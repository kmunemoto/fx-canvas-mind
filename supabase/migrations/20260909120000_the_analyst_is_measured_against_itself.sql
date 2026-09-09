-- #65 wants to know whether swapping the rulebook changes the analyst's
-- answer. It cannot know that until we know how often the analyst changes its
-- own answer with nothing swapped at all: the request carries no seed and, on
-- this model, temperature/top_p/top_k are not accepted parameters, so two
-- identical POSTs are two independent samples and every difference #65 sees is
-- a mixture it cannot decompose. These tables hold that measurement.
--
-- The mixture is not hypothetical arithmetic. #65's design is a paired McNemar
-- at delta = 0.20, and noise does not bias that test -- it dilutes it, so the
-- pairs it needs grow with the noise rate: recomputed today, 38 pairs at 5%,
-- 48 at 8.8%, 51 at 10%, 94 at 30%. Roughly 2.2 more pairs per point of noise
-- across that range, on top of a floor that is already 39 pairs at zero noise;
-- not proportional to the rate, which is why the break-even sits where it does
-- rather than anywhere near the origin. The 48 stored rows are enough only
-- while the rate stays under about 8.8%. Whether the corpus we already have
-- can answer #65 at all is therefore decided by a number nobody has ever
-- measured. That is what this schema is for, and it is why the tables are
-- built before the harness.
--
-- Two tables rather than one because a partial run must not be readable as a
-- complete one. noise_runs carries expected_cells and completed_cells, and the
-- reporting query refuses to emit a rate while completed < expected. That is
-- the "a read that fails is not zero" rule with a place to stand: the platform
-- kills an edge worker at 150 s wall clock with no chance to respond (the same
-- limit supabase/functions/analyze/budget.ts is written against), so a killed
-- worker leaves a claimed-unfinished cell behind, and a later invocation can
-- see it, rather than the run silently reporting 100% agreement over the six
-- cells that happened to finish. Folding the header fields into the cell rows
-- was the alternative and it has no way to express "expected": a count of rows
-- that exist can never be compared against the count that should exist.
--
-- No prompt text is stored, only sha256 of the two strings actually sent.
-- 20260905161000_replay_inputs_are_server_side.sql moved the system prompt off
-- public.analyses precisely because that table carries a table-level select
-- grant to authenticated that cannot be revoked one column at a time --
-- verified still true today: public.analyses grants SELECT to authenticated at
-- table level and is narrowed by one RLS policy, while public.analysis_prompts
-- has no client grant at all. Echoing the prompt back into a second table for
-- debugging convenience would rebuild the exposure that migration exists to
-- remove. The hashes are enough to prove both replicates of a row sent
-- identical bytes, which is the only thing the measurement needs them for.

create table if not exists public.noise_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Frozen before the first call. The table this run draws from grows 15-28
  -- rows a day; a denominator that moves while the run is in flight lets the
  -- stopping time choose the answer.
  --
  -- Measured 2026-09-09 on public.analysis_prompts: 15 rows written on
  -- 2026-09-07 and 28 on 2026-09-08, which are the only two complete days the
  -- table has existed (first row 2026-09-06T07:55:24Z), and 23 rows in the
  -- trailing 24 hours. Against a standing population of 48 that is a
  -- denominator moving by roughly half its own size per day, so "freeze it" is
  -- not a formality here: an operator who reruns until the answer looks right
  -- would be choosing the answer, and nothing in the stored rows would record
  -- that he had.
  population_frozen_at timestamptz not null,
  arm text not null check (arm in ('search_free', 'fallback_surgery', 'search_on')),
  reps smallint not null check (reps between 2 and 5),
  expected_cells integer not null check (expected_cells > 0),
  completed_cells integer not null default 0 check (completed_cells >= 0),
  failed_cells integer not null default 0 check (failed_cells >= 0),
  -- Measured from usage on every response, not counted in calls. A call count
  -- cannot bound spend when max_tokens is 8000 and thinking is billed as
  -- output.
  budget_input_tokens bigint not null,
  budget_output_tokens bigint not null,
  spent_input_tokens bigint not null default 0,
  spent_output_tokens bigint not null default 0,
  -- 'dry' never calls the model. 'running' -> 'done' | 'aborted' | 'paused'.
  -- An operator stops a chained run with one UPDATE to 'paused'; the next hop
  -- reads it and does not fire.
  status text not null default 'dry'
    check (status in ('dry', 'running', 'paused', 'done', 'aborted')),
  abort_reason text,
  chain boolean not null default false,
  chain_hops integer not null default 0,
  max_chain_hops integer not null default 0,
  version text not null,
  notes jsonb,

  -- The reporting gate is "completed + failed >= expected", so these three
  -- columns are the whole of what stands between a half-finished run and a
  -- published rate. They are counters the harness increments, not counts it
  -- recomputes, and there are two ways to increment one twice: a stale claim
  -- re-run after the staleness window, and a chained hop that re-commits the
  -- batch before it. Either opens the gate while ok cells are still missing,
  -- and the rows still missing are the ones that needed a retry, which are the
  -- unstable ones -- so the rate that escapes is biased low, the direction that
  -- lets #65 read a real regression as noise. Bounding the sum turns the double
  -- count into a failed UPDATE: the run stays visibly unfinished and the gate
  -- stays shut, instead of a number nobody can tell is wrong.
  constraint noise_runs_cells_accounted_check
    check (completed_cells + failed_cells <= expected_cells)
);

