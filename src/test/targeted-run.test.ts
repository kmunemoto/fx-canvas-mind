import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_PLANS_ADMIN,
  MAX_PLANS_PER_RUN,
  isTargeted,
  parseIds,
  runLimit,
  unaccountedIds,
} from "../../supabase/functions/postmortem/targeted";

// A targeted run — one that names the rows to re-diagnose — is an operator
// action, not a tick of the schedule, and the sweep it shares an endpoint with
// treated it as one. Measured 2026-09-07:
//   * request 1033 at 12:39:45Z named four rows and came back
//     {"ok":true,"mode":"sweep","diagnosed":0,"skipped":"cooldown"}, 1m45s
//     after the 12:38 cron sweep had claimed the ten-minute slot. The ids
//     filter it was aimed at is fifty lines further down and was never
//     reached.
//   * the mirror, at 12:48: a targeted run that DID win the claim took the
//     slot from the schedule, and the 12:53 sweep was a no-op.
//   * request 1035 passed four ids and got {"candidates":4,"due":4,
//     "diagnosed":3,"errors":[]} — the fourth row silently dropped by the
//     cron's per-run limit, and materially different once re-run alone.
const index = readFileSync("supabase/functions/postmortem/index.ts", "utf8");

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

const emptySets = {
  due: new Set<string>(),
  queued: new Set<string>(),
  fetched: new Set<string>(),
  present: new Set<string>(),
  unavailable: false,
};

// The body of a `{ ... }` block starting at the first brace after `marker`
const blockAfter = (src: string, marker: string): string => {
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i);
  }
  throw new Error(`unbalanced block after ${marker}`);
};

