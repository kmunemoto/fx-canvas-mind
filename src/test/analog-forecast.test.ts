// #392 (docs §8.135): the similar-past forecast (似た相場の予測) — the shape
// of the newest bars, the past places most like it, and what came after each
// laid on the newest close (supabase/functions/_shared/analog-forecast.ts; the
// rule: research/analog-spec.md).
//
//   1. a hand example: two places at distance 0 (the newer first), the gap
//      between places, the median / highest / lowest worked out by hand
//   2. no forecast: a close in the pool that is no positive number, too few
//      bars; a bad close outside the pool does not matter
//   3. the rule written again here, apart from the module (every candidate's
//      distance by its own loop, the K nearest by repeated scans), on seeded
//      random walks: the same places and lines
//   4. nothing after the anchor is read: the forecast at a bar is the same
//      whatever follows it, and every place's path ends at or before it
import { describe, expect, it } from "vitest";
import { ANALOG, analogForecast, type AnalogOptions } from "@/lib/analogForecast";

const small = (o: Partial<AnalogOptions>): AnalogOptions => ({ pattern: 2, horizon: 1, matches: 2, window: 100, gap: 2, ...o });

// c[0..9]; the shape now (a = 9) is 100, 101 → 102; the same shape ends at
// j = 2 (100, 101, 102) and j = 5 (100, 101, 102): both distance 0
const HAND = [100, 101, 102, 100, 101, 102, 103, 100, 101, 102];

describe("the hand example", () => {
  it("takes the two places at distance 0, the newer first, and lays their next bar on the newest close", () => {
    const f = analogForecast(HAND, 9, small({}));
    expect(f).not.toBeNull();
    expect(f!.places.map((p) => p.j)).toEqual([5, 2]);
    expect(f!.places.map((p) => p.d)).toEqual([0, 0]);
    // j = 5: 102 * (103 / 102) = 103; j = 2: 102 * (100 / 102) = 100
    expect(f!.up[1]).toBeCloseTo(103, 10);
    expect(f!.lo[1]).toBeCloseTo(100, 10);
    expect(f!.mid[1]).toBeCloseTo(101.5, 10);
    expect([f!.mid[0], f!.up[0], f!.lo[0]]).toEqual([102, 102, 102]);
    // the centre ends under the newest close: down
    expect(f!.dir).toBe(-1);
    expect(f!.a).toBe(9);
    expect(f!.start).toBe(0);
  });

  it("keeps places at least `gap` bars apart", () => {
    // by distance after the two 0s: j = 6, 4, 8, 3, 7 (worked out in the spec's terms:
    // q = (c[j-2]/c[j] - 1, c[j-1]/c[j] - 1) against p = (100/102 - 1, 101/102 - 1))
    const g2 = analogForecast(HAND, 9, small({ matches: 3, gap: 2 }));
    expect(g2!.places.map((p) => p.j)).toEqual([5, 2, 8]);
    const g1 = analogForecast(HAND, 9, small({ matches: 3, gap: 1 }));
    expect(g1!.places.map((p) => p.j)).toEqual([5, 2, 6]);
    // K = 3 (odd): the median is the middle one
    // j = 6: 102 * (100 / 103); the three next bars: 99.03…, 100, 103
    expect(g1!.mid[1]).toBeCloseTo(100, 10);
    expect(g1!.lo[1]).toBeCloseTo((102 * 100) / 103, 10);
  });

  it("reaches H bars: each place's path from its own newest bar", () => {
    // H = 2: the candidates end at a - 2 = 7: j = 2 (0), j = 5 (0)
    const f = analogForecast(HAND, 9, small({ horizon: 2 }));
    expect(f!.places.map((p) => p.j)).toEqual([5, 2]);
    // h = 2: j = 5 → 102 * (100 / 102) = 100; j = 2 → 102 * (101 / 102) = 101
    expect(f!.up[2]).toBeCloseTo(101, 10);
    expect(f!.lo[2]).toBeCloseTo(100, 10);
    expect(f!.mid[2]).toBeCloseTo(100.5, 10);
    expect(f!.mid.length).toBe(3);
  });
});

