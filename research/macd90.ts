// The owner (2026-11-11): 「90%に届いたらその流れにのって注文を入れて、96%までそのままいく確率を求めて」. When the
// 1-hour MACD line (the email's v8 pane: 600 bars, the 120 newest, 0 included) comes into 90% of the way to the pane's
// top (bottom), an order rides the flow (a BUY toward the top, a SELL toward the bottom); how often does the line then
// go on to 96%? The rule and the output: research/macd90-spec.md. Way A: before it leaves the 90% band; way B: before
// it comes back to the zero line. Each trade's pips on GMO's 1-hour bid and ask (the spread paid), at the close of the
// bar the way ends on. Funds unlimited: every entry is a trade.
//
//   MODE=real       GMO's files: research/.cache, fetched when missing (GitHub's runners reach GMO; the development
//                   container cannot). Writes OUT/{rows.csv,summary.json}.
//   MODE=synthetic  seeded walks (ownerhold-data synthesize) in memory, the same pipeline, and the checks: the 95%
//                   entry computed here equals the email's decideZoneOnWindow on every bar; the look-ahead check (every
//                   price after an entry's bar, or after the bar a way ended on, moved by ±300 pips: the entry and that
//                   way's result stay); the counts add up; way A reached means way B reached on the same bar.
//   MODE=walkfiles  the walk of SEEDS' first seed written as GMO's files under OUT/gmo, read back through the real
//                   run's loaders (nothing fetched), the study written to OUT: what research/macd90-check.py is run on
//                   first.
//   MODE=print      the summary the real run wrote.
//
// Nothing here changes an email; the numbers are the study's only.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { decideZoneOnWindow, LEVEL_WINDOW, zoneAt } from "../supabase/functions/_shared/macd-level.ts";
import { macd } from "../supabase/functions/_shared/macd.ts";
import { type LoadStats, type M1, type Source, newLoadStats, synthesize, unitOf } from "./ownerhold-data.ts";
import { loadTf, quotesOf, ruleKeyOf, writeWalk } from "./trend-data.ts";
import { emptyBars, fromQuotes, weekendOutOf } from "./trend-labels.ts";
import { mean, median } from "./flowz-lib.ts";
import { HOUR } from "./lib.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-11-10T21:00:00Z"));
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-10-01T00:00:00Z"));
const OUT = env("OUT", "research/out/macd90");
const ENTER = 0.9;
const REACH = 0.96;
const W = LEVEL_WINDOW;

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const decimalsOf = (pair: string) => (pair.includes("JPY") ? 3 : 5);

// ---- the bars ----------------------------------------------------------------------------------------

// one pair's 1-hour bars: open time, the chart's mid close, and the bid and ask of the same bar
interface PairData {
  pair: string;
  n: number;
  t: number[];
  mid: number[];
  bc: number[];
  bl: number[];
  ac: number[];
  ah: number[];
}

