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

describe("the calendar's two silences", () => {
  it("distinguishes a clear horizon from a calendar it could not read", () => {
    for (const loc of ["ja", "en"] as const) {
      const L = stringsFor(loc);
      const clear = L.calendarClear(12);
      const broken = L.calendarUnavailable;
      // Both must actually say something: an empty block let the model read
      // "never checked" as "nothing scheduled"
      expect(clear.length).toBeGreaterThan(20);
      expect(broken.length).toBeGreaterThan(20);
      expect(clear).not.toBe(broken);
      expect(clear).toContain("12");
    }
    // The clear message must not be mistakable for an all-clear beyond the
    // published week
    expect(stringsFor("ja").calendarClear(12)).toContain("今週分");
    expect(stringsFor("en").calendarClear(12)).toContain("current week");
    expect(stringsFor("en").calendarClear(12)).not.toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
    expect(stringsFor("en").calendarUnavailable).not.toMatch(/[\u3040-\u30ff\u4e00-\u9faf]/);
  });
});

// The defect this guards: entryRejected had no low_confidence case, so all
// sixteen confidence-floor rows fell to the default and told the reader the
// entry, stop and target contradicted each other — levels nothing had compared
// — inside a head and tail that read "the call was WAIT, changed to WAIT".
// A missing case is invisible in a switch, which is exactly why it shipped.
describe("the confidence floor's two stories", () => {
  const parts = (signal: string, scored: boolean) => ({
    rejection: "low_confidence",
    signal,
    distanceAtr: null,
    stopAtr: null,
    riskReward: null,
    repairRejection: null,
    ...(scored ? { confidence: 45, confidenceFloor: 60 } : {}),
  });

  it("does not dress the model's own WAIT as an override", () => {
    // Nothing was overridden and nothing about the levels was tested, so the
    // sentence may claim neither
    const ja = stringsFor("ja").entryRejected(parts("WAIT", true));
    expect(ja).not.toContain("変更しました");
    expect(ja).not.toContain("却下");
    expect(ja).not.toContain("矛盾");
    expect(ja).toContain("確信度45");
    expect(ja).toContain("60");

    const en = stringsFor("en").entryRejected(parts("WAIT", true));
    expect(en).not.toContain("downgraded to WAIT");
    expect(en).not.toContain("contradict");
    expect(en).toContain("45");
    expect(en).toContain("60");
    expect(en).not.toMatch(/[぀-ヿ一-龯]/);
  });

  it("still calls a real override an override", () => {
    // A BUY the floor turned into a WAIT is the one case the head and tail
    // describe truthfully
    expect(stringsFor("ja").entryRejected(parts("BUY", true))).toContain("変更しました");
    expect(stringsFor("en").entryRejected(parts("SELL", true))).toContain("downgraded to WAIT");
  });

  it("reads correctly when the numbers are not passed", () => {
    // The two fields are optional, so the sentence has to stand without them
    // rather than print a hole where a number belongs
    for (const loc of ["ja", "en"] as const) {
      for (const signal of ["WAIT", "BUY"]) {
        const text = stringsFor(loc).entryRejected(parts(signal, false));
        expect(text).not.toContain("undefined");
        expect(text).not.toContain("null");
        expect(text).not.toContain("NaN");
        expect(text).not.toContain("?");
      }
    }
  });
});
