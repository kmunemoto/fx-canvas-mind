-- Measure the floor with the same ruler: a third arm on version_compare_cells.
--
-- 20260910180000_freeze_the_candidate_before_measuring_it.sql built a two-arm
-- comparison: 'live' and 'candidate'. Stage A counted how often the two arms
-- disagreed and compared that rate against a floor borrowed from #64 —
-- 10/48, 20.83% — to decide whether the change was material at all.
--
-- WHY THAT COMPARISON WAS NOT SOUND, AND WHY IT IS BEING PAID TO FIX.
--
-- #64 measured its floor by replaying the STORED prompt bytes. The rules block
-- in those bytes was rendered RANKED: every rule line carried a marker saying
-- whether that rule fitted the market of that minute, computed from the
-- indicators of that minute. This harness cannot produce those markers for the
-- candidate's rules — they come from different past regimes, and recomputing a
-- marker today would compare against today's market — so BOTH arms are
-- re-rendered WITHOUT them. The rate stage A measures and the floor it was
-- compared against therefore came from two different prompt shapes.
--
-- docs/VERSION_COMPARISON.md section 5 already recorded that the unranked floor
-- was UNVERIFIED and plausibly HIGHER, because the markers that were removed
-- were confidence-bearing text pinning some rules to "a different regime". If
-- the true unranked floor exceeds 20.83%, stage A was comparing against a floor
-- that is too low (material too easily) and stage B's 75-row target was an
-- underestimate. Both errors push toward PROMOTING a rulebook.
--
-- THE FIX IS A CONCURRENT CONTROL ARM. The frozen LIVE book is replayed a
-- second time, as a byte-identical request, on the same rows and the same day:
--
--   'live'      the frozen live book, re-rendered unranked (the reference)
--   'candidate' the frozen candidate book, re-rendered unranked
--   'live_b'    the frozen LIVE book again — the control
--
-- Per row that gives two paired binary observations: whether the candidate
-- disagreed with live, and whether live disagreed with ITSELF. The second is
-- the floor, measured rather than assumed, and the verdict is an exact McNemar
-- on the pair. The reasoning, the discordant-count orientation and the
-- correlation induced by the shared 'live' arm are all in
-- supabase/functions/version-compare/pairing.ts.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH:
--
--   * The freeze. `rulebook_candidate_freezes` stores ONE live book and ONE
--     candidate book, and the control arm replays the live book that is already
--     stored there. Freeze d066f7b9-c96c-4315-a65b-5a11a2d189d3 (frozen_at
--     2026-09-10T15:15:05.350Z, live v8 / 3 rules, candidate base_version 8 /
--     4 rules) stays valid and is still the object a run names. Nothing about
--     a third arm changes what was frozen; it changes how many times one of
--     the frozen books is sent.
--
--   * The unique key on the cells. It is already (run_id, analysis_id, arm) —
--     verified below rather than assumed — so a third row per analysis is
--     admitted without any change to it.
--
--   * Every other control: RLS with no policy, service_role only, the
--     write-once seal, the time-series split trigger, the one-spend-per-dry-run
--     index. All unchanged.
--
-- The cost is real and is not hidden: three arms instead of two is roughly half
-- again the billable calls per row. The owner has decided that measuring the
-- floor is worth it, because the alternative is a verdict whose comparator was
-- measured on a prompt nobody in this experiment sends.

-- ---------------------------------------------------------------------------
-- 1. Widen the arm vocabulary
-- ---------------------------------------------------------------------------
--
-- A CHECK constraint cannot be edited in place, so it is dropped and recreated.
-- `drop constraint if exists` followed by `add constraint` under the SAME name
-- makes the pair re-runnable: a second application drops what the first added
-- and puts back the identical definition. The name is the one Postgres itself
-- generated for the inline check in the 20260910180000 migration, confirmed
-- against production before this file was written, so `if not exists` on the
-- table there and this statement here agree about which object they mean.
--
-- Widening a CHECK can never fail on existing rows, and there are none: the
-- cells table is empty (verified 2026-09-10). The one run that exists,
-- e6a97341-69a4-443f-b877-5eed16d4ec34, was created under the two-arm design
-- and has been marked status='aborted', abort_reason='superseded_by_control_
-- arm_design'; it counted 28 of 160 cells in dry mode and spent nothing.

alter table public.version_compare_cells
  drop constraint if exists version_compare_cells_arm_check;

alter table public.version_compare_cells
  add constraint version_compare_cells_arm_check
  check (arm in ('live', 'candidate', 'live_b'));

