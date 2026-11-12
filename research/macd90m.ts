// The owner (2026-11-11), after docs §8.147 (research/macd90.ts: the line judged at each 1-hour bar's close):
// 「足の確定ではなく、96%に到達した瞬間があればいい」. The same trades, but the line counts as at 96% the first minute it
// gets there while a bar forms (the minute's high or low as the forming bar's close), and a second way in: the first
// minute the line touches 90%. The rule and the output: research/macd90m-spec.md (on research/macd90-spec.md).
//
//   MODE=real       GMO's 1-hour and 1-minute files: research/.cache, fetched when missing. Writes OUT/{rows.csv,
//                   summary.json}.
//   MODE=synthetic  seeded walks in memory and the checks: the line at a minute from the prepared state against zoneAt
//                   on the window rebuilt; the close entries against research/macd90.ts's; the look-ahead check (every
//                   price after the entry moment, or after a way's moment out, moved by ±300 pips: the entry and that
//                   way stay); the counts add up; way A reached means way B reached at the same moment.
//   MODE=walkfiles  the walk of SEEDS' first seed written as GMO's files under OUT/gmo, read back through the real
//                   run's loaders, the study written to OUT: what research/macd90m-check.py is run on first.
//   MODE=print      the summary the real run wrote.
//
// Nothing here changes an email; the numbers are the study's only.

import { LEVEL_WINDOW, ZONE_BARS, zoneAt } from "../supabase/functions/_shared/macd-level.ts";
import { macd, MACD_DEFAULTS } from "../supabase/functions/_shared/macd.ts";
import { pineEma } from "../supabase/functions/_shared/pine.ts";
import { type LoadStats, loadM1, type M1, newLoadStats, type Source, synthesize, writeGmoFiles } from "./ownerhold-data.ts";
import { loadTf, quotesOf, ruleKeyOf, writeWalk } from "./trend-data.ts";
import { emptyBars, fromQuotes, weekendOutOf } from "./trend-labels.ts";
import { lowerBound } from "./money-data.ts";
import { mean, median } from "./flowz-lib.ts";
import { HOUR, MINUTE } from "./lib.ts";
import {
  atShare,
  coarsen,
  dataOf,
  decimalsOf,
  ENTER,
  iso,
  P,
  type PairData,
  PAIRS,
  poisoned,
  REACH,
  type Result,
  type Side,
  shareOf,
  tradesOf,
  type Zone,
  zonesOf,
} from "./macd90.ts";

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-11-10T21:00:00Z"));
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-10-01T00:00:00Z"));
const OUT = env("OUT", "research/out/macd90m");
const W = LEVEL_WINDOW;
const A12 = 2 / (MACD_DEFAULTS.fast + 1);
const A26 = 2 / (MACD_DEFAULTS.slow + 1);
const A9 = 2 / (MACD_DEFAULTS.signal + 1);

type Way = "close" | "moment";

// ---- the line while a bar forms ----------------------------------------------------------------------

// bar j's window read once: the EMAs and the signal at index 598, and the pane's edges over 480..598
interface Prepared {
  f12: number;
  s26: number;
  sig: number;
  top119: number;
  bottom119: number;
}

