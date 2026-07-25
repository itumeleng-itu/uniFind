import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../db/migrate";
import { assembleInput, generateReport } from "./generate";

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

interface Seeded {
  institutionId: string;
  matchRunId: string;
  verifiedOpenProgrammeId: string;
  unverifiedProgrammeId: string;
  verifiedBursaryId: string;
  expiredBursaryId: string;
}

async function seed(db: PGlite): Promise<Seeded> {
  const { rows: instRows } = await db.query<{ id: string }>(
    `insert into institutions (name, slug, homepage_url, application_deadline)
     values ('Test University', 'test-university', 'https://test.ac.za', '2099-01-01')
     returning id`,
  );
  const institutionId = instRows[0].id;

  const { rows: verifiedProgRows } = await db.query<{ id: string }>(
    `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
     values ($1, 'Science', 'BSc Computer Science', 'BSc', 28, 'verified')
     returning id`,
    [institutionId],
  );

  const { rows: unverifiedProgRows } = await db.query<{ id: string }>(
    `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
     values ($1, 'Science', 'BSc Unverified', 'BSc', 28, 'pending')
     returning id`,
    [institutionId],
  );

  const { rows: verifiedBursaryRows } = await db.query<{ id: string }>(
    `insert into bursaries (name, provider, url, status, closing_date)
     values ('Open Bursary', 'Test Foundation', 'https://example.org', 'verified', '2099-01-01')
     returning id`,
  );

  const { rows: expiredBursaryRows } = await db.query<{ id: string }>(
    `insert into bursaries (name, provider, url, status, closing_date)
     values ('Expired Bursary', 'Test Foundation', 'https://example.org', 'expired', '2020-01-01')
     returning id`,
  );

  const { rows: studentRows } = await db.query<{ id: string }>(
    `insert into students (email, name, subjects, aps_score)
     values ('learner@example.com', 'Test Learner', '{}'::jsonb, 30)
     returning id`,
  );

  const { rows: matchRunRows } = await db.query<{ id: string }>(
    `insert into match_runs (student_id) values ($1) returning id`,
    [studentRows[0].id],
  );

  return {
    institutionId,
    matchRunId: matchRunRows[0].id,
    verifiedOpenProgrammeId: verifiedProgRows[0].id,
    unverifiedProgrammeId: unverifiedProgRows[0].id,
    verifiedBursaryId: verifiedBursaryRows[0].id,
    expiredBursaryId: expiredBursaryRows[0].id,
  };
}

describe("phase 5: assembleInput", () => {
  let db: PGlite;
  let seeded: Seeded;

  beforeEach(async () => {
    db = await createTestDb();
    seeded = await seed(db);
  });

  it("never surfaces an unverified programme or an expired bursary", async () => {
    const input = await assembleInput(db, seeded.matchRunId);

    const allProgrammeIds = [
      ...input.qualifiesFor,
      ...input.narrowlyMissed,
      ...input.alreadyClosed,
    ].map((p) => p.id);
    expect(allProgrammeIds).not.toContain(seeded.unverifiedProgrammeId);

    const bursaryIds = input.bursaries.map((b) => b.id);
    expect(bursaryIds).not.toContain(seeded.expiredBursaryId);
    expect(bursaryIds).toContain(seeded.verifiedBursaryId);
  });

  it("puts a qualifying verified open programme in qualifiesFor", async () => {
    const input = await assembleInput(db, seeded.matchRunId);
    const ids = input.qualifiesFor.map((p) => p.id);
    expect(ids).toContain(seeded.verifiedOpenProgrammeId);
  });

  it("excludes a verified programme whose deadline already passed from qualifiesFor/narrowlyMissed, and lists it as already closed", async () => {
    const { rows: instRows } = await db.query<{ id: string }>(
      `insert into institutions (name, slug, homepage_url, application_deadline)
       values ('Closed University', 'closed-university', 'https://closed.ac.za', '2020-01-01')
       returning id`,
    );
    const { rows: progRows } = await db.query<{ id: string }>(
      `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
       values ($1, 'Law', 'LLB', 'LLB', 28, 'verified')
       returning id`,
      [instRows[0].id],
    );

    const input = await assembleInput(db, seeded.matchRunId);

    const openIds = [...input.qualifiesFor, ...input.narrowlyMissed].map((p) => p.id);
    expect(openIds).not.toContain(progRows[0].id);
    expect(input.alreadyClosed.map((p) => p.id)).toContain(progRows[0].id);
  });
});

