// 法則探し (docs §8.136, research/lawsearch-spec.md): the shared types of the TS study. Types and interfaces only;
// no logic and no values (the rule constants are research/lawsearch-rules.ts, the frozen dates and sha256 are
// research/lawsearch-const.ts). The modules that build on these, their owners and their exact signatures are
// research/lawsearch-design.md; the files both implementations write for comparison are research/lawsearch-dump.md.
//
// Conventions (lawsearch-design.md 2):
//   * 無し (none) is NaN in a Float64Array and -1 in a Tri (Int8Array: 1 true, 0 false, -1 none);
//   * a direction is 1 (buy) or -1 (sell), held in an Int8Array; wherever both are listed, buy comes first;
//   * times are UTC epoch milliseconds, held in doubles (exact integers);
//   * points (spec 2: 1 point = 0.1 pip) are Int32;
//   * pairs are indexed 0..4 in PAIRS' order (lawsearch-const.ts), which is the spec's table order;
//   * a bar's index is its number of spec 2 (0 = the first usable bar at or after S0, gaps closed up).

import type { Bars } from "./trend-labels.ts";
export type { Bars };

// ---- names ------------------------------------------------------------------------------------------------

export type Pair = "USD/JPY" | "EUR/JPY" | "AUD/JPY" | "EUR/USD" | "AUD/USD";
// the two timeframes of the trials (the trial id's prefix) and the higher timeframe the h1 trials use
export type TfKey = "m15" | "h1";
export type SeriesKey = "m15" | "h1" | "h4";
// lawsearch-candidates.json's "tf"
export type TfName = "15min" | "1hour";
export type Dir = 1 | -1;
// per bar: 1 true, 0 false, -1 無し
export type Tri = Int8Array;
export type HalfName = "first" | "second" | "stage3";
// spec 1 and 6 ①: where a signal's (T, X) falls
export type HalfOf = HalfName | "r1" | "r1b";
export type StageName = "stage0" | "stage1" | "calib" | "stage2" | "stage3";
// the purpose a universe was loaded for (lawsearch-design.md 7.7)
export type LoadPurpose = StageName | "syn0" | "syn1" | "syn2" | "hand" | "cut";
// spec 2 季節の組 / 21.5 層の並び: 0 both winter, 1 both summer, 2 New York only summer, 3 London only summer
export type SeasonGroup = 0 | 1 | 2 | 3;
// spec 6 and 9 (lawsearch-rules.ts REASONS gives the index of each): counted, then the two drops of spec 5 ④ ⑤,
// then ① (r1: out of both halves; r1w: in a half, but before the warm-up), ①b, ② … ⑥
export type ReasonCode = "counted" | "f_none" | "both" | "r1" | "r1w" | "r1b" | "r2" | "r3" | "r4" | "r5" | "r6";
// spec 5's candidate status (lawsearch-rules.ts STATUS gives the index): emitted, dropped at ④ (F 無し), dropped at ⑤
export type CandStatus = "emit" | "f_none" | "both";
// spec 8.5's three SE candidates
export type SeKind = "week" | "4w" | "shift";
export type TrialKind = "EF" | "S" | "B" | "R";
// spec 5: how an item's condition becomes a signal
//   cross      the formula is the signal (X↑ etc. and E22/E23/E33/E34): true at i is a signal; no 無し rules
//   condition  rising edge of the state, with the two "no signal" bars of spec 5
//   hold       常に持つ型: rising edge of (target === d), with the two "no signal" bars
//   state      the S rows: every bar where F(d) is true
export type ItemKind = "cross" | "condition" | "hold" | "state";

// ---- bars (builder A: research/lawsearch-bars.ts) ----------------------------------------------------------

