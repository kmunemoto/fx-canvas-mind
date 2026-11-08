// 法則探し (docs §8.136, research/lawsearch-spec.md): spec 5 (the signals of a trial: ① condition, ② rising edge,
// ③ the item's keep rules, ④ F, ⑤ both directions) and spec 6 (the exclusions ①–⑥ and ①b, the holes of ③, the
// blind bars of 8.1) (builder B, research/lawsearch-design.md 5.3).
//
// Every exclusion is decided by the clock and the bars closed by T only (spec 6, 15). The one planted error that
// reads later bars is reasonUsesFuture (r3), and it exists to be caught by spec 15's cut and presence checks.

import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { avoidKey, parseSpreadHours, seasonOf, slotOf } from "./spreadhours-lib.ts";
import { DAY, HOUR, MINUTE, WEEK } from "./lib.ts";
import { END, N_BARS, PAIRS, SPLIT, START, STEP, WK, wk } from "./lawsearch-const.ts";
import { HOLE_MIN_SLOTS, OPEN_MIN_PAIRS, R2_MINUTES, R3_BACK, REASONS, STATUS } from "./lawsearch-rules.ts";
import { isGmoHoliday } from "./lawsearch-bars.ts";
import { answerKnowingE26, filterOf, itemOf, notBuilt, sFilterOf } from "./lawsearch-items.ts";
import type {
  Candidates,
  Classified,
  ExclCtx,
  FilterBuild,
  FilterDef,
  HalfName,
  HalfOf,
  Holes,
  Ind,
  ItemBuild,
  ItemDef,
  ItemKind,
  ItemParams,
  Pair,
  ReasonCode,
  Series,
  TfKey,
  TfSet,
  Tri,
  TrialDef,
  TrialSignals,
} from "./lawsearch-types.ts";

const ST_EMIT = STATUS.indexOf("emit");
const ST_F_NONE = STATUS.indexOf("f_none");
const ST_BOTH = STATUS.indexOf("both");
// no row at a bar in one direction (candidatesOf)
const NONE = -1;
const REASON_INDEX: Readonly<Record<ReasonCode, number>> = Object.fromEntries(REASONS.map((r, k) => [r, k])) as Record<ReasonCode, number>;

// ---- spec 5 ----------------------------------------------------------------------------------------------------

export interface CandOpts {
  // the hand examples' shrunk windows (a run never passes any)
  params?: ItemParams;
  // noRisingEdge (spec 16: 立ち上がりを見ない)
  plant?: string;
  // set O (spec 14.2): E26 from answerKnowingE26
  answerKnowing?: boolean;
}

const itemFor = (id: string, o?: CandOpts): ItemDef => (o?.answerKnowing && id === "E26" ? answerKnowingE26() : itemOf(id));

// spec 5 ⑤ on the rows of one trial and one pair, in bar order (buy before sell): when both directions are still
// emitted at one bar, both become "both" (counted as signals: two per bar). Returns how many rows it marked.
// candidatesOf calls it; it is exported for the hand example of ⑤ alone (A.3.29).
export function applyBoth(i: ArrayLike<number>, d: ArrayLike<number>, status: Uint8Array): number {
  let marked = 0;
  for (let k = 0; k + 1 < i.length; k++) {
    if (i[k] !== i[k + 1] || status[k] !== ST_EMIT || status[k + 1] !== ST_EMIT || d[k] === d[k + 1]) continue;
    status[k] = ST_BOTH;
    status[k + 1] = ST_BOTH;
    marked += 2;
  }
  return marked;
}

