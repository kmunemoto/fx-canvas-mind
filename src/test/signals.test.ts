import { describe, it, expect } from "vitest";
import {
  ATR_PERIOD,
  COOLDOWN_BARS,
  ENGULF_BODY_ATR,
  MAX_STOP_WIDTH_ATR,
  MIN_BOUNCE_ATR,
  MIN_SIGNAL_BARS,
  RECENT_BARS,
  RR,
  SIGNAL_HORIZON_BARS,
  SIGNAL_RULES,
  STOP_PAD_ATR,
  TOUCH_TOL_ATR,
  WICK_MIN,
  atrSeries,
  cloudSeries,
  LONG_RUN,
  LONG_RUN_MIN_N,
  compactSignals,
  computeSignals,
  longRunLines,
  lowerBandSeries,
  mirror,
  signalLines,
  smaSeries,
  wilson,
  type Signal,
} from "../../supabase/functions/analyze/signals";
import { atr, bollinger, cloudAt, rsiSeries, sma, type Candle } from "../../supabase/functions/analyze/indicators";
import { PIVOT_BARS, pivots } from "../../supabase/functions/analyze/structure";
import { detectDivergence } from "../../supabase/functions/analyze/divergence";
import { MIN_STOP_ATR } from "../../supabase/functions/analyze/entry";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(T0 + i * HOUR).toISOString().slice(0, 19).replace("T", " "),
  open: o,
  high: h,
  low: l,
  close: c,
});

// A flat baseline with a little movement, so ATR and RSI are defined and
// nothing is degenerate. ATR settles near 0.10.
const baseline = (n: number, at = 150, from = 0): Candle[] =>
  Array.from({ length: n }, (_, k) => {
    const i = from + k;
    const drift = i % 2 === 0 ? 0.02 : -0.02;
    return bar(i, at, at + 0.05, at - 0.05, at + drift);
  });

// A seeded random walk with realistic bars: open at the previous close,
// close a normal step away, wicks a little beyond the body.
const walk = (n: number, seed = 7, start = 150, step = 0.08): Candle[] => {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out: Candle[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open + gauss() * step;
    const high = Math.max(open, close) + Math.abs(gauss()) * step * 0.4;
    const low = Math.min(open, close) - Math.abs(gauss()) * step * 0.4;
    out.push(bar(i, open, high, low, close));
  }
  return out;
};

const key = (s: Signal) =>
  `${s.index}|${s.side}|${s.rule}|${s.level.toFixed(6)}|${s.entry.toFixed(6)}|${s.stop.toFixed(6)}|${s.target.toFixed(6)}`;

describe("the causal series agree with the whole-series helpers at every bar", () => {
  const series = walk(300);

  it("atrSeries[i] is atr(prefix ending at i)", () => {
    const s = atrSeries(series);
    for (const i of [ATR_PERIOD, 40, 150, 299]) {
      expect(s[i]).toBeCloseTo(atr(series.slice(0, i + 1)) as number, 12);
    }
    expect(s[ATR_PERIOD - 1]).toBeNull();
  });

  it("smaSeries[i] is sma(prefix ending at i)", () => {
    const closes = series.map((c) => c.close);
    const s = smaSeries(closes, 20);
    for (const i of [19, 100, 299]) expect(s[i]).toBeCloseTo(sma(closes.slice(0, i + 1), 20) as number, 12);
    expect(s[18]).toBeNull();
  });

  it("lowerBandSeries[i] is bollinger(prefix ending at i).lower", () => {
    const closes = series.map((c) => c.close);
    const s = lowerBandSeries(closes);
    for (const i of [19, 77, 299]) expect(s[i]).toBeCloseTo(bollinger(closes.slice(0, i + 1))!.lower, 12);
  });

  it("cloudSeries[i] is cloudAt(candles, i)", () => {
    const s = cloudSeries(series);
    for (let i = 0; i < series.length; i += 7) {
      const expected = cloudAt(series, i);
      if (expected === null) expect(s[i]).toBeNull();
      else {
        expect(s[i]!.top).toBeCloseTo(expected.top, 12);
        expect(s[i]!.bottom).toBeCloseTo(expected.bottom, 12);
      }
    }
  });
});