const prepare = (d: PairData, j: number): Prepared => {
  const closes = d.mid.slice(j - W + 1, j + 1);
  const r = macd(closes);
  const f = pineEma(closes, MACD_DEFAULTS.fast);
  const s = pineEma(closes, MACD_DEFAULTS.slow);
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

// the line at index 599 with x as the forming bar's close
const liveZone = (p: Prepared, x: number): Zone => {
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

// the same, as zoneAt reads the window rebuilt (the check)
const slowZone = (d: PairData, j: number, x: number): Zone => {
  const closes = d.mid.slice(j - W + 1, j + 1);
  closes[W - 1] = x;
  const z = zoneAt(macd(closes), W - 1);
  if (!z) throw new Error(`${d.pair} ${iso(d.t[j])}: no zone on the window rebuilt`);
  return { m: z.m, top: z.top, bottom: z.bottom };
};

// ---- one pair ---------------------------------------------------------------------------------------

interface PairAll {
  d: PairData;
  m1: M1;
  z: Array<Zone | null>;
  zp: Array<Zone | null>;
  prep: Array<Prepared | null>;
  // the first 1-minute bar of each 1-hour bar (lowerBound of its open)
  k0: number[];
  dec: number;
}

const pairAllOf = (d: PairData, m1: M1): PairAll => {
  const { z, zp } = zonesOf(d);
  const prep: Array<Prepared | null> = new Array(d.n).fill(null);
  for (let j = W - 1; j < d.n; j++) prep[j] = prepare(d, j);
  const k0 = d.t.map((t) => lowerBound(m1.t, t));
  return { d, m1, z, zp, prep, k0, dec: decimalsOf(d.pair) };
};

// the minute's price toward a side, rounded as the chart's
const hiOf = (a: PairAll, k: number) => Number(((a.m1.bh[k] + a.m1.ah[k]) / 2).toFixed(a.dec));
const loOf = (a: PairAll, k: number) => Number(((a.m1.bl[k] + a.m1.al[k]) / 2).toFixed(a.dec));
const towardOf = (a: PairAll, k: number, zs: Side) => (zs === "top" ? hiOf(a, k) : loOf(a, k));

// the 1-minute bars of 1-hour bar j: [k0[j], end)
const minutesOf = (a: PairAll, j: number): [number, number] => {
  const from = a.k0[j];
  const end = lowerBound(a.m1.t, a.d.t[j] + HOUR);
  return [from, end];
};

interface WayOut {
  result: Result;
  T: number;
  exit: number;
  pips: number;
  mae: number;
  minutes: number;
  share: number;
}
interface MTrade {
  way: Way;
  pair: string;
  i: number;
  open: number;
  T0: number;
  side: "BUY" | "SELL";
  zside: Side;
  entry: number;
  share0: number;
  already: boolean;
  // the first 1-minute bar followed, the first 1-hour bar whose close is judged; the entry minute (moment), for the checks
  kFrom: number;
  jFrom: number;
  kEntry: number;
  A: WayOut | null;
  B: WayOut | null;
  // way C (held until it gets there; the owner 2026-11-12): null when already or skipped
  C: WayOut | null;
  cSkipped: boolean;
}

// a touch read at minute k: the line there with the minute's price toward the side (and that price)
const touchAt = (a: PairAll, j: number, k: number, zs: Side): { z: Zone; x: number } => {
  const x = towardOf(a, k, zs);
  return { z: liveZone(a.prep[j] as Prepared, x), x };
};

const follow = (a: PairAll, tr: MTrade, way: "A" | "B" | "C", seen?: Array<{ j: number; k: number; x: number; z: Zone }>): WayOut => {
  const { d, m1, dec } = a;
  const pe = P(tr.entry, dec);
  let worst = 0;
  const done = (result: Result, T: number, exit: number, share: number): WayOut => {
    const pts = tr.side === "BUY" ? P(exit, dec) - pe : pe - P(exit, dec);
    return { result, T, exit, pips: pts / 10, mae: worst / 10, minutes: (T - tr.T0) / MINUTE, share };
  };
  const against = (k: number) => {
    const adv = tr.side === "BUY" ? pe - P(m1.bl[k], dec) : P(m1.ah[k], dec) - pe;
    if (adv > worst) worst = adv;
  };
  // every 1-minute bar after the entry's counts for mae, also one in no 1-hour bar (read for no touch)
  let kp = tr.kFrom;
  for (let j = tr.jFrom; j < d.n; j++) {
    const [from, end] = minutesOf(a, j);
    for (; kp < from; kp++) against(kp);
    for (let k = Math.max(from, kp); k < end; k++, kp = k) {
      against(k);
      const t = touchAt(a, j, k, tr.zside);
      if (seen) seen.push({ j, k, x: t.x, z: t.z });
      if (atShare(t.z, tr.zside, REACH)) return done("reached", m1.t[k] + MINUTE, tr.side === "BUY" ? m1.bc[k] : m1.ac[k], shareOf(t.z, tr.zside));
    }
    const zj = a.z[j];
    if (zj === null) throw new Error(`${d.pair} ${iso(d.t[j])}: no zone on a followed bar`);
    // way C has no failure: held until it is reached
    const failed = way === "C" ? false : way === "A" ? !atShare(zj, tr.zside, ENTER) : tr.zside === "top" ? zj.m <= 0 : zj.m >= 0;
    if (failed) return done("failed", d.t[j] + HOUR, tr.side === "BUY" ? d.bc[j] : d.ac[j], shareOf(zj, tr.zside));
  }
  const last = d.n - 1;
  return done("open", d.t[last] + HOUR, tr.side === "BUY" ? d.bc[last] : d.ac[last], shareOf(a.z[last] as Zone, tr.zside));
};

const tradesOfPair = (a: PairAll, seen?: Array<{ j: number; k: number; x: number; z: Zone }>): MTrade[] => {
  const { d, m1 } = a;
  const out: MTrade[] = [];
  // close: research/macd90.ts's entries, followed from the first minute of bar i + 1
  for (const t of tradesOf(d).trades) {
    const tr: MTrade = {
      way: "close",
      pair: d.pair,
      i: t.i,
      open: t.open,
      T0: t.T,
      side: t.side,
      zside: t.zside,
      entry: t.entry,
      share0: t.share0,
      already: t.already,
      kFrom: t.i + 1 < d.n ? a.k0[t.i + 1] : m1.n,
      jFrom: t.i + 1,
      kEntry: -1,
      A: null,
      B: null,
      C: null,
      cSkipped: false,
    };
    out.push(tr);
  }
  // moment: the first minute of bar i that touches 90% on a side the bar before was not at
  for (let i = W - 1; i < d.n; i++) {
    const T = d.t[i] + HOUR;
    if (T < START || T >= END) continue;
    const zp = a.zp[i];
    if (zp === null) continue;
    const [from, end] = minutesOf(a, i);
    for (let k = from; k < end; k++) {
      let hit: { zs: Side; z: Zone; x: number } | null = null;
      for (const zs of ["top", "bottom"] as Side[]) {
        if (hit || atShare(zp, zs, ENTER)) continue;
        const t = touchAt(a, i, k, zs);
        if (seen) seen.push({ j: i, k, x: t.x, z: t.z });
        if (atShare(t.z, zs, ENTER)) hit = { zs, z: t.z, x: t.x };
      }
      if (!hit) continue;
      const side = hit.zs === "top" ? "BUY" : "SELL";
      out.push({
        way: "moment",
        pair: d.pair,
        i,
        open: d.t[i],
        T0: m1.t[k] + MINUTE,
        side,
        zside: hit.zs,
        entry: side === "BUY" ? m1.ac[k] : m1.bc[k],
        share0: shareOf(hit.z, hit.zs),
        already: atShare(hit.z, hit.zs, REACH),
        kFrom: k + 1,
        jFrom: i,
        kEntry: k,
        A: null,
        B: null,
        C: null,
        cSkipped: false,
      });
      break;
    }
  }
  for (const tr of out) {
    if (tr.already) continue;
    tr.A = follow(a, tr, "A", seen);
    tr.B = follow(a, tr, "B");
  }
  // way C: within a way in and a side, the entries in time order (out holds each way's in time order); an entry
  // before the last taken one's moment out (or while it is open) is skipped
  const heldTo = new Map<string, number>();
  for (const tr of out) {
    if (tr.already) continue;
    const key = `${tr.way}|${tr.zside}`;
    const until = heldTo.get(key);
    if (until !== undefined && tr.T0 < until) {
      tr.cSkipped = true;
      continue;
    }
    tr.C = follow(a, tr, "C");
    heldTo.set(key, tr.C.result === "open" ? Infinity : tr.C.T);
  }
  return out;
};

// ---- the numbers --------------------------------------------------------------------------------------

const wayStats = (ws: WayOut[]) => {
  const dec = ws.filter((w) => w.result !== "open");
  const reached = ws.filter((w) => w.result === "reached");
  const failed = ws.filter((w) => w.result === "failed");
  const open = ws.filter((w) => w.result === "open");
  let pipsSum = 0;
  for (const w of dec) pipsSum += w.pips;
  let openPipsSum = 0;
  for (const w of open) openPipsSum += w.pips;
  return {
    reached: reached.length,
    failed: failed.length,
    open: open.length,
    rate: dec.length ? (100 * reached.length) / dec.length : null,
    pipsSum: dec.length ? pipsSum : null,
    pipsMean: mean(dec.map((w) => w.pips)),
    pipsMedian: median(dec.map((w) => w.pips)),
    reachedPipsMean: mean(reached.map((w) => w.pips)),
    failedPipsMean: mean(failed.map((w) => w.pips)),
    maeMedian: median(dec.map((w) => w.mae)),
    maeMax: dec.length ? Math.max(...dec.map((w) => w.mae)) : null,
    minutesMedian: median(dec.map((w) => w.minutes)),
    minutesMax: dec.length ? Math.max(...dec.map((w) => w.minutes)) : null,
    openPipsSum: open.length ? openPipsSum : null,
    openPipsWorst: open.length ? Math.min(...open.map((w) => w.pips)) : null,
  };
};
type WayStats = ReturnType<typeof wayStats>;

// the value at rank ceil(0.9 n) of the values in ascending order
const p90 = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((9 * s.length + 9) / 10) - 1];
};
const cStats = (ts: MTrade[]) => {
  const taken = ts.filter((t) => t.C !== null).map((t) => t.C as WayOut);
  const reached = taken.filter((w) => w.result === "reached");
  const open = taken.filter((w) => w.result === "open");
  let pipsSum = 0;
  for (const w of reached) pipsSum += w.pips;
  let openPipsSum = 0;
  for (const w of open) openPipsSum += w.pips;
  const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  return {
    reached: reached.length,
    open: open.length,
    skipped: ts.filter((t) => t.cSkipped).length,
    plus: reached.filter((w) => w.pips > 0).length,
    minus: reached.filter((w) => w.pips < 0).length,
    pipsSum: reached.length ? pipsSum : null,
    pipsMean: mean(reached.map((w) => w.pips)),
    pipsMedian: median(reached.map((w) => w.pips)),
    pipsMin: reached.length ? Math.min(...reached.map((w) => w.pips)) : null,
    maeMedian: median(reached.map((w) => w.mae)),
    maeP90: p90(reached.map((w) => w.mae)),
    maeMax: maxOf(reached.map((w) => w.mae)),
    minutesMedian: median(reached.map((w) => w.minutes)),
    minutesP90: p90(reached.map((w) => w.minutes)),
    minutesMax: maxOf(reached.map((w) => w.minutes)),
    within60: reached.filter((w) => w.minutes <= 60).length,
    within1440: reached.filter((w) => w.minutes <= 1440).length,
    within10080: reached.filter((w) => w.minutes <= 10080).length,
    openPipsSum: open.length ? openPipsSum : null,
    openPipsWorst: open.length ? Math.min(...open.map((w) => w.pips)) : null,
    openMaeMax: maxOf(open.map((w) => w.mae)),
    openMinutesMax: maxOf(open.map((w) => w.minutes)),
  };
};
type CStats = ReturnType<typeof cStats>;

