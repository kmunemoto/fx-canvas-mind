// The owner (2026-11-17): 「もうシンプル96%の足できたら逆張りのメールちょうだい」, then 「メールを1時間足から15分足に変更」.
// One email at a closed 15-MINUTE bar whose close puts the MACD line (600 closes, the newest 120 bars' pane) at 96% on a
// side the bar before was not at, on the fade side (top SELL, bottom BUY), the price in only: no target, no stop. The
// study measures it as the owner holds (CLAUDE.md: take profit 10 pips, no stop, funds unlimited), the other side (flow)
// beside it, and the same holding with no signal (the baseline). The rule and the output: research/macdfade15-spec.md.
//
//   MODE=real       GMO's 15-minute and 1-minute files: research/.cache, fetched when missing (GitHub's runners reach
//                   GMO; the development container cannot). Writes OUT/{rows.csv, summary.json}.
//   MODE=synthetic  two seeded walks (SEEDS) in memory and the checks of the spec: the 15-minute bars rebuilt from the
//                   minutes against the walk's own; the line at the close against zoneAt on the windows rebuilt; no bar
//                   at the share on both sides; at 0.95 the email's decideZoneOnWindow; each entry's two trades; the
//                   indexed follow against the plain minute walk; the look-ahead (every price after T0, or after a
//                   trade's T, moved by ±300 pips); the counts add up.
//   MODE=walkfiles  the walk of SEEDS' first seed written as GMO's files under OUT/gmo, read back through the real run's
//                   loaders, the study written to OUT (what research/macdfade15-check.py is run on first), and held
//                   byte for byte against the same walk computed in memory. With MESS=1 the files are first made
//                   untidy (messFiles: rows on one side, crossed, repeated across files, closes moved, minutes
//                   missing), so some minutes are in no chart bar; then not held against memory, the Python is.
//   MODE=null       driftless walks (NULL_SEEDS, default 1 to 10) over the run's period, in memory, through the same
//                   code: OUT/null.json, the gaps fade − base and fade − flow that chance alone gives.
//   MODE=print      the summary the real run wrote: fade, flow and base side by side, per pair, per side; the gaps
//                   next to null.json's walks; and, with OUT_END1W (the same run with END a week earlier), both.
//
//   SHARE           the share at the bar's close: above 0, at most 1 (not given or empty: 0.96).
//   TP              the take profit in pips: a whole number, at least 1 (not given or empty: 10).
//
// Nothing here changes an email; the numbers are the study's only.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import { GMO_SYMBOLS, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { decideZoneOnWindow, LEVEL_WINDOW, ZONE_SHARE, zoneAt } from "../supabase/functions/_shared/macd-level.ts";
import { macd } from "../supabase/functions/_shared/macd.ts";
import { barInsideClosure, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { type LoadStats, loadM1, type M1, newLoadStats, type Source, synthesize, writeGmoFiles } from "./ownerhold-data.ts";
import { loadTf, quotesOf } from "./trend-data.ts";
import { lowerBound, weekendOutOf } from "./trend-labels.ts";
import { mean, median } from "./flowz-lib.ts";
import { MINUTE } from "./lib.ts";
import { atShare, coarsen, decimalsOf, iso, P, type PairData, PAIRS, poisoned, shareOf, type Side, type Zone, zonesOf } from "./macd90.ts";

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-11-10T21:00:00Z"));
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-12-01T00:00:00Z"));
const OUT = env("OUT", "research/out/macdfade15");
if (!(Number.isFinite(START) && Number.isFinite(END) && Number.isFinite(LOAD_FROM) && LOAD_FROM <= START && START < END)) throw new Error("LOAD_FROM <= START < END, as times");
const SHARE_SPEC = 0.96;
const TP_SPEC = 10;
const SHARE = env("SHARE", "") === "" ? SHARE_SPEC : Number(env("SHARE", ""));
if (!(SHARE > 0 && SHARE <= 1)) throw new Error(`SHARE "${env("SHARE", "")}": a share above 0 and at most 1`);
const TP = env("TP", "") === "" ? TP_SPEC : /^[0-9]+$/.test(env("TP", "").trim()) ? Number(env("TP", "").trim()) : NaN;
if (!(Number.isSafeInteger(TP) && TP >= 1)) throw new Error(`TP "${env("TP", "")}": a whole number of pips, at least 1`);
// MESS=1 (MODE=walkfiles only): the walk's GMO files made untidy before they are read back (messFiles)
const MESS = env("MESS", "") === "1";
if (MESS && MODE !== "walkfiles") throw new Error("MESS=1 goes with MODE=walkfiles only");
const W = LEVEL_WINDOW;
const STEP = 15 * MINUTE;
type Pair = typeof PAIRS[number];
const pairIndex = (p: string) => PAIRS.indexOf(p as Pair);

// the function reads the 15-minute chart 0, 1 and 3 minutes after a close (indicators.ts gmoIntervalsDue) and does not
// run while isPossiblyClosed holds: a signal is mailed when one of those reads (a second into its minute) is not shut
// (research/macd15.ts mailedAt)
const READS = [0, 1, 3] as const;
const mailedAt = (T: number): boolean => READS.some((r) => !isPossiblyClosed(T + r * MINUTE + 1000));

// ---- the 15-minute chart ------------------------------------------------------------------------------

// one pair's 15-minute chart as the function judges it (research/macd90.ts's PairData on 15-minute bars): the open, the
// chart's mid close as drawn (historyRead), and GMO's own 15-minute bid and ask of the same bar
const chartOf = (pair: string, qs: QuoteCandle[]): PairData => {
  const byT = new Map(qs.map((q) => [Date.parse(q.datetime), q]));
  const d: PairData = { pair, n: 0, t: [], mid: [], bc: [], bl: [], ac: [], ah: [] };
  for (const c of historyRead(pair, "15min", qs, END).candles) {
    const t = Date.parse(c.datetime.replace(" ", "T") + "Z");
    const q = byT.get(t);
    if (!q) throw new Error(`${pair} ${iso(t)}: a chart bar without its quote`);
    d.t.push(t);
    d.mid.push(c.close);
    d.bc.push(q.bid.close);
    d.bl.push(q.bid.low);
    d.ac.push(q.ask.close);
    d.ah.push(q.ask.high);
  }
  d.n = d.t.length;
  return d;
};

interface PairAll {
  d: PairData;
  m1: M1;
  // Z(n) (index 599 of the window ending at n) and Zp(n) (index 598 of it): research/macd90.ts zonesOf
  z: Array<Zone | null>;
  zp: Array<Zone | null>;
  dec: number;
}

const pairAllOf = (d: PairData, m1: M1): PairAll => ({ d, m1, ...zonesOf(d), dec: decimalsOf(d.pair) });

// ---- the signals and the entries ------------------------------------------------------------------------

interface Signal {
  pair: string;
  n: number;
  open: number;
  T0: number;
  zside: Side;
  share0: number;
  mailed: boolean;
  // the first 1-minute bar at or after T0 (m1.n when none)
  kFrom: number;
}

interface Signals {
  sig: Signal[];
  // the bars in range: fewer than 600 bars up to it, Z or Zp null, judged
  short: number;
  zoneless: number;
  judged: number;
}

// every bar in range whose close puts the line at share s on a side the bar before was not at; at most one side (with
// s > 0 the top side needs m >= s * top > 0 and the bottom side m <= s * bottom < 0): it stops if both ever hold
const signalsOf = (a: PairAll, s: number): Signals => {
  const { d, m1 } = a;
  const sig: Signal[] = [];
  let short = 0;
  let zoneless = 0;
  let judged = 0;
  for (let n = 0; n < d.n; n++) {
    const T0 = d.t[n] + STEP;
    if (T0 < START || T0 >= END) continue;
    if (n < W - 1) {
      short++;
      continue;
    }
    const z = a.z[n];
    const zp = a.zp[n];
    if (z === null || zp === null) {
      zoneless++;
      continue;
    }
    judged++;
    const sides = (["top", "bottom"] as Side[]).filter((zs) => atShare(z, zs, s) && !atShare(zp, zs, s));
    if (sides.length === 0) continue;
    if (sides.length > 1) throw new Error(`${d.pair} ${iso(d.t[n])}: the line at ${s} on both sides`);
    const zside = sides[0];
    sig.push({ pair: d.pair, n, open: d.t[n], T0, zside, share0: shareOf(z, zside), mailed: mailedAt(T0), kFrom: lowerBound(m1.t, T0) });
  }
  return { sig, short, zoneless, judged };
};

// ---- following a trade (research/macd90m.ts's touch trade, from a given first minute) ----------------------

interface Followed {
  entry: number;
  targetP: number;
  target: number;
  result: "tp" | "open";
  T: number;
  exit: number;
  pips: number;
  mae: number;
  minutes: number;
}

// a trade in at `entry` on `side` at moment T0, followed minute by minute from minute kFrom through the last one loaded
// (minutes in no 15-minute bar too): in each minute the worst against the trade first, then the target test; tp at the
// first minute whose bid high (BUY) or ask low (SELL) reaches the target, out at the target exactly; else open, valued
// at the last minute's bid close (BUY) or ask close (SELL)
const tpFollowPlain = (a: PairAll, kFrom: number, entry: number, side: "BUY" | "SELL", T0: number): Followed => {
  const { m1, dec } = a;
  const pe = P(entry, dec);
  const targetP = side === "BUY" ? pe + 10 * TP : pe - 10 * TP;
  const target = targetP / 10 ** dec;
  let worst = 0;
  const done = (result: "tp" | "open", T: number, exit: number, pts: number): Followed => ({ entry, targetP, target, result, T, exit, pips: pts / 10, mae: worst / 10, minutes: (T - T0) / MINUTE });
  for (let k = kFrom; k < m1.n; k++) {
    const adv = side === "BUY" ? pe - P(m1.bl[k], dec) : P(m1.ah[k], dec) - pe;
    if (adv > worst) worst = adv;
    if (side === "BUY" ? P(m1.bh[k], dec) >= targetP : P(m1.al[k], dec) <= targetP) return done("tp", m1.t[k] + MINUTE, target, 10 * TP);
  }
  const last = m1.n - 1;
  const exit = side === "BUY" ? m1.bc[last] : m1.ac[last];
  return done("open", m1.t[last] + MINUTE, exit, side === "BUY" ? P(exit, dec) - pe : pe - P(exit, dec));
};

// the minutes' P(bid high), P(ask low), P(bid low), P(ask high) in segment trees (research/macd90m.ts's): leaf k at
// size + k, a parent the highest (bh, ah) or lowest (al, bl) of its two children, the leaves past the last minute
// -Infinity in a tree of the highest and +Infinity in one of the lowest
interface MinuteIndex {
  n: number;
  size: number;
  bh: Float64Array;
  al: Float64Array;
  bl: Float64Array;
  ah: Float64Array;
}

const treeOf = (xs: Float64Array, dec: number, n: number, size: number, high: boolean): Float64Array => {
  const t = new Float64Array(2 * size).fill(high ? -Infinity : Infinity);
  for (let k = 0; k < n; k++) t[size + k] = P(xs[k], dec);
  for (let v = size - 1; v >= 1; v--) t[v] = high ? Math.max(t[2 * v], t[2 * v + 1]) : Math.min(t[2 * v], t[2 * v + 1]);
  return t;
};

const minuteIndexOf = (a: PairAll): MinuteIndex => {
  const { m1, dec } = a;
  let size = 1;
  while (size < m1.n) size *= 2;
  return { n: m1.n, size, bh: treeOf(m1.bh, dec, m1.n, size, true), al: treeOf(m1.al, dec, m1.n, size, false), bl: treeOf(m1.bl, dec, m1.n, size, false), ah: treeOf(m1.ah, dec, m1.n, size, true) };
};

// the first minute k >= l whose value reaches x (a tree of the highest: >= x; of the lowest: <= x); n when none
const firstReaching = (ix: MinuteIndex, t: Float64Array, high: boolean, l: number, x: number): number => {
  if (l >= ix.n) return ix.n;
  let v = ix.size + l;
  for (;;) {
    if (high ? t[v] >= x : t[v] <= x) {
      while (v < ix.size) {
        v *= 2;
        if (!(high ? t[v] >= x : t[v] <= x)) v++;
      }
      return v - ix.size;
    }
    while (v & 1) v >>= 1;
    if (v === 0) return ix.n;
    v++;
  }
};

// the highest (high) or lowest of minutes l..r (l <= r)
const extremeOver = (ix: MinuteIndex, t: Float64Array, high: boolean, l: number, r: number): number => {
  let x = high ? -Infinity : Infinity;
  let lo = l + ix.size;
  let hi = r + ix.size + 1;
  while (lo < hi) {
    if (lo & 1) {
      x = high ? Math.max(x, t[lo]) : Math.min(x, t[lo]);
      lo++;
    }
    if (hi & 1) {
      hi--;
      x = high ? Math.max(x, t[hi]) : Math.min(x, t[hi]);
    }
    lo >>= 1;
    hi >>= 1;
  }
  return x;
};

// the same trade followed with the index from minute kFrom: the same numbers as tpFollowPlain's (checked)
const tpFollowIndexed = (a: PairAll, ix: MinuteIndex, kFrom: number, entry: number, side: "BUY" | "SELL", T0: number): Followed => {
  const { m1, dec } = a;
  const pe = P(entry, dec);
  const targetP = side === "BUY" ? pe + 10 * TP : pe - 10 * TP;
  const target = targetP / 10 ** dec;
  const kTp = side === "BUY" ? firstReaching(ix, ix.bh, true, kFrom, targetP) : firstReaching(ix, ix.al, false, kFrom, targetP);
  const tp = kTp < m1.n;
  const kOut = tp ? kTp : m1.n - 1;
  let worst = 0;
  if (kFrom <= kOut) {
    const adv = side === "BUY" ? pe - extremeOver(ix, ix.bl, false, kFrom, kOut) : extremeOver(ix, ix.ah, true, kFrom, kOut) - pe;
    if (adv > worst) worst = adv;
  }
  const exit = tp ? target : side === "BUY" ? m1.bc[kOut] : m1.ac[kOut];
  const pts = tp ? 10 * TP : side === "BUY" ? P(exit, dec) - pe : pe - P(exit, dec);
  const T = m1.t[kOut] + MINUTE;
  return { entry, targetP, target, result: tp ? "tp" : "open", T, exit, pips: pts / 10, mae: worst / 10, minutes: (T - T0) / MINUTE };
};

const sameFollowed = (x: Followed, y: Followed) =>
  x.entry === y.entry && x.targetP === y.targetP && x.target === y.target && x.result === y.result && x.T === y.T && x.exit === y.exit && x.pips === y.pips && x.mae === y.mae && x.minutes === y.minutes;

// ---- the trades -----------------------------------------------------------------------------------------

type Dir = "fade" | "flow";
const DIRS: Dir[] = ["fade", "flow"];
// fade: the top side a SELL, the bottom a BUY (the email's side); flow: the other way
const sideOf = (dir: Dir, zs: Side): "BUY" | "SELL" => ((dir === "fade") === (zs === "top") ? "SELL" : "BUY");

interface Trade extends Followed {
  dir: Dir;
  pair: string;
  n: number;
  open: number;
  T0: number;
  zside: Side;
  side: "BUY" | "SELL";
  share0: number;
  kFrom: number;
}

// one trade: in at bar n's 15-minute ask close (BUY) or bid close (SELL), followed from the first minute at or after
// the bar's close; none: the run stops (the spec: not valued)
const tradeOf = (a: PairAll, e: Signal, dir: Dir): Trade => {
  const { d, m1 } = a;
  if (e.kFrom >= m1.n) throw new Error(`${d.pair} ${iso(e.T0)}: no 1-minute bar at or after the bar's close`);
  const side = sideOf(dir, e.zside);
  const entry = side === "BUY" ? d.ac[e.n] : d.bc[e.n];
  return { dir, pair: e.pair, n: e.n, open: e.open, T0: e.T0, zside: e.zside, side, share0: e.share0, kFrom: e.kFrom, ...tpFollowPlain(a, e.kFrom, entry, side, e.T0) };
};

interface Study extends Signals {
  entries: Signal[];
  notMailed: number;
  // trades[2q], trades[2q + 1]: entries[q]'s fade, then flow
  trades: Trade[];
}

const studyOf = (a: PairAll): Study => {
  const s = signalsOf(a, SHARE);
  const entries = s.sig.filter((e) => e.mailed);
  return { ...s, entries, notMailed: s.sig.length - entries.length, trades: entries.flatMap((e) => DIRS.map((dir) => tradeOf(a, e, dir))) };
};

// ---- the same trade with no signal (the baseline) ---------------------------------------------------------

interface BTrade extends Followed {
  pair: string;
  n: number;
  k: number;
  T0: number;
  side: "BUY" | "SELL";
}

// the bars the entries may come from: judged and mailed
const baseBar = (a: PairAll, n: number): boolean => {
  const T = a.d.t[n] + STEP;
  return T >= START && T < END && n >= W - 1 && a.z[n] !== null && a.zp[n] !== null && mailedAt(T);
};

// every such bar with a minute loaded, at its first (the lowest u in [t[n], t[n] + 15 minutes)): a BUY at the minute's
// ask close then a SELL at its bid close, each followed from the next minute with the index
const baseOf = (a: PairAll, ix: MinuteIndex): { entries: number; trades: BTrade[] } => {
  const { d, m1 } = a;
  const trades: BTrade[] = [];
  let entries = 0;
  for (let n = 0; n < d.n; n++) {
    if (!baseBar(a, n)) continue;
    const from = lowerBound(m1.t, d.t[n]);
    if (from >= m1.n || m1.t[from] >= d.t[n] + STEP) continue;
    // the spec: an entry with no 1-minute bar at or after its T0 is not valued; the run stops (the Python's too)
    if (from + 1 >= m1.n) throw new Error(`${d.pair} ${iso(d.t[n])}: base: no 1-minute bar at or after the entry minute's end`);
    entries++;
    const T0 = m1.t[from] + MINUTE;
    for (const side of ["BUY", "SELL"] as const) trades.push({ pair: d.pair, n, k: from, T0, side, ...tpFollowIndexed(a, ix, from + 1, side === "BUY" ? m1.ac[from] : m1.bc[from], side, T0) });
  }
  return { entries, trades };
};

// every entry trade followed with the index equals its plain walk; every 97th baseline trade walked minute by minute
// equals the index's (the walks and the real run)
const PLAIN_EVERY = 97;
const checkFollow = (a: PairAll, ix: MinuteIndex, trades: Trade[], base: BTrade[], bad: (msg: string) => void) => {
  let indexed = 0;
  let plain = 0;
  for (const t of trades) {
    indexed++;
    if (!sameFollowed(tpFollowIndexed(a, ix, t.kFrom, t.entry, t.side, t.T0), t)) bad(`${a.d.pair} ${iso(t.T0)} ${t.dir}: the trade followed with the index differs from its plain walk`);
  }
  base.forEach((b, q) => {
    if (q % PLAIN_EVERY !== 0) return;
    plain++;
    if (!sameFollowed(tpFollowPlain(a, b.k + 1, b.entry, b.side, b.T0), b)) bad(`${a.d.pair} ${iso(b.T0)} ${b.side}: the baseline trade differs from its plain walk`);
  });
  return { indexed, plain };
};

// ---- per pair: the numbers of pairs[] ---------------------------------------------------------------------

// GMO's 15-minute close against the last 1-minute bar loaded inside the bar (bars in range; and the entries' bars)
const closeVsMinuteOf = (a: PairAll, entries: Signal[]) => {
  const { d, m1 } = a;
  const one = (n: number): "same" | "differ" | "noMinute" => {
    const k = lowerBound(m1.t, d.t[n] + STEP) - 1;
    if (k < 0 || m1.t[k] < d.t[n]) return "noMinute";
    return m1.bc[k] === d.bc[n] && m1.ac[k] === d.ac[n] ? "same" : "differ";
  };
  const c = { bars: 0, same: 0, differ: 0, noMinute: 0, entrySame: 0, entryDiffer: 0, entryNoMinute: 0 };
  const examples: string[] = [];
  for (let n = 0; n < d.n; n++) {
    const T = d.t[n] + STEP;
    if (T < START || T >= END) continue;
    c.bars++;
    const r = one(n);
    c[r]++;
    if (r === "differ" && examples.length < 5) {
      const k = lowerBound(m1.t, T) - 1;
      examples.push(`${iso(d.t[n])} 15min bid/ask close ${d.bc[n]}/${d.ac[n]}, last minute ${iso(m1.t[k])} ${m1.bc[k]}/${m1.ac[k]}`);
    }
  }
  for (const e of entries) {
    const r = one(e.n);
    if (r === "same") c.entrySame++;
    else if (r === "differ") c.entryDiffer++;
    else c.entryNoMinute++;
  }
  return { c, examples };
};

// The real run stops when GMO's 15-minute close differs from the last minute inside the bar in more than ALIGN_MAX of
// the bars in range that have a minute (same + differ; none with a minute stops it too): the one check on GMO's real
// files that the 1-minute bars are labelled as the 15-minute bars are. A minute labelled one minute off would put bar
// n's last minute, before the entry, into the follow.
const ALIGN_MAX = 0.01;
const alignmentBad = (p: { pair: string; closeVsMinute: ReturnType<typeof closeVsMinuteOf>["c"] }): string | null => {
  const c = p.closeVsMinute;
  const k = c.same + c.differ;
  if (k > 0 && c.differ <= ALIGN_MAX * k) return null;
  return `${p.pair}: GMO's 15-minute close differs from the last minute inside the bar in ${c.differ} of the ${k} bars in range with a minute (more than ${100 * ALIGN_MAX}%; noMinute ${c.noMinute}): the minutes may not be labelled as the 15-minute bars are, so the numbers are not trusted`;
};

// the entries whose bar before, read on its own 600-bar window (Z(n − 1)), is at the share on the entry's side
const prevAtOf = (a: PairAll, entries: Signal[]): number => entries.filter((e) => e.n - 1 >= W - 1 && a.z[e.n - 1] !== null && atShare(a.z[e.n - 1] as Zone, e.zside, SHARE)).length;

interface PairRow {
  pair: string;
  bars: number;
  minutes: number;
  short: number;
  zoneless: number;
  judged: number;
  signals: number;
  entries: number;
  notMailed: number;
  prevAt: number;
  baseEntries: number;
  closeVsMinute: ReturnType<typeof closeVsMinuteOf>["c"];
}

const pairRowOf = (a: PairAll, st: Study, baseEntries: number): PairRow => ({
  pair: a.d.pair,
  bars: a.d.n,
  minutes: a.m1.n,
  short: st.short,
  zoneless: st.zoneless,
  judged: st.judged,
  signals: st.sig.length,
  entries: st.entries.length,
  notMailed: st.notMailed,
  prevAt: prevAtOf(a, st.entries),
  baseEntries,
  closeVsMinute: closeVsMinuteOf(a, st.entries).c,
});

// ---- the numbers ------------------------------------------------------------------------------------------

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
// the value at rank ceil(0.9 n) of the values in ascending order
const p90 = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((9 * s.length + 9) / 10) - 1];
};

