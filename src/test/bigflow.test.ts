import { describe, it, expect } from "vitest";
import {
  CANDIDATES,
  addCell,
  aroon,
  credit,
  donchianState,
  flipped,
  flipsOf,
  lagsOf,
  linregSlope,
  readingsOf,
  tfMean,
  vortex,
  zigzag,
  type Cells,
} from "../../research/bigflow-lib";
import type { Candle } from "../../supabase/functions/analyze/indicators";

// the series the reference values were computed on, independently, in
// Python (the same formulas written from TradingView's definitions)
const N = 160;
const series: Candle[] = Array.from({ length: N }, (_, i) => {
  const close = 100 + 3 * Math.sin(i * 0.37) + 0.02 * i + 0.5 * Math.sin(i * 1.91);
  return {
    datetime: String(i),
    open: close,
    high: close + 0.5 + 0.3 * Math.cos(i * 0.7),
    low: close - 0.4 - 0.2 * Math.abs(Math.sin(i * 1.3)),
    close,
  };
});

// mulberry32
const rng = (seed: number) => {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const walk = (n: number, seed: number): Candle[] => {
  const r = rng(seed);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = o + (r() - 0.5) * 0.3;
    return { datetime: String(i), open: o, high: Math.max(o, p) + r() * 0.05, low: Math.min(o, p) - r() * 0.05, close: p };
  });
};

describe("#142 the answer key: the chart's swings seen afterwards", () => {
  it("turns where the close comes back K × ATR from the leg's extreme, and labels each bar with its leg", () => {
    const close = [10, 11, 12, 13, 12, 11, 10, 9, 10, 11, 12, 13, 14];
    const z = zigzag(close, close.map(() => 1), 3);
    expect(z.pivots).toEqual([
      { i: 0, top: false },
      { i: 3, top: true },
      { i: 7, top: false },
    ]);
    // before the first turn and on the leg still running: not known
    expect(Array.from(z.label)).toEqual([0, 1, 1, 1, -1, -1, -1, -1, 0, 0, 0, 0, 0]);
  });

  it("is not moved by a smaller swing, and uses each bar's ATR", () => {
    const close = [10, 11, 12, 13, 12, 11, 12, 13, 14, 11];
    expect(zigzag(close, close.map(() => 1), 3).pivots).toEqual([
      { i: 0, top: false },
      { i: 8, top: true },
    ]);
    // a wider ATR on the bar that would turn it: no turn
    const atr = close.map((_, i) => (i === 9 ? 2 : 1));
    expect(zigzag(close, atr, 3).pivots).toEqual([{ i: 0, top: false }]);
  });

  it("is the mirror image on the chart turned upside down", () => {
    const c = walk(3000, 3);
    const close = c.map((b) => b.close);
    const up = zigzag(close, close.map(() => 0.1), 6);
    const down = zigzag(close.map((x) => 300 - x), close.map(() => 0.1), 6);
    expect(up.pivots.length).toBeGreaterThan(10);
    expect(down.pivots.map((p) => ({ i: p.i, top: !p.top }))).toEqual(up.pivots);
    expect(Array.from(down.label)).toEqual(Array.from(up.label).map((x) => (x === 0 ? 0 : -x)));
  });
});

