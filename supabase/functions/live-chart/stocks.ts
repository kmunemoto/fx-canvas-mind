// ---- #389: stocks — individual US and Japanese shares ---------------------------------
//
// The request (2026-10-31), after the gold selloff of 10/30 and a question on
// the US midterm election: 「株にも対応してほしい」, then the owner's choices:
// the stocks' chart and email, US and Japanese individual shares (「米国の個別
// 株」「日本の個別株」, 「出来るだけ多くの個別株」), the Japanese ones from
// Yahoo (「Yahoo から取る」) and the moving price from Yahoo too (「Yahoo の値
// 段で動かす」). Twelve Data's free plan has the US shares tried (INTC, NVDA,
// AAPL, MSFT, AMZN, TSLA, GOOGL, META: Basic) but of 13 Japanese ones only
// Toyota (7203; Sony, SoftBank Group, MUFG, Keyence and the rest are Pro);
// Swissquote's public quotes have no shares (AAPL answered []). Read
// 2026-10-31 by .github/workflows/feed-check.yml (docs §8.132).
//
// Yahoo Finance's public chart endpoint (no key; not an official API, so it
// may stop or refuse) answers both markets' bars, their price and time, and
// the session's hours; its search endpoint finds a share by ticker, code or
// English name (Japanese words are refused: HTTP 400). A share is named here
// by Yahoo's own symbol: "AAPL", "BRK-B" for the US, "7203.T" for Tokyo.
// Only the regular session is read (no pre- or after-market). This is the
// chart only: the emails do not judge shares (yet).

import type { Candle } from "../analyze/indicators.ts";

export type StockMarket = "us" | "jp";

// A US share's ticker (a class after a dash: BRK-B), or a Tokyo code (four
// characters, the newer ones with a letter: 130A) on Yahoo's ".T"
const US_SYMBOL = /^[A-Z]{1,5}(-[A-Z]{1,2})?$/;
const JP_SYMBOL = /^[0-9][0-9A-Z]{3}\.T$/;
export const isStockSymbol = (v: unknown): v is string => typeof v === "string" && (US_SYMBOL.test(v) || JP_SYMBOL.test(v));
// the same of a name already known to be a string (the type guard above would
// leave nothing in its other branch)
export const isStock = (pair: string): boolean => isStockSymbol(pair);
export const stockMarketOf = (symbol: string): StockMarket => (symbol.endsWith(".T") ? "jp" : "us");

// Prices to the cent in the US, to a tenth of a yen in Tokyo (TOPIX 100's
// smallest step)
export const stockDecimals = (symbol: string): number => (stockMarketOf(symbol) === "jp" ? 1 : 2);

// The chart's timeframes Yahoo has as they are (the others — 3, 4, 10
// minutes, 2, 4, 8 hours — would be made of shorter bars across the
// sessions' breaks; not offered), and what is read for each: as many bars as
// the chart and its 1,400-bar deep history want where Yahoo keeps them (its
// minutes are kept 7 days, its 2- to 30-minute bars 60, its hours 730)
export const STOCK_INTERVALS = ["1min", "2min", "5min", "15min", "30min", "1h", "1day", "1week", "1month"] as const;
export const isStockInterval = (v: unknown): v is string => typeof v === "string" && (STOCK_INTERVALS as readonly string[]).includes(v);
const YAHOO_READ: Record<string, { interval: string; range: string }> = {
  "1min": { interval: "1m", range: "5d" },
  "2min": { interval: "2m", range: "1mo" },
  "5min": { interval: "5m", range: "1mo" },
  "15min": { interval: "15m", range: "60d" },
  "30min": { interval: "30m", range: "60d" },
  "1h": { interval: "60m", range: "1y" },
  "1day": { interval: "1d", range: "10y" },
  "1week": { interval: "1wk", range: "max" },
  "1month": { interval: "1mo", range: "max" },
};
// a day's bars and longer are stamped with their date alone, as Twelve Data's
// are: the exchange's own date (Yahoo stamps them at the session's open, or
// at the exchange's midnight)
const DATED = new Set(["1day", "1week", "1month"]);

