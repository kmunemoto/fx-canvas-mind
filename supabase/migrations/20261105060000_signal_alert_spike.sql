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