// What one loadTf call (pair, timeframe, fromMs, toMs) saw: spec 2's numbers and the data checks of spec 15
export interface LoadReport {
  purpose: LoadPurpose;
  pair: Pair;
  tf: TfKey;
  fromMs: number;
  toMs: number;
  // the day keys opened (YYYYMMDD, oldest first: jstDayKey(fromMs − 1 day) .. jstDayKey(toMs))
  keys: string[];
  // sides read (two per key)
  filesRead: number;
  // unreadable JSON, a body that is not sound() (ownerhold-data), or a missing file (a synthetic folder)
  readFailures: number;
  // spec 2 数にできない行: rows dropped by the value-form rules (both sides; non-object elements included)
  unparseableRows: number;
  // spec 2: values of the wrong form that parseKlines would read as finite numbers (the run stops when any)
  valueStops: string[];
  // spec 2 捨てた数 (Bid rows whose same-start Ask, the last row, closes below them; = loadTf's crossed)
  droppedAskLtBid: number;
  // spec 2 同じ始まりの行の数 (Bid rows with an earlier Bid row of the same start; = loadTf's repeated)
  sameStartBidRows: number;
  // spec 15: per UTC year of the row's start; num = the dropped rows above, den = Bid rows with a same-start Ask
  askLtBidByYear: Array<{ year: number; num: number; den: number }>;
  // bars kept (range and weekend applied), the first and last start (NaN when none)
  bars: number;
  first: number;
  last: number;
  // spec 15: bars where a side's low > min(open, close), high < max(open, close) or low > high
  ohlcBad: number;
  // spec 15: two bars with one start after the merge (0 by construction in TS; the Python's check)
  dupStarts: number;
  // spec 15: values outside the price band (synthetic runs: 0.25–2.5 times the walk's start)
  bandBad: number;
}

// One pair's bars of one timeframe as the study uses them (spec 2)
export interface Series {
  pair: Pair;
  pi: number;
  key: SeriesKey;
  // bar length in ms (900,000, 3,600,000 or 14,400,000)
  step: number;
  n: number;
  // start s_i and close T_i = s_i + step
  s: Float64Array;
  T: Float64Array;
  // the raw sides as read (Number of the file's decimal string)
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
  // the rounded mid (spec 2: Number(((bid + ask) / 2).toFixed(d)))
  O: Float64Array;
  H: Float64Array;
  L: Float64Array;
  C: Float64Array;
  // points: the mid's and both sides'
  Po: Int32Array;
  Ph: Int32Array;
  Pl: Int32Array;
  Pc: Int32Array;
  Bo: Int32Array;
  Bh: Int32Array;
  Bl: Int32Array;
  Bc: Int32Array;
  Ao: Int32Array;
  Ah: Int32Array;
  Al: Int32Array;
  Ac: Int32Array;
  // spec 2 日: D(s_i) as YYYYMMDD ((s + 3 h)'s UTC date, a Saturday moved to the Friday)
  day: Int32Array;
  // the key of the file the bar was read from (loadTf's; −1 for a higher-timeframe bar or a hand series)
  fileKey: Int32Array;
}

// One timeframe of the five pairs, with the higher timeframe made from it (spec 2 上位足)
export interface TfSet {
  tf: TfKey;
  step: number;
  // the higher timeframe's length (m15 → 1 hour, h1 → 4 hours)
  htfStep: number;
  // PAIRS order, always five (a pair without bars has n = 0)
  pairs: Series[];
  // per pair: the higher bars coarsened from pairs[pi] (both sides first, then the mid), numbered from S0
  htf: Series[];
  // per pair, per base bar i: the index of the last higher bar g with htf.s[g] + htfStep ≤ T_i, or −1
  g: Int32Array[];
}

export interface Universe {
  purpose: LoadPurpose;
  fromMs: number;
  toMs: number;
  m15: TfSet;
  h1: TfSet;
  load: LoadReport[];
  // spec 15 data checks that failed (empty: all passed); the stage prints no number when any
  problems: string[];
}

// ---- spec 6 ③ (builder B: research/lawsearch-events.ts) ----------------------------------------------------

