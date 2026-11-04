// #318 (docs §8.113 2): a pair's 5-minute bars. Bid and ask as GMO gave them (merged by time, the weekend's
// bars and the crossed rows left out by the reader), and the chart's mid: (bid + ask) ÷ 2 as a double,
// rounded as the chart draws it (live-chart historyRead: Number(v.toFixed(d)), d 3 on the yen pairs and 5 on
// the dollar pairs). Bars are numbered from 0 (the first usable bar from S0), gaps not filled. Pure.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import { pineAtr } from "../supabase/functions/_shared/pine.ts";
import { ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import type { Pair } from "./chartbest-const.ts";
import { plant } from "./chartbest-plants.ts";

export interface BarsView {
  pair: Pair;
  pi: number;
  // a pip (0.01 / 0.0001) and the chart's decimals
  unit: number;
  digits: number;
  // element k is the bar with index base + k (indices from S0)
  base: number;
  n: number;
  t: Float64Array;
  mo: Float64Array;
  mh: Float64Array;
  ml: Float64Array;
  mc: Float64Array;
}
export interface PairBars extends BarsView {
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
}

export const isJpy = (pair: string): boolean => pair.includes("JPY");
export const digitsOf = (pair: string): number => (isJpy(pair) ? 3 : 5);
export const pipOf = (pair: string): number => ultraUnit(pair);
// 2: the chart's rounding (the exact double, a tie upwards: toFixed)
export const chartRound = (v: number, d: number): number => Number(v.toFixed(d));
// the planted roundings (20 (f), hook "hand"): half to even on the exact double, and half up on the shortest
// decimal string (Python's Decimal(str(v))) — hand.round.1 and hand.round.2 must catch them
const exactDigits = (v: number): string => v.toPrecision(100).replace(/0+$/, "");
export const halfEvenRound = (v: number, d: number): number => {
  const s = exactDigits(Math.abs(v));
  const dot = s.indexOf(".");
  const tail = dot < 0 ? "" : s.slice(dot + 1 + d);
  const tie = /^50*$/.test(tail);
  if (!tie) return chartRound(v, d);
  const down = Number(v.toFixed(d + 1).slice(0, -1));
  const last = Number(down.toFixed(d).slice(-1));
  return last % 2 === 0 ? down : chartRound(v, d);
};
export const shortestReprRound = (v: number, d: number): number => {
  const s = String(v);
  const dot = s.indexOf(".");
  if (dot < 0 || s.length - dot - 1 <= d) return v;
  const up = s[dot + 1 + d] >= "5";
  const cut = Number(s.slice(0, dot + 1 + d));
  return up ? Number((cut + Math.sign(v) * 10 ** -d).toFixed(d)) : cut;
};
const roundPlanted = (v: number, d: number): number => {
  const pl = plant();
  return pl === "midHalfEven" ? halfEvenRound(v, d) : pl === "midShortestRepr" ? shortestReprRound(v, d) : chartRound(v, d);
};
export const midOf = (bid: number, ask: number, d: number): number => roundPlanted((bid + ask) / 2, d);
// 2: 点 — the rounded mid × 1,000 (yen) or 100,000, to the nearest whole number (the plant "pointsTrunc" cuts)
export const pointsOf = (v: number, pair: string): number => {
  const x = v * (isJpy(pair) ? 1e3 : 1e5);
  return plant() === "pointsTrunc" ? Math.trunc(x) : Math.round(x);
};
const MID_PLANTS = ["midHalfEven", "midShortestRepr"];

const F = (n: number) => new Float64Array(n);

// The bars of a pair from its merged quotes (oldest first, all closed by `end`): the chart's own read
// (historyRead) gives the mids; its bars are the quotes' one for one
export const pairBarsOf = (pair: Pair, pi: number, quotes: QuoteCandle[], end: number): PairBars => {
  const candles = historyRead(pair, "5min", quotes, end).candles;
  if (candles.length !== quotes.length) throw new Error(`${pair}: ${candles.length} chart bars from ${quotes.length} quotes`);
  const n = quotes.length;
  const pb: PairBars = {
    pair, pi, unit: pipOf(pair), digits: digitsOf(pair), base: 0, n,
    t: F(n), mo: F(n), mh: F(n), ml: F(n), mc: F(n),
    bo: F(n), bh: F(n), bl: F(n), bc: F(n), ao: F(n), ah: F(n), al: F(n), ac: F(n),
  };
  const planted = MID_PLANTS.includes(plant());
  for (let k = 0; k < n; k++) {
    const q = quotes[k];
    const c = candles[k];
    const t = barOpenMs(q.datetime);
    if (barOpenMs(c.datetime) !== t) throw new Error(`${pair}: chart bar ${k} is not quote ${k}`);
    if (k > 0 && !(t > pb.t[k - 1])) throw new Error(`${pair}: the bars are not in time order at ${k}`);
    pb.t[k] = t;
    pb.mo[k] = planted ? midOf(q.bid.open, q.ask.open, pb.digits) : c.open;
    pb.mh[k] = planted ? midOf(q.bid.high, q.ask.high, pb.digits) : c.high;
    pb.ml[k] = planted ? midOf(q.bid.low, q.ask.low, pb.digits) : c.low;
    pb.mc[k] = planted ? midOf(q.bid.close, q.ask.close, pb.digits) : c.close;
    pb.bo[k] = q.bid.open;
    pb.bh[k] = q.bid.high;
    pb.bl[k] = q.bid.low;
    pb.bc[k] = q.bid.close;
    pb.ao[k] = q.ask.open;
    pb.ah[k] = q.ask.high;
    pb.al[k] = q.ask.low;
    pb.ac[k] = q.ask.close;
  }
  return pb;
};

// The same from bid and ask arrays (made-up bars handed over in memory, or bars edited by a check): the mids
// re-derived as the chart derives them
export const pairBarsFromSides = (pair: Pair, pi: number, s: Omit<PairBars, "pair" | "pi" | "unit" | "digits" | "base" | "n" | "mo" | "mh" | "ml" | "mc">): PairBars => {
  const n = s.t.length;
  const d = digitsOf(pair);
  const pb: PairBars = { pair, pi, unit: pipOf(pair), digits: d, base: 0, n, ...s, mo: F(n), mh: F(n), ml: F(n), mc: F(n) };
  for (let k = 0; k < n; k++) {
    pb.mo[k] = midOf(s.bo[k], s.ao[k], d);
    pb.mh[k] = midOf(s.bh[k], s.ah[k], d);
    pb.ml[k] = midOf(s.bl[k], s.al[k], d);
    pb.mc[k] = midOf(s.bc[k], s.ac[k], d);
  }
  return pb;
};

export type Side8 = "bo" | "bh" | "bl" | "bc" | "ao" | "ah" | "al" | "ac";
export const SIDE8: readonly Side8[] = ["bo", "bh", "bl", "bc", "ao", "ah", "al", "ac"];

// A copy with only the bars `keep` keeps (indices renumbered from 0; used where only bars after the point
// judged are removed, so the bars up to it keep their S0 indices)
export const keepBars = (pb: PairBars, keep: (k: number) => boolean): PairBars => {
  const idx: number[] = [];
  for (let k = 0; k < pb.n; k++) if (keep(k)) idx.push(k);
  const m = idx.length;
  const pick = (xs: Float64Array) => {
    const out = F(m);
    for (let j = 0; j < m; j++) out[j] = xs[idx[j]];
    return out;
  };
  return {
    pair: pb.pair, pi: pb.pi, unit: pb.unit, digits: pb.digits, base: 0, n: m,
    t: pick(pb.t), mo: pick(pb.mo), mh: pick(pb.mh), ml: pick(pb.ml), mc: pick(pb.mc),
    bo: pick(pb.bo), bh: pick(pb.bh), bl: pick(pb.bl), bc: pick(pb.bc), ao: pick(pb.ao), ah: pick(pb.ah), al: pick(pb.al), ac: pick(pb.ac),
  };
};
// the bars up to index `last` (inclusive): a prefix, the indices unchanged
export const prefixBars = (pb: PairBars, last: number): PairBars => {
  const m = Math.max(0, Math.min(pb.n, last + 1));
  const s = (xs: Float64Array) => xs.slice(0, m);
  return {
    pair: pb.pair, pi: pb.pi, unit: pb.unit, digits: pb.digits, base: 0, n: m,
    t: s(pb.t), mo: s(pb.mo), mh: s(pb.mh), ml: s(pb.ml), mc: s(pb.mc),
    bo: s(pb.bo), bh: s(pb.bh), bl: s(pb.bl), bc: s(pb.bc), ao: s(pb.ao), ah: s(pb.ah), al: s(pb.al), ac: s(pb.ac),
  };
};
// A copy whose bid and ask are edited (the poison), the mids re-derived as the chart derives them
export const withSides = (pb: PairBars, edit: (q: Record<Side8, Float64Array>) => void): PairBars => {
  const q = Object.fromEntries(SIDE8.map((k) => [k, pb[k].slice()])) as Record<Side8, Float64Array>;
  edit(q);
  return pairBarsFromSides(pb.pair, pb.pi, { t: pb.t.slice(), ...q });
};
// a window of bars [from, to] (inclusive), as subarrays: element k is the bar from + k
export const viewOf = (pb: BarsView, from: number, to: number): BarsView => {
  const a = Math.max(0, from - pb.base);
  const b = Math.min(pb.n, to - pb.base + 1);
  return {
    pair: pb.pair, pi: pb.pi, unit: pb.unit, digits: pb.digits, base: pb.base + a, n: Math.max(0, b - a),
    t: pb.t.subarray(a, b), mo: pb.mo.subarray(a, b), mh: pb.mh.subarray(a, b), ml: pb.ml.subarray(a, b), mc: pb.mc.subarray(a, b),
  };
};

// 2: ATR14 of the mids (pineAtr's: TR[0] = high − low; the first 14 averaged; then Wilder), NaN before 13;
// in price units, or in points (the TRs of points)
export const atr14 = (v: BarsView, unit: "price" | "points"): Float64Array => {
  const f = unit === "points" ? (x: number) => pointsOf(x, v.pair) : (x: number) => x;
  const out = new Float64Array(v.n).fill(Number.NaN);
  let prev = Number.NaN;
  let sum = 0;
  for (let k = 0; k < v.n; k++) {
    const h = f(v.mh[k]);
    const l = f(v.ml[k]);
    const tr = k === 0 ? h - l : Math.max(h - l, Math.abs(h - f(v.mc[k - 1])), Math.abs(l - f(v.mc[k - 1])));
    if (k < 13) {
      sum += tr;
      continue;
    }
    if (k === 13) {
      sum += tr;
      prev = sum / 14;
    } else prev = (tr + 13 * prev) / 14;
    out[k] = prev;
  }
  return out;
};
// the same through _shared/pine.ts (the rule names pineAtr): the check of atr14
export const atr14Pine = (v: BarsView): Array<number | null> =>
  pineAtr(Array.from({ length: v.n }, (_, k) => ({ high: v.mh[k], low: v.ml[k], close: v.mc[k] })), 14);

// the first index at or after x (xs ascending)
export const lowerBound = (xs: ArrayLike<number>, x: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
};
// the index of the bar opening exactly at t, or −1
export const indexAt = (xs: ArrayLike<number>, t: number): number => {
  const k = lowerBound(xs, t);
  return k < xs.length && xs[k] === t ? k : -1;
};
