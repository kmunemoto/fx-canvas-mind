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
  // WAIT only: the trade named at the call was there and it paid, so standing
  // aside cost a win. The one cause in the taxonomy that pushes toward
  // trading MORE — every other one punishes being too bold, and a loop that
  // can only push one way ends at "always WAIT", never wrong and worth
  // nothing.
  | "wait_missed_trade"
  // WAIT only: that trade was stopped out or never paid. Standing aside was
  // right, and like good_call there is no lever to move.
  | "good_wait"
  // A loss where every lever this file can move was tested and none of them
  // would have changed the outcome: a wider stop still loses, a nearer target
  // is never reached, a better fill still loses, and price never came back to
  // the plan's side afterwards.
  //
  // It does NOT say the call was right. Everything measured here happened
  // AFTER the decision was made, so "the analysis was correct" is not a claim
  // this file is in any position to make. The whole assertion is: no lever we
  // can move would have changed this outcome — which is why the verdict names
  // no lever, and why a lesson filed under it must not move one.
  | "sound_call_lost"
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
  "wait_missed_trade",
  "good_wait",
  "sound_call_lost",
  "inconclusive",
];

// The vocabulary for a call that declined to trade. A WAIT has no fill, no
// stop and no target of its own, so the trade causes describe nothing that
// happened; and a trade must never be diagnosed "good_wait".
export const WAIT_CAUSES: readonly Cause[] = [
  "wait_missed_trade",
  "good_wait",
  "regime_misread",
  "news_shock",
  "inconclusive",
];

// The two a settled trade can never be. The other three above describe the
// market, not the decision, and belong to both vocabularies.
export const WAIT_ONLY_CAUSES: readonly string[] = ["wait_missed_trade", "good_wait"];

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

// Every cause valid under this contract, trades and WAITs together. Readers:
// causesForSignal() and causeOutsideContract() — the latter must see the WAIT
// causes, or a rule learned from over-caution would be held back from every
// prompt for naming a cause its own contract "cannot produce".
export const causesFor = (contract?: string | null): readonly Cause[] =>
  contract === MARKET_CONTRACT ? CAUSES.filter((c) => !LEGACY_CAUSES.includes(c)) : CAUSES;

// What a single row may be diagnosed with. Readers: diagnosisSchema() and
// parseDiagnosis(). Offering "good_wait" to a settled trade, or
// "stop_too_tight" to a call that never entered, is offering a verdict about
// something that did not happen.
export const causesForSignal = (contract?: string | null, signal?: string | null): readonly Cause[] =>
  signal === "WAIT" ? WAIT_CAUSES : causesFor(contract).filter((c) => !WAIT_ONLY_CAUSES.includes(c));

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
// A loss whose price never came this far the signal's way, in R, is a loss
// where the direction simply was not there. The SECOND positive test for
// direction_wrong, beside "price kept running past the stop", and it exists
// because those two together had to replace a fallback that filed every
// otherwise-unexplained loss as direction_wrong. Measured 2026-09-07: of the
// six live direction_wrong diagnoses, two carried beyond_sl_r >= 1 and four
// came out of that fallback — three of the four cited by rule r10. Under the
// two positive tests one of those four keeps the verdict (max_favorable_r 0)
// and three no longer earn it.
export const DIRECTION_DEAD_R = 0.1;

// Fewest bars of a plan's life at which the abnormal-bar test can return a
// meaningful "no". With two bars the median IS the mean of the two, so the
// largest ratio reachable is 2·max/(r1+r2), strictly under 2 and therefore
// under ABNORMAL_RANGE_RATIO; with three the median is the middle bar and the
// ratio is unbounded. Three is where the test starts being able to say no.
export const ABNORMAL_MIN_BARS = 3;
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

