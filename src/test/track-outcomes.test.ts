import { describe, it, expect } from "vitest";
import {
  classifyOrder,
  downsamplePath,
  hasFutureCandles,
  isCoherentPlan,
  isDue,
  judgePlan,
  parseCandleTime,
  type Evaluation,
  type OpenRow,
} from "../../supabase/functions/track-outcomes/evaluate.ts";
import type { Candle } from "../../supabase/functions/analyze/indicators.ts";

const candle = (datetime: string, high: number, low: number, open?: number, close?: number): Candle => ({
  datetime,
  open: open ?? (high + low) / 2,
  high,
  low,
  close: close ?? (high + low) / 2,
});

const T0 = "2026-08-20T00:00:00Z";
const HOUR = 3_600_000;
const at = (hours: number) => Date.parse(T0) + hours * HOUR;
// "YYYY-MM-DD HH:mm:ss" the way Twelve Data writes it, hours after T0
const stamp = (hours: number) => new Date(at(hours)).toISOString().slice(0, 19).replace("T", " ");

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

const judge = (row: OpenRow, candles: Candle[], nowHours = 48, evalInterval = "15min", fetchFine?: Parameters<typeof judgePlan>[4]) =>
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
    expect(j.evaluation.filled_at).toBe(new Date(at(2)).toISOString());
    expect(j.evaluation.resolved_at).toBe(new Date(at(3)).toISOString());
    expect(j.closed_at).toBe(new Date(at(3)).toISOString());
    expect(j.evaluation.order_type).toBe("limit");
    expect(j.evaluation.tps_hit).toEqual([1]);
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

  it("stays open while unfilled inside the entry window, then expires as no_fill", async () => {
    const quiet = [candle(stamp(0), 150.7, 150.3), candle(stamp(1), 150.8, 150.4)];
    const open = await judge(buyLimit, quiet, 10);
    expect(open.resolution).toBeNull();
    expect(open.closed_at).toBeNull();

    const stale = await judge(buyLimit, quiet, 49); // 1h plans get 48h to fill
    expect(stale.resolution).toBe("untriggered");
    expect(stale.evaluation.reason).toBe("no_fill");
  });

  it("fills a market-priced entry at signal time", async () => {
    const market: OpenRow = { ...buyLimit, price_at_signal: 150.01 };
    const j = await judge(market, [candle(stamp(1), 152.2, 150.3)]);
    expect(j.evaluation.order_type).toBe("market");
    expect(j.evaluation.filled_at).toBe(new Date(at(0)).toISOString());
    expect(j.resolution).toBe("win");
  });

  it("mirrors everything for SELL", async () => {
    // SELL limit: market 149.5, entry above at 150, SL 151, TP1 148
    const sell: OpenRow = { ...buyLimit, signal: "SELL", entry_point: 150, stop_loss: 151, take_profit_1: 148, take_profit_2: 147, take_profit_3: 146, price_at_signal: 149.5 };
    const j = await judge(sell, [
      candle(stamp(1), 150.1, 149.4), // fills
      candle(stamp(2), 149.8, 147.9), // TP1
    ]);
    expect(j.resolution).toBe("win");
    expect(j.evaluation.order_type).toBe("limit");
  });

  it("uses the first post-signal open as the reference when price_at_signal is missing", async () => {
    const legacy: OpenRow = { ...buyLimit, price_at_signal: null };
    const j = await judge(legacy, [candle(stamp(1), 150.9, 150.3, 150.6, 150.5), candle(stamp(2), 150.2, 149.9), candle(stamp(3), 152.4, 150.5)]);
    expect(j.evaluation.order_type).toBe("limit");
    expect(j.resolution).toBe("win");
  });

  it("prefers the close of the bar containing the signal as the legacy reference", async () => {
    // Signal at 00:00 inside the 23:00–00:00 bar (1h eval): its close of 149.7
    // puts a 150 entry above the market (a BUY stop), even though the next
    // bar opens higher
    const legacy: OpenRow = { ...buyLimit, price_at_signal: null };
    const j = await judge(legacy, [
      candle("2026-08-19 23:30:00", 149.8, 149.5, 149.6, 149.7),
      candle(stamp(1), 150.9, 150.3, 150.6, 150.5),
    ], 5, "1h");
    expect(j.evaluation.order_type).toBe("stop");
  });

  it("fills at signal time when the bar containing the signal reached the entry", async () => {
    // Signal at 00:05 inside the 00:00 bar. Market 150.2, entry 150 just
    // below; that bar dipped to 149.98, so the limit order filled right away
    const nearMarket: OpenRow = { ...buyLimit, price_at_signal: 150.2, created_at: "2026-08-20T00:05:00Z" };
    const j = await judge(nearMarket, [
      candle("2026-08-20 00:00:00", 150.3, 149.98),
      candle("2026-08-20 00:15:00", 152.2, 150.3), // TP1 in the next bar, no ambiguity
    ]);
    expect(j.evaluation.order_type).toBe("limit");
    expect(j.evaluation.filled_at).toBe("2026-08-20T00:05:00.000Z");
    expect(j.resolution).toBe("win");
  });

  it("does not treat the signal bar as a fill when it never reached the entry", async () => {
    const nearMarket: OpenRow = { ...buyLimit, price_at_signal: 150.2, created_at: "2026-08-20T00:05:00Z" };
    const j = await judge(nearMarket, [
      candle("2026-08-20 00:00:00", 150.3, 150.1),
      candle("2026-08-20 00:15:00", 152.2, 150.3),
    ]);
    expect(j.resolution).toBe("untriggered");
    expect(j.evaluation.reason).toBe("missed");
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
});

describe("judgePlan — ambiguity and refinement", () => {
  const filledThenSpans = [
    candle(stamp(1), 150.3, 149.9), // fills
    candle(stamp(2), 152.5, 148.5), // spans SL and TP1
  ];

  it("is ambiguous when no finer data can be fetched", async () => {
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
    expect(j.evaluation.resolved_at).toBe(new Date(at(2)).toISOString());
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

  it("expires a filled plan past its lifetime at the last close", async () => {
    const j = await judge(buyLimit, [candle(stamp(1), 150.3, 149.9), candle(stamp(2), 150.9, 150.2, 150.5, 150.7)], 21 * 24);
    expect(j.resolution).toBe("expired");
    expect(j.outcome_price).toBe(150.7);
  });

  it("keeps a compact path with signal context and marks a contradictory plan", async () => {
    const many: Candle[] = [];
    for (let h = -20; h < 200; h++) many.push(candle(stamp(h), 150.6 + (h % 3) * 0.01, 150.2, 150.4, 150.5));
    const j = await judge(buyLimit, many, 210);
    expect(j.evaluation.path.length).toBeLessThanOrEqual(60);
    expect(Date.parse(j.evaluation.path[0].t)).toBeLessThan(at(0));

    const broken: OpenRow = { ...buyLimit, stop_loss: 151 }; // SL above a BUY entry
    expect(isCoherentPlan(broken)).toBe(false);
    const jb = await judge(broken, many.slice(20, 30));
    expect(jb.resolution).toBe("ambiguous");
    expect(jb.evaluation.reason).toBe("incoherent");
  });
});

describe("downsamplePath", () => {
  it("merges neighbouring bars keeping the true high and low", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 120; i++) bars.push(candle(stamp(i), 100 + i, 90 - i, 95, 96));
    const path = downsamplePath(bars, 60);
    expect(path.length).toBe(60);
    expect(path[0]).toEqual({ t: new Date(at(0)).toISOString(), o: 95, h: 101, l: 89, c: 96 });
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
