// The MACD fade judged at closed bars (research/macdfade1h-prod-spec.md sections 2.1-2.2, 3.1, 3.7, 4.1 and 4.5, the
// record of v40 on 1-hour bars; v41 moves the email to 15-minute bars, research/macdfade15min-prod-spec.md 3.1 and 3.7):
// the shared code the function runs (supabase/functions/_shared/macd-fade.ts) and the measured paragraph
// (supabase/functions/_shared/macd-fade-measured.ts; still the 1-hour run's numbers until research/macdfade15min-
// prod-spec.md 4.5 puts the 15-minute run's in).
//
//   1. the constants and the two rule ids (built from the constants as 3.7 writes them; the app's FADE_ID of section 5
//      matches them, RIDE_ID does not)
//   2. on seeded random walks (prices of 3, 5, 2 and 1 decimals), at every bar with 600 closes up to it: Z and Zp
//      against zoneAt at 599 and 598 of the window rebuilt; Zp bit for bit against zoneAt(macd(the 599 closes before
//      n), 598); the entry at several shares against the rule written again here from 2.1-2.2; at v8's 0.95 the side
//      equal to macd-level.ts decideZoneOnWindow's; never both sides
//   3. equality at the share is in (a share that puts the line exactly on s * top or s * bottom)
//   4. null on 599 closes and on a non-finite close of the newest 600; only the newest 600 read
//   5. FADE_MEASURED against research/ledger/macdfade1h-summary.json, value by value (meta.tf "1h", share 0.96, tp 10)
//   6. the measured paragraph, ja and en, word for word: section 4.5's text (copied below and held against the spec
//      file) filled with the table's values, for every pair's mail and the notes' version; the 〔open〕 = 0 and
//      〔tp〕 = 0 variants from summaries made here; 4.1's guards
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
  FADE_MEASURED,
  FADE_MEASURED_NOTES,
  FADE_MEASURED_SOURCE,
  type FadeMeasured,
  type FadeSummary,
  fadeMeasuredFromSummary,
  fadeMeasuredLine,
  fadeMeasuredNotes,
} from "../../supabase/functions/_shared/macd-fade-measured";
import { MACDH_FADE_VERSION, MACDH_INTERVALS, MACDH_RULE_ID } from "../../supabase/functions/signal-alerts/indicators";
import { STOCKMACD_FADE_VERSION, STOCKMACD_INTERVALS, STOCKMACD_RULE_ID } from "../../supabase/functions/signal-alerts/stocks";

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

  it("the two ids built from the constants as 3.7 writes them, matching FADE_ID (pct 96) and not RIDE_ID", () => {
    // research/macdfade15min-prod-spec.md 3.7: fadeRuleId("macdx", MACDH_INTERVALS[0], 12),
    // fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], 5) (v40's: 11 and 4 on "1h")
    expect(MACDH_INTERVALS[0]).toBe("15min");
    expect(STOCKMACD_INTERVALS[0]).toBe("15min");
    expect(MACDH_FADE_VERSION).toBe(12);
    expect(STOCKMACD_FADE_VERSION).toBe(5);
    const pairs = fadeRuleId("macdx", MACDH_INTERVALS[0], MACDH_FADE_VERSION);
    const shares = fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], STOCKMACD_FADE_VERSION);
    expect(pairs).toBe("macdx_12_26_9_w600_15min_fade96of120_in_v12");
    expect(shares).toBe("stockmacd_12_26_9_w600_15min_fade96of120_in_v5");
    // the function's own ids are these
    expect(MACDH_RULE_ID).toBe(pairs);
    expect(STOCKMACD_RULE_ID).toBe(shares);
    for (const id of [pairs, shares]) {
      const m = FADE_ID.exec(id);
      expect(m, id).not.toBeNull();
      expect(Number(m?.[1])).toBe(FADE_PCT);
      expect(RIDE_ID.test(id), id).toBe(false);
    }
    // the app's tab (ruleOfId: the prefix the id starts with)
    expect(pairs.startsWith("macdx_")).toBe(true);
    expect(shares.startsWith("stockmacd_")).toBe(true);
    // v9's and v10's ids are RIDE_ID's, not FADE_ID's; v8's 1-hour zone id is neither
    for (const old of ["macdx_12_26_9_w600_1h_ride90to96of120_in_v9", "macdx_12_26_9_w600_1h_touch90to95of120_in_v10", "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2"]) {
      expect(RIDE_ID.test(old)).toBe(true);
      expect(FADE_ID.test(old)).toBe(false);
    }
    for (const old of ["macdx_12_26_9_w600_1h_z95of120_v8", "stockmacd_12_26_9_w600_1h_z95of120_v1"]) {
      expect(FADE_ID.test(old)).toBe(false);
      expect(RIDE_ID.test(old)).toBe(false);
    }
    // 3.7: the ids differ from every earlier id, the never-built ones and the two 1-hour fade ids v40 writes included
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
  });

  it("the copies above are the app's RIDE_ID as written, and section 5's FADE_ID (the app's, once it has one)", () => {
    const app = readFileSync("src/lib/signalAlerts.ts", "utf8");
    expect(app).toContain(`const RIDE_ID = /${RIDE_ID.source}/;`);
    const spec = readFileSync("research/macdfade15min-prod-spec.md", "utf8");
    expect(spec).toContain(`/${FADE_ID.source}/`);
    const fade = /const FADE_ID\s*=\s*(\/.*\/);/.exec(app);
    if (fade) expect(fade[1]).toBe(`/${FADE_ID.source}/`);
  });

  it("research/macdfade15min-prod-spec.md 4.5: _shared/macd-fade-measured.ts imports nothing from signal-alerts/ (indicators.ts imports it, and it builds its notes at load: an import back would read MACDH_INTERVALS before indicators.ts has set it)", () => {
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

// ---- 5. FADE_MEASURED against the ledger copy of the run's summary.json ------------------------------------------

const LEDGER = "research/ledger/macdfade1h-summary.json";
const ledgerBytes = readFileSync(LEDGER);
const ledger = JSON.parse(ledgerBytes.toString("utf8")) as FadeSummary & { meta: { tf: string; loadFrom: string } };
const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];

describe("FADE_MEASURED: the real 1-hour run's numbers (research/ledger/macdfade1h-summary.json)", () => {
  it("the ledger file is the run's summary.json (sha256 60edab22…a9e2, 16,630 bytes)", () => {
    expect(createHash("sha256").update(ledgerBytes).digest("hex")).toBe("60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2");
    expect(FADE_MEASURED_SOURCE.summarySha256).toBe("60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2");
    expect(ledgerBytes.length).toBe(16630);
    expect(FADE_MEASURED_SOURCE.ledger).toBe(LEDGER);
    expect(FADE_MEASURED_SOURCE.run).toBe(44099401423);
    expect(FADE_MEASURED_SOURCE.rerun).toBe(44108923903);
  });

  it("meta: tf 1h, share 0.96 (the function's FADE_SHARE), tp 10, the period", () => {
    expect(ledger.meta.tf).toBe("1h");
    expect(ledger.meta.share).toBe(0.96);
    expect(ledger.meta.share).toBe(FADE_SHARE);
    expect(ledger.meta.tp).toBe(10);
    expect(FADE_MEASURED.tf).toBe(ledger.meta.tf);
    expect(FADE_MEASURED.share).toBe(ledger.meta.share);
    expect(FADE_MEASURED.tp).toBe(ledger.meta.tp);
    expect(FADE_MEASURED.from).toBe(ledger.meta.start);
    expect(FADE_MEASURED.to).toBe(ledger.meta.end);
    expect(FADE_MEASURED.from).toBe("2024-01-01T00:00:00Z");
    expect(FADE_MEASURED.to).toBe("2026-11-10T21:00:00Z");
  });

  it("every value of FADE_MEASURED equals the file's, unrounded", () => {
    const f = ledger.dirs.fade.all;
    const keys = ["trades", "tp", "open", "pipsMean", "maeMedian", "maeMax", "tpMinutesMedian", "tpMinutesP90", "tpMinutesMax", "openPipsSum", "openPipsWorst", "openMinutesMax"] as const;
    for (const k of keys) expect(FADE_MEASURED.fade[k], `dirs.fade.all.${k}`).toBe(f[k]);
    expect(Object.keys(FADE_MEASURED.fade).sort()).toEqual([...keys].sort());
    expect(FADE_MEASURED.flowMean).toBe(ledger.dirs.flow.all.pipsMean);
    expect(FADE_MEASURED.baseMean).toBe(ledger.base.all.pipsMean);
    expect(ledger.pairs.map((p) => p.pair)).toEqual(PAIRS);
    expect(FADE_MEASURED.pairs.map((p) => p.pair)).toEqual(PAIRS);
    for (const [i, p] of FADE_MEASURED.pairs.entries()) {
      expect(p.mean, `dirs.fade["${p.pair}"].pipsMean`).toBe(ledger.dirs.fade[p.pair].pipsMean);
      expect(p.baseMean, `base["${p.pair}"].pipsMean`).toBe(ledger.base[p.pair].pipsMean);
      expect(p.notMailed, `pairs[${i}].notMailed`).toBe(ledger.pairs[i].notMailed);
    }
    expect(FADE_MEASURED.notMailed).toBe(ledger.pairs.reduce((x, p) => x + p.notMailed, 0));
    // the same through fadeMeasuredFromSummary (what the variants below are built with)
    expect(fadeMeasuredFromSummary(ledger, { sec: FADE_MEASURED.sec, chance: FADE_MEASURED.chance })).toEqual(FADE_MEASURED);
  });

  it("the values as section 4.5's table writes them", () => {
    const m = FADE_MEASURED;
    expect([m.fade.trades, m.fade.tp, m.fade.open]).toEqual([1490, 1468, 22]);
    expect(m.fade.tp + m.fade.open).toBe(m.fade.trades);
    expect(m.fade.pipsMean?.toFixed(2)).toBe("3.26");
    expect([m.fade.maeMedian, m.fade.maeMax]).toEqual([10.7, 2243.6]);
    expect([m.fade.tpMinutesMedian, m.fade.tpMinutesP90, m.fade.tpMinutesMax]).toEqual([140, 4489, 687037]);
    expect([m.fade.openPipsSum?.toFixed(1), m.fade.openPipsWorst, m.fade.openMinutesMax]).toEqual(["-9820.9", -1733.2, 888900]);
    expect(m.flowMean?.toFixed(2)).toBe("-2.08");
    expect(m.baseMean?.toFixed(2)).toBe("3.20");
    expect(m.pairs.map((p) => [p.pair, p.mean?.toFixed(2), p.baseMean?.toFixed(2), p.notMailed])).toEqual([
      ["USD/JPY", "-0.26", "5.74", 2],
      ["EUR/JPY", "4.30", "3.28", 0],
      ["AUD/JPY", "4.44", "-0.77", 2],
      ["EUR/USD", "3.11", "2.60", 3],
      ["AUD/USD", "4.42", "5.16", 4],
    ]);
    expect(m.notMailed).toBe(11);
    expect(m.sec).toBe("8.155");
  });

  it("〔chance〕's walks: the ranges and null.json's sha256 as research/macdfade15-spec.md records them, the real gaps inside", () => {
    const study = readFileSync("research/macdfade15-spec.md", "utf8").replace(/\s+/g, " ");
    const u = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(2)}`;
    const c = FADE_MEASURED.chance;
    const fb = (FADE_MEASURED.fade.pipsMean as number) - (FADE_MEASURED.baseMean as number);
    const ff = (FADE_MEASURED.fade.pipsMean as number) - (FADE_MEASURED.flowMean as number);
    expect(study).toContain(`fade − base ${u(fb)} pips a trade (walks ${u(c.fadeMinusBase.lo)}..${u(c.fadeMinusBase.hi)}: inside)`);
    expect(study).toContain(`fade − flow ${u(ff)} pips a trade (walks ${u(c.fadeMinusFlow.lo)}..${u(c.fadeMinusFlow.hi)}: inside)`);
    expect(u(fb)).toBe("+0.06");
    expect(u(ff)).toBe("+5.34");
    expect(study).toContain(`null.json sha256 \`${c.nullSha256}\``);
    expect(c.nullSha256).toBe("3d285440123d50ac776228092b1a2560db12ff1d114b97bbec676350175b9b96");
  });
});

