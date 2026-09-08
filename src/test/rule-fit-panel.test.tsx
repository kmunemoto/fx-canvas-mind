import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import RuleFitPanel from "../components/RuleFitPanel";
import { claimedRules } from "../../supabase/functions/analyze/rules";
import type { RuleFit, Rulebook } from "../lib/types";

const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");

const render = (ui: ReactElement, locale: "ja" | "en" = "ja") =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

// The panel is a fold, closed by default; the verdicts are inside it and the
// count is on the header.
const open = () => fireEvent.click(screen.getByRole("button", { name: /適用されたルール|Rules consulted/ }));

const rule = (id: string, ja: string) => ({
  id, text_ja: ja, text_en: `body of ${id}`, cause: "direction_wrong",
  support: 2, scope: null, since: null, kind: "constraint" as const,
  contract: "market_v1", evidence_contracts: ["entry_chosen_v1"], supported_by: [],
});

const rulebook: Rulebook = {
  version: 8,
  updated_at: "2026-09-05T12:00:00Z",
  summary: { ja: "", en: "" },
  rules: [rule("r4", "上位足が弱いなら見送る"), rule("r10", "伸び切りを追わない"), rule("r11", "TP1はATR1倍")],
} as unknown as Rulebook;

// The verdicts the first live preview actually produced.
const live: RuleFit = {
  shown: ["r4", "r10", "r11"],
  held_back: 0,
  rules: {
    r4: { fit: "unknown", comparable: [], missed: [], cases: 1, cited: 2 },
    r10: { fit: "off", comparable: ["rsi", "stretch", "bb_pos", "htf_adx"], missed: ["rsi", "stretch"], cases: 4, cited: 5 },
    r11: { fit: "off", comparable: ["adx", "rsi", "stretch", "bb_pos", "htf_adx"], missed: ["adx", "rsi", "stretch", "htf_adx"], cases: 3, cited: 3 },
  },
};

