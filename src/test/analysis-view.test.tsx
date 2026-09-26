import { describe, it, expect, vi, afterEach } from "vitest";
import PriceChart from "../components/PriceChart";
import { fireEvent, render as rtlRender, screen, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import AnalysisResultView from "../components/AnalysisResultView";
import AnalysisHistory from "../components/AnalysisHistory";
import LearnedRules from "../components/LearnedRules";
import AnalysisStages from "../components/AnalysisStages";
import type {
  AnalysisRecord,
  AnalysisResult,
  BounceStat,
  ChartSignalMark,
  ChartTrendLine,
  EntryCheck,
  OutcomeEvaluation,
  RsiSarSummary,
  GainzSummary,
  TechnicalData,
  TfChart,
} from "../lib/types";
import { CURRENT_CONTRACT } from "../lib/outcomeStats";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";

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
  it("renders direction, thesis, plan and chart levels, with the market context folded", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);

    expect(screen.getByText("LONG")).toBeInTheDocument();
    expect(screen.getByText("流動性スイープ後の上方拡張")).toBeInTheDocument();
    expect(screen.getByText("利確 TP3")).toBeInTheDocument();
    expect(screen.getByText("152.600")).toBeInTheDocument();
    // level pills drawn into the SVG chart
    expect(screen.getByText(/ENTRY 150\.123/)).toBeInTheDocument();
    expect(screen.getByText(/SL 149\.500/)).toBeInTheDocument();
    expect(screen.getByText(/TP1 151\.200/)).toBeInTheDocument();

    // The context rows are reference, closed until asked for
    expect(screen.queryByText("Trend Day")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /相場環境と水準/ }));
    expect(screen.getByText("相場モード")).toBeInTheDocument();
    expect(screen.getByText("Trend Day")).toBeInTheDocument();
    expect(screen.getByText("ストップ狩りゾーン")).toBeInTheDocument();
  });

  it("puts the call before the plan, the plan before the evidence, and the folds last", () => {
    // fullResult's only warning is the disclaimer, so give it one real one
    const withWarning = { ...fullResult, warnings: [...fullResult.warnings, "指標発表が近い"] };
    const { container } = render(
      <AnalysisResultView result={withWarning} techData={techData} pair="USD/JPY" interval="1h" />,
    );
    const order = ["trade-plan", "evidence", "warnings", "detail", "market-context-disclosure"]
      .map((id) => container.querySelector(`[data-testid="${id}"]`))
      .map((el) => (el ? Array.from(container.querySelectorAll("*")).indexOf(el) : -1));
    const hero = Array.from(container.querySelectorAll("*")).indexOf(screen.getByText("LONG"));
    expect(order.every((i) => i > hero)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    // and the one glow left is the hero's
    expect(container.querySelectorAll(".border-glow")).toHaveLength(1);
  });

  it("shows the stop and first target as a distance, in pips and in ATR", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    // 150.123 − 149.500 = 62.3 pips = 1.4 × an ATR of 0.450
    expect(screen.getByTestId("stop-distance")).toHaveTextContent("62 pips・ATR 1.4倍");
    // 151.200 − 150.123 = 107.7 pips = 2.4 × ATR
    expect(screen.getByTestId("tp1-distance")).toHaveTextContent("108 pips・ATR 2.4倍");
  });

  it("says what the stop costs per 10,000 units, in the pair's quote currency (#111)", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    // 150.123 − 149.500 = 0.623 yen a unit
    expect(screen.getByTestId("stop-loss-10k")).toHaveTextContent("1万通貨で損切りなら ¥6,230 の損失");
  });

  it("gives the distance in pips alone when there is no ATR to scale by", () => {
    render(<AnalysisResultView result={fullResult} techData={null} pair="USD/JPY" interval="1h" />);
    expect(screen.getByTestId("stop-distance")).toHaveTextContent("62 pips");
    expect(screen.getByTestId("stop-distance")).not.toHaveTextContent("ATR");
  });

  it("shows three factors and folds the rest behind a count", () => {
    const many = { ...fullResult, key_factors: ["一", "二", "三", "四", "五"] };
    render(<AnalysisResultView result={many} techData={techData} pair="USD/JPY" interval="1h" />);
    expect(screen.getByText("三")).toBeInTheDocument();
    expect(screen.queryByText("四")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "すべて表示（5件）" }));
    expect(screen.getByText("五")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "折りたたむ" }));
    expect(screen.queryByText("五")).toBeNull();
  });

  it("shows no trade plan for a WAIT", () => {
    const wait: AnalysisResult = {
      ...fullResult, signal: "WAIT", entry_point: "—", stop_loss: "—",
      take_profit_1: "—", take_profit_2: "—", take_profit_3: "—", risk_reward_ratio: "—",
    };
    render(<AnalysisResultView result={wait} techData={techData} pair="USD/JPY" interval="1h" />);
    expect(screen.queryByTestId("trade-plan")).toBeNull();
    expect(screen.queryByTestId("position-size")).toBeNull();
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

    // a document written before the danger block existed renders no danger line
    expect(screen.queryByTestId("postmortem-danger")).toBeNull();

    // the other settled loss has no diagnosis yet
    fireEvent.click(screen.getAllByRole("button", { name: /EUR\/USD 4h.*SELL 65%/ })[0]);
    expect(screen.getAllByTestId("postmortem")[0]).toHaveTextContent("原因分析は決着から数時間後に自動で行われます");
  });

  it("says, one measurement per flag, what made a win an unsafe one", () => {
    const lucky: AnalysisRecord = {
      ...records[0],
      id: "lucky",
      postmortem: {
        schema: 2, status: "done", cause: "lucky_win", secondary_causes: [], avoidable: true, confidence: 70,
        verdict: { ja: "勝ったが損切り直前まで逆行した", en: "Won, but came within a hair of the stop" },
        evidence: { ja: [], en: [] },
        lesson: { ja: "ADX 20 未満では損切りを ATR×1.5 以上に置く", en: "Below ADX 20 keep the stop at least 1.5 ATR away" },
        scope: null,
        facts: {
          bars_after_settlement: 24, hours_to_fill: 0, hours_to_settle: 15,
          from_signal: { max_favorable_r: 3.1, max_adverse_r: 0.98 },
          after: { first_touch: null, reached_tp1: null, reached_sl: null, beyond_sl_r: null, returned_to_entry: false },
          abnormal_bar: null,
          counterfactual: { market_entry: null, stop_x1_5: null, stop_x2: null, tp_half: null },
          regime: null,
          danger: {
            bars_in_trade: 15, underwater_bars: 9, underwater_ratio: 0.6, longest_underwater_bars: 4, entry_crossings: 5,
            closest_to_stop_r: 0.02, target_bar_close_r: -0.6, reversed_after_r: 1.4, life_used_ratio: 0.8,
            flags: ["deep_mae", "mostly_underwater", "chop", "spike_target", "late_win"],
          },
          hints: ["lucky_win"],
        },
        created_at: "2026-08-23T00:00:00Z",
      },
    };
    render(<AnalysisHistory records={[...records, lucky]} />);
    fireEvent.click(screen.getAllByRole("button", { name: /USD\/JPY 1h.*BUY 72%/ })[1]);
    const danger = screen.getByTestId("postmortem-danger");
    expect(danger).toHaveTextContent("損切りまで残り 0.02R まで逆行");
    expect(danger).toHaveTextContent("保有 15 本のうち 9 本が含み損");
    expect(danger).toHaveTextContent("エントリー価格を 5 回またいだ");
    expect(danger).toHaveTextContent("利確はヒゲだけで、その後 1.4R 戻した");
    expect(danger).toHaveTextContent("期限の 80% を使って到達");
  });

  it("renders no danger line for a win the block measured and found nothing on", () => {
    const clean: AnalysisRecord = {
      ...records[0],
      id: "clean",
      postmortem: {
        schema: 2, status: "done", cause: "good_call", secondary_causes: [], avoidable: false, confidence: 80,
        verdict: { ja: "想定通りに伸びた", en: "Went as planned" },
        evidence: { ja: [], en: [] },
        lesson: { ja: "この形は再現性がある", en: "This shape repeats" },
        scope: null,
        facts: {
          bars_after_settlement: 24, hours_to_fill: 0, hours_to_settle: 3,
          from_signal: { max_favorable_r: 2.1, max_adverse_r: 0.2 },
          after: { first_touch: null, reached_tp1: null, reached_sl: null, beyond_sl_r: null, returned_to_entry: false },
          abnormal_bar: null,
          counterfactual: { market_entry: null, stop_x1_5: null, stop_x2: null, tp_half: null },
          regime: null,
          danger: null,
          hints: ["good_call"],
        },
        created_at: "2026-08-23T00:00:00Z",
      },
    };
    render(<AnalysisHistory records={[...records, clean]} />);
    fireEvent.click(screen.getAllByRole("button", { name: /USD\/JPY 1h.*BUY 72%/ })[1]);
    expect(screen.getByTestId("postmortem")).toHaveTextContent("想定通り");
    expect(screen.queryByTestId("postmortem-danger")).toBeNull();
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

  // The confidence floor writes rejection = 'low_confidence' on a WAIT the
  // model itself answered. While the badge and the count were decided by that
  // string alone, sixteen such rows told the user the server had overruled
  // sixteen plans; exactly one plan had ever been refused.
  it("does not call the model's own WAIT a server refusal", () => {
    const selfDeclined: AnalysisRecord = {
      ...records[2],
      id: "own-wait",
      confidence: 45,
      signal: "WAIT",
      outcome: "skipped",
      entry_check: {
        proposed_signal: "WAIT", proposed_entry: null, proposed_stop: null, proposed_tp1: null,
        entry_type: null, distance_atr: null, risk_reward: null,
        rejection: "low_confidence", atr: 0.4,
      },
    };
    render(<AnalysisHistory records={[...records, selfDeclined]} />);
    expect(screen.getByTestId("gate-note")).toHaveTextContent(
      "見送りのうち 1件は、AI自身の判断か RSI・SAR の条件待ちです（サーバーによる却下ではありません）",
    );
    expect(screen.getByTestId("gate-note")).not.toHaveTextContent("サーバー側で却下し");
    expect(screen.queryByText("却下")).toBeNull();
    expect(screen.getByText("AI見送り")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /WAIT 45%/ }));
    expect(screen.queryByTestId("gate-detail")).toBeNull();
    expect(screen.getByText("AI自身が見送ると判断しました（サーバーによる却下ではありません）")).toBeInTheDocument();
  });

  // #104: from v68 a WAIT is the RSI/SAR rule not firing. Calling that "AI
  // declined" would name a decision nobody made.
  it("labels a WAIT the RSI/SAR rule decided as waiting for the conditions", () => {
    const ruleWait: AnalysisRecord = {
      ...records[2],
      id: "rule-wait",
      confidence: 62,
      signal: "WAIT",
      outcome: "skipped",
      entry_check: {
        rule: "rsi14_30_70_psar_v1",
        model_signal: "WAIT",
        proposed_signal: "WAIT", proposed_entry: null, proposed_stop: null, proposed_tp1: null,
        entry_type: null, distance_atr: null, risk_reward: null,
        rejection: null, atr: 0.4,
      },
    };
    render(<AnalysisHistory records={[...records, ruleWait]} />);
    expect(screen.getByText("条件待ち")).toBeInTheDocument();
    expect(screen.queryByText("AI見送り")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /WAIT 62%/ }));
    expect(screen.getByText("RSI・SAR の条件がそろわなかったので WAIT です（サーバーによる却下ではありません）")).toBeInTheDocument();
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
    // The editor's own summary is behind a fold with a caption saying whose
    // voice it is — it is model prose with internal identifiers in it, and
    // it used to be the first paragraph under the rules.
    expect(panel).not.toHaveTextContent("Most losses come from tight stops");
    fireEvent.click(screen.getByRole("button", { name: /Editor's note/ }));
    expect(screen.getByTestId("editor-note")).toHaveTextContent("may use internal terms");
    expect(screen.getByTestId("editor-note")).toHaveTextContent("Most losses come from tight stops");
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

  it("marks a rule whose evidence predates the current contract, without holding it back", () => {
    // The two questions the panel must not conflate. A rule is SHOWN when the
    // analyst can carry it out (`contract`); it is MARKED when the record
    // behind it was gathered under a contract with different moves
    // (`evidence_contracts`). The live book is exactly this case: three rules
    // that are followable now, resting entirely on entry_chosen_v1 evidence.
    const rulebook = {
      version: 7,
      rules: [
        { id: "old", text_ja: "旧証拠", text_en: "Old evidence", cause: "direction_wrong", support: 2, scope: null, since: null, contract: CURRENT_CONTRACT, evidence_contracts: ["entry_chosen_v1"] },
        { id: "new", text_ja: "新証拠", text_en: "New evidence", cause: "direction_wrong", support: 2, scope: null, since: null, contract: CURRENT_CONTRACT, evidence_contracts: [CURRENT_CONTRACT] },
        { id: "none", text_ja: "証拠不明", text_en: "No era recorded", cause: "direction_wrong", support: 2, scope: null, since: null, contract: CURRENT_CONTRACT, evidence_contracts: [] },
      ],
      summary: null,
      updated_at: null,
    };
    render(<LearnedRules rulebook={rulebook} />, "en");
    // All three reach the list: the marker labels, it does not suppress
    expect(screen.getByText("Old evidence")).toBeInTheDocument();
    expect(screen.getByText("New evidence")).toBeInTheDocument();
    expect(screen.queryByTestId("rules-held-back")).toBeNull();
    // ...and only the mixed-era one is marked
    expect(screen.getAllByTestId("prior-evidence")).toHaveLength(1);
    expect(screen.getByTestId("learned-rules")).toHaveTextContent("incl. prior contract");
  });

  it("puts the badges under the rule text, not beside it", () => {
    // On a 390px phone two shrink-0 badges beside the text left the text a
    // third of the width — a few characters per line.
    const rulebook = {
      version: 7,
      rules: [
        { id: "old", text_ja: "旧証拠", text_en: "Old evidence", cause: "direction_wrong", support: 2, scope: null, since: null, contract: CURRENT_CONTRACT, evidence_contracts: ["entry_chosen_v1"] },
      ],
      summary: null,
      updated_at: null,
    };
    render(<LearnedRules rulebook={rulebook} />, "en");
    const text = screen.getByText("Old evidence");
    const badge = screen.getByTestId("prior-evidence");
    const badges = badge.parentElement!;
    expect(badges).toHaveAttribute("data-testid", "rule-badges");
    // the badge row is the text's next sibling in a column, and the text's
    // parent is not the row that holds the badges
    expect(text.nextElementSibling).toBe(badges);
    expect(badge.parentElement).not.toBe(text.parentElement);
    expect(text.closest("li")!.children).toHaveLength(2);
    expect(badges).toHaveTextContent("under review, 2 cases");
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

describe("the model's self-ratings", () => {
  // One quiet row of chips under the evidence, not five cards with bars: the
  // scores are the model rating itself and nothing calibrates them.
  it("shows all five in one row when indicators are present", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    const row = screen.getByTestId("self-ratings");
    expect(row).toHaveTextContent("テクニカル 78");
    expect(row).toHaveTextContent("ファンダ 55");
    expect(row).toHaveTextContent("リスク 中");
    expect(row).toHaveTextContent("強気");
    expect(row).toHaveTextContent("ボラ 中");
    expect(row.querySelectorAll(".glass")).toHaveLength(0);
  });

  // Regression: volatility replaced sentiment via a ternary on ATR, so on every
  // normal run (ATR always present) the model's sentiment was never displayed.
  it("still shows sentiment when there are no indicators", () => {
    render(<AnalysisResultView result={fullResult} techData={null} pair="USD/JPY" interval="1h" />);
    const row = screen.getByTestId("self-ratings");
    expect(row).toHaveTextContent("強気");
    expect(row).not.toHaveTextContent("ボラ");
  });
});

describe("#100 a plan refused for the hour it was priced in", () => {
  const wait: AnalysisResult = {
    ...fullResult, signal: "WAIT", confidence: 70, entry_point: "—", stop_loss: "—",
    take_profit_1: "—", take_profit_2: "—", take_profit_3: "—", risk_reward_ratio: "—",
    warnings: ["AIの判断は SELL でしたが、いまは日本時間 6時台（UTC 21時台）で…見送り（WAIT）に変更しました。", "この分析は参考情報です。投資判断は自己責任で行ってください"],
  };
  const check = (tf: "1h" | "1min"): EntryCheck => ({
    proposed_signal: "SELL", proposed_entry: 150.1, proposed_stop: 150.3, proposed_tp1: 149.8,
    entry_type: "market", distance_atr: 0, stop_atr: 0.8, risk_reward: 1.5,
    rejection: "costly_hours", atr: 0.25,
    costly_hours: tf === "1h"
      ? { hour_utc: 21, evidence: { measured: true, pair: "USD/JPY", period: "2025-07〜2026-09", inside: { buy: 0.275, sell: 0.237 }, outside: { buy: 0.398, sell: 0.356 } } }
      : { hour_utc: 20, evidence: { measured: false, pair: "USD/JPY", period: "2025-07〜2026-09", inside: null, outside: null } },
  });

  it("names the reason, the hour in JST and the refused side's measured rates", () => {
    render(<AnalysisResultView result={wait} techData={techData} pair="USD/JPY" interval="1h" entryCheck={check("1h")} analysisMode="full" />);
    expect(screen.getByTestId("wait-reason")).toHaveTextContent("スプレッドが開く日替わり前後の時間帯だった");
    // the SELL side's numbers, not the BUY side's
    expect(screen.getByTestId("wait-reason-measured")).toHaveTextContent("日本時間 6時台・この時間帯の勝率 24%／ほか 36%");
  });

  it("gives only the hour where the timeframe was not measured", () => {
    render(<AnalysisResultView result={wait} techData={techData} pair="USD/JPY" interval="1min" entryCheck={check("1min")} analysisMode="full" />);
    expect(screen.getByTestId("wait-reason-measured")).toHaveTextContent("日本時間 5時台");
    expect(screen.getByTestId("wait-reason-measured")).not.toHaveTextContent("勝率");
  });
});

describe("why a WAIT is a WAIT", () => {
  const wait: AnalysisResult = {
    ...fullResult, signal: "WAIT", confidence: 66, entry_point: "—", stop_loss: "—",
    take_profit_1: "—", take_profit_2: "—", take_profit_3: "—", risk_reward_ratio: "—",
    warnings: [
      "AIの判断は SELL でしたが、損切りが現在値に近すぎ（ATRの0.4倍）、ノイズで刈られる可能性が高いため見送り（WAIT）に変更しました",
      "指標発表が近い",
      "この分析は参考情報です。投資判断は自己責任で行ってください",
    ],
  };
  const refused: EntryCheck = {
    proposed_signal: "SELL", proposed_entry: 150.1, proposed_stop: 150.3, proposed_tp1: 149.5,
    entry_type: "market", distance_atr: 0, stop_atr: 0.4, risk_reward: 3,
    rejection: "stop_too_tight", atr: 0.45,
  };

  it("says the reason under the signal, from entry_check, and drops the server's sentence from the warnings", () => {
    render(<AnalysisResultView result={wait} techData={techData} pair="USD/JPY" interval="1h" entryCheck={refused} analysisMode="full" />);
    const reason = screen.getByTestId("wait-reason");
    expect(reason).toHaveTextContent("見送りの理由");
    expect(reason).toHaveTextContent("損切りが近すぎる（ノイズで刈られる）");
    // The measured number the dropped server sentence used to carry
    expect(screen.getByTestId("wait-reason-measured")).toHaveTextContent("ATR 0.4倍");
    expect(reason).toHaveTextContent("SHORT（売り）の提案はサーバー側で却下され");
    // Said once: the direction line and the summary were two sentences both
    // beginning "AIの提案"
    expect(reason.textContent?.match(/AIの提案/g) ?? []).toHaveLength(0);

    const warnings = screen.getByTestId("warnings");
    expect(warnings).toHaveTextContent("指標発表が近い");
    expect(warnings).not.toHaveTextContent("見送り（WAIT）に変更");
  });

  it("finds the server's sentence behind the news-fallback sentence too", () => {
    const fallback = { ...wait, warnings: ["ニュース検索が利用できなかったため、テクニカルのみで判断しています", ...wait.warnings] };
    render(<AnalysisResultView result={fallback} techData={techData} pair="USD/JPY" interval="1h" entryCheck={refused} analysisMode="technical_fallback" />);
    const warnings = screen.getByTestId("warnings");
    expect(warnings).toHaveTextContent("ニュース検索が利用できなかった");
    expect(warnings).toHaveTextContent("指標発表が近い");
    expect(warnings).not.toHaveTextContent("見送り（WAIT）に変更");
  });

  it("does not call the model's own WAIT a refusal, and says so once", () => {
    const own: EntryCheck = { ...refused, proposed_signal: "WAIT", rejection: "low_confidence", confidence: 45, confidence_floor: 60 };
    const ownWait = { ...wait, warnings: ["AI自身の判断が見送り（WAIT）で、確信度45が公開の下限60に届きませんでした。", ...wait.warnings.slice(1)] };
    render(<AnalysisResultView result={ownWait} techData={techData} pair="USD/JPY" interval="1h" entryCheck={own} analysisMode="full" />);
    const reason = screen.getByTestId("wait-reason");
    expect(reason).toHaveTextContent("AI自身の確信度が公開の下限に届かなかった");
    expect(screen.getByTestId("wait-reason-measured")).toHaveTextContent("確信度 45／下限 60");
    expect(reason).not.toHaveTextContent("却下");
    // One line, not the sentence and then a summary of the same sentence
    expect(reason.querySelectorAll("p")).toHaveLength(1);
    expect(screen.getByTestId("warnings")).not.toHaveTextContent("AI自身の判断が見送り");
  });

  it("leaves a model WAIT on a shut market to the preview banner, and still drops the server's sentence", () => {
    const own: EntryCheck = { ...refused, proposed_signal: "WAIT", rejection: "market_closed" };
    const shut = { ...wait, warnings: ["為替市場が閉まっているため、見送り（WAIT）にしました。プランは「今の値段で入る」前提で、その値段が存在しないので、エントリー・損切り・利確は出していません。", ...wait.warnings.slice(1)] };
    render(<AnalysisResultView result={shut} techData={techData} pair="USD/JPY" interval="1h" entryCheck={own} analysisMode="full" />);
    expect(screen.queryByTestId("wait-reason")).toBeNull();
    const warnings = screen.getByTestId("warnings");
    expect(warnings).toHaveTextContent("指標発表が近い");
    expect(warnings).not.toHaveTextContent("為替市場が閉まっている");
  });

  it("still names the direction the model wanted when the market refused it by being shut", () => {
    const shutRefusal: EntryCheck = { ...refused, rejection: "market_closed" };
    render(<AnalysisResultView result={wait} techData={techData} pair="USD/JPY" interval="1h" entryCheck={shutRefusal} analysisMode="full" />);
    const reason = screen.getByTestId("wait-reason");
    expect(reason).toHaveTextContent("市場が閉まっていた");
    expect(reason).toHaveTextContent("SHORT（売り）の提案は");
  });

  it("shows no reason, and keeps every warning, when entry_check names none", () => {
    render(<AnalysisResultView result={wait} techData={techData} pair="USD/JPY" interval="1h" entryCheck={null} />);
    expect(screen.queryByTestId("wait-reason")).toBeNull();
    // The sentence is not dropped on a guess about its shape
    expect(screen.getByTestId("warnings")).toHaveTextContent("見送り（WAIT）に変更");
  });

  it("reads in English", () => {
    render(<AnalysisResultView result={wait} techData={techData} pair="USD/JPY" interval="1h" entryCheck={refused} />, "en");
    const reason = screen.getByTestId("wait-reason");
    expect(reason).toHaveTextContent("Why it is a WAIT");
    expect(reason).toHaveTextContent("Stop inside the noise");
    expect(reason).toHaveTextContent("0.4× ATR");
    expect(reason).toHaveTextContent("The model's SHORT (Sell) was refused server-side");
    expect(reason.textContent).not.toMatch(/[ぁ-んァ-ン一-龥]/);
    // The full-width parentheses are Japanese punctuation, which the kana
    // check above does not see
    expect(reason.textContent).not.toMatch(/[（）]/);
  });
});

describe("the disclaimer", () => {
  // The footer carries it on every page; in the warnings box it was the first
  // line of every result.
  it("is not repeated in the warnings, in either language", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    // fullResult's only warning IS the disclaimer, so the box does not render
    expect(screen.queryByTestId("warnings")).toBeNull();
    expect(screen.queryByText(/自己責任/)).toBeNull();

    const english = {
      ...fullResult,
      warnings: ["Thin liquidity into the London open.", "This analysis is reference information. Trading decisions are your own responsibility."],
    };
    render(<AnalysisResultView result={english} techData={techData} pair="USD/JPY" interval="1h" />, "en");
    const box = screen.getByTestId("warnings");
    expect(box).toHaveTextContent("Thin liquidity");
    expect(box).not.toHaveTextContent(/your own responsibility/i);
  });
});

describe("market context labels", () => {
  // They were English literals: "Market Mode", "Smart Money", "Stop Hunt
  // Zone" in the middle of a Japanese screen.
  it("come from the dictionary in both locales", () => {
    const { unmount } = render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    fireEvent.click(screen.getByRole("button", { name: /相場環境と水準/ }));
    const jaPanel = screen.getByTestId("market-context");
    for (const label of Object.values(ja.context)) expect(jaPanel).toHaveTextContent(label);
    expect(jaPanel).not.toHaveTextContent("Market Mode");
    expect(jaPanel).not.toHaveTextContent("Smart Money");
    expect(jaPanel).not.toHaveTextContent("Stop Hunt Zone");
    unmount();

    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />, "en");
    fireEvent.click(screen.getByRole("button", { name: /Market context and levels/ }));
    const enPanel = screen.getByTestId("market-context");
    for (const label of Object.values(en.context)) expect(enPanel).toHaveTextContent(label);
    // The summary is the model's own prose, written in the locale of the
    // request; everything around it is chrome and must be English
    const chrome = (enPanel.textContent ?? "").replace(fullResult.market_context, "");
    expect(chrome).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });
});

describe("localisation", () => {
  it("renders the same result in English", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />, "en");

    expect(screen.getByText("Trade plan")).toBeInTheDocument();
    expect(screen.getByText("Take profit 3")).toBeInTheDocument();
    expect(screen.getByText("Model's self-ratings")).toBeInTheDocument();
    expect(screen.getByText("Bullish")).toBeInTheDocument();
    expect(screen.getByTestId("stop-distance")).toHaveTextContent("62 pips · 1.4× ATR");
    // and no Japanese chrome leaks through
    expect(screen.queryByText("トレードプラン")).not.toBeInTheDocument();
    expect(screen.queryByText("AIの自己評価")).not.toBeInTheDocument();
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
        checked_at: "2026-09-01T12:00:00Z", scorer: 2,
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
        checked_at: "2026-09-01T12:00:00Z", scorer: 2,
      },
    })]} />);
    expect(screen.queryByText("取れていた")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /WAIT/ }));
    const detail = screen.getByTestId("wait-detail");
    expect(detail.textContent).toContain("検証期間が終わっていません");
    expect(detail.textContent).not.toContain("検証したトレード");
  });
});

