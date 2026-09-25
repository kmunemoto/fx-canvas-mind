import { describe, it, expect } from "vitest";
import {
  DAY,
  DAY_OFFSET,
  HOUR,
  MINUTE,
  aggregate,
  auc,
  clusterRate,
  fitLogistic,
  holm,
  labelAt,
  mid,
  predict,
  subStarts,
} from "../../research/lib";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const T0 = Date.parse("2026-01-05T00:00:00Z");
const dt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// A quote bar with the ask a fixed spread above the bid
const q = (ms: number, o: number, h: number, l: number, c: number, spread = 0.02): QuoteCandle => ({
  datetime: dt(ms),
  bid: { datetime: dt(ms), open: o, high: h, low: l, close: c },
  ask: { datetime: dt(ms), open: o + spread, high: h + spread, low: l + spread, close: c + spread },
});

describe("rungs from 15-minute bars", () => {
  it("groups by boundary, keeps each side's own extremes, and stamps the boundary", () => {
    const bars = [
      q(T0, 150, 150.2, 149.9, 150.1),
      q(T0 + 15 * MINUTE, 150.1, 150.5, 150.0, 150.4),
      q(T0 + 30 * MINUTE, 150.4, 150.45, 149.7, 149.8),
      q(T0 + 45 * MINUTE, 149.8, 150.0, 149.75, 149.95),
      q(T0 + 60 * MINUTE, 149.95, 150.0, 149.9, 149.92),
    ];
    const h = aggregate(bars, HOUR, 0, T0 + 3 * HOUR);
    expect(h).toHaveLength(2);
    expect(h[0].datetime).toBe(dt(T0));
    expect(h[0].bid).toMatchObject({ open: 150, high: 150.5, low: 149.7, close: 149.95 });
    expect(h[0].ask.high).toBeCloseTo(150.52, 10);
    expect(mid(h[0]).close).toBeCloseTo(149.96, 10);
    // a group that has not closed by `now` is not a bar
    expect(aggregate(bars, HOUR, 0, T0 + HOUR + 30 * MINUTE)).toHaveLength(1);
  });

  it("starts the day at 21:00 UTC", () => {
    const bars = [q(T0 - 3 * HOUR - 15 * MINUTE, 1, 1, 1, 1), q(T0 - 3 * HOUR, 2, 2, 2, 2)];
    const d = aggregate(bars, DAY, DAY_OFFSET, T0 + 2 * DAY);
    expect(d).toHaveLength(2);
    expect(d[1].datetime).toBe(dt(T0 - 3 * HOUR));
  });
});

