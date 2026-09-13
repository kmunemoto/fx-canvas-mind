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
  // Only the pair. The balance and risk-percent fields that used to sit here
  // sized a position off the plan's stop; the owner asked for them to go, and
  // settings saved while they existed are still in browsers — the loader in
  // src/lib/settings.ts drops them without complaint.
  currencyPair: string;
}

export type TimeInterval = "15min" | "1h" | "4h" | "1day";

// How the analysis was made, as the server resolved it. technical_fallback
// means news was asked for and could not be fetched, and the server then
// prepends its own sentence to the warnings list — which is why the result
// view needs to know the mode to find the server's other sentences.
export type AnalysisMode = "full" | "technical_only" | "technical_fallback";

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
  // The pair this window projects 26 bars AHEAD: the cloud price will meet,
  // not the one it is in. Named for what it is wherever it is shown.
  spanA: string;
  spanB: string;
  // The cloud price is actually trading against, computed 26 bars ago.
  cloudNowTop?: string;
  cloudNowBottom?: string;
  cloudSide?: "above" | "inside" | "below" | null;
  // Whether the newest bar had closed when this was read
  barClosed?: boolean | null;
  // The levels the judgement rests on, computed server-side. Drawn on the
  // chart in a different register from anything the model merely cited, so
  // "price is below the cloud" and "a sweep is coming" cannot look alike.
  levels?: Array<{ label: string; value: number; kind: string }>;
  cloudBand?: { top: number; bottom: number } | null;
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
// Stated as a runtime array with the TYPE DERIVED FROM IT, rather than as a
// bare union, so that the list can be walked at runtime and cannot drift from
// the type the way a hand-kept pair would.
//
// Authoritative FOR THE CLIENT, and a mirror rather than a source: the gate's
// own union is Rejection in supabase/functions/analyze/entry.ts, and
// market_closed and low_confidence are stamped separately by analyze/index.ts
// on top of it. Nothing in the language ties this array to either, so
// src/test/i18n.test.ts does it explicitly — add a member to the server union
// and the typecheck fails there rather than shipping a rejection that renders
// as nothing in BOTH languages.
//
// It exists because OutcomeDetail renders a rejection only when the key is
// present in the dictionary (`check.rejection in g.reasons`) and renders
// NOTHING when it is not — silently, in that one language, with no error
// anywhere and no test failing. src/test/i18n.test.ts walks this array in both
// directions; a list re-typed inside the test would have gone stale the first
// time a rejection was added, which is the whole failure it is there to catch.
export const ENTRY_REJECTIONS = [
  "too_far",
  "should_be_market",
  "stop_too_tight",
  "poor_rr",
  // The target was so far out that the ratio stopped meaning anything
  "target_out_of_reach",
  // The server refused because the market was shut: "enter now" was not an
  // available action. Recorded apart from a model WAIT — one is the analyst
  // declining, the other is the server declining for it.
  "market_closed",
  // The model rated its own call below the floor the policy states, and the
  // server published the WAIT the policy calls for. On a proposed WAIT this is
  // the analyst agreeing with itself and nothing was refused; on a proposed BUY
  // or SELL it is a real refusal. isRejected in outcomeStats.ts is what tells
  // the two apart — this string cannot. Measured 2026-09-08: EVERY row
  // carrying it proposed WAIT, so not one of them was a refusal. The count
  // itself moves hourly and is deliberately not written down here.
  "low_confidence",
  "incoherent",
] as const;