// Two populations on one screen: the statistics are the whole record, the
// list is the last 40 rows. Before this they were the same forty rows, which
// is why `clusters` could never reach its target of 50 and the P&L total
// could fall after a winning trade.
describe("AnalysisHistory draws the record from the server when it has one", () => {
  const one = (): AnalysisRecord => ({
    id: "srv-1", pair: "USD/JPY", interval: "1h", mode: "full",
    signal: "BUY", confidence: 70, entry_point: 150, stop_loss: 149,
    take_profit_1: 152, take_profit_2: null, take_profit_3: null,
    outcome: "win", outcome_price: 152, price_at_signal: 150,
    created_at: "2026-09-01T00:00:00Z", closed_at: "2026-09-01T06:00:00Z",
    plan_contract: "market_v1",
  } as AnalysisRecord);
  const group = {
    calls: 21, waits: 3, rejected: 0, waits_judged: 0, waits_missed: 0,
    total: 18, wins: 2, losses: 8, expired: 0, open: 1, untriggered: 7,
    ambiguous: 0, incoherent: 0, filled: 10, settled: 17, decided: 10,
    with_r: 10, clusters: 3, contracts: ["market_v1"],
    win_rate: 20, win_rate_ci95: [6, 51] as [number, number], fill_rate: 59,
    sum_r: -4.74, expectancy: -0.47, trades_per_call: 0.86, verdict_rate: 48,
    wait_rate: 14, expired_rate: 0, untriggered_rate: 33, ambiguous_rate: 0,
    incoherent_rate: 0, open_rate: 5, wait_miss_rate: null, below_min_n: true,
  };
  const stats = {
    generated_at: "2026-09-05T18:00:00Z",
    live_contract: "market_v1",
    scopes: { all_time: group },
    by_rulebook_version: {}, by_confidence: {}, by_timeframe: {}, by_mode: {},
    by_contract: { market_v1: group },
    other_contract_rows: 0, other_contracts: [],
    shadow: { total: 0, untriggered: 0, wins: 0, losses: 0, open: 0, other: 0 },
  };

  it("shows the whole record, not the rows it happens to hold", () => {
    render(<AnalysisHistory records={[one()]} stats={stats} />);
    // one row on screen, twenty-one calls in the record
    expect(screen.getByTestId("win-rate").textContent).toBe("20%");
    expect(screen.getByTestId("record-strip").textContent).toContain("3");
    expect(screen.getByTestId("stats-scope").textContent).toContain("21");
  });

  it("says which population each half of the panel is", () => {
    render(<AnalysisHistory records={[one()]} stats={stats} />);
    const scopeLabel = screen.getByTestId("stats-scope").textContent ?? "";
    expect(scopeLabel).toContain("全期間");
    // and the list keeps its own, different label
    expect(screen.getByText(/直近/)).toBeInTheDocument();
  });

  it("falls back to the rows on screen when the server did not answer", () => {
    render(<AnalysisHistory records={[one()]} />);
    expect(screen.getByTestId("stats-scope").textContent).toContain("直近");
  });
});


