-- #180: USD/CAD again.
--
-- The owner's request (2026-10-02): 「ドルカナダドルも追加して」, after #177
-- and #178 put EUR/USD and AUD/USD back (20261001163000_eur_usd_back.sql,
-- 20261002010000_aud_usd_back.sql). USD/CAD is not on GMO: it comes back as
-- it was before #175 — read as gold is (bars from Twelve Data, the price
-- from Swissquote), on the live chart and in the Q-Trend and ULTRA emails
-- (1-hour to daily, as the other pairs read from Twelve Data). Not in RSI +
-- SAR and the GA-style rule, which read GMO's bars (as before #175). The
-- owner's own 4-hour Q-Trend and ULTRA subscriptions to it are set apart
-- from this migration, as the owner's subscriptions always have been (docs
-- §8.91).
--
-- Only the check on the pairs a subscription may name changes: the 20 of
-- #178 and USD/CAD, in the live chart's order (live-chart/logic.ts
-- LIVE_PAIRS). Nothing is deleted. Applied before the functions that offer
-- USD/CAD (docs §10: a pair added goes migration → functions → screen).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_pair_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_pair_check
  check (pair = any (array['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY', 'TRY/JPY', 'USD/CAD', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD']));
