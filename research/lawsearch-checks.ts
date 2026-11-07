// 法則探し (docs §8.136, research/lawsearch-spec.md 15, 13 (iv)): the look-ahead and data checks, builder D
// (research/lawsearch-design.md 7.3). Stage-0 safe: this module imports no trade, measure or select code (the
// stage-0 program imports it; `deno info research/lawsearch-stage0.ts` is checked in CI).
//
// Every check returns a CheckResult. Its probes are named by trial id where a check is decided per trial (cut, poison,
// presence, same first half, adds up), so that checks.csv can carry one row per trial (rule 2 of spec 10 reads them);
// any other probe belongs to the whole run.
//
// Readings and choices of this module (reported to the lead):
//   * cut: the holes of the cut run are computed on [s_{k−9} − HOLE_MIN_SLOTS × step, T_k) instead of [S0, T_k).
//     ③ at bar k reads only the slots of [s_{k−9}, T_k), and a hole run reaching into that window from the left is
//     at least HOLE_MIN_SLOTS long within this range whenever it is in the whole cut series, so the decision is the
//     same; the cost per target drops from all slots to about a dozen. A planted ③ that reads past T still sees
//     nothing after T_k (the cut bars end there), which is what the check needs.
//   * poison: the poisoned bars are the trial's timeframe's five pairs (its higher bars are rebuilt from them only
//     when an item reads them); the decision at T reads no other series. The holes are the uncut run's: poison
//     changes prices, never which bars exist, and holesOf reads only the starts.
//   * the 300 evenly spaced bars: k = floor(j × (n − 1) ÷ 299), j = 0 … 299.
//   * spec 23.2 (2026-11-05): stage 0 keeps CUT_HTF_STAGE0 = 300 of the higher-timeframe boundary targets per
//     timeframe and pair, the j-th of their time-ordered list being floor(j × (n − 1) ÷ 299) (all when n ≤ 300); the
//     other kinds are unchanged. The chosen trials are cut on every boundary target: at the end of stage 1 on stage
//     1's universe ([S0, SPLIT), check "cut.chosen.first"), and in stage 2 on the second half ("cut.chosen.second").
//     The second half's targets (fromStart = SPLIT): a bar target (signal, even) whose bar starts at or after SPLIT;
//     a boundary target (gap, day, htf) whose boundary bar (the first bar after it) starts at or after SPLIT. So the
//     boundary at SPLIT, whose bars before it are the first half's last ones, is stage 2's: stage 1's universe has no
//     bar after it, so it cannot see that boundary. Every boundary is then checked once on the chosen trials.

import { checkConstants, checkFiles, HIGHER, MID_DIGITS, N_BARS, PAIRS, POINTS_PER_PRICE, SPLIT, STEP } from "./lawsearch-const.ts";
import { CUT_DAY_BARS, CUT_EVEN, CUT_GAP_BARS, CUT_HTF_BARS, CUT_HTF_STAGE0, CUT_SAMPLE, HOLE_MIN_SLOTS, POISON_N, POISON_PIPS, R3_BACK, REASONS, SEEDS, STATUS } from "./lawsearch-rules.ts";
import { coarsenSeries, deleteBars, entryExitIndex, htfIndex, poisonSeries, poisonTables, prefixSeries, stratumOf, windowSeries } from "./lawsearch-bars.ts";
import type { PoisonTables } from "./lawsearch-bars.ts";
import { indOf } from "./lawsearch-ind.ts";
import { parseCandidates } from "./lawsearch-items.ts";
import { candidatesOf, exclCtxOf, holesOf, reasonOf } from "./lawsearch-events.ts";
import { donchianState } from "./bigflow-lib.ts";
import { mulberry32, shuffle } from "./trend-stats.ts";
import { GMO_INTERVALS, GMO_SYMBOLS, jstDayKey } from "../supabase/functions/track-outcomes/quotes.ts";
import { DAY, WEEK } from "./lib.ts";
import type { CheckResult, Classified, CutFailRow, ExclCtx, Ind, Probe, Series, TfKey, TfSet, TrialDef, TrialSignals, Universe } from "./lawsearch-types.ts";

const RI = Object.fromEntries(REASONS.map((r, k) => [r, k])) as Record<string, number>;
const MAX_EXAMPLES = 5;

// ---- helpers ----------------------------------------------------------------------------------------------------

const probeOf = (name: string): Probe => ({ name, compared: 0, mismatched: 0, examples: [] });
const miss = (p: Probe, what: string, cap = MAX_EXAMPLES) => {
  p.mismatched++;
  if (p.examples.length < cap) p.examples.push(what);
};
const resultOf = (name: string, probes: Probe[], extra = ""): CheckResult => {
  const bad = probes.filter((p) => p.mismatched > 0);
  const compared = probes.reduce((a, p) => a + p.compared, 0);
  const detail = (bad.length === 0 ? `${compared} compared; none differs` : `${bad.length} of ${probes.length} probes differ: ${bad.map((p) => `${p.name} ${p.mismatched}/${p.compared} (${p.examples.join("; ")})`).join(" | ")}`) + (extra ? `; ${extra}` : "");
  return { name, passed: bad.length === 0, detail, probes };
};
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");

// the bar index range [lo, hi) of rows at bar i (Candidates are in bar order)
const rowsAt = (ci: Int32Array, i: number): [number, number] => {
  let lo = 0;
  let hi = ci.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ci[m] < i) lo = m + 1;
    else hi = m;
  }
  let e = lo;
  while (e < ci.length && ci[e] === i) e++;
  return [lo, e];
};
const lowerBound = (xs: ArrayLike<number>, n: number, v: number): number => {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
};

// the decision of one trial at bar i of the uncut run: "d:status:warm:reason:stratum" per row, or "none"
const decisionOfClassified = (c: Classified, s: Series, i: number): string => {
  const [lo, hi] = rowsAt(c.i, i);
  const parts: string[] = [];
  for (let r = lo; r < hi; r++) parts.push(`${c.d[r]}:${STATUS[c.status[r]]}:${c.warmOk[r]}:${REASONS[c.reason[r]]}:${stratumOf(s.pi, c.d[r] as 1 | -1, s.T[i])}`);
  return parts.length ? parts.join("|") : "none";
};

