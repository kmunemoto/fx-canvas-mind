// #291 (docs §8.112): the owner's video's way — the low (high) taken, then EMA
// 20 crossing EMA 80 — as the chart and the gold 1-minute email decide it
// (supabase/functions/_shared/sweep-cross.ts).
//
//   1. hand examples: a buy shaped as the video's (a wave down, up, down
//      below the last trough, up), the same without the low taken, a sell
//      (the mirror), and a cross too close to the window's start
//   2. the rule written again here, apart from the module (its own lines, its
//      own search for the crosses), on a seeded random walk: every bar, the
//      same decisions
//   3. the email's decision (the newest bar on its 600 closed bars) is the
//      chart's mark at that bar; a bar's decision does not change with what
//      comes after it
import { describe, expect, it } from "vitest";
import {
  SWEEPX,
  SWEEPX_MIN_WINDOW,
  sweepCrossMarks,
  sweepCrossNewest,
  sweepCrossOnWindow,
  sweepPip,
  type SweepBar,
} from "@/lib/sweepCross";

const bar = (close: number, wick = 0.5): SweepBar => ({ high: close + wick, low: close - wick, close });

// closes along straight legs: [from, to, bars] each, the first leg's first close `from`
const legs = (start: number, parts: Array<[number, number]>): number[] => {
  const out: number[] = [];
  let prev = start;
  for (const [to, n] of parts) {
    for (let k = 1; k <= n; k++) out.push(prev + ((to - prev) * k) / n);
    prev = to;
  }
  return out;
};

// ---- the rule again, written apart from the module -------------------------------------

const refEma = (xs: number[], n: number): Array<number | null> => {
  const out: Array<number | null> = xs.map(() => null);
  if (xs.length < n) return out;
  let e = 0;
  for (let k = 0; k < n; k++) e += xs[k];
  e /= n;
  out[n - 1] = e;
  const a = 2 / (n + 1);
  for (let k = n; k < xs.length; k++) {
    e = a * xs[k] + (1 - a) * e;
    out[k] = e;
  }
  return out;
};

interface Ref {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tps: [number, number];
  level: number;
  extreme: number;
}

// the decision at the last bar of w
const refDecide = (w: SweepBar[], pip: number): Ref | null => {
  const c = w.length - 1;
  if (c < 241) return null;
  const closes = w.map((b) => b.close);
  const f = refEma(closes, 20);
  const s = refEma(closes, 80);
  const ups: number[] = [];
  const downs: number[] = [];
  for (let k = 1; k < w.length; k++) {
    const [a, b, x, y] = [f[k - 1], s[k - 1], f[k], s[k]];
    if (a === null || b === null || x === null || y === null) continue;
    if (a <= b && x > y) ups.push(k);
    else if (a >= b && x < y) downs.push(k);
  }
  const buy = ups.includes(c);
  const sell = downs.includes(c);
  if (!buy && !sell) return null;
  const others = (buy ? downs : ups).filter((k) => k >= 240 && k < c);
  if (others.length < 2) return null;
  const leg = others[others.length - 1];
  const wave = others[others.length - 2];
  const lows = (from: number, to: number) => w.slice(from, to).map((b) => b.low);
  const highs = (from: number, to: number) => w.slice(from, to).map((b) => b.high);
  const entry = w[c].close;
  if (buy) {
    const level = Math.min(...lows(wave, leg));
    const extreme = Math.min(...lows(leg, c + 1));
    if (!(extreme < level)) return null;
    const sl = Math.min(...lows(Math.max(0, c - 4), c + 1)) - pip;
    return { side: "BUY", entry, sl, tps: [entry + 15 * pip, entry + 20 * pip], level, extreme };
  }
  const level = Math.max(...highs(wave, leg));
  const extreme = Math.max(...highs(leg, c + 1));
  if (!(extreme > level)) return null;
  const sl = Math.max(...highs(Math.max(0, c - 4), c + 1)) + pip;
  return { side: "SELL", entry, sl, tps: [entry - 15 * pip, entry - 20 * pip], level, extreme };
};

