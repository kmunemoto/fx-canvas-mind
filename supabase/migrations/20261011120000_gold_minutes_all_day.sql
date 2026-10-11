-- #291 (docs §8.112): gold's 1-minute bars made from Swissquote's prices all
-- day long, for the gold 1-minute email (the owner's video's way: the low or
-- high taken, then the cross of EMA 20 and EMA 80; rule 'sweepx',
-- _shared/sweep-cross.ts) and the chart's gold 1-minute bars alike.
--
-- The owner (2026-10-11): 「1分足のゴールド専用のゴールドの売買のメールだけは
-- これで判断してメールを送る様にしてください」; and, told that Twelve Data's free
-- key allows 800 reads a day where reading gold's 1-minute bars after every
-- close takes some 1,380: 「Swissquoteで、チャートもそろえる」.
--
-- 1. public.gold_tick_bars.source: 'swissquote' — the prices recorded here,
--    every few seconds all day by the signal-alerts function's "gold-ticks"
--    run (pg_cron, every minute; the next migration) and every two seconds
--    while somebody has a live chart open, as before — or 'twelvedata': the
--    minutes before the recording began, filled once from Twelve Data's
--    1-minute bars (its "gold-seed" run).
-- 2. record_gold_tick: a Swissquote price replaces a Twelve Data minute
--    outright (a minute is one source's, never a mix), and eight days are
--    kept, two before: a Monday's first bars have the week before behind
--    them. A price stamped more than five minutes ahead of the database's
--    clock, or a day behind it, is not recorded: one bad stamp from the
--    future would otherwise have every row before it deleted.
-- 3. The rows kept so far are removed, all of them: until the recording
--    begins (after this migration) a row was recorded only while somebody
--    watched, hours apart, and as a history they would be drawn, and judged,
--    as if each ran on from the last.
-- 4. public.gold_tick_minutes(count, from): the newest `count` minutes (from
--    `from` on, when given), oldest first, as one JSON array — the REST API
--    answers a thousand rows at most, and the chart's deep history asks for
--    1,400; a read of Twelve Data's, gone on with the minutes recorded since
--    (live-chart withTicks), may ask for days of them.
-- 5. Subscriptions: the 1-minute chart, and the rule 'sweepx'. The function
--    says which chart the rule may be followed on (gold's 1-minute only);
--    the checks here only bound what can be stored. Nothing is changed in a
--    row.
--
-- Applied before the function that knows the "gold-ticks" and "gold-seed"
-- runs and the rule (docs §10: migration → functions → screen).

alter table public.gold_tick_bars add column if not exists source text not null default 'swissquote';
alter table public.gold_tick_bars drop constraint if exists gold_tick_bars_source_check;
alter table public.gold_tick_bars add constraint gold_tick_bars_source_check
  check (source = any (array['swissquote', 'twelvedata']));

delete from public.gold_tick_bars;

create or replace function public.record_gold_tick(p_at timestamptz, p_mid numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m timestamptz;
begin
  if p_at is null or p_mid is null or p_mid <= 0 then
    return;
  end if;
  if p_at > now() + interval '5 minutes' or p_at < now() - interval '1 day' then
    return;
  end if;
  m := date_trunc('minute', p_at at time zone 'utc') at time zone 'utc';
  insert into public.gold_tick_bars as b (minute, open, high, low, close, first_at, last_at, samples, source)
  values (m, p_mid, p_mid, p_mid, p_mid, p_at, p_at, 1, 'swissquote')
  on conflict (minute) do update set
    open = case when b.source <> 'swissquote' or p_at < b.first_at then p_mid else b.open end,
    close = case when b.source <> 'swissquote' or p_at >= b.last_at then p_mid else b.close end,
    high = case when b.source <> 'swissquote' then p_mid else greatest(b.high, p_mid) end,
    low = case when b.source <> 'swissquote' then p_mid else least(b.low, p_mid) end,
    first_at = case when b.source <> 'swissquote' then p_at else least(b.first_at, p_at) end,
    last_at = case when b.source <> 'swissquote' then p_at else greatest(b.last_at, p_at) end,
    samples = case when b.source <> 'swissquote' then 1 else b.samples + 1 end,
    source = 'swissquote';
  delete from public.gold_tick_bars where minute < m - interval '8 days';
end;
$$;

revoke all on function public.record_gold_tick(timestamptz, numeric) from public, anon, authenticated;
grant execute on function public.record_gold_tick(timestamptz, numeric) to service_role;

-- (none was on the project on 2026-10-11; a one-argument one left beside the
-- function below would make every call naming p_count alone ambiguous)
drop function if exists public.gold_tick_minutes(integer);

create or replace function public.gold_tick_minutes(p_count integer, p_from timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'minute', x.minute, 'open', x.open, 'high', x.high, 'low', x.low, 'close', x.close,
        'first_at', x.first_at, 'last_at', x.last_at, 'samples', x.samples, 'source', x.source
      )
      order by x.minute
    ),
    '[]'::jsonb
  )
  from (
    select * from public.gold_tick_bars
    where p_from is null or minute >= p_from
    order by minute desc
    limit greatest(0, least(coalesce(p_count, 0), 20000))
  ) x;
$$;

revoke all on function public.gold_tick_minutes(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.gold_tick_minutes(integer, timestamptz) to service_role;

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_interval_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_interval_check
  check ("interval" = any (array['1min', '5min', '15min', '1h', '4h', '1day']));

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_rule_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_rule_check
  check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx', 'sweepx']));
