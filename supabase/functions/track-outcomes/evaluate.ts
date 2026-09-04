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
// Time is market time: the entry window and the expiry are measured in bars
// actually traded (a weekend close does not run them down) and applied to
// the bar that crosses them, so a judgement does not depend on when the
// sweep happened to run. A fill established by an earlier run is kept: the
// bar that proved it may have been still forming at the time.

import type { Candle } from "../analyze/indicators.ts";
import { exitSide, fillSide, isMarketClosed, sideOf, type QuoteCandle } from "./quotes.ts";

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
  // Where the bars came from: "mid" is a single mid price (Twelve Data),
  // "quotes" is bid and ask, so the fill and the exit were judged on the
  // side of the book each actually happens on
  price_basis?: "mid" | "quotes";
  // The spread at the fill and at the settlement, in price units — what the
  // mid-price judgement was silently leaving out
  spread_at_fill?: number | null;
  spread_at_exit?: number | null;
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
  // open and is retried, up to MAX_REFINE_ATTEMPTS provider failures
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

// Finer bars for [fromMs, toMs). `null` means the provider could not supply
// them (error, or nothing in the range) and counts as one failed attempt;
// "deferred" means the caller chose not to ask this run (request budget) and
// costs nothing. Both leave the plan open for another try.
export type FineResult = Candle[] | null | "deferred";
export interface FineFetcher {
  (pair: string, fromMs: number, toMs: number, interval: string): Promise<FineResult>;
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
// A second, finer rung.
//
// The ladder used to stop at 15min, and EVAL_INTERVAL puts both 15min and 1h
// plans on 15min bars — so for those the signal bar was ALREADY at the finest
// rung and `signalBar.ms > REFINE_MS` was false. Nothing could be refined.
// That was survivable while most plans were limits and the signal bar rarely
// filled; once every plan fills at bar zero, any signal bar that so much as
// grazes a level becomes a terminal, unscored `ambiguous`. One more rung
// keeps that rare instead of routine.
export const FINE_INTERVAL = "5min";
export const FINE_MS = 5 * MIN;
export const MAX_REFINE_ATTEMPTS = 3;

// The rung to ask for when splitting a bar of this length: one step finer,
// never the same size (which would return the bar itself and refine nothing).
export const finerRung = (barMs: number): { interval: string; ms: number } | null => {
  if (barMs > REFINE_MS) return { interval: REFINE_INTERVAL, ms: REFINE_MS };
  if (barMs > FINE_MS) return { interval: FINE_INTERVAL, ms: FINE_MS };
  return null;
};

// Market days after which a filled plan without a decision is closed as
// expired
export const EXPIRY_DAYS: Record<string, number> = {
  "15min": 5,
  "1h": 20,
  "4h": 60,
  "1day": 180,
};

// How long (market time) an unfilled entry stays valid
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
  // Market time since the signal after which an unfilled plan lapses / a
  // filled one expires
  entryWindowMs: number;
  expiryMs: number;
  // What a market order actually pays: the fill side's price around the
  // signal when quotes are available, the plan's own number otherwise
  marketFillPrice: number;
}