// the decision at bar i (of series s, whose Ind is ind) recomputed: candidatesOf, then spec 6 on the rows at i.
// C4c ("restore"): candidatesOf itself, the main run's own function, on the check's whole series s (a cut series ends
// at its target, so its walk ends there), as in b3a2c43; C4b's one-bar candidatesAt is gone (C4b's review, finding 1:
// it ran the per-bar body at bar i alone, so a look-ahead carried by state across bars was not seen). Trials on the
// same Ind share their builds (lawsearch-events.ts buildOf), each build made from the Ind's own series.
const decisionOf = (trial: TrialDef, ind: Ind, ctx: ExclCtx, s: Series, i: number, o: { answerKnowing: boolean; plant: string }): string => {
  const c = candidatesOf(trial, ind, { plant: o.plant, answerKnowing: o.answerKnowing });
  const [lo, hi] = rowsAt(c.i, i);
  const parts: string[] = [];
  for (let r = lo; r < hi; r++) {
    const st = STATUS[c.status[r]];
    const reason = st === "emit" ? reasonOf(ctx, s, i, c.warmOk[r] === 1) : st;
    parts.push(`${c.d[r]}:${st}:${c.warmOk[r]}:${reason}:${stratumOf(s.pi, c.d[r] as 1 | -1, s.T[i])}`);
  }
  return parts.length ? parts.join("|") : "none";
};

// an item of finite length may be recomputed on its own window (§8.113 C17: B06 reads 291 bars)
const FINITE_BARS: Readonly<Record<string, number>> = { B06: 291 };
const finiteOf = (t: TrialDef): number | null => (t.kind === "B" && t.b !== null && FINITE_BARS[t.b] !== undefined ? FINITE_BARS[t.b] : null);
// does a trial read the higher timeframe (F02, F02r, S02)? None of the trial's items does yet.
const readsHigher = (t: TrialDef): boolean => (t.f !== null && t.f.startsWith("F02")) || t.s === "S02";

// the Ind of one pair of a (possibly edited) timeframe: the higher bars rebuilt from the edited bars when read
const indFor = (s: Series, tfKey: TfKey, higher: boolean, plant: string): Ind => {
  if (!higher) return indOf(s, null, plant);
  const h = coarsenSeries(s, tfKey === "m15" ? "h1" : "h4", plant);
  return indOf(s, { series: h, g: htfIndex(s, h, plant) }, plant);
};

// ---- the rules files (spec 15 データ: ledger and spread-hours-h1.csv sha256; 12: the spec's) ------------------------

export async function checkRulesFiles(root = "."): Promise<CheckResult> {
  const files = probeOf("files");
  const bad = await checkFiles(root);
  files.compared = 5;
  for (const b of bad) miss(files, b);
  const consts = probeOf("constants");
  consts.compared = 5;
  for (const b of checkConstants()) miss(consts, b);
  const ledger = probeOf("ledger");
  ledger.compared = 1;
  try {
    const rows = parseCandidates(JSON.parse(await Deno.readTextFile(`${root}/research/ledger/lawsearch-candidates.json`)));
    if (rows.length !== 1364) miss(ledger, `${rows.length} rows`);
  } catch (e) {
    miss(ledger, (e as Error).message);
  }
  return resultOf("rules", [files, consts, ledger]);
}

// ---- spec 15 データ ------------------------------------------------------------------------------------------

export function dataCheck(u: Universe): CheckResult {
  const p = probeOf(`data ${u.purpose}`);
  p.compared = u.load.length;
  for (const x of u.problems) miss(p, x);
  return resultOf(`data.${u.purpose}`, [p]);
}

// ---- spec 15 切り取り ----------------------------------------------------------------------------------------

export interface CutTarget {
  tf: TfKey;
  pi: number;
  k: number;
  kinds: string[];
}

export interface CutTargetOpts {
  // spec 23.2: "even" keeps CUT_HTF_STAGE0 of the higher-timeframe boundary targets per (tf, pair), evenly picked in
  // time order (stage 0); "all" keeps every one (the chosen trials at the end of stage 1 and in stage 2)
  htf: "even" | "all";
  // the second half only (stage 2, fromStart = SPLIT): bar targets whose bar starts at or after fromStart, boundary
  // targets whose boundary bar starts at or after fromStart (the header above)
  fromStart?: number;
  // filled with the number of targets of each kind (a target with two kinds counts in both) and, for htf, how many
  // there were before the even pick ("htf.all")
  stats?: Record<string, number>;
}

// Per trial: every signal (every row of Classified, any reason; over 3,000 → sampleOf(…, 3000, 318)); per trial and
// pair: 300 evenly spaced bars, the 10 bars before every gap (open to open over one step), the 2 bars before each day
// boundary (dayOf changes) and the 2 before each higher-timeframe boundary (o.htf: 300 of them evenly picked, or all;
// spec 23.2). Deduplicated per (tf, pi, k), sorted.
export function cutTargets(u: Universe, trials: TrialDef[], sigs: TrialSignals[], o: CutTargetOpts): CutTarget[] {
  const map = new Map<string, CutTarget>();
  const stats = o.stats ?? {};
  const add = (tf: TfKey, pi: number, k: number, kind: string) => {
    if (k < 0) return;
    const key = `${tf}:${pi}:${k}`;
    const t = map.get(key);
    if (t) {
      if (!t.kinds.includes(kind)) t.kinds.push(kind);
    } else map.set(key, { tf, pi, k, kinds: [kind] });
  };
  const from = o.fromStart;
  const setOf = (tf: TfKey) => (tf === "m15" ? u.m15 : u.h1);
  for (const sig of sigs) {
    const series = setOf(sig.tf).pairs;
    const rows: Array<[number, number]> = [];
    for (const c of sig.pairs) for (let r = 0; r < c.n; r++) if (from === undefined || series[c.pi].s[c.i[r]] >= from) rows.push([c.pi, c.i[r]]);
    const pick = rows.length > CUT_SAMPLE ? sampleOf(rows, CUT_SAMPLE, SEEDS.cut) : rows;
    for (const [pi, k] of pick) add(sig.tf, pi, k, "signal");
  }
  const tfs = new Set(trials.map((t) => t.tf));
  for (const tf of tfs) {
    const set = setOf(tf);
    const step = STEP[tf];
    const hstep = HIGHER[tf];
    set.pairs.forEach((s, pi) => {
      const k0 = from === undefined ? 0 : lowerBound(s.s, s.n, from);
      const m = s.n - k0;
      if (m <= 0) return;
      for (let j = 0; j < CUT_EVEN; j++) add(tf, pi, k0 + Math.floor((j * (m - 1)) / (CUT_EVEN - 1)), "even");
      const htf = new Set<number>();
      for (let k = Math.max(1, k0); k < s.n; k++) {
        if (s.s[k] - s.s[k - 1] > step) for (let b = 1; b <= CUT_GAP_BARS; b++) add(tf, pi, k - b, "gap");
        if (s.day[k] !== s.day[k - 1]) for (let b = 1; b <= CUT_DAY_BARS; b++) add(tf, pi, k - b, "day");
        if (Math.floor(s.s[k] / hstep) !== Math.floor(s.s[k - 1] / hstep)) for (let b = 1; b <= CUT_HTF_BARS; b++) if (k - b >= 0) htf.add(k - b);
      }
      const list = Float64Array.from(htf).sort();
      const n = list.length;
      stats["htf.all"] = (stats["htf.all"] ?? 0) + n;
      if (o.htf === "all" || n <= CUT_HTF_STAGE0) for (let q = 0; q < n; q++) add(tf, pi, list[q], "htf");
      else for (let j = 0; j < CUT_HTF_STAGE0; j++) add(tf, pi, list[Math.floor((j * (n - 1)) / (CUT_HTF_STAGE0 - 1))], "htf");
    });
  }
  const out = [...map.values()].sort((a, b) => (a.tf === b.tf ? 0 : a.tf === "m15" ? -1 : 1) || a.pi - b.pi || a.k - b.k);
  for (const t of out) for (const kind of t.kinds) stats[kind] = (stats[kind] ?? 0) + 1;
  return out;
}

