export interface MarketContextDetail {
  mode: string;
  structure: string;
  smart_money: string;
  strength: string;
  session: string;
  direction: string;
  continuity: string;
}

export interface TimeframeBias {
  timeframe: string;
  bias: "BULLISH" | "NEUTRAL" | "BEARISH";
  note: string;
}

export interface AnalysisResult {
  signal: "BUY" | "SELL" | "WAIT";
  // One-line trade thesis shown under the direction, e.g.
  // "Liquidity sweep before upside expansion" (v9+; absent on old responses)
  thesis?: string;
  confidence: number;
  technical_score: number;
  fundamental_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  sentiment: "BULLISH" | "NEUTRAL" | "BEARISH";
  entry_point: string;
  stop_loss: string;
  take_profit_1: string;
  take_profit_2: string;
  take_profit_3?: string;
  risk_reward_ratio: string;
  analysis: string;
  key_factors: string[];
  warnings: string[];
  support_levels: string[];
  resistance_levels: string[];
  market_context: string;
  market_context_detail?: MarketContextDetail | null;
  stop_hunt_zone?: string;
  timeframe_alignment?: TimeframeBias[];
}

export interface AppSettings {
  defaultStopLossPips: number;
  defaultTakeProfitPips: number;
  currencyPair: string;
}

export type TimeInterval = "15min" | "1h" | "4h" | "1day";

export interface TechnicalData {
  price: string;
  datetime: string;
  timeSeries: CandleData[];
  rsi: string;
  macd: string;
  macdSignal: string;
  macdHist: string;
  bbUpper: string;
  bbMiddle: string;
  bbLower: string;
  sma20: string;
  sma50: string;
  sma200: string;
  tenkan: string;
  kijun: string;
  spanA: string;
  spanB: string;
  atr: string;
  slowK: string;
  slowD: string;
  adx: string;
  // v9+: oldest-first numeric candles of the entry timeframe, for the chart
  candles?: NumericCandle[];
}

export interface CandleData {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

export interface NumericCandle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

// 'untriggered': the entry price was never reached, so no trade happened.
// 'ambiguous': SL and TP1 were touched inside one bar and the order could
// not be determined. Neither counts toward the win rate.
export type TradeOutcome =
  | "pending"
  | "win"
  | "loss"
  | "expired"
  | "skipped"
  | "untriggered"
  | "ambiguous";

export type OutcomeReason = "missed" | "invalidated" | "no_fill" | "incoherent";
export type OrderType = "market" | "limit" | "stop" | "unknown";

export interface OutcomePathPoint {
  t: string; // ISO UTC of the bar open
  o: number;
  h: number;
  l: number;
  c: number;
}

// Mirror of Evaluation in supabase/functions/track-outcomes/evaluate.ts —
// the evidence the tracker stores with each judgement
export interface OutcomeEvaluation {
  version: number;
  eval_interval: string;
  order_type: OrderType;
  price_at_signal: number | null;
  filled_at: string | null;
  fill_price: number | null;
  resolution: "win" | "loss" | "untriggered" | "ambiguous" | "expired" | null;
  reason: OutcomeReason | null;
  resolved_at: string | null;
  refined: boolean;
  mfe: number | null;
  mae: number | null;
  mfe_r: number | null;
  mae_r: number | null;
  tps_hit: number[];
  bars_after_signal: number;
  window_covers_signal: boolean;
  first_candle_at: string | null;
  last_candle_at: string | null;
  checked_at: string;
  path: OutcomePathPoint[];
}

// Row shape of public.analyses as read by the client
export interface AnalysisRecord {
  id: string;
  pair: string;
  interval: string;
  mode: string | null;
  signal: "BUY" | "SELL" | "WAIT";
  confidence: number | null;
  thesis: string | null;
  entry_point: number | null;
  stop_loss: number | null;
  take_profit_1: number | null;
  take_profit_2: number | null;
  take_profit_3: number | null;
  price_at_signal: number | null;
  outcome: TradeOutcome;
  outcome_price: number | null;
  created_at: string;
  closed_at: string | null;
  evaluation: OutcomeEvaluation | null;
}

export interface HistoryEntry {
  timestamp: string;
  signal: "BUY" | "SELL" | "WAIT";
  confidence: number;
  pair: string;
  interval: TimeInterval;
}

export type LoadingStage =
  | "idle"
  | "fetching"
  | "analyzing"
  | "generating_judgment";
