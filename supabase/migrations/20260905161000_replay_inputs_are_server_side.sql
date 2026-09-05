-- The replay inputs are machinery, not the user's data, and the first
-- migration's reasoning was wrong about one of them: quote_at_signal and the
-- rendered rules block are indeed things the caller can already see, but
-- prompt.system is the whole analyst system prompt, which has never been
-- client-readable. public.analyses carries a table-level select grant to
-- authenticated (narrowed to own rows by RLS), and a table-level grant cannot
-- be revoked one column at a time — so the column has to live somewhere else.
--
-- A separate table also says what these rows are for: nothing in the app reads
-- them, only the replay and comparison paths running as the service role.
create table if not exists public.analysis_prompts (
  analysis_id uuid primary key references public.analyses(id) on delete cascade,
  system text,
  "user" text,
  model text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.analysis_prompts is
  'The two strings sent to the model for one analysis, verbatim, so the plan can be replayed. Service role only: no client reads these.';

alter table public.analysis_prompts enable row level security;
-- No policy on purpose: RLS with no policy denies every non-service role, and
-- the service role bypasses RLS. There is no client path to these rows.
revoke all on public.analysis_prompts from public, anon, authenticated;

-- The column on analyses was added minutes ago and no row has ever been
-- written with it, so there is nothing to migrate.
alter table public.analyses drop column if exists prompt;
