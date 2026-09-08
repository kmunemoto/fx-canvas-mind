-- The record stops calling the analyst's own WAIT a server refusal.
--
-- Measured in production on 2026-09-08 (contract market_v1, shadow and preview
-- excluded): 16 rows carried entry_check.rejection = 'low_confidence' on a WAIT
-- the MODEL ITSELF proposed — the entry gate refused nothing there, it agreed —
-- against exactly 1 row where the gate turned a proposed SELL into a WAIT
-- (poor_rr, risk/reward 1.19 against a floor of 1.20). `rejected` counted all
-- 17, and the sentence on the history screen rendered from it told a paying
-- user that the server had overruled its analyst sixteen times.
--
-- Nothing in the stored rows is rewritten: the 16 keep their rejection string.
-- What changes is who reads it as a refusal. The split is the same one
-- src/lib/outcomeStats.ts makes (isRejected / isSelfDeclined), and the two
-- must agree — the screen falls back to the client-side tally when this
-- function cannot be reached, and a fallback that disagrees with the server is
-- how one number with one name becomes two.
--
-- Only the two counters change. Every other field of the output object, the
-- argument list, and SECURITY INVOKER are carried over from
-- 20260907041000_one_episode_definition.sql verbatim.

create or replace function public.performance_stats(live_contract text default 'market_v1')
returns jsonb
language sql
stable
-- SECURITY INVOKER, spelled out rather than left to the default. public.analyses
-- has RLS enabled, so running as the caller is the whole of how this function is
-- scoped to one account: there is deliberately no user_id = auth.uid() in the
-- body, and adding one would be redundant here. public.loop_health is the other
-- way round — SECURITY DEFINER, which is why IT filters on auth.uid() explicitly.
security invoker
set search_path to 'public', 'pg_temp'
as $function$
with recursive mine as (
  select
    a.id, a.pair, a.signal, a.interval, a.mode, a.confidence, a.created_at,
    a.outcome, a.closed_at, a.entry_point, a.stop_loss, a.take_profit_1, a.outcome_price,
    a.evaluation, a.entry_check, a.wait_check, a.rulebook_version,
    coalesce(a.plan_contract, 'entry_chosen_v1') as contract
  from public.analyses a
  where a.shadow = false and a.preview = false
),
ordered as (
  select m.*, row_number() over (partition by m.pair, m.signal order by m.created_at, m.id) as rn
  from mine m
),
-- The episode rule, in SQL. The recursion carries two things forward now:
-- the episode's START, which anchors the 24h window (so a long run of plans
-- is cut every day rather than chained forever), and the settlement time of
-- the row IMMEDIATELY BEFORE, which opens the reopen escape.
--
-- prev_closed is that one row's closed_at and never an older one's. Carrying
-- the newest settlement forward would let a plan escape on the strength of
-- some other, long-closed plan while the plan before it was still open, and
-- an open position is the strongest evidence there is that we are still in
-- the same bet.
--
-- Both boundaries are the ones episodes.ts has: `<` on the window, so exactly
-- 24 hours SEPARATES, and `>` on the escape, so settling exactly 4 hours ahead
-- does NOT escape. null closed_at means still open or never recorded, and
-- neither may open the escape — hence the `is not null` guard rather than a
-- comparison that would go null and be read as false anyway.
clustered as (
  select o.id, o.pair, o.signal, o.rn, o.created_at as cluster_start, o.closed_at as prev_closed
  from ordered o where o.rn = 1
  union all
  select o.id, o.pair, o.signal, o.rn,
         case when o.created_at - c.cluster_start < interval '24 hours'
               and not (c.prev_closed is not null
                        and o.created_at > c.prev_closed + interval '4 hours')
              then c.cluster_start else o.created_at end,
         o.closed_at
  from ordered o
  join clustered c on c.pair = o.pair and c.signal = o.signal and o.rn = c.rn + 1
),
base as (
  select
    m.*,
    -- at time zone 'UTC' rather than bare to_char: to_char follows the session
    -- TimeZone, and the TS side labels with toISOString(). The database runs
    -- UTC today, so the two agree; a session on any other zone would relabel
    -- every episode and the two counts would stop being comparable row by row.
    -- (Grouping is unaffected either way, since distinct episode starts are
    -- always at least four hours apart. The label is what diverges.)
    (m.pair || '|' || m.signal || '|'
      || to_char(c.cluster_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24')) as cluster_id,
    row_number() over (order by m.created_at desc, m.id desc) as call_rank,
    (m.signal = 'WAIT' or m.outcome = 'skipped') as is_wait,
    -- WHO DECLINED. Two events, and this function reported both as the first.
    --
    -- `rejected` is now only what its name has always claimed: the analyst
    -- asked for a trade and the server published a WAIT instead. The
    -- confidence floor stamps a rejection on a WAIT THE MODEL ITSELF
    -- ANSWERED, so the rejection string alone cannot tell an override from an
    -- agreement; proposed_signal can.
    --
    -- coalesce to '' rather than comparing the missing field directly: on a
    -- row written before entry_check carried proposed_signal the `->>` is
    -- NULL, `NULL in ('BUY','SELL')` is NULL, and the row would land wherever
    -- three-valued logic dropped it. It lands in NEITHER count, on purpose.
    -- Measured 2026-09-08: 11 such rows, every one on entry_chosen_v1 and not
    -- one of them carrying a rejection, so nothing moves either way today —
    -- but with no record of what was asked for there is no evidence for
    -- either claim, and the claim this whole change exists to stop making is
    -- that the server overrode an analyst that had proposed nothing.
    (m.signal = 'WAIT'
     and coalesce(m.entry_check->>'proposed_signal', '') in ('BUY', 'SELL')
     and coalesce(m.entry_check->>'rejection', '') <> '') as rejected,
    (m.signal = 'WAIT'
     and coalesce(m.entry_check->>'proposed_signal', '') = 'WAIT') as self_declined,
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
    count(*) filter (where t.self_declined)::int as self_declined,
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
      'self_declined', a.self_declined,
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
      'win_rate', case when a.wins + a.losses + a.expired > 0
        then round(a.wins::numeric * 100 / (a.wins + a.losses + a.expired))::int end,
      'win_rate_ci95', case when a.wins + a.losses + a.expired > 0
        then public.wilson95(a.wins, a.wins + a.losses + a.expired) end,
      'fill_rate', case when a.settled > 0 then round(a.filled::numeric * 100 / a.settled)::int end,
      'sum_r', case when a.with_r > 0 then round(a.sum_r, 2) end,
      'expectancy', case when a.with_r > 0 then round(a.sum_r / a.with_r, 2) end,
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
      'below_min_n', (a.wins + a.losses + a.expired) < 20
    ) as value
  from agg a
)
select jsonb_build_object(
  'generated_at', now(),
  'live_contract', live_contract,
  -- Which definition of "one situation" produced every `clusters` below.
  -- A change in counting method looks exactly like the analyst getting better
  -- or worse, and nothing else on this object can tell them apart.
  'episode_definition_version', 2,
  'scopes', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'scope'), '{}'::jsonb),
  'by_rulebook_version', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_rulebook_version'), '{}'::jsonb),
  'by_confidence', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_confidence'), '{}'::jsonb),
  'by_timeframe', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_timeframe'), '{}'::jsonb),
  'by_mode', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_mode'), '{}'::jsonb),
  'by_contract', coalesce((select jsonb_object_agg(key, value) from shaped where dim = 'by_contract'), '{}'::jsonb),
  'other_contract_rows', (select count(*)::int from mine where contract <> live_contract),
  'other_contracts', coalesce(
    (select to_jsonb(array_agg(distinct contract)) from mine where contract <> live_contract),
    '[]'::jsonb),
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
  ),
  -- Excluded above, counted here. Weekend reads are not a silence in the
  -- record; they are a thing that happened and did not count.
  'preview', (
    select jsonb_build_object(
      'total', count(*)::int,
      'last_at', max(created_at)
    )
    from public.analyses where preview = true
  )
);
$function$;

-- Unchanged by this migration — create or replace keeps the ACL — and restated
-- so the file is a complete statement of who may call the function.
revoke all on function public.performance_stats(text) from public;
revoke all on function public.performance_stats(text) from anon;
grant execute on function public.performance_stats(text) to authenticated;
