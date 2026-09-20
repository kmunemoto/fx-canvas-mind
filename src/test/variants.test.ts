import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_VARIANT,
  resolveVariant,
  usesConditionalWait,
  usesLowerTimeframe,
  VARIANTS,
} from "../../supabase/functions/_shared/variants.ts";
import { RESPONSE_SCHEMA } from "../../supabase/functions/noise-floor/shape.ts";
import { SCHEMA_ERAS } from "../../supabase/functions/noise-floor/prompt-surgery.ts";
import { stringsFor } from "../../supabase/functions/analyze/locale.ts";

describe("resolveVariant", () => {
  it("returns every arm it knows by name", () => {
    for (const v of VARIANTS) expect(resolveVariant(v)).toBe(v);
  });

  it("falls back to control rather than failing the request", () => {
    for (const bad of [undefined, null, "", "both", "LOWER_TF", 3, {}, ["lower_tf"]]) {
      expect(resolveVariant(bad)).toBe(DEFAULT_VARIANT);
    }
    expect(DEFAULT_VARIANT).toBe("control");
  });

  it("each arm is exactly one arm — control changes nothing", () => {
    expect(usesLowerTimeframe("lower_tf")).toBe(true);
    expect(usesConditionalWait("lower_tf")).toBe(false);
    expect(usesConditionalWait("conditional_wait")).toBe(true);
    expect(usesLowerTimeframe("conditional_wait")).toBe(false);
    expect(usesLowerTimeframe("control")).toBe(false);
    expect(usesConditionalWait("control")).toBe(false);
  });
});

describe("the arm has to change what is SENT", () => {
  // If the two arms sent the same schema, the candidate arm would be a
  // relabelling of the control arm and the comparison would measure nothing.
  it("conditional_wait is asked for, and is optional", () => {
    expect(RESPONSE_SCHEMA.properties).toHaveProperty("conditional_wait");
    expect(RESPONSE_SCHEMA.required).not.toContain("conditional_wait");
    // The replay harnesses use `required` as their missing-key check against a
    // corpus that was never asked this question.
    expect(RESPONSE_SCHEMA.required.length).toBe(20);
  });

  const sha = async (text: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const era = (name: string) => {
    const e = SCHEMA_ERAS.find((x) => x.era === name);
    expect(e, name).toBeDefined();
    return e!;
  };

  // Until #96 the control arm landed in the era the 45 stored rows are keyed
  // on (v48): `conditional_wait` was the last property and stripping it
  // restored the v48 bytes exactly. #96 added `counter_case` to what EVERY
  // arm sends — that is its whole point — so the control arm now opens an
  // era of its own (v62) and the candidate arm another (v62cond). Both are
  // catalogued; what must never move silently is the v48 reproduction below,
  // which is what the replay harnesses send the corpus.
  it("stripping conditional_wait is the control arm's era, and it is catalogued", async () => {
    const { conditional_wait: _drop, ...free } = RESPONSE_SCHEMA.properties as Record<string, unknown>;
    const control = { ...RESPONSE_SCHEMA, properties: free };
    const suffix = stringsFor("ja").schemaInstruction(JSON.stringify(control));
    const v62 = era("v62");
    expect(suffix.length).toBe(v62.suffixLength);
    expect(await sha(suffix)).toBe(v62.suffixSha256);
    expect(v62.suffixSha256).not.toBe(era("v48").suffixSha256);
  });

  it("stripping counter_case as well reproduces the v48 era byte for byte — the corpus's bytes", async () => {
    const { conditional_wait: _a, counter_case: _b, ...free } = RESPONSE_SCHEMA.properties as Record<string, unknown>;
    const corpus = { ...RESPONSE_SCHEMA, properties: free };
    const suffix = stringsFor("ja").schemaInstruction(JSON.stringify(corpus));
    const v48 = era("v48");
    expect(suffix.length).toBe(v48.suffixLength);
    expect(await sha(suffix)).toBe(v48.suffixSha256);
  });

  // The digests move whenever either block's own text changes — they did
  // once already, when MIN_EXPIRES_BARS made "1以上" false. That is fine and
  // expected, as long as the new era is written down.
  it("the candidate arm opens its own era, and it is catalogued", async () => {
    const suffix = stringsFor("ja").schemaInstruction(JSON.stringify(RESPONSE_SCHEMA));
    const cond = era("v62cond");
    expect(suffix.length).toBe(cond.suffixLength);
    expect(await sha(suffix)).toBe(cond.suffixSha256);
    // Four eras, four labels — never the same twice.
    const digests = ["v44", "v48", "v56cond", "v62", "v62cond"].map((n) => era(n).suffixSha256);
    expect(new Set(digests).size).toBe(digests.length);
  });
});

describe("the arms stay out of the learning loop and out of the record", () => {
  const postmortemSrc = readFileSync("supabase/functions/postmortem/index.ts", "utf8");
  const trackSrc = readFileSync("supabase/functions/track-outcomes/index.ts", "utf8");

  // This is the one direction that cannot be undone by filtering later: a
  // lesson drawn from a candidate row goes into the SHARED rulebook, and
  // analyze shows that rulebook to control runs.
  it("postmortem reads control rows only, on both intakes", () => {
    expect(postmortemSrc).toContain('const controlOnly = "variant=eq.control";');
    // Both row intakes, whole statement — the WAIT one is split across
    // concatenated template literals, so a backtick-bounded match would miss
    // the half the filter is on.
    const starts = [...postmortemSrc.matchAll(/analyses\?outcome=/g)].map((m) => m.index ?? 0);
    expect(starts.length).toBe(2);
    for (const at of starts) {
      expect(postmortemSrc.slice(at, at + 400)).toContain("${controlOnly}");
    }
  });

  // Terminal verdict + a pending index that only selects rows with no outcome
  // means a window measured on the wall clock is never corrected later.
  it("the conditional scorer is given a market-time deadline", () => {
    expect(trackSrc).toContain(
      "const deadlineMs = marketHorizonEnd(signalMs, conditionalWindowMs(plan, entryBarMs));",
    );
    expect(trackSrc).toContain("deadlineMs });");
    expect(trackSrc).not.toContain("entryBarMs, signalMs }");
  });
});

describe("the measurement harnesses declare control-only populations", () => {
  const noiseSrc = readFileSync("supabase/functions/noise-floor/index.ts", "utf8");
  const compareSrc = readFileSync("supabase/functions/version-compare/index.ts", "utf8");

  // analysis_prompts has no `variant` column and analyze writes to it for every
  // saved row, so nothing about the arm is visible in the population query
  // itself. version-compare's own comment warns that a post-read filter is one
  // a refactor can drop while every test still passes — so it is pinned here.
  it("both declare their population through the arm filter", () => {
    for (const src of [noiseSrc, compareSrc]) {
      expect(src).toContain("return await withoutCandidateArms(ids);");
      expect(src).toContain("const withoutCandidateArms = async (ids: string[]): Promise<string[] | null> => {");
      // A failed read must stop the run, never read as "no candidate rows".
      expect(src).toContain('errors.push("read_failed:analyses_variant");');
    }
  });

  // A population frozen before the filter existed can still hold one. Dropping
  // it would change a declared population, so noise-floor refuses instead.
  it("noise-floor refuses a frozen population that already carries a candidate arm", () => {
    expect(noiseSrc).toContain("errors.push(`population_candidate_arm:${id}:${arm}`);");
    expect(noiseSrc).toContain("select=id,mode,preview,variant");
  });
});
