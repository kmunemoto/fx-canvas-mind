// 法則探し (docs §8.136; C4g, the lead's G3): the static audits of the program's realms, run by the yml's hand job
// (.github/workflows/lawsearch.yml). It is not part of the program (no module of the program imports it) and reads only
// the module graphs `deno info --json` wrote for the entry points (<dir>/graph-<entry>.json) and the graphs' source
// files. Usage: deno run --no-config --allow-read=.,<dir> research/lawsearch-audit.ts <graph|source|catch|trigger> <dir>,
// or deno run --no-config research/lawsearch-audit.ts relay
// Exit 0 when the audit holds, 1 when it does not (each offending module or line printed), 2 on a wrong call.
//
//   graph   every module of the graphs of the realms' entry points (lawsearch.ts, lawsearch-par-worker.ts,
//           lawsearch-follow-worker.ts, lawsearch-flip.ts) is a TypeScript file of the repository, not under research/out
//           or research/ledger, with no dynamic import and every dependency a module of the graph (a worker's graph is
//           loaded under the read permission of the realm that starts it, Deno 2.9.6: a literal import of a data file
//           would be read even by a worker with no permission); each entry's first two module requests are
//           lawsearch-lockdown.ts and lawsearch-frozen.ts (C4h, the lead's F4 on C4g's review: every value module
//           request counts, in source order, re-exports included: import … from, import "…", export … from and export *
//           from, which an ES module evaluates in that order; only import type and export type are skipped; read twice,
//           from the source text and from deno info's own parse of the entry, and both must agree; until C4h only the
//           import lines were read, so a re-export above the lockdown ran its whole graph before it unseen);
//           lawsearch-lockdown.ts imports nothing; lawsearch-frozen.ts's
//           graph holds no lawsearch module but lawsearch-const.ts, lawsearch-rules.ts and lawsearch-types.ts; and
//           trend-stats.ts and bigflow-lib.ts (the main thread's check-only code) are imported by lawsearch-checks.ts alone
//   source  the source rule: no code line of those graphs holds node:, import(, eval, Function( / new Function, Deno[ /
//           Deno.internal, SharedArrayBuffer / Atomics or new Worker, but the lines of SOURCE_ALLOW
//   catch   every Deno call inside a try block, or on a line with .catch(, in those graphs is one of CATCH_ALLOW
//   trigger (C4h, the lead's F5 on C4g's review) every module of those graphs is matched by a push path of
//           .github/workflows/lawsearch.yml or .github/workflows/lawsearch-audit.yml, so a push that changes any of them
//           runs this file's audits (lawsearch-audit.yml runs them on a change to a module the program shares with
//           other code: C4g's guarantees rest on the text of some of them, e.g. trend-data.ts's src.read line and
//           CATCH_ALLOW's pinned lines). A module of the graphs that no path matches fails the step, so the list cannot
//           go stale; a path of lawsearch-audit.yml that matches no module is printed (information)
//   relay   (C4h, the lead's F7; outside the threat model) the main realm's freeze of lawsearch-lockdown.ts holds: after
//           the lockdown is evaluated in this (main) realm, wrapping Worker.prototype.postMessage, redefining its
//           onmessage setter, replacing globalThis.Worker and wrapping EventTarget.prototype.addEventListener each throw
//           a TypeError (the two relays C4g's refuter built, c4g/refute-power-3, need the first two). The graph audit
//           shows that the lockdown is the first module request of every entry, so these hold in the program's main realm

const ENTRIES = ["lawsearch.ts", "lawsearch-par-worker.ts", "lawsearch-follow-worker.ts", "lawsearch-flip.ts"];

// the source rule's allowed lines (file, the line's text without its leading and trailing blanks), and why
const SOURCE_ALLOW: ReadonlyArray<readonly [string, string, string]> = [
  ["research/lawsearch-lockdown.ts", 'gone(D, internal, "Deno[Deno.internal]");', "the lockdown deletes the runtime's internals"],
  ["research/lawsearch-par.ts", 'const w = new Worker(ENTRY, { type: "module", deno: { permissions: "none" } } as WorkerOptions);', "the checks' pools: workers with no permission"],
  ["research/lawsearch.ts", 'const w = new Worker(new URL("./lawsearch-follow-worker.ts", import.meta.url).href, { type: "module", deno: { permissions: "none" } } as WorkerOptions);', "the follow-bar check's worker: no permission"],
];

