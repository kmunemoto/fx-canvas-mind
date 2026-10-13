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
// the highest (lowest) the blue line reached over the newest 120 bars (what
// the chart shows when it is opened), not the outer tenth of the pane from
// its bottom to its top; the email goes as soon as a closed bar gets there
// (no cross with the orange line waited for), one to a peak or valley, the
// next not before the line has gone back inside the 90% mark; and it takes
// the cross email's place (the five pairs and gold, 1 hour). The cross rule
// below stays (decideScaledOnWindow): the morning check's SQL v3
// (scripts/morning-check) mirrors it.
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
//   m       the MACD line (EMA 12 - EMA 26) of those 600 closes (macd(), the
//           chart's arithmetic), unrounded
//   top     H(i), the highest m over the ZONE_BARS (120) bars ending at i, i
//           among them (i-119 to i); bottom L(i), the lowest
//   bands   in the top band:    H(i) > 0 and m[i] >= ZONE_SHARE * H(i)
//           in the bottom band: L(i) < 0 and m[i] <= ZONE_SHARE * L(i)
//           (equality is in; the product held against as it comes, unrounded)
//   SELL    in the top band at i and not at i-1
//   BUY     in the bottom band at i and not at i-1
// i-1 is read from the same m (the 600 bars ending at i), on the 120 bars
// ending at it (i-120 to i-1). So a bar that is the highest of its 120 is in
// the band; staying in it mails nothing more; going out and in again mails
// again (no gap is kept between, the owner's 「90%より内側に戻るまで」 as it
// stands). With no m of the 120 above zero there is no top band (no SELL;
// the bottom likewise), and a top just above zero puts the band just above
// zero. An old top leaving the 120 lowers it: the line can come into the band
// without moving. The band is the blue line's alone: the chart's MACD pane
// (PriceChart.tsx) takes its edges from the signal line and the histogram as
// well, and adds a margin, so on the screen the line is nearly always short
// of 90% of the pane's edge when it fires (docs §8.119: at 144 of the 147
// entries on the stored bars); just past zero after a long stretch on the
// other side, the histogram stands far above it.

import { macd } from "./macd.ts";
import { sidesOf } from "./macd-extreme.ts";

export const LEVEL_WINDOW = 600;
// #353: the newest bars the band is taken on (the chart draws CHART_BARS,
// live-chart/logic.ts, 120: what it shows when opened), and how far from the
// zero line toward their top or bottom the band starts, in percent (a whole
// number: the rule id says it) and as the share held against (90 / 100, the
// double 0.9 is)
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

// #353: where the MACD line stands at index k of `ms` (a window's MACD line)
// against the ZONE_BARS values of it ending at k, k among them, price units
export interface ZoneRead {
  m: number;
  // the highest and lowest of those, and ZONE_SHARE times each: where the
  // top and bottom bands start
  top: number;
  bottom: number;
  topMark: number;
  bottomMark: number;
  inTop: boolean;
  inBottom: boolean;
}
// Null when there are fewer than ZONE_BARS values up to k, or one of them is
// no number (a MACD line with a gap)
export const zoneAt = (ms: ReadonlyArray<number | null>, k: number): ZoneRead | null => {
  if (k + 1 < ZONE_BARS || k >= ms.length) return null;
  let top = -Infinity;
  let bottom = Infinity;
  for (let j = k - ZONE_BARS + 1; j <= k; j++) {
    const v = ms[j];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    if (v > top) top = v;
    if (v < bottom) bottom = v;
  }
  const m = ms[k] as number;
  const topMark = ZONE_SHARE * top;
  const bottomMark = ZONE_SHARE * bottom;
  return { m, top, bottom, topMark, bottomMark, inTop: top > 0 && m >= topMark, inBottom: bottom < 0 && m <= bottomMark };
};

// #353: what made the zone rule fire: the side, the MACD line at the bar,
// the highest and lowest of the ZONE_BARS ending at it, and the mark the
// side's band starts at (ZONE_SHARE times the top for a SELL, the bottom for
// a BUY), price units. Only an entry is a decision, so `fire` is always true.
export interface ZoneDecision {
  side: "BUY" | "SELL";
  m: number;
  top: number;
  bottom: number;
  mark: number;
  fire: true;
}
// #353: the entry at index k of a MACD line: into the top band (a SELL) or
// the bottom band (a BUY) at k, out of it at k-1 (on the ZONE_BARS ending at
// k-1). The two cannot both be: the top band is above zero, the bottom below.
// Null when there is no entry, or fewer than ZONE_BARS + 1 values up to k, or
// one of them is no number.
export const zoneEntryAt = (ms: ReadonlyArray<number | null>, k: number): ZoneDecision | null => {
  const now = zoneAt(ms, k);
  const before = zoneAt(ms, k - 1);
  if (now === null || before === null) return null;
  if (now.inTop && !before.inTop) return { side: "SELL", m: now.m, top: now.top, bottom: now.bottom, mark: now.topMark, fire: true };
  if (now.inBottom && !before.inBottom) return { side: "BUY", m: now.m, top: now.top, bottom: now.bottom, mark: now.bottomMark, fire: true };
  return null;
};

// #353 (docs §8.119): the decision at bar i of `bars` (at least LEVEL_WINDOW
// of them ending at i), from those LEVEL_WINDOW bars alone: the MACD line of
// their closes, and the entry at their newest. Null when there are fewer, or
// a bar past the end, or no entry at i.
export const decideZoneOnWindow = (bars: ReadonlyArray<{ close: number }>, i: number): ZoneDecision | null => {
  if (i + 1 < LEVEL_WINDOW || i >= bars.length) return null;
  const ms = macd(bars.slice(i - LEVEL_WINDOW + 1, i + 1).map((b) => b.close)).macd;
  return zoneEntryAt(ms, LEVEL_WINDOW - 1);
};