// Spec 5's order on one trial and one pair's Ind:
//   ① the condition per direction (the item's build; an S row reads its F's f);
//   ② the raw signal: cross: the formula is true at i; condition and hold: true at i, false (not 無し) at i − 1, and
//      i is not the first bar after S0 whose condition is not 無し; state: F(d) true at i (no rising edge, no 無し
//      rules). Plant noRisingEdge: condition and hold emit every true bar;
//   ③ the item's keep rule drops the raw signal (uncounted); the condition array is not changed, so the next bar
//      still compares with ①'s value (§8.113 5, A.4.34);
//   ④ the F of an (E, F) trial: 無し → f_none (counted apart, not emitted), false → dropped (uncounted), true → kept;
//   ⑤ both directions still kept at one bar → both (applyBoth).
// warmOk: the bar index is at or past the trial's warm-ups (E's and F's; the S's F; the B's), and the F's own warmOk.
//
// C4c ("restore"): candidatesOf is again ONE walk over every bar of the series it is given, in bar order: prepare (①
// and what ②–④ and the warm-up read: the builds, the kind, the first bar whose condition is not 無し), then
// b3a2c43's loop (②–④ at every bar i = 0 … n − 1), then finish (the typed arrays, ⑤ and the warm-up). There is no
// other way to get a trial's rows: the main run (trialSignals) and the checks of spec 15 (cut, poison, presence:
// lawsearch-checks.ts decisionOf) both call this function, the checks on their own cut, poisoned or edited series,
// and read the rows at the bar they compare. So a check's decision at bar k is made by the same code as the
// main run's decision at bar k, from the check's series alone, whatever that code reads: values after k (in a build
// or in the loop), state carried from one bar to the next, rows already emitted, or the series' length n (the cut
// series ends at k, so the loop ends there too; C4d: for every item, B06 included, since the cut no longer gives B06
// a 291-bar window, lawsearch-checks.ts cutGotAt), and however that code reads the series: through its elements or
// through its memory block (C4e: every series a check hands to decisionOf has arrays that hold its own bars only,
// lawsearch-bars.ts copyOf; before C4e a cut prefix was a view whose backing store held the uncut bars after k, and a
// read through it was not seen: plant bufferReadE04 below). This holds by construction for any change of the loop's
// body or of a build that keeps every build and cache keyed by the Ind and adds no module-level state that survives
// between candidatesOf calls (lawsearch-design.md 12.2 (2)): such state is not part of "the check's series alone", so the
// equality does not cover it (and it could also make the bytes depend on WORKERS, since the main thread and each
// worker hold their own copy of it). Within that condition it does not depend on the body keeping no state (C4b's
// candidatesAt, which ran the body at one bar alone, needed that; C4b's review, finding 1). The item's and the F's
// builds are kept per Ind (buildOf) for the trials that share the same Ind; see there.
//
// Plants lastBarStateG3 and lastBarStateG5 (C4c, development only; lawsearch-design.md 8): a look-ahead that mixes
// state carried across bars with the series' end: on the series' last bar, a raw signal is dropped when the last row
// emitted before it is exactly G = 3 (or 5) bars back. The main run drops nothing but at its own last bar; a cut at
// k drops raw signals at k, so the cut check must fail (C4b's review: b3a2c43 fails, C4b's candidatesAt did not).
// Plant carriedCountB06 (C4d, development only; C4c's review, M5/M6, the refuter's R1): the same on B06's path: per
// direction, the raw signals (②) of B06 are counted from bar 0; on the series' last bar a raw B06 signal is dropped
// when that count before it is odd. A cut walked from bar 0 counts as the main run does and drops at k, so the cut
// must fail on m15.B06 or h1.B06; B06's former 291-bar window gave at most one raw signal before k, never an odd
// count with a raw signal at k, so it missed this plant (exit 0, every file as the clean run's).
// Plant carriedCountS01 (C4e, development only; the lead's G4 on C4d's review: no run plant reached the S trials): the
// same as carriedCountB06 on S01's trials (a state item: its raw signal is F01's f = 1, spec 4.3), so that a run
// plant reaches the S path too; the cut must fail on m15.S01 or h1.S01.
// Plant bufferReadE04 (C4e, development only; the lead's G1 on C4d's review, the reviewer's P5 and the refuter's q1):
// on E04's trials, a raw buy signal is dropped when the next close is below this bar's close, a raw sell signal when
// it is above, the next close being read through C's memory block (storeOf below: a Float64Array over C's backing
// store from C's first element to the store's end), never as C[i + 1]. Until C4e the cut prefix was a view of the
// uncut arrays, so this read saw the uncut next close at the prefix's last bar k and the cut decided as the main
// run did (the cut passed; only poison and presence, which make fresh arrays, failed). Since C4e every series a
// check hands to decisionOf holds its own bars only (lawsearch-bars.ts copyOf), so at k there is no next close in
// the store and the cut must fail on an E04 trial.
export function candidatesOf(trial: TrialDef, ind: Ind, o?: CandOpts): Candidates {
  const p = prepare(trial, ind, o);
  const { n, cond, keep, fb, edge, first } = p;
  const plant = o?.plant ?? "";
  const lastGap = plant === "lastBarStateG3" ? 3 : plant === "lastBarStateG5" ? 5 : 0;
  // plants carriedCountB06 and carriedCountS01 (the header above): B06's or S01's trials only; raw0 and raw1 count the
  // raw signals at bars 0 … i − 1
  const carried = (plant === "carriedCountB06" && trial.kind === "B" && trial.b === "B06") || (plant === "carriedCountS01" && trial.kind === "S" && trial.s === "S01");
  // plant bufferReadE04 (the header above): E04's trials only; peek[i + 1] is the next close read through the store
  const peek = plant === "bufferReadE04" && trial.kind === "EF" && trial.e === "E04" ? storeOf(ind.series.C) : null;
  let raw0 = 0, raw1 = 0;
  const rows: CandRows = { i: [], d: [], s: [] };
  const rowsI = rows.i;
  const rowsD = rows.d;
  const rowsS = rows.s;
  // b3a2c43's loop over every bar i = 0 … n − 1, its body written out for the two directions (k = 0 buy, then k = 1
  // sell) with the per-direction arrays taken once per call instead of at every bar (C4c, for speed; the same tests
  // in the same order at every bar, and the same rows appended in the same order, buy before sell). That body was,
  // per k: ② raw = c[i] = 1 for cross and state, and for condition and hold without the rising edge (edge is false
  // for every kind but condition and hold, and under noRisingEdge), else c[i] = 1 && i ≥ 1 && c[i − 1] = 0 && i ≠
  // first[k]; no raw → no row; ③ keep[k][i] = 0 → no row; ④ fb.f[k][i] = −1 → f_none, = 0 → no row; otherwise emit.
  // The rows of bar i are appended after both directions are decided (so the plants read the rows before bar i).
  const c0 = cond[0], c1 = cond[1];
  const keep0 = keep === null ? null : keep[0], keep1 = keep === null ? null : keep[1];
  const f0 = fb === null ? null : fb.f[0], f1 = fb === null ? null : fb.f[1];
  const first0 = first[0], first1 = first[1];
  for (let i = 0; i < n; i++) {
    // buy (k = 0)
    let s0 = NONE;
    // ②
    if (c0[i] === 1 && (!edge || (i >= 1 && c0[i - 1] === 0 && i !== first0))) {
      // plants lastBarStateG3 / lastBarStateG5, carriedCountB06 / carriedCountS01 and bufferReadE04 (the header above)
      const dropped = (lastGap > 0 && i === n - 1 && rowsI.length > 0 && rowsI[rowsI.length - 1] === i - lastGap) || (carried && i === n - 1 && (raw0 & 1) === 1) || (peek !== null && i + 1 < peek.length && peek[i + 1] < peek[i]);
      raw0++;
      if (!dropped) {
        // ③
        if (keep0 === null || keep0[i] !== 0) {
          // ④
          if (f0 === null) s0 = ST_EMIT;
          else {
            const fv = f0[i];
            s0 = fv === -1 ? ST_F_NONE : fv === 0 ? NONE : ST_EMIT;
          }
        }
      }
    }
    // sell (k = 1), the same
    let s1 = NONE;
    if (c1[i] === 1 && (!edge || (i >= 1 && c1[i - 1] === 0 && i !== first1))) {
      const dropped = (lastGap > 0 && i === n - 1 && rowsI.length > 0 && rowsI[rowsI.length - 1] === i - lastGap) || (carried && i === n - 1 && (raw1 & 1) === 1) || (peek !== null && i + 1 < peek.length && peek[i + 1] > peek[i]);
      raw1++;
      if (!dropped) {
        if (keep1 === null || keep1[i] !== 0) {
          if (f1 === null) s1 = ST_EMIT;
          else {
            const fv = f1[i];
            s1 = fv === -1 ? ST_F_NONE : fv === 0 ? NONE : ST_EMIT;
          }
        }
      }
    }
    if (s0 !== NONE) {
      rowsI.push(i);
      rowsD.push(1);
      rowsS.push(s0);
    }
    if (s1 !== NONE) {
      rowsI.push(i);
      rowsD.push(-1);
      rowsS.push(s1);
    }
  }
  return finish(trial, ind, p, rows);
}

