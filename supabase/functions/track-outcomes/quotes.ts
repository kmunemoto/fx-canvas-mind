// Bid and ask bars, so a plan is judged the way it would actually have been
// filled.
//
// Every judgement so far has been made on Twelve Data's mid price. Real
// execution is one-sided: a BUY is filled on the ask and closed on the bid, a
// SELL the mirror. Judging both ends on the mid therefore reaches the stop
// later and the target earlier than the market would have — the error runs
// toward wins on both ends.
//
// Measured on GMO Coin's USD/JPY, 82 fifteen-minute bars on 2026-09-03, the
// ask-minus-bid spread was 0.5 pips at the median, 1.14 on average, 3.0 at
// the 95th percentile and 10.0 pips across the JST rollover — 15% of the bars
// were wider than a pip. Small against a 30-pip stop, decisive for a level
// the market only grazed.
//
// GMO Coin's FX endpoint is public: no key, no account, bid and ask served
// separately. It carries USD/JPY and the other majors the app trades, so it
// is used for judging and Twelve Data stays the source for analysis (deeper
// history, every symbol).
//
// Deno-free on purpose: src/test/quotes.test.ts imports this file directly.

import type { Candle } from "../analyze/indicators.ts";

export const GMO_HOST = "https://forex-api.coin.z.com/public/v1";

// The pairs GMO serves, by the app's own symbol
export const GMO_SYMBOLS: Record<string, string> = {
  "USD/JPY": "USD_JPY",
  "EUR/JPY": "EUR_JPY",
  "GBP/JPY": "GBP_JPY",
  "AUD/JPY": "AUD_JPY",
  "NZD/JPY": "NZD_JPY",
  "CAD/JPY": "CAD_JPY",
  "CHF/JPY": "CHF_JPY",
  "EUR/USD": "EUR_USD",
  "GBP/USD": "GBP_USD",
  "AUD/USD": "AUD_USD",
  "NZD/USD": "NZD_USD",
};

// Our evaluation intervals, in GMO's spelling. The ones keyed by a calendar
// day return one JST day per request; 4hour and coarser take a year.
export const GMO_INTERVALS: Record<string, { name: string; key: "day" | "year" }> = {
  "15min": { name: "15min", key: "day" },
  "1h": { name: "1hour", key: "day" },
  "4h": { name: "4hour", key: "year" },
  "1day": { name: "1day", key: "year" },
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const JST_OFFSET_MS = 9 * HOUR;

export const supportsQuotes = (pair: string, evalInterval: string): boolean =>
  GMO_SYMBOLS[pair] !== undefined && GMO_INTERVALS[evalInterval] !== undefined;

// One bar with both sides of the market
export interface QuoteCandle {
  datetime: string;
  bid: Candle;
  ask: Candle;
}

// Which side of the book a plan touches. A BUY is filled on the ask and
// leaves on the bid; a SELL is filled on the bid and leaves on the ask.
export const fillSide = (signal: "BUY" | "SELL"): "bid" | "ask" => (signal === "BUY" ? "ask" : "bid");
export const exitSide = (signal: "BUY" | "SELL"): "bid" | "ask" => (signal === "BUY" ? "bid" : "ask");

export const sideOf = (q: QuoteCandle, side: "bid" | "ask"): Candle => (side === "bid" ? q.bid : q.ask);

// The spread at a bar's close, in price units
export const spreadAt = (q: QuoteCandle): number => q.ask.close - q.bid.close;

// "YYYYMMDD" of the JST calendar day a UTC instant falls in — GMO's own day
// key, which is not the UTC day
export const jstDayKey = (ms: number): string => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, "");

export const jstYearKey = (ms: number): string => String(new Date(ms + JST_OFFSET_MS).getUTCFullYear());

