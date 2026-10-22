// #378 (docs §8.125): Rakuten FX's ピークボトム (the chart's yellow and green marks, term 10) as 1-hour emails. A: a
// mark mailed when its 10 later bars are in (確定した時); B: a new mark mailed at the close of the bar it first shows
// on (仮の丸・足の確定で判断); C: the same judged minute by minute while the bar forms (仮の丸・途中の足). Each email
// followed the owner's way (§8.102's main row: a limit at E two minutes after the email, TP 10 pips, no stop) and by
// the email's guide (stop 13, TP 4), and the same email the other way round (the owner's way), on GMO's 1-minute
// bars; one email at a time (資金の限りなし).
//
//   MODE=real       GMO's files: research/.cache (tf-winrate's layout), fetched when missing (GitHub's runners
//                   reach GMO; the development container cannot). Writes research/out/pbz/{rows.csv,summary.json}.
//   MODE=synthetic  a seeded walk of 1-minute bars (ownerhold-data synthesize), its 1-hour bars made from it, the
//                   same pipeline, and the checks: the marks the fast way against M_k from scratch (C's forming
//                   bars too), the look-ahead check (every price from a time c on moved: the emails up to c and M_k
//                   up to c unchanged), the counts adding up, and the halves.
//   MODE=walkfiles  the walk of SEEDS' first seed written as GMO's files under OUT/gmo (1-minute and 15-minute day
//                   files as ownerhold-data writes them, 1-hour day files as trend-data's writeWalk), then read back
//                   through the real run's loaders (nothing fetched) and the study written to OUT as the real run
//                   writes it: what research/pbz-check.py is run on first.
//   MODE=print      the numbers of a run already written (read only).
//
// Nothing here sends an email; the numbers are the study's only.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { type LoadStats, type M1, type Source, loadM1, newLoadStats, synthesize, unitOf, writeGmoFiles } from "./ownerhold-data.ts";
import { type Book, makeBook } from "./ownerhold-trades.ts";
import { nyClosesBetween } from "./money-trades.ts";
import { loadTf, quotesOf, ruleKeyOf, writeWalk } from "./trend-data.ts";
import { type Bars, emptyBars, fromQuotes, weekendOutOf } from "./trend-labels.ts";
import {
  BOOT_SEED,
  type Cand,
  CANDS,
  DRAWS,
  type PbBar,
  type PbMail,
  type Row,
  TERM,
  bootstrap,
  cutOf,
  gapCut,
  gapOwn,
  guideStats,
  mailsOf,
  marksAtSlow,
  meanCut,
  meanOpp,
  meanOwn,
  oppositeOf,
  ownerStats,
  readsOf,
  testsAt,
  tradeOf,
} from "./pbz-lib.ts";
import { DAY, HOUR } from "./lib.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-10-17T00:00:00Z"));
const SPLIT = Date.parse(env("SPLIT", "2025-05-19T00:00:00Z"));
// the bars before START the marks read
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-10-01T00:00:00Z"));
// the later start of the start check (the marks read from here must give the same emails)
const LATE_FROM = Date.parse(env("LATE_FROM", "2023-12-01T00:00:00Z"));
const OUT = env("OUT", "research/out/pbz");

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const monthOf = (ms: number) => iso(ms).slice(0, 7);
const pairIndex = (pair: string) => PAIRS.indexOf(pair as typeof PAIRS[number]);
const halfOf = (T: number): 1 | 2 => (T < SPLIT ? 1 : 2);

// The pair's closed 1-hour bars: the bid high and low (the marks: Rakuten's chart is drawn on the bid) and the mid
// close as the chart rounds it (historyRead: Number(v.toFixed(d))), A's and B's E
const pbBars = (pair: string, qs: QuoteCandle[]): PbBar[] => {
  const mid = new Map(historyRead(pair, "1h", qs, END).candles.map((c) => [Date.parse(c.datetime.replace(" ", "T") + "Z"), c.close]));
  const out: PbBar[] = [];
  for (const q of qs) {
    const t = Date.parse(q.datetime);
    const close = mid.get(t);
    if (close === undefined) continue;
    out.push({ t, hi: q.bid.high, lo: q.bid.low, close });
  }
  return out;
};

