// #205 (docs §8.102): the owner's own way with the 15-minute ULTRA emails on
// the five pairs, measured — limit orders at the email's entry (at the market
// when already better), TP2 only, no stop and no time limit, every email,
// 10,000 units, Rakuten's 25x account of 300,000 yen (500,000 beside it),
// margin calls paid in up to 1,000,000 yen. The method is §8.102's, fixed
// before any data was read; this program does what it says and no more.
//
//   MODE=synthetic  確かめ A: the seeded walks (SETS none,t01,t03 × SEEDS),
//                   ③'s gates (i) and (ii) and the planted ③ errors; the full
//                   run on FULL seeds (accounts, E*, the look-ahead checks,
//                   files for ownerhold-check.py) and the planted errors (PLANTS)
//   MODE=real       GMO's bars, START..END; the checks of 確かめ B; numbers to
//                   files only (OUT), printed by MODE=print once every check passed
//   MODE=print      the numbers of a real run whose checks (and the Python's) all passed
//
// The pieces: ownerhold-data.ts (bars, signals, the walk), ownerhold-trades.ts
// (one order followed alone), ownerhold-account.ts (the account minute by
// minute; the all-accepted path, E* and M), ownerhold-report.ts (the lines).

import { MINUTE, WEEK, WEEK_OFFSET } from "./lib.ts";
import { lowerBound } from "./money-data.ts";
import { weekOf } from "./money-stats.ts";
import { type NyClose, nyClosesBetween, rakutenSpread, tausOf } from "./money-trades.ts";
import { csvCells, parseBisPolicy, rateBefore } from "./longhist-lib.ts";
import { LEAD15, type LoadStats, type M1, MAINT, PAIRS, type Sig, type SignalRead, type Source, isUsdPair, keysOf, load15, loadM1, loadQuotes, newLoadStats, pOf, signalsOf, synthesize, unitOf, wholeDayFile, writeGmoFiles } from "./ownerhold-data.ts";
import { GMO_SYMBOLS, dateKeys } from "../supabase/functions/track-outcomes/quotes.ts";
import { type Book, type Fill, type FollowOpts, NO_CUT, type Path, follow, lastEnded, lookAhead, makeBook, maintOf, rakutenM1, valueAt } from "./ownerhold-trades.ts";
import { type AccountOpts, type AccountOut, MAIN_OPTS, type Market, type OrderIn, type SwapFn, runAccount } from "./ownerhold-account.ts";
import { type AccountLine, DAY_MS, type DRow, type PerEmailSplit, type Third, accountLineOf, perEmailSplitOf, thirdOf, usdJpyAt } from "./ownerhold-report.ts";
import { ULTRA_PAIRS } from "../supabase/functions/_shared/ultra.ts";
import { FIXTURES } from "./ownerhold-fixture.ts";
import { A_SHA256, type ARow, type BValue, LEDGER_FROM, LEDGER_HEADER, type LedgerRow, compareRecompute, delaysOf, ledgerSigs, parseACsv, parseLedger, windowOf } from "./ownerhold-b.ts";
import {
  COMPARE_AT, END_B_DEADLINE, INTERVAL_P, PROVISIONAL_1H, PROVISIONAL_4H, PrintItemsError, R_MS, REASONS, RuleFileError, SPREAD_HOURS_PATH, SPREAD_HOURS_SHA256,
  type SlotsFile, Y23_END, Y23_FROM15, Y23_KEYS_M1, Y23_KEYS_M15, Y23_START, bStatusOf, checkItems, deltaOf, DONE_ITEMS, firstSaturdayAfter, judge, provisionalCsv,
  readSlotsFile, ruleFileOf, summaryOf, WEEKLY_ITEMS,
} from "./costhours-lib.ts";
import {
  type Item, type Mails, type RuleAccounts, booksOf, costDumpOf, csv2023Of, emailsOf, midLookAhead, printItemsOf, printTextOf, ruleAccounts, spreadsOf, weekOutside,
  weeklyItemsOf,
} from "./costhours.ts";
import { avoidKey, seasonOf, sha256Hex, slotOf } from "./spreadhours-lib.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
// §8.103 7 (9): a planted error that stops a run (emptyConst: the 2023 mode with an empty sha256 constant)
const PLANT_ENV = env("PLANT", "");
const START = env("START", "2024-01-01");
const END = env("END", "2026-10-03T00:00:00Z");
const SPLIT = env("SPLIT", "2025-05-19");
const START_MS = Date.parse(`${START}T00:00:00Z`);
const END_MS = Date.parse(END);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const OUT = env("OUT", "research/out/ownerhold");
const CACHE = env("CACHE_DIR", "research/.cache");
const DELAY = 2;
const START_YEN = 300_000;
const CAP = 1_000_000;
if (![START_MS, END_MS, SPLIT_MS].every(Number.isFinite) || !(START_MS < SPLIT_MS && SPLIT_MS < END_MS)) throw new Error(`START ${START}, SPLIT ${SPLIT}, END ${END}: not in order`);
if (ULTRA_PAIRS.tp2 !== 10) throw new Error("the emails' TP2 is not 10 pips (§8.102 fixes it)");

// a run's times and money: the study's (START..END, the split, 300,000 yen, the cap), or a hand example's
export interface Ctx {
  start: number;
  end: number;
  split: number;
  startYen: number;
  cap: number;
}
const CTX: Ctx = { start: START_MS, end: END_MS, split: SPLIT_MS, startYen: START_YEN, cap: CAP };

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "-");
const log = (...a: unknown[]) => console.log(...a);

// ---- the swap ---------------------------------------------------------------------------------

// §8.102 スワップ: a year's rate w × (base − quote) − the markup, from the BIS
// policy rates a month late (§8.24); a night = rate ÷ 100 × 10,000 × the mid ×
// its days (3 on a UTC Wednesday's close) ÷ 365, in the quote currency
const AREAS: Record<string, [string, string]> = { "USD/JPY": ["US", "JP"], "EUR/JPY": ["XM", "JP"], "AUD/JPY": ["AU", "JP"], "EUR/USD": ["XM", "US"], "AUD/USD": ["AU", "US"] };
const daysOf = (tau: number) => (new Date(tau).getUTCDay() === 3 ? 3 : 1);
type Rates = (area: string, tau: number) => number | null;
const swapFrom = (rates: Rates, markup: number): SwapFn => (pair, dir, tau, mid) => {
  const [b, q] = AREAS[pair];
  const rb = rates(b, tau);
  const rq = rates(q, tau);
  if (rb === null || rq === null) throw new Error(`${pair} ${iso(tau)}: no policy rate`);
  const rate = dir * (rb - rq) - markup;
  return (rate / 100) * 10_000 * mid * daysOf(tau) / 365;
};
// the walks' rates: fixed, the dollar's and the Aussie's over the yen's
const SYN_RATES: Record<string, number> = { US: 5.25, JP: 0.1, XM: 3.75, AU: 4.35 };
const synRates: Rates = (a) => SYN_RATES[a] ?? null;
const bisRates = async (path: string): Promise<Rates> => {
  const monthly = parseBisPolicy(await Deno.readTextFile(path), ["US", "JP", "XM", "AU"]);
  return (a, tau) => rateBefore(monthly[a] ?? [], new Date(tau).toISOString().slice(0, 10));
};
void csvCells;

// ---- one data set -----------------------------------------------------------------------------

export interface DataSet {
  name: string;
  m1s: M1[];
  sigs: Sig[];
  reads: SignalRead[];
  load: LoadStats;
  src: Source | null;
  rates: Rates;
  // the 15-minute slots in [START, END) holding 1-minute bars (both sides) but no 15-minute bar taken: what
  // the emails were judged without (listed, not a failure: the sweep read the same GMO files; a file kept
  // while its day was going on is read again by the loader, wholeDayFile)
  m15Gaps?: Array<{ pair: string; slots: number; examples: string[] }>;
  // #206 (docs §8.103 5): the day keys the reads opened (keysOf, as loadM1 and load15 open them), first and last
  opened?: { m1: [string, string]; m15: [string, string] };
}

const m15GapsOf = (m1: M1, q15: Array<{ datetime: string }>, from = START_MS, to = END_MS): { pair: string; slots: number; examples: string[] } => {
  const have = new Set(q15.map((q) => Date.parse(q.datetime)));
  const out = { pair: m1.pair, slots: 0, examples: [] as string[] };
  let last = NaN;
  for (let k = 0; k < m1.n; k++) {
    const t = m1.t[k];
    if (t < from || t >= to) continue;
    const slot = t - (t % (15 * MINUTE));
    if (slot === last) continue;
    last = slot;
    if (have.has(slot)) continue;
    out.slots++;
    if (out.examples.length < 20) out.examples.push(iso(slot));
  }
  return out;
};

// the bars a data set reads: (a)'s START..END, its 15-minute bars from START − LEAD15; 2023's (§8.103 5) its own;
// the walks' holidays (§8.103 7 (4): none in (a)'s)
interface Range {
  start: number;
  end: number;
  from15: number;
  closedKeys?: string[];
  // where the reads stop (planted "pastEndBar", §8.103 7 (9): a bar after END read; the checks of 5 must stop it)
  readEnd?: number;
}
const RANGE_A: Range = { start: START_MS, end: END_MS, from15: START_MS - LEAD15 };

const dataSetOf = async (name: string, src: Source | null, walk: { set: string; seed: number } | null, rg: Range = RANGE_A): Promise<DataSet> => {
  const load = newLoadStats();
  const m1s: M1[] = [];
  const reads: SignalRead[] = [];
  const m15Gaps: NonNullable<DataSet["m15Gaps"]> = [];
  for (const [pi, pair] of PAIRS.entries()) {
    let m1: M1;
    let q15;
    if (walk) {
      const trend = walk.set === "t01" ? 0.01 : walk.set === "t03" ? 0.03 : 0;
      // (a)'s walks end at END; 2023's (written out) go on 4 days past it, so a read past END finds bars
      const to = rg === RANGE_A ? rg.end : rg.end + 4 * DAY_MS;
      const w = synthesize(pair, pi, { seed: walk.seed, trend, startPips: trend ? 100_000 : null, ...(rg.closedKeys ? { closedKeys: rg.closedKeys } : {}) }, rg.from15 - DAY_MS, src ? to : rg.end);
      if (src) {
        // written out and read back: the Python check reads the same files
        await writeGmoFiles(src.dir, pair, w, rg.from15 - DAY_MS, to);
        m1 = await loadM1(src, pair, rg.start - DAY_MS, rg.readEnd ?? rg.end, load);
        q15 = await load15(src, pair, rg.from15, rg.readEnd ?? rg.end, load);
      } else {
        const k = lowerBound(w.m1.t, rg.start - DAY_MS);
        const cut = (xs: Float64Array) => xs.subarray(k);
        m1 = { pair, n: w.m1.n - k, t: cut(w.m1.t), bo: cut(w.m1.bo), bh: cut(w.m1.bh), bl: cut(w.m1.bl), bc: cut(w.m1.bc), ao: cut(w.m1.ao), ah: cut(w.m1.ah), al: cut(w.m1.al), ac: cut(w.m1.ac) };
        q15 = w.q15.filter((q) => Date.parse(q.datetime) >= rg.from15);
      }
    } else {
      m1 = await loadM1(src!, pair, rg.start - DAY_MS, rg.readEnd ?? rg.end, load);
      q15 = await load15(src!, pair, rg.from15, rg.readEnd ?? rg.end, load);
    }
    m1s.push(m1);
    if (src) m15Gaps.push(m15GapsOf(m1, q15, rg.start, rg.end));
    // the look-ahead check of the signals on the walks written out (FULL) and the real data
    reads.push(signalsOf(pair, pi, q15, rg.start, rg.end, src !== null));
  }
  const sigs = reads.flatMap((r) => r.signals);
  // by P, then Rakuten's pair order, BUY first (the order a minute's emails are taken in)
  sigs.sort((a, b) => pOf(a, DELAY) - pOf(b, DELAY) || a.pi - b.pi || b.dir - a.dir);
  const k1 = keysOf(rg.start - DAY_MS, rg.readEnd ?? rg.end).keys;
  const k15 = keysOf(rg.from15, rg.readEnd ?? rg.end).keys;
  const opened = src ? { m1: [k1[0], k1[k1.length - 1]] as [string, string], m15: [k15[0], k15[k15.length - 1]] as [string, string] } : undefined;
  return { name, m1s, sigs, reads, load, src, rates: walk ? synRates : await bisRates(env("BIS_CSV")), m15Gaps, opened };
};

// ---- the analysis of one data set -----------------------------------------------------------

interface Variant {
  name: string;
  delay: number;
  fill: Fill;
  skipMaint: boolean;
  rakuten: boolean;
  opposite: boolean;
  forceMarket?: boolean;
}
const V = (name: string, o: Partial<Variant> = {}): Variant => ({ name, delay: DELAY, fill: "touch", skipMaint: true, rakuten: false, opposite: false, ...o });
const VARIANTS: Variant[] = [
  V("main"),
  V("opposite", { opposite: true }),
  V("delay1", { delay: 1 }),
  V("delay5", { delay: 5 }),
  V("through", { fill: "through" }),
  V("exact", { fill: "exact" }),
  V("judgeMaint", { skipMaint: false }),
  V("rakuten", { rakuten: true }),
  V("market", { forceMarket: true }),
];
// (b) (§8.102 (b)): P is the email's sentAt + 1 minute rounded up to the minute (base: sentAt rounded up, then
// 1 minute), its supplement sentAt + 5 minutes rounded up (base + 5); no T + 1 row (it is the main P here)
const B_DELAY = 1;
const VB = (name: string, o: Partial<Variant> = {}): Variant => V(name, { delay: B_DELAY, ...o });
const VARIANTS_B: Variant[] = [
  VB("main"),
  VB("opposite", { opposite: true }),
  VB("delay5", { delay: 5 }),
  VB("through", { fill: "through" }),
  VB("exact", { fill: "exact" }),
  VB("judgeMaint", { skipMaint: false }),
  VB("rakuten", { rakuten: true }),
  VB("market", { forceMarket: true }),
];

interface Analysis {
  name: string;
  signals: Record<string, unknown>;
  third: { main: Third; week: Third; weekCells: Third; plain: Third; gaps24: { signal: number; opposite: number }; outside: number; rows: number };
  perEmail: Record<string, PerEmailSplit>;
  accounts: Record<string, AccountLine>;
  estar: Record<string, unknown>;
  m: Record<string, { M1: number; M2: number }>;
  extra: Record<string, unknown>;
  // each check: passed or not, its detail, and how many mismatches it found (n; §8.102 確かめ A: the planted errors' counts)
  checks: Record<string, { ok: boolean; detail: unknown; n?: number; why?: string }>;
  // every decision and number, one string each, for the planted errors' diff and the Python's
  decisions: string[];
  dump: Record<string, string>;
  // the accounts themselves (not written out): the hand examples' checks read them
  raw?: { outs: Record<string, AccountOut>; unl: Record<string, AccountOut> };
}

const fx = (x: number, d = 9) => (Number.isFinite(x) ? x.toFixed(d) : "NaN");

// The rows §8.102 counts each planted error's changes on (確かめ A 仕込んだ誤り: 「数える行」): (主) the main row
// with its paths, ③ and its E*; (スワップ込み) the main swap row; (補足の行) the 08:59 row; the dollar's P/L fixed
// in yen, the main row and M; ③'s planted errors, ③. A change elsewhere is listed but not counted.
const PLANT_ROWS: Record<string, string[]> = {
  swapSellSign: ["mainSwap"],
  swapBeforeCall: ["mainSwap"],
  swapAfterOrder: ["mainSwap"],
  deposit0859WhenCured: ["dep0859"],
  deposit0859Full: ["dep0859"],
  usdFixed: ["main", "m"],
  weekCells: ["third"],
  plain: ["third"],
};
export const countedFor = (plant: string, line: string): boolean => {
  const rows = PLANT_ROWS[plant] ?? ["main"];
  const [kind, name] = line.split("|");
  if (kind === "third") return rows.includes("main") || rows.includes("third");
  if (kind === "d" || kind === "w") return rows.includes("main");
  if (kind === "m") return rows.includes("main") || rows.includes("mainSwap") || rows.includes("m");
  if (kind === "path") return rows.includes("main") && name === "main";
  if (["estar", "estarBy", "acct", "fate", "trade", "call", "lc"].includes(kind)) return rows.includes(name);
  return false;
};
const changedOf = (before: string[], after: string[], plant: string) => {
  const was = new Set(before);
  let all = 0;
  let counted = 0;
  for (const x of after) {
    if (was.has(x)) continue;
    all++;
    if (countedFor(plant, x)) counted++;
  }
  return { all, counted };
};

