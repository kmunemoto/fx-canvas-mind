-- Run the outcome sweep a few minutes past the quarter hour instead of on it.
-- Bars close on the quarter hour, and that is also when people are most
-- likely to press Analyze; the sweep and an analysis share one market-data
-- key with a per-minute allowance, so keep them apart.
select cron.schedule(
  'track-outcomes-sweep',
  '3,18,33,48 * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/track-outcomes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"sweep"}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);