interface PairData {
  pair: string;
  bars: PbBar[];
  m1: M1;
  book: Book;
}

// ---- the pipeline ---------------------------------------------------------------------------------

type Halves<T> = { half1: T; half2: T; both: T };

interface PairOut {
  pair: string;
  bars: number;
  firstBar: string | null;
  // bars whose close is in [START, END)
  judged: number;
  // M_END's marks on bars whose close is in [START, END), by kind and half
  marks: Record<"peak" | "bottom", Halves<number>>;
  // ①: bars whose close is in [START, END) both a peak and a bottom candidate in M_END: their 10 later bars there
  // (full) or not (edge), by half
  bothBars: { full: Halves<number>; edge: Halves<number> };
  closed: Record<Cand, Halves<number>>;
  cVanished: number;
  cBarDiff: number;
  cBarsSeen: number;
  rows: Row[];
}

const halvesOf = <T>(f: (inHalf: (T: number) => boolean) => T): Halves<T> => ({
  half1: f((T) => T < SPLIT),
  half2: f((T) => T >= SPLIT),
  both: f(() => true),
});

const runPair = (d: PairData): PairOut => {
  const bars = d.bars;
  const { reads, final } = readsOf(bars);
  const out = mailsOf(d.pair, bars, reads, d.m1, START, END);
  const kept = new Set(final.map((x) => `${x.i}:${x.kind}`));
  const rows: Row[] = out.mails.map((mail) => {
    const half = halfOf(mail.T);
    return {
      mail,
      half,
      month: monthOf(mail.T),
      trade: tradeOf(d.book, mail, END),
      opp: oppositeOf(d.book, mail, END),
      cut: half === 1 ? cutOf(d.book, mail, SPLIT) : null,
      stays: kept.has(`${mail.mark.i}:${mail.mark.kind}`),
      otherKind: kept.has(`${mail.mark.i}:${mail.mark.kind === "peak" ? "bottom" : "peak"}`),
    };
  });
  const last = bars.length - 1;
  const closeOf = (i: number) => bars[i].t + HOUR;
  const inPeriod = (i: number) => closeOf(i) >= START && closeOf(i) < END;
  const count = (pred: (i: number) => boolean) => halvesOf((inHalf) => bars.reduce((n, _, i) => n + (inPeriod(i) && inHalf(closeOf(i)) && pred(i) ? 1 : 0), 0));
  const bothAt = (i: number) => {
    const t = testsAt(bars, i, last);
    return t.peak && t.bottom;
  };
  const markKinds = new Map(final.map((m) => [m.i, m.kind]));
  return {
    pair: d.pair,
    bars: bars.length,
    firstBar: bars.length ? iso(bars[0].t) : null,
    judged: bars.reduce((n, _, i) => n + (inPeriod(i) ? 1 : 0), 0),
    marks: { peak: count((i) => markKinds.get(i) === "peak"), bottom: count((i) => markKinds.get(i) === "bottom") },
    bothBars: { full: count((i) => i + TERM <= last && bothAt(i)), edge: count((i) => i + TERM > last && bothAt(i)) },
    closed: Object.fromEntries(CANDS.map((c) => [c, halvesOf((inHalf) => out.closedTimes.filter((x) => x.cand === c && inHalf(x.T)).length)])) as Record<Cand, Halves<number>>,
    cVanished: out.cVanished,
    cBarDiff: out.cBarDiff,
    cBarsSeen: out.cBarsSeen,
    rows,
  };
};

// every pair's rows: by the email's time, then by the pair's place in PAIRS, then A, B, C
const merged = (outs: PairOut[]): Row[] =>
  outs.flatMap((o) => o.rows).sort((a, b) => a.mail.T - b.mail.T || pairIndex(a.mail.pair) - pairIndex(b.mail.pair) || CANDS.indexOf(a.mail.cand) - CANDS.indexOf(b.mail.cand));

