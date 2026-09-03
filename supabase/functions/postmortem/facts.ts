// The facts a post-mortem is built on.
//
// A settled plan is compared with what price actually did — during the plan,
// and for a while after it was settled — and with what the same plan would
// have done entered differently: at the market instead of on a pullback,
// with a stop 1.5× or 2× as wide, with a target half as far. Those
// counterfactuals are run through the same judge the real plan was, so
// "the stop was too tight" means "the tracker would have called it a win
// with a wider stop", not an opinion.
//
// Everything here is deterministic; the model that writes the diagnosis is
// given these numbers and asked not to invent anything beyond them.
//
// Deno-free on purpose: src/test/postmortem.test.ts imports this file
// directly.

import type { Candle } from "../analyze/indicators.ts";
import { MIN_RISK_REWARD, MIN_STOP_ATR, isMomentumMode, normalizeMode } from "../analyze/entry.ts";
import {
  FILL_TOLERANCE,
  INTERVAL_MS,
  MAX_REFINE_ATTEMPTS,
  emptyEvaluation,
  judgePlan,
  parseCandleTime,
  toIso,
  type Evaluation,
  type OpenRow,
  type Resolution,
} from "../track-outcomes/evaluate.ts";

export type Cause =
  // the call itself was wrong: price went the other way
  | "direction_wrong"
  // right direction, but the stop sat inside the noise and was hit first
  | "stop_too_tight"
  // right direction, but the entry waited for a pullback that never came
  | "entry_too_far"
  // right direction, but chased at the market into an immediate retrace that
  // took the stop; a pullback entry would have paid
  | "entry_too_early"
  // filled and moved the right way, but the target was out of reach
  | "target_too_far"
  // a range traded as a trend, or the reverse
  | "regime_misread"
  // an event bar blew through the plan
  | "news_shock"
  // levels contradicted each other; nothing could be judged
  | "plan_incoherent"
  // won as planned
  | "good_call"
  // won, but the process was unsafe (deep adverse excursion, wrong reasons)
  | "lucky_win"
  // not enough evidence to say
  | "inconclusive";

export const CAUSES: readonly Cause[] = [
  "direction_wrong",
  "stop_too_tight",
  "entry_too_far",
  "entry_too_early",
  "target_too_far",
  "regime_misread",
  "news_shock",
  "plan_incoherent",
  "good_call",
  "lucky_win",
  "inconclusive",
];

export const isCause = (v: unknown): v is Cause =>
  typeof v === "string" && (CAUSES as readonly string[]).includes(v);

const MIN = 60_000;
const HOUR = 60 * MIN;

// Wall-clock wait after a settlement before the post-mortem runs, so "what
// happened next" exists to look at
export const AFTER_WAIT_MS: Record<string, number> = {
  "15min": HOUR,
  "1h": 2 * HOUR,
  "4h": 4 * HOUR,
  "1day": 8 * HOUR,
};

// Bars of the plan's own timeframe examined after the settlement
export const AFTER_BARS: Record<string, number> = {
  "15min": 24,
  "1h": 24,
  "4h": 12,
  "1day": 5,
};

// Below this many bars of aftermath a diagnosis rests on very little, and is
// revisited once the full window exists
export const MIN_AFTER_BARS = 8;

// A bar this many times the median range is an event, not a move
export const ABNORMAL_RANGE_RATIO = 3;
// MAE this close to the stop makes a win a lucky one
export const LUCKY_MAE_R = 0.8;
// A move of at least this many R without a fill is a missed trade
export const MISSED_MOVE_R = 1;
// The pullback the "entered later" counterfactual waits for, in R
export const PULLBACK_R = 0.5;
// An adverse move of this much inside the first bars after a market fill
// says the entry chased an exhausted move
export const EARLY_ADVERSE_R = 0.5;
export const EARLY_BARS = 3;

export interface PostmortemRow extends OpenRow {
  outcome: string;
  closed_at: string | null;
}

export const afterWindowMs = (interval: string): number =>
  (AFTER_BARS[interval] ?? 12) * (INTERVAL_MS[interval] ?? HOUR);

