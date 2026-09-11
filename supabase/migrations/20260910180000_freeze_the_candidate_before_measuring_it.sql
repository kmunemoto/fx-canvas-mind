-- #65 asks whether the CANDIDATE rulebook is better than the LIVE one. Before
-- any of that can be measured, one thing has to stop moving.
--
-- WHY A FREEZE TABLE EXISTS AT ALL.
--
-- `public.rulebook.candidate` is rewritten by the postmortem sweep, which is a
-- pg_cron job on `8,23,38,53 * * * *`. Measured 2026-09-10 against production:
-- the row holds version 8 with 3 live rules; `candidate` holds 4 rules,
-- `base_version` 8, `created_at` 2026-09-10T05:53:53.335Z, and
-- `candidate->'superseded'` carries 5 previous generations. The object under
-- evaluation is therefore replaced roughly every six hours, and a comparison
-- run takes hours: a run that named "the candidate" would be measuring one
-- object for its first hop and a different object for its last, and nothing in
-- the stored rows would say which cells belonged to which. Every cell would
-- still look like a measurement.
--
-- So a run does not name "the candidate". It names a FREEZE ID, and the row
-- behind that id is an immutable copy: the rules, the base version, a content
-- digest and the instant the copy was taken. The triggers below are what make
-- "immutable" a property of the database rather than a promise in a comment —
-- the only role that can reach these tables is service_role, and service_role
-- bypasses RLS, so a policy would not stop an UPDATE. A trigger does.
--
-- THE LIVE SIDE IS FROZEN TOO, and that is not symmetry for its own sake.
-- `rulebook.rules` moves when the postmortem promotes a candidate. A run whose
-- live arm re-read the table on every hop would be comparing the candidate
-- against version 8 in the morning and against version 9 in the afternoon,
-- which is two experiments reported as one. Both arms of a comparison come out
-- of one frozen row.
--
-- WHAT THESE TABLES DELIBERATELY DO NOT HOLD: prompt text. Same rule as
-- noise_cells (20260909120000_the_analyst_is_measured_against_itself.sql) and
-- for the same reason —
-- 20260905161000_replay_inputs_are_server_side.sql moved the system prompt off
-- a table carrying a table-level SELECT grant to `authenticated`, and echoing
-- it into a debugging table would rebuild that exposure. Digests are enough to
-- prove that the two arms of a pair sent the same user turn and the same
-- system prefix, and that is the only thing the pairing needs of them.

-- ---------------------------------------------------------------------------
-- The freeze
-- ---------------------------------------------------------------------------

