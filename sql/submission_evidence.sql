-- uniFind submission evidence queries: P&L, unit economics, funnel, and
-- agent autonomy. Every number here is queried from real events
-- (payments, cost_events, agent_decisions) -- nothing in this file is
-- estimated after the fact.

-- ============================================================
-- P&L
-- ============================================================

-- All-time summary. A refunded sale *was* collected, so it counts in gross
-- revenue and is reversed out on its own line -- excluding it from revenue
-- AND subtracting the refund would charge the same R79 twice.
select
    coalesce(sum(amount_cents) filter (where status in ('paid', 'refunded')), 0) as gross_revenue_cents,
    coalesce(sum(amount_cents) filter (where status = 'refunded'), 0) as refunds_cents,
    coalesce(sum(amount_cents) filter (where status in ('paid', 'refunded')), 0)
        - coalesce(sum(amount_cents) filter (where status = 'refunded'), 0) as net_revenue_cents,
    (select coalesce(sum(cost_usd), 0) from cost_events) as gemini_cost_usd
from payments;

-- Daily net revenue: a sale is recognised on the day it was paid; a refund
-- is reversed out on the day it actually happened, not restated back onto
-- the original sale date.
select
    day,
    sum(amount_cents) as net_revenue_cents
from (
    select date_trunc('day', paid_at)::date as day, amount_cents
    from payments
    where paid_at is not null and status in ('paid', 'refunded')
    union all
    select date_trunc('day', refunded_at)::date as day, -amount_cents
    from payments
    where refunded_at is not null and status = 'refunded'
) daily_events
group by day
order by day;

-- ============================================================
-- Unit economics
-- ============================================================

-- Contribution margin per completed report: the R79 price against the
-- Gemini cost actually logged for generating it (amount_cents / 100 gives
-- rand; cost_usd is already in USD, shown side by side rather than
-- converted at a hardcoded exchange rate).
select
    r.id as report_id,
    p.amount_cents / 100.0 as revenue_zar,
    coalesce(sum(ce.cost_usd), 0) as gemini_cost_usd
from reports r
join payments p on p.id = r.payment_id
left join cost_events ce on ce.report_id = r.id
where r.status = 'completed'
group by r.id, p.amount_cents
order by r.id;

-- Gemini spend by source (report generation vs each agent) -- this is what
-- the P&L's cost line is actually made of.
select
    source,
    count(*) as calls,
    sum(prompt_tokens) as prompt_tokens,
    sum(completion_tokens) as completion_tokens,
    sum(cost_usd) as total_cost_usd
from cost_events
group by source
order by total_cost_usd desc;

-- ============================================================
-- Funnel
-- ============================================================

-- Free quiz (match_run) -> checkout started (payment row inserted) ->
-- checkout completed (paid or refunded) -> report delivered, with
-- conversion between each stage.
with funnel as (
    select
        (select count(*) from match_runs) as match_runs,
        (select count(*) from payments) as payments_initiated,
        (select count(*) from payments where status in ('paid', 'refunded')) as payments_paid,
        (select count(*) from reports where status = 'completed') as reports_completed
)
select
    match_runs,
    payments_initiated,
    payments_paid,
    reports_completed,
    round(100.0 * payments_initiated / nullif(match_runs, 0), 1) as pct_started_checkout,
    round(100.0 * payments_paid / nullif(payments_initiated, 0), 1) as pct_completed_payment,
    round(100.0 * reports_completed / nullif(payments_paid, 0), 1) as pct_report_delivered
from funnel;

-- ============================================================
-- Agent autonomy
-- ============================================================

-- All-time autonomy by agent: how much of what each agent decided was
-- applied without a human ever touching it. autonomous_pct excludes
-- overridden decisions from the numerator, matching agent_autonomy_daily.
select
    ar.agent_name,
    count(*) as decisions,
    count(*) filter (where ad.applied) as applied,
    count(*) filter (where ad.escalated) as escalated,
    count(*) filter (where ad.overridden) as overridden,
    round(
        100.0 * count(*) filter (where ad.applied and not ad.overridden) / nullif(count(*), 0),
        2
    ) as autonomous_pct
from agent_decisions ad
join agent_runs ar on ar.id = ad.agent_run_id
group by ar.agent_name
order by ar.agent_name;

-- Daily breakdown, from the view created in 0002_agents.sql.
select * from agent_autonomy_daily order by day, agent_name;
