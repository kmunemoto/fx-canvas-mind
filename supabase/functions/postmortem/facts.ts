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
import { eventInBar, type EconEvent } from "../econ-calendar/events.ts";
import {
  MAX_LIMIT_ATR,
  MIN_RISK_REWARD,
  MIN_STOP_ATR,
  entryScale,
  inferEntryType,
  isMomentumMode,
  normalizeMode,
} from "../analyze/entry.ts";
import {
  EXPIRY_DAYS,
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
  // entry_chosen_v1 only: the model picked an entry the market never reached,
  // so the call was never scored. Under market_v1 the server enters at the
  // market price and no plan can go unfilled. Kept because old rows, old
  // lessons and old rulebook rules carry it, and because dropping it from
  // CAUSES would make isCause reject an old rule's cause and
  // parseConsolidation widen it to "general".
  | "entry_too_far"
  // entry_chosen_v1 vocabulary for what is now chased_move. No longer
  // produced by anything; kept so stored rows and rules stay legible.
  // canonicalCause folds it into chased_move at every comparison.
  | "entry_too_early"
  // filled into an immediate retrace that took the stop, in a market extended
  // enough that the same plan filled PULLBACK_R better would have paid. The
  // move was already extended when the plan was made; the only lever this
  // touches is whether to take the trade at all.
  | "chased_move"
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
  "chased_move",
  "target_too_far",
  "regime_misread",
  "news_shock",
  "plan_incoherent",
  "good_call",
  "lucky_win",
  "inconclusive",
];

export const MARKET_CONTRACT = "market_v1";

// entry_chosen_v1 vocabulary. Never produced again; still accepted and still
// counted. Sole reader: causesFor.
export const LEGACY_CAUSES: readonly string[] = ["entry_too_far", "entry_too_early"];

// Folds the old spelling into the new one wherever two cause strings are
// compared or counted. Readers: citationAllowed (both operands),
// parseConsolidation's cause coercion, parseDiagnosis's pick, and
// summarizeRecord's three histograms and its cluster map. NOT the UI label
// lookup — a stored row renders the wording of its own era.
export const canonicalCause = (c: string): string => (c === "entry_too_early" ? "chased_move" : c);

// The causes a plan made under this contract can be diagnosed with. Readers:
// diagnosisSchema(), parseDiagnosis() and causeOutsideContract().
export const causesFor = (contract?: string | null): readonly Cause[] =>
  contract === MARKET_CONTRACT ? CAUSES.filter((c) => !LEGACY_CAUSES.includes(c)) : CAUSES;

// A cause the given contract's taxonomy cannot produce, canonical spellings
// folded first — so a rule filed under the dead spelling "entry_too_early" is
// tested as the live cause "chased_move", which market_v1 does produce.
//
// "general" names no failure of any era and is exempt: it is the label the
// consolidation schema offers for a rule that addresses no single cause, so
// refusing it here would hold back every such rule. The text veto in
// postmortem/prompt.ts is what covers "general".
//
// An unrecognised cause returns true: a rule whose cause string is not in the
// taxonomy cannot prove it is followable, and the stamp is only ever granted
// on proof.
//
// Readers: stampFor (postmortem/prompt.ts) and the v7 repair migration, whose
// SQL cause list is pinned to this function by src/test/entry-contract.test.ts.
export const causeOutsideContract = (cause: string, contract?: string | null): boolean => {
  const c = canonicalCause(cause);
  if (c === "general") return false;
  return !(causesFor(contract) as readonly string[]).includes(c);
};

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
// MAE this close to the stop makes a win a lucky one (the deep_mae flag)
export const LUCKY_MAE_R = 0.8;
// A move of at least this many R without a fill is a missed trade
export const MISSED_MOVE_R = 1;
// The pullback the "entered later" counterfactual waits for, in R
export const PULLBACK_R = 0.5;
// An adverse move of this much inside the first bars after a market fill
// says the entry chased an exhausted move
export const EARLY_ADVERSE_R = 0.5;
export const EARLY_BARS = 3;

