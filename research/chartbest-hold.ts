// #318 (docs §8.113 9, 13, 14, 21; plan §3.12): the owner's way (オーナーの持ち方) of stage 2 — §8.102's way of holding
// (limit at E, TP 10 pips, no stop, no time limit, 10,000 units, Rakuten's 25x account of 300,000 yen, margin calls
// paid in up to 1,000,000 yen) run on the K_total chosen items and the two emails through research/ownerhold.ts's own
// analyse() (9「§8.111 の決まりのまま」「合図の元だけを…替える」).
//
// research/ownerhold.ts is a program: its top level runs the mode its MODE names (synthetic by default). It is imported
// here only dynamically, once, with MODE set to a name no mode has and SIGS, START, END, SPLIT and the other knobs it
// reads at import cleared (given back after), so its top level defines its functions and runs nothing (checked: the
// import alone writes no file and prints nothing). The specifier is computed, so `deno check` does not follow it:
// research/ownerhold-account.ts, which it imports, does not type-check under the CI's Deno (it is never type-checked
// in its own CI); the shapes used here are written out below (OhAnalysis …) and read back from the files it writes.
// Its chart follows SIGS at import (the 15-minute chart when SIGS is unset); of what analyse() computes, only its own
// signalProbe check reads SIGS (its 'looked'), and that check compares nothing here (the reads carry no probe): holdOne
// lists it as SKIP (gates-03).
// Every place the chart's step matters is given here: the signals' T, base and P (5-minute bars: T = open + 5 min, a
// late ULTRA signal's base the next bar's close, P = base + 2 min) and the dump's meta.json step 5, by which
// ownerhold-check.py checks T, base and E against the 5-minute bars (hold.*.step5 checks both here).
//
// Two accounts per source (9, SQ-27): the full account (every signal passing ① and ② with START ≤ T < END, from
// START, split SPLIT) and the second-half account (SPLIT ≤ T < END, from SPLIT with 300,000 yen, split SPLIT).
// Each writes $OUT/hold/<src>-<acct>/: dump/ (ownerhold.ts writeDump's files, the Python's --hold input), decisions.txt,
// analysis.json, held.json (ownerhold.ts heldSummary's numbers), lines.json (the account lines, the per-email view,
// E*, M, ③, the verdicts ①②③, the suspicious rows of 13, the facts of the sentences) and suspect-trades.csv (13 ②).

