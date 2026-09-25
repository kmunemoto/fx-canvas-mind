-- #105: email the RSI + Parabolic SAR signal.
--
-- Who follows which chart, and every signal the sweep found for them — mailed
-- or not, and why not. Both tables are written by the signal-alerts function
-- only (service role): a user may read their own rows and nothing else, so
-- the Pro check the function makes before saving a subscription cannot be
-- skipped by writing the row from the browser.

create table if not exists public.signal_alert_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pair text not null check (pair in ('USD/JPY', 'EUR/USD', 'GBP/USD', 'EUR/JPY', 'GBP/JPY', 'AUD/USD', 'AUD/JPY')),
  interval text not null check (interval in ('15min', '1h', '4h', '1day')),
  -- the language the email is written in: the app's, when the box was ticked
  lang text not null default 'ja' check (lang in ('ja', 'en')),
  created_at timestamptz not null default now(),
  unique (user_id, pair, interval)
);

alter table public.signal_alert_subscriptions enable row level security;
revoke all on public.signal_alert_subscriptions from anon, authenticated;
grant select on public.signal_alert_subscriptions to authenticated;
grant all on public.signal_alert_subscriptions to service_role;
drop policy if exists "Users read their own alert subscriptions" on public.signal_alert_subscriptions;
create policy "Users read their own alert subscriptions"
  on public.signal_alert_subscriptions for select to authenticated
  using (auth.uid() = user_id);

create table if not exists public.signal_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 'signal' from the sweep, 'test' from the settings button
  kind text not null default 'signal' check (kind in ('signal', 'test')),
  pair text,
  interval text,
  -- the open of the bar the rule fired on, and when that bar closed
  bar_time timestamptz,
  closed_at timestamptz,
  side text check (side in ('BUY', 'SELL')),
  -- the plan the app would publish at that close
  entry double precision,
  stop double precision,
  target double precision,
  rsi double precision,
  rsi_prev double precision,
  sar double precision,
  atr double precision,
  rule text,
  -- pending: claimed, not yet handed to the mail provider
  -- sent / failed: what the provider said
  -- not_configured: no RESEND_API_KEY on the function, so nothing could be sent
  -- skipped: found but deliberately not mailed (skip_reason)
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'not_configured', 'skipped')),
  skip_reason text,
  -- the provider's answer on a failure, with any address in it removed
  error text,
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  -- One row per signal per subscriber: the insert is the claim, so two sweeps
  -- that overlap cannot both mail it. Test rows leave the signal columns null
  -- and never collide.
  unique (user_id, kind, pair, interval, bar_time, side)
);

create index if not exists signal_alerts_user_recent_idx on public.signal_alerts (user_id, created_at desc);

alter table public.signal_alerts enable row level security;
revoke all on public.signal_alerts from anon, authenticated;
grant select on public.signal_alerts to authenticated;
grant all on public.signal_alerts to service_role;
drop policy if exists "Users read their own alerts" on public.signal_alerts;
create policy "Users read their own alerts"
  on public.signal_alerts for select to authenticated
  using (auth.uid() = user_id);

-- Two minutes after every quarter-hour close, on minutes no other sweep uses
-- (track-outcomes 3/18/33/48, postmortem 8/23/38/53, econ-calendar 13). A
-- close missed by one run is still fresh for the next (logic.ts FRESH_MS).
select cron.unschedule(jobid) from cron.job where jobname = 'signal-alerts-sweep';
select cron.schedule(
  'signal-alerts-sweep',
  '2,17,32,47 * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/signal-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"sweep"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
