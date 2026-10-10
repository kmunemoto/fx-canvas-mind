// #250 (docs §8.106 7 and 段1の作り): stage 1 — on the first half (H1) only, the four candidates' outcomes
// compared, one chosen; and, on the walks, the whole of the procedure (H1's choice, H2's check).
//
//   MODE=stage1  GMO's bars to the split (2025-05-19 00:00 UTC) only: (a)'s H1 emails (the stage-0 labels
//                file, its sha256 the constant's), followed on 5-minute bars, each candidate's δ, interval
//                and t, the choice (段1の作り 5), the chosen one's random line; the checks of 段1の作り 7;
//                OUT/print.txt (the numbers, never stdout), OUT/checks.json, OUT/result.json and
//                OUT/emails.csv (for the Python), OUT/trend-choice.json
//   MODE=syn     a walk research/trend.ts wrote (WALK_DIR: its gmo/ and trend-labels.csv): the same on H1,
//                then H2 with every candidate taken through §8.106 8 as if chosen (OUT/summary.json);
//                PLANT=<name> one planted error (段1の作り 8), which a check must catch
//   MODE=calib   the walks' summaries (CALIB_DIR/*/summary.json) against 段1の作り 8's conditions
//   MODE=stage2  stops: stage 2 runs only with the choice's constant (§8.106 7), not written yet
//
// The pieces (the follow, δ, the interval, the random removals) are research/trend-stats.ts.

import { GMO_SYMBOLS } from "../supabase/functions/track-outcomes/quotes.ts";
import { ULTRA_PAIRS } from "../supabase/functions/_shared/ultra.ts";
import { DAY, HOUR, MINUTE } from "./lib.ts";
import { LEAD15, PAIRS, type Sig, type Source, load15, loadQuotes, newLoadStats, signalsOf, unitOf } from "./ownerhold-data.ts";
import { A_SHA256 } from "./ownerhold-b.ts";
import { sha256Hex } from "./spreadhours-lib.ts";
import { type Bars, DIR_OF, FINE, type Labels, STATE_CODE, STATE_NAMES, TREND_LABELS_SHA256, type Series, gapsOf, holeIn, labelsOf, seriesOf, weekendOutOf } from "./trend-labels.ts";
import { STEP_OF, loadTf } from "./trend-data.ts";
import {
  type Delta, type Fine, type Item, KINDS, type Line, type REm, type Res, TPS, TRACK, dayOf, deltaHand, deltaOf, followHand, lineOf, lowerBound, removalSeed, setPlant, stratumOf, tradeOf, weekOf,
} from "./trend-stats.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const MODE = env("MODE", "syn");
if (!["stage1", "syn", "calib", "stage2"].includes(MODE)) throw new Error(`MODE ${MODE}: stage1, syn, calib or stage2`);
if (MODE === "stage2") throw new Error("stage 2 runs only with research/ledger/trend-choice.json's sha256 constant (§8.106 7), not written yet");
const SYN = MODE === "syn";
export const PLANTS = ["exitSideSwap", "hintSwap", "lateFromT", "noSideStratum", "noMeanError", "randomTotal", "trackH2", "keepEdge", "lostFive"] as const;
const PLANT = env("PLANT", "");
if (PLANT && !(PLANTS as readonly string[]).includes(PLANT)) throw new Error(`PLANT ${PLANT}: not one of ${PLANTS.join(", ")}`);
if (PLANT && !SYN) throw new Error(`PLANT ${PLANT}: on the walk only (MODE=syn)`);
setPlant(PLANT);
const OUT = env("OUT", "research/out/trend1");
const CACHE = env("CACHE_DIR", "research/.cache");
const WALK_DIR = env("WALK_DIR", "");
const SEED = SYN ? Number(env("SEED", "0")) : 0;
const ANSWER = SYN && env("ANSWER", "") === "1";
if (SYN && (!WALK_DIR || !(SEED > 0))) throw new Error("MODE=syn: WALK_DIR (the folder research/trend.ts wrote) and SEED (the walk's seed)");
const LABELS = SYN ? `${WALK_DIR}/trend-labels.csv` : env("LABELS", "research/ledger/trend-labels.csv");
const A_CSV = env("A_CSV", "research/ledger/ultra15-a.csv");
const TFW_JSON = env("TFW_JSON", "research/out/tf-winrate.json");

// (a)'s period and §8.106 5's split; the walks of 段1の作り 8 have the same
const START_MS = Date.parse("2024-01-01T00:00:00Z");
const SPLIT_MS = Date.parse("2025-05-19T00:00:00Z");
const END_MS = Date.parse("2026-10-03T00:00:00Z");
const W0 = { H1: weekOf(START_MS), H2: weekOf(SPLIT_MS) } as const;
const WEEKS = { H1: (SPLIT_MS - START_MS) / (7 * DAY), H2: (END_MS - SPLIT_MS) / (7 * DAY) } as const;
type Half = "H1" | "H2";

const TFS = ["15min", "1h", "4h"] as const;
type LTf = (typeof TFS)[number];
const CANDS = ["①1H", "②4H", "③1H+4H", "④15M"] as const;
const weekendOut = weekendOutOf("inside");
const GAPS = gapsOf(weekendOut);
const src: Source = SYN ? { dir: `${WALK_DIR}/gmo`, fetch: false } : { dir: CACHE, fetch: true };
const fromOf = (tf: LTf): number => (tf === "15min" ? START_MS - 12 * DAY : tf === "1h" ? START_MS - 45 * DAY : Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1));

const lines: string[] = [];
const say = (s = "") => {
  lines.push(s);
  console.log(s);
};
// the numbers: print.txt only on real data (never stdout or stderr; the job shows print.txt only once every
// check and the Python passed)
const sayOut = SYN ? say : (s = "") => {
  lines.push(s);
};
const isoMs = (ms: number) => new Date(ms).toISOString();

interface Check {
  ok: boolean;
  n: number;
  detail: string;
  examples: string[];
}
const checks: Record<string, Check> = {};
const check = (name: string, ok: boolean, n: number, detail: string, examples: string[] = []) => {
  checks[name] = { ok, n, detail, examples: examples.slice(0, 8) };
};

// ---- the labels file and (a) ---------------------------------------------------------------------

interface Lab {
  state: number;
  excl: number;
}
interface Row {
  T: number;
  pair: string;
  pi: number;
  side: "BUY" | "SELL";
  late: boolean;
  C: number;
  half: Half | "-";
  lab: Record<LTf, Lab>;
}
const parseLabels = (text: string): Row[] => {
  const ls = text.split("\n").filter((l) => l !== "");
  if (ls[0] !== "T,pair,side,late,C,half,s15,x15,s1h,x1h,s4h,x4h") throw new Error(`${LABELS}: header ${ls[0]}`);
  return ls.slice(1).map((l, k) => {
    const c = l.split(",");
    const pi = (PAIRS as readonly string[]).indexOf(c[1]);
    const st = (x: string) => (x === "-" ? -1 : STATE_CODE[x]);
    const r: Row = {
      T: Date.parse(c[0]),
      pair: c[1],
      pi,
      side: c[2] as "BUY" | "SELL",
      late: c[3] === "1",
      C: Date.parse(c[4]),
      half: c[5] as Half | "-",
      lab: { "15min": { state: st(c[6]), excl: Number(c[7]) }, "1h": { state: st(c[8]), excl: Number(c[9]) }, "4h": { state: st(c[10]), excl: Number(c[11]) } },
    };
    if (c.length !== 12 || pi < 0 || !["BUY", "SELL"].includes(r.side) || !["H1", "H2", "-"].includes(r.half) || ![r.T, r.C].every(Number.isFinite)) throw new Error(`${LABELS} row ${k + 1}: ${l}`);
    for (const tf of TFS) if (r.lab[tf].state === undefined || !Number.isFinite(r.lab[tf].excl)) throw new Error(`${LABELS} row ${k + 1}: label ${l}`);
    return r;
  });
};
const keyOf = (T: number, pair: string, side: string) => `${T}|${pair}|${side}`;

