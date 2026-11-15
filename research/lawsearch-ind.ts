// 法則探し (docs §8.136, research/lawsearch-spec.md): the indicator arrays of one series (builder B,
// research/lawsearch-design.md 5.1).
//
// Spec 3.2 and 17.1: EMA, RMA, ATR, RSI and MACD go through the app functions (pine.ts pineEma, pineRma, pineAtr;
// ultra.ts pineRsi; macd.ts macd); SMA is the research's own, summed oldest first (pine.ts sma sums newest first and
// is used only by the planted error smaNewestFirst); donchian is §8.113 C1, bigmove §8.113 C17 and rsi2 §8.113 C19
// with spec 17.3's substitutions; E29's inside bar and E30's previous day are spec 4.1's own formulas (17.1: the
// research writes E29–E32 itself). The app functions return Array<number | null>; this module converts with toF64
// (null and non-finite → NaN) and never hands an Array to another module. 無し is NaN in a Float64Array and −1 in a
// Tri.
//
// Every comparison here stays on doubles with no tolerance (spec 3.1, 21.5), or on the integer points where the spec
// says points (E29, §8.113 C19).

import { pineAtr, pineEma, pineRma, sma as pineSmaNewestFirst } from "../supabase/functions/_shared/pine.ts";
import { pineRsi } from "../supabase/functions/_shared/ultra.ts";
import { macd as appMacd } from "../supabase/functions/_shared/macd.ts";
import type { BigmoveOut, BigmoveParams, DonchianOut, Ind, MacdOut, RsiOut, Series, Tri } from "./lawsearch-types.ts";

// ---- conversions -------------------------------------------------------------------------------------------

// an app function's output: null and non-finite values become NaN (無し)
export function toF64(xs: ReadonlyArray<number | null>): Float64Array {
  const out = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    out[i] = v === null || v === undefined || !Number.isFinite(v) ? NaN : v;
  }
  return out;
}

// the app functions' input: NaN (無し) becomes null
const toNullable = (x: Float64Array): Array<number | null> => {
  const out: Array<number | null> = new Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Number.isFinite(x[i]) ? x[i] : null;
  return out;
};

// ---- spec 3.2 SMA_p (oldest first) -------------------------------------------------------------------------

// SMA_p(x)[i] for i ≥ p − 1 when x[i−p+1..i] are all present: the window summed oldest first, then ÷ p. Each
// window is summed afresh (a running sum would change the last digit). Plant smaNewestFirst: pine.ts sma.
export function smaOldest(x: Float64Array, p: number, plant = ""): Float64Array {
  if (plant === "smaNewestFirst") return toF64(pineSmaNewestFirst(toNullable(x), p));
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = p - 1; i < x.length; i++) {
    let sum = 0;
    let ok = true;
    for (let k = i - p + 1; k <= i; k++) {
      const v = x[k];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / p;
  }
  return out;
}

// ---- spec 3.1 crosses --------------------------------------------------------------------------------------

const lineAt = (b: Float64Array | number, i: number): number => (typeof b === "number" ? b : b[i]);

// X↑(a, b)[i] = a[i−1] ≤ b[i−1] && a[i] > b[i]; −1 (無し) when any of the four values is 無し, and at i = 0
export function xUp(a: Float64Array, b: Float64Array | number): Tri {
  const out = new Int8Array(a.length).fill(-1);
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i], b0 = lineAt(b, i - 1), b1 = lineAt(b, i);
    if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) continue;
    out[i] = a0 <= b0 && a1 > b1 ? 1 : 0;
  }
  return out;
}

// X↓(a, b)[i] = a[i−1] ≥ b[i−1] && a[i] < b[i]; 無し as xUp
export function xDn(a: Float64Array, b: Float64Array | number): Tri {
  const out = new Int8Array(a.length).fill(-1);
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i], b0 = lineAt(b, i - 1), b1 = lineAt(b, i);
    if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) continue;
    out[i] = a0 >= b0 && a1 < b1 ? 1 : 0;
  }
  return out;
}

// ---- §8.113 C1 donchian (spec 3.3, 4.1 E26) ----------------------------------------------------------------

