// #324 (docs §8.114): the MACD email's rule from signal-alerts v25, the
// owner's own numbers. Asked on the 1-hour USD/JPY chart which crosses to
// mail (2026-10-12), the owner answered 「上は0.085以上、下は−0.085以下のクロス
// でメールを出して」, and to mail it in place of the 5-minute rule (§8.109,
// _shared/macd-extreme.ts, which stays as it is: the studies decide through
// it).
// #339 (docs §8.116): from v26 the level is each pair's own. Looking at
// AUD/USD's 1-hour chart the owner asked 「通貨のペアによりますよね？大体紫丸
// ぐらいの高さ、低さでクロスした時にメールください。どのペアも」, and chose
// 0.8 times the pair's usual hourly move (the mean size of the move from one
// close to the next, up or down, over the same 600 bars), on the same five
// pairs: it takes in both crosses circled on AUD/USD (some 1.2 and 0.9 times
// it); on USD/JPY it is a little above the 0.085 chosen there (some 0.75
// times it when it was chosen, 2026-10-12).
// #345 (docs §8.118): from v27 gold (XAU/USD) is on it as well, 2026-10-13,
// the owner's 「金も1時間足でmacdのクロスでメールを送るようにして」: the same
// rule, in dollars (gold's bars are Twelve Data's, not GMO's).
// #353 (docs §8.119): from v28 the MACD email is no cross any more. The
// owner, 2026-10-13: 「やっぱりめーるですが、macdの青い線が上か下の90%以上の所
// までいったら売買のメールを送る様にしてください。意味わかりますか？」. Asked
// three things, the owner chose: the 90% is of the way from the zero line to
// the top (bottom) of the newest 120 bars (what the chart shows when it is
// opened), not the outer tenth of the pane from its bottom to its top; the
// email goes as soon as a closed bar gets there (no cross with the orange
// line waited for), one to a peak or valley, the next not before the line
// has gone back inside the 90% mark; and it takes the cross email's place
// (the five pairs and gold, 1 hour). What the top is was asked once more,
// 2026-10-14: made first as the blue line's own highest, that left the line
// short of 90% of the chart's MACD pane edge (the highest of the blue line,
// the orange line and the bars) at 49 of the 146 entries on the stored bars,
// 25 of them under half of it; the owner chose 「2で」, the pane's edge (「1」
// was the blue line's own highest). The cross rule below stays
// (decideScaledOnWindow): the morning check's SQL v3 (scripts/morning-check)
// mirrors it.
//
// THE RULE (v25 to v27): at a closed 1-hour bar i, judged on the 600 closed
// bars ending at i (the chart's history; MACD from those bars alone, as
// decideOnWindow does),
//   cross   the sides of h = MACD - signal as _shared/macd-extreme.ts sidesOf
//           takes them (h == 0 keeps the side before); a cross when the sides
//           at i-1 and i are both defined and differ: UP to +1, DOWN to -1
//   SELL    a DOWN cross with MACD[i] >= level
//   BUY     an UP cross with MACD[i] <= -level
// level is in price units, unrounded MACD against it (equality fires): a
// number given (decideLevelOnWindow, v25), or from v26 k times the window's
// mean |close[j] - close[j-1]| over its 599 steps (decideScaledOnWindow).
//
// THE ZONE RULE (v28 on; decideZoneOnWindow): at a closed 1-hour bar i, on
// the same 600 closed bars ending at i,
//   m s h   the MACD line (EMA 12 - EMA 26: the blue line), its signal line
//           (EMA 9 of m: the orange line) and the histogram (m - s: the
//           bars) of those 600 closes (macd(), the chart's arithmetic),
//           unrounded
//   top     T(i), the highest of m, s and h over the ZONE_BARS (120) bars
//           ending at i, i among them (i-119 to i: 360 values), and 0;
//           bottom B(i), the lowest of them and 0: the edges of the chart's
//           MACD pane (PriceChart.tsx) without the margin it draws them with
//   bands   in the top band:    T(i) > 0 and m[i] >= ZONE_SHARE * T(i)
//           in the bottom band: B(i) < 0 and m[i] <= ZONE_SHARE * B(i)
//           (equality is in; the product held against as it comes,
//           unrounded; only the blue line comes into a band, the orange
//           line and the bars only set the edges)
//   SELL    in the top band at i and not at i-1
//   BUY     in the bottom band at i and not at i-1
// i-1 is read from the same m, s and h (the 600 bars ending at i), on the
// 120 bars ending at it (i-120 to i-1). Where the blue line sets the edge (as
// it does while a rise or a fall goes on) a bar where it is the highest of
// the 120 is the edge itself, in the band; where the orange line or the bars
// set it, the line is in only at 90% of theirs: just past zero after a long
// stretch below it the orange line is still below zero, the bars (m - s)
// stand above the line, and there is no SELL (nor a BUY just below zero
// after a long stretch above it). Staying in a band mails nothing more;
// going out and in again mails again (no gap is kept between, the owner's
// 「90%より内側に戻るまで」 as it stands). With none of the 360 values above
// zero there is no top band (no SELL; the bottom likewise). An old edge
// leaving the 120 brings it toward zero, as the chart's pane shrinks: the
// line can come into the band without moving. The chart adds 8% to the edges
// as it draws them, takes in the forming bar, and works MACD out from the
// bars it has read, so on the screen the line sits a little under the drawn
// edge when it fires (docs §8.119).

