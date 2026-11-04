// 法則探し (docs §8.136, research/lawsearch-spec.md 8.2–8.8, 9, 11, 14.2, 21.5): the measures of a trial on the
// blind table (builder C of research/lawsearch-design.md 6.2).
//
//   * 8.2–8.4: the strata, Δ, a, PL, W and the explanatory numbers;
//   * 8.5: the influence functions, the clustered SE (week, 4 weeks), the week shift, the three SE candidates and the
//     choices of the interval and of p; t's distribution and quantile (money-stats.ts tQuantile and tUpperTail);
//   * 8.6: D_F with the influence functions' difference; 8.8: Δ_late (the same machinery on the late table);
//   * 11: κ (withKappa, kappaOf); 14.2 (N4): the SE gate; 21.5: the median, the 95% point, the non-overlapping
//     version.
//
// Sums run in 21.5's orders: rows ascending (T, pair, buy before sell; a signal row before the blind row of the same
// (T, pair, d)), strata by ascending id, clusters ascending, k ascending. A table's row order is its index order, so
// nothing is sorted again. Nothing here reads the environment; a planted error of spec 16 is a `plant` argument
// (blindNoHour, noBlind, inflStratumMean, shiftNoWrap).

import { WEEK } from "./lib.ts";
import { N_BARS, PAIRS, STEP } from "./lawsearch-const.ts";
import { C6_PARTS, FOUR_WEEK_MIN_C, ZERO } from "./lawsearch-rules.ts";
import { tQuantile, tUpperTail } from "./money-stats.ts";
import { stop } from "./lawsearch-bars.ts";
import { lateWhyOf, rowKey, trialRowsExtra } from "./lawsearch-trade.ts";
import type { BlindTable, Dir, PlExtras, SeCand, SeKind, ShiftRun, StratumAgg, TrialMeasures, TrialRows, ValueEst } from "./lawsearch-types.ts";

// ---- distributions and small statistics ---------------------------------------------------------------------------

// spec 8.5: U(x, ν) = ½ × I_{ν÷(ν+x×x)}(ν÷2, ½), the upper tail for x ≥ 0 (money-stats.ts)
export function tUpper(x: number, df: number): number {
  return tUpperTail(x, df);
}
// spec 8.5: the one-sided p = 1 − T(x, ν): U(x, ν) itself for x ≥ 0 (1 − T is never taken in doubles), 1 − U(−x, ν)
// for x < 0
export function pOneSided(x: number, df: number): number {
  return x >= 0 ? tUpperTail(x, df) : 1 - tUpperTail(-x, df);
}
// spec 8.5: T(x, ν): 1 − U(x, ν) for x ≥ 0, U(−x, ν) for x < 0
export function tCdf(x: number, df: number): number {
  return x >= 0 ? 1 - tUpperTail(x, df) : tUpperTail(-x, df);
}
// spec 8.5: the quantile t(q, ν) by money-stats.ts tQuantile (bisection to 1e−12)
export function tq(q: number, df: number): number {
  return tQuantile(q, df);
}

// The standard normal quantile, Wichura's AS241 (PPND16, about 1e−16 relative), for (N4)'s L (spec 14.2)
const A241 = [3.387132872796366608, 133.14166789178437745, 1971.5909503065514427, 13731.693765509461125, 45921.953931549871457, 67265.770927008700853, 33430.575583588128105, 2509.0809287301226727];
const B241 = [1, 42.313330701600911252, 687.1870074920579083, 5394.1960214247511077, 21213.794301586595867, 39307.89580009271061, 28729.085735721942674, 5226.495278852854561];
const C241 = [1.42343711074968357734, 4.6303378461565452959, 5.7694972214606914055, 3.64784832476320460504, 1.27045825245236838258, 0.24178072517745061177, 0.0227238449892691845833, 7.7454501427834140764e-4];
const D241 = [1, 2.05319162663775882187, 1.6763848301838038494, 0.68976733498510000455, 0.14810397642748007459, 0.0151986665636164571966, 5.475938084995344946e-4, 1.05075007164441684324e-9];
const E241 = [6.6579046435011037772, 5.4637849111641143699, 1.7848265399172913358, 0.29656057182850489123, 0.026532189526576123093, 0.0012426609473880784386, 2.71155556874348757815e-5, 2.01033439929228813265e-7];
const F241 = [1, 0.59983220655588793769, 0.13692988092273580531, 0.0148753612908506148525, 7.868691311456132591e-4, 1.8463183175100546818e-5, 1.4215117583164458887e-7, 2.04426310338993978564e-15];
const poly = (c: readonly number[], x: number): number => {
  let v = c[7];
  for (let k = 6; k >= 0; k--) v = v * x + c[k];
  return v;
};
export function zq(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`zq: p ${p} is not in (0, 1)`);
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * poly(A241, r)) / poly(B241, r);
  }
  let r = q < 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let v: number;
  if (r <= 5) {
    r -= 1.6;
    v = poly(C241, r) / poly(D241, r);
  } else {
    r -= 5;
    v = poly(E241, r) / poly(F241, r);
  }
  return q < 0 ? -v : v;
}

// spec 8.5: |x| < 1e−12 is 0 (8–11's numbers only)
export function isZero(x: number): boolean {
  return Math.abs(x) < ZERO;
}

