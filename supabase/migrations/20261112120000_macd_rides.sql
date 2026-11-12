-- #397 (docs §8.150): the MACD email as a ride — in at 90% with the flow,
-- told at 96% (supabase/functions/_shared/macd-ride.ts,
-- research/macdride-spec.md). Email 1 at the close of the 1-hour bar at which
-- the MACD line (blue) came into the 90% band of the pane's top (a BUY) or
-- bottom (a SELL), the bar before outside it; email 2 the moment the line
-- reaches 96% of the same edge. It takes the place of the 95% email (v8) on
-- the five pairs, gold and the shares.
--
-- The owner (2026-11-12): 「MACD 90%→96%: 足の確定で入ると 96% まで行く メールを
-- これに変更、なので、一つのペアで2回メールを送る」; asked, 「2通目で利確する
-- 感じ」, 「止めて入れ替える」, 「知らせを1通だけ送る」 (already at 96% at the
-- entry bar's close: one notice, no entry), 「5ペア・金・株を全部変える」,
-- 「96%に届くまで持ち続ける」 (the line leaving the band before 96%: held, no
-- notice) and 「1時間足の確定ごとに見る」 (the shares). Measured on the five
-- pairs only (docs §8.149): of the 800 trades that reached 96%, 360 were at
-- a profit and 429 at a loss, so email 2 reports the line and the profit or
-- loss since email 1; it is not a take-profit as a fact. Gold and the shares
-- are not measured.
--
-- Two tables, written and read by signal-alerts only (service role). The
-- subscriptions are not touched: the ride is followed under the rules
-- 'macdx' and 'stockmacd' as they are, and its three mails are rows of
-- public.signal_alerts under their own rule ids. Nothing is changed in a
-- row.
--
-- Applied before the function that knows the tables (docs §10: migration →
-- functions → screen).

-- A ride: one trade of one chart (a pair, gold or a share, on its 1-hour
-- bars) and trade side, opened by email 1 at the close of its entry bar and
-- ended ('reached') the first time the line is seen at 96% of its edge; no
-- other way out. Kept for all followers of the chart together: the same bar
-- is judged again and again (the pairs at minutes 0, 3 and 5, gold every
-- minute to 29, a share some 30 times), and a ride often ends within a
-- minute of its entry, so what was opened and how it ended must outlive a
-- run. Email 2 is written from the row, so every run mails the same numbers.
-- Rows are never deleted by the function: they are the record of how each
-- ride turned out.
create table if not exists public.macd_rides (
  pair text not null,
  side text not null check (side in ('BUY', 'SELL')),
  -- the entry bar's open (UTC)
  entry_bar timestamptz not null,
  entry_closed_at timestamptz not null,
  -- the price paid: the five pairs, the entry bar's ask close for a BUY and
  -- bid close for a SELL; gold and the shares, the bar's close
  entry_price double precision not null,
  -- the entry bar's close as the chart draws it
  entry_mid double precision not null,
  -- m / top (or bottom) at the entry
  share0 double precision,
  status text not null default 'open' check (status in ('open', 'reached')),
  -- when it was seen
  reached_at timestamptz,
  -- the open of the bar it was reached in
  reached_bar timestamptz,
  -- the price when seen
  seen_price double precision,
  -- the pairs and gold: seen by a close's catch-up, after the bar it was reached in had ended; the shares (judged at
  -- closes only): the bar is not the newest closed one, or the newest ended more than 45 minutes before it was read
  late boolean,
  -- m / top (or bottom) at the touch
  share1 double precision,
  created_at timestamptz not null default now(),
  primary key (pair, side, entry_bar)
);

-- At most one open ride a chart and side (both sides can be open at once)
create unique index if not exists macd_rides_one_open on public.macd_rides (pair, side) where status = 'open';

alter table public.macd_rides enable row level security;
revoke all on public.macd_rides from anon, authenticated;
grant all on public.macd_rides to service_role;

-- The state of a 1-hour bar of a pair or gold: what is needed of the 599
-- closed bars before it to know where the MACD line stands with any price
-- as its close (EMA 12, EMA 26 and the signal line at the bar before, and
-- the pane's edges over the 119 bars before it and 0), worked out once at a
-- bar's close for the bar then forming and kept here, so the
-- minute-by-minute check for 96% reads a row of a few bytes instead of the
-- bars (gold's stored Twelve Data bars are some 120 KB a read, a pair's GMO
-- files some 150 KB, and the project's database egress is limited).
-- source_read_at: for gold, the stored read (live_chart_fallback.fetched_at)
-- it was made from. Rows over eight days old are dropped by the function
-- when a state is written. The shares keep no state: every read of theirs
-- brings the bars.
create table if not exists public.macd_ride_state (
  pair text not null,
  -- the open (UTC) of the bar the state is for (the forming one when made)
  bar_time timestamptz not null,
  e12 double precision not null,
  e26 double precision not null,
  sig double precision not null,
  top119 double precision not null,
  bottom119 double precision not null,
  -- the open of the newest closed bar used
  last_bar timestamptz not null,
  source_read_at timestamptz,
  computed_at timestamptz not null default now(),
  primary key (pair, bar_time)
);

alter table public.macd_ride_state enable row level security;
revoke all on public.macd_ride_state from anon, authenticated;
grant all on public.macd_ride_state to service_role;
