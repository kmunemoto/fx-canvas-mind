// 法則探し (docs §8.136, research/lawsearch-spec.md 7, 8.1, 8.8, 15): the trades, the blind tables and the follow-bar
// checks (builder C of research/lawsearch-design.md 6.1).
//
//   * spec 7: the entry bar j (the first start ≥ T and < X), the exit bar x (the close exactly at X, else the last bar
//     with start ≥ s_j and close ≤ X), m = d × (Pc[x] − Po[j]), h = sign(m), PL: buy Bc[x] − Ao[j], sell Bo[j] − Ac[x]
//     (points), by lawsearch-bars.ts entryExitIndex;
//   * spec 8.1: the blind table of one timeframe and half (every bar that passed ①–⑥, both directions, in 21.5's row
//     order), and spec 8.8: the late table made from it (entry at T + 15 min, exit at X + 15 min, on the 15-minute
//     bars), with its three exclusions counted;
//   * the rows of a trial's counted signals in those tables (spec 6 末尾: no trade, no blind stratum);
//   * spec 15 追う足 (i) and (ii).
//
// Nothing here reads the environment; a planted error of spec 16 is a `plant` argument (entryAtSignalClose,
// entryEarly, exitLate, noSubstituteExit).

import { N_BARS, PAIRS, POINTS_PER_PRICE, STEP, wk } from "./lawsearch-const.ts";
import { FOLLOW_BACK, LATE_MS, POISON_PIPS, REASONS } from "./lawsearch-rules.ts";
import { entryExitIndex, hourOf, midOf, pointsOf, poisonBars, seasonGroupOf, stop, stratumOf, windowSeries } from "./lawsearch-bars.ts";
import { r4 } from "./lawsearch-events.ts";
import type { BlindTable, CheckResult, Dir, HalfName, Probe, Series, TfKey, TfSet, Trade, TrialRows, TrialSignals } from "./lawsearch-types.ts";

// ---- keys ------------------------------------------------------------------------------------------------------

// lawsearch-design.md 2.2: one number per (pair, T, direction); exact below 2^53 (T × 16 is about 2.8e13)
export const rowKey = (pi: number, T: number, d: Dir): number => T * 16 + pi * 2 + (d === 1 ? 0 : 1);

const HALF_CODE: Readonly<Record<HalfName, number>> = { first: 1, second: 2, stage3: 3 };
const COUNTED = REASONS.indexOf("counted");

// the last index with xs[k] ≤ v (xs ascending), −1 when none
const lastAtOrBefore = (xs: ArrayLike<number>, n: number, v: number): number => {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
};

// ---- spec 7 ----------------------------------------------------------------------------------------------------

// m, h and PL of the trade with entry bar j and exit bar x (points; −0 never comes out)
const valuesAt = (s: Series, j: number, x: number, d: Dir): { m: number; h: -1 | 0 | 1; pl: number } => {
  const m = (d * (s.Pc[x] - s.Po[j])) | 0;
  const h = m > 0 ? 1 : m < 0 ? -1 : 0;
  const pl = d === 1 ? s.Bc[x] - s.Ao[j] : s.Bo[j] - s.Ac[x];
  return { m, h, pl };
};

