// Pure judgement logic for track-outcomes, kept Deno-free so the vitest suite
// can import it directly.
//
// A plan only becomes a trade once price reaches the entry. From then on,
// TP1 before SL is a win and SL first is a loss. When one candle touches both
// levels the order is unknowable at that resolution, so the caller is asked
// for finer candles; if those cannot settle it either, the plan is
// 'ambiguous' rather than guessed. Plans whose entry is never reached are
// 'untriggered'. Everything the judge saw is kept as evidence.
//
// Time is always candle time: the entry window and the expiry are applied to
// the bar that crosses them, so a judgement does not depend on when the
// sweep happened to run.

import type { Candle } from "../analyze/indicators.ts";

export type Signal = "BUY" | "SELL";
export type Resolution = "win" | "loss" | "untriggered" | "ambiguous" | "expired";
export type UntriggeredReason = "missed" | "invalidated" | "no_fill";
export type Reason = UntriggeredReason | "incoherent" | "no_data";
export type OrderType = "market" | "limit" | "stop" | "unknown";

export interface PathPoint {
  t: string; // ISO UTC of the (first merged) candle open
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Evaluation {
  version: 3;
  eval_interval: string;
  order_type: OrderType;
  price_at_signal: number | null;
  // The bar around the signal reached the entry, but whether that happened
  // before or after the plan was made could not be told
  possible_fill: boolean;
  filled_at: string | null;
  fill_price: number | null;
  resolution: Resolution | null;
  reason: Reason | null;
  resolved_at: string | null;
  // Finer bars were used for a decision
  refined: boolean;
  // Finer bars were needed but could not be fetched this run; the plan stays
  // open and is retried, up to MAX_REFINE_ATTEMPTS times
  refine_pending: boolean;
  refine_attempts: number;
  // Largest move in the trade's favour / against it after the fill, in price
  // units and in multiples of the planned risk (entry to SL)
  mfe: number | null;
  mae: number | null;
  mfe_r: number | null;
  mae_r: number | null;
  tps_hit: number[];
  bars_after_signal: number;
  window_covers_signal: boolean;
  first_candle_at: string | null;
  last_candle_at: string | null;
  checked_at: string;
  note: string | null;
  path: PathPoint[];
}

export interface OpenRow {
  id: string;
  pair: string;
  interval: string;
  signal: Signal;
  entry_point: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number | null;
  take_profit_3: number | null;
  created_at: string;
  price_at_signal: number | null;
  evaluation: Evaluation | null;
}

export interface Judgement {
  resolution: Resolution | null; // null: still open
  outcome_price: number | null;
  closed_at: string | null;
  evaluation: Evaluation;
}

// Finer bars for [fromMs, toMs). `null` means the data could not be fetched
// right now (budget, provider error); an empty array means the provider had
// none. Both leave the plan open for another try.
export interface FineFetcher {
  (pair: string, fromMs: number, toMs: number): Promise<Candle[] | null>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const INTERVAL_MS: Record<string, number> = {
  "15min": 15 * MIN,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1day": DAY,
};

// Candles the plan is judged on. Finer than the plan's own timeframe so a
// fill and its resolution can be ordered; one request per pair+interval
// regardless of how many plans share it.
export const EVAL_INTERVAL: Record<string, string> = {
  "15min": "15min",
  "1h": "15min",
  "4h": "1h",
  "1day": "1h",
};

// Enough bars to reach back to the oldest plan that can still be open
// (EXPIRY_DAYS), allowing for weekends without candles
export const EVAL_OUTPUTSIZE: Record<string, number> = {
  "15min": 2000,
  "1h": 3200,
};

export const REFINE_INTERVAL = "15min";
export const REFINE_MS = 15 * MIN;
export const MAX_REFINE_ATTEMPTS = 3;

// Days after which a filled plan without a decision is closed as expired
export const EXPIRY_DAYS: Record<string, number> = {
  "15min": 5,
  "1h": 20,
  "4h": 60,
  "1day": 180,
};

// How long an unfilled entry stays valid
export const ENTRY_WINDOW_MS: Record<string, number> = {
  "15min": 12 * HOUR,
  "1h": 48 * HOUR,
  "4h": 7 * DAY,
  "1day": 30 * DAY,
};

// Re-judge cadence per plan timeframe (the sweep runs more often than this)
export const CHECK_EVERY_MS: Record<string, number> = {
  "15min": 15 * MIN,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1day": 4 * HOUR,
};

// An entry this close to the market price is treated as a market order
export const FILL_TOLERANCE = 0.0002;
export const PATH_POINTS = 60;
export const PRE_SIGNAL_CONTEXT = 8;
// A candle dated later than this past "now" means the data is not in UTC
export const FUTURE_SLACK_MS = MIN;

// Twelve Data returns "YYYY-MM-DD HH:mm:ss" for intraday bars and a bare
// "YYYY-MM-DD" for daily and above, neither carrying a zone marker. We ask
// for UTC explicitly, so build a full ISO string rather than relying on the
// engine's tolerance for non-standard forms.
export const parseCandleTime = (datetime: string): number => {
  if (!datetime) return NaN;
  if (datetime.includes("T")) return Date.parse(datetime);
  const [date, time] = datetime.split(" ");
  return Date.parse(`${date}T${time || "00:00:00"}Z`);
};

export const toIso = (ms: number): string => new Date(ms).toISOString();

const candleIso = (datetime: string): string => {
  const ms = parseCandleTime(datetime);
  return Number.isFinite(ms) ? toIso(ms) : datetime;
};

export const hasFutureCandles = (candles: Candle[], nowMs: number): boolean =>
  candles.some((c) => parseCandleTime(c.datetime) > nowMs + FUTURE_SLACK_MS);

export const isDue = (row: Pick<OpenRow, "interval" | "evaluation">, nowMs: number): boolean => {
  const checkedAt = row.evaluation?.checked_at;
  const checked = typeof checkedAt === "string" ? Date.parse(checkedAt) : NaN;
  if (!Number.isFinite(checked)) return true;
  const every = CHECK_EVERY_MS[row.interval] ?? HOUR;
  // Slack so a cron tick a few seconds early still counts
  return nowMs - checked >= every - MIN;
};

export const classifyOrder = (
  row: Pick<OpenRow, "signal" | "entry_point">,
  reference: number | null,
): OrderType => {
  if (reference === null || !Number.isFinite(reference) || reference <= 0) return "unknown";
  if (Math.abs(row.entry_point - reference) / reference <= FILL_TOLERANCE) return "market";
  if (row.signal === "BUY") return row.entry_point < reference ? "limit" : "stop";
  return row.entry_point > reference ? "limit" : "stop";
};

// SL on the wrong side of the entry (or TP1 not beyond it) cannot be judged
export const isCoherentPlan = (row: Pick<OpenRow, "signal" | "entry_point" | "stop_loss" | "take_profit_1">): boolean => {
  const { entry_point: e, stop_loss: sl, take_profit_1: tp } = row;
  if (![e, sl, tp].every(Number.isFinite)) return false;
  return row.signal === "BUY" ? sl < e && tp > e : sl > e && tp < e;
};

const toPoint = (c: Candle): PathPoint => ({
  t: candleIso(c.datetime),
  o: c.open,
  h: c.high,
  l: c.low,
  c: c.close,
});

// Merge consecutive candles so the stored path stays small
export const downsamplePath = (candles: Candle[], maxPoints: number): PathPoint[] => {
  if (candles.length <= maxPoints) return candles.map(toPoint);
  const bucket = Math.ceil(candles.length / maxPoints);
  const out: PathPoint[] = [];
  for (let i = 0; i < candles.length; i += bucket) {
    const chunk = candles.slice(i, i + bucket);
    let h = -Infinity;
    let l = Infinity;
    for (const c of chunk) {
      h = Math.max(h, c.high);
      l = Math.min(l, c.low);
    }
    out.push({
      t: candleIso(chunk[0].datetime),
      o: chunk[0].open,
      h,
      l,
      c: chunk[chunk.length - 1].close,
    });
  }
  return out;
};

// An evaluation record with nothing decided, for rows that were looked at but
// could not be judged (no usable market data). Keeps whatever an earlier run
// established so the row is not re-fetched on every tick.
export const emptyEvaluation = (row: OpenRow, evalInterval: string, nowMs: number): Evaluation => ({
  version: 3,
  eval_interval: evalInterval,
  order_type: "unknown",
  price_at_signal: row.price_at_signal,
  possible_fill: false,
  filled_at: null,
  fill_price: null,
  resolution: null,
  reason: null,
  resolved_at: null,
  refined: false,
  refine_pending: false,
  refine_attempts: 0,
  mfe: null,
  mae: null,
  mfe_r: null,
  mae_r: null,
  tps_hit: [],
  bars_after_signal: 0,
  window_covers_signal: false,
  first_candle_at: null,
  last_candle_at: null,
  checked_at: toIso(nowMs),
  note: null,
  path: [],
});

export const stampOnly = (row: OpenRow, evalInterval: string, nowMs: number, note: string): Evaluation => ({
  ...(row.evaluation ?? emptyEvaluation(row, evalInterval, nowMs)),
  checked_at: toIso(nowMs),
  note,
});

interface State {
  filled: boolean;
  filled_at: string | null;
  fill_price: number | null;
  possibleFill: boolean;
  mfe: number | null;
  mae: number | null;
}

const EMPTY_STATE: State = { filled: false, filled_at: null, fill_price: null, possibleFill: false, mfe: null, mae: null };

type Terminal =
  | { kind: "win" | "loss"; at: string }
  | { kind: "ambiguous"; at: string; refinable: boolean }
  | { kind: "untriggered"; reason: UntriggeredReason; at: string }
  | { kind: "expired"; at: string; price: number };

type Event = Terminal | { kind: "none" } | { kind: "filled" };

interface Ctx {
  row: OpenRow;
  orderType: OrderType;
  // A TP1 / SL touch before the fill only says something when the level lies
  // beyond the market at signal time; a level between the market and the
  // entry is "touched" by the very first bar
  missedArmed: boolean;
  invalidatedArmed: boolean;
  entryDeadline: number;
  expiryDeadline: number;
}

interface Timed {
  c: Candle;
  t: number;
  ms: number; // bar duration
}

const hitsTp = (signal: Signal, c: Candle, tp: number) => (signal === "BUY" ? c.high >= tp : c.low <= tp);
const hitsSl = (signal: Signal, c: Candle, sl: number) => (signal === "BUY" ? c.low <= sl : c.high >= sl);
const touches = (c: Candle, level: number) => c.low <= level && c.high >= level;
const favorableMove = (signal: Signal, entry: number, c: Candle) => (signal === "BUY" ? c.high - entry : entry - c.low);
const adverseMove = (signal: Signal, entry: number, c: Candle) => (signal === "BUY" ? entry - c.low : c.high - entry);

const withExcursion = (state: State, row: OpenRow, c: Candle, sides: "both" | "adverse" | "favorable" = "both"): State => ({
  ...state,
  mfe: sides === "adverse"
    ? state.mfe ?? 0
    : Math.max(state.mfe ?? 0, favorableMove(row.signal, row.entry_point, c), 0),
  mae: sides === "favorable"
    ? state.mae ?? 0
    : Math.max(state.mae ?? 0, adverseMove(row.signal, row.entry_point, c), 0),
});

const filledAt = (row: OpenRow, at: string): State => ({
  ...EMPTY_STATE,
  filled: true,
  filled_at: at,
  fill_price: row.entry_point,
});

// One bar of the plan's life. The fill bar also gets a resolution check: a
// limit entry sits between the market and the SL, so a bar that reaches the
// SL must have passed the entry first (a loss) while one that reaches TP may
// have done so before filling (unknown); a stop entry is the mirror.
const step = (ctx: Ctx, state: State, bar: Timed): { state: State; event: Event } => {
  const { row, orderType } = ctx;
  const c = bar.c;
  const at = toIso(bar.t);

  if (!state.filled && bar.t >= ctx.entryDeadline) {
    return { state, event: { kind: "untriggered", reason: "no_fill", at } };
  }
  if (state.filled && bar.t >= ctx.expiryDeadline) {
    return { state, event: { kind: "expired", at, price: c.open } };
  }

  const tp = hitsTp(row.signal, c, row.take_profit_1);
  const sl = hitsSl(row.signal, c, row.stop_loss);

  if (!state.filled) {
    if (!touches(c, row.entry_point)) {
      if (tp || sl) {
        // Maybe in the trade, maybe not: the signal bar could not tell
        if (state.possibleFill) return { state, event: { kind: "ambiguous", at, refinable: false } };
        if (tp && ctx.missedArmed) return { state, event: { kind: "untriggered", reason: "missed", at } };
        if (sl && ctx.invalidatedArmed) return { state, event: { kind: "untriggered", reason: "invalidated", at } };
      }
      return { state, event: { kind: "none" } };
    }
    // Price came from the market side, so on the fill bar only the far side
    // of the entry was traversed as a position
    const sides = orderType === "limit" ? "adverse" : orderType === "stop" ? "favorable" : "both";
    const filled = withExcursion(filledAt(row, at), row, c, sides);
    if (tp && sl) return { state: filled, event: { kind: "ambiguous", at, refinable: true } };
    if (tp) {
      return orderType === "limit" || orderType === "unknown"
        ? { state: filled, event: { kind: "ambiguous", at, refinable: true } }
        : { state: filled, event: { kind: "win", at } };
    }
    if (sl) {
      return orderType === "stop" || orderType === "unknown"
        ? { state: filled, event: { kind: "ambiguous", at, refinable: true } }
        : { state: filled, event: { kind: "loss", at } };
    }
    return { state: filled, event: { kind: "filled" } };
  }

  const next = withExcursion(state, row, c);
  if (tp && sl) return { state: next, event: { kind: "ambiguous", at, refinable: true } };
  if (tp) return { state: next, event: { kind: "win", at } };
  if (sl) return { state: next, event: { kind: "loss", at } };
  return { state: next, event: { kind: "none" } };
};

const timeline = (candles: Candle[], nowMs: number, ms: number): Timed[] =>
  candles
    .map((c) => ({ c, t: parseCandleTime(c.datetime), ms }))
    .filter((x) => Number.isFinite(x.t) && x.t <= nowMs + FUTURE_SLACK_MS)
    .sort((a, b) => a.t - b.t);

const isTerminal = (e: Event): e is Terminal => e.kind !== "none" && e.kind !== "filled";

const runUntilEvent = (ctx: Ctx, state: State, bars: Timed[]): { state: State; event: Terminal | null; index: number } => {
  for (let i = 0; i < bars.length; i++) {
    const r = step(ctx, state, bars[i]);
    state = r.state;
    if (isTerminal(r.event)) return { state, event: r.event, index: i };
  }
  return { state, event: null, index: bars.length };
};

// Further targets reached after TP1 while price stayed beyond the entry (a
// runner with its stop moved to breakeven), for the "what happened next"
// view. bars[0] is the bar that reached TP1.
const targetsReached = (ctx: Ctx, bars: Timed[], state: State): { tps: number[]; state: State } => {
  const { row } = ctx;
  const tps = [1];
  const beyond = (tp: number | null) => tp !== null && Number.isFinite(tp) &&
    (row.signal === "BUY" ? tp > row.take_profit_1 : tp < row.take_profit_1);
  const extra: Array<[number, number]> = [];
  if (beyond(row.take_profit_2)) extra.push([2, row.take_profit_2 as number]);
  if (beyond(row.take_profit_3)) extra.push([3, row.take_profit_3 as number]);
  if (extra.length === 0) return { tps, state };

  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].c;
    if (i > 0 && adverseMove(row.signal, row.entry_point, c) >= 0) break;
    state = withExcursion(state, row, c);
    for (const [n, tp] of extra) {
      if (!tps.includes(n) && hitsTp(row.signal, c, tp)) tps.push(n);
    }
  }
  return { tps: tps.sort(), state };
};

