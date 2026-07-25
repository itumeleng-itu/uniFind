import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

// Pure and dependency-free so it's directly unit-testable against a known
// HMAC, and reusable if a caller ever needs to verify against a non-default
// secret. timingSafeEqual throws on a length mismatch instead of returning
// false, so an attacker sending a wrong-length header would 500 the webhook
// instead of cleanly 401ing -- check lengths first.
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
): boolean {
  return verifySignature(rawBody, signatureHeader, env.paystackSecretKey);
}

interface PaystackErrorBody {
  message?: string;
}

async function paystackFetch<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const body = await res.json();
  if (!res.ok) {
    const message = (body as PaystackErrorBody).message ?? res.statusText;
    throw new Error(`Paystack ${path} failed (${res.status}): ${message}`);
  }
  return body as T;
}

export interface InitializeParams {
  email: string;
  amountCents: number;
  reference: string;
  callbackUrl: string;
}

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export async function initializeTransaction(
  params: InitializeParams,
): Promise<InitializeResult> {
  const body = await paystackFetch<{
    data: { authorization_url: string; access_code: string; reference: string };
  }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      amount: params.amountCents,
      reference: params.reference,
      callback_url: params.callbackUrl,
      currency: "ZAR",
      // Instant EFT and Capitec Pay need a separate KYC review, and mobile
      // money/USSD aren't SA channels at all -- listing either breaks
      // checkout rather than just hiding an option.
      channels: ["card", "bank_transfer"],
    }),
  });

  return {
    authorizationUrl: body.data.authorization_url,
    accessCode: body.data.access_code,
    reference: body.data.reference,
  };
}

export interface VerifyResult {
  status: string;
  reference: string;
  amountCents: number;
  currency: string;
  paidAt: string | null;
}

export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  const body = await paystackFetch<{
    data: {
      status: string;
      reference: string;
      amount: number;
      currency: string;
      paid_at: string | null;
    };
  }>(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });

  return {
    status: body.data.status,
    reference: body.data.reference,
    amountCents: body.data.amount,
    currency: body.data.currency,
    paidAt: body.data.paid_at,
  };
}

export interface RefundResult {
  status: string;
  reference: string;
}

export async function refundTransaction(
  reference: string,
  amountCents?: number,
): Promise<RefundResult> {
  const body = await paystackFetch<{ data: { status: string } }>("/refund", {
    method: "POST",
    body: JSON.stringify({
      transaction: reference,
      ...(amountCents !== undefined ? { amount: amountCents } : {}),
    }),
  });

  return { status: body.data.status, reference };
}
