import { describe, it, expect } from "vitest";
import { BASES, PARTNERS, ctxOf, htfTrend, type Ctx, type Dir } from "../../research/rsi-combos";
import { mirrored } from "../../research/indicator-series";
import { alignHigher } from "../../supabase/functions/analyze/state";
import type { Candle } from "../../supabase/functions/analyze/indicators";

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

const walk = (n: number, stepMs: number, seed: number): Candle[] => {
  const r = rng(seed);
  const out: Candle[] = [];
  let px = 150;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = o + (r() - 0.5) * 0.2;
    out.push({
      datetime: new Date(T0 + i * stepMs).toISOString().slice(0, 19).replace("T", " "),
      open: o,
      high: Math.max(o, px) + r() * 0.05,
      low: Math.min(o, px) - r() * 0.05,
      close: px,
    });
  }
  return out;
};

// 1h entry bars and a 4h rung built from them, as the study builds them
const fourHour = (c: Candle[]): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i + 4 <= c.length; i += 4) {
    const g = c.slice(i, i + 4);
    out.push({ datetime: g[0].datetime, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[3].close });
  }
  return out;
};

const ctxFor = (entry: Candle[]): Ctx => {
  const higher = fourHour(entry);
  return ctxOf(entry, alignHigher(entry, H, higher, 4 * H, htfTrend(higher)));
};

// For every bar where a base fires on `side`, the partners that agree
const agreements = (c: Ctx, n: number, side: Dir) => {
  const out: string[] = [];
  for (let i = 1; i < n; i++) {
    for (const b of BASES) {
      if (b.at(c, i) !== side) continue;
      out.push(`${i}:${b.id}`);
      for (const p of PARTNERS) if (p[b.id].ok(c, i, side)) out.push(`${i}:${b.id}+${p.id}`);
    }
  }
  return out;
};

describe("RSI combinations", () => {
  it("every partner's sell is its buy on the chart turned upside down", () => {
    for (const seed of [31, 32, 33]) {
      const c = walk(2400, H, seed);
      const up = agreements(ctxFor(c), c.length, 1);
      const down = agreements(ctxFor(mirrored(c)), c.length, -1);
      expect(up.length).toBeGreaterThan(100);
      expect(down).toEqual(up);
    }
  });

  // Not "agrees with some RSI signal": some pairings almost never meet by
  // construction (a bounce from RSI 30 above the Ichimoku cloud needs a fall
  // deep enough to push RSI under 30 that still left price above the cloud),
  // and that is a finding, not a bug. What must hold is that no condition is
  // a constant.
  it("no partner's condition is always true or always false", () => {
    const c = walk(4000, H, 41);
    const ctx = ctxFor(c);
    for (const b of BASES) {
      for (const p of PARTNERS) {
        for (const d of [1, -1] as Dir[]) {
          let yes = 0;
          let no = 0;
          for (let i = 250; i < c.length; i++) {
            if (p[b.id].ok(ctx, i, d)) yes++;
            else no++;
          }
          expect(yes, `${b.id}+${p.id} (${d}) never holds`).toBeGreaterThan(0);
          expect(no, `${b.id}+${p.id} (${d}) always holds`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("never reads a later bar", () => {
    const c = walk(1200, H, 51);
    const full = ctxFor(c);
    const part = ctxFor(c.slice(0, 901));
    for (let i = 850; i <= 900; i++) {
      for (const b of BASES) {
        expect(b.at(part, i), `${b.id}@${i}`).toBe(b.at(full, i));
        for (const d of [1, -1] as Dir[]) {
          for (const p of PARTNERS) expect(p[b.id].ok(part, i, d), `${b.id}+${p.id}@${i}`).toBe(p[b.id].ok(full, i, d));
        }
      }
    }
  });

  it("reads the higher timeframe's trend from its closed bars only", () => {
    const higher = walk(120, 4 * H, 61);
    const t = htfTrend(higher);
    expect(t[48]).toBeNull();
    const avg = higher.slice(50, 100).reduce((s, x) => s + x.close, 0) / 50;
    expect(t[99]).toBe(higher[99].close > avg ? "up" : "down");
  });
});
