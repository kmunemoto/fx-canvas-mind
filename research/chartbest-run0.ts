// #318 (docs §8.113 11, 20 (a), (b)): the parts of a run that stage 0 also runs — the configuration, the gates
// read before any bar (the ledger's sha256, the spread table, the hand examples), the data checks, the items'
// and the emails' signals and their own checks (donchianState, the measures' equality, the look-ahead checks
// of the items). Rule 11: stage 0 loads no follow code, so nothing here imports the follow, the blind table,
// the statistics or the selection (research/chartbest-stage0.ts's import graph is checked in CI).

import { CANDIDATES, ITEM_TABLE, MEASURES, type Period, SPREAD_HOURS, periodOf } from "./chartbest-const.ts";
import { type Checks, Log } from "./chartbest-checks.ts";
import { type RunBars, type SourceSigs, itemSigs, measureSigs } from "./chartbest-core.ts";
import type { Stage0 } from "./chartbest-count.ts";
import { crossedOk, crossedWorst, fileSha, readLine } from "./chartbest-data.ts";
import { itemsOf } from "./chartbest-items.ts";
import { type Probe, macdProbes, readerEquality, readerOf, ultraProbes, candlesOf } from "./chartbest-measures.ts";
import { cutCheck, decisionsOf, mergeProbes, poisonCheck, presenceCheck } from "./chartbest-lookahead.ts";
import { gmoWeekShut as gmoShutAt, sent } from "./chartbest-time.ts";

export interface RunCfg {
  mode: string;
  set: string;
  seed: number;
  flip: boolean;
  period: Period;
  data: string;
  out: string;
  full: boolean;
  forceChoice: string[] | null;
  handResults: string;
  hold: boolean;
  // 9「計算が Actions の1 job（6時間）に収まらない時は…「出せなかった」」: the owner's way starts an item's account only
  // before jobStartMs + holdBudgetMin minutes (CB_HOLD_BUDGET_MIN, default 300; CB_JOB_START_MS, the job's start the yml
  // sets, else this process's start)
  holdBudgetMin: number;
  jobStartMs: number;
  // the dumps for the Python / the flip in a light run (CB_DUMPS=1; full and flipped runs always write them)
  dumps: boolean;
  amount: number | null;
}

export const envOf = (k: string, d = ""): string => Deno.env.get(k) ?? d;
// gates-04: a set CB_HOLD_BUDGET_MIN that is not a finite number of minutes above 0 ("0" or "" would leave every item
// out, a word would turn the budget off), or a set CB_JOB_START_MS that is not a time
export const HOLD_BUDGET_DEFAULT_MIN = 300;
export const holdBudgetProblems = (get: (k: string) => string | undefined = (k) => Deno.env.get(k)): string[] => {
  const out: string[] = [];
  const b = get("CB_HOLD_BUDGET_MIN");
  if (b !== undefined && !(b.trim() !== "" && Number.isFinite(Number(b)) && Number(b) > 0)) out.push(`CB_HOLD_BUDGET_MIN=${JSON.stringify(b)}: not a number of minutes above 0`);
  const j = get("CB_JOB_START_MS");
  if (j !== undefined && !(/^\d{12,14}$/.test(j.trim()))) out.push(`CB_JOB_START_MS=${JSON.stringify(j)}: not a time in ms since 1970`);
  return out;
};
export const cfgFromEnv = (): RunCfg => {
  const set = envOf("CB_SET", "N");
  const force = envOf("CB_FORCE_CHOICE", "");
  const forceChoice = force ? force.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const unknown = (forceChoice ?? []).filter((id) => !ITEM_TABLE.some((r) => r.id === id));
  if (unknown.length) throw new Refused(`CB_FORCE_CHOICE: ${unknown.join(", ")} not an item of the table`);
  const budget = holdBudgetProblems();
  if (budget.length) throw new Refused(budget.join("; "));
  return {
    mode: envOf("CB_MODE", "run"),
    set,
    seed: Number(envOf("CB_SEED", "101")),
    flip: envOf("CB_FLIP") === "1",
    period: periodOf(envOf("CB_PERIOD", "main")),
    data: envOf("CB_DATA", ""),
    out: envOf("CB_OUT", "research/out/chartbest/run"),
    full: envOf("CB_FULL") === "1",
    forceChoice,
    handResults: envOf("CB_HAND_RESULTS", ""),
    hold: envOf("CB_HOLD", "1") !== "0",
    holdBudgetMin: Number(envOf("CB_HOLD_BUDGET_MIN", String(HOLD_BUDGET_DEFAULT_MIN))),
    jobStartMs: envOf("CB_JOB_START_MS") ? Number(envOf("CB_JOB_START_MS")) : Math.floor(performance.timeOrigin),
    dumps: envOf("CB_DUMPS") === "1",
    amount: envOf("CB_AMOUNT") ? Number(envOf("CB_AMOUNT")) : null,
  };
};

export class Refused extends Error {}

