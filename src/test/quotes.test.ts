import { describe, it, expect } from "vitest";
import {
  dateKeys,
  exitSide,
  fetchQuotes,
  fetchQuoteWindow,
  fillSide,
  GMO_INTERVALS,
  isMarketClosed,
  isPossiblyClosed,
  largestGap,
  MAX_GAP_INTERVALS,
  jstDayKey,
  klineUrl,
  mergeSides,
  parseKlines,
  spreadAt,
  supportsQuotes,
  usableBars,
  type QuoteCandle,
} from "../../supabase/functions/track-outcomes/quotes.ts";
import { judgePlan, type OpenRow } from "../../supabase/functions/track-outcomes/evaluate.ts";
import type { Candle } from "../../supabase/functions/analyze/indicators.ts";

// The shape GMO actually returns, taken from a live response on 2026-09-03:
// epoch milliseconds as a string, prices as strings
const kline = (t: number, o: number, h: number, l: number, c: number) => ({
  openTime: String(t),
  open: String(o),
  high: String(h),
  low: String(l),
  close: String(c),
});
const body = (rows: unknown[]) => ({ status: 0, data: rows });

const T = Date.parse("2026-09-03T09:00:00Z");
const HOUR = 3_600_000;

describe("which side of the book a plan touches", () => {
  it("fills a BUY on the ask and closes it on the bid, and the mirror for a SELL", () => {
    expect(fillSide("BUY")).toBe("ask");
    expect(exitSide("BUY")).toBe("bid");
    expect(fillSide("SELL")).toBe("bid");
    expect(exitSide("SELL")).toBe("ask");
  });

  it("knows which pairs and intervals have quotes", () => {
    expect(supportsQuotes("USD/JPY", "15min")).toBe(true);
    expect(supportsQuotes("USD/JPY", "1h")).toBe(true);
    expect(supportsQuotes("EUR/JPY", "4h")).toBe(true);
    expect(supportsQuotes("USD/CHF", "1h")).toBe(false);
    expect(supportsQuotes("USD/JPY", "1week")).toBe(false);
  });

  it("carries the refinement rungs, keyed by day like the other sub-day intervals", () => {
    // 5min and 1min are never a coarse evaluation interval (EVAL_INTERVAL
    // maps every plan to 15min or 1h); they are here so an ambiguous bar can
    // be split on the same bid/ask feed it was judged on. Verified live on
    // 2026-09-05: interval=5min&date=20260904 answered the 15min shape.
    expect(GMO_INTERVALS["5min"]).toEqual({ name: "5min", key: "day" });
    expect(GMO_INTERVALS["1min"]).toEqual({ name: "1min", key: "day" });
    expect(supportsQuotes("USD/JPY", "5min")).toBe(true);
  });
});

describe("GMO's date keys", () => {
  it("keys a bar by its JST day, not its UTC day", () => {
    // 2026-09-02 15:00 UTC is midnight on 2026-09-03 in Tokyo
    expect(jstDayKey(Date.parse("2026-09-02T15:00:00Z"))).toBe("20260903");
    expect(jstDayKey(Date.parse("2026-09-02T14:59:00Z"))).toBe("20260902");
  });

  it("covers both JST days a UTC window straddles, plus a day either side", () => {
    const keys = dateKeys(Date.parse("2026-09-02T13:00:00Z"), Date.parse("2026-09-02T16:00:00Z"), "day");
    // The two days the window itself touches must be there...
    expect(keys).toContain("20260902");
    expect(keys).toContain("20260903");
    // ...and the neighbours, because GMO files a bar under its trading day
    // (which starts at the New York roll), not under the JST calendar day.
    // Measured: at 03:49 JST the calendar day 404s and the previous key holds
    // the bars. Padding costs one request per side and removes the guess.
    expect(keys).toEqual(["20260901", "20260902", "20260903", "20260904"]);
  });

  it("asks for a whole year at a time on the coarse intervals", () => {
    // Away from New Year the day-wide padding adds nothing: one key, two
    // requests. Padding a whole year each way would burn four for nothing.
    expect(dateKeys(Date.parse("2026-03-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"), "year")).toEqual(["2026"]);
    // 2025-12-31 10:00 UTC is still 2025 in Tokyo; 20:00 UTC is already 2026
    expect(dateKeys(Date.parse("2025-12-31T10:00:00Z"), Date.parse("2026-01-02T00:00:00Z"), "year")).toEqual(["2025", "2026"]);
    // Within a day of the boundary the neighbour is fetched too: a bar at
    // 2026-01-01 03:00 JST belongs to the trading day that opened in 2025
    expect(dateKeys(Date.parse("2025-12-31T20:00:00Z"), Date.parse("2026-01-02T00:00:00Z"), "year")).toEqual(["2025", "2026"]);
  });

  it("builds the documented URL", () => {
    expect(klineUrl("USD_JPY", "bid", "15min", "20260903"))
      .toBe("https://forex-api.coin.z.com/public/v1/klines?symbol=USD_JPY&priceType=BID&interval=15min&date=20260903");
  });
});

