import { useSyncExternalStore } from "react";
import { STOCH_132_DEFAULTS, STOCH_DEFAULTS, normalizeStochParams, type StochParams } from "./stochastic";
import { DRAWING_COLORS, DRAWING_WIDTHS, LINE_STYLES, type LineStyle, type MagnetMode } from "./drawings";

// #117: which indicator strips the charts show under the price, and the
// stochastic's lengths (#118: the background; #119: what is drawn over the
// price) — one choice for every chart, kept in this browser (a convenience:
// a private window or cleared storage starts from the defaults, and nothing
// depends on it).

export type ChartTheme = "dark" | "light";

// #119: what else the charts draw, each switched on or off from the list at
// the chart's top left (TradingView's eye icons)
export interface ChartOverlays {
  // the rule's BUY/SELL labels and their TP/SL boxes
  signals: boolean;
  // each signal's position box, × and vertical line (the live chart)
  positions: boolean;
  sarCloud: boolean;
  sarDots: boolean;
  // the lines through the last two swings (the analysis chart)
  trendLines: boolean;
  // the SPECTRA-style Kalman Supertrend — off until switched on
  kalman: boolean;
  // #136: KivancOzbilgic's SuperTrend (a port of its open-source code) —
  // off until switched on
  supertrend: boolean;
  // #137: QuantNomad's UT Bot Alerts (a port of its open-source code) — it
  // paints the candles; off until switched on
  utBot: boolean;
  // Flux Charts' FVG Crossfire (#121) and Weighted Volume Profile (#122),
  // ports of their open-source code — one switch for the two (#123: the
  // owner asked for them as one, "ニコイチ")
  fvgProfile: boolean;
  // #124: ChartPrime's Zone Shift (a port of its open-source code) — it
  // paints the candles in its trend's colours
  zoneShift: boolean;
  // #129: Dow theory on four timeframes (the live chart)
  dow: boolean;
  // #131: the Pro-style confidence score (this app's reading of GainzAlgo's
  // Pro configuration)
  gainzPro: boolean;
  // #143: EMA 50 and EMA 200, the lines #142 found read the big flow best
  // (the flow across the chart, and the larger one) — on unless switched off
  ema50: boolean;
  ema200: boolean;
  // #145: the two indicators of the owner's video — tarasenko_'s Q-Trend
  // over the price, and where it, the BLSH line and the BLSH area agree
  // (the video's "triple confirmation"); on unless switched off
  qTrend: boolean;
  qtBlsh: boolean;
  // #150: the trend tools of the owner's note the chart lacked — trend
  // lines through the swings and the EMA 50 × 200 golden and dead crosses
  // (on unless switched off), and Ichimoku (off until switched on: a cloud
  // and four lines over the price)
  autoTrend: boolean;
  maCross: boolean;
  ichimoku: boolean;
  // #151: the owner's video's ULTRA EN (RSI 14 at 70 and 30, a stop and
  // three targets, and their tally) — on unless switched off
  ultra: boolean;
}

export const OVERLAY_DEFAULTS: ChartOverlays = {
  signals: true,
  positions: true,
  sarCloud: true,
  sarDots: true,
  trendLines: true,
  kalman: false,
  supertrend: false,
  utBot: false,
  fvgProfile: true,
  zoneShift: true,
  dow: true,
  gainzPro: false,
  ema50: true,
  ema200: true,
  qTrend: true,
  qtBlsh: true,
  autoTrend: true,
  maCross: true,
  ichimoku: false,
  ultra: true,
};

const overlaysOf = (v: unknown): ChartOverlays => {
  const r = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out = { ...OVERLAY_DEFAULTS };
  for (const k of Object.keys(OVERLAY_DEFAULTS) as Array<keyof ChartOverlays>) {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  }
  // kept from before #123, when FVG Crossfire had a switch of its own
  if (typeof r.fvgProfile !== "boolean" && typeof r.fvgCrossfire === "boolean") out.fvgProfile = r.fvgCrossfire;
  return out;
};

// #141: the live chart's own choices — its pair, timeframe and which rule's
// signals it shows. Kept as given (null: the chart's default); the live
// chart checks each against what it offers before using it.
export interface LivePrefs {
  pair: string | null;
  interval: string | null;
  view: string | null;
}
export const LIVE_PREFS_DEFAULTS: LivePrefs = { pair: null, interval: null, view: null };
const livePrefsOf = (v: unknown): LivePrefs => {
  const r = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 && x.length <= 16 ? x : null);
  return { pair: str(r.pair), interval: str(r.interval), view: str(r.view) };
};

// #160: the drawing tools' settings — the magnet, whether a tool stays on
// after a drawing is put down (TradingView's "stay in drawing mode"), whether
// the drawings are hidden, and the colour, width and line a new drawing
// starts with (the last chosen on one)
export interface DrawingPrefs {
  magnet: MagnetMode;
  keep: boolean;
  hidden: boolean;
  color: string;
  width: number;
  style: LineStyle;
}
export const DRAWING_PREFS_DEFAULTS: DrawingPrefs = { magnet: "off", keep: false, hidden: false, color: DRAWING_COLORS[0], width: 2, style: "solid" };
const drawingPrefsOf = (v: unknown): DrawingPrefs => {
  const r = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const d = DRAWING_PREFS_DEFAULTS;
  return {
    magnet: r.magnet === "weak" || r.magnet === "strong" ? r.magnet : d.magnet,
    keep: typeof r.keep === "boolean" ? r.keep : d.keep,
    hidden: typeof r.hidden === "boolean" ? r.hidden : d.hidden,
    color: typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : d.color,
    width: DRAWING_WIDTHS.includes(r.width as number) ? (r.width as number) : d.width,
    style: (LINE_STYLES as ReadonlyArray<unknown>).includes(r.style) ? (r.style as LineStyle) : d.style,
  };
};

