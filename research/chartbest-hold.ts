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
// Its chart follows SIGS at import (the 15-minute chart when SIGS is unset); nothing analyse() computes depends on it.
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
import { type Dir, PAIRS, type Period, SPEC, STEP, SYNTH_RATES } from "./chartbest-const.ts";
import type { SigRec } from "./chartbest-events.ts";
import { type LateSig, lateMailed } from "./chartbest-measures.ts";
import type { LoadDiag } from "./chartbest-data.ts";
import { type HoldFacts, type HoldRowFacts, type Placed, ROWS4, type Row4 } from "./chartbest-text.ts";

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
export interface OhLine {
  inEnd: number;
  A: number;
  B: number;
  S: number;
  lcs: number;
  deadlines: number;
  capped: number;
  calls: number;
  deposits: number;
  depositTotal: number;
  fates: Record<string, number>;
  fatesHalves: [Record<string, number>, Record<string, number>];
  winRate: number | null;
  outcomes: Record<string, number>;
  pips: number | null;
  yen: number | null;
  path?: { byHalf: [OhSub, OhSub]; byPair: Record<string, OhSub> };
  [k: string]: unknown;
}
export interface OhPerEmail extends OhSub {
  emails: number;
  filled: number;
  held: number;
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
export const verdictOf = (a: OhAnalysis, account: Account): Verdict => {
  const acc = a.accounts;
  const one = ROWS4.every((r) => acc[r].lcs === 0 && acc[r].deadlines === 0 && acc[r].capped === 0);
  const m = mViewOf(a, account);
  const twoAccounts = account === "full" ? ROWS4.every((r) => acc[r].A > 0 && acc[r].B > 0) : ROWS4.every((r) => acc[r].S > 0);
  const twoM = account === "full" ? m.none.M1 > 0 && m.none.M2 > 0 && m.swap.M1 > 0 && m.swap.M2 > 0 : m.mh!.none > 0 && m.mh!.swap > 0;
  const L = a.third.main.L;
  return { one, twoAccounts, twoM, two: twoAccounts && twoM, three: L !== null && L > 0 };
};
const placedOf = (f: Record<string, number>, n: number): Placed => {
  const g = (k: string) => f[k] ?? 0;
  return { n, entered: g("tp") + g("lc") + g("deadline") + g("held"), unfilled: g("unfilled"), cancelCall: g("cancelCall"), cancelLc: g("cancelLc"), refusedMargin: g("refusedMargin"), refusedCall: g("refusedCall") };
};
const rowFactsOf = (a: OhAnalysis, row: Row4, n: number): HoldRowFacts => {
  const l = a.accounts[row];
  const out = a.raw!.outs[row];
  return {
    lcs: l.lcs, deadlines: l.deadlines, capped: l.capped,
    lcAt: out.lcs.map((x) => x.at),
    deadlineAt: out.calls.filter((c) => c.end === "deadline").map((c) => c.endAt),
    cappedCalls: out.calls.filter((c) => c.uAfterDeposit !== null && c.uAfterDeposit > 0).map((c) => ({ tau: c.tau, short: c.uAfterDeposit!, end: c.end })),
    A: l.A, B: l.B, S: l.S, inTotal: l.inEnd, placed: placedOf(l.fates, n),
  };
};
export const factsOf = (a: OhAnalysis, src: string, account: Account, email: boolean, n: number, v: Verdict): HoldFacts => {
  const main = a.accounts.main;
  const opp = a.accounts.opposite;
  const halves = main.fatesHalves;
  const m = mViewOf(a, account);
  const pe = a.perEmail.main.all;
  const po = a.perEmail.opposite.all;
  return {
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
    verdict: { one: v.one, twoAccounts: v.twoAccounts, twoM: v.twoM, three: v.three },
  };
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
  checks: Record<string, { ok: boolean; n: number; detail?: unknown }>;
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

// 9 の 1〜8 as print.txt lines (hold.<src>.<acct>.…): the win rates with their endings and the per-trade pips and yen,
// the account's P/L A, B, S, the loss-cuts, calls and deposits, E*, M, ③, the placed shares, the verdicts
const fmtNum = (x: number | null, d: number): string => (x === null || !Number.isFinite(x) ? "-" : x.toFixed(d));
export const holdLines = (key: string, a: OhAnalysis, account: Account, v: Verdict, suspects: SuspectRow[], n: number): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const put = (k: string, x: string | number) => out.push([`${key}.${k}`, String(x)]);
  put("signals", n);
  for (const row of ["main", "mainSwap", "worst", "worstSwap", "opposite"]) {
    const l = a.accounts[row];
    const o = l.outcomes;
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
    put(`${row}.deposits`, l.deposits);
    put(`${row}.depositTotal`, fmtNum(l.depositTotal, 0));
    put(`${row}.in`, fmtNum(l.inEnd, 0));
    const p = placedOf(l.fates, n);
    put(`${row}.placed`, pct2(n ? (p.entered + p.unfilled + p.cancelCall + p.cancelLc) / n : null));
    put(`${row}.notPlaced`, `${p.refusedMargin};${p.refusedCall}`);
  }
  for (const side of ["main", "opposite"]) {
    for (const part of ["all", "first", "second"] as const) {
      const e = a.perEmail[side][part];
      put(`email.${side}.${part}.win`, pct2(e.winRate));
      put(`email.${side}.${part}.tp`, e.tp);
      put(`email.${side}.${part}.held`, e.held);
      put(`email.${side}.${part}.pips`, fmtNum(e.pips, 2));
      put(`email.${side}.${part}.yen`, fmtNum(e.yen, 0));
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
  put("suspicious", suspects.map((s) => `${s.scope}=${s.rate}`).join(";"));
  return out;
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
  const verdict = verdictOf(a, x.account);
  const suspects = suspectsOf(a);
  const facts = factsOf(a, x.src, x.account, x.email, x.sigs.length, verdict);
  await writeJson(`${dir}/lines.json`, {
    src: x.src, account: x.account, ctx: x.ctx, signals: x.sigs.length,
    accounts: Object.fromEntries(["main", "mainSwap", "worst", "worstSwap", "opposite"].map((r) => [r, a.accounts[r]])),
    perEmail: { main: a.perEmail.main, opposite: a.perEmail.opposite },
    estar: a.estar, m: mViewOf(a, x.account), third: a.third, verdict, suspects, facts,
  });
  await Deno.writeTextFile(`${dir}/suspect-trades.csv`, suspectTradesCsv(a, x.sigs, x.ctx.split, suspects));
  const checks: HoldOne["checks"] = {};
  for (const [k, c] of Object.entries(a.checks)) checks[k] = { ok: c.ok, n: c.n ?? 1, ...(c.ok ? {} : { detail: c.why || c.detail }) };
  const hb = heldAgainstLines(held, a);
  checks.held = { ok: hb.length === 0, n: hb.length || 2, ...(hb.length ? { detail: hb.slice(0, 5) } : {}) };
  const meta = JSON.parse(await Deno.readTextFile(`${dir}/dump/meta.json`)) as { step?: unknown; delay?: unknown };
  const sp = step5Problems(meta, x.sigs);
  checks.step5 = { ok: sp.length === 0, n: sp.length || x.sigs.length, ...(sp.length ? { detail: sp } : {}) };
  const lines = holdLines(`hold.${x.src}.${x.account}`, a, x.account, verdict, suspects, x.sigs.length);
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
  // minutes of wall clock for the whole owner's way; a source × account not started by then is 「出せなかった」
  budgetMin: number;
}
export const holdRun = async (x: HoldRunIn): Promise<HoldOne[]> => {
  const oh = await ownerholdInert();
  const t0 = Date.now();
  const load = loadStatsOf(x.diags);
  const out: HoldOne[] = [];
  for (const s of x.sources) {
    for (const account of ACCOUNTS) {
      const ctx = ctxOf(x.period, account);
      const sigs = holdSigsOf(s.recs, s.late, x.bars, ctx.start, ctx.end);
      if ((Date.now() - t0) / 60_000 > x.budgetMin) {
        out.push({ src: s.src, account, email: s.email, dir: "", signals: sigs.length, timedOut: true, seconds: 0, checks: {}, verdict: null, suspects: [], facts: null, lines: [] });
        continue;
      }
      const m1s = x.m1.map((m) => m1Window(m, ctx.start - DAY, ctx.end));
      out.push(await holdOne(oh, { src: s.src, account, email: s.email, sigs, reads: readsOf(x.bars, sigs, ctx.start, ctx.end), m1s, ctx, rates: x.rates, load, outDir: x.outDir }));
    }
  }
  return out;
};
