import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { env } from "@/lib/env";
import { initializeTransaction } from "@/lib/paystack";

// R79, in cents -- Paystack amounts are always the smallest currency unit.
const REPORT_PRICE_CENTS = 7900;

interface MatchRunWithEmail {
  id: string;
  email: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const matchRunId = form.get("match_run_id");

  if (typeof matchRunId !== "string" || matchRunId.length === 0) {
    return NextResponse.json({ error: "match_run_id is required" }, { status: 400 });
  }

  // The learner's email comes from the match_run's student record, not from
  // the request -- trusting a client-supplied email here would let anyone
  // send a report link to an address that isn't theirs.
  const { rows } = await getPool().query<MatchRunWithEmail>(
    `select mr.id, s.email
     from match_runs mr
     join students s on s.id = mr.student_id
     where mr.id = $1`,
    [matchRunId],
  );
  const matchRun = rows[0];
  if (!matchRun) {
    return NextResponse.json({ error: "unknown match_run_id" }, { status: 404 });
  }

  const reference = randomUUID();

  // Insert the pending payment row before redirecting to Paystack: if the
  // learner abandons checkout, we still have a record; if they complete it,
  // the webhook has a row to find by (provider, reference).
  await getPool().query(
    `insert into payments (match_run_id, provider, reference, status, amount_cents, currency)
     values ($1, 'paystack', $2, 'pending', $3, 'ZAR')`,
    [matchRun.id, reference, REPORT_PRICE_CENTS],
  );

  const { authorizationUrl } = await initializeTransaction({
    email: matchRun.email,
    amountCents: REPORT_PRICE_CENTS,
    reference,
    callbackUrl: `${env.appBaseUrl}/checkout/callback`,
  });

  return NextResponse.redirect(authorizationUrl, 303);
}
