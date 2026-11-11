// 法則探し (docs §8.136; C4h, the lead's F2 on C4g's review): the run-time test that a check's worker is sandboxed.
//
// Every worker of the checks (lawsearch-par-worker.ts, lawsearch-follow-worker.ts) is started with deno: { permissions:
// "none" } (lawsearch-par.ts WorkerPool, lawsearch.ts followInWorker): no file, no environment, no net, run, ffi, sys
// or import. That option is what keeps the environment and the files out of a check's realm. (Not the order of the
// env revoke: a "none" worker gets NotCapable for Deno.env whenever it is made, even when the main thread never
// revokes env at all; measured on Deno 2.9.6 by C4g's refuter, c4g/refute-power-2.) If the option were dropped by an
// edit or ignored by a Deno, the worker would inherit the main thread's permissions: under the program's real flags
// (--allow-read=. --allow-write=<OUT>) it could read every file under the repository and write into the dump folder.
// C4g's test queried each permission WITHOUT a path, which reads "prompt" in such an inheriting worker too (only a
// global --allow-read reads "granted" there), so it let that worker serve. A query WITH a path tells the two apart:
// read "." reads "granted" in an inheriting worker and "prompt" in a "none" one (measured, refute-power-2/t/flags2.ts,
// and again by C4h in c4h/f2).
//
// So the main thread lists the grants it holds itself (grantsHeld: each path-less name, and read and write on each of
// the paths it gives: ".", the run folder, the dump folder; the ones that read "granted" in the main thread) and sends
// that list with its first message to every worker; a worker refuses to serve (refusalOf, a clear error) when any of
// them, or any path-less name, reads "granted" in its own realm, and when it was given no list. A worker that is not
// sandboxed therefore stops the run (exit 1) at its first message, before it answers anything. What it cannot stop:
// the module code of the worker's own graph runs at the worker's start, before its first message (an inheriting
// worker's module code could read a file then; the run still stops); and a worker that holds some grant but none of the
// listed ones and no path-less name (an inheriting worker holds them all, so it is refused; the list covers what the
// program is granted: in CI --allow-read=. and --allow-write=<OUT>, locally also the scratch folder that holds the run
// folder, which is in the list).
// It imports nothing and runs no computation of the program.

// every permission name that can be queried without a path (Deno 2.9.6)
const NAMES = ["env", "read", "write", "net", "run", "ffi", "sys", "import"] as const;

const textOf = (d: Deno.PermissionDescriptor): string => {
  const o = d as unknown as Record<string, unknown>;
  const at = o.path ?? o.host ?? o.variable ?? o.command ?? o.kind;
  return at === undefined ? d.name : `${d.name} ${JSON.stringify(at)}`;
};

// the main thread: the descriptors of the fixed list (each path-less name; read and write on each of paths) that read
// "granted" here (plain objects: they go to the workers in a message)
export const grantsHeld = (paths: readonly string[]): Deno.PermissionDescriptor[] => {
  const all: Deno.PermissionDescriptor[] = NAMES.map((name) => ({ name }) as Deno.PermissionDescriptor);
  for (const path of paths) for (const name of ["read", "write"] as const) all.push({ name, path });
  return all.filter((d) => Deno.permissions.querySync(d).state === "granted");
};

// a worker: null when it holds none of the main thread's grants and no path-less name; else why it must not serve
export const refusalOf = (who: string, grants: unknown): string | null => {
  if (!Array.isArray(grants) || grants.length === 0) return `${who}: not sandboxed: it was not given the main thread's grants to test`;
  const bad: string[] = [];
  const all = [...NAMES.map((name) => ({ name }) as Deno.PermissionDescriptor), ...(grants as Deno.PermissionDescriptor[])];
  for (const d of all) if (Deno.permissions.querySync(d).state === "granted") bad.push(textOf(d));
  return bad.length === 0 ? null : `${who}: not sandboxed (granted here: ${bad.join(", ")}); it must be started with deno: { permissions: "none" }`;
};

// stderr only: the list the workers are tested against
export const grantsText = (grants: readonly Deno.PermissionDescriptor[]): string => grants.map(textOf).join(", ");
