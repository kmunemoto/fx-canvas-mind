import { describe, expect, it } from "vitest";
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
