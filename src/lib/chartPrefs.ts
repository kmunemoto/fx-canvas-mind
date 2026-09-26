import { useSyncExternalStore } from "react";
import { STOCH_DEFAULTS, normalizeStochParams, type StochParams } from "./stochastic";

// #117: which indicator strips the charts show under the price, and the
// stochastic's lengths (#118: and the background) — one choice for every
// chart, kept in this browser
// (a convenience: a private window or cleared storage starts from the
// defaults, and nothing depends on it).

export type ChartTheme = "dark" | "light";

export interface ChartPrefs {
  rsi: boolean;
  stoch: boolean;
  stochParams: StochParams;
  // #118: the chart's background — the app's dark one, or white
  theme: ChartTheme;
}

export const CHART_PREFS_KEY = "sextant.chart.prefs.v1";
export const CHART_PREFS_DEFAULTS: ChartPrefs = { rsi: true, stoch: true, stochParams: STOCH_DEFAULTS, theme: "dark" };

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
    };
  } catch {
    return CHART_PREFS_DEFAULTS;
  }
};

export const getChartPrefs = (): ChartPrefs => (current ??= read());

export const setChartPrefs = (patch: Partial<ChartPrefs>): void => {
  const next = { ...getChartPrefs(), ...patch };
  current = { ...next, stochParams: normalizeStochParams(next.stochParams), theme: next.theme === "light" ? "light" : "dark" };
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