// Spec 7 on one series: null when no bar starts in [T, X) (no trade can be made). Plants (spec 16):
//   entryAtSignalClose  the entry is the signal bar's close (buy Ac, sell Bc; the signal bar is the bar closing at T),
//                       and m uses its Pc;
//   entryEarly          the entry bar is j − 1;
//   exitLate            the exit bar is x + 1 (when it exists);
//   noSubstituteExit    no trade when no bar closes exactly at X.
export function tradeOf(s: Series, T: number, X: number, d: Dir, plant = ""): Trade | null {
  const ee = entryExitIndex(s, T, X);
  if (!ee) return null;
  let { j, x } = ee;
  const subst = ee.subst;
  if (plant === "noSubstituteExit" && subst) return null;
  if (plant === "entryEarly" && j > 0) j = j - 1;
  if (plant === "exitLate" && x + 1 < s.n) x = x + 1;
  if (plant === "entryAtSignalClose") {
    const i = lastAtOrBefore(s.T, s.n, T);
    if (i >= 0 && s.T[i] === T) {
      const m = (d * (s.Pc[x] - s.Pc[i])) | 0;
      const h = m > 0 ? 1 : m < 0 ? -1 : 0;
      const pl = d === 1 ? s.Bc[x] - s.Ac[i] : s.Bc[i] - s.Ac[x];
      return { j: i, x, subst, m, h, pl };
    }
  }
  return { j, x, subst, ...valuesAt(s, j, x, d) };
}

// Spec 8.8 on the 15-minute series of the pair: the entry bar is the first start ≥ T + 15 min and < X + 15 min, the
// exit bar the close exactly at X + 15 min, else the last bar with start ≥ the entry's and close ≤ X + 15 min. null
// when there is no late entry bar.
export function lateTradeOf(m15: Series, T: number, X: number, d: Dir): Trade | null {
  if (m15.key !== "m15") throw new Error(`lateTradeOf: the series is ${m15.key}, not m15`);
  const ee = entryExitIndex(m15, T + LATE_MS, X + LATE_MS);
  if (!ee) return null;
  return { j: ee.j, x: ee.x, subst: ee.subst, ...valuesAt(m15, ee.j, ee.x, d) };
}

// ---- spec 8.1: the blind table -----------------------------------------------------------------------------------

// a table of n rows with every array allocated
const emptyTable = (tf: TfKey, half: HalfName, late: boolean, n: number): BlindTable => ({
  tf, half, late, n,
  pi: new Int8Array(n),
  i: new Int32Array(n),
  T: new Float64Array(n),
  d: new Int8Array(n),
  j: new Int32Array(n),
  x: new Int32Array(n),
  subst: new Uint8Array(n),
  m: new Int32Array(n),
  h: new Int8Array(n),
  pl: new Int32Array(n),
  absm: new Int32Array(n),
  hour: new Uint8Array(n),
  season: new Uint8Array(n),
  stratum: new Int32Array(n),
  week: new Int32Array(n),
  weeks: new Int32Array(0),
  passedBars: 0,
  noTradeBars: 0,
  lateExcluded: { noEntry: 0, r4: 0, end: 0 },
  baseRow: null,
  index: new Map(),
});

// the distinct weeks of the rows, ascending (rows are in T order, so weeks never decrease)
const weeksOf = (week: Int32Array, n: number): Int32Array => {
  const out: number[] = [];
  for (let r = 0; r < n; r++) if (out.length === 0 || out[out.length - 1] !== week[r]) out.push(week[r]);
  for (let q = 1; q < out.length; q++) if (!(out[q] > out[q - 1])) throw new Error("weeksOf: the rows are not in T order");
  return Int32Array.from(out);
};

// the arrays cut to the first n rows (a table is filled to at most its allocated length)
const trimmed = (t: BlindTable, n: number): BlindTable => {
  if (n === t.n) return t;
  return {
    ...t,
    n,
    pi: t.pi.slice(0, n), i: t.i.slice(0, n), T: t.T.slice(0, n), d: t.d.slice(0, n), j: t.j.slice(0, n), x: t.x.slice(0, n),
    subst: t.subst.slice(0, n), m: t.m.slice(0, n), h: t.h.slice(0, n), pl: t.pl.slice(0, n), absm: t.absm.slice(0, n),
    hour: t.hour.slice(0, n), season: t.season.slice(0, n), stratum: t.stratum.slice(0, n), week: t.week.slice(0, n),
    baseRow: t.baseRow ? t.baseRow.slice(0, n) : null,
  };
};

