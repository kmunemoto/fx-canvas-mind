// #318 (docs §8.113): which of the chart methods the app does not have reads the direction best, measured on
// GMO's 5-minute bars by the rule fixed before any data was read (R_cb 2026-10-13 00:00 UTC).
// Step 2 of 22 (the trial, made-up data only): the blind table, breedon-1/2 (K1), donchian-A20/A55 (C1) and
// the two emails' yardsticks (ULTRA 5分足, MACD の山・谷), through stage 0 → 1 → 2, the made-up sets, the
// planted errors, the hand examples and the Python check (research/chartbest-check.py, another agent's).
//
//   CB_MODE=hand        the hand examples (research/chartbest/hand.json) → hand-results.json
//   CB_MODE=gen         a made-up set's day files (CB_SET, CB_SEED, CB_FLIP, CB_PERIOD; CB_FULL=1 the 1-minute ones)
//   CB_MODE=run         one run, end to end (CB_DATA the day files' folder; CB_FULL=1 every check and the dumps, and
//                       stage 2's owner's way (9, research/chartbest-hold.ts: $CB_OUT/hold/; CB_HOLD=0 leaves it out,
//                       CB_HOLD_BUDGET_MIN its wall-clock minutes, default 300; a real stage 2 reads CB_BIS_CSV))
//   CB_MODE=stage0|stage1|stage2   the stages as separate processes on one folder (walk-ledger/), or real (refused)
//   CB_MODE=flip-cmp    an original run's dumps against its flip's (CB_ORIG, CB_FLIPPED)
//   CB_MODE=calib       a set's trial seeds at CB_AMOUNT (light runs; prints the targets, judges nothing)
//   CB_MODE=sets-sum    20 (e)'s conditions over the formal seeds' summary.json files (CB_SETS_DIR)
//   CB_MODE=plants-list the planted errors as JSON;  CB_MODE=plant-sum  each plant run's failed checks
//   CB_MODE=repro-walk  20 (c) rehearsed: macdx.ts MODE=walk's files against the emails' measures (CB_WALK its
//                       walk's folder, CB_MACDX_OUT its report.json and decisions.csv; made-up only)
//   CB_MODE=hold-xcheck 20 (c) rehearsed: ownerhold.ts SIGS=ultra5|macdx5 MODE=synthetic FULL=1's folder against this
//                       program's owner-hold list and path (CB_OH_DIR its syn-none-<seed>, CB_OH_DATA its day files,
//                       default CB_OH_DIR/gmo; made-up only)
//
// Exit: 0 every check passed (or a plant run that completed); 1 a check failed (checks.json written, print.txt
// not kept); 2 refused before reading any data (nothing but checks.json written); 3 a crash.
// The log carries only the checks' names and verdicts, the read lines, sha256s and (made-up) MADEUP lines.

import { Checks, Log } from "./chartbest-checks.ts";
import { plant as currentPlant } from "./chartbest-plants.ts";
import { Refused, cfgFromEnv, envOf } from "./chartbest-run.ts";
import { modeGen, modeRun } from "./chartbest-modes.ts";

const mode = envOf("CB_MODE", "run");
const out = envOf("CB_OUT", "research/out/chartbest/run");
let code = 0;
try {
  const plant = currentPlant();
  if (mode === "gen") code = await modeGen(cfgFromEnv());
  else if (mode === "run" || mode === "stage0" || mode === "stage1" || mode === "stage2") code = await modeRun(cfgFromEnv(), mode, plant);
  else {
    const m = await import("./chartbest-modes.ts");
    const f = (m as unknown as Record<string, (() => Promise<number>) | undefined>)[`mode_${mode.replace(/-/g, "_")}`];
    if (!f) throw new Error(`CB_MODE ${mode}: not a mode`);
    code = await f();
  }
} catch (e) {
  if (e instanceof Refused) {
    const c = new Checks(true);
    c.set("gate.refused", { ok: false, n: 1, detail: e.message });
    await Deno.mkdir(out, { recursive: true });
    await Deno.writeTextFile(`${out}/checks.json`, c.json({ mode, refused: e.message }));
    Log.fail("gate.refused", 1);
    code = 2;
  } else {
    Log.crash(e instanceof Error ? e.stack ?? e.message : String(e));
    code = 3;
  }
}
Log.raw(`EXIT ${code}`);
Deno.exit(code);
