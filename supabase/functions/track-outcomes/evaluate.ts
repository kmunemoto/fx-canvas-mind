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

// WHY a plan could not be judged. `evaluation.reason` can only ever say
// incoherent / no_data / null, so the record cannot tell an unknowable
// SL-vs-TP order from an unknowable signal-vs-touch order from a starved
// provider from a feed disagreement. Without that distinction nobody can say
// whether a scoring convention for the residue is needed at all — which is
// exactly the question task #41 tried to answer without measuring first.
//
// Four of these are entry_chosen_v1-only. Under market_v1 analyze writes
// entry_point and price_at_signal from the same rounded constant, so
// classifyOrder returns "market", assessSignalBar fills at the signal instant,
// possibleFill is never set and step() is never entered unfilled. A zero in
// those buckets is a fact about the contract, not a measurement; they stay for
// the legacy rows still pending and for any contract that lets an entry go
// unfilled. (postmortem/facts.ts annotates the legacy causes the same way.)
export type AmbiguitySite =
  // The plan's own levels contradict each other. Legacy-only: analyze/entry.ts
  // refuses such a plan before it is written.
  | "incoherent"
  // The fetched window starts after the signal, so the gap is unknown
  | "window_short"
  // MAX_REFINE_ATTEMPTS provider failures before any bar could be labelled.
  // When a labelled bar exists the starvation does NOT replace its site: the
  // row keeps signal_bar / in_trade / fill_bar and says no_data in `reason`
  // with refine_attempts at the cap.
  | "no_finer_data"
  // The signal bar reached a level; whether that was before or after the plan
  // was written cannot be dated (the dominant market_v1 case)
  | "signal_bar"
  // The entry window lapsed on a plan the signal bar may already have filled.
  // Legacy-only. No single deciding bar, so bar_range / at_interval are null.
  | "pre_fill"
  // A later bar reached SL or TP1 while the signal bar's fill was still
  // undated — INSIDE the entry window. Whether the position existed cannot be
  // told. Legacy-only. Not a lapse: that is pre_fill.
  | "unfilled_touch"
  // The bar that filled the order also reached a level. Legacy-only.
  | "fill_bar"
  // Both levels inside one bar while the position was open
  | "in_trade"
  // The finer bars do not show what the coarse bar did. bar_range / touched
  // describe the COARSE bar — the reading the finer bars failed to reproduce;
  // evaluation.refined_interval says which rung was checked against it.
  | "feed_conflict";

export interface Ambiguity {
  site: AmbiguitySite;
  // Which levels the deciding bar reached. This is the direct test of the
  // claim that under market_v1 the commonest ambiguous row touched ONE level,
  // not both — the premise task #41 got wrong.
  touched: "tp1" | "sl" | "both" | null;
  // The length of the DECIDING bar — the one bar_range is measured on. Where
  // the ambiguity survived a refinement attempt this is still the coarse bar,
  // because bar_range / span is only readable against the bar that could not
  // be ordered. The rung actually fetched is evaluation.refined_interval.
  at_interval: string | null;
  // The deciding bar's high-low, and the distance the plan put between its
  // levels. bar_range / span is the falsification test: near 1.0 means the
  // refinement ladder is one rung short and the fix is more data; 3 and up
  // means a real flash event, and only then is a scoring convention worth
  // reopening.
  bar_range: number | null;
  span: number | null;
}
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
  // side of the book each actually happens on. Covers every bar THIS SWEEP
  // judged on, the finer bars that split an ambiguous one included:
  // fetchRange refuses sub-bars of the other basis, so nothing this sweep
  // decided was decided on a mid sub-bar under a bid/ask series. A fill
  // carried over from an earlier sweep (prevFill) keeps whatever basis that
  // sweep had, which this field does not record.
  price_basis?: PriceBasis;
  // The ask-minus-bid at the close of the bar CONTAINING the fill and the
  // settlement, in price units — the finest such bar this sweep held (a fine
  // bar when refinement supplied one, the coarse bar otherwise; for a market
  // fill whose signal bar was split, the first sub-bar after the signal,
  // which is where its price came from). An instant no bar contains falls back to the
  // bar the price came from: a fill made inside a gap, to the first bar
  // after it (marketFillPrice is that bar's open); an expiry stamped at the
  // sweep itself, to the last bar the sweep held, whose close priced it. A
  // settlement nothing priced — a lapse, a terminal unknown — records no
  // exit spread. Not the spread at the exact tick, which no bar feed
  // carries. Null on the mid feed, which was silently leaving it out.
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
  // The rung those finer bars were at ("15min" / "5min"); null when nothing
  // finer was fetched. What the UI names as the refinement rung — never
  // ambiguity.at_interval, which is the coarse deciding bar.
  refined_interval: string | null;
  // Finer bars were needed but could not be fetched this run; the plan stays
  // open and is retried, up to MAX_REFINE_ATTEMPTS provider failures
  refine_pending: boolean;
  refine_attempts: number;
  // The signal bar reached a level and finer bars have not yet said whether
  // that happened before or after the plan was written. Keeps the next sweep
  // from taking the established-fill short-circuit and forgetting the graze.
  signal_bar_pending: boolean;
  // Why an unjudgeable plan could not be judged. Null on every other
  // resolution. Read as a histogram, not per row.
  ambiguity: Ambiguity | null;
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

