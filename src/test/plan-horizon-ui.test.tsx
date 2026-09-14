import { describe, it, expect } from "vitest";
import { render as rtlRender, screen, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import AnalysisResultView from "../components/AnalysisResultView";
import OutcomeDetail from "../components/OutcomeDetail";
import { horizonLines } from "../lib/planHorizon";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";
import type { AnalysisRecord, AnalysisResult, PlanHorizon } from "../lib/types";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const HOUR = 60 * 60 * 1000;

const horizon = (over: Partial<PlanHorizon> = {}): PlanHorizon => ({
  version: 1,
  bars: 12,
  interval: "1h",
  source: "interval_table_v1",
  bar_ms: HOUR,
  declared_at: "2026-09-14T03:00:00.000Z",
  ends_at: "2026-09-14T15:00:00.000Z",
  calendar_covers_horizon: true,
  ...over,
});

const result = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
  signal: "BUY", thesis: "押し目買い", confidence: 72, technical_score: 70, fundamental_score: 55,
  risk_level: "MEDIUM", sentiment: "BULLISH", entry_point: "150.123", stop_loss: "149.500",
  take_profit_1: "151.200", take_profit_2: "151.900", take_profit_3: "152.600",
  risk_reward_ratio: "1:1.7", analysis: "", key_factors: [], warnings: [],
  support_levels: [], resistance_levels: [], market_context: "", ...over,
});

const record = (over: Partial<AnalysisRecord> = {}): AnalysisRecord => ({
  id: "r-1", pair: "USD/JPY", interval: "1h", mode: "full", signal: "BUY", confidence: 72,
  thesis: null, entry_point: 150.123, stop_loss: 149.5, take_profit_1: 151.2,
  take_profit_2: null, take_profit_3: null, price_at_signal: 150.123, outcome: "pending",
  outcome_price: null, created_at: "2026-09-14T03:00:00Z", closed_at: null, evaluation: null,
  plan_contract: "market_v1", ...over,
});

// ---------------------------------------------------------------------------
// the formatter
// ---------------------------------------------------------------------------

