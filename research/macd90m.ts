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
//   REACH           the share that counts as reached, when not the spec's 0.96 (the owner 2026-11-12:
//                   「90に到達した瞬間に注文入れたら、95か96に到達する確率？」): a number above 0.9, at most 1, e.g. 0.95.
//                   Every "96%" of the rule is then that share (already, reached, way C); nothing else changes.
//
// The touch (research/macd90m-spec.md, its last section; the owner 2026-11-17: 「やっぱり96%をメールの合図にして」,
// 「利確10・損切りなし」, 「両方を測って決める」): one entry a bar, the first minute the line touches TOUCH on a side the bar
// before was not at; two trades each, flow (top BUY, bottom SELL) and fade (top SELL, bottom BUY), in at the minute's
// close, out at the take profit of TP pips or still open at the last minute loaded. Written apart, to
// OUT/{rows-tp.csv, summary-tp.json}: rows.csv and summary.json stay as they are. MODE=synthetic checks it as well (the
// line at a minute against zoneAt at TOUCH, an entry's two trades, the look-ahead after T0 and after T, the counts);
// MODE=print prints its numbers after the others.
//
//   TOUCH           the share touched: a number above 0, at most 1 (not given or empty: 0.96).
//   TP              the take profit in pips: a whole number, at least 1 (not given or empty: 10).
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
  REACH as REACH_SPEC,
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
// the share that counts as reached: the spec's, or REACH (an empty REACH is the spec's)
const REACH = env("REACH", "") === "" ? REACH_SPEC : Number(env("REACH", ""));
if (!(REACH > ENTER && REACH <= 1)) throw new Error(`REACH "${env("REACH", "")}": a share above ${ENTER} and at most 1`);
// the touch's share and take profit (the spec's last section): TOUCH and TP, an empty one the spec's
const TOUCH_SPEC = 0.96;
const TP_SPEC = 10;
const TOUCH = env("TOUCH", "") === "" ? TOUCH_SPEC : Number(env("TOUCH", ""));
if (!(TOUCH > 0 && TOUCH <= 1)) throw new Error(`TOUCH "${env("TOUCH", "")}": a share above 0 and at most 1`);
const TP = env("TP", "") === "" ? TP_SPEC : /^[0-9]+$/.test(env("TP", "").trim()) ? Number(env("TP", "").trim()) : NaN;
if (!(Number.isSafeInteger(TP) && TP >= 1)) throw new Error(`TP "${env("TP", "")}": a whole number of pips, at least 1`);
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
      // Z(i) at the reach share (research/macd90.ts's own flag when REACH is the spec's: checked on the walks)
      already: atShare(a.z[t.i] as Zone, t.zside, REACH),
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

// ---- the touch: one email the minute the line touches TOUCH, take profit TP, no stop (the spec's last section) ------

type Dir = "flow" | "fade";
const DIRS: Dir[] = ["flow", "fade"];
type Seen = Array<{ j: number; k: number; x: number; z: Zone }>;

// an entry: bar i and its first minute k that touches TOUCH on an open side
interface TEntry {
  pair: string;
  i: number;
  k: number;
  open: number;
  T0: number;
  zside: Side;
  share0: number;
}
interface TTrade {
  dir: Dir;
  pair: string;
  i: number;
  k: number;
  open: number;
  T0: number;
  zside: Side;
  side: "BUY" | "SELL";
  entry: number;
  share0: number;
  // the target in whole points, and as a price (targetP / 10^d)
  targetP: number;
  target: number;
  result: "tp" | "open";
  T: number;
  exit: number;
  pips: number;
  mae: number;
  minutes: number;
}

