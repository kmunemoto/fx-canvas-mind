// A WAIT THAT NAMES WHAT WOULD CHANGE ITS MIND (#86).
//
// WHAT THIS IS. When the answer is WAIT, the analyst may also say: "not here,
// but if price touches X from this side within N bars, that is a BUY." This
// module validates that claim and, later, scores it against what the market
// actually did.
//
// WHAT THIS IS NOT, and the reason is measured. It is NEVER an order. #37
// recorded what happened when the analyst chose the price it filled at: 5 of 8
// BUY/SELL went unfilled, and every one of those 5 carried the analyst's own
// Trend Day / Breakout tag pointing the same way as the signal. analyze's
// should_be_market rule exists to refuse that exact shape. A conditional WAIT
// that became a resting order would walk straight back into it. So the plan
// the reader sees is still a WAIT with no levels; this is a PREDICTION kept
// beside it and marked right or wrong afterwards.
//
// THE FREE PASS THIS MODULE EXISTS TO CLOSE. The existing WAIT scorer returns
// `correct` with no R when the window runs out and nothing was taken. A
// conditional WAIT whose trigger never came would fall into that and score as
// a correct call — which would make naming an unreachable level the cheapest
// way to look right. `not_triggered` is therefore its own terminal verdict,
// and it is NOT a pass: the analyst said the level mattered, and it never
// came.
//
// WHAT THIS SCORE CANNOT TELL ANYONE. Written here rather than in a doc,
// because the number leaves this file and the caveats do not follow it.
//
//  * `triggered_right` is decided by the SIGN of the move from the trigger to
//    the last close in the window. In a market with any drift, that sign is
//    mostly the drift. Simulated against this exact rule (40k paths per cell,
//    sigma set so a 1h true range is about 1 ATR, trigger at 1.0 ATR,
//    expires_bars 6): with no drift a continuation claim scores ~52%; at 0.1
//    ATR per bar of drift — an ordinary weak trend — it scores ~64% with no
//    foresight whatsoever. So the null is NOT 50%, and an analyst that reads
//    the regime it is already shown and names it will look right. That is why
//    `trend_at_call` is on every claim: the score is only readable split by it.
//  * It is not a tradeable result. There is no stop, no target and no
//    excursion here, so `triggered_right` cannot be put on the same axis as
//    the record's R per trade — at the longest expiry a majority of "right"
//    verdicts are claims a real trade would have been stopped out of first,
//    at this app's own minimum stop.
//  * The n needed is large. Against a 50% null, detecting 60% needs ~194
//    RESOLVED claims (not_triggered, triggered_unresolved and unmeasurable are
//    all outside that denominator). Against the drifting null above it is
//    larger still. The arm is admin-only and opt-in, so that n is far away,
//    and any early ratio is noise with a label on it.
//
// Deno-free on purpose: src/test/conditional-wait.test.ts imports this file.
// analyze/entry.ts is Deno-free too, so the gate's own floor imports cleanly.

import { MIN_STOP_ATR } from "../analyze/entry.ts";

export const CONDITIONAL_WAIT_VERSION = 1;

// How far a trigger may sit from the price that was on screen, in ATR. Below
// the floor it is inside the noise the plan is already standing aside from;
// above the ceiling it is a level the entry timeframe cannot plausibly reach
// inside the window, which would make "it never came" meaningless.
//
// The floor is MIN_STOP_ATR (analyze/entry.ts), IMPORTED rather than copied:
// a copied 0.4 would go on claiming they are the same number after the next
// calibration moved one of them, which is a comment becoming a lie about a
// live threshold.
// It was 0.25 and that was incoherent: the gate refuses a stop closer than
// 0.4 ATR because inside that distance the app calls the move noise, so a
// trigger at 0.3 ATR was a level this same app does not believe in, being
// scored as though it were a level. The two floors are the same statement
// about the same market and there is no reason for them to disagree.
export const MIN_TRIGGER_ATR = MIN_STOP_ATR;
export const MAX_TRIGGER_ATR = 3.0;