export const analyse = (ds: DataSet, ctx: Ctx, parts: "third" | "all", plant = "", mode: "a" | "b" = "a"): Analysis => {
  // the variants of this part: (a)'s (P = T + 2 minutes) or (b)'s (P from the email's sentAt)
  const VS = mode === "b" ? VARIANTS_B : VARIANTS;
  const vOf = (name: string): Variant => {
    const v = VS.find((x) => x.name === name);
    if (!v) throw new Error(`no variant ${name} in (${mode})`);
    return v;
  };
  const closes = nyClosesBetween(ctx.start - DAY_MS, ctx.end);
  const taus = Float64Array.from(closes.map((c) => c.tau));
  const usdjpy = ds.m1s[0];
  const units = ds.m1s.map((m) => unitOf(m.pair));
  const maintPlant = plant === "maintJudge";
  const booksMain = ds.m1s.map((m) => makeBook(m, taus, !maintPlant));
  const booksJudge = ds.m1s.map((m) => makeBook(m, taus, false));
  let rakApplied: number[] = [];
  let booksRak: Book[] = [];
  const rakM1s: M1[] = [];
  if (parts === "all") {
    const rk = ds.m1s.map((m) => rakutenM1(m, rakutenSpread));
    rakApplied = rk.map((r) => r.applied);
    rakM1s.push(...rk.map((r) => r.m));
    booksRak = rakM1s.map((m) => makeBook(m, taus, true));
  }
  const sigs = ds.sigs;
  const checks: Analysis["checks"] = {};
  const decisions: string[] = [];
  const opts = (v: Variant): FollowOpts => ({ fill: v.fill, endMs: ctx.end, plant, forceMarket: v.forceMarket });
  const booksOf = (v: Variant) => (v.rakuten ? booksRak : v.skipMaint ? booksMain : booksJudge);
  const orderOf = (s: Sig, v: Variant) => {
    const dir = (v.opposite ? -s.dir : s.dir) as 1 | -1;
    return { dir, E: s.E, tp: v.opposite ? s.E + dir * 10 * unitOf(s.pair) : s.tp, P: pOf(s, v.delay) };
  };
  const variants = parts === "all" ? VS : VS.slice(0, 2);
  const paths: Record<string, Path[]> = {};
  for (const v of variants) paths[v.name] = sigs.map((s) => follow(booksOf(v)[s.pi], orderOf(s, v), opts(v)));

  // ③: d at P + 24 hours
  const rows: DRow[] = [];
  const rowsW: DRow[] = [];
  let gapS = 0;
  let gapO = 0;
  let outside = 0;
  // each email's values a day and a week after P, the signal's side and the opposite (emails.csv, for the Python)
  const vals = sigs.map(() => ({ d1: "", d1o: "", g1: "", g1o: "", w1: "", w1o: "" }));
  sigs.forEach((s, i) => {
    const P = paths.main[i].P;
    const H = P + DAY_MS;
    if (H <= ctx.end) {
      const a = valueAt(booksMain[s.pi], paths.main[i], s.dir, H);
      const b = valueAt(booksMain[s.pi], paths.opposite[i], (-s.dir) as 1 | -1, H);
      Object.assign(vals[i], { d1: String(a.v), d1o: String(b.v), g1: a.gap ? "1" : "0", g1o: b.gap ? "1" : "0" });
      if (a.gap) gapS++;
      if (b.gap) gapO++;
      rows.push({ pi: s.pi, dir: s.dir, T: s.T, d: a.v - b.v });
      // the evaluation bar must be inside T's week and its 4-week block
      const j = lastEnded(booksMain[s.pi].m, H);
      const tEval = j >= 0 ? booksMain[s.pi].m.t[j] : NaN;
      if (weekOf(tEval) !== weekOf(s.T) || Math.floor(weekOf(tEval) / 4) !== Math.floor(weekOf(s.T) / 4)) outside++;
      decisions.push(`d|${i}|${fx(a.v)}|${fx(b.v)}`);
    }
    const H7 = P + WEEK;
    if (H7 <= ctx.end) {
      const a = valueAt(booksMain[s.pi], paths.main[i], s.dir, H7);
      const b = valueAt(booksMain[s.pi], paths.opposite[i], (-s.dir) as 1 | -1, H7);
      Object.assign(vals[i], { w1: String(a.v), w1o: String(b.v) });
      decisions.push(`w|${i}|${fx(a.v)}|${fx(b.v)}`);
      rowsW.push({ pi: s.pi, dir: s.dir, T: s.T, d: a.v - b.v });
    }
  });
  const thirdHow = plant === "weekCells" ? "weekCells" : plant === "plain" ? "plain" : "main";
  const third = { main: thirdOf(rows, thirdHow), week: thirdOf(rowsW), weekCells: thirdOf(rows, "weekCells"), plain: thirdOf(rows, "plain"), gaps24: { signal: gapS, opposite: gapO }, outside, rows: rows.length };
  decisions.push(`third|${fx(third.main.main ?? NaN)}|${fx(third.main.L ?? NaN)}`);
  checks.dOutside = { ok: outside === 0, detail: outside, n: outside };

  // the paths, each decision a line
  for (const v of variants) {
    paths[v.name].forEach((p, i) => {
      decisions.push(`path|${v.name}|${i}|${p.P}|${p.none ? 1 : 0}|${p.market ? 1 : 0}|${p.t0}|${fx(p.fill)}|${p.x}|${fx(p.exit)}|${fx(p.endPx)}|${fx(p.mae, 6)}`);
    });
  }
  const signals = {
    count: sigs.length,
    late: sigs.filter((s) => s.late).length,
    byPair: ds.reads.map((r) => ({ pair: r.pair, bars: r.bars, first: r.first, last: r.last, judged: r.judged, noWindow: r.noWindow, mailed: r.signals.length, late: r.signals.filter((s) => s.late).length, unmailed: r.unmailed, lateUnmailed: r.lateUnmailed, lateFound: r.late })),
    probe: ds.reads.reduce((a, r) => ({ compared: a.compared + r.check.compared, mismatched: a.mismatched + r.check.mismatched, examples: [...a.examples, ...r.check.examples].slice(0, 10) }), { compared: 0, mismatched: 0, examples: [] as string[] }),
    probeLate: ds.reads.reduce((a, r) => ({ compared: a.compared + r.checkLate.compared, mismatched: a.mismatched + r.checkLate.mismatched, examples: [...a.examples, ...r.checkLate.examples].slice(0, 10) }), { compared: 0, mismatched: 0, examples: [] as string[] }),
  };
  checks.signalProbe = { ok: signals.probe.mismatched === 0 && signals.probeLate.mismatched === 0, detail: { probe: signals.probe, probeLate: signals.probeLate }, n: signals.probe.mismatched + signals.probeLate.mismatched };
  checks.loads = { ok: ds.load.failed === 0, detail: ds.load, n: ds.load.failed };
  if (ds.reads.some((r) => r.cut)) {
    const cuts = ds.reads.map((r) => ({ pair: r.pair, ...(r.cut ?? { compared: 0, mismatched: 0, examples: ["not run"] }) }));
    checks.signalCut = { ok: cuts.every((c) => c.compared > 0 && c.mismatched === 0), detail: cuts, n: cuts.reduce((a2, c) => a2 + c.mismatched, 0) };
  }
  const out: Analysis = { name: ds.name, signals, third, perEmail: {}, accounts: {}, estar: {}, m: {}, extra: {}, checks, decisions, dump: {} };
  if (parts === "third") return out;

  // ---- the per-email view ----
  for (const v of variants) {
    const ems = sigs.map((s) => ({ pi: s.pi, ...orderOf(s, v) }));
    out.perEmail[v.name] = perEmailSplitOf(ems, sigs.map((s) => s.T), paths[v.name], booksOf(v), usdjpy, ctx.end, ctx.split);
  }
  // look-ahead: every decision of the main paths, both ways
  let laCompared = 0;
  const laMoved: string[] = [];
  let laMovedAll = 0;
  for (const v of [vOf("main"), vOf("opposite")]) {
    sigs.forEach((s, i) => {
      const p = paths[v.name][i];
      const hs = [p.P + DAY_MS, p.P + WEEK].filter((h) => h <= ctx.end);
      const r = lookAhead(booksMain[s.pi], orderOf(s, v), opts(v), p, hs);
      laCompared += r.compared;
      laMovedAll += r.moved.length;
      for (const m of r.moved) if (laMoved.length < 20) laMoved.push(`${v.name} ${i} ${s.pair} ${iso(s.T)} ${m}`);
      if (r.moved.length && laMoved.length >= 20) laMoved.push("…");
    });
  }
  checks.lookAheadPaths = { ok: laMoved.length === 0, detail: { compared: laCompared, movedAll: laMovedAll, moved: laMoved.slice(0, 20) }, n: laMovedAll };
  // checks: no TP in the bar a trade came in on (§8.102: the entry bar's TP is not counted), every path of every variant
  // (the look-ahead check above cuts after the bar it judges, so a TP read from the entry bar itself passes it)
  const tpAfter = { compared: 0, bad: 0, examples: [] as string[] };
  for (const v of variants) {
    paths[v.name].forEach((p, i) => {
      if (p.none || p.fillK === -2 || p.tpK < 0) return;
      tpAfter.compared++;
      if (!(p.x > p.t0)) {
        tpAfter.bad++;
        if (tpAfter.examples.length < 5) tpAfter.examples.push(`${v.name} ${i} ${sigs[i].pair} ${iso(sigs[i].T)}`);
      }
    });
  }
  checks.tpAfterEntryPaths = { ok: tpAfter.bad === 0, detail: tpAfter, n: tpAfter.bad };

  // ---- the accounts ----
  const mk = (books: M1[], from = ctx.start): Market => ({ books, closes, split: ctx.split, end: ctx.end, from });
  // an email whose path is nothing at all (P at or past END, or no bar before P) is not ordered in the accounts
  // either, as in the per-email view and the Python
  const ordersOf = (v: Variant, keep: (s: Sig, i: number) => boolean = () => true): OrderIn[] =>
    sigs.map((s, i) => ({ sig: i, pi: s.pi, ...orderOf(s, v) })).filter((o, k) => keep(sigs[k], k) && !paths[v.name][k].none);
  const swapMain = swapFrom(ds.rates, 0.5);
  const swap10 = swapFrom(ds.rates, 1.0);
  const base: AccountOpts = { ...MAIN_OPTS, start: ctx.startYen, cap: ctx.cap, plant, skipMaint: !maintPlant, usd: plant === "usdFixed" ? "fixed" : "live", deposit: plant === "depositAtTau" ? "tau" : "notice", swapBeforeCall: plant === "swapBeforeCall" };
  interface Row {
    name: string;
    books?: M1[];
    orders: OrderIn[];
    o: AccountOpts;
    from?: number;
    decide?: boolean;
  }
  const oMain = ordersOf(vOf("main"));
  // the rows that judge in Rakuten's stop keep P unmoved: they start at the earliest P if that is before the start
  // ((b): the first email's P in the stop, S_b moved past it; in (a) every P is after START)
  let fromJudge = ctx.start;
  for (const x of oMain) if (x.P < fromJudge) fromJudge = x.P;
  const rowsA: Row[] = [
    { name: "main", orders: oMain, o: base, decide: true },
    { name: "mainSwap", orders: oMain, o: { ...base, swap: swapMain }, decide: true },
    { name: "worst", orders: oMain, o: { ...base, lc: "worst" }, decide: true },
    { name: "worstSwap", orders: oMain, o: { ...base, lc: "worst", swap: swapMain }, decide: true },
    { name: "m5", orders: oMain, o: { ...base, lc: "m5" } },
    { name: "start50", orders: oMain, o: { ...base, start: 500_000 } },
    // (b) has no T + 1 row: its main P is sentAt + 1 minute rounded up
    ...(mode === "a" ? [{ name: "delay1", orders: ordersOf(vOf("delay1")), o: base }] : []),
    { name: "delay5", orders: ordersOf(vOf("delay5")), o: base },
    { name: "through", orders: oMain, o: { ...base, fill: "through" } },
    { name: "exact", orders: oMain, o: { ...base, fill: "exact" } },
    { name: "judgeMaint", orders: oMain, o: { ...base, skipMaint: false }, from: fromJudge },
    { name: "rakuten", books: rakM1s, orders: oMain, o: base },
    { name: "noCancel", orders: oMain, o: { ...base, cancelOnCall: false } },
    { name: "depTau", orders: oMain, o: { ...base, deposit: "tau" } },
    { name: "dep0859", orders: oMain, o: { ...base, deposit: "m0859" } },
    { name: "noPartial", orders: oMain, o: { ...base, deposit: "noPartial" } },
    { name: "s899", orders: oMain, o: { ...base, accept: "s899" } },
    { name: "usdFixed", orders: oMain, o: { ...base, usd: "fixed" } },
    { name: "swapBeforeCall", orders: oMain, o: { ...base, swap: swapMain, swapBeforeCall: true } },
    { name: "swap10", orders: oMain, o: { ...base, swap: swap10 } },
    { name: "redeposit", orders: oMain, o: { ...base, redeposit: true } },
    // (b) has no halves (its split is END_b): no second half started again
    ...(mode === "a" ? [{ name: "restartB", orders: ordersOf(vOf("main"), (_s, i) => paths.main[i].P >= ctx.split), o: base, from: ctx.split }] : []),
    { name: "noBarOut", orders: ordersOf(vOf("main"), (_s, i) => !paths.main[i].noBar), o: base },
    { name: "opposite", orders: ordersOf(vOf("opposite")), o: base },
    ...PAIRS.flatMap((pair, pi) => [300_000, 500_000].map((st) => ({ name: `pair ${pair} ${st / 10_000}`, orders: ordersOf(vOf("main"), (s) => s.pi === pi), o: { ...base, start: st } }))),
  ];
  const Ts = sigs.map((s) => s.T);
  const outs: Record<string, AccountOut> = {};
  for (const r of rowsA) {
    const a = runAccount(mk(r.books ?? ds.m1s, r.from), r.orders, r.o);
    outs[r.name] = a;
    // the fates of the emails the row took, the others "none"
    const fates = sigs.map(() => "none");
    r.orders.forEach((o, k) => (fates[o.sig] = a.fates[k]));
    const Ps = sigs.map(() => NaN);
    for (const o of r.orders) Ps[o.sig] = o.P;
    const line = accountLineOf({ ...a, fates: fates as AccountOut["fates"] }, r.o.start, Ts, ctx.split, units, { books: r.books ? booksRak : booksMain, usdjpy, P: Ps, end: ctx.end }, r.decide === true || r.name === "dep0859");
    out.accounts[r.name] = line;
    {
      decisions.push(`acct|${r.name}|${fx(a.naSplit, 6)}|${fx(a.naEnd, 6)}|${fx(a.inEnd, 6)}|${a.lcs.length}|${a.calls.length}`);
      a.fates.forEach((f, k) => decisions.push(`fate|${r.name}|${r.orders[k].sig}|${f}`));
      for (const t of a.trades) decisions.push(`trade|${r.name}|${t.sig}|${t.t0}|${fx(t.fill)}|${t.x}|${fx(t.exit)}|${t.how}|${fx(t.swapQuote, 6)}|${t.swapYen}`);
      for (const c of a.calls) decisions.push(`call|${r.name}|${c.tau}|${fx(c.D, 6)}|${fx(c.deposits, 6)}|${fx(c.credits, 6)}|${c.end}|${c.endAt}`);
      for (const l of a.lcs) decisions.push(`lc|${r.name}|${l.at}|${fx(l.naBefore, 6)}`);
    }
  }
  // the all-accepted path: E* and M (swap none and the main swap; the loss-cut on closes and on the worst; the stop judged; no pending margin)
  const unl = (o: Partial<AccountOpts>, books: M1[] = ds.m1s, from = ctx.start) => runAccount(mk(books, from), oMain, { ...base, ...o, unlimited: true });
  const estarRows: Record<string, Partial<AccountOpts>> = { main: {}, mainSwap: { swap: swapMain }, worst: { lc: "worst" }, worstSwap: { lc: "worst", swap: swapMain }, judgeMaint: { skipMaint: false }, noPending: { pendingMargin: false } };
  const unlOut: Record<string, AccountOut> = {};
  for (const [name, o] of Object.entries(estarRows)) {
    const u = unl(o, ds.m1s, name === "judgeMaint" ? fromJudge : ctx.start);
    unlOut[name] = u;
    out.estar[name] = { estar: u.estar, by: u.estarBy, over1m: (u.estar?.value ?? 0) > ctx.cap };
    decisions.push(`estar|${name}|${fx(u.estar?.value ?? NaN, 6)}|${u.estar?.kind}|${u.estar?.at}`);
    for (const [kind, t] of Object.entries(u.estarBy)) decisions.push(`estarBy|${name}|${kind}|${fx(t.value, 6)}|${t.at}`);
  }
  out.m.none = { M1: unlOut.main.mSplit, M2: unlOut.main.mEnd - unlOut.main.mSplit };
  out.m.swap = { M1: unlOut.mainSwap.mSplit, M2: unlOut.mainSwap.mEnd - unlOut.mainSwap.mSplit };
  // the supplement (§8.102 ②: not judged on): the dollar pairs' P/L fixed in yen when settled, without and with the main swap
  for (const [name, o] of [["fixed", { usd: "fixed" }], ["fixedSwap", { usd: "fixed", swap: swapMain }]] as const) {
    const u = unl(o as Partial<AccountOpts>);
    out.m[name] = { M1: u.mSplit, M2: u.mEnd - u.mSplit };
  }
  decisions.push(`m|${fx(out.m.none.M1, 6)}|${fx(out.m.none.M2, 6)}|${fx(out.m.swap.M1, 6)}|${fx(out.m.swap.M2, 6)}`);
  // checks: the all-accepted path's fills and TPs are the paths' (signal side, and the opposite on its own path)
  const vsPaths = (u: AccountOut, ps: Path[], orders: OrderIn[]) => {
    const by = new Map(u.trades.map((t) => [t.sig, t]));
    // each email's fate in the all-accepted path ("none": not ordered, or the engine found no price before P)
    const fateBy = ps.map(() => "none");
    u.fates.forEach((f, k) => (fateBy[orders[k].sig] = f));
    let bad = 0;
    const ex: string[] = [];
    ps.forEach((p, i) => {
      const t = by.get(i);
      const pf = !p.none && p.fillK !== -2;
      const ok = (p.none === (fateBy[i] === "none")) && (pf ? !!t && t.t0 === p.t0 && t.fill === p.fill && (p.tpK >= 0 ? t.how === "tp" && t.x === p.x && t.exit === p.exit : t.how === "held" && t.exit === p.endPx) : !t);
      if (!ok) {
        bad++;
        if (ex.length < 5) ex.push(`${i} ${sigs[i].pair} ${iso(sigs[i].T)}`);
      }
    });
    return { compared: ps.length, mismatched: bad, examples: ex };
  };
  // the orders handed in leave out the emails whose path is nothing at all: the all-accepted path must then leave
  // exactly those unordered — and an email the engine finds no price for must be one the path left out
  const vp = vsPaths(unlOut.main, paths.main, oMain);
  const oOpp = ordersOf(vOf("opposite"));
  const vo = vsPaths(runAccount(mk(ds.m1s), oOpp, { ...base, unlimited: true }), paths.opposite, oOpp);
  checks.engineVsPaths = { ok: vp.mismatched === 0 && vo.mismatched === 0, detail: { signal: vp, opposite: vo }, n: vp.mismatched + vo.mismatched };
  // checks ((b)): the rows that keep P unmoved (judged in the stop) order every email whose own path is not nothing —
  // none left out for a P before the account's start
  if (mode === "b") {
    const dropped: string[] = [];
    let nDrop = 0;
    for (const [name, a2] of [["judgeMaint", outs.judgeMaint], ["unlimited-judgeMaint", unlOut.judgeMaint]] as const) {
      a2.fates.forEach((f, k) => {
        const i = oMain[k].sig;
        if (f !== "none" || paths.judgeMaint[i].none) return;
        nDrop++;
        if (dropped.length < 5) dropped.push(`${name} ${sigs[i].pair} ${iso(sigs[i].T)}`);
      });
    }
    checks.judgeMaintOrders = { ok: nDrop === 0, detail: { dropped }, n: nDrop };
  }
  // checks: no TP in the minute a trade came in on, every account row and the all-accepted paths
  const tpAfterA = { compared: 0, bad: 0, examples: [] as string[] };
  for (const [name, a] of [...Object.entries(outs), ...Object.entries(unlOut).map(([k, u]) => [`unlimited-${k}`, u] as const)]) {
    for (const t of a.trades) {
      if (t.how !== "tp") continue;
      tpAfterA.compared++;
      if (!(t.x > t.t0)) {
        tpAfterA.bad++;
        if (tpAfterA.examples.length < 5) tpAfterA.examples.push(`${name} ${t.sig} ${sigs[t.sig].pair} ${iso(sigs[t.sig].T)}`);
      }
    }
  }
  checks.tpAfterEntryAccount = { ok: tpAfterA.bad === 0, detail: tpAfterA, n: tpAfterA.bad };
  // checks: the engine's cut mode (what the clock has not reached rewritten) changes nothing, on the decision rows and the all-accepted path
  const cut: Record<string, unknown> = {};
  let cutOk = true;
  for (const r of rowsA.filter((x) => x.decide)) {
    for (const pp of [777.7, -777.7]) {
      const c = runAccount(mk(r.books ?? ds.m1s, r.from), r.orders, { ...r.o, poisonPips: pp });
      const same = JSON.stringify({ ...c, poisoned: 0 }) === JSON.stringify({ ...outs[r.name], poisoned: 0 });
      cut[`${r.name} ${pp}`] = { poisoned: c.poisoned, same };
      if (c.poisoned !== 0 || !same) cutOk = false;
    }
  }
  for (const pp of [777.7, -777.7]) {
    const c = runAccount(mk(ds.m1s), oMain, { ...base, unlimited: true, poisonPips: pp });
    const same = JSON.stringify({ ...c, poisoned: 0 }) === JSON.stringify({ ...unlOut.main, poisoned: 0 });
    cut[`unlimited ${pp}`] = { poisoned: c.poisoned, same };
    if (c.poisoned !== 0 || !same) cutOk = false;
  }
  // n: the reads rewritten (each one a look ahead), and the rows whose run changed under the rewriting
  const cutN = Object.values(cut as Record<string, { poisoned: number; same: boolean }>).reduce((a2, c) => a2 + c.poisoned + (c.same ? 0 : 1), 0);
  checks.lookAheadAccount = { ok: cutOk, detail: cut, n: cutN };
  // checks: E* just over runs clean, just under does not (each decision row)
  const est: Record<string, unknown> = {};
  let estOk = true;
  for (const [name, row] of [["main", "main"], ["mainSwap", "mainSwap"], ["worst", "worst"], ["worstSwap", "worstSwap"]] as const) {
    const E = (unlOut[name].estar?.value ?? 0);
    const r = rowsA.find((x) => x.name === row)!;
    const events = (a: AccountOut) => a.fates.filter((f) => f === "refusedMargin" || f === "refusedCall" || f === "cancelCall" || f === "cancelLc").length + a.lcs.length + a.calls.length;
    const up = runAccount(mk(ds.m1s), r.orders, { ...r.o, start: E * (1 + 1e-9), cap: Math.max(ctx.cap, E * 2) });
    const dn = runAccount(mk(ds.m1s), r.orders, { ...r.o, start: E * (1 - 1e-6), cap: E * (1 - 1e-6) });
    // bad: the all-accepted path's terms that were not numbers
    const bad = unlOut[name].estarBad;
    est[name] = { estar: E, over: events(up), under: events(dn), bad };
    if (!(E > 0) || events(up) !== 0 || events(dn) === 0 || bad !== 0) estOk = false;
  }
  const estFails = Object.entries(est as Record<string, { estar: number; over: number; under: number; bad: number }>).filter(([, e]) => !(e.estar > 0) || e.over !== 0 || e.under === 0 || e.bad !== 0);
  // why, without a measured number (MODE=real prints it): each failing row's four conditions
  const yn = (b: boolean) => (b ? "yes" : "NO");
  const estWhy = estFails.map(([k, e]) => `${k}: E* a positive number ${yn(e.estar > 0)}, nothing just over ${yn(e.over === 0)}, something just under ${yn(e.under !== 0)}, every term a number ${yn(e.bad === 0)}`).join("; ");
  checks.estar = { ok: estOk, detail: est, n: estFails.length, why: estWhy };

  // ---- the counts beside them ----
  const between = tausOf(closes);
  // swap nights and days of the all-accepted path's trades, by pair and side; the days a trade (to TP or END)
  const swapDays: Record<string, { trades: number; nights: number; days: number; quote: number }> = {};
  let daysAll = 0;
  for (const t of unlOut.mainSwap.trades) {
    const k = `${PAIRS[t.pi]} ${t.dir === 1 ? "BUY" : "SELL"} ${t.how === "tp" ? "tp" : "held"}`;
    const span = between(t.t0, Number.isFinite(t.x) ? t.x : ctx.end);
    const c = (swapDays[k] ??= { trades: 0, nights: 0, days: 0, quote: 0 });
    c.trades++;
    c.nights += span.nights;
    c.days += span.swap;
    c.quote += t.swapQuote;
    daysAll += span.swap;
  }
  const nightsEngine = unlOut.mainSwap.swapNights;
  const nightsTrades = Object.values(swapDays).reduce((s, c) => s + c.nights, 0);
  checks.swapNights = { ok: nightsEngine === nightsTrades, detail: { engine: nightsEngine, trades: nightsTrades }, n: Math.abs(nightsEngine - nightsTrades) };
  // checks: the swap's rule (§8.102 確かめ A) on every NY close and pair, both markups: a buy's and a sell's
  // together −2 × the markup × the amount × the days ÷ 365, the days tausOf's (a Wednesday's three), a buy's
  // the rates' difference less the markup, and a USD/JPY sell paying while the dollar's rate is over the yen's
  const rule = { compared: 0, bad: 0, usdJpySellsPaying: 0, examples: [] as string[] };
  const midAtTau = (pi: number, tau: number) => {
    const m = ds.m1s[pi];
    const j = lastEnded(m, tau);
    return j >= 0 ? (m.bc[j] + m.ac[j]) / 2 : NaN;
  };
  for (const c of closes) {
    if (c.tau < ctx.start || c.tau > ctx.end) continue;
    const days = between(c.tau - 1, c.tau + 1).swap;
    for (const [pi, pair] of PAIRS.entries()) {
      const mid = midAtTau(pi, c.tau);
      if (!Number.isFinite(mid)) continue;
      const [ba, qa] = AREAS[pair];
      const rb = ds.rates(ba, c.tau)!;
      const rq = ds.rates(qa, c.tau)!;
      for (const [fn, markup] of [[swapMain, 0.5], [swap10, 1.0]] as const) {
        const buy = fn(pair, 1, c.tau, mid);
        const sell = fn(pair, -1, c.tau, mid);
        const per = (10_000 * mid * days) / 365 / 100;
        const near = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
        rule.compared++;
        const ok = near(buy + sell, -2 * markup * per) && near(buy, (rb - rq - markup) * per) && (pair !== "USD/JPY" || !(rb > rq) || sell < 0);
        if (pair === "USD/JPY" && rb > rq && sell < 0) rule.usdJpySellsPaying++;
        if (!ok) {
          rule.bad++;
          if (rule.examples.length < 5) rule.examples.push(`${pair} ${iso(c.tau)} markup ${markup}`);
        }
      }
    }
  }
  // (none compared only where no close with prices falls in the period: a short hand example)
  const closesIn = closes.filter((c) => c.tau >= ctx.start && c.tau <= ctx.end && PAIRS.some((_p, pi) => Number.isFinite(midAtTau(pi, c.tau)))).length;
  checks.swapRule = { ok: rule.bad === 0 && (rule.compared > 0 || closesIn === 0), detail: { ...rule, closesIn }, n: rule.bad };
  // checks: each trade's swap in the all-accepted path with the main swap, made again from the closes it was held
  // over (entered before τ, still held at τ + 15 minutes, or at END) at each τ's mid — the engine's own sum
  const again = { compared: 0, bad: 0, examples: [] as string[] };
  for (const t of unlOut.mainSwap.trades) {
    const until = Number.isFinite(t.x) ? t.x : ctx.end;
    let q = 0;
    for (const c of closes) {
      if (!(t.t0 < c.tau) || c.tau + 15 * MINUTE > until || c.tau < ctx.start) continue;
      q += swapMain(PAIRS[t.pi], t.dir, c.tau, midAtTau(t.pi, c.tau));
    }
    again.compared++;
    if (Math.abs(q - t.swapQuote) > 1e-6 * Math.max(1, Math.abs(q))) {
      again.bad++;
      if (again.examples.length < 5) again.examples.push(`${PAIRS[t.pi]} ${t.dir === 1 ? "BUY" : "SELL"} ${iso(sigs[t.sig].T)}`);
    }
  }
  checks.swapAgain = { ok: again.bad === 0, detail: again, n: again.bad };
  const mainLine = out.accounts.main;
  // the main account's trades' swap days, for the swap that would bring it to 0 a day
  let mainDays = 0;
  for (const t of outs.main.trades) mainDays += between(t.t0, Number.isFinite(t.x) ? t.x : ctx.end).swap;
  // NY closes judged on a price that does not end at τ (Friday, a long gap, other)
  const fallback = { friday: 0, gap: 0, other: 0, weekdayDates: [] as string[] };
  for (const c of closes) {
    if (c.tau < ctx.start || c.tau > ctx.end) continue;
    const j = lastEnded(usdjpy, c.tau);
    if (j >= 0 && usdjpy.t[j] + MINUTE === c.tau) continue;
    const wd = new Date(c.tau).getUTCDay();
    if (wd === 5) fallback.friday++;
    else if (j < 0 || c.tau - (usdjpy.t[j] + MINUTE) > 60 * MINUTE) {
      fallback.gap++;
      fallback.weekdayDates.push(iso(c.tau).slice(0, 10));
    } else {
      fallback.other++;
      fallback.weekdayDates.push(iso(c.tau).slice(0, 10));
    }
  }
  // gaps over 60 minutes on weekdays (outside the weekend's closure)
  const gaps: string[] = [];
  let gapCount = 0;
  for (const m of ds.m1s) {
    for (let k = 1; k < m.n; k++) {
      const d = m.t[k] - m.t[k - 1];
      if (d <= 60 * MINUTE) continue;
      const a = new Date(m.t[k - 1]);
      if (d > 30 * 60 * MINUTE && (a.getUTCDay() === 5 || a.getUTCDay() === 6 || a.getUTCDay() === 0)) continue;
      gapCount++;
      if (gaps.length < 60) gaps.push(`${m.pair} ${iso(m.t[k - 1] + MINUTE)} .. ${iso(m.t[k])}`);
    }
  }
  // the USD balance's negative-conversion rule: the first business day's NY close where it would apply (counted, not applied)
  out.extra = {
    swapDays,
    breakEvenSwap: mainDays > 0 ? -mainLine.S / mainDays : null,
    mainDays,
    allDays: daysAll,
    rakutenApplied: rakApplied.map((n, p) => ({ pair: PAIRS[p], bars: ds.m1s[p].n, applied: n })),
    rakutenTrades: rakShare(outs.rakuten, sigs, ctx.split),
    fallback,
    gaps: { count: gapCount, list: gaps },
    shifted: paths.main.filter((p) => p.shifted).length,
    late: { signals: sigs.filter((s) => s.late).length },
    ifMarket: ifMarket(paths.market, outs.main, oMain, sigs, booksMain),
    m15Gaps: ds.m15Gaps ?? null,
  };
  void maintOf;
  void NO_CUT;
  void isUsdPair;
  void usdJpyAt;
  // ---- the files for the Python check ----
  out.dump = dumpOf(ds, paths, outs, unlOut, third, oMain);
  out.dump["emails.csv"] = ["i,d1,d1o,gap1,gap1o,w1,w1o", ...vals.map((v, i) => [i, v.d1, v.d1o, v.g1, v.g1o, v.w1, v.w1o].join(","))].join("\n");
  out.raw = { outs, unl: unlOut };
  void ctx;
  return out;
};