// plant bufferReadE04 (candidatesOf's header): the doubles of C's backing store from C's first element to the end of
// the store. On a series whose arrays hold its own bars only (every series since C4e: the main run's, as loaded, and
// every check's, lawsearch-bars.ts copyOf) that is C itself; on a view of a longer array it runs past the series' end.
const storeOf = (C: Float64Array): Float64Array => new Float64Array(C.buffer, C.byteOffset, (C.buffer.byteLength - C.byteOffset) / 8);

// what ②–④ and the warm-up read (prepare's result)
interface Prepared {
  n: number;
  kind: ItemKind;
  cond: [Tri, Tri];
  keep: [Uint8Array, Uint8Array] | null;
  // ④'s F (E × F trials only)
  fb: FilterBuild | null;
  // the warm-up: the index, and the F's own per-bar warmOk (F02), if any
  warm: number;
  fWarmOk: Uint8Array | null;
  edge: boolean;
  // the first bar whose condition is not 無し, per direction
  first: [number, number];
}
interface CandRows {
  i: number[];
  d: number[];
  s: number[];
}

// C4b ("free"): one Ind's builds of items and F's, kept while the Ind lives (a WeakMap keyed by the Ind), so that
// the trials on one Ind with the same item (or the same F; an S row's F is the F's own FilterDef) build it once. A
// build is a function of the Ind (its series and plant), the definition and params alone: kept only without params
// (a run never passes any; the hand examples' shrunk windows are built afresh each time), and keyed by the
// definition's id, with answerKnowingE26 apart (another item under E26's id). An Ind is made from one series (the
// uncut one, one cut target's prefix, one poisoned or edited copy) and never sees another, so a kept build is
// the build the next trial would make again from that same series: nothing passes between series. Nothing reads a
// build to change it (candidatesOf and the dump only read). This holds only because the cache is keyed by the Ind: a
// cache keyed by anything else (pair, trial, bar) or other module-level state would carry one series' values into
// another's, unseen by the checks and possibly different per WORKERS (lawsearch-design.md 12.2 (2)).
const BUILDS = new WeakMap<Ind, Map<string, ItemBuild | FilterBuild>>();
const buildOf = <B extends ItemBuild | FilterBuild>(ind: Ind, key: string, params: ItemParams | undefined, make: () => B): B => {
  if (params !== undefined) return make();
  let m = BUILDS.get(ind);
  if (!m) {
    m = new Map();
    BUILDS.set(ind, m);
  }
  const hit = m.get(key);
  if (hit) return hit as B;
  const v = make();
  m.set(key, v);
  return v;
};
const itemBuildOf = (id: string, ind: Ind, o?: CandOpts): ItemBuild => {
  const ak = !!(o?.answerKnowing && id === "E26");
  return buildOf(ind, `item:${id}${ak ? ":answerKnowing" : ""}`, o?.params, () => itemFor(id, o).build(ind, o?.params));
};
const filterBuildOf = (def: FilterDef, ind: Ind, o?: CandOpts): FilterBuild => buildOf(ind, `filter:${def.id}`, o?.params, () => def.build(ind, o?.params));

