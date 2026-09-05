-- awaiting_review counted only BUY/SELL, because before the WAIT diagnosis
-- path nothing else could ever be reviewed. `reviewed` has no signal filter,
-- so a diagnosed WAIT lands in one counter and never appeared in the other:
-- the panel showed "0 awaiting review" with a queue sitting behind it, and
-- `reviewed` jumped without anything having drained. The two numbers are
-- rendered side by side, and the panel exists to make a stalled loop visible.
--
-- A WAIT is reviewable on exactly the terms the post-mortem uses: a stored
-- plan, and a verdict the tracker actually reached. 'pending' has not been
-- measured, and 'unknown' / 'no_call' never can be — counting those as
-- backlog would show a queue that will never drain.
create or replace function public.loop_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tracker_last_run_at', (select last_sweep_at from public.tracker_state where id = 1),
    'postmortem_last_run_at', (select last_run_at from public.postmortem_state where id = 1),
    'postmortem_last_diagnosed', (select (last_result->>'diagnosed')::int from public.postmortem_state where id = 1),
    'postmortem_version', (select last_result->>'version' from public.postmortem_state where id = 1),
    'open_plans', (
      select count(*) from public.analyses
      where user_id = auth.uid() and shadow = false and signal in ('BUY', 'SELL') and outcome = 'pending'
    ),
    'awaiting_review', (
      select count(*) from public.analyses
      where user_id = auth.uid() and shadow = false
        and (postmortem is null or postmortem->>'status' <> 'done')
        and (
          (signal in ('BUY', 'SELL') and outcome in ('win', 'loss', 'untriggered', 'expired', 'ambiguous'))
          or (signal = 'WAIT' and outcome = 'skipped' and wait_plan is not null
              and wait_check->>'verdict' in ('missed', 'correct'))
        )
    ),
    'reviewed', (
      select count(*) from public.analyses
      where user_id = auth.uid() and shadow = false and postmortem->>'status' = 'done'
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
        and a.shadow = false and a.outcome in ('win', 'loss', 'expired')
    ),
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname), '[]'::jsonb)
      from cron.job where jobname in ('track-outcomes-sweep', 'postmortem-sweep')
    ),
    'now', now()
  );
$$;

revoke all on function public.loop_health() from public;
revoke all on function public.loop_health() from anon;
grant execute on function public.loop_health() to authenticated;
