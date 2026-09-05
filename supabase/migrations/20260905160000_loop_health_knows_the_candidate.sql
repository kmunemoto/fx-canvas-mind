-- The loop now paces revisions against the last revision WRITTEN (a held
-- candidate's created_at), and promotes into `rules` only once the live
-- version has been measured. loop_health still counted lessons since
-- updated_at, which stops moving while a candidate is held: the panel would
-- run past the threshold and pin at "0 more lessons until the next revision"
-- forever, telling the owner a revision is imminent when the loop is in fact
-- waiting for decided trades.
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
    -- Counted from the same clock the loop paces on: the last revision
    -- WRITTEN, promoted or not.
    'lessons_since_rulebook', (
      select count(*) from public.lessons l cross join public.rulebook r
      where r.id = 1
        and (coalesce((r.candidate->>'created_at')::timestamptz, r.updated_at) is null
             or l.created_at > coalesce((r.candidate->>'created_at')::timestamptz, r.updated_at))
    ),
    -- A revision written and waiting on the decided-trade gate, so the panel
    -- can say "waiting to be measured" instead of implying nothing happened.
    'candidate_waiting', (select (candidate is not null) from public.rulebook where id = 1),
    'candidate_created_at', (select (candidate->>'created_at')::timestamptz from public.rulebook where id = 1),
    'decided_under_version', (
      select count(*) from public.analyses a cross join public.rulebook r
      where r.id = 1 and r.version > 0 and a.rulebook_version = r.version
        and a.shadow = false and a.outcome in ('win', 'loss', 'expired')
    ),
    'schedules', (
      select jsonb_object_agg(jobname, schedule) from cron.job where active
    )
  );
$$;

revoke all on function public.loop_health() from public;
revoke all on function public.loop_health() from anon;
grant execute on function public.loop_health() to authenticated;
