import { describe, it, expect } from "vitest";
import {
  MAX_LIMIT_ATR,
  MAX_STOP_ATR,
  MIN_RISK_REWARD,
  MIN_STOP_ATR,
  alignedWithTrend,
  deriveRegime,
  entryScale,
  evaluateEntry,
  inferEntryType,
  isMomentumMode,
  normalizeMode,
  type EntryPlan,
} from "../../supabase/functions/analyze/entry.ts";

// A 1h USD/JPY plan: market 157.08, ATR 0.45 (45 pips). SELL at the market,
// stop 42 pips away (0.93 ATR), TP1 78 pips away (1:1.86).
const base: EntryPlan = {
  signal: "SELL",
  entry: 157.08,
  stopLoss: 157.5,
  takeProfit1: 156.3,
  price: 157.08,
  atr: 0.45,
  mode: "Trend Day",
  direction: "Down",
};

describe("helpers", () => {
  it("knows which regimes keep going, however the model spells them", () => {
    expect(isMomentumMode("Trend Day")).toBe(true);
    expect(isMomentumMode("trend_day")).toBe(true);
    expect(isMomentumMode("  BREAKOUT ")).toBe(true);
    expect(isMomentumMode("Range Day")).toBe(false);
    expect(isMomentumMode("Reversal")).toBe(false);
    expect(isMomentumMode(null)).toBe(false);
    expect(normalizeMode("Trend_Day")).toBe("trend day");
    expect(normalizeMode("   ")).toBeNull();
  });

  it("matches a signal against the reported direction, case-insensitively", () => {
    expect(alignedWithTrend("SELL", "Down")).toBe(true);
    expect(alignedWithTrend("BUY", "up")).toBe(true);
    expect(alignedWithTrend("SELL", "Up")).toBe(false);
    expect(alignedWithTrend("BUY", "Sideways")).toBe(false);
    expect(alignedWithTrend("BUY", null)).toBe(false);
  });

  it("reads the entry type off the numbers, not off the label", () => {
    // SELL: above the market waits for a bounce (limit), below rides the
    // break (stop)
    expect(inferEntryType("SELL", 157.5, 157.0, 0.45)).toBe("limit");
    expect(inferEntryType("SELL", 156.5, 157.0, 0.45)).toBe("stop");
    expect(inferEntryType("BUY", 156.5, 157.0, 0.45)).toBe("limit");
    expect(inferEntryType("BUY", 157.5, 157.0, 0.45)).toBe("stop");
    // within 0.15 ATR = 6.75 pips either way is "at market"
    expect(inferEntryType("SELL", 157.05, 157.0, 0.45)).toBe("market");
    expect(inferEntryType("BUY", 156.95, 157.0, 0.45)).toBe("market");
  });

  it("falls back to a fraction of price when the ATR is missing", () => {
    expect(entryScale(157, 0.45)).toBe(0.45);
    expect(entryScale(157, null)).toBeCloseTo(0.2355, 6);
    expect(entryScale(157, 0)).toBeCloseTo(0.2355, 6);
  });

  it("reads the regime off ADX and the moving-average stack", () => {
    expect(deriveRegime(157, { adx: 32, sma20: 157.3, sma50: 157.6 })).toEqual({ regime: "trend", direction: "Down" });
    expect(deriveRegime(157, { adx: 32, sma20: 156.7, sma50: 156.4 })).toEqual({ regime: "trend", direction: "Up" });
    // strong ADX but the averages disagree: not called
    expect(deriveRegime(157, { adx: 32, sma20: 157.3, sma50: 156.9 })).toEqual({ regime: "unclear", direction: null });
    expect(deriveRegime(157, { adx: 15, sma20: 157.3, sma50: 157.6 })).toEqual({ regime: "range", direction: null });
    expect(deriveRegime(157, { adx: 22, sma20: 157.3, sma50: 157.6 })).toEqual({ regime: "unclear", direction: null });
    expect(deriveRegime(157, { adx: null, sma20: 157.3, sma50: 157.6 })).toEqual({ regime: "unclear", direction: null });
    expect(deriveRegime(157, null)).toEqual({ regime: "unclear", direction: null });
  });
});