describe("the mirror", () => {
  const series = walk(200, 3);
  const flipped = series.map(mirror);

  it("keeps every bar coherent and keeps ATR exactly", () => {
    for (const c of flipped) expect(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)).toBe(true);
    const a = atrSeries(series);
    const b = atrSeries(flipped);
    a.forEach((v, i) => (v === null ? expect(b[i]).toBeNull() : expect(b[i]).toBeCloseTo(v, 12)));
  });

  it("turns RSI into its complement and swaps the pivots' kinds", () => {
    const r = rsiSeries(series.map((c) => c.close));
    const m = rsiSeries(flipped.map((c) => c.close));
    r.forEach((v, i) => (v === null ? expect(m[i]).toBeNull() : expect(m[i]).toBeCloseTo(100 - v, 9)));
    // A bar can be both kinds at once (an inside bar's neighbours), and
    // pivots() lists the high first; sorted, the two lists must be one list
    const p = pivots(series).map((x) => `${x.index}:${x.kind}`).sort();
    const q = pivots(flipped).map((x) => `${x.index}:${x.kind === "high" ? "low" : "high"}`).sort();
    expect(q).toEqual(p);
  });

  it("gives the SELL side as the exact reflection of the BUY side", () => {
    const a = computeSignals(series);
    const b = computeSignals(flipped);
    const reflect = (s: Signal) => ({
      ...s,
      side: s.side === "BUY" ? "SELL" : "BUY",
      level: -s.level,
      entry: -s.entry,
      stop: -s.stop,
      target: -s.target,
    });
    expect(b.signals.map(key)).toEqual(a.signals.map(reflect).map((s) => key(s as Signal)));
    expect(b.signals.map((s) => `${s.outcome}:${s.bars}:${s.mfeR}`))
      .toEqual(a.signals.map((s) => `${s.outcome}:${s.bars}:${s.mfeR}`));
    expect(a.signals.length).toBeGreaterThan(0);
  });
});

describe("both sides fire on real prices", () => {
  // The reflection test above cannot catch a rule that is switched off on
  // whichever side sees negative prices, because that failure reflects too.
  // So: on a long series with both regimes in it, every rule that fires for
  // BUY must also have fired for SELL.
  it("names every rule on both sides over a long walk", () => {
    const series = walk(4000, 17, 150, 0.1);
    const read = computeSignals(series);
    for (const rule of ["level_reject", "ma200_reject", "ma20_pullback", "band_reentry", "cloud_reject", "engulfing"] as const) {
      const buy = read.signals.filter((s) => s.rule === rule && s.side === "BUY").length;
      const sell = read.signals.filter((s) => s.rule === rule && s.side === "SELL").length;
      expect(buy, `${rule} BUY`).toBeGreaterThan(0);
      expect(sell, `${rule} SELL`).toBeGreaterThan(0);
    }
  });
});

describe("nothing repaints", () => {
  // The whole point. A signal drawn at bar i must be decided from bars 0..i:
  // the prefix of the series ending at any k shows exactly the signals the
  // full series shows below k, priced identically. Only the OUTCOME may
  // differ, because the prefix has less future to walk.
  it("the prefix shows the same signals the full series shows below it", () => {
    const series = walk(500, 11);
    const full = computeSignals(series);
    expect(full.signals.length).toBeGreaterThan(10);
    for (const k of [120, 201, 333, 450]) {
      const part = computeSignals(series.slice(0, k));
      expect(part.signals.map(key)).toEqual(full.signals.filter((s) => s.index < k).map(key));
    }
  });

  it("fires a divergence only on the bar that confirms its second low, and only where divergence.ts agrees", () => {
    const series = walk(1500, 5, 150, 0.12);
    const full = computeSignals(series);
    const divs = full.signals.filter((s) => s.rule === "divergence" && s.side === "BUY");
    expect(divs.length).toBeGreaterThan(0);
    const rsi = rsiSeries(series.map((c) => c.close));
    for (const d of divs) {
      const prefix = series.slice(0, d.index + 1);
      const p = pivots(prefix);
      const dd = detectDivergence(prefix, rsi.slice(0, d.index + 1), p, atr(prefix));
      expect(dd.status).toBe("bullish");
      expect(dd.to!.datetime).toBe(series[d.index - PIVOT_BARS].datetime);
    }
  });
});

