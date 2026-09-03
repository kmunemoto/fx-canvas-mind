-- Is the review loop running? One call that says when the tracker and the
-- post-mortem last ran, what is waiting on them, and where the rulebook
-- stands — so the app can show it instead of the owner having to trust it.
--
-- Global facts (last run times, rulebook version, schedules) are shared;
-- plan and lesson counts are the caller's own. Runs as the owner so the
-- state tables (service-role only) and cron.job can be read without
-- widening their grants.
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
      where user_id = auth.uid() and shadow = false and signal in ('BUY', 'SELL')
        and outcome in ('win', 'loss', 'untriggered', 'expired', 'ambiguous')
        and (postmortem is null or postmortem->>'status' <> 'done')
    ),
    'reviewed', (
      select count(*) from public.analyses
      where user_id = auth.uid() and shadow = false and postmortem->>'status' = 'done'
    ),
    'lessons', (select count(*) from public.lessons where user_id = auth.uid()),
    'rulebook_version', (select version from public.rulebook where id = 1),
    'rulebook_updated_at', (select updated_at from public.rulebook where id = 1),
    'lessons_since_rulebook', (
      select count(*) from public.lessons l cross join public.rulebook r
      where r.id = 1 and (r.updated_at is null or l.created_at > r.updated_at)
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
