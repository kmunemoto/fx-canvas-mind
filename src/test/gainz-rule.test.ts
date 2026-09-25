import { describe, it, expect } from "vitest";
import {
  GA_DELTA,
  GA_REWARD,
  GA_STOP_ATR,
  chartGainz,
  compactGainz,
  gainzAt,
  planForGa,
  readGainz,
  trueRange,
} from "../../supabase/functions/analyze/gainz";
import { wilderRsi } from "../../supabase/functions/analyze/rsisar";
import type { Candle } from "../../supabase/functions/analyze/indicators";
import { GAINZ_APP, revCtxOf } from "../../research/reversal";
import { freshGainzSignals, renderSignalMail, type FiredSignal } from "../../supabase/functions/signal-alerts/logic";

const H = 3_600_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * H).toISOString().replace("T", " ").slice(0, 19);

// A slow decline (with the odd up bar, so RSI is defined), then a down bar
// and an up bar that engulfs it with a large body: every BUY condition met
// on the last bar.
const buySetup = (): Candle[] => {
  const out: Candle[] = [];
  let p = 150;
  for (let k = 0; k < 69; k++) {
    const o = p;
    const c = k % 3 === 2 ? o + 0.02 : o - 0.05;
    out.push({ datetime: stamp(k), open: o, high: Math.max(o, c) + 0.01, low: Math.min(o, c) - 0.01, close: c });
    p = c;
  }
  // the down bar
  out.push({ datetime: stamp(69), open: p, high: p + 0.005, low: p - 0.065, close: p - 0.06 });
  // the engulfing up bar: opens just under that close, closes above its open
  const o = p - 0.065;
  const c = o + 0.08;
  out.push({ datetime: stamp(70), open: o, high: c + 0.005, low: o - 0.005, close: c });
  return out;
};

// The same chart upside down: every BUY becomes a SELL
const flip = (bars: Candle[]): Candle[] =>
  bars.map((b) => ({ datetime: b.datetime, open: 300 - b.open, close: 300 - b.close, high: 300 - b.low, low: 300 - b.high }));

const walk = (n: number, seed: number): Candle[] => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let p = 150;
  for (let i = 0; i < n; i++) {
    const o = p + (rnd() - 0.5) * 0.02;
    p = o + (rnd() - 0.5) * 0.4;
    out.push({ datetime: stamp(i), open: o, high: Math.max(o, p) + rnd() * 0.1, low: Math.min(o, p) - rnd() * 0.1, close: p });
  }
  return out;
};

describe("#112 the GA-style rule", () => {
  it("fires a BUY when all four conditions meet on the close, and the mirror fires a SELL", () => {
    const bars = buySetup();
    const i = bars.length - 1;
    const { rsi } = wilderRsi(bars.map((b) => b.close));
    expect(rsi[i]!).toBeLessThan(50);
    expect(bars[i].close).toBeLessThan(bars[i - GA_DELTA].close);
    expect(gainzAt(bars, rsi, i)).toBe("BUY");
    const down = flip(bars);
    const { rsi: rsiDown } = wilderRsi(down.map((b) => b.close));
    expect(gainzAt(down, rsiDown, i)).toBe("SELL");
  });

  it("needs every condition", () => {
    const bars = buySetup();
    const i = bars.length - 1;
    const rsiOf = (b: Candle[]) => wilderRsi(b.map((x) => x.close)).rsi;
    // a long upper wick: the body is no longer more than half the true range
    const wick = bars.map((b, k) => (k === i ? { ...b, high: b.high + 0.2 } : b));
    expect(trueRange(wick, i)).toBeGreaterThan(0.2);
    expect(gainzAt(wick, rsiOf(wick), i)).toBeNull();
    // not engulfing: the up bar closes below the down bar's open
    const short = bars.map((b, k) => (k === i ? { ...b, close: bars[i - 1].open - 0.01, high: bars[i - 1].open } : b));
    expect(gainzAt(short, rsiOf(short), i)).toBeNull();
    // the bar before closed up, not down
    const upBefore = bars.map((b, k) => (k === i - 1 ? { ...b, close: b.open + 0.01, high: b.open + 0.02 } : b));
    expect(gainzAt(upBefore, rsiOf(upBefore), i)).toBeNull();
    // RSI not below 50: the same bars, read with a stretched RSI
    const rsi = rsiOf(bars).map((v, k) => (k === i ? 55 : v));
    expect(gainzAt(bars, rsi, i)).toBeNull();
    // not lower than 5 bars ago
    const flat = bars.map((b, k) => (k === i - GA_DELTA ? { ...b, close: bars[i].close - 0.01 } : b));
    expect(gainzAt(flat, rsiOf(flat), i)).toBeNull();
  });

  it("never reads a later bar, and the study reads it exactly as the app does", () => {
    const bars = walk(1500, 7);
    const full = readGainz(bars);
    expect(full.signals.length).toBeGreaterThan(10);
    for (const cut of [200, 777, 1499]) {
      const part = readGainz(bars.slice(0, cut + 1));
      const at = full.signals.find((s) => s.index === cut)?.side ?? null;
      expect(part.now!.signal, `bar ${cut}`).toBe(at);
    }
    // research/reversal.ts GAINZ_APP runs on the study's own RSI series
    const x = revCtxOf(bars);
    const { rsi } = wilderRsi(bars.map((b) => b.close));
    for (let i = 0; i < bars.length; i++) {
      const app = gainzAt(bars, rsi, i);
      expect(GAINZ_APP.at(x, i), `bar ${i}`).toBe(app === "BUY" ? 1 : app === "SELL" ? -1 : 0);
    }
  });

  it("plans a stop one ATR away and a target twice the stop, and marks the chart as its own rule", () => {
    expect(planForGa("BUY", 150, 0.3)).toEqual({ entry: 150, stop: 150 - GA_STOP_ATR * 0.3, target: 150 + GA_REWARD * GA_STOP_ATR * 0.3 });
    const sell = planForGa("SELL", 150, 0.3);
    expect(sell.stop).toBeCloseTo(150.3, 10);
    expect(sell.target).toBeCloseTo(149.4, 10);
    const read = readGainz(walk(600, 3));
    const marks = chartGainz(read, 120, 3);
    expect(marks.every((m) => m.rule === "gainz" && m.barsAgo >= 0 && m.barsAgo < 120)).toBe(true);
    const summary = compactGainz("4h", read, 3);
    expect(summary.evidence.tf.measured).toBe(true);
    expect(summary.evidence.tf.win).toBeCloseTo(0.307, 3);
    expect(compactGainz("1day", read, 3).evidence.tf.measured).toBe(false);
  });
});

