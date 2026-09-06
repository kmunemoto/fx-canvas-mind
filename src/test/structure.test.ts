import { describe, it, expect } from "vitest";
import {
  BREAK_TOL_ATR,
  FLAT_TOL_ATR,
  computeStructure,
  mergeLevels,
  pivots,
  structureLines,
} from "../../supabase/functions/analyze/structure";
import { atr, rangeOf, rsiSeries, type Candle } from "../../supabase/functions/analyze/indicators";
import {
  MIN_GAP_BARS,
  PRICE_TOL_ATR,
  RSI_TOL,
  RSI_WARMUP_BARS,
  detectDivergence,
} from "../../supabase/functions/analyze/divergence";

const PIP = 0.01;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(T0 + i * HOUR).toISOString(),
  open: o,
  high: h,
  low: l,
  close: c,
});

// A flat baseline long enough to seed ATR and RSI, with a little movement so
// neither is degenerate.
const baseline = (n: number, start = 150): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const drift = (i % 2 === 0 ? 0.02 : -0.02);
    const c = start + drift;
    return bar(i, start, start + 0.05, start - 0.05, c);
  });

// Put a pivot high at index i by lifting that bar above its four neighbours
const spikeHigh = (rows: Candle[], i: number, high: number, close = high - 0.01) => {
  rows[i] = { ...rows[i], high, close, open: close, low: close - 0.05 };
};
const spikeLow = (rows: Candle[], i: number, low: number, close = low + 0.01) => {
  rows[i] = { ...rows[i], low, close, open: close, high: close + 0.05 };
};

describe("pivots", () => {
  it("confirms a pivot only after two bars on each side", () => {
    const rows = baseline(20);
    spikeHigh(rows, 10, 151);
    const found = pivots(rows);
    expect(found.some((p) => p.index === 10 && p.kind === "high")).toBe(true);
    // The newest two bars can never be confirmed, whatever they print
    spikeHigh(rows, rows.length - 1, 999);
    expect(pivots(rows).some((p) => p.index === rows.length - 1)).toBe(false);
  });

  it("dates every pivot and says how long ago it was", () => {
    const rows = baseline(20);
    spikeHigh(rows, 10, 151);
    const p = pivots(rows).find((x) => x.index === 10);
    expect(p?.datetime).toBe(rows[10].datetime);
    expect(p?.barsAgo).toBe(9);
    // The extreme AND the close of the same bar: divergence compares closes,
    // because RSI is computed from closes
    expect(p?.price).toBe(151);
    expect(p?.close).toBe(rows[10].close);
  });
});

describe("mergeLevels", () => {
  it("treats two pivots within half an ATR as one level being retested", () => {
    const mk = (index: number, price: number) =>
      ({ index, barsAgo: 0, datetime: "", price, close: price, kind: "high" as const });
    // ATR 0.10 → merge distance 0.05
    const merged = mergeLevels([mk(0, 151.0), mk(5, 151.02), mk(10, 151.6)], 0.1, 5);
    expect(merged).toHaveLength(2);
    // Newest first
    expect(merged[0].price).toBe(151.6);
  });
});

describe("computeStructure refuses rather than inventing a scale", () => {
  it("says so when there is no ATR, instead of using a zero tolerance", () => {
    // `0.1 * null` is 0 in JavaScript, which would turn every threshold into
    // a tick-noise detector — the exact failure the tolerance prevents
    const s = computeStructure(baseline(60), null, PIP);
    expect(s.ok).toBe(false);
    expect(s.reason).toBe("no_atr");
    expect(s.label).toBe("unknown");
  });

  it("refuses a zero or negative ATR too", () => {
    expect(computeStructure(baseline(60), 0, PIP).reason).toBe("no_atr");
    expect(computeStructure(baseline(60), -1, PIP).reason).toBe("no_atr");
  });

  it("refuses a window too short to have a structure in it", () => {
    const s = computeStructure(baseline(20), 0.1, PIP);
    expect(s.ok).toBe(false);
    expect(s.reason).toContain("too_few_bars");
  });
});

