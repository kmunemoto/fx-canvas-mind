# 法則探し: the small trial's design (spec 19 step 3)

This file fixes how the TS study of `research/lawsearch-spec.md` is cut into modules for the small trial: the modules
and their owners, every exported signature, the data structures, the run modes, the planted errors, which hand
examples the trial must pass, and the synthetic runs. It decides no rule. The spec (with 付録 A) is the only
authority; where a builder finds this file and the spec disagree, the spec wins and the builder reports it. Where the
spec needs a reading that the trial must check before step 4, it is listed in 11 (open points). It is not settled
here.

Companion files (all written before any builder starts):

| file | what |
|---|---|
| `research/lawsearch-types.ts` | every shared type and interface (no logic; passes `deno check`) |
| `research/lawsearch-rules.ts` | the rule constants the modules share (values only; passes `deno check`) |
| `research/lawsearch-dump.md` | the files both implementations write for comparison, and spec 17.2's comparison rules |
| `research/lawsearch-py-design.md` | the Python layout (PY1, PY2), for builders who do not read any TS |

Frozen and never edited (checked by sha256, `lawsearch-const.ts` FILES): the spec, `research/lawsearch-hand.json`,
`research/lawsearch-hand.md`, `research/ledger/lawsearch-candidates.json`, `research/ledger/spread-hours-h1.csv`, and
the sha256 constants of `research/lawsearch-const.ts`. No module changes `trend-data.ts` (walk5 included),
`ownerhold-data.ts`, `quotes.ts`, `market-hours.ts`, `spreadhours-lib.ts`, `bigflow-lib.ts` or the app functions.
The one change outside `research/lawsearch*` is a single export added to `research/money-stats.ts` (6.3), which spec
8.5 asks for.

(C4g, 2026-11-10; the lead's G1) Two more changes outside `research/lawsearch*`, so that the program reads the run's
files once (7.7 gate 3, 12.7):
- `ownerhold-data.ts`'s `Source` gained an optional field `read?: (path: string) => Promise<string>`;
- `trend-data.ts`'s `readFile` reads a file's text through `(src.read ?? Deno.readTextFile)(path)`.

With no `read` given, which is every caller but `lawsearch.ts`, each function is the same as before; an unbound call of
`Deno.readTextFile` that way was tested (the C4g integrator). Their other callers (the weekly (b) routine and other
research) were NOT run. `quotes.ts` is not edited, but `lawsearch-frozen.ts` freezes its objects `GMO_SYMBOLS` and
`GMO_INTERVALS` at run time in every realm of this program (12.7 G3). That changes nothing in any other program's
process.

---

## 1. Scope of the small trial

- **Trials (12)**: `m15.E04.F00`, `m15.E04.F01`, `m15.E26.F00`, `m15.E26.F01`, `m15.S01`, `m15.B06` and the same six
  on `h1` (`lawsearch-rules.ts` TRIAL_STEP3). Also the blind table (spec 8.1) and its 10 measure rows per timeframe
  (8.7, the blind rows only).
- **Stages**: stage 0, stage 1 and stage 2 on synthetic runs only. Stage 2 runs with κ = 1 (the calibration on seeds
  1101–1500 is step 7) and without g (spec 9's g comes from the 100 N runs of step 4). Both are written into
  `config.json` as "not run yet" (11 O-4).
- **TS ↔ Python**: every row and number of `lawsearch-dump.md` agrees under spec 17.2's rules.
- **Hand examples**: the 103 examples (with required keys) of 9 pass in TS and in Python. The other 41 examples
  report "skip" until their items are built.
- **Checks**: spec 15 (all of it that touches these trials), and the planted errors of 16 that touch them (8).
- **No real data**: no module reads `research/.cache`. No job has `--allow-net`. The real-data modes refuse with exit
  2 before they read any file (7.7).
- **The frame for later**: the registry is keyed by the ledger's trial ids. `itemOf` and `filterOf` throw
  `NOT BUILT: <id>` for every item not written yet, and every mode refuses a trial that is not built before it reads a
  bar. Adding an item later means one `ItemDef` (its build, its dump columns, the hand keys it unlocks in 9), and
  nothing in the other modules changes.

---

## 2. Conventions (every module)

### 2.1 Arrays

| what | type | 無し |
|---|---|---|
| prices, indicator values, means | `Float64Array` | `NaN` |
| times (UTC ms) | `Float64Array` (exact integers) | — |
| points (spec 2: 1 point = 0.1 pip), m, PL | `Int32Array` | — |
| directions | `Int8Array`, 1 buy / −1 sell | — |
| per-bar truth with 無し (conditions, F, crosses) | `Tri` = `Int8Array`: 1 true, 0 false, −1 無し | −1 |
| flags | `Uint8Array` 1/0 | — |
| bar indices, table rows | `Int32Array` | −1 = none |

- The app functions return `Array<number | null>`. `lawsearch-ind.ts` converts with `toF64` (null → NaN) and never
  hands an `Array` to another module.
- A comparison that the spec makes on doubles stays on doubles (3.1, 21.5: no tolerance). A comparison on points
  stays on the Int32 values.

### 2.2 Indices and order

- Pair index `pi` = position in `PAIRS` (`lawsearch-const.ts`): USD/JPY 0, EUR/JPY 1, AUD/JPY 2, EUR/USD 3,
  AUD/USD 4.
- A bar index is its number from spec 2: 0 is the first usable bar at or after S0, and gaps are closed up. Stage 1
  loads [S0, SPLIT), so its indices equal stage 0's for every bar it has.
- **Row order** (21.5): T ascending, then pi, then buy before sell, then the signal row before the blind row (then 15
  minutes before 1 hour, for D_AB only). Every table is built in this order once. Every sum of 8–11 runs over rows
  ascending, so no module sorts again.
- **Stratum id** (8.2, 21.5 層の並び): `((pi × 2 + (d === 1 ? 0 : 1)) × 24 + hour) × 4 + season`, where hour is the
  UTC hour of T (late: of T + 15 min) and season is the `SeasonGroup` (0 both winter, 1 both summer, 2 NY only summer,
  3 London only summer). Ascending ids are the spec's stratum order.
- **rowKey** (`lawsearch-trade.ts`): `T × 16 + pi × 2 + (d === 1 ? 0 : 1)`. It is exact below 2^53. The late table
  is keyed by the signal's T, not T + 15 min.
- **Week** `wk(t)` (`lawsearch-const.ts`) of T. **4-week block**: `Math.floor((wk − w0) / 4)` with w0 =
  `W0.first` 2817, `W0.second` 2889 (`lawsearch-rules.ts`). Never money-stats' clustered (spec 8.5).

### 2.3 Errors and exit codes

- `stop(what)` (`lawsearch-bars.ts`) throws `Error("STOP: " + what)`. It is used for spec 2's value stops, spec 15's
  data stops, and the "must be 0" counts (no blind, late past the end). (C3, 2026-11-05) The no-blind count includes
  stage 0's: every trial's noBlind of either half above 0 stops the run in stage 0 (7.4).
- `notBuilt(what)` (`lawsearch-items.ts`) throws `Error("NOT BUILT: " + what)`. `isNotBuilt(e)` tests the prefix.
- `refuse(what)` (`lawsearch.ts`) prints `REFUSED: <what>` and exits 2.
- Exit codes of `lawsearch.ts`: 0 every check passed; 2 refused by a gate; 3 a spec 2 / 15 check failed or a STOP
  was raised (the run continues through the stages and writes its dumps, then exits 3; 7.7); 4 a required hand
  example failed; 1 any other crash. (C3, 2026-11-05) "Continues" stops before stage 2: a failed check of the gate,
  stage 0, stage 1 or stage 1's end keeps stage 2 closed (7.7; `lawsearch-dump.md` 11.14). The Python uses the same
  codes (`lawsearch-py-design.md` 2), plus 5 for a TS–Python mismatch.
- (C4f, 2026-11-08; the lead's H3) **Exit 6** of `lawsearch.ts`: a universe changed after it was loaded. 7.7's guard
  found that a stage's universe, or the checks' snapshot of it, no longer has the digest taken at the load. The
  guard throws `CHANGED: …`. `main()` prints that line, removes the run's dump folder and exits 6. The pipeline made
  that folder at its start, after removing any older one, so no file of a run whose inputs changed under it is left.
  - `SHARED: …` (7.7's identity check) counts as "any other crash", with exit 1. So does a write into a frozen trial
    definition or `ExclCtx` (a `TypeError`), and so does a write through the avoid table's own `add`, `delete` or
    `clear` (`Error: the avoid table is read-only: … refused`). Such a run writes no `checks.csv` and no print.txt.
    Its folder keeps what was written before the error: for the plants `trialStashE04` and `avoidStashR3`, which
    throw in stage 0's main part, only `config.json` (8).
  - The comparator's 6 means something else. `lawsearch-check.py --run` and `--compare` exit 6 on a stop of spec 8.5
    (`lawsearch-dump.md` 10, `lawsearch-py-design.md` 2), which the sentence above leaves out. So the Python uses
    the same codes as the TS for 0–4 only. Its 5 and 6 are its own, and the TS's 6 is the TS's own. The yml reads
    each program's exit in a step of its own: the TS run step wants `matrix.want`, a plant wants its listed exit, and
    the Python step fails on any exit but 0. So CI never takes one program's 6 for the other's. A person reading a
    log must look at which program printed it. Whether the TS's case should get another number is open (11 O-16).
- (C4g, 2026-11-10; the lead's G4, which answers O-16's question) **Exit 7** replaces the TS's 6. A universe that
  changed after its load (`CHANGED: …`) now ends the run with exit 7. The run still removes its dump folder first, and
  its line is `exit 7: a universe changed after it was loaded; <folder> was removed`. The TS's codes are now 0–4 and 7,
  and the Python's are 0–6, so no number means two things. The yml's matrix wants `seriesStashE04:7` (7.8 syn step 3).
  The C4f bullets above keep their text as the record of C4f.
  - Exit 1 also covers, since C4g:
    - a refused permission (`NotCapable: Requires … access`). For example, any read of the environment after
      `readSettings` has revoked it (7.7), as in the plant `rp2EnvE04` (8);
    - a `SHARED` line from the allow-list that now checks every check run's task (`assertTaskAllowed`, 7.3);
    - a write into a frozen rule constant (`lawsearch-frozen.ts`, 12.7 G3);
    - a frozen `Set` that `readOnlySet` did not make read-only (5.3).
    - (C4h, 2026-11-11) a check's worker that is not sandboxed (`… not sandboxed (granted here: …)`, 12.9 F2), and a
      main-realm module that tries to change `Worker.prototype`, `EventTarget.prototype` or `globalThis.Worker` (a
      `TypeError` at its load, 12.9 F7).

    Such a run writes no `checks.csv` and no print.txt, as before.
  - A run without `--unstable-worker-options` stops at its first check run. Deno 2.9.6 prints `Unstable API
    'Worker.deno.permissions'` and the process exits 70. The program cannot catch that (tested by the C4g integrator).
    It is fail closed, and the yml always passes the flag (7.8).

### 2.4 Plants, environment, files

- A planted error (8) is one name in `PLANTS` (`lawsearch-rules.ts`). Only `lawsearch.ts` reads `LS_PLANT` from the
  environment. Every library function that has a plant takes `plant: string` as an argument (default `""`) and
  never reads `Deno.env`.
- File I/O: `lawsearch-bars.ts` reads the GMO files (through `loadTf`, plus its own raw read for the value forms).
  `lawsearch-gen.ts` writes a run. `lawsearch-dump.ts` writes the dumps. `lawsearch-hand.ts` reads the hand JSON and
  writes temporary GMO files under `research/out/lawsearch/hand-tmp/`. `lawsearch-checks.ts` reads the rules files
  (sha256) and the raw files (13 (iv)). `lawsearch.ts` reads the ledger. Every other module is pure.
- Runs write under `research/out/lawsearch/` (git-ignored; inside `--allow-read=.`). A run never reads
  `research/.cache`.
- (C4g, 2026-11-10; the lead's G1; 7.7, 12.7) The environment and the run's files:
  - `lawsearch.ts` reads every setting it knows (`ENV_NAMES`, 15 names: `MODE`, `LS_PLANT`, `CUT_MAX`, `WORKERS`,
    `HAND_IDS`, `TRIALS`, `OUT`, `GEN`, `SEED`, `FLIP`, `STRENGTH`, `RUN`, `G_FILE`, `KAPPA_DELTA`, `KAPPA_PL`) once,
    as `main()`'s first statement, into a map that only `env()` reads. It then revokes the environment permission for
    the whole process (`readSettings`). After that, any `Deno.env` call in the main thread or in a worker started later
    is refused (`NotCapable`, exit 1). (C4h, 2026-11-11) The checks' workers never hold env at all, being started with
    "none"; an inheriting worker would lose it at the revoke too (7.7's C4h bullet).
  - In `syn` and `walkfiles` modes the run's GMO files are read from the disk once, at gate 3 (`treeBytes`,
    `lawsearch-gen.ts`). The manifest's tree digest is taken of exactly those bytes. `loadPairTf` (through `src.read`,
    `lawsearch.ts` `memSourceOf`) and the retrace of 13 (iv) (`retraceCheck`'s `read`) read those bytes, never the disk.
  - The hand runner still loads its temporary GMO files from the disk: its `Source` has no `read`.
  - The checks' workers have no permission at all (7.3, 12.7): no file, no environment. (C4h, 2026-11-11) Each one tests
    that when it gets its first message, against the main thread's own grants, and refuses to serve otherwise (exit 1;
    `lawsearch-sandbox.ts`, 12.9 F2).
  - The yml's walkfiles and syn steps narrow the write grant to the run's own folder (7.8).

### 2.5 Arithmetic

- Sums run oldest first (3.1), and over rows ascending (21.5). Never `reduce` from the right, and never re-sum in
  another order. A standard deviation is two-pass and divides by n − 1 (spec 3.1, 8.5, 21.5).
- Spec 3.2's orders are the code's orders: `100 * a / b` is `(100 × a) ÷ b`, a square is `x * x`, and EMA is
  `α × x + (1 − α) × prev` with `1 − α` taken from the double α.
- The zero rule `|x| < 1e−12` (`ZERO`) applies to the numbers of spec 8–11 only, in their final unit (Δ and a after ×
  100). It never applies to indicators, crosses or F.

### 2.6 Text

Identifiers and comments are in English. The only Japanese strings the programs make are the labels that the hand
examples fix (7.2) and `print.txt`'s notes. Labels contain no comma.

---

## 3. Modules, owners and dependencies

| module | owner | role | may import (study modules) |
|---|---|---|---|
| `lawsearch-types.ts` | designer (done) | types | — |
| `lawsearch-rules.ts` | designer (done) | constants | types |
| `lawsearch-bars.ts` | A | loading, value forms, mid, points, index, higher timeframe, day, seasons, holidays, spec 15 data checks, series edits for the checks | gen (GEN_START only), rules, types, const |
| `lawsearch-gen.ts` | A | the synthetic walk (14.1) written as GMO files; (C4g, 2026-11-10) `treeBytes`, the tree read once and kept for gate 3 (4.2) | rules, types, const |
| `lawsearch-ind.ts` | B | indicator arrays (the app functions, SMA oldest first, donchian, bigmove, crosses) | rules, types |
| `lawsearch-items.ts` | B | the registry: E04, E26, B06, F00, F01, S01 now (others throw); the ledger | ind, rules, types |
| `lawsearch-events.ts` | B | spec 5 (candidates) and spec 6 (①–⑥, ①b; holes; blind bars) | bars, ind, items, rules, types, const |
| `lawsearch-trade.ts` | C | spec 7, 8.1, 8.8; the follow-bar checks of 15 (C4g, 2026-11-10: split into `followValues`, run in its own worker, and `followCompare`, 6.1) | bars, events, rules, types, const |
| `lawsearch-stats.ts` | C | 8.2–8.6, t and p, z, medians, 95% points, κ | trade, rules, types, const |
| `lawsearch-select0.ts` | D | spec 9 (stage 0's counts, floor, same trial, groups, MDE, marks) | bars, events, items, rules, types, const; money-stats (tQuantile only) |
| `lawsearch-select.ts` | D | spec 10, 11, 13 | stats, trade, select0, rules, types, const |
| `lawsearch-checks.ts` | D | spec 15 (rules sha256, data, cut, poison, presence, h1Only, adds up, items' checks, print list) and 13 (iv); (C4f, 2026-11-08) the checks' inputs kept apart from the main run's: the snapshot, the identity check, the universe digest and the sealed task (7.3); (C4g, 2026-11-10) the task allow-list (`assertTaskAllowed`) and the comparison of the units' answers in the check's thread (`mismatchesOf`); `inPlace` removed (7.3) | bars, ind, items, events, rules, types, const; trend-stats, bigflow-lib (check-only) |
| `lawsearch-stage0.ts` | D | stage 0 as its own program (spec 9's import rule) | bars, ind, items, events, select0, checks, dump |
| `lawsearch-dump.ts` | D | writes `lawsearch-dump.md`'s files | types, rules, const |
| `lawsearch-hand.ts` | D | the hand runner | everything |
| `lawsearch.ts` | D | the program: modes, gates, the pipeline; (C4f, 2026-11-08) the guard of each stage's universe (`Guard`, 7.7); (C4g, 2026-11-10) the settings read once and env revoked (`readSettings`), the gate-3 bytes and the three loads from them (`memSourceOf`, `readOf`), the follow-bar checks' worker (`followInWorker`), exit 7 (7.7); (C4h, 2026-11-11) the grants it holds (`grantsHeld`), sent to every check's worker (12.9 F2) | everything (lockdown and frozen first) |
| `lawsearch-flip.ts` (written in C2; listed C3) | D | spec 14.2's flip conditions on the exact mirror (23.1), 7.9 | (C4g: lockdown and frozen first) const, rules, bars, gen, items, events, checks, stage0, trade, types |
| `lawsearch-par.ts` (written in C4b; listed C4c, 2026-11-07) | D | the worker pool (`WorkerPool`) that runs the units of the checks cut, poison and presence on `WORKERS` workers (7.3, 7.7, 12.1); (C4g, 2026-11-10) `checkPools`: a cut pool made for each cut run (deltas, T order, one target per job, no want) and a probe pool kept for the run, max(1, `WORKERS`) workers each, every worker with no permission (12.7); (C4h, 2026-11-11) every "universe" message carries the main thread's grants (12.9 F2) | checks and types (types only) |
| `lawsearch-par-worker.ts` (written in C4b; listed C4c, 2026-11-07) | D | one worker: answers each job with `lawsearch-checks.ts`'s `runUnitJob`; reads no file and no environment, writes nothing; (C4g) started with no permission and refuses to serve if any permission reads granted; imports the lockdown and the frozen constants first; a cut worker grows its universe job by job (`applyGrow`). (C4h, 2026-11-11) C4g's test queried each permission without a path, which reads "prompt" in a worker that inherited the program's `--allow-read=.` too, so it would have served; it now tests the main thread's own grants, path-scoped (`lawsearch-sandbox.ts`, 12.9 F2) | lockdown, frozen, checks, sandbox, types |
| `lawsearch-follow-worker.ts` (C4g, 2026-11-10) | D | the realm of one follow-bar check (spec 15 追う足): started by `lawsearch.ts` for one call with no permission, it gets the snapshot's timeframe and the rows' coordinates and answers `followValues` (6.1, 12.7); (C4h, 2026-11-11) it had no run-time test of its sandbox; it now answers an error, and computes nothing, when it holds one of the main thread's grants (12.9 F2) | lockdown, frozen, trade, sandbox, types |
| `lawsearch-lockdown.ts` (C4g, 2026-11-10) | D | the lockdown of a realm (delete-only in C4g): removes the permission-free channels between realms and processes from its globals and the Deno namespace; imports nothing; the first import of every entry point (12.7 G3); (C4h, 2026-11-11) the first module request, re-exports counted (12.9 F4); in the main realm only, it also freezes `Worker.prototype` and `EventTarget.prototype` and pins `globalThis.Worker` (12.9 F7) | — |
| `lawsearch-frozen.ts` (C4g, 2026-11-10) | D | deep-freezes every object exported by `lawsearch-const.ts` and `lawsearch-rules.ts`, and quotes.ts' `GMO_SYMBOLS` and `GMO_INTERVALS`, in every realm; the second import (C4h: module request) of every entry point (12.7 G3) | const, rules (types through them); quotes.ts |
| `lawsearch-audit.ts` (C4g, 2026-11-10) | D | not part of the program (no realm imports it): the hand job's static audits `graph`, `source` and `catch` over the realms' module graphs (`deno info --json`) and their source files (7.8 hand steps 10–12); (C4h, 2026-11-11) `graph` counts re-exports among an entry's first module requests (F4), and two more modes: `trigger`, every module of the graphs in a push path of `lawsearch.yml` or `lawsearch-audit.yml` (F5), and `relay`, the main realm's freeze (F7) (7.8 hand steps 13 and 14, 12.9) | — (`relay` evaluates the lockdown) |
| `lawsearch-sandbox.ts` (C4h, 2026-11-11) | D | the run-time test that a check's worker is sandboxed: `grantsHeld` (the main thread: each path-less permission name, and read and write on `.`, the run folder and the dump folder, that read "granted" there) and `refusalOf` (a worker: why it must not serve, when any of them, or any path-less name, reads "granted" in its own realm) (12.9 F2) | — (imports nothing) |
| `.github/workflows/lawsearch.yml` | D | CI | — |
| `.github/workflows/lawsearch-audit.yml` (C4h, 2026-11-11) | D | CI: the hand job's cheap audits and `MODE=hand`, run on a push that changes a module of the four graphs outside `lawsearch.yml`'s paths (7.8, 12.9 F5) | — |
| `research/money-stats.ts` (+1 export) | C | U(x, ν) of spec 8.5 | — |

(C4c, 2026-11-07) `lawsearch-candat-check.ts`, C4b's CI guard for `candidatesAt`, is deleted with `candidatesAt`
(7.8, 12 rule 2). `lawsearch.ts` imports `lawsearch-par.ts`; the worker module is not imported by any module but
started by the pool as a Web Worker (so `deno info` of a program does not list it), and it imports only
`lawsearch-checks.ts` (stage-0 safe) and the types.

(C4g, 2026-11-10) The program now has four entry points, one per kind of realm:
- `lawsearch.ts`, the main thread;
- `lawsearch-par-worker.ts`, the units' workers;
- `lawsearch-follow-worker.ts`, the follow-bar check's worker, started by `lawsearch.ts`;
- `lawsearch-flip.ts`, the flip judgement.

Each one's first two imports are `lawsearch-lockdown.ts`, then `lawsearch-frozen.ts`, so these two are evaluated before
any other module of the realm. Their order and their graphs are audited in CI (7.8 hand step 10).
(C4h, 2026-11-11; C4g's review, the lead's F4) That "so" held only for import lines: an ES module evaluates every
value module request in source order, re-exports (`export … from`, `export * from`) included, and C4g's audit counted
import lines only. A re-export above the lockdown ran its whole graph first, unseen (C4g's refuter: `lawsearch-events.ts`
then captured CacheStorage). The audit now counts every value module request in source order (`import type` and
`export type` skipped), from the source text and from `deno info`'s own parse, which must agree. So the lockdown, which
imports nothing, is evaluated first in every realm, then `lawsearch-frozen.ts`'s graph, then the rest. The par worker now
also imports the lockdown and the frozen constants (and, through them, `lawsearch-const.ts`, `lawsearch-rules.ts`,
`lib.ts` and `quotes.ts`).

Rules on the graph:

- It is acyclic, in the order rules → A → B → C → D. Nothing in A imports B, C or D. Nothing in B imports C or D.
- **Spec 9**: `deno info research/lawsearch-stage0.ts` must list none of `lawsearch-trade.ts`, `lawsearch-stats.ts`
  or `lawsearch-select.ts` (the CI job greps for them, 7.8). That is why stage 0's decisions are in their own module
  (`lawsearch-select0.ts`). It is also why `entryExitIndex`, `stratumOf` and the season functions are in
  `lawsearch-bars.ts`: stage 0 counts "no trade" and "no blind stratum" from bar times alone.
- External modules: `trend-data.ts` (loadTf, coarsen, keysFor, STEP_OF, walkOpen), `trend-labels.ts` (Bars,
  emptyBars, weekendOutOf), `ownerhold-data.ts` (Source, newLoadStats, gmoDayKey, keysOf, sound),
  `track-outcomes/quotes.ts` (GMO_SYMBOLS, GMO_INTERVALS, parseKlines, jstDayKey), `_shared/market-hours.ts`
  (isPossiblyClosed, barInsideClosure, nyOffsetMs), `lib.ts` (MINUTE, HOUR, DAY, WEEK, WEEK_OFFSET),
  `lawsearch-const.ts`, `spreadhours-lib.ts` (parseSpreadHours, seasonOf, slotOf, avoidKey, CSV_HEADER), the app
  functions of spec 17.1, `bigflow-lib.ts` (donchianState, in the checks only), and `money-stats.ts` (tQuantile and
  the new tUpperTail, in stats only).
  - (C4g, 2026-11-10) Also `trend-stats.ts` (`mulberry32` and `shuffle`, for `sampleOf`; in the checks only). The hand
    job's graph audit fails if any module but `lawsearch-checks.ts` imports `trend-stats.ts` or `bigflow-lib.ts`
    (7.8 hand step 10). The main thread's checks run them (12.7, the table of the checks).
  - `trend-data.ts`'s file read and `ownerhold-data.ts`'s `Source` gained an optional `read` (the header above).
- **Working in parallel**: each builder codes against the signatures below. Until another builder's module exists,
  a builder may put a local stub with the same signature in their own scratch folder (never in `research/`). The
  signatures are the contract. If one must change, the builder writes the change and the reason to the lead, and the
  lead updates this file.

---

## 4. Builder A: data and generator

### 4.1 `research/lawsearch-bars.ts`

```ts
import type { Source } from "./ownerhold-data.ts";
import type { Bars, Dir, EntryExit, LoadPurpose, LoadReport, Pair, SeasonGroup, Series, SeriesKey, TfKey, TfSet, Universe } from "./lawsearch-types.ts";

export const stop: (what: string) => never;                       // throws Error("STOP: " + what)

// ---- spec 2: the value forms (21.5 ファイルの形と値の読み方)
export interface ScanOut { elements: number; kept: number; unparseable: number; stops: string[] }
// one side of one day file, already JSON.parse'd and sound() (ownerhold-data): every element of data, per spec 2
export function scanBody(body: unknown, where: string): ScanOut;

// ---- spec 2: mid and points
export function midOf(bid: number, ask: number, pair: Pair, plant?: string): number;   // Number(((bid + ask) / 2).toFixed(d)); plant midHalfEven
export function pointsOf(v: number, pair: Pair, plant?: string): number;               // Math.round(v × 1000 | 100000); plant pointsTrunc (Math.trunc)
export function rawPointsOf(v: number, pair: Pair): number;                            // Math.round(v × mult); stop() when |v × mult − that| > POINT_TOL

// ---- spec 2: calendar (pure functions of t)
export function dayOf(t: number, plant?: string): number;      // D(t) as YYYYMMDD: (t + 3 h)'s UTC date, a Saturday → the Friday; plant daySatSplit
export function nySummer(t: number): boolean;                  // nyOffsetMs(t) === −4 h
export function londonSummer(t: number): boolean;              // [last Sunday of March 01:00, last Sunday of October 01:00) UTC
export function seasonGroupOf(t: number): SeasonGroup;
export function isGmoHoliday(t: number): boolean;              // (t + 3 h)'s UTC month-day is 12-25 or 01-01 (no Saturday rule)
export function hourOf(t: number): number;                     // UTC hour 0–23
export function stratumOf(pi: number, d: Dir, t: number): number;   // 2.2's id from hourOf(t), seasonGroupOf(t)

// ---- spec 2: series
export function seriesOf(pair: Pair, key: SeriesKey, b: Bars, plant?: string): Series;   // T, mid, points (raw ones checked), day
// hand examples of groups 3 and 4: the mid given as decimal strings; raw sides = the mid; fileKey −1
export function seriesFromMid(pair: Pair, key: SeriesKey, s: ArrayLike<number>, mid: ReadonlyArray<readonly string[]>, plant?: string): Series;
export function coarsenSeries(base: Series, key: SeriesKey, plant?: string): Series;    // trend-data coarsen on the raw sides, then midOf / pointsOf
export function htfIndex(base: Series, htf: Series, plant?: string): Int32Array;      // g(i): last g with s_g + step_g ≤ T_i, else −1; plant htfOpen
export function tfSetOf(tf: TfKey, pairs: Series[], plant?: string): TfSet;           // htf (1 h from m15, 4 h from h1) and g for each pair

// ---- spec 7 (times only; the trade module and stage 0 both use it)
export function entryExitIndex(s: Series, T: number, X: number): EntryExit | null;    // j: first start ≥ T and < X; x: close = X, else last start ≥ s_j with close ≤ X

// ---- loading (spec 2)
export interface LoadOpts { purpose: LoadPurpose; band: "real" | "syn"; plant: string }
export function loadPairTf(src: Source, pair: Pair, tf: TfKey, fromMs: number, toMs: number, o: LoadOpts): Promise<{ series: Series; report: LoadReport }>;
export function loadUniverse(src: Source, fromMs: number, toMs: number, o: LoadOpts): Promise<Universe>;   // 5 pairs × 2 timeframes, tfSetOf, problems
export function dataProblems(u: Universe): string[];          // spec 15 データ: the strings of every failed data check

// ---- series edits for the checks of spec 15 (new arrays; the input is never changed)
export function prefixSeries(s: Series, Tcut: number): Series;                          // bars with T ≤ Tcut (C4e: a copy holding those bars only; until C4e subarray views)
export function windowSeries(s: Series, from: number, to: number): Series;              // bars [from, to] (C4e: a copy; the follow-bar checks only; C4d: no longer the cut's)
// (C4e, 2026-11-08) cutTfSet removed: no module called it (below)
export function poisonSeries(s: Series, afterT: number, pips: number): Series;          // every bar with T > afterT: + pips, − pips, … alternately (bar by bar) on all 8 raw sides; mid, points re-derived
export function poisonBars(s: Series, idx: Int32Array, pips: number): Series;            // the listed bars only (the follow-bar checks)
export function deleteBars(s: Series, drop: (k: number) => boolean): Series;           // the bars with drop(k) false kept, renumbered
```

Behaviour that is not obvious from the signatures:

- **loadPairTf** runs in this order:
  1. It reads the raw day files of `keysFor(tf, fromMs, toMs)` (trend-data) for both sides. It applies `sound()` and
     `scanBody`, and counts `readFailures`, `unparseableRows` and `valueStops`.
  2. It computes `askLtBidByYear` from `parseKlines` of the same bodies. It concatenates them in key order and sorts
     stably by t. The last Ask row of each start counts. The year is the UTC year of the row's start.
  3. It calls `loadTf(src, pair, tf === "m15" ? "15min" : "1h", fromMs, toMs, newLoadStats(), weekendOutOf("inside"))`.
     The report takes `droppedAskLtBid` from `diag.crossed` and `sameStartBidRows` from `diag.repeated`.
  4. It checks Σ askLtBid num = `diag.crossed` and stops otherwise.
  5. It builds `seriesOf`, and counts `ohlcBad`, `dupStarts` and `bandBad`.

  When there are value stops, it calls `stop()` after the counts are made, so the report can be printed. A synthetic
  run's Source is `{ dir: <run>/gmo, fetch: false }`.
  - (C4g, 2026-11-10; the lead's G1) Steps 1 and 3 read a file's text through `src.read` when the Source has one
    (`(src.read ?? Deno.readTextFile)(path)`, here and in trend-data's `readFile`). `lawsearch.ts` gives a synthetic
    run's Source a `read` over the bytes read once at gate 3 (`memSourceOf`, 7.7). Those bytes are decoded as
    `Deno.readTextFile` decodes a file: UTF-8, invalid sequences replaced, a BOM kept (`ignoreBOM`). A path that is not
    among them is `NotFound`, which the loader counts as a read failure, as a missing file was. So the load reads the
    same text and gives the same values. The hand runner gives no `read` (2.4).
- **scanBody**, per data element:
  - An element that is not an object (null, string, number, array) is unparseable.
  - For the five names, a value of the right form is accepted. openTime is a string of ASCII digits only. A price is
    a string of ASCII digits with at most one `.`, and at least one digit.
  - The value is then `Number(str)`. When it is not finite, the row is unparseable.
  - A value of the wrong form is checked with parseKlines' `num()`: a number stays a number, a string becomes
    `Number(str)`, anything else is NaN. When the result is finite, the value goes to `stops`, as `"<where> #k <name>
    <JSON>"`. Otherwise the row is unparseable. Each value is checked on its own, so a row can hold both.
  - Every element is checked, including rows outside [fromMs, toMs).
- **seriesOf**: mid `midOf(b, a)` per side pair (o, h, l, c). Points of the mid come from `pointsOf`, and the raw
  points from `rawPointsOf`. `day[i] = dayOf(s_i)`. `fileKey` comes from `Bars.key`.
- **coarsenSeries**: convert the base Series back to `Bars` (its raw sides; `key` −1), call trend-data's
  `coarsen(bars, "1h" | "4h")`, then `seriesOf`. Index 0 is the first higher bar of the base series. The base starts
  at S0, so this is "S0 からの通し".
- **htfIndex**: the correct g(i) is the last higher bar g with `s_g + step ≤ T_i`. That bar must be closed, even when
  base bars are missing (the clock decides). Plant `htfOpen`: the last higher bar with `s_g ≤ s_i` instead (it may
  still be forming).
- **dataProblems** reads every `LoadReport` and appends one string per failure:
  - readFailures > 0, valueStops non-empty, ohlcBad > 0, dupStarts > 0 or bandBad > 0;
  - num ÷ den > `ASK_LT_BID_MAX` in any year;
  - a higher-timeframe series with two bars of one start.

  Band: `PRICE_BAND[pair]` when `band === "real"`, and `SYN_BAND × GEN_START[pair]` when `band === "syn"`.
- **cutTfSet** (removed in C4e, 2026-11-08; the lead's G6): it was `prefixSeries` on each of the five pairs, then
  `tfSetOf` (the higher bars rebuilt from the cut bars, so a forming higher bar exists exactly as it would have at
  Tcut).
  - (C4d, 2026-11-07; C4c's review, finding 4) No module calls it: b3a2c43's cut did not either. The cut check makes
    its own cut (7.3: `prefixSeries` of the target's pair; the other pairs give only their bar starts, for the
    holes). `windowSeries` is now called only by the follow-bar checks (`lawsearch-trade.ts` `followBarChecks`): C4d
    removed the cut's window for B06 (7.3).
  - (C4e, 2026-11-08) Removed from `lawsearch-bars.ts`: it was exported and unused, and no `.ts` or `.py` file
    imported it (the C4e integrator's search; only this file named it). No output depends on it.
- **prefixSeries and windowSeries** (C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's
  q1; the lead's G1): both return a COPY that holds the asked bars only (`copyOf`). Each of the Series' 28 typed
  arrays (the 14 `Float64Array`s s, T, the eight raw sides and O, H, L, C; the 14 `Int32Array`s of points, `day` and
  `fileKey`) is sliced, so it gets a memory block (`ArrayBuffer`) of its own with exactly to − from elements, holding
  the same values bit for bit (a typed array's `slice` copies the bytes).
  - Until C4e they returned subarray views (`viewOf`) of the uncut arrays. A view's memory block still held every bar
    of the uncut series, so code that read a series through its memory block (a typed array or `DataView` made over
    `C.buffer` at an offset past the view's end) saw bars that the series did not hold. A cut prefix then showed the
    uncut future to such code, and the cut check could not see that read (7.3; 8's `bufferReadE04`). It was not a
    regression: b3a2c43 used the same views.
  - A copy has nothing past its last bar, so whatever way code reads it, it reads the asked bars alone.
  - The cost is the copy of bars 0 … k at each cut target: 12.5.

### 4.2 `research/lawsearch-gen.ts`

```ts
import type { Bars, GenGroup, GenManifest, GenSpec, Pair, TfKey } from "./lawsearch-types.ts";

export const GEN_VERSION = "lawsearch-gen 1";
// spec 14.1: the pairs' starts (lawsearch-bars.ts imports this one for the synthetic band)
export const GEN_START: Readonly<Record<Pair, number>>;          // 110.000, 125.000, 80.000, 1.10000, 0.70000
export const GEN_MINUTE_PIPS: Readonly<Record<Pair, number>>;    // 1.0 on the yen pairs, 0.6 on the dollar pairs
export const GEN_HOUR_MULT: readonly number[];                   // 24 values: 00–06 0.8, 07–15 1.2, 16–20 1.0, 21–23 0.6
// the effect's amounts per set, written after the trial seeds 901–920 (14.3); null until then (a formal effect run refuses)
export const GEN_STRENGTH: Readonly<Record<GenGroup, number | null>>;

export interface SpreadCell { median: number; p90: number; medianHundredths: number; p90Hundredths: number }
export function parseSpreadValues(text: string): Map<string, SpreadCell>;   // spread-hours-h1.csv (avoidKey → cell); same checks as parseSpreadHours
export function genSpecOf(env: { GEN?: string; SEED?: string; FLIP?: string; STRENGTH?: string }): GenSpec;   // validates seed ranges (4.2 rules)
export function generate(spec: GenSpec, spread: Map<string, SpreadCell>): { bars: Record<Pair, { m5: Bars; m15: Bars; h1: Bars }>; effectSignals: Record<string, number> };
export function writeTf(dir: string, pair: Pair, tf: TfKey, bars: Bars, fromMs: number, toMs: number, emptyKeys: ReadonlySet<string>): Promise<number>;
export function treeSha256(gmoDir: string): Promise<{ files: number; sha256: string }>;   // lawsearch-dump.md 1
// (C4g, 2026-11-10) treeSha256's walk and digest, keeping every file's bytes by its path relative to gmoDir (gate 3, 7.7)
export function treeBytes(gmoDir: string): Promise<{ files: number; sha256: string; bytes: ReadonlyMap<string, Uint8Array> }>;
export function writeRun(dir: string, spec: GenSpec): Promise<GenManifest>;              // <dir>/gmo/… and <dir>/manifest.json
```

(C4g, 2026-11-10; the lead's G1 and G3) `treeSha256` and `treeBytes` are one walk (`treeWalk(gmoDir, keep)`). It reads
each file once, hashes those bytes, and keeps them when asked. So the digest that gate 3 compares with the manifest is
the digest of exactly the bytes the run then reads (7.7). `treeSha256` is unchanged for its other callers (the flip
judgement, 7.9).

`writeRun`'s check for an existing `gmo` folder (`Deno.stat`) now catches only `NotFound`. Any other error, a refused
permission among them, is thrown. Before C4g a refused stat read as "no folder", and the run would have written into
an existing one. This came from the C4g audit of every catch around a Deno API (7.8 hand step 12).

`GEN_START` lives in `lawsearch-gen.ts`, and `lawsearch-bars.ts` imports it for the synthetic band. This is the only
import inside A. The generator imports nothing from `lawsearch-bars.ts`: it uses `gmoDayKey` for its day.

The walk, fixed now (spec 14.1) and never changed after the trial seeds 901–920 set the strengths:

- **Streams** (mulberry32 as trend-data's, Box–Muller as walk5's: `u` drawn until > 0, cos returned and sin kept as
  the spare):
  - own[pi]: `seed × 1009 + pi × 7919 + 14001`;
  - U: `seed × 1009 + 14101`; Y: `seed × 1009 + 14201`;
  - day volatility: `seed × 1009 + 14301`;
  - wide spread: `seed × 1009 + 14401`;
  - Q's jitter: `seed × 1009 + 14501`.
- **A shock** `t4/√2`: draw z, then four normals n1–n4 from the same stream. The shock is
  `z ÷ √((n1² + n2² + n3² + n4²) ÷ 4) ÷ √2`.
- **The minute loop** runs t from `fromMs` (a minute boundary) while t + 1 min ≤ toMs, and skips minutes where
  `walkOpen(t)` is false (trend-data: Sunday 22:00 to Friday 21:00 UTC in summer and 22:00 in winter; 12/25 and 1/1
  shut).
  - After a closure, each pair's mid jumps by `3 × GEN_MINUTE_PIPS × √15 × gauss(own[pi])` pips. This is walk5's
    jump, with no hour factor.
  - The day factor `x_D` updates when `gmoDayKey(t)` changes: `x = 0.9 × x + 0.15 × gauss(dayVol)`, with x = 0 before
    the first day.
  - The move of the minute, in pips, is `shock × GEN_MINUTE_PIPS[pair] × GEN_HOUR_MULT[UTC hour] × exp(x_D)`. The
    shock is combined from the minute's eU, eY and own[pi] draws: USD/JPY `0.5 eU − 0.5 eY + √0.5 own`; EUR/JPY and
    AUD/JPY `−0.6 eY + 0.8 own`; EUR/USD and AUD/USD `−0.6 eU + 0.8 own`.
  - The effect's push of the minute (below) is added. The mid is held in price units (pips × pip size).
- **Ticks and spread**:
  - The minute's mid in ticks is `Math.floor(mid × scale + 0.5)`, with scale 1000 or 100000.
  - Spread cell: (pair, `seasonOf(t)`, `slotOf(t)`) of `spread-hours-h1.csv`. At each new 15-minute slot, one draw
    per pair (PAIRS order) from the wide-spread stream: `u < 0.1` uses p90, otherwise the median.
  - The spread in ticks is `floor((hundredths + 5) ÷ 10)`, an integer half-up of the table's 2-decimal pips.
  - Bid = mid ticks − floor(spread ÷ 2); Ask = Bid + spread.
- **Bars**:
  - The 5-minute bar's open is the mid at its first minute's start (after any jump). High and low are the max and min
    over the open and the minute ends. Close is the last minute end. Bid and Ask get the bar's spread (constant within
    a 5-minute bar).
  - Values are held as `ticks ÷ scale` doubles in a trend-labels `Bars`.
  - 15-minute and 1-hour bars come from `coarsen(m5, "15min" | "1h")` (trend-data, unchanged).
  - Files are written with integer-to-decimal formatting of the ticks (exact; `digits` 3 or 5).
- **Effects** (per minute, in pips × pip size; s = `strength`; the effect's own formulas are written in the generator
  apart from the study's, spec 14.2):
  - **D**: every pair `+ s × GEN_MINUTE_PIPS`.
  - **H**: EUR/USD only, by New York's local hour (nyOffsetMs): [3, 9) `− s × pips`, [11, 15) `+ s × pips`.
  - **E15**: its own RSI14 on the 15-minute mid closes, computed at each 15-minute close: Wilder, seeded by the mean
    of the first 14 changes. BUY when the previous value ≤ 30 < the value, SELL when previous ≥ 70 > value. Each
    signal adds `d × s × pips` to each of the next 8 × 15 open minutes. Pushes add up. Nothing before the close is
    changed.
  - **E1h**: its own parabolic SAR (0.02, 0.2) on the 1-hour mid bars. A flip of long gives the signal. The push
    lasts 8 × 60 open minutes.
  - **EF**: its own EMA200 of the 1-hour mid closes. At each 1-hour close, C > EMA pushes `+ s × pips` and C < EMA
    pushes `− s × pips`, for the next 8 × 60 open minutes.
  - **Q**: on the 5-minute bars after the walk. The last 5-minute close of each 15-minute bar and the next 15-minute
    bar's first 5-minute open get the same jitter J (both sides; high and low widened to hold it).
    `J = Math.round(s × pips × √5 × gauss(Q) × 10)` ticks. The next 5-minute close is the walk's own.
  - **O** and **R**: no price change. O's error is in the program (`answerKnowingE26`); R's trials are step 4.
  - **N** and **C**: none.
- **C** (the trial's comparison walk with holes; 10): an N walk on `TRIAL_SEEDS.holes`, with this fixed list:
  - bars removed (starts in [from, to), both sides): USD/JPY m15 2024-03-05 10:00–11:30 UTC; EUR/USD h1
    2024-06-11 08:00–10:00; AUD/JPY m15 2025-08-13 13:15–13:45; EUR/JPY m15 2026-02-17 07:00–07:15 (one slot: a
    gap that is not a hole on m15);
  - empty day files: AUD/USD m15 key 20240918, and USD/JPY h1 key 20250911.

  The list is in `GenSpec.drop` and `emptyDays`, written by `genSpecOf` for GEN=C only.
- **Flip** (14.2 裏返し): on the 5-minute ticks before coarsening, with S = the pair's start in ticks: mid' = 2S − mid;
  Bid' = 2S − Ask, Ask' = 2S − Bid (high' from low).
- **Seeds** (`genSpecOf`):
  - Each formal set accepts only its `SET_SEEDS` range.
  - An effect set (D, H, E15, E1h, EF, Q) refuses a formal seed while `GEN_STRENGTH[set]` is null.
  - `TRIAL_SEEDS.smoke` accepts `STRENGTH` with `strengthNote = "provisional"`, and only for D, H, E15, EF.
  - C accepts only `TRIAL_SEEDS.holes`.
  - FLIP=1 is accepted on `SET_SEEDS.flip` and on smoke seeds.
- **writeRun** writes the keys of `keysFor(tf, fromMs, toMs)` and the bars' own keys, with `{"status":0,"data":[…]}`
  per side and an empty list for a day without bars, as `writeWalk` does. It then computes `treeSha256` and writes
  `manifest.json` (`GenManifest`). It writes no 5-minute, 4-hour or 1-minute files: the study reads none in the
  trial.

---

## 5. Builder B: signals

### 5.1 `research/lawsearch-ind.ts`

```ts
import type { BigmoveOut, BigmoveParams, DonchianOut, Ind, RsiOut, Series, Tri } from "./lawsearch-types.ts";

export function indOf(series: Series, higher?: { series: Series; g: Int32Array } | null, plant?: string): Ind;   // lazy, cached per (name, p)
export function toF64(xs: ReadonlyArray<number | null>): Float64Array;   // null / non-finite → NaN
export function smaOldest(x: Float64Array, p: number, plant?: string): Float64Array;   // plant smaNewestFirst: pine.ts sma
export function donchianOf(s: Series, n: number): DonchianOut;           // §8.113 C1 (spec 3.3): HH/LL of i−n..i−1, s from 0
export function donchianScan(s: Series, n: number): DonchianOut;         // C4b: b3a2c43's rescan, for n not a whole number ≥ 1
export function bigmoveOf(s: Series, o: BigmoveParams): BigmoveOut;      // §8.113 C17 with 17.3's substitutions
export function bigmoveDefault(step: number): BigmoveParams;            // { 288, 250, 6, 2, 12 × step }
export function xUp(a: Float64Array, b: Float64Array | number): Tri;   // 3.1: a[i−1] ≤ b[i−1] && a[i] > b[i]; −1 when any of the 4 is NaN; −1 at i = 0
export function xDn(a: Float64Array, b: Float64Array | number): Tri;
```

- EMA, RMA and ATR go through pineEma, pineRma and pineAtr. RSI goes through pineRsi, and U and D are pineRma(up) and
  pineRma(dn) with up and dn as spec 3.2 gives them (the same arithmetic as inside pineRsi). The TR array is pineAtr's
  TR (TR[0] = H[0] − L[0]).
- The bar objects for pineAtr are made once per series.
- (C4b, 2026-11-05; written here C4c, 2026-11-07) `donchianOf` takes HH and LL from two monotone queues of bar
  indices (O(len) in all); `donchianScan` is b3a2c43's rescan of each window, kept for n that is not a whole number
  ≥ 1. `rsi(p)` makes up, dn, U and D only when first read (getters); a signal reads only the RSI. Why both give
  b3a2c43's values, and what guards them: 12.1 items 4 and 5.
- The higher Ind is `indOf(higher.series)`.
- bigmove:
  - `r[t] = Math.log(C[t] / C[t−1])`. It is usable when t ≥ 1 and `s_t − s_{t−1} ≤ gapMs`.
  - σ[i] needs i ≥ sigmaWindow. The usable r of r[i−W..i−1] must be at least sigmaMinUsable. The mean is the sum
    oldest first ÷ count. σ = `Math.sqrt(Σ (r − mean) * (r − mean) ÷ (count − 1))`, and it must be > 0.
  - `z[i] = Math.log(C[i] / C[i − moveBars]) / (σ[i] * Math.sqrt(moveBars))`, only when r[i−moveBars+1..i] are all
    usable.
  - (C4d, 2026-11-07; the lead's F1 allowance) σ is computed faster, with the same values bit for bit. B06 is now cut
    on its prefix from bar 0 (7.3), so `bigmoveOf` runs on every cut prefix. The same function serves the main run,
    the dumps, the hand examples and every check.
    - `ru` holds the usable r in bar order. `at[t]` is how many usable r come before bar t. So the usable r of
      r[i−W..i−1] are `ru[at[i−W]] … ru[at[i] − 1]`, in the same oldest-first order, and the count is
      `at[i] − at[i−W]`.
    - `one(i)` is the old loop body for bar i, run on `ru`: the same count, the same additions in the same order
      from 0, the same mean, sum of squares, division and √. The skipped r added nothing before, and they are not in
      `ru` now.
    - Four bars i … i + 3 whose windows have the same count (at least `sigmaMinUsable`) are summed side by side.
      Each of the four sums, and each sum of squares, is still its own chain: it starts from 0 and adds its own
      window oldest first, exactly as `one(i + j)` would. Only the four independent chains are interleaved. Any
      other group of four bars goes through `one` bar by bar. No sum is reordered, split or shared between windows
      (there is no running sum), because floating-point addition is not associative (2.5).
    - Why and what guards it: 12.1 item 10.
- Nothing is computed by B06 that §8.113 C17 does not name. B is the only builder who reads §8.113 18's C1, C17 and
  docs §8.113 4's 置5–置7 (docs/OPERATIONS.md §8.113).

### 5.2 `research/lawsearch-items.ts`

```ts
import type { FilterDef, ItemDef, ItemParams, TfKey, TrialDef } from "./lawsearch-types.ts";

export const notBuilt: (what: string) => never;
export const isNotBuilt: (e: unknown) => boolean;
export function parseCandidates(json: unknown): TrialDef[];   // the ledger: 1,364 rows, order 1..1364; "15min" → "m15", "1hour" → "h1"; throws on any other shape (C4f: each TrialDef frozen)
export const trialCopyOf: (t: TrialDef) => TrialDef;          // (C4f, 2026-11-08) the checks' own copy: Object.freeze(structuredClone(t))
export const ITEMS: ReadonlyMap<string, ItemDef>;            // E04, E26, B06 now
export const FILTERS: ReadonlyMap<string, FilterDef>;        // F00, F01 now
export function itemOf(id: string): ItemDef;                  // notBuilt for any other id
export function filterOf(id: string): FilterDef;              // notBuilt for any other id
export function sFilterOf(sId: string): FilterDef;            // S01 → filterOf("F01") (S_OF_F); notBuilt otherwise
export function trialBuilt(t: TrialDef): boolean;            // every part of the trial has a definition
export function trialWarmup(t: TrialDef, params?: ItemParams): number;   // max(E's, F's) / the S's F / the B's
export function answerKnowingE26(): ItemDef;                 // set O (14.2): E26 with its direction from C[i+1] vs C[i]
export function stepThree(all: TrialDef[]): TrialDef[];      // TRIAL_STEP3 in table order (throws if any is missing)
```

The definitions now (spec 4.1–4.4, 5, 17.3):

| id | kind | build (on `ind`, `params`) | warm-up | dump columns |
|---|---|---|---|---|
| E04 rsi_back_14_30 | cross | rsi = `ind.rsi(params.rsi ?? 14).rsi`; buy `xUp(rsi, 30)`, sell `xDn(rsi, 70)` | p + 1 = 15 | RSI14, RSI14_U, RSI14_D, E04_buy, E04_sell |
| E26 donchian-A20 | hold | `don = ind.donchian(params.donchian ?? 20)`; buy `s === 1`, sell `s === −1` (never 無し) | 20 | DON20_HH, DON20_LL, DON20_s |
| B06 bigmove | condition | `bm = ind.bigmove(bigmoveDefault(step) ⊕ params.bigmove)`; buy `z ≤ −threshold`, sell `z ≥ threshold` (−1 where z is NaN); keep 0 where T's UTC time ∈ [19:35, 24:00) | 288 | BM_r, BM_ok, BM_sigma, BM_z, B06_buy, B06_sell, B06_keep |
| F00 | filter | 1 everywhere | 0 | — |
| F01 | filter | x = C − `ind.ema(params.ema ?? 200)`; buy `x > 0`, sell `−x > 0` (= `x < 0`), −1 where NaN | 200 | EMA200, F01_buy, F01_sell |

- The column names are `lawsearch-dump.md` 5's. With params, the names keep the default numbers (`RSI14`, `EMA200`),
  because only the hand examples pass params.
- S01 is a trial of kind S with `s = "S01"`. Its condition is `sFilterOf("S01")`'s `f`, and its warm-up is F01's.
- `answerKnowingE26`: kind hold. target[i] = +1 when C[i+1] > C[i], −1 when C[i+1] < C[i], else the previous target
  (0 at the start). This is the error set O plants: it reads the next bar. It is used only when the run's manifest
  says group O.
- Families: E04 is written as `rsiBack(p, L)` and E26 as `donchianA(n)`, so E01–E06 and E27 are one line each later.
  They are not registered now (`notBuilt`).
- (C4b, 2026-11-05; written here C4c, 2026-11-07) `checkRegistry`: when the module is loaded, before any file is
  read, the program stops if a key of `ITEM_MAP` or `FILTER_MAP` is not its definition's id. `lawsearch-events.ts`
  keeps an Ind's builds under the definition's id (`BUILDS`, 5.3), which is exact only while each id names one
  definition (12.1 item 3). The check covers every item and F registered later too.
- (C4f, 2026-11-08; the lead's H1 and H2 on C4e's review) The trial definitions:
  - `parseCandidates` returns each `TrialDef` frozen (`Object.freeze` where it is made). A `TrialDef` holds strings,
    numbers and nulls only, so the shallow freeze freezes all of it. No field can be changed and no property can be
    added. In these strict modules either write throws a `TypeError` (for example `Cannot add property __peek, object
    is not extensible`). That is defense in depth only (H2; 12.1 item 13). It does not stop state kept elsewhere and
    keyed by the trial or its id (a module-level map).
  - `trialCopyOf(t)` makes a definition of the checks' own: a structured clone (a new object with the same fields),
    frozen as well. `lawsearch.ts` makes the checks' trials with it in `main()`, right after gate 2 and before the
    pipeline starts (7.7). By then only gate 2's `trialBuilt` has read the parsed definitions, and they are frozen.
    So no check reads a definition object the main run holds. That is the guard by construction (H1; 7.3, 12.1
    item 12).

### 5.3 `research/lawsearch-events.ts`

```ts
import type { Candidates, Classified, ExclCtx, HalfName, HalfOf, Holes, Ind, ItemParams, Pair, ReasonCode, Series, TfKey, TfSet, TrialDef, TrialSignals } from "./lawsearch-types.ts";

// ---- spec 5
export interface CandOpts { params?: ItemParams; plant?: string; answerKnowing?: boolean }
export function candidatesOf(trial: TrialDef, ind: Ind, o?: CandOpts): Candidates;
// ---- spec 1, 6
export function halfOf(T: number, X: number, stage3: ExclCtx["stage3"], plant?: string): HalfOf;   // plant splitShift
export function r2(T: number): boolean;                               // isPossiblyClosed at T, T + 1 min, T + 3 min (all three)
export function r4(T: number, X: number): boolean;                    // Friday 21:00 UTC or a GMO holiday time inside [T, X)
export function r5(T: number): boolean;                               // (Sunday 21:00, Monday 00:00] or (holiday's day 21:00, next 00:00]
export function r6(avoid: ReadonlySet<string>, pair: Pair, T: number, X: number): boolean;   // entry (T) or exit (X − 1 min) slot avoided
export function holesOf(tf: TfKey, starts: ReadonlyArray<ArrayLike<number>>, fromMs: number, toMs: number): Holes;
export function r3(h: Holes, pi: number, sFrom: number, T: number, plant?: string): boolean;   // a hole slot a with a < T && a + step > sFrom; plant reasonUsesFuture
export function exclCtxOf(tf: TfSet, avoid: ReadonlySet<string>, fromMs: number, toMs: number, stage3?: ExclCtx["stage3"], plant?: string): ExclCtx;   // C4f: through exclCtxFrom (frozen)
// (C4f, 2026-11-08) an ExclCtx of these parts, frozen (stage 3's period, when given, a frozen copy); the cut's units call it directly
export const exclCtxFrom: (tf: TfKey, step: number, holes: Holes, avoid: ReadonlySet<string>, stage3: ExclCtx["stage3"], plant: string) => ExclCtx;
export function reasonOf(ctx: ExclCtx, s: Series, i: number, warmOk: boolean): ReasonCode;   // ① … ⑥ first match, for an emitted candidate or a blind bar
export function classify(ctx: ExclCtx, s: Series, c: Candidates): Classified;
export function trialSignals(trial: TrialDef, tf: TfSet, inds: Ind[], ctx: ExclCtx, o?: CandOpts): TrialSignals;
export function blindBarsOf(ctx: ExclCtx, tf: TfSet, half: HalfName): Uint8Array[];   // per pair: 1 = T in the half and ②–⑥ pass
export function avoidOf(text: string): ReadonlySet<string>;          // parseSpreadHours(text, PAIRS); the caller has checked the sha256 (C4f: read-only, readOnlySet)
// (C4f, 2026-11-08) s made read-only in place and returned: its own add, delete and clear throw, and the Set is frozen
// (C4g, 2026-11-10) a Set this function made read-only before is returned as it is (a module WeakSet records them);
// any other frozen Set throws
export function readOnlySet<T>(s: Set<T>, what: string): ReadonlySet<T>;
// (C4g) set by lawsearch.ts for the plant gmoWriteR only: the run's gmo folder
export const GMO_WRITE: { dir: string };
```

**candidatesOf** follows spec 5's order exactly:

1. ① The condition comes from the item's build (or, for an S row, from the filter's f).
2. ② The raw signal at bar i, per direction d:
   - cross: `cond[d][i] === 1`;
   - condition and hold: `cond[d][i] === 1 && i ≥ 1 && cond[d][i−1] === 0`, and i is not the first bar after S0
     where cond[d] is not −1. This makes both "no signal" bars of spec 5. A −1 at i−1 blocks i. Bar 0 never
     signals.
   - state: `f[d][i] === 1`, with no rising edge and no 無し rules.
   - Plant `noRisingEdge`: condition and hold emit every bar where the condition is 1.
3. ③ `keep[d][i] === 0` drops the raw signal. Nothing is counted for it, and the condition array is not changed, so
   the next bar's i−1 is still ①'s (§8.113 5, A.4.34).
4. ④ The filter f of the (E, F) trial (S rows: none here): f = −1 gives status `f_none`, f = 0 drops the signal
   (uncounted), f = 1 keeps it.
5. ⑤ When both directions remain at one bar, both get status `both`.
6. warmOk: `i ≥ max(item warm-up, filter warm-up)` (and the filter's `warmOk[i]` when non-null). For an S row, the
   F's warm-up.

The output lists every bar with a status (emit, f_none, both), in bar order, buy before sell.

(C4c, 2026-11-07; C4b's review, findings 1 and 3) How `candidatesOf` is written now:

- It is one walk over every bar of the series it is given, from bar 0, in order: `prepare` (① and what ②–④ and the
  warm-up read: the builds, the kind, the first bar whose condition is not −1), then the loop ②–④ at i = 0 … n − 1
  (b3a2c43's loop, its body written out once per direction for speed), then `finish` (⑤ and warmOk).
- It is the only way to get a trial's rows. The main run (`trialSignals`) and the checks of spec 15 (`decisionOf`,
  7.3) both call it, the checks on their own cut, poisoned or edited series. C4b's `candidatesAt` and
  `rowsAtBar` (the loop's body run at one bar alone) are gone. Why: 12 rule 2.
  - (C4d, 2026-11-07; C4c's review, finding 1) Up to C4c the cut also called it on a 291-bar window for B06. That
    window is gone: every item, B06 included, is cut on its prefix from bar 0 (7.3).
- The builds of items and F's go through `buildOf`: kept per Ind (`BUILDS`, a WeakMap keyed by the Ind), so that
  the trials on one Ind with the same item or F build it once (C4b; 12.1 item 3).
- The plants `lastBarStateG3` and `lastBarStateG5` (8) are in this loop. (C4d, 2026-11-07) So is the plant
  `carriedCountB06` (8). It affects B06's trials only. `raw0` and `raw1` count B06's raw signals (②) per direction
  from bar 0. On the series' last bar, a raw B06 signal is dropped when that direction's count before it is odd.
  - (C4e, 2026-11-08) Two more plants are in this loop (8):
    - `carriedCountS01` (the lead's G4): the same as `carriedCountB06`, on S01's trials only (kind S, `s` = S01).
    - `bufferReadE04` (the lead's G1): on E04's trials only, a raw buy signal (②) is dropped when the next close is
      below this bar's close, and a raw sell signal when it is above. The next close is read through C's memory
      block, never as `C[i + 1]`: `storeOf(C)` is a `Float64Array` over `C.buffer` from `C.byteOffset` to the end of
      the block, and the plant reads its element i + 1 when it exists. On a series whose arrays hold its own bars only,
      that is C itself, so on its last bar there is no next close and nothing is dropped. On a view of a longer array
      it runs past the series' end.
  - (C4f, 2026-11-08; the lead's H4 on C4e's review: the reviewer's `seriesStashE04` and `trialStashE04`, the
    refuters' `seriesWriteE04` and `trialahead`) Two more plants are in this loop, on E04's trials only, with
    `bufferReadE04`'s drop rule. They keep the next close where code that is handed the main run's objects could
    leave it for the checks (8):
    - `seriesStashE04`: `seriesStashOf` writes the sign of C[q + 1] − C[q] into the series' own `fileKey` array at
      every bar q < n − 1 that holds no sign yet (−10 down, −11 up, −12 equal). It returns that array, and a raw buy
      signal at bar i is dropped where `fileKey[i]` is −10, a raw sell signal where it is −11. This is the
      universe-array channel: the main run's call writes into the main run's universe.
    - `trialStashE04`: `trialStashOf` keeps, per pair, a copy of the longest close array the trial has been given, in
      a property `__peek` added to the trial object, and reads the next close from there. This is the trial-object
      channel. On a frozen `TrialDef` (5.2) its first write throws.
  - (C4g, 2026-11-10; the lead's G5: C4f's review and the C4g judges) Four more plants are in this loop. Three of them
    use `bufferReadE04`'s drop rule on E04's trials, each keeping or finding the next close in a place the C4g design
    closes (8; 12.7):
    - `rp2EnvE04`: the next close's sign per bar slot is kept in the process environment (`RP2E04_<pi>_<key>`). The
      first call writes it, which is the main run's call on its whole series, and every later call in any realm reads
      it. Since C4g the environment is revoked before any main-run code runs (7.7), so the first `Deno.env.get` throws
      `NotCapable` (exit 1).
    - `judgeListen2E04`: this module adds a listener to its realm's `message` events when it is evaluated. In a par
      worker the listener keeps the series of the latest `universe` message, and the next close is read from them
      wherever they hold one. The listener is added in every realm, whatever the plant, because a module cannot know
      `LS_PLANT` when it is evaluated. It only keeps a reference to a universe its worker already holds, and nothing
      reads that unless `LS_PLANT` names this plant. A cut worker is sent no bar after its target (deltas, 7.3), so
      the cut fails. Poison's and presence's workers still get the whole universe, by the spec (12.7, residual 1).
    - `judgeCacheCarryE04`: a memo of the next close's sign per (pair, timeframe, bar start). It is filled forward from
      every E04 series the realm sees, and a tail shifted by more than 2 % stops the fill. The memo is kept in a module
      `Map` and in CacheStorage. CacheStorage is read back with a top-level await when the module is evaluated; in
      Deno 2.9.6 it is shared by the workers of one entry module, within a process and across processes, on disk. The
      lockdown deletes `caches` in every realm (12.7 G3), so only the module `Map` is left. A cut worker is fresh for
      its cut run and holds no later bar, so the cut fails. The C4g integrator rewrote the judge's helper (numeric
      keys, a forward fill, look-ups at raw signals only, a cache write at most once per 2 s), because the judge's
      form took a C 7101 run over 30 minutes in stage 0.
    - `w0protoG3`: `lastBarStateG3`'s look-ahead, turned off on every series shorter than the first one this realm saw
      for the (trial, pair). The table is kept on a built-in prototype (`Array.prototype.__w0proto`, a non-enumerable
      expando), not in the module. Until C4g, at `WORKERS=0`, the main run's whole series came first in the one realm,
      so every cut prefix was shorter and the cut decided as the main run did. Since C4g every unit runs in a worker,
      and there a check's own series fill the table first.
- (C4d, 2026-11-07; C4c's review, finding 2) A check's decision at bar k is made by the same code as the main
  run's, from the check's series alone. This holds by construction for any change of the loop's body or of a build
  that keeps every build and cache keyed by the Ind and adds no module-level state that survives between
  `candidatesOf` calls (12.2 (2)). Such state is not part of "the check's series alone". It could also make the bytes
  depend on `WORKERS`, because the main thread and each worker hold their own copy of it (12 rule 3).
  - (C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's q1; the lead's G1) Until C4e
    this held only for code that reads a series through its elements. A cut prefix was a view, so code that read it
    through its memory block saw the uncut bars after k, while keeping every build keyed by the Ind and adding no
    module-level state. Now every series a check hands to `decisionOf` has arrays that hold its own bars only (4.1
    `copyOf`; 7.3), so the equality holds however the code reads the series: through its elements or through its
    memory block. The condition on module-level state stays (12.2 (2)).
  - (C4f, 2026-11-08; the lead's H1 on C4e's review) Until C4f this held only for code that wrote nothing into the
    objects it is handed. The checks copied their series from the arrays the main run had been handed, and read the
    main run's trial definitions and avoid table (poison also its `ExclCtx`). The workers got clones of those, made
    after the main run had used them. So a value that the main run's call of this code left in its own series, trial
    or table sat in every check's input. The plants `seriesStashE04`, `trialStashE04` and `avoidStashR3` (8) did that,
    and every check passed on fcce9e6 while the main run looked ahead. Now every input a check reads is its own: its
    series is made from a snapshot of the universe taken right after loading, before any main-run code was handed
    the universe, and its trial definitions, avoid table and holes are its own (7.3's C4f bullet; 7.7's guard). So
    the equality holds whatever this code writes into the objects it is handed. The condition on module-level state
    stays: at `WORKERS=0` the checks run in the main thread's own module instances (12.2 (2)).
  - (C4g, 2026-11-10; the lead's T and G2; C4f's review) The last sentence above is no longer true, and the condition
    is now narrower.
    - No check unit runs in the main thread at any `WORKERS`. Every unit runs in a worker with no permission, whose
      module instances and realm no main-run code ever ran in (7.3; 12.7). So state that the main run's call of this
      code keeps never reaches a check's call. That covers state outside any object handed to the code: module
      bindings, realm globals such as `globalThis` properties and built-in prototype expandos, the environment and
      files.
    - A cut unit's worker is made for its cut run and has never held a bar after the target it decides (deltas). So
      even state that one cut unit leaves for a later one in the same worker holds no later bar.
    - What the condition still covers is state that one poison or presence unit leaves for a later one in the kept
      probe pool. Their inputs hold the bars after T by the spec (12.7, residual 2).
    - For the threat model these claims rest on, see 12 rule 2.

**reasonOf** (spec 6; X = T + `N_BARS` × step), first match:

1. ① and ①b: `halfOf`. It returns first or second (or stage3) when the half's rule holds. It returns `r1b` when
   START ≤ T < SPLIT and the first half's rule fails. Otherwise it returns `r1`.
2. Then `r1w` when `!warmOk`. The warm-up is ignored for ①b.
3. Then r2; r3 (with sFrom = `s.s[max(0, i − R3_BACK)]`); r4; r5; r6; otherwise counted.

The blind table's bars use `warmOk = true`.

(C4f, 2026-11-08; the lead's H4 on C4e's review: the reviewer's `avoidStashR3`, the refuter's `rs-wt`) The plant
`avoidStashR3` is in `reasonOf`, on every trial (8). ③ is computed on `reasonUsesFuture`'s window, which reads the
holes after T. The answer is kept in the `ExclCtx`'s avoid table as an entry `plant:r3:<pair>:<tf>:<T>:<0|1>`, and is
read from there first. This is the avoid-table channel on the reason path. Until C4f the main run's avoid table was
the very Set that every check unit read in the main thread (a worker got a structured clone of it, with these
entries), so a check's decision at T found the main run's answer. Since C4f the checks have an avoid table of their
own (7.7), and `avoidOf`'s table is read-only, so the plant's first `add` throws (below).

(C4g, 2026-11-10; the lead's G5; C4f's review, the refuter's "rp4 call") The plant `avoidStashR3call` is
`avoidStashR3` with its entry (`plant:r3call:<pair>:<tf>:<T>:<0|1>`) written by `Set.prototype.add.call` and read by
`Set.prototype.has.call`. The read-only table does not stop that write. So the plant reaches the checks only if they
share the main run's Set, and it tests H1's separation itself in CI: the checks' avoid table is another Set, so the
cut or presence fails (8; 7.8, the job `plants-c4g`).
(C4h, 2026-11-11; C4g's review, the lead's F3) It also showed a carry route inside the checks: every poison and
presence unit of a check run in a probe worker shared the task's one table, so presence variant (ii) read the entry
variant (i) wrote for the same pair, timeframe and T (the key has no variant in it): half of its presence failures.
Since C4h each poison and presence unit gets its own read-only copy of the task's table (7.3 `unitAvoidOf`), and the
plant's presence counts halve (8).

(C4g) The plant `gmoWriteR` is in `trialSignals`. The main run's first call of the process, in stage 0, rewrites one
bid close of the run's own gmo folder: USD/JPY m15 2024-03-11T04:00Z, 113.217 → 113.218, a first-half bar of C 7101's
data. Its first call on a stage-2 universe writes the original bytes back. `lawsearch.ts` gives it the folder
(`GMO_WRITE.dir`). At the start of stages 1 and 2, `lawsearch.ts` prints that bar's close as three values: on the disk,
in the checks' snapshot and in the main run's universe. This is the file channel; since C4g no load and no check reads
the disk after gate 3 (8; 12.7 G1).

(C4f, 2026-11-08; the lead's H2, defense in depth; H1 is the guard) What the exclusions read is read-only where that
is cheap:

- `avoidOf` returns `readOnlySet(parseSpreadHours(text, PAIRS), "the avoid table")`. `readOnlySet` gives the Set its
  own `add`, `delete` and `clear`, each of which throws `the avoid table is read-only: <op> refused`, and freezes
  the Set, so those cannot be replaced and no property can be added. It does NOT stop
  `Set.prototype.add.call(set, x)` (or `delete`, `clear`), which writes into any Set. A structured clone of it (a
  worker's task) is a plain Set again, and the worker seals its copy (7.3 `sealTask`).
  - (C4g, 2026-11-10; the lead's G4; C4f's review) `readOnlySet` now records every Set it makes read-only in a module
    `WeakSet`, and returns such a Set as it is. Until C4g it returned any frozen Set as it was, although
    `Object.freeze` does not stop a Set's own `add`. Any other frozen Set now throws (exit 1), because it cannot be made
    read-only in place.
    - `sealTask` passes the checks' avoid table through `readOnlySet`, which returns it unchanged. So the sealed task's
      `avoid` is still the checks' own Set by identity, which the allow-list wants (7.3).
    - The run plant `avoidStashR3call` writes past the read-only table with `Set.prototype.add.call` (above); H1 is
      what catches it.
    - (C4h, 2026-11-11; the lead's F3) In a worker, the task's sealed table is no longer what a poison or presence unit
      reads: each such unit gets a fresh copy made read-only here (`readOnlySet(new Set(task.avoid))`, 7.3
      `unitAvoidOf`), so a write past it with `Set.prototype.add.call` stays in that one unit. The cut's units still
      read the task's table (12.9 F3 says why that carries no later bar).
- The `ExclCtx` is frozen (`exclCtxFrom`; `exclCtxOf` goes through it): no field can be replaced and no property
  added. Stage 3's period, when given, is a frozen copy.
- `holesOf` freezes the `Holes` object and its two per-pair lists (`present`, `hole`): no field and no list entry can
  be replaced. Its typed arrays (`open` and each pair's `present` and `hole`) cannot be frozen and stay writable.

None of this is the guard: the checks never read the main run's avoid table or `ExclCtx` (7.3's C4f bullet). The
freezes only make such a write fail at once, with exit 1 (2.3), where H1 would have kept it away from the checks.

**classify** sets T, X and half for every row, including f_none and both. `half` is 1 or 2 when the half's T/X rule
holds, whatever the reason, because spec 9 counts f_none and both by the half's rule.

**halfOf**:

| result | rule |
|---|---|
| first | START ≤ T, wk(T) ≤ 2888, X ≤ SPLIT |
| second | T ≥ SPLIT, X ≤ END |
| stage3 | stage3 given: T ≥ from and X ≤ end |
| r1b | START ≤ T < SPLIT, otherwise |
| r1 | otherwise |

Plant `splitShift`: SPLIT + 1 week, and wk 2889 in place of 2888.

**holesOf**:

- Slots of [fromMs, toMs) on the grid (fromMs rounded down to the step).
- A slot a is open when: not all of a, a + 1 min, a + 3 min are `isPossiblyClosed`; `isGmoHoliday(a)` is false; and
  at least `OPEN_MIN_PAIRS` pairs have a bar starting at a.
- A hole is a run of adjacent open slots where the pair has no bar, at least `HOLE_MIN_SLOTS[tf]` long. A slot that
  is not open breaks the run.
- (C4b, 2026-11-05; written here C4c, 2026-11-07) The clock part of "open" (`r2(a) || isGmoHoliday(a)`, which reads
  the time alone) is computed once per slot and kept for the run (`CLOCK`, per step, in blocks of 4,096 slots). The
  parts that depend on bars are computed from the starts each call is given (12.1 item 8). Each thread (the main one
  and each worker) keeps its own table.

**r3** is true when some hole slot a of the pair has `a < T && a + step > sFrom` (touching an end does not count).
Plant `reasonUsesFuture`: the window is [sFrom, X) and the holes are those of the whole series (it reads bars after
T).

**r6**: the entry slot is `avoidKey(pair, seasonOf(T), slotOf(T))`, and the exit slot is `avoidKey(pair, seasonOf(X −
1 min), slotOf(X − 1 min))` (spreadhours-lib).

---

## 6. Builder C: measures

### 6.1 `research/lawsearch-trade.ts`

```ts
import type { BlindTable, CheckResult, Dir, HalfName, Series, TfKey, TfSet, Trade, TrialRows, TrialSignals } from "./lawsearch-types.ts";

export const rowKey: (pi: number, T: number, d: Dir) => number;   // 2.2
export function tradeOf(s: Series, T: number, X: number, d: Dir, plant?: string): Trade | null;   // spec 7 via entryExitIndex; plants entryAtSignalClose, entryEarly, exitLate, noSubstituteExit
export function lateTradeOf(m15: Series, T: number, X: number, d: Dir): Trade | null;   // 8.8: entry start ≥ T + 15 min and < X + 15 min; exit close = X + 15 min, else the substitute
export function blindTable(tf: TfSet, half: HalfName, passing: Uint8Array[], plant?: string): BlindTable;
export function lateTable(base: BlindTable, m15: TfSet, periodEnd: number, plant?: string): BlindTable;   // 8.8's three exclusions counted
export function blindFromRows(tf: TfKey, half: HalfName, late: boolean, rows: ReadonlyArray<{ pi: number; T: number; m: number; plBuy: number; plSell: number; absm?: number }>): BlindTable;   // hand examples
export function trialRows(table: BlindTable, late: BlindTable, sig: TrialSignals, half: HalfName, series: Series[]): TrialRows;
export function followBarChecks(tf: TfSet, table: BlindTable): CheckResult;   // spec 15 追う足 (i) and (ii) (C4g: removed, below)
// (C4g, 2026-11-10) the follow-bar checks in two parts: the recomputation in a worker of its own, the comparison here
export interface FollowRows { tf: TfKey; late: boolean; n: number; pi: Int8Array; T: Float64Array; d: Int8Array; j: Int32Array; x: Int32Array }
export const followRowsOf: (table: BlindTable) => FollowRows;                   // the rows' coordinates only (copies)
export interface FollowValues { m: Int32Array; h: Int8Array; pl: Float64Array; opl: Float64Array }
export function followValues(tf: TfSet, rows: FollowRows): FollowValues;        // (i)'s m, h, PL and (ii)'s PL of every row
export function followCompare(table: BlindTable, v: FollowValues): CheckResult; // the check: v against the table, in its order
```

- **tradeOf**: `entryExitIndex(s, T, X)` gives j and x. Then m = d × (Pc[x] − Po[j]), h = sign(m), and pl = buy
  `Bc[x] − Ao[j]` or sell `Bo[j] − Ac[x]`. It returns null when there is no entry bar.
  - Plant `entryAtSignalClose`: the entry price is the signal bar's close (buy Ac, sell Bc), and m uses Pc[i].
  - Plant `entryEarly`: j − 1.
  - Plant `exitLate`: x + 1 (when it exists).
  - Plant `noSubstituteExit`: null when no bar closes at X.
- **blindTable**:
  - The bars are those with `passing[pi][i] === 1`, sorted by (T, pi). Each bar has `tradeOf` for d = +1 and −1.
  - When there is no trade, the bar counts once in `noTradeBars` and has no row. Otherwise it has two rows (buy,
    sell). The sell row's h is −h(buy) and its pl is computed with the sell formula.
  - hour, season, stratum and week come from T (bars: hourOf, seasonGroupOf, stratumOf; const: wk).
  - `weeks` is the distinct weeks ascending.
- **lateTable**:
  - For each row r of `base`, the late trade uses the 15-minute series of the same pair, with T and X of the row.
  - Excluded rows: no late entry bar (`noEntry`); `r4(T, X + 15 min)` true (`r4`); X + 15 min > periodEnd (`end`).
    `end` must be 0 (`stop()` otherwise).
  - The stratum uses `T + LATE_MS`. The week is still wk(T). The index is keyed by the base row's (pi, T, d).
- **trialRows**:
  - Each counted signal of the half (reason counted, half = the table's) looks up `table.index`.
  - When the row is absent, `tradeOf` decides: null adds to noTrade; a trade adds to noBlind. noBlind must be 0, and
    the caller stops otherwise.
  - lateRows are the late-table rows of the found rows. The absent ones are counted by the late table's reason.
- **followBarChecks**: for every row of the table, (i) and (ii) of spec 15.
  - (i) poison the 300 bars with T_k ≤ T (`poisonBars`) of the row's pair. Recompute m, h and pl with the same j and
    x. Every value must be equal.
  - (ii) poison bar j's open (both sides). pl must change.
  - (C4g, 2026-11-10; the lead's G2; C4f's review, the refuter's `lenmemo` with `entryEarly`) **Split in two, and the
    recomputation moved out of the main thread.**
    - Why. Until C4g `followBarChecks` ran in the main thread, in the module instances in which the main run's trades
      had run. A module-level memo of `valuesAt`, filled by the main run's trades, gave (i)'s poisoned windows the main
      run's values back. The plant `entryEarly` then passed follow (i) with 0 changed rows, on every `WORKERS`.
    - `followValues(tf, rows)` is the old loop's recomputation: (i) and (ii) for each row, from the timeframe and the
      rows' coordinates alone. It runs in a worker of its own, `lawsearch-follow-worker.ts`. `lawsearch.ts`
      (`followInWorker`) starts that worker for each call with no permission and ends it after its answer. There are
      at most four calls per run: stages 1 and 2, m15 and h1.
    - The worker gets the stage snapshot's timeframe without its higher bars, and `followRowsOf(table)`: copies of the
      table's `pi`, `T`, `d`, `j` and `x`. It never gets the main run's `m`, `h` or `pl` (the values compared), and
      never the table itself.
    - `followCompare(table, v)` then compares, in the main thread, row by row in the table's order. It makes the same
      counts, examples and detail strings as the single loop did, so `checks.csv` and print.txt are the same bytes.
  - (C4g) Plant `lenmemoEntryEarly` (8): `entryEarly`'s j − 1, plus a module-level memo of `valuesAt` keyed by the pair,
    the series key, the closes of the entry and exit bars and the direction. The plant's first trade in a realm switches
    the memo on. The memo is read back only on series longer than 16 bars: follow (i)'s windows (up to 308 bars), not
    (ii)'s (at most 9). In its own worker no trade has run, so the memo is off there and follow (i) changes.

### 6.2 `research/lawsearch-stats.ts`

```ts
import type { BlindTable, PlExtras, SeCand, SeKind, StratumAgg, TrialMeasures, TrialRows, ValueEst } from "./lawsearch-types.ts";

// distributions and small statistics
export function tUpper(x: number, df: number): number;          // money-stats tUpperTail: U(x, ν), x ≥ 0
export function pOneSided(x: number, df: number): number;       // x ≥ 0: U(x, df); x < 0: 1 − U(−x, df)
export function tq(q: number, df: number): number;              // money-stats tQuantile
export function zq(p: number): number;                          // standard normal quantile, Wichura AS241 (PPND16); for (N4)'s L
export function isZero(x: number): boolean;                     // |x| < ZERO
export function sdTwoPass(xs: ArrayLike<number>): number | null; // ÷ (n − 1); null when n < 2
export function median(xs: readonly number[]): number | null;    // 21.5
export function point95(xs: readonly number[]): number | null;   // 21.5: the ⌈95n ÷ 100⌉-th smallest
export function nGateL(M: number): number;                      // 1 + zq(1 − 0.01 ÷ M) ÷ √(2 × 99)
export function tCdf(x: number, df: number): number;            // T(x, ν): x ≥ 0 → 1 − U(x, ν); x < 0 → U(−x, ν) (A.2.12's T_double)
// 11 SE の較正: κ = sd of the runs' values (runs with a value) ÷ mean of the used se (runs with a t); used = max(1, κ) (A.2.21)
export function kappaOf(values: ReadonlyArray<number | null>, usedSe: ReadonlyArray<number | null>): { sd: number | null; meanSe: number | null; runsForSd: number; runsForMeanSe: number; runsWithoutT: number; kappa: number | null; kappaUsed: number | null };
// 14.2 (N4): r_used and r_cl per trial, their medians, L and the gate (A.2.31)
export function nGate(rows: ReadonlyArray<{ sd: number; meanUsed: number; meanWider: number }>, M: number): { rUsed: number[]; rCl: number[]; rUsedMedian: number | null; rClMedian: number | null; L: number; usedInRange: boolean; clLe115: boolean; allLeL: boolean; pass: boolean };

// 8.2–8.4
export function strataOf(t: BlindTable, rows: Int32Array, plant?: string): { strata: StratumAgg[]; N: number; noBlind: number };   // plant blindNoHour
export function deltaOf(t: BlindTable, rows: Int32Array, plant?: string): number | null;   // plant noBlind (B_s = 0)
export function aOf(t: BlindTable, rows: Int32Array): number | null;
export function plOf(t: BlindTable, rows: Int32Array): number | null;
export function plExtras(t: BlindTable, rows: Int32Array): PlExtras;
// Δ of the signals that pass sigKeep, against the blind rows that pass blindKeep (C2, C3, C6)
export function deltaWhere(t: BlindTable, rows: Int32Array, sigKeep: (r: number) => boolean, blindKeep?: (r: number) => boolean): number | null;

// 8.5
export interface EstOpts { w0: number; shift: boolean; plant: string }
export function estDelta(t: BlindTable, rows: Int32Array, o: EstOpts): ValueEst;   // plant inflStratumMean
export function estA(t: BlindTable, rows: Int32Array, o: EstOpts): ValueEst;
export function estPl(t: BlindTable, rows: Int32Array, o: EstOpts): ValueEst;
export function estDiff(t: BlindTable, rowsA: Int32Array, rowsB: Int32Array, o: EstOpts): ValueEst;   // 8.6: week and 4w only, widest t975 × se
export function shiftRows(t: BlindTable, rows: Int32Array, k: number, plant?: string): { rows: Int32Array; dropped: number };   // plant shiftNoWrap
export function choose(value: number | null, N: number, cands: SeCand[]): Pick<ValueEst, "hasT" | "useLB" | "useP" | "t" | "p" | "lb" | "ub">;   // 8.5's choices (A.2.7)
export function withKappa(e: ValueEst, kappa: number): ValueEst;   // max(1, κ) × every se, then choose again
export function nonOverlap(t: BlindTable, rows: Int32Array, nBars: number): { N: number; delta: number | null; pl: number | null };   // 21.5
export function measureTrial(t: BlindTable, late: BlindTable, tr: TrialRows, o: { w0: number; plant: string; dF: { rows: Int32Array; against: string } | null }): TrialMeasures;
export function measureBlindRows(t: BlindTable, late: BlindTable, w0: number): TrialMeasures[];   // 8.7: the 10 pair × direction rows (a, W, PL; Δ is 0 by definition)
```

The arithmetic follows spec 8 and 21.5, in their written order:

- **Strata**:
  - n_s counts the signal rows of the stratum. m_s counts the blind rows.
  - sigMean = Σ (h ÷ 2) over the signals, in row order, ÷ n_s. B_s is the same over the blind rows.
  - blindPlMean = Σ (pl ÷ 10) ÷ m_s. absMMean = Σ (|m| ÷ 10) ÷ m_s.
  - A stratum with signals and no blind row adds to noBlind.
- **Δ** = 100 × Σ over strata by ascending id of `(n_s ÷ N) × (sigMean − B_s)`, with the 100 multiplied last. Δ′ =
  Δ ÷ 100.
- **a** = `(100 × (Σ h ÷ N)) ÷ 2`.
- **PL** = Σ (pl ÷ 10) in row order ÷ N.
- **W** = Σ (pl > 0) ÷ N.
- **Influence functions** (8.5), computed per row in row order:
  - Δ, signal row: `(h ÷ 2 − B_s − Δ′) ÷ N`, with d_i = h ÷ 2 − B_s computed first.
  - Δ, blind row: `−(n_s ÷ N) × (h ÷ 2 − B_s) ÷ m_s`. It is 0 for a stratum without signals, and the row still
    counts for C.
  - PL: `(pl ÷ 10 − PL) ÷ N`.
  - a: `(h ÷ 2 − a′) ÷ N`.
  - S_g sums, per cluster, the influence of every row of the table in row order (the signal's before its blind row's
    at one row).
  - SE = `Math.sqrt((C / (C − 1)) * ΣS_g×S_g)`, with Σ over clusters ascending, then × 100 for Δ and a. C counts the
    clusters with any table row.
  - Plant `inflStratumMean`: the signal influence subtracts the stratum's mean of d_i in place of Δ′.
- **Candidates**:
  - week (df = C_week − 1).
  - 4w, only when C_4w ≥ `FOUR_WEEK_MIN_C`.
  - shift: k = 1 … W_h − 1 over `t.weeks`. For each k, `shiftRows` moves the signal rows only (Δ's rows: those with a
    trade and a blind stratum; Δ_late's: its rows), each to its week's k-th successor in `t.weeks`, wrapping around.
    T′ = T + (w′ − w) × WEEK. The row is looked up by rowKey(pi, T′, d); an absent one is dropped. The stratum is the
    row's own (late: T′ + 15 min).
  - A k with no signal left is skipped. K = used k. SD_shift = sdTwoPass(values) when K ≥ 2.
  - The shift candidate has se = SD_shift and df = C_week − 1.
- **choose**:
  - Each candidate's t = value ÷ se. There is no t when C < 2, N = 0, isZero(se), or (shift) K < 2.
  - p = pOneSided(t, df).
  - When any used candidate has no t, there is no t: p = 1, and lb and ub are null.
  - useLB is the largest q975 × se; useP is the largest p. Ties go to week, 4w, shift.
  - t is useP's t. lb and ub are value ∓ useLB's halfWidth.
- **estDiff** (D_F):
  - Per row, the difference of the two influence functions is taken first (an absent row counts 0). The differences
    are then summed per cluster in row order.
  - Week and 4w (4w when C_4w ≥ 10); the wider q975 × se is used (ties: week). There is no shift candidate.
- **κ** (stage 2): `withKappa` multiplies each of the three candidates' se by max(1, κ) and calls `choose` again.
  κ_Δ applies to Δ only and κ_PL to PL only (spec 11).
- `measureTrial` makes `deltaLate` with `estDelta` on the late table and lateRows, with the same w0. Its interval is
  the uncorrected two-sided 95% one (C4 reads its lb). `plLate` is a point only.

### 6.3 `research/money-stats.ts` (one export added; nothing else changes)

```ts
// spec 8.5 (法則探し): the upper tail U(x, ν) = ½ × I_{ν÷(ν+x×x)}(ν÷2, ½) for x ≥ 0, by the same ibeta as tCdf
export const tUpperTail = (x: number, df: number): number => 0.5 * ibeta(df / 2, 0.5, df / (df + x * x));
```

---

## 7. Builder D: decisions, checks and the program

### 7.1 `research/lawsearch-select0.ts` (stage 0; no trade or stats import)

```ts
import type { Stage0Half, Stage0Row, TfKey, TfSet, TrialDef, TrialSignals } from "./lawsearch-types.ts";

export interface SigList { pi: Int8Array; T: Float64Array; d: Int8Array }   // a trial's counted first-half signals, row order
export function countedList(sig: TrialSignals, half: "first" | "second"): SigList;
export function blindStrataOf(tf: TfSet, passing: Uint8Array[]): Set<number>;   // strata of passing bars with an entry bar (entryExitIndex), both directions
export function stage0Half(sig: TrialSignals, half: "first" | "second", tf: TfSet, blindStrata: Set<number>): Stage0Half;
export function floorPass(r: Pick<Stage0Row, "first" | "second">): boolean;   // ≥ 300 counted and ≥ 30 weeks, both halves
export function sameTrials(rows: ReadonlyArray<{ id: string; tf: TfKey; order: number; list: SigList }>): Map<string, string | null>;
export function overlapShare(a: SigList, b: SigList, step: number): number;   // share of a's signals with a b signal (same pair and direction, |ΔT| ≤ step)
export function overlapGroups(rows: ReadonlyArray<{ id: string; tf: TfKey; order: number; kind: "EF" | "S" | "B" | "R"; e: string | null; b: string | null; floor: boolean; list: SigList }>, step: Record<TfKey, number>): Map<string, string>;
export function mdeOf(g: number, n2: number, df: number, K: number): { se: number; passMin: number; mde: number; mark: boolean };   // spec 9 (K = 6 at stage 0)
export function gOf(meanUsedSe: number, n1: number): number;                   // spec 9: (meanUsedSe ÷ (50 ÷ √n1))²
export function plEstimate(sdPips: number, g: number, n2: number, df: number, K: number): { se: number; topHolm: number };   // spec 9 PL の見込み: se = sd × √(g ÷ n2); topHolm = t(1 − 0.025 ÷ K, df) × se
export function stage3Estimate(n2: number): number;                             // spec 9: n2 × 52 ÷ 76
export function stage0(sigs: TrialSignals[], tf: Record<TfKey, TfSet>, passing: Record<TfKey, { first: Uint8Array[]; second: Uint8Array[] }>, g: Record<string, number>, gDf: Record<string, number>, plant?: string): Stage0Row[];   // (C3) plant dropSecondStrata (8)
```

- **Counting ranges** (spec 9, 15):
  - First half: ① is counted only for T < SPLIT. ②–⑥ and noBlind are counted for the half's signals. f_none and both
    are counted by the half's T/X rule (`Classified.half`).
  - Second half: the same numbers. Only counted and weeks are printed per trial; the rest go into totals.
  - `r1All`, `r1b` and `r1w` cover the whole read range.
  - `addsUp`: emitted = Σ (r1, r1w, r1b, r2 … r6) + counted.
  - (C3, 2026-11-05) `emitted`, `r1All`, `r1w` and `r1b` are written only as per-timeframe sums in
    `stage0_totals.csv`; per trial, stage0.csv keeps `all.adds_up` (`lawsearch-dump.md` 7, the lead's D1).
  - (C3, 2026-11-05) `noBlind` of either half above 0, for any trial, is a program error (spec 6): `runStage0` stops
    (7.4). No per-trial noBlind number of the second half is written.
- **perWeek** = counted ÷ `HALF_WEEKS[half]` (11 O-6).
- **Same trial**: the counted first-half lists are compared as sets of (pi, T, d) of the same timeframe. A trial with
  0 signals is not compared. The name given is the earliest trial in table order with the same set.
- **Groups**:
  - Fixed links: the 15 trials of one E; `FIXED_E_GROUPS`; `FIXED_B_GROUPS`.
  - Overlap links: between floor-passing EF and B trials of one timeframe, `max(share(A→B), share(B→A)) ≥
    OVERLAP_SHARE`.
  - Union-find over both kinds of link. The group's name is its first trial in table order. Every S row is a group of
    its own, and never a link (21.5).
- **MDE** (9):
  - se = 50 × √(g ÷ n2); passMin = tq(1 − 0.025 ÷ K, df) × se; mde = (tq(1 − 0.025 ÷ K, df) + tq(0.80, df)) × se.
  - mark = passMin ≥ `MARK_PASS_MIN`.
  - Without g (the trial), the five fields are null.

### 7.2 `research/lawsearch-select.ts` (stages 1 and 2; spec 10, 11, 13)

```ts
import type { HalfName, Stage1Cand, Stage1Out, Stage2Cand, Stage2Row, SuspectRow, TrialMeasures } from "./lawsearch-types.ts";

export function failRuleOf(c: Stage1Cand, q4: "a" | "b", plant?: string): number;   // 0, or the first of rules 1–6; plants noEx1Week, noDF
export function chooseStage1(cands: Stage1Cand[], q4: "a" | "b", plant?: string): Stage1Out;
export function skipText(reason: "same-group" | "S-then-EF" | "EF-then-S", by: string): string;   // the labels below
export function stage1Explain(cands: Stage1Cand[], pIut: Map<string, number>): Stage1Explain;
export function bhCount(ps: readonly number[], q: number): number;                  // 21.5: the largest k with p_(k) ≤ k × q ÷ m
export function suspectOf(m: TrialMeasures): Omit<SuspectRow, "checks" | "checksPassed">;   // 13's lines (M from extras)
export function holm(cands: Stage2Cand[], K: number, which: "iut" | "delta", plant?: string): Map<string, { rank: number; pass: boolean; p: number }>;   // plants noHolm, iutOneLeg
export function conditionsOf(c: Stage2Cand, holmPass: boolean, q4: "a" | "b", plant?: string): [boolean, boolean, boolean, boolean, boolean, boolean, boolean];   // plant c4PointOnly, noEx1Week
export function verdictOf(C: readonly boolean[], deltaUb: number | null, holmDeltaPass: boolean): 1 | 2 | 3 | 4 | 5;
export function verdictLabel(v: 1 | 2 | 3 | 4 | 5, failed: number[], q2: "a" | "b"): string;
export function stage2Rows(cands: Stage2Cand[], K: number, q2: "a" | "b", q4: "a" | "b", plant?: string): Stage2Row[];
```

- **Rules 1–6, ordering and skipping**: spec 10. The order is lb descending, then n descending, then table order.
  Skipping:
  - same group: S rows are only their own group;
  - "S-then-EF": an S_F was chosen and this is an (E, F) with the same F name (F01r is another F);
  - "EF-then-S": the reverse.
- **Holm** (11): p ascending; ties by min(t_Δ, t_PL) descending (delta-only: t_Δ), then n descending, then table
  order; p = 1 ties by n, then table order. The test is `p_(k) ≤ 0.025 ÷ (K − k + 1)`, stopping at the first
  failure.
- **C2 / C3** look at directions and pairs with ≥ `C_MIN_N` counted signals (counted, with or without a trade; 11
  O-7). Their Δ is `deltaWhere`, which keeps the blind rows (strata are per pair and direction already).
- **C6** uses `deltaWhere` with both the signals and the blind rows kept to the part's weeks.
- **Labels** (fixed by A.2.20 and A.2.23; exact strings, the Python's too):

  | what | label |
  |---|---|
  | verdict 1, q2 (b) | `後半で確かめられた（問2 は (b) なので「法則の候補」。段3を待つ）` |
  | verdict 1, q2 (a) | none defined: the owner answered (b), and no example fixes this text. `verdictLabel` throws for (a). |
  | verdict 2 | `悪い` |
  | verdict 3 | `一部（満たさなかった条件: C3・C4・C7）` (the failed conditions, joined by `・`) |
  | verdict 4 | `向きだけ` |
  | verdict 5 | `言えない` |
  | D_F lower end ≤ 0 | `合図 E を足した分の上積みは言えない（F だけの行と区別できない）` |
  | skip, same group | `同じ重なりの組（<the chosen trial>）` |
  | skip, S-then-EF | `選んだ <S> と同じ F の (E, F)` |
  | skip, EF-then-S | `選んだ <EF> と同じ F の S` |

  `<…>` is the trial's name as the caller gives it: the trial id in a run, the example's name in a hand example.

### 7.3 `research/lawsearch-checks.ts` (spec 15; stage-0 safe)

```ts
import type { CheckResult, Classified, Ind, Probe, TfKey, TfSet, TrialDef, TrialSignals, Universe } from "./lawsearch-types.ts";

export function checkRulesFiles(root?: string): Promise<CheckResult>;       // lawsearch-const checkFiles + checkConstants; the ledger's 1,364 rows
export function dataCheck(u: Universe): CheckResult;                         // dataProblems
export interface CutTarget { tf: TfKey; pi: number; k: number; kinds: string[] }
export function cutTargets(u: Universe, trials: TrialDef[], sigs: TrialSignals[], o: { htf: "even" | "all"; fromStart?: number; stats?: Record<string, number> }): CutTarget[];   // deduplicated per (tf, pi, k); spec 23.2: htf "even" = 300 boundary targets per tf and pair (stage 0), "all" (the chosen trials); fromStart: the second half's targets only
export function cutCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], targets: CutTarget[], avoid: ReadonlySet<string>, o: { answerKnowing: boolean; plant: string; maxTargets?: number; times?: Record<string, number>; name?: string; timeKey?: string; maxExamples?: number; note?: string }): CheckResult;   // name "cut" (stage 0), "cut.chosen.first", "cut.chosen.second"
export function poisonCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { n: number; seed: number; answerKnowing: boolean; plant: string; only?: string[] }): CheckResult;   // (C4f) no ExclCtx option: the units make the uncut holes
export function presenceCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { seed: number; answerKnowing: boolean; plant: string; only?: string[] }): CheckResult;
// (C4b) the three above are async (Promise<CheckResult>) and take o.runner; (C4g, 2026-11-10) o.runner is REQUIRED: a
// pool of workers (lawsearch-par.ts checkPools); inPlace, which ran the units in this thread, is removed
// (C4g) retraceCheck(read, runDir, rows): read gives a raw file's text from the bytes read at gate 3 (lawsearch.ts readOf)
export function h1OnlyCheck(u1: Universe): CheckResult;                       // every bar of stage 1 has T ≤ SPLIT
export function sameFirstHalfCheck(s0: TrialSignals[], s1: TrialSignals[]): CheckResult;   // stage 1's first-half counted sets = stage 0's
export function addsUpCheck(rows: ReadonlyArray<{ trial: string; addsUp: boolean }>): CheckResult;
export function donchianCheck(u: Universe, inds: Record<TfKey, Ind[]>): CheckResult;   // E26's s = bigflow-lib donchianState(c, 20), all bars
export function retraceCheck(runDir: string, rows: ReadonlyArray<{ pair: string; tf: TfKey; T: number; d: 1 | -1; pl: number; m: number }>): Promise<CheckResult>;   // 13 (iv): raw files, no loadTf
export const PRINT_KEYS: readonly RegExp[];
export function printCheck(keys: readonly string[]): CheckResult;            // 15 出してよい項目
export function sampleOf<T>(xs: readonly T[], n: number, seed: number): T[];  // mulberry32 + Fisher–Yates (trend-stats'), the first n
// ---- (C4f, 2026-11-08; the lead's H1–H3) the checks' inputs apart from the main run's
export interface CheckInputs { u: Universe; trials: readonly TrialDef[]; avoid: ReadonlySet<string> }   // what the checks of one stage read besides the main run's results
export const snapshotOf: (u: Universe) => Universe;                                // structuredClone(u)
export function reachOf(roots: readonly unknown[]): Set<object>;                  // every object reachable through own enumerable properties, array, Set and Map entries; a typed array and its ArrayBuffer (not walked further)
export function assertApart(main: ReadonlySet<object>, check: readonly unknown[], where: string): void;   // throws "SHARED: …" when an object reachable from check is in main
export function universeDigest(u: Universe): Promise<Map<string, string>>;        // path → SHA-256 of each typed array, or the value of each other leaf
export function digestDiff(want: ReadonlyMap<string, string>, got: ReadonlyMap<string, string>, max?: number): { n: number; paths: string[] };
export function sealTask<T extends UnitTask>(task: T): T;                          // a frozen copy of a check run's task: frozen trials list and trials, read-only avoid table
// (C4g, 2026-11-10; the lead's G4) the allow-list for a check run's task: exactly its kind's UnitTask keys, a plain
// object, every trial one of chk.trials (by identity), avoid === chk.avoid; anything else throws "SHARED: …" (exit 1)
export function assertTaskAllowed(task: UnitTask, chk: CheckInputs, where: string): void;
```

- **Cut**: spec 15, with spec 23.2 (rewritten C3, 2026-11-05; the lead's D7).
  - Targets, per trial and pair: every signal (every row of `Classified`, any reason; over 3,000 → `sampleOf(…,
    3000, 318)`), 300 evenly spaced bars, the 10 bars before every gap (open to open over one step), the 2 bars
    before each day boundary (dayOf changes), and the 2 bars before each higher-timeframe boundary, picked by stage:
    - **Stage 0** (check `cut`, every trial; `cutTargets` htf `"even"`): the higher-timeframe boundary targets are
      300 per timeframe and pair. Their n candidates are put in time order, and the j-th pick (j = 0 … 299) is the
      floor(j(n − 1) ÷ 299)-th of them; all n when n ≤ 300. The other kinds are as above.
    - **Stage 1's end** (check `cut.chosen.first`, stage `stage1end`; the chosen trials only; htf `"all"`): every
      boundary target of the first half, on stage 1's universe, after the choice and before stage 2 opens. A failure
      names the trials and their failing bars and keeps stage 2 closed (7.7).
    - **Stage 2** (check `cut.chosen.second`, stage `stage2`; the chosen trials only; htf `"all"`, `fromStart` =
      SPLIT): every boundary target of the second half, and the other kinds of the second half. A failure withholds
      stage 2's numbers (7.7).
    - The halves (settled by the lead 2026-11-05, D11): the first half is stage 1's whole universe [S0, SPLIT),
      its warm-up bars before START included. The second half is the bar targets (signal, even) whose start is ≥
      SPLIT, and the boundary targets (gap, day, htf) whose boundary bar starts ≥ SPLIT; so the boundary at SPLIT
      belongs to stage 2 (stage 1 has no bar after it). The second half's "300 evenly spaced bars" are picked over
      the second-half bars. In stage 2 the entry-bar sub-check still covers all the trial's counted signals.
  - Targets are deduplicated per (tf, pi, k), and every trial of the timeframe is decided at each target.
  - At target k, every trial of the timeframe is recomputed on the cut for k alone, as below. The decision at k
    (presence, direction, status, warmOk), its reason and its stratum must equal the uncut run's.
    - (C4d, 2026-11-07; C4c's review, finding 4) Reworded to the code (`cutGotAt`, the same since b3a2c43 apart from
      the window removed below). Until C4d this bullet said "`cutTfSet(tf, T_k)`, `indOf` on the cut pair,
      `candidatesOf`, and `classify` with `exclCtxOf(cut, …, fromMs: S0, toMs: T_k)`", which no version of the code
      did. The code:
      - The cut is `prefixSeries(s, T_k)` of the target's pair alone: its bars with T ≤ T_k, that is bars 0 … k.
        The other four pairs give only their bar starts, for the holes (those with start ≥ the holes' first slot
        and T ≤ T_k). `cutTfSet` is not called (4.1; removed in C4e).
        - (C4e, 2026-11-08; the lead's G1) The cut is a copy that holds bars 0 … k only: each of its 28 typed arrays
          has a memory block of its own (4.1 `copyOf`), with the same values bit for bit. Until C4e it was a set of
          subarray views of the uncut arrays, whose memory block still held every bar after k. The bar starts given
          to `holesOf` are copies of their range too (`p.s.slice(…)`, until C4e `p.s.subarray(…)`).
      - The Ind is `indFor(cut)`: `indOf` of the cut, with higher bars rebuilt from the cut (`coarsenSeries`,
        `htfIndex`) only when a trial of the timeframe reads them (`readsHigher`: F02, F02r or S02; no trial of the
        small trial does). One Ind of the cut is shared by every trial decided at k.
      - Each trial's decision at k is `decisionOf`: `candidatesOf` walks the cut from bar 0 to bar k. Then each row
        at k gives `d:status:warm:reason:stratum`. The reason of an `emit` row comes from `reasonOf` at bar k alone;
        a `f_none` or `both` row takes its status as its reason. `classify` is not called: 12.2 (1) says why this
        equals the main run's `classify` and what it rests on.
      - The `ExclCtx` is made directly, not by `exclCtxOf`. Its holes are `holesOf` over the slots
        [s_{k−9} − `HOLE_MIN_SLOTS` × step, T_k), not [S0, T_k). ③ at bar k reads only the slots of [s_{k−9}, T_k),
        and a hole that reaches into them is a hole in the shorter range too. The argument is in the
        `lawsearch-checks.ts` header. It is b3a2c43's reading.
  - The entry bar of every counted signal must be the uncut series' first start ≥ T and < X.
  - A finite item (B06: 291 bars, §8.113 C17) may be recomputed on `windowSeries(s, k − 290, k)` with its global
    index. Every other item in the trial uses the cut prefix from bar 0.
    - (C4d, 2026-11-07; C4c's review, finding 1; the lead's F1) **Removed.** Every item, B06 included, is now cut
      on its prefix from bar 0, as spec 15 says (切った列). `FINITE_BARS`, `finiteOf` and the window branch of
      `cutGotAt` are gone; no spec text changes.
      - Why: the window gave B06 at most one raw signal before k, and its series always had 291 bars. So a
        look-ahead carried by state across bars, by rows already emitted, or by the series' length n was never seen
        by the cut on B06. By C4c's reviewer, the other checks did not cover it either: poison keeps n and never
        probes the last bar, and presence (ii) meets the series' end only for probes in the data's last week. This
        was not a regression against b3a2c43 (the same window since 837c02e), but it contradicted C4c's rule 2.
      - Evidence (8's `carriedCountB06` row): look-aheads of the three kinds on B06's path were missed with the
        window and caught without it.
      - The run plant `carriedCountB06` (8; 7.8 syn step 3) guards it now. Rule 1 holds: the identity runs give the
        same bytes (12.1's C4d paragraph). The cost, and `bigmoveOf`'s exact rewrite that lowers it (5.1): 12.4.
  - Time is printed per timeframe (spec 18).
  - (C3, 2026-11-05; the lead's D6) Every failing bar of `cut`, `cut.chosen.first` and `cut.chosen.second` goes to
    `ts/cut_fail.csv` (`lawsearch-dump.md` 8, TS only; always written, with its header): check, stage, trial, pair, k,
    s, kinds (`entry` for the entry-bar sub-check), and the cut and uncut decisions. `cutCheck` keeps every failing
    bar for this file; the STOP line, the `checks.csv` detail (`maxExamples`, 100 per trial) and print.txt's
    400-character detail keep their caps. Reason: spec 23.2 その試しの名前と外れた足を出す.
    - (C4a, 2026-11-05; the lead's E7, the C3 TS runner's question and C3 review finding 4) The file gets a column
      `T` right after `s`: the bar's close time in ms (`s + step`), which is the time the `checks.csv` detail and the
      STOP line print (`iso(T)`), so the two can be matched. The columns are now `check,stage,trial,pair,k,s,T,kinds,
      cut,uncut`. For `entry` rows, k, s and T are the signal bar's. `lawsearch-dump.md` 8 now words the decision
      fields as the code writes them: each candidate at k is `d:status:warm:reason:stratum`, the candidates are
      joined by `;`, the field is empty when there is no candidate, and the plant `chosenCutFirstDiff` adds
      `;planted` (`none;planted` with no candidate). It stays TS only and is not compared.
    - (C4a, 2026-11-05; the lead's E5) `cut_fail.csv` is sealed until stage 2 (`lawsearch-dump.md` 12): a failing
      stage-0 cut lists second-half bars of any trial. No code change.
  - (C3) A development cap (`CUT_MAX`, 7.7) caps the targets of all three checks; the run then writes `cut_max` into
    `config.json` and still prints `DEVELOPMENT CAP` in the checks' detail.
    - (C4a, 2026-11-05; the lead's E8, C3 review finding 5) It caps every cut check, not only those three: `cut`,
      `cut.chosen.first`, `cut.chosen.second`, and the 13 (i) cut of hit trials, `suspect13.cut.stage1` and
      `suspect13.cut.stage2` (`suspicionChecks` passes `maxTargets` to `cutCheck` too). print.txt's `note.cut_max`,
      `lawsearch-dump.md` 2 and this bullet name all five. Before, the note named only the first three. (E9)
      `checks.csv` gets no cap marker: `config.json`'s `cut_max` and print.txt suffice, and the Python's `--run`
      refuses a capped run.
- **Poison**: 100 signals and 100 bars without a signal of each trial (`sampleOf`, seed 319; 13 (ii): 1,000, seed
  419, on the hit trials). The trial's pair, in the trial's timeframe, is given `poisonSeries` after T, and its
  higher bars are rebuilt from the poisoned series when a trial reads them. Its decision is recomputed with the
  uncut run's holes. The decision and the reason at T must be equal.
  - (C4d, 2026-11-07; the C4d integrator's observation) Reworded to the code (`poisonGotAt`, the same as
    b3a2c43's poison loop). Until C4d this bullet said "Every series of the five pairs (m15 and h1) is given
    `poisonSeries` after T, and the higher timeframes are rebuilt. Everything is recomputed", which no version of
    the code did. The other pairs and the other timeframe are not poisoned (the trial loads no 1-minute bars).
    The decision at T reads none of them: its Ind is made from the trial's pair's series alone, and the holes read
    only bar starts, which poison does not change. So poisoning them could not change the decision, as long as
    12.2 (2)'s condition holds. This reading of spec 15's 毒 (確定が T より後のすべての足) is for the lead to
    confirm (11 O-14). The `lawsearch-checks.ts` header still says "the trial's timeframe's five pairs".
    - (C4e, 2026-11-08) Fixed: the `lawsearch-checks.ts` header's poison bullet and the comment above
      `poisonCheck` now say "the trial's pair in the trial's timeframe" and give the argument below.
  - (C4e, 2026-11-08; the C4d docs writer's question; the lead's G5) **The poison's scope, shown from the code.**
    Spec 15's 毒 adds ±777.7 pips to every bar whose close is after T (15-minute, 1-hour and 1-minute bars).
    `poisonGotAt` poisons the trial's pair in the trial's timeframe alone (`poisonSeries` after T) and keeps the
    uncut run's holes. The lead accepts this reading only if it is exact: the decision at T must read nothing else
    that the spec's 毒 would change. What `poisonGotAt`'s `decisionOf(trial, indFor(ps, …), ctx, ps, i, …)` reads:
    1. `candidatesOf(trial, ind)`. Its builds go through `buildOf`, kept on the Ind, and read the Ind alone
       (`lawsearch-items.ts`: `ind.series`, `ind.rsi`, `ind.ema`, `ind.donchian`, `ind.bigmove`). The Ind is
       `indFor(ps)`: `indOf` of the one poisoned series. When a trial reads the higher timeframe (`readsHigher`: F02,
       F02r, S02), its higher bars are rebuilt from that poisoned series by `coarsenSeries` and `htfIndex`; the main
       run's higher bars are coarsened from the pair's own series too (`tfSetOf`). `indOf` reads only the series and
       the higher series it is given, and its caches live in the Ind.
    2. `reasonOf(ctx, ps, i, warmOk)`. It reads the bar's close time T = `ps.T[i]`, the start
       `ps.s[max(0, i − 9)]`, the pair (`ps.pi`, `ps.pair`), and the `ExclCtx`: the step, stage 3's dates (none
       here), the plant, the holes and the avoided slots. The holes are the uncut run's (`exclCtxOf` or
       `ctxOfUniverse` of the uncut timeframe), made by `holesOf` from the five pairs' bar starts alone. The avoided
       slots come from a ledger file. ① ①b by `halfOf`, ② `r2`, ④ `r4` and ⑤ `r5` read times only; ⑥ `r6` reads the
       avoided slots by pair and time; ③ `r3` reads the holes. No price is read.
    3. `stratumOf(ps.pi, d, ps.T[i])`: the pair, the direction and T.

    So the decision at T reads no other pair's prices, no bar of the other timeframe's loaded series, and no 1-minute
    bar (the series keys are m15, h1 and h4 only, `lawsearch-types.ts` `SeriesKey`; the program reads no 1-minute
    file). It reads no higher bar that is not rebuilt from the poisoned series. Poison changes prices, never which
    bars exist or when they start, so the uncut holes are the poisoned timeframe's holes. Poisoning the other pairs,
    the other timeframe and the 1-minute bars as the spec's words say could therefore not change the decision. This
    holds under 12.2 (2)'s condition (no module-level state that survives between `candidatesOf` calls), as every
    claim about the checks' series does. No code change; the outputs are unchanged. The same argument is in the
    `lawsearch-checks.ts` header (the poison bullet). The C4e integrator found nothing else reachable; the C4e docs
    writer read the same functions (`decisionOf`, `indFor`, `poisonGotAt`, `reasonOf`, `exclCtxOf`, `ctxOfUniverse`,
    `indOf`, the item builds) and found nothing else either.
    - (C4f, 2026-11-08; C4e's review, the power reviewer; the lead's H1, H2 and H9) **The argument's premises.** It
      rests on the poisoned series, its holes, the trial definition and the avoid table holding nothing that the main
      run left there. Until C4f they did not hold by construction. The poisoned series was copied from the arrays the
      main run had been handed, so a value the main run's code wrote into them sat in it (the plant
      `seriesStashE04` on fcce9e6: poison found 0 of 200 differing on every trial; 8). Stage 0 passed the main run's
      own `ExclCtx` (from `ctxOfUniverse`) to `poisonCheck` for the holes, and the trial definition and the avoid
      table were the main run's objects.
      - Since C4f these premises hold by construction (H1; the C4f bullet below). The poisoned series is made from
        the stage's snapshot, which no main-run code has had. The holes are always made by the unit, by `exclCtxOf`
        on its own thread's copy of that snapshot, once per timeframe and task (`UnitCache`). `poisonCheck` takes no
        `ExclCtx`, so "the uncut run's holes" in 2. above now means holes made the same way from the same bar
        starts, never the main run's object. The trial definition and the avoid table are the checks' own.
      - H2 freezes them as well (5.2, 5.3; `sealTask` below), as defense in depth.
      - The one premise left is 12.2 (2)'s: no module-level state that survives between `candidatesOf` calls. At
        `WORKERS=0` the checks run in the main thread's own module instances, so such state still passes between the
        main run and the checks there.
      - The `lawsearch-checks.ts` header's poison bullet says the same.
      - (C4g, 2026-11-10; the lead's T and G2) Corrected. Poison's units now run only in the kept probe pool's workers,
        which have no permission and in which no main-run code ever ran, at every `WORKERS`. So no state the main run
        keeps reaches them: module bindings, realm globals, the environment and files. The premise left is narrower: no
        state that one poison or presence unit leaves for a later one in the same worker of the same run (12.2 (2);
        12.7, residual 2).
        - Even without such state, poison catches a naive look-ahead only. Its poisoned bars are the real ones shifted
          by ±7,777 points by parity, so they are exactly invertible (12 rule 2, the threat model).
        - The `lawsearch-checks.ts` header says the same.
- **Presence** (the same 100 signals):
  - (i) the first two bars with T > T_signal of the signal's pair, in the trial's timeframe, are deleted;
  - (ii) every bar with T > T_signal and start < the next Sunday 22:00 UTC, in the trial's timeframe of all five
    pairs, is deleted (11 O-8).

  The higher bars are rebuilt and everything recomputed. The decision must be equal.
- (C4b, 2026-11-05; the owner's answer 「まず速くする」) Any speed-up of `cutCheck`, `poisonCheck` or `presenceCheck`
  (or of what they call) keeps the speed-up rules of 12: the outputs do not change, the checks keep their power, the
  bytes do not depend on the number of workers, and what is checked and how many targets and probes there are stay
  as above.
- (C4c, 2026-11-07; C4b's review, findings 1 and 3) How the three checks recompute a decision, as the code now is:
  - Each check is a list of units, one recomputed decision each:
    - `cut`: one (target k, trial), on the target's pair cut at T_k (`cutGotAt`; corrected C4d, 2026-11-07, from
      "the five pairs cut at T_k": only the target's pair is cut for the Ind, and the other pairs give only their
      bar starts with T ≤ T_k, for the holes; the Cut bullet above);
    - poison: one probe bar i of one trial, on its pair poisoned after T_i (`poisonGotAt`);
    - presence: one (probe bar i, variant (i) or (ii)) of one trial, on the timeframe with those bars deleted and
      its holes made again (`presenceGotAt`).

    These three functions are the checks' loop bodies of b3a2c43, moved into functions in C4b (poison's with the
    poison tables of 12.1 item 6). Every check of 7.7's
    pipeline that cuts, poisons or deletes uses them: `cut`, `cut.chosen.first`, `cut.chosen.second`, `poison`,
    `presence`, and 13's `suspect13.cut.*`, `suspect13.poison1000.*` and `suspect13.presence.*`.
  - A unit's decision is `decisionOf` on the unit's own series and its own Ind (`indFor`: the higher bars rebuilt
    from that series when the trial reads them):
    - spec 5's rows come from `candidatesOf` (5.3), the main run's own function, which walks every bar of that
      series from bar 0 (a cut series ends at its target, so the walk ends there). (C4d, 2026-11-07) This now holds
      for every item: until C4c, B06 walked its 291-bar window instead (the Cut bullet above);
    - then each row at the compared bar gives `d:status:warm:reason:stratum`, with the reason from `reasonOf` and
      the unit's own `ExclCtx`: the cut's holes; for poison, the uncut run's holes (poison changes prices, never
      which bars exist); for presence, holes made again from the edited timeframe.
    - (C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's q1; the lead's G1) **Every
      series a unit hands to `decisionOf` has typed arrays of its own that hold its own bars only**, so code that
      reads a series through its memory block (a typed array or `DataView` over `C.buffer`) reads nothing the series
      does not hold.
      Where each one comes from (the C4e integrator's audit, checked again in the code by the C4e docs writer):
      - cut (stage 0's `cut`, `cut.chosen.first`, `cut.chosen.second`, `suspect13.cut.*`; all through `cutGotAt`):
        the prefix is `prefixSeries`, now a copy (4.1 `copyOf`); each pair's bar starts for the holes are copies of
        their range (`slice`);
      - poison (`poison`, `suspect13.poison1000.*`): `poisonSeries` makes fresh arrays (with the poison tables,
        `slice` of the whole series, then `set` from the table from bar k0 on; without them, `shifted`, which slices);
      - presence (`presence`, `suspect13.presence.*`): `deleteBars` makes fresh arrays of the kept length. In variant
        (i) the other four pairs are the universe's own series, unedited and whole (they give only bar starts, for the
        holes); in variant (ii) all five are `deleteBars` copies;
      - the higher bars and g, when a trial reads them: `coarsenSeries` (through `seriesOf`) and `htfIndex` allocate
        new arrays;
      - the universe itself: `seriesOf` allocates every array (`new Float64Array(n)`, `new Int32Array(n)`), and a
        worker gets the universe by structured clone, which copies each array with its own memory block. The stage
        universes are loaded separately, so they share no memory block either. (C4f, 2026-11-08) The universe a check
        is given is now the stage's snapshot (a structured clone taken right after loading, the C4f bullet below),
        and a worker gets a structured clone of that snapshot, so every series a unit copies from comes from arrays
        no main-run code has had. (C4g, 2026-11-10) A probe worker still gets the whole snapshot this way (`shipOf`). A
        cut worker gets the snapshot without bars and then, job by job, the bars of its timeframe up to each target
        (deltas, the C4g bullet below). It keeps each array as a `subarray` view of the filled part of an array that
        doubles when full; past the filled part that array holds only zeros, never a bar. Every series a cut unit hands
        to `decisionOf` is still `prefixSeries`, a copy of that view's bars 0 … k (`copyOf`). So the statement above
        holds for the cut too.

      Until C4e the cut prefix (and before C4d B06's window) was a set of subarray views of the uncut arrays, so this
      did not hold for the cut. The only `.subarray(` calls left in `research/lawsearch*.ts` are the sources of a copy
      (`poisonSeries` twice, `deleteBars`) and the dump writer; the hand job's grep step keeps it so as defense in depth
      (7.8 hand step 9).
  - C4b's `candidatesAt` (the per-bar body run at bar k alone after `prepare`) is gone, and with it the CI step that
    sampled it (7.8). Reason: 12 rule 2.
  - Units share only what sees the same series. At one cut target, the cut's holes and the cut's Ind (with the builds
    kept on that Ind, `BUILDS`) are made once and read by every trial decided at that target. Poison's uncut holes
    (when the caller gives none) and its poison tables are made once per check in the main thread, or once per task
    on each worker, from that thread's copy of the uncut series (12.1). (C4f, 2026-11-08) No caller gives poison's
    holes any more (`poisonCheck` has no `ExclCtx` option), so they are always made this way: `exclCtxOf` of the
    trial's timeframe in the thread's copy of the check's universe, with the task's avoid table, kept in the task's
    `UnitCache`. (C4g, 2026-11-10) Since no unit runs in the main thread, they are made once per task on each probe
    worker only. (C4h, 2026-11-11; C4g's review, the lead's F3) A poison unit now reads only the cached `ExclCtx`'s
    holes: its `ExclCtx` is made again for the unit (`exclCtxFrom` of the cached holes) with the unit's own read-only
    copy of the task's avoid table (`unitAvoidOf`), and so is every presence unit's (`presenceGotAt` gets the copy). The
    task's table is read-only through its own `add`, `delete` and `clear`, but `Set.prototype.add.call` writes into any
    Set, so until C4h one unit could leave a value there for a later unit of the same probe worker and run (12.9 F3).
    The copy holds the same entries (the ledger's 111 avoided slots), so no decision changes; measured: nothing (12.9).
    The cut's units still share their task's table: they are fed in T order to workers made for the cut run, so the
    table can hold only entries made from bars at or before the current target.
  - The uncut decision ("want") is made in the main thread from the run's own signals (`decisionOfClassified`). A
    unit returns its decision only when it differs from want. The check then replays the units in its own order
    (target by target, trial by trial; probe by probe) and does there everything its loop did: `compared`, the
    examples, the rows of cut_fail.csv, the planted mark.
    - (C4g, 2026-11-10; the lead's G2, "fix 9.4" from the C4g designer "process") **A job no longer carries its want.**
      The pool sends every job with `wantAt` and `wantStr` empty (`NO_WANT_AT`). A unit returns every decision that
      is not `none`. The check's own thread makes each job's mismatches (`mismatchesOf`: a merge of the two ascending
      lists, the returned decisions and the wants that are not `none`) and replays them as before. So the main run's
      answer is never in the realm where the check's answer is made. The mismatches, and so every byte, are those the
      comparison in the worker gave until C4g.
  - A unit runs in the main thread (`inPlace`, `WORKERS=0`) or on a worker (`lawsearch-par.ts`, `WORKERS` ≥ 1; 7.7).
    The answers are replayed in job order, so the files are the same bytes for any `WORKERS` (12 rule 3).
    - (C4g, 2026-11-10; the lead's G2) **Superseded: no unit runs in the main thread at any `WORKERS`.** `inPlace` is
      removed, and every check takes a runner. `lawsearch.ts` passes the pair of pools of `lawsearch-par.ts`
      `checkPools(WORKERS)`, wrapped by the guard. Each pool has max(1, `WORKERS`) workers, so `WORKERS=0` means one
      worker in each pool and runs exactly as `WORKERS=1` does.
      - **The cut pool** gets every cut run, one timeframe of one cut check. It is made for that run and closed when
        the run settles. The check makes one job per target (`per = 1`; C4b–C4f put about 64 (target, trial) units in
        a cut job, `CUT_UNITS_PER_JOB`, now removed). The pool takes all the jobs first and sends them in the order of
        their target's close T, ties in the check's order. A job without a target goes first.
      - A cut worker first gets the universe without bars (`skeletonOf`: both timeframes, every series empty, no higher
        bars). With each job it then gets only the new bars of every pair of the task's timeframe with T up to the
        job's target (`growOf`), which it appends (`lawsearch-par-worker.ts` `applyGrow`).
      - So when a cut worker decides target k, its realm has never held a bar after T_k. It has never held the main
        run's answer either, nor anything of another check run. At most two jobs are in flight per worker
        (`DEPTH`), but a message waiting for a worker is bytes outside its realm until the worker takes it.
      - **The probe pool** gets every poison and presence run, stage 1's and stage 2's spec 13 runs among them. It is
        made at its first run and kept for the whole run, and it is never given a cut task. Its workers get the whole
        snapshot at each run (`shipOf`), as before. By the spec, poison's and presence's inputs hold the bars after T.
      - Every worker of both pools is started with `deno: { permissions: "none" }`. A par worker also refuses to serve
        if any permission reads `granted` (`notSandboxed`).
        - (C4h, 2026-11-11; C4g's review, the lead's F2) That test queried each permission without a path. Under the
          program's real flags (`--allow-read=. --allow-write=<OUT>`) such a query reads "prompt" in a worker that
          inherited them too, so a worker started without "none" would have served (C4g's refuter). Now every
          "universe" message carries the main thread's grants (`lawsearch-sandbox.ts` `grantsHeld`: each path-less
          name, and read and write on `.`, the run folder and the dump folder, that read "granted" there), and the
          worker throws before it takes the universe if any of them, or any path-less name, reads "granted" in its
          realm (`refusalOf`); the run stops (exit 1). Path-scoped queries read "prompt" in a "none" worker. The
          follow-bar worker (7.7 `followInWorker`) does the same with its one message. Proof: 12.9 F2.
      - The answers are still replayed in the check's order, so the bytes do not depend on where or when a unit ran
        (12 rule 3, and its condition). Why the two pools differ, what each keeps by construction, and what stays open:
        12.7.
    - (C4d, 2026-11-07; C4c's review, finding 2) This holds while a unit's decision is a function of its own series
      alone: every build and cache keyed by the Ind, and no module-level state that survives between
      `candidatesOf` calls (12.2 (2)). Such state lives once in the main thread and once in each worker, and each
      copy sees a different sequence of series. So it could make the bytes depend on `WORKERS`, as well as carry
      the uncut series' values into a check. Nothing stops it by construction. The yml's `cmp-c-7101` job compares
      one failing run at `WORKERS=0` and 4 byte for byte, as defense in depth only (7.8 syn step 3).
      - (C4e, 2026-11-08; the lead's G2) The comparison now covers three clean runs, N 1001 (in a job of its own,
        `w0-n-1001`), C 7101 and O 6003, which between them reach every kind of pool run a synthetic run of the small
        trial reaches but stage 2's `suspect13` checks (7.8 syn step 3 lists what is and is not compared). Still
        defense in depth only. A read through a series' memory block, by contrast, is closed by construction since
        C4e (the bullet on the units' series above).
  - Why each shared or kept value is exact, and which test guards it: 12.1. The two places where the equality with
    the main run still rests on how future code is written (the reason at bar k from `reasonOf` alone; caches that
    must stay keyed by the Ind): 12.2.
- (C4f, 2026-11-08; C4e's review: the power reviewer's `seriesStashE04`, `trialStashE04` and `avoidStashR3`, each
  reproduced by a refuter, `refute-power-1` to `-4`; the lead's H1, H2 and H3) **The checks' inputs: a snapshot that
  no main-run code has had.**
  - Why. Until C4f the checks shared mutable objects with the main run, so main-run code could leave a look-ahead's
    answer where the checks read it. Every check then passed while the main run looked ahead. There were three
    channels:
    - the universe's own typed arrays: the checks copied their series (`copyOf`, `poisonSeries`, `deleteBars`) from
      the arrays the main run had been handed, and each pool run sent the workers a structured clone of that same
      universe, made after the main run had used it;
    - the `TrialDef` objects: the main run's own at `WORKERS=0`, and in a worker a clone with every added property;
    - the avoid Set and the `ExclCtx`: the main run's avoid table was every unit's, and stage 0 passed the main run's
      `ExclCtx` to `poisonCheck`.

    The refuters' mutants (a write of the next close's sign into `fileKey`, a trial expando, ③'s future answer kept
    in the avoid Set) each gave exit 0 on fcce9e6, with every check passed. C4e's reviewers report that b3a2c43
    behaves the same; that was not measured in C4f. The `WORKERS=0` against 4 step could not see any of them: the
    bytes are the same at both settings. The plants of 8 (`seriesStashE04`, `trialStashE04`, `avoidStashR3`) are
    these mutants under `LS_PLANT`.
  - **H1, the guard by construction** (`lawsearch.ts` `Guard`; `lawsearch-checks.ts` `CheckInputs`). No object is
    shared: the main run keeps the objects it is handed, and the checks read objects made apart from them.
    - Each stage's universe (stage 0's u0, stage 1's u1, stage 2's u2): right after its `loadUniverse`, before the
      universe is handed to any main-run code, `guard.keep(u)` takes its digest (H3 below) and a snapshot,
      `snapshotOf(u)` = `structuredClone(u)`. Every typed array of the snapshot has a memory block of its own. The
      main run goes on with u. Every check of that stage reads `CheckInputs` { u: the snapshot, trials: the checks'
      trials, avoid: the checks' avoid table }.
    - The checks' trials: `trialCopyOf` of each of the run's trials, made in `main()` before the pipeline starts
      (5.2).
    - The checks' avoid table: a second `avoidOf` of the same bytes, parsed right after the main run's (after gate 4).
    - The holes: every unit makes its own (cut: `cutGotAt`; poison: from its thread's copy of the universe, above;
      presence: from its edited timeframe). No check is given the main run's `ExclCtx`.
    - Which check reads what (the C4f integrator's audit, `c4f/isolation-audit.txt` in the C4f scratch folder,
      checked again in the code by the C4f docs writer):
      - stage 0 (`runStage0`, 7.4): `dataCheck`, `donchianCheck`, `cutTargets`, `cutCheck`, `poisonCheck` and
        `presenceCheck` get the snapshot and the checks' trials and avoid table;
      - stage 1: `dataCheck`, `h1OnlyCheck` and `followBarChecks` get the snapshot's bars. The hit trials' 13
        (i)–(iii) checks (`suspicionChecks`) and `cut.chosen.first` (`chosenCut`) get the snapshot and the checks'
        definition of each trial (found by its id) and their avoid table;
      - stage 2: `dataCheck`, `followBarChecks`, `cut.chosen.second` and 13's checks, the same way.
      - (C4g, 2026-11-10) `followBarChecks` is now `followInWorker`: its recomputation runs in a worker of its own on
        the snapshot's timeframe, and the comparison with the main run's table runs in the main thread (6.1). Every
        check of every stage, and the realm it runs in, is in 12.7's table.
    - What a check still reads of the main run: its results, which are what the check compares. These are the
      signals (`TrialSignals`), the Inds for `donchianCheck` (E26's s on the main run's Ind against
      `donchianState` on the snapshot's bars), the blind tables for `followBarChecks`, and the trade rows for
      `retraceCheck`, which reads the raw files. `addsUpCheck` and `sameFirstHalfCheck` compare main-run results
      with each other, as before.
      - (C4g, 2026-11-10) The follow-bar check's worker gets only the coordinates of the blind table's rows (pair, T,
        direction, j, x), never its m, h or PL, and the comparison is made in the main thread (6.1). `retraceCheck`
        reads the raw files as they were read at gate 3, never the disk (7.7).
    - The workers: each pool run sends a structured clone of the snapshot (its two timeframes and its dates,
      `lawsearch-par.ts` `shipOf`) and of the check's sealed task (the checks' trials and avoid table), never the main
      run's objects.
      - (C4g, 2026-11-10) A probe pool's run still does. A cut pool's run sends the snapshot without bars and then each
        job's new bars (deltas, above), with the same sealed task, and no job carries its want.
    - What a unit reads: `set.pairs` of its own copy of the universe, then `copyOf`, `poisonSeries` or `deleteBars`
      copies; holes it makes itself; the task's trials, avoid table, plant, `answerKnowing`, `higher` and `tf`; and the
      job's arrays, made afresh for each job.
  - **The run-time proofs** (`Guard`; on every run, at any `WORKERS`; nothing is written to any file):
    - `afterMain`, once per stage, after the main run's part. In stage 0 that is inside `runStage0`, right after
      `stage0` has made the counts, before the noBlind stop and before any check or dump. In stage 1 it comes after
      the main run's signals, and in stage 2 after the main run's indicators and `ExclCtx`. Stage 1's `dataCheck` and
      `h1OnlyCheck` and stage 2's `dataCheck` run on the snapshot earlier, before it. `afterMain` does three things:
      1. It compares both universes with their digest at the load (H3).
      2. It requires the stage's `CheckInputs` to hold that stage's snapshot. Otherwise it throws `SHARED: … the
         checks' inputs are not of this stage's snapshot`.
      3. It takes `reachOf` of the main run's objects: its universe, the run's trials, all 1,364 definitions, its
         avoid table and its `ExclCtx`. `assertApart` then requires that no object reachable from the `CheckInputs`
         is among them.
    - Before every pool run (each timeframe of a cut check, each poison and presence check; `guard.runner` wraps both
      the pool and `inPlace`), `before` checks four things. The universe must be a kept snapshot (otherwise `SHARED:
      … not a kept snapshot`). The stage's `afterMain` must have run. The snapshot must still have its load digest.
      No object reachable from the universe or the task may be the main run's.
      - (C4g, 2026-11-10; the lead's G4; C4f's review: the main side's list missed the Inds, signals, blind tables and
        rows, and stage 2's was taken before any stage-2 signal existed) **The fourth test is now an allow-list.** It
        no longer walks the task against a list of the main run's objects. `assertTaskAllowed(task, chk, where)`
        requires four things:
        - the task holds exactly the keys of its kind of `UnitTask` (cut: `answerKnowing`, `avoid`, `higher`, `kind`,
          `plant`, `tf`, `trials`; poison and presence: the same without `higher` and `tf`);
        - it is a plain object;
        - every trial in it is one of the stage's `chk.trials`, by identity;
        - its `avoid` is `chk.avoid`, by identity.

        Anything else throws `SHARED: … (lawsearch-checks.ts assertTaskAllowed, C4g)`, exit 1. Since the snapshot
        must be a kept one and the task may hold nothing but these, nothing else can reach a check run through its
        arguments. `afterMain` still proves, once per stage, that the snapshot, `chk.trials` and `chk.avoid` are apart
        from the main run's objects (its list unchanged). `guard.runner` now wraps the pools only, since `inPlace` is
        gone. The allow-lists and identity checks together cost 8–21 ms per clean C 7101 run (9–11 calls) and 6–51 ms
        per run of the plants of `plants-c4g` (6–33 calls), by the C4g runs' stderr.
    - At each stage's end (when the stage ends without a STOP or a refusal), `end` compares both universes with
      their digest once more.
    - `reachOf` walks own enumerable string-keyed properties, array entries, and Set and Map entries. It takes each
      typed array (or `DataView`) together with its `ArrayBuffer`, and does not walk them further. It does not walk
      non-enumerable or symbol-keyed properties, prototypes, functions' closures, WeakMaps or module-level state.
    - A shared object throws `SHARED: <where>: <n> objects a check reads are the main run's (<kinds>)`: exit 1 (2.3).
    - Tests (the C4f integrator, copies of the C4f code, C 7101; each exit 1 in 16 s with its `SHARED` line and no
      print.txt):
      - `share-u`: the checks given the main run's universe;
      - `share-trials`: 12 objects (Object), the main run's trials;
      - `share-avoid`: 1 object (Set);
      - `share-cutu`: a cut run given a universe that is not a kept snapshot;
      - `share-array`: one typed array of the snapshot replaced by the main run's array, with the same values. The
        identity walk names 2 objects (Float64Array, ArrayBuffer). The digest cannot see this one.
    - On every clean and plant run the proofs passed. The identity checks took 7–19 ms per run in all on the C4f
      code (55 ms on one H1-alone copy): 9 checks on C 7101, 11 on N 1001, 19–20 on O.
  - **H3, the exact detector** (defense in depth; `universeDigest`, `digestDiff`). `universeDigest(u)` walks the
    universe's own enumerable properties. It records each typed array's SHA-256 (of the view's bytes, with its type
    and length) and the value of every other leaf, path by path: 12,090 values for a universe of [S0, END), 6,750
    for stage 1's [S0, SPLIT). It is taken at `keep`. Both universes are compared with it at `afterMain` and at
    `end`, and the snapshot before every pool run. On any difference the guard throws `CHANGED: <where>: <n> values
    of <stage>'s <main run's | snapshot> universe differ from their digest at the load (<paths>); the run stops (exit
    6, …)`, and the run ends with exit 6 and no dump folder (2.3).
    - (C4g, 2026-11-10; the lead's G4) Kept, with exit 7 in place of 6 (2.3), and the line now says `(exit 7, C4f H3)`.
      Why it is kept: it sees the main run write into its own universe, whatever bar the write is at. The checks see
      such a write only through the decisions it changes at their targets and probes. It costs about 2.5–2.9 s per
      clean C 7101 run (21 digests; the C4g integrator), and up to 5.1 s (42 digests) in the plant run
      `lenmemoEntryEarly`, which reaches stage 1's spec 13 checks.
    - It adds nothing to a clean run's files. It writes only `[lawsearch guard] …` lines to stderr: no file, no
      print.txt key and no `checks.csv` row. Every clean and plant run gave C4e's bytes (12.1's C4f paragraph).
    - Its limits. It sees a write only if the write is still there at the next compare point. It does not watch the
      trial definitions, the avoid tables, the `ExclCtx` or module-level state. It cannot tell a typed array replaced
      by another with the same values (`share-array`); the identity check does.
  - **H2, read-only definitions** (defense in depth): the frozen `TrialDef` (5.2), the read-only avoid table and the
    frozen `ExclCtx` and `Holes` (5.3). `sealTask` adds a check run's task. Each check seals the task it hands the
    runner: a frozen copy of the task, a frozen copy of its list of trials, each trial frozen, and its avoid table
    read-only. Each worker seals the structured clone it receives again (a clone is neither frozen nor read-only;
    `lawsearch-par-worker.ts`). No unit writes its task; this only makes such a write throw.
  - What H1 does not separate: module-level state of the modules both sides load. In `lawsearch-events.ts` that is
    `BUILDS` (a WeakMap keyed by the Ind; a check's Ind is never a main-run Ind) and `CLOCK`. In
    `lawsearch-items.ts` it is the definitions, in `lawsearch-checks.ts` the poison tables' `TABLES` (keyed by
    `UnitCache`), and then the rules' constant arrays. At `WORKERS=4` each worker has module instances of its own. At
    `WORKERS=0` the units run in the main thread's, so state that the main run's code keeps in a module reaches the
    checks there. The identity check does not walk module state. 12.2 (2) is the residual, and its test is the
    mutant `w0hide`.
    - (C4g, 2026-11-10; the lead's T and G2; C4f's review, the power reviewer and the ci-docs reviewer) **Corrected.**
      That paragraph was wrong in two ways.
      - Several checks ran in the main thread at every `WORKERS`, not only at 0: `followBarChecks`, and the
        main-thread parts of the others. So module state reached them at `WORKERS=4` too (the refuter's
        `lenmemo`).
      - Module bindings are not the only state outside the objects H1 separates. There are also realm globals
        (`globalThis` properties, built-in prototype expandos) and process-global state (the environment, files, Web
        storage, CacheStorage, locks). Workers share the process-global state.

      C4g separates that state by realms, not by objects:
      - every unit and every follow-bar recomputation runs in a worker with no permission, in which no main-run code
        ran;
      - the environment is revoked, and the files are read once at gate 3, before any main-run code;
      - the lockdown deletes the shared Web APIs.

      12.7 has each check's realm (the table), what each realm keeps by construction, and what stays open.
  - Power, rule 1 and cost: 12 (rule 2, and the paragraph after the method), 12.1's C4f paragraph and items 12–14,
    and 12.6.
- **retraceCheck**: reads `<run>/gmo/<SYM>/<interval>/<side>/<key>.json` with JSON.parse. It finds the entry and exit
  bars by openTime (keys from jstDayKey; no loadTf, no mergeSides), recomputes pl and m in points, and compares.
  - (C4g, 2026-11-10; the lead's G1) It reads those paths through its new first argument `read`. `lawsearch.ts` gives
    `readOf`, the bytes read once at gate 3 and checked against the manifest, decoded as `Deno.readTextFile` would
    decode them. So nothing main-run code writes into the run's folder reaches this check. Until C4g it read the
    disk, after stages 0 and 1's main-run code had run (C4f's review). The plant `gmoWriteR` shows this for the loads
    (8). C 7101 has no spec 13 hit, so no run has shown it for the retrace: there it rests on the code.
- **PRINT_KEYS** lists the key patterns of `print.txt`. Any other key stops the print. (C4g, 2026-11-10) The list itself
  is frozen (`Object.freeze`).

### 7.4 `research/lawsearch-stage0.ts`

```ts
export function runStage0(u: Universe, trials: TrialDef[], cfg: RunConfig, avoid: ReadonlySet<string>, o: { answerKnowing: boolean; plant: string; dumpDir: string | null }): Promise<{ sigs: TrialSignals[]; rows: Stage0Row[]; checks: CheckResult[] }>;
if (import.meta.main) { /* MODE=stage0 on real data later: refuses now (7.7) */ }
```

It runs indicators, signals, `blindBarsOf` for both halves, `stage0`, and the stage-0-safe checks (data, adds up,
donchian, cut, poison, presence). It writes the stage-0 dumps when `dumpDir` is given. `lawsearch.ts` calls it
in-process for syn and walkfiles.

(C4f, 2026-11-08; the lead's H1) The signature is now `runStage0(u, trials, cfg, avoid, chk: CheckInputs, o: { …,
cutMaxTargets?, cutFails?, runner?, afterMain?: (main: unknown[]) => Promise<void> })`. u, trials and avoid are the
main run's. The main run's part (its `ExclCtx`, indicators, signals, blind bars and `stage0`'s rows) reads only
those. chk is what the checks read instead (7.3's C4f bullet): the stage's snapshot, the checks' trials (the same
order) and their avoid table. `dataCheck`, `donchianCheck` (on chk's bars, against the main run's Inds), `cutTargets`,
`cutCheck`, `poisonCheck` and `presenceCheck` get chk and the main run's signals and rows. `poisonCheck` is given no
`ExclCtx`; until C4f it got the main run's. `o.afterMain`, the guard's (7.7), is awaited with [u, trials, avoid,
ctx] right after `stage0` has made the counts, before the noBlind stop below and before any check or dump.
`lawsearch.ts` adds the 1,364 definitions to that list.

(C4g, 2026-11-10; the lead's G2) `o.runner` is now required: the pools of `lawsearch-par.ts`, never the main thread
(7.3). u0 and its snapshot are loaded and kept at the start of the pipeline, before any main-run code. Until C4g that
happened at stage 0's start, which was the same point for stage 0 (7.7).

(C3, 2026-11-05; the lead's D4) Right after `stage0` has made the counts, before stage 0's checks, `runStage0` calls
`stop()` when any trial's `first.noBlind` or `second.noBlind` is above 0 (spec 6: 0件でなければ、プログラムの誤りと
して止まる), for every trial, chosen later or not. The message names each such trial and half, and no count of the
second half (spec 9 後半). The stop is the same kind as the other program-error stops (2.3): the pipeline's stage-0
catch records the failed row `stop.stage0` in `checks.csv`, the run writes `checks.csv`, `cut_fail.csv` and print.txt,
does not open stage 1 or 2, and exits 3. The Python already stops on the same count (`lawsearch-py-design.md` 5.6).
Reason: since spec 23.3 the TS neither wrote nor checked the second half's per-trial noBlind, so a TS-only defect in
a trial that is not chosen passed with exit 0 (C2 review finding 4; plant `dropSecondStrata`, 8). (The stop's place,
right after the counts and before stage 0's checks, and its message, which names the trial and half and gives no
second-half count, were the C3 docs writer's readings; confirmed by the lead 2026-11-05, C4a.)

### 7.5 `research/lawsearch-dump.ts`

```ts
export function fmtInt(x: number | null): string;      // String(x); null → ""
export function fmtReal(x: number | null): string;     // String(x) (shortest round trip); NaN / null → ""
export function fmtBool(x: boolean | null): string;    // "1" / "0"; null → ""
export function fmtTri(x: number): string;             // 1 → "1", 0 → "0", −1 → ""
export function writeCsv(path: string, header: readonly string[], rows: Iterable<readonly string[]>): Promise<void>;
export function dumpConfig(dir: string, cfg: RunConfig): Promise<void>;
export function dumpLoad(dir: string, u: Universe, stage: string): Promise<void>;
export function dumpBars(dir: string, u: Universe): Promise<void>;
export function dumpHoles(dir: string, ctx: Record<TfKey, ExclCtx>): Promise<void>;
export function dumpInd(dir: string, tf: TfSet, builds: ReadonlyArray<{ pi: number; columns: Record<string, Float64Array | Int8Array | Uint8Array> }>, sigs: TrialSignals[]): Promise<void>;
export function dumpSignals(dir: string, sig: TrialSignals): Promise<void>;
export function dumpStage0(dir: string, rows: Stage0Row[]): Promise<void>;
export function dumpBlind(dir: string, t: BlindTable): Promise<void>;   // blind/ or late/ by t.late, and a row of blind_counts.csv (appending)
export function dumpTrades(dir: string, t: BlindTable, late: BlindTable, tr: TrialRows): Promise<void>;
export function dumpMeasures(dir: string, stage: "stage1" | "stage2", ms: TrialMeasures[]): Promise<void>;   // measures.csv, strata.csv, shift.csv, clusters.csv (appending)
export function dumpStage1(dir: string, cands: Stage1Cand[], out: Stage1Out, explain: Stage1Explain): Promise<void>;
export function dumpStage2(dir: string, cands: Stage2Cand[], rows: Stage2Row[]): Promise<void>;
export function dumpSuspect(dir: string, rows: SuspectRow[]): Promise<void>;
export function dumpChecks(dir: string, rs: CheckResult[]): Promise<void>;
// (C3, 2026-11-05) ts/cut_fail.csv (lawsearch-dump.md 8; always written, header first); the row type is the TS
// builder's, in lawsearch-types.ts
export function dumpCutFail(dir: string, rows: ReadonlyArray<CutFailRow>): Promise<void>;
```

- (C3) `dumpStage0` writes stage0.csv without the per-trial `all.emitted`, `all.r1`, `all.r1w` and `all.r1b`, and
  writes their per-timeframe sums into `stage0_totals.csv` (`lawsearch-dump.md` 7). `dumpConfig` writes `cut_max`
  (`lawsearch-dump.md` 2).
- (C4a, 2026-11-05; the lead's E4) The per-timeframe sums stay. A run with one trial in a timeframe (a `TRIALS` of
  one) makes them that trial's own numbers, so such a run is for development only (`lawsearch-dump.md` 7).
- (C4a, 2026-11-05; the lead's E7) `dumpCutFail` writes the new column `T` (the bar's close, `s + step` of the
  check's timeframe) right after `s` (`lawsearch-dump.md` 8); whether `CutFailRow` carries it or `dumpCutFail`
  computes it is the TS builder's choice.
- (C4a, 2026-11-05; the lead's E5) What `dumpSignals`, `dumpInd`, `dumpBars` (bars/ and htf/) and `dumpCutFail` write
  is sealed until stage 2 (`lawsearch-dump.md` 12): comparison dumps only, never shown, read by a person or
  summarised before stage 2. No code change.

`lawsearch-dump.ts` imports types from `lawsearch-types.ts` only, never from a study module, so that `deno info` of
the stage-0 program lists no trade, stats or select module even through a type import. The file names, columns, order
and formats are all in `lawsearch-dump.md`.

### 7.6 `research/lawsearch-hand.ts`

```ts
export const HAND_REQUIRED: Readonly<Record<string, "all" | readonly string[]>>;   // 9's table (example id → required keys)
export const ALT_KEY: RegExp;                                                       // /MISREADING|misreading|^variant_|_note$|^note$|^tolerance_rel$/, at any depth
export function runHand(o: { plant: string; ids?: string[] }): Promise<HandResult[]>;
if (import.meta.main) { /* prints one line per example and exits 4 when a required example fails */ }
```

- It reads `research/lawsearch-hand.json`. The caller has already checked HAND_JSON_SHA256.
- There is one adapter per covered example. It turns the example's input into the modules' inputs and compares each
  expect key:
  - points, indices, counts, booleans and texts are compared exactly;
  - doubles are compared by `===` when they are spec 17.2 "exact" values, otherwise by the class of
    `lawsearch-dump.md` 9 (q 1e−9, p relative 1e−9, ln relative 1e−9);
  - null equals NaN or null.
- A key matching `ALT_KEY`, at any depth of the expect object, is an alternative answer or a note: it is not
  compared in a normal run. Under a plant, the result says whether the plant's output equals an alternative answer
  (informational). Everything else, nested objects included, is compared (A.2.2's `stop_case` means the run must
  stop with no_blind 1; A.2.21's `kappa_arith` is `kappaOf`; A.2.19's extras are `gOf`, `plEstimate` and
  `stage3Estimate`; A.2.31 is `nGate`).
- A key whose computation throws `NOT BUILT` is "skip". When a required key is skipped or fails, the example fails.
- Examples given as bars write temporary GMO files under `research/out/lawsearch/hand-tmp/<id>/gmo` and use
  `loadPairTf` (A.1.4, A.1.6, A.1.34, A.1.36). Examples given as mid strings use `seriesFromMid`. Examples given as
  blind rows use `blindFromRows`. Examples given as trial records feed `Stage1Cand` / `Stage2Cand` directly.

### 7.7 `research/lawsearch.ts`

Modes (`MODE`):

| MODE | does | needs |
|---|---|---|
| `hand` | `runHand`, one line per example, exit 4 on a required failure | — |
| `syn` | `writeRun(OUT, genSpecOf(env))`, then the pipeline on OUT | GEN, SEED, FLIP, (STRENGTH), OUT |
| `walkfiles` | the pipeline on an existing run folder (read only); the dumps go to OUT (default `<RUN>/ts`; a plant run uses `<RUN>/plant-<name>`) | RUN (with its `manifest.json`), OUT |
| `stage0`, `stage1`, `calib`, `stage2`, `stage3`, `h1spread`, `print` | refuse: `REFUSED: the small trial has not passed (TRIAL_PASSED_SHA256 is null)`, exit 2, before any read | — |

The other environment variables:

- (C4g, 2026-11-10; the lead's G1) Every variable of this section and `MODE` are read once, at `main()`'s start,
  before any check of them, by `readSettings` (2.4: the 15 names of `ENV_NAMES`). It then calls
  `Deno.permissions.revokeSync({ name: "env" })`, and from then on the program reads the settings from that map only.
  - **Why the order matters.** A worker made before the revoke keeps its environment permission. The C4g integrator
    measured a worker made just before the revoke keeping env in 2 of 3 tries, while a worker that had already
    started when the revoke came lost it (`c4g/integ/perm/` in the C4g scratch folder). So the settings are read, and
    env revoked, before any worker exists. No audit checks that order; an edit that starts a worker earlier would
    reopen the environment to it (12.7, residual 5).
    - (C4h, 2026-11-11; C4g's review, the lead's F2) **That paragraph was wrong; the order is not what keeps env from
      the checks.** C4g's refuter measured (`c4g/refute-power-2` in the C4g scratch folder, Deno 2.9.6): a worker
      started with `deno: { permissions: "none" }` gets `NotCapable` for `Deno.env` whenever it is made, 20 of 20
      before the revoke and 3 of 3 with no revoke at all; and an inheriting worker that was already running and
      reading env got `NotCapable` at the moment of the revoke. The "2 of 3" was an inheriting worker's read that ran
      before the revoke statement, not a worker keeping env. What the revoke does: it closes env for the main thread,
      and at once for any worker that inherits the main thread's permissions. The program's workers never hold env,
      because they are started with "none"; since C4h each of them tests that at run time and refuses to serve when it
      holds any of the main thread's grants (12.9 F2). So no edit of the order can reopen env to them; an edit that
      drops "none" stops the run (exit 1).
  - The refusals and their messages are unchanged, and so is their order: only the reads moved. A refusal probe with
    `--allow-env` only (7.8 hand steps 7 and 8) still meets its first file read as `NotCapable`, exit 1.
- `TRIALS` (default TRIAL_STEP3);
- `LS_PLANT`;
- `KAPPA_DELTA` and `KAPPA_PL` (default 1, `kappaFrom` "not calibrated: step 7");
- `G_FILE` (optional JSON {trial: g});
- `HAND_IDS`;
- `CUT_MAX` (C3, 2026-11-05; the lead's D5): a development cap on the cut's targets per pair, for a builder's quick
  look only. Unset or empty: no cap. Otherwise it must be a positive integer in decimal digits (`^[1-9][0-9]*$`), or
  the run refuses (exit 2, before any file is read; before, `0`, `-3` or `abc` switched the cut off or were ignored).
  `config.json` gets `cut_max`: the number, or `null` (`lawsearch-dump.md` 2). A capped run still prints `DEVELOPMENT
  CAP`, and the Python's `--run` refuses it (and, from C4b, its `--compare`: the lead's E14). The yml never sets a
  valid `CUT_MAX`; (C4b, 2026-11-05; the lead's E13) its refusal step runs invalid values and expects exit 2 (7.8).
  (TS builder, C3: besides the checks'
  details, a capped run's print.txt has the key `note.cut_max` starting `DEVELOPMENT CAP`, since print.txt cuts a
  detail at 400 characters and a failing check's detail may not reach its cap text.) (C4a, 2026-11-05; the lead's
  E8) `note.cut_max` names every check the cap reaches: `cut`, `cut.chosen.first`, `cut.chosen.second`,
  `suspect13.cut.stage1` and `suspect13.cut.stage2` (7.3); so does the header comment of `lawsearch.ts`, which in C3
  says "all three cut checks". (E9) `checks.csv` gets no cap marker.
- `WORKERS` (C4b, 2026-11-05; written here C4c, 2026-11-07, C4b's review, finding 3): how many workers run the units
  of the checks cut, poison and presence (7.3; `research/lawsearch-par.ts`).
  - Unset or empty: 4. Otherwise a whole number from 0 to 64 in decimal digits, with no sign, no leading zero and no
    space (`^(0|[1-9][0-9]*)$` and ≤ 64). `0` runs every unit in the main thread (`inPlace`).
    - (C4g, 2026-11-10; the lead's G2) **Superseded.** No unit runs in the main thread at any value. The checks' two
      pools (`checkPools`, 7.3) each have max(1, `WORKERS`) workers. So `0` means one worker in the cut pool (made
      for each cut run) and one in the probe pool (kept for the run), and runs exactly as `1` does. The refusal, the
      default and the allowed range are unchanged. The stderr line is now `[lawsearch] the checks' units run on <n>
      workers per pool (WORKERS), no permission`, or `one worker (WORKERS=0) per pool`.
  - Anything else is refused with exit 2 and the line `REFUSED: WORKERS "<v>" is not a whole number from 0 to 64 (the
    workers of the checks cut, poison and presence; unset for 4)`, before any file is read: it is read right after
    `LS_PLANT` and `CUT_MAX`, before gate 1. It is read in `MODE=hand` too (and refused there), where no check uses
    it; the real modes are refused before it is read.
  - The output files are the same bytes for every allowed value (12 rule 3). So no file records it: `config.json` has
    no field for it, and only print.txt's `time.*` lines change with it. The console's stderr says `[lawsearch] the
    checks' units run on <n> workers (WORKERS)` (or "the main thread").
    - (C4d, 2026-11-07; C4c's review, finding 2) The same bytes hold while every build and cache is keyed by the Ind
      and no module-level state survives between `candidatesOf` calls (12.2 (2)). Such state would differ between
      the main thread and each worker, so it could make the bytes depend on `WORKERS`. The `lawsearch.ts` header
      says so too. The yml compares `WORKERS=0` with 4 on one run, as defense in depth (7.8 syn step 3).
      - (C4e, 2026-11-08; the lead's G2) On three runs now: CMP-N 1001, CMP-C 7101 and O 6003, each the job's own
        clean run (7.8 syn step 3). The `lawsearch.ts`, `lawsearch-par.ts` and `lawsearch-par-worker.ts` headers say
        so.
      - (C4f, 2026-11-08; the lead's H6) And on CMP-C 7101's `lastBarStateG3` plant run (7.8 syn step 3). Until C4f
        state carried in the universe, the trial definitions or the avoid table also gave the same bytes at both
        settings; H1 now keeps those apart by construction (7.3's C4f bullet). Module-level state is what is left
        (12.2 (2)). The `lawsearch-par.ts` header says so.
  - The pool is made after gate 3, before the pipeline starts. Its workers start at the first check that uses them
    and are closed when the run ends. At each run of the pool (a cut check: one per timeframe; poison and presence:
    one per check) the universe being
    checked is sent to each worker again before its first job of that run (a structured clone: about 100 MB per
    worker in the small trial; C4c measured a peak RSS of 2.9–3.4 GB for a whole run at `WORKERS=4`).
    - (C4f, 2026-11-08; the lead's H1) The universe being checked is the stage's snapshot, taken right after loading
      and never handed to main-run code, and the task holds the checks' own trials and avoid table (7.3's C4f bullet).
      Until C4f it was the universe the main run had been handed, cloned at each pool run, so whatever the main run's
      code had written into it reached every worker. Each pool run goes through the guard first (below). The C4f
      integrator's peak RSS was 3,061–3,434 MB on the clean runs and 3,112–3,424 MB on the plant runs that reach the
      checks (12.6).
    - (C4g, 2026-11-10; the lead's G2) **Two pools now** (`checkPools`, 7.3; 12.7), made after gate 3, before the
      pipeline starts. Both are closed when the run ends.
      - The cut pool spawns its workers fresh for every cut run and ends them when the run settles. A cut worker gets
        the snapshot without bars, then each job's new bars (deltas).
      - The probe pool spawns at its first run (poison or presence) and keeps its workers. Each of its runs sends each
        worker the snapshot again (`shipOf`), before that worker's first job of the run.
      - At the end of a run, stderr gets `[lawsearch pools] {cutRuns, probeRuns, spawns, spawnMs, sortMs, growMs,
        growRows}`. A clean C 7101 run at `WORKERS=4` shows 4 cut runs, 2 probe runs and 20 spawns (16 cut + 4 probe).
      - The C4g integrator's peak RSS was 3,469–3,575 MB on clean C 7101 at `WORKERS=4` (b322c13: 3,140 and 3,290 MB on
        the same days), and up to 3.64 GB on the O runs. Both pools are alive in stage 0 (12.8).
  - A unit's error is thrown again at that unit, in the check's order and with the same message, as the check's loop
    threw it before C4b (the program tells a STOP or a refusal by its message, so they stay what they were). A worker
    that dies stops the run with exit 1.
  - The yml sets `WORKERS: "4"` for every job (7.8), and its hand step 8 runs the refusal. (C4d, 2026-11-07) One
    step sets `WORKERS: "0"`: the `cmp-c-7101` step that compares the bytes at `WORKERS=0` and 4 (7.8 syn step 3).
    (C4e, 2026-11-08) That step now runs in three jobs, `w0-n-1001`, `cmp-c-7101` and `o-6003`, and it is still the
    only step that runs the pipeline at `WORKERS=0` (hand step 8's control `0` stops on its first read). (C4f,
    2026-11-08) In `cmp-c-7101` it also runs the plant `lastBarStateG3` at `WORKERS=0` (7.8 syn step 3). (C4g,
    2026-11-10) The new job `plants-c4g` runs the plant `w0protoG3` at `WORKERS: 0` too (7.8).

The gates run in order, before any bar is read (before them, the real modes are refused, then `MODE`, `LS_PLANT`,
`CUT_MAX` and `WORKERS` are checked; each refusal is exit 2):

1. `checkRulesFiles()`.
2. Every requested trial is built (`trialBuilt`); otherwise refuse and name the first one that is not.
3. The run folder has `manifest.json` whose version is GEN_VERSION, whose `treeSha256` matches the folder, and whose
   path has no `.cache`.
   - (C4g, 2026-11-10; the lead's G1, from the C4g designer "harden") **The gate-3 bytes.** The gate now reads every
     file under `<run>/gmo` once, with `treeBytes` (4.2). That is the walk and the digest of `treeSha256`, keeping each
     file's bytes by its path. It compares the digest and the file count with the manifest, as before (a mismatch
     prints the same `STOP: …` line and exits 3).
     - Those bytes are then the run's only source of GMO data. The three stages' loads read them (`memSourceOf`:
       `loadPairTf` and trend-data's `loadTf` through `src.read`; 4.1), and so does 13 (iv)'s retrace (`readOf`, 7.3).
     - Nothing reads a gmo file from the disk again. Until C4g, stages 1 and 2 loaded their universes from the disk
       after stage 0's main-run code had run, and the retrace read the disk too. A write into the run's own folder
       then reached every stage-1 and stage-2 snapshot (C4f's review; the plant `gmoWriteR`, 8).
     - The bytes stay in memory for the whole run, about the size of the gmo tree (22,040 files on C 7101).
4. Plant `avoidFull` reads `research/ledger/spread-hours.csv` as the avoid table. The sha256 check of the table
   actually read then fails, and the run exits 3.

The pipeline (syn and walkfiles; one process):

(C4g, 2026-11-10; the lead's G1) Right after gate 4 and the two parses of the avoid table, and before any main-run
code, the pipeline loads all three stages' universes from the gate-3 bytes: U0 [S0, END), U1 [S0, SPLIT) and U2
[S0, END). It keeps each one at once (`guard.keep`: its digest and its snapshot, below). The stages below take them
from there, and the loads named in items 2–4 are those loads.
- A load's error is held and thrown again where its stage used to load. So a STOP in U1's load is still `stop.stage1`,
  and U2's error is thrown only if stage 2 opens. If U0's load fails, U1 and U2 are not loaded.
- The three loads and keeps take 12.7–16.9 s on C 7101 (stderr `[lawsearch] the three loads and keeps`). Before C4g
  the same work was inside the stages' times. Now it shows only in `time.total` (12.8).
- With the plant `gmoWriteR`, stages 1 and 2 print a probe line at their start: that bar's close on the disk, in the
  stage's snapshot and in the main run's universe (8).

1. `config.json`.
2. **Stage 0**: U0 = `loadUniverse(src, S0, END, syn0)`, then `runStage0`. Dumps: load, bars, htf, holes, ind,
   signals, stage0. (C4a, 2026-11-05; the lead's E5) bars, htf, ind and signals hold second-half material of every
   trial: they are sealed until stage 2 (`lawsearch-dump.md` 12), as is `cut_fail.csv`.
3. **Stage 1**: U1 = `loadUniverse(src, S0, SPLIT, syn1)`, `h1OnlyCheck`, signals again, then `sameFirstHalfCheck`.
   - Blind first-half tables and late tables (m15, h1), `trialRows`, `measureTrial` (floor-passing, not-same trials;
     D_F of (E, F01) against S01 of the same timeframe), and `measureBlindRows`.
   - `suspectOf`. For hit rows, 13 (i) cut on all their signals, (ii) poison 1,000 (seed 419), (iii) presence, and (iv)
     `retraceCheck` on 6 trades. (v) is "not-run", so a hit row is not selectable (11 O-5).
   - `followBarChecks`, `failRuleOf`, `chooseStage1` and `stage1Explain`. (C4g, 2026-11-10) The follow-bar checks run
     right after each timeframe's blind and late tables are made, in the order the code has always had. Each one is now
     `followInWorker`: a worker with no permission, started for the call (6.1). The same holds in stage 2.
   - Write `ts/choice.json` (the chosen ids per timeframe) and print its sha256. (Settled by the lead 2026-11-05, D11:
     it stays before `cut.chosen.first`. Nothing reads it, the choice is in the compared stage-1 dumps anyway, and
     `MODE=stage1`, whose record step would commit it, is not built; C2 refuted the finding.)
   - Spec 23.2 (2026-11-05): the chosen trials are cut on U1 with every higher-timeframe boundary target (the other
     kinds as stage 0's), check `cut.chosen.first` (stage `stage1end` in `checks.csv`). A failure prints a STOP line
     with the trials and their failing bars, withholds stage 1's numbers and does not open stage 2.
   - (C3, 2026-11-05; the lead's D10) A blind row of stage 1 whose suspicion hits (spec 13: 物差しが当たったら、すべて
     止めて調べる) records the failed check `suspect.blind.stage1` (one row per hit row, naming it), as before, and
     now stops the run at the end of stage 1 through the next bullet. print.txt withholds stage 1's numbers and says
     STOP (a `note.*` key naming the stage and the blind rows; the console prints a `STOP:` line too). (TS builder,
     C3: the key is `note.stop13`.)
   - (C3, 2026-11-05; the lead's D8) **The stop before stage 2**: after stage 1's end (`cut.chosen.first`
     included), the run does not open stage 2 when any check of stage `gate`, `stage0`, `stage1` or `stage1end` has
     failed. It prints a `STOP:` line naming the failed checks, puts `note.stage2` ("not opened: …" with the failed
     check names), writes `checks.csv`, `suspect.csv`, `cut_fail.csv` and print.txt, and exits 3. It adds no check row
     of its own (CI's O step counts the failed rows). No stage-2 file or row is written (`lawsearch-dump.md` 11.14
     (a)). Reason: spec 11 opens the second half once, and a run with a known failure must not use it; before, only
     a failed `cut.chosen.first` closed stage 2, and O 6001 chose h1.B06 and printed its stage-2 verdict after its
     E26 failures. (TS builder, C3: a STOP raised inside stage 0 or stage 1, recorded as `stop.stage0` or
     `stop.stage1`, also puts `note.stage2` "not opened: a STOP in stage …", so every run that ends before stage 2
     says so in print.txt; CI's plant and O steps read that key.)
     - (Confirmed by the lead 2026-11-05, C4a; it was the C3 docs writer's question.) This is stricter than spec 10
       rule 2 (確かめ（15）がすべて通る, a rule of each trial) and spec 15 (1つでも外れたら、その段の数字を出さない) on
       purpose: spec 11 opens the second half once, so on real data one failed check keeps stage 2 closed for every
       trial until the error is fixed and the run is made again. Unchanged: the stop adds no check row of its own,
       and `cut.chosen.first` still runs at stage 1's end after a stage-0 failure. The Python's report gets a line
       `stage 2 not opened: …` for the same condition (the lead's E6, `lawsearch-dump.md` 11.14 (a)); the TS's
       output does not change.
4. **Stage 2**: U2 = `loadUniverse(src, S0, END, syn2)`. Blind second-half and late tables. Spec 23.2: the chosen
   trials cut on the second half's targets with every boundary target (`cut.chosen.second`; a failure withholds stage
   2's numbers). `measureTrial` for the
   chosen trials only: asking for any other trial throws `REFUSED: stage 2 of a trial not chosen` (plant
   `secondHalfAll` asks for all; exit 2). Then κ (`withKappa`), `holm` (iut and delta), `conditionsOf`, `verdictOf`
   and `stage2Rows`.
   - (C3, 2026-11-05; the lead's D9) A failed `cut.chosen.second` withholds every stage-2 number in print.txt (each
     `verdict.*`, `count.stage2.*` and any other stage-2 key; `withheld.stage2` 1), and the run exits 3. Every
     stage-2 dump is still written: the Python compares them as usual and reads the failure from `checks.csv`
     (`lawsearch-dump.md` 11.14 (b)).
   - (C3, 2026-11-05; the lead's D10) A blind row of stage 2 whose suspicion hits records `suspect.blind.stage2` as
     before; stage 2's dumps are all written (`suspect.csv` with its rows), print.txt withholds stage 2's numbers and
     says STOP (as at stage 1), and the run exits 3. Nothing comes after stage 2 in the trial
     (`lawsearch-dump.md` 11.14 (c)).
5. **The end**: `checks.csv`, `suspect.csv` and `print.txt` (PRINT_KEYS only: counts, times per stage
   `time.<stage>.ms`, check results; no stage's numbers when one of its checks failed). Exit 0, or 3 when any check
   failed. The run goes on through every stage after a failure, so set O can show its suspicion lines (but not into
   stage 2 after `cut.chosen.first` failed: spec 23.2). (C3, 2026-11-05: superseded in part by the stop before stage
   2 above. After a failure of stage 0 or 1 the run still goes through stage 1, so set O shows its suspicion lines,
   but it never opens stage 2; O runs now end before stage 2.) Also at the end: `cut_fail.csv` (7.3).

(C4f, 2026-11-08; the lead's H1 and H3 on C4e's review) **The guard** (`lawsearch.ts` `Guard`; 7.3's C4f bullet):

- In `main()`, right after gate 2: the checks' trials, `trialCopyOf` of each requested trial (5.2). In the pipeline,
  right after gate 4: the avoid table parsed twice from the same bytes, once for the main run (`avoid`) and once for
  the checks (`avoidChk`), both read-only (5.3).
- Stage 0, 1 and 2: right after the stage's `loadUniverse`, `guard.keep(u)` takes the universe's digest and its
  snapshot, before the universe is handed to any main-run code (in stages 1 and 2 before `dumpLoad`). The stage's
  checks get `CheckInputs` { the snapshot, the checks' trials, `avoidChk` } (`chk0`, `chk1`, `chk2`); the main run
  goes on with u, the run's trials and `avoid`.
- `guard.afterMain` once per stage, after the main run's part: in stage 0 inside `runStage0` (7.4); in stage 1 after
  the main run's signals; in stage 2 after its indicators and `ExclCtx`. `guard.runner` wraps the runner (the pool or
  `inPlace`), so every check run passes `before` first. `guard.end` at each stage's end (stage 0 after `runStage0`,
  stage 1 after `cut.chosen.first`, stage 2 after its dumps).
- A changed digest throws `CHANGED: …`. `main()` catches it, prints it, removes the dump folder and returns 6 (2.3).
  A shared object throws `SHARED: …`, which is exit 1. Neither is a STOP, so no stage's catch takes it, and no
  `checks.csv` or print.txt is written.
- Each kept universe's digest and snapshot times go to stderr as `[lawsearch guard] <stage>: digest <ms> ms (<n>
  values), snapshot <ms> ms`. At the end comes `[lawsearch guard] snapshots … ms; digests … ms (<n>); identity
  checks … ms (<n>)`. No file, no print.txt key and no `checks.csv` row is written, so a clean run's files are the
  same bytes as before (12 rule 1; 12.1's C4f paragraph).
- (C4g, 2026-11-10; the lead's G1 and G4) What changed in the guard:
  - `keep` now runs for all three universes at the pipeline's start, right after their loads from the gate-3 bytes,
    before any main-run code (above).
  - `before` now checks the task against an allow-list (`assertTaskAllowed`, 7.3) in place of the identity walk of the
    task.
  - `guard.runner` wraps the pools only, since `inPlace` is gone.
  - A changed digest returns 7, not 6 (2.3): `main()` prints the `CHANGED` line, removes the dump folder and prints
    `exit 7: a universe changed after it was loaded; <folder> was removed`.
  - The end line now reads `identity checks and allow-lists … ms (<n>)`, and `[lawsearch pools] {…}` follows it.
- (C4g) `main()`'s first lines print one stderr line: `[lawsearch] lockdown: removed <names>; <n> constant objects
  frozen; env read and revoked`. (C4h, 2026-11-11) It now reads `[lawsearch] lockdown: removed <names>; frozen
  Worker.prototype, EventTarget.prototype, globalThis.Worker (pinned); <n> constant objects frozen; env read and
  revoked` (12.9 F7), and the pools' line ends `…; every worker must not hold: <the main thread's grants>` (F2). Both
  are stderr only: no output file names them. On the main thread it names BroadcastChannel, caches, CacheStorage, Cache,
  localStorage, sessionStorage, Storage, navigator, Navigator, process, Deno.kill, Deno.addSignalListener,
  Deno.removeSignalListener and Deno[Deno.internal], and 77 objects frozen (12.7 G3).

Deno permissions: `--allow-read=. --allow-write=research/out --allow-env` (and the scratch folder when a builder
runs locally). No `--allow-net`. The constant `TRIAL_PASSED_SHA256: string | null = null` lives in `lawsearch.ts`,
and the lead sets it after the trial passes.

(C4g, 2026-11-10; the lead's G1 and G3) Deno flags and permissions now (the yml's `DENO_RUN` and `DENO_WALK`, 7.8):
- `--no-prompt`: a permission not granted is refused at once, never asked.
- `--unstable-worker-options`: needed for `deno: { permissions: "none" }` on the checks' workers. Without it Deno 2.9.6
  stops the process at the first check run (exit 70, 2.3): fail closed.
- `--v8-flags=--max-old-space-size=12288,--disallow-code-generation-from-strings`: one `--v8-flags`, so that `eval`
  and `Function` throw an `EvalError` in every realm. An unknown V8 flag stops Deno at its start, which is fail closed
  too.
- `--allow-read=.` and `--allow-env`, as before. The environment is revoked by the program itself after the settings
  are read (above). The checks' workers have no permission at all. (C4h, 2026-11-11) And each of them refuses to serve
  when it holds one of the main thread's grants (12.9 F2).
- Write: `DENO_RUN` keeps `--allow-write=research/out`. `DENO_WALK` has no write grant, and each step that uses it
  adds `--allow-write=<the run's own folder>`: a walkfiles run's dump folder, or a syn run's run folder, which holds
  its gmo files and its dumps.
  - Deno 2.9.6 cannot narrow a grant from inside the program. Revoking write, or read, on a path under a granted
    folder revoked the whole grant of that folder (measured by the C4g designer "harden" and the C4g integrator,
    `c4g/integ/perm/revoke.txt`). So the narrowing is done by the flags.
  - Write cannot go below the run's own folder, because `writeRun` and the dumps need it. Main-run code can still
    write there, and it can read everything under `.` (12.7, residual 6).
  - (C4h, 2026-11-11; C4g's review, the lead's F8) A `MODE=syn` run needs no more than `--allow-write=<OUT>` either: its
    run folder is OUT (its gmo files and `manifest.json`, then its dumps in `OUT/ts`). C4g's refuter measured it with no
    `research/out` folder at the start, and C4h's smoke-step run did the same (12.9 F8). The yml's comment above
    `DENO_WALK` said a syn run still needed `research/out`; it is corrected.

### 7.8 `.github/workflows/lawsearch.yml`

```yaml
name: Research lawsearch (small trial)
on:
  push:
    branches: [claude/app-confirmation-jvmk03]
    paths: [research/lawsearch*, research/money-stats.ts, .github/workflows/lawsearch.yml]
  workflow_dispatch:
permissions: { contents: read }
jobs:
  hand:     # deno check; the stage-0 graph; the realms' graph, source and catch audits (C4g); the push paths cover the graphs, the main realm's freeze (C4h); TS hand; Python hand; the hand plants; no read through a memory block (C4e; widened C4f); real modes, CUT_MAX, WORKERS refused
  syn:      # needs hand; matrix of 10's runs (+ w0-n-1001, C4e); TS syn → Python --run (recompute + compare); the run plants; WORKERS=0 vs 4 (three jobs; + cmp-c-7101's lastBarStateG3, C4f); uploads research/out/lawsearch/** as an artifact
  flip:     # (described in step 5 below)
  plants-c4g:  # (C4g) needs hand; its own C 7101 (MODE=syn); the seven C4g run plants, each wanting its exit and its catch; an artifact
  smoke:    # SMOKE 7001–7004, only with the repository variable LS_SMOKE_STRENGTH
```

(C4h, 2026-11-11) And a second workflow, `.github/workflows/lawsearch-audit.yml` (hand steps 13 and 14 below):

```yaml
name: Research lawsearch (audits of the shared modules)
on:
  push:
    branches: [claude/app-confirmation-jvmk03]
    paths: [.github/workflows/lawsearch-audit.yml, the 42 modules of the four graphs outside lawsearch.yml's paths]
  workflow_dispatch:
permissions: { contents: read }
jobs:
  audit:    # deno check; the stage-0 graph; the graph, source and catch audits; the push paths cover the graphs; TS hand
```

(C4g, 2026-11-10; the lead's G1 and G3) The workflow's `env` now holds two run commands besides `WORKERS: "4"`:
- `DENO_RUN`: `deno run --sloppy-imports --no-config --no-prompt --unstable-worker-options
  --v8-flags=--max-old-space-size=12288,--disallow-code-generation-from-strings --allow-read=.
  --allow-write=research/out --allow-env`;
- `DENO_WALK`: the same without its write grant.

Every syn, flip and plant run step uses `DENO_WALK` plus `--allow-write=<its own folder>`. So do the `WORKERS=0` step's
two runs and `plants-c4g`'s runs, except `gmoWriteR` (below). The hand job's `MODE=hand` steps and the real-mode step
use `DENO_RUN`. The flip judgement has no write grant (7.9). What the flags do: 7.7, the end.
(C4h, 2026-11-11; C4g's review, a ci-docs refuter; the lead's F8) That list missed one step: the smoke job's "TS
(MODE=syn, provisional strength)" still ran `$DENO_RUN`, with the broad grant on `research/out`. It now runs `$DENO_WALK
--allow-write=$OUT`, as every other run step. So `DENO_RUN` is used by the hand job's steps (which write nothing) and by
`gmoWriteR` alone. The comment above `DENO_WALK` in the yml is corrected too (7.7's C4h bullet on write).

- **hand**:
  1. `deno check` on every `research/lawsearch*.ts`.
  2. `deno info research/lawsearch-stage0.ts | grep -E "lawsearch-(trade|stats|select)\.ts"` must find nothing.
  3. `MODE=hand` exits 0.
  4. `python3 -I research/lawsearch-check.py --hand` exits 0.
  5. For each hand-level plant (8): `LS_PLANT=<p> MODE=hand` must exit 4, and at least one of 8's named examples must
     fail. The same for the Python's twins (`--hand --plant <p>`).
     - (C4c, 2026-11-07; C4b's review, finding 2) The Python reports a caught plant differently: `--hand --plant <p>`
       exits 0 when at least one of the plant's named examples failed, and prints `PLANT <p>: must fail one of
       <ids>; failed: <ids>` (`failed: none` and exit 4 when none failed; exit 2 for a plant it does not know). So
       the yml takes a Python twin as caught when it exits 0 and that line names a failed example (`grep -q "^PLANT
       <p>: .*failed: [^n]"`). `reasonUsesFuture` has no Python twin (`lawsearch-py-design.md` 5.2) and is not asked
       of the Python. Before C4c the yml wanted exit 4 from the Python too, so the step could never pass.
     - (C4d, 2026-11-07; C4c's review, finding 3; the lead's F3) The `grep` above trusted the Python's own list of
       named examples, not the step's. For `noRisingEdge` that list adds A.4.32, which 8 says cannot catch the
       plant. So a Python whose `noRisingEdge` failed only A.4.32 would have passed. Now the step parses the ids
       after `failed: ` on the `PLANT <p>:` line. It takes the twin as caught only when it exits 0 and one of those
       ids is among the step's own ids for the plant (its list, the same one the TS side uses). The step prints
       `Python <p>: exit <code>, failed: <ids>; one of <step's ids> among them: 0|1` (`(no PLANT line)` when there
       is none). The TS half and the Python are unchanged. The C4d integrator ran the step as extracted from the
       yml: on the repo it exits 0 (all 20 twins caught by the step's ids). With C4c refuter 3's wrapper
       `py-spurious.py` (the repo's Python, but `noRisingEdge` fails only A.4.32) it exits 1, and only
       `noRisingEdge` is not caught. 876b9e4's step exits 0 with the same wrapper. The TS lines are the same in all
       three runs.
  6. Every real mode exits 2.
  7. (C4b, 2026-11-05; the lead's E13) Invalid `CUT_MAX` values are refused: for each value of a fixed list that
     7.7's rule refuses (for example `0`, `-3`, `abc`, `1.5`, `07`; the list is the TS builder's), a run mode that
     reads `CUT_MAX` (`syn` or `walkfiles`, with the rest of its settings valid) must exit 2 before any file is read.
     It may be part of step 6. Reason: the refusal was written in C3 (before, `0`, `-3` or `abc` switched the cut off
     or were ignored), but no step ran it, so a later change could bring the old behaviour back unseen.
     - (Described C4c, 2026-11-07, as the yml has it since C4b) The step's values are `0`, `00`, `07`, `-3`, `+3`,
       `abc`, `1.5`, `1e3`, `0x10`, `" 3"`, `"3 "`, `9007199254740992` (2^53, not a safe integer) and `Infinity`, each
       with `MODE=syn` and with `MODE=walkfiles`, the rest of the mode's settings valid. Each probe runs with no read or
       write permission (`--allow-env --no-prompt` only), so a program that touched a file before the refusal would
       stop on the missing permission (`NotCapable`, exit 1). Each must exit 2, print the exact refusal line, and
       leave no output folder. The controls `1`, `9007199254740991` and empty must pass the refusal and stop on the
       first read (exit 1, `NotCapable`), which shows that a probe does see a read.
  8. (C4b, 2026-11-05; written here C4c, 2026-11-07, C4b's review, finding 3) Invalid `WORKERS` values are refused,
     as in step 7: `-1`, `+1`, `abc`, `65`, `100`, `04`, `00`, `1.5`, `1e1`, `0x4`, `" 4"`, `"4 "`, `Infinity` and
     `NaN`, each with `MODE=syn` and `MODE=walkfiles`, with no read or write permission: each must exit 2, print 7.7's
     `REFUSED: WORKERS …` line exactly, and leave no output folder. The controls `0`, `1`, `4`, `64` and empty must
     pass the refusal and stop on the first read (exit 1, `NotCapable`). C4c ran the step as extracted from the yml:
     exit 0.
  9. (C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's q1; the lead's G1) **No read
     through a typed array's memory block outside an allow-list.** In the yml this step runs right after step 5's
     hand-plant step and before step 6. Its name says what it is: defense in depth, not a guard by construction. The
     guard by construction is that every series a check hands to `decisionOf` holds its own bars only (4.1 `copyOf`;
     7.3, the units' series).
     - What it does (C4e's pattern; widened in C4f, below):
       `grep -nE '\.buffer\b|byteOffset|ArrayBuffer|DataView|\.subarray\('` over `research/lawsearch*.ts`; lines
       whose text is a comment alone (`//` after blanks) are dropped; each other line
       becomes `<file>: <its text without leading blanks>`. The step fails (exit 1) when such a line is not, as a
       whole line, in its allow-list, and prints those lines. It also prints, for information only, any allow-list line
       it no longer finds.
     - The allow-list (10 lines; 12 since C4f, below) and why each is allowed (the step's comment says the same):
       - `lawsearch-bars.ts` `poisonSeries` (`a.set(alt[k].subarray(k0), k0)`, the same text on two lines) and
         `deleteBars` (`a.set(src.subarray(…), j)`): the view is only the source of a copy into a fresh array;
       - the `hex` helpers of `lawsearch-const.ts`, `lawsearch-flip.ts`, `lawsearch-gen.ts` and `lawsearch.ts`: they
         format a SHA-256 digest (an `ArrayBuffer`);
       - `lawsearch-dump.ts`: it writes a dump file's bytes (`bytes.subarray(off)`);
       - `lawsearch-events.ts` `storeOf`: the run plant `bufferReadE04` itself (8), active only under `LS_PLANT`;
       - `lawsearch-hand.ts` `toPlain` and its JSON replacer (`ArrayBuffer.isView`): the hand examples' output, typed
         arrays turned into plain arrays.
     - Its limits (the step's comment says them too): it reads only these files, not the modules they import
       (trend-data, the app functions, …); it works line by line and by these names, so a read written across lines,
       through another name, or with a listed line's exact text elsewhere in the same file is not seen.
     - The C4e integrator's runs (the step as extracted from the yml; `c4e/logs/bufgrep-*.txt` in the C4e scratch
       folder): on the repo (code v2 and v3) exit 0, 11 lines, all allowed. With `new DataView(s.C.buffer,
       s.C.byteOffset)` planted in `lawsearch-items.ts`: exit 1, that line named. With `copyOf` turned back into
       `subarray` on the Float64 arrays: exit 1, that line named. Under 1 s.
     - (C4f, 2026-11-08; C4e's review, the ci-docs reviewer; the lead's H7) **Widened.** C4e's pattern missed
       `C["buffer"]`, `{ buffer } = C` and `.subarray (`. The pattern is now
       `\bbuffer\b|byteOffset|\bsubarray\b|ArrayBuffer|DataView` (`grep -nE`, case-sensitive). The words `buffer`
       and `subarray` match as whole words, so `.buffer`, `C["buffer"]`, `{ buffer } = C`, `{ buffer: b } = C`,
       `.subarray (` and `x["subarray"]` all match. `byteOffset`, `ArrayBuffer` and `DataView` match anywhere in a
       word, so `SharedArrayBuffer` and `ArrayBufferView` match too. The rest of the step is unchanged: the same
       line form, the same whole-line allow-list match, and the same information line for allow-list lines no longer
       found.
       - What it skips: only lines whose first non-blank characters are `//`. A name in a `/* */` or JSDoc block,
         or in a `//` comment after code on the same line, is scanned like code. That gives a false alarm, which
         fails the step, so it errs on the safe side.
       - What it cannot see (the step's comment lists the same):
         - a name not written out in the line: made at run time (`"buf" + "fer"`), a key read from a variable,
           `Reflect.get` or `Object.getOwnPropertyDescriptor` with such a key, or escapes in a string given to `eval`
           or `Function`;
         - a value the line gets from elsewhere without naming it: a function of another module that returns
           `x.buffer`, or a variable that holds a block taken on an earlier line, where only that earlier line is
           seen;
         - code outside `research/lawsearch*.ts`, in the modules they import;
         - a listed line's exact text used again elsewhere in the same file. The allow-list is matched per file,
           so in another file such a line fails.
       - The allow-list is now 12 lines: C4e's 10, plus two in `lawsearch-checks.ts`, both H1's identity check
         (7.3's C4f bullet). `isView` (`ArrayBuffer.isView`) tells a typed array or `DataView`. `reachOf`'s
         `seen.add(o.buffer)` adds a typed array's memory block to the set of reachable objects. Both hold a block
         by identity only, to prove that no check input shares one with the main run's, and no element is read
         through them.
       - The C4f integrator's runs (the step as extracted from the yml, `c4f/bufgrep-test/` in the C4f scratch
         folder). On the final repo: exit 0, 13 lines (`poisonSeries`' line twice), all allowed. On 15 copies of
         the repo's files with one line added or changed, each as wanted:
         - it fails (exit 1) on `C["buffer"]`, `const { buffer } = C`, `const { buffer: m } = C`,
           `C.subarray (0, 3)`, `C["subarray"](0, 3)`, `new DataView(s.C.buffer, s.C.byteOffset)`,
           `new SharedArrayBuffer(n)`, `copyOf`'s `slice` turned back into `subarray`, `.buffer` in a JSDoc line
           and after code (the two false alarms), and `seen.add(o.buffer)` added to `lawsearch-items.ts` (a listed
           text in another file);
         - it passes (exit 0) on the clean files, on a comment-only line that names all three words, on
           `["buf" + "fer"]`, and on `seen.add(o.buffer)` added again to `lawsearch-checks.ts`. These last two are
           the documented limits.
     - (C4g, 2026-11-10; the lead's G4; C4f's review, the ci-docs reviewer, reproduced by a ci-docs refuter)
       **What it skips and cannot see, completed.** The lists above missed three forms; the step's comment now names
       them:
       - a line inside a multi-line template literal whose first non-blank characters are `//`. It is skipped as a
         comment line, although it can hold `${…}` code. A skipped `//` line is a comment line only outside template
         literals;
       - an escape in a string key, such as `C["\x62uffer"]` or `C["\u{62}uffer"]`;
       - an escape in an identifier, such as `C.\u0062uffer`.

       Neither escape needs `eval` or a string built at run time. (Since C4g `eval` and `Function` are off anyway:
       `--disallow-code-generation-from-strings`, 7.7.) The pattern is unchanged.
       - **The allow-list is now 14 lines**: C4f's 12, plus two.
         - `lawsearch-par-worker.ts` `s[k] = arr.subarray(0, b);`: a cut worker's series is a view of the filled part
           of an array that doubles when full. Past its n that array holds only zeros, never a bar, because the worker
           never holds a bar after its target. Every series a unit hands to `decisionOf` is still a copy (`copyOf`).
         - `lawsearch-audit.ts`'s own source-rule pattern, which names `SharedArrayBuffer` to refuse it. That file is
           not a program module (no realm imports it), but it matches the step's file pattern.
       - Since C4g a cut unit's realm holds no bar after its target (deltas, 7.3), so for the cut nothing a memory
         block could show is a later bar. This step stays defense in depth for poison, presence and the follow-bar
         check.
       - The C4g integrator ran the step as extracted from the yml on the final code: exit 0, every line allowed (15
         matching lines, `poisonSeries`' line twice; the C4g docs writer counted them again).
  10. (C4g, 2026-11-10; the lead's G3, from the C4g designer "process") **Every realm's module graph holds the
      program's own `.ts` code only, and each entry imports the lockdown first.** In the yml this step and the next
      two run right after step 2.
      - Why. In Deno 2.9.6 a worker's module graph is loaded under the read permission of the realm that starts it, not
        under the worker's own. A literal import of a data file, a gmo JSON file or a dump under `research/out`, would be
        read even by a worker with no permission.
      - How. The step writes `deno info --json` of six modules: the four entry points `lawsearch.ts`,
        `lawsearch-par-worker.ts`, `lawsearch-follow-worker.ts` and `lawsearch-flip.ts`, plus `lawsearch-frozen.ts` and
        `lawsearch-lockdown.ts`. Then `research/lawsearch-audit.ts graph` requires:
        - every module of the four graphs is a TypeScript (`esm`) file of the repository, not under `research/out` or
          `research/ledger`, with no error, no dynamic import, and every dependency a module of the graph. So there is
          no JSON or other data module, and no remote, `npm:` or `node:` module;
        - each entry's first two imports are `./lawsearch-lockdown.ts` and then `./lawsearch-frozen.ts`;
          - (C4h, 2026-11-11; C4g's review, the ci-docs reviewer, reproduced by a refuter; the lead's F4) counted as an ES
            module evaluates them: every value module request in source order, re-exports included (`import … from`,
            `import "…"`, `export … from`, `export * from`; `import type` and `export type` are skipped), read twice,
            from the source text (`SOURCE_REQUEST`, the refuter's fixed pattern) and from `deno info`'s own parse of
            the entry (its dependencies that have a `code` specifier, by the position of the request), and both must
            say lockdown, then frozen. C4g's pattern read `import` lines only, so `export { followValues as fv } from
            "./lawsearch-trade.ts";` or `export * from "./lawsearch-trade.ts";` above the lockdown passed, while ES
            evaluation ran the trade module's whole graph first (the refuter saw `lawsearch-events.ts` capture
            CacheStorage before the lockdown deleted it). Shown in 12.9 F4;
        - `lawsearch-lockdown.ts` imports nothing;
        - `lawsearch-frozen.ts`'s graph holds no lawsearch module but `lawsearch-const.ts`, `lawsearch-rules.ts` and
          `lawsearch-types.ts`;
        - `trend-stats.ts` and `bigflow-lib.ts` are imported by `lawsearch-checks.ts` alone. They are the check-only
          code the main thread's checks run (12.7's table).
      - The final code: 63, 55, 45 and 59 modules in the four graphs, every condition held.
  11. (C4g; the lead's G3) **The source rule.** `research/lawsearch-audit.ts source` scans every code line (a line
      whose first non-blank characters are not `//`) of every module of those four graphs, 66 modules on the final
      code.
      - It fails on `node:`, `import(` (a computed dynamic import; step 10 sees a literal one), `eval`, `Function(` or
        `new Function`, `Deno[` or `Deno.internal`, `SharedArrayBuffer`, `Atomics`, or `new Worker`.
      - Three lines are allowed (`SOURCE_ALLOW`): the lockdown's deletion of `Deno[Deno.internal]`, and the two `new
        Worker` lines that start the checks' workers with no permission (`lawsearch-par.ts`, and `lawsearch.ts`'s
        follow-bar worker).
      - Why. The lockdown deletes the shared channels from every realm's globals. A `node:` built-in would bring them
        back (`node:worker_threads` has a BroadcastChannel; `node:process` has signals), and so would code made from a
        string.
      - What it cannot see: a name not written out in the line (`Reflect.get(Deno, symbol)`, a key made at run time);
        an escape in an identifier or a string; `import` and `(` split over two lines or with a comment between; and a
        code line that starts with `//` inside a multi-line template literal. An escaped import specifier is still
        resolved, and refused, by step 10.
  12. (C4g; the lead's G3) **Every Deno call inside a try block, or on a line with `.catch(`, is audited.**
      `research/lawsearch-audit.ts catch` lists every such call in the four graphs. It fails on any that is not one of
      the 19 entries of `CATCH_ALLOW`, each with what a refusal (or any other error) does there.
      - Why. A catch around a Deno API can turn a refused permission into a silent change of the output. The C4g
        designer "process" met exactly that: `writeCsvMode`'s `Deno.stat` read a refused read permission as "no file",
        and eight appended CSVs got repeated header lines.
      - Two catches were changed by this audit. `lawsearch-dump.ts`'s `writeCsvMode` and `lawsearch-gen.ts`'s
        `writeRun` now catch only `NotFound` and throw any other error (4.2). Those two make four entries: each `stat`
        line and each line that rethrows. The other 15 entries are listed with their reasons. For example, the loads'
        reads (through `src.read` in the program) count a failure as a read failure, which fails the data check.
  - Negative tests of steps 10–12 (the C4g integrator, on a copy of the repo). Each failed its step, as it should:
    - a JSON import → graph;
    - a `node:` import → graph and source;
    - a computed `import(` plus a new `try` around `Deno.readTextFile` → source and catch;
    - a worker entry without the lockdown first → graph.

    On the final code all three steps exit 0.
  13. (C4h, 2026-11-11; C4g's review, the ci-docs reviewer, reproduced by a refuter; the lead's F5) **Every module of
      the four graphs is in a push path of `lawsearch.yml` or `lawsearch-audit.yml`.** `research/lawsearch-audit.ts
      trigger` reads both workflows' `on.push.paths` (the plain list form; GitHub's filter patterns, `*` not crossing
      `/` and `**` crossing it; a pattern with any other special character is refused, not guessed) and fails when a
      module of the graphs (step 10's `graph-*.json`) is matched by neither. It prints a path of `lawsearch-audit.yml`
      that matches no module, as information.
      - Why. This workflow runs only on a change to `research/lawsearch*`, `research/money-stats.ts` or itself, but
        the guarantees of 12.7 rest on the text of modules the program shares with other code: `trend-data.ts`'s read
        through `src.read`, `ownerhold-data.ts`'s `Source`, `CATCH_ALLOW`'s pinned lines of `trend-data.ts`,
        `ownerhold-data.ts` and `trend-labels.ts`, who imports `trend-stats.ts` and `bigflow-lib.ts`, and `quotes.ts`'
        frozen maps. 42 of the graphs' 67 modules are outside this workflow's paths (C4h's count). A change to one of
        them ran no audit until the next lawsearch push. `.github/workflows/lawsearch-audit.yml` (below) now runs the
        cheap audits on such a push, and this step keeps its list from going stale.
  14. (C4h, 2026-11-11; C4g's review, the power reviewer, reproduced by a refuter; the lead's F7; outside the threat
      model) **The main realm's freeze refuses the relay hooks.** `research/lawsearch-audit.ts relay` evaluates
      `lawsearch-lockdown.ts` and wants each of four hooks refused with a `TypeError`: wrapping
      `Worker.prototype.postMessage`, redefining its `onmessage` setter, replacing `globalThis.Worker`, and wrapping
      `EventTarget.prototype.addEventListener`. Step 10 shows that the lockdown is the first module request of every
      entry, so these hold in the program's main realm. Seconds. On 12ee6d2's lockdown the step exits 1 (none is
      refused); on C4h's it exits 0 (12.9 F7).

  (C4h, 2026-11-11) In the yml, steps 13 and 14 run right after step 12, before step 3.
- (C4h, 2026-11-11; the lead's F5) **`.github/workflows/lawsearch-audit.yml`**, a workflow of its own (one job,
  `audit`, timeout 30 minutes, Deno only). It runs on a push to the branch that changes any of the 42 modules of the
  four graphs outside `lawsearch.yml`'s paths (each listed by name, from `deno info --json`; and itself), and on
  `workflow_dispatch`. Its steps are `lawsearch.yml`'s hand steps 1, 2, 10, 11, 12 and 13, then `MODE=hand` (step 3).
  It starts none of the multi-hour runs: a change that the audits pass but that changes the program's output is seen
  by the next `lawsearch.yml` run. Hand step 13 runs in both workflows, so a new import of a module that neither list
  names fails the push that adds it (when the importing module is listed) or the next lawsearch push. Shown with
  mutated copies in 12.9 F5: `trend-data.ts`'s read put back to `Deno.readTextFile` fails the catch step; a module
  taken out of the list, or a new module imported by a listed one, fails step 13.
- (C4b, 2026-11-05; written here C4c, 2026-11-07) The workflow sets `WORKERS: "4"` for every job (GitHub's
  `ubuntu-latest` runner has 4 vCPUs), so every run step's checks run their units on 4 workers. No step compares two
  `WORKERS` values: that the bytes do not depend on it (12 rule 3) is shown by local runs (12.1).
  - (C4g, 2026-11-10) `WORKERS: "4"` now means four workers in each of the checks' two pools (7.3). `WORKERS: "0"`
    means one in each, never the main thread (7.7).
  - (C4d, 2026-11-07; the lead's F2) Superseded in part: one step of the `cmp-c-7101` job now runs at `WORKERS=0`
    and compares its bytes with the same plant's `WORKERS=4` dump (syn step 3). It is defense in depth, not a guard
    by construction (12.2 (2)). Every other run step still runs at `WORKERS=4`.
  - (C4e, 2026-11-08; the lead's G2) That step now runs in the jobs `w0-n-1001`, `cmp-c-7101` and `o-6003`, each on
    the job's own clean run, not on a plant (syn step 3). Every other run step still runs at `WORKERS=4`.
  - (C4f, 2026-11-08; the lead's H6) In `cmp-c-7101` that step also runs the plant `lastBarStateG3` at `WORKERS=0`,
    against the plant step's `WORKERS=4` dump (syn step 3).
- **syn** (Python 3.11 + numpy; Deno 2.9.6): one job per run of 10.
  - (C4e, 2026-11-08; the lead's G2) Plus one job, `w0-n-1001`: it makes CMP-N 1001 again (`MODE=syn` with the same
    seed) and runs only the TS run and the `WORKERS=0` step of syn step 3: no Python step (the Python compares N 1001
    in `cmp-n-1001`'s job) and no plants. It is a job of its own because N 1001's `WORKERS=0` run alone took 6,665 s
    locally; inside `cmp-n-1001`, after its plants, that job would have taken about 3.1 h locally (12.5).
  1. TS `MODE=syn`.
     - (C4b, 2026-11-05; removed C4c, 2026-11-07) C4b put a step here: "The checks' one-bar candidates equal
       candidatesOf's rows at every bar", which ran `research/lawsearch-candat-check.ts` on the run's bars (C4b's
       `candidatesAt` at every bar of the uncut series, in a scrambled order, for every trial and pair, with the run's
       options and with `noRisingEdge`). C4c removed the step and deleted the file together with `candidatesAt`
       (5.3, 7.3): no one-bar path is left to compare. The step compared on the uncut series only, one series end
       per pair, so it caught a look-ahead at the series' end only by chance (C4b's review, finding 1; 12 rule 2).
       No "prefix" step replaces it: the C4b reviewer's prototype (`candidatesAt` against `candidatesOf` at the last
       bar of 2,380 cut prefixes of C 7101) and design B's prefix pass both tested `candidatesAt`, and neither was
       taken. The run plants `lastBarStateG3` and `lastBarStateG5` (step 3) guard in its place: on C4b's one-bar path
       they gave exit 0, not the 3 that step 3 wants, so the step fails if such a path comes back. CI loses the step
       (about 90 s per syn job) and gains two plant runs on CMP-C 7101 (212 s and 208 s in C4c's local runs at
       `WORKERS=4`).
  2. `python3 -I research/lawsearch-check.py --run <run>` (its own recompute, then the comparison; exit 5 on a
     mismatch).
  3. The run plants of 8 (`avoidFull` and `secondHalfAll` on CMP-N 1001, `reasonUsesFuture` on CMP-C 7101), each
     with `MODE=walkfiles` on the run's own gmo folder (read only) and `OUT=<RUN>/plant-<name>`, with the expected
     exit and failed check. (C3, 2026-11-05) Also on CMP-N 1001: `dropSecondStrata` (exit 3; `stop.stage0` failed and
     names m15.E04.F00's second half; no stage-1 or stage-2 file) and `blindRowHit` (exit 3; `suspect.blind.stage1`
     failed; the blind row's suspect.csv row has hit 1; print.txt has `withheld.stage1=1` and no `chosen.*` or
     `K_total`; no `syn2` row in load.csv and no stage2.csv). On CMP-C 7101: `chosenCutFirstDiff` (exit 3;
     `cut.chosen.first` failed on a chosen trial, stage `stage1end`, with its row in cut_fail.csv; print.txt has
     `withheld.stage1=1`; no `syn2` row in load.csv and no stage2.csv). Each of the three: print.txt's `note.stage2`
     says "not opened", and cut_fail.csv is written. (C4c, 2026-11-07) Also on CMP-C 7101: `lastBarStateG3` and
     `lastBarStateG5` (exit 3; stage 0's `cut` failed on a trial, with its `cut,stage0` rows in cut_fail.csv; no
     `syn2` row in load.csv and no stage2.csv).
     - (C4c, 2026-11-07) The yml tests, for each of the two: the exit; a failed `cut` row of an m15 or h1 trial in
       checks.csv (`^(m15|h1)\.[^,]*,cut,0,`); a `cut,stage0,` row in cut_fail.csv; no stage2.csv and no `syn2` row in
       load.csv. As a negative control, each of the three file tests flags the clean C 7101 dump (C4c's integrator;
       checked again by the C4c docs writer). C4c's local runs: exit 3; the cut failed on 8 of the 12 trials (m15 and
       h1, E04 and E26, F00 and F01), with 461 (G3) and 423 (G5) cut_fail rows; print.txt's `note.stage2` says "not
       opened". Every file (print.txt without `time.*`) is the same bytes as b3a2c43's with the same plant (the C4c
       restore designer's comparison of all 77 files; the integrator's runs matched on the six small files). C4b's
       code gave exit 0, every file as the clean run.
     - (C4d, 2026-11-07) With B06 cut on its prefix from bar 0 (7.3), the same two plants now also fail the cut on
       m15.B06 and h1.B06: 10 of the 12 trials. G3 has 162 (m15.B06) and 85 (h1.B06) new cut_fail rows, 708 in all.
       G5 has 94 and 52, 569 in all. The plants are real look-aheads that the window used to hide on B06. Against
       C4c's files, only B06's rows differ: the two B06 `cut` rows of checks.csv (passed 1 → 0), the new B06 rows of
       cut_fail.csv (every other row the same), print.txt's `check.cut.detail` (8 → 10 of 12 probes), and
       stage1.csv's B06 rows (`checks_ok` 1 → 0, `fail_rule` 4 → 2). The C4d integrator ran both plants again on
       C4c's code and got C4c's files exactly, so the difference comes from the window's removal alone. The yml's
       tests for the two plants are unchanged and pass.
     - (C4d, 2026-11-07; C4c's review, finding 1; the lead's F1) Also on CMP-C 7101: `carriedCountB06` (8; exit 3).
       Besides the exit, the yml tests that checks.csv has a failed `cut` row of m15.B06 or h1.B06
       (`^(m15|h1)\.B06,cut,0,`), that cut_fail.csv has a stage-0 cut row of a B06 trial
       (`^cut,stage0,(m15|h1)\.B06,`), and that stage 2 was not opened (no stage2.csv, no `syn2` row in load.csv).
       Negative control (the C4d docs writer, on the clean C 7101 dump): each of the three tests flags it. C4d's run:
       exit 3. The cut failed on m15.B06 (1,700 of 38,439) and h1.B06 (970 of 25,630) and on no other trial, with
       2,670 stage-0 rows in cut_fail.csv, all of B06. `cut.chosen.first` still ran on the chosen trial
       (h1.E04.F00) and passed (7.7), and print.txt's `note.stage2` says "not opened". The same plant on b3a2c43
       and on 876b9e4 (both with the window) gave exit 0, every file as the clean run's but `config.json` and
       print.txt's `plant=` line.
     - (C4d, 2026-11-07; C4c's review, finding 2; the lead's F2) Then, in the `cmp-c-7101` job only, the step "The
       same bytes at WORKERS=0 as at WORKERS=4" runs `lastBarStateG3` again with `MODE=walkfiles` and
       `WORKERS: "0"` (every unit in the main thread), into `<RUN>/plant-lastBarStateG3-w0`. It wants exit 3, the
       same list of files as the plant step's `WORKERS=4` dump `<RUN>/plant-lastBarStateG3` made in the same job,
       and every file the same bytes (print.txt without its `time.*` lines). (Superseded in C4e, 2026-11-08: the
       step now compares each job's own clean run, in three jobs; the C4e bullet below. This bullet is kept as the
       record of C4d's step and runs.)
       - Why: 12 rule 3 wants the same bytes for any `WORKERS`. That holds by construction only while every build
         and cache is keyed by the Ind and no module-level state survives between `candidatesOf` calls (12.2 (2)).
         Such state differs between the main thread and each worker, so it can make the bytes depend on `WORKERS`.
       - **Defense in depth, not a guard by construction** (the step's name and comment say so). It sees such state
         only where it changes this one run's bytes. A failing run was chosen so that the comparison covers
         checks.csv, cut_fail.csv and the check details with real failures in them.
       - C4d's runs: on the repo's code the step exits 0 (77 files compared, all equal; the `WORKERS=0` run took
         1,051 s). On C4c refuter 2's module-memo mutant M (a module-level memo of `candidatesOf` keyed by the
         series' buffer, added to C4d's code), the `WORKERS=4` run exits 3 with every trial's cut failed (memo
         noise), and the `WORKERS=0` run exits 0 ("every check passed": the memo hides the plant). The step then
         exits 1: 6 files exist only in the `WORKERS=0` dump and 14 differ. (Corrected C4e, 2026-11-08; C4d's
         review, the ci-docs nit, reproduced by the ci-docs refuter 1; the lead's G3. Until C4e this said "only in
         the `WORKERS=4` dump". The `WORKERS=0` run passed every check, so it opened stage 2 and wrote the stage-2
         files: stage2.csv, blind/m15_second.csv, blind/h1_second.csv, late/m15_second.csv, late/h1_second.csv and
         trades/h1.E04.F00_second.csv. The `WORKERS=4` run failed and never wrote them. The step's `diff` prints
         them as `>` lines, the side of b, the `WORKERS=0` dump. The C4e integrator's runs of M show the same six
         files on the same side.)
       - It adds about 1,050 s of one-thread run to the `cmp-c-7101` job (12.4). (Superseded in C4e: the next
         bullets.)
     - (C4e, 2026-11-08; the lead's G4: no run plant reached the S01 trials) Also on CMP-C 7101: `carriedCountS01`
       (8; exit 3). Besides the exit, the yml tests that checks.csv has a failed `cut` row of an S01 trial
       (`^(m15|h1)\.S01,cut,0,`), that cut_fail.csv has a stage-0 cut row of an S01 trial
       (`^cut,stage0,(m15|h1)\.S01,`), and that stage 2 was not opened (no stage2.csv, no `syn2` row in load.csv).
       - C4e's run: exit 3. Only the cut failed, on m15.S01 (15,404 of 311,962) and h1.S01 (12,110 of 86,600), with
         27,514 stage-0 rows in cut_fail.csv. `cut.chosen.first` ran on the chosen trial h1.E04.F00 and passed
         (29,948 compared), and print.txt's `note.stage2` says "not opened".
       - The same plant on 7e4dfcc (C4d's code) and on b3a2c43 (the plant put into its own `candidatesOf` loop, one
         thread): exit 3, the same counts, and every one of the 77 files identical to C4e's. S01 was cut on its
         prefix from bar 0 in every version (it never had a window), so all three catch it; what was missing was a
         run plant on the S path (12's C4d paragraph: a plant must reach each path).
       - Against the clean C 7101 run, 16 of the 77 files both have differ, among them signals/h1.S01.csv and
         ind/h1_EUR_JPY.csv: the plant also drops an S01 signal on EUR/JPY h1's last bar in the main run, and the
         ind/ rows include every bar of signals/ (`lawsearch-dump.md` 5). Both changes are expected.
     - (C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's q1; the lead's G1) Also on
       CMP-C 7101: `bufferReadE04` (8; exit 3). Besides the exit, the yml tests that checks.csv has a failed `cut`
       row of an E04.F00 or E04.F01 trial (`^(m15|h1)\.E04\.F0[01],cut,0,`), that cut_fail.csv has a stage-0 cut
       row of such a trial, and that stage 2 was not opened.
       - C4e's run (copies): exit 3. The cut failed on m15.E04.F00 (277 of 34,556), m15.E04.F01 (17 of 30,798),
         h1.E04.F00 (295 of 24,274) and h1.E04.F01 (27 of 23,489), with 616 stage-0 rows in cut_fail.csv. Poison and
         presence failed on the four E04 trials too, and so did `suspect13.poison1000` and `suspect13.presence` of
         the two stage-1 hit trials (m15.E04.F00, h1.E04.F00). No trial was chosen, and stage 2 was not opened. The
         yml's tests pass.
       - The same plant on 7e4dfcc (the cut prefix a view): exit 3, but the **cut passed** (694,767 compared, none
         differs) and cut_fail.csv has its header only. Only poison, presence and the two `suspect13` checks failed:
         they make fresh arrays, so they were the backstop. The yml's tests for this plant fail there, as wanted: the
         plant was missed by the cut. Against 7e4dfcc with the plant, C4e's run has the same 76 files, and only
         checks.csv (the four E04 cut rows), cut_fail.csv (616 rows) and print.txt (`note.stage2` now names `cut`;
         `check.cut.passed` and `check.cut.detail`) differ.
       - Not run on b3a2c43. Its cut prefix is a view too, so it would be expected to miss the plant as 7e4dfcc
         does; that is not measured.
       - The plant also changes the main run: on the uncut series, `storeOf(C)` is C itself, so the main run drops
         E04's raw signals by the true next close (a look-ahead), except on the series' last bar. So signals/ and
         ind/ of the E04 trials, and what is built on them, differ from the clean run.
     - (C4f, 2026-11-08; C4e's review, the power reviewer and refuters 1–4; the lead's H4) Also on CMP-C 7101:
       `seriesStashE04` (want exit 6), `trialStashE04` (exit 1) and `avoidStashR3` (exit 1) (8; the plants' line of
       the matrix ends `… bufferReadE04:3 seriesStashE04:6 trialStashE04:1 avoidStashR3:1`). Each keeps a
       look-ahead's answer where, until C4f, the checks read the main run's objects: the universe's arrays, the trial
       object, the avoid table. On C4f's code each is stopped in stage 0, before any check runs. None writes print.txt.
       - (C4g, 2026-11-10; the lead's G4) `seriesStashE04` now wants exit 7, the detector's new code (2.3). The matrix
         line ends `… seriesStashE04:7 trialStashE04:1 avoidStashR3:1`. The C4g integrator's run: exit 7 in 24 s, no
         dump folder, the yml's tests pass. Its run and the other nine C 7101 plants' runs on C4g's code each gave
         C4f's kept sha256 list (print.txt without `time.*`): 12.1's C4g paragraph.
       - The yml's tests, besides the exit:
         - `seriesStashE04`: a `CHANGED:` line naming a `fileKey` array (`^CHANGED: .*\.pairs\.[0-4]\.fileKey`) and no
           dump folder `plant-seriesStashE04` (the universe detector, H3);
         - `trialStashE04`: the line `TypeError: Cannot add property __peek, object is not extensible` (the frozen
           `TrialDef`, H2) and no print.txt;
         - `avoidStashR3`: the line `Error: the avoid table is read-only: add refused` (the read-only avoid table,
           H2) and no print.txt.

         The step's comment says the same. With the detector and the freezes taken out, each is caught by the cut
         (below).
       - On C4f's code (the C4f integrator's runs). `seriesStashE04`: exit 6 in 16 s, with `CHANGED: stage 0, after
         the main run's part: 10 values of stage 0 (syn0)'s main run's universe differ from their digest at the load
         (syn0.m15.pairs.0.fileKey, …)`, the five pairs' `fileKey` on both timeframes; the dump folder was removed.
         `trialStashE04` and `avoidStashR3`: exit 1 in 12 s each, thrown in stage 0's main part (`trialSignals`); the
         folder holds `config.json` alone. The yml's tests pass on all three.
       - On fcce9e6 (the plants' lines copied verbatim into C4e's code, `c4f/copies/c4e-plants` in the C4f scratch
         folder). Each gave exit 0 with every check passed, and the yml's tests fail: **missed**.
         - `seriesStashE04` (477 s): the cut found 0 differing on every trial (on the four E04 trials 0 of 34,556,
           30,798, 24,274 and 23,489), and poison and presence found 0 of 200 on all 12 trials. No trial was chosen,
           because the stash dropped E04's signals in the main run.
         - `trialStashE04` (467 s): the same.
         - `avoidStashR3` (608 s): every check passed and stage 2 opened (h1.E04.F00 chosen). The look-ahead did act
           on the main run: stage 0 counted m15.S01 136,756 / 144,372 (first / second half) against the clean run's
           136,764 / 144,380, h1.E26.F00 738 against 739, and h1.S01 30,322 / 31,922 against 30,330 / 31,926.
       - With H2 and H3 taken out and H1 kept (`c4f/copies/noguard`: no freeze, no read-only Set, no digest compare):
         each gave exit 3, caught by the checks, and stage 2 was not opened. This is the power by construction.
         - `seriesStashE04` (485 s): the cut failed on m15.E04.F00 (277), m15.E04.F01 (17), h1.E04.F00 (295) and
           h1.E04.F01 (27). Its cut_fail.csv equals `bufferReadE04`'s: the same look-ahead. Poison failed 54, 58, 42 and
           56 of 200 and presence 60, 69, 90 and 78 of 200 on those trials, and so did 13's poison1000 and presence.
           The yml's tests for `bufferReadE04` pass on it.
         - `trialStashE04` (471 s): the same cut rows (cut_fail.csv equals `bufferReadE04`'s), poison 27, 30, 39 and 38
           and presence 40, 40, 52 and 46 of 200. These counts differ from `bufferReadE04`'s because, with H2 off,
           each worker's own copy of a check trial keeps its stash from one unit to the next: state inside the mutant.
         - `avoidStashR3` (455 s): the cut failed on m15.S01 (24), h1.E26.F00 (1) and h1.S01 (16), the same rows as
           `reasonUsesFuture`'s cut, and presence failed on all 12 trials (156–194 of 200). The yml's tests for
           `reasonUsesFuture` pass on it.
       - The refuters' own mutants, ported to C4f's code (`c4f/copies/mk2.py`):
         - `rp1wr`, refute-power-1's `seriesWriteE04` (always on): exit 6 in 17 s (`CHANGED: … fileKey`, the folder
           removed). On noguard it gave exit 3, with checks.csv and cut_fail.csv equal to `bufferReadE04`'s.
         - `rp4w`, refute-power-4's m15 universe writes and h1 trial expando: exit 1 in 14 s (`TypeError: Cannot add
           property rp4, object is not extensible`). On noguard it gave exit 3, and the cut failed on m15.E04.F00
           (472) and F01 (116), the universe-write channel, and on h1.E04.F00 (330) and F01 (69), the trial-expando
           channel.
         - `rp3rs`, refute-power-3's `rs-wt` (③'s future answer kept in the avoid Set): exit 1 in 14 s (the avoid
           table is read-only). On noguard it gave exit 3, with checks.csv and cut_fail.csv equal to the noguard
           `avoidStashR3`'s.
         - `rp3by` (`rp3rs` writing with `Set.prototype.add.call`, which passes H2's read-only Set), on the full C4f
           code: exit 3 in 462 s, caught by H1. The cut failed on m15.S01 (24), h1.E26.F00 (1) and h1.S01 (16), and
           presence failed too. Its checks.csv and cut_fail.csv equal the noguard `avoidStashR3`'s, and its
           cut_fail.csv equals C4e's `reasonUsesFuture`'s. H3 does not watch the avoid table.
     - (C4f, 2026-11-08; the C4e docs writer's observation; the lead's H8) On CMP-N 1001: `chosenCutSecondDiff` (8;
       exit 3), the first run plant that fails `cut.chosen.second` and so runs 7.7's D9 path: a failed
       `cut.chosen.second` withholds stage 2's numbers. N 1001 opens stage 2 and chooses m15.E04.F01 and m15.B06 and
       h1.B06. Besides the exit, the yml tests the following:
       - a failed `cut.chosen.second` row of a trial, stage `stage2`, in checks.csv
         (`^(m15|h1)\.[^,]*,cut\.chosen\.second,0,.*,stage2$`);
       - a `cut.chosen.second,stage2,` row in cut_fail.csv;
       - `withheld.stage2=1` in print.txt, and no `verdict.` line;
       - stage2.csv written (stage 2's dumps are still written);
       - no `withheld.stage0` or `withheld.stage1` line;
       - `K_total=` in print.txt (stage 1's choice is shown).
       - The C4f integrator's run (1,987 s): exit 3. `cut.chosen.second` failed on m15.E04.F01, 1 of 94,869 (the
         planted bar), with its one row in cut_fail.csv, and every other check passed. The yml's tests pass. Against
         the clean N 1001 run, 81 of the 85 files are identical. The four that differ are checks.csv (the failed
         row), config.json (`plant`), cut_fail.csv (the row) and print.txt (`plant=`, the three verdict lines gone,
         `check.cut.chosen.second.*`, `withheld.stage2=1` and `exit=3`).
     - (C4e, 2026-11-08; C4d's review, the ci-docs finding, reproduced by the ci-docs refuter 2; the lead's G2) **The
       step "The same bytes at WORKERS=0 as at WORKERS=4" now compares each job's own clean run**, in three jobs:
       `w0-n-1001`, `cmp-c-7101` and `o-6003`. Until C4e it ran `lastBarStateG3`, which chooses no trial
       (`cut.chosen.first` has nothing to cut) and never opens stage 2: only stage 0's pool runs were compared, and
       the pool runs of `cut.chosen.first`, `cut.chosen.second` and `suspect13` never happened in it. C4d's ci-docs
       refuter 2 showed a mutant (module-level state read only by one-trial cut jobs) that was silent in that step
       and gave different bytes on `carriedCountB06`.
       - What it does: it runs the job's run again with `MODE=walkfiles`, `RUN` = the run, `OUT=<RUN>/ts-w0`,
         `WORKERS: "0"` and no plant, and compares it with the job's `ts/`, which the step "TS (MODE=syn)" made at
         `WORKERS=4`. It wants the job's exit (`matrix.want`: 0, 0 and 3), the same list of files, and every file the
         same bytes. The only differences allowed are those MODE itself makes: print.txt's `mode=` line (`syn` in
         ts/, `walkfiles` in ts-w0) and its `time.*` lines, and config.json's `"mode"`. The run folder is the same
         string in both (the syn step's `OUT` is the step's `RUN`), so the `run` fields are equal.
       - Which pool runs it compares (each a separate run of the worker pool; from the three runs' choice.json and
         checks.csv):

         | pool run | N 1001 (`w0-n-1001`) | C 7101 (`cmp-c-7101`) | O 6003 (`o-6003`) |
         |---|---|---|---|
         | stage 0's `cut`, m15 and h1 (6 trials each) | yes | yes | yes, with failures and cut_fail.csv rows |
         | stage 0's `poison` and `presence` (12 trials) | yes | yes | yes, failing on the E26 trials |
         | `cut.chosen.first`, m15 | 2 trials in one pool run (E04.F01, B06) | none chosen | 1 trial (E04.F01) |
         | `cut.chosen.first`, h1 | 1 trial (B06) | 1 trial (E04.F00) | 1 trial (E04.F00) |
         | `cut.chosen.second`, m15 | 2 trials (E04.F01, B06) | none chosen | stage 2 not opened |
         | `cut.chosen.second`, h1 | 1 trial (B06) | 1 trial (E04.F00) | stage 2 not opened |
         | stage 1's `suspect13` cut, poison1000 and presence | no hit | no hit | the 4 E26 hit trials, one trial per pool run |

       - **Not compared**: stage 2's `suspect13` checks (no synthetic run reaches them: O runs never open stage 2,
         and N, C and FLIP have no suspicion hit); the FLIP runs and the plants' runs (they reach no kind of pool run
         that the three runs lack: FLIP 1001 chooses N 1001's two m15 trials); and the pool runs of trials no
         synthetic run builds (the higher-timeframe path F02, F02r and S02, and every item not built). The step
         still sees module-level state only where it changes these three runs' bytes. The step's comment in the yml
         lists the same.
       - **Defense in depth, not a guard by construction**, as before (the step's name and comment say so).
       - Results (the C4e integrator; the step extracted verbatim from the yml, `c4e/ymlstep/w0step.sh`, run on the
         C4e `WORKERS=4` identity dumps, which are `MODE=walkfiles` dumps): N 1001 exit 0, 85 files equal, its
         `WORKERS=0` run 6,665 s (`time.total`); C 7101 exit 0, 83 files, 1,384 s; O 6003 exit 0 (its `WORKERS=0` run
         exits 3, as wanted), 77 files, 2,226 s. The normalisation for CI's `MODE=syn` dump was tested on a stand-in:
         C 7101's dump with config.json's mode and print.txt's `mode=` edited as `MODE=syn` writes them (and a
         `time.gen.ms` line), through a fake deno: exit 0; with one byte of checks.csv changed: exit 1. The step has
         not run on a real `MODE=syn` dump, nor in GitHub Actions. (C4f, 2026-11-08: that stand-in left checks.csv's
         print row as it was, so it could not show that the step failed on correct code. The step is now fixed and
         tested on real `MODE=syn` dumps (the C4f bullet below). It has still not run in GitHub Actions.)
       - Its power on mutants (each first run at `WORKERS=4` on C 7101, then the step on that dump):
         - mutR (C4d's ci-docs refuter 2's mutant, `c4d/refute-ci-docs-2`, ported to C4e's code): module-level
           state read only by one-trial cut jobs; each module copy (the main thread, each worker) marks the first
           unit of the first one-trial cut job it sees. `WORKERS=4`: exit 3, `cut.chosen.first` on h1.E04.F00 with
           4 of 29,948 differing (one per worker). The step exits 1: the `WORKERS=0` run exits 3 with 1 row where 0
           is wanted, and checks.csv, cut_fail.csv and print.txt differ.
         - M (C4c refuter 2's memo of `candidatesOf`, keyed by `C.buffer`, `C.byteOffset`, the trial and the options)
           on 7e4dfcc: `WORKERS=4` exit 3, the cut failed on all 12 trials. The step exits 1: the `WORKERS=0` run
           exits 0 (in the main thread the main run fills the memo on the uncut memory block first, so every cut
           prefix, a view at offset 0 of that block, gets the main run's rows and the cut is hidden); 6 files exist
           only in the `WORKERS=0` dump and 14 differ.
         - M on C4e's code: inert. `WORKERS=4` exit 0, all 83 files equal to the clean run's, and the step exits 0.
           Every cut prefix now has its own memory block, so the memo never matches across series. (Inert here is
           not power: there is nothing to find.)
         - M2 (new in C4e, to show the step's power on a memo on C4e's code): the same memo keyed by the series' pair
           and timeframe, the trial and the options, which the copies do not defuse. `WORKERS=4`: exit 3, all 36 cut,
           poison and presence rows of stage 0 fail (each worker's memo holds stale rows). The step exits 1: the
           `WORKERS=0` run exits 0 (the main thread's memo holds the main run's rows and hides every check); 6 files
           exist only in the `WORKERS=0` dump and 14 differ.
       - Its cost, and the CI time of each job: 12.5.
     - (C4f, 2026-11-08; C4e's review, the ci-docs reviewer, each point reproduced by a ci-docs refuter; the lead's H5
       and H6) **The step's compare fixed and tested on real `MODE=syn` dumps; a plant run added; its power stated
       as it is.**
       - The bug (H5). In CI the job's `ts/` is a `MODE=syn` dump, and its print.txt has one key more than a
         `MODE=walkfiles` run's: `time.gen.ms`, which `lawsearch.ts` writes only when it generated the run. The print
         check's row of checks.csv, `*,print,1,<n> compared; none differs,end`, counts print.txt's keys. So it is one
         higher in `ts/` than in `ts-w0`, and C4e's step, which compared checks.csv byte for byte, failed on correct
         code. C4e's stand-in (a walkfiles dump with print.txt and config.json edited to look like a `MODE=syn` dump,
         checks.csv not edited) could not show that.
       - The fix: one function, `same <a> <b>`, for every compare of the step. It compares the file lists, then each
         common file. When a's print.txt has the line `mode=syn` (a `MODE=syn` dump against its `MODE=walkfiles`
         rerun b), exactly three differences are allowed:
         1. print.txt's `mode=` line and its `time.*` lines;
         2. config.json's `"mode"`;
         3. checks.csv: compared byte for byte without its `*,print,` row, and that row's count of keys in a must be
            exactly b's + 1. Both counts must be read from a passing print row, or the step fails.

         Two walkfiles dumps may differ only in print.txt's `time.*` lines. The step prints `<b> against <a> (MODE=syn
         dump: 0|1): <n> files compared`. The C4e reviewer's tested variant
         (`c4e/review-ci-docs/ymlstep/w0step-fixed.sh`) did the same for the print row.
       - **Tested on real `MODE=syn` dumps, at `WORKERS=0`** (the C4f integrator; the step extracted verbatim from the
         yml, `c4f/ymlstep/w0step.sh`, with `matrix.name` = `cmp-c-7101`):
         - The `MODE=syn` dump: `GEN=C SEED=7101 FLIP=0`, `WORKERS=4`; generation 6.6 s, `time.total` 562 s. Its gmo
           folder's tree equals the synthetic C 7101 folder's. Its 83 files equal C4e's walkfiles dump of C 7101 but
           for print.txt's `run=`, `mode=` and `time.*` lines (`time.gen.ms` among them), config.json's `run` and
           `mode`, and checks.csv's print row: 90 keys against 89. Its `lastBarStateG3` plant dump at `WORKERS=4`
           (448 s): exit 3, the yml's tests pass, and checks.csv and cut_fail.csv equal C4e's kept files.
         - The step on them: the clean part's `WORKERS=0` rerun exits 0 (1,542 s). All 83 files are equal under the
           `MODE=syn` rules, the print row's 90 against 89 accepted. The plant part's `lastBarStateG3` at `WORKERS=0`
           exits 3 (1,349 s), and its 77 files equal the `WORKERS=4` plant dump's. The step exits 0, in 2,896 s.
         - Again on a second `MODE=syn` dump made the same way (clean part only): exit 0, its `WORKERS=0` run 1,549 s.
         - Controls on that real pair (the step with a fake deno that puts the real `WORKERS=0` dump in place, a
           copy of the `MODE=syn` dump edited): unchanged → exit 0; a cut row of checks.csv changed → 1; the print
           count made equal to b's → 1; made two more → 1; the `mode=syn` line changed to walkfiles → 1; stage0.csv
           changed → 1; and, in a first queue, a plant file changed → 1. The first queue's "row changed" control was
           faulty (its edit left checks.csv unchanged), and the second queue's replaced it.
       - The plant run (H6). In `cmp-c-7101` only, after the clean compare, the step runs `LS_PLANT=lastBarStateG3`
         with `MODE=walkfiles` at `WORKERS=0` into `<RUN>/plant-lastBarStateG3-w0`. It wants exit 3 and compares the
         dump with the plant step's `WORKERS=4` dump `<RUN>/plant-lastBarStateG3` by `same`. Both are walkfiles dumps,
         so only the `time.*` lines may differ. It adds about 1,350 s to the job (12.6).
       - **What the step can show** (H6; the step's comment says the same):
         - A change that makes the job's run fail at `WORKERS=4` fails the job at its "TS (MODE=syn)" step, and this
           step is never reached. The mutants mutR, M on 7e4dfcc and M2 on C4e's code all do that: exit 3 on clean
           C 7101 at `WORKERS=4`. So C4e's evidence that "the step fails on mutR, M and M2" (above) came from running
           the step by hand on their `WORKERS=4` dumps. In CI those mutants fail the job one step earlier.
         - What only this step sees is a change whose `WORKERS=4` runs pass every earlier step but whose
           `WORKERS=0` run differs. On the clean runs that means a change that makes a check fail, or the main run
           differ, at `WORKERS=0` only. No such mutant has been shown.
         - A change that HIDES a look-ahead at `WORKERS=0` only gives the same bytes on a clean run, where there is
           nothing to hide. That is state in the main thread's module instances that hands the checks the main run's
           answer. Only a plant run shows it.
         - C4f's test mutant `w0hide` (`c4f/copies/w0hide-mine`) does exactly that. A module-level Map in
           `lawsearch-events.ts` keeps the first n seen per trial and pair in its thread, and `lastBarStateG3` and
           `lastBarStateG5` are turned off on every shorter series. At `WORKERS=0` the main run's full series come
           first, so every cut prefix gets the main run's decision. A worker first sees a check's own series.
           - `WORKERS=4` with `lastBarStateG3`: exit 3, and checks.csv, cut_fail.csv and print.txt equal C4e's kept
             G3 files. In a worker the hiding does nothing.
           - `WORKERS=0` with `lastBarStateG3`: exit 0. Every check passed and stage 2 opened (h1.E04.F00 chosen).
             14 files differ from the `WORKERS=4` dump, and the stage-2 files exist only at `WORKERS=0`.
           - The step run verbatim: exit 1, from its plant part. Its clean part was stood in
             (`c4f/ymlstep/halffake.sh`) and not run on the mutant.

           This is 12.2 (2)'s residual made concrete: at `WORKERS=0`, module-level state can hide a planted
           look-ahead from every check.
         - It cannot see state that gives the same bytes at both settings. Nor can it see such state hiding a
           look-ahead that no plant here carries: only `lastBarStateG3` is run at `WORKERS=0`, which reaches E04,
           E26 and B06's last-bar path.
       - The C4f runs of the step (each as extracted from the yml, on the C4f code): N 1001 (`w0-n-1001`) exit 0, 85
         files equal, the `WORKERS=0` run 6,732 s, the step 6,737 s; O 6003 exit 0 (its `WORKERS=0` run exits 3, as
         wanted), 77 files, the step 2,432 s; C 7101 on the real `MODE=syn` dump, above. For N 1001 and O 6003 the
         `WORKERS=4` dump was the kept walkfiles `ts/`.
     - (C4g, 2026-11-10; the lead's G2) **What `WORKERS=0` is now, and what the step can still show.**
       - The step is unchanged but for its runs' permissions. Each of its two runs is `DENO_WALK` plus
         `--allow-write=<its own dump folder>`. Its comment is updated.
       - `WORKERS=0` no longer runs the units in the main thread. It runs one worker in each of the checks' two pools,
         exactly as `WORKERS=1` does (7.7). So the step now compares one worker per pool against four.
       - The C4f reading above, that module state "HIDES a look-ahead at `WORKERS=0` only" through the main thread's
         module instances, no longer applies. The main run's state is in no check realm at any setting (12.7).
         `w0hide`'s kind is now run as the plant `w0protoG3` in the job `plants-c4g`, at `WORKERS=0`, and the cut
         catches it there. On b322c13 it was missed (8).
       - What the step can still see: state that one unit leaves for a later one in its worker, when that state
         changes with how the units are spread over the workers. One worker meets every unit of a check run; at 4, a
         worker meets about a quarter of them. That spread depends on timing, because a pool gives the next job to
         whichever worker answers first.
       - For the cut, such state can hold no bar after the target (deltas). For poison and presence it can (12.7,
         residual 2). Clean code keeps no such state, and every comparison of this round was byte-equal.
       - It stays defense in depth, not a guard (12 rule 3).
       - The C4g integrator ran the step verbatim on the final code: `cmp-c-7101` (the clean C 7101 run and its
         `lastBarStateG3` plant, 83 + 77 files equal), `o-6003` (77) and `w0-n-1001` (85). Each step exited 0.
         - `WORKERS=0` `time.total`: C 7101 1,357.6 s, the plant 1,207.2 s, O 6003 2,362.7 s, N 1001 6,624.2 s. On
           C4f's code these were 1,542, 1,349, 2,429 and 6,732 s.
         - Each run was made beside one other heavy run.
       - CUT_MAX=1 C 7101 at `WORKERS=0` also equalled b322c13's `WORKERS=4` dump, file for file, three times.
  4. O's runs expect exit 3, the cut and poison checks failed, and the E26 rows' suspicion hit. (C3, 2026-11-05; the
     lead's D8) They now end before stage 2. The O step still requires the cut and poison failures on the four E26
     trials, their stage-1 suspicion hits, and no other failed check; it also requires that stage 2 was not opened
     (no `stage2` row in checks.csv, no stage2.csv, and print.txt's `note.stage2` says "not opened").
  5. The flip job (from 2026-11-05, spec 23.1): `research/lawsearch-flip.ts <FLIP=0 run> <FLIP=1 run>` judges 14.2's
     conditions on the exact mirror of the FLIP=0 run (built from its files, nothing written) and prints the FLIP=1
     run's dump differences as INFO lines; then `--run` on the FLIP=1 run (the TS–Python comparison). (C3) The tool
     is tied to the run it judges (7.9).
- (C4g, 2026-11-10; the lead's G5) **plants-c4g**: a job of its own (`needs: hand`, timeout 360 minutes, no Python).
  It holds one run plant per channel of C4f's review and of the C4g judges (8). Each of these was MISSED on b322c13,
  and each must be caught here by a named check, or stopped with a clear error.
  - It makes its own C 7101 data first: `MODE=syn GEN=C SEED=7101`, `DENO_WALK --allow-write=<its folder>`, wanting
    exit 0. The data are the same bytes as `cmp-c-7101`'s.
  - It then runs each plant with `MODE=walkfiles` on that data, into the plant's own folder, with the plant's own write
    grant. `gmoWriteR` alone uses `DENO_RUN`, whose broad write grant lets its write into the gmo folder happen. Each
    plant's wanted exit and tests:
    - `rp2EnvE04`, `WORKERS=4`: exit 1, a line `NotCapable: Requires env access to "RP2E04_…`, no print.txt.
    - `avoidStashR3call`: exit 3, a failed `cut` or `presence` row in checks.csv (printed), stage 2 not opened (no
      stage2.csv, no `syn2` row in load.csv).
      - (C4h, 2026-11-11; C4g's review, both reviewers, reproduced by a refuter; the lead's F1) **In C4g the row test
        could never fail.** The line was `grep -E ",(cut|presence),0," … | cut -c1-160 || {…}`. A step with no
        `shell:` runs as `bash -e`, without `pipefail`, so the pipeline's status was `cut`'s, always 0: only the exit
        and stage 2 were enforced. Now `grep -q` decides, and the rows are printed after it. No other line of the yml
        has that form (C4h checked every `| … ||` and `if … | …`: the others test the right command or use process
        substitution). Shown with the extracted step and a fake deno replaying C4g's kept plant outputs (12.9 F1).
      - (C4h; the lead's F3) Its presence failures halve: m15 E04.F00 186 → 93, E04.F01 190 → 95, E26.F00 192 → 96,
        E26.F01 182 → 91, S01 174 → 87, B06 178 → 89; h1 190 → 95, 156 → 78, 192 → 96, 186 → 93, 186 → 93, 194 → 97.
        The cut rows (m15.S01 24, h1.E26.F00 1, h1.S01 16), every poison row and cut_fail.csv are unchanged, and the
        exit is still 3 (8, 12.9 F3).
    - `lenmemoEntryEarly`: exit 3, and the rows `*,follow-bars m15 first,0,` and `*,follow-bars h1 first,0,` in
      checks.csv.
    - `judgeListen2E04`: exit 3, a failed `cut` row of an E04.F00 or E04.F01 trial in checks.csv, a stage-0 cut row of
      such a trial in cut_fail.csv, stage 2 not opened. The E04 trials' poison and presence rows are printed as
      information only: they pass, which is the residual by the spec (12.7).
    - `judgeCacheCarryE04`, run twice into two folders: each run exits 3, with the same E04 cut tests and stage 2 not
      opened, and run 2's cut_fail.csv must be the same bytes as run 1's. Something carried from run 1 into run 2
      would change it, as CacheStorage did on b322c13. The job does not compare presence rows, which vary with timing
      for this plant (12.7, residual 2).
    - `w0protoG3` at `WORKERS: 0`: exit 3, a failed `cut` row in checks.csv, a stage-0 cut row in cut_fail.csv, stage 2
      not opened.
    - `gmoWriteR`, `WORKERS=4`: exit 0, and:
      - the plant's write line;
      - at stages 1 and 2, the probe line `… bid close: disk 113.218, the checks' snapshot 113.217, the main run's
        universe 113.217`, exactly;
      - the gmo file's sha256 the same after the run as before;
      - every dump file the same as the job's clean `ts/`. The only differences allowed are print.txt's `time.*`,
        `mode=` and `plant=` lines, config.json's mode and plant, and checks.csv's print row, since the clean `ts/` is a
        `MODE=syn` dump.
  - The step exits 1 if any test fails. An artifact keeps the manifest, `ts/` and every `plant-*/`.
  - The C4g integrator ran the step verbatim three times:
    - on C4g's final code, beside another heavy run: exit 0, `bad=0`;
    - on C4g's final code, alone: exit 0, `bad=0`, in 4,167 s;
    - on b322c13 with the same plants (`c4g/copies/b3p`), alone: exit 1, `bad=1`, in 5,257 s. Five plants were
      missed there: `rp2EnvE04`, `judgeListen2E04`, `judgeCacheCarryE04` (its run 2), `w0protoG3` and `gmoWriteR`.
      `lenmemoEntryEarly`'s follow-bars test failed too. Only `avoidStashR3call` was caught, by H1 (8).
  - Its local time is about 1.3 h (12.8). It has not run on GitHub.
  - (C4h, 2026-11-11) C4h's run of the step, verbatim from the C4h yml, alone, and its time: 12.9.
- (C3, 2026-11-05; the lead's D5) No step sets `CUT_MAX` (the builder checks the yml); the Python's `--run` refuses a
  capped run (exit 2). (C4b, 2026-11-05) Except hand step 7 (the lead's E13), which sets only invalid values and
  expects the refusal; no run step sets it. The Python's `--compare` refuses a capped run too (the lead's E14;
  `lawsearch-dump.md` 2).
- No job reads real data and none has `--allow-net`. No real-data job is written yet.

### 7.9 `research/lawsearch-flip.ts` (spec 14.2, 23.1; C3, 2026-11-05)

```
deno run --sloppy-imports --no-config --v8-flags=--max-old-space-size=12288 --allow-read=. \
  research/lawsearch-flip.ts <run> [<flipped run>] [--ts <the run's dumps>] [--flipped-ts <the flipped run's dumps>]
```

(C4g, 2026-11-10; the lead's G3) The yml now runs it with `--no-prompt` and
`--v8-flags=--max-old-space-size=12288,--disallow-code-generation-from-strings`, still with `--allow-read=.` alone (no
write, no environment). Its first two imports are `lawsearch-lockdown.ts` and `lawsearch-frozen.ts`, as in every entry
point, and its module graph is one of the four the hand job audits (7.8 hand steps 10–12). It starts no worker. It still
reads the run's files from the disk, after `treeSha256` has checked them against the manifest, and runs no main-run code
before that check. Its judgement on N 1001 and FLIP 1001 with the C4g code: exit 0, RESULT pass, the same as C4f's.

- What it judges (written in C2): the original (FLIP=0) run's gmo files read under spec 2, mirrored exactly about the
  pair's S with no rounding of spec 2, and everything above them rebuilt (10's FLIP row); 14.2's three conditions
  are judged on that mirror. The FLIP=1 run's dumps are compared with the original's as INFO lines, never judged.
  Exit: 0 every judged condition passed; 3 a judged failure or a STOP; 1 a crash; 2 usage.
- (C3; the lead's D3; C2 review finding 3) The judgement must be of the run named:
  - Before it reads a bar, it checks `<run>/gmo`'s tree sha256 and file count against `<run>/manifest.json`
    (`treeSha256` and `files`; `lawsearch-dump.md` 1), with `treeSha256` of `lawsearch-gen.ts`, as `lawsearch.ts`'s
    gate 3 does. A mismatch prints `STOP: <run>/gmo: tree sha256 … (n files), the manifest's … (n)` and exits 3.
  - The trials come from `<ts>/config.json`'s `trials`. A missing or unreadable `config.json` is a FAIL (RESULT
    fail, exit 3); there is no fallback to the trial's twelve.
  - For each trial, a missing `<ts>/signals/<trial>.csv` is a FAIL. A missing `<ts>/blind/<tf>_first.csv` (m15 and
    h1) is a FAIL. When the run opened stage 2 (its `<ts>/load.csv` has a `syn2` row), a missing
    `<ts>/blind/<tf>_second.csv` is a FAIL; a missing `load.csv` is a FAIL too (stage 0 always writes it). Before,
    each of these was reported as "no … to compare with" and the ORIGINAL line still passed. ("Reached stage 2" read
    as a `syn2` row in `load.csv`, and the missing `load.csv` as a FAIL: the C3 docs writer's readings, confirmed by
    the lead 2026-11-05, C4a.)
  - The refuter's setups in
    `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c2/refute-3`
    must now fail: (A) C 7101 with an empty `--ts` (FAIL: no config.json, no signals, no blind; exit 3) and (B)
    `fake-c7101` (C 7101's manifest with N 1001's gmo; STOP on the tree sha256, exit 3). Its control (C), the fake
    gmo with C 7101's real dumps, still fails (exit 3).
  - (C4b, 2026-11-05; the lead's E13) The same check for the flipped run: when `<flipped run>` is given, before
    any bar of it is read, the tool checks `<flipped run>/gmo`'s tree sha256 and file count against `<flipped
    run>/manifest.json` (`treeSha256` and `files`), as for the original, with the same STOP text
    (`STOP: <flipped run>/gmo: tree sha256 … (n files), the manifest's … (n)`) and exit 3. The check `flip` true in
    that manifest stays. Reason: the FLIP=1 run's dumps are only INFO lines, but the lines must still be of the run
    named; before, the tool read the flipped manifest's `flip` and nothing else, so a FLIP=1 folder whose gmo was
    not its manifest's passed unseen. Test (as the refuter's (B) setup of C2, for the flipped side): N 1001 as the
    original and, as the flipped run, a folder with FLIP 1001's `manifest.json` over N 1001's gmo (read only) → STOP
    on the flipped run's tree, exit 3; the real N 1001 / FLIP 1001 pair → both trees pass (the passing line for the
    flipped run is the builder's form), and the rest as before.
- Settled by the lead 2026-11-05 (D11, spec 23.1): "2 で作った5分足" is read as the trial timeframes' bars that spec 2
  builds from the run's 15-minute and 1-hour files (no 5-minute file exists), mirrored, with the higher bars rebuilt
  from the mirror. S is the generator's start `GEN_START` in points (spec 14.1's 始値, the centre FLIP=1 uses), read
  back from the files as the first bar's Bid open + floor(spread ÷ 2) and checked against `GEN_START`; spec 2's
  rounded first mid open can differ by 1 point (N 1001: AUD/JPY 80001 against 80000), and any whole-point S keeps h
  and PL exact (C2 refute 7 measured no change).

---

## 8. The planted errors of spec 16 in the trial

Each plant is one name, read by the module that owns the error. It must make at least one of the named checks fail.
"(step 4)" marks the catchers that need sets or items that the trial does not run. Those are listed for later and not
required now.

| plant | owner: where | what it does | must be caught in the trial by |
|---|---|---|---|
| `htfOpen` | A: htfIndex | g = the last higher bar with s_g ≤ s_i (may be forming) | hand A.1.12, A.1.13 (`usable_htf_for_base_bar`); cut once F02 is built (step 4) |
| `entryAtSignalClose` | C: tradeOf | entry at the signal bar's close | hand A.1.26 |
| `entryEarly` | C: tradeOf | j − 1 | hand A.1.26 |
| `exitLate` | C: tradeOf | x + 1 | hand A.1.26, A.1.31 |
| `noSubstituteExit` | C: tradeOf | no trade when no bar closes at X | hand A.1.27, A.1.29 |
| `reasonUsesFuture` | B: r3 | ③ over [s_{i−9}, X) on the whole series' holes | cut (reasons) and presence (ii) on run C; hand A.1.24 |
| `blindNoHour` | C: strataOf | the stratum without its hour | hand A.2.1 (Δ); H (step 4) |
| `noBlind` | C: deltaOf | B_s = 0 | hand A.2.1; D's tooth (step 4) |
| `inflStratumMean` | C: estDelta | the signal influence subtracts the stratum mean | hand A.2.4; (N4) (step 4) |
| `midHalfEven` | A: midOf | ties to even | hand A.1.7 |
| `pointsTrunc` | A: pointsOf | Math.trunc | hand A.1.8 |
| `smaNewestFirst` | B: smaOldest | pine.ts sma | hand A.3.2, A.3.31 (SMA20); the Python's last digit once an item uses SMA (step 4) |
| `noRisingEdge` | B: candidatesOf | condition and hold emit every true bar | hand A.4.1, A.4.33, A.4.34 (A.4.32 has no condition true on two bars in a row, so it cannot catch it: found in the trial, 2026-11-05) |
| `noHolm` | D: holm | each p ≤ 0.025 | hand A.2.22 |
| `iutOneLeg` | D: holm | p = p_Δ | hand A.2.22 |
| `c4PointOnly` | D: conditionsOf | C4 = Δ_late's point > 0 | hand A.2.23 (V2's C4); Q (step 4) |
| `noEx1Week` | D: failRuleOf, conditionsOf | rule 4 and C7 without the 1-week-excluded PL | hand A.2.20 (E10×F00), A.2.23 (V2's C7) |
| `noDF` | D: failRuleOf | rule 5 dropped | hand A.2.20 (E22×F02); EF (step 4) |
| `splitShift` | B: halfOf | SPLIT one week later | hand A.1.2 |
| `avoidFull` | D: lawsearch.ts | reads `research/ledger/spread-hours.csv` | the sha256 check (exit 3) on `CMP-N 1001` |
| `secondHalfAll` | D: stage 2 | asks for every trial's second half | stage 2's gate refuses (exit 2) on `CMP-N 1001` |
| `shiftNoWrap` | C: shiftRows | no wrap (signals past the last week dropped) | hand A.2.4 |
| `daySatSplit` | A: dayOf | a Saturday D(t) kept as Saturday | hand A.1.9 |
| `dropSecondStrata` (C3, 2026-11-05; the lead's D4) | D: select0 (`stage0`'s new `plant` argument) | for m15.E04.F00 only (a trial CMP-N 1001 does not choose), the second half's blind strata lose every stratum of USD/JPY, so its second-half noBlind is above 0 (C2's refute 4 made the same edit on C 7101: noBlind 810, and the run then exited 0) | stage 0's noBlind stop (7.4) on `CMP-N 1001`: exit 3, `stop.stage0` failed naming m15.E04.F00's second half, no stage-1 or stage-2 file |
| `blindRowHit` (C3, 2026-11-05; the lead's D10) | D: lawsearch.ts (on `suspectOf`'s row, stage 1) | at stage 1, the blind row `blind.m15.USD_JPY.buy` is reported as hit (`hit_a` and `hit` 1; its measures unchanged) | the spec 13 stop, end to end on `CMP-N 1001`: exit 3; `suspect.blind.stage1` failed; that suspect.csv row has hit 1; print.txt withholds stage 1's numbers and says STOP; stage 2 not opened (no `syn2` row in load.csv, no stage2.csv) |
| `chosenCutFirstDiff` (C3, 2026-11-05; the TS builder, asked by the lead: C2 never ran the stop before stage 2 on a full run) | D: cutCheck (check `cut.chosen.first` only) | the cut decision of the first target of the first chosen trial (table order) gets a planted mark, so one bar of that chosen trial differs; nothing else changes (the choice is made before this check) | the stop before stage 2 (7.7), end to end on `CMP-C 7101` (it chooses h1.E04.F00): exit 3; `cut.chosen.first` failed on that trial (stage `stage1end`); its bar is in cut_fail.csv; print.txt withholds stage 1's numbers and its `note.stage2` says "not opened"; no `syn2` row in load.csv, no stage2.csv |
| `lastBarStateG3`, `lastBarStateG5` (C4c, 2026-11-07; C4b's review, finding 1; the names are the designer's, confirmed by the lead in C4d) | B: candidatesOf (spec 5's walk, the loop the main run executes) | on the series' last bar, a raw signal is dropped when the last row emitted before it is exactly 3 (G3) or 5 (G5) bars back: a look-ahead that mixes state carried across bars with the series' end | stage 0's cut on `CMP-C 7101`: exit 3, the cut failed on trials (cut_fail.csv names the bars), stage 2 not opened. b3a2c43 (candidatesOf on the cut) fails it; C4b's one-bar candidatesAt did not (exit 0, every file as the clean run). C4c's runs: the cut failed on 8 of the 12 trials, with 461 (G3) and 423 (G5) cut_fail rows, the same files as b3a2c43's with the plant (7.8 syn step 3). (C4d, 2026-11-07) With B06 cut on its prefix, on 10 of the 12: m15.B06 and h1.B06 fail too (708 and 569 rows; 7.8 syn step 3) |
| `carriedCountB06` (C4d, 2026-11-07; C4c's review, finding 1; the shape of C4c refuter 1's R1; the name is the lead's example, taken by the C4d integrator) | B: candidatesOf (spec 5's walk), B06's trials only | per direction, B06's raw signals (②) are counted from bar 0; on the series' last bar, a raw B06 signal is dropped when that direction's count before it is odd: a look-ahead carried by state across bars, on B06's path | stage 0's cut on `CMP-C 7101`: exit 3, the cut failed on m15.B06 or h1.B06 (cut_fail.csv names the bars), stage 2 not opened (7.8 syn step 3). C4d's run: m15.B06 1,700 of 38,439 and h1.B06 970 of 25,630, no other trial. b3a2c43 and 876b9e4 (B06 cut on its 291-bar window) miss it: exit 0, every file as the clean run's but `config.json` and print.txt's `plant=` line. Not in `PLANTS` but run as mutants in C4d, on full C 7101 runs at `WORKERS=4`: the series-length shape (C4c refuter 1's R2: drop when n is even) failed the cut on m15.B06 1,738 and h1.B06 1,007; the emitted-rows shape (R3: drop when the rows emitted before it are odd) on m15.B06 1,700 and h1.B06 985. With the window, C4c's reviewer and refuter 1 saw R1, R2 and the reviewer's M5 and M6 pass (exit 0, every file as the clean run's) and R3 pass an h1 probe (0 of 1,972 targets) |
| `carriedCountS01` (C4e, 2026-11-08; the lead's G4: no run plant reached the S01 trials; the name is the lead's example, taken by the C4e integrator) | B: candidatesOf (spec 5's walk), S01's trials only | the same as `carriedCountB06` on S01's trials (kind S, `s` = S01): per direction, S01's raw signals (②) are counted from bar 0; on the series' last bar, a raw S01 signal is dropped when that direction's count before it is odd: a look-ahead carried by state across bars, on the S path | stage 0's cut on `CMP-C 7101`: exit 3, the cut failed on m15.S01 or h1.S01 (cut_fail.csv names the bars), stage 2 not opened (7.8 syn step 3). C4e's run: m15.S01 15,404 of 311,962 and h1.S01 12,110 of 86,600, and no other check failed. 7e4dfcc and b3a2c43 with the plant give the same counts and files: S01 never had a window, so every version catches it; what was missing was a run plant that reaches the S path (12's C4d paragraph) |
| `bufferReadE04` (C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's q1; the lead's G1; the name is the lead's example, taken by the C4e integrator) | B: candidatesOf (spec 5's walk), E04's trials only; `storeOf` (`lawsearch-events.ts`) | a raw E04 signal (②) is dropped when the next close is against it (buy: below this bar's close; sell: above), the next close being read through C's memory block (`storeOf(C)`: a `Float64Array` over `C.buffer` from `C.byteOffset` to the block's end), never as `C[i + 1]`: a look-ahead through the memory block, which a series that is a view of a longer array lets through | stage 0's cut on `CMP-C 7101`: exit 3, the cut failed on an E04.F00 or E04.F01 trial (cut_fail.csv names the bars), stage 2 not opened (7.8 syn step 3). C4e's run (every check series a copy): m15.E04.F00 277 of 34,556, m15.E04.F01 17 of 30,798, h1.E04.F00 295 of 24,274 and h1.E04.F01 27 of 23,489; poison and presence fail on them too. 7e4dfcc (the cut prefix a view): exit 3, but the **cut passed** (694,767 compared, none differs); only poison and presence, which make fresh arrays, caught it, and the yml's tests for this plant fail there. Not run on b3a2c43 (its prefix is a view too) |
| `seriesStashE04` (C4f, 2026-11-08; C4e's review: the power reviewer's `seriesStashE04`, the power refuter's `seriesWriteE04`; the lead's H4; the name is the reviewer's, taken by the C4f integrator) | B: candidatesOf (spec 5's walk), E04's trials only; `seriesStashOf` (`lawsearch-events.ts`) | `bufferReadE04`'s drop rule, with the next close's sign kept in the series' own `fileKey` array: at every bar q < n − 1 that holds no sign yet, −10 when C[q + 1] < C[q], −11 when above, −12 when equal; a raw buy is dropped where `fileKey[i]` is −10, a raw sell where it is −11. A look-ahead kept in the universe's own typed arrays, which every check series was copied from until C4f | `CMP-C 7101`: exit 6 (exit 7 since C4g, 2.3), stopped by the universe detector (H3; 7.3's C4f bullet) after stage 0's main part, before any check: a `CHANGED:` line naming the `fileKey` arrays, and no dump folder (7.8 syn step 3). With H2 and H3 taken out (H1 alone): exit 3, the cut fails on the four E04 trials (cut_fail.csv equal to `bufferReadE04`'s), and poison and presence fail on them too. fcce9e6: exit 0, every check passed: missed. Not run on b3a2c43 (C4e's reviewers report the same miss there; not measured) |
| `trialStashE04` (C4f, 2026-11-08; C4e's review: the power reviewer's `trialStashE04`, the power refuter's `trialahead`; the lead's H4; the reviewer's name) | B: candidatesOf (spec 5's walk), E04's trials only; `trialStashOf` (`lawsearch-events.ts`) | the same drop rule, with the next close read from a copy of the closes kept on the trial object: per pair, the longest close array the trial has been given, in an added property `__peek`. A look-ahead kept on the `TrialDef`, which until C4f the checks shared (at `WORKERS=0` the very object; in a worker a clone with every added property) | `CMP-C 7101`: exit 1 in stage 0's main part: the frozen `TrialDef` (H2; 5.2) throws `TypeError: Cannot add property __peek, object is not extensible`; no print.txt (7.8 syn step 3). H1 alone: exit 3, the cut fails on the four E04 trials (cut_fail.csv equal to `bufferReadE04`'s), and poison and presence too. fcce9e6: exit 0, every check passed: missed. Not run on b3a2c43 (C4e's reviewers report the same miss; not measured) |
| `avoidStashR3` (C4f, 2026-11-08; C4e's review: the power reviewer's `avoidStashR3`, the power refuter's `rs-wt`; the lead's H4; the reviewer's name) | B: reasonOf (③), every trial | ③ computed on `reasonUsesFuture`'s window (the holes after T), its answer kept in the `ExclCtx`'s avoid table as an entry `plant:r3:<pair>:<tf>:<T>:<0 or 1>` and read from there first. A look-ahead kept in the avoid table, which until C4f every check unit shared with the main run (a worker got a clone with the entries) | `CMP-C 7101`: exit 1 in stage 0's main part: the read-only avoid table (H2; 5.3) throws `Error: the avoid table is read-only: add refused`; no print.txt (7.8 syn step 3). H1 alone: exit 3, the cut fails on m15.S01, h1.E26.F00 and h1.S01 (`reasonUsesFuture`'s rows) and presence on all 12 trials. fcce9e6: exit 0, every check passed and stage 2 opened: missed. A write by `Set.prototype.add.call`, which passes H2, is caught by H1 on the full C4f code (7.8 syn step 3, `rp3by`). Not run on b3a2c43 (C4e's reviewers report the same miss; not measured) |
| `chosenCutSecondDiff` (C4f, 2026-11-08; the C4e docs writer's observation; the lead's H8, who gave the name as an example; taken by the C4f integrator) | D: cutCheck (check `cut.chosen.second` only) | as `chosenCutFirstDiff`, in `cut.chosen.second`: the cut decision of the first target of the first chosen trial (table order) gets a planted mark, so one bar of that chosen trial differs; nothing else changes | 7.7's D9 path end to end on `CMP-N 1001` (it opens stage 2 and chooses m15.E04.F01, m15.B06 and h1.B06): exit 3; `cut.chosen.second` failed on m15.E04.F01 (1 of 94,869, stage `stage2`), its bar in cut_fail.csv; print.txt has `withheld.stage2=1` and no verdict line; stage2.csv is written; stages 0 and 1 are not withheld and `K_total` is shown (7.8 syn step 3). The first run plant that fails `cut.chosen.second` |
| `rp2EnvE04` (C4g, 2026-11-10; C4f's review, the refuter's; the lead's G5) | B: candidatesOf (spec 5's walk), E04's trials only; `rp2EnvSigns` (`lawsearch-events.ts`) | `bufferReadE04`'s drop rule, with the next close's sign per bar slot kept in the process environment (`RP2E04_<pi>_<key>`): written by the first call (the main run's, on its whole series), read by every later call in any realm. The ENVIRONMENT channel | the job `plants-c4g` (7.8): exit 1, `NotCapable: Requires env access to "RP2E04_…"` at the main run's first `Deno.env.get` (the environment is revoked after the settings are read, 7.7), no print.txt (only config.json). b322c13: exit 0, every check passed, no trial chosen (the clean run chooses h1.E04.F00): **missed** |
| `avoidStashR3call` (C4g; C4f's review, the refuter's "rp4 call"; the lead's G5) | B: reasonOf (③), every trial | `avoidStashR3` with its entry written by `Set.prototype.add.call` and read by `Set.prototype.has.call`, past the read-only avoid table (H2). The avoid-table channel, by a write H2 does not stop: it tests H1's separation in CI | `plants-c4g`: exit 3. The cut fails on m15.S01 (24), h1.E26.F00 (1) and h1.S01 (16) (`reasonUsesFuture`'s rows), presence on all 12 trials (156–194 of 200), and stage 2 is not opened. b322c13: the same exit and rows (H1 was there already). It is in CI so that the job fails if H1's separate avoid table is ever lost. The presence counts equal C4f's for `rp3by`, so they come from the main run's wrong rows compared in the main thread, not from carry between units (12.7). (C4h, 2026-11-11; C4g's review, the lead's F3) **That last sentence was wrong for half of each count.** Equal counts on b322c13 could not rule carry out: C4f's pool workers were long-lived too. C4g's refuter measured it: of 1,107 presence hits, 1,100 were variant (ii) reading the answer variant (i) of the same job had written into the task's shared table (6 crossed trials, 1 was equal). The (i) half is the main run's wrong rows (true detection); every (ii) failure was carry. Since C4h each poison and presence unit has its own copy of the table, and C4h measured: the presence counts halve exactly (m15 186/190/192/182/174/178 → 93/95/96/91/87/89, h1 190/156/192/186/186/194 → 95/78/96/93/93/97), no (ii) row is left, the cut rows, poison rows and cut_fail.csv are unchanged, and the exit is still 3. Its files now equal `reasonUsesFuture`'s on the same data, but config.json and print.txt's run, plant and time lines: without the carry the checks see exactly ③'s look-ahead (12.9 F3). The yml's test (a failed cut or presence row, exit 3, stage 2 not opened) is unchanged, and since C4h it is enforced (7.8, F1) |
| `lenmemoEntryEarly` (C4g; C4f's review, the refuter's `lenmemo` with `entryEarly`; the lead's G5) | C: tradeOf, valuesAt (`lawsearch-trade.ts`) | `entryEarly`'s j − 1, with a module-level memo of `valuesAt` keyed by the pair, the series key, the entry and exit bars' closes and the direction, switched on by the plant's first trade in a realm and read back on series longer than 16 bars (6.1). MODULE STATE reaching a check that ran in the main thread | `plants-c4g`: exit 3; `follow-bars m15 first` and `h1 first` fail, with (i) changed on all 273,528 m15 and 60,660 h1 rows (the follow-bar check now runs in a worker of its own, where no trade has run). `suspect13.retrace.stage1` fails on 9 trials too, on b322c13 as here. b322c13: exit 3 by the retrace alone; follow-bars passed with 0 changed rows (the main run's memo answered the check): **missed** by its named check |
| `judgeListen2E04` (C4g; the C4g power judge's; the lead's G5) | B: candidatesOf, E04's trials only; a `message` listener added at the module's evaluation (`lawsearch-events.ts` `LISTEN_BANK`, `listenNext`) | `bufferReadE04`'s drop rule, with the next close taken from the series of the latest `universe` message the realm received (in a par worker: the universe its pool sent it), or from the series itself where none holds it (the main run). No built-in is changed. A listener keeping what a worker is SENT | `plants-c4g`: exit 3; the cut fails on all four E04 trials (m15.E04.F00 277, F01 17, h1.E04.F00 295, F01 27 rows), stage 2 not opened. Poison and presence pass on all four: by the spec their workers get the whole universe (12.7, residual 1). b322c13 (every worker sent the whole uncut universe): exit 0, every check passed: **missed** |
| `judgeCacheCarryE04` (C4g; the C4g power judge's; the C4g integrator rewrote its helper for speed, 5.3; the lead's G5) | B: candidatesOf, E04's trials only; `jccSigns` | `bufferReadE04`'s drop rule, with the next close's sign per (pair, timeframe, bar start) memoised forward from every E04 series a realm sees, in a module `Map` and in CacheStorage (read back at the module's evaluation; in Deno 2.9.6 shared by the workers of one entry module, within a process and across processes, on disk). STATE CARRIED between units, check runs and processes | `plants-c4g`, run twice: exit 3 both times; the cut fails on the four E04 trials (277/17/295/27) and run 2's cut_fail.csv is run 1's, byte for byte (the lockdown deletes CacheStorage; cut workers are fresh per cut run). Presence also fails on h1.E04.F00, 2 of 200, in all four runs; the count stays, but the bar it names varies (the memo carried between presence units of the kept probe pool: 12.7, residual 2). b322c13: run 1 exit 3 (the cut; presence passed, its workers reading the main run's memo from CacheStorage); run 2 exit 0, no cut row (its cut workers read run 1's memo): **missed** |
| `w0protoG3` (C4g; C4f's review, the refuter's `w0proto`; the lead's G5) | B: candidatesOf (spec 5's walk), the trials `lastBarStateG3` reaches | `lastBarStateG3`, turned off on every series shorter than the first one the realm saw for the (trial, pair), the table kept on `Array.prototype` (a non-enumerable expando). REALM GLOBALS at `WORKERS=0` | `plants-c4g` at `WORKERS=0`: exit 3; the cut fails on 10 trials with `lastBarStateG3`'s counts (m15.E04.F00 225 … h1.B06 85; 708 stage-0 rows in cut_fail.csv), stage 2 not opened (every unit runs in a worker, where a check's own series come first). b322c13 at `WORKERS=0` (the units in the main thread, after the main run's whole series): exit 0, every check passed, h1.E04.F00 chosen, stage 2 opened: **missed** |
| `gmoWriteR` (C4g; C4f's review, the refuter's; here without the environment; the lead's G5) | B: trialSignals; the run's gmo folder (`GMO_WRITE.dir`, set by `lawsearch.ts`) | the main run's first `trialSignals` call of the process (stage 0) rewrites one bid close of the run's own gmo files (USD/JPY m15 2024-03-11T04:00Z, 113.217 → 113.218; C 7101's data only), and its first call on a stage-2 universe writes the original bytes back. The FILE channel | `plants-c4g` (with `DENO_RUN`'s write grant, so the write happens): exit 0; the write line; at stages 1 and 2 the probe lines `disk 113.218, the checks' snapshot 113.217, the main run's universe 113.217`; the gmo file the same bytes after the run; all 83 dump files equal the clean run's but the mode, plant and time lines. So the write reaches nothing, because nothing reads the disk after gate 3 (7.7). It is shown harmless by construction, not caught by a check: a check that compares the disk with the gate-3 bytes would only tell what the run already ignores. b322c13: exit 0; stages 1 and 2 reloaded the disk, and the probe lines read 113.218 for the disk, the snapshot and the universe alike; 7 dump files differ from the clean run's (blind/m15_first.csv, late/m15_first.csv, measures.csv, shift.csv, stage1.csv, strata.csv, trades/m15.S01_first.csv): **missed** |

The names of the three C3 run plants, `dropSecondStrata`, `blindRowHit` and `chosenCutFirstDiff`, were confirmed by
the lead 2026-11-05 (C4a). (C4d, 2026-11-07) The lead confirmed `lastBarStateG3` and `lastBarStateG5` in C4d's
task. `carriedCountB06` is the name the lead's task gave as an example; it is for the lead to confirm (11 O-14).
(C4e, 2026-11-08) `carriedCountS01` and `bufferReadE04` are the names the lead's C4e task gave as examples, taken by
the C4e integrator; they and `carriedCountB06` are for the lead to confirm (11 O-15).
(C4f, 2026-11-08) `seriesStashE04`, `trialStashE04` and `avoidStashR3` are C4e's power reviewer's names, which the
lead's C4f task gave, and `chosenCutSecondDiff` is the name the lead's task gave as an example. The C4f integrator
took all four; they are for the lead to confirm (11 O-16).
(C4g, 2026-11-10) The seven C4g plants are run in the job `plants-c4g` (7.8), not in a syn job's matrix, and want
their exits there. Their names:
- `rp2EnvE04`, `lenmemoEntryEarly` (from `lenmemo` and `entryEarly`), `w0protoG3` (from `w0proto` and
  `lastBarStateG3`), `avoidStashR3call` and `gmoWriteR` come from C4f's reviewers and refuters, as the lead's C4g task
  listed them;
- `judgeListen2E04` and `judgeCacheCarryE04` are the C4g power judge's.

The C4g integrator took all seven; they are for the lead to confirm (11 O-17).
None of these run plants is in the list of Python twins below: the Python compares nothing on a plant run
(`lawsearch-dump.md` 2).

The Python twins (`--plant`, `lawsearch-py-design.md` 6) are: midHalfEven, midDecimalStr (Python only:
`Decimal(str(v))`), pointsTrunc, daySatSplit, splitShift, entryAtSignalClose, entryEarly, exitLate,
noSubstituteExit, blindNoHour, noBlind, inflStratumMean, shiftNoWrap, noHolm, iutOneLeg, c4PointOnly, noEx1Week,
noDF (PY1), and smaNewestFirst, noRisingEdge, htfOpen (PY2). Each must fail the same named examples in the Python's
hand run.

Set O (14.2: E26's direction from the next bar, `answerKnowingE26`) is not a 16 plant, but it belongs to the same
idea. On seeds 6001–6004, the cut and the poison must fail on every E26 trial, the E26 rows' suspicion lines must
hit, and the other checks must pass.

(C4e, 2026-11-08; the lead's G4) **Which trial kinds a run plant reaches.** 12's C4d paragraph says a plant must
reach each path under test. The full step-4 set (the ledger `research/ledger/lawsearch-candidates.json`; the C4e
integrator's count, `c4e/logs/g4-inventory.txt` in the C4e scratch folder, counted again from the ledger by the C4e
docs writer) has 682 trials per timeframe, 1,364 in all:

- EF: 660, that is 44 E items (E01–E44) × 15 F's (F00, F01, F01r, F02, F02r, F03, F03r, F04, F04r, F05, F05r, F06,
  F06b, F07, F07r);
- S: 4 (S01 on F01, S02 on F02, S03 on F05, S04 on F07);
- B: 18 (B01–B18);
- among them the higher-timeframe path (`readsHigher` in `lawsearch-checks.ts`: F02, F02r and S02): 89 per
  timeframe (44 × 2 + 1), 178 in all.

The small trial builds 6 trials per timeframe: E04.F00, E04.F01, E26.F00, E26.F01, S01 and B06. The run plants (on
CMP-C 7101) and set O reach them as follows: the trials whose rows fail in each plant's checks.csv (C4e's runs; the
C4d plants' files are byte-identical to C4d's kept files).

| kind | trials (m15 and h1) | what fails on them |
|---|---|---|
| E, cross (E04), with F00 and F01 | E04.F00, E04.F01 | `lastBarStateG3`, `lastBarStateG5` (cut); `bufferReadE04` (cut, poison, presence; new in C4e); `chosenCutFirstDiff` (h1.E04.F00, `cut.chosen.first`); `reasonUsesFuture` (presence); (C4f) `seriesStashE04` and `trialStashE04` (stopped in stage 0's main part on the C4f code; with H1 alone, the cut, poison and presence); `chosenCutSecondDiff` (m15.E04.F01, `cut.chosen.second`, on CMP-N 1001); (C4g, the job `plants-c4g`) `judgeListen2E04` and `judgeCacheCarryE04` (the cut, on all four E04 trials), `w0protoG3` at `WORKERS=0` (the cut), `rp2EnvE04` (stopped: exit 1, `NotCapable`), `avoidStashR3call` (presence) |
| E, hold (E26), with F00 and F01 | E26.F00, E26.F01 | `lastBarStateG3`, `lastBarStateG5` (cut); `reasonUsesFuture` (h1.E26.F00's cut; presence); set O (cut, poison, the stage-1 `suspect13` checks); (C4f) `avoidStashR3` (stopped on the C4f code; with H1 alone, h1.E26.F00's cut and presence); (C4g) `w0protoG3` at `WORKERS=0` (the cut), `avoidStashR3call` (h1.E26.F00's cut; presence) |
| S, state (S01: F01's f) | S01 | `carriedCountS01` (cut; new in C4e, inside `candidatesOf`'s loop); `reasonUsesFuture` (cut and presence, through the reason path, not the loop); (C4f) `avoidStashR3` (with H1 alone, the cut and presence, through the reason path); (C4g) `avoidStashR3call` (the cut and presence, through the reason path) |
| B, condition (B06) | B06 | `carriedCountB06` (cut); `lastBarStateG3`, `lastBarStateG5` (cut); `reasonUsesFuture` (presence); (C4f) `avoidStashR3` (with H1 alone, presence); (C4g) `w0protoG3` at `WORKERS=0` (the cut), `avoidStashR3call` (presence) |

(C4g, 2026-11-10) Two C4g plants reach no trial kind: `lenmemoEntryEarly` acts on the trades, through the trade code (`tradeOf`, `valuesAt`), which every trial's measures use and the follow-bar checks recompute. `gmoWriteR` acts on the data, before any trial reads them.

The F kinds reached are F00 (no filter) and F01 (EMA200) only.

(C4f, 2026-11-08; the lead's H4 and H8) **Which channel a run plant reaches.** A look-ahead can hide from the checks
by the way it reads the future, and, until C4f, by where it keeps the answer. The C4f column gives what stops or
catches each plant on the C4f code (8's table and 7.8 syn step 3).

| channel | run plant (test mutants) | on the C4f code |
|---|---|---|
| the per-bar walk: state carried across bars, rows already emitted, the series' last bar | `lastBarStateG3`, `lastBarStateG5`, `carriedCountB06`, `carriedCountS01` | the cut (exit 3) |
| a series' memory block | `bufferReadE04` | the cut (every check series a copy, 4.1), poison and presence (exit 3) |
| the reason path, the holes after T | `reasonUsesFuture` | the cut and presence (exit 3) |
| the universe's typed arrays (a write into the main run's universe) | `seriesStashE04` (`rp1wr`; `rp4w`'s m15 part) | H3 stops it (exit 6); with H1 alone, the cut, poison and presence |
| the trial object (an added property) | `trialStashE04` (`rp4w`'s h1 part) | H2's frozen `TrialDef` stops it (exit 1); with H1 alone, the cut, poison and presence |
| the avoid table (the reason path) | `avoidStashR3` (`rp3rs`; `rp3by` through `Set.prototype.add.call`) | H2's read-only Set stops it (exit 1); `rp3by` passes H2 and is caught by H1: the cut and presence (exit 3) |
| the `ExclCtx` and its holes | none | H2 freezes the objects (a write throws), but the holes' typed arrays stay writable; by construction no check reads the main run's `ExclCtx` (every check makes its own holes). No run plant on this channel |
| module-level state (shared by the main run and the checks at `WORKERS=0`) | none in `PLANTS`; the test mutant `w0hide` (C4e's mutR, M and M2 are of this kind; they were not run on the C4f code) | not separated by H1 (12.2 (2)). At `WORKERS=4` the cut catches `w0hide` (exit 3); at `WORKERS=0` it is hidden (exit 0), and only the `WORKERS=0` step's plant run sees it (7.8 syn step 3) |
| stage 2's handling of a failed `cut.chosen.second` (7.7's D9) | `chosenCutSecondDiff` | stage 2's numbers withheld (exit 3) |
| stage 2's `suspect13` checks | none | no synthetic run reaches them (O runs never open stage 2; N, C and FLIP have no suspicion hit) |

(C4g, 2026-11-10; the lead's T and G5) **The channels of state not held in an object handed to the code.** H1
separates objects. C4f's review and the C4g judges showed five more ways the main run and the checks could share a
value. Each now has a run plant in the job `plants-c4g` (7.8). Each plant was missed on b322c13 and is caught or
stopped on the C4g code (8's table; 12.7). The rows above keep their C4f column. On the C4g code the rows of C4f's
plants are unchanged, but for `seriesStashE04`'s exit (7). The module-level state row is replaced by the rows below.

| channel | run plant | on b322c13 | on the C4g code |
|---|---|---|---|
| files: the run's gmo folder, written by main-run code and read again later | `gmoWriteR` | missed: stages 1 and 2 reloaded the written value; 7 dump files changed | nothing reads the disk after gate 3 (7.7): the probe lines show the disk changed and the snapshot and universe not; every dump the clean run's; exit 0 |
| the environment (`Deno.env`, shared by every realm of the process) | `rp2EnvE04` | missed: exit 0, every check passed | the environment is revoked before any main-run code: exit 1, `NotCapable` |
| module state reaching a check that ran in the main thread at every `WORKERS` | `lenmemoEntryEarly` | follow-bars passed (0 changed rows); exit 3 by the retrace only | follow-bars runs in a fresh worker with no permission: (i) changes on every row, exit 3 |
| realm globals (a built-in prototype expando) shared at `WORKERS=0` | `w0protoG3` at `WORKERS=0` | missed: exit 0, stage 2 opened | no unit runs in the main thread at any `WORKERS`: the cut fails, exit 3 |
| process-global Web APIs (CacheStorage, across processes too) and state carried from one check run to another | `judgeCacheCarryE04`, run twice | run 2 missed (exit 0): its cut read run 1's memo | the lockdown deletes CacheStorage; cut workers are fresh per cut run: the cut fails both times with the same bytes, exit 3 |
| what a worker is SENT, kept by a listener in its realm | `judgeListen2E04` | missed: exit 0 (every worker was sent the whole universe) | a cut worker is sent no bar after its target (deltas): the cut fails, exit 3; poison and presence still pass (by the spec their workers get the whole universe: residual) |
| the avoid table written past H2 (`Set.prototype.add.call`), to test H1 itself in CI | `avoidStashR3call` | caught: exit 3 (H1) | caught the same way, exit 3 |

**Must get a run plant before step 4, when such a trial exists.** No synthetic trial of the small trial uses these
kinds, so no run plant reaches them. No fake trial was made for them.

- The higher-timeframe path F02, F02r and S02. `readsHigher` is false for every trial of the small trial, so the
  higher bars rebuilt inside a check (`coarsenSeries`, `htfIndex` in `indFor`) are never exercised by a run. The hand
  plant `htfOpen` reaches `htfIndex` in hand examples only (the table above: "cut once F02 is built (step 4)").
- The other 42 E items.
- The F's F01r, F02–F07, F02r–F07r and F06b.
- S02, S03 and S04.
- B01–B05 and B07–B18, among them the 10 other finite items of 12.4.

(An observation of the C4e docs writer, outside G4: no run plant makes `cut.chosen.second` or stage 2's
`suspect13` checks fail. `cut.chosen.second` decides through the same `cutGotAt` as stage 0's cut, which the plants
above reach; what no run exercises is the handling of its failure in stage 2, 7.7's D9: stage 2's numbers withheld.
For the lead: 11 O-15.) (C4f, 2026-11-08; the lead's H8) The run plant `chosenCutSecondDiff` on CMP-N 1001 now runs
that path end to end (the table above; 7.8 syn step 3). Stage 2's `suspect13` checks still have no run plant.

---

## 9. The hand examples the trial must pass

- "all" means every expect key except those matching `ALT_KEY`. A list names the keys required now. Every other
  example and key reports "skip" (not built), and is unlocked by its item later without changing the runner.
- Groups 1 and 2 are run by PY1, groups 3 and 4 by PY2 (and all four by `lawsearch-hand.ts`).

| examples | required |
|---|---|
| A.1.1 … A.1.36 (all 36: dates, bars, exclusions, trades) | all |
| A.2.1 … A.2.32 (all 32: measures, SE, choices, selection, Holm, verdicts, late, (N4) median) | all |
| A.3.1 crossing | all |
| A.3.2 SMA·BB | `first_index_shown`, `SMA20` |
| A.3.5 EMA·RMA | all |
| A.3.6 ATR | `TR`, `ATR14` |
| A.3.7 RSI edges | `up`, `dn`, `U`, `D`, `RSI7` |
| A.3.8 RSI | `RSI7`, `RSI14`, `RSI21`, `signals.E04` |
| A.3.9 RSI = 50 | `up`, `dn`, `U14`, `D14`, `RSI14`, `RSI7`, `U14_eq_D14` |
| A.3.14 EMA | `EMA12`, `EMA26`, `EMA5`, `EMA35` |
| A.3.15, A.3.16, A.3.17 EMA (flat) | `first_index_shown` (where present), `EMA12`, `EMA26` |
| A.3.18 EMA | `EMA5`, `EMA20`, `EMA50` |
| A.3.19 warm-up table | the `E` row naming E04 (RSI14) and the `F` rows of F00 and F01 |
| A.3.20 F01 / F01r (EMA5) | `EMA5`, `C_minus_EMA`, `F01_buy`, `F01_sell`, `warmup_k`, `F_value_used_signal_excluded_by_warmup_1_at` |
| A.3.24 ATR, SMA (shrunk SMA5) | `TR`, `ATR14`, `SMA5_ATR14` |
| A.3.25 RSI14 | `RSI14` |
| A.3.29 ⑤ both directions | all |
| A.3.30 EMA200 and the F inputs | `first_index_shown`, `EMA50`, `EMA200`, `C_minus_EMA200`, `ATR14`, `SMA100_ATR14`, `first_value_index.EMA50`, `.EMA200`, `.SMA100_ATR14` |
| A.3.31 SMA order | `first_index_shown`, `SMA20` |
| A.3.34 ATR (double) | `TR`, `ATR14` |
| A.4.1 E26 | all |
| A.4.2 donchian 55 | `HH`, `LL`, `target_s` |
| A.4.3 ATR10, EMA20 | `TR`, `ATR10`, `EMA20` |
| A.4.9 ATR | `TR`, `ATR14` |
| A.4.10 ATR | `TR15`, `ATR14_14` |
| A.4.26, A.4.27, A.4.41 S01 | all |
| A.4.29, A.4.30 RSI14 | `U`, `D`, `RSI14` |
| A.4.32, A.4.33, A.4.34, A.4.36, A.4.40 B06 | all |

- That is 36 + 32 + 20 + 15 = 103 examples with required keys. The 41 others report "skip" (E05–E25 and E27–E44's
  own examples, F02–F07r, S02–S04), and so do the keys of other items inside the 103.
- The indicator-only keys of G3 and G4 (EMA, RMA, ATR, TR, RSI, SMA, donchian 55) are required now even where the
  example's item is not built, because `lawsearch-ind.ts` already computes them. They check the wiring of the app
  functions (spec 17.1) before the items that use them are written.

- Where an example's keys mix items, the adapter checks the built item's keys and reports the others as "skip (not
  built: E07)".
- The adapters for 9's examples are D's (TS) and PY1's / PY2's (Python). A–C make sure their functions accept the
  shapes these examples give: `seriesFromMid`, `blindFromRows`, the pure exclusion functions, and the select functions
  on plain records.

---

## 10. The synthetic runs of the trial

- Period: S0–END for every run (spec 14.1).
- Folder: `research/out/lawsearch/<name>/`, with `gmo/`, `ts/`, `py/` and `cmp/`.
- Every run prints its times per stage. Spec 18's estimates are unmeasured, and the trial measures them.

| run | set, seeds | what it must show |
|---|---|---|
| CMP-N 1001, CMP-N 1002 | N, 1001 and 1002, no flip | Every file of `lawsearch-dump.md` agrees between TS and Python under spec 17.2. Every check of 15 passes: data, adds up, cut, poison, presence, h1Only, stage 1's first half = stage 0's, follow-bar checks, donchian = donchianState. noBlind = 0; Δ_late's `end` exclusions = 0. Stages 0, 1 and 2 run to the end: floor, same trial, groups, choice and verdicts are printed. They are not judged against N's criteria, which need 100 runs and 1,364 trials (step 4). |
| CMP-C 7101 | C (N with holes; 4.2), 7101 | The same agreement, now with ③ holes, substitute exits, an empty day file and r ruled unusable by gaps. Blind bars are excluded by ③ after each removed m15 run of ≥ 2 slots and each removed h1 bar, and some blind rows have `subst = 1` (every bar is a blind bar, so these follow from the removed bars; a trial's own signals may or may not fall there). Plant `reasonUsesFuture` fails the cut or the presence (ii) here. |
| FLIP 1001–1005 | N, 1001–1005, flipped and not | For every blind bar of both halves and timeframes, the flipped run's buy h = the original's sell h and PL is the same (points; exact). E04, E26 and S01: the signals match 1-to-1 with reversed directions, with differences ≤ 0.1% per trial. B06 is not symmetric (log returns of mirrored prices), so its name and reason are printed with its difference. See 11 O-2 before reading a failure of the h equality. From 2026-11-05 (spec 22.6, 23.1) these conditions are judged on the exact mirror: the original run's 5-minute mid, Bid and Ask mirrored about the pair's first 5-minute mid open S (mid' = 2S − mid, Bid' = 2S − Ask, Ask' = 2S − Bid, high' from low), with no rounding of spec 2, and everything above it rebuilt from that. The FLIP=1 run (flipped files read under spec 2) still runs, and is compared TS–Python only. |
| O 6001–6004 | O, 6001–6004 | `m15.E26.*` and `h1.E26.*`: the cut and the poison fail (exit 3), and suspicion hits on their stage-1 rows. The other checks of the other trials pass. (C3, 2026-11-05) The run ends before stage 2 (7.7's stop before stage 2). |
| PLANT-* | walkfiles on CMP-N 1001's and CMP-C 7101's files (OUT `<RUN>/plant-<name>`), and the hand examples | Each plant of 8 is caught by its named check (C3: `dropSecondStrata` and `blindRowHit` on CMP-N 1001, `chosenCutFirstDiff` on CMP-C 7101; C4c: `lastBarStateG3` and `lastBarStateG5` on CMP-C 7101, by stage 0's `cut`; C4d, 2026-11-07: `carriedCountB06` on CMP-C 7101, by stage 0's `cut` on m15.B06 or h1.B06, and `lastBarStateG3` again at `WORKERS=0`, the same bytes as at `WORKERS=4`; C4e, 2026-11-08: `carriedCountS01` and `bufferReadE04` on CMP-C 7101, by stage 0's `cut` on an S01 or an E04 trial; the `WORKERS=0` comparison no longer runs a plant but the clean runs CMP-N 1001, CMP-C 7101 and O 6003, 7.8 syn step 3; C4f, 2026-11-08: `seriesStashE04` (exit 6, the universe detector), `trialStashE04` and `avoidStashR3` (exit 1, the frozen trial definition and the read-only avoid table) on CMP-C 7101, each caught by the cut when those guards are taken out; `chosenCutSecondDiff` on CMP-N 1001, by `cut.chosen.second` with stage 2's numbers withheld; and CMP-C 7101's `lastBarStateG3` again at `WORKERS=0` in the comparison step, the same bytes as at `WORKERS=4`; C4g, 2026-11-10: `seriesStashE04` now exit 7; and the job `plants-c4g` on its own C 7101 data: `rp2EnvE04` (exit 1, `NotCapable`), `avoidStashR3call`, `lenmemoEntryEarly` (follow-bars), `judgeListen2E04`, `judgeCacheCarryE04` twice and `w0protoG3` at `WORKERS=0` (exit 3, the cut or the named check), and `gmoWriteR` (exit 0, the disk written and nothing the run reads changed), 7.8). |
| SMOKE 7001–7004 | D, H, E15, EF, with `STRENGTH` provisional | Only that each effect moves its target the intended way, in the dumps: D the blind buy a > 0; H EUR/USD's blind buy a by New York hour (negative in 03–09, positive in 11–15); E15 m15.E04.F00's first-half Δ > 0; EF h1.S01's first-half Δ > 0. These are not formal runs, not the calibration of 14.3, and not written as strengths. No TS–Python comparison is required on them. |

- Not run in the trial: the formal effect sets (D, H, E15, E1h, EF, Q) need their strengths from seeds 901–920
  (step 4). R needs the R trials (step 4). (N1)–(N5) need 100 runs × 1,364 trials. κ needs 1101–1500 (step 7).
- Pass of the trial: CMP-N 1001, CMP-N 1002 and CMP-C 7101 agree and pass. FLIP and O show their conditions. Every
  plant is caught. 9's hand examples pass in TS and Python. The times are recorded.

---

## 11. Open points for the lead (not decided in this design)

- **O-1 the cut's cost**: spec 15's targets include "the 2 bars before each higher-timeframe boundary". That is half
  of all bars on both timeframes.
  - Literal targets, deduplicated per (tf, pi, k), at about 45,000 per pair on m15, are estimated (not measured) at
    tens of minutes per run in TS.
  - 7.3 keeps the literal set and only allows B06's 291-bar window (§8.113's finite length). [Superseded by the
    2026-11-05 decision below: 7.3 now picks 300 boundary targets per tf and pair in stage 0, and every boundary
    target only for the chosen trials (C3, the lead's D7).] [C4d, 2026-11-07: B06's window is gone too; every item
    is cut on its prefix from bar 0 (7.3, the lead's F1).]
  - If the measured time does not fit a job, the choice of a cap (as §8.113's chartbest capped its boundary kinds
    with seed 320) belongs to the owner, before step 4.
  - Decided 2026-11-05 (spec 22.7, 23.2), after the trial measured 9,217 s a run (m15's cut 8,006 s, 85% of its
    targets from the higher-timeframe boundaries): in stage 0 the higher-timeframe boundary targets are 300 evenly
    picked per timeframe and pair (j-th = floor(j(n−1)/299) of them in time order; all when n ≤ 300). Stage 1's chosen
    trials are cut on every boundary target of the first half at the end of stage 1, before the second half opens (a
    failure stops before stage 2), and stage 2 cuts them on every boundary target of the second half.
- **O-2 the flip's exact h**: spec 14.1's spread makes half-tick mids (an odd number of ticks). Mirroring changes the
  binary value that `toFixed` rounds, so a mirrored mid can round the other way by 1 point. Where |m| ≤ 1 point, the
  flipped buy h can then differ from the original sell h, even with a correct program. The trial counts those bars.
  If any exist, the owner decides how 14.2's "ぴったり同じ" is read (for example only on bars whose four mids are not
  half-ticks). The generator is not changed to avoid it.
  - Decided 2026-11-05 (spec 22.6, 23.1): judged on the exact mirror of the original run (see 10's FLIP row). The
    trial measured E04 and E26 signal differences of 0.84–3.94% on FLIP 1001's files, and 0 on the exact mirror.
- **O-3 E1h, Q, R**: their trials (E37, E22, the R trials) are not built. Their sets run in step 4.
- **O-4 κ and g**: stage 2 runs with κ = 1 and stage 0 without g. Both are written as "not run yet" in `config.json`
  and `print.txt`.
- **O-5 13 (v) on synthetic runs**: another agent's hand trace cannot run inside a job, so a suspicious row is not
  selectable in syn runs. A real stage 1 will need a pause and a recorded result. That design is for step 6.
- **O-6 "1週あたりの数"** (spec 9): read as counted ÷ the half's weeks (72, 76).
- **O-7 C2 / C3's 30**: read as counted signals (spec 6's 数えた合図), and their Δ as the trade rows.
- **O-8 presence (ii)**: read as deleting from all five pairs of the trial's timeframe (the stronger reading; spec 15
  does not say which pairs).
- **O-9 texts**: stage 2's sentences (spec 11 "どの文にも必ず付けるもの") are not in the trial. Only the hand
  examples' labels are. The texts need a fixed template that both implementations share. It is written before step
  7.
- **O-10 readings settled by the lead 2026-11-05** (C3, the lead's D11; no behaviour changes; the builders' C2
  questions):
  - Spec 23.1's "2 で作った5分足" and S: 7.9's last bullet.
  - Spec 23.2's halves for the chosen-trial cut: 7.3's Cut bullet.
  - Spec 23.5's stop rows: a row with a stop value counts as 数にできない行. The other counts made at such a stop
    (捨てた数, 同じ始まりの行の数, the Ask < Bid share by year) may still include that row, because loadTf parses it;
    a stop withholds the load dumps, so the difference cannot be seen in any compared file. Left as is.
  - `choice.json` written before `cut.chosen.first`: 7.7 (stays; C2 refuted the finding).
  - κ's run counts (spec 21.5, 23.5: "t の無い run" and "値の無い run"): settled when stage 3 is built. `kappaOf`'s
    counts stay as A.2.21 needs them.
- **O-11 decided or confirmed by the lead 2026-11-05** (C4a, from C3's review and the C3 builders' and docs writer's
  questions; the TS's part):
  - Confirmed readings, kept as written: D3's "reached stage 2" and missing `load.csv` (7.9); D4's stop place and
    message (7.4); D8 stricter than spec 10 rule 2 and 15 on purpose (7.7); the plant names `dropSecondStrata`,
    `blindRowHit` and `chosenCutFirstDiff` (8). D9 unchanged.
  - E4: the per-timeframe sums of `stage0_totals.csv` stay; a run with one trial in a timeframe is for development
    only (7.5, `lawsearch-dump.md` 7).
  - E5: `signals/`, `ind/`, `bars/`, `htf/` and `cut_fail.csv` are sealed comparison dumps until stage 2
    (`lawsearch-dump.md` 12). No code change.
  - E7: `cut_fail.csv` gets the column `T` after `s` (7.3, 7.5).
  - E8, E9: `CUT_MAX` reaches `suspect13.cut.*` too and every text names it (7.3, 7.7); `checks.csv` gets no cap
    marker; `secondHalfAll`'s refusal (exit 2, no `checks.csv` or print.txt) stays as is.
  - E1, E2, E6 are the Python comparator's (`lawsearch-dump.md` 9.3, 11.12, 11.14 (a)); the TS's files do not
    change for them.
- **O-12 decided by the lead 2026-11-05** (C4b; the TS's part):
  - E13: hand step 7 of the yml refuses invalid `CUT_MAX` values (7.8; 7.7), and `lawsearch-flip.ts` checks the
    flipped run's tree too (7.9).
  - The speed-up (the owner's answer 「まず速くする（おすすめ）」 to "step 4 does not fit a 6-hour job"): 12's rules.
  - E10, E11 and E14 are the Python comparator's (`lawsearch-dump.md` 9.3, 11.12, 2), and E12 rewords the sealed-dump
    rule (`lawsearch-dump.md` 12); the TS's files do not change for them.
- **O-13 for the lead** (C4c, 2026-11-07; C4b's review, findings 1–3): C4c restores b3a2c43's cut path
  (`candidatesOf` on the check's own series; 12 rule 2), fixes the yml's Python hand-plant step (7.8 hand step 5) and
  writes C4b's code into this file (3, 5, 7.3, 7.7, 7.8, 12.1). Open: the two points of 12.2 (the reason at bar k
  from `reasonOf` alone; caches that must stay keyed by the Ind), the plant names `lastBarStateG3` and
  `lastBarStateG5` (8), and the cost (12.3: one step-4 run estimated at 3.5 h at `WORKERS=4` at the stand-in target
  count, 8.8 h if every bar were a target). No spec question.
  - (C4d, 2026-11-07) Decided by the lead in C4d's task: (1) and (2) of 12.2 stay documented residuals, the poison
    tables stay a documented gap (12.2 (4)), and the two plant names are confirmed (8).
- **O-14 for the lead** (C4d, 2026-11-07; C4c's review, findings 1–4, all four reproduced by separate refuters):
  - Done as the lead decided: F1, B06 is cut on its prefix from bar 0 like every item (7.3), with the run plant
    `carriedCountB06` (8; 7.8 syn step 3) and the exact rewrite of `bigmoveOf` (5.1, 12.1 item 10). F2, the claims
    of power by construction and of bytes independent of `WORKERS` now carry their condition (5.3, 7.3, 7.7, 12
    rules 2 and 3, 12.1 items 1, 3 and 9, 12.2 (2)), and the yml compares `WORKERS=0` with 4 on one run as defense
    in depth (7.8 syn step 3). F3, the yml's Python hand-plant step checks the step's own ids (7.8 hand step 5). F4,
    7.3's Cut bullet and 12 rule 2's first sub-bullet describe the code.
  - To confirm:
    - the plant name `carriedCountB06` (the lead's task gave it as an example; 8);
    - the reading that spec 15's 毒 is met by poisoning only the trial's pair in the trial's timeframe, as the code
      has done since b3a2c43 (7.3's Poison bullet, which until C4d said "every series of the five pairs");
    - the cost: one step-4 run at `WORKERS=4` is estimated at 3.64 h at the stand-in target count (9.39 h at every
      bar), and at 5.44 h (15.34 h) if all 11 finite B items cost what B06 costs (12.4);
    - this round's text: 4.1, 5.1, 5.3, 7.3, 7.7, 7.8, 8, 10, 11 (O-1, O-13, O-14) and 12 (rules 2 and 3, the
      paragraphs after the method, 12.1–12.4).
  - Code comments outside this file that still describe the old wording (for the integrator; no output depends on
    them): the `lawsearch-checks.ts` header's poison reading ("the trial's timeframe's five pairs"), and the comment
    above `windowSeries` in `lawsearch-bars.ts` ("for an item of finite length recomputed on a window"; the cut no
    longer calls it). `cutTfSet` is exported and called by no module (4.1).
  - `lawsearch-dump.md` needs no change: no output file and no compared field changes its meaning. A plant run is
    compared with nothing by the Python (`lawsearch-dump.md` 2), and the new CI step compares the TS's files with
    each other only.
  - No spec question.
  - (C4e, 2026-11-08) Decided by the lead in C4e's task: the poison reading is accepted only if it is exact (G5);
    the C4e integrator and docs writer showed from the code that it is (7.3's Poison bullet), with no code change.
    The stale comments were fixed and `cutTfSet` was removed (G6; 4.1). The plant name `carriedCountB06` and the cost
    move to O-15.
- **O-15 for the lead** (C4e, 2026-11-08; C4d's review: the power reviewer's P5 and the ci-docs reviewer's two
  points, each reproduced by a separate refuter, none refuted; and points the C4d reviewers and docs writer left
  open):
  - Done as the lead decided:
    - G1: every series a check hands to `decisionOf` is a copy that holds its own bars only (4.1 `copyOf`; 5.3; 7.3,
      the Cut bullet and the units' series). The run plant `bufferReadE04` (8; 7.8 syn step 3): the cut passes it on
      7e4dfcc (only poison and presence fail) and fails it on C4e's code. The hand job's grep step for reads through a
      memory block, with its allow-list, as defense in depth only (7.8 hand step 9).
    - G2: the `WORKERS=0` against 4 step compares the clean runs CMP-N 1001 (a job of its own, `w0-n-1001`), CMP-C
      7101 and O 6003, which reach every kind of pool run the synthetic runs reach but stage 2's `suspect13` checks
      (7.8 syn step 3 lists what is and is not compared). It fails on C4d's ci-docs refuter 2's mutant, on the memo
      mutant M on 7e4dfcc and on M2 on C4e's code, and passes on C4e's code.
    - G3: 7.8 syn step 3's "only in the `WORKERS=4` dump" corrected to `WORKERS=0`.
    - G4: the run plant `carriedCountS01` (8; 7.8 syn step 3), caught on b3a2c43, 7e4dfcc and C4e's code; the list
      of trial kinds a run plant reaches, and of those that must get one before step 4 (8, after the table).
    - G5: the poison's scope shown from the code (7.3's Poison bullet); no code change.
    - G6: the stale code comments fixed; `cutTfSet` removed (4.1).
    - Rule 1 holds: every identity run and every C4d plant gives C4d's bytes (12.1's C4e paragraph).
  - To confirm:
    - the plant names `carriedCountB06` (from C4d), `carriedCountS01` and `bufferReadE04` (the lead's tasks gave them
      as examples; 8);
    - the cost: one step-4 run at `WORKERS=4` is estimated at 3.95 h at the stand-in target count (10.14 h at every
      bar), and at 5.76 h (16.13 h) if all 11 finite B items cost what B06 costs: inside 6 h, with 0.24 h to spare,
      measured on a slower day than C4d's (12.5);
    - the CI time: the longest syn job is now `w0-n-1001`, about 2.4 h locally; GitHub's runner time is not
      measured (12.5);
    - this round's text: 4.1, 5.3, 7.3, 7.7, 7.8, 8, 10, 11 (O-14, O-15) and 12 (rules 2 and 3, the paragraphs after
      the method, 12.1, 12.2, 12.4 and the new 12.5).
  - Open points the C4e docs writer found (not asked in C4e's task):
    - No run plant makes `cut.chosen.second` or stage 2's `suspect13` checks fail (8, after the table). The decision
      code of `cut.chosen.second` is `cutGotAt`, which the stage-0 plants reach, but no run exercises the stage-2
      handling of its failure (7.7's D9: stage 2's numbers withheld, exit 3). A plant like `chosenCutFirstDiff` on
      `cut.chosen.second` would; whether to add one is the lead's choice.
    - The `WORKERS=0` step's allowance for `MODE` (`mode=` in print.txt, `"mode"` in config.json) was tested on a
      walkfiles dump edited to look like a `MODE=syn` dump, not on a real `MODE=syn` dump, and the workflow has never
      run on GitHub. The first GitHub run of the three jobs is its first real test (7.8 syn step 3).
  - `lawsearch-dump.md` needs no change: no output file and no compared field changes its meaning. The `WORKERS=0`
    step writes `<RUN>/ts-w0` after the Python step of its job (or in a job without one) and compares TS files with
    TS files only; the Python never reads it. The new plants are plant runs, which the Python does not compare
    (`lawsearch-dump.md` 2).
  - No spec question.
- **O-16 for the lead** (C4f, 2026-11-08). The sources are C4e's review: the power reviewer's three shared-object
  channels, each reproduced by a refuter (`refute-power-1` to `-4`), and the ci-docs reviewer's points on the
  `WORKERS=0` step and the grep step, each reproduced by a ci-docs refuter. None was refuted.
  - Done as the lead decided:
    - H1: every input of every check comes from a snapshot taken right after loading, before any main-run code is
      handed the universe, and the checks have trial definitions, an avoid table and holes of their own (7.3's C4f
      bullet; 7.7's guard; 12.1 item 12). How it was shown that no mutable object is shared any more:
      - the static audit of what each check and unit reads (7.3);
      - the run-time identity check on every run, which fired on all five test copies that share an object;
      - the three plants and the refuters' mutants, caught by the checks with H1 alone.
    - H2: the frozen `TrialDef`, the read-only avoid table, the frozen `ExclCtx` and `Holes`, and the sealed task
      (5.2, 5.3, 7.3; 12.1 item 13). Defense in depth only; what each stops and does not stop is written there.
    - H3: the universe digest, compared after each stage's main part, before every pool run and at each stage's end.
      A change stops the run with exit 6 and no dump folder (2.3; 7.3; 12.1 item 14).
    - H4: the run plants `seriesStashE04`, `trialStashE04` and `avoidStashR3` on CMP-C 7101, with yml tests (8; 7.8
      syn step 3). Each is missed on fcce9e6 (exit 0) and stopped on the C4f code (exit 6, 1 and 1). With H2 and H3
      taken out, each is caught by the cut (exit 3).
    - H5: the `WORKERS=0` step's compare fixed (checks.csv's print row one higher in a `MODE=syn` dump) and tested
      on real `MODE=syn` dumps of C 7101 at `WORKERS=0` (7.8 syn step 3). This answers O-15's second open point:
      the first real test found that the step failed on correct code.
    - H6: the step also compares CMP-C 7101's `lastBarStateG3` plant run at `WORKERS=0` against 4. Its real power is
      written down (7.8 syn step 3). The test mutant `w0hide` hides the plant at `WORKERS=0` only, and only the
      plant run sees that.
    - H7: the grep step's pattern widened, with what it skips and cannot see, and two allow-list lines added (7.8
      hand step 9).
    - H8: the run plant `chosenCutSecondDiff` on CMP-N 1001, which runs 7.7's D9 path end to end (8; 7.8 syn step
      3). This answers O-15's first open point.
    - H9: the poison argument's premises now hold by construction (7.3's Poison bullet); 12.2 (1) and (2); the
      coverage list, with a table of channels (8).
    - Rule 1 holds: every clean run and every existing plant gives C4e's bytes (12.1's C4f paragraph).
  - To confirm:
    - the plant names `seriesStashE04`, `trialStashE04`, `avoidStashR3` and `chosenCutSecondDiff` (8), besides
      O-15's three;
    - exit 6 for a universe that changed after its load. The comparator's exit 6 already means a stop of spec 8.5,
      and 2.3 says the Python uses the TS's codes. CI reads the two programs' exits in separate steps, so nothing
      is misread there; a person reading a log must look at which program printed it. Keep 6, or give the TS's case
      another number? (2.3);
    - the cost. One step-4 run at `WORKERS=4` is estimated at 4.13 h at the stand-in target count (10.56 h at every
      bar), and at 5.93 h (16.58 h) if all 11 finite B items cost what B06 costs. That is inside 6 h by only 0.07 h,
      on a day when this machine ran slower; the C4f code itself measured no slower than C4e's on the same day
      (12.6);
    - the CI time. The longest job is still `w0-n-1001`, about 2.4 h locally. `cmp-n-1001` (about 1.85 h) and
      `cmp-c-7101` (about 1.9 h) grew by their new plant runs. GitHub's runner was not measured (12.6);
    - this round's text: 2.3, 3, 5.2, 5.3, 7.3, 7.4, 7.7, 7.8, 8, 10, 11 (O-16) and 12 (rules 2 and 3, the paragraph
      after the method, 12.1's C4f paragraph and items 9 and 12–14, 12.2 and the new 12.6).
  - Open points the C4f docs writer found (from the code and the C4f runs; none of them changes an output):
    - (C4g, 2026-11-10: corrected in 12.2 (2)'s C4g bullet and O-17; not the one channel, and not at `WORKERS=0`
      only.) Module-level state is the one channel H1 does not close (12.2 (2)). At `WORKERS=0` it can hide a planted
      look-ahead from every check (`w0hide`). CI sees that only through the `WORKERS=0` step's one plant run, which
      reaches E04, E26 and B06's last-bar path. The 40 E items still to be built will run through this code, so
      whether to add a guard for module state is the lead's choice.
    - The holes' typed arrays (`Holes.open`, `present[pi]`, `hole[pi]`) stay writable. No check reads the main
      run's holes, since every check makes its own, and no run plant writes into them. The digest does not watch
      them either, because they are not part of the universe.
    - The identity check and the digest walk own enumerable string-keyed properties only, and the identity check
      also walks Set and Map entries. A value hung on a non-enumerable or symbol-keyed property, a prototype, a
      closure or a WeakMap is not walked (7.3). H1 does not depend on the walk: the snapshot is a structured clone,
      which copies own enumerable properties only, so such a value is not in the snapshot to begin with.
    - Not tested by a run: a WeakMap keyed by the trial object, in which the main run keeps a look-ahead. H1 gives
      the checks other trial objects, so the checks should not find the main run's entries; this was not run. This
      is module-level state again (12.2 (2)).
  - `lawsearch-dump.md`: one bullet added to its section 1 (a TS run that exits 6 leaves no dump folder, and one
    that exits 1 writes no `checks.csv` or print.txt) and one to its section 2 (the new plants' exits). No compared
    file or field changes its meaning. The `WORKERS=0` step is not described there: it compares TS files with TS
    files only.
  - No spec question.
- **O-17 for the lead** (C4g, 2026-11-10). The sources were C4f's review (the power reviewer's channels (1)–(4) and its
  smaller findings, the ci-docs reviewer's points, each reproduced by a refuter) and the C4g design comparison (three
  designs and two judges, 12.7). The design is the lead's choice: the cost-risk judge's hybrid plus the power judge's
  cheap grafts, under an explicit threat model.
  - Done as the lead decided:
    - T: the threat model, with rule 2 restated under it, is in 12 rule 2. Only the cut keeps rule 2 by construction;
      poison and presence catch naive look-ahead only (12.7).
    - G1: the settings are read once, then the environment is revoked, before any worker exists (7.7). The gmo files
      are read once at gate 3, and all three universes are loaded from those bytes before any main-run code; the
      retrace reads them too (7.7, 7.3). Write is narrowed by the flags to the run's own folder (7.7, 7.8).
    - G2: the checks' computations run in workers with no permission (7.3; 12.1 items 15–17; 12.7's table):
      - the cut on a pool made for each cut run (one target per job, T order, deltas, no want: fix 9.4);
      - poison and presence on one pool kept for the run;
      - the follow-bar checks in a fresh worker per call, given coordinates only;
      - every other check audited and tabled.

      `WORKERS=0` is one worker per pool (7.7).
    - G3: the delete-only lockdown and the frozen constants, first in every realm; the V8 flag; the graph audit, the
      source rule and the catch audit, with two catches fixed (7.8 hand steps 10–12; 12.7).
    - G4: H1 kept, the task allow-list, `readOnlySet`'s `WeakSet`, H2, and H3 with exit 7 (2.3, 7.3, 12.7). Exit 7
      answers O-16's question on exit 6. The docs'
      residual list is corrected (12.2 (2), 7.3, 5.3), and so is the grep step's list of escapes (7.8 hand step 9).
    - G5: seven run plants in the new job `plants-c4g` (8; 7.8). Each was missed on b322c13 and is caught, or stopped,
      or shown to reach nothing on the C4g code; `avoidStashR3call` is caught on both.
    - Rule 1 holds: every clean run and every existing plant gives C4f's bytes, and `seriesStashE04` changes its exit
      only (12.1's C4g paragraph). Rule 3: every `WORKERS=0` against 4 comparison was byte-equal.
  - To confirm:
    - the plant names `rp2EnvE04`, `avoidStashR3call`, `lenmemoEntryEarly`, `judgeListen2E04`, `judgeCacheCarryE04`,
      `w0protoG3` and `gmoWriteR` (8), besides O-15's and O-16's;
    - the cost (12.8). One step-4 run at `WORKERS=4` is estimated at 4.07 h at the stand-in target count from paired
      samples (4.16–4.21 h by the other readings), and at 5.87 h (5.96–6.00 h) if all 11 finite B items cost what B06
      costs. That is at the 6-hour edge, with almost no margin. At every bar it does not fit (10.3–16.8 h). C4g adds
      about 2 % to b322c13 on the same pairs;
    - the CI time: the longest job is still `w0-n-1001`, about 2.4 h locally; the new `plants-c4g` takes about 1.3 h.
      GitHub's runner was not measured (12.8);
    - the residuals (12.7). Inside T:
      - 1: poison and presence by the spec;
      - 2: the kept probe pool's carry, measured: for code that keeps state across units, poison's and presence's
        rows can differ between runs and with `WORKERS`;
      - 3: the main-thread checks take the main run's answers as data;
      - 4: the lockdown deletes names and the audits are textual;
      - 5: the env revoke's order is not audited;
      - 6: write goes to the run's folder;
      - 7: the `WORKERS=0` step is defense in depth;
      - 8: the older points.

      Outside T, deliberately not closed: 9–12;
    - this round's text: 2.3, 2.4, 3, 4.1, 4.2, 5.3, 6.1, 7.3, 7.4, 7.7, 7.8, 7.9, 8, 10, 11 (O-17) and 12 (rules 2 and
      3, the paragraph after the method, 12.1's C4g paragraph and items 9 and 12–20, 12.2 (1) and (2), and the new 12.7
      and 12.8).
  - Open points the C4g docs writer found (from the code; none of them changes an output):
    - `lawsearch-par-worker.ts` refuses to serve when any permission reads `granted` (`notSandboxed`), so a Deno that
      ignored `deno: { permissions: "none" }` would fail closed there. `lawsearch-follow-worker.ts` has no such check.
      It is started with the same option, and the same flag is needed. Whether to add the check is the lead's choice.
      - (C4h, 2026-11-11) The first sentence was wrong under the program's flags: `notSandboxed` queried without a
        path, which reads "prompt" in an inheriting worker under `--allow-read=.`, so it would have served (C4g's
        refuter). The lead's F2: both workers now test the main thread's own grants, path-scoped (7.3, 12.7 G2, 12.9).
    - No audit checks two facts that 12.7 rests on:
      - that `readSettings` runs before any worker is made (residual 5);
      - that the shared functions the main thread's checks run (`stratumOf`, `jstDayKey`, and `entryExitIndex` on the
        main side) stay free of state.
      - (C4h, 2026-11-11) The first is not needed: the order does not keep env from the workers ("none" does, 12.7
        residual 5's C4h note). The lead decided the second stays a documented residual, with no new audit.

      An edit that breaks either would bring a channel back unseen. A narrow audit, such as an allow-list of the
      shared functions `lawsearch-checks.ts` may call in the main thread, could be added.
    - `trend-data.ts` and `ownerhold-data.ts` gained an optional `read`. With none given they behave as before, but
      their other callers (the weekly (b) routine and other research) were not run in C4g (the header of this file).
      - (C4h, 2026-11-11) The lead checked them: the weekly (b) program does not load `trend-data.ts`, and a `bsyn` run
        and `loadTf` over 22,040 synthetic files were byte-identical on b322c13 and C4g. No action.
    - `WORKERS=0` and `WORKERS=1` now run exactly alike. The refusal, the yml and the step names still speak of `0`
      (7.7, 7.8). Nothing is wrong, but the two names mean one thing now.
  - `lawsearch-dump.md`: section 1's bullet on the TS endings now says exit 7, and section 2's plant bullet names the
    C4g plants and their exits, and that `gmoWriteR` writes into the run's own gmo folder during the run and writes it
    back. No compared file or field changes its meaning, and the Python is not affected: its 5 and 6 are its own.
  - No spec question.
- **O-18 for the lead** (C4h, 2026-11-11). The sources were C4g's review (two reviewers, nine findings, eight distinct;
  each reproduced from scratch by a refuter) and the lead's F1–F8 on it. 12.9 holds every proof.
  - Done as the lead decided:
    - F1: the `plants-c4g` row test of `avoidStashR3call` is enforced (`grep -q`); no other dead `| … ||` in the yml
      (7.8).
    - F2: both check workers refuse to serve when they hold any of the main thread's grants (`lawsearch-sandbox.ts`);
      the sentences that credited the revoke's order are corrected (2.4, 7.3, 7.7, 12.7 G1, G2, residual 5).
    - F3: a read-only copy of the avoid table per poison and presence unit, adopted because the paired timer shows
      nothing measurable; `avoidStashR3call`'s presence counts halve (8); the task-level objects are tabled (12.9).
    - F4: the graph audit counts re-exports, from the source text and from `deno info` (7.8 hand step 10).
    - F5: the new workflow `lawsearch-audit.yml` and hand step 13 (7.8).
    - F6: residual 6's wording (12.7).
    - F7: the main realm's freeze of `Worker.prototype` and `EventTarget.prototype` and the pinned `Worker`, with hand
      step 14 (12.7 G3, residual 10); not as a run plant.
    - F8: the comment above `DENO_WALK` and the smoke step's grant (7.7, 7.8).
    - The lead's decisions on the C4g docs writer's questions are written where they apply: the kept probe pool stays
      a documented residual (12.7 residual 2), `stratumOf` and `jstDayKey` staying state-free stays a documented
      residual with no new audit, and the shared loaders' other callers need no action (the C4g block above).
  - To confirm: the module name `lawsearch-sandbox.ts`, the workflow `lawsearch-audit.yml` and its 42 paths, the two new
    hand steps; the cost and CI time (12.9: @@O18TIME@@).
  - `lawsearch-dump.md` is not changed: no output's format or meaning changes (one plant's rows change their counts,
    and that plant's files are never compared with the Python's).
  - No spec question.

---

## 12. Speed-up rules (C4b, 2026-11-05)

The owner's answer of 2026-11-05 to "step 4 does not fit a 6-hour job" was 「まず速くする（おすすめ）」: do not change
the spec; make the program faster, measure, and ask the owner again with the measured numbers if it still does not
fit. The goal is one run of step 4 (1,364 trials, 682 per timeframe) inside one GitHub Actions job (6 hours;
`ubuntu-latest`, 4 vCPUs, about 16 GB RAM) if possible, and otherwise as fast as possible, with measured numbers.
The rules below bind every speed-up, in C4b and after it, so that later code keeps them.

What costs the time (C2's measurements on N 1001 with the trial's 12 trials, in
`/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c2/tsr/`:
`profile.ts`, `profile2.ts`, `count-targets.ts` and their `*-n1001.txt`; one run took 4,298 s in C2 and about
3,960 s in C3 and C4a):

- stage 0's cut: each target rebuilds every trial's candidates over the whole cut prefix, so the cost per target
  grows with the number of trials (m15 about 4 ms shared + 1.2 ms per distinct E + 5 ms per further (E, F) trial,
  about 3.4 s per m15 target at 682 trials; h1 about 0.6 s);
- poison and presence: linear in the trials (each probe recomputes one trial on a whole edited series; about 67 s per
  m15 (E, F) trial and 15 s per h1 one);
- the chosen trials' full cuts: about 625 s (first half) and 1,854 s (second half) per m15 (E, F) trial.
- From these, the lead's estimate for step 4: about 50 hours on one core at the least, and up to about 15 days if
  the signal targets of 1,364 trials cover most bars. These are estimates from the measured parts, not a measured
  run of step 4.

The rules (the lead's hard rules, C4b):

1. **The outputs do not change.** Every file under `ts/` (and under a plant's `plant-<name>/`) is byte-identical to
   the reference, except print.txt's `time.*` lines, on passing runs and on failing ones.
   - The reference: C3's runs under
     `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c3/runs/`
     (`n1001`, `c7101`, `flip1001`, `o6001` … `o6004`, and the plants `n1001/plant-*` and `c7101/plant-*`), with
     C4a's two changes to the TS's outputs: `ts/cut_fail.csv`'s column `T` after `s` (T = s + the bar length; 7.3)
     and the text of print.txt's `note.cut_max` (7.7). For the plant `reasonUsesFuture`, C4a's uncapped run
     `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c4a/runs/c7101-reasonUsesFuture`.
   - On a failing run (O 6001; the plants `reasonUsesFuture` and `chosenCutFirstDiff`) this means the same failing
     bars, the same `cut_fail.csv` rows and the same check details, not only the same failed check names.
2. **The checks keep their power.** The cut check exists to catch code that reads the future.
   - Every decision at bar k on the cut side is still computed from the cut series for k alone: every pair's bars
     with T ≤ T_k, as `cutCheck` builds it (7.3's Cut bullet).
     - (C4d, 2026-11-07; C4c's review, finding 4) Reworded to the code. Until C4d this sub-bullet named "`cutTfSet(tf,
       T_k)`, `indOf` on the cut pair, `candidatesOf`, and `classify` with `exclCtxOf(cut, …, toMs: T_k)`". The code
       (`cutGotAt`, b3a2c43's but for B06's window) cuts the target's pair only, `prefixSeries(s, T_k)` (bars 0 …
       k). The other pairs give only their bar starts with T ≤ T_k, for the holes, which are made over the slots
       [s_{k−9} − `HOLE_MIN_SLOTS` × step, T_k). Its Ind is `indFor` of the prefix (higher bars rebuilt from the
       prefix only when a trial reads them). Each trial's decision is `decisionOf`: `candidatesOf` walked from bar 0
       to k, then `reasonOf` at bar k for each emitted row at k. `classify` is not called. Why `reasonOf` at bar k
       alone gives the main run's reason, and what that rests on: 12.2 (1).
     - (C4e, 2026-11-08; the lead's G1, as the lead's hard rule 2 now says it) "The cut series for k alone" means a
       series that **holds only its own bars**: the prefix is a copy of bars 0 … k, each typed array with a memory
       block of its own (4.1 `copyOf`). Until C4e it was a set of views whose memory block held the uncut bars after k
       (7.3; 8's `bufferReadE04`). The same holds for every check series: 7.3, the units' series.
     - (C4f, 2026-11-08; the lead's H1, as the lead's hard rule 2 now says it) **Rule 2, as it now reads: every
       decision at bar k on a check's side is computed from inputs that no main-run code has touched, holding only
       the check's own bars, by the same code the main run uses for bar k, walking from bar 0.** "Inputs no main-run
       code has touched" is a premise of every claim of power below. Until C4f it did not hold. The checks' series
       were copied from the arrays the main run had been handed, and the checks read the main run's trial definitions
       and avoid table (poison also its `ExclCtx`). So the main run's code could leave a look-ahead's answer where the
       checks read it (8: `seriesStashE04`, `trialStashE04`, `avoidStashR3`). Now it holds by construction: every
       input of every check comes from the stage's snapshot taken right after loading and from the checks' own trial
       definitions, avoid table and holes (7.3's C4f bullet). The one exception is module-level state, which H1 does
       not separate (12.2 (2)).
     - (C4g, 2026-11-10; the lead's T and hard rule 2) **The threat model, and rule 2 under it.**
       - **The threat model (T).**
         - The checks must catch ACCIDENTAL look-ahead in main-run code written in good faith. That includes state
           kept across calls: module-level caches and memos, `globalThis` and built-in prototype tables, the
           environment, files, the timing of loads (a stage that loads its data after main-run code has run), and
           state left in long-lived workers.
         - They are NOT required to resist DELIBERATE concealment aimed at the harness itself. Examples: hooks on
           built-ins or Web-API prototypes in the main realm, a `Worker.prototype.postMessage` relay, code that tells a
           check realm from the main one and misbehaves only there, blinding a detector, inverting the poison, and
           rewriting the verdict or the dumps.
         - Cheap defenses against those are kept where they cost nothing measurable. What stays open is listed in
           12.7.
       - **Rule 2, as it now reads.** Within T, every decision at bar k on a check's side is computed:
         - from inputs that no main-run code has touched;
         - holding only the check's own bars (the cut);
         - by the same code the main run uses for bar k;
         - walking from bar 0.

         Under T, "inputs no main-run code has touched" covers state outside objects too. The decision is computed in
         a realm where no main-run code ran: a worker with no permission. Its data were read once, before any main-run
         code ran: the gate-3 bytes. And the environment is closed.
       - **Only the cut keeps rule 2 by construction.**
         - A cut unit's realm has never held a bar after its target's close T_k: deltas, T order and a fresh pool per
           cut run. It has never held the main run's answer either (fix 9.4). So whatever state the code keeps, and
           however it reads what its realm holds, it cannot give the decision at k a later bar.
         - Poison and presence cannot have that, because by the spec their inputs hold the future. Poison's bars after
           T are the real bars shifted by ±7,777 points by parity, so they are exactly invertible. Presence keeps every
           bar after the deleted ones. Code that looks for the future in their inputs finds it.
         - So they catch naive look-ahead only: a direct read of a later bar, as in `bufferReadE04` or set O. And their
           kept pool can carry state from one unit to a later one (12.7, residuals 1 and 2).
       - The cut's construction rests on its trusted harness, as every check's does. That is the code that makes the
         targets, the deltas, the prefix and the comparison (`cutTargets`, `lawsearch-par.ts`, `cutGotAt`,
         `prefixSeries`, `copyOf`, `mismatchesOf`), and the main thread's realm, in which that code runs next to the
         main run. Within T the harness runs only plain loops, check-only modules, frozen constants and pure functions
         of shared modules (`stratumOf`, `jstDayKey`). 12.7's table of the checks shows each part's realm and what it
         runs. A pure function that later gains a memo would bring state back into the main thread, and no audit checks
         that. Deliberate hooks in the main realm stay open (12.7, residual 9).
       - The C4f sentence above, "the one exception is module-level state", no longer holds: 12.2 (2)'s C4g bullet
         says what is closed now.
   - Work may be shared only between computations that see the same cut series: for example, at one target k, the
     cut set, its higher bars and the cut pair's indicators can be built once and read by every trial decided at k.
   - Nothing is taken from the uncut series, or from another k's cut series, unless it is provably the same value by
     construction; the builder then says why, in a code comment at that place and in the round's report. (B06's
     291-bar window of 7.3 is not such a case: it reads only bars of the cut series for k.)
     - (C4d, 2026-11-07; C4c's review, finding 1; the lead's F1) The window is gone. It read only bars of the cut,
       but it walked them from bar k − 290 instead of bar 0, so a look-ahead carried by state, by rows already
       emitted or by n was never seen on B06 (7.3's Cut bullet). Every item is now cut on its prefix from bar 0.
   - The same for poison and presence: each probe's decision still comes from its own edited series (every pair's
     series poisoned after T, or the bars deleted, and the higher bars rebuilt from them, as 7.3 says).
     - (C4d, 2026-11-07) As the code is, poison edits only the trial's pair (7.3's Poison bullet; the reading is for
       the lead to confirm, 11 O-14). Presence deletes as 7.3 says.
     - (C4e, 2026-11-08; the lead's G5) The lead accepts that reading only if it is exact. 7.3's Poison bullet now
       shows from the code that the decision at T reads nothing else that the spec's 毒 would change, so poisoning
       the other pairs, the other timeframe and the 1-minute bars could not change it. No code change.
   - A shortcut that is exact only because today's 12 trials happen to have a property is not allowed. For example:
     that no built item reads another pair's bars or the higher timeframe, so that a target's cut could leave the
     other pairs or the higher bars uncut. It must stay exact for every item the registry can build later.
   - (C4c, 2026-11-07; after C4b's review, finding 1) **Rule 2, restated.** Every decision on the side of the cut,
     the poison or the presence is made by the very code the main run uses for that decision, run on the check's
     own series alone.
     - For spec 5's rows that code is `candidatesOf` (5.3): one walk over every bar of the series it is given, from
       bar 0, in order. The main run calls it on the uncut series. Every check calls it, through `decisionOf` (7.3),
       on its own cut, poisoned or edited series. A cut series ends at its target k, so the walk ends there.
       (C4d, 2026-11-07) "window" is struck from that list: until C4d, B06's cut used a 291-bar window (7.3), so
       for B06 this bullet did not hold. Now it holds for every item.
     - So any code that reads beyond k shows up as a difference, however it reads: directly (an index past k),
       through state carried from one bar to the next, through rows already emitted, or through the series' length
       n. This holds by construction for any change of the per-bar code, of the builds or of the items that keeps
       every build and cache keyed by the Ind and adds no module-level state that survives between `candidatesOf`
       calls (12.2 (2)). Within that condition it does not depend on the per-bar code keeping no state.
       - (C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's q1; the lead's G1) Also
         through the series' memory block (a typed array or `DataView` over `C.buffer`), since C4e: every check
         series holds its own bars only (4.1 `copyOf`). Until C4e the cut prefix was a view, so such a read saw the
         uncut bars after k inside C4d's condition, and the cut passed it: the reviewer's P5 (B06's keep read through
         a `Float64Array` over the buffer; on h1, 0 of 1,972 bars differing on the view against 967 on a copy) and
         the refuter's q1 (E04 read through a `DataView`). Poison and presence, which make fresh arrays, were the
         backstop. The run plant `bufferReadE04` (8) now guards it: the cut passes it on 7e4dfcc and fails it on C4e's
         code.
       - (C4f, 2026-11-08; C4e's review, the power reviewer and refuters 1–4; the lead's H1) And whatever that code
         writes into the objects it is handed, since C4f. A check's series, trial definitions, avoid table and holes
         are made from a snapshot taken right after loading and from the checks' own copies (7.3's C4f bullet), so a
         value the main run's call of the code left in its own universe, trial or avoid table never reaches a check.
         Until C4f such a value sat in every check's input, inside C4d's condition, and every check passed it (8:
         `seriesStashE04`, `trialStashE04` and `avoidStashR3` on fcce9e6, exit 0). The three plants now guard it.
         On the C4f code H3 and H2 stop them before any check runs. With those taken out, the cut catches each of
         them by H1 alone (7.8 syn step 3).
       - (C4d, 2026-11-07; C4c's review, finding 2; the lead's F2) Until C4d this bullet said "for any future change
         of the per-bar code, of the builds or of the items", with no condition. Module-level state is not part of
         "the check's own series alone", so the construction does not cover it. C4c refuter 2's mutant B changed only
         the loop's body and added module-level state (the longest n seen per trial and pair); it was silent at
         `WORKERS=0` (exit 0, every file as the clean run's) and caught at `WORKERS=4`. Such state can also make
         the bytes depend on `WORKERS` (12.2 (2), rule 3).
     - A shortcut (any other way to get the decision at k; for example C4b's `candidatesAt`, which ran the per-bar
       body at bar k alone after `prepare`) is allowed only when its equality with the main run's code holds by
       construction for any future change of that code. That today's code happens to keep no state, or happens to
       pass a test, is not enough.
     - **Why a sampling guard alone is not enough.** A guard that compares a shortcut with the full code finds a
       difference only on the inputs it tries, and a look-ahead acts only where its trigger is. C4b's guard
       (`lawsearch-candat-check.ts`, 7.8) compared `candidatesAt` with `candidatesOf` at every bar, but of the
       uncut series only: each pair offered one series end, where the cut check asks one series end per target.
       C4b's reviewer and refuter planted a look-ahead that drops a raw signal on the series' last bar when the last
       row before it is exactly G bars back. With G = 3 and with G = 5 it passed the guard on all eight local runs
       (N 1001, N 1002, C 7101, O 6001–6004, FLIP 1001); a gap-4 variant was caught on O 6001 alone, at one bar.
       b3a2c43's cut (`candidatesOf` on every cut prefix) failed the same plants on C 7101, with 461 (G = 3) and 423
       (G = 5) rows in cut_fail.csv, and C4b's code gave exit 0, every file as the clean run. Whether such a guard
       catches a later change depends on how that change happens to be written, and that is what this rule forbids.
       A sampling guard may be added as defense in depth, never in place of the construction.
     - The run plants `lastBarStateG3` and `lastBarStateG5` (8) must keep failing the cut on CMP-C 7101 (7.8 syn
       step 3). On C4b's one-bar path they did not (exit 0). (C4d, 2026-11-07) So must `carriedCountB06` (8), on
       m15.B06 or h1.B06: with B06's window (b3a2c43 and 876b9e4) it gave exit 0. (C4e, 2026-11-08) So must
       `carriedCountS01`, on m15.S01 or h1.S01, and `bufferReadE04`, on an E04 trial: with the cut prefix a view
       (7e4dfcc) the cut passed `bufferReadE04`. (C4f, 2026-11-08) And `seriesStashE04`, `trialStashE04` and
       `avoidStashR3` must stay stopped (exit 6, 1 and 1) and caught by the cut when H2 and H3 are taken out. On
       fcce9e6 every check passed them. `chosenCutSecondDiff` must keep failing `cut.chosen.second` with stage 2's
       numbers withheld (8). (C4g, 2026-11-10) `seriesStashE04`'s exit is now 7 (2.3). The seven plants of the job
       `plants-c4g` must keep the exits and catches that job wants (7.8; 8): `rp2EnvE04` 1, `gmoWriteR` 0 with its
       probe lines, and 3 for the others, by the cut or the follow-bar check. Each of them was missed on b322c13.
     - Poison and presence: their units call the same `decisionOf` on their own edited series (7.3).
     - How each part of today's code keeps this, and what guards it: 12.1. The two places where it still rests on
       how future code is written: 12.2.
3. **Determinism.** The same inputs give the same bytes, whatever the number of workers or the machine. (So the
   results of workers are put together in the row orders that `lawsearch-dump.md` already fixes, never in the order
   in which the workers finish, and every sum keeps 2.5's order.)
   - (C4d, 2026-11-07; C4c's review, finding 2) Today's code meets this by construction only while every build and
     cache is keyed by the Ind and no module-level state survives between `candidatesOf` calls (12.1 item 9, 12.2
     (2)). The yml's step that compares `WORKERS=0` with 4 on one run (7.8 syn step 3) is defense in depth for it.
     - (C4e, 2026-11-08; the lead's G2) On three clean runs now (CMP-N 1001, CMP-C 7101, O 6003), which between them
       reach every kind of pool run the synthetic runs reach but stage 2's `suspect13` checks (7.8 syn step 3). Still
       defense in depth, not a guard by construction.
     - (C4f, 2026-11-08; the lead's H5 and H6) The step's compare now allows exactly what `MODE=syn` makes differ,
       checks.csv's print row among them, and was tested on real `MODE=syn` dumps at `WORKERS=0`. In `cmp-c-7101` it
       also compares the plant run `lastBarStateG3`. What it can and cannot show is written in 7.8 syn step 3. H1
       takes state carried in the universe, the trial definitions or the avoid table out of the question, since the
       checks no longer read the main run's objects. Module-level state is what is left (12.2 (2)). The guard (7.7)
       adds nothing to any file and does not depend on `WORKERS`: the same digests and identity checks run before
       every pool run at any setting.
     - (C4g, 2026-11-10; the lead's G2) **What the step compares now.**
       - `WORKERS=0` no longer runs the units in the main thread. It runs one worker in each of the checks' two pools,
         as `WORKERS=1` does (7.7). So the main run's state cannot differ between the two settings in any check realm:
         it is in none of them.
       - What can still depend on `WORKERS` is state that one unit leaves for a later one in the same worker.
         - In a cut worker such state holds no bar after the target it is used at (deltas). It could still change a
           cut decision with the order of the jobs, which is T order in every pool, and with which jobs a worker
           gets.
         - In a probe worker it can hold anything the snapshot holds.
       - The jobs go to whichever worker answers first, so that spread also depends on timing. The C4g integrator
         measured this with `judgeCacheCarryE04`. Its presence row on h1.E04.F00 read "2 of 200" in all four runs of
         the same code, but named a different bar from run to run (12.7, residual 2).
       - Clean code keeps no such state. Every `WORKERS=0` against 4 comparison and every repeated run of this round
         was byte-equal (7.8 syn step 3; 12.1's C4g paragraph). The guard and the pools add nothing to any file.
4. **No change to the spec, to what is checked, or to how many targets and probes there are** (7.3's targets of
   each cut check, poison's 100 signals and 100 bars and 13 (ii)'s 1,000, presence's (i) and (ii)).

How a speed-up is shown to keep them: the reference runs above are made again with the new code (`CUT_MAX` unset)
and every `ts/` file is compared with the reference by its bytes (print.txt with its `time.*` lines removed); the
`time.*` lines and the machine (CPUs, workers) are recorded; step 4's time is then estimated from the measured costs
and written as an estimate. When it still does not fit one job, the measured numbers go to the owner and the owner
is asked again.

(C4c, 2026-11-07) Identical bytes show rule 1, not rule 2: a check that has lost its power still passes on a clean
run. So a speed-up of a check's path is also run with a plant that only the full path catches, on b3a2c43's code, on
the new code and, where one exists, on the shortcut it replaces; the new code must fail it as b3a2c43 does. C4c did
this with `lastBarStateG3` and `lastBarStateG5` (8).

(C4d, 2026-11-07) "As b3a2c43 does" is not enough where b3a2c43 itself lacks the power. On C4c's code and on
b3a2c43's, `lastBarStateG3` and `lastBarStateG5` failed the cut on E04 and E26 only: on B06, the window that both
share hid them, and the comparison could not show it, because both missed them there alike. C4d ran
`carriedCountB06` on b3a2c43's code and on 876b9e4's (both with the window: exit 0, missed) and on the new code
(exit 3, caught); without the window, G3 and G5 fail on B06 too (7.8 syn step 3). So a plant must reach each path
under test, here each item's own cut, and the code must catch it whatever b3a2c43 does.

(C4e, 2026-11-08) The same held for the memory block: b3a2c43, C4c and C4d all cut on views, so a read through the
memory block passed the cut on every one of them alike (the power reviewer's P5 on b3a2c43 too). C4e ran
`bufferReadE04` on 7e4dfcc (the cut passed; only poison and presence failed) and on the new code (the cut failed on
the four E04 trials); it was not run on b3a2c43. And no run plant reached the S path through `candidatesOf`'s loop
until `carriedCountS01` (the lead's G4), which b3a2c43, 7e4dfcc and the new code all catch. Which trial kinds a run
plant reaches now, and which must get one before step 4: 8, after the table.

(C4f, 2026-11-08) The same held for the objects the main run is handed. The checks read them, or copies of them made
after the main run had used them, on b3a2c43 (by C4e's reviewers; not measured in C4f) and on fcce9e6 alike. So a
look-ahead that left its answer there passed every check on both. C4f ran `seriesStashE04`, `trialStashE04` and
`avoidStashR3` in three ways (8; 7.8 syn step 3):
- on fcce9e6: exit 0, every check passed, missed;
- on the new code: stopped before any check (exit 6, 1 and 1);
- on the new code with H2 and H3 taken out, H1 alone: exit 3, caught by the cut.

C4e's refuters' own mutants gave the same three results. So the power now comes from the construction (H1); the
detector and the freezes come on top of it. A plant must reach each channel where a value can be kept, as well as
each path (8, the table of channels).

(C4g, 2026-11-10) The same held for state that is not held in an object handed to the code, which H1 cannot
separate. C4f's review found the channels and the C4g judges added two:
- the run's files, reread by stages 1 and 2;
- the environment;
- module state in the checks that ran in the main thread;
- realm globals at `WORKERS=0`;
- process-global Web APIs and state left in long-lived workers;
- what a worker is sent, kept by a listener.

The C4g integrator ran one plant per channel (8) as the job `plants-c4g` does, in two ways:
- on b322c13 (the C4f code) with the same plant code (`c4g/copies/b3p`): five were missed and `lenmemoEntryEarly`'s
  named check passed; `avoidStashR3call`, which tests H1, was caught (exit 3);
- on the C4g code: each one caught by its named check, or stopped with a clear error, or (`gmoWriteR`) shown to reach
  nothing.

So the power against these channels comes from the realms' construction (12.7). The lockdown, the frozen constants
and the audits come on top of it.

### 12.1 How each part of the code keeps the rules, and what guards it (C4c, 2026-11-07; C4b's review, finding 3)

Each part below is in the code now (C4c's code; C4b's speed-ups "free", "share" and "par", less `candidatesAt`).
"Exact" says why it gives b3a2c43's values by construction. "CI" names the steps of 7.8 that fail if it breaks.
"Local" is evidence outside CI. Besides these, the identity runs of 12's method cover every part at once: C4b's on its
code, and C4c's on N 1001, C 7101, FLIP 1001, O 6001–6004 and C3's run plants (every `ts/` file byte-identical to
C4b's dumps, and to C3's but for C4a's two known changes; print.txt without `time.*`).

(C4d, 2026-11-07) The code now is C4c's with three changes: B06's cut window removed (7.3), `bigmoveOf` rewritten
exactly (item 10), and the run plant `carriedCountB06` (8). C4d's identity runs, each at `WORKERS=4` with no other
heavy process on the machine:
- N 1001 (85 files), C 7101 (83), FLIP 1001 (84) and O 6001–6004 (77 each): every `ts/` file is byte-identical to
  C4c's (print.txt without `time.*`). FLIP 1001's flip judgement gives C4c's result, and the O step passes on each O
  run.
- The run plants `reasonUsesFuture` and `chosenCutFirstDiff` (C 7101) and `avoidFull`, `secondHalfAll`,
  `dropSecondStrata` and `blindRowHit` (N 1001): every file equals C4c's kept files.
- `lastBarStateG3` and `lastBarStateG5` differ from C4c's files in B06's rows only, because B06 now catches them
  (7.8 syn step 3).
- `MODE=hand`: 103 pass, 0 fail and 41 skip; the 21 TS hand plants exit 4 with b3a2c43's outputs.

(C4e, 2026-11-08) The code now is C4d's with these changes: every check series is a copy that holds its own bars
only (`copyOf` in place of `viewOf`, and `cutGotAt`'s bar starts for the holes sliced; item 11), the run plants
`carriedCountS01` and `bufferReadE04` (8), `cutTfSet` removed (4.1), and comments. The C4e integrator's runs, each
at `WORKERS=4` with no other heavy process (but a brief one during N 1001), logs and kept files in the C4e scratch
folder (`c4e/`):
- N 1001 (85 files), C 7101 (83, run twice), FLIP 1001 (84) and O 6001–6004 (77 each): every `ts/` file is
  byte-identical to C4d's (print.txt without `time.*`). FLIP 1001's flip judgement gives C4d's result (RESULT pass),
  and the O step passes on each O run.
- C4d's nine run plants, `reasonUsesFuture`, `chosenCutFirstDiff`, `lastBarStateG3`, `lastBarStateG5` and
  `carriedCountB06` (C 7101) and `avoidFull`, `secondHalfAll`, `dropSecondStrata` and `blindRowHit` (N 1001): every
  file's sha256 equals C4d's kept files (print.txt without `time.*`). No existing plant newly fails: on these runs
  the copies change no decision.
- The new plants: 7.8 syn step 3 and 8.
- The `WORKERS=0` step (as extracted from the yml) on N 1001, C 7101 and O 6003: exit 0, every file equal (7.8 syn
  step 3).
- `MODE=hand`: 103 pass, 0 fail and 41 skip; the 21 TS hand plants exit 4 with b3a2c43's outputs; the yml's
  hand-plant step exits 0 (21 TS plants and 20 Python twins caught). The gates, and the yml's `CUT_MAX` and
  `WORKERS` refusal steps, pass. `deno check`, `deno lint` on the 8 changed files and the stage-0 import graph pass.
- The code went through three versions that differ in comments only (`c4e/logs/v1-v2-comment-only.txt`,
  `v2-v3-comment-only.txt`): the runs before 06:51 UTC used v1, the later ones v2, and v3 changed one comment in
  `lawsearch-par.ts`. `MODE=hand` and the hand-plant step gave the same lines on all three.

(C4f, 2026-11-08) The code now is C4e's with these changes:
- H1 (item 12): the checks' inputs come from a snapshot of each stage's universe, the checks' own trial copies and
  avoid table, and poison's holes made in the unit;
- H2 (item 13): the frozen and read-only definitions;
- H3 (item 14): the universe digest, with exit 6;
- the run plants `seriesStashE04`, `trialStashE04`, `avoidStashR3` and `chosenCutSecondDiff` (8), the yml's changes
  (7.8), and comments.

Eight `.ts` files changed: `lawsearch.ts`, `-checks`, `-events`, `-items`, `-par`, `-par-worker`, `-rules` and
`-stage0`. The C4f integrator's runs were made at `WORKERS=4` with one heavy process at a time. Logs and kept files are
in the C4f scratch folder (`c4f/`). The code was the same in every run (each queue job checked
`c4f/code-after-apply.sha256`).
- N 1001 (85 files), C 7101 (83; run twice, with fcce9e6 run between the two), FLIP 1001 (84) and O 6001–6004 (77
  each): every `ts/` file is byte-identical to C4e's (print.txt without `time.*`). FLIP 1001's flip judgement gives
  C4e's result (RESULT pass, the same text but the paths and time lines), and the O step passes on each O run.
- C4e's eleven run plants: `reasonUsesFuture`, `chosenCutFirstDiff`, `lastBarStateG3`, `lastBarStateG5`,
  `carriedCountB06`, `carriedCountS01` and `bufferReadE04` (C 7101), and `avoidFull`, `secondHalfAll`,
  `dropSecondStrata` and `blindRowHit` (N 1001). For each, every file's sha256 equals C4e's kept files (print.txt
  without `time.*`), and the yml's tests pass where the matrix has them. No existing plant newly fails or changes:
  the snapshot, the copies and the freezes change no decision.
- The new plants, the refuters' mutants, the identity-check tests and `w0hide`: 7.3's C4f bullet and 7.8 syn step 3.
- The `WORKERS=0` step, as extracted from the yml: N 1001 and O 6003 exit 0 (85 and 77 files equal), and C 7101 on
  a real `MODE=syn` dump exit 0, its plant part included (7.8 syn step 3).
- `MODE=hand`: 103 pass, 0 fail and 41 skip. The 21 TS hand plants exit 4 with b3a2c43's outputs. The yml's
  hand-plant step exits 0 (21 TS plants and 20 Python twins caught, the lines equal to C4e's). The gates, and the
  yml's `CUT_MAX` and `WORKERS` refusal steps, pass. So do `deno check`, `deno lint` on the 8 changed files, the
  stage-0 import graph and the widened grep step (13 lines, all allowed).
- Rule 1 for the guard: it writes only `[lawsearch guard] …` lines to stderr, and the freezes change no value. That
  is why every run above has C4e's bytes.
- After the runs the yml was edited in comments only. The W0 step's comment now cites the measured `w0hide` result.
  The steps extracted again differ from the tested ones in 11 comment lines and in nothing else, and the lead
  committed that edit as 51a57d6.

(C4g, 2026-11-10) The code now is C4f's (b322c13) with these changes. The design is the one the lead chose after the
C4g design comparison (12.7). The details are in the items below and in 12.7.
- G1: the settings read once, then the environment revoked (7.7). Gate 3 reads the run's files once (`treeBytes`), and
  the three loads and keeps come from those bytes before any main-run code (7.7; 4.1, 4.2). The retrace reads the same
  bytes (7.3). Write is narrowed by the flags (7.7, 7.8).
- G2: the checks' two pools of workers with no permission (7.3). The cut pool is made for each cut run (one target per
  job, T order, deltas, no want: fix 9.4); the probe pool is kept for the run. `inPlace` is removed. The follow-bar
  checks run in a worker of their own, started for each call (6.1).
- G3: the lockdown and the frozen constants, first in every realm. The V8 flag that turns code generation from strings
  off. The three audits of the hand job (7.8 hand steps 10–12). Two catches that now rethrow (4.2).
- G4: the allow-list for every check run's task (7.3), `readOnlySet`'s `WeakSet` (5.3), `PRINT_KEYS` frozen, and
  exit 7 (2.3).
- G5: seven run plants and the job `plants-c4g` (8; 7.8).

The changed files:
- 16 `research/lawsearch*.ts` files. Of these, `-lockdown`, `-frozen`, `-follow-worker` and `-audit` are new, and the
  others are `lawsearch.ts`, `-bars`, `-checks`, `-dump`, `-events`, `-flip`, `-gen`, `-par`, `-par-worker`, `-rules`,
  `-stage0` and `-trade`;
- `trend-data.ts` and `ownerhold-data.ts` (the header of this file);
- the yml.

The C4g integrator's runs were made at `WORKERS=4` unless named. Logs and kept files are in the C4g scratch folder
(`c4g/`). The code is `c4g/code-c4g.sha256`, 27 files, which is the lead's WIP commit 34e657c. Every queue job checked
that list before and after its run.
- "Code v1" (`c4g/code-c4g-v1.sha256`, commit 9bf130c) differs from the final code only in the `judgeCacheCarryE04`
  helper of `lawsearch-events.ts`. That helper runs only under that plant, and the integrator rewrote it for speed
  (5.3). These runs used v1: C 7101, N 1001, FLIP 1001 and O 6001–6004 (the first identity runs), the `MODE=syn` C
  7101 dump, and six of the C 7101 plants (8). Every other run used the final code.
- N 1001 (85 files), C 7101 (83), FLIP 1001 (84) and O 6001–6004 (77 each): every `ts/` file is byte-identical to
  C4f's (print.txt without `time.*`). FLIP 1001's flip judgement gives C4f's result (RESULT pass), and the O step
  passes on each O run.
- On the final code, C 7101 was run twice more, alone: 83 of 83 files equal C4f's each time. CUT_MAX=1 C 7101 was run
  at `WORKERS=4` and at `WORKERS=0` on three versions of the code (before the plants, with the inert plants, final).
  Each gave 83 files with 0 differences against b322c13's `WORKERS=4` dump (the C4g designer "sandbox"'s `ref-cm1`).
- A real `MODE=syn` C 7101 dump (`--allow-write=<OUT>` only): its tree equals the manifest (22,040 files). Its 83
  files equal C4f's walkfiles dump except what the yml allows: the `run`/`mode` lines, config.json's `run` and `mode`,
  and the print row (90 keys against 89).
- C4f's run plants:
  - the ten on C 7101 (`reasonUsesFuture`, `chosenCutFirstDiff`, `lastBarStateG3`, `lastBarStateG5`,
    `carriedCountB06`, `carriedCountS01`, `bufferReadE04`, `seriesStashE04`, `trialStashE04`, `avoidStashR3`);
  - the five on N 1001 (`avoidFull`, `secondHalfAll`, `dropSecondStrata`, `blindRowHit`, `chosenCutSecondDiff`).

  For each, every file's sha256 equals C4f's kept list (print.txt without `time.*`), and the yml's tests pass. The
  one intended change is `seriesStashE04`'s exit, 6 → 7. No existing plant stops earlier, or differs in any row.
- The `WORKERS=0` step, as extracted from the yml (7.8 syn step 3): `cmp-c-7101` (the clean run and its
  `lastBarStateG3` plant), `o-6003` and `w0-n-1001` each exit 0.
- The step of `plants-c4g`, as extracted from the yml: `bad=0` on the final code, twice (once beside another run, once
  alone). On b322c13 with the same plants it gave `bad=1` (8).
- The hand job's steps, as extracted, all exit 0 on the final code:
  - `deno check`, the stage-0 graph, the three new audits and the grep step (15 matching lines, `poisonSeries`' line twice, all in its 14-line allow-list);
  - `MODE=hand` (103 pass, 0 fail, 41 skip);
  - the hand-plant step: the 21 TS plants exit 4 with a named example, and the 20 Python twins are caught;
  - the refusal steps.

  `deno lint --no-config` on the 18 changed `.ts` files is clean.
- Rule 1 for the realms. They move where a value is computed, and when a file is read, not what any value is: the
  bytes are the same as when they were read from the disk, and so is each unit's decision. The lockdown deletes names
  no computation reads. The frozen constants refuse writes that no code of the program makes, or every run would have
  thrown. The pools and the follow worker write only stderr lines (`[lawsearch pools] …`, `[lawsearch] follow-bars …`).
  Every run above is the evidence: C4f's bytes.

1. **`candidatesOf`, one walk** (`lawsearch-events.ts`; C4c restores b3a2c43's path).
   - What: `prepare` (① and what ②–④ read: the builds through `buildOf`, the kind, the first bar whose condition is
     not 無し), then b3a2c43's loop over i = 0 … n − 1, then `finish` (⑤ and warmOk). C4c writes the loop's body
     out once per direction, with the per-direction arrays taken once per call, for speed: 7.3 nanoseconds per trial
     and bar with b3a2c43's loop as written, 2.8 written out (the C4c restore designer's measurement).
   - Exact: the same tests in the same order at every bar, and the same rows appended in the same order (buy before
     sell, after both directions are decided). b3a2c43's branch on the kind becomes `!edge || …`, because `prepare`
     sets `edge` true only for condition and hold without the plant `noRisingEdge` (cross and state never test a
     rising edge). It is the one way to get a trial's rows (12 rule 2).
     - (C4d, 2026-11-07; C4c's review, finding 2) The power by construction of 12 rule 2 holds for any change that
       keeps every build and cache keyed by the Ind and adds no module-level state that survives between
       `candidatesOf` calls (12.2 (2)). (C4d) It now holds for B06 too: its cut walks the prefix from bar 0 (7.3).
       (C4e, 2026-11-08) And however the series is read, through its elements or through its memory block: every
       check series holds its own bars only (item 11).
   - CI: `--run`'s comparison of `signals/` and everything built on them (every syn job but O's, and each flip job's
     FLIP=1 run); the hand examples of spec 5 (A.4) and the hand plant `noRisingEdge` (A.4.1, A.4.33, A.4.34); the
     run plants `lastBarStateG3`, `lastBarStateG5` and `reasonUsesFuture` on CMP-C 7101; the O step. (C4d,
     2026-11-07) Also the run plant `carriedCountB06` on CMP-C 7101, the one plant that reaches B06's path. (C4e,
     2026-11-08) Also `carriedCountS01` (the S path inside the loop) and `bufferReadE04` (a read through the memory
     block, E04's path) on CMP-C 7101 (8).
   - Local: the restore designer's comparison of C4c's `candidatesOf` with b3a2c43's on N 1001, with 682 stand-in
     trials and the built ones, both timeframes and five pairs, the whole series and 9 prefixes, and the options
     none, `noRisingEdge` and answer-knowing: 204,600 units, 310,625,813 rows, none differs.
2. **`candidatesAt` and `rowsAtBar`** (C4b): removed in C4c, with the CI step that sampled them (7.8). They appear in
   comments only.
3. **`BUILDS` and `buildOf`** (`lawsearch-events.ts`; C4b "free").
   - What: an Ind's item and F builds are kept in a WeakMap keyed by the Ind, under `item:<id>` and `filter:<id>`
     (`item:E26:answerKnowing` apart), so that the trials on one Ind with the same item or F build it once. A build
     made with params (the hand examples) is not kept.
   - Exact: an Ind is made from one series (the uncut one, one cut target's prefix, one poisoned or edited copy;
     until C4d also one B06 window) and never sees another. A build is a function of the Ind (its series and plant),
     the definition and the params alone, and nothing writes into it. So a kept build is the build the next trial
     would make again from the same series, and nothing passes between series. This needs one definition per id:
     `checkRegistry` (`lawsearch-items.ts`) stops the program when the module is loaded, before any file is read, if
     a key of `ITEM_MAP` or `FILTER_MAP` is not its definition's id.
     - (C4d, 2026-11-07; C4c's review, finding 2) This holds only because the cache is keyed by the Ind. A cache
       keyed by anything else (pair, trial, bar, or a series' buffer, which a prefix shares with the uncut series)
       or any other module-level state would carry one series' values into another's. The checks would not see it,
       and the bytes could then depend on `WORKERS` (12.2 (2)). The `BUILDS` comment in `lawsearch-events.ts` says
       so too.
       - (C4e, 2026-11-08) A cut prefix no longer shares the uncut series' memory block: it is a copy (item 11).
         So a cache keyed by a series' memory block no longer carries the uncut series into a cut, but a cache keyed
         by pair, trial or bar still would (12.2 (2): mutant M2).
   - CI: `checkRegistry` runs in every step that runs the program. The O step: `answerKnowingE26`'s build reads
     C[i+1], so if a cut or poisoned Ind were given a build of the uncut series, the cut and the poison would stop
     failing on the E26 trials and the step would fail (reasoned; no such mutant was run).
   - Not guarded: a cache keyed by anything but the Ind (12.2). (C4d, 2026-11-07) Only defense in depth: the O step
     above and the yml's `WORKERS=0` against 4 step (7.8 syn step 3). With C4c refuter 2's module memo (keyed by
     the series' buffer) added to C4d's code, that step fails (7.8 syn step 3); it is not a guard by construction.
     (C4e, 2026-11-08) On C4e's code that memo is inert (the copies give every prefix its own memory block: exit 0,
     every file as the clean run's). The memo M2, keyed by the series' pair and timeframe, the trial and the
     options, makes the step fail on C4e's code (7.8 syn step 3).
4. **`donchianOf`'s monotone queues** (`lawsearch-ind.ts`; C4b "free").
   - What: HH and LL come from two monotone queues of bar indices (O(len) in all). `donchianScan`, b3a2c43's rescan,
     is kept for n that is not a whole number ≥ 1.
   - Exact: max and min round nothing, so only which bar's value is taken could differ, and the queue's front is
     the rescan's bar: the oldest bar with the largest H under `>` (a NaN bar never taken), and the same for L. The
     argument is in the code. Nothing after bar i − 1 is read for bar i.
   - CI: the check `donchian` on every run (spec 15: E26's s against bigflow-lib's `donchianState(c, 20)` on every
     bar of both timeframes and five pairs); the hand examples A.4.1 (n 20) and A.4.2 (n 55); `--run`'s comparison
     of `ind/` (`DON20_HH`, `DON20_LL`, `DON20_s`).
5. **The lazy RSI parts** (`lawsearch-ind.ts`, `lawsearch-items.ts`; C4b "free").
   - What: `rsi(p)` makes up, dn, U and D only when they are first read (getters; U and D through `rmaOf`'s memo, so
     every read gets the same array). E04's dump columns `RSI14_U` and `RSI14_D` are getters too. A signal reads
     only `rsi`.
   - Exact: the same functions on the same inputs, only later. The RSI is pineRsi's as before; its input is copied
     by a loop instead of `Array.from` (the same numbers in the same order).
   - CI: the hand examples A.3.7, A.3.9, A.4.29 and A.4.30 (up, dn, U, D and the RSI); `--run`'s comparison of
     `ind/` (`RSI14`, `RSI14_U`, `RSI14_D`) and of `signals/`.
6. **The poison tables** (`lawsearch-bars.ts` `poisonSeries` and `poisonTables`, `lawsearch-checks.ts` `tablesOf`;
   C4b "share").
   - What: two alternately shifted copies of the whole uncut series (alt[0]: + on the even bars and − on the odd
     ones; alt[1] the other way round), made once per check in the main thread, or once per task on each worker,
     from that thread's own copy of the uncut series. A probe's poisoned series is s's bars before k0 (the first bar
     with T > T_i) and alt[k0 & 1]'s bars from k0 on. (C4g, 2026-11-10) Now once per task on each probe worker only,
     since no unit runs in the main thread.
   - Exact: the bar k ≥ k0 gets + exactly when k − k0 is even, that is when k has k0's parity; and `shifted` makes
     each bar from that bar's own values and its sign alone. So alt[k0 & 1]'s bar k is the bar the per-probe
     poisoning makes (the proof is at `poisonSeries`). The tables depend on the uncut series and the pips alone,
     never on a probe, and each probe's Ind and decision are still made from its own poisoned series.
   - CI: the O step (the poison must fail on the four E26 trials). No CI step compares a series made with the
     tables with one made without them: `checks.csv` is TS only and not compared (`lawsearch-dump.md` 10).
   - Local: the identity runs (`checks.csv` byte-identical to C3's, which were made without tables).
7. **`deleteBars` by runs** (`lawsearch-bars.ts`; C4b).
   - Exact: each run of adjacent kept bars is one typed-array copy, the same values in the same order as one bar at
     a time; `drop` is still asked once for every bar, in order.
   - CI: presence on every run; `reasonUsesFuture` on CMP-C 7101 needs the cut or presence to fail (in C4c's run,
     presence failed on 12 trials and the cut on 3).
   - Local: the identity runs.
8. **The holes' clock cache** (`lawsearch-events.ts` `CLOCK` and `clockBlock`; C4b "share").
   - What: whether slot a is ②'s time or a GMO holiday time (`r2(a) || isGmoHoliday(a)`) is computed once per slot,
     in blocks of 4,096 slots per step, and kept for the rest of the run (in each thread).
   - Exact: that value reads the clock alone (no bar, no series, no plant), so it is one value for every `holesOf`
     call that meets slot a, whatever series the call is given. Every part that depends on bars (which pairs have a
     bar at a, how many, the runs) is still computed from the starts each call is given.
   - CI: `--run`'s comparison of `holes/` (every syn job but O's; the uncut run's holes go through the same
     cache); the hand examples of ③'s holes (A.1.15–A.1.19); CMP-C 7101's holes and ③ exclusions, through
     `signals/` and the blind tables.
9. **The workers** (`lawsearch-par.ts`, `lawsearch-par-worker.ts`, and the units of `lawsearch-checks.ts`; C4b
   "par").
   - Exact: a worker runs `runUnitJob`, the function `inPlace` runs, on its own structured-clone copy of the
     universe (value for value). A job's answer is a function of the universe, the task and the job alone: a worker
     keeps nothing else but the task's `UnitCache`, itself a function of those. The answers reach the check in job
     order (`done` for job q only after jobs 0 … q − 1), no unit reads another unit's work, and the main thread does
     not change the universe while a check runs.
     - (C4d, 2026-11-07; C4c's review, finding 2) "A job's answer is a function of the universe, the task and the
       job alone" holds while the modules a unit runs keep no module-level state that survives between
       `candidatesOf` calls, apart from the builds keyed by the Ind (item 3) and the holes' clock cache, a function
       of the clock alone (item 8). A worker loads its own copy of every module. So such state would live once in
       the main thread and once in each worker, and each copy would see a different sequence of series. The bytes
       could then depend on `WORKERS`. The `lawsearch-par.ts` and `lawsearch-par-worker.ts` headers say so. Nothing
       stops it by construction (12.2 (2)).
     - (C4f, 2026-11-08; the lead's H1) The universe a worker copies is the stage's snapshot, not the universe the
       main run was handed, and the task's trials and avoid table are the checks' own (item 12). A worker seals the
       task it receives (`sealTask`, item 13). The answers are unchanged: the snapshot holds the loaded values, and
       every run gave C4e's bytes (the C4f paragraph above).
   - CI: every run step runs at `WORKERS=4` and is compared with the Python (`--run`) or checked by the O and plant
     steps; hand step 8 (the refusal). No CI step compares two `WORKERS` values. (C4d, 2026-11-07) Superseded: the
     `cmp-c-7101` job now compares `lastBarStateG3` at `WORKERS=0` with its `WORKERS=4` dump, byte for byte (7.8 syn
     step 3). It is defense in depth for rule 3, not a guard by construction. (C4e, 2026-11-08) The step now
     compares the clean runs N 1001 (`w0-n-1001`), C 7101 and O 6003: stage 0's pool runs, `cut.chosen.first` and
     `cut.chosen.second` on both timeframes, and stage 1's `suspect13` checks; not stage 2's `suspect13` checks (7.8
     syn step 3). (C4f, 2026-11-08) With its compare fixed for `MODE=syn` dumps, and in `cmp-c-7101` also on the
     plant run `lastBarStateG3` (7.8 syn step 3).
   - Local: C4c's C 7101 `reasonUsesFuture` at `WORKERS` 0, 1 and 4 (77 of 77 files identical, and identical to
     C4b's); the C4c restore designer's runs at 0, 1 and 3; C4b's at 0, 1 and 2. (C4d, 2026-11-07) C4d's:
     `lastBarStateG3` at `WORKERS=0` against 4 (the yml step as extracted: exit 0, 77 files equal) and
     `reasonUsesFuture` at `WORKERS=1` against 4 (77 of 77, and equal to C4c's kept files). (C4e, 2026-11-08)
     C4e's: the new step on N 1001, C 7101 and O 6003 (exit 0; 85, 83 and 77 files equal), and on the mutants mutR,
     M (on 7e4dfcc) and M2 (exit 1; 7.8 syn step 3). (C4f, 2026-11-08) C4f's: the fixed step on N 1001, O 6003 and
     a real `MODE=syn` C 7101 dump with its plant part (exit 0), and on the mutant `w0hide` (exit 1 from its plant
     part; 7.8 syn step 3).
   - (C4g, 2026-11-10; the lead's G2) **Two pools of workers with no permission, and no unit in the main thread.**
     (7.3, 7.7; items 15 and 16.)
     - What a worker holds is still a function of the universe, the task and the jobs it was given. The answers are
       still replayed in the check's order.
     - A cut worker is fresh for its cut run and gets the jobs in T order, each with only its new bars. A probe worker
       lives for the whole run.
     - The condition above now concerns only state that one unit leaves for a later one inside a worker (12 rule 3's
       C4g bullet; 12.7, residual 2). The main run's state is in no worker.
     - CI: the same step, which now compares one worker per pool with four; and the job `plants-c4g`.
     - Local: the C4g runs of that step, and CUT_MAX=1 C 7101 at `WORKERS=0`, which equals b322c13's `WORKERS=4` dump
       (12.1's C4g paragraph).
10. **`bigmoveOf`'s σ, rewritten exactly** (`lawsearch-ind.ts`; C4d, 2026-11-07; the lead's F1 allowance).
    - What: 5.1's last bigmove bullet. The usable r are packed into `ru` in bar order, with `at[t]` counting them
      before bar t. `one(i)` is the old body for bar i on `ru`. Four bars whose windows have one count (at least
      `sigmaMinUsable`) are summed as four independent chains side by side, and every other bar goes through `one`.
    - Why it was allowed: cutting B06 on its prefix runs `bigmoveOf` (O(288 × k) per prefix) on every cut target.
      Before the rewrite, the C4d integrator measured B06's prefix at +9.32 ms per m15 stage-0 target (+2.33 ms on
      h1) at `WORKERS=4`, and N 1001's second-half chosen cut (B06 chosen) at 16.37 ms per m15 target against C4c's
      2.40 ms (12.4). The lead allowed an exact rewrite of `bigmoveOf` itself, applied to the main run and the
      checks alike, and never a cut-only shortcut. It is one function, called through `Ind.bigmove` by B06's build
      everywhere.
    - Exact: each σ[i] is the same chain of additions as before: from 0, over the same usable r, oldest first. The
      skipped r added nothing before, so leaving them out of `ru` changes no partial sum. The mean, the second chain
      (Σ (r − mean)²), the division by count − 1, the √ and the test σ > 0 are the old ones. Interleaving four
      chains changes which instruction runs when, not what any chain adds or in which order. No sum is reordered,
      split, or carried from one window to the next (2.5: floating-point addition is not associative). r and z are
      computed as before.
    - Local: the C4d integrator's equality test `c4d/tools/bmeq.ts` (log `c4d/logs/bmeq.txt`, in the C4d scratch
      folder) compared the new `bigmoveOf` with 876b9e4's bit for bit (r, usable, σ and z compared as bytes, so NaN
      payloads too). It covered the seven synthetic runs (N 1001, C 7101, FLIP 1001, O 6001–6004), both timeframes
      and five pairs, with the default params on every prefix up to k = 300, 60 evenly spaced prefixes, 30 seeded
      random ones and the prefixes around the first 20 gaps. On 12 prefixes of each series it also covered three
      other param sets (small windows; `sigmaMinUsable` = `sigmaWindow`; `sigmaMinUsable` 0), 6 poisoned copies and
      6 copies with bars deleted at random (windows of unequal counts). 38,371 calls and 270.7 million bars: 0
      differing arrays. The old function took 186.6 s and the new one 72.2 s over the test (2.58 times as fast).
      Every identity run (12.1's C4d paragraph) and the B06 hand examples (A.4.32, A.4.33, A.4.34, A.4.36, A.4.40)
      give the same outputs as before.
    - CI: the hand examples of B06; `--run`'s comparison of `ind/` (`BM_r`, `BM_ok`, `BM_sigma`, `BM_z`) and of
      `signals/` on every syn job but O's (spec 17.2 compares σ and z to relative 1e−9, so `--run` alone would not
      see a last-bit change: the bit-for-bit evidence is local).
11. **Every check series a copy** (`lawsearch-bars.ts` `copyOf`, `prefixSeries`, `windowSeries`;
    `lawsearch-checks.ts` `cutGotAt`; C4e, 2026-11-08; C4d's review, the power reviewer's P5 and the power refuter's
    q1; the lead's G1).
    - What: `prefixSeries` and `windowSeries` return a copy of the asked bars, each of the 28 typed arrays sliced into
      a memory block of its own (4.1); `cutGotAt` slices each pair's bar starts for the holes. Every other series a
      check hands to `decisionOf` was already made of fresh arrays (7.3, the units' series).
    - Exact: a typed array's `slice` copies the elements' bytes, so the copy holds the same values bit for bit at the
      same indices 0 … n − 1, with the same n. A decision can differ only where code read past n − 1 through the
      memory block. Within `research/lawsearch*.ts` the hand job's grep step finds no such read outside its
      allow-list (the one listed, `storeOf`, is a plant); the modules they import are not covered by it. The evidence
      that no decision changed is the identity runs: every identity run and every C4d plant gives C4d's bytes (the
      C4e paragraph above).
    - Power: a read through a series' memory block now sees only the series' own bars, on the cut too, so the cut sees
      a look-ahead written that way (12 rule 2; 8's `bufferReadE04`). It does not change 12.2 (2): module-level
      state is still covered only as defense in depth.
    - CI: the run plant `bufferReadE04` on CMP-C 7101 (the cut must fail on an E04 trial; with the cut prefix a view,
      on 7e4dfcc, it passes, so the plant step fails if the prefix becomes a view again); the hand job's grep step
      (7.8 hand step 9; defense in depth: it also fails if `copyOf` goes back to `subarray`, and catches a new
      `.buffer`, `byteOffset`, `ArrayBuffer` or `DataView` read in `research/lawsearch*.ts`); `--run` and the O step,
      for the unchanged outputs.
    - Local: the identity runs above; the cost of the copies (12.5).
12. **The checks' inputs from a snapshot** (`lawsearch.ts` `Guard`, `lawsearch-checks.ts` `CheckInputs`,
    `snapshotOf`, `reachOf`, `assertApart`, `lawsearch-items.ts` `trialCopyOf`; C4f, 2026-11-08; C4e's review, the
    power reviewer and refuters 1–4; the lead's H1).
    - What: 7.3's C4f bullet and 7.7's guard. Each stage's universe is snapshotted right after its load, before any
      main-run code is handed it. The checks read only the snapshot, their own trial copies and avoid table, and holes
      they make themselves. The workers get clones of the snapshot and of the checks' sealed task.
    - Exact: a structured clone copies every typed array's elements byte for byte, into a memory block of its own,
      and every other value as it is. So the snapshot holds the loaded bars, and every check decides on the same
      values as before. `trialCopyOf` copies a `TrialDef`'s fields, which are all primitives. The checks' avoid table
      is the same text parsed by the same function. Poison's holes: until C4f stage 0's poison was given the main
      run's `ExclCtx` (`ctxOfUniverse(u0, avoid, plant)`, that is `exclCtxOf(u0.<tf>, avoid, u0.fromMs, u0.toMs, null,
      plant)`), while 13's poison already made its own. Now every poison unit makes `exclCtxOf(set, task.avoid,
      u.fromMs, u.toMs, null, task.plant)` on its copy of the snapshot. That is the same function of the same bar
      starts, dates, avoid table and plant, so the holes have the same values. The evidence is that every clean run
      and every existing plant gives C4e's bytes (the C4f paragraph above).
    - Power: whatever main-run code writes into the objects it is handed never reaches a check (12 rule 2). Shown
      locally with H2 and H3 taken out (`c4f/copies/noguard`). There the three plants and the refuters' mutants were
      each caught by the cut (exit 3; 7.8 syn step 3), and `rp3by`, which passes H2, was caught on the full code.
    - CI: the identity check runs in every run step, and a `SHARED` line makes the run exit 1, which fails the step.
      The five test copies `share-u`, `share-trials`, `share-avoid`, `share-cutu` and `share-array` each exit 1 with
      their line (7.3; local only). The three plants' yml tests check H3 and H2, which stop the plants before any
      check runs. They do not show H1's power by themselves: that was shown locally, as above.
    - Not separated: module-level state (12.2 (2)).
    - (C4g, 2026-11-10; the lead's G1 and G4) Three changes.
      - All three universes are now loaded and kept at the pipeline's start, from the gate-3 bytes, before any
        main-run code (7.7). Until C4g stages 1 and 2 loaded theirs from the disk after stage 0's main-run code had
        run, so for the files "right after loading" did not mean "untouched by main-run code" (`gmoWriteR`, 8).
      - The task check before each pool run is now an allow-list (`assertTaskAllowed`, 7.3).
      - `avoidStashR3call` in the job `plants-c4g` passes H2, so it now tests H1's separation in CI. C4f's review found
        that until C4g only the identity check did.

      "Not separated" above: state outside the objects is now separated by the realms, not by H1 (12.7).
13. **Read-only definitions** (`lawsearch-items.ts` `parseCandidates`, `trialCopyOf`; `lawsearch-events.ts`
    `readOnlySet`, `avoidOf`, `exclCtxFrom`, `holesOf`; `lawsearch-checks.ts` `sealTask`; `lawsearch-par-worker.ts`;
    C4f, 2026-11-08; the lead's H2). Defense in depth; H1 is the guard.
    - What, and what each stops:
      - the frozen `TrialDef` stops field writes and added properties on a trial (`trialStashE04`, `rp4w`). It does
        not stop state kept elsewhere and keyed by the trial or its id;
      - the read-only avoid table: its own `add`, `delete` and `clear` throw (`avoidStashR3`, `rp3rs`). It does not
        stop `Set.prototype.add.call` (`rp3by`, which H1 catches);
      - the frozen `ExclCtx` and `Holes` stop the replacement of a field or list entry and added properties. They do
        not stop writes into the holes' typed arrays, which cannot be frozen;
      - `sealTask` does the same for a check run's task, in the main thread and in each worker (5.2, 5.3, 7.3).
    - Exact: freezing changes no value; it only refuses writes. No code of the program writes these objects in a way
      they now refuse: had any done so, the run would have thrown, and every clean and plant run ran through with
      C4e's bytes. `readOnlySet`
      adds its own `add`, `delete` and `clear` as non-enumerable properties of the Set, and `has` and iteration are
      unchanged.
    - CI: the plants `trialStashE04` and `avoidStashR3` on CMP-C 7101 (exit 1 with their lines, no print.txt; 7.8
      syn step 3).
    - (C4g, 2026-11-10; the lead's G4) `readOnlySet` now trusts only the Sets it made itself (a module `WeakSet`;
      5.3). The rule constants and `PRINT_KEYS` are frozen too, in every realm (item 19). All of it is kept: it costs
      nothing measurable, and it makes an accidental write fail at once.
14. **The universe digest** (`lawsearch-checks.ts` `universeDigest`, `digestDiff`; `lawsearch.ts` `Guard`, `main`;
    C4f, 2026-11-08; the lead's H3). Defense in depth; H1 is the guard.
    - What: 7.3's C4f bullet. A SHA-256 of every typed array and every other leaf value of a stage's universe,
      taken at the load and compared after the stage's main part, before every pool run (the snapshot) and at the
      stage's end. A difference stops the run: exit 6, with the dump folder removed (2.3).
    - Exact: it reads the universes and writes to stderr only. No clean or plant run of C4f met a difference, so the
      exit and the files are those of C4e (the C4f paragraph above).
    - Limits: it sees a write only if the write is still there at the next compare point. It does not watch the
      trial definitions, the avoid tables, the `ExclCtx` or module-level state. It cannot see a typed array replaced
      by another with the same values (`share-array`; the identity check sees that).
    - CI: the plant `seriesStashE04` on CMP-C 7101 (exit 6, a `CHANGED:` line naming `fileKey`, no dump folder; 7.8
      syn step 3). Local: `rp1wr` exit 6.
    - Cost: 12.6.
    - (C4g, 2026-11-10; the lead's G4) Kept, with exit 7 in place of 6 (2.3). It still adds something H1 does not: it
      sees the main run write into its own universe at any bar, while the checks see such a write only through the
      decisions it changes at their targets and probes. It costs about 2.5–2.9 s per clean C 7101 run (21 digests,
      12.8). CI: `seriesStashE04` now wants exit 7.
15. **The cut's realm** (`lawsearch-par.ts` `WorkerPool` of kind `cut`, `skeletonOf`, `growOf`, `timeOf`;
    `lawsearch-par-worker.ts` `applyGrow`; `lawsearch-checks.ts` `cutCheck` (`per = 1`) and `mismatchesOf`; C4g,
    2026-11-10; the lead's G2, from the C4g designer "process").
    - What: 7.3's C4g bullets. Every cut run gets a fresh pool. There is one target per job, the jobs are sent in T
      order, and a worker first gets the universe without bars, then with each job only the new bars up to that job's
      target. No job carries its want.
    - Exact: a cut unit still runs `cutGotAt` on the same target with the same trials.
      - The worker's series of a pair holds exactly that pair's snapshot bars with T ≤ T_k of the latest job. For the
        target's pair these are bars 0 … k.
      - `prefixSeries(s, T_k)` takes those bars, as before. The other pairs give the same bar starts with T ≤ T_k for
        the holes, as before. The higher bars are rebuilt from the prefix when a trial reads them, as before.
      - `growOf` copies each field value for value: an Int32 is exact in a double, and a NaN stays a NaN.
      - `arrayKeysOf` refuses a series field it does not know, so a field added later cannot be left out of the
        deltas unseen.
      - One target per job and the T order change which worker computes a unit, and when; they do not change what is
        computed. The answers are replayed in the check's order.
      - Fix 9.4 moves the comparison into the check's thread. `mismatchesOf` merges the two ascending lists, and a unit
        whose decision equals its want gives no mismatch, as before.

      The evidence that no value changed is the identity runs (12.1's C4g paragraph).
    - Power: rule 2 by construction for the cut (12 rule 2's C4g bullet). Two plants were missed on b322c13 and fail
      the cut here: `judgeListen2E04` (a listener keeping the universe a worker is sent) and `judgeCacheCarryE04` (a
      memo carried between units and runs) (8).
    - CI: the job `plants-c4g` (`judgeListen2E04`, `judgeCacheCarryE04` twice, `w0protoG3`), and every existing plant
      that the cut must catch (`lastBarStateG3`, `lastBarStateG5`, `carriedCountB06`, `carriedCountS01`,
      `bufferReadE04`, `reasonUsesFuture`, `chosenCutFirstDiff`, `chosenCutSecondDiff`).
    - Local: the identity runs. The C4g designer "process" compared 395,071 cut decisions of this regime with the old
      one in its prototype and found them identical (`c4g/design-process/`).
    - Cost: 12.8 (spawns about 0.2 s, the T sort about 0.4–0.5 s and the deltas about 2.1–2.6 s per clean C 7101 run).
16. **The probe pool** (`lawsearch-par.ts` `WorkerPool` of kind `probe`, `shipOf`; C4g; the lead's G2).
    - What: one pool for poison and presence, made at their first run and kept for the whole run, never given a cut
      task. Its workers get the whole snapshot at each run, as before. Its jobs carry no want either (fix 9.4).
    - Exact: as item 9. The units, their inputs and their replay are those of C4f.
    - Power: poison and presence catch naive look-ahead only (12 rule 2's C4g bullet). State that one of their units
      leaves can reach a later one in the same worker (12.7, residual 2; measured with `judgeCacheCarryE04`).
    - Why kept, not fresh: the C4g cost-risk judge measured a fresh pool per check run at 19–27 % slower m15 presence,
      and a fresh pool would not stop the carry within one run anyway. The lead chose to keep it.
    - CI: the O step (the poison must fail on the E26 trials); `bufferReadE04` and `reasonUsesFuture` (presence). The job
      `plants-c4g` prints `judgeListen2E04`'s poison and presence rows for information only.
17. **The follow-bar checks' realm** (`lawsearch.ts` `followInWorker`; `lawsearch-follow-worker.ts`;
    `lawsearch-trade.ts` `followRowsOf`, `followValues`, `followCompare`; C4g; the lead's G2).
    - What: 6.1's C4g bullet. A worker with no permission is started for each call, and gets the snapshot's timeframe
      and the rows' coordinates only. The main thread compares.
    - Exact: `followValues` is the old loop's body: the same windows (`windowSeries` copies) of the same snapshot's
      bars, the same poisoning and the same `valuesAt`. `followCompare` is the old comparison, in the same order and
      with the same strings. Every dump is byte-equal.
    - Power: `lenmemoEntryEarly` (a memo filled by the main run's trades): follow (i) changes on every row here, and
      changed on none on b322c13 (8).
    - CI: the job `plants-c4g` (`lenmemoEntryEarly`).
    - Cost: the four calls take 112–134 s per C 7101 run in all, but stages 1 and 2 were not slower in either same-day
      pair (12.8).
18. **The gate-3 bytes and the environment's revoke** (`lawsearch-gen.ts` `treeBytes`; `lawsearch.ts`
    `readSettings`, `readOf`, `memSourceOf` and the loads at the start; `lawsearch-bars.ts` and trend-data's `readFile`
    through `src.read`; `retraceCheck(read, …)`; C4g; the lead's G1, from the C4g designer "harden").
    - What: 7.7 (the other environment variables, gate 3, the pipeline's start).
    - Exact:
      - The bytes read are the bytes the gate hashes and compares with the manifest.
      - `readOf` decodes them as `Deno.readTextFile` decodes a file: UTF-8, invalid sequences replaced, a BOM kept
        (`ignoreBOM`). The C4g designer "harden" checked that on ten edge cases.
      - A path that is not among them is `NotFound`, as a missing file is.
      - The loads of stages 1 and 2 come earlier now, but they read the same bytes with the same arguments.
      - The settings are the same values, read earlier.

      The evidence is the identity runs.
    - Power: `gmoWriteR` (the file channel) and `rp2EnvE04` (the environment), both missed on b322c13 (8).
    - CI: the job `plants-c4g`; hand steps 7 and 8 (the refusals, whose order and text are unchanged).
19. **The lockdown, the frozen constants and the V8 flag** (`lawsearch-lockdown.ts`, `lawsearch-frozen.ts`; the yml's
    `--v8-flags`; C4g; the lead's G3).
    - What: 12.7 G3.
    - Exact:
      - No computation of the program reads a name the lockdown deletes (none used them).
      - No code writes a frozen constant: a write would throw, and no run threw.
      - The source audit finds no `eval` or `Function` in the program's realms.
      - No intrinsic is frozen, so no V8 fast path is lost.
    - Power: `judgeCacheCarryE04` run 2. CacheStorage had carried run 1's memo into run 2's cut on b322c13, and here it
      is deleted. Against the rest, which is deliberate concealment, it is a cheap defense only (12.7).
    - CI: the job `plants-c4g`; hand step 10 (each entry imports the lockdown and the frozen constants first).
20. **The static audits** (`lawsearch-audit.ts`; the yml's hand steps 10–12; C4g; the lead's G3). These are defense in
    depth, not guards by construction: the realms' module graphs, the source rule and the audited catches (7.8). Their
    negative tests each failed their step; on the final code they pass.
    - (C4h, 2026-11-11; F4, F5) The graph audit counts re-exports among an entry's first module requests; hand step 13
      (`trigger`) and the workflow `lawsearch-audit.yml` run the audits when a shared module changes (12.9).
21. **The sandbox test of the checks' workers** (`lawsearch-sandbox.ts`; `lawsearch-par.ts` and `lawsearch.ts` send
    the main thread's grants; `lawsearch-par-worker.ts` and `lawsearch-follow-worker.ts` test them; C4h, 2026-11-11; the
    lead's F2).
    - What: a worker that holds any of the main thread's grants (read and write on `.`, the run folder and the dump
      folder, and every path-less name, that read "granted" in the main thread) refuses to serve; the run stops (exit 1).
    - Exact: it computes nothing; it adds a list of plain descriptors to the first message of each worker. Every dump is
      byte-equal (12.9).
    - Power: fail closed for "none" under the program's real flags (C4g's test was not; 12.9 F2's mutated copies).
    - Cost: about 35–55 µs for `grantsHeld` once per run and about 37 µs per `refusalOf` call (one per worker per pool
      run, about 20–30 per run), measured beside two heavy runs (`c4h/f2/bench.txt`): nothing a whole run can show.
22. **A copy of the avoid table per poison and presence unit** (`lawsearch-checks.ts` `unitAvoidOf`, `runUnitJob`;
    C4h, 2026-11-11; the lead's F3).
    - What: 7.3's C4h bullet. Each such unit reads and writes only its own read-only copy.
    - Exact: the copy holds the task's entries; a unit that does not write its avoid table decides as before. Every
      clean dump is byte-equal; `avoidStashR3call`'s presence rows halve (8).
    - Power: closes the avoid-table route of 12.7 residual 2 (measured); the other task-level objects are tabled in
      12.9 F3.
    - Cost: the paired timer shows nothing (12.9 F3).
23. **The main realm's freeze** (`lawsearch-lockdown.ts`; the yml's hand step 14; C4h, 2026-11-11; the lead's F7;
    outside T).
    - What: `Worker.prototype` and `EventTarget.prototype` frozen and `globalThis.Worker` pinned in the main realm only.
    - Exact: no computation reads them. Every dump is byte-equal (12.9).
    - Power: the two relay plants that hid the cut on C4g's code stop with a `TypeError` (12.9 F7); other built-ins stay
      open (12.7 residual 10).
    - Cost: 12.9's same-day sets of whole C 7101 runs.

### 12.2 Open points for the lead (C4c, 2026-11-07)

These are not regressions: they are the same in b3a2c43 and in both of C4c's designs.

1. **The reason at bar k.** `decisionOf` takes spec 6's reason of an emitted row at k from `reasonOf` at bar k
   alone, as b3a2c43 did. The main run gets it from `classify`, which calls `reasonOf` row by row. That is the same
   function at the same bar, but not the same loop: it is equal by construction only while `classify` stays a
   per-row map of `reasonOf`. (`reasonOf`'s signature gives it nothing of other rows; `rowsAtBar` was given the rows,
   which is how C4b's finding came about.) Running `classify` over every row of the walk in `decisionOf` was measured
   by the C4c restore designer at 0.80–0.94 s per m15 stand-in cut target (one thread, on a busy machine), against
   about 0.28 s for the walk and the builds: about 3 times the whole cost per target. So it was not taken. A cheaper
   exact route (a cheaper `reasonOf`, or a memo of its clock parts) was not built.
   - (C4d, 2026-11-07; the lead's decision) It stays as it is, a documented residual. Why it holds today:
     `reasonOf(ctx, s, i, warmOk)` is given no rows and no state. It reads the bar's T and the start of bar
     max(0, i − 9), the pair, `warmOk` and its `ExclCtx` (the holes, the avoid table, stage 3's dates, the plant),
     and it keeps nothing from one call to the next. `classify` calls it once for each emitted row, with that row's
     bar and `warmOk`, and gives a `f_none` or `both` row its status as its reason; `decisionOf` does the same for
     the rows at k. So the two give the same reason row by row. It rests on two things that the code does not
     enforce: `classify` stays a per-row map of `reasonOf`, and `reasonOf` keeps taking no rows and keeping no
     state. 7.3's Cut bullet and 12 rule 2 point here.
   - (C4f, 2026-11-08; C4e's review, the power reviewer's `avoidStashR3` and refuter 3's `rs-wt`; the lead's H1, H2 and
     H9) The second premise was broken in exactly this way, and the cut could not see it. `reasonOf` kept ③'s
     look-ahead answer in its `ExclCtx`'s avoid table, the Set every check unit shared with the main run, so each
     check's reason at bar k was the main run's (8's `avoidStashR3` on fcce9e6: exit 0, every check passed). Since C4f
     two things hold:
     - Whatever `reasonOf` keeps in its `ExclCtx` or avoid table stays on its own side. The checks' `ExclCtx` and
       avoid table are their own (H1; 7.3's C4f bullet), so the main run's state never reaches a check's reason. With
       H2 taken out, the cut and presence catch `avoidStashR3` (7.8 syn step 3).
     - It cannot keep state there through the objects' own means. The `ExclCtx` and `Holes` are frozen, and the avoid
       table's own `add`, `delete` and `clear` throw (H2; 5.3).

     Still not enforced: state kept in a module (12.2 (2)), state written with `Set.prototype.add.call` into a
     check's own avoid table, and state in the holes' typed arrays, each within one side and one thread. The first
     premise, that `classify` stays a per-row map of `reasonOf`, is unchanged. It stays a documented residual.
   - (C4g, 2026-11-10; the lead's G2 and G5) Of the three ways still "not enforced" above:
     - State kept in a module now stays within one realm. A check's `reasonOf` runs only in a worker in which no
       main-run code ran: a cut worker fresh for its cut run, or the kept probe pool (12.2 (2)'s C4g bullet).
     - Writes with `Set.prototype.add.call` now have a run plant in CI: `avoidStashR3call` (8). The main run's entries
       land in the main run's table, which the checks never read (H1), so the cut and presence fail. Inside a check's
       own table such a write keeps only that check's own answers, on one side and in one realm. That is still not
       enforced, but it can carry no main-run answer.
       - (C4h, 2026-11-11; the lead's F3) It could carry one check unit's answer to a later unit, though: half of
         `avoidStashR3call`'s presence failures were variant (ii) reading variant (i)'s entry (8). Since C4h each
         poison and presence unit writes only into its own copy (7.3 `unitAvoidOf`); the cut's units share their task's
         table, which in T order holds entries made from bars at or before the current target only (12.9 F3).
     - The holes' typed arrays are unchanged.

     The first premise is unchanged.
2. **Caches must stay keyed by the Ind.** The builds, `prepare` and any item-level cache must be functions of the
   Ind, that is of its series. `BUILDS` is a WeakMap keyed by the Ind, which is right today. A module-level cache or
   variable that survives from one `candidatesOf` call to the next (for example one keyed by pair, trial or bar
   instead of by the Ind, or a per-bar state kept at module level) would carry the full series into the cut, poison
   and presence checks unseen. Nothing stops that by construction now; the O step would catch it only where it
   touches `answerKnowingE26`'s build. C4c's design B (a restricted form for the per-bar code, checked by a new
   program before every run) would have stopped module state inside the per-bar code; it was not taken, because its
   guarantee rested on that new trusted checker. A later round may add a guard.
   - (C4d, 2026-11-07; C4c's review, finding 2) **Such state can also make the bytes depend on `WORKERS`.** It
     lives once in the main thread and once in each worker (each worker loads its own copy of the modules), and
     each copy sees a different sequence of series. So a unit's answer is no longer a function of its job alone,
     and 12 rule 3 fails too. C4c refuter 2 showed it on C 7101:
     - Mutant M is a module-level memo of `candidatesOf`, keyed by the series' buffer, its byte offset, the trial
       and the options. A cut prefix is a view of the uncut series, so it shares that buffer and offset. With M and
       the G3 look-ahead always on (no plant flag), `WORKERS=0` gave exit 0 with every file as the clean run's: the
       look-ahead was invisible. `WORKERS=4` gave exit 3 with about 75,400 noise rows in cut_fail.csv. b3a2c43 with
       the same memo gave exit 0.
       - (C4e, 2026-11-08) Since C4e a cut prefix is a copy with a memory block of its own (12.1 item 11), so it no
         longer shares that key: M added to C4e's code is inert (`WORKERS=4` exit 0, every file as the clean run's).
         That closes M's key, not the residual: mutant M2, the same memo keyed by the series' pair and timeframe,
         the trial and the options, gives every series of one pair and timeframe one key, copies included. On C4e's
         code M2 gave `WORKERS=0` exit 0 (the main thread's memo holds the main run's rows and hides every check)
         and `WORKERS=4` exit 3 (all 36 cut, poison and presence rows of stage 0 failed: each worker's memo holds
         stale rows).
     - Mutant B changes only the loop's body and adds module-level state (the longest n seen per trial and pair,
       read as "the last bar"). It was silent at `WORKERS=0` (exit 0, every file as the clean run's) and caught at
       `WORKERS=4` (exit 3, the plant's 461 rows).
   - (C4d, 2026-11-07; the lead's decision) It stays a documented residual. It is covered only as defense in depth,
     never by construction:
     - the O step, where such state touches `answerKnowingE26`'s build (12.1 item 3);
     - the yml's step that compares `lastBarStateG3` at `WORKERS=0` with its `WORKERS=4` dump byte for byte (7.8 syn
       step 3). With M added to C4d's code, that step fails (exit 1): the `WORKERS=0` run exits 0 and the
       `WORKERS=4` run exits 3.
       - (C4e, 2026-11-08; the lead's G2) Now the step compares the clean runs CMP-N 1001, CMP-C 7101 and O 6003,
         which run the pool for stage 0's checks, `cut.chosen.first`, `cut.chosen.second` and stage 1's `suspect13`
         checks; stage 2's `suspect13` checks are reached by no synthetic run (7.8 syn step 3). It fails on C4d's
         ci-docs refuter 2's mutant (state read only by one-trial cut jobs, which the `lastBarStateG3` step missed),
         on M on 7e4dfcc and on M2 on C4e's code, and passes on C4e's code.
     - Refuter 2's caveat: in both mutants the clean CMP-C 7101 run at `WORKERS=4` already exits 3 (noise rows, or
       the plant's rows). CI caught them that way before the new step, but only as a side effect of how jobs reach
       the workers. The new step compares the two values directly. It still sees such state only where it changes
       that one run's bytes. (C4e, 2026-11-08) These three runs' bytes now.
   - (C4f, 2026-11-08; C4e's review; the lead's H1, H6 and H9) **Module-level state is now the one channel from the
     main run to a check that is left open.** (C4g, 2026-11-10: this bullet was wrong, and the C4g bullet below
     corrects it.) H1 closes the others by construction (7.3's C4f bullet). The universe's
     arrays, the trial definitions, the avoid table and the `ExclCtx` that a check reads are no longer the main run's
     objects, nor copies made from them after the main run had them. Module state is different. At `WORKERS=0` the
     units run in the main thread's own module instances, so state that the main run's code keeps in a module is
     there when the checks run. At `WORKERS=4` each worker has module instances of its own, which the main run never
     touches.
     - What such state can be (the C4f integrator's audit): in `lawsearch-events.ts`, `BUILDS` (a WeakMap keyed by
       the Ind, and a check's Ind is never a main-run Ind) and `CLOCK` (clock-only blocks, `Uint8Array`s that code
       could write). In `lawsearch-items.ts`, the definitions `ITEMS` and `FILTERS`. In `lawsearch-checks.ts`,
       `TABLES` (a WeakMap keyed by the task's `UnitCache`). Then the rules' constant arrays, which are plain arrays
       and writable. Neither the identity check nor the digest walks module state.
     - It is now concrete. The test mutant `w0hide` (7.8 syn step 3) keeps the first n seen per trial and pair in
       a module-level Map and turns `lastBarStateG3` off on every shorter series. At `WORKERS=0` the main run's full
       series come first, so every cut prefix gets the main run's decision: exit 0, every check passed, stage 2
       opened. At `WORKERS=4` the cut catches the plant (exit 3, the same files as the clean code's plant run).
     - Covered only as defense in depth. The `WORKERS=0` step's clean runs give the same bytes at both settings
       when the state only hides a look-ahead, because a clean run has nothing to hide. Its plant run (`lastBarStateG3`
       at `WORKERS=0` against 4, new in C4f) caught `w0hide`. It covers that one plant's path (E04, E26 and B06's last
       bar), not a hidden look-ahead elsewhere. The O step catches such state only where it touches
       `answerKnowingE26`'s build.
     - The mutants mutR, M and M2 above make the job's run fail at `WORKERS=4` (exit 3 on clean C 7101), so in CI
       they fail the job's "TS (MODE=syn)" step first. The step's own failure on them was shown by hand (7.8 syn
       step 3).
     - It stays a documented residual, as the lead decided in C4d. A guard for module state (for example running the
       checks of a `WORKERS=0` run in a fresh module instance, or forbidding module-level `let`, `Map` and `Set` in
       the modules a unit loads) was not built in C4f. The 40 E items still to be built will run through this code.
   - (C4g, 2026-11-10; the lead's T and G1–G4; C4f's review: the power reviewer's channels (1)–(4) and the ci-docs
     reviewer's restatement, each reproduced by a refuter; the C4g judges' channel (5)) **Corrected and narrowed.**
     - The C4f bullet above was wrong in three ways:
       - Module-level state was not the one channel left. The residual is state not held in an object handed to the
         code. That covers module bindings, realm globals (`globalThis` properties, built-in prototype expandos) and
         process-global state (the environment, files, Web storage, CacheStorage, locks, signals).
       - It did not reach the checks only at `WORKERS=0`. Several checks ran in the main thread at every `WORKERS`
         (`followBarChecks` and the main-thread parts of the others), and the workers shared the process's environment
         and files.
       - The suggested guard, forbidding module-level `let`, `Map` and `Set`, would not have covered realm globals or
         process-global state.
     - What C4g closes, and how (12.7 has the details and the evidence):
       - **Files**: closed for every load and every check. Gate 3 reads the gmo files once, and nothing reads them from
         the disk again (`gmoWriteR` shows it for the loads; for the retrace it rests on the code).
       - **The environment**: closed. It is read once, then revoked before any worker exists (`rp2EnvE04`). (C4h,
         2026-11-11: the revoke closes it for the main thread; the checks' workers never hold it because they are
         started with "none", whatever the order, and since C4h they test that at run time, 12.9 F2.)
       - **Module bindings and realm globals of the main run**: closed for every unit and for the follow-bar checks at
         every `WORKERS`. They run in workers in which no main-run code ever ran (`lenmemoEntryEarly`, `w0protoG3`).
         The checks left in the main thread compare plain data or run check-only code (12.7's table).
       - **Process-global Web APIs** (BroadcastChannel, CacheStorage, Web storage, navigator with its locks, signals,
         `process`, `Deno[Deno.internal]`): deleted in every realm by the lockdown (`judgeCacheCarryE04`).
       - **State left in long-lived workers**: closed for the cut, whose pool is fresh for each cut run and holds no bar
         after its target (`judgeCacheCarryE04`, `judgeListen2E04`). It stays open for poison and presence, within one
         run, in the kept probe pool (12.7, residual 2).
     - What remains of this point is therefore small. It is state that one poison or presence unit leaves for a later
       one in the same worker of the same run, plus whatever shared channel Deno has that the lockdown does not delete
       (12.7, residuals 2 and 4). Its effect on rule 3 is that poison's and presence's bytes can depend on `WORKERS`
       and on timing when the code keeps such state (measured, 12.7). Clean code is unaffected.
     - (C4h, 2026-11-11; C4g's review, the power reviewer, reproduced by a refuter; the lead's F3) **The framing above
       ("state not held in an object handed to the code") left out a route: the task object a worker is handed.** A
       check run's task (its trials, its avoid table, `answerKnowing`, the plant) is one object per worker, read by
       every unit of that run there, and its avoid table could be written through `Set.prototype.add.call` past
       `readOnlySet`. That was measured as carry: half of `avoidStashR3call`'s presence failures (8). C4h gives each
       poison and presence unit its own read-only copy of the table, so that route is closed (7.3 `unitAvoidOf`). The
       other task-level objects a probe worker's units share are tabled in 12.9 F3, with which can still carry: the
       cached `ExclCtx`'s holes (typed arrays, writable), the poison tables, and the universe `u` (typed arrays,
       writable) can; the frozen task, trial list and trials cannot.
     - The 40 E items will run through this code. For the cut they can keep any state without hiding a look-ahead.
       For poison and presence, state kept across units can still hide a naive one, but never from the cut.
3. **To confirm:** the plant names `lastBarStateG3` and `lastBarStateG5` (8; the names of both C4c designers), and
   this round's text: 3, 5.1–5.3, 7.3, 7.7, 7.8 and 8, 11 O-13, and 12 (rule 2 and 12.1–12.3).
   - (C4d, 2026-11-07) The lead confirmed the two names and decided (1) and (2) above, and 4 below, in C4d's task.
     C4d's own points for the lead: 11 O-14.
4. (C4d, 2026-11-07; the lead's decision) **The poison tables have no CI step of their own** (12.1 item 6). No CI
   step compares a poisoned series made with the tables with one made without them (`checks.csv` is TS only and not
   compared). It stays a documented gap. What covers them: the O step (the poison must fail on the four E26 trials)
   and, locally, the identity runs (`checks.csv` byte-identical to C3's, which were made without tables; C4c's and
   C4d's runs).

### 12.3 What the restore costs (C4c, 2026-11-07)

- Measured: whole runs at `WORKERS=4`, each with no other heavy process on this machine (4 CPUs, 15 GB RAM), against
  C4b's code (`time.total` from print.txt): 1.10–1.23 times as long. N 1001 556 s against 504 s; C 7101 291 against
  252; FLIP 1001 572 against 504; O 6001–6004 330–414 against 269–354. Summed over the runs with a C4b counterpart,
  3,555 s against 3,050 s (1.165 times).
  - The extra is mostly stage 0's cut, which now walks every bar up to each target for every trial: `cut.m15`
    1.25–1.37 times, `cut.h1` 1.18–1.35 times; the chosen cuts 1.04–1.17 times.
  - C3's code was 7–14 times slower than either. Peak RSS was 2.9–3.4 GB.
- Estimated: one step-4 run (682 trials per timeframe) at `WORKERS=4`, by C4b's timer method (the C4c integrator's
  `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c4c/estimate.txt`):
  3.51 h at the stand-ins' target count (m15 120,385 and h1 47,908 targets), up to 8.79 h if every bar were a target
  (372,320 and 93,080).
  - Parts: stage 0's cut 2.63–7.86 h, poison and presence 0.69 h, the chosen cuts 0.09–0.14 h, the rest 0.11 h.
  - By the same method, C4b's code gave 2.68–6.42 h. At `WORKERS=1`, C4c's code gives 11.2–29.5 h (the restore
    designer's measurements).
  - These hours are arithmetic: measured costs (per target, per trial and per chosen target, each on an idle
    machine, with C4b's harness unchanged) times measured counts. The items are stand-ins, because the 40 E items
    are not built yet. The walk part does not depend on the items: with 682 trials that share their builds, a target
    costs 20.4 ms on m15 and 5.6 ms on h1, against 2.6 and 1.0 ms on C4b's code, and the difference is the walks.
    The build part was measured on stand-ins only. It is not a measured step-4 run.
- The lead's preference: power by construction first, then speed; the restore if one step-4 run stays within about
  6 hours at `WORKERS=4` at the stand-in target count. At 3.5 h it does. If every bar were a target, it would not fit
  one 6-hour job.
- (C4d, 2026-11-07) C4d's code costs more, because B06 is now cut on its prefix (12.4). The lead's condition is
  still met at the stand-in target count, with less room: 12.4's verdict.

### 12.4 What cutting B06 on its prefix costs (C4d, 2026-11-07)

C4d drops B06's 291-bar window (7.3; the lead's F1), so every cut of B06 walks its prefix from bar 0, and
`bigmoveOf`, which costs O(288 × k) on a prefix of k bars, runs on every cut target. The lead allowed an exact
rewrite of `bigmoveOf` for the main run and the checks alike if that cost mattered for step 4 (5.1, 12.1 item 10).
The C4d integrator found that it did, and made one. The numbers below are the C4d integrator's, in the C4d scratch
folder (`c4d/timing.txt`, `c4d/estimate.py`, `c4d/estimate.txt`), on this machine (4 CPUs, 15 GB RAM).

- **Measured: whole runs** at `WORKERS=4`, one at a time, with no other heavy process (`time.total` from
  print.txt), against C4c's runs (12.3):
  - Every run that reaches the cut took 1.34–2.79 times as long. N 1001 1,550 s against 556 s; C 7101 433 against
    291; FLIP 1001 1,498 against 572; O 6001–6004 489–574 against 330–414; the C 7101 plants 343–352 against
    206–212 (`carriedCountB06`, new, 358 s). Summed over the 14 runs with a C4c counterpart (the two short N
    plants included), 7,351 s against 3,971 s (1.85 times).
  - The extra is B06 walked on every cut prefix. Stage 0's `cut.m15` took 2.19–2.45 times as long (209–244 s
    against 89–106 s), and `cut.h1` 2.44–2.74 times. Where B06 is a chosen trial (N 1001 on both timeframes,
    FLIP 1001 on m15, O 6001 on h1), the chosen cuts took 3.4–3.9 times as long on m15 (N 1001: 286 s first half,
    778 s second) and 20–47 times on h1 (15–43 s, where B06 is the only chosen trial). Stages with no B06 work
    took about 1.0 times as long.
  - One thread: `lastBarStateG3` at `WORKERS=0` (the yml step's run) took 1,051 s, and `reasonUsesFuture` at
    `WORKERS=1` 1,012 s. C4c's 491 s and 483 s for its `WORKERS=0` and 1 runs were measured as a pair, under load,
    so they are not compared here.
- **Measured: per target**, by C4b's timing harness (unchanged), at `WORKERS=4`:
  - The stage-0 cut of the 6 built trials per timeframe on today's targets (mean k 37,241 on m15): m15 8.30 ms per
    target against C4c's 3.36 ms, so B06's prefix adds 4.94 ms (9.32 ms before the `bigmoveOf` rewrite); h1 1.99
    against 0.84 ms, so 1.15 ms (2.33 before).
  - The 682 stand-in trials' cut (the real B06 among them; the other B items are cheap stand-ins): m15 75.4 ms
    against 71.1 ms, h1 18.6 against 18.0 ms (means of 3 and 2 repeats; the noise is about ±3 ms).
  - The chosen cuts: B06 adds, over one (E, F) trial, 2.29 ms (first half) and 6.55 ms (second half) per m15
    target, and 0.37 and 1.01 ms per h1 target.
  - `bigmoveOf` alone is 2.58 times as fast as before (12.1 item 10).
- **Estimated: one step-4 run** (682 trials per timeframe) at `WORKERS=4`, by C4b's method: the measured costs per
  target, per trial and per chosen target, times measured counts. Low is the stand-ins' target count (m15 120,385
  and h1 47,908 targets); high is every bar a target (372,320 and 93,080).

  | code | low | high | parts (stage-0 cut; poison and presence; chosen cuts; the rest) |
  |---|---|---|---|
  | C4d (B06 on its prefix, `bigmoveOf` rewritten) | 3.64 h | 9.39 h | 2.77–8.28 h; 0.67 h; 0.10–0.34 h; 0.11 h |
  | C4d before the rewrite | 3.73 h | 10.04 h | 2.91–8.67 h; 0.63 h; 0.09–0.63 h; 0.11 h |
  | C4c (B06 on its window; the C4d integrator's repeats) | 3.50 h | 8.75 h | 2.62–7.82 h; 0.69 h; 0.09–0.14 h; 0.11 h |
  | C4d, if all 11 finite B items cost what B06 costs (below) | 5.44 h | 15.34 h | 4.57–13.68 h; 0.67 h; 0.10–0.88 h; 0.11 h |
  | the same, before the rewrite | 7.16 h | 21.40 h | 6.33–18.91 h; 0.63 h; 0.09–1.75 h; 0.11 h |

  - The finite items. By the C4d integrator's count from docs §8.113 18, 11 of step 4's 18 B items are typed 有限
    there: B01 td9, B03 double7, B04 cci, B06 bigmove, B08 linreg, B11 ttm, B13 vr, B14 hurst, B16 demarker,
    B17 psych and B18 kairi. The other 7 B items, and the E items taken from §8.113 (E26/E27, E42, E44), are typed
    S0 から続けて. The spec's own E and F items carry no such type. Only B06 is built. Until C4d such an item could
    have been given its own window (C4c's `FINITE_BARS`). Now each one is cut on its prefix, as every item is.
  - The finite rows of the table assume that each of the other 10 adds B06's measured prefix cost per stage-0
    target (4.94 ms on m15, 1.15 ms on h1), and that up to 3 finite items per timeframe are chosen, each at B06's
    chosen-cut cost. This is an assumption, not a measurement: the items with long windows (vr with 1,008 values,
    hurst with 256 values over 6 scales, kairi's rank of 500 values) may cost more per bar than B06, and the short
    ones less.
  - These hours are arithmetic, not a measured step-4 run. The items are stand-ins, because the 40 E items are not
    built yet (as in 12.3).
- **Verdict** (the C4d integrator's, from the table): one step-4 run at `WORKERS=4` at the stand-in target count
  fits the 6-hour job: 3.64 h with B06 the only finite item built, and 5.44 h if all 11 finite items cost what B06
  costs, which is close to the limit. If every bar were a target it would not fit (9.4–15.3 h). Without the
  `bigmoveOf` rewrite the finite case would not fit even at the stand-in count (7.16 h).
- CI (not measured on GitHub): the `cmp-c-7101` job gains one plant run (`carriedCountB06`, 358 s locally) and the
  `WORKERS=0` step (about 1,050 s locally), and every syn job's TS run is longer as above (N 1001's TS run alone was
  1,550 s). The syn job's timeout is 360 minutes. (C4e, 2026-11-08: superseded by 12.5's CI times.)

### 12.5 What the copies cost, step 4 and the CI time (C4e, 2026-11-08)

C4e makes every check series a copy (12.1 item 11), adds two run plants to `cmp-c-7101` (8) and moves the
`WORKERS=0` comparison to three clean runs, one of them in a new job (7.8 syn step 3). The numbers below are the C4e
integrator's, in the C4e scratch folder (`c4e/timing.txt` from `c4e/timing.py`, `c4e/estimate.py` and
`c4e/estimate.txt`), on this machine (4 CPUs, 15 GB RAM). The machine restarted at 06:41 and 10:40 UTC that day and
ran slower after 06:41: 7e4dfcc itself took 497 s on clean C 7101 that day, against C4d's 433 s on C4d's day. So the
same-day pairs below are the fair comparison, and the ratios against C4d's own runs include the slower day.

- **Measured: whole runs** at `WORKERS=4`, one heavy process at a time (no other heavy process, but a brief other
  one during N 1001 and during 7e4dfcc's `carriedCountS01` run), `time.total` from print.txt:
  - Same day, one after the other, clean C 7101: C4e's code 542 s against 7e4dfcc's 497 s (1.09 times). By stage:
    `cut.m15` 1.07, `cut.h1` 1.09 and stage 0 1.07 times; stage 2 1.12 times. The one-trial chosen cuts on h1 took
    1.62 times (`cut.chosen.first.h1`, 7.6 s against 4.7 s) and 1.38 times (`cut.chosen.second.h1`, 18.8 s against
    13.7 s): there the copy of the prefix is most of the work, because one cheap trial is cut.
  - Against C4d's own runs (C4d's day): the 18 `WORKERS=4` runs with a C4d counterpart took 9,218 s against 7,710 s
    (1.20 times). N 1001 1,892 s against 1,550 s (1.22); C 7101 471 s against 433 s (1.09; run before the first
    restart); FLIP 1001 1,841 s against 1,498 s (1.23); O 6001–6004 1.19–1.24 times (O 6003 and 6004's chosen m15
    cut 1.42–1.43 times); the C 7101 plants 1.13–1.16 times. The new plants: `carriedCountS01` 344 s and
    `bufferReadE04` 379 s.
  - One thread (`WORKERS=0`, the yml step's runs): C 7101 1,384 s (C4d's `lastBarStateG3` at `WORKERS=0`: 1,051 s),
    O 6003 2,226 s, N 1001 6,665 s (stage 2 3,952 s, of which `cut.chosen.second.m15` 3,668 s).
  - Peak RSS 2.9–3.5 GB for each run that reaches the checks.
- **Measured: the copy per target**, by C4b's timer harness unchanged, C4e's code and 7e4dfcc alternated on the idle
  machine the same day, on the same targets, with the same result sha256s (22 jobs, none disturbed):
  - stage 0's cut of the 6 built trials: m15 +1.68 ms per target (9.82 against 8.13 ms) and, with 682 stand-in
    trials sharing the target, +1.33 ms (25.13 against 23.80 ms), at mean k 37,241; h1 +0.22 ms (2.35 against 2.13)
    and +0.49 ms (7.07 against 6.58);
  - the 682 stand-ins' cut: m15 +2.95 ms (81.0 against 78.1 ms; 7e4dfcc's two repeats were 76.0 and 80.1 ms, so the
    noise is about ±2 ms); h1 +1.02 ms (19.85 against 18.83 ms);
  - the chosen m15 cut of the second half: +1.1 to +1.35 ms per target.
  - These agree with the C4d power reviewer's measurement of the copy, about 1.16 ms per m15 target (one thread, on
    a shared machine).
- **Estimated: one step-4 run** (682 trials per timeframe) at `WORKERS=4`, by C4b's method as in 12.3 and 12.4: the
  measured costs per target, per trial and per chosen target from the C4e timer runs, times measured counts; the
  rest of the run from C4e's N 1001 run. Low is the stand-ins' target count (m15 120,385 and h1 47,908 targets);
  high is every bar a target (372,320 and 93,080).

  | code | low | high | parts (stage-0 cut; poison and presence; chosen cuts; the rest) |
  |---|---|---|---|
  | C4e (every check series a copy) | 3.95 h | 10.14 h | 2.97–8.89 h; 0.71 h; 0.15–0.42 h; 0.12 h |
  | C4e, if all 11 finite B items cost what B06 costs (12.4) | 5.76 h | 16.13 h | 4.78–14.30 h; 0.71 h; 0.15–1.00 h; 0.12 h |
  | C4d, measured on C4d's day (12.4) | 3.64 h | 9.39 h | 2.77–8.28 h; 0.67 h; 0.10–0.34 h; 0.11 h |
  | C4d, finite, on C4d's day (12.4) | 5.44 h | 15.34 h | 4.57–13.68 h; 0.67 h; 0.10–0.88 h; 0.11 h |

  - The copy itself adds about 0.11 h at the low count (2.95 ms × 120,385 + 1.02 ms × 47,908 = about 404 s) and
    about 0.33 h at the high count. The rest of the rise from C4d's figures is the slower day: 7e4dfcc's own
    stand-ins took 78.1 ms per m15 target that day against 75.4 ms on C4d's day, and the probes (poison and
    presence, which the copies do not touch) were 4–15% slower.
  - The finite rows rest on 12.4's assumption (B06's measured prefix cost for each of the other 10 finite items),
    not on a measurement. These hours are arithmetic, not a measured step-4 run, and the items are stand-ins.
- **Verdict** (the C4e integrator's, from the table): one step-4 run at `WORKERS=4` fits the 6-hour job at the
  stand-in target count: 3.95 h with B06 the only finite item built, and 5.76 h if all 11 finite items cost what B06
  costs, inside 6 h but at the limit (0.24 h to spare, on a slow day). If every bar were a target it would not fit
  (10.1–16.1 h).
- **CI time.** (C4f, 2026-11-08: superseded by 12.6's CI times.) Local seconds on this 4-CPU VM that day, at
  `WORKERS=4` unless named. GitHub was NOT measured:
  `lawsearch.yml` has never run on GitHub (every commit that touches it is `[skip ci]`, and the workflow is not
  registered). The repository is public, so by GitHub's documentation `ubuntu-latest` has 4 vCPUs and 16 GB; that
  was not checked. `MODE=syn`'s generation time is not included (not measured here). The Python `--run` times are
  the C4d comparer's local 148–200 s.

  | job | local, about | made of |
  |---|---|---|
  | `hand` | well under 5 min | the grep step under 1 s; the hand-plant step 13–15 s; `MODE=hand` and the 21 hand plants 6–8 s; `deno check` about 30 s |
  | `cmp-n-1001` | 4,500 s (1.25 h) | TS 1,923 s; Python ~190 s; the plants 2 + 1,919 + 16 + 430 s (its `WORKERS=0` step is no longer here) |
  | `w0-n-1001` (new) | 8,600 s (2.4 h) | TS 1,923 s; the `WORKERS=0` step 6,668 s. The longest job |
  | `cmp-n-1002` | 2,100 s | not measured: about `cmp-n-1001`'s TS run and its Python |
  | `cmp-c-7101` | 4,800 s (1.33 h) | TS 474 s; Python ~176 s; 7 plants 397 + 405 + 405 + 401 + 405 + 346 + 381 = 2,740 s; the `WORKERS=0` step 1,401 s |
  | `o-6003` | 2,950 s (0.8 h) | TS 714 s; the O step; the `WORKERS=0` step 2,229 s |
  | `o-6001`, `o-6002`, `o-6004` | 586–696 s each | TS and the O step |
  | `flip` (5 jobs), `smoke` | as in C4d | each flip job runs two TS runs (FLIP 1001's took 1,846 s), the judgement (45 s) and the Python |

  - GitHub estimate (arithmetic, not measured): if the runner is as fast as this VM, the longest job,
    `w0-n-1001`, takes about 2.4 h; at 1.5 times slower about 3.6 h, at 2 times about 4.8 h. All are under the
    360-minute timeout, but the 2-times case leaves little margin. Without the split (N 1001's `WORKERS=0` step
    inside `cmp-n-1001`), that job would take about 3.1 h locally (4,480 + 6,668 s).

### 12.6 What the guard costs, step 4 and the CI time (C4f, 2026-11-08)

C4f takes a snapshot and a digest of each stage's universe and checks them during the run (7.3's C4f bullet, 7.7's
guard). It adds three run plants to `cmp-c-7101` and one to `cmp-n-1001` (8), and a plant run to the `WORKERS=0` step
of `cmp-c-7101` (7.8 syn step 3). The numbers below are the C4f integrator's, in the C4f scratch folder:
`c4f/timing.txt` from `c4f/timing.py`, and `c4f/estimate.py` with `c4f/estimate.txt`. They were measured on this
machine (4 CPUs, 15 GB RAM), whole runs at `WORKERS=4` one heavy process at a time unless named. This machine ran
slower on C4f's day than on C4e's, so the same-day pairs below are the fair comparison.

- **Measured: whole runs** (`time.total` from print.txt).
  - Same day, one after the other, clean C 7101: the C4f code took 583.3 s and 570.7 s, and C4e's code fcce9e6, run
    between the two, took 580.2 s. That is 1.01 and 0.98 times; the walls were 585 s and 574 s against 584 s. By
    stage: `cut.m15` 1.01 and 0.99 times, `cut.h1` 1.03 and 0.97, stage 0 1.02 and 0.99, stage 1 0.97 and 0.98,
    stage 2 0.99 and 0.98, and `cut.chosen.first.h1` 0.89 and 0.92. No cost of the guard could be measured in whole
    runs.
  - Against C4e's own runs, made on C4e's day: the 17 `WORKERS=4` runs with a C4e counterpart took 10,967 s against
    9,941 s (1.10 times). C 7101 1.24 times (C4e's C 7101 was run before its machine slowed), the C 7101 plants
    1.12–1.30, O 6001–6004 1.08–1.10, N 1001 1.05 (1,988 s against 1,892 s) and FLIP 1001 1.07. At `WORKERS=0`: O 6003
    2,429 s against 2,226 s (1.09), C 7101 (on the `MODE=syn` dump) 1,542 s against 1,384 s (1.11), and N 1001
    6,732 s against 6,665 s (1.01). The same-day pair says this is the machine, not the code.
  - The new plants: `seriesStashE04` 16 s, `trialStashE04` and `avoidStashR3` 12 s each (they stop in stage 0), and
    `chosenCutSecondDiff` 1,987 s (a whole N 1001 run). On fcce9e6 the first three took 477, 467 and 608 s (they ran
    to the end). With H1 alone they took 485, 471 and 455 s.
  - Peak RSS: 3,061–3,434 MB on the clean runs, and 3,112–3,424 MB on the plant runs of the C4f code that reach the
    checks (12.5: 2.9–3.5 GB on C4e's code).
- **Measured: the guard's own cost**, from each run's stderr (`[lawsearch guard] …`):
  - the snapshot (a structured clone): stage 0's universe 111–155 ms (C4e's reviewer measured 115–120 ms for
    `structuredClone` of it), stage 1's 29–81 ms, stage 2's 89–140 ms; 154–344 ms per run;
  - the digest: 137–196 ms for a universe of [S0, END) (12,090 values), 81–104 ms for stage 1's (6,750); 1.8–3.1 s
    per run, for 14–28 digests (one per load, two after each stage's main part, one before each pool run, two at each
    stage's end);
  - the identity checks: 7–19 ms per run on the C4f code (55 ms on one H1-alone copy);
  - in all, at most about 3.5 s per run: about 0.6% of C 7101's 583 s and 0.17% of N 1001's 1,988 s.
- **Measured: per target and per trial**, by C4b's timer harness unchanged. The C4f code (F5) and fcce9e6 (G5) were
  alternated on the idle machine the same day, on the same targets: 24 jobs, every one exit 0, none disturbed, and
  every result sha256 equal between the two. The harness calls the checks directly, so the guard's digest before a
  pool run is not in these numbers (it is in the whole runs above).
  - stage 0's cut of the 6 built trials: m15 +0.10 ms per target (10.46 against 10.36 ms), and with 682 stand-in
    trials sharing the target −0.35 ms (26.97 against 27.32); h1 −0.14 ms (2.44 against 2.58) and +0.15 ms (7.47
    against 7.32);
  - the 682 stand-ins' cut: m15 84.1 against 88.0 ms per target (repeats 83.0 and 85.1 against 87.0 and 88.9), h1
    21.4 against 23.1 ms. The C4f code was 4% faster here. The cause was not found (not investigated);
  - the probes (poison and presence) per trial: m15 EF 3.04 against 3.19 s and SB 4.65 against 4.74 s; h1 EF 0.87
    against 0.86 s and SB 1.50 against 1.41 s;
  - the chosen m15 cut of the second half: 11.37 against 11.72 ms per target (N 1001's chosen trials).

  The C4f checks are not slower than C4e's.
- **Estimated: one step-4 run** (682 trials per timeframe) at `WORKERS=4`, by C4e's method (12.5). The measured costs
  per target, per trial and per chosen target from the C4f timer runs are multiplied by measured counts. The rest of
  the run (0.12 h) is taken as in 12.5, from C4f's N 1001 run (its rest 192 s, which holds the guard's snapshots and
  stage digests), plus the guard's digest before each of 8 pool runs (8 × 0.2 s). The timer harness calls the checks
  without the guard, so that digest is added here. Low is the stand-ins' target count (m15 120,385 and h1 47,908
  targets), and high is every bar a target (372,320 and 93,080).

  | code | low | high | parts (stage-0 cut; poison and presence; chosen cuts; the rest) |
  |---|---|---|---|
  | C4f (the checks read a snapshot) | 4.13 h | 10.56 h | 3.10–9.25 h; 0.76 h; 0.15–0.43 h; 0.12 h |
  | C4f, if all 11 finite B items cost what B06 costs (12.4) | 5.93 h | 16.58 h | 4.90–14.66 h; 0.76 h; 0.15–1.04 h; 0.12 h |
  | C4e, measured on C4e's day (12.5) | 3.95 h | 10.14 h | 2.97–8.89 h; 0.71 h; 0.15–0.42 h; 0.12 h |
  | C4e, finite, on C4e's day (12.5) | 5.76 h | 16.13 h | 4.78–14.30 h; 0.71 h; 0.15–1.00 h; 0.12 h |

  - The rise from C4e's figures is the slower day. fcce9e6's own stand-ins took 88.0 ms per m15 target on C4f's day
    against 81.0 ms on C4e's, while on the same day the C4f code's took 3.9 ms less than fcce9e6's.
  - The guard's cost in a step-4 run grows with the number of pool runs (about 0.2 s of digest each) and of stages,
    not with the number of trials or targets. That is arithmetic; it was not measured on 1,364 trials.
  - The finite rows rest on 12.4's assumption (B06's measured prefix cost for each of the other 10 finite items), not
    on a measurement. These hours are arithmetic, not a measured step-4 run, and the items are stand-ins.
- **Verdict** (the C4f integrator's, from the table): one step-4 run at `WORKERS=4` fits about 6 h at the stand-in
  target count. It takes 4.13 h with B06 the only finite item built. If all 11 finite items cost what B06 costs, it
  takes 5.93 h: inside 6 h by only 0.07 h, on a day this machine ran slow. If every bar were a target it would not
  fit (10.6–16.6 h).
- **CI time.** Local seconds on this 4-CPU VM on C4f's day, at `WORKERS=4` unless named. GitHub was NOT measured: the
  workflow has never run there. `MODE=walkfiles` walls stand in for `MODE=syn`, whose generation adds about 7 s
  (6.6 s measured). The Python `--run` times are the C4d comparer's 176–200 s, not measured in C4f. This supersedes
  12.5's table.

  | job | local, about | made of |
  |---|---|---|
  | `hand` | under 5 min | the hand-plant step 24 s; `MODE=hand` and the 21 TS hand plants a few seconds each; the grep step under 1 s; the gates and refusal steps 11 s; `deno check` about 30 s uncached (C4e's figure) |
  | `cmp-n-1001` | 6,650 s (1.85 h) | TS 2,003 s; Python ~190 s; the plants `avoidFull` 4 s, `secondHalfAll` 1,998 s, `dropSecondStrata` 17 s, `blindRowHit` 448 s and the new `chosenCutSecondDiff` 1,987 s |
  | `w0-n-1001` | 8,750 s (2.43 h) | TS 2,003 s; the `WORKERS=0` step 6,737 s. The longest job |
  | `cmp-n-1002` | 2,200 s | not measured: about `cmp-n-1001`'s TS run and its Python |
  | `cmp-c-7101` | 6,850 s (1.9 h) | TS 570 s; Python ~176 s; the 7 C4e plants 3,167 s (448–459 s each); the 3 new plants 40 s; the `WORKERS=0` step 2,896 s (the clean run's 1,542 s and the new plant run's 1,349 s) |
  | `o-6003` | 3,200 s | TS 769 s; the O step; the `WORKERS=0` step 2,432 s |
  | `o-6001`, `o-6002`, `o-6004` | 666, 645 and 766 s | TS and the O step |
  | `flip` (5 jobs) | 4,200 s for seed 1001 | N 1001 2,003 s; FLIP 1001 1,975 s; the judgement 50 s; Python ~190 s. The other seeds were not measured |

  - GitHub (arithmetic, not measured): if the runner is as fast as this VM, the longest job, `w0-n-1001`, takes about
    2.4 h; at 1.5 times slower about 3.6 h, and at 2 times about 4.9 h. All are under the 360-minute timeout, but the
    2-times case leaves only about 1 h of margin. `cmp-n-1001` and `cmp-c-7101` (about 1.9 h each locally) would
    reach 3.7–3.8 h at 2 times.

### 12.7 The threat model and the checks' realms (C4g, 2026-11-10)

**Why.** C4f's reviewers reproduced five ways in which the main run and the checks still shared a value, which C4f's
separation of objects (H1) cannot close, because they share one process:
1. FILES: stages 1 and 2 reloaded `<run>/gmo` after stage 0's main-run code had run.
2. ENV: `Deno.env` was shared with every worker.
3. MODULE STATE in the checks that ran in the main thread at every `WORKERS` (the refuter's `lenmemo` hid `entryEarly`
   from follow-bars), and in the units at `WORKERS=0`.
4. REALM GLOBALS (`globalThis`, built-in prototype expandos) at `WORKERS=0`.
5. State carried from one check unit to a later one inside long-lived pool workers. The C4g judges measured
   CacheStorage and `navigator.locks` doing this.

C4f's smaller findings were also open:
- no CI test showed H1 itself, because H2 or H3 stopped every H1 plant first;
- the identity proof's main side missed the Inds, signals and tables;
- `readOnlySet` trusted any frozen Set;
- the docs said "one channel";
- the grep's comment left out some escapes;
- exit 6 clashed with the Python comparator's 6.

**How the design was chosen.** Three designers each built a design with prototypes: "sandbox" (the main run in a
permission-less isolate under a warden), "process" (separate OS processes, with a cut regime of deltas, T order, fresh
cut workers and no want) and "harden" (one process, the main thread hardened, gate-3 bytes and the env revoke). Two
judges then compared them: "power", by plants against each design's prototypes, and "cost-risk", by paired benches and
the step-4 arithmetic.
- The power judge ranked sandbox first.
- The cost-risk judge found that only the process design's cut regime fits step 4. It recommended harden's in-process
  backbone with that cut regime and a kept poison and presence pool.
- The lead took the cost-risk judge's hybrid, plus the power judge's cheap grafts (delete CacheStorage, follow-bars in
  a worker of its own, jobs without their want), under an explicit threat model.

The files are in the C4g scratch folder: `c4g/design-final.json`, `c4g/design-{sandbox,process,harden}/design.md`, and
`c4g/judge-power/` and `c4g/judge-cost-risk/` with the judges' plants and benches.

**The threat model (T)** is written under 12 rule 2:
- The checks must catch accidental look-ahead in main-run code written in good faith, state kept across calls included.
- They are not built to resist deliberate concealment aimed at the harness.
- Only the cut keeps rule 2 by construction. Poison is exactly invertible, and presence keeps every bar after its
  deleted ones (both by the spec), so they catch naive look-ahead only.

#### G1: one process; the main run stays in the main thread

- **The environment.** `main()`'s first statement reads the 15 settings and revokes `env` (`readSettings`, 7.7). After
  that, every `Deno.env` call in the main thread or in a worker started later is `NotCapable`.
  - The order matters. A worker made before the revoke keeps env: the C4g integrator saw it in 2 of 3 tries, so it is
    a race. A worker that had already started lost it. So the settings are read and env is revoked before any worker
    exists.
    - (C4h, 2026-11-11; C4g's review, the lead's F2) **Wrong: the order is not what keeps env from the checks.** A
      worker started with `permissions: "none"` never holds env, whenever it is made, even with no revoke at all (C4g's
      refuter, `c4g/refute-power-2`: 20 of 20, and 3 of 3 without a revoke). An inheriting worker loses env at the
      moment of the revoke, even one already running; the "2 of 3" was its read before the revoke statement ran. The
      revoke closes env for the main thread, and at once for any inheriting worker. The program's workers are all
      "none", and since C4h each one refuses to serve when it holds any of the main thread's grants (G2's C4h bullet).
  - `rp2EnvE04` now stops at the main run's first `Deno.env.get` (exit 1). On b322c13 it passed every check.
- **The gate-3 bytes.** Gate 3 reads every gmo file once (`treeBytes`), and the manifest's digest is taken of exactly
  those bytes. Then, before any main-run code, the three stages' universes are loaded from those bytes and kept (their
  snapshots and digests). Every later reader reads the kept bytes, never the disk: stage 1's and stage 2's loads, which
  are now these early loads, and the retrace of 13 (iv) (7.3, 7.7).
  - `gmoWriteR` shows it. Stage 0's main run rewrites one close on the disk. At stages 1 and 2 the probe lines read
    "disk 113.218, the checks' snapshot 113.217, the main run's universe 113.217". All 83 dump files equal the clean
    run's, and the file is restored after the run.
  - On b322c13 all three values were 113.218, and 7 dump files changed.
- **Write.** It is narrowed by the flags to the run's own folder (7.7, 7.8). A path revoke at run time drops the whole
  parent grant in Deno 2.9.6 (measured), so the program cannot narrow it itself.

#### G2: the checks' computations in workers with no permission, which the main run never touched

Every worker is started with `deno: { permissions: "none" }` (needs `--unstable-worker-options`; without it Deno 2.9.6
exits 70 at the first check run: fail closed). Its entry imports the lockdown and the frozen constants first (G3).
(C4h, 2026-11-11; C4g's review, the lead's F2) **"none" is now tested in every worker, under the program's real flags.**
C4g's par worker queried each permission without a path (`notSandboxed`); under `--allow-read=. --allow-write=<OUT>` that
reads "prompt" in an inheriting worker too, so a worker started without "none" served (C4g's refuter ran the real par
worker so), and the follow-bar worker had no test at all. Now the main thread lists the grants it holds
(`lawsearch-sandbox.ts` `grantsHeld`: each path-less name, and read and write on `.`, the run folder and the dump folder,
that read "granted" there) and sends them with its first message to every worker; a worker refuses to serve when any of
them, or any path-less name, reads "granted" in its realm (`refusalOf`). A path-scoped query reads "granted" in an
inheriting worker and "prompt" in a "none" one. Shown with the real workers under the CI flags, and end to end with
copies whose `new Worker` lines lost "none": each run stops with `… not sandboxed (granted here: read ".", …)`, exit 1
(12.9 F2).

- **The cut** (12.1 item 15). A pool is made for each cut run and ended with it. There is one target per job, and the
  jobs are sent in T order. The worker first gets the universe without bars, then each job's new bars only. Jobs carry
  no want (fix 9.4: the main run's answer is compared in the main thread).
  - So at its target, a cut realm has never held a bar after T_k, nor the main run's answer, nor anything of another
    check run.
  - Plants missed on b322c13 and caught here: `judgeListen2E04` (a listener keeping what a worker is sent: 277, 17, 295
    and 27 cut rows on the four E04 trials); `judgeCacheCarryE04` (a memo carried in CacheStorage and between units:
    the same cut rows in both runs, byte for byte); and `w0protoG3` at `WORKERS=0`.
- **Poison and presence** (12.1 item 16). One probe pool is kept for the whole run and never given a cut unit. Its
  workers get the whole snapshot, because by the spec those checks' inputs hold the bars after T.
  - The lead chose the kept pool: a fresh pool per run costs about 20 % of m15 presence, measured by the C4g cost-risk
    judge.
  - Carry within the run is residual 2 below.
- **The follow-bar checks** (12.1 item 17). A fresh worker with no permission is started per call. It is sent the
  snapshot's timeframe and the rows' coordinates (pi, T, d, j, x) only, never the main run's m, h, PL or its blind
  table. It answers the recomputed values, and the main thread compares.
  - `lenmemoEntryEarly` (b322c13: follow (i) 0 changed rows) now fails follow-bars on all 273,528 m15 and 60,660 h1
    rows.
- **`WORKERS=0`** means one worker in each pool; no unit runs in the main thread at any `WORKERS`. The replay order is
  unchanged (rule 3). What the yml's `WORKERS=0` against 4 step can still show: 7.8 syn step 3's C4g bullet.

**Where every check runs, and why** (the C4g integrator's audit, checked again in the code by the C4g docs writer).
"Shared code" means a module the main run also runs in the main thread (bars, ind, items, events, trade). A check that
stays in the main thread does so because it compares plain data, or runs check-only code, pure functions and frozen
constants, never shared code that the main run's state could change, or because it is, by the spec, the main run's
answer side.

| check | where it runs | why (the decision) | evidence |
|---|---|---|---|
| the units of `cut`, `cut.chosen.first`, `cut.chosen.second`, `suspect13.cut.*` | a cut pool's worker (fresh per cut run, deltas, T order, one target per job, no want) | they run shared code (`candidatesOf`, `reasonOf`, `indOf`): moved into a realm that never held a later bar | `lawsearch-par.ts`, `-par-worker.ts`. Every dump byte-equal (12.1). `judgeListen2E04`, `judgeCacheCarryE04` (run 2) and `w0protoG3` at `WORKERS=0` missed on b322c13 and caught here. `[lawsearch pools]` on clean C 7101: 4 cut runs, 16 cut spawns |
| the units of `poison`, `presence`, `suspect13.poison1000.*`, `suspect13.presence.*` | the probe pool's workers (kept for the run, no want) | they run shared code: moved into workers no main-run code touched. By the spec their inputs hold the future, so not by construction (residuals 1, 2) | `judgeListen2E04` passes them (the residual by the spec). `judgeCacheCarryE04`'s presence row shows the carry (2 of 200, the bar varying). `avoidStashR3call`'s presence failures equal C4f's for `rp3by`, so they are the main run's wrong rows, not carry. (C4h, 2026-11-11; the lead's F3) **Half of them were carry**: variant (ii) read variant (i)'s answer from the task's shared avoid table (C4g's refuter: 1,100 of 1,107 hits). Since C4h each poison and presence unit has its own copy of the table, and every count halves (186 → 93 …, 8); the other half is the main run's wrong rows |
| `follow-bars` (m15 and h1, stages 1 and 2) | a fresh worker per call (`lawsearch-follow-worker.ts`); the comparison in the main thread | it runs shared code (`valuesAt`, `windowSeries`, `poisonBars`): moved; the worker gets coordinates only | `lenmemoEntryEarly`: caught here, missed by its named check on b322c13. The CheckResult strings are the old ones (every dump byte-equal) |
| the gates: the rules files (`checkRulesFiles`), the manifest's tree digest, the avoid table's sha256 | the main thread, before any main-run code | nothing of the main run exists yet | gate rows of every run's checks.csv and print.txt equal C4f's; the refusal steps pass |
| `data.syn0/1/2` and `h1Only` | the main thread | plain reads of the snapshot: `dataCheck` lists the snapshot's own load problems; `h1OnlyCheck` compares T with SPLIT | in `gmoWriteR` the snapshot keeps 113.217 while the disk holds 113.218 |
| the choice of cut targets, probe records and probe bars, and the seeds (`cutTargets`, `probeRecs`, `probeBars`, `sampleOf`, `lowerBound`) | the main thread | plain loops over the snapshot and the main run's signals; `sampleOf` runs trend-stats' `shuffle` and `mulberry32` (self-contained functions; the module is imported by `lawsearch-checks.ts` alone) on the frozen `SEEDS` | the graph audit (7.8 hand step 10); `lawsearch-frozen.ts` freezes `SEEDS`; every plant's cut_fail.csv bars equal C4f's |
| the wants (`decisionOfClassified`) | the main thread | the main run's answer side: its own rows, plus `stratumOf` (a pure function of the pair, direction and T) | fix 9.4: wants never reach a worker (`NO_WANT_AT`) |
| spec 13's hit lines (`suspectOf`), `suspect.blind.stage1`/`2`, and which trials get 13's checks | the main thread | by the spec this is the main run's code: the stage's own measures decide what spec 13 looks at; the checks it starts are the rows above and the retrace | blindRowHit (N 1001) and O 6001–6004 give C4f's suspect.csv and checks.csv; `lenmemoEntryEarly`'s 9 `suspect13.retrace.stage1` failures are the same on b322c13 |
| the main run's selection inputs: the signals that pick targets and probe bars, the blind tables whose rows follow-bars and the retrace recompute | the main thread, as data | they are the main run's claims of which bars to check; the recomputation is on the check side (a worker, or the gate-3 bytes); no main-run value reaches a worker as a want | every job has an empty want; follow-bars sends coordinates only |
| `donchian` | the main thread | the check side is `donchianState` of bigflow-lib (self-contained; the module is imported by `lawsearch-checks.ts` alone) on the snapshot's bars; the main side is the main run's `Ind.donchian`, its answer | the graph audit; the `*,donchian` row equal in every dump |
| the entry-bar sub-check of the cut checks | the main thread | the check side is a plain loop over the snapshot's starts; the main side is `entryExitIndex`, the main run's own function, which belongs where the main run's state is | every dump byte-equal |
| `suspect13.retrace` | the main thread | it reads the gate-3 bytes (`readOf`, never the disk) and runs `jstDayKey` (pure), `POINTS_PER_PRICE`, `MID_DIGITS` and the frozen GMO maps | `retraceCheck(read, …)`; O 6001–6004 equal C4f's and the yml's O step passes. No run that writes the disk has a spec 13 hit (C 7101 has none), so that the retrace cannot see such a write rests on the code (`readOf`), not on a run |
| `sameFirstHalf`, `addsUp`, `print` | the main thread | they compare main-run results with each other, or print keys with the frozen `PRINT_KEYS` | every dump equal |
| the guard: H1's separation, the task allow-list, H2, H3 | the main thread | identities and digests, before and after the main run's parts | `seriesStashE04` exit 7 in 24 s; `trialStashE04` and `avoidStashR3` exit 1; `avoidStashR3call` exit 3 (H1; C4h: its presence counts halve, 8). Per clean C 7101 run: digests 2.5–2.9 s (21), snapshots about 0.3 s, identity checks and allow-lists 8–21 ms |

#### G3: every realm

- **The lockdown** (`lawsearch-lockdown.ts`) is the first import of every entry point, and it imports nothing. It only
  deletes, from the realm's globals and the Deno namespace:
  - `BroadcastChannel`;
  - `caches`, `CacheStorage` and `Cache`;
  - `localStorage`, `sessionStorage` and `Storage`;
  - `navigator` (`navigator.locks` with it), `Navigator` and `WorkerNavigator`;
  - `process`;
  - `Deno.kill`, `Deno.addSignalListener` and `Deno.removeSignalListener`;
  - `Deno[Deno.internal]`.

  A name it cannot delete is shadowed with an unconfigurable `undefined`. It freezes no intrinsic: freezing the
  built-in prototypes in the hot realms cost +3 to +10 % of a unit's time (measured by the C4g designers and judges),
  and it would only help against deliberate hooks, which T leaves out.
  - (C4h, 2026-11-11; C4g's review, the lead's F7; outside T) In the MAIN realm only (a worker realm has
    `WorkerGlobalScope`), it now also freezes `Worker.prototype` and `EventTarget.prototype` and makes
    `globalThis.Worker` read-only and unconfigurable. Neither prototype is on a unit's hot path (units run in workers,
    whose intrinsics stay unfrozen), and a same-day pair of whole C 7101 runs shows its cost (12.9). It refuses the two
    relays C4g's refuter built (a wrap of `Worker.prototype.postMessage`, and an `onmessage`-setter hook; both hid the
    cut on C4g's code): each now stops with a `TypeError` when the plant installs its hook (12.9 F7). Residual 10 says
    what stays open.
  - (C4h; the lead's F4) "The first import" means the first module request, re-exports counted (3, 7.8 hand step 10).
- **`--disallow-code-generation-from-strings`**, merged into the one `--v8-flags`: `eval` and `Function` throw in every
  realm. An unknown V8 flag stops Deno at its start (fail closed).
- **The frozen constants** (`lawsearch-frozen.ts`) are the second import of every entry point. It deep-freezes every
  object or function value exported by `lawsearch-const.ts` and `lawsearch-rules.ts` (`SEEDS`, `HOLE_MIN_SLOTS`,
  `S_OF_F`, `REASONS`, `PLANTS`, …) and quotes.ts' `GMO_SYMBOLS` and `GMO_INTERVALS`: 77 objects on the main thread.
  Until C4g `SEEDS.cut = 1` succeeded at run time (C4f's review), and `SEEDS` picks the cut's signal targets.
  `lawsearch-const.ts` itself is not edited: its sha256 constants are part of R_law.
- **The audits** (7.8 hand steps 10–12; C4h: 13 and 14):
  - the graph audit: every realm's module graph holds the repository's `.ts` code only, with no data module and nothing
    under `research/out` or `research/ledger`, and the lockdown first (C4h: first among every value module request,
    re-exports included, from the source text and from `deno info`, F4);
  - the source rule: no `node:`, no computed `import(`, no `eval` or `Function`, no `Deno[`, no shared memory, no other
    `new Worker`, with a 3-line allow-list;
  - the catch audit: every Deno call inside a try block or with `.catch` is one of 19 audited entries. Two catches now
    rethrow anything but `NotFound`, so that a permission refusal cannot silently change the output;
  - (C4h, 2026-11-11; F5) the trigger audit: every module of the four graphs is in a push path of `lawsearch.yml` or of
    the new `lawsearch-audit.yml`, which runs these audits (and `MODE=hand`) when a module the program shares with other
    code changes;
  - (C4h; F7) the relay audit: in a realm where the lockdown ran, the four relay hooks are refused (`TypeError`).

#### G4: what stays of C4f's guard, and why

- **H1**, the separation of the check side's objects (a snapshot per universe, the checks' own trial definitions and
  avoid table, holes made by the units), is kept. It still adds power cheaply, about 0.3 s per run. It is what catches
  `avoidStashR3call`, whose writes H2 does not stop. With the realms, H1 also keeps the main thread's checks (the
  table above) on objects no main-run code holds.
- **The identity proof** is now an allow-list for every check run's task (7.3 `assertTaskAllowed`): exactly the task's
  keys, a plain object, every trial one of the checks' own (by identity), and the checks' own avoid table (by identity).
  `afterMain`'s identity walk is kept as it was.
- **`readOnlySet`** trusts only the Sets it made itself (a module `WeakSet`, 5.3).
- **H2's freezes** are kept, defense in depth (12.1 item 13).
- **H3, the universe digest,** is kept, with exit 7 (2.3). It sees a main-run write into its own universe at any bar,
  where the checks see a write only through the decisions it changes at their targets and probes. It costs about 2.5–2.9
  s per clean C 7101 run.
- **Exit codes** (2.3): 0, 2, 3 and 4 as before; 7 a universe changed after its load; 1 any other error, including a
  `SHARED` line, a write into a frozen object, a refused permission (`NotCapable`) and a foreign frozen Set.

#### G5: the plants

The job `plants-c4g` holds seven run plants, one per channel (8's table, 8's table of channels, and 7.8). Each was
missed on b322c13, with two exceptions:
- `lenmemoEntryEarly` was missed by its named check, follow-bars; that run still exited 3, through the retrace;
- `avoidStashR3call` was caught there too, by H1. It is in CI so that the job fails if H1's separation is ever lost.
  (C4h, 2026-11-11; F1) In C4g its row test could never fail (a pipe into `cut` under `bash -e` without `pipefail`), so
  only its exit and stage 2 were enforced; since C4h the row test is enforced too (7.8). Each is caught on the C4g code by a named check, stopped by a clear error, or (`gmoWriteR`)
shown to reach nothing the run reads.

#### What stays open

Inside T:
1. **Poison and presence cannot keep rule 2 by construction.** By the spec their inputs hold the future, so code that
   looks for it there finds it. `judgeListen2E04` passes both on all four E04 trials and is caught only by the cut.
2. **The kept probe pool can carry state from one poison or presence unit to a later one in the same worker, in the
   same run.**
   - Such state can hide a naive look-ahead from these two checks, but not from the cut.
   - Measured: with CacheStorage deleted, `judgeCacheCarryE04`'s memo is plain module state. Its presence row on
     h1.E04.F00 read "2 of 200 differ" in all four runs of the same code, but it named a different bar each time:
     EUR/JPY 2026-06-17, EUR/USD 2026-09-22, AUD/JPY 2026-07-15, and EUR/USD again.
   - By the code, a pool gives the next job to whichever worker answers first (`lawsearch-par.ts` `feed`), so what a
     worker holds when a unit runs depends on timing. For code that keeps state across units, poison's and presence's
     results can therefore change between runs and with `WORKERS`. The cut's cut_fail.csv was identical in all four
     runs.
   - The job `plants-c4g` checks only the cut and the exit for this plant. Clean code is not affected: every
     `WORKERS=0` against 4 comparison and every repeat of this round was byte-equal.
   - A fresh realm per probe unit, or per trial, would close this at the cost of a worker start and a universe copy
     per unit (not measured). A fixed job-to-worker assignment would make the bytes repeatable per `WORKERS`, but it
     would not stop the carry.
   - (C4h, 2026-11-11; C4g's review, the lead's F3) **The routes of this carry are three, not two.** Besides module or
     realm state, the task-level objects a probe worker is handed are shared by every unit of a check run there. The
     avoid table was one, writable through `Set.prototype.add.call`: half of `avoidStashR3call`'s presence failures
     were carry through it (8). C4h closes that route: each poison and presence unit gets its own read-only copy.
     What stays (12.9 F3's table): the cached `ExclCtx`'s holes and the poison tables (typed arrays, one per task per
     worker), and the universe `u` the worker is sent for the run (plain objects and typed arrays), each writable, so
     a unit can still leave a value there for a later unit; the frozen task, its trial list and its trials cannot
     carry. The cut is immune to all of them by T order (its pool is fresh for each cut run, and its realm holds no bar
     after the current target). The lead's decision stands: the kept pool stays (a fresh pool per run costs about 20 %
     of m15 presence).
3. **The main-thread checks take the main run's answers as data.** These are the wants, `entryExitIndex`,
   `Ind.donchian`, the signals that pick the targets, spec 13's hit lines, `sameFirstHalf` and `addsUp`. If a main-run
   function is wrong the same way on both of its own sides, these checks cannot see it; the worker checks are the ones
   that recompute.
4. The lockdown deletes names; it does not prove that Deno 2.9.6 has no other shared channel.
   - The source rule is a regex over the program's files with a 3-line allow-list.
   - The catch audit covers try blocks and `.catch` lines only.
   - The memory-block grep cannot see names built at run time, string-key escapes (`C["\x62uffer"]`), identifier
     escapes (`C.\u0062uffer`), or a `//` line inside a template literal (7.8 hand step 9).
5. **The env revoke is process-wide, but a worker made just before it can keep env** (a race, measured). The code reads
   the settings and revokes before any worker exists, but no audit checks that order, so an edit that starts a worker
   earlier would reopen the environment to it.
   - (C4h, 2026-11-11; C4g's review, the lead's F2) **Wrong, and withdrawn as a residual.** No worker keeps env: an
     inheriting worker loses it at the revoke, and the program's workers, started with "none", never hold it (G1's C4h
     bullet). The order of the revoke protects the main thread only. What keeps env and the files out of the checks'
     realms is "none", and since C4h each worker tests it at run time against the main thread's own grants and
     refuses to serve otherwise (G2's C4h bullet). What stays: the worker's own module code runs at its start, before
     its first message and so before the test (an inheriting worker's module code could read a file then; the run
     still stops); and a worker that held some grant but none of the listed ones would pass (an inheriting worker holds
     them all).
6. **Write is narrowed to the run's own folder, not to nothing.** Main-run code can still write there, and it can read
   everything under `.` and the scratch folder. Nothing it writes into the run's gmo folder is read again (G1).
   - (C4h, 2026-11-11; C4g's review, the ci-docs reviewer; the lead's F6) Corrected: main-run code can read everything
     under the repository (`--allow-read=.`, the CI's grant); only the local runs of the builders and integrators were
     also granted the scratch folder (`--allow-read=.,<scratch>`). In CI no scratch folder is readable (C4g's refuter,
     `c4g/refute-ci-docs-5`). Since C4h `MODE=syn` and the smoke step write only their OUT too (7.7, 7.8).
7. **The `WORKERS=0` against 4 step** sees only state that changes bytes between the two settings. It stays defense in
   depth, not a guard (7.8 syn step 3).
8. **Points open since earlier rounds, unchanged:**
   - 12.2 (1): the reason at bar k rests on `classify` staying a per-row map of `reasonOf`;
   - the holes' typed arrays stay writable;
   - the poison tables have no CI step of their own (12.2 (4));
   - stage 2's `suspect13` checks have no run plant (8);
   - the higher-timeframe path and every item not built have no run plant (8).

Outside T (deliberate concealment aimed at the harness; not required, and open):
9. Hooks on built-ins or Web-API prototypes in the main realm, set before the checks read. On the designers'
   prototypes, the power judge's `judgeHookBlindE04` blinded the harden design's prototype check and hid the cut, and
   a `MessagePort` `onmessage` setter hook hid the sandbox design's cut.
10. A relay through `Worker.prototype.postMessage`: the power judge's `judgeRelayE04` hid every check on the process
    design's prototype.
    - (C4h, 2026-11-11; C4g's review, the power reviewer, reproduced by a refuter; the lead's F7) On C4g's code two
      relays hid the cut: a main-realm wrap of `Worker.prototype.postMessage` and an `onmessage`-setter hook, each
      adding the main run's universe to what a cut worker is sent, with `judgeListen2E04`'s listener using it (exit 0,
      "0 of 34556 … differ" on the E04 cuts; C4h ran both on 12ee6d2 again, 12.9 F7). **Closed since C4h: these two
      hooks**, and any other change to `Worker.prototype`, `EventTarget.prototype` or `globalThis.Worker` in the main
      realm. G3's freeze makes each plant stop with a `TypeError` when it installs its hook (exit 1, about 2 s), and
      hand step 14 checks the freeze. **Not closed: the relay itself.** A hook on another built-in that the harness
      calls with a worker or a message can still reach the worker: `Array.prototype.push` (which takes `lawsearch-par.ts`'s
      slot, with its worker; C4g's refuter's micro test), `Object.prototype` setters, the `MessageEvent` `data` getter
      the replies are read through, and the other built-ins of residual 9; and a worker-realm hook (worker intrinsics
      are not frozen).
11. A module that tells a check realm from the main realm (by its missing permissions or its missing bars) and
    misbehaves only there.
12. Blinding the digest, inverting the poison, or rewriting the verdict or the dumps.

No intrinsic is frozen in the hot realms. That would only help against 9 and 10, and it was measured at +3 to +10 %.
(C4h, 2026-11-11) Still true of the hot realms (the workers). The main realm now freezes two prototypes and pins
`globalThis.Worker` (G3's C4h bullet), which are off every hot path; 12.9 has the cost.

### 12.8 What the realms cost, step 4 and the CI time (C4g, 2026-11-10)

(C4h, 2026-11-11) C4h's numbers, and its CI table, which supersedes this one's, are in 12.9. This section stays as the
record of C4g.

The numbers below are the C4g integrator's, in the C4g scratch folder:
- `c4g/integ/timing.txt` (from `c4g/integ/timing.py`);
- `c4g/estimate.py`, with `c4g/integ/estimate.txt`;
- the timer results `c4g/timer/` (C4b's `tb.ts`, unchanged).

They were measured on this machine (4 CPUs, 15 GB RAM) at `WORKERS=4`, one heavy process at a time, unless named.

**This machine's own speed moved by about 10 % during the round.** The same C 7101 run on the same code took 538 s at
16:17Z on 11-10, 594 s at 01:21Z after the machine had been up about 14 h, and 518 s after a reboot. So only same-day
pairs, run back to back, separate the code's cost from the machine's.

- **Measured: whole runs** (`time.total` from print.txt).
  - Two same-day pairs on clean C 7101, b322c13 then the C4g code, both alone; every file equal to C4f's dump:
    - pair 1: 537.1 s against 538.0 s (+0.2 %);
    - pair 2: 518.5 s against 517.6 s (−0.2 %).
  - By stage, C4g minus b322c13 (pair 1 / pair 2):
    - `checks` +6.3 / +0.3 s;
    - `cut.m15` +3.5 / −3.7 s;
    - `cut.h1` +1.9 / +3.0 s;
    - `cut.chosen.first.h1` +2.9 / +3.2 s and `cut.chosen.second.h1` +3.3 / +4.2 s. Each cut run now starts a fresh
      pool and sends a skeleton and then the deltas, which is about 3–4 s per small cut run;
    - `stage0` −2.8 / −9.6 s, `stage1` −3.1 / +0.6 s and `stage2` −8.0 / −4.6 s. The three loads now happen before
      stage 0 and appear only in `time.total`: 14.7 / 12.7 s.
  - Peak RSS: 3.58 / 3.47 GB against 3.14 / 3.29 GB. The cut pool and the probe pool are both alive in stage 0.
  - Against C4f's own runs (another day, so the machine's speed is mixed in):
    - C 7101 538 s against 583 s, N 1001 1,962 against 1,988, FLIP 1001 1,846 against 1,970;
    - O 6001–6004 649, 640, 749 and 735 s against 657, 640, 757 and 761 s;
    - peak RSS 3.46–3.64 GB against 3.06–3.43 GB.
  - At `WORKERS=0` (now one worker per pool), each beside one other heavy run:
    - C 7101 1,358 s (C4f: 1,542), its `lastBarStateG3` plant 1,207 (1,349);
    - O 6003 2,363 (2,429), N 1001 6,624 (6,732).
- **Measured: the cost of each new part** (each run's stderr, three C 7101 runs):
  - the lockdown, the freezes, the settings read and the env revoke: not timed apart; nothing shows in the walls;
  - the gate-3 bytes and the three loads from them: 12.7–16.9 s, moved out of the stages, with `time.total`
    unchanged within ±0.2 %;
  - the fresh cut pools: 20 spawns per clean C 7101 run in all (16 cut + 4 probe). The spawns take 216–235 ms, the T
    sort 416–537 ms, and the deltas 2.1–2.6 s for 2.43 million rows;
  - follow-bars in 4 fresh workers: 112–134 s per run. They replace the main thread's loop, and stages 1 + 2 were not
    slower in either pair;
  - the guard: snapshots about 0.3 s, digests 2.5–2.9 s (21 per run), allow-lists and identity checks 8–21 ms.
- **Measured: paired timer samples** (each C4g job run next to a b322c13 job on the same machine state, 44 jobs, every
  result sha256 equal):
  - the stage-0 cut copies: m15 T682 30.57 against 30.34 ms per target (+0.8 %), T6 9.69 against 10.14 ms; h1 T682
    8.46 against 8.28 ms (+2.1 %);
  - the stand-ins (682 trials): m15 83.3 against 82.4 ms per target (+1.1 %); h1 20.1 against 19.3 ms (+4.2 %);
  - the probes, in s per trial: m15 EF 3.00 against 2.86 (+4.6 %) and SB 4.30 against 4.25 (+1.1 %); h1 EF 0.84
    against 0.81 and SB 1.33 against 1.30;
  - the chosen m15 cut of the second half: +0.15 to +0.32 ms per target.
  - Three early C4g stand-in jobs had no b322c13 partner, because that copy had been deleted (`c4f/copies/si-c4f`;
    rebuilt as `c4g/copies/si-base`). They are left out of the paired figures: m15 91.11 and 90.90 ms, h1 22.51 ms.
    The integrator's first estimate, which used them, is superseded.

  In sum, the timer shows about +1 to +5 % per target or per trial, and a whole C 7101 run shows nothing measurable
  (+0.2 % and −0.2 %).
- **Estimated: one step-4 run** (682 trials per timeframe) at `WORKERS=4`, by C4e's method (12.5). The costs measured
  per target, per trial and per chosen target are multiplied by measured counts.
  - Low is the stand-ins' target count (m15 120,385 and h1 47,908 targets); high is every bar a target (372,320 and
    93,080).
  - The rest of the run is C4g's N 1001 run outside its checks (180 s), plus about 0.2 s per pool run.
  - The finite rows assume that each of the 10 other finite B items costs what B06's measured prefix costs (12.4).
    That is an assumption, not a measurement.

  | code (paired samples) | low | high | parts (stage-0 cut; poison and presence; chosen cuts; the rest) |
  |---|---|---|---|
  | C4g | 4.07 h | 10.45 h | 3.05–9.14 h; 0.74 h; 0.16–0.45 h; 0.12 h |
  | C4g, if all 11 finite B items cost what B06 costs | 5.87 h | 16.51 h | 4.86–14.55 h; 0.74 h; 0.16–1.11 h; 0.12 h |
  | b322c13, the same pairs | 3.99 h | 10.29 h | 3.01–9.02 h; 0.71 h; 0.15–0.45 h; 0.12 h |
  | b322c13, finite | 5.80 h | 16.34 h | 4.82–14.43 h; 0.71 h; 0.15–1.09 h; 0.12 h |

  - C4g adds +0.08 h (+2.0 %), and +0.07 h (+1.2 %) in the finite case.
  - Other readings: with every C4g sample, the three unpaired ones included, 4.16 / 5.96 h. C4f's day figures (4.13 /
    5.93 h, 12.6) times the paired ratio give 4.21 / 6.00 h. The C4g judges' arithmetic for this hybrid was 4.14 h and
    5.94–5.97 h, which agrees.
  - These hours are arithmetic, not a measured step-4 run, and the items are stand-ins.
- **Verdict** (the C4g integrator's, from the table):
  - At the stand-in target count, one step-4 run at `WORKERS=4` fits about 6 h: 4.1–4.2 h, with B06 the only finite
    item built.
  - If all 11 finite B items cost what B06 costs, it takes 5.87–6.00 h. That is at the 6-hour edge with almost no
    margin, and the machine's own speed moved ±10 % within this round.
  - If every bar were a target it would not fit (10.3–16.8 h).
- **CI time.** Local seconds on this 4-CPU VM, at `WORKERS=4` unless named. GitHub was NOT measured: the workflow has
  never run there. This supersedes 12.6's table.
  - `MODE=walkfiles` walls stand in for `MODE=syn`, whose generation adds about 12 s.
  - The Python `--run` times (about 176–200 s) are the C4d comparer's.
  - Where the integrator's plant run was not alone, C4f's alone wall for that plant is used: the plant's code path is
    the same, and the C4g clean runs were within ±0.2 % of b322c13 on the same day. The parallel walls are upper bounds.

  | job | local, about | made of |
  |---|---|---|
  | `hand` | under 5 min | measured warm: the hand-plant step 16 s; the three audits (`deno info` graph, source, catch) 0–1 s each; `MODE=hand`, the grep step and the refusal steps about 8 s together; `deno check` about 30 s uncached (C4e's figure; 3 s cached here) |
  | `plants-c4g` (new) | 4,730 s (1.3 h) | C 7101 `MODE=syn` about 555 s alone; the plant step 4,167 s, measured alone: `w0protoG3` at `WORKERS=0` 1,255 s, the others 430–540 s each, `rp2EnvE04` a few seconds |
  | `cmp-n-1001` | 6,600 s (1.84 h) | TS 1,966 s; Python ~190 s; the plants at C4f's alone walls: `avoidFull` 4, `secondHalfAll` 1,998, `dropSecondStrata` 17, `blindRowHit` 448, `chosenCutSecondDiff` 1,987 s. Upper bound 9,076 s |
  | `w0-n-1001` | 8,590 s (2.39 h) | TS 1,966 s; the `WORKERS=0` step 6,627 s (beside one other run). The longest job |
  | `cmp-c-7101` | 6,520 s (1.81 h) | TS 541 s; Python ~176 s; the 7 C4e plants at C4f's alone walls, 3,167 s; the 3 short plants 62 s; the `WORKERS=0` step 2,571 s (beside another run). Upper bound 8,710 s |
  | `o-6003` | 3,130 s | TS 760 s; the O step; the `WORKERS=0` step 2,366 s |
  | `o-6001`, `o-6002`, `o-6004` | 659, 644 and 741 s | TS and the O step |
  | `flip` (5 jobs) | 4,050 s for seed 1001 | N 1,966 s; FLIP 1,849 s; the judgement 46 s; Python ~190 s. The other seeds were not measured |
  | `cmp-n-1002`, `smoke` | not measured | `cmp-n-1002` about 2,000 s, as N 1001's TS run |

  - GitHub (arithmetic, not measured): if the runner is as fast as this VM, the longest job, `w0-n-1001`, takes about
    2.4 h; at 1.5 times slower about 3.6 h, and at 2 times about 4.8 h. All are under the 360-minute timeout, but at 2
    times only about 1.2 h of margin is left. `plants-c4g` would take about 2.6 h at 2 times.

### 12.9 C4g's review fixed: the sandbox test, the avoid copies, the audits, the trigger and the freeze (C4h, 2026-11-11)

**Why.** C4g's two reviewers found nine problems (one found by both, so eight). A refuter reproduced every one from
scratch (C4g's report, `c4g/final.json` in the C4g scratch folder: `review[].findings[]` with each verdict and its
reproduction). The lead's F1–F8 fix them; F7 and F8 are outside the threat model T (12.7) and were done because they
cost nothing measurable. Rules 1–4 of 12 hold: no output changes but the rows of one plant (F3, said below), W0 and W4
give the same bytes, no check and no count of targets or probes changes, and the spec is not changed. Everything below
was run by the C4h fixer in the C4h scratch folder (`c4h/`; its `progress-fixer.md` lists every file). The code at
launch was C4g's (`c4h/code-at-launch.sha256` equals `c4g/code-c4g.sha256` for the 24 `research/lawsearch*.ts`); the
final code is `c4h/code-final.sha256`.

**F1 (a bug): the `plants-c4g` row test of `avoidStashR3call` could never fail.** The line `grep -E
",(cut|presence),0," $d/checks.csv | cut -c1-160 || {…}` ran under `bash -e` without `pipefail` (a step with no
`shell:`), so its status was `cut`'s. Now `grep -q` decides and the rows are printed after it (7.8). Every other
`| … ||` and `if … | …` of the yml was checked: each tests the right command or uses process substitution.
- Proof (`c4h/f1/`): the step extracted from the yml (`extract.py`, asserting no `shell:` and no `defaults:`), run with
  `bash -e` and a fake `deno` that replays C4g's kept plant outputs (`c4g/kept/c4gplants-alone`; C4g's refuter's
  harness), on 12ee6d2's yml and on C4h's:

  | case | 12ee6d2's step | C4h's step |
  |---|---|---|
  | clean | exit 0 | exit 0 |
  | `avoid-norow` (every `,cut,0,` and `,presence,0,` row of the plant removed) | exit 0 (missed) | exit 1, "neither cut nor presence failed" |
  | `avoid-nochecks` (its checks.csv removed) | exit 0 (missed) | exit 1 |
  | `avoid-cutonly`, `avoid-presenceonly` (one kind of row left) | exit 0 | exit 0 (one is enough) |
  | `w0-nocut` (control: `w0protoG3`'s cut rows removed) | exit 1 | exit 1 |

**F2: the checks' workers now refuse to serve when they are not sandboxed under the program's real flags** (7.3, 12.7
G2). New module `lawsearch-sandbox.ts`: `grantsHeld([".", run, out])` in the main thread, after gate 3 (each path-less
name, and read and write on `.`, the run folder and the dump folder, that read "granted" there; env is already revoked),
sent in every "universe" message of `lawsearch-par.ts` and in the follow-bar worker's one message; `refusalOf` in the
worker, which throws (par worker) or answers an error (follow worker) when any of them, or any path-less name, reads
"granted" in its realm, or when no list came. The env sentences that credited the revoke's order are corrected (7.7,
12.7 G1 and residual 5, the `readSettings` comment in `lawsearch.ts`; the C4g integrator's G1 text in its report said
the same and is wrong in the same way).
- Proof, the real workers under the CI flags (`c4h/f2/drive.ts`, `drive-ci-walk.txt`, `drive-ci-run.txt`; `DENO_WALK
  --allow-write=<OUT>` and `DENO_RUN`): started with "none", the par worker passes the test (its next, wrong-task job
  meets its ordinary error) and the follow worker answers; started without "none", each refuses: `… not sandboxed
  (granted here: read ".", read "<run>", read "<out>", write "<out>"); it must be started with deno: { permissions: "none"
  }`. A par worker sent no list refuses too.
- End to end (`c4h/f2/logs/*-final.log`): copies of the final code whose `new Worker` line lost "none" (one copy for
  the par pool, one for the follow-bar worker), C 7101 `CUT_MAX=1`, W4: both exit 1 with that line, in 21 s (stage 0's
  first cut run) and 72 s (stage 1's first follow-bar check); neither writes checks.csv or print.txt. With "none" the
  workers serve: every run of this round.
- What it cannot see: the worker's own module code runs at its start, before its first message (12.7 residual 5's C4h
  note).

**F3: each poison and presence unit gets its own read-only copy of the task's avoid table** (7.3 `unitAvoidOf`; 5.3,
8, 12.2 (2), 12.7 residual 2).
- Measured cost, the timer (C4b's harness `tb.ts`, unchanged; `c4h/timer/`: `tc4h` = 12ee6d2 + F2 + F3 against
  `c4g/copies/tc4g` = 12ee6d2, alternated, each on an idle machine, W4; every pair's result sha256 equal). Poison +
  presence, s per trial:

  | probe group | C4h | 12ee6d2 | C4h − 12ee6d2 |
  |---|---|---|---|
  | m15 EF (3 + 3 samples) | 2.907 | 2.900 | +0.2 % |
  | m15 SB (3 + 3) | 4.140 | 4.285 | −3.4 % |
  | h1 EF (2 + 2) | 0.876 | 0.853 | +2.6 % |
  | h1 SB (2 + 2) | 1.291 | 1.345 | −4.0 % |

  Nothing measurable (the spread between repeats of one side is of the same size), so F3 was adopted.
- What changes: only `avoidStashR3call`'s rows (`c4h/kept/f3-avoid`, the plant on C4g's `plants-c4g` data, W4): 75 of
  its 77 files equal C4g's run (`c4g/kept/c4gplants-repo`); checks.csv's 12 presence rows and print.txt's
  `check.presence.detail` line differ; every count halves (8's table) and no (ii) row is left. The cut rows, the poison
  rows, cut_fail.csv and exit 3 are unchanged. Every file, print.txt included, equals C4g's refuter's run with a copy
  for presence units only (`c4g/refute-power-4/kept/fresh`), so poison's copy changed nothing. And every file but
  config.json and print.txt's run, plant and time lines now equals `reasonUsesFuture`'s run on C 7101 (C4g's kept list,
  the same data; this round's run of it too): the plant hides ③'s look-ahead in the avoid table, and without the carry
  the checks see exactly that look-ahead, row for row.
- **The task-level objects a probe worker's units share** (one check run in one worker; by the code):

  | object | how it is held | can it carry a value from one unit to a later one? |
  |---|---|---|
  | the task (`sealTask`) | frozen; its fields replaced or added: no | no |
  | its trial list and trials | frozen array of frozen `TrialDef`s, whose fields are all strings and numbers | no |
  | its avoid table | read-only Set, but `Set.prototype.add.call` writes into it | until C4h, yes (measured: half of `avoidStashR3call`'s presence failures). Since C4h no unit reads it: each gets a copy (the cached `ExclCtx` below is made from it, but units use only its holes) |
  | poison's cached `ExclCtx` (`UnitCache`, one per timeframe per task) | frozen, its `Holes` frozen, but the holes' typed arrays (`open`, `present`, `hole`) writable | yes, by a write into a typed array (open since C4e: 12.7 residual 8) |
  | poison's tables (`TABLES`, keyed by the `UnitCache`) | typed arrays (two shifted copies of each series) | yes, by a write |
  | the universe `u` the probe worker is sent for the run (`shipOf`) | plain objects and typed arrays, not frozen (presence's edited timeframe keeps the other pairs' series objects) | yes, by a write or an added property |
  | module and realm state of the worker | as 12.7 residual 2 | yes |

  The cut is immune to every row by T order: its pool is made for each cut run and its realm never holds a bar after
  the current target, so whatever a unit leaves there was made from bars at or before it.

**F4: the graph audit counts re-exports** (7.8 hand step 10; 3). Proof (`c4h/f4/run.sh`, `results.txt`,
`results-neg3.txt`, `results-new-final.txt`): the yml's graph step on copies of the tree, with 12ee6d2's audit and with
C4h's:

| case (a line put above the lockdown's import) | 12ee6d2's audit | C4h's audit |
|---|---|---|
| clean | exit 0 | exit 0 |
| `export { followValues as fv } from "./lawsearch-trade.ts";` in the follow worker (C4g's refuter's neg1) | exit 0 (missed) | exit 1 (source text and `deno info`) |
| `export * from "./lawsearch-trade.ts";` in the follow worker (neg2) | exit 0 (missed) | exit 1 (both) |
| `export * from "./lawsearch-trade.ts";` in `lawsearch.ts` | exit 0 (missed) | exit 1 (both) |
| the same with single quotes in the follow worker | exit 0 (missed) | exit 1 (`deno info` only: the source pattern reads double quotes) |
| `import type { FollowRows as FR0 } from "./lawsearch-trade.ts";` (evaluates nothing) | exit 1 (a false alarm) | exit 0 |
| `export type { FollowRows } from "./lawsearch-trade.ts";` | exit 0 | exit 0 |

**F5: a change to a module the program shares with other code now runs the cheap audits** (7.8 hand step 13 and
`lawsearch-audit.yml`). The 42 modules of the four graphs outside `lawsearch.yml`'s paths are listed (`c4h/f5/
modules.txt`, from `deno info --json`; 67 modules in all with `lawsearch-sandbox.ts`). Proof (`c4h/f5/run.sh`,
`results-clean.txt`, `results.txt`): `lawsearch-audit.yml`'s steps extracted (as Actions runs them) on copies of the tree,
then `lawsearch.yml`'s hand step 13:
- clean: every step exits 0 (`deno check` too, after a type error of C4h's own audit change was fixed; `MODE=hand`
  103 pass, 0 fail, 41 skip); hand step 13: "67 modules of the graphs, 42 of them matched only by lawsearch-audit.yml's
  paths: every one is in a push path";
- `trend-data.ts`'s read put back to `JSON.parse(await Deno.readTextFile(path))` (C4g's refuter's case): the catch step
  exits 1 (`not audited: research/trend-data.ts: …`), and `research/trend-data.ts` is one of `lawsearch-audit.yml`'s
  paths, so that push runs it;
- `research/trend-data.ts` taken out of `lawsearch-audit.yml`'s list: hand step 13 exits 1 in both workflows;
- a new module imported by `research/lib.ts`: hand step 13 exits 1 in both;
- a path with a `[` in it: refused (exit 1), not guessed.

**F6** is a wording fix (12.7 residual 6's C4h note).

**F7 (outside T): the main realm freezes `Worker.prototype` and `EventTarget.prototype` and pins `globalThis.Worker`**
(12.7 G3, residual 10; 7.8 hand step 14).
- The relay plants (`c4h/f7/mk.py`: C4g's refuter's `plant()` unchanged, the setter variant in its second form; each
  run with `LS_PLANT=judgeListen2E04`, C 7101, W4; `c4h/logs/f7-*.log`):

  | plant | 12ee6d2 | C4h |
  |---|---|---|
  | `post`: a main-realm wrap of `Worker.prototype.postMessage` adds the main run's universes to each "universe" message | exit 0, every check passed, the E04 cuts "0 of 34556 / 30798 / 24274 / 23489 differ" (missed) | exit 1 in 2 s: `TypeError: Cannot assign to read only property 'postMessage' of object '#<Worker>'` |
  | `setter`: a hook on `Worker.prototype`'s `onmessage` setter posts them with the genuine `postMessage` | exit 0, every check passed, the same four E04 cuts "0 of … differ" (missed; C4g's refuter had run it on its own fixed copy only) | exit 1 in 2 s: `TypeError: Cannot redefine property: onmessage` |

- Hand step 14 (`lawsearch-audit.ts relay`) on C4h's lockdown: exit 0, all four hooks refused; with 12ee6d2's lockdown:
  exit 1, none refused (`c4h/f7/relay-audit-*.txt`).
- Neither plant is added to `plants-c4g`: as a run plant it would have to live in the program's code, as the other
  plants do; hand step 14 tests the freeze itself in seconds instead.

**F8 (outside T)**: the yml's comment above `DENO_WALK` and the smoke step (7.7, 7.8). @@F8@@
