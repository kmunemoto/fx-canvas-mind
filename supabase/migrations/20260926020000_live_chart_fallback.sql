-- #113 v3: the live chart's fallback while GMO's feed cannot be read.
--
-- The last bars fetched from Twelve Data per pair and timeframe, so the
-- chart can still show the market up to its last close (GMO's weekend
-- maintenance answers every call with status 5). One row per chart, fetched
-- again at most every 30 minutes (live-chart/logic.ts FALLBACK_TTL_MS): the
-- key is the analysis's own, eight requests a minute. Market data, written
-- and read by the live-chart function only (service role).

create table if not exists public.live_chart_fallback (
  pair text not null,
  interval text not null,
  -- oldest first: [{datetime: "YYYY-MM-DD HH:mm:ss" (UTC), open, high, low, close}]
  bars jsonb not null,
  source text not null default 'twelvedata',
  fetched_at timestamptz not null default now(),
  primary key (pair, interval)
);

alter table public.live_chart_fallback enable row level security;
revoke all on public.live_chart_fallback from anon, authenticated;
grant all on public.live_chart_fallback to service_role;