comment on column public.version_compare_cells.arm is
  'Which book was spliced into the stored system prompt for this call. ''live'' and ''candidate'' are the frozen books, both re-rendered UNRANKED so the only difference between them is the rule list. ''live_b'' is the CONTROL: the frozen live book again, as a byte-identical request, so that one book''s self-disagreement is measured on the same rows and the same rendering instead of borrowed from a run against differently rendered prompts. A row''s three cells must agree on user_sha256; live and live_b must agree on rules_sha256 AND system_sha256; candidate must differ from live on rules_sha256.';

-- ---------------------------------------------------------------------------
-- 2. Verify the unique key admits a third row per analysis
-- ---------------------------------------------------------------------------
--
-- The claim being relied on is that `unique (run_id, analysis_id, arm)` already
-- has room for three arms. That is checked here rather than assumed, because
-- the whole design rests on it and a key that had been narrowed to
-- (run_id, analysis_id) at some point would turn the control arm into a
-- constraint violation on the first cell of the first run — after the freeze,
-- after the dry run, and with an operator watching a 500.
do $$
declare
  cols text;
begin
  select string_agg(a.attname, ',' order by k.ord)
    into cols
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.version_compare_cells'::regclass
     and c.contype = 'u'
   group by c.oid
  having string_agg(a.attname, ',' order by k.ord) = 'run_id,analysis_id,arm';

  if cols is null then
    raise exception
      'version_compare_cells has no unique key on (run_id, analysis_id, arm); the control arm cannot be claimed per (row, arm) without it';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Correct the comments the third arm made wrong
-- ---------------------------------------------------------------------------
--
-- The comment on version_compare_runs said "One paired live-vs-candidate
-- replay". It is now three arms, and one of them is a control; a reader who
-- took the old sentence at face value would count two cells per row and
-- conclude a complete run was a third short. The comment on the cells table
-- said "under one rulebook", which is still true of a cell but says nothing
-- about which of three.
--
-- expected_cells gets a comment of its own for the same reason: the 20260910180000
-- migration documents it inline as "rows x 2", that file is applied and must not
-- be edited, and a column comment is the only place the correction can be read
-- from the database itself.

comment on table public.version_compare_runs is
  'One replay of a frozen population under three arms — the frozen live book, the frozen candidate book, and the frozen live book a SECOND time as a control — against one freeze. Header only. Service role only: no client reads these.';

comment on table public.version_compare_cells is
  'One replay of one stored prompt under one arm: which book (or which of the two identical live sends), the digests of what was sent, and the raw pre-normalisation answer. Service role only: no client reads these.';

comment on column public.version_compare_runs.expected_cells is
  'rows x 3, one cell per arm. The inline comment in the 20260910180000 migration says rows x 2; that file is applied and immutable, and this is the correction. The reporting gate is completed_cells + failed_cells >= expected_cells, so a run still counted against the old number would report two thirds of a population as a complete one.';

-- ---------------------------------------------------------------------------
-- 4. An aborted run is finished
-- ---------------------------------------------------------------------------
--
-- The function refuses to resume or report on an aborted run, and this is the
-- floor under that. The reason it is worth a trigger rather than a comment is
-- the run that already exists: e6a97341-69a4-443f-b877-5eed16d4ec34 was created
-- under the two-arm design, its notes carry an expected_cells of 160 for a
-- population of 80 rows, and it was aborted precisely because the design under
-- it changed. Flipping it back to 'running' with one UPDATE would hand the
-- three-arm runner a header whose arithmetic is one arm out of date.
--
-- 'aborted' is the only terminal status made durable here. 'done' is left
-- alone: a done run legitimately gets its counters recomputed by report mode,
-- and there is no path in the function that moves it back to running.
--
-- THE TRIGGER IS SPELLED DIFFERENTLY FROM THE FUNCTION ON PURPOSE, and a
-- reviewer has already read it once as a slip. 20260910180000 names every one
-- of its pairs this way: function `..._respect_the_split` / trigger `..._split`,
-- function `..._seal_is_write_once` / trigger `..._seal_write_once`, function
-- `..._are_immutable` / trigger `..._no_update`. The trigger carries the short
-- form so that `\d version_compare_runs` lists three names that read as a list
-- of rules rather than three repetitions of the function list. Making the two
-- identical here would be the thing that breaks the convention.
create or replace function public.version_compare_runs_aborted_is_final()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'aborted' and new.status is distinct from old.status then
    raise exception
      'version_compare_runs %: an aborted run is finished; it cannot be moved to %. Take a new dry run.',
      old.id, new.status;
  end if;
  return new;
end;
$$;

revoke all on function public.version_compare_runs_aborted_is_final() from public, anon, authenticated;

drop trigger if exists version_compare_runs_abort_is_final on public.version_compare_runs;
create trigger version_compare_runs_abort_is_final
  before update of status on public.version_compare_runs
  for each row execute function public.version_compare_runs_aborted_is_final();