// ---- the verdicts (§8.106 2; trend.ts's) ----------------------------------------------------------

const dirOf = (state: number): number => {
  if (state < 0) return 0;
  // planted: the hints' directions swapped
  if (PLANT === "hintSwap" && (state === 3 || state === 4)) return -DIR_OF[state];
  return DIR_OF[state];
};
// 1 kept, -1 left out, 0 unreadable
const verdictOf = (c: number, buy: boolean, lab: Record<LTf, Lab>): number => {
  const ok = (tf: LTf) => lab[tf].state >= 0 && lab[tf].excl === 0;
  const against = (tf: LTf) => dirOf(lab[tf].state) === -(buy ? 1 : -1);
  if (c === 0) return ok("1h") ? (against("1h") ? -1 : 1) : 0;
  if (c === 1) return ok("4h") ? (against("4h") ? -1 : 1) : 0;
  if (c === 2) return ok("1h") && ok("4h") ? (against("1h") && against("4h") ? -1 : 1) : 0;
  return ok("15min") ? (against("15min") ? -1 : 1) : 0;
};
const verdictHand = () => {
  const lab = (a: number, b: number, c: number, xb = 0, xc = 0): Record<LTf, Lab> => ({ "15min": { state: a, excl: a < 0 ? 9 : 0 }, "1h": { state: b, excl: xb }, "4h": { state: c, excl: xc } });
  const cases: Array<[string, boolean, Record<LTf, Lab>, number[]]> = [
    ["BUY 15M up, 1H down, 4H toUp", true, lab(1, 2, 3), [-1, 1, 1, 1]],
    ["SELL 15M toUp, 1H toUp, 4H up", false, lab(3, 3, 1), [-1, -1, -1, -1]],
    ["BUY 15M toDown, 1H none, 4H toDown", true, lab(4, 0, 4), [1, -1, 1, -1]],
    ["SELL 15M down, 1H up (short), 4H down", false, lab(2, 1, 2, 1), [0, 1, 0, 1]],
    ["BUY 15M not read, 1H up, 4H down", true, lab(-1, 1, 2), [1, -1, 1, 0]],
    ["SELL 15M none, 1H down, 4H toDown", false, lab(0, 2, 4), [1, 1, 1, 1]],
    ["BUY 15M up, 1H up, 4H down (a hole)", true, lab(1, 1, 2, 0, 2), [1, 0, 0, 1]],
  ];
  const bad: string[] = [];
  for (const [name, buy, l, want] of cases) {
    const got = CANDS.map((_, c) => verdictOf(c, buy, l));
    if (got.join() !== want.join()) bad.push(`${name}: ${got.join(" ")} (want ${want.join(" ")})`);
  }
  check("verdicts", bad.length === 0, bad.length, `${cases.length} hand-made emails through the four candidates`, bad);
};

// §8.106 6's floors (trend.ts floorMiss), from the labels file's counts
const floorMiss = (n: number, kept: number, out: number, unread: number, wK: number, wO: number, kB: number, kS: number, wKB: number, wKS: number): string[] =>
  [
    kept < 300 ? "kept<300" : "",
    out < 300 ? "out<300" : "",
    wK < 30 ? "keptWeeks<30" : "",
    wO < 30 ? "outWeeks<30" : "",
    kB < 50 ? "BUY<50" : "",
    kS < 50 ? "SELL<50" : "",
    wKB < 40 ? "BUYWeeks<40" : "",
    wKS < 40 ? "SELLWeeks<40" : "",
    50 * unread > n ? "unread>2%" : "",
  ].filter((m) => m !== "");
const floorsOf = (rows: Row[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const h of ["H1", "H2"] as const) {
    const inH = rows.filter((r) => r.half === h);
    CANDS.forEach((name, c) => {
      const v = inH.map((r) => verdictOf(c, r.side === "BUY", r.lab));
      const cnt = (want: number, side?: string) => inH.filter((r, i) => v[i] === want && (!side || r.side === side)).length;
      const wks = (want: number, side?: string) => new Set(inH.filter((r, i) => v[i] === want && (!side || r.side === side)).map((r) => weekOf(r.T))).size;
      out[`${h}|${name}`] = floorMiss(inH.length, cnt(1), cnt(-1), cnt(0), wks(1), wks(-1), cnt(1, "BUY"), cnt(1, "SELL"), wks(1, "BUY"), wks(1, "SELL"));
    });
  }
  return out;
};

// ---- one half's emails, followed ------------------------------------------------------------------

interface Em {
  row: Row;
  buy: boolean;
  s: number;
  week: number;
  day: number;
  E: number;
  bidC: number;
  askC: number;
  res: Res[]; // TPS order: 4, 10, 16
  v1d: number | null;
  verdict: number[]; // per candidate
  // the yardstick's verdicts (the labels one bar further, 段1の作り 5), H1 only
  ahead: number[] | null;
}

const fineOf = (qs: Array<{ datetime: string; bid: { open: number; high: number; low: number; close: number }; ask: { open: number; high: number; low: number; close: number } }>): Fine => {
  const n = qs.length;
  const f: Fine = { n, t: new Float64Array(n), bo: new Float64Array(n), bh: new Float64Array(n), bl: new Float64Array(n), bc: new Float64Array(n), ao: new Float64Array(n), ah: new Float64Array(n), al: new Float64Array(n), ac: new Float64Array(n) };
  qs.forEach((q, i) => {
    f.t[i] = Date.parse(q.datetime);
    f.bo[i] = q.bid.open;
    f.bh[i] = q.bid.high;
    f.bl[i] = q.bid.low;
    f.bc[i] = q.bid.close;
    f.ao[i] = q.ask.open;
    f.ah[i] = q.ask.high;
    f.al[i] = q.ask.low;
    f.ac[i] = q.ask.close;
  });
  return f;
};

interface HalfRun {
  half: Half;
  ems: Em[];
  fines: Fine[];
  // the newest bar read (its close), of any series
  newest: number;
  // each pair's signals with T up to the bars' end (tf-winrate's coverage counts the bars closed by its END)
  sigsUpTo: number[];
}

