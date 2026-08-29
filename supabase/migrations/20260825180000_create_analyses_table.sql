-- Per-analysis history with win/loss tracking.
--
-- Rows are written by the analyze edge function with the service role and
-- evaluated later by track-outcomes (SL/TP hit detection). Users can only
-- read their own rows; all writes go through the service role so a user
-- cannot forge their own track record.

create table if not exists public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  pair text not null,
  interval text not null,
  mode text not null default 'full',
  signal text not null check (signal in ('BUY', 'SELL', 'WAIT')),
  confidence integer,
  thesis text,
  entry_point numeric,
  stop_loss numeric,
  take_profit_1 numeric,
  take_profit_2 numeric,
  take_profit_3 numeric,
  risk_reward text,
  result jsonb,
  outcome text not null default 'pending'
    check (outcome in ('pending', 'win', 'loss', 'expired', 'skipped')),
  outcome_price numeric,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists analyses_user_created_idx
  on public.analyses (user_id, created_at desc);

-- track-outcomes scans open trades only
create index if not exists analyses_pending_idx
  on public.analyses (user_id, created_at)
  where outcome = 'pending';

alter table public.analyses enable row level security;

drop policy if exists "Users can read own analyses" on public.analyses;
create policy "Users can read own analyses"
  on public.analyses for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.analyses from anon, authenticated;
grant select on public.analyses to authenticated;
grant all on public.analyses to service_role;
