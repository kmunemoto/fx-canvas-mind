// #397 v10 (research/macdride10-spec.md, docs §8.154): the MACD ride's email 1 the moment the line touches 90% of the
// pane's edge (the five pairs and gold), email 2 the moment it touches 95% — the parts of the shared code
// (supabase/functions/_shared/macd-ride.ts, spec section 6) that v10 adds, held as section 9's first bullet asks:
//
//   1. Zp of a bar (rideZpOf, rideStateZpOf, rideZpFrom): zoneAt at 598 of the bar's 600-window rebuilt with any
//      price in slot 599, bit for bit, on seeded random walks; v9's Zp from rideEntryAt; not Z of the bar before on
//      its own window; a row read back
//   2. a touch at a share (rideTouchAt): zoneAt on the window rebuilt; and it only switches on as x moves toward its
//      side, over a price grid on both sides at 0.90 and 0.95 (spec section 1, "why the extremes so far are enough")
//   3. the hit (rideHit) against the rule written again here from section 1.1's sentences, on random states and
//      extremes: both sides hit (the top decides), a side gated by Zp, already, prices that are no number
//   4. the step (rideCloseStep with a hit): a table of cases, in, at, quiet and skip, at a minute's read and at the
//      tail, with section 1.1's addition (a ride of the side entered in a bar after j) and reached_bar = open(j)
//   5. the catch-up with the entry bar (rideCatchUp's entryBarToo, section 4 A.3)
//   6. walks with minutes, driven read by read as section 4 B does it (reaches first, then the bar's one decision),
//      against the study's moment entries with way C written again here (research/macd90m.ts at REACH = 0.95): the
//      same decisions, the same rides, and at each close the catch-up and the tail find nothing
import { describe, expect, it } from "vitest";
import { macd, MACD_DEFAULTS } from "../../supabase/functions/_shared/macd";
import { pineEma } from "../../supabase/functions/_shared/pine";
import { LEVEL_WINDOW, ZONE_BARS, zoneAt } from "../../supabase/functions/_shared/macd-level";
import {
  atShare,
  RIDE_CATCHUP_BARS,
  RIDE_IN_SHARE,
  RIDE_OUT_SHARE,
  type RideBar,
  rideCatchUp,
  rideCloseStep,
  rideEntryAt,
  type RideHit,
  rideHit,
  rideLineAt,
  type RideRow,
  type RideSide,
  type RideState,
  rideStateFrom,
  rideStateOf,
  rideStateZpOf,
  type RideStep,
  rideTouch,
  rideTouchAt,
  type RideZone,
  rideZoneAt,
  type RideZoneSide,
  rideZoneSideOf,
  rideZpFrom,
  rideZpOf,
  shareOf,
} from "../../supabase/functions/_shared/macd-ride";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const W = LEVEL_WINDOW;
const T0 = Date.UTC(2026, 0, 5, 0);
const SIDES: RideZoneSide[] = ["top", "bottom"];
// the loops over the walks take a few seconds each: room for a slower machine
const SLOW = 120_000;

// bit for bit: Object.is on each number (toBe), not "close"
const sameZone = (a: RideZone | null, b: { m: number; top: number; bottom: number } | null) => {
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect((a as RideZone).m).toBe((b as RideZone).m);
  expect((a as RideZone).top).toBe((b as RideZone).top);
  expect((a as RideZone).bottom).toBe((b as RideZone).bottom);
};

// ---- seeded walks (as src/test/macd-ride.test.ts) ---------------------------------------------------------------

const rndOf = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

// 1-hour bars of a seeded walk, rounded to `d` decimals as a chart draws them
const walk = (n: number, seed: number, start: number, d: number, wick = 0.0008): RideBar[] => {
  const rnd = rndOf(seed);
  const out: RideBar[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    const open = v;
    v *= 1 + (rnd() - 0.5) * 0.004;
    const high = Math.max(open, v) * (1 + rnd() * wick);
    const low = Math.min(open, v) * (1 - rnd() * wick);
    out.push({ t: T0 + i * HOUR, high: Number(high.toFixed(d)), low: Number(low.toFixed(d)), close: Number(v.toFixed(d)) });
  }
  return out;
};

interface Walk {
  name: string;
  bars: RideBar[];
  closes: number[];
  // each bar's state on its own window (the 599 closes before it), from the 600th bar on
  state: Array<RideState | null>;
}
const walkOf = (name: string, n: number, seed: number, start: number, d: number): Walk => {
  const bars = walk(n, seed, start, d);
  const closes = bars.map((b) => b.close);
  const state: Array<RideState | null> = bars.map((_, j) => (j >= W - 1 ? rideStateOf(closes.slice(j - (W - 1), j)) : null));
  return { name, bars, closes, state };
};

// yen pairs (3 decimals), the others (5), gold (2)
const WALKS: Walk[] = [
  walkOf("150.123 seed 41", 1500, 41, 150.123, 3),
  walkOf("97.531 seed 42", 1500, 42, 97.531, 3),
  walkOf("1.10234 seed 43", 1500, 43, 1.10234, 5),
  walkOf("0.65432 seed 44", 1500, 44, 0.65432, 5),
  walkOf("4123.45 seed 45", 1500, 45, 4123.45, 2),
];

// ---- 1. Zp of a bar --------------------------------------------------------------------------------------------