const dataOf = (pair: string, qs: QuoteCandle[]): PairData => {
  const byT = new Map(qs.map((q) => [Date.parse(q.datetime), q]));
  const d: PairData = { pair, n: 0, t: [], mid: [], bc: [], bl: [], ac: [], ah: [] };
  for (const c of historyRead(pair, "1h", qs, END).candles) {
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

// ---- where the line stands, each bar on its own window ------------------------------------------------

interface Zone {
  m: number;
  top: number;
  bottom: number;
}
type Side = "top" | "bottom";

const atShare = (z: Zone, side: Side, s: number): boolean => (side === "top" ? z.top > 0 && z.m >= s * z.top : z.bottom < 0 && z.m <= s * z.bottom);
const shareOf = (z: Zone, side: Side): number => (side === "top" ? z.m / z.top : z.m / z.bottom);

// Z(i) (index 599 of bar i's window) and Zp(i) (index 598 of the same window); null before 600 bars or on a gap
const zonesOf = (d: PairData): { z: Array<Zone | null>; zp: Array<Zone | null> } => {
  const z: Array<Zone | null> = new Array(d.n).fill(null);
  const zp: Array<Zone | null> = new Array(d.n).fill(null);
  for (let i = W - 1; i < d.n; i++) {
    const r = macd(d.mid.slice(i - W + 1, i + 1));
    const a = zoneAt(r, W - 1);
    const b = zoneAt(r, W - 2);
    z[i] = a ? { m: a.m, top: a.top, bottom: a.bottom } : null;
    zp[i] = b ? { m: b.m, top: b.top, bottom: b.bottom } : null;
  }
  return { z, zp };
};

// ---- the trades ---------------------------------------------------------------------------------------

type Result = "reached" | "failed" | "open";
interface WayOut {
  result: Result;
  jx: number;
  T: number;
  exit: number;
  pips: number;
  mae: number;
  bars: number;
  share: number;
}
interface Trade {
  pair: string;
  i: number;
  open: number;
  T: number;
  side: "BUY" | "SELL";
  zside: Side;
  entry: number;
  share0: number;
  already: boolean;
  A: WayOut | null;
  B: WayOut | null;
}

// whole points of a price, so that both implementations make the same pips
const P = (x: number, d: number) => Math.round(x * 10 ** d);

const follow = (d: PairData, z: Array<Zone | null>, tr: Trade, way: "A" | "B"): WayOut => {
  const dec = decimalsOf(d.pair);
  const pe = P(tr.entry, dec);
  let jx = d.n - 1;
  let result: Result = "open";
  let worst = 0;
  for (let j = tr.i + 1; j < d.n; j++) {
    // the worst against the trade so far, this bar included
    const adv = tr.side === "BUY" ? pe - P(d.bl[j], dec) : P(d.ah[j], dec) - pe;
    if (adv > worst) worst = adv;
    const zj = z[j];
    if (zj === null) throw new Error(`${d.pair} ${iso(d.t[j])}: no zone on a followed bar`);
    if (atShare(zj, tr.zside, REACH)) {
      result = "reached";
      jx = j;
      break;
    }
    const failed = way === "A" ? !atShare(zj, tr.zside, ENTER) : tr.zside === "top" ? zj.m <= 0 : zj.m >= 0;
    if (failed) {
      result = "failed";
      jx = j;
      break;
    }
  }
  const exit = tr.side === "BUY" ? d.bc[jx] : d.ac[jx];
  const pts = tr.side === "BUY" ? P(exit, dec) - pe : pe - P(exit, dec);
  const zx = z[jx] as Zone;
  return { result, jx, T: d.t[jx] + HOUR, exit, pips: pts / 10, mae: worst / 10, bars: jx - tr.i, share: shareOf(zx, tr.zside) };
};

const tradesOf = (d: PairData): { trades: Trade[]; z: Array<Zone | null>; zp: Array<Zone | null> } => {
  const { z, zp } = zonesOf(d);
  const trades: Trade[] = [];
  for (let i = W - 1; i < d.n; i++) {
    const T = d.t[i] + HOUR;
    if (T < START || T >= END) continue;
    const a = z[i];
    const b = zp[i];
    if (a === null || b === null) continue;
    let zside: Side | null = null;
    for (const s of ["top", "bottom"] as Side[]) if (atShare(a, s, ENTER) && !atShare(b, s, ENTER)) zside = s;
    if (zside === null) continue;
    const side = zside === "top" ? "BUY" : "SELL";
    const tr: Trade = {
      pair: d.pair,
      i,
      open: d.t[i],
      T,
      side,
      zside,
      entry: side === "BUY" ? d.ac[i] : d.bc[i],
      share0: shareOf(a, zside),
      already: atShare(a, zside, REACH),
      A: null,
      B: null,
    };
    if (!tr.already) {
      tr.A = follow(d, z, tr, "A");
      tr.B = follow(d, z, tr, "B");
    }
    trades.push(tr);
  }
  return { trades, z, zp };
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
    barsMedian: median(dec.map((w) => w.bars)),
    barsMax: dec.length ? Math.max(...dec.map((w) => w.bars)) : null,
    openPipsSum: open.length ? openPipsSum : null,
    openPipsWorst: open.length ? Math.min(...open.map((w) => w.pips)) : null,
  };
};
type WayStats = ReturnType<typeof wayStats>;

const groupOf = (ts: Trade[]) => ({
  entries: ts.length,
  already: ts.filter((t) => t.already).length,
  A: wayStats(ts.filter((t) => !t.already).map((t) => t.A as WayOut)),
  B: wayStats(ts.filter((t) => !t.already).map((t) => t.B as WayOut)),
});
type Group = ReturnType<typeof groupOf>;

const ordered = (all: Trade[]): Trade[] =>
  [...all].sort((a, b) => a.T - b.T || PAIRS.indexOf(a.pair as typeof PAIRS[number]) - PAIRS.indexOf(b.pair as typeof PAIRS[number]));

const summaryOf = (trades: Trade[], ds: PairData[]) => {
  const groups: Record<string, Group> = { all: groupOf(trades) };
  for (const p of PAIRS) groups[p] = groupOf(trades.filter((t) => t.pair === p));
  for (const s of ["BUY", "SELL"]) groups[s] = groupOf(trades.filter((t) => t.side === s));
  return {
    meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM) },
    pairs: ds.map((d) => ({ pair: d.pair, bars: d.n, entries: trades.filter((t) => t.pair === d.pair).length })),
    groups,
  };
};

