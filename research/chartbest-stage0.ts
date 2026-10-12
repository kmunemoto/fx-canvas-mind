// #318 (docs §8.113 11, 22): stage 0 — counts only, never an outcome. This file is also the entry of the real
// stage 0 (deno run … research/chartbest-stage0.ts, guarded: plan §5.4), and its import graph holds no follow,
// blind-table, statistics, selection or owner-hold module (11「段0のプログラムは、追い方のコードを読み込まない」;
// CI checks it with deno info). research/chartbest.ts's run and stage modes use the same stage0Part.
//
//   the gates read before any bar (the candidates ledger's sha256, the spread table, the hand examples, the
//   59-row table) → the day files → the data checks → the items' and the emails' signals → donchianState, the
//   measures' equality and the items' look-ahead checks (full runs) → the counts (stage0Of) → print.txt's s0
//   lines, counts.json (the walk ledger or, real, its own file) and the stage-0 dumps.

import { AMOUNTS, CANDIDATES, HALVES, ITEM_TABLE, LEDGER, PAIRS, R_CB } from "./chartbest-const.ts";
import { type Check, Checks, Log, Printer } from "./chartbest-checks.ts";
import { type RunBars, loadRun } from "./chartbest-core.ts";
import { type NSummary, type Stage0, countsJson, stage0Of } from "./chartbest-count.ts";
import { fileSha, openRealGate, sha256Hex } from "./chartbest-data.ts";
import * as dump0 from "./chartbest-dump0.ts";
import { fmt } from "./chartbest-fmt.ts";
import { allImplemented, tableProblems } from "./chartbest-items.ts";
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

export const realGuard = async (stage: string): Promise<void> => {
  const why: string[] = [];
  if (!allImplemented()) why.push(`${ITEM_TABLE.filter((r) => !r.implemented).length} of the 59 items are not built (22: step 3 first)`);
  if (Date.now() < R_CB) why.push("before R_cb");
  if (envOf("CB_REAL_CONFIRM") !== "§8.113") why.push("CB_REAL_CONFIRM is not §8.113");
  try {
    if ((await fileSha(CANDIDATES.path)) !== CANDIDATES.sha256) why.push("the candidates ledger's sha256 differs");
  } catch {
    why.push("the candidates ledger cannot be read");
  }
  const setsPass = envOf("CB_SETS_PASS");
  if (!setsPass) why.push("CB_SETS_PASS (sets-pass.json) is not given");
  else {
    try {
      const sp = JSON.parse(await Deno.readTextFile(setsPass)) as { ok?: boolean };
      if (sp.ok !== true) why.push("sets-pass.json does not say every condition passed");
    } catch {
      why.push("sets-pass.json cannot be read");
    }
  }
  const ledgerOk = async (l: { path: string; sha256: string }) => l.sha256 !== "" && (await exists(l.path)) && (await fileSha(l.path)) === l.sha256;
  if (stage === "stage0" && LEDGER.counts.sha256 !== "") why.push("stage 0 has run (the counts ledger's sha256 is written)");
  if (stage === "stage1" && !(await ledgerOk(LEDGER.counts))) why.push("stage 0's counts ledger is not written with its sha256");
  if (stage === "stage2") {
    if (!(await ledgerOk(LEDGER.choice))) why.push("stage 1's choice ledger is not written with its sha256");
    if (LEDGER.stage2.sha256 !== "") why.push("stage 2 has run once (its ledger's sha256 is written)");
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

export const printStage0 = (pr: Printer, s0: Stage0) => {
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
    }
    if (c.kind === "item") pr.line(`s0.${src}.floor`, c.floor ? "yes" : "no");
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
  }
};

// ---- the end of a run: checks.json, print.txt only when every check passed -------------------------------------

export const finishRun = async (out: string, head: Record<string, unknown>, checks: Checks, printer: Printer, code: number, plant: string): Promise<number> => {
  const pc: Check = printer.check();
  checks.set("print.items", pc);
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
  await Deno.writeTextFile(`${cfg.out}/run.json`, JSON.stringify({ ...head, forceChoice: cfg.forceChoice, amounts: AMOUNTS }, null, 1) + "\n");
  const rb = await loadRun({ dir: cfg.data, real: !madeUp }, cfg.period, madeUp, cfg.full, cfg.full);
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
  printStage0(printer, s0);
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
  return finishRun(cfg.out, head, checks, printer, 0, plant);
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