const groupOf = (ts: MTrade[]) => ({
  entries: ts.length,
  already: ts.filter((t) => t.already).length,
  A: wayStats(ts.filter((t) => !t.already).map((t) => t.A as WayOut)),
  B: wayStats(ts.filter((t) => !t.already).map((t) => t.B as WayOut)),
  C: cStats(ts.filter((t) => !t.already)),
});
type Group = ReturnType<typeof groupOf>;

const groupsOf = (ts: MTrade[]) => {
  const g: Record<string, Group> = { all: groupOf(ts) };
  for (const p of PAIRS) g[p] = groupOf(ts.filter((t) => t.pair === p));
  for (const s of ["BUY", "SELL"]) g[s] = groupOf(ts.filter((t) => t.side === s));
  return g;
};

const wayOrder = (w: Way) => (w === "close" ? 0 : 1);
const ordered = (all: MTrade[]): MTrade[] =>
  [...all].sort((a, b) => a.T0 - b.T0 || PAIRS.indexOf(a.pair as typeof PAIRS[number]) - PAIRS.indexOf(b.pair as typeof PAIRS[number]) || wayOrder(a.way) - wayOrder(b.way));

const summaryOf = (trades: MTrade[], as: PairAll[]) => ({
  meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM) },
  pairs: as.map((a) => ({
    pair: a.d.pair,
    bars: a.d.n,
    minutes: a.m1.n,
    close: trades.filter((t) => t.pair === a.d.pair && t.way === "close").length,
    moment: trades.filter((t) => t.pair === a.d.pair && t.way === "moment").length,
  })),
  ways: { close: groupsOf(trades.filter((t) => t.way === "close")), moment: groupsOf(trades.filter((t) => t.way === "moment")) },
});

