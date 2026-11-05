// #318 (docs §8.113 11): stage 0 — counts only. This module and everything it imports hold no follow and no
// outcome (checked in CI: `deno info --json research/chartbest-stage0.ts`).
//
// Per source and half: the counted signals; the weeks holding one; the counts per pair × direction; the reasons
// ①〜④; the both-direction suppressions; the signals whose stratum holds no blind-table bar (SQ-05; both
// layers for the emails); the warm-up date; the share of T in spread-hours.csv's avoid=yes slots (SQ-21);
// per week (÷ W_h, SQ-20); the items' own counts (breedon's missing days and shifted-week signals).
// The floor: 300 counted and 30 weeks in both halves. M_1. The overlap groups (union-find over the
// floor-passing items; forced: the same candidate and the ledger's ⑨). The projections (g from N's summary,
// else 2; df per SQ-18).
// The halves of a signal left out by ①〜④ (which has no half) are by T against SPLIT.

import { seasonOf as spreadSeason, slotOf } from "./spreadhours-lib.ts";
import { type Dir, FLOOR, H2_WEEKS_EXPECTED, type Half, HALVES, ITEM_TABLE, LEDGER_GROUPS, MARK_LINE, PAIRS, type Period, STAGE3_MIN, STAGE3_WEEKS, STEP, dirName } from "./chartbest-const.ts";
import type { RunBars, SourceSigs } from "./chartbest-core.ts";
import { blindBarsOf, blindStrataOf, stratumOf } from "./chartbest-strata.ts";
import { block4, wk } from "./chartbest-time.ts";
import { breedonMissing } from "./chartbest-breedon-lib.ts";
import { tQuantile } from "./money-stats.ts";

export interface HalfCounts {
  counted: number;
  weeks: number;
  byPairDir: Record<string, number>;
  reasons: { r1: number; r2: number; r3: number; r4: number };
  bothSuppressed: number;
  noBlindRows: number;
  noBlindRowsCal: number | null;
  wideShare: number | null;
  perWeek: number | null;
  extra: Record<string, number | string[]>;
}
export interface SourceCounts {
  kind: "item" | "yardstick";
  group: "chart" | "cal" | null;
  // the close T (ms) of the first bar reaching the warm-up, per pair of the source (null: never)
  warmDate: Record<string, number | null>;
  H1: HalfCounts;
  H2: HalfCounts;
  floor: boolean;
}
export interface Projection {
  g: number;
  gGiven: boolean;
  kind: "week" | "4w" | "shift";
  df: number;
  n2: number;
  passMin: number | null;
  size: number | null;
  marks: string[];
  n26: number;
}
export interface Stage0 {
  period: string;
  sources: Record<string, SourceCounts>;
  M1: { chart: number; cal: number };
  floorItems: string[];
  groups: Record<string, string>;
  overlap: Record<string, number>;
  Wh: Record<Half, number>;
  C4: Record<Half, number>;
  projections: Record<string, Projection>;
}
// N's summary per item (20 (e) (4)): g, n1's mean, the SE kind most chosen in the first halves
export type NSummary = Record<string, { g: number; n1: number; kind: "week" | "4w" | "shift" }>;

const halfByT = (T: number, p: Period): Half => (T < p.split ? "H1" : "H2");
const emptyHalf = (): HalfCounts => ({ counted: 0, weeks: 0, byPairDir: {}, reasons: { r1: 0, r2: 0, r3: 0, r4: 0 }, bothSuppressed: 0, noBlindRows: 0, noBlindRowsCal: null, wideShare: null, perWeek: null, extra: {} });

export const pairDirKey = (pi: number, d: Dir): string => `${PAIRS[pi]} ${dirName(d)}`;

