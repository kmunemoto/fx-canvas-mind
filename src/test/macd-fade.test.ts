// The MACD fade judged at closed bars (research/macdfade1h-prod-spec.md sections 2.1-2.2, 3.1, 3.7, 4.1 and 4.5, the
// record of v40 on 1-hour bars; v41 judges each pair on its own chart, research/macdfade15min-prod-spec.md 3.1, 3.7,
// 4.5 and 7.1): the shared code the function runs (supabase/functions/_shared/macd-fade.ts) and the measured paragraph
// (supabase/functions/_shared/macd-fade-measured.ts: one run of record per chart, the 15-minute run 44535888012 and the
// 1-hour run 44555599946).
//
//   1. the constants and the three rule ids (the two 'macdx' ids, one per chart, and the shares'; built from the
//      constants as 3.7 writes them; the app's FADE_ID of section 5 matches them, RIDE_ID does not)
//   2. on seeded random walks (prices of 3, 5, 2 and 1 decimals), at every bar with 600 closes up to it: Z and Zp
//      against zoneAt at 599 and 598 of the window rebuilt; Zp bit for bit against zoneAt(macd(the 599 closes before
//      n), 598); the entry at several shares against the rule written again here from 2.1-2.2; at v8's 0.95 the side
//      equal to macd-level.ts decideZoneOnWindow's; never both sides
//   3. equality at the share is in (a share that puts the line exactly on s * top or s * bottom)
//   4. null on 599 closes and on a non-finite close of the newest 600; only the newest 600 read
//   5. FADE_MEASURED, each chart's run against its own ledger copy, value by value (meta.tf, share 0.96, tp 10);
//      v43: FADE_MAILED_TF (the five pairs' emails on 5-minute bars, where no run is held) against the function's map
//      (MACDH_INTERVAL_OF); the module loads with the five pairs on 5 minutes
//   6. the measured paragraph per chart, ja and en, word for word: section 4.5's text (copied below and held against
//      the spec file) filled with the table's values, for every pair's mail on each chart and each chart's notes'
//      version; 〔mailedOn〕 (v43's sentence, in place of section 4.5's v41 one, which is held against the spec file
//      still), 〔chance〕, 〔baseWhat〕 and the per-pair chance sentence; the 〔open〕 = 0 and 〔tp〕 = 0 variants from
//      summaries made here; the refusals; 4.1's guards; v43's not-measured sentence of a pair's 5-minute mail
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { macd, MACD_DEFAULTS } from "../../supabase/functions/_shared/macd";
import { LEVEL_WINDOW, ZONE_BARS, ZONE_SHARE, decideZoneOnWindow, zoneAt } from "../../supabase/functions/_shared/macd-level";
import {
  closeEntryAt,
  closeZonesAt,
  FADE_PCT,
  FADE_SHARE,
  FADE_TAG,
  type FadeZone,
  type FadeZoneSide,
  fadeCloseEntryAt,
  fadeRuleId,
  fadeSideOf,
} from "../../supabase/functions/_shared/macd-fade";
import {
  FADE_MAILED_TF,
  FADE_MEASURED,
  FADE_MEASURED_NOTES,
  FADE_MEASURED_SOURCE,
  FADE_NOT_MEASURED_ON_MAILED_TF,
  FADE_TFS,
  type FadeMeasured,
  type FadeSummary,
  type FadeTf,
  fadeMeasuredFromSummary,
  fadeMeasuredLine,
  fadeMeasuredNotes,
} from "../../supabase/functions/_shared/macd-fade-measured";
import { MACDH_FADE_VERSION_OF, MACDH_INTERVAL_OF, MACDH_PAIRS, isMacdhChart, macdhRuleId } from "../../supabase/functions/signal-alerts/indicators";
import { STOCKMACD_FADE_VERSION_OF, STOCKMACD_INTERVALS, stockmacdChartOf, stockmacdRuleId } from "../../supabase/functions/signal-alerts/stocks";

const W = LEVEL_WINDOW;
const SIDES: FadeZoneSide[] = ["top", "bottom"];
// the loops over the walks take a few seconds: room for a slower machine
const SLOW = 120_000;

// the app's regexes: RIDE_ID as src/lib/signalAlerts.ts:48 has it, FADE_ID as research/macdfade1h-prod-spec.md
// section 5 proposed it (research/macdfade15min-prod-spec.md section 5: unchanged)
const RIDE_ID = /^(?:macdx|stockmacd)_.*_(?:touch|ride)(\d+)to(\d+)of120_(in|at|out)_/;
const FADE_ID = /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/;

// ---- seeded walks -------------------------------------------------------------------------------------------------

const rndOf = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

// closes of a seeded walk, rounded to `d` decimals as a chart draws them
const walk = (n: number, seed: number, start: number, d: number, step = 0.004): number[] => {
  const rnd = rndOf(seed);
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v *= 1 + (rnd() - 0.5) * step;
    out.push(Number(v.toFixed(d)));
  }
  return out;
};

// yen pairs (3 decimals), the others (5), gold (2), a Tokyo share (1)
const WALKS: Array<{ name: string; closes: number[] }> = [
  { name: "150.123 seed 1", closes: walk(1500, 1, 150.123, 3) },
  { name: "150.123 seed 2", closes: walk(1500, 2, 150.123, 3) },
  { name: "97.531 seed 3", closes: walk(1500, 3, 97.531, 3) },
  { name: "1.10234 seed 4", closes: walk(1500, 4, 1.10234, 5) },
  { name: "1.10234 seed 5", closes: walk(1500, 5, 1.10234, 5) },
  { name: "0.65432 seed 6", closes: walk(1500, 6, 0.65432, 5) },
  { name: "4123.45 seed 7", closes: walk(1500, 7, 4123.45, 2) },
  { name: "2876.5 seed 8", closes: walk(1500, 8, 2876.5, 1) },
];

// ---- the rule written again from the spec (2.1-2.2) ---------------------------------------------------------------

const zoneOf = (r: ReturnType<typeof zoneAt>): FadeZone | null => (r === null ? null : { m: r.m, top: r.top, bottom: r.bottom });
// "At share s, top: top > 0 && m >= s * top; bottom: bottom < 0 && m <= s * bottom (equality in, the product as it
// comes)"
const atS = (z: FadeZone, side: FadeZoneSide, s: number) => (side === "top" ? z.top > 0 && z.m >= s * z.top : z.bottom < 0 && z.m <= s * z.bottom);
// "w = the 600 closes ending at n, r = macd(w), Z(n) = zoneAt(r, 599), Zp(n) = zoneAt(r, 598)"
const zonesAgain = (closes: number[], n: number) => {
  const r = macd(closes.slice(n - 599, n + 1));
  const Z = zoneOf(zoneAt(r, 599));
  const Zp = zoneOf(zoneAt(r, 598));
  return Z === null || Zp === null ? null : { Z, Zp };
};
// "an entry on side S when Z(n) is at s on S and Zp(n) is not"
const sidesAgain = (Z: FadeZone, Zp: FadeZone, s: number) => SIDES.filter((side) => atS(Z, side, s) && !atS(Zp, side, s));
const sameBits = (a: FadeZone, b: FadeZone) => Object.is(a.m, b.m) && Object.is(a.top, b.top) && Object.is(a.bottom, b.bottom);

// ---- 1. the constants and the ids ---------------------------------------------------------------------------------