// the entries: bar i (close in [START, END), at least 600 bars up to it); a side is open when Zp(i) is not at TOUCH on
// it; the first minute of the bar touching TOUCH on an open side (the top side first when it touches both); one a bar
const touchEntriesOf = (a: PairAll, seen?: Seen): TEntry[] => {
  const { d, m1 } = a;
  const out: TEntry[] = [];
  for (let i = W - 1; i < d.n; i++) {
    const T = d.t[i] + HOUR;
    if (T < START || T >= END) continue;
    const zp = a.zp[i];
    if (zp === null) continue;
    const open = (["top", "bottom"] as Side[]).filter((zs) => !atShare(zp, zs, TOUCH));
    if (open.length === 0) continue;
    const [from, end] = minutesOf(a, i);
    for (let k = from; k < end; k++) {
      let hit: { zs: Side; z: Zone } | null = null;
      for (const zs of open) {
        const t = touchAt(a, i, k, zs);
        if (seen) seen.push({ j: i, k, x: t.x, z: t.z });
        if (atShare(t.z, zs, TOUCH)) {
          hit = { zs, z: t.z };
          break;
        }
      }
      if (!hit) continue;
      out.push({ pair: d.pair, i, k, open: d.t[i], T0: m1.t[k] + MINUTE, zside: hit.zs, share0: shareOf(hit.z, hit.zs) });
      break;
    }
  }
  return out;
};

// flow: the top side a BUY, the bottom a SELL; fade: the other way
const tpSideOf = (dir: Dir, zs: Side): "BUY" | "SELL" => ((dir === "flow") === (zs === "top") ? "BUY" : "SELL");

// one trade: in at the entry minute's close (ask for a BUY, bid for a SELL); followed from the next minute through the
// last one loaded (minutes in no 1-hour bar too); tp at the first minute whose bid high (BUY) or ask low (SELL) reaches
// the target, out at the target exactly; else open, valued at the last minute's close
const tpTradeOf = (a: PairAll, e: TEntry, dir: Dir): TTrade => {
  const { m1, dec } = a;
  const side = tpSideOf(dir, e.zside);
  const entry = side === "BUY" ? m1.ac[e.k] : m1.bc[e.k];
  const pe = P(entry, dec);
  const targetP = side === "BUY" ? pe + 10 * TP : pe - 10 * TP;
  const target = targetP / 10 ** dec;
  let worst = 0;
  const done = (result: "tp" | "open", T: number, exit: number, pts: number): TTrade => ({
    dir,
    pair: e.pair,
    i: e.i,
    k: e.k,
    open: e.open,
    T0: e.T0,
    zside: e.zside,
    side,
    entry,
    share0: e.share0,
    targetP,
    target,
    result,
    T,
    exit,
    pips: pts / 10,
    mae: worst / 10,
    minutes: (T - e.T0) / MINUTE,
  });
  for (let k = e.k + 1; k < m1.n; k++) {
    // the worst against the trade, this minute included (the minute out too)
    const adv = side === "BUY" ? pe - P(m1.bl[k], dec) : P(m1.ah[k], dec) - pe;
    if (adv > worst) worst = adv;
    if (side === "BUY" ? P(m1.bh[k], dec) >= targetP : P(m1.al[k], dec) <= targetP) return done("tp", m1.t[k] + MINUTE, target, 10 * TP);
  }
  // no minute after the entry reached it: open at the last minute loaded (the entry minute itself when it is the last)
  const last = m1.n - 1;
  const exit = side === "BUY" ? m1.bc[last] : m1.ac[last];
  return done("open", m1.t[last] + MINUTE, exit, side === "BUY" ? P(exit, dec) - pe : pe - P(exit, dec));
};

// a pair's entries and their trades, each entry's flow then fade (trades[2q], trades[2q + 1] are entries[q]'s)
const touchOf = (a: PairAll, seen?: Seen): { entries: TEntry[]; trades: TTrade[] } => {
  const entries = touchEntriesOf(a, seen);
  return { entries, trades: entries.flatMap((e) => DIRS.map((dir) => tpTradeOf(a, e, dir))) };
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
  meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), reach: REACH },
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

// ---- the touch's numbers and files ----------------------------------------------------------------------

// the highest and lowest without spreading the values into arguments (many trades)
const maxOf = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  let v = xs[0];
  for (const x of xs) if (x > v) v = x;
  return v;
};
const minOf = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  let v = xs[0];
  for (const x of xs) if (x < v) v = x;
  return v;
};

