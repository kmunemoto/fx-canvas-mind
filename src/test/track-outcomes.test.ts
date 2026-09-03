import { describe, it, expect, expectTypeOf } from "vitest";
import {
  CHECK_EVERY_MS,
  EVAL_INTERVAL,
  EVAL_OUTPUTSIZE,
  EXPIRY_DAYS,
  INTERVAL_MS,
  classifyOrder,
  downsamplePath,
  hasFutureCandles,
  isCoherentPlan,
  isDue,
  judgePlan,
  parseCandleTime,
  stampOnly,
  type Evaluation,
  type OpenRow,
  type Reason,
} from "../../supabase/functions/track-outcomes/evaluate.ts";
import { parseCandles, type Candle } from "../../supabase/functions/analyze/indicators.ts";
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
const judge = (row: OpenRow, candles: Candle[], nowHours = 48, evalInterval = "1h", fetchFine?: Parameters<typeof judgePlan>[4]) =>
  judgePlan(row, candles, evalInterval, at(nowHours), fetchFine);

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
    const fetchFine = async (_pair: string, from: number, to: number) => {
      calls.push([from, to]);
      return [
        candle("2026-08-20 00:00:00", 150.3, 150.1),
        candle("2026-08-20 00:15:00", 150.3, 150.15),
        candle("2026-08-20 00:30:00", 150.2, 149.97),
        candle("2026-08-20 00:45:00", 150.4, 150.1, 150.2, 150.3),
      ];
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
    const fetchFine = async (pair: string, from: number, to: number) => {
      calls.push([pair, from, to]);
      return [
        candle("2026-08-20 02:00:00", 150.6, 150.0),
        candle("2026-08-20 02:15:00", 152.1, 150.5), // TP1 first
        candle("2026-08-20 02:30:00", 151.0, 148.5), // then SL
      ];
    };
    const j = await judge(buyLimit, filledThenSpans, 48, "1h", fetchFine);
    expect(calls).toEqual([["USD/JPY", at(2), at(3)]]);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.refined).toBe(true);
    expect(j.evaluation.resolved_at).toBe("2026-08-20T02:15:00.000Z");
  });

  it("stays ambiguous when the finer bars span both levels too", async () => {
    const fetchFine = async () => [candle("2026-08-20 02:00:00", 152.5, 148.5)];
    const j = await judge(buyLimit, filledThenSpans, 48, "1h", fetchFine);
    expect(j.resolution).toBe("ambiguous");
    expect(j.evaluation.refined).toBe(true);
  });

  it("leaves the plan open when the provider has no finer bars, keeping the fill, and gives up after three tries", async () => {
    const unavailable = async () => null;
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
    const deferred = async () => "deferred" as const;
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
    const fetchFine = async () => [candle("2026-08-20 03:00:00", 150.2, 148.9)];
    const j = await judge(buyLimit, [...filledThenSpans, candle(stamp(3), 150.2, 148.9)], 48, "1h", fetchFine);
    expect(j.resolution).toBeNull();
    expect(j.evaluation.refine_pending).toBe(true);
  });

  it("keeps a filled plan ambiguous when the finer bars contradict the coarse one", async () => {
    const fetchFine = async () => [
      candle("2026-08-20 02:00:00", 150.6, 150.0),
      candle("2026-08-20 02:30:00", 151.0, 149.5),
    ];
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
    const fetchFine = async () => [
      candle("2026-08-20 01:00:00", 150.5, 149.95),
      candle("2026-08-20 01:45:00", 151.0, 150.3),
    ];
    const j = await judge(buyLimit, coarse, 48, "1h", fetchFine);
    expect(j.evaluation.filled_at).toBe("2026-08-20T01:00:00.000Z");
    expect(j.resolution).toBe("loss");
    expect(j.evaluation.resolved_at).toBe(iso(2));
  });

  it("closes a plan as missed when the finer bars show TP1 before the fill", async () => {
    const coarse = [candle(stamp(1), 152.2, 149.95)];
    const fetchFine = async () => [
      candle("2026-08-20 01:00:00", 152.2, 150.8),
      candle("2026-08-20 01:45:00", 150.5, 149.95),
    ];
    const j = await judge(buyLimit, coarse, 48, "1h", fetchFine);
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("missed");
  });

  it("measures the runner on the finer bars after a refined win, not on the whole coarse bar", async () => {
    const coarse = [
      candle(stamp(1), 150.3, 149.9),
      candle(stamp(2), 153.5, 148.5), // TP1, SL and TP2 all inside one hour
    ];
    const fetchFine = async () => [
      candle("2026-08-20 02:00:00", 150.6, 150.0),
      candle("2026-08-20 02:15:00", 152.1, 150.5), // TP1
      candle("2026-08-20 02:30:00", 151.0, 148.5), // back through the entry: runner stopped
      candle("2026-08-20 02:45:00", 153.5, 151.0), // TP2, but after the runner stopped
    ];
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
