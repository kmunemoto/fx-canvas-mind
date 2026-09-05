// Was standing aside the right call?
//
// A WAIT is a prediction too — "there is no trade worth taking here right
// now" — and until this module existed it was the one prediction the app
// never checked. That mattered more than it looks: the outcome 'untriggered'
// used to carry the reason 'missed' (price ran to the target without ever
// coming back to the entry), and that was the ONLY signal in the whole system
// for "too cautious". Everything else — a loss, a stop too tight — punishes
// being too bold. Remove the unfilled-limit case without replacing it and the
// learning loop can only ever push one way, toward trading less, until the
// analyst answers WAIT to everything and is never wrong again.
//
// So a WAIT is scored against what the market then did. The test invents no
// new thresholds: it asks whether the SMALLEST trade this app would itself
// have allowed — the tightest stop the entry gate permits, and the nearest
// target that still clears its risk/reward floor — would have won from the
// price at the moment of the call.
//
// WHICH SIDE that trade is on has to be decided at the call, and it is: the
// plan is built and stored by analyze (`waitPlanFor`) and only resolved here.
// The first version of this file walked a long AND a short and called the
// WAIT a miss if either paid. Nothing at the moment of the call chose the
// side — the outcome did — so a market that wandered 0.48 ATR the wrong way
// and then 0.4 ATR the right way scored as a missed trade, and a market that
// did the reverse scored as one too. Over enough bars almost every market
// does one or the other. It was measuring the market's range and reporting it
// as the analyst's over-caution, in the one number that exists to detect
// over-caution.
//
// A row with no stored plan, or a plan whose direction nothing at the time
// named, is not scored at all: `no_call`. An unmeasurable call is a smaller
// loss than a fabricated verdict.
//
// Deno-free on purpose: src/test/waits.test.ts imports this file directly.

import { MIN_RISK_REWARD, MIN_STOP_ATR, WAIT_SCORER, type WaitPlan } from "../analyze/entry.ts";
import { isMarketClosed } from "./quotes.ts";

export type { WaitPlan };

export interface WaitBar {
  // Bar open, epoch ms
  t: number;
  high: number;
  low: number;
}

export type WaitVerdict =
  // The trade named at the call was there, and it won
  | "missed"
  // That trade was stopped out, or never paid inside the window
  | "correct"
  // Not enough market time has passed to say yet
  | "pending"
  // The call predates the data needed to judge it (no ATR or no signal price)
  | "unknown"
  // Nothing at the moment of the call named a side, so there is no prediction
  // to score. Terminal, and deliberately not counted either way.
  | "no_call";

export interface WaitCheck {
  verdict: WaitVerdict;
  // The direction fixed AT THE CALL, echoed here so a reader of this object
  // alone can see what was graded. Never chosen from the outcome.
  direction: "BUY" | "SELL" | null;
  plan_direction: "BUY" | "SELL" | null;
  direction_source: string | null;
  // What that minimal trade paid, in multiples of its own risk: the stored
  // plan's own reward/risk when it won, −1 when it was stopped.
  r: number | null;
  // When the target was reached
  at: string | null;
  // The levels the test used, so the judgement can be checked by hand
  price: number | null;
  atr: number | null;
  risk: number | null;
  reward: number | null;
  stop: number | null;
  target: number | null;
  bars_examined: number;
  horizon_ms: number;
  checked_at: string;
  // Which scoring rule produced this verdict. Verdicts from different rules
  // are different measurements and must not be pooled into one miss rate.
  scorer: number;
}

// Where a horizon of `horizonMs` of OPEN market ends, starting from `fromMs`.
// Walked at a coarse step because the answer only has to be right to within an
// hour: the alternative is grading a Friday WAIT against a weekend.
const HORIZON_STEP_MS = 30 * 60_000;
export const marketHorizonEnd = (fromMs: number, horizonMs: number): number => {
  let open = 0;
  let t = fromMs;
  // A hard stop so a pathological input cannot spin: at worst this walks four
  // weeks of wall clock to bank the requested open time.
  const limit = fromMs + horizonMs + 28 * 24 * 60 * 60_000;
  while (open < horizonMs && t < limit) {
    if (!isMarketClosed(t)) open += HORIZON_STEP_MS;
    t += HORIZON_STEP_MS;
  }
  return t;
};

// The tightest stop the gate would allow, and the nearest target that still
// clears the risk/reward floor. Both come from the app's own constants: a
// WAIT is judged against the least the app would have demanded of a trade,
// not against a threshold invented for the purpose.
//
// Kept exported for the tests and for anyone reconstructing an old verdict by
// hand; the scorer itself now reads the levels off the stored plan, because
// the plan was sized by these same constants at the moment of the call and a
// later change to them must not silently re-grade calls already made.
export const minimalTrade = (atr: number): { risk: number; reward: number } => {
  const risk = MIN_STOP_ATR * atr;
  return { risk, reward: MIN_RISK_REWARD * risk };
};

