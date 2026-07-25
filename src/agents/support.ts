import type { DbClient } from "@/lib/dbClient";
import { AgentRun, runAgent } from "./base";

const AUTONOMY_THRESHOLD = 0.8;

// A ceiling on autonomous refunds, not on confidence: never refund more
// than the price of one report without a human signing off, regardless of
// how sure the triage model is that a refund is warranted.
const AUTO_REFUND_CEILING_CENTS = 7900;

export type SupportAction = "regenerate_report" | "refund" | "resolve" | "escalate_to_human";

export interface TriageResult {
  action: SupportAction;
  confidence: number;
  rationale: string;
  refundAmountCents?: number;
}

export interface SupportDeps {
  db: DbClient;
  triageTicket: (ticket: { subject: string; body: string }) => Promise<TriageResult>;
  generateReport: (reportId: string) => Promise<void>;
  refundTransaction: (reference: string, amountCents?: number) => Promise<{ status: string }>;
}

interface TicketRow {
  id: string;
  student_id: string | null;
  payment_id: string | null;
  subject: string;
  body: string;
}

async function applySupportAction(
  deps: SupportDeps,
  ticket: TicketRow,
  action: SupportAction,
  amountCents: number | undefined,
): Promise<void> {
  if (!ticket.payment_id) return;

  if (action === "refund") {
    const { rows } = await deps.db.query<{ reference: string }>(
      `select reference from payments where id = $1`,
      [ticket.payment_id],
    );
    const reference = rows[0]?.reference;
    if (!reference) return;
    await deps.refundTransaction(reference, amountCents);
    await deps.db.query(`update payments set status = 'refunded', updated_at = now() where id = $1`, [
      ticket.payment_id,
    ]);
    return;
  }

  if (action === "regenerate_report") {
    const { rows } = await deps.db.query<{ id: string }>(
      `select id from reports where payment_id = $1`,
      [ticket.payment_id],
    );
    const reportId = rows[0]?.id;
    if (!reportId) return;
    await deps.db.query(`update reports set status = 'pending' where id = $1`, [reportId]);
    await deps.generateReport(reportId);
  }
  // "resolve": nothing further to mutate besides the ticket status itself.
}

async function triageOne(run: AgentRun, deps: SupportDeps, ticket: TicketRow): Promise<void> {
  const triage = await deps.triageTicket({ subject: ticket.subject, body: ticket.body });

  // The triage model's own abstention -- there is no autonomous action to
  // gate, so this is logged as an always-escalated decision (confidence 0)
  // rather than skipped, keeping every ticket outcome in the audit trail.
  if (triage.action === "escalate_to_human") {
    await run.decide({
      entityType: "support_ticket",
      entityId: ticket.id,
      action: "escalate_to_human",
      confidence: 0,
      rationale: triage.rationale,
      threshold: AUTONOMY_THRESHOLD,
      apply: async () => {},
    });
    await deps.db.query(`update support_tickets set status = 'escalated', updated_at = now() where id = $1`, [
      ticket.id,
    ]);
    return;
  }

  const amount =
    triage.action === "refund" ? triage.refundAmountCents ?? AUTO_REFUND_CEILING_CENTS : undefined;
  const withinCeiling = amount === undefined || amount <= AUTO_REFUND_CEILING_CENTS;
  const effectiveConfidence = withinCeiling ? triage.confidence : 0;

  const result = await run.decide({
    entityType: "support_ticket",
    entityId: ticket.id,
    action: triage.action,
    confidence: effectiveConfidence,
    rationale: triage.rationale,
    threshold: AUTONOMY_THRESHOLD,
    apply: () => applySupportAction(deps, ticket, triage.action, amount),
  });

  await deps.db.query(`update support_tickets set status = $2, updated_at = now() where id = $1`, [
    ticket.id,
    result.applied ? "resolved" : "escalated",
  ]);
}

export async function runSupport(deps: SupportDeps): Promise<void> {
  await runAgent({ db: deps.db }, "support", async (run) => {
    const { rows: tickets } = await deps.db.query<TicketRow>(
      `select id, student_id, payment_id, subject, body from support_tickets where status = 'open'`,
    );
    for (const ticket of tickets) {
      await triageOne(run, deps, ticket);
    }
    return `triaged ${tickets.length} tickets`;
  });
}
