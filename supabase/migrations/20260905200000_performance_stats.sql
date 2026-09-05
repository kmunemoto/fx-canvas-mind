-- Applied to production in two steps: this file is the final state. The first
-- version filtered the whole function to the live contract, which showed a
-- record made entirely under an older contract as empty — and production is
-- exactly that case. The correction is the by_contract block below
-- (migration performance_stats_keeps_every_contract).

-- Wilson score interval for a proportion, in percent. Split out so the
-- statistics function below stays readable and so the two implementations (this and wilson() in
-- src/lib/outcomeStats.ts) can be compared side by side.
create or replace function public.wilson95(successes int, n int)
returns jsonb
language sql
immutable
set search_path = pg_temp
as $$
  select case when n <= 0 then null else (
    with c as (
      select successes::numeric / n as p, 1.96::numeric as z, n::numeric as nn
    ), d as (
      select p, z, nn, 1 + z * z / nn as denom from c
    ), e as (
      select
        (p + z * z / (2 * nn)) / denom as centre,
        (z * sqrt(p * (1 - p) / nn + z * z / (4 * nn * nn))) / denom as half
      from d
    )
    select jsonb_build_array(
      round(greatest(0, centre - half) * 100)::int,
      round(least(1, centre + half) * 100)::int
    ) from e
  ) end;
$$;


