// 法則探し (docs §8.136; C4g, the lead's G3): the delete-only lockdown of a realm. It is the FIRST module request of
// every entry point of the program (lawsearch.ts, the units' worker lawsearch-par-worker.ts, the follow-bar checks'
// worker lawsearch-follow-worker.ts, the flip judgement lawsearch-flip.ts) and imports nothing itself, so its
// statements run before any other module of the realm is evaluated. (C4h, the lead's F4: "first" counts every value
// module request in source order, re-exports included, as ES modules evaluate them; the yml's graph audit,
// lawsearch-audit.ts, checks it from the source text and from deno info. Until C4h it counted import lines only, so an
// `export … from` above this import would have run its module graph before the lockdown.)
//
// It removes, from the realm's global object and the Deno namespace, the permission-free ways in which one realm of
// the process (the main thread or a worker started with deno: { permissions: "none" }) can leave a value for another
// realm, or for a later process, to read (measured on Deno 2.9.6 by the C4g designers and judges):
//   * BroadcastChannel (joins every realm of the process);
//   * CacheStorage: caches, CacheStorage, Cache (shared by the workers of one entry module, in one process and across
//     processes: it persists on disk; the judge's judgeCacheCarryE04 carried a memo from presence units into a later
//     cut run that way);
//   * Web Storage: localStorage, sessionStorage, Storage (localStorage persists on disk across runs);
//   * the whole navigator (navigator.locks: a lock's name, held by one worker, is read by a fresh worker of another
//     entry module), Navigator, WorkerNavigator;
//   * signals: Deno.kill, Deno.addSignalListener, Deno.removeSignalListener, and the global process (node's);
//   * Deno[Deno.internal] (the runtime's internals).
// It deletes (and, since C4h, freezes two prototypes of the main realm, below; no other intrinsic is frozen: freezing
// the built-in prototypes costs 3–10 % of a unit's time, measured by the C4g judges and designers, and would protect
// against deliberate hooks only, which the threat model leaves out: research/lawsearch-design.md 12). It changes no value any computation reads. What it cannot stop: a `node:` built-in
// (node:worker_threads gives a BroadcastChannel back, node:process signals); the yml's source rule refuses any node:
// specifier in the program's modules, and eval/Function are off (--v8-flags=--disallow-code-generation-from-strings),
// so such an import can only be a literal that the rule sees.

const removed: string[] = [];
// delete o[k]; when it cannot be deleted (or it is found on a prototype), shadow it with an unconfigurable undefined
const gone = (o: object | undefined | null, k: PropertyKey, name: string): void => {
  if (o === undefined || o === null) return;
  if (!(k in o)) return;
  if (!Reflect.deleteProperty(o, k) || k in o) Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false, enumerable: false });
  removed.push(name);
};
const g = globalThis as unknown as Record<PropertyKey, unknown>;
for (const k of ["BroadcastChannel", "caches", "CacheStorage", "Cache", "localStorage", "sessionStorage", "Storage", "navigator", "Navigator", "WorkerNavigator", "process"]) gone(g, k, k);
const D = Deno as unknown as Record<PropertyKey, unknown> & { internal: symbol };
const internal = D.internal;
for (const k of ["kill", "addSignalListener", "removeSignalListener"]) gone(D, k, `Deno.${k}`);
gone(D, internal, "Deno[Deno.internal]");

// C4h (the lead's F7 on C4g's review; outside the threat model T, which leaves deliberate concealment out): in the
// MAIN realm only (a worker realm has WorkerGlobalScope), Worker.prototype and EventTarget.prototype are frozen and
// globalThis.Worker is made read-only and unconfigurable. So no later module of the main realm can wrap
// Worker.prototype.postMessage, redefine the onmessage setter (or any other member of either prototype), or put another
// Worker in its place: the two relays C4g's refuter built (c4g/refute-power-3: a main-realm wrap of postMessage, and an
// onmessage-setter hook, each adding the main run's later bars to what a cut worker is sent, so that a worker-side
// listener hid the cut; both exit 0 on C4g's code) now stop with a TypeError when the plant installs its hook (exit 1).
// What it does NOT close (design 12.7, residual 10): hooks on other built-ins the harness calls with a worker or a
// message (Array.prototype.push, which takes par.ts's slot; Object.prototype setters; the MessageEvent data getter;
// structuredClone-adjacent built-ins), and a realm that tells a check realm from the main realm. No worker realm's
// intrinsic is frozen (a unit's hot path runs there; freezing the built-in prototypes cost 3–10 % of a unit's time, C4g).
// Cost: these two prototypes are not on any hot path (C4h: measured on whole C 7101 runs, design 12.9).
const frozen: string[] = [];
if (!("WorkerGlobalScope" in globalThis) && typeof Worker === "function") {
  Object.freeze(Worker.prototype);
  Object.freeze(EventTarget.prototype);
  const W = Worker;
  Object.defineProperty(globalThis, "Worker", { value: W, writable: false, configurable: false, enumerable: false });
  frozen.push("Worker.prototype", "EventTarget.prototype", "globalThis.Worker (pinned)");
}

// what was removed and frozen (stderr lines only; no output file names it)
export const LOCKDOWN: Readonly<{ removed: readonly string[]; frozen: readonly string[] }> = Object.freeze({ removed: Object.freeze([...removed]), frozen: Object.freeze([...frozen]) });