// G (research/macd90m-spec.md), over trades in the rows' order (sums and means add in it)
const groupOf = (ts: Followed[]) => {
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
type Group = ReturnType<typeof groupOf>;

// GROUPS: all, each pair, BUY and SELL (the trade's side), top and bottom (the entry's side)
const groupsOf = (ts: Trade[]) => {
  const g: Record<string, Group> = { all: groupOf(ts) };
  for (const p of PAIRS) g[p] = groupOf(ts.filter((t) => t.pair === p));
  for (const s of ["BUY", "SELL"]) g[s] = groupOf(ts.filter((t) => t.side === s));
  for (const zs of ["top", "bottom"]) g[zs] = groupOf(ts.filter((t) => t.zside === zs));
  return g;
};
const baseGroupsOf = (ts: BTrade[]) => {
  const g: Record<string, Group> = { all: groupOf(ts) };
  for (const p of PAIRS) g[p] = groupOf(ts.filter((t) => t.pair === p));
  for (const s of ["BUY", "SELL"]) g[s] = groupOf(ts.filter((t) => t.side === s));
  return g;
};

// the rows' order: T0, the pairs' order, fade before flow; the baseline's: T0, the pairs' order, BUY before SELL
const dirOrder = (d: Dir) => (d === "fade" ? 0 : 1);
const sideOrder = (s: "BUY" | "SELL") => (s === "BUY" ? 0 : 1);
const tradeOrdered = (all: Trade[]): Trade[] => [...all].sort((a, b) => a.T0 - b.T0 || pairIndex(a.pair) - pairIndex(b.pair) || dirOrder(a.dir) - dirOrder(b.dir));
const baseOrdered = (all: BTrade[]): BTrade[] => [...all].sort((a, b) => a.T0 - b.T0 || pairIndex(a.pair) - pairIndex(b.pair) || sideOrder(a.side) - sideOrder(b.side));

const summaryOf = (trades: Trade[], pairs: PairRow[], base: BTrade[]) => ({
  meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), share: SHARE, tp: TP },
  pairs,
  dirs: { fade: groupsOf(trades.filter((t) => t.dir === "fade")), flow: groupsOf(trades.filter((t) => t.dir === "flow")) },
  base: baseGroupsOf(base),
});
type Summary = ReturnType<typeof summaryOf>;

