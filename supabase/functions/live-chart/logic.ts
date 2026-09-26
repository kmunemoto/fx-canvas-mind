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

import { parseCandles, type Candle } from "../analyze/indicators.ts";
import { barFullyClosed } from "../_shared/market-hours.ts";
import { chartRsiSar, readRsiSar } from "../analyze/rsisar.ts";
import { chartGainz, readGainz } from "../analyze/gainz.ts";
import { barOpenMs } from "../analyze/state.ts";
import { fetchRecentQuotes, midCandle } from "../analyze/price-source.ts";
import { fetchYearQuotes } from "../signal-alerts/logic.ts";
import { GMO_HOST, GMO_INTERVALS, GMO_SYMBOLS, type Fetcher, type QuoteCandle } from "../track-outcomes/quotes.ts";

// #127: and gold (XAU/USD), which GMO does not carry — see "gold" below
export const LIVE_PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY", "XAU/USD"] as const;
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
// #124: closed bars read for the chart's history — the candles before the
// ones drawn, which Zone Shift's 200-bar average needs before its first
// value. Asked for only while that indicator is on, and apart from the
// bars above, so the signals read exactly what they did.
export const HISTORY_BARS = 600;

export const isLivePair = (v: unknown): v is string => typeof v === "string" && (LIVE_PAIRS as readonly string[]).includes(v);
export const isLiveInterval = (v: unknown): v is string => typeof v === "string" && (LIVE_INTERVALS as readonly string[]).includes(v);

// ---- #127: gold -----------------------------------------------------------------------
//
// The request (2026-09-26), with a TradingView chart of 金CFD (US$/oz):
// 「金cFDを追加して」. GMO's FX feed has no gold (its /symbols lists 21 FX
// pairs), so gold's chart has its own two reads:
//   * bars: Twelve Data's XAU/USD ("Gold Spot / US Dollar", on the Basic
//     plan: its symbol_search with show_plan says so), kept in
//     public.live_chart_fallback and read again once a bar has closed since;
//   * price: Swissquote's public quotes (no key), every few seconds with the
//     FX ticker, moving the forming bar as GMO's price does for the pairs.
// No 1-minute chart: a new bar a minute would need up to 1,440 reads a day of
// a key that allows 800 and is shared with the analysis.
export const GOLD = "XAU/USD";
export const isGold = (pair: string): boolean => pair.toUpperCase() === GOLD;
export const GOLD_INTERVALS = ["15min", "1h", "4h", "1day"] as const;
export const intervalsFor = (pair: string): readonly string[] => (isGold(pair) ? GOLD_INTERVALS : LIVE_INTERVALS);
// Bars read at once: enough for the chart, its signals and Zone Shift's history
export const GOLD_BARS = 800;
// Stored gold bars are fresh while no bar has closed since they were read
// (a bar opens on the UTC grid of its length, as Twelve Data's do); while the
// market may be shut, for FALLBACK_TTL_MS
export const goldFresh = (fetchedAtMs: number, nowMs: number, interval: string, marketShut: boolean): boolean => {
  const step = LIVE_STEP_MS[interval];
  if (!Number.isFinite(fetchedAtMs) || step === undefined) return false;
  if (marketShut) return nowMs - fetchedAtMs < FALLBACK_TTL_MS;
  return fetchedAtMs >= Math.floor(nowMs / step) * step;
};

