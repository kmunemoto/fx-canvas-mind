-- #147: gold's price, recorded as 1-minute bars, so its chart goes on in
-- real time when Twelve Data cannot be read again.
--
-- The request (2026-09-28): 「チャートはいつもリアルタイムで表示するように」.
-- Gold's bars come from Twelve Data, read again once a bar has closed, and
-- #146 caps the day's reads per timeframe (the key allows 800 a day): past
-- the cap, or while Twelve Data does not answer, the chart stood still at
-- the bars it had last read. Its moving price is Swissquote's, which the
-- live-chart function reads every few seconds while anyone has a live chart
-- open; each of those reads is kept here, one row a minute (the mid's open,
-- high, low and close), and the function goes on from the bars it last read
-- with these (live-chart/logic.ts extendWithTicks). Only while someone is
-- watching: a minute nobody watched has no row. Two days are kept.
-- Written and read by the live-chart function only (service role).

create table if not exists public.gold_tick_bars (
  -- the minute (UTC) the prices fell in
  minute timestamptz primary key,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  -- the first and last price's own time in the minute
  first_at timestamptz not null,
  last_at timestamptz not null,
  samples integer not null default 1
);

alter table public.gold_tick_bars enable row level security;
revoke all on public.gold_tick_bars from anon, authenticated;
grant all on public.gold_tick_bars to service_role;

-- One price (Swissquote's mid, at its own time) into its minute; rows two
-- days older than it are dropped.
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
  m := date_trunc('minute', p_at at time zone 'utc') at time zone 'utc';
  insert into public.gold_tick_bars as b (minute, open, high, low, close, first_at, last_at, samples)
  values (m, p_mid, p_mid, p_mid, p_mid, p_at, p_at, 1)
  on conflict (minute) do update set
    open = case when p_at < b.first_at then p_mid else b.open end,
    close = case when p_at >= b.last_at then p_mid else b.close end,
    high = greatest(b.high, p_mid),
    low = least(b.low, p_mid),
    first_at = least(b.first_at, p_at),
    last_at = greatest(b.last_at, p_at),
    samples = b.samples + 1;
  delete from public.gold_tick_bars where minute < m - interval '2 days';
end;
$$;

revoke all on function public.record_gold_tick(timestamptz, numeric) from public, anon, authenticated;
grant execute on function public.record_gold_tick(timestamptz, numeric) to service_role;