// ---- the gates read before any bar (20 (a) ledger sha256; the hand examples) ---------------------------------

export const gateCandidates = async (checks: Checks, plant: string): Promise<boolean> => {
  let got = "";
  try {
    got = await fileSha(CANDIDATES.path);
  } catch {
    got = "";
  }
  const want = plant === "badSha" ? CANDIDATES.sha256.replace(/.$/, (c) => (c === "0" ? "1" : "0")) : CANDIDATES.sha256;
  if (got) Log.sha(CANDIDATES.path, got);
  checks.count("data.candidatesSha", got === want ? 0 : 1, 1);
  return got === want;
};
export const gateSpread = async (checks: Checks): Promise<string | null> => {
  const text = await Deno.readTextFile(SPREAD_HOURS.path);
  const got = await fileSha(SPREAD_HOURS.path);
  Log.sha(SPREAD_HOURS.path, got);
  checks.count("data.spreadSha", got === SPREAD_HOURS.sha256 ? 0 : 1, 1);
  return got === SPREAD_HOURS.sha256 ? text : null;
};
// the hand examples' results (CB_MODE=hand): every case passed, no plant, and run on the hand.json of this tree
export const gateHand = async (checks: Checks, path: string): Promise<boolean> => {
  if (!path) {
    checks.count("hand.all", 1, 0, "CB_HAND_RESULTS not given");
    return false;
  }
  try {
    const r = JSON.parse(await Deno.readTextFile(path)) as { ok: boolean; cases: Record<string, { ok: boolean }>; plant?: string; handSha?: string };
    const bad = Object.entries(r.cases).filter(([, c]) => !c.ok).map(([k]) => k);
    const now = await fileSha("research/chartbest/hand.json");
    const stale = r.handSha !== now;
    const n = bad.length + (r.ok ? 0 : bad.length ? 0 : 1) + (r.plant ? 1 : 0) + (stale ? 1 : 0);
    checks.count("hand.all", n, Object.keys(r.cases).length, n ? { failed: bad.slice(0, 10), plant: r.plant || null, stale } : undefined);
    return n === 0;
  } catch {
    checks.count("hand.all", 1, 0, `cannot read ${path}`);
    return false;
  }
};

// ---- (a): the data checks -----------------------------------------------------------------------------------

export const dataChecks = (checks: Checks, rb: RunBars, full: boolean, madeUp: boolean) => {
  for (const d of rb.diags) Log.raw(readLine(d));
  const sum = (f: (d: (typeof rb.diags)[number]) => number) => rb.diags.reduce((a, d) => a + f(d), 0);
  checks.count("data.readFail", sum((d) => d.failed), sum((d) => d.files));
  checks.count("data.dup", sum((d) => d.dup), sum((d) => d.kept));
  checks.count("data.ohlc", sum((d) => d.ohlc), sum((d) => d.kept));
  checks.count("data.band", sum((d) => d.band), sum((d) => d.kept));
  const crossedBad = rb.diags.filter((d) => !crossedOk(d));
  checks.count("data.crossed", crossedBad.length, rb.diags.length, crossedBad.length ? crossedBad.map((d) => ({ pair: d.pair, interval: d.interval, worst: crossedWorst(d) })) : undefined);
  if (full) checks.count("data.minuteNoFive", rb.minuteNoFive ?? 0, sum((d) => (d.interval === "1min" ? d.kept : 0)));
  else checks.skip("data.minuteNoFive", "light run");
  if (madeUp) {
    // 20 (e): the made-up bars' times are GMO's week
    let bad = 0;
    let n = 0;
    for (const pb of rb.bars) {
      for (let k = 0; k < pb.n; k++) {
        n++;
        if (gmoShutAt(pb.t[k])) bad++;
      }
    }
    checks.count("data.gmoWeek", bad, n);
  }
};

// ---- the signals --------------------------------------------------------------------------------------------

export interface Signals {
  items: SourceSigs[];
  measures: Array<ReturnType<typeof measureSigs>>;
  all: SourceSigs[];
}
export const signalsOf = (rb: RunBars, plant: string, answerKnowing: boolean): Signals => {
  const items = itemsOf(answerKnowing).map((d) => itemSigs(d, rb, plant));
  const measures = MEASURES.map((id) => measureSigs(id, rb, plant));
  return { items, measures, all: [...items, ...measures] };
};

