-- #154: the price of each pair read as gold is, recorded as gold's is
-- (#147, gold_tick_bars), so its chart goes on in real time when Twelve
-- Data cannot be read again.
--
-- The request (2026-09-28), with the owner's broker's 38 pairs: 「画像の
-- ペアと銘柄を全て追加して」. Fifteen of them GMO does not serve; their
-- bars come from Twelve Data and their moving price from Swissquote, as
-- gold's do (live-chart/logic.ts, "the broker's pairs GMO does not serve"),
-- within the same day's reads. Past a timeframe's cap for the day, or while
-- Twelve Data does not answer, the chart goes on from the bars it last read
-- with the prices kept here: the pair on screen's Swissquote mid, which the
-- live-chart function reads every few seconds, one row a minute (open,
-- high, low and close). Only the pair someone is watching, and only while
-- they are: a minute nobody watched has no row. Two days are kept.
-- Written and read by the live-chart function only (service role).

create table if not exists public.live_tick_bars (
  pair text not null,
  -- the minute (UTC) the prices fell in
  minute timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  -- the first and last price's own time in the minute
  first_at timestamptz not null,
  last_at timestamptz not null,
  samples integer not null default 1,
  primary key (pair, minute)
);

alter table public.live_tick_bars enable row level security;
revoke all on public.live_tick_bars from anon, authenticated;
grant all on public.live_tick_bars to service_role;

-- One price of a pair (Swissquote's mid, at the time it was read) into its
-- minute; the pair's rows two days older than it are dropped.
create or replace function public.record_live_tick(p_pair text, p_at timestamptz, p_mid numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m timestamptz;
begin
  if p_pair is null or length(p_pair) = 0 or length(p_pair) > 16 or p_at is null or p_mid is null or p_mid <= 0 then
    return;
  end if;
  m := date_trunc('minute', p_at at time zone 'utc') at time zone 'utc';
  insert into public.live_tick_bars as b (pair, minute, open, high, low, close, first_at, last_at, samples)
  values (p_pair, m, p_mid, p_mid, p_mid, p_mid, p_at, p_at, 1)
  on conflict (pair, minute) do update set
    open = case when p_at < b.first_at then p_mid else b.open end,
    close = case when p_at >= b.last_at then p_mid else b.close end,
    high = greatest(b.high, p_mid),
    low = least(b.low, p_mid),
    first_at = least(b.first_at, p_at),
    last_at = greatest(b.last_at, p_at),
    samples = b.samples + 1;
  delete from public.live_tick_bars where pair = p_pair and minute < m - interval '2 days';
end;
$$;

revoke all on function public.record_live_tick(text, timestamptz, numeric) from public, anon, authenticated;
grant execute on function public.record_live_tick(text, timestamptz, numeric) to service_role;