interface Timed {
  // The side of the book the entry is filled on: the ask for a BUY, the bid
  // for a SELL. On mid data both sides are the same candle.
  c: Candle;
  // The side the position is closed on — the other one. A BUY's stop and
  // target are both reached on the bid, which sits below the mid, so judging
  // them on the mid reaches the stop late and the target early.
  x: Candle;
  t: number;
  ms: number; // bar duration
  mt: number; // market time elapsed since the signal before this bar
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

// A limit or stop order gets the price it named; a market order gets what
// the book was showing on its side, which is not the number on the plan.
const filledAt = (row: OpenRow, at: string, price: number): State => ({
  ...EMPTY_STATE,
  filled: true,
  filled_at: at,
  fill_price: price,
});

// One bar of the plan's life. The fill bar also gets a resolution check: a
// limit entry sits between the market and the SL, so a bar that reaches the
// SL must have passed the entry first (a loss) while one that reaches TP may
// have done so before filling (unknown); a stop entry is the mirror.
const step = (ctx: Ctx, state: State, bar: Timed): { state: State; event: Event } => {
  const { row, orderType } = ctx;
  // The entry is reached on one side of the book, the exits on the other
  const c = bar.c;
  const x = bar.x;
  const at = toIso(bar.t);

  if (!state.filled && bar.mt >= ctx.entryWindowMs) {
    // The order lapsed; unless the signal bar may already have filled it, in
    // which case nothing can be said
    return state.possibleFill
      ? { state, event: { kind: "ambiguous", at, refinable: false } }
      : { state, event: { kind: "untriggered", reason: "no_fill", at } };
  }
  if (state.filled && bar.mt >= ctx.expiryMs) {
    return { state, event: { kind: "expired", at, price: x.open } };
  }

  const tp = hitsTp(row.signal, x, row.take_profit_1);
  const sl = hitsSl(row.signal, x, row.stop_loss);

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
    const filled = withExcursion(filledAt(row, at, row.entry_point), row, x, sides);
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

  const next = withExcursion(state, row, x);
  if (tp && sl) return { state: next, event: { kind: "ambiguous", at, refinable: true } };
  if (tp) return { state: next, event: { kind: "win", at } };
  if (sl) return { state: next, event: { kind: "loss", at } };
  return { state: next, event: { kind: "none" } };
};

// The mid-price feed does not publish bars for a market that was shut, and
// market time is measured off the bars that exist, so this path is left
// exactly as it was.
const timeline = (candles: Candle[], nowMs: number, ms: number): Timed[] =>
  candles
    .map((c) => {
      const t = parseCandleTime(c.datetime);
      return { c, x: c, t, ms, mt: 0 };
    })
    .filter((b) => Number.isFinite(b.t) && b.t <= nowMs + FUTURE_SLACK_MS)
    .sort((a, b) => a.t - b.t);

// The same, from two-sided quotes: the plan's own direction decides which
// side fills it and which side closes it. Unlike the mid feed, this
// provider's behaviour across the weekend break is not established, so a bar
// stamped inside the closed session is dropped — a level "touched" while
// nobody could trade was never really reached.
const quoteTimeline = (quotes: QuoteCandle[], signal: Signal, nowMs: number, ms: number): Timed[] => {
  const fill = fillSide(signal);
  const exit = exitSide(signal);
  return quotes
    .map((q) => {
      const t = parseCandleTime(q.datetime);
      return { c: sideOf(q, fill), x: sideOf(q, exit), t, ms, mt: 0 };
    })
    .filter((b) => Number.isFinite(b.t) && b.t <= nowMs + FUTURE_SLACK_MS && !isMarketClosed(b.t))
    .sort((a, b) => a.t - b.t);
};

// Market time before each bar = the durations of the bars that came before
// it; gaps between bars (weekends, holidays) are not counted
const withMarketTime = (bars: Timed[], startMt = 0): Timed[] => {
  let acc = startMt;
  return bars.map((x) => {
    const y = { ...x, mt: acc };
    acc += x.ms;
    return y;
  });
};

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
    // A runner is closed on the exit side too
    const x = bars[i].x;
    if (i > 0 && adverseMove(row.signal, row.entry_point, x) >= 0) break;
    state = withExcursion(state, row, x);
    for (const [n, tp] of extra) {
      if (!tps.includes(n) && hitsTp(row.signal, x, tp)) tps.push(n);
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
    // A market order does not get the number written on the plan; it gets
    // whatever its own side of the book was showing
    state = filledAt(row, toIso(createdMs), ctx.marketFillPrice);
  } else if (
    signalBar !== null && orderType !== "unknown" && reference !== null &&
    touches(signalBar.c, row.entry_point)
  ) {
    const crossed = (reference - row.entry_point) * (signalBar.c.close - row.entry_point) <= 0;
    state = crossed ? filledAt(row, toIso(createdMs), row.entry_point) : { ...state, possibleFill: true };
  }
  if (state.filled && signalBar !== null &&
    (hitsTp(row.signal, signalBar.x, row.take_profit_1) || hitsSl(row.signal, signalBar.x, row.stop_loss))) {
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
  // Two-sided bars for the plan's pair. When present the plan is judged the
  // way it would have been executed — filled on one side of the book, closed
  // on the other — instead of on a mid price nobody trades at.
  quotes?: QuoteCandle[],
): Promise<Judgement> => {
  const createdMs = Date.parse(row.created_at);
  const evalMs = INTERVAL_MS[evalInterval] ?? HOUR;
  const checkedAt = toIso(nowMs);
  const prev = row.evaluation;
  const risk = Math.abs(row.entry_point - row.stop_loss);
  const ageMs = nowMs - createdMs;
  const entryWindowMs = ENTRY_WINDOW_MS[row.interval] ?? 48 * HOUR;
  const expiryMs = (EXPIRY_DAYS[row.interval] ?? 30) * DAY;
  const twoSided = Array.isArray(quotes) && quotes.length > 0;

  let series = twoSided
    ? quoteTimeline(quotes as QuoteCandle[], row.signal, nowMs, evalMs)
    : timeline(candles, nowMs, evalMs);
  const windowCoversSignal = series.length > 0 && series[0].t <= createdMs + evalMs;

  // Locate the bar containing the signal and the bars after it
  const locate = () => {
    const firstIdx = series.findIndex((x) => x.t >= createdMs);
    const signalIdx = firstIdx > 0 ? firstIdx - 1 : firstIdx === -1 ? series.length - 1 : -1;
    const candidate = signalIdx >= 0 ? series[signalIdx] : null;
    const signalBar = candidate !== null && candidate.t <= createdMs && candidate.t + candidate.ms > createdMs ? candidate : null;
    const post = firstIdx >= 0 ? withMarketTime(series.slice(firstIdx)) : [];
    return { firstIdx, signalIdx, signalBar, post };
  };
  let { firstIdx, signalIdx, signalBar, post } = locate();

  const reference = row.price_at_signal ?? signalBar?.c.close ?? (post.length > 0 ? post[0].c.open : null);
  const orderType = classifyOrder(row, reference);
  // What a market order really costs: on two-sided data, the fill side's
  // price around the signal. On mid data there is nothing better than the
  // plan's own number, which is what every judgement used before.
  const marketFillPrice = twoSided
    ? signalBar?.c.close ?? (post.length > 0 ? post[0].c.open : row.entry_point)
    : row.entry_point;
  const ctx: Ctx = {
    row,
    orderType,
    missedArmed: reference === null || (row.signal === "BUY" ? row.take_profit_1 > reference : row.take_profit_1 < reference),
    invalidatedArmed: reference === null || (row.signal === "BUY" ? row.stop_loss < reference : row.stop_loss > reference),
    entryWindowMs,
    expiryMs,
    marketFillPrice,
  };

  // A fill an earlier run established stands: the bar that proved it may
  // have been still forming then, and its final shape can look different
  const prevFillMs = typeof prev?.filled_at === "string" ? Date.parse(prev.filled_at) : NaN;
  const prevFill = Number.isFinite(prevFillMs) && prev !== null
    ? {
      at: prevFillMs,
      state: {
        filled: true,
        filled_at: prev.filled_at,
        fill_price: prev.fill_price ?? row.entry_point,
        possibleFill: false,
        mfe: prev.mfe,
        mae: prev.mae,
      } satisfies State,
    }
    : null;

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

  // Finer bars for one coarse bar, carrying its market-time offset
  const fetchRange = async (bar: Timed, sinceMs?: number): Promise<Timed[] | null | "deferred"> => {
    if (!fetchFine) return "deferred";
    const rung = finerRung(bar.ms);
    if (rung === null) return null;
    const fine = await fetchFine(row.pair, bar.t, bar.t + bar.ms, rung.interval);
    if (fine === "deferred") return "deferred";
    if (fine === null) return null;
    const bars = timeline(fine, nowMs, rung.ms)
      .filter((x) => x.t >= bar.t && x.t < bar.t + bar.ms)
      // Splitting the SIGNAL bar exposes the part of it that happened BEFORE
      // the plan existed. Price that had already traded cannot resolve a plan
      // that was not yet written, so those sub-bars are dropped rather than
      // allowed to stop out a trade retroactively.
      .filter((x) => sinceMs === undefined || x.t + rung.ms > sinceMs)
      .map((x) => ({ ...x, mt: bar.mt + (x.t - bar.t) }));
    return bars.length > 0 ? bars : null;
  };
  // Finer data was needed and not obtained: try again next time. Provider
  // failures are counted so a bar nobody can supply does not stall the plan
  // forever; a caller that merely ran out of budget costs nothing.
  const deferRefinement = (outcome: null | "deferred") => {
    if (outcome === null) refineAttempts++;
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
  } else if (prevFill !== null) {
    state = prevFill.state;
    post = post.filter((x) => x.t >= prevFill.at);
  } else if (!windowCoversSignal) {
    // The fetched bars start after the signal: whatever happened in between
    // is unknown, so this snapshot cannot say anything about the plan
    judged = false;
    if (ageMs > entryWindowMs) {
      terminal = { kind: "ambiguous", at: checkedAt, refinable: false };
      note = "no_data";
    } else {
      note = "window_short";
    }
  } else {
    let sig = assessSignalBar(ctx, reference, signalBar, createdMs);
    // A coarse signal bar that leaves the fill or the first touches
    // untimed: replace it with finer bars and look again
    if (signalBar !== null && finerRung(signalBar.ms) !== null && (sig.event !== null || sig.state.possibleFill) && fetchFine) {
      const fine = await fetchRange({ ...signalBar, mt: -signalBar.ms }, createdMs);
      if (fine === null || fine === "deferred") {
        deferRefinement(fine === null ? null : "deferred");
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
      if (r.event.kind === "ambiguous" && r.event.refinable && finerRung(post[idx].ms) !== null && fetchFine) {
        // Whatever the bars before the ambiguous one established (a fill,
        // excursions) is kept even if this run cannot finish
        const stateBefore = idx === i ? before : runUntilEvent(ctx, before, post.slice(i, idx)).state;
        const fine = await fetchRange(post[idx]);
        if (fine === null || fine === "deferred") {
          state = stateBefore;
          deferRefinement(fine === null ? null : "deferred");
          break;
        }
        refined = true;
        // Resume from the state before the ambiguous bar; the fine bars
        // replace it
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
    // No bar has crossed the window yet, but the market has been open long
    // enough that one should have: the data lags (the current bar counts for
    // at most a bar or two)
    const last = post[post.length - 1];
    const marketElapsed = last.mt + last.ms + Math.max(0, Math.min(nowMs - (last.t + last.ms), 2 * last.ms));
    if (!state.filled) {
      if (marketElapsed > entryWindowMs) {
        if (state.possibleFill) {
          resolution = "ambiguous";
        } else {
          resolution = "untriggered";
          reason = "no_fill";
        }
        resolvedAt = checkedAt;
      }
    } else if (marketElapsed > expiryMs) {
      resolution = "expired";
      resolvedAt = checkedAt;
      outcomePrice = last.c.close;
    }
  }

  const contextStart = firstIdx >= 0 ? Math.max(0, firstIdx - PRE_SIGNAL_CONTEXT) : Math.max(0, series.length - PRE_SIGNAL_CONTEXT);
  const contextEnd = terminalIdx >= 0
    ? Math.min(series.length, series.findIndex((x) => x.t === post[terminalIdx].t) + 4)
    : series.length;
  const path = downsamplePath(series.slice(contextStart, contextEnd).map((x) => x.c), PATH_POINTS);

  // The spread the plan actually paid, at the two moments it mattered
  const spreadAtBar = (atMs: number | null): number | null => {
    if (!twoSided || atMs === null || !Number.isFinite(atMs)) return null;
    const bar = series.filter((b) => b.t <= atMs).pop() ?? series[0];
    if (!bar) return null;
    const s = Math.abs(bar.x.close - bar.c.close);
    return Number.isFinite(s) ? Number(s.toFixed(5)) : null;
  };
  const filledMs = state.filled_at ? Date.parse(state.filled_at) : null;
  const settledMs = resolvedAt ? Date.parse(resolvedAt) : null;

  const evaluation: Evaluation = {
    version: 3,
    eval_interval: evalInterval,
    price_basis: twoSided ? "quotes" : "mid",
    spread_at_fill: spreadAtBar(filledMs),
    spread_at_exit: spreadAtBar(settledMs),
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