// the detail's summary of cutTargets' stats: "signal 1,234, even 3,000, …, htf 3,000 of 168,123"
export const cutStatsText = (stats: Record<string, number>): string =>
  ["signal", "even", "gap", "day", "htf"].map((k) => `${k} ${stats[k] ?? 0}${k === "htf" ? ` of ${stats["htf.all"] ?? 0}` : ""}`).join(", ");

// ---- the units of the checks cut, poison and presence (C4b, the speed-up "par") -----------------------------------
//
// Each of the three checks is a list of units, and a unit is one decision recomputed on its own edited series:
//   cut       one (target k, trial): the five pairs cut at T_k (cutGotAt);
//   poison    one probe bar i of one trial: its pair poisoned after T_i (poisonGotAt);
//   presence  one (probe bar i, variant) of one trial: bars deleted after T_i (presenceGotAt).
// The three Got functions are the bodies of the checks' loops before C4b, moved here unchanged. Nothing is shared
// between units except what those loops already shared: at one cut target, the holes of the cut and the cut's Ind
// are made once and read by every trial at that target (the same cut series for all of them). The uncut decision
// ("want") is still made in this thread, by the check, from the uncut run's signals; a unit only gives back its
// recomputed decision when it differs from want. The check then replays the units in their original order (target
// by target, trial by trial; probe by probe) and does there everything the loop did: compared, the examples, the
// rows of cut_fail.csv, the planted mark. A unit may run in this thread (inPlace) or on a worker
// (research/lawsearch-par.ts); the replay order does not depend on where or when a unit ran, so the bytes are the
// same with any number of workers. An error is replayed at its unit too: the units before it count, then it is
// thrown, as the loop would have thrown it there.

// what the units of one check read besides the universe
export type UnitTask =
  | { kind: "cut"; tf: TfKey; trials: TrialDef[]; higher: boolean; avoid: ReadonlySet<string>; answerKnowing: boolean; plant: string }
  | { kind: "poison"; trials: TrialDef[]; ctx: Partial<Record<TfKey, ExclCtx>> | null; avoid: ReadonlySet<string>; answerKnowing: boolean; plant: string }
  | { kind: "presence"; trials: TrialDef[]; avoid: ReadonlySet<string>; answerKnowing: boolean; plant: string };

// One job: a run of consecutive units. cut: the targets ks of pair pi, unit j × (trials) + ti for target j and trial
// ti; poison: the probe bars (pis[q], is[q]) of trial ti, unit q; presence: the same probe bars, unit 2q (variant
// (i)) and 2q + 1 (variant (ii)). limit: the units at and after it are not computed (the check met an error there).
// want: the uncut decision of the units listed in wantAt (ascending), "none" for every other unit.
export interface UnitJob {
  ti: number;
  pi: number;
  ks: Int32Array;
  pis: Int32Array;
  is: Int32Array;
  limit: number;
  wantAt: Int32Array;
  wantStr: string[];
}

// A job's answer: the units whose recomputed decision differs from want (ascending) with that decision; done: the
// units before it were computed; err: the message of the error that stopped the job at unit `done` (null: none)
export interface UnitOut {
  mmAt: number[];
  mmGot: string[];
  done: number;
  err: string | null;
}

// poison's uncut holes per timeframe when the check was given none (exclCtxOf of the uncut timeframe, made once per
// timeframe and task: a function of the universe, avoid and plant only, which do not change within a task)
export type UnitCache = Partial<Record<TfKey, ExclCtx>>;

// Runs the jobs of one task on universe u: next() gives the jobs in order (null: no more); done(out) is called with
// the answers in that same order, whatever order they finish in; the promise ends when every job given was answered
// and done; an error thrown by done (or next) is the promise's error, the earliest in job order winning.
export interface UnitRunner {
  run(u: Universe, task: UnitTask, next: () => UnitJob | null, done: (out: UnitOut) => void): Promise<void>;
}

// every unit in this thread, one job after the other
export const inPlace: UnitRunner = {
  run: (u, task, next, done) => {
    const cache: UnitCache = {};
    try {
      for (let job = next(); job !== null; job = next()) done(runUnitJob(u, task, job, cache));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  },
};

const NO_BARS = new Int32Array(0);
// units per job: a cut job holds about CUT_UNITS_PER_JOB (target, trial) units (at least one target); poison and
// presence jobs hold this many probe bars
const CUT_UNITS_PER_JOB = 64;
const POISON_PER_JOB = 2;
const PRESENCE_PER_JOB = 1;

// the want of unit `at` of a job ("none" when not listed)
const wantOfJob = (job: UnitJob, at: number): string => {
  let lo = 0;
  let hi = job.wantAt.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (job.wantAt[m] < at) lo = m + 1;
    else hi = m;
  }
  return lo < job.wantAt.length && job.wantAt[lo] === at ? job.wantStr[lo] : "none";
};

// Cut target k of pair pi (cutCheck's loop body before C4b): the five pairs' bars with T ≤ T_k, the holes of the
// window ③ reads, and the first `count` trials of the task recomputed on that cut alone (one Ind of the cut shared
// by these trials; a finite item on its own window of the cut); each(ti, got) in trial order
export function cutGotAt(set: TfSet, c: Extract<UnitTask, { kind: "cut" }>, pi: number, k: number, count: number, each: (ti: number, got: string) => void): void {
  const tf = c.tf;
  const s = set.pairs[pi];
  const Tk = s.T[k];
  // the cut: every pair's bars with T ≤ T_k; the holes of the window ③ reads
  const cut = prefixSeries(s, Tk);
  const from = s.s[Math.max(0, k - R3_BACK)] - HOLE_MIN_SLOTS[tf] * STEP[tf];
  const starts = set.pairs.map((p) => {
    const lo = lowerBound(p.s, p.n, from);
    const hi = lowerBound(p.T, p.n, Tk + 1);
    return p.s.subarray(lo, Math.max(lo, hi));
  });
  const ctx: ExclCtx = { tf, step: STEP[tf], holes: holesOf(tf, starts, from, Tk), avoid: c.avoid, stage3: null, plant: c.plant };
  let indCut: Ind | null = null;
  for (let ti = 0; ti < count; ti++) {
    const trial = c.trials[ti];
    const fin = finiteOf(trial);
    let got: string;
    if (fin !== null && k >= fin - 1) {
      const w = windowSeries(s, k - (fin - 1), k);
      got = decisionOf(trial, indFor(w, tf, c.higher, c.plant), ctx, w, fin - 1, c);
    } else {
      indCut ??= indFor(cut, tf, c.higher, c.plant);
      got = decisionOf(trial, indCut, ctx, cut, k, c);
    }
    each(ti, got);
  }
}