const readHalf = async (half: Half, rows: Row[], st: ReturnType<typeof newLoadStats>): Promise<HalfRun> => {
  // the bars end where the half ends (H1: the split; H2: END). Planted trackH2: H1's read runs to END
  const barsEnd = half === "H1" && PLANT !== "trackH2" ? SPLIT_MS : END_MS;
  // the emails followed: the half's rows. Planted: H2's rows too (trackH2), or every row before the split (keepEdge)
  const mine = rows.filter((r) => (half === "H1" ? (PLANT === "trackH2" ? r.half !== "-" : PLANT === "keepEdge" ? r.T < SPLIT_MS : r.half === "H1") : r.half === "H2"));
  let newest = -Infinity;
  const ems: Em[] = [];
  const fines: Fine[] = [];
  const sigBad: string[] = [];
  let sigN = 0;
  let rowN = 0;
  const sigsUpTo: number[] = [];
  for (const [pi, pair] of PAIRS.entries()) {
    if (!GMO_SYMBOLS[pair]) throw new Error(`${pair}: no GMO symbol`);
    // the signals again (E, the bar's bid and ask closes): every row with T before the bars' end is one signal
    const q15 = await load15(src, pair, START_MS - LEAD15, barsEnd, st);
    for (const q of q15) newest = Math.max(newest, Date.parse(q.datetime) + 15 * MINUTE);
    const sigs = signalsOf(pair, pi, q15, START_MS, barsEnd, false).signals;
    sigsUpTo.push(signalsOf(pair, pi, q15, START_MS, barsEnd + 1, false).signals.length);
    const byKey = new Map<string, Sig>();
    for (const s of sigs) {
      const k = `${keyOf(s.T, s.pair, s.side)}|${s.late ? 1 : 0}`;
      if (byKey.has(k)) sigBad.push(`${pair} ${isoMs(s.T)} ${s.side}: two signals`);
      byKey.set(k, s);
    }
    const pairRows = rows.filter((r) => r.pair === pair && r.T < barsEnd);
    sigN += sigs.length;
    rowN += pairRows.length;
    const rowKeys = new Set(pairRows.map((r) => `${keyOf(r.T, r.pair, r.side)}|${r.late ? 1 : 0}`));
    for (const s of sigs) if (!rowKeys.has(`${keyOf(s.T, s.pair, s.side)}|${s.late ? 1 : 0}`)) sigBad.push(`${pair} ${isoMs(s.T)} ${s.side}: a signal without a row`);
    // the 5-minute bars the trades are followed on (from two days before the half's first email)
    const from5 = (half === "H1" ? START_MS : SPLIT_MS) - 2 * DAY;
    let q5 = await loadQuotes(src, pair, "5min", 5 * MINUTE, from5, barsEnd, st);
    // planted: a 5-minute day file lost (USD/JPY, the GMO day 2025-02-12), which the 5-minute holes check must catch
    if (PLANT === "lostFive" && pair === "USD/JPY") q5 = q5.filter((q) => {
      const t = Date.parse(q.datetime);
      return t < Date.parse("2025-02-11T21:00:00Z") || t >= Date.parse("2025-02-12T21:00:00Z");
    });
    const f = fineOf(q5);
    const q15At = new Map(q15.map((q) => [Date.parse(q.datetime), q]));
    if (f.n) newest = Math.max(newest, f.t[f.n - 1] + 5 * MINUTE);
    fines.push(f);
    const unit = unitOf(pair);
    for (const r of mine.filter((x) => x.pair === pair)) {
      const s = byKey.get(`${keyOf(r.T, r.pair, r.side)}|${r.late ? 1 : 0}`);
      if (!s) {
        sigBad.push(`${pair} ${isoMs(r.T)} ${r.side}: a row without a signal`);
        continue;
      }
      if (s.base !== r.C) sigBad.push(`${pair} ${isoMs(r.T)} ${r.side}: C ${isoMs(r.C)}, the signal's ${isoMs(s.base)}`);
      const buy = r.side === "BUY";
      // a late signal is entered at the close of the 15-minute bar closing at C (§8.106 1), the levels from its E
      const cq = r.late ? q15At.get(r.C - 15 * MINUTE) : null;
      if (r.late && !cq) sigBad.push(`${pair} ${isoMs(r.T)} ${r.side}: late, no 15-minute bar closing at C`);
      const x = { T: r.T, C: r.C, buy, E: s.E, unit, bidC: cq ? cq.bid.close : s.bidC, askC: cq ? cq.ask.close : s.askC };
      const res = TPS.map((tp) => tradeOf(f, x, tp));
      ems.push({ row: r, buy, s: stratumOf(pi, buy), week: weekOf(r.T), day: dayOf(r.T), E: s.E, bidC: x.bidC, askC: x.askC, res: res as Res[], v1d: null, verdict: CANDS.map((_, c) => verdictOf(c, buy, r.lab)), ahead: null });
      if (res.some((x) => x === null)) (ems[ems.length - 1] as Em & { short?: boolean }).short = true;
    }
  }
  ems.sort((a, b) => a.row.T - b.row.T || a.row.pi - b.row.pi || (b.buy ? 1 : 0) - (a.buy ? 1 : 0) || Number(a.row.late) - Number(b.row.late));
  check(`signals.${half}`, sigBad.length === 0 && sigN === rowN, sigBad.length + Math.abs(sigN - rowN), `the labels file's rows with T before ${isoMs(barsEnd)}: ${rowN}; the signals again: ${sigN}; differ ${sigBad.length}`, sigBad);
  return { half, ems, fines, newest, sigsUpTo };
};

// h1Only (段1の作り 1, 7): H1's read ends at the split, the emails followed are the labels file's H1 rows, each
// followed for 1,440 bars inside the bars read
const h1OnlyCheck = (run: HalfRun, rows: Row[]) => {
  const want = new Set(rows.filter((r) => r.half === "H1").map((r) => `${keyOf(r.T, r.pair, r.side)}|${r.late ? 1 : 0}`));
  const got = new Set(run.ems.map((e) => `${keyOf(e.row.T, e.row.pair, e.row.side)}|${e.row.late ? 1 : 0}`));
  const extra = [...got].filter((k) => !want.has(k));
  const missing = [...want].filter((k) => !got.has(k));
  const short = run.ems.filter((e) => (e as Em & { short?: boolean }).short);
  const ok = run.newest <= SPLIT_MS && extra.length === 0 && missing.length === 0 && short.length === 0;
  check("h1Only", ok, extra.length + missing.length + short.length,
    `the newest bar read closes ${isoMs(run.newest)} (the split ${isoMs(SPLIT_MS)}); emails followed ${got.size}, H1 rows ${want.size}, not H1 ${extra.length}, H1 not followed ${missing.length}, not followed for 1,440 bars inside the bars read ${short.length}`,
    [...extra.slice(0, 3), ...missing.slice(0, 3), ...short.slice(0, 3).map((e) => `${isoMs(e.row.T)} ${e.row.pair} ${e.row.side}: short`)]);
};

// fiveHoles (段1の作り 7, §8.106 11 「穴の数」): in each email's follow — the gap before its first 5-minute bar from C
// and between its 1,440 bars — a hole of 30 minutes or more that neither the market's hours nor GMO's own closures
// (a stamp most of the five pairs miss, stage 0's rule) explain. A file GMO lost would stretch a follow unseen.
const fiveHolesCheck = (run: HalfRun) => {
  const bars = run.fines.map((f) => f as unknown as Bars);
  const holes = GAPS.commonMissing(bars, 5 * MINUTE);
  const pre = bars.map((b) => GAPS.gapPrefix(b, 5 * MINUTE, holes));
  let bad = 0;
  const ex: string[] = [];
  for (const e of run.ems) {
    const f = run.fines[e.row.pi];
    const from = lowerBound(f.t, PLANT === "lateFromT" ? e.row.T : e.row.C);
    const lo = Math.max(0, from - 1);
    const hi = Math.min(f.n - 1, from + TRACK - 1);
    if (holeIn(pre[e.row.pi], lo, hi)) {
      bad++;
      if (ex.length < 6) ex.push(`${isoMs(e.row.T)} ${e.row.pair} ${e.row.side}`);
    }
  }
  const days = new Set([...holes].map((t) => isoMs(t).slice(0, 10)));
  check(`fiveHoles.${run.half}`, bad === 0, bad, `follows with an unexplained hole of 30 minutes or more: ${bad} of ${run.ems.length}; GMO's own 5-minute closures ${holes.size} stamps on ${days.size} days`, ex);
};