// the share of the Rakuten row's trades whose entry and exit fell where §8.99's table has a spread
const rakShare = (a: AccountOut, sigs: Sig[], split: number) => {
  const by: Record<string, { entries: number; entriesApplied: number; exits: number; exitsApplied: number }> = {};
  for (const t of a.trades) {
    const pair = PAIRS[t.pi];
    const half = sigs[t.sig].T < split ? "first" : "second";
    const c = (by[`${pair} ${half}`] ??= { entries: 0, entriesApplied: 0, exits: 0, exitsApplied: 0 });
    c.entries++;
    if (rakutenSpread(pair, t.t0) !== null) c.entriesApplied++;
    if (Number.isFinite(t.x)) {
      c.exits++;
      if (rakutenSpread(pair, t.x) !== null) c.exitsApplied++;
    }
  }
  return by;
};

// the emails the main account did not take, as if taken at the market at P: by why not
const ifMarket = (ps: Path[], a: AccountOut, orders: OrderIn[], sigs: Sig[], books: Book[]) => {
  const groups: Record<string, { n: number; tp: number; pips: number }> = {};
  const fateOf = new Map<number, string>();
  // a.fates is in the orders' order: each one's email by its sig
  a.fates.forEach((f, k) => fateOf.set(orders[k].sig, f));
  ps.forEach((p, i) => {
    if (p.none) return;
    const f = fateOf.get(i) ?? "none";
    const g = f === "refusedMargin" || f === "refusedCall" ? "refused" : f === "unfilled" ? "unfilled" : f === "cancelCall" || f === "cancelLc" ? "cancelled" : "placed";
    const c = (groups[g] ??= { n: 0, tp: 0, pips: 0 });
    const s = sigs[i];
    const pips = p.tpK >= 0 ? (s.dir * (p.exit - p.fill)) / books[s.pi].unit : (s.dir * (p.endPx - p.fill)) / books[s.pi].unit;
    c.n++;
    if (p.tpK >= 0) c.tp++;
    c.pips += pips;
  });
  return Object.fromEntries(Object.entries(groups).map(([k, c]) => [k, { n: c.n, winRate: c.n ? c.tp / c.n : null, pips: c.n ? c.pips / c.n : null }]));
};

// the CSVs the Python check reads (its own inputs: the signals) and compares (the rest)
const dumpOf = (ds: DataSet, paths: Record<string, Path[]>, outs: Record<string, AccountOut>, unl: Record<string, AccountOut>, third: Analysis["third"], orders: OrderIn[]): Record<string, string> => {
  const d: Record<string, string> = {};
  // (b): the email's sent time beside them (the Python makes P from it on its own)
  const withSent = ds.sigs.some((s) => s.sent !== undefined);
  d["signals.csv"] = [`i,pair,side,open,T,E,tp,late,base${withSent ? ",sent" : ""}`, ...ds.sigs.map((s, i) => `${i},${s.pair},${s.side},${s.open},${s.T},${s.E},${s.tp},${s.late ? 1 : 0},${s.base}${withSent ? `,${s.sent}` : ""}`)].join("\n");
  for (const v of ["main", "opposite"]) {
    d[`paths-${v}.csv`] = ["i,P,shifted,noBar,none,market,fillK,t0,fill,fillGap,tpK,x,exit,tpGap,tpInFill,mae,endPx", ...paths[v].map((p, i) => [i, p.P, +p.shifted, +p.noBar, +p.none, +p.market, p.fillK, p.t0, p.fill, +p.fillGap, p.tpK, p.x, p.exit, +p.tpGap, +p.tpInFill, p.mae, p.endPx].join(","))].join("\n");
  }
  const acct = (name: string, a: AccountOut) => {
    d[`acct-${name}-trades.csv`] = ["sig,pi,dir,market,t0,fill,fillGap,x,exit,how,tpGap,quote,yen,swapQuote,swapYen", ...a.trades.map((t) => [t.sig, t.pi, t.dir, +t.market, t.t0, t.fill, +t.fillGap, t.x, t.exit, t.how, +t.tpGap, t.quote, t.yen, t.swapQuote, t.swapYen].join(","))].join("\n");
    d[`acct-${name}-calls.csv`] = ["tau,deadline,D,cancelled,deposits,credits,uAfterDeposit,end,endAt", ...a.calls.map((c) => [c.tau, c.deadline, c.D, c.cancelled, c.deposits, c.credits, c.uAfterDeposit, c.end, c.endAt].join(","))].join("\n");
    d[`acct-${name}-lcs.csv`] = ["at,naBefore,naAfter,closed,cancelled", ...a.lcs.map((l) => [l.at, l.naBefore, l.naAfter, l.closed, l.cancelled].join(","))].join("\n");
    d[`acct-${name}-deposits.csv`] = ["at,amount,total,why", ...a.deposits.map((x) => [x.at, x.amount, x.total, x.why].join(","))].join("\n");
    // every email's fate by its index ("none": not ordered — its path is nothing at all); the rows written use the main orders
    const bySig = ds.sigs.map(() => "none");
    a.fates.forEach((f, k) => (bySig[orders[k].sig] = f));
    d[`acct-${name}-fates.csv`] = ["k,fate", ...bySig.map((f, k) => `${k},${f}`)].join("\n");
    d[`acct-${name}-summary.json`] = JSON.stringify({ naSplit: a.naSplit, inSplit: a.inSplit, naEnd: a.naEnd, inEnd: a.inEnd, estar: a.estar, estarBy: a.estarBy, mSplit: a.mSplit, mEnd: a.mEnd, swapNights: a.swapNights });
  };
  for (const n of ["main", "mainSwap", "worst", "worstSwap", "dep0859"]) acct(n, outs[n]);
  for (const n of ["main", "mainSwap", "worst", "worstSwap"]) acct(`unlimited-${n}`, unl[n]);
  d["third.json"] = JSON.stringify(third);
  return d;
};

// ---- the synthetic runs (確かめ A) -------------------------------------------------------------

