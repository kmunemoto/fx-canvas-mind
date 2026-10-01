import { describe, it, expect } from "vitest";
import {
  ZLT_DEFAULTS,
  ZLT_ROUGH_BARS,
  ZLT_SETTLE_BARS,
  emaFromFirst,
  tema,
  zeroLagTema,
  zlTemaCrosses,
  zltSidesAndSignals,
} from "../lib/zlTema";

// A random walk (Park–Miller), the same every run
const walk = (n: number, seed = 17, step = 0.3, drift = 0) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, () => (p += (rnd() - 0.5) * step + drift));
};

// Pine's own ta.ema, written apart from the port: nothing until the first
// n values are all there, their simple average, then alpha = 2 / (n + 1)
const pineEma = (xs: ReadonlyArray<number | null>, n: number): Array<number | null> => {
  const alpha = 2 / (n + 1);
  const out: Array<number | null> = [];
  let prev: number | null = null;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (prev === null) {
      const win = i >= n - 1 ? xs.slice(i - n + 1, i + 1) : [];
      if (win.length === n && win.every((v) => v !== null)) prev = (win as number[]).reduce((a, b) => a + b, 0) / n;
    } else if (x !== null) {
      prev = alpha * x + (1 - alpha) * prev;
    }
    out.push(prev);
  }
  return out;
};
const pineTema = (xs: ReadonlyArray<number | null>, n: number) => {
  const e1 = pineEma(xs, n);
  const e2 = pineEma(e1, n);
  const e3 = pineEma(e2, n);
  return e1.map((v, i) => (v === null || e2[i] === null || e3[i] === null ? null : 3 * (v - (e2[i] as number)) + (e3[i] as number)));
};
const pineZlagtema = (xs: ReadonlyArray<number>, n: number) => pineTema(pineTema(xs, n), n);

