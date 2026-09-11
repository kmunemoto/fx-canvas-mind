import { describe, expect, it } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import SeparatedScores from "../components/SeparatedScores";
import { readSeparatedScores } from "../lib/outcomeStats";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja") =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

// Production's own answer, 2026-09-10. Same fixture as
// src/test/separated-scores.test.ts and for the same reason: the panel is
// tested against the shape the server really sends.
const raw = {
  generated_at: "2026-09-10T17:31:23.147621+00:00",
  live_contract: "market_v1",
  definition_version: 1,
  thresholds: { direction_dead_r: 0.1, early_adverse_r: 0.5, lucky_mae_r: 0.8 },
  population: {
    calls: 97,
    trades: 56,
    waits: 41,
    diagnosed_trades: 54,
    undiagnosed_trades: 2,
    pairs: ["USD/JPY"],
    intervals: ["15min", "1day", "1h", "4h"],
    signals: { BUY: 1, SELL: 55, WAIT: 41 },
    first_call_at: "2026-08-29T05:13:43.858491+00:00",
    last_call_at: "2026-09-10T14:51:10.62516+00:00",
  },
  scopes: {
    all_time: {
      graded_trades: 36,
      direction: { n: 33, hits: 18, rate: 55, ci95: [38, 70], unscored: 3, ran_past_stop: 11, never_came: 4, wrong_partial: 0, below_min_n: false },
      timing: {
        n: 26, hits: 14, rate: 54, ci95: [35, 71], unscored: 10, below_min_n: false,
        deep_mae: { n: 34, hits: 18, rate: 53, ci95: [37, 69], unscored: 2, below_min_n: false },
      },
      placement: { n: 24, hits: 13, rate: 54, ci95: [35, 72], unscored: 12, stop_bad: 4, target_bad: 7, stop_untested: 10, below_min_n: false },
      causes: {
        total: 65, waits: 29, direction: 8, timing: 1, placement: 6, neither: 50,
        by_cause: { good_wait: 18, good_call: 14, direction_wrong: 7 },
      },
    },
  },
  by_contract: {},
  other_contract_rows: 21,
  other_contracts: ["entry_chosen_v1"],
};

const scores = readSeparatedScores(raw);