// ---- 6. the measured paragraph (spec 4.5) -------------------------------------------------------------------------

// section 4.5's ja and en, word for word (held against the spec file below); 〔…〕 the slots
const SPEC_JA =
  "測った数字（5ペア、〔from〕以後、〔to〕より前に確定した1時間足、スプレッド込み、docs §〔sec〕）。過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。" +
  "このメールの決まりで足の終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていません）: 合図は〔trades〕回、うち〔tp〕回が+10 pips に届きました。" +
  "〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕持ったままでした（その後は追っていません）。" +
  "1回あたり平均〔mean〕 pips（届いていないものは、その時の含み損益で数えました）。途中の含み損は中央値〔maeMedian〕 pips、最大〔maeMax〕 pips。" +
  "+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。足の終値で入るので指値ではなく、入らなかった注文はありません（メールした合図はすべて入ったとして数えました）。" +
  "損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり〔flowMean〕 pips、合図なしで〔baseWhat〕入ると〔baseMean〕 pips でした" +
  "（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく1時間足の最初の1分に入ったもので、同じ入りではありません）。〔chance〕〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。" +
  "平均がマイナスだったペア: 〔negPairs〕。ほかに〔notMailed〕回、週末の止まっている時間に確定した足に合図がありましたが、このメールでは判定しないので、上の数字に入れていません。";