export type EntryRejection = (typeof ENTRY_REJECTIONS)[number];

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
  // The model's own score and the floor it is published at. Written by
  // analyze on every row since the floor existed; absent on older rows.
  confidence?: number;
  confidence_floor?: number;
  rejection: EntryRejection | null;
  // The shape gate's own opinion of the plan (entry.ts evaluateEntry), NOT
  // what happened to the row: `rejection` above is the reason acted on, and
  // market_closed and low_confidence outrank the gate there, so the gate's
  // verdict used to be overwritten on exactly the rows where the two differ.
  // Null does NOT mean the gate approved the plan: on a proposed WAIT the gate
  // returns before it looks at any level (entry.ts, the WAIT early return), so
  // null there means not applicable, and that is every low_confidence row we
  // have. Read it as "no objection recorded" only where proposed_signal is BUY
  // or SELL. Absent on every row written before analyze-v46.
  shape_rejection?: EntryRejection | null;
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
  // WAIT only: the trade named at the call was there and it paid, or it was
  // not. wait_missed_trade is the one cause that pushes toward trading more.
  | "wait_missed_trade"
  | "good_wait"
  // A loss where every lever the review can move was tested and none of them
  // would have changed the outcome. Written by the server's own lever table
  // only — the model is never offered it — and it is not a verdict that the
  // call was right: everything the review measures happened after the call.
  | "sound_call_lost"
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
  from_signal: {
    max_favorable_r: number | null;
    max_adverse_r: number | null;
    // The favourable excursion measured only up to the settlement. Absent on
    // documents written before it existed.
    max_favorable_r_in_life?: number | null;
  };
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
  // The judge's MAE for the plan, in R. Absent on documents written before it
  // was carried here; on those rows the danger block is usually absent too, so
  // "was this win a lucky one" is not answerable from the document alone.
  mae_r?: number | null;
  // Losses only: which lever the no-fault verdict was tested against, and how
  // each one answered. Absent on anything else and on older documents.
  no_fault_grounds?: {
    // `paid` is tri-state: true when moving the lever changed the outcome
    // (won, or expired without ever being stopped), false when it was pulled
    // and the trade still lost, null when the judge has not answered yet.
    levers: Array<{ lever: string; computed: boolean; resolution?: string | null; paid: boolean | null }>;
    complete: boolean;
    answered?: boolean;
    allowed: boolean;
  } | null;
  // Bars of the plan's own life. Absent on older documents.
  bars_in_life?: number;
  // What the plan settled as. Absent on older documents.
  resolution?: string | null;
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
  // Diagnosed on little aftermath. Null on a WAIT, where the aftermath of a
  // trade that was never taken is not measured at all, so neither true nor
  // false would be a fact about it.
  thin?: boolean | null;
  revisions?: number;
  // Every earlier reading of this same row, oldest first, kept when the
  // diagnosis is rewritten. A compact snapshot: no facts, and no prior of its
  // own.
  prior?: Array<{
    version?: string | null;
    created_at?: string | null;
    cause?: PostmortemCause | null;
    secondary_causes?: PostmortemCause[];
    avoidable?: boolean | null;
    confidence?: number | null;
    rule_blamed?: string | null;
    rule_credited?: string | null;
    lesson?: { ja: string | null; en: string | null };
    bars_after_settlement?: number | null;
    thin?: boolean | null;
  }>;
  rule_blamed?: string | null;
  rule_credited?: string | null;
  rulebook_version?: number | null;
  // What was diagnosed. On a WAIT the facts measure a trade that was never
  // taken, and a reader who assumes otherwise reads a position that never
  // existed.
  subject?: "trade" | "wait";
  wait_plan?: WaitPlan | null;
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

// How today's market compared with the plans each learned rule was drawn
// from, as the server measured it (supabase/functions/analyze/situation.ts).
//   match    every axis that could be compared puts today inside or beside
//            the rule's evidence
//   off      at least one comparable axis puts today outside it
//   unknown  fewer than two axes could be compared at all — too thin, too
//            wide, or the cited plans predate the stored snapshot
export type RuleFitVerdict = "match" | "off" | "unknown";

export interface RuleFitEntry {
  fit: RuleFitVerdict;
  // Axes that counted towards the verdict, and the ones that came out outside
  comparable: string[];
  missed: string[];
  // Cited plans whose snapshot could be read, out of the number cited. The gap
  // is the part of a rule's evidence the comparison could not see.
  cases: number;
  cited: number;
}

export interface RuleFit {
  shown: string[];
  held_back: number;
  rules: Record<string, RuleFitEntry>;
  // Which of the shown rules the analyst SAID it applied on this call. This is
  // the analyst's SELF-REPORT and nothing else: it is never evidence about a
  // rule, never a measurement, and must never be mixed into the `fit` verdicts
  // above, which the server measured against each rule's own citations.
  //
  // Optional because the analyst often does not answer: structured output does
  // not bind when web search is on, and most runs search. Absent means "did
  // not say", which is not the same as an empty array — "I applied none".
  claimed_by_analyst?: string[];
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
  // Rows decided under the live version. Kept because a server that has not
  // run the loop_health migration yet still sends only this one — but it is
  // NOT the number the gate decides on, and reading it against the gate's
  // floor is what made the screen say 2/10 while the gate sat at 1/10.
  decided_under_version?: number;
  // Independent SITUATIONS decided under the live version: what
  // MIN_DECIDED_EPISODES is actually compared against. Absent until the
  // loop_health migration is applied, which is why the display falls back.
  decided_episodes_under_version?: number;
  // Which definition of "one situation" produced the count above
  // (supabase/functions/_shared/episodes.ts, EPISODE_DEFINITION_VERSION).
  episode_definition_version?: number;
  jobs: Array<{ name: string; schedule: string; active: boolean }>;
  now: string;
}

