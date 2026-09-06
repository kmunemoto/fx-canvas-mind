-- The weekend read: a row that is kept, and never scored.
--
-- analyze used to refuse outright while the market was shut — HTTP 409 before
-- any model call, quota or row. That put the analyst out of reach from Friday
-- 21:00 UTC to Sunday 22:00 UTC, about 49 hours a week, which in Japan is the
-- whole of Saturday and Sunday. Nothing the server computes off Friday's close
-- stops being true on a Sunday: the indicators, the structure, the divergence,
-- the rules whose situation matches, the week's calendar. Only the entry does.
--
-- So the run now goes ahead as a PREVIEW. The existing entry gate already
-- turns a closed market into a WAIT with no entry, stop or targets; this
-- column marks that the market was shut when the request ARRIVED, which is
-- what makes the row unscoreable rather than merely cautious.
--
-- Why a column and not a reuse of `shadow` or `plan_contract`:
--   `shadow` means the twin of a plan the gate refused on fillability, folded
--   back into its parent in the history — a different thing with its own
--   display path. `plan_contract` decides which learned rules may be shown in
--   the prompt, and a preview must still see them.
alter table public.analyses
  add column if not exists preview boolean not null default false;

comment on column public.analyses.preview is
  'The FX market was shut when this analysis was requested, so it is a read of the last close and not a plan. Never scored, never diagnosed, never counted in any statistic. Carries no wait_plan, which is what keeps the WAIT sweep and the post-mortem from picking it up.';

-- Statistics: two contracts were already two populations; a preview is not a
-- population at all. It is excluded from `mine`, which is the single source
-- every scope, dimension, cluster and rate is built from — so one line here
-- covers win rate, fill rate, expectancy, clusters and every ratio.
--
-- Its count is reported rather than dropped, beside the shadow tally, for the
-- same reason the chart prints how many levels it could not draw: a number
-- that silently vanishes reads as a number that was never there.
create or replace function public.performance_stats(live_contract text default 'market_v1')
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
with recursive mine as (
  select
    a.id, a.pair, a.signal, a.interval, a.mode, a.confidence, a.created_at,
    a.outcome, a.entry_point, a.stop_loss, a.take_profit_1, a.outcome_price,
    a.evaluation, a.entry_check, a.wait_check, a.rulebook_version,
    coalesce(a.plan_contract, 'entry_chosen_v1') as contract
  from public.analyses a
  where a.shadow = false and a.preview = false
),
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

-- The loop's own dashboard. The WAIT queue already skipped previews by
-- accident — it requires `wait_plan is not null`, which a preview never has —
-- and `reviewed` and `decided_under_version` skip them because a preview is
-- never diagnosed and never settles. Saying it out loud anyway: an invariant
-- that holds by side effect is one nobody will notice breaking.
create or replace function public.loop_health()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select jsonb_build_object(
    'tracker_last_run_at', (select last_sweep_at from public.tracker_state where id = 1),
    'postmortem_last_run_at', (select last_run_at from public.postmortem_state where id = 1),
    'postmortem_last_diagnosed', (select (last_result->>'diagnosed')::int from public.postmortem_state where id = 1),
    'postmortem_version', (select last_result->>'version' from public.postmortem_state where id = 1),
    'open_plans', (
      select count(*) from public.analyses
      where user_id = auth.uid() and shadow = false and preview = false
        and signal in ('BUY', 'SELL') and outcome = 'pending'
    ),
    'awaiting_review', (
      select count(*) from public.analyses
      where user_id = auth.uid() and shadow = false and preview = false
        and (postmortem is null or postmortem->>'status' <> 'done')
        and (
          (signal in ('BUY', 'SELL') and outcome in ('win', 'loss', 'untriggered', 'expired', 'ambiguous'))
          or (signal = 'WAIT' and outcome = 'skipped' and wait_plan is not null
              and wait_check->>'verdict' in ('missed', 'correct'))
        )
    ),
    'reviewed', (
      select count(*) from public.analyses
      where user_id = auth.uid() and shadow = false and preview = false
        and postmortem->>'status' = 'done'
    ),
    'lessons', (select count(*) from public.lessons where user_id = auth.uid()),
    'rulebook_version', (select version from public.rulebook where id = 1),
    'rulebook_updated_at', (select updated_at from public.rulebook where id = 1),
    -- Counted from the same clock the loop paces on: the last revision
    -- WRITTEN, promoted or not.
    'lessons_since_rulebook', (
      select count(*) from public.lessons l cross join public.rulebook r
      where r.id = 1
        and (coalesce((r.candidate->>'created_at')::timestamptz, r.updated_at) is null
             or l.created_at > coalesce((r.candidate->>'created_at')::timestamptz, r.updated_at))
    ),
    'candidate_waiting', (select (candidate is not null) from public.rulebook where id = 1),
    'candidate_created_at', (select (candidate->>'created_at')::timestamptz from public.rulebook where id = 1),
    'decided_under_version', (
      select count(*) from public.analyses a cross join public.rulebook r
      where r.id = 1 and r.version > 0 and a.rulebook_version = r.version
        and a.shadow = false and a.preview = false
        and a.outcome in ('win', 'loss', 'expired')
    ),
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname), '[]'::jsonb)
      from cron.job where jobname in ('track-outcomes-sweep', 'postmortem-sweep')
    ),
    'now', now()
  );
$function$;