comment on table public.noise_runs is
  'One repeat-run of the stored analyst prompts. Header only: frozen population, arm, measured token spend, and whether the run finished. Service role only: no client reads these.';

create table if not exists public.noise_cells (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.noise_runs(id) on delete cascade,
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  rep smallint not null check (rep >= 1),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,

  -- The shape actually sent, recorded rather than inferred later. The row in
  -- analysis_prompts stores system, user and model and nothing else; every
  -- other field of the request is reconstructed from today's code, and a
  -- future reader must be able to see which reconstruction ran without
  -- reading a git history to find out what the constants were that week.
  shape text not null check (shape in ('search_free_inline', 'structured', 'search_on')),
  effort text not null,
  max_tokens integer not null,
  tools_present boolean not null,
  schema_in_prompt boolean not null,
  -- 'v44' (2617-char schema suffix) or 'v48' (2811-char, gained rules_applied),
  -- or 'none' for the three rows that never carried a schema in their text.
  --
  -- Measured 2026-09-09 over the 48 joined rows, slicing the stored user text
  -- from the marker "\n\n最終回答は<json>タグ内に" to end of string: 41 rows at
  -- 2617 chars, md5 5d3d5538fb27e74b37af2babeb2e2af4, none of them containing
  -- rules_applied; 4 rows at 2811 chars, md5 5cfa2b6d1d26cf322bc5b3142929a7bc,
  -- all four containing it; 3 rows with no marker at all, which are exactly the
  -- 3 rows whose analyses.mode is 'technical_only'.
  --
  -- This is a free text column and not a check constraint on purpose. The era
  -- is a fact about bytes written weeks ago, and a fourth era can appear in the
  -- corpus at any time without this migration being touched; a constraint would
  -- turn "we met a suffix we do not recognise" into a write that fails, losing
  -- the cell that would have told us. An unrecognised suffix is recorded as
  -- 'unknown' and reported: say what happened, never silently drop it. The
  -- status column below is checked, and goes the other way for the reason
  -- given there -- its vocabulary is this harness's own, so a value outside it
  -- is a bug in the writer and not a discovery about the corpus.
  schema_era text not null,
  -- The bytes that went on the wire. Two replicates of one row must match.
  system_sha256 text not null,
  user_sha256 text not null,

  -- claimed | ok | http_error | parse_failed | missing_keys | refusal
  -- | truncated | timeout | pause_exhausted | aborted
  --
  -- 'claimed' is the default because the row is inserted before the model is
  -- called -- see the unique constraint at the foot of the table -- and none of
  -- the nine terminal values is true of a cell nobody has answered yet. Left
  -- without a default, the claiming INSERT has to name one of the nine anyway,
  -- and the only one that reads as data is 'ok': a worker killed at the 150 s
  -- wall clock would then leave behind a row that says a call succeeded, with
  -- no answer in it, and the projection turns a null signal into a WAIT. That
  -- is the same downward bias the paragraph below is about, arriving through
  -- the schema instead of through the parser. The default is the fix, and the
  -- check keeps a later hand from inventing a tenth value that nothing counts.
  -- metric.ts's CellStatus is the finished vocabulary and does not carry
  -- 'claimed'; a claimed cell is not report input, and while any remain the
  -- gate above is shut by construction.
  --
  -- Checked here where schema_era above is deliberately not, because they are
  -- not the same kind of column. schema_era describes bytes written weeks ago
  -- by code nobody controls now, so a value we have never seen has to be
  -- recordable. status is written by this harness out of a list this harness
  -- owns, so a value outside it is a bug in the writer -- and a write that
  -- fails leaves the cell unfinished, which the gate already refuses to count.
  -- Losing the row is the safe direction there; refusing the write is the safe
  -- direction here.
  --
  -- Anything but 'ok' leaves BOTH numerator and denominator. It is never a
  -- WAIT: normalizeAnalysis coerces an unreadable signal to "WAIT" and an
  -- unreadable confidence to 0, so a harness that reads only the normalised
  -- object scores every parse failure as agreement-with-WAIT and reports a
  -- floor lower than the truth. The 45 search-derived rows are the ones at
  -- risk, because their field contract is prose in the prompt and nothing
  -- enforces it.
  --
  -- Both coercions read today in supabase/functions/analyze/index.ts: the
  -- signal falls back to "WAIT" when it is not one of BUY/SELL/WAIT, and the
  -- confidence is clampInt(source.confidence, 0, 100, 0) -- a default of zero,
  -- not a failure. A broken response therefore lands as "a WAIT at confidence
  -- 0", which is indistinguishable from a deliberate stand-aside, and a floor
  -- biased downward is the direction that would let #65 mistake real rulebook
  -- damage for noise. Measured 2026-09-09: 45 of the 48 rows are search-derived
  -- (analyses.mode = 'full', all 45 carrying the inline schema in their prompt
  -- text), so on 45 of 48 rows nothing but prose asks for those keys.
  status text not null default 'claimed'
    check (status in ('claimed', 'ok', 'http_error', 'parse_failed',
                      'missing_keys', 'refusal', 'truncated', 'timeout',
                      'pause_exhausted', 'aborted')),
  http_status integer,
  stop_reason text,
  -- Populated only when stop_reason = 'refusal'; null for every other value.
  stop_details jsonb,
  error_slice text,

  -- The model's own answer, read from the raw parsed JSON before any
  -- normalisation, so that a missing key is visible as a missing key.
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

  -- 'ok' is the only value a rate is ever computed from, so it has to mean the
  -- call came back and was read. A cell claimed and then abandoned keeps
  -- 'claimed' and a later invocation can see it; a cell marked 'ok' with no
  -- finish time and no answer in it is refused outright. classifyCell returns
  -- 'ok' only when the response parsed and carried all 20 required keys, so
  -- this can fire on nothing but a harness bug -- and it fires at write time,
  -- where somebody notices, rather than at report time, where an empty cell
  -- would be scored as one more agreement-with-WAIT and quietly lower the
  -- floor.
  constraint noise_cells_ok_is_answered_check
    check (status <> 'ok'
           or (finished_at is not null
               and raw_signal is not null
               and raw_confidence is not null)),

  -- The claim. A cell is inserted before the model call, not after it, so this
  -- constraint is what stops two invocations of a chained run from both
  -- spending on the same replicate: the second INSERT ... ON CONFLICT DO
  -- NOTHING returns no row and that invocation knows it does not own the cell.
  -- An advisory lock was the alternative and it dies with the worker, which is
  -- the exact moment the protection is needed.
  unique (run_id, analysis_id, rep)
);

