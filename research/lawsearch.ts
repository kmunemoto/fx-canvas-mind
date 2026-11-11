// 法則探し (docs §8.136, research/lawsearch-spec.md): the program, builder D (research/lawsearch-design.md 7.7).
//
// MODE (environment):
//   hand        the hand examples (lawsearch-hand.ts), one line per example; exit 4 when a required one fails
//   syn         writeRun(OUT, genSpecOf(GEN, SEED, FLIP, STRENGTH)), then the pipeline on OUT (dumps in OUT/ts)
//   walkfiles   the pipeline on an existing run folder RUN (read only); the dumps go to OUT (default RUN/ts; a plant
//               run RUN/plant-<name>)
//   stage0, stage1, calib, stage2, stage3, h1spread, print
//               refused (exit 2, before any read) while the small trial has not passed (TRIAL_PASSED_SHA256 null)
// Other variables: TRIALS (comma-separated ids; default the trial's twelve), LS_PLANT, KAPPA_DELTA, KAPPA_PL (default
// 1: not calibrated, step 7), G_FILE (JSON {trial: g}), HAND_IDS, CUT_MAX (development only: caps the targets per
// pair of every cut check: cut, cut.chosen.first, cut.chosen.second and 13 (i)'s suspect13.cut.stage1 and
// suspect13.cut.stage2 (C4a, the lead's E8); a positive integer, anything else refused with exit 2; written to
// config.json as cut_max and named in print.txt's note.cut_max; checks.csv has no cap marker (E9); the Python's --run
// refuses a capped run; never in CI or a formal run), WORKERS (C4b: the workers that run the units of the checks cut,
// poison and presence, research/lawsearch-par.ts; a whole number 0 … 64, default 4; C4g: 0 means one worker in each
// of the checks' pools (no unit runs in this thread at any value); anything else refused with exit 2; the output files
// are the same bytes whatever its value, so no file names it, as long as every build and cache stays keyed by the Ind
// and no state survives between candidatesOf calls: research/lawsearch-design.md 12.2 (2), C4d; the yml compares
// WORKERS=0 with 4 on three runs, CMP-N 1001, CMP-C 7101 and O 6003, and on CMP-C 7101's lastBarStateG3 plant run
// (C4f), as defense in depth, C4e). Every variable is read once, at the start of main(), and the environment is then
// closed for the whole process (C4g: readSettings).
//
// C4f (the lead's H1–H3 on C4e's review): the checks never read an object the main run is handed. Each universe is
// kept apart right after its load (Guard below: a snapshot for the checks, a digest of both); the checks get trial
// definitions of their own (made in main) and an avoid table of their own (parsed again from the same bytes); poison
// makes its own holes. The trial definitions, the avoid tables and every ExclCtx are frozen or read-only as well
// (H2), and a universe that changes after its load stops the run (H3, exit 7; exit 6 until C4g).
//
// C4g (the lead's T and G1–G4; research/lawsearch-design.md 12): the checks must catch ACCIDENTAL look-ahead in
// main-run code written in good faith, state kept across calls included (module memos, globalThis tables, the
// environment, files, the timing of loads, state left in long-lived workers). So, besides H1's separation of objects:
//   * G1: this module's first two module requests are lawsearch-lockdown.ts and lawsearch-frozen.ts; main() reads every
//     setting and then revokes the environment (readSettings), which closes env for this thread (C4h: the checks'
//     workers never hold env, because they are started with permissions "none", not because of when the revoke runs;
//     C4g's "a worker made before the revoke would keep env" was wrong); gate 3 reads the run's gmo files ONCE
//     (treeBytes: the manifest's tree digest is taken of exactly those bytes), and the three stages' universes are
//     loaded from those bytes (memSourceOf) before any main-run code runs; the retrace reads them too. Nothing reads a
//     gmo file from the disk after gate 3.
//   * G2: every check computation that runs shared code runs in a worker started with no permission, never in this
//     thread: the units of cut (a pool made for each cut run, deltas, T order), of poison and presence (one pool kept
//     for the run), and the follow-bar checks (a worker per call, given the rows' coordinates only). The checks left
//     in this thread compare plain data or run check-only code (design 12, the table of the checks). C4h (F2): every
//     such worker is sent this thread's grants and refuses to serve if it holds one (lawsearch-sandbox.ts), so a worker
//     that was not started with permissions "none" stops the run (exit 1).
//   * G4: H1, its allow-list for every check run's task (assertTaskAllowed), H2 and H3 (exit 7) are kept.
//
// Exit codes (design 2.3): 0 every check passed; 2 refused by a gate; 3 a spec 2 / 15 check failed or a STOP was
// raised (the run goes on through stages 0 and 1 and writes its dumps first, but never opens stage 2 after a failed
// check: design 7.7's stop before stage 2); 4 a required hand example failed; 7 (C4f's H3; 6 until C4g, which
// clashed with the Python comparator's 6) a universe changed after it was loaded (the guard below: the run stops at
// once and removes its dump folder, so no file of it is left; the Python's 5 is a TS–Python difference); 1 any other
// error (a SHARED line from the guard's identity check or allow-list, a write into a frozen trial definition, ExclCtx
// or rule constant, or into the read-only avoid table, and a refused permission, NotCapable, among them). No mode
// reads research/.cache and none fetches (no --allow-net).
//
// The one-process pipeline (design 7.7): config.json; stage 0 (load [S0, END), runStage0, which stops on any trial's
// noBlind above 0 in either half, spec 6); stage 1 (load [S0, SPLIT), h1Only, signals again, stage 1 = stage 0 on the
// first half, the first-half blind and late tables, trial rows, measures of the floor-passing trials that are not same
// trials, the blind rows, suspicion and 13's checks (a blind row's hit is spec 13's stop), the follow-bar checks,
// rules 1–6 and the choice; choice.json; then spec 23.2's cut of the chosen trials on every higher-timeframe boundary
// target of the first half); the stop before stage 2 (any failed check of the gate, stage 0, stage 1 or stage 1's end:
// stage 2 is not opened, C3 D8); stage 2 (load [S0, END), the second-half tables, the chosen trials only, their cut on
// every boundary target of the second half (spec 23.2; its failure withholds stage 2's numbers), κ, Holm, C1–C7,
// verdicts); then checks.csv, cut_fail.csv (every failing bar of the cut checks cut, cut.chosen.first and
// cut.chosen.second, with each bar's start s and close T; not suspect13.cut.*), suspect.csv and print.txt.

// C4g (the lead's G3): the realm's lockdown and the frozen rule constants, evaluated before any other module
import { LOCKDOWN } from "./lawsearch-lockdown.ts";
import { FROZEN_CONSTANTS } from "./lawsearch-frozen.ts";
import { END, N_BARS, PAIRS, S0, SPLIT, SPREAD_H1_SHA256 } from "./lawsearch-const.ts";
import { DIRECTIONAL_F, PLANTS, POISON_1000, QUESTIONS, S_OF_F, SEEDS, TRIAL_STEP3, W0 } from "./lawsearch-rules.ts";
import { loadUniverse } from "./lawsearch-bars.ts";
import { GEN_VERSION, genSpecOf, treeBytes, writeRun } from "./lawsearch-gen.ts";
import { parseCandidates, trialBuilt, trialCopyOf } from "./lawsearch-items.ts";
import { avoidOf, blindBarsOf, GMO_WRITE, trialSignals } from "./lawsearch-events.ts";
import { blindTable, followCompare, followRowsOf, lateTable, lateWhyOf, trialRows } from "./lawsearch-trade.ts";
import type { FollowValues } from "./lawsearch-trade.ts";
import { measureBlindRows, measureTrial, withKappa } from "./lawsearch-stats.ts";
import { chooseStage1, skipText, stage1Explain, stage2Rows, suspectOf } from "./lawsearch-select.ts";
import type { Stage2In } from "./lawsearch-select.ts";
import { assertApart, assertTaskAllowed, checkRulesFiles, ctxOfUniverse, cutCheck, cutStatsText, cutTargets, dataCheck, digestDiff, h1OnlyCheck, poisonCheck, presenceCheck, printCheck, reachOf, retraceCheck, sameFirstHalfCheck, sampleOf, snapshotOf, universeDigest } from "./lawsearch-checks.ts";
import type { CheckInputs, UnitRunner, UnitTask } from "./lawsearch-checks.ts";
import { checkPools, poolStats } from "./lawsearch-par.ts";
import { grantsHeld, grantsText } from "./lawsearch-sandbox.ts";
import { indsOf, runStage0 } from "./lawsearch-stage0.ts";
import type { Stage0Out } from "./lawsearch-stage0.ts";
import { checksRows, dumpBlind, dumpChecks, dumpConfig, dumpCutFail, dumpLoad, dumpMeasures, dumpStage1, dumpStage2, dumpSuspect, dumpTrades } from "./lawsearch-dump.ts";
import { handLines, runHand } from "./lawsearch-hand.ts";
import type { BlindTable, CheckResult, CutFailRow, GenManifest, RunConfig, Stage0Row, Stage1Cand, SuspectRow, TfKey, TfSet, TrialDef, TrialMeasures, TrialRows, TrialSignals, Universe } from "./lawsearch-types.ts";
import type { Source } from "./ownerhold-data.ts";