// How unsafe a win was, beyond its MAE. Each threshold below raises one
// DangerFlag on a settled win (computeDanger); the flags together are what
// files a win as lucky_win instead of good_call. They are defaults chosen
// WITHOUT a calibration sample: at the time of writing two wins exist in
// production (mae_r 0.98 over 15 bars, and mae_r 0.21 over 5 bars), which is
// enough to show the gap the block fills and not enough to place a boundary
// on. A future calibration reads the danger block of settled wins in
// analyses.postmortem.facts and asks, flag by flag, whether the wins it
// raised on went on to be cited in rules that held up.
//
// At least this share of the bars in the trade closed on the adverse side
// of the entry: the trade spent most of its life losing before it won
export const UNDERWATER_RATIO = 0.5;
// The underwater share means nothing on a trade this short (2 of 3 bars is
// one bar of noise), so mostly_underwater needs at least this many bars
export const MIN_DANGER_BARS = 4;
// This many changes of side around the entry is a range being traded as a
// move, not a move
export const CHOP_CROSSINGS = 4;
// The bar that reached TP1 closed at least this far short of it, in R: the
// target was touched by a wick, not by the close
export const SPIKE_CLOSE_R = 0.5;
// ...and price then gave back at least this many R from TP1 inside the
// after-window. Both together make a spike_target; a wick that held is a
// win that was simply early
export const SPIKE_REVERSAL_R = 1;
// The trade used at least this share of its allowed life before the target
// was reached: a call that needed nearly the whole expiry window to pay is
// a slow call, whatever its mae_r says
export const LATE_LIFE_RATIO = 0.75;

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
  // Which of the gate's tests the variant fails, when it is not viable: the
  // reward for the risk, the stop's width, a limit's distance from the
  // market, or a limit in a regime where the gate turns limits into
  // market entries
  gate: "ok" | "poor_rr" | "stop_too_tight" | "too_far" | "should_be_market";
}

export interface GateContext {
  atr: number | null;
  // The no-pullback rule was in force for the plan (entry_check.momentum)
  momentum: boolean;
}

// What made a win an unsafe one. Raised only on a win; the numbers behind
// them are measured for every filled plan.
export type DangerFlag =
  // mae_r reached LUCKY_MAE_R: the stop was nearly hit
  | "deep_mae"
  // underwater_ratio reached UNDERWATER_RATIO over at least MIN_DANGER_BARS
  | "mostly_underwater"
  // entry_crossings reached CHOP_CROSSINGS
  | "chop"
  // the TP1 bar closed SPIKE_CLOSE_R or more short of the target, and the
  // after-window gave back SPIKE_REVERSAL_R or more from it
  | "spike_target"
  // life_used_ratio reached LATE_LIFE_RATIO
  | "late_win";

export const DANGER_FLAGS: readonly DangerFlag[] = ["deep_mae", "mostly_underwater", "chop", "spike_target", "late_win"];

// How unsafe a filled trade was, measured on the evaluation bars from the
// fill to the settlement and on the after-window. mae_r alone cannot tell a
// win that spent nine of fifteen bars underwater from one that never looked
// back; these can.
export interface Danger {
  // Bars from the fill bar to the settlement bar inclusive
  bars_in_trade: number;
  // Bars in trade whose close sat strictly on the adverse side of the entry
  underwater_bars: number;
  // underwater_bars / bars_in_trade; null when there were no bars in trade
  underwater_ratio: number | null;
  // Longest run of consecutive underwater bars
  longest_underwater_bars: number;
  // Closes that changed side of the entry versus the previous close. A
  // close exactly on the entry keeps the previous side.
  entry_crossings: number;
  // 1 - mae_r: how much of the risk was still unspent at the worst point;
  // null when the judge recorded no mae_r
  closest_to_stop_r: number | null;
  // Wins only: where the bar that reached TP1 closed, relative to TP1, in
  // R. Negative means it closed short of the target (mirrored for SELL, so
  // negative still means short of it). Null otherwise.
  target_bar_close_r: number | null;
  // Wins only: the largest move against the signal from TP1 inside the
  // after-window, in R (never below 0). Null when there is no aftermath.
  reversed_after_r: number | null;
  // hours_to_settle over the expiry allowance (EXPIRY_DAYS of the plan's own
  // timeframe, in hours). Wall-clock hours over calendar days: the judge
  // itself counts market time, so a trade that held over a weekend shows a
  // higher ratio here than the judge would have measured. Null when the
  // settlement time is unknown.
  life_used_ratio: number | null;
  // In DANGER_FLAGS order. Empty on anything but a win.
  flags: DangerFlag[];
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
  // A bar far outside the others during the plan, and the scheduled release
  // it can be attributed to — "news" as a fact rather than an inference from
  // the shape of a candle
  abnormal_bar: { at: string; range_ratio: number; event: { at: string; country: string; impact: string; title: string } | null } | null;
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
  // How unsafe the trade was, for every filled plan; null when the plan
  // never filled. Its flags are what turn a win into lucky_win.
  danger: Danger | null;
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
  gateCtx: GateContext,
): Promise<CfResult> => {
  const { atr, momentum } = gateCtx;
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
  let gate: CfResult["gate"] = !rrOk ? "poor_rr" : !stopOk ? "stop_too_tight" : "ok";
  // The gate's distance and regime tests, on a limit variant: the same
  // rules entry.ts applies to the model's own plans
  const ref = base.price_at_signal;
  if (gate === "ok" && ref !== null && Number.isFinite(ref) && ref > 0) {
    const scale = entryScale(ref, atr);
    if (inferEntryType(base.signal, base.entry_point, ref, scale) === "limit") {
      if (Math.abs(base.entry_point - ref) / scale > MAX_LIMIT_ATR) gate = "too_far";
      else if (momentum) gate = "should_be_market";
    }
  }
  return {
    resolution: j.resolution,
    reason: j.evaluation.reason,
    mfe_r: j.evaluation.mfe_r,
    mae_r: j.evaluation.mae_r,
    rr,
    viable: gate === "ok",
    gate,
  };
};

