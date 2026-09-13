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
// Deno-free on purpose: src/test/conditional-wait.test.ts imports this file.

export const CONDITIONAL_WAIT_VERSION = 1;

// How far a trigger may sit from the price that was on screen, in ATR. Below
// the floor it is inside the noise the plan is already standing aside from;
// above the ceiling it is a level the entry timeframe cannot plausibly reach
// inside the window, which would make "it never came" meaningless.
export const MIN_TRIGGER_ATR = 0.25;
export const MAX_TRIGGER_ATR = 3.0;

// The longest a conditional view may stay alive, in ENTRY-timeframe bars.
// Bounded so the claim resolves inside the same window the WAIT itself is
// scored over rather than trailing a plan nobody is watching any more.
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
  // What the price was when the claim was made. Kept so the claim can be read
  // later without trusting that some other column still holds the same number.
  price_at_call: number;
  atr_at_call: number | null;
  distance_atr: number | null;
}

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
  const distanceAtr = Math.abs(trigger - input.price) / input.atr;
  if (distanceAtr < MIN_TRIGGER_ATR) return { ok: false, rejection: "too_close" };
  if (distanceAtr > MAX_TRIGGER_ATR) return { ok: false, rejection: "too_far" };

  return {
    ok: true,
    value: {
      version: 1,
      trigger_price: round(trigger, input.decimals),
      trigger_side: side,
      then_signal: then,
      // Clamped rather than refused: an over-long window is a claim about the
      // right level with the wrong patience, and throwing the level away over
      // that loses more than it protects.
      expires_bars: Math.max(1, Math.min(MAX_EXPIRES_BARS, Math.round(bars))),
      thesis_if_triggered: thesis.slice(0, 120),
      price_at_call: round(input.price, input.decimals),
      atr_at_call: round(input.atr, input.decimals),
      distance_atr: round(distanceAtr, 2),
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
  window_ends_at: string;
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

// THE WINDOW IS A DURATION, NOT A BAR COUNT, AND THAT IS THE WHOLE CARE HERE.
//
// `expires_bars` is written in ENTRY-timeframe bars, because that is the chart
// the analyst was looking at. The series this is scored on is finer:
// EVAL_INTERVAL maps 1h -> 15min and 4h/1day -> 1h, so the same number means 4
// bars where the analyst meant 4 hours, and 24 where the analyst meant 24
// days. Slicing the supplied array by `expires_bars` would therefore cut the
// window by 4x to 24x on every timeframe but 15min, and the arm would report a
// flood of `not_triggered` that is an artefact of the unit and nothing else —
// a failure that reads exactly like a finding.
//
// So the caller passes the length of ONE ENTRY BAR and the instant of the
// call, and the deadline is computed here.
//
// The trigger is a TOUCH — high/low, not close — because a level the market
// reached is a level the market reached; requiring a close would score the
// claim on a stricter rule than the one it was written under.
export const scoreConditionalWait = (input: {
  plan: ConditionalWait;
  // Bars strictly AFTER the call, ascending. Anything at or before the call is
  // the caller's to drop: a bar the claim was made inside already contains the
  // price the claim was measured against, and letting it count would hand a
  // free trigger to any level inside that bar's range.
  barsAfterCall: ScorableBar[];
  // One entry-timeframe bar, in milliseconds.
  entryBarMs: number;
  // When the claim was made.
  signalMs: number;
}): ConditionalOutcome => {
  const { plan } = input;
  const windowMs = plan.expires_bars * Math.max(1, input.entryBarMs);
  const deadline = input.signalMs + windowMs;
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
