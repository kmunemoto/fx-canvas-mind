import { describe, it, expect } from "vitest";
import { alignedBools, alignedNumbers, normalizeRsiSar } from "../lib/rsiSar";
import { compactRsiSar, readRsiSar } from "../../supabase/functions/analyze/rsisar";
import type { Candle } from "../../supabase/functions/analyze/indicators";

const walk = (n: number): Candle[] => {
  let s = 5;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  let px = 150;
  return Array.from({ length: n }, (_, i) => {
    const o = px;
    px = o + (r() - 0.5) * 0.2;
    return {
      datetime: new Date(Date.parse("2026-01-05T00:00:00Z") + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      open: o,
      high: Math.max(o, px) + 0.02,
      low: Math.min(o, px) - 0.02,
      close: px,
    };
  });
};

describe("the RSI/SAR summary as the client takes it (#104)", () => {
  it("round-trips what the server sends", () => {
    const sent = JSON.parse(JSON.stringify(compactRsiSar("1h", readRsiSar(walk(500)), 3)));
    const got = normalizeRsiSar(sent)!;
    expect(got.tf).toBe("1h");
    expect(got.ok).toBe(true);
    expect(got.now?.rsi).toBe(sent.now.rsi);
    expect(got.next?.buy.side).toBe("BUY");
    expect(got.next?.sell.side).toBe("SELL");
    expect(got.next?.close?.at).toBe(sent.next.close.at);
    expect(got.evidence.tf.measured).toBe(true);
    expect(got.evidence.breakeven.win).toBe(0.4);
  });

  it("drops what it cannot trust", () => {
    expect(normalizeRsiSar(null)).toBeNull();
    expect(normalizeRsiSar({ tf: 1, ok: true })).toBeNull();
    const sent = JSON.parse(JSON.stringify(compactRsiSar("1h", readRsiSar(walk(500)), 3)));
    // a trigger for the wrong side is not rendered as advice
    const swapped = normalizeRsiSar({ ...sent, next: { ...sent.next, buy: sent.next.sell } })!;
    expect(swapped.next).toBeNull();
    // a price that is not a number is not a price
    const bad = normalizeRsiSar({ ...sent, now: { ...sent.now, sar: "150.1" } })!;
    expect(bad.now?.sar).toBeNull();
  });

  it("accepts a series only when it lines up with the candles", () => {
    expect(alignedNumbers([1, null, 3], 3)).toEqual([1, null, 3]);
    expect(alignedNumbers([1, "x", 3], 3)).toEqual([1, null, 3]);
    expect(alignedNumbers([1, 2], 3)).toBeUndefined();
    expect(alignedBools([true, null, false], 3)).toEqual([true, null, false]);
    expect(alignedBools("no", 3)).toBeUndefined();
  });
});