export const isPostmortemDue = (row: { interval: string; closed_at: string | null }, nowMs: number): boolean => {
  const closed = row.closed_at ? Date.parse(row.closed_at) : NaN;
  if (!Number.isFinite(closed)) return true;
  return nowMs - closed >= (AFTER_WAIT_MS[row.interval] ?? 2 * HOUR);
};

export interface Touch {
  at: string;
  bars: number;
}

export interface CfResult {
  resolution: Resolution | null;
  reason: string | null;
  mfe_r: number | null;
  mae_r: number | null;
  // Reward-to-risk of the variant itself (TP1 against its own stop), and
  // whether the entry gate would have let it through. A counterfactual that
  // "wins" with a 0.6 risk/reward is not a plan the analyzer may publish, so
  // it is not evidence for "should have entered at the market".
  rr: number | null;
  viable: boolean;
  // Which of the gate's tests the variant fails, when it is not viable
  gate: "ok" | "poor_rr" | "stop_too_tight";
}

export interface PostmortemFacts {
  version: 2;
  eval_interval: string;
  bars_after_settlement: number;
  risk: number;
  reward: number;
  rr: number | null;
  order_type: string;
  hours_to_fill: number | null;
  hours_to_settle: number | null;
  // Market price the plan was made at (the tracker's reference)
  reference: number | null;
  // Largest move for / against the signal from the reference, over the
  // plan's life and the after-window, in multiples of the planned risk
  from_signal: { max_favorable_r: number | null; max_adverse_r: number | null };
  after: {
    // Which level price reached first after the settlement
    first_touch: "tp1" | "sl" | "both" | null;
    reached_tp1: Touch | null;
    reached_sl: Touch | null;
    // How far past the stop price kept going (loss), in R
    beyond_sl_r: number | null;
    returned_to_entry: boolean | null;
  };
  abnormal_bar: { at: string; range_ratio: number } | null;
  // Largest adverse move in the first bars after the fill, in R: a chase
  // into a retrace shows up here before it shows up anywhere else
  early_adverse_r: number | null;
  counterfactual: {
    // Unfilled plans: the same stop and target entered at the market
    market_entry: CfResult | null;
    // Unfilled plans: entered at the market with the stop moved so the risk
    // width is what the plan had (the target stays), which is what a market
    // version of the plan would actually have looked like
    market_entry_same_risk: CfResult | null;
    stop_x1_5: CfResult | null;
    stop_x2: CfResult | null;
    tp_half: CfResult | null;
    // Filled plans: entered on a pullback of PULLBACK_R against the signal,
    // with the stop moved the same way (same risk width, better price)
    limit_pullback: CfResult | null;
  };
  // The declared regime against the ADX at signal time, when known
  regime: { declared: string | null; adx: number | null; conflict: boolean } | null;
  // Deterministic pre-classification; the model picks among these first
  hints: Cause[];
  notes: string[];
}

interface Timed {
  c: Candle;
  t: number;
}

const round2 = (v: number) => Number(v.toFixed(2));

const timeline = (candles: Candle[], nowMs: number): Timed[] =>
  candles
    .map((c) => ({ c, t: parseCandleTime(c.datetime) }))
    .filter((x) => Number.isFinite(x.t) && x.t <= nowMs + MIN)
    .sort((a, b) => a.t - b.t);

const hitsTp = (signal: "BUY" | "SELL", c: Candle, tp: number) => (signal === "BUY" ? c.high >= tp : c.low <= tp);
const hitsSl = (signal: "BUY" | "SELL", c: Candle, sl: number) => (signal === "BUY" ? c.low <= sl : c.high >= sl);
const touches = (c: Candle, level: number) => c.low <= level && c.high >= level;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const hoursBetween = (fromIso: string | null, toIso_: string | null): number | null => {
  if (!fromIso || !toIso_) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso_);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return round2((b - a) / HOUR);
};

