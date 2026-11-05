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
| `.github/workflows/lawsearch.yml` | D | CI | — |
| `research/money-stats.ts` (+1 export) | C | U(x, ν) of spec 8.5 | — |

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
export function prefixSeries(s: Series, Tcut: number): Series;                          // bars with T ≤ Tcut (subarray views)
export function windowSeries(s: Series, from: number, to: number): Series;              // bars [from, to] (views; for a finite item's cut)
export function cutTfSet(tf: TfSet, Tcut: number, plant?: string): TfSet;               // every pair cut; htf and g rebuilt from the cut bars
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
- **cutTfSet**: `prefixSeries` on each of the five pairs, then `tfSetOf` (the higher bars rebuilt from the cut bars,
  so a forming higher bar exists exactly as it would have at Tcut).

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
export function bigmoveOf(s: Series, o: BigmoveParams): BigmoveOut;      // §8.113 C17 with 17.3's substitutions
export function bigmoveDefault(step: number): BigmoveParams;            // { 288, 250, 6, 2, 12 × step }
export function xUp(a: Float64Array, b: Float64Array | number): Tri;   // 3.1: a[i−1] ≤ b[i−1] && a[i] > b[i]; −1 when any of the 4 is NaN; −1 at i = 0
export function xDn(a: Float64Array, b: Float64Array | number): Tri;
```

- EMA, RMA and ATR go through pineEma, pineRma and pineAtr. RSI goes through pineRsi, and U and D are pineRma(up) and
  pineRma(dn) with up and dn as spec 3.2 gives them (the same arithmetic as inside pineRsi). The TR array is pineAtr's
  TR (TR[0] = H[0] − L[0]).
- The bar objects for pineAtr are made once per series.
- The higher Ind is `indOf(higher.series)`.
- bigmove:
  - `r[t] = Math.log(C[t] / C[t−1])`. It is usable when t ≥ 1 and `s_t − s_{t−1} ≤ gapMs`.
  - σ[i] needs i ≥ sigmaWindow. The usable r of r[i−W..i−1] must be at least sigmaMinUsable. The mean is the sum
    oldest first ÷ count. σ = `Math.sqrt(Σ (r − mean) * (r − mean) ÷ (count − 1))`, and it must be > 0.
  - `z[i] = Math.log(C[i] / C[i − moveBars]) / (σ[i] * Math.sqrt(moveBars))`, only when r[i−moveBars+1..i] are all
    usable.
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
  - At target k: `cutTfSet(tf, T_k)`, `indOf` on the cut pair, `candidatesOf`, and `classify` with
    `exclCtxOf(cut, …, fromMs: S0, toMs: T_k)`. The decision at k (presence, direction, status, warmOk), its reason
    and its stratum must equal the uncut run's.
  - The entry bar of every counted signal must be the uncut series' first start ≥ T and < X.
  - A finite item (B06: 291 bars, §8.113 C17) may be recomputed on `windowSeries(s, k − 290, k)` with its global
    index. Every other item in the trial uses the cut prefix from bar 0.
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
  419, on the hit trials). Every series of the five pairs (m15 and h1) is given `poisonSeries` after T, and the
  higher timeframes are rebuilt. Everything is recomputed. The decision and the reason at T must be equal.
- **Presence** (the same 100 signals):
  - (i) the first two bars with T > T_signal of the signal's pair, in the trial's timeframe, are deleted;
  - (ii) every bar with T > T_signal and start < the next Sunday 22:00 UTC, in the trial's timeframe of all five
    pairs, is deleted (11 O-8).

  The higher bars are rebuilt and everything recomputed. The decision must be equal.
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
  CAP`, and the Python's `--run` refuses it. The yml never sets `CUT_MAX`. (TS builder, C3: besides the checks'
  details, a capped run's print.txt has the key `note.cut_max` starting `DEVELOPMENT CAP`, since print.txt cuts a
  detail at 400 characters and a failing check's detail may not reach its cap text.) (C4a, 2026-11-05; the lead's
  E8) `note.cut_max` names every check the cap reaches: `cut`, `cut.chosen.first`, `cut.chosen.second`,
  `suspect13.cut.stage1` and `suspect13.cut.stage2` (7.3); so does the header comment of `lawsearch.ts`, which in C3
  says "all three cut checks". (E9) `checks.csv` gets no cap marker.