// the half's own counterpart for H2 (the walks): every email followed for 1,440 bars inside the bars read
const h2Check = (run: HalfRun, rows: Row[]) => {
  const want = rows.filter((r) => r.half === "H2").length;
  const short = run.ems.filter((e) => (e as Em & { short?: boolean }).short).length;
  check("h2Follow", run.ems.length === want && short === 0, Math.abs(run.ems.length - want) + short, `H2 emails followed ${run.ems.length} of ${want}; short ${short}`);
};

// lookBehind (段1の作り 7): the 300 5-minute bars before C moved ±777.7 pips: no outcome moves; the first bar
// from C moved: every email's outcome moves
const lookBehindCheck = (run: HalfRun) => {
  let n = 0;
  let movedBefore = 0;
  let movedFirst = 0;
  const ex: string[] = [];
  for (const e of run.ems) {
    const f = run.fines[e.row.pi];
    const from = lowerBound(f.t, PLANT === "lateFromT" ? e.row.T : e.row.C);
    const lo = Math.max(0, from - 300);
    const hi = Math.min(f.n, from + TRACK);
    const cut = (): Fine => ({ n: hi - lo, t: f.t.slice(lo, hi), bo: f.bo.slice(lo, hi), bh: f.bh.slice(lo, hi), bl: f.bl.slice(lo, hi), bc: f.bc.slice(lo, hi), ao: f.ao.slice(lo, hi), ah: f.ah.slice(lo, hi), al: f.al.slice(lo, hi), ac: f.ac.slice(lo, hi) });
    const unit = unitOf(e.row.pair);
    const x = { T: e.row.T, C: e.row.C, buy: e.buy, E: e.E, unit, bidC: e.bidC, askC: e.askC };
    const before = cut();
    for (let j = 0; j < from - lo; j++) {
      const d = (j % 2 === 0 ? 777.7 : -777.7) * unit;
      for (const a of [before.bo, before.bh, before.bl, before.bc, before.ao, before.ah, before.al, before.ac]) a[j] += d;
    }
    const first = cut();
    {
      const j = from - lo;
      const d = (n % 2 === 0 ? 777.7 : -777.7) * unit;
      if (j < first.n) for (const a of [first.bo, first.bh, first.bl, first.bc, first.ao, first.ah, first.al, first.ac]) a[j] += d;
    }
    n++;
    TPS.forEach((tp, k) => {
      const a = tradeOf(before, x, tp);
      const b = tradeOf(first, x, tp);
      const was = e.res[k];
      if (!a || !was || a.kind !== was.kind || a.pips !== was.pips) {
        movedBefore++;
        if (ex.length < 6) ex.push(`${isoMs(e.row.T)} ${e.row.pair} ${e.row.side} TP${tp}: the bars before C moved it`);
      }
      if (b && was && b.kind === was.kind && b.pips === was.pips) {
        movedFirst++;
        if (ex.length < 6) ex.push(`${isoMs(e.row.T)} ${e.row.pair} ${e.row.side} TP${tp}: the first bar from C did not move it`);
      }
    });
  }
  check(`lookBehind.${run.half}`, n > 0 && movedBefore === 0 && movedFirst === 0, movedBefore + movedFirst, `${n} emails × 3 TPs: moved by the bars before C ${movedBefore}; not moved by the first bar from C ${movedFirst}`, ex);
};

// ---- the labels again, and the yardstick (段1の作り 1, 5) -----------------------------------------------

const labelsAgain = async (run: HalfRun, st: ReturnType<typeof newLoadStats>) => {
  const bars: Record<string, Record<LTf, Bars>> = {};
  for (const pair of PAIRS) {
    bars[pair] = {} as Record<LTf, Bars>;
    for (const tf of TFS) {
      const r = await loadTf(src, pair, tf, fromOf(tf), run.half === "H1" && PLANT !== "trackH2" ? SPLIT_MS : END_MS, st, weekendOut);
      bars[pair][tf] = r.bars;
      if (r.bars.n) run.newest = Math.max(run.newest, r.bars.t[r.bars.n - 1] + STEP_OF[tf]);
    }
  }
  const holes = {} as Record<LTf, Set<number>>;
  for (const tf of TFS) holes[tf] = GAPS.commonMissing(PAIRS.map((p) => bars[p][tf]), STEP_OF[tf]);
  let same = 0;
  let differ = 0;
  const ex: string[] = [];
  for (const [pi, pair] of PAIRS.entries()) {
    const mine = run.ems.filter((e) => e.row.pi === pi);
    const Cs = Float64Array.from(mine.map((e) => e.row.C));
    const ahead = mine.map(() => ({}) as Record<LTf, Lab>);
    for (const tf of TFS) {
      const s: Series = seriesOf(tf, bars[pair][tf], holes[tf], GAPS, true);
      const L: Labels = labelsOf(s, Cs.map((C) => C - FINE));
      mine.forEach((e, k) => {
        const got = { state: L.state[k], excl: L.state[k] >= 0 ? L.excl[k] : 9 };
        const want = e.row.lab[tf];
        if (got.state === want.state && got.excl === want.excl) same++;
        else {
          differ++;
          if (ex.length < 6) ex.push(`${pair} ${tf} C ${isoMs(e.row.C)}: file ${STATE_NAMES[want.state] ?? "-"}/${want.excl}, again ${STATE_NAMES[got.state] ?? "-"}/${got.excl}`);
        }
        // one bar further: the window when the next bar in the data after the newest one closed by C has closed
        // (trend.ts's planted oneBarAhead); a label not read at C (no window, or unreadable) stays as it is
        const i = L.bar[k];
        if (i < 0 || L.state[k] < 0 || L.excl[k] !== 0 || i + 1 >= s.bars.n) ahead[k][tf] = got;
        else {
          const r = labelsOf(s, Float64Array.of(s.bars.t[i + 1] + s.step - FINE));
          ahead[k][tf] = { state: r.state[0], excl: r.state[0] >= 0 ? r.excl[0] : 9 };
        }
      });
    }
    mine.forEach((e, k) => {
      e.ahead = CANDS.map((_, c) => verdictOf(c, e.buy, ahead[k]));
    });
  }
  check(`labelsAgain.${run.half}`, differ === 0 && same === run.ems.length * TFS.length, differ, `labels computed again ${same + differ}: the file's ${same}, another ${differ}`, ex);
};

// ---- the measures (段1の作り 2, 3) ---------------------------------------------------------------------

