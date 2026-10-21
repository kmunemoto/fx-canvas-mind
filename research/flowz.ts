// #371 (docs §8.124): would leaving out the 1-hour MACD emails (v6, 95%) that go against the big trend make the
// emails left better? The big trend: A, the 1-hour EMA200 (the 1-hour chart's purple line); B, the 4-hour EMA200.
// Each email followed the owner's way (§8.102's main row: a limit at E two minutes after the close, TP 10 pips, no
// stop) and by the email's guide (stop 13, TP 4), on GMO's 1-minute bars; one email at a time (資金の限りなし).
//
//   MODE=real       GMO's files: research/.cache (tf-winrate's layout), fetched when missing (GitHub's runners
//                   reach GMO; the development container cannot). Writes research/out/flowz/{rows.csv,summary.json}.
//   MODE=synthetic  a seeded walk of 1-minute bars (ownerhold-data synthesize), its 1-hour and 4-hour bars made from
//                   it, the same pipeline, and the checks: the look-ahead check (every bar after an email's close
//                   rewritten: its email, side and trends unchanged), the counts adding up, and the halves.
//   MODE=walkfiles  the walk of SEEDS' first seed written as GMO's files under OUT/gmo (1-minute and 15-minute day
//                   files as ownerhold-data writes them, 1-hour day files and 4-hour year files as trend-data's
//                   writeWalk), then read back through the real run's loaders (nothing fetched) and the study
//                   written to OUT as the real run writes it: what research/flowz-check.py is run on first.
//
// Nothing here changes an email; the numbers are the study's only.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { emaSeries } from "../supabase/functions/analyze/indicators.ts";
import { type LoadStats, type M1, type Source, loadM1, newLoadStats, synthesize, unitOf, writeGmoFiles } from "./ownerhold-data.ts";
import { type Book, makeBook } from "./ownerhold-trades.ts";
import { nyClosesBetween } from "./money-trades.ts";
import { loadTf, quotesOf, ruleKeyOf, writeWalk } from "./trend-data.ts";
import { emptyBars, fromQuotes, weekendOutOf } from "./trend-labels.ts";
import {
  BOOT_SEED,
  type Bar,
  type Cand,
  DRAWS,
  DROP_SEED,
  type Row,
  type Stats,
  bootstrap,
  flowB,
  flowsA,
  FLOW_EMA,
  gapOf,
  guideOf,
  leanOf,
  leanOfRow,
  mailsOf,
  mean,
  ownerOf,
  randomDrop,
  statsOf,
} from "./flowz-lib.ts";
import { DAY, HOUR } from "./lib.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-10-17T00:00:00Z"));
const SPLIT = Date.parse(env("SPLIT", "2025-05-19T00:00:00Z"));
// the bars before START the 600-bar window and the EMA200s read
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-10-01T00:00:00Z"));
const OUT = env("OUT", "research/out/flowz");

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const monthOf = (ms: number) => iso(ms).slice(0, 7);

// the chart's closed mid bars (historyRead: Number(v.toFixed(d))) of quotes read at END
const midBars = (pair: string, interval: "1h" | "4h", qs: QuoteCandle[]): Bar[] =>
  historyRead(pair, interval, qs, END).candles.map((c) => ({ t: Date.parse(c.datetime.replace(" ", "T") + "Z"), close: c.close }));

interface PairData {
  pair: string;
  bars1h: Bar[];
  bars4h: Bar[];
  book: Book;
}

// ---- the pipeline ---------------------------------------------------------------------------------

interface PairOut {
  pair: string;
  judged: number;
  notMailed: number;
  first1h: string | null;
  first4h: string | null;
  bars1h: number;
  bars4h: number;
  rows: Row[];
}

const runPair = (d: PairData): PairOut => {
  const { mails, judged, notMailed } = mailsOf(d.pair, d.bars1h, START, END);
  const fa = flowsA(d.bars1h);
  const t4 = Float64Array.from(d.bars4h.map((b) => b.t));
  const ema4 = emaSeries(d.bars4h.map((b) => b.close), FLOW_EMA);
  const rows: Row[] = mails.map((mail) => {
    const own = ownerOf(d.book, mail, END);
    return {
      mail,
      half: mail.T < SPLIT ? 1 : 2,
      month: monthOf(mail.T),
      A: leanOf(mail.dir, fa[mail.i]),
      B: leanOf(mail.dir, flowB(t4, d.bars4h, ema4, mail.T)),
      own,
      guide: guideOf(d.book, mail, own, END),
    };
  });
  return {
    pair: d.pair,
    judged,
    notMailed,
    first1h: d.bars1h.length ? iso(d.bars1h[0].t) : null,
    first4h: d.bars4h.length ? iso(d.bars4h[0].t) : null,
    bars1h: d.bars1h.length,
    bars4h: d.bars4h.length,
    rows,
  };
};