// a seeded walk (mulberry32): 1-minute gold-like bars
const walk = (n: number, seed: number, start = 4000): SweepBar[] => {
  let t = seed >>> 0;
  const rnd = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const out: SweepBar[] = [];
  let p = start;
  for (let k = 0; k < n; k++) {
    const o = p;
    p = Math.round((p + (rnd() - 0.5) * 1.6) * 100) / 100;
    const hi = Math.round((Math.max(o, p) + rnd() * 0.6) * 100) / 100;
    const lo = Math.round((Math.min(o, p) - rnd() * 0.6) * 100) / 100;
    out.push({ high: hi, low: lo, close: p });
  }
  return out;
};

// ---- 1. hand examples ---------------------------------------------------------------------

// 400 flat bars, then the video's shape: down to 1990, up to 2010, down to 1985 (below the
// trough at 1990: the low taken), up to 2005
const videoShape = (secondLow: number) =>
  legs(2000, [[2000, 400], [1990, 80], [2010, 100], [secondLow, 100], [2005, 120]]).map((c) => bar(c));

describe("#291 the low taken, then EMA 20 crossing EMA 80 (hand examples)", () => {
  it("a pip: $0.10 on gold (the owner's choice), 0.01 on a yen pair, 0.0001 on another", () => {
    expect(sweepPip("XAU/USD")).toBe(0.1);
    expect(sweepPip("USD/JPY")).toBe(0.01);
    expect(sweepPip("EUR/USD")).toBe(0.0001);
  });

  it("the video's buy: the first up cross after the leg went below the last trough", () => {
    const bars = videoShape(1985);
    const marks = sweepCrossMarks(bars, 0.1, 600);
    expect(marks.length).toBe(1);
    const m = marks[0];
    expect(m.side).toBe("BUY");
    expect(m.full).toBe(true);
    // the last wave's trough: the low of the bar the first leg ended on (1990, its low 1989.5)
    expect(m.level).toBeCloseTo(1989.5, 9);
    expect(m.levelAt).toBe(400 + 80 - 1);
    // the leg's lowest: 1985's bar (its low 1984.5)
    expect(m.extreme).toBeCloseTo(1984.5, 9);
    expect(m.extremeAt).toBe(400 + 80 + 100 + 100 - 1);
    // entered at the cross bar's close; the stop a pip ($0.10) below the last five bars' lowest
    // low; the targets $1.50 and $2.00 above the entry
    const lows = bars.slice(m.at - 4, m.at + 1).map((b) => b.low);
    expect(m.entry).toBe(bars[m.at].close);
    expect(m.sl).toBeCloseTo(Math.min(...lows) - 0.1, 9);
    expect(m.tps[0]).toBeCloseTo(m.entry + 1.5, 9);
    expect(m.tps[1]).toBeCloseTo(m.entry + 2.0, 9);
    // the crosses: the leg's (d) inside the second fall, the wave's (d') inside the first
    expect(m.legFrom).toBeGreaterThan(400 + 80 + 100);
    expect(m.legFrom).toBeLessThan(400 + 80 + 100 + 100);
    // (the flat lines part on the first falling bar: the wave's cross is that bar, 400)
    expect(m.waveFrom).toBe(400);
    // and the email, judging that bar on its 600 closed bars, says the same
    const mail = sweepCrossNewest(bars.slice(0, m.at + 1), 0.1);
    expect(mail?.side).toBe("BUY");
    expect(mail?.entry).toBe(m.entry);
    expect(mail?.sl).toBe(m.sl);
  });

  it("the same shape, the second fall stopping above the trough (1992): no signal", () => {
    expect(sweepCrossMarks(videoShape(1992), 0.1, 600)).toEqual([]);
  });

  it("a sell: the mirror of the buy (the high taken), mirrored levels", () => {
    const buy = videoShape(1985);
    const sell = buy.map((b) => ({ high: 4000 - b.low, low: 4000 - b.high, close: 4000 - b.close }));
    const [b] = sweepCrossMarks(buy, 0.1, 600);
    const marks = sweepCrossMarks(sell, 0.1, 600);
    expect(marks.length).toBe(1);
    const s = marks[0];
    expect(s.side).toBe("SELL");
    expect(s.at).toBe(b.at);
    expect(s.level).toBeCloseTo(4000 - b.level, 9);
    expect(s.sl).toBeCloseTo(4000 - b.sl, 9);
    expect(s.tps[0]).toBeCloseTo(4000 - b.tps[0], 9);
    expect(s.tps[1]).toBeCloseTo(4000 - b.tps[1], 9);
  });

  it("the earlier cross within the window's first 240 bars: not counted, so no signal", () => {
    // the same shape on 160 flat bars: the window (600 bars ending at the cross) starts at the
    // first bar, and the first fall's cross is before its bar 240
    const bars = legs(2000, [[2000, 160], [1990, 80], [2010, 100], [1985, 100], [2005, 120]]).map((c) => bar(c));
    expect(sweepCrossMarks(bars, 0.1, 0)).toEqual([]);
    // the rule written again agrees: no bar fires
    for (let i = SWEEPX_MIN_WINDOW - 1; i < bars.length; i++) expect(refDecide(bars.slice(0, i + 1), 0.1)).toBeNull();
  });

  it("no bar is judged on fewer than SWEEPX_MIN_WINDOW bars; the email needs its 600", () => {
    const bars = videoShape(1985);
    expect(SWEEPX_MIN_WINDOW).toBe(SWEEPX.warm + 60);
    expect(sweepCrossNewest(bars.slice(0, SWEEPX.window - 1), 0.1)).toBeNull();
    expect(sweepCrossOnWindow(bars.slice(0, SWEEPX.warm + 1), 0.1)).toBeNull();
  });
});