type Measure = "W2" | "PL2" | "W1" | "PL1" | "W3" | "PL3" | "V1D" | "B30";
const MEASURES: Measure[] = ["W2", "PL2", "W1", "PL1", "W3", "PL3", "V1D", "B30"];
const yOf = (e: Em, m: Measure): number | null => {
  if (m === "V1D") return e.v1d;
  // (a)'s v1d carries float error (a −30.0 pips row reads −29.999999999998916): −30 within 1e-9 counts (段1の作り 2)
  if (m === "B30") return e.v1d === null ? null : e.v1d <= -30 + 1e-9 ? 1 : 0;
  const k = m.endsWith("1") ? 0 : m.endsWith("2") ? 1 : 2;
  const r = e.res[k];
  if (!r) return null;
  if (m.startsWith("W")) return r.kind === "open" ? null : r.kind === "tp" ? 1 : 0;
  return r.pips;
};
const itemsOf = (ems: Em[], c: number, m: Measure, verdicts: (e: Em) => number[] = (e) => e.verdict, side?: boolean): Item[] => {
  const out: Item[] = [];
  for (const e of ems) {
    const v = verdicts(e)[c];
    if (v === 0 || (side !== undefined && e.buy !== side)) continue;
    const y = yOf(e, m);
    if (y === null) continue;
    out.push({ s: e.s, kept: v === 1, y, week: e.week });
  }
  return out;
};
const meanOf = (ems: Em[], m: Measure, keep: (e: Em) => boolean) => {
  let n = 0;
  let s = 0;
  for (const e of ems) {
    if (!keep(e)) continue;
    const y = yOf(e, m);
    if (y === null) continue;
    n++;
    s += y;
  }
  return { n, mean: n ? s / n : Number.NaN };
};

interface CandStat {
  cand: string;
  counts: Record<string, { all: number; kept: number; out: number; unread: number }>;
  raw: Record<string, Record<string, { n: number; mean: number }>>; // [measure][col|side]
  delta: Record<string, Delta>; // measure, W2.BUY, W2.SELL
  keptMinusAll: { d: number; lo: number; hi: number; factor: number };
  // week × pair × side as the strata (described): the point only — the strata lie inside the weeks, so the
  // influence values sum to 0 in each week and the clustered error is 0 (no interval)
  weekAdj: { d: number; share: number };
  ahead: Delta | null;
  aheadChanged: number;
  eligible: boolean;
  misses: string[];
}
const COLS: Array<[string, (e: Em, c: number) => boolean]> = [
  ["all", () => true],
  ["kept", (e, c) => e.verdict[c] === 1],
  ["out", (e, c) => e.verdict[c] === -1],
];
const candStat = (ems: Em[], c: number, half: Half, withV1d: boolean): CandStat => {
  const w0 = W0[half];
  const counts: CandStat["counts"] = {};
  for (const side of ["all", "BUY", "SELL"]) {
    const inS = ems.filter((e) => side === "all" || e.row.side === side);
    counts[side] = { all: inS.length, kept: inS.filter((e) => e.verdict[c] === 1).length, out: inS.filter((e) => e.verdict[c] === -1).length, unread: inS.filter((e) => e.verdict[c] === 0).length };
  }
  const raw: CandStat["raw"] = {};
  const ms = MEASURES.filter((m) => withV1d || (m !== "V1D" && m !== "B30"));
  for (const m of ms) {
    raw[m] = {};
    for (const [col, f] of COLS) for (const side of ["all", "BUY", "SELL"]) raw[m][`${col}.${side}`] = meanOf(ems, m, (e) => f(e, c) && (side === "all" || e.row.side === side));
  }
  const delta: Record<string, Delta> = {};
  for (const m of ms) delta[m] = deltaOf(itemsOf(ems, c, m), w0, m === "B30" ? -1 : 1);
  delta["W2.BUY"] = deltaOf(itemsOf(ems, c, "W2", undefined, true), w0);
  delta["W2.SELL"] = deltaOf(itemsOf(ems, c, "W2", undefined, false), w0);
  const dw = delta.W2;
  const factor = dw.nOut / dw.nAll;
  // week × pair × side as the strata (described): a key per stratum and week
  const wItems = itemsOf(ems, c, "W2").map((it) => ({ ...it, s: it.s * 10_000 + (it.week - w0) }));
  const wa = deltaOf(wItems, w0);
  const outW2 = itemsOf(ems, c, "W2").filter((it) => !it.kept).length;
  let ahead: Delta | null = null;
  let aheadChanged = 0;
  if (ems.every((e) => e.ahead)) {
    ahead = deltaOf(itemsOf(ems, c, "W2", (e) => e.ahead!), w0);
    aheadChanged = ems.filter((e) => e.ahead![c] !== e.verdict[c]).length / ems.length;
  }
  const misses = [
    dw.d > 0 ? "" : "δW2≤0",
    delta["W2.BUY"].d > 0 ? "" : "δW2(BUY)≤0",
    delta["W2.SELL"].d > 0 ? "" : "δW2(SELL)≤0",
    delta.PL2.d >= 0 ? "" : "δPL2<0",
    Number.isFinite(dw.t) ? "" : "no t",
  ].filter((x) => x !== "");
  return {
    cand: CANDS[c],
    counts,
    raw,
    delta,
    keptMinusAll: { d: factor * dw.d, lo: factor * dw.lo, hi: factor * dw.hi, factor },
    weekAdj: { d: wa.d, share: outW2 ? wa.nOut / outW2 : Number.NaN },
    ahead,
    aheadChanged,
    eligible: misses.length === 0,
    misses,
  };
};

// the random line of candidate c in a half (段1の作り 4)
const lineFor = (ems: Em[], c: number, half: Half): Line => {
  const comp = ems.filter((e) => e.verdict[c] !== 0);
  const rems: REm[] = comp.map((e) => ({ s: e.s, side: e.buy ? 0 : 1, pi: e.row.pi, day: e.day, week: e.week }));
  const target = new Array<number>(PAIRS.length * 2).fill(0);
  for (const e of comp) if (e.verdict[c] === -1) target[e.s]++;
  const w2 = comp.map((e) => {
    const y = yOf(e, "W2");
    return y === null ? null : { y };
  });
  return lineOf(rems, PAIRS.length, target, w2, W0[half], (k) => removalSeed(SEED, half === "H1" ? 1 : 2, c + 1, k));
};

// ---- the printing -----------------------------------------------------------------------------------------

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "-");
const pips = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}` : "-");
const pts = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(100 * x).toFixed(2)}` : "-");
const dLine = (name: string, d: Delta, points: boolean) => {
  const f = points ? pts : pips;
  return `${name} ${f(d.d)} [${f(d.lo)}, ${f(d.hi)}] t ${Number.isFinite(d.t) ? d.t.toFixed(3) : "-"} (${d.by}, ${d.C} clusters${d.outDropped ? `, left out of δ: ${d.outDropped} left-out emails` : ""})`;
};
const printCand = (st: CandStat, half: Half, withV1d: boolean) => {
  const W = WEEKS[half];
  sayOut(`\n-- ${st.cand} (${half})`);
  for (const side of ["all", "BUY", "SELL"]) {
    const k = st.counts[side];
    sayOut(`  ${side.padEnd(4)} emails: all ${k.all} (${(k.all / W).toFixed(1)}/week), kept ${k.kept} (${(k.kept / W).toFixed(1)}/week), left out ${k.out} (${(k.out / W).toFixed(1)}/week), unreadable ${k.unread}`);
    const cell = (m: string, col: string) => st.raw[m]?.[`${col}.${side}`];
    const row = (label: string, m: string, rate: boolean) => `${label} ${["all", "kept", "out"].map((col) => `${col} ${rate ? pct(cell(m, col).mean) : pips(cell(m, col).mean)} (${cell(m, col).n})`).join(", ")}`;
    sayOut(`    ${row("TP10 first", "W2", true)}`);
    sayOut(`    ${row("pips/trade (TP10)", "PL2", false)}`);
    sayOut(`    ${row("TP4 first", "W1", true)}`);
    sayOut(`    ${row("pips/trade (TP4)", "PL1", false)}`);
    if (withV1d) {
      sayOut(`    ${row("1 day: −30 pips or worse (no stop)", "B30", true)}`);
      sayOut(`    ${row("1 day: mean pips (no stop)", "V1D", false)}`);
    }
    sayOut(`    ${row("TP16 first (described)", "W3", true)}`);
    sayOut(`    ${row("pips/trade (TP16, described)", "PL3", false)}`);
  }
  sayOut(`  ${dLine("δ W2", st.delta.W2, true)}`);
  sayOut(`  ${dLine("δ W2 BUY", st.delta["W2.BUY"], true)}; ${dLine("δ W2 SELL", st.delta["W2.SELL"], true)}`);
  sayOut(`  ${dLine("δ PL2", st.delta.PL2, false)}`);
  sayOut(`  ${dLine("δ W1", st.delta.W1, true)}; ${dLine("δ PL1", st.delta.PL1, false)}`);
  if (withV1d) sayOut(`  ${dLine("δ v1d", st.delta.V1D, false)}; ${dLine("δ B30 (left out − kept)", st.delta.B30, true)}`);
  sayOut(`  kept − all (W2, by stratum): ${pts(st.keptMinusAll.d)} [${pts(st.keptMinusAll.lo)}, ${pts(st.keptMinusAll.hi)}] (× ${st.keptMinusAll.factor.toFixed(4)} of δ)`);
  sayOut(`  δ W2 by week × pair × side (described; the point only) ${pts(st.weekAdj.d)}; left-out emails in the cells used ${pct(st.weekAdj.share)}`);
  if (st.ahead) sayOut(`  yardstick: δ W2 with the labels one bar further ${pts(st.ahead.d)} (verdicts changed ${pct(st.aheadChanged)}; look-ahead would look like this)`);
  sayOut(`  can be chosen: ${st.eligible ? "yes" : `no (${st.misses.join(", ")})`}`);
};