// Poison's unit (poisonCheck's loop body before C4b): the decision at bar i of pair pi recomputed on that pair
// poisoned after T_i (ctx: the uncut run's holes; poison changes prices, never which bars exist)
// C4b ("share", grafted by the judge): poisonSeries may build each poisoned series from a PoisonTables, two
// alternately shifted copies of the whole uncut series made once, instead of rounding every bar after T_i again for
// each probe. The series it gives is the same, value for value, as without tables (the proof is at poisonSeries in
// lawsearch-bars.ts). One PoisonTables is kept per UnitCache: inPlace makes one UnitCache per check run, and a
// worker makes one per task it is sent (lawsearch-par-worker.ts), so the tables are made from that thread's own copy
// of the uncut series and are dropped with the cache when the check ends. They depend on the uncut series and the
// pips alone, never on a probe: each probe's poisoned series is still put together for its own bar T_i, and its Ind
// and decision are still made from that series alone.
const TABLES = new WeakMap<UnitCache, PoisonTables>();
const tablesOf = (c: UnitCache): PoisonTables => {
  let t = TABLES.get(c);
  if (!t) {
    t = poisonTables();
    TABLES.set(c, t);
  }
  return t;
};
export function poisonGotAt(set: TfSet, trial: TrialDef, ctx: ExclCtx, pi: number, i: number, o: { answerKnowing: boolean; plant: string }, tables?: PoisonTables): string {
  const s = set.pairs[pi];
  const T = s.T[i];
  const ps = poisonSeries(s, T, POISON_PIPS, tables);
  return decisionOf(trial, indFor(ps, trial.tf, readsHigher(trial), o.plant), ctx, ps, i, o);
}

// Presence's unit (presenceCheck's loop body before C4b): the decision at bar i of pair pi recomputed with bars
// deleted ((i) the pair's first two bars after T_i; (ii) every pair's bars with T > T_i and start < the next Sunday
// 22:00 UTC), the holes made again from the edited timeframe
export function presenceGotAt(u: Universe, set: TfSet, trial: TrialDef, avoid: ReadonlySet<string>, pi: number, i: number, variant: "i" | "ii", o: { answerKnowing: boolean; plant: string }): string {
  const s = set.pairs[pi];
  const T = s.T[i];
  let pairs: Series[];
  if (variant === "i") {
    const k0 = lowerBound(s.T, s.n, T + 1);
    pairs = set.pairs.map((p, q) => (q === pi ? deleteBars(p, (k) => k === k0 || k === k0 + 1) : p));
  } else {
    const until = nextSunday2200(T);
    pairs = set.pairs.map((p) => deleteBars(p, (k) => p.T[k] > T && p.s[k] < until));
  }
  const edited: TfSet = { ...set, pairs };
  const ctx = exclCtxOf(edited, avoid, u.fromMs, u.toMs, null, o.plant);
  const es = pairs[pi];
  return decisionOf(trial, indFor(es, trial.tf, readsHigher(trial), o.plant), ctx, es, i, o);
}

// One job's units, in order (the worker and inPlace both call this): each unit's decision, compared with its want
export function runUnitJob(u: Universe, task: UnitTask, job: UnitJob, cache: UnitCache): UnitOut {
  const out: UnitOut = { mmAt: [], mmGot: [], done: 0, err: null };
  const put = (at: number, got: string) => {
    if (got !== wantOfJob(job, at)) {
      out.mmAt.push(at);
      out.mmGot.push(got);
    }
    out.done = at + 1;
  };
  try {
    if (job.ti < 0 && task.kind !== "cut") {
      // an inert job: the record of an error the check met before the trial's first unit (a trial without
      // signals: the loop threw before it made the trial's uncut holes); nothing is computed
    } else if (task.kind === "cut") {
      const set = task.tf === "m15" ? u.m15 : u.h1;
      const nT = task.trials.length;
      for (let j = 0; j < job.ks.length; j++) {
        out.done = j * nT;
        cutGotAt(set, task, job.pi, job.ks[j], Math.min(nT, job.limit - j * nT), (ti, got) => put(j * nT + ti, got));
      }
    } else if (task.kind === "poison") {
      const trial = task.trials[job.ti];
      const set = trial.tf === "m15" ? u.m15 : u.h1;
      const ctx = task.ctx?.[trial.tf] ?? (cache[trial.tf] ??= exclCtxOf(set, task.avoid, u.fromMs, u.toMs, null, task.plant));
      for (let q = 0; q < job.limit; q++) put(q, poisonGotAt(set, trial, ctx, job.pis[q], job.is[q], task, tablesOf(cache)));
    } else {
      const trial = task.trials[job.ti];
      const set = trial.tf === "m15" ? u.m15 : u.h1;
      for (let x = 0; x < job.limit; x++) put(x, presenceGotAt(u, set, trial, task.avoid, job.pis[x >> 1], job.is[x >> 1], (x & 1) === 0 ? "i" : "ii", task));
    }
  } catch (e) {
    out.err = e instanceof Error ? e.message : String(e);
  }
  return out;
}

// the next job of a list of main-thread records (a generator), or null; an error of the generator itself becomes an
// inert record that carries it (none of the three generators throws but where its loop threw before its next unit:
// they read typed arrays and arrays only, and decisionOfClassified, probeBars and sampleOf have no throw)
const recordsOf = <R extends { job: UnitJob; err: unknown }>(gen: Generator<R>, queue: R[], empty: (e: unknown) => R) => {
  let over = false;
  return (): UnitJob | null => {
    if (over) return null;
    let r: R;
    try {
      const x = gen.next();
      if (x.done) {
        over = true;
        return null;
      }
      r = x.value;
    } catch (e) {
      r = empty(e);
    }
    if (r.err !== null) over = true;
    queue.push(r);
    return r.job;
  };
};
// a job without a unit (cut: no target; poison and presence: limit 0); inert (ti -1): runUnitJob computes nothing
const emptyJob = (ti: number, pi: number): UnitJob => ({ ti, pi, ks: NO_BARS, pis: NO_BARS, is: NO_BARS, limit: 0, wantAt: NO_BARS, wantStr: [] });
const inertJob = (): UnitJob => emptyJob(-1, -1);
// the error a job ends on: the unit's own (thrown on the worker; the same message), else the check's
const rethrow = (out: UnitOut, err: unknown) => {
  if (out.err !== null) throw new Error(out.err);
  if (err !== null) throw err;
};