// ① and what ②–④ read (b3a2c43's code before the loop, the builds through buildOf; C4b)
function prepare(trial: TrialDef, ind: Ind, o?: CandOpts): Prepared {
  const plant = o?.plant ?? "";
  const n = ind.series.n;
  let kind: ItemKind;
  let cond: [Tri, Tri];
  let keep: [Uint8Array, Uint8Array] | null = null;
  let fb: FilterBuild | null = null;
  let warm: number;
  let fWarmOk: Uint8Array | null = null;
  switch (trial.kind) {
    case "EF": {
      if (trial.e === null || trial.f === null) return notBuilt(trial.id);
      const b: ItemBuild = itemBuildOf(trial.e, ind, o);
      fb = filterBuildOf(filterOf(trial.f), ind, o);
      kind = b.kind;
      cond = b.cond;
      keep = b.keep;
      warm = Math.max(b.warmup, fb.warmup);
      fWarmOk = fb.warmOk;
      break;
    }
    case "S": {
      // the S row's condition is its F's f, and its warm-up the F's (spec 4.3, 21.5)
      if (trial.s === null) return notBuilt(trial.id);
      const sf = filterBuildOf(sFilterOf(trial.s), ind, o);
      kind = "state";
      cond = sf.f;
      warm = sf.warmup;
      fWarmOk = sf.warmOk;
      break;
    }
    case "B": {
      if (trial.b === null) return notBuilt(trial.id);
      const b = itemBuildOf(trial.b, ind, o);
      kind = b.kind;
      cond = b.cond;
      keep = b.keep;
      warm = b.warmup;
      break;
    }
    default:
      return notBuilt(trial.id);
  }
  if (kind === "state" && trial.kind !== "S") throw new Error(`candidatesOf: ${trial.id}: an item of kind state`);
  const edge = (kind === "condition" || kind === "hold") && plant !== "noRisingEdge";
  // the first bar whose condition is not 無し, per direction
  const first: [number, number] = [cond[0].findIndex((v) => v !== -1), cond[1].findIndex((v) => v !== -1)];
  return { n, kind, cond, keep, fb, warm, fWarmOk, edge, first };
}