import { DAY, MINUTE } from "./lib.ts";
import { type LoadStats, type M1, type Sig, type SignalRead, newLoadStats, pOf, unitOf } from "./ownerhold-data.ts";
import { quantile } from "./money-stats.ts";
import { parseBisPolicy, rateBefore } from "./longhist-lib.ts";
import { ULTRA_PAIRS, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import type { PairBars } from "./chartbest-bars.ts";
import { type Dir, HOLD_PRINT, PAIRS, type Period, SPEC, STEP, SYNTH_RATES, holdPrintKeys, pairKeyOf } from "./chartbest-const.ts";
import type { SigRec } from "./chartbest-events.ts";
import { type LateSig, lateMailed } from "./chartbest-measures.ts";
import type { LoadDiag } from "./chartbest-data.ts";
import { type HoldFacts, type HoldRowFacts, type Placed, ROWS4, type Row4, holdVerdictOf, placedCountOf } from "./chartbest-text.ts";

// ---- the shapes of research/ownerhold.ts used here (structural; ownerhold.ts's own types are not imported) ----------

export interface OhCtx {
  start: number;
  end: number;
  split: number;
  startYen: number;
  cap: number;
}
export type Rates = (area: string, tau: number) => number | null;
export interface OhDataSet {
  name: string;
  m1s: M1[];
  sigs: Sig[];
  reads: SignalRead[];
  load: LoadStats;
  src: null;
  rates: Rates;
}
interface OhSub {
  n: number;
  tp: number;
  winRate: number | null;
  pips: number | null;
  yen: number | null;
}
// research/ownerhold-report.ts's quantiles (money-stats quantile) and its TP-within shares
export interface OhQ {
  n: number;
  median: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}
export interface OhWithin {
  of: number;
  tp: number;
  share: number | null;
}
type OhSubOut = OhSub & { outcomes?: Record<string, number> };
export interface OhLine {
  inEnd: number;
  A: number;
  B: number;
  S: number;
  lcs: number;
  deadlines: number;
  capped: number;
  calls: number;
  callEnds?: Record<string, number>;
  deposits: number;
  depositTotal: number;
  // the first deposit after which the money put in reached 500,000 / 1,000,000 yen (−Infinity: the start had it)
  reached50?: number | null;
  reached100?: number | null;
  maxDrawdown?: number;
  fates: Record<string, number>;
  fatesHalves: [Record<string, number>, Record<string, number>];
  winRate: number | null;
  outcomes: Record<string, number>;
  pips: number | null;
  yen: number | null;
  path?: { byHalf: [OhSubOut, OhSubOut]; byPair: Record<string, OhSubOut>; mae?: { tp: OhQ; notTp: OhQ }; maeYen?: { tp: OhQ; notTp: OhQ }; tpWithin?: Record<string, OhWithin> };
  [k: string]: unknown;
}
export interface OhPerEmail extends OhSub {
  emails: number;
  filled: number;
  held: number;
  unfilled?: number;
  mae?: { tp: OhQ; notTp: OhQ };
  maeYen?: { tp: OhQ; notTp: OhQ };
  tpWithin?: Record<string, OhWithin>;
  [k: string]: unknown;
}
export interface OhThird {
  n: number;
  main: number | null;
  L: number | null;
  plain: number | null;
  [k: string]: unknown;
}
export interface OhTrade {
  sig: number;
  pi: number;
  dir: 1 | -1;
  t0: number;
  fill: number;
  x: number;
  exit: number;
  how: string;
}
export interface OhCall {
  tau: number;
  end: string;
  endAt: number;
  uAfterDeposit: number | null;
}
export interface OhAccountOut {
  trades: OhTrade[];
  lcs: Array<{ at: number }>;
  calls: OhCall[];
  mSplit: number;
  mEnd: number;
  estar: { value: number } | null;
}
export interface OhAnalysis {
  name: string;
  signals: Record<string, unknown>;
  third: { main: OhThird; [k: string]: unknown };
  perEmail: Record<string, { all: OhPerEmail; first: OhPerEmail; second: OhPerEmail; byPair: Record<string, OhPerEmail> }>;
  accounts: Record<string, OhLine>;
  estar: Record<string, { estar: { value: number } | null }>;
  m: Record<string, { M1: number; M2: number }>;
  extra: Record<string, unknown>;
  checks: Record<string, { ok: boolean; detail: unknown; n?: number; why?: string }>;
  decisions: string[];
  dump: Record<string, string>;
  raw?: { outs: Record<string, OhAccountOut>; unl: Record<string, OhAccountOut> };
}
export interface OwnerHold {
  analyse: (ds: OhDataSet, ctx: OhCtx, parts: "third" | "all", plant?: string) => OhAnalysis;
  writeDump: (dir: string, a: OhAnalysis, ctx: OhCtx, extra?: Record<string, unknown>) => Promise<void>;
}

// ---- the inert import of research/ownerhold.ts ---------------------------------------------------------------

// a MODE no mode of ownerhold.ts has: its top level defines its functions and runs nothing
export const INERT_MODE = "chartbest-inert";
// what ownerhold.ts reads from the environment at import (cleared for the import, given back after it)
const IMPORT_ENV = ["MODE", "SIGS", "START", "END", "SPLIT", "OUT", "PLANT", "PLANTS", "SETS", "SEEDS", "FULL", "CACHE_DIR", "BIS_CSV", "END_B", "LEDGER", "A_CSV"];
let ohMod: OwnerHold | null = null;
export const ownerholdInert = async (): Promise<OwnerHold> => {
  if (ohMod) return ohMod;
  const kept = new Map<string, string | undefined>(IMPORT_ENV.map((k) => [k, Deno.env.get(k)]));
  for (const k of IMPORT_ENV) Deno.env.delete(k);
  Deno.env.set("MODE", INERT_MODE);
  try {
    const spec = "./" + "ownerhold.ts";
    const m = (await import(spec)) as Partial<OwnerHold>;
    if (typeof m.analyse !== "function" || typeof m.writeDump !== "function") throw new Error("research/ownerhold.ts exports no analyse / writeDump");
    ohMod = m as OwnerHold;
  } finally {
    for (const [k, v] of kept) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
  return ohMod;
};

// ---- the signal lists (9: START ≤ T < END, ① and ② passed, ③ and ④ not applied; SQ-27: the second half by T) ------

export const DELAY = 2;
// an email's P (9: T + 2 min; a late ULTRA signal's base + 2 min, §8.111 3)
export const pOfSig = (s: Sig): number => pOf(s, DELAY);
export const START_YEN = 300_000;
export const CAP_YEN = 1_000_000;
export type Account = "full" | "h2";
export const ACCOUNTS: readonly Account[] = ["h2", "full"];

const sideOf = (d: Dir): "BUY" | "SELL" => (d === 1 ? "BUY" : "SELL");
// an email as §8.111's readers make it: E the bar's rounded mid close (the record's), TP2 = E ± 10 pips (ultraLevels)
const sigOf = (pb: PairBars, i: number, dir: Dir, E: number, late: boolean, base: number): Sig => {
  const side = sideOf(dir);
  return { pair: pb.pair, pi: pb.pi, side, dir, open: pb.t[i], T: pb.t[i] + STEP, E, tp: ultraLevels(side, E, unitOf(pb.pair), ULTRA_PAIRS).tps[1], late, base, bidC: pb.bc[i], askC: pb.ac[i] };
};
// The signals one account of one source runs on: the records passing ① (T in the period, past the warm-up) and ② (sent),
// with from ≤ T < to; the ULTRA late signals mailed with the next bar's read (base = that bar's close; §8.102 (a), §8.111
// 2: within the 10-minute freshness, outside isPossiblyClosed). Ordered as ownerhold.ts orders its emails: by P (base + 2
// min), Rakuten's pair order, BUY first (then the bar's open, which only orders a late and an on-time signal of one pair,
// side and P the way ownerhold.ts's stable sort keeps them).
export const holdSigsOf = (recs: readonly SigRec[], late: readonly LateSig[], bars: readonly PairBars[], from: number, to: number): Sig[] => {
  const out: Sig[] = [];
  for (const r of recs) {
    if (r.reason === "r1" || r.reason === "r2" || r.T < from || r.T >= to) continue;
    out.push(sigOf(bars[r.pi], r.i, r.dir, r.E, false, r.T));
  }
  for (const l of late) {
    const pb = bars[l.pi];
    if (l.T < from || l.T >= to || !lateMailed(pb, l)) continue;
    out.push(sigOf(pb, l.i, l.dir, pb.mc[l.i], true, pb.t[l.i + 1] + STEP));
  }
  out.sort((a, b) => pOf(a, DELAY) - pOf(b, DELAY) || a.pi - b.pi || b.dir - a.dir || a.open - b.open);
  return out;
};

// the reads analyse() lists per pair (its own probes are §8.111's sweep checks; here the sources' checks are 20 (b)'s —
// measure.ultra.vsSignalsOf / measure.macd.vsReadOf and the items' look-ahead checks — so these carry none)
const NO_PROBE = () => ({ compared: 0, mismatched: 0, examples: [] as string[] });
export const readsOf = (bars: readonly PairBars[], sigs: readonly Sig[], from: number, to: number): SignalRead[] =>
  bars.map((pb) => {
    const mine = sigs.filter((s) => s.pi === pb.pi);
    let judged = 0;
    for (let k = 0; k < pb.n; k++) if (pb.t[k] + STEP >= from && pb.t[k] + STEP < to) judged++;
    return {
      pair: pb.pair, bars: pb.n, first: pb.n ? new Date(pb.t[0]).toISOString() : null, last: pb.n ? new Date(pb.t[pb.n - 1]).toISOString() : null,
      judged, noWindow: 0, bar600: null, signals: mine, unmailed: 0, lateUnmailed: 0, late: mine.filter((s) => s.late).length,
      check: NO_PROBE(), checkLate: NO_PROBE(), cut: null,
    };
  });

// ---- the data set -------------------------------------------------------------------------------------------------

// the 1-minute bars an account reads (ownerhold.ts loadM1's window: opened at or after its start − 1 day, closed by END)
export const m1Window = (m: M1, from: number, to: number): M1 => {
  let a = 0;
  while (a < m.n && m.t[a] < from) a++;
  let b = m.n;
  while (b > a && m.t[b - 1] + MINUTE > to) b--;
  const cut = (xs: Float64Array) => xs.subarray(a, b);
  return { pair: m.pair, n: b - a, t: cut(m.t), bo: cut(m.bo), bh: cut(m.bh), bl: cut(m.bl), bc: cut(m.bc), ao: cut(m.ao), ah: cut(m.ah), al: cut(m.al), ac: cut(m.ac) };
};
// the reads' counts in ownerhold-data's shape (the 1-minute reads of chartbest-data's loader; 20 (a) checks them)
export const loadStatsOf = (diags: readonly LoadDiag[]): LoadStats => {
  const st = newLoadStats();
  for (const d of diags) {
    if (d.interval !== "1min") continue;
    st.files += d.files;
    st.cached += d.files;
    st.failed += d.failed;
    st.oneSide += d.oneSide;
    st.crossed += d.crossed;
    st.closure += d.closure;
    st.repeated += d.dup;
  }
  return st;
};
// the made-up rates (ownerhold.ts's walks, ownerhold-check.py SYNTH_RATES); real data: the BIS policy rates a month late
export const synthRates: Rates = (area) => (SYNTH_RATES as Record<string, number>)[area] ?? null;
export const bisRates = async (path: string): Promise<Rates> => {
  const monthly = parseBisPolicy(await Deno.readTextFile(path), ["US", "JP", "XM", "AU"]);
  return (a, tau) => rateBefore(monthly[a] ?? [], new Date(tau).toISOString().slice(0, 10));
};
export const ctxOf = (p: Pick<Period, "start" | "split" | "end">, account: Account): OhCtx =>
  account === "full" ? { start: p.start, end: p.end, split: p.split, startYen: START_YEN, cap: CAP_YEN } : { start: p.split, end: p.end, split: p.split, startYen: START_YEN, cap: CAP_YEN };

// ---- ownerhold.ts heldSummary (a copy: it is not exported), on a dump's own files ------------------------------------

const csvRowsOf = (text: string): Array<Record<string, string>> => {
  const [h, ...rows] = text.trim().split("\n");
  const cols = h.split(",");
  return rows.filter((r) => r !== "").map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
};
const quantileOf = (xs: number[], q: number): number | null => quantile(xs, q);
export const heldSummary = async (dump: string) => {
  const meta = JSON.parse(await Deno.readTextFile(`${dump}/meta.json`)) as { end: number };
  const paths = csvRowsOf(await Deno.readTextFile(`${dump}/paths-main.csv`));
  const P = new Map(paths.map((r) => [Number(r.i), Number(r.P)]));
  const out: Record<string, unknown> = {};
  for (const row of ["main", "mainSwap"]) {
    const trades = csvRowsOf(await Deno.readTextFile(`${dump}/acct-${row}-trades.csv`));
    const by = (how: string) => trades.filter((t) => t.how === how);
    const held = by("held");
    const heldYen = held.map((t) => Number(t.yen));
    const waits = by("tp").map((t) => (Number(t.x) - P.get(Number(t.sig))!) / (60 * MINUTE));
    const heldDays = held.map((t) => (meta.end - P.get(Number(t.sig))!) / DAY);
    out[row] = {
      trades: trades.length,
      byHow: { tp: by("tp").length, lc: by("lc").length, deadline: by("deadline").length, held: held.length },
      heldAtEnd: {
        n: held.length,
        floatingYenNoSwapSum: heldYen.reduce((a, b) => a + b, 0),
        floatingYenNoSwapWorst: heldYen.length ? Math.min(...heldYen) : null,
        swapYenSum: held.reduce((a, t) => a + Number(t.swapYen), 0),
        inLoss: heldYen.filter((v) => v < 0).length,
        heldDays: { median: quantileOf(heldDays, 0.5), p90: quantileOf(heldDays, 0.9), max: heldDays.length ? Math.max(...heldDays) : null },
      },
      hoursToTakeProfit: { n: waits.length, median: quantileOf(waits, 0.5), p90: quantileOf(waits, 0.9), max: waits.length ? Math.max(...waits) : null },
    };
  }
  return out;
};
// ownerhold.ts MODE=heldprint's check: each row's trades by how they ended are the account line's own counts
export const heldAgainstLines = (held: Record<string, unknown>, a: OhAnalysis): string[] => {
  const bad: string[] = [];
  for (const row of ["main", "mainSwap"]) {
    const h = held[row] as { byHow: Record<string, number>; trades: number };
    const o = a.accounts[row].outcomes;
    for (const how of ["tp", "lc", "deadline", "held"]) if ((o[how] ?? 0) !== h.byHow[how]) bad.push(`${row} ${how}: account line ${o[how] ?? 0}, dump ${h.byHow[how]}`);
    const sum = Object.values(h.byHow).reduce((x, y) => x + y, 0);
    if (sum !== h.trades) bad.push(`${row}: ${sum} by how, ${h.trades} trades`);
  }
  return bad;
};

// ---- ①②③ (§8.102 決まり; 9 for the second-half account) and the facts of the sentences ----------------------------

export interface Verdict {
  one: boolean;
  // ② split: the account rows alone, and the all-emails view (M) alone
  twoAccounts: boolean;
  twoM: boolean;
  two: boolean;
  three: boolean;
}
export interface MView {
  // full: M1 (to SPLIT) and M2 (SPLIT to END), none and the main swap
  none: { M1: number; M2: number };
  swap: { M1: number; M2: number };
  // h2 (SQ-27): M_h, the all-accepted path's M at END
  mh: { none: number; swap: number } | null;
}
export const mViewOf = (a: OhAnalysis, account: Account): MView => {
  const raw = a.raw!;
  return {
    none: { M1: a.m.none.M1, M2: a.m.none.M2 },
    swap: { M1: a.m.swap.M1, M2: a.m.swap.M2 },
    mh: account === "h2" ? { none: raw.unl.main.mEnd, swap: raw.unl.mainSwap.mEnd } : null,
  };
};
// ①②③ come from the facts the sentences are written from (holdVerdictOf, the one derivation the hand cases text.hold.*
// check too: indep-06); `two` is ② whole (the account rows and the all-emails view)
export const verdictOfFacts = (f: HoldFacts): Verdict => ({ ...f.verdict, two: f.verdict.twoAccounts && f.verdict.twoM });
const placedOf = (f: Record<string, number>, n: number): Placed => {
  const g = (k: string) => f[k] ?? 0;
  return { n, entered: g("tp") + g("lc") + g("deadline") + g("held"), unfilled: g("unfilled"), cancelCall: g("cancelCall"), cancelLc: g("cancelLc"), refusedMargin: g("refusedMargin"), refusedCall: g("refusedCall") };
};
// §8.102「楽天の知らせの時刻 τ＋35分」 (only for SPEC.holdCappedCallTime "notice"; research/ownerhold-account.ts's own
// NOTICE is not imported: that file does not pass deno check here, SQ-H3 (a))
const NOTICE_MS = 35 * MINUTE;
// a row's calls as the sentences list them (the hand case text.hold.cappedCalls runs these on call records written by
// hand): ①'s capped calls (U left after the notice's deposit) with the time SPEC.holdCappedCallTime names (SQ-PF1: τ),
// U and the ending; the close-outs of the calls ended by the deadline, at the time the positions were closed
export const cappedCallsOf = (calls: readonly OhCall[]): HoldRowFacts["cappedCalls"] =>
  calls.filter((c) => c.uAfterDeposit !== null && c.uAfterDeposit > 0).map((c) => ({ tau: SPEC.holdCappedCallTime === "notice" ? c.tau + NOTICE_MS : c.tau, short: c.uAfterDeposit!, end: c.end }));
export const deadlineAtOf = (calls: readonly OhCall[]): number[] => calls.filter((c) => c.end === "deadline").map((c) => c.endAt);
const rowFactsOf = (a: OhAnalysis, row: Row4, n: number): HoldRowFacts => {
  const l = a.accounts[row];
  const out = a.raw!.outs[row];
  return {
    lcs: l.lcs, deadlines: l.deadlines, capped: l.capped,
    lcAt: out.lcs.map((x) => x.at),
    deadlineAt: deadlineAtOf(out.calls),
    cappedCalls: cappedCallsOf(out.calls),
    A: l.A, B: l.B, S: l.S, inTotal: l.inEnd, placed: placedOf(l.fates, n),
  };
};
export const factsOf = (a: OhAnalysis, src: string, account: Account, email: boolean, n: number): HoldFacts => {
  const main = a.accounts.main;
  const opp = a.accounts.opposite;
  const halves = main.fatesHalves;
  const m = mViewOf(a, account);
  const pe = a.perEmail.main.all;
  const po = a.perEmail.opposite.all;
  const f: Omit<HoldFacts, "verdict"> = {
    src, account, email, timedOut: false,
    rows: Object.fromEntries(ROWS4.map((r) => [r, rowFactsOf(a, r, n)])) as Record<Row4, HoldRowFacts>,
    placedHalves: account === "full" ? [placedOf(halves[0], Object.values(halves[0]).reduce((x, y) => x + y, 0)), placedOf(halves[1], Object.values(halves[1]).reduce((x, y) => x + y, 0))] : null,
    m: { none: [m.none.M1, m.none.M2], swap: [m.swap.M1, m.swap.M2] },
    mh: m.mh ? [m.mh.none, m.mh.swap] : null,
    third: { main: a.third.main.main, L: a.third.main.L, plain: a.third.main.plain, n: a.third.main.n },
    win: {
      rate: main.winRate, tp: main.outcomes.tp ?? 0, lc: main.outcomes.lc ?? 0, deadline: main.outcomes.deadline ?? 0, held: main.outcomes.held ?? 0,
      pips: main.pips, yen: main.yen, lcEvents: main.lcs, estar: a.estar.main?.estar?.value ?? null,
    },
    opposite: { rate: opp.winRate, tp: opp.outcomes.tp ?? 0, lc: opp.outcomes.lc ?? 0, deadline: opp.outcomes.deadline ?? 0, held: opp.outcomes.held ?? 0, pips: opp.pips, yen: opp.yen, lcs: opp.lcs, deadlines: opp.deadlines, capped: opp.capped, S: opp.S },
    perTrade: { rate: pe.winRate, tp: pe.tp, held: pe.held, pips: pe.pips, yen: pe.yen, oppRate: po.winRate, oppPips: po.pips, oppYen: po.yen },
    // 21 いつも添える文's range: the per-trade view's five-pair rows (the whole account; the full account's halves too)
    perTradeParts: (account === "full" ? (["all", "first", "second"] as const) : (["all"] as const)).map((k) => ({
      rate: a.perEmail.main[k].winRate, pips: a.perEmail.main[k].pips, oppRate: a.perEmail.opposite[k].winRate, oppPips: a.perEmail.opposite[k].pips,
    })),
  };
  return { ...f, verdict: holdVerdictOf(f) };
};

// the sentences' facts against the account lines they are read from: every email has one of the fates the sentences
// count (none left without one, none unknown), the halves add up to the account's emails, and each row's dates and
// capped calls are as many as its counts (the sentences list them)
const FATES = ["tp", "lc", "deadline", "held", "unfilled", "cancelCall", "cancelLc", "refusedMargin", "refusedCall"];
export const factsProblems = (f: HoldFacts, a: OhAnalysis, n: number): string[] => {
  const bad: string[] = [];
  const fatesOk = (fa: Record<string, number>, want: number | null, what: string) => {
    const odd = Object.keys(fa).filter((k) => !FATES.includes(k) && fa[k] > 0);
    if (odd.length) bad.push(`${what}: fates ${odd.join(",")}`);
    const sum = Object.values(fa).reduce((x, y) => x + y, 0);
    if (want !== null && sum !== want) bad.push(`${what}: ${sum} fates for ${want} emails`);
  };
  for (const k of ROWS4) {
    const r = f.rows[k];
    fatesOk(a.accounts[k].fates, n, k);
    if (r.lcAt.length !== r.lcs) bad.push(`${k}: ${r.lcAt.length} loss-cut times for ${r.lcs}`);
    if (r.deadlineAt.length !== r.deadlines) bad.push(`${k}: ${r.deadlineAt.length} deadline times for ${r.deadlines}`);
    if (r.cappedCalls.length !== r.capped) bad.push(`${k}: ${r.cappedCalls.length} capped calls listed for ${r.capped}`);
  }
  if (f.placedHalves) {
    const [h1, h2] = a.accounts.main.fatesHalves;
    fatesOk(h1, null, "main H1");
    fatesOk(h2, null, "main H2");
    if (f.placedHalves[0].n + f.placedHalves[1].n !== n) bad.push(`main: halves ${f.placedHalves[0].n} + ${f.placedHalves[1].n} for ${n} emails`);
  }
  return bad;
};

// ---- 13: the owner's way's suspicious rows (a win rate printed as 100.00% or 0.00%) --------------------------------

export const pct2 = (x: number | null): string => (x === null ? "—" : `${(100 * x).toFixed(SPEC.holdPctDigits)}%`);
const isEdge = (x: number | null): boolean => {
  if (x === null) return false;
  const s = pct2(x);
  return s === pct2(1) || s === pct2(0);
};
export interface SuspectRow {
  // acct.<main|opposite>.<all|H1|H2|PAIR> (the account's win rate: TP ÷ trades entered) or
  // email.<main|opposite>.<all|first|second|PAIR> (the per-email view's: TP ÷ entered)
  scope: string;
  rate: string;
}
const pairKey = (pair: string) => pair.replace("/", "_");
export const suspectsOf = (a: OhAnalysis): SuspectRow[] => {
  const out: SuspectRow[] = [];
  const put = (scope: string, x: number | null) => {
    if (isEdge(x)) out.push({ scope, rate: pct2(x) });
  };
  for (const row of ["main", "opposite"]) {
    const l = a.accounts[row];
    put(`acct.${row}.all`, l.winRate);
    if (l.path) {
      put(`acct.${row}.H1`, l.path.byHalf[0].winRate);
      put(`acct.${row}.H2`, l.path.byHalf[1].winRate);
      for (const pair of PAIRS) if (l.path.byPair[pair]) put(`acct.${row}.${pairKey(pair)}`, l.path.byPair[pair].winRate);
    }
  }
  for (const side of ["main", "opposite"]) {
    const e = a.perEmail[side];
    put(`email.${side}.all`, e.all.winRate);
    put(`email.${side}.first`, e.first.winRate);
    put(`email.${side}.second`, e.second.winRate);
    for (const pair of PAIRS) if (e.byPair[pair]) put(`email.${side}.${pairKey(pair)}`, e.byPair[pair].winRate);
  }
  return out;
};
// 13 ②: three winning trades and three of the other endings of each suspicious row (as many as there are), in order
export const SUSPECT_TRADES_HEADER = "scope,kind,sig,pair,side,T,P,t0,fill,x,exit,how";
export const suspectTradesCsv = (a: OhAnalysis, sigs: readonly Sig[], split: number, rows: readonly SuspectRow[]): string => {
  const lines = [SUSPECT_TRADES_HEADER];
  const paths: Record<string, Array<Record<string, string>>> = { main: csvRowsOf(a.dump["paths-main.csv"]), opposite: csvRowsOf(a.dump["paths-opposite.csv"]) };
  for (const r of rows) {
    const [kind, side, part] = r.scope.split(".");
    const inPart = (i: number) => {
      const s = sigs[i];
      if (part === "all") return true;
      if (part === "H1" || part === "first") return s.T < split;
      if (part === "H2" || part === "second") return s.T >= split;
      return pairKey(s.pair) === part;
    };
    const take = (xs: Array<{ win: boolean; line: string }>) => [...xs.filter((x) => x.win).slice(0, 3), ...xs.filter((x) => !x.win).slice(0, 3)].map((x) => x.line);
    if (kind === "acct") {
      const trades = a.raw!.outs[side].trades.filter((t) => inPart(t.sig));
      lines.push(...take(trades.map((t) => {
        const s = sigs[t.sig];
        return { win: t.how === "tp", line: [r.scope, kind, t.sig, s.pair, sideOf(t.dir), s.T, pOf(s, DELAY), t.t0, t.fill, t.x, t.exit, t.how].join(",") };
      })));
    } else {
      const ps = paths[side].filter((p) => inPart(Number(p.i)) && p.none !== "1");
      lines.push(...take(ps.map((p) => {
        const s = sigs[Number(p.i)];
        const dir = (side === "opposite" ? -s.dir : s.dir) as Dir;
        const tp = Number(p.tpK) >= 0;
        // a path's fillK −2: never filled (ownerhold-trades follow)
        const how = tp ? "tp" : Number(p.fillK) === -2 ? "notFilled" : "held";
        return { win: tp, line: [r.scope, kind, p.i, s.pair, sideOf(dir), s.T, p.P, p.t0, p.fill, p.x, p.exit, how].join(",") };
      })));
    }
  }
  return lines.join("\n") + "\n";
};

// ---- one account of one source ------------------------------------------------------------------------------------

export interface HoldOne {
  src: string;
  account: Account;
  email: boolean;
  dir: string;
  signals: number;
  // the budget (9「計算が Actions の1 job（6時間）に収まらない時は…「出せなかった」」): not run, no numbers
  timedOut: boolean;
  seconds: number;
  checks: Record<string, { ok: boolean; n: number; detail?: unknown; skipped?: string }>;
  verdict: Verdict | null;
  suspects: SuspectRow[];
  facts: HoldFacts | null;
  // the numbers print.txt carries (9 の 1〜8), key → value
  lines: Array<[string, string]>;
}

const writeJson = (path: string, x: unknown) => Deno.writeTextFile(path, JSON.stringify(x, null, 1) + "\n");

// the dump's meta and signals: the 5-minute chart's (meta step 5, delay 2; T = open + 5 min; base = T, a late one's
// the next bar's close, at least T + 5 min)
export const step5Problems = (meta: { step?: unknown; delay?: unknown }, sigs: readonly Sig[]): string[] => {
  const bad: string[] = [];
  if (meta.step !== STEP / MINUTE) bad.push(`meta step ${String(meta.step)}`);
  if (meta.delay !== DELAY) bad.push(`meta delay ${String(meta.delay)}`);
  for (const s of sigs) {
    if (bad.length >= 5) break;
    if (s.T - s.open !== STEP) bad.push(`${s.pair} ${s.open}: T − open ${s.T - s.open}`);
    else if (s.late ? s.base < s.T + STEP : s.base !== s.T) bad.push(`${s.pair} ${s.open}: base ${s.base}`);
  }
  return bad;
};

// 9 の 1〜8 as print.txt lines (hold.<src>.<acct>.<key>; the keys are chartbest-const.ts holdPrintKeys(account), every
// value from analyse() and heldSummary, nothing computed here): 1 the win rates with their endings and the pips and yen
// per trade, 2 the endings and the trades held at END with their price P/L, 3 the MAE (pips and yen, TP / not TP) and the
// largest drawdown, 4 the TP-within shares, the hours to the TPs and the days the held ones were held, 5 the loss-cuts,
// calls and deposits with their dates and the 500,000 / 1,000,000 yen dates, 6 placed and the refused / cancelled by
// reason, 7 A, B, S and M, 8 the opposite-only account and ③; the full account's rows by half and every row by pair;
// the per-trade view (main and opposite) whole, by half and by pair; E*, the verdicts and 13's suspicious rows
const fmtNum = (x: number | null | undefined, d: number): string => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(d));
const fmtCount = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "-" : String(x));
const isoKey = (t: number): string => `${new Date(t).toISOString().slice(0, 16)}Z`;
// a list of times: ISO minutes oldest first, joined by ";" ("" when there is none, as print.txt's other lists)
const datesKey = (ts: readonly number[]): string => [...ts].sort((x, y) => x - y).map(isoKey).join(";");
// the 500,000 / 1,000,000 yen dates: a deposit's time, "start" when the start already had it, "-" when never reached
const reachedKey = (x: number | null | undefined): string => (x === undefined || x === null ? "-" : x === -Infinity ? "start" : Number.isFinite(x) ? isoKey(x) : "-");
const CALL_ENDS = ["deposit", "settle", "deadline", "lc", "open"];
const callEndsKey = (ce: Record<string, number> | undefined): string => {
  const e = ce ?? {};
  return [...CALL_ENDS.map((k) => `${k}=${e[k] ?? 0}`), ...Object.keys(e).filter((k) => !CALL_ENDS.includes(k)).sort().map((k) => `${k}=${e[k]}`)].join(";");
};
const Q4 = ["median", "p90", "p99", "max"] as const;
type HeldRow = { heldAtEnd: { n: number; floatingYenNoSwapSum: number; floatingYenNoSwapWorst: number | null; swapYenSum: number; inLoss: number; heldDays: { median: number | null; p90: number | null; max: number | null } }; hoursToTakeProfit: { n: number; median: number | null; p90: number | null; max: number | null } };
export const holdLines = (key: string, a: OhAnalysis, account: Account, v: Verdict, suspects: SuspectRow[], n: number, held: Record<string, unknown>): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const put = (k: string, x: string | number) => out.push([`${key}.${k}`, String(x)]);
  const maeOf = (pre: string, mae?: { tp: OhQ; notTp: OhQ }, maeYen?: { tp: OhQ; notTp: OhQ }) => {
    for (const k of ["tp", "notTp"] as const) {
      put(`${pre}mae.${k}.n`, fmtCount(mae?.[k]?.n));
      for (const q of Q4) put(`${pre}mae.${k}.${q}`, fmtNum(mae?.[k]?.[q], 2));
      for (const q of Q4) put(`${pre}maeYen.${k}.${q}`, fmtNum(maeYen?.[k]?.[q], 0));
    }
  };
  const withinOf = (pre: string, w?: Record<string, OhWithin>) => {
    for (const h of ["1d", "1w", "4w", "end"]) {
      put(`${pre}tpWithin.${h}.share`, pct2(w?.[h]?.share ?? null));
      put(`${pre}tpWithin.${h}.tp`, fmtCount(w?.[h]?.tp));
      put(`${pre}tpWithin.${h}.of`, fmtCount(w?.[h]?.of));
    }
  };
  const subOf = (pre: string, s: OhSubOut | undefined, placed: string | null) => {
    const o = s?.outcomes ?? {};
    put(`${pre}n`, fmtCount(s?.n));
    put(`${pre}win`, pct2(s?.winRate ?? null));
    put(`${pre}tp`, fmtCount(s ? o.tp ?? 0 : null));
    put(`${pre}lc`, fmtCount(s ? o.lc ?? 0 : null));
    put(`${pre}deadline`, fmtCount(s ? o.deadline ?? 0 : null));
    put(`${pre}held`, fmtCount(s ? o.held ?? 0 : null));
    put(`${pre}pips`, fmtNum(s?.pips, 2));
    put(`${pre}yen`, fmtNum(s?.yen, 0));
    if (placed !== null) put(`${pre}placed`, placed);
  };
  put("signals", n);
  for (const row of HOLD_PRINT.rows) {
    const l = a.accounts[row];
    const o = l.outcomes;
    const r = a.raw!.outs[row];
    put(`${row}.win`, pct2(l.winRate));
    put(`${row}.tp`, o.tp ?? 0);
    put(`${row}.lc`, o.lc ?? 0);
    put(`${row}.deadline`, o.deadline ?? 0);
    put(`${row}.held`, o.held ?? 0);
    put(`${row}.pips`, fmtNum(l.pips, 2));
    put(`${row}.yen`, fmtNum(l.yen, 0));
    put(`${row}.A`, fmtNum(l.A, 0));
    put(`${row}.B`, fmtNum(l.B, 0));
    put(`${row}.S`, fmtNum(l.S, 0));
    put(`${row}.lcs`, l.lcs);
    put(`${row}.deadlines`, l.deadlines);
    put(`${row}.capped`, l.capped);
    put(`${row}.calls`, l.calls);
    put(`${row}.callEnds`, callEndsKey(l.callEnds));
    put(`${row}.deposits`, l.deposits);
    put(`${row}.depositTotal`, fmtNum(l.depositTotal, 0));
    put(`${row}.in`, fmtNum(l.inEnd, 0));
    put(`${row}.lcAt`, datesKey(r.lcs.map((x) => x.at)));
    put(`${row}.deadlineAt`, datesKey(deadlineAtOf(r.calls)));
    put(`${row}.cappedAt`, datesKey(cappedCallsOf(r.calls).map((c) => c.tau)));
    put(`${row}.reached50`, reachedKey(l.reached50));
    put(`${row}.reached100`, reachedKey(l.reached100));
    const p = placedOf(l.fates, n);
    put(`${row}.placed`, pct2(n ? placedCountOf(p) / n : null));
    put(`${row}.notPlaced`, `${p.refusedMargin};${p.refusedCall}`);
    put(`${row}.unfilled`, p.unfilled);
    put(`${row}.cancelCall`, p.cancelCall);
    put(`${row}.cancelLc`, p.cancelLc);
    put(`${row}.maxDrawdown`, fmtNum(l.maxDrawdown, 0));
    maeOf(`${row}.`, l.path?.mae, l.path?.maeYen);
    withinOf(`${row}.`, l.path?.tpWithin);
    // 9「1〜8 は、前半・後半に分けても並べる」: the full account's rows by the signal's half (the placed share of the half's emails)
    if (account === "full") {
      for (const [h, k] of [["H1", 0], ["H2", 1]] as const) {
        const fh = l.fatesHalves[k];
        const nh = Object.values(fh).reduce((x, y) => x + y, 0);
        subOf(`${row}.${h}.`, l.path?.byHalf[k], pct2(nh ? placedCountOf(placedOf(fh, nh)) / nh : null));
      }
    }
    // §8.111 出すもの「5ペアまとめてと、ペアごと」
    for (const pair of PAIRS) subOf(`${row}.${pairKeyOf(pair)}.`, l.path?.byPair[pair], null);
  }
  // §8.111 2・4: the trades still held at END (their price P/L in yen; the swap apart), how long they were held, how long
  // the take profits took (heldSummary, the main and the main swap rows)
  for (const row of HOLD_PRINT.heldRows) {
    const h = held[row] as HeldRow | undefined;
    const e = h?.heldAtEnd;
    put(`${row}.heldEnd.n`, fmtCount(e?.n));
    put(`${row}.heldEnd.yen`, fmtNum(e?.floatingYenNoSwapSum, 0));
    put(`${row}.heldEnd.worstYen`, fmtNum(e?.floatingYenNoSwapWorst, 0));
    put(`${row}.heldEnd.swapYen`, fmtNum(e?.swapYenSum, 0));
    put(`${row}.heldEnd.inLoss`, fmtCount(e?.inLoss));
    put(`${row}.heldDays.median`, fmtNum(e?.heldDays.median, 2));
    put(`${row}.heldDays.p90`, fmtNum(e?.heldDays.p90, 2));
    put(`${row}.heldDays.max`, fmtNum(e?.heldDays.max, 2));
    const w = h?.hoursToTakeProfit;
    put(`${row}.tpHours.n`, fmtCount(w?.n));
    put(`${row}.tpHours.median`, fmtNum(w?.median, 2));
    put(`${row}.tpHours.p90`, fmtNum(w?.p90, 2));
    put(`${row}.tpHours.max`, fmtNum(w?.max, 2));
  }
  for (const side of ["main", "opposite"]) {
    for (const part of HOLD_PRINT.emailParts) {
      const e = a.perEmail[side][part];
      const pre = `email.${side}.${part}.`;
      put(`${pre}emails`, e.emails);
      put(`${pre}filled`, e.filled);
      put(`${pre}unfilled`, fmtCount(e.unfilled));
      put(`${pre}win`, pct2(e.winRate));
      put(`${pre}tp`, e.tp);
      put(`${pre}held`, e.held);
      put(`${pre}pips`, fmtNum(e.pips, 2));
      put(`${pre}yen`, fmtNum(e.yen, 0));
      maeOf(pre, e.mae, e.maeYen);
      withinOf(pre, e.tpWithin);
    }
    for (const pair of PAIRS) {
      const e = a.perEmail[side].byPair[pair];
      const pre = `email.${side}.${pairKeyOf(pair)}.`;
      put(`${pre}win`, pct2(e?.winRate ?? null));
      put(`${pre}tp`, fmtCount(e?.tp));
      put(`${pre}held`, fmtCount(e?.held));
      put(`${pre}pips`, fmtNum(e?.pips, 2));
      put(`${pre}yen`, fmtNum(e?.yen, 0));
    }
  }
  put("estar", fmtNum(a.estar.main?.estar?.value ?? null, 0));
  const m = mViewOf(a, account);
  if (account === "full") {
    put("M1", fmtNum(m.none.M1, 0));
    put("M2", fmtNum(m.none.M2, 0));
    put("M1swap", fmtNum(m.swap.M1, 0));
    put("M2swap", fmtNum(m.swap.M2, 0));
  } else {
    put("Mh", fmtNum(m.mh!.none, 0));
    put("MhSwap", fmtNum(m.mh!.swap, 0));
  }
  put("third.main", fmtNum(a.third.main.main, 2));
  put("third.L", fmtNum(a.third.main.L, 2));
  put("third.plain", fmtNum(a.third.main.plain, 2));
  put("third.n", a.third.main.n);
  put("v1", v.one ? "yes" : "no");
  put("v2", v.two ? "yes" : "no");
  put("v3", v.three ? "yes" : "no");
  // 13: the rows printed 100.00% or 0.00% ("" when there is none, as s1 / s2's suspicious lines)
  put("suspicious", suspects.map((s) => `${s.scope}=${s.rate}`).join(";"));
  return out;
};
// the print check of 9 の 1〜8: every key holdPrintKeys promises for the account, once, and nothing else; an empty value
// only for a list (the suspicious rows, the dates), a missing number is "-"
const LIST_KEY = /\.(suspicious|lcAt|deadlineAt|cappedAt)$/;
export const printedProblems = (lines: ReadonlyArray<[string, string]>, key: string, account: Account): string[] => {
  const want = new Set(holdPrintKeys(account).map((k) => `${key}.${k}`));
  const seen = new Map<string, number>();
  for (const [k] of lines) seen.set(k, (seen.get(k) ?? 0) + 1);
  const bad: string[] = [];
  for (const k of want) if (!seen.has(k)) bad.push(`missing ${k}`);
  for (const [k, c] of seen) {
    if (!want.has(k)) bad.push(`not promised ${k}`);
    else if (c > 1) bad.push(`${k} printed ${c} times`);
  }
  for (const [k, v] of lines) if (v === "" && !LIST_KEY.test(k)) bad.push(`${k} empty`);
  return bad;
};

