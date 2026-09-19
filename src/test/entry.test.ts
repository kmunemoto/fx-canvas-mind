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

describe("a floor with no ceiling is an instruction to reverse-engineer the target", () => {
  it("refuses a target placed far enough out to make any stop look good", () => {
    // Measured over the first eight plans: every risk/reward landed between
    // 1.48 and 1.69, just above the floor, while stops sat at 0.72-1.03 ATR.
    // The model was solving "what passes", not "where is this idea wrong".
    // Closing the other end stops the target being pushed out of reach.
    const v = evaluateEntry({
      signal: "BUY",
      entry: 150,
      stopLoss: 149.5,      // risk 0.5
      takeProfit1: 155,     // reward 5.0 -> RR 10
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
      stopLoss: 149.5,
      takeProfit1: 151,   // RR 2
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
      { tf: "4h", bias: "Down", from: "break" },
      { tf: "1day", bias: "Up", from: "break" },
      { tf: "1week", bias: null, from: null },
    ]);
    expect(readHigherStructures(null)).toEqual([]);
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
      { tf: "4h", bias: "Up", from: "break" },
      { tf: "1day", bias: "Up", from: "break" },
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

  it("analyze hands the gate the higher rungs and stores what it read", () => {
    expect(analyze).toContain("higherStructures: higherStructures,");
    expect(analyze).toContain("structure_read: entryVerdict.structureRead,");
    expect(analyze).toContain("structure_conflict: entryVerdict.structureConflict,");
    expect(analyze).toContain("structureConflict: entryVerdict.structureConflict,");
    // the same objects go to the prompt as to the gate
    expect(analyze).toContain("readHigherStructures(higherStructures)");
  });

  it("the prompt says which line decides the higher timeframe's direction, and that the server enforces it", () => {
    const prompt = analyze.slice(analyze.indexOf("const SYSTEM_PROMPT"), analyze.indexOf("const RESPONSE_SCHEMA"));
    expect(prompt).toContain("終値ブレイク");
    expect(prompt).toContain("サーバーが公開しない");
    expect(analyze).toContain("上位足の方向(サーバ判定");
  });

  it("both languages have a sentence for the refusal that names the rung", () => {
    const cases = locale.match(/case "structure_conflict":/g) ?? [];
    expect(cases).toHaveLength(2);
    expect(locale).toContain("structureConflict?:");
  });
});