export const GOLD_QUOTE_URL = "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD";
// A quote older than this is not a market trading now (the daily break, the weekend)
export const GOLD_QUOTE_STALE_MS = 3 * 60_000;
// [{topo: {platform}, spreadProfilePrices: [{spreadProfile: "standard",
// bid, ask}, ...], ts}] — the first platform's standard profile (or its
// first), and only a sane book
export const parseSwissquote = (body: unknown, nowMs: number): Tick | null => {
  if (!Array.isArray(body)) return null;
  for (const platform of body) {
    if (typeof platform !== "object" || platform === null) continue;
    const p = platform as { spreadProfilePrices?: unknown; ts?: unknown };
    if (!Array.isArray(p.spreadProfilePrices) || p.spreadProfilePrices.length === 0) continue;
    const profiles = p.spreadProfilePrices.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
    const pick = profiles.find((x) => x.spreadProfile === "standard") ?? profiles[0];
    const bid = Number(pick?.bid);
    const ask = Number(pick?.ask);
    const ts = Number(p.ts);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid || !Number.isFinite(ts)) continue;
    return { bid, ask, mid: (bid + ask) / 2, time: new Date(ts).toISOString(), open: nowMs - ts < GOLD_QUOTE_STALE_MS };
  }
  return null;
};

// Gold's stored bars -> the chart's read, and its closed bars for the history
export const goldRead = (bars: Candle[], interval: string, nowMs: number, fetchedAt: string) =>
  fallbackRead(GOLD, interval, bars, nowMs, { source: "twelvedata", feed: "gold", fetchedAt });

const decimalsOf = (pair: string) => (isGold(pair) ? 2 : pair.toUpperCase().includes("JPY") ? 3 : 5);
const round = (v: number | null | undefined, d: number): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));

// READ_BARS closed bars and the one forming, oldest first (#124: or as
// many as asked for, for the history)
export const fetchLiveQuotes = async (
  pair: string,
  interval: string,
  nowMs: number,
  deadlineMs: number,
  fetcher: Fetcher,
  count: number = READ_BARS + 1,
): Promise<QuoteCandle[] | null> => {
  const spec = GMO_INTERVALS[interval];
  if (!spec || !isLivePair(pair) || !isLiveInterval(interval)) return null;
  if (spec.key === "day") {
    const got = await fetchRecentQuotes(pair, interval, count, nowMs, deadlineMs, fetcher);
    return got ? got.bars : null;
  }
  return fetchYearQuotes(pair, interval, count, nowMs, fetcher);
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

// Where a read's bars came from: GMO, or — v3, while GMO cannot be read —
// Twelve Data's last bars (see fallbackBars below)
export interface ReadSource {
  source: "gmo" | "twelvedata";
  // why GMO was not used: "maintenance" | "unavailable" — or "gold" (#127):
  // Twelve Data is gold's own feed, GMO has none
  feed: string | null;
  // when the fallback bars were fetched, ISO
  fetchedAt: string | null;
}
const GMO_SOURCE: ReadSource = { source: "gmo", feed: null, fetchedAt: null };

// What the client draws: the candles (the forming one last), RSI and the
// SAR aligned to them, both rules' signals as marks, and each rule's
// reading on the newest closed bar.
export const liveRead = (pair: string, interval: string, quotes: QuoteCandle[], nowMs: number) => {
  const { closed, forming, formingQuote } = splitBars(quotes, interval, nowMs);
  const spread = formingQuote ? formingQuote.ask.close - formingQuote.bid.close : null;
  return readBars(pair, interval, closed, forming, spread, nowMs, GMO_SOURCE);
};

// The same read from mid candles already split into closed and forming
export const readBars = (
  pair: string,
  interval: string,
  closed: Candle[],
  forming: Candle | null,
  spreadNow: number | null,
  nowMs: number,
  from: ReadSource,
) => {
  const d = decimalsOf(pair);
  const step = LIVE_STEP_MS[interval];
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
    spread: round(spreadNow, d),
    next_close: nextCloseMs !== null && Number.isFinite(nextCloseMs) ? new Date(nextCloseMs).toISOString() : null,
    at: new Date(nowMs).toISOString(),
    source: from.source,
    feed: from.feed,
    fetched_at: from.fetchedAt,
  };
};

export type LiveRead = ReturnType<typeof liveRead>;

