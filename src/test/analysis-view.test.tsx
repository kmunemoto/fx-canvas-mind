import { describe, it, expect } from "vitest";
import { fireEvent, render as rtlRender, screen, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import AnalysisResultView from "../components/AnalysisResultView";
import AnalysisHistory from "../components/AnalysisHistory";
import LearnedRules from "../components/LearnedRules";
import AnalysisStages from "../components/AnalysisStages";
import type { AnalysisRecord, AnalysisResult, OutcomeEvaluation, TechnicalData } from "../lib/types";
import { CURRENT_CONTRACT } from "../lib/outcomeStats";

// Everything user-facing reads the dictionary now, so the provider is part of
// rendering these components at all. Tests default to Japanese, which is what
// a viewer with no stored preference and a ja browser gets.
const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const fullResult: AnalysisResult = {
  signal: "BUY",
  thesis: "流動性スイープ後の上方拡張",
  confidence: 72,
  technical_score: 78,
  fundamental_score: 55,
  risk_level: "MEDIUM",
  sentiment: "BULLISH",
  entry_point: "150.123",
  stop_loss: "149.500",
  take_profit_1: "151.200",
  take_profit_2: "151.900",
  take_profit_3: "152.600",
  risk_reward_ratio: "1:1.7",
  analysis: "詳細分析テキスト",
  key_factors: ["上位足と方向一致", "サポート反発"],
  warnings: ["この分析は参考情報です。投資判断は自己責任で行ってください"],
  support_levels: ["149.800", "149.200"],
  resistance_levels: ["151.500"],
  market_context: "東京時間のトレンド継続局面",
  market_context_detail: {
    mode: "Trend Day",
    structure: "Higher Highs & Higher Lows",
    smart_money: "Accumulation",
    strength: "Moderate",
    session: "Tokyo",
    direction: "Up",
    continuity: "Sustained",
  },
  stop_hunt_zone: "149.45-149.50",
  timeframe_alignment: [
    { timeframe: "1h", bias: "BULLISH", note: "押し目形成" },
    { timeframe: "4h", bias: "BULLISH", note: "上昇継続" },
    { timeframe: "1day", bias: "NEUTRAL", note: "レンジ上限" },
  ],
};

const techData: TechnicalData = {
  price: "150.123",
  datetime: "2026-08-25 12:00:00",
  timeSeries: [],
  rsi: "58.20",
  macd: "0.05000",
  macdSignal: "0.03000",
  macdHist: "0.02000",
  bbUpper: "150.900",
  bbMiddle: "150.000",
  bbLower: "149.100",
  sma20: "150.000",
  sma50: "149.700",
  sma200: "148.900",
  tenkan: "150.050",
  kijun: "149.850",
  spanA: "149.950",
  spanB: "149.500",
  atr: "0.450",
  slowK: "65.00",
  slowD: "60.00",
  adx: "28.00",
  candles: Array.from({ length: 60 }, (_, i) => ({
    datetime: `2026-08-25 ${String(i % 24).padStart(2, "0")}:00:00`,
    open: 149.5 + Math.sin(i / 6) * 0.4,
    high: 149.8 + Math.sin(i / 6) * 0.4,
    low: 149.3 + Math.sin(i / 6) * 0.4,
    close: 149.6 + Math.sin(i / 6) * 0.4,
  })),
};

describe("AnalysisResultView (v9 payload)", () => {
  it("renders direction, thesis, plan, market context and chart levels", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);

    expect(screen.getByText("LONG")).toBeInTheDocument();
    expect(screen.getByText("流動性スイープ後の上方拡張")).toBeInTheDocument();
    expect(screen.getByText("Market Mode")).toBeInTheDocument();
    expect(screen.getByText("Trend Day")).toBeInTheDocument();
    expect(screen.getByText("Stop Hunt Zone")).toBeInTheDocument();
    expect(screen.getByText("利確 TP3")).toBeInTheDocument();
    expect(screen.getByText("152.600")).toBeInTheDocument();
    // level pills drawn into the SVG chart
    expect(screen.getByText(/ENTRY 150\.123/)).toBeInTheDocument();
    expect(screen.getByText(/SL 149\.500/)).toBeInTheDocument();
    expect(screen.getByText(/TP1 151\.200/)).toBeInTheDocument();
  });

  it("still renders a legacy v8-shaped result without the new fields", () => {
    const legacy: AnalysisResult = {
      ...fullResult,
      thesis: undefined,
      take_profit_3: undefined,
      market_context_detail: null,
      stop_hunt_zone: undefined,
      timeframe_alignment: [],
    };
    render(<AnalysisResultView result={legacy} techData={null} pair="USD/JPY" interval="1h" />);
    expect(screen.getAllByText("LONG").length).toBeGreaterThan(0);
  });
});