describe("a rejection at a confirmed low", () => {
  // Bars 0-39 sit at 150 with a pivot low at 30 (149.00, confirmed by 32),
  // bars 40-59 sit at 149.10, and bar 60 wicks down to the level and closes
  // back above it.
  const build = (wickAtr: number, after: Array<[number, number, number, number]>) => {
    const rows = baseline(40);
    rows[30] = bar(30, 149.05, 149.06, 149.0, 149.04);
    rows.push(...baseline(20, 149.1, 40));
    const aBefore = atrSeries(rows)[rows.length - 1] as number;
    const low = 149.1 - wickAtr * aBefore;
    // The level is 149.00; the wick reaches it when wickAtr*a >= 0.10
    rows.push(bar(60, 149.1, 149.12, Math.min(low, 149.0), 149.08));
    after.forEach(([o, h, l, c], k) => rows.push(bar(61 + k, o, h, l, c)));
    return rows;
  };

  it("fires on the rejection bar, priced off that bar and stopped past its low", () => {
    const rows = build(0.9, [
      [149.08, 149.15, 149.05, 149.14],
      [149.14, 149.4, 149.1, 149.35],
      [149.35, 149.4, 149.3, 149.32],
    ]);
    const read = computeSignals(rows);
    expect(read.ok).toBe(true);
    const hit = read.signals.filter((s) => s.rule === "level_reject");
    expect(hit).toHaveLength(1);
    const s = hit[0];
    const a = atrSeries(rows)[60] as number;
    expect(s.index).toBe(60);
    expect(s.side).toBe("BUY");
    expect(s.level).toBe(149.0);
    expect(s.entry).toBe(149.08);
    expect(s.stop).toBeCloseTo(rows[60].low - STOP_PAD_ATR * a, 9);
    expect(s.target).toBeCloseTo(149.08 + RR * (149.08 - s.stop), 9);
    expect(s.stopAtr).toBeGreaterThanOrEqual(MIN_STOP_ATR);
    expect(s.stopAtr).toBeLessThanOrEqual(MAX_STOP_WIDTH_ATR);
    // bar 62's high clears the target, bar 61 did not touch the stop
    expect(s.outcome).toBe("win");
    expect(s.bars).toBe(2);
    expect(s.barsAgo).toBe(3);
    // Three bars old is one bar too old to be "in force"; one bar old is not
    expect(read.recent).toEqual([]);
    const fresh = computeSignals(build(0.9, [[149.08, 149.15, 149.05, 149.14]]));
    expect(fresh.recent.map((r) => `${r.rule}:${r.barsAgo}`)).toContain("level_reject:1");
    const st = read.stats.find((x) => x.rule === "level_reject" && x.side === "BUY")!;
    expect(st).toMatchObject({ n: 1, wins: 1, losses: 0, rate: 1, expectancyR: RR, avgBars: 2 });
  });

  it("is a loss when the stop is reached first, ambiguous when both are reached in one bar", () => {
    const loss = computeSignals(build(0.9, [
      [149.08, 149.1, 148.9, 148.95],
      [148.95, 149.5, 148.9, 149.4],
    ])).signals.find((s) => s.rule === "level_reject")!;
    expect(loss.outcome).toBe("loss");
    expect(loss.bars).toBe(1);
    const both = computeSignals(build(0.9, [
      [149.08, 149.6, 148.8, 149.3],
    ])).signals.find((s) => s.rule === "level_reject")!;
    expect(both.outcome).toBe("ambiguous");
  });

  it("is open while the future is shorter than the horizon, expired once it is not", () => {
    const flat: Array<[number, number, number, number]> = Array.from({ length: 10 }, () => [149.08, 149.12, 149.05, 149.08]);
    expect(computeSignals(build(0.9, flat)).signals.find((s) => s.rule === "level_reject")!.outcome).toBe("open");
    const long: Array<[number, number, number, number]> = Array.from({ length: SIGNAL_HORIZON_BARS }, () => [149.08, 149.12, 149.05, 149.08]);
    expect(computeSignals(build(0.9, long)).signals.find((s) => s.rule === "level_reject")!.outcome).toBe("expired");
  });

  it("widens a stop under the app's floor to the floor, and refuses one over its cap", () => {
    // A small bar whose wick reaches the level: the stop it implies is under
    // MIN_STOP_ATR, and the app would not accept it, so the floor applies
    const rows = build(0.9, []).slice(0, 60);
    rows.push(bar(60, 149.04, 149.05, 149.0, 149.03));
    const s = computeSignals(rows).signals.find((x) => x.rule === "level_reject")!;
    expect(s).toBeDefined();
    expect(s.stopAtr).toBe(MIN_STOP_ATR);
    expect(s.stop).toBeCloseTo(s.entry - MIN_STOP_ATR * (atrSeries(rows)[60] as number), 9);

    // A reversal bar that pierces the level and closes far above it needs a
    // stop wider than a plan may carry: counted as such, not priced with a
    // stop the plan could not have
    const deep = build(0.9, []).slice(0, 60);
    const a59 = atrSeries(deep)[59] as number;
    deep.push(bar(60, 149.1, 149.16, 149.0 - 0.4 * a59, 149.15));
    const read = computeSignals(deep);
    expect(read.signals.some((x) => x.rule === "level_reject")).toBe(false);
    expect(read.stats.find((x) => x.rule === "level_reject" && x.side === "BUY")?.untradable).toBe(1);
  });

  it("does not fire twice inside the cooldown, and never on a level already closed through", () => {
    const rows = build(0.9, [
      [149.08, 149.12, 149.0, 149.08],
      [149.08, 149.12, 149.0, 149.08],
    ]);
    const hits = computeSignals(rows).signals.filter((s) => s.rule === "level_reject");
    expect(hits).toHaveLength(1);
    expect(COOLDOWN_BARS).toBeGreaterThan(2);

    // Close through the level between the pivot and the touch: it is not
    // support any more, so the same bar 60 is not a rejection of it
    const broken = build(0.9, []);
    broken[50] = bar(50, 149.1, 149.12, 148.5, 148.6);
    broken[51] = bar(51, 148.6, 149.15, 148.55, 149.1);
    expect(computeSignals(broken).signals.some((s) => s.rule === "level_reject")).toBe(false);
  });

  it("needs a rejecting wick, not just a touch", () => {
    const rows = build(0.9, []);
    const c = rows[60];
    // Same low, but the bar closes on it
    rows[60] = bar(60, c.open, c.high, c.low, c.low + 0.001);
    expect(computeSignals(rows).signals.some((s) => s.rule === "level_reject")).toBe(false);
    expect(WICK_MIN).toBeGreaterThan(0);
  });
});