const range = (s: string) => s.split(",").flatMap((x) => {
  const [a, b] = x.split("-").map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, k) => a + k) : [a];
});

const writeJson = async (path: string, x: unknown) => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(x, null, 1));
};
export const writeDump = async (dir: string, a: Analysis, ctx: Ctx, extra: Record<string, unknown> = {}) => {
  await Deno.mkdir(dir, { recursive: true });
  for (const [k, v] of Object.entries(a.dump)) await Deno.writeTextFile(`${dir}/${k}`, v);
  await Deno.writeTextFile(`${dir}/meta.json`, JSON.stringify({ start: ctx.start, end: ctx.end, split: ctx.split, delay: DELAY, startYen: ctx.startYen, cap: ctx.cap, ...extra }));
};

const T_999 = 3.8834; // t(19), two-sided 99.9% (§8.102 確かめ A (ii))

if (MODE === "synthetic") {
  const sets = env("SETS", "none,t01,t03").split(",");
  const seeds = range(env("SEEDS", "1-20"));
  const full = new Set(range(env("FULL", "1")));
  const plants = env("PLANTS", "").split(",").filter(Boolean);
  const result: Record<string, unknown> = { start: START, end: END, split: SPLIT, sets, seeds: [...seeds], full: [...full] };
  const gates: Record<string, unknown> = {};
  let pass = true;
  for (const set of sets) {
    const mains: number[] = [];
    let lowOver = 0;
    const planted = { weekCells: { lowOver: 0, mains: [] as number[] }, plain: { lowOver: 0, mains: [] as number[] } };
    for (const seed of seeds) {
      const t0 = Date.now();
      const isFull = set === "none" && full.has(seed);
      const dir = `${OUT}/syn-${set}-${seed}`;
      const ds = await dataSetOf(`${set} ${seed}`, isFull ? { dir: `${dir}/gmo`, fetch: false } : null, { set, seed });
      const a = analyse(ds, CTX, isFull ? "all" : "third");
      const th = a.third;
      if (th.main.main === null || th.main.L === null) throw new Error(`${set} ${seed}: ③ could not be formed (a pair-side cell empty)`);
      mains.push(th.main.main);
      if (th.main.L > 0) lowOver++;
      for (const k of ["weekCells", "plain"] as const) {
        planted[k].mains.push(th[k].main ?? NaN);
        if ((th[k].L ?? -Infinity) > 0) planted[k].lowOver++;
      }
      log(`${set} seed ${seed}: signals ${a.signals.count} (late ${a.signals.late}), ③ main ${th.main.main.toFixed(3)} L ${th.main.L.toFixed(3)} (n ${th.rows}), plain ${th.plain.main?.toFixed(3)}, week-cells ${th.weekCells.main?.toFixed(3)} L ${th.weekCells.L?.toFixed(3)}; checks ${Object.entries(a.checks).map(([k, c]) => `${k}:${c.ok ? "ok" : "FAIL"}`).join(" ")} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      for (const [k, c] of Object.entries(a.checks)) if (!c.ok) {
        pass = false;
        log(`  CHECK ${k} FAILED: ${JSON.stringify(c.detail).slice(0, 2000)}`);
      }
      if (isFull) {
        // what each planted error changed and which own checks failed (the plants job sums these with the hand examples')
        const plantsFull: Record<string, { changed: number; all?: number; checks: Record<string, number> }> = {};
        await writeJson(`${dir}/analysis.json`, { ...a, dump: undefined, decisions: undefined, raw: undefined });
        await writeDump(`${dir}/dump`, a, CTX);
        await Deno.writeTextFile(`${dir}/decisions.txt`, a.decisions.join("\n"));
        log(`  full: ${JSON.stringify({ accounts: Object.fromEntries(["main", "mainSwap", "worst", "worstSwap"].map((n) => [n, { S: a.accounts[n].S, lcs: a.accounts[n].lcs, deadlines: a.accounts[n].deadlines, capped: a.accounts[n].capped, calls: a.accounts[n].calls, win: a.accounts[n].winRate, pips: a.accounts[n].pips }])), estar: Object.fromEntries(Object.entries(a.estar).map(([k, v]) => [k, (v as { estar: { value: number } }).estar?.value])), m: a.m })}`);
        // the planted signal error: E from the bar after (look-ahead), which the cut check must catch on every pair
        if (plants.includes("signalNextBar")) {
          const qs = await Promise.all(PAIRS.map((pair) => load15({ dir: `${dir}/gmo`, fetch: false }, pair, START_MS - LEAD15, END_MS, newLoadStats())));
          const caught = PAIRS.map((pair, pi) => signalsOf(pair, pi, qs[pi], START_MS, END_MS, true, "signalNextBar").cut!).map((c) => c.mismatched);
          log(`  planted signalNextBar: the cut check's mismatches by pair ${caught.join(",")}`);
          if (caught.some((m) => m === 0)) pass = false;
          const cutAll = caught.reduce((a2, m) => a2 + m, 0);
          plantsFull.signalNextBar = { changed: cutAll, checks: caught.every((m) => m > 0) ? { signalCut: cutAll } : {} };
        }
        // the planted errors on this walk: what each one changes, and which checks see it
        for (const plant of plants.filter((x: string) => x !== "signalNextBar")) {
          const b = analyse(ds, CTX, "all", plant);
          const ch = changedOf(a.decisions, b.decisions, plant);
          // the own checks that failed, each with how many mismatches it found
          const failed = Object.fromEntries(Object.entries(b.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.n ?? 1]));
          log(`  planted ${plant}: ${ch.all} decisions or numbers changed, ${ch.counted} on its rows; own checks failing: ${Object.entries(failed).map(([k, v]) => `${k} ${v}`).join(",") || "none"}`);
          plantsFull[plant] = { changed: ch.counted, all: ch.all, checks: failed };
          await Deno.writeTextFile(`${dir}/decisions-${plant}.txt`, b.decisions.join("\n"));
          await writeDump(`${dir}/dump-${plant}`, b, CTX);
        }
        await writeJson(`${dir}/plants-full.json`, plantsFull);
      }
    }
    // gate (i): L over 0 in at most 2 of 20; gate (ii): the mean within 3.88 × SD ÷ √20 of 0
    const n = mains.length;
    const mean = mains.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(mains.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
    const se = sd / Math.sqrt(n);
    // judged on the 20 walks a set (a run of fewer, a part of 確かめ A run elsewhere, is not judged)
    const judgedGates = n >= 20;
    const g1 = lowOver <= 2;
    const g2 = judgedGates ? Math.abs(mean) <= T_999 * se : true;
    const pm = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      const s = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) / Math.sqrt(xs.length);
      return { mean: m, se: s, within: Math.abs(m) <= T_999 * s };
    };
    gates[set] = { runs: n, lowOver, gateI: g1, mean, se, t: mean / se, gateII: g2, planted: { weekCells: { lowOver: planted.weekCells.lowOver, caughtByI: planted.weekCells.lowOver > 2, ...pm(planted.weekCells.mains) }, plain: { lowOver: planted.plain.lowOver, ...pm(planted.plain.mains), caughtByII: !pm(planted.plain.mains).within } } };
    log(`\n== ${set}: ③ L > 0 in ${lowOver} of ${n} (gate (i): ${g1 ? "ok" : "FAIL"}); mean ${mean.toFixed(4)} ± ${se.toFixed(4)} (t ${(mean / se).toFixed(2)}; gate (ii) |t| ≤ ${T_999}: ${g2 ? "ok" : "FAIL"})`);
    log(`   planted week cells: L > 0 in ${planted.weekCells.lowOver} of ${n}; plain: mean ${pm(planted.plain.mains).mean.toFixed(4)} ± ${pm(planted.plain.mains).se.toFixed(4)}`);
    if (judgedGates && (!g1 || !g2)) pass = false;
    if (!judgedGates) log(`   (gates not judged: ${n} walks)`);
  }
  // the planted ③ errors must be caught (§8.102 確かめ A): the week cells by (i) on every set, the plain mean by
  // (ii) on the trend sets — judged once 20 walks a set were run
  const gp = gates as Record<string, { runs: number; planted: { weekCells: { caughtByI: boolean }; plain: { caughtByII: boolean } } }>;
  for (const set of sets) {
    const g = gp[set];
    if (g.runs < 20) {
      log(`planted ③ errors on ${set}: not judged (${g.runs} walks)`);
      continue;
    }
    const wc = g.planted.weekCells.caughtByI;
    const pl = set === "none" ? true : g.planted.plain.caughtByII;
    log(`planted ③ errors on ${set}: week cells caught by (i) ${wc ? "yes" : "NO"}${set === "none" ? "" : `; plain mean caught by (ii) ${pl ? "yes" : "NO"}`}`);
    if (!wc || !pl) pass = false;
  }
  result.gates = gates;
  result.pass = pass;
  await writeJson(`${OUT}/synthetic.json`, result);
  log(`\n確かめ A (this run): ${pass ? "PASSED" : "FAILED"}`);
  if (!pass) Deno.exit(1);
}

if (MODE === "fixtures") {
  const plants = env("PLANTS", "").split(",").filter(Boolean);
  const only = env("ONLY", "");
  let pass = true;
  const byPlant: Record<string, { changed: number; all: number; flagged: string[]; workedOut: number; checks: Record<string, number> }> = {};
  for (const f of FIXTURES) {
    if (only && !only.split(",").includes(f.name)) continue;
    const ds: DataSet = { name: f.name, m1s: f.m1s, sigs: f.sigs, reads: [], load: newLoadStats(), src: null, rates: synRates };
    const a = analyse(ds, f.ctx, "all");
    const fails = f.check(a.raw!.outs, a.raw!.unl);
    const bad = Object.entries(a.checks).filter(([, c]) => !c.ok).map(([k]) => k);
    log(`${f.name}: ${fails.length ? "NOT AS WORKED OUT: " + fails.join("; ") : "as worked out"}; checks ${bad.length ? "FAILED " + bad.join(",") : "ok"} — ${f.what}`);
    for (const k of bad) log(`  ${k}: ${JSON.stringify(a.checks[k].detail).slice(0, 1500)}`);
    if (fails.length || bad.length) pass = false;
    const dir = `${OUT}/fixtures/${f.name}`;
    for (const m of f.m1s) await writeGmoFiles(`${dir}/gmo`, m.pair, { m1: m, q15: [] }, f.ctx.start - DAY_MS, f.ctx.end);
    await writeDump(`${dir}/dump`, a, f.ctx);
    await Deno.writeTextFile(`${dir}/decisions.txt`, a.decisions.join("\n"));
    for (const plant of plants) {
      const b = analyse(ds, f.ctx, "all", plant);
      const ch = changedOf(a.decisions, b.decisions, plant);
      const changed = ch.counted;
      const pf = f.check(b.raw!.outs, b.raw!.unl);
      const pb = Object.entries(b.checks).filter(([, c]) => !c.ok);
      const e = (byPlant[plant] ??= { changed: 0, all: 0, flagged: [], workedOut: 0, checks: {} });
      e.changed += changed;
      e.all += ch.all;
      // the worked-out values that did not hold, and each own check's mismatches, summed over the hand examples
      if (pf.length) e.flagged.push(f.name);
      e.workedOut += pf.length;
      for (const [k, c] of pb) e.checks[k] = (e.checks[k] ?? 0) + (c.n ?? 1);
      if (ch.all) await writeDump(`${dir}/dump-${plant}`, b, f.ctx);
    }
  }
  for (const [plant, e] of Object.entries(byPlant)) log(`planted ${plant}: ${e.all} decisions or numbers changed over the hand examples, ${e.changed} on its rows; their worked-out checks fail in ${e.flagged.join(",") || "none"} (${e.workedOut} values); own checks failing: ${Object.entries(e.checks).map(([k, v]) => `${k} ${v}`).join(",") || "none"}`);
  await writeJson(`${OUT}/fixtures/plants-fixtures.json`, byPlant);
  log(`hand examples: ${pass ? "all as worked out" : "NOT ALL AS WORKED OUT"}`);
  if (!pass) Deno.exit(1);
}

// Before tf-winrate (the real job's first step): the kept day files (1-, 5- and 15-minute) answered
// before their day's file had ended — kept by a study that ran while the day was going on — or kept
// without the time they were answered (a 404) are removed, so tf-winrate and this program both read them again
if (MODE === "cache") {
  const keys = dateKeys(START_MS - LEAD15 - 2 * DAY_MS, END_MS, "day");
  const c = { whole: 0, removed: 0, notKept: 0, byInterval: {} as Record<string, number> };
  for (const pair of PAIRS) {
    for (const iv of ["1min", "5min", "15min"]) {
      for (const side of ["bid", "ask"]) {
        for (const key of keys) {
          const path = `${CACHE}/${GMO_SYMBOLS[pair]}/${iv}/${side}/${key}.json`;
          let body: unknown;
          try {
            body = JSON.parse(await Deno.readTextFile(path));
          } catch {
            c.notKept++;
            continue;
          }
          if (wholeDayFile(body, key)) {
            c.whole++;
            continue;
          }
          await Deno.remove(path);
          c.removed++;
          c.byInterval[iv] = (c.byInterval[iv] ?? 0) + 1;
        }
      }
    }
  }
  log(`kept day files: ${c.whole} whole, ${c.removed} removed (${JSON.stringify(c.byInterval)}), ${c.notKept} not kept`);
}

if (MODE === "real") {
  const t0 = Date.now();
  const src: Source = { dir: CACHE, fetch: true };
  const ds = await dataSetOf("real", src, null);
  log(`loaded: ${JSON.stringify(ds.load)}; signals ${ds.sigs.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  // the data's own gaps (no measured number): 15-minute slots without a bar beside 1-minute bars
  for (const g of ds.m15Gaps ?? []) log(`${g.pair}: 15-minute slots without a bar beside 1-minute bars ${g.slots}${g.examples.length ? " (" + g.examples.slice(0, 5).join(", ") + ")" : ""}`);
  const a = analyse(ds, CTX, "all");
  // B(2): the email rule reproduced on 5-minute bars against tf-winrate's own JSON
  checks: {
    const tfw = env("TFW_JSON");
    if (!tfw) {
      a.checks.tfWinrate = { ok: false, detail: "no TFW_JSON" };
      break checks;
    }
    a.checks.tfWinrate = await reproduce(ds, JSON.parse(await Deno.readTextFile(tfw)));
  }
  await writeJson(`${OUT}/real/checks.json`, a.checks);
  await writeJson(`${OUT}/real/analysis.json`, { ...a, dump: undefined, decisions: undefined, raw: undefined });
  await writeDump(`${OUT}/real/dump`, a, CTX);
  await Deno.writeTextFile(`${OUT}/real/decisions.txt`, a.decisions.join("\n"));
  // the per-email values for (b)'s comparison (ultra15-a.csv): written now, committed only from a run whose checks all passed
  await Deno.writeTextFile(`${OUT}/real/ultra15-a.csv`, aCsv(ds, a));
  let ok = true;
  for (const [k, c] of Object.entries(a.checks)) {
    // only whether each check passed; a failed one's detail holds no measured number but is not printed either
    log(`check ${k}: ${c.ok ? "ok" : "FAILED"}`);
    // a check's own reason, written without a measured number (only the E* check has one)
    if (!c.ok && c.why) log(`  ${c.why}`);
    if (!c.ok) ok = false;
  }
  log(`TypeScript checks: ${ok ? "all passed" : "FAILED"} (${((Date.now() - t0) / 1000).toFixed(0)} s). The numbers are in ${OUT}/real, printed only by MODE=print after the Python check.`);
  if (!ok) Deno.exit(1);
}

if (MODE === "print") {
  const dir = `${OUT}/real`;
  const checks = JSON.parse(await Deno.readTextFile(`${dir}/checks.json`)) as Record<string, { ok: boolean }>;
  const py = JSON.parse(await Deno.readTextFile(env("PYCHECK", `${dir}/pycheck.json`))) as { ok: boolean };
  if (!Object.values(checks).every((c) => c.ok) || !py.ok) {
    log("a check failed: the numbers are not printed (§8.102 確かめ B (5))");
    Deno.exit(1);
  }
  log(await Deno.readTextFile(`${dir}/analysis.json`));
  // (a)'s per-email values, to be committed as research/ledger/ultra15-a.csv (with its sha256 to check the copy)
  const csv = await Deno.readTextFile(`${dir}/ultra15-a.csv`);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(csv)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  log(`== ultra15-a.csv sha256 ${hash}, ${csv.split("\n").length - 1} rows`);
  log(csv);
}

// ---- §8.103 ② stage 2 (5, 6, 7): the slots avoided tested on data the rule was not chosen on ------------------

// the planted errors of 7 (9) that change the computing (the others stop a run: below)
const COST_PLANTS = ["slotFromOpen", "vExit", "noWeekCell", "fridayIn", "holidayIn", "keptMeanAll", "pastEndIn", "blocks4", "ruleOrdersAvoided", "midAhead"];
const Y23_RANGE: Range = { start: Y23_START, end: Y23_END, from15: Y23_FROM15 };
// 7 (11): (a)'s fourteen checks less tf-winrate's
const Y23_CHECKS = ["loads", "signalProbe", "signalCut", "lookAheadPaths", "tpAfterEntryPaths", "engineVsPaths", "tpAfterEntryAccount", "lookAheadAccount", "estar", "swapNights", "swapRule", "swapAgain", "dOutside"];
const COST_OUT = `${OUT}/cost`;
const PROVISIONAL_DIR = "research/out/costhours";

// the provisional files (7 (0)): written where only the synthetic modes read them, and read back as the real file is
const provisional = async (which: "1h" | "4h"): Promise<SlotsFile> => {
  const text = provisionalCsv(PAIRS, which === "1h" ? PROVISIONAL_1H : PROVISIONAL_4H);
  await Deno.mkdir(PROVISIONAL_DIR, { recursive: true });
  await Deno.writeTextFile(`${PROVISIONAL_DIR}/provisional-${which}.csv`, text);
  return readSlotsFile(await Deno.readTextFile(`${PROVISIONAL_DIR}/provisional-${which}.csv`), PAIRS);
};

// One run's ② on its bars and emails (5): the values, the judgments, the summary, the checks of 7 (8)
const costOf = (m1s: M1[], ms: Mails, slots: SlotsFile, start: number, end: number, plant = "", accounts = true) => {
  const books = booksOf(m1s, start, end);
  const { es, paths } = emailsOf(books, ms, end, plant);
  const js = judge(es, slots.avoid, { end, plant });
  const s = summaryOf(es, js, slots.bars, plant);
  const mid = midLookAhead(books, ms, paths, end, plant);
  const wk = weekOutside(es, js);
  const acc = accounts ? ruleAccounts(m1s, ms, paths, js, start, end, plant) : null;
  const checks: Analysis["checks"] = {
    lookAheadMid: { ok: mid.moved === 0 && (mid.compared > 0 || es.every((e) => e.none)), detail: mid, n: mid.moved },
    weekOutside: { ok: wk.n === 0, detail: wk, n: wk.n },
  };
  if (acc) checks.lookAheadAccountRule = { ok: acc.cut.ok, detail: acc.cut, n: acc.cut.poisoned + acc.cut.changed };
  return { es, js, s, paths, acc, checks };
};

// 5「2024年の足を読まない」: the day files opened and the bars kept, inside the period's own; every 15-minute
// window whole (noWindow 0) — a stop's log shows only each pair's 600th bar's close (bar times only)
const readChecksOf = (ds: DataSet, rg: Range, keys: { m1: readonly [string, string]; m15: readonly [string, string] }): Analysis["checks"] => {
  const bad: string[] = [];
  const o = ds.opened;
  if (!o) bad.push("no day file opened");
  else {
    if (!(o.m1[0] >= keys.m1[0] && o.m1[1] <= keys.m1[1])) bad.push(`1-minute day files ${o.m1[0]}..${o.m1[1]}, outside ${keys.m1[0]}..${keys.m1[1]}`);
    if (!(o.m15[0] >= keys.m15[0] && o.m15[1] <= keys.m15[1])) bad.push(`15-minute day files ${o.m15[0]}..${o.m15[1]}, outside ${keys.m15[0]}..${keys.m15[1]}`);
  }
  for (const m of ds.m1s) {
    if (!m.n) bad.push(`${m.pair}: no 1-minute bar`);
    else if (!(m.t[0] >= rg.start - DAY_MS && m.t[m.n - 1] + MINUTE <= rg.end)) bad.push(`${m.pair}: 1-minute bars ${iso(m.t[0])}..${iso(m.t[m.n - 1] + MINUTE)}`);
  }
  for (const r of ds.reads) {
    if (r.first === null || r.last === null) bad.push(`${r.pair}: no 15-minute bar`);
    else if (!(Date.parse(r.first) >= rg.from15 && Date.parse(r.last) + 15 * MINUTE <= rg.end)) bad.push(`${r.pair}: 15-minute bars ${r.first}..${r.last}`);
  }
  const noWindow = ds.reads.map((r) => ({ pair: r.pair, noWindow: r.noWindow, bar600: r.bar600 }));
  const nw = noWindow.reduce((a2, r) => a2 + r.noWindow, 0);
  return {
    readsInPeriod: { ok: bad.length === 0, detail: { opened: o, bad }, n: bad.length, why: bad.length ? `${bad.length} reads outside the period` : undefined },
    noWindow: { ok: nw === 0, detail: noWindow, n: nw, why: nw ? `each pair's 600th 15-minute bar closed at: ${noWindow.map((r) => `${r.pair} ${r.bar600}`).join(", ")}` : undefined },
  };
};