export const stage0Of = (rb: RunBars, sources: SourceSigs[], avoid: ReadonlySet<string>, nSummary: NSummary | null, plant = ""): Stage0 => {
  const p = rb.period;
  // the blind table's bars (no outcome): its weeks, its 4-week blocks and its strata
  const rows: Record<Half, number[][]> = { H1: blindBarsOf(rb.bars, rb.holes, "H1", p), H2: blindBarsOf(rb.bars, rb.holes, "H2", p) };
  const Wh = {} as Record<Half, number>;
  const C4 = {} as Record<Half, number>;
  const strata = {} as Record<Half, { chart: Set<number>; cal: Set<number> }>;
  for (const h of HALVES) {
    const weeks = new Set<number>();
    const blocks = new Set<number>();
    rows[h].forEach((ks, pi) => {
      for (const k of ks) {
        const T = rb.bars[pi].t[k] + STEP;
        weeks.add(wk(T));
        blocks.add(block4(T, h, p));
      }
    });
    Wh[h] = weeks.size;
    C4[h] = blocks.size;
    strata[h] = { chart: blindStrataOf(rb.bars, rows[h], "chart", plant), cal: blindStrataOf(rb.bars, rows[h], "cal", plant) };
  }
  const out: Stage0 = { period: p.name, sources: {}, M1: { chart: 0, cal: 0 }, floorItems: [], groups: {}, overlap: {}, Wh, C4, projections: {} };
  const h1Counted = new Map<string, Array<{ pi: number; dir: Dir; T: number }>>();
  for (const s of sources) {
    const layer = s.def ? s.def.group : "chart";
    const halves: Record<Half, HalfCounts> = { H1: emptyHalf(), H2: emptyHalf() };
    const weeks: Record<Half, Set<number>> = { H1: new Set(), H2: new Set() };
    const wide: Record<Half, number> = { H1: 0, H2: 0 };
    for (const r of s.recs) {
      if (r.reason !== "counted") {
        halves[halfByT(r.T, p)].reasons[r.reason]++;
        continue;
      }
      const h = r.half!;
      const hc = halves[h];
      hc.counted++;
      weeks[h].add(wk(r.T));
      const key = pairDirKey(r.pi, r.dir);
      hc.byPairDir[key] = (hc.byPairDir[key] ?? 0) + 1;
      if (!strata[h][layer].has(stratumOf(layer, r.pi, r.dir, r.T, plant))) hc.noBlindRows++;
      if (s.measure) {
        if (!strata[h].cal.has(stratumOf("cal", r.pi, r.dir, r.T, plant))) hc.noBlindRowsCal = (hc.noBlindRowsCal ?? 0) + 1;
        else hc.noBlindRowsCal ??= 0;
      }
      if (avoid.has(`${PAIRS[r.pi]}|${spreadSeason(r.T)}|${slotOf(r.T)}`)) wide[h]++;
      if (h === "H1") {
        const l = h1Counted.get(s.src) ?? [];
        l.push({ pi: r.pi, dir: r.dir, T: r.T });
        h1Counted.set(s.src, l);
      }
    }
    for (const T of s.suppressedT) halves[halfByT(T, p)].bothSuppressed++;
    for (const h of HALVES) {
      const hc = halves[h];
      hc.weeks = weeks[h].size;
      hc.wideShare = hc.counted ? wide[h] / hc.counted : null;
      hc.perWeek = Wh[h] ? hc.counted / Wh[h] : null;
      if (s.measure && hc.noBlindRowsCal === null) hc.noBlindRowsCal = 0;
      // the byPairDir keys: the source's pairs in pair order, BUY first, a zero where nothing was counted
      const ordered: Record<string, number> = {};
      for (let pi = 0; pi < PAIRS.length; pi++) {
        if (s.def && !s.def.pairs.includes(PAIRS[pi])) continue;
        for (const d of [1, -1] as const) {
          const k = pairDirKey(pi, d);
          ordered[k] = hc.byPairDir[k] ?? 0;
        }
      }
      hc.byPairDir = ordered;
    }
    // the items' own counts (18 「数を出す」)
    if (s.src === "breedon-1" || s.src === "breedon-2") {
      const eu = rb.bars[PAIRS.indexOf("EUR/USD")];
      const miss = breedonMissing(eu, s.src === "breedon-1" ? 1 : 2, p);
      for (const h of HALVES) {
        halves[h].extra = {
          missingDays: miss.missing[h].length,
          missingDates: miss.missing[h],
          shiftedWeek: s.recs.filter((r) => r.reason === "counted" && r.half === h && r.marks.includes("shiftedWeek")).length,
        };
      }
    }
    // the warm-up date: the close of the first bar reaching the warm-up, per pair
    const warmDate: Record<string, number | null> = {};
    const warm = s.def ? s.def.warmup : 599;
    for (const pb of rb.bars) {
      if (s.def && !s.def.pairs.includes(pb.pair)) continue;
      warmDate[pb.pair] = warm < pb.n ? pb.t[warm] + STEP : null;
    }
    const floor = floorOf(halves.H1, halves.H2, plant);
    out.sources[s.src] = { kind: s.measure ? "yardstick" : "item", group: s.def ? s.def.group : null, warmDate, H1: halves.H1, H2: halves.H2, floor };
    if (s.def && floor) {
      out.floorItems.push(s.src);
      out.M1[s.def.group]++;
    }
  }
  // the overlap groups (11)
  const floorItems = out.floorItems;
  const share = (a: string, b: string): number => {
    const A = h1Counted.get(a) ?? [];
    const B = h1Counted.get(b) ?? [];
    if (!A.length) return 0;
    const byKey = new Map<string, number[]>();
    for (const x of B) {
      const k = `${x.pi}|${x.dir}`;
      const l = byKey.get(k) ?? [];
      l.push(x.T);
      byKey.set(k, l);
    }
    let hit = 0;
    for (const x of A) {
      const l = byKey.get(`${x.pi}|${x.dir}`);
      if (l && l.some((T) => Math.abs(T - x.T) <= 30 * 60_000)) hit++;
    }
    return hit / A.length;
  };
  for (const a of floorItems) for (const b of floorItems) if (a !== b) out.overlap[`${a}>${b}`] = share(a, b);
  out.groups = groupsOf(floorItems, (a, b) => Math.max(out.overlap[`${a}>${b}`], out.overlap[`${b}>${a}`]));
  // the projections (11)
  for (const id of floorItems) {
    const given = nSummary?.[id];
    const g = given ? given.g : 2;
    const kind = given ? given.kind : "week";
    const C = kind === "4w" ? C4.H2 : Wh.H2;
    const df = C - 1;
    const n2 = out.sources[id].H2.counted;
    const se = n2 > 0 ? 0.47 * Math.sqrt(g / n2) : null;
    const tp = df >= 1 ? tQuantile(1 - 0.025 / 4, df) : Number.NaN;
    const t8 = df >= 1 ? tQuantile(0.80, df) : Number.NaN;
    const passMin = se !== null && Number.isFinite(tp) ? tp * se : null;
    const size = se !== null && Number.isFinite(tp) ? (tp + t8) * se : null;
    // 11's marks: the pass-min and the detectable size at the suspicious line (10 points), stage 3 under 100
    const marks: string[] = [];
    if (passMin !== null && passMin >= MARK_LINE) marks.push("passMin");
    if (size !== null && size >= MARK_LINE) marks.push("size");
    const n26 = (n2 * STAGE3_WEEKS) / H2_WEEKS_EXPECTED;
    if (n26 < STAGE3_MIN) marks.push("n26");
    out.projections[id] = { g, gGiven: Boolean(given), kind, df, n2, passMin, size, marks, n26 };
  }
  return out;
};

