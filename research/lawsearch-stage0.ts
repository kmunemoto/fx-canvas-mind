// 法則探し (docs §8.136, research/lawsearch-spec.md 9): stage 0 as its own program, builder D
// (research/lawsearch-design.md 7.4). Spec 9: stage 0 imports no trade or measure code; CI checks that
// `deno info research/lawsearch-stage0.ts` lists none of lawsearch-trade.ts, lawsearch-stats.ts, lawsearch-select.ts.
// lawsearch.ts calls runStage0 in-process for the syn and walkfiles modes; run directly (MODE=stage0 on real data,
// spec 19 step 5) it refuses while the small trial has not passed.

import { indOf } from "./lawsearch-ind.ts";
import { answerKnowingE26, filterOf, itemOf, sFilterOf } from "./lawsearch-items.ts";
import { blindBarsOf, trialSignals } from "./lawsearch-events.ts";
import { stage0 } from "./lawsearch-select0.ts";
import { addsUpCheck, ctxOfUniverse, cutCheck, cutStatsText, cutTargets, dataCheck, donchianCheck, poisonCheck, presenceCheck } from "./lawsearch-checks.ts";
import { dumpBars, dumpHoles, dumpInd, dumpLoad, dumpSignals, dumpStage0 } from "./lawsearch-dump.ts";
import { CUT_HTF_STAGE0, POISON_N, SEEDS } from "./lawsearch-rules.ts";
import type { CheckResult, ExclCtx, Ind, RunConfig, Stage0Row, TfKey, TfSet, TrialDef, TrialSignals, Universe } from "./lawsearch-types.ts";

// the dump columns of the built items and filters of the run's trials on one timeframe, per pair
const buildsOf = (trials: TrialDef[], inds: Ind[], answerKnowing: boolean): Array<{ pi: number; columns: Record<string, Float64Array | Int8Array | Uint8Array> }> => {
  const out: Array<{ pi: number; columns: Record<string, Float64Array | Int8Array | Uint8Array> }> = [];
  const seen = new Set<string>();
  for (const t of trials) {
    const parts: Array<[string, (ind: Ind) => Record<string, Float64Array | Int8Array | Uint8Array>]> = [];
    if (t.kind === "EF" && t.e !== null && t.f !== null) {
      const e = t.e;
      parts.push([`E:${e}`, (ind) => (answerKnowing && e === "E26" ? answerKnowingE26() : itemOf(e)).build(ind).columns]);
      const f = t.f;
      parts.push([`F:${f}`, (ind) => filterOf(f).build(ind).columns]);
    } else if (t.kind === "S" && t.s !== null) {
      const s = t.s;
      parts.push([`S:${s}`, (ind) => sFilterOf(s).build(ind).columns]);
    } else if (t.kind === "B" && t.b !== null) {
      const b = t.b;
      parts.push([`B:${b}`, (ind) => itemOf(b).build(ind).columns]);
    }
    for (const [key, make] of parts) {
      if (seen.has(key)) continue;
      seen.add(key);
      inds.forEach((ind, pi) => out.push({ pi, columns: make(ind) }));
    }
  }
  return out;
};

// the Ind of every pair of a timeframe (with its higher timeframe)
export const indsOf = (set: TfSet, plant: string): Ind[] => set.pairs.map((s, pi) => indOf(s, { series: set.htf[pi], g: set.g[pi] }, plant));

export interface Stage0Out {
  sigs: TrialSignals[];
  rows: Stage0Row[];
  checks: CheckResult[];
  // what stage 1 and the checks of 13 reuse
  inds: Record<TfKey, Ind[]>;
  ctx: Record<TfKey, ExclCtx>;
  passing: Record<TfKey, { first: Uint8Array[]; second: Uint8Array[] }>;
  times: Record<string, number>;
}