describe("evaluateEntry — the defect this exists for", () => {
  it("refuses a pullback entry while the trend is running, and says why the repair did not help", () => {
    // Exactly the shape of the five plans that were never filled: SELL,
    // Trend Day / Down, entry parked above the market. Entered at the market
    // instead, the same stop and target pay 0.83:1, so it is refused.
    const v = evaluateEntry({ ...base, entry: 157.3, stopLoss: 157.9, takeProfit1: 156.4 });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("should_be_market");
    expect(v.entryType).toBe("limit");
    expect(v.repaired).toBe(false);
    expect(v.repairRejection).toBe("poor_rr");
    expect(v.momentum).toBe(true);
    expect(v.entry).toBe(157.3);
  });

  it("repairs the same plan to a market entry when the stop and target still pay", () => {
    // Pullback to 157.30 with a stop at 157.60 and TP1 156.20: entered now,
    // risk 52 pips, reward 88 pips
    const v = evaluateEntry({ ...base, entry: 157.3, stopLoss: 157.6, takeProfit1: 156.2 });
    expect(v.ok).toBe(true);
    expect(v.repaired).toBe(true);
    expect(v.rejection).toBeNull();
    expect(v.entry).toBe(157.08);
    expect(v.originalEntry).toBe(157.3);
    expect(v.entryType).toBe("market");
    expect(v.riskReward).toBe(1.69);
  });

  it("uses the indicators' own regime read when the model calls a trend a range", () => {
    // Declared "Range Day", but ADX 32 with price under a falling stack
    const v = evaluateEntry({
      ...base,
      mode: "Range Day",
      direction: "Sideways",
      entry: 157.3,
      stopLoss: 157.9,
      takeProfit1: 156.4,
      indicators: { adx: 32, sma20: 157.3, sma50: 157.6 },
    });
    expect(v.rejection).toBe("should_be_market");
    expect(v.regime).toBe("trend");
    expect(v.regimeDirection).toBe("Down");
    expect(v.momentum).toBe(true);
  });

  it("accepts the same plan when both readings say range", () => {
    const v = evaluateEntry({
      ...base,
      mode: "Range Day",
      direction: "Sideways",
      entry: 157.3,
      stopLoss: 157.9,
      takeProfit1: 156.4,
      indicators: { adx: 15, sma20: 157.2, sma50: 157.1 },
    });
    expect(v.ok).toBe(true);
    expect(v.repaired).toBe(false);
    expect(v.entryType).toBe("limit");
    expect(v.regime).toBe("range");
    expect(v.momentum).toBe(false);
  });

  it("accepts the same plan when the signal fights the trend (a real reversal)", () => {
    const v = evaluateEntry({
      ...base,
      mode: "Reversal",
      direction: "Up",
      entry: 157.3,
      stopLoss: 157.9,
      takeProfit1: 156.4,
    });
    expect(v.ok).toBe(true);
    expect(v.momentum).toBe(false);
  });

  it("accepts a stop entry in the trend's own direction", () => {
    // SELL on a breakdown: entry below the market, so a continuing trend
    // fills it
    const v = evaluateEntry({ ...base, entry: 156.95, stopLoss: 157.4, takeProfit1: 156.2 });
    expect(v.entryType).toBe("stop");
    expect(v.ok).toBe(true);
  });

  it("accepts a market entry in a trending market", () => {
    const v = evaluateEntry(base);
    expect(v.entryType).toBe("market");
    expect(v.ok).toBe(true);
    expect(v.rejection).toBeNull();
    expect(v.repaired).toBe(false);
    expect(v.snapped).toBe(false);
  });

  it("pulls an entry inside the market band onto the market price", () => {
    // 6 pips above a 157.08 market on a 45-pip ATR is 0.13 ATR — "at market"
    // by this module, but a limit to the tracker, which would then require a
    // bounce back to 157.14 before the trade counts as taken
    const v = evaluateEntry({ ...base, entry: 157.14, stopLoss: 157.6, takeProfit1: 156.3 });
    expect(v.entryType).toBe("market");
    expect(v.ok).toBe(true);
    expect(v.snapped).toBe(true);
    expect(v.entry).toBe(157.08);
    expect(v.originalEntry).toBe(157.14);
    // risk and reward are recomputed at the snapped price: 52 / 78 pips
    expect(v.riskReward).toBe(1.5);
    expect(v.distanceAtr).toBe(0);
  });

  it("leaves the entry where the model put it when snapping would break the plan", () => {
    // 6 pips of the reward came from the entry sitting above the market; at
    // the market the same stop and target pay only 1.15, so the plan stands
    // as written rather than being snapped or refused
    const v = evaluateEntry({ ...base, entry: 157.14, stopLoss: 157.54, takeProfit1: 156.62 });
    expect(v.ok).toBe(true);
    expect(v.snapped).toBe(false);
    expect(v.snapDeclined).toBe("poor_rr");
    expect(v.entry).toBe(157.14);
    expect(v.rejection).toBeNull();
  });

  it("applies the same rules to the BUY side", () => {
    const buy: EntryPlan = { ...base, signal: "BUY", direction: "Up", entry: 156.9, stopLoss: 156.3, takeProfit1: 157.9 };
    // pullback 18 pips below the market in an uptrend: refused, and at the
    // market the same stop and target pay only 1.05:1
    const v = evaluateEntry(buy);
    expect(v.repaired).toBe(false);
    expect(v.rejection).toBe("should_be_market");
    expect(v.repairRejection).toBe("poor_rr");
    // breakout above the market in an uptrend: fine
    const stop = evaluateEntry({ ...buy, entry: 157.25, stopLoss: 156.8, takeProfit1: 158.1 });
    expect(stop.entryType).toBe("stop");
    expect(stop.ok).toBe(true);
  });
});

