import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../db/migrate";
import { processPaystackWebhookReference } from "./webhook";

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

describe("phase 4: paystack webhook idempotency", () => {
  let db: PGlite;
  let matchRunId: string;
  const reference = "ref_test_123";

  beforeEach(async () => {
    db = await createTestDb();

    const { rows: studentRows } = await db.query<{ id: string }>(
      `insert into students (email, name) values ('learner@example.com', 'Test Learner') returning id`,
    );
    const { rows: matchRunRows } = await db.query<{ id: string }>(
      `insert into match_runs (student_id) values ($1) returning id`,
      [studentRows[0].id],
    );
    matchRunId = matchRunRows[0].id;

    await db.query(
      `insert into payments (match_run_id, provider, reference, status, amount_cents, currency)
       values ($1, 'paystack', $2, 'pending', 7900, 'ZAR')`,
      [matchRunId, reference],
    );
  });

  it("produces exactly one report from three deliveries of the same reference", async () => {
    const verifyTransaction = async () => ({ status: "success", reference });

    for (let i = 0; i < 3; i++) {
      await processPaystackWebhookReference({ db, verifyTransaction }, reference);
    }

    const { rows: reportRows } = await db.query(`select id from reports`);
    expect(reportRows).toHaveLength(1);

    const { rows: paymentRows } = await db.query<{ status: string }>(
      `select status from payments where reference = $1`,
      [reference],
    );
    expect(paymentRows[0].status).toBe("paid");
  });

  it("produces nothing for an unknown reference", async () => {
    const verifyTransaction = async () => ({
      status: "success",
      reference: "ref_does_not_exist",
    });

    await processPaystackWebhookReference({ db, verifyTransaction }, "ref_does_not_exist");

    const { rows: reportRows } = await db.query(`select id from reports`);
    expect(reportRows).toHaveLength(0);

    const { rows: paymentRows } = await db.query<{ status: string }>(
      `select status from payments`,
    );
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0].status).toBe("pending");
  });

  it("does not mark paid or create a report when re-verification is not a success", async () => {
    const verifyTransaction = async () => ({ status: "abandoned", reference });

    await processPaystackWebhookReference({ db, verifyTransaction }, reference);

    const { rows: reportRows } = await db.query(`select id from reports`);
    expect(reportRows).toHaveLength(0);

    const { rows: paymentRows } = await db.query<{ status: string }>(
      `select status from payments where reference = $1`,
      [reference],
    );
    expect(paymentRows[0].status).toBe("pending");
  });
});