const statsOfRows = (rows: readonly Row[]) => {
  const gone = rows.filter((r) => !r.stays);
  const both = rows.filter((r) => r.mail.both);
  return {
    own: ownerStats(rows.map((r) => r.trade.own)),
    guide: guideStats(rows.map((r) => r.trade.guide)),
    opp: ownerStats(rows.map((r) => r.opp)),
    // the emails' marks not in M_END (the same bar of the other kind there: otherKind), and their main numbers
    gone: gone.length,
    goneOtherKind: gone.filter((r) => r.otherKind).length,
    goneOwn: ownerStats(gone.map((r) => r.trade.own)),
    // decided while the mark's bar was both (a peak): their main numbers, and the other way's
    both: both.length,
    bothOwn: ownerStats(both.map((r) => r.trade.own)),
    bothOpp: ownerStats(both.map((r) => r.opp)),
    weekFirst: rows.filter((r) => r.mail.weekFirst).length,
    buy: rows.filter((r) => r.mail.dir === 1).length,
    sell: rows.filter((r) => r.mail.dir === -1).length,
  };
};
type Table = ReturnType<typeof statsOfRows>;

const tableOf = (rows: readonly Row[]): Halves<Table> => ({
  half1: statsOfRows(rows.filter((r) => r.half === 1)),
  half2: statsOfRows(rows.filter((r) => r.half === 2)),
  both: statsOfRows(rows),
});

// the same bar k (and pair) mailing A and B, and A and C
const sameBar = (rows: readonly Row[], c: Cand) => {
  const key = (r: Row) => `${r.mail.pair}|${r.mail.k}|${r.mail.open}`;
  const a = new Set(rows.filter((r) => r.mail.cand === "A").map(key));
  return rows.filter((r) => r.mail.cand === c && a.has(key(r))).length;
};

const sumHalves = (xs: Array<Halves<number>>): Halves<number> => ({
  half1: xs.reduce((s, x) => s + x.half1, 0),
  half2: xs.reduce((s, x) => s + x.half2, 0),
  both: xs.reduce((s, x) => s + x.both, 0),
});

