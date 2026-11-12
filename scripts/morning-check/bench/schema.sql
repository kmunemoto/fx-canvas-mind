-- Local test bench of scripts/morning-check v9: the tables the statements read, with the columns they read (shapes as in production on 2026-11-12; `who` stands for the
-- user column, which the statements never read). public.macd_rides, public.macd_ride_state and the functions mc.pairs_v9 / mc.gold_v9 come from the repository's own
-- migrations (run.sh applies them after this file). THIS DROPS THE SCHEMA public: for a scratch database only.
drop schema if exists public cascade;
create schema public;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create table public.gmo_kline_files (symbol text not null, price_type text not null, interval text not null, date_key text not null, body jsonb not null, fetched_at timestamptz not null default now(),
  primary key (symbol, price_type, interval, date_key));
create table public.signal_alerts (id bigserial primary key, kind text not null, pair text not null, interval text not null, bar_time timestamptz not null, closed_at timestamptz, side text not null,
  entry double precision, rule text not null, status text not null, created_at timestamptz not null default now(), sent_at timestamptz, who text not null default 'u1');
create table public.signal_alert_subscriptions (who text not null default 'u1', pair text not null, interval text not null, rule text not null);
create table public.live_chart_fallback (pair text not null, interval text not null, bars jsonb not null, source text, fetched_at timestamptz not null, primary key (pair, interval));
create table public.gold_tick_bars (minute timestamptz primary key, open numeric not null, high numeric not null, low numeric not null, close numeric not null,
  first_at timestamptz not null, last_at timestamptz not null, samples integer not null default 1, source text);
create table public.twelve_data_usage (day date primary key, used integer not null, updated_at timestamptz not null default now());
