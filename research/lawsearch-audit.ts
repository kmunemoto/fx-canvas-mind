// 法則探し (docs §8.136; C4g, the lead's G3): the static audits of the program's realms, run by the yml's hand job
// (.github/workflows/lawsearch.yml). It is not part of the program (no module of the program imports it) and reads only
// the module graphs `deno info --json` wrote for the entry points (<dir>/graph-<entry>.json) and the graphs' source
// files. Usage: deno run --no-config --allow-read=.,<dir> research/lawsearch-audit.ts <graph|source|catch> <dir>
// Exit 0 when the audit holds, 1 when it does not (each offending module or line printed), 2 on a wrong call.
//
//   graph   every module of the graphs of the realms' entry points (lawsearch.ts, lawsearch-par-worker.ts,
//           lawsearch-follow-worker.ts, lawsearch-flip.ts) is a TypeScript file of the repository, not under research/out
//           or research/ledger, with no dynamic import and every dependency a module of the graph (a worker's graph is
//           loaded under the read permission of the realm that starts it, Deno 2.9.6: a literal import of a data file
//           would be read even by a worker with no permission); each entry's first two imports are
//           lawsearch-lockdown.ts and lawsearch-frozen.ts; lawsearch-lockdown.ts imports nothing; lawsearch-frozen.ts's
//           graph holds no lawsearch module but lawsearch-const.ts, lawsearch-rules.ts and lawsearch-types.ts; and
//           trend-stats.ts and bigflow-lib.ts (the main thread's check-only code) are imported by lawsearch-checks.ts alone
//   source  the source rule: no code line of those graphs holds node:, import(, eval, Function( / new Function, Deno[ /
//           Deno.internal, SharedArrayBuffer / Atomics or new Worker, but the lines of SOURCE_ALLOW
//   catch   every Deno call inside a try block, or on a line with .catch(, in those graphs is one of CATCH_ALLOW

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
if (!["graph", "source", "catch"].includes(what) || !dir) {
  console.log("usage: lawsearch-audit.ts <graph|source|catch> <dir of graph-<entry>.json>");
  Deno.exit(2);
}
const root = `file://${Deno.cwd()}/`;
const relOf = (s: string): string | null => (s.startsWith(root) ? s.slice(root.length) : null);
interface Dep {
  specifier: string;
  isDynamic?: boolean;
  code?: { specifier?: string };
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
    const first = [...src.matchAll(/^import\b[^;]*?from\s+"([^"]+)"|^import\s+"([^"]+)"/gm)].map((x) => x[1] ?? x[2]).slice(0, 2);
    if (first[0] !== "./lawsearch-lockdown.ts" || first[1] !== "./lawsearch-frozen.ts") fail(`${e}: its first two imports are ${first.join(", ")}, not ./lawsearch-lockdown.ts and ./lawsearch-frozen.ts`);
    console.log(`${e}: ${mods.length} modules; first imports ${first.join(", ")}`);
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
