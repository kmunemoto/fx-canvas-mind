// Whether a trade plan can actually be entered.
//
// The first version let the model put the entry wherever it liked. On a
// trending day it kept asking for a pullback that never came: of the eight
// BUY/SELL plans the app produced, five were never filled — and every one of
// those five carried the model's own tag "Trend Day" or "Breakout" in the
// direction of the signal. A mean-reversion entry bolted onto a
// trend-following call is not a plan, it is a wish.
//
// A plan that never fills is worth less than a wrong one: a wrong plan at
// least teaches something. So an unreachable entry is first repaired (moved
// to the market price, if the rest of the plan still pays at that price) and
// otherwise refused rather than published. The refusal is recorded, and the
// refused plan is tracked in the shadows, so the gate itself can be checked
// against what the market then did.
//
// The regime the rules key on is taken from two places: what the model
// declared (market_context_detail.mode) and what the indicators say (ADX and
// the moving-average stack). The indicators calling it a trend in the
// signal's direction is enough to forbid waiting for a pullback; the model
// calling it one is enough only while the indicators do not call it a range.
//
// Deno-free on purpose: src/test/entry.test.ts imports this file directly.

export type Signal = "BUY" | "SELL" | "WAIT";
export type EntryType = "market" | "limit" | "stop";
export type Regime = "trend" | "range" | "unclear";
export type TrendDirection = "Up" | "Down";

// Regimes (as the model names them) where price is expected to keep going,
// so waiting for a deep retrace means not trading at all
export const MOMENTUM_MODES = ["trend day", "breakout"];

// A pullback (limit) entry further than this many ATRs from the market does
// not get filled
export const MAX_LIMIT_ATR = 0.5;
// A breakout (stop) entry may sit further out — the move brings price to it —
// but past this it is a late entry, not a breakout
export const MAX_STOP_ATR = 1.0;
// "At market" in practice: inside the spread and ordinary jitter
export const MARKET_TOLERANCE_ATR = 0.15;
// A stop closer than this is inside the bar-to-bar noise and gets hit by it
export const MIN_STOP_ATR = 0.4;
// Below this, the trade actually available is not worth taking
export const MIN_RISK_REWARD = 1.2;
// Used when the entry timeframe produced no ATR (too few candles)
export const FALLBACK_ATR_RATIO = 0.0015;
// ADX above which the indicators call it a trend; below which a range
export const TREND_ADX = 25;
export const RANGE_ADX = 20;

export interface RegimeInputs {
  adx: number | null;
  sma20: number | null;
  sma50: number | null;
}

export interface EntryPlan {
  signal: Signal;
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  price: number; // market price at the time of the analysis
  atr: number | null; // entry-timeframe ATR
  mode: string | null; // market_context_detail.mode
  direction: string | null; // market_context_detail.direction
  // entry-timeframe indicators, for a regime read independent of the model
  indicators?: RegimeInputs | null;
}

export type Rejection =
  // the entry sits beyond the distance bound for its order type
  | "too_far"
  // a momentum regime, but the plan waits for a retrace against the move
  | "should_be_market"
  // the stop sits inside the noise around the entry
  | "stop_too_tight"
  // reachable entry, but the reward does not pay for the risk
  | "poor_rr"
  // stop loss or target on the wrong side of the entry
  | "incoherent";

export interface EntryVerdict {
  ok: boolean;
  rejection: Rejection | null;
  // The entry was moved to the market price because the original could not
  // be filled and the rest of the plan still pays at the market
  repaired: boolean;
  // The entry was inside the "at market" band but not exactly at the market,
  // so it was pulled onto it. The tracker's own definition of a market order
  // is far narrower than this band (FILL_TOLERANCE, ~3 pips), so an entry
  // left a few pips away would be judged as a limit that has to be touched —
  // the very failure this module exists to prevent.
  snapped: boolean;
  // When the plan was refused: why moving the entry to the market did not
  // save it either (null when no repair was attempted)
  repairRejection: Rejection | null;
  // The entry to publish (the market price when repaired)
  entry: number | null;
  originalEntry: number | null;
  entryType: EntryType | null;
  riskReward: number | null;
  distanceAtr: number | null;
  stopAtr: number | null;
  // What the indicators said, next to what the model declared
  regime: Regime;
  regimeDirection: TrendDirection | null;
  // The no-pullback rule applied: a trend in the signal's direction by
  // either reading
  momentum: boolean;
  // The entry was inside the market band, but pulling it onto the market
  // would have broken the plan (this is why), so it stands as written
  snapDeclined: Rejection | null;
}