const writeCost = async (dir: string, files: Record<string, string>) => {
  await Deno.mkdir(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) await Deno.writeTextFile(`${dir}/${k}`, v);
};
const judgedChecks = (checks: Analysis["checks"]): boolean => {
  let ok = true;
  for (const [k, c] of Object.entries(checks)) {
    log(`check ${k}: ${c.ok ? "ok" : "FAILED"}`);
    if (!c.ok && c.why) log(`  ${c.why}`);
    if (!c.ok) ok = false;
  }
  return ok;
};

// ---- the hand examples (7 (3)): research/costhours-hand.json, its answers written before this was run ----

interface HandEmail {
  id: string;
  pair: string;
  side: "BUY" | "SELL";
  T: string;
  sent?: string;
  tpPips?: number;
  want: Record<string, unknown>;
}
interface HandRun {
  name: string;
  start: string;
  end: string;
  emails: HandEmail[];
}
interface Hand {
  walk: { seed: number; from: string; to: string; closedKeys: string[]; wide: Array<{ pair: string; from: string; to: string; pips: number }> };
  runs: HandRun[];
  shift: { pips: number };
}
const HAND_PATH = "research/costhours-hand.json";

// the hand emails as signals: P0 T + 2 minutes, or (b)'s from sent; E the open of the order's side in the bar at
// P (moved past the stop), TP E ± tpPips
const handMails = (run: HandRun, m1s: M1[], books: Book[]): Mails => {
  const sigs: Sig[] = [];
  const P0: number[] = [];
  for (const h of run.emails) {
    const pi = PAIRS.indexOf(h.pair as (typeof PAIRS)[number]);
    const T = Date.parse(h.T);
    const sent = h.sent ? Date.parse(h.sent) : undefined;
    const p0 = sent !== undefined ? Math.ceil(sent / MINUTE) * MINUTE + MINUTE : T + DELAY * MINUTE;
    const tau = maintOf(books[pi].taus, p0);
    const P = tau === null ? p0 : tau + MAINT;
    const m = m1s[pi];
    const k = lowerBound(m.t, P);
    if (!(k < m.n && m.t[k] === P)) throw new Error(`hand ${h.id}: no ${h.pair} bar at ${iso(P)}`);
    const dir = h.side === "BUY" ? 1 : -1;
    const E = dir === 1 ? m.ao[k] : m.bo[k];
    const tp = Number((E + dir * (h.tpPips ?? 10) * unitOf(h.pair)).toFixed(h.pair.includes("JPY") ? 3 : 5));
    sigs.push({ pair: h.pair, pi, side: h.side, dir, open: T - 15 * MINUTE, T, E, tp, late: false, base: T, bidC: NaN, askC: NaN, ...(sent !== undefined ? { sent } : {}) });
    P0.push(p0);
  }
  return { sigs, P0 };
};

// the worked-out answers against one run's numbers: each mismatch a line
const handFails = (run: HandRun, c: ReturnType<typeof costOf>): string[] => {
  const fails: string[] = [];
  const at = new Map(run.emails.map((h, i) => [h.id, i]));
  run.emails.forEach((h, i) => {
    const e = c.es[i];
    const j = c.js[i];
    const w = h.want;
    // times as ms (the answers write them as ISO without milliseconds)
    const got: Record<string, unknown> = { P: e.P, season: j.season, slot: j.slot, avoided: j.avoided, reason: j.reason, aligned: j.aligned, in1d: e.in1d, tp1d: e.tp1d, ruleOrdered: c.acc?.ruleOrdered[i], weekStart: weekOf(e.T) * WEEK + WEEK_OFFSET };
    for (const k of ["P", "season", "slot", "avoided", "reason", "aligned", "in1d", "tp1d", "ruleOrdered", "weekStart"]) {
      const want = k === "P" || k === "weekStart" ? (k in w ? Date.parse(w[k] as string) : undefined) : w[k];
      if (k in w && want !== got[k]) fails.push(`${run.name} ${h.id} ${k}: want ${JSON.stringify(w[k])}, got ${k === "P" || k === "weekStart" ? iso(got[k] as number) : JSON.stringify(got[k])}`);
    }
    if ("midMinusExit" in w && !(Math.abs(e.vMid - e.vExit - (w.midMinusExit as number)) < 1e-9)) fails.push(`${run.name} ${h.id} midMinusExit: want ${w.midMinusExit}, got ${e.vMid - e.vExit}`);
    if ("keptMates" in w) {
      const mates = (w.keptMates as string[]).map((id) => c.es[at.get(id)!].vMid);
      const want = e.vMid - mates.reduce((s2, v) => s2 + v, 0) / mates.length;
      if (!(j.x !== null && Math.abs(j.x - want) < 1e-9)) fails.push(`${run.name} ${h.id} x: want ${want}, got ${j.x}`);
    }
  });
  return fails;
};


// ---- 2023-11/12 (5): one run's numbers, from the bars of a data set (real, or a walk written out) ----------

const y23Of = (ds: DataSet, slots: SlotsFile, rg: Range, plant = "") => {
  const ctx: Ctx = { start: rg.start, end: rg.end, split: rg.end, startYen: START_YEN, cap: CAP };
  const a = analyse(ds, ctx, "all");
  const ms: Mails = { sigs: ds.sigs, P0: ds.sigs.map((s) => pOf(s, DELAY)) };
  const c = costOf(ds.m1s, ms, slots, rg.start, rg.end, plant);
  const spreads = spreadsOf(ds.m1s, slots.avoid, slots.thr2, rg.start, rg.end);
  const checks: Analysis["checks"] = {};
  for (const k of Y23_CHECKS) checks[k] = a.checks[k] ?? { ok: false, detail: "not run", why: `${k} was not run` };
  Object.assign(checks, readChecksOf(ds, rg, { m1: Y23_KEYS_M1, m15: Y23_KEYS_M15 }), c.checks);
  // the rule's row without the rule is §8.102's main row, run again
  checks.ruleNoneIsMain = { ok: JSON.stringify(c.acc!.none) === JSON.stringify(a.raw!.outs.main), detail: null };
  return { a, c, spreads, checks, ms, ctx };
};

// 5「数字の後の調べ」 from the TS's own numbers (the Python's are added by the print)
const afterOf = (r: ReturnType<typeof y23Of>): string[] => {
  const s = r.c.s;
  const sumNot = REASONS.filter((x) => x !== "noKept").reduce((a2, x) => a2 + s.notCounted[x], 0);
  const lines = [
    `件数: すべて ${s.emails} ＝ 数えた ${s.counted} ＋ 数えなかった ${sumNot}（${REASONS.filter((x) => x !== "noKept").map((x) => `${x} ${s.notCounted[x]}`).join("・")}）: ${s.emails === s.counted + sumNot ? "合う" : "合わない"}`,
    `数えた ${s.counted} ＝ 避けた ${s.countedAvoided} ＋ 残した ${s.kept}: ${s.counted === s.countedAvoided + s.kept ? "合う" : "合わない"}`,
    `数えた避けた ${s.countedAvoided} ＝ そろえた ${s.aligned} ＋ 同じますに残したメールが無い ${s.notCounted.noKept}: ${s.countedAvoided === s.aligned + s.notCounted.noKept ? "合う" : "合わない"}`,
    `先読みの確かめ: lookAheadPaths ${JSON.stringify({ compared: (r.checks.lookAheadPaths?.detail as { compared?: number })?.compared, moved: r.checks.lookAheadPaths?.n })}・中値の v ${JSON.stringify({ compared: (r.c.checks.lookAheadMid.detail as { compared: number }).compared, moved: r.c.checks.lookAheadMid.n })}・lookAheadAccount ${r.checks.lookAheadAccount?.n}・ルールの行 ${r.c.checks.lookAheadAccountRule?.n}・signalCut ${r.checks.signalCut?.n}`,
    `1日以内の勝率の分母と分子: 避けた ${s.win1d.avoided.tp}/${s.win1d.avoided.of}（まだ持っている ${s.win1d.avoided.held}、入らなかった ${s.win1d.avoided.notIn}）・残した ${s.win1d.kept.tp}/${s.win1d.kept.of}（${s.win1d.kept.held}・${s.win1d.kept.notIn}）`,
  ];
  const flags: string[] = [];
  if (s.win1d.avoided.rate === 1 || s.win1d.kept.rate === 1) flags.push("1日以内の勝率のどれかが100%");
  if (s.delta.m !== null && Math.abs(s.delta.m) > 10) flags.push("|Δ| が10 pips を超えた");
  if (s.delta.lo !== null && s.delta.hi !== null && (s.delta.hi < 0 || s.delta.lo > 0)) flags.push("区間が0をまたがない");
  lines.push(flags.length ? `当たったもの（調べる項目は同じ）: ${flags.join("・")}` : "100%・|Δ|>10・0をまたがない区間: どれも無し");
  return lines;
};

const y23Files = async (dir: string, r: ReturnType<typeof y23Of>, plant = "") => {
  await writeJson(`${dir}/checks.json`, r.checks);
  await writeJson(`${dir}/analysis.json`, { ...r.a, dump: undefined, decisions: undefined, raw: undefined, cost: r.c.s, spreads: r.spreads, accounts: r.c.acc!.lines });
  await writeDump(`${dir}/dump`, r.a, r.ctx);
  await writeCost(`${dir}/dump`, { ...costDumpOf(r.c.es, r.c.js, r.c.s, r.c.acc, r.spreads), "cost-meta.json": JSON.stringify({ start: r.ctx.start, end: r.ctx.end, delay: DELAY }) });
  await Deno.writeTextFile(`${dir}/ultra15-2023.csv`, csv2023Of(r.c.es, r.c.js));
  const items = printItemsOf({ where: "2023年11〜12月", kind: "2023", s: r.c.s, spreads: r.spreads, acc: r.c.acc!, after: afterOf(r), checks: Object.fromEntries(Object.entries(r.checks).map(([k, c]) => [k, c.ok])), sha256: {}, weeks: 8 }, plant);
  await writeJson(`${dir}/items.json`, items);
};

// the Python's facts and the sha256s, then the print (only the listed items; a planted item stops it)
const y23Print = async (dir: string): Promise<string> => {
  const items = JSON.parse(await Deno.readTextFile(`${dir}/items.json`)) as Item[];
  const py = JSON.parse(await Deno.readTextFile(env("PYCHECK", `${dir}/pycheck.json`))) as { ok: boolean; cost?: { avoidedCompared: number; avoidedDiffer: number } };
  const shaOfDir = async (d: string) => {
    const names: string[] = [];
    for await (const e of Deno.readDir(d)) if (e.isFile) names.push(e.name);
    names.sort();
    const parts: string[] = [];
    for (const n of names) parts.push(`${n} ${await sha256Hex(await Deno.readTextFile(`${d}/${n}`))}`);
    return sha256Hex(parts.join("\n"));
  };
  const sha = { "analysis.json": await sha256Hex(await Deno.readTextFile(`${dir}/analysis.json`)), dump: await shaOfDir(`${dir}/dump`), "pycheck.json": await sha256Hex(await Deno.readTextFile(env("PYCHECK", `${dir}/pycheck.json`))) };
  for (const x of items) {
    if (x.item === "sha256") x.text = Object.entries(sha).map(([k, h]) => `${k} ${h}`).join("\n");
    if (x.item === "after") {
      x.text += `\n避けたかの判定（Python が P だけから作り直した判定）: ${py.cost?.avoidedCompared ?? "-"} 件を比べ、食い違い ${py.cost?.avoidedDiffer ?? "-"} 件`;
      x.text += `\n手の例（7 の (3)）: 同じ run の作り物の job（同じ commit）で ${env("HAND_JOB", "-")}`;
    }
  }
  return printTextOf(items);
};

const stops = async (f: () => Promise<unknown>): Promise<boolean> => {
  try {
    await f();
    return false;
  } catch (e) {
    if (e instanceof RuleFileError || e instanceof PrintItemsError) return true;
    throw e;
  }
};



// 7 (4), (5): the walks on 2023's calendar (12/25 shut), seeds 1-100 on three sets; the planted errors and the
// files for the Python on the FULL seeds; the stops of 7 (0) and (9) that read no price
const T_999_99 = 3.39; // t(99), two-sided 99.9% (§8.103 7 (4))

// ---- (b)'s weekly ② (6): the counts every week, the one comparison -----------------------------------------

// The emails sent from R before END_b: ② on them (P, v, the cells as 2023's); which run this is; its output
const bCostOf = (m1s: M1[], all: Sig[], endB: number, slots: SlotsFile, plant = "") => {
  const sigs = all.filter((s) => s.sent! >= R_MS);
  const before = all.length - sigs.length;
  const P0 = sigs.map((s) => pOf(s, B_DELAY));
  const ms: Mails = { sigs, P0, sent: sigs.map((s) => s.sent!) };
  const taus = Float64Array.from(nyClosesBetween((P0.length ? Math.min(...P0) : endB) - DAY_MS, endB).map((c) => c.tau));
  const moved = (P: number) => {
    const tau = maintOf(taus, P);
    return tau === null ? P : tau + MAINT;
  };
  // the accounts' start: the first P moved past the stop (S_b's way)
  const sR = P0.length ? Math.min(...P0.map(moved)) : endB;
  const c = costOf(m1s, ms, slots, sR, endB, plant, false);
  // the aligned avoided emails as a run with END_b = e would count them: the emails sent before e, END e
  const alignedAt = (e: number): number => {
    if (e === endB) return c.s.aligned;
    const es2 = c.es.filter((x) => x.sent! < e);
    return judge(es2, slots.avoid, { end: e, plant }).filter((j) => j.aligned).length;
  };
  const status = bStatusOf(endB, alignedAt, plant);
  const items = weeklyItemsOf(c.s, status.kind, status.compareEnd, plant);
  let print: Item[] | null = null;
  let acc: RuleAccounts | null = null;
  let spreads: ReturnType<typeof spreadsOf> | null = null;
  if (status.kind === "compare") {
    acc = ruleAccounts(m1s, ms, c.paths, c.js, sR, endB, plant);
    c.checks.lookAheadAccountRule = { ok: acc.cut.ok, detail: acc.cut, n: acc.cut.poisoned + acc.cut.changed };
    spreads = spreadsOf(m1s, slots.avoid, slots.thr2, R_MS, endB);
    print = printItemsOf({ where: `これからのメール（R〜END_b ＝ ${iso(R_MS).slice(0, 10)}〜${iso(endB).slice(0, 10)}）`, kind: "b", s: c.s, spreads, acc, after: [], checks: Object.fromEntries(Object.entries(c.checks).map(([k, x]) => [k, x.ok])), sha256: {}, weeks: Math.round((endB - R_MS) / WEEK) }, plant);
  }
  return { c, ms, acc, spreads, status, items, print, before, sR };
};

