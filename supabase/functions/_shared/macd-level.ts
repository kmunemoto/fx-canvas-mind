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
//
// THE RULE: at a closed 1-hour bar i, judged on the 600 closed bars ending at
// i (the chart's history; MACD from those bars alone, as decideOnWindow does),
//   cross   the sides of h = MACD - signal as _shared/macd-extreme.ts sidesOf
//           takes them (h == 0 keeps the side before); a cross when the sides
//           at i-1 and i are both defined and differ: UP to +1, DOWN to -1
//   SELL    a DOWN cross with MACD[i] >= level
//   BUY     an UP cross with MACD[i] <= -level
// level is in price units, unrounded MACD against it (equality fires): a
// number given (decideLevelOnWindow, v25), or from v26 k times the window's
// mean |close[j] - close[j-1]| over its 599 steps (decideScaledOnWindow).

import { macd } from "./macd.ts";
import { sidesOf } from "./macd-extreme.ts";

export const LEVEL_WINDOW = 600;

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
