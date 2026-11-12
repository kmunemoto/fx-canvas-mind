// #397 (docs §8.150): the MACD email as a ride (in at 90% with the flow, told
// at 96%) — the code the function and the replay share
// (supabase/functions/_shared/macd-ride.ts; the rule: research/macdride-spec.md).
//
//   1. the state and the line while a bar forms, against zoneAt on the window
//      rebuilt with the price in the forming slot: bit for bit, on seeded
//      random walks (prices of 3, 5, 2 and 1 decimals)
//   2. the entry at a bar's close, against the rule written again here
//      straight from the spec's sentences (zoneAt at 599 and 598, the two
//      shares) on every bar of the walks
//   3. the catch-up: the newest closed bar bit for bit as rideTouch on the
//      state of the 599 closes before it; older bars within 1e-9 of their own
//      600-window state; the shares' (by the close) against each bar's own Z
//   4. what a bar's close does (in, at, skip, quiet): a table of cases, the
//      same closes judged again and again over a made-up ride table, and the
//      walks driven bar by bar against the study's way C written again here
//      (research/macd90m-spec.md: held until reached, an entry before the
//      held ride's moment out skipped)
import { describe, expect, it } from "vitest";
import { macd, MACD_DEFAULTS } from "../../supabase/functions/_shared/macd";
import { pineEma } from "../../supabase/functions/_shared/pine";
import { LEVEL_WINDOW, ZONE_BARS, ZONE_PCT, decideZoneOnWindow, zoneAt } from "../../supabase/functions/_shared/macd-level";
import {
  atShare,
  RIDE_CATCHUP_BARS,
  RIDE_CATCHUP_MIN_BEFORE,
  RIDE_IN_PCT,
  RIDE_IN_SHARE,
  RIDE_OUT_PCT,
  RIDE_OUT_SHARE,
  RIDE_RULE_TAG,
  type RideBar,
  rideCatchUp,
  rideCatchUpByClose,
  rideCloseStep,
  type RideEntry,
  rideEntryAt,
  rideLineAt,
  type RideRow,
  rideRuleId,
  type RideSide,
  rideSideOf,
  type RideState,
  rideStateFrom,
  rideStateOf,
  type RideStep,
  rideTouch,
  type RideZone,
  rideZoneAt,
  type RideZoneSide,
  rideZoneSideOf,
  shareOf,
} from "../../supabase/functions/_shared/macd-ride";

const HOUR = 3_600_000;
const W = LEVEL_WINDOW;
const T0 = Date.UTC(2026, 0, 5, 0);
const SIDES: RideZoneSide[] = ["top", "bottom"];
// the loops over the walks take a second or two each: room for a slower machine
const SLOW = 60_000;

// ---- seeded walks ---------------------------------------------------------------------------

const rndOf = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

// 1-hour bars of a seeded walk, rounded to `d` decimals as a chart draws them
// (the high at or above the close, the low at or below it; `wick`: how far
// past the open and the close they can go, as a share of the price)
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
const walkOf = (name: string, n: number, seed: number, start: number, d: number, wick?: number): Walk => {
  const bars = walk(n, seed, start, d, wick);
  const closes = bars.map((b) => b.close);
  const state: Array<RideState | null> = bars.map((_, j) => (j >= W - 1 ? rideStateOf(closes.slice(j - (W - 1), j)) : null));
  return { name, bars, closes, state };
};

// yen pairs (3 decimals), the others (5), gold (2), a Tokyo share (1)
const WALKS: Walk[] = [
  walkOf("150.123 seed 1", 1500, 1, 150.123, 3),
  walkOf("150.123 seed 2", 1500, 2, 150.123, 3),
  walkOf("97.531 seed 3", 1500, 3, 97.531, 3),
  walkOf("1.10234 seed 4", 1500, 4, 1.10234, 5),
  walkOf("1.10234 seed 5", 1500, 5, 1.10234, 5),
  walkOf("0.65432 seed 6", 1500, 6, 0.65432, 5),
  walkOf("4123.45 seed 7", 1500, 7, 4123.45, 2),
  walkOf("2876.5 seed 8", 1500, 8, 2876.5, 1),
];

// ---- 0. the numbers -------------------------------------------------------------------------

describe("#397 the ride's numbers", () => {
  it("90 and 96 percent of the v8 pane (600 closed bars, the newest 120), as the doubles the study held against", () => {
    expect(RIDE_IN_PCT).toBe(90);
    expect(RIDE_OUT_PCT).toBe(96);
    // research/macd90.ts ENTER and REACH
    expect(RIDE_IN_SHARE).toBe(0.9);
    expect(RIDE_OUT_SHARE).toBe(0.96);
    expect(LEVEL_WINDOW).toBe(600);
    expect(ZONE_BARS).toBe(120);
    expect(MACD_DEFAULTS).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(RIDE_CATCHUP_BARS).toBe(100);
    expect(RIDE_CATCHUP_MIN_BEFORE).toBe(479);
    // _shared/macd-level.ts keeps v8's 95
    expect(ZONE_PCT).toBe(95);
  });

  it("the three rule ids of each run, built from the constants (spec section 2)", () => {
    expect(RIDE_RULE_TAG).toBe("ride90to96of120");
    expect(rideRuleId("macdx", "in", 9)).toBe("macdx_12_26_9_w600_1h_ride90to96of120_in_v9");
    expect(rideRuleId("macdx", "at", 9)).toBe("macdx_12_26_9_w600_1h_ride90to96of120_at_v9");
    expect(rideRuleId("macdx", "out", 9)).toBe("macdx_12_26_9_w600_1h_ride90to96of120_out_v9");
    expect(rideRuleId("stockmacd", "in", 2)).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2");
    expect(rideRuleId("stockmacd", "at", 2)).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_at_v2");
    expect(rideRuleId("stockmacd", "out", 2)).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_out_v2");
  });

  it("the top is a BUY and the bottom a SELL (with the flow)", () => {
    expect(rideSideOf("top")).toBe("BUY");
    expect(rideSideOf("bottom")).toBe("SELL");
    expect(rideZoneSideOf("BUY")).toBe("top");
    expect(rideZoneSideOf("SELL")).toBe("bottom");
  });

  it("at a share: the product held against as it comes, equality in, no band without an edge past zero", () => {
    const z = (m: number, top: number, bottom: number): RideZone => ({ m, top, bottom });
    expect(atShare(z(0.9 * 0.07, 0.07, -0.01), "top", 0.9)).toBe(true);
    expect(atShare(z(0.9 * 0.07 - 1e-12, 0.07, -0.01), "top", 0.9)).toBe(false);
    expect(atShare(z(0.07, 0.07, -0.01), "top", 0.96)).toBe(true);
    expect(atShare(z(0.9 * -0.07, 0.01, -0.07), "bottom", 0.9)).toBe(true);
    expect(atShare(z(0.9 * -0.07 + 1e-12, 0.01, -0.07), "bottom", 0.9)).toBe(false);
    // the top side is not read on the bottom, nor the bottom on the top
    expect(atShare(z(0.07, 0.07, -0.01), "bottom", 0.9)).toBe(false);
    expect(atShare(z(-0.07, 0.01, -0.07), "top", 0.9)).toBe(false);
    // nothing above zero in the pane: no top band, wherever the line is
    expect(atShare(z(0, 0, -0.05), "top", 0.9)).toBe(false);
    expect(atShare(z(0, 0.05, 0), "bottom", 0.9)).toBe(false);
    expect(shareOf(z(0.03, 0.06, -0.02), "top")).toBe(0.5);
    expect(shareOf(z(-0.01, 0.06, -0.02), "bottom")).toBe(0.5);
  });
});

