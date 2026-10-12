// #318 (docs §8.113 11, 22): stage 0 — counts only, never an outcome. This file is also the entry of the real
// stage 0 (deno run … research/chartbest-stage0.ts, guarded: plan §5.4), and its import graph holds no follow,
// blind-table, statistics, selection or owner-hold module (11「段0のプログラムは、追い方のコードを読み込まない」;
// CI checks it with deno info). research/chartbest.ts's run and stage modes use the same stage0Part.
//
//   the gates read before any bar (the candidates ledger's sha256, the spread table, the hand examples, the
//   59-row table) → the day files → the data checks → the items' and the emails' signals → donchianState, the
//   measures' equality and the items' look-ahead checks (full runs) → the counts (stage0Of) → print.txt's s0
//   lines, counts.json (the walk ledger or, real, its own file) and the stage-0 dumps.

import { AMOUNTS, CANDIDATES, HALVES, type Half, HOLD_BUILT, ITEM_TABLE, LEDGER, PAIRS, type Period, R_CB, REAL_CACHE_DIR, SPEC, STEP } from "./chartbest-const.ts";
import type { PairBars } from "./chartbest-bars.ts";
import { type Check, Checks, Log, Printer } from "./chartbest-checks.ts";
import { type RunBars, loadRun } from "./chartbest-core.ts";
import { type NSummary, type Stage0, countsJson, stage0Of } from "./chartbest-count.ts";
import { fileSha, openRealGate, sha256Hex } from "./chartbest-data.ts";
import * as dump0 from "./chartbest-dump0.ts";
import { fmt } from "./chartbest-fmt.ts";
import { allImplemented, tableProblems } from "./chartbest-items.ts";
import { madeUpDataProblems } from "./chartbest-manifest.ts";
import type { LateSig } from "./chartbest-measures.ts";
import { plant as currentPlant } from "./chartbest-plants.ts";
import { type RunCfg, Refused, type Signals, cfgFromEnv, dataChecks, donchianStateCheck, envOf, gateCandidates, gateHand, gateSpread, lookaheadChecks, measureChecks, reconcile0, signalsOf } from "./chartbest-run0.ts";
import { parseSpreadHours } from "./spreadhours-lib.ts";

export const exists = async (p: string): Promise<boolean> => {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
};

// ---- the real-data guard (plan §5.4; never passes in step 2) ------------------------------------------------------

// the configuration of a real stage, from the environment (the guard mode has no RunCfg): the fixed dates of 1, no
// made-up set's semantics (O's answer-knowing item, H's counted-only suspicion), every check of 20 (CB_FULL=1), the
// owner's way (14), and none of the made-up knobs
export const realConfigProblems = (env: (k: string) => string = (k) => envOf(k)): string[] => {
  const out: string[] = [];
  const period = env("CB_PERIOD");
  if (period !== "" && period !== "main") out.push(`CB_PERIOD=${period}: a real stage uses the fixed dates of 1 (main)`);
  const set = env("CB_SET");
  if (set !== "" && set !== "N") out.push(`CB_SET=${set}: a real stage carries no made-up set's semantics`);
  if (env("CB_FULL") !== "1") out.push("CB_FULL is not 1: a real stage runs every check of 20");
  if (env("CB_HOLD") === "0") out.push("CB_HOLD=0: a real stage does not leave out the owner's way (14)");
  for (const k of ["CB_FORCE_CHOICE", "CB_PLANT", "CB_AMOUNT"]) if (env(k) !== "") out.push(`${k} is set: made-up runs only`);
  if (env("CB_FLIP") === "1") out.push("CB_FLIP=1: made-up runs only");
  return out;
};
// 20 (e)「dispatch では、作り物がすべて通った時だけ実データを走らせる」: sets-pass.json is the whole sets-sum (no
// CB_SETS_ONLY part), every set's own conditions passed, and E3's counts are there
export const SETS_PASS_OK = [
  "set.N.runs", "set.N.1", "set.N.2", "set.N.3", "set.N.4", "set.N.5", "set.D.runs", "set.D.1", "set.D.tooth", "set.H.runs", "set.H.1", "set.H.2",
  "set.E.runs", "set.E", "set.E3.runs", "set.Q.runs", "set.Q", "set.O.runs", "set.O", "set.flip",
] as const;
export const SETS_PASS_PRESENT = ["set.E3.counts"] as const;
export const setsPassProblems = (sp: { ok?: unknown; only?: unknown; conditions?: Record<string, { ok?: unknown } | undefined> }): string[] => {
  const out: string[] = [];
  if (sp.ok !== true) out.push("sets-pass.json does not say every condition passed");
  if (sp.only !== null) out.push("sets-pass.json is not the whole sets-sum (only is not null)");
  const c = sp.conditions ?? {};
  const notPassed = SETS_PASS_OK.filter((k) => c[k]?.ok !== true);
  if (notPassed.length) out.push(`sets-pass.json has no passed ${notPassed.join(", ")}`);
  const absent = SETS_PASS_PRESENT.filter((k) => c[k] === undefined);
  if (absent.length) out.push(`sets-pass.json has no ${absent.join(", ")}`);
  return out;
};

