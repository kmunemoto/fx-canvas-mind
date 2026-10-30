// #387 (docs §8.130): the owner's video's way — 20 EMA and 200 EMA cross, the
// candle back to the 200 EMA, the two necklines, their break, the return move
// and the bar past its body — as the chart and the 15-minute email decide it
// (supabase/functions/_shared/ema-return.ts; the rule: research/ema-return-spec.md).
//
//   1. a hand example walked bar by bar (the cross, the touch, the swing high,
//      the diagonal's break, the break, the 1st and 2nd bars not counted, the
//      return move, the entry), its levels worked out by hand; the sell (the
//      mirror); and each way it ends without an entry
//   2. the rule written again here, apart from the module (each side's own
//      comparisons, the horizontal's swing searched afresh at every bar), on
//      seeded random walks: the same entries
//   3. the email's decision (the newest bar on its 600 closed bars) is the
//      chart's mark at that bar; a bar's decision does not change with what
//      comes after it
import { describe, expect, it } from "vitest";
import {
  EMA_RETURN,
  EMA_RETURN_MIN_WINDOW,
  emaReturnMarks,
  emaReturnNewest,
  emaReturnNow,
  emaReturnOnWindow,
  emaReturnScan,
  type ErBar,
  type ErEntry,
} from "@/lib/emaReturn";
import { buyCase, mirror, walk } from "./ema-return-case";

// ---- 1. hand examples ---------------------------------------------------------------------