// #124: the closed bars (mid, rounded as the chart's), oldest first — the
// client keeps those older than the chart's own and computes over both
export const historyRead = (pair: string, interval: string, quotes: QuoteCandle[], nowMs: number) =>
  historyOf(pair, interval, splitBars(quotes, interval, nowMs).closed, nowMs);

// #127: the same from mid candles (gold's), those not closed left out
export const historyOfBars = (pair: string, interval: string, bars: Candle[], nowMs: number) => {
  const step = LIVE_STEP_MS[interval] ?? 0;
  return historyOf(pair, interval, bars.filter((c) => barOpenMs(c.datetime) + step <= nowMs), nowMs);
};

const historyOf = (pair: string, interval: string, closed: Candle[], nowMs: number) => {
  const d = decimalsOf(pair);
  return {
    pair,
    interval,
    decimals: d,
    candles: closed.map((c) => ({ datetime: c.datetime, open: round(c.open, d)!, high: round(c.high, d)!, low: round(c.low, d)!, close: round(c.close, d)! })),
    at: new Date(nowMs).toISOString(),
  };
};

// ---- v3: the fallback while GMO cannot be read ------------------------------------------
//
// The request (2026-09-26), after the chart stood empty through GMO's
// Saturday maintenance: show the chart up to the last close from another
// feed. Twelve Data, the analysis's own feed — whose shared key allows eight
// requests a minute, so these bars are kept in public.live_chart_fallback
// and fetched again at most every FALLBACK_TTL_MS per pair and timeframe
// (while the market is shut they cannot change anyway). No live price: the
// chart says it is showing the last bars, not the market now.

export const FALLBACK_TTL_MS = 30 * MIN;
// Enough closed bars for RSI and the SAR to settle and a chart to draw
export const FALLBACK_BARS = 260;

export const twelveDataUrl = (pair: string, interval: string, apiKey: string, outputsize: number = FALLBACK_BARS): string =>
  `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(interval)}` +
  `&outputsize=${outputsize}&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`;

// Twelve Data's time_series body -> oldest-first candles with the app's
// timestamps: intraday "YYYY-MM-DD HH:mm:ss" (UTC) as sent, daily bars
// ("YYYY-MM-DD") given a time so every reader parses them, and bars that
// lie wholly inside the weekend closure dropped, as the analysis drops them
export const parseTwelveData = (body: unknown, interval: string): Candle[] | null => {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { status?: unknown; values?: unknown };
  if (b.status === "error" || !Array.isArray(b.values)) return null;
  const step = LIVE_STEP_MS[interval] ?? 0;
  return parseCandles(b.values)
    .map((c) => (/^\d{4}-\d{2}-\d{2}$/.test(c.datetime) ? { ...c, datetime: `${c.datetime} 00:00:00` } : c))
    .filter((c) => !barFullyClosed(barOpenMs(c.datetime), step));
};

// Stored bars -> the same read as GMO's, the newest bar forming if it has
// not closed yet
export const fallbackRead = (pair: string, interval: string, bars: Candle[], nowMs: number, from: ReadSource) => {
  const step = LIVE_STEP_MS[interval];
  const closed: Candle[] = [];
  let forming: Candle | null = null;
  for (const c of bars) {
    const t = barOpenMs(c.datetime);
    if (!Number.isFinite(t) || step === undefined) continue;
    if (t + step <= nowMs) closed.push(c);
    else if (t <= nowMs) forming = c;
  }
  return readBars(pair, interval, closed, forming, null, nowMs, from);
};

// GMO answers every public call with {"status": 5, messages: [{message_code:
// "ERR-5201", message_string: "MAINTENANCE. ..."}]} while its feed is down
// for maintenance (seen on a Saturday morning, 2026-09-26): no bars and no
// prices, which is not an error of ours and should not read as one.
export const isMaintenance = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; messages?: unknown };
  if (b.status === 5) return true;
  return Array.isArray(b.messages) &&
    b.messages.some((m) => typeof m === "object" && m !== null && (m as { message_code?: unknown }).message_code === "ERR-5201");
};

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