const HEAD = ["pair", "open", "T", "side", "entry", "share0", "already", "A_result", "A_T", "A_exit", "A_pips", "A_mae", "A_bars", "A_share", "B_result", "B_T", "B_exit", "B_pips", "B_mae", "B_bars", "B_share"];
const wayCells = (w: WayOut | null) => (w ? [w.result, iso(w.T), String(w.exit), String(w.pips), String(w.mae), String(w.bars), String(w.share)] : ["", "", "", "", "", "", ""]);
const csvOf = (trades: Trade[]): string =>
  [HEAD.join(","), ...trades.map((t) => [t.pair, iso(t.open), iso(t.T), t.side, String(t.entry), String(t.share0), t.already ? "1" : "0", ...wayCells(t.A), ...wayCells(t.B)].join(","))].join("\n") + "\n";

const fmt = (v: number | null, k = 2) => (v === null ? "-" : v.toFixed(k));
const printWay = (name: string, w: WayStats) =>
  `${name}: reached ${w.reached} failed ${w.failed} open ${w.open} rate ${fmt(w.rate, 1)}% | pips sum ${fmt(w.pipsSum, 1)} mean ${fmt(w.pipsMean)} median ${fmt(w.pipsMedian)} (reached ${fmt(w.reachedPipsMean)}, failed ${fmt(w.failedPipsMean)}) | mae median ${fmt(w.maeMedian, 1)} max ${fmt(w.maeMax, 1)} | bars median ${fmt(w.barsMedian, 1)} max ${fmt(w.barsMax, 0)} | open pips sum ${fmt(w.openPipsSum, 1)} worst ${fmt(w.openPipsWorst, 1)}`;
const printSummary = (s: ReturnType<typeof summaryOf>) => {
  console.log(`meta ${JSON.stringify(s.meta)}`);
  console.log(`pairs ${JSON.stringify(s.pairs)}`);
  for (const [k, g] of Object.entries(s.groups)) {
    console.log(`${k.padEnd(8)} entries ${g.entries} already ${g.already}`);
    console.log(`  ${printWay("A (the band)", g.A)}`);
    console.log(`  ${printWay("B (zero line)", g.B)}`);
  }
};

// ---- loading ------------------------------------------------------------------------------------------