// §8.106 11 数字の後: the signs to look for look-ahead before any report
const triggersOf = (stats: CandStat[]): string[] => {
  const out: string[] = [];
  for (const st of stats) {
    const k = (m: string, col = "kept", side = "all") => st.raw[m]?.[`${col}.${side}`]?.mean ?? Number.NaN;
    if (k("W2") >= 0.8) out.push(`${st.cand}: kept W2 ${pct(k("W2"))} (80% or more)`);
    if (k("W1") >= 0.9) out.push(`${st.cand}: kept W1 ${pct(k("W1"))} (90% or more)`);
    if (Math.abs(st.delta.W2.d) >= 0.1) out.push(`${st.cand}: |δ W2| ${pts(st.delta.W2.d)} points (10 or more)`);
    for (const col of ["all", "kept", "out"]) for (const side of ["all", "BUY", "SELL"]) if (k("PL2", col, side) >= 3) out.push(`${st.cand}: PL2 ${col} ${side} ${pips(k("PL2", col, side))} (+3 or more)`);
    for (const m of ["W1", "W2", "W3", "B30"]) for (const col of ["all", "kept", "out"]) for (const side of ["all", "BUY", "SELL"]) if (st.raw[m] && k(m, col, side) === 1) out.push(`${st.cand}: ${m} ${col} ${side} 100%`);
  }
  return out;
};

// ---- a half's analysis --------------------------------------------------------------------------------

interface HalfOut {
  stats: CandStat[];
  triggers: string[];
}
const analyse = (run: HalfRun, withV1d: boolean, usable: boolean[]): HalfOut => {
  const stats = CANDS.map((_, c) => candStat(run.ems, c, run.half, withV1d));
  stats.forEach((st, c) => {
    if (!usable[c]) st.eligible = false, st.misses.push("floors (§8.106 6)");
  });
  return { stats, triggers: triggersOf(stats) };
};
const chooseOf = (stats: CandStat[]): number => {
  let best = -1;
  stats.forEach((st, c) => {
    if (!st.eligible) return;
    if (best < 0) return void (best = c);
    const b = stats[best];
    const t = st.delta.W2.t;
    const tb = b.delta.W2.t;
    if (t > tb || (t === tb && st.counts.all.kept > b.counts.all.kept)) best = c;
  });
  return best;
};
const SENTENCE_CHOSEN = (name: string) => `選んだのは${name}です。4つから良いものを選んだので、この数字は良く見えやすく、判断には使いません。`;
const SENTENCE_NONE = "前半で、4つのどれも決めた条件を満たしませんでした。ここで終わります。流れの条件で良くなるものは見つかりませんでした。メールは今のままです。";
const NAME_JA = ["①（1時間足のダウが逆向きなら出さない）", "②（4時間足のダウが逆向きなら出さない）", "③（1時間足と4時間足の両方が逆向きなら出さない）", "④（15分足のダウが逆向きなら出さない）"];

// §8.106 8 on H2, the candidate taken as chosen: the conditions and the sentence
const judgeH2 = (st: CandStat, line: Line, checksOk: boolean, triggers: string[], withV1d: boolean) => {
  const k = (m: string, col: string) => st.raw[m][`${col}.all`].mean;
  const c1 = Number.isFinite(st.delta.W2.t) && st.delta.W2.t > line.line && k("W2", "kept") > k("W2", "all");
  const c2 = st.delta.PL2.d >= 0 && k("PL2", "kept") >= k("PL2", "all") && k("W1", "kept") >= k("W1", "all") && k("PL1", "kept") >= k("PL1", "all");
  const c3 = withV1d ? st.delta.V1D.d >= 0 && st.delta.B30.d >= 0 : true;
  const c4 = st.delta["W2.BUY"].d > 0 && st.delta["W2.SELL"].d > 0;
  const c5 = checksOk && triggers.filter((x) => x.startsWith(st.cand)).length === 0;
  const sentence = c1 && c2 && c3 && c4 && c5 ? "adopt" : st.delta.W2.hi < 0 ? "bad" : c1 && !(c2 && c3 && c4) ? "partBad" : "cannot";
  return { c1, c2, c3, c4, c5, sentence };
};

// ---- the run ------------------------------------------------------------------------------------------

const emailsCsv = (ems: Em[]) =>
  ["T,pair,side,late,C,half,E,bidC,askC,k4,p4,k10,p10,k16,p16,v1d,v1,v2,v3,v4,a1,a2,a3,a4"].concat(ems.map((e) =>
    [isoMs(e.row.T), e.row.pair, e.row.side, e.row.late ? 1 : 0, isoMs(e.row.C), e.row.half, e.E, e.bidC, e.askC, ...e.res.flatMap((r) => [r.kind, r.pips]), e.v1d ?? "", ...e.verdict, ...(e.ahead ?? ["", "", "", ""])].join(",")
  )).join("\n") + "\n";