describe("the rules this analysis was given", () => {
  it("shows each rule with its verdict and its own text", () => {
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    expect(screen.getByTestId("rule-fit")).toBeTruthy();
    expect(screen.queryByText("上位足が弱いなら見送る")).toBeNull();
    open();
    expect(screen.getByText("上位足が弱いなら見送る")).toBeTruthy();
    expect(screen.getByText("伸び切りを追わない")).toBeTruthy();
    expect(screen.getAllByText("別局面")).toHaveLength(2);
    expect(screen.getByText("照合不可")).toBeTruthy();
  });

  it("says which axes put the market outside, not just that it is outside", () => {
    // "Different situation" on its own is a verdict without its evidence.
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    open();
    expect(screen.getByText(/外れた軸: RSI・SMA20乖離$/)).toBeTruthy();
    expect(screen.getByText(/外れた軸: ADX・RSI・SMA20乖離・上位足ADX$/)).toBeTruthy();
  });

  it("says how much of a rule's evidence the comparison could actually read", () => {
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    open();
    // r10 cites five and only four carry the reading of the day
    expect(screen.getByText(/根拠5件のうち4件しか当時の値が残っておらず/)).toBeTruthy();
    // r11 cites three and all three are readable
    expect(screen.getByText(/根拠3件すべての当時の値と比較/)).toBeTruthy();
  });

  it("says the verdict is a measurement, not something the rule claims", () => {
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    open();
    const note = screen.getByTestId("rule-fit-note").textContent ?? "";
    expect(note).toContain("ルール本文の主張ではありません");
    // And that the evidence behind a rule is not only this reader's record
    expect(note).toContain("全アカウント");
  });

  it("counts how many of the shown rules fit, on the header, before it is opened", () => {
    const someMatch: RuleFit = {
      ...live,
      rules: { ...live.rules, r4: { fit: "match", comparable: ["adx", "rsi"], missed: [], cases: 2, cited: 2 } },
    };
    render(<RuleFitPanel ruleFit={someMatch} rulebook={rulebook} />);
    expect(screen.getByText(/3件を提示し、うち1件が今の相場に該当/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /適用されたルール/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("names what the budget cut, on the header too", () => {
    render(<RuleFitPanel ruleFit={{ ...live, held_back: 4 }} rulebook={rulebook} />);
    expect(screen.getByText(/4件を省略/)).toBeTruthy();
  });

  it("renders nothing at all when no rules were shown", () => {
    const { container } = render(<RuleFitPanel ruleFit={{ shown: [], held_back: 0, rules: {} }} rulebook={rulebook} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the comparison was not made", () => {
    const { container } = render(<RuleFitPanel ruleFit={null} rulebook={rulebook} />);
    expect(container.textContent).toBe("");
  });

  it("survives a rule whose text the client could not fetch", () => {
    // The rulebook comes from a separate RPC and can be absent or behind.
    render(<RuleFitPanel ruleFit={live} rulebook={null} />);
    expect(screen.getByTestId("rule-fit")).toBeTruthy();
    open();
    expect(screen.getByText(/r10：本文を取得できませんでした/)).toBeTruthy();
  });

  it("has an English rendering with no Japanese in it", () => {
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />, "en");
    open();
    const panel = screen.getByTestId("rule-fit").textContent ?? "";
    expect(panel).toContain("different situation");
    expect(panel).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });
});

describe("what the analyst says it used, beside what the server measured", () => {
  // The claim is the analyst's word. It is marked, not scored: the panel must
  // never let it be read as the measured verdict sitting next to it.
  const claiming: RuleFit = { ...live, claimed_by_analyst: ["r10"] };

  it("marks the rules the analyst claimed, and only those", () => {
    render(<RuleFitPanel ruleFit={claiming} rulebook={rulebook} />);
    open();
    expect(screen.getByTestId("rule-claimed-r10")).toBeTruthy();
    expect(screen.queryByTestId("rule-claimed-r4")).toBeNull();
    expect(screen.queryByTestId("rule-claimed-r11")).toBeNull();
  });

  it("says in words that the mark is the analyst's word and not a measurement", () => {
    render(<RuleFitPanel ruleFit={claiming} rulebook={rulebook} />);
    open();
    const note = screen.getByTestId("rule-fit-claim-note").textContent ?? "";
    expect(note).toContain("AI自身");
    expect(note).toContain("サーバが測ったものではありません");
  });

  it("keeps the claim visually apart from the measured verdict", () => {
    // Same chip styling for both would make "the analyst used it" read as
    // "the server measured it", which is the confusion this panel exists to
    // prevent.
    render(<RuleFitPanel ruleFit={claiming} rulebook={rulebook} />);
    open();
    const claimClass = screen.getByTestId("rule-claimed-r10").className;
    expect(claimClass).toContain("border-dashed");
    expect(claimClass).not.toContain("font-semibold");
  });

  it("shows no mark and no caption when the analyst did not answer", () => {
    // The common case: web search is on, so the response schema never binds.
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    open();
    expect(screen.queryByTestId("rule-claimed-r10")).toBeNull();
    expect(screen.queryByTestId("rule-fit-claim-note")).toBeNull();
  });

  it("keeps 'it used none' distinct from 'it did not say', in words as well", () => {
    // An empty claim is an answer, so the caption stands and nothing is
    // marked. With no chips on screen the two states look the same, so the
    // caption has to be the one that tells them apart — the silent wording
    // ("a run that said nothing carries no marks") would say the reverse of
    // what this row holds.
    render(<RuleFitPanel ruleFit={{ ...live, claimed_by_analyst: [] }} rulebook={rulebook} />);
    open();
    const note = screen.getByTestId("rule-fit-claim-note").textContent ?? "";
    expect(note).toContain("どのルールも使わなかったと述べています");
    expect(note).not.toContain("申告が無い回");
    expect(screen.queryByTestId("rule-claimed-r10")).toBeNull();
  });

  it("survives a rule_fit whose claim is not an array", () => {
    // Index.tsx casts the response body to RuleFit without validating it. A
    // decoration must not be able to take the analysis off the screen.
    const bad = { ...live, claimed_by_analyst: 5 } as unknown as RuleFit;
    render(<RuleFitPanel ruleFit={bad} rulebook={rulebook} />);
    open();
    expect(screen.getByTestId("rule-fit")).toBeTruthy();
    expect(screen.queryByTestId("rule-fit-claim-note")).toBeNull();
  });

  it("marks every rule when the analyst claims every rule", () => {
    render(<RuleFitPanel ruleFit={{ ...live, claimed_by_analyst: ["r4", "r10", "r11"] }} rulebook={rulebook} />);
    open();
    for (const id of ["r4", "r10", "r11"]) expect(screen.getByTestId(`rule-claimed-${id}`)).toBeTruthy();
    // and the header count still reports the MEASUREMENT, untouched by the claim
    expect(screen.getByText(/3件を提示し、うち0件が今の相場に該当/)).toBeTruthy();
  });

  it("has an English rendering with no Japanese in it", () => {
    render(<RuleFitPanel ruleFit={claiming} rulebook={rulebook} />, "en");
    open();
    const panel = screen.getByTestId("rule-fit").textContent ?? "";
    expect(panel).toContain("AI says used");
    expect(panel).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });
});

describe("the analyst's claim is filtered against what it was shown", () => {
  const shown = ["r4", "r10", "r11"];

  it("returns null when the field is absent, so silence is not 'used none'", () => {
    // Structured output does not bind with web search on, which is most
    // production runs: absent must be ordinary, and must stay tellable from
    // an answered empty list.
    expect(claimedRules(undefined, shown)).toBeNull();
    expect(claimedRules(null, shown)).toBeNull();
  });

  it("returns null for anything that is not an array", () => {
    expect(claimedRules("r10", shown)).toBeNull();
    expect(claimedRules({ r10: true }, shown)).toBeNull();
    expect(claimedRules(10, shown)).toBeNull();
  });

  it("drops ids that were never shown", () => {
    // A rule the run never put in front of it cannot have been applied by it,
    // and a held-back or invented id must not enter the record as one.
    expect(claimedRules(["r10", "r99", "r7"], shown)).toEqual(["r10"]);
  });

  it("treats an answer it could not read as silence, never as 'used none'", () => {
    // The rule block prints no ids, so an id the analyst produces today is an
    // id it was never shown. Filing that as "I used none of them" would be a
    // denial the analyst never made, on the rows most likely to have leaned
    // on a rule.
    expect(claimedRules(["r99"], shown)).toBeNull();
    expect(claimedRules(["over-extended trends"], shown)).toBeNull();
    expect(claimedRules([null, 10], shown)).toBeNull();
  });

  it("drops non-strings and empty entries without failing the whole list", () => {
    expect(claimedRules([null, 10, "", "  ", { id: "r10" }, "r11"], shown)).toEqual(["r11"]);
  });

  it("counts a repeat once", () => {
    // Same rule named twice is one citation, as parseDiagnosis treats the
    // secondary causes.
    expect(claimedRules(["r10", "r10", " r10 "], shown)).toEqual(["r10"]);
  });

  it("accepts every shown id, in the order the analyst gave them", () => {
    expect(claimedRules(["r11", "r4", "r10"], shown)).toEqual(["r11", "r4", "r10"]);
  });

  it("answers 'none' as an empty list, not as silence", () => {
    expect(claimedRules([], shown)).toEqual([]);
  });

  it("claims nothing when nothing was shown", () => {
    expect(claimedRules(["r10"], [])).toBeNull();
    expect(claimedRules([], [])).toEqual([]);
  });
});

describe("the server sends the comparison to the client", () => {
  it("puts rule_fit in the response", () => {
    expect(analyze).toContain("rule_fit: ruleFitRecord,");
  });

  it("stores the claim inside the same object, named as a claim", () => {
    // No new column and no migration: the self-report rides in the rule_fit
    // object that already carries the server's verdicts, under a key that says
    // whose statement it is.
    expect(analyze).toContain("ruleFitRecord.claimed_by_analyst = claimed");
    expect(analyze).toContain("claimedRules(parsedAnalysis.rules_applied, rulesShown)");
    // and it is written only when there is an answer, so absent stays absent
    expect(analyze).toContain("if (claimed !== null)");
  });

  it("asks for what the analyst used, not for what it was shown, and lets it say none", () => {
    const at = analyze.indexOf("rules_applied:");
    const schema = analyze.slice(at, analyze.indexOf("  required: [", at));
    expect(schema).toContain("実際に根拠として使った");
    expect(schema).toContain("空配列");
    // Never required: the field is absent on every searching run.
    const required = analyze.slice(analyze.indexOf("  required: [", at), analyze.indexOf("  additionalProperties: false", at));
    expect(required).not.toContain("rules_applied");
  });

  it("puts no live rule id in the schema description", () => {
    // The whole schema is stringified into the user message on the searching
    // path, and the rule block itself prints no ids — so an example id would
    // be the only id in the prompt, and the field would measure its own
    // example rather than the analyst.
    const at = analyze.indexOf("rules_applied:");
    const schema = analyze.slice(at, analyze.indexOf("  required: [", at));
    expect(schema).not.toMatch(/["\[]r\d+/);
  });

  it("sends rule ids and verdicts only, never the cited analysis ids", () => {
    // The rules are learned from every account. Whose plans they were learned
    // from is not the client's business.
    const record = analyze.slice(analyze.indexOf("const ruleFitRecord"), analyze.indexOf("const anthropicHeaders"));
    expect(record).toContain("comparable: fit.comparable");
    expect(record).toContain("cases: fit.cases");
    expect(record).not.toContain("supported_by");
  });
});
