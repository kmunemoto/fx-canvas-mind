import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  GMO_ANALYSIS_TIMEFRAMES,
  acceptOverlay,
  fetchRecentQuotes,
  midCandle,
} from "../../supabase/functions/analyze/price-source.ts";
import { MARKET_TOLERANCE_ATR } from "../../supabase/functions/analyze/entry.ts";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes.ts";

const HOUR = 60 * 60 * 1000;
// A Wednesday, mid-session, so no weekend logic interferes unless a test wants it
const NOW = Date.parse("2026-09-02T12:00:00Z");

const bar = (openMs: number, bidClose: number, spread = 0.006, span = 0.05): QuoteCandle => ({
  datetime: new Date(openMs).toISOString(),
  bid: { datetime: "", open: bidClose, high: bidClose + span, low: bidClose - span, close: bidClose },
  ask: {
    datetime: "",
    open: bidClose + spread,
    high: bidClose + span + spread,
    low: bidClose - span + spread,
    close: bidClose + spread,
  },
});

// n bars ending on the bar that is still forming at NOW
const series = (n: number, from = 150): QuoteCandle[] =>
  Array.from({ length: n }, (_, i) => bar(NOW - (n - 1 - i) * HOUR, from + i * 0.01));

describe("which timeframes the overlay covers", () => {
  it("is 1h only, and says so as data rather than as a branch", () => {
    expect([...GMO_ANALYSIS_TIMEFRAMES]).toEqual(["1h"]);
    // 4h and 1day are not a policy choice: TF_CHAIN needs 1week/1month for their
    // higher-timeframe snapshots and GMO serves neither, so they cannot be
    // computed on this feed at all.
    expect(GMO_ANALYSIS_TIMEFRAMES.has("4h")).toBe(false);
    expect(GMO_ANALYSIS_TIMEFRAMES.has("1day")).toBe(false);
  });
});

describe("the mid candle handed to the indicators", () => {
  it("averages both sides per field and speaks Twelve Data's datetime format", () => {
    const m = midCandle(bar(Date.parse("2026-09-02T03:00:00Z"), 150, 0.01, 0.2));
    expect(m.close).toBeCloseTo(150.005, 6);
    expect(m.high).toBeCloseTo(150.205, 6);
    expect(m.low).toBeCloseTo(149.805, 6);
    // Not an ISO string: the prompt, the chart and parseCandleTime all already
    // read "YYYY-MM-DD HH:mm:ss", so nothing downstream learns a second format.
    expect(m.datetime).toBe("2026-09-02 03:00:00");
  });
});

describe("accepting or refusing a candidate series", () => {
  const base = { nowMs: NOW, intervalMs: HOUR, atr: 0.4 };

  it("accepts a fresh, complete series whose newest bar contains the reference price", () => {
    const q = series(250);
    const newest = midCandle(q[q.length - 1]);
    const r = acceptOverlay({ ...base, quotes: q, refPrice: newest.close });
    expect(r).toEqual({ ok: true, reason: null, deltaAtr: 0 });
  });

  it("accepts a price anywhere inside the newest bar, not just at its close", () => {
    // This is the whole point. Measured against nine production rows, the Twelve
    // Data price sat inside the GMO bar every time but up to 1.05 ATR from that
    // bar's close, because the analysis happens mid-bar. A close-distance test
    // would have rejected feeds that agree exactly.
    const q = series(250);
    const newest = midCandle(q[q.length - 1]);
    for (const p of [newest.low, newest.high, (newest.low + newest.high) / 2]) {
      expect(acceptOverlay({ ...base, quotes: q, refPrice: p }).ok).toBe(true);
    }
  });

  it("refuses a series too short to carry SMA200", () => {
    // sma(closes, 200) returns null below 200 and SMA200 just vanishes from the
    // prompt with nothing raised, so a short merge must not be published on.
    expect(acceptOverlay({ ...base, quotes: series(199), refPrice: 150 }).reason).toBe("short");
    expect(acceptOverlay({ ...base, quotes: series(200), refPrice: midCandle(series(200)[199]).close }).ok).toBe(true);
  });

  it("refuses a stale series", () => {
    const old = series(250).map((q) => ({ ...q, datetime: new Date(Date.parse(q.datetime) - 6 * HOUR).toISOString() }));
    expect(acceptOverlay({ ...base, quotes: old, refPrice: 150 }).reason).toBe("stale");
  });

  it("refuses a series with a hole bigger than the judge tolerates", () => {
    const q = series(250);
    q.splice(100, 8); // eight consecutive hours missing, well past MAX_GAP_INTERVALS
    const newest = midCandle(q[q.length - 1]);
    expect(acceptOverlay({ ...base, quotes: q, refPrice: newest.close }).reason).toBe("gap");
  });

  it("refuses two feeds that disagree by more than the app's own market tolerance", () => {
    const q = series(250);
    const newest = midCandle(q[q.length - 1]);
    const justOutside = newest.high + (MARKET_TOLERANCE_ATR + 0.01) * 0.4;
    const r = acceptOverlay({ ...base, quotes: q, refPrice: justOutside });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("disagree");
    // Reported even on rejection: this is the number that says whether the two
    // feeds are quoting the same instrument.
    expect(r.deltaAtr).toBeGreaterThan(MARKET_TOLERANCE_ATR);
  });

  it("grants no tolerance it cannot scale, rather than inventing a pip figure", () => {
    const q = series(250);
    const newest = midCandle(q[q.length - 1]);
    expect(acceptOverlay({ ...base, atr: null, quotes: q, refPrice: newest.close }).ok).toBe(true);
    expect(acceptOverlay({ ...base, atr: null, quotes: q, refPrice: newest.high + 0.001 }).reason).toBe("disagree");
  });
});