The gates run in order, before any bar is read:

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
  hand:     # deno check research/lawsearch*.ts; the stage-0 graph; TS hand; Python hand; the hand plants (TS and Python)
  syn:      # needs hand; matrix of 10's runs; TS syn → Python --run (recompute + compare); the run plants; uploads research/out/lawsearch/** as an artifact
```

- **hand**:
  1. `deno check` on every `research/lawsearch*.ts`.
  2. `deno info research/lawsearch-stage0.ts | grep -E "lawsearch-(trade|stats|select)\.ts"` must find nothing.
  3. `MODE=hand` exits 0.
  4. `python3 -I research/lawsearch-check.py --hand` exits 0.
  5. For each hand-level plant (8): `LS_PLANT=<p> MODE=hand` must exit 4, and at least one of 8's named examples must
     fail. The same for the Python's twins (`--hand --plant <p>`).
  6. Every real mode exits 2.
- **syn** (Python 3.11 + numpy; Deno 2.9.6): one job per run of 10.
  1. TS `MODE=syn`.
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
     says "not opened", and cut_fail.csv is written.
  4. O's runs expect exit 3, the cut and poison checks failed, and the E26 rows' suspicion hit. (C3, 2026-11-05; the
     lead's D8) They now end before stage 2. The O step still requires the cut and poison failures on the four E26
     trials, their stage-1 suspicion hits, and no other failed check; it also requires that stage 2 was not opened
     (no `stage2` row in checks.csv, no stage2.csv, and print.txt's `note.stage2` says "not opened").
  5. The flip job (from 2026-11-05, spec 23.1): `research/lawsearch-flip.ts <FLIP=0 run> <FLIP=1 run>` judges 14.2's
     conditions on the exact mirror of the FLIP=0 run (built from its files, nothing written) and prints the FLIP=1
     run's dump differences as INFO lines; then `--run` on the FLIP=1 run (the TS–Python comparison). (C3) The tool
     is tied to the run it judges (7.9).
- (C3, 2026-11-05; the lead's D5) No step sets `CUT_MAX` (the builder checks the yml); the Python's `--run` refuses a
  capped run (exit 2).
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

The names of the three C3 run plants, `dropSecondStrata`, `blindRowHit` and `chosenCutFirstDiff`, were confirmed by
the lead 2026-11-05 (C4a).

The Python twins (`--plant`, `lawsearch-py-design.md` 6) are: midHalfEven, midDecimalStr (Python only:
`Decimal(str(v))`), pointsTrunc, daySatSplit, splitShift, entryAtSignalClose, entryEarly, exitLate,
noSubstituteExit, blindNoHour, noBlind, inflStratumMean, shiftNoWrap, noHolm, iutOneLeg, c4PointOnly, noEx1Week,
noDF (PY1), and smaNewestFirst, noRisingEdge, htfOpen (PY2). Each must fail the same named examples in the Python's
hand run.

Set O (14.2: E26's direction from the next bar, `answerKnowingE26`) is not a 16 plant, but it belongs to the same
idea. On seeds 6001–6004, the cut and the poison must fail on every E26 trial, the E26 rows' suspicion lines must
hit, and the other checks must pass.

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
| PLANT-* | walkfiles on CMP-N 1001's and CMP-C 7101's files (OUT `<RUN>/plant-<name>`), and the hand examples | Each plant of 8 is caught by its named check (C3: `dropSecondStrata` and `blindRowHit` on CMP-N 1001, `chosenCutFirstDiff` on CMP-C 7101). |
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
    target only for the chosen trials (C3, the lead's D7).]
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
