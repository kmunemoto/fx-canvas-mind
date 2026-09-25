import { describe, it, expect } from "vitest";
import {
  BUY_LEVEL,
  HORIZON_BARS,
  REWARD_RATIO,
  RSI_SAR_EVIDENCE,
  SELL_LEVEL,
  STOP_ATR,
  chartRsiSar,
  closeForRsi,
  compactRsiSar,
  nextSar,
  parabolicSar,
  planFor,
  readRsiSar,
  rsiSarLines,
  wilderRsi,
} from "../../supabase/functions/analyze/rsisar";
import { rsiSeries, type Candle } from "../../supabase/functions/analyze/indicators";
import { psarSeries } from "../../research/indicator-series";
import { BASES, PARTNERS, ctxOf } from "../../research/rsi-combos";

const T0 = Date.parse("2026-01-05T00:00:00Z");
const H = 3_600_000;

const rng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const dt = (i: number) => new Date(T0 + i * H).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed: number, step = 0.2): Candle[] => {
  const r = rng(seed);
  const out: Candle[] = [];
  let px = 150;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = o + (r() - 0.5) * step;
    out.push({ datetime: dt(i), open: o, high: Math.max(o, px) + r() * 0.05, low: Math.min(o, px) - r() * 0.05, close: px });
  }
  return out;
};
// the next bar, closing at `close`, as tight around its open and close as a bar can be
const barTo = (prev: Candle, i: number, close: number): Candle => ({
  datetime: dt(i),
  open: prev.close,
  high: Math.max(prev.close, close) + 1e-7,
  low: Math.min(prev.close, close) - 1e-7,
  close,
});

describe("the two lines are the ones the study measured", () => {
  const c = walk(1200, 7);
  const closes = c.map((x) => x.close);

  it("RSI is the app's RSI, value for value", () => {
    const mine = wilderRsi(closes).rsi;
    const app = rsiSeries(closes);
    expect(mine).toEqual(app);
  });

  it("the SAR is the study's SAR, bar for bar", () => {
    const mine = parabolicSar(c);
    const study = psarSeries(c);
    expect(mine.sar).toEqual(study.sar);
    expect(mine.long).toEqual(study.long);
  });

  it("the rule fires on exactly the bars the study counted as bounce + SAR", () => {
    // The rule is rare — about one signal per few hundred bars, as in the
    // study — so the count is checked over all three walks together.
    let total = 0;
    for (const seed of [7, 8, 9]) {
      const bars = walk(3000, seed);
      const read = readRsiSar(bars);
      const ctx = ctxOf(bars, bars.map(() => null));
      const bounce = BASES.find((b) => b.id === "bounce")!;
      const psar = PARTNERS.find((p) => p.id === "psar")!;
      const study: string[] = [];
      for (let i = 1; i < bars.length; i++) {
        const d = bounce.at(ctx, i);
        if (d !== 0 && psar.bounce.ok(ctx, i, d)) study.push(`${i}:${d === 1 ? "BUY" : "SELL"}`);
      }
      // the read drops a signal only where the ATR has not formed yet
      const mine = read.signals.map((s) => `${s.index}:${s.side}`);
      expect(mine).toEqual(study.filter((k) => Number(k.split(":")[0]) >= 14));
      total += mine.length;
    }
    expect(total).toBeGreaterThan(10);
  });
});

describe("the close that moves RSI to a level", () => {
  it("lands RSI on the level, from above and from below", () => {
    const closes = walk(300, 11).map((x) => x.close);
    for (const cut of [60, 120, 200, 299]) {
      const part = closes.slice(0, cut + 1);
      const { rsi, gain, loss } = wilderRsi(part);
      for (const target of [30, 50, 70]) {
        const close = closeForRsi(part[cut], gain[cut]!, loss[cut]!, target)!;
        const after = wilderRsi([...part, close]).rsi[cut + 1]!;
        expect(after).toBeCloseTo(target, 8);
        // and the direction: a little above the close gives a higher RSI
        const above = wilderRsi([...part, close + 1e-4]).rsi[cut + 1]!;
        expect(above).toBeGreaterThan(target);
        expect(rsi[cut]).not.toBeNull();
      }
    }
  });
});