describe("evaluateEntry — distance", () => {
  it("refuses a pullback beyond the limit bound, whatever the regime", () => {
    const far = 157.08 + MAX_LIMIT_ATR * 0.45 + 0.01;
    const v = evaluateEntry({ ...base, mode: "Range Day", direction: "Sideways", entry: far, stopLoss: far + 0.5, takeProfit1: far - 1 });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("too_far");
    expect(v.distanceAtr).toBeGreaterThan(MAX_LIMIT_ATR);
    // the repair was tried and did not pay
    expect(v.repairRejection).toBe("poor_rr");
  });

  it("allows a pullback exactly at the bound", () => {
    const edge = 157.08 + MAX_LIMIT_ATR * 0.45;
    const v = evaluateEntry({ ...base, mode: "Range Day", direction: "Sideways", entry: edge, stopLoss: edge + 0.4, takeProfit1: edge - 0.9 });
    expect(v.distanceAtr).toBe(MAX_LIMIT_ATR);
    expect(v.ok).toBe(true);
  });

  it("gives a breakout entry more room, but not without limit", () => {
    // 0.8 ATR below the market: the move brings price to it
    const near = evaluateEntry({ ...base, entry: 157.08 - 0.8 * 0.45, stopLoss: 157.2, takeProfit1: 155.9 });
    expect(near.entryType).toBe("stop");
    expect(near.ok).toBe(true);
    // 1.3 ATR below: a late entry, not a breakout — and a stop is not
    // repaired to a market entry, that would be a different trade
    const far = evaluateEntry({ ...base, entry: 157.08 - (MAX_STOP_ATR + 0.3) * 0.45, stopLoss: 157.2, takeProfit1: 155.4 });
    expect(far.rejection).toBe("too_far");
    expect(far.repairRejection).toBeNull();
    expect(far.repaired).toBe(false);
  });

  it("still bites when the ATR is missing", () => {
    // fallback scale = 157.08 * 0.0015 ≈ 0.2356, bound ≈ 11.8 pips
    const v = evaluateEntry({ ...base, atr: null, mode: "Range Day", direction: "Sideways", entry: 157.3, stopLoss: 157.9, takeProfit1: 156.4 });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("too_far");
  });
});

