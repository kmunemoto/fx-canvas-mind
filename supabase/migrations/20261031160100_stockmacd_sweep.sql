-- #391 (docs §8.134): the run of the MACD email on shares, every minute
-- (signal-alerts, mode "stocks"). Each run reads Yahoo only for the shares
-- somebody follows under 'stockmacd' whose hourly bar may have closed (the
-- half hour after one of the session's closes) and is not in yet; most
-- minutes it reads nothing.
--
-- Applied after the function that knows the mode is deployed: before it, the
-- function took any sweep call for the RSI + SAR sweep, which would then run
-- every minute (as the "indicators" job's migration says).
select cron.unschedule(jobid) from cron.job where jobname = 'signal-alerts-stocks';
select cron.schedule(
  'signal-alerts-stocks',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"stocks"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
