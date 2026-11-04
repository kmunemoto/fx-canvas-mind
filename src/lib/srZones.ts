// #393: the owner's ③ — "the places the price stopped again and again" — as a
// horizontal band on every chart. The owner (2026-11-04), after a trend-line
// lesson on an AUD/USD 1-hour chart that marked the band 0.7014-0.7018 where
// the lows had stopped four times: 「全てのチャートに③を表示されて」.
//
// Read mechanically from closed bars:
//   * the swing highs and lows of Dow theory, as the trend lines read them
//     (trendTools.ts: a high with no higher high `pivot` bars either side,
//     known `pivot` bars later; ties go to the earlier bar), both kinds
//     together — a level that held the lows may hold the highs later;
//   * of the newest `lookback` closed bars only;
//   * a band is a price window `width` × ATR(14) of the newest closed bar
//     high; it is kept when at least `minTouches` swings lie in it;
//   * the band with the most swings first (ties: the newer last swing, then
//     the lower price), its swings taken out, and again, up to `maxZones`
//     bands, none overlapping another;
//   * each band drawn from its first swing to the right edge.
// Shown on the chart only: no signal, alert or record is judged on it, and
// none of it has been measured on past data.

import { pineAtr } from "../../supabase/functions/_shared/pine";

type Bar = { high: number; low: number; close: number };

export const SR_ZONES = { pivot: 4, lookback: 300, atr: 14, width: 0.3, minTouches: 3, maxZones: 4 } as const;
export type SrZonesOptions = { pivot: number; lookback: number; atr: number; width: number; minTouches: number; maxZones: number };

export interface SrTouch {
  // the swing's bar and its price (the high of a swing high, the low of a swing low)
  i: number;
  price: number;
  kind: "high" | "low";
}

export interface SrZone {
  lo: number;
  hi: number;
  // oldest first
  touches: SrTouch[];
}

// The swings of `bars[s..lastClosed]` (each known `pivot` bars before lastClosed)
export const srSwings = (bars: ReadonlyArray<Bar>, lastClosed: number, s: number, pivot: number): SrTouch[] => {
  const out: SrTouch[] = [];
  for (let p = Math.max(s, pivot); p + pivot <= lastClosed && p + pivot < bars.length; p++) {
    let isH = true;
    let isL = true;
    for (let k = p - pivot; k <= p + pivot; k++) {
      if (k === p) continue;
      if (k < p ? bars[k].high >= bars[p].high : bars[k].high > bars[p].high) isH = false;
      if (k < p ? bars[k].low <= bars[p].low : bars[k].low < bars[p].low) isL = false;
    }
    if (isH) out.push({ i: p, price: bars[p].high, kind: "high" });
    if (isL) out.push({ i: p, price: bars[p].low, kind: "low" });
  }
  return out;
};

// The bands, highest price first; [] when the bars are too few for the ATR
export const srZones = (bars: ReadonlyArray<Bar>, lastClosed: number, o: SrZonesOptions = SR_ZONES): SrZone[] => {
  if (lastClosed < 0 || lastClosed >= bars.length) return [];
  const atr = pineAtr(bars.slice(0, lastClosed + 1), o.atr)[lastClosed];
  if (atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0) return [];
  const w = o.width * atr;
  const s = Math.max(0, lastClosed - o.lookback + 1);
  let left = srSwings(bars, lastClosed, s, o.pivot).sort((a, b) => a.price - b.price || a.i - b.i);
  const zones: SrZone[] = [];
  const overlaps = (lo: number, hi: number) => zones.some((z) => lo <= z.hi && hi >= z.lo);
  while (zones.length < o.maxZones) {
    let best: { from: number; to: number; count: number; newest: number } | null = null;
    for (let a = 0; a < left.length; a++) {
      let b = a;
      while (b + 1 < left.length && left[b + 1].price - left[a].price <= w) b++;
      const count = b - a + 1;
      if (count < o.minTouches || overlaps(left[a].price, left[b].price)) continue;
      let newest = -1;
      for (let k = a; k <= b; k++) newest = Math.max(newest, left[k].i);
      if (!best || count > best.count || (count === best.count && newest > best.newest)) best = { from: a, to: b, count, newest };
    }
    if (!best) break;
    const picked = left.slice(best.from, best.to + 1);
    zones.push({ lo: picked[0].price, hi: picked[picked.length - 1].price, touches: [...picked].sort((a, b) => a.i - b.i) });
    left = [...left.slice(0, best.from), ...left.slice(best.to + 1)];
  }
  return zones.sort((a, b) => b.hi - a.hi);
};
