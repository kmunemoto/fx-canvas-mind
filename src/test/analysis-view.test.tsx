import { describe, it, expect } from "vitest";
import { fireEvent, render as rtlRender, screen, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import AnalysisResultView from "../components/AnalysisResultView";
import AnalysisHistory from "../components/AnalysisHistory";
import AnalysisStages from "../components/AnalysisStages";
import type { AnalysisRecord, AnalysisResult, OutcomeEvaluation, TechnicalData } from "../lib/types";

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

  it("shows the win rate over WIN/LOSS only, with a badge per outcome", () => {
    render(<AnalysisHistory records={records} />);
    expect(screen.getAllByText("勝率").length).toBeGreaterThan(0);
    expect(screen.getByText("50%")).toBeInTheDocument(); // 1 win / 1 loss; the no-fill row is excluded
    expect(screen.getByText("WIN")).toBeInTheDocument();
    expect(screen.getByText("LOSS")).toBeInTheDocument();
    expect(screen.getAllByText("未約定").length).toBeGreaterThan(0);
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