// The chart was a trade-plan chart: entry, stop, targets and nothing else.
// Every level the judgement rested on — the swings, the level a close settled
// through, the cloud — existed only as prose, so a reader could not check a
// claim against the picture.
describe("PriceChart draws the evidence, in two registers", () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    datetime: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000).toISOString(),
    open: 150, high: 150.4, low: 149.6, close: 150.1,
  }));

  it("separates what was measured from what was merely named", () => {
    render(
      <PriceChart
        candles={candles}
        pair="USD/JPY"
        entry="150.1"
        stopLoss="149.7"
        overlays={[
          { label: "H 8本前", value: 150.35, register: "computed" },
          { label: "150.30", value: 150.3, register: "cited" },
        ]}
      />,
    );
    const svg = document.querySelector("svg[role='img']");
    expect(svg?.textContent).toContain("H 8本前");
    // the model-named one carries its mark; the measured one does not
    expect(svg?.textContent).toContain("(AI)");
    expect(screen.getByTestId("chart-legend").textContent).toContain("破線");
  });

  it("does not let a distant level flatten the candles", () => {
    // Widening the price domain to fit an overlay would stretch the scale
    // until every candle was a flat line — the overlay would have made the
    // chart worse at the one job it already did.
    render(
      <PriceChart
        candles={candles}
        pair="USD/JPY"
        overlays={[{ label: "far", value: 900, register: "computed" }]}
      />,
    );
    const svg = document.querySelector("svg[role='img']");
    expect(svg?.textContent).not.toContain("far");
    // and it says how many it could not draw rather than dropping them silently
    expect(screen.getByTestId("chart-legend").textContent).toContain("表示範囲の外に 1件");
  });

  it("says nothing about registers when there is nothing in them", () => {
    render(<PriceChart candles={candles} pair="USD/JPY" entry="150.1" />);
    expect(screen.queryByTestId("chart-legend")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The same-direction losing run on the plan card (2026-09-19).
// ---------------------------------------------------------------------------
describe("the plan card shows the reader's own losing run in this direction", () => {
  const streak = (direction: "BUY" | "SELL", losses: number) =>
    ({ direction, losses, from: "2026-09-09T13:00:00Z", to: "2026-09-15T13:52:00Z" });

  it("says so, in the plan's direction, once the run is long enough", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" streak={streak("BUY", 9)} />);
    const strip = screen.getByTestId("direction-streak");
    expect(strip.textContent).toContain("9");
    expect(strip.textContent).toContain(ja.direction.BUY.word);
    expect(strip.textContent).toContain(ja.result.streak.note);
  });

  it("stays silent for the other direction, for a short run, and on a WAIT", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" streak={streak("SELL", 9)} />);
    expect(screen.queryByTestId("direction-streak")).toBeNull();
  });

  it("is silent for a run of two", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" streak={streak("BUY", 2)} />);
    expect(screen.queryByTestId("direction-streak")).toBeNull();
  });

  it("is silent on a WAIT even with a long run", () => {
    render(<AnalysisResultView result={{ ...fullResult, signal: "WAIT" }} techData={techData} pair="USD/JPY" interval="1h" streak={streak("BUY", 9)} />);
    expect(screen.queryByTestId("direction-streak")).toBeNull();
  });

  it("the history card carries the same run over the record", () => {
    const rows: AnalysisRecord[] = [1, 2, 3].map((d) => ({
      id: `s${d}`, pair: "USD/JPY", interval: "1h", mode: "full", signal: "SELL", confidence: 65, thesis: null,
      entry_point: 153, stop_loss: 153.5, take_profit_1: 152.5, take_profit_2: null, take_profit_3: null,
      price_at_signal: 153, outcome: "loss", outcome_price: 153.5, created_at: `2026-09-1${d}T00:00:00Z`, closed_at: null,
      evaluation: null, plan_contract: CURRENT_CONTRACT,
    }));
    render(<AnalysisHistory records={rows} />);
    expect(screen.getByTestId("history-streak").textContent).toContain("3");
  });
});