// At each target k: the five pairs cut at T_k (bars with T ≤ T_k), the pair's indicators and every trial of the
// timeframe recomputed on the cut (a finite item on its own window), spec 6 with the cut's holes; the decision at k
// (presence, direction, status, warm-up), its reason and its stratum must equal the uncut run's. And the entry bar of
// every counted signal is the uncut series' first start ≥ T and < X. o.maxTargets (development only, never a formal
// run): at most this many targets per (tf, pair), evenly picked; the detail says so. o.name: the check's name
// (default "cut": stage 0; "cut.chosen.first" and "cut.chosen.second" for spec 23.2's cuts of the chosen trials);
// o.timeKey: the prefix of the times written to o.times (default "cut": cut.m15, cut.h1); o.maxExamples: how many
// failing bars each trial's probe lists (default 5); o.note: appended to the detail (the targets by kind). o.fails
// (C3, the lead's D6; lawsearch-dump.md 8 cut_fail.csv): every failing bar is pushed to o.fails.rows with the check's
// name and o.fails.stage, whatever the caps above (spec 23.2 その試しの名前と外れた足を出す), with the bar's start s and
// close T (C4a, the lead's E7: T is the time the detail prints, so the two can be matched).
// Plant chosenCutFirstDiff (design 8, C3): in the check "cut.chosen.first" only, the cut decision of the first target
// of the first trial given (the first chosen trial in table order) gets a planted mark, so that this check fails on a
// chosen trial and the stop before stage 2 (design 7.7) runs end to end; nothing else changes.
// o.runner (C4b): where the units run (inPlace when not given; the result is the same bytes either way, see above).
export async function cutCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], targets: CutTarget[], avoid: ReadonlySet<string>, o: { answerKnowing: boolean; plant: string; maxTargets?: number; times?: Record<string, number>; name?: string; timeKey?: string; maxExamples?: number; note?: string; fails?: { stage: string; rows: CutFailRow[] }; runner?: UnitRunner }): Promise<CheckResult> {
  const cap = o.maxExamples ?? MAX_EXAMPLES;
  const name = o.name ?? "cut";
  // cut_fail.csv's text of a decision: each candidate "d:status:warm:reason:stratum", the candidates joined by ";",
  // empty for no candidate (lawsearch-dump.md 8)
  const failText = (d: string) => (d === "none" ? "" : d.split("|").join(";"));
  // bar k of series s: its start s.s[k] and close s.T[k] (for "entry", k is the signal bar)
  const fail = (trial: TrialDef, pi: number, s: Series, k: number, kinds: string, cut: string, uncut: string) => {
    if (o.fails) o.fails.rows.push({ check: name, stage: o.fails.stage, trial: trial.id, order: trial.order, pi, k, s: s.s[k], T: s.T[k], kinds, cut, uncut });
  };
  let planted = o.plant === "chosenCutFirstDiff" && name === "cut.chosen.first" && trials.length > 0 ? trials[0].id : null;
  const probes = new Map<string, Probe>();
  for (const t of trials) probes.set(t.id, probeOf(t.id));
  const sigOf = new Map(sigs.map((s) => [s.trial.id, s]));
  const capped: string[] = [];
  const runner = o.runner ?? inPlace;
  for (const tf of ["m15", "h1"] as const) {
    const t0 = Date.now();
    const set = tf === "m15" ? u.m15 : u.h1;
    const tfTrials = trials.filter((t) => t.tf === tf);
    if (tfTrials.length === 0) continue;
    const higher = tfTrials.some(readsHigher);
    const nT = tfTrials.length;
    const per = Math.max(1, Math.floor(CUT_UNITS_PER_JOB / nT));
    // the jobs in the loop's order: pair by pair, `per` targets at a time, each with the uncut decision of its units
    // (made here, from the uncut run's signals) and the error met while making them (the loop stops there)
    interface Rec {
      job: UnitJob;
      s: Series;
      ts: CutTarget[];
      err: unknown;
    }
    const queue: Rec[] = [];
    const recs = function* (): Generator<Rec> {
      for (let pi = 0; pi < PAIRS.length; pi++) {
        let ts = targets.filter((x) => x.tf === tf && x.pi === pi);
        if (o.maxTargets !== undefined && ts.length > o.maxTargets) {
          const m = o.maxTargets;
          const all = ts;
          ts = Array.from({ length: m }, (_, j) => all[Math.floor((j * (all.length - 1)) / Math.max(1, m - 1))]);
          capped.push(`${tf} ${PAIRS[pi]} ${m} of ${all.length}`);
        }
        const s = set.pairs[pi];
        for (let a = 0; a < ts.length; a += per) {
          const chunk = ts.slice(a, a + per);
          const wantAt: number[] = [];
          const wantStr: string[] = [];
          let limit = 0;
          let err: unknown = null;
          try {
            for (let j = 0; j < chunk.length; j++) {
              for (let ti = 0; ti < nT; ti++) {
                limit = j * nT + ti;
                const sig = sigOf.get(tfTrials[ti].id)!;
                const want = decisionOfClassified(sig.pairs[pi], s, chunk[j].k);
                if (want !== "none") {
                  wantAt.push(limit);
                  wantStr.push(want);
                }
              }
            }
            limit = chunk.length * nT;
          } catch (e) {
            err = e;
          }
          const nk = err === null ? chunk.length : Math.floor(limit / nT) + 1;
          yield { job: { ti: -1, pi, ks: Int32Array.from(chunk.slice(0, nk), (t) => t.k), pis: NO_BARS, is: NO_BARS, limit, wantAt: Int32Array.from(wantAt), wantStr }, s, ts: chunk, err };
          if (err !== null) return;
        }
      }
    };
    const next = recordsOf(recs(), queue, (e) => ({ job: inertJob(), s: set.pairs[0], ts: [], err: e }));
    // the replay of one job's units in the loop's order: compared for every unit done, then each unit that differs
    // (and the planted one) in order: the example, the cut_fail.csv row; then the job's error, if any
    const done = (out: UnitOut) => {
      const { job, s, ts: chunk, err } = queue.shift()!;
      const end = Math.min(out.done, job.limit);
      const full = Math.floor(end / nT);
      const rem = end % nT;
      for (let ti = 0; ti < nT; ti++) probes.get(tfTrials[ti].id)!.compared += full + (ti < rem ? 1 : 0);
      // the planted trial's first unit in the timeframe is unit tp of its first job (the first target, trial tp)
      const tp = planted === null ? -1 : tfTrials.findIndex((t) => t.id === planted);
      const gotOf = new Map<number, string>();
      const units: number[] = [];
      out.mmAt.forEach((at, g) => {
        if (at >= end) return;
        gotOf.set(at, out.mmGot[g]);
        units.push(at);
      });
      if (tp >= 0 && tp < end && !gotOf.has(tp)) units.push(tp);
      units.sort((a, b) => a - b);
      for (const at of units) {
        const j = Math.floor(at / nT);
        const trial = tfTrials[at % nT];
        const tg = chunk[j];
        const k = tg.k;
        const want = wantOfJob(job, at);
        let got = gotOf.get(at) ?? want;
        if (planted === trial.id) {
          got += "|planted";
          planted = null;
        }
        if (got !== want) {
          miss(probes.get(trial.id)!, `${PAIRS[job.pi]} ${iso(s.T[k])} k=${k} [${tg.kinds.join("+")}] cut ${got} uncut ${want}`, cap);
          fail(trial, job.pi, s, k, tg.kinds.join("|"), failText(got), failText(want));
        }
      }
      rethrow(out, err);
    };
    await runner.run(u, { kind: "cut", tf, trials: tfTrials, higher, avoid, answerKnowing: o.answerKnowing, plant: o.plant }, next, done);
    // spec 7 / 15: the entry bar of every counted signal is the uncut series' first start ≥ T and < X
    for (const trial of tfTrials) {
      const probe = probes.get(trial.id)!;
      for (const c of sigOf.get(trial.id)!.pairs) {
        const s = set.pairs[c.pi];
        for (let r = 0; r < c.n; r++) {
          if (c.reason[r] !== RI.counted) continue;
          const T = c.T[r];
          const X = c.X[r];
          let j = -1;
          for (let q = c.i[r] + 1; q < s.n; q++) {
            if (s.s[q] >= X) break;
            if (s.s[q] >= T) {
              j = q;
              break;
            }
          }
          const e = entryExitIndex(s, T, X);
          probe.compared++;
          if ((e === null ? -1 : e.j) !== j) {
            miss(probe, `${PAIRS[c.pi]} ${iso(T)} entry ${e?.j} first start ${j}`, cap);
            fail(trial, c.pi, s, c.i[r], "entry", e === null ? "" : String(e.j), j < 0 ? "" : String(j));
          }
        }
      }
    }
    if (o.times) o.times[`${o.timeKey ?? "cut"}.${tf}`] = Date.now() - t0;
  }
  const extra = (capped.length ? `DEVELOPMENT CAP: ${capped.join("; ")}` : `${targets.length} targets`) + (o.note ? ` (${o.note})` : "");
  return resultOf(name, [...probes.values()], extra);
}