const summaryOf = (rows: Row[], outs: PairOut[]) => {
  const of = (c: Cand) => rows.filter((r) => r.mail.cand === c);
  const tables: Record<string, Record<string, Halves<Table>>> = {};
  for (const c of CANDS) {
    tables[c] = { all: tableOf(of(c)) };
    for (const pair of PAIRS) tables[c][pair] = tableOf(of(c).filter((r) => r.mail.pair === pair));
  }
  // 1: the first half, as known at SPLIT, picks the highest mean of A, B and C; a tie: the earlier of A, B, C;
  // none with a filled trade: A
  const h1 = (c: Cand) => of(c).filter((r) => r.half === 1);
  const stage1Means = Object.fromEntries(CANDS.map((c) => [c, meanCut(h1(c))])) as Record<Cand, number | null>;
  let chosen: Cand = "A";
  let best: number | null = null;
  for (const c of CANDS) {
    const m = stage1Means[c];
    if (m !== null && (best === null || m > best)) {
      best = m;
      chosen = c;
    }
  }
  // the first half's trades still held at SPLIT, and their pips at END
  const heldAtSplit = Object.fromEntries(CANDS.map((c) => {
    const xs = h1(c).filter((r) => r.cut && r.cut.own.filled && r.cut.own.held);
    return [c, { n: xs.length, pipsAtEnd: xs.reduce((s, r) => s + (r.trade.own.pips as number), 0) }];
  }));
  // 2: the second half, the chosen one only, against the same emails the other way round
  const h2 = (c: Cand) => of(c).filter((r) => r.half === 2);
  const point = (c: Cand) => {
    const x = h2(c);
    return { cand: c, mean: meanOwn(x), oppMean: meanOpp(x), gap: gapOwn(x) };
  };
  const boot = bootstrap(h2(chosen));
  const better = boot.gapLo !== null && boot.ownLo !== null && boot.gapLo > 0 && boot.ownLo > 0;
  const worse = boot.gapHi !== null && boot.gapHi < 0;
  const x2 = h2(chosen);
  return {
    meta: { start: iso(START), end: iso(END), split: iso(SPLIT), loadFrom: iso(LOAD_FROM), term: TERM, draws: DRAWS, bootSeed: BOOT_SEED },
    stage1: { means: stage1Means, chosen, heldAtSplit },
    stage2: { ...point(chosen), boot, verdict: better ? "better" : worse ? "worse" : "indistinguishable" },
    // written beside, not judged on
    beside: {
      firstHalfGap: gapCut(h1(chosen)),
      pairGaps: Object.fromEntries(PAIRS.map((p) => [p, gapOwn(x2.filter((r) => r.mail.pair === p))])),
      buyGap: gapOwn(x2.filter((r) => r.mail.dir === 1)),
      sellGap: gapOwn(x2.filter((r) => r.mail.dir === -1)),
      others: CANDS.filter((c) => c !== chosen).map(point),
    },
    tables,
    counts: {
      marks: { peak: sumHalves(outs.map((o) => o.marks.peak)), bottom: sumHalves(outs.map((o) => o.marks.bottom)) },
      bothBars: { full: sumHalves(outs.map((o) => o.bothBars.full)), edge: sumHalves(outs.map((o) => o.bothBars.edge)) },
      closed: Object.fromEntries(CANDS.map((c) => [c, sumHalves(outs.map((o) => o.closed[c]))])),
      sameBarAB: sameBar(rows, "B"),
      sameBarAC: sameBar(rows, "C"),
      cVanished: outs.reduce((s, o) => s + o.cVanished, 0),
      cBarDiff: outs.reduce((s, o) => s + o.cBarDiff, 0),
      cBarsSeen: outs.reduce((s, o) => s + o.cBarsSeen, 0),
    },
  };
};

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const csvOf = (rows: Row[]): string => {
  const head = [
    "cand", "pair", "k", "open", "T", "side", "E", "markI", "markT", "markKind", "markPrice", "both", "weekFirst", "stays", "otherKind", "half", "month",
    "filled", "market", "fillT", "fill", "tp", "tpT", "exit", "endPx", "pips", "mae", "hold", "g_result", "g_pips", "g_both",
    "o_filled", "o_market", "o_fillT", "o_fill", "o_tp", "o_tpT", "o_pips", "o_mae", "o_hold",
    "s_filled", "s_tp", "s_held", "s_pips", "so_filled", "so_pips",
  ];
  const out = [head.join(",")];
  for (const r of rows) {
    const o = r.trade.own;
    const p = o.path;
    const q = r.opp;
    const pq = q.path;
    const s = r.cut;
    out.push([
      r.mail.cand, r.mail.pair, String(r.mail.k), iso(r.mail.open), iso(r.mail.T), r.mail.side, String(r.mail.E),
      String(r.mail.mark.i), iso(r.mail.markOpen), r.mail.mark.kind, String(r.mail.mark.price), r.mail.both ? "1" : "0", r.mail.weekFirst ? "1" : "0",
      r.stays ? "1" : "0", r.otherKind ? "1" : "0", String(r.half), r.month,
      o.filled ? "1" : "0", p.market ? "1" : "0", o.filled ? iso(p.t0) : "", o.filled ? String(p.fill) : "",
      o.tp ? "1" : "0", o.tp ? iso(p.x) : "", o.tp ? String(p.exit) : "", o.held ? String(p.endPx) : "",
      num(o.pips), num(o.mae), num(o.hold),
      r.trade.guide?.result ?? "", r.trade.guide ? String(r.trade.guide.pips) : "", r.trade.guide ? (r.trade.guide.both ? "1" : "0") : "",
      q.filled ? "1" : "0", pq.market ? "1" : "0", q.filled ? iso(pq.t0) : "", q.filled ? String(pq.fill) : "",
      q.tp ? "1" : "0", q.tp ? iso(pq.x) : "", num(q.pips), num(q.mae), num(q.hold),
      s ? (s.own.filled ? "1" : "0") : "", s ? (s.own.tp ? "1" : "0") : "", s ? (s.own.held ? "1" : "0") : "", s ? num(s.own.pips) : "",
      s ? (s.opp.filled ? "1" : "0") : "", s ? num(s.opp.pips) : "",
    ].join(","));
  }
  return out.join("\n") + "\n";
};

// ---- the data ---------------------------------------------------------------------------------------

const bookOf = (m: M1): Book => makeBook(m, Float64Array.from(nyClosesBetween(LOAD_FROM - DAY, END).map((c) => c.tau)), true);

