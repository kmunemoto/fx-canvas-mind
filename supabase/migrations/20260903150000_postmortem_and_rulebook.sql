-- Why a plan missed, and what the analyzer learns from it.
--
-- Every settled plan gets a post-mortem: the tracker's evidence plus what
-- price did afterwards, turned into a cause ("the stop was inside the noise",
-- "the entry never came") and a one-line lesson. The lessons are consolidated
-- into a small rulebook that analyze puts in front of the model, and each new
-- plan records which rulebook version it was made under so the effect of the
-- rules can be measured rather than assumed.

-- 1. analyses: the indicator snapshot the plan was made on (so a post-mortem
--    can see what the model saw), the diagnosis, the rulebook version, and a
--    shadow flag for plans the entry gate refused but which are still tracked
--    so the refusal itself can be checked against the market.
alter table public.analyses add column if not exists context jsonb;
alter table public.analyses add column if not exists postmortem jsonb;
alter table public.analyses add column if not exists rulebook_version integer;
alter table public.analyses add column if not exists shadow boolean not null default false;
alter table public.analyses add column if not exists shadow_of uuid references public.analyses(id) on delete cascade;

create index if not exists analyses_postmortem_due_idx
  on public.analyses (closed_at)
  where outcome in ('win', 'loss', 'untriggered', 'expired', 'ambiguous')
    and postmortem is null;

create index if not exists analyses_shadow_of_idx
  on public.analyses (shadow_of)
  where shadow_of is not null;

-- 2. One lesson per diagnosed plan. Readable by the plan's owner; written by
--    the postmortem function with the service role.
create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null unique references public.analyses(id) on delete cascade,
  user_id uuid,
  pair text not null,
  interval text not null,
  signal text not null,
  mode text,
  order_type text,
  outcome text not null,
  cause text not null,
  secondary_causes text[] not null default '{}',
  avoidable boolean,
  confidence integer,
  lesson_ja text not null,
  lesson_en text not null,
  scope jsonb,
  shadow boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists lessons_created_at_idx on public.lessons (created_at desc);
alter table public.lessons enable row level security;
revoke all on public.lessons from anon, authenticated;
grant select on public.lessons to authenticated;
grant all on public.lessons to service_role;
drop policy if exists "Users can read lessons from own analyses" on public.lessons;
create policy "Users can read lessons from own analyses"
  on public.lessons for select to authenticated
  using ((select auth.uid()) = user_id);

-- 3. The consolidated rules. One row; every signed-in user can read it
--    (the app shows what the analyzer has learned), only the service role
--    writes it. Previous versions are kept so a rule can be traced.
create table if not exists public.rulebook (
  id integer primary key check (id = 1),
  version integer not null default 0,
  rules jsonb not null default '[]'::jsonb,
  summary jsonb,
  stats jsonb,
  history jsonb not null default '[]'::jsonb,
  updated_at timestamptz
);
insert into public.rulebook (id) values (1) on conflict (id) do nothing;
alter table public.rulebook enable row level security;
revoke all on public.rulebook from anon, authenticated;
grant select on public.rulebook to authenticated;
grant all on public.rulebook to service_role;
drop policy if exists "Signed-in users can read the rulebook" on public.rulebook;
create policy "Signed-in users can read the rulebook"
  on public.rulebook for select to authenticated
  using (true);

-- 4. Sweep bookkeeping for the postmortem run (cooldown + last result)
create table if not exists public.postmortem_state (
  id integer primary key check (id = 1),
  last_run_at timestamptz,
  last_result jsonb
);
insert into public.postmortem_state (id) values (1) on conflict (id) do nothing;
alter table public.postmortem_state enable row level security;
revoke all on public.postmortem_state from anon, authenticated;
grant all on public.postmortem_state to service_role;

-- 5. Every 15 minutes, offset from the tracker sweep so the two never share
--    a minute of market-data quota. Same shared secret as the tracker.
select cron.unschedule(jobid) from cron.job where jobname = 'postmortem-sweep';
select cron.schedule(
  'postmortem-sweep',
  '8,23,38,53 * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/postmortem',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"sweep"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
