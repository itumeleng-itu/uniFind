import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrate";

// PGlite needs pgcrypto loaded as a bundled extension module at
// construction time -- running `CREATE EXTENSION pgcrypto` against a plain
// PGlite instance fails because there is no WASM module backing it yet.
async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

const EXPECTED_TABLES = [
  "institutions",
  "programmes",
  "programme_subject_requirements",
  "bursaries",
  "students",
  "match_runs",
  "payments",
  "reports",
  "cost_events",
  "agent_runs",
  "agent_decisions",
  "support_tickets",
];

describe("phase 1: core + agents schema", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("applies migrations cleanly and creates every table", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tableNames = rows.map((r) => r.table_name);

    for (const table of EXPECTED_TABLES) {
      expect(tableNames).toContain(table);
    }
  });

  it("exposes the agent_autonomy_daily view", async () => {
    const { rows } = await db.query(
      `select table_name from information_schema.views where table_schema = 'public' and table_name = 'agent_autonomy_daily'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps the idempotency-critical unique constraints", async () => {
    const { rows } = await db.query<{ table_name: string; constraint_name: string }>(
      `select tc.table_name, tc.constraint_name
       from information_schema.table_constraints tc
       where tc.constraint_type = 'UNIQUE'
         and tc.table_name in ('payments', 'reports')`,
    );

    const paymentsUnique = rows.filter((r) => r.table_name === "payments");
    const reportsUnique = rows.filter((r) => r.table_name === "reports");

    // payments: unique (provider, reference)
    expect(paymentsUnique.length).toBeGreaterThanOrEqual(1);
    // reports: unique (payment_id) -- created as a unique index, which also
    // registers as a table constraint.
    expect(reportsUnique.length).toBeGreaterThanOrEqual(1);
  });

  it("computes agent_autonomy_daily correctly from seeded decisions", async () => {
    const { rows: runRows } = await db.query<{ id: string }>(
      `insert into agent_runs (agent_name, status) values ('course-sync', 'completed') returning id`,
    );
    const agentRunId = runRows[0].id;

    // one applied, one escalated, one applied-then-overridden
    await db.exec(`
      insert into agent_decisions
        (agent_run_id, entity_type, action, confidence, rationale, threshold, applied, escalated, overridden)
      values
        ('${agentRunId}', 'programme', 'insert', 0.95, 'high confidence match', 0.8, true, false, false),
        ('${agentRunId}', 'programme', 'withdraw', 0.4, 'page render was empty', 0.8, false, true, false),
        ('${agentRunId}', 'programme', 'update', 0.9, 'requirement changed', 0.8, true, false, true)
    `);

    const { rows } = await db.query<{
      decisions: number;
      applied: number;
      escalated: number;
      overridden: number;
      autonomous_pct: string;
    }>(`select decisions, applied, escalated, overridden, autonomous_pct from agent_autonomy_daily`);

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].decisions)).toBe(3);
    expect(Number(rows[0].applied)).toBe(2);
    expect(Number(rows[0].escalated)).toBe(1);
    expect(Number(rows[0].overridden)).toBe(1);
    // 1 of 3 decisions was applied and never overridden -> 33.33%
    expect(Number(rows[0].autonomous_pct)).toBeCloseTo(33.33, 1);
  });
});
