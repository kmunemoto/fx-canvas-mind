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

import { checkConstants, checkFiles, HIGHER, MID_DIGITS, N_BARS, PAIRS, POINTS_PER_PRICE, SPLIT, STEP } from "./lawsearch-const.ts";
import { CUT_DAY_BARS, CUT_EVEN, CUT_GAP_BARS, CUT_HTF_BARS, CUT_SAMPLE, HOLE_MIN_SLOTS, POISON_N, POISON_PIPS, R3_BACK, REASONS, SEEDS, STATUS } from "./lawsearch-rules.ts";
import { coarsenSeries, deleteBars, entryExitIndex, htfIndex, poisonSeries, prefixSeries, stratumOf, windowSeries } from "./lawsearch-bars.ts";
import { indOf } from "./lawsearch-ind.ts";
import { parseCandidates } from "./lawsearch-items.ts";
import { candidatesOf, exclCtxOf, holesOf, reasonOf } from "./lawsearch-events.ts";
import { donchianState } from "./bigflow-lib.ts";
import { mulberry32, shuffle } from "./trend-stats.ts";
import { GMO_INTERVALS, GMO_SYMBOLS, jstDayKey } from "../supabase/functions/track-outcomes/quotes.ts";
import { DAY, WEEK } from "./lib.ts";
import type { CheckResult, Classified, ExclCtx, Ind, Probe, Series, TfKey, TfSet, TrialDef, TrialSignals, Universe } from "./lawsearch-types.ts";

const RI = Object.fromEntries(REASONS.map((r, k) => [r, k])) as Record<string, number>;
const MAX_EXAMPLES = 5;

// ---- helpers ----------------------------------------------------------------------------------------------------