// HH_n(i) = max H[i−n..i−1], LL_n(i) = min L[i−n..i−1] (bar i not included; 無し for i < n). The target s starts at
// 0 at bar 0 and is never 無し; for i ≥ n: C[i] > HH and s ≠ +1 → +1, C[i] < LL and s ≠ −1 → −1, otherwise
// unchanged (C = HH or C = LL is no break). The same values as bigflow-lib donchianState(c, n) (spec 15).
//
// C4b ("free"): HH and LL come from two monotone queues of bar indices instead of rescanning the n bars of every
// window (O(len) in all instead of O(n × len)); donchianScan below is the rescan, kept for n that is not a whole
// number ≥ 1. The values are the same, double for double, by construction: max and min round nothing, so only which
// bar's value is taken could differ, and it is the same bar. The rescan takes, in each window, the oldest bar whose H
// is the largest under ">" (it starts at −Infinity and replaces only on a strictly larger value; NaN is never larger,
// so a NaN bar is never taken, and a window with no other value gives −Infinity, as does a window of −Infinity alone).
// The queue qh holds the bars of the window that no later bar of the window beats: a bar j is dropped from its back
// when a newer bar has a strictly larger H (j can then never be that window's or a later window's maximum, since the
// newer bar stays in every later window as long as j does), equal values are kept (the older first), NaN bars are
// never put in, and bars older than i − n leave from its front. So the front is the oldest bar with the largest H of
// [i − n, i − 1] (−Infinity when the queue is empty), which is the rescan's bar. LL the same with "<". Nothing after
// bar i − 1 is read for bar i, as before.
export function donchianOf(s: Series, n: number): DonchianOut {
  if (!(Number.isInteger(n) && n >= 1)) return donchianScan(s, n);
  const len = s.n;
  const H = s.H;
  const L = s.L;
  const HH = new Float64Array(len).fill(NaN);
  const LL = new Float64Array(len).fill(NaN);
  const out = new Int8Array(len);
  const qh = new Int32Array(len);
  const ql = new Int32Array(len);
  let h0 = 0, h1 = 0, l0 = 0, l1 = 0;
  // bar j enters both queues (NaN values stay out)
  const enter = (j: number) => {
    const h = H[j];
    if (!Number.isNaN(h)) {
      while (h1 > h0 && H[qh[h1 - 1]] < h) h1--;
      qh[h1++] = j;
    }
    const l = L[j];
    if (!Number.isNaN(l)) {
      while (l1 > l0 && L[ql[l1 - 1]] > l) l1--;
      ql[l1++] = j;
    }
  };
  for (let j = 0; j < n - 1 && j < len; j++) enter(j);
  let target = 0;
  for (let i = n; i < len; i++) {
    // the window [i − n, i − 1]: bar i − 1 enters, bars before i − n leave
    enter(i - 1);
    while (h0 < h1 && qh[h0] < i - n) h0++;
    while (l0 < l1 && ql[l0] < i - n) l0++;
    const hh = h0 < h1 ? H[qh[h0]] : -Infinity;
    const ll = l0 < l1 ? L[ql[l0]] : Infinity;
    HH[i] = hh;
    LL[i] = ll;
    const c = s.C[i];
    if (c > hh && target !== 1) target = 1;
    else if (c < ll && target !== -1) target = -1;
    out[i] = target;
  }
  return { HH, LL, s: out };
}

// donchianOf by rescanning each window (b3a2c43's loop, unchanged): for n that is not a whole number ≥ 1, and for
// the hand check of the queues (design-free/tsr)
export function donchianScan(s: Series, n: number): DonchianOut {
  const len = s.n;
  const HH = new Float64Array(len).fill(NaN);
  const LL = new Float64Array(len).fill(NaN);
  const out = new Int8Array(len);
  let target = 0;
  for (let i = n; i < len; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n; j < i; j++) {
      if (s.H[j] > hh) hh = s.H[j];
      if (s.L[j] < ll) ll = s.L[j];
    }
    HH[i] = hh;
    LL[i] = ll;
    const c = s.C[i];
    if (c > hh && target !== 1) target = 1;
    else if (c < ll && target !== -1) target = -1;
    out[i] = target;
  }
  return { HH, LL, s: out };
}

// ---- §8.113 C17 bigmove (spec 17.3: 12 × STEP gaps; T's UTC time is applied by the item, not here) --------

// §8.113 C17 with spec 17.3's substitutions: σ over r[i−288..i−1] with at least 250 usable, z over 6 bars, ±2, r
// unusable after a gap over 12 × STEP
export function bigmoveDefault(step: number): BigmoveParams {
  return { sigmaWindow: 288, sigmaMinUsable: 250, moveBars: 6, threshold: 2, gapMs: 12 * step };
}

