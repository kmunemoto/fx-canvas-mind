-- #160: the lines and shapes drawn on the chart, kept with the account.
--
-- One row per user and pair: that pair's drawings as the browser keeps them
-- (src/lib/drawings.ts, read back through drawingListFrom, which drops
-- anything it cannot draw). A pair's drawings show on every timeframe, as
-- TradingView keeps them per symbol. Read and written from the app by its
-- owner only (src/lib/drawingsSync.ts); the browser keeps its own copy too,
-- so the chart works without these rows. A pair with nothing drawn keeps an
-- empty list (deleting everything on one device clears it on the others).

create table if not exists public.user_chart_drawings (
  user_id uuid not null references auth.users (id) on delete cascade,
  pair text not null,
  drawings jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, pair),
  constraint user_chart_drawings_pair check (char_length(pair) between 1 and 16),
  constraint user_chart_drawings_list check (jsonb_typeof(drawings) = 'array'),
  -- up to 200 drawings of a few hundred bytes each
  constraint user_chart_drawings_size check (pg_column_size(drawings) < 131072)
);

alter table public.user_chart_drawings enable row level security;
revoke all on public.user_chart_drawings from anon;
revoke all on public.user_chart_drawings from authenticated;
grant select, insert, update on public.user_chart_drawings to authenticated;
grant all on public.user_chart_drawings to service_role;

drop policy if exists "user_chart_drawings own read" on public.user_chart_drawings;
create policy "user_chart_drawings own read" on public.user_chart_drawings
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_chart_drawings own insert" on public.user_chart_drawings;
create policy "user_chart_drawings own insert" on public.user_chart_drawings
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_chart_drawings own update" on public.user_chart_drawings;
create policy "user_chart_drawings own update" on public.user_chart_drawings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
