import { describe, it, expect, expectTypeOf } from "vitest";
import {
  CHECK_EVERY_MS,
  EVAL_INTERVAL,
  EVAL_OUTPUTSIZE,
  EXPIRY_DAYS,
  INTERVAL_MS,
  classifyOrder,
  downsamplePath,
  finerRung,
  hasFutureCandles,
  isCoherentPlan,
  isDue,
  judgePlan,
  parseCandleTime,
  stampOnly,
  type Evaluation,
  type FineFetcher,
  type FineResult,
  type OpenRow,
  type Reason,
} from "../../supabase/functions/track-outcomes/evaluate.ts";
import { parseCandles, type Candle } from "../../supabase/functions/analyze/indicators.ts";
import { isMarketClosed, type QuoteCandle } from "../../supabase/functions/track-outcomes/quotes.ts";
import type { OutcomeEvaluation, OutcomeReason } from "../lib/types";

const candle = (datetime: string, high: number, low: number, open?: number, close?: number): Candle => ({
  datetime,
  open: open ?? (high + low) / 2,
  high,
  low,
  close: close ?? (high + low) / 2,
});

const T0 = "2026-08-20T00:00:00Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (hours: number) => Date.parse(T0) + hours * HOUR;
const iso = (hours: number) => new Date(at(hours)).toISOString();
// "YYYY-MM-DD HH:mm:ss" the way Twelve Data writes it, hours after T0
const stamp = (hours: number) => new Date(at(hours)).toISOString().slice(0, 19).replace("T", " ");
// Contiguous quiet hourly bars for hours [from, to)
const quietHours = (from: number, to: number, high = 150.7, low = 150.3): Candle[] => {
  const out: Candle[] = [];
  for (let h = from; h < to; h++) out.push(candle(stamp(h), high, low));
  return out;
};

// BUY limit: market at 150.5, entry below it at 150, SL 149, TP1 152
const buyLimit: OpenRow = {
  id: "1",
  pair: "USD/JPY",
  interval: "1h",
  signal: "BUY",
  entry_point: 150,
  stop_loss: 149,
  take_profit_1: 152,
  take_profit_2: 153,
  take_profit_3: 154,
  created_at: T0,
  price_at_signal: 150.5,
  evaluation: null,
};

// SELL limit: market 149.5, entry above at 150, SL 151, TP1 148
const sellLimit: OpenRow = {
  ...buyLimit,
  signal: "SELL",
  entry_point: 150,
  stop_loss: 151,
  take_profit_1: 148,
  take_profit_2: 147,
  take_profit_3: 146,
  price_at_signal: 149.5,
};

// Fixtures are hourly bars, so the default judging interval is 1h; tests that
// use 15min bars say so explicitly
const judge = (row: OpenRow, candles: Candle[], nowHours = 48, evalInterval = "1h", fetchFine?: FineFetcher) =>
  judgePlan(row, candles, evalInterval, at(nowHours), fetchFine);

// Finer bars from the mid feed, in the tagged shape a FineFetcher returns:
// the judge refuses sub-bars whose basis differs from the coarse series'
const mid = (bars: Candle[]): FineResult => ({ basis: "mid", bars });

describe("classifyOrder", () => {
  it("treats an entry at the market price as a market order", () => {
    expect(classifyOrder({ signal: "BUY", entry_point: 150.01 }, 150)).toBe("market");
  });
  it("BUY below the market is a limit, above it a stop", () => {
    expect(classifyOrder({ signal: "BUY", entry_point: 149 }, 150)).toBe("limit");
    expect(classifyOrder({ signal: "BUY", entry_point: 151 }, 150)).toBe("stop");
  });
  it("SELL above the market is a limit, below it a stop", () => {
    expect(classifyOrder({ signal: "SELL", entry_point: 151 }, 150)).toBe("limit");
    expect(classifyOrder({ signal: "SELL", entry_point: 149 }, 150)).toBe("stop");
  });
  it("is unknown without a reference price", () => {
    expect(classifyOrder({ signal: "BUY", entry_point: 150 }, null)).toBe("unknown");
  });
});

describe("judgePlan — entry handling", () => {
  it("wins only after the entry fills and TP1 is then reached", async () => {
    const j = await judge(buyLimit, [
      candle(stamp(1), 150.6, 150.2), // never reaches the entry
      candle(stamp(2), 150.3, 149.9), // fills at 150
      candle(stamp(3), 152.3, 150.4), // TP1
    ]);
    expect(j.resolution).toBe("win");
    expect(j.outcome_price).toBe(152);
    expect(j.evaluation.filled_at).toBe(iso(2));
    expect(j.evaluation.resolved_at).toBe(iso(3));
    expect(j.closed_at).toBe(iso(3));
    expect(j.evaluation.order_type).toBe("limit");
    expect(j.evaluation.tps_hit).toEqual([1]);
  });

  it("judges the raw provider payload (newest first, string fields)", async () => {
    const raw = parseCandles([
      { datetime: "2026-08-20 03:00:00", open: "150.5", high: "152.3", low: "150.4", close: "152.0" },
      { datetime: "2026-08-20 02:00:00", open: "150.2", high: "150.3", low: "149.9", close: "150.1" },
      { datetime: "2026-08-20 01:00:00", open: "150.5", high: "150.6", low: "150.2", close: "150.3" },
      { datetime: "2026-08-20 00:00:00", open: "150.5", high: "150.7", low: "150.3", close: "150.5" },
    ]);
    const j = await judge(buyLimit, raw);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.filled_at).toBe("2026-08-20T02:00:00.000Z");
    expect(j.evaluation.resolved_at).toBe("2026-08-20T03:00:00.000Z");
  });

  it("loses when SL is reached after the fill", async () => {
    const j = await judge(buyLimit, [
      candle(stamp(1), 150.3, 149.95),
      candle(stamp(2), 150.2, 148.9),
    ]);
    expect(j.resolution).toBe("loss");
    expect(j.outcome_price).toBe(149);
  });

  it("is untriggered (missed) when TP1 is reached before the entry ever fills", async () => {
    const j = await judge(buyLimit, [
      candle(stamp(1), 151.0, 150.3),
      candle(stamp(2), 152.5, 150.8),
    ]);
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("missed");
    expect(j.evaluation.filled_at).toBeNull();
    expect(j.outcome_price).toBeNull();
  });

  it("is untriggered (invalidated) when a stop entry sees its SL before the trigger", async () => {
    // BUY stop above the market: entry 151, SL 150, market 150.5
    const buyStop: OpenRow = { ...buyLimit, entry_point: 151, stop_loss: 150, price_at_signal: 150.5 };
    const j = await judge(buyStop, [candle(stamp(1), 150.8, 149.9)]);
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("invalidated");
    expect(j.evaluation.order_type).toBe("stop");
  });

  it("ignores a level that sits between the market and the entry", async () => {
    // BUY stop: market 150.0, entry 150.5, SL 150.2 (already below the
    // market at signal time), TP1 151.5
    const buyStop: OpenRow = { ...buyLimit, entry_point: 150.5, stop_loss: 150.2, take_profit_1: 151.5, take_profit_2: null, take_profit_3: null, price_at_signal: 150.0 };
    const j = await judge(buyStop, [
      candle(stamp(1), 150.1, 149.9), // "touches" the SL without any trade
      candle(stamp(2), 150.7, 150.3), // triggers
      candle(stamp(3), 151.6, 150.6), // TP1
    ]);
    expect(j.resolution).toBe("win");
  });

  it("stays open while unfilled inside the entry window, then lapses as no_fill", async () => {
    const open = await judge(buyLimit, quietHours(0, 10), 10);
    expect(open.resolution).toBeNull();
    expect(open.closed_at).toBeNull();

    // 1h plans get 48h of market time to fill: the bar that opens 48h in
    // closes the order
    const stale = await judge(buyLimit, quietHours(0, 49), 49);
    expect(stale.resolution).toBe("untriggered");
    expect(stale.evaluation.reason).toBe("no_fill");
    expect(stale.evaluation.resolved_at).toBe(iso(48));
  });

  it("lapses on the judge's clock only when the data lags a little behind an elapsed window", async () => {
    const lagging = await judge(buyLimit, quietHours(0, 47), 49);
    expect(lagging.resolution).toBe("untriggered");
    expect(lagging.evaluation.reason).toBe("no_fill");
    expect(lagging.evaluation.resolved_at).toBe(iso(49));

    // Two bars of data 49h later is missing data, not an elapsed window
    const sparse = await judge(buyLimit, quietHours(0, 2), 49);
    expect(sparse.resolution).toBeNull();
  });

  it("closes the entry window on candle time, not on when the judge ran", async () => {
    const bars = quietHours(0, 50);
    bars.push(candle(stamp(50), 150.3, 149.9)); // would fill, but the order lapsed at 48h
    bars.push(candle(stamp(51), 152.3, 150.4));
    const j = await judge(buyLimit, bars, 60);
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("no_fill");
    expect(j.evaluation.resolved_at).toBe(iso(48));
  });

  it("does not run the entry window down over the weekend close", async () => {
    // 15min plan (12h window) made Friday 20:00 UTC, an hour before the
    // close; the market reopens Sunday 21:00 and reaches the entry
    const friday: OpenRow = { ...buyLimit, interval: "15min", created_at: "2026-08-21T20:00:00Z" };
    const bars: Candle[] = [];
    for (let m = 0; m < 8; m++) {
      const t = new Date(Date.parse("2026-08-21T20:00:00Z") + m * 15 * 60_000).toISOString().slice(0, 19).replace("T", " ");
      bars.push(candle(t, 150.7, 150.3));
    }
    bars.push(candle("2026-08-23 21:00:00", 150.3, 149.9));
    bars.push(candle("2026-08-23 21:15:00", 152.3, 150.4));
    const j = await judgePlan(friday, bars, "15min", Date.parse("2026-08-23T22:00:00Z"));
    expect(j.resolution).toBe("win");
    expect(j.evaluation.filled_at).toBe("2026-08-23T21:00:00.000Z");
  });

  it("expires a filled plan on candle time at the bar that crosses the deadline", async () => {
    const bars: Candle[] = [candle(stamp(1), 150.3, 149.9)]; // fill
    for (let h = 2; h <= 21 * 24; h++) bars.push(candle(stamp(h), 150.8, 150.4, 150.6, 150.5));
    const j = await judge(buyLimit, bars, 25 * 24);
    expect(j.resolution).toBe("expired");
    // 20 market days after the signal: the bar 480 bars in
    expect(j.evaluation.resolved_at).toBe(iso(481));
    expect(j.outcome_price).toBe(150.6);
  });

  it("fills a market-priced entry at signal time", async () => {
    const market: OpenRow = { ...buyLimit, price_at_signal: 150.01 };
    const j = await judge(market, [candle(stamp(1), 152.2, 150.3)]);
    expect(j.evaluation.order_type).toBe("market");
    expect(j.evaluation.filled_at).toBe(iso(0));
    expect(j.resolution).toBe("win");
  });

  it("uses the first post-signal open as the reference when price_at_signal is missing", async () => {
    const legacy: OpenRow = { ...buyLimit, price_at_signal: null };
    const j = await judge(legacy, [candle(stamp(1), 150.9, 150.3, 150.6, 150.5), candle(stamp(2), 150.2, 149.9), candle(stamp(3), 152.4, 150.5)]);
    expect(j.evaluation.order_type).toBe("limit");
    expect(j.resolution).toBe("win");
  });

  it("prefers the close of the bar containing the signal as the legacy reference", async () => {
    // Signal at 00:05 inside the 00:00 hourly bar: its close of 149.7 puts a
    // 150 entry above the market (a BUY stop), even though the next bar
    // opens higher
    const legacy: OpenRow = { ...buyLimit, price_at_signal: null, created_at: "2026-08-20T00:05:00Z" };
    const j = await judge(legacy, [
      candle("2026-08-20 00:00:00", 149.8, 149.5, 149.6, 149.7),
      candle("2026-08-20 01:00:00", 150.9, 150.3, 150.6, 150.5),
    ], 5, "1h");
    expect(j.evaluation.order_type).toBe("stop");

    // A signal exactly on the hour: the previous bar ended with it and is
    // not the signal bar, so the next bar's open is the reference
    const onTheHour: OpenRow = { ...buyLimit, price_at_signal: null };
    const k = await judge(onTheHour, [
      candle("2026-08-19 23:00:00", 149.8, 149.5, 149.6, 149.7),
      candle(stamp(1), 150.9, 150.3, 150.6, 150.5),
    ], 5, "1h");
    expect(k.evaluation.order_type).toBe("limit");
  });
});