// spec 3.1 / 21.5: two passes (the mean summed oldest first, then (x − mean)² oldest first), ÷ (n − 1); null when
// n < 2
export function sdTwoPass(xs: ArrayLike<number>): number | null {
  const n = xs.length;
  if (n < 2) return null;
  let s = 0;
  for (let k = 0; k < n; k++) s += xs[k];
  const mean = s / n;
  let ss = 0;
  for (let k = 0; k < n; k++) {
    const e = xs[k] - mean;
    ss += e * e;
  }
  return Math.sqrt(ss / (n - 1));
}

const ascending = (xs: readonly number[]): number[] => xs.slice().sort((a, b) => a - b);
// 21.5 中央値: the middle value (odd n), or (a + b) ÷ 2 of the two middle values (even n); null when empty
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = ascending(xs);
  const h = s.length >> 1;
  return s.length % 2 === 1 ? s[h] : (s[h - 1] + s[h]) / 2;
}
// 21.5 95%点: the ⌈(95 × n) ÷ 100⌉-th smallest (1-based, integer arithmetic, no interpolation); null when empty
export function point95(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = ascending(xs);
  const rank = Math.floor((95 * s.length + 99) / 100);
  return s[rank - 1];
}

// spec 14.2 (N4): L = 1 + z(1 − 0.01 ÷ M) ÷ √(2 × 99)
export function nGateL(M: number): number {
  return 1 + zq(1 - 0.01 / M) / Math.sqrt(2 * 99);
}

// spec 11 SE の較正 (21.5 使う SE): κ = (the sd of the runs' values, runs with a value) ÷ (the mean of the used SE,
// runs with a t); used = max(1, κ). runsWithoutT counts the runs whose used SE is null (no t, including a run without
// a value).
export function kappaOf(values: ReadonlyArray<number | null>, usedSe: ReadonlyArray<number | null>): { sd: number | null; meanSe: number | null; runsForSd: number; runsForMeanSe: number; runsWithoutT: number; kappa: number | null; kappaUsed: number | null } {
  if (values.length !== usedSe.length) throw new Error(`kappaOf: ${values.length} values, ${usedSe.length} SE`);
  const vs = values.filter((v): v is number => v !== null);
  const ses = usedSe.filter((v): v is number => v !== null);
  const sd = sdTwoPass(vs);
  let s = 0;
  for (const x of ses) s += x;
  const meanSe = ses.length > 0 ? s / ses.length : null;
  const kappa = sd !== null && meanSe !== null && meanSe !== 0 ? sd / meanSe : null;
  return { sd, meanSe, runsForSd: vs.length, runsForMeanSe: ses.length, runsWithoutT: usedSe.length - ses.length, kappa, kappaUsed: kappa === null ? null : Math.max(1, kappa) };
}

// spec 14.2 (N4): r_used = sd ÷ meanUsed and r_cl = sd ÷ meanWider per trial; their medians (21.5); the gate: the
// median of r_used in [0.70, 1.10], the median of r_cl ≤ 1.15, every r_used and r_cl ≤ L
export function nGate(rows: ReadonlyArray<{ sd: number; meanUsed: number; meanWider: number }>, M: number): { rUsed: number[]; rCl: number[]; rUsedMedian: number | null; rClMedian: number | null; L: number; usedInRange: boolean; clLe115: boolean; allLeL: boolean; pass: boolean } {
  const rUsed = rows.map((r) => r.sd / r.meanUsed);
  const rCl = rows.map((r) => r.sd / r.meanWider);
  const rUsedMedian = median(rUsed);
  const rClMedian = median(rCl);
  const L = nGateL(M);
  const usedInRange = rUsedMedian !== null && rUsedMedian >= 0.7 && rUsedMedian <= 1.1;
  const clLe115 = rClMedian !== null && rClMedian <= 1.15;
  const allLeL = rUsed.every((r) => r <= L) && rCl.every((r) => r <= L);
  return { rUsed, rCl, rUsedMedian, rClMedian, L, usedInRange, clLe115, allLeL, pass: usedInRange && clLe115 && allLeL };
}

// ---- 8.2: strata ----------------------------------------------------------------------------------------------------

// stratum ids are ((pi × 2 + dir) × 24 + hour) × 4 + season < 960
const NS = PAIRS.length * 2 * 24 * 4;
// plant blindNoHour (spec 16 目つぶりの層から時を外す): the stratum without its hour (pair, direction, season)
const keyFnOf = (plant: string): ((id: number) => number) => (plant === "blindNoHour" ? (id) => Math.floor(id / 96) * 96 + (id % 4) : (id) => id);

// The blind rows by stratum: m_s, B_s (mean of h ÷ 2), the mean of PL ÷ 10 and of |m| ÷ 10 (each value divided
// first, summed in row order, divided by m_s)
interface BlindAgg {
  m: Int32Array;
  B: Float64Array;
  plMean: Float64Array;
  absMean: Float64Array;
}
const blindCache = new WeakMap<BlindTable, Map<string, BlindAgg>>();
const blindAggOf = (t: BlindTable, plant: string, keep?: (r: number) => boolean): BlindAgg => {
  const tag = plant === "blindNoHour" ? "nohour" : "hour";
  if (!keep) {
    const hit = blindCache.get(t)?.get(tag);
    if (hit) return hit;
  }
  const key = keyFnOf(plant);
  const m = new Int32Array(NS);
  const sH = new Float64Array(NS);
  const sPl = new Float64Array(NS);
  const sAbs = new Float64Array(NS);
  for (let r = 0; r < t.n; r++) {
    if (keep && !keep(r)) continue;
    const k = key(t.stratum[r]);
    m[k]++;
    sH[k] += t.h[r] / 2;
    sPl[k] += t.pl[r] / 10;
    sAbs[k] += t.absm[r] / 10;
  }
  const B = new Float64Array(NS);
  const plMean = new Float64Array(NS);
  const absMean = new Float64Array(NS);
  for (let k = 0; k < NS; k++) {
    if (m[k] === 0) continue;
    B[k] = sH[k] / m[k];
    plMean[k] = sPl[k] / m[k];
    absMean[k] = sAbs[k] / m[k];
  }
  const out = { m, B, plMean, absMean };
  if (!keep) {
    const c = blindCache.get(t) ?? new Map<string, BlindAgg>();
    c.set(tag, out);
    blindCache.set(t, c);
  }
  return out;
};

