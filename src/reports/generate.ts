import type { DbClient } from "@/lib/dbClient";
import { buildReportPrompt } from "./prompt";

// A programme is "narrowly missed" when the learner is this many APS points
// or fewer short of the requirement. Purely a bucketing heuristic for
// non-APS institutions too -- the prompt is responsible for telling the
// model that APS is indicative only where scoringSystem isn't 'aps'.
const NARROW_MISS_MARGIN = 2;

export interface AssembledStudent {
  name: string;
  apsScore: number | null;
  subjects: Record<string, number>;
  interests: string | null;
}

export interface AssembledProgramme {
  id: string;
  institutionName: string;
  scoringSystem: string;
  faculty: string;
  name: string;
  qualification: string;
  pointsRequirement: number;
  effectiveDeadline: string | null;
}

export interface AssembledBursary {
  id: string;
  name: string;
  provider: string;
  url: string;
  eligibilityCriteria: string | null;
  amount: string | null;
  closingDate: string | null;
}

export interface AssembledInput {
  student: AssembledStudent;
  qualifiesFor: AssembledProgramme[];
  narrowlyMissed: AssembledProgramme[];
  alreadyClosed: AssembledProgramme[];
  bursaries: AssembledBursary[];
}

interface ProgrammeRow {
  id: string;
  institution_name: string;
  scoring_system: string;
  faculty: string;
  name: string;
  qualification: string;
  points_requirement: number;
  effective_deadline: string | null;
}

function toProgramme(row: ProgrammeRow): AssembledProgramme {
  return {
    id: row.id,
    institutionName: row.institution_name,
    scoringSystem: row.scoring_system,
    faculty: row.faculty,
    name: row.name,
    qualification: row.qualification,
    pointsRequirement: row.points_requirement,
    effectiveDeadline: row.effective_deadline,
  };
}