describe("judgePlan — SELL", () => {
  it("mirrors the limit fill and win", async () => {
    const j = await judge(sellLimit, [
      candle(stamp(1), 150.1, 149.4), // fills
      candle(stamp(2), 149.8, 147.9), // TP1
    ]);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.order_type).toBe("limit");
  });

  it("a limit fill bar that reaches SL is a loss, with the adverse side only counted", async () => {
    const j = await judge(sellLimit, [candle(stamp(1), 151.1, 149.9)]);
    expect(j.resolution).toBe("loss");
    expect(j.evaluation.mae).toBeCloseTo(1.1, 6);
    expect(j.evaluation.mfe).toBe(0);
  });

  it("a stop fill bar that reaches SL is ambiguous, one that reaches TP1 is a win", async () => {
    const sellStop: OpenRow = { ...sellLimit, price_at_signal: 150.5 };
    expect((await judge(sellStop, [candle(stamp(1), 151.1, 149.9)])).resolution).toBe("ambiguous");
    expect((await judge(sellStop, [candle(stamp(1), 150.6, 147.9)])).resolution).toBe("win");
  });

  it("tracks excursions and further targets downward", async () => {
    const j = await judge(sellLimit, [
      candle(stamp(1), 150.1, 149.4),
      candle(stamp(2), 149.8, 147.9), // TP1
      candle(stamp(3), 149.0, 146.9), // TP2
      candle(stamp(4), 150.1, 148.0), // back through the entry: runner stops
      candle(stamp(5), 148.0, 145.9), // TP3, too late
    ]);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.tps_hit).toEqual([1, 2]);
    expect(j.evaluation.mfe).toBeCloseTo(3.1, 6);
    expect(j.evaluation.mae).toBeCloseTo(0.1, 6);
  });

  it("a stop entry is invalidated when the SL above the market is reached first", async () => {
    const sellStop: OpenRow = { ...sellLimit, price_at_signal: 150.5 };
    const j = await judge(sellStop, [candle(stamp(1), 151.2, 150.2)]);
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("invalidated");
  });
});

describe("judgePlan — the bar around the signal", () => {
  // Signal at 00:05 inside the 00:00 15min bar; market 150.2, entry 150
  const nearMarket: OpenRow = { ...buyLimit, price_at_signal: 150.2, created_at: "2026-08-20T00:05:00Z" };

  it("fills at signal time when that bar closed beyond the entry (price crossed it after the signal)", async () => {
    const j = await judge(nearMarket, [
      candle("2026-08-20 00:00:00", 150.3, 149.9, 150.2, 149.95),
      candle("2026-08-20 00:15:00", 152.2, 149.96), // TP1
    ], 5, "15min");
    expect(j.evaluation.order_type).toBe("limit");
    expect(j.evaluation.filled_at).toBe("2026-08-20T00:05:00.000Z");
    expect(j.evaluation.possible_fill).toBe(false);
    expect(j.resolution).toBe("win");
  });

  it("keeps a fill established while the signal bar was still forming", async () => {
    // First sweep, five minutes in: the live close is below the entry
    const first = await judgePlan(nearMarket, [
      candle("2026-08-20 00:00:00", 150.3, 149.9, 150.2, 149.95),
    ], "15min", Date.parse("2026-08-20T00:10:00Z"));
    expect(first.evaluation.filled_at).toBe("2026-08-20T00:05:00.000Z");
    expect(first.resolution).toBeNull();

    // Later, the completed bar closed back above the entry; the fill stands
    const second = await judgePlan({ ...nearMarket, evaluation: first.evaluation }, [
      candle("2026-08-20 00:00:00", 150.3, 149.9, 150.2, 150.2),
      candle("2026-08-20 00:15:00", 152.2, 150.3),
    ], "15min", Date.parse("2026-08-20T00:35:00Z"));
    expect(second.evaluation.filled_at).toBe("2026-08-20T00:05:00.000Z");
    expect(second.resolution).toBe("win");
  });

  it("cannot tell a fill from a pre-signal touch when that bar closed back on the market side", async () => {
    const j = await judge(nearMarket, [
      candle("2026-08-20 00:00:00", 150.3, 149.95, 150.2, 150.2),
      candle("2026-08-20 00:15:00", 152.2, 150.3), // TP1 without touching the entry again
    ], 5, "15min");
    expect(j.evaluation.filled_at).toBeNull();
    expect(j.evaluation.possible_fill).toBe(true);
    expect(j.resolution).toBe("ambiguous");
  });

  it("does not report a possible fill as never reached when the window lapses", async () => {
    const bars = [candle("2026-08-20 00:00:00", 150.3, 149.95, 150.2, 150.2)];
    for (let m = 1; m <= 52; m++) {
      const t = new Date(Date.parse("2026-08-20T00:00:00Z") + m * 15 * 60_000).toISOString().slice(0, 19).replace("T", " ");
      bars.push(candle(t, 150.9, 150.3));
    }
    const plan: OpenRow = { ...nearMarket, interval: "15min" }; // 12h window
    const j = await judge(plan, bars, 14, "15min");
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.possible_fill).toBe(true);
  });

  it("settles a possible fill normally when the entry is touched again later", async () => {
    const j = await judge(nearMarket, [
      candle("2026-08-20 00:00:00", 150.3, 149.95, 150.2, 150.2),
      candle("2026-08-20 00:15:00", 150.4, 149.98), // fills for sure
      candle("2026-08-20 00:30:00", 152.2, 150.3),
    ], 5, "15min");
    expect(j.evaluation.filled_at).toBe("2026-08-20T00:15:00.000Z");
    expect(j.resolution).toBe("win");
  });

  it("does not treat the signal bar as a fill when it never reached the entry", async () => {
    const j = await judge(nearMarket, [
      candle("2026-08-20 00:00:00", 150.3, 150.1),
      candle("2026-08-20 00:15:00", 152.2, 150.3),
    ], 5, "15min");
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("missed");
  });

  it("refines a coarse signal bar with 15min bars before deciding on the fill", async () => {
    // 1h eval (a 4h plan): the 00:00 hour touched the entry but closed above
    // it; the 15min bars show the touch came at 00:30, after the 00:05 signal
    const plan: OpenRow = { ...nearMarket, interval: "4h" };
    const calls: Array<[number, number]> = [];
    const fetchFine: FineFetcher = async (_pair, from, to) => {
      calls.push([from, to]);
      return mid([
        candle("2026-08-20 00:00:00", 150.3, 150.1),
        candle("2026-08-20 00:15:00", 150.3, 150.15),
        candle("2026-08-20 00:30:00", 150.2, 149.97),
        candle("2026-08-20 00:45:00", 150.4, 150.1, 150.2, 150.3),
      ]);
    };
    const j = await judge(plan, [
      candle("2026-08-20 00:00:00", 150.4, 149.97, 150.2, 150.3),
      candle("2026-08-20 01:00:00", 152.3, 150.2),
    ], 5, "1h", fetchFine);
    expect(calls).toEqual([[Date.parse("2026-08-20T00:00:00Z"), Date.parse("2026-08-20T01:00:00Z")]]);
    expect(j.evaluation.refined).toBe(true);
    expect(j.evaluation.filled_at).toBe("2026-08-20T00:30:00.000Z");
    expect(j.resolution).toBe("win");
  });

  it("is ambiguous when a market order's signal bar already reached the SL", async () => {
    const market: OpenRow = { ...nearMarket, price_at_signal: 150.01 };
    const j = await judge(market, [
      candle("2026-08-20 00:00:00", 150.1, 148.9, 150.0, 149.2), // SL 149 inside the signal bar
      candle("2026-08-20 00:15:00", 152.2, 149.1),
    ], 5, "15min");
    expect(j.evaluation.order_type).toBe("market");
    expect(j.resolution).toBe("ambiguous");
  });
});