// Which feed a bar came from: a single mid price, or bid and ask
export type PriceBasis = "mid" | "quotes";

// Finer bars for [fromMs, toMs), tagged with the feed they came from. `null`
// means the provider could not supply them (error, or nothing in the range)
// and counts as one failed attempt; "deferred" means the caller chose not to
// ask this run (request budget) and costs nothing. Both leave the plan open
// for another try.
//
// `basis` is the basis of the coarse series the plan is being judged on, so
// the caller can route to the matching provider. Within one judgement the
// fine bars must have the SAME basis as the coarse series: a stop grazed on
// the bid by less than the spread is invisible on the mid, so mid sub-bars
// under a bid/ask series show no touch where the bid made one, and the
// mirror. fetchRange treats a result of the other basis as a failed attempt
// rather than deciding the plan on it.
export type FineResult =
  | { basis: "mid"; bars: Candle[] }
  | { basis: "quotes"; bars: QuoteCandle[] }
  | null
  | "deferred";
export interface FineFetcher {
  (pair: string, fromMs: number, toMs: number, interval: string, basis: PriceBasis): Promise<FineResult>;
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
  const cadence = CHECK_EVERY_MS[row.interval] ?? HOUR;
  // A plan waiting on a bar to close — a refinement deferred, or a signal
  // bar that was still forming — comes back after one evaluation bar, by
  // which time the bar has certainly closed, instead of a whole cadence
  // later. The cadence is four hours for 4h and 1day plans, which would hold
  // an order of touches already on the tape for three bars longer than
  // necessary. The extra looks cost the group's coarse fetch each time and
  // nothing in attempts. What it moves: waiting rows sort ahead of the
  // frequently checked 15min and 1h plans (older checked_at), so with three
  // waiting groups a sweep's budgets can be spent before those plans' groups
  // are reached — a one-tick deferral for them, once an hour instead of once
  // per four, never indefinite (a deferred group is not stamped and goes
  // first next tick).
  const ev = row.evaluation;
  const waiting = ev?.refine_pending === true || ev?.signal_bar_pending === true;
  const bar = INTERVAL_MS[ev?.eval_interval ?? ""] ?? cadence;
  // Nothing a waiting plan waits for happens while the market is shut, so
  // the weekend is checked at the plan's own cadence, not every bar
  const every = waiting && !isMarketClosed(nowMs) ? Math.min(cadence, bar) : cadence;
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
  refined_interval: null,
  refine_pending: false,
  refine_attempts: 0,
  signal_bar_pending: false,
  ambiguity: null,
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
  // The earliest instant at which the position is KNOWN to have been open.
  // `filled_at` is only as precise as the bar that proved the fill; this is
  // the end of that bar. A market order is exact, so the two are equal.
  fillCertainFrom: number | null;
  possibleFill: boolean;
  mfe: number | null;
  mae: number | null;
}

const EMPTY_STATE: State = { filled: false, filled_at: null, fill_price: null, fillCertainFrom: null, possibleFill: false, mfe: null, mae: null };

type Terminal =
  // `atOpen` marks a resolution decided by the bar's OPEN (see OPEN-THROUGH in
  // step): the position left at the first traded price, so nothing else in
  // that bar happened while the trade was on.
  | { kind: "win" | "loss"; at: string; atOpen?: boolean }
  | { kind: "ambiguous"; at: string; refinable: boolean; why: Ambiguity }
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
const filledAt = (row: OpenRow, at: string, price: number, certainFrom: number): State => ({
  ...EMPTY_STATE,
  filled: true,
  filled_at: at,
  fill_price: price,
  fillCertainFrom: certainFrom,
});

// The bar's first traded price, as a zero-range candle
const openTick = (c: Candle): Candle => ({ ...c, high: c.open, low: c.open });

// Was the position already open before this bar started? Only then can the
// bar's own open price order the levels inside it.
const openBefore = (state: State, bar: Timed): boolean =>
  state.fillCertainFrom !== null && bar.t >= state.fillCertainFrom;

// A bar length as the app spells it, for the record. Unknown lengths are
// written in minutes rather than dropped, so a new rung cannot silently
// report `null`.
const intervalName = (ms: number): string => {
  for (const [name, len] of Object.entries(INTERVAL_MS)) if (len === ms) return name;
  if (ms === REFINE_MS) return REFINE_INTERVAL;
  if (ms === FINE_MS) return FINE_INTERVAL;
  return `${Math.round(ms / MIN)}min`;
};