export const realGuard = async (stage: string): Promise<void> => {
  const why: string[] = [];
  if (!allImplemented()) why.push(`${ITEM_TABLE.filter((r) => !r.implemented).length} of the 59 items are not built (22: step 3 first)`);
  if (Date.now() < R_CB) why.push("before R_cb");
  if (envOf("CB_REAL_CONFIRM") !== "§8.113") why.push("CB_REAL_CONFIRM is not §8.113");
  why.push(...realConfigProblems());
  try {
    if ((await fileSha(CANDIDATES.path)) !== CANDIDATES.sha256) why.push("the candidates ledger's sha256 differs");
  } catch {
    why.push("the candidates ledger cannot be read");
  }
  const setsPass = envOf("CB_SETS_PASS");
  if (!setsPass) why.push("CB_SETS_PASS (sets-pass.json) is not given");
  else {
    try {
      why.push(...setsPassProblems(JSON.parse(await Deno.readTextFile(setsPass))));
    } catch {
      why.push("sets-pass.json cannot be read");
    }
  }
  const ledgerOk = async (l: { path: string; sha256: string }) => l.sha256 !== "" && (await exists(l.path)) && (await fileSha(l.path)) === l.sha256;
  if (stage === "stage0" && LEDGER.counts.sha256 !== "") why.push("stage 0 has run (the counts ledger's sha256 is written)");
  if (stage === "stage1" && !(await ledgerOk(LEDGER.counts))) why.push("stage 0's counts ledger is not written with its sha256");
  if (stage === "stage2") {
    // 11: stage 2 too reads the counts stage 0 fixed (gate.counts, M_1)
    if (!(await ledgerOk(LEDGER.counts))) why.push("stage 0's counts ledger is not written with its sha256");
    if (!(await ledgerOk(LEDGER.choice))) why.push("stage 1's choice ledger is not written with its sha256");
    if (LEDGER.stage2.sha256 !== "") why.push("stage 2 has run once (its ledger's sha256 is written)");
    // 14「段2で、オーナーの持ち方（9）も測る」
    if (!HOLD_BUILT) why.push("the owner's way (research/chartbest-hold.ts) is not built");
  }
  if (why.length) throw new Refused(`real ${stage} refused: ${why.join("; ")}`);
  openRealGate(stage);
};

// ---- the walk ledger (the made-up stand-ins of research/ledger/chartbest-{counts,choice,stage2}.json) -------------

