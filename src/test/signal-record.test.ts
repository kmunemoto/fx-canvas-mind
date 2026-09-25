import { describe, it, expect } from "vitest";
import { BACKTEST, MIN_FOR_INTERVAL, fillAt, settleEvent, summarize, type OpenEvent } from "../../supabase/functions/signal-alerts/record";
import { HORIZON_BARS } from "../../supabase/functions/analyze/rsisar";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-24T00:00:00Z");
const iso = (i: number) => new Date(T0 + i * M15).toISOString();

// A bar around a mid price, bid 0.01 below and ask 0.01 above
const bar = (i: number, m: { o: number; h: number; l: number; c: number }): QuoteCandle => {
  const side = (s: number) => ({ datetime: iso(i), open: m.o + s, high: m.h + s, low: m.l + s, close: m.c + s });
  return { datetime: iso(i), bid: side(-0.01), ask: side(0.01) };
};
const flat = (i: number, px: number) => bar(i, { o: px, h: px + 0.02, l: px - 0.02, c: px });

// A BUY on the bar that opened at index 0: mid close 100, stop 99.2 (0.8), target 101.2
const buyEvent = (over: Partial<OpenEvent> = {}): OpenEvent => ({
  id: "e1",
  pair: "USD/JPY",
  interval: "15min",
  bar_time: iso(0),
  side: "BUY",
  entry: 100,
  stop: 99.2,
  target: 101.2,
  fill: null,
  ...over,
});
// "now" just after bar k has closed
const after = (k: number) => T0 + (k + 1) * M15 + 60_000;

describe("settling a signal", () => {
  it("a BUY is filled on the ask and wins when the bid reaches the target", () => {
    const q = [flat(0, 100), flat(1, 100.4), bar(2, { o: 100.5, h: 101.3, l: 100.4, c: 101.1 })];
    const s = settleEvent(buyEvent(), q, after(2))!;
    expect(s.outcome).toBe("win");
    expect(s.fill).toBeCloseTo(100.01, 10);
    expect(s.exit_price).toBe(101.2);
    expect(s.bars).toBe(2);
    // (101.2 - 100.01) / 0.8: a little under 1.5R, the spread
    expect(s.r).toBeCloseTo(1.4875, 4);
    expect(s.exit_at).toBe(new Date(T0 + 3 * M15).toISOString());
  });

  it("loses when the bid reaches the stop, and a bar that opens past it fills at its open", () => {
    const q = [flat(0, 100), bar(1, { o: 100, h: 100.1, l: 99.1, c: 99.3 })];
    const loss = settleEvent(buyEvent(), q, after(1))!;
    expect(loss.outcome).toBe("loss");
    expect(loss.exit_price).toBe(99.2);
    expect(loss.r).toBeCloseTo(-1.0125, 4);
    const gap = [flat(0, 100), bar(1, { o: 98.9, h: 99.0, l: 98.8, c: 98.95 })];
    const g = settleEvent(buyEvent(), gap, after(1))!;
    expect(g.outcome).toBe("loss");
    // the bid opened at 98.89, below the stop
    expect(g.exit_price).toBeCloseTo(98.89, 10);
    expect(g.r!).toBeLessThan(-1.3);
  });

  it("a bar that reaches both is counted as a loss", () => {
    const q = [flat(0, 100), bar(1, { o: 100, h: 101.5, l: 99.0, c: 100 })];
    const s = settleEvent(buyEvent(), q, after(1))!;
    expect(s.outcome).toBe("ambiguous");
    expect(s.r!).toBeLessThan(-1);
  });

  it("a SELL is the mirror: filled on the bid, settled on the ask", () => {
    const sell = buyEvent({ side: "SELL", stop: 100.8, target: 98.8 });
    const q = [flat(0, 100), bar(1, { o: 99.9, h: 100, l: 98.7, c: 98.9 })];
    const s = settleEvent(sell, q, after(1))!;
    expect(s.outcome).toBe("win");
    expect(s.fill).toBeCloseTo(99.99, 10);
    // the ask low is 98.71, below 98.8
    expect(s.r).toBeCloseTo((99.99 - 98.8) / 0.8, 4);
  });

  it("stays open until a level is reached or the horizon runs out, then closes at the market", () => {
    const q = [flat(0, 100), ...Array.from({ length: 10 }, (_, k) => flat(k + 1, 100.3))];
    expect(settleEvent(buyEvent(), q, after(10))).toBeNull();
    const long = [flat(0, 100), ...Array.from({ length: HORIZON_BARS + 2 }, (_, k) => flat(k + 1, 100.3))];
    const s = settleEvent(buyEvent(), long, after(HORIZON_BARS + 2))!;
    expect(s.outcome).toBe("expired");
    expect(s.bars).toBe(HORIZON_BARS);
    // sold on the bid, 100.29, bought on the ask, 100.01
    expect(s.r).toBeCloseTo(0.35, 4);
  });

  it("reads only closed bars: the one still forming does not settle anything", () => {
    const q = [flat(0, 100), bar(1, { o: 100, h: 101.5, l: 100, c: 101.4 })];
    // bar 1 has not closed yet
    expect(settleEvent(buyEvent(), q, T0 + M15 + 60_000)).toBeNull();
  });

  it("uses the recorded fill when there is one, and gives up on a bar the feed no longer serves", () => {
    const q = [flat(0, 100), bar(1, { o: 100.5, h: 101.3, l: 100.4, c: 101.1 })];
    expect(settleEvent(buyEvent({ fill: 100.05 }), q, after(1))!.fill).toBe(100.05);
    const later = [flat(5, 100), flat(6, 100.2)];
    expect(settleEvent(buyEvent(), later, after(6))!.outcome).toBe("no_data");
  });

  it("finds the bar by time whatever the timestamp's spelling", () => {
    const q = [flat(0, 100)];
    expect(fillAt(q, "2026-09-24T00:00:00+00:00", "BUY")).toEqual({ fill: 100.01, spread: expect.closeTo(0.02, 10) });
    expect(fillAt(q, "2026-09-24 00:00:00", "SELL")!.fill).toBeCloseTo(99.99, 10);
    expect(fillAt(q, iso(3), "BUY")).toBeNull();
  });
});

describe("the record, summed up", () => {
  it("counts wins, losses (both kinds) and expiries, and leaves the open ones out of the averages", () => {
    const s = summarize([
      { outcome: "win", r: 1.45 },
      { outcome: "loss", r: -1.02 },
      { outcome: "ambiguous", r: -1.1 },
      { outcome: "expired", r: 0.2 },
      { outcome: null, r: null },
      { outcome: "no_data", r: null },
    ]);
    expect(s.n).toBe(4);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(2);
    expect(s.expired).toBe(1);
    expect(s.open).toBe(1);
    expect(s.winRate).toBe(0.25);
    expect(s.meanR).toBeCloseTo((1.45 - 1.02 - 1.1 + 0.2) / 4, 10);
    // too few for an interval
    expect(s.ciR).toBeNull();
  });

  it("gives an interval from ten settled signals on", () => {
    const rows = Array.from({ length: MIN_FOR_INTERVAL }, (_, i) => ({ outcome: i % 3 === 0 ? "win" : "loss", r: i % 3 === 0 ? 1.5 : -1 }));
    const s = summarize(rows);
    expect(s.ciR).not.toBeNull();
    expect(s.ciR!).toBeGreaterThan(0);
    expect(summarize([]).meanR).toBeNull();
  });

  it("the yardstick is the past-chart result the docs record", () => {
    expect(BACKTEST.meanR).toBe(-0.125);
    expect(BACKTEST.breakeven).toBe(0.4);
  });
});