describe("parsing", () => {
  it("reads the string-typed numbers and orders the bars", () => {
    const rows = parseKlines(body([
      kline(T + HOUR, 158.7, 158.8, 158.6, 158.75),
      kline(T, 158.6, 158.7, 158.5, 158.65),
    ]));
    expect(rows.map((r) => r.t)).toEqual([T, T + HOUR]);
    expect(rows[0].c).toMatchObject({ open: 158.6, high: 158.7, low: 158.5, close: 158.65 });
    expect(rows[0].c.datetime).toBe(new Date(T).toISOString());
  });

  it("drops rows it cannot read and survives an error body", () => {
    expect(parseKlines(body([kline(T, 1, 2, 3, 4), { openTime: "x" }, null, { open: "1" }]))).toHaveLength(1);
    expect(parseKlines({ status_code: 404, message: "Not found" })).toEqual([]);
    expect(parseKlines(null)).toEqual([]);
    expect(parseKlines({ status: 0, data: "nope" })).toEqual([]);
  });
});

describe("pairing the two sides", () => {
  it("keeps only the bars both sides quoted, and measures the spread", () => {
    const bid = parseKlines(body([kline(T, 158.6, 158.7, 158.5, 158.65), kline(T + HOUR, 158.65, 158.8, 158.6, 158.7)]));
    const ask = parseKlines(body([kline(T, 158.61, 158.71, 158.51, 158.66)]));
    const merged = mergeSides(bid, ask);
    expect(merged).toHaveLength(1);
    expect(spreadAt(merged[0])).toBeCloseTo(0.01, 6);
  });

  it("refuses a row where the ask sits below the bid", () => {
    const bid = parseKlines(body([kline(T, 158.6, 158.7, 158.5, 158.65)]));
    const ask = parseKlines(body([kline(T, 158.5, 158.6, 158.4, 158.55)]));
    expect(mergeSides(bid, ask)).toEqual([]);
  });
});

describe("which bars may be judged on", () => {
  const at = (iso: string): QuoteCandle => ({
    datetime: iso,
    bid: { datetime: iso, open: 1, high: 1, low: 1, close: 1 },
    ask: { datetime: iso, open: 1, high: 1, low: 1, close: 1.001 },
  });

  it("knows when the market is shut", () => {
    // The Friday close moves with daylight saving, so 21:00 stays in
    expect(isMarketClosed(Date.parse("2026-09-04T20:59:00Z"))).toBe(false); // Friday, still open
    expect(isMarketClosed(Date.parse("2026-09-04T21:00:00Z"))).toBe(false); // Friday, may still be open
    expect(isMarketClosed(Date.parse("2026-09-04T22:00:00Z"))).toBe(true); // Friday, shut under any rule
    expect(isMarketClosed(Date.parse("2026-09-05T12:00:00Z"))).toBe(true); // Saturday
    expect(isMarketClosed(Date.parse("2026-09-06T20:59:00Z"))).toBe(true); // Sunday before the open
    expect(isMarketClosed(Date.parse("2026-09-06T21:00:00Z"))).toBe(false); // Sunday open
    expect(isMarketClosed(Date.parse("2026-09-03T09:00:00Z"))).toBe(false); // midweek
  });

  it("keeps the bar still forming — its high and low can only widen — and drops the closed session", () => {
    const now = Date.parse("2026-09-03T10:10:00Z");
    const bars = [
      at("2026-09-03T08:00:00Z"),
      at("2026-09-03T09:00:00Z"),
      at("2026-09-03T10:00:00Z"), // still forming at 10:10: a touch in it is real
      at("2026-09-05T02:00:00Z"), // Saturday: shut under any rule
      at("2026-09-03T11:00:00Z"), // has not started yet
    ];
    expect(usableBars(bars, HOUR, now).map((b) => b.datetime)).toEqual([
      "2026-09-03T08:00:00Z",
      "2026-09-03T09:00:00Z",
      "2026-09-03T10:00:00Z",
    ]);
  });
});