// every pair's rows, by close and then by the pair's place in PAIRS
const merged = (outs: PairOut[]): Row[] =>
  outs.flatMap((o) => o.rows).sort((a, b) => a.mail.T - b.mail.T || PAIRS.indexOf(a.mail.pair as typeof PAIRS[number]) - PAIRS.indexOf(b.mail.pair as typeof PAIRS[number]));

interface Table {
  [group: string]: Stats;
}
const tableOf = (rows: readonly Row[], c: Cand): Table => ({
  with: statsOf(rows.filter((r) => leanOfRow(r, c) === "with")),
  against: statsOf(rows.filter((r) => leanOfRow(r, c) === "against")),
  none: statsOf(rows.filter((r) => leanOfRow(r, c) === "none")),
  decided: statsOf(rows.filter((r) => leanOfRow(r, c) !== "none")),
  all: statsOf(rows),
});

const summaryOf = (rows: Row[]) => {
  const h1 = rows.filter((r) => r.half === 1);
  const h2 = rows.filter((r) => r.half === 2);
  const tables: Record<string, Record<string, Table>> = {};
  for (const c of ["A", "B"] as Cand[]) {
    tables[c] = { half1: tableOf(h1, c), half2: tableOf(h2, c), both: tableOf(rows, c) };
    for (const pair of PAIRS) tables[c][pair] = tableOf(rows.filter((r) => r.mail.pair === pair), c);
  }
  // 1: the first half picks A or B by (with − decided); a tie or two nulls: A
  const gA = gapOf(h1, "A");
  const gB = gapOf(h1, "B");
  const chosen: Cand = gB !== null && (gA === null || gB > gA) ? "B" : "A";
  // 2: the second half, the chosen one only
  const gap2 = gapOf(h2, chosen);
  const boot = bootstrap(h2, chosen);
  const drop = randomDrop(h2, chosen);
  const withMean = mean(h2.filter((r) => leanOfRow(r, chosen) === "with" && r.own.filled).map((r) => r.own.pips as number));
  const better = boot.lo > 0 && withMean !== null && withMean > drop.line;
  const worse = boot.hi < 0;
  return {
    meta: { start: iso(START), end: iso(END), split: iso(SPLIT), loadFrom: iso(LOAD_FROM), draws: DRAWS, bootSeed: BOOT_SEED, dropSeed: DROP_SEED },
    stage1: { gapA: gA, gapB: gB, chosen },
    stage2: { cand: chosen, gap: gap2, withMean, boot, drop, verdict: better ? "better" : worse ? "worse" : "indistinguishable" },
    tables,
    // the other candidate's numbers in the second half, written beside (not judged)
    other: (() => {
      const o: Cand = chosen === "A" ? "B" : "A";
      return { cand: o, gap: gapOf(h2, o) };
    })(),
  };
};

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(d));
const csvOf = (rows: Row[]): string => {
  const head = [
    "pair", "open", "T", "side", "E", "m", "top", "bottom", "half", "month", "A", "B",
    "filled", "market", "fillT", "fill", "tp", "tpT", "exit", "endPx", "pips", "mae", "hold", "g_result", "g_pips", "g_both",
  ];
  const out = [head.join(",")];
  for (const r of rows) {
    const p = r.own.path;
    out.push([
      r.mail.pair, iso(r.mail.open), iso(r.mail.T), r.mail.side, String(r.mail.E), String(r.mail.m), String(r.mail.top), String(r.mail.bottom),
      String(r.half), r.month, r.A, r.B,
      r.own.filled ? "1" : "0", p.market ? "1" : "0", r.own.filled ? iso(p.t0) : "", r.own.filled ? String(p.fill) : "",
      r.own.tp ? "1" : "0", r.own.tp ? iso(p.x) : "", r.own.tp ? String(p.exit) : "", r.own.held ? String(p.endPx) : "",
      r.own.pips === null ? "" : String(r.own.pips), r.own.mae === null ? "" : String(r.own.mae), r.own.hold === null ? "" : String(r.own.hold),
      r.guide?.result ?? "", r.guide ? String(r.guide.pips) : "", r.guide ? (r.guide.both ? "1" : "0") : "",
    ].join(","));
  }
  return out.join("\n") + "\n";
};