// the Candidates of the rows: ⑤ and the warm-up (b3a2c43's code after the loop, unchanged; C4b)
function finish(trial: TrialDef, ind: Ind, p: Prepared, rows: CandRows): Candidates {
  const len = rows.i.length;
  const out: Candidates = {
    trial: trial.id,
    tf: trial.tf,
    pi: ind.series.pi,
    n: len,
    i: Int32Array.from(rows.i),
    d: Int8Array.from(rows.d),
    status: Uint8Array.from(rows.s),
    warmOk: new Uint8Array(len),
  };
  // ⑤
  applyBoth(out.i, out.d, out.status);
  const { warm, fWarmOk } = p;
  for (let r = 0; r < len; r++) {
    const i = out.i[r];
    out.warmOk[r] = i >= warm && (fWarmOk === null || fWarmOk[i] === 1) ? 1 : 0;
  }
  return out;
}

// ---- spec 1 and 6 ① ①b ------------------------------------------------------------------------------------------

// Where (T, X) falls (spec 1): first: START ≤ T, wk(T) ≤ 2888, X ≤ SPLIT; second: T ≥ SPLIT, X ≤ END; r1b (①b):
// START ≤ T < SPLIT otherwise; r1 (①) otherwise. With stage 3 (spec 12) the halves are not read: stage3 when T ≥
// from and X ≤ end, r1 otherwise (①b does not exist in stage 3). Plant splitShift: SPLIT one week later (and its
// week 2889 the first half's last).
export function halfOf(T: number, X: number, stage3: ExclCtx["stage3"], plant = ""): HalfOf {
  if (stage3) return T >= stage3.from && X <= stage3.end ? "stage3" : "r1";
  const split = plant === "splitShift" ? SPLIT + WEEK : SPLIT;
  const lastWeek = plant === "splitShift" ? WK.FIRST_HALF_LAST + 1 : WK.FIRST_HALF_LAST;
  if (T >= START && wk(T) <= lastWeek && X <= split) return "first";
  if (T >= split && X <= END) return "second";
  if (T >= START && T < split) return "r1b";
  return "r1";
}

// ---- spec 6 ② ④ ⑤ ⑥ (the clock only) ------------------------------------------------------------------------------

// ②: T, T + 1 min and T + 3 min are all isPossiblyClosed (Friday 21:00 UTC on, Saturday, Sunday before 22:00)
export function r2(T: number): boolean {
  return R2_MINUTES.every((m) => isPossiblyClosed(T + m * MINUTE));
}

// spec 2 GMO の休み: [the day before 21:00, the day 21:00) UTC for 12/25 and 1/1 (no Saturday rule)
const holidayWindowsOf = (year: number): Array<readonly [number, number]> => [
  [Date.UTC(year, 11, 24, 21), Date.UTC(year, 11, 25, 21)],
  [Date.UTC(year - 1, 11, 31, 21), Date.UTC(year, 0, 1, 21)],
];

