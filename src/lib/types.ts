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

export type OutcomeReason = "missed" | "invalidated" | "no_fill" | "incoherent" | "no_data";
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
  // The bar around the signal reached the entry but the timing is unknown
  possible_fill: boolean;
  filled_at: string | null;
  fill_price: number | null;
  resolution: "win" | "loss" | "untriggered" | "ambiguous" | "expired" | null;
  reason: OutcomeReason | null;
  resolved_at: string | null;
  refined: boolean;
  // Finer bars were needed but not available on the last check
  refine_pending: boolean;
  refine_attempts: number;
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
  note: string | null;
  path: OutcomePathPoint[];
}

// Why the entry gate in analyze refused (or repaired) a plan — mirror of
// entry_check written by supabase/functions/analyze/index.ts
export type EntryRejection = "too_far" | "should_be_market" | "stop_too_tight" | "poor_rr" | "incoherent";

export interface EntryCheck {
  proposed_signal: "BUY" | "SELL" | "WAIT";
  proposed_entry: number | null;
  proposed_stop: number | null;
  proposed_tp1: number | null;
  declared_type?: string | null;
  entry_type: string | null;
  regime?: string | null;
  momentum?: boolean;
  distance_atr: number | null;
  stop_atr?: number | null;
  risk_reward: number | null;
  rejection: EntryRejection | null;
  repair_rejection?: EntryRejection | null;
  repaired?: boolean;
  atr: number | null;
}

// Why a settled plan went the way it did — mirror of the postmortem
// document written by supabase/functions/postmortem/index.ts
export type PostmortemCause =
  | "direction_wrong"
  | "stop_too_tight"
  | "entry_too_far"
  | "target_too_far"
  | "regime_misread"
  | "news_shock"
  | "plan_incoherent"
  | "good_call"
  | "lucky_win"
  | "inconclusive";

export interface Counterfactual {
  resolution: string | null;
  reason: string | null;
  mfe_r: number | null;
  mae_r: number | null;
}

export interface PostmortemFacts {
  bars_after_settlement: number;
  hours_to_fill: number | null;
  hours_to_settle: number | null;
  from_signal: { max_favorable_r: number | null; max_adverse_r: number | null };
  after: {
    first_touch: "tp1" | "sl" | "both" | null;
    reached_tp1: { at: string; bars: number } | null;
    reached_sl: { at: string; bars: number } | null;
    beyond_sl_r: number | null;
    returned_to_entry: boolean | null;
  };
  abnormal_bar: { at: string; range_ratio: number } | null;
  counterfactual: {
    market_entry: Counterfactual | null;
    stop_x1_5: Counterfactual | null;
    stop_x2: Counterfactual | null;
    tp_half: Counterfactual | null;
  };
  regime: { declared: string | null; adx: number | null; conflict: boolean } | null;
  hints: PostmortemCause[];
}

export interface Postmortem {
  schema: number;
  status: "done" | "failed";
  cause?: PostmortemCause;
  secondary_causes?: PostmortemCause[];
  avoidable?: boolean;
  confidence?: number;
  verdict?: { ja: string; en: string };
  evidence?: { ja: string[]; en: string[] };
  lesson?: { ja: string; en: string };
  scope?: string | null;
  facts?: PostmortemFacts | null;
  created_at?: string;
  error?: string;
  attempts?: number;
}

// One consolidated rule the analyzer is given (public.rulebook)
export interface RulebookRule {
  id: string;
  text_ja: string;
  text_en: string;
  cause: string;
  support: number;
  scope: string | null;
  since: string | null;
}

export interface Rulebook {
  version: number;
  rules: RulebookRule[];
  summary: { ja: string; en: string } | null;
  updated_at: string | null;
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
  // v19+: the entry gate's verdict, the post-mortem, and shadow tracking of
  // refused plans (absent on rows written by earlier versions)
  entry_check?: EntryCheck | null;
  postmortem?: Postmortem | null;
  shadow?: boolean;
  shadow_of?: string | null;
  rulebook_version?: number | null;
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