// ownerhold.ts's own checks that compare nothing here: its signal probes compare the sweep's own readers (§8.111 確かめ
// B 1, its review fix 6「比べた数が0でも通る穴を塞いだ」), and chartbest's reads carry none (NO_PROBE), so its signalProbe
// (whose 'looked' also follows its import-time SIGS) and a signalCut would pass on 0 compared. They are listed as SKIP
// with the checks that cover the signal lists here (gates-03, hold-signalprobe-trivial)
const NOT_HERE: Record<string, string> = {
  signalProbe: "the owner's way's reads carry no probe; the signal lists are checked by 20 (b): measure.ultra.indicatorSignals, measure.macd.macdxSignals, measure.ultra.vsSignalsOf, measure.macd.vsReadOf and the items' look-ahead checks",
  signalCut: "the owner's way's reads carry no cut; the look-ahead of the signal lists is 20 (b)'s (lookahead.* of the items, measure.* of the emails)",
};

export interface HoldOneSpec {
  src: string;
  account: Account;
  email: boolean;
  sigs: Sig[];
  reads: SignalRead[];
  m1s: M1[];
  ctx: OhCtx;
  rates: Rates;
  load: LoadStats;
  outDir: string;
}
// analyse() on one account, its files, its checks and its facts
export const holdOne = async (oh: OwnerHold, x: HoldOneSpec): Promise<HoldOne> => {
  const t0 = Date.now();
  const ds: OhDataSet = { name: `${x.src} ${x.account}`, m1s: x.m1s, sigs: x.sigs, reads: x.reads, load: x.load, src: null, rates: x.rates };
  const a = oh.analyse(ds, x.ctx, "all");
  if (!a.raw || !a.accounts.main || !a.accounts.opposite || !a.perEmail.main) throw new Error("ownerhold.ts analyse(): not the shape this program reads");
  const dir = `${x.outDir}/${x.src}-${x.account}`;
  await Deno.mkdir(dir, { recursive: true });
  await oh.writeDump(`${dir}/dump`, a, x.ctx, { step: STEP / MINUTE, sigs: x.src });
  await Deno.writeTextFile(`${dir}/decisions.txt`, a.decisions.join("\n"));
  await writeJson(`${dir}/analysis.json`, { ...a, dump: undefined, decisions: undefined, raw: undefined });
  const held = await heldSummary(`${dir}/dump`);
  await writeJson(`${dir}/held.json`, held);
  const suspects = suspectsOf(a);
  const facts = factsOf(a, x.src, x.account, x.email, x.sigs.length);
  const verdict = verdictOfFacts(facts);
  await writeJson(`${dir}/lines.json`, {
    src: x.src, account: x.account, ctx: x.ctx, signals: x.sigs.length,
    accounts: Object.fromEntries(HOLD_PRINT.rows.map((r) => [r, a.accounts[r]])),
    perEmail: { main: a.perEmail.main, opposite: a.perEmail.opposite },
    estar: a.estar, m: mViewOf(a, x.account), third: a.third, verdict, suspects, facts,
  });
  await Deno.writeTextFile(`${dir}/suspect-trades.csv`, suspectTradesCsv(a, x.sigs, x.ctx.split, suspects));
  const checks: HoldOne["checks"] = {};
  for (const [k, c] of Object.entries(a.checks)) {
    if (NOT_HERE[k] !== undefined) checks[k] = { ok: true, n: 0, skipped: NOT_HERE[k] };
    else checks[k] = { ok: c.ok, n: c.n ?? 1, ...(c.ok ? {} : { detail: c.why || c.detail }) };
  }
  const hb = heldAgainstLines(held, a);
  checks.held = { ok: hb.length === 0, n: hb.length || 2, ...(hb.length ? { detail: hb.slice(0, 5) } : {}) };
  const meta = JSON.parse(await Deno.readTextFile(`${dir}/dump/meta.json`)) as { step?: unknown; delay?: unknown };
  const sp = step5Problems(meta, x.sigs);
  checks.step5 = { ok: sp.length === 0, n: sp.length || x.sigs.length, ...(sp.length ? { detail: sp } : {}) };
  const fp = factsProblems(facts, a, x.sigs.length);
  checks.facts = { ok: fp.length === 0, n: fp.length || x.sigs.length, ...(fp.length ? { detail: fp.slice(0, 5) } : {}) };
  const key = `hold.${x.src}.${x.account}`;
  const lines = holdLines(key, a, x.account, verdict, suspects, x.sigs.length, held);
  const pp = printedProblems(lines, key, x.account);
  checks.printed = { ok: pp.length === 0, n: pp.length || lines.length, ...(pp.length ? { detail: pp.slice(0, 5) } : {}) };
  return { src: x.src, account: x.account, email: x.email, dir, signals: x.sigs.length, timedOut: false, seconds: (Date.now() - t0) / 1000, checks, verdict, suspects, facts, lines };
};