// What public.performance_stats() returns: the record over EVERY row, not
// over the page the client happened to fetch.
//
// No group here ever carries a bare win rate. `decided`, `sum_r`,
// `trades_per_call` and `wait_rate` travel with it, because a rulebook that
// raises the win rate by standing aside more and one that is right more often
// look identical in the rate alone and completely different in those four.
export interface PerformanceGroup {
  calls: number;
  waits: number;
  // WAIT rows the gate imposed on a plan the analyst asked for.
  rejected: number;
  // WAIT rows the analyst chose itself. Optional because an answer from a
  // server that predates the split does not carry it; read as 0 rather than
  // guessed from `waits - rejected`, which under the old conflated `rejected`
  // would have produced a number for an event nobody counted. Its absence is
  // also how serverTally recognises such a server and withholds `rejected`
  // too, since that field is then the conflated count under a narrower name.
  self_declined?: number;
  waits_judged: number;
  waits_missed: number;
  total: number;
  wins: number;
  losses: number;
  expired: number;
  open: number;
  untriggered: number;
  ambiguous: number;
  incoherent: number;
  filled: number;
  settled: number;
  decided: number;
  with_r: number;
  clusters: number;
  contracts: string[];
  win_rate: number | null;
  win_rate_ci95: [number, number] | null;
  fill_rate: number | null;
  sum_r: number | null;
  expectancy: number | null;
  trades_per_call: number | null;
  verdict_rate: number | null;
  wait_rate: number | null;
  expired_rate: number | null;
  untriggered_rate: number | null;
  ambiguous_rate: number | null;
  incoherent_rate: number | null;
  open_rate: number | null;
  wait_miss_rate: number | null;
  // The rate is real, but its interval spans most of the range. Reported
  // rather than withheld — an interval says more than a blank.
  below_min_n: boolean;
}

export interface PerformanceStats {
  generated_at: string;
  live_contract: string;
  // Which definition of "one independent situation" every `clusters` below was
  // counted under. Absent from answers written by a server older than the one
  // definition; a change of method must never read as the analyst improving.
  episode_definition_version?: number;
  scopes: Record<string, PerformanceGroup>;
  by_rulebook_version: Record<string, PerformanceGroup>;
  by_confidence: Record<string, PerformanceGroup>;
  by_timeframe: Record<string, PerformanceGroup>;
  by_mode: Record<string, PerformanceGroup>;
  // Each entry contract's own record, kept apart rather than pooled. Where
  // the record still is when every plan predates the current contract.
  by_contract: Record<string, PerformanceGroup>;
  other_contract_rows: number;
  other_contracts: string[];
  shadow: { total: number; untriggered: number; wins: number; losses: number; open: number; other: number };
}

// Was standing aside the right call? Mirror of the WaitCheck written by
// supabase/functions/track-outcomes/waits.ts.
//
// A WAIT is a prediction too, and the one prediction that costs nothing to
// make: answer WAIT to everything and the win rate never moves. So it is
// scored against the smallest trade the app's own entry gate would have
// allowed from the price at the moment of the call — 'missed' means that
// trade existed and won.
//
// WHICH trade is decided at the call and stored in wait_plan, never chosen
// afterwards from what paid. Where nothing at the time named a side there is
// no prediction to score: 'no_call', counted on neither side of the rate.
export type WaitVerdict = "missed" | "correct" | "pending" | "unknown" | "no_call";

// The trade the WAIT stood aside from, fixed at the moment of the call.
// Mirror of the WaitPlan written by supabase/functions/analyze/entry.ts.
export interface WaitPlan {
  direction: "BUY" | "SELL" | null;
  direction_source: "proposed_signal" | "declared_direction" | "regime" | "none";
  entry: number | null;
  stop: number | null;
  target: number | null;
  risk: number | null;
  reward: number | null;
  atr: number | null;
  spread: number | null;
  contract: string;
  decided_at: string;
  scorer: number;
}