describe("phase 5: generateReport claiming", () => {
  let db: PGlite;
  let seeded: Seeded;
  let paymentId: string;
  let reportId: string;

  beforeEach(async () => {
    db = await createTestDb();
    seeded = await seed(db);

    const { rows: paymentRows } = await db.query<{ id: string }>(
      `insert into payments (match_run_id, provider, reference, status, amount_cents, currency)
       values ($1, 'paystack', 'ref_report_test', 'paid', 7900, 'ZAR')
       returning id`,
      [seeded.matchRunId],
    );
    paymentId = paymentRows[0].id;

    const { rows: reportRows } = await db.query<{ id: string }>(
      `insert into reports (payment_id, match_run_id, status)
       values ($1, $2, 'pending')
       returning id`,
      [paymentId, seeded.matchRunId],
    );
    reportId = reportRows[0].id;
  });

  it("only lets one concurrent caller generate the same report", async () => {
    let callCount = 0;
    const generate = async () => {
      callCount += 1;
      return {
        text: "# Report\nSome content.",
        modelName: "gemini-2.5-flash",
        promptTokens: 100,
        completionTokens: 50,
      };
    };

    await Promise.all([
      generateReport({ db, generate }, reportId),
      generateReport({ db, generate }, reportId),
    ]);

    expect(callCount).toBe(1);

    const { rows } = await db.query<{ status: string; content: string | null }>(
      `select status, content from reports where id = $1`,
      [reportId],
    );
    expect(rows[0].status).toBe("completed");
    expect(rows[0].content).toContain("Some content");
  });

  it("stores the input snapshot, model name, and token counts", async () => {
    const generate = async () => ({
      text: "# Report",
      modelName: "gemini-2.5-flash",
      promptTokens: 123,
      completionTokens: 45,
    });

    await generateReport({ db, generate }, reportId);

    const { rows } = await db.query<{
      model_name: string;
      prompt_tokens: number;
      completion_tokens: number;
      input_snapshot: unknown;
    }>(
      `select model_name, prompt_tokens, completion_tokens, input_snapshot from reports where id = $1`,
      [reportId],
    );
    expect(rows[0].model_name).toBe("gemini-2.5-flash");
    expect(rows[0].prompt_tokens).toBe(123);
    expect(rows[0].completion_tokens).toBe(45);
    expect(rows[0].input_snapshot).toBeTruthy();
  });
});

describe("phase: on-demand institution refresh", () => {
  let db: PGlite;
  let seeded: Seeded;
  let reportId: string;

  beforeEach(async () => {
    db = await createTestDb();
    seeded = await seed(db);

    const { rows: paymentRows } = await db.query<{ id: string }>(
      `insert into payments (match_run_id, provider, reference, status, amount_cents, currency)
       values ($1, 'paystack', 'ref_refresh_test', 'paid', 7900, 'ZAR')
       returning id`,
      [seeded.matchRunId],
    );
    const { rows: reportRows } = await db.query<{ id: string }>(
      `insert into reports (payment_id, match_run_id, status)
       values ($1, $2, 'pending')
       returning id`,
      [paymentRows[0].id, seeded.matchRunId],
    );
    reportId = reportRows[0].id;
  });

  const generate = async () => ({
    text: "# Report",
    modelName: "gemini-2.5-flash",
    promptTokens: 1,
    completionTokens: 1,
  });

  it("refreshes a matched institution with no verified programme yet, and the report reflects the result", async () => {
    // The seeded programme has never been through course-sync
    // (last_verified_at is null), so it's stale by definition -- and it
    // already qualifies, so its institution is a candidate.
    let refreshedWith: string[] | null = null;
    const refreshInstitutions = async (institutionIds: string[]) => {
      refreshedWith = institutionIds;
      await db.query(
        `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status, last_verified_at)
         values ($1, 'Science', 'BSc Data Science', 'BSc', 29, 'verified', now())`,
        [seeded.institutionId],
      );
    };

    await generateReport({ db, generate, refreshInstitutions }, reportId);

    expect(refreshedWith).toEqual([seeded.institutionId]);

    const { rows } = await db.query<{ input_snapshot: { qualifiesFor: { name: string }[] } }>(
      `select input_snapshot from reports where id = $1`,
      [reportId],
    );
    const names = rows[0].input_snapshot.qualifiesFor.map((p) => p.name);
    expect(names).toContain("BSc Data Science");
  });

  it("does not refresh an institution whose programme was verified recently", async () => {
    await db.query(`update programmes set last_verified_at = now() where id = $1`, [
      seeded.verifiedOpenProgrammeId,
    ]);

    let called = false;
    const refreshInstitutions = async () => {
      called = true;
    };

    await generateReport({ db, generate, refreshInstitutions }, reportId);

    expect(called).toBe(false);
  });

  it("behaves exactly as before when refreshInstitutions is not provided", async () => {
    await generateReport({ db, generate }, reportId);
    const { rows } = await db.query<{ status: string }>(`select status from reports where id = $1`, [
      reportId,
    ]);
    expect(rows[0].status).toBe("completed");
  });
});
