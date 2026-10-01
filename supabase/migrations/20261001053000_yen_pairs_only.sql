-- #175: the yen pairs and gold only.
--
-- The owner's request (2026-10-01): 「通貨のペアを円とどれかだけにして」 — the
-- whole app (the chart, the email alerts and the owner's subscriptions),
-- gold kept (「金は残す」). The live chart now has the broker's 17 yen pairs
-- that are read here and gold (live-chart/logic.ts LIVE_PAIRS); the 19 other
-- pairs are no longer read (docs §8.86).
--
-- 1. Subscriptions to the pairs taken away are deleted (the function no
--    longer reads them, so they would never be mailed), and only the 18
--    pairs can be stored.
-- 2. The bars and prices kept for the pairs taken away are deleted: nothing
--    reads them now, and live_tick_bars drops a pair's old minutes only when
--    a new one of that pair is recorded.
--
-- Not changed: signal_events and signal_alerts (the record and the emails
-- already sent stay as they were; the function counts the four yen pairs'
-- signals only), each user's saved chart pair and drawings (the chart opens
-- USD/JPY when the saved pair is not in its list).

delete from public.signal_alert_subscriptions
  where pair <> all (array['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY', 'TRY/JPY', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD']);

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_pair_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_pair_check
  check (pair = any (array['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY', 'TRY/JPY', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD']));

delete from public.live_chart_fallback
  where pair <> all (array['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY', 'TRY/JPY', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD']);

delete from public.live_tick_bars
  where pair <> all (array['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY', 'TRY/JPY', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD']);