// The signals of rows by stratum, Δ (spec 8.3, 21.5), and what the influence functions need
interface DeltaCore {
  N: number;
  value: number | null;
  key: (id: number) => number;
  n: Int32Array;
  sigMean: Float64Array;
  // B_s as Δ uses it (0 under the plant noBlind)
  Bused: Float64Array;
  blind: BlindAgg;
  // Σ (h ÷ 2 − B_s) ÷ n_s per stratum (the plant inflStratumMean)
  dMean: Float64Array;
  noBlind: number;
}
const checkRows = (t: BlindTable, rows: Int32Array) => {
  for (let q = 0; q < rows.length; q++) {
    const r = rows[q];
    if (!(r >= 0 && r < t.n)) throw new Error(`rows: ${r} is not a row of the ${t.tf} ${t.half} table (${t.n})`);
    if (q > 0 && !(r > rows[q - 1])) throw new Error("rows: not strictly ascending (21.5's row order)");
  }
};
const deltaCore = (t: BlindTable, rows: Int32Array, plant: string, blindKeep?: (r: number) => boolean): DeltaCore => {
  checkRows(t, rows);
  const key = keyFnOf(plant);
  const blind = blindAggOf(t, plant, blindKeep);
  const Bused = plant === "noBlind" ? new Float64Array(NS) : blind.B;
  const N = rows.length;
  const n = new Int32Array(NS);
  const sSig = new Float64Array(NS);
  const sD = new Float64Array(NS);
  for (let q = 0; q < N; q++) {
    const r = rows[q];
    const k = key(t.stratum[r]);
    n[k]++;
    sSig[k] += t.h[r] / 2;
    sD[k] += t.h[r] / 2 - Bused[k];
  }
  const sigMean = new Float64Array(NS);
  const dMean = new Float64Array(NS);
  let noBlind = 0;
  for (let k = 0; k < NS; k++) {
    if (n[k] === 0) continue;
    sigMean[k] = sSig[k] / n[k];
    dMean[k] = sD[k] / n[k];
    if (blind.m[k] === 0) noBlind += n[k];
  }
  let value: number | null = null;
  if (N > 0 && noBlind === 0) {
    let acc = 0;
    for (let k = 0; k < NS; k++) if (n[k] > 0) acc += (n[k] / N) * (sigMean[k] - Bused[k]);
    value = 100 * acc;
  }
  return { N, value, key, n, sigMean, Bused, blind, dMean, noBlind };
};

// Spec 8.2: the strata with signals (n_s > 0) by ascending id, N and the signals whose stratum has no blind row
// (0 by construction: every signal row is a row of the table). Plant blindNoHour: the stratum without its hour.
export function strataOf(t: BlindTable, rows: Int32Array, plant = ""): { strata: StratumAgg[]; N: number; noBlind: number } {
  const c = deltaCore(t, rows, plant === "blindNoHour" ? plant : "");
  const strata: StratumAgg[] = [];
  for (let k = 0; k < NS; k++) {
    if (c.n[k] === 0) continue;
    strata.push({ id: k, n: c.n[k], m: c.blind.m[k], sigMean: c.sigMean[k], B: c.blind.B[k], blindPlMean: c.blind.plMean[k], absMMean: c.blind.absMean[k] });
  }
  return { strata, N: c.N, noBlind: c.noBlind };
}

const noBlindStop = (c: DeltaCore, what: string) => {
  if (c.noBlind > 0) stop(`${what}: ${c.noBlind} signals in strata without a blind row (must be 0, spec 6)`);
};

// Spec 8.3: Δ = 100 × Σ_s (n_s ÷ N) × (the signals' mean of h ÷ 2 − B_s), strata ascending, × 100 last; null when
// N = 0. Plants: noBlind (B_s = 0), blindNoHour (the stratum without its hour).
export function deltaOf(t: BlindTable, rows: Int32Array, plant = ""): number | null {
  const c = deltaCore(t, rows, plant);
  noBlindStop(c, "deltaOf");
  return c.value;
}
// Spec 8.3: a = (100 × (Σ h ÷ N)) ÷ 2, h summed in row order; null when N = 0
export function aOf(t: BlindTable, rows: Int32Array): number | null {
  checkRows(t, rows);
  if (rows.length === 0) return null;
  let s = 0;
  for (let q = 0; q < rows.length; q++) s += t.h[rows[q]];
  return (100 * (s / rows.length)) / 2;
}
// Spec 8.4: PL = Σ (pl ÷ 10) in row order ÷ N (pips); null when N = 0
export function plOf(t: BlindTable, rows: Int32Array): number | null {
  checkRows(t, rows);
  if (rows.length === 0) return null;
  let s = 0;
  for (let q = 0; q < rows.length; q++) s += t.pl[rows[q]] / 10;
  return s / rows.length;
}

