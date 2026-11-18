-- Local test bench of scripts/morning-check v11 (README.md v11.4): the tables the v11 statements read, with the columns they read (signal_alerts with entry, stop and target, as
-- in supabase/migrations/20260925120000_signal_alerts.sql; `who` stands for the user column, which the statements never read). public.gold_tick_bars is here only so that the
-- v9 bench's gold file (gen_gold.py) loads as it is; v11 does not read it. THIS DROPS THE SCHEMA public: for a scratch database only.
drop schema if exists public cascade;
create schema public;
create table public.gmo_kline_files (symbol text not null, price_type text not null, interval text not null, date_key text not null, body jsonb not null, fetched_at timestamptz not null default now(),
  primary key (symbol, price_type, interval, date_key));
create table public.signal_alerts (id bigserial primary key, kind text not null, pair text not null, interval text not null, bar_time timestamptz not null, closed_at timestamptz, side text not null,
  entry double precision, stop double precision, target double precision, rule text not null, status text not null, created_at timestamptz not null default now(), sent_at timestamptz,
  who text not null default 'u1');
create table public.signal_alert_subscriptions (who text not null default 'u1', pair text not null, interval text not null, rule text not null);
create table public.live_chart_fallback (pair text not null, interval text not null, bars jsonb not null, source text, fetched_at timestamptz not null, primary key (pair, interval));
create table public.gold_tick_bars (minute timestamptz primary key, open numeric not null, high numeric not null, low numeric not null, close numeric not null,
  first_at timestamptz not null, last_at timestamptz not null, samples integer not null default 1, source text);
create table public.twelve_data_usage (day date primary key, used integer not null, updated_at timestamptz not null default now());