// ---- 2, 3. the rule again on random walks ------------------------------------------------------

describe("#291 the module against the rule written again (seeded random walks)", () => {
  it("every bar of three walks: the same decisions, with the same entry, stop, targets and levels", () => {
    let compared = 0;
    let fired = 0;
    for (const seed of [1, 2, 3]) {
      const bars = walk(2400, seed);
      const marks = new Map(sweepCrossMarks(bars, 0.1, 599).map((m) => [m.at, m]));
      for (let i = 599; i < bars.length; i++) {
        const ref = refDecide(bars.slice(i - 599, i + 1), 0.1);
        const m = marks.get(i);
        compared++;
        if (ref === null) {
          expect(m).toBeUndefined();
          continue;
        }
        fired++;
        expect(m).toBeDefined();
        expect(m?.full).toBe(true);
        expect(m?.side).toBe(ref.side);
        expect(m?.entry).toBe(ref.entry);
        expect(m?.sl).toBeCloseTo(ref.sl, 9);
        expect(m?.tps[0]).toBeCloseTo(ref.tps[0], 9);
        expect(m?.tps[1]).toBeCloseTo(ref.tps[1], 9);
        expect(m?.level).toBe(ref.level);
        expect(m?.extreme).toBe(ref.extreme);
      }
    }
    expect(compared).toBe(3 * (2400 - 599));
    // the walks must fire for the comparison to mean anything
    expect(fired).toBeGreaterThan(5);
  });

  it("the email's decision at the newest bar is the chart's mark there; later bars change nothing before them", () => {
    const bars = walk(1800, 7);
    const marks = sweepCrossMarks(bars, 0.1, 599);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      const mail = sweepCrossNewest(bars.slice(0, m.at + 1), 0.1);
      expect(mail).not.toBeNull();
      expect(mail?.side).toBe(m.side);
      expect(mail?.entry).toBe(m.entry);
      expect(mail?.sl).toBe(m.sl);
      expect(mail?.tps).toEqual(m.tps);
      // the bars after it replaced: the mark stays
      const changed = [...bars.slice(0, m.at + 1), ...walk(200, 99, bars[m.at].close)];
      const again = sweepCrossMarks(changed, 0.1, m.at).find((x) => x.at === m.at);
      expect(again?.side).toBe(m.side);
      expect(again?.sl).toBe(m.sl);
    }
  });
});