describe("AnalysisHistory (DB records)", () => {
  const base = {
    mode: "full", thesis: null, take_profit_2: null, take_profit_3: null,
    price_at_signal: null, evaluation: null,
  };
  const evaluation: OutcomeEvaluation = {
    version: 3, eval_interval: "15min", order_type: "limit", price_at_signal: 150.4, possible_fill: false,
    filled_at: "2026-08-20T02:00:00Z", fill_price: 150,
    resolution: "win", reason: null, resolved_at: "2026-08-20T05:00:00Z",
    refined: false, refine_pending: false, refine_attempts: 0,
    mfe: 2.1, mae: 0.3, mfe_r: 2.1, mae_r: 0.3, tps_hit: [1, 2],
    bars_after_signal: 20, window_covers_signal: true,
    first_candle_at: "2026-08-20T00:00:00Z", last_candle_at: "2026-08-20T05:00:00Z",
    checked_at: "2026-08-20T06:00:00Z", note: null,
    path: [
      { t: "2026-08-19T23:00:00Z", o: 150.4, h: 150.6, l: 150.3, c: 150.5 },
      { t: "2026-08-20T02:00:00Z", o: 150.3, h: 150.4, l: 149.9, c: 150.2 },
      { t: "2026-08-20T05:00:00Z", o: 150.8, h: 152.3, l: 150.7, c: 152.0 },
    ],
  };
  const records: AnalysisRecord[] = [
    {
      ...base, id: "a", pair: "USD/JPY", interval: "1h", signal: "BUY", confidence: 72,
      entry_point: 150, stop_loss: 149, take_profit_1: 152, take_profit_2: 153, price_at_signal: 150.4,
      outcome: "win", outcome_price: 152, created_at: "2026-08-20T00:00:00Z", closed_at: "2026-08-20T05:00:00Z",
      evaluation,
    },
    {
      ...base, id: "b", pair: "EUR/USD", interval: "4h", mode: "technical_only", signal: "SELL", confidence: 65,
      entry_point: 1.1, stop_loss: 1.11, take_profit_1: 1.08,
      outcome: "loss", outcome_price: 1.11, created_at: "2026-08-22T00:00:00Z", closed_at: null,
    },
    {
      ...base, id: "c", pair: "USD/JPY", interval: "15min", signal: "WAIT", confidence: 40,
      entry_point: null, stop_loss: null, take_profit_1: null,
      outcome: "skipped", outcome_price: null, created_at: "2026-08-23T00:00:00Z", closed_at: null,
    },
    {
      ...base, id: "d", pair: "USD/JPY", interval: "1h", signal: "SELL", confidence: 66,
      entry_point: 157.9, stop_loss: 158.45, take_profit_1: 157.05, price_at_signal: 158.3,
      outcome: "untriggered", outcome_price: null, created_at: "2026-09-03T04:49:00Z", closed_at: "2026-09-03T06:00:00Z",
      evaluation: { ...evaluation, order_type: "stop", filled_at: null, fill_price: null, resolution: "untriggered", reason: "invalidated", resolved_at: "2026-09-03T06:00:00Z", mfe: null, mae: null, mfe_r: null, mae_r: null, tps_hit: [] },
    },
  ];

  it("takes the win rate over win/loss/expired, with a badge per outcome", () => {
    render(<AnalysisHistory records={records} />);
    expect(screen.getAllByText("勝率").length).toBeGreaterThan(0);
    // 1 win, 1 loss, no expiry; the row that never filled is not a verdict
    expect(screen.getByTestId("win-rate")).toHaveTextContent("50%");
    expect(screen.getByText("WIN")).toBeInTheDocument();
    expect(screen.getByText("LOSS")).toBeInTheDocument();
    expect(screen.getAllByText("未約定").length).toBeGreaterThan(0);
  });

  it("publishes what share of calls ever produced a verdict", () => {
    render(<AnalysisHistory records={records} />);
    const strip = screen.getByTestId("verdict-strip");
    // 4 calls: a win, a loss, a WAIT and one that never filled. Only 2 of them
    // ever produced a verdict, and the WAIT is in the denominator — leaving it
    // out is exactly how "never trade, never be wrong" would hide.
    expect(strip).toHaveTextContent("50%");
    expect(strip).toHaveTextContent("(2/4)");
    expect(strip).toHaveTextContent("見送り 25%");
    expect(strip).toHaveTextContent("未約定 25%");
  });

  it("breaks the record down by timeframe, mode and confidence", () => {
    render(<AnalysisHistory records={records} />);
    expect(screen.getByRole("button", { name: "時間足" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("4h")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "モード" }));
    expect(screen.getByRole("button", { name: "モード" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("ニュース込み")).toBeInTheDocument();
    expect(screen.getByText("テクニカル")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "確信度" }));
    expect(screen.getByText("70–79%")).toBeInTheDocument();
  });

  it("opens a row into the plan-vs-actual evidence with fill and TP1 marked on the chart", () => {
    render(<AnalysisHistory records={records} />);
    expect(screen.queryByTestId("outcome-detail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /USD\/JPY 1h.*BUY 72%/ }));
    const detail = screen.getByTestId("outcome-detail");
    expect(detail).toBeInTheDocument();
    expect(screen.getByText("AIの予想")).toBeInTheDocument();
    expect(screen.getByText("TP1 152.000 に到達")).toBeInTheDocument();
    expect(screen.getByText("TP1 / TP2")).toBeInTheDocument();
    expect(screen.getByText("210 pips (2.1R)")).toBeInTheDocument();
    expect(screen.getByTestId("chart-marker-signal")).toBeInTheDocument();
    expect(screen.getByTestId("chart-marker-fill")).toBeInTheDocument();
    expect(screen.getByTestId("chart-marker-win")).toBeInTheDocument();
  });

  it("explains why an untriggered plan never became a trade", () => {
    render(<AnalysisHistory records={records} />);
    fireEvent.click(screen.getByRole("button", { name: /SELL 66%/ }));
    expect(screen.getByText("約定前に損切り水準へ到達（シナリオ崩れ）")).toBeInTheDocument();
    expect(screen.getByText("未約定", { selector: "span.font-mono" })).toBeInTheDocument();
  });

  it("does not promise a judgement for a WAIT row", () => {
    render(<AnalysisHistory records={records} />);
    fireEvent.click(screen.getByRole("button", { name: /WAIT 40%/ }));
    expect(screen.getByText("WAIT（トレードプランなし）のため判定対象外")).toBeInTheDocument();
    expect(screen.queryByText(/次回の自動判定/)).toBeNull();
    expect(screen.queryByText("エントリー")).toBeNull();
  });

  it("shows the post-mortem on a settled row, and says one is coming on a row without it", () => {
    const diagnosed: AnalysisRecord = {
      ...records[1],
      id: "pm",
      postmortem: {
        schema: 1, status: "done", cause: "stop_too_tight", secondary_causes: ["news_shock"], avoidable: true, confidence: 80,
        verdict: { ja: "方向は合っていたが損切りが近すぎた", en: "Right direction, stop too tight" },
        evidence: { ja: ["損切り後4本でTP1到達"], en: ["TP1 reached 4 bars after the stop"] },
        lesson: { ja: "4h の成行では損切りを ATR×1.0 以上に置く", en: "On 4h market entries keep the stop at least 1 ATR away" },
        scope: "4h",
        facts: {
          bars_after_settlement: 12, hours_to_fill: 0, hours_to_settle: 8,
          from_signal: { max_favorable_r: 2.5, max_adverse_r: 1 },
          after: { first_touch: "tp1", reached_tp1: { at: "2026-08-22T12:00:00Z", bars: 4 }, reached_sl: null, beyond_sl_r: 0.2, returned_to_entry: true },
          abnormal_bar: null,
          counterfactual: {
            market_entry: null,
            stop_x1_5: { resolution: "win", reason: null, mfe_r: 2, mae_r: 1.1 },
            stop_x2: { resolution: "win", reason: null, mfe_r: 2, mae_r: 1.1 },
            tp_half: { resolution: "loss", reason: null, mfe_r: 0.4, mae_r: 1 },
          },
          regime: null,
          hints: ["stop_too_tight"],
        },
        created_at: "2026-08-23T00:00:00Z",
      },
    };
    render(<AnalysisHistory records={[...records, diagnosed]} />);
    // the cause is on the row and in the breakdown before the row is opened
    expect(screen.getByTestId("cause-breakdown")).toHaveTextContent("損切りが近すぎた ×1");

    fireEvent.click(screen.getAllByRole("button", { name: /EUR\/USD 4h.*SELL 65%/ })[1]);
    const pm = screen.getByTestId("postmortem");
    expect(pm).toHaveTextContent("なぜ外れたか（AIの検証）");
    expect(pm).toHaveTextContent("損切りが近すぎた");
    expect(pm).toHaveTextContent("指標・イベントの急変動");
    expect(pm).toHaveTextContent("方向は合っていたが損切りが近すぎた");
    expect(pm).toHaveTextContent("損切り後4本でTP1到達");
    expect(pm).toHaveTextContent("教訓:4h の成行では損切りを ATR×1.0 以上に置く");
    expect(pm).toHaveTextContent("損切りを2倍に広げていたらWIN");
    expect(pm).toHaveTextContent("利確を半分にしていたらLOSS");
    expect(pm).toHaveTextContent("損切りの 4 本後に TP1 へ到達");
    expect(pm).toHaveTextContent("分析時点の情報で回避できた");
    expect(pm).toHaveTextContent("診断の確度 80%");

    // the other settled loss has no diagnosis yet
    fireEvent.click(screen.getAllByRole("button", { name: /EUR\/USD 4h.*SELL 65%/ })[0]);
    expect(screen.getAllByTestId("postmortem")[0]).toHaveTextContent("原因分析は決着から数時間後に自動で行われます");
  });

  it("shows a refused plan under its WAIT row, with what the shadow copy then did", () => {
    const refused: AnalysisRecord = {
      ...records[2],
      id: "gate",
      confidence: 66,
      entry_check: {
        proposed_signal: "SELL", proposed_entry: 157.9, proposed_stop: 158.45, proposed_tp1: 157.05,
        entry_type: "limit", distance_atr: 0.31, stop_atr: 1.22, risk_reward: 1.55,
        rejection: "should_be_market", repair_rejection: "poor_rr", repaired: false, atr: 0.45,
      },
    };
    const shadow: AnalysisRecord = {
      ...records[3],
      id: "gate-shadow",
      shadow: true,
      shadow_of: "gate",
      outcome: "untriggered",
      evaluation: { ...evaluation, filled_at: null, resolution: "untriggered", reason: "missed" },
    };
    render(<AnalysisHistory records={[...records, refused, shadow]} />);
    // the shadow is not a row of its own, and the record counts the refusal
    expect(screen.getAllByRole("button", { name: /SELL 66%/ })).toHaveLength(1);
    expect(screen.getByTestId("gate-note")).toHaveTextContent("AIの提案 1件は「約定しない・割に合わない」としてサーバー側で却下");
    expect(screen.getByTestId("gate-note")).toHaveTextContent("未約定 1 / WIN 0 / LOSS 0 / 進行中 0");
    expect(screen.getByText("却下")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /WAIT 66%/ }));
    const gate = screen.getByTestId("gate-detail");
    expect(gate).toHaveTextContent("サーバー側で却下したプラン");
    expect(gate).toHaveTextContent("トレンド継続中に戻りを待つ指値（約定しない）");
    expect(gate).toHaveTextContent("157.900");
    expect(gate).toHaveTextContent("0.31 ATR");
    expect(gate).toHaveTextContent("1:1.55");
    expect(gate).toHaveTextContent("却下は正しかった");
    expect(screen.getByText("AIの提案はサーバー側で却下され、WAITとして公開されました")).toBeInTheDocument();
  });
});

