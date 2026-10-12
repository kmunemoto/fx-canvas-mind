// #318 (docs §8.113 20 (e)): the made-up sets' pass conditions over the formal seeds' light-run summaries
// (sets-sum → sets-pass.json, n-summary.json), the trial seeds' calibration targets (calib), and the flip check
// (flip-cmp: an original run's dumps against its flipped run's). Pure, except the readers at the end.
//
// Each run's summary.json (research/chartbest-modes.ts summaryOf): the items' first-half Δ, SE (used and the
// wider of week / 4 weeks), t, p, nE, a, Δ_late's t, the suspicious lines, whether chosen, the second half's C1
// and judgment; the blind's direction rows (a, W1); the chosen and confirmed items.

import type { PairBars } from "./chartbest-bars.ts";
import { PAIRS, type Pair, Q_ITEM, SETS, SPEC, START_MID_TICKS, TRACK } from "./chartbest-const.ts";
import { ITEM_CTX } from "./chartbest-core.ts";
import type { ItemDef } from "./chartbest-events.ts";
import { levelsOf } from "./chartbest-follow.ts";

export interface ItemSum {
  floor: boolean;
  H1: { delta: number | null; se: number | null; seKind: string | null; df: number | null; seWide: number | null; t: number | null; p: number | null; nE: number; a: number | null; aSe: number | null; lateT: number | null; suspicious: string[] } | null;
  chosen: boolean;
  H2: { delta: number | null; t: number | null; c1: boolean; judgment: string } | null;
}
export interface RunSum {
  set: string;
  seed: number;
  flip: boolean;
  period: string;
  checksOk: boolean;
  failed: string[];
  stopped: boolean;
  items: Record<string, ItemSum>;
  blind: Record<string, Record<string, { a: number | null; w1: number | null }>>;
  chosen: string[];
  confirmed: string[];
  confirmedChart: string[];
  confirmedCal: string[];
}
export interface Cond {
  ok: boolean;
  value: unknown;
  need: string;
}

const mean = (xs: number[]): number | null => {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
};
const sd = (xs: number[]): number | null => {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
};
// money-stats' median (SQ-30 medianOf): the middle of the sorted values, the mean of the two in the middle
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const nums = (xs: Array<number | null | undefined>): number[] => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
// z of a mean over runs: mean ÷ (SD ÷ √n)
const zOf = (xs: number[]): number | null => {
  const m = mean(xs);
  const s = sd(xs);
  return m === null || s === null || s === 0 ? null : m / (s / Math.sqrt(xs.length));
};

// the floor-passing items of a set's runs (an item passing the floor in any run is examined in every run that has it)
const floorItems = (runs: RunSum[]): string[] => [...new Set(runs.flatMap((r) => Object.entries(r.items).filter(([, x]) => x.floor && x.H1).map(([id]) => id)))].sort();

