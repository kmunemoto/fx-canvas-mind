import { describe, it, expect } from "vitest";
import { GP_DEFAULTS, gainzPro, rankAmong } from "../lib/gainzPro";

// #131: a seeded random walk with a drift, as candles
const walk = (n: number, seed = 11, drift = 0.02) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 100;
  return Array.from({ length: n }, () => {
    const open = p;
    p += drift + (rnd() - 0.5) * 1.2;
    const close = p;
    return { open, close, high: Math.max(open, close) + rnd() * 0.4, low: Math.min(open, close) - rnd() * 0.4 };
  });
};
// the same market upside down: a buy there is a sell here
const mirror = (bars: ReturnType<typeof walk>) => bars.map((b) => ({ open: -b.open, close: -b.close, high: -b.low, low: -b.high }));

describe("#131 the Pro-style confidence score", () => {
  it("ranks a value among the ones before it, ties counting half, and needs all of them", () => {
    expect(rankAmong([1, 2, 3, 4, 2.5], 4, 4)).toBe(0.5);
    expect(rankAmong([1, 2, 2, 4, 2], 4, 4)).toBe((1 + 1) / 4);
    expect(rankAmong([1, null, 3, 4, 2], 4, 4)).toBeNull();
    expect(rankAmong([1, 2, 3], 2, 4)).toBeNull();
  });

  it("signals only after a down then an up candle (a buy) or the mirror, at the top 5% of recent scores", () => {
    const bars = walk(1500);
    const r = gainzPro(bars);
    expect(r.signals.length).toBeGreaterThan(10);
    for (const sg of r.signals) {
      const b = bars[sg.i], p = bars[sg.i - 1];
      if (sg.side === "BUY") expect(p.close < p.open && b.close > b.open).toBe(true);
      else expect(p.close > p.open && b.close < b.open).toBe(true);
      expect(sg.rank).toBeGreaterThanOrEqual(GP_DEFAULTS.threshold);
      expect(sg.score).toBe(r.score[sg.side][sg.i]);
    }
    // nothing before every part and the score can be ranked on a full window
    expect(Math.min(...r.signals.map((s) => s.i))).toBeGreaterThanOrEqual(2 * GP_DEFAULTS.window + GP_DEFAULTS.emaLength);
  });

  it("is its own mirror: the market upside down gives sells where it gave buys", () => {
    const bars = walk(900, 5);
    const up = gainzPro(bars).signals;
    const down = gainzPro(mirror(bars)).signals;
    expect(down.map((s) => `${s.i}:${s.side === "BUY" ? "SELL" : "BUY"}`)).toEqual(up.map((s) => `${s.i}:${s.side}`));
    down.forEach((s, k) => expect(s.score).toBeCloseTo(up[k].score, 10));
  });

  it("never repaints, and nothing is signalled on the bar still forming", () => {
    const bars = walk(700, 3);
    const all = gainzPro(bars).signals.map((s) => `${s.i}:${s.side}`);
    for (const k of [400, 523, 650, 700]) {
      expect(gainzPro(bars.slice(0, k)).signals.map((s) => `${s.i}:${s.side}`)).toEqual(all.filter((x) => Number(x.split(":")[0]) < k));
    }
    const last = gainzPro(bars).signals.at(-1)!;
    expect(gainzPro(bars.slice(0, last.i + 1), GP_DEFAULTS, last.i - 1).signals.some((s) => s.i === last.i)).toBe(false);
  });

  it("without the trend part, scores the three reversal parts alone", () => {
    const bars = walk(900, 9);
    const a = gainzPro(bars).signals.map((s) => `${s.i}:${s.side}`);
    const b = gainzPro(bars, { ...GP_DEFAULTS, trend: false }).signals.map((s) => `${s.i}:${s.side}`);
    expect(b.length).toBeGreaterThan(0);
    expect(b).not.toEqual(a);
  });
});
