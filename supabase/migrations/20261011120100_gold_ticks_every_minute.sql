-- #291 (docs §8.112): the "gold-ticks" run every minute (signal-alerts,
-- gold-minutes.ts): Swissquote's gold price every few seconds until 25
-- seconds past the minute, recorded into public.gold_tick_bars. The function
-- answers at once and reads in the background (pg_net sends nothing else
-- while a request it sent is open: measured on this project, docs §8.112).
-- While gold is shut (the FX weekend at its widest, gold's daily hour) a run
-- reads nothing.
--
-- Applied after the function that knows the mode is deployed: before it, the
-- function took a sweep call it did not know for the RSI + SAR sweep, which
-- would then run every minute. The answer comes at once (the two minutes
-- allowed for it are only a generous bound).

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
