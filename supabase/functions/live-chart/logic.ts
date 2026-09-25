// #113: the live chart — five pairs, the app's own drawing, RSI + SAR and
// the GA-style rule marked on it.
//
// The request (2026-09-25): 「リアルタイムのチャートを表示するようにできる？
// 5パターンぐらいでいい」, then, asked what the five were and how to build it:
// five currency pairs, drawn by the app (not an embedded TradingView chart),
// so the app's signals can sit on it.
//
// Two reads, both from GMO Coin's public API (no key, the feed every signal
// is settled on):
//   * bars: the last READ_BARS closed bars and the one forming, bid/ask, read
//     for RSI + SAR and the GA-style rule exactly as the analysis and the
//     alerts read them (closed bars only). The client asks again when a bar
//     closes.
//   * ticker: one request for every pair's bid and ask now. The client asks
//     every few seconds and moves the forming bar with it.
//
// Everything here is Deno-free: src/test/live-chart.test.ts imports it.

import type { Candle } from "../analyze/indicators.ts";
import { chartRsiSar, readRsiSar } from "../analyze/rsisar.ts";
import { chartGainz, readGainz } from "../analyze/gainz.ts";
import { barOpenMs } from "../analyze/state.ts";
import { fetchRecentQuotes, midCandle } from "../analyze/price-source.ts";
import { fetchYearQuotes } from "../signal-alerts/logic.ts";
import { GMO_HOST, GMO_INTERVALS, GMO_SYMBOLS, type Fetcher, type QuoteCandle } from "../track-outcomes/quotes.ts";

export const LIVE_PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY"] as const;
export const LIVE_INTERVALS = ["1min", "15min", "1h", "4h", "1day"] as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
export const LIVE_STEP_MS: Record<string, number> = {
  "1min": MIN,
  "15min": 15 * MIN,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1day": 24 * HOUR,
};

// Closed bars read (the alerts read the same number) and bars drawn
export const READ_BARS = 200;
export const CHART_BARS = 120;

export const isLivePair = (v: unknown): v is string => typeof v === "string" && (LIVE_PAIRS as readonly string[]).includes(v);
export const isLiveInterval = (v: unknown): v is string => typeof v === "string" && (LIVE_INTERVALS as readonly string[]).includes(v);

const decimalsOf = (pair: string) => (pair.toUpperCase().includes("JPY") ? 3 : 5);
const round = (v: number | null | undefined, d: number): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));

// READ_BARS closed bars and the one forming, oldest first
export const fetchLiveQuotes = async (
  pair: string,
  interval: string,
  nowMs: number,
  deadlineMs: number,
  fetcher: Fetcher,
): Promise<QuoteCandle[] | null> => {
  const spec = GMO_INTERVALS[interval];
  if (!spec || !isLivePair(pair) || !isLiveInterval(interval)) return null;
  if (spec.key === "day") {
    const got = await fetchRecentQuotes(pair, interval, READ_BARS + 1, nowMs, deadlineMs, fetcher);
    return got ? got.bars : null;
  }
  return fetchYearQuotes(pair, interval, READ_BARS + 1, nowMs, fetcher);
};

// The closed bars (mid) and the one still forming, if the feed has it
export const splitBars = (quotes: QuoteCandle[], interval: string, nowMs: number) => {
  const step = LIVE_STEP_MS[interval];
  const closed: QuoteCandle[] = [];
  let forming: QuoteCandle | null = null;
  for (const q of quotes) {
    const t = Date.parse(q.datetime);
    if (!Number.isFinite(t) || step === undefined) continue;
    if (t + step <= nowMs) closed.push(q);
    else if (t <= nowMs) forming = q;
  }
  return { closed: closed.map(midCandle), forming: forming ? midCandle(forming) : null, formingQuote: forming };
};

