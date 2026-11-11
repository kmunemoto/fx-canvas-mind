// 法則探し (docs §8.136, research/lawsearch-spec.md 15, 23.2): the worker pools that run the units of the checks cut,
// poison and presence (C4b, the speed-up "par"; the owner's answer 2026-11-05 「まず速くする」: the program faster, the
// spec and every check unchanged; C4g, the lead's G2: the checks' realms).
//
// What runs where: each check (lawsearch-checks.ts) still enumerates its units in its own order and makes each unit's
// uncut decision ("want") in the main thread; a worker computes a unit's recomputed decision on the unit's own edited
// series (cutGotAt, poisonGotAt, presenceGotAt) and answers every decision that is not "none"; the check compares and
// replays the units in its own order. So the bytes do not depend on the workers: the answers are put back in job order
// before the check reads them (done is called for job q only after jobs 0 … q − 1).
//
// C4g (the lead's G2; lawsearch-design.md 12, its threat model T): no unit runs in the main thread, at any WORKERS
// (WORKERS=0 means one worker in each pool), and every worker is started with deno: { permissions: "none" } (no file,
// no environment, no net, run, ffi or sys; Deno 2.9.6 needs --unstable-worker-options for it and refuses the Worker
// without it, so a run without the flag stops at its first check run: fail closed). Its entry,
// lawsearch-par-worker.ts, imports lawsearch-lockdown.ts and lawsearch-frozen.ts first. C4h (the lead's F2): each
// "universe" message carries the grants the main thread holds (lawsearch-sandbox.ts grantsHeld, given to checkPools),
// and a worker that holds any of them refuses to serve, so a worker started without "none" (or a Deno that ignored the
// option) stops the run at its first message (exit 1). Two kinds of pool:
//   * cut: a pool made for each cut run (one timeframe of one cut check) and ended with it ("fresh"); one target per
//     job; the jobs sent in the order of their target's close T (ties: the check's order); DELTAS: a worker first
//     gets the universe without bars (skeletonOf) and then, with each job, only the bars of the task's timeframe
//     (every pair) with T in (what it holds, T of the job's target] (growOf; lawsearch-par-worker.ts applyGrow appends
//     them); and no job carries its want (fix 9.4, lawsearch-checks.ts mismatchesOf). So when a worker decides target
//     k, its realm has never held a bar after T_k, nor the main run's answer, nor anything of another check run: no
//     state kept there (module bindings, realm globals) and no read of what the realm holds can give the unit a later
//     bar. That is rule 2 by construction for the cut (lawsearch-design.md 12), within the threat model: the code a
//     unit runs is the program's own (no node: module, no eval), and its harness (cutGotAt, prefixSeries, copyOf) is
//     trusted as every check's is. (From the C4g designer "process": deltas, T order, fresh cut workers and fix 9.4;
//     395,071 cut comparisons identical there.) A message queued for a worker is bytes until the worker takes it, so
//     a job in flight behind the current one (DEPTH 2) is not in the realm while the current one runs.
//   * probe: ONE pool for poison and presence, made at their first run and kept for the whole run ("kept"; never given
//     a cut task). Their inputs hold bars after T by the spec (poison's are the real bars shifted by ±7777 points,
//     exactly invertible; presence keeps every bar after the deleted ones), so deltas cannot apply and they catch a
//     naive look-ahead only; state one of their units leaves can reach a later poison or presence unit of the same run
//     (lawsearch-design.md 12.2 (2), the residual). A fresh pool per run would not close that (it is within one run
//     too) and costs about 20 % of m15 presence (measured by the C4g judges), so the pool is kept.
// What a worker holds is still a function of the universe, the task and the jobs it was given; its answers are a
// function of its jobs alone while the code a unit runs keeps every build and cache keyed by the Ind and no state that
// survives between candidatesOf calls (lawsearch-design.md 12.2 (2); C4d). The yml compares WORKERS=0 (one worker per
// pool) with 4 on three runs as defense in depth (C4e).
// Memory: a cut worker holds the task's timeframe up to its current target (arrays that double when full); a probe
// worker holds one copy of the universe being checked (both timeframes, about 100 MB for [S0, END) of the small
// trial) and the temporaries of its current unit.