export interface WalkLedger {
  dir: string;
}
export const ledgerWrite = async (w: WalkLedger, name: string, v: unknown): Promise<string> => {
  await Deno.mkdir(w.dir, { recursive: true });
  const text = JSON.stringify(v, dump0.jsonReplacer, 1) + "\n";
  await Deno.writeTextFile(`${w.dir}/${name}`, text);
  const sha = await sha256Hex(new TextEncoder().encode(text));
  await Deno.writeTextFile(`${w.dir}/${name}.sha256`, `${sha}\n`);
  return sha;
};
// a ledger file is read only against the sha256 given for it (a changed file stops the stage: exit 2)
export const ledgerRead = async <T>(w: WalkLedger, name: string, wantSha: string): Promise<{ v: T; sha: string }> => {
  if (!wantSha) throw new Refused(`${name}: its sha256 is not given (the stage reads a ledger file only against its sha256)`);
  const path = `${w.dir}/${name}`;
  const text = await Deno.readTextFile(path);
  const sha = await sha256Hex(new TextEncoder().encode(text));
  if (sha !== wantSha) throw new Refused(`${name}: sha256 ${sha}, not the ${wantSha} given`);
  return { v: JSON.parse(text) as T, sha };
};

// ---- print.txt's stage-0 lines --------------------------------------------------------------------------------

// 11 出すもの: per source and half the counts, the reasons ①〜④, the counts per pair × direction; per pair the
// warm-up date; the floor, the overlap group (floor items), the projections (with n26); ULTRA's late signals per half
// (10「遅れた合図は数だけ出して外す」; SQ-R1: by T in [START, SPLIT) and [SPLIT, END), or by the close of the bar
// where the signal shows, SPEC.lateHalfBy)
export const lateAt = (l: LateSig, bars: PairBars[]): number => {
  if (SPEC.lateHalfBy === "T") return l.T;
  const pb = bars[l.pi];
  return l.i + 1 < pb.n ? pb.t[l.i + 1] + STEP : l.T + STEP;
};
export const ultraLateOf = (sig: Signals, p: Period, bars: PairBars[]): Record<Half, number> => {
  const out: Record<Half, number> = { H1: 0, H2: 0 };
  for (const m of sig.measures) {
    if (m.measure !== "ultra5") continue;
    for (const l of m.late) {
      const at = lateAt(l, bars);
      if (at < p.start || at >= p.end) continue;
      out[at < p.split ? "H1" : "H2"]++;
    }
  }
  return out;
};
const isoMin = (t: number | null): string => (t === null ? "-" : `${new Date(t).toISOString().slice(0, 16)}Z`);
export const printStage0 = (pr: Printer, s0: Stage0, ultraLate: Record<Half, number> | null = null) => {
  for (const [src, c] of Object.entries(s0.sources)) {
    for (const h of HALVES) {
      const x = c[h];
      pr.line(`s0.${src}.${h}.counted`, x.counted);
      pr.line(`s0.${src}.${h}.weeks`, x.weeks);
      for (const r of ["r1", "r2", "r3", "r4"] as const) pr.line(`s0.${src}.${h}.${r}`, x.reasons[r]);
      pr.line(`s0.${src}.${h}.both`, x.bothSuppressed);
      pr.line(`s0.${src}.${h}.noBlind`, x.noBlindRows);
      if (x.perWeek !== null) pr.line(`s0.${src}.${h}.perWeek`, x.perWeek.toFixed(2));
      if (x.wideShare !== null) pr.line(`s0.${src}.${h}.wideShare`, (100 * x.wideShare).toFixed(1));
      if (typeof x.extra.missingDays === "number") pr.line(`s0.${src}.${h}.missingDays`, x.extra.missingDays);
      if (typeof x.extra.shiftedWeek === "number") pr.line(`s0.${src}.${h}.shifted`, x.extra.shiftedWeek);
      for (const [key, n] of Object.entries(x.byPairDir)) {
        const [pair, dir] = key.split(" ");
        pr.line(`s0.${src}.${h}.${pair.replace("/", "_")}.${dir}`, n);
      }
      if (src === "ultra5" && ultraLate) pr.line(`s0.${src}.${h}.late`, ultraLate[h]);
    }
    for (const [pair, t] of Object.entries(c.warmDate)) pr.line(`s0.${src}.warmDate.${pair.replace("/", "_")}`, isoMin(t));
    if (c.kind === "item") pr.line(`s0.${src}.floor`, c.floor ? "yes" : "no");
    if (s0.groups[src]) pr.line(`s0.${src}.group`, s0.groups[src]);
  }
  pr.line("s0.M1.chart", s0.M1.chart);
  pr.line("s0.M1.cal", s0.M1.cal);
  pr.line("s0.Wh.H1", s0.Wh.H1);
  pr.line("s0.Wh.H2", s0.Wh.H2);
  for (const [id, pj] of Object.entries(s0.projections)) {
    pr.line(`s0.${id}.g`, pj.g);
    pr.line(`s0.${id}.df`, pj.df);
    pr.line(`s0.${id}.passMin`, fmt.pts(pj.passMin));
    pr.line(`s0.${id}.size`, fmt.pts(pj.size));
    pr.line(`s0.${id}.marks`, pj.marks.join(";"));
    pr.line(`s0.${id}.n26`, pj.n26.toFixed(1));
  }
};