// One lever, and what the counterfactual that moves it answered.
export interface LeverVerdict {
  lever: "stop_x1_5" | "stop_x2" | "tp_half" | "limit_pullback";
  // The variant was simulated at all. A lever that was never computed is a
  // lever nobody tested, which is not the same as a lever that would not have
  // helped — and only the second one may earn sound_call_lost.
  computed: boolean;
  // What the judge said about the variant, kept raw so a reader of a stored
  // row can see the answer and not only our reading of it.
  resolution: Resolution | null;
  // Would moving this lever have changed the outcome? Keyed on resolution and
  // NEVER on viable: viable is false on every stop and target variant this
  // system will ever compute, because doubling the risk or halving the reward
  // drops rr under MIN_RISK_REWARD by construction (the rr and gate arithmetic
  // in simulate()). A no-fault verdict gated on viable would be granted to
  // every loss on earth.
  //
  //   true  — "win", and also "expired": a wider stop that was never hit and
  //           never reached the target turns −1R into about 0R, and a lever
  //           that erases the loss has changed the outcome as surely as one
  //           that wins. Reading expired as "did not pay" was the single most
  //           flattering thing this table did.
  //   false — "loss" (the lever was pulled and the trade still lost) or
  //           "untriggered" (the better fill never existed, so there was no
  //           lever there to pull).
  //   null  — not computed, still open (resolution null), or "ambiguous". The
  //           question was asked and has not been answered. Measured against
  //           production 2026-09-08: stop_x2 is computed-but-open on 3 of the
  //           9 live losses and stop_x1_5 on 3 of them, because a postmortem
  //           runs at MIN_AFTER_BARS bars while the variants are judged over
  //           EXPIRY_DAYS — 20 days on a 1h plan. (An earlier revision of this
  //           comment said 7 and 5; those were the counts before four rows were
  //           re-diagnosed at 48-95 bars on 2026-09-07, and it also claimed the
  //           null-as-refusal reading had earned three live no-fault verdicts.
  //           It has earned none: there are zero sound_call_lost rows and zero
  //           no_fault_grounds.allowed. Both figures are re-checked here rather
  //           than carried forward, because a stale measurement written as a
  //           present-tense fact is how a comment starts lying.)
  //
  //           The deeper point the counts hint at: `expired` — the one
  //           resolution leverMoved reads as a wider stop having paid — needs
  //           EXPIRY_DAYS of market time, while the widest window this code
  //           examines is AFTER_BARS. The shortfall is 20x on a 1h plan and 36x
  //           on a 1day plan, so that answer is unreachable by construction: the
  //           exculpating verdict cannot arrive, while the incriminating ones
  //           can. Waiting longer before the first diagnosis does not fix it.
  paid: boolean | null;
}