// The slots of one timeframe on the clock grid [fromMs, fromMs + nSlots × step)
export interface Holes {
  tf: TfKey;
  step: number;
  fromMs: number;
  nSlots: number;
  // 1: an open slot (not ②'s time at a, a + 1 min, a + 3 min; not a GMO holiday at a; ≥ 3 of the 5 pairs have a bar)
  open: Uint8Array;
  // per pair: 1 when the pair has a bar starting at the slot
  present: Uint8Array[];
  // per pair: 1 when the slot is part of a hole (a run of adjacent open slots without the pair's bar, at least
  // HOLE_MIN_SLOTS[tf] long; a slot that is not open breaks the run)
  hole: Uint8Array[];
}

// What the exclusions of spec 6 read besides the bar
export interface ExclCtx {
  tf: TfKey;
  step: number;
  holes: Holes;
  // spreadhours-lib avoidKey(pair, season, slot) of the slots whose avoid is yes (parseSpreadHours)
  avoid: ReadonlySet<string>;
  // spec 12: stage 3's period, read in place of the two halves (absent before stage 3)
  stage3: { from: number; end: number } | null;
  plant: string;
}

// ---- indicators (builder B: research/lawsearch-ind.ts) -----------------------------------------------------

export interface RsiOut {
  // up[0], dn[0] 無し; U = RMA_p(up), D = RMA_p(dn); rsi by pineRsi
  up: Float64Array;
  dn: Float64Array;
  U: Float64Array;
  D: Float64Array;
  rsi: Float64Array;
}
export interface DonchianOut {
  // HH_n(i) = max H[i−n..i−1], LL_n(i) = min L[i−n..i−1] (無し for i < n); target s (0 from bar 0, never 無し)
  HH: Float64Array;
  LL: Float64Array;
  s: Int8Array;
}
export interface BigmoveParams {
  // §8.113 C17 with 17.3's substitutions: σ over r[i−288..i−1] with ≥ 250 usable; z over 6 bars; ±2;
  // r unusable after a gap over 12 × STEP (gapMs)
  sigmaWindow: number;
  sigmaMinUsable: number;
  moveBars: number;
  threshold: number;
  gapMs: number;
}
export interface BigmoveOut {
  // r[t] = ln(C[t] ÷ C[t−1]) (無し at bar 0); usable[t] = 1 when r[t] may be used; σ and z (無し where §8.113 says)
  r: Float64Array;
  usable: Uint8Array;
  sigma: Float64Array;
  z: Float64Array;
}

// The indicators of one series, computed on first use and kept (the app functions of spec 17.1, the research's
// own formulas of spec 3.2). Every array has the series' length; 無し is NaN.
export interface Ind {
  readonly series: Series;
  // the higher timeframe's indicators (F02) and the usable higher bar of each base bar; null for a hand series
  readonly higher: Ind | null;
  readonly g: Int32Array | null;
  // EMA_p of the mid close, by pineEma
  ema(p: number): Float64Array;
  emaOf(x: Float64Array, p: number): Float64Array;
  rmaOf(x: Float64Array, p: number): Float64Array;
  // SMA_p summed oldest first (spec 3.2; not pine.ts sma, which sums newest first)
  smaOf(x: Float64Array, p: number): Float64Array;
  // TR on the mid doubles (TR[0] = H[0] − L[0]) and ATR_p by pineAtr
  tr(): Float64Array;
  atr(p: number): Float64Array;
  rsi(p: number): RsiOut;
  donchian(n: number): DonchianOut;
  bigmove(o: BigmoveParams): BigmoveOut;
}

// ---- items, filters and trials (builder B: research/lawsearch-items.ts) ------------------------------------

// Shrunk windows of the hand examples (their "params"); a run never passes any
export interface ItemParams {
  // F01 / S01: EMA200 → EMA_ema
  ema?: number;
  // E04: RSI14 → RSI_rsi
  rsi?: number;
  // E26: donchian 20 → n
  donchian?: number;
  bigmove?: Partial<BigmoveParams>;
  // the item's warm-up k and the filter's, replaced
  warmup?: number;
  fWarmup?: number;
}