// the lead sets this after the small trial has passed (spec 19 step 3); every real-data mode refuses until then
export const TRIAL_PASSED_SHA256: string | null = null;

const REAL_MODES = ["stage0", "stage1", "calib", "stage2", "stage3", "h1spread", "print"];

class Refused extends Error {}
export const refuse = (what: string): never => {
  throw new Refused("REFUSED: " + what);
};
const isRefused = (e: unknown) => e instanceof Refused || (e instanceof Error && e.message.startsWith("REFUSED: "));
const isStop = (e: unknown) => e instanceof Error && e.message.startsWith("STOP: ");
const isChanged = (e: unknown) => e instanceof Error && e.message.startsWith("CHANGED: ");

// ---- C4f: the checks' inputs apart from the main run's (the lead's H1 and H3; lawsearch-checks.ts' C4f section) ----
//
// keep(u) is called right after each loadUniverse (stage 0's u0, stage 1's u1, stage 2's u2), before the universe is
// handed to any main-run code. It takes the universe's digest (H3: a SHA-256 of every typed array and every other
// value) and a snapshot (a structured clone); the main run goes on with u, and every check of the stage reads the
// snapshot alone, with the checks' own trial definitions and avoid table (H1). afterMain(check, main) is called once
// the main run's part of the stage has made its objects, before the stage's checks: both universes must still have
// their load digest, and no object reachable from the stage's CheckInputs may be reachable from the main run's
// objects (its universe, its trial definitions, its avoid table, its ExclCtx). runner() wraps the units' runner: before
// each check run (one pool run: one cut timeframe, one poison or presence check) the run's universe must be a kept
// snapshot that still has its load digest, and (C4g, the lead's G4: an allow-list, not a list of the main run's
// objects) the task must hold exactly a UnitTask's keys, its trials must be the checks' own definitions and its avoid
// table the checks' own (lawsearch-checks.ts assertTaskAllowed). end(check) at the stage's end compares both universes
// once more and forgets them. A changed digest throws "CHANGED: …" (main() removes the dump folder and exits 7; 6
// until C4g); a shared object throws "SHARED: …" (exit 1). On a clean run nothing is written by any of this (no file,
// no print.txt key, no checks.csv row), so the outputs are the same bytes; its costs go to stderr only. The digests are
// compared again only at those points: a write that is undone before the next of them is not seen (H1 is the guard by
// construction for objects; this is defense in depth). What H3 adds in C4g: it sees the main run write into the
// universe it was handed (a stash: plant seriesStashE04) whatever bar the write is at, where the cut sees only the
// look-ahead on its targets; it costs a few seconds per run (stderr's "digests" line).
interface Kept {
  name: string;
  main: Universe;
  digest: Map<string, string>;
  mainReach: Set<object> | null;
  // the stage's check inputs (set at afterMain): every check run's task is allowed against them
  chk: CheckInputs | null;
}
class Guard {
  private kept = new Map<Universe, Kept>();
  private ms = { snapshot: 0, digest: 0, digests: 0, apart: 0, aparts: 0 };
  async keep(u: Universe, name: string): Promise<Universe> {
    const t0 = Date.now();
    const digest = await universeDigest(u);
    const t1 = Date.now();
    const check = snapshotOf(u);
    const t2 = Date.now();
    this.ms.digest += t1 - t0;
    this.ms.digests++;
    this.ms.snapshot += t2 - t1;
    console.error(`[lawsearch guard] ${name}: digest ${t1 - t0} ms (${digest.size} values), snapshot ${t2 - t1} ms`);
    this.kept.set(check, { name, main: u, digest, mainReach: null, chk: null });
    return check;
  }
  private of(check: Universe, where: string): Kept {
    const k = this.kept.get(check);
    if (!k) throw new Error(`SHARED: ${where}: a check was given a universe that is not a kept snapshot (lawsearch.ts Guard; C4f H1)`);
    return k;
  }
  private async same(k: Kept, u: Universe, which: string, where: string): Promise<void> {
    const t0 = Date.now();
    const d = digestDiff(k.digest, await universeDigest(u));
    this.ms.digest += Date.now() - t0;
    this.ms.digests++;
    if (d.n > 0) throw new Error(`CHANGED: ${where}: ${d.n} values of ${k.name}'s ${which} universe differ from their digest at the load (${d.paths.join(", ")}${d.n > d.paths.length ? ", …" : ""}); the run stops (exit 7, C4f H3)`);
  }
  private apart(k: Kept, check: readonly unknown[], where: string): void {
    const t0 = Date.now();
    assertApart(k.mainReach!, check, where);
    this.ms.apart += Date.now() - t0;
    this.ms.aparts++;
  }
  async afterMain(check: Universe, main: readonly unknown[], chk: CheckInputs, where: string): Promise<void> {
    const k = this.of(check, where);
    await this.same(k, k.main, "main run's", where);
    await this.same(k, check, "snapshot", where);
    const t0 = Date.now();
    k.mainReach = reachOf([k.main, ...main]);
    this.ms.apart += Date.now() - t0;
    if (chk.u !== check) throw new Error(`SHARED: ${where}: the checks' inputs are not of this stage's snapshot (lawsearch.ts Guard; C4f H1)`);
    this.apart(k, [chk.u, chk.trials, chk.avoid], where);
    k.chk = chk;
  }
  async before(u: Universe, task: UnitTask): Promise<void> {
    const where = `before a ${task.kind} check run`;
    const k = this.of(u, where);
    if (k.mainReach === null || k.chk === null) throw new Error(`SHARED: ${where}: a check run before the main run's part of ${k.name} was done (lawsearch.ts Guard; C4f H1)`);
    await this.same(k, u, "snapshot", `${k.name}, ${where}`);
    const t0 = Date.now();
    assertTaskAllowed(task, k.chk, `${k.name}, ${where}`);
    this.ms.apart += Date.now() - t0;
    this.ms.aparts++;
  }
  async end(check: Universe, where: string): Promise<void> {
    const k = this.of(check, where);
    await this.same(k, k.main, "main run's", where);
    await this.same(k, check, "snapshot", where);
    this.kept.delete(check);
  }
  runner(inner: UnitRunner): UnitRunner {
    return { run: async (u, task, next, done) => {
      await this.before(u, task);
      return await inner.run(u, task, next, done);
    } };
  }
  report(): string {
    return `snapshots ${this.ms.snapshot} ms; digests ${this.ms.digest} ms (${this.ms.digests}); identity checks and allow-lists ${this.ms.apart} ms (${this.ms.aparts})`;
  }
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

// ---- the stage checks, kept with their stage ------------------------------------------------------------------

// stage1end: spec 23.2's cut of the chosen trials at the end of stage 1, after the choice (rule 2 of spec 10 does not
// read it: it is made after the choice; its failure withholds stage 1's numbers and stage 2 is not opened)
type StageTag = "gate" | "stage0" | "stage1" | "stage1end" | "stage2" | "end";
interface Tagged {
  stage: StageTag;
  r: CheckResult;
}
const failedOf = (cs: Tagged[]) => cs.filter((c) => !c.r.passed);
// the stage whose numbers a failed check withholds (spec 15: その段の数字を出さない)
const withheldStage = (t: StageTag): StageTag => (t === "stage1end" ? "stage1" : t);
// the stages whose failed check keeps stage 2 closed (design 7.7, the lead's D8; lawsearch-dump.md 11.14 (a))
const BEFORE_STAGE2: readonly StageTag[] = ["gate", "stage0", "stage1", "stage1end"];

// rule 2 of spec 10: every "*" row and every row of the trial passed (checks.csv, as the Python reads it; called at the
// choice, when the checks are those of stages gate, stage0 and stage1)
const checksOkOf = (cs: Tagged[]) => {
  const rows = checksRows(cs.map((c) => c.r));
  const allOk = rows.filter((r) => r[0] === "*").every((r) => r[2] === "1");
  const bad = new Set(rows.filter((r) => r[0] !== "*" && r[2] !== "1").map((r) => r[0]));
  return (id: string) => allOk && !bad.has(id);
};

// ---- environment ------------------------------------------------------------------------------------------------

// C4g (the lead's G1, from the C4g designer "harden"): every setting is read from the environment at once, as main()'s
// first statement, and then the environment is closed for the whole process (Deno.permissions.revokeSync, the stable
// API): the main thread and every worker started AFTER the revoke get NotCapable for any Deno.env call, so no code of
// the run can keep a value in an environment variable for another to read (C4f's review: rp2EnvE04 hid a look-ahead
// that way at every WORKERS). Refusals and their messages are unchanged: only the reads moved.
// C4h (C4g's review, F2; measured on Deno 2.9.6 by C4g's refuter, c4g/refute-power-2): the revoke closes env for this
// thread, and at once for any worker that inherited this thread's permissions (one already running and reading env
// gets NotCapable at the revoke). The checks' workers never hold env at all: they are started with permissions "none"
// (lawsearch-par.ts, followInWorker), which gives NotCapable for env whenever the worker is made, even with no revoke.
// So the ORDER of this revoke and the workers' start is not what keeps env from the checks (C4g said a worker made
// before the revoke keeps env: that was code that ran before the revoke statement, not a worker keeping it); what keeps
// it is "none", which lawsearch-sandbox.ts now tests in every worker (a worker that holds a grant refuses to serve).
const ENV_NAMES = ["MODE", "LS_PLANT", "CUT_MAX", "WORKERS", "HAND_IDS", "TRIALS", "OUT", "GEN", "SEED", "FLIP", "STRENGTH", "RUN", "G_FILE", "KAPPA_DELTA", "KAPPA_PL"] as const;
type EnvName = (typeof ENV_NAMES)[number];
let SETTINGS: ReadonlyMap<string, string> | null = null;
const readSettings = (): void => {
  const m = new Map<string, string>();
  for (const k of ENV_NAMES) {
    const v = Deno.env.get(k);
    if (v !== undefined) m.set(k, v);
  }
  SETTINGS = m;
  Deno.permissions.revokeSync({ name: "env" });
};
const env = (k: EnvName): string | undefined => {
  if (SETTINGS === null) throw new Error("lawsearch.ts: a setting read before readSettings");
  const v = SETTINGS.get(k);
  return v === undefined || v === "" ? undefined : v;
};
const numEnv = (k: EnvName, def: number): number => {
  const v = env(k);
  if (v === undefined) return def;
  const x = Number(v);
  if (!Number.isFinite(x) || !(x > 0)) refuse(`${k} ${JSON.stringify(v)} is not a positive number`);
  return x;
};

// CUT_MAX: null when unset or empty; a positive integer (decimal digits, no sign, no leading zero, a safe integer);
// anything else is refused (exit 2)
export const cutMaxOf = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const x = Number(v);
  if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(x)) return refuse(`CUT_MAX ${JSON.stringify(v)} is not a positive integer (the development cap on the cut's targets per pair; unset for no cap)`);
  return x;
};