// What the client draws: the candles (the forming one last), RSI and the
// SAR aligned to them, both rules' signals as marks, and each rule's
// reading on the newest closed bar.
export const liveRead = (pair: string, interval: string, quotes: QuoteCandle[], nowMs: number) => {
  const d = decimalsOf(pair);
  const step = LIVE_STEP_MS[interval];
  const { closed, forming, formingQuote } = splitBars(quotes, interval, nowMs);
  const rs = readRsiSar(closed);
  const ga = readGainz(closed);
  const drawn = chartRsiSar(rs, CHART_BARS, d);
  const shown = closed.slice(-CHART_BARS);
  const candle = (c: Candle) => ({ datetime: c.datetime, open: round(c.open, d)!, high: round(c.high, d)!, low: round(c.low, d)!, close: round(c.close, d)! });
  const candles = [...shown.map(candle), ...(forming ? [candle(forming)] : [])];
  // the forming bar has no RSI yet; its SAR is the one it is measured against
  const rsi = [...drawn.rsi, ...(forming ? [null] : [])];
  const sar = [...drawn.sar, ...(forming ? [round(rs.next?.sar?.level, d)] : [])];
  const sarBelow = [...drawn.sar_below, ...(forming ? [rs.next?.sar?.long ?? null] : [])];
  const first = shown[0]?.datetime ?? null;
  // barsAgo is counted from the newest CLOSED bar, as everywhere else
  const marks = first === null
    ? []
    : [...drawn.marks, ...chartGainz(ga, CHART_BARS, d)]
      .filter((m) => m.datetime >= first)
      .sort((a, b) => (a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0));
  const lastClosed = closed[closed.length - 1] ?? null;
  const lastOpen = lastClosed ? barOpenMs(lastClosed.datetime) : Number.NaN;
  // when the bar now forming closes: the client asks again then
  const nextCloseMs = forming
    ? barOpenMs(forming.datetime) + step
    : Number.isFinite(lastOpen) ? lastOpen + 2 * step : null;
  const newest = (rule: string) => {
    const own = marks.filter((m) => m.rule === rule);
    return own.length > 0 ? own[own.length - 1] : null;
  };
  return {
    pair,
    interval,
    ok: rs.ok,
    reason: rs.reason,
    decimals: d,
    candles,
    rsi,
    sar,
    sar_below: sarBelow,
    marks,
    now: {
      datetime: lastClosed?.datetime ?? null,
      rsi: round(rs.now?.rsi, 1),
      sar_below: rs.now?.long ?? null,
      rsi_sar: rs.now?.signal ?? null,
      gainz: ga.now?.signal ?? null,
    },
    latest: { rsi_sar: newest("rsi_sar"), gainz: newest("gainz") },
    spread: formingQuote ? round(formingQuote.ask.close - formingQuote.bid.close, d) : null,
    next_close: nextCloseMs !== null && Number.isFinite(nextCloseMs) ? new Date(nextCloseMs).toISOString() : null,
    at: new Date(nowMs).toISOString(),
  };
};

export type LiveRead = ReturnType<typeof liveRead>;

// ---- the ticker ----------------------------------------------------------------------

export const TICKER_URL = `${GMO_HOST}/ticker`;

export interface Tick {
  bid: number;
  ask: number;
  mid: number;
  // when GMO priced it, ISO
  time: string | null;
  // GMO's own flag: the pair is trading now
  open: boolean;
}

// {status: 0, data: [{symbol: "USD_JPY", bid: "150.123", ask: "150.126",
// timestamp: "...", status: "OPEN"}]} — only the live pairs, and only a
// sane book
export const parseTicker = (body: unknown): Record<string, Tick> => {
  const out: Record<string, Tick> = {};
  if (typeof body !== "object" || body === null) return out;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  const bySymbol = new Map(Object.entries(GMO_SYMBOLS).map(([pair, sym]) => [sym, pair]));
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const pair = typeof r.symbol === "string" ? bySymbol.get(r.symbol) : undefined;
    if (!pair || !isLivePair(pair)) continue;
    const bid = Number(r.bid);
    const ask = Number(r.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) continue;
    out[pair] = {
      bid,
      ask,
      mid: (bid + ask) / 2,
      time: typeof r.timestamp === "string" ? r.timestamp : null,
      open: r.status === "OPEN",
    };
  }
  return out;
};