const loadFiles = async (src: Source): Promise<{ data: PairData[]; st: LoadStats }> => {
  const st = newLoadStats();
  const data: PairData[] = [];
  const weekend = weekendOutOf("inside");
  for (const pair of PAIRS) {
    const h = await loadTf(src, pair, "1h", LOAD_FROM, END, st, weekend);
    const m1 = await loadM1(src, pair, START, END, st);
    const bars = pbBars(pair, quotesOf(h.bars));
    data.push({ pair, bars, m1, book: bookOf(m1) });
    console.log(`${pair}: 1h ${h.bars.n} (from ${h.bars.n ? iso(h.bars.t[0]) : "-"}), bars used ${bars.length}, 1min ${m1.n}`);
  }
  return { data, st };
};

// the walk's 1-minute bars cut into GMO's grid of `step` (first open, highest high, lowest low, last close, each side)
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

// the walk's hourly bars as the real run reads them: weekend bars (start and end inside the closure) left out
const weekendOut = weekendOutOf("inside");
const hourly = (m: M1): QuoteCandle[] => coarsen(m, HOUR).filter((q) => !weekendOut(Date.parse(q.datetime), HOUR) && Date.parse(q.datetime) + HOUR <= END);

// the walk written as GMO's files: its 1-minute and 15-minute day files, and its 1-hour day files (the other
// timeframes empty), every day key a read of [LOAD_FROM, END) opens
const writeWalkFiles = async (dir: string, seed: number) => {
  for (const pair of PAIRS) {
    const { m1, q15 } = synthesize(pair, pairIndex(pair), { seed, trend: 0, startPips: null }, LOAD_FROM, END);
    const h: Bars = fromQuotes(coarsen(m1, HOUR), (t) => ruleKeyOf("1h", t));
    await writeWalk(dir, pair, { "5min": emptyBars(0), "15min": emptyBars(0), "1h": h, "4h": emptyBars(0) }, LOAD_FROM, END);
    await writeGmoFiles(dir, pair, { m1, q15 }, LOAD_FROM, END);
  }
};

// every price of a walk at or after `fromMs` moved by `pips` (the rewritten future of the look-ahead check)
const poisoned = (m: M1, fromMs: number, pips: number): M1 => {
  const u = unitOf(m.pair) * pips;
  const add = (xs: Float64Array) => Float64Array.from(xs, (v, k) => (m.t[k] >= fromMs ? v + u : v));
  return { ...m, bo: add(m.bo), bh: add(m.bh), bl: add(m.bl), bc: add(m.bc), ao: add(m.ao), ah: add(m.ah), al: add(m.al), ac: add(m.ac) };
};

// the walk's 1-minute bars from START on (the real run reads them from START)
const fromStart = (m: M1): M1 => {
  const a = m.t.findIndex((t) => t >= START);
  const s = a < 0 ? m.n : a;
  const cut = (xs: Float64Array) => xs.slice(s);
  return { pair: m.pair, n: m.n - s, t: cut(m.t), bo: cut(m.bo), bh: cut(m.bh), bl: cut(m.bl), bc: cut(m.bc), ao: cut(m.ao), ah: cut(m.ah), al: cut(m.al), ac: cut(m.ac) };
};

const synthPair = (seed: number, pair: string, cut?: { T: number; pips: number }): PairData => {
  const { m1 } = synthesize(pair, pairIndex(pair), { seed, trend: 0, startPips: null }, LOAD_FROM, END);
  const m = cut ? poisoned(m1, cut.T, cut.pips) : m1;
  const m1s = fromStart(m);
  return { pair, bars: pbBars(pair, hourly(m)), m1: m1s, book: bookOf(m1s) };
};

// ---- the checks ----------------------------------------------------------------------------------------

const mailKey = (m: PbMail) => [m.cand, m.pair, m.T, m.side, m.E, m.markOpen, m.mark.kind, m.mark.price, m.both].join("|");