function parseSubjects(raw: unknown): Record<string, number> {
  if (raw && typeof raw === "object") return raw as Record<string, number>;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

interface SubjectRequirement {
  subject: string;
  min_level: number;
}

async function loadSubjectRequirements(
  db: DbClient,
  programmeIds: string[],
): Promise<Map<string, SubjectRequirement[]>> {
  const map = new Map<string, SubjectRequirement[]>();
  if (programmeIds.length === 0) return map;

  const { rows } = await db.query<{
    programme_id: string;
    subject: string;
    min_level: number;
  }>(
    `select programme_id, subject, min_level
     from programme_subject_requirements
     where programme_id = any($1)`,
    [programmeIds],
  );
  for (const row of rows) {
    const list = map.get(row.programme_id) ?? [];
    list.push({ subject: row.subject, min_level: row.min_level });
    map.set(row.programme_id, list);
  }
  return map;
}

const byDeadlineAscending = (a: AssembledProgramme, b: AssembledProgramme): number =>
  (a.effectiveDeadline ?? "9999-12-31").localeCompare(b.effectiveDeadline ?? "9999-12-31");

// Pulls only verified, still-open rows and buckets them into three lists.
// Both "open" (via the open_programmes view, which already applies the
// deadline filter) and "verified" are enforced in SQL here -- an unverified
// or closed programme can never reach this function's output.
export async function assembleInput(db: DbClient, matchRunId: string): Promise<AssembledInput> {
  const { rows: studentRows } = await db.query<{
    name: string;
    aps_score: number | null;
    subjects: unknown;
    interests: string | null;
  }>(
    `select s.name, s.aps_score, s.subjects, s.interests
     from match_runs mr
     join students s on s.id = mr.student_id
     where mr.id = $1`,
    [matchRunId],
  );
  const student = studentRows[0];
  if (!student) {
    throw new Error(`match_run ${matchRunId} not found`);
  }
  const subjects = parseSubjects(student.subjects);

  const { rows: openRows } = await db.query<ProgrammeRow>(
    `select op.id, i.name as institution_name, op.scoring_system, op.faculty,
            op.name, op.qualification, op.points_requirement, op.effective_deadline
     from open_programmes op
     join institutions i on i.id = op.institution_id
     where op.status = 'verified'`,
  );

  // Verified programmes whose deadline has already passed -- shown for
  // context only ("you would have qualified"), never as something to apply
  // to. open_programmes already excludes these from openRows, so this is a
  // separate query rather than a filter on the same result set.
  const { rows: closedRows } = await db.query<ProgrammeRow>(
    `select p.id, i.name as institution_name, i.scoring_system, p.faculty,
            p.name, p.qualification, p.points_requirement,
            coalesce(fd.deadline, i.application_deadline) as effective_deadline
     from programmes p
     join institutions i on i.id = p.institution_id
     left join faculty_deadlines fd
       on fd.institution_id = p.institution_id and fd.faculty = p.faculty
     where p.status = 'verified'
       and coalesce(fd.deadline, i.application_deadline) is not null
       and coalesce(fd.deadline, i.application_deadline) < current_date`,
  );

  const requirementsByProgramme = await loadSubjectRequirements(db, [
    ...openRows.map((r) => r.id),
    ...closedRows.map((r) => r.id),
  ]);

  const meetsSubjectRequirements = (programmeId: string): boolean => {
    const requirements = requirementsByProgramme.get(programmeId) ?? [];
    return requirements.every((req) => (subjects[req.subject] ?? 0) >= req.min_level);
  };

  const apsScore = student.aps_score;
  const qualifiesFor: AssembledProgramme[] = [];
  const narrowlyMissed: AssembledProgramme[] = [];

  for (const row of openRows) {
    const meetsPoints = apsScore !== null && apsScore >= row.points_requirement;
    if (meetsPoints && meetsSubjectRequirements(row.id)) {
      qualifiesFor.push(toProgramme(row));
    } else if (apsScore !== null && row.points_requirement - apsScore <= NARROW_MISS_MARGIN) {
      narrowlyMissed.push(toProgramme(row));
    }
  }

  const alreadyClosed = closedRows.map(toProgramme);

  // Deadline first, fit second: a closing date next week matters more to a
  // learner than a slightly better fit that stays open all year.
  qualifiesFor.sort(byDeadlineAscending);
  narrowlyMissed.sort(byDeadlineAscending);
  alreadyClosed.sort(byDeadlineAscending);

  const { rows: bursaryRows } = await db.query<{
    id: string;
    name: string;
    provider: string;
    url: string;
    eligibility_criteria: string | null;
    amount: string | null;
    closing_date: string | null;
  }>(
    `select id, name, provider, url, eligibility_criteria, amount, closing_date
     from bursaries
     where status = 'verified'
       and (closing_date is null or closing_date >= current_date)
     order by closing_date asc nulls last`,
  );

  return {
    student: {
      name: student.name,
      apsScore: student.aps_score,
      subjects,
      interests: student.interests,
    },
    qualifiesFor,
    narrowlyMissed,
    alreadyClosed,
    bursaries: bursaryRows.map((b) => ({
      id: b.id,
      name: b.name,
      provider: b.provider,
      url: b.url,
      eligibilityCriteria: b.eligibility_criteria,
      amount: b.amount,
      closingDate: b.closing_date,
    })),
  };
}

export interface GenerateTextResult {
  text: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
}

export interface GenerateReportDeps {
  db: DbClient;
  generate: (
    prompt: string,
    opts: { source: string; reportId: string },
  ) => Promise<GenerateTextResult>;
}

// Claims the report row with a conditional UPDATE before doing any work: the
// WHERE clause requires status = 'pending', so if two workers race on the
// same reportId, only the one whose UPDATE actually matched a row proceeds.
// The other's UPDATE affects zero rows and it returns immediately.
export async function generateReport(deps: GenerateReportDeps, reportId: string): Promise<void> {
  const { rows: claimedRows } = await deps.db.query<{ id: string; match_run_id: string }>(
    `update reports set status = 'generating'
     where id = $1 and status = 'pending'
     returning id, match_run_id`,
    [reportId],
  );
  const claimed = claimedRows[0];
  if (!claimed) return;

  try {
    const input = await assembleInput(deps.db, claimed.match_run_id);
    const promptText = buildReportPrompt(input);
    const result = await deps.generate(promptText, { source: "report_generation", reportId });

    await deps.db.query(
      `update reports
       set status = 'completed',
           content = $2,
           model_name = $3,
           prompt_tokens = $4,
           completion_tokens = $5,
           input_snapshot = $6,
           completed_at = now()
       where id = $1`,
      [
        reportId,
        result.text,
        result.modelName,
        result.promptTokens,
        result.completionTokens,
        JSON.stringify(input),
      ],
    );
  } catch (err) {
    await deps.db.query(`update reports set status = 'failed' where id = $1`, [reportId]);
    throw err;
  }
}
