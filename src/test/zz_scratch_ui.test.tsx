import { describe, it, expect } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import AnalysisHistory from "../components/AnalysisHistory";
import LearnedRules from "../components/LearnedRules";
import OutcomeDetail from "../components/OutcomeDetail";
import type { AnalysisRecord } from "../lib/types";

const render = (ui: ReactElement, locale: "ja" | "en" = "en") =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const rec = (over: Partial<AnalysisRecord>): AnalysisRecord => ({
  id: Math.random().toString(36).slice(2),
  pair: "USD/JPY", interval: "1h", mode: "full", signal: "BUY", confidence: 70, thesis: null,
  entry_point: 150, stop_loss: 149, take_profit_1: 152, take_profit_2: null, take_profit_3: null,
  price_at_signal: 150.2, outcome: "pending", outcome_price: null,
  created_at: "2026-08-20T00:00:00Z", closed_at: null, evaluation: null, ...over,
});

describe("scratch: record strip", () => {
  it("one settled trade, en", () => {
    render(<AnalysisHistory records={[rec({ outcome: "win" })]} />);
    const strip = screen.getByTestId("record-strip");
    console.log("STRIP(1 win, en):", strip.textContent);
    expect(strip.textContent).toContain("Expectancy");
  });

  it("many settled trades in few clusters, en", () => {
    // 60 settled trades on the same pair/direction within 24h windows => clusters far below 50
    const records = Array.from({ length: 60 }, (_, i) =>
      rec({ outcome: i % 2 === 0 ? "win" : "loss", created_at: `2026-08-${String(1 + Math.floor(i / 10)).padStart(2, "0")}T0${i % 10}:00:00Z` }),
    );
    render(<AnalysisHistory records={records} />);
    const strip = screen.getByTestId("record-strip");
    console.log("STRIP(60 settled, few clusters):", strip.textContent);
  });

  it("R column for a group with no settled R", () => {
    render(<AnalysisHistory records={[rec({ outcome: "win", interval: "1h" }), rec({ outcome: "untriggered", interval: "4h" })]} />);
    const rows = screen.getAllByRole("row");
    console.log("TABLE ROWS:", rows.map((r) => r.textContent));
  });
});

describe("scratch: outcome detail v2 facts", () => {
  const base = rec({
    outcome: "loss", closed_at: "2026-08-20T05:00:00Z",
    evaluation: {
      version: 3, eval_interval: "15min", order_type: "market", price_at_signal: 150.2, possible_fill: false,
      filled_at: "2026-08-20T00:00:00Z", fill_price: 150, resolution: "loss", reason: null, resolved_at: "2026-08-20T05:00:00Z",
      refined: false, refine_pending: false, refine_attempts: 0, mfe: 0.3, mae: 1, mfe_r: 0.3, mae_r: 1, tps_hit: [],
      bars_after_signal: 20, window_covers_signal: true, first_candle_at: null, last_candle_at: null, checked_at: "2026-08-20T06:00:00Z", note: null, path: [],
    },
  });
  const facts = {
    version: 2, bars_after_settlement: 2, hours_to_fill: 0, hours_to_settle: 5,
    from_signal: { max_favorable_r: 0.3, max_adverse_r: 1 },
    after: { first_touch: null, reached_tp1: null, reached_sl: null, beyond_sl_r: 0, returned_to_entry: null },
    abnormal_bar: null, early_adverse_r: 0.7,
    counterfactual: {
      market_entry: null,
      market_entry_same_risk: { resolution: "win", reason: null, mfe_r: 2, mae_r: 0.2, rr: 0.9, viable: false },
      stop_x1_5: { resolution: "win", reason: null, mfe_r: 2, mae_r: 1.1, rr: 1.33, viable: true },
      stop_x2: null, tp_half: null,
      limit_pullback: { resolution: "win", reason: null, mfe_r: 2.5, mae_r: 0.4, rr: 2.5, viable: true },
    },
    regime: null, hints: ["entry_too_early" as const], notes: [],
  };
  it("thin and revised together", () => {
    const r: AnalysisRecord = {
      ...base,
      postmortem: {
        schema: 2, status: "done", cause: "entry_too_early", avoidable: true, confidence: 70,
        verdict: { ja: "v", en: "verdict" }, evidence: { ja: [], en: [] }, lesson: { ja: "l", en: "lesson" },
        facts, thin: true, revisions: 1, rule_blamed: "r2", rule_credited: null,
      },
    };
    render(<OutcomeDetail record={r} />);
    const pm = screen.getByTestId("postmortem");
    console.log("POSTMORTEM(thin+revised):", pm.textContent);
    expect(pm.textContent).not.toContain("undefined");
  });
});

describe("scratch: learned rules", () => {
  it("kind badge and under review, en", () => {
    const rules = [
      { id: "r1", text_ja: "ルール1", text_en: "Rule 1", cause: "stop_too_tight", support: 2, scope: null, since: null, kind: "constraint" as const, supported_by: [] },
      { id: "r2", text_ja: "ルール2", text_en: "Rule 2", cause: "general", support: 3, scope: "1h", since: null, kind: "heuristic" as const, supported_by: [] },
    ];
    render(<LearnedRules rulebook={{ version: 1, rules, summary: null, updated_at: null }} />);
    console.log("RULES(en):", screen.getByTestId("learned-rules").textContent);
    fireEvent.click(document.body);
  });
});