// An item's spec 5 ① (and ③) on one series
export interface ItemBuild {
  kind: ItemKind;
  // [buy, sell] per bar. cross: the formula (−1 when a value is 無し); condition: the state; hold: target === d
  // (−1 when the target is 無し); state: unused (the S rows read the filter)
  cond: [Tri, Tri];
  // spec 5 ③: the item's keep rules, applied after the rising edge (1 keep, 0 drop; B06's time exclusion);
  // null: keep every bar
  keep: [Uint8Array, Uint8Array] | null;
  // spec 5 温め: signals of bars with index ≥ warmup are kept, the others go to ① (r1w / r1)
  warmup: number;
  // the values the dump writes (lawsearch-dump.md 5: column name → array)
  columns: Record<string, Float64Array | Int8Array | Uint8Array>;
}
export interface ItemDef {
  // "E04", "E26", "B06" (an E or a B of the table)
  id: string;
  kind: ItemKind;
  warmup: number;
  build(ind: Ind, params?: ItemParams): ItemBuild;
}

// A filter F (spec 4.2) on one series
export interface FilterBuild {
  // [buy, sell] per bar: 1 true, 0 false, −1 無し (F が無し)
  f: [Tri, Tri];
  warmup: number;
  // per bar: 1 when the filter's warm-up is met (F02: the higher bar's index g ≥ 51); null: index ≥ warmup
  warmOk: Uint8Array | null;
  columns: Record<string, Float64Array | Int8Array | Uint8Array>;
}
export interface FilterDef {
  // "F00", "F01", …
  id: string;
  directional: boolean;
  warmup: number;
  build(ind: Ind, params?: ItemParams): FilterBuild;
}

// One row of research/ledger/lawsearch-candidates.json
export interface TrialDef {
  // "m15.E04.F01", "h1.S01", "m15.B06"
  id: string;
  // the table order (1-based, as the ledger)
  order: number;
  tf: TfKey;
  kind: TrialKind;
  e: string | null;
  f: string | null;
  s: string | null;
  b: string | null;
  name: string;
}

// ---- signals (builder B: research/lawsearch-events.ts) -----------------------------------------------------

// One trial on one pair after spec 5 ①–⑤: the bars where a signal stands, in bar order (buy before sell)
export interface Candidates {
  trial: string;
  tf: TfKey;
  pi: number;
  n: number;
  i: Int32Array;
  d: Int8Array;
  // lawsearch-rules.ts STATUS index: 0 emitted, 1 dropped at ④ (F 無し), 2 dropped at ⑤ (both directions)
  status: Uint8Array;
  // 1: the bar is at or past every warm-up of the trial (E's and F's, or the S's F; F02 per bar)
  warmOk: Uint8Array;
}
// The same after spec 6 (emitted rows get a reason; the f_none and both rows keep theirs)
export interface Classified extends Candidates {
  T: Float64Array;
  // X = T + N × step
  X: Float64Array;
  // lawsearch-rules.ts REASONS index
  reason: Uint8Array;
  // 0 none, 1 first, 2 second, 3 stage3: the half whose T and X rule (spec 1) the row meets, whatever its reason
  half: Uint8Array;
}
export interface TrialSignals {
  trial: TrialDef;
  tf: TfKey;
  // PAIRS order
  pairs: Classified[];
}

// ---- trades and blind tables (builder C: research/lawsearch-trade.ts) --------------------------------------

// spec 7: the entry bar j (first start ≥ T and < X) and the exit bar x (close = X, else the last bar with start
// ≥ s_j and close ≤ X; subst = 1 then)
export interface EntryExit {
  j: number;
  x: number;
  subst: boolean;
}
export interface Trade extends EntryExit {
  // m = d × (Pc[x] − Po[j]) (points), h = sign(m), pl (points): buy Bc[x] − Ao[j], sell Bo[j] − Ac[x]
  m: number;
  h: -1 | 0 | 1;
  pl: number;
}

