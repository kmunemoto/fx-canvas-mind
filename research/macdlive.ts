// #388 (docs §8.131): the 1-hour MACD email (v6/v8, 95%: _shared/macd-level.ts decideZoneOnWindow) sent at the
// bar's close, as now ("close"), or at the first minute the forming bar's price puts the blue line in the band
// ("live"), the owner: 「一回どっちが儲かるか測って」. The rule and the output: research/macdlive-spec.md.
// Each email followed the owner's way (§8.102's main row: a limit at E two minutes after the email, TP 10 pips, no
// stop) and by the email's guide (stop 13, TP 4), on GMO's 1-minute bars (research/flowz-lib.ts ownerOf, guideOf,
// statsOf: §8.124's, checked against research/flowz-check.py). Funds unlimited: every email is a trade.
//
//   MODE=real       GMO's files: research/.cache, fetched when missing (GitHub's runners reach GMO; the development
//                   container cannot). Writes OUT/{rows.csv,summary.json}.
//   MODE=synthetic  seeded walks (ownerhold-data synthesize) in memory, the same pipeline, and the checks: the live
//                   decision at a minute equal to decideZoneOnWindow on the window with that price as the forming
//                   bar's close (every live email, the minute before it, a sample of the rest); the look-ahead check
//                   (every 1-minute price from the email's moment on moved by ±300 pips: the email, its side and E
//                   stay); a live email at the close is the close way's; the counts add up.
//   MODE=walkfiles  the walk of SEEDS' first seed written as GMO's files under OUT/gmo, read back through the real
//                   run's loaders (nothing fetched), the study written to OUT: what research/macdlive-check.py is run
//                   on first.
//   MODE=print      the summary the real run wrote.
//
// The live decision is computed on the window's closed bars once a bar (the 12 and 26 EMAs, the line, the signal and
// the histogram up to the bar before, and the band's highest and lowest over the 119 bars before), and each minute's
// price updates the newest index alone, with the same arithmetic as _shared/pine.ts (alpha * x + (1 - alpha) * prev);
// every live email (and the minute before it, and a sample of the others) is checked against decideZoneOnWindow on
// the rebuilt window, and any difference stops the run.
//
// Nothing here changes an email; the numbers are the study's only.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { decideZoneOnWindow, LEVEL_WINDOW, ZONE_BARS, ZONE_SHARE, zoneAt } from "../supabase/functions/_shared/macd-level.ts";
import { macd, MACD_DEFAULTS } from "../supabase/functions/_shared/macd.ts";
import { pineEma } from "../supabase/functions/_shared/pine.ts";
import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { type LoadStats, type M1, type Source, loadM1, newLoadStats, synthesize, unitOf, writeGmoFiles } from "./ownerhold-data.ts";
import { type Book, makeBook } from "./ownerhold-trades.ts";
import { nyClosesBetween } from "./money-trades.ts";
import { lowerBound } from "./money-data.ts";
import { loadTf, quotesOf, ruleKeyOf, writeWalk } from "./trend-data.ts";
import { emptyBars, fromQuotes, weekendOutOf } from "./trend-labels.ts";
import { type Bar, type Guide, type Mail, type Owner, type Row, type Stats, guideOf, mailedAt, mean, median, ownerOf, statsOf } from "./flowz-lib.ts";
import { DAY, HOUR, MINUTE } from "./lib.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-10-29T21:00:00Z"));
// the bars before START the 600-bar window reads
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-10-01T00:00:00Z"));
const OUT = env("OUT", "research/out/macdlive");

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const decimalsOf = (pair: string) => (pair.includes("JPY") ? 3 : 5);

// the chart's closed mid bars (historyRead: Number(v.toFixed(d))) of quotes read at END
const midBars = (pair: string, qs: QuoteCandle[]): Bar[] =>
  historyRead(pair, "1h", qs, END).candles.map((c) => ({ t: Date.parse(c.datetime.replace(" ", "T") + "Z"), close: c.close }));

interface PairData {
  pair: string;
  bars1h: Bar[];
  book: Book;
}

// ---- the live decision ----------------------------------------------------------------------------

type Way = "close" | "live";

interface LiveMail extends Mail {
  way: Way;
  early: boolean;
  minutes: number;
  gone: boolean;
}

interface Decision {
  side: "BUY" | "SELL";
  m: number;
  top: number;
  bottom: number;
}