export interface WaitCheck {
  verdict: WaitVerdict;
  direction: "BUY" | "SELL" | null;
  // The same direction, named for what it is: the one fixed at the call.
  // `direction` used to mean "the way the missed trade went", chosen from the
  // outcome — a reader who assumes the old meaning reads a fact that is no
  // longer in the data.
  plan_direction?: "BUY" | "SELL" | null;
  direction_source?: string | null;
  r: number | null;
  at: string | null;
  price: number | null;
  atr: number | null;
  risk: number | null;
  reward: number | null;
  stop?: number | null;
  target?: number | null;
  bars_examined: number;
  horizon_ms: number;
  checked_at: string;
  // Which scoring rule produced this verdict. 2 is the decision-time scorer;
  // absent means the two-sided one that chose the winning side afterwards.
  scorer?: number;
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
  wait_plan?: WaitPlan | null;
  shadow?: boolean;
  shadow_of?: string | null;
  // The market was shut when this was requested, so it is a read of the last
  // close with no entry, stop or targets. Kept in the history, counted nowhere.
  preview?: boolean;
  rulebook_version?: number | null;
  // The held-position review made on this run (analyze/review.ts). Absent on
  // rows written before it existed; null on rows written since by a function
  // that recorded nothing.
  position_review?: PositionReview | null;
}

// ---------------------------------------------------------------------------
// Held positions and the review of them — mirrors of
// supabase/functions/analyze/review.ts. Every field carries the meaning the
// server gave it there; nothing here is derived on the client.
// ---------------------------------------------------------------------------

// Row shape of public.positions as read by the client (RLS: own rows).
export interface Position {
  id: string;
  analysis_id: string;
  pair: string;
  interval: string;
  direction: "BUY" | "SELL";
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number | null;
  take_profit_3: number | null;
  opened_at: string;
  // user = the reader typed the fill time; registered = the server clock at
  // registration stood in for it. Null on a row read by an older client.
  opened_at_source: "user" | "registered" | null;
  registered_after_settlement: boolean;
  status: "open" | "closed";
  closed_at: string | null;
  // user = the reader typed the close time; registered = the server clock at
  // the moment it was recorded stood in for it. Null on an open position and
  // on a row closed before the column existed.
  closed_at_source: "user" | "registered" | null;
  close_price: number | null;
  close_reason: "manual" | "stop" | "target" | "other" | null;
  created_at: string;
}

export type HeldVerdict = "hold" | "caution" | "exit_condition_met" | "undecidable";
export type ThesisStatus = "intact" | "weakened" | "broken" | "unknown";
export type ReviewDecidedBy = "server" | "analyst" | "unknown";
export type ChangeKind = "same_call" | "reversed" | "trade_to_wait" | "wait_to_trade" | "unclear";

export interface ReferenceOutcome {
  outcome: string;
  price_basis: "mid" | "quotes" | null;
  closed_at: string | null;
  outcome_price: number | null;
}

export interface HeldReference {
  kind: "held";
  position_id: string;
  analysis_id: string;
  direction: "BUY" | "SELL";
  entry: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  opened_at: string;
  opened_at_source: "user" | "registered" | null;
  registered_after_settlement: boolean;
  interval: string;
  confidence: number | null;
  thesis: string | null;
  key_factors: string[];
  feed: "twelve_data" | "gmo" | null;
  outcome: ReferenceOutcome | null;
  other_open_positions: { count: number; ids: string[] };
}

export interface PreviousReference {
  kind: "previous";
  analysis_id: string;
  at: string;
  priced_at: string | null;
  interval: string;
  signal: "BUY" | "SELL" | "WAIT";
  proposed_signal: "BUY" | "SELL" | "WAIT" | null;
  rejection: string | null;
  confidence: number | null;
  decided_by: ReviewDecidedBy;
  analyst_direction: "BUY" | "SELL" | "WAIT" | null;
  levels: { direction: "BUY" | "SELL"; entry: number; stop: number; tp1: number; published: boolean } | null;
  thesis: string | null;
  key_factors: string[];
  feed: "twelve_data" | "gmo" | null;
  outcome: ReferenceOutcome | null;
}