// one row; tS is the time of the stratum (T for the normal table, T + 15 min for the late table), whose hour and
// season the caller has taken once for the bar's two rows; the id is lawsearch-bars.ts stratumOf's
const putRow = (t: BlindTable, r: number, pi: number, i: number, T: number, d: Dir, tr: { j: number; x: number; subst: boolean; m: number; h: number; pl: number }, tS: number, hour: number, season: number) => {
  t.pi[r] = pi;
  t.i[r] = i;
  t.T[r] = T;
  t.d[r] = d;
  t.j[r] = tr.j;
  t.x[r] = tr.x;
  t.subst[r] = tr.subst ? 1 : 0;
  t.m[r] = tr.m;
  t.h[r] = tr.h;
  t.pl[r] = tr.pl;
  t.absm[r] = Math.abs(tr.m);
  t.hour[r] = hour;
  t.season[r] = season;
  t.stratum[r] = stratumOf(pi, d, tS);
  t.week[r] = wk(T);
  t.index.set(rowKey(pi, T, d), r);
};

// The passing bars of the five pairs in (T, pair) order: [pi, i] pairs
const passingInOrder = (tf: TfSet, passing: Uint8Array[]): Array<[number, number]> => {
  if (passing.length !== tf.pairs.length) throw new Error(`blindTable: ${passing.length} passing arrays, ${tf.pairs.length} pairs`);
  const keys: number[] = [];
  tf.pairs.forEach((s, pi) => {
    if (passing[pi].length !== s.n) throw new Error(`blindTable: passing[${pi}] has ${passing[pi].length}, the series ${s.n}`);
    for (let i = 0; i < s.n; i++) if (passing[pi][i] === 1) keys.push(s.T[i] * 8 + pi);
  });
  const sorted = Float64Array.from(keys).sort();
  const out: Array<[number, number]> = new Array(sorted.length);
  const iOf = tf.pairs.map(() => 0);
  for (let q = 0; q < sorted.length; q++) {
    const pi = sorted[q] % 8;
    const s = tf.pairs[pi];
    // the bars of a pair come in their own order, so a pointer per pair finds them
    while (!(passing[pi][iOf[pi]] === 1)) iOf[pi]++;
    const i = iOf[pi]++;
    if (s.T[i] * 8 + pi !== sorted[q]) throw new Error("blindTable: the passing bars are out of order");
    out[q] = [pi, i];
  }
  return out;
};

// Spec 8.1: the blind table of one timeframe and half. passing (per pair, blindBarsOf): 1 = the bar's T and X are in
// the half and ②–⑥ pass. Each bar has a buy row and a sell row (spec 7 with X = T + N × step), or, when no bar
// starts in [T, X), no row (counted once in noTradeBars). The sell row's h is −h(buy) (spec 8.1), which spec 7's m
// gives; its PL is the sell formula's. hour, season and the stratum come from T; week = wk(T).
export function blindTable(tf: TfSet, half: HalfName, passing: Uint8Array[], plant = ""): BlindTable {
  const bars = passingInOrder(tf, passing);
  const t = emptyTable(tf.tf, half, false, 2 * bars.length);
  let r = 0;
  for (const [pi, i] of bars) {
    const s = tf.pairs[pi];
    const T = s.T[i];
    const X = T + N_BARS * tf.step;
    const buy = tradeOf(s, T, X, 1, plant);
    const sell = tradeOf(s, T, X, -1, plant);
    if (!buy || !sell) {
      t.noTradeBars++;
      continue;
    }
    if (sell.h !== -buy.h) throw new Error(`blindTable: ${s.pair} ${new Date(T).toISOString()}: sell h ${sell.h}, buy h ${buy.h}`);
    const hour = hourOf(T);
    const season = seasonGroupOf(T);
    putRow(t, r++, pi, i, T, 1, buy, T, hour, season);
    putRow(t, r++, pi, i, T, -1, sell, T, hour, season);
  }
  const out = trimmed(t, r);
  out.passedBars = bars.length;
  out.weeks = weeksOf(out.week, out.n);
  return out;
}