describe("LearnedRules", () => {
  it("says so when nothing has been learned yet", () => {
    render(<LearnedRules rulebook={null} />);
    expect(screen.getByTestId("learned-rules")).toHaveTextContent("まだ学習したルールはありません");
    render(<LearnedRules rulebook={{ version: 0, rules: [], summary: null, updated_at: null }} />);
    expect(screen.getAllByText(/まだ学習したルールはありません/)).toHaveLength(2);
  });

  it("lists the rules with their evidence in the viewer's language, and folds the long tail", () => {
    const rules = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i + 1}`,
      text_ja: `ルール${i + 1}`,
      text_en: `Rule ${i + 1}`,
      cause: "stop_too_tight",
      support: 7 - i,
      scope: i === 0 ? "1h" : null,
      since: null,
      contract: CURRENT_CONTRACT,
    }));
    const rulebook = { version: 3, rules, summary: { ja: "損切りが近すぎる負けが多い", en: "Most losses come from tight stops" }, updated_at: "2026-09-03T09:00:00Z" };
    render(<LearnedRules rulebook={rulebook} />, "en");
    const panel = screen.getByTestId("learned-rules");
    expect(panel).toHaveTextContent("What the AI has learned");
    expect(panel).toHaveTextContent("v3");
    expect(panel).toHaveTextContent("Most losses come from tight stops");
    expect(panel).toHaveTextContent("[1h]Rule 1");
    expect(panel).toHaveTextContent("7 cases");
    expect(screen.queryByText("Rule 7")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show all \(7\)/ }));
    expect(screen.getByText("Rule 7")).toBeInTheDocument();
    expect(panel).toHaveTextContent("1 case");
    // The evidence count is every account's, and the panel has to say so:
    // the reader will not find those plans in their own history.
    expect(panel).toHaveTextContent(/learned from every account/i);
    expect(screen.queryByTestId("rules-held-back")).toBeNull();
  });

  it("holds back a rule written for a previous contract, and says how many", () => {
    // The prompt applies the same test (analyze/rules.ts inForce). Listing a
    // held-back rule beside the live ones would claim an influence it has not
    // had since the contract changed.
    const rulebook = {
      version: 5,
      rules: [
        { id: "r1", text_ja: "旧", text_en: "Old limit rule", cause: "entry_too_far", support: 28, scope: null, since: null, contract: "entry_chosen_v1" },
        { id: "r2", text_ja: "新", text_en: "Live rule", cause: "stop_too_tight", support: 4, scope: null, since: null, contract: CURRENT_CONTRACT },
      ],
      summary: null,
      updated_at: null,
    };
    render(<LearnedRules rulebook={rulebook} />, "en");
    const panel = screen.getByTestId("learned-rules");
    expect(panel).toHaveTextContent("Live rule");
    expect(panel).not.toHaveTextContent("Old limit rule");
    expect(screen.getByTestId("rules-held-back").textContent).toContain("1 rule");
  });

  it("says the book is empty for this contract rather than showing dead rules", () => {
    const rulebook = {
      version: 5,
      rules: [
        { id: "r1", text_ja: "旧", text_en: "Old limit rule", cause: "entry_too_far", support: 28, scope: null, since: null, contract: null },
      ],
      summary: null,
      updated_at: null,
    };
    render(<LearnedRules rulebook={rulebook} />, "en");
    const panel = screen.getByTestId("learned-rules");
    expect(panel).not.toHaveTextContent("Old limit rule");
    expect(panel).toHaveTextContent(/No rule is in force under the current contract/i);
  });

  it("renders nothing with no records", () => {
    const { container } = render(<AnalysisHistory records={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("AnalysisStages", () => {
  it("shows the five-stage stepper while active", () => {
    render(<AnalysisStages active />);
    for (const label of ["STRUCTURE", "LEVELS", "TREND", "PRICES", "PLAN"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders nothing when inactive", () => {
    const { container } = render(<AnalysisStages active={false} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("PriceChart level pills", () => {
  // Regression: the price axis and the level pills used to share one right-hand
  // lane, so a level near a gridline was drawn under its axis label.
  const tightResult: AnalysisResult = {
    ...fullResult,
    entry_point: "149.600",
    stop_loss: "149.580",
    take_profit_1: "149.620",
    take_profit_2: "149.640",
    take_profit_3: "149.660",
  };

  const readPills = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("text"))
      .filter((t) => /^(ENTRY|SL|TP\d) /.test(t.textContent ?? ""))
      .map((t) => ({ label: t.textContent!, y: Number(t.getAttribute("y")) }));

  it("keeps every pill legible when all five levels are nearly identical", () => {
    const { container } = render(
      <AnalysisResultView result={tightResult} techData={techData} pair="USD/JPY" interval="1h" />,
    );

    const pills = readPills(container).sort((a, b) => a.y - b.y);
    expect(pills).toHaveLength(5);

    // no two pills overlap vertically (15px tall)
    for (let i = 1; i < pills.length; i++) {
      expect(pills[i].y - pills[i - 1].y).toBeGreaterThanOrEqual(15);
    }
    // and none of them are pushed outside the plot
    for (const p of pills) {
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(300);
    }
  });

  it("draws pills clear of the price-axis labels", () => {
    const { container } = render(
      <AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />,
    );

    const xOf = (t: Element) => Number(t.getAttribute("x"));
    const texts = Array.from(container.querySelectorAll("text"));
    const pillX = texts.filter((t) => /^(ENTRY|SL|TP\d) /.test(t.textContent ?? "")).map(xOf);
    const axisX = texts.filter((t) => /^\d+\.\d+$/.test(t.textContent ?? "")).map(xOf);

    expect(pillX.length).toBeGreaterThan(0);
    expect(axisX.length).toBeGreaterThan(0);
    // every pill starts to the right of every axis label
    expect(Math.min(...pillX)).toBeGreaterThan(Math.max(...axisX));
  });

  it("shows the direction once — the gauge inside the hero is score-only", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    // getByText throws when there is more than one match, so this asserts
    // exactly one direction label and no second vocabulary for it
    expect(screen.getByText("LONG")).toBeInTheDocument();
    expect(screen.queryAllByText("BUY")).toHaveLength(0);
    // the gauge animates from 0, so assert the readout exists rather than its
    // instantaneous value
    expect(screen.getByText(/^\d+%$/)).toBeInTheDocument();
  });
});

describe("score cards", () => {
  // Regression: volatility replaced sentiment via a ternary on ATR, so on every
  // normal run (ATR always present) the model's sentiment was never displayed.
  it("shows sentiment and volatility together when indicators are present", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    expect(screen.getByText("センチメント")).toBeInTheDocument();
    expect(screen.getByText("強気")).toBeInTheDocument();
    expect(screen.getByText("ボラティリティ")).toBeInTheDocument();
  });

  it("still shows sentiment when there are no indicators", () => {
    render(<AnalysisResultView result={fullResult} techData={null} pair="USD/JPY" interval="1h" />);
    expect(screen.getByText("センチメント")).toBeInTheDocument();
    expect(screen.queryByText("ボラティリティ")).not.toBeInTheDocument();
  });
});

describe("localisation", () => {
  it("renders the same result in English", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />, "en");

    expect(screen.getByText("Trade plan")).toBeInTheDocument();
    expect(screen.getByText("Take profit 3")).toBeInTheDocument();
    expect(screen.getByText("Sentiment")).toBeInTheDocument();
    expect(screen.getByText("Bullish")).toBeInTheDocument();
    // and no Japanese chrome leaks through
    expect(screen.queryByText("トレードプラン")).not.toBeInTheDocument();
    expect(screen.queryByText("センチメント")).not.toBeInTheDocument();
  });

  it("shows the direction word and its plain-language gloss in both locales", () => {
    // Regression: the hero showed only "SHORT", which a reader took for a buy.
    const { unmount } = render(
      <AnalysisResultView result={{ ...fullResult, signal: "SELL" }} techData={techData} pair="USD/JPY" interval="1h" />,
    );
    expect(screen.getByText("SHORT")).toBeInTheDocument();
    expect(screen.getByText("売り")).toBeInTheDocument();
    unmount();

    render(
      <AnalysisResultView result={{ ...fullResult, signal: "SELL" }} techData={techData} pair="USD/JPY" interval="1h" />,
      "en",
    );
    expect(screen.getByText("SHORT")).toBeInTheDocument();
    expect(screen.getByText("Sell")).toBeInTheDocument();
  });

  it("never shows a BUY signal worded as SHORT, or vice versa", () => {
    const { unmount } = render(
      <AnalysisResultView result={{ ...fullResult, signal: "BUY" }} techData={techData} pair="USD/JPY" interval="1h" />,
    );
    expect(screen.getByText("LONG")).toBeInTheDocument();
    expect(screen.getByText("買い")).toBeInTheDocument();
    expect(screen.queryByText("SHORT")).not.toBeInTheDocument();
    expect(screen.queryByText("売り")).not.toBeInTheDocument();
    unmount();
  });
});

describe("AnalysisHistory across two entry contracts", () => {
  const base = {
    mode: "full", thesis: null, take_profit_2: null, take_profit_3: null,
    price_at_signal: null, evaluation: null,
  };
  const row = (over: Partial<AnalysisRecord>): AnalysisRecord => ({
    ...base, id: Math.random().toString(36).slice(2), pair: "USD/JPY", interval: "1h",
    signal: "BUY", confidence: 70, entry_point: 150, stop_loss: 149, take_profit_1: 152,
    outcome: "win", outcome_price: 152, created_at: "2026-09-01T00:00:00Z", closed_at: null,
    ...over,
  } as AnalysisRecord);

  it("says why no rate is shown instead of rendering blanks", () => {
    render(<AnalysisHistory records={[
      row({ outcome: "win" }),
      row({ outcome: "loss", plan_contract: "market_v1" }),
    ]} />);
    expect(screen.getByTestId("mixed-contracts")).toBeInTheDocument();
    // and no win rate is claimed over the pooled rows
    expect(screen.queryByTestId("win-rate")).toBeNull();
  });

  it("labels the old contract in the rulebook breakdown", () => {
    render(<AnalysisHistory records={[
      row({ outcome: "win", rulebook_version: 5 }),
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "ルール版" }));
    expect(screen.getByText("v5（旧契約）")).toBeInTheDocument();
  });

  // A verdict computed every fifteen minutes and shown to nobody is not a
  // verdict. WAIT is the one call that costs nothing to make, so the record
  // has to say out loud how often the market went on to refute it.
  const waitRow = (verdict: "missed" | "correct", over: Partial<AnalysisRecord> = {}) =>
    row({
      signal: "WAIT", outcome: "skipped", entry_point: null, stop_loss: null,
      take_profit_1: null, outcome_price: null, price_at_signal: 150,
      wait_check: {
        verdict, direction: "BUY", r: 1.2, at: "2026-09-01T09:00:00Z",
        price: 150, atr: 0.2, risk: 0.08, reward: 0.096,
        bars_examined: 40, horizon_ms: 48 * 3_600_000,
        checked_at: "2026-09-01T12:00:00Z",
      },
      ...over,
    });

  it("publishes how often standing aside was the wrong call", () => {
    render(<AnalysisHistory records={[
      waitRow("missed"), waitRow("correct"), waitRow("correct"), waitRow("correct"),
    ]} />);
    const strip = screen.getByTestId("wait-strip");
    expect(strip.textContent).toContain("判定済み 4件");
    expect(strip.textContent).toContain("1件（25%）");
  });

  it("says nothing about standing aside before anything has been judged", () => {
    render(<AnalysisHistory records={[row({ signal: "WAIT", outcome: "skipped" })]} />);
    expect(screen.queryByTestId("wait-strip")).toBeNull();
  });

  it("marks the row the market refuted and shows the trade it was judged on", () => {
    render(<AnalysisHistory records={[waitRow("missed")]} />);
    expect(screen.getByText("取れていた")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /WAIT/ }));
    const detail = screen.getByTestId("wait-detail");
    expect(detail.textContent).toContain("見送るべきではなかった");
    // the levels are shown so the judgement can be checked by hand
    expect(detail.textContent).toContain("検証したトレード");
    expect(detail.textContent).toContain("検証した足 40本");
  });

  it("does not claim a verdict on a WAIT the tracker has not reached one on", () => {
    render(<AnalysisHistory records={[waitRow("correct", {
      wait_check: {
        verdict: "pending", direction: null, r: null, at: null, price: 150, atr: 0.2,
        risk: null, reward: null, bars_examined: 4, horizon_ms: 48 * 3_600_000,
        checked_at: "2026-09-01T12:00:00Z",
      },
    })]} />);
    expect(screen.queryByText("取れていた")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /WAIT/ }));
    const detail = screen.getByTestId("wait-detail");
    expect(detail.textContent).toContain("検証期間が終わっていません");
    expect(detail.textContent).not.toContain("検証したトレード");
  });
});
