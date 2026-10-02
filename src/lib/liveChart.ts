import { supabase } from "@/lib/supabase";
import type { ChartSignalMark, NumericCandle } from "@/lib/types";
import { parseUtcCandleTime, priceDecimals } from "@/lib/candleTime";

// #113: the live chart's two reads (supabase/functions/live-chart), as the
// client accepts them. Anything malformed is dropped rather than drawn.

export const LIVE_CHART_URL = "https://endcqzewujdvimdlazhj.supabase.co/functions/v1/live-chart";
// #153: every pair GMO serves, in the owner's broker's order (楽天FX), then
// gold — as the function lists them. #154: and 15 of the broker's pairs GMO
// does not serve, read as gold is (their bars Twelve Data's, their price
// Swissquote's); the broker's CNH/JPY and CNH/HKD have no feed here.
// #175: the yen pairs only (「通貨のペアを円とどれかだけにして」), in the
// broker's order — 12 GMO serves, 5 read as gold is. #177: and EUR/USD
// again (「ユーロドル追加して」), in its place, from GMO. #178: and AUD/USD
// again (「豪ドル/ドル、追加して」), likewise. #180: and USD/CAD again
// (「ドルカナダドルも追加して」), in its place, read as gold is
export const LIVE_FX_PAIRS = [
  "USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY",
  "EUR/USD", "AUD/USD", "MXN/JPY", "NZD/JPY",
  "ZAR/JPY", "CAD/JPY", "CHF/JPY", "TRY/JPY",
  "USD/CAD", "HKD/JPY", "SGD/JPY", "NOK/JPY",
  "HUF/JPY", "SEK/JPY", "PLN/JPY", "CZK/JPY",
];
// #154: those read as gold is
export const TWELVE_FX_PAIRS = [
  "USD/CAD", "HKD/JPY", "SGD/JPY", "NOK/JPY", "PLN/JPY", "CZK/JPY",
];
export const isTwelveFx = (pair: string): boolean => TWELVE_FX_PAIRS.includes(pair);
export const LIVE_COMMODITIES = ["XAU/USD"];
export const LIVE_PAIRS = [...LIVE_FX_PAIRS, ...LIVE_COMMODITIES];
// the picker's groups, as the broker's lists are split
export const LIVE_PAIR_GROUPS: Array<{ key: "fx" | "commodities"; pairs: string[] }> = [
  { key: "fx", pairs: LIVE_FX_PAIRS },
  { key: "commodities", pairs: LIVE_COMMODITIES },
];
// #146: the 5-minute chart too, for every pair. #181: the broker's (楽天FX)
// bar timeframes, in its menu's order (「足の種類、これだけ追加して」) — as
// the function lists them (supabase/functions/live-chart/logic.ts)
export const LIVE_INTERVALS = [
  "1min", "2min", "3min", "4min", "5min", "10min", "15min", "30min",
  "1h", "2h", "4h", "8h", "1day", "1week", "1month",
];
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
// Each timeframe's length, as the function's LIVE_STEP_MS: a month's is the
// longest (31 days); when a month's bar closes is barEndMs's
export const INTERVAL_STEP_MS: Record<string, number> = {
  "1min": MIN_MS, "2min": 2 * MIN_MS, "3min": 3 * MIN_MS, "4min": 4 * MIN_MS,
  "5min": 5 * MIN_MS, "10min": 10 * MIN_MS, "15min": 15 * MIN_MS, "30min": 30 * MIN_MS,
  "1h": HOUR_MS, "2h": 2 * HOUR_MS, "4h": 4 * HOUR_MS, "8h": 8 * HOUR_MS,
  "1day": DAY_MS, "1week": 7 * DAY_MS, "1month": 31 * DAY_MS,
};
// #181: when a bar that opened at `openMs` closes, as the function's
// barEndMs: its open and its length, and a month's at the next month's open
// at the same time of day (GMO's at 06:00 JST on the 1st, Twelve Data's at
// 00:00 UTC). NaN for a timeframe the chart does not have.
export const barEndMs = (interval: string, openMs: number): number => {
  if (!Number.isFinite(openMs)) return Number.NaN;
  if (interval === "1month") {
    const d = new Date(openMs + 12 * HOUR_MS);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + (openMs - start);
  }
  const step = INTERVAL_STEP_MS[interval];
  return step === undefined ? Number.NaN : openMs + step;
};
// #127: gold (XAU/USD) — its bars from Twelve Data, its price from
// Swissquote (GMO has no gold); #146: every timeframe, the 1- and 5-minute
// ones too, within the day's reads the function keeps for each
export const GOLD_PAIR = "XAU/USD";
export const GOLD_INTERVALS = LIVE_INTERVALS;
export const intervalsFor = (pair: string): string[] => (pair === GOLD_PAIR ? GOLD_INTERVALS : LIVE_INTERVALS);
// How often the price is asked for while the chart is on screen
export const TICK_MS = 5_000;