// ---- spec 8.8: the late table ------------------------------------------------------------------------------------

// Why a base row is not in a late table (late tables made by lateTable only): per base row, 0 kept, 1 no late entry,
// 2 ④ at X + 15 min, 3 past the period's end
const LATE_KEPT = 0;
const LATE_NO_ENTRY = 1;
const LATE_R4 = 2;
const LATE_END = 3;
const lateWhy = new WeakMap<BlindTable, { base: BlindTable; why: Uint8Array }>();
// The base table of a late table made by lateTable and, per base row, why it is not in it (0 kept, 1 no late entry,
// 2 ④ at X + 15 min, 3 past the period's end); null for a late table from blindFromRows
export function lateWhyOf(late: BlindTable): { base: BlindTable; why: Uint8Array } | null {
  return lateWhy.get(late) ?? null;
}

// Spec 8.8: the late table of a blind table (base: its timeframe and half; m15: the 15-minute bars of the five pairs).
// Each base row gets the late trade of its pair (lateTradeOf, T and X of the row). A row is left out, counted by the
// first that applies, when there is no late entry bar (noEntry), when ④ holds on [T, X + 15 min) (r4), or when X +
// 15 min > periodEnd (end; SPLIT, END or stage 3's end). end must be 0 (spec 8.8: ④, ②, ⑤ or ①b comes first);
// the run stops otherwise. hour, season and the stratum are of T + 15 min; the week stays wk(T); the index is keyed
// by the base row's (pi, T, d). No plant of spec 16 acts here (plant is accepted for the signature).
export function lateTable(base: BlindTable, m15: TfSet, periodEnd: number, plant = ""): BlindTable {
  void plant;
  if (base.late) throw new Error("lateTable: the base is a late table");
  if (m15.tf !== "m15") throw new Error(`lateTable: the 15-minute set is ${m15.tf}`);
  const step = STEP[base.tf];
  const t = emptyTable(base.tf, base.half, true, base.n);
  const baseRow = new Int32Array(base.n);
  const why = new Uint8Array(base.n);
  let n = 0;
  for (let r = 0; r < base.n; r++) {
    const pi = base.pi[r];
    const T = base.T[r];
    const X = T + N_BARS * step;
    const d = base.d[r] as Dir;
    const tr = lateTradeOf(m15.pairs[pi], T, X, d);
    if (!tr) {
      why[r] = LATE_NO_ENTRY;
      t.lateExcluded.noEntry++;
      continue;
    }
    if (r4(T, X + LATE_MS)) {
      why[r] = LATE_R4;
      t.lateExcluded.r4++;
      continue;
    }
    if (X + LATE_MS > periodEnd) {
      why[r] = LATE_END;
      t.lateExcluded.end++;
      continue;
    }
    why[r] = LATE_KEPT;
    const tL = T + LATE_MS;
    putRow(t, n, pi, base.i[r], T, d, tr, tL, hourOf(tL), seasonGroupOf(tL));
    baseRow[n] = r;
    n++;
  }
  t.baseRow = baseRow;
  const out = trimmed(t, n);
  out.passedBars = base.passedBars;
  out.noTradeBars = base.noTradeBars;
  out.weeks = weeksOf(out.week, out.n);
  lateWhy.set(out, { base, why });
  if (out.lateExcluded.end !== 0) stop(`late table ${base.tf} ${base.half}: ${out.lateExcluded.end} rows with X + 15 min past the period's end (must be 0, spec 8.8)`);
  return out;
}

// ---- hand examples: a table from given rows ----------------------------------------------------------------------