const A12 = 2 / (MACD_DEFAULTS.fast + 1);
const A26 = 2 / (MACD_DEFAULTS.slow + 1);
const A9 = 2 / (MACD_DEFAULTS.signal + 1);
const W = LEVEL_WINDOW;

// a bar's window read once: the closed state up to index W − 2, and the band over the 119 bars before
interface Prepared {
  closes: number[];
  f12: number;
  s26: number;
  sig: number;
  top119: number;
  bottom119: number;
  beforeTop: boolean;
  beforeBottom: boolean;
}

const prepare = (bars: readonly Bar[], i: number): Prepared | null => {
  if (i + 1 < W) return null;
  const closes = bars.slice(i - W + 1, i + 1).map((b) => b.close);
  const r = macd(closes);
  const before = zoneAt(r, W - 2);
  if (before === null) return null;
  const f = pineEma(closes, MACD_DEFAULTS.fast);
  const s = pineEma(closes, MACD_DEFAULTS.slow);
  let top = 0;
  let bottom = 0;
  for (const xs of [r.macd, r.signal, r.hist]) {
    for (let j = W - ZONE_BARS; j <= W - 2; j++) {
      const v = xs[j] as number;
      if (v > top) top = v;
      if (v < bottom) bottom = v;
    }
  }
  return { closes, f12: f[W - 2] as number, s26: s[W - 2] as number, sig: r.signal[W - 2] as number, top119: top, bottom119: bottom, beforeTop: before.inTop, beforeBottom: before.inBottom };
};

// the decision with x as the forming bar's close
const liveAt = (p: Prepared, x: number): Decision | null => {
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
  const inTop = top > 0 && m >= ZONE_SHARE * top;
  const inBottom = bottom < 0 && m <= ZONE_SHARE * bottom;
  if (inTop && !p.beforeTop) return { side: "SELL", m, top, bottom };
  if (inBottom && !p.beforeBottom) return { side: "BUY", m, top, bottom };
  return null;
};

// the same, as the email's code decides it (the window rebuilt)
const slowAt = (p: Prepared, x: number): Decision | null => {
  const w = p.closes.map((c) => ({ close: c }));
  w[W - 1] = { close: x };
  const d = decideZoneOnWindow(w, W - 1);
  return d ? { side: d.side, m: d.m, top: d.top, bottom: d.bottom } : null;
};
const sameDecision = (a: Decision | null, b: Decision | null) =>
  a === null || b === null ? a === b : a.side === b.side && a.m === b.m && a.top === b.top && a.bottom === b.bottom;

// the price at τ: the mid of the 1-minute bar opened at τ − 1 minute, rounded as the chart's
const priceAt = (m: M1, tau: number, dec: number): number | null => {
  const q = lowerBound(m.t, tau - MINUTE);
  if (q >= m.n || m.t[q] !== tau - MINUTE) return null;
  return Number(((m.bc[q] + m.ac[q]) / 2).toFixed(dec));
};

interface Checks {
  compared: number;
  mismatches: string[];
}

// both ways' emails of a pair, the bars closed in [fromT, toT)
const emailsOf = (d: PairData, fromT: number, toT: number, ck: Checks): { close: LiveMail[]; live: LiveMail[]; judged: number } => {
  const bars = d.bars1h;
  const m1 = d.book.m;
  const dec = decimalsOf(d.pair);
  const close: LiveMail[] = [];
  const live: LiveMail[] = [];
  let judged = 0;
  const mailOf = (way: Way, i: number, tau: number, x: number, dd: Decision, early: boolean, gone: boolean): LiveMail => ({
    way,
    pair: d.pair,
    open: bars[i].t,
    T: tau,
    side: dd.side,
    dir: dd.side === "BUY" ? 1 : -1,
    E: x,
    m: dd.m,
    top: dd.top,
    bottom: dd.bottom,
    i,
    early,
    minutes: early ? (bars[i].t + HOUR - tau) / MINUTE : 0,
    gone,
  });
  for (let i = W - 1; i < bars.length; i++) {
    const T = bars[i].t + HOUR;
    if (T < fromT || T >= toT) continue;
    judged++;
    const cd = decideZoneOnWindow(bars, i);
    const closeMail = cd && mailedAt(T) ? mailOf("close", i, T, bars[i].close, cd, false, false) : null;
    if (closeMail) close.push(closeMail);
    const p = prepare(bars, i);
    let found: LiveMail | null = null;
    if (p) {
      let lastNone: number | null = null;
      for (let k = 1; k <= 59 && !found; k++) {
        const tau = bars[i].t + k * MINUTE;
        const x = priceAt(m1, tau, dec);
        if (x === null) continue;
        const dd = liveAt(p, x);
        // a sample of the minutes against the email's own code
        if ((i * 59 + k) % 101 === 0) {
          ck.compared++;
          if (!sameDecision(dd, slowAt(p, x))) ck.mismatches.push(`${d.pair} ${iso(tau)} (sample)`);
        }
        if (dd === null || isPossiblyClosed(tau + 1000)) {
          if (dd === null) lastNone = x;
          continue;
        }
        ck.compared++;
        if (!sameDecision(dd, slowAt(p, x))) ck.mismatches.push(`${d.pair} ${iso(tau)} (email)`);
        if (lastNone !== null) {
          ck.compared++;
          if (slowAt(p, lastNone) !== null) ck.mismatches.push(`${d.pair} ${iso(tau)} (the minute before)`);
        }
        found = mailOf("live", i, tau, x, dd, true, cd === null);
      }
    }
    if (!found && closeMail) found = { ...closeMail, way: "live" };
    if (found) live.push(found);
  }
  return { close, live, judged };
};