const printTable = (name: string, t: Table) => {
  console.log(`  ${name}`);
  for (const [g, s] of Object.entries(t)) {
    console.log(
      `    ${g.padEnd(8)} mails ${s.mails} filled ${s.filled} unfilled ${s.unfilled} | owner: win ${fmt(s.win, 2)}% (${s.tp}/${s.filled}) mean ${fmt(s.pipsMean)} median ${fmt(s.pipsMedian)} pips` +
        ` | MAE median ${fmt(s.maeMedian, 1)} max ${fmt(s.maeMax, 1)} | hold median ${fmt(s.holdMedian, 1)}h max ${fmt(s.holdMax, 1)}h | held ${s.held} sum ${fmt(s.heldPipsSum, 1)} worst ${fmt(s.heldPipsMin, 1)}` +
        ` | guide: win ${fmt(s.guideWin, 2)}% (tp ${s.guideTp} sl ${s.guideSl} held ${s.guideHeld} both ${s.guideBoth}) mean ${fmt(s.guidePipsMean)} pips`,
    );
  }
};

// ---- the data ---------------------------------------------------------------------------------------

const bookOf = (m: M1): Book => makeBook(m, Float64Array.from(nyClosesBetween(LOAD_FROM - DAY, END).map((c) => c.tau)), true);