const isFinitePositive = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

const round2 = (v: number) => Number(v.toFixed(2));

// The ATR the distance rules are measured in. Without one, fall back to a
// fraction of price so the rules still bite rather than silently passing.
export const entryScale = (price: number, atr: number | null): number =>
  isFinitePositive(atr) ? atr : price * FALLBACK_ATR_RATIO;

// "Trend Day", "trend_day", " TREND DAY " all mean the same thing
export const normalizeMode = (mode: string | null): string | null =>
  typeof mode === "string" ? mode.trim().toLowerCase().replace(/[_\s]+/g, " ") || null : null;

export const isMomentumMode = (mode: string | null): boolean => {
  const m = normalizeMode(mode);
  return m !== null && MOMENTUM_MODES.includes(m);
};

// The signal points the same way the market is said to be going
export const alignedWithTrend = (signal: Signal, direction: string | null): boolean => {
  const d = typeof direction === "string" ? direction.trim().toLowerCase() : "";
  return (signal === "BUY" && d === "up") || (signal === "SELL" && d === "down");
};

// The regime from the numbers alone: a strong ADX with price and the moving
// averages stacked one way is a trend that way; a weak ADX is a range;
// anything else is not called.
export const deriveRegime = (
  price: number,
  ind: RegimeInputs | null | undefined,
): { regime: Regime; direction: TrendDirection | null } => {
  if (!ind || ind.adx === null || !Number.isFinite(ind.adx)) return { regime: "unclear", direction: null };
  if (ind.adx < RANGE_ADX) return { regime: "range", direction: null };
  const { sma20, sma50 } = ind;
  if (ind.adx >= TREND_ADX && sma20 !== null && sma50 !== null && Number.isFinite(sma20) && Number.isFinite(sma50)) {
    if (price > sma20 && sma20 > sma50) return { regime: "trend", direction: "Up" };
    if (price < sma20 && sma20 < sma50) return { regime: "trend", direction: "Down" };
  }
  return { regime: "unclear", direction: null };
};

// Derived from the numbers, not from what the model called it: a limit sits
// against the immediate move (buy lower / sell higher), a stop sits with it.
export const inferEntryType = (
  signal: Signal,
  entry: number,
  price: number,
  scale: number,
): EntryType => {
  if (Math.abs(entry - price) <= MARKET_TOLERANCE_ATR * scale) return "market";
  if (signal === "BUY") return entry < price ? "limit" : "stop";
  return entry > price ? "limit" : "stop";
};

const coherent = (signal: Signal, entry: number, stopLoss: number, takeProfit1: number) =>
  signal === "BUY"
    ? stopLoss < entry && takeProfit1 > entry
    : stopLoss > entry && takeProfit1 < entry;

interface Check {
  rejection: Rejection | null;
  entryType: EntryType | null;
  riskReward: number | null;
  distanceAtr: number | null;
  stopAtr: number | null;
}