export interface ReviewReferenceSet {
  held: HeldReference | null;
  held_reason: "no_open_position" | "lookup_failed" | "plan_row_missing" | null;
  previous: PreviousReference | null;
  previous_reason: "none_within_window" | "lookup_failed" | null;
  thesis_of: "held" | "previous" | null;
}

// One level, three states. `measured: false` is never rendered as "no touch".
export type LevelTouch =
  | { measured: true; touched: true; at: string; bar_closed: boolean }
  | { measured: true; touched: false; from: string; as_of: string; bars_examined: number }
  | { measured: false; reason: "no_anchor" | "series_starts_after_anchor" | "no_bars_since_anchor" };

export interface ReviewMechanical {
  subject: "held" | "previous";
  basis: "mid";
  feed: "twelve_data" | "gmo";
  feed_delta_atr: number | null;
  price: number;
  priced_at: string;
  direction: "BUY" | "SELL";
  entry: number;
  stop: number;
  tp1: number;
  risk: number | null;
  // Signed, favourable positive. Hypothetical when subject is "previous".
  move_pips: number | null;
  move_r: number | null;
  to_stop_pips: number | null;
  to_tp1_pips: number | null;
  anchor_at: string | null;
  anchor_source: "opened_at" | "priced_at" | null;
  covers_anchor: boolean | null;
  bars_examined: number;
  as_of: string | null;
  stop_touch: LevelTouch;
  tp1_touch: LevelTouch;
}

export interface ReviewAnalyst {
  status: "ok" | "failed";
  verdict: HeldVerdict | null;
  thesis_status: ThesisStatus | null;
  reasons: string[];
  what_changed: string[];
  watch: string | null;
  model: string | null;
  effort: string | null;
  max_tokens: number | null;
  error: string | null;
  elapsed_ms: number | null;
}

export interface ReviewOverride {
  source: "mid_touch" | "tracker" | "analyst_incoherent";
  at: string | null;
  basis: "mid" | "quotes" | null;
  feed: "twelve_data" | "gmo" | null;
  bar_closed: boolean | null;
  before_open: boolean | null;
  analyst: { verdict: HeldVerdict | null; thesis_status: ThesisStatus | null } | null;
}

export interface ChangeSide {
  analysis_id: string | null;
  at: string;
  signal: "BUY" | "SELL" | "WAIT";
  proposed_signal: "BUY" | "SELL" | "WAIT" | null;
  rejection: string | null;
  confidence: number | null;
  decided_by: ReviewDecidedBy;
  published: boolean;
  analyst_direction: "BUY" | "SELL" | "WAIT" | null;
}

export interface ReviewChange {
  previous: ChangeSide;
  current: ChangeSide;
  kind: ChangeKind;
  thesis_of: "held" | "previous" | null;
  thesis_status: ThesisStatus | null;
  current_gate_rr: number | null;
}

// What analyze wrote about the plan the reader holds (or the previous run's
// plan) on THIS row. `verdict` is the server's derivation and `analyst` is
// the model's answer as written; the two are kept apart on purpose.
export interface PositionReview {
  version: 1;
  status: "ok" | "partial" | "skipped" | "failed";
  skipped_reason: "no_reference" | null;
  error: string | null;
  reference: ReviewReferenceSet | null;
  mechanical: ReviewMechanical | null;
  analyst: ReviewAnalyst | null;
  verdict: HeldVerdict | null;
  decided_by: "server" | "analyst" | null;
  override_reason: ReviewOverride | null;
  override_suppressed:
    | { reason: "settled_before_open" | "settled_before_registration" | "registered_after_settlement"; closed_at: string | null }
    | null;
  change: ReviewChange | null;
  at: string;
  elapsed_ms: number | null;
}

// What analyze says when it served a stored answer instead of drawing a new
// one — mirror of ReuseRecord in supabase/functions/analyze/reuse.ts. Null on
// a run that actually analysed; the two must never look alike on screen.
export interface AnalysisReuse {
  version: 1;
  // The row this answer belongs to. It was written then, not now.
  analysis_id: string;
  analyzed_at: string;
  served_at: string;
  // true = the credit came back, false = the refund failed and the count
  // stayed down, null = none was consumed (admin). The banner says nothing
  // about credits when this is null.
  credit_refunded: boolean | null;
  // No `inputs_key`: the digest covers the analyst system prompt, which is
  // server-side only, and no screen reads it.
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