// spec 8.1 (late: 8.8): every bar of one timeframe and half that passed ①–⑥ and has a trade, both directions,
// in 21.5's row order (T ascending, then pair, then buy before sell)
export interface BlindTable {
  tf: TfKey;
  half: HalfName;
  late: boolean;
  n: number;
  pi: Int8Array;
  // the signal bar (index in the timeframe's series) and its close
  i: Int32Array;
  T: Float64Array;
  d: Int8Array;
  // the trade's bars (late: in the 15-minute series)
  j: Int32Array;
  x: Int32Array;
  subst: Uint8Array;
  m: Int32Array;
  h: Int8Array;
  pl: Int32Array;
  absm: Int32Array;
  // the stratum's parts (late: of T + 15 min) and its id (lawsearch-design.md 2: ((pi × 2 + (d === 1 ? 0 : 1))
  // × 24 + hour) × 4 + season), and wk(T)
  hour: Uint8Array;
  season: Uint8Array;
  stratum: Int32Array;
  week: Int32Array;
  // the distinct weeks of the table, ascending (W_h of 8.5)
  weeks: Int32Array;
  // bars that passed ①–⑥ (each counts once, for both directions), and those of them without an entry bar
  passedBars: number;
  noTradeBars: number;
  // late only: rows of the normal table left out by 8.8 (no late entry bar, ④ at X + 15 min, past the period's end)
  lateExcluded: { noEntry: number; r4: number; end: number };
  // late only: the row of the normal table each late row comes from
  baseRow: Int32Array | null;
  // rowKey(pi, T, d) (lawsearch-trade.ts) → row; T is the signal's T (not T + 15 min) in the late table too
  index: Map<number, number>;
}

// One trial's counted signals of one half, as rows of the half's tables
export interface TrialRows {
  trial: string;
  tf: TfKey;
  half: HalfName;
  // counted signals (①–⑥ passed) of the half
  counted: number;
  // counted signals without an entry bar (spec 6 末尾: left out and counted)
  noTrade: number;
  // counted signals with a trade whose stratum has no blind row (must be 0; the run stops otherwise)
  noBlind: number;
  // rows of the BlindTable (ascending = row order) of the counted signals with a trade
  rows: Int32Array;
  // rows of the late table of the signals Δ_late keeps, and how many of rows were left out by 8.8
  lateRows: Int32Array;
  lateExcluded: { noEntry: number; r4: number; end: number };
}

// ---- measures (builder C: research/lawsearch-stats.ts) -----------------------------------------------------

