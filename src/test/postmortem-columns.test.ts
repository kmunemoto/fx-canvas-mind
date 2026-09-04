import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The same read-path check as history-columns.test.ts, for the other half of
// the loop.
//
// PostgREST returns only the columns named in the select, and every field the
// mapping below reads is optional on the way in, so a column left out of the
// select does not throw — it arrives as undefined and the code downstream
// quietly takes its default. That is how `plan_contract` reached production
// inert on the client. The server had the same hole: the consolidation pooled
// two entry contracts into one win rate because the column it would have
// needed was never asked for, and the WAIT verdicts were written every fifteen
// minutes and read by nobody.
//
// So the sources are read, not a fixture: the row shape, the query, and the
// mapping between them have to agree.
const prompt = readFileSync("supabase/functions/postmortem/prompt.ts", "utf8");
const index = readFileSync("supabase/functions/postmortem/index.ts", "utf8");

const interfaceFields = (src: string, name: string): string[] => {
  const start = src.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
};

// The body of an object literal, from its opening brace to the matching close
const literalAfter = (src: string, marker: string): string => {
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i);
  }
  throw new Error(`unbalanced literal after ${marker}`);
};

const recordSelect = (() => {
  const m = index.match(/analyses\?select=([^&]+)&order=created_at\.desc/);
  expect(m).not.toBeNull();
  return new Set((m as RegExpMatchArray)[1].split(","));
})();

const diagnosisSelect = (() => {
  const at = index.indexOf("const select = [");
  expect(at).toBeGreaterThan(-1);
  const body = index.slice(at, index.indexOf("].join", at));
  return new Set([...body.matchAll(/"(\w+)"/g)].map((m) => m[1]));
})();

// A select entry is either a bare column or `alias:column->>path`
const columnOf = (entry: string) => (entry.includes(":") ? entry.slice(0, entry.indexOf(":")) : entry);

describe("the post-mortem asks for every column it then reads", () => {
  const mapping = literalAfter(index, "const record: RecordRow[] = recordRows.map(");

  it("maps every field RecordRow declares", () => {
    const declared = interfaceFields(prompt, "RecordRow");
    expect(declared.length).toBeGreaterThan(10);
    const unmapped = declared.filter((f) => !new RegExp(`^\\s+${f}:`, "m").test(mapping));
    expect(unmapped).toEqual([]);
  });

  it("selects every column the mapping reads", () => {
    const read = [...mapping.matchAll(/\br\.(\w+)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(10);
    const aliases = new Set([...recordSelect].map(columnOf));
    const missing = [...new Set(read)].filter((f) => !aliases.has(f));
    expect(missing).toEqual([]);
  });

  it("selects the two columns the loop was reading blind without", () => {
    // Named on their own because both fail silently. Without plan_contract
    // the record pools two entry eras into one win rate; without the WAIT
    // verdict the only call that can never be wrong is also the only call
    // nobody counts, and the loop can push in one direction forever.
    expect(recordSelect.has("plan_contract")).toBe(true);
    expect([...recordSelect].some((c) => c.startsWith("wait_verdict:wait_check"))).toBe(true);
    expect(prompt).toContain("rowContract(r) !== s.contract");
    expect(prompt).toContain("s.waits_missed");
  });

  it("selects every column the diagnosed plan reads", () => {
    const plan = literalAfter(index, "const plan: PlanSummary = ");
    const read = [...new Set([...plan.matchAll(/\braw\.(\w+)/g)].map((m) => m[1]))];
    expect(read.length).toBeGreaterThan(2);
    const missing = read.filter((f) => !diagnosisSelect.has(f));
    expect(missing).toEqual([]);
  });
});