// the signals and the bars without a signal of each trial that poison and presence look at (sampleOf, seed)
const probeBars = (sig: TrialSignals, set: TfSet, n: number, seed: number): { signals: Array<[number, number]>; quiet: Array<[number, number]> } => {
  const signals: Array<[number, number]> = [];
  const has = set.pairs.map((s) => new Uint8Array(s.n));
  for (const c of sig.pairs) {
    for (let r = 0; r < c.n; r++) {
      if (r > 0 && c.i[r] === c.i[r - 1]) continue;
      signals.push([c.pi, c.i[r]]);
      has[c.pi][c.i[r]] = 1;
    }
  }
  const quiet: Array<[number, number]> = [];
  set.pairs.forEach((s, pi) => {
    for (let i = 0; i < s.n; i++) if (!has[pi][i]) quiet.push([pi, i]);
  });
  return { signals: sampleOf(signals, n, seed), quiet: sampleOf(quiet, n, seed) };
};

// The probe bars of poison and presence as jobs, trial by trial in the given order (o.only skips), `per` bars a job
// (at least one job per trial, so that a trial without a probe bar still reaches its worker as the loop reached it:
// poison's worker makes the trial's uncut holes when the check was given none, as the loop did before its probes).
// Each record keeps the bars' kind (signal, quiet) and T for the examples, and the probe of its trial. An error is
// placed where the loop met it: a trial without signals, an inert record (the loop threw before the trial's holes);
// probeBars', a job of the trial with no unit (after the holes); an uncut decision's at probe q, a job that ends
// before q's units (after the units before them).
interface ProbeRec {
  job: UnitJob;
  probe: Probe;
  kinds: string[];
  times: number[];
  err: unknown;
}
function* probeRecs(u: Universe, trials: TrialDef[], sigs: TrialSignals[], what: "poisonCheck" | "presenceCheck", n: number, seed: number, only: string[] | undefined, per: number, variants: number, probes: Probe[], withQuiet: boolean): Generator<ProbeRec> {
  for (let ti = 0; ti < trials.length; ti++) {
    const trial = trials[ti];
    if (only && !only.includes(trial.id)) continue;
    const sig = sigs.find((s) => s.trial.id === trial.id);
    if (!sig) {
      yield { job: inertJob(), probe: probeOf(trial.id), kinds: [], times: [], err: new Error(`${what}: no signals of ${trial.id}`) };
      return;
    }
    const set = trial.tf === "m15" ? u.m15 : u.h1;
    const probe = probeOf(trial.id);
    probes.push(probe);
    let bars: { signals: Array<[number, number]>; quiet: Array<[number, number]> };
    try {
      bars = probeBars(sig, set, n, seed);
    } catch (e) {
      yield { job: emptyJob(ti, -1), probe, kinds: [], times: [], err: e };
      return;
    }
    const { signals, quiet } = bars;
    const list: Array<[string, number, number]> = [...signals.map(([pi, i]) => ["signal", pi, i] as [string, number, number]), ...(withQuiet ? quiet.map(([pi, i]) => ["quiet", pi, i] as [string, number, number]) : [])];
    for (let a = 0; a === 0 || a < list.length; a += per) {
      const chunk = list.slice(a, a + per);
      const wantAt: number[] = [];
      const wantStr: string[] = [];
      let nq = 0;
      let err: unknown = null;
      try {
        for (; nq < chunk.length; nq++) {
          const [, pi, i] = chunk[nq];
          const want = decisionOfClassified(sig.pairs[pi], set.pairs[pi], i);
          for (let v = 0; v < variants; v++) {
            if (want === "none") continue;
            wantAt.push(nq * variants + v);
            wantStr.push(want);
          }
        }
      } catch (e) {
        err = e;
      }
      yield {
        job: { ti, pi: -1, ks: NO_BARS, pis: Int32Array.from(chunk, (x) => x[1]), is: Int32Array.from(chunk, (x) => x[2]), limit: nq * variants, wantAt: Int32Array.from(wantAt), wantStr },
        probe,
        kinds: chunk.map((x) => x[0]),
        times: chunk.map((x) => set.pairs[x[1]].T[x[2]]),
        err,
      };
      if (err !== null) return;
    }
  }
}

