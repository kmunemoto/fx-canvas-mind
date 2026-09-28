-- #155: email alerts for Q-Trend and ULTRA, on every pair the live chart has.
--
-- The owner's request (2026-09-29): 「全ての銘柄でこのsellとbuyの判断がでたとき
-- strongも含む。その時にメールが届く様にして」 — Q-Trend's BUY, SELL and STRONG and
-- ULTRA's Buy ☆ and Sell ☆, on the 5-minute to daily charts (the pairs read
-- from Twelve Data on 1 hour and up only), one email a signal. The function
-- (signal-alerts, mode "indicators") judges which pair and timeframe each
-- rule may be followed on; the checks here only bound what can be stored.
--
-- 1. Subscriptions: every pair of the live chart, the 5-minute chart, and the
--    two rules beside RSI + SAR and the GA-style rule.
-- 2. public.gmo_kline_files: GMO's daily (and yearly) kline files that have
--    ended, kept as GMO answered them, so the sweep reads each once. Written
--    and read by the functions only (service role).
-- 3. signal_alerts.strong: whether a Q-Trend signal was a STRONG one, for
--    the app's list of recent alerts (null for the other rules).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_pair_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_pair_check
  check (pair = any (array['USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/USD', 'GBP/USD', 'AUD/USD', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY', 'TRY/JPY', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'GBP/CHF', 'EUR/GBP', 'EUR/CHF', 'AUD/CHF', 'NZD/CHF', 'AUD/NZD', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'EUR/AUD', 'GBP/AUD', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'CAD/CHF', 'NOK/SEK', 'AUD/CAD', 'NZD/CAD', 'USD/HKD', 'XAU/USD']));

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_interval_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_interval_check
  check ("interval" = any (array['5min', '15min', '1h', '4h', '1day']));

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_rule_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_rule_check
  check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra']));

create table if not exists public.gmo_kline_files (
  -- as in the request: USD_JPY, BID or ASK, 5min .. 1day, YYYYMMDD or YYYY
  symbol text not null,
  price_type text not null,
  "interval" text not null,
  date_key text not null,
  -- GMO's answer as it came (status 0 and its data)
  body jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (symbol, price_type, "interval", date_key)
);

alter table public.gmo_kline_files enable row level security;
revoke all on public.gmo_kline_files from anon, authenticated;
grant all on public.gmo_kline_files to service_role;

alter table public.signal_alerts add column if not exists strong boolean;