describe("the MACD fade's constants and rule ids (spec 3.1, 3.7)", () => {
  it("96% of the pane of the newest 120 bars on 600 closes, MACD 12/26/9", () => {
    expect(FADE_PCT).toBe(96);
    expect(FADE_SHARE).toBe(0.96);
    expect(FADE_SHARE).toBe(FADE_PCT / 100);
    expect(FADE_TAG).toBe("fade96of120");
    expect(LEVEL_WINDOW).toBe(600);
    expect(ZONE_BARS).toBe(120);
    expect(MACD_DEFAULTS).toEqual({ fast: 12, slow: 26, signal: 9 });
  });

  it("the fade side: the top a SELL, the bottom a BUY", () => {
    expect(fadeSideOf("top")).toBe("SELL");
    expect(fadeSideOf("bottom")).toBe("BUY");
  });

  it("the three ids built from the constants as 3.7 writes them (the version follows the chart), matching FADE_ID (pct 96) and not RIDE_ID", () => {
    // research/macdfade15min-prod-spec.md 3.7: fadeRuleId("macdx", "15min", 12) and fadeRuleId("macdx", "1h", 11)
    // through macdhRuleId, fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], 5) (v40's: 11 and 4 on "1h"); v43:
    // fadeRuleId("macdx", "5min", 13), the five pairs' (12 stays buildable for the rows up to v42; 11 is gold's); and the
    // shares' one version a chart: 5 on "15min" as before, 6 on "1h" (4063.T's), through stockmacdRuleId
    expect(MACDH_FADE_VERSION_OF).toEqual({ "5min": 13, "15min": 12, "1h": 11 });
    const five = fadeRuleId("macdx", "5min", 13);
    expect(five).toBe("macdx_12_26_9_w600_5min_fade96of120_in_v13");
    expect(macdhRuleId("5min")).toBe(five);
    expect(STOCKMACD_INTERVALS[0]).toBe("15min");
    expect(STOCKMACD_FADE_VERSION_OF).toEqual({ "15min": 5, "1h": 6 });
    const pairs = fadeRuleId("macdx", "15min", 12);
    const hour = fadeRuleId("macdx", "1h", 11);
    const shares = fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], STOCKMACD_FADE_VERSION_OF["15min"]);
    const shareHour = fadeRuleId("stockmacd", "1h", STOCKMACD_FADE_VERSION_OF["1h"]);
    expect(shareHour).toBe("stockmacd_12_26_9_w600_1h_fade96of120_in_v6");
    expect(pairs).toBe("macdx_12_26_9_w600_15min_fade96of120_in_v12");
    expect(hour).toBe("macdx_12_26_9_w600_1h_fade96of120_in_v11");
    expect(shares).toBe("stockmacd_12_26_9_w600_15min_fade96of120_in_v5");
    // the function's own ids are these
    expect(macdhRuleId("15min")).toBe(pairs);
    expect(macdhRuleId("1h")).toBe(hour);
    expect(() => macdhRuleId("4h")).toThrow(/no version/);
    expect(stockmacdRuleId("15min")).toBe(shares);
    expect(stockmacdRuleId("1h")).toBe(shareHour);
    expect(stockmacdRuleId(stockmacdChartOf("4063.T"))).toBe(shareHour);
    expect(stockmacdRuleId(stockmacdChartOf("7203.T"))).toBe(shares);
    expect(() => stockmacdRuleId("5min")).toThrow(/no version/);
    for (const id of [five, pairs, hour, shares, shareHour]) {
      const m = FADE_ID.exec(id);
      expect(m, id).not.toBeNull();
      expect(Number(m?.[1])).toBe(FADE_PCT);
      expect(RIDE_ID.test(id), id).toBe(false);
    }
    // the app's tab (ruleOfId: the prefix the id starts with)
    expect(five.startsWith("macdx_")).toBe(true);
    expect(pairs.startsWith("macdx_")).toBe(true);
    expect(hour.startsWith("macdx_")).toBe(true);
    expect(shares.startsWith("stockmacd_")).toBe(true);
    expect(shareHour.startsWith("stockmacd_")).toBe(true);
    // v9's and v10's ids are RIDE_ID's, not FADE_ID's; v8's 1-hour zone id is neither
    for (const old of ["macdx_12_26_9_w600_1h_ride90to96of120_in_v9", "macdx_12_26_9_w600_1h_touch90to95of120_in_v10", "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2"]) {
      expect(RIDE_ID.test(old)).toBe(true);
      expect(FADE_ID.test(old)).toBe(false);
    }
    for (const old of ["macdx_12_26_9_w600_1h_z95of120_v8", "stockmacd_12_26_9_w600_1h_z95of120_v1"]) {
      expect(FADE_ID.test(old)).toBe(false);
      expect(RIDE_ID.test(old)).toBe(false);
    }
    // 3.7: the charts that change (USD/JPY and AUD/USD's 15 minutes, the shares') get ids that differ from every
    // earlier id, the never-built ones and the two 1-hour fade ids v40 writes included; the 1-hour charts keep v40's
    // own id (the same rule on the same chart: a close judged by both versions collides under the claim key)
    for (const other of [
      "macdx_12_26_9_w600_1h_fade96tp10of120_in_v11",
      "macdx_12_26_9_w600_15min_fade96of120_in_v11",
      "stockmacd_12_26_9_w600_15min_fade96of120_in_v4",
      "macdx_12_26_9_w600_1h_fade96of120_in_v11",
      "stockmacd_12_26_9_w600_1h_fade96of120_in_v4",
    ]) {
      expect(pairs).not.toBe(other);
      expect(shares).not.toBe(other);
    }
    expect(hour).toBe("macdx_12_26_9_w600_1h_fade96of120_in_v11");
    // the never-built 15-minute v11 differs from v40's 1-hour v11 by the interval: no id names two rules
    expect("macdx_12_26_9_w600_15min_fade96of120_in_v11").not.toBe(hour);
    // v43: the five pairs' 5-minute id differs from every id written before it (v12 on 15 minutes, v11 on 1 hour, the
    // shares' v5 and v4, the never-built ones above, the 5-minute rule's of v23 and v24); gold keeps v40's v11 (its
    // chart and rule do not change)
    for (const other of [pairs, hour, shares, "macdx_12_26_9_w600_1h_fade96tp10of120_in_v11", "macdx_12_26_9_w600_15min_fade96of120_in_v11", "stockmacd_12_26_9_w600_15min_fade96of120_in_v4", "stockmacd_12_26_9_w600_1h_fade96of120_in_v4", "macdx_12_26_9_w600_n288_k4_2_v1"]) {
      expect(five).not.toBe(other);
    }
    // v43: 4063.T's 1-hour id differs from every share id written before it (v40's v4 on '1h' for every share, v41's v5
    // on '15min', the never-built 15-minute v4, the 95% rule's and the ride's) and from every pair's
    for (const other of [five, pairs, hour, shares, "stockmacd_12_26_9_w600_1h_fade96of120_in_v4", "stockmacd_12_26_9_w600_15min_fade96of120_in_v4", "stockmacd_12_26_9_w600_1h_z95of120_v1", "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2"]) {
      expect(shareHour).not.toBe(other);
    }
    expect(macdhRuleId(MACDH_INTERVAL_OF["XAU/USD"])).toBe(hour);
    for (const p of MACDH_PAIRS.filter((x) => x !== "XAU/USD")) expect(macdhRuleId(MACDH_INTERVAL_OF[p]), p).toBe(five);
  });

  it("the copies above are the app's RIDE_ID as written, and section 5's FADE_ID (the app's, once it has one)", () => {
    const app = readFileSync("src/lib/signalAlerts.ts", "utf8");
    expect(app).toContain(`const RIDE_ID = /${RIDE_ID.source}/;`);
    const spec = readFileSync("research/macdfade15min-prod-spec.md", "utf8");
    expect(spec).toContain(`/${FADE_ID.source}/`);
    const fade = /const FADE_ID\s*=\s*(\/.*\/);/.exec(app);
    if (fade) expect(fade[1]).toBe(`/${FADE_ID.source}/`);
  });

  it("research/macdfade15min-prod-spec.md 4.5: _shared/macd-fade-measured.ts imports nothing from signal-alerts/ (indicators.ts imports it, and it builds its notes at load: an import back would read indicators.ts's constants before they are set)", () => {
    const src = readFileSync("supabase/functions/_shared/macd-fade-measured.ts", "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    expect(imports).toEqual(["./pair-names.ts"]);
    expect(src).not.toMatch(/signal-alerts\//);
    expect(src).not.toMatch(/import\s*\(/);
  });
});

// ---- 2. the walks -------------------------------------------------------------------------------------------------

describe("closeEntryAt on seeded walks against the rule written again (spec 2.1-2.2)", () => {
  it(
    "Z and Zp at every bar; Zp bit for bit on the 599 closes before the bar; the entry at six shares; decideZoneOnWindow at 0.95; never both sides",
    () => {
      const SHARES = [FADE_SHARE, ZONE_SHARE, 0.9, 0.5, 0.1, 1];
      const c = { bars: 0, entries96: 0, top96: 0, bottom96: 0, entries95: 0, v8: 0, both: 0 };
      for (const wk of WALKS) {
        const closes = wk.closes;
        const bars = closes.map((close) => ({ close }));
        for (let n = W - 1; n < closes.length; n++) {
          c.bars++;
          const w = closes.slice(n - (W - 1), n + 1);
          // Z and Zp of the module against zoneAt on the window rebuilt
          const zs = closeZonesAt(w);
          const again = zonesAgain(closes, n);
          expect(zs === null, `${wk.name} bar ${n}`).toBe(again === null);
          if (zs === null || again === null) continue;
          expect(sameBits(zs.z, again.Z), `${wk.name} bar ${n}: Z`).toBe(true);
          expect(sameBits(zs.zp, again.Zp), `${wk.name} bar ${n}: Zp`).toBe(true);
          // Zp is the bar before read on its own 599 closes, bit for bit (the EMAs are causal)
          const before = zoneOf(zoneAt(macd(closes.slice(n - (W - 1), n)), W - 2));
          expect(before).not.toBeNull();
          expect(sameBits(zs.zp, before as FadeZone), `${wk.name} bar ${n}: Zp against the 599 closes before`).toBe(true);
          // the entry at each share against the rule again
          for (const s of SHARES) {
            const sides = sidesAgain(again.Z, again.Zp, s);
            if (sides.length > 1) c.both++;
            const e = closeEntryAt(w, s);
            expect(e?.zside ?? null, `${wk.name} bar ${n} share ${s}`).toBe(sides[0] ?? null);
            if (e) {
              expect(e.side).toBe(e.zside === "top" ? "SELL" : "BUY");
              expect(sameBits(e.z, again.Z) && sameBits(e.zp, again.Zp)).toBe(true);
              expect(Object.is(e.share0, e.zside === "top" ? again.Z.m / again.Z.top : again.Z.m / again.Z.bottom)).toBe(true);
            }
          }
          // the email's rule is closeEntryAt at FADE_SHARE
          const fade = fadeCloseEntryAt(w);
          expect(fade).toEqual(closeEntryAt(w, FADE_SHARE));
          if (fade) {
            c.entries96++;
            if (fade.zside === "top") c.top96++;
            else c.bottom96++;
          }
          // at v8's 0.95: decideZoneOnWindow's side (macd-level.ts, top SELL, bottom BUY), at every bar
          const v8 = decideZoneOnWindow(bars, n);
          const e95 = closeEntryAt(w, ZONE_SHARE);
          expect(e95?.side ?? null, `${wk.name} bar ${n}: decideZoneOnWindow`).toBe(v8?.side ?? null);
          if (e95) c.entries95++;
          if (v8) c.v8++;
        }
      }
      // every walk bar read; never both sides; the walks reach both sides at 96% often enough to mean something
      expect(c.bars).toBe(WALKS.length * (1500 - (W - 1)));
      expect(c.both).toBe(0);
      expect(c.top96).toBeGreaterThan(5);
      expect(c.bottom96).toBeGreaterThan(5);
      expect(c.entries95).toBe(c.v8);
      expect(c.entries95).toBeGreaterThan(10);
    },
    SLOW,
  );

  it(
    "equality at the share is in: a share that puts the line exactly on s * top (s * bottom) gives the entry, a share a little above does not",
    () => {
      const c = { top: 0, bottom: 0 };
      for (const wk of WALKS) {
        const closes = wk.closes;
        for (let n = W - 1; n < closes.length; n += 3) {
          const w = closes.slice(n - (W - 1), n + 1);
          const zs = closeZonesAt(w);
          if (zs === null) continue;
          const { z, zp } = zs;
          for (const side of SIDES) {
            const edge = side === "top" ? z.top : z.bottom;
            if (side === "top" ? !(edge > 0 && z.m > 0) : !(edge < 0 && z.m < 0)) continue;
            const s = z.m / edge;
            // only shares where the product comes back exactly to m (the line on the mark)
            if (!(s > 0 && s <= 1) || s * edge !== z.m) continue;
            const e = closeEntryAt(w, s);
            const zpAt = atS(zp, side, s);
            expect(e?.zside ?? null, `${wk.name} bar ${n} ${side} at s = m / edge`).toBe(zpAt ? null : side);
            if (!zpAt) c[side]++;
            const up = s * (1 + 4 * Number.EPSILON);
            if (up <= 1 && Math.abs(up * edge) > Math.abs(z.m)) expect(closeEntryAt(w, up)?.zside === side, `${wk.name} bar ${n} ${side} above`).toBe(false);
          }
        }
      }
      expect(c.top).toBeGreaterThan(5);
      expect(c.bottom).toBeGreaterThan(5);
    },
    SLOW,
  );
});

// ---- 4. null and the window ---------------------------------------------------------------------------------------

describe("closeEntryAt's window", () => {
  const closes = WALKS[0].closes;
  // a bar with an entry at 96%
  const n96 = (() => {
    for (let n = W - 1; n < closes.length; n++) if (fadeCloseEntryAt(closes.slice(n - (W - 1), n + 1))) return n;
    throw new Error("no entry on walk 0");
  })();
  const w = closes.slice(n96 - (W - 1), n96 + 1);

  it("null on 599 closes; the entry on the same bar's 600", () => {
    expect(w.length).toBe(600);
    expect(fadeCloseEntryAt(w)).not.toBeNull();
    expect(fadeCloseEntryAt(w.slice(1))).toBeNull();
    expect(closeZonesAt(w.slice(1))).toBeNull();
    for (const s of [FADE_SHARE, ZONE_SHARE, 0.1]) expect(closeEntryAt(w.slice(1), s)).toBeNull();
    expect(fadeCloseEntryAt([])).toBeNull();
  });

  it("null on a close of the newest 600 that is not a finite number (the newest, the oldest, one between)", () => {
    for (const k of [W - 1, 0, 300]) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const x = [...w];
        x[k] = bad;
        expect(fadeCloseEntryAt(x), `index ${k} ${bad}`).toBeNull();
        expect(closeZonesAt(x)).toBeNull();
      }
      const y: unknown[] = [...w];
      y[k] = null;
      expect(fadeCloseEntryAt(y as number[])).toBeNull();
    }
  });

  it("only the newest 600 closes are read: older closes (a NaN among them) change nothing", () => {
    for (const n of [n96, W - 1 + 100, closes.length - 1]) {
      const all = closes.slice(0, n + 1);
      const win = closes.slice(n - (W - 1), n + 1);
      expect(fadeCloseEntryAt(all)).toEqual(fadeCloseEntryAt(win));
      expect(closeZonesAt(all)).toEqual(closeZonesAt(win));
    }
    expect(fadeCloseEntryAt([Number.NaN, ...w])).toEqual(fadeCloseEntryAt(w));
  });

  it("a share outside (0, 1] is refused", () => {
    for (const s of [0, -0.5, 1.0000001, Number.NaN]) expect(() => closeEntryAt(w, s)).toThrow(RangeError);
  });
});

// ---- 5. FADE_MEASURED: each chart's run against its own ledger copy of the run's summary.json --------------------

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
// research/macdfade15min-prod-spec.md 4.5's table of the two runs of record (never mixed)
const LEDGERS: Record<FadeTf, { path: string; sha256: string; bytes: number; run: number; commit: string; replaces: number }> = {
  "15min": {
    path: "research/ledger/macdfade15-summary.json",
    sha256: "eacb7815d7779be716b24e559c0aea139e6455910abcf4b1ec59ab4d8c5eb188",
    bytes: 16817,
    run: 44535888012,
    commit: "9ca2054",
    replaces: 44077464383,
  },
  "1h": {
    path: "research/ledger/macdfade1h-whole-summary.json",
    sha256: "d59b64c6212e594f0b3b4a89bb1683a6a5f98652208cafb59f6420bb352c833b",
    bytes: 16648,
    run: 44555599946,
    commit: "e4b16c7",
    replaces: 44099401423,
  },
};
type Ledger = FadeSummary & { meta: { tf: string; loadFrom: string } };
const ledgerBytes = (tf: FadeTf) => readFileSync(LEDGERS[tf].path);
const ledgerOf = (tf: FadeTf): Ledger => JSON.parse(ledgerBytes(tf).toString("utf8")) as Ledger;

