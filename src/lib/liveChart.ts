import { supabase } from "@/lib/supabase";
import type { ChartSignalMark, NumericCandle } from "@/lib/types";

// #113: the live chart's two reads (supabase/functions/live-chart), as the
// client accepts them. Anything malformed is dropped rather than drawn.

export const LIVE_CHART_URL = "https://endcqzewujdvimdlazhj.supabase.co/functions/v1/live-chart";
export const LIVE_PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY"];
export const LIVE_INTERVALS = ["1min", "15min", "1h", "4h", "1day"];
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
    decimals: num(r.decimals) ?? (r.pair.includes("JPY") ? 3 : 5),
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