const HEAD = ["dir", "pair", "open", "T0", "zside", "side", "entry", "share0", "target", "result", "T", "exit", "pips", "mae", "minutes"];
const csvOf = (ts: Trade[]): string =>
  [HEAD.join(","), ...ts.map((t) => [t.dir, t.pair, iso(t.open), iso(t.T0), t.zside, t.side, String(t.entry), String(t.share0), String(t.target), t.result, iso(t.T), String(t.exit), String(t.pips), String(t.mae), String(t.minutes)].join(","))].join("\n") + "\n";

// ---- printing ---------------------------------------------------------------------------------------------

const fmt = (v: number | null, k = 2) => (v === null ? "-" : v.toFixed(k));
const rate = (g: Group) => fmt(g.trades ? (100 * g.tp) / g.trades : null, 1);
// the mean of the open trades' unrealized pips (a tp trade's are TP exactly)
const openMean = (g: Group) => (g.open && g.openPipsSum !== null ? g.openPipsSum / g.open : null);
const groupLines = (k: string, g: Group): string[] => [
  `${k.padEnd(8)} trades ${g.trades}: tp ${g.tp} (${rate(g)}%) open ${g.open}`,
  `  pips (all trades, open ones unrealized): sum ${fmt(g.pipsSum, 1)} mean ${fmt(g.pipsMean)} median ${fmt(g.pipsMedian)} | mae (all trades) median ${fmt(g.maeMedian, 1)} p90 ${fmt(g.maeP90, 1)} max ${fmt(g.maeMax, 1)}`,
  `  tp: minutes median ${fmt(g.tpMinutesMedian, 0)} p90 ${fmt(g.tpMinutesP90, 0)} max ${fmt(g.tpMinutesMax, 0)} | within 1h ${g.within60} 1d ${g.within1440} 1w ${g.within10080} | mae max ${fmt(g.tpMaeMax, 1)}`,
  `  open (still held at the last minute): pips sum ${fmt(g.openPipsSum, 1)} mean ${fmt(openMean(g))} worst ${fmt(g.openPipsWorst, 1)} | mae max ${fmt(g.openMaeMax, 1)} | minutes max ${fmt(g.openMinutesMax, 0)}`,
];
const sideBySide = (k: string, name: string, g: Group) =>
  `${k.padEnd(8)} ${name.padEnd(4)} trades ${g.trades} tp ${rate(g)}% open ${g.open} | pips mean ${fmt(g.pipsMean)} sum ${fmt(g.pipsSum, 1)} | mae median ${fmt(g.maeMedian, 1)} p90 ${fmt(g.maeP90, 1)} max ${fmt(g.maeMax, 1)} | tp minutes median ${fmt(g.tpMinutesMedian, 0)} p90 ${fmt(g.tpMinutesP90, 0)} max ${fmt(g.tpMinutesMax, 0)} | open pips sum ${fmt(g.openPipsSum, 1)} mean ${fmt(openMean(g))} worst ${fmt(g.openPipsWorst, 1)} minutes max ${fmt(g.openMinutesMax, 0)}`;

const printSummary = (s: Summary) => {
  console.log(`== the MACD fade on the 15-minute chart: one entry a closed 15-minute bar whose close puts the line at ${s.meta.share} on a side the bar before was not at`);
  console.log(`   the email is the fade side and states no target and no stop; measured as the owner holds: take profit ${s.meta.tp} pips, no stop, every email taken`);
  console.log(`   (research/macdfade15-spec.md). Open trades are still held at the last minute loaded (their pips unrealized). Orders not filled: 0 (in at the bar's close: no limit order).`);
  console.log(`   A tp trade's pips are +${s.meta.tp} exactly; the mean a trade is set mostly by the open trades' pips at the last minute (their "open ... mean" below).`);
  console.log(`   Every trade is in at the bar's exact closing price and may reach its target from the first minute after the close. The minutes between the close and`);
  console.log(`   the owner's order (the function reads 0, 1 and 3 minutes after the close, the email is then sent and the order placed by hand), and the price then: not measured.`);
  console.log(`meta ${JSON.stringify(s.meta)}`);
  for (const p of s.pairs) console.log(`pair ${JSON.stringify(p)}`);
  for (const dir of DIRS) {
    console.log(`== ${dir} (${dir === "fade" ? "top SELL, bottom BUY: the email's side" : "top BUY, bottom SELL: for comparison, no email"})`);
    for (const [k, g] of Object.entries(s.dirs[dir])) for (const line of groupLines(k, g)) console.log(line);
  }
  console.log(`== base (no signal: every bar the entries may come from, at its first minute, a BUY at the ask close and a SELL at the bid close; take profit ${s.meta.tp}, no stop)`);
  for (const [k, g] of Object.entries(s.base)) for (const line of groupLines(k, g)) console.log(line);
  console.log(`== fade, flow and base side by side (take profit ${s.meta.tp}, no stop; pips a trade over all trades, open ones unrealized)`);
  // the one real-data check that the minutes line up with the 15-minute bars (the real run stops above ALIGN_MAX)
  for (const p of s.pairs) {
    const c = p.closeVsMinute;
    const k = c.same + c.differ;
    console.log(`${p.pair}: GMO's 15-minute close equals the last minute inside the bar in ${c.same} of the ${k} bars in range with a minute (${fmt(k ? (100 * c.same) / k : null, 2)}%), differs in ${c.differ}, no minute ${c.noMinute}; the entries' bars: same ${c.entrySame} differ ${c.entryDiffer} no minute ${c.entryNoMinute}`);
  }
  for (const k of ["all", ...PAIRS, "BUY", "SELL", "top", "bottom"]) {
    for (const [name, g] of [["fade", s.dirs.fade[k]], ["flow", s.dirs.flow[k]], ["base", s.base[k]]] as Array<[string, Group | undefined]>) if (g) console.log(sideBySide(k, name, g));
  }
};