// r[t] = ln(C[t] ÷ C[t−1]) (無し at bar 0); usable[t] when t ≥ 1 and s_t − s_{t−1} ≤ gapMs (a gap of exactly gapMs
// is usable). σ[i] for i ≥ sigmaWindow over the usable r of r[i−W..i−1] (bar i not included) when at least
// sigmaMinUsable are usable: mean = oldest-first sum ÷ count, σ = √(Σ (r − mean)·(r − mean), oldest first, ÷
// (count − 1)), kept only when σ > 0. z[i] = ln(C[i] ÷ C[i−m]) ÷ (σ[i] × √m) when r[i−m+1..i] are all usable.
// ln is Math.log, which is not correctly rounded: r, σ and z are compared to relative 1e−9 (spec 17.2).
//
// C4d (the lead's F1: B06 is now cut on its prefix from bar 0, so this function runs on every cut prefix): the same
// values, bit for bit, as b3a2c43's (and C4c's) bigmoveOf, faster. That code looped over r[i−W..i−1] twice per bar,
// skipping the unusable r, and its time was the two chains of W dependent additions per bar. Here:
//   * ru holds the usable r in bar order and at[t] how many usable r come before bar t, so the usable r of
//     r[i−W..i−1] are ru[at[i−W]] … ru[at[i] − 1], in the same oldest-first order, and count = at[i] − at[i−W];
//   * one(i) is that code's body for bar i on ru: the same count, the same additions in the same order from 0 (the
//     skipped r added nothing before, and are not in ru now), the same mean, sum of squares, division and √;
//   * four bars i … i + 3 whose windows have the same count (≥ sigmaMinUsable) are summed side by side: each of the
//     four sums (and sums of squares) is still its own chain, started from 0 and added to in its own oldest-first
//     order, exactly as one(i + j) would add them; only the chains are interleaved, so the CPU can overlap them.
//     Any other group of four goes through one() bar by bar. Floating-point addition is not associative, so no sum
//     is ever reordered, split or shared between windows (no running sum); only independent chains are overlapped.
// The function is the same one for the main run, the dumps, the hand examples and every check (lawsearch-items.ts B06
// through Ind.bigmove); C4d's equality test compared it with C4c's on every series and many prefixes of the
// synthetic runs (c4d/tools/bmeq.ts in the C4d scratch folder).
const BM_LANES = 4;
export function bigmoveOf(s: Series, o: BigmoveParams): BigmoveOut {
  const n = s.n;
  const r = new Float64Array(n).fill(NaN);
  const usable = new Uint8Array(n);
  for (let t = 1; t < n; t++) {
    r[t] = Math.log(s.C[t] / s.C[t - 1]);
    usable[t] = s.s[t] - s.s[t - 1] <= o.gapMs ? 1 : 0;
  }
  const sigma = new Float64Array(n).fill(NaN);
  const W = o.sigmaWindow;
  const minUsable = o.sigmaMinUsable;
  // the usable r in bar order, and how many come before each bar
  const at = new Int32Array(n + 1);
  const ru = new Float64Array(n);
  let nu = 0;
  for (let t = 0; t < n; t++) {
    at[t] = nu;
    if (usable[t] === 1) ru[nu++] = r[t];
  }
  at[n] = nu;
  // σ[i] alone (the loop body before C4d, on ru)
  const one = (i: number) => {
    const a = at[i - W];
    const count = at[i] - a;
    if (count < minUsable) return;
    let sum = 0;
    for (let u = 0; u < count; u++) sum += ru[a + u];
    const mean = sum / count;
    let ss = 0;
    for (let u = 0; u < count; u++) {
      const dv = ru[a + u] - mean;
      ss += dv * dv;
    }
    const sd = Math.sqrt(ss / (count - 1));
    if (sd > 0) sigma[i] = sd;
  };
  let i = W;
  for (; i + BM_LANES <= n; i += BM_LANES) {
    const a0 = at[i - W], a1 = at[i + 1 - W], a2 = at[i + 2 - W], a3 = at[i + 3 - W];
    const count = at[i] - a0;
    if (count < minUsable || at[i + 1] - a1 !== count || at[i + 2] - a2 !== count || at[i + 3] - a3 !== count) {
      one(i);
      one(i + 1);
      one(i + 2);
      one(i + 3);
      continue;
    }
    // four windows of one count side by side (the header above): four chains, each in one(i + j)'s order
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let u = 0; u < count; u++) {
      s0 += ru[a0 + u];
      s1 += ru[a1 + u];
      s2 += ru[a2 + u];
      s3 += ru[a3 + u];
    }
    const m0 = s0 / count, m1 = s1 / count, m2 = s2 / count, m3 = s3 / count;
    let q0 = 0, q1 = 0, q2 = 0, q3 = 0;
    for (let u = 0; u < count; u++) {
      const d0 = ru[a0 + u] - m0;
      const d1 = ru[a1 + u] - m1;
      const d2 = ru[a2 + u] - m2;
      const d3 = ru[a3 + u] - m3;
      q0 += d0 * d0;
      q1 += d1 * d1;
      q2 += d2 * d2;
      q3 += d3 * d3;
    }
    const sd0 = Math.sqrt(q0 / (count - 1));
    const sd1 = Math.sqrt(q1 / (count - 1));
    const sd2 = Math.sqrt(q2 / (count - 1));
    const sd3 = Math.sqrt(q3 / (count - 1));
    if (sd0 > 0) sigma[i] = sd0;
    if (sd1 > 0) sigma[i + 1] = sd1;
    if (sd2 > 0) sigma[i + 2] = sd2;
    if (sd3 > 0) sigma[i + 3] = sd3;
  }
  for (; i < n; i++) one(i);
  const z = new Float64Array(n).fill(NaN);
  const m = o.moveBars;
  const rootM = Math.sqrt(m);
  for (let i = m; i < n; i++) {
    if (Number.isNaN(sigma[i])) continue;
    let ok = true;
    for (let t = i - m + 1; t <= i; t++) {
      if (usable[t] !== 1) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    z[i] = Math.log(s.C[i] / s.C[i - m]) / (sigma[i] * rootM);
  }
  return { r, usable, sigma, z };
}