create table if not exists public.rulebook_candidate_freezes (
  id uuid primary key default gen_random_uuid(),
  -- The instant the copy was taken. THIS IS ALSO THE TIME-SERIES SPLIT: stage
  -- 'performance' may only replay snapshots created strictly after it. See the
  -- trigger below and the query in the function; both enforce it, because a
  -- split that lives only in a WHERE clause somebody remembers to type is not
  -- a split.
  frozen_at timestamptz not null default now(),

  -- The candidate, copied. `rules` is the array as it stood; `base_version` is
  -- what the postmortem said it was derived from.
  candidate_rules jsonb not null,
  candidate_base_version integer not null,
  -- `candidate->>'created_at'`, i.e. when the postmortem wrote that generation.
  -- Nullable: it is the candidate's own claim about itself, and a generation
  -- that carried no timestamp must be recordable as one that carried none
  -- rather than as one written at freeze time.
  candidate_created_at timestamptz,
  -- `candidate->>'lessons_considered'`. Recorded because it is the single
  -- clearest statement of the leakage this harness is built around: measured
  -- 2026-09-10, it is 60, which is `RECENT_LESSONS` in
  -- supabase/functions/postmortem/index.ts — a CAP, not the whole table (there
  -- were 75 lessons at the freeze instant and 78 today). Of those 78 lessons,
  -- 60 are about analyses that also have a row in public.analysis_prompts,
  -- which is exactly the corpus a replay would draw from. Hence stage 'a'
  -- refuses to look at outcomes at all and stage 'b' refuses to look at
  -- snapshots older than `frozen_at`.
  candidate_lessons_considered integer,

  -- The live book at the same instant.
  live_rules jsonb not null,
  live_version integer not null,

  -- sha256 over the canonical text of each rule array, computed by the
  -- function before the insert. Two freezes of the same pair of books collide
  -- on the unique index below, which is deliberate: re-freezing an unchanged
  -- state should hand back the freeze that already exists rather than create a
  -- second id for one object and let two runs report on "different" freezes
  -- that are the same thing.
  candidate_sha256 text not null,
  live_sha256 text not null,

  -- Counted at freeze time and checked, so a freeze cannot record an empty
  -- book. A comparison against no rules is not a comparison.
  candidate_rule_count integer not null check (candidate_rule_count > 0),
  live_rule_count integer not null check (live_rule_count > 0),

  version text not null,
  notes jsonb,

  -- THE WHOLE POINT, stated as a constraint. If the two books render to the
  -- same digest there is nothing to measure and a run against this freeze
  -- would spend money to discover that the two arms were identical. The
  -- function checks the RENDERED BLOCKS as well (a rule reordering can change
  -- the array without changing the prompt); this is the floor under it.
  constraint freeze_arms_differ check (candidate_sha256 <> live_sha256)
);

comment on table public.rulebook_candidate_freezes is
  'An immutable copy of one generation of rulebook.candidate together with the live book at the same instant. A comparison run names one of these ids; the object behind it cannot change under the run. Service role only: no client reads these.';

create unique index if not exists rulebook_candidate_freezes_content_idx
  on public.rulebook_candidate_freezes (candidate_sha256, live_sha256);

-- IMMUTABILITY, enforced rather than promised.
--
-- RLS with no policy denies every non-service role, and service_role bypasses
-- RLS — which means the only role that can reach this table is the one a
-- policy cannot restrain. A trigger can. Both statements are refused outright:
-- there is no legitimate edit to a freeze (a changed candidate is a NEW
-- freeze), and there is no legitimate delete either, because runs reference
-- freezes and a deleted freeze would leave a finished run whose two arms
-- nobody can reconstruct.
create or replace function public.rulebook_candidate_freezes_are_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception
    'rulebook_candidate_freezes is append-only: % is refused. A changed candidate is a new freeze.',
    tg_op;
end;
$$;

revoke all on function public.rulebook_candidate_freezes_are_immutable() from public, anon, authenticated;

drop trigger if exists rulebook_candidate_freezes_no_update on public.rulebook_candidate_freezes;
create trigger rulebook_candidate_freezes_no_update
  before update or delete on public.rulebook_candidate_freezes
  for each row execute function public.rulebook_candidate_freezes_are_immutable();

-- ---------------------------------------------------------------------------
-- The run header
-- ---------------------------------------------------------------------------
--
-- Shaped after public.noise_runs on purpose. The two harnesses share the same
-- failure mode — an edge worker killed at the platform's 150 s wall clock
-- leaves a claimed-unfinished cell behind — and the same answer to it: an
-- `expected_cells` the reporting gate compares against, so a partial run can
-- never be read as a complete one. A count of rows that exist can never be
-- compared against the count that should exist, which is why the header is a
-- separate table rather than a column on the cells.