describe("#176 Zero-lag TEMA Crosses [Loxx] (a port of its open-source Pine code)", () => {
  it("has the original's defaults", () => {
    expect(ZLT_DEFAULTS).toEqual({ fast: 22, slow: 144 });
    expect(ZLT_SETTLE_BARS).toBe(1200);
    expect(ZLT_ROUGH_BARS).toBe(600);
  });

  it("is TEMA of TEMA, each EMA started from the first value (worked by hand)", () => {
    // n = 3, alpha 0.5: e1 1, 1.5, 2.25, 3.125; e2 1, 1.25, 1.75, 2.4375;
    // e3 1, 1.125, 1.4375, 1.9375 → TEMA 1, 1.875, 2.9375, 4
    expect(emaFromFirst([1, 2, 3, 4], 3)).toEqual([1, 1.5, 2.25, 3.125]);
    expect(tema([1, 2, 3, 4], 3)).toEqual([1, 1.875, 2.9375, 4]);
    // and TEMA of that: 1, 1.765625, 2.859375, 3.98828125
    zeroLagTema([1, 2, 3, 4], 3).forEach((v, i) => expect(v).toBeCloseTo([1, 1.765625, 2.859375, 3.98828125][i], 12));
    // a period of 1 is the series itself
    expect(zeroLagTema([5, 7, 6], 1)).toEqual([5, 7, 6]);
  });

  it("past the bars its start needs, is the line Pine draws over a long history (TradingView's)", () => {
    for (const [seed, drift] of [[17, 0], [29, 0.01], [41, -0.02]] as const) {
      const closes = walk(3600, seed, 0.3, drift);
      const meanMove = closes.slice(1).reduce((a, c, i) => a + Math.abs(c - closes[i]), 0) / (closes.length - 1);
      // Pine over all 3,600 bars: settled long before the last 120
      const fullFast = pineZlagtema(closes, 22);
      const fullSlow = pineZlagtema(closes, 144);
      // the port over the last 1,200 + 120 only, as the chart reads them
      const part = closes.slice(-(ZLT_SETTLE_BARS + 120));
      const r = zlTemaCrosses(part);
      for (let k = 1; k <= 120; k++) {
        expect(Math.abs(r.slow[part.length - k] - (fullSlow[closes.length - k] as number)) / meanMove).toBeLessThan(0.01);
        expect(Math.abs(r.fast[part.length - k] - (fullFast[closes.length - k] as number)) / meanMove).toBeLessThan(1e-9);
      }
      // the same L/S marks on those 120 bars
      const tvSigs = zltSidesAndSignals(
        fullFast.slice(-121).map((v) => v as number),
        fullSlow.slice(-121).map((v) => v as number),
        120,
      ).signals;
      const ours = zltSidesAndSignals(r.fast.slice(-121), r.slow.slice(-121), 120).signals;
      expect(ours).toEqual(tvSigs);
    }
  });

  it("with too few bars before them, differs from it (why the chart reads deep)", () => {
    const closes = walk(3600, 17);
    const meanMove = closes.slice(1).reduce((a, c, i) => a + Math.abs(c - closes[i]), 0) / (closes.length - 1);
    const fullSlow = pineZlagtema(closes, 144);
    const part = closes.slice(-(300 + 120));
    const r = zlTemaCrosses(part);
    const worst = Math.max(...Array.from({ length: 120 }, (_, k) => Math.abs(r.slow[part.length - 1 - k] - (fullSlow[closes.length - 1 - k] as number)) / meanMove));
    expect(worst).toBeGreaterThan(0.05);
    // and Pine's own start has no slow line at all within 858 bars
    expect(pineZlagtema(closes.slice(0, 858), 144).every((v) => v === null)).toBe(true);
    expect(pineZlagtema(closes.slice(0, 859), 144)[858]).not.toBeNull();
  });

  it("colours a bar green only while fast > slow, and marks the crossings as ta.crossover / ta.crossunder do", () => {
    const fast = [1, 2, 2, 3, 1, 1, 2];
    const slow = [2, 2, 1, 1, 2, 1, 1];
    const r = zltSidesAndSignals(fast, slow, 6);
    // equal is not above: red
    expect(r.side).toEqual([-1, -1, 1, 1, -1, -1, 1]);
    // over at 2 (from equal), under at 4; 5 is equal (no cross); over at 6
    // from equal (1 <= 1 before, 2 > 1 now)
    expect(r.signals).toEqual([
      { i: 2, side: "BUY" },
      { i: 4, side: "SELL" },
      { i: 6, side: "BUY" },
    ]);
    // the bar still forming: neither painted nor marked
    const closed = zltSidesAndSignals(fast, slow, 5);
    expect(closed.side[6]).toBeNull();
    expect(closed.signals.map((s) => s.i)).toEqual([2, 4]);
  });

  it("marks nothing on the second bar, where the two lines only part from the same first close", () => {
    // without it, every chart computed from its first bar had an L or S on
    // its second (up: L, down: S); Pine marks none there
    for (let seed = 1; seed <= 200; seed++) {
      const closes = walk(200, seed);
      const r = zlTemaCrosses(closes);
      expect(r.fast[0]).toBe(r.slow[0]);
      expect(r.signals.some((sg) => sg.i < 2)).toBe(false);
    }
    expect(zlTemaCrosses([100, 100, 101, 102, 101]).signals.some((sg) => sg.i === 1)).toBe(false);
  });

  it("on a long walk, marks every change of side and alternates L and S", () => {
    const r = zlTemaCrosses(walk(2000, 7));
    let changes = 0;
    for (let i = 2; i < r.side.length; i++) if (r.side[i] !== r.side[i - 1]) changes++;
    expect(r.signals.length).toBe(changes);
    expect(r.signals.length).toBeGreaterThan(4);
    for (let k = 1; k < r.signals.length; k++) expect(r.signals[k].side).not.toBe(r.signals[k - 1].side);
  });
});
