-- #291 (docs §8.112): the "gold-ticks" run every minute (signal-alerts,
-- gold-minutes.ts): Swissquote's gold price every few seconds until just
-- before the next minute, recorded into public.gold_tick_bars. While gold is
-- shut (the FX weekend at its widest, gold's daily hour) a run reads nothing
-- and ends at once.
--
-- Applied after the function that knows the mode is deployed: before it, the
-- function took a sweep call it did not know for the RSI + SAR sweep, which
-- would then run every minute. Its own minute's reads take the run some 58
-- seconds, so the call waits up to two minutes for its answer.

select cron.unschedule(jobid) from cron.job where jobname = 'signal-alerts-gold-ticks';
select cron.schedule(
  'signal-alerts-gold-ticks',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"gold-ticks"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