// spec 15 毒 (and 13 (ii): n 1,000, seed 419, only the hit trials): the trial's timeframe's five pairs get ±777.7 pips
// alternately on every bar with T > T_signal; everything the decision at T reads is recomputed; decision and reason
// at T must be equal. 100 signals and 100 bars without a signal per trial. o.runner (C4b): where the units run.
export async function poisonCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { n: number; seed: number; answerKnowing: boolean; plant: string; only?: string[]; ctx?: Record<TfKey, ExclCtx>; runner?: UnitRunner }): Promise<CheckResult> {
  const probes: Probe[] = [];
  const queue: ProbeRec[] = [];
  const next = recordsOf(probeRecs(u, trials, sigs, "poisonCheck", o.n, o.seed, o.only, POISON_PER_JOB, 1, probes, true), queue, (e) => ({ job: inertJob(), probe: probeOf(""), kinds: [], times: [], err: e }));
  const done = (out: UnitOut) => {
    const { job, probe, kinds, times, err } = queue.shift()!;
    const end = Math.min(out.done, job.limit);
    probe.compared += end;
    for (let g = 0; g < out.mmAt.length && out.mmAt[g] < end; g++) {
      const q = out.mmAt[g];
      miss(probe, `${kinds[q]} ${PAIRS[job.pis[q]]} ${iso(times[q])} poisoned ${out.mmGot[g]} clean ${wantOfJob(job, q)}`);
    }
    rethrow(out, err);
  };
  await (o.runner ?? inPlace).run(u, { kind: "poison", trials, ctx: o.ctx ?? null, avoid, answerKnowing: o.answerKnowing, plant: o.plant }, next, done);
  return resultOf(o.n === POISON_N ? "poison" : `poison${o.n}`, probes, `n ${o.n}, seed ${o.seed}`);
}

// the next Sunday 22:00 UTC after t
const nextSunday2200 = (t: number): number => {
  const d = new Date(t);
  const day = d.getUTCDay();
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let c = midnight + ((7 - day) % 7) * DAY + 22 * 3_600_000;
  if (c <= t) c += WEEK;
  return c;
};

// spec 15 有無の毒 (the same 100 signals as the poison): (i) the first two bars with T > T_signal of the signal's pair
// deleted; (ii) every bar with T > T_signal and start < the next Sunday 22:00 UTC deleted from all five pairs of the
// trial's timeframe (11 O-8). The holes and every value are recomputed; the decision at T must be equal. o.runner
// (C4b): where the units run.
export async function presenceCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { seed: number; answerKnowing: boolean; plant: string; only?: string[]; n?: number; runner?: UnitRunner }): Promise<CheckResult> {
  const probes: Probe[] = [];
  const n = o.n ?? POISON_N;
  const queue: ProbeRec[] = [];
  const next = recordsOf(probeRecs(u, trials, sigs, "presenceCheck", n, o.seed, o.only, PRESENCE_PER_JOB, 2, probes, false), queue, (e) => ({ job: inertJob(), probe: probeOf(""), kinds: [], times: [], err: e }));
  const done = (out: UnitOut) => {
    const { job, probe, times, err } = queue.shift()!;
    const end = Math.min(out.done, job.limit);
    probe.compared += end;
    for (let g = 0; g < out.mmAt.length && out.mmAt[g] < end; g++) {
      const x = out.mmAt[g];
      miss(probe, `(${(x & 1) === 0 ? "i" : "ii"}) ${PAIRS[job.pis[x >> 1]]} ${iso(times[x >> 1])} deleted ${out.mmGot[g]} whole ${wantOfJob(job, x)}`);
    }
    rethrow(out, err);
  };
  await (o.runner ?? inPlace).run(u, { kind: "presence", trials, avoid, answerKnowing: o.answerKnowing, plant: o.plant }, next, done);
  return resultOf("presence", probes, `seed ${o.seed}`);
}

// ---- spec 15 h1Only, stage 1 = stage 0, adds up, donchian ----------------------------------------------------

// spec 10 / 15 h1Only: every bar stage 1 built (both timeframes, the higher bars too) has closed by SPLIT
export function h1OnlyCheck(u1: Universe): CheckResult {
  const p = probeOf("h1Only");
  for (const set of [u1.m15, u1.h1]) {
    for (const s of [...set.pairs, ...set.htf]) {
      for (let i = 0; i < s.n; i++) {
        p.compared++;
        if (!(s.T[i] <= SPLIT)) miss(p, `${s.pair} ${s.key} ${iso(s.s[i])} closes ${iso(s.T[i])}`);
      }
    }
  }
  return resultOf("h1Only", [p]);
}

// stage 1's first-half rows (half = 1: pair, bar, direction, status, warm-up, reason) equal stage 0's, trial by trial
export function sameFirstHalfCheck(s0: TrialSignals[], s1: TrialSignals[]): CheckResult {
  const rowsOf = (sig: TrialSignals): string[] => {
    const out: string[] = [];
    for (const c of sig.pairs) for (let r = 0; r < c.n; r++) if (c.half[r] === 1) out.push(`${c.pi}:${c.i[r]}:${c.d[r]}:${c.status[r]}:${c.warmOk[r]}:${c.reason[r]}`);
    return out;
  };
  const probes: Probe[] = [];
  for (const a of s0) {
    const p = probeOf(a.trial.id);
    const b = s1.find((x) => x.trial.id === a.trial.id);
    if (!b) {
      miss(p, "not in stage 1");
      probes.push(p);
      continue;
    }
    const ra = rowsOf(a);
    const rb = rowsOf(b);
    p.compared = Math.max(ra.length, rb.length);
    if (ra.length !== rb.length) miss(p, `stage 0 ${ra.length} rows, stage 1 ${rb.length}`);
    for (let k = 0; k < Math.min(ra.length, rb.length); k++) if (ra[k] !== rb[k]) miss(p, `row ${k}: stage 0 ${ra[k]}, stage 1 ${rb[k]}`);
    probes.push(p);
  }
  return resultOf("sameFirstHalf", probes);
}

export function addsUpCheck(rows: ReadonlyArray<{ trial: string; addsUp: boolean }>): CheckResult {
  return resultOf("addsUp", rows.map((r) => {
    const p = probeOf(r.trial);
    p.compared = 1;
    if (!r.addsUp) miss(p, "emitted ≠ Σ reasons + counted");
    return p;
  }));
}

// spec 15 項目ごとの確かめ: E26's target s = bigflow-lib donchianState(c, 20) on every bar (inds: per timeframe, PAIRS
// order)
export function donchianCheck(u: Universe, inds: Record<TfKey, Ind[]>): CheckResult {
  const probes: Probe[] = [];
  for (const set of [u.m15, u.h1]) {
    set.pairs.forEach((s, pi) => {
      const p = probeOf(`donchian ${set.tf} ${s.pair}`);
      const mine = inds[set.tf][pi].donchian(20).s;
      const candles = Array.from({ length: s.n }, (_, i) => ({ datetime: "", open: s.O[i], high: s.H[i], low: s.L[i], close: s.C[i] }));
      const theirs = donchianState(candles, 20);
      for (let i = 0; i < s.n; i++) {
        p.compared++;
        if (mine[i] !== theirs[i]) miss(p, `${iso(s.s[i])} i=${i}: ${mine[i]} vs donchianState ${theirs[i]}`);
      }
      probes.push(p);
    });
  }
  return resultOf("donchian", probes);
}