// every Deno call inside a try block or with .catch(: (file, the line's text), and what an error there does
const CATCH_ALLOW: ReadonlyArray<readonly [string, string, string]> = [
  ["research/lawsearch-bars.ts", "body = JSON.parse(await (src.read ?? Deno.readTextFile)(`${src.dir}/${symbol}/${interval}/${side}/${key}.json`));", "the program reads through src.read, the bytes of gate 3 (no permission); a path not among them is NotFound: a read failure, as a missing file was (the data check fails)"],
  ["research/trend-data.ts", "body = JSON.parse(await (src.read ?? Deno.readTextFile)(path));", "as lawsearch-bars.ts loadPairTf"],
  ["research/lawsearch-checks.ts", "const rows = parseCandidates(JSON.parse(await Deno.readTextFile(`${root}/research/ledger/lawsearch-candidates.json`)));", "a refused read fails the ledger probe: gate 1 refuses (exit 2)"],
  ["research/lawsearch-dump.ts", "await Deno.stat(path);", "only NotFound is caught (a new file); any other error is thrown (C4g)"],
  ["research/lawsearch-dump.ts", "if (!(e instanceof Deno.errors.NotFound)) throw e;", "the line that rethrows"],
  ["research/lawsearch-gen.ts", "await Deno.stat(gmo);", "only NotFound is caught (no run folder yet); any other error is thrown (C4g)"],
  ["research/lawsearch-gen.ts", "if (!(e instanceof Deno.errors.NotFound)) throw e;", "the line that rethrows"],
  ["research/lawsearch-hand.ts", "await Deno.remove(dir, { recursive: true }).catch(() => {});", "a refused remove is followed by a refused mkdir or write: exit 1"],
  ["research/lawsearch.ts", "await Deno.remove(dir, { recursive: true }).catch(() => {});", "the dump folder: a refused remove is followed by a refused mkdir: exit 1"],
  ["research/lawsearch.ts", "await Deno.remove(out, { recursive: true }).catch(() => {});", "exit 7's removal of the dump folder: a refused remove leaves it; the exit code says why"],
  ["research/lawsearch.ts", 'await Deno.writeTextFile(`${dir}/choice.json`, choice + "\\n");', "in stage 1's try, whose catch rethrows every error but a STOP: exit 1"],
  ["research/lawsearch.ts", "m = JSON.parse(await Deno.readTextFile(`${run}/manifest.json`));", "an error is a refusal: exit 2"],
  ["research/lawsearch-flip.ts", "Deno.exit(1);", "the flip judgement's main: its own exit codes"],
  ["research/lawsearch-flip.ts", "Deno.exit(3);", "the flip judgement's main: its own exit codes"],
  ["research/lawsearch-flip.ts", "Deno.exit(passed ? 0 : 3);", "the flip judgement's main: its own exit codes"],
  ["research/lawsearch-flip.ts", "const cfg = JSON.parse(await Deno.readTextFile(`${tsDir}/config.json`));", "an error fails the judgement (CONFIG … FAIL)"],
  ["research/lawsearch-flip.ts", "text = await Deno.readTextFile(path);", "readCsv: a refused read reads as a missing CSV, which the judgement fails (FAIL) or, for an INFO line, reports as not in both runs"],
  ["research/ownerhold-data.ts", "body = JSON.parse(await Deno.readTextFile(path));", "readSide: not called by the program (ownerhold's own loader)"],
  ["research/trend-labels.ts", "body = JSON.parse(await Deno.readTextFile(path));", "a cache fetcher: not called by the program (other studies)"],
];