-- Performance statistics, computed over the whole record instead of over
-- whatever the browser happened to fetch.
--
-- Every number the panel shows is currently computed in the client from ONE
-- query: the 40 newest rows. The consequences are not cosmetic. `clusters` is
-- compared against a target of 50 independent situations out of a 40-row
-- window, so that target can never be reached and the branch behind it is
-- dead code. The P&L total is a sliding-window sum, so it can FALL after a
-- winning trade, because an older trade dropped out of the window at the same
-- time. The confidence interval never narrows, because n plateaus at 40. And
-- every group-by splits those 40 rows into cells of two or three and colours
-- their win rates with full confidence.
--
-- SECURITY INVOKER is load-bearing: RLS then scopes this to the caller's own
-- rows and no user filter can be forgotten. loop_health() is the
-- counter-example — it is definer, and two of its counters silently count
-- every account.
--
-- WHAT THE SHAPE ENFORCES: no group ever returns a bare win rate. It comes
-- with `decided`, `sum_r`, `trades_per_call` and `wait_rate` in the same
-- object, because a rulebook that raises the win rate by taking fewer trades
-- and a rulebook that is right more often look identical in the rate alone and
-- completely different in those four together. The first shows a falling
-- decided, a falling trades_per_call, a rising wait_rate and a falling sum_r.
--
-- Contracts are never pooled. Under entry_chosen_v1 the model chose its own
-- entry and a plan the market never reached went unscored; under market_v1
-- that cannot happen. The scopes and group-bys describe the live contract
-- only, with the rest counted in `other_contract_rows`. Each contract also
-- gets its own complete object in `by_contract`, so a record made entirely
-- under an older contract is still visible — correctly labelled rather than
-- averaged into a population that never existed, and rather than hidden.
create or replace function public.performance_stats(live_contract text default 'market_v1')
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
with recursive mine as (
  select
    a.id, a.pair, a.signal, a.interval, a.mode, a.confidence, a.created_at,
    a.outcome, a.entry_point, a.stop_loss, a.take_profit_1, a.outcome_price,
    a.evaluation, a.entry_check, a.wait_check, a.rulebook_version,
    coalesce(a.plan_contract, 'entry_chosen_v1') as contract
  from public.analyses a
  where a.shadow = false
),
-- Cluster ids, anchored on the FIRST plan of each run rather than the
-- previous one: same pair, same direction, opened within 24 hours of the
-- cluster's start. Mirrors clusterIds() in src/lib/outcomeStats.ts.
ordered as (
  select m.*, row_number() over (partition by m.pair, m.signal order by m.created_at, m.id) as rn
  from mine m
),
clustered as (
  select o.id, o.pair, o.signal, o.rn, o.created_at as cluster_start
  from ordered o where o.rn = 1
  union all
  select o.id, o.pair, o.signal, o.rn,
         case when o.created_at - c.cluster_start < interval '24 hours'
              then c.cluster_start else o.created_at end
  from ordered o
  join clustered c on c.pair = o.pair and c.signal = o.signal and o.rn = c.rn + 1
),
base as (
  select
    m.*,
    (m.pair || '|' || m.signal || '|' || to_char(c.cluster_start, 'YYYY-MM-DD"T"HH24')) as cluster_id,
    row_number() over (order by m.created_at desc, m.id desc) as call_rank,
    (m.signal = 'WAIT' or m.outcome = 'skipped') as is_wait,
    (m.signal = 'WAIT' and coalesce(m.entry_check->>'rejection', '') <> '') as rejected,
    -- Only the current scorer's WAIT verdicts. The first one chose the
    -- direction from whichever side paid, so its miss rate measured the
    -- market's range; pooling the two rules would carry that in invisibly.
    (coalesce((m.wait_check->>'scorer')::int, 0) >= 2
     and m.wait_check->>'verdict' in ('missed', 'correct')) as wait_judged,
    (coalesce((m.wait_check->>'scorer')::int, 0) >= 2
     and m.wait_check->>'verdict' = 'missed') as wait_missed,
    (m.outcome = 'ambiguous' and m.evaluation->>'reason' = 'incoherent') as incoherent,
    (m.outcome in ('win', 'loss', 'expired')
     or (m.outcome = 'ambiguous' and coalesce(m.evaluation->>'filled_at', '') <> '')) as filled,
    case
      when m.signal not in ('BUY', 'SELL') then null
      when coalesce((m.evaluation->>'fill_price')::numeric, m.entry_point) is null
        or m.stop_loss is null or m.take_profit_1 is null then null
      when abs(coalesce((m.evaluation->>'fill_price')::numeric, m.entry_point) - m.stop_loss) <= 0 then null
      when m.outcome = 'win' then round(
        abs(m.take_profit_1 - coalesce((m.evaluation->>'fill_price')::numeric, m.entry_point))
        / abs(coalesce((m.evaluation->>'fill_price')::numeric, m.entry_point) - m.stop_loss), 2)
      when m.outcome = 'loss' then -1
      when m.outcome = 'expired' and m.outcome_price is not null then round(
        (case when m.signal = 'BUY' then 1 else -1 end)
        * (m.outcome_price - coalesce((m.evaluation->>'fill_price')::numeric, m.entry_point))
        / abs(coalesce((m.evaluation->>'fill_price')::numeric, m.entry_point) - m.stop_loss), 2)
      else null
    end as realized_r,
    case
      when m.confidence is null then 'unknown'
      when m.confidence <= 59 then '0-59'
      when m.confidence <= 69 then '60-69'
      when m.confidence <= 79 then '70-79'
      else '80+'
    end as confidence_key,
    case
      when m.rulebook_version is not null and m.rulebook_version > 0
        then m.contract || '|v' || m.rulebook_version
      else m.contract || '|none'
    end as rulebook_key
  from mine m
  left join clustered c on c.id = m.id
),
-- The scopes and the group-bys describe the LIVE contract only: under
-- entry_chosen_v1 the model chose its own entry and a plan the market never
-- reached went unscored, so pooling the two answers a question nobody asked.
--
-- by_contract is the exception, and it is computed over every row: a record
-- made entirely under the old contract is still that user's record, and
-- filtering it away would show them nothing at all rather than something
-- correctly labelled. Not pooled — each contract keeps its own object.
tagged as (
  select b.*, d.dim, d.key
  from base b
  cross join lateral (
    select 'scope'::text as dim, 'all_time'::text as key
    union all select 'scope', 'last_90d' where b.created_at >= now() - interval '90 days'
    union all select 'scope', 'last_50_calls' where b.call_rank <= 50
    union all select 'by_rulebook_version', b.rulebook_key
    union all select 'by_confidence', b.confidence_key
    union all select 'by_timeframe', b.interval
    union all select 'by_mode', coalesce(b.mode, 'unknown')
  ) d
  where b.contract = live_contract
  union all
  select b.*, 'by_contract'::text as dim, b.contract as key
  from base b
),
agg as (
  select
    t.dim, t.key,
    count(*)::int as calls,
    count(*) filter (where t.is_wait)::int as waits,
    count(*) filter (where t.rejected)::int as rejected,
    count(*) filter (where t.is_wait and t.wait_judged)::int as waits_judged,
    count(*) filter (where t.is_wait and t.wait_missed)::int as waits_missed,
    count(*) filter (where not t.is_wait)::int as total,
    count(*) filter (where not t.is_wait and t.outcome = 'win')::int as wins,
    count(*) filter (where not t.is_wait and t.outcome = 'loss')::int as losses,
    count(*) filter (where not t.is_wait and t.outcome = 'expired')::int as expired,
    count(*) filter (where not t.is_wait and t.outcome = 'pending')::int as open,
    count(*) filter (where not t.is_wait and t.outcome = 'untriggered')::int as untriggered,
    count(*) filter (where not t.is_wait and t.outcome = 'ambiguous' and not t.incoherent)::int as ambiguous,
    count(*) filter (where not t.is_wait and t.incoherent)::int as incoherent,
    count(*) filter (where not t.is_wait and t.filled)::int as filled,
    count(*) filter (where not t.is_wait and (t.filled or t.outcome = 'untriggered'))::int as settled,
    count(*) filter (where t.realized_r is not null)::int as with_r,
    coalesce(sum(t.realized_r) filter (where t.realized_r is not null), 0)::numeric as sum_r,
    count(distinct t.cluster_id) filter (where t.outcome in ('win', 'loss'))::int as clusters,
    array_agg(distinct t.contract) as contracts
  from tagged t
  group by t.dim, t.key
),
shaped as (
  select
    a.dim, a.key,
    jsonb_build_object(
      'calls', a.calls,
      'waits', a.waits,
      'rejected', a.rejected,
      'waits_judged', a.waits_judged,
      'waits_missed', a.waits_missed,
      'total', a.total,
      'wins', a.wins,
      'losses', a.losses,
      'expired', a.expired,
      'open', a.open,
      'untriggered', a.untriggered,
      'ambiguous', a.ambiguous,
      'incoherent', a.incoherent,
      'filled', a.filled,
      'settled', a.settled,
      'decided', a.wins + a.losses + a.expired,
      'with_r', a.with_r,
      'clusters', a.clusters,
      'contracts', to_jsonb(a.contracts),
      -- Every rate below is published only WITH the counts above it in the
      -- same object. A rate on its own cannot distinguish "right more often"
      -- from "traded less".
      'win_rate', case when a.wins + a.losses + a.expired > 0
        then round(a.wins::numeric * 100 / (a.wins + a.losses + a.expired))::int end,
      'win_rate_ci95', case when a.wins + a.losses + a.expired > 0
        then public.wilson95(a.wins, a.wins + a.losses + a.expired) end,
      'fill_rate', case when a.settled > 0 then round(a.filled::numeric * 100 / a.settled)::int end,
      'sum_r', case when a.with_r > 0 then round(a.sum_r, 2) end,
      'expectancy', case when a.with_r > 0 then round(a.sum_r / a.with_r, 2) end,
      -- How many trades one call buys. A rulebook that raises the win rate by
      -- standing aside more shows up here and nowhere else.
      'trades_per_call', case when a.calls > 0 then round(a.total::numeric / a.calls, 2) end,
      'verdict_rate', case when a.calls > 0
        then round((a.wins + a.losses)::numeric * 100 / a.calls)::int end,
      'wait_rate', case when a.calls > 0 then round(a.waits::numeric * 100 / a.calls)::int end,
      'expired_rate', case when a.calls > 0 then round(a.expired::numeric * 100 / a.calls)::int end,
      'untriggered_rate', case when a.calls > 0 then round(a.untriggered::numeric * 100 / a.calls)::int end,
      'ambiguous_rate', case when a.calls > 0 then round(a.ambiguous::numeric * 100 / a.calls)::int end,
      'incoherent_rate', case when a.calls > 0 then round(a.incoherent::numeric * 100 / a.calls)::int end,
      'open_rate', case when a.calls > 0 then round(a.open::numeric * 100 / a.calls)::int end,
      'wait_miss_rate', case when a.waits_judged > 0
        then round(a.waits_missed::numeric * 100 / a.waits_judged)::int end,
      -- Below this the rate is real but the interval around it spans most of
      -- the range. Reported rather than withheld: an interval says more than
      -- a blank, and hiding the number would hide how little there is.
      'below_min_n', (a.wins + a.losses + a.expired) < 20
    ) as value
  from agg a
)
select jsonb_build_object(
  'generated_at', now(),
  'live_contract', live_contract,
  'scopes', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'scope'), '{}'::jsonb),
  'by_rulebook_version', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_rulebook_version'), '{}'::jsonb),
  'by_confidence', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_confidence'), '{}'::jsonb),
  'by_timeframe', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_timeframe'), '{}'::jsonb),
  'by_mode', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_mode'), '{}'::jsonb),
  -- Every contract's own record, kept apart rather than pooled. The client
  -- reads the live one; when the live one is empty because every plan was
  -- made under an older contract, this is where the record still is.
  'by_contract', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_contract'), '{}'::jsonb),
  -- Rows the record excludes rather than pools: a different entry contract
  -- answers a different question.
  'other_contract_rows', (select count(*)::int from mine where contract <> live_contract),
  'other_contracts', coalesce(
    (select to_jsonb(array_agg(distinct contract)) from mine where contract <> live_contract),
    '[]'::jsonb),
  -- Plans the gate refused, tracked apart. Never part of the record; this is
  -- how the gate itself is checked.
  'shadow', (
    select jsonb_build_object(
      'total', count(*)::int,
      'untriggered', count(*) filter (where outcome = 'untriggered')::int,
      'wins', count(*) filter (where outcome = 'win')::int,
      'losses', count(*) filter (where outcome = 'loss')::int,
      'open', count(*) filter (where outcome = 'pending')::int,
      'other', count(*) filter (where outcome not in ('untriggered', 'win', 'loss', 'pending'))::int
    )
    from public.analyses where shadow = true
  )
);
$$;

revoke all on function public.performance_stats(text) from public;
revoke all on function public.performance_stats(text) from anon;
grant execute on function public.performance_stats(text) to authenticated;
revoke all on function public.wilson95(int, int) from public;
grant execute on function public.wilson95(int, int) to authenticated;
