import { useSyncExternalStore } from "react";
import { STOCH_132_DEFAULTS, STOCH_DEFAULTS, normalizeStochParams, type StochParams } from "./stochastic";

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
}

export const OVERLAY_DEFAULTS: ChartOverlays = {
  signals: true,
  positions: true,
  sarCloud: true,
  sarDots: true,
  trendLines: true,
  kalman: false,
  fvgProfile: true,
  zoneShift: true,
  dow: true,
  gainzPro: false,
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

export interface ChartPrefs {
  rsi: boolean;
  stoch: boolean;
  stochParams: StochParams;
  // #135: Bollinger %b and RCI strips (TradingView's built-ins), off until
  // switched on
  pctB: boolean;
  rci: boolean;
  // #118: the chart's background — the app's dark one, or white
  theme: ChartTheme;
  overlays: ChartOverlays;
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
  theme: "dark",
  overlays: OVERLAY_DEFAULTS,
};

let current: ChartPrefs | null = null;
const listeners = new Set<() => void>();

const read = (): ChartPrefs => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CHART_PREFS_KEY);
    if (!raw) return CHART_PREFS_DEFAULTS;
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      rsi: typeof v.rsi === "boolean" ? v.rsi : CHART_PREFS_DEFAULTS.rsi,
      stoch: typeof v.stoch === "boolean" ? v.stoch : CHART_PREFS_DEFAULTS.stoch,
      stochParams: (() => {
        const p = normalizeStochParams(v.stochParams);
        return v.stochDefaults === STOCH_132_MARK && sameStoch(p, STOCH_132_DEFAULTS) ? STOCH_DEFAULTS : p;
      })(),
      pctB: typeof v.pctB === "boolean" ? v.pctB : CHART_PREFS_DEFAULTS.pctB,
      rci: typeof v.rci === "boolean" ? v.rci : CHART_PREFS_DEFAULTS.rci,
      theme: v.theme === "light" ? "light" : "dark",
      overlays: overlaysOf(v.overlays),
    };
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
  };
  try {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ ...current, stochDefaults: STOCH_DEFAULTS_MARK }));
  } catch {
    // kept for this page only
  }
  listeners.forEach((l) => l());
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useChartPrefs = (): ChartPrefs => useSyncExternalStore(subscribe, getChartPrefs, () => CHART_PREFS_DEFAULTS);

// Tests start each case from what storage holds
export const resetChartPrefsCache = (): void => {
  current = null;
};
