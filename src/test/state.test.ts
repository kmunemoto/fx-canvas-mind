import { describe, it, expect } from "vitest";
import {
  FEATURES,
  LEVELS,
  OWN_FEATURES,
  adxSeries,
  alignHigher,
  ownStateSeries,
  stateNow,
  stateSeries,
  trendSeries,
} from "../../supabase/functions/analyze/state";
import { adx, type Candle } from "../../supabase/functions/analyze/indicators";

const T0 = Date.parse("2026-01-05T00:00:00Z"); // a Monday
const MIN15 = 15 * 60_000;
const HOUR = 60 * 60_000;

// mulberry32: a proper 32-bit generator. A plain-double LCG overflows 2^53
// and produces structured series (#100 found this the hard way).
const rng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const walk = (n: number, stepMs: number, seed = 3, drift = 0): Candle[] => {
  const r = rng(seed);
  const out: Candle[] = [];
  let px = 150;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = o + (r() - 0.5) * 0.2 + drift;
    const h = Math.max(o, px) + r() * 0.05;
    const l = Math.min(o, px) - r() * 0.05;
    out.push({ datetime: new Date(T0 + i * stepMs).toISOString().slice(0, 19).replace("T", " "), open: o, high: h, low: l, close: px });
  }
  return out;
};

describe("the state of a bar", () => {
  it("reads ADX with the same arithmetic the prompt prints", () => {
    const c = walk(300, HOUR);
    const series = adxSeries(c);
    expect(series[series.length - 1].adx).toBeCloseTo(adx(c) as number, 10);
    const part = c.slice(0, 120);
    expect(adxSeries(part)[119].adx).toBeCloseTo(adx(part) as number, 10);
  });

  it("never reads the future: the prefix gives the rows the full series gives", () => {
    const c = walk(700, HOUR, 9);
    const full = ownStateSeries(c, HOUR);
    for (const k of [60, 211, 450, 699]) {
      const part = ownStateSeries(c.slice(0, k + 1), HOUR);
      expect(part[k]).toEqual(full[k]);
    }
    const tFull = trendSeries(c);
    expect(trendSeries(c.slice(0, 300))[299]).toBe(tFull[299]);
  });

  it("only ever produces the declared levels", () => {
    const c = walk(900, MIN15, 21);
    const rows = stateSeries([
      { candles: c, intervalMs: MIN15 },
      { candles: walk(300, HOUR, 22), intervalMs: HOUR },
      { candles: walk(100, 4 * HOUR, 23), intervalMs: 4 * HOUR },
    ]);
    for (const row of rows) {
      for (const f of FEATURES) {
        const v = row[f];
        if (v !== null) expect(LEVELS[f], `${f}=${v}`).toContain(v);
      }
    }
    // after warm-up every own feature is filled
    const late = rows[rows.length - 1];
    for (const f of OWN_FEATURES) expect(late[f], f).not.toBeNull();
  });

  it("names a steady rise as a rise", () => {
    const c = walk(400, HOUR, 5, 0.05);
    const row = ownStateSeries(c, HOUR)[399];
    expect(row.ma50).toBe("above");
    expect(row.ma200).toBe("above");
    expect(row.slope50).toBe("up");
    expect(trendSeries(c)[399]).toBe("up");
    const fall = ownStateSeries(walk(400, HOUR, 5, -0.05), HOUR)[399];
    expect(fall.ma50).toBe("below");
    expect(fall.slope50).toBe("down");
  });

  it("uses a higher bar only once it has closed", () => {
    // entry 15min bars from 00:00; higher 1h bars from 00:00
    const entry = walk(8, MIN15);
    const higher = walk(3, HOUR);
    const values = ["h0", "h1", "h2"];
    const got = alignHigher(entry, MIN15, higher, HOUR, values);
    // the 1h bar 00:00-01:00 is known from the entry bar that closes at 01:00
    // (00:45-01:00, index 3), not before
    expect(got.slice(0, 3)).toEqual([null, null, null]);
    expect(got[3]).toBe("h0");
    expect(got[6]).toBe("h0");
    expect(got[7]).toBe("h1");
  });

  it("reads the present as the research read the past", () => {
    const rungs = [
      { candles: walk(500, HOUR, 31), intervalMs: HOUR },
      { candles: walk(200, 4 * HOUR, 32), intervalMs: 4 * HOUR },
      { candles: walk(120, 24 * HOUR, 33), intervalMs: 24 * HOUR },
    ];
    const rows = stateSeries(rungs);
    expect(stateNow(rungs)).toEqual(rows[rows.length - 1]);
    expect(stateNow([])).toBeNull();
  });
});