describe("horizonLines derives the period from the row and nothing else", () => {
  it("reads the length off bars x bar_ms rather than any table", () => {
    // The point of storing bar_ms is that a row issued under one table still
    // renders its own period. So a row claiming a bar length the current table
    // does not have must render THAT length, not the one 1h means today.
    const odd = horizonLines(horizon({ bars: 5, bar_ms: 2 * HOUR }), ja, "ja-JP");
    expect(odd?.bars).toContain("5");
    expect(odd?.bars).toContain("10");   // 5 x 2h, not 5 x 1h
  });

  it("says days once the period stops reading as hours", () => {
    // 120 hours is a real number and an unreadable one.
    const daily = horizonLines(horizon({ interval: "1day", bars: 5, bar_ms: 24 * HOUR }), ja, "ja-JP");
    expect(daily?.bars).toContain("5日");
    expect(daily?.bars).not.toContain("120");
    // and the ordinary case stays in hours
    expect(horizonLines(horizon(), ja, "ja-JP")?.bars).toContain("12時間");
  });

  it("labels the timeframe from the dictionary, and falls back to the raw value", () => {
    expect(horizonLines(horizon(), ja, "ja-JP")?.bars).toContain("1時間足");
    expect(horizonLines(horizon(), en, "en-GB")?.bars).toContain("1H");
    // An interval the dictionary has no label for still renders — an unknown
    // key must not print "undefined" where the timeframe belongs.
    const unknown = horizonLines(horizon({ interval: "30min" }), ja, "ja-JP");
    expect(unknown?.bars).toContain("30min");
    expect(unknown?.bars).not.toContain("undefined");
  });

  it("drops only the end line when the instant cannot be read", () => {
    // "to about Invalid Date" is worse than saying nothing, but the bar count
    // is still true, so the rest of the block survives.
    const broken = horizonLines(horizon({ ends_at: "not a time" }), ja, "ja-JP");
    expect(broken).not.toBeNull();
    expect(broken?.endsAt).toBeNull();
    expect(broken?.bars).toContain("12");
  });

  it("refuses a period of nothing rather than rendering one", () => {
    // "0 bars (about 0 hours)" reads as a plan that is already over.
    for (const bad of [{ bars: 0 }, { bars: -3 }, { bar_ms: 0 }, { bars: Number.NaN }]) {
      expect(horizonLines(horizon(bad), ja, "ja-JP"), JSON.stringify(bad)).toBeNull();
    }
    expect(horizonLines(null, ja, "ja-JP")).toBeNull();
    expect(horizonLines(undefined, ja, "ja-JP")).toBeNull();
  });

  it("renders nothing at all from calendar_covers_horizon", () => {
    // It was going to be a warning shown only where the calendar fell short.
    // Measured over four weeks of hourly starts it is false on 31 / 35 / 56 /
    // 99 % of plans for 15min / 1h / 4h / 1day — the period is walked in
    // MARKET time, so the flag really says "this window crossed a closure",
    // and a five-day window always crosses a weekend. True every time and
    // useless nearly every time is the definition of boilerplate.
    // The field stays on the row; it is simply not a warning.
    const covered = horizonLines(horizon({ calendar_covers_horizon: true }), ja, "ja-JP");
    const short = horizonLines(horizon({ calendar_covers_horizon: false }), ja, "ja-JP");
    expect(JSON.stringify(short)).toBe(JSON.stringify(covered));
    expect(JSON.stringify(short)).not.toContain("カレンダー");
  });

  it("keeps each locale in its own language", () => {
    const jaLines = horizonLines(horizon(), ja, "ja-JP");
    const enLines = horizonLines(horizon(), en, "en-GB");
    const enText = [enLines?.bars, enLines?.notACutoff, enLines?.tpRoles].join(" ");
    expect(enText).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(jaLines?.notACutoff).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});

// ---------------------------------------------------------------------------
// the live plan card
// ---------------------------------------------------------------------------

describe("the plan card says what period the levels were placed against", () => {
  it("shows the period, its end, and that the count is not a deadline", () => {
    render(<AnalysisResultView result={result()} pair="USD/JPY" interval="1h" planHorizon={horizon()} />);
    const block = screen.getByTestId("plan-horizon");
    expect(block).toHaveTextContent("1時間足");
    expect(block).toHaveTextContent("12");
    expect(screen.getByTestId("horizon-ends-at")).toBeTruthy();
    // The measured reason this sentence exists: truncating the 53 settled
    // rows at 24 bars drops 2, and both of them are wins.
    expect(block).toHaveTextContent("期限ではありません");
    // and which target is meant to land inside the period, which is the only
    // thing on this card that changes where a level goes
    expect(block).toHaveTextContent("TP1");
  });

  it("renders nothing at all when no period was declared", () => {
    // The live card is forward-looking: an absent period there means the
    // interval had no entry in the table, and inventing a line for it would
    // be inventing the period.
    render(<AnalysisResultView result={result()} pair="USD/JPY" interval="1h" planHorizon={null} />);
    expect(screen.queryByTestId("plan-horizon")).toBeNull();
  });

  it("does not claim a period for a WAIT, which has no levels to place", () => {
    render(
      <AnalysisResultView
        result={result({ signal: "WAIT", entry_point: "—", stop_loss: "—", take_profit_1: "—" })}
        pair="USD/JPY"
        interval="1h"
        planHorizon={horizon()}
      />,
    );
    expect(screen.queryByTestId("trade-plan")).toBeNull();
    expect(screen.queryByTestId("plan-horizon")).toBeNull();
  });

  it("does not warn about the calendar, whichever way the flag went", () => {
    for (const covers of [true, false]) {
      const { unmount } = render(
        <AnalysisResultView result={result()} pair="USD/JPY" interval="1h"
          planHorizon={horizon({ calendar_covers_horizon: covers })} />,
      );
      expect(screen.queryByTestId("horizon-calendar-short"), String(covers)).toBeNull();
      expect(screen.getByTestId("plan-horizon").textContent ?? "").not.toContain("カレンダー");
      unmount();
    }
  });

  it("speaks English to an English reader", () => {
    render(
      <AnalysisResultView result={result()} pair="USD/JPY" interval="1h" planHorizon={horizon()} />,
      "en",
    );
    const block = screen.getByTestId("plan-horizon");
    expect(block.textContent ?? "").not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(block).toHaveTextContent("not a deadline");
  });
});

// ---------------------------------------------------------------------------
// the history panel
// ---------------------------------------------------------------------------

describe("a past plan keeps the period it was issued with", () => {
  it("renders the row's own stored period, not one computed today", () => {
    render(<OutcomeDetail record={record({ plan_horizon: horizon({ bars: 9, bar_ms: 4 * HOUR, interval: "4h" }) })} />);
    const block = screen.getByTestId("detail-horizon");
    expect(block).toHaveTextContent("4時間足");
    expect(block).toHaveTextContent("9");
    // 9 x 4h = 36 hours, which is under the two-day threshold
    expect(block).toHaveTextContent("36時間");
  });

  it("says a row has no period rather than leaving the space blank", () => {
    // The 117 rows written before the column existed were deliberately not
    // backfilled: a period computed today is not the period that plan was
    // aiming at. Silence there would read as "the period is the default".
    render(<OutcomeDetail record={record({ plan_horizon: null })} />);
    expect(screen.getByTestId("detail-horizon-absent")).toBeTruthy();
    expect(screen.queryByTestId("detail-horizon")).toBeNull();
  });

  it("does not announce a target period on a row that proposed no trade", () => {
    // The column IS stamped on WAIT rows — analyze writes it on every row — so
    // this is not about a missing value. It is about what the value MEANS: a
    // WAIT has no entry, stop or target, so calling anything "the period this
    // is aiming at" describes a trade that was never proposed. Nothing scores
    // a WAIT against it either; WAIT scoring spends wait_window_ms.
    const wait = record({ signal: "WAIT", outcome: "skipped", entry_point: null, stop_loss: null,
      take_profit_1: null, plan_horizon: horizon() });
    render(<OutcomeDetail record={wait} />);
    expect(screen.queryByTestId("detail-horizon")).toBeNull();
    // and not the "no period recorded" line either — on a WAIT that would
    // imply a period that ought to have been there
    expect(screen.queryByTestId("detail-horizon-absent")).toBeNull();
  });

  it("still shows it on a trade row, so the guard did not silence everything", () => {
    render(<OutcomeDetail record={record({ plan_horizon: horizon() })} />);
    expect(screen.getByTestId("detail-horizon")).toBeTruthy();
  });

  it("leaves the 'not a deadline' caveat off a row that has already been scored", () => {
    // Nothing is still being decided on a settled row, so the reassurance the
    // live card carries would be addressing a question nobody has.
    render(<OutcomeDetail record={record({ plan_horizon: horizon(), outcome: "win" })} />);
    expect(screen.getByTestId("detail-horizon").textContent ?? "").not.toContain("期限ではありません");
  });
});