describe("#387 the video's way, by hand", () => {
  it("a buy: the cross, the touch, the lines, the break, the return move after the 2nd bar, the entry", () => {
    const { bars, x, p, t, b, k, slowT } = buyCase();
    expect(x).toBeGreaterThanOrEqual(EMA_RETURN.warm);
    const s = emaReturnScan(bars);
    expect(s.entries).toHaveLength(1);
    const e = s.entries[0];
    expect(e.side).toBe("BUY");
    expect(e.at).toBe(k + 4);
    expect(e.at).toBe(bars.length - 1);
    expect(e.x).toBe(x);
    expect(e.t).toBe(t);
    expect(e.aAt).toBe(x + 5);
    expect(e.b).toBe(b);
    expect(e.k).toBe(k);
    expect(e.dk).toBe(t + 9);
    expect(e.r).toBe(k + 3);
    expect(e.a).toBeCloseTo(p + 0.3, 9);
    expect(e.neck).toBeCloseTo(p - 0.02, 9);
    expect(e.entry).toBeCloseTo(p + 0.06, 9);
    // the lowest low from the diagonal's break (T+9: opened at P - 0.7) to the entry
    expect(e.stop).toBeCloseTo(p - 0.75, 9);
    expect(e.tp1).toBeCloseTo(p + 0.3, 9);
    // wave 3's start (the lowest low of B..K: P - 0.95) plus wave 1 (B's high over the touch's low)
    expect(e.tp2).toBeCloseTo(p - 0.95 + (p - 0.02 - (slowT - 0.2)), 9);
    expect(e.rr).toBeCloseTo(0.24 / 0.81, 9);
    expect(s.setup?.phase).toBe("done");
    // the window ending at the entry decides it there
    expect(emaReturnOnWindow(bars)?.at).toBe(k + 4);
    expect(emaReturnOnWindow(bars.slice(0, -1))).toBeNull();
  });

  it("the setup alive bar by bar: the touch, the lines before and after B, the retest", () => {
    const { bars, x, p, t, b, k } = buyCase();
    const at = (i: number) => emaReturnScan(bars.slice(0, i + 1)).setup;
    expect(at(x - 1)).toBeNull();
    expect(at(x)).toMatchObject({ side: "BUY", phase: "touch", x, t: null });
    expect(at(t - 1)).toMatchObject({ phase: "touch", aAt: x + 5 });
    expect(at(t)).toMatchObject({ phase: "lines", t, b: null });
    // B is known 3 bars after it
    expect(at(b + 2)).toMatchObject({ phase: "lines", b: null });
    expect(at(b + 3)).toMatchObject({ phase: "lines", b });
    expect(at(b + 3)?.neck).toBeCloseTo(p - 0.02, 9);
    expect(at(k)).toMatchObject({ phase: "retest", b, k, r: null });
    // the 1st and 2nd bars after the break reach the horizontal but are no return move
    expect(at(k + 2)).toMatchObject({ phase: "retest", r: null });
    expect(at(k + 3)).toMatchObject({ phase: "retest", r: k + 3 });
  });

  it("a sell: the mirror, the same bars", () => {
    const { bars, p } = buyCase();
    const buy = emaReturnScan(bars).entries[0];
    const sell = emaReturnScan(mirror(bars)).entries;
    expect(sell).toHaveLength(1);
    const e = sell[0];
    expect(e.side).toBe("SELL");
    for (const key of ["at", "x", "t", "aAt", "b", "k", "dk", "r"] as const) expect(e[key]).toBe(buy[key]);
    expect(e.a).toBeCloseTo(200 - (p + 0.3), 9);
    expect(e.entry).toBeCloseTo(200 - (p + 0.06), 9);
    expect(e.stop).toBeCloseTo(200 - (p - 0.75), 9);
    expect(e.tp1).toBeCloseTo(e.a, 12);
    expect(e.tp2).toBeCloseTo(200 - (buy.tp2 as number), 9);
    expect(e.rr).toBeCloseTo(buy.rr, 9);
  });

  it("the bars right after the break alone are no return move: no entry", () => {
    // K+3 stays above the horizontal (its low P - 0.01): before K+4, the only bars at it were
    // the 1st and 2nd; K+4 (its low P - 0.04) is the return move, not yet an entry
    const { bars, k, p } = buyCase();
    bars[k + 3].l = p - 0.01;
    expect(emaReturnScan(bars.slice(0, k + 4)).setup).toMatchObject({ phase: "retest", r: null });
    const s = emaReturnScan(bars);
    expect(s.entries).toHaveLength(0);
    expect(s.setup).toMatchObject({ phase: "retest", r: k + 4 });
  });

  it("the high reaching A before an entry: no entry", () => {
    const { bars, k, p } = buyCase();
    bars[k + 3].h = p + 0.3;
    const s = emaReturnScan(bars);
    expect(s.entries).toHaveLength(0);
    expect(s.setup?.phase).toBe("done");
  });

  it("the break's own high at A: no entry", () => {
    const { bars, k, p } = buyCase();
    bars[k].h = p + 0.3;
    const s = emaReturnScan(bars);
    expect(s.entries).toHaveLength(0);
    expect(s.setup?.phase).toBe("done");
  });

  it("a close back under the horizontal: the break failed, the lines again", () => {
    const { bars, k, p } = buyCase();
    bars[k + 3].c = p - 0.03;
    const s = emaReturnScan(bars.slice(0, k + 4));
    expect(s.entries).toHaveLength(0);
    expect(s.setup).toMatchObject({ phase: "lines", k: null, r: null });
  });

  it("a new high over A before the break: the touch is waited for again", () => {
    const { bars, t, p } = buyCase();
    bars[t + 2].h = p + 0.4;
    const s = emaReturnScan(bars.slice(0, t + 3));
    expect(s.setup).toMatchObject({ phase: "touch", aAt: t + 2, t: null });
    expect(s.setup?.a).toBeCloseTo(p + 0.4, 9);
  });

  it("a cross before WARM does not count", () => {
    const { bars, x } = buyCase();
    const s = emaReturnScan(bars, { ...EMA_RETURN, warm: x + 1 });
    expect(s.entries).toHaveLength(0);
    expect(s.setup).toBeNull();
  });

  it("the email needs its 600 closed bars; the chart at least MIN_WINDOW", () => {
    const { bars } = buyCase();
    expect(bars.length).toBeLessThan(EMA_RETURN.window);
    expect(emaReturnNewest(bars)).toBeNull();
    expect(EMA_RETURN_MIN_WINDOW).toBe(EMA_RETURN.warm + 100);
    // the chart judges the entry's bar on all it holds before it, marked as short of the email's window
    const marks = emaReturnMarks(bars);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ at: bars.length - 1, full: false });
  });
});

// ---- 2. the rule again, written apart from the module ----------------------------------------

interface Ref {
  side: "BUY" | "SELL";
  at: number;
  x: number;
  t: number;
  aAt: number;
  a: number;
  b: number;
  neck: number;
  k: number;
  dk: number;
  r: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  rr: number;
}

const refEma = (xs: number[], n: number): Array<number | null> => {
  const out: Array<number | null> = xs.map(() => null);
  if (xs.length < n) return out;
  let e = 0;
  for (let k = 0; k < n; k++) e += xs[k];
  e /= n;
  out[n - 1] = e;
  const al = 2 / (n + 1);
  for (let k = n; k < xs.length; k++) {
    e = al * xs[k] + (1 - al) * e;
    out[k] = e;
  }
  return out;
};