import { macd } from "./macd.ts";
import { sidesOf } from "./macd-extreme.ts";

export const LEVEL_WINDOW = 600;
// #353: the newest bars the band is taken on (the chart draws CHART_BARS,
// live-chart/logic.ts, 120: what it shows when opened), and how far from the
// zero line toward the top or bottom of their MACD pane the band starts, in
// percent (a whole number: the rule id says it) and as the share held
// against (90 / 100, the double 0.9 is)
export const ZONE_BARS = 120;
export const ZONE_PCT = 90;
export const ZONE_SHARE = ZONE_PCT / 100;

export interface LevelDecision {
  dir: "UP" | "DOWN";
  side: "BUY" | "SELL";
  // MACD and its signal line at the bar, price units
  m: number;
  signal: number;
  fire: boolean;
}

// The decision on the newest of `closes` (a window's), MACD from them alone.
// Null when there is no cross there.
const decideOnCloses = (closes: number[], level: number): LevelDecision | null => {
  const r = macd(closes);
  const sides = sidesOf(r.hist);
  const k = closes.length - 1;
  const a = sides[k - 1];
  const b = sides[k];
  if (a === null || b === null || a === b) return null;
  const m = r.macd[k];
  const signal = r.signal[k];
  if (m === null || signal === null) return null;
  const dir = b === 1 ? "UP" : "DOWN";
  return { dir, side: dir === "DOWN" ? "SELL" : "BUY", m, signal, fire: dir === "DOWN" ? m >= level : m <= -level };
};

// The decision at bar i of `bars` (at least LEVEL_WINDOW of them ending at
// i), from those LEVEL_WINDOW bars alone, against a level given. Null when
// there are fewer, or no cross at i.
export const decideLevelOnWindow = (bars: ReadonlyArray<{ close: number }>, i: number, level: number): LevelDecision | null => {
  if (i + 1 < LEVEL_WINDOW || i >= bars.length) return null;
  return decideOnCloses(bars.slice(i - LEVEL_WINDOW + 1, i + 1).map((b) => b.close), level);
};

// #339: the pair's usual hourly move on a window: the mean |close[j] -
// close[j-1]| over its steps (599 on LEVEL_WINDOW closes), price units
export const meanMoveOf = (closes: ReadonlyArray<number>): number => {
  let s = 0;
  for (let j = 1; j < closes.length; j++) s += Math.abs(closes[j] - closes[j - 1]);
  return s / (closes.length - 1);
};

export interface ScaledDecision extends LevelDecision {
  // the window's usual move and the level held against: k times it, price units
  scale: number;
  level: number;
}
// #339: the decision at bar i as decideLevelOnWindow's, against k times the
// same window's usual move
export const decideScaledOnWindow = (bars: ReadonlyArray<{ close: number }>, i: number, k: number): ScaledDecision | null => {
  if (i + 1 < LEVEL_WINDOW || i >= bars.length) return null;
  const closes = bars.slice(i - LEVEL_WINDOW + 1, i + 1).map((b) => b.close);
  const scale = meanMoveOf(closes);
  const level = k * scale;
  const d = decideOnCloses(closes, level);
  return d ? { ...d, scale, level } : null;
};

