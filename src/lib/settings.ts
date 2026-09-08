import type { AppSettings } from "./types";

export const DEFAULT_SETTINGS: AppSettings = {
  currencyPair: "USD/JPY",
};

// Only the pair is read. Settings written under this key have carried the
// stop/target pips fields, then the balance and risk-percent fields, and
// browsers still hold both generations; each is ignored rather than treated
// as a reason to reset the pair.
export const settingsFromStored = (stored: unknown): AppSettings => {
  const s = stored && typeof stored === "object" ? stored as Partial<AppSettings> : {};
  return {
    currencyPair: typeof s.currencyPair === "string" && s.currencyPair ? s.currencyPair : DEFAULT_SETTINGS.currencyPair,
  };
};