// Why a loss may be filed as sound_call_lost. `levers` is the table itself;
// `complete` says every lever was actually tested; `allowed` is the verdict,
// which needs the whole table plus the disqualifiers around it.
export interface NoFaultGrounds {
  levers: LeverVerdict[];
  // Every lever was simulated at all
  complete: boolean;
  // ...and the judge returned an answer for every one of them. Separate from
  // `complete` because the two failures need different words: a lever nobody
  // computed and a lever still running both leave the question open, but only
  // the second one is waiting on time rather than on code.
  answered: boolean;
  allowed: boolean;
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
  from_signal: {
    // Measured over the plan's life PLUS the after-window — "what did the
    // market do around this call", which is the question the untriggered
    // branch and the prompt ask.
    max_favorable_r: number | null;
    max_adverse_r: number | null;
    // The same excursion measured only up to the settlement: how far price
    // came our way while the decision was still live. Optional because rows
    // written before it existed do not carry it, and a reader must treat a
    // missing one as "not measured" rather than as zero.
    max_favorable_r_in_life?: number | null;
  };
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
  // The judge's own MAE for the real plan, in R. Copied out of the evaluation
  // rather than left there because luckyWinSupported has to answer from the
  // facts row alone: 17 of the 19 diagnosed rows in production carry
  // danger: null (they predate the danger block), and on those the only thing
  // that separates a lucky win from a clean one is this number. A row written
  // before this field existed carries null, which is "not recorded", not 0.
  mae_r: number | null;
  // Losses only: which lever the no-fault verdict was tested against, and how
  // each answered. Written whether or not the verdict was earned, so a reader
  // of a stored row can see which lever decided it. Null on anything else.
  // Bars of the plan's own life, up to the settlement. The abnormal-bar test
  // is a range-against-median over exactly these, so with two or fewer of them
  // the largest ratio reachable is 2·max/(r1+r2) < 2 — under ABNORMAL_RANGE_RATIO
  // by construction, and a short violent loss is structurally incapable of
  // showing an event bar. Stored so a clause that reads "no event bar" can
  // tell "we looked and found none" from "the test could not discriminate".
  // Optional: rows written before it existed do not carry it.
  bars_in_life?: number;
  no_fault_grounds: NoFaultGrounds | null;
  // What the plan itself settled as — the judge's resolution, or the row's
  // outcome when there is no evaluation. Optional because rows written before
  // it existed do not carry it. causeGrounds reads it so that a question about
  // a win (lucky_win, good_call) is not answered about a loss; without it a
  // losing row with a deep mae_r came back "lucky_win: supported".
  resolution?: string | null;
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

// How far price came our way BEFORE the trade was settled. Null when the row
// does not carry the measure — every row written before it existed, and a
// reader must not read that as zero. Clause 5 and the second direction_wrong
// test both read this rather than from_signal.max_favorable_r, so neither of
// them can be decided by bars that arrived after the decision was over.
export const favorableInLife = (facts: PostmortemFacts): number | null =>
  facts.from_signal.max_favorable_r_in_life ?? null;

// Did moving this lever change the outcome? The tri-state above, in one
// place, so noFaultGrounds and causeGrounds cannot read a resolution two
// different ways. Null means the judge has not answered yet — "we asked and
// it is still open" is evidence for nothing, in either direction.
export const leverMoved = (
  lever: LeverVerdict["lever"],
  resolution: Resolution | null,
  // What the real plan settled as. The comparison is against THIS and not
  // against "win", because "did the lever move the outcome" is a question
  // about the difference between two endings, not about one of them being
  // good. On a loss, an expired variant is a lever that moved — the −1R never
  // happens. On an expired plan, an expired tp_half is a lever that did not:
  // the nearer target was missed as well, and the ending is the same one.
  settled: string | null,
): boolean | null => {
  // No answer yet. "ambiguous" is the judge declining to say, which is a
  // different thing from saying no.
  if (resolution === null || resolution === "ambiguous") return null;
  // Only limit_pullback can say "untriggered" and mean something: it is the
  // one variant with a different entry, and never triggering there is the
  // finding that the better fill was never on offer — a lever that was not
  // there to pull. The stop and target variants keep the original entry, so an
  // untriggered one describes a trade that never happened, which answers
  // nothing about the trade that did.
  if (resolution === "untriggered") return lever === "limit_pullback" ? false : null;
  if (settled === null) return null;
  return resolution !== settled;
};

// Whether a loss may be filed as "no lever we can move would have changed
// this outcome". Every clause below is a way for the answer to be no; there
// is no clause that makes the answer more yes the worse the loss looked,
// which is the trap this verdict has to stay out of.
//
// A first draft keyed it on how far price drifted our way before reversing as
// the thing that EARNED the verdict. That is the same bias with the sign
// flipped and the flattering sign showing: the noisier the loss, the more
// thoroughly the rulebook would be insulated from it, and the supply of noisy
// losses grows with volatility, not with judgement. The excursion appears here
// once, as clause 5, only ever to REFUSE — a loss that never went our way at
// all is direction_wrong and must not be laundered into a no-fault — and it is
// the LIFE-ONLY excursion, because the one measured over life plus the
// after-window loosened as more aftermath arrived while every other clause
// here tightened, which is that same gradient bounded at DIRECTION_DEAD_R
// rather than unbounded.
export const noFaultGrounds = (facts: PostmortemFacts): NoFaultGrounds => {
  const cf = facts.counterfactual;
  const lever = (name: LeverVerdict["lever"], r: CfResult | null): LeverVerdict => {
    const computed = r !== null && r !== undefined && typeof r === "object";
    const resolution = computed ? r.resolution : null;
    return { lever: name, computed, resolution, paid: computed ? leverMoved(name, resolution, facts.resolution ?? null) : null };
  };
  const levers: LeverVerdict[] = [
    lever("stop_x1_5", cf.stop_x1_5),
    lever("stop_x2", cf.stop_x2),
    lever("tp_half", cf.tp_half),
    lever("limit_pullback", cf.limit_pullback),
  ];
  const complete = levers.every((l) => l.computed);
  const answered = levers.every((l) => l.paid !== null);
  const after = facts.after;
  const maxFavR = favorableInLife(facts);
  const beyondSlR = after.beyond_sl_r;
  const earlyAdverseR = facts.early_adverse_r;
  // `?.` and `== null`, not `!== null`: a v1 facts row has no limit_pullback
  // KEY at all, so the value is undefined rather than null. 7 of the 20 rows
  // in production are v1, and `undefined !== null` is true — this line used to
  // throw TypeError on every one of them.
  const paysPullback = cf.limit_pullback?.resolution === "win" &&
    cf.limit_pullback.gate !== "poor_rr" && cf.limit_pullback.gate !== "stop_too_tight";
  const allowed =
    // 1. enough aftermath to have looked. A thin diagnosis is revisited, and
    //    "we saw eight bars and found no fault" is a different sentence from
    //    "we saw two".
    facts.bars_after_settlement >= MIN_AFTER_BARS &&
    // 2. every lever was tested, the judge answered for every one of them, and
    //    not one of the answers moved the outcome. `paid === false` and not
    //    `paid !== true`, so an unanswered lever refuses the verdict instead
    //    of supporting it.
    complete && levers.every((l) => l.paid === false) &&
    // 3. the target never came after the stop — that is stop_too_tight
    after.reached_tp1 === null &&
    // 4. price did not keep running past the stop — that is direction_wrong
    beyondSlR !== null && beyondSlR < 1 &&
    // 5. ...and it did go our way at least a little — the other direction_wrong
    //    test. A DISQUALIFIER, never the thing that earns the verdict.
    maxFavR !== null && maxFavR >= DIRECTION_DEAD_R &&
    // 6. we looked for an event bar and found none — and the looking was
    //    capable of finding one. Under ABNORMAL_MIN_BARS bars of life the
    //    range-against-median test cannot reach ABNORMAL_RANGE_RATIO at all,
    //    so `abnormal_bar === null` there means "the test could not answer",
    //    not "there was no event". Live losses settle in as little as 0.88h.
    (facts.bars_in_life ?? 0) >= ABNORMAL_MIN_BARS && facts.abnormal_bar === null &&
    // 7. the regime read was actually checked, and it agreed with the ADX.
    //    Both halves matter: conflict can only be true when declared AND adx
    //    are both present, so `conflict !== true` alone passes a plan that
    //    declared a mode nobody measured — an absent reading scoring as a
    //    clean one. Tested here EXPLICITLY rather than through hints, because
    //    regime_misread is pushed AFTER the switch that files this verdict, so
    //    at that moment hints cannot know about it.
    facts.regime != null && facts.regime.adx !== null && facts.regime.declared !== null &&
    facts.regime.conflict !== true &&
    // 8. the entry did not chase an extended move. Today this is implied by
    //    clause 2 — pays() begins with the same win test — but the chase asks a
    //    different question of the same variant, and a clause that only holds
    //    because another clause happens to overlap it is a clause that breaks
    //    silently when the other one moves.
    (earlyAdverseR === null || earlyAdverseR < EARLY_ADVERSE_R || !paysPullback) &&
    // 9. and nothing else already found a fault
    !facts.hints.some((h) => attributionOf(h) === "fault");
  return { levers, complete, answered, allowed };
};

// Whether the facts support filing a win as lucky rather than clean. Extracted
// from the win branch so that branch and any later grounding check read one
// expression and cannot disagree about it.
//
// The danger === null arm is not a legacy nicety: measured 2026-09-07, no row
// in the whole database has a non-empty danger.flags, 17 of 19 diagnosed rows
// have danger null at all, and the single live lucky_win is one of them —
// danger null, mae_r 0.98. A check that demanded a raised flag would reject
// 100% of the real lucky_wins on record.
export const luckyWinSupported = (facts: PostmortemFacts): boolean => {
  const flags = facts.danger?.flags ?? [];
  // `== null`, so a row whose danger key is absent (every v1 row) reads the
  // same as one whose danger is explicitly null.
  return flags.length > 0 || (facts.danger == null && (facts.mae_r ?? 0) >= LUCKY_MAE_R);
};

// What the facts say about a cause somebody named: do they carry it, do they
// refuse it, or do they not reach. The single table a grounding check reads,
// so that the model's claim and the server's own tests are compared against
// one statement of what each cause requires rather than two.
//
// "unknown" is the honest answer wherever the deciding measurement is missing
// or lives off the facts row (a WAIT's verdict, the plan's own text), and it
// is deliberately the answer for every cause this file cannot test. A checker
// must not read "unknown" as "contradicted".
export const causeGrounds = (cause: string, facts: PostmortemFacts): "supported" | "contradicted" | "unknown" => {
  const cf = facts.counterfactual;
  const after = facts.after;
  // `?.` and `== null` throughout, never `!== null`. A v1 facts row has no
  // limit_pullback key and NO row on record has facts.mae_r, so the value that
  // arrives here is undefined, not null — and `undefined !== null` is true.
  // Read with `!==` this table threw TypeError on every v1 row and answered
  // "contradicted" about a measurement nobody ever took.
  const won = (r?: CfResult | null) => r?.resolution === "win";
  const has = (r?: CfResult | null) => r != null;
  // Did moving this lever change the outcome — true, false, or not yet
  // answered. The same reading noFaultGrounds uses, from the same table.
  const moved = (lever: LeverVerdict["lever"], r?: CfResult | null) =>
    has(r) ? leverMoved(lever, r?.resolution ?? null, outcome) : null;
  // What the real plan settled as, when the row records it. Rows written
  // before the field existed do not, and a win-only or loss-only cause must
  // then answer "unknown" rather than grade a question it cannot see.
  const outcome = facts.resolution ?? null;
  const isWin = outcome === null ? null : outcome === "win";
  const isLoss = outcome === null ? null : outcome === "loss";
  // The life-only excursion, the same measure the loss branch's own direction
  // test reads. from_signal.max_favorable_r includes the after-window, and a
  // table that graded the model's answer on bars the model was not being asked
  // about would disagree with the hint it is there to check.
  const maxFavR = favorableInLife(facts);
  const beyondSlR = after.beyond_sl_r;
  switch (canonicalCause(cause)) {
    case "direction_wrong": {
      // The two positive tests, and nothing else. The fallback that used to
      // grant this cause for the absence of any other is what this table is
      // here to stop coming back through the model's answer.
      const ranPast = beyondSlR !== null && beyondSlR >= 1 && after.reached_tp1 === null;
      const neverCame = maxFavR !== null && maxFavR < DIRECTION_DEAD_R;
      if (ranPast || neverCame) return "supported";
      return beyondSlR !== null && maxFavR !== null ? "contradicted" : "unknown";
    }
    case "stop_too_tight": {
      // moved(), not won(). A wider stop that was never hit and never reached
      // the target expires flat: it does not win, but it does turn −1R into
      // about 0R, and "the stop was inside the noise" is exactly what that
      // says. Asking only whether the wider stop WON made this cause
      // unsayable on the clipped stop it describes best.
      // A question about a plan whose stop was actually hit. On anything else
      // "a wider stop would have done better" is not a claim these numbers can
      // carry: on an expired plan a wider stop that LOST reads as a lever that
      // moved the outcome, which is true and is the opposite of this cause.
      if (isLoss !== true) return isLoss === false ? "contradicted" : "unknown";
      const wider = [moved("stop_x1_5", cf.stop_x1_5), moved("stop_x2", cf.stop_x2)];
      if (after.reached_tp1 !== null || wider.includes(true)) return "supported";
      return wider.every((m) => m === false) && facts.bars_after_settlement > 0 ? "contradicted" : "unknown";
    }
    case "target_too_far": {
      const m = moved("tp_half", cf.tp_half);
      return m === true ? "supported" : m === false ? "contradicted" : "unknown";
    }
    case "chased_move": {
      const early = facts.early_adverse_r;
      const paid = won(cf.limit_pullback) && cf.limit_pullback?.gate !== "poor_rr" &&
        cf.limit_pullback?.gate !== "stop_too_tight";
      if (early !== null && early >= EARLY_ADVERSE_R && paid) return "supported";
      return early !== null && has(cf.limit_pullback) ? "contradicted" : "unknown";
    }
    case "entry_too_far":
      if (won(cf.market_entry) || won(cf.market_entry_same_risk)) return "supported";
      return has(cf.market_entry) || has(cf.market_entry_same_risk) ? "contradicted" : "unknown";
    case "regime_misread":
      if (facts.regime === null) return "unknown";
      return facts.regime.conflict ? "supported" : "contradicted";
    case "news_shock":
      // The bar is the fact; whether the plan named the event is a question
      // about the plan, which the diagnosis prompt asks separately.
      return facts.abnormal_bar !== null ? "supported" : "contradicted";
    // Both of these are questions about a WIN. Asked of a loss they used to
    // answer anyway — a losing row with a deep mae_r came back "lucky_win:
    // supported" — because nothing here read the outcome. A cause that cannot
    // apply to this row is not contradicted by it; it is simply the wrong
    // question, and #4 must not let the model through on a "supported" that
    // was never about this trade.
    case "lucky_win":
      if (isWin !== true) return isWin === false ? "contradicted" : "unknown";
      if (luckyWinSupported(facts)) return "supported";
      return facts.danger != null || facts.mae_r != null ? "contradicted" : "unknown";
    case "good_call":
      if (isWin !== true) return isWin === false ? "contradicted" : "unknown";
      if (facts.danger == null && facts.mae_r == null) return "unknown";
      return luckyWinSupported(facts) ? "contradicted" : "supported";
    case "sound_call_lost": {
      // Loss-only by construction: it is the loss branch that files it.
      if (isLoss !== true) return isLoss === false ? "contradicted" : "unknown";
      const g = noFaultGrounds(facts);
      if (g.allowed) return "supported";
      // Refused for want of evidence is not the same as refused on the
      // evidence: an untested lever, a lever the judge has not finished with,
      // or an aftermath too short to have looked at, all leave the question
      // open rather than answering it no. `answered` and not just `complete`,
      // or a row whose variants are all still running would be reported as
      // positively refuted.
      return g.complete && g.answered && facts.bars_after_settlement >= MIN_AFTER_BARS
        ? "contradicted"
        : "unknown";
    }
    // plan_incoherent is the judge's verdict, good_wait / wait_missed_trade are
    // the WAIT scorer's, and inconclusive asserts nothing to check. None of
    // them is decidable from these numbers.
    default:
      return "unknown";
  }
};

// What naming this cause claims about the decision. A pure function of the
// stored cause and nothing else: no column, nothing to backfill, nothing that
// can drift away from the taxonomy it reads.
//
// lucky_win counts as fault on purpose. It is a win, but what it says is
// "the process was unsafe", which is a lever — and a tally that filed it as
// credit would let an unsafe process be counted as evidence for itself.
export const attributionOf = (cause: string): "fault" | "credit" | "no_fault" | "undetermined" => {
  switch (canonicalCause(cause)) {
    case "good_call":
    case "good_wait":
      return "credit";
    case "sound_call_lost":
      return "no_fault";
    case "inconclusive":
    case "plan_incoherent":
      return "undetermined";
    default:
      return "fault";
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
  // A call that declined to trade, measured over the window the tracker
  // actually graded and no further.
  //
  // Without this the WAIT would be handed the trade windows: the 24-bar
  // after-window past settlement, a life horizon running the same distance,
  // and counterfactuals simulated over EXPIRY_DAYS. Every one of those can
  // report that the declined trade reached its target AFTER the window the
  // verdict was decided in — which is precisely the hindsight this phase
  // exists to remove, arriving through the back door as "facts". The
  // diagnosis would then contradict the verdict on the same row, and
  // wait_missed_trade can support a rulebook rule.
  //
  // `waitUntilMs` is the end of that graded window (marketHorizonEnd of the
  // WAIT's own horizon). `waitHint` replaces the deterministic
  // pre-classification, which is built from the trade taxonomy and would
  // otherwise hand the model "good_call" on a call the tracker scored as a
  // missed trade.
  wait?: { untilMs: number; hint: Cause } | null;
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
  // measures. A WAIT stops at the end of the window its verdict was decided
  // in: anything past it is a fact about a different question.
  const wait = ctx.wait ?? null;
  const horizonMs = wait
    ? wait.untilMs
    : Number.isFinite(resolvedMs) ? resolvedMs + windowMs : Infinity;
  const life = post.filter((x) => x.t < horizonMs);

  let maxFav: number | null = null;
  let maxAdv: number | null = null;
  // The same favourable excursion, stopped at the settlement. A WAIT has no
  // settlement, so its window IS its life and the two coincide.
  let maxFavLife: number | null = null;
  const lifeEndsMs = wait ? wait.untilMs : Number.isFinite(resolvedMs) ? resolvedMs : Infinity;
  if (reference !== null && life.length > 0) {
    maxFav = 0;
    maxAdv = 0;
    maxFavLife = 0;
    for (const { c, t } of life) {
      const fav = signal === "BUY" ? c.high - reference : reference - c.low;
      maxFav = Math.max(maxFav, fav);
      maxAdv = Math.max(maxAdv, signal === "BUY" ? reference - c.low : c.high - reference);
      if (t <= lifeEndsMs) maxFavLife = Math.max(maxFavLife, fav);
    }
  }

  // After the settlement. Empty for a WAIT: "what happened once it was over"
  // is exactly the evidence that must not reach a judgement about whether
  // declining was right at the time.
  const after = !wait && Number.isFinite(resolvedMs)
    ? post.filter((x) => x.t > resolvedMs && x.t < resolvedMs + windowMs)
    : [];
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
  // A WAIT gets none of these. cf.market_entry is the identical trade the
  // tracker already graded, re-judged over EXPIRY_DAYS instead of the WAIT's
  // own horizon — so it can report "win" on a row whose verdict is "correct",
  // and the two would sit in the same payload contradicting each other.
  if (!wait && reference !== null && !filled && coherentAt(reference)) {
    cf.market_entry = await simulate(row, { entry_point: reference, price_at_signal: reference }, candles, evalInterval, nowMs, gateCtx);
  }
  if (!wait && reference !== null && !filled && risk > 0 && coherentAt(reference, against(reference, 1))) {
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

  // Deterministic reading, for the model to confirm or overrule with reasons.
  //
  // A WAIT's is decided by the verdict alone and short-circuits the whole
  // switch below: that switch reads the synthesised trade's outcome, so it
  // would file "good_call" on a call the tracker scored as a missed trade,
  // and "stop_too_tight" — a hint about a stop on a position nobody opened —
  // on one it scored as correct. Neither is even in the WAIT vocabulary, so
  // the model would be handed a pre-classification its own schema forbids.
  const hints: Cause[] = wait ? [wait.hint] : [];
  const push = (c: Cause) => {
    if (wait || hints.includes(c)) return;
    hints.push(c);
  };
  const maxFavR = toR(maxFav);
  const maxFavLifeR = toR(maxFavLife);
  const maxAdvR = toR(maxAdv);
  const beyondSlR = after.length > 0 ? toR(beyondSl) : null;
  const won = (r: CfResult | null) => r?.resolution === "win";
  // A counterfactual only counts as a remedy when the gate would publish it
  const wonViable = (r: CfResult | null) => won(r) && r?.viable === true;
  const marketOrder = (ev?.order_type ?? "unknown") === "market";
  const marketV1 = ctx.contract === MARKET_CONTRACT;
  const settledAs = ev?.resolution ?? row.outcome;

  // Assembled BEFORE the switch, and returned unchanged at the end. The loss
  // branch has to ask noFaultGrounds whether any lever moves, and that
  // question is asked of the facts row a later reader will see — not of a
  // parallel set of locals that could answer it differently. `hints` and
  // `notes` are the same arrays push() and notes.push() write to, so the
  // branches below keep filling them in place.
  const facts: PostmortemFacts = {
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
    from_signal: { max_favorable_r: maxFavR, max_adverse_r: maxAdvR, max_favorable_r_in_life: maxFavLifeR },
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
    mae_r: typeof ev?.mae_r === "number" && Number.isFinite(ev.mae_r) ? ev.mae_r : null,
    bars_in_life: during.length,
    no_fault_grounds: null,
    resolution: settledAs,
    hints,
    notes,
  };

  switch (settledAs) {
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
      // The two POSITIVE tests for a wrong direction: price kept running past
      // the stop, or it never came DIRECTION_DEAD_R our way in the first
      // place. What stood here as well was a fallback — "no other lever
      // fired, so blame the direction" — and it was the largest single source
      // of the verdict: four of the six live direction_wrong diagnoses came
      // out of it, three of those four cited by rule r10. Blaming the
      // direction for the absence of evidence is exactly the reading the
      // owner asked not to make, so the fallback is gone and the second
      // positive test replaces the part of its work that was real.
      if (beyondSlR !== null && beyondSlR >= 1 && tp1Touch === null) push("direction_wrong");
      // maxFavLifeR, not maxFavR: "it never came our way" is a question about
      // the trade's life. Measured over life + after-window instead, a plan
      // that died flat and then bounced once the stop was already paid would
      // read as though the direction had been fine — post-decision noise
      // deciding a verdict about the decision.
      if (maxFavLifeR !== null && maxFavLifeR < DIRECTION_DEAD_R) push("direction_wrong");
      if (abnormal !== null) push("news_shock");
      // Recorded whichever way it comes out, so a reader of the stored row can
      // see which lever refused the verdict rather than only that it was
      // refused. Computed after the tests above because clause 9 reads hints.
      // Not for a WAIT. The switch reads the synthesised trade's outcome, so a
      // declined plan whose shadow lost arrives here — and a lever table about
      // a position nobody opened has no business riding along in the payload.
      const grounds = wait ? null : noFaultGrounds(facts);
      facts.no_fault_grounds = grounds;
      // "No lever we can move would have changed this outcome" and "there is
      // not yet enough basis to change anything" are different findings and
      // must not share a bucket: the first is a finished review of a loss, the
      // second is a review that could not be finished.
      if (hints.length === 0) push(grounds?.allowed ? "sound_call_lost" : "inconclusive");
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
    case "expired": {
      // The same test the loss branch and causeGrounds use. The `||` that
      // stood here let a large excursion carry the cause on its own, on a row
      // where the halved target was computed and lost — a hint its own
      // grounding table called contradicted, and the one place the server
      // disagreed with itself about what target_too_far means.
      const halfMoved = leverMoved("tp_half", cf.tp_half?.resolution ?? null, settledAs);
      if (halfMoved === true || (halfMoved === null && (ev?.mfe_r ?? 0) >= 0.5)) push("target_too_far");
      else push("inconclusive");
      break;
    }
    case "win": {
      // A win is lucky when any of the danger flags is up — the deep MAE
      // that always made one, or a trade that spent most of its bars
      // underwater, chopped around its entry, took the target on a wick
      // that reversed, or needed most of its allowed life. A win with no
      // flags is a good call as far as the bars can tell; the model may
      // still overrule that from the plan.
      const maeR = facts.mae_r;
      const dz = danger;
      if (dz) dz.flags = dangerFlags(dz, maeR);
      // A win whose fill instant is not on record (an early version wrote
      // filled_at null) has no bars to walk, but its MAE is on record and
      // the rule that read it never needed the walk. The decision itself is
      // luckyWinSupported's, read off the same facts row a later grounding
      // check will read, so the two cannot come to different answers about
      // the same win; the flag list here is only for the note.
      const flags: DangerFlag[] = dz ? dz.flags : (maeR ?? 0) >= LUCKY_MAE_R ? ["deep_mae"] : [];
      push(luckyWinSupported(facts) ? "lucky_win" : "good_call");
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

  return facts;
};
