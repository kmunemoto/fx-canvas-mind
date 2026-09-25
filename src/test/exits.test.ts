import { describe, it, expect } from "vitest";
import { chandelierExit, sarExit, sarStops } from "../../research/exits-lib";
import { psarSeries } from "../../research/indicator-series";
import type { Candle } from "../../supabase/functions/analyze/indicators";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const H = 3_600_000;
const T0 = Date.parse("2026-01-05T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * H).toISOString();

const walk = (n: number, seed: number): Candle[] => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let p = 150;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = o + (rnd() - 0.5) * 0.4;
    out.push({ datetime: stamp(i), open: o, high: Math.max(o, p) + rnd() * 0.1, low: Math.min(o, p) - rnd() * 0.1, close: p });
  }
  return out;
};
const quotes = (c: Candle[], spread = 0.02): QuoteCandle[] =>
  c.map((m) => ({
    datetime: m.datetime,
    bid: { ...m, open: m.open - spread / 2, high: m.high - spread / 2, low: m.low - spread / 2, close: m.close - spread / 2 },
    ask: { ...m, open: m.open + spread / 2, high: m.high + spread / 2, low: m.low + spread / 2, close: m.close + spread / 2 },
  }));

describe("the SAR as a stop", () => {
  const c = walk(3000, 5);
  const stops = sarStops(c);
  const ps = psarSeries(c);

  it("is the study's SAR: the same level on every bar that does not flip, and a flip exactly where it breaks", () => {
    let flips = 0;
    for (let i = 2; i < c.length; i++) {
      if (ps.long[i] === stops.long[i]) {
        expect(stops.level[i], `bar ${i}`).toBeCloseTo(ps.sar[i]!, 10);
      } else {
        flips++;
        // the bar traded through the stop in effect
        if (stops.long[i]) expect(c[i].low).toBeLessThan(stops.level[i]!);
        else expect(c[i].high).toBeGreaterThan(stops.level[i]!);
      }
    }
    expect(flips).toBeGreaterThan(50);
  });

  it("never reads a later bar", () => {
    for (const cut of [100, 999, 2999]) {
      const part = sarStops(c.slice(0, cut + 1));
      expect(part.level[cut]).toBe(stops.level[cut]);
      expect(part.long[cut]).toBe(stops.long[cut]);
    }
  });
});

describe("the trailing exits", () => {
  const c = walk(2000, 11);
  const q = quotes(c);
  const stops = sarStops(c);

  it("a SAR exit leaves at the bar that trades through the SAR, never earlier", () => {
    let checked = 0;
    for (let t = 50; t < 1900 && checked < 40; t += 7) {
      const side = stops.long[t + 1] ? "BUY" : "SELL";
      const x = sarExit(q, stops, t, side, 0.3);
      if (!x) continue;
      checked++;
      const j = t + x.bars;
      // the exit bar is where the SAR on the mid is broken
      if (side === "BUY") expect(c[j].low - 0.01).toBeLessThanOrEqual(stops.level[j]! + 1e-12);
      else expect(c[j].high + 0.01).toBeGreaterThanOrEqual(stops.level[j]! - 1e-12);
      // and no bar before it was
      for (let k = t + 1; k < j; k++) {
        if (side === "BUY") expect(q[k].bid.low).toBeGreaterThan(stops.level[k]!);
        else expect(q[k].ask.high).toBeLessThan(stops.level[k]!);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("a SAR exit needs the SAR on the position's side", () => {
    for (let t = 50; t < 200; t++) {
      const against = stops.long[t + 1] ? "SELL" : "BUY";
      expect(sarExit(q, stops, t, against, 0.3)).toBeNull();
    }
  });

  it("the chandelier stop only tightens, and a hand-made run is kept until it turns", () => {
    // a steady climb, then a drop of more than 3 ATR
    const up: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 40; i++) {
      const o = p;
      p += 0.5;
      up.push({ datetime: stamp(i), open: o, high: p + 0.05, low: o - 0.05, close: p });
    }
    for (let i = 40; i < 50; i++) {
      const o = p;
      p -= 1;
      up.push({ datetime: stamp(i), open: o, high: o + 0.05, low: p - 0.05, close: p });
    }
    const x = chandelierExit(quotes(up), 5, "BUY", 1, 3)!;
    // bought near 103, the high reached about 120.05, out about 3 below it
    expect(x.atr).toBeGreaterThan(10);
    expect(x.bars).toBeGreaterThan(35);
    expect(x.risk).toBeCloseTo(3.01, 1);
  });
});