describe("judgePlan — fill candle that also touches a level", () => {
  it("a limit entry whose fill candle reaches SL is a loss (price passed the entry to get there)", async () => {
    const j = await judge(buyLimit, [candle(stamp(1), 150.4, 148.8)]);
    expect(j.resolution).toBe("loss");
  });

  it("a limit entry whose fill candle reaches TP1 is ambiguous at the finest resolution", async () => {
    const j = await judge(buyLimit, [candle(stamp(1), 152.2, 149.95)]);
    expect(j.resolution).toBe("ambiguous");
  });

  it("a stop entry whose fill candle reaches TP1 is a win (entry sits between market and TP)", async () => {
    const buyStop: OpenRow = { ...buyLimit, entry_point: 151, stop_loss: 150, take_profit_1: 152.5, price_at_signal: 150.5 };
    const j = await judge(buyStop, [candle(stamp(1), 152.6, 150.6)]);
    expect(j.resolution).toBe("win");
  });

  it("counts only the far side of the entry as excursion on the fill bar", async () => {
    // BUY stop entry 151: the bar's low of 150.1 was traversed before the
    // trigger, so it is not adverse excursion of the trade
    const buyStop: OpenRow = { ...buyLimit, entry_point: 151, stop_loss: 150, take_profit_1: 152.5, price_at_signal: 150.5 };
    const j = await judge(buyStop, [candle(stamp(1), 151.2, 150.1), candle(stamp(2), 152.6, 151.1)]);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.mae).toBe(0);
  });
});

// A bar that reaches both SL and TP1 cannot normally be ordered, and the
// judge asks for finer bars. But if the position was ALREADY open when that
// bar began, and the bar OPENS at or beyond one of the levels, the order is
// not in doubt: the open is the bar's first traded price, and no finer
// resolution can revise it. That is the only new resolution here, and it is
// definitional rather than a guess.
//
// The rest of this block pins the three ways the first cut of it was wrong.
// None of them was caught by the 434 tests that existed before.
// The instrument. evaluation.reason can only say incoherent / no_data / null,
// so the record could not tell an unknowable SL-vs-TP order from an
// unknowable signal-vs-touch order from a starved provider. That distinction
// is what decides whether a scoring convention for the residue is needed at
// all — the question task #41 tried to answer without measuring.
//
// These pin that each site is REACHABLE and names what actually happened. A
// label that lies is worse than no label, because the next decision is made
// off the histogram.
describe("judgePlan — where an unjudgeable plan became unjudgeable", () => {
  const buyMarket: OpenRow = { ...buyLimit, entry_point: 150, price_at_signal: 150 };

  it("names a plan whose own levels contradict each other", async () => {
    const broken: OpenRow = { ...buyLimit, stop_loss: 153 }; // SL above TP1
    const j = await judge(broken, quietHours(1, 4), 48, "1h");
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.ambiguity?.site).toBe("incoherent");
    expect(j.evaluation.ambiguity?.touched).toBeNull();
  });

  it("names a window that starts after the signal", async () => {
    // Two conditions: the fetched bars begin after the signal AND the entry
    // window (48h for a 1h plan) has already run out, so waiting cannot help.
    const j = await judge(buyLimit, quietHours(50, 54), 60, "1h");
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.ambiguity?.site).toBe("window_short");
    expect(j.evaluation.ambiguity?.at_interval).toBeNull();
  });

  it("names a starved provider, and the bar it starved on", async () => {
    const bars = [
      candle(stamp(1), 150.3, 149.9),
      candle(stamp(2), 152.5, 148.5),
    ];
    const first = await judge(buyLimit, bars, 48, "1h", async () => null);
    const third = await judge(
      { ...buyLimit, evaluation: { ...first.evaluation, refine_attempts: 2 } },
      bars,
      48,
      "1h",
      async () => null,
    );
    expect(third.resolution).toBe("ambiguous");
    // Starvation does not overwrite the site: the coarse bar still touched
    // both levels while the trade was on, and that is what the row says.
    // The starvation is in reason / refine_attempts, not in the site.
    expect(third.evaluation.ambiguity?.site).toBe("in_trade");
    expect(third.evaluation.ambiguity?.touched).toBe("both");
    expect(third.evaluation.ambiguity?.at_interval).toBe("1h");
    expect(third.evaluation.reason).toBe("no_data");
    expect(third.evaluation.refine_attempts).toBe(3);
  });

  it("names a starved provider only when no bar could be labelled", async () => {
    // A legacy limit whose signal bar touched the entry without crossing it:
    // possibleFill, no level reached, so the refinement was about the fill
    // alone and there is no labelled bar for the site to keep.
    const late: OpenRow = { ...buyLimit, created_at: "2026-08-20T00:50:00Z" };
    const bars = [
      candle(stamp(0), 150.6, 149.95, 150.5, 150.4),
      ...quietHours(1, 4),
    ];
    const first = await judge(late, bars, 48, "1h", async () => null);
    const third = await judge(
      { ...late, evaluation: { ...first.evaluation, refine_attempts: 2 } },
      bars,
      48,
      "1h",
      async () => null,
    );
    expect(third.resolution).toBe("ambiguous");
    expect(third.evaluation.ambiguity?.site).toBe("no_finer_data");
    expect(third.evaluation.ambiguity?.at_interval).toBeNull();
  });

  it("separates a level reached inside the window from a window that ran out", async () => {
    // The reviewer's case: legacy limit, signal bar touches the entry without
    // crossing (possibleFill), next bar cleanly reaches TP1 without touching
    // the entry — ten minutes into a 48-hour window. Not a lapse.
    const late: OpenRow = { ...buyLimit, created_at: "2026-08-20T00:50:00Z" };
    const bars = [
      candle(stamp(0), 150.6, 149.95, 150.5, 150.4),
      candle(stamp(1), 152.5, 150.5, 150.6, 152.4),
      candle(stamp(2), 152.6, 152.0),
    ];
    const j = await judge(late, bars, 48, "1h");
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.ambiguity?.site).toBe("unfilled_touch");
    expect(j.evaluation.ambiguity?.touched).toBe("tp1");
    expect(j.evaluation.ambiguity?.bar_range).toBeCloseTo(2, 5);

    // ...and the genuine lapse: same undated fill, quiet bars, window run out
    const lapsed = await judge(late, [bars[0], ...quietHours(1, 52)], 60, "1h");
    expect(lapsed.resolution).toBe("ambiguous");
    expect(lapsed.evaluation.ambiguity?.site).toBe("pre_fill");
    expect(lapsed.evaluation.ambiguity?.touched).toBeNull();
    expect(lapsed.evaluation.ambiguity?.bar_range).toBeNull();
  });

  it("names the fill bar that also reached a level", async () => {
    // Legacy limit: the bar that reaches the entry also reaches TP1, and a
    // limit fill cannot say which came first.
    const bars = [candle(stamp(1), 152.5, 149.9, 150.4, 152.2), candle(stamp(2), 152.6, 152.0)];
    const j = await judge(buyLimit, bars, 48, "1h", async () => mid([candle("2026-08-20 01:00:00", 152.5, 149.9)]));
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.ambiguity?.site).toBe("fill_bar");
    expect(j.evaluation.ambiguity?.touched).toBe("tp1");
  });

  it("records what the coarse bar showed when the finer bars disagree, and which rung disagreed", async () => {
    const bars = [
      candle(stamp(1), 150.3, 149.9),
      candle(stamp(2), 152.5, 148.5), // both, on the coarse bar
      ...quietHours(3, 5),
    ];
    // Fine bars that reach neither level
    const j = await judge(buyLimit, bars, 48, "1h", async () => mid([
      candle("2026-08-20 02:00:00", 150.6, 150.0),
      candle("2026-08-20 02:30:00", 151.0, 149.5),
    ]));
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.ambiguity?.site).toBe("feed_conflict");
    expect(j.evaluation.ambiguity?.touched).toBe("both");
    expect(j.evaluation.ambiguity?.at_interval).toBe("1h");
    expect(j.evaluation.refined_interval).toBe("15min");
  });

  it("records the rung a judged plan was refined at, and none when it was not", async () => {
    const bars = [candle(stamp(1), 150.3, 149.9), candle(stamp(2), 152.5, 148.5)];
    const refined = await judge(buyLimit, bars, 48, "1h", async () => mid([
      candle("2026-08-20 02:00:00", 150.6, 150.0),
      candle("2026-08-20 02:15:00", 152.1, 150.5),
      candle("2026-08-20 02:30:00", 151.0, 148.5),
    ]));
    expect(refined.resolution).toBe("win");
    expect(refined.evaluation.refined_interval).toBe("15min");
    expect(refined.evaluation.ambiguity).toBeNull();
    const plain = await judge(buyLimit, [candle(stamp(1), 150.3, 149.9), candle(stamp(2), 152.3, 150.1)], 48, "1h");
    expect(plain.evaluation.refined_interval).toBeNull();
  });

  it("names a signal bar, and records that it reached only ONE level", async () => {
    // The premise task #41 got wrong: assessSignalBar fires on tp OR sl, and
    // under market_v1 the commonest case is a single level touched before the
    // plan existed. This is the direct test of that.
    const late: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:50:00Z" };
    const bars = [
      candle(stamp(0), 150.2, 148.9, 150.0, 150.1), // grazes SL only
      candle(stamp(1), 152.3, 150.0, 150.1, 152.1),
      ...quietHours(2, 5, 152.2, 151.9),
    ];
    const healthyFine: FineFetcher = async () => mid([
      candle("2026-08-20 00:00:00", 150.2, 150.0),
      candle("2026-08-20 00:30:00", 150.2, 148.9),
    ]);
    const j = await judge(late, bars, 48, "1h", healthyFine);
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.ambiguity?.site).toBe("signal_bar");
    expect(j.evaluation.ambiguity?.touched).toBe("sl");
    expect(j.evaluation.ambiguity?.at_interval).toBe("1h");
  });

  it("records the bar's size against the distance between the plan's levels", async () => {
    // bar_range / span is the falsification test: near 1.0 means the ladder is
    // a rung short, 3 and up means a real flash event.
    const late: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:50:00Z" };
    const bars = [
      candle(stamp(0), 150.2, 148.9, 150.0, 150.1),
      ...quietHours(1, 4, 150.5, 150.2),
    ];
    const j = await judge(late, bars, 48, "1h", async () => mid([
      candle("2026-08-20 00:00:00", 150.2, 148.9),
    ]));
    // SL 149, TP1 152 -> span 3; the signal bar spans 150.2-148.9 = 1.3
    expect(j.evaluation.ambiguity?.span).toBeCloseTo(3, 5);
    expect(j.evaluation.ambiguity?.bar_range).toBeCloseTo(1.3, 5);
  });

  it("names a bar that touched both levels while the position was open", async () => {
    const bars = [
      candle(stamp(1), 150.3, 149.9),
      candle(stamp(2), 152.5, 148.5), // both, and does not open through either
      ...quietHours(3, 5),
    ];
    const j = await judge(buyLimit, bars, 48, "1h", async () => mid([
      candle("2026-08-20 02:00:00", 152.5, 148.5),
    ]));
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.ambiguity?.touched).toBe("both");
  });

  it("leaves the marker null on a plan that was actually judged", async () => {
    const bars = [candle(stamp(1), 150.3, 149.9), candle(stamp(2), 152.3, 150.1)];
    const j = await judge(buyLimit, bars, 48, "1h");
    expect(j.resolution).toBe("win");
    expect(j.evaluation.ambiguity).toBeNull();
  });
});

