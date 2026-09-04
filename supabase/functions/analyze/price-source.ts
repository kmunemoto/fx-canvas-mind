// Which price feed the analysis prices a plan from, and whether a candidate
// overlay is good enough to publish on.
//
// Why this exists. The plan is priced by the analysis and later judged by the
// tracker. Those two used different feeds: the analysis priced from Twelve Data
// mid candles while the tracker fills from GMO Coin bid/ask. Every 1h plan
// settled since the trading-day fix carries price_basis "quotes", so the seam is
// live, not theoretical — entry_point came from one book and the fill from
// another.
//
// Deno-free on purpose: src/test/price-source.test.ts imports this directly.

import {
  GMO_INTERVALS,
  GMO_SYMBOLS,
  MAX_GAP_INTERVALS,
  dateKeys,
  jstDayKey,
  klineUrl,
  largestGap,
  mergeSides,
  parseKlines,
  supportsQuotes,
  usableBars,
  type Fetcher,
  type QuoteCandle,
} from "../track-outcomes/quotes.ts";
import { isPossiblyClosed } from "../_shared/market-hours.ts";
import type { Candle } from "./indicators.ts";
import { MARKET_TOLERANCE_ATR } from "./entry.ts";

// Only 1h. Not because the others are unsafe — because of what each costs and
// what GMO actually serves:
//   4h / 1day  — impossible. TF_CHAIN needs 1week for a 4h plan and 1week plus
//                1month for a 1day plan, and GMO_INTERVALS has neither, so the
//                higher-timeframe snapshots could not be computed at all.
//   15min      — possible and in fact cheaper (96 bars per day file, so 250 bars
//                is ~3 files), just not what the app is mostly used for. Adding
//                it here is a one-line change once 1h has been observed.
// 1h is where the plans are, and 24 bars per day file means ~11 productive day
// files for 250 bars.
export const GMO_ANALYSIS_TIMEFRAMES = new Set(["1h"]);

// The SMA200 floor. sma(closes, 200) returns null below this and SMA200 simply
// vanishes from the prompt with nothing raised, so an overlay that merged short
// would quietly hand the analyst a thinner picture than Twelve Data would have.
const MIN_OVERLAY_BARS = 200;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Twelve Data's shape, deliberately. The prompt's candle block, the chart, the
// stored context.entry.datetime and parseCandleTime all already handle
// "YYYY-MM-DD HH:mm:ss"; normalising here means nothing downstream has to learn
// a second format.
export const midCandle = (q: QuoteCandle): Candle => ({
  datetime: q.datetime.slice(0, 19).replace("T", " "),
  open: (q.bid.open + q.ask.open) / 2,
  high: (q.bid.high + q.ask.high) / 2,
  low: (q.bid.low + q.ask.low) / 2,
  close: (q.bid.close + q.ask.close) / 2,
});

export interface OverlayCheck {
  ok: boolean;
  reason: string | null;
  // How far outside the newest GMO bar the reference price sat, in ATR. Zero
  // when the two feeds agree, which is what every measured production row did.
  deltaAtr: number | null;
}

// Is the candidate series good enough to price a plan from?
//
// The agreement test is deliberately "is the reference price INSIDE the newest
// bar", not "how far is it from that bar's close". Measured against nine real
// 1h rows: every Twelve Data price sat inside the matching GMO bar's range, but
// was up to 1.05 ATR from that bar's CLOSE — because the analysis happens
// mid-bar. A close-distance test would have rejected feeds that agree perfectly.
export const acceptOverlay = (a: {
  quotes: QuoteCandle[];
  refPrice: number;
  atr: number | null;
  nowMs: number;
  intervalMs: number;
}): OverlayCheck => {
  const bars = a.quotes;
  if (bars.length < MIN_OVERLAY_BARS) return { ok: false, reason: "short", deltaAtr: null };

  const newest = bars[bars.length - 1];
  const mid = midCandle(newest);
  const openedAt = Date.parse(newest.datetime);
  if (!Number.isFinite(openedAt)) return { ok: false, reason: "unparsable", deltaAtr: null };

  // One interval of slack past the bar still forming: a fresh feed's newest bar
  // opened at most one interval ago.
  if (a.nowMs - openedAt > 2 * a.intervalMs) return { ok: false, reason: "stale", deltaAtr: null };

  const oldest = Date.parse(bars[0].datetime);
  if (Number.isFinite(oldest) && largestGap(bars, oldest, a.nowMs, a.intervalMs) > MAX_GAP_INTERVALS * a.intervalMs) {
    return { ok: false, reason: "gap", deltaAtr: null };
  }

  // Distance outside the bar, in ATR. Inside the bar is exact agreement.
  const outside = Math.max(0, a.refPrice - mid.high, mid.low - a.refPrice);
  if (a.atr === null || !Number.isFinite(a.atr) || a.atr <= 0) {
    // No ATR to scale by, so no tolerance can be granted: demand strict
    // agreement rather than inventing a pip figure.
    return outside === 0
      ? { ok: true, reason: null, deltaAtr: null }
      : { ok: false, reason: "disagree", deltaAtr: null };
  }
  const deltaAtr = Number((outside / a.atr).toFixed(4));
  // The app's own definition of "the same price in practice". Two feeds further
  // apart than that are not quoting the same instrument, and the right answer is
  // to publish on the feed we already have rather than on a suspect one.
  if (deltaAtr > MARKET_TOLERANCE_ATR) return { ok: false, reason: "disagree", deltaAtr };
  return { ok: true, reason: null, deltaAtr };
};