// G of summary-tp.json, over trades in the rows' order (sums and means add in it)
const tpGroupOf = (ts: TTrade[]) => {
  const tp = ts.filter((t) => t.result === "tp");
  const open = ts.filter((t) => t.result === "open");
  let pipsSum = 0;
  for (const t of ts) pipsSum += t.pips;
  let openPipsSum = 0;
  for (const t of open) openPipsSum += t.pips;
  return {
    trades: ts.length,
    tp: tp.length,
    open: open.length,
    pipsSum: ts.length ? pipsSum : null,
    pipsMean: mean(ts.map((t) => t.pips)),
    pipsMedian: median(ts.map((t) => t.pips)),
    tpMinutesMedian: median(tp.map((t) => t.minutes)),
    tpMinutesP90: p90(tp.map((t) => t.minutes)),
    tpMinutesMax: maxOf(tp.map((t) => t.minutes)),
    within60: tp.filter((t) => t.minutes <= 60).length,
    within1440: tp.filter((t) => t.minutes <= 1440).length,
    within10080: tp.filter((t) => t.minutes <= 10080).length,
    maeMedian: median(ts.map((t) => t.mae)),
    maeP90: p90(ts.map((t) => t.mae)),
    maeMax: maxOf(ts.map((t) => t.mae)),
    tpMaeMax: maxOf(tp.map((t) => t.mae)),
    openPipsSum: open.length ? openPipsSum : null,
    openPipsWorst: minOf(open.map((t) => t.pips)),
    openMaeMax: maxOf(open.map((t) => t.mae)),
    openMinutesMax: maxOf(open.map((t) => t.minutes)),
  };
};
type TpGroup = ReturnType<typeof tpGroupOf>;

// GROUPS: all, each pair, BUY and SELL (the trade's side), top and bottom (the entry's side)
const tpGroupsOf = (ts: TTrade[]) => {
  const g: Record<string, TpGroup> = { all: tpGroupOf(ts) };
  for (const p of PAIRS) g[p] = tpGroupOf(ts.filter((t) => t.pair === p));
  for (const s of ["BUY", "SELL"]) g[s] = tpGroupOf(ts.filter((t) => t.side === s));
  for (const zs of ["top", "bottom"]) g[zs] = tpGroupOf(ts.filter((t) => t.zside === zs));
  return g;
};

// the rows' order: T0, then the pairs' order, then flow before fade
const dirOrder = (d: Dir) => (d === "flow" ? 0 : 1);
const tpOrdered = (all: TTrade[]): TTrade[] =>
  [...all].sort((a, b) => a.T0 - b.T0 || PAIRS.indexOf(a.pair as typeof PAIRS[number]) - PAIRS.indexOf(b.pair as typeof PAIRS[number]) || dirOrder(a.dir) - dirOrder(b.dir));

const summaryTpOf = (trades: TTrade[], pairs: Array<{ pair: string; entries: number }>) => ({
  meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), touch: TOUCH, tp: TP },
  pairs,
  dirs: { flow: tpGroupsOf(trades.filter((t) => t.dir === "flow")), fade: tpGroupsOf(trades.filter((t) => t.dir === "fade")) },
});

const HEAD_TP = ["dir", "pair", "open", "T0", "zside", "side", "entry", "share0", "target", "result", "T", "exit", "pips", "mae", "minutes"];
const csvTpOf = (ts: TTrade[]): string =>
  [HEAD_TP.join(","), ...ts.map((t) => [t.dir, t.pair, iso(t.open), iso(t.T0), t.zside, t.side, String(t.entry), String(t.share0), String(t.target), t.result, iso(t.T), String(t.exit), String(t.pips), String(t.mae), String(t.minutes)].join(","))].join("\n") + "\n";