describe("fetching a window", () => {
  const rows = (base: number, offset: number) => body([
    kline(base, 158.6 + offset, 158.7 + offset, 158.5 + offset, 158.65 + offset),
    kline(base + HOUR, 158.65 + offset, 158.8 + offset, 158.6 + offset, 158.7 + offset),
  ]);

  it("asks both sides for every date key and returns only complete, settled bars", async () => {
    const seen: string[] = [];
    const now = Date.parse("2026-09-03T12:00:00Z");
    const res = await fetchQuotes("USD/JPY", "1h", T, T + 2 * HOUR, now, async (url) => {
      seen.push(url);
      const side = url.includes("priceType=ASK") ? 0.01 : 0;
      return rows(T, side);
    });
    expect(res).not.toBeNull();
    // The window's own day plus one either side, both sides of the book
    expect(seen).toHaveLength(6);
    expect(seen.some((u) => u.includes("interval=1hour&date=20260903"))).toBe(true);
    expect(res?.requests).toBe(6);
    expect(res?.missing).toEqual([]);
    // This fixture answers every key with the same two bars; one timestamp is
    // still one bar, so padding cannot inflate the series
    expect(res?.bars).toHaveLength(2);
    expect(spreadAt(res!.bars[0])).toBeCloseTo(0.01, 6);
  });

  it("treats an empty date key as ordinary, because the newest one has no file yet", async () => {
    // This is the production failure that hid for a whole release: between
    // JST midnight and the New York roll, the calendar day 404s. Judged by
    // buckets, every window that touched "today" was declared incomplete and
    // silently fell back to the mid feed.
    const now = Date.parse("2026-09-03T12:00:00Z");
    const res = await fetchQuotes("USD/JPY", "1h", T, T + 2 * HOUR, now, async (url) =>
      url.includes("date=20260904") ? null : rows(T, url.includes("ASK") ? 0.01 : 0));
    expect(res?.empty).toContain("20260904");
    expect(res?.missing).toEqual([]);
    expect(res?.bars).toHaveLength(2);
  });

  it("still refuses when the bars leave a real hole in an open market", async () => {
    // Nothing at all comes back for a two-day window the market was open for
    const from = Date.parse("2026-09-01T00:00:00Z"); // a Tuesday
    const now = Date.parse("2026-09-03T00:00:00Z");
    const res = await fetchQuotes("USD/JPY", "1h", from, now, now, async () => null);
    expect(res?.bars).toHaveLength(0);
    expect(res?.missing).toHaveLength(1);
    expect(res?.missing[0]).toMatch(/^gap \d+x1h$/);
  });

  it("declines a pair it does not carry", async () => {
    expect(await fetchQuotes("USD/CHF", "1h", T, T + HOUR, T + 2 * HOUR, async () => null)).toBeNull();
  });
});

// --- one coarse bar's worth of sub-bars, from the same feed -----------------
// The sub-bars that split an ambiguous bar must come from the feed the bar
// itself came from, and the provider serves whole trading days keyed by a
// calendar date whose roll is not JST midnight. What is checked here is the
// cost of getting them and the refusal to judge on a window with a hole.

