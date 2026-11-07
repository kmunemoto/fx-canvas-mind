// 法則探し (docs §8.136, research/lawsearch-spec.md 15, 23.2): the worker pool that runs the units of the checks cut,
// poison and presence (C4b, the speed-up "par"; the owner's answer 2026-11-05 「まず速くする」: the program faster, the
// spec and every check unchanged).
//
// What runs where: each check (lawsearch-checks.ts) still enumerates its units in its own order, makes each unit's
// uncut decision ("want") in the main thread and replays the units in that order; a worker only computes a unit's
// recomputed decision on the unit's own edited series (cutGotAt, poisonGotAt, presenceGotAt: the loops' bodies before
// C4b) and answers which units differ from want. So:
//   * the bytes do not depend on the workers: the answers are put back in job order before the check reads them
//     (done is called for job q only after jobs 0 … q − 1), and a job's answer is a function of the universe, the
//     task and the job alone (the workers hold no other state: one universe, one task and poison's per-task copy of
//     the uncut holes, a function of those two);
//   * the checks keep their power: a worker computes exactly what the loop computed, on its own copy of the same
//     universe (structured clone copies every typed array value for value), and no unit reads another unit's work.
//     The universe is sent again at every run (every check and timeframe), so a worker's copy is the universe as
//     the main thread holds it when the check starts; nothing in the main thread changes it while the check runs
//     (the check's own code only reads it, and the pipeline awaits the check).
// Memory: each worker holds one copy of the universe being checked (both timeframes, about 100 MB for [S0, END) of
// the small trial) and the temporaries of its current unit.

import type { UnitJob, UnitOut, UnitRunner, UnitTask } from "./lawsearch-checks.ts";
import type { Universe } from "./lawsearch-types.ts";

// jobs in flight per worker (the next one waits on the worker while the main thread replays the last one)
const DEPTH = 2;

interface Slot {
  w: Worker;
  // the run whose universe and task this worker holds (0: none)
  tid: number;
  busy: number;
}

interface Reply {
  tid: number;
  seq: number;
  out: UnitOut;
}

// the universe as a worker gets it: what the units read (both timeframes, fromMs, toMs); the load reports and the
// data problems stay here (no unit reads them)
const shipOf = (u: Universe): Universe => ({ purpose: u.purpose, fromMs: u.fromMs, toMs: u.toMs, m15: u.m15, h1: u.h1, load: [], problems: [] });

export class WorkerPool implements UnitRunner {
  readonly size: number;
  private slots: Slot[] = [];
  private lastTid = 0;
  private onReply: ((slot: Slot, m: Reply) => void) | null = null;
  private onFail: ((e: Error) => void) | null = null;
  private broken: Error | null = null;

  constructor(size: number) {
    if (!(Number.isInteger(size) && size >= 1)) throw new Error(`WorkerPool: ${size} workers`);
    this.size = size;
  }

  private spawn() {
    for (let k = 0; k < this.size; k++) {
      const w = new Worker(new URL("./lawsearch-par-worker.ts", import.meta.url).href, { type: "module" });
      const slot: Slot = { w, tid: 0, busy: 0 };
      w.onmessage = (e: MessageEvent) => this.onReply?.(slot, e.data as Reply);
      const failed = (what: string) => {
        const err = new Error(`lawsearch-par: worker ${k}: ${what}`);
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
  }

  run(u: Universe, task: UnitTask, next: () => UnitJob | null, done: (out: UnitOut) => void): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);
    if (this.onReply !== null) return Promise.reject(new Error("lawsearch-par: one run at a time"));
    if (this.slots.length === 0) this.spawn();
    const tid = ++this.lastTid;
    return new Promise<void>((resolve, reject) => {
      let seq = 0;
      let nextDone = 0;
      let inflight = 0;
      // no more jobs: next gave null, or an error stopped the feeding
      let ended = false;
      // the first error of done (in job order: done is called in order) and of next; a dead worker's
      let doneErr: { e: unknown } | null = null;
      let nextErr: { e: unknown } | null = null;
      let fatal: Error | null = null;
      const answers = new Map<number, UnitOut>();
      const settle = () => {
        if (fatal === null && (inflight > 0 || !ended)) return;
        this.onReply = null;
        this.onFail = null;
        if (fatal !== null) reject(fatal);
        else if (doneErr !== null) reject(doneErr.e);
        else if (nextErr !== null) reject(nextErr.e);
        else resolve();
      };
      const feed = (slot: Slot) => {
        while (!ended && slot.busy < DEPTH) {
          let job: UnitJob | null;
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
          // this run's universe and task, before the worker's first job of the run
          if (slot.tid !== tid) {
            slot.w.postMessage({ t: "universe", u: shipOf(u) });
            slot.w.postMessage({ t: "task", tid, task });
            slot.tid = tid;
          }
          slot.w.postMessage({ t: "job", tid, seq: seq++, job });
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
