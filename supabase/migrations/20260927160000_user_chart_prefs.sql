-- #141: the chart's settings kept with the account.
--
-- What was chosen on the charts — the indicators and their settings, the
-- background, and the live chart's pair, timeframe and signals — so another
-- device, or the home-screen app beside the browser, opens the same chart.
-- One row per user, the whole set as the browser keeps it
-- (src/lib/chartPrefs.ts, read back through chartPrefsFrom, which drops
-- anything it does not know). Read and written from the app by its owner
-- only (src/lib/chartPrefsSync.ts); the browser keeps its own copy too, so
-- the chart works without this row.

create table if not exists public.user_chart_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  prefs jsonb not null,
  updated_at timestamptz not null default now(),
  -- a few hundred bytes in use; a bound so the row stays a settings row
  constraint user_chart_prefs_size check (pg_column_size(prefs) < 8192)
);

alter table public.user_chart_prefs enable row level security;
revoke all on public.user_chart_prefs from anon;
revoke all on public.user_chart_prefs from authenticated;
grant select, insert, update on public.user_chart_prefs to authenticated;
grant all on public.user_chart_prefs to service_role;

drop policy if exists "user_chart_prefs own read" on public.user_chart_prefs;
create policy "user_chart_prefs own read" on public.user_chart_prefs
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_chart_prefs own insert" on public.user_chart_prefs;
create policy "user_chart_prefs own insert" on public.user_chart_prefs
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_chart_prefs own update" on public.user_chart_prefs;
create policy "user_chart_prefs own update" on public.user_chart_prefs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