describe("judgePlan — open-through", () => {
  // BUY entered at the market, so the position is open from the signal instant
  const buyMarket: OpenRow = { ...buyLimit, entry_point: 150, price_at_signal: 150 };

  it("resolves a gap that opens through the stop, without asking for finer bars", async () => {
    const bars = [
      candle(stamp(1), 150.2, 149.9, 150.0, 150.1),
      // Opens BELOW the SL, then trades all the way up through TP1
      candle(stamp(2), 152.5, 148.4, 148.5, 152.0),
    ];
    let asked = 0;
    const j = await judge(buyMarket, bars, 48, "1h", async () => { asked++; return null; });
    expect(j.resolution).toBe("loss");
    expect(j.evaluation.refine_attempts).toBe(0);
    expect(j.evaluation.refined).toBe(false);
    expect(asked).toBe(0);
  });

  it("resolves the mirror: opening through TP1 while the bar also spans the stop", async () => {
    const bars = [
      candle(stamp(1), 150.2, 149.9, 150.0, 150.1),
      candle(stamp(2), 152.6, 148.5, 152.3, 152.0),
    ];
    const j = await judge(buyMarket, bars, 48, "1h", async () => null);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.refine_attempts).toBe(0);
  });

  it("resolves a SELL that opens through its stop", async () => {
    const sellMarket: OpenRow = { ...sellLimit, entry_point: 150, price_at_signal: 150 };
    const bars = [
      candle(stamp(1), 150.1, 149.8, 150.0, 149.9),
      // SELL stop is 151, TP1 148: opens ABOVE the stop
      candle(stamp(2), 151.6, 147.5, 151.4, 148.0),
    ];
    const j = await judge(sellMarket, bars, 48, "1h", async () => null);
    expect(j.resolution).toBe("loss");
  });

  it("does not charge the open bar's later range to the trade's excursion", async () => {
    // The position left at the open. Everything after it in that bar is
    // post-exit price action, and mae_r is the ONLY input to the
    // lucky_win / good_call split in postmortem/facts.ts - so folding the
    // whole bar in would file a clean win as lucky_win, which (unlike
    // good_call) is citable evidence for a "do not trade" rule.
    const bars = [
      candle(stamp(1), 150.2, 149.9, 150.0, 150.1),
      // Opens through TP1, then dives almost to the stop before closing
      candle(stamp(2), 152.6, 148.6, 152.3, 149.2),
      ...quietHours(3, 6, 152.2, 151.8),
    ];
    const j = await judge(buyMarket, bars, 48, "1h", async () => null);
    expect(j.resolution).toBe("win");
    // risk is 1.00, so an unfixed mae would read ~1.4R and trip LUCKY_MAE_R (0.8)
    expect(j.evaluation.mae_r ?? 0).toBeLessThan(0.8);
  });

  it("does not fire on the bar that filled the order", async () => {
    // The fill happened somewhere inside this bar, so its open predates the
    // position and cannot order anything.
    const bars = [candle(stamp(1), 152.5, 148.4, 148.5, 150.2)];
    const j = await judge(buyLimit, bars, 48, "1h", async () => null);
    expect(j.resolution).not.toBe("loss");
  });

  it("does not fire on the signal bar", async () => {
    // The signal must fall INSIDE a bar for that bar to be the signal bar:
    // a plan stamped exactly at a bar's open has no signal bar at all, and
    // that bar is its first post bar.
    const midBar: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:30:00Z" };
    const bars = [
      // Signal bar: opens through the SL and also spans TP1
      candle(stamp(0), 152.5, 148.4, 148.5, 150.2),
      ...quietHours(1, 4),
    ];
    const j = await judge(midBar, bars, 48, "1h", async () => null);
    // Its open predates the plan, so it can order nothing: this must go to
    // the refinement path, not to a verdict.
    expect(j.resolution).toBeNull();
    expect(j.evaluation.refine_pending).toBe(true);
  });

  it("does not apply to sub-bars of a limit fill an earlier sweep recorded", async () => {
    // filled_at is only bar-granular. On a re-sweep the recorded fill bar is
    // re-admitted with filled=true, and without the fillCertainFrom guard a
    // stop touch that PRECEDED the real limit fill convicts the trade.
    const bars = [
      candle(stamp(1), 150.3, 149.9, 150.2, 150.0),
      candle(stamp(2), 152.5, 148.4, 148.5, 152.0),
    ];
    const first = await judge(buyLimit, bars, 48, "1h", async () => null);
    expect(first.evaluation.filled_at).toBe(iso(1));
    // Re-sweep carrying that fill forward
    const again = await judge(
      { ...buyLimit, evaluation: { ...first.evaluation, order_type: "limit", filled_at: iso(2) } },
      bars,
      48,
      "1h",
      async () => null,
    );
    expect(again.resolution).not.toBe("loss");
  });
});

// When the signal falls inside the LAST fine sub-bar of its signal bar, every
// sub-bar the provider returns predates the signal and the sinceMs filter
// empties the list. The feed is healthy, so charging three provider failures
// for it was wrong. But the graze lives in exactly that last sub-bar, and
// EVAL_INTERVAL puts 15min and 1h plans on 15min bars - so the sub-bar is
// already 5min and finerRung(5min) is null. Nothing can ever date it.
//
// Dropping the graze and judging from the later bars is therefore not an
// option: it decides the plan as if the signal bar had been clean, and the
// error follows the market. A one-minute change in created_at flipped the
// SAME price data from "cannot say" to "win".
describe("judgePlan — a signal inside the last fine sub-bar", () => {
  const buyMarket: OpenRow = { ...buyLimit, entry_point: 150, price_at_signal: 150 };
  // Signal bar 00:00-01:00 grazes the SL; the next bar cleanly reaches TP1
  const bars = [
    candle(stamp(0), 150.2, 148.9, 150.0, 150.1),
    candle(stamp(1), 152.3, 150.0, 150.1, 152.1),
    ...quietHours(2, 5, 152.2, 151.9),
  ];
  // A healthy 15min feed for the signal hour, all of it before 00:50
  const healthyBars = mid([
    candle("2026-08-20 00:00:00", 150.2, 150.0),
    candle("2026-08-20 00:15:00", 150.2, 150.0),
    candle("2026-08-20 00:30:00", 150.2, 148.9),
  ]);
  const healthyFine: FineFetcher = async () => healthyBars;

  it("settles as unknown instead of judging the plan off the later bars", async () => {
    const late: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:50:00Z" };
    const j = await judge(late, bars, 48, "1h", healthyFine);
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.reason).toBe("no_data");
    // and emphatically not the win the later bars would suggest
    expect(j.resolution).not.toBe("win");
  });

  it("does not charge a healthy feed three provider failures for it", async () => {
    const late: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:50:00Z" };
    let asked = 0;
    const j = await judge(late, bars, 48, "1h", async () => { asked++; return healthyBars; });
    expect(asked).toBe(1);
    expect(j.evaluation.refine_attempts).toBe(0);
    expect(j.evaluation.refined).toBe(true);
  });

  it("keeps the fill it established, so the row is not outside both sides of the fill rate", async () => {
    const late: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:50:00Z" };
    const j = await judge(late, bars, 48, "1h", healthyFine);
    expect(j.evaluation.filled_at).toBe("2026-08-20T00:50:00.000Z");
  });

  it("still resolves normally when the signal is early enough for the graze to be dated", async () => {
    // Same prices, signal in the FIRST sub-bar: the 00:30 graze is after it,
    // so the stop is genuinely hit and the plan is a loss.
    const early: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:05:00Z" };
    const j = await judge(early, bars, 48, "1h", healthyFine);
    expect(j.resolution).toBe("loss");
  });

  it("still treats a real provider failure as one", async () => {
    const late: OpenRow = { ...buyMarket, created_at: "2026-08-20T00:50:00Z" };
    const j = await judge(late, bars, 48, "1h", async () => null);
    expect(j.resolution).toBeNull();
    expect(j.evaluation.refine_attempts).toBe(1);
    expect(j.evaluation.signal_bar_pending).toBe(true);
    // and the fill survives the deferral
    expect(j.evaluation.filled_at).toBe("2026-08-20T00:50:00.000Z");
  });
});