describe("the counter-case card (#96)", () => {
  const withCase: AnalysisResult = {
    ...fullResult,
    counter_case: {
      direction: "SELL",
      thesis: "上値余地が 0.4ATR しかない",
      evidence: ["RSI 71.2 は極値", "上抜け 151.50 は終値で戻された"],
      trigger: "151.20 を終値で割る",
    },
  };

  it("shows the other side's case under the evidence, with the direction it argues for", () => {
    render(<AnalysisResultView result={withCase} techData={techData} pair="USD/JPY" interval="1h" />);
    const card = screen.getByTestId("counter-case");
    expect(card.textContent).toContain(ja.result.counterCase.title);
    expect(card.textContent).toContain(ja.direction.SELL.word);
    expect(card.textContent).toContain("上値余地が 0.4ATR しかない");
    expect(card.textContent).toContain("RSI 71.2 は極値");
    expect(screen.getByTestId("counter-case-trigger").textContent).toContain("151.20 を終値で割る");
    expect(card.textContent).toContain(ja.result.counterCase.note);
  });

  it("reads the dictionary in English too", () => {
    render(<AnalysisResultView result={withCase} techData={techData} pair="USD/JPY" interval="1h" />, "en");
    const card = screen.getByTestId("counter-case");
    expect(card.textContent).toContain(en.result.counterCase.title);
    expect(card.textContent).toContain(en.direction.SELL.word);
    expect(card.textContent).toContain(en.result.counterCase.trigger);
  });

  it("renders nothing for a row without one, and nothing for an empty trigger", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    expect(screen.queryByTestId("counter-case")).toBeNull();
  });
});