const HEAD = ["way", "pair", "open", "T0", "side", "entry", "share0", "already", "A_result", "A_T", "A_exit", "A_pips", "A_mae", "A_minutes", "A_share", "B_result", "B_T", "B_exit", "B_pips", "B_mae", "B_minutes", "B_share", "C_result", "C_T", "C_exit", "C_pips", "C_mae", "C_minutes", "C_share"];
const wayCells = (w: WayOut | null) => (w ? [w.result, iso(w.T), String(w.exit), String(w.pips), String(w.mae), String(w.minutes), String(w.share)] : ["", "", "", "", "", "", ""]);
const csvOf = (ts: MTrade[]): string =>
  [HEAD.join(","), ...ts.map((t) => [t.way, t.pair, iso(t.open), iso(t.T0), t.side, String(t.entry), String(t.share0), t.already ? "1" : "0", ...wayCells(t.A), ...wayCells(t.B), ...(t.cSkipped ? ["skipped", "", "", "", "", "", ""] : wayCells(t.C))].join(","))].join("\n") + "\n";

const fmt = (v: number | null, k = 2) => (v === null ? "-" : v.toFixed(k));
const printWay = (name: string, w: WayStats) =>
  `${name}: reached ${w.reached} failed ${w.failed} open ${w.open} rate ${fmt(w.rate, 1)}% | pips sum ${fmt(w.pipsSum, 1)} mean ${fmt(w.pipsMean)} median ${fmt(w.pipsMedian)} (reached ${fmt(w.reachedPipsMean)}, failed ${fmt(w.failedPipsMean)}) | mae median ${fmt(w.maeMedian, 1)} max ${fmt(w.maeMax, 1)} | minutes median ${fmt(w.minutesMedian, 0)} max ${fmt(w.minutesMax, 0)} | open pips sum ${fmt(w.openPipsSum, 1)} worst ${fmt(w.openPipsWorst, 1)}`;