// Why a variant would not be published, for the notes
const gateReason = (r: CfResult | null, atr: number | null): string => {
  if (!r) return "n/a";
  switch (r.gate) {
    case "poor_rr":
      return `rr ${r.rr ?? "?"} below ${MIN_RISK_REWARD}`;
    case "stop_too_tight":
      return `stop under ${MIN_STOP_ATR} ATR${atr !== null ? ` (ATR ${atr})` : ""}`;
    case "too_far":
      return `more than ${MAX_LIMIT_ATR} ATR from the market`;
    case "should_be_market":
      return "away from the market in a trend regime, where the gate enters at the market instead";
    default:
      return "passes";
  }
};

// The flags a win's danger block raises, in DANGER_FLAGS order. Wins only:
// on a loss every number is still measured, but a loss is diagnosed by what
// went wrong, not by how close it came to going wrong, so its flags stay
// empty and the loss hints are untouched by this block. deep_mae is the rule
// that filed lucky_win before the block existed, unchanged: a missing mae_r
// reads as 0, as it always did.
export const dangerFlags = (d: Danger, maeR: number | null): DangerFlag[] => {
  const raised: Record<DangerFlag, boolean> = {
    deep_mae: (maeR ?? 0) >= LUCKY_MAE_R,
    // The raw share, not the rounded one the block shows: 61 bars of 123
    // rounds to 0.50 and is not most of them
    mostly_underwater: d.bars_in_trade >= MIN_DANGER_BARS && d.underwater_bars / d.bars_in_trade >= UNDERWATER_RATIO,
    chop: d.entry_crossings >= CHOP_CROSSINGS,
    spike_target: d.target_bar_close_r !== null && d.target_bar_close_r <= -SPIKE_CLOSE_R &&
      d.reversed_after_r !== null && d.reversed_after_r >= SPIKE_REVERSAL_R,
    late_win: d.life_used_ratio !== null && d.life_used_ratio >= LATE_LIFE_RATIO,
  };
  // The order is the constant's, so the two lists cannot drift apart
  return DANGER_FLAGS.filter((f) => raised[f]);
};

// One raised flag in words, with the number behind it, for the notes: the
// model reads facts.notes as well as facts.danger, and the reason a win was
// filed as lucky should be legible in both
const describeFlag = (flag: DangerFlag, d: Danger | null, maeR: number | null): string => {
  switch (flag) {
    case "deep_mae":
      return `deep_mae (mae_r ${maeR ?? 0})`;
    case "mostly_underwater":
      return `mostly_underwater (${d?.underwater_bars ?? 0}/${d?.bars_in_trade ?? 0} bars)`;
    case "chop":
      return `chop (${d?.entry_crossings ?? 0} crossings)`;
    case "spike_target":
      return `spike_target (TP1 bar closed ${Math.abs(d?.target_bar_close_r ?? 0)}R short, gave back ${d?.reversed_after_r ?? 0}R after)`;
    case "late_win":
      return `late_win (${Math.round((d?.life_used_ratio ?? 0) * 100)}% of life)`;
  }
};