// #98. A one-minute plan's entry is the price at the moment the market data
// was read; the result is saved a median 54 s later. On this frame that is
// most of a bar, so the card says it in seconds.
describe("the one-minute price staleness line", () => {
  const pricedAt = "2026-09-24T12:54:10.000Z"; // 21:54:10 JST
  const check = { proposed_signal: "BUY", priced_at: pricedAt } as unknown as EntryCheck;
  afterEach(() => vi.useRealTimers());

  it("says when the price was read and how many seconds ago, on a 1min plan", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(pricedAt) + 53_000));
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1min" entryCheck={check} />);
    const line = screen.getByTestId("price-staleness");
    expect(line.textContent).toContain("21:54:10");
    expect(line.textContent).toContain("約53秒前");
  });

  it("is not shown on any other frame, nor on a WAIT", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(pricedAt) + 53_000));
    const { unmount } = render(
      <AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" entryCheck={check} />,
    );
    expect(screen.queryByTestId("price-staleness")).toBeNull();
    unmount();
    render(
      <AnalysisResultView result={{ ...fullResult, signal: "WAIT" }} techData={techData} pair="USD/JPY" interval="1min" entryCheck={check} />,
    );
    expect(screen.queryByTestId("price-staleness")).toBeNull();
  });

  it("reads the dictionary in English too", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(pricedAt) + 53_000));
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1min" entryCheck={check} />, "en");
    expect(screen.getByTestId("price-staleness").textContent).toContain("about 53s before");
  });
});

