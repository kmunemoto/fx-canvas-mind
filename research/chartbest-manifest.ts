// #318 (docs §8.113 20 (e), 22; review fix lookahead-05): a made-up folder proves where its day files came from.
// `gen` writes gmo/manifest.json: the set, seed, flip, period and amount it generated, whether it wrote the 1-minute
// files, and one sha256 over every file it wrote. A made-up run, stage or flip-cmp reads a folder only when that
// manifest matches the run's configuration and the files on disk, and never a folder under research/.cache, where the
// real jobs keep GMO's day files (REAL_CACHE_DIR). The functions return the problems; the callers refuse (exit 2).
// Stage-0-safe: no follow, no outcome.

import { sha256Hex } from "./chartbest-data.ts";

export const MANIFEST = "manifest.json";
export interface GenManifest {
  kind: "chartbest-gen";
  set: string;
  seed: number;
  flip: boolean;
  period: string;
  amount: number;
  // the 1-minute files were written (CB_FULL=1 at gen)
  minutes: boolean;
  files: number;
  // sha256 over the lines "<path relative to the folder>\t<sha256 of the file>\n", sorted by path
  sha256: string;
}
export type FileHash = [string, string];

const byPath = (a: FileHash, b: FileHash): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
export const digestOf = (entries: FileHash[]): Promise<string> =>
  sha256Hex(new TextEncoder().encode([...entries].sort(byPath).map(([p, h]) => `${p}\t${h}\n`).join("")));
export const textHash = (text: string): Promise<string> => sha256Hex(new TextEncoder().encode(text));

export const writeManifest = async (dir: string, m: Omit<GenManifest, "kind" | "files" | "sha256">, entries: FileHash[]): Promise<GenManifest> => {
  const out: GenManifest = { kind: "chartbest-gen", ...m, files: entries.length, sha256: await digestOf(entries) };
  await Deno.writeTextFile(`${dir}/${MANIFEST}`, JSON.stringify(out, null, 1) + "\n");
  return out;
};

// every file under dir (the manifest aside), recursively, with its sha256
const filesOf = async (dir: string, rel = ""): Promise<FileHash[]> => {
  const out: FileHash[] = [];
  const here = rel ? `${dir}/${rel}` : dir;
  for await (const e of Deno.readDir(here)) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory) out.push(...(await filesOf(dir, p)));
    else if (p !== MANIFEST) out.push([p, await sha256Hex(await Deno.readFile(`${dir}/${p}`))]);
  }
  return out;
};

// the real jobs' GMO cache (research/.cache, and wherever it points): a made-up run never reads under it
export const underRealCache = async (dir: string): Promise<boolean> => {
  const abs = await Deno.realPath(dir);
  const roots = [`${await Deno.realPath(".")}/research/.cache`];
  const linked = await Deno.realPath("research/.cache").catch(() => null);
  if (linked) roots.push(linked);
  return roots.some((r) => abs === r || abs.startsWith(`${r}/`));
};

export interface MadeUpWant {
  set: string;
  seed: number;
  flip: boolean;
  period: string;
  // the run reads the 1-minute files (a full run)
  minutes: boolean;
  // CB_AMOUNT given to the run (null: not given)
  amount: number | null;
}
export const madeUpDataProblems = async (dir: string, want: MadeUpWant): Promise<{ problems: string[]; files: number; sha256: string }> => {
  const problems: string[] = [];
  let real = false;
  try {
    real = await underRealCache(dir);
  } catch {
    return { problems: [`${dir}: the folder cannot be read`], files: 0, sha256: "" };
  }
  if (real) return { problems: [`${dir} is under research/.cache, the real jobs' GMO day files: a made-up run never reads there`], files: 0, sha256: "" };
  let m: GenManifest;
  try {
    m = JSON.parse(await Deno.readTextFile(`${dir}/${MANIFEST}`)) as GenManifest;
  } catch {
    return { problems: [`${dir}/${MANIFEST}: no manifest from gen (a made-up run reads only a folder gen wrote)`], files: 0, sha256: "" };
  }
  if (m.kind !== "chartbest-gen") problems.push(`${MANIFEST}: not gen's`);
  if (m.set !== want.set) problems.push(`the folder holds set ${m.set}, the run is set ${want.set}`);
  if (m.seed !== want.seed) problems.push(`the folder holds seed ${m.seed}, the run is seed ${want.seed}`);
  if (m.flip !== want.flip) problems.push(`the folder's flip is ${m.flip}, the run's ${want.flip}`);
  if (m.period !== want.period) problems.push(`the folder holds the ${m.period} period, the run the ${want.period}`);
  if (want.minutes && !m.minutes) problems.push("a full run needs the 1-minute files, which gen did not write (CB_FULL=1 at gen)");
  if (want.amount !== null && want.amount !== m.amount) problems.push(`the folder's amount is ${m.amount}, the run's CB_AMOUNT ${want.amount}`);
  const files = await filesOf(dir);
  const sha = await digestOf(files);
  if (files.length !== m.files || sha !== m.sha256) problems.push(`the files on disk (${files.length}) are not the ${m.files} gen wrote (sha256 differs)`);
  return { problems, files: files.length, sha256: sha };
};