// The weekly run's ② (MODE=b): only with the rule's file whose sha256 the program holds (`want`; the weekly run
// passes SPREAD_HOURS_SHA256 and nothing else), written apart from (b)'s own files (b/costhours.json)
const bCostWeekly = async (dir: string, m1s: M1[], sigs: Sig[], endB: number, text: string | null, want: string, plant = "") => {
  if (!want) {
    log("② (§8.103 6): the sha256 of spread-hours.csv is not written in the program yet: no ② row this week");
    return null;
  }
  let slots: SlotsFile;
  try {
    if (text === null) throw new RuleFileError(`${SPREAD_HOURS_PATH}: not there`);
    slots = await ruleFileOf(text, PAIRS, want);
  } catch (e) {
    if (!(e instanceof RuleFileError)) throw e;
    log(`② (§8.103 6): stopped: ${e.message}`);
    await writeJson(`${dir}/costhours.json`, { ok: false, why: e.message });
    return null;
  }
  const x = bCostOf(m1s, sigs, endB, slots, plant);
  log(`② : ledger rows sent before R ${x.before} (counted only, not used)`);
  const ok = Object.values(x.c.checks).every((c) => c.ok);
  for (const [k, c] of Object.entries(x.c.checks)) log(`② check ${k}: ${c.ok ? "ok" : "FAILED"}`);
  await writeJson(`${dir}/costhours.json`, { ok, endB: iso(endB), status: x.status, items: x.items, print: x.print, checks: x.c.checks });
  await writeCost(`${dir}/dump`, { ...costDumpOf(x.c.es, x.c.js, x.c.s, x.acc, x.spreads), "cost-status.json": JSON.stringify({ endB, status: x.status, before: x.before, sR: x.sR }) });
  return x;
};

// ---- (b): the emails sent (§8.102 (b) and 「(b) のプログラムの細部」) ------------------------------------

// END_b: the Saturday 00:00 UTC before the run; the ledger and (a)'s per-email values (read, never recomputed)
const END_B_MS = Date.parse(env("END_B", ""));
const LEDGER = env("LEDGER", "research/ledger/ultra15.csv");
const A_CSV = env("A_CSV", "research/ledger/ultra15-a.csv");
const OUT_B = `${OUT}/b`;
// the checks a weekly run does not fail on: the recomputed signals' own (they serve the comparison with the emails only)
const B_SOFT = new Set(["signalProbe", "signalCut"]);
const sha256Of = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const readACsv = async (): Promise<ARow[]> => {
  const text = await Deno.readTextFile(A_CSV);
  const hash = await sha256Of(text);
  if (hash !== A_SHA256) throw new Error(`${A_CSV}: sha256 ${hash}, not the committed ${A_SHA256}`);
  return parseACsv(text);
};
const isSaturdayMidnight = (ms: number) => Number.isFinite(ms) && ms % DAY_MS === 0 && new Date(ms).getUTCDay() === 6;

// One (b) run on a set of day files: the rows sent before END_b as the signals, the 1-minute bars from a day
// before S_b, the 15-minute bars for the recomputed signals; the accounts and the per-email view as (a)'s,
// and beside them the recomputed signals, the times to the send and the one comparison
async function runB(name: string, src: Source, rows: LedgerRow[], endB: number, rates: Rates, aRows: ARow[], plant = "") {
  const sigs = ledgerSigs(rows, endB, plant);
  if (!sigs.length) throw new Error(`(b) ${name}: no email sent before ${iso(endB)}`);
  // S_b: the first P, moved past Rakuten's stop as the paths move it
  const stopTaus = Float64Array.from(nyClosesBetween(sigs[0].base - DAY_MS, endB).map((c) => c.tau));
  const moved = (P: number) => {
    const tau = maintOf(stopTaus, P);
    return tau === null ? P : tau + MAINT;
  };
  const sB = Math.min(...sigs.map((s) => moved(pOf(s, B_DELAY))));
  const load = newLoadStats();
  const m1s: M1[] = [];
  const reads: SignalRead[] = [];
  const m15Gaps: NonNullable<DataSet["m15Gaps"]> = [];
  // the recomputed signals: bars closed from half an hour before the ledger's first send (a late one's base is T + 15)
  const from15 = LEDGER_FROM - 30 * MINUTE;
  for (const [pi, pair] of PAIRS.entries()) {
    const m1 = await loadM1(src, pair, sB - DAY_MS, endB, load);
    const q15 = await load15(src, pair, from15 - LEAD15, endB, load);
    m1s.push(m1);
    m15Gaps.push(m15GapsOf(m1, q15, sB, endB));
    reads.push(signalsOf(pair, pi, q15, from15, endB, true));
  }
  const ds: DataSet = { name, m1s, sigs, reads, load, src, rates, m15Gaps };
  // (b) has no halves: the split at END_b
  const ctx: Ctx = { start: sB, end: endB, split: endB, startYen: START_YEN, cap: CAP };
  const a = analyse(ds, ctx, "all", plant, "b");
  // checks: P is sentAt + 1 minute rounded up to the minute, the supplement's sentAt + 5 minutes rounded up
  // (§8.102 (b), written as the docs say it; the paths take pOf, made from base)
  const pBad = sigs.filter((s) => pOf(s, B_DELAY) !== Math.ceil((s.sent! + MINUTE) / MINUTE) * MINUTE || pOf(s, 5) !== Math.ceil((s.sent! + 5 * MINUTE) / MINUTE) * MINUTE);
  a.checks.bP = { ok: pBad.length === 0, detail: { compared: sigs.length, bad: pBad.slice(0, 5).map((s) => `${s.pair} ${s.side} ${iso(s.open)} sent ${iso(s.sent!)}`) }, n: pBad.length };
  // each email's value a day after P, made as (a)'s ultra15-a.csv (the main path on GMO's bars, touch)
  const taus = Float64Array.from(nyClosesBetween(sB - DAY_MS, endB).map((c) => c.tau));
  const books = m1s.map((m) => makeBook(m, taus, true));
  const vals: BValue[] = [];
  for (const s of sigs) {
    const p = follow(books[s.pi], { dir: s.dir, E: s.E, tp: s.tp, P: pOf(s, B_DELAY) }, { fill: "touch", endMs: endB });
    if (p.none || p.P + DAY_MS > endB) continue;
    vals.push({ P: p.P, v: valueAt(books[s.pi], p, s.dir, p.P + DAY_MS).v });
  }
  const b = { sB: iso(sB), endB: iso(endB), ledgerRows: rows.length, sentBefore: sigs.length, recompute: compareRecompute(rows, reads.flatMap((r) => r.signals), endB), delays: delaysOf(rows, endB), window: windowOf(vals, sB, endB, aRows, plant) };
  // for the Python: the comparison and the times to the send, each made again there from the ledger and its own paths
  a.dump["window.json"] = JSON.stringify(b.window);
  a.dump["delays.json"] = JSON.stringify(b.delays);
  return { a, ctx, b, ds };
}

// a (b) run's files: the checks, the numbers (not printed here), the Python's inputs
const writeB = async (dir: string, r: Awaited<ReturnType<typeof runB>>, endB: number) => {
  await writeJson(`${dir}/checks.json`, r.a.checks);
  await writeJson(`${dir}/analysis.json`, { ...r.a, dump: undefined, decisions: undefined, raw: undefined, b: r.b });
  await writeDump(`${dir}/dump`, r.a, r.ctx, { delay: B_DELAY, mode: "b", endB });
  await Deno.writeTextFile(`${dir}/decisions.txt`, r.a.decisions.join("\n"));
};
// whether each check passed (no measured number), and whether the run fails (the soft ones never fail it)
const judgeB = (checks: Analysis["checks"]): boolean => {
  let ok = true;
  for (const [k, c] of Object.entries(checks)) {
    log(`check ${k}: ${c.ok ? "ok" : "FAILED"}${B_SOFT.has(k) ? " (not failing the run)" : ""}`);
    if (!c.ok && c.why) log(`  ${c.why}`);
    if (!c.ok && !B_SOFT.has(k)) ok = false;
  }
  return ok;
};
const recomputeLines = (rc: ReturnType<typeof compareRecompute>) => [
  `emails ${rc.emails}, recomputed ${rc.recomputed}, matched ${rc.matched}; only emails ${rc.emailOnly.length}, only recomputed ${rc.recomputeOnly.length}, entry differs ${rc.eDiff.length}, late differs ${rc.lateDiff.length}`,
  ...rc.emailOnly.map((x) => `  only an email: ${x}`),
  ...rc.recomputeOnly.map((x) => `  only recomputed: ${x}`),
  ...rc.eDiff.map((x) => `  entry differs: ${x}`),
  ...rc.lateDiff.map((x) => `  late differs: ${x}`),
];