// Stage 0 on a universe loaded over [S0, END): indicators, signals (spec 5, 6), the blind bars of both halves, spec
// 9's rows, and the stage-0-safe checks of 15 (data, adds up, donchian, cut, poison, presence; the cut with spec
// 23.2's 300 higher-timeframe boundary targets per tf and pair). The stage-0 dumps are written when dumpDir is given.
export async function runStage0(u: Universe, trials: TrialDef[], cfg: RunConfig, avoid: ReadonlySet<string>, o: { answerKnowing: boolean; plant: string; dumpDir: string | null; cutMaxTargets?: number }): Promise<Stage0Out> {
  const t0 = Date.now();
  const times: Record<string, number> = {};
  const ctx = ctxOfUniverse(u, avoid, o.plant);
  const inds: Record<TfKey, Ind[]> = { m15: indsOf(u.m15, o.plant), h1: indsOf(u.h1, o.plant) };
  const sigs = trials.map((t) => trialSignals(t, t.tf === "m15" ? u.m15 : u.h1, inds[t.tf], ctx[t.tf], { plant: o.plant, answerKnowing: o.answerKnowing }));
  const passing: Record<TfKey, { first: Uint8Array[]; second: Uint8Array[] }> = {
    m15: { first: blindBarsOf(ctx.m15, u.m15, "first"), second: blindBarsOf(ctx.m15, u.m15, "second") },
    h1: { first: blindBarsOf(ctx.h1, u.h1, "first"), second: blindBarsOf(ctx.h1, u.h1, "second") },
  };
  const gDf: Record<string, number> = {};
  const rows = stage0(sigs, { m15: u.m15, h1: u.h1 }, passing, cfg.g, gDf);
  times["stage0"] = Date.now() - t0;
  const checks: CheckResult[] = [];
  const tc = Date.now();
  checks.push(dataCheck(u));
  checks.push(addsUpCheck(rows.map((r) => ({ trial: r.trial, addsUp: r.addsUp }))));
  checks.push(donchianCheck(u, inds));
  // spec 15 切り取り with spec 23.2's stage-0 rule: 300 of the higher-timeframe boundary targets per tf and pair
  const cutStats: Record<string, number> = {};
  const targets = cutTargets(u, trials, sigs, { htf: "even", stats: cutStats });
  checks.push(cutCheck(u, trials, sigs, targets, avoid, { answerKnowing: o.answerKnowing, plant: o.plant, maxTargets: o.cutMaxTargets, times, note: `${cutStatsText(cutStats)}; htf: ${CUT_HTF_STAGE0} evenly picked per timeframe and pair, spec 23.2` }));
  checks.push(poisonCheck(u, trials, sigs, avoid, { n: POISON_N, seed: SEEDS.poison, answerKnowing: o.answerKnowing, plant: o.plant, ctx }));
  checks.push(presenceCheck(u, trials, sigs, avoid, { seed: SEEDS.poison, answerKnowing: o.answerKnowing, plant: o.plant }));
  times["checks"] = Date.now() - tc;
  if (o.dumpDir) {
    const dir = o.dumpDir;
    await dumpLoad(dir, u, u.purpose);
    await dumpBars(dir, u);
    await dumpHoles(dir, ctx);
    for (const tf of ["m15", "h1"] as const) {
      const ts = trials.filter((t) => t.tf === tf);
      await dumpInd(dir, tf === "m15" ? u.m15 : u.h1, buildsOf(ts, inds[tf], o.answerKnowing), sigs.filter((s) => s.tf === tf));
    }
    for (const s of sigs) await dumpSignals(dir, s);
    await dumpStage0(dir, rows);
  }
  return { sigs, rows, checks, inds, ctx, passing, times };
}

if (import.meta.main) {
  // MODE=stage0 on real data (spec 19 step 5) is not open before the small trial has passed (lawsearch.ts' gate)
  console.log("REFUSED: the small trial has not passed (TRIAL_PASSED_SHA256 is null)");
  Deno.exit(2);
}
