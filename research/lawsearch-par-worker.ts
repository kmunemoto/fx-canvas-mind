// 法則探し (docs §8.136): one worker of research/lawsearch-par.ts (C4b, the speed-up "par"; C4g, the lead's G2: the
// checks' realms). It holds one universe and one task at a time (both sent again at each run of its pool) and answers
// each job with lawsearch-checks.ts' runUnitJob. C4g:
//   * it is started with deno: { permissions: "none" }: no file, no environment, no net, run, ffi or sys (and refuses
//     to serve when any of them is granted: notSandboxed below, so a Deno that ignored the option fails closed);
//   * its first two imports are lawsearch-lockdown.ts (the permission-free channels between realms deleted) and
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
import type { UnitCache, UnitJob, UnitTask } from "./lawsearch-checks.ts";
import type { Universe } from "./lawsearch-types.ts";

type Grow = { to: number[]; data: Float64Array };
type Msg =
  | { t: "universe"; u: Universe; keys?: string[] }
  | { t: "task"; tid: number; task: UnitTask }
  | { t: "job"; tid: number; seq: number; job: UnitJob; grow?: Grow | null };

// a worker started with permissions "none" reports "prompt" for each (Deno 2.9.6); "granted" means the option was
// ignored or widened: refuse to serve
const notSandboxed = (): string | null => {
  const bad: string[] = [];
  for (const name of ["env", "read", "write", "net", "run", "ffi", "sys"] as const) {
    const state = Deno.permissions.querySync({ name } as Deno.PermissionDescriptor).state;
    if (state === "granted") bad.push(`${name} ${state}`);
  }
  return bad.length === 0 ? null : `lawsearch-par worker: not sandboxed (${bad.join(", ")}); it must be started with deno: { permissions: "none" }`;
};
const SANDBOX = notSandboxed();

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
  if (SANDBOX !== null) throw new Error(SANDBOX);
  const m = e.data as Msg;
  if (m.t === "universe") {
    u = m.u;
    keys = m.keys ?? null;
    grown = new Map();
    task = null;
    tid = 0;
    cache = {};
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
