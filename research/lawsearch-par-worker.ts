// 法則探し (docs §8.136): one worker of research/lawsearch-par.ts (C4b, the speed-up "par"). It holds one universe and
// one task at a time (both sent again at each run of the pool) and answers each job with lawsearch-checks.ts'
// runUnitJob, the very function the checks call when they run their units in place. It reads no file and no
// environment and writes nothing; it keeps no state but the universe, the task and the task's UnitCache (poison's
// uncut holes, a function of the universe and the task).

import { runUnitJob } from "./lawsearch-checks.ts";
import type { UnitCache, UnitJob, UnitTask } from "./lawsearch-checks.ts";
import type { Universe } from "./lawsearch-types.ts";

type Msg =
  | { t: "universe"; u: Universe }
  | { t: "task"; tid: number; task: UnitTask }
  | { t: "job"; tid: number; seq: number; job: UnitJob };

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };

let u: Universe | null = null;
let task: UnitTask | null = null;
let tid = 0;
let cache: UnitCache = {};

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as Msg;
  if (m.t === "universe") {
    u = m.u;
    task = null;
    tid = 0;
    cache = {};
  } else if (m.t === "task") {
    task = m.task;
    tid = m.tid;
    cache = {};
  } else if (m.t === "job") {
    if (u === null || task === null || m.tid !== tid) throw new Error(`lawsearch-par worker: job ${m.seq} of task ${m.tid} before its universe or task`);
    scope.postMessage({ tid, seq: m.seq, out: runUnitJob(u, task, m.job, cache) });
  }
};