// A blind table (late: a late table) from rows given as numbers (the hand examples of group 2): one bar per row with
// its pair, T, the buy m and both PL (points). The buy row has m and h = sign(m), the sell row −m and −h. hour,
// season and the stratum come from T (late: T + 15 min). i, j and x are −1; subst 0; absm = |m| unless given.
export function blindFromRows(tf: TfKey, half: HalfName, late: boolean, rows: ReadonlyArray<{ pi: number; T: number; m: number; plBuy: number; plSell: number; absm?: number }>): BlindTable {
  const order = rows.map((_, q) => q).sort((a, b) => rows[a].T - rows[b].T || rows[a].pi - rows[b].pi || a - b);
  const t = emptyTable(tf, half, late, 2 * rows.length);
  let r = 0;
  let prev = "";
  for (const q of order) {
    const x = rows[q];
    if (!(Number.isInteger(x.pi) && x.pi >= 0 && x.pi < PAIRS.length)) throw new Error(`blindFromRows: pair index ${x.pi}`);
    if (!(Number.isInteger(x.m) && Number.isInteger(x.plBuy) && Number.isInteger(x.plSell))) throw new Error(`blindFromRows: row ${q} is not in whole points`);
    const key = `${x.T}:${x.pi}`;
    if (key === prev) throw new Error(`blindFromRows: two rows of pair ${x.pi} at ${new Date(x.T).toISOString()}`);
    prev = key;
    const tS = late ? x.T + LATE_MS : x.T;
    const hour = hourOf(tS);
    const season = seasonGroupOf(tS);
    const mBuy = x.m | 0;
    const hBuy = mBuy > 0 ? 1 : mBuy < 0 ? -1 : 0;
    const absm = x.absm ?? Math.abs(mBuy);
    putRow(t, r++, x.pi, -1, x.T, 1, { j: -1, x: -1, subst: false, m: mBuy, h: hBuy, pl: x.plBuy }, tS, hour, season);
    putRow(t, r++, x.pi, -1, x.T, -1, { j: -1, x: -1, subst: false, m: (-mBuy) | 0, h: (-hBuy) as -1 | 0 | 1, pl: x.plSell }, tS, hour, season);
    t.absm[r - 2] = absm;
    t.absm[r - 1] = absm;
  }
  t.passedBars = rows.length;
  t.weeks = weeksOf(t.week, t.n);
  return t;
}

// ---- a trial's rows ----------------------------------------------------------------------------------------------

// What trialRows saw beyond TrialRows' fields (kept per TrialRows object; read by lawsearch-stats.ts measureTrial):
// the counted signals of the half by pair × direction (index pi × 2 + (d === 1 ? 0 : 1)), with or without a trade
// (lawsearch-design.md 11 O-7), and the distinct weeks of all counted signals
const rowsExtra = new WeakMap<TrialRows, { countedByPairDir: Int32Array; countedWeeks: number }>();
export function trialRowsExtra(tr: TrialRows): { countedByPairDir: Int32Array; countedWeeks: number } | null {
  return rowsExtra.get(tr) ?? null;
}