// Spec 8.4's explanatory numbers and 13's M
export function plExtras(t: BlindTable, rows: Int32Array): PlExtras {
  const c = deltaCore(t, rows, "");
  const N = rows.length;
  const pl = plOf(t, rows);
  // 1週を除いた PL: the week with the largest sum of PL in points (integers; a tie keeps the oldest) is left out
  const weekSum = new Map<number, number>();
  let wCount = 0;
  for (let q = 0; q < N; q++) {
    const r = rows[q];
    weekSum.set(t.week[r], (weekSum.get(t.week[r]) ?? 0) + t.pl[r]);
    if (t.pl[r] > 0) wCount++;
  }
  let ex1wWeek: number | null = null;
  let best = -Infinity;
  for (const [w, sum] of weekSum) {
    if (sum > best) {
      best = sum;
      ex1wWeek = w;
    }
  }
  let sEx = 0;
  let nEx = 0;
  for (let q = 0; q < N; q++) {
    const r = rows[q];
    if (t.week[r] === ex1wWeek) continue;
    sEx += t.pl[r] / 10;
    nEx++;
  }
  // the blind PL and |m| by the strata's weights
  let blindPlW: number | null = null;
  let M: number | null = null;
  if (N > 0) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < NS; k++) {
      if (c.n[k] === 0) continue;
      a += (c.n[k] / N) * c.blind.plMean[k];
      b += (c.n[k] / N) * c.blind.absMean[k];
    }
    blindPlW = a;
    M = b;
  }
  const byPair = PAIRS.map(() => ({ s: 0, n: 0 }));
  const byDir = [{ s: 0, n: 0 }, { s: 0, n: 0 }];
  for (let q = 0; q < N; q++) {
    const r = rows[q];
    const p = byPair[t.pi[r]];
    p.s += t.pl[r] / 10;
    p.n++;
    const g = byDir[t.d[r] === 1 ? 0 : 1];
    g.s += t.pl[r] / 10;
    g.n++;
  }
  return {
    plEx1w: nEx > 0 ? sEx / nEx : null,
    ex1wWeek,
    wCount,
    wRate: N > 0 ? wCount / N : null,
    blindPlW,
    plMinusBlind: pl !== null && blindPlW !== null ? pl - blindPlW : null,
    M,
    plByPair: byPair.map((p) => (p.n > 0 ? p.s / p.n : null)),
    nByPair: byPair.map((p) => p.n),
    plByDir: [byDir[0].n > 0 ? byDir[0].s / byDir[0].n : null, byDir[1].n > 0 ? byDir[1].s / byDir[1].n : null],
    nByDir: [byDir[0].n, byDir[1].n],
  };
}

// Δ of the signal rows that pass sigKeep, against the blind rows that pass blindKeep (all when absent): spec 11's
// C2 / C3 (by direction, by pair; the blind rows are all kept, strata are per pair and direction already) and C6
// (both kept to the part's weeks; n_s, N, m_s and B_s are then the part's)
export function deltaWhere(t: BlindTable, rows: Int32Array, sigKeep: (r: number) => boolean, blindKeep?: (r: number) => boolean): number | null {
  const kept = rows.filter(sigKeep);
  const c = deltaCore(t, kept, "", blindKeep);
  noBlindStop(c, "deltaWhere");
  return c.value;
}

// ---- 8.5: influence functions and clusters -----------------------------------------------------------------------

// Per table row: the signal row's influence (sig, when isSig) and the blind row's (blind; 0 for a value without a
// blind part)
interface Infl {
  isSig: Uint8Array;
  sig: Float64Array;
  blind: Float64Array | null;
}

// Spec 8.5 for Δ: signal row (d_i − Δ′) ÷ N with d_i = h ÷ 2 − B_s first; blind row −(n_s ÷ N) × (h ÷ 2 − B_s) ÷
// m_s (0 for a stratum without signals). Plant inflStratumMean: the signal row subtracts the stratum's mean of d_i
// in place of Δ′.
const deltaInfl = (t: BlindTable, rows: Int32Array, c: DeltaCore, plant: string): Infl => {
  const isSig = new Uint8Array(t.n);
  const sig = new Float64Array(t.n);
  const blind = new Float64Array(t.n);
  if (c.value === null) return { isSig, sig, blind };
  const N = c.N;
  const dP = c.value / 100;
  for (let q = 0; q < rows.length; q++) {
    const r = rows[q];
    const k = c.key(t.stratum[r]);
    const di = t.h[r] / 2 - c.Bused[k];
    isSig[r] = 1;
    sig[r] = plant === "inflStratumMean" ? (di - c.dMean[k]) / N : (di - dP) / N;
  }
  for (let r = 0; r < t.n; r++) {
    const k = c.key(t.stratum[r]);
    const ns = c.n[k];
    blind[r] = ns === 0 ? 0 : (-(ns / N) * (t.h[r] / 2 - c.Bused[k])) / c.blind.m[k];
  }
  return { isSig, sig, blind };
};
// a: (h ÷ 2 − a′) ÷ N for the signal rows; no blind part
const aInfl = (t: BlindTable, rows: Int32Array, a: number | null): Infl => {
  const isSig = new Uint8Array(t.n);
  const sig = new Float64Array(t.n);
  if (a === null) return { isSig, sig, blind: null };
  const N = rows.length;
  const aP = a / 100;
  for (let q = 0; q < N; q++) {
    const r = rows[q];
    isSig[r] = 1;
    sig[r] = (t.h[r] / 2 - aP) / N;
  }
  return { isSig, sig, blind: null };
};
// PL: (pl ÷ 10 − PL) ÷ N (pips) for the signal rows; no blind part
const plInfl = (t: BlindTable, rows: Int32Array, pl: number | null): Infl => {
  const isSig = new Uint8Array(t.n);
  const sig = new Float64Array(t.n);
  if (pl === null) return { isSig, sig, blind: null };
  const N = rows.length;
  for (let q = 0; q < N; q++) {
    const r = rows[q];
    isSig[r] = 1;
    sig[r] = (t.pl[r] / 10 - pl) / N;
  }
  return { isSig, sig, blind: null };
};

