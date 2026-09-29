// #150: MACD as TradingView's built-in computes it (12, 26, 9; both averages
// EMAs, Pine's ta.ema). #158: moved here from src/lib/trendTools.ts (which
// re-exports it) unchanged, so the functions can read it as the chart does
// (research/confirm.ts; #158's check was measured and not put in).

import { pineEma, type Series } from "./pine.ts";

export const MACD_DEFAULTS = { fast: 12, slow: 26, signal: 9 };

export interface MacdRead {
  macd: Series;
  signal: Series;
  hist: Series;
}

export const macd = (closes: ReadonlyArray<number>, o = MACD_DEFAULTS): MacdRead => {
  const fast = pineEma(closes, o.fast);
  const slow = pineEma(closes, o.slow);
  const line: Series = closes.map((_, i) => (fast[i] === null || slow[i] === null ? null : (fast[i] as number) - (slow[i] as number)));
  const signal = pineEma(line, o.signal);
  return { macd: line, signal, hist: line.map((v, i) => (v === null || signal[i] === null ? null : v - (signal[i] as number))) };
};
