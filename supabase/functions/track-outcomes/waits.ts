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
// Deno-free on purpose: src/test/waits.test.ts imports this file directly.

import { MIN_RISK_REWARD, MIN_STOP_ATR } from "../analyze/entry.ts";
import { isMarketClosed } from "./quotes.ts";

export interface WaitBar {
  // Bar open, epoch ms
  t: number;
  high: number;
  low: number;
}

export type WaitVerdict =
  // The market offered a trade this app would have allowed, and it won
  | "missed"
  // Neither direction paid: standing aside cost nothing
  | "correct"
  // Not enough market time has passed to say yet
  | "pending"
  // The call predates the data needed to judge it (no ATR or no signal price)
  | "unknown";

export interface WaitCheck {
  verdict: WaitVerdict;
  // Which way the missed trade would have gone
  direction: "BUY" | "SELL" | null;
  // What that minimal trade would have paid, in multiples of its own risk.
  // It is MIN_RISK_REWARD by construction when it won — recorded so the
  // number is visible rather than implied.
  r: number | null;
  // When the target was reached
  at: string | null;
  // The levels the test used, so the judgement can be checked by hand
  price: number | null;
  atr: number | null;
  risk: number | null;
  reward: number | null;
  bars_examined: number;
  horizon_ms: number;
  checked_at: string;
}

// The tightest stop the gate would allow, and the nearest target that still
// clears the risk/reward floor. Both come from the app's own constants: a
// WAIT is judged against the least the app would have demanded of a trade,
// not against a threshold invented for the purpose.
export const minimalTrade = (atr: number): { risk: number; reward: number } => {
  const risk = MIN_STOP_ATR * atr;
  return { risk, reward: MIN_RISK_REWARD * risk };
};

interface SideState {
  stopped: boolean;
  won: boolean;
  at: number | null;
}

// One side of the hypothetical trade walked through one bar.
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

/**
 * Score a WAIT against the bars that followed it.
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
  bars: WaitBar[],
  nowMs: number,
): WaitCheck => {
  const checked_at = new Date(nowMs).toISOString();
  const base: WaitCheck = {
    verdict: "unknown",
    direction: null,
    r: null,
    at: null,
    price: input.price,
    atr: input.atr,
    risk: null,
    reward: null,
    bars_examined: 0,
    horizon_ms: input.horizonMs,
    checked_at,
  };
  const { price, atr } = input;
  if (price === null || atr === null || !Number.isFinite(price) || !Number.isFinite(atr) || atr <= 0) {
    return base;
  }

  const { risk, reward } = minimalTrade(atr);
  const withLevels = { ...base, risk, reward };

  const until = input.signalMs + input.horizonMs;
  const usable = bars
    .filter((b) => b.t > input.signalMs && b.t <= Math.min(until, nowMs))
    .filter((b) => !isMarketClosed(b.t))
    .filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low))
    .sort((a, b) => a.t - b.t);

  let long: SideState = { stopped: false, won: false, at: null };
  let short: SideState = { stopped: false, won: false, at: null };

  for (const bar of usable) {
    long = walk(long, bar, price - risk, price + reward, "BUY");
    short = walk(short, bar, price + risk, price - reward, "SELL");
    if (long.won || short.won) break;
  }

  const examined = { ...withLevels, bars_examined: usable.length };

  // Whichever side got paid first is the trade that was there to be taken.
  // Both cannot win: the first to reach its target ends the walk.
  const winner = long.won ? "BUY" : short.won ? "SELL" : null;
  if (winner) {
    const at = long.won ? long.at : short.at;
    return {
      ...examined,
      verdict: "missed",
      direction: winner,
      r: MIN_RISK_REWARD,
      at: at === null ? null : new Date(at).toISOString(),
    };
  }

  // Both directions were stopped out, so there was nothing to take. Standing
  // aside was right, and that is settled even if the horizon has not run out.
  if (long.stopped && short.stopped) return { ...examined, verdict: "correct", direction: null };

  // Still inside the window with one side alive: no verdict yet.
  if (nowMs < until) return { ...examined, verdict: "pending", direction: null };

  return { ...examined, verdict: "correct", direction: null };
};