describe("the other conditions", () => {
  it("a close back inside the Bollinger band after a close outside it", () => {
    const rows = baseline(60);
    // a close just outside the lower band, then a close back inside
    rows.push(bar(60, 150.0, 150.02, 149.88, 149.9));
    rows.push(bar(61, 149.9, 149.98, 149.88, 149.97));
    rows.push(...baseline(5, 149.95, 62));
    const closes = rows.map((c) => c.close);
    const band = lowerBandSeries(closes);
    expect(rows[60].close).toBeLessThan(band[60] as number);
    expect(rows[61].close).toBeGreaterThan(band[61] as number);
    const read = computeSignals(rows);
    const s = read.signals.find((x) => x.rule === "band_reentry");
    expect(s).toBeDefined();
    expect(s!.index).toBe(61);
    expect(s!.side).toBe("BUY");
    expect(s!.level).toBeCloseTo(band[61] as number, 12);
    // stopped past the low of the excursion, which both bars share
    expect(s!.stop).toBeCloseTo(149.88 - STOP_PAD_ATR * (atrSeries(rows)[61] as number), 9);
  });

  it("a double bottom, on the bar that confirms the second low", () => {
    const rows = baseline(60);
    const a = atrSeries(rows)[59] as number;
    // first low at 60, a peak MIN_BOUNCE_ATR+ above it, a second equal low at 70
    rows.push(bar(60, 150, 150.02, 149.6, 149.65));
    rows.push(bar(61, 149.65, 149.9, 149.62, 149.88));
    rows.push(bar(62, 149.88, 150.1, 149.85, 150.05));
    rows.push(bar(63, 150.05, 150.05 + MIN_BOUNCE_ATR * a + 0.3, 150.0, 150.05 + MIN_BOUNCE_ATR * a + 0.2));
    rows.push(bar(64, rows[63].close, rows[63].close + 0.02, rows[63].close - 0.1, rows[63].close - 0.08));
    rows.push(bar(65, rows[64].close, rows[64].close + 0.02, rows[64].close - 0.1, rows[64].close - 0.08));
    rows.push(bar(66, rows[65].close, rows[65].close + 0.02, rows[65].close - 0.1, rows[65].close - 0.08));
    rows.push(bar(67, rows[66].close, rows[66].close + 0.02, rows[66].close - 0.1, rows[66].close - 0.08));
    rows.push(bar(68, rows[67].close, rows[67].close + 0.02, 149.75, 149.78));
    rows.push(bar(69, 149.78, 149.8, 149.66, 149.7));
    rows.push(bar(70, 149.7, 149.72, 149.6, 149.68)); // the second low, equal to the first
    rows.push(bar(71, 149.68, 149.72, 149.65, 149.7));
    rows.push(bar(72, 149.7, 149.74, 149.68, 149.72));
    rows.push(...baseline(3, 149.72, 73));
    const read = computeSignals(rows);
    const s = read.signals.find((x) => x.rule === "double_pivot");
    expect(s).toBeDefined();
    expect(s!.index).toBe(70 + PIVOT_BARS);
    expect(s!.level).toBe(149.6);
    expect(s!.stop).toBeCloseTo(149.6 - STOP_PAD_ATR * (atrSeries(rows)[72] as number), 9);
  });

  it("an engulfing bar at a level", () => {
    const rows = baseline(40);
    rows[30] = bar(30, 149.05, 149.06, 149.0, 149.04);
    rows.push(...baseline(20, 149.06, 40));
    const a = atrSeries(rows)[59] as number;
    // a red bar, then a green bar that opens below its close, closes above
    // its open, with a body over ENGULF_BODY_ATR, low on the level
    rows[59] = bar(59, 149.08, 149.09, 149.03, 149.04);
    rows.push(bar(60, 149.03, 149.04 + ENGULF_BODY_ATR * a + 0.05, 149.0, 149.04 + ENGULF_BODY_ATR * a + 0.02));
    const read = computeSignals(rows);
    const s = read.signals.find((x) => x.rule === "engulfing");
    expect(s).toBeDefined();
    expect(s!.index).toBe(60);
    expect(s!.level).toBe(149.0);
  });

  it("refuses a series too short to read", () => {
    const read = computeSignals(baseline(MIN_SIGNAL_BARS - 1));
    expect(read.ok).toBe(false);
    expect(read.reason).toMatch(/too_few_bars/);
    expect(read.signals).toEqual([]);
  });
});