export interface SeCand {
  kind: SeKind;
  // in the value's unit (Δ and a: points, after × 100; PL: pips); null when it cannot be made
  se: number | null;
  // clusters (week: C_week; 4w: C_4w; shift: C_week) and the degrees of freedom C − 1
  C: number;
  df: number;
  // shift only: the k used (K)
  K: number | null;
  // value ÷ se; null when there is no t (C < 2, N = 0, |se| < 1e−12, shift K < 2)
  t: number | null;
  // one-sided p (spec 8.5: U(x, ν) for x ≥ 0, 1 − U(−x, ν) for x < 0; 1 without t)
  p: number;
  // t(0.975, df) and t(0.975, df) × se (null without t)
  q975: number | null;
  halfWidth: number | null;
}
// spec 8.5 週ずらし of one value: k = 1 … W_h − 1
export interface ShiftRun {
  k: Int32Array;
  // signals left after the shift, and those dropped (no blind row at T′)
  n: Int32Array;
  dropped: Int32Array;
  // the value at each k (NaN: no signal left, the k is not used)
  v: Float64Array;
  // K (used k) and the k without a signal; SD_shift (two-pass, ÷ (K − 1); null when K < 2)
  used: number;
  skipped: number;
  sd: number | null;
}
// One value (Δ, a, PL, Δ_late, D_F, …) with its candidates and choices (spec 8.5)
export interface ValueEst {
  value: number | null;
  N: number;
  C_week: number;
  C_4w: number;
  // the 4-week candidate is used (C_4w ≥ 10)
  four: boolean;
  // week, then 4w (when four), then shift (when built for the value)
  cands: SeCand[];
  // every used candidate has a t
  hasT: boolean;
  // the candidate of the interval and LB (widest q975 × se) and of p (largest p); ties: week, 4w, shift
  useLB: SeKind | null;
  useP: SeKind | null;
  // the useP candidate's t; p (1 without t); value ∓ the useLB candidate's halfWidth (null without t)
  t: number | null;
  p: number;
  lb: number | null;
  ub: number | null;
  // S_g of the influence functions (before × 100), by cluster key ascending (4w: floor((wk − w0) ÷ 4))
  sums: { week: Map<number, number>; four: Map<number, number> };
  shift: ShiftRun | null;
  // stage 2: max(1, κ) applied to every candidate's se before the choices (1 otherwise)
  kappa: number;
}
// spec 8.2 of one stratum (in stratum-id order)
export interface StratumAgg {
  id: number;
  // n_s (signals with a trade), m_s (blind rows)
  n: number;
  m: number;
  // the signals' mean of h ÷ 2, B_s, the blind rows' mean of PL ÷ 10 and of |m| ÷ 10 (pips)
  sigMean: number;
  B: number;
  blindPlMean: number;
  absMMean: number;
}
// spec 8.4's explanatory numbers and 13's M
export interface PlExtras {
  // 1週を除いた PL (pips), the week left out (null when no signal), W count and rate
  plEx1w: number | null;
  ex1wWeek: number | null;
  wCount: number;
  wRate: number | null;
  // Σ_s (n_s ÷ N) × the blind PL mean, and PL − that; 13's M
  blindPlW: number | null;
  plMinusBlind: number | null;
  M: number | null;
  // PL (pips) and N by pair (PAIRS order; null when the pair has none) and by direction (buy, sell)
  plByPair: Array<number | null>;
  nByPair: number[];
  plByDir: [number | null, number | null];
  nByDir: [number, number];
}
// Every number of one trial (or one blind measure row) in one half (spec 8, 10, 11)
export interface TrialMeasures {
  trial: string;
  tf: TfKey;
  half: HalfName;
  counted: number;
  noTrade: number;
  noBlind: number;
  // weeks with a counted signal
  weeks: number;
  strata: StratumAgg[];
  delta: ValueEst;
  a: ValueEst;
  pl: ValueEst;
  extras: PlExtras;
  // 8.8: Δ_late with its candidates, PL_late (point only), and the rows left out
  deltaLate: ValueEst;
  plLate: number | null;
  lateN: number;
  lateExcluded: { noEntry: number; r4: number; end: number };
  // 8.6: D_F against the trial's S_F (directional F) or (E, F00) (other F; explanatory); null for F00, S, B
  dF: ValueEst | null;
  dFAgainst: string | null;
  // 21.5 重ならない版 (points only)
  nonOverlap: { N: number; delta: number | null; pl: number | null };
  // 11 C2 / C3 (second half): Δ by direction and by pair, with the counted signals of each
  deltaByDir: [number | null, number | null];
  countedByDir: [number, number];
  deltaByPair: Array<number | null>;
  countedByPair: number[];
  // 11 C6 (second half): Δ of weeks 2889–2926 and 2927–2964
  c6: [number | null, number | null];
}

// ---- stage 0 (builder D: research/lawsearch-select0.ts) ----------------------------------------------------