describe("fetching one coarse bar's sub-bars", () => {
  const MIN = 60_000;
  const JST = 9 * HOUR;
  // A UTC instant from a JST wall-clock time
  const jst = (iso: string) => Date.parse(`${iso}Z`) - JST;
  const dayOf = (key: string) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;

  // A provider whose trading day runs 06:00 JST to 06:00 JST the next day —
  // the rule every measurement so far is consistent with — serving 5min
  // bars. `absent` leaves a sub-bar out of every file, `missingKeys` answer
  // 404 (a day that has no file yet).
  const provider = (opts: { absent?: number[]; missingKeys?: string[] } = {}) => {
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      const key = url.match(/date=(\d{8})/)?.[1] ?? "";
      if (opts.missingKeys?.includes(key)) return null;
      const side = url.includes("priceType=ASK") ? 0.01 : 0;
      const open = jst(`${dayOf(key)}T06:00:00`);
      const rows: unknown[] = [];
      for (let t = open; t < open + 24 * HOUR; t += 5 * MIN) {
        if (opts.absent?.includes(t)) continue;
        rows.push(kline(t, 158.6 + side, 158.7 + side, 158.5 + side, 158.65 + side));
      }
      return body(rows);
    };
    return { seen, fetcher, keysAsked: () => seen.map((u) => u.match(/date=(\d{8})/)?.[1]) };
  };

  it("costs two requests when the calendar key covers the window, and asks no other key", async () => {
    // A 15min bar at 10:00 JST on a Wednesday, well inside the trading day
    const from = jst("2026-09-02T10:00:00");
    const p = provider();
    const res = await fetchQuoteWindow("USD/JPY", "5min", from, from + 15 * MIN, from + 2 * HOUR, p.fetcher);
    expect(res?.requests).toBe(2);
    expect(p.keysAsked()).toEqual(["20260902", "20260902"]);
    expect(res?.missing).toEqual([]);
    expect(res?.empty).toEqual([]);
    expect(res?.bars.map((b) => b.datetime)).toEqual([
      new Date(from).toISOString(),
      new Date(from + 5 * MIN).toISOString(),
      new Date(from + 10 * MIN).toISOString(),
    ]);
    expect(spreadAt(res!.bars[0])).toBeCloseTo(0.01, 6);
  });

  it("costs four before the roll: the calendar key has no file yet, the previous key holds the bars", async () => {
    // 03:00 JST, judged at 03:49 JST — the measured production case, where
    // date=20260902 answers 404 and date=20260901 runs to the small hours
    const from = jst("2026-09-02T03:00:00");
    const p = provider({ missingKeys: ["20260902"] });
    const res = await fetchQuoteWindow("USD/JPY", "5min", from, from + 15 * MIN, jst("2026-09-02T03:49:00"), p.fetcher);
    expect(res?.requests).toBe(4);
    expect(p.keysAsked()).toEqual(["20260902", "20260902", "20260901", "20260901"]);
    expect(res?.empty).toEqual(["20260902"]);
    expect(res?.missing).toEqual([]);
    expect(res?.bars).toHaveLength(3);
  });

  it("stitches a bar that straddles the roll from both files, nearest key first", async () => {
    // 05:50 to 06:05 JST: the first two sub-bars are filed under the day
    // that is ending, the last under the day that is starting
    const from = jst("2026-09-02T05:50:00");
    const p = provider();
    const res = await fetchQuoteWindow("USD/JPY", "5min", from, from + 15 * MIN, from + 2 * HOUR, p.fetcher);
    expect(res?.requests).toBe(4);
    // The calendar day of the window's start is asked first, then — its file
    // starting at 06:00 leaves a hole at 05:50 — the previous day; never the
    // next one, which nothing needed
    expect(p.keysAsked()).toEqual(["20260902", "20260902", "20260901", "20260901"]);
    expect(res?.missing).toEqual([]);
    expect(res?.bars.map((b) => b.datetime)).toEqual([
      new Date(from).toISOString(),
      new Date(from + 5 * MIN).toISOString(),
      new Date(from + 10 * MIN).toISOString(),
    ]);
  });

  it("refuses partial coverage, because a missing sub-bar can hide the level reached first", async () => {
    const from = jst("2026-09-02T10:00:00");
    const p = provider({ absent: [from + 5 * MIN] });
    const res = await fetchQuoteWindow("USD/JPY", "5min", from, from + 15 * MIN, from + 2 * HOUR, p.fetcher);
    // Every candidate key was tried before giving up
    expect(res?.requests).toBe(6);
    expect(res?.bars).toHaveLength(2);
    expect(res?.missing).toEqual(["gap 1x5min"]);
  });

  it("does not allege a gap over the part of a forming bar that has not happened yet", async () => {
    // Judged at 10:07 JST: only the 10:00 and 10:05 sub-bars can exist
    const from = jst("2026-09-02T10:00:00");
    const p = provider();
    const res = await fetchQuoteWindow("USD/JPY", "5min", from, from + 15 * MIN, from + 7 * MIN, p.fetcher);
    expect(res?.missing).toEqual([]);
    expect(res?.requests).toBe(2);
  });

  it("asks the nearest key even inside the hour the widest closure cannot vouch for", async () => {
    // Sunday 21:00Z is Monday 06:00 JST under US summer time: the first hour
    // of GMO's week, and inside the band isPossiblyClosed marks as maybe
    // shut. A walk that trusted "covered" before its first request returned
    // nothing here, while the coarse series does hold these bars.
    const from = Date.parse("2026-09-06T21:00:00Z");
    const p = provider();
    const res = await fetchQuoteWindow("USD/JPY", "5min", from, from + 15 * MIN, from + 2 * HOUR, p.fetcher);
    expect(res?.requests).toBe(2);
    expect(p.keysAsked()).toEqual(["20260907", "20260907"]);
    expect(res?.missing).toEqual([]);
    expect(res?.bars).toHaveLength(3);
  });

  it("declines what it cannot fetch", async () => {
    const from = jst("2026-09-02T10:00:00");
    expect(await fetchQuoteWindow("USD/CHF", "5min", from, from + 15 * MIN, from + HOUR, async () => null)).toBeNull();
    expect(await fetchQuoteWindow("USD/JPY", "3min", from, from + 15 * MIN, from + HOUR, async () => null)).toBeNull();
    expect(await fetchQuoteWindow("USD/JPY", "5min", from, from, from + HOUR, async () => null)).toBeNull();
  });
});

