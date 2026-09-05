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
  // The stop and target widths are the analyzer's to decide (ATR and
  // structure, inside the entry gate's bounds). What belongs to the trader is
  // the size: the balance and the share of it risked on one trade.
  accountBalance: number;
  riskPercent: number;
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
  // Whether the plan was judged on a mid price or on both sides of the book
  price_basis?: "mid" | "quotes";
  // The spread the trade actually paid, when it was judged on quotes
  spread_at_fill?: number | null;
  spread_at_exit?: number | null;
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
  // The rung the finer bars were at ("15min" / "5min"); null when none fetched
  refined_interval: string | null;
  // The signal bar reached a level and finer bars have not yet said whether
  // that happened before or after the plan was written. Keeps the next sweep
  // from taking the established-fill short-circuit and forgetting the graze.
  signal_bar_pending: boolean;
  // Why an unjudgeable plan could not be judged (see AmbiguitySite in
  // track-outcomes/evaluate.ts). Null on every other resolution.
  ambiguity: {
    site: string;
    touched: "tp1" | "sl" | "both" | null;
    at_interval: string | null;
    bar_range: number | null;
    span: number | null;
  } | null;
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

// Why the entry gate in analyze refused a plan — mirror of entry_check
// written by supabase/functions/analyze/index.ts.
//
// `repaired` / `snapped` / `snap_declined` only ever appear on rows from the
// entry_chosen_v1 contract, where the model picked the entry price and the
// server sometimes moved it. Under market_v1 the server sets the entry, so
// there is nothing to move and the fields are absent.
export type EntryRejection =
  | "too_far"
  | "should_be_market"
  | "stop_too_tight"
  | "poor_rr"
  // The target was so far out that the ratio stopped meaning anything
  | "target_out_of_reach"
  // The server refused because the market was shut: "enter now" was not an
  // available action. Recorded apart from a model WAIT — one is the analyst
  // declining, the other is the server declining for it.
  | "market_closed"
  | "incoherent";

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
  // Which contract the plan was made under, and the geometry the gate saw.
  // Recorded so a drift in how the model places stops and targets is visible
  // before it becomes a change in the win rate.
  contract?: string;
  tp1_atr?: number | null;
  priced_at?: string;
  stop_atr?: number | null;
  risk_reward: number | null;
  rejection: EntryRejection | null;
  repair_rejection?: EntryRejection | null;
  repaired?: boolean;
  atr: number | null;
  // Written by analyze since the first version, never declared until now.
  price?: number | null;
  // Which book priced this plan. Twelve Data mid unless the GMO overlay was
  // accepted for the entry timeframe, in which case the plan is priced from the
  // same feed the tracker fills it on. Absent on rows written before the
  // overlay existed, which were all Twelve Data.
  price_feed?: "twelve_data" | "gmo";
  // How far outside GMO's newest bar the Twelve Data reference sat, in ATR.
  // Zero means the two feeds agreed exactly, which is what every measured
  // production row did. Null when there was no ATR to scale by.
  feed_delta_atr?: number | null;
}

// Why a settled plan went the way it did — mirror of the postmortem
// document written by supabase/functions/postmortem/index.ts
export type PostmortemCause =
  | "direction_wrong"
  | "stop_too_tight"
  // entry_chosen_v1 only, never newly written: under market_v1 the server
  // fills at the market, so no plan can go unfilled and no entry was chosen
  // late. Kept because stored rows still carry them.
  | "entry_too_far"
  | "entry_too_early"
  // What entry_too_early is called now: filled into an immediate retrace, in
  // a move that was already extended when the plan was made.
  | "chased_move"
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
  // v2 facts: the variant's own reward-to-risk, and whether the entry gate
  // would have published it
  rr?: number | null;
  viable?: boolean;
  gate?: "ok" | "poor_rr" | "stop_too_tight" | "too_far" | "should_be_market";
}

export interface PostmortemFacts {
  version?: number;
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
  abnormal_bar: { at: string; range_ratio: number; event?: { at: string; country: string; impact: string; title: string } | null } | null;
  early_adverse_r?: number | null;
  counterfactual: {
    market_entry: Counterfactual | null;
    market_entry_same_risk?: Counterfactual | null;
    stop_x1_5: Counterfactual | null;
    stop_x2: Counterfactual | null;
    tp_half: Counterfactual | null;
    limit_pullback?: Counterfactual | null;
  };
  regime: { declared: string | null; adx: number | null; conflict: boolean } | null;
  // How unsafe the trade was, mirror of postmortem/facts.ts Danger. Absent
  // on documents written before it was measured; null when the plan never
  // filled. Its flags are what filed a win as lucky_win.
  danger?: PostmortemDanger | null;
  hints: PostmortemCause[];
  notes?: string[];
}

