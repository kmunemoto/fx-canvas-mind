import { describe, it, expect } from "vitest";
import {
  dateKeys,
  exitSide,
  fetchQuotes,
  fillSide,
  isMarketClosed,
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
    expect(supportsQuotes("USD/JPY", "5min")).toBe(false);
  });
});

describe("GMO's date keys", () => {
  it("keys a bar by its JST day, not its UTC day", () => {
    // 2026-09-02 15:00 UTC is midnight on 2026-09-03 in Tokyo
    expect(jstDayKey(Date.parse("2026-09-02T15:00:00Z"))).toBe("20260903");
    expect(jstDayKey(Date.parse("2026-09-02T14:59:00Z"))).toBe("20260902");
  });

  it("covers both JST days a UTC window straddles", () => {
    const keys = dateKeys(Date.parse("2026-09-02T13:00:00Z"), Date.parse("2026-09-02T16:00:00Z"), "day");
    expect(keys).toEqual(["20260902", "20260903"]);
  });

  it("asks for a whole year at a time on the coarse intervals", () => {
    expect(dateKeys(Date.parse("2026-03-01T00:00:00Z"), Date.parse("2026-09-01T00:00:00Z"), "year")).toEqual(["2026"]);
    // 2025-12-31 10:00 UTC is still 2025 in Tokyo; 20:00 UTC is already 2026
    expect(dateKeys(Date.parse("2025-12-31T10:00:00Z"), Date.parse("2026-01-02T00:00:00Z"), "year")).toEqual(["2025", "2026"]);
    expect(dateKeys(Date.parse("2025-12-31T20:00:00Z"), Date.parse("2026-01-02T00:00:00Z"), "year")).toEqual(["2026"]);
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
    expect(seen).toHaveLength(2); // one JST day, two sides
    expect(seen.every((u) => u.includes("interval=1hour&date=20260903"))).toBe(true);
    expect(res?.requests).toBe(2);
    expect(res?.missing).toEqual([]);
    expect(res?.bars).toHaveLength(2);
    expect(spreadAt(res!.bars[0])).toBeCloseTo(0.01, 6);
  });

  it("reports a date key it could not read instead of returning a shorter series silently", async () => {
    const now = Date.parse("2026-09-03T12:00:00Z");
    const res = await fetchQuotes("USD/JPY", "1h", Date.parse("2026-09-02T13:00:00Z"), T, now, async (url) =>
      url.includes("date=20260902") ? null : rows(T, url.includes("ASK") ? 0.01 : 0));
    expect(res?.missing).toEqual(["20260902"]);
    expect(res?.bars.length).toBeGreaterThan(0);
  });

  it("declines a pair it does not carry", async () => {
    expect(await fetchQuotes("USD/CHF", "1h", T, T + HOUR, T + 2 * HOUR, async () => null)).toBeNull();
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