const printC = (c: CStats) =>
  `C (held until reached): reached ${c.reached} (plus ${c.plus}, minus ${c.minus}) open ${c.open} skipped ${c.skipped} | pips sum ${fmt(c.pipsSum, 1)} mean ${fmt(c.pipsMean)} median ${fmt(c.pipsMedian)} min ${fmt(c.pipsMin, 1)} | mae median ${fmt(c.maeMedian, 1)} p90 ${fmt(c.maeP90, 1)} max ${fmt(c.maeMax, 1)} | minutes median ${fmt(c.minutesMedian, 0)} p90 ${fmt(c.minutesP90, 0)} max ${fmt(c.minutesMax, 0)} | within 1h ${c.within60} 1d ${c.within1440} 1w ${c.within10080} | open pips sum ${fmt(c.openPipsSum, 1)} worst ${fmt(c.openPipsWorst, 1)} mae max ${fmt(c.openMaeMax, 1)} minutes max ${fmt(c.openMinutesMax, 0)}`;
const printSummary = (s: ReturnType<typeof summaryOf>) => {
  console.log(`meta ${JSON.stringify(s.meta)}`);
  console.log(`pairs ${JSON.stringify(s.pairs)}`);
  for (const way of ["close", "moment"] as Way[]) {
    console.log(`== in at the ${way === "close" ? "bar's close" : "moment the line touches 90%"}`);
    for (const [k, g] of Object.entries(s.ways[way])) {
      console.log(`${k.padEnd(8)} entries ${g.entries} already ${g.already}`);
      console.log(`  ${printWay("A (the band)", g.A)}`);
      console.log(`  ${printWay("B (zero line)", g.B)}`);
      console.log(`  ${printC(g.C)}`);
    }
  }
};

