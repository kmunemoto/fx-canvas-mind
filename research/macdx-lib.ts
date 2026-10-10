// #272 (docs §8.109): the MACD extreme-cross rule, as pure functions over a
// pair's chart bars, so the study (research/macdx.ts), the look-ahead check on
// the email sweep's own 600-bar windows and the hand examples
// (research/macdx-hand.ts) all decide through the same code.
//
// THE RULE, frozen 2026-10-10 before any of the measured period was read
// (§8.109 合図の決まり 1-9; PR #197): at a closed 5-minute bar i, judged on the
// 600 closed bars ending at i,
//   cross   side(k) = +1 if h[k] > 0, -1 if h[k] < 0, side(k-1) if h[k] == 0
//           (h = MACD - signal, unrounded); a cross when side(i-1) and side(i)
//           are both defined and differ: UP to +1, DOWN to -1
//   x       +m[i] on a DOWN cross, -m[i] on an UP cross (price units)
//   C0      x > 0
//   C1      S = TR[i-287] + .. + TR[i], added one at a time in that order;
//           S > 0 and (4 * x) * 288 >= S
//   C2      P = max |m[k]| over k = max(r, i-287) .. i, r the first bar of the
//           current run of the sign of m (m == 0 keeps the sign; a null m ends
//           a run); 2 * x >= P
//   fire    C0 and C1 and C2 (equalities fire): SELL on DOWN, BUY on UP
// TR[k] = max(high[k], close[k-1]) - min(low[k], close[k-1]) on the chart's
// rounded mid bars, close[k-1] the previous bar by index (across a gap too).

import { macd } from "../supabase/functions/_shared/macd.ts";

export const WINDOW = 600;
export const N_TR = 288;
export const L_WAVE = 288;

export type Side = "BUY" | "SELL";
export type Dir = "UP" | "DOWN";
export interface Bar { high: number; low: number; close: number }

// side of h at each bar: +1, -1, or null (h null, or no nonzero h yet)
export const sidesOf = (h: ReadonlyArray<number | null>): Array<1 | -1 | null> => {
  const out: Array<1 | -1 | null> = new Array(h.length).fill(null);
  for (let k = 0; k < h.length; k++) {
    const v = h[k];
    if (v === null) out[k] = null;
    else if (v > 0) out[k] = 1;
    else if (v < 0) out[k] = -1;
    else out[k] = k > 0 ? out[k - 1] : null;
  }
  return out;
};

// sign of m at each bar, the same way (m == 0 keeps the previous sign)
export const msignsOf = (m: ReadonlyArray<number | null>): Array<1 | -1 | null> => sidesOf(m);

export const trOf = (bars: ReadonlyArray<Bar>): number[] => {
  const tr = new Array(bars.length).fill(Number.NaN);
  for (let k = 1; k < bars.length; k++) {
    const pc = bars[k - 1].close;
    tr[k] = Math.max(bars[k].high, pc) - Math.min(bars[k].low, pc);
  }
  return tr;
};

export interface Decision {
  dir: Dir;
  side: Side;
  x: number;
  // C1's sum and C2's peak, and the first bar the peak was taken from
  S: number;
  P: number;
  from: number;
  // the first bar of the run of the sign of m (before the 288-bar cap)
  run: number;
  c0: boolean;
  c1: boolean;
  c2: boolean;
  fire: boolean;
}

// the run start: the first bar of the maximal run ending at i whose sign
// (m == 0 keeping the previous sign) equals the sign at i; -1 when the sign
// at i is undefined
export const runStart = (ms: ReadonlyArray<1 | -1 | null>, i: number): number => {
  const s = ms[i];
  if (s === null) return -1;
  let r = i;
  while (r - 1 >= 0 && ms[r - 1] === s) r--;
  return r;
};

// The decision at bar i of arrays that hold at least the bars i-599 .. i
// (`first` is the index of the window's first bar: the bars before it are not
// read). Null when there is no cross at i, or the window is short.
export const decide = (
  m: ReadonlyArray<number | null>,
  sides: ReadonlyArray<1 | -1 | null>,
  ms: ReadonlyArray<1 | -1 | null>,
  tr: ReadonlyArray<number>,
  i: number,
  first: number,
): Decision | null => {
  if (i - first + 1 < WINDOW) return null;
  if (i < 1) return null;
  const a = sides[i - 1];
  const b = sides[i];
  if (a === null || b === null || a === b) return null;
  const dir: Dir = b === 1 ? "UP" : "DOWN";
  const mi = m[i];
  if (mi === null) return null;
  const x = dir === "DOWN" ? mi : -mi;
  let S = 0;
  for (let k = i - N_TR + 1; k <= i; k++) S += tr[k];
  const r = runStart(ms, i);
  const from = r < 0 ? i : Math.max(r, i - L_WAVE + 1);
  let P = 0;
  for (let k = from; k <= i; k++) {
    const v = m[k];
    if (v !== null && Math.abs(v) > P) P = Math.abs(v);
  }
  const c0 = x > 0;
  const c1 = S > 0 && 4 * x * 288 >= S;
  const c2 = 2 * x >= P;
  return { dir, side: dir === "DOWN" ? "SELL" : "BUY", x, S, P, from, run: r, c0, c1, c2, fire: c0 && c1 && c2 };
};

// Everything the rule needs, over a whole series of the chart's bars
export interface Prepared {
  m: Array<number | null>;
  h: Array<number | null>;
  sides: Array<1 | -1 | null>;
  ms: Array<1 | -1 | null>;
  tr: number[];
}
export const prepare = (bars: ReadonlyArray<Bar>): Prepared => {
  const r = macd(bars.map((b) => b.close));
  return { m: r.macd, h: r.hist, sides: sidesOf(r.hist), ms: msignsOf(r.macd), tr: trOf(bars) };
};

// The same decision recomputed the way the email sweep would: MACD on the 600
// bars ending at i alone (the look-ahead check, §8.109 確かめ 1)
export const decideOnWindow = (bars: ReadonlyArray<Bar>, i: number): Decision | null => {
  if (i + 1 < WINDOW) return null;
  const w = bars.slice(i - WINDOW + 1, i + 1);
  const p = prepare(w);
  return decide(p.m, p.sides, p.ms, p.tr, WINDOW - 1, 0);
};

// Reporting only (§8.109 ほかに出す数字): the decision under the two variants
// of where a wave starts, with a = S / 288 the mean range at i
//   "beyond": a run is reset only by m going past 0 by at least 0.2 a
//   "near":   a run is also cut where |m| < 0.2 a
export const c2Variant = (m: ReadonlyArray<number | null>, i: number, x: number, S: number, variant: "beyond" | "near"): boolean => {
  const a = S / N_TR;
  const thr = 0.2 * a;
  const mi = m[i];
  if (mi === null || x <= 0) return false;
  const s = mi > 0 ? 1 : -1;
  const lo = i - L_WAVE + 1;
  let P = 0;
  for (let k = i; k >= lo; k--) {
    const v = m[k];
    if (v === null) break;
    if (variant === "beyond") {
      if (v * s < 0 && Math.abs(v) >= thr) break;
    } else {
      if (v * s < 0 || Math.abs(v) < thr) {
        if (k !== i) break;
      }
    }
    if (Math.abs(v) > P) P = Math.abs(v);
  }
  return 2 * x >= P;
};