const [what, dir] = Deno.args;
if (what === "relay") {
  // C4h (F7): the lockdown, evaluated here as the first module of an entry would be (this file is not in any graph)
  await import("./lawsearch-lockdown.ts");
  const tries: Array<[string, () => void]> = [
    ["wrap Worker.prototype.postMessage", () => {
      (Worker.prototype as unknown as { postMessage: unknown }).postMessage = () => {};
    }],
    ["redefine Worker.prototype's onmessage setter", () => {
      Object.defineProperty(Worker.prototype, "onmessage", { set() {} });
    }],
    ["replace globalThis.Worker", () => {
      (globalThis as unknown as { Worker: unknown }).Worker = class {};
    }],
    ["wrap EventTarget.prototype.addEventListener", () => {
      (EventTarget.prototype as unknown as { addEventListener: unknown }).addEventListener = () => {};
    }],
  ];
  let open = 0;
  for (const [name, f] of tries) {
    try {
      f();
      open++;
      console.log(`${name}: NOT refused`);
    } catch (e) {
      console.log(`${name}: refused (${e instanceof TypeError ? "TypeError" : "other error"}: ${(e as Error).message})`);
      if (!(e instanceof TypeError)) open++;
    }
  }
  console.log(`the main realm's freeze: ${open === 0 ? "every hook refused" : `BAD: ${open} not refused with a TypeError`}`);
  Deno.exit(open === 0 ? 0 : 1);
}
if (!["graph", "source", "catch", "trigger"].includes(what) || !dir) {
  console.log("usage: lawsearch-audit.ts <graph|source|catch|trigger> <dir of graph-<entry>.json> | relay");
  Deno.exit(2);
}
const root = `file://${Deno.cwd()}/`;
const relOf = (s: string): string | null => (s.startsWith(root) ? s.slice(root.length) : null);
// where deno info found a module request in its module's source (0-based line and character)
interface Span {
  start: { line: number; character: number };
}
interface Dep {
  specifier: string;
  isDynamic?: boolean;
  code?: { specifier?: string; span?: Span };
  type?: { specifier?: string };
}
interface Mod {
  specifier: string;
  kind?: string;
  mediaType?: string;
  error?: string;
  dependencies?: Dep[];
}
const graphOf = (e: string): Mod[] => (JSON.parse(Deno.readTextFileSync(`${dir}/graph-${e}.json`)) as { modules: Mod[] }).modules;
// C4h (F4): an entry's value module requests in source order, as deno info parsed them: the entry module's dependencies
// that have a code specifier (a type-only import has none), by the position of that request in the source
const firstRequestsOf = (e: string): string[] => {
  const g = JSON.parse(Deno.readTextFileSync(`${dir}/graph-${e}.json`)) as { roots: string[]; modules: Mod[] };
  const root = g.modules.find((m) => m.specifier === g.roots[0]);
  if (root === undefined) return [];
  const deps = (root.dependencies ?? []).filter((d) => d.code?.specifier !== undefined && d.code.span !== undefined);
  deps.sort((a, b) => a.code!.span!.start.line - b.code!.span!.start.line || a.code!.span!.start.character - b.code!.span!.start.character);
  return deps.map((d) => d.specifier);
};
// C4h (F4): the same from the source text: every import … from "…", import "…", export … from "…" and export * from "…"
// that starts a line, but import type and export type (the refuter's form, c4g/refute-ci-docs-2/keep/audit-fixed.ts)
const SOURCE_REQUEST = /^(?:import|export)\b(?!\s+type\b)[^;]*?\bfrom\s+"([^"]+)"|^import\s+"([^"]+)"/gm;
let bad = 0;
const fail = (line: string) => {
  bad = 1;
  console.log(line);
};
// the repository's files of the graphs (a module that is not one is reported: the graph audit refuses it too)
const filesOf = (): string[] => {
  const s = new Set<string>();
  for (const e of ENTRIES) {
    for (const m of graphOf(e)) {
      const r = relOf(m.specifier);
      if (r === null) fail(`${e}: ${m.specifier}: not a file of the repository`);
      else s.add(r);
    }
  }
  return [...s].sort();
};

if (what === "graph") {
  for (const e of ENTRIES) {
    const mods = graphOf(e);
    const specs = new Set(mods.map((m) => m.specifier));
    for (const m of mods) {
      const r = relOf(m.specifier);
      const why: string[] = [];
      if (r === null) why.push("not a file of the repository");
      else if (!r.endsWith(".ts")) why.push("not a .ts file");
      else if (r.startsWith("research/out/") || r.startsWith("research/ledger/")) why.push("under research/out or research/ledger");
      if (m.kind !== "esm" || m.mediaType !== "TypeScript") why.push(`kind ${m.kind}, ${m.mediaType}`);
      if (m.error !== undefined) why.push(`error ${m.error}`);
      for (const d of m.dependencies ?? []) {
        if (d.isDynamic) why.push(`a dynamic import of ${d.specifier}`);
        for (const c of [d.code?.specifier, d.type?.specifier]) if (c !== undefined && !specs.has(c)) why.push(`imports ${c}, not a module of the graph`);
      }
      if (why.length > 0) fail(`${e}: ${r ?? m.specifier}: ${why.join("; ")}`);
    }
    const src = Deno.readTextFileSync(`research/${e}`);
    const first = [...src.matchAll(SOURCE_REQUEST)].map((x) => x[1] ?? x[2]).slice(0, 2);
    const firstG = firstRequestsOf(e).slice(0, 2);
    if (first[0] !== "./lawsearch-lockdown.ts" || first[1] !== "./lawsearch-frozen.ts") fail(`${e}: its first two module requests (source text) are ${first.join(", ")}, not ./lawsearch-lockdown.ts and ./lawsearch-frozen.ts`);
    if (firstG[0] !== "./lawsearch-lockdown.ts" || firstG[1] !== "./lawsearch-frozen.ts") fail(`${e}: its first two module requests (deno info) are ${firstG.join(", ")}, not ./lawsearch-lockdown.ts and ./lawsearch-frozen.ts`);
    console.log(`${e}: ${mods.length} modules; first module requests ${first.join(", ")} (deno info: ${firstG.join(", ")})`);
  }
  const lock = graphOf("lawsearch-lockdown.ts").map((m) => relOf(m.specifier));
  if (lock.length !== 1 || lock[0] !== "research/lawsearch-lockdown.ts") fail(`lawsearch-lockdown.ts imports something: ${lock.join(", ")}`);
  const fro = graphOf("lawsearch-frozen.ts").map((m) => relOf(m.specifier) ?? m.specifier).filter((r) => r.startsWith("research/lawsearch-")).sort();
  const want = ["research/lawsearch-const.ts", "research/lawsearch-frozen.ts", "research/lawsearch-rules.ts", "research/lawsearch-types.ts"];
  if (fro.join() !== want.join()) fail(`lawsearch-frozen.ts's graph holds other lawsearch modules: ${fro.join(", ")}`);
  for (const e of ENTRIES) {
    for (const m of graphOf(e)) {
      for (const d of m.dependencies ?? []) {
        const c = relOf(d.code?.specifier ?? "");
        if ((c === "research/trend-stats.ts" || c === "research/bigflow-lib.ts") && relOf(m.specifier) !== "research/lawsearch-checks.ts") fail(`${e}: ${relOf(m.specifier)} imports ${c} (only lawsearch-checks.ts may)`);
      }
    }
  }
  console.log(`the module graphs: ${bad ? "BAD (the lines above)" : "every condition holds"}`);
} else if (what === "trigger") {
  // C4h (F5): a workflow's on.push.paths (the plain list form these two files use: `on:`, then `push:`, then `paths:`
  // with one `- <pattern>` per line); GitHub's filter patterns: * any characters but /, ** any characters; a pattern with
  // any other special character ([, ], ?, +, !) is refused here, so the matching below is GitHub's
  const pathsOf = (file: string): string[] => {
    const lines = Deno.readTextFileSync(file).split("\n");
    const out: string[] = [];
    let inOn = false;
    let inPush = -1;
    let inPaths = -1;
    for (const line of lines) {
      if (/^\s*(#.*)?$/.test(line)) continue;
      const ind = line.length - line.trimStart().length;
      if (ind === 0) {
        inOn = line.trim() === "on:";
        inPush = -1;
        inPaths = -1;
        continue;
      }
      if (!inOn) continue;
      if (inPaths >= 0 && ind > inPaths) {
        const m = /^\s*-\s+(.+?)\s*$/.exec(line);
        if (m === null) fail(`${file}: a line of push.paths that is not a list item: ${line.trim()}`);
        else out.push(m[1].replace(/^(["'])(.*)\1$/, "$2"));
        continue;
      }
      inPaths = -1;
      if (line.trim() === "push:") inPush = ind;
      else if (inPush >= 0 && ind > inPush && line.trim() === "paths:") inPaths = ind;
      else if (ind <= inPush) inPush = -1;
    }
    if (out.length === 0) fail(`${file}: no on.push.paths found`);
    return out;
  };
  const reOf = (pat: string): RegExp => {
    if (/[[\]?+!]/.test(pat)) {
      fail(`a push path with a special character this audit does not match as GitHub does: ${pat}`);
      return /(?!)/;
    }
    const body = pat.split("**").map((part) => part.split("*").map((x) => x.replace(/[.^$|(){}\\/]/g, "\\$&")).join("[^/]*")).join(".*");
    return new RegExp(`^${body}$`);
  };
  const own = pathsOf(".github/workflows/lawsearch.yml");
  const audit = pathsOf(".github/workflows/lawsearch-audit.yml");
  const pats = [...own.map((p) => ({ p, from: "lawsearch.yml", re: reOf(p), used: false })), ...audit.map((p) => ({ p, from: "lawsearch-audit.yml", re: reOf(p), used: false }))];
  const files = filesOf();
  let shared = 0;
  for (const f of files) {
    const hit = pats.filter((x) => x.re.test(f));
    for (const x of hit) x.used = true;
    if (hit.length === 0) fail(`not in the push paths of lawsearch.yml or lawsearch-audit.yml: ${f}`);
    else if (!hit.some((x) => x.from === "lawsearch.yml")) shared++;
  }
  for (const x of pats) if (x.from === "lawsearch-audit.yml" && !x.used && !x.p.startsWith(".github/")) console.log(`not found (lawsearch-audit.yml path that matches no module of the graphs): ${x.p}`);
  console.log(`${files.length} modules of the graphs, ${shared} of them matched only by lawsearch-audit.yml's paths: ${bad ? "BAD (the lines above)" : "every one is in a push path"}`);
} else if (what === "source") {
  const pat = /node:|\bimport\s*\(|\beval\b|\bFunction\s*\(|\bnew\s+Function\b|\bDeno\s*\[|\bDeno\.internal\b|\bSharedArrayBuffer\b|\bAtomics\b|\bnew\s+Worker\b/;
  const allow = new Map(SOURCE_ALLOW.map(([f, l]) => [`${f}\t${l}`, false]));
  const files = filesOf();
  for (const f of files) {
    Deno.readTextFileSync(f).split("\n").forEach((line, i) => {
      const s = line.trim();
      if (s.startsWith("//") || !pat.test(s)) return;
      const k = `${f}\t${s}`;
      if (allow.has(k)) allow.set(k, true);
      else fail(`${f}:${i + 1}: ${s}`);
    });
  }
  for (const [k, used] of allow) if (!used) console.log(`not found (allow-list line unused): ${k.replace("\t", ": ")}`);
  console.log(`${files.length} modules scanned: ${bad ? "BAD: the lines above break the source rule" : "no code line breaks the source rule"}`);
} else {
  // the Deno calls inside a try block (braces matched outside strings and // comments) or on a line with .catch(
  const found = new Set<string>();
  const files = filesOf();
  for (const f of files) {
    const lines = Deno.readTextFileSync(f).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (/\bDeno\./.test(s) && s.includes(".catch(") && !s.startsWith("//")) found.add(`${f}\t${s}`);
      if (!(/^(\}\s*)?try\s*\{/.test(s) || s.endsWith(" try {"))) continue;
      let depth = 0;
      let started = false;
      for (let j = i; j < lines.length; j++) {
        const t = lines[j].replace(/"(\\.|[^"\\])*"|'(\\.|[^'\\])*'|`[^`]*`|\/\/.*$/g, "");
        for (const ch of t) {
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") depth--;
        }
        if (j > i && /\bDeno\./.test(lines[j]) && !lines[j].trim().startsWith("//")) found.add(`${f}\t${lines[j].trim()}`);
        if (started && depth <= 0) break;
      }
    }
  }
  const allow = new Set(CATCH_ALLOW.map(([f, l]) => `${f}\t${l}`));
  for (const k of [...found].sort()) if (!allow.has(k)) fail(`not audited: ${k.replace("\t", ": ")}`);
  for (const k of allow) if (!found.has(k)) console.log(`not found (allow-list line unused): ${k.replace("\t", ": ")}`);
  console.log(`${files.length} modules scanned, ${found.size} Deno calls inside a try block or with .catch: ${bad ? "BAD (the lines above)" : "every one audited"}`);
}
Deno.exit(bad);
