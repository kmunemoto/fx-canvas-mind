import { describe, it, expect } from "vitest";
import { REVERSALS, revCtxOf, reversalClose, rsiSarAt, tradeR } from "../../research/reversal";
import { mirrored } from "../../research/indicator-series";
import { BASES, PARTNERS, ctxOf } from "../../research/rsi-combos";
import type { Candle } from "../../supabase/functions/analyze/indicators";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const T0 = Date.parse("2026-01-05T00:00:00Z");
const M15 = 15 * 60_000;

const rng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed: number): Candle[] => {
  const r = rng(seed);
  const out: Candle[] = [];
  let px = 150;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = o + (r() - 0.5) * 0.3;
    out.push({ datetime: stamp(i), open: o, high: Math.max(o, px) + r() * 0.05, low: Math.min(o, px) - r() * 0.05, close: px });
  }
  return out;
};

const RULES = [...REVERSALS.map((r) => ({ id: r.id, at: r.at })), { id: "rsi_sar", at: rsiSarAt }];

describe("the readings of the video", () => {
  const c = walk(3000, 3);
  const x = revCtxOf(c);

  it("fire on a random walk, a SELL only on a reversal close and a BUY only on its mirror", () => {
    for (const rule of REVERSALS) {
      let sells = 0;
      let buys = 0;
      for (let i = 1; i < c.length; i++) {
        const d = rule.at(x, i);
        if (d === -1) {
          sells++;
          expect(reversalClose(c, i, -1), `${rule.id} SELL at ${i}`).toBe(true);
          expect(c[i].close).toBeLessThan(c[i].open);
          expect(c[i].close).toBeLessThan(c[i - 1].low);
        }
        if (d === 1) {
          buys++;
          expect(c[i].close).toBeGreaterThan(c[i].open);
          expect(c[i].close).toBeGreaterThan(c[i - 1].high);
        }
      }
      expect(sells, rule.id).toBeGreaterThan(5);
      expect(buys, rule.id).toBeGreaterThan(5);
    }
  });

  it("treat both sides alike: the chart turned upside down swaps every BUY for a SELL", () => {
    const m = revCtxOf(mirrored(c));
    for (const rule of RULES) {
      for (let i = 1; i < c.length; i++) {
        // (0 - x, not -x: -0 is not 0 to toBe)
        expect(rule.at(m, i), `${rule.id} at ${i}`).toBe(0 - rule.at(x, i));
      }
    }
  });

  it("never read a later bar", () => {
    for (const cut of [300, 777, 1500, 2999]) {
      const part = revCtxOf(c.slice(0, cut + 1));
      for (const rule of RULES) {
        for (let i = cut - 20; i <= cut; i++) expect(rule.at(part, i), `${rule.id} at ${i}/${cut}`).toBe(rule.at(x, i));
      }
    }
  });

  it("the app's rule is the #103 study's bounce + SAR, bar for bar", () => {
    const ctx = ctxOf(c, c.map(() => null));
    const bounce = BASES.find((b) => b.id === "bounce")!;
    const psar = PARTNERS.find((p) => p.id === "psar")!;
    for (let i = 1; i < c.length; i++) {
      const d = bounce.at(ctx, i);
      const study = d !== 0 && psar.bounce.ok(ctx, i, d) ? d : 0;
      expect(rsiSarAt(x, i)).toBe(study);
    }
  });
});

// ---- R ---------------------------------------------------------------------------------

const q = (i: number, mid: { o: number; h: number; l: number; c: number }, spread = 0.02): QuoteCandle => {
  const half = spread / 2;
  const side = (s: number) => ({ datetime: stamp(i), open: mid.o + s, high: mid.h + s, low: mid.l + s, close: mid.c + s });
  return { datetime: stamp(i), bid: side(-half), ask: side(half) };
};
const flat = (i: number, px: number) => q(i, { o: px, h: px + 0.01, l: px - 0.01, c: px });

describe("what a trade earned, in R", () => {
  const spec = { stopAtr: 1, rr: 2, horizon: 5 };
  // entry bar 0 at mid 100 (ask 100.01, bid 99.99), ATR 1: a BUY stops at
  // 99.01 and targets 102.01, both read on the bid
  it("a target reached pays the ratio, a stop reached costs one", () => {
    const win = [flat(0, 100), flat(1, 100.5), q(2, { o: 100.5, h: 102.1, l: 100.4, c: 102 })];
    expect(tradeR(win, 0, 1, "BUY", spec, M15)).toEqual({ outcome: "win", r: 2 });
    const loss = [flat(0, 100), q(1, { o: 100, h: 100.2, l: 98.9, c: 99 })];
    expect(tradeR(loss, 0, 1, "BUY", spec, M15)).toEqual({ outcome: "loss", r: -1 });
    // the mirror for a SELL, entered on the bid and closed on the ask
    const sellWin = [flat(0, 100), q(1, { o: 100, h: 100.1, l: 97.9, c: 98 })];
    expect(tradeR(sellWin, 0, 1, "SELL", spec, M15)).toEqual({ outcome: "win", r: 2 });
  });

  it("a trade neither level took is closed at the horizon, on the side it would really close on", () => {
    const bars = [flat(0, 100), ...[1, 2, 3, 4, 5].map((i) => flat(i, 100.5)), flat(6, 100)];
    const r = tradeR(bars, 0, 1, "BUY", spec, M15)!;
    expect(r.outcome).toBe("expired");
    // bought at 100.01 on the ask, sold at 100.49 on the bid, 1 ATR = 1 R
    expect(r.r).toBeCloseTo(0.48, 10);
    const s = tradeR(bars, 0, 1, "SELL", spec, M15)!;
    // sold at 99.99 on the bid, bought back at 100.51 on the ask
    expect(s.r).toBeCloseTo(-0.52, 10);
  });

  it("a trade whose horizon runs past the history is not counted", () => {
    const bars = [flat(0, 100), flat(1, 100.2), flat(2, 100.1)];
    expect(tradeR(bars, 0, 1, "BUY", spec, M15)).toBeNull();
  });

  it("a bar that reached both levels is counted as a loss", () => {
    const both = [flat(0, 100), q(1, { o: 100, h: 102.5, l: 98.5, c: 100 })];
    expect(tradeR(both, 0, 1, "BUY", spec, M15)).toEqual({ outcome: "ambiguous", r: -1 });
  });
});