// ---- §8.113 C19 rsi2 (spec 3.3, 4.4 B07; step 4) -------------------------------------------------------------

// §8.113 C19's RSI2 on the point closes c = Pc, from bar 0 (S0 から続けて): u[k] = max(c[k] − c[k−1], 0), v[k] =
// max(c[k−1] − c[k], 0); at bar 2 AG = (u[1] + u[2]) ÷ 2 and AL = (v[1] + v[2]) ÷ 2; from bar 3 AG = (AG × 1 + u[k])
// ÷ 2 and AL = (AL × 1 + v[k]) ÷ 2, in doubles and in this order (C19's words). 無し before bar 2. Nothing after bar
// k is read for bar k. The comparisons RSI2 < 10 ⇔ 9 × AG < AL and RSI2 > 90 ⇔ AG > 9 × AL are the item's
// (lawsearch-items.ts B07).
export function rsi2Of(s: Series): { AG: Float64Array; AL: Float64Array } {
  const n = s.n;
  const c = s.Pc;
  const AG = new Float64Array(n).fill(NaN);
  const AL = new Float64Array(n).fill(NaN);
  if (n < 3) return { AG, AL };
  const up = (k: number) => Math.max(c[k] - c[k - 1], 0);
  const dn = (k: number) => Math.max(c[k - 1] - c[k], 0);
  let ag = (up(1) + up(2)) / 2;
  let al = (dn(1) + dn(2)) / 2;
  AG[2] = ag;
  AL[2] = al;
  for (let k = 3; k < n; k++) {
    ag = (ag * 1 + up(k)) / 2;
    al = (al * 1 + dn(k)) / 2;
    AG[k] = ag;
    AL[k] = al;
  }
  return { AG, AL };
}

// §8.113 C19's 200-bar mean parts on the point closes: up[i] = (w × c[i] > Σ c[i−w+1..i]), dn[i] = (w × c[i] <
// Σ c[i−w+1..i]), 無し for i < w − 1 (w = 200). The closes are integers and every partial sum is an integer below
// 2^53 (w × 2^31 at most), so each sum is exact whatever the order: the running sum (the new close added, the leaving
// one taken away) is the same double as the window summed oldest first (spec 3.1), and it reads nothing after bar i.
export function mean200Of(s: Series, w = 200): { up: Tri; dn: Tri } {
  const n = s.n;
  const c = s.Pc;
  const up = new Int8Array(n).fill(-1);
  const dn = new Int8Array(n).fill(-1);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += c[i];
    if (i >= w) sum -= c[i - w];
    if (i < w - 1) continue;
    const x = w * c[i];
    up[i] = x > sum ? 1 : 0;
    dn[i] = x < sum ? 1 : 0;
  }
  return { up, dn };
}