// the first Friday 21:00 UTC at or after t
const fridayCloseFrom = (t: number): number => {
  const day0 = Math.floor(t / DAY) * DAY;
  const dow = new Date(day0).getUTCDay();
  let f = day0 + ((5 - dow + 7) % 7) * DAY + 21 * HOUR;
  if (f < t) f += WEEK;
  return f;
};

// ④: [T, X) holds Friday 21:00 UTC (X > the first Friday 21:00 at or after T; X equal to it is kept), or holds a
// GMO holiday time (T < the holiday's end and X > its start)
export function r4(T: number, X: number): boolean {
  if (X > fridayCloseFrom(T)) return true;
  const y0 = new Date(T).getUTCFullYear();
  const y1 = new Date(X).getUTCFullYear();
  for (let y = y0; y <= y1 + 1; y++) {
    for (const [a, b] of holidayWindowsOf(y)) if (T < b && X > a) return true;
  }
  return false;
}

// ⑤: T in (Sunday 21:00, Monday 00:00] UTC, or in (a holiday's day 21:00, the next 00:00] (12/25 and 1/1)
export function r5(T: number): boolean {
  const d = new Date(T);
  const tod = T - Math.floor(T / DAY) * DAY;
  const dow = d.getUTCDay();
  if (dow === 0 && tod > 21 * HOUR) return true;
  if (dow === 1 && tod === 0) return true;
  const y = d.getUTCFullYear();
  for (const [mo, da] of [[11, 25], [0, 1]] as const) {
    for (const yy of [y, y - 1]) {
      const end = Date.UTC(yy, mo, da, 21);
      if (T > end && T <= end + 3 * HOUR) return true;
    }
  }
  return false;
}

// ⑥: the entry slot (pair, seasonOf(T), slotOf(T)) or the exit slot (pair, seasonOf(X − 1 min), slotOf(X − 1 min))
// is avoided (spreadhours-lib's season and slot)
export function r6(avoid: ReadonlySet<string>, pair: Pair, T: number, X: number): boolean {
  if (avoid.has(avoidKey(pair, seasonOf(T), slotOf(T)))) return true;
  const e = X - MINUTE;
  return avoid.has(avoidKey(pair, seasonOf(e), slotOf(e)));
}

// ---- spec 6 ③ --------------------------------------------------------------------------------------------------

// C4b ("share"): whether slot a is ②'s time or a GMO holiday time (r2(a) || isGmoHoliday(a)) reads the clock alone (no
// bar, no series, no plant), so it is one value for every holesOf call that meets slot a, whatever series it is given
// (the uncut run's, a cut target's, a presence probe's): it is computed once per slot, the first time a call meets its
// block of CLOCK_BLOCK slots, and kept (per step; slot number = a ÷ step). Every bar-dependent part of the holes
// (present, the count of pairs, the runs) is still computed from the starts the call is given.
const CLOCK_BLOCK = 4096;
const CLOCK = new Map<number, Map<number, Uint8Array>>();
const clockBlock = (step: number, b: number): Uint8Array => {
  let m = CLOCK.get(step);
  if (!m) {
    m = new Map();
    CLOCK.set(step, m);
  }
  let block = m.get(b);
  if (!block) {
    block = new Uint8Array(CLOCK_BLOCK);
    for (let q = 0; q < CLOCK_BLOCK; q++) {
      const a = (b * CLOCK_BLOCK + q) * step;
      block[q] = r2(a) || isGmoHoliday(a) ? 1 : 0;
    }
    m.set(b, block);
  }
  return block;
};