export interface ChartPrefs {
  rsi: boolean;
  stoch: boolean;
  stochParams: StochParams;
  // #135: Bollinger %b and RCI strips (TradingView's built-ins), off until
  // switched on
  pctB: boolean;
  rci: boolean;
  // #145: zacmcc's Buy Low Sell High Composite under the price
  blsh: boolean;
  // #150: TradingView's MACD and ADX (DMI) strips, off until switched on
  macd: boolean;
  adx: boolean;
  // #118: the chart's background — the app's dark one, or white
  theme: ChartTheme;
  overlays: ChartOverlays;
  live: LivePrefs;
  drawing: DrawingPrefs;
}

export const CHART_PREFS_KEY = "sextant.chart.prefs.v1";
// Saved beside the preferences, to say which stochastic defaults were in
// force when they were saved. #132 changed the defaults to 21, 5, 3 and
// marked what it saved 132; #133 put 14, 1, 3 back. Preferences marked 132
// that hold 21, 5, 3 held them because they were the defaults, and take
// 14, 1, 3 again; anything saved from now on is marked 133 and kept.
const STOCH_DEFAULTS_MARK = 133;
const STOCH_132_MARK = 132;
const sameStoch = (a: StochParams, b: StochParams) => a.kLength === b.kLength && a.kSmoothing === b.kSmoothing && a.dSmoothing === b.dSmoothing;
export const CHART_PREFS_DEFAULTS: ChartPrefs = {
  rsi: true,
  stoch: true,
  stochParams: STOCH_DEFAULTS,
  pctB: false,
  rci: false,
  blsh: true,
  macd: false,
  adx: false,
  theme: "dark",
  overlays: OVERLAY_DEFAULTS,
  live: LIVE_PREFS_DEFAULTS,
  drawing: DRAWING_PREFS_DEFAULTS,
};

let current: ChartPrefs | null = null;
const listeners = new Set<() => void>();

// Anything stored — in this browser, or (#141) with the account — as
// preferences the charts can use
export const chartPrefsFrom = (stored: unknown): ChartPrefs => {
  if (stored === null || typeof stored !== "object") return CHART_PREFS_DEFAULTS;
  const v = stored as Record<string, unknown>;
  return {
    rsi: typeof v.rsi === "boolean" ? v.rsi : CHART_PREFS_DEFAULTS.rsi,
    stoch: typeof v.stoch === "boolean" ? v.stoch : CHART_PREFS_DEFAULTS.stoch,
    stochParams: (() => {
      const p = normalizeStochParams(v.stochParams);
      return v.stochDefaults === STOCH_132_MARK && sameStoch(p, STOCH_132_DEFAULTS) ? STOCH_DEFAULTS : p;
    })(),
    pctB: typeof v.pctB === "boolean" ? v.pctB : CHART_PREFS_DEFAULTS.pctB,
    rci: typeof v.rci === "boolean" ? v.rci : CHART_PREFS_DEFAULTS.rci,
    blsh: typeof v.blsh === "boolean" ? v.blsh : CHART_PREFS_DEFAULTS.blsh,
    macd: typeof v.macd === "boolean" ? v.macd : CHART_PREFS_DEFAULTS.macd,
    adx: typeof v.adx === "boolean" ? v.adx : CHART_PREFS_DEFAULTS.adx,
    theme: v.theme === "light" ? "light" : "dark",
    overlays: overlaysOf(v.overlays),
    live: livePrefsOf(v.live),
    drawing: drawingPrefsOf(v.drawing),
  };
};

// What is saved: the preferences and the mark saying which stochastic
// defaults were in force
export const storedChartPrefs = (p: ChartPrefs): Record<string, unknown> => ({ ...p, stochDefaults: STOCH_DEFAULTS_MARK });

const read = (): ChartPrefs => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CHART_PREFS_KEY);
    if (!raw) return CHART_PREFS_DEFAULTS;
    return chartPrefsFrom(JSON.parse(raw));
  } catch {
    return CHART_PREFS_DEFAULTS;
  }
};

export const getChartPrefs = (): ChartPrefs => (current ??= read());

export const setChartPrefs = (patch: Partial<ChartPrefs>): void => {
  const next = { ...getChartPrefs(), ...patch };
  current = {
    ...next,
    stochParams: normalizeStochParams(next.stochParams),
    theme: next.theme === "light" ? "light" : "dark",
    overlays: overlaysOf(next.overlays),
    live: livePrefsOf(next.live),
    drawing: drawingPrefsOf(next.drawing),
  };
  save();
};

const save = () => {
  try {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(storedChartPrefs(getChartPrefs())));
  } catch {
    // kept for this page only
  }
  listeners.forEach((l) => l());
};

// #141: the account's saved preferences, taken as this browser's
export const replaceChartPrefs = (stored: unknown): void => {
  current = chartPrefsFrom(stored);
  save();
};

export const subscribeChartPrefs = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useChartPrefs = (): ChartPrefs => useSyncExternalStore(subscribeChartPrefs, getChartPrefs, () => CHART_PREFS_DEFAULTS);

// Tests start each case from what storage holds
export const resetChartPrefsCache = (): void => {
  current = null;
};