describe("walking GMO day files newest first", () => {
  const payload = (openTimes: number[], side: "bid" | "ask") => ({
    status: 0,
    data: openTimes.map((t, i) => ({
      openTime: String(t),
      open: String(150 + i * 0.01 + (side === "ask" ? 0.006 : 0)),
      high: String(150.05 + i * 0.01 + (side === "ask" ? 0.006 : 0)),
      low: String(149.95 + i * 0.01 + (side === "ask" ? 0.006 : 0)),
      close: String(150 + i * 0.01 + (side === "ask" ? 0.006 : 0)),
    })),
  });

  // One JST day file = 24 hourly bars, as measured against the live API
  const dayFile = (key: string, side: "bid" | "ask") => {
    const start = Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T00:00:00Z`) - 9 * HOUR;
    return payload(Array.from({ length: 24 }, (_, i) => start + i * HOUR), side);
  };

  it("never spends a request on a date past today, and stops as soon as it has enough", async () => {
    const asked: string[] = [];
    // The deadline is a real wall-clock budget, not market time: NOW is frozen in
    // the fixture but Date.now() keeps running, so the budget must come from it.
    const res = await fetchRecentQuotes("USD/JPY", "1h", 250, NOW, Date.now() + 60_000, async (url) => {
      const key = new URL(url).searchParams.get("date")!;
      const side = new URL(url).searchParams.get("priceType")!.toLowerCase() as "bid" | "ask";
      asked.push(key);
      return dayFile(key, side);
    });
    expect(res).not.toBeNull();
    expect(res!.bars.length).toBe(250);

    const today = "20260902";
    // dateKeys pads its far end by a whole day, so without the filter the first
    // request of every analysis is guaranteed to 404 on tomorrow's file.
    expect(asked.every((k) => k <= today)).toBe(true);
    // Newest first: the first key asked for is today's.
    expect(asked[0]).toBe(today);
    // 250 bars at 24 per file is 11 files; stopping early is what makes this
    // affordable on the user's latency path.
    expect(res!.keys).toBeLessThanOrEqual(13);
    expect(res!.requests).toBe(res!.keys * 2);
  });

  it("gives up on a blown deadline instead of running past the budget", async () => {
    const res = await fetchRecentQuotes("USD/JPY", "1h", 250, NOW, Date.now() - 1, async () => null);
    expect(res).toBeNull();
  });

  it("returns null for a pair or timeframe GMO does not serve", async () => {
    expect(await fetchRecentQuotes("USD/JPY", "1week", 250, NOW, Date.now() + 60_000, async () => null)).toBeNull();
    expect(await fetchRecentQuotes("XXX/YYY", "1h", 250, NOW, Date.now() + 60_000, async () => null)).toBeNull();
  });
});

// These read the deployed source rather than a fixture, because the defects
// that matter here are not in the logic above — they are in whether the wiring
// reaches it. A previous version of this change was refuted on exactly that:
// the overlay swapped `seriesByTf` AFTER `entryCandles` had already been bound,
// so the chart the client draws kept Twelve Data bars while every indicator,
// the entry marker and entry_point moved to GMO, with nothing raised anywhere.
describe("the overlay is wired into analyze so nothing can read the old series", () => {
  const src = readFileSync("supabase/functions/analyze/index.ts", "utf8");

  it("swaps the series before entryCandles is bound", () => {
    const swap = src.indexOf("seriesByTf = [gmoRaw.bars.map(midCandle)");
    const bind = src.indexOf("const entryCandles = seriesByTf[0];");
    expect(swap).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(-1);
    // Binding after the swap is what makes every later reader — the <60 guard,
    // the snapshots, the printed candles and technicalData.candles — consistent
    // by construction rather than by remembering to rebind.
    expect(swap).toBeLessThan(bind);
    // And there is only one such binding to keep honest.
    expect(src.split("const entryCandles = seriesByTf[0];").length - 1).toBe(1);
  });

  it("runs the overlay concurrently with Twelve Data and can never reject", () => {
    // The Twelve Data fetch stays the fallback, so its rejection is still the
    // only thing that reaches market_data_failed.
    expect(src).toContain("const [td, gmo] = await Promise.all([");
    expect(src).toMatch(/\}\)\.catch\(\(\) => null\)/);
  });

  it("anchors the overlay budget where the fetch starts, not at the request start", () => {
    // Five sequential round trips precede the fetch; measuring from startedAt
    // would silently hand the walk almost nothing on a slow tick and every row
    // would read "unavailable".
    expect(src).toContain("const overlayDeadline = Date.now() + PRICE_OVERLAY_BUDGET_MS;");
    expect(src).not.toContain("startedAt + PRICE_OVERLAY_BUDGET_MS");
  });

  it("records which book priced the plan, and gives the market-data fetch a timeout", () => {
    expect(src).toContain("price_feed: priceFeed,");
    expect(src).toContain("feed_delta_atr: feedDeltaAtr,");
    // entry_check.price shared the rounded constant with nothing; the comment
    // beside it claims all readers use marketEntry.
    expect(src).not.toContain("price: entrySnapshot.price,");
    // A hung provider used to burn the whole wall clock and lose the quota.
    expect(src).toMatch(/await fetch\(url, \{ signal: AbortSignal\.timeout\(/);
  });
});