// ---- is the gap more than chance? (MODE=null writes null.json; MODE=print reads it) --------------------------

// a group's share of tp and of open trades (%) and its mean pips a trade (open ones unrealized)
const statOf = (g: Group | undefined) => (g && g.trades && g.pipsMean !== null ? { trades: g.trades, tpShare: (100 * g.tp) / g.trades, pipsMean: g.pipsMean, openShare: (100 * g.open) / g.trades } : null);
type Stat = NonNullable<ReturnType<typeof statOf>>;
const gapOf = (x: Stat | null, y: Stat | null) => (x && y ? { tpShare: x.tpShare - y.tpShare, pipsMean: x.pipsMean - y.pipsMean, openShare: x.openShare - y.openShare } : null);
type Gap = NonNullable<ReturnType<typeof gapOf>>;
// the groups fade, flow and base all have (top and bottom are fade's and flow's only)
const GAP_KEYS = ["all", ...PAIRS, "BUY", "SELL"];
const gapsOf = (s: Summary) =>
  Object.fromEntries(GAP_KEYS.map((k) => {
    const fade = statOf(s.dirs.fade[k]);
    const flow = statOf(s.dirs.flow[k]);
    const base = statOf(s.base[k]);
    return [k, { fade, flow, base, fadeMinusBase: gapOf(fade, base), fadeMinusFlow: gapOf(fade, flow) }];
  }));
type Gaps = ReturnType<typeof gapsOf>;
interface NullRun {
  meta: Summary["meta"] & { seeds: number[] };
  walks: Array<{ seed: number; entries: number; gaps: Gaps }>;
}
const sameRun = (a: Summary["meta"], b: Summary["meta"]) => a.start === b.start && a.end === b.end && a.loadFrom === b.loadFrom && a.share === b.share && a.tp === b.tp;
const sgn = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

const printGaps = (s: Summary, nul0: NullRun | null) => {
  const nul = nul0 && sameRun(nul0.meta, s.meta) ? nul0 : null;
  console.log(`== is the gap more than chance? fade − base and fade − flow (take profit ${s.meta.tp}, no stop): tp and open in percentage points of the trades, pips mean in pips a trade`);
  if (nul0 && !nul) console.log(`   null.json is for another run (${JSON.stringify(nul0.meta)}): not shown`);
  if (!nul) {
    console.log("   no driftless walks for this run: the gaps below have no measure of their noise, and are not evidence of anything");
  } else {
    console.log(`   next to the same gaps on ${nul.walks.length} driftless walks (MODE=null, seeds ${nul.meta.seeds.join(",")}): random walks with no trend, through the same code over the same`);
    console.log("   period. No signal can do better than no signal on such a walk, so their gaps are chance alone. A real gap inside the walks' range is not evidence that the");
    console.log("   email's side does better than no signal (or than the other side). The walks' price moves are the generator's, not GMO's, and a few walks give a range, not a test:");
    console.log(`   with ${nul.walks.length} walks, a gap with no edge at all still falls outside their range about ${fmt((100 * 2) / (nul.walks.length + 1), 0)}% of the time (2 in ${nul.walks.length + 1}), so "OUTSIDE" alone is not evidence either.`);
  }
  const part = (g: Gap | null) => (g ? `tp ${sgn(g.tpShare)} pts, pips mean ${sgn(g.pipsMean)}, open ${sgn(g.openShare)} pts` : "-");
  const real = gapsOf(s);
  for (const k of GAP_KEYS) {
    const fb = real[k].fadeMinusBase;
    const ff = real[k].fadeMinusFlow;
    console.log(`${k.padEnd(8)} real   fade−base: ${part(fb)} | fade−flow: ${part(ff)}`);
    if (!nul) continue;
    const span = (which: "fadeMinusBase" | "fadeMinusFlow", f: keyof Gap, realGap: Gap | null) => {
      const vs = nul.walks.map((w) => w.gaps[k][which]).filter((g): g is Gap => g !== null).map((g) => g[f]);
      if (vs.length === 0) return "-";
      const lo = Math.min(...vs);
      const hi = Math.max(...vs);
      const at = realGap === null ? "" : realGap[f] < lo || realGap[f] > hi ? " real OUTSIDE" : " real inside";
      return `${sgn(lo)}..${sgn(hi)}${at}`;
    };
    const walks = (which: "fadeMinusBase" | "fadeMinusFlow", realGap: Gap | null) => `tp ${span(which, "tpShare", realGap)}, pips mean ${span(which, "pipsMean", realGap)}, open ${span(which, "openShare", realGap)}`;
    console.log(`${"".padEnd(8)} walks  fade−base: ${walks("fadeMinusBase", fb)} | fade−flow: ${walks("fadeMinusFlow", ff)}`);
    if (k === "all") {
      const own = (which: "fade" | "flow" | "base", f: keyof Stat) => {
        const vs = nul.walks.map((w) => w.gaps.all[which]).filter((x): x is Stat => x !== null).map((x) => x[f]);
        return vs.length ? `${Math.min(...vs).toFixed(2)}..${Math.max(...vs).toFixed(2)}` : "-";
      };
      console.log(`${"".padEnd(8)} the walks' own numbers: tp share fade ${own("fade", "tpShare")}% flow ${own("flow", "tpShare")}% base ${own("base", "tpShare")}%; pips mean fade ${own("fade", "pipsMean")} flow ${own("flow", "pipsMean")} base ${own("base", "pipsMean")}`);
    }
  }
};

// the same study with END a week earlier (OUT_END1W, checked by the Python too): the open trades valued a week
// earlier and the last week's entries left out; how much the mean a trade moves with the last minute's price
const printEarlier = (s: Summary, e: Summary | null) => {
  if (!e || !(e.meta.start === s.meta.start && e.meta.loadFrom === s.meta.loadFrom && e.meta.share === s.meta.share && e.meta.tp === s.meta.tp)) {
    console.log(`== END a week earlier: ${e ? `another run (${JSON.stringify(e.meta)})` : "not given (OUT_END1W)"}: how much the mean a trade moves with the last minute's price is not shown`);
    return;
  }
  console.log(`== the same study with END ${e.meta.end} instead of ${s.meta.end} (take profit ${s.meta.tp}, no stop): the open trades valued then, that week's entries left out`);
  const one = (g: Group | undefined) => (g ? `trades ${g.trades} tp ${rate(g)}% open ${g.open} pips mean ${fmt(g.pipsMean)} (open: sum ${fmt(g.openPipsSum, 1)} mean ${fmt(openMean(g))})` : "-");
  for (const k of ["all", ...PAIRS]) {
    for (const [name, g, h] of [["fade", s.dirs.fade[k], e.dirs.fade[k]], ["flow", s.dirs.flow[k], e.dirs.flow[k]], ["base", s.base[k], e.base[k]]] as Array<[string, Group | undefined, Group | undefined]>) {
      console.log(`${k.padEnd(8)} ${name.padEnd(4)} END ${s.meta.end}: ${one(g)} | END ${e.meta.end}: ${one(h)}`);
    }
  }
};

// a JSON file, or null when there is none (any other failure stops)
const readJsonIfAny = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
};

// ---- the walk ---------------------------------------------------------------------------------------------

const walkOf = (seed: number, pair: string) => synthesize(pair, pairIndex(pair), { seed, trend: 0, startPips: null }, LOAD_FROM, END);

// the walk's 15-minute bars rebuilt from its minutes, as GMO's files and the loader would give them: on the 15-minute
// grid, opened at or after LOAD_FROM, closed by END, not wholly inside the weekend closure
const bars15Of = (m: M1): QuoteCandle[] =>
  coarsen(m, STEP).filter((q) => {
    const t = Date.parse(q.datetime);
    return t >= LOAD_FROM && t + STEP <= END && !barInsideClosure(t, STEP);
  });

// the minutes from START on (as loadM1 reads them)
const fromStart = (m: M1): M1 => {
  const k = lowerBound(m.t, START);
  const cut = (xs: Float64Array) => xs.slice(k);
  return { ...m, n: m.n - k, t: cut(m.t), bo: cut(m.bo), bh: cut(m.bh), bl: cut(m.bl), bc: cut(m.bc), ao: cut(m.ao), ah: cut(m.ah), al: cut(m.al), ac: cut(m.ac) };
};
const synthAll = (pair: string, m: M1): PairAll => pairAllOf(chartOf(pair, bars15Of(m)), fromStart(m));

// a pair's study, baseline and row (the walks in memory and the files alike); the index dropped after it
const runPair = (a: PairAll, bad: (msg: string) => void) => {
  const t0 = performance.now();
  const st = studyOf(a);
  const t1 = performance.now();
  const ix = minuteIndexOf(a);
  const base = baseOf(a, ix);
  const t2 = performance.now();
  const c = checkFollow(a, ix, st.trades, base.trades, bad);
  const t3 = performance.now();
  return { st, base, row: pairRowOf(a, st, base.entries), checked: c, ms: { study: t1 - t0, base: t2 - t1, check: t3 - t2 } };
};

const written = (all: Array<{ st: Study; base: { trades: BTrade[] }; row: PairRow }>) => {
  const trades = tradeOrdered(all.flatMap((x) => x.st.trades));
  const base = baseOrdered(all.flatMap((x) => x.base.trades));
  const summary = summaryOf(trades, all.map((x) => x.row), base);
  return { trades, base, summary, csv: csvOf(trades), json: JSON.stringify(summary, null, 1) };
};

// ---- the checks on the walks --------------------------------------------------------------------------------

const sameZone = (a: Zone | null, b: Zone | null) => (a === null || b === null ? a === b : a.m === b.m && a.top === b.top && a.bottom === b.bottom);
const zoneOf = (r: ReturnType<typeof zoneAt>): Zone | null => (r ? { m: r.m, top: r.top, bottom: r.bottom } : null);
const inRange = (a: PairAll, n: number) => a.d.t[n] + STEP >= START && a.d.t[n] + STEP < END;

// what stays when the prices at or after `cut` move: the entries with T0 at or before it (bar, side, share0, the first
// minute followed, the trades' sides and prices), and the tp trades out at or before it
const entriesTo = (st: Study, cut: number) =>
  st.entries.flatMap((e, q) => (e.T0 <= cut ? [`${e.n} ${e.T0} ${e.zside} ${e.share0} ${e.kFrom} ${[st.trades[2 * q], st.trades[2 * q + 1]].map((t) => `${t.dir} ${t.side} ${t.entry}`).join(" ")}`] : [])).join("|");