export type PostmortemDangerFlag = "deep_mae" | "mostly_underwater" | "chop" | "spike_target" | "late_win";

export interface PostmortemDanger {
  bars_in_trade: number;
  underwater_bars: number;
  underwater_ratio: number | null;
  longest_underwater_bars: number;
  entry_crossings: number;
  // 1 - mae_r: the risk still unspent at the worst point
  closest_to_stop_r: number | null;
  // Wins only: where the TP1 bar closed relative to TP1, in R; negative
  // means short of the target
  target_bar_close_r: number | null;
  // Wins only: the largest move back from TP1 in the after-window, in R
  reversed_after_r: number | null;
  // Time to settlement over the timeframe's expiry allowance
  life_used_ratio: number | null;
  flags: PostmortemDangerFlag[];
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
  // Diagnosed on little aftermath; revisited once the full window exists
  thin?: boolean;
  revisions?: number;
  rule_blamed?: string | null;
  rule_credited?: string | null;
  rulebook_version?: number | null;
}

// One consolidated rule the analyzer is given (public.rulebook)
export interface RulebookRule {
  id: string;
  text_ja: string;
  text_en: string;
  cause: string;
  // Independent clusters of diagnosed plans behind it (server-computed)
  support: number;
  scope: string | null;
  since: string | null;
  kind?: "constraint" | "heuristic";
  // Which entry contract the analyst can actually CARRY THIS RULE OUT under.
  // Derived server-side from the rule's own cause and its own text, never from
  // when it was written. A rule stamped for another contract is held back from
  // the analyst's prompt — the move it describes may not exist any more — so
  // the panel must not present it as in force. Absent on rules written before
  // this was recorded: treat as legacy.
  contract?: string | null;
  // The entry contracts of the lessons this rule cites. Observational only: it
  // labels the rule's evidence as partly pre-dating the current contract, and
  // never decides whether the rule is shown.
  evidence_contracts?: string[];
  supported_by?: string[];
}

export interface Rulebook {
  version: number;
  rules: RulebookRule[];
  summary: { ja: string; en: string } | null;
  updated_at: string | null;
}

// What public.loop_health() returns: whether the review loop is running
export interface LoopHealth {
  tracker_last_run_at: string | null;
  postmortem_last_run_at: string | null;
  postmortem_last_diagnosed: number | null;
  postmortem_version?: string | null;
  open_plans: number;
  awaiting_review: number;
  reviewed: number;
  lessons: number;
  rulebook_version: number | null;
  rulebook_updated_at: string | null;
  lessons_since_rulebook: number;
  // A revision the loop has written but not yet promoted: it is held until
  // the live version has enough decided trades to be measured against.
  candidate_waiting?: boolean;
  candidate_created_at?: string | null;
  decided_under_version?: number;
  jobs: Array<{ name: string; schedule: string; active: boolean }>;
  now: string;
}

// Was standing aside the right call? Mirror of the WaitCheck written by
// supabase/functions/track-outcomes/waits.ts.
//
// A WAIT is a prediction too, and the one prediction that costs nothing to
// make: answer WAIT to everything and the win rate never moves. So it is
// scored against the smallest trade the app's own entry gate would have
// allowed from the price at the moment of the call — 'missed' means that
// trade existed and won.
export type WaitVerdict = "missed" | "correct" | "pending" | "unknown";

export interface WaitCheck {
  verdict: WaitVerdict;
  direction: "BUY" | "SELL" | null;
  r: number | null;
  at: string | null;
  price: number | null;
  atr: number | null;
  risk: number | null;
  reward: number | null;
  bars_examined: number;
  horizon_ms: number;
  checked_at: string;
}

// Row shape of public.analyses as read by the client
export type PlanContract = "entry_chosen_v1" | "market_v1";

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
  // Which entry contract the plan was made under. Absent on rows read by an
  // older client; treat that as the legacy contract (see contractKey).
  //   entry_chosen_v1 — the model picked the entry price, and a plan the market
  //                     never reached was never scored at all
  //   market_v1       — the server sets the entry to the market price at
  //                     analysis, so every non-WAIT call gets a verdict
  // Not derivable from rulebook_version: the same rulebook spans both.
  plan_contract?: PlanContract;
  // v19+: the entry gate's verdict, the post-mortem, and shadow tracking of
  // refused plans (absent on rows written by earlier versions)
  entry_check?: EntryCheck | null;
  postmortem?: Postmortem | null;
  // The verdict on a call that declined to trade (v24+; null until the
  // tracker has looked, absent on rows written before it existed)
  wait_check?: WaitCheck | null;
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