describe("#142 the candidates' arithmetic", () => {
  it("Aroon(14) as TradingView defines it", () => {
    const a = aroon(series, 14);
    const want: Record<number, [number, number]> = {
      20: [100.0, 42.857142857142854],
      57: [78.57142857142857, 14.285714285714286],
      101: [21.428571428571427, 78.57142857142857],
      159: [78.57142857142857, 21.428571428571427],
    };
    for (const [i, [u, d]] of Object.entries(want)) {
      expect(a.up[Number(i)]).toBeCloseTo(u, 10);
      expect(a.down[Number(i)]).toBeCloseTo(d, 10);
    }
    expect(a.up[13]).toBeNull();
  });

  it("Vortex(14) as TradingView defines it", () => {
    const v = vortex(series, 14);
    const want: Record<number, [number, number]> = {
      14: [0.7025782958840442, 0.907570910605882],
      57: [1.0056395890124885, 0.8066837213460296],
      101: [0.7348806564631513, 0.9282037733992227],
      159: [0.997264341926297, 0.6985648845158675],
    };
    for (const [i, [p, m]] of Object.entries(want)) {
      expect(v.plus[Number(i)]).toBeCloseTo(p, 10);
      expect(v.minus[Number(i)]).toBeCloseTo(m, 10);
    }
    expect(v.plus[13]).toBeNull();
  });

  it("the least-squares slope of the last 100 closes", () => {
    const s = linregSlope(series.map((c) => c.close), 100);
    expect(s[98]).toBeNull();
    expect(s[99]).toBeCloseTo(0.011826272388166685, 12);
    expect(s[130]).toBeCloseTo(0.020674070630432525, 12);
    expect(s[159]).toBeCloseTo(0.028906459417704172, 12);
  });

  it("Donchian: the side of the last close outside the previous bars' channel, held", () => {
    const bar = (close: number, high = close + 0.5, low = close - 0.5): Candle => ({ datetime: "", open: close, high, low, close });
    const c = [bar(10), bar(10.2), bar(10.1), bar(10.9), bar(10.4), bar(9.2), bar(9.6), bar(9.9)];
    // n = 3: bar 3 closes over the high of bars 0-2 (10.7); bar 5 under the
    // low of bars 2-4 (9.6); bar 7 inside
    expect(Array.from(donchianState(c, 3))).toEqual([0, 0, 0, 1, 1, -1, -1, -1]);
  });

  it("scores right 1, wrong 0 and 'neither' a half", () => {
    expect(credit(1, 1)).toBe(1);
    expect(credit(-1, 1)).toBe(0);
    expect(credit(0, -1)).toBe(0.5);
  });

  it("counts turns without counting a 'neither' between two readings the same way", () => {
    expect(flipsOf([0, 1, 1, 0, 1, -1, 0, -1, 1], 0, 8)).toBe(2);
    expect(flipsOf([1, -1, 1, -1], 1, 2)).toBe(1);
  });

  it("measures how late each leg is shown, and a leg never shown", () => {
    const close = [10, 11, 12, 13, 12, 11, 10, 9, 10, 11, 12, 13, 14, 13, 12, 11];
    const z = zigzag(close, close.map(() => 1), 3);
    // legs: up 1-3, down 4-7, up 8-12
    const r = [0, 0, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1, 1, 1, 1];
    expect(lagsOf(r, z, 0)).toEqual([
      { start: 1, lag: 1, length: 3 },
      { start: 4, lag: 2, length: 4 },
      { start: 8, lag: null, length: 5 },
    ]);
    expect(lagsOf(r, z, 2).map((l) => l.start)).toEqual([4, 8]);
  });
});

describe("#142 every candidate reads the chart turned upside down the other way", () => {
  for (const seed of [1, 2]) {
    const c = walk(3000, seed);
    const up = readingsOf(c);
    const down = readingsOf(flipped(c, 150));
    for (const cand of CANDIDATES) {
      it(`${cand.id} (seed ${seed})`, () => {
        const a = Array.from(up[cand.id]).slice(600);
        const b = Array.from(down[cand.id]).slice(600).map((x) => (x === 0 ? 0 : -x));
        expect(a.some((x) => x !== 0)).toBe(true);
        expect(b).toEqual(a);
      });
    }
  }
});

describe("#142 the timeframes' average and its interval, clustered by month", () => {
  const cellsOf = (rows: Array<[string, string, number, number]>): Cells => {
    const c: Cells = new Map();
    for (const [k, tf, s, n] of rows) addCell(c, k, tf, s, n);
    return c;
  };
  const A = cellsOf([
    ["c1", "a", 3, 4], ["c2", "a", 1, 2], ["c3", "a", 2, 4],
    ["c1", "b", 1, 1], ["c2", "b", 0, 1], ["c3", "b", 2, 2],
  ]);
  const B = cellsOf([
    ["c1", "a", 2, 4], ["c2", "a", 1, 2], ["c3", "a", 1, 4],
    ["c1", "b", 0, 1], ["c2", "b", 1, 1], ["c3", "b", 1, 2],
  ]);

  it("counts each timeframe the same, whatever its number of bars", () => {
    const r = tfMean(A, ["a", "b"])!;
    // (6/10 + 3/4) / 2; the error worked by hand (the delta method)
    expect(r.est).toBeCloseTo(0.675, 12);
    expect(r.se).toBeCloseTo(0.15646984533768798, 12);
    expect(r.n).toBe(14);
    expect(tfMean(A, ["a"])!.est).toBeCloseTo(0.6, 12);
  });

  it("a paired difference on the same bars", () => {
    const r = tfMean(A, ["a", "b"], B)!;
    expect(r.est).toBeCloseTo(0.225, 12);
    expect(r.se).toBeCloseTo(0.2657565850548204, 12);
  });
});