create table if not exists public.version_compare_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  freeze_id uuid not null references public.rulebook_candidate_freezes(id),

  -- 'materiality' replays a snapshot under both books and asks only HOW OFTEN
  -- THEY DISAGREE. It reads no outcome, so no outcome can leak into it.
  --
  -- 'performance' scores both arms against what the market actually did, and
  -- is admissible only on snapshots created after the freeze. It cannot
  -- produce a verdict on the day the freeze is taken, by construction.
  stage text not null check (stage in ('materiality', 'performance')),

  -- The population cut, taken once before the first billable call. Same reason
  -- noise_runs has one: public.analysis_prompts grew from 48 rows on
  -- 2026-09-09 to 78 on 2026-09-10, so the denominator moves by roughly half
  -- its own size per day and an operator who reran until the answer looked
  -- right would be choosing the answer.
  population_frozen_at timestamptz not null,

  -- What the eligibility filter actually was, written down rather than
  -- reconstructed later. Null on a materiality run (no lower bound); on a
  -- performance run it is the freeze's `frozen_at`, and the trigger below
  -- checks that it is.
  eligible_after timestamptz,

  -- Two cells per row: one per arm. expected_cells = rows x 2.
  expected_cells integer not null check (expected_cells > 0),
  completed_cells integer not null default 0 check (completed_cells >= 0),
  failed_cells integer not null default 0 check (failed_cells >= 0),

  -- Measured from `usage` on every response, never counted in calls: at
  -- max_tokens 8000 with thinking billed as output, a call count bounds
  -- nothing.
  budget_input_tokens bigint not null,
  budget_output_tokens bigint not null,
  spent_input_tokens bigint not null default 0,
  spent_output_tokens bigint not null default 0,

  status text not null default 'dry'
    check (status in ('dry', 'running', 'paused', 'done', 'aborted')),
  abort_reason text,
  chain boolean not null default false,
  chain_hops integer not null default 0,
  max_chain_hops integer not null default 0,
  version text not null,
  notes jsonb,

  -- THE STOPPING RULE, WRITTEN DOWN ONCE.
  --
  -- Report mode is free, reads only, and re-runnable, while the number of
  -- SCORED pairs keeps growing on a fixed population as outcomes settle. So an
  -- operator could look on day 3, day 5 and day 8 and publish whichever look
  -- came out best — optional stopping, under which the nominal 5% is not 5%.
  --
  -- The rule is that the FIRST look at which the population reaches the
  -- pre-registered n is the test. That look writes itself here and every later
  -- look reports its own numbers as post hoc. This is a column and not a key
  -- inside `notes` for two reasons: a PATCH of `notes` rewrites the whole
  -- document and would race the run lease that also lives there, and a column
  -- can be made write-once by a trigger while a key inside a document cannot.
  stage_b_seal jsonb,

  -- Same bound, same reason, as noise_runs_cells_accounted_check: the
  -- reporting gate is `completed + failed >= expected`, and a double increment
  -- would open it while ok cells are still missing. The cells still missing are
  -- the ones that needed a retry, which are the unstable ones, so the rate that
  -- escapes is biased toward agreement — the direction that lets a real
  -- difference read as noise.
  constraint version_compare_runs_cells_accounted_check
    check (completed_cells + failed_cells <= expected_cells)
);

comment on table public.version_compare_runs is
  'One paired live-vs-candidate replay over a frozen population against a frozen candidate. Header only. Service role only: no client reads these.';

