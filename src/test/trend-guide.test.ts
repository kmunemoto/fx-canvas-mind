// #394: the owner's ① ② ④ drawn by themselves (src/lib/trendGuide.ts)
//
//   1. a down move: ① from the highest high through the swing high with the
//      shallowest fall (every swing high to the low under it), its break by a close
//   2. ② the steeper line of the last leg, and its break
//   3. ④ the lowest low; its rising line only once a confirmed higher low follows
//   4. an up move mirrored: ① through the lows, broken by a close below, ④ the top
//   5. closed bars on screen only: the window's start, the forming bar, too few bars
import { describe, expect, it } from "vitest";
import { guideAt, trendGuide } from "@/lib/trendGuide";

// closes in straight steps between the turning points (5 bars a leg); every bar
// ±0.0004 around its close, so turning point k is bar 5k, a swing at the point ± 0.0004
const zig = (points: number[], legBars = 5) => {
  const c: number[] = [];
  for (let k = 0; k + 1 < points.length; k++) for (let j = 0; j < legBars; j++) c.push(points[k] + ((points[k + 1] - points[k]) * j) / legBars);
  c.push(points[points.length - 1]);
  return c.map((x) => ({ open: x, high: x + 0.0004, low: x - 0.0004, close: x }));
};
// highs at bars 5 (1.0204), 15, 25, 35 (1.0094), 45 (1.0054), 55 (1.0009); the low at bar 60 (0.9846); a rally to bar 65
const DOWN = [1.0, 1.02, 1.01, 1.016, 1.006, 1.012, 1.002, 1.009, 0.997, 1.005, 0.994, 1.0005, 0.985, 1.008];

describe("#394 the owner's ① ② ④ drawn by themselves", () => {
  it("draws ① from the highest high through the swing high with the shallowest fall, broken by a close", () => {
    const b = zig(DOWN);
    const g = trendGuide(b, 0, b.length - 1)!;
    expect(g.dir).toBe("down");
    expect([g.main!.a, g.main!.b]).toEqual([5, 35]);
    expect(g.main!.pa).toBeCloseTo(1.0204, 10);
    expect(g.main!.pb).toBeCloseTo(1.0094, 10);
    // every swing high from the top to the low is on or under it
    for (const k of [15, 25, 45, 55]) expect(b[k].high).toBeLessThanOrEqual(guideAt(g.main!, k) + 1e-12);
    // the first close above it: bar 64 (bar 63's close 0.9988 is under the line's 0.99913)
    expect(g.main!.brokenAt).toBe(64);
  });

  it("draws ② through the last leg's two swing highs when it falls more steeply, and its break", () => {
    const b = zig(DOWN);
    const g = trendGuide(b, 0, b.length - 1)!;
    expect([g.steep!.a, g.steep!.b]).toEqual([45, 55]);
    const s1 = (g.main!.pb - g.main!.pa) / (g.main!.b - g.main!.a);
    const s2 = (g.steep!.pb - g.steep!.pa) / (g.steep!.b - g.steep!.a);
    expect(s2).toBeLessThan(s1);
    expect(g.steep!.brokenAt).toBe(63);
  });

  it("marks ④ at the lowest low; its rising line waits for a confirmed higher low", () => {
    const b = zig(DOWN);
    const g = trendGuide(b, 0, b.length - 1)!;
    expect(g.extreme.i).toBe(60);
    expect(g.extreme.price).toBeCloseTo(0.9846, 10);
    expect(g.counter).toBeNull();
    // a pullback to a higher low at bar 70 (0.9946), confirmed 4 bars later
    const b2 = zig([...DOWN, 0.995, 1.004]);
    const g2 = trendGuide(b2, 0, b2.length - 1)!;
    expect([g2.counter!.a, g2.counter!.b]).toEqual([60, 70]);
    expect(g2.counter!.pb).toBeCloseTo(0.9946, 10);
    // not yet known 3 bars after it
    expect(trendGuide(b2, 0, 73)!.counter).toBeNull();
  });

  it("mirrors an up move: ① through the lows, broken by a close below, ④ the top", () => {
    const up = DOWN.map((v) => 2 - v);
    const b = zig(up);
    const g = trendGuide(b, 0, b.length - 1)!;
    expect(g.dir).toBe("up");
    expect([g.main!.a, g.main!.b]).toEqual([5, 35]);
    expect(g.main!.pa).toBeCloseTo(0.9796, 10);
    expect(g.main!.brokenAt).toBe(64);
    expect([g.steep!.a, g.steep!.b]).toEqual([45, 55]);
    expect(g.extreme.i).toBe(60);
    expect(g.extreme.price).toBeCloseTo(1.0154, 10);
  });

  it("reads the closed bars of the window only", () => {
    const b = zig(DOWN);
    // a window from bar 20: its highest high is bar 25's (1.0124)
    expect(trendGuide(b, 20, b.length - 1)!.main!.a).toBe(25);
    // too few bars
    expect(trendGuide(b, 40, 60)).toBeNull();
    // the last closed bar 63: ① not broken yet, ② broken at 63
    const g = trendGuide(b, 0, 63)!;
    expect(g.main!.brokenAt).toBeNull();
    expect(g.steep!.brokenAt).toBe(63);
  });
});
