// 法則探し (docs §8.136; C4g, the lead's G3): the delete-only lockdown of a realm. It is the FIRST import of every
// entry point of the program (lawsearch.ts, the units' worker lawsearch-par-worker.ts, the follow-bar checks' worker
// lawsearch-follow-worker.ts) and imports nothing itself, so its statements run before any other module of the realm
// is evaluated.
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
// It only deletes (no intrinsic is frozen: freezing the built-in prototypes costs 3–10 % of a unit's time, measured by
// the C4g judges and designers, and would protect against deliberate hooks only, which the threat model leaves out:
// research/lawsearch-design.md 12). It changes no value any computation reads. What it cannot stop: a `node:` built-in
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

// what was removed (stderr lines only; no output file names it)
export const LOCKDOWN: Readonly<{ removed: readonly string[] }> = Object.freeze({ removed: Object.freeze([...removed]) });
