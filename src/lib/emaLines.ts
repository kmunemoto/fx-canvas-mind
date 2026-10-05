// #143: the moving averages on the chart. #142 measured which indicator
// reads the big flow of a chart best (docs §8.54): for the flow across the
// chart's 120 bars, the close above or below EMA 50 (first of 31 on both
// periods); for a flow larger than the screen, the 200-bar averages (EMA 200
// first on the first period). The owner asked for both: 「EMA50 の線（必要なら
// 移動平均200も）をチャートに追加して、両方」.
//
// #200: three lines, each with the number (its length) and the kind (EMA or
// SMA) the owner chooses: 「移動平均線を設定できる様にして 数字選んで」「3つ
// ほしい」. The first two keep their switches' keys (ema50, ema200: the
// account's saved switches, #141) and start at EMA 50 and EMA 200; the third
// (ma3) starts at EMA 20. #142 measured SMA 25, 75, 200 and EMA 50, 200
// (MEASURED_MA); any other line is drawn, not measured.
//
// TradingView's EMA (Pine's ta.ema: the simple average of the first n
// closes, then alpha = 2 / (n + 1)) — the same arithmetic the study read
// (analyze/indicators.ts emaSeries) — and SMA (ta.sma: the mean of the last
// n closes). The live chart computes them over the 600 closed bars before
// its own as well, so a line on its first bar has settled.
//
// Shown on the chart only: they read where the flow has been, not where it
// goes (after a reading, the next 48 bars went its way about half the
// time), so no signal, alert or record is judged on them.

import { ema, sma } from "./zoneShift";

export type MaType = "EMA" | "SMA";
export const MA_TYPES: ReadonlyArray<MaType> = ["EMA", "SMA"];

export interface MaLine {
  period: number;
  type: MaType;
}

// each line's switch (ChartOverlays) and colour, in the list's order
export const MA_SLOTS = [
  { key: "ema50", color: "#FF9800" },
  { key: "ema200", color: "#E040FB" },
  { key: "ma3", color: "#00BCD4" },
] as const;

export type MaKey = (typeof MA_SLOTS)[number]["key"];

export const MA_DEFAULTS: ReadonlyArray<MaLine> = [
  { period: 50, type: "EMA" },
  { period: 200, type: "EMA" },
  { period: 20, type: "EMA" },
];

// the longest: the live chart reads 600 closed bars before its own, so a
// line of up to 500 starts before the chart's first bar on a chart of 100
export const MA_MAX = 500;

// the numbers offered as buttons (any whole number from 1 to MA_MAX can be
// typed): the short, middle and long lines traders draw most
export const MA_PRESETS: ReadonlyArray<number> = [5, 10, 20, 25, 50, 75, 100, 200];

const lineOf = (v: unknown, d: MaLine): MaLine => {
  const r = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const p = r.period;
  return {
    period: typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= MA_MAX ? p : d.period,
    type: r.type === "SMA" || r.type === "EMA" ? r.type : d.type,
  };
};

// anything stored as the three lines: each line on its own, a missing or
// wrong one from its default
export const normalizeMaLines = (v: unknown): MaLine[] => {
  const a = Array.isArray(v) ? v : [];
  return MA_DEFAULTS.map((d, i) => lineOf(a[i], d));
};

export const sameMaLine = (a: MaLine, b: MaLine): boolean => a.period === b.period && a.type === b.type;

export const maLabel = (l: MaLine): string => `${l.type} ${l.period}`;

// #142's moving averages (docs §8.54: the close above or below each)
export const MEASURED_MA: ReadonlyArray<MaLine> = [
  { period: 25, type: "SMA" },
  { period: 75, type: "SMA" },
  { period: 200, type: "SMA" },
  { period: 50, type: "EMA" },
  { period: 200, type: "EMA" },
];
export const measuredMa = (l: MaLine): boolean => MEASURED_MA.some((m) => sameMaLine(m, l));

export const emaLine = (closes: ReadonlyArray<number>, length: number): Array<number | null> => ema(closes, length);

export const maValues = (closes: ReadonlyArray<number>, l: MaLine): Array<number | null> =>
  l.type === "SMA" ? sma(closes, l.period) : ema(closes, l.period);

// #150, #200: the golden and dead crosses are of the first two lines, the
// shorter as the fast one (the longer's crossing it from below is a GC);
// none when the two are the same line
export const crossPair = (lines: ReadonlyArray<MaLine>): { fast: MaLine; slow: MaLine } | null => {
  const [a, b] = lines;
  if (!a || !b || sameMaLine(a, b)) return null;
  return a.period <= b.period ? { fast: a, slow: b } : { fast: b, slow: a };
};