type Side = "BUY" | "SELL";

export interface LiveRead {
  pair: string;
  interval: string;
  ok: boolean;
  reason: string | null;
  decimals: number;
  candles: NumericCandle[];
  rsi: Array<number | null>;
  sar: Array<number | null>;
  sarBelow: Array<boolean | null>;
  marks: ChartSignalMark[];
  now: { datetime: string | null; rsi: number | null; sarBelow: boolean | null; rsiSar: Side | null; gainz: Side | null };
  latest: { rsiSar: ChartSignalMark | null; gainz: ChartSignalMark | null };
  spread: number | null;
  nextClose: string | null;
  // #181: the forming bar's open, as the function says (ms; null: none, or
  // an older function that does not say)
  formingOpen: number | null;
  at: string;
  // v3: "twelvedata" while GMO cannot be read, with why ("maintenance" |
  // "unavailable") and when those bars were fetched — or, as the pair's own
  // feed, "gold" (#127) and "twelve" (#154, a pair GMO does not serve)
  source: "gmo" | "twelvedata";
  feed: string | null;
  fetchedAt: string | null;
  // #146: Twelve Data's bars could not be read again: the day's reads for
  // this timeframe are spent, so these are the ones read at fetchedAt
  limited: boolean;
  // #147: gold's bars from this one on are made from the prices recorded
  // since Twelve Data was last read (ISO), or null
  ticksFrom: string | null;
  // when the market reopens, while it may be shut
  reopens: string | null;
}

