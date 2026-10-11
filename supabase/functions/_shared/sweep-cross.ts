// #291 (docs §8.112): the owner's video's way — liquidity taken below the last
// low (or above the last high), then the EMA cross — as pure functions over a
// chart's closed bars, so the moving-average chart (src/lib/sweepCross.ts
// re-exports this file) and the gold 1-minute email
// (signal-alerts/indicators.ts) decide with the same code.
//
// The owner (2026-10-11), with a screen recording of an Instagram video (a
// gold trader's "three things to look for": the low taken, the break of
// structure, the EMA cross; one buy, no sound, sixteen captions): 「下の移動
// 平均線チャートをこの動画のやり方で合図を出し、1分足のゴールド専用のゴールドの
// 売買のメールだけはこれで判断してメールを送る様にしてください。EMAクロスもセット
// で」「EMAの値は前私が設定した値のものをしようしてください」. Asked before
// anything was built: the cross of EMA 20 and EMA 80 (the first two of the
// three lines saved with the owner's account, EMA 20, 80 and 320); the break
// of structure not waited for (the video's buy came on the cross, before the
// break); "15 to 20 pips" on gold as $1.50 and $2.00 (a pip of $0.10).
//
// THE RULE (docs §8.112 合図の決まり 1-10), at a closed bar c, judged on the
// window of closed bars ending at c (WINDOW of them for the email):
//   lines   EMA 20 and EMA 80 of the closes (Pine's ta.ema, _shared/pine.ts,
//           the chart's own lines' function), from the window's first bar
//   cross   UP at k: fast[k-1] <= slow[k-1] and fast[k] > slow[k]; DOWN at k:
//           fast[k-1] >= slow[k-1] and fast[k] < slow[k]. Only crosses at
//           window index WARM or later count (EMA 80's start has faded)
//   BUY     an UP cross at c; d the latest DOWN cross before c and d' the one
//           before d (both counted); L the lowest low of d' .. d-1 (the last
//           wave's trough); the lows of d .. c went below L ("low taken")
//   SELL    mirrored: a DOWN cross at c; u, u' the two UP crosses before it;
//           H the highest high of u' .. u-1; the highs of u .. c went above H
//   entry   c's close; stop one pip beyond the lowest low (BUY) or highest
//           high (SELL) of the last SL_BARS bars, c's among them; targets 15
//           and 20 pips (a pip: $0.10 on gold, 0.01 on a yen pair, 0.0001 on
//           another)
// The break of structure is not a condition (the owner's choice). The
// window, WARM, SL_BARS and the pip beyond are this app's (the video gives no
// numbers but "15 to 20 pips").
//
// Everything here is Deno-free: src/test/sweep-cross.test.ts imports it.

import { ema } from "./pine.ts";

export const SWEEPX = {
  fast: 20,
  slow: 80,
  // the closed bars a decision is judged on (the email's), and the first
  // index of them a cross counts from: three times EMA 80's length
  window: 600,
  warm: 240,
  // the stop: one pip beyond the extreme of the last five bars
  slBars: 5,
  slPips: 1,
  tp1Pips: 15,
  tp2Pips: 20,
} as const;

// the shortest window the chart judges on, where it holds fewer bars before
// a bar than the email's window (the oldest of the bars it shows): the
// crosses before WARM do not count, so a few hundred bars past it
export const SWEEPX_MIN_WINDOW = SWEEPX.warm + 60;

export interface SweepBar {
  high: number;
  low: number;
  close: number;
}

export type SweepSide = "BUY" | "SELL";

export interface SweepDecision {
  side: SweepSide;
  // indices into the window judged (0 = its first bar; the bar judged is the last)
  at: number;
  entry: number;
  sl: number;
  tps: [number, number];
  // the last wave's trough (BUY) or crest (SELL) that was taken, and its bar
  level: number;
  levelAt: number;
  // how far the leg went past it: its lowest low (BUY) or highest high (SELL), and that bar
  extreme: number;
  extremeAt: number;
  // the two crosses before the bar's: the one the leg started at (d or u) and the one before it
  legFrom: number;
  waveFrom: number;
  // the lines at the bar
  fast: number;
  slow: number;
}

// A pip as this rule counts it: $0.10 on gold (the owner, 2026-10-11), 0.01
// on a yen pair, 0.0001 on any other
export const sweepPip = (pair: string): number => {
  const p = pair.toUpperCase();
  if (p.startsWith("XAU")) return 0.1;
  return p.includes("JPY") ? 0.01 : 0.0001;
};