// WORKERS (C4b): 4 when unset or empty; a whole number 0 … 64 in decimal digits (no sign, no leading zero); anything
// else is refused (exit 2) before any file is read
export const WORKERS_DEFAULT = 4;
export const workersOf = (v: string | undefined): number => {
  if (v === undefined) return WORKERS_DEFAULT;
  const x = Number(v);
  if (!/^(0|[1-9][0-9]*)$/.test(v) || !(x <= 64)) return refuse(`WORKERS ${JSON.stringify(v)} is not a whole number from 0 to 64 (the workers of the checks cut, poison and presence; unset for ${WORKERS_DEFAULT})`);
  return x;
};

// ---- the pipeline -----------------------------------------------------------------------------------------------

interface RunCtx {
  mode: "syn" | "walkfiles";
  run: string;
  out: string;
  trials: TrialDef[];
  all: TrialDef[];
  plant: string;
  manifest: GenManifest;
  cfg: RunConfig;
  cutMax?: number;
  // where the units of cut, poison and presence run (C4b; lawsearch-checks.ts, lawsearch-par.ts), behind the guard's
  // check before each run (C4f)
  runner: UnitRunner;
  // C4f (the lead's H1): the checks' own trial definitions (copies of trials, the same order), made before the
  // pipeline starts, and the guard of the stages' universes (H1's identity check and H3's digests)
  chkTrials: TrialDef[];
  guard: Guard;
  times: Record<string, number>;
  // every failing bar of the checks cut, cut.chosen.first and cut.chosen.second (ts/cut_fail.csv; C3, D6)
  cutFails: CutFailRow[];
  // C4g (G1): the run's gmo files as read once at gate 3 (checked against the manifest), by their path relative to
  // <run>/gmo; the three loads and the retrace read these bytes, never the disk
  bytes: ReadonlyMap<string, Uint8Array>;
  // C4h (F2): the permissions this thread holds (lawsearch-sandbox.ts grantsHeld), which no check's worker may hold
  grants: readonly Deno.PermissionDescriptor[];
}

// C4g (G1, from the C4g designer "harden"): a file of the run as Deno.readTextFile would give it, from the bytes read at
// gate 3 (UTF-8, invalid sequences replaced, a BOM kept: ignoreBOM, as Deno.readTextFile; checked by the designer on
// ten edge cases); a path that is not one of them is not found, as on the disk
const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });
const readOf = (dir: string, bytes: ReadonlyMap<string, Uint8Array>) => (path: string): Promise<string> => {
  const b = path.startsWith(`${dir}/`) ? bytes.get(path.slice(dir.length + 1)) : undefined;
  if (b === undefined) return Promise.reject(new Deno.errors.NotFound(`${path}: not one of the run's files read at gate 3`));
  return Promise.resolve(DECODER.decode(b));
};
const memSourceOf = (dir: string, bytes: ReadonlyMap<string, Uint8Array>): Source => ({ dir, fetch: false, read: readOf(dir, bytes) });

// C4g (G2): a follow-bar check (spec 15 追う足) in a realm of its own: a worker with no permission, started for this
// call and ended after it (lawsearch-follow-worker.ts). It gets the snapshot's timeframe and the coordinates of the
// table's rows only (lawsearch-trade.ts followRowsOf: pair, T, j, x, direction), never the main run's m, h or PL, and
// answers the recomputed values; the comparison with the table is made here (followCompare), so the CheckResult is
// the one the single loop gave before C4g.
const followInWorker = (set: TfSet, table: BlindTable, grants: readonly Deno.PermissionDescriptor[]): Promise<CheckResult> => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const w = new Worker(new URL("./lawsearch-follow-worker.ts", import.meta.url).href, { type: "module", deno: { permissions: "none" } } as WorkerOptions);
  w.onmessage = (e: MessageEvent) => {
    w.terminate();
    const m = e.data as { ok?: FollowValues; err?: string };
    console.error(`[lawsearch] follow-bars ${table.tf} ${table.half}${table.late ? " late" : ""} in its worker: ${Date.now() - t0} ms (${table.n} rows)`);
    if (m.err !== undefined) reject(new Error(m.err));
    else {
      try {
        resolve(followCompare(table, m.ok!));
      } catch (x) {
        reject(x);
      }
    }
  };
  w.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    w.terminate();
    reject(new Error(`lawsearch: the follow-bar check's worker: ${e.message}`));
  };
  w.onmessageerror = () => {
    w.terminate();
    reject(new Error("lawsearch: the follow-bar check's worker: a message could not be read"));
  };
  // the timeframe without its higher bars (the check reads the pairs' bars only); C4h (F2): with this thread's grants,
  // which the worker tests first (it answers an error, and serves nothing, if it holds one of them)
  w.postMessage({ set: { tf: set.tf, step: set.step, htfStep: set.htfStep, pairs: set.pairs, htf: [], g: [] }, rows: followRowsOf(table), grants });
});

