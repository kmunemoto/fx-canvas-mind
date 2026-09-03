import { describe, it, expect } from "vitest";
import {
  parseCandles,
  sma,
  emaSeries,
  rsi,
  macd,
  bollinger,
  atr,
  stochastic,
  adx,
  ichimoku,
  swingLevels,
  computeSnapshot,
  type Candle,
} from "../../supabase/functions/analyze/indicators.ts";

const flat = (n: number, price = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    datetime: `t${i}`,
    open: price,
    high: price,
    low: price,
    close: price,
  }));

const trend = (n: number, start = 100, step = 1): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const close = start + i * step;
    return {
      datetime: `t${i}`,
      open: close - step,
      high: close + Math.abs(step) * 0.5,
      low: close - Math.abs(step) * 1.5,
      close,
    };
  });

describe("parseCandles", () => {
  it("reverses newest-first rows into oldest-first numbers", () => {
    const parsed = parseCandles([
      { datetime: "b", open: "2", high: "3", low: "1", close: "2.5" },
      { datetime: "a", open: "1", high: "2", low: "0.5", close: "1.5" },
    ]);
    expect(parsed.map((c) => c.datetime)).toEqual(["a", "b"]);
    expect(parsed[1].close).toBe(2.5);
  });

  it("drops malformed rows and non-arrays", () => {
    expect(parseCandles(null)).toEqual([]);
    expect(parseCandles([{ open: "x", high: "1", low: "1", close: "1" }])).toEqual([]);
  });
});

describe("sma / emaSeries", () => {
  it("computes a simple average over the last period", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2], 3)).toBeNull();
  });

  it("EMA of a constant series stays constant", () => {
    const series = emaSeries(Array(30).fill(5), 10);
    expect(series[29]).toBeCloseTo(5, 10);
    expect(series[8]).toBeNull();
  });
});

describe("rsi", () => {
  it("matches the classic Wilder reference dataset", () => {
    // Wilder reference dataset: first RSI(14) = 70.53 (verified by hand:
    // avg gain 0.2385, avg loss 0.0996 over the first 14 changes)
    const closes = [
      44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
      45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282,
    ];
    expect(rsi(closes)).toBeCloseTo(70.53, 1);
  });

  it("is 100 for straight gains and near 0 for straight losses", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(up)).toBe(100);
    expect(rsi(down)!).toBeLessThan(1);
  });

  it("needs period+1 closes", () => {
    expect(rsi(Array(14).fill(1))).toBeNull();
  });
});

describe("macd", () => {
  it("is zero on a constant series", () => {
    const r = macd(Array(60).fill(100));
    expect(r!.macd).toBeCloseTo(0, 10);
    expect(r!.signal).toBeCloseTo(0, 10);
    expect(r!.hist).toBeCloseTo(0, 10);
  });

  it("is positive in a steady uptrend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    expect(macd(closes)!.macd).toBeGreaterThan(0);
  });
});

describe("bollinger", () => {
  it("collapses to the mean on constant prices", () => {
    const r = bollinger(Array(25).fill(50));
    expect(r!.upper).toBeCloseTo(50);
    expect(r!.lower).toBeCloseTo(50);
  });

  it("upper > middle > lower with variance", () => {
    const closes = Array.from({ length: 25 }, (_, i) => 50 + (i % 2));
    const r = bollinger(closes)!;
    expect(r.upper).toBeGreaterThan(r.middle);
    expect(r.middle).toBeGreaterThan(r.lower);
  });
});

describe("atr", () => {
  it("equals the constant candle range", () => {
    const candles = Array.from({ length: 30 }, (_, i) => ({
      datetime: `t${i}`,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
    }));
    expect(atr(candles)).toBeCloseTo(2, 8);
  });
});

describe("stochastic", () => {
  it("approaches 100 when closes ride the highs", () => {
    const r = stochastic(trend(40));
    expect(r!.slowK).toBeGreaterThan(70);
    expect(r!.slowD).toBeGreaterThan(70);
  });

  it("is 50 on a dead-flat range", () => {
    const r = stochastic(flat(40));
    expect(r!.slowK).toBe(50);
  });
});

describe("adx", () => {
  it("is high in a persistent trend and low when flat", () => {
    expect(adx(trend(80))!).toBeGreaterThan(25);
    expect(adx(flat(80))!).toBeLessThan(5);
  });
});

describe("ichimoku", () => {
  it("all lines equal price on constant candles", () => {
    const r = ichimoku(flat(60))!;
    expect(r.tenkan).toBe(100);
    expect(r.kijun).toBe(100);
    expect(r.spanA).toBe(100);
    expect(r.spanB).toBe(100);
  });
});

describe("swingLevels", () => {
  it("finds an isolated peak and trough", () => {
    const candles = flat(20);
    candles[10] = { datetime: "t10", open: 100, high: 110, low: 100, close: 105 };
    candles[15] = { datetime: "t15", open: 100, high: 100, low: 90, close: 95 };
    const r = swingLevels(candles);
    expect(r.highs).toContain(110);
    expect(r.lows).toContain(90);
  });
});

describe("computeSnapshot", () => {
  it("fills every field given enough candles", () => {
    const snap = computeSnapshot(trend(250))!;
    expect(snap.price).toBe(100 + 249);
    expect(snap.rsi).not.toBeNull();
    expect(snap.macdHist).not.toBeNull();
    expect(snap.sma200).not.toBeNull();
    expect(snap.adx).not.toBeNull();
    expect(snap.spanB).not.toBeNull();
    expect(snap.atrPct).toBeGreaterThan(0);
  });

  it("degrades to nulls on short series instead of throwing", () => {
    const snap = computeSnapshot(trend(10))!;
    expect(snap.price).toBe(109);
    expect(snap.sma200).toBeNull();
    expect(snap.adx).toBeNull();
  });
});

describe("candle budget the edge function must fetch", () => {
  // Regression: an attempt to cut the function's runtime lowered the entry
  // timeframe from 250 candles to 150. Wall clock was unaffected (the fetch
  // is one HTTP call either way) but sma(closes, 200) silently returned null,
  // so SMA200 disappeared from the model's prompt with no error anywhere.
  const synth = (n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => ({
      datetime: `2026-09-03 ${String(i % 24).padStart(2, "0")}:00:00`,
      open: 150 + Math.sin(i / 8),
      high: 150.2 + Math.sin(i / 8),
      low: 149.8 + Math.sin(i / 8),
      close: 150.1 + Math.sin(i / 8),
    }));

  it("produces SMA200 at 250 candles and loses it at 150", () => {
    const closes = (n: number) => synth(n).map((c) => c.close);
    expect(sma(closes(250), 200)).not.toBeNull();
    expect(sma(closes(150), 200)).toBeNull();
  });

  it("computeSnapshot reports sma200 only when the series is long enough", () => {
    expect(computeSnapshot(synth(250))?.sma200).not.toBeNull();
    expect(computeSnapshot(synth(150))?.sma200).toBeNull();
  });
});