// ---- the pipeline ------------------------------------------------------------------------------------

interface LRow extends Row {
  mail: LiveMail;
}

interface PairOut {
  pair: string;
  bars1h: number;
  judged: number;
  rows: LRow[];
}

const runPair = (d: PairData, ck: Checks): PairOut => {
  const { close, live, judged } = emailsOf(d, START, END, ck);
  const rowOf = (mail: LiveMail): LRow => {
    const own: Owner = ownerOf(d.book, mail, END);
    const guide: Guide | null = guideOf(d.book, mail, own, END);
    return { mail, half: 1, month: iso(mail.T).slice(0, 7), A: "none", B: "none", own, guide };
  };
  return { pair: d.pair, bars1h: d.bars1h.length, judged, rows: [...close, ...live].map(rowOf) };
};

const wayOrder = (w: Way) => (w === "close" ? 0 : 1);
const merged = (outs: PairOut[]): LRow[] =>
  outs.flatMap((o) => o.rows).sort((a, b) =>
    a.mail.T - b.mail.T || PAIRS.indexOf(a.mail.pair as typeof PAIRS[number]) - PAIRS.indexOf(b.mail.pair as typeof PAIRS[number]) || wayOrder(a.mail.way) - wayOrder(b.mail.way)
  );

type FullStats = Stats & { pipsSum: number; guidePipsSum: number };
const fullStats = (rows: readonly LRow[]): FullStats => {
  const s = statsOf(rows);
  const f = rows.filter((r) => r.own.filled);
  let pipsSum = 0;
  for (const r of f) pipsSum += r.own.pips as number;
  let guidePipsSum = 0;
  for (const r of f) guidePipsSum += (r.guide as Guide).pips;
  return { ...s, pipsSum, guidePipsSum };
};

const summaryOf = (rows: LRow[], outs: PairOut[], st: LoadStats) => {
  const ways: Record<string, Record<string, FullStats>> = {};
  for (const w of ["close", "live"] as Way[]) {
    const rs = rows.filter((r) => r.mail.way === w);
    ways[w] = { all: fullStats(rs) };
    for (const pair of PAIRS) ways[w][pair] = fullStats(rs.filter((r) => r.mail.pair === pair));
  }
  const early = rows.filter((r) => r.mail.way === "live" && r.mail.early);
  return {
    meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM) },
    ways,
    live: {
      early: early.length,
      gone: early.filter((r) => r.mail.gone).length,
      minutesMedian: median(early.map((r) => r.mail.minutes)),
      minutesMax: early.length ? Math.max(...early.map((r) => r.mail.minutes)) : null,
    },
    pairs: outs.map((o) => ({ pair: o.pair, bars1h: o.bars1h, judged: o.judged })),
    load: st,
  };
};