export interface FactsContext {
  // What the model declared and what the indicators said at signal time
  declaredMode?: string | null;
  adx?: number | null;
  atr?: number | null;
  // Whether the gate's no-pullback rule applied to the plan
  momentum?: boolean | null;
  // The calendar around the plan's life, for attributing an abnormal bar
  events?: EconEvent[];
  // Which entry contract the plan was made under. One reader: the untriggered
  // branch of the hints switch, which must not file a market_v1 plan under a
  // cause only the old contract could produce.
  contract?: string | null;
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
    let best = { at: "", ratio: 0, t: 0 };
    during.forEach((x, i) => {
      const ratio = ranges[i] / med;
      if (ratio > best.ratio) best = { at: toIso(x.t), ratio, t: x.t };
    });
    if (best.ratio >= ABNORMAL_RANGE_RATIO) {
      const barMs = INTERVAL_MS[evalInterval] ?? HOUR;
      const scheduled = eventInBar(ctx.events ?? [], row.pair, best.t, best.t + barMs);
      abnormal = {
        at: best.at,
        range_ratio: round2(best.ratio),
        event: scheduled
          ? { at: scheduled.event_at, country: scheduled.country, impact: scheduled.impact, title: scheduled.title }
          : null,
      };
    }
  }

  // The first bars in the trade: did price turn on the entry at once? Only
  // the bars before the one that settled it (a stop-out bar always shows a
  // full risk of adverse move, which says nothing about a chase), and not
  // for stop entries, whose fill bar is mostly the approach to the entry
  // rather than a move against it.
  const filledMs = typeof ev?.filled_at === "string" ? Date.parse(ev.filled_at) : NaN;
  const orderType = ev?.order_type ?? "unknown";
  let earlyAdverseR: number | null = null;
  let earlyAdverse = 0;
  if (Number.isFinite(filledMs) && risk > 0 && (orderType === "market" || orderType === "limit")) {
    const barMs = INTERVAL_MS[evalInterval] ?? HOUR;
    const early = post
      .filter((x) => x.t + barMs > filledMs && (!Number.isFinite(resolvedMs) || x.t < resolvedMs))
      .slice(0, EARLY_BARS);
    if (early.length > 0) {
      for (const { c } of early) {
        earlyAdverse = Math.max(earlyAdverse, signal === "BUY" ? row.entry_point - c.low : c.high - row.entry_point);
      }
      earlyAdverseR = round2(earlyAdverse / risk);
    }
  }

  // How unsafe the trade was, bar by bar. The bars in trade run from the one
  // containing the fill to the one containing the settlement, inclusive: the
  // fill bar counts because a market fill's own bar is the first the trade
  // lived through, and the settlement bar counts because the settlement is
  // usually what its close shows. Measured for every filled plan; the flags
  // are raised in the win branch below, so nothing about a loss changes.
  const isWin = (ev?.resolution ?? row.outcome) === "win";
  let danger: Danger | null = null;
  if (Number.isFinite(filledMs)) {
    const barMs = INTERVAL_MS[evalInterval] ?? HOUR;
    // From `series`, not `post`: post starts at the first bar AT OR AFTER
    // the signal, and a market fill is mid-bar, so the bar holding the fill
    // — the only bar of a win settled inside it, which is what a wick that
    // touched the target and reversed looks like — would otherwise be missed
    const inTrade = series.filter((x) => x.t + barMs > filledMs && (!Number.isFinite(resolvedMs) || x.t <= resolvedMs));
    const adverse = (close: number) => (signal === "BUY" ? close < row.entry_point : close > row.entry_point);
    let underwater = 0;
    let run = 0;
    let longestRun = 0;
    let crossings = 0;
    // Which side of the entry the previous close sat on; a close on the
    // entry itself keeps it, so a bar that touched the line is not a
    // crossing twice over
    type Side = "for" | "against" | null;
    let side: Side = null;
    for (const { c } of inTrade) {
      if (adverse(c.close)) {
        underwater++;
        run++;
        longestRun = Math.max(longestRun, run);
      } else run = 0;
      const now: Side = c.close === row.entry_point ? side : adverse(c.close) ? "against" : "for";
      if (side !== null && now !== side) crossings++;
      side = now;
    }
    // Wins only: was the target reached by a close or by a wick, and did
    // the move hold. The TP1 bar is the first bar in trade that touched TP1,
    // which for a win is normally the bar the judge settled on.
    let targetBarCloseR: number | null = null;
    let reversedAfterR: number | null = null;
    if (isWin && risk > 0) {
      const tpBar = inTrade.find((x) => hitsTp(signal, x.c, row.take_profit_1)) ?? null;
      if (tpBar) {
        const short = signal === "BUY" ? tpBar.c.close - row.take_profit_1 : row.take_profit_1 - tpBar.c.close;
        targetBarCloseR = round2(short / risk);
      }
      if (after.length > 0) {
        let reversed = 0;
        for (const { c } of after) {
          reversed = Math.max(reversed, signal === "BUY" ? row.take_profit_1 - c.low : c.high - row.take_profit_1);
        }
        reversedAfterR = round2(reversed / risk);
      }
    }
    const maeR = typeof ev?.mae_r === "number" && Number.isFinite(ev.mae_r) ? ev.mae_r : null;
    danger = {
      bars_in_trade: inTrade.length,
      underwater_bars: underwater,
      underwater_ratio: inTrade.length > 0 ? round2(underwater / inTrade.length) : null,
      longest_underwater_bars: longestRun,
      entry_crossings: crossings,
      closest_to_stop_r: maeR === null ? null : round2(1 - maeR),
      target_bar_close_r: targetBarCloseR,
      reversed_after_r: reversedAfterR,
      // Measured in bar time, as the judge measures the expiry: the bars the
      // trade lived through times the bar length, over the allowance. Wall
      // clock would count a weekend as two days of life and file a Friday
      // plan that paid on Tuesday as late. The same fallback as the judge's
      // for an interval with no allowance; an expiry can reach 1 or more.
      life_used_ratio: inTrade.length === 0 ? null : round2((inTrade.length * barMs) / HOUR / ((EXPIRY_DAYS[row.interval] ?? 30) * 24)),
      flags: [],
    };
  }

  // Counterfactuals
  const atr = typeof ctx.atr === "number" && Number.isFinite(ctx.atr) && ctx.atr > 0 ? ctx.atr : null;
  const gateCtx: GateContext = { atr, momentum: ctx.momentum === true };
  const filled = ev?.filled_at !== null && ev?.filled_at !== undefined;
  const coherentAt = (entry: number, stop = row.stop_loss, tp = row.take_profit_1) =>
    signal === "BUY" ? stop < entry && tp > entry : stop > entry && tp < entry;
  const cf: PostmortemFacts["counterfactual"] = {
    market_entry: null, market_entry_same_risk: null, stop_x1_5: null, stop_x2: null, tp_half: null, limit_pullback: null,
  };
  // Away from the target: a BUY's pullback and stop sit lower
  const against = (from: number, r: number) => (signal === "BUY" ? from - risk * r : from + risk * r);
  if (reference !== null && !filled && coherentAt(reference)) {
    cf.market_entry = await simulate(row, { entry_point: reference, price_at_signal: reference }, candles, evalInterval, nowMs, gateCtx);
  }
  if (reference !== null && !filled && risk > 0 && coherentAt(reference, against(reference, 1))) {
    cf.market_entry_same_risk = await simulate(
      row,
      { entry_point: reference, stop_loss: against(reference, 1), price_at_signal: reference },
      candles,
      evalInterval,
      nowMs,
      gateCtx,
    );
  }
  if (filled && risk > 0) {
    cf.stop_x1_5 = await simulate(row, { stop_loss: against(row.entry_point, 1.5) }, candles, evalInterval, nowMs, gateCtx);
    cf.stop_x2 = await simulate(row, { stop_loss: against(row.entry_point, 2) }, candles, evalInterval, nowMs, gateCtx);
    const half = signal === "BUY" ? row.entry_point + reward / 2 : row.entry_point - reward / 2;
    cf.tp_half = await simulate(row, { take_profit_1: half, take_profit_2: null, take_profit_3: null }, candles, evalInterval, nowMs, gateCtx);
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
        gateCtx,
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
  const marketV1 = ctx.contract === MARKET_CONTRACT;

  switch (ev?.resolution ?? row.outcome) {
    case "loss": {
      // Chased: an entry that turned against it at once — by at least half the
      // risk, and by a real move (half an ATR) rather than the bar-to-bar
      // noise a narrow stop sits in — while the same plan filled PULLBACK_R
      // better, at the same risk width, would have paid. The same path also
      // reads as a stop inside the noise, so that hint follows; the chase
      // comes first because declining the trade is a remedy the analyzer may
      // apply under either contract, and widening the stop past MIN_STOP_ATR
      // is not. All four conditions discriminate: earlyAdverseR is null when
      // the fill time is unparseable or the entry was a stop order, and the
      // ATR test separates a real move from noise. pays(cf.limit_pullback) is
      // the one that carries the "a better price was there" claim — stop
      // computing that counterfactual and this cause silently stops firing.
      const pays = (r: CfResult | null) => r !== null && won(r) && r.gate !== "poor_rr" && r.gate !== "stop_too_tight";
      const chased = marketOrder && earlyAdverseR !== null && earlyAdverseR >= EARLY_ADVERSE_R &&
        (atr === null || earlyAdverse >= 0.5 * atr) && pays(cf.limit_pullback);
      if (chased) push("chased_move");
      // The stop and target variants say what went wrong even when the
      // variant itself would not pass the gate (the model is told which);
      // the entry variants are gated because they are the ones that turn
      // straight into "enter at the market" rules
      if (tp1Touch !== null || won(cf.stop_x1_5) || won(cf.stop_x2)) push("stop_too_tight");
      if ((ev?.mfe_r ?? 0) >= 0.5 && won(cf.tp_half)) push("target_too_far");
      if (beyondSlR !== null && beyondSlR >= 1 && tp1Touch === null) push("direction_wrong");
      if (abnormal !== null) push("news_shock");
      if (hints.length === 0) push(after.length === 0 ? "inconclusive" : "direction_wrong");
      break;
    }
    case "untriggered":
      if (marketV1) {
        // Under market_v1 entry === price_at_signal, classifyOrder returns
        // "market" and the judge fills on the signal bar, so an untriggered
        // verdict is not a plan the market never reached — it is a fill that
        // could not be established from the data. Filing it under a legacy
        // cause would put a fabricated entry_too_far into by_cause and into
        // citation.
        push("inconclusive");
        notes.push(
          "market_v1: every plan is entered at the market price on the signal bar, so an untriggered verdict means the fill could not be established from the data (price_at_signal missing, or the signal bar unavailable), not that the entry was never reached",
        );
        break;
      }
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
    case "win": {
      // A win is lucky when any of the danger flags is up — the deep MAE
      // that always made one, or a trade that spent most of its bars
      // underwater, chopped around its entry, took the target on a wick
      // that reversed, or needed most of its allowed life. A win with no
      // flags is a good call as far as the bars can tell; the model may
      // still overrule that from the plan.
      const maeR = typeof ev?.mae_r === "number" && Number.isFinite(ev.mae_r) ? ev.mae_r : null;
      const dz = danger;
      if (dz) dz.flags = dangerFlags(dz, maeR);
      // A win whose fill instant is not on record (an early version wrote
      // filled_at null) has no bars to walk, but its MAE is on record and
      // the rule that read it never needed the walk
      const flags: DangerFlag[] = dz ? dz.flags : (maeR ?? 0) >= LUCKY_MAE_R ? ["deep_mae"] : [];
      push(flags.length > 0 ? "lucky_win" : "good_call");
      if (flags.length > 0) notes.push(`danger: ${flags.map((f) => describeFlag(f, dz, maeR)).join(", ")}`);
      if (won(cf.limit_pullback) && cf.limit_pullback?.rr !== null && rr !== null && (cf.limit_pullback?.rr ?? 0) > rr) {
        notes.push(
          cf.limit_pullback?.viable
            ? `a fill ${PULLBACK_R}R better would also have paid ${cf.limit_pullback?.rr}:1 instead of ${rr}:1`
            : `a fill ${PULLBACK_R}R better would also have paid ${cf.limit_pullback?.rr}:1, but a plan entered there does not pass the gate (${gateReason(cf.limit_pullback, atr)})`,
        );
      } else if (cf.limit_pullback?.resolution === "untriggered") {
        notes.push(`price never came back ${PULLBACK_R}R while the trade was open: this entry was not late`);
      }
      break;
    }
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
    danger,
    hints,
    notes,
  };
};