const tpTo = (ts: Array<Followed & { T0: number; side: string }>, cut: number) => ts.filter((t) => t.result === "tp" && t.T <= cut).map((t) => `${t.T0} ${t.side} ${t.entry} ${t.result} ${t.T} ${t.exit} ${t.pips} ${t.mae} ${t.minutes}`).join("|");
const baseTo = (bs: BTrade[], cut: number) => bs.filter((b) => b.T0 <= cut).map((b) => `${b.n} ${b.k} ${b.T0} ${b.side} ${b.entry}`).join("|");

const checkPair = (seed: number, pair: string, bad: (msg: string) => void) => {
  const w = walkOf(seed, pair);
  const m = w.m1;
  const c = { line: 0, both: 0, cmp95: 0, notMailedBars: 0, lookahead: 0, lookaheadTp: 0, baseLookahead: 0 };
  // (1) the 15-minute bars rebuilt from the minutes are the walk's own (the files' bars)
  const q = bars15Of(m);
  if (JSON.stringify(q) !== JSON.stringify(w.q15)) bad(`${pair}: the 15-minute bars rebuilt from the minutes differ from the walk's own (${q.length} and ${w.q15.length})`);
  const a = synthAll(pair, m);
  const { d, m1 } = a;
  const r = runPair(a, bad);
  const { st, base } = r;
  const sigBar = new Map(st.sig.map((e) => [e.n, e]));
  // (2) the line at the close against the windows rebuilt; (3) never both sides
  for (let n = W - 1; n < d.n; n++) {
    if (!inRange(a, n)) continue;
    if (!mailedAt(d.t[n] + STEP)) c.notMailedBars++;
    const z = a.z[n];
    if (z && atShare(z, "top", SHARE) && atShare(z, "bottom", SHARE)) bad(`${pair} ${iso(d.t[n])}: Z at ${SHARE} on both sides`);
    if (z) c.both++;
    const e = sigBar.get(n);
    if (!e && n % 29 !== 0) continue;
    c.line++;
    const zr = zoneOf(zoneAt(macd(d.mid.slice(n - W + 1, n + 1)), W - 1));
    const zpr = zoneOf(zoneAt(macd(d.mid.slice(n - W + 1, n)), W - 2));
    if (!sameZone(zr, a.z[n])) bad(`${pair} ${iso(d.t[n])}: Z differs from zoneAt on the 600 closes rebuilt`);
    if (!sameZone(zpr, a.zp[n])) bad(`${pair} ${iso(d.t[n])}: Zp differs from zoneAt at 598 of the 599 closes ending at the bar before`);
    let again: Side | null = null;
    if (zr && zpr) for (const zs of ["top", "bottom"] as Side[]) if (atShare(zr, zs, SHARE) && !atShare(zpr, zs, SHARE)) again = zs;
    if ((again === null) !== (e === undefined) || (e && again !== e.zside)) bad(`${pair} ${iso(d.t[n])}: the bar's signal differs when read from the windows rebuilt`);
  }
  // (4) at 0.95 the signals' fade side is the email's own decideZoneOnWindow on every judged bar
  const at95 = new Map(signalsOf(a, ZONE_SHARE).sig.map((e) => [e.n, sideOf("fade", e.zside)]));
  const closes = d.mid.map((x) => ({ close: x }));
  for (let n = W - 1; n < d.n; n++) {
    if (!inRange(a, n) || a.z[n] === null || a.zp[n] === null) continue;
    c.cmp95++;
    const mine = at95.get(n) ?? null;
    const theirs = decideZoneOnWindow(closes, n)?.side ?? null;
    if (mine !== theirs) bad(`${pair} ${iso(d.t[n])}: at ${ZONE_SHARE} the fade side ${mine}, decideZoneOnWindow ${theirs}`);
  }
  // (5) each entry's two trades
  if (st.trades.length !== 2 * st.entries.length) bad(`${pair}: ${st.trades.length} trades for ${st.entries.length} entries`);
  const lastT = m1.n ? m1.t[m1.n - 1] + MINUTE : NaN;
  st.entries.forEach((e, k) => {
    const [f, g] = [st.trades[2 * k], st.trades[2 * k + 1]];
    if (!f || !g) return;
    const at = `${pair} ${iso(e.T0)}`;
    if (f.dir !== "fade" || g.dir !== "flow") bad(`${at}: not fade then flow`);
    for (const t of [f, g]) {
      if (t.pair !== e.pair || t.n !== e.n || t.open !== e.open || t.T0 !== e.T0 || t.zside !== e.zside || t.share0 !== e.share0 || t.kFrom !== e.kFrom) bad(`${at} ${t.dir}: not its entry's pair, bar, open, T0, zside, share0`);
      if (t.entry !== (t.side === "BUY" ? d.ac[e.n] : d.bc[e.n])) bad(`${at} ${t.dir}: the entry is not the 15-minute bar's ${t.side === "BUY" ? "ask" : "bid"} close`);
      if (t.result === "tp" && !(t.pips === TP && t.exit === t.target && t.T > t.T0 && t.T <= lastT)) bad(`${at} ${t.dir}: a tp trade's pips ${t.pips} (TP ${TP}), exit or T`);
      if (t.result === "open" && !(t.pips < TP && t.T === lastT)) bad(`${at} ${t.dir}: an open trade's pips ${t.pips} not below TP ${TP}, or not valued at the last minute`);
      if (!(t.mae >= 0) || t.minutes !== (t.T - t.T0) / MINUTE) bad(`${at} ${t.dir}: mae or minutes`);
    }
    if (f.side === g.side) bad(`${at}: fade and flow on the same side`);
    if (f.side !== (e.zside === "top" ? "SELL" : "BUY")) bad(`${at}: fade is not top SELL, bottom BUY`);
    if (e.open !== d.t[e.n] || e.T0 !== d.t[e.n] + STEP || !e.mailed) bad(`${at}: open, T0 or mailed`);
    if (!(e.kFrom < m1.n && m1.t[e.kFrom] >= e.T0 && (e.kFrom === 0 || m1.t[e.kFrom - 1] < e.T0))) bad(`${at}: not followed from the first minute at or after T0`);
    if (!atShare(a.z[e.n] as Zone, e.zside, SHARE) || atShare(a.zp[e.n] as Zone, e.zside, SHARE) || e.share0 !== shareOf(a.z[e.n] as Zone, e.zside)) bad(`${at}: Z not at the share, Zp at it, or share0`);
  });
  // the baseline: each entry a BUY then a SELL at its bar's first minute, at its ask and bid closes; tp and open
  if (base.trades.length !== 2 * base.entries) bad(`${pair}: base: ${base.trades.length} trades for ${base.entries} entries`);
  for (let k = 0; 2 * k + 1 < base.trades.length; k++) {
    const [b, s] = [base.trades[2 * k], base.trades[2 * k + 1]];
    const at = `${pair} ${iso(b.T0)}: base`;
    if (b.side !== "BUY" || s.side !== "SELL" || b.n !== s.n || b.k !== s.k || b.T0 !== s.T0) bad(`${at}: not a BUY and a SELL at one minute`);
    if (b.k !== lowerBound(m1.t, d.t[b.n]) || m1.t[b.k] < d.t[b.n] || m1.t[b.k] >= d.t[b.n] + STEP || b.T0 !== m1.t[b.k] + MINUTE || !baseBar(a, b.n)) bad(`${at}: not a bar's first minute, or not a bar the entries may come from`);
    if (b.entry !== m1.ac[b.k] || s.entry !== m1.bc[s.k]) bad(`${at}: not the minute's ask close (BUY) and bid close (SELL)`);
    for (const t of [b, s]) {
      if (t.result === "tp" && !(t.pips === TP && t.exit === t.target && t.T > t.T0 && t.T <= lastT)) bad(`${at} ${t.side}: a tp trade's pips, exit or T`);
      if (t.result === "open" && !(t.pips < TP && t.T === lastT)) bad(`${at} ${t.side}: an open trade's pips or T`);
      if (!(t.mae >= 0) || t.minutes !== (t.T - t.T0) / MINUTE) bad(`${at} ${t.side}: mae or minutes`);
    }
  }
  // the baseline's entries counted again: the bars the entries may come from whose 15 minutes hold a minute loaded
  const quarters = new Set<number>();
  for (let k = 0; k < m1.n; k++) quarters.add(Math.floor(m1.t[k] / STEP) * STEP);
  let baseBars = 0;
  for (let n = 0; n < d.n; n++) if (baseBar(a, n) && quarters.has(d.t[n])) baseBars++;
  if (baseBars !== base.entries) bad(`${pair}: base: ${base.entries} entries, ${baseBars} bars with a minute`);
  // (7) the look-ahead: the entries, four spread over the period (at 10%, 35%, 60% and 85% of the pair's entries)
  const spread = (count: number) => [...new Set([0.1, 0.35, 0.6, 0.85].map((f) => Math.floor(f * count)))].filter((k) => k < count);
  for (const k of spread(st.entries.length)) {
    const e = st.entries[k];
    const mine = [st.trades[2 * k], st.trades[2 * k + 1]];
    for (const pips of [300, -300]) {
      const cuts = [e.T0, ...mine.filter((t) => t.result === "tp").map((t) => t.T)];
      for (const cut of cuts) {
        const again = studyOf(synthAll(pair, poisoned(m, cut, pips)));
        c.lookahead++;
        if (cut !== e.T0) c.lookaheadTp++;
        const at = `${pair} ${iso(e.T0)}: when the prices at or after ${iso(cut)} moved ${pips}`;
        if (!again.entries.some((u) => u.T0 === e.T0)) bad(`${at}: the entry went`);
        if (entriesTo(again, cut) !== entriesTo(st, cut)) bad(`${at}: the entries at or before the cut changed`);
        if (tpTo(again.trades, cut) !== tpTo(st.trades, cut)) bad(`${at}: the tp trades out at or before the cut changed`);
      }
    }
  }
  // the look-ahead: the baseline, four entries spread over the period as the entries'
  for (const k of spread(base.entries)) {
    const mine = [base.trades[2 * k], base.trades[2 * k + 1]];
    for (const pips of [300, -300]) {
      const cuts = [mine[0].T0, ...mine.filter((t) => t.result === "tp").map((t) => t.T)];
      for (const cut of cuts) {
        const aa = synthAll(pair, poisoned(m, cut, pips));
        const again = baseOf(aa, minuteIndexOf(aa)).trades;
        c.baseLookahead++;
        const at = `${pair} ${iso(mine[0].T0)}: base: when the prices at or after ${iso(cut)} moved ${pips}`;
        if (baseTo(again, cut) !== baseTo(base.trades, cut)) bad(`${at}: the entries at or before the cut changed`);
        if (tpTo(again, cut) !== tpTo(base.trades, cut)) bad(`${at}: the tp trades out at or before the cut changed`);
      }
    }
  }
  return { r, c };
};