const SPEC_EN =
  "Measured (five pairs, 1-hour bars that closed from 〔from〕 up to, not including, 〔to〕, spread paid, docs §〔sec〕). It re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured). " +
  "Entered by this email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this email states no take-profit price): 〔trades〕 signals, of which 〔tp〕 reached +10 pips. " +
  "〔open〕 had not reached it by 〔to〕; their unrealised result was 〔openPipsSum〕 pips in all (a minus is a loss), the worst 〔openPipsWorst〕 pips, the longest held 〔openLongest〕 (not followed after that). " +
  "The mean was 〔mean〕 pips a trade (those not reached counted at their unrealised result then). The largest loss on the way: median 〔maeMedian〕 pips, largest 〔maeMax〕 pips. " +
  "Time to +10 pips: median 〔tpMedian〕, longer than 〔tpP90〕 one time in ten, longest 〔tpMax〕. The entry is at the bar's close, not a limit order, so no order went unfilled (every signal emailed is counted as entered). " +
  "With no stop, the share reaching +10 pips comes out high by construction. Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave 〔flowMean〕 pips a trade, and entering with no signal 〔baseWhat〕 gave 〔baseMean〕 pips " +
  "(held the same way, +10 pips and no stop, but entered at the 1-hour bar's first minute, not at its close, so not the same entry). 〔chance〕 On 〔pair〕 alone the mean was 〔pairMean〕 pips (with no signal, 〔pairBaseMean〕 pips). " +
  "Pairs whose mean was below zero: 〔negPairs〕. Besides these, 〔notMailed〕 signals fell on bars that closed in the weekend pause; this email does not judge those bars, so they are not in the numbers above.";