// ---- spec 4.1 E29 and E30 (step 4) -------------------------------------------------------------------------

// E29's inside bar (spec 4.1, in points): inside[i] = (Ph[i−1] ≤ Ph[i−2] && Pl[i−1] ≥ Pl[i−2]); 無し for i < 2
// (equal highs or lows are inside)
export function insideOf(s: Series): Tri {
  const out = new Int8Array(s.n).fill(-1);
  for (let i = 2; i < s.n; i++) out[i] = s.Ph[i - 1] <= s.Ph[i - 2] && s.Pl[i - 1] >= s.Pl[i - 2] ? 1 : 0;
  return out;
}

// E30's previous day (spec 2 日, 4.1 E30's notes), per bar i: first[i] = 1 at the first bar of its day D(s_i)
// (series.day); prevDay[i] = the previous day (the latest day before D(s_i) that has a bar, i.e. the day of the
// bars just before bar i's day) as YYYYMMDD, −1 when there is none; prevBars[i] = that day's bar count; PDH[i] and
// PDL[i] = the max H and min L of that day's bars (the rounded mid doubles), 無し when there is no previous day or it
// has fewer than minBars bars. Only bars before bar i's day are read for bar i. The days of a series never go back
// in time (D is (t + 3 h)'s date, a Saturday moved to the Friday), and this function stops when they do.
export function pdayOf(s: Series, minBars: number): { first: Uint8Array; prevDay: Int32Array; prevBars: Int32Array; PDH: Float64Array; PDL: Float64Array } {
  const n = s.n;
  const first = new Uint8Array(n);
  const prevDay = new Int32Array(n).fill(-1);
  const prevBars = new Int32Array(n);
  const PDH = new Float64Array(n).fill(NaN);
  const PDL = new Float64Array(n).fill(NaN);
  // the day being read, and the day before it
  let day = -1, hi = -Infinity, lo = Infinity, count = 0;
  let pDay = -1, pHi = NaN, pLo = NaN, pCount = 0;
  for (let i = 0; i < n; i++) {
    const d = s.day[i];
    if (i === 0 || d !== day) {
      if (i > 0 && d < day) throw new Error(`pdayOf: ${s.pair} ${s.key}: the day goes back at bar ${i} (${day} → ${d})`);
      if (i > 0) {
        pDay = day;
        pHi = hi;
        pLo = lo;
        pCount = count;
      }
      day = d;
      hi = -Infinity;
      lo = Infinity;
      count = 0;
      first[i] = 1;
    }
    prevDay[i] = pDay;
    prevBars[i] = pCount;
    if (pDay !== -1 && pCount >= minBars) {
      PDH[i] = pHi;
      PDL[i] = pLo;
    }
    count++;
    if (s.H[i] > hi) hi = s.H[i];
    if (s.L[i] < lo) lo = s.L[i];
  }
  return { first, prevDay, prevBars, PDH, PDL };
}

// ---- the Ind of one series (lazy, cached per name and parameter) -------------------------------------------