export const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
export const yahooChartUrl = (symbol: string, interval: string): string => {
  const r = YAHOO_READ[interval];
  return `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=${r.interval}&range=${r.range}&includePrePost=false`;
};
// the price now: the day's one bar, and Yahoo's own price and time beside it
export const yahooQuoteUrl = (symbol: string): string => `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
// in Japanese, so a Tokyo share's name comes in Japanese (ソニーグループ)
export const yahooSearchUrl = (q: string): string =>
  `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&lang=ja-JP&region=JP`;
// Yahoo answers a plain client with 429; a browser's name is what it serves
export const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0" };

export interface StockQuote {
  price: number;
  // when Yahoo last priced it, ISO
  time: string | null;
  // the regular session is on now (Tokyo's lunch break, 11:30-12:30, is not)
  open: boolean;
}
export interface StockChart {
  bars: Candle[];
  quote: StockQuote | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const dated = (ms: number, offsetMs: number) => new Date(ms + offsetMs).toISOString().slice(0, 10);

// Tokyo's lunch break in Japan time (minutes of the day): no trading
const JP_LUNCH = [11 * 60 + 30, 12 * 60 + 30];
const inJpLunch = (ms: number): boolean => {
  const m = Math.floor(((ms + 9 * 3_600_000) % 86_400_000) / 60_000);
  return m >= JP_LUNCH[0] && m < JP_LUNCH[1];
};

// The session Yahoo says is the current (or the last) one, as [start, end) ms
const sessionOf = (meta: Record<string, unknown> | null): [number, number] | null => {
  const regular = rec(rec(meta?.currentTradingPeriod)?.regular);
  const start = num(regular?.start);
  const end = num(regular?.end);
  return start !== null && end !== null && end > start ? [start * 1000, end * 1000] : null;
};

export const parseYahooQuote = (symbol: string, meta: Record<string, unknown> | null, nowMs: number): StockQuote | null => {
  const price = num(meta?.regularMarketPrice);
  if (price === null || price <= 0) return null;
  const at = num(meta?.regularMarketTime);
  const session = sessionOf(meta);
  const open = session !== null && nowMs >= session[0] && nowMs < session[1] && !(stockMarketOf(symbol) === "jp" && inJpLunch(nowMs));
  return { price, time: at !== null ? new Date(at * 1000).toISOString() : null, open };
};

// {chart: {result: [{meta, timestamp: [s], indicators: {quote: [{open,
// high, low, close, volume}]}}]}} -> the bars, oldest first, and the price.
// A bar with any of its four prices missing is left out (Yahoo leaves nulls
// where nothing traded). Yahoo ends a finished session's intraday bars with
// one more point at the session's close (16:00 New York, 15:30 Tokyo;
// volume 0), the closing auction's price: it is the last bar's close, not a
// bar of its own, so it is joined to the bar before it.
export const parseYahooChart = (symbol: string, body: unknown, interval: string, nowMs: number): StockChart | null => {
  const result = rec(rec(body)?.chart)?.result;
  const r = Array.isArray(result) ? rec(result[0]) : null;
  const meta = rec(r?.meta);
  const ts = r?.timestamp;
  const q = rec(Array.isArray(rec(r?.indicators)?.quote) ? (rec(r?.indicators)!.quote as unknown[])[0] : null);
  if (!r || !Array.isArray(ts) || !q) return null;
  const [o, h, l, c] = [q.open, q.high, q.low, q.close].map((a) => (Array.isArray(a) ? a : []));
  const intraday = !DATED.has(interval);
  const session = sessionOf(meta);
  const offsetMs = (num(meta?.gmtoffset) ?? 0) * 1000;
  const bars: Candle[] = [];
  let lastMs = Number.NaN;
  for (let i = 0; i < ts.length; i++) {
    const t = num(ts[i]);
    const [open, high, low, close] = [num(o[i]), num(h[i]), num(l[i]), num(c[i])];
    if (t === null || open === null || high === null || low === null || close === null || close <= 0 || low <= 0 || high < low) continue;
    const ms = t * 1000;
    if (intraday && session !== null && ms >= session[1] && bars.length > 0 && ms - lastMs < 86_400_000) {
      const prev = bars[bars.length - 1];
      bars[bars.length - 1] = { ...prev, high: Math.max(prev.high, high), low: Math.min(prev.low, low), close };
      continue;
    }
    bars.push({ datetime: intraday ? stamp(ms) : dated(ms, offsetMs), open, high, low, close });
    lastMs = ms;
  }
  return { bars, quote: parseYahooQuote(symbol, meta, nowMs) };
};

export interface StockHit {
  symbol: string;
  name: string;
  market: StockMarket;
}
// The exchanges a share is taken from: the US ones (Nasdaq's three markets,
// the NYSE, NYSE American, NYSE Arca, Cboe BZX) and Tokyo — not the
// over-the-counter ones (PNK) or other countries'
const US_EXCHANGES = new Set(["NMS", "NGM", "NCM", "NYQ", "ASE", "PCX", "BTS"]);
export const parseYahooSearch = (body: unknown): StockHit[] => {
  const quotes = rec(body)?.quotes;
  if (!Array.isArray(quotes)) return [];
  const out: StockHit[] = [];
  for (const v of quotes) {
    const x = rec(v);
    const symbol = typeof x?.symbol === "string" ? x.symbol : "";
    const exchange = typeof x?.exchange === "string" ? x.exchange : "";
    if (x?.quoteType !== "EQUITY" || !isStockSymbol(symbol)) continue;
    const market = stockMarketOf(symbol);
    if (market === "jp" ? exchange !== "JPX" : !US_EXCHANGES.has(exchange)) continue;
    const name = [x.longname, x.shortname].find((n): n is string => typeof n === "string" && n.trim() !== "") ?? symbol;
    if (!out.some((h) => h.symbol === symbol)) out.push({ symbol, name: name.trim(), market });
  }
  return out;
};
// what may be searched for: a few words of letters, digits and the like
export const isStockQuery = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length >= 1 && v.length <= 40 && /^[\p{L}\p{N} .&'-]+$/u.test(v);
