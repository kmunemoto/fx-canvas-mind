// #105: mail the RSI + Parabolic SAR signal to the people who asked for it.
//
// Two callers:
//   * pg_cron at 2, 17, 32 and 47 past the hour, with the shared sweep token
//     (migrations/20260925120000_signal_alerts.sql): read every subscribed
//     pair and timeframe, and mail each fresh signal once per subscriber;
//   * the app, with the user's JWT: read the settings ("status"), follow or
//     unfollow a chart ("set"), send oneself a test ("test").
//
// The subscriptions and the sent log are written here only, with the service
// role: the tables grant the user SELECT on their own rows and nothing else,
// so the plan check below cannot be stepped around from the browser.
//
// Mail goes out through Resend when RESEND_API_KEY is set. Until it is, every
// signal is still detected and logged — status "not_configured" — and the
// app says that no email can be sent yet, rather than pretending it was.
//
// #108: the sweep also reads every one of the app's seven pairs (#175: the
// four yen pairs among them, logic.ts ALERT_PAIRS; #177: and EUR/USD;
// #178: and AUD/USD) on every alert timeframe, followed or not, records
// each signal once in signal_events and settles the open ones against the
// bars that came after (record.ts). The app shows that record beside the
// alerts.
//
// #112: a second rule beside RSI + SAR, the GA-style rule
// (analyze/gainz.ts). It is read on the same bars, recorded and settled the
// same way (signal_events.rule tells the two apart), and mailed only to the
// charts subscribed with rule = 'gainz'.
//
// #155: Q-Trend's and ULTRA's signals, on every pair of the live chart
// (indicators.ts): a third caller, pg_cron every minute with the same token
// and {"mode": "indicators"}. Judged on the bars the live chart holds, with
// the chart's own code, and mailed to the charts subscribed with rule =
// 'qtrend' or 'ultra' (#275: or 'macdx', the MACD peak-and-valley rule on the
// 5-minute chart of GMO's pairs; #324: on their 1-hour chart from v25, the
// owner's levels; #345: and on gold's 1-hour chart from v27, read from
// Twelve Data; #353: from v28 the blue line at 90% of the way from zero to
// the top or bottom of the newest 120 bars' MACD pane (the highest or lowest
// of the MACD line, the signal line and the histogram), no cross; #362: 95%
// from v30; #397: from v39 a ride, two emails a pair — in at the close where
// the line came into the 90% band, with the flow, and told the moment it
// reaches 96% — its rides kept in public.macd_rides; v40: the MACD fade on
// the same 1-hour charts, one email when the line closes at 96% of the
// pane's top, a SELL, or bottom, a BUY, with the price in only). Not
// recorded or settled (signal_events is the two rules' record).
//
// #291: a fourth caller, pg_cron every minute with {"mode": "gold-ticks"}:
// Swissquote's gold price every few seconds all minute, recorded into
// public.gold_tick_bars (gold's 1-minute bars, the chart's too), and the
// minute that closed judged by the owner's video's way, mailed to the charts
// subscribed with rule = 'sweepx' (gold's 1-minute chart). Not recorded or
// settled either.

import {
  ALERT_INTERVALS,
  ALERT_PAIRS,
  DEFAULT_FROM,
  alertsAllowed,
  checkPair,
  isAlertInterval,
  isAlertPair,
  isLang,
  mayHaveFreshClose,
  renderSignalMail,
  renderTestMail,
  RULE_ID,
  ruleIdOf,
  sendMail,
  type FiredSignal,
  type Lang,
} from "./logic.ts";
import { GA_RULE_ID, isRuleKey, type RuleKey } from "../analyze/gainz.ts";
import type { Fetcher, QuoteCandle } from "../track-outcomes/quotes.ts";
import { BACKTEST, GA_BACKTEST, fillAt, settleEvent, summarize, type EventRow, type OpenEvent } from "./record.ts";
import { isPossiblyClosed, isPossiblyClosedFor } from "../_shared/market-hours.ts";
import {
  ALERT_TWELVE_CAP,
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  MACDH_INTERVAL_OF,
  MACDH_INTERVALS,
  MACDH_PAIRS,
  STALE_RETRY_MS,
  STALE_TRIES,
  TWELVE_ALERT_INTERVALS,
  TWELVE_READS_PER_RUN,
  TWELVE_RETRY_MS,
  fadeSignal,
  freshFor,
  gmoIntervalsDue,
  hourCloseOf,
  indicatorIntervalsFor,
  indicatorSignals,
  isGmoChartPair,
  isIndicatorChartFor,
  isIndicatorRule,
  isMacdhChart,
  keepableKlines,
  klineFileEnded,
  klineFileKey,
  klineFileOf,
  klinePreloadDays,
  latestCloseMs,
  ridePaidAt,
  rideSignalTag,
  signalRow,
  amdpo3Signals,
  emarmSignals,
  EMARM_INTERVALS,
  EMARM_PAIRS,
  SPIKE_INTERVALS,
  SPIKE_LATE_MS,
  SPIKE_PAIRS,
  SPIKE_RULE_ID,
  goldHourBar,
  spikeRangeFor,
  spikeSignals,
  SWEEPX_INTERVALS,
  SWEEPX_PAIRS,
  isSweepxChart,
  sweepxSignals,
  renderIndicatorMail,
  staleForClose,
  startWaitMs,
  twelveChartDue,
  twelveCloseDue,
  twelvePhase,
  twelveReadDue,
  type IndicatorRule,
  type IndicatorSignal,
  type KlineFile,
} from "./indicators.ts";
// v40 (docs §8.155): the MACD email as the fade at a closed 1-hour bar, the
// code research/macdfade-prod-check.ts holds to the study's entries (v41: at
// a closed bar of each pair's own chart, 15-minute or 1-hour). (#397: v39's
// ride, _shared/macd-ride.ts, is no longer imported here)
import { fadeCloseEntryAt } from "../_shared/macd-fade.ts";
import {
  GOLD,
  GOLD_BARS,
  GOLD_QUOTE_URL,
  HISTORY_BARS,
  LIVE_STEP_MS,
  TWELVE_1MIN_BARS,
  fetchLiveQuotes,
  historyOfBars,
  historyRead,
  isTwelvePair,
  parseSwissquote,
  parseTickMinutes,
  parseTwelveData,
  splitBars,
  tickMinuteCandles,
  twelveDataUrl,
  type Tick,
} from "../live-chart/logic.ts";
import { SPIKE, spikeOf } from "../_shared/spike.ts";
import { GOLD_TICK_EVERY_MS, goldSeedRows, goldTickPlan, judgesWhileShut, nextTickAt } from "./gold-minutes.ts";
import {
  STOCK_RUN_BUDGET_MS,
  STOCKMACD_INTERVALS,
  STOCKMACD_PAIRS,
  isStockmacdChart,
  stockBarsOf,
  stockCloseDue,
  stockFadeClose,
  stockSweepOf,
  type StockBar,
} from "./stocks.ts";
import { YAHOO_HEADERS, yahooChartUrl } from "../live-chart/stocks.ts";
import { SWEEPX } from "../_shared/sweep-cross.ts";
import { GMO_INTERVALS, GMO_SYMBOLS, jstDayKey, jstYearKey } from "../track-outcomes/quotes.ts";
import { barOpenMs } from "../analyze/state.ts";
import type { Candle } from "../analyze/indicators.ts";