// ---- every source × account of a stage-2 run ---------------------------------------------------------------------

export interface HoldSource {
  src: string;
  email: boolean;
  recs: readonly SigRec[];
  late: readonly LateSig[];
}
export interface HoldRunIn {
  bars: readonly PairBars[];
  m1: readonly M1[];
  diags: readonly LoadDiag[];
  period: Pick<Period, "start" | "split" | "end">;
  sources: readonly HoldSource[];
  rates: Rates;
  outDir: string;
  // 9「合図がとても多い項目で、計算が Actions の1 job（6時間）に収まらない時は、その項目のオーナーの持ち方は「出せなかった」
  // と書く」: an item's account not started by this time (ms since 1970: the job's start + CB_HOLD_BUDGET_MIN, see
  // research/chartbest-modes.ts) is 「出せなかった」. A started account runs to its end (analyse() is synchronous)
  deadlineMs: number;
  // the clock (a test can pass its own)
  now?: () => number;
}
// the marker of an account left out by the budget (SQ-PF4): hold/<src>-<acct>/timed-out.json, and no dump
export const TIMED_OUT_FILE = "timed-out.json";
// 9 and 20 (c): the two emails' accounts run first and are never left out (9 names the items: 「その項目のオーナーの持ち方
// は「出せなかった」」; 「今のメール2つの数字は、§8.111 の数字を再現して並べる」); then the items, each account started only
// before the deadline. The results come back in the sources' order (the print and the sentences keep their order)
export const holdRun = async (x: HoldRunIn): Promise<HoldOne[]> => {
  const oh = await ownerholdInert();
  const now = x.now ?? Date.now;
  const load = loadStatsOf(x.diags);
  const order = [...x.sources.filter((s) => s.email), ...x.sources.filter((s) => !s.email)];
  const done = new Map<string, HoldOne>();
  for (const s of order) {
    for (const account of ACCOUNTS) {
      const ctx = ctxOf(x.period, account);
      const sigs = holdSigsOf(s.recs, s.late, x.bars, ctx.start, ctx.end);
      if (!s.email && now() > x.deadlineMs) {
        const dir = `${x.outDir}/${s.src}-${account}`;
        await Deno.mkdir(dir, { recursive: true });
        await writeJson(`${dir}/${TIMED_OUT_FILE}`, { src: s.src, account, signals: sigs.length, deadline: new Date(x.deadlineMs).toISOString(), at: new Date(now()).toISOString(), why: "the owner's way's budget (CB_HOLD_BUDGET_MIN from the job's start) ran out before this account started: 9「出せなかった」" });
        done.set(`${s.src}|${account}`, { src: s.src, account, email: s.email, dir, signals: sigs.length, timedOut: true, seconds: 0, checks: {}, verdict: null, suspects: [], facts: null, lines: [] });
        continue;
      }
      const m1s = x.m1.map((m) => m1Window(m, ctx.start - DAY, ctx.end));
      done.set(`${s.src}|${account}`, await holdOne(oh, { src: s.src, account, email: s.email, sigs, reads: readsOf(x.bars, sigs, ctx.start, ctx.end), m1s, ctx, rates: x.rates, load, outDir: x.outDir }));
    }
  }
  return x.sources.flatMap((s) => ACCOUNTS.map((account) => done.get(`${s.src}|${account}`)!));
};