// ---- 1. the state and the line while a bar forms ---------------------------------------------

describe("#397 the forming bar's line from the state is zoneAt on the window rebuilt, bit for bit", () => {
  it("the state is the EMAs and the signal at index 598 and the pane over 480..598 (the spec's sentence)", () => {
    let compared = 0;
    for (const w of WALKS) {
      for (let j = W - 1; j < w.bars.length; j += 13) {
        const c599 = w.closes.slice(j - (W - 1), j);
        // any finite number in the forming slot: nothing up to 598 depends on it
        const win = [...c599, 12345.678];
        const r = macd(win);
        let top = 0;
        let bottom = 0;
        for (const xs of [r.macd, r.signal, r.hist]) {
          for (let k = W - ZONE_BARS; k <= W - 2; k++) {
            top = Math.max(top, xs[k] as number);
            bottom = Math.min(bottom, xs[k] as number);
          }
        }
        const st = w.state[j] as RideState;
        expect(st.e12).toBe(pineEma(win, 12)[W - 2]);
        expect(st.e26).toBe(pineEma(win, 26)[W - 2]);
        expect(st.sig).toBe(r.signal[W - 2]);
        expect(st.top119).toBe(top);
        expect(st.bottom119).toBe(bottom);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("rideLineAt(rideStateOf(c599), x) is zoneAt(macd(c599 + [x]), 599): m, top and bottom, for many bars and prices", () => {
    let compared = 0;
    for (const [wi, w] of WALKS.entries()) {
      const rnd = rndOf(1000 + wi);
      for (let j = W - 1; j < w.bars.length; j += 3) {
        const c599 = w.closes.slice(j - (W - 1), j);
        const st = rideStateOf(c599);
        expect(st).not.toBeNull();
        const b = w.bars[j];
        const last = c599[W - 2];
        const xs = [
          // the bar's own prices as the chart draws them, and the close before
          b.close,
          b.high,
          b.low,
          last,
          // prices that are not rounded, near and far
          last * (1 + (rnd() - 0.5) * 0.002),
          last * (1 + (rnd() - 0.5) * 0.02),
          last * 1.05,
          last * 0.95,
          0,
          1e6,
        ];
        for (const x of xs) {
          const z = zoneAt(macd([...c599, x]), W - 1);
          expect(z).not.toBeNull();
          const line = rideLineAt(st as RideState, x);
          expect(line.m).toBe((z as RideZone).m);
          expect(line.top).toBe((z as RideZone).top);
          expect(line.bottom).toBe((z as RideZone).bottom);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(20000);
  }, SLOW);

  it("with the bar's own close the line is Z of the bar (rideZoneAt, zoneAt at 599 of its own 600 closes)", () => {
    for (const w of WALKS) {
      for (let j = W - 1; j < w.bars.length; j += 5) {
        const c600 = w.closes.slice(j - (W - 1), j + 1);
        const z = zoneAt(macd(c600), W - 1) as RideZone;
        expect(rideZoneAt(c600)).toEqual({ m: z.m, top: z.top, bottom: z.bottom });
        expect(rideLineAt(w.state[j] as RideState, w.closes[j])).toEqual({ m: z.m, top: z.top, bottom: z.bottom });
      }
    }
  });

  it("of more closes the newest are taken; fewer, or a close that is no number, gives nothing", () => {
    const w = WALKS[0];
    const j = 900;
    const st = rideStateOf(w.closes.slice(j - (W - 1), j));
    expect(st).not.toBeNull();
    expect(rideStateOf(w.closes.slice(0, j))).toEqual(st);
    expect(rideStateOf(w.closes.slice(j - (W - 1) - 1, j))).toEqual(st);
    // a close older than the newest 599 is not read at all
    expect(rideStateOf([NaN, ...w.closes.slice(1, j)])).toEqual(st);
    expect(rideStateOf(w.closes.slice(j - (W - 2), j))).toBeNull();
    expect(rideStateOf([])).toBeNull();
    for (const bad of [NaN, Infinity, null as unknown as number, undefined as unknown as number]) {
      for (const at of [0, 300, W - 2]) {
        const c = w.closes.slice(j - (W - 1), j);
        c[at] = bad;
        expect(rideStateOf(c)).toBeNull();
      }
    }
    // the entry and Z likewise, on 600
    const c600 = w.closes.slice(j - (W - 1), j + 1);
    expect(rideZoneAt(c600)).not.toBeNull();
    expect(rideZoneAt(w.closes.slice(0, j + 1))).toEqual(rideZoneAt(c600));
    expect(rideZoneAt([NaN, ...w.closes.slice(1, j + 1)])).toEqual(rideZoneAt(c600));
    for (let i = W - 1 + 5; i < w.bars.length; i++) {
      const own = w.closes.slice(i - (W - 1), i + 1);
      expect(rideEntryAt(w.closes.slice(0, i + 1))).toEqual(rideEntryAt(own));
      expect(rideEntryAt([NaN, ...w.closes.slice(i - (W - 1) - 4, i + 1)])).toEqual(rideEntryAt(own));
    }
    expect(rideZoneAt(c600.slice(1))).toBeNull();
    expect(rideEntryAt(c600.slice(1))).toBeNull();
    for (const at of [0, 300, W - 1]) {
      const c = c600.slice();
      c[at] = NaN;
      expect(rideZoneAt(c)).toBeNull();
      expect(rideEntryAt(c)).toBeNull();
    }
  });

  it("a state kept as a row and read back is the same state: JSON text carries its doubles, the row's other columns are left", () => {
    let compared = 0;
    for (const w of WALKS) {
      for (let j = W - 1; j < w.bars.length; j += 7) {
        const st = w.state[j] as RideState;
        const row = JSON.parse(JSON.stringify({ pair: "USD/JPY", bar_time: "2026-11-12T04:00:00+00:00", ...st, last_bar: "2026-11-12T03:00:00+00:00", source_read_at: null }));
        const back = rideStateFrom(row);
        expect(back).toEqual(st);
        expect(Object.keys(back as RideState).sort()).toEqual(["bottom119", "e12", "e26", "sig", "top119"]);
        expect(rideLineAt(back as RideState, w.bars[j].high)).toEqual(rideLineAt(st, w.bars[j].high));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(900);
    // a row that does not hold the five numbers is no state
    const good = { e12: 150.1, e26: 150.0, sig: 0.05, top119: 0.12, bottom119: -0.03 };
    expect(rideStateFrom(good)).toEqual(good);
    expect(rideStateFrom({ ...good, top119: 0, bottom119: 0 })).toEqual({ ...good, top119: 0, bottom119: 0 });
    for (const key of ["e12", "e26", "sig", "top119", "bottom119"] as const) {
      for (const bad of [null, undefined, "0.1", NaN, Infinity, {}]) expect(rideStateFrom({ ...good, [key]: bad })).toBeNull();
      const { [key]: _gone, ...rest } = good;
      expect(rideStateFrom(rest)).toBeNull();
    }
    // the pane's edges hold 0: a top below it or a bottom above it was never made by rideStateOf
    expect(rideStateFrom({ ...good, top119: -0.01 })).toBeNull();
    expect(rideStateFrom({ ...good, bottom119: 0.01 })).toBeNull();
    for (const bad of [null, undefined, 5, "state", []]) expect(rideStateFrom(bad)).toBeNull();
    for (const w of WALKS) for (const st of w.state) if (st !== null) expect(st.top119 >= 0 && st.bottom119 <= 0).toBe(true);
  });

  it("a touch is the line with the high (top side) or the low (bottom side) at 96% on that side", () => {
    const seen = { top: 0, bottom: 0, none: 0 };
    for (const w of WALKS) {
      for (let j = W - 1; j < w.bars.length; j++) {
        const st = w.state[j] as RideState;
        const b = w.bars[j];
        for (const zs of SIDES) {
          const x = zs === "top" ? b.high : b.low;
          const z = zoneAt(macd([...w.closes.slice(j - (W - 1), j), x]), W - 1) as RideZone;
          const want = zs === "top" ? z.top > 0 && z.m >= 0.96 * z.top : z.bottom < 0 && z.m <= 0.96 * z.bottom;
          const got = rideTouch(st, zs, b.high, b.low);
          if (!want) {
            expect(got).toBeNull();
            seen.none++;
            continue;
          }
          expect(got).toEqual({ m: z.m, top: z.top, bottom: z.bottom, share: zs === "top" ? z.m / z.top : z.m / z.bottom });
          expect((got as { share: number }).share).toBeGreaterThanOrEqual(0.96);
          seen[zs]++;
        }
      }
    }
    expect(seen.top).toBeGreaterThan(100);
    expect(seen.bottom).toBeGreaterThan(100);
    expect(seen.none).toBeGreaterThan(1000);
    // a price that is no number touches nothing
    const st = WALKS[0].state[700] as RideState;
    expect(rideTouch(st, "top", NaN, 1)).toBeNull();
    expect(rideTouch(st, "bottom", 1e9, NaN)).toBeNull();
    expect(rideTouch(st, "top", Infinity, 1)).toBeNull();
  }, SLOW);
});

// ---- 2. the entry at a bar's close ------------------------------------------------------------

// The rule again, apart from the module, from research/macdride-spec.md section 1:
// r = macd(the 600 closes ending at i); Z(i) = zoneAt(r, 599), Zp(i) = zoneAt(r, 598);
// an entry on a side when Z(i) is at 0.90 there and Zp(i) is not; already when Z(i) is at 0.96
const bruteEntry = (closes600: number[]): RideEntry | null => {
  const r = macd(closes600);
  const Z = zoneAt(r, 599);
  const Zp = zoneAt(r, 598);
  if (Z === null || Zp === null) return null;
  const z = { m: Z.m, top: Z.top, bottom: Z.bottom };
  const zp = { m: Zp.m, top: Zp.top, bottom: Zp.bottom };
  const topNow = Z.top > 0 && Z.m >= 0.9 * Z.top;
  const topBefore = Zp.top > 0 && Zp.m >= 0.9 * Zp.top;
  const bottomNow = Z.bottom < 0 && Z.m <= 0.9 * Z.bottom;
  const bottomBefore = Zp.bottom < 0 && Zp.m <= 0.9 * Zp.bottom;
  if (topNow && !topBefore) return { zside: "top", side: "BUY", already: Z.m >= 0.96 * Z.top, z, zp };
  if (bottomNow && !bottomBefore) return { zside: "bottom", side: "SELL", already: Z.m <= 0.96 * Z.bottom, z, zp };
  return null;
};

describe("#397 the entry at a bar's close", () => {
  it("is the rule written again from the spec's sentences, on every bar of the walks", () => {
    const n = { BUY: 0, SELL: 0, already: 0, ride: 0, none: 0 };
    for (const w of WALKS) {
      for (let i = W - 1; i < w.bars.length; i++) {
        const c600 = w.closes.slice(i - (W - 1), i + 1);
        const want = bruteEntry(c600);
        const got = rideEntryAt(c600);
        expect(got).toEqual(want);
        if (got === null) n.none++;
        else {
          n[got.side]++;
          if (got.already) n.already++;
          else n.ride++;
        }
      }
    }
    // the walks hold entries of both sides, notices and rides: the comparison is of something
    expect(n.BUY).toBeGreaterThan(20);
    expect(n.SELL).toBeGreaterThan(20);
    expect(n.already).toBeGreaterThan(20);
    expect(n.ride).toBeGreaterThan(20);
    expect(n.none).toBeGreaterThan(5000);
  }, SLOW);

  it("at 95% the same reading is v8's entry on the other side (the pane and the window are _shared/macd-level.ts's)", () => {
    let entries = 0;
    for (const w of WALKS.slice(0, 4)) {
      const bars = w.closes.map((close) => ({ close }));
      for (let i = W - 1; i < w.bars.length; i++) {
        const r = macd(w.closes.slice(i - (W - 1), i + 1));
        const a = zoneAt(r, W - 1) as RideZone;
        const b = zoneAt(r, W - 2) as RideZone;
        let mine: RideSide | null = null;
        if (atShare(a, "top", 0.95) && !atShare(b, "top", 0.95)) mine = "SELL";
        if (atShare(a, "bottom", 0.95) && !atShare(b, "bottom", 0.95)) mine = "BUY";
        expect(mine).toBe(decideZoneOnWindow(bars, i)?.side ?? null);
        if (mine) entries++;
      }
    }
    expect(entries).toBeGreaterThan(20);
  }, SLOW);

  it("an entry holds Z and Zp, the share at the entry is at least 90%, and already is 96% or more", () => {
    for (const w of WALKS) {
      for (let i = W - 1; i < w.bars.length; i++) {
        const e = rideEntryAt(w.closes.slice(i - (W - 1), i + 1));
        if (e === null) continue;
        expect(e.side).toBe(rideSideOf(e.zside));
        expect(atShare(e.z, e.zside, RIDE_IN_SHARE)).toBe(true);
        expect(atShare(e.zp, e.zside, RIDE_IN_SHARE)).toBe(false);
        expect(e.already).toBe(atShare(e.z, e.zside, RIDE_OUT_SHARE));
        expect(shareOf(e.z, e.zside)).toBeGreaterThanOrEqual(0.9 - 1e-12);
        // Z is the line of the bar's own state with its own close (the study's Z(i))
        expect(rideLineAt(w.state[i] as RideState, w.closes[i])).toEqual(e.z);
      }
    }
  }, SLOW);
});

// ---- 3. the catch-up --------------------------------------------------------------------------

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
// the spec's bound on an older bar (section 5 A.3): the later seed moves the line and the pane's edges by under 1e-12 of the price
const within = (a: RideZone, b: RideZone, price: number) =>
  Math.abs(a.m - b.m) <= 1e-12 * price && Math.abs(a.top - b.top) <= 1e-12 * price && Math.abs(a.bottom - b.bottom) <= 1e-12 * price;

describe("#397 the catch-up of the pairs and gold (the closed bars' highs and lows)", () => {
  it("the newest closed bar: rideTouch on the state of the 599 closes before it, bit for bit (600 or 601 bars in hand)", () => {
    const seen = { top: 0, bottom: 0, none: 0 };
    for (const w of WALKS) {
      for (let i = W; i < w.bars.length; i++) {
        const in600 = w.bars.slice(i - (W - 1), i + 1);
        const in601 = w.bars.slice(i - W, i + 1);
        const b = w.bars[i];
        for (const zs of SIDES) {
          // the ride was entered at the bar before: only the newest bar is after it. w.state[i] is rideStateOf of
          // the 599 closes before bar i (walkOf)
          const want = rideTouch(w.state[i] as RideState, zs, b.high, b.low);
          const got = rideCatchUp(in600, zs, w.bars[i - 1].t);
          if (want === null) {
            expect(got).toBeNull();
            if (i % 10 === 0) expect(rideCatchUp(in601, zs, w.bars[i - 1].t)).toBeNull();
            seen.none++;
            continue;
          }
          const got601 = rideCatchUp(in601, zs, w.bars[i - 1].t);
          expect(got).not.toBeNull();
          const g = got as NonNullable<typeof got>;
          expect(g.m).toBe(want.m);
          expect(g.top).toBe(want.top);
          expect(g.bottom).toBe(want.bottom);
          expect(g.share).toBe(want.share);
          expect(g.bar).toBe(b.t);
          expect(g.index).toBe(W - 1);
          expect(g.newest).toBe(true);
          expect(g.x).toBe(zs === "top" ? b.high : b.low);
          expect(got601).toEqual({ ...g, index: W });
          seen[zs]++;
        }
      }
    }
    expect(seen.top).toBeGreaterThan(100);
    expect(seen.bottom).toBeGreaterThan(100);
    expect(seen.none).toBeGreaterThan(1000);
  }, SLOW);

  it("older bars: the first touched bar after the entry bar, within 1e-9 of each bar's own 600-window state", () => {
    const seen = { caught: 0, older: 0, none: 0 };
    for (const w of WALKS) {
      for (let i = W - 1 + RIDE_CATCHUP_BARS; i < w.bars.length; i += 7) {
        const hand = w.bars.slice(i - (W - 1), i + 1);
        for (const back of [1, 2, 5, 37, 99, 100]) {
          const e = i - back;
          for (const zs of SIDES) {
            // each bar after the entry bar on its own window (the study's state of the bar)
            let want: { j: number; touch: NonNullable<ReturnType<typeof rideTouch>> } | null = null;
            for (let j = e + 1; j <= i && want === null; j++) {
              const touch = rideTouch(w.state[j] as RideState, zs, w.bars[j].high, w.bars[j].low);
              if (touch !== null) want = { j, touch };
            }
            const got = rideCatchUp(hand, zs, w.bars[e].t);
            if (want === null) {
              expect(got).toBeNull();
              seen.none++;
              continue;
            }
            expect(got).not.toBeNull();
            const g = got as NonNullable<typeof got>;
            expect(g.bar).toBe(w.bars[want.j].t);
            expect(g.index).toBe(want.j - (i - (W - 1)));
            expect(g.newest).toBe(want.j === i);
            expect(g.x).toBe(zs === "top" ? w.bars[want.j].high : w.bars[want.j].low);
            expect(near(g.m, want.touch.m)).toBe(true);
            expect(near(g.top, want.touch.top)).toBe(true);
            expect(near(g.bottom, want.touch.bottom)).toBe(true);
            expect(near(g.share, want.touch.share)).toBe(true);
            expect(within(g, want.touch, g.x)).toBe(true);
            seen.caught++;
            if (want.j !== i) seen.older++;
          }
        }
      }
    }
    expect(seen.caught).toBeGreaterThan(500);
    expect(seen.older).toBeGreaterThan(500);
    expect(seen.none).toBeGreaterThan(500);
  }, SLOW);

  it("only bars after the entry bar, only the newest `limit` bars, only bars with 479 before them in hand", () => {
    const w = WALKS[0];
    let checked = 0;
    for (let i = W - 1 + RIDE_CATCHUP_BARS; i < w.bars.length && checked < 40; i += 3) {
      const hand = w.bars.slice(i - (W - 1), i + 1);
      for (const zs of SIDES) {
        const first = rideCatchUp(hand, zs, hand[W - 1 - RIDE_CATCHUP_BARS].t);
        if (first === null || first.newest) continue;
        checked++;
        const p = first.index;
        expect(p).toBeGreaterThanOrEqual(W - RIDE_CATCHUP_BARS);
        // a ride entered at that bar is not reached in it: followed from the next bar
        const after = rideCatchUp(hand, zs, first.bar);
        expect(after === null || after.index > p).toBe(true);
        // an entry bar older than every bar in hand: still only the newest 100 are read
        expect(rideCatchUp(hand, zs, hand[0].t - 500 * HOUR)).toEqual(first);
        expect(rideCatchUp(hand, zs, -Infinity)).toEqual(first);
        // the entry bar the newest in hand, or a time that is no number: nothing to read
        expect(rideCatchUp(hand, zs, hand[W - 1].t)).toBeNull();
        expect(rideCatchUp(hand, zs, NaN)).toBeNull();
        // the limit: the bar is read when it is among the newest `limit`, not when it has left them
        expect(rideCatchUp(hand, zs, hand[0].t, W - p)).toEqual(first);
        const left = rideCatchUp(hand, zs, hand[0].t, W - 1 - p);
        expect(left === null || left.index > p).toBe(true);
        for (const bad of [0, -1, 1.5, NaN, Infinity]) expect(rideCatchUp(hand, zs, hand[0].t, bad)).toBeNull();
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);

    // fewer bars in hand: the newest is read with 479 bars before it (within 1e-9 of its own window), not with 478
    let short = 0;
    for (const v of WALKS) {
      for (let i = W - 1; i < v.bars.length; i++) {
        for (const zs of SIDES) {
          const b = v.bars[i];
          const want = rideTouch(v.state[i] as RideState, zs, b.high, b.low);
          // far enough inside 96% that the later seed cannot decide it
          if (want === null || want.share < 0.961) continue;
          const got = rideCatchUp(v.bars.slice(i - RIDE_CATCHUP_MIN_BEFORE, i + 1), zs, v.bars[i - 1].t);
          expect(got).not.toBeNull();
          expect((got as { index: number }).index).toBe(RIDE_CATCHUP_MIN_BEFORE);
          expect(near((got as { m: number }).m, want.m)).toBe(true);
          expect(near((got as { share: number }).share, want.share)).toBe(true);
          expect(within(got as RideZone, want, b.close)).toBe(true);
          expect(rideCatchUp(v.bars.slice(i - RIDE_CATCHUP_MIN_BEFORE + 1, i + 1), zs, v.bars[i - 1].t)).toBeNull();
          short++;
        }
      }
    }
    expect(short).toBeGreaterThan(100);
    expect(rideCatchUp([], "top", 0)).toBeNull();
  }, SLOW);

  it("a close in hand that is no number: nothing is judged", () => {
    const w = WALKS[3];
    let done = 0;
    for (let i = W - 1 + 100; i < w.bars.length && done < 5; i++) {
      const hand = w.bars.slice(i - (W - 1), i + 1);
      for (const zs of SIDES) {
        const caught = rideCatchUp(hand, zs, hand[W - 2].t);
        if (caught === null) continue;
        done++;
        for (const at of [0, 250, W - 1]) {
          const broken = hand.map((b, k) => (k === at ? { ...b, close: NaN } : b));
          expect(rideCatchUp(broken, zs, hand[W - 2].t)).toBeNull();
        }
        // of more than 600 bars only the newest 600 are read: a broken close older than them blinds nothing
        const longer = w.bars.slice(i - (W - 1) - 100, i + 1).map((b, k) => (k === 50 ? { ...b, close: NaN } : b));
        expect(rideCatchUp(longer, zs, hand[W - 2].t)).toEqual({ ...caught, index: caught.index + 100 });
        // the touching price itself no number: no touch
        const blind = hand.map((b, k) => (k === W - 1 ? { ...b, high: NaN, low: NaN } : b));
        expect(rideCatchUp(blind, zs, hand[W - 2].t)).toBeNull();
      }
    }
    expect(done).toBeGreaterThanOrEqual(5);
  });
});

describe("#397 the catch-up of the shares (each closed bar's own Z)", () => {
  it("the first bar after the entry bar among the newest 100 whose Z is at 96% on the ride's side, exactly", () => {
    const seen = { caught: 0, older: 0, none: 0 };
    for (const w of [WALKS[4], WALKS[7]]) {
      // Z(j) from the spec's sentence: zoneAt at 599 of the 600 closes ending at j
      const Z = w.bars.map((_, j) => (j >= W - 1 ? (zoneAt(macd(w.closes.slice(j - (W - 1), j + 1)), 599) as RideZone) : null));
      const at96 = (j: number, zs: RideZoneSide) => {
        const z = Z[j] as RideZone;
        return zs === "top" ? z.top > 0 && z.m >= 0.96 * z.top : z.bottom < 0 && z.m <= 0.96 * z.bottom;
      };
      for (let i = W - 1 + RIDE_CATCHUP_BARS; i < w.bars.length; i += 11) {
        // a share's read brings more than 600 bars: all of them in hand
        const hand = w.bars.slice(0, i + 1).map((b) => ({ t: b.t, close: b.close }));
        for (const back of [1, 20, 100, 150]) {
          const e = i - back;
          for (const zs of SIDES) {
            let want: number | null = null;
            for (let j = Math.max(e + 1, i - (RIDE_CATCHUP_BARS - 1)); j <= i && want === null; j++) if (at96(j, zs)) want = j;
            const got = rideCatchUpByClose(hand, zs, w.bars[e].t);
            if (want === null) {
              expect(got).toBeNull();
              seen.none++;
              continue;
            }
            const z = Z[want] as RideZone;
            expect(got).toEqual({
              m: z.m,
              top: z.top,
              bottom: z.bottom,
              share: zs === "top" ? z.m / z.top : z.m / z.bottom,
              bar: w.bars[want].t,
              index: want,
              newest: want === i,
              x: w.closes[want],
            });
            seen.caught++;
            if (want !== i) seen.older++;
          }
        }
      }
    }
    expect(seen.caught).toBeGreaterThan(300);
    expect(seen.older).toBeGreaterThan(300);
    expect(seen.none).toBeGreaterThan(300);
  }, SLOW);

  it("a bar without 600 closed bars up to it has no Z and is not judged; the limit and the entry bar as the pairs'", () => {
    const w = WALKS[7];
    const closeBars = w.bars.map((b) => ({ t: b.t, close: b.close }));
    let done = 0;
    for (let i = W - 1; i < w.bars.length && done < 10; i++) {
      for (const zs of SIDES) {
        const z = rideZoneAt(w.closes.slice(i - (W - 1), i + 1)) as RideZone;
        if (!atShare(z, zs, RIDE_OUT_SHARE)) continue;
        done++;
        const hand = closeBars.slice(i - (W - 1), i + 1);
        const got = rideCatchUpByClose(hand, zs, hand[W - 2].t);
        expect(got).toEqual({ ...z, share: shareOf(z, zs), bar: w.bars[i].t, index: W - 1, newest: true, x: w.closes[i] });
        // 599 bars in hand: the newest has no window of its own
        expect(rideCatchUpByClose(hand.slice(1), zs, hand[W - 2].t)).toBeNull();
        // the ride's own entry bar is not read
        expect(rideCatchUpByClose(hand, zs, hand[W - 1].t)).toBeNull();
        expect(rideCatchUpByClose(hand, zs, NaN)).toBeNull();
        expect(rideCatchUpByClose(hand, zs, hand[W - 2].t, 1)).toEqual(got);
        for (const bad of [0, -3, 2.5, NaN]) expect(rideCatchUpByClose(hand, zs, hand[W - 2].t, bad)).toBeNull();
        // a close in its window that is no number: that bar has no Z
        const broken = hand.map((b, k) => (k === 10 ? { ...b, close: NaN } : b));
        expect(rideCatchUpByClose(broken, zs, hand[W - 2].t)).toBeNull();
      }
    }
    expect(done).toBeGreaterThanOrEqual(10);
    expect(rideCatchUpByClose([], "top", 0)).toBeNull();
  });
});

// ---- 4. what a bar's close does ---------------------------------------------------------------

const B = Date.UTC(2026, 10, 12, 3);
const zone: RideZone = { m: 0.05, top: 0.05, bottom: -0.02 };
const entryOf = (side: RideSide, already: boolean): RideEntry => ({ zside: rideZoneSideOf(side), side, already, z: zone, zp: zone });
const open = (side: RideSide, entryBar: number): RideRow => ({ side, entryBar, status: "open", reachedBar: null });
const reached = (side: RideSide, entryBar: number, reachedBar: number | null): RideRow => ({ side, entryBar, status: "reached", reachedBar });

describe("#397 what a bar's close does (rideCloseStep)", () => {
  const cases: Array<{ name: string; entry: RideEntry | null; rows: RideRow[]; step: RideStep | null; by?: number; own?: number }> = [
    { name: "no entry, no ride", entry: null, rows: [], step: null },
    { name: "no entry, rides open on both sides", entry: null, rows: [open("BUY", B - 5 * HOUR), open("SELL", B - 2 * HOUR)], step: null },
    { name: "an entry, no ride: in", entry: entryOf("BUY", false), rows: [], step: "in" },
    { name: "a SELL entry, no ride: in", entry: entryOf("SELL", false), rows: [], step: "in" },
    { name: "already at 96%, no ride: the notice", entry: entryOf("BUY", true), rows: [], step: "at" },
    { name: "already at 96% on the bottom, no ride: the notice", entry: entryOf("SELL", true), rows: [], step: "at" },
    // skipped entries
    { name: "another ride of the side open: skip", entry: entryOf("BUY", false), rows: [open("BUY", B - 5 * HOUR)], step: "skip", by: 0 },
    { name: "another ride of the side open since the bar before: skip", entry: entryOf("SELL", false), rows: [open("SELL", B - HOUR)], step: "skip", by: 0 },
    { name: "another ride of the side reached in the next bar: skip", entry: entryOf("BUY", false), rows: [reached("BUY", B - 5 * HOUR, B + HOUR)], step: "skip", by: 0 },
    { name: "another ride of the side reached days later: skip", entry: entryOf("SELL", false), rows: [reached("SELL", B - 30 * HOUR, B + 70 * HOUR)], step: "skip", by: 0 },
    {
      name: "a ride held for weeks (its entry bar long out of the newest 100) reached a minute after this close: skip",
      entry: entryOf("BUY", false),
      rows: [reached("BUY", B - 700 * HOUR, B + HOUR)],
      step: "skip",
      by: 0,
    },
    // (what the rows must hold: without that ride the same close would be an entry)
    { name: "the same close on rows that left that ride out: in — the read must bring every ride reached in this bar or later", entry: entryOf("BUY", false), rows: [], step: "in" },
    // not skipped
    { name: "another ride of the side reached in this very bar: in", entry: entryOf("BUY", false), rows: [reached("BUY", B - 5 * HOUR, B)], step: "in" },
    { name: "another ride of the side reached in the bar before: in", entry: entryOf("BUY", false), rows: [reached("BUY", B - 5 * HOUR, B - HOUR)], step: "in" },
    { name: "another ride of the side reached long ago: in", entry: entryOf("SELL", false), rows: [reached("SELL", B - 90 * HOUR, B - 89 * HOUR)], step: "in" },
    { name: "a ride of the other side open: in", entry: entryOf("BUY", false), rows: [open("SELL", B - 5 * HOUR)], step: "in" },
    { name: "a ride of the other side reached in a later bar: in", entry: entryOf("SELL", false), rows: [reached("BUY", B - 5 * HOUR, B + HOUR)], step: "in" },
    { name: "a reached ride without its bar: held to be over, in", entry: entryOf("BUY", false), rows: [reached("BUY", B - 5 * HOUR, null)], step: "in" },
    // the notice, and when it is quiet
    { name: "already, and a ride of the side reached in this very bar: quiet", entry: entryOf("BUY", true), rows: [reached("BUY", B - 5 * HOUR, B)], step: "quiet", by: 0 },
    { name: "already on the bottom, and a SELL ride reached in this very bar: quiet", entry: entryOf("SELL", true), rows: [reached("SELL", B - HOUR, B)], step: "quiet", by: 0 },
    { name: "already, and a ride held for weeks reached in this very bar: quiet", entry: entryOf("SELL", true), rows: [reached("SELL", B - 700 * HOUR, B)], step: "quiet", by: 0 },
    { name: "already, and a ride of the OTHER side reached in this very bar: the notice", entry: entryOf("BUY", true), rows: [reached("SELL", B - 5 * HOUR, B)], step: "at" },
    { name: "already, and a ride of the side reached in the bar before: the notice", entry: entryOf("BUY", true), rows: [reached("BUY", B - 5 * HOUR, B - HOUR)], step: "at" },
    { name: "already, and a ride of the side reached in a later bar: the notice", entry: entryOf("BUY", true), rows: [reached("BUY", B - 5 * HOUR, B + HOUR)], step: "at" },
    { name: "already, and a ride of the side still open: the notice", entry: entryOf("BUY", true), rows: [open("BUY", B - 5 * HOUR)], step: "at" },
    { name: "already, and a reached ride without its bar: the notice", entry: entryOf("BUY", true), rows: [reached("BUY", B - 5 * HOUR, null)], step: "at" },
    // the same bar judged again
    { name: "again, the bar's own ride open: in", entry: entryOf("BUY", false), rows: [open("BUY", B)], step: "in", own: 0 },
    { name: "again, the bar's own ride reached in the next bar: in", entry: entryOf("BUY", false), rows: [reached("BUY", B, B + HOUR)], step: "in", own: 0 },
    { name: "again, the bar's own ride reached days later: in", entry: entryOf("SELL", false), rows: [reached("SELL", B, B + 50 * HOUR)], step: "in", own: 0 },
    {
      name: "again, the bar's own ride there and the older one reached in this bar: in",
      entry: entryOf("BUY", false),
      rows: [reached("BUY", B - 5 * HOUR, B), open("BUY", B)],
      step: "in",
      own: 1,
    },
    {
      name: "again, after the older ride of the side was reached in a later bar: still skip",
      entry: entryOf("BUY", false),
      rows: [reached("BUY", B - 5 * HOUR, B + 2 * HOUR), open("SELL", B - HOUR)],
      step: "skip",
      by: 0,
    },
    { name: "the bar's own row of the other side changes nothing: in", entry: entryOf("BUY", false), rows: [open("SELL", B)], step: "in" },
    { name: "a ride entered at a later bar does not skip an older bar", entry: entryOf("BUY", false), rows: [open("BUY", B + HOUR)], step: "in" },
    // both sides at once
    {
      name: "rides of both sides, the side's own reached earlier, the other open: in",
      entry: entryOf("SELL", false),
      rows: [open("BUY", B - 9 * HOUR), reached("SELL", B - 7 * HOUR, B - 6 * HOUR)],
      step: "in",
    },
    {
      name: "many rows, an old open ride of the side among them: skip",
      entry: entryOf("SELL", false),
      rows: [reached("SELL", B - 80 * HOUR, B - 60 * HOUR), reached("BUY", B - 9 * HOUR, B), open("SELL", B - 7 * HOUR), open("BUY", B - HOUR)],
      step: "skip",
      by: 2,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const got = rideCloseStep(c.entry, B, c.rows);
      expect(got.step).toBe(c.step);
      expect(got.side).toBe(c.entry?.side ?? null);
      expect(got.zside).toBe(c.entry?.zside ?? null);
      expect(got.by).toBe(c.by === undefined ? null : c.rows[c.by]);
      expect(got.own).toBe(c.own === undefined ? null : c.rows[c.own]);
      // the rows' order is not read
      const back = rideCloseStep(c.entry, B, [...c.rows].reverse());
      expect(back.step).toBe(c.step);
      expect(back.by).toBe(got.by);
      expect(back.own).toBe(got.own);
    });
  }

  it("the skip is the study's: an entry whose close is before the held ride's moment out (T0 < T), not one at or after it", () => {
    // a ride reached in bar r ends at a moment T in (r, r + 1 hour]; the entry at bar i is at T0 = i + 1 hour
    for (let r = -3; r <= 3; r++) {
      const reachedBar = B + r * HOUR;
      for (const T of [reachedBar + 60_000, reachedBar + 30 * 60_000, reachedBar + HOUR]) {
        const skipped = B + HOUR < T;
        expect(rideCloseStep(entryOf("BUY", false), B, [reached("BUY", B - 10 * HOUR, reachedBar)]).step).toBe(skipped ? "skip" : "in");
      }
    }
  });

  it("the same closes judged again and again over one ride table: one ride an entry bar, the same step every time", () => {
    // a made-up chart's table, as the function keeps it (at most one open ride a side), and a made-up course:
    // bar 0 a BUY entry; bar 2 a BUY entry while it is held (skipped); the ride reached in bar 3; bar 3 closes as a
    // BUY entry again (taken: the older ride was reached in this very bar); that ride reached in bar 4, and bar 4
    // closes already at 96% (quiet); bar 6 closes already at 96% with nothing reached in it (the notice)
    const table: RideRow[] = [];
    const bar = (k: number) => B + k * HOUR;
    const judge = (k: number, entry: RideEntry | null): RideStep | null => {
      const s = rideCloseStep(entry, bar(k), table);
      // as the function: the row is inserted when it is not there (a duplicate is ignored)
      if (s.step === "in" && s.own === null) table.push(open(entry!.side, bar(k)));
      return s.step;
    };
    const reach = (entryBar: number, k: number) => {
      const row = table.find((r) => r.entryBar === entryBar && r.status === "open");
      expect(row).toBeDefined();
      (row as RideRow).status = "reached";
      (row as RideRow).reachedBar = bar(k);
    };
    const opens = () => table.filter((r) => r.status === "open").length;

    for (let again = 0; again < 3; again++) expect(judge(0, entryOf("BUY", false))).toBe("in");
    expect(table).toHaveLength(1);
    expect(judge(1, null)).toBeNull();
    for (let again = 0; again < 3; again++) expect(judge(2, entryOf("BUY", false))).toBe("skip");
    expect(table).toHaveLength(1);
    // a SELL entry meanwhile is its own ride
    for (let again = 0; again < 2; again++) expect(judge(2, entryOf("SELL", false))).toBe("in");
    expect(table).toHaveLength(2);
    // reached in bar 3: bar 2 judged again is still skipped, bar 0 judged again is still its own ride
    reach(bar(0), 3);
    expect(judge(2, entryOf("BUY", false))).toBe("skip");
    expect(judge(0, entryOf("BUY", false))).toBe("in");
    expect(table).toHaveLength(2);
    // bar 3 closes as a new entry on that side: taken, once
    for (let again = 0; again < 3; again++) expect(judge(3, entryOf("BUY", false))).toBe("in");
    expect(table).toHaveLength(3);
    expect(opens()).toBe(2);
    // that ride reached in bar 4 (a minute after its entry); bar 3 judged again opens nothing
    reach(bar(3), 4);
    for (let again = 0; again < 3; again++) expect(judge(3, entryOf("BUY", false))).toBe("in");
    expect(table).toHaveLength(3);
    // bar 4 closes already at 96% on that side: its email 2 said so, no notice
    for (let again = 0; again < 3; again++) expect(judge(4, entryOf("BUY", true))).toBe("quiet");
    // bar 6 closes already at 96%, nothing reached in it: the notice, and no ride of it
    for (let again = 0; again < 3; again++) expect(judge(6, entryOf("BUY", true))).toBe("at");
    expect(table).toHaveLength(3);
    expect(table.filter((r) => r.side === "BUY").map((r) => [r.entryBar, r.status, r.reachedBar])).toEqual([
      [bar(0), "reached", bar(3)],
      [bar(3), "reached", bar(4)],
    ]);
    // the SELL ride is still held: a new SELL entry is skipped, a BUY entry is not
    expect(judge(7, entryOf("SELL", false))).toBe("skip");
    expect(judge(7, entryOf("BUY", false))).toBe("in");
    expect(opens()).toBe(2);
    expect(new Set(table.filter((r) => r.status === "open").map((r) => r.side)).size).toBe(2);
  });

  it("driven bar by bar over walks with a ride table, the rides are the study's way C, every close judged three times", () => {
    const totals = { rides: 0, reached: 0, open: 0, skip: 0, at: 0, quiet: 0 };
    // bars without wicks too: fewer touches, longer rides, more entries while one is held
    const walks = [...WALKS.slice(0, 5), walkOf("150.123 seed 21, no wicks", 3000, 21, 150.123, 3, 0), walkOf("1.10234 seed 22, no wicks", 3000, 22, 1.10234, 5, 0)];
    for (const w of walks) {
      const n = w.bars.length;
      const entries = w.bars.map((_, i) => (i >= W - 1 ? rideEntryAt(w.closes.slice(i - (W - 1), i + 1)) : null));
      const touches = (j: number, zs: RideZoneSide) => rideTouch(w.state[j] as RideState, zs, w.bars[j].high, w.bars[j].low) !== null;

      // (1) research/macd90m-spec.md way C, each side apart, the entries in time order: an entry (not already) whose
      // moment T0 (its bar's close) is before the moment out T of the last one taken (or that one is open) is
      // skipped; a taken one is followed from the next bar to the first touch, with no other way out
      const want: Array<{ side: RideSide; entryBar: number; reachedBar: number | null }> = [];
      let wantSkipped = 0;
      let wantAlready = 0;
      for (const zs of SIDES) {
        let until = -Infinity;
        for (let i = W - 1; i < n; i++) {
          const e = entries[i];
          if (e === null || e.zside !== zs) continue;
          if (e.already) {
            wantAlready++;
            continue;
          }
          if (w.bars[i].t + HOUR < until) {
            wantSkipped++;
            continue;
          }
          let j = i + 1;
          while (j < n && !touches(j, zs)) j++;
          // the moment out is the end of a minute of bar j: any minute of it gives the same skips
          until = j < n ? w.bars[j].t + [60_000, 30 * 60_000, HOUR][j % 3] : Infinity;
          want.push({ side: rideSideOf(zs), entryBar: w.bars[i].t, reachedBar: j < n ? w.bars[j].t : null });
        }
      }

      // (2) as the function goes: bar by bar, the open rides' touches in the bar (a ride is followed from the bar
      // after its entry bar), then the bar's close on the table as it stands, three times over
      const table: RideRow[] = [];
      const first: Array<RideStep | null> = new Array(n).fill(null);
      for (let i = W - 1; i < n; i++) {
        const t = w.bars[i].t;
        for (const r of table) {
          if (r.status === "open" && r.entryBar < t && touches(i, rideZoneSideOf(r.side))) {
            r.status = "reached";
            r.reachedBar = t;
          }
        }
        for (let again = 0; again < 3; again++) {
          const s = rideCloseStep(entries[i], t, table);
          if (again === 0) {
            first[i] = s.step;
            if (s.step === "skip" || s.step === "at" || s.step === "quiet") totals[s.step]++;
            expect(s.own).toBeNull();
          } else {
            expect(s.step).toBe(first[i]);
            expect(s.own !== null).toBe(s.step === "in");
          }
          if (s.step === "in" && s.own === null) table.push({ side: s.side as RideSide, entryBar: t, status: "open", reachedBar: null });
        }
        // the table's own rule (the partial unique index): at most one open ride a side
        expect(table.filter((r) => r.status === "open" && r.side === "BUY").length).toBeLessThanOrEqual(1);
        expect(table.filter((r) => r.status === "open" && r.side === "SELL").length).toBeLessThanOrEqual(1);
      }
      const order = (a: { side: RideSide; entryBar: number }, b: { side: RideSide; entryBar: number }) => (a.side === b.side ? a.entryBar - b.entryBar : a.side < b.side ? -1 : 1);
      expect(table.map((r) => ({ side: r.side, entryBar: r.entryBar, reachedBar: r.reachedBar })).sort(order)).toEqual(want.sort(order));
      expect(first.filter((x) => x === "skip")).toHaveLength(wantSkipped);
      expect(first.filter((x) => x === "at" || x === "quiet")).toHaveLength(wantAlready);
      // (3) every close judged once more on the finished table (a fresh instance, hours later): the same step
      for (let i = W - 1; i < n; i++) expect(rideCloseStep(entries[i], w.bars[i].t, table).step).toBe(first[i]);
      totals.rides += table.length;
      totals.reached += table.filter((r) => r.status === "reached").length;
      totals.open += table.filter((r) => r.status === "open").length;
    }
    expect(totals.rides).toBeGreaterThan(50);
    expect(totals.reached).toBeGreaterThan(50);
    expect(totals.skip).toBeGreaterThan(0);
    expect(totals.at).toBeGreaterThan(20);
    expect(totals.quiet).toBeGreaterThan(0);
  }, SLOW);
});