// One trial's counted signals of the half (reason counted, half = the table's) as rows of the half's tables:
//   * a signal with a row of the blind table (rowKey(pi, T, d)) is a Δ row;
//   * a signal without one: no trade (spec 7's tradeOf is null) adds to noTrade; a trade adds to noBlind (must be
//     0; the caller stops otherwise);
//   * lateRows: the late table's rows of the Δ rows; the ones the late table left out are counted by its reason.
// series: the timeframe's five series (PAIRS order). plant: the trade plants, as the table was built with them (an
// addition to lawsearch-design.md 6.1's signature, optional).
export function trialRows(table: BlindTable, late: BlindTable, sig: TrialSignals, half: HalfName, series: Series[], plant = ""): TrialRows {
  if (table.late || !late.late) throw new Error("trialRows: (normal table, late table) expected");
  if (table.half !== half || late.half !== half) throw new Error(`trialRows: the tables are ${table.half}/${late.half}, the half ${half}`);
  if (sig.tf !== table.tf || late.tf !== table.tf) throw new Error(`trialRows: ${sig.trial.id} is ${sig.tf}, the tables ${table.tf}/${late.tf}`);
  if (series.length !== PAIRS.length) throw new Error(`trialRows: ${series.length} series`);
  const code = HALF_CODE[half];
  const info = lateWhy.get(late);
  if (info && info.base !== table) throw new Error("trialRows: the late table was not made from this table");
  const rows: number[] = [];
  const lateRows: number[] = [];
  const lateExcluded = { noEntry: 0, r4: 0, end: 0 };
  const byPairDir = new Int32Array(PAIRS.length * 2);
  const weeks = new Set<number>();
  let counted = 0;
  let noTrade = 0;
  let noBlind = 0;
  for (const c of sig.pairs) {
    const s = series[c.pi];
    if (s.pi !== c.pi || s.key !== table.tf) throw new Error(`trialRows: series ${c.pi} is ${s.pair} ${s.key}`);
    for (let q = 0; q < c.n; q++) {
      if (c.reason[q] !== COUNTED || c.half[q] !== code) continue;
      const d = c.d[q] as Dir;
      const T = c.T[q];
      counted++;
      byPairDir[c.pi * 2 + (d === 1 ? 0 : 1)]++;
      weeks.add(wk(T));
      const r = table.index.get(rowKey(c.pi, T, d));
      if (r === undefined) {
        if (tradeOf(s, T, c.X[q], d, plant) === null) noTrade++;
        else noBlind++;
        continue;
      }
      rows.push(r);
      const lr = late.index.get(rowKey(c.pi, T, d));
      if (lr !== undefined) {
        lateRows.push(lr);
        continue;
      }
      const w = info ? info.why[r] : null;
      if (w === LATE_NO_ENTRY) lateExcluded.noEntry++;
      else if (w === LATE_R4) lateExcluded.r4++;
      else if (w === LATE_END) lateExcluded.end++;
      else if (w === null) {
        // a late table without reasons (blindFromRows): ④ at X + 15 min is the clock's, the rest is no entry
        if (r4(T, c.X[q] + LATE_MS)) lateExcluded.r4++;
        else lateExcluded.noEntry++;
      } else throw new Error(`trialRows: ${sig.trial.id} row ${r} is kept by the late table but not in its index`);
    }
  }
  const out: TrialRows = {
    trial: sig.trial.id,
    tf: table.tf,
    half,
    counted,
    noTrade,
    noBlind,
    rows: Int32Array.from(rows).sort(),
    lateRows: Int32Array.from(lateRows).sort(),
    lateExcluded,
  };
  rowsExtra.set(out, { countedByPairDir: byPairDir, countedWeeks: weeks.size });
  return out;
}

// ---- spec 15 追う足 ------------------------------------------------------------------------------------------------

// a copy of the window s whose bar `at` has +pts on the raw open of both sides (the mid's open and its points made
// again from them); the other arrays stay the window's views
const poisonOpen = (s: Series, at: number, pts: number): Series => {
  const mult = POINTS_PER_PRICE(s.pair);
  const out: Series = { ...s, bo: s.bo.slice(), ao: s.ao.slice(), Bo: s.Bo.slice(), Ao: s.Ao.slice(), O: s.O.slice(), Po: s.Po.slice() };
  out.Bo[at] = s.Bo[at] + pts;
  out.Ao[at] = s.Ao[at] + pts;
  out.bo[at] = out.Bo[at] / mult;
  out.ao[at] = out.Ao[at] / mult;
  out.O[at] = midOf(out.bo[at], out.ao[at], s.pair);
  out.Po[at] = pointsOf(out.O[at], s.pair);
  return out;
};