// What an unjudgeable bar reached, and how big it was against the distance the
// plan put between its own levels.
const ambiguityAt = (
  site: AmbiguitySite,
  row: OpenRow,
  bar: Timed | null,
  touched: "tp1" | "sl" | "both" | null,
): Ambiguity => {
  const span = [row.take_profit_1, row.stop_loss].every(Number.isFinite)
    ? Math.abs(row.take_profit_1 - row.stop_loss)
    : null;
  const range = bar !== null && Number.isFinite(bar.x.high) && Number.isFinite(bar.x.low)
    ? bar.x.high - bar.x.low
    : null;
  return {
    site,
    touched,
    at_interval: bar === null ? null : intervalName(bar.ms),
    bar_range: range === null ? null : Number(range.toFixed(5)),
    span: span === null ? null : Number(span.toFixed(5)),
  };
};

// Which of the plan's levels this bar reached
const touchedBy = (tp: boolean, sl: boolean): "tp1" | "sl" | "both" | null =>
  tp && sl ? "both" : tp ? "tp1" : sl ? "sl" : null;

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
      // No single deciding bar: the ambiguity belongs to the signal bar, not to
      // whichever later bar happened to cross the window. Same shape as the
      // lapse recorded in judgePlan, so the two paths of one situation agree.
      ? { state, event: { kind: "ambiguous", at, refinable: false, why: ambiguityAt("pre_fill", row, null, null) } }
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
        // Maybe in the trade, maybe not: the signal bar could not tell. This
        // is NOT a lapse — the window is still open (the lapse check above
        // returns first) — so it is not pre_fill.
        if (state.possibleFill) {
          return { state, event: { kind: "ambiguous", at, refinable: false, why: ambiguityAt("unfilled_touch", row, bar, touchedBy(tp, sl)) } };
        }
        if (tp && ctx.missedArmed) return { state, event: { kind: "untriggered", reason: "missed", at } };
        if (sl && ctx.invalidatedArmed) return { state, event: { kind: "untriggered", reason: "invalidated", at } };
      }
      return { state, event: { kind: "none" } };
    }
    // Price came from the market side, so on the fill bar only the far side
    // of the entry was traversed as a position
    const sides = orderType === "limit" ? "adverse" : orderType === "stop" ? "favorable" : "both";
    const filled = withExcursion(filledAt(row, at, row.entry_point, bar.t + bar.ms), row, x, sides);
    const fillBar = (t: "tp1" | "sl" | "both") =>
      ({ state: filled, event: { kind: "ambiguous" as const, at, refinable: true, why: ambiguityAt("fill_bar", row, bar, t) } });
    if (tp && sl) return fillBar("both");
    if (tp) {
      return orderType === "limit" || orderType === "unknown"
        ? fillBar("tp1")
        : { state: filled, event: { kind: "win", at } };
    }
    if (sl) {
      return orderType === "stop" || orderType === "unknown"
        ? fillBar("sl")
        : { state: filled, event: { kind: "loss", at } };
    }
    return { state: filled, event: { kind: "filled" } };
  }

  const next = withExcursion(state, row, x);
  if (tp && sl) {
    // OPEN-THROUGH. The open is the bar's first traded price. If the position
    // was already open before this bar began, and the bar OPENS at or beyond
    // one of the levels, that level was reached before anything else in the
    // bar could be: the order is not in doubt and no finer data can revise
    // it. A coherent plan has SL and TP1 on opposite sides of the entry, so
    // at most one of these can fire.
    if (openBefore(state, bar)) {
      const first = openTick(x);
      // Excursion as of the OPEN, not `next`. The position closed at the
      // open, so everything else in this bar is post-exit price action.
      // Folding the whole bar in inflates mae, and mae_r is the ONLY input to
      // the lucky_win / good_call split (postmortem/facts.ts): a clean win
      // through the open would be filed as lucky_win, which — unlike
      // good_call — is citable and is a CONSTRAINT cause, so the bar's
      // post-exit wick would mint evidence for a "do not trade" rule.
      const atOpen = withExcursion(state, row, first);
      if (hitsSl(row.signal, first, row.stop_loss)) return { state: atOpen, event: { kind: "loss", at, atOpen: true } };
      if (hitsTp(row.signal, first, row.take_profit_1)) return { state: atOpen, event: { kind: "win", at, atOpen: true } };
    }
    return { state: next, event: { kind: "ambiguous", at, refinable: true, why: ambiguityAt("in_trade", row, bar, "both") } };
  }
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
const targetsReached = (
  ctx: Ctx,
  bars: Timed[],
  state: State,
  // The TP1 bar was decided by its own open, so none of it is in-trade range.
  // Without this the bar folded back in here and undid the excursion fix in
  // step(), which is what turns a clean win into `lucky_win` downstream.
  exitedAtOpen = false,
): { tps: number[]; state: State } => {
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
    if (!(i === 0 && exitedAtOpen)) state = withExcursion(state, row, x);
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
//
// `prior` is the fill an earlier sweep established, when this runs again
// because the signal bar had not closed then. It stands: the completed bar's
// close can sit back on the market side of a limit the live close had
// crossed, and re-deriving the fill from the closed bar would drop it.
const assessSignalBar = (
  ctx: Ctx,
  reference: number | null,
  signalBar: Timed | null,
  createdMs: number,
  prior?: State,
): { state: State; event: (Terminal & { kind: "ambiguous" }) | null } => {
  const { row, orderType } = ctx;
  // A prior that is only a possible fill is kept too: the touch it records
  // lived in the coarse bar, or in the dropped sub-bar around the signal, and
  // quiet sub-bars after the signal neither confirm nor refute it
  let state = prior ?? EMPTY_STATE;
  if (state.filled) {
    // established already
  } else if (orderType === "market") {
    // A market order does not get the number written on the plan; it gets
    // whatever its own side of the book was showing
    state = filledAt(row, toIso(createdMs), ctx.marketFillPrice, createdMs);
  } else if (
    signalBar !== null && orderType !== "unknown" && reference !== null &&
    touches(signalBar.c, row.entry_point)
  ) {
    const crossed = (reference - row.entry_point) * (signalBar.c.close - row.entry_point) <= 0;
    state = crossed
      ? filledAt(row, toIso(createdMs), row.entry_point, signalBar.t + signalBar.ms)
      : { ...state, possibleFill: true };
  }
  if (state.filled && signalBar !== null) {
    const tp = hitsTp(row.signal, signalBar.x, row.take_profit_1);
    const sl = hitsSl(row.signal, signalBar.x, row.stop_loss);
    // OR, not AND: one level is enough, because the touch may predate the
    // plan. Recording `touched` here is what tests the claim that this is the
    // commonest market_v1 case and that it is usually a single level.
    if (tp || sl) {
      return {
        state,
        event: { kind: "ambiguous", at: toIso(createdMs), refinable: true, why: ambiguityAt("signal_bar", row, signalBar, touchedBy(tp, sl)) },
      };
    }
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
  const basis: PriceBasis = twoSided ? "quotes" : "mid";

  let series = twoSided
    ? quoteTimeline(quotes as QuoteCandle[], row.signal, nowMs, evalMs)
    : timeline(candles, nowMs, evalMs);
  // The series as fetched, before the signal-bar splice replaces one coarse
  // bar with its sub-bars: spreadAtBar falls back to it for an instant no
  // surviving bar contains
  const coarseSeries = series;
  // The end of the coarse bar containing an instant; the instant plus one
  // bar when none does (a fill inside a gap)
  const endOfBarHolding = (ms: number): number => {
    const holder = series.find((b) => b.t <= ms && ms < b.t + b.ms);
    if (holder) return holder.t + holder.ms;
    // A hole at the fill bar: the fill was proved by that bar's close, which
    // ends no later than the next bar's open
    const next = series.find((b) => b.t > ms);
    return Math.min(ms + evalMs, next?.t ?? Infinity);
  };
  // Milliseconds of open market between two instants, sampled by the minute
  const openMsSince = (fromMs: number, toMs: number): number => {
    let open = 0;
    for (let t = fromMs; t < toMs; t += MIN) if (!isMarketClosed(t)) open += MIN;
    return open;
  };
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
  // plan's own number, which is what every judgement used before. The
  // coarse bar's close is the first estimate; once the signal bar is split,
  // the fill is re-priced off the open of the first sub-bar after the signal
  // (see the splice), which is minutes from the instant rather than up to an
  // hour, and does not depend on how far formed the coarse bar was when this
  // sweep read it. Re-derived by every sweep that goes back through the
  // signal bar, so the record ends up the same whichever tick first saw it.
  const marketFillPrice = twoSided
    ? signalBar?.c.close ?? (post.length > 0 ? post[0].c.open : row.entry_point)
    : row.entry_point;
  let ctx: Ctx = {
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
        // `filled_at` is only bar-granular, so it cannot be reused directly as
        // "the position was certainly open from here". A market order is
        // exact — that is the signal instant. Anything else was only proved by
        // the close of the coarse bar that showed the crossing, so the whole
        // of that bar stays off-limits to the open-through rule. Without this,
        // a re-sweep re-admits the fill bar with filled=true, the fine walk
        // sees sub-bars that precede the real limit fill, and a pre-entry stop
        // touch convicts the trade as a loss. That bar's END, not the instant
        // plus a bar: filled_at is the signal instant, mid-bar, and adding a
        // bar to it reached into the bar after, whose open-through a single
        // sweep applies and a re-judge then did not.
        fillCertainFrom: prev.order_type === "market" ? prevFillMs : endOfBarHolding(prevFillMs),
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
  let refinedInterval: string | null = null;
  let refinePending = false;
  let refineAttempts = prev?.refine_attempts ?? 0;
  let note: string | null = null;
  let signalBarPending = false;
  // Whether this sweep split the signal bar to completion, and the sub-bar
  // a split market fill was priced off (its spread is read there too)
  let splitDone = false;
  let fillPricedFrom: Timed | null = null;
  // Bars from the TP1 bar onwards, for the runner view (fine bars when the
  // win came from refinement)
  let afterWin: Timed[] = [];
  let judged = true;
  // Every fine bar the post-bar site adopted, so the spread recorded for an
  // instant decided on one is that bar's and not the coarse bar's it
  // replaced. The signal-bar site needs no entry here: it splices its
  // sub-bars into `series`, where spreadAtBar finds them; and when those
  // sub-bars are themselves split at the post-bar site (a 4h or 1day plan on
  // 1h bars: signal bar to 15min, one of them to 5min), an entry from the
  // signal site would be the coarser bar containing the same instant.
  const fineUsed: Timed[] = [];

  // Finer bars for one coarse bar, carrying its market-time offset. Asked for
  // on the coarse series' own basis and refused on any other: a bid/ask
  // series split with mid sub-bars would miss the touches it was adopted to
  // see (see FineResult).
  const fetchRange = async (bar: Timed, sinceMs?: number): Promise<Timed[] | null | "deferred" | "empty"> => {
    if (!fetchFine) return "deferred";
    const rung = finerRung(bar.ms);
    if (rung === null) return null;
    // A bar still forming is not split: its sub-bars are not all there, and
    // a split that finds no touch in the ones that are would be filed as
    // feed_conflict — terminal, and wrong, when the touch simply sits in the
    // sub-bar not yet published. On a user-triggered run seconds after the
    // analysis the old path did worse: every sub-bar predated the signal, so
    // the graze was filed as terminal no_data at once. Whatever brought the
    // split about — a graze in the signal bar, a fill and a level in one
    // bar, both levels in one bar — waits until the bar has closed, at no
    // cost in attempts or requests, and the plan is looked at again on its
    // next due sweep: isDue brings a waiting plan back after one evaluation
    // bar rather than a whole check cadence.
    if (bar.t + bar.ms > nowMs) return "deferred";
    const fine = await fetchFine(row.pair, bar.t, bar.t + bar.ms, rung.interval, basis);
    if (fine === "deferred") return "deferred";
    if (fine === null) return null;
    // The caller answered on the other feed. That is a contract violation
    // on its side; it costs one attempt here and never decides the plan.
    if (fine.basis !== basis) return null;
    const subBars = fine.basis === "quotes"
      ? quoteTimeline(fine.bars, row.signal, nowMs, rung.ms)
      : timeline(fine.bars, nowMs, rung.ms);
    const inRange = subBars.filter((x) => x.t >= bar.t && x.t < bar.t + bar.ms);
    // Nothing inside the bar at all: the provider answered about some other
    // window, which is a failure like any other.
    if (inRange.length === 0) return null;
    const bars = inRange
      // Splitting the SIGNAL bar exposes the part of it that happened BEFORE
      // the plan existed. Price that had already traded cannot resolve a plan
      // that was not yet written, so those sub-bars are dropped rather than
      // allowed to stop out a trade retroactively.
      //
      // The sub-bar CONTAINING the signal goes too. Its high and low span both
      // sides of the moment the plan was written, so keeping it re-admits the
      // pre-signal extreme through the back door — and under market_v1, where
      // the trade is open from the first instant, that extreme resolves it.
      // Losing at most one fine bar of genuinely post-signal range is the
      // cheaper error: the next bar is along in five minutes, and the trade
      // cannot be decided by something that had already happened.
      .filter((x) => sinceMs === undefined || x.t >= sinceMs)
      .map((x) => ({ ...x, mt: bar.mt + (x.t - bar.t) }));
    // The provider is healthy and every sub-bar it returned predates the
    // signal — the signal fell inside the last one. This coarse bar holds no
    // post-signal price action, so it is evidence about nothing, NOT a
    // provider failure. Counting it as one burned all three attempts on a
    // working feed for roughly a third of all signals.
    return bars.length > 0 ? bars : "empty";
  };
  // Finer data was needed and not obtained: try again next time. Provider
  // failures are counted so a bar nobody can supply does not stall the plan
  // forever; a caller that merely ran out of budget costs nothing.
  // `why` is the ambiguity that was being refined. When the provider starves
  // it, that site SURVIVES: the bar still grazed, and `touched` is still what
  // it reached. Starvation is already on the row as reason "no_data" with
  // refine_attempts at the cap, so `site` does not need to spend itself on
  // it. no_finer_data is only for the case with no labelled bar at all.
  const deferRefinement = (outcome: null | "deferred", why: Ambiguity | null = null) => {
    if (outcome === null) refineAttempts++;
    if (refineAttempts >= MAX_REFINE_ATTEMPTS) {
      terminal = {
        kind: "ambiguous",
        at: checkedAt,
        refinable: false,
        why: why ?? ambiguityAt("no_finer_data", row, null, null),
      };
      note = "no_data";
    } else {
      refinePending = true;
      judged = false;
    }
  };

  if (!isCoherentPlan(row)) {
    terminal = { kind: "ambiguous", at: checkedAt, refinable: false, why: ambiguityAt("incoherent", row, null, null) };
    // signal_bar_pending sends the plan back through assessSignalBar: so an
    // undated graze is looked at again, or — for a signal bar that had not
    // closed at the last sweep — so its later part is looked at at all. The
    // fill that sweep established is handed back in as `prior`.
    // `|| !windowCoversSignal` is the guard on that: once the fetched window
    // no longer reaches the signal, going back would drop into the
    // window_short branch below and lose a fill an earlier sweep had already
    // established. The flag self-terminates: a deferred graze once its
    // refinement has succeeded or failed MAX_REFINE_ATTEMPTS times (a budget
    // deferral costs nothing and does not count, so a starved feed can hold
    // it longer), a forming bar once a bar of open market has passed since
    // it closed.
    // When the window no longer covers the signal, a pending graze is
    // dropped along with the branch — accepted, because index.ts cannot
    // produce it: the quotes series is fetched from the oldest open plan's
    // created_at, the mid series is thousands of bars deep, and the flag
    // lives at most three sweeps.
  } else if (prevFill !== null && (prev?.signal_bar_pending !== true || !windowCoversSignal)) {
    state = prevFill.state;
    post = post.filter((x) => x.t >= prevFill.at);
  } else if (!windowCoversSignal) {
    // The fetched bars start after the signal: whatever happened in between
    // is unknown, so this snapshot cannot say anything about the plan
    judged = false;
    if (ageMs > entryWindowMs) {
      terminal = { kind: "ambiguous", at: checkedAt, refinable: false, why: ambiguityAt("window_short", row, null, null) };
      note = "no_data";
    } else {
      note = "window_short";
    }
  } else {
    // The fill an earlier sweep established, handed back in only where this
    // sweep cannot re-derive it: a limit or stop whose crossing the live
    // close proved and the closed bar no longer shows. A market order is
    // re-derived every time — its fill is the signal instant by definition —
    // so the record ends up what a single sweep at this time would write,
    // whichever tick first saw the bar.
    const prior = orderType === "market" ? undefined : prevFill?.state;
    let sig = assessSignalBar(ctx, reference, signalBar, createdMs, prior);
    // Whether the signal bar can be considered done with, judged on the
    // series as fetched, before any splice moves `signalBar`. Not done with:
    // a bar the clock says is still forming; a bar no later bar follows on
    // the tape, for less than a bar of OPEN market since its end (a feed
    // serving a bar part-formed does so for minutes; the bound is open
    // market, so a plan made in the hour before Friday's close waits until
    // Sunday's open — at its own cadence, since isDue does not hurry a plan
    // while the market is shut, and with no extra fetches); no bar around
    // the signal at all yet (the feed has not emitted it, and the market
    // fill was priced off the plan's own number). Each sends the plan back
    // through this branch next sweep.
    const sb = signalBar;
    const signalBarForming = sb === null
      ? post.length === 0
      : sb.t + sb.ms > nowMs ||
        (!series.some((b) => b.t >= sb.t + sb.ms) && openMsSince(sb.t + sb.ms, nowMs) < evalMs);
    // A coarse signal bar that leaves the fill or the first touches
    // untimed: replace it with finer bars and look again
    if (signalBar !== null && finerRung(signalBar.ms) !== null && (sig.event !== null || sig.state.possibleFill) && fetchFine) {
      const signalRung = finerRung(signalBar.ms)?.interval ?? null;
      const fine = await fetchRange({ ...signalBar, mt: -signalBar.ms }, createdMs);
      if (fine === "empty") {
        // Every sub-bar the provider returned predates the signal, which
        // means the signal fell inside the LAST one — and that is exactly the
        // sub-bar the graze may live in. The feed is healthy, so charging
        // this as a provider failure burned all three attempts for nothing;
        // that half of the problem is real and is fixed here.
        //
        // But the graze must NOT be dropped. Doing so decides the plan off
        // the later bars as if the signal bar had been clean, and the
        // direction of that error follows the market: measured on a probe, a
        // one-minute change in created_at flipped the SAME price data from
        // `ambiguous` to `win`, and at a signal 2/3 of the way into the bar
        // the recorded win is wrong about two times in three.
        //
        // Nor can it be refined away: EVAL_INTERVAL puts 15min and 1h plans
        // on 15min bars, so this sub-bar is already 5min and finerRung(5min)
        // is null. There is no finer rung to ask for. (For 4h/1day plans a
        // 15min sub-bar could still go to 5min — that recursion is the
        // deferred ladder work, and the graze rate there is near zero.)
        //
        // So settle it as terminally unknown: keep the fill assessSignalBar
        // established, keep the graze as the reason, and stop asking.
        refined = true;
        refinedInterval = signalRung;
        if (sig.event !== null) {
          // assessSignalBar only ever raises an ambiguous event, and it is now
          // terminal: no finer rung exists to date the graze.
          terminal = { ...sig.event, refinable: false };
          note = "no_data";
        }
      } else if (fine === null || fine === "deferred") {
        deferRefinement(fine === null ? null : "deferred", sig.event?.why ?? null);
      } else {
        refined = true;
        refinedInterval = signalRung;
        series = [...series.slice(0, signalIdx), ...fine, ...series.slice(signalIdx + 1)];
        ({ firstIdx, signalIdx, signalBar, post } = locate());
        // What the sub-bars can and cannot say about the entry.
        //
        // A market order: filled at the signal instant; on two-sided data,
        // re-priced off the open of the first sub-bar after it — minutes
        // from the fill instead of the coarse bar's close up to an hour
        // later, and independent of how far formed that coarse bar was when
        // read. On the mid feed the plan's own number stays: nothing on that
        // feed is a better fill price, split or not.
        //
        // A limit or stop: the coarse bar dated its fill only to "somewhere
        // in the bar". If a sub-bar after the signal reaches the entry, and
        // no earlier sub-bar sat wholly on the far side of it, the walk
        // re-derives the fill at that sub-bar, and a level touched before it
        // is a miss, not a trade. A sub-bar wholly beyond the entry proves
        // the crossing happened before it — inside the dropped sub-bar
        // around the signal — so the fill stands from the signal instant
        // (certain from that sub-bar's open when this is what establishes
        // it; a fill an earlier sweep proved keeps its own bound), and a
        // level it reaches is a trade. When no sub-bar reaches the entry at
        // all, the coarse bar's
        // finding (a fill, or a possible one) stands: quiet sub-bars neither
        // confirm nor refute a touch that lived in the dropped one.
        //
        // Known limits, all on the legacy contract (analyze has issued only
        // market orders since market_v1, and no legacy row is pending): a
        // gap across the entry between two later sub-bars dates the fill to
        // the signal instant, so the near-side sub-bars before the gap are
        // walked as in the trade; a level reached between the signal and the
        // first surviving touch is a miss even when the dropped sub-bar could
        // have filled the order; a possible fill whose touch a pre-signal
        // sub-bar explains is still carried. Each needs a limit or stop order
        // and a level inside the signal bar.
        splitDone = true;
        if (orderType === "market") {
          if (twoSided) {
            ctx = { ...ctx, marketFillPrice: fine[0].c.open };
            fillPricedFrom = fine[0];
          }
          sig = assessSignalBar(ctx, reference, signalBar, createdMs);
        } else {
          const side = reference === null ? 0 : reference - row.entry_point;
          const beyond = (c: Candle) => side !== 0 && side * (c.high - row.entry_point) < 0 && side * (c.low - row.entry_point) < 0;
          const firstTouch = fine.findIndex((x) => touches(x.c, row.entry_point));
          const firstBeyond = fine.findIndex((x) => beyond(x.c));
          const provedEarlier = firstBeyond >= 0 && (firstTouch < 0 || firstBeyond < firstTouch);
          const reDerived = firstTouch >= 0 && !provedEarlier;
          let carried = reDerived ? undefined : (prior ?? sig.state);
          if (provedEarlier && carried !== undefined && !carried.filled) {
            carried = filledAt(row, toIso(createdMs), row.entry_point, fine[firstBeyond].t);
          }
          sig = assessSignalBar(ctx, reference, signalBar, createdMs, carried);
        }
      }
    }
    // The fill assessSignalBar established stands whatever became of the
    // refinement. Under market_v1 it is a market order at the signal instant
    // and no finer bar can revise it; dropping it wrote `filled_at: null`
    // both on the deferred sweeps and on the terminal one, which took the row
    // out of the fill rate entirely and left mfe/mae empty.
    state = sig.state;
    if (judged && terminal === null && sig.event !== null) terminal = sig.event;
    // A signal bar whose graze is still unresolved must be re-examined next
    // sweep. Without this flag the `prevFill` short-circuit above would drop
    // the signal bar from the evidence for good and score the plan off the
    // post bars as though it had been clean — silently, and win-ward.
    // Sent back through this branch next sweep: a graze whose refinement was
    // deferred, or a signal bar that had not closed. The second matters even
    // when the bar was quiet — under market_v1 the trade is open from the
    // signal instant, and a stop reached later in that same bar is a loss
    // the prevFill short-circuit would never look at: it starts the walk at
    // the bars AFTER the fill, and the signal bar is not one of them, so the
    // plan was scored off the next bar's target instead. With the cron at
    // :03/:18/:33/:48 a 1h signal bar is still forming at the first sweep
    // for about four plans in five.
    // ...but not when this sweep already split the closed bar to
    // completion: fetchQuoteWindow demanded coverage up to the bar's end, so
    // nothing a re-visit could fetch differs, and a provider failure on such
    // a re-visit would count toward the terminal cap for nothing.
    signalBarPending = (!judged && sig.event !== null) || (signalBarForming && !splitDone);
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
        // "empty" is unreachable here: it only arises from the sinceMs filter,
        // and this call passes none. Folded into the failure branch so the
        // union stays exhaustive rather than relying on that staying true.
        if (fine === null || fine === "deferred" || fine === "empty") {
          state = stateBefore;
          deferRefinement(fine === "deferred" ? "deferred" : null, r.event.why);
          break;
        }
        refined = true;
        refinedInterval = finerRung(post[idx].ms)?.interval ?? null;
        fineUsed.push(...fine);
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
          terminal = {
            kind: "ambiguous",
            at: toIso(post[idx].t),
            refinable: false,
            // The coarse bar's own finding: it reached both levels, which is
            // the only reason refinement ran. The finer rung that disagreed is
            // in refined_interval.
            why: ambiguityAt("feed_conflict", row, post[idx], r.event.why.touched),
          };
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

  let ambiguity: Ambiguity | null = null;
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
      const reached = targetsReached(ctx, afterWin, state, terminal.atOpen === true);
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
    } else if (terminal.kind === "ambiguous") {
      resolution = "ambiguous";
      ambiguity = terminal.why;
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
          // Same case as the pre_fill branch in step(): the entry window ran
          // out on a plan the signal bar may already have filled. There is no
          // single deciding bar, so only the site is known.
          ambiguity = ambiguityAt("pre_fill", row, null, null);
        } else {
          resolution = "untriggered";
          reason = "no_fill";
        }
        resolvedAt = checkedAt;
      }
    } else if (marketElapsed > expiryMs) {
      resolution = "expired";
      resolvedAt = checkedAt;
      // Priced on the exit side, like every other exit: `c` is the side the
      // plan was filled on, and an expiry is a close, not a fill
      outcomePrice = last.x.close;
    }
  }

  const contextStart = firstIdx >= 0 ? Math.max(0, firstIdx - PRE_SIGNAL_CONTEXT) : Math.max(0, series.length - PRE_SIGNAL_CONTEXT);
  const contextEnd = terminalIdx >= 0
    ? Math.min(series.length, series.findIndex((x) => x.t === post[terminalIdx].t) + 4)
    : series.length;
  const path = downsamplePath(series.slice(contextStart, contextEnd).map((x) => x.c), PATH_POINTS);

  // The spread at the two moments it mattered, read at the close of the
  // finest bar CONTAINING that instant. Post-bar fine bars first — a
  // settlement decided during refinement was decided on one — then the
  // series as judged (which holds the signal bar's sub-bars after a splice),
  // then the series as fetched: a market fill's instant lies in the sub-bar
  // the splice drops, and only the coarse signal bar it was priced off still
  // contains it. Containment, not "the last bar starting before", which after
  // a splice named the bar BEFORE the signal bar. Before fineUsed existed a
  // post-bar refinement left `series` without its fine bars, so the recorded
  // "spread at exit" was the coarse bar's, up to an hour away from the exit.
  // `orElse` names the bar to read when none contains the instant — the one
  // the price itself came from (see the field comment).
  const spreadOf = (bar: Timed): number | null => {
    if (!twoSided) return null;
    const s = Math.abs(bar.x.close - bar.c.close);
    return Number.isFinite(s) ? Number(s.toFixed(5)) : null;
  };
  const spreadAtBar = (atMs: number | null, orElse: (bars: Timed[]) => Timed | undefined): number | null => {
    if (!twoSided || atMs === null || !Number.isFinite(atMs)) return null;
    const containing = (bars: Timed[]) => bars.find((b) => b.t <= atMs && atMs < b.t + b.ms);
    const bar = containing(fineUsed) ?? containing(series) ?? containing(coarseSeries) ?? orElse(coarseSeries);
    return bar ? spreadOf(bar) : null;
  };
  // A resolved row is never looked at again; a pending flag on it would
  // only contradict the record
  if (resolution !== null) signalBarPending = false;
  const filledMs = state.filled_at ? Date.parse(state.filled_at) : null;
  const settledMs = resolvedAt ? Date.parse(resolvedAt) : null;

  const evaluation: Evaluation = {
    version: 3,
    eval_interval: evalInterval,
    price_basis: basis,
    // A split market fill was priced off the first sub-bar after the
    // signal, so its spread is read there; a fill inside a gap was priced
    // off the first bar after it
    spread_at_fill: fillPricedFrom !== null
      ? spreadOf(fillPricedFrom)
      : spreadAtBar(filledMs, (bars) => bars.find((b) => filledMs !== null && b.t >= filledMs)),
    // A settlement nothing priced — a lapse, a terminal unknown — had no
    // exit to read a spread at, whichever bar it was stamped with. An expiry
    // stamped at the sweep itself was priced off the last bar.
    spread_at_exit: outcomePrice === null ? null : spreadAtBar(settledMs, (bars) => (settledMs === nowMs ? bars[bars.length - 1] : undefined)),
    order_type: orderType,
    price_at_signal: row.price_at_signal,
    possible_fill: state.possibleFill,
    filled_at: state.filled_at,
    fill_price: state.fill_price,
    resolution,
    reason,
    resolved_at: resolvedAt,
    refined,
    refined_interval: refinedInterval,
    refine_pending: refinePending,
    refine_attempts: refineAttempts,
    signal_bar_pending: signalBarPending,
    ambiguity,
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