describe("judgePlan — ambiguity and refinement", () => {
  const filledThenSpans = [
    candle(stamp(1), 150.3, 149.9), // fills
    candle(stamp(2), 152.5, 148.5), // spans SL and TP1
  ];

  it("is ambiguous when no finer data can be fetched at all", async () => {
    const j = await judge(buyLimit, filledThenSpans, 48, "1h");
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.refined).toBe(false);
  });

  it("asks for 15min bars over the ambiguous hour and settles on what they show", async () => {
    const calls: Array<[string, number, number]> = [];
    const fetchFine: FineFetcher = async (pair, from, to) => {
      calls.push([pair, from, to]);
      return mid([
        candle("2026-08-20 02:00:00", 150.6, 150.0),
        candle("2026-08-20 02:15:00", 152.1, 150.5), // TP1 first
        candle("2026-08-20 02:30:00", 151.0, 148.5), // then SL
      ]);
    };
    const j = await judge(buyLimit, filledThenSpans, 48, "1h", fetchFine);
    expect(calls).toEqual([["USD/JPY", at(2), at(3)]]);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.refined).toBe(true);
    expect(j.evaluation.resolved_at).toBe("2026-08-20T02:15:00.000Z");
  });

  it("stays ambiguous when the finer bars span both levels too", async () => {
    const fetchFine: FineFetcher = async () => mid([candle("2026-08-20 02:00:00", 152.5, 148.5)]);
    const j = await judge(buyLimit, filledThenSpans, 48, "1h", fetchFine);
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.refined).toBe(true);
  });

  it("leaves the plan open when the provider has no finer bars, keeping the fill, and gives up after three tries", async () => {
    const unavailable: FineFetcher = async () => null;
    const first = await judge(buyLimit, filledThenSpans, 48, "1h", unavailable);
    expect(first.resolution).toBeNull();
    expect(first.closed_at).toBeNull();
    expect(first.evaluation.refine_pending).toBe(true);
    expect(first.evaluation.refine_attempts).toBe(1);
    expect(first.evaluation.refined).toBe(false);
    expect(first.evaluation.filled_at).toBe(iso(1));
    expect(first.evaluation.mae).toBeCloseTo(0.1, 6);

    const third = await judge({ ...buyLimit, evaluation: { ...first.evaluation, refine_attempts: 2 } }, filledThenSpans, 48, "1h", unavailable);
    expect(third.resolution).toBe("ambiguous");
    expect(third.evaluation.reason).toBe("no_data");
    expect(third.evaluation.refine_attempts).toBe(3);
  });

  it("a budget-deferred refinement costs the plan nothing", async () => {
    const deferred: FineFetcher = async () => "deferred";
    let row: OpenRow = buyLimit;
    for (let run = 0; run < 3; run++) {
      const j = await judge(row, filledThenSpans, 48, "1h", deferred);
      expect(j.resolution).toBeNull();
      expect(j.evaluation.refine_pending).toBe(true);
      expect(j.evaluation.refine_attempts).toBe(0);
      expect(j.evaluation.filled_at).toBe(iso(1));
      row = { ...row, evaluation: j.evaluation };
    }
  });

  it("treats finer bars outside the hour as unavailable rather than skipping the bar", async () => {
    const fetchFine: FineFetcher = async () => mid([candle("2026-08-20 03:00:00", 150.2, 148.9)]);
    const j = await judge(buyLimit, [...filledThenSpans, candle(stamp(3), 150.2, 148.9)], 48, "1h", fetchFine);
    expect(j.resolution).toBeNull();
    expect(j.evaluation.refine_pending).toBe(true);
  });

  it("keeps a filled plan ambiguous when the finer bars contradict the coarse one", async () => {
    const fetchFine: FineFetcher = async () => mid([
      candle("2026-08-20 02:00:00", 150.6, 150.0),
      candle("2026-08-20 02:30:00", 151.0, 149.5),
    ]);
    const j = await judge(buyLimit, [...filledThenSpans, candle(stamp(3), 150.2, 148.9)], 48, "1h", fetchFine);
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.resolved_at).toBe(iso(2));
  });

  it("refines the fill candle itself and continues with later bars", async () => {
    // Fill candle spans entry and TP1 for a limit order: ambiguous at 1h
    const coarse = [
      candle(stamp(1), 152.2, 149.95),
      candle(stamp(2), 150.4, 148.9), // SL, if still open
    ];
    // 15min bars show the fill but not the TP touch: carry the filled state
    // into the next coarse bar
    const fetchFine: FineFetcher = async () => mid([
      candle("2026-08-20 01:00:00", 150.5, 149.95),
      candle("2026-08-20 01:45:00", 151.0, 150.3),
    ]);
    const j = await judge(buyLimit, coarse, 48, "1h", fetchFine);
    expect(j.evaluation.filled_at).toBe("2026-08-20T01:00:00.000Z");
    expect(j.resolution).toBe("loss");
    expect(j.evaluation.resolved_at).toBe(iso(2));
  });

  it("closes a plan as missed when the finer bars show TP1 before the fill", async () => {
    const coarse = [candle(stamp(1), 152.2, 149.95)];
    const fetchFine: FineFetcher = async () => mid([
      candle("2026-08-20 01:00:00", 152.2, 150.8),
      candle("2026-08-20 01:45:00", 150.5, 149.95),
    ]);
    const j = await judge(buyLimit, coarse, 48, "1h", fetchFine);
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("missed");
  });

  it("measures the runner on the finer bars after a refined win, not on the whole coarse bar", async () => {
    const coarse = [
      candle(stamp(1), 150.3, 149.9),
      candle(stamp(2), 153.5, 148.5), // TP1, SL and TP2 all inside one hour
    ];
    const fetchFine: FineFetcher = async () => mid([
      candle("2026-08-20 02:00:00", 150.6, 150.0),
      candle("2026-08-20 02:15:00", 152.1, 150.5), // TP1
      candle("2026-08-20 02:30:00", 151.0, 148.5), // back through the entry: runner stopped
      candle("2026-08-20 02:45:00", 153.5, 151.0), // TP2, but after the runner stopped
    ]);
    const j = await judge(buyLimit, coarse, 48, "1h", fetchFine);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.tps_hit).toEqual([1]);
    expect(j.evaluation.mae).toBeCloseTo(0.1, 6);
  });
});

describe("judgePlan — evidence", () => {
  it("records excursions in price and in R, and further targets reached after TP1", async () => {
    const j = await judge(buyLimit, [
      candle(stamp(1), 150.2, 149.6), // fill, 0.4 adverse
      candle(stamp(2), 152.3, 150.1), // TP1
      candle(stamp(3), 153.4, 151.0), // TP2 while above the entry
      candle(stamp(4), 152.0, 149.9), // back through the entry: runner stops
      candle(stamp(5), 154.5, 152.0), // TP3, but after the runner stopped
    ]);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.mae).toBeCloseTo(0.4, 6);
    expect(j.evaluation.mae_r).toBeCloseTo(0.4, 6);
    expect(j.evaluation.mfe).toBeCloseTo(3.4, 6);
    expect(j.evaluation.mfe_r).toBeCloseTo(3.4, 6);
    expect(j.evaluation.tps_hit).toEqual([1, 2]);
  });

  it("ignores candles from before the plan was created", async () => {
    const j = await judge(buyLimit, [
      candle("2026-08-19 22:00:00", 153, 148), // pre-plan spike
      candle(stamp(1), 150.6, 150.2),
    ]);
    expect(j.resolution).toBeNull();
    expect(j.evaluation.bars_after_signal).toBe(1);
  });

  it("drops candles dated in the future instead of judging on them", async () => {
    const future = [candle(stamp(1), 150.3, 149.9), candle(stamp(30), 152.5, 150.4)];
    expect(hasFutureCandles(future, at(10))).toBe(true);
    const j = await judge(buyLimit, future, 10);
    expect(j.resolution).toBeNull();
    expect(j.evaluation.bars_after_signal).toBe(1);
  });

  it("expires a filled plan at the last close when the market has been open past its lifetime but the data lags", async () => {
    const bars: Candle[] = [candle(stamp(1), 150.3, 149.9)];
    for (let h = 2; h < 480; h++) bars.push(candle(stamp(h), 150.9, 150.2, 150.5, 150.7));
    const j = await judge(buyLimit, bars, 21 * 24);
    expect(j.resolution).toBe("expired");
    expect(j.outcome_price).toBe(150.7);
    expect(j.evaluation.resolved_at).toBe(iso(21 * 24));
  });

  it("does not judge from a window that starts after the signal", async () => {
    const late = [candle(stamp(700), 150.3, 149.9), candle(stamp(701), 152.3, 150.4)];
    const j = await judge(buyLimit, late, 702);
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.reason).toBe("no_data");
    expect(j.evaluation.window_covers_signal).toBe(false);

    const young: OpenRow = { ...buyLimit, interval: "1day" }; // 30-day entry window still open
    const pending = await judge(young, late, 702);
    expect(pending.resolution).toBeNull();
    expect(pending.evaluation.note).toBe("window_short");
  });

  it("carries a fill established by an earlier run when the window no longer reaches the signal", async () => {
    const earlier = await judge(buyLimit, [candle(stamp(1), 150.3, 149.9)], 2);
    expect(earlier.evaluation.filled_at).toBe(iso(1));
    const later = await judge(
      { ...buyLimit, evaluation: earlier.evaluation },
      [candle(stamp(300), 150.8, 150.2), candle(stamp(301), 152.3, 150.4)],
      302,
    );
    expect(later.resolution).toBe("win");
    expect(later.evaluation.filled_at).toBe(iso(1));
  });

  it("keeps a compact path around the plan's life and marks a contradictory plan", async () => {
    const many: Candle[] = [];
    for (let h = -20; h < 200; h++) many.push(candle(stamp(h), 150.6 + (h % 3) * 0.01, 150.2, 150.4, 150.5));
    const j = await judge(buyLimit, many, 210);
    expect(j.evaluation.path.length).toBeLessThanOrEqual(60);
    expect(Date.parse(j.evaluation.path[0].t)).toBeLessThan(at(0));

    // Fill at h=2, TP1 at h=3: the stored path ends a few bars after
    const short = [...quietHours(-20, 2), candle(stamp(2), 150.3, 149.9), candle(stamp(3), 152.3, 150.4), ...quietHours(4, 40)];
    const k = await judge(buyLimit, short, 40);
    expect(k.resolution).toBe("win");
    expect(k.evaluation.path[0].t).toBe(iso(-8));
    expect(k.evaluation.path.at(-1)?.t).toBe(iso(6));

    const broken: OpenRow = { ...buyLimit, stop_loss: 151 }; // SL above a BUY entry
    expect(isCoherentPlan(broken)).toBe(false);
    const jb = await judge(broken, many.slice(20, 30));
    expect(jb.resolution).toBe("ambiguous");
    expect(jb.evaluation.reason).toBe("incoherent");
  });

  it("stampOnly keeps the earlier evidence and records why nothing was judged", async () => {
    const earlier = await judge(buyLimit, [candle(stamp(1), 150.3, 149.9)], 2);
    const stamped = stampOnly({ ...buyLimit, evaluation: earlier.evaluation }, "15min", at(3), "future_candles");
    expect(stamped.filled_at).toBe(iso(1));
    expect(stamped.checked_at).toBe(iso(3));
    expect(stamped.note).toBe("future_candles");
    expect(stampOnly(buyLimit, "15min", at(3), "no_data").path).toEqual([]);
  });
});

