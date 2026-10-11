-- #291 (docs §8.112): the "gold-ticks" run every minute (signal-alerts,
-- gold-minutes.ts): Swissquote's gold price every few seconds until 25
-- seconds past the minute, recorded into public.gold_tick_bars. The function
-- answers at once and reads in the background. While gold is shut (the FX
-- weekend at its widest, gold's daily hour) a run reads nothing.
--
-- Called through the http extension (pgsql-http, which waits for the
-- answer), not pg_net as the other jobs are: this project's pg_net 0.20.0
-- sends no request while one it sent is still open (measured 2026-10-11), so
-- a run would begin only when the longest of the minute's other requests
-- ended (their budgets reach 90 to 130 seconds), and a minute could go partly
-- unread. pg_cron starts its jobs at the minute (within 0.53 s, every run of
-- 2026-10-08 to 10-11), and the call is answered in some 0.2 s (an
-- unauthenticated probe, 2026-10-11: 0.14 to 0.19 s).
--
-- The extension gives a connection 1 second unless told otherwise (measured
-- 2026-10-11: a host that never answers failed after 1,001 ms), so the job
-- gives it 5 seconds and the whole call 10. A call that fails on the way
-- (no connection, no answer in time) or is answered 5xx is made once more;
-- a minute's run is begun by this call alone, and one lost leaves the
-- minute read by the run before for its first 25 seconds only. An answer
-- other than 200 fails the job, its status in cron.job_run_details (a
-- statement that returns a row is logged there as succeeded, whatever the
-- status: pg_cron 1.6.4).
--
-- The extension's functions are owned by supabase_admin, and every role may
-- execute them, as Supabase installs it (a revoke run as postgres takes
-- nothing away: tried 2026-10-11). The API does not reach them: it serves
-- the schemas public and graphql_public only (asked of it 2026-10-11 with
-- the anon key: "Invalid schema: extensions", and no public.http_get).
--
-- Applied after the function that knows the mode is deployed: before it, the
-- function took a sweep call it did not know for the RSI + SAR sweep.

create extension if not exists http with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'signal-alerts-gold-ticks';
select cron.schedule(
  'signal-alerts-gold-ticks',
  '* * * * *',
  $$
  do $job$
  declare
    st integer;
  begin
    perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS', '5000');
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '10000');
    for attempt in 1..2 loop
      begin
        select status into st from extensions.http((
          'POST',
          'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts',
          array[extensions.http_header('x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token'))],
          'application/json',
          '{"mode":"gold-ticks"}'
        )::extensions.http_request);
      exception when others then
        if attempt = 2 then
          raise;
        end if;
        st := null;
      end;
      exit when st is not null and st < 500;
    end loop;
    if st is distinct from 200 then
      raise exception 'signal-alerts gold-ticks answered %', st;
    end if;
  end
  $job$;
  $$
);