const g = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const csvOf = (rows: LRow[]): string => {
  const head = ["way", "pair", "open", "tau", "side", "E", "early", "minutes", "gone", "filled", "market", "fillT", "fill", "tp", "tpT", "exit", "endPx", "pips", "mae", "hold", "g_result", "g_pips", "g_both"];
  const out = [head.join(",")];
  for (const r of rows) {
    const p = r.own.path;
    out.push([
      r.mail.way, r.mail.pair, iso(r.mail.open), iso(r.mail.T), r.mail.side, String(r.mail.E),
      r.mail.early ? "1" : "0", String(r.mail.minutes), r.mail.gone ? "1" : "0",
      r.own.filled ? "1" : "0", p.market ? "1" : "0", r.own.filled ? iso(p.t0) : "", r.own.filled ? String(p.fill) : "",
      r.own.tp ? "1" : "0", r.own.tp ? iso(p.x) : "", r.own.tp ? String(p.exit) : "", r.own.held ? String(p.endPx) : "",
      g(r.own.pips), g(r.own.mae), g(r.own.hold),
      r.guide?.result ?? "", r.guide ? String(r.guide.pips) : "", r.guide ? (r.guide.both ? "1" : "0") : "",
    ].join(","));
  }
  return out.join("\n") + "\n";
};

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));
const printStats = (name: string, s: FullStats) =>
  console.log(
    `  ${name.padEnd(8)} emails ${s.mails} filled ${s.filled} unfilled ${s.unfilled} | owner: TP ${s.tp}/${s.filled} (${fmt(s.win)}%) pips sum ${fmt(s.pipsSum, 1)} mean ${fmt(s.pipsMean)} median ${fmt(s.pipsMedian)}` +
      ` | MAE median ${fmt(s.maeMedian, 1)} max ${fmt(s.maeMax, 1)} | hours median ${fmt(s.holdMedian, 1)} max ${fmt(s.holdMax, 1)} | held ${s.held} sum ${fmt(s.heldPipsSum, 1)} worst ${fmt(s.heldPipsMin, 1)}` +
      ` | guide: TP ${s.guideTp} stop ${s.guideSl} held ${s.guideHeld} both ${s.guideBoth} (${fmt(s.guideWin)}%) sum ${fmt(s.guidePipsSum, 1)} mean ${fmt(s.guidePipsMean)}`,
  );

// ---- the data ---------------------------------------------------------------------------------------

const bookOf = (m: M1): Book => makeBook(m, Float64Array.from(nyClosesBetween(LOAD_FROM - DAY, END).map((c) => c.tau)), true);

const loadFiles = async (src: Source): Promise<{ data: PairData[]; st: LoadStats }> => {
  const st = newLoadStats();
  const data: PairData[] = [];
  const weekend = weekendOutOf("inside");
  for (const pair of PAIRS) {
    const h = await loadTf(src, pair, "1h", LOAD_FROM, END, st, weekend);
    const m1 = await loadM1(src, pair, START, END, st);
    data.push({ pair, bars1h: midBars(pair, quotesOf(h.bars)), book: bookOf(m1) });
    console.log(`${pair}: 1h ${h.bars.n} (from ${h.bars.n ? iso(h.bars.t[0]) : "-"}), 1min ${m1.n}`);
  }
  return { data, st };
};

// the walk's 1-minute bars cut into GMO's grid of `step` (research/flowz.ts's, as it is)
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

// the walk written as GMO's files (research/flowz.ts's writeWalkFiles, as it is)
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
  return { pair, bars1h: midBars(pair, coarsen(m, HOUR)), book: bookOf(m) };
};

// ---- the checks on the walk ----------------------------------------------------------------------------

