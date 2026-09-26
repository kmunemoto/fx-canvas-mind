import { supabase } from "@/lib/supabase";
import type { ChartSignalMark, NumericCandle } from "@/lib/types";
import { priceDecimals } from "@/lib/candleTime";

// #113: the live chart's two reads (supabase/functions/live-chart), as the
// client accepts them. Anything malformed is dropped rather than drawn.

export const LIVE_CHART_URL = "https://endcqzewujdvimdlazhj.supabase.co/functions/v1/live-chart";
export const LIVE_PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY", "XAU/USD"];
export const LIVE_INTERVALS = ["1min", "15min", "1h", "4h", "1day"];
// #127: gold (XAU/USD) — its bars from Twelve Data, its price from
// Swissquote (GMO has no gold); no 1-minute chart (the shared key's daily
// allowance)
export const GOLD_PAIR = "XAU/USD";
export const GOLD_INTERVALS = ["15min", "1h", "4h", "1day"];
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
  at: string;
  // v3: "twelvedata" while GMO cannot be read, with why ("maintenance" |
  // "unavailable") and when those bars were fetched
  source: "gmo" | "twelvedata";
  feed: string | null;
  fetchedAt: string | null;
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
    at: typeof r.at === "string" ? r.at : new Date().toISOString(),
    source: r.source === "twelvedata" ? "twelvedata" : "gmo",
    feed: typeof r.feed === "string" ? r.feed : null,
    fetchedAt: typeof r.fetched_at === "string" ? r.fetched_at : null,
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

// The forming bar moved by a new price: its close is the price, its high and
// low only widen. A price for a bar the chart does not have yet (the bar
// closed and the next read has not arrived) changes nothing.
export const applyTick = (candles: NumericCandle[], mid: number, formingOpenMs: number | null, tickMs: number, stepMs: number): NumericCandle[] => {
  if (candles.length === 0 || formingOpenMs === null || !Number.isFinite(mid)) return candles;
  if (!(tickMs >= formingOpenMs && tickMs < formingOpenMs + stepMs)) return candles;
  const last = candles[candles.length - 1];
  const next = { ...last, close: mid, high: Math.max(last.high, mid), low: Math.min(last.low, mid) };
  return [...candles.slice(0, -1), next];
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

export const fetchTicks = async (): Promise<Record<string, Tick>> => normalizeTicks((await call({ action: "ticker" })).ticks);

// #129: Dow theory on four timeframes (supabase/functions/_shared/dow.ts),
// as the live-chart function reads it — gold without the 5-minute one
export const DOW_TFS = ["4h", "1h", "15min", "5min"];
export const dowTfsFor = (pair: string): string[] => (pair === GOLD_PAIR ? DOW_TFS.slice(0, 3) : DOW_TFS);
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

// The history joined to the chart's candles: those older than the chart's
// first, or null when the history ends before the chart begins (it was
// read too long ago, and a gap would move every average)
export const historyBefore = (history: ReadonlyArray<NumericCandle> | null, candles: ReadonlyArray<NumericCandle>): NumericCandle[] | null => {
  if (!history || history.length === 0 || candles.length === 0) return null;
  const first = candles[0].datetime;
  if (history[history.length - 1].datetime < first) return null;
  return history.filter((h) => h.datetime < first);
};