// The indicators of one series (spec 3.2, 17.1). higher: the higher timeframe's series and the usable higher bar
// of each base bar (spec 2 上位足); its Ind is indOf(higher.series). plant: smaNewestFirst reaches smaOf.
export function indOf(series: Series, higher?: { series: Series; g: Int32Array } | null, plant = ""): Ind {
  const C = series.C;
  const cache = new Map<string, unknown>();
  const byArray = new WeakMap<Float64Array, Map<string, Float64Array>>();
  const memo = <T>(key: string, make: () => T): T => {
    if (cache.has(key)) return cache.get(key) as T;
    const v = make();
    cache.set(key, v);
    return v;
  };
  const memoOf = (x: Float64Array, key: string, make: () => Float64Array): Float64Array => {
    let m = byArray.get(x);
    if (!m) {
      m = new Map();
      byArray.set(x, m);
    }
    const hit = m.get(key);
    if (hit) return hit;
    const v = make();
    m.set(key, v);
    return v;
  };
  // pineAtr's bar objects, made once per series
  let atrBars: Array<{ high: number; low: number; close: number }> | null = null;
  const barsForAtr = () => {
    if (!atrBars) {
      atrBars = new Array(series.n);
      for (let i = 0; i < series.n; i++) atrBars[i] = { high: series.H[i], low: series.L[i], close: series.C[i] };
    }
    return atrBars;
  };
  const emaOf = (x: Float64Array, p: number): Float64Array => memoOf(x, `ema:${p}`, () => toF64(pineEma(toNullable(x), p)));
  const rmaOf = (x: Float64Array, p: number): Float64Array => memoOf(x, `rma:${p}`, () => toF64(pineRma(toNullable(x), p)));
  const smaOf = (x: Float64Array, p: number): Float64Array => memoOf(x, `sma:${p}:${plant}`, () => smaOldest(x, p, plant));
  const higherInd = higher ? indOf(higher.series, null, plant) : null;
  const ind: Ind = {
    series,
    higher: higherInd,
    g: higher ? higher.g : null,
    ema: (p: number) => emaOf(C, p),
    emaOf,
    rmaOf,
    smaOf,
    // TR on the mid doubles, pineAtr's: TR[0] = H[0] − L[0]; TR[i] = max(H−L, |H − C[i−1]|, |L − C[i−1]|)
    tr: () =>
      memo("tr", () => {
        const out = new Float64Array(series.n);
        for (let i = 0; i < series.n; i++) {
          const h = series.H[i], l = series.L[i];
          out[i] = i === 0 ? h - l : Math.max(h - l, Math.abs(h - C[i - 1]), Math.abs(l - C[i - 1]));
        }
        return out;
      }),
    atr: (p: number) => memo(`atr:${p}`, () => toF64(pineAtr(barsForAtr(), p))),
    // up[0], dn[0] 無し; up = max(C[i] − C[i−1], 0), dn = max(C[i−1] − C[i], 0); U = pineRma(up), D = pineRma(dn);
    // the RSI itself is pineRsi's (the same arithmetic, spec 3.2).
    // C4b ("free"): up, dn, U and D are made when first read (getters; U and D through rmaOf's memo, so every read
    // gets the same array), not with the RSI: a signal reads only rsi, the dump and the hand examples read them all.
    // pineRsi gets C as a plain array copied by a loop (Array.from(C) gave the same numbers in the same order, more
    // slowly). Each value is the one b3a2c43 computed: the same functions on the same inputs.
    rsi: (p: number) =>
      memo(`rsi:${p}`, (): RsiOut => {
        let upDn: [Float64Array, Float64Array] | null = null;
        const upDnOf = (): [Float64Array, Float64Array] => {
          if (upDn) return upDn;
          const up = new Float64Array(series.n).fill(NaN);
          const dn = new Float64Array(series.n).fill(NaN);
          for (let i = 1; i < series.n; i++) {
            up[i] = Math.max(C[i] - C[i - 1], 0);
            dn[i] = Math.max(C[i - 1] - C[i], 0);
          }
          upDn = [up, dn];
          return upDn;
        };
        const closes: number[] = [];
        for (let i = 0; i < C.length; i++) closes.push(C[i]);
        const rsi = toF64(pineRsi(closes, p));
        return {
          get up() {
            return upDnOf()[0];
          },
          get dn() {
            return upDnOf()[1];
          },
          get U() {
            return rmaOf(upDnOf()[0], p);
          },
          get D() {
            return rmaOf(upDnOf()[1], p);
          },
          rsi,
        };
      }),
    // step 4 (E13): the app's macd (_shared/macd.ts: line = pineEma(C, f) − pineEma(C, s), 無し when either is;
    // signal = pineEma(line, m), seeded where m lines are first present), its line and signal only (spec 17.1). C is
    // handed as a plain array copied by a loop, as for pineRsi above.
    macd: (f: number, sl: number, m: number) =>
      memo(`macd:${f}:${sl}:${m}`, (): MacdOut => {
        const closes: number[] = [];
        for (let i = 0; i < C.length; i++) closes.push(C[i]);
        const r = appMacd(closes, { fast: f, slow: sl, signal: m });
        return { line: toF64(r.macd), signal: toF64(r.signal) };
      }),
    donchian: (n: number) => memo(`donchian:${n}`, () => donchianOf(series, n)),
    bigmove: (o: BigmoveParams) =>
      memo(`bigmove:${o.sigmaWindow}:${o.sigmaMinUsable}:${o.moveBars}:${o.threshold}:${o.gapMs}`, () => bigmoveOf(series, o)),
  };
  return ind;
}