// How long a conditional view may stay alive, in ENTRY-timeframe bars.
//
// The FLOOR stops a claim from being unfalsifiable, and it is worth being
// exact about where that is true, because an earlier version of this comment
// was not. The scoring series is EVAL_INTERVAL, which equals the entry frame
// only on 15min (1h -> 15min, 4h/1day -> 1h). So a one-bar window holds:
//   15min  -> 1 eval bar   — a touch leaves nothing after it. Unfalsifiable:
//                            `triggered_unresolved` or `not_triggered`, never
//                            wrong. A claim that cannot be wrong is not a
//                            prediction, and it would sit in the same column
//                            as ones that can.
//   1h     -> 4 eval bars
//   4h     -> 4 eval bars
//   1day   -> 24 eval bars
// Only 15min is structurally unfalsifiable at one bar; the others are merely
// very short. The floor is set for all of them anyway — one floor that is
// sometimes stricter than it needs to be beats a per-timeframe floor nobody
// can hold in their head, and a claim about the next bar or two is a claim
// about noise on any of these frames.
//
// The CEILING keeps the claim resolving inside the window the WAIT itself is
// scored over rather than trailing a plan nobody is watching any more.
export const MIN_EXPIRES_BARS = 3;
export const MAX_EXPIRES_BARS = 24;

export type TriggerSide = "above" | "below";
export type ThenSignal = "BUY" | "SELL";

export interface ConditionalWait {
  version: 1;
  trigger_price: number;
  trigger_side: TriggerSide;
  then_signal: ThenSignal;
  expires_bars: number;
  thesis_if_triggered: string;
  // Whether the window stored above is the one the analyst asked for. A claim
  // written with a 400-bar expiry and kept at 24 is not the claim that was
  // made, and a reader comparing stored windows cannot otherwise tell.
  expires_clamped: boolean;
  // What the price was when the claim was made. Kept so the claim can be read
  // later without trusting that some other column still holds the same number.
  price_at_call: number;
  atr_at_call: number | null;
  distance_atr: number | null;
  // WHICH WAY THE MARKET WAS ALREADY GOING, and whether this claim agrees.
  //
  // Without this the score is uninterpretable, because `triggered_right` is
  // decided by the sign of the move after the touch and a trending window
  // produces that sign on its own. An analyst that simply names the
  // prevailing direction scores well above half with no foresight at all, and
  // nothing else in the row would let a reader subtract that.
  //
  // Read off the gate's own regime reading at the moment of the call — not
  // recomputed later, which would be reading the answer off the outcome.
  // "unknown" when the gate saw no directional regime, which is a third of
  // the population and must not be silently folded into either side.
  trend_at_call: TrendRelation;
}

// This claim relative to the regime the gate already measured.
export type TrendRelation = "with_trend" | "against_trend" | "unknown";

// Why a claim was thrown away. Recorded rather than silently dropped: an arm
// whose output is discarded 80% of the time is an arm that is not running, and
// the row has to be able to say so.
export type ConditionalRejection =
  | "absent"
  | "not_a_wait"
  | "malformed"
  | "wrong_side"
  | "too_close"
  | "too_far"
  | "no_atr";

export type ConditionalRead =
  | { ok: true; value: ConditionalWait }
  | { ok: false; rejection: ConditionalRejection };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const round = (v: number, d: number) => Number(v.toFixed(d));