// --- judging on two sides of the book -------------------------------------
// The point of the whole exercise: a BUY is filled on the ask and closed on
// the bid, so a stop the mid never reached can already have been hit, and a
// target the mid reached may not have been.

const MONDAY = "2026-08-24T00:00:00Z"; // a Monday, well inside the trading week
const t0 = Date.parse(MONDAY);
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (ms: number) => iso(ms).slice(0, 19).replace("T", " ");

// mid ± half a pip: a 1 pip spread, close to the measured median
const HALF = 0.005;
const quoted = (ms: number, high: number, low: number, close: number): QuoteCandle => ({
  datetime: iso(ms),
  bid: { datetime: iso(ms), open: close - HALF, high: high - HALF, low: low - HALF, close: close - HALF },
  ask: { datetime: iso(ms), open: close + HALF, high: high + HALF, low: low + HALF, close: close + HALF },
});
const mid = (ms: number, high: number, low: number, close: number): Candle => ({
  datetime: stamp(ms), open: close, high, low, close,
});

const buy: OpenRow = {
  id: "q1", pair: "USD/JPY", interval: "1h", signal: "BUY",
  entry_point: 150.0, stop_loss: 149.9, take_profit_1: 150.3,
  take_profit_2: null, take_profit_3: null,
  created_at: iso(t0 + 5 * 60_000), price_at_signal: 150.0, evaluation: null,
};