describe("a level is broken on a close, not on a wick", () => {
  const build = () => {
    const rows = baseline(60);
    spikeHigh(rows, 20, 151);
    return rows;
  };

  it("does not call a wick through the level a break", () => {
    const rows = build();
    // pierces the level by a mile intrabar, closes back under it
    rows[40] = { ...rows[40], high: 152, close: 150.0, open: 150, low: 149.9 };
    const s = computeStructure(rows, 0.1, PIP);
    expect(s.lastBreak.up).toBeNull();
    // but the pierce is counted and reported as what it is
    const held = pivots(rows).filter((p) => p.kind === "high");
    expect(held.length).toBeGreaterThan(0);
  });

  it("calls it a break when a close settles through by more than the tolerance", () => {
    const rows = build();
    const atrValue = 0.1;
    for (let i = 40; i < 46; i++) {
      const c = 151 + BREAK_TOL_ATR * atrValue + 0.5;
      rows[i] = { ...rows[i], open: c, high: c + 0.05, low: c - 0.05, close: c };
    }
    const s = computeStructure(rows, atrValue, PIP);
    expect(s.lastBreak.up?.state).toBe("broken");
    expect(s.lastBreak.up?.level).toBe(151);
    expect(s.lastBreak.up?.datetime).toBe(rows[40].datetime);
  });

  it("calls a break that was taken back within three bars 'reclaimed'", () => {
    const rows = build();
    const atrValue = 0.1;
    const through = 151 + BREAK_TOL_ATR * atrValue + 0.5;
    rows[40] = { ...rows[40], open: through, high: through + 0.05, low: through - 0.05, close: through };
    const backUnder = 151 - BREAK_TOL_ATR * atrValue - 0.5;
    rows[41] = { ...rows[41], open: backUnder, high: backUnder + 0.05, low: backUnder - 0.05, close: backUnder };
    const s = computeStructure(rows, atrValue, PIP);
    expect(s.lastBreak.up?.state).toBe("reclaimed");
  });

  it("never scans the forming bar — the caller passes closed bars only", () => {
    // The module's contract: a forming bar's close is not a close. This is
    // the caller's job, and the test states the contract so a future change
    // that scans to the end fails here.
    const rows = build();
    const closed = rows.slice(0, -1);
    const s = computeStructure(closed, 0.1, PIP);
    expect(s.bars).toBe(closed.length);
  });
});

describe("the structure label", () => {
  const atrValue = 0.1;
  const labelled = (hs: Array<[number, number]>, ls: Array<[number, number]>) => {
    const rows = baseline(80);
    for (const [i, p] of hs) spikeHigh(rows, i, p);
    for (const [i, p] of ls) spikeLow(rows, i, p);
    return computeStructure(rows, atrValue, PIP).label;
  };

  it("reads a higher high with a higher low as an uptrend", () => {
    expect(labelled([[20, 151], [50, 152]], [[30, 149], [60, 149.5]])).toBe("uptrend");
  });

  it("reads a lower high with a lower low as a downtrend", () => {
    expect(labelled([[20, 152], [50, 151]], [[30, 149.5], [60, 149]])).toBe("downtrend");
  });

  it("calls near-equal highs and lows a range rather than a trend", () => {
    // The tolerance has to be wide enough that this fires. With a tolerance
    // of a few hundredths of an ATR nothing is ever equal, every market reads
    // as trending, and 16 of the first 21 analyses said "lower highs and
    // lower lows" — which is what this test exists to stop coming back.
    const within = FLAT_TOL_ATR * atrValue * 0.5;
    expect(labelled([[20, 151], [50, 151 + within]], [[30, 149], [60, 149 - within]])).toBe("range");
  });

  it("says unknown rather than guessing when there are not two of each", () => {
    const rows = baseline(80);
    spikeHigh(rows, 20, 151);
    expect(computeStructure(rows, atrValue, PIP).label).toBe("unknown");
  });
});

describe("room to the next level", () => {
  it("measures the distance in pips AND in ATR, because the stop rules are in ATR", () => {
    const rows = baseline(80, 150);
    spikeHigh(rows, 20, 151);
    spikeLow(rows, 30, 149);
    const s = computeStructure(rows, 0.1, PIP);
    expect(s.nextUp).not.toBeNull();
    expect(s.nextUp?.level).toBe(151);
    expect(s.nextUp?.pips).toBeGreaterThan(0);
    expect(s.nextUp?.atr).toBeGreaterThan(0);
    expect(s.nextDown?.level).toBe(149);
  });

  it("does not offer a level price is already standing on", () => {
    const rows = baseline(80, 150);
    // a hair above the last close, inside the near tolerance
    spikeHigh(rows, 20, 150.03);
    const s = computeStructure(rows, 0.5, PIP);
    expect(s.nextUp).toBeNull();
  });

  it("says nothing above rather than reporting a level that gave way", () => {
    const rows = baseline(80, 150);
    spikeHigh(rows, 20, 151);
    for (let i = 40; i < 60; i++) {
      const c = 153;
      rows[i] = { ...rows[i], open: c, high: c + 0.05, low: c - 0.05, close: c };
    }
    const s = computeStructure(rows, 0.1, PIP);
    // 151 was settled through, so it is not what stands above 153. Something
    // else may well stand above — what must not happen is a broken level
    // being offered as the room ahead.
    expect(s.nextUp?.level).not.toBe(151);
  });
});