import type { UnitJob, UnitOut, UnitRunner, UnitTask } from "./lawsearch-checks.ts";
import type { Series, TfSet, Universe } from "./lawsearch-types.ts";

// jobs in flight per worker (the next one waits on the worker while the main thread replays the last one)
const DEPTH = 2;
const ENTRY = new URL("./lawsearch-par-worker.ts", import.meta.url).href;
const NO_WANT_AT = new Int32Array(0);

interface Slot {
  w: Worker;
  // the run whose universe and task this worker holds (0: none)
  tid: number;
  // a cut run's bars this worker holds, per pair of the task's timeframe (deltas)
  held: number[] | null;
  busy: number;
}

interface Reply {
  tid: number;
  seq: number;
  out: UnitOut;
}

// the universe as a probe worker gets it: what the units read (both timeframes, fromMs, toMs); the load reports and
// the data problems stay here (no unit reads them)
const shipOf = (u: Universe): Universe => ({ purpose: u.purpose, fromMs: u.fromMs, toMs: u.toMs, m15: u.m15, h1: u.h1, load: [], problems: [] });

// deltas: the arrays of a series (its Float64Array and Int32Array fields, in key order; any other field than these
// and pair, pi, key, step and n is refused, so that a field added later cannot be left out of the deltas unseen), an
// empty series of the same kinds, the universe without bars (both timeframes; no higher bars: a cut rebuilds them from
// its prefix when a trial reads them)
const SCALARS = new Set(["pair", "pi", "key", "step", "n"]);
const arrayKeysOf = (s: Series): string[] => {
  const o = s as unknown as Record<string, unknown>;
  const keys: string[] = [];
  for (const k of Object.keys(o)) {
    if (o[k] instanceof Float64Array || o[k] instanceof Int32Array) keys.push(k);
    else if (!SCALARS.has(k)) throw new Error(`lawsearch-par: a series field the cut's deltas do not know: ${k}`);
  }
  return keys.sort();
};
const emptyOf = (s: Series): Series => {
  const o: Record<string, unknown> = { pair: s.pair, pi: s.pi, key: s.key, step: s.step, n: 0 };
  for (const k of arrayKeysOf(s)) o[k] = new ((s as unknown as Record<string, { constructor: new (n: number) => unknown }>)[k].constructor)(0);
  return o as unknown as Series;
};
const skeletonOf = (u: Universe): Universe => {
  const e = (set: TfSet): TfSet => ({ tf: set.tf, step: set.step, htfStep: set.htfStep, pairs: set.pairs.map(emptyOf), htf: [], g: [] });
  return { purpose: u.purpose, fromMs: u.fromMs, toMs: u.toMs, m15: e(u.m15), h1: e(u.h1), load: [], problems: [] };
};
// the number of bars with T <= t
const countUpTo = (T: Float64Array, n: number, t: number): number => {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (T[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
};
// the bars a cut worker gets with one job: per pair, the bars up to `to` (from what it held), field by field (keys'
// order) in one Float64Array (every field of a series is a Float64Array or an Int32Array: exact in a double)
export interface Grow {
  to: number[];
  data: Float64Array;
}
// the bars of set with T in (held[pi], Tk] for every pair; held is moved on (null: no new bar)
const growOf = (set: TfSet, keys: string[], held: number[], Tk: number): Grow | null => {
  const to = set.pairs.map((p, pi) => Math.max(held[pi], countUpTo(p.T, p.n, Tk)));
  let rows = 0;
  for (let pi = 0; pi < to.length; pi++) rows += to[pi] - held[pi];
  if (rows === 0) return null;
  const data = new Float64Array(rows * keys.length);
  let o = 0;
  for (let pi = 0; pi < to.length; pi++) {
    const p = set.pairs[pi] as unknown as Record<string, ArrayLike<number>>;
    for (const k of keys) {
      const a = p[k];
      for (let i = held[pi]; i < to[pi]; i++) data[o++] = a[i];
    }
    held[pi] = to[pi];
  }
  return { to, data };
};
// a cut job's target close (its one target; an inert job, without a target, goes first)
const timeOf = (set: TfSet, job: UnitJob): number => (job.ks.length === 0 ? -Infinity : set.pairs[job.pi].T[job.ks[0]]);

// the run's costs of the pools (stderr only)
export const poolStats = { cutRuns: 0, probeRuns: 0, spawns: 0, spawnMs: 0, sortMs: 0, growMs: 0, growRows: 0 };

export class WorkerPool implements UnitRunner {
  readonly size: number;
  readonly kind: "cut" | "probe";
  private slots: Slot[] = [];
  private lastTid = 0;
  private onReply: ((slot: Slot, m: Reply) => void) | null = null;
  private onFail: ((e: Error) => void) | null = null;
  private broken: Error | null = null;
  // C4h (F2): the main thread's grants, sent with every "universe" message (the worker refuses to serve if it holds one)
  private readonly grants: Deno.PermissionDescriptor[];

  // kind "cut": fresh workers for every run, cut tasks only; "probe": workers kept for the run, poison and presence only
  constructor(size: number, kind: "cut" | "probe", grants: readonly Deno.PermissionDescriptor[]) {
    if (!(Number.isInteger(size) && size >= 1)) throw new Error(`WorkerPool: ${size} workers`);
    if (grants.length === 0) throw new Error("WorkerPool: no grant of the main thread to test the workers against");
    this.size = size;
    this.kind = kind;
    this.grants = grants.map((d) => ({ ...d }));
  }

  private spawn() {
    const t0 = Date.now();
    for (let k = 0; k < this.size; k++) {
      // no permission at all (--unstable-worker-options; Deno refuses the option without the flag: fail closed)
      const w = new Worker(ENTRY, { type: "module", deno: { permissions: "none" } } as WorkerOptions);
      const slot: Slot = { w, tid: 0, held: null, busy: 0 };
      w.onmessage = (e: MessageEvent) => this.onReply?.(slot, e.data as Reply);
      const failed = (what: string) => {
        const err = new Error(`lawsearch-par: ${this.kind} worker ${k}: ${what}`);
        this.broken = err;
        this.onFail?.(err);
      };
      w.onerror = (e: ErrorEvent) => {
        e.preventDefault();
        failed(e.message);
      };
      w.onmessageerror = () => failed("a message could not be read");
      this.slots.push(slot);
    }
    poolStats.spawns += this.size;
    poolStats.spawnMs += Date.now() - t0;
  }

  run(u: Universe, task: UnitTask, next: () => UnitJob | null, done: (out: UnitOut) => void): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);
    if (this.onReply !== null) return Promise.reject(new Error("lawsearch-par: one run at a time"));
    const cut = task.kind === "cut";
    if (cut !== (this.kind === "cut")) return Promise.reject(new Error(`lawsearch-par: a ${task.kind} task given to the ${this.kind} pool`));
    // cut: fresh workers for this run (ended when it settles); probe: made once, kept
    if (cut) {
      if (this.slots.length > 0) this.close();
      this.spawn();
      poolStats.cutRuns++;
    } else {
      if (this.slots.length === 0) this.spawn();
      poolStats.probeRuns++;
    }
    const tid = ++this.lastTid;
    const cutSet = task.kind === "cut" ? (task.tf === "m15" ? u.m15 : u.h1) : null;
    const cutKeys = cutSet === null || cutSet.pairs.length === 0 ? null : arrayKeysOf(cutSet.pairs[0]);
    // a cut run's jobs, all made first and sent in T order (seq: the check's order, in which done is called)
    let order: Array<{ seq: number; job: UnitJob; t: number }> | null = null;
    let pre: { e: unknown } | null = null;
    if (cutSet !== null) {
      const t0 = Date.now();
      order = [];
      try {
        for (let j = next(); j !== null; j = next()) {
          if (j.ks.length > 1) throw new Error("lawsearch-par: a cut job with more than one target");
          order.push({ seq: order.length, job: j, t: timeOf(cutSet, j) });
        }
      } catch (e) {
        pre = { e };
      }
      order.sort((a, b) => a.t - b.t || a.seq - b.seq);
      poolStats.sortMs += Date.now() - t0;
    }
    return new Promise<void>((resolve, reject) => {
      let seq = 0;
      let oi = 0;
      let nextDone = 0;
      let inflight = 0;
      // no more jobs: next gave null, or an error stopped the feeding
      let ended = false;
      // the first error of done (in job order: done is called in order) and of next; a dead worker's
      let doneErr: { e: unknown } | null = null;
      let nextErr: { e: unknown } | null = pre;
      let fatal: Error | null = null;
      const answers = new Map<number, UnitOut>();
      const settle = () => {
        if (fatal === null && (inflight > 0 || !ended)) return;
        this.onReply = null;
        this.onFail = null;
        // a cut run's workers end with it
        if (cut) this.close();
        if (fatal !== null) reject(fatal);
        else if (doneErr !== null) reject(doneErr.e);
        else if (nextErr !== null) reject(nextErr.e);
        else resolve();
      };
      const feed = (slot: Slot) => {
        while (!ended && slot.busy < DEPTH) {
          let job: UnitJob | null;
          let jseq: number;
          if (order !== null) {
            if (oi >= order.length) {
              ended = true;
              break;
            }
            job = order[oi].job;
            jseq = order[oi].seq;
            oi++;
          } else {
            try {
              job = next();
            } catch (e) {
              nextErr = { e };
              ended = true;
              break;
            }
            if (job === null) {
              ended = true;
              break;
            }
            jseq = seq++;
          }
          // this run's universe and task, before the worker's first job of the run (a cut worker: no bar yet)
          if (slot.tid !== tid) {
            if (cutSet !== null) {
              slot.w.postMessage({ t: "universe", u: skeletonOf(u), keys: cutKeys, grants: this.grants });
              slot.held = cutSet.pairs.map(() => 0);
            } else slot.w.postMessage({ t: "universe", u: shipOf(u), grants: this.grants });
            slot.w.postMessage({ t: "task", tid, task });
            slot.tid = tid;
          }
          let grow: Grow | null = null;
          if (cutSet !== null && job.ks.length > 0) {
            const t0 = performance.now();
            grow = growOf(cutSet, cutKeys!, slot.held!, timeOf(cutSet, job));
            poolStats.growMs += performance.now() - t0;
            if (grow !== null) poolStats.growRows += grow.data.length / cutKeys!.length;
          }
          // fix 9.4: the job goes without its want (the check compares in its own thread)
          slot.w.postMessage({ t: "job", tid, seq: jseq, job: { ...job, wantAt: NO_WANT_AT, wantStr: [] }, grow });
          slot.busy++;
          inflight++;
        }
      };
      this.onReply = (slot, m) => {
        if (m.tid !== tid) return;
        slot.busy--;
        inflight--;
        answers.set(m.seq, m.out);
        // the answers in job order
        while (answers.has(nextDone)) {
          const out = answers.get(nextDone)!;
          answers.delete(nextDone);
          nextDone++;
          if (doneErr !== null) continue;
          try {
            done(out);
          } catch (e) {
            doneErr = { e };
            ended = true;
          }
        }
        feed(slot);
        settle();
      };
      this.onFail = (e) => {
        fatal = e;
        settle();
      };
      for (const s of this.slots) feed(s);
      settle();
    });
  }

  close() {
    for (const s of this.slots) s.w.terminate();
    this.slots = [];
  }
}

// The checks' runners of one run (lawsearch.ts): a cut pool and a probe pool of max(1, WORKERS) workers each; run()
// sends a cut task to the cut pool and poison's and presence's to the probe pool; close() ends both. grants: the
// permissions the main thread holds (lawsearch-sandbox.ts grantsHeld; C4h, F2), which no worker may hold.
export function checkPools(workers: number, grants: readonly Deno.PermissionDescriptor[]): UnitRunner & { close(): void; size: number } {
  const size = Math.max(1, workers);
  const cut = new WorkerPool(size, "cut", grants);
  const probe = new WorkerPool(size, "probe", grants);
  return {
    size,
    run: (u, task, next, done) => (task.kind === "cut" ? cut : probe).run(u, task, next, done),
    close: () => {
      cut.close();
      probe.close();
    },
  };
}