const probeOf = (name: string): Probe => ({ name, compared: 0, mismatched: 0, examples: [] });
const miss = (p: Probe, what: string) => {
  p.mismatched++;
  if (p.examples.length < MAX_EXAMPLES) p.examples.push(what);
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

// the decision at bar i (of series s, whose Ind is ind) recomputed: candidatesOf, then spec 6 on the rows at i
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

// Per trial: every signal (every row of Classified, any reason; over 3,000 → sampleOf(…, 3000, 318)); per trial and
// pair: 300 evenly spaced bars, the 10 bars before every gap (open to open over one step), the 2 bars before each day
// boundary (dayOf changes) and the 2 before each higher-timeframe boundary. Deduplicated per (tf, pi, k), sorted.
export function cutTargets(u: Universe, trials: TrialDef[], sigs: TrialSignals[]): CutTarget[] {
  const map = new Map<string, CutTarget>();
  const add = (tf: TfKey, pi: number, k: number, kind: string) => {
    if (k < 0) return;
    const key = `${tf}:${pi}:${k}`;
    const t = map.get(key);
    if (t) {
      if (!t.kinds.includes(kind)) t.kinds.push(kind);
    } else map.set(key, { tf, pi, k, kinds: [kind] });
  };
  for (const sig of sigs) {
    const rows: Array<[number, number]> = [];
    for (const c of sig.pairs) for (let r = 0; r < c.n; r++) rows.push([c.pi, c.i[r]]);
    const pick = rows.length > CUT_SAMPLE ? sampleOf(rows, CUT_SAMPLE, SEEDS.cut) : rows;
    for (const [pi, k] of pick) add(sig.tf, pi, k, "signal");
  }
  const tfs = new Set(trials.map((t) => t.tf));
  for (const tf of tfs) {
    const set = tf === "m15" ? u.m15 : u.h1;
    const step = STEP[tf];
    const hstep = HIGHER[tf];
    set.pairs.forEach((s, pi) => {
      if (s.n === 0) return;
      for (let j = 0; j < CUT_EVEN; j++) add(tf, pi, Math.floor((j * (s.n - 1)) / (CUT_EVEN - 1)), "even");
      for (let k = 1; k < s.n; k++) {
        if (s.s[k] - s.s[k - 1] > step) for (let b = 1; b <= CUT_GAP_BARS; b++) add(tf, pi, k - b, "gap");
        if (s.day[k] !== s.day[k - 1]) for (let b = 1; b <= CUT_DAY_BARS; b++) add(tf, pi, k - b, "day");
        if (Math.floor(s.s[k] / hstep) !== Math.floor(s.s[k - 1] / hstep)) for (let b = 1; b <= CUT_HTF_BARS; b++) add(tf, pi, k - b, "htf");
      }
    });
  }
  return [...map.values()].sort((a, b) => (a.tf === b.tf ? 0 : a.tf === "m15" ? -1 : 1) || a.pi - b.pi || a.k - b.k);
}

// At each target k: the five pairs cut at T_k (bars with T ≤ T_k), the pair's indicators and every trial of the
// timeframe recomputed on the cut (a finite item on its own window), spec 6 with the cut's holes; the decision at k
// (presence, direction, status, warm-up), its reason and its stratum must equal the uncut run's. And the entry bar of
// every counted signal is the uncut series' first start ≥ T and < X. o.maxTargets (development only, never a formal
// run): at most this many targets per (tf, pair), evenly picked; the detail says so.
export function cutCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], targets: CutTarget[], avoid: ReadonlySet<string>, o: { answerKnowing: boolean; plant: string; maxTargets?: number; times?: Record<string, number> }): CheckResult {
  const probes = new Map<string, Probe>();
  for (const t of trials) probes.set(t.id, probeOf(t.id));
  const sigOf = new Map(sigs.map((s) => [s.trial.id, s]));
  const capped: string[] = [];
  for (const tf of ["m15", "h1"] as const) {
    const t0 = Date.now();
    const set = tf === "m15" ? u.m15 : u.h1;
    const tfTrials = trials.filter((t) => t.tf === tf);
    if (tfTrials.length === 0) continue;
    const higher = tfTrials.some(readsHigher);
    for (let pi = 0; pi < PAIRS.length; pi++) {
      let ts = targets.filter((x) => x.tf === tf && x.pi === pi);
      if (o.maxTargets !== undefined && ts.length > o.maxTargets) {
        const m = o.maxTargets;
        const all = ts;
        ts = Array.from({ length: m }, (_, j) => all[Math.floor((j * (all.length - 1)) / Math.max(1, m - 1))]);
        capped.push(`${tf} ${PAIRS[pi]} ${m} of ${all.length}`);
      }
      const s = set.pairs[pi];
      for (const tg of ts) {
        const k = tg.k;
        const Tk = s.T[k];
        // the cut: every pair's bars with T ≤ T_k; the holes of the window ③ reads
        const cut = prefixSeries(s, Tk);
        const from = s.s[Math.max(0, k - R3_BACK)] - HOLE_MIN_SLOTS[tf] * STEP[tf];
        const starts = set.pairs.map((p) => {
          const lo = lowerBound(p.s, p.n, from);
          const hi = lowerBound(p.T, p.n, Tk + 1);
          return p.s.subarray(lo, Math.max(lo, hi));
        });
        const ctx: ExclCtx = { tf, step: STEP[tf], holes: holesOf(tf, starts, from, Tk), avoid, stage3: null, plant: o.plant };
        let indCut: Ind | null = null;
        for (const trial of tfTrials) {
          const probe = probes.get(trial.id)!;
          const sig = sigOf.get(trial.id)!;
          const want = decisionOfClassified(sig.pairs[pi], s, k);
          const fin = finiteOf(trial);
          let got: string;
          if (fin !== null && k >= fin - 1) {
            const w = windowSeries(s, k - (fin - 1), k);
            got = decisionOf(trial, indFor(w, tf, higher, o.plant), ctx, w, fin - 1, o);
          } else {
            indCut ??= indFor(cut, tf, higher, o.plant);
            got = decisionOf(trial, indCut, ctx, cut, k, o);
          }
          probe.compared++;
          if (got !== want) miss(probe, `${PAIRS[pi]} ${iso(Tk)} k=${k} [${tg.kinds.join("+")}] cut ${got} uncut ${want}`);
        }
      }
    }
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
          if ((e === null ? -1 : e.j) !== j) miss(probe, `${PAIRS[c.pi]} ${iso(T)} entry ${e?.j} first start ${j}`);
        }
      }
    }
    if (o.times) o.times[`cut.${tf}`] = Date.now() - t0;
  }
  return resultOf("cut", [...probes.values()], capped.length ? `DEVELOPMENT CAP: ${capped.join("; ")}` : `${targets.length} targets`);
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