describe("#112 the GA-style alert", () => {
  it("is picked up fresh with the close it was compared against", () => {
    const bars = buySetup();
    const read = readGainz(bars);
    const last = bars[bars.length - 1];
    const closeMs = Date.parse(last.datetime.replace(" ", "T") + "Z") + H;
    const fired = freshGainzSignals("USD/JPY", "1h", read, bars, closeMs + 2 * 60_000);
    expect(fired).toHaveLength(1);
    expect(fired[0].rule).toBe("gainz");
    expect(fired[0].side).toBe("BUY");
    expect(fired[0].closeThen).toBe(bars[bars.length - 1 - GA_DELTA].close);
    expect(fired[0].target - fired[0].entry).toBeCloseTo(2 * (fired[0].entry - fired[0].stop), 10);
    // stale after the freshness window
    expect(freshGainzSignals("USD/JPY", "1h", read, bars, closeMs + 30 * 60_000)).toHaveLength(0);
  });

  it("says it is the GA-style rule, how it fired, the plan, and what it was measured at", () => {
    const s: FiredSignal = {
      rule: "gainz",
      pair: "USD/JPY",
      interval: "4h",
      side: "SELL",
      barTime: "2026-09-25T00:00:00.000Z",
      closedAt: "2026-09-25T04:00:00.000Z",
      entry: 150,
      stop: 150.3,
      target: 149.4,
      rsi: 58.2,
      rsiPrev: null,
      sar: null,
      atr: 0.3,
      stability: 0.72,
      closeThen: 149.8,
      costly: false,
    };
    const ja = renderSignalMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】USD/JPY 4時間足 売り（SELL）のサイン（GA型）");
    expect(ja.text).toContain("実体が足の値幅の 72%");
    expect(ja.text).toContain("RSI(14): 58.2（50超）");
    expect(ja.text).toContain("終値 150.000 は5本前の終値（149.800）より高い");
    expect(ja.text).toContain("損切り 150.300（30.0pips・1万通貨で ¥3,000 の損失）");
    expect(ja.text).toContain("利確 149.400（60.0pips）");
    expect(ja.text).toContain("勝率は 31%（649回）");
    expect(ja.text).toContain("届いていません");
    expect(ja.text).not.toContain("パラボリックSAR:");
    const en = renderSignalMail(s, "en");
    expect(en.subject).toBe("[Sextant] USD/JPY 4-hour SELL signal (GA style)");
    expect(en.text).toContain("¥3,000 per 10,000 units");
    expect(en.text).not.toContain("undefined");
  });
});
