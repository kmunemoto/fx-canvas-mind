-- What is scheduled, so the analyzer is not surprised by the calendar and the
-- post-mortem does not have to guess at "news".
--
-- Until now the plan prompt knew only what a web search happened to surface,
-- and a post-mortem called a move "news_shock" purely from the shape of a bar.
-- Forex Factory's weekly JSON is free and keyless; it carries the schedule and
-- the consensus, but no actual print — so this table answers "what is due" and
-- "what was expected", never "what came out".

create table if not exists public.econ_events (
  -- country|event_at|title — the feed has no id of its own
  id text primary key,
  event_at timestamptz not null,
  country text not null,
  title text not null,
  -- High / Medium / Low / Holiday
  impact text not null,
  forecast text,
  previous text,
  -- A holiday, or an item the feed gives no time for: the stamp is the day
  all_day boolean not null default false,
  source text not null default 'forexfactory',
  fetched_at timestamptz not null default now()
);

create index if not exists econ_events_at_idx on public.econ_events (event_at, impact);

alter table public.econ_events enable row level security;
revoke all on public.econ_events from anon, authenticated;
grant select on public.econ_events to authenticated;
grant all on public.econ_events to service_role;
drop policy if exists "Signed-in users can read the calendar" on public.econ_events;
create policy "Signed-in users can read the calendar"
  on public.econ_events for select to authenticated
  using (true);

-- Sweep bookkeeping, like the tracker and the post-mortem have
create table if not exists public.econ_calendar_state (
  id integer primary key check (id = 1),
  last_run_at timestamptz,
  last_result jsonb
);
insert into public.econ_calendar_state (id) values (1) on conflict (id) do nothing;
alter table public.econ_calendar_state enable row level security;
revoke all on public.econ_calendar_state from anon, authenticated;
grant all on public.econ_calendar_state to service_role;

-- Hourly, on a minute of its own so it never shares a tick with the two
-- market-data sweeps. Far inside Forex Factory's published rate limit.
select cron.unschedule(jobid) from cron.job where jobname = 'econ-calendar-sync';
select cron.schedule(
  'econ-calendar-sync',
  '13 * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/econ-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"sweep"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
