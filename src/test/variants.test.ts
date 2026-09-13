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

  // The control arm must keep landing in the era 45 stored rows are keyed on
  // (noise-floor/prompt-surgery.ts SCHEMA_ERAS). `conditional_wait` is the
  // last property, so stripping it restores that key order exactly — measured,
  // not assumed, and pinned here because the next property appended anywhere
  // but the end would silently break it.
  it("stripping conditional_wait reproduces the v48 era byte for byte", async () => {
    const { conditional_wait: _drop, ...free } = RESPONSE_SCHEMA.properties as Record<string, unknown>;
    const control = { ...RESPONSE_SCHEMA, properties: free };
    const suffix = stringsFor("ja").schemaInstruction(JSON.stringify(control));

    const v48 = SCHEMA_ERAS.find((e) => e.era === "v48");
    expect(v48).toBeDefined();
    expect(suffix.length).toBe(v48!.suffixLength);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(suffix));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(v48!.suffixSha256);
  });

  // The digests move whenever the conditional_wait block's own text changes —
  // they did once already, when MIN_EXPIRES_BARS made "1以上" false. That is
  // fine and expected; what must never move silently is the CONTROL digest
  // above, which is what keeps the stored corpus replayable.
  it("the candidate arm opens its own era, and it is catalogued", async () => {
    const suffix = stringsFor("ja").schemaInstruction(JSON.stringify(RESPONSE_SCHEMA));
    const cond = SCHEMA_ERAS.find((e) => e.era === "v56cond");
    expect(cond).toBeDefined();
    expect(suffix.length).toBe(cond!.suffixLength);

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(suffix));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(cond!.suffixSha256);
    // Two arms, two eras — never the same label.
    expect(cond!.suffixSha256).not.toBe(SCHEMA_ERAS.find((e) => e.era === "v48")!.suffixSha256);
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