const loadFiles = async (src: Source): Promise<{ data: PairData[]; st: LoadStats }> => {
  const st = newLoadStats();
  const data: PairData[] = [];
  const weekend = weekendOutOf("inside");
  for (const pair of PAIRS) {
    const h = await loadTf(src, pair, "1h", LOAD_FROM, END, st, weekend);
    const d = dataOf(pair, quotesOf(h.bars));
    data.push(d);
    console.log(`${pair}: 1h ${h.bars.n} chart ${d.n} (from ${d.n ? iso(d.t[0]) : "-"})`);
  }
  return { data, st };
};

// the walk's 1-minute bars cut into GMO's 1-hour grid (research/macdlive.ts coarsen, as it is)
const coarsen = (m: M1, step: number): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  let cur: QuoteCandle | null = null;
  let curT = NaN;
  for (let k = 0; k < m.n; k++) {
    const t = Math.floor(m.t[k] / step) * step;
    if (t !== curT) {
      if (cur) out.push(cur);
      curT = t;
      const datetime = new Date(t).toISOString();
      cur = { datetime, bid: { datetime, open: m.bo[k], high: m.bh[k], low: m.bl[k], close: m.bc[k] }, ask: { datetime, open: m.ao[k], high: m.ah[k], low: m.al[k], close: m.ac[k] } };
    } else if (cur) {
      cur.bid.high = Math.max(cur.bid.high, m.bh[k]);
      cur.bid.low = Math.min(cur.bid.low, m.bl[k]);
      cur.bid.close = m.bc[k];
      cur.ask.high = Math.max(cur.ask.high, m.ah[k]);
      cur.ask.low = Math.min(cur.ask.low, m.al[k]);
      cur.ask.close = m.ac[k];
    }
  }
  if (cur) out.push(cur);
  return out;
};

const walkM1 = (seed: number, pair: string): M1 => synthesize(pair, PAIRS.indexOf(pair as typeof PAIRS[number]), { seed, trend: 0, startPips: null }, LOAD_FROM, END).m1;

// every price of a walk at or after `fromMs` moved by `pips` (the rewritten future of the look-ahead check)
const poisoned = (m: M1, fromMs: number, pips: number): M1 => {
  const u = unitOf(m.pair) * pips;
  const add = (xs: Float64Array) => Float64Array.from(xs, (v, k) => (m.t[k] >= fromMs ? v + u : v));
  return { ...m, bo: add(m.bo), bh: add(m.bh), bl: add(m.bl), bc: add(m.bc), ao: add(m.ao), ah: add(m.ah), al: add(m.al), ac: add(m.ac) };
};

const writeWalkFiles = async (dir: string, seed: number) => {
  for (const pair of PAIRS) {
    const q = coarsen(walkM1(seed, pair), HOUR);
    await writeWalk(dir, pair, { "5min": emptyBars(0), "15min": emptyBars(0), "1h": fromQuotes(q, (t) => ruleKeyOf("1h", t)), "4h": emptyBars(0) }, LOAD_FROM, END);
  }
};

// ---- the checks on the walk ----------------------------------------------------------------------------

const sameWay = (a: WayOut | null, b: WayOut | null) =>
  a === null || b === null ? a === b : a.result === b.result && a.jx === b.jx && a.pips === b.pips && a.mae === b.mae && a.share === b.share;