describe("the separated-scores panel", () => {
  it("never prints a rate without its own n beside it", () => {
    render(<SeparatedScores scores={scores} />);
    // Three rates, three denominators, and the denominators differ. This is
    // the whole reason the three are three rows rather than one line.
    expect(screen.getByTestId("score-direction-rate")).toHaveTextContent("55%");
    expect(screen.getByTestId("score-direction-n")).toHaveTextContent("18/33件");
    expect(screen.getByTestId("score-timing-rate")).toHaveTextContent("54%");
    expect(screen.getByTestId("score-timing-n")).toHaveTextContent("14/26件");
    expect(screen.getByTestId("score-placement-rate")).toHaveTextContent("54%");
    expect(screen.getByTestId("score-placement-n")).toHaveTextContent("13/24件");
    // ...and the deeper excursion keeps its own, on its own row.
    expect(screen.getByTestId("score-deep-mae-n")).toHaveTextContent("18/34件");
  });

  it("shows the rows it could not score rather than dropping them", () => {
    render(<SeparatedScores scores={scores} />);
    expect(screen.getByTestId("score-direction")).toHaveTextContent("採点できず 3件");
    expect(screen.getByTestId("score-timing")).toHaveTextContent("採点できず 10件");
    expect(screen.getByTestId("score-placement")).toHaveTextContent("採点できず 12件");
  });

  it("prints every interval next to its rate", () => {
    render(<SeparatedScores scores={scores} />);
    expect(screen.getByTestId("score-direction")).toHaveTextContent("95%区間 38〜70%");
    expect(screen.getByTestId("score-timing")).toHaveTextContent("95%区間 35〜71%");
    expect(screen.getByTestId("score-placement")).toHaveTextContent("95%区間 35〜72%");
  });

  it("says what the numbers rest on, and says it above them", () => {
    render(<SeparatedScores scores={scores} />);
    const basis = screen.getByTestId("separated-basis");
    expect(basis).toHaveTextContent("USD/JPY");
    expect(basis).toHaveTextContent("97");
    expect(basis).toHaveTextContent("SELL 55");
    // The basis really is before the scores in document order.
    const panel = screen.getByTestId("separated-scores");
    const order = Array.from(panel.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid"));
    expect(order.indexOf("separated-basis")).toBeLessThan(order.indexOf("score-direction"));
  });

  // The narrowness warning used to be a constant string: "one pair, almost one
  // direction, about two weeks", printed three lines under the pair list and
  // the date span it described. That is a claim with no data behind it, in the
  // sentence a reader trusts most, and it goes wrong silently — which is the
  // shape of the two lies this screen has already had removed (#83).
  it("measures the narrowness warning instead of asserting it", () => {
    render(<SeparatedScores scores={scores} />);
    const narrow = screen.getByTestId("separated-narrow");
    // 1 pair, 2026-08-29 to 2026-09-10 = 12 days, SELL 55 of 97 = 57%.
    expect(narrow).toHaveTextContent("通貨ペア 1種");
    expect(narrow).toHaveTextContent("12日");
    expect(narrow).toHaveTextContent("SELL");
    expect(narrow).toHaveTextContent("57%");
  });

  it("moves with the data rather than outliving it", () => {
    const wider = readSeparatedScores({
      ...raw,
      population: {
        ...raw.population,
        calls: 400,
        pairs: ["EUR/JPY", "USD/JPY"],
        signals: { BUY: 150, SELL: 160, WAIT: 90 },
        first_call_at: "2026-03-01T00:00:00+00:00",
        last_call_at: "2026-09-10T00:00:00+00:00",
      },
    });
    render(<SeparatedScores scores={wider} />);
    const narrow = screen.getByTestId("separated-narrow");
    expect(narrow).toHaveTextContent("通貨ペア 2種");
    // Six months, not "about two weeks".
    expect(narrow).toHaveTextContent("193日");
    // And it no longer claims a single direction.
    expect(narrow).not.toHaveTextContent("1種");
  });

  it("accounts for the trades the scores could not reach, instead of dropping them", () => {
    render(<SeparatedScores scores={scores} />);
    const basis = screen.getByTestId("separated-basis");
    // 54 diagnosed above, 36 scored below. Without this line the 18 rows on
    // the older entry contract vanish between one sentence and the next, and
    // "採点できず 3件" understates the real gap by eighteen.
    expect(basis).toHaveTextContent("原因分析ずみ 54件");
    expect(basis).toHaveTextContent("36件");
    expect(screen.getByTestId("separated-other-contract")).toHaveTextContent("21");
    expect(screen.getByTestId("separated-other-contract")).toHaveTextContent("entry_chosen_v1");
  });

  it("says how much of the placement score is a stop nothing examined", () => {
    render(<SeparatedScores scores={scores} />);
    // 10 of the 13 "placement fine" rows are trades that simply did not lose:
    // causeGrounds refuses to judge a stop that was never hit, so `bad` is
    // unreachable on a win and a run of wins lifts this score by itself.
    expect(screen.getByTestId("score-placement")).toHaveTextContent("10件");
    expect(screen.getByTestId("score-placement")).toHaveTextContent("検証していない");
    // ...and the hint must not claim the judge answered the stop question.
    expect(screen.getByTestId("score-placement")).toHaveTextContent("負けなかった取引は");
  });

  it("marks the one row where a higher number is worse", () => {
    render(<SeparatedScores scores={scores} />);
    const deep = screen.getByTestId("score-deep-mae");
    expect(deep).toHaveTextContent("数字が大きいほど悪い");
    render(<SeparatedScores scores={scores} />, "en");
    expect(screen.getAllByTestId("score-deep-mae").at(-1)).toHaveTextContent("higher is WORSE");
  });

  it("puts the thresholds on the screen, not only in the payload", () => {
    render(<SeparatedScores scores={scores} />);
    // "Right about the direction" is satisfied by a 0.1R excursion. A reader
    // cannot discover that from the label, so the number is in the hint.
    expect(screen.getByTestId("score-direction")).toHaveTextContent("0.1R");
    expect(screen.getByTestId("score-timing")).toHaveTextContent("0.5R");
    expect(screen.getByTestId("score-deep-mae")).toHaveTextContent("80%");
  });

  it("gives the cause histogram its own n and says it is a different population", () => {
    render(<SeparatedScores scores={scores} />);
    const n = screen.getByTestId("separated-causes-n");
    // 65 lesson rows, 29 of them WAITs — which are in none of the three
    // scores. Three rates over 36 trades and a count over 65 lessons under one
    // heading, with no denominator on the second, is the same error.
    expect(n).toHaveTextContent("65");
    expect(n).toHaveTextContent("29");
  });

  it("applies the thin-n rule to the deep-excursion row as well", () => {
    const thin = readSeparatedScores({
      ...raw,
      scopes: {
        all_time: {
          ...raw.scopes.all_time,
          timing: {
            n: 26, hits: 14, rate: 54, ci95: [35, 71], unscored: 10, below_min_n: false,
            deep_mae: { n: 11, hits: 9, rate: 82, ci95: [52, 95], unscored: 25, below_min_n: true },
          },
        },
      },
    });
    render(<SeparatedScores scores={thin} />);
    expect(screen.getByTestId("score-deep-mae-thin")).toBeInTheDocument();
  });

  it("says nothing is decided while an interval still straddles even odds", () => {
    render(<SeparatedScores scores={scores} />);
    // All three of today's intervals contain 50%.
    expect(screen.getByTestId("separated-undecided")).toBeInTheDocument();
    const settled = readSeparatedScores({
      ...raw,
      scopes: {
        all_time: {
          ...raw.scopes.all_time,
          direction: { n: 300, hits: 240, rate: 80, ci95: [75, 84], unscored: 0, ran_past_stop: 40, never_came: 20, wrong_partial: 0, below_min_n: false },
          timing: { n: 300, hits: 210, rate: 70, ci95: [65, 75], unscored: 0, below_min_n: false, deep_mae: { n: 300, hits: 60, rate: 20, ci95: [16, 25], unscored: 0, below_min_n: false } },
          placement: { n: 300, hits: 225, rate: 75, ci95: [70, 80], unscored: 0, stop_bad: 30, target_bad: 45, stop_untested: 100, below_min_n: false },
        },
      },
    });
    render(<SeparatedScores scores={settled} />);
    expect(screen.queryAllByTestId("separated-undecided")).toHaveLength(1);
  });

  it("refuses to let the three read as a decomposition", () => {
    render(<SeparatedScores scores={scores} />);
    expect(screen.getByTestId("separated-denominators")).toHaveTextContent("3つの母数");
    expect(screen.getByTestId("separated-caveat")).toHaveTextContent("足しても勝率になりません");
  });

  it("carries each score's own caveat on the score itself", () => {
    render(<SeparatedScores scores={scores} />);
    // direction may be right on a losing trade
    expect(screen.getByTestId("score-direction")).toHaveTextContent("負けた取引でも方向は正解でありえます");
    // timing is heat, not a verdict on the entry
    expect(screen.getByTestId("score-timing")).toHaveTextContent("「入り方が間違っていた」という意味ではありません");
    // placement is downstream of the other two
    expect(screen.getByTestId("score-placement")).toHaveTextContent("方向とタイミングの結果でもあります");
  });

  it("says it has no answer instead of drawing zeroes", () => {
    render(<SeparatedScores scores={null} />);
    expect(screen.getByTestId("separated-none")).toBeInTheDocument();
    expect(screen.queryByTestId("score-direction")).toBeNull();
    // A panel with no data must not put a percent sign on the screen at all.
    expect(screen.getByTestId("separated-scores").textContent).not.toContain("%");
  });

  it("says there is nothing to score yet rather than 0%", () => {
    const empty = readSeparatedScores({
      ...raw,
      scopes: { all_time: { graded_trades: 0, direction: { n: 0 }, timing: { n: 0, deep_mae: { n: 0 } }, placement: { n: 0 }, causes: {} } },
      by_contract: {},
    });
    render(<SeparatedScores scores={empty} />);
    expect(screen.getByTestId("separated-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("score-direction")).toBeNull();
    // The basis is still shown: "here is how little there is" is the finding.
    expect(screen.getByTestId("separated-basis")).toBeInTheDocument();
  });

  it("labels a thin n rather than withholding the rate", () => {
    const thin = readSeparatedScores({
      ...raw,
      scopes: {
        all_time: {
          graded_trades: 6,
          direction: { n: 6, hits: 4, rate: 67, ci95: [30, 90], unscored: 0, below_min_n: true },
          timing: { n: 5, hits: 2, rate: 40, ci95: [12, 77], unscored: 1, below_min_n: true, deep_mae: { n: 5, hits: 1, rate: 20, ci95: [4, 62], unscored: 1, below_min_n: true } },
          placement: { n: 4, hits: 2, rate: 50, ci95: [15, 85], unscored: 2, below_min_n: true },
          causes: {},
        },
      },
      by_contract: {},
    });
    render(<SeparatedScores scores={thin} />);
    expect(screen.getByTestId("score-direction-rate")).toHaveTextContent("67%");
    expect(screen.getByTestId("score-direction-thin")).toBeInTheDocument();
    expect(screen.getByTestId("score-placement-thin")).toBeInTheDocument();
  });

  it("names the older contract when that is the record being drawn", () => {
    const legacy = readSeparatedScores({
      ...raw,
      scopes: { all_time: { graded_trades: 0, direction: { n: 0 }, timing: { n: 0, deep_mae: { n: 0 } }, placement: { n: 0 }, causes: {} } },
      by_contract: { entry_chosen_v1: raw.scopes.all_time },
    });
    render(<SeparatedScores scores={legacy} />);
    expect(screen.getByTestId("separated-contract")).toHaveTextContent("entry_chosen_v1");
  });

  it("renders in English with the same shape and no Japanese left in it", () => {
    render(<SeparatedScores scores={scores} />, "en");
    const panel = screen.getByTestId("separated-scores");
    expect(panel).toHaveTextContent("Three scores kept apart");
    expect(screen.getByTestId("score-direction-n")).toHaveTextContent("18/33");
    expect(screen.getByTestId("score-timing-n")).toHaveTextContent("14/26");
    expect(screen.getByTestId("score-placement-n")).toHaveTextContent("13/24");
    expect(screen.getByTestId("separated-caveat")).toHaveTextContent("not independent");
    expect(screen.getByTestId("separated-narrow")).toHaveTextContent("1 pair");
    expect(screen.getByTestId("score-placement")).toHaveTextContent("passed the stop test untested");
    expect(panel.textContent ?? "").not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});