const BASE_WHAT = {
  ja: "このメールが判定する1時間足ごとの最初の1分に（買いと売りを1回ずつ）",
  en: "at the first minute of every 1-hour bar this email judges (a BUY and a SELL)",
};
// the notes' version of 〔baseWhat〕 (4.5's notes' change list: no 「このメール」 / "this email")
const BASE_WHAT_NOTES = {
  ja: "メールが判定する1時間足ごとの最初の1分に（買いと売りを1回ずつ）",
  en: "at the first minute of every 1-hour bar the email judges (a BUY and a SELL)",
};
const CHANCE = {
  ja: "合図なしとの差も、逆向きとの差も、値動きに傾きのない作り物の値段10本で同じように測った差の幅の中でした（偶然で出る幅の中なので、どちらより良いとも言えません。作り物の値段は GMO のものではなく、10本で分かるのは幅だけで、確かめ〈検定〉ではありません）。",
  en: "The differences from no signal and from the other way were both within the range of the same differences measured on ten made-up price walks with no trend (a range chance alone gives, so it is not shown to do better than either; the walks' prices are not GMO's, and ten walks give a range, not a test).",
};
const JA_PAIR: Record<string, string> = { "USD/JPY": "ドル/円", "EUR/JPY": "ユーロ/円", "AUD/JPY": "豪ドル/円", "EUR/USD": "ユーロ/ドル", "AUD/USD": "豪ドル/ドル" };