// The influence functions of one value per table row (an addition to lawsearch-design.md 6.2, for the hand examples
// A.2.4, A.2.11 and A.2.30, which give them row by row): isSig 1 where the row is a signal row, sig its signal
// row's influence, blind its blind row's (null for a and PL, which have no blind part); before × 100
export function influenceOf(t: BlindTable, rows: Int32Array, value: "delta" | "a" | "pl", plant = ""): { isSig: Uint8Array; sig: Float64Array; blind: Float64Array | null } {
  if (value === "delta") {
    const c = deltaCore(t, rows, plant);
    noBlindStop(c, "influenceOf");
    return deltaInfl(t, rows, c, plant);
  }
  if (value === "a") return aInfl(t, rows, aOf(t, rows));
  return plInfl(t, rows, plOf(t, rows));
}

// S_g per week and per 4-week block (floor((wk − w0) ÷ 4)): every table row's influence summed in row order (the
// signal row's before the blind row's at one row). Every cluster with a table row is a key (C counts them), even
// when its S_g is 0. The rows are in T order, so a cluster's rows are consecutive and the keys come ascending.
const clusterSums = (t: BlindTable, w0: number, f: Infl): { week: Map<number, number>; four: Map<number, number> } => {
  const week = new Map<number, number>();
  const four = new Map<number, number>();
  let wCur = NaN;
  let bCur = NaN;
  let wAcc = 0;
  let bAcc = 0;
  for (let r = 0; r < t.n; r++) {
    const w = t.week[r];
    const b = Math.floor((w - w0) / 4);
    if (w !== wCur) {
      if (!Number.isNaN(wCur)) week.set(wCur, wAcc);
      if (week.has(w)) throw new Error("clusterSums: the table's weeks are not in order");
      wCur = w;
      wAcc = 0;
    }
    if (b !== bCur) {
      if (!Number.isNaN(bCur)) four.set(bCur, bAcc);
      if (four.has(b)) throw new Error("clusterSums: the table's blocks are not in order");
      bCur = b;
      bAcc = 0;
    }
    if (f.isSig[r] === 1) {
      wAcc += f.sig[r];
      bAcc += f.sig[r];
    }
    if (f.blind) {
      wAcc += f.blind[r];
      bAcc += f.blind[r];
    }
  }
  if (!Number.isNaN(wCur)) week.set(wCur, wAcc);
  if (!Number.isNaN(bCur)) four.set(bCur, bAcc);
  return { week, four };
};

// SE = √((C ÷ (C − 1)) × Σ S_g × S_g), clusters ascending, × scale (100 for Δ and a); null when C < 2
const seOf = (sums: Map<number, number>, scale: number): number | null => {
  const C = sums.size;
  if (C < 2) return null;
  let ss = 0;
  for (const g of sums.values()) ss += g * g;
  return Math.sqrt((C / (C - 1)) * ss) * scale;
};

const candOf = (kind: SeKind, se: number | null, C: number, K: number | null): SeCand => ({ kind, se, C, df: C - 1, K, t: null, p: 1, q975: null, halfWidth: null });

// ---- 8.5: the week shift -----------------------------------------------------------------------------------------

// The signal rows moved k weeks on (spec 8.5 週ずらし): each row's week w goes to the k-th next week w′ of the
// table's weeks (t.weeks), wrapping around the end; T′ = T + (w′ − w) × 1 week; the row at (pair, T′, d) of the
// table (rowKey; a late table is keyed by the signal's T) is taken, or the signal is dropped when there is none. The
// stratum is the found row's own (late: of T′ + 15 min). Plant shiftNoWrap: a signal that would wrap is dropped.
export function shiftRows(t: BlindTable, rows: Int32Array, k: number, plant = ""): { rows: Int32Array; dropped: number } {
  const m = shiftMap(t, rows, k, plant);
  const out: number[] = [];
  let dropped = 0;
  for (let q = 0; q < m.to.length; q++) {
    if (m.to[q] < 0) dropped++;
    else out.push(m.to[q]);
  }
  return { rows: Int32Array.from(out).sort(), dropped };
}
// shiftRows' moves one by one (for the hand examples' moved / dropped lists; shiftRows is built on it): per signal
// row rows[q], its T′ (NaN when the plant shiftNoWrap drops it before the lookup) and the row found at T′ (−1 when
// dropped)
export function shiftMap(t: BlindTable, rows: Int32Array, k: number, plant = ""): { from: Int32Array; T2: Float64Array; to: Int32Array } {
  const W = t.weeks.length;
  if (!(Number.isInteger(k) && k >= 1 && k < W)) throw new Error(`shiftRows: k ${k} with ${W} weeks`);
  const pos = new Map<number, number>();
  t.weeks.forEach((w, q) => pos.set(w, q));
  const T2s = new Float64Array(rows.length).fill(NaN);
  const to = new Int32Array(rows.length).fill(-1);
  for (let q = 0; q < rows.length; q++) {
    const r = rows[q];
    const p = pos.get(t.week[r]);
    if (p === undefined) throw new Error(`shiftRows: week ${t.week[r]} is not a week of the table`);
    if (plant === "shiftNoWrap" && p + k >= W) continue;
    const w2 = t.weeks[(p + k) % W];
    const T2 = t.T[r] + (w2 - t.week[r]) * WEEK;
    T2s[q] = T2;
    const r2 = t.index.get(rowKey(t.pi[r], T2, t.d[r] as Dir));
    if (r2 !== undefined) to[q] = r2;
  }
  return { from: rows.slice(), T2: T2s, to };
}