// spec 9's numbers of one trial in one half
export interface Stage0Half {
  counted: number;
  weeks: number;
  // counted by pair × direction: index pi × 2 + (d === 1 ? 0 : 1)
  byPairDir: number[];
  // by REASONS index (first half: ① only the T < SPLIT part; ②–⑥ the half's signals); the second half's
  // per-trial breakdown is kept for the totals only (spec 9: not printed per trial before stage 2)
  byReason: number[];
  noBlind: number;
  noTrade: number;
  fNone: number;
  both: number;
  // counted ÷ the half's weeks (72 or 76)
  perWeek: number;
}
export interface Stage0Row {
  trial: string;
  tf: TfKey;
  order: number;
  first: Stage0Half;
  second: Stage0Half;
  // the whole read range (spec 9 and 15 数が合う): ① (with the T ≥ SPLIT part), ①b, and the part of ① that is
  // the warm-up of a signal whose T is in a half (r1w)
  r1All: number;
  r1b: number;
  r1w: number;
  // every emitted candidate (after ⑤), and whether it equals Σ reasons + counted
  emitted: number;
  addsUp: boolean;
  floor: boolean;
  // the earliest trial (table order, same timeframe) with the same first-half counted set, or null
  sameAs: string | null;
  // the overlap group (its first trial in table order); S rows are their own group
  group: string;
  // spec 9 見分けられる大きさ (null when no g is given)
  g: number | null;
  df: number | null;
  passMin: number | null;
  mde: number | null;
  mark: boolean | null;
  stage3Estimate: number | null;
}

// ---- stage 1 and 2 (builder D: research/lawsearch-select.ts) -----------------------------------------------

// What spec 10 reads of one trial (the hand example A.2.20 feeds these directly)
export interface Stage1Cand {
  id: string;
  tf: TfKey;
  order: number;
  // the F of an (E, F) trial and of an S row (S01 → F01); null for B rows and E × F00
  f: string | null;
  isS: boolean;
  directionalF: boolean;
  passFloor: boolean;
  same: boolean;
  checksOk: boolean;
  hasT: boolean;
  delta: number | null;
  lb: number | null;
  pl: number | null;
  plEx1w: number | null;
  dF: number | null;
  suspicious: boolean;
  // spec 13's checks (i)–(v) all passed (null when not suspicious)
  suspiciousChecksPassed: boolean | null;
  n: number;
  group: string;
}
export type SkipReason = "same-group" | "S-then-EF" | "EF-then-S";
export interface Stage1Out {
  // per trial: 0 eligible, else the first rule of 10 (1–6) it fails
  failRule: Map<string, number>;
  order: Record<TfKey, string[]>;
  chosen: Record<TfKey, string[]>;
  skipped: Array<{ id: string; reason: SkipReason; by: string }>;
  K_total: number;
}
// spec 10 説明として出すもの (the trial's part: the week-shift 95% points of 14.4 are real data's, step 6)
export interface Stage1Explain {
  // trials with LB > 0 and their groups; trials with LB > 0 and PL > 0
  lbPos: number;
  lbPosGroups: number;
  lbAndPlPos: number;
  // the reference BH (q = 0.10) on the first half's max(p_Δ, p_PL): the family's size m and how many pass
  bhM: number;
  bhPass: number;
}

// What spec 11 reads of one chosen trial (second half, κ applied)
export interface Stage2Cand {
  id: string;
  tf: TfKey;
  order: number;
  n: number;
  weeks: number;
  pDelta: number;
  pPl: number;
  tDelta: number | null;
  tPl: number | null;
  // C2–C7's inputs
  deltaByDir: [number | null, number | null];
  countedByDir: [number, number];
  deltaByPair: Array<number | null>;
  countedByPair: number[];
  lateLb: number | null;
  plLate: number | null;
  suspicious: boolean;
  suspiciousChecksPassed: boolean | null;
  c6: [number | null, number | null];
  plEx1w: number | null;
  // verdict 2: the upper end of Δ's uncorrected two-sided 95% interval
  deltaUb: number | null;
}
export interface Stage2Row {
  id: string;
  pIut: number;
  holmRank: number;
  holmPass: boolean;
  holmDeltaRank: number;
  holmDeltaPass: boolean;
  // C1 … C7
  C: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  // 1 confirmed (法則の候補 under question 2 (b)), 2 bad, 3 partial, 4 direction only, 5 cannot say
  verdict: 1 | 2 | 3 | 4 | 5;
  failed: number[];
  mde: number | null;
  simLb: number | null;
}

