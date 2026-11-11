// 法則探し (docs §8.136; C4g, the lead's G2): the realm of one follow-bar check (spec 15 追う足). lawsearch.ts starts one
// worker of this module per call (four per run at most: stages 1 and 2, m15 and h1), with deno: { permissions: "none" }
// (no file, no environment), sends it one message and ends it after its answer. So the code it runs
// (lawsearch-trade.ts followValues, valuesAt and poisonOpen; lawsearch-bars.ts windowSeries and poisonBars) runs in
// module instances and a realm that no main-run code has ever run in: a module memo that the main run's trades filled
// (C4f's review: the refuter's lenmemo in valuesAt hid the plant entryEarly from follow (i)) is not here, nor is state
// that the main thread's own loads left (the process designer's loadmemo).
// It gets the stage's snapshot timeframe (taken right after the load from the bytes read at gate 3, never handed to
// main-run code) and only the coordinates of the table's rows: pair, T, j, x and direction. It never gets the main
// run's m, h or PL (the values the check compares) nor the table itself (C4g fix 9.4 applied to follow-bars: the main
// run's answer is not in the realm that recomputes it). It answers the recomputed values; lawsearch.ts compares them
// with the table in the main thread (lawsearch-trade.ts followCompare), so the CheckResult is the one followBarChecks
// gave before C4g, byte for byte.
// C4h (the lead's F2 on C4g's review: this worker had no run-time test at all): the message carries the grants the
// main thread holds (lawsearch-sandbox.ts grantsHeld: read and write on ".", the run folder and the dump folder, and
// every path-less name, each that reads "granted" there); if any of them, or any path-less name, reads "granted" in this
// realm (refusalOf: it was not started with permissions "none", or the option was ignored), it answers an error and
// computes nothing, so the run stops (exit 1).
import "./lawsearch-lockdown.ts";
import "./lawsearch-frozen.ts";
import { followValues } from "./lawsearch-trade.ts";
import { refusalOf } from "./lawsearch-sandbox.ts";
import type { FollowRows } from "./lawsearch-trade.ts";
import type { TfSet } from "./lawsearch-types.ts";

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e: MessageEvent) => {
  scope.onmessage = null;
  const m = e.data as { set: TfSet; rows: FollowRows; grants: Deno.PermissionDescriptor[] };
  const why = refusalOf("lawsearch-follow worker", m.grants);
  if (why !== null) {
    scope.postMessage({ err: why });
    return;
  }
  try {
    scope.postMessage({ ok: followValues(m.set, m.rows) });
  } catch (x) {
    scope.postMessage({ err: x instanceof Error ? x.message : String(x) });
  }
};