// The slots of [fromMs, toMs) on the clock grid (fromMs rounded down to the step). A slot a is open when a, a +
// 1 min and a + 3 min are not all ②'s time, a is not a GMO holiday time, and at least 3 of the 5 pairs have a bar
// starting at a. A hole is a run of adjacent open slots where the pair has no bar, at least 2 slots on m15 and 1 on
// h1; a slot that is not open breaks the run. starts: per pair (PAIRS order), ascending bar starts.
export function holesOf(tf: TfKey, starts: ReadonlyArray<ArrayLike<number>>, fromMs: number, toMs: number): Holes {
  const step = STEP[tf];
  const a0 = Math.floor(fromMs / step) * step;
  const nSlots = Math.max(0, Math.ceil((toMs - a0) / step));
  if (starts.length !== PAIRS.length) throw new Error(`holesOf: ${starts.length} pairs, not ${PAIRS.length}`);
  const present = starts.map((ss) => {
    const p = new Uint8Array(nSlots);
    for (let k = 0; k < ss.length; k++) {
      const off = ss[k] - a0;
      if (off < 0 || off >= nSlots * step) continue;
      if (off % step !== 0) throw new Error(`holesOf: a ${tf} bar off the grid at ${new Date(ss[k]).toISOString()}`);
      p[off / step] = 1;
    }
    return p;
  });
  const open = new Uint8Array(nSlots);
  // the clock part of "open" (r2(a) || isGmoHoliday(a)) from the shared blocks (clockBlock): slot a = a0 + k × step is
  // slot number a0 ÷ step + k (a0 is a multiple of step, and every value here is an integer below 2^53, so both
  // ways give the same a)
  const slot0 = a0 / step;
  let blockNo = NaN;
  let block: Uint8Array = new Uint8Array(0);
  for (let k = 0; k < nSlots; k++) {
    const slot = slot0 + k;
    const b = Math.floor(slot / CLOCK_BLOCK);
    if (b !== blockNo) {
      blockNo = b;
      block = clockBlock(step, b);
    }
    if (block[slot - b * CLOCK_BLOCK] === 1) continue;
    let have = 0;
    for (const p of present) have += p[k];
    if (have >= OPEN_MIN_PAIRS) open[k] = 1;
  }
  const min = HOLE_MIN_SLOTS[tf];
  const hole = present.map((p) => {
    const h = new Uint8Array(nSlots);
    let k = 0;
    while (k < nSlots) {
      if (open[k] !== 1 || p[k] === 1) {
        k++;
        continue;
      }
      let e = k;
      while (e < nSlots && open[e] === 1 && p[e] === 0) e++;
      if (e - k >= min) h.fill(1, k, e);
      k = e;
    }
    return h;
  });
  return { tf, step, fromMs: a0, nSlots, open, present, hole };
}

// ③: some hole slot [a, a + step) of the pair overlaps [sFrom, T) with a positive length (a < T and a + step >
// sFrom; touching an end does not count). sFrom = s_{i−9}. Plant reasonUsesFuture: the window runs to X = T + N ×
// step instead of T (it reads the bars after T).
export function r3(h: Holes, pi: number, sFrom: number, T: number, plant = ""): boolean {
  const to = plant === "reasonUsesFuture" ? T + N_BARS * h.step : T;
  const hole = h.hole[pi];
  const kLo = Math.max(0, Math.floor((sFrom - h.fromMs) / h.step));
  const kHi = Math.min(h.nSlots - 1, Math.ceil((to - h.fromMs) / h.step) - 1);
  for (let k = kLo; k <= kHi; k++) {
    if (hole[k] !== 1) continue;
    const a = h.fromMs + k * h.step;
    if (a < to && a + h.step > sFrom) return true;
  }
  return false;
}

// ---- spec 6: the reasons in their order ---------------------------------------------------------------------------

// What the exclusions read besides the bar: the holes of [fromMs, toMs) of the timeframe's five pairs, the avoided
// slots of ⑥ (empty when question 3 is (b)), stage 3's period (null before stage 3), and the plant
export function exclCtxOf(tf: TfSet, avoid: ReadonlySet<string>, fromMs: number, toMs: number, stage3?: ExclCtx["stage3"], plant = ""): ExclCtx {
  return { tf: tf.tf, step: tf.step, holes: holesOf(tf.tf, tf.pairs.map((p) => p.s), fromMs, toMs), avoid, stage3: stage3 ?? null, plant };
}