describe("FADE_MEASURED: one run of record per chart (research/macdfade15min-prod-spec.md 4.5)", () => {
  it("two runs, keyed by chart, 15min and 1h; the source of each as 4.5's table writes it", () => {
    expect([...FADE_TFS]).toEqual(["15min", "1h"]);
    expect(Object.keys(FADE_MEASURED).sort()).toEqual(["15min", "1h"]);
    expect(Object.keys(FADE_MEASURED_SOURCE).sort()).toEqual(["15min", "1h"]);
    expect(Object.keys(FADE_MEASURED_NOTES).sort()).toEqual(["15min", "1h"]);
    for (const tf of FADE_TFS) {
      const src = FADE_MEASURED_SOURCE[tf];
      expect(src.ledger).toBe(LEDGERS[tf].path);
      expect(src.summarySha256).toBe(LEDGERS[tf].sha256);
      expect(src.summaryBytes).toBe(LEDGERS[tf].bytes);
      expect(src.run).toBe(LEDGERS[tf].run);
      expect(src.commit).toBe(LEDGERS[tf].commit);
      expect(src.replaces).toBe(LEDGERS[tf].replaces);
    }
    // the 15-minute one also without its tf line (the form .github/workflows/macdfade15.yml holds the run to)
    expect(FADE_MEASURED_SOURCE["15min"].summarySha256WithoutTf).toBe("74a4a230a291d68a8e8169ea293a5428f46863ffc0ed86804522f4f509cc888b");
    // v40's run stays a record only: no chart reads it
    for (const tf of FADE_TFS) expect(FADE_MEASURED_SOURCE[tf].ledger).not.toBe("research/ledger/macdfade1h-summary.json");
  });

  for (const tf of ["15min", "1h"] as const) {
    describe(`the ${tf} run (${LEDGERS[tf].path})`, () => {
      it(`the ledger file is the run's summary.json (sha256 ${LEDGERS[tf].sha256.slice(0, 8)}…, ${LEDGERS[tf].bytes} bytes)`, () => {
        const b = ledgerBytes(tf);
        expect(createHash("sha256").update(b).digest("hex")).toBe(LEDGERS[tf].sha256);
        expect(b.length).toBe(LEDGERS[tf].bytes);
        if (tf === "15min") {
          const t = Buffer.from(',\n  "tf": "15min"', "utf8");
          const s = b.toString("latin1");
          const tt = t.toString("latin1");
          expect(s.split(tt).length - 1).toBe(1);
          const stripped = Buffer.from(s.replace(tt, ""), "latin1");
          expect(createHash("sha256").update(stripped).digest("hex")).toBe(FADE_MEASURED_SOURCE["15min"].summarySha256WithoutTf);
        }
      });

      it(`meta: tf ${tf}, share 0.96 (the function's FADE_SHARE), tp 10, the period`, () => {
        const ledger = ledgerOf(tf);
        const m = FADE_MEASURED[tf];
        expect(ledger.meta.tf).toBe(tf);
        expect(ledger.meta.share).toBe(0.96);
        expect(ledger.meta.share).toBe(FADE_SHARE);
        expect(ledger.meta.tp).toBe(10);
        expect(m.tf).toBe(ledger.meta.tf);
        expect(m.share).toBe(ledger.meta.share);
        expect(m.tp).toBe(ledger.meta.tp);
        expect(m.from).toBe(ledger.meta.start);
        expect(m.to).toBe(ledger.meta.end);
        expect(m.from).toBe("2024-01-01T00:00:00Z");
        expect(m.to).toBe("2026-11-10T21:00:00Z");
      });

      it("every value equals the file's, unrounded", () => {
        const ledger = ledgerOf(tf);
        const m = FADE_MEASURED[tf];
        const f = ledger.dirs.fade.all;
        const keys = ["trades", "tp", "open", "pipsMean", "maeMedian", "maeMax", "tpMinutesMedian", "tpMinutesP90", "tpMinutesMax", "openPipsSum", "openPipsWorst", "openMinutesMax"] as const;
        for (const k of keys) expect(m.fade[k], `dirs.fade.all.${k}`).toBe(f[k]);
        expect(Object.keys(m.fade).sort()).toEqual([...keys].sort());
        expect(m.flowMean).toBe(ledger.dirs.flow.all.pipsMean);
        expect(m.baseMean).toBe(ledger.base.all.pipsMean);
        expect(ledger.pairs.map((p) => p.pair)).toEqual(PAIRS);
        expect(m.pairs.map((p) => p.pair)).toEqual(PAIRS);
        for (const [i, p] of m.pairs.entries()) {
          expect(p.mean, `dirs.fade["${p.pair}"].pipsMean`).toBe(ledger.dirs.fade[p.pair].pipsMean);
          expect(p.baseMean, `base["${p.pair}"].pipsMean`).toBe(ledger.base[p.pair].pipsMean);
          expect(p.notMailed, `pairs[${i}].notMailed`).toBe(ledger.pairs[i].notMailed);
        }
        expect(m.notMailed).toBe(ledger.pairs.reduce((x, p) => x + p.notMailed, 0));
        // the same through fadeMeasuredFromSummary (what the variants below are built with)
        expect(fadeMeasuredFromSummary(ledger, { sec: m.sec, chance: m.chance })).toEqual(m);
      });
    });
  }

  it("the values as section 4.5's table writes them, each chart's own", () => {
    const rows = (m: FadeMeasured) => m.pairs.map((p) => [p.pair, p.mean?.toFixed(2), p.baseMean?.toFixed(2), p.notMailed]);
    const q = FADE_MEASURED["15min"];
    expect([q.fade.trades, q.fade.tp, q.fade.open]).toEqual([6006, 5926, 80]);
    expect(q.fade.tp + q.fade.open).toBe(q.fade.trades);
    expect(q.fade.pipsMean?.toFixed(2)).toBe("2.41");
    expect([q.fade.maeMedian, q.fade.maeMax]).toEqual([11.9, 2975.8]);
    expect([q.fade.tpMinutesMedian, q.fade.tpMinutesP90, q.fade.tpMinutesMax]).toEqual([143, 5681, 784561]);
    expect([q.fade.openPipsSum?.toFixed(1), q.fade.openPipsWorst, q.fade.openMinutesMax]).toEqual(["-44784.5", -1913.4, 959205]);
    expect(q.flowMean?.toFixed(2)).toBe("3.19");
    expect(q.baseMean?.toFixed(2)).toBe("3.32");
    expect(rows(q)).toEqual([
      ["USD/JPY", "2.67", "5.69", 1],
      ["EUR/JPY", "1.29", "3.41", 0],
      ["AUD/JPY", "-0.82", "-0.30", 1],
      ["EUR/USD", "3.86", "2.60", 0],
      ["AUD/USD", "4.94", "5.18", 1],
    ]);
    expect(q.notMailed).toBe(3);
    expect(q.sec).toBe("8.156");
    const h = FADE_MEASURED["1h"];
    expect([h.fade.trades, h.fade.tp, h.fade.open]).toEqual([1490, 1468, 22]);
    expect(h.fade.tp + h.fade.open).toBe(h.fade.trades);
    expect(h.fade.pipsMean?.toFixed(2)).toBe("3.26");
    expect([h.fade.maeMedian, h.fade.maeMax]).toEqual([10.7, 2243.6]);
    expect([h.fade.tpMinutesMedian, h.fade.tpMinutesP90, h.fade.tpMinutesMax]).toEqual([140, 4489, 687037]);
    expect([h.fade.openPipsSum?.toFixed(1), h.fade.openPipsWorst, h.fade.openMinutesMax]).toEqual(["-9820.9", -1733.2, 888900]);
    expect(h.flowMean?.toFixed(2)).toBe("-2.08");
    // v40's run showed +3.20 (base 3.2016); the whole-file run's is +3.21
    expect(h.baseMean?.toFixed(2)).toBe("3.21");
    expect(rows(h)).toEqual([
      ["USD/JPY", "-0.26", "5.74", 2],
      ["EUR/JPY", "4.30", "3.28", 0],
      ["AUD/JPY", "4.44", "-0.75", 2],
      ["EUR/USD", "3.11", "2.61", 3],
      ["AUD/USD", "4.42", "5.16", 4],
    ]);
    expect(h.notMailed).toBe(11);
    // 〔sec〕: the release's section on both charts (§8.155 records v40's run, not this one)
    expect(h.sec).toBe("8.156");
  });

  it("〔chance〕's walks: the ranges and null.json's sha256 as research/macdfade15-spec.md records them; the gaps, unrounded, as 4.5's table gives them", () => {
    const study = readFileSync("research/macdfade15-spec.md", "utf8").replace(/\s+/g, " ");
    const u = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(2)}`;
    const gaps = (m: FadeMeasured) => ({
      fb: (m.fade.pipsMean as number) - (m.baseMean as number),
      ff: (m.fade.pipsMean as number) - (m.flowMean as number),
    });
    // 15 minutes (research/macdfade15-spec.md :477-478, :497-499): fade − base below its walks' range, fade − flow inside
    const q = FADE_MEASURED["15min"];
    const gq = gaps(q);
    expect(gq.fb).toBe(-0.906247088751817);
    expect(gq.ff).toBe(-0.7833999333999344);
    expect([u(gq.fb), u(gq.ff)]).toEqual(["−0.91", "−0.78"]);
    expect(q.chance.fadeMinusBase).toEqual({ lo: -0.8, hi: 2.24 });
    expect(q.chance.fadeMinusFlow).toEqual({ lo: -2.25, hi: 5.7 });
    expect(study).toContain(`fade − base ${u(gq.fb)} pips a trade (walks ${u(q.chance.fadeMinusBase.lo)}..${u(q.chance.fadeMinusBase.hi)}: below their range)`);
    expect(study).toContain(`fade − flow ${u(gq.ff)} pips a trade (walks ${u(q.chance.fadeMinusFlow.lo)}..${u(q.chance.fadeMinusFlow.hi)}: inside)`);
    // the study writes "null.json `…`" (no "sha256") in both new sections
    expect(study).toContain(`null.json \`${q.chance.nullSha256}\``);
    expect(q.chance.nullSha256).toBe("a0d390456ebc5ce5747bc88623dc756440165b55e19a2689c44041c7c1d6791e");
    expect(gq.fb).toBeLessThan(q.chance.fadeMinusBase.lo);
    // 1 hour (research/macdfade15-spec.md :536, :548-549): both inside; the study writes "fade − flow +5.34 (walks …"
    // with no "pips a trade" there
    const h = FADE_MEASURED["1h"];
    const gh = gaps(h);
    expect(gh.fb).toBe(0.05417607241652034);
    expect(gh.ff).toBe(5.342080536912752);
    expect([u(gh.fb), u(gh.ff)]).toEqual(["+0.05", "+5.34"]);
    expect(h.chance.fadeMinusBase).toEqual({ lo: -4.1, hi: 0.83 });
    expect(h.chance.fadeMinusFlow).toEqual({ lo: -5.42, hi: 5.81 });
    expect(study).toContain(`fade − base ${u(gh.fb)} pips a trade (walks ${u(h.chance.fadeMinusBase.lo)}..${u(h.chance.fadeMinusBase.hi)}: inside)`);
    expect(study).toContain(`fade − flow ${u(gh.ff)} (walks ${u(h.chance.fadeMinusFlow.lo)}..${u(h.chance.fadeMinusFlow.hi)}: inside)`);
    expect(study).toContain(`null.json \`${h.chance.nullSha256}\``);
    expect(h.chance.nullSha256).toBe("3d285440123d50ac776228092b1a2560db12ff1d114b97bbec676350175b9b96");
  });

  it("v43: FADE_MAILED_TF is the function's map (MACDH_INTERVAL_OF): all five pairs' emails are judged on 5-minute bars, where no run is held (none can be built); the runs of record stay the 15-minute and 1-hour ones, each holding the five pairs; gold on its 1-hour chart, measured on neither", () => {
    expect(FADE_MAILED_TF).toBe("5min");
    const five = MACDH_PAIRS.filter((p) => p !== "XAU/USD");
    expect([...five].sort()).toEqual([...PAIRS].sort());
    for (const p of five) {
      expect(MACDH_INTERVAL_OF[p], p).toBe(FADE_MAILED_TF);
      expect(isMacdhChart(p, FADE_MAILED_TF), p).toBe(true);
    }
    // no run is held on the mailed chart, and none can be built for it (nothing was measured on 5-minute bars)
    expect(FADE_TFS as readonly string[]).not.toContain(FADE_MAILED_TF);
    expect(Object.keys(FADE_MEASURED)).not.toContain(FADE_MAILED_TF);
    expect(Object.keys(FADE_MEASURED_NOTES)).not.toContain(FADE_MAILED_TF);
    for (const lang of ["ja", "en"] as const) {
      expect(() => fadeMeasuredNotes(lang, FADE_MAILED_TF)).toThrow(/no run is held for the chart "5min"/);
      for (const p of five) expect(() => fadeMeasuredLine(lang, p, FADE_MAILED_TF), p).toThrow(/no run is held for the chart "5min"/);
    }
    // the runs of record hold the five pairs (〔mailedOn〕 speaks of them as the five), and each still builds for every
    // pair (fadeMeasuredLine is no mail's from v43, but its form stays buildable)
    for (const tf of FADE_TFS) {
      expect(FADE_MEASURED[tf].pairs.map((x) => x.pair)).toEqual(PAIRS);
      for (const lang of ["ja", "en"] as const) for (const p of five) expect(() => fadeMeasuredLine(lang, p, tf)).not.toThrow();
    }
    // gold is mailed on its 1-hour chart, but measured on neither (no numbers in its mail)
    expect(MACDH_INTERVAL_OF["XAU/USD"]).toBe("1h");
    for (const tf of FADE_TFS) expect(FADE_MEASURED[tf].pairs.map((x) => x.pair)).not.toContain("XAU/USD");
  });

  it("v43: the module loads with the five pairs on 5 minutes (FADE_MEASURED_NOTES is built as it loads): both runs' notes, ja and en, each with v43's 〔mailedOn〕 and its own run's bar word", () => {
    expect(Object.keys(FADE_MEASURED_NOTES).sort()).toEqual(["15min", "1h"]);
    for (const tf of FADE_TFS) {
      for (const lang of ["ja", "en"] as const) {
        const t = FADE_MEASURED_NOTES[tf][lang];
        expect(t.length, `${tf} ${lang}`).toBeGreaterThan(1000);
        expect(t, `${tf} ${lang}`).toContain(MAILED_ON[tf][lang]);
        // v41's sentence is gone
        expect(t, `${tf} ${lang}`).not.toContain(MAILED_ON_V41[tf][lang]);
        expect(t, `${tf} ${lang}`).not.toMatch(/この5ペアのうち、メールを|Of these five pairs, the email is judged on/);
      }
    }
  });

  it("v43: a pair's 5-minute email's sentence in place of the measured paragraph: not measured on 5-minute bars, no number, the numbers measured on 15-minute and 1-hour bars in the app's notes and not 5-minute numbers", () => {
    expect(FADE_NOT_MEASURED_ON_MAILED_TF.ja).toBe("この決まりは、5分足ではまだ測っていません（数字はありません）。15分足と1時間足で測った数字は、アプリの設定の注にあります（5分足の数字ではありません）。");
    expect(FADE_NOT_MEASURED_ON_MAILED_TF.en).toBe("This rule has not been measured on 5-minute bars (there are no numbers for them). The numbers measured on 15-minute and 1-hour bars are in the app's settings notes (they are not 5-minute numbers).");
    for (const lang of ["ja", "en"] as const) {
      const t = FADE_NOT_MEASURED_ON_MAILED_TF[lang];
      // no measured number, no rate, no count
      expect(t, lang).not.toMatch(/\d\.\d|pips|%|回|勝率|win rate/i);
      // none of either run's paragraph is in it
      for (const tf of FADE_TFS) expect(FADE_MEASURED_NOTES[tf][lang].includes(t), `${lang} ${tf}`).toBe(false);
    }
  });
});

