import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import RuleFitPanel from "../components/RuleFitPanel";
import type { RuleFit, Rulebook } from "../lib/types";

const analyze = readFileSync("supabase/functions/analyze/index.ts", "utf8");

const render = (ui: ReactElement, locale: "ja" | "en" = "ja") =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

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
    expect(screen.getByText("上位足が弱いなら見送る")).toBeTruthy();
    expect(screen.getByText("伸び切りを追わない")).toBeTruthy();
    expect(screen.getAllByText("別局面")).toHaveLength(2);
    expect(screen.getByText("照合不可")).toBeTruthy();
  });

  it("says which axes put the market outside, not just that it is outside", () => {
    // "Different situation" on its own is a verdict without its evidence.
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    expect(screen.getByText(/外れた軸: RSI・SMA20乖離$/)).toBeTruthy();
    expect(screen.getByText(/外れた軸: ADX・RSI・SMA20乖離・上位足ADX$/)).toBeTruthy();
  });

  it("says how much of a rule's evidence the comparison could actually read", () => {
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    // r10 cites five and only four carry the reading of the day
    expect(screen.getByText(/根拠5件のうち4件しか当時の値が残っておらず/)).toBeTruthy();
    // r11 cites three and all three are readable
    expect(screen.getByText(/根拠3件すべての当時の値と比較/)).toBeTruthy();
  });

  it("says the verdict is a measurement, not something the rule claims", () => {
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />);
    const note = screen.getByTestId("rule-fit-note").textContent ?? "";
    expect(note).toContain("ルール本文の主張ではありません");
    // And that the evidence behind a rule is not only this reader's record
    expect(note).toContain("全アカウント");
  });

  it("counts how many of the shown rules fit", () => {
    const someMatch: RuleFit = {
      ...live,
      rules: { ...live.rules, r4: { fit: "match", comparable: ["adx", "rsi"], missed: [], cases: 2, cited: 2 } },
    };
    render(<RuleFitPanel ruleFit={someMatch} rulebook={rulebook} />);
    expect(screen.getByText(/3件を提示し、うち1件が今の相場に該当/)).toBeTruthy();
  });

  it("names what the budget cut", () => {
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
    expect(screen.getByText(/r10：本文を取得できませんでした/)).toBeTruthy();
  });

  it("has an English rendering with no Japanese in it", () => {
    render(<RuleFitPanel ruleFit={live} rulebook={rulebook} />, "en");
    const panel = screen.getByTestId("rule-fit").textContent ?? "";
    expect(panel).toContain("different situation");
    expect(panel).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });
});

describe("the server sends the comparison to the client", () => {
  it("puts rule_fit in the response", () => {
    expect(analyze).toContain("rule_fit: ruleFitRecord,");
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