const main = async () => {
  await Deno.mkdir(OUT, { recursive: true });
  // the labels file and (a) first: another sha256 stops the run before any bar is read (§8.106 6)
  const labelsText = await Deno.readTextFile(LABELS);
  const labelsHash = await sha256Hex(labelsText);
  if (!SYN && labelsHash !== TREND_LABELS_SHA256) throw new Error(`${LABELS}: sha256 ${labelsHash}, not the stage-0 labels' ${TREND_LABELS_SHA256}: nothing computed`);
  let aText = "";
  if (!SYN) {
    aText = await Deno.readTextFile(A_CSV);
    const aHash = await sha256Hex(aText);
    if (aHash !== A_SHA256) throw new Error(`${A_CSV}: sha256 ${aHash}, not (a)'s ${A_SHA256}: nothing computed`);
  }
  if (ULTRA_PAIRS.sl !== 13 || ULTRA_PAIRS.tp1 !== 4 || ULTRA_PAIRS.tp2 !== 10 || ULTRA_PAIRS.tp3 !== 16) throw new Error("ULTRA_PAIRS is not the stop 13 and TP 4/10/16 (§8.106 3)");
  if (!SYN && Date.now() < SPLIT_MS) throw new Error("the split is in the future");
  const rows = parseLabels(labelsText);
  say(`MODE ${MODE}${PLANT ? ` PLANT ${PLANT}` : ""}${SYN ? ` SEED ${SEED}${ANSWER ? " ANSWER" : ""} (${WALK_DIR})` : ""}; labels ${rows.length} rows, sha256 ${labelsHash}; H1 ${rows.filter((r) => r.half === "H1").length}, H2 ${rows.filter((r) => r.half === "H2").length}`);

  // hand-made checks of the pieces
  const fh = followHand();
  check("followHand", fh.bad.length === 0, fh.bad.length, `${fh.n} hand-made trades`, fh.bad);
  const dh = deltaHand();
  check("deltaHand", dh.bad.length === 0, dh.bad.length, `${dh.n} hand-made sums (δ, its error, kept − all, the clusters, t, mulberry32)`, dh.bad);
  verdictHand();
  const floors = floorsOf(rows);
  const usable = CANDS.map((n) => floors[`H1|${n}`].length === 0 && floors[`H2|${n}`].length === 0);
  check("floors", SYN || usable.every(Boolean), usable.filter((u) => !u).length, `§8.106 6 from the labels file: ${CANDS.map((n, c) => `${n} ${usable[c] ? "met" : `not met (${[...floors[`H1|${n}`].map((x) => `H1 ${x}`), ...floors[`H2|${n}`].map((x) => `H2 ${x}`)].join(", ")})`}`).join("; ")}`);

  const st = newLoadStats();
  // ---- H1 ----
  const h1 = await readHalf("H1", rows, st);
  await labelsAgain(h1, st);
  if (!SYN) {
    // (a)'s 1-day values, each H1 email one row
    const aRows = aText.split("\n").filter((l) => l !== "").slice(1).map((l) => l.split(","));
    const byKey = new Map<string, Array<{ P: number; v: number }>>();
    for (const c of aRows) {
      const k = keyOf(Date.parse(c[0]), c[1], c[2]);
      byKey.set(k, [...(byKey.get(k) ?? []), { P: Date.parse(c[3]), v: Number(c[5]) }]);
    }
    let bad = 0;
    let late = 0;
    for (const e of h1.ems) {
      const v = byKey.get(keyOf(e.row.T, e.row.pair, e.row.side)) ?? [];
      if (v.length !== 1 || !Number.isFinite(v[0].v)) bad++;
      else {
        e.v1d = v[0].v;
        // §8.106 5: P + 24 hours before the split as well
        if (!(v[0].P + DAY <= SPLIT_MS)) late++;
      }
    }
    check("aFile", bad === 0 && late === 0, bad + late, `(a)'s rows: ${aRows.length}; H1 emails without exactly one row ${bad}; with P + 24 hours after the split ${late}`);
  }
  if (ANSWER) answerLabels(h1);
  h1OnlyCheck(h1, rows);
  fiveHolesCheck(h1);
  lookBehindCheck(h1);
  // an email not followed for 1,440 bars has failed h1Only (the run stops there); a planted run goes on without it
  h1.ems = h1.ems.filter((e) => e.res.every((r) => r !== null));
  const o1 = analyse(h1, !SYN, usable);
  const chosen = chooseOf(o1.stats);
  // H1's random line: the chosen candidate's (described); on the walks every candidate's, for the Python
  const lines1: Array<Line | null> = CANDS.map((_, c) => (c === chosen || SYN ? lineFor(h1.ems, c, "H1") : null));
  const line1 = chosen >= 0 ? lines1[chosen] : null;
  lines1.forEach((l, c) => {
    if (l) check(`randomCounts.H1.${c + 1}`, l.missed === 0, l.missed, `${CANDS[c]}: ${KINDS.length} kinds × 500 removals, missing a stratum's count ${l.missed}; standard error not over 0 ${l.noSe}`);
  });
  if (!SYN) await tfWinrateCheck(h1);

  // ---- H2 (the walks only) ----
  let h2: HalfRun | null = null;
  let o2: HalfOut | null = null;
  const lines2: Line[] = [];
  if (SYN) {
    h2 = await readHalf("H2", rows, st);
    if (ANSWER) answerLabels(h2);
    h2Check(h2, rows);
    fiveHolesCheck(h2);
    h2.ems = h2.ems.filter((e) => e.res.every((r) => r !== null));
    o2 = analyse(h2, false, usable);
    for (let c = 0; c < CANDS.length; c++) {
      const l = lineFor(h2.ems, c, "H2");
      lines2.push(l);
      check(`randomCounts.H2.${c + 1}`, l.missed === 0, l.missed, `${CANDS[c]}: 4 × 500 removals, missing a stratum's count ${l.missed}`);
    }
  }
  check("loads", st.failed === 0, st.failed, `requests ${st.requests}, kept files ${st.cached}, failed ${st.failed}`, st.failedExamples);

  // ---- the checks, then the numbers ----
  say("\n== checks");
  for (const [k, c] of Object.entries(checks)) {
    say(`${c.ok ? "ok  " : "FAIL"} ${k}: ${c.detail}`);
    for (const e of c.examples) say(`       ${e}`);
  }
  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k);
  await Deno.writeTextFile(`${OUT}/checks.json`, JSON.stringify({ mode: MODE, plant: PLANT, seed: SEED, answer: ANSWER, failed, checks, labels: { rows: rows.length, sha256: labelsHash } }, null, 1));
  if (failed.length && !PLANT) {
    say(`\nchecks failed: ${failed.join(", ")} — no numbers are written`);
    Deno.exit(1);
  }

  sayOut(`\n== H1 (${isoMs(START_MS)} .. ${isoMs(SPLIT_MS)}, ${WEEKS.H1.toFixed(1)} weeks): ${h1.ems.length} emails`);
  const unread = (c: number) => h1.ems.filter((e) => e.verdict[c] === 0).length;
  const decided = h1.ems.filter((e) => e.res[1].kind !== "open").length;
  sayOut(`counts: H1 emails ${h1.ems.length} = compared + unreadable (${CANDS.map((n, c) => `${n} ${h1.ems.length - unread(c)} + ${unread(c)}`).join(", ")}); TP10 decided ${decided} + undecided ${h1.ems.length - decided}`);
  for (const s of o1.stats) printCand(s, "H1", !SYN);
  sayOut(`\nchosen: ${chosen >= 0 ? CANDS[chosen] : "none"}`);
  sayOut(chosen >= 0 ? SENTENCE_CHOSEN(NAME_JA[chosen]) : SENTENCE_NONE);
  if (line1) sayOut(`its t ${o1.stats[chosen].delta.W2.t.toFixed(3)}; H1's random line ${line1.line.toFixed(3)} (each kind's 97.5% point: ${KINDS.map((k, i) => `${k} ${line1.kinds[i].toFixed(3)}`).join(", ")}; described, not used to choose)`);
  sayOut(`signs to look into before a report (§8.106 11): ${o1.triggers.length ? o1.triggers.join("; ") : "none"}`);

  const result = {
    mode: MODE,
    seed: SEED,
    plant: PLANT,
    answer: ANSWER,
    labelsSha256: labelsHash,
    floors,
    H1: { stats: o1.stats, chosen, line: line1, lines: lines1, triggers: o1.triggers },
    H2: o2 ? { stats: o2.stats, lines: lines2, triggers: o2.triggers } : null,
  };
  await Deno.writeTextFile(`${OUT}/result.json`, JSON.stringify(result, (_, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v), 1));
  await Deno.writeTextFile(`${OUT}/emails.csv`, emailsCsv([...h1.ems, ...(h2?.ems ?? [])]));
  if (!SYN) {
    const choice = {
      stage: 1,
      chosen: chosen >= 0 ? CANDS[chosen] : null,
      labelsSha256: labelsHash,
      aSha256: A_SHA256,
      H1: o1.stats.map((s) => ({ cand: s.cand, dW2: s.delta.W2.d, dW2Buy: s.delta["W2.BUY"].d, dW2Sell: s.delta["W2.SELL"].d, dPL2: s.delta.PL2.d, t: s.delta.W2.t, eligible: s.eligible, misses: s.misses })),
    };
    await Deno.writeTextFile(`${OUT}/trend-choice.json`, JSON.stringify(choice, null, 1) + "\n");
  }
  if (SYN && h2 && o2) {
    const ok = failed.length === 0;
    say(`\n== H2 (the walk; every candidate taken through §8.106 8 as if chosen)`);
    const per = o2.stats.map((s, c) => {
      const j = judgeH2(s, lines2[c], ok, o2!.triggers, false);
      const adopt = usable[c] && o1.stats[c].eligible && j.sentence === "adopt";
      const raw = (side: string) => ({ kept: s.raw.W2[`kept.${side}`].mean, out: s.raw.W2[`out.${side}`].mean });
      say(`${s.cand}: ${dLine("δ W2", s.delta.W2, true)}; line ${lines2[c].line.toFixed(3)}; H1 can be chosen ${o1.stats[c].eligible}; 1 ${j.c1} 2 ${j.c2} 3 ${j.c3} 4 ${j.c4} 5 ${j.c5} -> ${j.sentence}${adopt ? " (adopted)" : ""}; raw W2 kept/out BUY ${pct(raw("BUY").kept)}/${pct(raw("BUY").out)} SELL ${pct(raw("SELL").kept)}/${pct(raw("SELL").out)}`);
      return { cand: s.cand, d: s.delta.W2.d, lo: s.delta.W2.lo, hi: s.delta.W2.hi, t: s.delta.W2.t, line: lines2[c].line, h1Eligible: o1.stats[c].eligible, floors: usable[c], ...j, adopt, rawBuy: raw("BUY"), rawSell: raw("SELL") };
    });
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify({ seed: SEED, walk: WALK_DIR, answer: ANSWER, failed, H1chosen: chosen, H2: per }, null, 1));
  }
  await Deno.writeTextFile(`${OUT}/print.txt`, lines.join("\n") + "\n");
};

