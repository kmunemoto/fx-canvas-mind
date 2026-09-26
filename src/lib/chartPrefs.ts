import { useSyncExternalStore } from "react";
import { STOCH_DEFAULTS, normalizeStochParams, type StochParams } from "./stochastic";

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
  // #121: FluxChart's FVG Crossfire (a port of its open-source code)
  fvgCrossfire: boolean;
}

export const OVERLAY_DEFAULTS: ChartOverlays = {
  signals: true,
  positions: true,
  sarCloud: true,
  sarDots: true,
  trendLines: true,
  kalman: false,
  fvgCrossfire: true,
};

const overlaysOf = (v: unknown): ChartOverlays => {
  const r = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out = { ...OVERLAY_DEFAULTS };
  for (const k of Object.keys(OVERLAY_DEFAULTS) as Array<keyof ChartOverlays>) {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  }
  return out;
};

export interface ChartPrefs {
  rsi: boolean;
  stoch: boolean;
  stochParams: StochParams;
  // #118: the chart's background — the app's dark one, or white
  theme: ChartTheme;
  overlays: ChartOverlays;
}

export const CHART_PREFS_KEY = "sextant.chart.prefs.v1";
export const CHART_PREFS_DEFAULTS: ChartPrefs = {
  rsi: true,
  stoch: true,
  stochParams: STOCH_DEFAULTS,
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
      stochParams: normalizeStochParams(v.stochParams),
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
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(current));
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
