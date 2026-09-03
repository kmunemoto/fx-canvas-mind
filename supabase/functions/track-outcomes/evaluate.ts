// Pure judgement logic for track-outcomes, kept Deno-free so the vitest suite
// can import it directly.
//
// A plan only becomes a trade once price reaches the entry. From then on,
// TP1 before SL is a win and SL first is a loss. When one candle touches both
// levels the order is unknowable at that resolution, so the caller is asked
// for finer candles; if those cannot settle it either, the plan is
// 'ambiguous' rather than guessed. Plans whose entry is never reached are
// 'untriggered'. Everything the judge saw is kept as evidence.

import type { Candle } from "../analyze/indicators.ts";

export type Signal = "BUY" | "SELL";
export type Resolution = "win" | "loss" | "untriggered" | "ambiguous" | "expired";
export type UntriggeredReason = "missed" | "invalidated" | "no_fill";
export type Reason = UntriggeredReason | "incoherent";
export type OrderType = "market" | "limit" | "stop" | "unknown";

export interface PathPoint {
  t: string; // ISO UTC of the (first merged) candle open
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Evaluation {
  version: 2;
  eval_interval: string;
  order_type: OrderType;
  price_at_signal: number | null;
  filled_at: string | null;
  fill_price: number | null;
  resolution: Resolution | null;
  reason: Reason | null;
  resolved_at: string | null;
  refined: boolean;
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

interface State {
  filled: boolean;
  filled_at: string | null;
  fill_price: number | null;
  mfe: number | null;
  mae: number | null;
}

type Event =
  | { kind: "none" }
  | { kind: "filled" }
  | { kind: "win" | "loss" | "ambiguous"; at: string }
  | { kind: "untriggered"; reason: UntriggeredReason; at: string };

const hitsTp = (signal: Signal, c: Candle, tp: number) => (signal === "BUY" ? c.high >= tp : c.low <= tp);
const hitsSl = (signal: Signal, c: Candle, sl: number) => (signal === "BUY" ? c.low <= sl : c.high >= sl);
const touches = (c: Candle, level: number) => c.low <= level && c.high >= level;
const favorableMove = (signal: Signal, entry: number, c: Candle) => (signal === "BUY" ? c.high - entry : entry - c.low);
const adverseMove = (signal: Signal, entry: number, c: Candle) => (signal === "BUY" ? entry - c.low : c.high - entry);

const withExcursion = (state: State, row: OpenRow, c: Candle): State => ({
  ...state,
  mfe: Math.max(state.mfe ?? 0, favorableMove(row.signal, row.entry_point, c), 0),
  mae: Math.max(state.mae ?? 0, adverseMove(row.signal, row.entry_point, c), 0),
});

// One candle of the plan's life. The fill candle also gets a resolution check:
// a limit entry sits between the market and the SL, so a candle that reaches
// the SL must have passed the entry first (a loss) while one that reaches TP
// may have done so before filling (unknown); a stop entry is the mirror.
const step = (row: OpenRow, orderType: OrderType, state: State, c: Candle): { state: State; event: Event } => {
  const at = candleIso(c.datetime);
  const tp = hitsTp(row.signal, c, row.take_profit_1);
  const sl = hitsSl(row.signal, c, row.stop_loss);

  if (!state.filled) {
    if (!touches(c, row.entry_point)) {
      if (tp) return { state, event: { kind: "untriggered", reason: "missed", at } };
      if (sl) return { state, event: { kind: "untriggered", reason: "invalidated", at } };
      return { state, event: { kind: "none" } };
    }
    const filled = withExcursion(
      { ...state, filled: true, filled_at: at, fill_price: row.entry_point },
      row,
      c,
    );
    if (tp && sl) return { state: filled, event: { kind: "ambiguous", at } };
    if (tp) {
      return orderType === "limit" || orderType === "unknown"
        ? { state: filled, event: { kind: "ambiguous", at } }
        : { state: filled, event: { kind: "win", at } };
    }
    if (sl) {
      return orderType === "stop" || orderType === "unknown"
        ? { state: filled, event: { kind: "ambiguous", at } }
        : { state: filled, event: { kind: "loss", at } };
    }
    return { state: filled, event: { kind: "filled" } };
  }

  const next = withExcursion(state, row, c);
  if (tp && sl) return { state: next, event: { kind: "ambiguous", at } };
  if (tp) return { state: next, event: { kind: "win", at } };
  if (sl) return { state: next, event: { kind: "loss", at } };
  return { state: next, event: { kind: "none" } };
};

interface Timed {
  c: Candle;
  t: number;
}

const timeline = (candles: Candle[], nowMs: number): Timed[] =>
  candles
    .map((c) => ({ c, t: parseCandleTime(c.datetime) }))
    .filter((x) => Number.isFinite(x.t) && x.t <= nowMs + FUTURE_SLACK_MS)
    .sort((a, b) => a.t - b.t);

const runUntilEvent = (row: OpenRow, orderType: OrderType, state: State, candles: Timed[]): { state: State; event: Event; index: number } => {
  for (let i = 0; i < candles.length; i++) {
    const r = step(row, orderType, state, candles[i].c);
    state = r.state;
    if (r.event.kind !== "none" && r.event.kind !== "filled") return { state, event: r.event, index: i };
  }
  return { state, event: { kind: "none" }, index: candles.length };
};

// Further targets reached after TP1 while price stayed above the entry (a
// runner with its stop moved to breakeven), for the "what happened next" view
const targetsReached = (row: OpenRow, candles: Timed[], winIndex: number, state: State): { tps: number[]; state: State } => {
  const tps = [1];
  const beyond = (tp: number | null) => tp !== null && Number.isFinite(tp) &&
    (row.signal === "BUY" ? tp > row.take_profit_1 : tp < row.take_profit_1);
  const extra: Array<[number, number]> = [];
  if (beyond(row.take_profit_2)) extra.push([2, row.take_profit_2 as number]);
  if (beyond(row.take_profit_3)) extra.push([3, row.take_profit_3 as number]);
  if (extra.length === 0) return { tps, state };

  for (let i = winIndex; i < candles.length; i++) {
    const c = candles[i].c;
    if (i > winIndex && adverseMove(row.signal, row.entry_point, c) >= 0) break;
    state = withExcursion(state, row, c);
    for (const [n, tp] of extra) {
      if (!tps.includes(n) && hitsTp(row.signal, c, tp)) tps.push(n);
    }
  }
  return { tps: tps.sort(), state };
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
  const series = timeline(candles, nowMs);
  const firstIdx = series.findIndex((x) => x.t >= createdMs);
  const post = firstIdx >= 0 ? series.slice(firstIdx) : [];
  const windowCoversSignal = series.length > 0 && series[0].t <= createdMs + evalMs;

  // The bar the signal fell inside. It is not judged for SL/TP (part of it
  // predates the plan) but it is the best witness for what price was doing at
  // signal time: if it reached the entry, the order would have filled then.
  const signalIdx = firstIdx > 0 ? firstIdx - 1 : firstIdx === -1 ? series.length - 1 : -1;
  const signalBar = signalIdx >= 0 && series[signalIdx].t + evalMs > createdMs ? series[signalIdx] : null;

  const reference = row.price_at_signal ?? signalBar?.c.close ?? (post.length > 0 ? post[0].c.open : null);
  const orderType = classifyOrder(row, reference);
  const checkedAt = toIso(nowMs);
  const risk = Math.abs(row.entry_point - row.stop_loss);

  const filledAtSignal = orderType === "market" ||
    (orderType !== "unknown" && signalBar !== null && touches(signalBar.c, row.entry_point));
  let state: State = filledAtSignal
    ? { filled: true, filled_at: toIso(createdMs), fill_price: row.entry_point, mfe: null, mae: null }
    : { filled: false, filled_at: null, fill_price: null, mfe: null, mae: null };

  let terminal: Event | null = null;
  let terminalIdx = -1;
  let refined = false;

  if (!isCoherentPlan(row)) {
    terminal = { kind: "ambiguous", at: checkedAt };
  } else {
    let i = 0;
    while (i < post.length) {
      const before = state;
      const r = runUntilEvent(row, orderType, state, post.slice(i));
      const idx = i + r.index;
      if (r.event.kind === "none") {
        state = r.state;
        break;
      }
      if (r.event.kind === "ambiguous" && evalInterval !== REFINE_INTERVAL && fetchFine) {
        const from = post[idx].t;
        const to = from + evalMs;
        const fine = await fetchFine(row.pair, from, to);
        refined = true;
        if (fine && fine.length > 0) {
          const fineSeries = timeline(fine, nowMs).filter((x) => x.t >= from && x.t < to);
          // Resume from the state before the ambiguous candle; the fine bars
          // replace it
          const stateBefore = idx === i ? before : runUntilEvent(row, orderType, before, post.slice(i, idx)).state;
          const fr = runUntilEvent(row, orderType, stateBefore, fineSeries);
          if (fr.event.kind !== "none") {
            terminal = fr.event;
            terminalIdx = idx;
            state = fr.state;
            break;
          }
          // The finer bars did not reproduce a decisive touch: carry on from
          // their end state with the next coarse candle
          state = fr.state;
          i = idx + 1;
          continue;
        }
      }
      terminal = r.event;
      terminalIdx = idx;
      state = r.state;
      break;
    }
  }

  let resolution: Resolution | null = null;
  let reason: Reason | null = null;
  let resolvedAt: string | null = null;
  let outcomePrice: number | null = null;
  let tpsHit: number[] = [];

  if (terminal && terminal.kind !== "none" && terminal.kind !== "filled") {
    resolvedAt = terminal.at;
    if (terminal.kind === "win") {
      resolution = "win";
      outcomePrice = row.take_profit_1;
      const reached = targetsReached(row, post, terminalIdx, state);
      tpsHit = reached.tps;
      state = reached.state;
    } else if (terminal.kind === "loss") {
      resolution = "loss";
      outcomePrice = row.stop_loss;
    } else if (terminal.kind === "untriggered") {
      resolution = "untriggered";
      reason = terminal.reason;
    } else {
      resolution = "ambiguous";
      if (!isCoherentPlan(row)) reason = "incoherent";
    }
  } else if (post.length > 0) {
    const ageMs = nowMs - createdMs;
    if (!state.filled) {
      if (windowCoversSignal && ageMs > (ENTRY_WINDOW_MS[row.interval] ?? 48 * HOUR)) {
        resolution = "untriggered";
        reason = "no_fill";
        resolvedAt = checkedAt;
      }
    } else if (ageMs > (EXPIRY_DAYS[row.interval] ?? 30) * DAY) {
      resolution = "expired";
      resolvedAt = checkedAt;
      outcomePrice = post[post.length - 1].c.close;
    }
  }

  const contextStart = firstIdx >= 0 ? Math.max(0, firstIdx - PRE_SIGNAL_CONTEXT) : Math.max(0, series.length - PRE_SIGNAL_CONTEXT);
  const contextEnd = terminalIdx >= 0 ? Math.min(series.length, firstIdx + terminalIdx + 4) : series.length;
  const path = downsamplePath(series.slice(contextStart, contextEnd).map((x) => x.c), PATH_POINTS);

  const evaluation: Evaluation = {
    version: 2,
    eval_interval: evalInterval,
    order_type: orderType,
    price_at_signal: row.price_at_signal,
    filled_at: state.filled_at,
    fill_price: state.fill_price,
    resolution,
    reason,
    resolved_at: resolvedAt,
    refined,
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
    path,
  };

  return {
    resolution,
    outcome_price: outcomePrice,
    closed_at: resolution ? resolvedAt ?? checkedAt : null,
    evaluation,
  };
};