describe("configuration", () => {
  it("fetches enough bars to reach back to the oldest plan that can still be open", () => {
    for (const interval of Object.keys(EXPIRY_DAYS)) {
      const evalInterval = EVAL_INTERVAL[interval];
      const covered = EVAL_OUTPUTSIZE[evalInterval] * INTERVAL_MS[evalInterval] * (7 / 5); // weekends have no bars
      expect(covered, interval).toBeGreaterThanOrEqual(EXPIRY_DAYS[interval] * DAY + 2 * DAY);
    }
  });

  it("re-checks 15min plans on every sweep tick", () => {
    expect(CHECK_EVERY_MS["15min"] - 60_000).toBeLessThanOrEqual(15 * 60_000);
  });

  it("the client's view of the evidence matches what the tracker writes", () => {
    expectTypeOf<Evaluation>().toMatchTypeOf<OutcomeEvaluation>();
    expectTypeOf<keyof Evaluation>().toEqualTypeOf<keyof OutcomeEvaluation>();
    expectTypeOf<Reason>().toEqualTypeOf<OutcomeReason>();
  });
});

describe("downsamplePath", () => {
  it("merges neighbouring bars keeping the true high and low", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 120; i++) bars.push(candle(stamp(i), 100 + i, 90 - i, 95, 96));
    const path = downsamplePath(bars, 60);
    expect(path.length).toBe(60);
    expect(path[0]).toEqual({ t: iso(0), o: 95, h: 101, l: 89, c: 96 });
  });

  it("passes short series through unchanged", () => {
    expect(downsamplePath([candle(stamp(0), 101, 99)], 60)).toHaveLength(1);
  });
});

describe("isDue", () => {
  const evaluated = (checkedAgoMs: number, nowMs: number): Evaluation =>
    ({ checked_at: new Date(nowMs - checkedAgoMs).toISOString() }) as Evaluation;

  it("is due when never checked", () => {
    expect(isDue({ interval: "1h", evaluation: null }, at(5))).toBe(true);
  });

  it("re-checks a 1h plan hourly and a 1day plan every four hours", () => {
    const now = at(5);
    expect(isDue({ interval: "1h", evaluation: evaluated(30 * 60_000, now) }, now)).toBe(false);
    expect(isDue({ interval: "1h", evaluation: evaluated(59.5 * 60_000, now) }, now)).toBe(true);
    expect(isDue({ interval: "1day", evaluation: evaluated(3 * HOUR, now) }, now)).toBe(false);
    expect(isDue({ interval: "1day", evaluation: evaluated(4 * HOUR, now) }, now)).toBe(true);
  });

  it("brings a plan waiting on a bar to close back after one evaluation bar, not a whole cadence", () => {
    const now = at(5);
    const waiting = (checkedAgoMs: number, flags: Partial<Evaluation>, evalInterval = "1h"): Evaluation =>
      ({ ...evaluated(checkedAgoMs, now), eval_interval: evalInterval, ...flags }) as Evaluation;
    expect(isDue({ interval: "1day", evaluation: waiting(59.5 * 60_000, { refine_pending: true }) }, now)).toBe(true);
    expect(isDue({ interval: "1day", evaluation: waiting(30 * 60_000, { refine_pending: true }) }, now)).toBe(false);
    expect(isDue({ interval: "4h", evaluation: waiting(59.5 * 60_000, { signal_bar_pending: true }) }, now)).toBe(true);
    expect(isDue({ interval: "1h", evaluation: waiting(14.5 * 60_000, { signal_bar_pending: true }, "15min") }, now)).toBe(true);
    // a plan that is not waiting keeps its cadence
    expect(isDue({ interval: "1day", evaluation: waiting(59.5 * 60_000, {}) }, now)).toBe(false);
    // and never waits longer than the cadence itself
    expect(isDue({ interval: "15min", evaluation: waiting(14.5 * 60_000, { refine_pending: true }) }, now)).toBe(true);
  });
});

describe("parseCandleTime", () => {
  it("reads intraday bars as UTC", () => {
    expect(parseCandleTime("2026-08-25 12:00:00")).toBe(Date.parse("2026-08-25T12:00:00Z"));
  });

  it("reads daily bars (date only) as UTC midnight", () => {
    expect(parseCandleTime("2026-08-25")).toBe(Date.parse("2026-08-25T00:00:00Z"));
  });

  it("passes through an already-ISO string", () => {
    expect(parseCandleTime("2026-08-25T12:00:00Z")).toBe(Date.parse("2026-08-25T12:00:00Z"));
  });

  it("is NaN for empty input", () => {
    expect(Number.isNaN(parseCandleTime(""))).toBe(true);
  });
});

describe("the refinement ladder", () => {
  it("has a rung below 15min, because 15min and 1h plans are judged on 15min bars", () => {
    // EVAL_INTERVAL puts both on 15min, so `bar.ms > REFINE_MS` was false and
    // their signal bar could never be split. Under a contract where every plan
    // fills at bar zero, that turns a graze into a terminal, unscored result.
    expect(finerRung(HOUR)).toEqual({ interval: "15min", ms: 15 * 60_000 });
    expect(finerRung(15 * 60_000)).toEqual({ interval: "5min", ms: 5 * 60_000 });
    // and it stops rather than asking for a rung the same size as the bar
    expect(finerRung(5 * 60_000)).toBeNull();
  });

  it("does not let price from before the plan existed resolve it", async () => {
    // The signal lands half way through its bar. The first half of that hour
    // dipped through the stop — but the plan did not exist yet, so it cannot
    // have been stopped there.
    const created = at(0) + 30 * 60_000;
    const row: OpenRow = {
      ...buyLimit,
      created_at: new Date(created).toISOString(),
      entry_point: 150, stop_loss: 149.5, take_profit_1: 151,
      take_profit_2: null, take_profit_3: null,
      price_at_signal: 150, // a market order
    };
    const asked: string[] = [];
    const fetchFine: FineFetcher = async (_p, from, _to, interval) => {
      asked.push(interval);
      const t = (m: number) => new Date(from + m * 60_000).toISOString().slice(0, 19).replace("T", " ");
      return mid([
        candle(t(0), 150.0, 149.0),   // before the signal: through the stop
        candle(t(15), 150.1, 149.6),  // still before
        candle(t(30), 151.2, 150.0),  // the signal bar onwards: to the target
        candle(t(45), 151.3, 151.0),
      ]);
    };
    const j = await judge(row, [
      candle(stamp(0), 151.2, 149.0),
      candle(stamp(1), 151.4, 151.0),
    ], 5, "1h", fetchFine);
    expect(asked[0]).toBe("15min");
    // the pre-signal dip is discarded, so this is not a loss
    expect(j.resolution).not.toBe("loss");
    // and the sub-bar straddling the signal goes with it: its low is the
    // pre-signal extreme, and keeping it would re-admit exactly what the
    // filter exists to exclude
    expect(j.evaluation.first_candle_at === null || Date.parse(j.evaluation.first_candle_at) >= created).toBe(true);
  });
});

// --- the finer bars come from the same feed as the coarse ones --------------
// A bid/ask series split with mid sub-bars from another provider misses the
// very touches it was adopted to see: a stop grazed on the bid by less than
// the spread is invisible on the mid. So the judge asks for sub-bars on the
// coarse series' own basis and refuses any other.