// The shift values of several measures at once (one shiftRows per k): k = 1 … W_h − 1; a k without a signal left is
// skipped (v NaN); SD_shift over the used k (two passes, ÷ (K − 1); null when K < 2)
const shiftRunsOf = (t: BlindTable, rows: Int32Array, plant: string, fns: ReadonlyArray<(rows: Int32Array) => number | null>): ShiftRun[] => {
  const W = t.weeks.length;
  const nk = Math.max(0, W - 1);
  const runs = fns.map(() => ({ k: new Int32Array(nk), n: new Int32Array(nk), dropped: new Int32Array(nk), v: new Float64Array(nk).fill(NaN), used: 0, skipped: 0, sd: null as number | null }));
  for (let k = 1; k <= nk; k++) {
    const sh = shiftRows(t, rows, k, plant);
    fns.forEach((fn, q) => {
      const run = runs[q];
      run.k[k - 1] = k;
      run.n[k - 1] = sh.rows.length;
      run.dropped[k - 1] = sh.dropped;
      const v = sh.rows.length > 0 ? fn(sh.rows) : null;
      if (v === null) run.skipped++;
      else {
        run.v[k - 1] = v;
        run.used++;
      }
    });
  }
  for (const run of runs) run.sd = sdTwoPass(Array.from(run.v).filter((v) => !Number.isNaN(v)));
  return runs;
};

// ---- 8.5: the choices --------------------------------------------------------------------------------------------

// Spec 8.5's choices on the candidates (A.2.7). Each candidate's t, p, q975 and halfWidth are filled in place: t =
// value ÷ se, p = pOneSided(t, df), q975 = t(0.975, df), halfWidth = q975 × se. A candidate has no t when value is
// null, N = 0, se is null, C < 2, |se| < 1e−12, or (shift) K < 2; then t, q975 and halfWidth are null and p is 1.
// When any candidate has no t, the value has none: p = 1, no lb and ub. Otherwise the interval (lb, ub = value ∓
// halfWidth) comes from the widest halfWidth and p from the largest p; ties go to the earlier candidate (week, 4w,
// shift); t is p's candidate's.
export function choose(value: number | null, N: number, cands: SeCand[]): Pick<ValueEst, "hasT" | "useLB" | "useP" | "t" | "p" | "lb" | "ub"> {
  let hasT = cands.length > 0;
  for (const c of cands) {
    const noT = value === null || N === 0 || c.se === null || !Number.isFinite(c.se) || c.C < 2 || isZero(c.se) || (c.kind === "shift" && (c.K ?? 0) < 2);
    if (noT) {
      c.t = null;
      c.p = 1;
      c.q975 = null;
      c.halfWidth = null;
      hasT = false;
      continue;
    }
    const se = c.se as number;
    c.t = (value as number) / se;
    c.p = pOneSided(c.t, c.df);
    c.q975 = tq(0.975, c.df);
    c.halfWidth = c.q975 * se;
  }
  if (!hasT) return { hasT: false, useLB: null, useP: null, t: null, p: 1, lb: null, ub: null };
  let iLB = 0;
  let iP = 0;
  for (let q = 1; q < cands.length; q++) {
    if ((cands[q].halfWidth as number) > (cands[iLB].halfWidth as number)) iLB = q;
    if (cands[q].p > cands[iP].p) iP = q;
  }
  const v = value as number;
  const hw = cands[iLB].halfWidth as number;
  return { hasT: true, useLB: cands[iLB].kind, useP: cands[iP].kind, t: cands[iP].t, p: cands[iP].p, lb: v - hw, ub: v + hw };
}

// Spec 11 (and 12): every candidate's se times max(1, κ), then the choices again (κ never narrows)
export function withKappa(e: ValueEst, kappa: number): ValueEst {
  if (!Number.isFinite(kappa)) throw new Error(`withKappa: κ ${kappa}`);
  if (e.kappa !== 1) throw new Error(`withKappa: κ ${e.kappa} is applied already`);
  const k = Math.max(1, kappa);
  const cands = e.cands.map((c) => ({ ...c, se: c.se === null ? null : c.se * k }));
  return { ...e, cands, kappa: k, ...choose(e.value, e.N, cands) };
}

// ---- 8.5: the estimates ------------------------------------------------------------------------------------------

export interface EstOpts {
  w0: number;
  shift: boolean;
  plant: string;
}

// One value's estimate from its influence functions: week, 4w (C_4w ≥ 10) and, when given, the shift candidate
const estimateOf = (t: BlindTable, value: number | null, N: number, f: Infl, scale: number, w0: number, shift: ShiftRun | null): ValueEst => {
  const sums = value === null ? { week: new Map<number, number>(), four: new Map<number, number>() } : clusterSums(t, w0, f);
  // C counts the clusters with a table row whether or not the value exists
  const C_week = t.weeks.length;
  const C_4w = new Set(Array.from(t.weeks, (w) => Math.floor((w - w0) / 4))).size;
  const four = C_4w >= FOUR_WEEK_MIN_C;
  const cands: SeCand[] = [candOf("week", value === null ? null : seOf(sums.week, scale), C_week, null)];
  if (four) cands.push(candOf("4w", value === null ? null : seOf(sums.four, scale), C_4w, null));
  if (shift) cands.push(candOf("shift", shift.sd, C_week, shift.used));
  return { value, N, C_week, C_4w, four, cands, ...choose(value, N, cands), sums, shift, kappa: 1 };
};