// ---- N (seeds 101–150) ---------------------------------------------------------------------------------------------
export const condN = (runs: RunSum[]): Record<string, Cond> => {
  const out: Record<string, Cond> = {};
  const confirmedRuns = runs.filter((r) => r.confirmed.length > 0).length;
  out["set.N.1"] = { ok: confirmedRuns <= 4, value: confirmedRuns, need: "runs with any item confirmed ≤ 4" };
  const ids = floorItems(runs);
  const per: Record<string, unknown> = {};
  let worst2 = 0;
  const r4: number[] = [];
  const r5: number[] = [];
  let ok4 = true;
  let ok5 = true;
  let pAll = 0;
  let pLow = 0;
  for (const id of ids) {
    const h1 = runs.map((r) => r.items[id]?.H1).filter((x): x is NonNullable<ItemSum["H1"]> => !!x);
    const t = nums(h1.map((x) => x.t));
    const z = zOf(t);
    if (z !== null) worst2 = Math.max(worst2, Math.abs(z));
    const p = nums(h1.map((x) => x.p));
    pAll += p.length;
    pLow += p.filter((x) => x < 0.025).length;
    const d = nums(h1.map((x) => x.delta));
    const sdD = sd(d);
    const se = mean(nums(h1.map((x) => x.se)));
    const seW = mean(nums(h1.map((x) => x.seWide)));
    const q4 = sdD !== null && se ? sdD / se : null;
    const q5 = sdD !== null && seW ? sdD / seW : null;
    if (q4 !== null) {
      r4.push(q4);
      if (q4 > 1.6) ok4 = false;
    }
    if (q5 !== null) {
      r5.push(q5);
      if (q5 > 1.35) ok5 = false;
    }
    per[id] = { runs: h1.length, zT: z, sdDeltaOverSe: q4, sdDeltaOverSeWide: q5 };
  }
  out["set.N.2"] = { ok: worst2 < 4.0, value: { worstAbsZ: worst2, items: ids.length }, need: "every floor item: |mean t ÷ (SD ÷ √runs)| < 4.0" };
  const share = pAll ? pLow / pAll : null;
  out["set.N.3"] = { ok: share !== null && share <= 0.045, value: { share, low: pLow, all: pAll }, need: "first-half one-sided p < 0.025 in ≤ 4.5% of item × run" };
  const m4 = median(r4);
  out["set.N.4"] = { ok: ok4 && m4 !== null && m4 >= 0.7 && m4 <= 1.15, value: { median: m4, per }, need: "SD(Δ) ÷ mean SE ≤ 1.6 per item, median 0.7–1.15" };
  const m5 = median(r5);
  out["set.N.5"] = { ok: ok5 && m5 !== null && m5 <= 1.15, value: { median: m5 }, need: "SD(Δ) ÷ mean wider(week, 4w) SE ≤ 1.35 per item, median ≤ 1.15" };
  return out;
};
// n-summary.json (11's projection, 20 (e) (4)): g = (mean used SE ÷ (0.47 ÷ √n1))², n1 the mean e-signals, the SE kind most chosen
export const nSummaryOf = (runs: RunSum[]): Record<string, { g: number; n1: number; kind: "week" | "4w" | "shift" }> => {
  const out: Record<string, { g: number; n1: number; kind: "week" | "4w" | "shift" }> = {};
  for (const id of floorItems(runs)) {
    const h1 = runs.map((r) => r.items[id]?.H1).filter((x): x is NonNullable<ItemSum["H1"]> => !!x);
    const n1 = mean(h1.map((x) => x.nE));
    const se = mean(nums(h1.map((x) => x.se)));
    if (n1 === null || se === null || n1 <= 0) continue;
    const kinds = new Map<string, number>();
    for (const x of h1) if (x.seKind) kinds.set(x.seKind, (kinds.get(x.seKind) ?? 0) + 1);
    const order = ["week", "4w", "shift"];
    const kind = ([...kinds.entries()].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0]?.[0] ?? "week") as "week" | "4w" | "shift";
    out[id] = { g: (se / (0.47 / Math.sqrt(n1))) ** 2, n1, kind };
  }
  return out;
};