// ---- 6. the measured paragraph (spec 4.5), one per chart --------------------------------------------------------

type Lang = "ja" | "en";
// section 4.5's texts, word for word (copied from research/macdfade15min-prod-spec.md by a script, and held against
// the spec file below); 〔…〕 the slots
const SPEC_JA_15 =
  "測った数字（5ペア、〔from〕以後、〔to〕より前に確定した15分足、スプレッド込み、docs §〔sec〕）。〔mailedOn〕過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。このメールの決まりで足の終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていません）: 合図は〔trades〕回、うち〔tp〕回が+10 pips に届きました。〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕持ったままでした（その後は追っていません）。1回あたり平均〔mean〕 pips（届いていないものは、その時の含み損益で数えました）。途中の含み損は中央値〔maeMedian〕 pips、最大〔maeMax〕 pips。+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。足の終値で入るので指値ではなく、入らなかった注文はありません（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）。損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり〔flowMean〕 pips、合図なしで〔baseWhat〕入ると〔baseMean〕 pips でした（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく15分足の最初の1分に入ったもので、同じ入りではありません）。〔chance〕〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。平均がマイナスだったペア: 〔negPairs〕。ほかに〔notMailed〕回、週末の止まっている時間に確定した足に合図がありましたが、その足はどのペアのメールでも判定しないので、上の数字に入れていません。";
const SPEC_EN_15 =
  "Measured (five pairs, 15-minute bars that closed from 〔from〕 up to, not including, 〔to〕, spread paid, docs §〔sec〕). 〔mailedOn〕 The measurement re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured). Entered by this email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this email states no take-profit price): 〔trades〕 signals, of which 〔tp〕 reached +10 pips. 〔open〕 had not reached it by 〔to〕; their unrealised result was 〔openPipsSum〕 pips in all (a minus is a loss), the worst 〔openPipsWorst〕 pips, the longest held 〔openLongest〕 (not followed after that). The mean was 〔mean〕 pips a trade (those not reached counted at their unrealised result then). The largest loss on the way: median 〔maeMedian〕 pips, largest 〔maeMax〕 pips. Time to +10 pips: median 〔tpMedian〕, longer than 〔tpP90〕 one time in ten, longest 〔tpMax〕. The entry is at the bar's close, not a limit order, so no order went unfilled (every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe). With no stop, the share reaching +10 pips comes out high by construction. Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave 〔flowMean〕 pips a trade, and entering with no signal 〔baseWhat〕 gave 〔baseMean〕 pips (held the same way, +10 pips and no stop, but entered at the 15-minute bar's first minute, not at its close, so not the same entry). 〔chance〕 On 〔pair〕 alone the mean was 〔pairMean〕 pips (with no signal, 〔pairBaseMean〕 pips). Each pair's difference from no signal has not been shown to be larger than chance gives (chance alone puts a gap outside the range of ten made-up price walks with no trend about 2 times in 11). Pairs whose mean was below zero: 〔negPairs〕. Besides these, 〔notMailed〕 signals fell on bars that closed in the weekend pause; no pair's email judges those bars, so they are not in the numbers above.";
// 〔mailedOn〕 as section 4.5 wrote it for v41 (which pairs were mailed on which run's chart; held against the spec file
// below, as the record of v41 and v42's paragraphs)
const MAILED_ON_V41: Record<FadeTf, Record<Lang, string>> = {
  "15min": {
    ja: "この5ペアのうち、メールを15分足で判定するのはドル/円・豪ドル/ドルです。ユーロ/円・豪ドル/円・ユーロ/ドルのメールは1時間足で判定し、そのメールには1時間足で測った数字を載せています（この段落の数字は、どのペアの分も、すべて15分足で測ったものです）。",
    en: "Of these five pairs, the email is judged on 15-minute bars for USD/JPY and AUD/USD. The emails of EUR/JPY, AUD/JPY and EUR/USD are judged on 1-hour bars and carry the numbers measured on 1-hour bars (every number in this paragraph, for every pair, was measured on 15-minute bars).",
  },
  "1h": {
    ja: "この5ペアのうち、メールを1時間足で判定するのはユーロ/円・豪ドル/円・ユーロ/ドルです。ドル/円・豪ドル/ドルのメールは15分足で判定し、そのメールには15分足で測った数字を載せています（この段落の数字は、どのペアの分も、すべて1時間足で測ったものです）。",
    en: "Of these five pairs, the email is judged on 1-hour bars for EUR/JPY, AUD/JPY and EUR/USD. The emails of USD/JPY and AUD/USD are judged on 15-minute bars and carry the numbers measured on 15-minute bars (every number in this paragraph, for every pair, was measured on 1-hour bars).",
  },
};
// v43's 〔mailedOn〕 (the five pairs' emails judged on 5-minute bars, the owner's 2026-11-26 and 2026-11-27; no spec
// file holds it): all five pairs' emails are judged on 5-minute bars, and every number of the paragraph was measured on
// the run's own bars, not on 5-minute bars. It takes v41's place in every paragraph, the mail's form and the notes'
const MAILED_ON: Record<FadeTf, Record<Lang, string>> = {
  "15min": {
    ja: "この5ペアのメールは、今はすべて5分足で判定しています。この段落の数字は、どのペアの分も、すべて15分足で測ったもので、5分足で測ったものではありません。",
    en: "The emails of all five pairs are now judged on 5-minute bars. Every number in this paragraph, for every pair, was measured on 15-minute bars, not on 5-minute bars.",
  },
  "1h": {
    ja: "この5ペアのメールは、今はすべて5分足で判定しています。この段落の数字は、どのペアの分も、すべて1時間足で測ったもので、5分足で測ったものではありません。",
    en: "The emails of all five pairs are now judged on 5-minute bars. Every number in this paragraph, for every pair, was measured on 1-hour bars, not on 5-minute bars.",
  },
};
const CHANCE_BELOW_SPEC = {
  ja: "合図なしとの差（この決まり − 合図なし）は1回あたり〔gapBase〕 pips で、合図なしで入った時より低くありました。値動きに傾きのない作り物の値段10本で同じように測った差は〔baseLo〕〜〔baseHi〕 pips で、この差はその幅より下（合図なしより悪い側）でした。逆向きとの差は〔gapFlow〕 pips で、10本の幅（〔flowLo〕〜〔flowHi〕 pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。",
  en: "The difference from no signal (this rule less no signal) was 〔gapBase〕 pips a trade: lower than entering with no signal. The same difference measured on ten made-up price walks with no trend ranged from 〔baseLo〕 to 〔baseHi〕 pips, and this one was below that range (on the side of doing worse than no signal). The difference from the other way was 〔gapFlow〕 pips, within the walks' range (〔flowLo〕 to 〔flowHi〕 pips; a range chance alone gives, so it is not shown to do better or worse than the other way). Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's).",
};
const CHANCE_BELOW_FILLED = {
  ja: "合図なしとの差（この決まり − 合図なし）は1回あたり-0.91 pips で、合図なしで入った時より低くありました。値動きに傾きのない作り物の値段10本で同じように測った差は-0.80〜+2.24 pips で、この差はその幅より下（合図なしより悪い側）でした。逆向きとの差は-0.78 pips で、10本の幅（-2.25〜+5.70 pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。",
  en: "The difference from no signal (this rule less no signal) was -0.91 pips a trade: lower than entering with no signal. The same difference measured on ten made-up price walks with no trend ranged from -0.80 to +2.24 pips, and this one was below that range (on the side of doing worse than no signal). The difference from the other way was -0.78 pips, within the walks' range (-2.25 to +5.70 pips; a range chance alone gives, so it is not shown to do better or worse than the other way). Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's).",
};
const PAIR_CHANCE = {
  ja: "ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。",
  en: "Each pair's difference from no signal has not been shown to be larger than chance gives (chance alone puts a gap outside the range of ten made-up price walks with no trend about 2 times in 11).",
};
// the 1-hour run's texts: 4.5's substitutions on the 15-minute ones ("`1h`: the same two texts with …"), each found
// exactly once
const once = (t: string, from: string, to: string): string => {
  const n = t.split(from).length - 1;
  if (n !== 1) throw new Error(`"${from}" found ${n} times`);
  return t.replace(from, to);
};
const SPEC: Record<FadeTf, Record<Lang, string>> = {
  "15min": { ja: SPEC_JA_15, en: SPEC_EN_15 },
  "1h": {
    ja: once(once(SPEC_JA_15, "確定した15分足", "確定した1時間足"), "15分足の最初の1分", "1時間足の最初の1分"),
    en: once(once(SPEC_EN_15, "15-minute bars that closed", "1-hour bars that closed"), "the 15-minute bar's first minute", "the 1-hour bar's first minute"),
  },
};
// 〔baseWhat〕 from the chart (4.5; the same in the mail and the notes: it holds no 「このメール」 / "this email")
const BASE_WHAT: Record<FadeTf, Record<Lang, string>> = {
  "15min": {
    ja: "5ペアの15分足ごとの最初の1分に（週末の止まっている時間に確定した足を除く。買いと売りを1回ずつ）",
    en: "at the first minute of every 15-minute bar of the five pairs (bars that closed in the weekend pause left out; a BUY and a SELL)",
  },
  "1h": {
    ja: "5ペアの1時間足ごとの最初の1分に（週末の止まっている時間に確定した足を除く。買いと売りを1回ずつ）",
    en: "at the first minute of every 1-hour bar of the five pairs (bars that closed in the weekend pause left out; a BUY and a SELL)",
  },
};
// 〔chance〕 "both inside" (the 1-hour run's): research/macdfade1h-prod-spec.md 4.5, v40's, unchanged
const CHANCE_INSIDE = {
  ja: "合図なしとの差も、逆向きとの差も、値動きに傾きのない作り物の値段10本で同じように測った差の幅の中でした（偶然で出る幅の中なので、どちらより良いとも言えません。作り物の値段は GMO のものではなく、10本で分かるのは幅だけで、確かめ〈検定〉ではありません）。",
  en: "The differences from no signal and from the other way were both within the range of the same differences measured on ten made-up price walks with no trend (a range chance alone gives, so it is not shown to do better than either; the walks' prices are not GMO's, and ten walks give a range, not a test).",
};
const CHANCE: Record<FadeTf, Record<Lang, string>> = { "15min": CHANCE_BELOW_FILLED, "1h": CHANCE_INSIDE };
// the three phrases 4.5 rewrote for the per-pair form (held against the spec file below)
const ENTRY_PAREN = {
  ja: "（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）",
  en: "(every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe)",
};
const WEEKEND = { ja: "その足はどのペアのメールでも判定しないので、上の数字に入れていません。", en: "no pair's email judges those bars" };
const JA_PAIR: Record<string, string> = { "USD/JPY": "ドル/円", "EUR/JPY": "ユーロ/円", "AUD/JPY": "豪ドル/円", "EUR/USD": "ユーロ/ドル", "AUD/USD": "豪ドル/ドル" };

