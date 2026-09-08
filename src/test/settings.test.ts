import { describe, it, expect } from "vitest";
import { settingsFromStored } from "../lib/settings";

// The settings key has held three generations of fields: stop/target pips,
// then balance and risk percent, now the pair alone. Browsers still hold
// every generation, and none of it is a reason to lose the pair.
describe("settings loaded from an older browser", () => {
  it("keeps the pair and drops the balance and risk fields silently", () => {
    const stored = { accountBalance: 1_000_000, riskPercent: 1, currencyPair: "EUR/JPY" };
    expect(settingsFromStored(stored)).toEqual({ currencyPair: "EUR/JPY" });
  });

  it("drops the pips fields from the generation before that", () => {
    const stored = { stopPips: 30, targetPips: 60, currencyPair: "GBP/JPY" };
    expect(settingsFromStored(stored)).toEqual({ currencyPair: "GBP/JPY" });
  });

  it("falls back to the default pair for anything that is not a settings object", () => {
    expect(settingsFromStored(null)).toEqual({ currencyPair: "USD/JPY" });
    expect(settingsFromStored("USD/JPY")).toEqual({ currencyPair: "USD/JPY" });
    expect(settingsFromStored({ currencyPair: "" })).toEqual({ currencyPair: "USD/JPY" });
    expect(settingsFromStored({ accountBalance: 5 })).toEqual({ currencyPair: "USD/JPY" });
  });
});
