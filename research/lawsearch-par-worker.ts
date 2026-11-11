// 法則探し (docs §8.136): one worker of research/lawsearch-par.ts (C4b, the speed-up "par"; C4g, the lead's G2: the
// checks' realms). It holds one universe and one task at a time (both sent again at each run of its pool) and answers
// each job with lawsearch-checks.ts' runUnitJob. C4g:
//   * it is started with deno: { permissions: "none" }: no file, no environment, no net, run, ffi or sys. C4h (the
//     lead's F2): it refuses to serve when it is not sandboxed under the program's real flags: each "universe" message
//     carries the grants the main thread holds (lawsearch-sandbox.ts grantsHeld: read and write on ".", the run folder
//     and the dump folder, and every path-less name, each that reads "granted" there), and if any of them, or any
//     path-less name, reads "granted" in this realm (refusalOf), it throws before it takes the universe, so the run
//     stops (exit 1). C4g's test queried without a path, which reads "prompt" in a worker that inherited
//     --allow-read=. too, so it served (C4g's review);
//   * its first two module requests are lawsearch-lockdown.ts (the permission-free channels between realms deleted) and
//     lawsearch-frozen.ts (the rule constants frozen), evaluated before any module that holds main-run code;
//   * a cut run's universe arrives without bars and grows job by job (applyGrow): the bars of every pair of the task's
//     timeframe with T up to the job's one target, so the realm never holds a bar after the target it decides;
//   * a job carries no want (fix 9.4): every decision that is not "none" goes back and the main thread compares.
// It keeps no state but the universe, the task and the task's UnitCache (poison's uncut holes and tables, functions of
// the universe and the task); a cut worker lives for one cut run, a probe worker (poison, presence) for the whole run.
// The modules it loads are its own instances, which no main-run code of the main thread ever ran in; the answers are
// the same bytes for any WORKERS while those modules keep no state between candidatesOf calls but the builds keyed by
// the Ind and the holes' clock cache (lawsearch-design.md 12.2 (2); C4d).
import "./lawsearch-lockdown.ts";
import "./lawsearch-frozen.ts";
import { runUnitJob, sealTask } from "./lawsearch-checks.ts";
import { refusalOf } from "./lawsearch-sandbox.ts";
import type { UnitCache, UnitJob, UnitTask } from "./lawsearch-checks.ts";
import type { Universe } from "./lawsearch-types.ts";

type Grow = { to: number[]; data: Float64Array };
type Msg =
  | { t: "universe"; u: Universe; keys?: string[]; grants: Deno.PermissionDescriptor[] }
  | { t: "task"; tid: number; task: UnitTask }
  | { t: "job"; tid: number; seq: number; job: UnitJob; grow?: Grow | null };

// C4h (F2): set by the first "universe" message whose grants all read other than "granted" here (refusalOf); until
// then no task or job is taken
let sandboxed = false;

let u: Universe | null = null;
let task: UnitTask | null = null;
let tid = 0;
let cache: UnitCache = {};

// C4g deltas (from the C4g designer "process"): a cut run's universe arrives without bars; each job brings the bars of
// every pair of the task's timeframe up to its target (lawsearch-par.ts growOf: per pair, field by field in keys'
// order), appended here. The arrays are views of the filled part of arrays that double when full (their unfilled
// part holds zeros only, never a bar); each keeps its kind (Float64Array or Int32Array).
let keys: string[] | null = null;
let grown = new Map<string, Float64Array | Int32Array>();
const applyGrow = (g: Grow) => {
  if (u === null || task === null || task.kind !== "cut" || keys === null) throw new Error("lawsearch-par worker: bars for a run that is not a cut");
  const set = task.tf === "m15" ? u.m15 : u.h1;
  let o = 0;
  for (let pi = 0; pi < g.to.length; pi++) {
    const s = set.pairs[pi] as unknown as Record<string, Float64Array | Int32Array> & { n: number };
    const a = s.n;
    const b = g.to[pi];
    if (b === a) continue;
    if (b < a) throw new Error(`lawsearch-par worker: bars of pair ${pi} shrink from ${a} to ${b}`);
    for (const k of keys) {
      const id = `${pi}|${k}`;
      const cur = s[k];
      let arr = grown.get(id);
      if (arr === undefined || arr.length < b) {
        const cap = Math.max(b, 2 * (arr?.length ?? 0), 1024);
        const next = cur instanceof Int32Array ? new Int32Array(cap) : new Float64Array(cap);
        for (let i = 0; i < a; i++) next[i] = cur[i];
        arr = next;
        grown.set(id, arr);
      }
      for (let i = a; i < b; i++) arr[i] = g.data[o++];
      s[k] = arr.subarray(0, b);
    }
    s.n = b;
  }
  if (o !== g.data.length) throw new Error(`lawsearch-par worker: a job's bars hold ${g.data.length} values, ${o} were taken`);
};

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e: MessageEvent) => {
  const m = e.data as Msg;
  if (m.t === "universe") {
    // C4h (F2): a worker that holds any of the main thread's grants (it was not started with permissions "none", or the
    // option was ignored) serves nothing: the error ends the run (lawsearch-par.ts onerror)
    const why = refusalOf("lawsearch-par worker", m.grants);
    if (why !== null) {
      sandboxed = false;
      throw new Error(why);
    }
    sandboxed = true;
    u = m.u;
    keys = m.keys ?? null;
    grown = new Map();
    task = null;
    tid = 0;
    cache = {};
  } else if (!sandboxed) {
    throw new Error(`lawsearch-par worker: a ${m.t} message before a universe it may serve`);
  } else if (m.t === "task") {
    // C4f (the lead's H2): the clone made read-only again (frozen task and trials, read-only avoid table)
    task = sealTask(m.task);
    tid = m.tid;
    cache = {};
  } else if (m.t === "job") {
    if (u === null || task === null || m.tid !== tid) throw new Error(`lawsearch-par worker: job ${m.seq} of task ${m.tid} before its universe or task`);
    if (m.grow) applyGrow(m.grow);
    scope.postMessage({ tid, seq: m.seq, out: runUnitJob(u, task, m.job, cache) });
  }
};