const checkWalk = (seed: number) => {
  const datas = PAIRS.map((pair) => synthPair(seed, pair));
  const outs = datas.map((d) => runPair(d));
  const rows = merged(outs);
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    console.log(`  CHECK FAILED: ${msg}`);
  };
  // the fast marks against M_k from scratch: every 37th bar of each pair, and M at the last bar
  let slowCompared = 0;
  for (const d of datas) {
    const { reads, final } = readsOf(d.bars);
    for (let k = 0; k < d.bars.length; k += 37) {
      const slow = marksAtSlow(d.bars, k);
      const newest = slow.length ? slow[slow.length - 1] : null;
      const fixedHere = k - TERM >= 0 && slow.some((m) => m.i === k - TERM);
      slowCompared++;
      if (JSON.stringify(newest) !== JSON.stringify(reads[k].newest) || fixedHere !== reads[k].fixedHere) bad(`${d.pair} k=${k}: the fast marks differ from M_k from scratch`);
    }
    if (JSON.stringify(final) !== JSON.stringify(marksAtSlow(d.bars, d.bars.length - 1))) bad(`${d.pair}: M at the last bar differs from scratch`);
  }
  // C's marks against M from scratch on the forming bar: every C email's bar, at its minute
  let cCompared = 0;
  for (const r of rows.filter((x) => x.mail.cand === "C").slice(0, 60)) {
    const d = datas[pairIndex(r.mail.pair)];
    const k = r.mail.k;
    const a = d.m1.t.findIndex((t) => t >= d.bars[k].t);
    let hi = -Infinity;
    let lo = Infinity;
    for (let q = a; q < d.m1.n && d.m1.t[q] < r.mail.T; q++) {
      hi = Math.max(hi, d.m1.bh[q]);
      lo = Math.min(lo, d.m1.bl[q]);
    }
    const slow = marksAtSlow(d.bars, k, { t: d.bars[k].t, hi, lo, close: NaN });
    cCompared++;
    if (JSON.stringify(slow.at(-1)) !== JSON.stringify(r.mail.mark)) bad(`${r.mail.pair} ${iso(r.mail.T)} C: the mark differs from M from scratch on the forming bar`);
  }
  // the counts add up
  for (const c of CANDS) {
    const rc = rows.filter((r) => r.mail.cand === c);
    const t = tableOf(rc);
    if (t.half1.own.mails + t.half2.own.mails !== t.both.own.mails) bad(`${c}: half1 + half2 ≠ all`);
    for (const h of [t.half1, t.half2, t.both]) {
      for (const o of [h.own, h.opp]) if (o.filled + o.unfilled !== o.mails || o.tp + o.held !== o.filled) bad(`${c}: filled/unfilled/tp/held do not add up`);
      if (h.buy + h.sell !== h.own.mails) bad(`${c}: buy + sell ≠ all`);
    }
    if (PAIRS.reduce((n, p) => n + rc.filter((r) => r.mail.pair === p).length, 0) !== rc.length) bad(`${c}: the pairs do not add up`);
  }
  if (rows.some((r) => (r.half === 1) !== (r.mail.T < SPLIT))) bad("a half is wrong");
  if (rows.some((r) => (r.half === 1) !== (r.cut !== null))) bad("a first-half row without its cut, or a second-half row with one");
  // the look-ahead check: for some times c (every 23rd email's time, up to 12), every price from c on moved by
  // ±300 pips; the emails at or before c and M_k of the bars closed by c stay as they were
  const cuts = rows.filter((_, k) => k % 23 === 0).slice(0, 12).map((r) => ({ pair: r.mail.pair, c: r.mail.T }));
  let compared = 0;
  for (const { pair, c } of cuts) {
    const base = outs[pairIndex(pair)].rows.filter((r) => r.mail.T <= c).map((r) => mailKey(r.mail)).sort();
    const d0 = datas[pairIndex(pair)];
    const r0 = readsOf(d0.bars).reads;
    for (const pips of [300, -300]) {
      const d = synthPair(seed, pair, { T: c, pips });
      const again = runPair(d).rows.filter((r) => r.mail.T <= c).map((r) => mailKey(r.mail)).sort();
      compared++;
      if (JSON.stringify(again) !== JSON.stringify(base)) bad(`${pair} ${iso(c)}: the emails up to c moved with the future (${pips})`);
      const r1 = readsOf(d.bars).reads;
      for (let k = 0; k < Math.min(d.bars.length, d0.bars.length) && d0.bars[k].t + HOUR <= c; k++) {
        if (JSON.stringify(r1[k]) !== JSON.stringify(r0[k])) {
          bad(`${pair} ${iso(c)} k=${k}: M_k moved with the future (${pips})`);
          break;
        }
      }
    }
  }
  const s = summaryOf(rows, outs);
  const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(d));
  console.log(
    `walk seed ${seed}: emails A ${rows.filter((r) => r.mail.cand === "A").length} B ${rows.filter((r) => r.mail.cand === "B").length} C ${rows.filter((r) => r.mail.cand === "C").length}; ` +
      `slow compared ${slowCompared}, C ${cCompared}; look-ahead compared ${compared}; stage 1 means A ${fmt(s.stage1.means.A)} B ${fmt(s.stage1.means.B)} C ${fmt(s.stage1.means.C)} → ${s.stage1.chosen}; ` +
      `stage 2 gap ${fmt(s.stage2.gap)} [${fmt(s.stage2.boot.gapLo)}, ${fmt(s.stage2.boot.gapHi)}] mean [${fmt(s.stage2.boot.ownLo)}, ${fmt(s.stage2.boot.ownHi)}] → ${s.stage2.verdict}`,
  );
  for (const o of outs) console.log(`  ${o.pair}: bars ${o.bars}, judged ${o.judged}, emails ${o.rows.length}, C vanished ${o.cVanished}, C bars differing ${o.cBarDiff}/${o.cBarsSeen}`);
  return { fail, rows, summary: s };
};