const printTpGroup = (k: string, g: TpGroup): string[] => [
  `${k.padEnd(8)} trades ${g.trades}: tp ${g.tp} (${fmt(g.trades ? (100 * g.tp) / g.trades : null, 1)}%) open ${g.open}`,
  `  pips (all trades, open ones unrealized): sum ${fmt(g.pipsSum, 1)} mean ${fmt(g.pipsMean)} median ${fmt(g.pipsMedian)} | mae (all trades) median ${fmt(g.maeMedian, 1)} p90 ${fmt(g.maeP90, 1)} max ${fmt(g.maeMax, 1)}`,
  `  tp: minutes median ${fmt(g.tpMinutesMedian, 0)} p90 ${fmt(g.tpMinutesP90, 0)} max ${fmt(g.tpMinutesMax, 0)} | within 1h ${g.within60} 1d ${g.within1440} 1w ${g.within10080} | mae max ${fmt(g.tpMaeMax, 1)}`,
  `  open (still held at the last minute): pips sum ${fmt(g.openPipsSum, 1)} worst ${fmt(g.openPipsWorst, 1)} | mae max ${fmt(g.openMaeMax, 1)} | minutes max ${fmt(g.openMinutesMax, 0)}`,
];
const printSummaryTp = (s: ReturnType<typeof summaryTpOf>) => {
  console.log("");
  console.log(`== the touch: one entry the minute the line touches ${s.meta.touch}, take profit ${s.meta.tp} pips, no stop (summary-tp.json)`);
  console.log(`meta ${JSON.stringify(s.meta)}`);
  console.log(`pairs ${JSON.stringify(s.pairs)}`);
  for (const dir of DIRS) {
    console.log(`== ${dir} (${dir === "flow" ? "top BUY, bottom SELL" : "top SELL, bottom BUY"})`);
    for (const [k, g] of Object.entries(s.dirs[dir])) for (const line of printTpGroup(k, g)) console.log(line);
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

// the touch's entry of bar i read again minute by minute with zoneAt on the window rebuilt (no prepared state)
const touchBySlow = (a: PairAll, i: number): { k: number; zs: Side } | null => {
  const zp = a.zp[i];
  if (zp === null) return null;
  const [from, end] = minutesOf(a, i);
  for (let k = from; k < end; k++) {
    for (const zs of ["top", "bottom"] as Side[]) {
      if (atShare(zp, zs, TOUCH)) continue;
      if (atShare(slowZone(a.d, i, towardOf(a, k, zs)), zs, TOUCH)) return { k, zs };
    }
  }
  return null;
};

// the touch's checks on one pair of a walk (the spec's last section, "Checks")
const checkTouchPair = (pair: string, m: M1, a: PairAll, bad: (msg: string) => void) => {
  const { d, m1 } = a;
  const seen: Seen = [];
  const { entries, trades } = touchOf(a, seen);
  let zones = 0;
  let bars = 0;
  let lookahead = 0;
  // (1) the line at a minute against zoneAt on the window rebuilt, at TOUCH: every entry's minute and a sample of the
  // others; and bars read again minute by minute that way (every entry's bar and a sample of the others): the same entry
  const entryK = new Set(entries.map((e) => e.k));
  for (let q = 0; q < seen.length; q++) {
    const s = seen[q];
    if (!entryK.has(s.k) && q % 53 !== 0) continue;
    zones++;
    const slow = slowZone(d, s.j, s.x);
    if (!sameZone(s.z, slow)) bad(`${pair} ${iso(m1.t[s.k])}: touch: the line at the minute differs from zoneAt on the window rebuilt`);
  }
  const byBar = new Map(entries.map((e) => [e.i, e]));
  for (let i = W - 1; i < d.n; i++) {
    const T = d.t[i] + HOUR;
    if (T < START || T >= END) continue;
    const e = byBar.get(i);
    if (!e && i % 29 !== 0) continue;
    bars++;
    const s = touchBySlow(a, i);
    if ((s === null) !== (e === undefined) || (s && e && (s.k !== e.k || s.zs !== e.zside))) bad(`${pair} ${iso(d.t[i])}: touch: the bar's entry differs when read with zoneAt on the window rebuilt`);
  }
  // (2) each entry's two trades: flow then fade, the same pair, open, T0, zside, share0, opposite sides, the minute's ask
  // close for the BUY and bid close for the SELL; each trade's numbers as the spec's
  if (trades.length !== 2 * entries.length) bad(`${pair}: touch: ${trades.length} trades for ${entries.length} entries`);
  const lastT = m1.n ? m1.t[m1.n - 1] + MINUTE : NaN;
  entries.forEach((e, q) => {
    const [f, g] = [trades[2 * q], trades[2 * q + 1]];
    if (!f || !g) return;
    const at = `${pair} ${iso(e.T0)}: touch`;
    if (f.dir !== "flow" || g.dir !== "fade") bad(`${at}: not flow then fade`);
    for (const t of [f, g]) {
      if (t.pair !== e.pair || t.open !== e.open || t.T0 !== e.T0 || t.zside !== e.zside || t.share0 !== e.share0 || t.i !== e.i || t.k !== e.k) bad(`${at} ${t.dir}: not its entry's pair, open, T0, zside, share0`);
      if (t.entry !== (t.side === "BUY" ? m1.ac[e.k] : m1.bc[e.k])) bad(`${at} ${t.dir}: the entry is not the minute's ${t.side === "BUY" ? "ask" : "bid"} close`);
      if (t.result === "tp" && !(t.pips === TP && t.exit === t.target && t.T > t.T0 && t.T <= lastT)) bad(`${at} ${t.dir}: a tp trade's pips ${t.pips} (TP ${TP}), exit or T`);
      if (t.result === "open" && !(t.pips < TP && t.T === lastT)) bad(`${at} ${t.dir}: an open trade's pips ${t.pips} not below TP ${TP}, or not valued at the last minute`);
      if (!(t.mae >= 0) || t.minutes !== (t.T - t.T0) / MINUTE) bad(`${at} ${t.dir}: mae or minutes`);
    }
    if (f.side === g.side) bad(`${at}: flow and fade on the same side`);
    if (f.side !== (e.zside === "top" ? "BUY" : "SELL")) bad(`${at}: flow is not the side of the line`);
    if (m1.t[e.k] < e.open || m1.t[e.k] >= e.open + HOUR || e.T0 !== m1.t[e.k] + MINUTE) bad(`${at}: the entry minute is not in its bar`);
    if (e.share0 < TOUCH) bad(`${at}: share0 ${e.share0} under ${TOUCH}`);
  });
  // (3) the look-ahead: a sample of entries; every price after T0 moved by ±300 pips: the entry stays (bar, minute,
  // side, price); every price after a tp trade's T moved: its result, T, pips and mae stay
  const sample = entries.filter((_, q) => q % 7 === 0).slice(0, 4);
  for (const e of sample) {
    const q = entries.indexOf(e);
    const mine = [trades[2 * q], trades[2 * q + 1]];
    for (const pips of [300, -300]) {
      const cuts: Array<[number, TTrade | null]> = [[e.T0, null], ...mine.filter((t) => t.result === "tp").map((t): [number, TTrade] => [t.T, t])];
      for (const [cut, t] of cuts) {
        const again = touchOf(synthAll(pair, poisoned(m, cut, pips)));
        const qa = again.entries.findIndex((u) => u.T0 === e.T0);
        lookahead++;
        const at = `${pair} ${iso(e.T0)}: touch: when the future after ${iso(cut)} moved ${pips}`;
        if (qa < 0) {
          bad(`${at}: the entry went`);
          continue;
        }
        const ea = again.entries[qa];
        const theirs = [again.trades[2 * qa], again.trades[2 * qa + 1]];
        if (ea.i !== e.i || ea.k !== e.k || ea.zside !== e.zside || ea.share0 !== e.share0 || theirs.some((u, r) => u.side !== mine[r].side || u.entry !== mine[r].entry)) bad(`${at}: the entry changed`);
        if (t) {
          const u = theirs.find((x) => x.dir === t.dir) as TTrade;
          if (!(u.result === t.result && u.T === t.T && u.pips === t.pips && u.mae === t.mae)) bad(`${at}: the ${t.dir} trade changed`);
        }
      }
    }
  }
  return { entries, trades, zones, bars, lookahead };
};

const checkWalk = (seed: number): number => {
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    if (fail <= 30) console.log(`  CHECK FAILED: ${msg}`);
  };
  const all: MTrade[] = [];
  let zonesCompared = 0;
  let lookahead = 0;
  // the touch's
  const tAll: TTrade[] = [];
  const tPairs: Array<{ pair: string; entries: number }> = [];
  let tZones = 0;
  let tBars = 0;
  let tLookahead = 0;
  for (const pair of PAIRS) {
    const m = walkOf(seed, pair).m1;
    const a = synthAll(pair, m);
    const tc = checkTouchPair(pair, m, a, bad);
    tAll.push(...tc.trades);
    tPairs.push({ pair, entries: tc.entries.length });
    tZones += tc.zones;
    tBars += tc.bars;
    tLookahead += tc.lookahead;
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
    // the close entries are research/macd90.ts's (its already flag is at the spec's share: compared when REACH is that)
    const closeKey = (t: { i: number; side: string; entry: number; already: boolean }) => `${t.i} ${t.side} ${t.entry}` + (REACH === REACH_SPEC ? ` ${t.already}` : "");
    const mine = trades.filter((t) => t.way === "close").map(closeKey).join("|");
    const theirs = tradesOf(a.d).trades.map(closeKey).join("|");
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
  // the touch: (4) the counts add up (tp + open = trades = 2 x entries, in every group and pair); (2)'s every tp trade
  // at TP and every open one below it are checked trade by trade above
  const st = summaryTpOf(tpOrdered(tAll), tPairs);
  const entriesAll = tPairs.reduce((s, p) => s + p.entries, 0);
  for (const dir of DIRS) {
    const gs = st.dirs[dir];
    for (const [k, g] of Object.entries(gs)) if (g.tp + g.open !== g.trades) bad(`touch ${dir} ${k}: tp + open is not trades`);
    if (gs.all.trades !== entriesAll) bad(`touch ${dir}: ${gs.all.trades} trades for ${entriesAll} entries`);
    for (const p of tPairs) if (gs[p.pair].trades !== p.entries) bad(`touch ${dir} ${p.pair}: ${gs[p.pair].trades} trades for ${p.entries} entries`);
    if (gs.BUY.trades + gs.SELL.trades !== gs.all.trades || gs.top.trades + gs.bottom.trades !== gs.all.trades) bad(`touch ${dir}: BUY + SELL or top + bottom is not all`);
    if (gs.all.tp === 0) bad(`touch ${dir}: the walk has no tp trade`);
  }
  if (st.dirs.flow.all.trades + st.dirs.fade.all.trades !== 2 * entriesAll) bad("touch: trades are not 2 x entries");
  for (const dir of DIRS) {
    const g = st.dirs[dir].all;
    console.log(`walk seed ${seed} touch ${TOUCH} tp ${TP} ${dir}: entries ${entriesAll}`);
    for (const line of printTpGroup("all", g)) console.log(`  ${line}`);
  }
  console.log(`walk seed ${seed} touch: zones compared ${tZones}; bars read again ${tBars}; look-ahead compared ${tLookahead}`);
  if (entriesAll === 0 || tZones === 0 || tBars === 0 || tLookahead === 0) bad("the touch's checks compared nothing");
  return fail;
};

// ---- main --------------------------------------------------------------------------------------------

if (import.meta.main) {
  if (MODE !== "print") await Deno.mkdir(OUT, { recursive: true });
  if (MODE !== "print") console.log(`reach ${REACH}${REACH === REACH_SPEC ? " (the spec's)" : " (REACH set: NOT the spec's 0.96)"}`);
  if (MODE !== "print") console.log(`touch ${TOUCH} tp ${TP}${TOUCH === TOUCH_SPEC && TP === TP_SPEC ? " (the spec's)" : " (TOUCH or TP set: NOT the spec's 0.96 and 10)"}`);
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
    // the touch, apart (rows.csv and summary.json above do not depend on it)
    const touch = as.map((a) => touchOf(a));
    const tTrades = tpOrdered(touch.flatMap((x) => x.trades));
    await Deno.writeTextFile(`${OUT}/rows-tp.csv`, csvTpOf(tTrades));
    await Deno.writeTextFile(`${OUT}/summary-tp.json`, JSON.stringify(summaryTpOf(tTrades, as.map((a, q) => ({ pair: a.d.pair, entries: touch[q].entries.length }))), null, 1));
    // the numbers are printed by the workflow only after the Python agreed (research/macd90m-check.py)
    console.log(`written: ${trades.length} rows; the touch: ${tTrades.length} rows`);
  } else if (MODE === "print") {
    printSummary(JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`)));
    printSummaryTp(JSON.parse(await Deno.readTextFile(`${OUT}/summary-tp.json`)));
  }
}