// The same judge the real plan went through, on a variant of the plan. No
// finer bars are available here, so a bar that touches both levels settles
// as ambiguous instead of being retried.
const simulate = async (
  row: PostmortemRow,
  variant: Partial<Pick<OpenRow, "entry_point" | "stop_loss" | "take_profit_1" | "take_profit_2" | "take_profit_3" | "price_at_signal">>,
  candles: Candle[],
  evalInterval: string,
  nowMs: number,
  atr: number | null,
): Promise<CfResult> => {
  const base: OpenRow = {
    id: `${row.id}:cf`,
    pair: row.pair,
    interval: row.interval,
    signal: row.signal,
    entry_point: row.entry_point,
    stop_loss: row.stop_loss,
    take_profit_1: row.take_profit_1,
    take_profit_2: row.take_profit_2,
    take_profit_3: row.take_profit_3,
    created_at: row.created_at,
    price_at_signal: row.price_at_signal,
    evaluation: null,
    ...variant,
  };
  const prior: Evaluation = { ...emptyEvaluation(base, evalInterval, nowMs), refine_attempts: MAX_REFINE_ATTEMPTS - 1 };
  const j = await judgePlan({ ...base, evaluation: prior }, candles, evalInterval, nowMs, async () => null);
  const vRisk = Math.abs(base.entry_point - base.stop_loss);
  const vReward = Math.abs(base.take_profit_1 - base.entry_point);
  const rr = vRisk > 0 ? round2(vReward / vRisk) : null;
  // The gate's own tests (entry.ts), on the variant: enough reward for the
  // risk, and a stop outside the noise when the ATR is known
  const stopOk = atr === null || !Number.isFinite(atr) || atr <= 0 || vRisk / atr >= MIN_STOP_ATR;
  const rrOk = rr !== null && rr >= MIN_RISK_REWARD;
  return {
    resolution: j.resolution,
    reason: j.evaluation.reason,
    mfe_r: j.evaluation.mfe_r,
    mae_r: j.evaluation.mae_r,
    rr,
    viable: rrOk && stopOk,
    gate: !rrOk ? "poor_rr" : !stopOk ? "stop_too_tight" : "ok",
  };
};

// Why a variant would not be published, for the notes
const gateReason = (r: CfResult | null, atr: number | null): string => {
  if (!r) return "n/a";
  if (r.gate === "poor_rr") return `rr ${r.rr ?? "?"} below ${MIN_RISK_REWARD}`;
  if (r.gate === "stop_too_tight") return `stop under ${MIN_STOP_ATR} ATR${atr !== null ? ` (ATR ${atr})` : ""}`;
  return "passes";
};

export interface FactsContext {
  // What the model declared and what the indicators said at signal time
  declaredMode?: string | null;
  adx?: number | null;
  atr?: number | null;
}

