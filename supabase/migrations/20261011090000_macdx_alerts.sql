-- #275: email alerts for the MACD peak-and-valley rule.
--
-- The owner's request (2026-10-10, on three 5-minute charts with circles
-- marked on the MACD pane): mail only where MACD's blue line crosses the
-- orange line near the top or the bottom, and not near zero. Measured first
-- (docs §8.109, #272), then asked again after the numbers: 「2、はい」
-- (2026-10-11), the owner's ULTRA 5-minute emails kept beside it. The rule
-- is read on the 5-minute chart of GMO's currency pairs (signal-alerts v23,
-- indicators.ts macdxSignals), and every chart it may be followed on is
-- already within the checks on pair and interval below it.
--
-- Only the check on the rules a subscription may name changes: the four of
-- #155 and 'macdx'. Nothing is deleted or changed in a row. Applied before
-- the function that offers the rule (docs §10: a change goes migration →
-- functions → screen).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_rule_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_rule_check
  check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx']));