describe("evaluateEntry — stop, reward and coherence", () => {
  it("refuses a stop inside the noise", () => {
    // 12 pips on a 45-pip ATR
    const v = evaluateEntry({ ...base, stopLoss: 157.2, takeProfit1: 156.3 });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("stop_too_tight");
    expect(v.stopAtr).toBeLessThan(MIN_STOP_ATR);
  });

  it("accepts a stop exactly at the floor", () => {
    const v = evaluateEntry({ ...base, stopLoss: 157.08 + MIN_STOP_ATR * 0.45, takeProfit1: 156.3 });
    expect(v.stopAtr).toBe(MIN_STOP_ATR);
    expect(v.ok).toBe(true);
  });

  it("refuses a reachable entry whose reward does not pay", () => {
    // risk 42 pips, reward 40 pips
    const v = evaluateEntry({ ...base, stopLoss: 157.5, takeProfit1: 156.68 });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("poor_rr");
    expect(v.riskReward).toBeLessThan(MIN_RISK_REWARD);
  });

  it("accepts one exactly at the risk/reward floor", () => {
    // risk 0.42, reward 0.504 → 1.2
    const v = evaluateEntry({ ...base, stopLoss: 157.5, takeProfit1: 157.08 - 0.504 });
    expect(v.riskReward).toBe(MIN_RISK_REWARD);
    expect(v.ok).toBe(true);
  });

  it("refuses levels on the wrong side of the entry", () => {
    // SELL with the stop below and the target above
    expect(evaluateEntry({ ...base, stopLoss: 156.5, takeProfit1: 157.9 }).rejection).toBe("incoherent");
    expect(evaluateEntry({ ...base, signal: "BUY", stopLoss: 157.5, takeProfit1: 156.3 }).rejection).toBe("incoherent");
  });

  it("refuses a plan with missing prices", () => {
    expect(evaluateEntry({ ...base, entry: null }).rejection).toBe("incoherent");
    expect(evaluateEntry({ ...base, stopLoss: null }).rejection).toBe("incoherent");
    expect(evaluateEntry({ ...base, takeProfit1: null }).rejection).toBe("incoherent");
    expect(evaluateEntry({ ...base, price: 0 }).rejection).toBe("incoherent");
  });

  it("passes a WAIT through untouched", () => {
    const v = evaluateEntry({ ...base, signal: "WAIT" });
    expect(v.ok).toBe(true);
    expect(v.rejection).toBeNull();
    expect(v.entryType).toBeNull();
    expect(v.repaired).toBe(false);
    expect(v.entry).toBe(157.08);
  });

  it("works on a five-decimal pair", () => {
    // EUR/USD 1.0850, ATR 0.0040: market SELL, stop 30 pips, TP1 60 pips
    const eur: EntryPlan = { ...base, entry: 1.085, stopLoss: 1.088, takeProfit1: 1.079, price: 1.085, atr: 0.004 };
    const v = evaluateEntry(eur);
    expect(v.ok).toBe(true);
    expect(v.entryType).toBe("market");
    expect(v.riskReward).toBe(2);
    // a pullback 25 pips up in the trend: refused, repaired (risk 30,
    // reward 60 at the market)
    const pullback = evaluateEntry({ ...eur, entry: 1.0875 });
    expect(pullback.repaired).toBe(true);
    expect(pullback.entry).toBe(1.085);
  });
});