// one scan as the spec words it, each side with its own comparisons; B searched afresh at
// every bar among all the swings after the touch
const refScan = (w: ErBar[], warm = EMA_RETURN.warm, piv = EMA_RETURN.piv, skip = EMA_RETURN.skip): Ref[] => {
  const cl = w.map((b) => b.c);
  const fast = refEma(cl, EMA_RETURN.fast);
  const slow = refEma(cl, EMA_RETURN.slow);
  const out: Ref[] = [];
  let up = true;
  let phase = "";
  let x = 0;
  let t = 0;
  let a = 0;
  let aAt = 0;
  let b = -1;
  let neck = 0;
  let kk = 0;
  let dk = 0;
  let r = -1;
  // the side's own view: its extreme (high / low), its far side (low / high), beyond (> / <)
  const ext = (j: number) => (up ? w[j].h : w[j].l);
  const far = (j: number) => (up ? w[j].l : w[j].h);
  const beyond = (u: number, v: number) => (up ? u > v : u < v);
  const swing = (p: number) => {
    if (p - piv < 0) return false;
    for (let j = p + 1; j <= p + piv; j++) if (!beyond(ext(p), ext(j))) return false;
    for (let j = p - piv; j < p; j++) if (beyond(ext(j), ext(p))) return false;
    return true;
  };
  const pickB = (k: number) => {
    let best = -1;
    for (let p = t + 1; p + piv <= k; p++) {
      if (!swing(p) || !beyond(a, ext(p))) continue;
      if (best < 0 || !beyond(ext(best), ext(p))) best = p;
    }
    return best;
  };
  const diag = (bb: number, j: number) => a + (ext(bb) - a) * (j - aAt) / (bb - aAt);
  for (let k = warm; k < w.length; k++) {
    const f0 = fast[k - 1];
    const s0 = slow[k - 1];
    const f1 = fast[k];
    const s1 = slow[k];
    if (f0 !== null && s0 !== null && f1 !== null && s1 !== null) {
      const golden = f0 <= s0 && f1 > s1;
      const dead = f0 >= s0 && f1 < s1;
      if (golden || dead) {
        up = golden;
        phase = "touch";
        x = k;
        a = ext(k);
        aAt = k;
        continue;
      }
    }
    if (phase === "" || phase === "done") continue;
    if (phase === "touch") {
      if (beyond(ext(k), a)) {
        a = ext(k);
        aAt = k;
      }
      if (up ? w[k].l <= (slow[k] as number) : w[k].h >= (slow[k] as number)) {
        phase = "lines";
        t = k;
      }
      continue;
    }
    if (phase === "lines") {
      const bb = pickB(k);
      if (bb >= 0 && beyond(w[k].c, ext(bb)) && beyond(w[k].c, diag(bb, k))) {
        if (!beyond(a, ext(k))) {
          phase = "done";
          continue;
        }
        phase = "retest";
        b = bb;
        neck = ext(bb);
        kk = k;
        dk = -1;
        for (let j = bb + 1; j <= k && dk < 0; j++) if (beyond(w[j].c, diag(bb, j))) dk = j;
        r = -1;
      } else if (beyond(ext(k), a)) {
        phase = "touch";
        a = ext(k);
        aAt = k;
      }
      continue;
    }
    // retest
    if (!beyond(a, ext(k))) {
      phase = "done";
      continue;
    }
    if (beyond(neck, w[k].c)) {
      phase = "lines";
      continue;
    }
    if (r >= 0 && beyond(w[k].c, up ? Math.max(w[r].o, w[r].c) : Math.min(w[r].o, w[r].c))) {
      const e = w[k].c;
      const worst = (from: number, to: number) => {
        let v = far(from);
        for (let j = from + 1; j <= to; j++) if (beyond(v, far(j))) v = far(j);
        return v;
      };
      const stop = worst(dk, k);
      const l1 = worst(t, b);
      const l2 = worst(b, kk);
      const tp2 = l2 + (neck - l1);
      out.push({
        side: up ? "BUY" : "SELL",
        at: k,
        x,
        t,
        aAt,
        a,
        b,
        neck,
        k: kk,
        dk,
        r,
        entry: e,
        stop,
        tp1: a,
        tp2: beyond(tp2, e) ? tp2 : null,
        rr: (a - e) / (e - stop),
      });
      phase = "done";
      continue;
    }
    if (k >= kk + skip + 1 && !beyond(far(k), neck)) r = k;
  }
  return out;
};

