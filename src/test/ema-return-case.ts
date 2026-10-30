// #387: the hand example the rule's tests (ema-return.test.ts) and the chart's
// (ema-return-chart.test.tsx) walk through: a buy shaped as the video's, bar
// by bar, and its mirror (a sell)
import { EMA_RETURN, type ErBar } from "@/lib/emaReturn";
import type { NumericCandle } from "@/lib/types";
import { ema } from "../../supabase/functions/_shared/pine";

const WICK = 0.05;
const fromCloses = (cs: number[], first: number): ErBar[] =>
  cs.map((c, i) => {
    const o = i === 0 ? first : cs[i - 1];
    return { o, c, h: Math.max(o, c) + WICK, l: Math.min(o, c) - WICK };
  });

// 200 bars down from 120 to 100, `flat` bars (300) flat at 100, then up 0.3 a bar: the 20 EMA crosses over
// the 200 EMA at X (found from the lines, at or after WARM). Five bars more up to P (its high
// P + 0.3: A), then, the bars after (closes relative to P):
//   T    the touch: a lower wick 0.2 under the 200 EMA
//   T+4  B: its high P - 0.02 (the horizontal), the highest swing high under A
//   T+9  closes over the diagonal (Dk), still under the horizontal
//   K    T+10, closes over both: the break
//   K+1, K+2  lows at the horizontal: the 1st and 2nd bars, not counted
//   K+3  low at the horizontal: the return move R (its body's top P + 0.01)
//   K+4  closes at P + 0.06, over R's body: the entry
export const TAIL = [-0.1, -0.4, -0.7, -0.5, -0.3, -0.6, -0.8, -0.9, -0.7, -0.3, 0.05, 0.02, 0.0, 0.01, 0.06];

export const buyCase = (tail: number[] = TAIL, flat = 300) => {
  const pre: number[] = [];
  for (let i = 0; i < 200; i++) pre.push(120 - (20 * (i + 1)) / 200);
  for (let i = 200; i < 200 + flat; i++) pre.push(100);
  for (let i = 200 + flat; i < 270 + flat; i++) pre.push(100 + 0.3 * (i - 199 - flat));
  const f = ema(pre, 20);
  const s = ema(pre, 200);
  let x = -1;
  for (let k = EMA_RETURN.warm; k < pre.length && x < 0; k++) {
    if ((f[k - 1] as number) <= (s[k - 1] as number) && (f[k] as number) > (s[k] as number)) x = k;
  }
  const p = pre[x + 5];
  const cs = [...pre.slice(0, x + 6), ...tail.map((d) => p + d)];
  const bars = fromCloses(cs, 120);
  const t = x + 6;
  const slowT = ema(cs, 200)[t] as number;
  bars[x + 5].h = p + 0.3;
  bars[t].h = p + 0.02;
  bars[t].l = slowT - 0.2;
  bars[t + 4].h = p - 0.02;
  return { bars, x, p, t, b: t + 4, k: t + 10, slowT };
};

// prices turned upside down around 200: a sell
export const mirror = (bars: ErBar[]): ErBar[] => bars.map((b) => ({ o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c }));


// as the chart's candles: 15-minute bars from 2026-10-01 00:00 UTC
const T0 = Date.parse("2026-10-01T00:00:00Z");
export const toCandles = (bars: ErBar[]): NumericCandle[] =>
  bars.map((b, i) => ({ datetime: new Date(T0 + i * 15 * 60_000).toISOString().slice(0, 19).replace("T", " "), open: b.o, high: b.h, low: b.l, close: b.c }));

// a seeded walk (mulberry32): 15-minute yen-pair-like bars
export const walk = (n: number, seed: number, start = 150): ErBar[] => {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const out: ErBar[] = [];
  let p = start;
  for (let k = 0; k < n; k++) {
    const o = p;
    p = Math.round((p + (rnd() - 0.5) * 0.16) * 1000) / 1000;
    const hi = Math.round((Math.max(o, p) + rnd() * 0.05) * 1000) / 1000;
    const lo = Math.round((Math.min(o, p) - rnd() * 0.05) * 1000) / 1000;
    out.push({ o, h: hi, l: lo, c: p });
  }
  return out;
};