export interface RecentQuotes {
  bars: QuoteCandle[];
  requests: number;
  keys: number;
}

// "Give me the newest N bars", which is a different walk from fetchQuotes'
// "cover this window": day keys are consumed NEWEST FIRST and the walk stops as
// soon as it has enough, so a 250-bar 1h request costs ~11 productive files
// instead of every file in the span.
//
// Never throws and never rejects: the caller runs this concurrently with the
// Twelve Data fetch that remains the fallback, so a GMO outage must cost a
// label, never an analysis.
//
// nowMs and deadlineMs are deliberately two different clocks: nowMs is the
// market-time reference the bars are judged against, deadlineMs is a wall-clock
// latency budget measured with Date.now(). A test may hold the first fixed while
// the second keeps running.
export const fetchRecentQuotes = async (
  pair: string,
  evalInterval: string,
  minBars: number,
  nowMs: number,
  deadlineMs: number,
  fetcher: Fetcher,
): Promise<RecentQuotes | null> => {
  if (!supportsQuotes(pair, evalInterval)) return null;
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[evalInterval];
  if (!symbol || !spec || spec.key !== "day") return null;

  // Enough calendar days to hold minBars of OPEN market, padded for weekends
  // (five open days in seven) and then walked newest-first. Over-asking costs
  // nothing here because the walk stops early; under-asking loses bars.
  const perDay = Math.max(1, Math.floor(DAY_MS / intervalMsOf(evalInterval)));
  const openDays = Math.ceil(minBars / perDay);
  const spanDays = Math.ceil(openDays * 7 / 5) + 2;
  const today = jstDayKey(nowMs);
  const keys = dateKeys(nowMs - spanDays * DAY_MS, nowMs, spec.key)
    // dateKeys pads the far end by a whole day, so its newest key is always
    // tomorrow's — a guaranteed 404. Anything past today is spent for nothing.
    .filter((k) => k <= today)
    .reverse();

  let bid: Array<{ t: number; c: Candle }> = [];
  let ask: Array<{ t: number; c: Candle }> = [];
  let requests = 0;
  let used = 0;
  for (const key of keys) {
    if (Date.now() > deadlineMs) return null;
    // A whole JST day inside the weekend break holds no judgeable bar.
    const dayStart = Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00Z`) - 9 * HOUR_MS;
    if (Number.isFinite(dayStart) && isPossiblyClosed(dayStart) && isPossiblyClosed(dayStart + DAY_MS - 1)) continue;
    used++;
    const [b, a] = await Promise.all([
      fetcher(klineUrl(symbol, "bid", spec.name, key)),
      fetcher(klineUrl(symbol, "ask", spec.name, key)),
    ]);
    requests += 2;
    bid = [...parseKlines(b), ...bid];
    ask = [...parseKlines(a), ...ask];
    const merged = usableBars(mergeSides(bid, ask), intervalMsOf(evalInterval), nowMs);
    if (merged.length >= minBars) return { bars: merged.slice(-minBars), requests, keys: used };
  }
  const merged = usableBars(mergeSides(bid, ask), intervalMsOf(evalInterval), nowMs);
  return merged.length > 0 ? { bars: merged, requests, keys: used } : null;
};

// Local rather than imported: quotes.ts keeps its own copy unexported to avoid
// an import cycle with evaluate.ts, and this file only needs the day-keyed ones.
const intervalMsOf = (evalInterval: string): number =>
  evalInterval === "15min" ? 15 * 60 * 1000 : HOUR_MS;