// the shift values of Δ, a and PL (one shift per k)
const deltaFn = (t: BlindTable, plant: string) => (rows: Int32Array): number | null => {
  const c = deltaCore(t, rows, plant);
  noBlindStop(c, "the week shift");
  return c.value;
};

// Spec 8.5 for Δ (and Δ_late on the late table). Plant inflStratumMean (and noBlind, blindNoHour as deltaOf).
export function estDelta(t: BlindTable, rows: Int32Array, o: EstOpts): ValueEst {
  const c = deltaCore(t, rows, o.plant);
  noBlindStop(c, "estDelta");
  const shift = o.shift ? shiftRunsOf(t, rows, o.plant, [deltaFn(t, o.plant)])[0] : null;
  return estimateOf(t, c.value, c.N, deltaInfl(t, rows, c, o.plant), 100, o.w0, shift);
}
// Spec 8.5 for a (the same candidates as Δ, the shift with a_k; no κ, its p not used)
export function estA(t: BlindTable, rows: Int32Array, o: EstOpts): ValueEst {
  const a = aOf(t, rows);
  const shift = o.shift ? shiftRunsOf(t, rows, o.plant, [(r) => aOf(t, r)])[0] : null;
  return estimateOf(t, a, rows.length, aInfl(t, rows, a), 100, o.w0, shift);
}
// Spec 8.5 for PL (pips)
export function estPl(t: BlindTable, rows: Int32Array, o: EstOpts): ValueEst {
  const pl = plOf(t, rows);
  const shift = o.shift ? shiftRunsOf(t, rows, o.plant, [(r) => plOf(t, r)])[0] : null;
  return estimateOf(t, pl, rows.length, plInfl(t, rows, pl), 1, o.w0, shift);
}

// Spec 8.6: D = Δ(rowsA) − Δ(rowsB) on one table. Per row (signal row, blind row), the difference of the two
// influence functions is taken first (a signal row of one trial only counts 0 for the other), then summed per
// cluster in row order. Week and 4w (C_4w ≥ 10); the wider t(0.975) × se is the interval (ties: week); no shift.
export function estDiff(t: BlindTable, rowsA: Int32Array, rowsB: Int32Array, o: EstOpts): ValueEst {
  const cA = deltaCore(t, rowsA, o.plant);
  const cB = deltaCore(t, rowsB, o.plant);
  noBlindStop(cA, "estDiff");
  noBlindStop(cB, "estDiff");
  const value = cA.value !== null && cB.value !== null ? cA.value - cB.value : null;
  const fA = deltaInfl(t, rowsA, cA, o.plant);
  const fB = deltaInfl(t, rowsB, cB, o.plant);
  const isSig = new Uint8Array(t.n);
  const sig = new Float64Array(t.n);
  const blind = new Float64Array(t.n);
  for (let r = 0; r < t.n; r++) {
    if (fA.isSig[r] === 1 || fB.isSig[r] === 1) {
      isSig[r] = 1;
      sig[r] = (fA.isSig[r] === 1 ? fA.sig[r] : 0) - (fB.isSig[r] === 1 ? fB.sig[r] : 0);
    }
    blind[r] = (fA.blind as Float64Array)[r] - (fB.blind as Float64Array)[r];
  }
  return estimateOf(t, value, cA.N, { isSig, sig, blind }, 100, o.w0, null);
}

// ---- 21.5: the non-overlapping version ---------------------------------------------------------------------------

// Spec 7 / 21.5 重ならない版: per pair and direction, in T order, a signal with T before the X (= T + nBars × step)
// of the last kept one is dropped (T = X stays); dropped signals are not compared again. Δ and PL of the kept ones.
export function nonOverlap(t: BlindTable, rows: Int32Array, nBars: number): { N: number; delta: number | null; pl: number | null; rows: Int32Array } {
  checkRows(t, rows);
  const span = nBars * STEP[t.tf];
  const lastX = new Map<number, number>();
  const kept: number[] = [];
  for (let q = 0; q < rows.length; q++) {
    const r = rows[q];
    const g = t.pi[r] * 2 + (t.d[r] === 1 ? 0 : 1);
    const x = lastX.get(g);
    if (x !== undefined && t.T[r] < x) continue;
    kept.push(r);
    lastX.set(g, t.T[r] + span);
  }
  const k = Int32Array.from(kept);
  // rows: the kept rows (for the hand example A.2.28's lists)
  return { N: k.length, delta: deltaOf(t, k), pl: plOf(t, k), rows: k };
}

// ---- one trial ---------------------------------------------------------------------------------------------------