type Lang = "ja" | "en";
// the spec's text with section 4.5's changes: the notes' version (its listed changes only) and the 〔open〕 = 0 /
// 〔tp〕 = 0 variants, each replacement found exactly once
const once = (t: string, from: string, to: string) => {
  expect(t.split(from).length - 1, `"${from}" once`).toBe(1);
  return t.replace(from, to);
};
const specOf = (lang: Lang, o: { notes: boolean; open0: boolean; tp0: boolean; pairs?: Array<[string, string, string]> }) => {
  let t = lang === "ja" ? SPEC_JA : SPEC_EN;
  if (lang === "ja") {
    if (o.open0) {
      t = once(t, "〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕持ったままでした（その後は追っていません）。", "〔to〕の時点でまだ届いていないものはありませんでした。");
      t = once(t, "（届いていないものは、その時の含み損益で数えました）", "");
    }
    if (o.tp0) t = once(t, "+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。", "+10 pips に届いたものはありませんでした。");
    if (o.notes) {
      t = once(t, "このメールの決まりで", "メールの決まりで");
      t = once(t, "このメールでは判定しないので", "メールでは判定しないので");
      t = once(t, "合図なしで〔baseWhat〕入ると", `合図なしで${BASE_WHAT_NOTES.ja}入ると`);
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
      t = once(t, "this email does not judge those bars", "the email does not judge those bars");
      t = once(t, "entering with no signal 〔baseWhat〕 gave", `entering with no signal ${BASE_WHAT_NOTES.en} gave`);
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

// the real numbers' slots, written by hand from section 4.5's table (a minus as toFixed writes it)
const REAL: Record<Lang, Record<string, string>> = {
  ja: {
    from: "2024年1月1日 0:00（UTC）",
    to: "2026年11月10日 21:00（UTC）",
    sec: "8.155",
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
    baseMean: "+3.20",
    baseWhat: BASE_WHAT.ja,
    chance: CHANCE.ja,
    negPairs: "ドル/円（-0.26 pips）",
    notMailed: "11",
  },
  en: {
    from: "1 January 2024, 00:00 UTC",
    to: "10 November 2026, 21:00 UTC",
    sec: "8.155",
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
    baseMean: "+3.20",
    baseWhat: BASE_WHAT.en,
    chance: CHANCE.en,
    negPairs: "USD/JPY (-0.26 pips)",
    notMailed: "11",
  },
};
const REAL_PAIRS: Array<[string, string, string]> = [
  ["USD/JPY", "-0.26", "+5.74"],
  ["EUR/JPY", "+4.30", "+3.28"],
  ["AUD/JPY", "+4.44", "-0.77"],
  ["EUR/USD", "+3.11", "+2.60"],
  ["AUD/USD", "+4.42", "+5.16"],
];

// the USD/JPY mail and the notes, written out whole (the paragraph as the owner reads it)
const USDJPY_JA =
  "測った数字（5ペア、2024年1月1日 0:00（UTC）以後、2026年11月10日 21:00（UTC）より前に確定した1時間足、スプレッド込み、docs §8.155）。過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。" +
  "このメールの決まりで足の終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていません）: 合図は1,490回、うち1,468回が+10 pips に届きました。" +
  "22回は2026年11月10日 21:00（UTC）の時点でまだ届いておらず、その含み損益は合わせて-9,820.9 pips（マイナスが損）、いちばん悪いもので-1,733.2 pips、いちばん長いもので約617日持ったままでした（その後は追っていません）。" +
  "1回あたり平均+3.26 pips（届いていないものは、その時の含み損益で数えました）。途中の含み損は中央値10.7 pips、最大2,243.6 pips。" +
  "+10 pips に届くまでの時間は中央値約2時間、10回に1回は約3日より長く、いちばん長いもので約477日でした。足の終値で入るので指値ではなく、入らなかった注文はありません（メールした合図はすべて入ったとして数えました）。" +
  "損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり-2.08 pips、合図なしでこのメールが判定する1時間足ごとの最初の1分に（買いと売りを1回ずつ）入ると+3.20 pips でした" +
  "（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく1時間足の最初の1分に入ったもので、同じ入りではありません）。" +
  "合図なしとの差も、逆向きとの差も、値動きに傾きのない作り物の値段10本で同じように測った差の幅の中でした（偶然で出る幅の中なので、どちらより良いとも言えません。作り物の値段は GMO のものではなく、10本で分かるのは幅だけで、確かめ〈検定〉ではありません）。" +
  "ドル/円だけでは平均-0.26 pips（合図なしでは+5.74 pips）です。平均がマイナスだったペア: ドル/円（-0.26 pips）。ほかに11回、週末の止まっている時間に確定した足に合図がありましたが、このメールでは判定しないので、上の数字に入れていません。";
const USDJPY_EN =
  "Measured (five pairs, 1-hour bars that closed from 1 January 2024, 00:00 UTC up to, not including, 10 November 2026, 21:00 UTC, spread paid, docs §8.155). It re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured). " +
  "Entered by this email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this email states no take-profit price): 1,490 signals, of which 1,468 reached +10 pips. " +
  "22 had not reached it by 10 November 2026, 21:00 UTC; their unrealised result was -9,820.9 pips in all (a minus is a loss), the worst -1,733.2 pips, the longest held about 617 days (not followed after that). " +
  "The mean was +3.26 pips a trade (those not reached counted at their unrealised result then). The largest loss on the way: median 10.7 pips, largest 2,243.6 pips. " +
  "Time to +10 pips: median about 2 hours, longer than about 3 days one time in ten, longest about 477 days. The entry is at the bar's close, not a limit order, so no order went unfilled (every signal emailed is counted as entered). " +
  "With no stop, the share reaching +10 pips comes out high by construction. Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave -2.08 pips a trade, and entering with no signal at the first minute of every 1-hour bar this email judges (a BUY and a SELL) gave +3.20 pips " +
  "(held the same way, +10 pips and no stop, but entered at the 1-hour bar's first minute, not at its close, so not the same entry). " +
  "The differences from no signal and from the other way were both within the range of the same differences measured on ten made-up price walks with no trend (a range chance alone gives, so it is not shown to do better than either; the walks' prices are not GMO's, and ten walks give a range, not a test). " +
  "On USD/JPY alone the mean was -0.26 pips (with no signal, +5.74 pips). Pairs whose mean was below zero: USD/JPY (-0.26 pips). Besides these, 11 signals fell on bars that closed in the weekend pause; this email does not judge those bars, so they are not in the numbers above.";
// the notes: the same with 4.5's notes' changes only
const NOTES_JA = USDJPY_JA.replace("このメールの決まりで", "メールの決まりで")
  .replace("このメールでは判定しないので", "メールでは判定しないので")
  .replace("合図なしでこのメールが判定する1時間足ごとの", "合図なしでメールが判定する1時間足ごとの")
  .replace(
    "ドル/円だけでは平均-0.26 pips（合図なしでは+5.74 pips）です。",
    "ペアごとの1回あたりの平均は、ドル/円-0.26 pips（合図なしでは+5.74 pips）・ユーロ/円+4.30 pips（+3.28 pips）・豪ドル/円+4.44 pips（-0.77 pips）・ユーロ/ドル+3.11 pips（+2.60 pips）・豪ドル/ドル+4.42 pips（+5.16 pips）でした。",
  );
const NOTES_EN = USDJPY_EN.replace("times this email's reads failed", "times the email's reads failed")
  .replace("Entered by this email's rule", "Entered by the email's rule")
  .replace("this email states no take-profit price", "the email states no take-profit price")
  .replace("this email does not judge those bars", "the email does not judge those bars")
  .replace("every 1-hour bar this email judges", "every 1-hour bar the email judges")
  .replace(
    "On USD/JPY alone the mean was -0.26 pips (with no signal, +5.74 pips).",
    "The mean a trade by pair: USD/JPY -0.26 pips (with no signal, +5.74 pips), EUR/JPY +4.30 pips (+3.28 pips), AUD/JPY +4.44 pips (-0.77 pips), EUR/USD +3.11 pips (+2.60 pips), AUD/USD +4.42 pips (+5.16 pips).",
  );

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
  start: string;
  end: string;
  fade: Partial<G>;
  flowMean: number;
  baseMean: number;
  pairs: Array<[string, number, number, number]>;
}): FadeSummary => ({
  meta: { start: o.start, end: o.end, share: 0.96, tp: 10, tf: "1h" },
  pairs: o.pairs.map(([pair, , , notMailed]) => ({ pair, notMailed })),
  dirs: {
    fade: { all: group(o.fade), ...Object.fromEntries(o.pairs.map(([p, mean]) => [p, group({ pipsMean: mean })])) },
    flow: { all: group({ pipsMean: o.flowMean }) },
  },
  base: { all: group({ pipsMean: o.baseMean }), ...Object.fromEntries(o.pairs.map(([p, , baseMean]) => [p, group({ pipsMean: baseMean })])) },
});
const made = (s: FadeSummary): FadeMeasured => fadeMeasuredFromSummary(s, { sec: "8.155", chance: FADE_MEASURED.chance });

// 〔open〕 = 0: every trade reached +10; times exact and rounded; no pair below zero
const OPEN0 = made(summaryMade({
  start: "2024-02-05T09:05:00Z",
  end: "2025-12-31T23:59:00Z",
  fade: { trades: 12, tp: 12, open: 0, pipsMean: 10, maeMedian: 3.2, maeMax: 1234.5, tpMinutesMedian: 44.5, tpMinutesP90: 180, tpMinutesMax: 2880 },
  flowMean: 9.5,
  baseMean: 9.99,
  pairs: [["USD/JPY", 10, 9.5, 2], ["EUR/JPY", 10, 10.25, 0], ["AUD/JPY", 10, 9, 1], ["EUR/USD", 10, 12, 0], ["AUD/USD", 10, 0, 0]],
}));
const OPEN0_SLOTS: Record<Lang, Record<string, string>> = {
  ja: {
    from: "2024年2月5日 9:05（UTC）",
    to: "2025年12月31日 23:59（UTC）",
    sec: "8.155",
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
    baseWhat: BASE_WHAT.ja,
    chance: CHANCE.ja,
    negPairs: "ありません",
    notMailed: "3",
  },
  en: {
    from: "5 February 2024, 09:05 UTC",
    to: "31 December 2025, 23:59 UTC",
    sec: "8.155",
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
    baseWhat: BASE_WHAT.en,
    chance: CHANCE.en,
    negPairs: "none",
    notMailed: "3",
  },
};
const OPEN0_PAIRS: Array<[string, string, string]> = [["USD/JPY", "+10.00", "+9.50"], ["EUR/JPY", "+10.00", "+10.25"], ["AUD/JPY", "+10.00", "+9.00"], ["EUR/USD", "+10.00", "+12.00"], ["AUD/USD", "+10.00", "+0.00"]];

// 〔tp〕 = 0: no trade reached +10, all still open; two pairs below zero
const TP0 = made(summaryMade({
  start: "2024-01-01T00:00:00Z",
  end: "2026-11-10T21:00:00Z",
  fade: { trades: 3, tp: 0, open: 3, pipsMean: -25.5, maeMedian: 30, maeMax: 45.6, tpMinutesMedian: null, tpMinutesP90: null, tpMinutesMax: null, openPipsSum: -76.5, openPipsWorst: -40.2, openMinutesMax: 119 },
  flowMean: -26,
  baseMean: -25,
  pairs: [["USD/JPY", -12.5, -1, 0], ["EUR/JPY", 0, 0, 0], ["AUD/JPY", 3, -2, 0], ["EUR/USD", 1.234, 2, 0], ["AUD/USD", -1, 5, 2]],
}));
const TP0_SLOTS: Record<Lang, Record<string, string>> = {
  ja: {
    from: "2024年1月1日 0:00（UTC）",
    to: "2026年11月10日 21:00（UTC）",
    sec: "8.155",
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
    baseWhat: BASE_WHAT.ja,
    chance: CHANCE.ja,
    negPairs: "ドル/円（-12.50 pips）・豪ドル/ドル（-1.00 pips）",
    notMailed: "2",
  },
  en: {
    from: "1 January 2024, 00:00 UTC",
    to: "10 November 2026, 21:00 UTC",
    sec: "8.155",
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
    baseWhat: BASE_WHAT.en,
    chance: CHANCE.en,
    negPairs: "USD/JPY (-12.50 pips), AUD/USD (-1.00 pips)",
    notMailed: "2",
  },
};
const TP0_PAIRS: Array<[string, string, string]> = [["USD/JPY", "-12.50", "-1.00"], ["EUR/JPY", "+0.00", "+0.00"], ["AUD/JPY", "+3.00", "-2.00"], ["EUR/USD", "+1.23", "+2.00"], ["AUD/USD", "-1.00", "+5.00"]];

const pairSlots = (lang: Lang, rows: Array<[string, string, string]>, pair: string) => {
  const r = rows.find((x) => x[0] === pair) as [string, string, string];
  return { pair: lang === "ja" ? JA_PAIR[pair] : pair, pairMean: r[1], pairBaseMean: r[2] };
};

// every text built here, for the guards
const ALL_TEXTS: Array<[string, string]> = [];
for (const lang of ["ja", "en"] as const) {
  for (const p of PAIRS) ALL_TEXTS.push([`${lang} ${p}`, fadeMeasuredLine(lang, p)]);
  ALL_TEXTS.push([`${lang} notes`, fadeMeasuredNotes(lang)]);
  for (const [name, m] of [["open0", OPEN0], ["tp0", TP0]] as const) {
    ALL_TEXTS.push([`${lang} ${name} USD/JPY`, fadeMeasuredLine(lang, "USD/JPY", m)]);
    ALL_TEXTS.push([`${lang} ${name} notes`, fadeMeasuredNotes(lang, m)]);
  }
}

describe("the measured paragraph (spec 4.5), ja and en, word for word", () => {
  it("the texts above are section 4.5's, as the spec file writes them (its lines joined: ja with nothing between, en with a space)", () => {
    const lines = readFileSync("research/macdfade1h-prod-spec.md", "utf8").split("\n");
    const from = (head: string, end: string, sep: string) => {
      const i = lines.findIndex((l) => l.startsWith(head));
      expect(i, head).toBeGreaterThan(0);
      const out: string[] = [];
      for (const l of lines.slice(i)) {
        out.push(l.trim());
        if (l.trimEnd().endsWith(end)) break;
      }
      return out.join(sep);
    };
    expect(from("ja: 「測った数字", "」", "")).toBe(`ja: 「${SPEC_JA}」`);
    expect(from('en: "Measured', '"', " ")).toBe(`en: "${SPEC_EN}"`);
    const spec = lines.join("\n");
    const flat = (s: string, sep: string) => s.split("\n").map((l) => l.trim()).join(sep);
    expect(flat(spec, "")).toContain(`〔baseWhat〕 「${BASE_WHAT.ja}」`);
    expect(flat(spec, " ")).toContain(`/ "${BASE_WHAT.en}"`);
    expect(flat(spec, "")).toContain(`「${CHANCE.ja}」`);
    expect(flat(spec, " ")).toContain(`en "${CHANCE.en}"`);
  });

  it("a pair's mail, the USD/JPY one written out whole", () => {
    expect(fadeMeasuredLine("ja", "USD/JPY")).toBe(USDJPY_JA);
    expect(fadeMeasuredLine("en", "USD/JPY")).toBe(USDJPY_EN);
  });

  it("every pair's mail: section 4.5's text filled with the table's values", () => {
    for (const lang of ["ja", "en"] as const) {
      const t = specOf(lang, { notes: false, open0: false, tp0: false });
      for (const p of PAIRS) expect(fadeMeasuredLine(lang, p), `${lang} ${p}`).toBe(fill(t, { ...REAL[lang], ...pairSlots(lang, REAL_PAIRS, p) }));
    }
    // the AUD/JPY sentence, as the owner reads it
    expect(fadeMeasuredLine("ja", "AUD/JPY")).toContain("ではありません）。豪ドル/円だけでは平均+4.44 pips（合図なしでは-0.77 pips）です。平均がマイナスだったペア: ドル/円（-0.26 pips）。");
    expect(fadeMeasuredLine("en", "AUD/JPY")).toContain("not a test). On AUD/JPY alone the mean was +4.44 pips (with no signal, -0.77 pips). Pairs whose mean was below zero: USD/JPY (-0.26 pips).");
  });

  it("the notes' version (the five pairs, 4.5's listed changes only), written out and from the spec's text; FADE_MEASURED_NOTES is it", () => {
    expect(fadeMeasuredNotes("ja")).toBe(NOTES_JA);
    expect(fadeMeasuredNotes("en")).toBe(NOTES_EN);
    for (const lang of ["ja", "en"] as const) expect(fadeMeasuredNotes(lang)).toBe(fill(specOf(lang, { notes: true, open0: false, tp0: false, pairs: REAL_PAIRS }), REAL[lang]));
    expect(FADE_MEASURED_NOTES).toEqual({ ja: NOTES_JA, en: NOTES_EN });
    // no pair's own sentence
    expect(NOTES_JA).not.toContain("だけでは平均");
    expect(NOTES_EN).not.toContain(" alone the mean");
    // no 「このメール」 / "this email" in the notes (4.5: the notes' version has no 「このメール」)
    for (const m of [FADE_MEASURED, OPEN0, TP0]) {
      expect(fadeMeasuredNotes("ja", m)).not.toContain("このメール");
      expect(fadeMeasuredNotes("en", m)).not.toMatch(/this email/i);
    }
  });

  it("〔open〕 = 0 (a summary made here): 「…の時点でまだ届いていないものはありませんでした。」 / \"None was still short of it by …\", the unrealised clause gone; times exact and rounded; 〔negPairs〕 none", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(fadeMeasuredLine(lang, "USD/JPY", OPEN0)).toBe(fill(specOf(lang, { notes: false, open0: true, tp0: false }), { ...OPEN0_SLOTS[lang], ...pairSlots(lang, OPEN0_PAIRS, "USD/JPY") }));
      expect(fadeMeasuredNotes(lang, OPEN0)).toBe(fill(specOf(lang, { notes: true, open0: true, tp0: false, pairs: OPEN0_PAIRS }), OPEN0_SLOTS[lang]));
    }
    const ja = fadeMeasuredLine("ja", "USD/JPY", OPEN0);
    expect(ja).toContain("うち12回が+10 pips に届きました。2025年12月31日 23:59（UTC）の時点でまだ届いていないものはありませんでした。1回あたり平均+10.00 pips。途中の含み損は");
    expect(ja).toContain("中央値約45分、10回に1回は3時間より長く、いちばん長いもので2日でした。");
    expect(ja).toContain("平均がマイナスだったペア: ありません。");
    const en = fadeMeasuredLine("en", "USD/JPY", OPEN0);
    expect(en).toContain("of which 12 reached +10 pips. None was still short of it by 31 December 2025, 23:59 UTC. The mean was +10.00 pips a trade. The largest loss");
    expect(en).toContain("median about 45 minutes, longer than 3 hours one time in ten, longest 2 days.");
    expect(en).toContain("Pairs whose mean was below zero: none.");
    for (const t of [ja, en]) expect(t).not.toMatch(/null|undefined|NaN/);
  });

  it("〔tp〕 = 0 (a summary made here): 「+10 pips に届いたものはありませんでした。」 / \"None reached +10 pips.\"; two pairs below zero", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(fadeMeasuredLine(lang, "AUD/USD", TP0)).toBe(fill(specOf(lang, { notes: false, open0: false, tp0: true }), { ...TP0_SLOTS[lang], ...pairSlots(lang, TP0_PAIRS, "AUD/USD") }));
      expect(fadeMeasuredNotes(lang, TP0)).toBe(fill(specOf(lang, { notes: true, open0: false, tp0: true, pairs: TP0_PAIRS }), TP0_SLOTS[lang]));
    }
    const ja = fadeMeasuredLine("ja", "AUD/USD", TP0);
    expect(ja).toContain("いちばん長いもので119分持ったままでした（その後は追っていません）。1回あたり平均-25.50 pips（届いていないものは、その時の含み損益で数えました）。途中の含み損は中央値30.0 pips、最大45.6 pips。+10 pips に届いたものはありませんでした。足の終値で入る");
    expect(ja).toContain("豪ドル/ドルだけでは平均-1.00 pips（合図なしでは+5.00 pips）です。平均がマイナスだったペア: ドル/円（-12.50 pips）・豪ドル/ドル（-1.00 pips）。ほかに2回、");
    const en = fadeMeasuredLine("en", "AUD/USD", TP0);
    expect(en).toContain("the longest held 119 minutes (not followed after that). The mean was -25.50 pips a trade (those not reached counted at their unrealised result then). The largest loss on the way: median 30.0 pips, largest 45.6 pips. None reached +10 pips. The entry is");
    expect(en).toContain("Pairs whose mean was below zero: USD/JPY (-12.50 pips), AUD/USD (-1.00 pips).");
    for (const t of [ja, en]) expect(t).not.toMatch(/null|undefined|NaN/);
  });

  it("not built: no fade trade; a pair not measured (gold); a gap outside the walks' ranges (4.5 writes no sentence for it); a run not on 1-hour bars", () => {
    const none = { ...OPEN0, fade: { ...OPEN0.fade, trades: 0, tp: 0, open: 0 } };
    expect(() => fadeMeasuredLine("ja", "USD/JPY", none)).toThrow(/no fade trade/);
    expect(() => fadeMeasuredNotes("en", none)).toThrow(/no fade trade/);
    expect(() => fadeMeasuredLine("ja", "XAU/USD")).toThrow(/not among the pairs/);
    expect(() => fadeMeasuredLine("en", "GBP/JPY")).toThrow(/not among the pairs/);
    const outside = { ...FADE_MEASURED, baseMean: (FADE_MEASURED.fade.pipsMean as number) - 0.9 };
    expect(() => fadeMeasuredLine("en", "USD/JPY", outside)).toThrow(/not both inside/);
    expect(() => fadeMeasuredNotes("ja", { ...FADE_MEASURED, tf: "15min" })).toThrow(/not 1h/);
    expect(() => fadeMeasuredNotes("ja", { ...FADE_MEASURED, fade: { ...FADE_MEASURED.fade, openPipsSum: null } })).toThrow(/openPipsSum/);
  });

  it("the fields 4.1 and 7.1 require with a count reaching +10: the mean, the open trades, the largest loss on the way, the holding time, no order unfilled, the baseline, the re-read clause", () => {
    for (const [name, t] of ALL_TEXTS) {
      if (name.startsWith("ja")) {
        expect(t, name).toContain("過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。");
        expect(t, name).toContain("1回あたり平均");
        expect(t, name).toMatch(/（マイナスが損）|の時点でまだ届いていないものはありませんでした。/);
        expect(t, name).toContain("途中の含み損は中央値");
        expect(t, name).toMatch(/\+10 pips に届くまでの時間は中央値|\+10 pips に届いたものはありませんでした。/);
        expect(t, name).toContain("入らなかった注文はありません");
        expect(t, name).toContain(`合図なしで${name.endsWith("notes") ? BASE_WHAT_NOTES.ja : BASE_WHAT.ja}入ると`);
        expect(t, name).toContain("（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく1時間足の最初の1分に入ったもので、同じ入りではありません）。");
        expect(t, name).toContain("損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。");
      } else {
        expect(t, name).toContain("It re-reads GMO's past bars;");
        expect(t, name).toContain("The mean was ");
        expect(t, name).toMatch(/\(a minus is a loss\)|None was still short of it by /);
        expect(t, name).toContain("The largest loss on the way: median ");
        expect(t, name).toMatch(/Time to \+10 pips: median |None reached \+10 pips\./);
        expect(t, name).toContain("no order went unfilled");
        expect(t, name).toContain(`entering with no signal ${name.endsWith("notes") ? BASE_WHAT_NOTES.en : BASE_WHAT.en} gave`);
        expect(t, name).toContain("(held the same way, +10 pips and no stop, but entered at the 1-hour bar's first minute, not at its close, so not the same entry).");
        expect(t, name).toContain("With no stop, the share reaching +10 pips comes out high by construction.");
      }
    }
  });

  it("4.1's guards: research/macdfade96-spec.md 6.1's two patterns find nothing; no 「利確の目安」 / \"take-profit level\"", () => {
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
    expect(ALL_TEXTS.length).toBe(2 * (PAIRS.length + 1 + 4));
    for (const [name, t] of ALL_TEXTS) {
      expect(BACK_JA.test(t), name).toBe(false);
      expect(BACK_EN.test(t), name).toBe(false);
      expect(t, name).not.toContain("利確の目安");
      expect(t.toLowerCase(), name).not.toContain("take-profit level");
      expect(t, name).not.toContain("必ず");
    }
  });
});