describe("the chart's signals and the RSI/SAR panel (#99, #104)", () => {
  const hourly = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      datetime: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      open: 150,
      high: 150.4,
      low: 149.6,
      close: 150.1,
    }));
  const candles = hourly(60);
  const mark = (i: number, side: "BUY" | "SELL", outcome: ChartSignalMark["outcome"], rule = "level_reject"): ChartSignalMark => ({
    datetime: candles[i].datetime,
    barsAgo: candles.length - 1 - i,
    side,
    rule,
    level: 149.6,
    entry: 150.1,
    stop: 149.5,
    target: 151.0,
    stop_atr: 0.8,
    outcome,
    bars: outcome === "open" ? null : 3,
    mfe_r: 1.2,
  });
  const line: ChartTrendLine = {
    kind: "lows",
    from: { datetime: candles[10].datetime, barsAgo: 49, price: 149.6 },
    to: { datetime: candles[30].datetime, barsAgo: 29, price: 149.7 },
    slope_per_bar: 0.005,
    now: 149.845,
  };
  const stat = (rule: string, side: "BUY" | "SELL", wins: number, losses: number, extra: Partial<BounceStat> = {}): BounceStat => ({
    rule,
    side,
    n: wins + losses,
    wins,
    losses,
    ambiguous: 0,
    expired: 0,
    open: 0,
    untradable: 0,
    rate: wins + losses > 0 ? wins / (wins + losses) : null,
    lo: wins + losses > 0 ? 0.354 : null,
    hi: wins + losses > 0 ? 0.879 : null,
    expectancy_r: 0.67,
    avg_bars: 3,
    ...extra,
  });
  const charts: TfChart[] = [
    {
      tf: "1h", ok: true, bars: 480, rr: 1.5, horizon: 48, candles,
      marks: [mark(20, "BUY", "win")],
      recent: [mark(58, "BUY", "open")],
      lines: [line],
      stats: [stat("level_reject", "BUY", 6, 3), stat("band_reentry", "SELL", 0, 0, { untradable: 2 })],
    },
    { tf: "4h", ok: true, bars: 400, rr: 1.5, horizon: 48, candles: hourly(40), marks: [], recent: [], lines: [], stats: [] },
    { tf: "1day", ok: false, reason: "too_few_bars:30", bars: 30, candles: hourly(30), marks: [], recent: [], lines: [], stats: [] },
  ];

  it("draws a flag on the bar each condition fired on, and the line through the last two swings", () => {
    render(
      <PriceChart
        candles={candles}
        pair="USD/JPY"
        marks={[mark(20, "BUY", "win"), mark(40, "SELL", "loss"), { ...mark(0, "BUY", "open"), datetime: "2020-01-01 00:00:00" }]}
        lines={[line]}
      />,
    );
    expect(screen.getByTestId("chart-signal-BUY-win")).toBeInTheDocument();
    expect(screen.getByTestId("chart-signal-SELL-loss")).toBeInTheDocument();
    // a mark whose bar is not on this chart is not drawn anywhere
    expect(screen.queryByTestId("chart-signal-BUY-open")).toBeNull();
    expect(screen.getByTestId("chart-trend-lows")).toBeInTheDocument();
    expect(screen.getByTestId("chart-signal-legend").textContent).toContain("RSI が30/70から戻り");
    const svg = document.querySelector("svg[role='img']");
    expect(svg?.textContent).toContain("BUY✓");
    expect(svg?.textContent).toContain("SELL✗");
    expect(svg?.textContent).toContain("安値線");
    // #104: the reference indicator's TP/SL box beside the label
    const boxes = screen.getAllByTestId("chart-signal-levels");
    expect(boxes.length).toBe(2);
    expect(boxes[0].textContent).toContain("TP: 151.000");
    expect(boxes[0].textContent).toContain("SL: 149.500");
  });

  it("#112: draws the GA-style signal as its own outlined flag, even on a bar RSI/SAR fired on too", () => {
    render(
      <PriceChart
        candles={candles}
        pair="USD/JPY"
        marks={[mark(20, "BUY", "win", "rsi_sar"), mark(20, "BUY", "loss", "gainz"), mark(40, "SELL", "open", "gainz")]}
      />,
    );
    const flags = document.querySelectorAll("[data-rule]");
    expect([...flags].map((f) => f.getAttribute("data-rule"))).toEqual(["rsi_sar", "gainz", "gainz"]);
    const svg = document.querySelector("svg[role='img']");
    expect(svg?.textContent).toContain("BUY✓");
    expect(svg?.textContent).toContain("GA BUY✗");
    expect(svg?.textContent).toContain("GA SELL");
    expect(screen.getByTestId("chart-gainz-legend").textContent).toContain("GA型サイン");
  });

  it("says nothing about GA when no GA signal is on the chart", () => {
    render(<PriceChart candles={candles} pair="USD/JPY" marks={[mark(20, "BUY", "win", "rsi_sar")]} />);
    expect(screen.queryByTestId("chart-gainz-legend")).toBeNull();
  });

  it("puts the TP/SL box on the newest three signals only (#104)", () => {
    render(
      <PriceChart
        candles={candles}
        pair="USD/JPY"
        marks={[mark(5, "BUY", "win"), mark(15, "SELL", "loss"), mark(25, "BUY", "loss"), mark(35, "SELL", "win"), mark(45, "BUY", "win")]}
      />,
    );
    expect(screen.getAllByTestId("chart-signal-levels")).toHaveLength(3);
  });

  it("does not print two signals' levels on top of each other (#104)", () => {
    // two BUYs two bars apart: their boxes would overlap, so only the newer
    // one is drawn; the older keeps its label and its tooltip
    render(<PriceChart candles={candles} pair="USD/JPY" marks={[mark(50, "BUY", "loss"), mark(52, "BUY", "win")]} />);
    expect(screen.getAllByTestId("chart-signal-levels")).toHaveLength(1);
    expect(screen.getByTestId("chart-signal-BUY-loss").textContent).toContain("BUY✗");
    expect(screen.getByTestId("chart-signal-BUY-loss").querySelector("title")?.textContent).toContain("TP 151.000");
  });

  it("#115: keeps each label inside the plot and off the others, even two signals pushed to the top edge", () => {
    // bars 30 and 31 make the high of the window: both SELL labels are
    // pushed against the top of the plot
    const spiky = candles.map((c, i) => (i === 30 || i === 31 ? { ...c, high: 151.5 } : c));
    const at = (i: number, side: "BUY" | "SELL") => ({ ...mark(i, side, "win"), datetime: spiky[i].datetime });
    render(<PriceChart candles={spiky} pair="USD/JPY" marks={[at(0, "BUY"), at(30, "SELL"), at(31, "SELL")]} />);
    const labels = [...document.querySelectorAll("g[data-rule] > rect")].map((r) => ({
      left: Number(r.getAttribute("x")),
      top: Number(r.getAttribute("y")),
      w: Number(r.getAttribute("width")),
      h: Number(r.getAttribute("height")),
    }));
    expect(labels).toHaveLength(3);
    // the first bar's label is not cut off at the left edge
    expect(labels[0].left).toBeGreaterThanOrEqual(8);
    const [a, b] = [labels[1], labels[2]];
    const overlap = a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;
    expect(overlap).toBe(false);
  });

  it("#115: draws positions, the signal lines and the SAR band only when asked, and the band in place of the dots", () => {
    const sar = candles.map((_, i) => (i < 2 ? null : i % 7 < 4 ? 149.3 : 150.7));
    const sarBelow = candles.map((_, i) => (i < 2 ? null : i % 7 < 4));
    const marks = [mark(20, "BUY", "win"), mark(40, "SELL", "loss")];
    const { unmount } = render(<PriceChart candles={candles} pair="USD/JPY" marks={marks} sar={sar} sarBelow={sarBelow} />);
    expect(screen.queryByTestId("chart-cloud")).toBeNull();
    expect(screen.queryAllByTestId(/^chart-position-/)).toHaveLength(0);
    expect(screen.queryAllByTestId("chart-signal-line")).toHaveLength(0);
    unmount();
    render(<PriceChart candles={candles} pair="USD/JPY" marks={marks} sar={sar} sarBelow={sarBelow} positions sarStyle="cloud" />);
    // one piece of band per run of bars on one side: 2–3, then every 7 bars
    expect(screen.getByTestId("chart-cloud").querySelectorAll("polygon").length).toBe(17);
    expect(screen.getByTestId("chart-cloud").querySelectorAll("g[data-side='below']").length).toBe(9);
    expect(screen.queryByTestId("chart-sar")).toBeNull();
    expect(screen.getByTestId("chart-position-BUY-win")).toBeInTheDocument();
    expect(screen.getByTestId("chart-position-SELL-loss")).toBeInTheDocument();
    expect(screen.getByTestId("chart-exit-loss").textContent).toBe("SL");
    expect(screen.getAllByTestId("chart-signal-line")).toHaveLength(2);
    expect(screen.getByTestId("chart-position-legend").textContent).toContain("帯=パラボリックSAR");
  });

  it("draws the SAR as dots and RSI in its own strip, only when they line up with the candles (#104)", () => {
    const sar = candles.map((_, i) => (i < 2 ? null : i % 7 < 4 ? 149.3 : 150.7));
    const sarBelow = candles.map((_, i) => (i < 2 ? null : i % 7 < 4));
    const rsi = candles.map((_, i) => (i < 14 ? null : 30 + (i % 40)));
    const { unmount } = render(<PriceChart candles={candles} pair="USD/JPY" sar={sar} sarBelow={sarBelow} rsi={rsi} />);
    expect(screen.getByTestId("chart-sar").querySelectorAll("circle")).toHaveLength(58);
    const strip = screen.getByTestId("chart-rsi");
    expect(strip.textContent).toContain("RSI(14)");
    expect(strip.textContent).toContain("70");
    expect(strip.textContent).toContain("30");
    // a legend is shown for the dots even with no signal on screen
    expect(screen.getByTestId("chart-signal-legend").textContent).toContain("パラボリックSAR");
    unmount();
    render(<PriceChart candles={candles} pair="USD/JPY" sar={sar.slice(1)} rsi={rsi.slice(1)} />);
    expect(screen.queryByTestId("chart-sar")).toBeNull();
    expect(screen.queryByTestId("chart-rsi")).toBeNull();
  });

  it("says nothing about signals when there are none", () => {
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-signal-legend")).toBeNull();
  });

  // #104: the analysis itself — RSI and SAR now, and on a WAIT the price the
  // next close has to reach on each side.
  const summary = (over: Partial<RsiSarSummary> = {}): RsiSarSummary => ({
    tf: "1h",
    rule: "rsi14_30_70_psar_v1",
    ok: true,
    reason: null,
    bars: 470,
    stop_atr: 0.8,
    reward_ratio: 1.5,
    horizon: 48,
    now: { datetime: "2026-09-25 06:00:00", close: 150.1, rsi: 28.4, rsi_prev: 31.2, sar: 150.42, sar_below: false, atr: 0.3, signal: null },
    next: {
      close: { at: "2026-09-25T08:00:00.000Z", costly: false },
      sar: { level: 150.4, below: false },
      buy: { side: "BUY", ready: true, rsi_close: 150.18, sar_on_side: false, sar_level: 150.4, complete_close: 150.4, plan: { entry: 150.4, stop: 150.16, target: 150.76 } },
      sell: { side: "SELL", ready: false, rsi_close: 151.35, sar_on_side: true, sar_level: 150.4, complete_close: null, plan: null },
    },
    tally: { BUY: { n: 3, wins: 1, losses: 2, ambiguous: 0, expired: 0, open: 0 }, SELL: { n: 2, wins: 1, losses: 1, ambiguous: 0, expired: 0, open: 0 } },
    evidence: {
      period: "2025-07〜2026-09",
      pairs: 11,
      breakeven: { win: 0.4, hit: 0.5 },
      blind: { win: 0.35, hit: 0.448 },
      tf: { measured: true, win: 0.34, winN: 247, hit: 0.44, hitN: 248 },
      all: { measured: true, win: 0.354, winN: 1239, hit: 0.46, hitN: 1243 },
    },
    ...over,
  });
  const waitResult = { ...fullResult, signal: "WAIT" as const };

  it("on a WAIT, says what close each side needs, how far that is, and the plan it would make (#104)", () => {
    render(<AnalysisResultView result={waitResult} techData={{ ...techData, price: "150.100", rsiSar: summary() }} pair="USD/JPY" interval="1h" />);
    const panel = screen.getByTestId("rsi-sar-panel");
    expect(screen.getByTestId("rsi-sar-now").textContent).toContain("RSI(14) 31.2 → 28.4");
    expect(screen.getByTestId("rsi-sar-now").textContent).toContain("パラボリックSAR 150.420（価格の上＝売り側）");
    expect(screen.getByTestId("rsi-sar-fired").textContent).toContain("サインは出ていません");
    const buy = screen.getByTestId("rsi-sar-trigger-BUY").textContent ?? "";
    expect(buy).toContain("次の足が 150.400 を上回って引けたら、買いの条件がそろいます");
    expect(buy).toContain("+30.0pips");
    expect(screen.getByTestId("rsi-sar-plan-BUY").textContent).toContain("エントリー 150.400・損切り 150.160・利確 150.760");
    const sell = screen.getByTestId("rsi-sar-trigger-SELL").textContent ?? "";
    expect(sell).toContain("まだ準備前です。まず終値が 151.350 以上で引けて RSI が70を超える必要があります");
    expect(sell).toContain("+125.0pips");
    expect(screen.queryByTestId("rsi-sar-plan-SELL")).toBeNull();
    expect(screen.queryByTestId("rsi-sar-costly-next")).toBeNull();
    expect(screen.getByTestId("rsi-sar-window").textContent).toContain("買い 3回（勝ち1・負け2）");
    expect(panel.textContent).toContain("勝率 34%（247回）");
    expect(panel.textContent).toContain("損益ゼロになる勝率は 40%");
    expect(panel.textContent).toContain("このルールの勝率は損益ゼロに届いていません");
  });

  it("warns when the next close falls in the hours the app stands aside, and says a timeframe was not tested (#104)", () => {
    const s = summary({
      tf: "1min",
      next: { ...summary().next!, close: { at: "2026-09-25T21:05:00.000Z", costly: true } },
      evidence: { ...summary().evidence, tf: { measured: false, win: null, winN: null, hit: null, hitN: null } },
    });
    render(<AnalysisResultView result={waitResult} techData={{ ...techData, rsiSar: s }} pair="USD/JPY" interval="1min" />);
    expect(screen.getByTestId("rsi-sar-costly-next").textContent).toContain("日本時間6時台");
    const ev = screen.getByTestId("rsi-sar-evidence").textContent ?? "";
    expect(ev).toContain("1分足では検証していません");
    expect(ev).toContain("勝率 35%（1239回）");
  });

  it("shows the reading but no next-close advice on a BUY, and reads the row's copy on a past analysis (#104)", () => {
    const fired = summary({ now: { ...summary().now!, rsi: 31.5, rsi_prev: 28.9, sar_below: true, signal: "BUY" } });
    const check = { proposed_signal: "BUY", rejection: null, rsi_sar: fired } as unknown as EntryCheck;
    render(<AnalysisResultView result={fullResult} techData={techData} entryCheck={check} pair="USD/JPY" interval="1h" />);
    expect(screen.getByTestId("rsi-sar-fired").textContent).toContain("最新の確定足で買いのサインが出ています");
    expect(screen.queryByTestId("rsi-sar-advice")).toBeNull();
  });

  it("reads the panel in English too (#104)", () => {
    render(<AnalysisResultView result={waitResult} techData={{ ...techData, price: "150.100", rsiSar: summary() }} pair="USD/JPY" interval="1h" />, "en");
    expect(screen.getByTestId("rsi-sar-trigger-BUY").textContent).toContain("If the next bar closes above 150.400, the buy conditions are met");
    expect(screen.getByTestId("rsi-sar-panel").textContent).toContain(en.rsiSar.belowBreakeven);
  });

  it("says so when the reading could not be made", () => {
    render(<AnalysisResultView result={waitResult} techData={{ ...techData, rsiSar: summary({ ok: false, reason: "bars<60", now: null, next: null }) }} pair="USD/JPY" interval="1h" />);
    expect(screen.getByTestId("rsi-sar-unavailable").textContent).toContain("bars<60");
    expect(screen.queryByTestId("rsi-sar-advice")).toBeNull();
  });

  it("switches the chart between the rungs, and keeps the plan's levels on the entry rung only", () => {
    render(<AnalysisResultView result={fullResult} techData={{ ...techData, charts }} pair="USD/JPY" interval="1h" />);
    const tabs = screen.getByTestId("chart-tabs");
    expect(tabs.textContent).toContain("1時間足");
    expect(tabs.textContent).toContain("4時間足");
    expect(screen.getByText(/ENTRY 150\.123/)).toBeInTheDocument();
    expect(screen.getByTestId("chart-signal-BUY-win")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "4時間足" }));
    expect(screen.queryByText(/ENTRY 150\.123/)).toBeNull();
    expect(screen.queryByTestId("chart-signal-BUY-win")).toBeNull();
    expect(screen.getByText("プライスチャート · 4時間足")).toBeInTheDocument();
  });

  it("falls back to the entry candles when an older payload carries no charts", () => {
    render(<AnalysisResultView result={fullResult} techData={techData} pair="USD/JPY" interval="1h" />);
    expect(screen.queryByTestId("chart-tabs")).toBeNull();
    expect(screen.queryByTestId("rsi-sar-panel")).toBeNull();
    expect(screen.queryByTestId("gainz-panel")).toBeNull();
    expect(screen.getByText(/ENTRY 150\.123/)).toBeInTheDocument();
  });

  // #112: the GA-style rule's card beside RSI/SAR
  const gaSummary = (over: Partial<GainzSummary> = {}): GainzSummary => ({
    tf: "1h",
    rule: "gainz_v2a_050_50_5_atr1_v1",
    ok: true,
    reason: null,
    bars: 470,
    stop_atr: 1,
    reward_ratio: 2,
    horizon: 48,
    now: { datetime: "2026-09-25 06:00:00", close: 150.1, rsi: 44.2, atr: 0.3, signal: "BUY", plan: { entry: 150.1, stop: 149.8, target: 150.7 } },
    tally: { BUY: { n: 5, wins: 1, losses: 4, ambiguous: 0, expired: 0, open: 0 }, SELL: { n: 4, wins: 2, losses: 2, ambiguous: 0, expired: 0, open: 0 } },
    evidence: {
      period: "2025-07〜2026-09",
      pairs: 11,
      breakeven: 1 / 3,
      tf: { measured: true, win: 0.306, n: 1791, meanR: -0.08 },
      all: { measured: true, win: 0.288, n: 10757, meanR: -0.134 },
    },
    ...over,
  });

  it("#112: shows the GA-style signal beside RSI/SAR, with its plan, tally and what it was measured at", () => {
    render(<AnalysisResultView result={waitResult} techData={{ ...techData, price: "150.100", rsiSar: summary(), gainz: gaSummary() }} pair="USD/JPY" interval="1h" />);
    const panel = screen.getByTestId("gainz-panel");
    // it does not decide the signal: the published one is still WAIT
    expect(panel.textContent).toContain("売買判定（RSI × SAR）には使っていません");
    expect(screen.getByTestId("gainz-fired").textContent).toContain("買いのサイン");
    expect(screen.getByTestId("gainz-plan").textContent).toBe("そのときのプラン: エントリー 150.100・損切り 149.800・利確 150.700");
    expect(screen.getByTestId("gainz-window").textContent).toContain("買い 5回（勝ち1・負け4）");
    expect(screen.getByTestId("gainz-evidence").textContent).toContain("勝率 31%（1791回）、1回あたり平均 -0.08R。損益ゼロになる勝率は 33% です。");
    expect(screen.getByTestId("gainz-evidence").textContent).toContain("マイナスでした");
  });

  it("#112: falls back to the tested total on an untested timeframe, and says when nothing fired", () => {
    const g = gaSummary({
      tf: "1day",
      now: { datetime: "2026-09-25 00:00:00", close: 150.1, rsi: 52, atr: 0.9, signal: null, plan: null },
      evidence: { period: "2025-07〜2026-09", pairs: 11, breakeven: 1 / 3, tf: { measured: false, win: null, n: null, meanR: null }, all: { measured: true, win: 0.288, n: 10757, meanR: -0.134 } },
    });
    render(<AnalysisResultView result={waitResult} techData={{ ...techData, gainz: g }} pair="USD/JPY" interval="1day" />);
    expect(screen.getByTestId("gainz-fired").textContent).toContain("サインは出ていません");
    expect(screen.queryByTestId("gainz-plan")).toBeNull();
    expect(screen.getByTestId("gainz-evidence").textContent).toContain("日足では検証していません");
    expect(screen.getByTestId("gainz-evidence").textContent).toContain("勝率 29%（10757回）");
  });
});