describe("counting", () => {
  it("wilson", () => {
    const ci = wilson(6, 9)!;
    expect(ci.lo).toBeCloseTo(0.354, 2);
    expect(ci.hi).toBeCloseTo(0.879, 2);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(0, 5)!.lo).toBe(0);
    expect(wilson(5, 5)!.hi).toBeCloseTo(1, 9);
  });

  it("every rule is named for both sides, and the trend lines run through the last two swings", () => {
    const series = walk(400, 21);
    const read = computeSignals(series);
    const p = pivots(series);
    const lows = p.filter((x) => x.kind === "low");
    const line = read.lines.find((l) => l.kind === "lows")!;
    expect(line.from.datetime).toBe(lows[lows.length - 2].datetime);
    expect(line.to.datetime).toBe(lows[lows.length - 1].datetime);
    const a = lows[lows.length - 2], b = lows[lows.length - 1];
    expect(line.slopePerBar).toBeCloseTo((b.price - a.price) / (b.index - a.index), 12);
    expect(line.now).toBeCloseTo(b.price + line.slopePerBar * (series.length - 1 - b.index), 12);
    expect(SIGNAL_RULES).toHaveLength(8);
    expect(RECENT_BARS).toBe(3);
    expect(TOUCH_TOL_ATR).toBeLessThan(MIN_STOP_ATR);
  });

  it("renders the prompt block with the rate, the interval, the conditions in force and the break-even rate", () => {
    const series = walk(400, 21);
    const read = computeSignals(series);
    const text = signalLines(read, 3);
    expect(text).toContain("反発の実績(サーバ計算・確定足400本");
    expect(text).toMatch(/\d+勝\d+敗=\d+%/);
    expect(text).toMatch(/95%CI \d+%-\d+%/);
    expect(text).toContain("損益分岐は的中率40%");
    expect(text).toContain("直近3本で成立した条件:");
    const refused = signalLines(computeSignals(baseline(10)), 3);
    expect(refused).toContain("判定保留");
  });

  it("prints the long run beside the window, and says when there is none", () => {
    const line = longRunLines("1h", "USD/JPY");
    // The measured row, as measured: 99 of 247 at a confirmed low on 1h
    expect(line).toContain("確定安値での反発(BUY) 40%[34%-46%] n=247");
    expect(line).toContain("2025-09-23〜2026-09-25");
    expect(line).toContain("損益分岐（40%）");
    // Rows under the floor are not printed: 1 divergence is not a rate
    expect(line).not.toContain("強気ダイバージェンス確定(BUY)");
    expect(LONG_RUN["1h"].rows.divergence!.BUY[0]).toBeLessThan(LONG_RUN_MIN_N);
    expect(longRunLines("1h", "EUR/USD")).toContain("EUR/USD は未計測");
    expect(longRunLines("1week", "USD/JPY")).toContain("1week は未計測");
    // every row is a count: wins never exceed decided
    for (const run of Object.values(LONG_RUN)) {
      for (const row of Object.values(run.rows)) {
        expect(row.BUY[1]).toBeLessThanOrEqual(row.BUY[0]);
        expect(row.SELL[1]).toBeLessThanOrEqual(row.SELL[0]);
      }
    }
  });

  it("stores the counts and the conditions in force, rounded, and never the whole list", () => {
    const series = walk(400, 21);
    const read = computeSignals(series);
    const row = compactSignals("1h", read, 3) as Record<string, unknown>;
    expect(row.tf).toBe("1h");
    expect(row.ok).toBe(true);
    expect(row).not.toHaveProperty("signals");
    const stats = row.stats as Array<Record<string, unknown>>;
    expect(stats.length).toBe(read.stats.length);
    for (const st of stats) {
      if (typeof st.rate === "number") expect(String(st.rate).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
    }
    const recent = row.recent as Array<Record<string, unknown>>;
    expect(recent.length).toBe(read.recent.length);
    const refused = compactSignals("1h", computeSignals(baseline(10)), 3) as Record<string, unknown>;
    expect(refused).toEqual({ tf: "1h", ok: false, reason: "too_few_bars:10", bars: 10 });
  });
});