// The predicate the cooldown branches on, exercised as a predicate rather than
// read as text: whatever arrives in `ids`, either this run is the schedule and
// is paced like it, or it names at least one row and is not.
describe("what counts as naming a row", () => {
  it("treats a real id as targeted and everything that names no row as a sweep", () => {
    expect(isTargeted(parseIds([uuid(1)]))).toBe(true);
    // Nothing here names a row, so every one of them is an ordinary sweep and
    // keeps the cron's cooldown. `[""]` is the one that mattered: before the
    // trim, one blank string bought a caller the whole run body with no
    // cooldown and no row to run it on.
    for (const body of [undefined, null, [], "abc", [1, 2], [null], [""], ["   "], {}]) {
      expect(isTargeted(parseIds(body))).toBe(false);
    }
  });

  it("is the same expression the cooldown branch actually uses", () => {
    // The only structural claim in this file: that the branch reads the
    // predicate above rather than re-deriving one from the raw body.
    expect(index).toContain("const targeted = isTargeted(parsedIds);");
    expect(index).toContain("const parsedIds = parseIds(body.ids);");
  });

  it("puts the claim and the cooldown answer behind `if (!targeted)`", () => {
    const guarded = blockAfter(index, "if (!targeted) {");
    expect(guarded).toContain("postmortem_state?id=eq.1&or=(last_run_at.is.null,last_run_at.lt.");
    expect(guarded).toContain('skipped: "cooldown"');
    // ...and nothing else claims the slot behind its back
    const claims = [...index.matchAll(/postmortem_state\?id=eq\.1&or=\(last_run_at/g)];
    expect(claims.length).toBe(1);
  });

  it("knows whether the run is targeted before it reaches the auth block", () => {
    // The body is parsed at the top of the handler, so `ids` is in hand long
    // before the token check; the options block only had to move above it.
    const bodyAt = index.indexOf("const body: JsonRecord = isRecord(bodyRaw)");
    const targetedAt = index.indexOf("const targeted = isTargeted(parsedIds);");
    const whoAt = index.indexOf("---- who is asking");
    expect(bodyAt).toBeGreaterThan(-1);
    expect(targetedAt).toBeGreaterThan(bodyAt);
    expect(targetedAt).toBeLessThan(whoAt);
  });

  it("still verifies the sweep token before doing anything with the request", () => {
    // Exempting a targeted run from the cooldown is not exempting it from
    // authentication: the 401 is still ahead of every branch.
    const tokenCheck = index.indexOf("constantTimeEqual(sweepToken, expected)");
    const unauthorized = index.indexOf('return json({ ok: false, error: "認証に失敗しました" }, 401);');
    const exemption = index.indexOf("if (!targeted) {");
    expect(tokenCheck).toBeGreaterThan(-1);
    expect(tokenCheck).toBeLessThan(unauthorized);
    expect(unauthorized).toBeLessThan(exemption);
  });

  it("does not let an operator run overwrite the schedule's own record of itself", () => {
    // loop_health reads postmortem_state.last_run_at and last_result->>
    // diagnosed to say whether the sweep is alive. A hand-run on two named
    // rows is not the sweep's last word on the queue.
    expect(index).toContain('if (scope.kind === "sweep" && !targeted) {');
    expect(index).toContain("      targeted,");
  });
});

describe("a named row is answered for", () => {
  it("lets the ids set the run's limit, so naming four does not run three", () => {
    expect(runLimit(4, null)).toBe(4);
    expect(runLimit(0, null)).toBe(MAX_PLANS_PER_RUN);
    // never past what one worker's wall clock can hold
    expect(runLimit(20, null)).toBe(MAX_PLANS_ADMIN);
    // an explicit limit is still the caller's word, bounded the same way
    expect(runLimit(4, 2)).toBe(2);
    expect(runLimit(4, 0)).toBe(1);
    expect(runLimit(0, 99)).toBe(MAX_PLANS_ADMIN);
  });

  it("reports the ids it truncates instead of dropping them past the bound", () => {
    // Eight ids in, six run, and the seventh and eighth mentioned NOWHERE in
    // the response — request 1035's shape at the outer bound. The truncation
    // used to be a bare .slice() two hundred lines above the accounting, so
    // the accounting could not see it.
    const sent = Array.from({ length: 8 }, (_, i) => uuid(i + 1));
    const parsed = parseIds(sent);
    expect(parsed.ids).toEqual(sent.slice(0, MAX_PLANS_ADMIN));
    expect(parsed.rejected).toEqual([
      `${uuid(7)}: not diagnosed (over MAX_PLANS_ADMIN of 6 ids for one run)`,
      `${uuid(8)}: not diagnosed (over MAX_PLANS_ADMIN of 6 ids for one run)`,
    ]);
    // and the count the caller reconciles against is what they SENT
    expect(parsed.requested).toBe(8);
    expect(parsed.ids.length + parsed.rejected.length).toBe(parsed.requested);
  });

  it("rejects an id Postgres cannot cast, one at a time, instead of failing the query for all of them", () => {
    // analyses.id is uuid and PostgREST casts the whole `id=in.(...)` list, so
    // `select 'not-a-uuid'::uuid` -> 22P02 fails the read for every id beside
    // it; readRows then turns that 400 into an empty page. One typo used to
    // make the entire run a no-op that reported the good rows as nonexistent.
    const good = uuid(1);
    const parsed = parseIds([good, "typo", "1b003cf3-c530-498a-ae63"]);
    expect(parsed.ids).toEqual([good]);
    expect(parsed.rejected).toEqual([
      "typo: not diagnosed (not a plan id)",
      "1b003cf3-c530-498a-ae63: not diagnosed (not a plan id)",
    ]);
  });

  it("trims, and names a blank entry rather than printing a line that names nothing", () => {
    const padded = parseIds([`  ${uuid(1)}  `]);
    expect(padded.ids).toEqual([uuid(1)]);
    // `: not diagnosed (...)` would name no id at all, so a blank is quoted
    expect(parseIds([""]).rejected).toEqual(['"": not diagnosed (not a plan id)']);
    expect(parseIds(["  "]).rejected).toEqual(['"": not diagnosed (not a plan id)']);
  });

  it("names every id it will not diagnose, and why", () => {
    const lines = unaccountedIds(
      ["A", "B", "C", "D", "E"],
      {
        due: new Set(["A"]),
        queued: new Set(["A", "B"]),
        fetched: new Set(["A", "B", "C"]),
        present: new Set(["A", "B", "C", "D"]),
        unavailable: false,
      },
      1,
    );
    // A ran. B was diagnosable and the limit stopped it. C came back and the
    // queue refused it. D is in the table and neither candidate query would
    // ever return it. E matched nothing at all. Five different things to have
    // to fix, all of them silence before and then all of them "no such id".
    expect(lines).toEqual([
      "B: not diagnosed (over this run's limit of 1)",
      "C: not diagnosed (row found, but nothing on it can be graded)",
      "D: not diagnosed (row exists, but it is not a settled trade nor a gradeable WAIT)",
      "E: not diagnosed (no plan with this id)",
    ]);
    // every line opens with the id, like the loop's own deferral line
    for (const line of lines) expect(line).toMatch(/^[A-Za-z0-9-]+: /);
    expect(index).toContain("errors.push(`${row.id}: deferred (time budget)`);");
  });

  it("does not claim a row is missing when the lookup is what went missing", () => {
    // A failed candidate query used to come back as an empty page, and an
    // empty page reported per id says "no plan with this id" about a row the
    // operator is looking straight at. On 2026-09-07 the table held ten
    // ungradeable WAITs and one unsettled trade against two gradeable WAITs,
    // so the misleading branch was the likely one.
    expect(unaccountedIds(["A"], { ...emptySets, unavailable: true }, 6)).toEqual([
      "A: not diagnosed (candidate lookup unavailable, state unknown)",
    ]);
    // ...and the same when the existence probe itself could not be read
    expect(unaccountedIds(["A"], { ...emptySets, present: null }, 6)).toEqual([
      "A: not diagnosed (candidate lookup unavailable, state unknown)",
    ]);
  });

  it("says nothing about ids that did run", () => {
    const all = new Set(["A", "B"]);
    expect(unaccountedIds(["A", "B"], { ...emptySets, due: all, queued: all, fetched: all, present: all }, 6))
      .toEqual([]);
  });

  it("wires the accounting into the run, before the first diagnosis is attempted", () => {
    const rejected = index.indexOf("errors.push(...parsedIds.rejected);");
    const call = index.indexOf("errors.push(...unaccountedIds(");
    const loop = index.indexOf("for (const { row, raw, wait } of due) {");
    expect(rejected).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(rejected);
    expect(call).toBeLessThan(loop);
    // the sets are the queue's own stages, not a re-derivation
    const block = index.slice(call, call + 900);
    expect(block).toContain("due.map((d) => d.row.id)");
    expect(block).toContain("rows.map((d) => d.row.id)");
    expect(block).toContain("[...candidates, ...waitCandidates]");
    // ...and the failed-read distinction the reasons depend on
    expect(block).toContain("candidatesOrNull === null || waitCandidatesOrNull === null");
    // the response counts what was sent, so it can be reconciled against it
    expect(index).toContain("requested_ids: parsedIds.requested,");
  });

  it("keeps a failed candidate read distinguishable from an empty one", () => {
    // readRows collapses a 400 to []; the two candidate queries are the ones
    // whose emptiness is reported per id, so they must not use it.
    for (const marker of ["const candidatesOrNull = await readRowsOrNull(", "const waitCandidatesOrNull = await readRowsOrNull("]) {
      expect(index).toContain(marker);
    }
    expect(index).not.toContain("const candidates = await readRows(");
    expect(index).not.toContain("const waitCandidates = await readRows(");
  });
});