export const readConditionalWait = (input: {
  raw: unknown;
  signal: string;
  price: number;
  atr: number | null;
  decimals: number;
  // The gate's regime reading at the call: "Up" / "Down", or null when it saw
  // no directional regime. Passed in rather than derived here — this module
  // has no indicators and inventing one would be inventing the control.
  regimeDirection?: "Up" | "Down" | null;
}): ConditionalRead => {
  if (input.raw === undefined || input.raw === null) return { ok: false, rejection: "absent" };
  // Only a WAIT can carry one. On a published BUY/SELL the plan itself is the
  // claim, and a second conditional one beside it would be two answers.
  if (input.signal !== "WAIT") return { ok: false, rejection: "not_a_wait" };
  if (!isRecord(input.raw)) return { ok: false, rejection: "malformed" };

  const trigger = num(input.raw.trigger_price);
  const side = input.raw.trigger_side === "above" || input.raw.trigger_side === "below"
    ? input.raw.trigger_side
    : null;
  const then = input.raw.then_signal === "BUY" || input.raw.then_signal === "SELL"
    ? input.raw.then_signal
    : null;
  const bars = num(input.raw.expires_bars);
  const thesis = typeof input.raw.thesis_if_triggered === "string"
    ? input.raw.thesis_if_triggered.trim()
    : "";
  if (trigger === null || side === null || then === null || bars === null || thesis === "") {
    return { ok: false, rejection: "malformed" };
  }
  if (!Number.isFinite(input.price) || input.price <= 0) return { ok: false, rejection: "malformed" };

  // The side and the level have to agree. "Above" with a trigger below the
  // market is already true the moment it is written, which would score as an
  // instant free hit.
  if (side === "above" && trigger <= input.price) return { ok: false, rejection: "wrong_side" };
  if (side === "below" && trigger >= input.price) return { ok: false, rejection: "wrong_side" };

  // Distance is judged in ATR because pips mean different things per pair and
  // per regime. Without an ATR there is no scale to judge it on, and guessing
  // one would be inventing the check.
  if (input.atr === null || !Number.isFinite(input.atr) || input.atr <= 0) {
    return { ok: false, rejection: "no_atr" };
  }
  // Compared at the precision it is REPORTED at, not at full binary precision.
  // 150.2 - 150.0 is 0.19999999999998863 in IEEE754, so a trigger sitting
  // exactly on the floor lands either side of it depending on representation
  // noise — and the row would then store `distance_atr: 0.4` beside a
  // `too_close` refusal, which is a row contradicting itself. The stored number
  // is the one the rule is about.
  const distanceAtr = round(Math.abs(trigger - input.price) / input.atr, 2);
  if (distanceAtr < MIN_TRIGGER_ATR) return { ok: false, rejection: "too_close" };
  if (distanceAtr > MAX_TRIGGER_ATR) return { ok: false, rejection: "too_far" };

  // Clamped rather than refused: a window outside the bounds is a claim about
  // the right level with the wrong patience, and throwing the level away over
  // that loses more than it protects. Recorded as clamped, though — see
  // `expires_clamped`.
  const asked = Math.round(bars);
  const expires = Math.max(MIN_EXPIRES_BARS, Math.min(MAX_EXPIRES_BARS, asked));

  const regime = input.regimeDirection ?? null;
  const trend: TrendRelation = regime === null
    ? "unknown"
    : (regime === "Up") === (then === "BUY")
    ? "with_trend"
    : "against_trend";

  return {
    ok: true,
    value: {
      version: 1,
      trigger_price: round(trigger, input.decimals),
      trigger_side: side,
      then_signal: then,
      expires_bars: expires,
      expires_clamped: expires !== asked,
      thesis_if_triggered: thesis.slice(0, 120),
      price_at_call: round(input.price, input.decimals),
      atr_at_call: round(input.atr, input.decimals),
      distance_atr: distanceAtr,
      trend_at_call: trend,
    },
  };
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ConditionalVerdict =
  // The level never came inside the window. NOT a pass — see the header.
  | "not_triggered"
  // It came, and the direction it named was right / wrong over the rest of the
  // window, measured on the bars after the touch.
  | "triggered_right"
  | "triggered_wrong"
  // It came so late that there are no bars left to judge the direction on.
  | "triggered_unresolved"
  // No bars in the window: nothing was observed, and that is said rather than
  // guessed. Distinct from `not_triggered`, which is a real observation that
  // the level did not come.
  | "unmeasurable";

export interface ConditionalOutcome {
  version: 1;
  verdict: ConditionalVerdict;
  triggered_at: string | null;
  // Counted in the bars that were SUPPLIED — the scoring series, which is
  // finer than the entry timeframe (track-outcomes/evaluate.ts EVAL_INTERVAL
  // puts a 1h plan on 15min bars). Not comparable to `expires_bars`, which is
  // in entry bars. `triggered_at` is the unit-free fact; this is for reading
  // how early in the window it happened.
  bars_to_trigger: number | null;
  bars_examined: number;
  // Null only when the caller handed a deadline that was not a number.
  window_ends_at: string | null;
  // Where price went after the touch, in the direction the claim named.
  // Positive means the named direction was the profitable one.
  move_after_atr: number | null;
}

export interface ScorableBar {
  datetime: string;
  high: number;
  low: number;
  close: number;
}

// HOW LONG THE CLAIM IS ALIVE, IN MILLISECONDS OF MARKET TIME.
//
// `expires_bars` is written in ENTRY-timeframe bars, because that is the chart
// the analyst was looking at. The series this is scored on is finer:
// EVAL_INTERVAL maps 1h -> 15min and 4h/1day -> 1h, so the same number means 4
// bars where the analyst meant 4 hours, and 24 where the analyst meant 24
// days. Slicing the supplied array by `expires_bars` would cut the window by
// 4x to 24x on every timeframe but 15min, and the arm would report a flood of
// `not_triggered` that is an artefact of the unit and nothing else — a failure
// that reads exactly like a finding.
//
// Exported and tested separately because the caller has to hand this to
// `marketHorizonEnd` (see below) and the conversion must not be re-derived at
// the call site, where nothing would catch it going wrong again.
export const conditionalWindowMs = (plan: ConditionalWait, entryBarMs: number): number =>
  plan.expires_bars * Math.max(1, entryBarMs);

// AND THE DEADLINE IS MARKET TIME, NOT WALL CLOCK — which is the other half of
// the same mistake, and one this codebase has already made once.
//
// track-outcomes/waits.ts:203 records what it cost there: "a WAIT issued on a
// Friday spends most of its 48-hour window on a shut market: almost no bars
// survive the weekend filter... and the call is graded 'correct' on no
// evidence at all." A conditional claim measured on the wall clock fails the
// same way pointing the other direction: a Friday claim gets a fraction of the
// hours it asked for, nothing touches the level, and the row says
// `not_triggered` — which is terminal, because the pending index only selects
// rows with no outcome yet. Nothing ever comes back to correct it, and the
// result is a day-of-week artefact in the verdict this whole design turns on.
//
// So the CALLER passes the deadline, computed with the market-time walk that
// already exists (`marketHorizonEnd`), and passes bars with the closed-market
// ones already dropped. Two copies of a market calendar is how the two drift;
// this module keeps the part that is pure and testable.
//
// The trigger is a TOUCH — high/low, not close — because a level the market
// reached is a level the market reached; requiring a close would score the
// claim on a stricter rule than the one it was written under.
export const scoreConditionalWait = (input: {
  plan: ConditionalWait;
  // Bars strictly AFTER the call, ascending, with closed-market bars already
  // dropped. Anything at or before the call is the caller's to drop too: a bar
  // the claim was made inside already contains the price the claim was
  // measured against, and letting it count would hand a free trigger to any
  // level inside that bar's range.
  barsAfterCall: ScorableBar[];
  // When the claim was made.
  signalMs: number;
  // When the window closes, in MARKET time — `marketHorizonEnd(signalMs,
  // conditionalWindowMs(plan, entryBarMs))`.
  deadlineMs: number;
}): ConditionalOutcome => {
  const { plan } = input;
  const deadline = input.deadlineMs;
  // A non-finite deadline would throw out of `new Date(...).toISOString()`,
  // and this runs inside a loop over rows in the sweep — one bad row would
  // take the whole pass down with it rather than being one unscored row.
  if (!Number.isFinite(deadline)) {
    return {
      version: 1,
      verdict: "unmeasurable",
      triggered_at: null,
      bars_to_trigger: null,
      bars_examined: 0,
      window_ends_at: null,
      move_after_atr: null,
    };
  }
  const windowEndsAt = new Date(deadline).toISOString();

  const window = input.barsAfterCall.filter((b) => {
    const t = Date.parse(b.datetime);
    return Number.isFinite(t) && t > input.signalMs && t <= deadline;
  });

  if (window.length === 0) {
    return {
      version: 1,
      verdict: "unmeasurable",
      triggered_at: null,
      bars_to_trigger: null,
      bars_examined: 0,
      window_ends_at: windowEndsAt,
      move_after_atr: null,
    };
  }

  const hit = (b: ScorableBar) =>
    plan.trigger_side === "above" ? b.high >= plan.trigger_price : b.low <= plan.trigger_price;

  let idx = -1;
  for (let i = 0; i < window.length; i++) {
    if (hit(window[i])) { idx = i; break; }
  }

  if (idx === -1) {
    return {
      version: 1,
      verdict: "not_triggered",
      triggered_at: null,
      bars_to_trigger: null,
      bars_examined: window.length,
      window_ends_at: windowEndsAt,
      move_after_atr: null,
    };
  }

  const triggeredAt = window[idx].datetime;
  // What happened after the touch, over what remains of the window.
  const after = window.slice(idx + 1);
  if (after.length === 0) {
    return {
      version: 1,
      verdict: "triggered_unresolved",
      triggered_at: triggeredAt,
      bars_to_trigger: idx + 1,
      bars_examined: window.length,
      window_ends_at: windowEndsAt,
      move_after_atr: null,
    };
  }

  const last = after[after.length - 1].close;
  const signed = plan.then_signal === "BUY"
    ? last - plan.trigger_price
    : plan.trigger_price - last;
  const atr = plan.atr_at_call;
  const moveAtr = atr !== null && atr > 0 ? Number((signed / atr).toFixed(2)) : null;

  return {
    version: 1,
    // Judged on the sign only. A magnitude threshold here would be a number
    // nobody measured, and the R this claim would have earned depends on a
    // stop it was never given — the claim is a direction, so it is scored as
    // one.
    verdict: signed > 0 ? "triggered_right" : "triggered_wrong",
    triggered_at: triggeredAt,
    bars_to_trigger: idx + 1,
    bars_examined: window.length,
    window_ends_at: windowEndsAt,
    move_after_atr: moveAtr,
  };
};
