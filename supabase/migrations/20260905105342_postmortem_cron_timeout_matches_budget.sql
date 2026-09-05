-- The post-mortem cron job waited 120 s for a function whose own wall-clock
-- budget is 130 s (WALL_CLOCK_BUDGET_MS), so a run that used its full budget
-- had its reply thrown away by pg_net: the function still wrote its rows, but
-- net._http_response recorded a timeout instead of the summary we read to see
-- what the run did. Wait 150 s instead — the platform kills the worker at 150 s
-- anyway, so nothing is waited on that could still be running.
do $$
declare
  jid bigint;
  cmd text;
begin
  select jobid, command into jid, cmd from cron.job where jobname = 'postmortem-sweep';
  if jid is null then
    raise notice 'postmortem-sweep not scheduled; nothing to alter';
    return;
  end if;
  perform cron.alter_job(
    job_id := jid,
    command := replace(cmd, 'timeout_milliseconds := 120000', 'timeout_milliseconds := 150000')
  );
end
$$;