// v14 (#176): the code is v13's; the bars of the pairs read as gold is are
// read GOLD_BARS (1,400) at once, as the live chart's deep history needs
// them stored. The signals judge from anchoredStart, so the mails are the same.
// v15 (#177): EUR/USD again, for RSI + SAR and the GA-style rule (ALERT_PAIRS)
// and Q-Trend and ULTRA (the live chart's pairs).
// v16 (#178): and AUD/USD again, likewise.
// v17 (#180): USD/CAD again, for Q-Trend and ULTRA (the live chart's pairs),
// read from Twelve Data as before #175: 1-hour to daily only. Not for RSI +
// SAR and the GA-style rule, which read GMO's bars (as before #175).
// v18 (#181): the version only. The live chart's 15 timeframes are in the
// live-chart logic this reads (LIVE_STEP_MS, barEndMs); the emails' own
// lists (ALERT_INTERVALS, INDICATOR_INTERVALS) are as they were, and for
// their timeframes every bar closes where it did.
// v19 (#182): GMO's 4-hour bar stamped Sunday 20:00 UTC (the week's first two
// hours) is no longer thrown away (quotes.ts usableBars): the 4-hour charts
// are judged at Monday 00:00 UTC too, and every 4-hour reading runs on the
// bars with it. The other timeframes' bars are as they were.
// v20 (#192): Q-Trend's and ULTRA's stop and targets, on gold and the pairs
// both, at the second F-INVEST video's chart: the stop 13 and the targets 4,
// 10 and 16 (dollars on gold, pips on a pair; _shared/ultra.ts ULTRA_PAIRS and
// ULTRA_GOLD), and the emails' measured figures at them (indicators.ts). The
// signals and the rule ids are as they were.
// v21 (#211): the Japanese emails name the pair as 楽天FX does (ユーロ/円, in
// the subject and the body; _shared/pair-names.ts). The English emails, the
// signals, the rule ids and what is recorded (the pair's code) are as they were.
// v22 (#212): gold's Q-Trend and ULTRA on 15 minutes too (indicators.ts
// GOLD_ALERT_INTERVALS): its bars read from Twelve Data after each 15-minute
// close, as the hourly ones after theirs; a chart whose bars' phase this
// instance has not learned is looked at by its own grid when under an hour
// (twelveChartDue). The other Twelve Data pairs stay on 1 hour and up.
// v23 (#275): a third rule beside Q-Trend and ULTRA, the MACD peak-and-valley
// rule (indicators.ts macdxSignals; docs §8.109), mailed to the charts
// subscribed with rule = 'macdx': the 5-minute chart of GMO's currency pairs
// only. Judged on the same closed bars as ULTRA, with the code the rule was
// measured with (_shared/macd-extreme.ts). Q-Trend's and ULTRA's signals, the
// rule ids and what is recorded are as they were.
// v24 (#291): gold's price from Swissquote recorded all day (a fourth caller,
// pg_cron every minute with {"mode": "gold-ticks"}; gold-minutes.ts), the
// minutes before it filled once from Twelve Data ({"mode": "gold-seed"}), and
// a fourth rule, the owner's video's way (indicators.ts sweepxSignals; docs
// §8.112), judged by that run on the minutes recorded and mailed to the
// charts subscribed with rule = 'sweepx': gold's 1-minute chart only. The
// other rules' signals, ids and what is recorded are as they were.
// v25 (#324): the MACD email ('macdx') judged by the owner's rule on the
// 1-hour chart in place of the 5-minute one (indicators.ts macdhSignals,
// _shared/macd-level.ts; docs §8.114): a SELL where MACD crosses below its
// signal line at or above +8.5 pips (0.085 on a yen pair), a BUY where it
// crosses above at or below -8.5 pips, recorded under its own rule id
// (MACDH_RULE_ID). The 5-minute rule is no longer mailed (its subscriptions
// are not followed); its code stays for the studies. The other rules'
// signals, ids and what is recorded are as they were.
// v26 (#339): the MACD email's level each pair's own (indicators.ts
// macdhSignals, _shared/macd-level.ts decideScaledOnWindow; docs §8.116):
// MACDH_K (0.8) times the pair's usual hourly move, the mean move from one
// close to the next over the 600 bars judged on, in place of v25's 8.5 pips;
// recorded under a new rule id (MACDH_RULE_ID). The charts (the five pairs'
// 1-hour), the subscriptions and the other rules are as they were.
// v27 (#345): gold's 1-hour chart too for the MACD email (indicators.ts
// MACDH_PAIRS; docs §8.118): the same rule and rule id on gold's bars, which
// are Twelve Data's (read after each hourly close as gold's other Twelve Data
// charts are), the level in dollars (MACDH_K times gold's usual hourly move),
// the stop and targets ULTRA's. The five pairs' emails, the subscriptions and
// the other rules are as they were.
// v28 (#353): the MACD email ('macdx') is no cross any more (indicators.ts
// macdhSignals, _shared/macd-level.ts decideZoneOnWindow; docs §8.119): a
// SELL at the bar where MACD's blue line comes to 90% or more of the way
// from the zero line to the top of the MACD pane of the newest 120 bars (the
// highest of the MACD line, the signal line and the histogram there), a BUY
// likewise toward the pane's bottom, once as it gets there (the owner:
// 「macdの青い線が上か下の90%以上の所までいったら売買のメールを送る様に」, and
// 「2で」 for the pane's edge), in place of v26's cross;
// recorded under a new rule id (MACDH_RULE_ID). The charts (the five pairs'
// and gold's 1-hour), the bars, the window, the freshness, the read times,
// the stop and targets, the subscriptions and the other rules are as they
// were. Put out after GMO's day rolls (21:30-21:50 UTC), so a morning check
// counts each day under one rule.
// v30 (#362, docs §8.122): the same rule with the band from 95% (ZONE_PCT),
// the owner's 「やっぱりメールの判断を95%に設定して」 (2026-10-19), recorded
// under its own rule id (MACDH_RULE_ID, ..._z95of120_v6); nothing else
// changes. (v29, the 80% cross rule of #359, was never put out, docs §8.121.)
// Put out after GMO's day rolls, as v28 was.
// v31 (#384, docs §8.127): the same rule judged on the 15-minute chart of the
// same six (the five pairs' GMO bars, gold's Twelve Data bars) in place of the
// 1-hour one (indicators.ts MACDH_INTERVALS), the owner's 「メールの判断15分足に
// 変更して」 (2026-10-26), recorded under its own rule id (MACDH_RULE_ID,
// ..._15min_z95of120_v7); the owner's subscriptions are moved to the
// 15-minute chart once it is out. The 600 bars, the 120-bar pane, the 95%,
// the stop and targets and the other rules are as they were. Put out at once
// on the owner's 「確かめなくていい、15分足に変更してくれればそれでいい」, in the
// middle of a GMO day (not after the day rolls, as v28 and v30 were).
// v32 (#385, docs §8.128): a fifth rule beside them, 'amdpo3' — AMD Po3's DIST
// (WillyAlgoTrader's indicator, _shared/amd-po3.ts, at its default settings:
// the manipulation confirmed, the reference trade opened at the bar's close),
// on the charts Q-Trend and ULTRA are mailed on, judged on the same bars
// (indicators.ts amdpo3Signals), recorded under AMDPO3_RULE_ID; the owner's
// 「エントリーのタイミングが来たらこれも設定でメールが届く様にもして」. The
// other rules are as they were.
// v33 (#386, docs §8.129): the MACD rule back on the 1-hour chart of the same
// six (indicators.ts MACDH_INTERVALS), the owner's 「やっぱりメールの判断を
// 1時間にしてください」 (2026-10-30): v30's rule again (600 bars, 120-bar pane,
// 95%), recorded under its own rule id (MACDH_RULE_ID, ..._1h_z95of120_v8);
// the owner's subscriptions are moved back to the 1-hour chart once it is out.
// Put out at once, in the middle of a GMO day, as v31 was. The other rules are
// as they were.
// v34 (#387, docs §8.130): a sixth rule beside them, 'emarm' — the owner's
// video's EMA 20 / 200 way (the cross, the candle back to the 200 EMA, the
// diagonal and horizontal necklines' break, the return move, the bar past
// its body), on the 15-minute chart of the same six (indicators.ts
// EMARM_PAIRS, EMARM_INTERVALS), judged on the 600 closed bars ending at the
// bar with the chart's code (_shared/ema-return.ts; indicators.ts
// emarmSignals), recorded under EMARM_RULE_ID; the owner's 「この機能追加して」
// with 「チャートとメール」 and 「今の5ペア＋金の15分足」. The other rules are as
// they were.
// v35 (#391): the MACD email on shares (stocks.ts; docs §8.134): the MACD
// email's rule (v8's numbers) on the hourly bars of the 22 US and Japanese
// shares measured in docs §8.133, read from Yahoo as the live chart reads
// them, judged by its own run ({"mode": "stocks"}, every minute: a share's
// bars read only in the half hour after one of its bars closes), mailed to
// the shares subscribed with rule = 'stockmacd' under STOCKMACD_RULE_ID, with
// no stop or target (the owner: 「出す、利確幅はいらない、自分で決める」).
// The other rules are as they were.
// v36 (#395, docs §8.138): a sharp rise or fall of the 1-hour bar ('spike'):
// the owner's 「チャートが1時間足で急激に上がったり、下がったりしたらメール
// ください」 with 「3倍以上」, 「足の途中ですぐ」 and 「5ペア＋金」. Every minute
// the "indicators" run reads each followed chart's forming 1-hour bar (and
// the newest closed one, while it closed at most SPIKE_LATE_MS ago) and mails
// it once a side when its high (low) has gone SPIKE.k times the mean range of
// the 120 closed bars before it from its open (_shared/spike.ts; indicators.ts
// spikeSignals), recorded under SPIKE_RULE_ID. Gold's hour is made of the
// minutes recorded from Swissquote (goldHourBar), its range from Twelve
// Data's bars. An hour's range is worked out once and kept in
// public.spike_ranges (the bars are too much to read every minute: the
// database's egress). The other rules are as they were.
// v37 (docs §8.140): a share's bar is closed only once its end has passed and
// Yahoo has priced at or past it, or a bar that opens at or after its end is
// there (stocks.ts stockBarsOf); Yahoo's point at the last price after the
// forming bar is joined to it (live-chart/stocks.ts). On 2026-11-05 the
// forming bar was judged as closed from 15:32 UTC on, so the bar that closed
// after it would not have been judged. The other rules are as they were.
// v38 (docs §8.141): a Tokyo share's email says that Yahoo's Tokyo prices
// come about 15 minutes late (stocks.ts). The other rules are as they were.
// v39 (#397, docs §8.150): the MACD email ('macdx') is a ride, the owner's
// 「MACD 90%→96%: 足の確定で入ると 96% まで行く メールをこれに変更、なので、
// 一つのペアで2回メールを送る」 (2026-11-12; _shared/macd-ride.ts,
// research/macdride-spec.md), in place of v33's 95% email, which is stopped.
// Email 1 at the close of the 1-hour bar at which the blue line came into the
// 90% band of the MACD pane's top (a BUY) or bottom (a SELL), the bar before
// outside it: an entry with the flow, the opposite side of the 95% email's;
// a notice in its place when the line is already at 96% at that close; email
// 2 the moment the line reaches 96% of the same edge, with the profit or loss
// since email 1 (measured on the five pairs, docs §8.149: of the 800 trades
// that reached 96%, 429 were at a loss, so it reports the line, not a
// profit). No stop, no target, no other way out; while a ride is held no new
// email 1 for its chart and side. A ride is one row of public.macd_rides (for
// all the chart's followers together; opened at a close, patched once when
// reached, never deleted); the state of the forming 1-hour bar is worked out
// at each close and kept in public.macd_ride_state, so that every minute the
// "indicators" run reads a few bytes, the forming bar's high and low so far
// (GMO's 1-hour bar, the read shared with the sharp rise; gold's recorded
// minutes) and tells whether the line has touched 96%. A touch in a time
// nothing was read is found by the next close's catch-up and mailed as seen
// late. Each mail is recorded under its own rule id (MACDH_RULE_ID,
// ..._ride90to96of120_in_v9; MACDH_AT_RULE_ID, ..._at_v9; MACDH_OUT_RULE_ID,
// ..._out_v9), email 2's row under the ride's entry bar. The charts (the five
// pairs' and gold's 1-hour), the bars and the subscriptions are as they were;
// the rule is named 「MACD の流れ」 / "MACD ride" in the mails. The shares'
// email (stocks.ts, the "stocks" run) becomes the same ride in this version,
// judged at each 1-hour close. Put out in minutes 30 to 59 of an hour, the
// migration first, so no bar is mailed by both versions. The other rules are
// as they were.
// v40 (docs §8.155; research/macdfade1h-prod-spec.md; the study
// research/macdfade15-spec.md "On 1-hour bars (TF=1h)", Actions run
// 44099401423): the MACD email ('macdx') is the fade on the same 1-hour
// charts, the owner's 「もうシンプル96%の足できたら逆張りのメールちょうだい」,
// then 「メールを1時間足から15分足に変更」, then 「やっぱりメールの判断1時間足
// で」 (2026-11-17), in place of v39's ride, which is stopped. One email at
// the close of the 1-hour bar at which the MACD line (blue) is at 96% or more
// of the top (a SELL) or bottom (a BUY) of the pane of the newest 120 bars,
// the bar before not at 96% (_shared/macd-fade.ts fadeCloseEntryAt, on the
// 600 closes ending at the bar), with the price in only: a pair's ask close
// for a BUY and bid close for a SELL of GMO's 1-hour bar (the read the
// chart's closes come from), gold's close. No take-profit and no stop price,
// nothing sent after it, and nothing read or kept each minute for it: the
// decision is the closed bars', worked out again at each judging; one email a
// follower by the claim key, and one side a bar (a row of the other side:
// nothing mailed, other_side). Recorded under MACDH_RULE_ID,
// macdx_12_26_9_w600_1h_fade96of120_in_v11 (indicators.ts). The charts, the
// read times, the freshness and the subscriptions are v39's (the five pairs'
// and gold's 1-hour charts; no subscription moves). The rule is named
// 「MACD の逆張り」 / "MACD fade" in the mails. The tables of v39's rides
// (public.macd_rides, macd_ride_state) are written no more (v9's morning
// check and a rollback read them). The shares' email is replaced in this
// version too (stocks.ts). The other rules are as they were.
// v41 (research/macdfade15min-prod-spec.md; the study research/macdfade15-spec.md
// on both charts): the same fade, each pair on its own chart, the owner's
// per-pair decision (2026-11-19: each pair's email on the timeframe of its
// higher win rate; gold stays on 1-hour bars until it is measured another
// way; the shares on 15-minute bars). USD/JPY and AUD/USD: the 15-minute
// chart, read 0, 1 and 3 minutes after each quarter hour (gmoIntervalsDue),
// fresh 20 minutes (freshFor("15min")), recorded under
// macdx_12_26_9_w600_15min_fade96of120_in_v12; v40's 1-hour email of theirs
// stops when v41 starts (a replacement, not a second email). EUR/JPY,
// AUD/JPY, EUR/USD and gold: v40's 1-hour chart, reads and freshness,
// recorded under v40's macdx_12_26_9_w600_1h_fade96of120_in_v11 (the same
// rule on the same chart, so a 1-hour close judged by both versions at the
// switch is mailed once a follower). One map says each pair's chart
// (indicators.ts MACDH_INTERVAL_OF; macdhRuleId gives the chart's id); the
// price in is a pair's ask close for a BUY and bid close for a SELL of GMO's
// bar of its own chart, kept from the same read in fadeQuotes under
// `${pair}|${interval}` (hourQuotes stays the sharp rise's). Each pair's
// mail carries the numbers of its own chart's run of record only
// (_shared/macd-fade-measured.ts: run 44535888012 on 15 minutes, 44555599946
// on 1 hour). The shares: Yahoo's 15-minute bars, their closes every 15
// minutes of the regular session (stocks.ts), recorded under
// stockmacd_12_26_9_w600_15min_fade96of120_in_v5; a "stocks" run starts no
// Yahoo read once it has spent STOCK_RUN_BUDGET_MS (30 seconds; the shares
// left are read first by the next run), since it shares pg_net's one queue
// with the other runs. 'macdx' is read, offered and accepted on each pair's
// own chart only (the status call sends it as macdx.limited), 'stockmacd' on
// the 15-minute chart only, so the '1h' rows of USD/JPY and AUD/USD under
// 'macdx' and every '1h' 'stockmacd' row get a '15min' twin before the
// release (spec 3.6, by hand, no migration); the other four's '1h' 'macdx'
// rows stay. `set` and `set_many` send created_at with each tick, and the
// test mail lists only the rows this version mails (spec 3.6). The other
// rules are as they were. (The date below is set again at the release.)
const FUNCTION_VERSION = "signal-alerts-v41-2026-11-23";

const MIN = 60_000;
// What one sweep may spend on the feed before it stops starting new charts
const FETCH_BUDGET_MS = 90_000;
// One test email per user per this long
const TEST_COOLDOWN_MS = 5 * MIN;
const RECENT_ALERTS = 20;
// How far back the record shown in the app reaches
const RECORD_DAYS = 365;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sweep-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const gmoFetcher: Fetcher = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
};

interface Subscription {
  user_id: string;
  pair: string;
  interval: string;
  lang: string;
  rule: RuleKey;
}

// #155: a chart followed under Q-Trend, ULTRA, the MACD rule (#275) or the
// video's way (#291)
interface IndicatorSub {
  user_id: string;
  pair: string;
  interval: string;
  lang: string;
  rule: IndicatorRule;
}

