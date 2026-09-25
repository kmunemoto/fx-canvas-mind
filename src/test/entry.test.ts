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
  MAX_RISK_REWARD,
  FRESH_BREAK_BARS,
  TURN_BLOCK,
  type TurnForGate,
  MIN_TP1_ATR,
  WAIT_SCORER,
  waitPlanFor,
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

  it("does not force a market entry on a declared trend that the indicators call a range", () => {
    // The model says "Trend Day", the ADX says 15: a pullback limit stands
    const v = evaluateEntry({
      ...base,
      entry: 157.3,
      stopLoss: 157.9,
      takeProfit1: 156.4,
      indicators: { adx: 15, sma20: 157.2, sma50: 157.1 },
    });
    expect(v.momentum).toBe(false);
    expect(v.regime).toBe("range");
    expect(v.ok).toBe(true);
    expect(v.rejection).toBeNull();
    expect(v.entryType).toBe("limit");
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
  const history: Array<{ name: string; plan: EntryPlan; expect: string; repair?: string }> = [
    {
      name: "1h SELL 157.90, Trend Day (14 pips above market)",
      plan: { signal: "SELL", entry: 157.9, stopLoss: 158.45, takeProfit1: 157.05, price: 157.76, atr: 0.45, mode: "Trend Day", direction: "Down" },
      expect: "should_be_market",
    },
    {
      name: "4h SELL 158.05, Breakout (66 pips above market)",
      plan: { signal: "SELL", entry: 158.05, stopLoss: 158.75, takeProfit1: 157.0, price: 157.39, atr: 0.9, mode: "Breakout", direction: "Down" },
      expect: "too_far",
      // Entered at the market this one is refused by the TARGET floor rather
      // than the ratio: 39 pips of reward on a 0.9 ATR is 0.43 ATR, inside
      // the noise, and target_too_close is checked first because it is the
      // more precise of the two sentences (entry.ts, MIN_TP1_ATR).
      repair: "target_too_close",
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

  for (const { name, plan, expect: reason, repair } of history) {
    it(`refuses: ${name}`, () => {
      const v = evaluateEntry(plan);
      expect(v.ok).toBe(false);
      expect(v.rejection).toBe(reason);
      expect(v.entryType).toBe("limit");
      expect(v.repaired).toBe(false);
      expect(v.repairRejection).toBe(repair ?? "poor_rr");
    });
  }

  // WHAT THE 0.6 STOP FLOOR COSTS, on the one plan in this set that used to
  // pass. 1day BUY 159.85, Breakout / Up, 22 pips from a 159.63 market on a
  // 1.5 ATR: at the market by the tolerance, 1:1.5 on TP1, and a stop 80 pips
  // away — 0.53 ATR. Until 2026-09-21 that cleared the 0.4 floor and the plan
  // was published; it then lost. Under the 0.6 floor the same plan is refused.
  //
  // This test used to assert the opposite ("must not be filtered out"), and
  // the assertion is inverted here rather than deleted, because the floor
  // moving is exactly the kind of change that should have to rewrite a test
  // that says what the gate publishes.
  it("now refuses the one plan in this set that used to trade — the stop is 0.53 ATR", () => {
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
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("stop_too_tight");
    expect(v.stopAtr).toBeCloseTo(0.53, 2);
    expect(v.stopAtr).toBeLessThan(MIN_STOP_ATR);
    // The geometry it was refused on is still measured and reported: the
    // ratio was never the problem.
    expect(v.riskReward).toBe(1.5);
    expect(v.entryType).toBe("market");
  });
});

describe("a floor with no ceiling is an instruction to reverse-engineer the target", () => {
  it("refuses a target placed far enough out to make any stop look good", () => {
    // Measured over the first eight plans: every risk/reward landed between
    // 1.48 and 1.69, just above the floor, while stops sat at 0.72-1.03 ATR.
    // The model was solving "what passes", not "where is this idea wrong".
    // Closing the other end stops the target being pushed out of reach.
    const v = evaluateEntry({
      signal: "BUY",
      entry: 150,
      stopLoss: 149.3,      // risk 0.7 ATR, clear of the stop floor
      takeProfit1: 155,     // reward 5.0 -> RR 7.1
      price: 150,
      atr: 1,
      mode: null,
      direction: null,
      indicators: { adx: 30, sma20: 149, sma50: 148 },
    });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("target_out_of_reach");
  });

  it("still allows an ordinary ratio", () => {
    const v = evaluateEntry({
      signal: "BUY",
      entry: 150,
      stopLoss: 149.3,    // risk 0.7 ATR
      takeProfit1: 151.4, // reward 1.4 ATR -> RR 2
      price: 150,
      atr: 1,
      mode: null,
      direction: null,
      indicators: { adx: 30, sma20: 149, sma50: 148 },
    });
    expect(v.ok).toBe(true);
    expect(v.riskReward).toBe(2);
  });

  it("brackets the ratio from both ends", () => {
    expect(MAX_RISK_REWARD).toBeGreaterThan(MIN_RISK_REWARD);
  });
});

// THE 0.6 ATR FLOORS (2026-09-21). The owner asked for a minimum width of
// 0.6 ATR on BOTH sides of the entry after seeing a plan whose stop could
// legally have been 9 pips. These are the contract for that.
describe("both sides of the entry have to give the plan room", () => {
  // 150 with a 1.0 ATR, so an ATR multiple reads off the price directly.
  const at = (stop: number, target: number): EntryPlan => ({
    signal: "BUY",
    entry: 150,
    stopLoss: 150 - stop,
    takeProfit1: 150 + target,
    price: 150,
    atr: 1,
    mode: null,
    direction: null,
  });

  it("the two floors are the number that was asked for", () => {
    expect(MIN_STOP_ATR).toBe(0.6);
    expect(MIN_TP1_ATR).toBe(0.6);
  });

  it("refuses a stop inside the floor and accepts one exactly on it", () => {
    const under = evaluateEntry(at(0.59, 2));
    expect(under.ok).toBe(false);
    expect(under.rejection).toBe("stop_too_tight");
    expect(under.stopAtr).toBe(0.59);

    // Exactly on the floor. `150 - 0.6` is 0.5999999999999943 in binary, so
    // this passes only because the gate judges the ROUNDED multiple — the
    // same number it reports and the screen prints. A plan cannot be refused
    // for being under a floor the card beside the refusal says it meets.
    const on = evaluateEntry(at(MIN_STOP_ATR, 2));
    expect(on.ok).toBe(true);
    expect(on.stopAtr).toBe(MIN_STOP_ATR);
  });

  it("refuses a first target inside the floor and accepts one exactly on it", () => {
    // Stop well clear of its own floor, so the only thing under test is the
    // target: 0.5 ATR of reward on 1.0 ATR of risk.
    const under = evaluateEntry(at(1, 0.5));
    expect(under.ok).toBe(false);
    expect(under.rejection).toBe("target_too_close");

    // Exactly on the target floor: this reason is gone, and what refuses it
    // now is the RATIO (0.6 against a 1.0 stop is 1:0.6), which is the honest
    // reason at that geometry.
    expect(evaluateEntry(at(1, MIN_TP1_ATR)).rejection).toBe("poor_rr");
    // ...and on a stop the target can pay for, it passes.
    const ok = evaluateEntry(at(MIN_STOP_ATR, 0.72));
    expect(ok.ok).toBe(true);
    expect(ok.riskReward).toBe(1.2);
  });

  it("names the target, not the ratio, when both are wrong", () => {
    // 0.4 ATR of reward on a 0.8 ATR stop fails the ratio (1:0.5) AND the
    // target floor. The more precise sentence is the one that is returned.
    const v = evaluateEntry(at(0.8, 0.4));
    expect(v.rejection).toBe("target_too_close");
    expect(v.riskReward).toBe(0.5);
  });

  it("is the same demand for a SELL", () => {
    const mirror = (stop: number, target: number): EntryPlan => ({
      ...at(stop, target),
      signal: "SELL",
      stopLoss: 150 + stop,
      takeProfit1: 150 - target,
    });
    expect(evaluateEntry(mirror(0.59, 2)).rejection).toBe("stop_too_tight");
    expect(evaluateEntry(mirror(1, 0.5)).rejection).toBe("target_too_close");
    expect(evaluateEntry(mirror(MIN_STOP_ATR, 0.72)).ok).toBe(true);
  });

  it("the WAIT it is measured against moved with it, and carries a new era", () => {
    // waitPlanFor builds the least trade the app would have demanded. Both
    // numbers come from these floors, so the WAIT scorer's subject changed
    // shape the moment they did — which is what the era number records.
    const p = waitPlanFor({
      proposedSignal: "BUY",
      declaredDirection: null,
      regime: "unclear",
      regimeDirection: null,
      entry: 150,
      atr: 1,
      quote: null,
      decimals: 3,
      contract: "market_v1",
      decidedAt: "2026-09-21T12:00:00.000Z",
    });
    expect(p.risk).toBeCloseTo(MIN_STOP_ATR, 10);
    expect(p.reward).toBeCloseTo(MIN_STOP_ATR * MIN_RISK_REWARD, 10);
    expect(p.scorer).toBe(WAIT_SCORER);
    expect(WAIT_SCORER).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// THE STRUCTURE GATE (2026-09-19).
//
// Measured that day: 62 of the 63 directional calls since 8/29 were SELL, the
// analyst never proposed a BUY, and the six SELLs into the 9/14–9/19 rally
// (153.7 → 156.9) all lost. Nothing in the pipeline could say "the higher
// timeframe has stopped going down". This is the thing that says so, and
// these tests are the contract for exactly what it reads.
// ---------------------------------------------------------------------------

import {
  readHigherStructures,
  structureBias,
  structureConflictFor,
  type HigherStructure,
  type StructureForGate,
} from "../../supabase/functions/analyze/entry.ts";
import { readFileSync } from "node:fs";

const brk = (kind: "high" | "low", state: "held" | "broken" | "reclaimed", barsAgo: number, level = 154.66) => ({
  level,
  kind,
  datetime: "2026-09-17 00:00:00",
  barsAgo,
  close: kind === "high" ? level + 0.5 : level - 0.5,
  state,
  wickOnly: 0,
});

const st = (over: Partial<StructureForGate> = {}): StructureForGate => ({
  ok: true,
  label: "range",
  lastBreak: { up: null, down: null },
  ...over,
});

describe("structureBias reads the higher timeframe off its own closes", () => {
  it("is the most recent settled close-break, whichever side", () => {
    // The 9/21 daily, as the code will see it: 154.66 broken up 3 bars ago,
    // 158.04 broken down 12 bars ago — the up break is what price did last.
    const daily = st({ label: "downtrend", lastBreak: { up: brk("high", "broken", 3), down: brk("low", "broken", 12, 158.04) } });
    expect(structureBias(daily)).toMatchObject({ bias: "Up", from: "break" });
    expect(structureBias(daily).brk?.level).toBe(154.66);
    // and the mirror image
    const mirror = st({ label: "uptrend", lastBreak: { up: brk("high", "broken", 12), down: brk("low", "broken", 3, 152.9) } });
    expect(structureBias(mirror)).toMatchObject({ bias: "Down", from: "break" });
  });

  it("ignores a reclaimed level and a level only pierced by wicks", () => {
    // 9/14's daily: the 8/28 up-break was reclaimed, the 9/3 down-break held.
    // Reclaimed is "the level is alive", not a break; held is a wick.
    const sept14 = st({ label: "downtrend", lastBreak: { up: brk("high", "reclaimed", 13, 159.78), down: brk("low", "broken", 8, 158.04) } });
    expect(structureBias(sept14)).toMatchObject({ bias: "Down", from: "break" });
    const wicks = st({ lastBreak: { up: brk("high", "held", 2), down: null } });
    expect(structureBias(wicks).bias).toBeNull();
  });

  it("falls back to the two-pivot label only when nothing was closed through, and says so", () => {
    expect(structureBias(st({ label: "uptrend" }))).toEqual({ bias: "Up", from: "label", brk: null });
    expect(structureBias(st({ label: "downtrend" }))).toEqual({ bias: "Down", from: "label", brk: null });
    for (const label of ["range", "expanding", "contracting", "unknown"] as const) {
      expect(structureBias(st({ label })).bias, label).toBeNull();
    }
    // a break outranks the label, even the opposite label
    expect(structureBias(st({ label: "downtrend", lastBreak: { up: brk("high", "broken", 3), down: null } })).bias).toBe("Up");
  });

  it("calls a tie no direction, and an unusable structure no direction", () => {
    expect(structureBias(st({ lastBreak: { up: brk("high", "broken", 5), down: brk("low", "broken", 5) } })).bias).toBeNull();
    expect(structureBias(st({ ok: false, label: "uptrend" })).bias).toBeNull();
    expect(structureBias(null).bias).toBeNull();
    expect(structureBias(undefined).bias).toBeNull();
  });
});

describe("structureConflictFor refuses the plan that points against the rung above it", () => {
  const up = (tf: string): HigherStructure => ({ tf, structure: st({ lastBreak: { up: brk("high", "broken", 3), down: null } }) });
  const down = (tf: string): HigherStructure => ({ tf, structure: st({ lastBreak: { up: null, down: brk("low", "broken", 3, 152.9) } }) });
  const flat = (tf: string): HigherStructure => ({ tf, structure: st() });

  it("names the nearest rung that disagrees, with the level it read", () => {
    const c = structureConflictFor("SELL", [flat("4h"), up("1day")]);
    expect(c).toMatchObject({ tf: "1day", bias: "Up", from: "break", level: 154.66, barsAgo: 3 });
    expect(structureConflictFor("BUY", [down("4h"), up("1day")])).toMatchObject({ tf: "4h", bias: "Down" });
  });

  it("lets an aligned plan, a WAIT, and a plan with no rungs through", () => {
    expect(structureConflictFor("SELL", [down("4h"), down("1day")])).toBeNull();
    expect(structureConflictFor("BUY", [up("4h")])).toBeNull();
    expect(structureConflictFor("WAIT", [up("4h"), up("1day")])).toBeNull();
    expect(structureConflictFor("SELL", [])).toBeNull();
    expect(structureConflictFor("SELL", null)).toBeNull();
    expect(structureConflictFor("SELL", [flat("4h"), flat("1day")])).toBeNull();
  });

  it("a label-only reading still refuses, and is reported as the weaker source", () => {
    const labelUp: HigherStructure = { tf: "1day", structure: st({ label: "uptrend" }) };
    expect(structureConflictFor("SELL", [labelUp])).toMatchObject({ from: "label", level: null, datetime: null, barsAgo: null });
  });

  it("records what every rung said, on every call", () => {
    expect(readHigherStructures([down("4h"), up("1day"), flat("1week")])).toEqual([
      { tf: "4h", bias: "Down", from: "break", turn: null, turning: false },
      { tf: "1day", bias: "Up", from: "break", turn: null, turning: false },
      { tf: "1week", bias: null, from: null, turn: null, turning: false },
    ]);
    expect(readHigherStructures(null)).toEqual([]);
  });
});

describe("a turning rung yields, and the entry rung's own turn refuses a continuation (#96)", () => {
  const turn = (up: number, down: number): TurnForGate => ({
    up: { score: up, facts: ["stale_break", "hist_run", "rsi_recovery", "mean_cross"].slice(0, up) },
    down: { score: down, facts: ["stale_break", "hist_run", "rsi_recovery", "mean_cross"].slice(0, down) },
  });
  // The 9/14 daily as the code saw it: 158.04 broken down eight bars ago, the
  // 8/28 up-break reclaimed, and three facts that the fall was ending.
  const dailyTurning: HigherStructure = {
    tf: "1day",
    structure: st({ label: "downtrend", lastBreak: { up: brk("high", "reclaimed", 13, 159.78), down: brk("low", "broken", 8, 158.04) } }),
    turn: turn(3, 0),
  };
  const buy: EntryPlan = { signal: "BUY", entry: 154.57, stopLoss: 154.1, takeProfit1: 155.4, price: 154.57, atr: 0.45, mode: "Trend Day", direction: "Up" };

  it("lets the 9/14 1h BUY through the daily that still read Down, and writes the yield down", () => {
    const v = evaluateEntry({ ...buy, higherStructures: [{ tf: "4h", structure: st() }, dailyTurning] });
    expect(v.ok).toBe(true);
    expect(v.rejection).toBeNull();
    expect(v.structureConflict).toBeNull();
    expect(v.structureYielded).toEqual([{ tf: "1day", bias: "Down", score: 3 }]);
    expect(v.structureRead[1]).toEqual({ tf: "1day", bias: "Down", from: "break", turn: { up: 3, down: 0 }, turning: true });
  });

  it("does not yield below the threshold, nor on a fresh break whatever the oscillators say", () => {
    const weak = { ...dailyTurning, turn: turn(TURN_BLOCK - 1, 0) };
    expect(evaluateEntry({ ...buy, higherStructures: [weak] }).rejection).toBe("structure_conflict");
    const fresh: HigherStructure = {
      ...dailyTurning,
      structure: st({ lastBreak: { up: null, down: brk("low", "broken", FRESH_BREAK_BARS, 152.9) } }),
    };
    const v = evaluateEntry({ ...buy, higherStructures: [fresh] });
    expect(v.rejection).toBe("structure_conflict");
    expect(v.structureYielded).toEqual([]);
    expect(v.structureRead[0].turning).toBe(false);
  });

  it("a rung without a turn read never yields", () => {
    const { turn: _t, ...noTurn } = dailyTurning;
    expect(evaluateEntry({ ...buy, higherStructures: [noTurn] }).rejection).toBe("structure_conflict");
  });

  it("refuses the 9/15 daily SELL: the entry rung is turning up under it, before any geometry", () => {
    const v = evaluateEntry({
      ...base,
      entryStructure: { structure: dailyTurning.structure, turn: turn(3, 0) },
    });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("turn_conflict");
    expect(v.turnConflict).toEqual({ side: "Up", score: 3, block: TURN_BLOCK, facts: ["stale_break", "hist_run", "rsi_recovery"] });
    expect(v.riskReward).toBeNull();
    expect(v.stopAtr).toBeNull();
  });

  it("lets the 9/8 SELL through: a breakdown two bars old is the move still going", () => {
    const v = evaluateEntry({
      ...base,
      entryStructure: { structure: st({ lastBreak: { up: null, down: brk("low", "broken", 2, 152.9) } }), turn: turn(3, 0) },
    });
    expect(v.ok).toBe(true);
    expect(v.turnConflict).toBeNull();
  });

  it("is symmetric: a BUY into an entry rung turning down is refused the same way", () => {
    const v = evaluateEntry({
      ...buy,
      entryStructure: { structure: st({ lastBreak: { up: brk("high", "broken", 9), down: null } }), turn: turn(0, 3) },
    });
    expect(v.rejection).toBe("turn_conflict");
    expect(v.turnConflict).toMatchObject({ side: "Down", score: 3 });
    // and the same evidence does not touch a SELL
    expect(evaluateEntry({
      ...base,
      entryStructure: { structure: st({ lastBreak: { up: brk("high", "broken", 9), down: null } }), turn: turn(0, 3) },
    }).turnConflict).toBeNull();
  });

  it("the rungs above are asked first", () => {
    const v = evaluateEntry({
      ...base,
      higherStructures: [{ tf: "4h", structure: st({ lastBreak: { up: brk("high", "broken", 2, 155.64), down: null } }) }],
      entryStructure: { structure: dailyTurning.structure, turn: turn(3, 0) },
    });
    expect(v.rejection).toBe("structure_conflict");
    expect(v.turnConflict).toBeNull();
  });

  it("leaves a WAIT and a caller without an entry read alone", () => {
    const w = evaluateEntry({ ...base, signal: "WAIT", entry: null, stopLoss: null, takeProfit1: null, entryStructure: { structure: dailyTurning.structure, turn: turn(3, 0) } });
    expect(w.ok).toBe(true);
    expect(w.turnConflict).toBeNull();
    expect(w.structureYielded).toEqual([]);
    expect(evaluateEntry(base).turnConflict).toBeNull();
    expect(evaluateEntry({ ...base, entryStructure: { structure: dailyTurning.structure, turn: null } }).ok).toBe(true);
  });
});

describe("evaluateEntry runs the structure gate before the geometry", () => {
  const rally: HigherStructure[] = [
    { tf: "4h", structure: st({ lastBreak: { up: brk("high", "broken", 2, 155.64), down: null } }) },
    { tf: "1day", structure: st({ label: "downtrend", lastBreak: { up: brk("high", "broken", 3), down: brk("low", "broken", 12, 158.04) } }) },
  ];

  it("refuses the SELL into the rally that the record shows losing six times", () => {
    const v = evaluateEntry({ ...base, higherStructures: rally });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe("structure_conflict");
    expect(v.structureConflict).toMatchObject({ tf: "4h", bias: "Up", from: "break", level: 155.64 });
    expect(v.structureRead).toEqual([
      { tf: "4h", bias: "Up", from: "break", turn: null, turning: false },
      { tf: "1day", bias: "Up", from: "break", turn: null, turning: false },
    ]);
    // direction before geometry: nothing about the stop or target was measured
    expect(v.riskReward).toBeNull();
    expect(v.stopAtr).toBeNull();
    expect(v.entryType).toBeNull();
  });

  it("publishes the same plan when the rungs agree, and records what they said", () => {
    const falling: HigherStructure[] = rally.map((h) => ({
      tf: h.tf,
      structure: st({ lastBreak: { up: null, down: brk("low", "broken", 2, 152.9) } }),
    }));
    const v = evaluateEntry({ ...base, higherStructures: falling });
    expect(v.ok).toBe(true);
    expect(v.rejection).toBeNull();
    expect(v.structureConflict).toBeNull();
    expect(v.structureRead.map((r) => r.bias)).toEqual(["Down", "Down"]);
  });

  it("leaves a WAIT alone but still writes down what the rungs said", () => {
    const v = evaluateEntry({ ...base, signal: "WAIT", entry: null, stopLoss: null, takeProfit1: null, higherStructures: rally });
    expect(v.ok).toBe(true);
    expect(v.rejection).toBeNull();
    expect(v.structureConflict).toBeNull();
    expect(v.structureRead).toHaveLength(2);
  });

  it("is a no-op for a caller that passes no rungs", () => {
    const v = evaluateEntry(base);
    expect(v.ok).toBe(true);
    expect(v.structureRead).toEqual([]);
    expect(v.structureConflict).toBeNull();
  });
});

describe("the gate is wired through, in every place it has to be", () => {
  const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");
  const locale = readFileSync("supabase/functions/analyze/locale.ts", "utf8");

  // #104: the structure gate is off in analyze — the signal is the RSI/SAR
  // rule's, and the swing structure is not RSI or SAR. The gate itself is
  // unchanged (the tests above still hold it), analyze just hands it no rungs,
  // and the row still carries the fields so the record reads as before.
  it("analyze hands the gate no higher rungs, and still stores the gate's fields", () => {
    expect(analyze).toContain("higherStructures: [],");
    expect(analyze).not.toContain("readHigherStructures(");
    expect(analyze).toContain("structure_read: entryVerdict.structureRead,");
    expect(analyze).toContain("structure_conflict: entryVerdict.structureConflict,");
    expect(analyze).toContain("structureConflict: entryVerdict.structureConflict,");
  });

  // #104: likewise the turn gate. The turn evidence is still computed and
  // stored (context.turn); it no longer refuses anything or reaches the prompt.
  it("analyze no longer hands the gate the turn, and still records it (#96, #104)", () => {
    expect(analyze).toContain("entryStructure: null,");
    expect(analyze).not.toContain("turnForGate(");
    expect(analyze).not.toContain("turnLines(");
    expect(analyze).toContain("turn_conflict: entryVerdict.turnConflict,");
    expect(analyze).toContain("structure_yielded: entryVerdict.structureYielded,");
    expect(analyze).toContain("turn: turns.map((t, i) => compactTurn(timeframes[i], t, decimals)),");
  });

  it("the prompt states the RSI/SAR rule and no longer asks for a counter-case (#96, #104)", () => {
    const prompt = analyze.slice(analyze.indexOf("const SYSTEM_PROMPT"), analyze.indexOf("const RESPONSE_SCHEMA"));
    expect(prompt).not.toContain("転換の証拠");
    expect(prompt).toContain("RSI が30以下から30を上に戻した確定足で、パラボリックSARが価格の下にあるとき");
    expect(prompt).toContain("RSI が70以上から70を下に戻した確定足で、パラボリックSARが価格の上にあるとき");
    expect(prompt).toContain("counter_case は書かなくてよい");
    const schema = analyze.slice(analyze.indexOf("const RESPONSE_SCHEMA"), analyze.indexOf("const { conditional_wait"));
    expect(schema).toContain("counter_case: {");
    // optional in the schema (the replay harnesses' missing-key check), and
    // therefore required by the prompt instead
    expect(schema).not.toMatch(/required: \[[^\]]*"counter_case"/);
  });

  it("both languages have a sentence for the turn refusal that carries the count", () => {
    const cases = locale.match(/case "turn_conflict":/g) ?? [];
    expect(cases).toHaveLength(2);
    expect(locale).toContain("turnConflict?:");
  });

  it("the prompt says the higher timeframes are reference only and the server decides", () => {
    const prompt = analyze.slice(analyze.indexOf("const SYSTEM_PROMPT"), analyze.indexOf("const RESPONSE_SCHEMA"));
    expect(prompt).not.toContain("終値ブレイク");
    expect(prompt).toContain("上位足の RSI と SAR は参考として触れてよいが、signal の判断には使わない");
    expect(prompt).toContain("signal はこの判定で決まり、あなたが変えることはできません");
    expect(analyze).not.toContain("上位足の方向(サーバ判定");
  });

  it("both languages have a sentence for the refusal that names the rung", () => {
    const cases = locale.match(/case "structure_conflict":/g) ?? [];
    expect(cases).toHaveLength(2);
    expect(locale).toContain("structureConflict?:");
  });
});