describe("no forecast", () => {
  it("a close in the pool at or below zero, or not a number", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const c = [...HAND];
      c[4] = bad;
      expect(analogForecast(c, 9, small({}))).toBeNull();
    }
  });

  it("a bad close before the pool does not matter", () => {
    // W = 8: the pool is c[2..9]; c[0] is not read
    const c = [...HAND];
    c[0] = -5;
    const f = analogForecast(c, 9, small({ window: 8 }));
    expect(f).not.toBeNull();
    expect(f!.start).toBe(2);
    // j from start + L = 4: j = 5 (distance 0) is still there; j = 2 is not
    expect(f!.places[0].j).toBe(5);
    expect(f!.places.some((p) => p.j === 2)).toBe(false);
  });

  it("fewer places than K, or too few bars for the shape", () => {
    expect(analogForecast(HAND, 9, small({ matches: 9, gap: 2 }))).toBeNull();
    expect(analogForecast(HAND.slice(0, 2), 1, small({}))).toBeNull();
    expect(analogForecast([], -1, small({}))).toBeNull();
  });
});

// a seeded walk of closes (no bar at or below zero)
const walk = (n: number, seed: number): number[] => {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: number[] = [];
  let v = 150;
  for (let i = 0; i < n; i++) {
    v *= 1 + (rnd() - 0.5) * 0.004;
    out.push(Number(v.toFixed(3)));
  }
  return out;
};

// the rule again, apart from the module: each distance by its own loop, the
// K places by scanning the candidates again each time for the nearest one
// not yet taken and not near one taken (ties: the newer)
const again = (c: number[], a: number, o: AnalogOptions) => {
  const { pattern: L, horizon: H, matches: K, window: W, gap: G } = o;
  const s = Math.max(0, a - W + 1);
  const dist = new Map<number, number>();
  for (let j = s + L; j <= a - H; j++) {
    let d = 0;
    for (let k = 0; k < L; k++) {
      const q = c[j - L + k] / c[j] - 1;
      const p = c[a - L + k] / c[a] - 1;
      d += (q - p) * (q - p);
    }
    dist.set(j, d);
  }
  const taken: number[] = [];
  while (taken.length < K) {
    let best: number | null = null;
    for (const [j, d] of dist) {
      if (taken.includes(j) || taken.some((t) => Math.abs(t - j) < G)) continue;
      if (best === null || d < dist.get(best)! || (d === dist.get(best)! && j > best)) best = j;
    }
    if (best === null) return null;
    taken.push(best);
  }
  const lines = { mid: [c[a]], up: [c[a]], lo: [c[a]] };
  for (let h = 1; h <= H; h++) {
    const v = taken.map((j) => c[a] * (c[j + h] / c[j])).sort((x, y) => x - y);
    lines.mid.push(K % 2 ? v[(K - 1) / 2] : (v[K / 2 - 1] + v[K / 2]) / 2);
    lines.up.push(v[K - 1]);
    lines.lo.push(v[0]);
  }
  return { places: taken, ...lines };
};

describe("the rule written again", () => {
  it("finds the same places and lines on seeded walks", () => {
    const o: AnalogOptions = { ...ANALOG, window: 400 };
    let compared = 0;
    for (const seed of [1, 7, 42]) {
      const c = walk(900, seed);
      for (const a of [399, 520, 777, 899]) {
        const f = analogForecast(c, a, o);
        const g = again(c, a, o);
        expect(f === null).toBe(g === null);
        if (!f || !g) continue;
        expect(f.places.map((p) => p.j)).toEqual(g.places);
        expect(f.mid).toEqual(g.mid);
        expect(f.up).toEqual(g.up);
        expect(f.lo).toEqual(g.lo);
        compared++;
      }
    }
    expect(compared).toBe(12);
  });

  it("uses the video's reach and the app's numbers by default", () => {
    expect(ANALOG).toEqual({ pattern: 20, horizon: 20, matches: 10, window: 1500, gap: 20 });
    const c = walk(1600, 3);
    const f = analogForecast(c);
    expect(f).not.toBeNull();
    expect(f!.a).toBe(1599);
    expect(f!.start).toBe(100);
    expect(f!.places.length).toBe(10);
    expect(f!.mid.length).toBe(21);
    for (let h = 0; h <= 20; h++) {
      expect(f!.lo[h]).toBeLessThanOrEqual(f!.mid[h]);
      expect(f!.mid[h]).toBeLessThanOrEqual(f!.up[h]);
    }
  });
});

describe("nothing after the anchor is read", () => {
  it("the forecast at a bar is the same whatever follows it", () => {
    const c = walk(2200, 11);
    for (const a of [1700, 2000]) {
      const f = analogForecast(c, a);
      const cut = analogForecast(c.slice(0, a + 1), a);
      const changed = c.map((v, i) => (i > a ? v * 1.5 : v));
      const g = analogForecast(changed, a);
      expect(f).toEqual(cut);
      expect(f).toEqual(g);
      // every place's path ends at or before the anchor
      for (const p of f!.places) expect(p.j + ANALOG.horizon).toBeLessThanOrEqual(a);
    }
  });
});
