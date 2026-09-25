-- #108: what every signal the rule fired actually did afterwards.
--
-- One row per signal on the app's seven pairs and four alert timeframes,
-- whoever follows the chart, written and settled by the signal-alerts sweep
-- (supabase/functions/signal-alerts/record.ts says how). Market data, not
-- personal data: any signed-in user may read it; only the service role
-- writes.

create table if not exists public.signal_events (
  id uuid primary key default gen_random_uuid(),
  pair text not null,
  interval text not null,
  -- the open of the signal bar, and when it closed
  bar_time timestamptz not null,
  closed_at timestamptz not null,
  side text not null check (side in ('BUY', 'SELL')),
  rule text not null,
  -- the plan the email printed, on the mid
  entry double precision not null,
  stop double precision not null,
  target double precision not null,
  atr double precision not null,
  rsi double precision,
  rsi_prev double precision,
  sar double precision,
  -- the tradeable price at the signal bar's close (ask for a BUY, bid for a
  -- SELL) and the spread then
  fill double precision,
  spread double precision,
  -- closed in the hours the app does not mail (timing.ts): recorded, and
  -- kept apart in the record the app shows
  costly boolean not null default false,
  -- null while open
  outcome text check (outcome in ('win', 'loss', 'ambiguous', 'expired', 'no_data')),
  exit_price double precision,
  exit_at timestamptz,
  bars integer,
  -- the result over the planned risk (entry to stop on the mid)
  r double precision,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (pair, interval, bar_time, side)
);

create index if not exists signal_events_open_idx on public.signal_events (pair, interval) where outcome is null;
create index if not exists signal_events_closed_at_idx on public.signal_events (closed_at desc);

alter table public.signal_events enable row level security;
revoke all on public.signal_events from anon, authenticated;
grant select on public.signal_events to authenticated;
grant all on public.signal_events to service_role;
drop policy if exists "Signed-in users read the signal record" on public.signal_events;
create policy "Signed-in users read the signal record"
  on public.signal_events for select to authenticated
  using (true);

-- Which recorded signal an alert was about, so a user's own alerts can be
-- read with their results
alter table public.signal_alerts
  add column if not exists event_id uuid references public.signal_events (id) on delete set null;
create index if not exists signal_alerts_event_idx on public.signal_alerts (event_id);
