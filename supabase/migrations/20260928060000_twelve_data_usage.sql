-- #146: the live chart's Twelve Data reads, counted per day.
--
-- Gold's 1- and 5-minute charts read Twelve Data again once a bar has
-- closed — up to 1,440 and 288 times a day while one is open — and the key
-- allows 800 a day (its day ends at 00:00 UTC). The live-chart function
-- counts each read here and stops reading for a timeframe once the day's
-- count reaches that timeframe's cap (live-chart/logic.ts TWELVE_CAPS: the
-- 1-minute chart first, the 5-minute one next, the rest last), so one chart
-- left open cannot spend the others' reads. Written and read by the
-- live-chart function only (service role).

create table if not exists public.twelve_data_usage (
  -- the UTC day, as Twelve Data counts it
  day date primary key,
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now()
);

alter table public.twelve_data_usage enable row level security;
revoke all on public.twelve_data_usage from anon, authenticated;
grant all on public.twelve_data_usage to service_role;

-- One more read for the day, unless the day's count has reached p_cap:
-- true when counted (the read may go ahead), false when not. One statement,
-- so two reads at once cannot both take the last one. p_day is for checks
-- only; the function passes none.
create or replace function public.take_twelve_data_credit(
  p_cap integer,
  p_day date default (now() at time zone 'utc')::date
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  got integer;
begin
  if p_cap is null or p_cap < 1 then
    return false;
  end if;
  insert into public.twelve_data_usage as u (day, used, updated_at)
  values (p_day, 1, now())
  on conflict (day) do update
    set used = u.used + 1, updated_at = now()
    where u.used < p_cap
  returning u.used into got;
  return got is not null;
end;
$$;

revoke all on function public.take_twelve_data_credit(integer, date) from public, anon, authenticated;
grant execute on function public.take_twelve_data_credit(integer, date) to service_role;
