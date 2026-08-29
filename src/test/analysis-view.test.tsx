import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AnalysisResultView from "../components/AnalysisResultView";
import AnalysisHistory from "../components/AnalysisHistory";
import AnalysisStages from "../components/AnalysisStages";
import type { AnalysisRecord, AnalysisResult, TechnicalData } from "../lib/types";

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
  const records: AnalysisRecord[] = [
    {
      id: "a", pair: "USD/JPY", interval: "1h", signal: "BUY", confidence: 72,
      thesis: null, entry_point: 150, stop_loss: 149, take_profit_1: 152,
      outcome: "win", outcome_price: 152, created_at: "2026-08-20T00:00:00Z", closed_at: "2026-08-21T00:00:00Z",
    },
    {
      id: "b", pair: "EUR/USD", interval: "4h", signal: "SELL", confidence: 65,
      thesis: null, entry_point: 1.1, stop_loss: 1.11, take_profit_1: 1.08,
      outcome: "loss", outcome_price: 1.11, created_at: "2026-08-22T00:00:00Z", closed_at: null,
    },
    {
      id: "c", pair: "USD/JPY", interval: "15min", signal: "WAIT", confidence: 40,
      thesis: null, entry_point: null, stop_loss: null, take_profit_1: null,
      outcome: "skipped", outcome_price: null, created_at: "2026-08-23T00:00:00Z", closed_at: null,
    },
  ];

  it("shows win rate over closed trades and outcome badges", () => {
    render(<AnalysisHistory records={records} />);
    expect(screen.getByText("勝率")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("WIN")).toBeInTheDocument();
    expect(screen.getByText("LOSS")).toBeInTheDocument();
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