describe("what a plan opened at a bar would have done", () => {
  const spec = { stopAtr: 1, rr: 1.5, horizon: 5 };
  // entry bar closes at bid 150.00 / ask 150.02; ATR 0.1
  const entry = q(T0, 150, 150.05, 149.95, 150.0);

  it("fills a BUY on the ask and closes it on the bid", () => {
    // BUY: entry 150.02, stop 149.92, target 150.17 — all read on the bid.
    // (Fixtures sit a pip off each boundary; exactly on it is a coin flip in
    // binary floating point, and the tracker has the same property.)
    const bars = [entry, q(T0 + HOUR, 150, 150.16, 149.95, 150.1), q(T0 + 2 * HOUR, 150.1, 150.18, 150.0, 150.15)];
    expect(labelAt(bars, 0, 0.1, "BUY", spec, HOUR)).toEqual({ outcome: "win", bars: 2 });
    // a bid low of 149.93 does not stop it; 149.91 does
    const stopped = [entry, q(T0 + HOUR, 150, 150.05, 149.91, 150)];
    expect(labelAt(stopped, 0, 0.1, "BUY", spec, HOUR).outcome).toBe("loss");
    const held = [entry, q(T0 + HOUR, 150, 150.05, 149.93, 150)];
    expect(labelAt(held, 0, 0.1, "BUY", spec, HOUR).outcome).not.toBe("loss");
  });

  it("fills a SELL on the bid and closes it on the ask", () => {
    // SELL: entry 150.00, stop 150.10, target 149.85 — read on the ask (bid + 0.02)
    const win = [entry, q(T0 + HOUR, 150, 150.0, 149.82, 149.9)];
    expect(labelAt(win, 0, 0.1, "SELL", spec, HOUR)).toEqual({ outcome: "win", bars: 1 });
    // ask low 149.86 is not the target
    const short = [entry, q(T0 + HOUR, 150, 150.0, 149.84, 149.9)];
    expect(labelAt(short, 0, 0.1, "SELL", spec, HOUR).outcome).not.toBe("win");
    // ask high 150.11 stops it
    const loss = [entry, q(T0 + HOUR, 150, 150.09, 149.95, 150)];
    expect(labelAt(loss, 0, 0.1, "SELL", spec, HOUR).outcome).toBe("loss");
  });

  it("splits a bar that reached both on the finer bars, and admits it when it cannot", () => {
    const both = q(T0 + HOUR, 150, 150.3, 149.8, 150);
    const bars = [entry, both];
    expect(labelAt(bars, 0, 0.1, "BUY", spec, HOUR).outcome).toBe("ambiguous");
    // the stop came first inside the hour
    const fine = [
      q(T0 + HOUR, 150, 150.02, 149.8, 149.85),
      q(T0 + HOUR + 15 * MINUTE, 149.85, 150.3, 149.84, 150.2),
    ];
    const sub = { bars: fine, startOf: subStarts(bars, fine) };
    expect(labelAt(bars, 0, 0.1, "BUY", spec, HOUR, sub)).toEqual({ outcome: "loss", bars: 1 });
    // both inside one finer bar: still ambiguous, never guessed
    const oneBar = [q(T0 + HOUR, 150, 150.3, 149.8, 150)];
    expect(labelAt(bars, 0, 0.1, "BUY", spec, HOUR, { bars: oneBar, startOf: subStarts(bars, oneBar) }).outcome).toBe("ambiguous");
  });

  it("is open while the future is shorter than the horizon, expired once it is not", () => {
    const quiet = (i: number) => q(T0 + i * HOUR, 150, 150.05, 149.95, 150);
    expect(labelAt([entry, quiet(1), quiet(2)], 0, 0.1, "BUY", spec, HOUR).outcome).toBe("open");
    expect(labelAt([entry, ...[1, 2, 3, 4, 5].map(quiet)], 0, 0.1, "BUY", spec, HOUR).outcome).toBe("expired");
  });
});

describe("counting", () => {
  it("widens the interval when outcomes arrive in clumps", () => {
    // 20 days, each day all wins or all losses, 10 trades a day
    const clumped = Array.from({ length: 200 }, (_, i) => ({ cluster: Math.floor(i / 10), win: Math.floor(i / 10) % 2 === 0 }));
    const spread = Array.from({ length: 200 }, (_, i) => ({ cluster: Math.floor(i / 10), win: i % 2 === 0 }));
    const a = clusterRate(clumped)!;
    const b = clusterRate(spread)!;
    expect(a.p).toBe(0.5);
    expect(b.p).toBe(0.5);
    expect(a.se).toBeGreaterThan(3 * b.se);
    expect(clusterRate([])).toBeNull();
  });

  it("holm", () => {
    const adj = holm([0.01, 0.04, 0.03, 0.2]);
    expect(adj[0]).toBeCloseTo(0.04, 10);
    expect(adj[2]).toBeCloseTo(0.09, 10);
    expect(adj[1]).toBeCloseTo(0.09, 10);
    expect(adj[3]).toBeCloseTo(0.2, 10);
  });

  it("fits a logistic model that recovers what was put in, and scores it", () => {
    // column 0 raises the odds, column 1 lowers them
    let s = 17;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const rows: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const row = [r() < 0.5 ? 0 : 1];
      const z = -0.4 + (row[0] === 0 ? 1.0 : -1.0);
      rows.push(row);
      y.push(r() < 1 / (1 + Math.exp(-z)) ? 1 : 0);
    }
    const w = fitLogistic(rows, y, 2, 0.01);
    expect(predict(w, [0])).toBeCloseTo(1 / (1 + Math.exp(-0.6)), 1);
    expect(predict(w, [1])).toBeCloseTo(1 / (1 + Math.exp(1.4)), 1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
  });
});