// counts.json (plan §4.3; the ledger's chartbest-counts.json): {src: {H1, H2, floor}, M1, groups, overlap, Wh,
// projections}; per half: counted, weeks, byPairDir, reasons, bothSuppressed, noBlindRows {layer: n} (an item
// its own layer, an email both), warmDate {pair: T ms}, wideShare, perWeek, extra; floor null for the emails
export const countsJson = (s0: Stage0): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [src, c] of Object.entries(s0.sources)) {
    const half = (h: HalfCounts) => ({
      counted: h.counted, weeks: h.weeks, byPairDir: h.byPairDir, reasons: h.reasons, bothSuppressed: h.bothSuppressed,
      noBlindRows: c.kind === "item" ? { [c.group!]: h.noBlindRows } : { chart: h.noBlindRows, cal: h.noBlindRowsCal },
      warmDate: c.warmDate, wideShare: h.wideShare, perWeek: h.perWeek, extra: h.extra,
    });
    out[src] = { H1: half(c.H1), H2: half(c.H2), floor: c.kind === "item" ? c.floor : null };
  }
  out.M1 = s0.M1;
  out.groups = s0.groups;
  out.overlap = s0.overlap;
  out.Wh = s0.Wh;
  out.projections = Object.fromEntries(Object.entries(s0.projections).map(([id, pj]) => [id, { g: pj.g, gGiven: pj.gGiven, kind: pj.kind, df: pj.df, passMin: pj.passMin, size: pj.size, marks: pj.marks, n26: pj.n26 }]));
  return out;
};
// the floor-passing items (table order) and the groups, read back from a counts.json (the stage-1 process)
export const floorFromCounts = (c: Record<string, unknown>): { floor: string[]; groups: Record<string, string>; m1: { chart: number; cal: number } } => {
  const floor = ITEM_TABLE.filter((r) => (c[r.id] as { floor?: boolean } | undefined)?.floor === true).map((r) => r.id);
  return { floor, groups: (c.groups ?? {}) as Record<string, string>, m1: (c.M1 ?? { chart: 0, cal: 0 }) as { chart: number; cal: number } };
};