// What the bar around the signal says about the entry. A market order is in
// from the start. Otherwise the bar's close is the one price known to be
// after the signal: if it sits on the far side of the entry from where the
// market was, price crossed the entry after the plan was made and the order
// filled; if the bar only reached the entry, the touch may predate the plan.
// A filled plan whose signal bar also reached SL or TP1 cannot be timed.
const assessSignalBar = (
  ctx: Ctx,
  reference: number | null,
  signalBar: Timed | null,
  createdMs: number,
): { state: State; event: Terminal | null } => {
  const { row, orderType } = ctx;
  let state = EMPTY_STATE;
  if (orderType === "market") {
    state = filledAt(row, toIso(createdMs));
  } else if (
    signalBar !== null && orderType !== "unknown" && reference !== null &&
    touches(signalBar.c, row.entry_point)
  ) {
    const crossed = (reference - row.entry_point) * (signalBar.c.close - row.entry_point) <= 0;
    state = crossed ? filledAt(row, toIso(createdMs)) : { ...state, possibleFill: true };
  }
  if (state.filled && signalBar !== null &&
    (hitsTp(row.signal, signalBar.c, row.take_profit_1) || hitsSl(row.signal, signalBar.c, row.stop_loss))) {
    return { state, event: { kind: "ambiguous", at: toIso(createdMs), refinable: true } };
  }
  return { state, event: null };
};