// 20 (b): donchian's target against research/bigflow-lib.ts donchianState, every bar of every pair (the
// module needs --sloppy-imports: loaded by name at run time)
export const donchianStateCheck = async (checks: Checks, rb: RunBars, plant: string) => {
  const spec = "./" + "bigflow-lib.ts";
  const mod = await import(spec) as { donchianState: (c: Array<{ datetime: string; open: number; high: number; low: number; close: number }>, n: number) => Int8Array };
  let bad = 0;
  let n = 0;
  const examples: string[] = [];
  for (const def of itemsOf(false).filter((d) => d.id.startsWith("donchian"))) {
    const nn = def.id === "donchian-A20" ? 20 : 55;
    for (const pb of rb.bars) {
      const out = def.compute(pb, { plant, params: {} });
      const candles = Array.from({ length: pb.n }, (_, k) => ({ datetime: "", open: pb.mo[k], high: pb.mh[k], low: pb.ml[k], close: pb.mc[k] }));
      const ds = mod.donchianState(candles, nn);
      for (let k = 0; k < pb.n; k++) {
        n++;
        if (ds[k] !== out.target![k]) {
          bad++;
          if (examples.length < 5) examples.push(`${def.id} ${pb.pair} bar ${k}: ${out.target![k]} vs ${ds[k]}`);
        }
      }
    }
  }
  checks.count("item.donchianState", bad, n, examples.length ? examples : undefined);
};

// 20 (b) 今のメールの照合 (full runs)
export const measureChecks = (checks: Checks, rb: RunBars, sig: Signals) => {
  const p = rb.period;
  const probes: Record<string, Probe[]> = { ui: [], ul: [], uv: [], mw: [], mm: [], mv: [] };
  sig.measures.forEach((m) => {
    rb.bars.forEach((pb, pi) => {
      const candles = candlesOf(pb);
      const raw = m.raw[pi];
      if (m.measure === "ultra5") {
        const u = raw as Parameters<typeof ultraProbes>[2];
        const pr = ultraProbes(pb, candles, u);
        probes.ui.push(pr.indicator);
        probes.ul.push(pr.late);
        if (rb.quotes) probes.uv.push(readerEquality("ultra5", pb, { cands: u.cands, late: u.late }, readerOf("ultra5", pb, rb.quotes[pi], p), p, (T) => sent(T)));
      } else {
        const mm = raw as Parameters<typeof macdProbes>[2];
        const pr = macdProbes(pb, candles, mm);
        probes.mw.push(pr.window);
        probes.mm.push(pr.macdx);
        if (rb.quotes) probes.mv.push(readerEquality("macdx5", pb, { cands: mm.cands, late: [] }, readerOf("macdx5", pb, rb.quotes[pi], p), p, (T) => sent(T)));
      }
    });
  });
  const put = (name: string, ps: Probe[]) => {
    const m = mergeProbes(ps);
    checks.count(name, m.mismatched, m.compared, m.examples.length ? m.examples : undefined);
  };
  put("measure.ultra.indicatorSignals", probes.ui);
  put("measure.ultra.late", probes.ul);
  put("measure.ultra.vsSignalsOf", probes.uv);
  put("measure.macd.window", probes.mw);
  put("measure.macd.macdxSignals", probes.mm);
  put("measure.macd.vsReadOf", probes.mv);
};

// 20 (b) the cut, the poison and the presence poison, per item (full runs)
export const lookaheadChecks = (checks: Checks, rb: RunBars, plant: string, answerKnowing: boolean) => {
  for (const def of itemsOf(answerKnowing)) {
    const cut: Probe[] = [];
    const poi: Probe[] = [];
    const p1: Probe[] = [];
    const p2: Probe[] = [];
    for (const pb of rb.bars) {
      if (!def.pairs.includes(pb.pair)) continue;
      const d = decisionsOf(def, pb, plant);
      cut.push(cutCheck(def, pb, d, rb.period, plant));
      poi.push(poisonCheck(def, pb, d, plant));
      p1.push(presenceCheck(def, pb, d, 1, plant));
      p2.push(presenceCheck(def, pb, d, 2, plant));
    }
    for (const [name, ps] of [["cut", cut], ["poison", poi], ["presence1", p1], ["presence2", p2]] as const) {
      const m = mergeProbes(ps);
      checks.count(`lookahead.${name}.${def.id}`, m.mismatched, m.compared, m.examples.length ? m.examples.slice(0, 3) : undefined);
    }
  }
};

// 20 (h), the stage-0 part: every signal = Σ ①〜④ + counted, the records against stage 0's own counts
// (research/chartbest-count.ts counts them in a loop of its own)
export const reconcileCounts = (sig: Signals, s0: Stage0): { bad: number; n: number; why: string[] } => {
  let bad = 0;
  let n = 0;
  const why: string[] = [];
  for (const s of sig.all) {
    n++;
    const c = s0.sources[s.src];
    if (!c) {
      bad++;
      why.push(`${s.src}: no stage-0 counts`);
      continue;
    }
    let sum = 0;
    for (const h of [c.H1, c.H2]) sum += h.counted + h.reasons.r1 + h.reasons.r2 + h.reasons.r3 + h.reasons.r4;
    if (sum !== s.recs.length) {
      bad++;
      why.push(`${s.src}: ${sum} counted or left out ≠ ${s.recs.length} signals`);
    }
  }
  return { bad, n, why };
};
export const reconcile0 = (checks: Checks, sig: Signals, s0: Stage0) => {
  const r = reconcileCounts(sig, s0);
  checks.count("count.reconcile", r.bad, r.n, r.why.length ? r.why.slice(0, 5) : undefined);
};