const loadFiles = async (src: Source): Promise<{ data: PairData[]; st: LoadStats }> => {
  const st = newLoadStats();
  const data: PairData[] = [];
  const weekend = weekendOutOf("inside");
  for (const pair of PAIRS) {
    const h = await loadTf(src, pair, "1h", LOAD_FROM, END, st, weekend);
    const f = await loadTf(src, pair, "4h", LOAD_FROM, END, st, weekend);
    const m1 = await loadM1(src, pair, START, END, st);
    data.push({ pair, bars1h: midBars(pair, "1h", quotesOf(h.bars)), bars4h: midBars(pair, "4h", quotesOf(f.bars)), book: bookOf(m1) });
    console.log(`${pair}: 1h ${h.bars.n} (from ${h.bars.n ? iso(h.bars.t[0]) : "-"}), 4h ${f.bars.n} (from ${f.bars.n ? iso(f.bars.t[0]) : "-"}), 1min ${m1.n}`);
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

// the walk written as GMO's files: its 1-minute and 15-minute day files, and its 1-hour day files and 4-hour year
// files (5-minute ones empty), every day key a read of [LOAD_FROM, END) opens
const writeWalkFiles = async (dir: string, seed: number) => {
  for (const pair of PAIRS) {
    const { m1, q15 } = synthesize(pair, PAIRS.indexOf(pair), { seed, trend: 0, startPips: null }, LOAD_FROM, END);
    const barsOf = (qs: QuoteCandle[], tf: "1h" | "4h") => fromQuotes(qs, (t) => ruleKeyOf(tf, t));
    await writeWalk(dir, pair, { "5min": emptyBars(0), "15min": emptyBars(0), "1h": barsOf(coarsen(m1, HOUR), "1h"), "4h": barsOf(coarsen(m1, 4 * HOUR), "4h") }, LOAD_FROM, END);
    await writeGmoFiles(dir, pair, { m1, q15 }, LOAD_FROM, END);
  }
};

// every price of a walk at or after `fromMs` moved by `pips` (the rewritten future of the look-ahead check)
const poisoned = (m: M1, fromMs: number, pips: number): M1 => {
  const u = unitOf(m.pair) * pips;
  const add = (xs: Float64Array) => Float64Array.from(xs, (v, k) => (m.t[k] >= fromMs ? v + u : v));
  return { ...m, bo: add(m.bo), bh: add(m.bh), bl: add(m.bl), bc: add(m.bc), ao: add(m.ao), ah: add(m.ah), al: add(m.al), ac: add(m.ac) };
};

const synthPair = (seed: number, pair: string, cut?: { T: number; pips: number }): PairData => {
  const { m1 } = synthesize(pair, PAIRS.indexOf(pair as typeof PAIRS[number]), { seed, trend: 0, startPips: null }, LOAD_FROM, END);
  const m = cut ? poisoned(m1, cut.T, cut.pips) : m1;
  return { pair, bars1h: midBars(pair, "1h", coarsen(m, HOUR)), bars4h: midBars(pair, "4h", coarsen(m, 4 * HOUR)), book: bookOf(m) };
};

// ---- the checks on the walk ----------------------------------------------------------------------------

const checkWalk = (seed: number) => {
  const outs = PAIRS.map((pair) => runPair(synthPair(seed, pair)));
  const rows = merged(outs);
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    console.log(`  CHECK FAILED: ${msg}`);
  };
  // the counts add up
  for (const c of ["A", "B"] as Cand[]) {
    const t = tableOf(rows, c);
    if (t.with.mails + t.against.mails + t.none.mails !== rows.length) bad(`${c}: with + against + none ≠ all`);
    if (t.decided.mails !== t.with.mails + t.against.mails) bad(`${c}: decided ≠ with + against`);
    for (const s of Object.values(t)) if (s.filled + s.unfilled !== s.mails || s.tp + s.held !== s.filled) bad(`${c}: filled/unfilled/tp/held do not add up`);
  }
  if (rows.some((r) => (r.half === 1) !== (r.mail.T < SPLIT))) bad("a half is wrong");
  // the look-ahead check: for some emails (every 7th), every price after the close moved by ±300 pips; the email,
  // its side and both trends stay
  const sample = rows.filter((_, k) => k % 7 === 0).slice(0, 40);
  let compared = 0;
  for (const r of sample) {
    for (const pips of [300, -300]) {
      const again = runPair(synthPair(seed, r.mail.pair, { T: r.mail.T, pips })).rows.find((x) => x.mail.T === r.mail.T);
      compared++;
      if (!again) bad(`${r.mail.pair} ${iso(r.mail.T)}: the email went when the future was rewritten (${pips})`);
      else if (again.mail.side !== r.mail.side || again.A !== r.A || again.B !== r.B || again.mail.E !== r.mail.E) bad(`${r.mail.pair} ${iso(r.mail.T)}: moved with the future (${pips})`);
    }
  }
  const s = summaryOf(rows);
  console.log(`walk seed ${seed}: ${rows.length} emails; look-ahead compared ${compared}; stage 1 gaps A ${fmt(s.stage1.gapA)} B ${fmt(s.stage1.gapB)} → ${s.stage1.chosen}; stage 2 gap ${fmt(s.stage2.gap)} [${fmt(s.stage2.boot.lo)}, ${fmt(s.stage2.boot.hi)}] line ${fmt(s.stage2.drop.line)} → ${s.stage2.verdict}`);
  for (const o of outs) console.log(`  ${o.pair}: judged ${o.judged}, emails ${o.rows.length}, not mailed (closed) ${o.notMailed}`);
  return { fail, rows, summary: s };
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
    const outs = data.map(runPair);
    const rows = merged(outs);
    await Deno.writeTextFile(`${OUT}/rows.csv`, csvOf(rows));
    const s = summaryOf(rows);
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify({ ...s, pairs: outs.map((o) => ({ pair: o.pair, judged: o.judged, notMailed: o.notMailed, first1h: o.first1h, first4h: o.first4h, bars1h: o.bars1h, bars4h: o.bars4h, emails: o.rows.length })), load: st }, null, 1));
    // the numbers are printed by the workflow only after the Python agreed (research/flowz-check.py)
    console.log(`written: ${rows.length} emails`);
  } else if (MODE === "print") {
    const s = JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`));
    console.log(JSON.stringify({ meta: s.meta, stage1: s.stage1, stage2: s.stage2, other: s.other, pairs: s.pairs }, null, 1));
    for (const c of ["A", "B"]) for (const [k, t] of Object.entries(s.tables[c] as Record<string, Table>)) printTable(`${c} ${k}`, t);
  } else {
    throw new Error(`MODE ${MODE}?`);
  }
}