// spec 15 毒 (and 13 (ii): n 1,000, seed 419, only the hit trials): the trial's timeframe's five pairs get ±777.7 pips
// alternately on every bar with T > T_signal; everything the decision at T reads is recomputed; decision and reason
// at T must be equal. 100 signals and 100 bars without a signal per trial.
export function poisonCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { n: number; seed: number; answerKnowing: boolean; plant: string; only?: string[]; ctx?: Record<TfKey, ExclCtx> }): CheckResult {
  const probes: Probe[] = [];
  for (const trial of trials) {
    if (o.only && !o.only.includes(trial.id)) continue;
    const sig = sigs.find((s) => s.trial.id === trial.id);
    if (!sig) throw new Error(`poisonCheck: no signals of ${trial.id}`);
    const set = trial.tf === "m15" ? u.m15 : u.h1;
    const ctx = o.ctx?.[trial.tf] ?? exclCtxOf(set, avoid, u.fromMs, u.toMs, null, o.plant);
    const probe = probeOf(trial.id);
    const { signals, quiet } = probeBars(sig, set, o.n, o.seed);
    for (const [kind, list] of [["signal", signals], ["quiet", quiet]] as const) {
      for (const [pi, i] of list) {
        const s = set.pairs[pi];
        const T = s.T[i];
        const want = decisionOfClassified(sig.pairs[pi], s, i);
        const ps = poisonSeries(s, T, POISON_PIPS);
        const got = decisionOf(trial, indFor(ps, trial.tf, readsHigher(trial), o.plant), ctx, ps, i, o);
        probe.compared++;
        if (got !== want) miss(probe, `${kind} ${PAIRS[pi]} ${iso(T)} poisoned ${got} clean ${want}`);
      }
    }
    probes.push(probe);
  }
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
// trial's timeframe (11 O-8). The holes and every value are recomputed; the decision at T must be equal.
export function presenceCheck(u: Universe, trials: TrialDef[], sigs: TrialSignals[], avoid: ReadonlySet<string>, o: { seed: number; answerKnowing: boolean; plant: string; only?: string[]; n?: number }): CheckResult {
  const probes: Probe[] = [];
  const n = o.n ?? POISON_N;
  for (const trial of trials) {
    if (o.only && !o.only.includes(trial.id)) continue;
    const sig = sigs.find((s) => s.trial.id === trial.id);
    if (!sig) throw new Error(`presenceCheck: no signals of ${trial.id}`);
    const set = trial.tf === "m15" ? u.m15 : u.h1;
    const probe = probeOf(trial.id);
    const { signals } = probeBars(sig, set, n, o.seed);
    for (const [pi, i] of signals) {
      const s = set.pairs[pi];
      const T = s.T[i];
      const want = decisionOfClassified(sig.pairs[pi], s, i);
      for (const variant of ["i", "ii"] as const) {
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
        const got = decisionOf(trial, indFor(es, trial.tf, readsHigher(trial), o.plant), ctx, es, i, o);
        probe.compared++;
        if (got !== want) miss(probe, `(${variant}) ${PAIRS[pi]} ${iso(T)} deleted ${got} whole ${want}`);
      }
    }
    probes.push(probe);
  }
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
  /^time\.(gen|stage0|stage1|stage2|cut\.m15|cut\.h1|checks|total)\.ms$/,
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