const same = (m: ErEntry, ref: Ref) => {
  for (const key of ["side", "at", "x", "t", "aAt", "b", "k", "dk", "r"] as const) expect(m[key]).toBe(ref[key]);
  for (const key of ["a", "neck", "entry", "stop", "tp1"] as const) expect(m[key]).toBe(ref[key]);
  if (ref.tp2 === null) expect(m.tp2).toBeNull();
  else expect(m.tp2).toBeCloseTo(ref.tp2, 9);
  expect(m.rr).toBeCloseTo(ref.rr, 9);
};

describe("#387 the module against the rule written again (seeded random walks)", () => {
  it("one scan over each whole walk: the same entries, buys and sells", () => {
    let n = 0;
    const sides = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const bars = walk(4000, seed);
      const got = emaReturnScan(bars).entries;
      const ref = refScan(bars);
      expect(got.length).toBe(ref.length);
      got.forEach((m, i) => same(m, ref[i]));
      n += got.length;
      got.forEach((m) => sides.add(m.side));
    }
    // the walks must enter for the comparison to mean anything (40 when written)
    expect(n).toBeGreaterThan(20);
    expect([...sides].sort()).toEqual(["BUY", "SELL"]);
  });

  it("every bar of ten walks, each on its 600 bars: the chart's marks are the rule's decisions", () => {
    let fired = 0;
    for (let seed = 11; seed <= 20; seed++) {
      const bars = walk(2000, seed);
      const marks = new Map(emaReturnMarks(bars, 599).map((m) => [m.at, m]));
      for (let i = 599; i < bars.length; i++) {
        const start = i - 599;
        const ref = refScan(bars.slice(start, i + 1)).filter((e) => e.at === 599)[0];
        const m = marks.get(i);
        if (!ref) {
          expect(m).toBeUndefined();
          continue;
        }
        fired++;
        expect(m?.full).toBe(true);
        same(
          { ...(m as ErEntry), at: m!.at - start, x: m!.x - start, t: m!.t - start, aAt: m!.aAt - start, b: m!.b - start, k: m!.k - start, dk: m!.dk - start, r: m!.r - start },
          ref,
        );
      }
    }
    // 6 when written
    expect(fired).toBeGreaterThan(3);
  });
});

// ---- 3. the email and the chart ----------------------------------------------------------------

describe("#387 the email's decision is the chart's", () => {
  it("the newest bar on its 600: the chart's mark there; later bars change nothing before them", () => {
    const bars = walk(2400, 21);
    const marks = emaReturnMarks(bars, 599);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      const mail = emaReturnNewest(bars.slice(0, m.at + 1));
      expect(mail).not.toBeNull();
      expect(mail?.side).toBe(m.side);
      expect(mail?.entry).toBe(m.entry);
      expect(mail?.stop).toBe(m.stop);
      expect(mail?.tp1).toBe(m.tp1);
      expect(mail?.tp2).toBe(m.tp2);
      const changed = [...bars.slice(0, m.at + 1), ...walk(200, 99, bars[m.at].c)];
      const again = emaReturnMarks(changed, m.at).find((y) => y.at === m.at);
      expect(again?.entry).toBe(m.entry);
      expect(again?.stop).toBe(m.stop);
    }
    // a bar without a mark: no email
    const marked = new Set(marks.map((m) => m.at));
    for (let i = 599; i < 900; i++) if (!marked.has(i)) expect(emaReturnNewest(bars.slice(0, i + 1))).toBeNull();
  });

  it("the setup alive at the newest bar and the two lines: on the same 600 bars, indices the chart's own", () => {
    const bars = walk(1500, 31);
    let alive = 0;
    for (const n of [700, 950, 1200, 1500]) {
      const now = emaReturnNow(bars.slice(0, n));
      const direct = emaReturnScan(bars.slice(n - 600, n));
      expect(now).not.toBeNull();
      expect(now?.fast).toHaveLength(n);
      expect(now?.slow).toHaveLength(n);
      expect(now?.slow.slice(n - 600)).toEqual(direct.slow);
      expect(now?.fast.slice(n - 600)).toEqual(direct.fast);
      expect(now?.slow.slice(0, n - 600).every((v) => v === null)).toBe(true);
      if (direct.setup === null) {
        expect(now?.setup).toBeNull();
        continue;
      }
      alive++;
      expect(now?.setup?.phase).toBe(direct.setup.phase);
      expect(now?.setup?.x).toBe(direct.setup.x + n - 600);
      expect(now?.setup?.t).toBe(direct.setup.t === null ? null : direct.setup.t + n - 600);
    }
    expect(alive).toBeGreaterThan(0);
    // fewer bars than the chart's least window: nothing
    expect(emaReturnNow(bars.slice(0, EMA_RETURN_MIN_WINDOW - 1))).toBeNull();
  });
});
