-- v42 (research/allstocks-prod-spec.md): the stock MACD email on any share Yahoo's search finds, at most 50 shares
-- for all users together (the owner, 2026-11-21: 「1で」, 「50銘柄まで（おすすめ）」).
--
-- 1. The subscriptions' pair check: the 21 FX and gold names as before, and any share symbol of the app's two
--    shapes (live-chart/stocks.ts US_SYMBOL, JP_SYMBOL). The function says which shares may be followed; this check
--    only bounds what can be stored.
-- 2. public.signal_alert_stocks: a row a share, no user id: the name Yahoo's search gave when the share was added,
--    and the stocks run's daily note (the newest bar's open, the closed bars' count, when the note was written).
-- 3. stockmacd_followed_count(): the distinct shares followed on '15min'. stockmacd_follow(...): saves a user's
--    shares only while the count stays at most p_cap or nothing new is asked, one call at a time; a share nobody
--    followed has its old daily note cleared when it is saved.
--
-- Applied before the function that uses them (docs §10: migration → functions → screen). No row is changed. Each
-- revoke follows its create at once (whether the connector applies the file in one transaction is not checked).
-- The patterns write the dot as [.] (not a backslash), so they do not depend on standard_conforming_strings.

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_pair_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_pair_check
  check (
    pair = any (array[
      'USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY',
      'TRY/JPY', 'USD/CAD', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD'
    ])
    or pair ~ '^[A-Z]{1,5}(-[A-Z]{1,2})?$'
    or pair ~ '^[0-9][0-9A-Z]{3}[.]T$'
  );

create table if not exists public.signal_alert_stocks (
  pair text primary key check (pair ~ '^[A-Z]{1,5}(-[A-Z]{1,2})?$' or pair ~ '^[0-9][0-9A-Z]{3}[.]T$'),
  name text check (name is null or char_length(name) between 1 and 100),
  checked_at timestamptz,
  last_bar_at timestamptz,
  bars integer check (bars is null or bars >= 0),
  noted_at timestamptz
);
alter table public.signal_alert_stocks enable row level security;
revoke all on public.signal_alert_stocks from anon, authenticated;
grant all on public.signal_alert_stocks to service_role;

create or replace function public.stockmacd_followed_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct pair)::integer
  from public.signal_alert_subscriptions
  where rule = 'stockmacd' and "interval" = '15min';
$$;
revoke all on function public.stockmacd_followed_count() from public, anon, authenticated;
grant execute on function public.stockmacd_followed_count() to service_role;

create or replace function public.stockmacd_follow(p_user uuid, p_pairs jsonb, p_lang text, p_at timestamptz, p_cap integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  asked text[];
  n integer;
begin
  select array_agg(distinct v) into asked from jsonb_array_elements_text(p_pairs) as t(v);
  if p_user is null or asked is null or p_lang is null or p_lang not in ('ja', 'en') or p_at is null or p_cap is null
     or exists (select 1 from unnest(asked) as a(pair)
                where not (a.pair ~ '^[A-Z]{1,5}(-[A-Z]{1,2})?$' or a.pair ~ '^[0-9][0-9A-Z]{3}[.]T$')) then
    raise exception 'stockmacd_follow: bad arguments';
  end if;
  -- the count after the lock sees the rows committed while waiting only under read committed (a statement's own
  -- snapshot); under another level it could count an old snapshot, so it refuses instead
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'stockmacd_follow: needs read committed';
  end if;
  -- one call at a time: a second call waits here until the first has committed, then counts its rows
  perform pg_advisory_xact_lock(391042);
  select count(*) into n from (
    select pair from public.signal_alert_subscriptions where rule = 'stockmacd' and "interval" = '15min'
    union
    select unnest(asked)
  ) s;
  if n > p_cap and exists (
    select 1 from unnest(asked) as a(pair)
    where not exists (select 1 from public.signal_alert_subscriptions x
                      where x.rule = 'stockmacd' and x."interval" = '15min' and x.pair = a.pair)
  ) then
    return false;
  end if;
  -- a share nobody followed: its old daily note (from before a gap) is not shown again
  update public.signal_alert_stocks s set last_bar_at = null, bars = null, noted_at = null
  where s.pair = any (asked)
    and not exists (select 1 from public.signal_alert_subscriptions x
                    where x.rule = 'stockmacd' and x."interval" = '15min' and x.pair = s.pair);
  insert into public.signal_alert_subscriptions (user_id, pair, "interval", rule, lang, created_at)
  select p_user, a.pair, '15min', 'stockmacd', p_lang, p_at from unnest(asked) as a(pair)
  on conflict (user_id, pair, "interval", rule) do update set lang = excluded.lang, created_at = excluded.created_at;
  return true;
end;
$$;
revoke all on function public.stockmacd_follow(uuid, jsonb, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.stockmacd_follow(uuid, jsonb, text, timestamptz, integer) to service_role;