export const computeFacts = async (
  row: PostmortemRow,
  candles: Candle[],
  evalInterval: string,
  nowMs: number,
  ctx: FactsContext = {},
): Promise<PostmortemFacts> => {
  const ev = row.evaluation;
  const signal = row.signal;
  const createdMs = Date.parse(row.created_at);
  const resolvedIso = ev?.resolved_at ?? row.closed_at ?? null;
  const resolvedMs = resolvedIso ? Date.parse(resolvedIso) : NaN;
  const windowMs = afterWindowMs(row.interval);
  const notes: string[] = [];

  const risk = Math.abs(row.entry_point - row.stop_loss);
  const reward = Math.abs(row.take_profit_1 - row.entry_point);
  const rr = risk > 0 ? round2(reward / risk) : null;
  const toR = (v: number | null) => (v === null || risk <= 0 ? null : round2(v / risk));

  const series = timeline(candles, nowMs);
  const post = series.filter((x) => x.t >= createdMs);
  const signalBar = series.filter((x) => x.t < createdMs).pop() ?? null;
  const reference = row.price_at_signal ?? signalBar?.c.close ?? (post.length > 0 ? post[0].c.open : null);

  // Life of the plan plus the after-window, for the "what did the market do"
  // measures
  const horizonMs = Number.isFinite(resolvedMs) ? resolvedMs + windowMs : Infinity;
  const life = post.filter((x) => x.t < horizonMs);

  let maxFav: number | null = null;
  let maxAdv: number | null = null;
  if (reference !== null && life.length > 0) {
    maxFav = 0;
    maxAdv = 0;
    for (const { c } of life) {
      maxFav = Math.max(maxFav, signal === "BUY" ? c.high - reference : reference - c.low);
      maxAdv = Math.max(maxAdv, signal === "BUY" ? reference - c.low : c.high - reference);
    }
  }

  // After the settlement
  const after = Number.isFinite(resolvedMs) ? post.filter((x) => x.t > resolvedMs && x.t < resolvedMs + windowMs) : [];
  let reachedTp1: Touch | null = null;
  let reachedSl: Touch | null = null;
  let beyondSl = 0;
  let returnedToEntry = false;
  after.forEach(({ c, t }, i) => {
    if (reachedTp1 === null && hitsTp(signal, c, row.take_profit_1)) reachedTp1 = { at: toIso(t), bars: i + 1 };
    if (reachedSl === null && hitsSl(signal, c, row.stop_loss)) reachedSl = { at: toIso(t), bars: i + 1 };
    beyondSl = Math.max(beyondSl, signal === "BUY" ? row.stop_loss - c.low : c.high - row.stop_loss);
    if (touches(c, row.entry_point)) returnedToEntry = true;
  });
  const tp1Touch = reachedTp1 as Touch | null;
  const slTouch = reachedSl as Touch | null;
  const firstTouch: PostmortemFacts["after"]["first_touch"] =
    tp1Touch && slTouch
      ? tp1Touch.bars === slTouch.bars ? "both" : tp1Touch.bars < slTouch.bars ? "tp1" : "sl"
      : tp1Touch ? "tp1" : slTouch ? "sl" : null;
  if (after.length === 0) notes.push("no bars after the settlement yet");

  // An event bar: one range far outside the others during the plan
  const during = Number.isFinite(resolvedMs) ? post.filter((x) => x.t <= resolvedMs) : post;
  const ranges = during.map((x) => x.c.high - x.c.low);
  const med = median(ranges);
  let abnormal: PostmortemFacts["abnormal_bar"] = null;
  if (med !== null && med > 0) {
    let best = { at: "", ratio: 0 };
    during.forEach((x, i) => {
      const ratio = ranges[i] / med;
      if (ratio > best.ratio) best = { at: toIso(x.t), ratio };
    });
    if (best.ratio >= ABNORMAL_RANGE_RATIO) abnormal = { at: best.at, range_ratio: round2(best.ratio) };
  }

  // The first bars in the trade: did price turn on the entry at once? Only
  // while the trade was open, and not for stop entries, whose fill bar is
  // mostly the approach to the entry rather than a move against it.
  const filledMs = typeof ev?.filled_at === "string" ? Date.parse(ev.filled_at) : NaN;
  const orderType = ev?.order_type ?? "unknown";
  let earlyAdverseR: number | null = null;
  if (Number.isFinite(filledMs) && risk > 0 && (orderType === "market" || orderType === "limit")) {
    const barMs = INTERVAL_MS[evalInterval] ?? HOUR;
    const early = post
      .filter((x) => x.t + barMs > filledMs && (!Number.isFinite(resolvedMs) || x.t <= resolvedMs))
      .slice(0, EARLY_BARS);
    if (early.length > 0) {
      let adverse = 0;
      for (const { c } of early) {
        adverse = Math.max(adverse, signal === "BUY" ? row.entry_point - c.low : c.high - row.entry_point);
      }
      earlyAdverseR = round2(adverse / risk);
    }
  }

  // Counterfactuals
  const atr = typeof ctx.atr === "number" && Number.isFinite(ctx.atr) && ctx.atr > 0 ? ctx.atr : null;
  const filled = ev?.filled_at !== null && ev?.filled_at !== undefined;
  const coherentAt = (entry: number, stop = row.stop_loss, tp = row.take_profit_1) =>
    signal === "BUY" ? stop < entry && tp > entry : stop > entry && tp < entry;
  const cf: PostmortemFacts["counterfactual"] = {
    market_entry: null, market_entry_same_risk: null, stop_x1_5: null, stop_x2: null, tp_half: null, limit_pullback: null,
  };
  // Away from the target: a BUY's pullback and stop sit lower
  const against = (from: number, r: number) => (signal === "BUY" ? from - risk * r : from + risk * r);
  if (reference !== null && !filled && coherentAt(reference)) {
    cf.market_entry = await simulate(row, { entry_point: reference, price_at_signal: reference }, candles, evalInterval, nowMs, atr);
  }
  if (reference !== null && !filled && risk > 0 && coherentAt(reference, against(reference, 1))) {
    cf.market_entry_same_risk = await simulate(
      row,
      { entry_point: reference, stop_loss: against(reference, 1), price_at_signal: reference },
      candles,
      evalInterval,
      nowMs,
      atr,
    );
  }
  if (filled && risk > 0) {
    cf.stop_x1_5 = await simulate(row, { stop_loss: against(row.entry_point, 1.5) }, candles, evalInterval, nowMs, atr);
    cf.stop_x2 = await simulate(row, { stop_loss: against(row.entry_point, 2) }, candles, evalInterval, nowMs, atr);
    const half = signal === "BUY" ? row.entry_point + reward / 2 : row.entry_point - reward / 2;
    cf.tp_half = await simulate(row, { take_profit_1: half, take_profit_2: null, take_profit_3: null }, candles, evalInterval, nowMs, atr);
    // Waited for a pullback instead: a limit PULLBACK_R away from the entry
    // with the stop moved along (same risk width), judged against the
    // market price so the judge sees it as the limit it is. Only when that
    // level really is a limit from where the market was — for a stop entry
    // the pullback can land on the market side, which would be judged as a
    // market order, not a wait.
    const pullback = against(row.entry_point, PULLBACK_R);
    const ref = reference ?? row.entry_point;
    const isLimit = (signal === "BUY" ? pullback < ref : pullback > ref) && Math.abs(pullback - ref) / ref > FILL_TOLERANCE;
    if (isLimit) {
      cf.limit_pullback = await simulate(
        row,
        { entry_point: pullback, stop_loss: against(pullback, 1), price_at_signal: ref },
        candles,
        evalInterval,
        nowMs,
        atr,
      );
    }
  }

  // Regime: what was declared against what the ADX said
  let regime: PostmortemFacts["regime"] = null;
  const declared = normalizeMode(ctx.declaredMode ?? null);
  const adx = typeof ctx.adx === "number" && Number.isFinite(ctx.adx) ? ctx.adx : null;
  if (declared !== null || adx !== null) {
    const momentum = isMomentumMode(declared);
    const conflict = adx !== null && declared !== null &&
      ((momentum && adx < 20) || (!momentum && (declared === "range day" || declared === "reversal") && adx >= 30));
    regime = { declared, adx, conflict };
  }

  // Deterministic reading, for the model to confirm or overrule with reasons
  const hints: Cause[] = [];
  const push = (c: Cause) => {
    if (!hints.includes(c)) hints.push(c);
  };
  const maxFavR = toR(maxFav);
  const maxAdvR = toR(maxAdv);
  const beyondSlR = after.length > 0 ? toR(beyondSl) : null;
  const won = (r: CfResult | null) => r?.resolution === "win";
  // A counterfactual only counts as a remedy when the gate would publish it
  const wonViable = (r: CfResult | null) => won(r) && r?.viable === true;
  const marketOrder = (ev?.order_type ?? "unknown") === "market";

  switch (ev?.resolution ?? row.outcome) {
    case "loss": {
      // Chased: turned against the entry at once, and a pullback limit with
      // the same risk width would have paid. The same path also reads as a
      // stop inside the noise; the chase is the first reading only when the
      // stop was not narrow (at least an ATR wide), otherwise the stop is.
      const chased = marketOrder && earlyAdverseR !== null && earlyAdverseR >= EARLY_ADVERSE_R && wonViable(cf.limit_pullback);
      const stopWide = atr !== null && risk >= atr;
      if (chased && stopWide) push("entry_too_early");
      // The stop and target variants say what went wrong even when the
      // variant itself would not pass the gate (the model is told which);
      // the entry variants are gated because they are the ones that turn
      // straight into "enter at the market" rules
      if (tp1Touch !== null || won(cf.stop_x1_5) || won(cf.stop_x2)) push("stop_too_tight");
      if (chased && !stopWide) push("entry_too_early");
      if ((ev?.mfe_r ?? 0) >= 0.5 && won(cf.tp_half)) push("target_too_far");
      if (beyondSlR !== null && beyondSlR >= 1 && tp1Touch === null) push("direction_wrong");
      if (abnormal !== null) push("news_shock");
      if (hints.length === 0) push(after.length === 0 ? "inconclusive" : "direction_wrong");
      break;
    }
    case "untriggered":
      if (ev?.reason === "invalidated") push("direction_wrong");
      else if (wonViable(cf.market_entry) || wonViable(cf.market_entry_same_risk)) push("entry_too_far");
      else if (won(cf.market_entry) || won(cf.market_entry_same_risk)) {
        // The move was there, but no market version of this plan passes the
        // gate: the remedy is a different stop or a skip, not "go market"
        push("inconclusive");
        notes.push(
          `a market entry would have reached TP1 but no market version of the plan pays (market: ${gateReason(cf.market_entry, atr)}; same-risk: ${gateReason(cf.market_entry_same_risk, atr)}); the lesson must change the stop or the target, or skip the trade, not switch to a market order`,
        );
      } else if (cf.market_entry?.resolution === "loss" || cf.market_entry_same_risk?.resolution === "loss") push("direction_wrong");
      else if (maxFavR !== null && maxFavR >= MISSED_MOVE_R) {
        push("inconclusive");
        notes.push(`price moved ${maxFavR}R in the signal's direction from the reference, but no market version of the plan reached TP1 first`);
      } else push("inconclusive");
      break;
    case "expired":
      if ((ev?.mfe_r ?? 0) >= 0.5 || won(cf.tp_half)) push("target_too_far");
      else push("inconclusive");
      break;
    case "win":
      push((ev?.mae_r ?? 0) >= LUCKY_MAE_R ? "lucky_win" : "good_call");
      if (wonViable(cf.limit_pullback) && cf.limit_pullback?.rr !== null && rr !== null && (cf.limit_pullback?.rr ?? 0) > rr) {
        notes.push(`a limit ${PULLBACK_R}R back would also have filled and paid ${cf.limit_pullback?.rr}:1 instead of ${rr}:1`);
      } else if (cf.limit_pullback?.resolution === "untriggered") {
        notes.push(`a limit ${PULLBACK_R}R back would not have filled: entering at once was right`);
      }
      break;
    case "ambiguous":
      push(ev?.reason === "incoherent" ? "plan_incoherent" : "inconclusive");
      break;
    default:
      push("inconclusive");
  }
  if (regime?.conflict) push("regime_misread");

  return {
    version: 2,
    eval_interval: evalInterval,
    bars_after_settlement: after.length,
    risk: round2(risk * 1000) / 1000,
    reward: round2(reward * 1000) / 1000,
    rr,
    order_type: ev?.order_type ?? "unknown",
    hours_to_fill: hoursBetween(row.created_at, ev?.filled_at ?? null),
    hours_to_settle: hoursBetween(row.created_at, resolvedIso),
    reference,
    from_signal: { max_favorable_r: maxFavR, max_adverse_r: maxAdvR },
    after: {
      first_touch: firstTouch,
      reached_tp1: tp1Touch,
      reached_sl: slTouch,
      beyond_sl_r: beyondSlR,
      returned_to_entry: after.length > 0 ? returnedToEntry : null,
    },
    abnormal_bar: abnormal,
    early_adverse_r: earlyAdverseR,
    counterfactual: cf,
    regime,
    hints,
    notes,
  };
};