// ---- #155: what the "indicators" sweep keeps between its runs ----------------------------
//
// GMO's ended files (indicators.ts "GMO's files, kept"): those this instance
// has read, by klineFileKey; the table keeps them across instances, and each
// chart's are read from it once an instance
const klineMemory = new Map<string, unknown>();
const KLINE_MEMORY_MAX = 6000;
// (#395: and how many days of them, a chart's read being 600 bars and the
// sharp rise's range 123)
const klinePreloaded = new Map<string, number>();
// each chart's newest closed bar judged (its open, ms), so one close is
// judged once an instance
const judgedBar = new Map<string, number>();
// #395: each 1-hour bar's R this instance worked out (pair|bar open), so a
// worker whose store into public.spike_ranges failed does not read the big
// rows again the next minute
const spikeRangeMemo = new Map<string, JsonRecord>();
const SPIKE_RANGE_MEMO_MAX = 500;
// (#397: v39 kept each forming 1-hour bar's MACD ride state here, a copy of
// its row in public.macd_ride_state; v40's fade keeps nothing between runs)
// when each Twelve Data chart was last read here (besides the stored row's
// time, which twelveReadDue goes by: this holds when storing it failed)
const twelveReadAt = new Map<string, number>();
// where each Twelve Data chart's bars start within their length
// (twelvePhase), learned from its bars; 0 until they are seen
const twelvePhaseOf = new Map<string, number>();
// GMO's public API a request at a time, a fifth of a second apart
let gmoNextAt = 0;
const GMO_GAP_MS = 200;
// a sweep that runs past the minute is not joined by the next one in the
// same instance (it would read the same charts again)
let indicatorSweepRunning = false;
// #291: the minute (its start, ms) this instance's "gold-ticks" run is
// reading, so a second call for the same minute does not read it twice (the
// next minute's run may begin while this one ends)
let goldTicksMinute: number | null = null;
// #391: each share's newest closed bar judged (its open), the close whose bar
// is in (done for that close), and when Yahoo was last read for it, in this
// instance; and a "stocks" run not joined by the next one (#397: a bar is
// held judged, and its close done, only once the MACD email's work on it
// left nothing to try again; v40: the fade's, which keeps nothing in a table)
const stockJudged = new Map<string, number>();
const stockDone = new Map<string, number>();
const stockReadAt = new Map<string, number>();
let stockSweepRunning = false;
// Resend allows two requests a second
let sendNextAt = 0;
const SEND_GAP_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return json({ ok: false, error: "サーバー設定エラー" }, 500);
    }
    const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
    const emailConfigured = resendKey.length > 0;
    const from = Deno.env.get("ALERT_FROM") || DEFAULT_FROM;

    const serviceHeaders = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    };
    const rest = (path: string, init: RequestInit = {}) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders, ...(init.headers ?? {}) } });
    const readRows = async (path: string): Promise<JsonRecord[]> => {
      const res = await rest(path);
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("read failed:", path.split("?")[0], res.status);
      return Array.isArray(rows) ? rows.filter(isRecord) : [];
    };
    const patchRow = async (id: string, body: JsonRecord) => {
      const res = await rest(`signal_alerts?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) console.error("patch failed:", res.status, await res.text().catch(() => ""));
    };
    // Inserts one alert row unless the same signal is already logged for the
    // same subscriber. The unique key is the claim: two overlapping sweeps
    // cannot both mail it.
    const claimRow = async (row: JsonRecord): Promise<string | null> => {
      const res = await rest("signal_alerts?on_conflict=user_id,kind,pair,interval,bar_time,side,rule", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("insert failed:", res.status, await res.text().catch(() => ""));
      return Array.isArray(rows) && rows.length > 0 && isRecord(rows[0]) && typeof rows[0].id === "string" ? rows[0].id : null;
    };
    // A follower's address as the auth service gives it. `ok` false: the
    // lookup itself failed (an answer that is neither 200 nor "no such
    // user", or a body that cannot be read). That is not a follower with no
    // address: the indicators' mailer claims no row then, so that a later
    // run that offers the same mail tries again (#397)
    const userEmailRead = async (userId: string): Promise<{ ok: boolean; email: string | null }> => {
      const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: serviceHeaders });
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: res.status === 404, email: null };
      }
      const body = await res.json().catch(() => null);
      if (!isRecord(body)) return { ok: false, email: null };
      return { ok: true, email: typeof body.email === "string" && body.email.length > 0 ? body.email : null };
    };
    const userEmail = async (userId: string): Promise<string | null> => (await userEmailRead(userId)).email;
    // One row per signal, whoever follows the chart. The unique key makes a
    // second sweep that sees the same bar a no-op; either way the id comes back.
    const eventId = async (row: JsonRecord): Promise<string | null> => {
      const res = await rest("signal_events?on_conflict=pair,interval,bar_time,side,rule", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("event insert failed:", res.status, await res.text().catch(() => ""));
      if (Array.isArray(rows) && rows.length > 0 && isRecord(rows[0]) && typeof rows[0].id === "string") return rows[0].id;
      const found = await readRows(
        `signal_events?pair=eq.${encodeURIComponent(String(row.pair))}&interval=eq.${encodeURIComponent(String(row.interval))}` +
          `&bar_time=eq.${encodeURIComponent(String(row.bar_time))}&side=eq.${encodeURIComponent(String(row.side))}` +
          `&rule=eq.${encodeURIComponent(String(row.rule))}&select=id`,
      );
      return found.length > 0 && typeof found[0].id === "string" ? found[0].id : null;
    };
    const planOf = async (userId: string): Promise<string | null> => {
      const rows = await readRows(`profiles?id=eq.${encodeURIComponent(userId)}&select=plan`);
      return rows.length > 0 && typeof rows[0].plan === "string" ? rows[0].plan : null;
    };
    // Mail one claimed row and record what happened to it
    const deliver = async (id: string, to: string | null, mail: ReturnType<typeof renderTestMail>): Promise<string> => {
      if (!emailConfigured) {
        await patchRow(id, { status: "not_configured" });
        return "not_configured";
      }
      if (!to) {
        await patchRow(id, { status: "failed", error: "no_email" });
        return "failed";
      }
      // #155: two a second at most (Resend's limit), once more after a
      // "429 rate limit"
      const send = async () => {
        const at = Math.max(Date.now(), sendNextAt);
        sendNextAt = at + SEND_GAP_MS;
        await sleep(at - Date.now());
        return await sendMail(resendKey, from, to, mail);
      };
      let sent = await send();
      if (!sent.ok && sent.error.startsWith("429") && !/quota/i.test(sent.error)) {
        await sleep(1_500);
        sent = await send();
      }
      if (sent.ok) {
        await patchRow(id, { status: "sent", provider_id: sent.id, sent_at: new Date().toISOString() });
        return "sent";
      }
      console.error("send failed:", sent.error);
      await patchRow(id, { status: "failed", error: sent.error });
      return "failed";
    };

    // One more Twelve Data read counted for the UTC day, unless the day's
    // count has reached `cap` (live-chart's own, the same table); counting
    // that fails lets the read go ahead
    const takeTwelveRead = async (cap: number): Promise<boolean> => {
      try {
        const r = await rest("rpc/take_twelve_data_credit", { method: "POST", body: JSON.stringify({ p_cap: cap }) });
        if (!r.ok) {
          console.error("twelve data count failed:", r.status, await r.text().catch(() => ""));
          return true;
        }
        return (await r.json().catch(() => true)) !== false;
      } catch (err) {
        console.error("twelve data count failed:", err);
        return true;
      }
    };

    // #155: each fresh signal of Q-Trend, ULTRA (#275: the MACD rule; #291:
    // the video's way) to each of `subs` following its chart under its rule,
    // once (the claim's unique key); what happened, counted into `counts`
    const mailerFor = (subs: IndicatorSub[], counts: Record<string, number>) => {
      const access = new Map<string, { allowed: boolean; email: string | null; unread: boolean }>();
      return async (sigs: IndicatorSignal[]) => {
        for (const sig of sigs) {
          for (const sub of subs.filter((x) => x.pair === sig.pair && x.interval === sig.interval && x.rule === sig.rule)) {
            let who = access.get(sub.user_id);
            if (!who) {
              const [plan, address] = await Promise.all([planOf(sub.user_id), userEmailRead(sub.user_id)]);
              who = { allowed: alertsAllowed(plan, address.email), email: address.email, unread: !address.ok };
              access.set(sub.user_id, who);
            }
            if (!who.allowed) {
              counts.not_allowed = (counts.not_allowed ?? 0) + 1;
              continue;
            }
            // #397: the address could not be looked up (the lookup failed,
            // which is not "no address"). No row is claimed: a row would be
            // marked failed for good and keep every later run from mailing
            // this follower. Counted, so the run's record says it; a later
            // run that offers the mail again (the bar judged again; a ride's
            // mails and the sharp rise's while they are offered; v40: the
            // fade's when its bar is judged again) tries again
            if (who.unread) {
              counts.lookup_failed = (counts.lookup_failed ?? 0) + 1;
              continue;
            }
            // #397: the bar, the side, the prices and the rule id as the
            // signal's row says them (indicators.ts signalRow): a rule's
            // own id, and a mail of the MACD ride under that mail's (email
            // 2's row under the ride's entry bar, its closed_at when the
            // reach was seen, its entry the ride's and its target the price
            // when seen); v40: the fade's under its id, its entry the price
            // in, no stop and no target
            const id = await claimRow({
              user_id: sub.user_id,
              kind: "signal",
              pair: sig.pair,
              interval: sig.interval,
              ...signalRow(sig),
              rsi: sig.rsi,
              rsi_prev: sig.rsiPrev,
              sar: null,
              atr: sig.eps,
              strong: sig.rule === "qtrend" ? sig.strong : null,
              event_id: null,
              status: "pending",
            });
            if (id === null) {
              counts.duplicate = (counts.duplicate ?? 0) + 1;
              continue;
            }
            const lang: Lang = isLang(sub.lang) ? sub.lang : "ja";
            const outcome = await deliver(id, who.email, renderIndicatorMail(sig, lang));
            counts[outcome] = (counts[outcome] ?? 0) + 1;
          }
        }
      };
    };

    // ---- v40 (docs §8.155): the MACD fade's one email, mailed once a follower ---------------------
    //
    // For the "indicators" run (the five pairs and gold) and the "stocks" run
    // (the shares). (#397: v39's ride kept its trades in public.macd_rides,
    // opened and reached here; v40 reads and writes neither of its tables.)
    // No user id, address or row id goes into a log or a run's record from
    // here.
    //
    // What an error says, without any address in it (a request that could
    // not be sent names its URL, and a lookup's URL holds a follower's id):
    // what the MACD email's catches log, in both runs.
    const errText = (err: unknown): string =>
      (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/https?:\/\/\S+/g, "(url)");

    // One mail (the fade's one email, as a signal; #397: v39's ride's three)
    // to the followers of its chart under its rule who have no row for it yet.
    // Those whose row is in the table are left out before any lookup, as the
    // sharp rise's are, and the claim's unique key keeps two runs from both
    // mailing: each follower once, and a follower a run failed on (a lookup
    // that failed) is mailed by a later run. `made`: the rows made in this run
    // (sent, failed or not configured); `had`: the rows of the signal's side
    // there already; `why`: why a follower left got none. Counted into
    // `counts` even when a lookup throws partway.
    // v40 (research/macdfade1h-prod-spec.md 2.5): one side a bar. The bar's
    // rows under the rule's id are read whatever their side (the read has no
    // side filter): a row of the other side there means nothing is mailed,
    // and `otherSide` says so (only a feed that changed the closed bars
    // between two judgings can cause it). The read is rest()'s, not
    // readRows()'s: readRows gives no rows when the read fails, which would
    // be taken as "no row of either side" and mail a side whose other side
    // the bar may already have. A read that fails, or gives no list, throws
    // before anything is mailed: an exception, so the bar is left unsettled
    // (spec 3.2 step 5; a share's not settled, 3.3) and judged again at the
    // next read
    const mailRide = async (
      sig: IndicatorSignal,
      subs: IndicatorSub[],
      counts: Record<string, number>,
    ): Promise<{ made: number; had: number; why: string; otherSide: boolean }> => {
      const row = signalRow(sig);
      const e = encodeURIComponent;
      const res = await rest(
        `signal_alerts?kind=eq.signal&pair=eq.${e(sig.pair)}&interval=eq.${e(sig.interval)}&bar_time=eq.${e(row.bar_time)}&rule=eq.${e(row.rule)}&select=user_id,side`,
      );
      const read: unknown = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) await res.body?.cancel();
      if (!Array.isArray(read)) throw new Error(`rows_unread: signal_alerts ${res.status}`);
      const there = read.filter(isRecord);
      const mine = there.filter((r) => r.side === row.side);
      if (mine.length < there.length) return { made: 0, had: mine.length, why: "", otherSide: true };
      const done = new Set(mine.map((r) => String(r.user_id)));
      const left = subs.filter((x) => x.rule === sig.rule && x.pair === sig.pair && x.interval === sig.interval && !done.has(x.user_id));
      if (left.length === 0) return { made: 0, had: done.size, why: "", otherSide: false };
      const these: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, duplicate: 0, not_allowed: 0, lookup_failed: 0 };
      try {
        await mailerFor(left, these)([sig]);
      } finally {
        for (const [k, v] of Object.entries(these)) if (v > 0 || k in counts) counts[k] = (counts[k] ?? 0) + v;
      }
      return {
        made: these.sent + these.failed + these.not_configured,
        had: done.size,
        why: ["not_allowed", "lookup_failed", "duplicate"].filter((k) => these[k] > 0).join(","),
        otherSide: false,
      };
    };

    const nowMs = Date.now();
    const bodyRaw = await req.json().catch(() => null);
    const body: JsonRecord = isRecord(bodyRaw) ? bodyRaw : {};

    // ---- #155: Q-Trend's and ULTRA's signals (indicators.ts) --------------------------------
    //
    // The charts due at this minute that somebody follows: GMO's read with
    // its ended files kept, Twelve Data's from the bars the live chart keeps
    // (public.live_chart_fallback, read again here when no bar of this close
    // is in them, within the day's reads), each judged as the chart judges
    // it, each fresh signal mailed once per subscriber.
    const indicatorSweep = async (): Promise<JsonRecord> => {
      // #171: a bar that closed at this minute is read from a second after it
      // (indicators.ts startWaitMs), and this run's clock is taken then — it
      // shadows the request's, which this run may have waited past
      const wait = startWaitMs(Date.now());
      if (wait > 0) await sleep(wait);
      const nowMs = Date.now();
      const summary: JsonRecord = { ok: true, mode: "indicators", version: FUNCTION_VERSION, email_configured: emailConfigured };
      if (isPossiblyClosed(nowMs)) return { ...summary, skipped: "market_closed" };
      const minute = new Date(nowMs).getUTCMinutes();
      // GMO's files kept past two months are not needed again (the hourly
      // chart reaches back some 40 days)
      if (new Date(nowMs).getUTCHours() === 3 && minute === 7) {
        const res = await rest(`gmo_kline_files?fetched_at=lt.${encodeURIComponent(new Date(nowMs - 60 * 24 * 60 * MIN).toISOString())}`, { method: "DELETE" });
        if (!res.ok) console.error("kline purge failed:", res.status, await res.text().catch(() => ""));
      }
      // (#291: not the video's way, 'sweepx': gold's 1-minute chart is judged by
      // the "gold-ticks" run on the minutes it records, and read here it would
      // be a Twelve Data chart read every minute)
      // (#385: and AMD Po3's, 'amdpo3'; #387: and the EMA 20 / 200 way's, 'emarm';
      // #395: and a sharp rise's or fall's, 'spike', read every minute below)
      const subs: IndicatorSub[] = (await readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm,spike)&select=user_id,pair,interval,lang,rule"))
        .filter((r) => typeof r.user_id === "string" && isIndicatorRule(r.rule) && r.rule !== "sweepx" && isIndicatorChartFor(r.rule, r.pair, r.interval) && typeof r.lang === "string")
        .map((r) => ({ user_id: r.user_id as string, pair: r.pair as string, interval: r.interval as string, lang: r.lang as string, rule: r.rule as IndicatorRule }));
      summary.subscriptions = subs.length;
      if (subs.length === 0) return summary;

      // the charts followed, due now: GMO's by the minute, Twelve Data's by
      // their close; the quicker timeframes first
      const gmoDue = gmoIntervalsDue(nowMs);
      const followed = [...new Set(subs.map((x) => `${x.pair}|${x.interval}`))].map((k) => {
        const [pair, interval] = k.split("|");
        return { pair, interval };
      });
      const order = (iv: string) => (INDICATOR_INTERVALS as readonly string[]).indexOf(iv);
      const gmoCharts = followed.filter((c) => isGmoChartPair(c.pair) && gmoDue.includes(c.interval)).sort((a, b) => order(a.interval) - order(b.interval));
      // Twelve Data's by where their own bars close (#212: twelveChartDue; a
      // chart whose bars this instance has not seen, by its own UTC grid under
      // an hour, else in the first half hour of every hour)
      const twelveCharts = followed.filter((c) =>
        isTwelvePair(c.pair) && twelveChartDue(c.interval, nowMs, twelvePhaseOf.get(`${c.pair}|${c.interval}`))
      ).sort((a, b) => order(a.interval) - order(b.interval));
      const deadline = Date.now() + FETCH_BUDGET_MS;
      const reads: JsonRecord[] = [];
      const fired: IndicatorSignal[] = [];
      const files = { memory: 0, table: 0, ended: 0, live: 0, stale: 0 };

      // GMO, a request at a time; once it says it is down for maintenance,
      // no more
      let maintenance = false;
      const paced = async (url: string) => {
        if (maintenance) return null;
        const at = Math.max(Date.now(), gmoNextAt);
        gmoNextAt = at + GMO_GAP_MS;
        await sleep(at - Date.now());
        const got = await gmoFetcher(url);
        if (typeof got === "object" && got !== null && (got as { status?: unknown }).status === 5) maintenance = true;
        return got;
      };
      const storeFile = async (f: KlineFile, body: unknown) => {
        const res = await rest("gmo_kline_files?on_conflict=symbol,price_type,interval,date_key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ symbol: f.symbol, price_type: f.priceType, interval: f.interval, date_key: f.date, body }),
        });
        if (!res.ok) console.error("kline store failed:", res.status, await res.text().catch(() => ""));
      };
      // an ended file from this instance, else from GMO (and kept); a file
      // still being written from GMO — #171: for a chart whose bars close at
      // `closeMs`, read again while GMO made its answer before that close and
      // the answer holds the bar (indicators.ts staleForClose), STALE_TRIES
      // times at most; past them the read fails, and a later run reads it
      const chartFetcher = (closeMs: number, stepMs: number): Fetcher => async (url) => {
        const f = klineFileOf(url);
        if (!f || !klineFileEnded(f.date, nowMs)) {
          files.live++;
          for (let tries = 1; ; tries++) {
            const got = await paced(url);
            if (got === null || maintenance || !staleForClose(got, closeMs, stepMs)) return got;
            files.stale++;
            if (tries >= STALE_TRIES || Date.now() + STALE_RETRY_MS > deadline) return null;
            await sleep(STALE_RETRY_MS);
          }
        }
        const k = klineFileKey(f);
        if (klineMemory.has(k)) {
          files.memory++;
          return klineMemory.get(k);
        }
        files.ended++;
        const body = await paced(url);
        if (keepableKlines(body)) {
          if (klineMemory.size >= KLINE_MEMORY_MAX) klineMemory.clear();
          klineMemory.set(k, body);
          await storeFile(f, body);
        }
        return body;
      };
      // a chart's kept files, from the table, once an instance (#395: as
      // many days as `bars` bars need; more again, if a later read needs more)
      const preload = async (pair: string, interval: string, bars: number = HISTORY_BARS + 1) => {
        const symbol = GMO_SYMBOLS[pair];
        const spec = GMO_INTERVALS[interval];
        if (!symbol || !spec) return;
        const key = `${symbol}|${spec.name}`;
        const days = spec.key === "day" ? klinePreloadDays(interval, bars) : Number.POSITIVE_INFINITY;
        if ((klinePreloaded.get(key) ?? 0) >= days) return;
        const since = spec.key === "day"
          ? jstDayKey(nowMs - days * 24 * 60 * MIN)
          : String(Number(jstYearKey(nowMs)) - 1);
        const rows = await readRows(
          `gmo_kline_files?symbol=eq.${encodeURIComponent(symbol)}&interval=eq.${encodeURIComponent(spec.name)}&date_key=gte.${since}&select=price_type,date_key,body`,
        );
        for (const r of rows) {
          if (typeof r.price_type !== "string" || typeof r.date_key !== "string" || !keepableKlines(r.body)) continue;
          if (klineMemory.size >= KLINE_MEMORY_MAX) klineMemory.clear();
          klineMemory.set(klineFileKey({ symbol, priceType: r.price_type, interval: spec.name, date: r.date_key }), r.body);
          files.table++;
        }
        klinePreloaded.set(key, Math.max(klinePreloaded.get(key) ?? 0, days));
      };
      // Each fresh signal to each follower of its chart, once (the claim's
      // unique key)
      const counts: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, duplicate: 0, not_allowed: 0 };
      const mailSignals = mailerFor(subs, counts);
      // #395: the hour now, and the 1-hour bars the sharp rise looks at (the
      // forming one, and the one before while it closed at most
      // SPIKE_LATE_MS ago)
      const HOUR = 60 * MIN;
      const hourMs = Math.floor(nowMs / HOUR) * HOUR;
      const spikeOpens = nowMs - hourMs <= SPIKE_LATE_MS ? [hourMs - HOUR, hourMs] : [hourMs];
      const isoOf = (ms: number) => new Date(ms).toISOString();
      const enc = encodeURIComponent;
      // #395: the stored bars this run read (or read again), for the sharp
      // rise's range below
      const twelveStored = new Map<string, { bars: Candle[]; fetchedAt: string }>();
      // #395: the 1-hour reads of this run, for the sharp rise and fall below
      // (v40 read the MACD fade's price in here too; v41's is fadeQuotes, below)
      const hourQuotes = new Map<string, QuoteCandle[]>();
      // v41 (research/macdfade15min-prod-spec.md 2.3, 3.2 item 5): this run's
      // reads of each pair's own MACD fade chart (isMacdhChart: USD/JPY and
      // AUD/USD on 15 minutes, EUR/JPY, AUD/JPY and EUR/USD on 1 hour), keyed
      // `${pair}|${interval}`: the judged bar's bid and ask closes, GMO's as
      // given, are its price in, from the same read the chart's closes are made
      // from. Keyed by chart, so no other chart's read of the same pair (one
      // followed under another rule, such as EUR/JPY's 15-minute chart under
      // 'emarm') can stand in. (Kept apart from hourQuotes, the sharp rise's,
      // which only a 1-hour read fills: with one map for both charts, the
      // other chart's pairs would get no quote and every entry of theirs would
      // end as no_price)
      const fadeQuotes = new Map<string, QuoteCandle[]>();

      // v40 (docs §8.155; research/macdfade1h-prod-spec.md 3.2): the MACD fade
      // on the chart of the five pairs and gold the rule is offered on (v40:
      // the 1-hour chart; v41: each pair's own chart, isMacdhChart through
      // MACDH_INTERVAL_OF, the 15-minute chart of USD/JPY and AUD/USD and the
      // 1-hour chart of EUR/JPY, AUD/JPY, EUR/USD and gold,
      // research/macdfade15min-prod-spec.md 3.2), for the charts somebody
      // follows under 'macdx' in this run (a chart nobody follows is not
      // judged for it; a row on a pair's other chart is not a follower).
      // (#397: v39's ride, rideAtClose and its minute's check, went with it)
      const fadeSubs = subs.filter((x) => x.rule === "macdx" && isMacdhChart(x.pair, x.interval));
      const fadePairs = [...new Set(fadeSubs.map((x) => x.pair))];
      // At a close of the chart `interval` (v41: the pair's own, "15min" or
      // "1h"), with the chart's
      // closed bars in hand (`closed`, oldest first; `newest` the newest one's
      // open): (1) not fresh (it closed more than freshFor(interval) ago, or
      // not yet; a bar ends LIVE_STEP_MS[interval] after its open): nothing;
      // (2) the entry at that bar, fadeCloseEntryAt on its 600 closes: none,
      // nothing; (3) the price in, a pair's ask close for a BUY and bid close
      // for a SELL of this run's read of that chart (fadeQuotes under
      // `${pair}|${interval}`: the quote whose open is the bar's, as v39's
      // email 1 paid), gold's the bar's
      // close; none: no_price, and the bar is left unsettled; (4) the signal,
      // under `interval` (the followers are matched on it) and the chart's id
      // (signalRuleId: v12 on '15min', v40's v11 on '1h'), mailed to the
      // chart's followers who have no row for it yet (mailRide: one side a
      // bar; on '1h' a row v40 wrote for the bar counts). Nothing is read or written
      // each minute for it and no state is kept: the decision is the closed
      // bars' own, worked out again at each judging. The record goes into
      // `out` as it is made ({ fresh, entry, price, error?, other_side? }), so
      // that a failure partway leaves what was done; said in the run's
      // signals only when a row was made for it in this run or was there
      // already, and, when a follower left got none, why (a plan with no
      // alerts or a lookup that failed: tried again when the bar is judged
      // again)
      const fadeAtClose = async (pair: string, interval: string, closed: Candle[], newest: number, out: { fade: JsonRecord; tags: string[]; unsent: string[] }) => {
        const gold = pair === GOLD;
        out.fade.fresh = false;
        out.fade.entry = null;
        out.fade.price = null;
        const step = LIVE_STEP_MS[interval];
        const age = nowMs - (newest + step);
        if (age < 0 || age > freshFor(interval)) {
          // not fresh: nothing (spec 3.2 step 1)
          return;
        }
        out.fade.fresh = true;
        const entry = fadeCloseEntryAt(closed.map((c) => c.close));
        if (entry === null) return;
        out.fade.entry = entry.side;
        const last = closed[closed.length - 1];
        const quote = gold ? null : (fadeQuotes.get(`${pair}|${interval}`) ?? []).find((x) => Date.parse(x.datetime) === newest) ?? null;
        const price = gold ? last.close : quote ? ridePaidAt(entry.side, quote) : Number.NaN;
        if (!Number.isFinite(price)) {
          out.fade.error = "no_price";
          return;
        }
        out.fade.price = price;
        const sig = fadeSignal("macdx", pair, interval, entry, { openMs: newest, closeMs: newest + step, close: last.close, price });
        const got = await mailRide(sig, fadeSubs, counts);
        if (got.otherSide) out.fade.other_side = true;
        if (got.made > 0) fired.push(sig);
        if (got.made + got.had > 0) out.tags.push(rideSignalTag(sig));
        if (got.why) out.unsent.push(got.why);
      };

      // #171: a chart's signals are mailed as soon as it is judged, before
      // the other charts due are read
      const judge = async (pair: string, interval: string, closed: Candle[], newest: number) => {
        // #275: the MACD peak-and-valley rule was judged here beside Q-Trend's
        // and ULTRA's (#324: from v25 the 1-hour rule's; #353: from v28 the
        // zone rule's, docs §8.119; #384: v31 on the 15-minute chart; #386:
        // v33 on the 1-hour chart again). #397: from v39 the MACD email was a
        // ride; v40: the fade, judged below, after the other rules' mails
        // (v41: on each pair's own chart, the interval passed on)
        const sigs = indicatorSignals(pair, interval, closed, nowMs);
        // #385: AMD Po3's DIST, apart: its failure must never cost the others
        // their emails (docs §8.128)
        try {
          sigs.push(...amdpo3Signals(pair, interval, closed, nowMs));
        } catch (err) {
          console.error("amdpo3 failed:", pair, interval, err);
        }
        // #387: the EMA 20 / 200 way, likewise apart (docs §8.130)
        try {
          sigs.push(...emarmSignals(pair, interval, closed, nowMs));
        } catch (err) {
          console.error("emarm failed:", pair, interval, err);
        }
        judgedBar.set(`${pair}|${interval}`, newest);
        fired.push(...sigs);
        // #171: how long after the bar closed it was judged, ms
        const judgedAfter = Date.now() - (newest + (LIVE_STEP_MS[interval] ?? 0));
        if (sigs.length > 0) await mailSignals(sigs);
        // v40 (docs §8.155): the MACD fade at this close, on a chart it is
        // offered on with a follower in this run. In its own try / catch:
        // nothing of it can cost the other rules their emails (they are out
        // by now) or the other charts their judgment
        const said: { fade: JsonRecord; tags: string[]; unsent: string[] } = { fade: {}, tags: [], unsent: [] };
        const faded = isMacdhChart(pair, interval) && fadePairs.includes(pair);
        if (faded) {
          try {
            await fadeAtClose(pair, interval, closed, newest, said);
          } catch (err) {
            console.error("macdx failed:", pair, interval, errText(err));
            said.fade.error = "failed";
          }
          if (said.unsent.length > 0) said.fade.unsent = said.unsent;
          // The fade's work on this bar did not finish (no price, an
          // exception): this instance does not hold the bar judged, so the
          // chart is read and judged again the next time it is due inside the
          // bar's fresh window, as a fresh instance would (v41: a 15-minute
          // pair at minutes 1 and 3, a 1-hour pair at minutes 3 and 5, gold
          // each minute to :29). Judging again sends nothing twice: the
          // other rules' mails and the fade's are claimed by their rows. A
          // follower left without a mail (a lookup that failed) does not make
          // the bar unsettled here: as for every other rule, that mail is
          // tried again only when the bar is judged again
          if (said.fade.error !== undefined) judgedBar.delete(`${pair}|${interval}`);
        }
        return {
          pair,
          interval,
          bars: closed.length,
          newest: new Date(newest).toISOString(),
          // (v40: the fade's email as "macdx:SELL" or "macdx:BUY"; #397: v39's
          // ride had "macdx-at:" and "macdx-out:" too)
          signals: [...sigs.map((x) => `${x.rule}:${x.side}${x.strong ? "!" : ""}`), ...said.tags],
          judged_after_ms: judgedAfter,
          ...(faded ? { fade: said.fade } : {}),
        };
      };

      // Twelve Data's first: a few reads at most, which GMO's many would
      // otherwise leave no time for
      let twelveLeft = TWELVE_READS_PER_RUN;
      const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
      for (const c of twelveCharts) {
        const key = `${c.pair}|${c.interval}`;
        const step = LIVE_STEP_MS[c.interval];
        const learn = (bars: Candle[]) => {
          const phase = twelvePhase(bars, c.interval);
          if (phase !== null) twelvePhaseOf.set(key, phase);
        };
        const closeNow = () => twelveCloseDue(c.interval, nowMs, twelvePhaseOf.get(key) ?? 0);
        const known = twelvePhaseOf.has(key);
        let close = known ? closeNow() : null;
        if (known && judgedBar.get(key) === (close as number) - step) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        // the bars the live chart keeps (live-chart index.ts fallbackBars)
        const rows = await readRows(`live_chart_fallback?pair=eq.${encodeURIComponent(c.pair)}&interval=eq.${encodeURIComponent(c.interval)}&select=bars,fetched_at`);
        let stored = rows.length > 0 && Array.isArray(rows[0].bars) && typeof rows[0].fetched_at === "string"
          ? { bars: rows[0].bars as Candle[], fetchedAt: rows[0].fetched_at as string }
          : null;
        if (stored) {
          learn(stored.bars);
          twelveStored.set(key, stored);
        } else if (!twelvePhaseOf.has(key)) twelvePhaseOf.set(key, 0);
        close = closeNow();
        // its bars close at another hour
        if (close === null) continue;
        let expected = close - step;
        if (judgedBar.get(key) === expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        const closedOfStored = (x: { bars: Candle[]; fetchedAt: string }) => historyOfBars(c.pair, c.interval, x.bars, nowMs, x.fetchedAt).candles;
        const hasClose = (x: { bars: Candle[]; fetchedAt: string } | null) => {
          if (!x) return false;
          const cl = closedOfStored(x);
          return cl.length > 0 && barOpenMs(cl[cl.length - 1].datetime) === expected;
        };
        if (!hasClose(stored)) {
          // read since the close (twice at most) and the bar was not there
          if (!twelveReadDue(close, stored ? Date.parse(stored.fetchedAt) : Number.NaN, nowMs)) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "not_yet" });
            continue;
          }
          if (!twelveKey || twelveLeft <= 0 || Date.now() > deadline || nowMs - (twelveReadAt.get(key) ?? 0) < TWELVE_RETRY_MS) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "waiting" });
            continue;
          }
          if (!(await takeTwelveRead(ALERT_TWELVE_CAP))) {
            reads.push({ pair: c.pair, interval: c.interval, error: "day_spent" });
            continue;
          }
          twelveLeft--;
          twelveReadAt.set(key, nowMs);
          try {
            const r = await fetch(twelveDataUrl(c.pair, c.interval, twelveKey, GOLD_BARS), { signal: AbortSignal.timeout(10_000) });
            const bars = parseTwelveData(await r.json().catch(() => null), c.interval);
            if (!r.ok || !bars || bars.length < 60) {
              reads.push({ pair: c.pair, interval: c.interval, error: "twelve_unavailable" });
              continue;
            }
            // as of the run's clock, as the live chart stamps its reads
            const fetchedAt = new Date(nowMs).toISOString();
            // kept for the chart as well, in its own shape
            const up = await rest("live_chart_fallback?on_conflict=pair,interval", {
              method: "POST",
              headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
              body: JSON.stringify({ pair: c.pair, interval: c.interval, bars, source: "twelvedata", fetched_at: fetchedAt }),
            });
            if (!up.ok) console.error("fallback store failed:", up.status, await up.text().catch(() => ""));
            stored = { bars, fetchedAt };
            twelveStored.set(key, stored);
            learn(bars);
          } catch (err) {
            console.error("twelve data read failed:", err);
            reads.push({ pair: c.pair, interval: c.interval, error: "twelve_unavailable" });
            continue;
          }
          // the bars read may start at another hour than was assumed
          close = closeNow();
          if (close === null) continue;
          expected = close - step;
          if (!hasClose(stored)) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "not_yet" });
            continue;
          }
        }
        const closed = closedOfStored(stored!);
        // #345: when the bars judged were read (the record of a gold judgment shows it: a read before the close
        // would not have the bar)
        reads.push({ ...(await judge(c.pair, c.interval, closed, expected)), twelve: true, fetched_at: stored!.fetchedAt, close: closed[closed.length - 1].close });
      }
      // #171: the 4-hour and daily charts' newest closed bar this hour (its
      // open), once the first of them read tells (hourCloseOf); null when
      // none closed this hour
      const yearNewest = new Map<string, number | null>();
      for (const c of gmoCharts) {
        const key = `${c.pair}|${c.interval}`;
        const step = LIVE_STEP_MS[c.interval];
        const spec = GMO_INTERVALS[c.interval];
        // on the day-keyed charts (5 min to 1 hour, on the UTC grid) the
        // newest closed bar is known before reading; on the others once a
        // pair of the timeframe was read this run
        let expected = spec.key === "day" ? Math.floor(nowMs / step) * step - step : null;
        if (spec.key === "year" && yearNewest.has(c.interval)) {
          const e = yearNewest.get(c.interval) as number | null;
          if (e === null) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "no_close" });
            continue;
          }
          expected = e;
        }
        if (expected !== null && judgedBar.get(key) === expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        if (Date.now() > deadline || maintenance) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: maintenance ? "maintenance" : "deadline" });
          continue;
        }
        await preload(c.pair, c.interval);
        // the chart's history read (the chart's own function), rounded as
        // drawn; #171: not from an answer GMO made before the close it is for
        const fetcher = chartFetcher(latestCloseMs(c.interval, nowMs), step);
        const quotes = await fetchLiveQuotes(c.pair, c.interval, nowMs, deadline, fetcher, HISTORY_BARS + 1);
        if (!quotes || quotes.length === 0) {
          reads.push({ pair: c.pair, interval: c.interval, error: maintenance ? "maintenance" : "unavailable" });
          continue;
        }
        if (c.interval === "1h") hourQuotes.set(c.pair, quotes);
        // v41: the read of a pair's own MACD fade chart, for its price in,
        // keyed by pair and chart (spec 3.2 item 5)
        if (isMacdhChart(c.pair, c.interval)) fadeQuotes.set(`${c.pair}|${c.interval}`, quotes);
        const closed = historyRead(c.pair, c.interval, quotes, nowMs).candles;
        const newest = closed.length > 0 ? barOpenMs(closed[closed.length - 1].datetime) : Number.NaN;
        // a read cut short is not the chart's history (a year-keyed read
        // holds what the chart's does, fewer than 600 on the daily chart)
        if (spec.key === "day" && closed.length < HISTORY_BARS) {
          reads.push({ pair: c.pair, interval: c.interval, error: "short", bars: closed.length });
          continue;
        }
        if (spec.key === "year" && expected === null) {
          const said = hourCloseOf(newest, c.interval, nowMs);
          if (said === "unknown") {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "unknown", newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null });
            continue;
          }
          yearNewest.set(c.interval, said === "closed" ? newest : null);
          if (said === "none") {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "no_close", newest: new Date(newest).toISOString() });
            continue;
          }
          expected = newest;
        }
        if (expected !== null && newest !== expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "not_yet", newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null });
          continue;
        }
        if (judgedBar.get(key) === newest) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        reads.push(await judge(c.pair, c.interval, closed, newest));
      }

      // #395 (docs §8.138): a sharp rise or fall of the 1-hour bar, seen as it
      // forms. Every minute, each followed chart's forming bar and its newest
      // closed one (while it closed at most SPIKE_LATE_MS ago), each against
      // its range R (indicators.ts spikeSignals). An hour's R is worked out
      // once (spikeRangeFor) and kept in public.spike_ranges: the bars it is
      // made of are some 120 KB a read (gold's stored Twelve Data bars) or
      // 150 KB (a pair's GMO files), too much to read every minute against
      // the database's egress. Worked out again when it was made from a read
      // a bar behind, or could not be: gold's once a newer stored read is
      // there, a pair's when this run read its 1-hour chart. The five pairs'
      // bars are GMO's 1-hour read (this run's, when the chart was read
      // above, else the newest file alone); gold's hour the minutes recorded
      // from Swissquote. Each bar and side is mailed to each follower once:
      // those whose row is already in the table are left out before any
      // lookup (and the claim's unique key keeps two runs from both mailing),
      // so a follower a run failed on is mailed by a later run. Its failure
      // must never cost the others theirs
      const spikePairs = [...new Set(subs.filter((x) => x.rule === "spike").map((x) => x.pair))];
      // #397: what the sharp rise read of the hour now (v39's MACD ride read
      // it too; v40's fade does not), each read once a run. A pair's: GMO's
      // 1-hour read that holds its
      // forming bar — the chart's own read when it was made above (hourQuotes),
      // else the newest file alone (and the one before, while the bar that
      // closed at its start is looked at), or the read the sharp rise's range
      // was made from in this run; null when it could not be read. Gold's:
      // its recorded minutes (public.gold_tick_bars, Swissquote's prices)
      // from the first bar looked at on
      const formingReads = new Map<string, QuoteCandle[] | null>();
      const formingQuotes = async (pair: string): Promise<QuoteCandle[] | null> => {
        const own = hourQuotes.get(pair);
        if (own) return own;
        if (!formingReads.has(pair)) {
          const got = await fetchLiveQuotes(pair, "1h", nowMs, deadline, chartFetcher(latestCloseMs("1h", nowMs), HOUR), spikeOpens.length);
          formingReads.set(pair, got && got.length > 0 ? got : null);
        }
        return formingReads.get(pair) ?? null;
      };
      let goldMinutesRead: Array<{ minute: string; open: number; high: number; low: number; close: number }> | null = null;
      const goldMinutes = async () => {
        goldMinutesRead ??= (await readRows(
          `gold_tick_bars?minute=gte.${enc(isoOf(spikeOpens[0]))}&select=minute,open,high,low,close&order=minute.asc`,
        ))
          .filter((m) => typeof m.minute === "string")
          .map((m) => ({ minute: m.minute as string, open: Number(m.open), high: Number(m.high), low: Number(m.low), close: Number(m.close) }));
        return goldMinutesRead;
      };
      const spikeRead = async (pair: string): Promise<JsonRecord> => {
        const gold = pair === GOLD;
        if (!gold && !isGmoChartPair(pair)) return { pair, interval: "1h", spike: true, error: "not_offered" };
        // each bar's R, as kept. The table not read (not there, an error): no
        // R is worked out, the big rows it is made of being what it saves
        const kept = new Map<number, JsonRecord>();
        const rangesRes = await rest(`spike_ranges?pair=eq.${enc(pair)}&bar_time=in.(${spikeOpens.map((t) => enc(isoOf(t))).join(",")})&select=bar_time,r,status,behind,source_read_at`);
        const rows = rangesRes.ok ? await rangesRes.json().catch(() => null) : null;
        if (!Array.isArray(rows)) {
          console.error("spike ranges read failed:", pair, rangesRes.status);
          return { pair, interval: "1h", spike: true, error: "ranges_unread", status: rangesRes.status };
        }
        for (const row of rows.filter(isRecord)) {
          const t = Date.parse(String(row.bar_time));
          if (Number.isFinite(t)) kept.set(t, row);
        }
        for (const t of spikeOpens) {
          const memo = spikeRangeMemo.get(`${pair}|${t}`);
          if (memo && !kept.has(t)) kept.set(t, memo);
        }
        // gold's R is made from the bars the live chart keeps: this run's read
        // of them (the Twelve Data loop above), else the stored read's time
        let goldStored = gold ? twelveStored.get(`${pair}|1h`) ?? null : null;
        let goldReadAt = goldStored ? Date.parse(goldStored.fetchedAt) : Number.NaN;
        if (gold && !goldStored) {
          const at = await readRows(`live_chart_fallback?pair=eq.${enc(pair)}&interval=eq.1h&select=fetched_at`);
          goldReadAt = at.length > 0 && typeof at[0].fetched_at === "string" ? Date.parse(at[0].fetched_at) : Number.NaN;
        }
        const pairRead = gold ? null : hourQuotes.get(pair) ?? null;
        // gold's new bar, while the stored read was made before it opened (the
        // Twelve Data loop reads the bars again from a minute past the hour):
        // its R a bar behind is the 120 bars before the bar before it, which
        // is that bar's R, kept — so it is taken from there, not worked out
        // from the whole stored row. Worked out again once a read of this
        // hour is there (behind 1)
        if (gold && !kept.has(hourMs) && !(goldReadAt >= hourMs)) {
          const prev = kept.get(hourMs - HOUR);
          if (prev && prev.status === "ok" && Number(prev.behind) === 0 && Number(prev.r) > 0) {
            kept.set(hourMs, {
              bar_time: isoOf(hourMs),
              r: Number(prev.r),
              status: "ok",
              behind: isPossiblyClosedFor(pair, hourMs - HOUR) ? 0 : 1,
              source_read_at: prev.source_read_at ?? null,
              from_bar_before: true,
            });
          }
        }
        const again = (t: number): boolean => {
          const row = kept.get(t);
          if (row?.from_bar_before === true) return false;
          if (!row) return true;
          if (row.status === "ok" && Number(row.behind) === 0) return false;
          if (gold) {
            const at = typeof row.source_read_at === "string" ? Date.parse(row.source_read_at) : Number.NaN;
            return Number.isFinite(goldReadAt) && !(at >= goldReadAt);
          }
          return pairRead !== null;
        };
        const need = spikeOpens.filter(again);
        let storeFailed = false;
        if (need.length > 0) {
          let history: Candle[] | null = null;
          if (gold) {
            if (!goldStored) {
              const st = await readRows(`live_chart_fallback?pair=eq.${enc(pair)}&interval=eq.1h&select=bars,fetched_at`);
              if (st.length > 0 && Array.isArray(st[0].bars) && typeof st[0].fetched_at === "string") {
                goldStored = { bars: st[0].bars as Candle[], fetchedAt: st[0].fetched_at as string };
              }
            }
            if (goldStored) {
              history = historyOfBars(pair, "1h", goldStored.bars, nowMs, goldStored.fetchedAt).candles;
              goldReadAt = Date.parse(goldStored.fetchedAt);
            }
          } else {
            let quotes = pairRead;
            if (!quotes && Date.now() <= deadline && !maintenance) {
              // the table's files for the bars R needs, not the chart's 600
              await preload(pair, "1h", SPIKE.bars + 3);
              quotes = await fetchLiveQuotes(pair, "1h", nowMs, deadline, chartFetcher(latestCloseMs("1h", nowMs), HOUR), SPIKE.bars + 3);
              // #397: this read holds the forming bar too: it is the run's
              // one read of it (formingQuotes)
              if (quotes && quotes.length > 0) formingReads.set(pair, quotes);
            }
            if (quotes && quotes.length > 0) history = historyRead(pair, "1h", quotes, nowMs).candles;
          }
          if (history) {
            for (const t of need) {
              const g = spikeRangeFor(pair, history, t);
              const row: JsonRecord = {
                pair,
                bar_time: isoOf(t),
                r: g.r,
                status: g.status,
                behind: g.behind,
                last_bar: g.lastBar === null ? null : isoOf(g.lastBar),
                source_read_at: gold && Number.isFinite(goldReadAt) ? isoOf(goldReadAt) : null,
                computed_at: new Date().toISOString(),
              };
              kept.set(t, row);
              if (spikeRangeMemo.size >= SPIKE_RANGE_MEMO_MAX) spikeRangeMemo.clear();
              spikeRangeMemo.set(`${pair}|${t}`, row);
              const res = await rest("spike_ranges?on_conflict=pair,bar_time", {
                method: "POST",
                headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
                body: JSON.stringify(row),
              });
              if (!res.ok) {
                storeFailed = true;
                console.error("spike range store failed:", res.status, await res.text().catch(() => ""));
              }
            }
            // the rows over three days old
            const old = await rest(`spike_ranges?pair=eq.${enc(pair)}&bar_time=lt.${enc(isoOf(hourMs - 72 * HOUR))}`, {
              method: "DELETE",
              headers: { Prefer: "return=minimal" },
            });
            if (!old.ok) console.error("spike range clean failed:", old.status, await old.text().catch(() => ""));
          }
        }
        // the bars looked at
        const candidates: Array<{ bar: Candle; forming: boolean }> = [];
        if (gold) {
          const minutes = await goldMinutes();
          for (const t of spikeOpens) {
            const bar = goldHourBar(minutes, t);
            if (bar) candidates.push({ bar, forming: t === hourMs });
          }
        } else {
          let quotes = pairRead;
          if (!quotes) {
            if (!formingReads.has(pair) && (Date.now() > deadline || maintenance)) return { pair, interval: "1h", spike: true, skipped: maintenance ? "maintenance" : "deadline" };
            // the newest file (and the one before, while the bar that closed
            // at its start is looked at): GMO's, not the table's (#397: the
            // run's one read of the forming bar)
            quotes = await formingQuotes(pair);
          }
          if (!quotes || quotes.length === 0) return { pair, interval: "1h", spike: true, error: maintenance ? "maintenance" : "unavailable" };
          const read = historyRead(pair, "1h", quotes, nowMs);
          for (const c of read.candles) if (spikeOpens.includes(barOpenMs(c.datetime))) candidates.push({ bar: c, forming: false });
          const f = splitBars(quotes, "1h", nowMs).forming;
          const rd = (v: number) => Number(v.toFixed(read.decimals));
          if (f && barOpenMs(f.datetime) === hourMs) {
            candidates.push({ bar: { datetime: f.datetime, open: rd(f.open), high: rd(f.high), low: rd(f.low), close: rd(f.close) }, forming: true });
          }
        }
        const usable = new Map<number, { r: number; behind: number }>();
        for (const [t, row] of kept) {
          const r = Number(row.r);
          if (row.status === "ok" && row.r !== null && Number.isFinite(r) && r > 0) usable.set(t, { r, behind: Number(row.behind) || 0 });
        }
        const sigs = spikeSignals(pair, "1h", candidates, usable, nowMs);
        const mailed: string[] = [];
        for (const x of sigs) {
          const done = new Set((await readRows(
            `signal_alerts?kind=eq.signal&pair=eq.${enc(x.pair)}&interval=eq.${enc(x.interval)}&bar_time=eq.${enc(x.barTime)}&side=eq.${x.side}&rule=eq.${enc(SPIKE_RULE_ID)}&select=user_id`,
          )).map((r) => String(r.user_id)));
          const left = subs.filter((s) => s.rule === "spike" && s.pair === x.pair && s.interval === x.interval && !done.has(s.user_id));
          if (left.length === 0) continue;
          // counted on their own, so the run's record says a signal only
          // when a row was made for it (a follower whose plan has no alerts
          // is looked up again the next minute, and is not one), and why
          // not; kept even when a lookup throws partway (the per-pair catch)
          const these: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, duplicate: 0, not_allowed: 0 };
          try {
            await mailerFor(left, these)([x]);
          } finally {
            for (const [k, v] of Object.entries(these)) counts[k] = (counts[k] ?? 0) + v;
            const made = these.sent + these.failed + these.not_configured;
            if (made > 0) fired.push(x);
            const why = ["not_allowed", "lookup_failed", "duplicate"].filter((k) => these[k] > 0).join(",");
            mailed.push(`spike:${x.side}${x.spike?.forming ? "" : "@close"}${made > 0 ? "" : `:unsent${why ? `(${why})` : ""}`}`);
          }
        }
        // the forming bar's reading, kept in the run's record (net._http_response)
        const fb = candidates.find((c) => c.forming)?.bar ?? null;
        const fr = usable.get(hourMs) ?? null;
        const sr = fb && fr ? spikeOf({ o: fb.open, h: fb.high, l: fb.low }, fr.r) : null;
        return {
          pair,
          interval: "1h",
          spike: true,
          forming: fb ? fb.datetime : null,
          range: kept.get(hourMs)?.status ?? null,
          worked_out: need.length,
          ...(storeFailed ? { stored: false } : {}),
          r: fr ? Number(fr.r.toPrecision(6)) : null,
          up_x: sr ? Number(sr.upX.toFixed(2)) : null,
          down_x: sr ? Number(sr.downX.toFixed(2)) : null,
          signals: mailed,
        };
      };
      for (const pair of spikePairs) {
        try {
          reads.push(await spikeRead(pair));
        } catch (err) {
          console.error("spike failed:", pair, err);
          reads.push({ pair, interval: "1h", spike: true, error: "failed" });
        }
      }

      // (#397: v39's ride was looked at here each minute, its forming 1-hour
      // bar against 96%, and its email 2 sent; v40's fade reads and keeps
      // nothing each minute)

      summary.reads = reads;
      summary.files = files;
      summary.twelve_reads = TWELVE_READS_PER_RUN - twelveLeft;
      summary.signals = fired.length;
      // (#395: and a sharp rise or fall that made no row says why)
      if (fired.length === 0 && Object.values(counts).every((v) => v === 0)) return summary;
      return { ...summary, ...counts };
    };

    // ---- #291: gold's 1-minute bars, recorded all day (gold-minutes.ts) -------------------
    //
    // Every minute (pg_cron), in the background: Swissquote's gold price every
    // GOLD_TICK_EVERY_MS until GOLD_TICK_OVERLAP_MS past the minute, each one
    // open now and stamped in a minute gold trades recorded into
    // public.gold_tick_bars. While gold is shut (the FX weekend at its
    // widest, gold's daily hour) nothing is read; a quote left standing
    // (older than GOLD_QUOTE_STALE_MS: a break the hours above do not know,
    // a holiday, the first reads after a reopening) is not recorded.
    const goldQuote = async (): Promise<Tick | null> => {
      try {
        const r = await fetch(GOLD_QUOTE_URL, { signal: AbortSignal.timeout(GOLD_TICK_EVERY_MS - 500) });
        if (!r.ok) {
          await r.body?.cancel();
          return null;
        }
        return parseSwissquote(await r.json().catch(() => null), Date.now());
      } catch {
        return null;
      }
    };
    // #291: the minutes just closed, judged for the gold 1-minute email
    // (indicators.ts sweepxSignals) on the minutes recorded by now, rounded as
    // the chart's history is (historyOfBars): the bars the chart draws its
    // marks on. Only when somebody follows the chart
    const goldJudge = async (): Promise<JsonRecord> => {
      try {
        const subs: IndicatorSub[] = (await readRows("signal_alert_subscriptions?rule=eq.sweepx&select=user_id,pair,interval,lang,rule"))
          .filter((r) => typeof r.user_id === "string" && r.rule === "sweepx" && isSweepxChart(r.pair, r.interval) && typeof r.lang === "string")
          .map((r) => ({ user_id: r.user_id as string, pair: r.pair as string, interval: r.interval as string, lang: r.lang as string, rule: "sweepx" as const }));
        if (subs.length === 0) return { subscriptions: 0 };
        // the window, and the few newest bars that may still be fresh beyond it
        const res = await rest("rpc/gold_tick_minutes", { method: "POST", body: JSON.stringify({ p_count: SWEEPX.window + 4 }) });
        if (!res.ok) {
          console.error("gold minutes read failed:", res.status, await res.text().catch(() => ""));
          return { subscriptions: subs.length, error: "read_failed" };
        }
        const minutes = parseTickMinutes(await res.json().catch(() => null));
        const now = Date.now();
        const closed = historyOfBars(GOLD, "1min", tickMinuteCandles(minutes), now, new Date(now).toISOString()).candles;
        const sigs = sweepxSignals(GOLD, "1min", closed, now);
        const counts: Record<string, number> = {};
        if (sigs.length > 0) await mailerFor(subs, counts)(sigs);
        return {
          subscriptions: subs.length,
          bars: closed.length,
          newest: closed.length > 0 ? closed[closed.length - 1].datetime : null,
          signals: sigs.map((s) => `${s.side}@${s.barTime}`),
          // how long after the bar closed it was judged, ms
          judged_after_ms: closed.length > 0 ? now - (barOpenMs(closed[closed.length - 1].datetime) + MIN) : null,
          ...counts,
        };
      } catch (err) {
        console.error("gold judge failed:", err);
        return { error: "failed" };
      }
    };
    // ---- #391: the MACD email on shares (stocks.ts) --------------------------------------------
    //
    // The shares somebody follows under 'stockmacd' whose bar may have closed
    // (in the half hour after one of the session's closes, stockCloseDue),
    // read from Yahoo once a minute at most until that bar is in; the newest
    // closed bar judged once an instance.
    // #397 (docs §8.150): from v39 to v40 what was judged was the MACD ride,
    // its rides kept in public.macd_rides.
    // v40 (docs §8.155; research/macdfade1h-prod-spec.md 3.3): what is judged
    // is the MACD fade, at closes only, on the same 1-hour bars and at the
    // same reads (no minute is read and nothing is kept: every read brings
    // the bars). On a read whose newest closed bar this instance has not
    // judged (stockFade, below): while that bar ended at most STOCK_FRESH_MS
    // ago (stocks.ts stockFadeClose), the entry at its close
    // (fadeCloseEntryAt on the 600 closed bars ending at it), priced at the
    // bar's close, and mailed to the share's followers who have no row for it
    // yet (mailRide: each follower once by the claim's unique key, and one
    // side a bar). public.macd_rides is neither read nor written. A share's
    // failure here never costs another share its judgment, and a bar is held
    // judged by this instance (and its close done) only once nothing of it is
    // left to try again: no error, and no follower left without a mail (a
    // lookup that failed, a plan with no alerts), so the next run in the
    // close's half hour reads the share and judges the bar again.
    // v41 (research/macdfade15min-prod-spec.md 2.4 and 3.3): the same fade on
    // the shares' 15-minute bars (STOCKMACD_INTERVALS: Yahoo's `15m` over
    // `60d`), read in the half hour after each 15-minute close of the regular
    // session, at most once in 50 seconds. A Tokyo share's bars come about 15
    // minutes late (docs §8.141, on 1-hour reads), so its close due is rarely
    // done before the next one starts and it is read about once a minute
    // through the session (counted from the code; not measured on 15-minute
    // reads). This run and the pairs' and gold's run share pg_net's one queue
    // (docs §8.112), so a run's Yahoo reads are bounded (spec 3.3 item 10):
    // the shares are taken oldest read first (a share never read first), no
    // read is started once the run has spent STOCK_RUN_BUDGET_MS (30 seconds),
    // each share left is recorded as skipped: "budget" with its read time not
    // set (so the next run reads it first), and the run's summary says how
    // long it took (took_ms).
    const stockSweep = async (): Promise<JsonRecord> => {
      const nowMs = Date.now();
      const summary: JsonRecord = { ok: true, mode: "stocks", version: FUNCTION_VERSION, email_configured: emailConfigured };
      const subs: IndicatorSub[] = (await readRows("signal_alert_subscriptions?rule=eq.stockmacd&select=user_id,pair,interval,lang,rule"))
        .filter((r) => typeof r.user_id === "string" && isStockmacdChart(r.pair, r.interval) && typeof r.lang === "string")
        .map((r) => ({ user_id: r.user_id as string, pair: r.pair as string, interval: r.interval as string, lang: r.lang as string, rule: "stockmacd" as const }));
      summary.subscriptions = subs.length;
      if (subs.length === 0) return { ...summary, took_ms: Date.now() - nowMs };
      const counts: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, duplicate: 0, not_allowed: 0 };
      const reads: JsonRecord[] = [];
      // The fade on one share at a read whose newest closed bar is to be
      // judged (`closed`: its closed bars, oldest first; `newest`: the newest
      // of them): (1) not fresh (it ended more than STOCK_FRESH_MS ago):
      // nothing; (2) the entry at its close: none, nothing; (3) the price in,
      // the bar's close; (4) the signal, mailed to the share's followers who
      // have no row for it yet. Its record goes into `out` as it is made ({
      // fresh, entry, price, other_side? }), so that a failure partway leaves
      // what was done; said in the run's signals only when a row was made for
      // it in this run or was there already, and, when a follower left got
      // none, why (a plan with no alerts or a lookup that failed: tried again
      // by the next run). Whether nothing is left to try again: no follower
      // was left without a mail.
      const stockFade = async (sym: string, closed: StockBar[], newest: StockBar, out: { fade: JsonRecord; tags: string[]; unsent: string[] }): Promise<boolean> => {
        out.fade.fresh = false;
        out.fade.entry = null;
        out.fade.price = null;
        const close = stockFadeClose(sym, closed, nowMs);
        // not fresh: nothing (spec 3.3)
        if (!close.fresh) return true;
        out.fade.fresh = true;
        const entry = close.entry;
        if (entry === null) return true;
        out.fade.entry = entry.side;
        // a share has one price: the price in is the bar's close (spec 2.3)
        const price = newest.close;
        out.fade.price = price;
        const sig = fadeSignal("stockmacd", sym, STOCKMACD_INTERVALS[0], entry, { openMs: newest.open_ms, closeMs: newest.end, close: newest.close, price });
        const got = await mailRide(sig, subs, counts);
        if (got.otherSide) out.fade.other_side = true;
        if (got.made + got.had > 0) out.tags.push(rideSignalTag(sig));
        if (got.why) out.unsent.push(got.why);
        return out.unsent.length === 0;
      };
      // v41 (spec 3.3 item 10): the followed shares, oldest read first (a
      // share never read in this instance first; the sort keeps the
      // subscriptions' order among equals), so a share a run left for the
      // budget is read first by the next
      const followed = [...new Set(subs.map((x) => x.pair))]
        .map((sym, k) => ({ sym, k, at: stockReadAt.get(sym) ?? Number.NEGATIVE_INFINITY }))
        .sort((a, b) => a.at - b.at || a.k - b.k)
        .map((x) => x.sym);
      for (const sym of followed) {
        const due = stockCloseDue(sym, nowMs);
        if (due === null || stockDone.get(sym) === due) continue;
        if (nowMs - (stockReadAt.get(sym) ?? 0) < 50_000) continue;
        // v41: no Yahoo read is started once the run has spent its budget; the
        // share is left for the next run (its read time not set)
        if (Date.now() - nowMs >= STOCK_RUN_BUDGET_MS) {
          reads.push({ pair: sym, skipped: "budget" });
          continue;
        }
        stockReadAt.set(sym, nowMs);
        let body: unknown = null;
        try {
          const r = await fetch(yahooChartUrl(sym, STOCKMACD_INTERVALS[0]), { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(10_000) });
          body = r.ok ? await r.json().catch(() => null) : null;
          if (!r.ok) {
            await r.body?.cancel();
            reads.push({ pair: sym, error: `yahoo_${r.status}` });
            continue;
          }
        } catch (err) {
          console.error("yahoo read failed:", sym, err);
          reads.push({ pair: sym, error: "yahoo_unavailable" });
          continue;
        }
        const got = stockBarsOf(sym, body, nowMs);
        if (!got) {
          reads.push({ pair: sym, error: "yahoo_no_bars" });
          continue;
        }
        const step = stockSweepOf(sym, got.bars, due, stockJudged.get(sym), nowMs);
        if (step.noSession) {
          stockDone.set(sym, due);
          reads.push({ pair: sym, due: new Date(due).toISOString(), skipped: "no_session" });
          continue;
        }
        // v40: the fade at this read, in its own try / catch
        const said: { fade: JsonRecord; tags: string[]; unsent: string[] } = { fade: {}, tags: [], unsent: [] };
        let settled = true;
        if (step.judge && step.newest) {
          try {
            settled = await stockFade(sym, step.closed, step.newest, said);
          } catch (err) {
            console.error("stockmacd failed:", sym, errText(err));
            said.fade.error = "failed";
            settled = false;
          }
          if (said.unsent.length > 0) said.fade.unsent = said.unsent;
        }
        // (held judged, and the close done, only once nothing is left to try
        // again: until then the next run reads the share and judges the bar
        // again, as a fresh instance does)
        if (settled) {
          if (step.done) stockDone.set(sym, due);
          if (step.judge && step.newest) stockJudged.set(sym, step.newest.open_ms);
        }
        reads.push({
          pair: sym,
          due: new Date(due).toISOString(),
          bars: step.closed.length,
          newest: step.newest ? step.newest.datetime : null,
          close: step.newest ? step.newest.close : null,
          market_time: got.marketMs === null ? null : new Date(got.marketMs).toISOString(),
          judged: step.judge,
          // (v40: the fade's email as "stockmacd:SELL" or "stockmacd:BUY";
          // #397: v39's ride's three mails were "stockmacd:", "stockmacd-at:"
          // and "stockmacd-out:")
          signals: said.tags,
          // how long after the bar closed it was judged, ms
          judged_after_ms: step.judge && step.newest ? Date.now() - step.newest.end : null,
          ...(step.judge ? { fade: said.fade } : {}),
        });
      }
      // v41: how long the run took, ms (spec 3.3 item 10)
      return { ...summary, reads, ...counts, took_ms: Date.now() - nowMs };
    };

    const goldTicks = async (): Promise<JsonRecord> => {
      const started = Date.now();
      const plan = goldTickPlan(started);
      const summary: JsonRecord = {
        ok: true,
        mode: "gold-ticks",
        version: FUNCTION_VERSION,
        minute: new Date(plan.minuteStart).toISOString(),
        started: new Date(started).toISOString(),
      };
      // a second call for the minute this instance is already reading
      if (goldTicksMinute === plan.minuteStart) return { ...summary, skipped: "busy" };
      if (isPossiblyClosedFor(GOLD, plan.minuteStart)) {
        // the last minute before gold shut (its daily hour, the week's end)
        // is judged still, GOLD_JUDGE_AFTER_MS after it closed (the run
        // before this one may still be recording its last prices) and a
        // minute later, as every minute is (judgesWhileShut); the others
        // while it is shut have no bar
        if (!judgesWhileShut(plan.minuteStart)) return { ...summary, skipped: "market_closed" };
        await sleep(plan.judgeAt - Date.now());
        return { ...summary, skipped: "market_closed", judged: await goldJudge() };
      }
      goldTicksMinute = plan.minuteStart;
      const tally = { reads: 0, recorded: 0, stale: 0, shut: 0, failed: 0, record_failed: 0 };
      // the judge runs beside the reads (its mails may take seconds), not
      // between them, and its result goes to the log as soon as it is made:
      // a run cut short after its minute (were it given a worker booted for
      // an earlier request, which lives 150 s from its boot) still leaves it
      const judge = (): Promise<JsonRecord> =>
        goldJudge().then((judged) => {
          console.log(JSON.stringify({ ...summary, judged }));
          return judged;
        });
      let judging: Promise<JsonRecord> | null = null;
      try {
        let lastAt = Number.NEGATIVE_INFINITY;
        for (;;) {
          const at = nextTickAt(lastAt, Date.now());
          // the minute that closed, once its last prices are in
          if (judging === null && plan.judgeAt <= at) {
            await sleep(plan.judgeAt - Date.now());
            judging = judge();
          }
          if (at >= plan.stopAt) break;
          await sleep(at - Date.now());
          lastAt = at;
          tally.reads++;
          const tick = await goldQuote();
          if (!tick) {
            tally.failed++;
            continue;
          }
          if (!tick.open || !tick.time) {
            tally.stale++;
            continue;
          }
          // (a price stamped while gold is shut makes no bar)
          if (isPossiblyClosedFor(GOLD, Date.parse(tick.time))) {
            tally.shut++;
            continue;
          }
          try {
            const rec = await rest("rpc/record_gold_tick", { method: "POST", body: JSON.stringify({ p_at: tick.time, p_mid: tick.mid }) });
            const said = await rec.text().catch(() => "");
            if (rec.ok) tally.recorded++;
            else {
              tally.record_failed++;
              console.error("gold tick record failed:", rec.status, said);
            }
          } catch (err) {
            tally.record_failed++;
            console.error("gold tick record failed:", err);
          }
        }
        if (judging === null) {
          await sleep(plan.judgeAt - Date.now());
          judging = judge();
        }
      } finally {
        if (goldTicksMinute === plan.minuteStart) goldTicksMinute = null;
      }
      // (the reads' summary; the judgment was logged when it was made)
      const ended = new Date().toISOString();
      await judging;
      return { ...summary, ...tally, ended };
    };
    // Once, by hand: the minutes before the recording began, from Twelve
    // Data's newest 1-minute bars (gold-minutes.ts goldSeedRows), within the
    // day's reads. A minute already in the table is left as it is. Refused
    // once a Swissquote price is in the table (gold-minutes.ts, "the fill of
    // the minutes before the recording began"), and when that cannot be read
    const goldSeed = async (): Promise<JsonRecord> => {
      const summary: JsonRecord = { ok: true, mode: "gold-seed", version: FUNCTION_VERSION };
      const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
      if (!twelveKey) return { ...summary, ok: false, error: "no_key" };
      const firstRes = await rest("gold_tick_bars?source=eq.swissquote&select=minute&order=minute.asc&limit=1");
      const first = firstRes.ok ? await firstRes.json().catch(() => null) : null;
      if (!firstRes.ok) await firstRes.body?.cancel();
      if (!Array.isArray(first)) return { ...summary, ok: false, error: "read_failed", status: firstRes.status };
      if (first.length > 0) {
        return { ...summary, ok: false, error: "recording_started", first_recorded: isRecord(first[0]) ? first[0].minute ?? null : null };
      }
      if (!(await takeTwelveRead(ALERT_TWELVE_CAP))) return { ...summary, ok: false, error: "day_spent" };
      let bars: Candle[] | null = null;
      try {
        const r = await fetch(twelveDataUrl(GOLD, "1min", twelveKey, TWELVE_1MIN_BARS), { signal: AbortSignal.timeout(20_000) });
        bars = r.ok ? parseTwelveData(await r.json().catch(() => null), "1min") : null;
        if (!r.ok) await r.body?.cancel();
      } catch (err) {
        console.error("twelve data read failed:", err);
      }
      if (!bars) return { ...summary, ok: false, error: "twelve_unavailable" };
      const rows = goldSeedRows(bars, Date.now());
      const out: JsonRecord = { ...summary, read: bars.length, rows: rows.length };
      if (rows.length === 0) return { ...out, inserted: 0 };
      const res = await rest("gold_tick_bars?on_conflict=minute&select=minute", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(rows),
      });
      const got = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) {
        console.error("gold seed store failed:", res.status, await res.text().catch(() => ""));
        return { ...out, ok: false, error: "store_failed", status: res.status };
      }
      return { ...out, inserted: Array.isArray(got) ? got.length : null, from: rows[0].minute, to: rows[rows.length - 1].minute };
    };

    // ---- the sweep ---------------------------------------------------------------
    const sweepToken = req.headers.get("x-sweep-token");
    if (sweepToken) {
      const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
      const expected = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      if (typeof expected !== "string" || expected.length === 0 || !constantTimeEqual(sweepToken, expected)) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      // #155: every minute, Q-Trend's and ULTRA's
      if (body.mode === "indicators") {
        if (indicatorSweepRunning) return json({ ok: true, mode: "indicators", version: FUNCTION_VERSION, skipped: "busy" });
        indicatorSweepRunning = true;
        try {
          return json(await indicatorSweep());
        } finally {
          indicatorSweepRunning = false;
        }
      }
      // #291: every minute, gold's price from Swissquote all minute long — in
      // the background (EdgeRuntime.waitUntil), the request answered at once:
      // the job's call (the http extension) waits for the answer and gives it
      // up after 10 seconds, and this run takes the minute and more. Its
      // summary goes to the function's log
      if (body.mode === "gold-ticks") {
        const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (typeof runtime?.waitUntil !== "function") {
          return json({ ok: false, mode: "gold-ticks", version: FUNCTION_VERSION, error: "no_background" }, 500);
        }
        runtime.waitUntil(
          goldTicks().then(
            (s) => console.log(JSON.stringify(s)),
            (err) => console.error("gold ticks failed:", err),
          ),
        );
        return json({ ok: true, mode: "gold-ticks", version: FUNCTION_VERSION, background: true, at: new Date().toISOString() });
      }
      // #291: once, by hand: the minutes before that recording began
      if (body.mode === "gold-seed") return json(await goldSeed());
      // #391: every minute, the MACD email on shares
      if (body.mode === "stocks") {
        if (stockSweepRunning) return json({ ok: true, mode: "stocks", version: FUNCTION_VERSION, skipped: "busy" });
        stockSweepRunning = true;
        try {
          return json(await stockSweep());
        } finally {
          stockSweepRunning = false;
        }
      }
      const summary: JsonRecord = { ok: true, mode: "sweep", version: FUNCTION_VERSION, email_configured: emailConfigured };
      // "Enter now" is not an available action while the market may be shut,
      // which is when analyze refuses too
      if (isPossiblyClosed(nowMs)) return json({ ...summary, skipped: "market_closed" });

      // (#155: its own two rules' only — Q-Trend's and ULTRA's are the
      // "indicators" sweep's, and a rule this sweep does not know is not
      // RSI + SAR)
      const subs: Subscription[] = (await readRows("signal_alert_subscriptions?rule=in.(rsi_sar,gainz)&select=user_id,pair,interval,lang,rule"))
        .filter((r) => typeof r.user_id === "string" && isAlertPair(r.pair) && isAlertInterval(r.interval) && typeof r.lang === "string" && isRuleKey(r.rule))
        .map((r) => ({
          user_id: r.user_id as string,
          pair: r.pair as string,
          interval: r.interval as string,
          lang: r.lang as string,
          rule: isRuleKey(r.rule) ? r.rule : "rsi_sar",
        }));
      summary.subscriptions = subs.length;

      // Every chart the app covers, followed or not (#108): the record needs
      // the rule's signals, not only the ones somebody asked to be told about
      const charts = ALERT_PAIRS.flatMap((pair) => ALERT_INTERVALS.map((interval) => ({ pair, interval })))
        .filter((c) => mayHaveFreshClose(c.interval, nowMs));
      // (#175: of the pairs still read; another pair's is left as it is)
      const openEvents = (await readRows("signal_events?outcome=is.null&select=id,pair,interval,bar_time,side,entry,stop,target,fill"))
        .filter((r) => typeof r.id === "string" && typeof r.bar_time === "string" && (r.side === "BUY" || r.side === "SELL") && isAlertPair(r.pair))
        .map((r) => ({
          id: r.id as string,
          pair: String(r.pair),
          interval: String(r.interval),
          bar_time: r.bar_time as string,
          side: r.side as "BUY" | "SELL",
          entry: Number(r.entry),
          stop: Number(r.stop),
          target: Number(r.target),
          fill: typeof r.fill === "number" ? r.fill : null,
        } satisfies OpenEvent));
      const deadline = Date.now() + FETCH_BUDGET_MS;
      const reads: JsonRecord[] = [];
      const fired: Array<FiredSignal & { eventId: string | null }> = [];
      let recorded = 0;
      let settled = 0;
      // One chart at a time: two requests in flight is gentle on a public feed
      for (const c of charts) {
        if (Date.now() > deadline) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "deadline" });
          continue;
        }
        const r = await checkPair(c.pair, c.interval, nowMs, deadline, gmoFetcher);
        reads.push({
          pair: c.pair,
          interval: c.interval,
          bars: r.bars,
          ok: r.read?.ok ?? false,
          bar: r.read?.now?.datetime ?? null,
          rsi: r.read?.now ? Number(r.read.now.rsi.toFixed(1)) : null,
          signal: r.read?.now?.signal ?? null,
          ga: r.gainz?.now?.signal ?? null,
          fresh: r.signals.length,
        });
        const quotes: QuoteCandle[] = r.quotes;
        for (const sig of r.signals) {
          const f = fillAt(quotes, sig.barTime, sig.side);
          const id = await eventId({
            pair: sig.pair,
            interval: sig.interval,
            bar_time: sig.barTime,
            closed_at: sig.closedAt,
            side: sig.side,
            rule: ruleIdOf(sig.rule),
            entry: sig.entry,
            stop: sig.stop,
            target: sig.target,
            atr: sig.atr,
            rsi: sig.rsi,
            rsi_prev: sig.rsiPrev,
            sar: sig.sar,
            fill: f?.fill ?? null,
            spread: f?.spread ?? null,
            costly: sig.costly,
          });
          if (id) recorded++;
          fired.push({ ...sig, eventId: id });
        }
        // Settle what this chart's bars can settle
        for (const ev of openEvents.filter((e) => e.pair === c.pair && e.interval === c.interval)) {
          const done = settleEvent(ev, quotes, nowMs);
          if (!done) continue;
          const res = await rest(`signal_events?id=eq.${encodeURIComponent(ev.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ ...done, settled_at: new Date().toISOString() }),
          });
          if (res.ok) settled++;
          else console.error("settle failed:", res.status, await res.text().catch(() => ""));
        }
      }
      summary.reads = reads;
      summary.signals = fired.length;
      summary.recorded = recorded;
      summary.settled = settled;
      summary.open = openEvents.length - settled;
      if (fired.length === 0 || subs.length === 0) return json(summary);

      const counts: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, skipped: 0, duplicate: 0, not_allowed: 0 };
      const access = new Map<string, { allowed: boolean; email: string | null }>();
      for (const sig of fired) {
        for (const sub of subs.filter((s) => s.pair === sig.pair && s.interval === sig.interval && s.rule === sig.rule)) {
          let who = access.get(sub.user_id);
          if (!who) {
            const [plan, email] = await Promise.all([planOf(sub.user_id), userEmail(sub.user_id)]);
            who = { allowed: alertsAllowed(plan, email), email };
            access.set(sub.user_id, who);
          }
          // A subscription outlives a lapsed plan; it just stops mailing
          if (!who.allowed) {
            counts.not_allowed++;
            continue;
          }
          const id = await claimRow({
            user_id: sub.user_id,
            kind: "signal",
            pair: sig.pair,
            interval: sig.interval,
            bar_time: sig.barTime,
            closed_at: sig.closedAt,
            side: sig.side,
            entry: sig.entry,
            stop: sig.stop,
            target: sig.target,
            rsi: sig.rsi,
            rsi_prev: sig.rsiPrev,
            sar: sig.sar,
            atr: sig.atr,
            rule: ruleIdOf(sig.rule),
            event_id: sig.eventId,
            status: sig.costly ? "skipped" : "pending",
            skip_reason: sig.costly ? "costly_hours" : null,
          });
          if (id === null) {
            counts.duplicate++;
            continue;
          }
          // Logged, not mailed: the app would answer WAIT at this hour
          // (timing.ts), and an email saying "buy now" when the app says
          // "wait" is worse than no email
          if (sig.costly) {
            counts.skipped++;
            continue;
          }
          const lang: Lang = isLang(sub.lang) ? sub.lang : "ja";
          const outcome = await deliver(id, who.email, renderSignalMail(sig, lang));
          counts[outcome] = (counts[outcome] ?? 0) + 1;
        }
      }
      return json({ ...summary, ...counts });
    }

    // ---- the app -------------------------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ ok: false, error: "認証が必要です" }, 401);
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: supabaseAnonKey },
    });
    const userData = userRes.ok ? await userRes.json().catch(() => null) : null;
    if (!isRecord(userData) || typeof userData.id !== "string") return json({ ok: false, error: "認証に失敗しました" }, 401);
    const userId = userData.id;
    const email = typeof userData.email === "string" ? userData.email : null;
    const plan = await planOf(userId);
    const allowed = alertsAllowed(plan, email);
    const uid = encodeURIComponent(userId);

    const status = async () => {
      const [subs, alerts] = await Promise.all([
        readRows(`signal_alert_subscriptions?user_id=eq.${uid}&select=pair,interval,lang,rule&order=created_at.asc`),
        readRows(
          `signal_alerts?user_id=eq.${uid}&select=id,kind,pair,interval,bar_time,closed_at,side,entry,stop,target,rsi,rsi_prev,sar,rule,strong,status,skip_reason,error,created_at,sent_at,event:signal_events(outcome,r,bars,exit_at)&order=created_at.desc&limit=${RECENT_ALERTS}`,
        ),
      ]);
      // #108: the live record. "all" is every signal the rule fired outside
      // the hours it is not mailed in; "mine" is the alerts this user was
      // actually sent. #175: both on the pairs still read (ALERT_PAIRS) only.
      const since = encodeURIComponent(new Date(nowMs - RECORD_DAYS * 24 * 60 * MIN).toISOString());
      const [events, mine] = await Promise.all([
        readRows(`signal_events?closed_at=gte.${since}&select=pair,interval,costly,outcome,r,rule&limit=20000`),
        readRows(`signal_alerts?user_id=eq.${uid}&kind=eq.signal&status=eq.sent&created_at=gte.${since}&select=pair,rule,event:signal_events(outcome,r)&limit=20000`),
      ]).then((rs) => rs.map((xs) => xs.filter((x) => isAlertPair(x.pair))));
      const row = (x: JsonRecord): EventRow => ({
        outcome: typeof x.outcome === "string" ? x.outcome : null,
        r: typeof x.r === "number" ? x.r : null,
      });
      // #112: one record per rule. #132: a row counts only under the rule id
      // it was decided by, the current setting's — a row of an earlier
      // setting (RSI(14) 30/70, GA 0.5/50/5) belongs to neither record.
      const ofRule = (ga: boolean) => (x: JsonRecord) => x.rule === (ga ? GA_RULE_ID : RULE_ID);
      const recordOf = (ga: boolean, backtest: typeof BACKTEST) => {
        const own = events.filter(ofRule(ga));
        const mailed = own.filter((e) => e.costly !== true);
        return {
          mine: summarize(mine.filter(ofRule(ga)).map((m) => (isRecord(m.event) ? row(m.event) : { outcome: null, r: null }))),
          all: summarize(mailed.map(row)),
          costly: summarize(own.filter((e) => e.costly === true).map(row)),
          byTf: Object.fromEntries(ALERT_INTERVALS.map((iv) => [iv, summarize(mailed.filter((e) => e.interval === iv).map(row))])),
          backtest,
        };
      };
      const performance = {
        days: RECORD_DAYS,
        ...recordOf(false, BACKTEST),
        gainz: recordOf(true, GA_BACKTEST),
      };
      return {
        ok: true,
        version: FUNCTION_VERSION,
        allowed,
        email_configured: emailConfigured,
        email,
        pairs: ALERT_PAIRS,
        intervals: ALERT_INTERVALS,
        // #155: Q-Trend's and ULTRA's charts: every pair of the live chart,
        // those read from Twelve Data on 1 hour and up (#212: gold on 15
        // minutes too)
        indicator: {
          rules: INDICATOR_RULES,
          pairs: INDICATOR_PAIRS,
          intervals: INDICATOR_INTERVALS,
          limited: Object.fromEntries(INDICATOR_PAIRS.filter((p) => isTwelvePair(p)).map((p) => [p, indicatorIntervalsFor(p)])),
          limited_intervals: TWELVE_ALERT_INTERVALS,
          // #275: the MACD peak-and-valley rule's charts: GMO's currency pairs
          // (#324: from v25 the 1-hour rule's, mailed in place of the 5-minute one,
          // on the owner's five pairs; #345: and gold from v27). v41
          // (research/macdfade15min-prod-spec.md 3.2 item 6): one chart a pair
          // (MACDH_INTERVAL_OF), sent as `limited` in the base block's shape, so
          // the screen offers each pair its own chart only and draws "—" on the
          // other; `intervals` is the column list (["15min", "1h"])
          macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS, limited: Object.fromEntries(MACDH_PAIRS.map((p) => [p, [MACDH_INTERVAL_OF[p]]])) },
          // #291: the video's way's: gold's 1-minute chart
          sweepx: { pairs: SWEEPX_PAIRS, intervals: SWEEPX_INTERVALS },
          // #387: the EMA 20 / 200 way's: the six's 15-minute chart
          emarm: { pairs: EMARM_PAIRS, intervals: EMARM_INTERVALS },
          // #391: the MACD email on shares: the 22 shares' 1-hour chart
          stockmacd: { pairs: STOCKMACD_PAIRS, intervals: STOCKMACD_INTERVALS },
          // #395: a sharp rise or fall: the six's 1-hour chart
          spike: { pairs: SPIKE_PAIRS, intervals: SPIKE_INTERVALS },
        },
        subscriptions: subs.map((s) => ({
          pair: s.pair,
          interval: s.interval,
          rule: isRuleKey(s.rule) || isIndicatorRule(s.rule) ? s.rule : "rsi_sar",
        })),
        performance,
        alerts,
      };
    };

    const action = typeof body.action === "string" ? body.action : "status";
    if (action === "status") return json(await status());

    if (action === "set") {
      // #155: Q-Trend's and ULTRA's on their own charts
      const indicator = isIndicatorRule(body.rule);
      const chartOk = indicator ? isIndicatorChartFor(body.rule, body.pair, body.interval) : isAlertPair(body.pair) && isAlertInterval(body.interval);
      if (!chartOk || typeof body.pair !== "string" || typeof body.interval !== "string" || typeof body.on !== "boolean") {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      // #112: which rule's signals; absent means RSI + SAR, as before
      if (body.rule !== undefined && !isRuleKey(body.rule) && !indicator) return json({ ok: false, error: "invalid_request" }, 400);
      const rule: RuleKey | IndicatorRule = indicator ? (body.rule as IndicatorRule) : isRuleKey(body.rule) ? body.rule : "rsi_sar";
      if (body.on) {
        if (!allowed) return json({ ok: false, error: "plan_required" }, 403);
        // v41 (research/macdfade15min-prod-spec.md 3.6): created_at, the
        // function's now, beside lang: a tick of a row that exists (the upsert
        // merges) shows the tick's time too, so the reconcile after the
        // release, bounded by the merge's time, never takes a v41 tick for a
        // twin. Every rule's rows alike
        const res = await rest("signal_alert_subscriptions?on_conflict=user_id,pair,interval,rule", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: userId, pair: body.pair, interval: body.interval, rule, lang: isLang(body.lang) ? body.lang : "ja", created_at: new Date(nowMs).toISOString() }),
        });
        if (!res.ok) {
          console.error("subscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
        }
      } else {
        // Always possible, plan or not: nobody should need a subscription to
        // stop receiving mail
        const res = await rest(
          `signal_alert_subscriptions?user_id=eq.${uid}&pair=eq.${encodeURIComponent(body.pair)}&interval=eq.${encodeURIComponent(body.interval)}&rule=eq.${rule}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          console.error("unsubscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
        }
      }
      return json(await status());
    }

    // #155: many of Q-Trend's or ULTRA's charts at once (a timeframe across
    // every pair, or a pair across its timeframes)
    if (action === "set_many") {
      if (!isIndicatorRule(body.rule) || typeof body.on !== "boolean" || !Array.isArray(body.charts) || body.charts.length === 0 || body.charts.length > 200) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const rule = body.rule;
      const charts = body.charts.map((c) => (isRecord(c) ? { pair: c.pair, interval: c.interval } : { pair: null, interval: null }));
      if (!charts.every((c) => isIndicatorChartFor(rule, c.pair, c.interval))) return json({ ok: false, error: "invalid_request" }, 400);
      const list = charts as Array<{ pair: string; interval: string }>;
      if (body.on) {
        if (!allowed) return json({ ok: false, error: "plan_required" }, 403);
        const lang = isLang(body.lang) ? body.lang : "ja";
        // v41 (spec 3.6): created_at, the function's now, in every row beside
        // lang, as `set` sends it
        const createdAt = new Date(nowMs).toISOString();
        const res = await rest("signal_alert_subscriptions?on_conflict=user_id,pair,interval,rule", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(list.map((c) => ({ user_id: userId, pair: c.pair, interval: c.interval, rule, lang, created_at: createdAt }))),
        });
        if (!res.ok) {
          console.error("subscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
        }
      } else {
        // by timeframe, the pairs in one request each
        for (const iv of [...new Set(list.map((c) => c.interval))]) {
          const pairs = list.filter((c) => c.interval === iv).map((c) => `"${c.pair}"`).join(",");
          const res = await rest(
            `signal_alert_subscriptions?user_id=eq.${uid}&rule=eq.${rule}&interval=eq.${encodeURIComponent(iv)}&pair=in.(${encodeURIComponent(pairs)})`,
            { method: "DELETE" },
          );
          if (!res.ok) {
            console.error("unsubscribe failed:", res.status, await res.text().catch(() => ""));
            return json({ ok: false, error: "save_failed" }, 500);
          }
        }
      }
      return json(await status());
    }

    if (action === "test") {
      if (!allowed) return json({ ok: false, error: "plan_required" }, 403);
      const since = encodeURIComponent(new Date(nowMs - TEST_COOLDOWN_MS).toISOString());
      const recent = await readRows(`signal_alerts?user_id=eq.${uid}&kind=eq.test&created_at=gt.${since}&select=id`);
      if (recent.length > 0) return json({ ok: false, error: "test_cooldown" }, 429);
      const res = await rest("signal_alerts", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ user_id: userId, kind: "test", status: "pending" }),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      const id = Array.isArray(rows) && isRecord(rows[0]) && typeof rows[0].id === "string" ? rows[0].id : null;
      if (!id) return json({ ok: false, error: "save_failed" }, 500);
      const subs = await readRows(`signal_alert_subscriptions?user_id=eq.${uid}&select=pair,interval,rule&order=created_at.asc`);
      const lang: Lang = isLang(body.lang) ? body.lang : "ja";
      // v41 (research/macdfade15min-prod-spec.md 3.6): only the rows this
      // version mails are listed: an indicator rule's row on a chart it is not
      // judged on (a USD/JPY or a share's '1h' row beside its '15min' twin, an
      // EUR/JPY '15min' row of 'macdx') is left out; the other rules' rows as
      // before
      const outcome = await deliver(
        id,
        email,
        renderTestMail(
          subs
            .filter((s) => !isIndicatorRule(s.rule) || isIndicatorChartFor(s.rule, s.pair, s.interval))
            .map((s) => ({ pair: String(s.pair), interval: String(s.interval), rule: isRuleKey(s.rule) || isIndicatorRule(s.rule) ? s.rule : "rsi_sar" })),
          lang,
        ),
      );
      return json({ ...(await status()), test: outcome });
    }

    return json({ ok: false, error: "invalid_request" }, 400);
  } catch (err) {
    console.error("signal-alerts failed:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
