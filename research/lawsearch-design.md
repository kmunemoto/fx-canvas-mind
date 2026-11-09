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
| `lawsearch-gen.ts` | A | the synthetic walk (14.1) written as GMO files | rules, types, const |
| `lawsearch-ind.ts` | B | indicator arrays (the app functions, SMA oldest first, donchian, bigmove, crosses) | rules, types |
| `lawsearch-items.ts` | B | the registry: E04, E26, B06, F00, F01, S01 now (others throw); the ledger | ind, rules, types |
| `lawsearch-events.ts` | B | spec 5 (candidates) and spec 6 (①–⑥, ①b; holes; blind bars) | bars, ind, items, rules, types, const |
| `lawsearch-trade.ts` | C | spec 7, 8.1, 8.8; the follow-bar checks of 15 | bars, events, rules, types, const |
| `lawsearch-stats.ts` | C | 8.2–8.6, t and p, z, medians, 95% points, κ | trade, rules, types, const |
| `lawsearch-select0.ts` | D | spec 9 (stage 0's counts, floor, same trial, groups, MDE, marks) | bars, events, items, rules, types, const; money-stats (tQuantile only) |
| `lawsearch-select.ts` | D | spec 10, 11, 13 | stats, trade, select0, rules, types, const |
| `lawsearch-checks.ts` | D | spec 15 (rules sha256, data, cut, poison, presence, h1Only, adds up, items' checks, print list) and 13 (iv) | bars, ind, items, events, rules, types, const |
| `lawsearch-stage0.ts` | D | stage 0 as its own program (spec 9's import rule) | bars, ind, items, events, select0, checks, dump |
| `lawsearch-dump.ts` | D | writes `lawsearch-dump.md`'s files | types, rules, const |
| `lawsearch-hand.ts` | D | the hand runner | everything |
| `lawsearch.ts` | D | the program: modes, gates, the pipeline | everything |
| `lawsearch-flip.ts` (written in C2; listed C3) | D | spec 14.2's flip conditions on the exact mirror (23.1), 7.9 | const, rules, bars, gen, items, events, checks, stage0, trade, types |
| `lawsearch-par.ts` (written in C4b; listed C4c, 2026-11-07) | D | the worker pool (`WorkerPool`) that runs the units of the checks cut, poison and presence on `WORKERS` workers (7.3, 7.7, 12.1) | checks and types (types only) |
| `lawsearch-par-worker.ts` (written in C4b; listed C4c, 2026-11-07) | D | one worker: answers each job with `lawsearch-checks.ts`'s `runUnitJob`; reads no file and no environment, writes nothing | checks, types |
| `.github/workflows/lawsearch.yml` | D | CI | — |
| `research/money-stats.ts` (+1 export) | C | U(x, ν) of spec 8.5 | — |

(C4c, 2026-11-07) `lawsearch-candat-check.ts`, C4b's CI guard for `candidatesAt`, is deleted with `candidatesAt`
(7.8, 12 rule 2). `lawsearch.ts` imports `lawsearch-par.ts`; the worker module is not imported by any module but
started by the pool as a Web Worker (so `deno info` of a program does not list it), and it imports only
`lawsearch-checks.ts` (stage-0 safe) and the types.

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
export function writeRun(dir: string, spec: GenSpec): Promise<GenManifest>;              // <dir>/gmo/… and <dir>/manifest.json
```

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
export function parseCandidates(json: unknown): TrialDef[];   // the ledger: 1,364 rows, order 1..1364; "15min" → "m15", "1hour" → "h1"; throws on any other shape
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
export function exclCtxOf(tf: TfSet, avoid: ReadonlySet<string>, fromMs: number, toMs: number, stage3?: ExclCtx["stage3"], plant?: string): ExclCtx;
export function reasonOf(ctx: ExclCtx, s: Series, i: number, warmOk: boolean): ReasonCode;   // ① … ⑥ first match, for an emitted candidate or a blind bar
export function classify(ctx: ExclCtx, s: Series, c: Candidates): Classified;
export function trialSignals(trial: TrialDef, tf: TfSet, inds: Ind[], ctx: ExclCtx, o?: CandOpts): TrialSignals;
export function blindBarsOf(ctx: ExclCtx, tf: TfSet, half: HalfName): Uint8Array[];   // per pair: 1 = T in the half and ②–⑥ pass
export function avoidOf(text: string): ReadonlySet<string>;          // parseSpreadHours(text, PAIRS); the caller has checked the sha256
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

**reasonOf** (spec 6; X = T + `N_BARS` × step), first match:

1. ① and ①b: `halfOf`. It returns first or second (or stage3) when the half's rule holds. It returns `r1b` when
   START ≤ T < SPLIT and the first half's rule fails. Otherwise it returns `r1`.
2. Then `r1w` when `!warmOk`. The warm-up is ignored for ①b.
3. Then r2; r3 (with sFrom = `s.s[max(0, i − R3_BACK)]`); r4; r5; r6; otherwise counted.

The blind table's bars use `warmOk = true`.

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
export function followBarChecks(tf: TfSet, table: BlindTable): CheckResult;   // spec 15 追う足 (i) and (ii)
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
export function poisonCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { n: number; seed: number; answerKnowing: boolean; plant: string; only?: string[] }): CheckResult;
export function presenceCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { seed: number; answerKnowing: boolean; plant: string; only?: string[] }): CheckResult;
export function h1OnlyCheck(u1: Universe): CheckResult;                       // every bar of stage 1 has T ≤ SPLIT
export function sameFirstHalfCheck(s0: TrialSignals[], s1: TrialSignals[]): CheckResult;   // stage 1's first-half counted sets = stage 0's
export function addsUpCheck(rows: ReadonlyArray<{ trial: string; addsUp: boolean }>): CheckResult;
export function donchianCheck(u: Universe, inds: Record<TfKey, Ind[]>): CheckResult;   // E26's s = bigflow-lib donchianState(c, 20), all bars
export function retraceCheck(runDir: string, rows: ReadonlyArray<{ pair: string; tf: TfKey; T: number; d: 1 | -1; pl: number; m: number }>): Promise<CheckResult>;   // 13 (iv): raw files, no loadTf
export const PRINT_KEYS: readonly RegExp[];
export function printCheck(keys: readonly string[]): CheckResult;            // 15 出してよい項目
export function sampleOf<T>(xs: readonly T[], n: number, seed: number): T[];  // mulberry32 + Fisher–Yates (trend-stats'), the first n
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
        universes are loaded separately, so they share no memory block either.

      Until C4e the cut prefix (and before C4d B06's window) was a set of subarray views of the uncut arrays, so this
      did not hold for the cut. The only `.subarray(` calls left in `research/lawsearch*.ts` are the sources of a copy
      (`poisonSeries` twice, `deleteBars`) and the dump writer; the hand job's grep step keeps it so as defense in depth
      (7.8 hand step 9).
  - C4b's `candidatesAt` (the per-bar body run at bar k alone after `prepare`) is gone, and with it the CI step that
    sampled it (7.8). Reason: 12 rule 2.
  - Units share only what sees the same series. At one cut target, the cut's holes and the cut's Ind (with the builds
    kept on that Ind, `BUILDS`) are made once and read by every trial decided at that target. Poison's uncut holes
    (when the caller gives none) and its poison tables are made once per check in the main thread, or once per task
    on each worker, from that thread's copy of the uncut series (12.1).
  - The uncut decision ("want") is made in the main thread from the run's own signals (`decisionOfClassified`). A
    unit returns its decision only when it differs from want. The check then replays the units in its own order
    (target by target, trial by trial; probe by probe) and does there everything its loop did: `compared`, the
    examples, the rows of cut_fail.csv, the planted mark.
  - A unit runs in the main thread (`inPlace`, `WORKERS=0`) or on a worker (`lawsearch-par.ts`, `WORKERS` ≥ 1; 7.7).
    The answers are replayed in job order, so the files are the same bytes for any `WORKERS` (12 rule 3).
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
- **retraceCheck**: reads `<run>/gmo/<SYM>/<interval>/<side>/<key>.json` with JSON.parse. It finds the entry and exit
  bars by openTime (keys from jstDayKey; no loadTf, no mergeSides), recomputes pl and m in points, and compares.
- **PRINT_KEYS** lists the key patterns of `print.txt`. Any other key stops the print.

### 7.4 `research/lawsearch-stage0.ts`

```ts
export function runStage0(u: Universe, trials: TrialDef[], cfg: RunConfig, avoid: ReadonlySet<string>, o: { answerKnowing: boolean; plant: string; dumpDir: string | null }): Promise<{ sigs: TrialSignals[]; rows: Stage0Row[]; checks: CheckResult[] }>;
if (import.meta.main) { /* MODE=stage0 on real data later: refuses now (7.7) */ }
```

It runs indicators, signals, `blindBarsOf` for both halves, `stage0`, and the stage-0-safe checks (data, adds up,
donchian, cut, poison, presence). It writes the stage-0 dumps when `dumpDir` is given. `lawsearch.ts` calls it
in-process for syn and walkfiles.

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
  - The pool is made after gate 3, before the pipeline starts. Its workers start at the first check that uses them
    and are closed when the run ends. At each run of the pool (a cut check: one per timeframe; poison and presence:
    one per check) the universe being
    checked is sent to each worker again before its first job of that run (a structured clone: about 100 MB per
    worker in the small trial; C4c measured a peak RSS of 2.9–3.4 GB for a whole run at `WORKERS=4`).
  - A unit's error is thrown again at that unit, in the check's order and with the same message, as the check's loop
    threw it before C4b (the program tells a STOP or a refusal by its message, so they stay what they were). A worker
    that dies stops the run with exit 1.
  - The yml sets `WORKERS: "4"` for every job (7.8), and its hand step 8 runs the refusal. (C4d, 2026-11-07) One
    step sets `WORKERS: "0"`: the `cmp-c-7101` step that compares the bytes at `WORKERS=0` and 4 (7.8 syn step 3).
    (C4e, 2026-11-08) That step now runs in three jobs, `w0-n-1001`, `cmp-c-7101` and `o-6003`, and it is still the
    only step that runs the pipeline at `WORKERS=0` (hand step 8's control `0` stops on its first read).

The gates run in order, before any bar is read (before them, the real modes are refused, then `MODE`, `LS_PLANT`,
`CUT_MAX` and `WORKERS` are checked; each refusal is exit 2):

1. `checkRulesFiles()`.
2. Every requested trial is built (`trialBuilt`); otherwise refuse and name the first one that is not.
3. The run folder has `manifest.json` whose version is GEN_VERSION, whose `treeSha256` matches the folder, and whose
   path has no `.cache`.
4. Plant `avoidFull` reads `research/ledger/spread-hours.csv` as the avoid table. The sha256 check of the table
   actually read then fails, and the run exits 3.

The pipeline (syn and walkfiles; one process):

1. `config.json`.
2. **Stage 0**: U0 = `loadUniverse(src, S0, END, syn0)`, then `runStage0`. Dumps: load, bars, htf, holes, ind,
   signals, stage0. (C4a, 2026-11-05; the lead's E5) bars, htf, ind and signals hold second-half material of every
   trial: they are sealed until stage 2 (`lawsearch-dump.md` 12), as is `cut_fail.csv`.
3. **Stage 1**: U1 = `loadUniverse(src, S0, SPLIT, syn1)`, `h1OnlyCheck`, signals again, then `sameFirstHalfCheck`.
   - Blind first-half tables and late tables (m15, h1), `trialRows`, `measureTrial` (floor-passing, not-same trials;
     D_F of (E, F01) against S01 of the same timeframe), and `measureBlindRows`.
   - `suspectOf`. For hit rows, 13 (i) cut on all their signals, (ii) poison 1,000 (seed 419), (iii) presence, and (iv)
     `retraceCheck` on 6 trades. (v) is "not-run", so a hit row is not selectable (11 O-5).
   - `followBarChecks`, `failRuleOf`, `chooseStage1` and `stage1Explain`.
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

Deno permissions: `--allow-read=. --allow-write=research/out --allow-env` (and the scratch folder when a builder
runs locally). No `--allow-net`. The constant `TRIAL_PASSED_SHA256: string | null = null` lives in `lawsearch.ts`,
and the lead sets it after the trial passes.

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
  hand:     # deno check; the stage-0 graph; TS hand; Python hand; the hand plants; no read through a memory block (C4e); real modes, CUT_MAX, WORKERS refused
  syn:      # needs hand; matrix of 10's runs (+ w0-n-1001, C4e); TS syn → Python --run (recompute + compare); the run plants; WORKERS=0 vs 4 (three jobs); uploads research/out/lawsearch/** as an artifact
```

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
     - What it does: `grep -nE '\.buffer\b|byteOffset|ArrayBuffer|DataView|\.subarray\('` over
       `research/lawsearch*.ts`; lines whose text is a comment alone (`//` after blanks) are dropped; each other line
       becomes `<file>: <its text without leading blanks>`. The step fails (exit 1) when such a line is not, as a
       whole line, in its allow-list, and prints those lines. It also prints, for information only, any allow-list line
       it no longer finds.
     - The allow-list (10 lines) and why each is allowed (the step's comment says the same):
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
- (C4b, 2026-11-05; written here C4c, 2026-11-07) The workflow sets `WORKERS: "4"` for every job (GitHub's
  `ubuntu-latest` runner has 4 vCPUs), so every run step's checks run their units on 4 workers. No step compares two
  `WORKERS` values: that the bytes do not depend on it (12 rule 3) is shown by local runs (12.1).
  - (C4d, 2026-11-07; the lead's F2) Superseded in part: one step of the `cmp-c-7101` job now runs at `WORKERS=0`
    and compares its bytes with the same plant's `WORKERS=4` dump (syn step 3). It is defense in depth, not a guard
    by construction (12.2 (2)). Every other run step still runs at `WORKERS=4`.
  - (C4e, 2026-11-08; the lead's G2) That step now runs in the jobs `w0-n-1001`, `cmp-c-7101` and `o-6003`, each on
    the job's own clean run, not on a plant (syn step 3). Every other run step still runs at `WORKERS=4`.
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
         not run on a real `MODE=syn` dump, nor in GitHub Actions.
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
  4. O's runs expect exit 3, the cut and poison checks failed, and the E26 rows' suspicion hit. (C3, 2026-11-05; the
     lead's D8) They now end before stage 2. The O step still requires the cut and poison failures on the four E26
     trials, their stage-1 suspicion hits, and no other failed check; it also requires that stage 2 was not opened
     (no `stage2` row in checks.csv, no stage2.csv, and print.txt's `note.stage2` says "not opened").
  5. The flip job (from 2026-11-05, spec 23.1): `research/lawsearch-flip.ts <FLIP=0 run> <FLIP=1 run>` judges 14.2's
     conditions on the exact mirror of the FLIP=0 run (built from its files, nothing written) and prints the FLIP=1
     run's dump differences as INFO lines; then `--run` on the FLIP=1 run (the TS–Python comparison). (C3) The tool
     is tied to the run it judges (7.9).
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

The names of the three C3 run plants, `dropSecondStrata`, `blindRowHit` and `chosenCutFirstDiff`, were confirmed by
the lead 2026-11-05 (C4a). (C4d, 2026-11-07) The lead confirmed `lastBarStateG3` and `lastBarStateG5` in C4d's
task. `carriedCountB06` is the name the lead's task gave as an example; it is for the lead to confirm (11 O-14).
(C4e, 2026-11-08) `carriedCountS01` and `bufferReadE04` are the names the lead's C4e task gave as examples, taken by
the C4e integrator; they and `carriedCountB06` are for the lead to confirm (11 O-15).
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
| E, cross (E04), with F00 and F01 | E04.F00, E04.F01 | `lastBarStateG3`, `lastBarStateG5` (cut); `bufferReadE04` (cut, poison, presence; new in C4e); `chosenCutFirstDiff` (h1.E04.F00, `cut.chosen.first`); `reasonUsesFuture` (presence) |
| E, hold (E26), with F00 and F01 | E26.F00, E26.F01 | `lastBarStateG3`, `lastBarStateG5` (cut); `reasonUsesFuture` (h1.E26.F00's cut; presence); set O (cut, poison, the stage-1 `suspect13` checks) |
| S, state (S01: F01's f) | S01 | `carriedCountS01` (cut; new in C4e, inside `candidatesOf`'s loop); `reasonUsesFuture` (cut and presence, through the reason path, not the loop) |
| B, condition (B06) | B06 | `carriedCountB06` (cut); `lastBarStateG3`, `lastBarStateG5` (cut); `reasonUsesFuture` (presence) |

The F kinds reached are F00 (no filter) and F01 (EMA200) only.

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
For the lead: 11 O-15.)

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
| PLANT-* | walkfiles on CMP-N 1001's and CMP-C 7101's files (OUT `<RUN>/plant-<name>`), and the hand examples | Each plant of 8 is caught by its named check (C3: `dropSecondStrata` and `blindRowHit` on CMP-N 1001, `chosenCutFirstDiff` on CMP-C 7101; C4c: `lastBarStateG3` and `lastBarStateG5` on CMP-C 7101, by stage 0's `cut`; C4d, 2026-11-07: `carriedCountB06` on CMP-C 7101, by stage 0's `cut` on m15.B06 or h1.B06, and `lastBarStateG3` again at `WORKERS=0`, the same bytes as at `WORKERS=4`; C4e, 2026-11-08: `carriedCountS01` and `bufferReadE04` on CMP-C 7101, by stage 0's `cut` on an S01 or an E04 trial; the `WORKERS=0` comparison no longer runs a plant but the clean runs CMP-N 1001, CMP-C 7101 and O 6003, 7.8 syn step 3). |
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
       (7e4dfcc) the cut passed `bufferReadE04`.
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
     with T > T_i) and alt[k0 & 1]'s bars from k0 on.
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
   - CI: every run step runs at `WORKERS=4` and is compared with the Python (`--run`) or checked by the O and plant
     steps; hand step 8 (the refusal). No CI step compares two `WORKERS` values. (C4d, 2026-11-07) Superseded: the
     `cmp-c-7101` job now compares `lastBarStateG3` at `WORKERS=0` with its `WORKERS=4` dump, byte for byte (7.8 syn
     step 3). It is defense in depth for rule 3, not a guard by construction. (C4e, 2026-11-08) The step now
     compares the clean runs N 1001 (`w0-n-1001`), C 7101 and O 6003: stage 0's pool runs, `cut.chosen.first` and
     `cut.chosen.second` on both timeframes, and stage 1's `suspect13` checks; not stage 2's `suspect13` checks (7.8
     syn step 3).
   - Local: C4c's C 7101 `reasonUsesFuture` at `WORKERS` 0, 1 and 4 (77 of 77 files identical, and identical to
     C4b's); the C4c restore designer's runs at 0, 1 and 3; C4b's at 0, 1 and 2. (C4d, 2026-11-07) C4d's:
     `lastBarStateG3` at `WORKERS=0` against 4 (the yml step as extracted: exit 0, 77 files equal) and
     `reasonUsesFuture` at `WORKERS=1` against 4 (77 of 77, and equal to C4c's kept files). (C4e, 2026-11-08)
     C4e's: the new step on N 1001, C 7101 and O 6003 (exit 0; 85, 83 and 77 files equal), and on the mutants mutR,
     M (on 7e4dfcc) and M2 (exit 1; 7.8 syn step 3).
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
- **CI time.** Local seconds on this 4-CPU VM that day, at `WORKERS=4` unless named. GitHub was NOT measured:
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