-- THE TIME-SERIES SPLIT, IN THE DATABASE.
--
-- The brief for this harness says the eligibility filter must be enforced in
-- the query and not by convention. It is — see readEligibleIds in
-- supabase/functions/version-compare/index.ts, which sends
-- `created_at=gt.<frozen_at>` to PostgREST. This trigger is the second lock on
-- the same door: it refuses a performance run whose declared eligibility bound
-- is EARLIER than the freeze's own instant, so a hand-written INSERT, or a
-- future function that forgot, cannot create a performance run that silently
-- admits the snapshots the candidate was built from.
--
-- A LATER bound is accepted on purpose. `eligible_after > frozen_at` throws
-- eligible rows away; it can never admit a fitted one, and the direction that
-- discards evidence is the direction this instrument is allowed to err in.
--
-- What this trigger does NOT cover, stated here because it is the gap a reader
-- would otherwise assume closed: it fires `before insert or update of stage,
-- freeze_id, eligible_after, population_frozen_at`, and `notes` — which holds
-- the frozen population's id list, i.e. the rows that actually get scored — is
-- deliberately not in that list, because report mode and the run lease both
-- rewrite `notes` on a finished run. The id list is therefore re-checked
-- against this bound in report mode, on the path that emits the number, before
-- any outcome is read. See "THE SPLIT, RE-PROVED HERE" in index.ts.
create or replace function public.version_compare_runs_respect_the_split()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  frozen timestamptz;
begin
  select f.frozen_at into frozen
    from public.rulebook_candidate_freezes f
   where f.id = new.freeze_id;
  if frozen is null then
    raise exception 'version_compare_runs: freeze_id % does not exist', new.freeze_id;
  end if;

  if new.stage = 'performance' then
    if new.eligible_after is null or new.eligible_after < frozen then
      raise exception
        'a performance run must declare eligible_after >= the freeze instant (%); got %',
        frozen, new.eligible_after;
    end if;
    if new.population_frozen_at <= frozen then
      raise exception
        'a performance run needs a population cut after the freeze (%); got %',
        frozen, new.population_frozen_at;
    end if;
  else
    -- A materiality run has no lower bound and must not pretend to one: a
    -- stored value here would be read later as "this run was forward-only".
    if new.eligible_after is not null then
      raise exception 'a materiality run must not declare eligible_after; it has no time-series split';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.version_compare_runs_respect_the_split() from public, anon, authenticated;

drop trigger if exists version_compare_runs_split on public.version_compare_runs;
create trigger version_compare_runs_split
  before insert or update of stage, freeze_id, eligible_after, population_frozen_at
  on public.version_compare_runs
  for each row execute function public.version_compare_runs_respect_the_split();

-- THE SEAL IS WRITE-ONCE, ENFORCED RATHER THAN PROMISED.
--
-- The function will not overwrite a seal — it PATCHes with
-- `stage_b_seal=is.null` and adopts the winner on a miss — but the function is
-- the policy and this is the floor under it. Once the pre-registered look has
-- been recorded, no later look and no hand-written UPDATE may replace it,
-- because replacing it is exactly how a null result becomes a positive one
-- three days later. Clearing it back to null is refused for the same reason.
create or replace function public.version_compare_runs_seal_is_write_once()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.stage_b_seal is not null and new.stage_b_seal is distinct from old.stage_b_seal then
    raise exception
      'version_compare_runs.stage_b_seal is write-once: the pre-registered look has already been recorded';
  end if;
  return new;
end;
$$;

revoke all on function public.version_compare_runs_seal_is_write_once() from public, anon, authenticated;

drop trigger if exists version_compare_runs_seal_write_once on public.version_compare_runs;
create trigger version_compare_runs_seal_write_once
  before update of stage_b_seal on public.version_compare_runs
  for each row execute function public.version_compare_runs_seal_is_write_once();

-- One dry run authorises ONE spending run. Copied from
-- noise_runs_one_spend_per_dry_run, including its reasoning: the function
-- checks this too and refuses more (any non-dry run citing the id, 'done' and
-- 'aborted' included), but the function's check is a SELECT followed by an
-- INSERT and the documented invocation is `select net.http_post(...)`, which
-- returns before the run exists. The index is the floor that survives a future
-- function change; the function is the policy on top of it.
create unique index if not exists version_compare_runs_one_spend_per_dry_run
  on public.version_compare_runs ((notes->>'dry_run_id'))
  where status in ('running', 'paused');

-- ---------------------------------------------------------------------------
-- The cells
-- ---------------------------------------------------------------------------