// #353: a window's MACD as the zone rule reads it (macd()'s: the MACD line,
// its signal line and the histogram, index for index)
export interface ZoneLines {
  macd: ReadonlyArray<number | null>;
  signal: ReadonlyArray<number | null>;
  hist: ReadonlyArray<number | null>;
}

// #353: where the MACD line stands at index k of `r` (a window's MACD)
// against the MACD pane of the ZONE_BARS bars ending at k, k among them,
// price units
export interface ZoneRead {
  m: number;
  // the pane's edges: the highest and lowest of the MACD line, the signal
  // line and the histogram over those bars, and 0; and ZONE_SHARE times
  // each: where the top and bottom bands start
  top: number;
  bottom: number;
  topMark: number;
  bottomMark: number;
  inTop: boolean;
  inBottom: boolean;
}
// Null when there are fewer than ZONE_BARS bars up to k, or one of the three
// at one of them is no number (a MACD with a gap)
export const zoneAt = (r: ZoneLines, k: number): ZoneRead | null => {
  if (k + 1 < ZONE_BARS || k >= r.macd.length) return null;
  let top = 0;
  let bottom = 0;
  for (const xs of [r.macd, r.signal, r.hist]) {
    for (let j = k - ZONE_BARS + 1; j <= k; j++) {
      const v = xs[j];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      if (v > top) top = v;
      if (v < bottom) bottom = v;
    }
  }
  const m = r.macd[k] as number;
  const topMark = ZONE_SHARE * top;
  const bottomMark = ZONE_SHARE * bottom;
  return { m, top, bottom, topMark, bottomMark, inTop: top > 0 && m >= topMark, inBottom: bottom < 0 && m <= bottomMark };
};

// #353: what made the zone rule fire: the side, the MACD line at the bar,
// the MACD pane's top and bottom over the ZONE_BARS ending at it (the
// highest and lowest of the MACD line, the signal line and the histogram
// there, and 0), and the mark the side's band starts at (ZONE_SHARE times
// the top for a SELL, the bottom for a BUY), price units. Only an entry is a
// decision, so `fire` is always true.
export interface ZoneDecision {
  side: "BUY" | "SELL";
  m: number;
  top: number;
  bottom: number;
  mark: number;
  fire: true;
}
// #353: the entry at index k of a window's MACD: the MACD line into the top
// band (a SELL) or the bottom band (a BUY) at k, out of it at k-1 (on the
// pane of the ZONE_BARS ending at k-1). The two cannot both be: the top band
// is above zero, the bottom below. Null when there is no entry, or fewer
// than ZONE_BARS + 1 bars up to k, or one of the three at one of them is no
// number.
export const zoneEntryAt = (r: ZoneLines, k: number): ZoneDecision | null => {
  const now = zoneAt(r, k);
  const before = zoneAt(r, k - 1);
  if (now === null || before === null) return null;
  if (now.inTop && !before.inTop) return { side: "SELL", m: now.m, top: now.top, bottom: now.bottom, mark: now.topMark, fire: true };
  if (now.inBottom && !before.inBottom) return { side: "BUY", m: now.m, top: now.top, bottom: now.bottom, mark: now.bottomMark, fire: true };
  return null;
};

// #353 (docs §8.119): the decision at bar i of `bars` (at least LEVEL_WINDOW
// of them ending at i), from those LEVEL_WINDOW bars alone: the MACD of
// their closes (the line, the signal line and the histogram), and the entry
// at their newest. Null when there are fewer, or a bar past the end, or no
// entry at i.
export const decideZoneOnWindow = (bars: ReadonlyArray<{ close: number }>, i: number): ZoneDecision | null => {
  if (i + 1 < LEVEL_WINDOW || i >= bars.length) return null;
  return zoneEntryAt(macd(bars.slice(i - LEVEL_WINDOW + 1, i + 1).map((b) => b.close)), LEVEL_WINDOW - 1);
};