// (9) hand-made minutes (USD/JPY, 3 decimals), each trade followed both ways against numbers worked out by hand: the
// walks seldom have a minute that both reaches the target and sets the worst against the trade, so the order "the worst
// first, then the target" is pinned here. Entry 150.000 (150000 points) at T0, the target 10 * TP points away.
const handCases = (bad: (msg: string) => void): number => {
  const T0 = Date.parse("2024-02-05T10:00:00Z");
  const e = 150000;
  const up = e + 10 * TP;
  const down = e - 10 * TP;
  // rows: [bid open, high, low, close] in points, the ask 2 points above each; the first minute is the entry's own
  // (before T0, not followed)
  const m1Of = (rows: number[][]): M1 => {
    const n = rows.length;
    const col = (j: number, add: number) => Float64Array.from(rows, (r) => (r[j] + add) / 1000);
    return { pair: "USD/JPY", n, t: Float64Array.from(rows, (_, k) => T0 + (k - 1) * MINUTE), bo: col(0, 0), bh: col(1, 0), bl: col(2, 0), bc: col(3, 0), ao: col(0, 2), ah: col(1, 2), al: col(2, 2), ac: col(3, 2) };
  };
  const cases: Array<{ name: string; side: "BUY" | "SELL"; rows: number[][]; want: Omit<Followed, "entry" | "targetP" | "target"> }> = [
    {
      // the target reached in the second minute followed, whose bid low (149.900) is the worst of all: mae 10.0 pips
      name: "BUY, the tp minute sets the worst",
      side: "BUY",
      rows: [[e, e, e, e], [e, up - 1, 149990, e], [e, up, 149900, up]],
      want: { result: "tp", T: T0 + 2 * MINUTE, exit: up / 1000, pips: TP, mae: 10, minutes: 2 },
    },
    {
      // a minute that opens beyond the target is taken at the target exactly; never against: mae 0
      name: "BUY, a gap through the target",
      side: "BUY",
      rows: [[e, e, e, e], [up + 200, up + 300, up + 150, up + 250]],
      want: { result: "tp", T: T0 + MINUTE, exit: up / 1000, pips: TP, mae: 0, minutes: 1 },
    },
    {
      // the ask low never at the target (down + 1): open at the last minute's ask close 150.052, pips -5.2; the worst
      // ask high 150.082: mae 8.2 pips
      name: "SELL, open at the last minute",
      side: "SELL",
      rows: [[e, e, e, e], [e, 150030, down - 1, 150010], [150010, 150080, down - 1, 150050]],
      want: { result: "open", T: T0 + 2 * MINUTE, exit: 150.052, pips: -5.2, mae: 8.2, minutes: 2 },
    },
  ];
  let n = 0;
  for (const c of cases) {
    const m1 = m1Of(c.rows);
    const a: PairAll = { d: { pair: "USD/JPY", n: 0, t: [], mid: [], bc: [], bl: [], ac: [], ah: [] }, m1, z: [], zp: [], dec: 3 };
    const entry = e / 1000;
    const plain = tpFollowPlain(a, 1, entry, c.side, T0);
    const indexed = tpFollowIndexed(a, minuteIndexOf(a), 1, entry, c.side, T0);
    const w = c.want;
    for (const [how, f] of [["plain", plain], ["indexed", indexed]] as const) {
      n++;
      if (!(f.result === w.result && f.T === w.T && f.exit === w.exit && f.pips === w.pips && f.mae === w.mae && f.minutes === w.minutes)) bad(`hand case "${c.name}" (${how}): ${JSON.stringify(f)}, by hand ${JSON.stringify(w)}`);
    }
  }
  return n;
};

// (10) the weekend gate by hand: a signal at each bar of the table below, held against the table written from the
// spec ("a bar is not read exactly when it closes at or after Friday 21:00 UTC and before Sunday 22:00 UTC"), through
// studyOf (the entries and notMailed) and baseOf (the baseline's entries). mailedAt is what is tested, so the table
// does not call it. The week: the first Friday (UTC) whose 20:30 bar closes at or after START.
const gateCases = (bad: (msg: string) => void): number => {
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  let fri = Math.floor(START / DAY) * DAY;
  while (new Date(fri).getUTCDay() !== 5 || fri + 20 * HOUR + 30 * MINUTE + STEP < START) fri += DAY;
  // [the bar's open from that Friday 00:00 UTC, mailed by hand]
  const table: Array<[number, boolean]> = [
    [20 * HOUR + 30 * MINUTE, true], // Friday, closes 20:45: the read at 20:45:01 is before 21:00
    [20 * HOUR + 45 * MINUTE, false], // Friday, closes 21:00: reads 21:00:01, 21:01:01, 21:03:01, all shut
    [21 * HOUR, false], // Friday, closes 21:15
    [DAY + 12 * HOUR, false], // Saturday, closes 12:15
    [2 * DAY + 21 * HOUR + 30 * MINUTE, false], // Sunday, closes 21:45: reads 21:45:01 to 21:48:01, before 22:00
    [2 * DAY + 21 * HOUR + 45 * MINUTE, true], // Sunday, closes 22:00: the read at 22:00:01 is open
    [3 * DAY, true], // Monday, closes 00:15
  ];
  const opens = table.map(([o]) => fri + o);
  const lastClose = opens[opens.length - 1] + STEP;
  if (lastClose >= END) {
    bad(`weekend gate by hand: the week of ${iso(fri)} does not end before END ${iso(END)} (the period is too short for this check)`);
    return 0;
  }
  // 599 bars long before START (none in range), then the table's bars, each a signal on the top side
  const t = [...Array.from({ length: W - 1 }, (_, i) => fri - 30 * DAY + i * STEP), ...opens];
  const n = t.length;
  const d: PairData = { pair: "USD/JPY", n, t, mid: t.map(() => 150), bc: t.map(() => 150), bl: t.map(() => 150), ac: t.map(() => 150.002), ah: t.map(() => 150.002) };
  const z = t.map((_, k): Zone | null => (k < W - 1 ? null : { m: 1, top: 1, bottom: -1 }));
  const zp = t.map((_, k): Zone | null => (k < W - 1 ? null : { m: 0, top: 1, bottom: -1 }));
  // one minute at each table bar's open, and one at the last bar's close (the trades are followed from it)
  const mt = [...opens, lastClose];
  const col = (v: number) => Float64Array.from(mt, () => v);
  const m1: M1 = { pair: "USD/JPY", n: mt.length, t: Float64Array.from(mt), bo: col(150), bh: col(150), bl: col(150), bc: col(150), ao: col(150.002), ah: col(150.002), al: col(150.002), ac: col(150.002) };
  const a: PairAll = { d, m1, z, zp, dec: 3 };
  const st = studyOf(a);
  const want = table.flatMap(([o, mailed]) => (mailed ? [iso(fri + o + STEP)] : []));
  const got = st.entries.map((e) => iso(e.T0));
  if (st.sig.length !== table.length) bad(`weekend gate by hand: ${st.sig.length} signals, the table has ${table.length}`);
  if (got.join(" ") !== want.join(" ")) bad(`weekend gate by hand: the entries close at ${got.join(" ")}, by hand ${want.join(" ")}`);
  if (st.notMailed !== table.length - want.length) bad(`weekend gate by hand: notMailed ${st.notMailed}, by hand ${table.length - want.length}`);
  const base = baseOf(a, minuteIndexOf(a));
  const wantBase = table.flatMap(([o, mailed]) => (mailed ? [iso(fri + o)] : []));
  const gotBase = base.trades.filter((b) => b.side === "BUY").map((b) => iso(d.t[b.n]));
  if (base.entries !== wantBase.length || gotBase.join(" ") !== wantBase.join(" ")) bad(`weekend gate by hand: the baseline's entries at the bars opening ${gotBase.join(" ")}, by hand ${wantBase.join(" ")}`);
  return table.length;
};

