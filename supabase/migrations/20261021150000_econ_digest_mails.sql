-- #370: the mail of big scheduled events, sent on its own each weekday
-- morning in Japan (econ-calendar/digest.ts, docs §8.123).
--
-- One row per person per Japanese morning. The insert is the claim, so two
-- runs of econ-calendar that overlap cannot both mail it. Written by the
-- econ-calendar function only (service role): a user may read their own rows
-- and nothing else.

create table if not exists public.econ_digest_mails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- the Japanese date of the morning the mail is for
  digest_day date not null,
  -- the first section: 24 hours from the send
  window_from timestamptz not null,
  window_to timestamptz not null,
  -- how many events each section listed, and which (econ_events.id)
  soon_events integer not null default 0,
  later_events integer not null default 0,
  event_ids text[] not null default '{}',
  lang text not null default 'ja' check (lang in ('ja', 'en')),
  -- pending: claimed, not yet handed to the mail provider
  -- sent / failed: what the provider said
  -- not_configured: no RESEND_API_KEY on the function
  -- skipped: not mailed on purpose (error says why: 'plan')
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'not_configured', 'skipped')),
  -- why it was skipped, or the provider's answer on a failure, with any
  -- address in it removed
  error text,
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, digest_day)
);

alter table public.econ_digest_mails enable row level security;
revoke all on public.econ_digest_mails from anon, authenticated;
grant select on public.econ_digest_mails to authenticated;
grant all on public.econ_digest_mails to service_role;
drop policy if exists "Users read their own digest mails" on public.econ_digest_mails;
create policy "Users read their own digest mails"
  on public.econ_digest_mails for select to authenticated
  using (auth.uid() = user_id);