// ---- the end of a run: checks.json, print.txt only when every check passed -------------------------------------

export const finishRun = async (out: string, head: Record<string, unknown>, checks: Checks, printer: Printer, code: number, plant: string, real = false): Promise<number> => {
  const pc: Check = printer.check();
  checks.set("print.items", pc);
  // 20「1つでも外れたら、その段の数字を出さない」: on real data a check that did not run (SKIP) is no pass, so a real
  // run prints only when nothing was skipped (made-up light runs may skip, and say so)
  if (real) {
    const sk = checks.skipped();
    checks.count("print.noSkip", sk.length, checks.names().length, sk.length ? sk : undefined);
  }
  await Deno.writeTextFile(`${out}/checks.json`, checks.json(head));
  const ok = checks.ok();
  if (ok && code === 0) await Deno.writeTextFile(`${out}/print.txt`, printer.text());
  else {
    try {
      await Deno.remove(`${out}/print.txt`);
    } catch {
      // none written
    }
  }
  return code !== 0 ? code : ok ? 0 : plant ? 0 : 1;
};

// ---- stage 0 ----------------------------------------------------------------------------------------------------

export interface Stage0Out {
  rb: RunBars;
  sig: Signals;
  s0: Stage0;
  counts: Record<string, unknown>;
  madeUp: boolean;
  dumps: boolean;
  tsDir: string;
  answerKnowing: boolean;
}
// the gates and stage 0; null when a gate refused reading (checks.json is written, exit 2)
export const stage0Part = async (cfg: RunCfg, mode: string, plant: string, checks: Checks, printer: Printer, head: Record<string, unknown>): Promise<Stage0Out | null> => {
  // gates before any bar: the candidates ledger (a wrong sha256 reads nothing), the spread table, the hand examples
  if (!(await gateCandidates(checks, plant))) {
    await Deno.writeTextFile(`${cfg.out}/checks.json`, checks.json(head));
    return null;
  }
  const spreadText = await gateSpread(checks);
  await gateHand(checks, cfg.handResults);
  const tp = tableProblems();
  checks.count("item.table", tp.length, 59, tp.length ? tp : undefined);
  // the bars
  const madeUp = cfg.data !== "real";
  Log.setMadeUp(madeUp);
  // lookahead-05: a made-up run reads only a folder gen wrote for this set, seed, flip and period (its manifest and
  // files agree), never research/.cache, where the real jobs keep GMO's day files (refused before any bar)
  if (madeUp) {
    const m = await madeUpDataProblems(cfg.data, { set: cfg.set, seed: cfg.seed, flip: cfg.flip, period: cfg.period.name, minutes: cfg.full, amount: cfg.amount });
    if (m.problems.length) throw new Refused(`made-up data refused: ${m.problems.join("; ")}`);
    Log.sha("CB_DATA/manifest.json", m.sha256);
    checks.count("data.manifest", 0, m.files);
  }
  await Deno.writeTextFile(`${cfg.out}/run.json`, JSON.stringify({ ...head, forceChoice: cfg.forceChoice, amounts: AMOUNTS }, null, 1) + "\n");
  const rb = await loadRun({ dir: madeUp ? cfg.data : REAL_CACHE_DIR, real: !madeUp }, cfg.period, madeUp, cfg.full, cfg.full);
  dataChecks(checks, rb, cfg.full, madeUp);
  const answerKnowing = cfg.set === "O";
  const sig = signalsOf(rb, plant, answerKnowing);
  await donchianStateCheck(checks, rb, plant);
  if (cfg.full) {
    measureChecks(checks, rb, sig);
    lookaheadChecks(checks, rb, plant, answerKnowing);
  } else {
    for (const n of ["measure.ultra.indicatorSignals", "measure.ultra.late", "measure.ultra.vsSignalsOf", "measure.macd.window", "measure.macd.macdxSignals", "measure.macd.vsReadOf"]) checks.skip(n, "light run");
    checks.skip("lookahead.items", "light run");
  }
  // the counts
  const avoid = parseSpreadHours(spreadText ?? "", PAIRS);
  let nSummary: NSummary | null = null;
  const ns = envOf("CB_NSUMMARY");
  if (ns) nSummary = JSON.parse(await Deno.readTextFile(ns)) as NSummary;
  const s0 = stage0Of(rb, sig.all, avoid, nSummary, plant);
  printStage0(printer, s0, ultraLateOf(sig, cfg.period, rb.bars));
  const counts = countsJson(s0);
  if (mode === "stage0" || mode === "run") {
    if (madeUp) await ledgerWrite({ dir: `${cfg.out}/walk-ledger` }, "counts.json", counts);
    else await ledgerWrite({ dir: `${cfg.out}/ledger` }, "chartbest-counts.json", counts);
  }
  const dumps = cfg.full || cfg.flip || cfg.dumps;
  const tsDir = `${cfg.out}/ts`;
  if (dumps) {
    await dump0.writeBars(tsDir, rb.bars);
    await dump0.writeSignals(tsDir, sig.all, rb.bars);
    await dump0.writeHoles(tsDir, rb.holes);
    await dump0.writeJson(tsDir, "counts.json", counts);
  }
  return { rb, sig, s0, counts, madeUp, dumps, tsDir, answerKnowing };
};

