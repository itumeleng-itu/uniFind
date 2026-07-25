import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../db/migrate";
import { runCourseSync, type CourseSyncDeps, type ExtractedProgramme } from "./course-sync";

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

async function seedInstitution(db: PGlite, prospectusUrl: string | null) {
  const { rows } = await db.query<{ id: string }>(
    `insert into institutions (name, slug, homepage_url, prospectus_url)
     values ('Test University', 'test-university', 'https://test.ac.za', $1)
     returning id`,
    [prospectusUrl],
  );
  return rows[0].id;
}

describe("phase 6: course-sync", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("inserts a newly discovered programme when confidence clears the threshold", async () => {
    const institutionId = await seedInstitution(db, "https://test.ac.za/prospectus");

    const extracted: ExtractedProgramme = {
      faculty: "Science",
      name: "BSc Computer Science",
      qualification: "BSc",
      pointsRequirement: 30,
      subjectRequirements: [{ subject: "Mathematics", minLevel: 5 }],
      confidence: 0.9,
      rationale: "clearly listed with explicit APS requirement",
    };

    const deps: CourseSyncDeps = {
      db,
      discoverProspectusUrl: async () => {
        throw new Error("should not be called -- prospectus_url already set");
      },
      extractProgrammes: async () => [extracted],
    };

    await runCourseSync(deps);

    const { rows } = await db.query<{ id: string; points_requirement: number; status: string }>(
      `select id, points_requirement, status from programmes where institution_id = $1`,
      [institutionId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].points_requirement).toBe(30);
    expect(rows[0].status).toBe("verified");

    const { rows: reqRows } = await db.query(
      `select subject, min_level from programme_subject_requirements where programme_id = $1`,
      [rows[0].id],
    );
    expect(reqRows).toHaveLength(1);
  });

  it("does not insert a discovered programme when confidence is below threshold", async () => {
    await seedInstitution(db, "https://test.ac.za/prospectus");

    const deps: CourseSyncDeps = {
      db,
      discoverProspectusUrl: async () => {
        throw new Error("unused");
      },
      extractProgrammes: async () => [
        {
          faculty: "Science",
          name: "BSc Uncertain",
          qualification: "BSc",
          pointsRequirement: 30,
          subjectRequirements: [],
          confidence: 0.5,
          rationale: "ambiguous page layout",
        },
      ],
    };

    await runCourseSync(deps);

    const { rows } = await db.query(`select id from programmes`);
    expect(rows).toHaveLength(0);

    const { rows: decisionRows } = await db.query<{ applied: boolean; escalated: boolean }>(
      `select applied, escalated from agent_decisions where action = 'insert'`,
    );
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].applied).toBe(false);
    expect(decisionRows[0].escalated).toBe(true);
  });

  it("updates a catalogue programme whose points requirement changed", async () => {
    const institutionId = await seedInstitution(db, "https://test.ac.za/prospectus");
    const { rows: progRows } = await db.query<{ id: string }>(
      `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
       values ($1, 'Science', 'BSc Computer Science', 'BSc', 28, 'verified')
       returning id`,
      [institutionId],
    );

    const deps: CourseSyncDeps = {
      db,
      discoverProspectusUrl: async () => {
        throw new Error("unused");
      },
      extractProgrammes: async () => [
        {
          faculty: "Science",
          name: "BSc Computer Science",
          qualification: "BSc",
          pointsRequirement: 32,
          subjectRequirements: [],
          confidence: 0.95,
          rationale: "requirement raised on the current page",
        },
      ],
    };

    await runCourseSync(deps);

    const { rows } = await db.query<{ points_requirement: number }>(
      `select points_requirement from programmes where id = $1`,
      [progRows[0].id],
    );
    expect(rows[0].points_requirement).toBe(32);
  });

  it("records a withdraw decision below threshold and never applies it -- the programme stays verified", async () => {
    const institutionId = await seedInstitution(db, "https://test.ac.za/prospectus");
    const { rows: progRows } = await db.query<{ id: string }>(
      `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
       values ($1, 'Science', 'BSc Physics', 'BSc', 28, 'verified')
       returning id`,
      [institutionId],
    );

    const deps: CourseSyncDeps = {
      db,
      discoverProspectusUrl: async () => {
        throw new Error("unused");
      },
      // The current page fetch found nothing at all -- BSc Physics is
      // simply absent, which is the scenario a withdraw decision must
      // treat conservatively.
      extractProgrammes: async () => [],
    };

    await runCourseSync(deps);

    const { rows: programmeRows } = await db.query<{ status: string }>(
      `select status from programmes where id = $1`,
      [progRows[0].id],
    );
    expect(programmeRows[0].status).toBe("verified");

    const { rows: decisionRows } = await db.query<{
      applied: boolean;
      escalated: boolean;
      confidence: string;
      threshold: string;
    }>(`select applied, escalated, confidence, threshold from agent_decisions where action = 'withdraw'`);
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].applied).toBe(false);
    expect(decisionRows[0].escalated).toBe(true);
    expect(Number(decisionRows[0].confidence)).toBeLessThan(Number(decisionRows[0].threshold));
  });

  it("computes agent_autonomy_daily correctly across a mixed run (insert applied, withdraw escalated)", async () => {
    const institutionId = await seedInstitution(db, "https://test.ac.za/prospectus");
    await db.query(
      `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
       values ($1, 'Science', 'BSc Physics', 'BSc', 28, 'verified')`,
      [institutionId],
    );

    const deps: CourseSyncDeps = {
      db,
      discoverProspectusUrl: async () => {
        throw new Error("unused");
      },
      extractProgrammes: async () => [
        {
          faculty: "Science",
          name: "BSc Computer Science",
          qualification: "BSc",
          pointsRequirement: 30,
          subjectRequirements: [],
          confidence: 0.9,
          rationale: "clearly listed",
        },
      ],
    };

    await runCourseSync(deps);

    const { rows } = await db.query<{
      decisions: number;
      applied: number;
      escalated: number;
      autonomous_pct: string;
    }>(`select decisions, applied, escalated, autonomous_pct from agent_autonomy_daily where agent_name = 'course-sync'`);

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].decisions)).toBe(2); // one insert, one withdraw
    expect(Number(rows[0].applied)).toBe(1);
    expect(Number(rows[0].escalated)).toBe(1);
    expect(Number(rows[0].autonomous_pct)).toBeCloseTo(50, 0);
  });

  it("discovers a missing prospectus_url before crawling, and skips crawling when discovery is escalated", async () => {
    const institutionId = await seedInstitution(db, null);
    let extractCalled = false;

    const deps: CourseSyncDeps = {
      db,
      discoverProspectusUrl: async () => ({
        url: "https://test.ac.za/prospectus",
        confidence: 0.5,
        rationale: "homepage navigation is ambiguous",
      }),
      extractProgrammes: async () => {
        extractCalled = true;
        return [];
      },
    };

    await runCourseSync(deps);

    expect(extractCalled).toBe(false);
    const { rows } = await db.query<{ prospectus_url: string | null }>(
      `select prospectus_url from institutions where id = $1`,
      [institutionId],
    );
    expect(rows[0].prospectus_url).toBeNull();
  });
});