// the spec's text of a chart with section 4.5's changes: the notes' version (its listed changes only) and the
// 〔open〕 = 0 / 〔tp〕 = 0 variants (v40's, research/macdfade1h-prod-spec.md 4.5), each replacement found once
const specOf = (lang: Lang, tf: FadeTf, o: { notes: boolean; open0: boolean; tp0: boolean; pairs?: Array<[string, string, string]> }) => {
  let t = SPEC[tf][lang];
  if (lang === "ja") {
    if (o.open0) {
      t = once(t, "〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕持ったままでした（その後は追っていません）。", "〔to〕の時点でまだ届いていないものはありませんでした。");
      t = once(t, "（届いていないものは、その時の含み損益で数えました）", "");
    }
    if (o.tp0) t = once(t, "+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。", "+10 pips に届いたものはありませんでした。");
    if (o.notes) {
      t = once(t, "このメールの決まりで", "メールの決まりで");
      t = once(t, "〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。", `ペアごとの1回あたりの平均は、${(o.pairs ?? []).map(([p, m, b], i) => `${JA_PAIR[p]}${m} pips（${i === 0 ? "合図なしでは" : ""}${b} pips）`).join("・")}でした。`);
    }
  } else {
    if (o.open0) {
      t = once(t, "〔open〕 had not reached it by 〔to〕; their unrealised result was 〔openPipsSum〕 pips in all (a minus is a loss), the worst 〔openPipsWorst〕 pips, the longest held 〔openLongest〕 (not followed after that).", "None was still short of it by 〔to〕.");
      t = once(t, " (those not reached counted at their unrealised result then)", "");
    }
    if (o.tp0) t = once(t, "Time to +10 pips: median 〔tpMedian〕, longer than 〔tpP90〕 one time in ten, longest 〔tpMax〕.", "None reached +10 pips.");
    if (o.notes) {
      t = once(t, "times this email's reads failed", "times the email's reads failed");
      t = once(t, "Entered by this email's rule", "Entered by the email's rule");
      t = once(t, "this email states no take-profit price", "the email states no take-profit price");
      t = once(t, "On 〔pair〕 alone the mean was 〔pairMean〕 pips (with no signal, 〔pairBaseMean〕 pips).", `The mean a trade by pair: ${(o.pairs ?? []).map(([p, m, b], i) => `${p} ${m} pips (${i === 0 ? "with no signal, " : ""}${b} pips)`).join(", ")}.`);
    }
  }
  return t;
};
const fill = (t: string, slots: Record<string, string>) => {
  const out = t.replace(/〔([A-Za-z0-9]+)〕/g, (_, k: string) => {
    if (!(k in slots)) throw new Error(`no value for 〔${k}〕`);
    return slots[k];
  });
  expect(out).not.toContain("〔");
  return out;
};

// the real numbers' slots of each chart, written by hand from section 4.5's table (a minus as toFixed writes it)
const COMMON: Record<Lang, Record<string, string>> = {
  ja: { from: "2024年1月1日 0:00（UTC）", to: "2026年11月10日 21:00（UTC）", sec: "8.156" },
  en: { from: "1 January 2024, 00:00 UTC", to: "10 November 2026, 21:00 UTC", sec: "8.156" },
};
const REAL: Record<FadeTf, Record<Lang, Record<string, string>>> = {
  "15min": {
    ja: {
      ...COMMON.ja,
      trades: "6,006",
      tp: "5,926",
      open: "80",
      openPipsSum: "-44,784.5",
      openPipsWorst: "-1,913.4",
      openLongest: "約666日",
      mean: "+2.41",
      maeMedian: "11.9",
      maeMax: "2,975.8",
      tpMedian: "約2時間",
      tpP90: "約4日",
      tpMax: "約545日",
      flowMean: "+3.19",
      baseMean: "+3.32",
      negPairs: "豪ドル/円（-0.82 pips）",
      notMailed: "3",
    },
    en: {
      ...COMMON.en,
      trades: "6,006",
      tp: "5,926",
      open: "80",
      openPipsSum: "-44,784.5",
      openPipsWorst: "-1,913.4",
      openLongest: "about 666 days",
      mean: "+2.41",
      maeMedian: "11.9",
      maeMax: "2,975.8",
      tpMedian: "about 2 hours",
      tpP90: "about 4 days",
      tpMax: "about 545 days",
      flowMean: "+3.19",
      baseMean: "+3.32",
      negPairs: "AUD/JPY (-0.82 pips)",
      notMailed: "3",
    },
  },
  "1h": {
    ja: {
      ...COMMON.ja,
      trades: "1,490",
      tp: "1,468",
      open: "22",
      openPipsSum: "-9,820.9",
      openPipsWorst: "-1,733.2",
      openLongest: "約617日",
      mean: "+3.26",
      maeMedian: "10.7",
      maeMax: "2,243.6",
      tpMedian: "約2時間",
      tpP90: "約3日",
      tpMax: "約477日",
      flowMean: "-2.08",
      baseMean: "+3.21",
      negPairs: "ドル/円（-0.26 pips）",
      notMailed: "11",
    },
    en: {
      ...COMMON.en,
      trades: "1,490",
      tp: "1,468",
      open: "22",
      openPipsSum: "-9,820.9",
      openPipsWorst: "-1,733.2",
      openLongest: "about 617 days",
      mean: "+3.26",
      maeMedian: "10.7",
      maeMax: "2,243.6",
      tpMedian: "about 2 hours",
      tpP90: "about 3 days",
      tpMax: "about 477 days",
      flowMean: "-2.08",
      baseMean: "+3.21",
      negPairs: "USD/JPY (-0.26 pips)",
      notMailed: "11",
    },
  },
};
const REAL_PAIRS: Record<FadeTf, Array<[string, string, string]>> = {
  "15min": [
    ["USD/JPY", "+2.67", "+5.69"],
    ["EUR/JPY", "+1.29", "+3.41"],
    ["AUD/JPY", "-0.82", "-0.30"],
    ["EUR/USD", "+3.86", "+2.60"],
    ["AUD/USD", "+4.94", "+5.18"],
  ],
  "1h": [
    ["USD/JPY", "-0.26", "+5.74"],
    ["EUR/JPY", "+4.30", "+3.28"],
    ["AUD/JPY", "+4.44", "-0.75"],
    ["EUR/USD", "+3.11", "+2.61"],
    ["AUD/USD", "+4.42", "+5.16"],
  ],
};
// the chart's own slots: 〔mailedOn〕, 〔chance〕 and 〔baseWhat〕 with the table's numbers
const slotsOf = (tf: FadeTf, lang: Lang) => ({ ...REAL[tf][lang], mailedOn: MAILED_ON[tf][lang], chance: CHANCE[tf][lang], baseWhat: BASE_WHAT[tf][lang] });
const pairSlots = (lang: Lang, rows: Array<[string, string, string]>, pair: string) => {
  const r = rows.find((x) => x[0] === pair) as [string, string, string];
  return { pair: lang === "ja" ? JA_PAIR[pair] : pair, pairMean: r[1], pairBaseMean: r[2] };
};
const mailOf = (tf: FadeTf, lang: Lang, pair: string) => fill(specOf(lang, tf, { notes: false, open0: false, tp0: false }), { ...slotsOf(tf, lang), ...pairSlots(lang, REAL_PAIRS[tf], pair) });
const notesOf = (tf: FadeTf, lang: Lang) => fill(specOf(lang, tf, { notes: true, open0: false, tp0: false, pairs: REAL_PAIRS[tf] }), slotsOf(tf, lang));

// ---- summaries made here (research/macdfade15.ts summaryOf's form, the fields the paragraph reads) ----------------

