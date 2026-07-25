import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../db/migrate";
import { AgentRun, runAgent } from "./base";

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

async function createAgentRun(db: PGlite): Promise<AgentRun> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (agent_name, status) values ('course-sync', 'running') returning id`,
  );
  return new AgentRun(db, rows[0].id);
}

describe("phase 6: AgentRun.decide()", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("applies and records a decision at or above threshold", async () => {
    const run = await createAgentRun(db);
    let applyCalled = false;

    const result = await run.decide({
      entityType: "programme",
      entityId: null,
      action: "insert",
      confidence: 0.9,
      rationale: "clear match",
      threshold: 0.8,
      apply: async () => {
        applyCalled = true;
      },
    });

    expect(applyCalled).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.escalated).toBe(false);

    const { rows } = await db.query<{ applied: boolean; escalated: boolean }>(
      `select applied, escalated from agent_decisions where id = $1`,
      [result.id],
    );
    expect(rows[0].applied).toBe(true);
    expect(rows[0].escalated).toBe(false);
  });

  it("records but does not apply a decision below threshold", async () => {
    const run = await createAgentRun(db);
    let applyCalled = false;

    const result = await run.decide({
      entityType: "programme",
      entityId: "11111111-1111-1111-1111-111111111111",
      action: "withdraw",
      confidence: 0.4,
      rationale: "missing from one page load",
      threshold: 0.8,
      apply: async () => {
        applyCalled = true;
      },
    });

    expect(applyCalled).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.escalated).toBe(true);

    const { rows } = await db.query<{ applied: boolean; escalated: boolean; confidence: string }>(
      `select applied, escalated, confidence from agent_decisions where id = $1`,
      [result.id],
    );
    expect(rows[0].applied).toBe(false);
    expect(rows[0].escalated).toBe(true);
    expect(Number(rows[0].confidence)).toBeCloseTo(0.4);
  });

  it("marks the agent run completed with a summary on success", async () => {
    await runAgent({ db }, "bursary-verify", async () => "did nothing notable");

    const { rows } = await db.query<{ status: string; summary: string; finished_at: string | null }>(
      `select status, summary, finished_at from agent_runs order by started_at desc limit 1`,
    );
    expect(rows[0].status).toBe("completed");
    expect(rows[0].summary).toBe("did nothing notable");
    expect(rows[0].finished_at).not.toBeNull();
  });

  it("marks the agent run failed and rethrows when work throws", async () => {
    await expect(
      runAgent({ db }, "support", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const { rows } = await db.query<{ status: string; summary: string }>(
      `select status, summary from agent_runs order by started_at desc limit 1`,
    );
    expect(rows[0].status).toBe("failed");
    expect(rows[0].summary).toBe("boom");
  });
});
