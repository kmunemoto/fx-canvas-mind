-- Outcome evidence, entry-aware outcomes, and a scheduled sweep so that open
-- signals are judged even when nobody opens the app.
--
-- The first tracker compared plans against candles whose timestamps were not
-- UTC and never checked whether the entry price was reached, so it marked
-- trades that never happened as losses. Rows it judged are sent back to
-- 'pending' and re-judged by the new tracker, which records its evidence.

-- 1. Two more outcomes. 'untriggered': the entry price was never reached, so
--    no trade happened. 'ambiguous': SL and TP were both touched inside one
--    candle and finer data could not order them. Neither counts toward the
--    win rate.
alter table public.analyses drop constraint if exists analyses_outcome_check;
alter table public.analyses add constraint analyses_outcome_check
  check (outcome in ('pending', 'win', 'loss', 'expired', 'skipped', 'untriggered', 'ambiguous'));

-- 2. Evidence: the market price when the plan was made (written by analyze)
--    and the tracker's judgement details (fill, resolution, excursions, path).
alter table public.analyses add column if not exists price_at_signal numeric;
alter table public.analyses add column if not exists evaluation jsonb;

-- The sweep scans open plans across all users, oldest first
create index if not exists analyses_pending_sweep_idx
  on public.analyses (created_at)
  where outcome = 'pending';

-- 3. Re-judge everything the old tracker decided without evidence
update public.analyses
   set outcome = 'pending', outcome_price = null, closed_at = null
 where outcome in ('win', 'loss')
   and evaluation is null;

-- 4. Sweep bookkeeping (global cooldown + last result), service role only
create table if not exists public.tracker_state (
  id integer primary key check (id = 1),
  last_sweep_at timestamptz,
  last_sweep_result jsonb
);
insert into public.tracker_state (id) values (1) on conflict (id) do nothing;
alter table public.tracker_state enable row level security;
revoke all on public.tracker_state from anon, authenticated;
grant all on public.tracker_state to service_role;

-- 5. Shared secret between the cron job and the edge function. Generated on
--    the database so it never appears in the repository; the function reads
--    it back through a service-role-only RPC.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'track_outcomes_sweep_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(24), 'hex'),
      'track_outcomes_sweep_token',
      'Authorises the scheduled track-outcomes sweep'
    );
  end if;
end $$;

create or replace function public.track_outcomes_sweep_token()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = 'track_outcomes_sweep_token'
   limit 1;
$$;
revoke all on function public.track_outcomes_sweep_token() from public, anon, authenticated;
grant execute on function public.track_outcomes_sweep_token() to service_role;

-- 6. Every 15 minutes, ask the tracker to judge whatever is due. The function
--    itself decides which plans need a fresh look (one check per plan
--    timeframe), so most runs cost nothing.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'track-outcomes-sweep',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/track-outcomes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')
    ),
    body := '{"mode":"sweep"}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);