type G = FadeSummary["base"][string];
const group = (g: Partial<G>): G => ({
  trades: 1,
  tp: 1,
  open: 0,
  pipsMean: 0,
  maeMedian: 0,
  maeMax: 0,
  tpMinutesMedian: 1,
  tpMinutesP90: 1,
  tpMinutesMax: 1,
  openPipsSum: null,
  openPipsWorst: null,
  openMinutesMax: null,
  ...g,
});
const summaryMade = (o: {
  tf: FadeTf;
  start: string;
  end: string;
  fade: Partial<G>;
  flowMean: number;
  baseMean: number;
  pairs: Array<[string, number, number, number]>;
}): FadeSummary => ({
  meta: { start: o.start, end: o.end, share: 0.96, tp: 10, tf: o.tf },
  pairs: o.pairs.map(([pair, , , notMailed]) => ({ pair, notMailed })),
  dirs: {
    fade: { all: group(o.fade), ...Object.fromEntries(o.pairs.map(([p, mean]) => [p, group({ pipsMean: mean })])) },
    flow: { all: group({ pipsMean: o.flowMean }) },
  },
  base: { all: group({ pipsMean: o.baseMean }), ...Object.fromEntries(o.pairs.map(([p, , baseMean]) => [p, group({ pipsMean: baseMean })])) },
});
const made = (s: FadeSummary, tf: FadeTf): FadeMeasured => fadeMeasuredFromSummary(s, { sec: "8.156", chance: FADE_MEASURED[tf].chance });

// 〔open〕 = 0 on the 1-hour chart: every trade reached +10; times exact and rounded; no pair below zero; both gaps
// inside the 1-hour walks' ranges
const OPEN0 = made(summaryMade({
  tf: "1h",
  start: "2024-02-05T09:05:00Z",
  end: "2025-12-31T23:59:00Z",
  fade: { trades: 12, tp: 12, open: 0, pipsMean: 10, maeMedian: 3.2, maeMax: 1234.5, tpMinutesMedian: 44.5, tpMinutesP90: 180, tpMinutesMax: 2880 },
  flowMean: 9.5,
  baseMean: 9.99,
  pairs: [["USD/JPY", 10, 9.5, 2], ["EUR/JPY", 10, 10.25, 0], ["AUD/JPY", 10, 9, 1], ["EUR/USD", 10, 12, 0], ["AUD/USD", 10, 0, 0]],
}), "1h");
const OPEN0_SLOTS: Record<Lang, Record<string, string>> = {
  ja: {
    from: "2024年2月5日 9:05（UTC）",
    to: "2025年12月31日 23:59（UTC）",
    sec: "8.156",
    trades: "12",
    tp: "12",
    mean: "+10.00",
    maeMedian: "3.2",
    maeMax: "1,234.5",
    tpMedian: "約45分",
    tpP90: "3時間",
    tpMax: "2日",
    flowMean: "+9.50",
    baseMean: "+9.99",
    mailedOn: MAILED_ON["1h"].ja,
    baseWhat: BASE_WHAT["1h"].ja,
    chance: CHANCE_INSIDE.ja,
    negPairs: "ありません",
    notMailed: "3",
  },
  en: {
    from: "5 February 2024, 09:05 UTC",
    to: "31 December 2025, 23:59 UTC",
    sec: "8.156",
    trades: "12",
    tp: "12",
    mean: "+10.00",
    maeMedian: "3.2",
    maeMax: "1,234.5",
    tpMedian: "about 45 minutes",
    tpP90: "3 hours",
    tpMax: "2 days",
    flowMean: "+9.50",
    baseMean: "+9.99",
    mailedOn: MAILED_ON["1h"].en,
    baseWhat: BASE_WHAT["1h"].en,
    chance: CHANCE_INSIDE.en,
    negPairs: "none",
    notMailed: "3",
  },
};
const OPEN0_PAIRS: Array<[string, string, string]> = [["USD/JPY", "+10.00", "+9.50"], ["EUR/JPY", "+10.00", "+10.25"], ["AUD/JPY", "+10.00", "+9.00"], ["EUR/USD", "+10.00", "+12.00"], ["AUD/USD", "+10.00", "+0.00"]];

// 〔tp〕 = 0 on the 15-minute chart: no trade reached +10, all still open; two pairs below zero; both gaps inside the
// 15-minute walks' ranges (so the "both inside" sentence, chosen by the numbers, not the chart)
const TP0 = made(summaryMade({
  tf: "15min",
  start: "2024-01-01T00:00:00Z",
  end: "2026-11-10T21:00:00Z",
  fade: { trades: 3, tp: 0, open: 3, pipsMean: -25.5, maeMedian: 30, maeMax: 45.6, tpMinutesMedian: null, tpMinutesP90: null, tpMinutesMax: null, openPipsSum: -76.5, openPipsWorst: -40.2, openMinutesMax: 119 },
  flowMean: -26,
  baseMean: -25,
  pairs: [["USD/JPY", -12.5, -1, 0], ["EUR/JPY", 0, 0, 0], ["AUD/JPY", 3, -2, 0], ["EUR/USD", 1.234, 2, 0], ["AUD/USD", -1, 5, 2]],
}), "15min");
const TP0_SLOTS: Record<Lang, Record<string, string>> = {
  ja: {
    from: "2024年1月1日 0:00（UTC）",
    to: "2026年11月10日 21:00（UTC）",
    sec: "8.156",
    trades: "3",
    tp: "0",
    open: "3",
    openPipsSum: "-76.5",
    openPipsWorst: "-40.2",
    openLongest: "119分",
    mean: "-25.50",
    maeMedian: "30.0",
    maeMax: "45.6",
    flowMean: "-26.00",
    baseMean: "-25.00",
    mailedOn: MAILED_ON["15min"].ja,
    baseWhat: BASE_WHAT["15min"].ja,
    chance: CHANCE_INSIDE.ja,
    negPairs: "ドル/円（-12.50 pips）・豪ドル/ドル（-1.00 pips）",
    notMailed: "2",
  },
  en: {
    from: "1 January 2024, 00:00 UTC",
    to: "10 November 2026, 21:00 UTC",
    sec: "8.156",
    trades: "3",
    tp: "0",
    open: "3",
    openPipsSum: "-76.5",
    openPipsWorst: "-40.2",
    openLongest: "119 minutes",
    mean: "-25.50",
    maeMedian: "30.0",
    maeMax: "45.6",
    flowMean: "-26.00",
    baseMean: "-25.00",
    mailedOn: MAILED_ON["15min"].en,
    baseWhat: BASE_WHAT["15min"].en,
    chance: CHANCE_INSIDE.en,
    negPairs: "USD/JPY (-12.50 pips), AUD/USD (-1.00 pips)",
    notMailed: "2",
  },
};
const TP0_PAIRS: Array<[string, string, string]> = [["USD/JPY", "-12.50", "-1.00"], ["EUR/JPY", "+0.00", "+0.00"], ["AUD/JPY", "+3.00", "-2.00"], ["EUR/USD", "+1.23", "+2.00"], ["AUD/USD", "-1.00", "+5.00"]];

// every text built here, for the guards: each pair's mail on each chart, each chart's notes, the variants
const ALL_TEXTS: Array<[string, string]> = [];
for (const lang of ["ja", "en"] as const) {
  for (const tf of FADE_TFS) {
    for (const p of PAIRS) ALL_TEXTS.push([`${lang} ${tf} ${p}`, fadeMeasuredLine(lang, p, tf)]);
    ALL_TEXTS.push([`${lang} ${tf} notes`, fadeMeasuredNotes(lang, tf)]);
  }
  for (const [name, m] of [["open0", OPEN0], ["tp0", TP0]] as const) {
    ALL_TEXTS.push([`${lang} ${name} USD/JPY`, fadeMeasuredLine(lang, "USD/JPY", m.tf, m)]);
    ALL_TEXTS.push([`${lang} ${name} notes`, fadeMeasuredNotes(lang, m.tf, m)]);
  }
}
const tfOfName = (name: string): FadeTf => (name.includes(" 15min ") || name.includes("tp0") ? "15min" : "1h");