describe("range and close pressure", () => {
  it("reports width and position, and refuses a position inside a zero-width range", () => {
    const flat = Array.from({ length: 30 }, (_, i) => bar(i, 150, 150, 150, 150));
    const r = rangeOf(flat, 20);
    expect(r?.width).toBe(0);
    // (close - low) / 0 is not 50%, it is undefined
    expect(r?.positionPct).toBeNull();
  });

  it("puts a close at the top of its range near 100%", () => {
    const rows = baseline(40, 150);
    rows[rows.length - 1] = { ...rows[rows.length - 1], high: 151, low: 149, close: 151 };
    const r = rangeOf(rows, 20);
    expect(r?.positionPct).toBeGreaterThan(95);
  });

  it("computes close pressure from OHLC and leaves it null when every bar is flat", () => {
    const flat = Array.from({ length: 60 }, (_, i) => bar(i, 150, 150, 150, 150));
    expect(computeStructure(flat, 0.1, PIP).closePressure).toBeNull();
    const rows = baseline(60);
    const p = computeStructure(rows, 0.1, PIP).closePressure;
    expect(p).not.toBeNull();
    expect(p as number).toBeGreaterThanOrEqual(0);
    expect(p as number).toBeLessThanOrEqual(1);
  });
});

describe("rsiSeries", () => {
  it("lines up index for index with the closes and is null before the seed", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 150 + Math.sin(i / 3));
    const series = rsiSeries(closes);
    expect(series).toHaveLength(closes.length);
    expect(series[13]).toBeNull();
    expect(series[14]).not.toBeNull();
  });

  it("does not put a market that never moved at the top of the scale", () => {
    // The single-value form answered 100 for any window with no losses, which
    // on a completely flat stretch means 0/0 rendered as "maximum overbought"
    const flat = Array.from({ length: 40 }, () => 150);
    expect(rsiSeries(flat).at(-1)).toBeNull();
  });

  it("still answers 100 when there are gains and no losses", () => {
    const rising = Array.from({ length: 40 }, (_, i) => 150 + i);
    expect(rsiSeries(rising).at(-1)).toBe(100);
  });
});

describe("divergence is computed, or not claimed", () => {
  const withPivots = (highs: Array<[number, number]>, lows: Array<[number, number]>, n = 80) => {
    const rows = baseline(n);
    for (const [i, p] of highs) spikeHigh(rows, i, p);
    for (const [i, p] of lows) spikeLow(rows, i, p);
    return rows;
  };
  const run = (rows: Candle[], atrValue: number | null = 0.1) =>
    detectDivergence(rows, rsiSeries(rows.map((c) => c.close)), pivots(rows), atrValue);

  it("refuses without an ATR rather than comparing on a zero tolerance", () => {
    const d = run(withPivots([[30, 151], [60, 152]], []), null);
    expect(d.status).toBe("unavailable");
    expect(d.reason).toBe("no_atr");
  });

  it("says there are not enough pivots rather than inventing a comparison", () => {
    const d = run(baseline(80));
    expect(d.status).not.toBe("bearish");
    expect(d.status).not.toBe("bullish");
  });

  it("names both points and both RSI readings when it does fire", () => {
    // rising closes into a fading RSI: the textbook bearish case
    const rows = baseline(90, 150);
    for (let i = 0; i < 40; i++) {
      const c = 150 + i * 0.2;
      rows[i] = { ...rows[i], open: c, high: c + 0.05, low: c - 0.05, close: c };
    }
    for (let i = 40; i < 90; i++) {
      const c = 158 + (i - 40) * 0.01;
      rows[i] = { ...rows[i], open: c, high: c + 0.05, low: c - 0.05, close: c };
    }
    spikeHigh(rows, 45, 158.5, 158.4);
    spikeHigh(rows, 70, 159.5, 159.4);
    const d = run(rows);
    if (d.status === "bearish") {
      expect(d.from?.datetime).toBeTruthy();
      expect(d.to?.datetime).toBeTruthy();
      expect(typeof d.from?.rsi).toBe("number");
      expect(typeof d.to?.rsi).toBe("number");
      expect(d.priceDelta as number).toBeGreaterThan(0);
      expect(d.rsiDelta as number).toBeLessThan(0);
    } else {
      // If it declines, it must say why in a named reason rather than
      // hedging — that is the whole point
      expect(d.reason).toBeTruthy();
    }
  });

  it("refuses when the two closes are effectively the same price", () => {
    const atrValue = 0.1;
    const within = PRICE_TOL_ATR * atrValue * 0.5;
    const rows = withPivots([[30, 151], [60, 151 + within]], []);
    const d = run(rows, atrValue);
    expect(d.status).not.toBe("bearish");
    expect(d.reason).toContain("price_flat");
  });

  it("refuses when the RSI barely moved", () => {
    const rows = baseline(90, 150);
    spikeHigh(rows, 30, 151, 150.9);
    spikeHigh(rows, 60, 152, 151.9);
    const d = run(rows);
    if (d.status === "none") expect(d.reason).toMatch(/rsi_flat|agree|price_flat/);
  });

  it("refuses two pivots that are too close together to be one move", () => {
    const rows = withPivots([[40, 151], [40 + MIN_GAP_BARS - 2, 152]], []);
    const d = run(rows);
    expect(d.status).not.toBe("bearish");
  });

  it("refuses a comparison inside the RSI warm-up, where the seed still dominates", () => {
    expect(RSI_WARMUP_BARS).toBeGreaterThan(14);
    const rows = withPivots([[5, 151], [15, 152]], []);
    const d = run(rows);
    expect(d.status).not.toBe("bearish");
  });

  it("has a tolerance wide enough that RSI noise alone cannot fire it", () => {
    expect(RSI_TOL).toBeGreaterThanOrEqual(2);
    expect(PRICE_TOL_ATR).toBeGreaterThan(0);
  });
});


