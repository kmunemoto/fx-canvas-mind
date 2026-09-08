import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildConsolidationPrompt, type LessonRow } from "../../supabase/functions/postmortem/prompt";
import type { Rule } from "../../supabase/functions/analyze/rules";

// A lesson never said how much aftermath it was drawn from, so every lesson
// read as though it had been drawn from the same amount.
//
// AFTER_WAIT_MS (facts.ts) waits 1h on a 15min plan and 8h on a daily one: a
// diagnosis is written very soon after settlement BY DESIGN, and
// postmortem.facts has always recorded bars_after_settlement. public.lessons
// did not, and the rulebook editor reads lessons.
//
// Measured 2026-09-07, re-diagnosing four stored losses at 48-95 bars:
// 1b003cf3 had been direction_wrong at 8 bars with max_favorable_r 0 — "never
// once in profit" — and became chased_move with max_favorable_r 7, price
// having reached TP1 23 bars later. c8788083 became stop_too_tight at 81
// bars. c14cdb0a kept direction_wrong at 95 bars but flipped avoidable to
// false. Nothing is on record for the fourth, 32d167d3, and it can no longer
// be recovered — the re-read overwrote the earlier document. So the honest
// count is two cause changes and one avoidable flip out of four, not the
// "three of four" this was first written up as, and not four of four either.
// Every one of them stated a confidence in the 70s. The migration below
// records the count as it was first written.
//
// This records the depth. It does not weight anything by it — that judgement
// belongs to whoever reads the record.
const index = readFileSync("supabase/functions/postmortem/index.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260907050000_lesson_evidence_depth.sql", "utf8");

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

const lessonSelect = (() => {
  const m = index.match(/const lessonSelect = "([^"]+)"/);
  expect(m).not.toBeNull();
  return new Set((m as RegExpMatchArray)[1].split(","));
})();

describe("a lesson records how much aftermath it rests on", () => {
  it("adds the columns, explains them, and backfills them from the diagnosis", () => {
    expect(migration).toContain("add column if not exists bars_after_settlement integer");
    expect(migration).toContain("add column if not exists postmortem_version text");
    // a column with no comment is a number nobody can place
    expect(migration).toContain("comment on column public.lessons.bars_after_settlement");
    expect(migration).toContain("comment on column public.lessons.postmortem_version");
    // the past is recoverable: the diagnosis document holds both values
    expect(migration).toContain("(a.postmortem->'facts'->>'bars_after_settlement')::int");
    expect(migration).toContain("a.postmortem->>'version'");
    expect(migration).toContain("where a.id = l.analysis_id");
    // and this build changes only the measurement: not the waits, not the
    // thin threshold, not which rows are diagnosed or cited
    expect(index).not.toMatch(/bars_after_settlement\s*[<>]=?\s*\d+\s*\?/);
  });

  it("writes both onto the lessons row, from the stored document", () => {
    // writeLesson enumerates its columns, and is the single writer: the
    // repair pass rebuilds a lost lesson through the same function, with no
    // model call, so a rebuilt lesson carries the same depth.
    const payload = literalAfter(index, "const res = await rest(\"lessons?on_conflict=analysis_id\"");
    expect(payload).toContain("bars_after_settlement: numberOrNull(");
    expect(payload).toContain("(isRecord(doc.facts) ? doc.facts : {}).bars_after_settlement");
    expect(payload).toContain("postmortem_version: strOrNull(doc.version)");
  });

  it("asks the database for them again on the way back out", () => {
    // plan_closed_at's whole failure was a correct function never receiving
    // its input: written, never selected, read as null forever.
    expect(lessonSelect.has("bars_after_settlement")).toBe(true);
    expect(lessonSelect.has("postmortem_version")).toBe(true);
  });

  it("selects every column the lesson mapping reads", () => {
    // The general form of that failure, not just this instance of it.
    const mapping = literalAfter(index, "const lessons: LessonRow[] = withClusters(lessonRows.map(");
    const read = [...new Set([...mapping.matchAll(/\bl\.(\w+)/g)].map((m) => m[1]))];
    expect(read.length).toBeGreaterThan(15);
    expect(read).toContain("bars_after_settlement");
    expect(read.filter((f) => !lessonSelect.has(f))).toEqual([]);
  });

  it("hands the number to the rulebook editor, in the digest it already reads", () => {
    // The editor is the reader this exists for: it decides which rules the
    // analyst is shown, and it could not tell an eight-bar lesson from a
    // ninety-five-bar one.
    const lesson = (over: Partial<LessonRow>): LessonRow => ({
      analysis_id: "1b003cf3", user_id: null, contract: "market_v1", pair: "USD/JPY", signal: "SELL",
      cause: "direction_wrong", outcome: "loss", interval: "1h", mode: null, order_type: null,
      lesson_ja: "教訓", lesson_en: "lesson", confidence: 72, avoidable: true, shadow: false,
      scope: null, created_at: "2026-09-07T00:00:00Z", plan_created_at: "2026-09-06T00:00:00Z",
      plan_closed_at: "2026-09-06T04:00:00Z", rule_blamed: null, rule_credited: null, ...over,
    });
    const rules: Rule[] = [];
    const stats = { contract: "market_v1" } as unknown as Parameters<typeof buildConsolidationPrompt>[2];
    const shallow = buildConsolidationPrompt(rules, [lesson({ bars_after_settlement: 8 })], stats);
    expect(shallow.user).toContain('"bars_after_settlement":8');
    const deep = buildConsolidationPrompt(rules, [lesson({ bars_after_settlement: 95 })], stats);
    expect(deep.user).toContain('"bars_after_settlement":95');
    // the two are distinguishable at all, which is the whole point
    expect(shallow.user).not.toBe(deep.user);
    // a legacy lesson says "unknown" rather than pretending to a depth
    const legacy = buildConsolidationPrompt(rules, [lesson({})], stats);
    expect(legacy.user).toContain('"bars_after_settlement":null');
    // and the digest keeps its shape: one number per lesson line, no prose
    expect(shallow.user.length - legacy.user.length).toBeLessThan(4);
    // the editor is told what the number means, and that confidence does not
    // already account for it
    expect(shallow.system).toContain("bars_after_settlement");
  });
});
