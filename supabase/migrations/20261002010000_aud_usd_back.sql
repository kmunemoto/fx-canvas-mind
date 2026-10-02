-- #178: AUD/USD again.
--
-- The owner's request (2026-10-02): 「豪ドル/ドル、追加して」, after #177 put
-- EUR/USD back (20261001163000_eur_usd_back.sql). Done as #177 was: the whole
-- app as before #175 for this pair — the live chart, the Q-Trend and ULTRA
-- emails, and RSI + SAR and the GA-style rule (signal-alerts/logic.ts
-- ALERT_PAIRS) — and the owner's own 4-hour Q-Trend and ULTRA subscriptions
-- to it again (set apart from this migration, as the owner's subscriptions
-- always have been; docs §8.89).
--
-- Only the check on the pairs a subscription may name changes: the 19 of
-- #177 and AUD/USD, in the live chart's order (live-chart/logic.ts
-- LIVE_PAIRS). Nothing is deleted. Applied before the functions that offer
-- AUD/USD (docs §10: a pair added goes migration → functions → screen).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_pair_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_pair_check
  check (pair = any (array['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY', 'TRY/JPY', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD']));
