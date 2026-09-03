import { describe, it, expect } from "vitest";
import { canSizeInYen, pipSize, positionSize, quoteCurrency } from "../lib/position";

describe("position sizing from the plan's own stop", () => {
  it("sizes a USD/JPY trade so the stop costs exactly the risk budget", () => {
    // ¥1,000,000 balance, 1% risk = ¥10,000. Stop 40 pips (0.40 yen) away.
    // 10,000 / 0.40 = 25,000 units = 2.5 lots
    const p = positionSize({ balance: 1_000_000, riskPercent: 1, entry: 158.0, stop: 158.4, pair: "USD/JPY" });
    expect(p).toEqual({ riskAmount: 10_000, stopDistance: 0.4, stopPips: 40, units: 25_000, lots: 2.5 });
  });

  it("halves the size when the plan's stop is twice as wide", () => {
    const tight = positionSize({ balance: 1_000_000, riskPercent: 1, entry: 158.0, stop: 158.2, pair: "USD/JPY" });
    const wide = positionSize({ balance: 1_000_000, riskPercent: 1, entry: 158.0, stop: 158.4, pair: "USD/JPY" });
    expect(tight?.units).toBe(50_000);
    expect(wide?.units).toBe(25_000);
  });

  it("refuses nonsense rather than returning a number", () => {
    expect(positionSize({ balance: 0, riskPercent: 1, entry: 158, stop: 158.4, pair: "USD/JPY" })).toBeNull();
    expect(positionSize({ balance: 1_000_000, riskPercent: 0, entry: 158, stop: 158.4, pair: "USD/JPY" })).toBeNull();
    // an entry equal to the stop has no risk to size against
    expect(positionSize({ balance: 1_000_000, riskPercent: 1, entry: 158, stop: 158, pair: "USD/JPY" })).toBeNull();
    expect(positionSize({ balance: NaN, riskPercent: 1, entry: 158, stop: 158.4, pair: "USD/JPY" })).toBeNull();
  });

  it("knows a pip and the quote currency, and when a yen balance cannot size a pair", () => {
    expect(pipSize("USD/JPY")).toBe(0.01);
    expect(pipSize("EUR/USD")).toBe(0.0001);
    expect(quoteCurrency("USD/JPY")).toBe("JPY");
    expect(quoteCurrency("EUR/USD")).toBe("USD");
    expect(canSizeInYen("USD/JPY")).toBe(true);
    expect(canSizeInYen("GBP/JPY")).toBe(true);
    // the risk on a dollar-quoted pair is in dollars; converting it would need
    // a rate this app does not hold
    expect(canSizeInYen("EUR/USD")).toBe(false);
  });
});
