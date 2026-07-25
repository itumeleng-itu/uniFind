import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../db/migrate";
import { runBursaryVerify, type BursaryVerifyDeps } from "./bursary-verify";

async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await applyMigrations(db);
  return db;
}

describe("phase 6: bursary-verify", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("promotes a pending bursary when the page confirms it's open with high confidence", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into bursaries (name, provider, url, status)
       values ('New Bursary', 'Foundation', 'https://example.org', 'pending')
       returning id`,
    );

    const deps: BursaryVerifyDeps = {
      db,
      checkBursaryPage: async () => ({
        isOpen: true,
        confidence: 0.95,
        rationale: "application form is live on the page",
      }),
    };

    await runBursaryVerify(deps);

    const { rows: after } = await db.query<{ status: string }>(
      `select status from bursaries where id = $1`,
      [rows[0].id],
    );
    expect(after[0].status).toBe("verified");
  });

  it("expires a verified bursary when the page shows it closed with high confidence", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into bursaries (name, provider, url, status)
       values ('Old Bursary', 'Foundation', 'https://example.org', 'verified')
       returning id`,
    );

    const deps: BursaryVerifyDeps = {
      db,
      checkBursaryPage: async () => ({
        isOpen: false,
        confidence: 0.9,
        rationale: "page explicitly states applications closed",
      }),
    };

    await runBursaryVerify(deps);

    const { rows: after } = await db.query<{ status: string }>(
      `select status from bursaries where id = $1`,
      [rows[0].id],
    );
    expect(after[0].status).toBe("expired");
  });

  it("leaves a verified bursary alone when confidence is below threshold", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into bursaries (name, provider, url, status)
       values ('Ambiguous Bursary', 'Foundation', 'https://example.org', 'verified')
       returning id`,
    );

    const deps: BursaryVerifyDeps = {
      db,
      checkBursaryPage: async () => ({
        isOpen: false,
        confidence: 0.3,
        rationale: "page failed to load fully",
      }),
    };

    await runBursaryVerify(deps);

    const { rows: after } = await db.query<{ status: string }>(
      `select status from bursaries where id = $1`,
      [rows[0].id],
    );
    expect(after[0].status).toBe("verified");
  });
});