// The start check (real data): the bars from LATE_FROM on give the same emails in the period
// (the emails only: the marks and A, B, C, no trade followed)
const startCheck = (data: PairData[], rows: Row[]): { compared: number; later: number; same: boolean } => {
  const base = rows.map((r) => mailKey(r.mail)).sort();
  const later = data.flatMap((d) => {
    const from = d.bars.findIndex((b) => b.t >= LATE_FROM);
    const bars = d.bars.slice(from < 0 ? d.bars.length : from);
    return mailsOf(d.pair, bars, readsOf(bars).reads, d.m1, START, END).mails.map(mailKey);
  }).sort();
  return { compared: base.length, later: later.length, same: JSON.stringify(base) === JSON.stringify(later) };
};

// ---- the print ------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const fmtN = (v: unknown, d = 2) => (v === null || v === undefined || typeof v !== "number" || !Number.isFinite(v) ? "" : v.toFixed(d));
// The owner's way of one group of trades: every number §8.125's tables ask for (the same as §8.124's)
const statsLine = (x: Json) =>
  `filled ${x.filled} unfilled ${x.unfilled} win ${fmtN(x.win)}% (${x.tp}/${x.filled}) mean ${fmtN(x.pipsMean)} median ${fmtN(x.pipsMedian)} pips` +
  ` | MAE median ${fmtN(x.maeMedian, 1)} max ${fmtN(x.maeMax, 1)} | hold median ${fmtN(x.holdMedian, 1)}h max ${fmtN(x.holdMax, 1)}h | held ${x.held} sum ${fmtN(x.heldPipsSum, 1)} worst ${fmtN(x.heldPipsMin, 1)}`;