// 11: the floor, both halves (the plant "floorH1Only" looks at the first half alone, which hand.floor must catch)
export const floorOf = (h1: { counted: number; weeks: number }, h2: { counted: number; weeks: number }, plant = ""): boolean => {
  const ok = (h: { counted: number; weeks: number }) => h.counted >= FLOOR.n && h.weeks >= FLOOR.weeks;
  return plant === "floorH1Only" ? ok(h1) : ok(h1) && ok(h2);
};

export interface ItemMeta {
  order: (id: string) => number;
  candidate: (id: string) => string;
  ledgerGroups: ReadonlyArray<readonly string[]>;
}
export const TABLE_META: ItemMeta = {
  order: (id) => ITEM_TABLE.find((r) => r.id === id)!.order,
  candidate: (id) => ITEM_TABLE.find((r) => r.id === id)!.candidate,
  ledgerGroups: LEDGER_GROUPS,
};

// 11: union-find over the floor-passing items: joined when the larger overlap share reaches 0.5, and always
// within a candidate and within a ledger ⑨ group; a group is named by its first item in table order
export const groupsOf = (items: string[], overlapMax: (a: string, b: string) => number, plant = "", meta: ItemMeta = TABLE_META): Record<string, string> => {
  const order = meta.order;
  const sorted = [...items].sort((a, b) => order(a) - order(b));
  const parent = new Map(sorted.map((x) => [x, x]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (order(ra) < order(rb)) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  if (plant !== "ignoreGroups") {
    for (let x = 0; x < sorted.length; x++) {
      for (let y = x + 1; y < sorted.length; y++) {
        const a = sorted[x];
        const b = sorted[y];
        if (meta.candidate(a) === meta.candidate(b) || meta.ledgerGroups.some((g) => g.includes(a) && g.includes(b)) || overlapMax(a, b) >= 0.5) join(a, b);
      }
    }
  }
  const out: Record<string, string> = {};
  for (const x of sorted) out[x] = find(x);
  return out;
};