// ---- loading ------------------------------------------------------------------------------------------

const loadFiles = async (src: Source): Promise<{ as: PairAll[]; st: LoadStats }> => {
  const st = newLoadStats();
  const as: PairAll[] = [];
  const weekend = weekendOutOf("inside");
  for (const pair of PAIRS) {
    const h = await loadTf(src, pair, "1h", LOAD_FROM, END, st, weekend);
    const d = dataOf(pair, quotesOf(h.bars));
    const m1 = await loadM1(src, pair, START, END, st);
    as.push(pairAllOf(d, m1));
    console.log(`${pair}: 1h ${h.bars.n} chart ${d.n} (from ${d.n ? iso(d.t[0]) : "-"}), 1min ${m1.n}`);
  }
  return { as, st };
};

const walkOf = (seed: number, pair: string) => synthesize(pair, PAIRS.indexOf(pair as typeof PAIRS[number]), { seed, trend: 0, startPips: null }, LOAD_FROM, END);

// the walk's 1-minute bars from START on (as loadM1 reads them), the 1-hour bars from all of it
const fromStart = (m: M1): M1 => {
  const k = lowerBound(m.t, START);
  const cut = (xs: Float64Array) => xs.slice(k);
  return { ...m, n: m.n - k, t: cut(m.t), bo: cut(m.bo), bh: cut(m.bh), bl: cut(m.bl), bc: cut(m.bc), ao: cut(m.ao), ah: cut(m.ah), al: cut(m.al), ac: cut(m.ac) };
};
const synthAll = (pair: string, m: M1): PairAll => pairAllOf(dataOf(pair, coarsen(m, HOUR)), fromStart(m));

const writeWalkFiles = async (dir: string, seed: number) => {
  for (const pair of PAIRS) {
    const w = walkOf(seed, pair);
    const q = coarsen(w.m1, HOUR);
    await writeWalk(dir, pair, { "5min": emptyBars(0), "15min": emptyBars(0), "1h": fromQuotes(q, (t) => ruleKeyOf("1h", t)), "4h": emptyBars(0) }, LOAD_FROM, END);
    await writeGmoFiles(dir, pair, { m1: w.m1, q15: w.q15 }, LOAD_FROM, END);
  }
};

// ---- the checks on the walk ----------------------------------------------------------------------------

const sameZone = (a: Zone, b: Zone) => a.m === b.m && a.top === b.top && a.bottom === b.bottom;
const sameWay = (a: WayOut | null, b: WayOut | null) =>
  a === null || b === null ? a === b : a.result === b.result && a.T === b.T && a.pips === b.pips && a.mae === b.mae && a.share === b.share;

