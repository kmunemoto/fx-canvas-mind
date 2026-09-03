import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANALYSIS_LOCALE,
  SUPPORTED_LOCALES,
  resolveAnalysisLocale,
  stringsFor,
  withDisclaimer,
} from "../../supabase/functions/analyze/locale";

describe("resolveAnalysisLocale", () => {
  it("accepts what the client sends", () => {
    expect(resolveAnalysisLocale("ja")).toBe("ja");
    expect(resolveAnalysisLocale("en")).toBe("en");
    expect(resolveAnalysisLocale("en-GB")).toBe("en");
    expect(resolveAnalysisLocale("JA_jp")).toBe("ja");
  });

  it("falls back for anything else, so a bad value never produces a prompt in no language", () => {
    for (const v of [undefined, null, 42, {}, "", "fr", "zh-CN", "ja;drop"]) {
      expect(resolveAnalysisLocale(v)).toBe(DEFAULT_ANALYSIS_LOCALE);
    }
  });
});

describe("withDisclaimer", () => {
  it("appends the locale's disclaimer when the model omitted it", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const out = withDisclaimer(["something else"], locale);
      expect(out).toHaveLength(2);
      expect(out[1]).toBe(stringsFor(locale).disclaimer);
    }
  });

  it("does not add a second copy when the model already wrote one", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const existing = [stringsFor(locale).disclaimer];
      expect(withDisclaimer(existing, locale)).toEqual(existing);
    }
  });

  it("recognises the model's own wording of the same point", () => {
    expect(withDisclaimer(["投資判断は自己責任でお願いします"], "ja")).toHaveLength(1);
    expect(withDisclaimer(["Trades are taken at your own responsibility."], "en")).toHaveLength(1);
  });

  it("never returns an empty warnings list", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(withDisclaimer([], locale).length).toBeGreaterThan(0);
    }
  });
});

describe("prompt strings", () => {
  it("builds a user message carrying the pair, time, mode note and data", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const msg = stringsFor(locale).userMessage({
        pair: "USD/JPY",
        nowUtc: "2026-09-03T05:30:00Z",
        note: "MODE-NOTE",
        sections: "TF-SECTIONS",
        schema: "SCHEMA-BLOCK",
      });
      for (const part of ["USD/JPY", "2026-09-03T05:30:00Z", "MODE-NOTE", "TF-SECTIONS", "SCHEMA-BLOCK"]) {
        expect(msg, `${locale} message missing ${part}`).toContain(part);
      }
    }
  });

  it("keeps the schema block out of the message when it is not wanted", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const msg = stringsFor(locale).userMessage({
        pair: "USD/JPY", nowUtc: "t", note: "n", sections: "s", schema: "",
      });
      expect(msg).not.toContain("undefined");
    }
  });

  it("gives every locale a non-empty rule for each mode", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const L = stringsFor(locale);
      for (const key of ["languageRule", "searchNote", "technicalNote", "fallbackNote", "disclaimer", "fallbackWarning"] as const) {
        expect(L[key].length, `${locale}.${key}`).toBeGreaterThan(0);
      }
      expect(L.schemaInstruction("{}")).toContain("{}");
    }
  });

  it("tells the model which language to answer in, per locale", () => {
    expect(stringsFor("ja").languageRule).toContain("日本語");
    expect(stringsFor("en").languageRule).toContain("English");
  });
});