const printTable = (name: string, h: Json) => {
  for (const half of ["half1", "half2", "both"]) {
    const t = h[half] as Json;
    const o = t.own as Json;
    const g = t.guide as Json;
    console.log(`  ${name.padEnd(8)} ${half.padEnd(5)} mails ${o.mails} (buy ${t.buy} sell ${t.sell}, after a gap ${t.weekFirst}) | owner: ${statsLine(o)}`);
    console.log(`      guide: win ${fmtN(g.guideWin)}% (tp ${g.guideTp} sl ${g.guideSl} held ${g.guideHeld} both ${g.guideBoth}) mean ${fmtN(g.guidePipsMean)} pips`);
    console.log(`      other way: ${statsLine(t.opp as Json)}`);
    console.log(`      not in M_END: ${t.gone} (the other kind there ${t.goneOtherKind}) | owner: ${statsLine(t.goneOwn as Json)}`);
    console.log(`      decided on a both bar: ${t.both} | owner: ${statsLine(t.bothOwn as Json)}`);
    console.log(`        its other way: ${statsLine(t.bothOpp as Json)}`);
    // every 100% row (the table's anywhere), with its worst against it and its longest hold (§8.125 出す数)
    const groups: Array<[string, Json]> = [["owner", o], ["other way", t.opp as Json], ["not in M_END", t.goneOwn as Json], ["both bar", t.bothOwn as Json], ["both bar, other way", t.bothOpp as Json]];
    for (const [label, x] of groups) {
      if (x.win === 100) console.log(`    100% (${label}, ${x.filled} filled): MAE max ${fmtN(x.maeMax, 1)}, hold max ${fmtN(x.holdMax, 1)}h`);
    }
    if (typeof g.guideWin === "number" && g.guideWin > 80) console.log(`    NOTE: the guide's win ${fmtN(g.guideWin)}% is far over §8.124's range: suspect a look-ahead before reading on`);
  }
};

// ---- main --------------------------------------------------------------------------------------------

if (import.meta.main) {
  // the print reads what the real run wrote, and writes nothing (it runs without --allow-write)
  if (MODE !== "print") await Deno.mkdir(OUT, { recursive: true });
  if (MODE === "synthetic") {
    let fail = 0;
    const seeds = env("SEEDS", "1,2").split(",").map(Number);
    for (const seed of seeds) {
      const w = checkWalk(seed);
      fail += w.fail;
      if (seed === seeds[0]) {
        await Deno.writeTextFile(`${OUT}/rows-syn.csv`, csvOf(w.rows));
        await Deno.writeTextFile(`${OUT}/summary-syn.json`, JSON.stringify(w.summary, null, 1));
      }
    }
    console.log(fail === 0 ? "ALL WALK CHECKS PASSED" : `${fail} WALK CHECKS FAILED`);
    if (fail) Deno.exit(1);
  } else if (MODE === "real" || MODE === "walkfiles") {
    const walk = MODE === "walkfiles";
    if (walk) await writeWalkFiles(`${OUT}/gmo`, Number(env("SEEDS", "1").split(",")[0]));
    const { data, st } = await loadFiles(walk ? { dir: `${OUT}/gmo`, fetch: false } : { dir: "research/.cache", fetch: true });
    console.log(`files ${st.files} requests ${st.requests} cached ${st.cached} partial ${st.partial} failed ${st.failed} ${st.failedExamples.join("; ")}`);
    if (st.failed > 0) console.log("NOTE: some files could not be read (counted above)");
    const outs = data.map((d) => runPair(d));
    const rows = merged(outs);
    await Deno.writeTextFile(`${OUT}/rows.csv`, csvOf(rows));
    const s = summaryOf(rows, outs);
    const start = walk ? null : startCheck(data, rows);
    if (start) console.log(`start check: ${start.compared} emails, from ${iso(LATE_FROM)} ${start.later}: ${start.same ? "the same" : "DIFFERENT"}`);
    const pairs = outs.map((o) => ({
      pair: o.pair, bars: o.bars, firstBar: o.firstBar, judged: o.judged, marks: o.marks, bothBars: o.bothBars, closed: o.closed,
      cVanished: o.cVanished, cBarDiff: o.cBarDiff, cBarsSeen: o.cBarsSeen, emails: o.rows.length,
    }));
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify({ ...s, startCheck: start, pairs, load: st }, null, 1));
    // the numbers are printed by the workflow only after the Python agreed (research/pbz-check.py)
    console.log(`written: ${rows.length} emails`);
  } else if (MODE === "print") {
    const s = JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`));
    const { tables, ...rest } = s;
    if (s.startCheck && s.startCheck.same === false) console.log("NOTE: the start check is DIFFERENT (the emails change with the 1-hour bars read from 2023-12-01): find why before reading on");
    console.log(JSON.stringify({ ...rest, load: undefined }, null, 1));
    for (const c of CANDS) {
      console.log(c);
      for (const [name, h] of Object.entries(tables[c] as Record<string, Json>)) printTable(name, h);
    }
  } else {
    console.log(`unknown MODE ${MODE}`);
    Deno.exit(2);
  }
}