// spec 13 of one row (a trial or a blind measure row) in one half
export interface SuspectRow {
  id: string;
  half: HalfName;
  // only rows with ≥ 100 counted signals are looked at
  looked: boolean;
  hitDelta: boolean;
  hitA: boolean;
  hitPl: boolean;
  hitLate: boolean;
  hitW: boolean;
  hit: boolean;
  // 13 (i)–(iv) run by the program; (v) is another agent's hand trace ("not-run" on synthetic runs)
  checks: { cut: boolean | null; poison1000: boolean | null; presence: boolean | null; retrace: boolean | null; hand: "pass" | "fail" | "not-run" };
  checksPassed: boolean | null;
}

// ---- checks (builder D: research/lawsearch-checks.ts; follow-bar checks: builder C) ------------------------

export interface Probe {
  name: string;
  compared: number;
  mismatched: number;
  // the first few mismatches, readable
  examples: string[];
}
export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
  probes: Probe[];
}

// ---- hand examples (builder D: research/lawsearch-hand.ts) -------------------------------------------------

// One element of research/lawsearch-hand.json's "examples"
export interface HandExample {
  group: "G1" | "G2" | "G3" | "G4";
  id: string;
  topic: string;
  tests: string;
  params: Record<string, unknown>;
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
  doubt: unknown;
}
export type HandStatus = "pass" | "fail" | "skip";
export interface HandKeyResult {
  key: string;
  status: HandStatus;
  // why a key was skipped (an item not built yet, an alternative answer) or how it failed
  why: string;
}
export interface HandResult {
  id: string;
  // pass: every required key passed; fail: a required key failed or was skipped; skip: not in the trial's set
  status: HandStatus;
  keys: HandKeyResult[];
}

// ---- the synthetic prices (builder A: research/lawsearch-gen.ts) -------------------------------------------

// spec 14.2's sets; "C" is the trial's comparison walk with planted holes (lawsearch-design.md 4.2, 10), not a set of 14
export type GenGroup = "N" | "R" | "D" | "H" | "E15" | "E1h" | "EF" | "Q" | "O" | "C";
export interface GenSpec {
  group: GenGroup;
  seed: number;
  // 14.2 裏返し: the walk mirrored about each pair's start (Bid and Ask swapped)
  flip: boolean;
  // S0 and END for every set of 14 (a shorter period only for a development run, never compared)
  fromMs: number;
  toMs: number;
  // the effect's amount (14.3: set by the trial seeds 901–920 later); null: none written yet (an effect set refuses)
  strength: number | null;
  // "provisional": an amount used only to see the effect's code run (the trial's smoke runs), never a formal run
  strengthNote: string;
  // C only: bars removed from the written files (both sides), and day files written empty
  drop: Array<{ pair: Pair; tf: TfKey; fromMs: number; toMs: number }>;
  emptyDays: Array<{ pair: Pair; tf: TfKey; key: string }>;
}
// <run>/manifest.json
export interface GenManifest {
  // "lawsearch-gen 1"
  version: string;
  spec: GenSpec;
  // the files written under <run>/gmo, and the sha256 of their listing (lawsearch-dump.md 1)
  files: number;
  treeSha256: string;
  // the effect's own signals (E15: its E04, E1h: its E37, EF: its EMA200 side changes) per pair, for the report
  effectSignals: Record<string, number>;
  ms: number;
}

// ---- a run's settings, written first to <run>/ts/config.json (lawsearch-dump.md 2) ------------------------

export interface RunConfig {
  mode: "syn" | "walkfiles";
  run: string;
  trials: string[];
  N: number;
  // spec 22: the owner's answers (q4 chosen by Claude, spec 22 4)
  questions: { q1: number; q2: "a" | "b"; q3: "a" | "b"; q4: "a" | "b"; q5: "a" | "b" };
  // stage 2's κ (1 until calib has run on 1101–1500) and where it came from
  kappaDelta: number;
  kappaPl: number;
  kappaFrom: string;
  // spec 9's g per trial from the N runs (empty: none yet; MDE and the marks are then 無し)
  g: Record<string, number>;
  gFrom: string;
  plant: string;
  spreadH1Sha256: string;
}