// Spec 15 追う足 on every row of a table (a bar's two rows share j and x, and are checked on one poisoned copy):
//   (i) with the trade record fixed (j, x), the FOLLOW_BACK bars with T_k ≤ T of the row's pair get ±POISON_PIPS
//       (lawsearch-bars.ts poisonBars); m, h and PL recomputed at j and x must all be equal;
//   (ii) the raw open of bar j (both sides) gets +POISON_PIPS; PL must change.
// tf is the table's timeframe (the 15-minute set for a late table). Only the bars [k0, x] are copied for each check
// (windowSeries views, then poisonBars), so the cost is the window's, not the series'. (ii) poisons the open only:
// with a substitute exit at the entry bar (x = j, hand A.1.29), poisoning the whole bar would move Ao[j] and Bc[x]
// together and leave PL unchanged.
export function followBarChecks(tf: TfSet, table: BlindTable): CheckResult {
  if ((table.late ? "m15" : table.tf) !== tf.tf) throw new Error(`followBarChecks: the table is ${table.tf}${table.late ? " late" : ""}, the set ${tf.tf}`);
  const pts = Math.round(POISON_PIPS * 10);
  const p1: Probe = { name: "follow (i): m, h and PL unchanged when the 300 bars up to T are poisoned", compared: 0, mismatched: 0, examples: [] };
  const p2: Probe = { name: "follow (ii): PL changes when bar j's open is poisoned", compared: 0, mismatched: 0, examples: [] };
  const where = (r: number) => `${PAIRS[table.pi[r]]} ${new Date(table.T[r]).toISOString()} d=${table.d[r]}`;
  let r = 0;
  while (r < table.n) {
    const pi = table.pi[r];
    const T = table.T[r];
    const j = table.j[r];
    const x = table.x[r];
    const pairRow = r + 1 < table.n && table.pi[r + 1] === pi && table.T[r + 1] === T && table.j[r + 1] === j && table.x[r + 1] === x;
    const rows = pairRow ? [r, r + 1] : [r];
    r += rows.length;
    const s = tf.pairs[pi];
    if (j < 0 || x < j || x >= s.n) throw new Error(`followBarChecks: row ${rows[0]} has no trade bars in the series (j ${j}, x ${x})`);
    const i0 = lastAtOrBefore(s.T, s.n, T);
    // (i): the bars k0..i0 (T_k ≤ T) of the window k0..x poisoned
    const k0 = Math.max(0, i0 - (FOLLOW_BACK - 1));
    const idx = new Int32Array(Math.max(0, i0 - k0 + 1));
    for (let q = 0; q < idx.length; q++) idx[q] = q;
    const pw = poisonBars(windowSeries(s, k0, x), idx, POISON_PIPS);
    // (ii): the window j..x with bar j's open poisoned
    const ow = poisonOpen(windowSeries(s, j, x), 0, pts);
    for (const rr of rows) {
      const d = table.d[rr] as Dir;
      const v = valuesAt(pw, j - k0, x - k0, d);
      p1.compared++;
      if (v.m !== table.m[rr] || v.h !== table.h[rr] || v.pl !== table.pl[rr]) {
        p1.mismatched++;
        if (p1.examples.length < 5) p1.examples.push(`${where(rr)}: m ${table.m[rr]}→${v.m} h ${table.h[rr]}→${v.h} pl ${table.pl[rr]}→${v.pl}`);
      }
      const o = valuesAt(ow, 0, x - j, d);
      p2.compared++;
      if (o.pl === table.pl[rr]) {
        p2.mismatched++;
        if (p2.examples.length < 5) p2.examples.push(`${where(rr)}: pl ${o.pl} unchanged`);
      }
    }
  }
  return {
    name: `follow-bars ${table.tf} ${table.half}${table.late ? " late" : ""}`,
    passed: p1.mismatched === 0 && p2.mismatched === 0,
    detail: `${table.n} rows: (i) ${p1.mismatched} changed, (ii) ${p2.mismatched} unchanged`,
    probes: [p1, p2],
  };
}
