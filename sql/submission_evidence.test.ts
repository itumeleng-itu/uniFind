import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../db/migrate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Splits the evidence file into individual statements. Comments are
// stripped first -- prose in a comment can itself contain a semicolon
// ("...it was paid; a refund..."), which would otherwise be mistaken for a
// statement boundary by a naive split.
function loadQueries(): string[] {
  const raw = readFileSync(path.join(__dirname, "submission_evidence.sql"), "utf-8").replace(
    /\r\n/g,
    "\n",
  );
  const withoutComments = raw
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  return withoutComments
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function findQuery(queries: string[], marker: string): string {
  const found = queries.find((q) => q.includes(marker));
  if (!found) throw new Error(`No evidence query contains "${marker}"`);
  return found;
}

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

async function seed(db: PGlite): Promise<void> {
  const { rows: instRows } = await db.query<{ id: string }>(
    `insert into institutions (name, slug, homepage_url, application_deadline)
     values ('Test University', 'test-university', 'https://test.ac.za', '2099-01-01')
     returning id`,
  );
  await db.query(
    `insert into programmes (institution_id, faculty, name, qualification, points_requirement, status)
     values ($1, 'Science', 'BSc Computer Science', 'BSc', 30, 'verified')`,
    [instRows[0].id],
  );

  const { rows: studentRows } = await db.query<{ id: string }>(
    `insert into students (email, name, aps_score) values
       ('learner1@example.com', 'Learner One', 32),
       ('learner2@example.com', 'Learner Two', 28)
     returning id`,
  );
  const { rows: matchRunRows } = await db.query<{ id: string }>(
    `insert into match_runs (student_id) values ($1), ($2) returning id`,
    [studentRows[0].id, studentRows[1].id],
  );

  // Payment 1: paid, report completed, one report_generation cost event.
  const { rows: payment1 } = await db.query<{ id: string }>(
    `insert into payments (match_run_id, provider, reference, status, amount_cents, currency, paid_at)
     values ($1, 'paystack', 'ref_1', 'paid', 7900, 'ZAR', now())
     returning id`,
    [matchRunRows[0].id],
  );
  const { rows: report1 } = await db.query<{ id: string }>(
    `insert into reports (payment_id, match_run_id, status, content)
     values ($1, $2, 'completed', '# Report')
     returning id`,
    [payment1[0].id, matchRunRows[0].id],
  );
  await db.query(
    `insert into cost_events (report_id, source, model_name, prompt_tokens, completion_tokens, cost_usd)
     values ($1, 'report_generation', 'gemini-2.5-flash', 1000, 500, 0.002)`,
    [report1[0].id],
  );

  // Payment 2: paid a couple of days ago, then refunded today -- exercises
  // the P&L's same-sale-different-day reversal.
  const { rows: payment2 } = await db.query<{ id: string }>(
    `insert into payments (match_run_id, provider, reference, status, amount_cents, currency, paid_at, refunded_at)
     values ($1, 'paystack', 'ref_2', 'refunded', 7900, 'ZAR', now() - interval '2 days', now())
     returning id`,
    [matchRunRows[1].id],
  );
  await db.query(
    `insert into reports (payment_id, match_run_id, status, content)
     values ($1, $2, 'completed', '# Report 2')`,
    [payment2[0].id, matchRunRows[1].id],
  );

  // Agent activity: one applied insert, one escalated withdraw.
  const { rows: runRows } = await db.query<{ id: string }>(
    `insert into agent_runs (agent_name, status) values ('course-sync', 'completed') returning id`,
  );
  await db.query(
    `insert into agent_decisions
       (agent_run_id, entity_type, action, confidence, rationale, threshold, applied, escalated)
     values
       ($1, 'programme', 'insert', 0.9, 'clear match', 0.8, true, false),
       ($1, 'programme', 'withdraw', 0.4, 'missing from page', 0.8, false, true)`,
    [runRows[0].id],
  );
  await db.query(
    `insert into cost_events (source, model_name, prompt_tokens, completion_tokens, cost_usd)
     values ('course-sync', 'gemini-2.5-flash', 2000, 300, 0.003)`,
  );
}

describe("phase 8: submission evidence queries", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
    await seed(db);
  });

  it("runs every evidence query against seeded data without error", async () => {
    const queries = loadQueries();
    expect(queries.length).toBeGreaterThan(0);

    for (const query of queries) {
      const { rows } = await db.query(query);
      expect(Array.isArray(rows)).toBe(true);
    }
  });

  it("computes a correct all-time P&L summary", async () => {
    const query = findQuery(loadQueries(), "gross_revenue_cents");
    const { rows } = await db.query<{
      gross_revenue_cents: string;
      refunds_cents: string;
      net_revenue_cents: string;
      gemini_cost_usd: string;
    }>(query);

    // Two R79 sales, one later refunded: gross counts both, refunds
    // reverses one out, net is exactly one sale.
    expect(Number(rows[0].gross_revenue_cents)).toBe(15800);
    expect(Number(rows[0].refunds_cents)).toBe(7900);
    expect(Number(rows[0].net_revenue_cents)).toBe(7900);
    expect(Number(rows[0].gemini_cost_usd)).toBeCloseTo(0.005, 5);
  });

  it("computes the funnel with correct conversion percentages", async () => {
    const query = findQuery(loadQueries(), "pct_started_checkout");
    const { rows } = await db.query<{
      match_runs: number;
      payments_initiated: number;
      payments_paid: number;
      reports_completed: number;
      pct_started_checkout: string;
    }>(query);

    expect(Number(rows[0].match_runs)).toBe(2);
    expect(Number(rows[0].payments_initiated)).toBe(2);
    expect(Number(rows[0].payments_paid)).toBe(2); // paid + refunded both completed checkout
    expect(Number(rows[0].reports_completed)).toBe(2);
    expect(Number(rows[0].pct_started_checkout)).toBeCloseTo(100, 0);
  });

  it("computes all-time agent autonomy correctly for the seeded course-sync run", async () => {
    const query = findQuery(loadQueries(), "join agent_runs ar on ar.id = ad.agent_run_id");
    const { rows } = await db.query<{
      agent_name: string;
      decisions: number;
      applied: number;
      escalated: number;
      autonomous_pct: string;
    }>(query);

    const courseSync = rows.find((r) => r.agent_name === "course-sync");
    expect(courseSync).toBeDefined();
    expect(Number(courseSync?.decisions)).toBe(2);
    expect(Number(courseSync?.applied)).toBe(1);
    expect(Number(courseSync?.escalated)).toBe(1);
    expect(Number(courseSync?.autonomous_pct)).toBeCloseTo(50, 0);
  });

  it("returns unit economics per completed report", async () => {
    const query = findQuery(loadQueries(), "revenue_zar");
    const { rows } = await db.query<{ report_id: string; revenue_zar: string; gemini_cost_usd: string }>(
      query,
    );

    expect(rows).toHaveLength(2);
    expect(Number(rows[0].revenue_zar)).toBeCloseTo(79, 2);
  });
});