interface SideState {
  stopped: boolean;
  won: boolean;
  at: number | null;
}

// The hypothetical trade walked through one bar.
//
// A bar that reaches both levels is treated as a stop-out, not a win. The
// order within the bar is unknowable at this resolution, and a WAIT should
// only be called a miss on evidence that is not in doubt.
const walk = (
  state: SideState,
  bar: WaitBar,
  stopLevel: number,
  targetLevel: number,
  dir: "BUY" | "SELL",
): SideState => {
  if (state.stopped || state.won) return state;
  const hitStop = dir === "BUY" ? bar.low <= stopLevel : bar.high >= stopLevel;
  const hitTarget = dir === "BUY" ? bar.high >= targetLevel : bar.low <= targetLevel;
  if (hitStop) return { ...state, stopped: true };
  if (hitTarget) return { ...state, won: true, at: bar.t };
  return state;
};

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Score a WAIT against the bars that followed it.
 *
 * `plan` is the trade fixed at the moment of the call (analyze's
 * `waitPlanFor`). Without one — or without a direction on it — there is no
 * prediction to grade and the verdict is `no_call`.
 *
 * `bars` must start at or after the signal and be ordered oldest first.
 * Bars stamped inside the weekend break are skipped: a level "reached" while
 * nobody could trade was never reached.
 */
export const judgeWait = (
  input: {
    price: number | null;
    atr: number | null;
    signalMs: number;
    horizonMs: number;
  },
  plan: WaitPlan | null,
  bars: WaitBar[],
  nowMs: number,
): WaitCheck => {
  const checked_at = new Date(nowMs).toISOString();
  const base: WaitCheck = {
    verdict: "unknown",
    direction: plan?.direction ?? null,
    plan_direction: plan?.direction ?? null,
    direction_source: plan?.direction_source ?? null,
    r: null,
    at: null,
    // The stored plan's own numbers when it has them: those are what was
    // graded. The row's columns are the fallback for a plan that got as far
    // as being written but not sized.
    price: plan && finite(plan.entry) ? plan.entry : input.price,
    atr: plan && finite(plan.atr) ? plan.atr : input.atr,
    risk: plan && finite(plan.risk) ? plan.risk : null,
    reward: plan && finite(plan.reward) ? plan.reward : null,
    stop: plan && finite(plan.stop) ? plan.stop : null,
    target: plan && finite(plan.target) ? plan.target : null,
    bars_examined: 0,
    horizon_ms: input.horizonMs,
    checked_at,
    scorer: WAIT_SCORER,
  };

  // No plan, or a plan nothing at the time gave a side to: unmeasurable, and
  // said so. Terminal — re-running the sweep will not conjure a direction the
  // row never carried, and the alternative (picking the side that paid) is
  // the bias this whole module was rewritten to remove.
  if (!plan || plan.direction === null) return { ...base, verdict: "no_call" };
  if (!finite(plan.entry) || !finite(plan.stop) || !finite(plan.target) || !finite(plan.risk) || !finite(plan.reward)) {
    return base;
  }

  const direction = plan.direction;

  // The horizon is MARKET time, not wall clock.
  //
  // Measured in wall clock, a WAIT issued on a Friday spends most of its
  // 48-hour window on a shut market: almost no bars survive the weekend
  // filter, the trade is neither stopped nor paid, the window runs out, and
  // the call is graded "correct" on no evidence at all. Since the whole point
  // is to detect over-caution, a WAIT that grades itself correct for free is
  // the failure mode to avoid. Walk forward one interval at a time and only
  // count the hours the market was open.
  const until = marketHorizonEnd(input.signalMs, input.horizonMs);
  const usable = bars
    .filter((b) => b.t > input.signalMs && b.t <= Math.min(until, nowMs))
    .filter((b) => !isMarketClosed(b.t))
    .filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low))
    .sort((a, b) => a.t - b.t);

  let side: SideState = { stopped: false, won: false, at: null };
  for (const bar of usable) {
    side = walk(side, bar, plan.stop, plan.target, direction);
    if (side.stopped || side.won) break;
  }

  const examined = { ...base, bars_examined: usable.length };

  // The trade named at the call was there and it paid. THIS is the miss, and
  // it is the app's only evidence of over-caution.
  if (side.won) {
    return {
      ...examined,
      verdict: "missed",
      r: Number((plan.reward / plan.risk).toFixed(2)),
      at: side.at === null ? null : new Date(side.at).toISOString(),
    };
  }

  // Stopped out: the trade declined was a losing one, and that is settled
  // even if the horizon has not run out.
  if (side.stopped) return { ...examined, verdict: "correct", r: -1 };

  // Still inside the window and still alive: no verdict yet.
  if (nowMs < until) return { ...examined, verdict: "pending" };

  // The window ran out with the trade neither paid nor stopped. Standing
  // aside cost nothing, and it saved nothing either: r stays null rather
  // than claiming a loss that never happened.
  return { ...examined, verdict: "correct" };
};