const checkWalk = (seed: number): number => {
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    if (fail <= 30) console.log(`  CHECK FAILED: ${msg}`);
  };
  const all: Trade[] = [];
  let compared95 = 0;
  let lookahead = 0;
  for (const pair of PAIRS) {
    const m1 = walkM1(seed, pair);
    const d = dataOf(pair, coarsen(m1, HOUR));
    const { trades, z, zp } = tradesOf(d);
    all.push(...trades);
    // the 95% entry computed here against the email's own code, on every bar
    const bars = d.mid.map((c) => ({ close: c }));
    for (let i = W - 1; i < d.n; i++) {
      const a = z[i];
      const b = zp[i];
      let mine: string | null = null;
      if (a && b) {
        if (atShare(a, "top", 0.95) && !atShare(b, "top", 0.95)) mine = "SELL";
        if (atShare(a, "bottom", 0.95) && !atShare(b, "bottom", 0.95)) mine = "BUY";
      }
      const theirs = decideZoneOnWindow(bars, i)?.side ?? null;
      compared95++;
      if (mine !== theirs) bad(`${pair} ${iso(d.t[i])}: the 95% entry here ${mine}, decideZoneOnWindow ${theirs}`);
    }
    // the counts and way A against way B
    for (const t of trades) {
      if (t.already !== (t.A === null && t.B === null)) bad(`${pair} ${iso(t.T)}: already and the ways disagree`);
      if (t.A && t.B && t.A.result === "reached" && !(t.B.result === "reached" && t.B.jx === t.A.jx)) bad(`${pair} ${iso(t.T)}: A reached but B not on the same bar`);
      if (t.share0 < ENTER) bad(`${pair} ${iso(t.T)}: share0 ${t.share0} under 90%`);
    }
    // the look-ahead check on a sample: the future after the entry's bar, and after each way's last bar, rewritten
    const sample = trades.filter((t) => !t.already && t.A && t.A.result !== "open").filter((_, k) => k % 7 === 0).slice(0, 6);
    for (const t of sample) {
      for (const pips of [300, -300]) {
        const cuts: Array<[number, (u: Trade) => boolean]> = [
          [t.T, (u) => u.side === t.side && u.entry === t.entry && u.share0 === t.share0],
          [(t.A as WayOut).T, (u) => sameWay(u.A, t.A)],
          [(t.B as WayOut).T, (u) => (t.B as WayOut).result === "open" || sameWay(u.B, t.B)],
        ];
        for (const [cut, same] of cuts) {
          const again = tradesOf(dataOf(pair, coarsen(poisoned(m1, cut, pips), HOUR))).trades.find((u) => u.T === t.T);
          lookahead++;
          if (!again) bad(`${pair} ${iso(t.T)}: the entry went when the future after ${iso(cut)} moved ${pips}`);
          else if (!same(again)) bad(`${pair} ${iso(t.T)}: changed when the future after ${iso(cut)} moved ${pips}`);
        }
      }
    }
  }
  const s = summaryOf(ordered(all), []);
  for (const [k, g] of Object.entries(s.groups)) {
    for (const w of [g.A, g.B]) if (w.reached + w.failed + w.open + g.already !== g.entries) bad(`${k}: the counts do not add up`);
  }
  if (s.groups.all.A.reached === 0 || s.groups.all.A.failed === 0) bad("the walk has no reached or no failed trade: the checks compared too little");
  console.log(`walk seed ${seed}: entries ${s.groups.all.entries} already ${s.groups.all.already}; 95% entries compared ${compared95}; look-ahead compared ${lookahead}`);
  console.log(`  ${printWay("A", s.groups.all.A)}`);
  console.log(`  ${printWay("B", s.groups.all.B)}`);
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
    const { data, st } = await loadFiles(walk ? { dir: `${OUT}/gmo`, fetch: false } : { dir: "research/.cache", fetch: true });
    console.log(`files ${st.files} requests ${st.requests} cached ${st.cached} partial ${st.partial} failed ${st.failed} ${st.failedExamples.join("; ")}`);
    if (st.failed) {
      console.log("some files could not be read: stop");
      Deno.exit(1);
    }
    const trades = ordered(data.flatMap((d) => tradesOf(d).trades));
    await Deno.writeTextFile(`${OUT}/rows.csv`, csvOf(trades));
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify(summaryOf(trades, data), null, 1));
    // the numbers are printed by the workflow only after the Python agreed (research/macd90-check.py)
    console.log(`written: ${trades.length} rows`);
  } else if (MODE === "print") {
    printSummary(JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`)));
  }
}