comment on table public.noise_cells is
  'One replay of one stored prompt: the shape sent, the sha256 of the two strings sent, the raw pre-normalisation answer, and a status that says whether this cell is a measurement at all. Service role only: no client reads these.';

-- The two reads the harness makes on every invocation: "how much of this run is
-- left" and "which cells failed". Both are run-scoped and both filter on
-- status, so one composite index serves them; the unique constraint above
-- already covers lookup by (run_id, analysis_id).
create index if not exists noise_cells_run_idx on public.noise_cells (run_id, status);

-- One dry run authorises ONE spending run, enforced by the database rather
-- than by a read-then-write in the function.
--
-- The function checks, before creating a spending run, that no run already
-- cites this dry_run_id. That check is a SELECT followed by an INSERT, and the
-- gap between them is not theoretical here: the operator fires a run with
-- `select net.http_post(...)`, which returns a request id immediately and
-- leaves the response body to be read out of net._http_response afterwards, so
-- there is a window of up to the function's whole 130-second wall clock in
-- which the operator has no evidence the run was created. That window is
-- exactly when a second `select net.http_post(...)` gets typed, and two
-- accepted creations means the population is bought twice -- the cells do not
-- collide, because the unique key above is scoped to a run_id and these are
-- two different runs.
--
-- Partial on purpose. A 'dry' row carries no dry_run_id, and an 'aborted' or
-- 'done' run has stopped spending: re-authorising a finished dry run to start
-- a fresh attempt after an abort is a legitimate operator move, and a total
-- index would forbid it. What must never happen is two runs spending against
-- one authorisation AT THE SAME TIME, which is what 'running' and 'paused'
-- name.
create unique index if not exists noise_runs_one_spend_per_dry_run
  on public.noise_runs ((notes->>'dry_run_id'))
  where status in ('running', 'paused');

-- RLS with no policy denies every non-service role, and the service role
-- bypasses RLS. There is no client path to these rows, and no grant to
-- service_role is needed or given. Expect rls_enabled_no_policy to appear as a
-- new INFO advisor finding on both tables: that is the intended state, the
-- same one analysis_prompts has carried since 20260905161000 -- confirmed in
-- production today, that table has RLS enabled, zero policies, and no grant to
-- anon or authenticated.
alter table public.noise_runs enable row level security;
alter table public.noise_cells enable row level security;
revoke all on public.noise_runs from public, anon, authenticated;
revoke all on public.noise_cells from public, anon, authenticated;