// the answer-knowing label (段1の作り 8): the 1-hour label replaced by the mid's direction from C to C + 4 hours
// (the newest 5-minute bar closed by each)
const answerLabels = (run: HalfRun) => {
  for (const e of run.ems) {
    const f = run.fines[e.row.pi];
    const at = (t: number) => lowerBound(f.t, t - 5 * MINUTE + 1) - 1;
    const a = at(e.row.C);
    const b = at(e.row.C + 4 * HOUR);
    if (a < 0 || b < 0) throw new Error("the answer label: no bar");
    const m0 = (f.bc[a] + f.ac[a]) / 2;
    const m1 = (f.bc[b] + f.ac[b]) / 2;
    e.row.lab["1h"] = { state: m1 > m0 ? 1 : m1 < m0 ? 2 : 0, excl: 0 };
    e.verdict = CANDS.map((_, c) => verdictOf(c, e.buy, e.row.lab));
  }
};

// tfWinrate (段1の作り 2): tf-winrate.ts run to the split on the same bars — its 15-minute ULTRA trades at TP 4,
// 10 and 16 the same as H1's emails' (counts the same, the mean pips to 1e-9), its signals per pair the same
const tfWinrateCheck = async (h1: HalfRun) => {
  const bad: string[] = [];
  let tfw: Record<string, unknown>;
  try {
    tfw = JSON.parse(await Deno.readTextFile(TFW_JSON));
  } catch {
    check("tfWinrate", false, 1, `no ${TFW_JSON}`);
    return;
  }
  if (Date.parse(String(tfw.now).replace(" ", "T") + "Z") !== SPLIT_MS) bad.push(`tf-winrate now ${tfw.now} (want the split)`);
  if (tfw.start !== "2024-01-01" || tfw.split !== "2025-05-19" || tfw.sl !== 13 || tfw.weekend !== "inside" || tfw.synthetic) bad.push(`tf-winrate settings ${JSON.stringify({ start: tfw.start, split: tfw.split, sl: tfw.sl, weekend: tfw.weekend, synthetic: tfw.synthetic })}`);
  if (JSON.stringify(tfw.pairs) !== JSON.stringify(PAIRS)) bad.push(`tf-winrate pairs ${JSON.stringify(tfw.pairs)}`);
  const tables = tfw.tables as Record<string, Record<string, Record<string, { n: number; tp: number; sl: number; amb: number; open: number; pips: number | null }>>>;
  TPS.forEach((tp, k) => {
    const th = tables?.all?.["15min"]?.[`ultra-tp${k + 1}`];
    const me = { n: h1.ems.length, tp: 0, sl: 0, amb: 0, open: 0, pips: 0 };
    for (const e of h1.ems) {
      me[e.res[k].kind]++;
      me.pips += e.res[k].pips;
    }
    me.pips /= me.n;
    if (!th) return void bad.push(`TP${tp}: no table`);
    for (const f of ["n", "tp", "sl", "amb", "open"] as const) if (th[f] !== me[f]) bad.push(`TP${tp} ${f}: tf-winrate and here differ`);
    if (th.pips === null || Math.abs(th.pips - me.pips) > 1e-9) bad.push(`TP${tp} pips: differ by more than 1e-9`);
  });
  const cov = (tfw.coverage as Array<{ pair: string; tf: string; ultra: number; failed: number }>).filter((c) => c.tf === "15min");
  for (const c of cov) {
    const pi = (PAIRS as readonly string[]).indexOf(c.pair);
    if (pi < 0 || h1.sigsUpTo[pi] !== c.ultra) bad.push(`${c.pair}: tf-winrate's 15-minute ULTRA signals and here differ`);
  }
  if (cov.length !== PAIRS.length) bad.push(`tf-winrate's 15-minute coverage: ${cov.length} pairs`);
  const ck = (tfw.check as Record<string, { compared: number; mismatched: number }> | undefined)?.["15min"];
  if (!ck || ck.mismatched !== 0 || !(ck.compared > 0)) bad.push("tf-winrate's own check of its 15-minute signals");
  const tfFailed = (tfw.coverage as Array<{ failed?: number }>).reduce((a, c) => a + (c.failed ?? 0), 0);
  if (tfFailed !== 0) bad.push(`tf-winrate GMO reads failed: ${tfFailed}`);
  check("tfWinrate", bad.length === 0, bad.length, `tf-winrate (to the split) against H1's ${h1.ems.length} emails at TP 4, 10 and 16`, bad);
};

if (MODE === "calib") await (await import("./trend1-calib.ts")).calib(env("CALIB_DIR", "research/out/trend1/calib"));
else await main();