export const judgePlan = async (
  row: OpenRow,
  candles: Candle[],
  evalInterval: string,
  nowMs: number,
  fetchFine?: FineFetcher,
): Promise<Judgement> => {
  const createdMs = Date.parse(row.created_at);
  const evalMs = INTERVAL_MS[evalInterval] ?? HOUR;
  const checkedAt = toIso(nowMs);
  const prev = row.evaluation;
  const risk = Math.abs(row.entry_point - row.stop_loss);
  const ageMs = nowMs - createdMs;
  const entryWindowMs = ENTRY_WINDOW_MS[row.interval] ?? 48 * HOUR;
  const expiryMs = (EXPIRY_DAYS[row.interval] ?? 30) * DAY;

  let series = timeline(candles, nowMs, evalMs);
  const windowCoversSignal = series.length > 0 && series[0].t <= createdMs + evalMs;

  // Locate the bar containing the signal and the bars after it
  const locate = () => {
    const firstIdx = series.findIndex((x) => x.t >= createdMs);
    const signalIdx = firstIdx > 0 ? firstIdx - 1 : firstIdx === -1 ? series.length - 1 : -1;
    const candidate = signalIdx >= 0 ? series[signalIdx] : null;
    const signalBar = candidate !== null && candidate.t <= createdMs && candidate.t + candidate.ms > createdMs ? candidate : null;
    const post = firstIdx >= 0 ? series.slice(firstIdx) : [];
    return { firstIdx, signalIdx, signalBar, post };
  };
  let { firstIdx, signalIdx, signalBar, post } = locate();

  const reference = row.price_at_signal ?? signalBar?.c.close ?? (post.length > 0 ? post[0].c.open : null);
  const orderType = classifyOrder(row, reference);
  const ctx: Ctx = {
    row,
    orderType,
    missedArmed: reference === null || (row.signal === "BUY" ? row.take_profit_1 > reference : row.take_profit_1 < reference),
    invalidatedArmed: reference === null || (row.signal === "BUY" ? row.stop_loss < reference : row.stop_loss > reference),
    entryDeadline: createdMs + entryWindowMs,
    expiryDeadline: createdMs + expiryMs,
  };

  let state: State = EMPTY_STATE;
  let terminal: Terminal | null = null;
  let terminalIdx = -1; // index into post; -1 = decided on the signal bar
  let refined = false;
  let refinePending = false;
  let refineAttempts = prev?.refine_attempts ?? 0;
  let note: string | null = null;
  // Bars from the TP1 bar onwards, for the runner view (fine bars when the
  // win came from refinement)
  let afterWin: Timed[] = [];
  let judged = true;

  const fetchRange = async (fromMs: number, toMs: number): Promise<Timed[] | null> => {
    if (!fetchFine) return null;
    const fine = await fetchFine(row.pair, fromMs, toMs);
    if (fine === null) return null;
    const bars = timeline(fine, nowMs, REFINE_MS).filter((x) => x.t >= fromMs && x.t < toMs);
    return bars.length > 0 ? bars : null;
  };
  // Finer data was needed and not obtained: try again next time, a bounded
  // number of times
  const deferRefinement = () => {
    refineAttempts++;
    if (refineAttempts >= MAX_REFINE_ATTEMPTS) {
      terminal = { kind: "ambiguous", at: checkedAt, refinable: false };
      note = "no_data";
    } else {
      refinePending = true;
      judged = false;
    }
  };

  if (!isCoherentPlan(row)) {
    terminal = { kind: "ambiguous", at: checkedAt, refinable: false };
  } else if (!windowCoversSignal && !prev?.filled_at) {
    // The fetched bars start after the signal: whatever happened in between
    // is unknown, so this snapshot cannot say anything about the plan
    judged = false;
    if (ageMs > entryWindowMs) {
      terminal = { kind: "ambiguous", at: checkedAt, refinable: false };
      note = "no_data";
    } else {
      note = "window_short";
    }
  } else if (!windowCoversSignal && prev?.filled_at) {
    // Filled in an earlier, complete run: carry that and judge the rest
    state = {
      filled: true,
      filled_at: prev.filled_at,
      fill_price: prev.fill_price,
      possibleFill: false,
      mfe: prev.mfe,
      mae: prev.mae,
    };
  } else {
    let sig = assessSignalBar(ctx, reference, signalBar, createdMs);
    // A coarse signal bar that leaves the fill or the first touches
    // untimed: replace it with finer bars and look again
    if (signalBar !== null && signalBar.ms > REFINE_MS && (sig.event !== null || sig.state.possibleFill) && fetchFine) {
      const fine = await fetchRange(signalBar.t, signalBar.t + signalBar.ms);
      if (fine === null) {
        deferRefinement();
      } else {
        refined = true;
        series = [...series.slice(0, signalIdx), ...fine, ...series.slice(signalIdx + 1)];
        ({ firstIdx, signalIdx, signalBar, post } = locate());
        sig = assessSignalBar(ctx, reference, signalBar, createdMs);
      }
    }
    if (judged && terminal === null) {
      state = sig.state;
      if (sig.event !== null) terminal = sig.event;
    }
  }

  if (judged && terminal === null) {
    let i = 0;
    while (i < post.length) {
      const before = state;
      const r = runUntilEvent(ctx, state, post.slice(i));
      const idx = i + r.index;
      if (r.event === null) {
        state = r.state;
        break;
      }
      if (r.event.kind === "ambiguous" && r.event.refinable && post[idx].ms > REFINE_MS && fetchFine) {
        const fine = await fetchRange(post[idx].t, post[idx].t + post[idx].ms);
        if (fine === null) {
          deferRefinement();
          break;
        }
        refined = true;
        // Resume from the state before the ambiguous bar; the fine bars
        // replace it
        const stateBefore = idx === i ? before : runUntilEvent(ctx, before, post.slice(i, idx)).state;
        const fr = runUntilEvent(ctx, stateBefore, fine);
        if (fr.event !== null) {
          terminal = fr.event;
          terminalIdx = idx;
          state = fr.state;
          afterWin = [...fine.slice(fr.index), ...post.slice(idx + 1)];
          break;
        }
        if (stateBefore.filled) {
          // In the trade, and the finer bars do not show the touches the
          // coarse bar did: the data disagrees, so leave it undecided
          terminal = { kind: "ambiguous", at: toIso(post[idx].t), refinable: false };
          terminalIdx = idx;
          state = fr.state;
          break;
        }
        // The fill bar: the finer bars did not settle anything, carry on
        // from their end state with the next coarse bar
        state = fr.state;
        i = idx + 1;
        continue;
      }
      terminal = r.event;
      terminalIdx = idx;
      state = r.state;
      afterWin = post.slice(idx);
      break;
    }
  }

  let resolution: Resolution | null = null;
  let reason: Reason | null = null;
  let resolvedAt: string | null = null;
  let outcomePrice: number | null = null;
  let tpsHit: number[] = [];

  if (terminal !== null) {
    resolvedAt = terminal.at;
    if (terminal.kind === "win") {
      resolution = "win";
      outcomePrice = row.take_profit_1;
      const reached = targetsReached(ctx, afterWin, state);
      tpsHit = reached.tps;
      state = reached.state;
    } else if (terminal.kind === "loss") {
      resolution = "loss";
      outcomePrice = row.stop_loss;
    } else if (terminal.kind === "untriggered") {
      resolution = "untriggered";
      reason = terminal.reason;
    } else if (terminal.kind === "expired") {
      resolution = "expired";
      outcomePrice = terminal.price;
    } else {
      resolution = "ambiguous";
      reason = !isCoherentPlan(row) ? "incoherent" : note === "no_data" ? "no_data" : null;
    }
  } else if (judged && post.length > 0) {
    // The window has elapsed but no bar has crossed it yet (data lag)
    if (!state.filled) {
      if (windowCoversSignal && ageMs > entryWindowMs) {
        resolution = "untriggered";
        reason = "no_fill";
        resolvedAt = checkedAt;
      }
    } else if (ageMs > expiryMs) {
      resolution = "expired";
      resolvedAt = checkedAt;
      outcomePrice = post[post.length - 1].c.close;
    }
  }

  const contextStart = firstIdx >= 0 ? Math.max(0, firstIdx - PRE_SIGNAL_CONTEXT) : Math.max(0, series.length - PRE_SIGNAL_CONTEXT);
  const contextEnd = terminalIdx >= 0 ? Math.min(series.length, firstIdx + terminalIdx + 4) : series.length;
  const path = downsamplePath(series.slice(contextStart, contextEnd).map((x) => x.c), PATH_POINTS);

  const evaluation: Evaluation = {
    version: 3,
    eval_interval: evalInterval,
    order_type: orderType,
    price_at_signal: row.price_at_signal,
    possible_fill: state.possibleFill,
    filled_at: state.filled_at,
    fill_price: state.fill_price,
    resolution,
    reason,
    resolved_at: resolvedAt,
    refined,
    refine_pending: refinePending,
    refine_attempts: refineAttempts,
    mfe: state.mfe,
    mae: state.mae,
    mfe_r: state.mfe !== null && risk > 0 ? Number((state.mfe / risk).toFixed(2)) : null,
    mae_r: state.mae !== null && risk > 0 ? Number((state.mae / risk).toFixed(2)) : null,
    tps_hit: tpsHit,
    bars_after_signal: post.length,
    window_covers_signal: windowCoversSignal,
    first_candle_at: post.length > 0 ? toIso(post[0].t) : null,
    last_candle_at: post.length > 0 ? toIso(post[post.length - 1].t) : null,
    checked_at: checkedAt,
    note,
    path,
  };

  return {
    resolution,
    outcome_price: outcomePrice,
    closed_at: resolution ? resolvedAt ?? checkedAt : null,
    evaluation,
  };
};
