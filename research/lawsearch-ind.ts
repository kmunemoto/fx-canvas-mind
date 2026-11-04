// 法則探し (docs §8.136, research/lawsearch-spec.md): the indicator arrays of one series (builder B,
// research/lawsearch-design.md 5.1).
//
// Spec 3.2 and 17.1: EMA, RMA, ATR and RSI go through the app functions (pine.ts pineEma, pineRma, pineAtr;
// ultra.ts pineRsi); SMA is the research's own, summed oldest first (pine.ts sma sums newest first and is used only
// by the planted error smaNewestFirst); donchian is §8.113 C1 and bigmove §8.113 C17 with spec 17.3's substitutions.
// The app functions return Array<number | null>; this module converts with toF64 (null and non-finite → NaN) and
// never hands an Array to another module. 無し is NaN in a Float64Array and −1 in a Tri.
//
// Every comparison here stays on doubles with no tolerance (spec 3.1, 21.5).

import { pineAtr, pineEma, pineRma, sma as pineSmaNewestFirst } from "../supabase/functions/_shared/pine.ts";
import { pineRsi } from "../supabase/functions/_shared/ultra.ts";
import type { BigmoveOut, BigmoveParams, DonchianOut, Ind, RsiOut, Series, Tri } from "./lawsearch-types.ts";

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
export function donchianOf(s: Series, n: number): DonchianOut {
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
  for (let i = W; i < n; i++) {
    let count = 0;
    let sum = 0;
    for (let t = i - W; t < i; t++) {
      if (usable[t] === 1) {
        count++;
        sum += r[t];
      }
    }
    if (count < o.sigmaMinUsable) continue;
    const mean = sum / count;
    let ss = 0;
    for (let t = i - W; t < i; t++) {
      if (usable[t] === 1) {
        const dv = r[t] - mean;
        ss += dv * dv;
      }
    }
    const sd = Math.sqrt(ss / (count - 1));
    if (sd > 0) sigma[i] = sd;
  }
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
    // the RSI itself is pineRsi's (the same arithmetic, spec 3.2)
    rsi: (p: number) =>
      memo(`rsi:${p}`, (): RsiOut => {
        const up = new Float64Array(series.n).fill(NaN);
        const dn = new Float64Array(series.n).fill(NaN);
        for (let i = 1; i < series.n; i++) {
          up[i] = Math.max(C[i] - C[i - 1], 0);
          dn[i] = Math.max(C[i - 1] - C[i], 0);
        }
        return { up, dn, U: rmaOf(up, p), D: rmaOf(dn, p), rsi: toF64(pineRsi(Array.from(C), p)) };
      }),
    donchian: (n: number) => memo(`donchian:${n}`, () => donchianOf(series, n)),
    bigmove: (o: BigmoveParams) =>
      memo(`bigmove:${o.sigmaWindow}:${o.sigmaMinUsable}:${o.moveBars}:${o.threshold}:${o.gapMs}`, () => bigmoveOf(series, o)),
  };
  return ind;
}
