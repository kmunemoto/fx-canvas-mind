-- #387 (docs §8.130): the rule 'emarm' — the owner's video's EMA 20 / 200 way
-- (the 20 EMA crossing the 200 EMA, the candle back to the 200 EMA, the
-- diagonal and horizontal necklines' break, the return move to the horizontal
-- and the bar past its body: supabase/functions/_shared/ema-return.ts,
-- research/ema-return-spec.md), mailed at its entry.
--
-- The owner (2026-10-30), with a screen recording of an Instagram video:
-- 「この機能追加して」; asked, 「チャートとメール」 and 「今の5ペア＋金の15分足」.
--
-- Subscriptions may now be kept under 'emarm'. The function says which
-- charts the rule may be followed on (the 15-minute chart of USD/JPY,
-- EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold); the check here only bounds
-- what can be stored. Nothing is changed in a row.
--
-- Applied before the function that knows the rule (docs §10: migration →
-- functions → screen).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_rule_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_rule_check
  check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx', 'amdpo3', 'emarm']));
