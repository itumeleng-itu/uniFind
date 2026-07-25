// Structurally compatible with both `pg`'s Pool/Client and PGlite, so the
// same logic runs against production Postgres and the in-memory test
// database without an adapter.
export interface DbClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface VerifiedTransaction {
  status: string;
  reference: string;
}

export interface ProcessWebhookDeps {
  db: DbClient;
  verifyTransaction: (reference: string) => Promise<VerifiedTransaction>;
}

interface PaymentRow {
  id: string;
  match_run_id: string;
  status: string;
}

// The webhook body claims a charge succeeded, but the body is exactly what
// an attacker who obtained (or guessed) the signature would also send.
// Verifying the HMAC only proves the request came from someone holding the
// secret; re-reading the transaction from Paystack's API is what actually
// confirms the charge happened.
export async function processPaystackWebhookReference(
  deps: ProcessWebhookDeps,
  reference: string,
): Promise<void> {
  const verified = await deps.verifyTransaction(reference);

  const { rows } = await deps.db.query<PaymentRow>(
    `select id, match_run_id, status from payments where provider = 'paystack' and reference = $1`,
    [reference],
  );
  const payment = rows[0];

  // Unknown reference: nothing in our system to reconcile against. Not an
  // error -- Paystack can deliver events for transactions we never
  // initiated (dashboard test pings, replayed data, etc).
  if (!payment) return;

  if (verified.status !== "success") return;

  await deps.db.query(
    `update payments set status = 'paid', updated_at = now() where id = $1 and status <> 'paid'`,
    [payment.id],
  );

  // `on conflict (payment_id) do nothing` is what makes this idempotent
  // under Paystack's retries: the first delivery inserts the report, every
  // later delivery of the same reference is a no-op here.
  await deps.db.query(
    `insert into reports (payment_id, match_run_id, status)
     values ($1, $2, 'pending')
     on conflict (payment_id) do nothing`,
    [payment.id, payment.match_run_id],
  );
}