// ---- D (201–230), H (301–330), E (601–610), E3, Q (701–710) -------------------------------------------------------
export const condD = (runs: RunSum[]): Record<string, Cond> => {
  const confirmedRuns = runs.filter((r) => r.confirmed.length > 0).length;
  const half = SPEC.dToothHalf;
  const blindA = nums(runs.map((r) => r.blind[half]?.BUY?.a));
  const bA = mean(blindA);
  const bSe = sd(blindA) !== null ? sd(blindA)! / Math.sqrt(blindA.length) : null;
  const k1 = nums(runs.map((r) => r.items["breedon-1"]?.H1?.a));
  const kA = mean(k1);
  const kSe = sd(k1) !== null ? sd(k1)! / Math.sqrt(k1.length) : null;
  const k1d = nums(runs.map((r) => r.items["breedon-1"]?.H1?.delta));
  return {
    "set.D.1": { ok: confirmedRuns <= 3, value: confirmedRuns, need: "runs with any item confirmed ≤ 3" },
    "set.D.tooth": {
      ok: bA !== null && bSe !== null && bA > 3 * bSe && kA !== null && kSe !== null && kA < 0 && -kA > 3 * kSe,
      value: { blindBuyA: bA, blindSe: bSe, breedon1A: kA, breedon1Se: kSe, breedon1Delta: mean(k1d), breedon1DeltaZ: zOf(k1d) },
      need: "the blind BUY a > 3 SE (between runs); breedon-1's a < 0 and |a| > 3 SE",
    },
  };
};
export const condH = (runs: RunSum[]): Record<string, Cond> => {
  const chartRuns = runs.filter((r) => r.confirmedChart.length > 0).length;
  const tooth = runs.filter((r) => ["breedon-1", "breedon-2"].some((id) => r.chosen.includes(id) && r.items[id]?.H2?.c1)).length;
  return {
    "set.H.1": { ok: chartRuns <= 3, value: chartRuns, need: "runs with a chart item confirmed ≤ 3" },
    "set.H.2": { ok: tooth >= 20, value: tooth, need: "runs choosing breedon-1 or -2 with C1 in the second half ≥ 20" },
  };
};
export const condE = (runs: RunSum[]): Cond => {
  const n = runs.filter((r) => r.confirmed.includes("donchian-A20")).length;
  return { ok: n >= 6, value: { runs: n, otherGroups: runs.filter((r) => r.confirmed.some((x) => x !== "donchian-A20")).length }, need: "donchian-A20 confirmed in ≥ 6 of 10" };
};
export const condQ = (runs: RunSum[]): Cond => {
  if (Q_ITEM === null) return { ok: false, value: null, need: "Q's item is named in docs with its amount (SQ-12, SQ-28): not yet" };
  const n = runs.filter((r) => r.confirmed.includes(Q_ITEM!)).length;
  return { ok: n <= 1, value: { runs: n, others: runs.filter((r) => r.confirmed.some((x) => x !== Q_ITEM)).length }, need: `${Q_ITEM} confirmed in ≤ 1 run` };
};
// O (801–804), from each run's checks: the cut and the poison of donchian-A20 fail, a suspicious line hits, the
// other checks pass
export const condO = (runs: RunSum[]): Cond => {
  const per = runs.map((r) => {
    const cut = r.failed.some((f) => f.startsWith("lookahead.cut.donchian-A20"));
    const poison = r.failed.some((f) => f.startsWith("lookahead.poison.donchian-A20"));
    const sus = (r.items["donchian-A20"]?.H1?.suspicious.length ?? 0) > 0;
    const others = r.failed.filter((f) => !f.startsWith("lookahead.cut.donchian-A20") && !f.startsWith("lookahead.poison.donchian-A20") && !f.startsWith("lookahead.presence") && f !== "print.items");
    return { seed: r.seed, cut, poison, suspicious: sus, others };
  });
  return { ok: per.length === SETS.O.length && per.every((x) => x.cut && x.poison && x.suspicious && x.others.length === 0), value: per, need: "all 4: the cut and the poison fail, a suspicious line hits, nothing else fails" };
};

// the trial seeds' targets (calib): what each set's amount moves (20 (e) 強さ)
export const calibTargets = (set: string, runs: RunSum[]): Record<string, number | null> => {
  const h1 = (id: string, k: "delta" | "a" | "t" | "lateT") => nums(runs.map((r) => r.items[id]?.H1?.[k]));
  if (set === "D") return { blindBuyA: mean(nums(runs.map((r) => r.blind[SPEC.dToothHalf]?.BUY?.a))) };
  if (set === "H") return { breedon1Delta: mean(h1("breedon-1", "delta")) };
  if (set === "E" || set === "E3") return { donchianA20Delta: mean(h1("donchian-A20", "delta")) };
  if (set === "Q") return { qItemT: mean(h1(SPEC.qItemTrial, "t")), qItemLateT: mean(h1(SPEC.qItemTrial, "lateT")) };
  return {};
};

export const readSums = async (dir: string, set: string, seeds: readonly number[]): Promise<{ runs: RunSum[]; missing: number[] }> => {
  const runs: RunSum[] = [];
  const missing: number[] = [];
  for (const seed of seeds) {
    try {
      runs.push(JSON.parse(await Deno.readTextFile(`${dir}/${set}-${seed}/summary.json`)) as RunSum);
    } catch {
      missing.push(seed);
    }
  }
  return { runs, missing };
};

