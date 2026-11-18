// The MACD fade judged at closed 1-hour bars (research/macdfade1h-prod-spec.md sections 2.1-2.2, 3.1 and 3.7; the
// study it must equal: research/macdfade15-spec.md "On 1-hour bars (TF=1h)", research/macdfade15.ts with TF=1h).
// The owner, 2026-11-17: 「もうシンプル96%の足できたら逆張りのメールちょうだい」, then 「メールを1時間足から15分足に変更」,
// then 「やっぱりメールの判断1時間足で」.
//
// THE RULE, at the close of bar n of a chart's closed bars (oldest first, their closes as the chart draws them), with
// at least LEVEL_WINDOW (600) closed bars up to it:
//   w       the 600 closes ending at n; r = macd(w) (macd.ts, 12/26/9, Pine's EMAs)
//   Z(n)    zoneAt(r, 599): the MACD line at the bar's close (m), and the highest (top) and lowest (bottom) of the line,
//           the signal line and the histogram over the ZONE_BARS (120) positions ending there, 0 included; unrounded
//   Zp(n)   zoneAt(r, 598): the bar before, read in bar n's own window. The EMAs are causal, so it is bit for bit
//           zoneAt(macd(the 599 closes before n), 598). It is not Z(n - 1) on bar n - 1's own window (which starts a
//           bar earlier). v8's reading is the same (macd-level.ts zoneEntryAt at 599 and 598 of one window).
//   at s    top: top > 0 && m >= s * top; bottom: bottom < 0 && m <= s * bottom (equality in, the product as it
//           comes: research/macd90.ts atShare)
//   entry   on side S when Z(n) is at FADE_SHARE on S and Zp(n) is not. Both cannot hold (the top needs m > 0, the
//           bottom m < 0). The side is the fade: top SELL, bottom BUY (a share's SELL is a short sale).
// No entry while the line stays at 96%; it enters again only after a close below 96% and a close back at it. None is
// skipped. At 0.95 this is v8's zone rule (macd-level.ts decideZoneOnWindow) exactly.
//
// Pure: no clock, no I/O. One function for the pairs, gold and the shares. Imports macd.ts and macd-level.ts only
// (not macd-ride.ts). The ids' versions (3.7: macdx v11, stockmacd v4) and the charts' intervals are the function's
// (indicators.ts, stocks.ts): fadeRuleId("macdx", MACDH_INTERVALS[0], 11) is
// "macdx_12_26_9_w600_1h_fade96of120_in_v11", fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], 4) is
// "stockmacd_12_26_9_w600_1h_fade96of120_in_v4".

import { macd, MACD_DEFAULTS } from "./macd.ts";
import { LEVEL_WINDOW, ZONE_BARS, zoneAt } from "./macd-level.ts";

// how far from the zero line toward the pane's edge the line closes, in percent (a whole number: the rule id says it)
// and as the share held against (96 / 100, the double 0.96 is)
export const FADE_PCT = 96;
export const FADE_SHARE = FADE_PCT / 100;
// the rule ids' tag: "fade96of120"
export const FADE_TAG = `fade${FADE_PCT}of${ZONE_BARS}`;

export type FadeZoneSide = "top" | "bottom";
export type FadeSide = "BUY" | "SELL";

// the fade: the top a SELL, the bottom a BUY (a share's SELL is a short sale)
export const fadeSideOf = (zside: FadeZoneSide): FadeSide => (zside === "top" ? "SELL" : "BUY");

// `${prefix}_${fast}_${slow}_${signal}_w${LEVEL_WINDOW}_${interval}_${FADE_TAG}_in_v${version}`, every part from a
// constant (section 3.7)
export const fadeRuleId = (prefix: string, interval: string, version: number): string =>
  `${prefix}_${MACD_DEFAULTS.fast}_${MACD_DEFAULTS.slow}_${MACD_DEFAULTS.signal}_w${LEVEL_WINDOW}_${interval}_${FADE_TAG}_in_v${version}`;

// where the line stands at a close: the MACD line and the pane's top and bottom, price units, unrounded
export interface FadeZone {
  m: number;
  top: number;
  bottom: number;
}

export interface FadeEntry {
  // the pane's side the line closed at, and the fade side of it
  zside: FadeZoneSide;
  side: FadeSide;
  // Z(n) and Zp(n)
  z: FadeZone;
  zp: FadeZone;
  // m / top (top side) or m / bottom (bottom side) at Z(n)
  share0: number;
}

const zoneOf = (r: ReturnType<typeof zoneAt>): FadeZone | null => (r === null ? null : { m: r.m, top: r.top, bottom: r.bottom });

// at share s on a side, equality in, the product as it comes (research/macd90.ts atShare)
const atShare = (z: FadeZone, zside: FadeZoneSide, s: number): boolean =>
  zside === "top" ? z.top > 0 && z.m >= s * z.top : z.bottom < 0 && z.m <= s * z.bottom;

// Z(n) and Zp(n) on the newest LEVEL_WINDOW of `closes`: null on fewer, a close (of those) that is not a finite
// number, or a MACD with a gap (zoneAt null). Older closes are not read.
export const closeZonesAt = (closes: ReadonlyArray<number>): { z: FadeZone; zp: FadeZone } | null => {
  if (closes.length < LEVEL_WINDOW) return null;
  const w = closes.slice(closes.length - LEVEL_WINDOW);
  for (const c of w) if (typeof c !== "number" || !Number.isFinite(c)) return null;
  const r = macd(w);
  const z = zoneOf(zoneAt(r, LEVEL_WINDOW - 1));
  const zp = zoneOf(zoneAt(r, LEVEL_WINDOW - 2));
  return z === null || zp === null ? null : { z, zp };
};

// The entry at the newest of `closes` (a chart's closed bars, oldest first) at share s (above 0, at most 1): the side
// whose share Z(n) is at and Zp(n) is not, with Z, Zp and share0; null when there is none, or closeZonesAt is null
export const closeEntryAt = (closes: ReadonlyArray<number>, s: number): FadeEntry | null => {
  if (!(s > 0 && s <= 1)) throw new RangeError(`closeEntryAt: share ${s}: above 0 and at most 1`);
  const zs = closeZonesAt(closes);
  if (zs === null) return null;
  const { z, zp } = zs;
  const sides = (["top", "bottom"] as FadeZoneSide[]).filter((x) => atShare(z, x, s) && !atShare(zp, x, s));
  if (sides.length === 0) return null;
  // not reachable with s > 0 (the top side needs m > 0, the bottom m < 0); the study stops on it the same way
  if (sides.length > 1) throw new Error("closeEntryAt: the line at the share on both sides");
  const zside = sides[0];
  return { zside, side: fadeSideOf(zside), z, zp, share0: zside === "top" ? z.m / z.top : z.m / z.bottom };
};

// the email's rule: at FADE_SHARE
export const fadeCloseEntryAt = (closes: ReadonlyArray<number>): FadeEntry | null => closeEntryAt(closes, FADE_SHARE);