// the stage-0 process (the pipeline rehearsal's first step, and the real stage 0)
export const modeStage0 = async (cfg: RunCfg, plant: string): Promise<number> => {
  Log.mode("stage0", `set=${cfg.set} seed=${cfg.seed} flip=${cfg.flip ? 1 : 0} period=${cfg.period.name} full=${cfg.full ? 1 : 0}${plant ? ` plant=${plant}` : ""}`);
  if (cfg.data === "real") await realGuard("stage0");
  if (plant && cfg.data === "real") throw new Refused("a planted error never runs on real data");
  if (!cfg.data) throw new Refused("CB_DATA (the day files' folder) is not given");
  const checks = new Checks();
  const printer = new Printer();
  await Deno.mkdir(cfg.out, { recursive: true });
  const head = { mode: "stage0", set: cfg.set, seed: cfg.seed, flip: cfg.flip, period: cfg.period.name, plant, full: cfg.full };
  const s = await stage0Part(cfg, "stage0", plant, checks, printer, head);
  if (!s) return 2;
  reconcile0(checks, s.sig, s.s0);
  return finishRun(cfg.out, head, checks, printer, 0, plant, cfg.data === "real");
};

if (import.meta.main) {
  let code = 0;
  try {
    code = await modeStage0(cfgFromEnv(), currentPlant());
  } catch (e) {
    const out = envOf("CB_OUT", "research/out/chartbest/stage0");
    if (e instanceof Refused) {
      const c = new Checks(true);
      c.set("gate.refused", { ok: false, n: 1, detail: e.message });
      await Deno.mkdir(out, { recursive: true });
      await Deno.writeTextFile(`${out}/checks.json`, c.json({ mode: "stage0", refused: e.message }));
      Log.fail("gate.refused", 1);
      code = 2;
    } else {
      Log.crash(e instanceof Error ? e.stack ?? e.message : String(e));
      code = 3;
    }
  }
  Log.raw(`EXIT ${code}`);
  Deno.exit(code);
}
