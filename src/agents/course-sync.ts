import type { DbClient } from "@/lib/dbClient";
import { AgentRun, runAgent } from "./base";

const AUTONOMY_THRESHOLD = 0.8;

// A programme's absence from a single page fetch is usually a rendering
// quirk (JS-rendered content, a paginated list we only read page one of, a
// transient error) -- removing a real course from a learner's results is
// the worse error. Withdrawals use this fixed, always-below-threshold
// confidence rather than anything the extraction model reports, so a
// withdrawal can never auto-apply from a single missed page load alone.
const WITHDRAW_CONFIDENCE = 0.4;

export interface ExtractedProgramme {
  faculty: string;
  name: string;
  qualification: string;
  pointsRequirement: number;
  subjectRequirements: { subject: string; minLevel: number }[];
  confidence: number;
  rationale: string;
}

export interface ProspectusDiscovery {
  url: string;
  confidence: number;
  rationale: string;
}

export interface CourseSyncDeps {
  db: DbClient;
  discoverProspectusUrl: (
    institutionName: string,
    homepageUrl: string,
  ) => Promise<ProspectusDiscovery>;
  extractProgrammes: (
    institutionName: string,
    prospectusUrl: string,
  ) => Promise<ExtractedProgramme[]>;
}

interface InstitutionRow {
  id: string;
  name: string;
  homepage_url: string;
  prospectus_url: string | null;
}

interface CatalogueProgrammeRow {
  id: string;
  faculty: string;
  name: string;
  qualification: string;
  points_requirement: number;
  status: string;
}

function programmeKey(faculty: string, name: string, qualification: string): string {
  return `${faculty}|${name}|${qualification}`.toLowerCase();
}

async function insertSubjectRequirements(
  db: DbClient,
  programmeId: string,
  requirements: { subject: string; minLevel: number }[],
): Promise<void> {
  for (const req of requirements) {
    await db.query(
      `insert into programme_subject_requirements (programme_id, subject, min_level) values ($1, $2, $3)`,
      [programmeId, req.subject, req.minLevel],
    );
  }
}

async function resolveProspectusUrl(
  run: AgentRun,
  deps: CourseSyncDeps,
  institution: InstitutionRow,
): Promise<string | null> {
  if (institution.prospectus_url) return institution.prospectus_url;

  const discovery = await deps.discoverProspectusUrl(institution.name, institution.homepage_url);
  const result = await run.decide({
    entityType: "institution",
    entityId: institution.id,
    action: "discover_prospectus_url",
    confidence: discovery.confidence,
    rationale: discovery.rationale,
    threshold: AUTONOMY_THRESHOLD,
    apply: async () => {
      await deps.db.query(
        `update institutions set prospectus_url = $2, updated_at = now() where id = $1`,
        [institution.id, discovery.url],
      );
    },
  });

  return result.applied ? discovery.url : null;
}

async function syncInstitution(
  run: AgentRun,
  deps: CourseSyncDeps,
  institution: InstitutionRow,
): Promise<void> {
  const prospectusUrl = await resolveProspectusUrl(run, deps, institution);
  if (!prospectusUrl) return; // discovery escalated -- nothing to crawl yet

  const discovered = await deps.extractProgrammes(institution.name, prospectusUrl);
  const discoveredByKey = new Map(
    discovered.map((p) => [programmeKey(p.faculty, p.name, p.qualification), p]),
  );

  const { rows: catalogue } = await deps.db.query<CatalogueProgrammeRow>(
    `select id, faculty, name, qualification, points_requirement, status
     from programmes where institution_id = $1 and status <> 'withdrawn'`,
    [institution.id],
  );
  const catalogueByKey = new Map(
    catalogue.map((p) => [programmeKey(p.faculty, p.name, p.qualification), p]),
  );

  for (const [key, extracted] of discoveredByKey) {
    const existing = catalogueByKey.get(key);

    if (!existing) {
      await run.decide({
        entityType: "programme",
        entityId: null,
        action: "insert",
        confidence: extracted.confidence,
        rationale: extracted.rationale,
        threshold: AUTONOMY_THRESHOLD,
        apply: async () => {
          const { rows } = await deps.db.query<{ id: string }>(
            `insert into programmes
               (institution_id, faculty, name, qualification, points_requirement, status, source_url, last_verified_at)
             values ($1, $2, $3, $4, $5, 'verified', $6, now())
             returning id`,
            [
              institution.id,
              extracted.faculty,
              extracted.name,
              extracted.qualification,
              extracted.pointsRequirement,
              prospectusUrl,
            ],
          );
          await insertSubjectRequirements(deps.db, rows[0].id, extracted.subjectRequirements);
        },
      });
      continue;
    }

    const changed =
      existing.points_requirement !== extracted.pointsRequirement || existing.status !== "verified";
    if (!changed) continue;

    await run.decide({
      entityType: "programme",
      entityId: existing.id,
      action: "update",
      confidence: extracted.confidence,
      rationale: extracted.rationale,
      threshold: AUTONOMY_THRESHOLD,
      apply: async () => {
        await deps.db.query(
          `update programmes
           set points_requirement = $2, status = 'verified', source_url = $3, last_verified_at = now(), updated_at = now()
           where id = $1`,
          [existing.id, extracted.pointsRequirement, prospectusUrl],
        );
        await deps.db.query(`delete from programme_subject_requirements where programme_id = $1`, [
          existing.id,
        ]);
        await insertSubjectRequirements(deps.db, existing.id, extracted.subjectRequirements);
      },
    });
  }

  for (const [key, existing] of catalogueByKey) {
    if (discoveredByKey.has(key)) continue;
    if (existing.status !== "verified") continue; // already pending/withdrawn -- nothing to withdraw

    await run.decide({
      entityType: "programme",
      entityId: existing.id,
      action: "withdraw",
      confidence: WITHDRAW_CONFIDENCE,
      rationale: `${existing.name} (${existing.qualification}) was not found on the current prospectus page`,
      threshold: AUTONOMY_THRESHOLD,
      apply: async () => {
        await deps.db.query(`update programmes set status = 'withdrawn', updated_at = now() where id = $1`, [
          existing.id,
        ]);
      },
    });
  }
}

export async function runCourseSync(deps: CourseSyncDeps): Promise<void> {
  await runAgent({ db: deps.db }, "course-sync", async (run) => {
    const { rows: institutions } = await deps.db.query<InstitutionRow>(
      `select id, name, homepage_url, prospectus_url from institutions`,
    );
    for (const institution of institutions) {
      await syncInstitution(run, deps, institution);
    }
    return `synced ${institutions.length} institutions`;
  });
}
