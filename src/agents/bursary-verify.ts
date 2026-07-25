import type { DbClient } from "@/lib/dbClient";
import { AgentRun, runAgent } from "./base";

const AUTONOMY_THRESHOLD = 0.8;

export interface BursaryCheckResult {
  isOpen: boolean;
  confidence: number;
  rationale: string;
}

export interface BursaryVerifyDeps {
  db: DbClient;
  checkBursaryPage: (url: string) => Promise<BursaryCheckResult>;
}

interface BursaryRow {
  id: string;
  name: string;
  url: string;
  status: string;
}

async function verifyBursary(
  run: AgentRun,
  deps: BursaryVerifyDeps,
  bursary: BursaryRow,
): Promise<void> {
  const check = await deps.checkBursaryPage(bursary.url);

  if (check.isOpen && bursary.status !== "verified") {
    await run.decide({
      entityType: "bursary",
      entityId: bursary.id,
      action: "promote",
      confidence: check.confidence,
      rationale: check.rationale,
      threshold: AUTONOMY_THRESHOLD,
      apply: async () => {
        await deps.db.query(
          `update bursaries set status = 'verified', last_verified_at = now(), updated_at = now() where id = $1`,
          [bursary.id],
        );
      },
    });
    return;
  }

  if (!check.isOpen && bursary.status === "verified") {
    await run.decide({
      entityType: "bursary",
      entityId: bursary.id,
      action: "expire",
      confidence: check.confidence,
      rationale: check.rationale,
      threshold: AUTONOMY_THRESHOLD,
      apply: async () => {
        await deps.db.query(`update bursaries set status = 'expired', updated_at = now() where id = $1`, [
          bursary.id,
        ]);
      },
    });
  }
}

export async function runBursaryVerify(deps: BursaryVerifyDeps): Promise<void> {
  await runAgent({ db: deps.db }, "bursary-verify", async (run) => {
    const { rows: bursaries } = await deps.db.query<BursaryRow>(
      `select id, name, url, status from bursaries where status in ('pending', 'verified')`,
    );
    for (const bursary of bursaries) {
      await verifyBursary(run, deps, bursary);
    }
    return `checked ${bursaries.length} bursaries`;
  });
}
