import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { HISTORY_COLUMNS } from "../pages/Index";

// The read path is as much a part of a feature as the write path, and it is
// the half that fails silently.
//
// `plan_contract` shipped written-but-never-read: PostgREST returns only the
// columns named in the select, AnalysisRecord declares the newer fields
// optional, so every row arrived with `plan_contract: undefined` and the guard
// that refuses to pool two entry contracts concluded the population was
// uniform. It reported confident pooled statistics instead — including an
// untriggered rate under a contract where untriggered cannot happen. The unit
// tests passed throughout, because they hand-build records with the field set.
//
// This is the fourth bug of that shape found in two days. Hence a test that
// reads the actual sources rather than a fixture.

// Every source file of the app itself. The test files are excluded on
// purpose: a field only a fixture mentions is still a field nobody reads.
const sourceFiles = (dir = "src"): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "test" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !e.name.includes(".test.") ? [path] : [];
  });

const columns = new Set(HISTORY_COLUMNS.split(","));
const types = readFileSync("src/lib/types.ts", "utf8");
const stats = readFileSync("src/lib/outcomeStats.ts", "utf8");

describe("the history select fetches everything the statistics read", () => {
  it("fetches every field AnalysisRecord declares", () => {
    // Take the interface as the contract: anything the row shape promises, the
    // query must actually ask for.
    const body = types.slice(
      types.indexOf("export interface AnalysisRecord {"),
      types.indexOf("}", types.indexOf("export interface AnalysisRecord {")),
    );
    const declared = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(10);
    const missing = declared.filter((f) => !columns.has(f));
    expect(missing).toEqual([]);
  });

  it("fetches the column the cross-contract guard depends on", () => {
    // Named on its own because its absence is silent: the guard does not
    // throw, it just decides every row is legacy and pools the two eras.
    expect(columns.has("plan_contract")).toBe(true);
    expect(stats).toContain("r.plan_contract ?? LEGACY_CONTRACT");
  });

  it("declares every column it fetches, and reads every column it declares", () => {
    // The converse of the test above, and the shape `wait_check` shipped in:
    // the column was written by the tracker and named in the select, but no
    // field on AnalysisRecord and no reader anywhere — a verdict computed
    // every fifteen minutes and shown to nobody. Selecting a column the row
    // shape does not declare is dead weight at best and a silent default at
    // worst, so both directions are asserted.
    const body = types.slice(
      types.indexOf("export interface AnalysisRecord {"),
      types.indexOf("}", types.indexOf("export interface AnalysisRecord {")),
    );
    const declared = new Set([...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]));
    const undeclared = [...columns].filter((c) => !declared.has(c));
    expect(undeclared).toEqual([]);

    // And someone besides the query and the declaration has to look at it.
    // Both of those files mention every field by construction, so counting
    // them as readers is how this half of the test quietly passes forever.
    const declarers = new Set(["src/pages/Index.tsx", "src/lib/types.ts"]);
    const readers = sourceFiles()
      .filter((f) => !declarers.has(f))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const unread = [...declared].filter((f) => !readers.includes(f));
    expect(unread).toEqual([]);
  });

  it("is the only select used for history", () => {
    const index = readFileSync("src/pages/Index.tsx", "utf8");
    // A second hand-written select would drift from this one
    const selects = [...index.matchAll(/\.from\("analyses"\)[\s\S]{0,200}?\.select\(([^)]*)\)/g)];
    expect(selects.length).toBeGreaterThan(0);
    for (const [, arg] of selects) expect(arg.trim()).toBe("HISTORY_COLUMNS");
  });
});