const checkWalk = (seed: number) => {
  const ck: Checks = { compared: 0, mismatches: [] };
  const outs = PAIRS.map((pair) => runPair(synthPair(seed, pair), ck));
  const rows = merged(outs);
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    console.log(`  CHECK FAILED: ${msg}`);
  };
  for (const x of ck.mismatches.slice(0, 20)) bad(`the live decision differs from decideZoneOnWindow: ${x}`);
  // a live email at the close is the close way's, and every close email's bar has a live email (at or before it)
  for (const o of outs) {
    const closeAt = new Map(o.rows.filter((r) => r.mail.way === "close").map((r) => [r.mail.i, r]));
    const liveAt = new Map(o.rows.filter((r) => r.mail.way === "live").map((r) => [r.mail.i, r]));
    for (const [i, c] of closeAt) {
      const l = liveAt.get(i);
      if (!l) bad(`${o.pair} ${iso(c.mail.T)}: a close email without a live one`);
      else if (!l.mail.early && (l.mail.T !== c.mail.T || l.mail.E !== c.mail.E || l.mail.side !== c.mail.side)) bad(`${o.pair} ${iso(c.mail.T)}: the live email at the close differs`);
    }
    for (const [i, l] of liveAt) if (l.mail.gone !== (l.mail.early && !closeAt.has(i))) bad(`${o.pair} ${iso(l.mail.T)}: gone is wrong`);
  }
  for (const w of ["close", "live"] as Way[]) {
    const s = fullStats(rows.filter((r) => r.mail.way === w));
    if (s.filled + s.unfilled !== s.mails || s.tp + s.held !== s.filled) bad(`${w}: filled/unfilled/tp/held do not add up`);
  }
  // the look-ahead check: every 1-minute price from an early live email's moment on moved by ±300 pips: the email
  // (its bar, side and E) stays
  const sample = rows.filter((r) => r.mail.way === "live" && r.mail.early).filter((_, k) => k % 3 === 0).slice(0, 30);
  let compared = 0;
  for (const r of sample) {
    for (const pips of [300, -300]) {
      const again = runPair(synthPair(seed, r.mail.pair, { T: r.mail.T, pips }), { compared: 0, mismatches: [] }).rows.find((x) => x.mail.way === "live" && x.mail.T === r.mail.T);
      compared++;
      if (!again) bad(`${r.mail.pair} ${iso(r.mail.T)}: the live email went when the future was rewritten (${pips})`);
      else if (again.mail.side !== r.mail.side || again.mail.E !== r.mail.E || again.mail.i !== r.mail.i) bad(`${r.mail.pair} ${iso(r.mail.T)}: moved with the future (${pips})`);
    }
  }
  const live = rows.filter((r) => r.mail.way === "live");
  console.log(
    `walk seed ${seed}: close ${rows.length - live.length}, live ${live.length} (early ${live.filter((r) => r.mail.early).length}, gone ${live.filter((r) => r.mail.gone).length}); decisions compared ${ck.compared}; look-ahead compared ${compared}`,
  );
  if (sample.length === 0) bad("no early live email on the walk: the look-ahead check compared nothing");
  return { fail, rows };
};

// ---- main --------------------------------------------------------------------------------------------

if (import.meta.main) {
  if (MODE !== "print") await Deno.mkdir(OUT, { recursive: true });
  if (MODE === "synthetic") {
    let fail = 0;
    const seeds = env("SEEDS", "1,2").split(",").map(Number);
    for (const seed of seeds) fail += checkWalk(seed).fail;
    console.log(fail === 0 ? "ALL WALK CHECKS PASSED" : `${fail} WALK CHECKS FAILED`);
    if (fail) Deno.exit(1);
  } else if (MODE === "real" || MODE === "walkfiles") {
    const walk = MODE === "walkfiles";
    if (walk) await writeWalkFiles(`${OUT}/gmo`, Number(env("SEEDS", "1").split(",")[0]));
    const { data, st } = await loadFiles(walk ? { dir: `${OUT}/gmo`, fetch: false } : { dir: "research/.cache", fetch: true });
    console.log(`files ${st.files} requests ${st.requests} cached ${st.cached} partial ${st.partial} failed ${st.failed} ${st.failedExamples.join("; ")}`);
    const ck: Checks = { compared: 0, mismatches: [] };
    const outs = data.map((d) => runPair(d, ck));
    console.log(`live decisions compared with decideZoneOnWindow: ${ck.compared}, differences ${ck.mismatches.length}`);
    if (ck.mismatches.length) {
      for (const x of ck.mismatches.slice(0, 20)) console.log(`  DIFF ${x}`);
      Deno.exit(1);
    }
    const rows = merged(outs);
    await Deno.writeTextFile(`${OUT}/rows.csv`, csvOf(rows));
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify(summaryOf(rows, outs, st), null, 1));
    // the numbers are printed by the workflow only after the Python agreed (research/macdlive-check.py)
    console.log(`written: ${rows.length} rows`);
  } else if (MODE === "print") {
    const s = JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`));
    console.log(`meta ${JSON.stringify(s.meta)}`);
    for (const w of ["close", "live"]) {
      console.log(w);
      for (const [k, v] of Object.entries(s.ways[w])) printStats(k, v as FullStats);
    }
    console.log(`live: ${JSON.stringify(s.live)}`);
    console.log(`pairs: ${JSON.stringify(s.pairs)}`);
  }
}
