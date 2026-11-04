// #393: the owner's ③ — "the places the price stopped again and again" — as a
// horizontal band on every chart. The owner (2026-11-04), after a trend-line
// lesson on an AUD/USD 1-hour chart that marked the band 0.7014-0.7018 where
// the lows had stopped four times: 「全てのチャートに③を表示されて」.
//
// Read mechanically from the closed bars on screen (the window the owner looks
// at, as a person draws on it; as ① ② ④ in trendGuide.ts):
//   * the swing highs and lows of Dow theory, as the trend lines read them
//     (trendTools.ts: a high with no higher high `pivot` bars either side,
//     known `pivot` bars later; ties go to the earlier bar), both kinds
//     together — a level that held the lows may hold the highs later;
//   * their prices in order, joined while the gap to the next one is at most
//     `gap` × ATR(14) of the newest closed bar; a group wider than `maxWidth` ×
//     ATR is cut at its widest gap (again until none is wider);
//   * a group of at least `minTouches` swings is a band, from its lowest to its
//     highest swing; the bands with the most swings first (ties: the newer last
//     swing), up to `maxZones`;
//   * each band drawn from its first swing to the right edge.
// The numbers were set so the owner's ③ on AUD/USD 1-hour (the bars on screen,
// 2026-10-28 13:00 to 11-03 20:00 UTC: lows 0.70137, 0.70147, 0.70171, 0.70178)
// comes out as the one band 0.70137-0.70178; a fixed window of 0.3 or 0.4 × ATR
// and the 300 bars before split it or mixed in swings off the screen.
// Shown on the chart only: no signal, alert or record is judged on it, and
// none of it has been measured on past data.

import { pineAtr } from "../../supabase/functions/_shared/pine";

type Bar = { high: number; low: number; close: number };

export const SR_ZONES = { pivot: 4, atr: 14, gap: 0.25, maxWidth: 0.6, minTouches: 3, maxZones: 4 } as const;
export type SrZonesOptions = { pivot: number; atr: number; gap: number; maxWidth: number; minTouches: number; maxZones: number };

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

// The swings of bars[s..lastClosed] (each known `pivot` bars before lastClosed;
// the bars before s count as neighbours)
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

// cut a price-ordered group at its widest gap until no part is wider than maxW
const cut = (g: SrTouch[], maxW: number): SrTouch[][] => {
  if (g.length < 2 || g[g.length - 1].price - g[0].price <= maxW) return [g];
  let at = 1;
  for (let k = 2; k < g.length; k++) if (g[k].price - g[k - 1].price > g[at].price - g[at - 1].price) at = k;
  return [...cut(g.slice(0, at), maxW), ...cut(g.slice(at), maxW)];
};

// The bands of bars[from..lastClosed], highest price first; [] when the bars are too few for the ATR
export const srZones = (bars: ReadonlyArray<Bar>, from: number, lastClosed: number, o: SrZonesOptions = SR_ZONES): SrZone[] => {
  if (lastClosed < 0 || lastClosed >= bars.length) return [];
  const atr = pineAtr(bars.slice(0, lastClosed + 1), o.atr)[lastClosed];
  if (atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0) return [];
  const sw = srSwings(bars, lastClosed, Math.max(0, from), o.pivot).sort((a, b) => a.price - b.price || a.i - b.i);
  const groups: SrTouch[][] = [];
  for (const t of sw) {
    const g = groups[groups.length - 1];
    if (g && t.price - g[g.length - 1].price <= o.gap * atr) g.push(t);
    else groups.push([t]);
  }
  const bands = groups
    .flatMap((g) => cut(g, o.maxWidth * atr))
    .filter((g) => g.length >= o.minTouches)
    .map((g) => ({ lo: g[0].price, hi: g[g.length - 1].price, touches: [...g].sort((a, b) => a.i - b.i) }))
    .sort((a, b) => b.touches.length - a.touches.length || b.touches[b.touches.length - 1].i - a.touches[a.touches.length - 1].i)
    .slice(0, o.maxZones);
  return bands.sort((a, b) => b.hi - a.hi);
};
