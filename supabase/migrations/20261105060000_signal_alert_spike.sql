-- #395 (docs §8.138): the rule 'spike' — a sharp rise or fall of the 1-hour
-- bar: its high (low) gone 3 times the mean high − low of the 120 closed bars
-- before it from its open, seen as the bar forms (supabase/functions/_shared/
-- spike.ts, research/spike-spec.md), mailed in the minute it is seen.
--
-- The owner (2026-11-05): 「チャートが1時間足で急激に上がったり、下がったり
-- したらメールください。」; asked, 「3倍以上」, 「足の途中ですぐ」, 「5ペア＋金」
-- and 「チャートにも出す」.
--
-- Subscriptions may now be kept under 'spike'. The function says which charts
-- the rule may be followed on (the 1-hour chart of USD/JPY, EUR/JPY, AUD/JPY,
-- EUR/USD, AUD/USD and gold); the check here only bounds what can be stored.
-- The alerts keep a rise as side 'BUY' and a fall as 'SELL' (the table's own
-- check), not as a trade. Nothing is changed in a row.
--
-- Applied before the function that knows the rule (docs §10: migration →
-- functions → screen).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_rule_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_rule_check
  check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx', 'amdpo3', 'emarm', 'stockmacd', 'spike']));

-- Each 1-hour bar's usual range R (the mean high − low of the 120 closed
-- bars before it), worked out once for the hour and kept here, so the
-- minute-by-minute check reads a row of a few bytes instead of the bars:
-- gold's stored Twelve Data bars are some 120 KB a read, a pair's GMO files
-- some 150 KB, and the project's database egress is limited. status 'ok'
-- with r; 'short' (fewer than 120 bars before it), 'stale' (the bars before
-- it end more than one open hour early) or 'zero' (R not above zero), r
-- null. behind: the open hours between the newest bar used and the bar
-- (gold's stored read can be one bar behind). source_read_at: for gold,
-- the stored read (live_chart_fallback.fetched_at) it was worked out from,
-- so a newer read works it out again. Rows over three days old are dropped
-- by the function. Written and read by signal-alerts only (service role).
create table if not exists public.spike_ranges (
  pair text not null,
  -- the open (UTC) of the bar the range is for
  bar_time timestamptz not null,
  r double precision,
  status text not null check (status in ('ok', 'short', 'stale', 'zero')),
  behind integer not null default 0,
  -- the open of the newest bar used
  last_bar timestamptz,
  source_read_at timestamptz,
  computed_at timestamptz not null default now(),
  primary key (pair, bar_time)
);

alter table public.spike_ranges enable row level security;
revoke all on public.spike_ranges from anon, authenticated;
grant all on public.spike_ranges to service_role;
