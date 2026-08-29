import { describe, it, expect } from "vitest";
import { evaluatePlan } from "../../supabase/functions/track-outcomes/evaluate.ts";
import type { Candle } from "../../supabase/functions/analyze/indicators.ts";

const candle = (datetime: string, high: number, low: number): Candle => ({
  datetime,
  open: (high + low) / 2,
  high,
  low,
  close: (high + low) / 2,
});

const basePlan = {
  id: "1",
  pair: "USD/JPY",
  interval: "1h",
  signal: "BUY" as const,
  entry_point: 150,
  stop_loss: 149,
  take_profit_1: 152,
  created_at: "2026-08-20T00:00:00Z",
};

describe("evaluatePlan", () => {
  it("BUY wins when a candle after creation reaches TP1", () => {
    const verdict = evaluatePlan(basePlan, [
      candle("2026-08-20 01:00:00", 150.5, 149.8),
      candle("2026-08-20 02:00:00", 152.3, 150.2),
    ]);
    expect(verdict).toEqual({ outcome: "win", price: 152, at: "2026-08-20 02:00:00" });
  });

  it("BUY loses when SL is reached first", () => {
    const verdict = evaluatePlan(basePlan, [
      candle("2026-08-20 01:00:00", 150.2, 148.9),
      candle("2026-08-20 02:00:00", 152.5, 150.0),
    ]);
    expect(verdict?.outcome).toBe("loss");
    expect(verdict?.price).toBe(149);
  });

  it("SELL direction mirrors the comparisons", () => {
    const sell = { ...basePlan, signal: "SELL" as const, stop_loss: 151, take_profit_1: 148 };
    const verdict = evaluatePlan(sell, [candle("2026-08-20 01:00:00", 150.4, 147.9)]);
    expect(verdict?.outcome).toBe("win");
  });

  it("a candle spanning both SL and TP is undecidable", () => {
    const verdict = evaluatePlan(basePlan, [candle("2026-08-20 01:00:00", 152.5, 148.5)]);
    expect(verdict).toBeNull();
  });

  it("ignores candles from before the plan was created", () => {
    const verdict = evaluatePlan(basePlan, [
      candle("2026-08-19 23:00:00", 153, 148), // pre-plan spike must not count
      candle("2026-08-20 01:00:00", 150.5, 149.8),
    ]);
    expect(verdict).toBeNull();
  });

  it("returns null while neither level is touched", () => {
    const verdict = evaluatePlan(basePlan, [candle("2026-08-20 01:00:00", 151.5, 149.5)]);
    expect(verdict).toBeNull();
  });
});