const checkWalk = (seed: number): { fail: number; notMailed: number } => {
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    if (fail <= 30) console.log(`  CHECK FAILED: ${msg}`);
  };
  const all: Array<ReturnType<typeof runPair>> = [];
  const tot = { line: 0, both: 0, cmp95: 0, notMailedBars: 0, lookahead: 0, lookaheadTp: 0, baseLookahead: 0, indexed: 0, plain: 0 };
  for (const pair of PAIRS) {
    const t0 = performance.now();
    const { r, c } = checkPair(seed, pair, bad);
    all.push(r);
    for (const k of Object.keys(c) as Array<keyof typeof c>) tot[k] += c[k];
    tot.indexed += r.checked.indexed;
    tot.plain += r.checked.plain;
    console.log(`walk seed ${seed} ${pair}: chart ${r.row.bars} bars, minutes ${r.row.minutes}; judged ${r.row.judged} (short ${r.row.short}, zoneless ${r.row.zoneless}); signals ${r.row.signals}: entries ${r.row.entries}, not mailed ${r.row.notMailed}; prevAt ${r.row.prevAt}; base ${r.row.baseEntries}; close vs minute ${JSON.stringify(r.row.closeVsMinute)} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
  // (8) the counts add up
  const { summary: s } = written(all);
  const entries = s.pairs.reduce((x, p) => x + p.entries, 0);
  for (const p of s.pairs) {
    if (p.signals !== p.entries + p.notMailed) bad(`${p.pair}: signals is not entries + notMailed`);
    const cv = p.closeVsMinute;
    if (cv.same + cv.differ + cv.noMinute !== cv.bars || cv.entrySame + cv.entryDiffer + cv.entryNoMinute !== p.entries) bad(`${p.pair}: closeVsMinute does not add up`);
    if (p.short !== 0 || p.zoneless !== 0) bad(`${p.pair}: short ${p.short} zoneless ${p.zoneless} (the walk loads enough bars)`);
    if (p.judged + p.short + p.zoneless !== cv.bars) bad(`${p.pair}: judged + short + zoneless is not the bars in range`);
  }
  for (const dir of DIRS) {
    const gs = s.dirs[dir];
    for (const [k, g] of Object.entries(gs)) if (g.tp + g.open !== g.trades) bad(`${dir} ${k}: tp + open is not trades`);
    if (gs.all.trades !== entries) bad(`${dir}: ${gs.all.trades} trades for ${entries} entries`);
    for (const p of s.pairs) if (gs[p.pair].trades !== p.entries) bad(`${dir} ${p.pair}: ${gs[p.pair].trades} trades for ${p.entries} entries`);
    if (gs.BUY.trades + gs.SELL.trades !== gs.all.trades || gs.top.trades + gs.bottom.trades !== gs.all.trades) bad(`${dir}: BUY + SELL or top + bottom is not all`);
    if (gs.all.tp === 0) bad(`${dir}: the walk has no tp trade`);
  }
  const [fa, fl] = [s.dirs.fade, s.dirs.flow];
  if (fa.BUY.trades !== fl.SELL.trades || fa.SELL.trades !== fl.BUY.trades || fa.top.trades !== fl.top.trades || fa.bottom.trades !== fl.bottom.trades) bad("fade and flow do not have the same entries");
  if (fa.SELL.trades !== fa.top.trades || fa.BUY.trades !== fa.bottom.trades) bad("fade is not top SELL, bottom BUY in the counts");
  const bg = s.base;
  const baseAll = s.pairs.reduce((x, p) => x + p.baseEntries, 0);
  for (const [k, g] of Object.entries(bg)) if (g.tp + g.open !== g.trades) bad(`base ${k}: tp + open is not trades`);
  if (bg.all.trades !== 2 * baseAll) bad(`base: ${bg.all.trades} trades for ${baseAll} entries`);
  for (const p of s.pairs) if (bg[p.pair].trades !== 2 * p.baseEntries) bad(`base ${p.pair}: ${bg[p.pair].trades} trades for ${p.baseEntries} entries`);
  if (bg.BUY.trades !== baseAll || bg.SELL.trades !== baseAll) bad("base: BUY or SELL is not one an entry");
  if (bg.all.tp === 0 || bg.all.open === 0) bad("base: the walk has no tp or no open trade");
  for (const dir of DIRS) {
    console.log(`walk seed ${seed} share ${SHARE} tp ${TP} ${dir}: entries ${entries}`);
    for (const line of groupLines("all", s.dirs[dir].all)) console.log(`  ${line}`);
  }
  console.log(`walk seed ${seed} base: entries ${baseAll}`);
  for (const line of groupLines("all", bg.all)) console.log(`  ${line}`);
  console.log(
    `walk seed ${seed} checks: bars read with the line rebuilt ${tot.line}; judged bars none at ${SHARE} on both sides ${tot.both}; bars against decideZoneOnWindow at ${ZONE_SHARE} ${tot.cmp95}; bars in range the function does not read (weekend gate) ${tot.notMailedBars}; entry trades followed with the index ${tot.indexed}; baseline trades walked minute by minute ${tot.plain}; look-ahead runs ${tot.lookahead} (after a tp trade's T ${tot.lookaheadTp}); baseline look-ahead runs ${tot.baseLookahead}`,
  );
  if (entries === 0 || tot.line === 0 || tot.cmp95 === 0 || tot.indexed === 0 || tot.plain === 0 || tot.lookahead === 0 || tot.lookaheadTp === 0 || tot.baseLookahead === 0) bad("the checks compared nothing");
  return { fail, notMailed: s.pairs.reduce((x, p) => x + p.notMailed, 0) };
};

// ---- loading ------------------------------------------------------------------------------------------------

const loadFiles = async (src: Source): Promise<{ as: PairAll[]; st: LoadStats; diags: Array<{ oneSide: number; crossed: number; repeated: number }> }> => {
  const st = newLoadStats();
  const as: PairAll[] = [];
  const diags: Array<{ oneSide: number; crossed: number; repeated: number }> = [];
  const weekend = weekendOutOf("inside");
  for (const pair of PAIRS) {
    const q = await loadTf(src, pair, "15min", LOAD_FROM, END, st, weekend);
    const d = chartOf(pair, quotesOf(q.bars));
    const m1 = await loadM1(src, pair, START, END, st);
    as.push(pairAllOf(d, m1));
    diags.push({ oneSide: q.diag.oneSide, crossed: q.diag.crossed, repeated: q.diag.repeated });
    console.log(`${pair}: 15min ${q.bars.n} chart ${d.n} (from ${d.n ? iso(d.t[0]) : "-"}), 1min ${m1.n}; 15min files ${q.diag.files} oneSide ${q.diag.oneSide} crossed ${q.diag.crossed} repeated ${q.diag.repeated} keyMismatch ${q.diag.keyMismatch}`);
  }
  return { as, st, diags };
};

const writeWalkFiles = async (dir: string, seed: number) => {
  for (const pair of PAIRS) await writeGmoFiles(dir, pair, walkOf(seed, pair), LOAD_FROM, END);
};

// MESS=1: a walk's GMO files made untidy as GMO's can be, then read back through the real run's loaders (the Python
// reads the same files). The minutes stay where 15-minute rows go, so some minutes are in no chart bar (followed all
// the same, as the spec says). With q = floor(t / 15 minutes) and u = floor(t / 1 minute) of a row's open, the first
// rule that holds (1 point = the last decimal written):
//   15-minute rows  q % 37 == 0: the ask row removed (one side). q % 41 == 1: the ask close 1 point under the bid close
//                   (crossed). q % 43 == 2: a second bid row 2 points under the first bid's close and a second ask
//                   row 1 point under it, in the next day's file (the first bid row is then crossed with the last ask
//                   row, and the time's next bid row is taken). q % 47 == 3: the same two rows again in the next day's
//                   file (repeated, the same). q % 53 == 4: both closes 1 point up (no longer the last minute's).
//   1-minute rows   q % 59 == 5: every minute of the quarter removed, both sides (a chart bar with no minute).
//                   u % 101 == 7: the ask row removed. u % 211 == 8: the ask close 1 point under the bid close.
//                   u % 307 == 9: a second row, both sides 5 points up, in the next day's file (the first is kept).
// Returns the rows changed, by rule.
type GmoRow = { openTime: string; open: string; high: string; low: string; close: string };
const messFiles = async (dir: string, pair: string) => {
  const symbol = GMO_SYMBOLS[pair];
  const dg = decimalsOf(pair);
  const pt = (x: string) => P(Number(x), dg);
  const px = (p: number) => (p / 10 ** dg).toFixed(dg);
  const moved = (r: GmoRow, by: number): GmoRow => ({ openTime: r.openTime, open: px(pt(r.open) + by), high: px(pt(r.high) + by), low: px(pt(r.low) + by), close: px(pt(r.close) + by) });
  const withClose = (r: GmoRow, close: number): GmoRow => ({ ...r, close: px(close), high: px(Math.max(pt(r.high), close)), low: px(Math.min(pt(r.low), close)) });
  const count: Record<string, number> = {};
  const hit = (k: string) => (count[k] = (count[k] ?? 0) + 1);
  for (const iv of ["15min", "1min"] as const) {
    const base = `${dir}/${symbol}/${iv}`;
    const keys: string[] = [];
    for await (const f of Deno.readDir(`${base}/bid`)) if (f.name.endsWith(".json")) keys.push(f.name.slice(0, -5));
    keys.sort();
    const read = async (side: string, key: string): Promise<GmoRow[]> => JSON.parse(await Deno.readTextFile(`${base}/${side}/${key}.json`)).data;
    const files = await Promise.all(keys.map(async (key) => ({ bid: await read("bid", key), ask: await read("ask", key) })));
    // the rows each file gets: those put in front from the day before, then its own (changed)
    const front = keys.map(() => ({ bid: [] as GmoRow[], ask: [] as GmoRow[] }));
    const own = keys.map(() => ({ bid: [] as GmoRow[], ask: [] as GmoRow[] }));
    files.forEach((f, i) => {
      const asks = new Map(f.ask.map((r) => [r.openTime, r]));
      const next = i + 1 < keys.length ? front[i + 1] : null;
      for (const b of f.bid) {
        const t = Number(b.openTime);
        const q = Math.floor(t / STEP);
        const u = Math.floor(t / MINUTE);
        let a = asks.get(b.openTime);
        asks.delete(b.openTime);
        let bb: GmoRow | null = b;
        if (!a) throw new Error(`MESS ${pair} ${iv} ${keys[i]}: a walk row on one side only`);
        if (iv === "15min") {
          if (q % 37 === 0) {
            a = undefined;
            hit("15min one side");
          } else if (q % 41 === 1) {
            a = withClose(a, pt(b.close) - 1);
            hit("15min crossed");
          } else if (q % 43 === 2 && next) {
            next.bid.push(withClose(b, pt(b.close) - 2));
            next.ask.push(withClose(a, pt(b.close) - 1));
            hit("15min repeated, the first bid crossed");
          } else if (q % 47 === 3 && next) {
            next.bid.push({ ...b });
            next.ask.push({ ...a });
            hit("15min repeated, the same");
          } else if (q % 53 === 4) {
            bb = withClose(b, pt(b.close) + 1);
            a = withClose(a, pt(a.close) + 1);
            hit("15min closes moved");
          }
        } else {
          if (q % 59 === 5) {
            bb = null;
            a = undefined;
            hit("1min quarter removed");
          } else if (u % 101 === 7) {
            a = undefined;
            hit("1min one side");
          } else if (u % 211 === 8) {
            a = withClose(a, pt(b.close) - 1);
            hit("1min crossed");
          } else if (u % 307 === 9 && next) {
            next.bid.push(moved(b, 5));
            next.ask.push(moved(a, 5));
            hit("1min repeated");
          }
        }
        if (bb) own[i].bid.push(bb);
        if (a) own[i].ask.push(a);
      }
      if (asks.size) throw new Error(`MESS ${pair} ${iv} ${keys[i]}: a walk row on one side only`);
    });
    for (let i = 0; i < keys.length; i++) {
      for (const side of ["bid", "ask"] as const) await Deno.writeTextFile(`${base}/${side}/${keys[i]}.json`, JSON.stringify({ status: 0, data: [...front[i][side], ...own[i][side]] }));
    }
  }
  return count;
};

// what MESS must have done to the files read back: every kind of untidy row met by the loaders, minutes in no chart
// bar, chart bars with no minute and closes that are not their last minute's, on every pair
const messChecks = (as: PairAll[], st: LoadStats, diags: Array<{ oneSide: number; crossed: number; repeated: number }>, bad: (msg: string) => void) => {
  if (!(st.oneSide > 0 && st.crossed > 0 && st.repeated > 0)) bad(`MESS: the 1-minute loader met oneSide ${st.oneSide} crossed ${st.crossed} repeated ${st.repeated} (each should be above 0)`);
  as.forEach((a, i) => {
    const { d, m1 } = a;
    const g = diags[i];
    const quarters = new Set(d.t);
    let outside = 0;
    for (let k = 0; k < m1.n; k++) if (!quarters.has(Math.floor(m1.t[k] / STEP) * STEP)) outside++;
    let taken = 0;
    for (let n = 0; n < d.n; n++) if (Math.floor(d.t[n] / STEP) % 43 === 2) taken++;
    const cv = closeVsMinuteOf(a, []).c;
    console.log(`MESS ${d.pair}: 15min oneSide ${g.oneSide} crossed ${g.crossed} repeated ${g.repeated}; minutes in no chart bar ${outside}; chart bars whose first bid row was crossed (the next bid row taken) ${taken}; close vs minute ${JSON.stringify(cv)}`);
    if (!(g.oneSide > 0 && g.crossed > 0 && g.repeated > 0)) bad(`MESS ${d.pair}: the 15-minute loader met oneSide ${g.oneSide} crossed ${g.crossed} repeated ${g.repeated} (each should be above 0)`);
    if (outside === 0) bad(`MESS ${d.pair}: no minute in no chart bar`);
    if (taken < 2) bad(`MESS ${d.pair}: ${taken} chart bars from a time's second bid row`);
    if (!(cv.differ > 0 && cv.noMinute > 1)) bad(`MESS ${d.pair}: close vs minute differ ${cv.differ} noMinute ${cv.noMinute}`);
  });
};

// ---- main ---------------------------------------------------------------------------------------------------

if (import.meta.main) {
  if (MODE !== "print") {
    await Deno.mkdir(OUT, { recursive: true });
    console.log(`share ${SHARE} tp ${TP}${SHARE === SHARE_SPEC && TP === TP_SPEC ? " (the spec's)" : " (SHARE or TP set: NOT the spec's 0.96 and 10)"}; start ${iso(START)} end ${iso(END)} loadFrom ${iso(LOAD_FROM)}`);
  }
  if (MODE === "synthetic") {
    let fail = 0;
    const bad = (msg: string) => {
      fail++;
      console.log(`  CHECK FAILED: ${msg}`);
    };
    console.log(`hand cases: ${handCases(bad)} trades followed against numbers worked out by hand`);
    console.log(`weekend gate by hand: ${gateCases(bad)} signal bars against a table written by hand`);
    let notMailed = 0;
    for (const seed of env("SEEDS", "1,2").split(",").map(Number)) {
      const r = checkWalk(seed);
      fail += r.fail;
      notMailed += r.notMailed;
    }
    // the walks' own signals must reach the weekend gate too (walk 2 has some on the syn job's period)
    console.log(`signals the weekend gate kept from the walks: ${notMailed}`);
    if (notMailed === 0) bad("no walk has a signal the weekend gate keeps from mail (notMailed 0 on every walk): the gate is not tried on the walks");
    console.log(fail === 0 ? "ALL WALK CHECKS PASSED" : `${fail} WALK CHECKS FAILED`);
    if (fail) Deno.exit(1);
  } else if (MODE === "real" || MODE === "walkfiles") {
    const walk = MODE === "walkfiles";
    const seed = Number(env("SEEDS", "1").split(",")[0]);
    if (walk) await writeWalkFiles(`${OUT}/gmo`, seed);
    if (MESS) for (const pair of PAIRS) console.log(`MESS ${pair}: the rows changed ${JSON.stringify(await messFiles(`${OUT}/gmo`, pair))}`);
    const { as, st, diags } = await loadFiles(walk ? { dir: `${OUT}/gmo`, fetch: false } : { dir: "research/.cache", fetch: true });
    console.log(`files ${st.files} requests ${st.requests} cached ${st.cached} partial ${st.partial} failed ${st.failed} ${st.failedExamples.join("; ")}; 1-minute rows left out: oneSide ${st.oneSide} crossed ${st.crossed} closure ${st.closure} repeated ${st.repeated}`);
    if (st.failed) {
      console.log("some files could not be read: stop");
      Deno.exit(1);
    }
    let fail = 0;
    const bad = (msg: string) => {
      fail++;
      if (fail <= 30) console.log(`  CHECK FAILED: ${msg}`);
    };
    if (MESS) messChecks(as, st, diags, bad);
    const all = as.map((a) => {
      const r = runPair(a, bad);
      const p = r.row;
      console.log(
        `${p.pair}: judged ${p.judged} (short ${p.short}, zoneless ${p.zoneless}); signals ${p.signals}: entries ${p.entries}, not mailed ${p.notMailed}; prevAt ${p.prevAt}; base ${p.baseEntries} entries; study ${r.ms.study.toFixed(0)} ms, base ${r.ms.base.toFixed(0)} ms (the index built and searched), checked in ${r.ms.check.toFixed(0)} ms: entry trades followed with the index ${r.checked.indexed}, baseline trades walked minute by minute ${r.checked.plain}`,
      );
      console.log(`${p.pair}: GMO's 15-minute close against the last 1-minute bar in it: ${JSON.stringify(p.closeVsMinute)}`);
      for (const x of closeVsMinuteOf(a, r.st.entries).examples) console.log(`  differs: ${x}`);
      return r;
    });
    for (const r of all) if (r.row.short !== 0 || r.row.zoneless !== 0) bad(`${r.row.pair}: ${r.row.short} bars in range with fewer than 600 bars up to them, ${r.row.zoneless} with no zone (LOAD_FROM too late?)`);
    // GMO's minutes against its 15-minute bars: the real run stops when they do not line up (ALIGN_MAX); the untidy
    // walk files (MESS) must trip the same check (their closes are moved on purpose), and do not stop on it
    const misaligned = all.map((r) => alignmentBad(r.row)).filter((m): m is string => m !== null);
    if (!walk) for (const m of misaligned) bad(m);
    if (MESS) {
      console.log(`the alignment check on the untidy files: ${misaligned.length} of ${all.length} pairs over ${100 * ALIGN_MAX}% (the real run would stop): ${misaligned.join(" | ")}`);
      if (misaligned.length === 0) bad("MESS: the alignment check did not trip on the untidy files (it is not tried)");
    }
    if (fail) {
      console.log(`${fail} CHECKS FAILED: rows.csv and summary.json not written`);
      Deno.exit(1);
    }
    const w = written(all);
    await Deno.writeTextFile(`${OUT}/rows.csv`, w.csv);
    await Deno.writeTextFile(`${OUT}/summary.json`, w.json);
    console.log(`written: ${w.trades.length} rows; the baseline: ${w.base.length} trades (no rows)`);
    // the walk read back from the files against the same walk in memory: the same bytes (not the untidy files: their
    // chart is not the walk's; the Python is run on them instead)
    if (walk && !MESS) {
      const mem = written(PAIRS.map((pair) => runPair(synthAll(pair, walkOf(seed, pair).m1), bad)));
      const same = mem.csv === w.csv && mem.json === w.json;
      console.log(`walk seed ${seed}: the files read back give ${same ? "the same rows.csv and summary.json as" : "OTHER BYTES THAN"} the walk in memory`);
      if (!same || fail) Deno.exit(1);
    }
    // the numbers are printed by the workflow only after the Python agreed (research/macdfade15-check.py)
  } else if (MODE === "null") {
    // driftless walks (no trend: no signal can do better than none on them) over the run's own period, in memory,
    // through the same code as the real run: the gaps fade − base and fade − flow that chance alone gives
    const seeds = env("NULL_SEEDS", "1,2,3,4,5,6,7,8,9,10").split(",").map(Number);
    if (!seeds.every((x) => Number.isSafeInteger(x) && x > 0)) throw new Error(`NULL_SEEDS "${env("NULL_SEEDS", "")}": whole numbers above 0, by commas`);
    let fail = 0;
    const bad = (msg: string) => {
      fail++;
      if (fail <= 30) console.log(`  CHECK FAILED: ${msg}`);
    };
    const walks: NullRun["walks"] = [];
    for (const seed of seeds) {
      const t0 = performance.now();
      const s = written(PAIRS.map((pair) => runPair(synthAll(pair, walkOf(seed, pair).m1), bad))).summary;
      const gaps = gapsOf(s);
      const entries = s.pairs.reduce((x, p) => x + p.entries, 0);
      walks.push({ seed, entries, gaps });
      const a = gaps.all;
      const v = (x: Stat | null, f: keyof Stat) => fmt(x ? x[f] : null);
      console.log(
        `null walk seed ${seed}: entries ${entries}; all: tp share fade ${v(a.fade, "tpShare")}% flow ${v(a.flow, "tpShare")}% base ${v(a.base, "tpShare")}%; pips mean fade ${v(a.fade, "pipsMean")} flow ${v(a.flow, "pipsMean")} base ${v(a.base, "pipsMean")}; fade−base tp ${a.fadeMinusBase ? sgn(a.fadeMinusBase.tpShare) : "-"} pts pips ${a.fadeMinusBase ? sgn(a.fadeMinusBase.pipsMean) : "-"} (${((performance.now() - t0) / 1000).toFixed(0)} s)`,
      );
    }
    if (fail) {
      console.log(`${fail} CHECKS FAILED: null.json not written`);
      Deno.exit(1);
    }
    const nul: NullRun = { meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), share: SHARE, tp: TP, seeds }, walks };
    await Deno.writeTextFile(`${OUT}/null.json`, JSON.stringify(nul, null, 1));
    console.log(`written: ${OUT}/null.json (${walks.length} walks)`);
  } else if (MODE === "print") {
    const s: Summary = JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`));
    printSummary(s);
    printGaps(s, await readJsonIfAny<NullRun>(`${OUT}/null.json`));
    const earlier = env("OUT_END1W", "");
    printEarlier(s, earlier ? await readJsonIfAny<Summary>(`${earlier}/summary.json`) : null);
  } else {
    throw new Error(`MODE "${MODE}": synthetic, walkfiles, real, null or print`);
  }
}