describe("judging a plan on bid and ask instead of the mid", () => {
  it("sees a stop the mid never reached, because a BUY is closed on the bid", async () => {
    // The low prints 149.905 on the mid — a hair above the stop — but the bid
    // that a BUY actually sells into is half a pip lower, and reaches it
    const shape: Array<[number, number, number, number]> = [
      [t0, 150.02, 149.98, 150.0],
      [t0 + HOUR, 150.05, 149.905, 149.95],
      [t0 + 2 * HOUR, 150.0, 149.95, 149.98],
    ];
    const onMid = await judgePlan(buy, shape.map((s) => mid(...s)), "1h", t0 + 5 * HOUR);
    expect(onMid.resolution).toBeNull();

    const onQuotes = await judgePlan(buy, [], "1h", t0 + 5 * HOUR, undefined, shape.map((s) => quoted(...s)));
    expect(onQuotes.resolution).toBe("loss");
    expect(onQuotes.evaluation.price_basis).toBe("quotes");
    // and the fill was the ask, not the number written on the plan
    expect(onQuotes.evaluation.fill_price).toBeCloseTo(150.005, 6);
    expect(onQuotes.evaluation.spread_at_fill).toBeCloseTo(0.01, 6);
  });

  it("withholds a target the mid reached but the bid did not", async () => {
    const shape: Array<[number, number, number, number]> = [
      [t0, 150.02, 149.98, 150.0],
      [t0 + HOUR, 150.302, 150.0, 150.25],
      [t0 + 2 * HOUR, 150.28, 150.2, 150.24],
    ];
    const onMid = await judgePlan(buy, shape.map((s) => mid(...s)), "1h", t0 + 5 * HOUR);
    expect(onMid.resolution).toBe("win");

    const onQuotes = await judgePlan(buy, [], "1h", t0 + 5 * HOUR, undefined, shape.map((s) => quoted(...s)));
    expect(onQuotes.resolution).toBeNull();
  });

  it("mirrors both sides for a SELL: filled on the bid, closed on the ask", async () => {
    const sell: OpenRow = {
      ...buy, id: "q2", signal: "SELL",
      entry_point: 150.0, stop_loss: 150.1, take_profit_1: 149.7,
    };
    // The mid high stops at 150.095, just under the stop; the ask a BUY-back
    // pays is half a pip higher and reaches it
    const shape: Array<[number, number, number, number]> = [
      [t0, 150.02, 149.98, 150.0],
      [t0 + HOUR, 150.095, 149.95, 150.05],
      [t0 + 2 * HOUR, 150.05, 149.9, 149.95],
    ];
    const onMid = await judgePlan(sell, shape.map((s) => mid(...s)), "1h", t0 + 5 * HOUR);
    expect(onMid.resolution).toBeNull();

    const onQuotes = await judgePlan(sell, [], "1h", t0 + 5 * HOUR, undefined, shape.map((s) => quoted(...s)));
    expect(onQuotes.resolution).toBe("loss");
    // a SELL is filled on the bid: below the plan's number, so it earns less
    expect(onQuotes.evaluation.fill_price).toBeCloseTo(149.995, 6);
  });

  it("falls back to the mid when no quotes are supplied", async () => {
    const shape: Array<[number, number, number, number]> = [
      [t0, 150.02, 149.98, 150.0],
      [t0 + HOUR, 150.35, 150.0, 150.3],
    ];
    const j = await judgePlan(buy, shape.map((s) => mid(...s)), "1h", t0 + 5 * HOUR);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.price_basis).toBe("mid");
    expect(j.evaluation.spread_at_fill).toBeNull();
    expect(j.evaluation.fill_price).toBe(150.0);
  });
});

describe("a weekend is not a hole in the data", () => {
  const MIN = 60_000;
  const q = (iso: string): QuoteCandle => ({
    datetime: iso,
    bid: { datetime: iso, open: 1, high: 1, low: 1, close: 1 },
    ask: { datetime: iso, open: 1, high: 1, low: 1, close: 1 },
  });

  it("asks the week two different questions and gets two different answers", () => {
    // The summer band between the real Friday close (21:00Z) and the latest
    // possible one (22:00Z). Keeping a bar here is right — it may be real.
    // Alleging a GAP here is wrong — the market may have been shut.
    const band = Date.parse("2026-09-04T21:30:00Z");
    expect(isMarketClosed(band)).toBe(false);
    expect(isPossiblyClosed(band)).toBe(true);
    // Deep in the weekend both agree
    expect(isMarketClosed(Date.parse("2026-09-05T12:00:00Z"))).toBe(true);
    expect(isPossiblyClosed(Date.parse("2026-09-05T12:00:00Z"))).toBe(true);
  });

  it("does not call a 15min series incomplete just because a weekend went past", () => {
    // This shipped, and then quietly sent every weekend-spanning 15min window
    // back to the mid feed: 60 minutes of phantom gap against a 45-minute
    // tolerance, every weekend.
    const friLast = Date.parse("2026-09-04T20:45:00Z");
    const sunFirst = Date.parse("2026-09-06T21:00:00Z");
    const gap = largestGap([q(new Date(friLast).toISOString()), q(new Date(sunFirst).toISOString())], friLast, sunFirst, 15 * MIN);
    expect(gap).toBeLessThanOrEqual(MAX_GAP_INTERVALS * 15 * MIN);
  });

  it("still catches a real hole in the middle of a trading day", () => {
    const from = Date.parse("2026-09-01T09:00:00Z"); // a Tuesday
    const to = Date.parse("2026-09-01T15:00:00Z");
    // one bar at each end, six hours of open market with nothing between
    const gap = largestGap([q(new Date(from).toISOString()), q(new Date(to).toISOString())], from, to, 15 * MIN);
    expect(gap).toBeGreaterThan(MAX_GAP_INTERVALS * 15 * MIN);
  });
});