// Every date key a UTC window touches, oldest first. A window of a few hours
// can still span two JST days.
export const dateKeys = (fromMs: number, toMs: number, key: "day" | "year"): string[] => {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const step = key === "day" ? DAY : 365 * DAY;
  const keyOf = key === "day" ? jstDayKey : jstYearKey;
  // Walk the window; the final key is added explicitly so a window shorter
  // than the step still covers its end
  for (let t = fromMs; t <= toMs; t += step) {
    const k = keyOf(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  const last = keyOf(toMs);
  if (!seen.has(last)) out.push(last);
  return out;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

// GMO returns openTime as epoch milliseconds in a string, and the prices as
// strings too. Anything unparseable is dropped rather than turned into NaN
// somewhere downstream.
export const parseKlines = (body: unknown): Array<{ t: number; c: Candle }> => {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: Array<{ t: number; c: Candle }> = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const t = num(r.openTime);
    const open = num(r.open);
    const high = num(r.high);
    const low = num(r.low);
    const close = num(r.close);
    if (![t, open, high, low, close].every(Number.isFinite)) continue;
    out.push({ t, c: { datetime: new Date(t).toISOString(), open, high, low, close } });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
};

// The forex week: closed from Friday evening to Sunday 21:00 UTC — the hour
// the rest of this codebase already treats as the open (see the weekend test
// in src/test/track-outcomes.test.ts, whose bars resume at Sunday 21:00).
//
// The exact Friday close moves with US daylight saving, so only the hours
// that are shut under every rule are excluded: all of Saturday, Sunday
// before the open, and Friday from 22:00 (the latest possible close). An
// hour of genuinely closed market left in costs nothing; discarding an hour
// of real trading would corrupt a judgement.
export const isMarketClosed = (ms: number): boolean => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return true; // Saturday
  if (day === 5 && hour >= 22) return true; // Friday, past the latest close
  if (day === 0 && hour < 21) return true; // Sunday, before the earliest open
  return false;
};

// Pair the two sides by timestamp. A bar present on only one side is dropped:
// judging a level against half a book is worse than not judging it.
export const mergeSides = (
  bid: Array<{ t: number; c: Candle }>,
  ask: Array<{ t: number; c: Candle }>,
): QuoteCandle[] => {
  const asks = new Map(ask.map((x) => [x.t, x.c]));
  const out: QuoteCandle[] = [];
  for (const b of bid) {
    const a = asks.get(b.t);
    if (!a) continue;
    // An ask below the bid is a bad row, not a negative spread
    if (a.close < b.c.close) continue;
    out.push({ datetime: b.c.datetime, bid: b.c, ask: a });
  }
  return out;
};

// Bars that can be judged on: the ones the market was open for.
//
// The bar still forming is deliberately kept. Its high and low can only
// widen, so a level it has already touched really was reached, and dropping
// it would delay every settlement by up to a whole bar for no gain. Only a
// bar stamped inside the weekend break is discarded — a level "touched"
// while nobody could trade was never really reached.
export const usableBars = (bars: QuoteCandle[], _intervalMs: number, nowMs: number): QuoteCandle[] =>
  bars.filter((q) => {
    const t = Date.parse(q.datetime);
    if (!Number.isFinite(t)) return false;
    if (t > nowMs + 60_000) return false;
    return !isMarketClosed(t);
  });

export const klineUrl = (symbol: string, side: "bid" | "ask", interval: string, dateKey: string): string =>
  `${GMO_HOST}/klines?symbol=${encodeURIComponent(symbol)}&priceType=${side.toUpperCase()}&interval=${encodeURIComponent(interval)}&date=${dateKey}`;

export interface QuoteFetchResult {
  bars: QuoteCandle[];
  // Requests that failed or returned nothing, so the caller can tell "the
  // market was quiet" from "we could not look"
  missing: string[];
  requests: number;
}

export type Fetcher = (url: string) => Promise<unknown | null>;

// Bid and ask bars covering [fromMs, toMs], merged and filtered. Each date
// key costs two requests (one per side). A key that fails leaves a gap the
// caller is told about rather than a silently shorter series.
export const fetchQuotes = async (
  pair: string,
  evalInterval: string,
  fromMs: number,
  toMs: number,
  nowMs: number,
  fetcher: Fetcher,
): Promise<QuoteFetchResult | null> => {
  const symbol = GMO_SYMBOLS[pair];
  const interval = GMO_INTERVALS[evalInterval];
  if (!symbol || !interval) return null;

  const keys = dateKeys(fromMs, Math.min(toMs, nowMs), interval.key);
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: Array<{ t: number; c: Candle }> = [];
  const missing: string[] = [];
  let requests = 0;

  for (const key of keys) {
    const [b, a] = await Promise.all([
      fetcher(klineUrl(symbol, "bid", interval.name, key)),
      fetcher(klineUrl(symbol, "ask", interval.name, key)),
    ]);
    requests += 2;
    const bRows = parseKlines(b);
    const aRows = parseKlines(a);
    if (bRows.length === 0 || aRows.length === 0) {
      missing.push(key);
      continue;
    }
    bid.push(...bRows);
    ask.push(...aRows);
  }

  const intervalMs = INTERVAL_MS[evalInterval] ?? HOUR;
  const merged = usableBars(mergeSides(bid, ask), intervalMs, nowMs)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return t >= fromMs - intervalMs && t <= toMs;
    });
  return { bars: merged, missing, requests };
};

// Kept local so this module has no import cycle with evaluate.ts
const INTERVAL_MS: Record<string, number> = {
  "15min": 15 * MIN,
  "1h": HOUR,
  "4h": 4 * HOUR,
  "1day": DAY,
};