if (MODE === "b") {
  if (!isSaturdayMidnight(END_B_MS)) throw new Error(`END_B ${env("END_B")}: not a Saturday 00:00 UTC`);
  const t0 = Date.now();
  const rows = parseLedger(await Deno.readTextFile(LEDGER));
  const r = await runB("b", { dir: CACHE, fetch: true }, rows, END_B_MS, await bisRates(env("BIS_CSV")), await readACsv());
  log(`ledger ${LEDGER}: ${rows.length} rows, ${r.b.sentBefore} sent before END_b ${r.b.endB}; S_b ${r.b.sB}`);
  log(`loaded: ${JSON.stringify(r.a.checks.loads.detail)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  for (const g of (r.a.extra.m15Gaps as DataSet["m15Gaps"]) ?? []) log(`${g.pair}: 15-minute slots without a bar beside 1-minute bars ${g.slots}${g.examples.length ? " (" + g.examples.slice(0, 5).join(", ") + ")" : ""}`);
  // the emails against the recomputed signals: listed in every run (the emails' own rows, no measured number)
  for (const l of recomputeLines(r.b.recompute)) log(l);
  await writeB(OUT_B, r, END_B_MS);
  // §8.103 6: ②'s weekly row, apart from (b)'s files, only with the rule's file the program's sha256 names
  await bCostWeekly(OUT_B, r.ds.m1s, r.ds.sigs, END_B_MS, await Deno.readTextFile(SPREAD_HOURS_PATH).catch(() => null), SPREAD_HOURS_SHA256);
  const ok = judgeB(r.a.checks);
  log(`TypeScript checks of (b): ${ok ? "all passed" : "FAILED"}. The numbers are in ${OUT_B}, printed only by MODE=printb after the Python check.`);
  if (!ok) Deno.exit(1);
}

if (MODE === "printb") {
  const checks = JSON.parse(await Deno.readTextFile(`${OUT_B}/checks.json`)) as Analysis["checks"];
  const py = JSON.parse(await Deno.readTextFile(env("PYCHECK", `${OUT_B}/pycheck.json`))) as { ok: boolean };
  if (!Object.entries(checks).every(([k, c]) => c.ok || B_SOFT.has(k)) || !py.ok) {
    log("a check failed: the numbers of (b) are not printed (§8.102 確かめ B (5), (b) の毎週の run)");
    Deno.exit(1);
  }
  log(await Deno.readTextFile(`${OUT_B}/analysis.json`));
  // §8.103 6: ②'s row — the five items (or that the comparison was done), and the comparing run's sentences —
  // only when its own checks and the Python's ② part passed, and only the items listed
  const cost = await Deno.readTextFile(`${OUT_B}/costhours.json`).then((t) => JSON.parse(t) as { ok: boolean; why?: string; items: Item[]; print: Item[] | null }).catch(() => null);
  const pyCost = (py as { cost?: { ok: boolean } }).cost;
  if (!cost) log("== ② (§8.103 6): no row this week (the sha256 of spread-hours.csv is not written in the program yet)");
  else if (!cost.ok || !pyCost?.ok) log(`== ② (§8.103 6): not printed (${cost.why ?? "a check of ② failed, the TS's or the Python's"})`);
  else {
    checkItems(cost.items, (cost.items.length === 1 ? DONE_ITEMS : WEEKLY_ITEMS) as unknown as string[]);
    log(`== ② (§8.103 6)\n${cost.items.map((x) => `${x.item}: ${x.text}`).join("\n")}`);
    if (cost.print) log(printTextOf(cost.print));
  }
}

// 確かめ for (b) on a walk: the walk's own signals as the emails (sent a few seconds to a minute after their
// send time, one exactly on a minute), with the differences an email record can have planted (one dropped,
// one that no bar made, one entry changed, one sent late); run on each END_b of ENDS_B, the planted (b)
// errors (PLANTS) beside it for the Python
if (MODE === "bsyn") {
  const seed = Number(env("SEED", "1"));
  const endBs = env("ENDS_B", "2026-10-10T00:00:00Z,2026-10-17T00:00:00Z,2026-10-24T00:00:00Z").split(",").map((x: string) => Date.parse(x));
  if (!endBs.every(isSaturdayMidnight)) throw new Error(`ENDS_B ${env("ENDS_B")}: not every one a Saturday 00:00 UTC`);
  const plants = env("PLANTS", "").split(",").filter(Boolean);
  const last = Math.max(...endBs);
  const dir = `${OUT}/bsyn-${seed}`;
  const from = LEDGER_FROM - 30 * MINUTE - LEAD15 - 2 * DAY_MS;
  for (const [pi, pair] of PAIRS.entries()) {
    const w = synthesize(pair, pi, { seed, trend: 0, startPips: null }, from, last);
    await writeGmoFiles(`${dir}/gmo`, pair, w, from, last);
  }
  const src: Source = { dir: `${dir}/gmo`, fetch: false };
  const recs: Sig[] = [];
  for (const [pi, pair] of PAIRS.entries()) {
    const q15 = await load15(src, pair, LEDGER_FROM - 30 * MINUTE - LEAD15, last, newLoadStats());
    recs.push(...signalsOf(pair, pi, q15, LEDGER_FROM - 30 * MINUTE, last).signals);
  }
  const pool = recs.filter((s) => s.base >= LEDGER_FROM && s.base < last).sort((x, y) => x.base - y.base || x.pi - y.pi || y.dir - x.dir);
  if (pool.length < 40) throw new Error(`bsyn: ${pool.length} signals on the walk, too few`);
  const OFFS = [3_824, 0, 59_999, 60_000, 1, 4_500, 30_000];
  let rows: LedgerRow[] = pool.map((s, k) => ({ pair: s.pair, side: s.side, open: s.open, T: s.T, E: s.E, sent: s.base + OFFS[k % OFFS.length] }));
  const planted = { dropped: rows[5], changed: rows[7], fake: rows[9], late: rows[11] };
  // the dropped email's signal: in the recomputed ones from its send time (base) on
  const droppedBase = pool[5].base;
  rows = rows.filter((x) => x !== planted.dropped);
  const ix = (x: LedgerRow) => rows.indexOf(x);
  rows[ix(planted.changed)] = { ...planted.changed, E: Number((planted.changed.E + unitOf(planted.changed.pair)).toFixed(planted.changed.pair.includes("JPY") ? 3 : 5)) };
  rows[ix(planted.late)] = { ...planted.late, sent: planted.late.T + 15 * MINUTE + 2_000 };
  rows.push({ ...planted.fake, side: planted.fake.side === "BUY" ? "SELL" : "BUY", sent: planted.fake.sent + 1 });
  rows.sort((x, y) => x.sent - y.sent);
  const text = [LEDGER_HEADER, ...rows.map((x) => `${x.pair},${x.side},${iso(x.open)},${iso(x.T)},${x.E},${iso(x.sent)}`)].join("\n") + "\n";
  await Deno.writeTextFile(`${dir}/ultra15.csv`, text);
  const back = parseLedger(text);
  const aRows = await readACsv();
  let pass = true;
  for (const endB of endBs) {
    const out = `${dir}/end-${iso(endB).slice(0, 10)}`;
    const r = await runB(`bsyn ${seed} ${iso(endB)}`, src, back, endB, synRates, aRows);
    await writeB(out, r, endB);
    const rc = r.b.recompute;
    // the planted differences, as many as were sent before this END_b
    const want = { emailOnly: Number(planted.fake.sent + 1 < endB), recomputeOnly: Number(droppedBase < endB), eDiff: Number(planted.changed.sent < endB), lateDiff: Number(planted.late.T + 15 * MINUTE + 2_000 < endB) };
    const got = { emailOnly: rc.emailOnly.length, recomputeOnly: rc.recomputeOnly.length, eDiff: rc.eDiff.length, lateDiff: rc.lateDiff.length };
    const same = JSON.stringify(want) === JSON.stringify(got);
    const ok = judgeB(r.a.checks) && same;
    log(`${iso(endB)}: emails ${r.b.sentBefore}, S_b ${r.b.sB}; recompute ${JSON.stringify(got)} (planted ${JSON.stringify(want)}) ${same ? "ok" : "NOT AS PLANTED"}; delays ${JSON.stringify(r.b.delays)}; window n ${r.b.window.n} (a week before ${r.b.window.nPrev}) ${r.b.window.due ? `compared: b ${r.b.window.b!.value.toFixed(3)} (n ${r.b.window.b!.n}), a 5-95% ${r.b.window.a!.q05.toFixed(3)}..${r.b.window.a!.q95.toFixed(3)} of ${r.b.window.a!.values} (empty ${r.b.window.a!.empty}), ${r.b.window.verdict}` : "not compared"}; ${ok ? "ok" : "FAILED"}`);
    if (!ok) pass = false;
    for (const plant of plants) {
      const q = await runB(`bsyn ${seed} ${iso(endB)} ${plant}`, src, back, endB, synRates, aRows, plant);
      await writeB(`${out}/plant-${plant}`, q, endB);
    }
  }
  // the hard start: the first two emails sent at 20:53 UTC on 2026-10-05 (US summer), so both P (20:55) fall in
  // Rakuten's stop and move to 21:10 = S_b, in one minute: EUR/JPY sold and EUR/USD bought at the market (E 5 pips
  // past 21:10's open). The account must price that first minute from the bars before S_b (USD/JPY for the dollar
  // pair's margin, EUR/JPY's own position), and the rows judged in the stop must take both at 20:55
  {
    const endB = endBs[0];
    const at = Date.parse("2026-10-05T21:10:00Z");
    const openAt = async (pair: string) => {
      const m = await loadM1(src, pair, at - DAY_MS, at + DAY_MS, newLoadStats());
      const k = lowerBound(m.t, at);
      if (!(k < m.n && m.t[k] === at)) throw new Error(`bsyn edge: no ${pair} bar at ${iso(at)}`);
      return { bo: m.bo[k], ao: m.ao[k] };
    };
    const ej = await openAt("EUR/JPY");
    const eu = await openAt("EUR/USD");
    const open = Date.parse("2026-10-05T20:30:00Z");
    const first: LedgerRow[] = [
      { pair: "EUR/JPY", side: "SELL", open, T: open + 15 * MINUTE, E: Number((ej.bo - 0.05).toFixed(3)), sent: Date.parse("2026-10-05T20:53:30.000Z") },
      { pair: "EUR/USD", side: "BUY", open, T: open + 15 * MINUTE, E: Number((eu.ao + 0.0005).toFixed(5)), sent: Date.parse("2026-10-05T20:53:40.000Z") },
    ];
    const edgeRows = [...first, ...back.filter((x) => x.sent >= Date.parse("2026-10-05T21:12:00Z"))];
    const edgeText = [LEDGER_HEADER, ...edgeRows.map((x) => `${x.pair},${x.side},${iso(x.open)},${iso(x.T)},${x.E},${iso(x.sent)}`)].join("\n") + "\n";
    const out = `${dir}/edge-${iso(endB).slice(0, 10)}`;
    await Deno.mkdir(out, { recursive: true });
    await Deno.writeTextFile(`${out}/ultra15.csv`, edgeText);
    const r = await runB(`bsyn ${seed} edge`, src, parseLedger(edgeText), endB, synRates, aRows);
    await writeB(out, r, endB);
    const sOk = r.b.sB === iso(at);
    const ok = judgeB(r.a.checks) && sOk;
    log(`the hard start: S_b ${r.b.sB} (${sOk ? "21:10 as built" : "NOT 21:10"}), emails ${r.b.sentBefore}; ${ok ? "ok" : "FAILED"}`);
    if (!ok) pass = false;
  }
  log(`(b) on the walk: ${pass ? "PASSED" : "FAILED"}`);
  if (!pass) Deno.exit(1);
}

// ---- §8.103 ② stage 2: the runs ---------------------------------------------------------------------

if (MODE === "costhand") {
  const hand = JSON.parse(await Deno.readTextFile(HAND_PATH)) as Hand;
  const plants = env("PLANTS", "").split(",").filter(Boolean);
  const slots = await provisional("1h");
  const from = Date.parse(hand.walk.from);
  const to = Date.parse(hand.walk.to);
  const wide = hand.walk.wide.map((x) => ({ pi: PAIRS.indexOf(x.pair as (typeof PAIRS)[number]), from: Date.parse(x.from), to: Date.parse(x.to), pips: x.pips }));
  const dir = `${COST_OUT}/hand`;
  const src: Source = { dir: `${dir}/gmo`, fetch: false };
  for (const [pi, pair] of PAIRS.entries()) {
    const extra = (p: number, t: number) => wide.reduce((s2, x) => s2 + (x.pi === p && t >= x.from && t < x.to ? x.pips : 0), 0);
    const w = synthesize(pair, pi, { seed: hand.walk.seed, trend: 0, startPips: null, closedKeys: hand.walk.closedKeys, extraSpread: extra }, from, to);
    await writeGmoFiles(src.dir, pair, w, from, to);
  }
  let pass = true;
  const byPlant: Record<string, { workedOut: number; checks: Record<string, number> }> = {};
  for (const run of hand.runs) {
    const start = Date.parse(run.start);
    const end = Date.parse(run.end);
    const m1s: M1[] = [];
    for (const pair of PAIRS) m1s.push(await loadM1(src, pair, start - DAY_MS, end, newLoadStats()));
    const ms = handMails(run, m1s, booksOf(m1s, start, end));
    const c = costOf(m1s, ms, slots, start, end);
    const fails = handFails(run, c);
    const bad = Object.entries(c.checks).filter(([, x]) => !x.ok).map(([k]) => k);
    log(`hand run ${run.name}: ${fails.length ? "NOT AS WORKED OUT: " + fails.join("; ") : "as worked out"} (${run.emails.length} emails); checks ${bad.length ? "FAILED " + bad.join(",") : "ok"}`);
    if (fails.length || bad.length) pass = false;
    const out = `${dir}/run-${run.name}`;
    await writeCost(out, { ...costDumpOf(c.es, c.js, c.s, c.acc, null), "signals.csv": ms.sigs.map((s2, i) => `${run.emails[i].id},${s2.pair},${s2.side},${s2.T},${ms.P0[i]},${s2.E},${s2.tp}`).join("\n"), "meta.json": JSON.stringify({ start, end, slots: "1h" }) });
    // 7 (3): 5 pips taken from every avoided email's v (the main value, at the mid)
    if (run.name === "A") {
      const k = hand.shift.pips;
      const es2 = c.es.map((e, i) => (c.js[i].avoided ? { ...e, vMid: e.vMid - k } : e));
      const s2 = summaryOf(es2, judge(es2, slots.avoid, { end }), slots.bars);
      const near = (x: number | null, y: number | null) => x !== null && y !== null && Math.abs(x - y) < 1e-9;
      const ok = near(s2.delta.m, c.s.delta.m! - k) && near(s2.means.avoided.mean, c.s.means.avoided.mean! - k) && near(s2.means.kept.mean, c.s.means.kept.mean);
      log(`hand shift ${k} pips: Δ ${c.s.delta.m?.toFixed(6)} → ${s2.delta.m?.toFixed(6)}, avoided mean ${c.s.means.avoided.mean?.toFixed(6)} → ${s2.means.avoided.mean?.toFixed(6)}, kept mean the same ${near(s2.means.kept.mean, c.s.means.kept.mean) ? "yes" : "NO"}: ${ok ? "as worked out" : "NOT AS WORKED OUT"}`);
      if (!ok) pass = false;
    }
    for (const plant of plants) {
      const q = costOf(m1s, ms, slots, start, end, plant);
      let pf = handFails(run, q).length;
      if (run.name === "A") {
        const es2 = q.es.map((e, i) => (q.js[i].avoided ? { ...e, vMid: e.vMid - hand.shift.pips } : e));
        const s2 = summaryOf(es2, judge(es2, slots.avoid, { end, plant }), slots.bars, plant);
        if (!(s2.delta.m !== null && q.s.delta.m !== null && Math.abs(s2.delta.m - (q.s.delta.m - hand.shift.pips)) < 1e-9)) pf++;
      }
      const e2 = (byPlant[plant] ??= { workedOut: 0, checks: {} });
      e2.workedOut += pf;
      for (const [k, x] of Object.entries(q.checks)) if (!x.ok) e2.checks[k] = (e2.checks[k] ?? 0) + (x.n ?? 1);
      await writeCost(`${out}/plant-${plant}`, costDumpOf(q.es, q.js, q.s, q.acc, null));
    }
  }
  for (const [plant, e2] of Object.entries(byPlant)) log(`planted ${plant}: worked-out answers failing ${e2.workedOut}; own checks failing: ${Object.entries(e2.checks).map(([k, v]) => `${k} ${v}`).join(",") || "none"}`);
  await writeJson(`${dir}/plants-hand.json`, byPlant);
  log(`hand examples of ②: ${pass ? "all as worked out" : "NOT ALL AS WORKED OUT"}`);
  if (!pass) Deno.exit(1);
}

if (MODE === "y2023") {
  // 7 (0): the rule's file against the sha256 written in the program, before anything is read from GMO
  let slots: SlotsFile;
  try {
    // the constant first (an empty one stops here, the file not even read), then the file against it
    const want = PLANT_ENV === "emptyConst" ? "" : SPREAD_HOURS_SHA256;
    if (!want) throw new RuleFileError("the sha256 of spread-hours.csv is not written in the program yet (stage 1 not committed)");
    const text = await Deno.readTextFile(SPREAD_HOURS_PATH).catch(() => {
      throw new RuleFileError(`${SPREAD_HOURS_PATH}: not there`);
    });
    slots = await ruleFileOf(text, PAIRS, want);
  } catch (e) {
    if (!(e instanceof RuleFileError)) throw e;
    log(`2023: stopped before GMO is read: ${e.message}`);
    Deno.exit(3);
  }
  const t0 = Date.now();
  const ds = await dataSetOf("2023", { dir: CACHE, fetch: true }, null, Y23_RANGE);
  log(`loaded (${((Date.now() - t0) / 1000).toFixed(0)} s); signals ${ds.sigs.length}`);
  const r = y23Of(ds, slots!, Y23_RANGE);
  await y23Files(`${COST_OUT}/y2023`, r);
  const ok = judgedChecks(r.checks);
  log(`2023 TypeScript checks: ${ok ? "all passed" : "FAILED"}. The numbers are in ${COST_OUT}/y2023, printed only by MODE=y2023print after the Python check.`);
  if (!ok) Deno.exit(1);
}

if (MODE === "y2023print") {
  const dir = `${COST_OUT}/y2023`;
  const checks = JSON.parse(await Deno.readTextFile(`${dir}/checks.json`)) as Analysis["checks"];
  const py = JSON.parse(await Deno.readTextFile(env("PYCHECK", `${dir}/pycheck.json`))) as { ok: boolean };
  if (!Object.values(checks).every((c) => c.ok) || !py.ok) {
    log("a check failed: the numbers of 2023 are not printed (§8.103 5)");
    Deno.exit(1);
  }
  const text = await y23Print(dir);
  await Deno.writeTextFile(`${dir}/print.txt`, text);
  log(text);
  const csv = await Deno.readTextFile(`${dir}/ultra15-2023.csv`);
  log(`== ultra15-2023.csv sha256 ${await sha256Hex(csv)}, ${csv.split("\n").length - 2} rows`);
  log(csv);
}

if (MODE === "costsyn") {
  const sets = env("SETS", "none,t01,t03").split(",");
  const seeds = range(env("SEEDS", "1-100"));
  const full = new Set(range(env("FULL", "1")));
  const plants = env("PLANTS", "").split(",").filter(Boolean);
  const slots = await provisional("1h");
  const rg: Range = { ...Y23_RANGE, closedKeys: ["20231225"] };
  let pass = true;
  const result: Record<string, unknown> = { sets, seeds: seeds.length, full: [...full], intervalP: INTERVAL_P };
  // 7 (0), (9): the rule's file stops where it must, and passes where it must
  {
    const prov = await Deno.readTextFile(`${PROVISIONAL_DIR}/provisional-1h.csv`);
    const provSha = await sha256Hex(prov);
    const changed = prov.replace(/^(USD\/JPY,summer,40,10:00,5000,[^\n]*,)no$/m, "$1yes");
    if (changed === prov) throw new Error("the planted slot was not changed");
    const r0 = {
      // the file as it is, against its own sha256: read (the check does not refuse everything)
      sameFileReads: !(await stops(() => ruleFileOf(prov, PAIRS, provSha))),
      // one slot changed (fileSlot): stopped
      fileSlotStops: await stops(() => ruleFileOf(changed, PAIRS, provSha)),
      // the provisional file at the real path (provisionalAtProd), against the program's constant: stopped
      provisionalAtProdStops: await stops(() => ruleFileOf(prov, PAIRS, SPREAD_HOURS_SHA256)),
      // an empty constant (emptyConst): stopped
      emptyConstStops: await stops(() => ruleFileOf(prov, PAIRS, "")),
    };
    log(`the rule's file: ${JSON.stringify(r0)}`);
    if (!Object.values(r0).every(Boolean)) pass = false;
    result.ruleFile = r0;
  }
  const lines: Record<string, unknown> = {};
  for (const set of sets) {
    const rows: Array<{ seed: number; m: number | null; lo: number | null; hi: number | null; lo99: number | null; hi99: number | null; aligned: number; weeks: number; mExit: number | null }> = [];
    const wideRows: typeof rows = [];
    for (const seed of seeds) {
      const t0 = Date.now();
      const isFull = set === "none" && full.has(seed);
      const dir = `${COST_OUT}/syn-${set}-${seed}`;
      const src: Source | null = isFull ? { dir: `${dir}/gmo`, fetch: false } : null;
      const ds = await dataSetOf(`2023 ${set} ${seed}`, src, { set, seed }, rg);
      const ms: Mails = { sigs: ds.sigs, P0: ds.sigs.map((s) => pOf(s, DELAY)) };
      const r23 = isFull ? y23Of(ds, slots, rg) : null;
      const c = r23 ? r23.c : costOf(ds.m1s, ms, slots, rg.start, rg.end, "", false);
      const d99 = deltaOf(c.es, c.js, "", 0.995);
      const row = { seed, m: c.s.delta.m, lo: c.s.delta.lo, hi: c.s.delta.hi, lo99: d99.lo, hi99: d99.hi, aligned: c.s.aligned, weeks: c.s.weeks, mExit: c.s.deltaExit };
      rows.push(row);
      const bad = Object.entries(c.checks).filter(([, x]) => !x.ok);
      if (bad.length) {
        pass = false;
        for (const [k, x] of bad) log(`  ${set} ${seed} CHECK ${k} FAILED: ${JSON.stringify(x.detail).slice(0, 1000)}`);
      }
      // (5): the same walk, the winter's avoided slots 12 pips wider (the mid as it is); the signals and E of the
      // walk without it
      if (set === "none") {
        const wide = (pi: number, t: number) => (seasonOf(t) === "winter" && slots.avoid.has(avoidKey(PAIRS[pi], "winter", slotOf(t))) ? 12 : 0);
        const m1w = PAIRS.map((pair, pi) => {
          const w = synthesize(pair, pi, { seed, trend: 0, startPips: null, closedKeys: rg.closedKeys, extraSpread: wide }, rg.from15 - DAY_MS, rg.end);
          const k = lowerBound(w.m1.t, rg.start - DAY_MS);
          const cut = (xs: Float64Array) => xs.subarray(k);
          return { pair, n: w.m1.n - k, t: cut(w.m1.t), bo: cut(w.m1.bo), bh: cut(w.m1.bh), bl: cut(w.m1.bl), bc: cut(w.m1.bc), ao: cut(w.m1.ao), ah: cut(w.m1.ah), al: cut(w.m1.al), ac: cut(w.m1.ac) } as M1;
        });
        const cw = costOf(m1w, ms, slots, rg.start, rg.end, "", false);
        const dw99 = deltaOf(cw.es, cw.js, "", 0.995);
        wideRows.push({ seed, m: cw.s.delta.m, lo: cw.s.delta.lo, hi: cw.s.delta.hi, lo99: dw99.lo, hi99: dw99.hi, aligned: cw.s.aligned, weeks: cw.s.weeks, mExit: cw.s.deltaExit });
      }
      log(`${set} seed ${seed}: signals ${ds.sigs.length}, aligned ${c.s.aligned} (${c.s.weeks} weeks), Δ ${c.s.delta.m?.toFixed(3)} [${c.s.delta.lo?.toFixed(3)}, ${c.s.delta.hi?.toFixed(3)}]${set === "none" ? `; wide Δ ${wideRows[wideRows.length - 1].m?.toFixed(3)}` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (r23) {
        const r = r23;
        await y23Files(dir, r);
        const okFull = judgedChecks(r.checks);
        if (!okFull) pass = false;
        // the print on the walk: the items allowed, and the planted ③ d stopping it (printD)
        const printed = !(await stops(async () => printTextOf(JSON.parse(await Deno.readTextFile(`${dir}/items.json`)) as Item[])));
        const items2 = printItemsOf({ where: "2023年11〜12月", kind: "2023", s: r.c.s, spreads: r.spreads, acc: r.c.acc!, after: [], checks: {}, sha256: {}, weeks: 8 }, "printD");
        const printDStops = await stops(async () => printTextOf(items2));
        log(`  FULL ${seed}: print with the allowed items ${printed ? "made" : "NOT MADE"}; planted printD ${printDStops ? "stopped" : "NOT STOPPED"}`);
        if (!printed || !printDStops) pass = false;
        // pastEndBar: the reads go one bar past END (the first bar after the weekend): the checks of 5 must stop it
        const dsPast = await dataSetOf(`2023 ${set} ${seed} pastEndBar`, src, { set, seed }, { ...rg, readEnd: rg.end + 70 * 3_600_000 + MINUTE });
        const rc = readChecksOf(dsPast, rg, { m1: Y23_KEYS_M1, m15: Y23_KEYS_M15 });
        const pastStops = !rc.readsInPeriod.ok;
        log(`  FULL ${seed}: planted pastEndBar ${pastStops ? "stopped" : "NOT STOPPED"} (${rc.readsInPeriod.why ?? "-"})`);
        if (!pastStops) pass = false;
        // the planted errors that change the computing: each one's numbers for the Python, and its own checks
        const byPlant: Record<string, { changed: number; checks: Record<string, number> }> = {};
        const base = costDumpOf(r.c.es, r.c.js, r.c.s, r.c.acc, r.spreads);
        for (const plant of plants) {
          const q = costOf(ds.m1s, ms, slots, rg.start, rg.end, plant);
          const qd = costDumpOf(q.es, q.js, q.s, q.acc, r.spreads);
          const lines0 = new Set(base["cost-emails.csv"].split("\n"));
          const changed = qd["cost-emails.csv"].split("\n").filter((l) => !lines0.has(l)).length + (qd["cost-summary.json"] !== base["cost-summary.json"] ? 1 : 0) + (qd["cost-accounts.json"] !== base["cost-accounts.json"] ? 1 : 0);
          byPlant[plant] = { changed, checks: Object.fromEntries(Object.entries(q.checks).filter(([, x]) => !x.ok).map(([k, x]) => [k, x.n ?? 1])) };
          log(`  planted ${plant}: ${changed} rows or numbers changed; own checks failing: ${Object.entries(byPlant[plant].checks).map(([k, v]) => `${k} ${v}`).join(",") || "none"}`);
          await writeCost(`${dir}/dump-${plant}`, { ...qd, "cost-meta.json": JSON.stringify({ start: rg.start, end: rg.end, delay: DELAY }) });
        }
        await writeJson(`${dir}/plants-cost.json`, byPlant);
      }
    }
    // line 1: the interval's misses each way at most 7 of 100 (99%: 3); line 2: the mean Δ within 3.39 × SD ÷ 10 of 0
    const judgeSet = (xs: typeof rows, effect: boolean) => {
      const ms2 = xs.map((x) => x.m).filter((x): x is number => x !== null);
      const n = ms2.length;
      const mean = ms2.reduce((a2, x) => a2 + x, 0) / n;
      const sd = Math.sqrt(ms2.reduce((a2, x) => a2 + (x - mean) ** 2, 0) / (n - 1));
      const se = sd / Math.sqrt(n);
      const worse = xs.filter((x) => x.hi !== null && x.hi < 0).length;
      const better = xs.filter((x) => x.lo !== null && x.lo > 0).length;
      const worse99 = xs.filter((x) => x.hi99 !== null && x.hi99 < 0).length;
      const better99 = xs.filter((x) => x.lo99 !== null && x.lo99 > 0).length;
      const noInterval = xs.filter((x) => x.lo === null).length;
      const sortedA = xs.map((x) => x.aligned).sort((a2, b2) => a2 - b2);
      const exits = xs.map((x) => x.mExit).filter((x): x is number => x !== null);
      const limit = INTERVAL_P === 0.975 ? 7 : 3;
      const judged = xs.length >= 100;
      const line1 = !judged || effect || (worse <= limit && better <= limit);
      const line2 = !judged || (effect ? mean < -T_999_99 * se : Math.abs(mean) <= T_999_99 * se);
      return { runs: xs.length, withDelta: n, noInterval, worse, better, worse99, better99, mean, sd, se, line1, line2, judged, alignedMedian: sortedA[Math.floor((sortedA.length - 1) / 2)], meanExit: exits.reduce((a2, x) => a2 + x, 0) / exits.length };
    };
    const j4 = judgeSet(rows, false);
    lines[set] = j4;
    log(`\n== (4) ${set}: worse ${j4.worse}, better ${j4.better} of ${j4.runs} (95%; 99%: ${j4.worse99}, ${j4.better99}; no interval ${j4.noInterval}) — line 1 ${j4.line1 ? "ok" : "FAIL"}; mean Δ ${j4.mean.toFixed(4)} ± ${j4.se.toFixed(4)} — line 2 ${j4.line2 ? "ok" : "FAIL"}${j4.judged ? "" : " (not judged: under 100 walks)"}`);
    if (!j4.line1 || !j4.line2) pass = false;
    if (set === "none") {
      const j5 = judgeSet(wideRows, true);
      lines.wide = j5;
      log(`== (5) the winter's avoided slots 12 pips wider: mean Δ ${j5.mean.toFixed(4)} ± ${j5.se.toFixed(4)} — the line (under −3.39 × SE) ${j5.line2 ? "ok" : "FAIL"}; shown only: worse in ${j5.worse} of ${j5.runs}, the aligned median ${j5.alignedMedian}, the mean Δ on the exit side ${j5.meanExit.toFixed(4)}`);
      if (!j5.line2) pass = false;
    }
  }
  result.lines = lines;
  result.pass = pass;
  await writeJson(`${COST_OUT}/costsyn.json`, result);
  log(`\n§8.103 7 (4), (5) (this run): ${pass ? "PASSED" : "FAILED"}`);
  if (!pass) Deno.exit(1);
}

// 7 (6): (b)'s comparing run on a walk from R to the deadline (12/25 and 1/1 shut): the wide provisional slots
// reach 100 before the deadline (that END_b compares, the week before does not, the week after says it was
// done); the 1-hour ones never reach it (the deadline compares); the planted (b) errors
if (MODE === "bcostsyn") {
  const seed = Number(env("SEED", "1"));
  const plants = env("PLANTS", "").split(",").filter(Boolean);
  const closedKeys = ["20261225", "20270101"];
  const dir = `${COST_OUT}/bcost-${seed}`;
  const from = R_MS - 30 * MINUTE - LEAD15 - 2 * DAY_MS;
  const last = END_B_DEADLINE + WEEK;
  const src: Source = { dir: `${dir}/gmo`, fetch: false };
  for (const [pi, pair] of PAIRS.entries()) {
    const w = synthesize(pair, pi, { seed, trend: 0, startPips: null, closedKeys }, from, last);
    await writeGmoFiles(src.dir, pair, w, from, last);
  }
  // the walk's signals as the emails, sent a few seconds to a minute after their send time (bsyn's offsets)
  const recs: Sig[] = [];
  for (const [pi, pair] of PAIRS.entries()) {
    const q15 = await load15(src, pair, R_MS - 30 * MINUTE - LEAD15, last, newLoadStats());
    recs.push(...signalsOf(pair, pi, q15, R_MS - 30 * MINUTE, last).signals);
  }
  const pool = recs.filter((s) => s.base >= R_MS - 30 * MINUTE && s.base < last).sort((x, y) => x.base - y.base || x.pi - y.pi || y.dir - x.dir);
  const OFFS = [3_824, 0, 59_999, 60_000, 1, 4_500, 30_000];
  const rows: LedgerRow[] = pool.map((s, k) => ({ pair: s.pair, side: s.side, open: s.open, T: s.T, E: s.E, sent: s.base + OFFS[k % OFFS.length] }));
  rows.sort((x, y) => x.sent - y.sent);
  const text = [LEDGER_HEADER, ...rows.map((x) => `${x.pair},${x.side},${iso(x.open)},${iso(x.T)},${x.E},${iso(x.sent)}`)].join("\n") + "\n";
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/ultra15.csv`, text);
  const back = parseLedger(text);
  const files = { "1h": await provisional("1h"), "4h": await provisional("4h") };
  const texts = { "1h": await Deno.readTextFile(`${PROVISIONAL_DIR}/provisional-1h.csv`), "4h": await Deno.readTextFile(`${PROVISIONAL_DIR}/provisional-4h.csv`) };
  // one END_b, as the weekly run reads it: the 1-minute bars from a day before the first email's P
  const runAt = async (endB: number, which: "1h" | "4h", plant = "", out: string | null = null) => {
    const sigs = ledgerSigs(back, endB);
    const first = Math.min(...sigs.filter((s) => s.sent! >= R_MS).map((s) => pOf(s, B_DELAY)));
    const m1s: M1[] = [];
    for (const pair of PAIRS) m1s.push(await loadM1(src, pair, first - 2 * DAY_MS, endB, newLoadStats()));
    if (out) {
      await Deno.mkdir(out, { recursive: true });
      const x = await bCostWeekly(out, m1s, sigs, endB, texts[which], await sha256Hex(texts[which]), plant);
      // the inputs the Python's (b) reading takes (as MODE=b's dump holds them): S_b, END_b, the emails sent before it
      const stopTaus = Float64Array.from(nyClosesBetween(sigs[0].base - DAY_MS, endB).map((c) => c.tau));
      const sB = Math.min(...sigs.map((s) => {
        const P = pOf(s, B_DELAY);
        const tau = maintOf(stopTaus, P);
        return tau === null ? P : tau + MAINT;
      }));
      await writeCost(`${out}/dump`, {
        "meta.json": JSON.stringify({ start: sB, end: endB, split: endB, delay: B_DELAY, startYen: START_YEN, cap: CAP, mode: "b", endB }),
        "signals.csv": ["i,pair,side,open,T,E,tp,late,base,sent", ...sigs.map((s, i) => `${i},${s.pair},${s.side},${s.open},${s.T},${s.E},${s.tp},${s.late ? 1 : 0},${s.base},${s.sent}`)].join("\n"),
      });
      return { x, m1s, sigs };
    }
    return { x: bCostOf(m1s, sigs, endB, files[which], plant), m1s, sigs };
  };
  // the counts every Saturday (from the deadline's bars: what each END_b's run counts, 7 (6))
  const counts: Record<string, Array<{ endB: string; aligned: number }>> = { "1h": [], "4h": [] };
  let reach: number | null = null;
  for (const which of ["4h", "1h"] as const) {
    const r = await runAt(END_B_DEADLINE, which);
    const all = r.x!.c;
    for (let e = firstSaturdayAfter(R_MS); e <= END_B_DEADLINE; e += WEEK) {
      const n = judge(all.es.filter((x) => x.sent! < e), files[which].avoid, { end: e }).filter((j) => j.aligned).length;
      counts[which].push({ endB: iso(e).slice(0, 10), aligned: n });
      if (which === "4h" && reach === null && n >= COMPARE_AT) reach = e;
    }
    log(`${which}: aligned avoided by END_b ${counts[which].map((c) => `${c.endB.slice(5)} ${c.aligned}`).join(", ")}`);
  }
  let pass = true;
  const under1h = counts["1h"][counts["1h"].length - 1].aligned < COMPARE_AT;
  log(`the wide slots reach ${COMPARE_AT} before the deadline: ${reach !== null && reach < END_B_DEADLINE ? `yes (${iso(reach).slice(0, 10)})` : "NO"}; the 1-hour slots stay under ${COMPARE_AT} to the deadline: ${under1h ? "yes" : "NO"}`);
  if (reach === null || !(reach < END_B_DEADLINE) || !under1h) pass = false;
  const RUNS: Array<{ name: string; which: "1h" | "4h"; endB: number; want: "before" | "compare" | "done" }> = reach === null ? [] : [
    { name: "wide-before", which: "4h", endB: reach - WEEK, want: "before" },
    { name: "wide-reach", which: "4h", endB: reach, want: "compare" },
    ...(reach + WEEK <= END_B_DEADLINE ? [{ name: "wide-after", which: "4h" as const, endB: reach + WEEK, want: "done" as const }] : []),
    { name: "deadline-1h", which: "1h", endB: END_B_DEADLINE, want: "compare" },
  ];
  const result: Record<string, unknown> = { seed, reach: reach === null ? null : iso(reach), counts, runs: {} };
  for (const run of RUNS) {
    const out = `${dir}/${run.name}`;
    const r = await runAt(run.endB, run.which, "", out);
    const x = r.x!;
    const ok = x.status.kind === run.want && Object.values(x.c.checks).every((c) => c.ok) && (run.want !== "compare" || x.print !== null);
    let printOk = true;
    if (x.print) printOk = !(await stops(async () => printTextOf(x.print!)));
    log(`${run.name} (END_b ${iso(run.endB).slice(0, 10)}, ${run.which}): ${x.status.kind} (want ${run.want}); aligned ${x.c.s.aligned} (${x.c.s.weeks} weeks), kept ${x.c.s.kept}, enough ${x.c.s.enough ? "yes" : "no"}; evaluation early ${x.c.s.notCounted.evalEarly}; ${x.print ? `Δ ${x.c.s.delta.m?.toFixed(3)} [${x.c.s.delta.lo?.toFixed(3)}, ${x.c.s.delta.hi?.toFixed(3)}], print ${printOk ? "made" : "NOT MADE"}` : x.items.map((i) => `${i.item} ${i.text}`).join(", ")}; ${ok && printOk ? "ok" : "FAILED"}`);
    if (!ok || !printOk) pass = false;
    await Deno.writeTextFile(`${out}/meta.json`, JSON.stringify({ endB: run.endB, which: run.which, want: run.want }));
    (result.runs as Record<string, unknown>)[run.name] = { status: x.status, aligned: x.c.s.aligned };
    // the planted (b) errors: compare at every run of 100 or more, the deadline ignored, Δ in the weekly output
    for (const plant of plants) {
      let caught: boolean;
      try {
        const q = await runAt(run.endB, run.which, plant);
        caught = q.x!.status.kind !== x.status.kind;
      } catch (e) {
        if (!(e instanceof PrintItemsError)) throw e;
        caught = true;
      }
      log(`  planted ${plant} on ${run.name}: ${caught ? "caught" : "not caught here"}`);
      const k = `plant ${plant}`;
      result[k] = ((result[k] as number) ?? 0) + (caught ? 1 : 0);
    }
  }
  for (const plant of plants) {
    if (!result[`plant ${plant}`]) {
      log(`planted ${plant}: NOT CAUGHT on any run`);
      pass = false;
    }
  }
  result.pass = pass;
  await writeJson(`${dir}/bcostsyn.json`, result);
  log(`\n§8.103 7 (6) (this run): ${pass ? "PASSED" : "FAILED"}`);
  if (!pass) Deno.exit(1);
}

// ---- B(2): the email rule on 5-minute bars, against tf-winrate.ts ---------------------------------

async function reproduce(ds: DataSet, tfw: Record<string, unknown>): Promise<{ ok: boolean; detail: unknown }> {
  const STEP5 = 5 * MINUTE;
  const MAX_HOLD = 1440;
  const recs: Array<{ T: number; kind: string; pips: number }> = [];
  const perPair: Record<string, number> = {};
  const failed5: Record<string, number> = {};
  for (const [pi, pair] of PAIRS.entries()) {
    const st = newLoadStats();
    const q5 = await loadQuotes(ds.src!, pair, "5min", STEP5, START_MS - 5 * DAY_MS, END_MS, st);
    failed5[pair] = st.failed;
    const t = Float64Array.from(q5.map((q) => Date.parse(q.datetime)));
    const unit = unitOf(pair);
    const own = ds.sigs.filter((s) => s.pi === pi && !s.late);
    perPair[pair] = own.length;
    for (const s of own) {
      const buy = s.dir === 1;
      const sl = s.E - s.dir * 13 * unit;
      const tp = s.E + s.dir * 4 * unit;
      // the signal bar's own close on the side it fills on (tf-winrate: the 15-minute quote's)
      const fill = buy ? s.askC : s.bidC;
      const from = lowerBound(t, s.T);
      const last = from + MAX_HOLD - 1;
      if (from < 0 || last > q5.length - 1) continue;
      let kind = "open";
      let exit = buy ? q5[last].bid.close : q5[last].ask.close;
      for (let j = from; j <= last; j++) {
        const q = buy ? q5[j].bid : q5[j].ask;
        if (buy ? q.open <= sl : q.open >= sl) {
          kind = "sl";
          exit = q.open;
          break;
        }
        if (buy ? q.open >= tp : q.open <= tp) {
          kind = "tp";
          exit = q.open;
          break;
        }
        const hitTp = buy ? q.high >= tp : q.low <= tp;
        const hitSl = buy ? q.low <= sl : q.high >= sl;
        if (hitTp && hitSl) {
          kind = "amb";
          exit = sl;
          break;
        }
        if (hitSl) {
          kind = "sl";
          exit = sl;
          break;
        }
        if (hitTp) {
          kind = "tp";
          exit = tp;
          break;
        }
      }
      recs.push({ T: s.T, kind, pips: (buy ? exit - fill : fill - exit) / unit });
    }
  }
  const sum = (xs: typeof recs) => ({ n: xs.length, tp: xs.filter((x) => x.kind === "tp").length, sl: xs.filter((x) => x.kind === "sl").length, amb: xs.filter((x) => x.kind === "amb").length, open: xs.filter((x) => x.kind === "open").length, pips: xs.length ? xs.reduce((s, x) => s + x.pips, 0) / xs.length : null });
  const mine = { all: sum(recs), first: sum(recs.filter((x) => x.T < SPLIT_MS)), second: sum(recs.filter((x) => x.T >= SPLIT_MS)) };
  const tables = tfw.tables as Record<string, Record<string, Record<string, { n: number; tp: number; sl: number; amb: number; open: number; pips: number | null }>>>;
  const cov = (tfw.coverage as Array<{ pair: string; tf: string; ultra: number }>).filter((c) => c.tf === "15min");
  const diffs: string[] = [];
  for (const per of ["all", "first", "second"] as const) {
    const th = tables[per]["15min"]["ultra-tp1"];
    const me = mine[per];
    for (const k of ["n", "tp", "sl", "amb", "open"] as const) if (th[k] !== me[k]) diffs.push(`${per} ${k}: tf-winrate ${th[k]}, here ${me[k]}`);
    if (th.pips !== null && me.pips !== null && Math.abs(th.pips - me.pips) > 1e-9) diffs.push(`${per} pips differ by more than 1e-9`);
  }
  for (const c of cov) if (perPair[c.pair] !== c.ultra) diffs.push(`${c.pair} ULTRA signals: tf-winrate ${c.ultra}, here ${perPair[c.pair]}`);
  // B(2'): tf-winrate's own check of its 15-minute signals against indicatorSignals, and the JSON being this run's settings
  const ck = (tfw.check as Record<string, { compared: number; mismatched: number }> | undefined)?.["15min"];
  if (!ck) diffs.push("tf-winrate check 15min missing");
  else {
    if (ck.mismatched !== 0) diffs.push(`tf-winrate check 15min: ${ck.mismatched} of ${ck.compared} differ`);
    if (!(ck.compared > 0)) diffs.push("tf-winrate check 15min compared nothing");
  }
  if (Date.parse(String(tfw.now)) !== END_MS) diffs.push(`tf-winrate now ${tfw.now}, END ${END}`);
  if (tfw.start !== START) diffs.push(`tf-winrate start ${tfw.start}, here ${START}`);
  if (tfw.split !== SPLIT) diffs.push(`tf-winrate split ${tfw.split}, here ${SPLIT}`);
  if (tfw.sl !== 13) diffs.push(`tf-winrate sl ${tfw.sl}, not 13`);
  if (tfw.weekend !== "inside") diffs.push(`tf-winrate weekend ${tfw.weekend}, not inside`);
  if (tfw.synthetic) diffs.push("tf-winrate ran on synthetic data");
  if (JSON.stringify(tfw.pairs) !== JSON.stringify(PAIRS)) diffs.push(`tf-winrate pairs ${JSON.stringify(tfw.pairs)}`);
  // every GMO read made: tf-winrate's own (its coverage) and the 5-minute bars read here
  const tfFailed = (tfw.coverage as Array<{ failed?: number }>).reduce((a, c) => a + (c.failed ?? 0), 0);
  if (tfFailed !== 0) diffs.push(`tf-winrate GMO reads failed: ${tfFailed}`);
  for (const [pair, f] of Object.entries(failed5)) if (f !== 0) diffs.push(`${pair} 5-minute reads failed: ${f}`);
  return { ok: diffs.length === 0, detail: { diffs } };
}

// (a)'s per-email values: T, pair, side, P, week, the value at P + 1 day (the signal's side)
function aCsv(ds: DataSet, a: Analysis): string {
  void a;
  const closes = nyClosesBetween(START_MS - DAY_MS, END_MS);
  const taus = Float64Array.from(closes.map((c: NyClose) => c.tau));
  const books = ds.m1s.map((m) => makeBook(m, taus, true));
  const lines = ["T,pair,side,P,week,v1d"];
  for (const s of ds.sigs) {
    const p = follow(books[s.pi], { dir: s.dir, E: s.E, tp: s.tp, P: pOf(s, DELAY) }, { fill: "touch", endMs: END_MS });
    if (p.none || p.P + DAY_MS > END_MS) continue;
    const v = valueAt(books[s.pi], p, s.dir, p.P + DAY_MS);
    lines.push(`${iso(s.T)},${s.pair},${s.side},${iso(p.P)},${weekOf(s.T)},${v.v}`);
  }
  return lines.join("\n");
}