// +1 an UP cross at k, -1 a DOWN cross, 0 none (or a line not yet defined)
const crossAt = (fast: ReadonlyArray<number | null>, slow: ReadonlyArray<number | null>, k: number): 1 | -1 | 0 => {
  if (k < 1) return 0;
  const f0 = fast[k - 1];
  const s0 = slow[k - 1];
  const f1 = fast[k];
  const s1 = slow[k];
  if (f0 === null || s0 === null || f1 === null || s1 === null) return 0;
  if (f0 <= s0 && f1 > s1) return 1;
  if (f0 >= s0 && f1 < s1) return -1;
  return 0;
};

// The decision at the last bar of `w` (the window ending at the bar judged,
// oldest first): null when the bar is no cross, the crosses before it are too
// few, or nothing was taken
export const sweepCrossOnWindow = (w: ReadonlyArray<SweepBar>, pip: number, o = SWEEPX): SweepDecision | null => {
  const n = w.length;
  const c = n - 1;
  if (c < o.warm + 1) return null;
  const closes = w.map((b) => b.close);
  const fast = ema(closes, o.fast);
  const slow = ema(closes, o.slow);
  const dir = crossAt(fast, slow, c);
  if (dir === 0) return null;
  // the two counted crosses the other way before c
  const before: number[] = [];
  for (let k = c - 1; k >= o.warm && before.length < 2; k--) {
    if (crossAt(fast, slow, k) === -dir) before.push(k);
  }
  if (before.length < 2) return null;
  const [legFrom, waveFrom] = before;
  const buy = dir === 1;
  // the last wave's trough (crest): the first bar it was reached on
  let level = buy ? Infinity : -Infinity;
  let levelAt = -1;
  for (let k = waveFrom; k < legFrom; k++) {
    const v = buy ? w[k].low : w[k].high;
    if (buy ? v < level : v > level) {
      level = v;
      levelAt = k;
    }
  }
  // the leg's lowest low (highest high), d .. c
  let extreme = buy ? Infinity : -Infinity;
  let extremeAt = -1;
  for (let k = legFrom; k <= c; k++) {
    const v = buy ? w[k].low : w[k].high;
    if (buy ? v < extreme : v > extreme) {
      extreme = v;
      extremeAt = k;
    }
  }
  if (levelAt < 0 || extremeAt < 0) return null;
  if (buy ? !(extreme < level) : !(extreme > level)) return null;
  const entry = w[c].close;
  let edge = buy ? Infinity : -Infinity;
  for (let k = Math.max(0, c - o.slBars + 1); k <= c; k++) {
    edge = buy ? Math.min(edge, w[k].low) : Math.max(edge, w[k].high);
  }
  const sign = buy ? 1 : -1;
  const sl = edge - sign * o.slPips * pip;
  const tps: [number, number] = [entry + sign * o.tp1Pips * pip, entry + sign * o.tp2Pips * pip];
  return {
    side: buy ? "BUY" : "SELL",
    at: c,
    entry,
    sl,
    tps,
    level,
    levelAt,
    extreme,
    extremeAt,
    legFrom,
    waveFrom,
    fast: fast[c] as number,
    slow: slow[c] as number,
  };
};

// The email's decision: the newest of `closed` (the chart's closed bars,
// oldest first) on the WINDOW closed bars ending at it, and on nothing else.
// Null on a shorter history
export const sweepCrossNewest = (closed: ReadonlyArray<SweepBar>, pip: number, o = SWEEPX): SweepDecision | null => {
  if (closed.length < o.window) return null;
  return sweepCrossOnWindow(closed.slice(closed.length - o.window), pip, o);
};

// The chart's: every bar from `from` on, each judged on the WINDOW bars
// ending at it — or, where the chart holds fewer before it, on all it holds
// (at least SWEEPX_MIN_WINDOW). A bar judged on a full window is decided as
// the email decides it. The decisions' indices are the bars' own in `bars`
export interface SweepMark extends SweepDecision {
  // whether it was judged on a full window (as the email is)
  full: boolean;
}
export const sweepCrossMarks = (bars: ReadonlyArray<SweepBar>, pip: number, from = 0, o = SWEEPX): SweepMark[] => {
  const out: SweepMark[] = [];
  for (let i = Math.max(from, SWEEPX_MIN_WINDOW - 1); i < bars.length; i++) {
    const start = Math.max(0, i - o.window + 1);
    const d = sweepCrossOnWindow(bars.slice(start, i + 1), pip, o);
    if (!d) continue;
    out.push({
      ...d,
      at: d.at + start,
      levelAt: d.levelAt + start,
      extremeAt: d.extremeAt + start,
      legFrom: d.legFrom + start,
      waveFrom: d.waveFrom + start,
      full: i - start + 1 === o.window,
    });
  }
  return out;
};