describe("the SAR the next bar is measured against", () => {
  it("holds when the next bar stays on its side and flips when it trades through", () => {
    const c = walk(400, 21);
    for (const cut of [100, 150, 220, 399]) {
      const part = c.slice(0, cut + 1);
      const s = parabolicSar(part);
      const nx = nextSar(part, s)!;
      const last = part[cut];
      // a bar that keeps well clear of the level
      const clear = nx.long
        ? { datetime: dt(cut + 1), open: last.close, high: last.close + 0.01, low: Math.max(nx.level + 1e-6, last.close - 0.01), close: last.close }
        : { datetime: dt(cut + 1), open: last.close, high: Math.min(nx.level - 1e-6, last.close + 0.01), low: last.close - 0.01, close: last.close };
      const held = parabolicSar([...part, clear]);
      expect(held.long[cut + 1]).toBe(nx.long);
      expect(held.sar[cut + 1]).toBeCloseTo(nx.level, 10);
      // a bar that trades through it
      const through = nx.long
        ? { ...clear, low: nx.level - 0.001 }
        : { ...clear, high: nx.level + 0.001 };
      expect(parabolicSar([...part, through]).long[cut + 1]).toBe(!nx.long);
    }
  });
});

describe("the triggers", () => {
  // Every prefix of a long walk on which a side is ready: closing just beyond
  // the complete-close fires the rule, closing just short of it does not.
  it("a close beyond the complete-close fires the rule, one short of it does not", () => {
    const c = walk(4000, 31, 0.3);
    let checked = 0;
    for (let cut = 100; cut < c.length - 1 && checked < 40; cut += 3) {
      const part = c.slice(0, cut + 1);
      const read = readRsiSar(part);
      if (!read.ok || !read.next) continue;
      for (const tr of [read.next.buy, read.next.sell]) {
        if (!tr.ready || tr.completeClose === null) continue;
        const dir = tr.side === "BUY" ? 1 : -1;
        const eps = 1e-5;
        const fired = readRsiSar([...part, barTo(part[cut], cut + 1, tr.completeClose + dir * eps)]);
        expect(fired.now?.signal, `${tr.side} at ${cut}`).toBe(tr.side);
        const short = readRsiSar([...part, barTo(part[cut], cut + 1, tr.completeClose - dir * eps)]);
        expect(short.now?.signal, `${tr.side} short at ${cut}`).not.toBe(tr.side);
        // the plan it would publish is the app's geometry around that close
        expect(tr.plan!.entry).toBe(tr.completeClose);
        expect(Math.abs(tr.plan!.target - tr.plan!.entry) / Math.abs(tr.plan!.stop - tr.plan!.entry)).toBeCloseTo(REWARD_RATIO, 10);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("a side that is not ready says which close would make it ready", () => {
    const c = walk(600, 41);
    const read = readRsiSar(c);
    const buy = read.next!.buy;
    const sell = read.next!.sell;
    const rsi = read.now!.rsi;
    expect(buy.ready).toBe(rsi <= BUY_LEVEL);
    expect(sell.ready).toBe(rsi >= SELL_LEVEL);
    for (const tr of [buy, sell]) {
      if (tr.ready) continue;
      expect(tr.completeClose).toBeNull();
      expect(tr.plan).toBeNull();
      const next = readRsiSar([...c, barTo(c[c.length - 1], c.length, tr.rsiClose!)]);
      expect(next.now!.rsi).toBeCloseTo(tr.side === "BUY" ? BUY_LEVEL : SELL_LEVEL, 6);
    }
  });
});

describe("past signals", () => {
  it("are priced the app's way and settled by walking the bars after them", () => {
    const read = readRsiSar(walk(3000, 51));
    expect(read.signals.length).toBeGreaterThan(3);
    for (const s of read.signals) {
      const dir = s.side === "BUY" ? 1 : -1;
      expect((s.entry - s.stop) * dir).toBeCloseTo(STOP_ATR * s.atr, 10);
      expect((s.target - s.entry) * dir).toBeCloseTo(STOP_ATR * s.atr * REWARD_RATIO, 10);
      if (s.outcome === "win" || s.outcome === "loss" || s.outcome === "ambiguous") expect(s.bars).toBeGreaterThan(0);
      if (s.outcome === "expired") expect(s.index + HORIZON_BARS).toBeLessThanOrEqual(read.bars - 1);
    }
  });

  it("settles a hand-made BUY", () => {
    expect(planFor("BUY", 100, 1)).toEqual({ entry: 100, stop: 99.2, target: 101.2 });
    expect(planFor("SELL", 100, 1)).toEqual({ entry: 100, stop: 100.8, target: 98.8 });
  });

  it("refuses to read a series too short to have formed", () => {
    const read = readRsiSar(walk(40, 3));
    expect(read.ok).toBe(false);
    expect(read.now).toBeNull();
    expect(rsiSarLines(read, 3, true)).toContain("算出不能");
  });
});

describe("what leaves the server", () => {
  const c = walk(700, 61);
  const read = readRsiSar(c);

  it("the chart gets the lines and the marks inside its window only", () => {
    const chart = chartRsiSar(read, 120, 3);
    expect(chart.rsi).toHaveLength(120);
    expect(chart.sar).toHaveLength(120);
    expect(chart.sar_below).toHaveLength(120);
    const first = c[c.length - 120].datetime;
    for (const m of chart.marks) {
      expect(m.datetime >= first).toBe(true);
      expect(m.rule).toBe("rsi_sar");
    }
  });

  it("the summary carries the reading, the triggers and the evidence for the timeframe", () => {
    const s = compactRsiSar("15min", read, 3);
    expect(s.now?.signal === null || s.now?.signal === "BUY" || s.now?.signal === "SELL").toBe(true);
    expect(s.next?.buy.side).toBe("BUY");
    expect(s.evidence.tf).toEqual(RSI_SAR_EVIDENCE.byTf["15min"]);
    expect(compactRsiSar("1min", read, 3).evidence.tf.measured).toBe(false);
    expect(s.evidence.breakeven.win).toBe(0.4);
  });

  it("the analyst's lines quote the reading and, on the entry rung, the triggers", () => {
    const entry = rsiSarLines(read, 3, true);
    expect(entry).toContain("RSI(14)");
    expect(entry).toContain("パラボリックSAR");
    expect(entry).toContain("次の足で条件がそろう価格");
    expect(rsiSarLines(read, 3, false)).not.toContain("次の足で条件がそろう価格");
    // nothing else
    for (const other of ["MACD", "ボリンジャー", "一目", "ADX", "SMA", "ストキャス"]) expect(entry).not.toContain(other);
  });
});

describe("when the next bar closes", () => {
  it("is two steps after the newest closed bar opened, and says when that is a costly hour", async () => {
    const { nextCloseOf } = await import("../../supabase/functions/analyze/rsisar");
    const bars = walk(200, 71).map((b, i) => ({ ...b, datetime: new Date(Date.parse("2026-01-05T00:00:00Z") + i * 15 * 60_000).toISOString().slice(0, 19).replace("T", " ") }));
    const read = readRsiSar(bars);
    const next = nextCloseOf("15min", read)!;
    // bar 199 opened at 00:00 + 199*15min = 49:45 -> next closes at 50:15 = Jan 7 02:15 UTC
    expect(next.at).toBe("2026-01-07T02:15:00.000Z");
    expect(next.costly).toBe(false);
    const late = readRsiSar(bars.slice(0, 81)); // bar 80 opens 20:00, next closes 20:30 UTC
    expect(nextCloseOf("15min", late)!.costly).toBe(true);
    expect(nextCloseOf("4h", late)!.costly).toBe(false);
    expect(nextCloseOf("5min", late)).toBeNull();
  });
});
