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
// And above THIS it is not a plan, it is a lottery ticket.
//
// A floor with no ceiling is an instruction to reverse-engineer the target:
// measured over the first eight plans every single risk/reward landed between
// 1.48 and 1.69, just above the floor, while the stop sat between 0.72 and
// 1.03 ATR — the model was not asking where the idea would be wrong, it was
// asking what passes. A ceiling closes the other end, so a target cannot be
// pushed out of reach to make the ratio work.
export const MAX_RISK_REWARD = 6;
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
  // the reward is so far out that the ratio stopped meaning anything: a
  // target placed where it will not be reached inside the plan's life, so
  // the trade expires instead of resolving
  | "target_out_of_reach"
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

  // A target far enough out to make any stop look good is not a target. This
  // fires on the same side as poor_rr and is reported apart from it, because
  // the two say opposite things about the plan.
  if (rr > MAX_RISK_REWARD) {
    return { ...out, rejection: "target_out_of_reach" };
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

// The trade a WAIT is standing aside from — fixed HERE, at the moment of the
// call, and stored on the row.
//
// The first scorer walked a long AND a short from the decision price and
// called the WAIT a miss if either paid. Nothing at the moment of the call
// chose the side; the outcome did. A market that wanders half an ATR in both
// directions — which is most markets, over enough bars — scores as a missed
// trade no matter what was actually knowable, and that verdict is the app's
// only evidence of over-caution. So it was measuring the market's range and
// reporting it as the analyst's fault.
//
// One direction, decided now, on information that exists now. Where the
// direction cannot be read from what was said at the time, there is nothing
// to score, and the honest answer is that no call was recorded — not a
// coin-flip dressed as a verdict.
export type WaitDirectionSource =
  // the model asked for this trade and the server refused it
  | "proposed_signal"
  // the model called the market's direction while declining to trade it
  | "declared_direction"
  // neither, but the indicators had it in a trend
  | "regime"
  // nothing at the time named a side
  | "none";

export interface WaitPlan {
  direction: "BUY" | "SELL" | null;
  direction_source: WaitDirectionSource;
  entry: number | null;
  stop: number | null;
  target: number | null;
  risk: number | null;
  reward: number | null;
  atr: number | null;
  // The two-sided quote behind the mid, when the feed gave one. The scorer
  // does not charge it yet; recorded so it can be charged without asking the
  // past for data it never stored.
  spread: number | null;
  contract: string;
  decided_at: string;
  // Which scoring rule this plan was built for. A verdict from one rule and a
  // verdict from another are not the same measurement and must not be
  // averaged into one miss rate.
  scorer: number;
}

export const WAIT_SCORER = 2;

const directionOf = (input: {
  proposedSignal: Signal;
  declaredDirection: string | null;
  regime: Regime;
  regimeDirection: TrendDirection | null;
}): { direction: "BUY" | "SELL" | null; source: WaitDirectionSource } => {
  if (input.proposedSignal === "BUY" || input.proposedSignal === "SELL") {
    return { direction: input.proposedSignal, source: "proposed_signal" };
  }
  const declared = (input.declaredDirection ?? "").trim().toLowerCase();
  if (declared === "up") return { direction: "BUY", source: "declared_direction" };
  if (declared === "down") return { direction: "SELL", source: "declared_direction" };
  if (input.regime === "trend" && input.regimeDirection !== null) {
    return { direction: input.regimeDirection === "Up" ? "BUY" : "SELL", source: "regime" };
  }
  return { direction: null, source: "none" };
};

export const waitPlanFor = (input: {
  proposedSignal: Signal;
  declaredDirection: string | null;
  regime: Regime;
  regimeDirection: TrendDirection | null;
  entry: number | null;
  atr: number | null;
  quote: { bid: number; ask: number } | null;
  decimals: number;
  contract: string;
  decidedAt: string;
}): WaitPlan => {
  const { direction, source } = directionOf(input);
  const spread = input.quote && Number.isFinite(input.quote.ask) && Number.isFinite(input.quote.bid)
    ? Number((input.quote.ask - input.quote.bid).toFixed(input.decimals))
    : null;
  const base: WaitPlan = {
    direction,
    direction_source: source,
    entry: null,
    stop: null,
    target: null,
    risk: null,
    reward: null,
    atr: isFinitePositive(input.atr) ? input.atr : null,
    spread,
    contract: input.contract,
    decided_at: input.decidedAt,
    scorer: WAIT_SCORER,
  };
  if (direction === null || !isFinitePositive(input.entry) || !isFinitePositive(input.atr)) return base;

  // The same floors the gate itself applies: the tightest stop it permits and
  // the nearest target that still clears its risk/reward floor. A WAIT is
  // measured against the least the app would have demanded of a trade, not
  // against a threshold invented for the purpose.
  const risk = MIN_STOP_ATR * input.atr;
  const reward = MIN_RISK_REWARD * risk;
  const sign = direction === "BUY" ? 1 : -1;
  const r = (v: number) => Number(v.toFixed(input.decimals));
  return {
    ...base,
    entry: r(input.entry),
    stop: r(input.entry - sign * risk),
    target: r(input.entry + sign * reward),
    risk: r(risk),
    reward: r(reward),
  };
};
