// #393: the bands where the price stopped again and again (src/lib/srZones.ts)
//
//   1. four swing lows close together make one band, the far-apart highs none;
//      the band's ends are the lowest and highest swing
//   2. fewer than three swings: no band
//   3. a swing known only with the forming bar is not read (closed bars only)
//   4. highs and lows together: a level that held the lows and later the highs
//   5. the band with the most swings first, up to the cap; highest price first
//   6. a group wider than maxWidth × ATR is cut at its widest gap
//   7. only the swings in the window (the bars on screen)
import { describe, expect, it } from "vitest";
import { SR_ZONES, srSwings, srZones } from "@/lib/srZones";
import { pineAtr } from "../../supabase/functions/_shared/pine";

type B = { open: number; high: number; low: number; close: number };

// Closes in straight steps between the turning points; every bar is ±0.0004
// around its close (open = close), so each turning point is a swing whose
// price is the point ± 0.0004
const zigzag = (points: number[], legBars = 5): B[] => {
  const closes: number[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    for (let j = 0; j < legBars; j++) closes.push(points[k] + ((points[k + 1] - points[k]) * j) / legBars);
  }
  closes.push(points[points.length - 1]);
  return closes.map((c) => ({ open: c, high: c + 0.0004, low: c - 0.0004, close: c }));
};

describe("#393 the bands where the price stopped again and again", () => {
  it("makes one band of the four lows close together, none of the far-apart highs", () => {
    const bars = zigzag([1.005, 1.0, 1.005, 1.0002, 1.008, 0.9999, 1.0065, 1.0001, 1.0095, 1.004]);
    const last = bars.length - 1;
    const atr = pineAtr(bars, 14)[last]!;
    // the lows' gaps (0.0001) within 0.25 × ATR; the highs' gaps (≥ 0.0015) beyond it
    expect(SR_ZONES.gap * atr).toBeGreaterThan(0.0001);
    expect(SR_ZONES.gap * atr).toBeLessThan(0.0015);
    const z = srZones(bars, 0, last);
    expect(z).toHaveLength(1);
    // the lows' own prices: each turning point − 0.0004
    expect(z[0].lo).toBeCloseTo(0.9995, 10);
    expect(z[0].hi).toBeCloseTo(0.9998, 10);
    expect(z[0].touches.map((t) => t.kind)).toEqual(["low", "low", "low", "low"]);
    // oldest first: the swings at bars 5, 15, 25 and 35
    expect(z[0].touches.map((t) => t.i)).toEqual([5, 15, 25, 35]);
  });

  it("needs three swings", () => {
    const bars = zigzag([1.005, 1.0, 1.007, 1.0002, 1.009, 0.995, 1.004]);
    expect(srZones(bars, 0, bars.length - 1)).toEqual([]);
  });

  it("reads closed bars only: a swing known only with the forming bar is not counted", () => {
    // the third low at bar 25 is known 4 bars later (bar 29)
    const bars = zigzag([1.005, 1.0, 1.006, 1.0002, 1.008, 1.0001, 1.007]);
    expect(srZones(bars, 0, 29)).toHaveLength(1);
    expect(srZones(bars, 0, 28)).toEqual([]);
    for (const s of srSwings(bars, 28, 0, SR_ZONES.pivot)) expect(s.i + SR_ZONES.pivot).toBeLessThanOrEqual(28);
  });

  it("counts highs and lows together: a level that held the lows and later the highs", () => {
    // lows at 0.9996 and 0.9998 (turns 1.0000 and 1.0002), then the price
    // below it, its rallies' highs stopping at 0.9997 and 0.9996 (turns 0.9993 and 0.9992)
    const bars = zigzag([1.006, 1.0, 1.007, 1.0002, 1.006, 0.994, 0.9993, 0.988, 0.9992, 0.99]);
    const z = srZones(bars, 0, bars.length - 1);
    expect(z).toHaveLength(1);
    expect(z[0].touches.map((t) => t.kind)).toEqual(["low", "low", "high", "high"]);
    expect(z[0].lo).toBeCloseTo(0.9996, 10);
    expect(z[0].hi).toBeCloseTo(0.9998, 10);
  });

  it("puts the band with the most swings first, up to the cap; highest price first", () => {
    // four lows near 1.0000 and three highs near 1.0100
    const bars = zigzag([1.005, 1.0, 1.01, 1.0001, 1.0102, 0.9999, 1.0101, 1.0002, 1.005]);
    const z = srZones(bars, 0, bars.length - 1);
    expect(z.map((b) => b.touches.length)).toEqual([3, 4]);
    expect(z[0].lo).toBeGreaterThan(z[1].hi);
    expect(srZones(bars, 0, bars.length - 1, { ...SR_ZONES, maxZones: 1 }).map((b) => b.touches.length)).toEqual([4]);
  });

  it("cuts a group wider than maxWidth × ATR at its widest gap", () => {
    // lows chained in steps within 0.25 × ATR: 0.9996, 0.9999, 1.0002, then 1.0007, 1.0010, 1.0013
    // (the step 1.0002 → 1.0007 the widest); together wider than 0.6 × ATR; the highs far apart
    const bars = zigzag([1.01, 1.0, 1.013, 1.0003, 1.016, 1.0006, 1.012, 1.0011, 1.015, 1.0014, 1.011, 1.0017, 1.014]);
    const last = bars.length - 1;
    const atr = pineAtr(bars, 14)[last]!;
    expect(0.0005).toBeLessThanOrEqual(SR_ZONES.gap * atr);
    expect(0.0017).toBeGreaterThan(SR_ZONES.maxWidth * atr);
    const z = srZones(bars, 0, last);
    expect(z.map((b) => [Number(b.lo.toFixed(4)), Number(b.hi.toFixed(4)), b.touches.length])).toEqual([[1.0007, 1.0013, 3], [0.9996, 1.0002, 3]]);
  });

  it("reads only the swings in the window", () => {
    const bars = zigzag([1.005, 1.0, 1.005, 1.0002, 1.008, 0.9999, 1.0065, 1.0001, 1.0095, 1.004]);
    // from bar 10: the low at bar 5 is left out, three remain
    expect(srZones(bars, 10, bars.length - 1)[0].touches.map((t) => t.i)).toEqual([15, 25, 35]);
    expect(srZones(bars, 20, bars.length - 1)).toEqual([]);
  });

  it("is empty with too few bars for the ATR", () => {
    expect(srZones(zigzag([1.0, 1.01], 3), 0, 3)).toEqual([]);
  });
});