describe("v10 Zp of a bar: the zone at index 598 of the bar's window, from the 599 closed closes before it", () => {
  it("rideZpOf(c599) is zoneAt(macd(c599 + [x]), 598) bit for bit, whatever price x is in slot 599 (the study's zp)", () => {
    let compared = 0;
    for (const [wi, w] of WALKS.entries()) {
      const rnd = rndOf(3000 + wi);
      for (let j = W - 1; j < w.bars.length; j += 3) {
        const c599 = w.closes.slice(j - (W - 1), j);
        const zp = rideZpOf(c599);
        const last = c599[W - 2];
        // the bar's own close (its 600-window: the study's zp, research/macd90.ts zonesOf), its high and low, prices
        // near and far, and prices that are no number
        for (const x of [w.closes[j], w.bars[j].high, w.bars[j].low, last * (1 + (rnd() - 0.5) * 0.05), 0, 1e6, NaN, Infinity]) {
          sameZone(zp, zoneAt(macd([...c599, x]), W - 2));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(10000);
  }, SLOW);

  it("it is v9's Zp of rideEntryAt wherever the bar's close is an entry, and rideStateZpOf is rideStateOf and rideZpOf of one window", () => {
    let entries = 0;
    for (const w of WALKS) {
      for (let j = W - 1; j < w.bars.length; j++) {
        const c599 = w.closes.slice(j - (W - 1), j);
        const zp = rideZpOf(c599);
        const both = rideStateZpOf(c599);
        expect(both).not.toBeNull();
        expect(both?.state).toEqual(w.state[j]);
        const st = both?.state as RideState;
        const ws = w.state[j] as RideState;
        for (const k of ["e12", "e26", "sig", "top119", "bottom119"] as const) expect(st[k]).toBe(ws[k]);
        sameZone(both?.zp ?? null, zp);
        const e = rideEntryAt(w.closes.slice(j - (W - 1), j + 1));
        if (e === null) continue;
        sameZone(e.zp, zp);
        entries++;
      }
    }
    expect(entries).toBeGreaterThan(50);
  }, SLOW);

  it("it is not Z of the bar before on its own window (that window starts a bar earlier): close, not always the same bits", () => {
    let differ = 0;
    let compared = 0;
    for (const w of WALKS) {
      for (let j = W; j < w.bars.length; j += 2) {
        const c599 = w.closes.slice(j - (W - 1), j);
        const zp = rideZpOf(c599) as RideZone;
        const zBefore = rideZoneAt(w.closes.slice(j - W, j)) as RideZone;
        const price = w.closes[j - 1];
        expect(Math.abs(zp.m - zBefore.m)).toBeLessThan(1e-9 * price);
        expect(Math.abs(zp.top - zBefore.top)).toBeLessThan(1e-9 * price);
        expect(Math.abs(zp.bottom - zBefore.bottom)).toBeLessThan(1e-9 * price);
        if (zp.m !== zBefore.m || zp.top !== zBefore.top || zp.bottom !== zBefore.bottom) differ++;
        compared++;
        // the close 600 bars back is in that window and not in Zp's: no number there blinds that Z, not Zp
        if (j % 50 === 0) {
          const broken = w.closes.slice(j - W, j);
          broken[0] = NaN;
          expect(rideZoneAt(broken)).toBeNull();
          expect(rideZpOf(broken)).toEqual(zp);
        }
      }
    }
    // the EMAs forget the older seed below the last bit almost always, so the two are mostly the same bits; not always
    // (on these walks once in some 2,000 bars): the function keeps Zp from the bar's own 599 closes, never Z(j - 1)
    expect(compared).toBeGreaterThan(2000);
    expect(differ).toBeGreaterThan(0);
  });

  it("of more closes the newest 599 are taken; fewer, or a close that is no number among them, gives nothing", () => {
    const w = WALKS[0];
    const j = 900;
    const c599 = w.closes.slice(j - (W - 1), j);
    const zp = rideZpOf(c599);
    expect(zp).not.toBeNull();
    expect(rideZpOf(w.closes.slice(0, j))).toEqual(zp);
    // a close older than the newest 599 is not read at all
    expect(rideZpOf([NaN, ...w.closes.slice(1, j)])).toEqual(zp);
    expect(rideStateZpOf(w.closes.slice(0, j))).toEqual(rideStateZpOf(c599));
    expect(rideZpOf(c599.slice(1))).toBeNull();
    expect(rideStateZpOf(c599.slice(1))).toBeNull();
    expect(rideZpOf([])).toBeNull();
    for (const bad of [NaN, Infinity, null as unknown as number, undefined as unknown as number]) {
      for (const at of [0, 300, W - 2]) {
        const c = c599.slice();
        c[at] = bad;
        expect(rideZpOf(c)).toBeNull();
        expect(rideStateZpOf(c)).toBeNull();
      }
    }
  });

  it("Zp kept beside the state in a row and read back is the same zone (zp_m, zp_top, zp_bottom); a row without them has none", () => {
    let compared = 0;
    for (const w of WALKS) {
      for (let j = W - 1; j < w.bars.length; j += 7) {
        const both = rideStateZpOf(w.closes.slice(j - (W - 1), j));
        if (both === null) throw new Error("no state");
        const { state, zp } = both;
        // the row as the close writes it (research/macdride10-spec.md section 3), through JSON as the database's answer
        const row = JSON.parse(
          JSON.stringify({ pair: "USD/JPY", bar_time: "2026-11-16T04:00:00+00:00", ...state, zp_m: zp.m, zp_top: zp.top, zp_bottom: zp.bottom, last_bar: "2026-11-16T03:00:00+00:00" }),
        );
        const back = rideZpFrom(row);
        sameZone(back, zp);
        expect(Object.keys(back as RideZone).sort()).toEqual(["bottom", "m", "top"]);
        expect(rideStateFrom(row)).toEqual(state);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
    const good = { e12: 150.1, e26: 150.0, sig: 0.05, top119: 0.12, bottom119: -0.03, zp_m: 0.06, zp_top: 0.12, zp_bottom: -0.03 };
    expect(rideZpFrom(good)).toEqual({ m: 0.06, top: 0.12, bottom: -0.03 });
    // a row written before v10: the five numbers, no Zp (it starts no minute decision, section 4 B.2)
    const v9 = { e12: 150.1, e26: 150.0, sig: 0.05, top119: 0.12, bottom119: -0.03 };
    expect(rideZpFrom(v9)).toBeNull();
    expect(rideZpFrom({ ...v9, zp_m: null, zp_top: null, zp_bottom: null })).toBeNull();
    expect(rideStateFrom({ ...v9, zp_m: null, zp_top: null, zp_bottom: null })).toEqual(v9);
    for (const key of ["zp_m", "zp_top", "zp_bottom"] as const) {
      for (const bad of [null, undefined, "0.1", NaN, Infinity, {}]) expect(rideZpFrom({ ...good, [key]: bad })).toBeNull();
    }
    // no zone: an edge on the wrong side of zero, or the line outside the pane's edges
    expect(rideZpFrom({ ...good, zp_top: -0.01, zp_m: -0.02 })).toBeNull();
    expect(rideZpFrom({ ...good, zp_bottom: 0.01 })).toBeNull();
    expect(rideZpFrom({ ...good, zp_m: 0.13 })).toBeNull();
    expect(rideZpFrom({ ...good, zp_m: -0.04 })).toBeNull();
    // the line at an edge is a zone (it set the edge)
    expect(rideZpFrom({ ...good, zp_m: 0.12 })).toEqual({ m: 0.12, top: 0.12, bottom: -0.03 });
    for (const bad of [null, undefined, 5, "row", []]) expect(rideZpFrom(bad)).toBeNull();
  });
});

// ---- 2. a touch at a share -------------------------------------------------------------------------------------

describe("v10 a touch at a share (rideTouchAt)", () => {
  it("is the line with x as the bar's close at the share on that side: zoneAt on the window rebuilt, at 0.90 and 0.95", () => {
    const seen = { top: 0, bottom: 0, none: 0 };
    for (const [wi, w] of WALKS.entries()) {
      const rnd = rndOf(4000 + wi);
      for (let j = W - 1; j < w.bars.length; j += 4) {
        const c599 = w.closes.slice(j - (W - 1), j);
        const st = w.state[j] as RideState;
        const last = c599[W - 2];
        for (const x of [w.bars[j].high, w.bars[j].low, last * (1 + (rnd() - 0.5) * 0.02)]) {
          const z = zoneAt(macd([...c599, x]), W - 1) as RideZone;
          for (const s of [0.9, 0.95]) {
            for (const zs of SIDES) {
              const want = zs === "top" ? z.top > 0 && z.m >= s * z.top : z.bottom < 0 && z.m <= s * z.bottom;
              const got = rideTouchAt(st, zs, x, s);
              if (!want) {
                expect(got).toBeNull();
                seen.none++;
                continue;
              }
              expect(got).toEqual({ m: z.m, top: z.top, bottom: z.bottom, share: zs === "top" ? z.m / z.top : z.m / z.bottom });
              seen[zs]++;
            }
          }
          // rideTouch is its special case at 95%, with the high on the top side and the low on the bottom
          for (const zs of SIDES) expect(rideTouch(st, zs, x, x)).toEqual(rideTouchAt(st, zs, x, RIDE_OUT_SHARE));
        }
      }
    }
    expect(seen.top).toBeGreaterThan(100);
    expect(seen.bottom).toBeGreaterThan(100);
    expect(seen.none).toBeGreaterThan(1000);
    const st = WALKS[0].state[700] as RideState;
    for (const bad of [NaN, Infinity, -Infinity]) for (const zs of SIDES) expect(rideTouchAt(st, zs, bad, 0.9)).toBeNull();
  }, SLOW);

  it("only switches on as x moves toward its side: over a price grid, on both sides, at 0.90 and 0.95 (and m rises with x)", () => {
    const switched = { top90: 0, bottom90: 0, top95: 0, bottom95: 0 };
    let grids = 0;
    for (const w of WALKS) {
      for (let j = W - 1; j < w.bars.length; j += 5) {
        const st = w.state[j] as RideState;
        const last = w.closes[j - 1];
        // 1201 prices from 4% under the close before to 4% over it, ascending
        const xs = Array.from({ length: 1201 }, (_, k) => last * (0.96 + (0.08 * k) / 1200));
        const ms = xs.map((x) => rideLineAt(st, x).m);
        for (let k = 1; k < ms.length; k++) expect(ms[k]).toBeGreaterThan(ms[k - 1]);
        for (const s of [RIDE_IN_SHARE, RIDE_OUT_SHARE]) {
          const top = xs.map((x) => rideTouchAt(st, "top", x, s) !== null);
          const bottom = xs.map((x) => rideTouchAt(st, "bottom", x, s) !== null);
          // the top side: once on as x rises, on above it; the bottom side: once on as x falls, on below it
          for (let k = 1; k < xs.length; k++) {
            if (top[k - 1]) expect(top[k]).toBe(true);
            if (bottom[k]) expect(bottom[k - 1]).toBe(true);
          }
          const tag = s === RIDE_IN_SHARE ? "90" : "95";
          if (top.includes(true) && top.includes(false)) switched[`top${tag}` as keyof typeof switched]++;
          if (bottom.includes(true) && bottom.includes(false)) switched[`bottom${tag}` as keyof typeof switched]++;
          // at 95% it is on only where it is on at 90% too
          if (s === RIDE_OUT_SHARE) {
            for (let k = 0; k < xs.length; k++) {
              if (top[k]) expect(rideTouchAt(st, "top", xs[k], RIDE_IN_SHARE)).not.toBeNull();
              if (bottom[k]) expect(rideTouchAt(st, "bottom", xs[k], RIDE_IN_SHARE)).not.toBeNull();
            }
          }
        }
        grids++;
      }
    }
    // the grids cross the line on both sides at both shares: the order is held, not only never met
    expect(grids).toBeGreaterThan(800);
    for (const v of Object.values(switched)) expect(v).toBeGreaterThan(100);
  }, SLOW);
});

// ---- 3. the hit ------------------------------------------------------------------------------------------------

// The hit again, apart from the module, from research/macdride10-spec.md section 1.1's sentences: Zp(j) the zone at
// index 598 of the window of the 599 closed closes before j with any price in slot 599; a touch of a share with an
// extreme, the line with x = hi (top side) or x = lo (bottom side) as bar j's close (zoneAt at 599 of the window
// rebuilt) at that share; the top side when Zp(j) is not at 0.90 on the top and hi touches 0.90 there, else the bottom
// likewise with lo; the trade side top -> BUY, bottom -> SELL; already when the same extreme touches 0.95 too
const atS = (z: RideZone, zs: RideZoneSide, s: number) => (zs === "top" ? z.top > 0 && z.m >= s * z.top : z.bottom < 0 && z.m <= s * z.bottom);
const bruteHit = (c599: number[], hi: number, lo: number) => {
  const zp = zoneAt(macd([...c599, 1]), 598) as RideZone;
  const touched: Record<RideZoneSide, { x: number; z: RideZone } | null> = { top: null, bottom: null };
  for (const zs of SIDES) {
    const x = zs === "top" ? hi : lo;
    const z = zoneAt(macd([...c599, x]), 599);
    if (z !== null && atS(z, zs, 0.9)) touched[zs] = { x, z: { m: z.m, top: z.top, bottom: z.bottom } };
  }
  let hit: RideHit | null = null;
  for (const zs of SIDES) {
    const t = touched[zs];
    if (hit !== null || atS(zp, zs, 0.9) || t === null) continue;
    hit = { zside: zs, side: zs === "top" ? "BUY" : "SELL", x: t.x, z: t.z, share0: zs === "top" ? t.z.m / t.z.top : t.z.m / t.z.bottom, already: atS(t.z, zs, 0.95) };
  }
  return { hit, zp, touched };
};

describe("v10 the hit of a read (rideHit)", () => {
  it("is the rule written again from section 1.1's sentences, on random states and extremes", () => {
    const n = { none: 0, top: 0, bottom: 0, already: 0, both: 0, gatedTop: 0, gatedBottom: 0, gatedBoth: 0, nan: 0 };
    for (const [wi, w] of WALKS.entries()) {
      const rnd = rndOf(5000 + wi);
      for (let j = W - 1; j < w.bars.length; j += 4) {
        const c599 = w.closes.slice(j - (W - 1), j);
        const st = w.state[j] as RideState;
        const zp = rideZpOf(c599) as RideZone;
        const last = c599[W - 2];
        const pairs: Array<[number, number]> = [[w.bars[j].high, w.bars[j].low]];
        for (const width of [0.0005, 0.002, 0.008, 0.03, 0.08]) pairs.push([last * (1 + rnd() * width), last * (1 - rnd() * width)]);
        // prices that are no number: that side touches nothing
        pairs.push([NaN, last * (1 - rnd() * 0.03)], [last * (1 + rnd() * 0.03), NaN]);
        for (const [hi, lo] of pairs) {
          const want = bruteHit(c599, hi, lo);
          const got = rideHit(st, zp, hi, lo);
          expect(got).toEqual(want.hit);
          if (got !== null) {
            // bit for bit, and what the step reads of it
            sameZone(got.z, (want.hit as RideHit).z);
            expect(got.x).toBe(want.hit?.x);
            expect(got.share0).toBe(want.hit?.share0);
            expect(got.share0).toBe(shareOf(got.z, got.zside));
            expect(got.already).toBe(rideTouchAt(st, got.zside, got.x, RIDE_OUT_SHARE) !== null);
            expect(got.side).toBe(got.zside === "top" ? "BUY" : "SELL");
            n[got.zside]++;
            if (got.already) n.already++;
          } else n.none++;
          if (!Number.isFinite(hi) || !Number.isFinite(lo)) n.nan++;
          const gTop = atS(zp, "top", 0.9) && want.touched.top !== null;
          const gBottom = atS(zp, "bottom", 0.9) && want.touched.bottom !== null;
          if (gTop) n.gatedTop++;
          if (gBottom) n.gatedBottom++;
          if (gTop && want.touched.bottom !== null) n.gatedBoth++;
          if (want.touched.top !== null && want.touched.bottom !== null && !atS(zp, "top", 0.9) && !atS(zp, "bottom", 0.9)) {
            // both sides hit: the top side decides
            expect(got?.zside).toBe("top");
            n.both++;
          }
        }
      }
    }
    // the reads hold every kind: the comparison is of something
    expect(n.top).toBeGreaterThan(100);
    expect(n.bottom).toBeGreaterThan(100);
    expect(n.already).toBeGreaterThan(100);
    expect(n.none).toBeGreaterThan(1000);
    expect(n.both).toBeGreaterThan(50);
    expect(n.gatedTop).toBeGreaterThan(50);
    expect(n.gatedBottom).toBeGreaterThan(50);
    // the top gated by Zp and the bottom touched: the bottom decides
    expect(n.gatedBoth).toBeGreaterThan(5);
    expect(n.nan).toBeGreaterThan(100);
  }, SLOW);

  it("made-up states: the Zp gate on each side, the top first, already at 95%, equality in", () => {
    // a state whose line is m = (A12 - A26) * (x - 100) with the signal at 0 and a pane of ±1 before the bar
    // (e12 = e26 = 100, sig = 0, top119 = 1, bottom119 = -1): m at x is exact enough to pick prices around 90% and 95%
    const st: RideState = { e12: 100, e26: 100, sig: 0, top119: 1, bottom119: -1 };
    const A12 = 2 / (MACD_DEFAULTS.fast + 1);
    const A26 = 2 / (MACD_DEFAULTS.slow + 1);
    const xFor = (mWanted: number) => 100 + mWanted / (A12 - A26);
    const out: RideZone = { m: 0, top: 1, bottom: -1 };
    const inTop: RideZone = { m: 0.95, top: 1, bottom: -1 };
    const inBottom: RideZone = { m: -0.95, top: 1, bottom: -1 };
    const hiAt92 = xFor(0.92);
    const hiAt97 = xFor(0.97);
    const loAt92 = xFor(-0.92);
    const loAt97 = xFor(-0.97);
    const mid = 100;
    // nothing touched
    expect(rideHit(st, out, mid, mid)).toBeNull();
    // the top at 92%: a BUY, not already; at 97%: already
    expect(rideHit(st, out, hiAt92, mid)).toMatchObject({ zside: "top", side: "BUY", x: hiAt92, already: false });
    expect(rideHit(st, out, hiAt97, mid)).toMatchObject({ zside: "top", side: "BUY", x: hiAt97, already: true });
    expect(rideHit(st, out, mid, loAt92)).toMatchObject({ zside: "bottom", side: "SELL", x: loAt92, already: false });
    expect(rideHit(st, out, mid, loAt97)).toMatchObject({ zside: "bottom", side: "SELL", x: loAt97, already: true });
    // both: the top decides, whatever the bottom's depth
    expect(rideHit(st, out, hiAt92, loAt97)).toMatchObject({ zside: "top", already: false });
    // Zp at 90% on the top: the top is not read; the bottom still is
    expect(rideHit(st, inTop, hiAt97, mid)).toBeNull();
    expect(rideHit(st, inTop, hiAt97, loAt92)).toMatchObject({ zside: "bottom", already: false });
    expect(rideHit(st, inBottom, mid, loAt97)).toBeNull();
    expect(rideHit(st, inBottom, hiAt92, loAt97)).toMatchObject({ zside: "top" });
    // Zp exactly at 90% is at it (equality in): gated
    expect(rideHit(st, { m: 0.9, top: 1, bottom: -1 }, hiAt92, mid)).toBeNull();
    // the boundary of 90% of an edge the line does not set: the lowest price found at it hits, the price just under
    // it (the next double down, by halving) does not
    const pane: RideState = { e12: 100, e26: 100, sig: 0, top119: 1, bottom119: -1 };
    const top = (x: number) => rideLineAt(pane, x);
    let lo = 100;
    let hi = xFor(0.95);
    for (let k = 0; k < 200; k++) {
      const midX = (lo + hi) / 2;
      const z = top(midX);
      if (z.m >= 0.9 * z.top) hi = midX;
      else lo = midX;
    }
    expect(rideHit(pane, out, hi, 100)).not.toBeNull();
    expect(rideHit(pane, out, lo, 100)).toBeNull();
  });
});

// ---- 4. the step of a decision ---------------------------------------------------------------------------------

const B = Date.UTC(2026, 10, 16, 3);
const hitOf = (side: RideSide, already: boolean): RideHit => {
  const zside = rideZoneSideOf(side);
  return { zside, side, x: 150, z: { m: 0.05, top: 0.05, bottom: -0.02 }, share0: zside === "top" ? 0.93 : 0.91, already };
};
const open = (side: RideSide, entryBar: number): RideRow => ({ side, entryBar, status: "open", reachedBar: null });
const reached = (side: RideSide, entryBar: number, reachedBar: number | null): RideRow => ({ side, entryBar, status: "reached", reachedBar });

describe("v10 the step of a bar's decision (rideCloseStep with a hit; research/macdride10-spec.md section 1.1)", () => {
  // bar j opened at B. A minute's read: the rows as they stand after the read's reaches (no ride of the chart can be
  // reached in a bar after j yet, nor entered after it). The tail (bar j's close read in the next bar or later): rows
  // can hold a ride reached in the next bar before the close was read, or entered after j by a later decision
  const cases: Array<{ name: string; hit: RideHit | null; rows: RideRow[]; step: RideStep | null; by?: number; own?: number }> = [
    { name: "no hit: no decision", hit: null, rows: [open("BUY", B - 5 * HOUR)], step: null },
    // ---- a minute's read
    { name: "minute: no ride: in", hit: hitOf("BUY", false), rows: [], step: "in" },
    { name: "minute: a SELL, no ride: in", hit: hitOf("SELL", false), rows: [], step: "in" },
    { name: "minute: already, no ride: the notice", hit: hitOf("BUY", true), rows: [], step: "at" },
    { name: "minute: a ride of the side open (entered bars ago): skip", hit: hitOf("BUY", false), rows: [open("BUY", B - 5 * HOUR)], step: "skip", by: 0 },
    { name: "minute: a ride of the side opened by the tail of the bar before (its entry moment this bar's open): skip", hit: hitOf("SELL", false), rows: [open("SELL", B - HOUR)], step: "skip", by: 0 },
    { name: "minute: a ride of the side reached by this very read (reaches first; T0 = T): in", hit: hitOf("BUY", false), rows: [reached("BUY", B - 5 * HOUR, B)], step: "in" },
    { name: "minute: a ride of the side reached by this very read, and already: quiet (its email 2 says the same)", hit: hitOf("BUY", true), rows: [reached("BUY", B - 5 * HOUR, B)], step: "quiet", by: 0 },
    {
      name: "minute: already, and a ride of the side reached in this bar by another run, or an earlier run that failed before deciding: quiet",
      hit: hitOf("SELL", true),
      rows: [reached("SELL", B - 2 * HOUR, B)],
      step: "quiet",
      by: 0,
    },
    { name: "minute: already, and a ride of the side open: the notice (an already decision is never skipped)", hit: hitOf("BUY", true), rows: [open("BUY", B - 5 * HOUR)], step: "at" },
    { name: "minute: a ride of the side reached in the bar before: in", hit: hitOf("BUY", false), rows: [reached("BUY", B - 9 * HOUR, B - HOUR)], step: "in" },
    { name: "minute: already, and a ride of the side reached in the bar before: the notice", hit: hitOf("BUY", true), rows: [reached("BUY", B - 9 * HOUR, B - HOUR)], step: "at" },
    { name: "minute: a ride of the other side open: in", hit: hitOf("BUY", false), rows: [open("SELL", B - 5 * HOUR)], step: "in" },
    { name: "minute: already, and a ride of the other side reached in this bar: the notice", hit: hitOf("BUY", true), rows: [reached("SELL", B - 5 * HOUR, B)], step: "at" },
    // ---- the tail (bar j's close, read in the next bar or later)
    { name: "tail: no ride: in", hit: hitOf("SELL", false), rows: [], step: "in" },
    { name: "tail: already, no ride: the notice", hit: hitOf("SELL", true), rows: [], step: "at" },
    { name: "tail: a ride of the side open since before j: skip", hit: hitOf("BUY", false), rows: [open("BUY", B - 3 * HOUR)], step: "skip", by: 0 },
    {
      name: "tail: a ride of the side entered before j and reached in the next bar before the close was read (reached_bar > open(j)): skip",
      hit: hitOf("BUY", false),
      rows: [reached("BUY", B - 3 * HOUR, B + HOUR)],
      step: "skip",
      by: 0,
    },
    { name: "tail: already, and a ride of the side entered before j reached in the next bar: the notice", hit: hitOf("BUY", true), rows: [reached("BUY", B - 3 * HOUR, B + HOUR)], step: "at" },
    { name: "tail: a ride of the side reached in bar j itself (reached_bar = open(j)): in", hit: hitOf("SELL", false), rows: [reached("SELL", B - 3 * HOUR, B)], step: "in" },
    { name: "tail: already, and a ride of the side reached in bar j itself (reached_bar = open(j)): quiet", hit: hitOf("SELL", true), rows: [reached("SELL", B - 3 * HOUR, B)], step: "quiet", by: 0 },
    // section 1.1's addition: a ride of the side entered in a bar after j (a tail decided late, by a later judge of the
    // close, after the next bar's decision of the side was mailed)
    { name: "tail decided late: a ride of the side entered in the next bar, open: skip", hit: hitOf("BUY", false), rows: [open("BUY", B + HOUR)], step: "skip", by: 0 },
    { name: "tail decided late: a ride of the side entered in the next bar and reached there: skip", hit: hitOf("BUY", false), rows: [reached("BUY", B + HOUR, B + HOUR)], step: "skip", by: 0 },
    { name: "tail decided late: a ride of the side entered hours later and reached: skip", hit: hitOf("SELL", false), rows: [reached("SELL", B + 3 * HOUR, B + 7 * HOUR)], step: "skip", by: 0 },
    { name: "tail decided late: a ride of the side entered after j whose reached bar is not kept: skip all the same", hit: hitOf("SELL", false), rows: [reached("SELL", B + HOUR, null)], step: "skip", by: 0 },
    { name: "tail decided late: already, and a ride of the side entered in the next bar, open: quiet", hit: hitOf("BUY", true), rows: [open("BUY", B + HOUR)], step: "quiet", by: 0 },
    { name: "tail decided late: already, and a ride of the side entered in the next bar and reached there: quiet", hit: hitOf("SELL", true), rows: [reached("SELL", B + HOUR, B + HOUR)], step: "quiet", by: 0 },
    { name: "tail decided late: a ride of the OTHER side entered in the next bar: in", hit: hitOf("BUY", false), rows: [open("SELL", B + HOUR)], step: "in" },
    { name: "tail decided late: already, and a ride of the OTHER side entered in the next bar: the notice", hit: hitOf("BUY", true), rows: [reached("SELL", B + HOUR, B + 2 * HOUR)], step: "at" },
    {
      name: "tail decided late: a ride of the side reached long ago, and one entered in the next bar: skip by the later one",
      hit: hitOf("BUY", false),
      rows: [reached("BUY", B - 50 * HOUR, B - 40 * HOUR), open("BUY", B + HOUR)],
      step: "skip",
      by: 1,
    },
    {
      name: "tail decided late: an older ride open and one entered after j cannot both be (one open ride a side); the older open one is named",
      hit: hitOf("BUY", false),
      rows: [open("BUY", B - 4 * HOUR), reached("BUY", B + HOUR, B + 2 * HOUR)],
      step: "skip",
      by: 0,
    },
    // v9's own row: the bar's own ride (a decision kept as a ride row) stays "in" whatever a later read gives
    { name: "the bar's own ride row there: in, nothing new opened", hit: hitOf("BUY", false), rows: [open("BUY", B)], step: "in", own: 0 },
    { name: "the bar's own ride row there, a later read already: still in", hit: hitOf("BUY", true), rows: [reached("BUY", B, B)], step: "in", own: 0 },
    { name: "the bar's own ride row there and a ride entered after it: still in", hit: hitOf("SELL", false), rows: [reached("SELL", B, B + HOUR), open("SELL", B + 2 * HOUR)], step: "in", own: 0 },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const got = rideCloseStep(c.hit, B, c.rows);
      expect(got.step).toBe(c.step);
      expect(got.side).toBe(c.hit?.side ?? null);
      expect(got.zside).toBe(c.hit?.zside ?? null);
      expect(got.by).toBe(c.by === undefined ? null : c.rows[c.by]);
      expect(got.own).toBe(c.own === undefined ? null : c.rows[c.own]);
      // the rows' order is not read
      const back = rideCloseStep(c.hit, B, [...c.rows].reverse());
      expect(back.step).toBe(c.step);
      expect(back.by).toBe(got.by);
      expect(back.own).toBe(got.own);
    });
  }

  it("at a minute's read the skip is the study's T0 < T: a ride reached at an earlier read or at this very read does not skip, one reached later does", () => {
    // a ride entered before bar j and reached at the read of minute r of bar j (reaches first); the entry decided at the
    // read of minute e. At e the rows hold the ride open when r > e, reached in bar j when r <= e
    for (let e = 0; e < 60; e += 7) {
      for (let r = 0; r < 60; r += 5) {
        const row = r <= e ? reached("BUY", B - 3 * HOUR, B) : open("BUY", B - 3 * HOUR);
        const T0 = B + (e + 1) * MINUTE;
        const T = B + (r + 1) * MINUTE;
        expect(rideCloseStep(hitOf("BUY", false), B, [row]).step).toBe(T0 < T ? "skip" : "in");
        // already: never skipped; quiet when the ride was reached in this bar by then
        expect(rideCloseStep(hitOf("BUY", true), B, [row]).step).toBe(r <= e ? "quiet" : "at");
      }
    }
  });
});

// ---- 5. the catch-up of the entry bar ----------------------------------------------------------------------------

describe("v10 the catch-up of a minute ride's entry bar at its own close (rideCatchUp's entryBarToo, section 4 A.3)", () => {
  it("the entry bar the newest in hand: rideTouch on its state with its high and low, bit for bit; v9's reading does not read it", () => {
    const seen = { top: 0, bottom: 0, none: 0 };
    for (const w of WALKS) {
      for (let i = W; i < w.bars.length; i++) {
        const in600 = w.bars.slice(i - (W - 1), i + 1);
        const in601 = w.bars.slice(i - W, i + 1);
        const b = w.bars[i];
        for (const zs of SIDES) {
          // the ride entered at a minute of bar i: bar i is its entry bar and the newest in hand
          expect(rideCatchUp(in600, zs, b.t)).toBeNull();
          const want = rideTouch(w.state[i] as RideState, zs, b.high, b.low);
          const got = rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, {});
          if (want === null) {
            expect(got).toBeNull();
            seen.none++;
            continue;
          }
          expect(got).not.toBeNull();
          const g = got as NonNullable<typeof got>;
          expect(g.m).toBe(want.m);
          expect(g.top).toBe(want.top);
          expect(g.bottom).toBe(want.bottom);
          expect(g.share).toBe(want.share);
          expect(g.share).toBeGreaterThanOrEqual(0.95);
          expect(g.bar).toBe(b.t);
          expect(g.index).toBe(W - 1);
          expect(g.newest).toBe(true);
          expect(g.x).toBe(zs === "top" ? b.high : b.low);
          expect(rideCatchUp(in601, zs, b.t, RIDE_CATCHUP_BARS, {})).toEqual({ ...g, index: W });
          // the limit counts the newest bar in: 1 is enough
          expect(rideCatchUp(in600, zs, b.t, 1, {})).toEqual(g);
          seen[zs]++;
        }
      }
    }
    expect(seen.top).toBeGreaterThan(100);
    expect(seen.bottom).toBeGreaterThan(100);
    expect(seen.none).toBeGreaterThan(1000);
  }, SLOW);

  it("gold: the entry bar's high and low as given (the extremes of the hour's recorded minutes) in place of the bar's", () => {
    let compared = 0;
    for (const [wi, w] of WALKS.entries()) {
      const rnd = rndOf(6000 + wi);
      for (let i = W; i < w.bars.length; i += 3) {
        const in600 = w.bars.slice(i - (W - 1), i + 1);
        const b = w.bars[i];
        const st = w.state[i] as RideState;
        // another feed's extremes: up to 0.3% past or short of the bar's
        const high = b.high * (1 + (rnd() - 0.5) * 0.006);
        const low = b.low * (1 + (rnd() - 0.5) * 0.006);
        for (const zs of SIDES) {
          const want = rideTouch(st, zs, high, low);
          const got = rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, { high, low });
          if (want === null) expect(got).toBeNull();
          else expect(got).toEqual({ ...want, bar: b.t, index: W - 1, newest: true, x: zs === "top" ? high : low });
          // one given: the other is the bar's own
          expect(rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, { high })).toEqual(rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, { high, low: b.low }));
          expect(rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, { low })).toEqual(rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, { high: b.high, low }));
          // no recorded minute (no number): no touch in the entry bar
          expect(rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, { high: NaN, low: NaN })).toBeNull();
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  }, SLOW);

  it("an entry bar that is not the newest in hand is not read (its own close only); the bars after it are read as v9 reads them", () => {
    let caught = 0;
    let checked = 0;
    for (const w of WALKS) {
      for (let i = W - 1 + RIDE_CATCHUP_BARS; i < w.bars.length; i += 5) {
        const hand = w.bars.slice(i - (W - 1), i + 1);
        for (const back of [1, 2, 7, 60]) {
          const e = hand[W - 1 - back].t;
          for (const zs of SIDES) {
            const v9 = rideCatchUp(hand, zs, e);
            // the entry bar's own extremes given far past every edge: still not read, and not lent to a later bar
            expect(rideCatchUp(hand, zs, e, RIDE_CATCHUP_BARS, {})).toEqual(v9);
            expect(rideCatchUp(hand, zs, e, RIDE_CATCHUP_BARS, { high: 1e9, low: -1e9 })).toEqual(v9);
            if (v9 !== null) {
              expect(v9.bar).toBeGreaterThan(e);
              caught++;
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(caught).toBeGreaterThan(100);
    // the closes in hand as v9's: one that is no number, or a bad limit, judges nothing
    const w = WALKS[0];
    for (let i = W; i < w.bars.length; i++) {
      const in600 = w.bars.slice(i - (W - 1), i + 1);
      const b = w.bars[i];
      const zs: RideZoneSide = rideTouch(w.state[i] as RideState, "top", b.high, b.low) !== null ? "top" : "bottom";
      if (rideCatchUp(in600, zs, b.t, RIDE_CATCHUP_BARS, {}) === null) continue;
      expect(rideCatchUp(in600.map((x, k) => (k === 100 ? { ...x, close: NaN } : x)), zs, b.t, RIDE_CATCHUP_BARS, {})).toBeNull();
      for (const bad of [0, -1, 1.5, NaN]) expect(rideCatchUp(in600, zs, b.t, bad, {})).toBeNull();
      // fewer than 480 bars in hand: the newest is not judged
      expect(rideCatchUp(in600.slice(W - 479), zs, b.t, RIDE_CATCHUP_BARS, {})).toBeNull();
      break;
    }
  }, SLOW);
});

// ---- 6. walks with minutes, read by read, against the study's moment entries with way C ------------------------------

// A seeded walk of 1-minute bars (the mid's high, low and close, rounded as the chart draws them), and its 1-hour bars:
// the high the highest of the hour's minutes' highs, the low the lowest, the close the last minute's close
interface MinuteWalk {
  name: string;
  bars: RideBar[];
  closes: number[];
  minutes: Array<Array<{ hi: number; lo: number }>>;
}
const minuteWalkOf = (name: string, hours: number, seed: number, start: number, d: number, vol: number): MinuteWalk => {
  const rnd = rndOf(seed);
  const bars: RideBar[] = [];
  const minutes: Array<Array<{ hi: number; lo: number }>> = [];
  let v = start;
  for (let j = 0; j < hours; j++) {
    const ms: Array<{ hi: number; lo: number }> = [];
    for (let k = 0; k < 60; k++) {
      const o = v;
      v *= 1 + (rnd() - 0.5) * vol;
      ms.push({ hi: Number((Math.max(o, v) * (1 + (rnd() * vol) / 4)).toFixed(d)), lo: Number((Math.min(o, v) * (1 - (rnd() * vol) / 4)).toFixed(d)) });
    }
    minutes.push(ms);
    bars.push({ t: T0 + j * HOUR, high: Math.max(...ms.map((m) => m.hi)), low: Math.min(...ms.map((m) => m.lo)), close: Number(v.toFixed(d)) });
  }
  return { name, bars, closes: bars.map((b) => b.close), minutes };
};

// The study again (research/macd90m.ts, REACH = 0.95; its arithmetic written again here): bar i's window the 600
// closes ending at i; `prepare` the EMAs and the signal at index 598 and the pane over 480..598; the line at a minute
// with the minute's own high (top) or low (bottom) as the bar's close; zp the zone at 598 of the window. The moment
// entry: the first minute of bar i that touches 0.90 on a side zp is not at (top first); already when that line is at
// 0.95. Way C: each side apart, entries in time order (T0 the minute's end); one that is not already is skipped when
// T0 < T of the last one taken (Infinity while it is open); a taken one is followed from the next minute, each
// minute's own price toward its side, to the first at 0.95 (T that minute's end)
const A12 = 2 / (MACD_DEFAULTS.fast + 1);
const A26 = 2 / (MACD_DEFAULTS.slow + 1);
const A9 = 2 / (MACD_DEFAULTS.signal + 1);
interface Prep {
  f12: number;
  s26: number;
  sig: number;
  top119: number;
  bottom119: number;
}
const prepare = (window600: number[]): Prep => {
  const r = macd(window600);
  const f = pineEma(window600, MACD_DEFAULTS.fast);
  const s = pineEma(window600, MACD_DEFAULTS.slow);
  let top = 0;
  let bottom = 0;
  for (const xs of [r.macd, r.signal, r.hist]) {
    for (let k = W - ZONE_BARS; k <= W - 2; k++) {
      const v = xs[k] as number;
      if (v > top) top = v;
      if (v < bottom) bottom = v;
    }
  }
  return { f12: f[W - 2] as number, s26: s[W - 2] as number, sig: r.signal[W - 2] as number, top119: top, bottom119: bottom };
};
const liveZone = (p: Prep, x: number): RideZone => {
  const f = A12 * x + (1 - A12) * p.f12;
  const s = A26 * x + (1 - A26) * p.s26;
  const m = f - s;
  const sig = A9 * m + (1 - A9) * p.sig;
  const h = m - sig;
  let top = p.top119;
  let bottom = p.bottom119;
  for (const v of [m, sig, h]) {
    if (v > top) top = v;
    if (v < bottom) bottom = v;
  }
  return { m, top, bottom };
};

interface Decision {
  i: number;
  k: number;
  zside: RideZoneSide;
  x: number;
  share0: number;
  already: boolean;
  // way C: "in" (taken), "skip", or an already one ("at" or "quiet" to the function; the study's no trade)
  way: "in" | "skip" | "already";
  // a taken one: T0 and the moment out (null while open)
  T0: number;
  T: number | null;
}

const studyOf = (mw: MinuteWalk): Decision[] => {
  const n = mw.bars.length;
  const prep: Array<Prep | null> = new Array(n).fill(null);
  const zp: Array<RideZone | null> = new Array(n).fill(null);
  for (let i = W - 1; i < n; i++) {
    const win = mw.closes.slice(i - (W - 1), i + 1);
    prep[i] = prepare(win);
    const z = zoneAt(macd(win), W - 2) as RideZone;
    zp[i] = { m: z.m, top: z.top, bottom: z.bottom };
  }
  const toward = (i: number, k: number, zs: RideZoneSide) => (zs === "top" ? mw.minutes[i][k].hi : mw.minutes[i][k].lo);
  const out: Decision[] = [];
  for (let i = W - 1; i < n; i++) {
    for (let k = 0; k < 60; k++) {
      let hit: { zs: RideZoneSide; z: RideZone; x: number } | null = null;
      for (const zs of SIDES) {
        if (hit !== null || atS(zp[i] as RideZone, zs, 0.9)) continue;
        const x = toward(i, k, zs);
        const z = liveZone(prep[i] as Prep, x);
        if (atS(z, zs, 0.9)) hit = { zs, z, x };
      }
      if (hit === null) continue;
      const already = atS(hit.z, hit.zs, 0.95);
      out.push({ i, k, zside: hit.zs, x: hit.x, share0: shareOf(hit.z, hit.zs), already, way: already ? "already" : "in", T0: mw.bars[i].t + (k + 1) * MINUTE, T: null });
      break;
    }
  }
  const until: Record<RideZoneSide, number> = { top: -Infinity, bottom: -Infinity };
  for (const e of out) {
    if (e.already) continue;
    if (e.T0 < until[e.zside]) {
      e.way = "skip";
      continue;
    }
    let T: number | null = null;
    for (let j = e.i; j < n && T === null; j++) {
      for (let k = j === e.i ? e.k + 1 : 0; k < 60; k++) {
        if (atS(liveZone(prep[j] as Prep, toward(j, k, e.zside)), e.zside, 0.95)) {
          T = mw.bars[j].t + (k + 1) * MINUTE;
          break;
        }
      }
    }
    e.T = T;
    until[e.zside] = T === null ? Infinity : T;
  }
  return out;
};

// As the function reads (research/macdride10-spec.md section 4 B, every minute read at its end, as the replay's R1):
// bar i's state and Zp from the 599 closes before it; at each read the bar's high and low so far; reaches first (each
// open ride whose entry moment is before this read's), then the bar's one decision while it has none (rideHit, then
// rideCloseStep on the rides as they stand). At each close the catch-up (with the entry bar for a ride entered in it)
// and the tail of an undecided bar.
interface Driven {
  decisions: Array<Decision & { step: RideStep }>;
  rides: Array<{ side: RideSide; T0: number; T: number | null }>;
  caught: number;
  tails: number;
}
const drive = (mw: MinuteWalk): Driven => {
  const n = mw.bars.length;
  const table: Array<RideRow & { T0: number; T: number | null }> = [];
  const decisions: Array<Decision & { step: RideStep }> = [];
  let caught = 0;
  let tails = 0;
  for (let i = W - 1; i < n; i++) {
    const sz = rideStateZpOf(mw.closes.slice(i - (W - 1), i));
    if (sz === null) throw new Error(`${mw.name}: no state at ${i}`);
    const open_ = mw.bars[i].t;
    let hi = -Infinity;
    let lo = Infinity;
    let decided = false;
    for (let k = 0; k < 60; k++) {
      const now = open_ + (k + 1) * MINUTE;
      hi = Math.max(hi, mw.minutes[i][k].hi);
      lo = Math.min(lo, mw.minutes[i][k].lo);
      for (const r of table) {
        if (r.status !== "open" || !(r.T0 < now)) continue;
        if (rideTouch(sz.state, rideZoneSideOf(r.side), hi, lo) === null) continue;
        r.status = "reached";
        r.reachedBar = open_;
        r.T = now;
      }
      if (decided) continue;
      const hit = rideHit(sz.state, sz.zp, hi, lo);
      if (hit === null) continue;
      decided = true;
      const s = rideCloseStep(hit, open_, table);
      expect(s.own).toBeNull();
      const step = s.step as RideStep;
      decisions.push({ i, k, zside: hit.zside, x: hit.x, share0: hit.share0, already: hit.already, way: step === "in" ? "in" : step === "skip" ? "skip" : "already", T0: now, T: null, step });
      if (step === "in") table.push({ side: hit.side, entryBar: open_, status: "open", reachedBar: null, T0: now, T: null });
    }
    // the close of bar i: every minute was read, so the catch-up and the tail find nothing (research/macdride10-spec.md
    // section 9, R1)
    const hand = mw.bars.slice(Math.max(0, i - (W - 1)), i + 1);
    for (const r of table) {
      if (r.status !== "open") continue;
      const c = rideCatchUp(hand, rideZoneSideOf(r.side), r.entryBar, RIDE_CATCHUP_BARS, r.entryBar === open_ ? {} : null);
      if (c !== null) caught++;
    }
    if (!decided && rideHit(sz.state, sz.zp, mw.bars[i].high, mw.bars[i].low) !== null) tails++;
  }
  return { decisions, rides: table.map((r) => ({ side: r.side, T0: r.T0, T: r.T })), caught, tails };
};

describe("v10 walks read minute by minute as the function reads them, against the study's moment entries with way C", () => {
  it("the same decisions (bar, minute, side, price, share, already, skip) and the same rides; the catch-up and the tail find nothing", () => {
    const totals = { decisions: 0, in: 0, at: 0, quiet: 0, skip: 0, reached: 0, reachedInEntryBar: 0, open: 0 };
    const walks = [
      minuteWalkOf("150.123 seed 51", 1800, 51, 150.123, 3, 0.0005),
      minuteWalkOf("1.10234 seed 52", 1800, 52, 1.10234, 5, 0.0005),
      minuteWalkOf("4123.45 seed 53", 1800, 53, 4123.45, 2, 0.0007),
      minuteWalkOf("97.531 seed 54", 1800, 54, 97.531, 3, 0.0004),
    ];
    for (const mw of walks) {
      const want = studyOf(mw);
      const got = drive(mw);
      expect(got.decisions.map(({ step: _s, ...d }) => d).map((d) => ({ ...d, T: null }))).toEqual(want.map((d) => ({ ...d, T: null })));
      for (const d of got.decisions) {
        // bit for bit with the study's line (toEqual above holds x and share0 with Object.is)
        if (d.step === "at" || d.step === "quiet") expect(d.already).toBe(true);
        totals[d.step]++;
      }
      const taken = want.filter((d) => d.way === "in").map((d) => ({ side: (d.zside === "top" ? "BUY" : "SELL") as RideSide, T0: d.T0, T: d.T }));
      expect(got.rides).toEqual(taken);
      expect(got.caught).toBe(0);
      expect(got.tails).toBe(0);
      totals.decisions += got.decisions.length;
      for (const r of got.rides) {
        if (r.T === null) totals.open++;
        else {
          totals.reached++;
          if (Math.floor((r.T - 1 - T0) / HOUR) === Math.floor((r.T0 - 1 - T0) / HOUR)) totals.reachedInEntryBar++;
        }
      }
    }
    // the walks hold every step: the comparison is of something
    expect(totals.in).toBeGreaterThan(30);
    expect(totals.skip).toBeGreaterThan(10);
    expect(totals.at).toBeGreaterThan(10);
    expect(totals.quiet).toBeGreaterThan(0);
    expect(totals.reached).toBeGreaterThan(30);
    // rides reached in their entry bar, at a later read (section 1.2)
    expect(totals.reachedInEntryBar).toBeGreaterThan(5);
  }, SLOW);
});
