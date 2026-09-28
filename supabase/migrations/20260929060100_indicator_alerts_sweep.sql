-- #155: the sweep of Q-Trend's and ULTRA's email alerts, every minute
-- (signal-alerts, mode "indicators"). Each run reads only the charts due at
-- that minute (signal-alerts/indicators.ts gmoIntervalsDue, twelveCloseDue)
-- and only those somebody follows; most minutes it reads nothing.
--
-- Applied after the function that knows the mode is deployed: before it, the
-- function took any sweep call for the RSI + SAR sweep, which would then run
-- every minute.

select cron.unschedule(jobid) from cron.job where jobname = 'signal-alerts-indicators';
select cron.schedule(
  'signal-alerts-indicators',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"indicators"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
