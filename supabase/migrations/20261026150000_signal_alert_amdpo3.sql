-- #385 (docs §8.128): the rule 'amdpo3' — WillyAlgoTrader's AMD Po3 with Live
-- Edge Stats (supabase/functions/_shared/amd-po3.ts, a port of its
-- open-source Pine code at its default settings), mailed at its DIST event:
-- the manipulation confirmed and the reference trade opened.
--
-- The owner (2026-10-26): 「これと全く同じものを追加して。これでもチャートを分析
-- できる様に。エントリーのタイミングが来たらこれも設定でメールが届く様にもして。」
--
-- Subscriptions may now be kept under 'amdpo3'. The function says which
-- charts the rule may be followed on (those of Q-Trend and ULTRA); the check
-- here only bounds what can be stored. Nothing is changed in a row.
--
-- Applied before the function that knows the rule (docs §10: migration →
-- functions → screen).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_rule_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_rule_check
  check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx', 'amdpo3']));