describe("judgePlan — refinement on the coarse series' own basis", () => {
  // Two-sided bars around a mid shape, `half` a spread each side of it
  const quoted = (ms: number, high: number, low: number, close: number, half = 0.005): QuoteCandle => ({
    datetime: new Date(ms).toISOString(),
    bid: { datetime: new Date(ms).toISOString(), open: close - half, high: high - half, low: low - half, close: close - half },
    ask: { datetime: new Date(ms).toISOString(), open: close + half, high: high + half, low: low + half, close: close + half },
  });
  const quotes = (bars: QuoteCandle[]): FineResult => ({ basis: "quotes", bars });
  const MIN = 60_000;

  // BUY limit at 150 (SL 149, TP1 152): quiet signal bar, a fill in hour 1,
  // then an hour whose bid spans both levels
  const coarse: QuoteCandle[] = [
    quoted(at(0), 150.7, 150.3, 150.5),
    quoted(at(1), 150.3, 149.9, 150.1),
    quoted(at(2), 152.5, 148.5, 150.2),
  ];
  // Inside that hour: the 02:15 bar's mid low is 149.004, four tenths of a
  // pip above the stop, and its bid — the side a BUY is closed on — is half
  // a pip lower still, at 148.999. Only the bid reached the stop. The target
  // follows at 02:30.
  const fineShape: Array<[number, number, number, number]> = [
    [at(2), 150.6, 150.0, 150.3],
    [at(2) + 15 * MIN, 150.5, 149.004, 149.5],
    [at(2) + 30 * MIN, 152.3, 149.5, 152.0],
  ];
  const fineQuotes = fineShape.map((s) => quoted(...s));
  const fineMid = fineShape.map(([ms, high, low, close]) =>
    candle(new Date(ms).toISOString().slice(0, 19).replace("T", " "), high, low, close, close));

  it("settles a stop the bid alone touched when the sub-bars are bid/ask too", async () => {
    const fetchFine: FineFetcher = async () => quotes(fineQuotes);
    const j = await judgePlan(buyLimit, [], "1h", at(48), fetchFine, coarse);
    expect(j.resolution).toBe("loss");
    expect(j.evaluation.resolved_at).toBe(new Date(at(2) + 15 * MIN).toISOString());
    expect(j.evaluation.refined).toBe(true);
    expect(j.evaluation.refined_interval).toBe("15min");
    expect(j.evaluation.price_basis).toBe("quotes");
  });

  it("treats mid sub-bars under a bid/ask series as a failed attempt, never as a verdict", async () => {
    // The same bars on the mid: no touch at 02:15, the target at 02:30. On
    // that feed the plan is a win, which is the wrong answer — and the
    // judge must not take it
    const fetchFine: FineFetcher = async () => mid(fineMid);
    const j = await judgePlan(buyLimit, [], "1h", at(48), fetchFine, coarse);
    expect(j.resolution).toBeNull();
    expect(j.closed_at).toBeNull();
    expect(j.evaluation.refine_pending).toBe(true);
    expect(j.evaluation.refine_attempts).toBe(1);
    expect(j.evaluation.refined).toBe(false);
    // the fill established before the ambiguous bar is kept
    expect(j.evaluation.filled_at).toBe(iso(1));
  });

  it("asks for sub-bars on the basis the coarse series has", async () => {
    const asked: string[] = [];
    const fetchFine: FineFetcher = async (_pair, _from, _to, _interval, basis) => {
      asked.push(basis);
      return basis === "quotes" ? quotes(fineQuotes) : mid(fineMid);
    };
    await judgePlan(buyLimit, [], "1h", at(48), fetchFine, coarse);
    expect(asked).toEqual(["quotes"]);

    const onMid = [
      candle(stamp(0), 150.7, 150.3),
      candle(stamp(1), 150.3, 149.9),
      candle(stamp(2), 152.5, 148.5),
    ];
    await judgePlan(buyLimit, onMid, "1h", at(48), fetchFine);
    expect(asked).toEqual(["quotes", "mid"]);
  });

  it("records the spread of the sub-bar that decided the exit, not the coarse bar's", async () => {
    // The deciding sub-bar is quoted three pips wide; the coarse bar around
    // it, and the fill bar, one pip
    const wide = fineShape.map((s, i) => quoted(...s, i === 1 ? 0.015 : 0.005));
    const fetchFine: FineFetcher = async () => quotes(wide);
    const j = await judgePlan(buyLimit, [], "1h", at(48), fetchFine, coarse);
    expect(j.resolution).toBe("loss");
    expect(j.evaluation.spread_at_exit).toBeCloseTo(0.03, 6);
    // the fill was decided on a coarse bar, so its spread is that bar's
    expect(j.evaluation.spread_at_fill).toBeCloseTo(0.01, 6);
  });

  it("reads the spread off the finest bar containing the instant when refinement nests", async () => {
    // A 4h plan is judged on 1h bars, so its signal bar splits to 15min and
    // a 15min sub-bar that spans both levels splits again to 5min. The exit
    // is decided on a 5min bar quoted three pips wide, the fill on a 15min
    // sub-bar quoted two, the coarse bars one.
    const created = at(0) + 5 * MIN;
    const row: OpenRow = { ...buyLimit, interval: "4h", created_at: new Date(created).toISOString() };
    const hours: QuoteCandle[] = [
      // the signal hour reaches the entry and both levels, closing back above
      quoted(at(0), 152.6, 148.4, 150.4),
      quoted(at(1), 150.7, 150.3, 150.5),
      quoted(at(2), 150.7, 150.3, 150.5),
    ];
    const fifteen: QuoteCandle[] = [
      quoted(at(0), 150.7, 150.3, 150.5, 0.01),
      quoted(at(0) + 15 * MIN, 150.3, 149.9, 150.0, 0.01), // fills the limit
      quoted(at(0) + 30 * MIN, 152.6, 148.4, 150.2, 0.01), // spans both levels
      quoted(at(0) + 45 * MIN, 150.7, 150.3, 150.5, 0.01),
    ];
    const five: QuoteCandle[] = [
      quoted(at(0) + 30 * MIN, 150.6, 150.0, 150.3, 0.015),
      quoted(at(0) + 35 * MIN, 150.5, 148.9, 149.5, 0.015), // the stop, first
      quoted(at(0) + 40 * MIN, 152.6, 149.5, 152.0, 0.015),
    ];
    const asked: string[] = [];
    const fetchFine: FineFetcher = async (_pair, _from, _to, interval) => {
      asked.push(interval);
      return quotes(interval === "15min" ? fifteen : five);
    };
    const j = await judgePlan(row, [], "1h", at(48), fetchFine, hours);
    expect(asked).toEqual(["15min", "5min"]);
    expect(j.resolution).toBe("loss");
    expect(j.evaluation.resolved_at).toBe(new Date(at(0) + 35 * MIN).toISOString());
    expect(j.evaluation.refined_interval).toBe("5min");
    expect(j.evaluation.filled_at).toBe(new Date(at(0) + 15 * MIN).toISOString());
    expect(j.evaluation.spread_at_exit).toBeCloseTo(0.03, 6);
    expect(j.evaluation.spread_at_fill).toBeCloseTo(0.02, 6);
  });

  it("waits for a forming bar to complete rather than splitting it", async () => {
    // Judged half an hour into the bar that spans both levels: its sub-bars
    // are not all there yet, and the ones that are could show neither touch
    // and be read as a conflict between feeds
    let calls = 0;
    const fetchFine: FineFetcher = async () => {
      calls++;
      return quotes(fineQuotes);
    };
    const j = await judgePlan(buyLimit, [], "1h", at(2) + 30 * MIN, fetchFine, coarse);
    expect(calls).toBe(0);
    expect(j.resolution).toBeNull();
    expect(j.evaluation.refine_pending).toBe(true);
    expect(j.evaluation.refine_attempts).toBe(0);
    expect(j.evaluation.filled_at).toBe(iso(1));
    // once the bar has closed the same sub-bars settle it
    const later = await judgePlan(buyLimit, [], "1h", at(3), fetchFine, coarse);
    expect(calls).toBe(1);
    expect(later.resolution).toBe("loss");
  });

  it("reads a market fill's spread off the coarse signal bar the fill was priced from", async () => {
    // The sub-bar around the signal instant is dropped by the splice, so no
    // fine bar contains the fill; the bar BEFORE the signal bar must not be
    // read in its place
    const created = at(0) + 22 * MIN;
    const market: OpenRow = { ...buyLimit, entry_point: 150.5, created_at: new Date(created).toISOString() };
    const hours: QuoteCandle[] = [
      quoted(at(-1), 150.7, 150.3, 150.5, 0.005), // one pip wide
      quoted(at(0), 152.6, 150.2, 150.9, 0.02), // four pips wide; reaches the target
      quoted(at(1), 150.7, 150.3, 150.5, 0.005),
    ];
    const fifteen: QuoteCandle[] = [
      quoted(at(0), 150.7, 150.3, 150.5, 0.02),
      quoted(at(0) + 15 * MIN, 150.8, 150.4, 150.6, 0.02), // holds the signal; dropped
      quoted(at(0) + 30 * MIN, 152.6, 150.5, 152.0, 0.03), // the target
      quoted(at(0) + 45 * MIN, 151.0, 150.6, 150.9, 0.02),
    ];
    const fetchFine: FineFetcher = async () => quotes(fifteen);
    const j = await judgePlan(market, [], "1h", at(48), fetchFine, hours);
    expect(j.evaluation.order_type).toBe("market");
    expect(j.resolution).toBe("win");
    expect(j.evaluation.resolved_at).toBe(new Date(at(0) + 30 * MIN).toISOString());
    expect(j.evaluation.spread_at_fill).toBeCloseTo(0.04, 6);
    expect(j.evaluation.spread_at_exit).toBeCloseTo(0.06, 6);
  });

  // --- the signal bar was still forming at the first sweep --------------
  // Under market_v1 the trade is open from the signal instant, and with the
  // cron at :03/:18/:33/:48 a 1h signal bar has not closed at the first sweep
  // for about four plans in five.
  const marketBuy: OpenRow = { ...buyLimit, interval: "4h", entry_point: 150.5, created_at: new Date(at(2) + 10 * MIN).toISOString() };
  const quietHours: QuoteCandle[] = [quoted(at(0), 150.7, 150.3, 150.5), quoted(at(1), 150.7, 150.3, 150.5)];
  // The signal hour as the tape showed it at 02:18 (quiet), at 02:33 (the
  // stop already reached), and as it closed; then the hour that reaches the
  // target
  const signalQuiet = quoted(at(2), 150.8, 149.9, 150.4);
  const signalGrazing = quoted(at(2), 150.8, 148.9, 149.4);
  const signalClosed = quoted(at(2), 150.8, 148.9, 150.2);
  const nextHour = quoted(at(3), 152.4, 150.2, 152.3);
  const subBars: QuoteCandle[] = [
    quoted(at(2), 150.8, 150.2, 150.5),
    quoted(at(2) + 15 * MIN, 150.6, 150.0, 150.3),
    quoted(at(2) + 30 * MIN, 150.4, 148.9, 149.4), // the stop
    quoted(at(2) + 45 * MIN, 150.3, 149.6, 150.2),
  ];

  it("does not split a forming signal bar; once it has closed the next sweep reaches the single-sweep verdict", async () => {
    let calls = 0;
    const fetchFine: FineFetcher = async () => {
      calls++;
      return quotes(subBars);
    };
    const first = await judgePlan(marketBuy, [], "1h", at(2) + 33 * MIN, fetchFine, [...quietHours, signalGrazing]);
    expect(calls).toBe(0);
    expect(first.resolution).toBeNull();
    expect(first.evaluation.refine_pending).toBe(true);
    expect(first.evaluation.refine_attempts).toBe(0);
    expect(first.evaluation.signal_bar_pending).toBe(true);
    expect(first.evaluation.filled_at).toBe(new Date(at(2) + 10 * MIN).toISOString());

    const closed = [...quietHours, signalClosed, nextHour];
    const second = await judgePlan({ ...marketBuy, evaluation: first.evaluation }, [], "1h", at(3) + 3 * MIN, fetchFine, closed);
    const single = await judgePlan(marketBuy, [], "1h", at(3) + 3 * MIN, fetchFine, closed);
    expect(second.resolution).toBe("loss");
    expect(second.evaluation.resolved_at).toBe(new Date(at(2) + 30 * MIN).toISOString());
    expect(second.evaluation.resolved_at).toBe(single.evaluation.resolved_at);
    expect(second.evaluation.filled_at).toBe(single.evaluation.filled_at);
  });

  it("looks at a signal bar that was still forming again once it has closed, even when it was quiet", async () => {
    // Sweep one, eight minutes after the signal: nothing has happened yet.
    // The stop is reached at 02:40. A second sweep that started at the bars
    // AFTER the fill never saw it and scored the target at 03:00 instead.
    const fetchFine: FineFetcher = async () => quotes(subBars);
    const first = await judgePlan(marketBuy, [], "1h", at(2) + 18 * MIN, fetchFine, [...quietHours, signalQuiet]);
    expect(first.resolution).toBeNull();
    expect(first.evaluation.refine_pending).toBe(false);
    expect(first.evaluation.signal_bar_pending).toBe(true);
    expect(first.evaluation.filled_at).toBe(new Date(at(2) + 10 * MIN).toISOString());

    const second = await judgePlan({ ...marketBuy, evaluation: first.evaluation }, [], "1h", at(3) + 3 * MIN, fetchFine, [...quietHours, signalClosed, nextHour]);
    expect(second.resolution).toBe("loss");
    expect(second.evaluation.resolved_at).toBe(new Date(at(2) + 30 * MIN).toISOString());
    expect(second.evaluation.filled_at).toBe(new Date(at(2) + 10 * MIN).toISOString());
  });

  it("keeps the signal bar pending while no later bar follows it on the tape", async () => {
    const fetchFine: FineFetcher = async () => quotes(subBars);
    const first = await judgePlan(marketBuy, [], "1h", at(2) + 18 * MIN, fetchFine, [...quietHours, signalQuiet]);
    expect(first.evaluation.signal_bar_pending).toBe(true);
    // Sweep two, three minutes past the hour by the clock — and the feed
    // still serves the bar part-formed, with nothing after it
    const second = await judgePlan({ ...marketBuy, evaluation: first.evaluation }, [], "1h", at(3) + 3 * MIN, fetchFine, [...quietHours, signalQuiet]);
    expect(second.resolution).toBeNull();
    expect(second.evaluation.signal_bar_pending).toBe(true);
    // Sweep three sees the bar as it closed, and the stop it reached
    const third = await judgePlan({ ...marketBuy, evaluation: second.evaluation }, [], "1h", at(3) + 18 * MIN, fetchFine, [...quietHours, signalClosed, nextHour]);
    expect(third.resolution).toBe("loss");
    expect(third.evaluation.resolved_at).toBe(new Date(at(2) + 30 * MIN).toISOString());
  });

  it("goes back for a signal bar the feed had not emitted at the first sweep", async () => {
    const fetchFine: FineFetcher = async () => quotes(subBars);
    // A minute after the signal the newest bar on the tape is the one before
    const first = await judgePlan(marketBuy, [], "1h", at(2) + 11 * MIN, fetchFine, quietHours);
    expect(first.evaluation.filled_at).toBe(new Date(at(2) + 10 * MIN).toISOString());
    expect(first.evaluation.signal_bar_pending).toBe(true);
    const later = [...quietHours, signalClosed, nextHour];
    const second = await judgePlan({ ...marketBuy, evaluation: first.evaluation }, [], "1h", at(3) + 3 * MIN, fetchFine, later);
    const single = await judgePlan(marketBuy, [], "1h", at(3) + 3 * MIN, fetchFine, later);
    expect(second.resolution).toBe("loss");
    expect(second.evaluation.resolved_at).toBe(single.evaluation.resolved_at);
    // priced off the bar once it was on the tape, not the plan's own number
    expect(second.evaluation.fill_price).toBe(single.evaluation.fill_price);
  });

  // --- a limit order's fill established while its bar was forming ----------
  // Under market_v1 every plan is a market order; these guard the legacy
  // contract, whose fill is proved by a close and dated only to the bar.
  const limitRow: OpenRow = { ...buyLimit, interval: "4h", created_at: new Date(at(2) + 10 * MIN).toISOString() };

  it("re-derives a limit fill from the sub-bars, so a level reached before the entry is a miss, not a trade", async () => {
    // Sweep one, mid-bar: the live close has crossed the entry, so the fill
    // is certain — but only "somewhere in the bar". The sub-bars date it to
    // 02:30, after the target was reached at 02:15 with the entry untouched:
    // the order was not in when the level was hit.
    const forming = quoted(at(2), 152.3, 149.9, 149.9);
    const closed = quoted(at(2), 152.3, 149.9, 150.4);
    const subs: QuoteCandle[] = [
      quoted(at(2), 150.6, 150.3, 150.5),
      quoted(at(2) + 15 * MIN, 152.3, 150.4, 151.0), // the target, entry untouched
      quoted(at(2) + 30 * MIN, 150.6, 149.9, 150.1), // the entry
      quoted(at(2) + 45 * MIN, 150.6, 150.2, 150.4),
    ];
    const fetchFine: FineFetcher = async () => quotes(subs);
    const first = await judgePlan(limitRow, [], "1h", at(2) + 35 * MIN, fetchFine, [...quietHours, forming]);
    expect(first.evaluation.filled_at).toBe(new Date(at(2) + 10 * MIN).toISOString());
    expect(first.evaluation.signal_bar_pending).toBe(true);
    const later = [...quietHours, closed, quoted(at(3), 150.7, 150.3, 150.5)];
    const second = await judgePlan({ ...limitRow, evaluation: first.evaluation }, [], "1h", at(3) + 3 * MIN, fetchFine, later);
    const single = await judgePlan(limitRow, [], "1h", at(3) + 3 * MIN, fetchFine, later);
    expect(single.resolution).toBe("untriggered");
    expect(second.resolution).toBe(single.resolution);
    expect(second.evaluation.reason).toBe(single.evaluation.reason);
    expect(second.evaluation.filled_at).toBe(single.evaluation.filled_at);
  });

  it("dates a re-derived limit fill to the sub-bar that reached the entry and starts its excursions there", async () => {
    const forming = quoted(at(2), 151.5, 149.9, 149.9);
    const closed = quoted(at(2), 151.5, 148.9, 149.4);
    const subs: QuoteCandle[] = [
      quoted(at(2), 150.6, 150.3, 150.5),
      quoted(at(2) + 15 * MIN, 151.5, 150.4, 151.0), // favourable, entry untouched
      quoted(at(2) + 30 * MIN, 150.6, 149.9, 150.1), // the entry
      quoted(at(2) + 45 * MIN, 150.2, 148.9, 149.4), // the stop
    ];
    const fetchFine: FineFetcher = async () => quotes(subs);
    const first = await judgePlan(limitRow, [], "1h", at(2) + 35 * MIN, fetchFine, [...quietHours, forming]);
    expect(first.evaluation.signal_bar_pending).toBe(true);
    const later = [...quietHours, closed, quoted(at(3), 150.7, 150.3, 150.5)];
    const second = await judgePlan({ ...limitRow, evaluation: first.evaluation }, [], "1h", at(3) + 3 * MIN, fetchFine, later);
    const single = await judgePlan(limitRow, [], "1h", at(3) + 3 * MIN, fetchFine, later);
    expect(single.resolution).toBe("loss");
    expect(single.evaluation.filled_at).toBe(new Date(at(2) + 30 * MIN).toISOString());
    expect(second.resolution).toBe("loss");
    expect(second.evaluation.filled_at).toBe(single.evaluation.filled_at);
    expect(second.evaluation.mfe).toBe(single.evaluation.mfe);
    expect(second.evaluation.mae).toBe(single.evaluation.mae);
  });

  it("re-admits the open-through rule from the end of the bar that held a limit fill, not a bar past the fill instant", async () => {
    // The closed signal bar is quiet and shows the crossing; the next bar
    // opens beyond the target while spanning both levels. A single sweep
    // decides it by its open, and a re-judge must too.
    const forming = quoted(at(2), 150.6, 149.9, 149.9);
    const closed = quoted(at(2), 150.6, 149.9, 149.95);
    const gapBar = quoted(at(3), 152.5, 148.5, 152.3);
    const first = await judgePlan(limitRow, [], "1h", at(2) + 35 * MIN, async () => null, [...quietHours, forming]);
    expect(first.evaluation.filled_at).toBe(new Date(at(2) + 10 * MIN).toISOString());
    const later = [...quietHours, closed, gapBar];
    const second = await judgePlan({ ...limitRow, evaluation: first.evaluation }, [], "1h", at(4) + 3 * MIN, async () => null, later);
    const single = await judgePlan(limitRow, [], "1h", at(4) + 3 * MIN, async () => null, later);
    expect(single.resolution).toBe("win");
    expect(second.resolution).toBe("win");
    expect(second.evaluation.resolved_at).toBe(single.evaluation.resolved_at);
  });

  // --- instants no bar contains ------------------------------------------

  it("records no exit spread for a settlement nothing priced", async () => {
    // Three sweeps with no sub-bars to be had: a terminal unknown, no exit
    let ev: Evaluation | null = null;
    for (let i = 0; i < 3; i++) {
      const j = await judgePlan({ ...buyLimit, evaluation: ev }, [], "1h", at(48), async () => null, coarse);
      ev = j.evaluation;
    }
    expect(ev?.resolution).toBe("ambiguous");
    expect(ev?.reason).toBe("no_data");
    expect(ev?.spread_at_exit).toBeNull();
  });

  it("prices an expiry's spread off the last bar the sweep held, the bar whose close priced the exit", async () => {
    // A 15min plan lives five market days (480 bars). 479 quiet bars fall
    // one short of that on bar time, and the sweep runs an hour after the
    // last one closed: the wall time since then carries the plan over the
    // line, so the expiry is stamped with the sweep's own time, which no bar
    // contains.
    const bars: QuoteCandle[] = [];
    for (let t = at(0); bars.length < 479; t += 15 * MIN) {
      if (!isMarketClosed(t)) bars.push(quoted(t, 150.7, 150.3, 150.5));
    }
    const last = Date.parse(bars[bars.length - 1].datetime);
    const plan: OpenRow = { ...buyLimit, interval: "15min", entry_point: 150.5 };
    const j = await judgePlan(plan, [], "15min", last + 15 * MIN + HOUR, async () => null, bars);
    expect(j.resolution).toBe("expired");
    expect(j.evaluation.resolved_at).toBe(j.evaluation.checked_at);
    // closed on the bid, the side a BUY leaves on
    expect(j.outcome_price).toBeCloseTo(150.5 - 0.005, 6);
    expect(j.evaluation.spread_at_exit).toBeCloseTo(0.01, 6);
  });

  it("prices a fill made inside a gap off the first bar after it", async () => {
    // No bar contains the signal instant; the market order was priced off
    // the first bar's open
    const created = at(0) + 5 * MIN;
    const plan: OpenRow = { ...buyLimit, entry_point: 150.5, created_at: new Date(created).toISOString() };
    const bars: QuoteCandle[] = [quoted(at(1), 150.7, 150.3, 150.5, 0.02), quoted(at(2), 152.4, 150.4, 152.0, 0.005)];
    const j = await judgePlan(plan, [], "1h", at(3), async () => null, bars);
    expect(j.evaluation.filled_at).toBe(new Date(created).toISOString());
    expect(j.resolution).toBe("win");
    expect(j.evaluation.spread_at_fill).toBeCloseTo(0.04, 6);
  });
});