const setOf = (u: Universe, tf: TfKey) => (tf === "m15" ? u.m15 : u.h1);
const blindId = (id: string) => id.startsWith("blind.");
// the checks' own definition of a trial of the main run (C4f, H1)
const chkTrialOf = (c: RunCtx, t: TrialDef): TrialDef => {
  const k = c.chkTrials.find((x) => x.id === t.id);
  if (!k) throw new Error(`the checks have no trial ${t.id}`);
  return k;
};

// Stage 1 / 2's 13 checks (i)–(iv) of a hit trial on the stage's universe; (v) is another agent's hand trace (not run
// on synthetic runs, so a hit row is not selectable: 11 O-5). C4f (H1): (i)–(iii) read chk (the stage's snapshot, the
// checks' trial definition and avoid table) and the main run's signals sig; (iv) reads the raw files (C4g: as read at
// gate 3) and the main run's table.
async function suspicionChecks(c: RunCtx, chk: CheckInputs, trial: TrialDef, sig: TrialSignals, table: BlindTable, tr: TrialRows, answerKnowing: boolean, tagged: Tagged[], stage: StageTag): Promise<SuspectRow["checks"] & { passed: boolean }> {
  const targets = (() => {
    const out: Array<{ tf: TfKey; pi: number; k: number; kinds: string[] }> = [];
    const seen = new Set<string>();
    for (const p of sig.pairs) {
      for (let r = 0; r < p.n; r++) {
        const key = `${p.pi}:${p.i[r]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tf: trial.tf, pi: p.pi, k: p.i[r], kinds: ["signal13"] });
      }
    }
    return out.sort((a, b) => a.pi - b.pi || a.k - b.k);
  })();
  const o = { answerKnowing, plant: c.plant };
  const ct = chkTrialOf(c, trial);
  // 13 (i): CUT_MAX caps this cut too (print.txt's note.cut_max names it; C4a, the lead's E8); its failing bars are not
  // in cut_fail.csv (lawsearch-dump.md 8)
  const cut = await cutCheck(chk.u, [ct], [sig], targets, chk.avoid, { ...o, maxTargets: c.cutMax, runner: c.runner });
  const poison = await poisonCheck(chk.u, [ct], [sig], chk.avoid, { ...o, n: POISON_1000, seed: SEEDS.poison1000, runner: c.runner });
  const presence = await presenceCheck(chk.u, [ct], [sig], chk.avoid, { ...o, seed: SEEDS.poison1000, n: POISON_1000, runner: c.runner });
  const picks = sampleOf(Array.from(tr.rows), 6, SEEDS.poison1000);
  const retrace = await retraceCheck(readOf(`${c.run}/gmo`, c.bytes), c.run, picks.map((r) => ({ pair: PAIRS[table.pi[r]], tf: trial.tf, T: table.T[r], d: table.d[r] as 1 | -1, pl: table.pl[r], m: table.m[r] })));
  for (const [name, r] of [["suspect13.cut", cut], ["suspect13.poison1000", poison], ["suspect13.presence", presence], ["suspect13.retrace", retrace]] as const) {
    tagged.push({ stage, r: { ...r, name: `${name}.${stage}`, probes: r.probes.map((p) => ({ ...p, name: p.name === "retrace" ? trial.id : p.name })) } });
  }
  return { cut: cut.passed, poison1000: poison.passed, presence: presence.passed, retrace: retrace.passed, hand: "not-run", passed: false };
}

const sTrialOf = (all: TrialDef[], tf: TfKey, f: string): TrialDef | null => {
  const s = Object.entries(S_OF_F).find(([, ff]) => ff === f)?.[0];
  return s ? all.find((t) => t.tf === tf && t.kind === "S" && t.s === s) ?? null : null;
};

// Spec 23.2: the chosen trials cut on every higher-timeframe boundary target of one half, the other kinds as stage 0's
// (lawsearch-checks.ts cutTargets): "first" on stage 1's universe ([S0, SPLIT)), at the end of stage 1; "second" on
// stage 2's, its second-half targets only (fromStart = SPLIT). The check is "cut.chosen.<half>"; each failing trial's
// row lists up to 100 failing bars. times gets cut.chosen.<half>.<tf>. C4f (H1): trials are the main run's chosen
// trials; the cut reads chk (the stage's snapshot, the checks' definitions of those trials, their avoid table) and the
// main run's signals sigs.
async function chosenCut(c: RunCtx, chk: CheckInputs, trials: TrialDef[], sigs: TrialSignals[], answerKnowing: boolean, half: "first" | "second", times: Record<string, number>): Promise<CheckResult> {
  const name = `cut.chosen.${half}`;
  if (trials.length === 0) return { name, passed: true, detail: "no trial was chosen: nothing to cut (spec 23.2)", probes: [] };
  const ct = trials.map((t) => chkTrialOf(c, t));
  const stats: Record<string, number> = {};
  const targets = cutTargets(chk.u, ct, sigs, { htf: "all", fromStart: half === "second" ? SPLIT : undefined, stats });
  const note = `${cutStatsText(stats)}; the chosen trials on every higher-timeframe boundary target of the ${half} half, spec 23.2`;
  return await cutCheck(chk.u, ct, sigs, targets, chk.avoid, { answerKnowing, plant: c.plant, maxTargets: c.cutMax, times, name, timeKey: name, maxExamples: 100, note, fails: { stage: half === "first" ? "stage1end" : "stage2", rows: c.cutFails }, runner: c.runner });
}

// the plant blindRowHit (design 8, C3): stage 1's blind row that is reported as hit (its measures unchanged)
const BLIND_ROW_HIT = "blind.m15.USD_JPY.buy";
// spec 13's stop on a blind row (C3, the lead's D10): the note and the console's STOP line
const stop13Text = (stage: "stage1" | "stage2", ids: readonly string[]) =>
  `${stage}: the blind (物差し) rows ${ids.join(" ")} hit spec 13's lines; stop and look (spec 13: 物差しが当たったら、すべて止めて調べる); ${stage === "stage1" ? "stage 1's numbers are withheld and stage 2 is not opened" : "stage 2's numbers are withheld"}`;

// the failing trials of a check and their failing bars, for a STOP line
const failingText = (r: CheckResult): string => r.probes.filter((p) => p.mismatched > 0).map((p) => `${p.name}: ${p.mismatched} of ${p.compared} (${p.examples.join(" | ")})`).join("; ");

async function pipeline(c: RunCtx): Promise<number> {
  const tagged: Tagged[] = [];
  const t0 = Date.now();
  const dir = c.out;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  await dumpConfig(dir, c.cfg);
  // C4g (G1): every load reads the bytes read once at gate 3
  const src = memSourceOf(`${c.run}/gmo`, c.bytes);
  // plant gmoWriteR (lawsearch-events.ts): its folder, and its probes (stderr) at the start of stages 1 and 2
  if (c.plant === "gmoWriteR") GMO_WRITE.dir = `${c.run}/gmo`;
  const gmoProbe = (stage: string, k: Universe, u: Universe) => {
    if (c.plant !== "gmoWriteR") return;
    const at = (x: Universe) => {
      const s = x.m15.pairs.find((p) => p.pair === "USD/JPY")!;
      for (let j = 0; j < s.n; j++) if (s.s[j] === 1710129600000) return String(s.bc[j]);
      return "none";
    };
    const disk = (Deno.readTextFileSync(`${c.run}/gmo/USD_JPY/15min/bid/20240311.json`).match(/\{"openTime":"1710129600000"[^}]*"close":"([0-9.]+)"\}/) ?? [])[1] ?? "none";
    console.error(`[plant gmoWriteR probe] ${stage}: USD/JPY m15 2024-03-11T04:00Z bid close: disk ${disk}, the checks' snapshot ${at(k)}, the main run's universe ${at(u)}`);
  };
  const answerKnowing = c.manifest.spec.group === "O";
  const print: Array<[string, string]> = [];
  const put = (k: string, v: string | number) => print.push([k, String(v).replace(/[\r\n]+/g, " ")]);
  put("run", c.run);
  put("mode", c.mode);
  put("group", c.manifest.spec.group);
  put("seed", c.manifest.spec.seed);
  put("flip", c.manifest.spec.flip ? 1 : 0);
  put("plant", c.plant);
  put("trials", c.trials.map((t) => t.id).join("|"));
  put("kappa.delta", c.cfg.kappaDelta);
  put("kappa.pl", c.cfg.kappaPl);
  put("kappa.from", c.cfg.kappaFrom);
  put("g.from", c.cfg.gFrom);
  // a capped run says so in print.txt, whatever the checks' details (lawsearch-dump.md 2: cut_max); the note names
  // every check the cap reaches, 13 (i)'s cut of hit trials included (suspicionChecks; C4a, the lead's E8)
  if (c.cfg.cut_max !== null) put("note.cut_max", `DEVELOPMENT CAP: CUT_MAX ${c.cfg.cut_max} targets per pair on every cut check (cut, cut.chosen.first, cut.chosen.second, suspect13.cut.stage1, suspect13.cut.stage2); not a formal run`);
  if (c.times.gen !== undefined) put("time.gen.ms", c.times.gen);

  // gate 4: the avoid table actually read (plant avoidFull: the table with the second half) against its sha256
  const avoidPath = c.plant === "avoidFull" ? "research/ledger/spread-hours.csv" : "research/ledger/spread-hours-h1.csv";
  const avoidBytes = await Deno.readFile(avoidPath);
  const avoidSha = await sha256(avoidBytes);
  const avoidOk = avoidSha === SPREAD_H1_SHA256;
  tagged.push({ stage: "gate", r: { name: "avoid", passed: avoidOk, detail: `${avoidPath}: sha256 ${avoidSha}${avoidOk ? "" : `, not ${SPREAD_H1_SHA256}`}`, probes: [] } });
  const stopped = !avoidOk;
  let code = 0;
  const finish = async (): Promise<number> => {
    put("time.total.ms", Date.now() - t0);
    for (const t of tagged) {
      const key = t.r.name.replace(/[^A-Za-z0-9_.]/g, "_");
      put(`check.${key}.passed`, t.r.passed ? 1 : 0);
      put(`check.${key}.detail`, t.r.detail.slice(0, 400));
    }
    for (const st of ["stage0", "stage1", "stage2"] as const) if (tagged.some((t) => withheldStage(t.stage) === st && !t.r.passed)) put(`withheld.${st}`, 1);
    if (code === 0 && failedOf(tagged).length > 0) code = 3;
    put("exit", code);
    const pc = printCheck(print.map(([k]) => k));
    tagged.push({ stage: "end", r: pc });
    await dumpChecks(dir, tagged.map((t) => t.r), tagged.map((t) => t.stage));
    await dumpCutFail(dir, c.cutFails);
    if (pc.passed) await Deno.writeTextFile(`${dir}/print.txt`, print.map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    else code = 3;
    console.log(`exit ${pc.passed ? code : 3}: ${failedOf(tagged).map((t) => t.r.name).join(", ") || "every check passed"}`);
    return pc.passed ? code : 3;
  };
  if (stopped) return await finish();
  // C4f (H1, H2): the table parsed twice from the same bytes, read-only both times: the main run's and the checks'
  const avoidText = new TextDecoder().decode(avoidBytes);
  const avoid = avoidOf(avoidText);
  const avoidChk = avoidOf(avoidText);
  const withheld = (st: StageTag) => tagged.some((t) => withheldStage(t.stage) === st && !t.r.passed);

  const say = (what: string) => console.error(`[lawsearch ${new Date().toISOString()}] ${what}`);
  // C4g (G1, from the C4g designer "harden"): the three stages' universes are loaded here, before any main-run code
  // runs, from the bytes read once at gate 3, and each is kept (its digest and snapshot: the guard) at once. Until C4g
  // stages 1 and 2 loaded theirs from the disk after stage 0's main-run code had run (C4f's review: gmoWriteR, a write
  // into a gmo file, reached every stage-1 and stage-2 snapshot), with the loader's modules in the state that code had
  // left. A load's error is held and thrown again where its stage used to load, so a STOP of stage 1's load is still
  // stop.stage1, and stage 2's is thrown only when stage 2 opens.
  type Loaded = { u: Universe; k: Universe } | { e: unknown };
  const loadKeep = async (purpose: "syn0" | "syn1" | "syn2", toMs: number, name: string): Promise<Loaded> => {
    try {
      const u = await loadUniverse(src, S0, toMs, { purpose, band: "syn", plant: c.plant });
      return { u, k: await c.guard.keep(u, name) };
    } catch (e) {
      return { e };
    }
  };
  const unwrap = (l: Loaded): { u: Universe; k: Universe } => {
    if ("e" in l) throw l.e;
    return l;
  };
  say("the loads (stages 0, 1 and 2, from the bytes read at gate 3)");
  const tl = Date.now();
  const L0 = await loadKeep("syn0", END, "stage 0 (syn0)");
  const L1 = "e" in L0 ? L0 : await loadKeep("syn1", SPLIT, "stage 1 (syn1)");
  const L2 = "e" in L0 ? L0 : await loadKeep("syn2", END, "stage 2 (syn2)");
  console.error(`[lawsearch] the three loads and keeps: ${Date.now() - tl} ms`);
  // ---- stage 0
  say("stage 0");
  let s0: Stage0Out;
  try {
    const ts = Date.now();
    // C4f (H1, H3): the snapshot the checks read, taken before u0 is handed to any main-run code (C4g: at the start)
    const { u: u0, k: k0 } = unwrap(L0);
    const chk0: CheckInputs = { u: k0, trials: c.chkTrials, avoid: avoidChk };
    s0 = await runStage0(u0, c.trials, c.cfg, avoid, chk0, { answerKnowing, plant: c.plant, dumpDir: dir, cutMaxTargets: c.cutMax, cutFails: c.cutFails, runner: c.runner, afterMain: (main) => c.guard.afterMain(k0, [...main, c.all], chk0, "stage 0, after the main run's part") });
    await c.guard.end(k0, "stage 0's end");
    for (const r of s0.checks) tagged.push({ stage: "stage0", r });
    for (const [k, v] of Object.entries(s0.times)) if (k !== "stage0") put(`time.${k}.ms`, v);
    put("time.stage0.ms", Date.now() - ts);
    if (!withheld("stage0")) {
      for (const r of s0.rows) {
        put(`count.stage0.${r.trial}.first`, r.first.counted);
        put(`count.stage0.${r.trial}.second`, r.second.counted);
        if (r.sameAs) put(`same.${r.trial}`, r.sameAs);
      }
      for (const tf of ["m15", "h1"] as const) {
        put(`floor.${tf}`, s0.rows.filter((r) => r.tf === tf && r.floor).length);
        put(`groups.${tf}`, new Set(s0.rows.filter((r) => r.tf === tf && r.group !== "").map((r) => r.group)).size);
      }
    }
  } catch (e) {
    if (!isStop(e)) throw e;
    tagged.push({ stage: "stage0", r: { name: "stop.stage0", passed: false, detail: (e as Error).message, probes: [] } });
    put("note.stage2", "not opened: a STOP in stage 0 (stop.stage0) ended the run");
    return await finish();
  }
  const row0 = new Map<string, Stage0Row>(s0.rows.map((r) => [r.trial, r]));

  // ---- stage 1
  say("stage 1");
  let chosen: Record<TfKey, string[]> = { m15: [], h1: [] };
  let K = 0;
  try {
    const ts = Date.now();
    // C4f (H1, H3): stage 1's snapshot, taken before u1 is handed to any main-run code; stage 1's checks read it (C4g:
    // loaded and kept at the start, before stage 0's main-run code)
    const { u: u1, k: k1 } = unwrap(L1);
    gmoProbe("stage 1", k1, u1);
    const chk1: CheckInputs = { u: k1, trials: c.chkTrials, avoid: avoidChk };
    await dumpLoad(dir, u1, "syn1");
    tagged.push({ stage: "stage1", r: dataCheck(k1) });
    tagged.push({ stage: "stage1", r: h1OnlyCheck(k1) });
    const ctx1 = ctxOfUniverse(u1, avoid, c.plant);
    const inds1 = { m15: indsOf(u1.m15, c.plant), h1: indsOf(u1.h1, c.plant) };
    const sigOf1 = new Map<string, TrialSignals>();
    const sig1 = (t: TrialDef) => {
      let s = sigOf1.get(t.id);
      if (!s) sigOf1.set(t.id, (s = trialSignals(t, setOf(u1, t.tf), inds1[t.tf], ctx1[t.tf], { plant: c.plant, answerKnowing })));
      return s;
    };
    const sigs1 = c.trials.map(sig1);
    await c.guard.afterMain(k1, [u1, c.trials, c.all, avoid, ctx1], chk1, "stage 1, after the main run's signals");
    tagged.push({ stage: "stage1", r: sameFirstHalfCheck(s0.sigs, sigs1) });
    const tables: Record<TfKey, { t: BlindTable; late: BlindTable }> = {} as Record<TfKey, { t: BlindTable; late: BlindTable }>;
    for (const tf of ["m15", "h1"] as const) {
      const t = blindTable(setOf(u1, tf), "first", blindBarsOf(ctx1[tf], setOf(u1, tf), "first"), c.plant);
      const late = lateTable(t, u1.m15, SPLIT, c.plant);
      tables[tf] = { t, late };
      await dumpBlind(dir, t);
      await dumpBlind(dir, late);
      tagged.push({ stage: "stage1", r: await followInWorker(setOf(k1, tf), t, c.grants) });
    }
    const trOf = new Map<string, TrialRows>();
    const rowsOf = (t: TrialDef) => {
      let r = trOf.get(t.id);
      if (!r) {
        const tb = tables[t.tf];
        trOf.set(t.id, (r = trialRows(tb.t, tb.late, sig1(t), "first", setOf(u1, t.tf).pairs, c.plant)));
      }
      return r;
    };
    const measured = c.trials.filter((t) => row0.get(t.id)!.floor && row0.get(t.id)!.sameAs === null);
    const ms: TrialMeasures[] = [];
    for (const t of measured) {
      const tr = rowsOf(t);
      let dF: { rows: Int32Array; against: string } | null = null;
      if (t.kind === "EF" && t.f !== null && DIRECTIONAL_F.includes(t.f)) {
        const sT = sTrialOf(c.all, t.tf, t.f);
        if (sT && trialBuilt(sT)) dF = { rows: rowsOf(sT).rows, against: sT.id };
      }
      ms.push(measureTrial(tables[t.tf].t, tables[t.tf].late, tr, { w0: W0.first, plant: c.plant, dF }));
      await dumpTrades(dir, tables[t.tf].t, tables[t.tf].late, tr, lateWhyOf(tables[t.tf].late)?.why ?? null);
    }
    const blind = [...measureBlindRows(tables.m15.t, tables.m15.late, W0.first), ...measureBlindRows(tables.h1.t, tables.h1.late, W0.first)];
    await dumpMeasures(dir, "stage1", [...ms, ...blind]);
    // spec 13
    const sus: SuspectRow[] = [];
    const blindHits: string[] = [];
    for (const m of [...ms, ...blind]) {
      let s = suspectOf(m);
      // plant blindRowHit (design 8): this blind row is reported as hit at stage 1, its measures unchanged
      if (c.plant === "blindRowHit" && m.trial === BLIND_ROW_HIT) s = { ...s, hitA: true, hit: true };
      let checks: SuspectRow["checks"] = { cut: null, poison1000: null, presence: null, retrace: null, hand: "not-run" };
      let checksPassed: boolean | null = null;
      if (s.hit && !blindId(m.trial)) {
        const t = c.trials.find((x) => x.id === m.trial)!;
        const r = await suspicionChecks(c, chk1, t, sig1(t), tables[t.tf].t, rowsOf(t), answerKnowing, tagged, "stage1");
        checks = { cut: r.cut, poison1000: r.poison1000, presence: r.presence, retrace: r.retrace, hand: r.hand };
        checksPassed = r.passed;
      }
      if (s.hit && blindId(m.trial)) {
        blindHits.push(m.trial);
        tagged.push({ stage: "stage1", r: { name: "suspect.blind.stage1", passed: false, detail: `the blind row ${m.trial} hits spec 13's lines (spec 13: stop and look)`, probes: [] } });
      }
      sus.push({ ...s, checks, checksPassed });
    }
    await dumpSuspect(dir, sus);
    // spec 13 (C3, the lead's D10): a blind row's hit stops the run at the end of stage 1 (the stop before stage 2
    // below; its failed check withholds stage 1's numbers); stage 1 still runs to its end and writes its dumps
    if (blindHits.length > 0) {
      console.log(`STOP: ${stop13Text("stage1", blindHits)}`);
      put("note.stop13", stop13Text("stage1", blindHits));
    }
    // spec 10
    const ok = checksOkOf(tagged);
    const susOf = new Map(sus.map((s) => [s.id, s]));
    const cands: Stage1Cand[] = ms.map((m) => {
      const t = c.trials.find((x) => x.id === m.trial)!;
      const r0 = row0.get(t.id)!;
      const f = t.kind === "B" || t.f === "F00" ? null : t.f;
      const s = susOf.get(t.id)!;
      return {
        id: t.id, tf: t.tf, order: t.order, f, isS: t.kind === "S", directionalF: f !== null && DIRECTIONAL_F.includes(f), passFloor: r0.floor, same: r0.sameAs !== null,
        checksOk: ok(t.id), hasT: m.delta.hasT, delta: m.delta.value, lb: m.delta.lb, pl: m.pl.value, plEx1w: m.extras.plEx1w, dF: m.dF ? m.dF.value : null,
        suspicious: s.hit, suspiciousChecksPassed: s.hit ? s.checksPassed : null, n: m.counted, group: r0.group,
      };
    });
    const out = chooseStage1(cands, QUESTIONS.q4, c.plant);
    const pIut = new Map(ms.map((m) => [m.trial, Math.max(m.delta.p, m.pl.p)]));
    const explain = stage1Explain(cands, pIut);
    await dumpStage1(dir, cands, out, explain, pIut, skipText);
    chosen = out.chosen;
    K = out.K_total;
    const choice = JSON.stringify({ m15: chosen.m15, h1: chosen.h1 });
    await Deno.writeTextFile(`${dir}/choice.json`, choice + "\n");
    console.log(`choice.json sha256 ${await sha256(enc.encode(choice + "\n"))}`);
    // spec 23.2: after the choice, before stage 2 opens, the chosen trials on every boundary target of the first half
    say("stage 1: the cut of the chosen trials (spec 23.2)");
    const cutTimes: Record<string, number> = {};
    const chosenTs = c.trials.filter((t) => chosen.m15.includes(t.id) || chosen.h1.includes(t.id));
    const cut1 = await chosenCut(c, chk1, chosenTs, chosenTs.map(sig1), answerKnowing, "first", cutTimes);
    tagged.push({ stage: "stage1end", r: cut1 });
    for (const [k, v] of Object.entries(cutTimes)) put(`time.${k}.ms`, v);
    await c.guard.end(k1, "stage 1's end");
    put("time.stage1.ms", Date.now() - ts);
    if (!cut1.passed) console.log(`STOP: spec 23.2's cut of the chosen trials failed at the end of stage 1; stage 2 is not opened: ${failingText(cut1)}`);
    if (!withheld("stage1")) {
      put("chosen.m15", chosen.m15.join("|"));
      put("chosen.h1", chosen.h1.join("|"));
      put("K_total", K);
    }
    // the stop before stage 2 (design 7.7, the lead's D8; lawsearch-dump.md 11.14 (a)): any failed check of the gate,
    // stage 0, stage 1 or stage 1's end keeps stage 2 closed (spec 11 opens the second half once, and a run with a
    // known failure must not use it). No check row of its own: note.stage2 names the failed checks.
    const early = [...new Set(failedOf(tagged).filter((t) => BEFORE_STAGE2.includes(t.stage)).map((t) => t.r.name))];
    if (early.length > 0) {
      console.log(`STOP: failed checks before stage 2 (${early.join(", ")}); stage 2 is not opened (spec 11)`);
      put("note.stage2", `not opened: failed checks before stage 2: ${early.join(" ")} (spec 11; design 7.7)`);
      return await finish();
    }
  } catch (e) {
    if (!isStop(e)) throw e;
    tagged.push({ stage: "stage1", r: { name: "stop.stage1", passed: false, detail: (e as Error).message, probes: [] } });
    put("note.stage2", "not opened: a STOP in stage 1 (stop.stage1) ended the run");
    return await finish();
  }

  // ---- stage 2 (spec 11): the chosen trials only; no chosen trial → the second half is not opened. The plant
  // secondHalfAll (spec 16: the second half of trials not chosen is computed) asks for it whatever K is, so that the
  // stage-2 gate meets it even when nothing was chosen.
  if (K === 0 && c.plant !== "secondHalfAll") {
    put("note.stage2", "no trial was chosen: the second half is not opened (spec 10)");
    return await finish();
  }
  say("stage 2");
  try {
    const ts = Date.now();
    // C4f (H1, H3): stage 2's snapshot, taken before u2 is handed to any main-run code; stage 2's checks read it (C4g:
    // loaded and kept at the start)
    const { u: u2, k: k2 } = unwrap(L2);
    gmoProbe("stage 2", k2, u2);
    const chk2: CheckInputs = { u: k2, trials: c.chkTrials, avoid: avoidChk };
    await dumpLoad(dir, u2, "syn2");
    tagged.push({ stage: "stage2", r: dataCheck(k2) });
    const ctx2 = ctxOfUniverse(u2, avoid, c.plant);
    const inds2 = { m15: indsOf(u2.m15, c.plant), h1: indsOf(u2.h1, c.plant) };
    await c.guard.afterMain(k2, [u2, c.trials, c.all, avoid, ctx2], chk2, "stage 2, after the main run's indicators");
    const isChosen = (id: string) => chosen.m15.includes(id) || chosen.h1.includes(id);
    const tables: Record<TfKey, { t: BlindTable; late: BlindTable }> = {} as Record<TfKey, { t: BlindTable; late: BlindTable }>;
    for (const tf of ["m15", "h1"] as const) {
      const t = blindTable(setOf(u2, tf), "second", blindBarsOf(ctx2[tf], setOf(u2, tf), "second"), c.plant);
      const late = lateTable(t, u2.m15, END, c.plant);
      tables[tf] = { t, late };
      await dumpBlind(dir, t);
      await dumpBlind(dir, late);
      tagged.push({ stage: "stage2", r: await followInWorker(setOf(k2, tf), t, c.grants) });
    }
    const sigOf2 = new Map<string, TrialSignals>();
    const sig2 = (t: TrialDef) => {
      let s = sigOf2.get(t.id);
      if (!s) sigOf2.set(t.id, (s = trialSignals(t, setOf(u2, t.tf), inds2[t.tf], ctx2[t.tf], { plant: c.plant, answerKnowing })));
      return s;
    };
    // spec 23.2: the chosen trials on every boundary target of the second half (a failure withholds stage 2's numbers)
    const cutTimes: Record<string, number> = {};
    const chosenTs = c.trials.filter((t) => isChosen(t.id));
    const cut2 = await chosenCut(c, chk2, chosenTs, chosenTs.map(sig2), answerKnowing, "second", cutTimes);
    tagged.push({ stage: "stage2", r: cut2 });
    for (const [k, v] of Object.entries(cutTimes)) put(`time.${k}.ms`, v);
    // spec 23.2 (C3, the lead's D9): a failed cut.chosen.second withholds every stage-2 number in print.txt (its failed
    // check, through withheld()); every stage-2 dump is still written, and the Python compares them as usual
    if (!cut2.passed) console.log(`STOP: spec 23.2's cut of the chosen trials failed on the second half; stage 2's numbers are withheld: ${failingText(cut2)}`);
    const trOf = new Map<string, TrialRows>();
    const rowsOf = (t: TrialDef) => {
      let r = trOf.get(t.id);
      if (!r) {
        const tb = tables[t.tf];
        trOf.set(t.id, (r = trialRows(tb.t, tb.late, sig2(t), "second", setOf(u2, t.tf).pairs, c.plant)));
      }
      return r;
    };
    // spec 10 記録 / 20: the program refuses the second half of a trial that was not chosen
    const measure2 = (t: TrialDef): TrialMeasures => {
      if (!isChosen(t.id)) refuse(`stage 2 of a trial not chosen (${t.id})`);
      let dF: { rows: Int32Array; against: string } | null = null;
      if (t.kind === "EF" && t.f !== null && DIRECTIONAL_F.includes(t.f)) {
        const sT = sTrialOf(c.all, t.tf, t.f);
        if (sT && trialBuilt(sT)) dF = { rows: rowsOf(sT).rows, against: sT.id };
      }
      return measureTrial(tables[t.tf].t, tables[t.tf].late, rowsOf(t), { w0: W0.second, plant: c.plant, dF });
    };
    const asked = c.plant === "secondHalfAll" ? c.trials : c.trials.filter((t) => isChosen(t.id));
    const ms = asked.map(measure2);
    for (const t of asked) await dumpTrades(dir, tables[t.tf].t, tables[t.tf].late, rowsOf(t), lateWhyOf(tables[t.tf].late)?.why ?? null);
    const blind = [...measureBlindRows(tables.m15.t, tables.m15.late, W0.second), ...measureBlindRows(tables.h1.t, tables.h1.late, W0.second)];
    const msK = ms.map((m) => ({ ...m, delta: withKappa(m.delta, c.cfg.kappaDelta), pl: withKappa(m.pl, c.cfg.kappaPl) }));
    await dumpMeasures(dir, "stage2", [...msK, ...blind]);
    const sus: SuspectRow[] = [];
    const blindHits2: string[] = [];
    for (const m of [...ms, ...blind]) {
      const s = suspectOf(m);
      let checks: SuspectRow["checks"] = { cut: null, poison1000: null, presence: null, retrace: null, hand: "not-run" };
      let checksPassed: boolean | null = null;
      if (s.hit && !blindId(m.trial)) {
        const t = c.trials.find((x) => x.id === m.trial)!;
        const r = await suspicionChecks(c, chk2, t, sig2(t), tables[t.tf].t, rowsOf(t), answerKnowing, tagged, "stage2");
        checks = { cut: r.cut, poison1000: r.poison1000, presence: r.presence, retrace: r.retrace, hand: r.hand };
        checksPassed = r.passed;
      }
      if (s.hit && blindId(m.trial)) {
        blindHits2.push(m.trial);
        tagged.push({ stage: "stage2", r: { name: "suspect.blind.stage2", passed: false, detail: `the blind row ${m.trial} hits spec 13's lines (spec 13: stop and look)`, probes: [] } });
      }
      sus.push({ ...s, checks, checksPassed });
    }
    await dumpSuspect(dir, sus);
    // spec 13 (C3, D10): a blind row's hit at stage 2 stops the run at the end of stage 2 (the last stage of the
    // trial): its dumps are all written, and its failed check withholds stage 2's numbers
    if (blindHits2.length > 0) {
      console.log(`STOP: ${stop13Text("stage2", blindHits2)}`);
      put("note.stop13", stop13Text("stage2", blindHits2));
    }
    const susOf = new Map(sus.map((s) => [s.id, s]));
    const cands: Stage2In[] = msK.map((m) => {
      const t = c.trials.find((x) => x.id === m.trial)!;
      const s = susOf.get(t.id)!;
      return {
        id: t.id, tf: t.tf, order: t.order, n: m.counted, weeks: m.weeks, pDelta: m.delta.p, pPl: m.pl.p, tDelta: m.delta.t, tPl: m.pl.t,
        deltaByDir: m.deltaByDir, countedByDir: m.countedByDir, deltaByPair: m.deltaByPair, countedByPair: m.countedByPair,
        lateLb: m.deltaLate.lb, plLate: m.plLate, suspicious: s.hit, suspiciousChecksPassed: s.hit ? s.checksPassed : null, c6: m.c6, plEx1w: m.extras.plEx1w,
        deltaUb: m.delta.ub, deltaLate: m.deltaLate.value, deltaEst: m.delta, dF: m.dF,
      };
    }).sort((a, b) => a.order - b.order);
    const rows = stage2Rows(cands, K, QUESTIONS.q2, QUESTIONS.q4, c.plant);
    await dumpStage2(dir, cands, rows, { delta: c.cfg.kappaDelta, pl: c.cfg.kappaPl });
    await c.guard.end(k2, "stage 2's end");
    put("time.stage2.ms", Date.now() - ts);
    if (!withheld("stage2")) for (const r of rows) put(`verdict.${r.id}`, `${r.verdict} ${r.label}`);
  } catch (e) {
    if (!isStop(e)) throw e;
    tagged.push({ stage: "stage2", r: { name: "stop.stage2", passed: false, detail: (e as Error).message, probes: [] } });
  }
  put("note.kappa", "not run yet: step 7");
  put("note.g", "none: step 4");
  return await finish();
}

// ---- the gates and the modes ------------------------------------------------------------------------------------

async function readManifest(run: string): Promise<GenManifest> {
  if (run.split("/").some((p) => p === ".cache")) refuse(`the run folder ${run} is under a .cache folder`);
  let m: GenManifest;
  try {
    m = JSON.parse(await Deno.readTextFile(`${run}/manifest.json`));
  } catch (e) {
    return refuse(`${run}/manifest.json: ${(e as Error).message}`);
  }
  if (m.version !== GEN_VERSION) refuse(`${run}/manifest.json: version ${JSON.stringify(m.version)}, not ${GEN_VERSION}`);
  return m;
}

async function main(): Promise<number> {
  // C4g (G1): the settings, then the environment closed (before any worker exists)
  readSettings();
  console.error(`[lawsearch] lockdown: removed ${LOCKDOWN.removed.join(" ")}; frozen ${LOCKDOWN.frozen.join(", ") || "nothing"}; ${FROZEN_CONSTANTS} constant objects frozen; env read and revoked`);
  const mode = env("MODE") ?? "";
  // real data: refused before any read
  if (REAL_MODES.includes(mode)) {
    if (TRIAL_PASSED_SHA256 === null) refuse("the small trial has not passed (TRIAL_PASSED_SHA256 is null)");
    refuse(`MODE=${mode} is not built yet`);
  }
  if (!["hand", "syn", "walkfiles"].includes(mode)) refuse(`MODE ${JSON.stringify(mode)} is not one of hand, syn, walkfiles, ${REAL_MODES.join(", ")}`);
  const plant = env("LS_PLANT") ?? "";
  if (plant && !PLANTS.includes(plant)) refuse(`LS_PLANT ${plant} is not a planted error of spec 16`);
  // CUT_MAX (design 7.7, the lead's D5): unset or empty, no cap; otherwise a positive integer in decimal digits, or the
  // run is refused before any file is read (before C3, 0, -3 or abc switched the cut off or were ignored)
  const cutMax = cutMaxOf(env("CUT_MAX"));
  // WORKERS (C4b): refused before any file is read, as CUT_MAX
  const workers = workersOf(env("WORKERS"));
  // gate 1: the rules files
  const rules = await checkRulesFiles();
  if (!rules.passed) refuse(`the rules files: ${rules.detail}`);
  if (mode === "hand") {
    const ids = (env("HAND_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const rs = await runHand({ plant, ids });
    for (const line of handLines(rs)) console.log(line);
    const failed = rs.filter((r) => r.status === "fail").length;
    console.log(`hand: ${rs.filter((r) => r.status === "pass").length} pass, ${failed} fail, ${rs.filter((r) => r.status === "skip").length} skip${plant ? ` (plant ${plant})` : ""}`);
    return failed > 0 ? 4 : 0;
  }
  // gate 2: the trials, every one built
  const all = parseCandidates(JSON.parse(await Deno.readTextFile("research/ledger/lawsearch-candidates.json")));
  const ids = (env("TRIALS") ?? TRIAL_STEP3.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const trials: TrialDef[] = [];
  for (const id of ids) {
    const t = all.find((x) => x.id === id);
    if (!t) refuse(`trial ${id} is not in the ledger`);
    if (!trialBuilt(t!)) refuse(`trial ${id} is not built`);
    trials.push(t!);
  }
  trials.sort((a, b) => a.order - b.order);
  // C4f (the lead's H1): the checks' own trial definitions, made here, before any main-run code is handed the parsed
  // ones (frozen copies, the same order)
  const chkTrials = trials.map(trialCopyOf);
  // gate 3: the run folder
  const times: Record<string, number> = {};
  let run: string;
  let out: string;
  let manifest: GenManifest;
  if (mode === "syn") {
    run = env("OUT") ?? refuse("OUT is needed");
    const spec = genSpecOf({ GEN: env("GEN"), SEED: env("SEED"), FLIP: env("FLIP"), STRENGTH: env("STRENGTH") });
    const tg = Date.now();
    manifest = await writeRun(run, spec);
    times.gen = Date.now() - tg;
    out = `${run}/${plant ? `plant-${plant}` : "ts"}`;
  } else {
    run = env("RUN") ?? refuse("RUN is needed");
    manifest = await readManifest(run);
    out = env("OUT") ?? `${run}/${plant ? `plant-${plant}` : "ts"}`;
  }
  if (out.split("/").some((p) => p === ".cache" || p === "gmo")) refuse(`OUT ${out} is not a dump folder`);
  // C4g (G1): the run's files read once, here; the run reads these bytes only
  const tree = await treeBytes(`${run}/gmo`);
  if (tree.sha256 !== manifest.treeSha256 || tree.files !== manifest.files) {
    console.log(`STOP: ${run}/gmo: tree sha256 ${tree.sha256} (${tree.files} files), the manifest's ${manifest.treeSha256} (${manifest.files})`);
    return 3;
  }
  let g: Record<string, number> = {};
  let gFrom = "none: step 4";
  const gFile = env("G_FILE");
  if (gFile) {
    g = JSON.parse(await Deno.readTextFile(gFile));
    gFrom = gFile;
  }
  const kappaDelta = numEnv("KAPPA_DELTA", 1);
  const kappaPl = numEnv("KAPPA_PL", 1);
  const cfg: RunConfig = {
    mode: mode as "syn" | "walkfiles",
    run,
    trials: trials.map((t) => t.id),
    N: N_BARS,
    questions: { ...QUESTIONS },
    kappaDelta,
    kappaPl,
    kappaFrom: env("KAPPA_DELTA") || env("KAPPA_PL") ? "env" : "not calibrated: step 7",
    g,
    gFrom,
    plant,
    spreadH1Sha256: SPREAD_H1_SHA256,
    cut_max: cutMax,
  };
  // C4g (G2): the checks' pools (lawsearch-par.ts): the cut's made for each cut run, poison's and presence's kept for
  // the run, max(1, WORKERS) workers each, every one with no permission; their workers start at the first check run
  // that uses them. No unit runs in this thread at any WORKERS.
  // C4h (the lead's F2): the grants this thread holds (each path-less name, and read and write on ".", the run folder and
  // the dump folder, that read "granted" here); every check's worker is sent them and refuses to serve if it holds one
  // (lawsearch-sandbox.ts), so a worker that was not started with permissions "none" stops the run
  const grants = grantsHeld([".", run, out]);
  const pools = checkPools(workers, grants);
  console.error(`[lawsearch] the checks' units run on ${workers > 0 ? `${workers} workers` : "one worker (WORKERS=0)"} per pool (WORKERS), no permission; every worker must not hold: ${grantsText(grants)}`);
  // C4f (H1, H3): every check run goes through the guard (lawsearch.ts Guard)
  const guard = new Guard();
  try {
    return await pipeline({ mode: mode as "syn" | "walkfiles", run, out, trials, all, plant, manifest, cfg, cutMax: cutMax ?? undefined, runner: guard.runner(pools), chkTrials, guard, times, cutFails: [], bytes: tree.bytes, grants });
  } catch (e) {
    // H3: a universe changed after its load: the run's dump folder (made by this run, which removed any older one at
    // its start) is removed, so no file of a run whose inputs changed under it is left; exit 7 (6 until C4g)
    if (!isChanged(e)) throw e;
    console.log((e as Error).message);
    await Deno.remove(out, { recursive: true }).catch(() => {});
    console.log(`exit 7: a universe changed after it was loaded; ${out} was removed`);
    return 7;
  } finally {
    console.error(`[lawsearch guard] ${guard.report()}`);
    console.error(`[lawsearch pools] ${JSON.stringify(poolStats)}`);
    pools.close();
  }
}

if (import.meta.main) {
  let code: number;
  try {
    code = await main();
  } catch (e) {
    if (isRefused(e)) {
      console.log((e as Error).message);
      code = 2;
    } else if (isStop(e)) {
      console.log((e as Error).message);
      code = 3;
    } else {
      console.error(e);
      code = 1;
    }
  }
  Deno.exit(code);
}