// ---- 13 (iv): six trades retraced from the raw files (no loadTf, no mergeSides) ---------------------------------

interface RawRow {
  openTime: number;
  open: string;
  close: string;
}
const readSide = async (path: string): Promise<RawRow[]> => {
  try {
    const j = JSON.parse(await Deno.readTextFile(path));
    if (!j || !Array.isArray(j.data)) return [];
    return (j.data as Array<Record<string, unknown>>).filter((r) => r && typeof r === "object" && typeof r.openTime === "string").map((r) => ({ openTime: Number(r.openTime), open: String(r.open), close: String(r.close) }));
  } catch {
    return [];
  }
};

// rows: trades to retrace (pair, tf, T, d, and the run's pl and m in points). The bars are found by openTime in the
// day files jstDayKey(T − 1 day) … jstDayKey(X + 1 day); a start is a bar when it has a Bid row and an Ask row (the
// last Ask row of the start; the first Bid row whose close ≤ that Ask close). Entry: the first start ≥ T and < X;
// exit: the bar that closes at X, else the last one with start ≥ the entry's and close ≤ X.
export async function retraceCheck(runDir: string, rows: ReadonlyArray<{ pair: string; tf: TfKey; T: number; d: 1 | -1; pl: number; m: number }>): Promise<CheckResult> {
  const p = probeOf("retrace");
  for (const r of rows) {
    const step = STEP[r.tf];
    const X = r.T + N_BARS * step;
    const sym = GMO_SYMBOLS[r.pair];
    const interval = GMO_INTERVALS[r.tf === "m15" ? "15min" : "1h"].name;
    const keys = new Set<string>();
    for (let t = r.T - DAY; t <= X + DAY; t += DAY / 2) keys.add(jstDayKey(t));
    const bid = new Map<number, RawRow[]>();
    const ask = new Map<number, RawRow>();
    for (const key of [...keys].sort()) {
      for (const b of await readSide(`${runDir}/gmo/${sym}/${interval}/bid/${key}.json`)) {
        if (!bid.has(b.openTime)) bid.set(b.openTime, []);
        bid.get(b.openTime)!.push(b);
      }
      for (const a of await readSide(`${runDir}/gmo/${sym}/${interval}/ask/${key}.json`)) ask.set(a.openTime, a);
    }
    const mult = POINTS_PER_PRICE(r.pair);
    const dg = MID_DIGITS(r.pair);
    const bars: Array<{ s: number; bo: number; bc: number; ao: number; ac: number }> = [];
    for (const [s, list] of bid) {
      const a = ask.get(s);
      if (!a || s < r.T - step || s >= X) continue;
      const b = list.find((x) => Number(a.close) >= Number(x.close));
      if (!b) continue;
      bars.push({ s, bo: Number(b.open), bc: Number(b.close), ao: Number(a.open), ac: Number(a.close) });
    }
    bars.sort((x, y) => x.s - y.s);
    const j = bars.findIndex((b) => b.s >= r.T && b.s < X);
    p.compared++;
    if (j < 0) {
      miss(p, `${r.pair} ${r.tf} ${iso(r.T)}: no entry bar in the raw files`);
      continue;
    }
    let x = -1;
    for (let q = j; q < bars.length; q++) if (bars[q].s + step <= X) x = q;
    const pts = (v: number) => Math.round(v * mult);
    const mid = (b: number, a: number) => Number(((b + a) / 2).toFixed(dg));
    const pc = pts(mid(bars[x].bc, bars[x].ac));
    const po = pts(mid(bars[j].bo, bars[j].ao));
    const m = r.d * (pc - po);
    const pl = r.d === 1 ? pts(bars[x].bc) - pts(bars[j].ao) : pts(bars[j].bo) - pts(bars[x].ac);
    if (m !== r.m || pl !== r.pl) miss(p, `${r.pair} ${r.tf} ${iso(r.T)} d=${r.d}: raw m ${m} pl ${pl}, run m ${r.m} pl ${r.pl}`);
  }
  return resultOf("retrace", [p]);
}

// ---- 15 出してよい項目 ----------------------------------------------------------------------------------------

// the keys print.txt may hold (any other key stops the print)
export const PRINT_KEYS: readonly RegExp[] = [
  /^run$/,
  /^mode$/,
  /^group$/,
  /^seed$/,
  /^flip$/,
  /^plant$/,
  /^trials$/,
  /^kappa\.(delta|pl|from)$/,
  /^g\.from$/,
  /^time\.(gen|stage0|stage1|stage2|cut\.m15|cut\.h1|cut\.chosen\.(first|second)\.(m15|h1)|checks|total)\.ms$/,
  /^check\.[A-Za-z0-9_.]+\.(passed|detail)$/,
  /^count\.(stage0|stage1|stage2)\.[A-Za-z0-9_.]+$/,
  /^floor\.(m15|h1)$/,
  /^groups\.(m15|h1)$/,
  /^same\.[A-Za-z0-9_.]+$/,
  /^chosen\.(m15|h1)$/,
  /^K_total$/,
  /^verdict\.[A-Za-z0-9_.]+$/,
  /^note\.[a-z0-9_]+$/,
  /^withheld\.(stage0|stage1|stage2)$/,
  /^exit$/,
];

export function printCheck(keys: readonly string[]): CheckResult {
  const p = probeOf("print");
  for (const k of keys) {
    p.compared++;
    if (!PRINT_KEYS.some((re) => re.test(k))) miss(p, `key ${k} is not in the print list`);
  }
  return resultOf("print", [p]);
}

// ---- sampling (trend-stats' mulberry32 + Fisher–Yates) ----------------------------------------------------------

// the first n of xs shuffled with mulberry32(seed); xs itself (in order) when it has n or fewer
export function sampleOf<T>(xs: readonly T[], n: number, seed: number): T[] {
  if (xs.length <= n) return xs.slice();
  const a = xs.slice();
  shuffle(a, mulberry32(seed));
  return a.slice(0, n);
}

// the timeframe's ExclCtx of a whole universe (the uncut run's)
export const ctxOfUniverse = (u: Universe, avoid: ReadonlySet<string>, plant: string): Record<TfKey, ExclCtx> => ({
  m15: exclCtxOf(u.m15, avoid, u.fromMs, u.toMs, null, plant),
  h1: exclCtxOf(u.h1, avoid, u.fromMs, u.toMs, null, plant),
});