// Spec 6, the first reason that applies, for an emitted candidate or a blind bar (X = T + N × step):
//   ① ①b by halfOf (①b first: a ①b signal counts as ①b even when its warm-up is short); then r1w (①: in a half but
//   before the trial's warm-up); then ② ③ (sFrom = s_{max(0, i − 9)}) ④ ⑤ ⑥; otherwise counted.
export function reasonOf(ctx: ExclCtx, s: Series, i: number, warmOk: boolean): ReasonCode {
  const T = s.T[i];
  const X = T + N_BARS * ctx.step;
  const h = halfOf(T, X, ctx.stage3, ctx.plant);
  if (h === "r1b" || h === "r1") return h;
  if (!warmOk) return "r1w";
  if (r2(T)) return "r2";
  if (r3(ctx.holes, s.pi, s.s[Math.max(0, i - R3_BACK)], T, ctx.plant)) return "r3";
  if (r4(T, X)) return "r4";
  if (r5(T)) return "r5";
  if (r6(ctx.avoid, s.pair, T, X)) return "r6";
  return "counted";
}

const HALF_CODE: Readonly<Record<HalfOf, number>> = { first: 1, second: 2, stage3: 3, r1: 0, r1b: 0 };

// Spec 6 on one pair's candidates: T, X and the half for every row (f_none and both included: the half is the
// half whose T and X rule holds, whatever the reason, as spec 9 counts f_none and both by it); the reason of an
// emitted row is reasonOf's, and f_none and both rows keep theirs.
export function classify(ctx: ExclCtx, s: Series, c: Candidates): Classified {
  if (c.tf !== ctx.tf) throw new Error(`classify: ${c.trial} is ${c.tf}, the context ${ctx.tf}`);
  if (c.pi !== s.pi) throw new Error(`classify: ${c.trial} pair ${c.pi}, the series ${s.pi}`);
  const T = new Float64Array(c.n);
  const X = new Float64Array(c.n);
  const reason = new Uint8Array(c.n);
  const half = new Uint8Array(c.n);
  for (let r = 0; r < c.n; r++) {
    const i = c.i[r];
    T[r] = s.T[i];
    X[r] = T[r] + N_BARS * ctx.step;
    half[r] = HALF_CODE[halfOf(T[r], X[r], ctx.stage3, ctx.plant)];
    if (c.status[r] === ST_F_NONE) reason[r] = REASON_INDEX.f_none;
    else if (c.status[r] === ST_BOTH) reason[r] = REASON_INDEX.both;
    else reason[r] = REASON_INDEX[reasonOf(ctx, s, i, c.warmOk[r] === 1)];
  }
  return { ...c, T, X, reason, half };
}

// A trial on the five pairs of its timeframe: candidatesOf, then classify (inds: per pair, PAIRS order)
export function trialSignals(trial: TrialDef, tf: TfSet, inds: Ind[], ctx: ExclCtx, o?: CandOpts): TrialSignals {
  if (trial.tf !== tf.tf || ctx.tf !== tf.tf) throw new Error(`trialSignals: ${trial.id} on ${tf.tf} (context ${ctx.tf})`);
  if (inds.length !== tf.pairs.length) throw new Error(`trialSignals: ${inds.length} Ind, ${tf.pairs.length} pairs`);
  const pairs = tf.pairs.map((s, pi) => {
    if (inds[pi].series !== s) throw new Error(`trialSignals: the Ind of pair ${pi} is not its series'`);
    return classify(ctx, s, candidatesOf(trial, inds[pi], o));
  });
  return { trial, tf: trial.tf, pairs };
}

// Spec 8.1's bars: per pair, 1 when the bar's T and X are in the half and ②–⑥ pass (warm-up met: the blind table
// has no item)
export function blindBarsOf(ctx: ExclCtx, tf: TfSet, half: HalfName): Uint8Array[] {
  if (ctx.tf !== tf.tf) throw new Error(`blindBarsOf: the context is ${ctx.tf}, the bars ${tf.tf}`);
  return tf.pairs.map((s) => {
    const out = new Uint8Array(s.n);
    for (let i = 0; i < s.n; i++) {
      const T = s.T[i];
      if (halfOf(T, T + N_BARS * ctx.step, ctx.stage3, ctx.plant) !== half) continue;
      if (reasonOf(ctx, s, i, true) === "counted") out[i] = 1;
    }
    return out;
  });
}

// ⑥'s table (research/ledger/spread-hours-h1.csv; the caller has checked its sha256): the avoided slots of the five
// pairs (parseSpreadHours stops on a missing, doubled or foreign row)
export function avoidOf(text: string): ReadonlySet<string> {
  return parseSpreadHours(text, PAIRS);
}
