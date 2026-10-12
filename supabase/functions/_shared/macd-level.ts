// #324 (docs §8.114): the MACD email's rule from signal-alerts v25, the
// owner's own numbers. Asked on the 1-hour USD/JPY chart which crosses to
// mail (2026-10-12), the owner answered 「上は0.085以上、下は−0.085以下のクロス
// でメールを出して」, and to mail it in place of the 5-minute rule (§8.109,
// _shared/macd-extreme.ts, which stays as it is: the studies decide through
// it).
//
// THE RULE: at a closed 1-hour bar i, judged on the 600 closed bars ending at
// i (the chart's history; MACD from those bars alone, as decideOnWindow does),
//   cross   the sides of h = MACD - signal as _shared/macd-extreme.ts sidesOf
//           takes them (h == 0 keeps the side before); a cross when the sides
//           at i-1 and i are both defined and differ: UP to +1, DOWN to -1
//   SELL    a DOWN cross with MACD[i] >= level
//   BUY     an UP cross with MACD[i] <= -level
// level is in price units, unrounded MACD against it (equality fires).

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

// The decision at bar i of `bars` (at least LEVEL_WINDOW of them ending at
// i), from those LEVEL_WINDOW bars alone. Null when there are fewer, or no
// cross at i.
export const decideLevelOnWindow = (bars: ReadonlyArray<{ close: number }>, i: number, level: number): LevelDecision | null => {
  if (i + 1 < LEVEL_WINDOW || i >= bars.length) return null;
  const r = macd(bars.slice(i - LEVEL_WINDOW + 1, i + 1).map((b) => b.close));
  const sides = sidesOf(r.hist);
  const k = LEVEL_WINDOW - 1;
  const a = sides[k - 1];
  const b = sides[k];
  if (a === null || b === null || a === b) return null;
  const m = r.macd[k];
  const signal = r.signal[k];
  if (m === null || signal === null) return null;
  const dir = b === 1 ? "UP" : "DOWN";
  return { dir, side: dir === "DOWN" ? "SELL" : "BUY", m, signal, fire: dir === "DOWN" ? m >= level : m <= -level };
};