// Every number of one trial in one half (spec 8, 10, 11, 13). t and late are the half's tables; tr comes from
// lawsearch-trade.ts trialRows. dF: the rows of the trial's S_F (directional F; spec 8.6) or (E, F00) (other F) in
// the same table, and its name. Δ, a and PL have the three candidates; Δ_late the same on the late table (its
// interval is the uncorrected two-sided 95% one, C4 reads its lb); PL_late a point only.
export function measureTrial(t: BlindTable, late: BlindTable, tr: TrialRows, o: { w0: number; plant: string; dF: { rows: Int32Array; against: string } | null }): TrialMeasures {
  if (t.late || !late.late) throw new Error("measureTrial: (normal table, late table) expected");
  if (tr.tf !== t.tf || tr.half !== t.half || late.half !== t.half || late.tf !== t.tf) throw new Error(`measureTrial: ${tr.trial} ${tr.tf} ${tr.half} on ${t.tf} ${t.half} / ${late.tf} ${late.half}`);
  // spec 6 (A.2.2 stop_case): a counted signal with a trade and no blind row is a program error; no number is made
  if (tr.noBlind !== 0) stop(`${tr.trial}: ${tr.noBlind} counted signals with a trade but no blind row (must be 0, spec 6)`);
  const rows = tr.rows;
  const plant = o.plant;
  const st = strataOf(t, rows, plant);
  if (st.noBlind !== 0) stop(`${tr.trial}: ${st.noBlind} signals without a blind stratum (must be 0, spec 6)`);
  // Δ, a and PL share one shift per k
  const c = deltaCore(t, rows, plant);
  noBlindStop(c, tr.trial);
  const a = aOf(t, rows);
  const pl = plOf(t, rows);
  const [sD, sA, sP] = shiftRunsOf(t, rows, plant, [deltaFn(t, plant), (r) => aOf(t, r), (r) => plOf(t, r)]);
  const delta = estimateOf(t, c.value, c.N, deltaInfl(t, rows, c, plant), 100, o.w0, sD);
  const aEst = estimateOf(t, a, rows.length, aInfl(t, rows, a), 100, o.w0, sA);
  const plEst = estimateOf(t, pl, rows.length, plInfl(t, rows, pl), 1, o.w0, sP);
  const deltaLate = estDelta(late, tr.lateRows, { w0: o.w0, shift: true, plant });
  const extra = trialRowsExtra(tr);
  const byPD = extra ? extra.countedByPairDir : (() => {
    const x = new Int32Array(PAIRS.length * 2);
    for (const r of rows) x[t.pi[r] * 2 + (t.d[r] === 1 ? 0 : 1)]++;
    return x;
  })();
  const weeks = extra ? extra.countedWeeks : new Set(Array.from(rows, (r) => t.week[r])).size;
  const countedByPair = PAIRS.map((_, pi) => byPD[pi * 2] + byPD[pi * 2 + 1]);
  let buy = 0;
  let sell = 0;
  PAIRS.forEach((_, pi) => {
    buy += byPD[pi * 2];
    sell += byPD[pi * 2 + 1];
  });
  return {
    trial: tr.trial,
    tf: tr.tf,
    half: tr.half,
    counted: tr.counted,
    noTrade: tr.noTrade,
    noBlind: tr.noBlind,
    weeks,
    strata: st.strata,
    delta,
    a: aEst,
    pl: plEst,
    extras: plExtras(t, rows),
    deltaLate,
    plLate: plOf(late, tr.lateRows),
    lateN: tr.lateRows.length,
    lateExcluded: { ...tr.lateExcluded },
    dF: o.dF ? estDiff(t, rows, o.dF.rows, { w0: o.w0, shift: false, plant }) : null,
    dFAgainst: o.dF ? o.dF.against : null,
    nonOverlap: nonOverlap(t, rows, N_BARS),
    deltaByDir: [deltaWhere(t, rows, (r) => t.d[r] === 1), deltaWhere(t, rows, (r) => t.d[r] === -1)],
    countedByDir: [buy, sell],
    deltaByPair: PAIRS.map((_, pi) => deltaWhere(t, rows, (r) => t.pi[r] === pi)),
    countedByPair,
    c6: [0, 1].map((q) => {
      const [lo, hi] = C6_PARTS[q];
      const inPart = (r: number) => t.week[r] >= lo && t.week[r] <= hi;
      return deltaWhere(t, rows, inPart, inPart);
    }) as [number | null, number | null],
  };
}

// Spec 8.7's blind rows of one timeframe and half: the 10 pair × direction rows, each with every blind row of its
// pair and direction as its signals (named blind.<tf>.<SYM>.<buy|sell>). Δ is 0 by definition (n_s = m_s and the
// same means); a, W and PL are the numbers 8.7 asks for, Δ_late the same on the late table.
export function measureBlindRows(t: BlindTable, late: BlindTable, w0: number): TrialMeasures[] {
  const out: TrialMeasures[] = [];
  const info = lateWhyOf(late);
  if (info && info.base !== t) throw new Error("measureBlindRows: the late table was not made from this table");
  for (let pi = 0; pi < PAIRS.length; pi++) {
    for (const d of [1, -1] as const) {
      const rows: number[] = [];
      for (let r = 0; r < t.n; r++) if (t.pi[r] === pi && t.d[r] === d) rows.push(r);
      const lateRows: number[] = [];
      for (let r = 0; r < late.n; r++) if (late.pi[r] === pi && late.d[r] === d) lateRows.push(r);
      const lateExcluded = { noEntry: 0, r4: 0, end: 0 };
      if (info) {
        for (const r of rows) {
          const w = info.why[r];
          if (w === 1) lateExcluded.noEntry++;
          else if (w === 2) lateExcluded.r4++;
          else if (w === 3) lateExcluded.end++;
        }
      }
      const tr: TrialRows = {
        trial: `blind.${t.tf}.${PAIRS[pi].replace("/", "_")}.${d === 1 ? "buy" : "sell"}`,
        tf: t.tf,
        half: t.half,
        counted: rows.length,
        noTrade: 0,
        noBlind: 0,
        rows: Int32Array.from(rows),
        lateRows: Int32Array.from(lateRows),
        lateExcluded,
      };
      out.push(measureTrial(t, late, tr, { w0, plant: "", dF: null }));
    }
  }
  return out;
}