export interface Tick {
  bid: number;
  ask: number;
  mid: number;
  time: string | null;
  open: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const sideOf = (v: unknown): Side | null => (v === "BUY" || v === "SELL" ? v : null);
const OUTCOMES = new Set(["win", "loss", "ambiguous", "expired", "open"]);

const mark = (v: unknown): ChartSignalMark | null => {
  const m = rec(v);
  const side = sideOf(m?.side);
  if (!m || typeof m.datetime !== "string" || !side || typeof m.rule !== "string" || typeof m.outcome !== "string" || !OUTCOMES.has(m.outcome)) {
    return null;
  }
  return {
    datetime: m.datetime,
    barsAgo: num(m.barsAgo) ?? 0,
    side,
    rule: m.rule,
    level: num(m.level),
    entry: num(m.entry),
    stop: num(m.stop),
    target: num(m.target),
    stop_atr: num(m.stop_atr),
    outcome: m.outcome as ChartSignalMark["outcome"],
    bars: num(m.bars),
    mfe_r: num(m.mfe_r),
  };
};

const candle = (v: unknown): NumericCandle | null => {
  const c = rec(v);
  if (!c || typeof c.datetime !== "string") return null;
  const [o, h, l, cl] = [num(c.open), num(c.high), num(c.low), num(c.close)];
  if (o === null || h === null || l === null || cl === null) return null;
  return { datetime: c.datetime, open: o, high: h, low: l, close: cl };
};

export const normalizeLiveRead = (value: unknown): LiveRead | null => {
  const r = rec(value);
  if (!r || typeof r.pair !== "string" || typeof r.interval !== "string" || !Array.isArray(r.candles)) return null;
  const candles = r.candles.map(candle);
  // one bad candle would shift every aligned series under it: all or nothing
  if (candles.some((c) => c === null) || candles.length === 0) return null;
  const n = candles.length;
  const aligned = <T,>(v: unknown, f: (x: unknown) => T): T[] =>
    Array.isArray(v) && v.length === n ? v.map(f) : Array.from({ length: n }, () => f(null));
  const now = rec(r.now);
  const latest = rec(r.latest);
  return {
    pair: r.pair,
    interval: r.interval,
    ok: r.ok === true,
    reason: typeof r.reason === "string" ? r.reason : null,
    decimals: num(r.decimals) ?? priceDecimals(r.pair),
    candles: candles as NumericCandle[],
    rsi: aligned(r.rsi, num),
    sar: aligned(r.sar, num),
    sarBelow: aligned(r.sar_below, (x) => (typeof x === "boolean" ? x : null)),
    marks: Array.isArray(r.marks) ? r.marks.map(mark).filter((m): m is ChartSignalMark => m !== null) : [],
    now: {
      datetime: typeof now?.datetime === "string" ? now.datetime : null,
      rsi: num(now?.rsi),
      sarBelow: typeof now?.sar_below === "boolean" ? now.sar_below : null,
      rsiSar: sideOf(now?.rsi_sar),
      gainz: sideOf(now?.gainz),
    },
    latest: { rsiSar: mark(latest?.rsi_sar), gainz: mark(latest?.gainz) },
    spread: num(r.spread),
    nextClose: typeof r.next_close === "string" ? r.next_close : null,
    formingOpen: typeof r.forming_open === "string" && Number.isFinite(Date.parse(r.forming_open)) ? Date.parse(r.forming_open) : null,
    at: typeof r.at === "string" ? r.at : new Date().toISOString(),
    source: r.source === "twelvedata" ? "twelvedata" : "gmo",
    feed: typeof r.feed === "string" ? r.feed : null,
    fetchedAt: typeof r.fetched_at === "string" ? r.fetched_at : null,
    limited: r.limited === true,
    ticksFrom: typeof r.ticks_from === "string" ? r.ticks_from : null,
    reopens: typeof r.reopens === "string" ? r.reopens : null,
  };
};

export const normalizeTicks = (value: unknown): Record<string, Tick> => {
  const t = rec(value);
  const out: Record<string, Tick> = {};
  if (!t) return out;
  for (const [pair, v] of Object.entries(t)) {
    const x = rec(v);
    const bid = num(x?.bid);
    const ask = num(x?.ask);
    if (bid === null || ask === null || ask < bid) continue;
    out[pair] = { bid, ask, mid: num(x?.mid) ?? (bid + ask) / 2, time: typeof x?.time === "string" ? x.time : null, open: x?.open === true };
  }
  return out;
};

// #147: the chart in real time between reads (「チャートはいつもリアルタイム
// で表示するように」; it had moved the forming bar only, with the newest
// price alone). What the prices have made on top of the last read:
//   * the forming bar keeps the highest and lowest price since (moving it
//     with the newest price alone let a wick shrink back when the price
//     turned);
//   * once its time is up, the next price starts the next bar there and
//     then, on the bars' own grid, instead of the chart standing still
//     until the next read (a few seconds after each close, or longer when a
//     read cannot be had);
//   * a new read replaces all of it, except bars newer than its own (a read
//     that could not be refreshed).
export interface LiveBars {
  candles: NumericCandle[];
  // when the newest candle opened, while it is forming (ms)
  formingOpen: number | null;
}

const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// One price at its own time. #181: `endOf` gives a bar's close from its open
// when the bars are not all one length (a month's: barEndMs); by default
// the open and `stepMs`.
export const tickLive = (
  live: LiveBars,
  mid: number,
  tickMs: number,
  stepMs: number,
  endOf: (openMs: number) => number = (o) => o + stepMs,
): LiveBars => {
  const { candles } = live;
  if (candles.length === 0 || !Number.isFinite(mid) || mid <= 0 || !Number.isFinite(tickMs) || !(stepMs > 0)) return live;
  const last = candles[candles.length - 1];
  const lastOpen = parseUtcCandleTime(last.datetime);
  if (!Number.isFinite(lastOpen) || tickMs < lastOpen) return live;
  const lastEnd = endOf(lastOpen);
  if (!(lastEnd > lastOpen)) return live;
  if (live.formingOpen === lastOpen && tickMs < lastEnd) {
    if (mid === last.close && mid <= last.high && mid >= last.low) return live;
    const next = { ...last, close: mid, high: Math.max(last.high, mid), low: Math.min(last.low, mid) };
    return { candles: [...candles.slice(0, -1), next], formingOpen: lastOpen };
  }
  // a price inside the newest bar's time, when that bar is not forming
  // (a read taken just as it closed): it is left as read
  if (tickMs < lastEnd) return live;
  // the bar the price falls in, on the bars' own grid
  let open = lastEnd;
  for (let next = endOf(open); next <= tickMs && next > open; next = endOf(open)) open = next;
  return { candles: [...candles, { datetime: stamp(open), open: mid, high: mid, low: mid, close: mid }], formingOpen: open };
};

// #149: how many of the newest candles on screen no indicator judges on:
// everything after the read's last closed bar — its forming bar, and the
// bars the prices made since (their open, high, low and close are the
// prices seen here, not the feed's; the next read brings the feed's)
export const unjudgedOf = (readLength: number, readForming: boolean, shownLength: number): number =>
  Math.max(0, shownLength - (readLength - (readForming ? 1 : 0)));

// A new read: its candles, and after them the bars the prices made that
// are newer than its own
export const withRead = (candles: NumericCandle[], formingOpen: number | null, prev: LiveBars | null): LiveBars => {
  const base = { candles, formingOpen };
  if (!prev || candles.length === 0) return base;
  const newest = parseUtcCandleTime(candles[candles.length - 1].datetime);
  if (!Number.isFinite(newest)) return base;
  const newer = prev.candles.filter((c) => parseUtcCandleTime(c.datetime) > newest);
  return newer.length === 0 ? base : { candles: [...candles, ...newer], formingOpen: prev.formingOpen };
};

export class LiveChartError extends Error {
  // when the market reopens, if the function said
  constructor(public code: string, public reopens: string | null = null) {
    super(code);
  }
}

const call = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new LiveChartError("login_required");
  const res = await fetch(LIVE_CHART_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const data = rec(await res.json().catch(() => null));
  if (!res.ok || !data || data.ok !== true) {
    throw new LiveChartError(typeof data?.error === "string" ? data.error : `http_${res.status}`, typeof data?.reopens === "string" ? data.reopens : null);
  }
  return data;
};

export const fetchLiveBars = async (pair: string, interval: string): Promise<LiveRead> => {
  const data = await call({ action: "bars", pair, interval });
  const read = normalizeLiveRead(rec(data.read) ? { ...(data.read as Record<string, unknown>), reopens: data.reopens } : data.read);
  if (!read) throw new LiveChartError("bad_response");
  return read;
};

// #154: told the pair on screen, whose price the function then reads each
// time when it is one Swissquote prices
export const fetchTicks = async (pair?: string): Promise<Record<string, Tick>> =>
  normalizeTicks((await call(pair ? { action: "ticker", pair } : { action: "ticker" })).ticks);

// #154: a read whose bars are the pair's own feed's (GMO's, or Twelve Data's
// for gold and the pairs GMO does not serve) — not a stand-in while GMO is
// down — so the price moves them and the history joins them
export const ownFeed = (r: LiveRead): boolean => r.source === "gmo" || r.feed === "gold" || r.feed === "twelve";

// #129: Dow theory on four timeframes (supabase/functions/_shared/dow.ts),
// as the live-chart function reads it — #146: gold's 5-minute one too
export const DOW_TFS = ["4h", "1h", "15min", "5min"];
export const dowTfsFor = (_pair: string): string[] => DOW_TFS;
export type DowState = "up" | "down" | "toDown" | "toUp" | "none";
export interface DowPoint {
  price: number;
  at: string | null;
}
export interface DowTf {
  tf: string;
  state: DowState;
  since: string | null;
  key: (DowPoint & { kind: "pushLow" | "pullHigh" }) | null;
  high: DowPoint | null;
  low: DowPoint | null;
  swings: Array<DowPoint & { kind: "H" | "L"; label: string | null }>;
  events: Array<{ kind: "update" | "break1" | "confirm" | "cancel"; dir: "up" | "down"; level: number; at: string | null }>;
  asOf: string | null;
}
const DOW_STATES = new Set(["up", "down", "toDown", "toUp", "none"]);
const point = (v: unknown): DowPoint | null => {
  const r = rec(v);
  const price = num(r?.price);
  return r && price !== null ? { price, at: typeof r.at === "string" ? r.at : null } : null;
};
export const normalizeDow = (value: unknown): DowTf[] => {
  if (!Array.isArray(value)) return [];
  const out: DowTf[] = [];
  for (const v of value) {
    const r = rec(v);
    if (!r || typeof r.tf !== "string" || typeof r.state !== "string" || !DOW_STATES.has(r.state)) continue;
    const key = point(r.key);
    const keyKind = rec(r.key)?.kind;
    out.push({
      tf: r.tf,
      state: r.state as DowState,
      since: typeof r.since === "string" ? r.since : null,
      key: key && (keyKind === "pushLow" || keyKind === "pullHigh") ? { ...key, kind: keyKind } : null,
      high: point(r.high),
      low: point(r.low),
      swings: Array.isArray(r.swings)
        ? r.swings.flatMap((s) => {
          const p = point(s);
          const k = rec(s)?.kind;
          const label = rec(s)?.label;
          return p && (k === "H" || k === "L") ? [{ ...p, kind: k, label: typeof label === "string" ? label : null }] : [];
        })
        : [],
      events: Array.isArray(r.events)
        ? r.events.flatMap((e) => {
          const x = rec(e);
          const level = num(x?.level);
          const kind = x?.kind;
          const dir = x?.dir;
          return x && level !== null && (kind === "update" || kind === "break1" || kind === "confirm" || kind === "cancel") && (dir === "up" || dir === "down")
            ? [{ kind, dir, level, at: typeof x.at === "string" ? x.at : null }]
            : [];
        })
        : [],
      asOf: typeof r.as_of === "string" ? r.as_of : null,
    });
  }
  return out;
};

export const fetchDow = async (pair: string): Promise<DowTf[]> => normalizeDow((await call({ action: "dow", pair })).dow);

// #124: the closed bars before the chart's own, for Zone Shift's 200-bar
// average — all or nothing, like the bars (a gap would move every average)
export const normalizeHistory = (value: unknown): NumericCandle[] | null => {
  const r = rec(value);
  if (!r || !Array.isArray(r.candles)) return null;
  const candles = r.candles.map(candle);
  if (candles.some((c) => c === null) || candles.length === 0) return null;
  return candles as NumericCandle[];
};

export const fetchLiveHistory = async (pair: string, interval: string): Promise<NumericCandle[]> => {
  const got = normalizeHistory((await call({ action: "history", pair, interval })).history);
  if (!got) throw new LiveChartError("bad_response");
  return got;
};

// #176: the deep history, for the Zero-lag TEMA (live-chart's `deep`):
// `complete` false while the function's read stopped short (asked again)
export const fetchLiveDeepHistory = async (pair: string, interval: string): Promise<{ bars: NumericCandle[]; complete: boolean }> => {
  const res = await call({ action: "history", pair, interval, deep: true });
  const got = normalizeHistory(res.history);
  if (!got) throw new LiveChartError("bad_response");
  return { bars: got, complete: res.complete !== false };
};

// The history joined to the chart's candles: those older than the chart's
// first, or null when the history ends before the chart begins (it was
// read too long ago, and a gap would move every average)
export const historyBefore = (history: ReadonlyArray<NumericCandle> | null, candles: ReadonlyArray<NumericCandle>): NumericCandle[] | null => {
  if (!history || history.length === 0 || candles.length === 0) return null;
  const first = candles[0].datetime;
  if (history[history.length - 1].datetime < first) return null;
  return history.filter((h) => h.datetime < first);
};
