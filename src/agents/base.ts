import type { DbClient } from "@/lib/dbClient";

export type AgentName = "course-sync" | "bursary-verify" | "support";

export interface DecisionInput {
  entityType: string;
  entityId: string | null;
  action: string;
  confidence: number;
  rationale: string;
  threshold: number;
  apply: () => Promise<void>;
}

export interface DecisionResult {
  id: string;
  applied: boolean;
  escalated: boolean;
}

export class AgentRun {
  constructor(
    private readonly db: DbClient,
    public readonly id: string,
  ) {}

  // Every decision is logged before it is applied. Below-threshold
  // decisions are recorded but apply() is never called -- the row itself
  // is the escalation, there is no separate "pending" state to review
  // elsewhere.
  async decide(input: DecisionInput): Promise<DecisionResult> {
    const meetsThreshold = input.confidence >= input.threshold;

    const { rows } = await this.db.query<{ id: string }>(
      `insert into agent_decisions
         (agent_run_id, entity_type, entity_id, action, confidence, rationale, threshold, applied, escalated)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        this.id,
        input.entityType,
        input.entityId,
        input.action,
        input.confidence,
        input.rationale,
        input.threshold,
        meetsThreshold,
        !meetsThreshold,
      ],
    );
    const decisionId = rows[0].id;

    if (meetsThreshold) {
      await input.apply();
    }

    return { id: decisionId, applied: meetsThreshold, escalated: !meetsThreshold };
  }
}

export interface RunAgentDeps {
  db: DbClient;
}

export async function runAgent(
  deps: RunAgentDeps,
  agentName: AgentName,
  work: (run: AgentRun) => Promise<string | void>,
): Promise<void> {
  const { rows } = await deps.db.query<{ id: string }>(
    `insert into agent_runs (agent_name, status) values ($1, 'running') returning id`,
    [agentName],
  );
  const runId = rows[0].id;
  const run = new AgentRun(deps.db, runId);

  try {
    const summary = await work(run);
    await deps.db.query(
      `update agent_runs set status = 'completed', finished_at = now(), summary = $2 where id = $1`,
      [runId, summary ?? null],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db.query(
      `update agent_runs set status = 'failed', finished_at = now(), summary = $2 where id = $1`,
      [runId, message],
    );
    throw err;
  }
}