// ---- the flip (裏返し) -------------------------------------------------------------------------------------------
// The blind table of the flipped run against the original's: the flipped BUY's kind and pips = the original
// SELL's (and the other way), the pips within 1e-9. SQ-02: a row whose E′ is not 2c − E in whole ticks (a spread
// of an odd number of ticks puts the mid on a half tick, rounded up both times) is a "halfTickE" exception, and a
// mismatching row whose path came within pip ÷ 1000 of one of its levels an "exactTouch" exception; both are
// counted and printed, any other mismatch fails. The symmetric items' signals: one to one, the direction reversed.
export interface FlipItem {
  // compared: the original's signals; differ: signals without their reversed twin outside the tie stretches (the
  // 0.1% of 20 (e) is judged on these); tieExcepted: those inside them (SQ-37); onsets / tieOnsets: where the targets
  // stop mirroring, and how many of those bars were ties
  compared: number;
  differ: number;
  tieExcepted: number;
  onsets: number;
  tieOnsets: number;
  share: number;
  examples: string[];
}
export interface FlipOut {
  // exact: the rows compared exactly (neither exception); missing: the halves whose blind dump is absent in either run
  blind: { compared: number; exact: number; halfTickE: number; exactTouch: number; differ: number; missing: string[]; examples: string[] };
  items: Record<string, FlipItem>;
  signalsMissing: boolean;
}