describe("the measured paragraph (spec 4.5), one per chart, ja and en, word for word", () => {
  it("the texts above are section 4.5's, as research/macdfade15min-prod-spec.md writes them (its 15-minute text whole; the 1-hour one by its substitutions; 〔mailedOn〕, 〔baseWhat〕, 〔chance〕, the per-pair chance sentence and the three phrases rewritten)", () => {
    const lines = readFileSync("research/macdfade15min-prod-spec.md", "utf8").split("\n");
    const one = (head: string) => {
      const xs = lines.filter((l) => l.startsWith(head));
      expect(xs.length, head).toBe(1);
      return xs[0];
    };
    expect(one("ja, `15min`")).toContain(`: 「${SPEC_JA_15}」`);
    expect(one("en, `15min`")).toBe(`en, \`15min\`: "${SPEC_EN_15}"`);
    // "`1h`: the same two texts with 「確定した15分足」 → 「確定した1時間足」, 「15分足の最初の1分」 → 「1時間足の最初の1分」; ..."
    const flatJa = lines.map((l) => l.trim()).join("");
    const flatEn = lines.map((l) => l.trim()).join(" ");
    expect(flatEn).toContain("`1h`: the same two texts with 「確定した15分足」 → 「確定した1時間足」, 「15分足の最初の1分」 → 「1時間足の最初の1分」; \"15-minute bars that closed\" → \"1-hour bars that closed\", \"the 15-minute bar's first minute\" → \"the 1-hour bar's first minute\"; 〔mailedOn〕 its `1h` sentence.");
    // 〔mailedOn〕 as section 4.5 wrote it (v41's; v43's, MAILED_ON, is in no spec file: it is pinned word for word below)
    for (const tf of FADE_TFS) {
      expect(flatJa, `${tf} mailedOn ja`).toContain(`「${MAILED_ON_V41[tf].ja}」`);
      expect(flatEn, `${tf} mailedOn en`).toContain(`en "${MAILED_ON_V41[tf].en}"`);
      for (const lang of ["ja", "en"] as const) expect(lang === "ja" ? flatJa : flatEn, `${tf} v43 mailedOn ${lang}`).not.toContain(MAILED_ON[tf][lang]);
    }
    expect(flatJa).toContain(`\`15min\` 「${BASE_WHAT["15min"].ja}」`);
    expect(flatEn).toContain(`/ "${BASE_WHAT["15min"].en}"; \`1h\` the same with 「1時間足」 / "1-hour".`);
    for (const lang of ["ja", "en"] as const) expect(BASE_WHAT["1h"][lang]).toBe(BASE_WHAT["15min"][lang].replace(lang === "ja" ? "15分足" : "15-minute", lang === "ja" ? "1時間足" : "1-hour"));
    expect(one("The sentence, ja 「合図なしとの差")).toBe(`The sentence, ja 「${CHANCE_BELOW_SPEC.ja}」 en "${CHANCE_BELOW_SPEC.en}"`);
    expect(one("Filled with the 15-minute numbers, ja")).toBe(`Filled with the 15-minute numbers, ja 「${CHANCE_BELOW_FILLED.ja}」 en "${CHANCE_BELOW_FILLED.en}"`);
    expect(flatJa).toContain(`「${PAIR_CHANCE.ja}」`);
    expect(flatEn).toContain(`en "${PAIR_CHANCE.en}"`);
    expect(flatJa).toContain(`→ 「${ENTRY_PAREN.ja}」`);
    expect(flatEn).toContain(`"${ENTRY_PAREN.en}"`);
    expect(flatJa).toContain(`→ 「…${WEEKEND.ja}」`);
    expect(flatEn).toContain(`/ "${WEEKEND.en}"`);
    // the 15-minute text holds the three phrases, the per-pair chance sentence and en's new subject, each once
    for (const [t, parts] of [
      [SPEC_JA_15, [ENTRY_PAREN.ja, WEEKEND.ja, PAIR_CHANCE.ja, "〔mailedOn〕", "〔baseWhat〕", "〔chance〕〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。" + PAIR_CHANCE.ja]],
      [SPEC_EN_15, [ENTRY_PAREN.en, WEEKEND.en, PAIR_CHANCE.en, "〔mailedOn〕 The measurement re-reads GMO's past bars;", "〔baseWhat〕", `〔chance〕 On 〔pair〕 alone the mean was 〔pairMean〕 pips (with no signal, 〔pairBaseMean〕 pips). ${PAIR_CHANCE.en}`]],
    ] as const) {
      for (const p of parts) expect(t.split(p).length - 1, p).toBe(1);
    }
    // 〔chance〕 "both inside": research/macdfade1h-prod-spec.md 4.5's, kept as the 1-hour run's
    const v40 = readFileSync("research/macdfade1h-prod-spec.md", "utf8").split("\n");
    expect(v40.map((l) => l.trim()).join("")).toContain(`「${CHANCE_INSIDE.ja}」`);
    expect(v40.map((l) => l.trim()).join(" ")).toContain(`en "${CHANCE_INSIDE.en}"`);
    // the filled 〔chance〕 is the template with 4.5's table values
    expect(fill(CHANCE_BELOW_SPEC.ja, { gapBase: "-0.91", baseLo: "-0.80", baseHi: "+2.24", gapFlow: "-0.78", flowLo: "-2.25", flowHi: "+5.70" })).toBe(CHANCE_BELOW_FILLED.ja);
    expect(fill(CHANCE_BELOW_SPEC.en, { gapBase: "-0.91", baseLo: "-0.80", baseHi: "+2.24", gapFlow: "-0.78", flowLo: "-2.25", flowHi: "+5.70" })).toBe(CHANCE_BELOW_FILLED.en);
  });

  it("every pair's mail on each chart: section 4.5's text of that chart filled with that run's values", () => {
    for (const tf of FADE_TFS) {
      for (const lang of ["ja", "en"] as const) {
        for (const p of PAIRS) expect(fadeMeasuredLine(lang, p, tf), `${lang} ${tf} ${p}`).toBe(mailOf(tf, lang, p));
      }
    }
  });

  it("the paragraph's mail form (v41 and v42's mails; no mail carries it from v43) as the owner read it: USD/JPY's of the 15-minute run and EUR/JPY's of the 1-hour run, each its own pair's sentence and the per-pair chance sentence after it, v43's 〔mailedOn〕 after the first sentence", () => {
    const uj = fadeMeasuredLine("ja", "USD/JPY", "15min");
    expect(uj.startsWith("測った数字（5ペア、2024年1月1日 0:00（UTC）以後、2026年11月10日 21:00（UTC）より前に確定した15分足、スプレッド込み、docs §8.156）。この5ペアのメールは、今はすべて5分足で判定しています。この段落の数字は、どのペアの分も、すべて15分足で測ったもので、5分足で測ったものではありません。")).toBe(true);
    expect(uj).toContain("ではありません）。ドル/円だけでは平均+2.67 pips（合図なしでは+5.69 pips）です。ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。平均がマイナスだったペア: 豪ドル/円（-0.82 pips）。ほかに3回、");
    expect(uj).toContain("合図なしとの差（この決まり − 合図なし）は1回あたり-0.91 pips で、合図なしで入った時より低くありました。");
    const ue = fadeMeasuredLine("en", "USD/JPY", "15min");
    expect(ue.startsWith("Measured (five pairs, 15-minute bars that closed from 1 January 2024, 00:00 UTC up to, not including, 10 November 2026, 21:00 UTC, spread paid, docs §8.156). The emails of all five pairs are now judged on 5-minute bars. Every number in this paragraph, for every pair, was measured on 15-minute bars, not on 5-minute bars. ")).toBe(true);
    expect(ue).toContain("On USD/JPY alone the mean was +2.67 pips (with no signal, +5.69 pips). Each pair's difference from no signal has not been shown to be larger than chance gives");
    const ej = fadeMeasuredLine("ja", "EUR/JPY", "1h");
    expect(ej.startsWith("測った数字（5ペア、2024年1月1日 0:00（UTC）以後、2026年11月10日 21:00（UTC）より前に確定した1時間足、スプレッド込み、docs §8.156）。この5ペアのメールは、今はすべて5分足で判定しています。この段落の数字は、どのペアの分も、すべて1時間足で測ったもので、5分足で測ったものではありません。")).toBe(true);
    expect(ej).toContain("ユーロ/円だけでは平均+4.30 pips（合図なしでは+3.28 pips）です。ペアごとの合図なしとの差は");
    expect(ej).toContain("入ると+3.21 pips でした");
    // the AUD/JPY and EUR/USD sentences of the 1-hour run (no signal -0.75 and +2.61; v40's run said -0.77 and +2.60)
    expect(fadeMeasuredLine("ja", "AUD/JPY", "1h")).toContain("ではありません）。豪ドル/円だけでは平均+4.44 pips（合図なしでは-0.75 pips）です。ペアごとの合図なしとの差は");
    expect(fadeMeasuredLine("en", "AUD/JPY", "1h")).toContain("not a test). On AUD/JPY alone the mean was +4.44 pips (with no signal, -0.75 pips). Each pair's difference");
    expect(fadeMeasuredLine("ja", "EUR/USD", "1h")).toContain("ユーロ/ドルだけでは平均+3.11 pips（合図なしでは+2.61 pips）です。");
    // AUD/USD on its own chart (15 minutes)
    expect(fadeMeasuredLine("en", "AUD/USD", "15min")).toContain("On AUD/USD alone the mean was +4.94 pips (with no signal, +5.18 pips).");
  });

  it("each chart's notes' version (that run's five pairs, 4.5's listed changes only), from the spec's text; FADE_MEASURED_NOTES is them", () => {
    for (const tf of FADE_TFS) {
      for (const lang of ["ja", "en"] as const) {
        expect(fadeMeasuredNotes(lang, tf), `${lang} ${tf}`).toBe(notesOf(tf, lang));
        expect(FADE_MEASURED_NOTES[tf][lang]).toBe(notesOf(tf, lang));
      }
    }
    expect(FADE_MEASURED_NOTES["1h"].ja).toContain("ペアごとの1回あたりの平均は、ドル/円-0.26 pips（合図なしでは+5.74 pips）・ユーロ/円+4.30 pips（+3.28 pips）・豪ドル/円+4.44 pips（-0.75 pips）・ユーロ/ドル+3.11 pips（+2.61 pips）・豪ドル/ドル+4.42 pips（+5.16 pips）でした。ペアごとの合図なしとの差は");
    expect(FADE_MEASURED_NOTES["15min"].en).toContain("The mean a trade by pair: USD/JPY +2.67 pips (with no signal, +5.69 pips), EUR/JPY +1.29 pips (+3.41 pips), AUD/JPY -0.82 pips (-0.30 pips), EUR/USD +3.86 pips (+2.60 pips), AUD/USD +4.94 pips (+5.18 pips). Each pair's difference");
    for (const tf of FADE_TFS) {
      // no pair's own sentence
      expect(FADE_MEASURED_NOTES[tf].ja).not.toContain("だけでは平均");
      expect(FADE_MEASURED_NOTES[tf].en).not.toContain(" alone the mean");
    }
    // no 「このメール」 / "this email" in the notes (4.5: the notes' version has none)
    for (const [tf, m] of [["15min", FADE_MEASURED["15min"]], ["1h", FADE_MEASURED["1h"]], ["1h", OPEN0], ["15min", TP0]] as const) {
      expect(fadeMeasuredNotes("ja", tf, m)).not.toContain("このメール");
      expect(fadeMeasuredNotes("en", tf, m)).not.toMatch(/this email/i);
    }
  });

  it("〔mailedOn〕 right after the first sentence, the same in the mail and the notes; 〔baseWhat〕, the entry's parenthesis, the weekend sentence and the per-pair chance sentence in both; en's \"The measurement re-reads GMO's past bars\" in both charts' mail and notes", () => {
    for (const tf of FADE_TFS) {
      for (const lang of ["ja", "en"] as const) {
        for (const t of [fadeMeasuredLine(lang, "USD/JPY", tf), fadeMeasuredNotes(lang, tf)]) {
          const first = lang === "ja" ? t.indexOf("）。") + 2 : t.indexOf("). ") + 3;
          expect(t.slice(first).startsWith(MAILED_ON[tf][lang]), `${lang} ${tf}`).toBe(true);
          expect(t.split(MAILED_ON[tf][lang]).length - 1).toBe(1);
          expect(t).toContain(BASE_WHAT[tf][lang]);
          expect(t).toContain(ENTRY_PAREN[lang]);
          expect(t).toContain(WEEKEND[lang]);
          expect(t).toContain(PAIR_CHANCE[lang]);
          if (lang === "en") {
            expect(t).toContain(`${MAILED_ON[tf].en} The measurement re-reads GMO's past bars;`);
            expect(t).not.toContain("It re-reads");
          }
          // v40's three phrases are gone
          expect(t).not.toContain("メールした合図はすべて入ったとして数えました");
          expect(t).not.toContain("every signal emailed is counted as entered");
          expect(t).not.toContain("このメールでは判定しないので");
          expect(t).not.toContain("email does not judge those bars");
          expect(t).not.toContain("メールが判定する1時間足ごと");
          expect(t).not.toMatch(/bar (this|the) email judges/);
        }
      }
    }
  });

  it("the bar's word per chart: a run's paragraph names its own chart only, but for the 5-minute chart its emails are judged on in 〔mailedOn〕 (v43; v41's named the other run's chart there)", () => {
    // 「5分足」 / "5-minute" not as the end of 「15分足」 / "15-minute"
    const FIVE = { ja: /(?<!1)5分足/, en: /(?<!1)5-minute/ };
    for (const tf of FADE_TFS) {
      const [own, other] = tf === "15min" ? [["15分足", "15-minute"], ["1時間足", "1-hour"]] : [["1時間足", "1-hour"], ["15分足", "15-minute"]];
      for (const lang of ["ja", "en"] as const) {
        const i = lang === "ja" ? 0 : 1;
        expect(MAILED_ON[tf][lang], `${lang} ${tf}`).toMatch(FIVE[lang]);
        expect(MAILED_ON[tf][lang], `${lang} ${tf}`).toContain(own[i]);
        expect(MAILED_ON[tf][lang], `${lang} ${tf}`).not.toContain(other[i]);
        for (const t of [fadeMeasuredLine(lang, "EUR/USD", tf), fadeMeasuredNotes(lang, tf)]) {
          const rest = t.replace(MAILED_ON[tf][lang], "");
          expect(rest, `${lang} ${tf}`).toContain(own[i]);
          expect(rest, `${lang} ${tf}`).not.toContain(other[i]);
          expect(rest, `${lang} ${tf}`).not.toMatch(FIVE[lang]);
        }
      }
    }
    expect(fadeMeasuredLine("ja", "USD/JPY", "15min")).toContain("より前に確定した15分足、");
    expect(fadeMeasuredLine("ja", "USD/JPY", "15min")).toContain("足の終値ではなく15分足の最初の1分に入ったもので");
    expect(fadeMeasuredLine("en", "USD/JPY", "15min")).toContain("but entered at the 15-minute bar's first minute, not at its close");
    expect(fadeMeasuredLine("ja", "EUR/JPY", "1h")).toContain("より前に確定した1時間足、");
    expect(fadeMeasuredLine("en", "EUR/JPY", "1h")).toContain("but entered at the 1-hour bar's first minute, not at its close");
  });

  it("〔chance〕 per chart: the 15-minute run's \"base below, flow inside\" sentence, filled as 4.5 writes it; the 1-hour run's \"both inside\"; the case from the unrounded gaps against the run's own ranges; any other case refused", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(fadeMeasuredLine(lang, "USD/JPY", "15min")).toContain(CHANCE_BELOW_FILLED[lang]);
      expect(fadeMeasuredLine(lang, "USD/JPY", "15min")).not.toContain(CHANCE_INSIDE[lang]);
      expect(fadeMeasuredLine(lang, "EUR/JPY", "1h")).toContain(CHANCE_INSIDE[lang]);
      expect(fadeMeasuredLine(lang, "EUR/JPY", "1h")).not.toContain(CHANCE_BELOW_FILLED[lang]);
    }
    // the unrounded gap decides: the real gap (-0.906…) at a range's lower end is inside; the end a hair above it puts
    // the gap below (-0.91 written either way)
    const q = FADE_MEASURED["15min"];
    const mean = q.fade.pipsMean as number;
    const gb = mean - (q.baseMean as number);
    const withLo = (lo: number): FadeMeasured => ({ ...q, chance: { ...q.chance, fadeMinusBase: { lo, hi: 2.24 } } });
    expect(fadeMeasuredLine("en", "USD/JPY", "15min", withLo(gb))).toContain(CHANCE_INSIDE.en);
    expect(fadeMeasuredLine("en", "USD/JPY", "15min", withLo(gb + 1e-12))).toContain(fill(CHANCE_BELOW_SPEC.en, { gapBase: "-0.91", baseLo: "-0.91", baseHi: "+2.24", gapFlow: "-0.78", flowLo: "-2.25", flowHi: "+5.70" }));
    const at = (gbase: number, gflow: number): FadeMeasured => ({ ...q, baseMean: mean - gbase, flowMean: mean - gflow });
    expect(fadeMeasuredLine("ja", "USD/JPY", "15min", at(-1.234, 5.6))).toContain(fill(CHANCE_BELOW_SPEC.ja, { gapBase: "-1.23", baseLo: "-0.80", baseHi: "+2.24", gapFlow: "+5.60", flowLo: "-2.25", flowHi: "+5.70" }));
    // any other case: the build stops (no sentence written for it)
    expect(() => fadeMeasuredLine("en", "USD/JPY", "15min", at(2.25, 0))).toThrow(/writes no sentence/);
    expect(() => fadeMeasuredLine("en", "USD/JPY", "15min", at(0, 5.71))).toThrow(/writes no sentence/);
    expect(() => fadeMeasuredLine("ja", "USD/JPY", "15min", at(-1, -2.26))).toThrow(/writes no sentence/);
    const h = FADE_MEASURED["1h"];
    expect(() => fadeMeasuredNotes("ja", "1h", { ...h, baseMean: (h.fade.pipsMean as number) - 0.9 })).toThrow(/writes no sentence/);
  });

  it("〔open〕 = 0 (a summary made here, 1-hour chart): 「…の時点でまだ届いていないものはありませんでした。」 / \"None was still short of it by …\", the unrealised clause gone; times exact and rounded; 〔negPairs〕 none", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(fadeMeasuredLine(lang, "USD/JPY", "1h", OPEN0)).toBe(fill(specOf(lang, "1h", { notes: false, open0: true, tp0: false }), { ...OPEN0_SLOTS[lang], ...pairSlots(lang, OPEN0_PAIRS, "USD/JPY") }));
      expect(fadeMeasuredNotes(lang, "1h", OPEN0)).toBe(fill(specOf(lang, "1h", { notes: true, open0: true, tp0: false, pairs: OPEN0_PAIRS }), OPEN0_SLOTS[lang]));
    }
    const ja = fadeMeasuredLine("ja", "USD/JPY", "1h", OPEN0);
    expect(ja).toContain("うち12回が+10 pips に届きました。2025年12月31日 23:59（UTC）の時点でまだ届いていないものはありませんでした。1回あたり平均+10.00 pips。途中の含み損は");
    expect(ja).toContain("中央値約45分、10回に1回は3時間より長く、いちばん長いもので2日でした。");
    expect(ja).toContain("平均がマイナスだったペア: ありません。");
    const en = fadeMeasuredLine("en", "USD/JPY", "1h", OPEN0);
    expect(en).toContain("of which 12 reached +10 pips. None was still short of it by 31 December 2025, 23:59 UTC. The mean was +10.00 pips a trade. The largest loss");
    expect(en).toContain("median about 45 minutes, longer than 3 hours one time in ten, longest 2 days.");
    expect(en).toContain("Pairs whose mean was below zero: none.");
    for (const t of [ja, en]) expect(t).not.toMatch(/null|undefined|NaN/);
  });

  it("〔tp〕 = 0 (a summary made here, 15-minute chart): 「+10 pips に届いたものはありませんでした。」 / \"None reached +10 pips.\"; two pairs below zero", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(fadeMeasuredLine(lang, "AUD/USD", "15min", TP0)).toBe(fill(specOf(lang, "15min", { notes: false, open0: false, tp0: true }), { ...TP0_SLOTS[lang], ...pairSlots(lang, TP0_PAIRS, "AUD/USD") }));
      expect(fadeMeasuredNotes(lang, "15min", TP0)).toBe(fill(specOf(lang, "15min", { notes: true, open0: false, tp0: true, pairs: TP0_PAIRS }), TP0_SLOTS[lang]));
    }
    const ja = fadeMeasuredLine("ja", "AUD/USD", "15min", TP0);
    expect(ja).toContain("いちばん長いもので119分持ったままでした（その後は追っていません）。1回あたり平均-25.50 pips（届いていないものは、その時の含み損益で数えました）。途中の含み損は中央値30.0 pips、最大45.6 pips。+10 pips に届いたものはありませんでした。足の終値で入る");
    expect(ja).toContain("豪ドル/ドルだけでは平均-1.00 pips（合図なしでは+5.00 pips）です。ペアごとの合図なしとの差は");
    expect(ja).toContain("平均がマイナスだったペア: ドル/円（-12.50 pips）・豪ドル/ドル（-1.00 pips）。ほかに2回、");
    const en = fadeMeasuredLine("en", "AUD/USD", "15min", TP0);
    expect(en).toContain("the longest held 119 minutes (not followed after that). The mean was -25.50 pips a trade (those not reached counted at their unrealised result then). The largest loss on the way: median 30.0 pips, largest 45.6 pips. None reached +10 pips. The entry is");
    expect(en).toContain("Pairs whose mean was below zero: USD/JPY (-12.50 pips), AUD/USD (-1.00 pips).");
    for (const t of [ja, en]) expect(t).not.toMatch(/null|undefined|NaN/);
  });

  it("refused (spec 4.5, 7.1): a chart with no run (5 minutes among them); a run that is not the chart's (m.tf !== tf); a pair not measured (gold); no fade trade; a missing value; a run that does not hold the five pairs (v43's 〔mailedOn〕)", () => {
    expect(() => fadeMeasuredLine("ja", "USD/JPY", "4h")).toThrow(/no run is held for the chart "4h"/);
    expect(() => fadeMeasuredNotes("en", "5min")).toThrow(/no run is held/);
    expect(() => fadeMeasuredLine("en", "USD/JPY", "4h", { ...FADE_MEASURED["15min"], tf: "4h" })).toThrow(/no run is held/);
    expect(() => fadeMeasuredLine("en", "toString", "toString")).toThrow(/no run is held/);
    expect(() => fadeMeasuredLine("ja", "EUR/JPY", "1h", FADE_MEASURED["15min"])).toThrow(/the run's chart is "15min", not "1h"/);
    expect(() => fadeMeasuredNotes("ja", "15min", FADE_MEASURED["1h"])).toThrow(/the run's chart is "1h", not "15min"/);
    expect(() => fadeMeasuredLine("ja", "XAU/USD", "1h")).toThrow(/not among the pairs/);
    expect(() => fadeMeasuredLine("en", "GBP/JPY", "15min")).toThrow(/not among the pairs/);
    const none = { ...OPEN0, fade: { ...OPEN0.fade, trades: 0, tp: 0, open: 0 } };
    expect(() => fadeMeasuredLine("ja", "USD/JPY", "1h", none)).toThrow(/no fade trade/);
    expect(() => fadeMeasuredNotes("en", "1h", none)).toThrow(/no fade trade/);
    expect(() => fadeMeasuredNotes("ja", "1h", { ...FADE_MEASURED["1h"], fade: { ...FADE_MEASURED["1h"].fade, openPipsSum: null } })).toThrow(/openPipsSum/);
    // v43: 〔mailedOn〕 speaks of the run's pairs as the five (v41: a pair mailed on the chart that the run did not hold)
    const noAud = { ...FADE_MEASURED["15min"], pairs: FADE_MEASURED["15min"].pairs.filter((p) => p.pair !== "AUD/USD") };
    expect(() => fadeMeasuredLine("ja", "USD/JPY", "15min", noAud)).toThrow(/〔mailedOn〕 speaks of five pairs, the run holds 4/);
    expect(() => fadeMeasuredNotes("en", "15min", noAud)).toThrow(/〔mailedOn〕 speaks of five pairs, the run holds 4/);
  });

  it("the fields 4.1 and 7.1 require with a count reaching +10: the mean, the open trades, the largest loss on the way, the holding time, no order unfilled, the baseline, the re-read clause", () => {
    for (const [name, t] of ALL_TEXTS) {
      const tf = tfOfName(name);
      if (name.startsWith("ja")) {
        expect(t, name).toContain("過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。");
        expect(t, name).toContain("1回あたり平均");
        expect(t, name).toMatch(/（マイナスが損）|の時点でまだ届いていないものはありませんでした。/);
        expect(t, name).toContain("途中の含み損は中央値");
        expect(t, name).toMatch(/\+10 pips に届くまでの時間は中央値|\+10 pips に届いたものはありませんでした。/);
        expect(t, name).toContain("入らなかった注文はありません");
        expect(t, name).toContain(`合図なしで${BASE_WHAT[tf].ja}入ると`);
        expect(t, name).toContain(`（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく${tf === "15min" ? "15分足" : "1時間足"}の最初の1分に入ったもので、同じ入りではありません）。`);
        expect(t, name).toContain("損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。");
      } else {
        expect(t, name).toContain("The measurement re-reads GMO's past bars;");
        expect(t, name).toContain("The mean was ");
        expect(t, name).toMatch(/\(a minus is a loss\)|None was still short of it by /);
        expect(t, name).toContain("The largest loss on the way: median ");
        expect(t, name).toMatch(/Time to \+10 pips: median |None reached \+10 pips\./);
        expect(t, name).toContain("no order went unfilled");
        expect(t, name).toContain(`entering with no signal ${BASE_WHAT[tf].en} gave`);
        expect(t, name).toContain(`(held the same way, +10 pips and no stop, but entered at the ${tf === "15min" ? "15-minute" : "1-hour"} bar's first minute, not at its close, so not the same entry).`);
        expect(t, name).toContain("With no stop, the share reaching +10 pips comes out high by construction.");
      }
    }
  });

  it("4.1's guards: research/macdfade96-spec.md 6.1's two patterns find nothing; no 「利確の目安」 / \"take-profit level\"; no text puts the five pairs and gold on one chart or gives the reason for a pair's chart", () => {
    // the two patterns, as research/macdfade96-spec.md 6.1 writes them (held against the file)
    const BACK_JA = /(必ず|いずれ|きっと|そのうち|やがて)[^。]{0,8}戻|戻ってく|戻ってき|戻るはず|戻ります/;
    const BACK_EN =
      /\b(always|will|surely|certainly|eventually)\s+(come|comes|go|goes)\s+back\b|\b(always|will|surely|certainly|eventually)\s+(return|returns|recover|recovers)\b|\bcomes?\s+back\s+(eventually|in\s+the\s+end)\b/i;
    const spec96 = readFileSync("research/macdfade96-spec.md", "utf8");
    expect(spec96).toContain(`\`/${BACK_JA.source}/\``);
    expect(spec96).toContain(`\`/${BACK_EN.source}/i\``);
    // the patterns catch the owner's own words and an English come-back claim
    expect(BACK_JA.test("必ず戻ってくる")).toBe(true);
    expect(BACK_EN.test("the price will come back")).toBe(true);
    expect(ALL_TEXTS.length).toBe(2 * (2 * (PAIRS.length + 1) + 4));
    for (const [name, t] of ALL_TEXTS) {
      expect(BACK_JA.test(t), name).toBe(false);
      expect(BACK_EN.test(t), name).toBe(false);
      expect(t, name).not.toContain("利確の目安");
      expect(t.toLowerCase(), name).not.toContain("take-profit level");
      expect(t, name).not.toContain("必ず");
      // 4.1: no reason for a pair's chart (「勝率の高い方」) and no "the five pairs and gold on 15-minute bars"
      expect(t, name).not.toContain("勝率");
      expect(t.toLowerCase(), name).not.toContain("win rate");
      expect(t, name).not.toMatch(/金/);
      expect(t, name).not.toMatch(/gold/i);
    }
  });
});