const checkWalk = (seed: number): number => {
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    if (fail <= 30) console.log(`  CHECK FAILED: ${msg}`);
  };
  const all: MTrade[] = [];
  let zonesCompared = 0;
  let lookahead = 0;
  for (const pair of PAIRS) {
    const m = walkOf(seed, pair).m1;
    const a = synthAll(pair, m);
    const seen: Array<{ j: number; k: number; x: number; z: Zone }> = [];
    const trades = tradesOfPair(a, seen);
    all.push(...trades);
    // the line at a minute against zoneAt on the window rebuilt: every entry's and touch's minute, and a sample
    const entryK = new Set(trades.map((t) => t.kEntry));
    const reachT = new Set(trades.flatMap((t) => (t.A && t.A.result === "reached" ? [t.A.T] : [])));
    for (let q = 0; q < seen.length; q++) {
      const s = seen[q];
      const isEvent = entryK.has(s.k) || reachT.has(a.m1.t[s.k] + MINUTE);
      if (!isEvent && q % 53 !== 0) continue;
      zonesCompared++;
      if (!sameZone(s.z, slowZone(a.d, s.j, s.x))) bad(`${pair} ${iso(a.m1.t[s.k])}: the line at the minute differs from zoneAt on the window rebuilt`);
    }
    // the close entries are research/macd90.ts's
    const mine = trades.filter((t) => t.way === "close").map((t) => `${t.i} ${t.side} ${t.entry} ${t.already}`).join("|");
    const theirs = tradesOf(a.d).trades.map((t) => `${t.i} ${t.side} ${t.entry} ${t.already}`).join("|");
    if (mine !== theirs) bad(`${pair}: the close entries differ from research/macd90.ts's`);
    for (const t of trades) {
      if (t.already !== (t.A === null && t.B === null)) bad(`${pair} ${iso(t.T0)}: already and the ways disagree`);
      if (t.A && t.B && t.A.result === "reached" && !(t.B.result === "reached" && t.B.T === t.A.T)) bad(`${pair} ${iso(t.T0)} ${t.way}: A reached but B not at the same moment`);
      // way C: taken or skipped but not both; reached with A reached is A's trade; never out before A or B
      if (!t.already && (t.C === null) !== t.cSkipped) bad(`${pair} ${iso(t.T0)} ${t.way}: C neither taken nor skipped (or both)`);
      if (t.C && t.A && t.A.result === "reached" && !(t.C.result === "reached" && t.C.T === t.A.T && t.C.pips === t.A.pips && t.C.mae === t.A.mae)) bad(`${pair} ${iso(t.T0)} ${t.way}: C differs from a reached A`);
      if (t.C && t.A && t.B && (t.C.T < t.A.T || t.C.T < t.B.T)) bad(`${pair} ${iso(t.T0)} ${t.way}: C out before A or B`);
      if (t.share0 < ENTER) bad(`${pair} ${iso(t.T0)} ${t.way}: share0 ${t.share0} under 90%`);
    }
    // no two taken C trades of one way in and side overlap
    for (const way of ["close", "moment"] as Way[]) {
      for (const zs of ["top", "bottom"] as Side[]) {
        let until = -Infinity;
        for (const t of trades.filter((x) => x.way === way && x.zside === zs && x.C !== null)) {
          if (t.T0 < until) bad(`${pair} ${iso(t.T0)} ${way}: a C trade taken while another was held`);
          until = (t.C as WayOut).result === "open" ? Infinity : (t.C as WayOut).T;
        }
      }
    }
    // the look-ahead check on a sample of each way in
    for (const way of ["close", "moment"] as Way[]) {
      const sample = trades.filter((t) => t.way === way && !t.already && t.A && t.A.result !== "open").filter((_, k) => k % 7 === 0).slice(0, 4);
      for (const t of sample) {
        for (const pips of [300, -300]) {
          const cuts: Array<[number, (u: MTrade) => boolean]> = [
            [t.T0, (u) => u.side === t.side && u.entry === t.entry && u.share0 === t.share0 && u.already === t.already],
            [(t.A as WayOut).T, (u) => sameWay(u.A, t.A)],
            [(t.B as WayOut).T, (u) => (t.B as WayOut).result === "open" || sameWay(u.B, t.B)],
            [t.C && t.C.result !== "open" ? t.C.T : END, (u) => u.cSkipped === t.cSkipped && (t.C === null || t.C.result === "open" || sameWay(u.C, t.C))],
          ];
          for (const [cut, same] of cuts) {
            const again = tradesOfPair(synthAll(pair, poisoned(m, cut, pips))).find((u) => u.way === way && u.T0 === t.T0);
            lookahead++;
            if (!again) bad(`${pair} ${iso(t.T0)} ${way}: the entry went when the future after ${iso(cut)} moved ${pips}`);
            else if (!same(again)) bad(`${pair} ${iso(t.T0)} ${way}: changed when the future after ${iso(cut)} moved ${pips}`);
          }
        }
      }
    }
  }
  const s = summaryOf(ordered(all), []);
  for (const way of ["close", "moment"] as Way[]) {
    for (const [k, g] of Object.entries(s.ways[way])) {
      for (const w of [g.A, g.B]) if (w.reached + w.failed + w.open + g.already !== g.entries) bad(`${way} ${k}: the counts do not add up`);
      if (g.C.reached + g.C.open + g.C.skipped + g.already !== g.entries || g.C.plus + g.C.minus > g.C.reached) bad(`${way} ${k}: the C counts do not add up`);
    }
    const g = s.ways[way].all;
    if (g.A.reached === 0 || g.A.failed === 0) bad(`${way}: the walk has no reached or no failed trade`);
    console.log(`walk seed ${seed} ${way}: entries ${g.entries} already ${g.already}`);
    console.log(`  ${printWay("A", g.A)}`);
    console.log(`  ${printWay("B", g.B)}`);
    console.log(`  ${printC(g.C)}`);
  }
  console.log(`walk seed ${seed}: zones compared ${zonesCompared}; look-ahead compared ${lookahead}`);
  if (zonesCompared === 0 || lookahead === 0) bad("the checks compared nothing");
  return fail;
};

