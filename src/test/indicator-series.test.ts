import { describe, it, expect } from "vitest";
import {
  RULES,
  bollingerSeries,
  cciSeries,
  crossDown,
  crossUp,
  donchianSeries,
  ichimokuSeries,
  macdSeries,
  mirrored,
  psarSeries,
  rciSeries,
  signalsOf,
  smaSeries,
  stochSeries,
} from "../../research/indicator-series";
import { bollinger, cloudAt, ichimoku, macd, sma, stochastic, type Candle } from "../../supabase/functions/analyze/indicators";

const T0 = Date.parse("2026-01-05T00:00:00Z");

// mulberry32, a proper 32-bit generator
const rng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const walk = (n: number, seed = 3): Candle[] => {
  const r = rng(seed);
  const out: Candle[] = [];
  let px = 150;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = o + (r() - 0.5) * 0.2;
    out.push({
      datetime: new Date(T0 + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      open: o,
      high: Math.max(o, px) + r() * 0.05,
      low: Math.min(o, px) - r() * 0.05,
      close: px,
    });
  }
  return out;
};

describe("the study's indicators are the app's indicators", () => {
  const c = walk(400);
  const closes = c.map((x) => x.close);

  it("SMA, MACD and Bollinger end on the value the analysis prints", () => {
    expect(smaSeries(closes, 25)[399]).toBeCloseTo(sma(closes, 25) as number, 10);
    const m = macdSeries(closes);
    const ref = macd(closes)!;
    expect(m.macd[399]).toBeCloseTo(ref.macd, 10);
    expect(m.signal[399]).toBeCloseTo(ref.signal, 10);
    // and at an earlier bar, from the prefix
    const refMid = macd(closes.slice(0, 201))!;
    expect(m.signal[200]).toBeCloseTo(refMid.signal, 10);
    const b = bollingerSeries(closes);
    const bref = bollinger(closes)!;
    expect(b.upper[399]).toBeCloseTo(bref.upper, 10);
    expect(b.lower[399]).toBeCloseTo(bref.lower, 10);
  });

  it("stochastic and Ichimoku match, including the cloud standing at a bar", () => {
    const s = stochSeries(c);
    const sref = stochastic(c)!;
    expect(s.k[399]).toBeCloseTo(sref.slowK, 10);
    expect(s.d[399]).toBeCloseTo(sref.slowD, 10);
    const i = ichimokuSeries(c);
    const iref = ichimoku(c)!;
    expect(i.tenkan[399]).toBeCloseTo(iref.tenkan, 10);
    expect(i.kijun[399]).toBeCloseTo(iref.kijun, 10);
    for (const idx of [120, 399]) {
      const cloud = cloudAt(c, idx)!;
      expect(i.cloudTop[idx]).toBeCloseTo(cloud.top, 10);
      expect(i.cloudBottom[idx]).toBeCloseTo(cloud.bottom, 10);
    }
  });

  it("never reads a later bar", () => {
    const full = signalsOf(c);
    const part = signalsOf(c.slice(0, 301));
    for (const r of RULES) expect(Array.from(part[r.id].slice(250, 301)), r.id).toEqual(Array.from(full[r.id].slice(250, 301)));
  });
});

describe("the indicators the app does not have yet", () => {
  it("RCI is +100 on a steady rise, -100 on a steady fall, and averages ties", () => {
    const up = Array.from({ length: 12 }, (_, i) => 100 + i);
    expect(rciSeries(up, 9)[11]).toBeCloseTo(100, 10);
    expect(rciSeries(up.map((x) => -x), 9)[11]).toBeCloseTo(-100, 10);
    expect(rciSeries(up, 9)[7]).toBeNull();
    const flat = Array.from({ length: 9 }, () => 1);
    // every close tied: price ranks all 5, time ranks 1..9, sum d^2 = 60
    expect(rciSeries(flat, 9)[8]).toBeCloseTo((1 - (6 * 60) / (9 * 80)) * 100, 10);
  });

  it("Parabolic SAR stays under a rise and flips on the bar that breaks it", () => {
    const bars: Candle[] = [];
    for (let i = 0; i < 30; i++) bars.push({ datetime: String(i), open: 100 + i, high: 100.5 + i, low: 99.5 + i, close: 100 + i });
    // a sharp fall through the SAR
    bars.push({ datetime: "30", open: 129, high: 129, low: 110, close: 111 });
    const p = psarSeries(bars);
    for (let i = 2; i < 30; i++) {
      expect(p.long[i]).toBe(true);
      expect(p.sar[i]!).toBeLessThan(bars[i].low);
    }
    expect(p.long[30]).toBe(false);
    // it restarts at the highest high of the rise
    expect(p.sar[30]).toBe(129.5);
  });

  it("CCI is zero at the average and Donchian includes its own bar", () => {
    const bars = walk(60, 5);
    const cci = cciSeries(bars);
    expect(cci[18]).toBeNull();
    expect(Number.isFinite(cci[40] as number)).toBe(true);
    const dc = donchianSeries(bars);
    expect(dc.high[59]).toBe(Math.max(...bars.slice(40).map((b) => b.high)));
    expect(dc.low[59]).toBe(Math.min(...bars.slice(40).map((b) => b.low)));
  });

  it("a cross needs both bars, and the two directions are mirrors", () => {
    expect(crossUp([1, 3], 2, 1)).toBe(true);
    expect(crossUp([2, 3], 2, 1)).toBe(true);
    expect(crossUp([3, 4], 2, 1)).toBe(false);
    expect(crossUp([null, 3], 2, 1)).toBe(false);
    expect(crossDown([3, 1], 2, 1)).toBe(true);
    expect(crossDown([-1, -3], -2, 1)).toBe(crossUp([1, 3], 2, 1));
  });
});

describe("every rule's sell is its buy upside down", () => {
  // If a rule's SELL were written with a different threshold or a strict/
  // non-strict slip, one side would be judged on a different rule and the
  // pooled win rate would say nothing about the indicator.
  for (const seed of [11, 12]) {
    const c = walk(1500, seed);
    const up = signalsOf(c);
    const down = signalsOf(mirrored(c));
    for (const r of RULES) {
      it(`${r.id} (seed ${seed})`, () => {
        const buys = Array.from(up[r.id]).flatMap((v, i) => (v === 1 ? [i] : []));
        const mirroredSells = Array.from(down[r.id]).flatMap((v, i) => (v === -1 ? [i] : []));
        expect(buys.length).toBeGreaterThan(3);
        expect(mirroredSells).toEqual(buys);
      });
    }
  }
});
