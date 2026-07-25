-- Agent execution log and the autonomy metrics built on top of it.
CREATE TABLE agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name text NOT NULL
        CHECK (agent_name IN ('course-sync', 'bursary-verify', 'support')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed')),
    summary text
);

CREATE INDEX agent_runs_agent_name_idx ON agent_runs(agent_name);

CREATE TABLE agent_decisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    entity_type text NOT NULL,
    entity_id uuid,
    action text NOT NULL,
    confidence numeric(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    rationale text NOT NULL,
    threshold numeric(4, 3) NOT NULL,
    -- applied and escalated are mutually exclusive: decide() applies the
    -- change only when confidence clears threshold, otherwise it escalates.
    applied boolean NOT NULL DEFAULT false,
    escalated boolean NOT NULL DEFAULT false,
    -- Set when a human later reverses an applied decision -- this is what
    -- agent_autonomy_daily's "overridden" count measures.
    overridden boolean NOT NULL DEFAULT false,
    reviewed_by text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_decisions_agent_run_id_idx ON agent_decisions(agent_run_id);
CREATE INDEX agent_decisions_created_at_idx ON agent_decisions(created_at);

CREATE TABLE support_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id uuid REFERENCES students(id),
    payment_id uuid REFERENCES payments(id),
    subject text NOT NULL,
    body text NOT NULL,
    status text NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'triaged', 'resolved', 'escalated')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_tickets_status_idx ON support_tickets(status);

-- Daily autonomy rollup: what fraction of agent decisions were applied
-- without a human ever touching them. autonomous_pct excludes overridden
-- decisions from the numerator -- an applied-then-reversed decision was not
-- actually autonomous, it just looked that way until a human caught it.
CREATE VIEW agent_autonomy_daily AS
SELECT
    date_trunc('day', ad.created_at)::date AS day,
    ar.agent_name,
    count(*) AS decisions,
    count(*) FILTER (WHERE ad.applied) AS applied,
    count(*) FILTER (WHERE ad.escalated) AS escalated,
    count(*) FILTER (WHERE ad.overridden) AS overridden,
    round(
        100.0 * count(*) FILTER (WHERE ad.applied AND NOT ad.overridden)
            / NULLIF(count(*), 0),
        2
    ) AS autonomous_pct
FROM agent_decisions ad
JOIN agent_runs ar ON ar.id = ad.agent_run_id
GROUP BY 1, 2;
