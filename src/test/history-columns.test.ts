import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

  it("is the only select used for history", () => {
    const index = readFileSync("src/pages/Index.tsx", "utf8");
    // A second hand-written select would drift from this one
    const selects = [...index.matchAll(/\.from\("analyses"\)[\s\S]{0,200}?\.select\(([^)]*)\)/g)];
    expect(selects.length).toBeGreaterThan(0);
    for (const [, arg] of selects) expect(arg.trim()).toBe("HISTORY_COLUMNS");
  });
});
