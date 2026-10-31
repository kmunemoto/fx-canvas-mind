-- #391 (docs §8.134): the rule 'stockmacd' — the MACD email's rule (v8's
-- numbers) on the hourly bars of the 22 US and Japanese shares measured in
-- docs §8.133 (supabase/functions/signal-alerts/stocks.ts), read from Yahoo.
--
-- The owner (2026-10-31), shown the measured numbers: 「出す、利確幅はいらない、
-- 自分で決める」.
--
-- Subscriptions may now be kept under 'stockmacd', on the 22 shares (Yahoo's
-- symbols: AAPL, 7203.T, ...). The function says which charts the rule may be
-- followed on (the 22 shares' 1-hour chart); the checks here only bound what
-- can be stored. Nothing is changed in a row.
--
-- Applied before the function that knows the rule (docs §10: migration →
-- functions → screen).

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_rule_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_rule_check
  check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx', 'amdpo3', 'emarm', 'stockmacd']));

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_pair_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_pair_check
  check (pair = any (array[
    'USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY',
    'TRY/JPY', 'USD/CAD', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD',
    'NVDA', 'INTC', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA',
    '7203.T', '6758.T', '9984.T', '8306.T', '6861.T', '9983.T', '8035.T', '7974.T', '9432.T', '6501.T', '7267.T',
    '6920.T', '4063.T', '8058.T'
  ]));
