import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { verifyTransaction, verifyWebhookSignature } from "@/lib/paystack";
import { processPaystackWebhookReference } from "@/payments/webhook";

interface PaystackEvent {
  event: string;
  data?: { reference?: string };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Signature verification needs the exact raw bytes Paystack signed, so
  // read text before any JSON parsing.
  const rawBody = await request.text();
  const signature = request.headers.get("x-paystack-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "malformed body" }, { status: 400 });
  }

  // Only charge.success carries a completed payment; other event types
  // (transfers, disputes, etc.) are irrelevant here and safely ignored.
  const reference = event.event === "charge.success" ? event.data?.reference : undefined;
  if (!reference) {
    return NextResponse.json({ received: true });
  }

  // Duplicates and unknown references are handled outcomes, not errors --
  // they fall through to the 200 below. A genuine failure (DB down, Paystack
  // API error) throws here and Next returns 500, which is what we want:
  // Paystack retries on any non-2xx, and retries are safe because of the
  // on-conflict-do-nothing in processPaystackWebhookReference.
  await processPaystackWebhookReference({ db: getPool(), verifyTransaction }, reference);

  return NextResponse.json({ received: true });
}