// SQ-37: an always-hold item's target keeps a decision, so one bar decided the other way by the half-tick mids (a tie
// within one tick of the line) changes the signals until the two runs mirror again. The stretches [onset, the bar
// where −s_orig = s_flip again] whose onset is a tie in either run; per pair, as S0 index ranges (inclusive).
export const tieStretches = (def: ItemDef, orig: PairBars[], flip: PairBars[]): { onsets: number; tieOnsets: number; stretches: Map<number, Array<[number, number]>> } => {
  const stretches = new Map<number, Array<[number, number]>>();
  let onsets = 0;
  let tieOnsets = 0;
  for (const po of orig) {
    const pf = flip.find((x) => x.pair === po.pair);
    if (!pf || !def.pairs.includes(po.pair)) continue;
    const so = def.compute(po, ITEM_CTX("")).target;
    const sf = def.compute(pf, ITEM_CTX("")).target;
    if (!so || !sf) continue;
    const list: Array<[number, number]> = [];
    let open = -1;
    let openTie = false;
    const n = Math.min(so.length, sf.length);
    for (let i = 0; i < n; i++) {
      const mirrored = sf[i] === -so[i];
      if (!mirrored && open < 0) {
        open = i;
        onsets++;
        openTie = SPEC.flipItemTies === "tieOnsetExcepted" && !!def.flipTie && (def.flipTie(po, i) || def.flipTie(pf, i));
        if (openTie) tieOnsets++;
      } else if (mirrored && open >= 0) {
        if (openTie) list.push([po.base + open, po.base + i]);
        open = -1;
      }
    }
    if (open >= 0 && openTie) list.push([po.base + open, po.base + n - 1]);
    stretches.set(po.pi, list);
  }
  return { onsets, tieOnsets, stretches };
};
const inStretch = (list: Array<[number, number]> | undefined, i: number): boolean => !!list && list.some(([a, b]) => i >= a && i <= b);
const readCsv = async (path: string): Promise<{ head: string[]; rows: string[][] }> => {
  const lines = (await Deno.readTextFile(path)).split("\n").filter((x) => x.length);
  return { head: lines[0].split(","), rows: lines.slice(1).map((l) => l.split(",")) };
};
// does the follow of a row (bars k + 1 … k + 1440, both sides, O/H/L/C) come within pip ÷ 1000 of a level of
// either direction?
const nearTouch = (pb: PairBars, k: number, E: number): boolean => {
  const lv = [...levelsOf(1, E, pb.unit).tps, levelsOf(1, E, pb.unit).sl, ...levelsOf(-1, E, pb.unit).tps, levelsOf(-1, E, pb.unit).sl];
  const eps = pb.unit / 1000;
  for (let j = k + 1; j <= Math.min(pb.n - 1, k + TRACK); j++) {
    for (const x of [pb.bo[j], pb.bh[j], pb.bl[j], pb.bc[j], pb.ao[j], pb.ah[j], pb.al[j], pb.ac[j]]) {
      if (lv.some((l) => Math.abs(x - l) <= eps)) return true;
    }
  }
  return false;
};
export const flipCompare = async (orig: string, flip: string, origBars: PairBars[], flipBars: PairBars[], symmetric: ItemDef[]): Promise<FlipOut> => {
  const out: FlipOut = { blind: { compared: 0, exact: 0, halfTickE: 0, exactTouch: 0, differ: 0, missing: [], examples: [] }, items: {}, signalsMissing: false };
  for (const h of ["H1", "H2"]) {
    let a: { head: string[]; rows: string[][] };
    let b: { head: string[]; rows: string[][] };
    try {
      a = await readCsv(`${orig}/blind-${h}.csv`);
      b = await readCsv(`${flip}/blind-${h}.csv`);
    } catch {
      // a half not dumped in either run is not a pass: the check fails on it (mode_flip_cmp)
      out.blind.missing.push(h);
      continue;
    }
    const ia = (c: string) => a.head.indexOf(c);
    const ib = (c: string) => b.head.indexOf(c);
    const mb = new Map(b.rows.map((r) => [`${r[ib("pair")]}|${r[ib("T")]}`, r]));
    for (const r of a.rows) {
      const pair = r[ia("pair")] as Pair;
      const key = `${pair}|${r[ia("T")]}`;
      const s = mb.get(key);
      out.blind.compared++;
      if (!s) {
        out.blind.differ++;
        if (out.blind.examples.length < 5) out.blind.examples.push(`${h} ${key}: row missing`);
        continue;
      }
      const d = pair.includes("JPY") ? 3 : 5;
      const eA = Math.round(Number(r[ia("E")]) * 10 ** d);
      const eB = Math.round(Number(s[ib("E")]) * 10 ** d);
      // SQ-02: a half-tick mid rounds up in both runs, so E′ misses 2c − E by exactly one tick; any other miss differs
      const off = eB - (2 * START_MID_TICKS[pair] - eA);
      if (Math.abs(off) === 1) {
        out.blind.halfTickE++;
        continue;
      }
      if (off !== 0) {
        out.blind.differ++;
        if (out.blind.examples.length < 5) out.blind.examples.push(`${h} ${key}: E off by ${off} ticks`);
        continue;
      }
      const bad: string[] = [];
      for (const tp of ["4", "10"]) {
        for (const [x, y] of [[`s${tp}`, `b${tp}`], [`b${tp}`, `s${tp}`]]) {
          if (r[ia(`${x}k`)] !== s[ib(`${y}k`)]) bad.push(`${x}k`);
          if (!(Math.abs(Number(r[ia(`${x}p`)]) - Number(s[ib(`${y}p`)])) <= 1e-9)) bad.push(`${x}p`);
        }
      }
      if (!bad.length) {
        out.blind.exact++;
        continue;
      }
      const pb = origBars[PAIRS.indexOf(pair)];
      if (pb && nearTouch(pb, Number(r[ia("k")]), Number(r[ia("E")]))) {
        out.blind.exactTouch++;
        continue;
      }
      out.blind.differ++;
      if (out.blind.examples.length < 5) out.blind.examples.push(`${h} ${key}: ${bad.join(";")}`);
    }
  }
  try {
    const a = await readCsv(`${orig}/signals.csv`);
    const b = await readCsv(`${flip}/signals.csv`);
    const ia = (c: string) => a.head.indexOf(c);
    const ib = (c: string) => b.head.indexOf(c);
    for (const def of symmetric) {
      const id = def.id;
      const { onsets, tieOnsets, stretches } = tieStretches(def, origBars, flipBars);
      // signal → direction, keyed by pair and S0 index, in each run
      const keyed = (rows: string[][], ix: (c: string) => number) => new Map(rows.filter((r) => r[ix("src")] === id).map((r) => [`${r[ix("pair")]}|${r[ix("i")]}`, r[ix("dir")]]));
      const ma = keyed(a.rows, ia);
      const mb = keyed(b.rows, ib);
      const x: FlipItem = { compared: ma.size, differ: 0, tieExcepted: 0, onsets, tieOnsets, share: 0, examples: [] };
      const unmatched = (key: string) => {
        const [pair, i] = key.split("|");
        if (inStretch(stretches.get(PAIRS.indexOf(pair as Pair)), Number(i))) x.tieExcepted++;
        else {
          x.differ++;
          if (x.examples.length < 5) x.examples.push(key);
        }
      };
      for (const [key, dir] of ma) if (mb.get(key) !== (dir === "BUY" ? "SELL" : "BUY")) unmatched(key);
      for (const key of mb.keys()) if (!ma.has(key)) unmatched(key);
      x.share = x.compared ? x.differ / x.compared : 0;
      out.items[id] = x;
    }
  } catch {
    // no signals dump in either run: every symmetric item fails (mode_flip_cmp)
    out.signalsMissing = true;
  }
  return out;
};
