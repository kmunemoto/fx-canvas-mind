-- The dashboard was reading a different number from the one the gate decides on.
--
-- The promotion gate now counts INDEPENDENT SITUATIONS decided under the live
-- rulebook version (supabase/functions/postmortem/promotion.ts,
-- MIN_DECIDED_EPISODES = 10). loop_health still counted ROWS, and
-- src/components/LoopHealth.tsx rendered that row count against the gate's
-- floor of ten. Measured 2026-09-07: two decided rows under v8, made four
-- hours apart on USD/JPY short — the screen said 2/10 for a gate sitting at
-- 1/10. The gap is not a constant, it widens with cadence: ten plans in one
-- afternoon read 10/10 on screen while the gate has 1.
--
-- So this teaches loop_health the same rule, from the same place:
-- supabase/functions/_shared/episodes.ts, stated in SQL exactly as
-- public.performance_stats states it — the window anchored on the EPISODE'S
-- START, and the reopen escape opened only by the settlement of the plan
-- IMMEDIATELY before. Boundaries identical: `<` on the window, so exactly 24
-- hours separates; `>` on the escape, so settling exactly four hours ahead
-- does not.
--
-- Two things kept deliberately:
--
--   * SECURITY DEFINER, and every auth.uid() filter exactly where it was.
--     loop_health runs as the owner, so its per-account counters MUST filter
--     explicitly — unlike performance_stats, which is SECURITY INVOKER and
--     leaves the scoping to RLS. decided_under_version has never been
--     per-account and is not made so here: it is the population the gate
--     measures, and the gate runs service-role across every account, so a
--     per-account number here would disagree with it again in the other
--     direction.
--
--   * decided_under_version, the old key, still counting rows. A client that
--     has not been rebuilt keeps reading a number that means what it always
--     meant, and the new key appears alongside it. Removing it would have made
--     the dashboard read 0/10 for the window between this migration and the
--     next deploy — the same class of failure this run is here to close.
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
    'lessons_since_rulebook', (
      select count(*) from public.lessons l cross join public.rulebook r
      where r.id = 1
        and (coalesce((r.candidate->>'created_at')::timestamptz, r.updated_at) is null
             or l.created_at > coalesce((r.candidate->>'created_at')::timestamptz, r.updated_at))
    ),
    'candidate_waiting', (select (candidate is not null) from public.rulebook where id = 1),
    'candidate_created_at', (select (candidate->>'created_at')::timestamptz from public.rulebook where id = 1),
    -- Kept, unchanged, still rows. See the header: the old key stays truthful
    -- so that a client built before this migration is not left reading zero.
    'decided_under_version', (
      select count(*) from public.analyses a cross join public.rulebook r
      where r.id = 1 and r.version > 0 and a.rulebook_version = r.version
        and a.shadow = false and a.preview = false
        and a.outcome in ('win', 'loss', 'expired')
    ),
    -- What the gate actually asks. Same population as the row count above —
    -- and the same population decidedRowsPath() fetches — grouped by the one
    -- episode rule.
    'decided_episodes_under_version', (
      with recursive decided as (
        select a.id, a.pair, a.signal, a.created_at, a.closed_at
        from public.analyses a cross join public.rulebook r
        where r.id = 1 and r.version > 0 and a.rulebook_version = r.version
          and a.shadow = false and a.preview = false
          and a.outcome in ('win', 'loss', 'expired')
      ),
      ordered as (
        select d.*, row_number() over (partition by d.pair, d.signal order by d.created_at, d.id) as rn
        from decided d
      ),
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
      )
      select count(distinct (c.pair || '|' || c.signal || '|'
        || to_char(c.cluster_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24')))::int
      from clustered c
    ),
    -- Which definition of "one situation" produced the count above. A change
    -- of counting method looks exactly like the loop gathering evidence faster
    -- or slower, and nothing else on this object can tell the two apart.
    'episode_definition_version', 2,
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname), '[]'::jsonb)
      from cron.job where jobname in ('track-outcomes-sweep', 'postmortem-sweep')
    ),
    'now', now()
  );
$function$;
