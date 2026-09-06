import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  compactStructure,
  computeStructure,
  pivots,
} from "../../supabase/functions/analyze/structure";
import { compactDivergence, detectDivergence } from "../../supabase/functions/analyze/divergence";
import { atr, rsiSeries, type Candle } from "../../supabase/functions/analyze/indicators";

const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");

const PIP = 0.01;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(T0 + i * HOUR).toISOString(),
  open: o, high: h, low: l, close: c,
});

// A descending series with pivots on both sides: enough shape that the
// structure has a label, levels, a break and both ranges.
const falling = (n = 120): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const base = 150 - i * 0.03;
    const wave = Math.sin(i / 4) * 0.25;
    const c = base + wave;
    return bar(i, c - 0.01, c + 0.12, c - 0.12, c);
  });

const structureOf = (candles: Candle[]) =>
  computeStructure(candles, atr(candles), PIP, candles[candles.length - 1].close);

describe("the structure, as it lands on the row", () => {
  const s = structureOf(falling());
  const out = compactStructure("1h", s, 3) as Record<string, unknown>;

  it("is usable in the first place, or the rest of this proves nothing", () => {
    expect(s.ok).toBe(true);
    expect(s.highs.length + s.lows.length).toBeGreaterThan(0);
  });

  it("keeps what still means something once the series is gone", () => {
    expect(out.tf).toBe("1h");
    expect(out.ok).toBe(true);
    expect(out.label).toBe(s.label);
    expect(out.bars).toBe(s.bars);
    // barsAgo and datetime survive; the array index does not, because it is a
    // position in an array that no longer exists.
    const high = (out.highs as Array<Record<string, unknown>>)[0];
    if (high) {
      expect(high).toHaveProperty("barsAgo");
      expect(high).toHaveProperty("datetime");
      expect(high).not.toHaveProperty("index");
    }
  });

  it("keeps the two bars the label was read off", () => {
    // The label is a two-pivot comparison, not a verdict about the window.
    // Without these the difference is invisible on the row, exactly as it was
    // in the prompt before they were rendered.
    const from = out.label_from as { highs: unknown[] | null; lows: unknown[] | null };
    expect(from).toBeDefined();
    if (s.labelFrom.highs) expect(from.highs).toHaveLength(2);
    if (s.labelFrom.lows) expect(from.lows).toHaveLength(2);
  });

  it("rounds prices to the pair's decimals and ATR multiples to two", () => {
    const decimalsOf = (v: unknown) => {
      const t = String(v);
      return t.includes(".") ? t.split(".")[1].length : 0;
    };
    for (const p of [...(out.highs as Array<Record<string, unknown>>), ...(out.lows as Array<Record<string, unknown>>)]) {
      expect(decimalsOf(p.price)).toBeLessThanOrEqual(3);
      expect(decimalsOf(p.close)).toBeLessThanOrEqual(3);
    }
    if (out.net_atr !== null) expect(decimalsOf(out.net_atr)).toBeLessThanOrEqual(2);
    const up = out.next_up as { atr: number } | null;
    if (up) expect(decimalsOf(up.atr)).toBeLessThanOrEqual(2);
  });

  it("says only why, when there is no structure to say anything about", () => {
    // Empty pivot lists beside ok:false would invite a reader to treat them as
    // a measurement of "no pivots" rather than as "not measured".
    const thin = computeStructure(falling(10), atr(falling(10)), PIP, 150);
    expect(thin.ok).toBe(false);
    const bad = compactStructure("1h", thin, 3) as Record<string, unknown>;
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe(thin.reason);
    expect(bad).not.toHaveProperty("highs");
    expect(bad).not.toHaveProperty("label");
  });

  it("survives a round trip through JSON, which is how it is stored", () => {
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe("the divergence, as it lands on the row", () => {
  it("keeps the reason even when the answer is none", () => {
    // "Looked and found nothing" and "could not look" are different facts and
    // the row has to be able to tell them apart.
    const candles = falling();
    const d = detectDivergence(candles, rsiSeries(candles.map((c) => c.close)), pivots(candles), atr(candles));
    const out = compactDivergence(d, 3) as Record<string, unknown>;
    expect(out).not.toBeNull();
    expect(out.status).toBe(d.status);
    expect(typeof out.reason).toBe("string");
    expect((out.reason as string).length).toBeGreaterThan(0);
  });

  it("is null only when nothing was computed at all", () => {
    expect(compactDivergence(null, 3)).toBeNull();
  });

  it("carries both bars with their RSI when there is one", () => {
    const candles = falling();
    const d = detectDivergence(candles, rsiSeries(candles.map((c) => c.close)), pivots(candles), atr(candles));
    const out = compactDivergence(d, 3) as Record<string, unknown>;
    if (d.from && d.to) {
      expect(out.from).toMatchObject({ barsAgo: d.from.barsAgo, datetime: d.from.datetime });
      expect(out.to).toMatchObject({ barsAgo: d.to.barsAgo, datetime: d.to.datetime });
    } else {
      expect(out.from).toBeNull();
      expect(out.to).toBeNull();
    }
  });
});

describe("analyze stores the whole reading, not half of it", () => {
  it("writes the structure for every timeframe", () => {
    expect(analyze).toContain(
      "structure: structures.map((x, i) => compactStructure(timeframes[i], x.structure, decimals)),",
    );
  });

  it("writes the divergence", () => {
    expect(analyze).toContain("divergence: compactDivergence(entryDivergence, decimals),");
  });

  it("finally writes the closed-bar reading its own comment demanded", () => {
    // index.ts has said since closedSnapshots was written that "the record has
    // to keep both, or the judgement cannot be reproduced afterwards". The
    // record kept neither until now.
    expect(analyze).toContain("closed: closedSnapshots.map((snap, i) =>");
    expect(analyze).toContain("snap === null ? null : compactSnapshot(timeframes[i], snap)");
  });
});