describe("evaluateEntry — replaying the plans that were actually published", () => {
  // Reconstructed from public.analyses: entry, stop, target, the market price
  // at the time, and the model's own market_context_detail. Every one of
  // these was published under the old rules and then judged "untriggered /
  // missed" by the tracker. None of them survives the gate: the pullback is
  // refused, and at the market the model's own stop and target do not pay.
  const history: Array<{ name: string; plan: EntryPlan; expect: string }> = [
    {
      name: "1h SELL 157.90, Trend Day (14 pips above market)",
      plan: { signal: "SELL", entry: 157.9, stopLoss: 158.45, takeProfit1: 157.05, price: 157.76, atr: 0.45, mode: "Trend Day", direction: "Down" },
      expect: "should_be_market",
    },
    {
      name: "4h SELL 158.05, Breakout (66 pips above market)",
      plan: { signal: "SELL", entry: 158.05, stopLoss: 158.75, takeProfit1: 157.0, price: 157.39, atr: 0.9, mode: "Breakout", direction: "Down" },
      expect: "too_far",
    },
    {
      name: "1day SELL 158.30, Breakout (41 pips above market)",
      plan: { signal: "SELL", entry: 158.3, stopLoss: 159.25, takeProfit1: 156.76, price: 157.89, atr: 1.5, mode: "Breakout", direction: "Down" },
      expect: "should_be_market",
    },
    {
      name: "1h SELL 157.60, Trend Day (15 pips above market)",
      plan: { signal: "SELL", entry: 157.6, stopLoss: 158.05, takeProfit1: 156.85, price: 157.45, atr: 0.45, mode: "Trend Day", direction: "Down" },
      expect: "should_be_market",
    },
    {
      name: "1h SELL 157.30, Trend Day (45 pips above market)",
      plan: { signal: "SELL", entry: 157.3, stopLoss: 157.9, takeProfit1: 156.4, price: 156.85, atr: 0.45, mode: "Trend Day", direction: "Down" },
      expect: "too_far",
    },
    {
      name: "15min SELL 157.28, Trend Day (29 pips above market)",
      plan: { signal: "SELL", entry: 157.28, stopLoss: 157.66, takeProfit1: 156.62, price: 156.99, atr: 0.24, mode: "Trend Day", direction: "Down" },
      expect: "too_far",
    },
    {
      // 78 pips on a 1.5 ATR is 0.52 — over the distance bound, which is
      // checked before the regime rule
      name: "1day SELL 157.60, Breakout (78 pips above market)",
      plan: { signal: "SELL", entry: 157.6, stopLoss: 158.75, takeProfit1: 155.6, price: 156.82, atr: 1.5, mode: "Breakout", direction: "Down" },
      expect: "too_far",
    },
  ];

  for (const { name, plan, expect: reason } of history) {
    it(`refuses: ${name}`, () => {
      const v = evaluateEntry(plan);
      expect(v.ok).toBe(false);
      expect(v.rejection).toBe(reason);
      expect(v.entryType).toBe("limit");
      expect(v.repaired).toBe(false);
      expect(v.repairRejection).toBe("poor_rr");
    });
  }

  it("still accepts the one plan that did trade", () => {
    // 1day BUY 159.85, Breakout / Up, 22 pips from a 159.63 market on a
    // 1.5 ATR — at the market by the tolerance, and 1:1.5 on TP1. It went on
    // to lose, but it was a real, fillable plan and must not be filtered out.
    const v = evaluateEntry({
      signal: "BUY",
      entry: 159.85,
      stopLoss: 159.05,
      takeProfit1: 161.05,
      price: 159.63,
      atr: 1.5,
      mode: "Breakout",
      direction: "Up",
    });
    expect(v.ok).toBe(true);
    expect(v.entryType).toBe("market");
    expect(v.riskReward).toBe(1.5);
    // snapping it onto the market would put the stop inside the noise, so
    // the model's own entry stands
    expect(v.snapped).toBe(false);
    expect(v.snapDeclined).toBe("stop_too_tight");
    expect(v.entry).toBe(159.85);
  });
});
