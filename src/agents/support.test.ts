import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../db/migrate";
import { runSupport, type SupportDeps, type TriageResult } from "./support";

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

interface Seeded {
  studentId: string;
  paymentId: string;
  reportId: string;
}

async function seed(db: PGlite, reference: string): Promise<Seeded> {
  const { rows: studentRows } = await db.query<{ id: string }>(
    `insert into students (email, name) values ('learner@example.com', 'Test Learner') returning id`,
  );
  const { rows: matchRunRows } = await db.query<{ id: string }>(
    `insert into match_runs (student_id) values ($1) returning id`,
    [studentRows[0].id],
  );
  const { rows: paymentRows } = await db.query<{ id: string }>(
    `insert into payments (match_run_id, provider, reference, status, amount_cents, currency)
     values ($1, 'paystack', $2, 'paid', 7900, 'ZAR')
     returning id`,
    [matchRunRows[0].id, reference],
  );
  const { rows: reportRows } = await db.query<{ id: string }>(
    `insert into reports (payment_id, match_run_id, status, content)
     values ($1, $2, 'completed', 'old content')
     returning id`,
    [paymentRows[0].id, matchRunRows[0].id],
  );
  return { studentId: studentRows[0].id, paymentId: paymentRows[0].id, reportId: reportRows[0].id };
}

async function openTicket(db: PGlite, studentId: string, paymentId: string, subject: string, body: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into support_tickets (student_id, payment_id, subject, body, status)
     values ($1, $2, $3, $4, 'open')
     returning id`,
    [studentId, paymentId, subject, body],
  );
  return rows[0].id;
}

function makeDeps(
  overrides: { db: PGlite } & Partial<SupportDeps> & { triageResult: TriageResult },
): SupportDeps {
  const generateReport = vi.fn(async () => {});
  const refundTransaction = vi.fn(async () => ({ status: "success" }));
  return {
    triageTicket: async () => overrides.triageResult,
    generateReport,
    refundTransaction,
    ...overrides,
    db: overrides.db,
  };
}

describe("phase 6: support", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("issues a refund within the ceiling and resolves the ticket", async () => {
    const seeded = await seed(db, "ref_support_1");
    const ticketId = await openTicket(db, seeded.studentId, seeded.paymentId, "Wrong report", "This isn't for me");

    const refundTransaction = vi.fn(async () => ({ status: "success" }));
    const deps = makeDeps({
      db,
      refundTransaction,
      triageResult: {
        action: "refund",
        confidence: 0.9,
        rationale: "report clearly doesn't match the learner's subjects",
        refundAmountCents: 7900,
      },
    });

    await runSupport(deps);

    expect(refundTransaction).toHaveBeenCalledWith("ref_support_1", 7900);
    const { rows: paymentRows } = await db.query<{ status: string }>(
      `select status from payments where id = $1`,
      [seeded.paymentId],
    );
    expect(paymentRows[0].status).toBe("refunded");
    const { rows: ticketRows } = await db.query<{ status: string }>(
      `select status from support_tickets where id = $1`,
      [ticketId],
    );
    expect(ticketRows[0].status).toBe("resolved");
  });

  it("escalates a refund above the ceiling instead of applying it, even at high confidence", async () => {
    const seeded = await seed(db, "ref_support_2");
    const ticketId = await openTicket(db, seeded.studentId, seeded.paymentId, "Refund me more", "Give me extra back");

    const refundTransaction = vi.fn(async () => ({ status: "success" }));
    const deps = makeDeps({
      db,
      refundTransaction,
      triageResult: {
        action: "refund",
        confidence: 0.99,
        rationale: "learner insists",
        refundAmountCents: 50_000,
      },
    });

    await runSupport(deps);

    expect(refundTransaction).not.toHaveBeenCalled();
    const { rows: paymentRows } = await db.query<{ status: string }>(
      `select status from payments where id = $1`,
      [seeded.paymentId],
    );
    expect(paymentRows[0].status).toBe("paid");
    const { rows: ticketRows } = await db.query<{ status: string }>(
      `select status from support_tickets where id = $1`,
      [ticketId],
    );
    expect(ticketRows[0].status).toBe("escalated");

    const { rows: decisionRows } = await db.query<{ confidence: string }>(
      `select confidence from agent_decisions where action = 'refund'`,
    );
    expect(Number(decisionRows[0].confidence)).toBe(0);
  });

  it("regenerates the report and resolves the ticket", async () => {
    const seeded = await seed(db, "ref_support_3");
    const ticketId = await openTicket(
      db,
      seeded.studentId,
      seeded.paymentId,
      "Outdated info",
      "This programme closed already",
    );

    const generateReport = vi.fn(async () => {});
    const deps = makeDeps({
      db,
      generateReport,
      triageResult: {
        action: "regenerate_report",
        confidence: 0.85,
        rationale: "underlying data has changed since the report was generated",
      },
    });

    await runSupport(deps);

    expect(generateReport).toHaveBeenCalledWith(seeded.reportId);
    const { rows: ticketRows } = await db.query<{ status: string }>(
      `select status from support_tickets where id = $1`,
      [ticketId],
    );
    expect(ticketRows[0].status).toBe("resolved");
  });

  it("escalates to a human and logs a zero-confidence decision", async () => {
    const seeded = await seed(db, "ref_support_4");
    const ticketId = await openTicket(
      db,
      seeded.studentId,
      seeded.paymentId,
      "Complicated question",
      "I have a legal question about my application",
    );

    const deps = makeDeps({
      db,
      triageResult: {
        action: "escalate_to_human",
        confidence: 0.2,
        rationale: "outside the scope of an automated agent",
      },
    });

    await runSupport(deps);

    const { rows: ticketRows } = await db.query<{ status: string }>(
      `select status from support_tickets where id = $1`,
      [ticketId],
    );
    expect(ticketRows[0].status).toBe("escalated");

    const { rows: decisionRows } = await db.query<{ confidence: string; escalated: boolean }>(
      `select confidence, escalated from agent_decisions where action = 'escalate_to_human'`,
    );
    expect(Number(decisionRows[0].confidence)).toBe(0);
    expect(decisionRows[0].escalated).toBe(true);
  });
});