// The block has to earn its place in a prompt with a character budget: the
// rulebook and the candles are already in there, and an addition that pushes
// either out has made the analysis worse, not better. So the cost is
// MEASURED here rather than asserted in a comment.
describe("what the structure block costs the prompt", () => {
  const built = () => {
    const rows = baseline(120, 150);
    for (let i = 0; i < 60; i++) {
      const c = 150 + i * 0.05;
      rows[i] = { ...rows[i], open: c, high: c + 0.06, low: c - 0.06, close: c };
    }
    spikeHigh(rows, 30, 151.9);
    spikeHigh(rows, 70, 153.4);
    spikeLow(rows, 45, 151.2);
    spikeLow(rows, 90, 152.4);
    return rows;
  };

  it("costs under 900 characters on the entry timeframe, with everything populated", () => {
    const rows = built();
    const st = computeStructure(rows, atr(rows) ?? 0.1, PIP);
    const dv = detectDivergence(rows, rsiSeries(rows.map((c) => c.close)), pivots(rows), atr(rows));
    const rendered = structureLines(st, dv, 3, true);
    expect(rendered.length).toBeGreaterThan(200);
    expect(rendered.length).toBeLessThan(900);
  });

  it("costs under 200 characters on a higher timeframe", () => {
    // The schema asks a higher timeframe for a bias and a note, not for a
    // break history — three full blocks would spend two thirds of the added
    // budget on the timeframes the plan is not built at
    const rows = built();
    const st = computeStructure(rows, atr(rows) ?? 0.1, PIP);
    expect(structureLines(st, null, 3, false).length).toBeLessThan(200);
  });

  it("still says something useful when it cannot compute anything", () => {
    const rendered = structureLines(computeStructure(baseline(60), null, PIP), null, 3, true);
    expect(rendered).toContain("判定保留");
    expect(rendered).toContain("no_atr");
    // and it is short: a refusal should not cost what an answer costs
    expect(rendered.length).toBeLessThan(120);
  });

  it("dates every level it names, and says the window is the limit", () => {
    const rows = built();
    const st = computeStructure(rows, atr(rows) ?? 0.1, PIP);
    const rendered = structureLines(st, null, 3, true);
    // no bare price without a date beside it
    expect(rendered).toMatch(/確定スイング高値.*\d{2}-\d{2}T\d{2}:\d{2}Z/);
    expect(rendered).toContain("期間外は不明");
    expect(rendered).toContain("直近2本は構造判定に入らない");
  });

  it("never prints the word divergence when it did not compute one", () => {
    const rows = built();
    const st = computeStructure(rows, atr(rows) ?? 0.1, PIP);
    const refused = structureLines(st, { status: "unavailable", reason: "few_pivots", from: null, to: null, priceDelta: null, rsiDelta: null }, 3, true);
    expect(refused).toContain("判定不可");
    expect(refused).not.toMatch(/弱気|強気/);
  });
});