create table if not exists public.version_compare_cells (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.version_compare_runs(id) on delete cascade,
  analysis_id uuid not null references public.analyses(id) on delete cascade,

  -- Which book was spliced into the stored system prompt for this call.
  -- 'live' is the frozen live book, NOT the block the stored prompt carried:
  -- both arms are re-rendered by the same renderer so that the ONLY difference
  -- between the two members of a pair is the rule list. The cost of that
  -- choice is real and is written down in docs/VERSION_COMPARISON.md — neither
  -- arm is byte-identical to what production sent, because the stored block was
  -- rendered ranked and carried per-rule fit markers computed against the
  -- market of that minute, and re-computing those today would change two
  -- things at once and destroy the pairing.
  arm text not null check (arm in ('live', 'candidate')),

  claimed_at timestamptz not null default now(),
  finished_at timestamptz,

  -- The request actually built, recorded rather than reconstructed later.
  shape text not null check (shape in ('search_free_inline', 'structured', 'search_on')),
  effort text not null,
  max_tokens integer not null,
  tools_present boolean not null,
  schema_in_prompt boolean not null,
  schema_era text not null,

  -- The bytes that went on the wire. THE PAIRING TEST IS SPELLED OUT IN THESE
  -- THREE COLUMNS: the two arms of one row must agree on `user_sha256` (same
  -- market snapshot, same question) and must DIFFER on `rules_sha256` (a
  -- different book), which forces them to differ on `system_sha256` as well.
  -- A pair that agrees on rules_sha256 is not a comparison; a pair that
  -- disagrees on user_sha256 is not a pair. Report mode refuses both.
  system_sha256 text not null,
  user_sha256 text not null,
  -- sha256 of the rendered rules block spliced in for this arm.
  rules_sha256 text not null,

  status text not null default 'claimed'
    check (status in ('claimed', 'ok', 'http_error', 'parse_failed',
                      'missing_keys', 'refusal', 'truncated', 'timeout',
                      'pause_exhausted', 'aborted')),
  http_status integer,
  stop_reason text,
  stop_details jsonb,
  error_slice text,

  -- The model's own answer, read from the raw parsed JSON before any
  -- normalisation. Same rule as noise_cells: `normalizeAnalysis` coerces an
  -- unreadable signal to "WAIT" and an unreadable confidence to 0, so a
  -- harness that read the normalised object would score every parse failure as
  -- agreement-with-WAIT — and here that biases the disagreement rate DOWN,
  -- which is the direction that makes a real change look immaterial.
  raw_signal text,
  raw_confidence integer,
  raw_stop numeric,
  raw_tp1 numeric,
  raw_fundamental_score integer,
  missing_required_keys text[],
  rules_applied jsonb,

  response_model text,
  input_tokens integer,
  output_tokens integer,
  cache_read_input_tokens integer,
  request_id text,

  constraint version_compare_cells_ok_is_answered_check
    check (status <> 'ok'
           or (finished_at is not null
               and raw_signal is not null
               and raw_confidence is not null)),

  -- The claim. Inserted before the model is called, so two invocations of a
  -- chained run cannot both spend on the same (row, arm).
  unique (run_id, analysis_id, arm)
);

comment on table public.version_compare_cells is
  'One replay of one stored prompt under one rulebook: which arm, the digests of what was sent, and the raw pre-normalisation answer. Service role only: no client reads these.';

create index if not exists version_compare_cells_run_idx
  on public.version_compare_cells (run_id, status);

-- RLS with no policy denies every non-service role; service_role bypasses RLS.
-- No client path exists to any of these rows and no grant to service_role is
-- needed or given. Expect `rls_enabled_no_policy` to appear as an INFO advisor
-- finding on all three tables: that is the intended state, the same one
-- analysis_prompts, noise_runs and noise_cells already carry.
alter table public.rulebook_candidate_freezes enable row level security;
alter table public.version_compare_runs enable row level security;
alter table public.version_compare_cells enable row level security;
revoke all on public.rulebook_candidate_freezes from public, anon, authenticated;
revoke all on public.version_compare_runs from public, anon, authenticated;
revoke all on public.version_compare_cells from public, anon, authenticated;
