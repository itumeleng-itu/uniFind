import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "./paystack";

describe("paystack HMAC-SHA512 signature verification", () => {
  const secret = "sk_test_examplesecret";
  const rawBody = JSON.stringify({
    event: "charge.success",
    data: { reference: "ref_123", amount: 7900 },
  });
  const sign = (body: string, key: string) =>
    createHmac("sha512", key).update(body).digest("hex");

  it("accepts a signature computed the same way Paystack computes it", () => {
    expect(verifySignature(rawBody, sign(rawBody, secret), secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = sign(rawBody, secret);
    const tampered = rawBody.replace("ref_123", "ref_999");
    expect(verifySignature(tampered, signature, secret)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = sign(rawBody, "wrong-secret");
    expect(verifySignature(rawBody, signature, secret)).toBe(false);
  });

  it("returns false instead of throwing when the header has the wrong length", () => {
    expect(() => verifySignature(rawBody, "too-short", secret)).not.toThrow();
    expect(verifySignature(rawBody, "too-short", secret)).toBe(false);
  });

  it("returns false when no signature header is present", () => {
    expect(verifySignature(rawBody, null, secret)).toBe(false);
    expect(verifySignature(rawBody, undefined, secret)).toBe(false);
  });
});