// ---- main --------------------------------------------------------------------------------------------

if (import.meta.main) {
  if (MODE !== "print") await Deno.mkdir(OUT, { recursive: true });
  if (MODE === "synthetic") {
    let fail = 0;
    for (const seed of env("SEEDS", "1,2").split(",").map(Number)) fail += checkWalk(seed);
    console.log(fail === 0 ? "ALL WALK CHECKS PASSED" : `${fail} WALK CHECKS FAILED`);
    if (fail) Deno.exit(1);
  } else if (MODE === "real" || MODE === "walkfiles") {
    const walk = MODE === "walkfiles";
    if (walk) await writeWalkFiles(`${OUT}/gmo`, Number(env("SEEDS", "1").split(",")[0]));
    const { as, st } = await loadFiles(walk ? { dir: `${OUT}/gmo`, fetch: false } : { dir: "research/.cache", fetch: true });
    console.log(`files ${st.files} requests ${st.requests} cached ${st.cached} partial ${st.partial} failed ${st.failed} ${st.failedExamples.join("; ")}`);
    if (st.failed) {
      console.log("some files could not be read: stop");
      Deno.exit(1);
    }
    const trades = ordered(as.flatMap((a) => tradesOfPair(a)));
    await Deno.writeTextFile(`${OUT}/rows.csv`, csvOf(trades));
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify(summaryOf(trades, as), null, 1));
    // the numbers are printed by the workflow only after the Python agreed (research/macd90m-check.py)
    console.log(`written: ${trades.length} rows`);
  } else if (MODE === "print") {
    printSummary(JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`)));
  }
}