// One plan at one entry price. Comparisons are on the raw numbers; the
// reported figures are rounded for the record.
const check = (
  plan: EntryPlan,
  entry: number,
  scale: number,
  momentum: boolean,
): Check => {
  const { signal, price } = plan;
  const stopLoss = plan.stopLoss as number;
  const takeProfit1 = plan.takeProfit1 as number;
  const none: Check = { rejection: null, entryType: null, riskReward: null, distanceAtr: null, stopAtr: null };

  if (!coherent(signal, entry, stopLoss, takeProfit1)) {
    return { ...none, rejection: "incoherent" };
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit1 - entry);
  const rr = risk > 0 ? reward / risk : null;
  const distance = Math.abs(entry - price) / scale;
  const stop = risk / scale;
  const entryType = inferEntryType(signal, entry, price, scale);
  const out: Check = {
    rejection: null,
    entryType,
    riskReward: rr === null ? null : round2(rr),
    distanceAtr: round2(distance),
    stopAtr: round2(stop),
  };

  const bound = entryType === "stop" ? MAX_STOP_ATR : MAX_LIMIT_ATR;
  if (entryType !== "market" && distance > bound) {
    return { ...out, rejection: "too_far" };
  }

  // The defect this module exists for: waiting for a bounce that a trending
  // market will not give. A stop entry in the trend's own direction is fine —
  // it fills if the move continues.
  if (entryType === "limit" && momentum) {
    return { ...out, rejection: "should_be_market" };
  }

  if (stop < MIN_STOP_ATR) {
    return { ...out, rejection: "stop_too_tight" };
  }

  if (rr === null || rr < MIN_RISK_REWARD) {
    return { ...out, rejection: "poor_rr" };
  }

  return out;
};

export const evaluateEntry = (plan: EntryPlan): EntryVerdict => {
  const { signal, entry, stopLoss, takeProfit1, price } = plan;
  const derived = deriveRegime(price, plan.indicators);
  const base = {
    repaired: false,
    snapped: false,
    snapDeclined: null as Rejection | null,
    repairRejection: null,
    originalEntry: entry,
    regime: derived.regime,
    regimeDirection: derived.direction,
  };

  // Nothing to enter, nothing to check
  if (signal === "WAIT") {
    return {
      ...base,
      ok: true,
      rejection: null,
      entry,
      entryType: null,
      riskReward: null,
      distanceAtr: null,
      stopAtr: null,
      momentum: false,
    };
  }

  // The indicators calling it a trend in the signal's direction is enough;
  // the model calling it one counts only while the indicators do not say
  // range. A "Trend Day" declared on an ADX under 20 is a range being
  // chased, and forcing a market entry there is the mistake this rule was
  // meant to prevent, not a cure for it.
  const momentum =
    (derived.regime === "trend" && alignedWithTrend(signal, derived.direction)) ||
    (derived.regime !== "range" && isMomentumMode(plan.mode) && alignedWithTrend(signal, plan.direction));

  if (
    entry === null || stopLoss === null || takeProfit1 === null ||
    !Number.isFinite(entry) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit1) ||
    !isFinitePositive(price)
  ) {
    return {
      ...base,
      ok: false,
      rejection: "incoherent",
      entry,
      entryType: null,
      riskReward: null,
      distanceAtr: null,
      stopAtr: null,
      momentum,
    };
  }

  const scale = entryScale(price, plan.atr);
  const first = check(plan, entry, scale, momentum);
  if (first.rejection === null) {
    // Inside the market band: publish it at the market rather than a few
    // pips away, so the plan the tracker judges is the plan this checker
    // approved. Re-checked at the snapped price, because moving the entry
    // moves the risk and the reward with it.
    if (first.entryType === "market" && entry !== price) {
      const snapped = check(plan, price, scale, momentum);
      if (snapped.rejection === null) {
        return { ...base, ok: true, snapped: true, entry: price, momentum, ...snapped };
      }
      // Moving those few pips would break a plan that is sound where the
      // model put it (the risk and the reward both shift). Publish it as
      // written rather than refusing a plan the gate already approved.
      return { ...base, ok: true, entry, momentum, ...first, snapDeclined: snapped.rejection };
    }
    return { ...base, ok: true, entry, momentum, ...first };
  }

  // A pullback the market will not give: try the same plan entered now. The
  // stop and the target stay where the model put them, so the trade pays
  // less; if it still pays enough it is published that way and said so.
  if (first.entryType === "limit" && (first.rejection === "too_far" || first.rejection === "should_be_market")) {
    const repaired = check(plan, price, scale, momentum);
    if (repaired.rejection === null) {
      return { ...base, ok: true, repaired: true, snapped: true, entry: price, momentum, ...repaired };
    }
    return { ...base, ok: false, entry, momentum, ...first, repairRejection: repaired.rejection };
  }

  return { ...base, ok: false, entry, momentum, ...first };
};
