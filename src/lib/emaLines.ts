// #143: the exponential moving averages of 50 and 200 closes on the chart.
// #142 measured which indicator reads the big flow of a chart best (docs
// §8.54): for the flow across the chart's 120 bars, the close above or
// below EMA 50 (first of 31 on both periods); for a flow larger than the
// screen, the 200-bar averages (EMA 200 first on the first period). The
// owner asked for both: 「EMA50 の線（必要なら移動平均200も）をチャートに
// 追加して、両方」.
//
// TradingView's EMA (Pine's ta.ema: the simple average of the first n
// closes, then alpha = 2 / (n + 1)) — the same arithmetic the study read
// (analyze/indicators.ts emaSeries). The live chart computes them over the
// 600 closed bars before its own as well, so the line on its first bar has
// settled.
//
// Shown on the chart only: they read where the flow has been, not where it
// goes (after a reading, the next 48 bars went its way about half the
// time), so no signal, alert or record is judged on them.

import { ema } from "./zoneShift";

export const EMA_LINES = [
  { key: "ema50", length: 50, color: "#FF9800" },
  { key: "ema200", length: 200, color: "#E040FB" },
] as const;

export type EmaKey = (typeof EMA_LINES)[number]["key"];

export const emaLine = (closes: ReadonlyArray<number>, length: number): Array<number | null> => ema(closes, length);
