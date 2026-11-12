// #155: an email when Q-Trend or ULTRA marks a BUY or SELL on the live chart.
//
// The owner's request (2026-09-29), with a screenshot of the live chart
// (USD/JPY 5-minute, Q-Trend's BUY/SELL labels and ULTRA's Buy ☆/Sell ☆):
// 「全ての銘柄でこのsellとbuyの判断がでたときstrongも含む。その時にメールが
// 届く様にして」. Asked what exactly, the owner chose: both indicators (Q-Trend's
// BUY, SELL and STRONG; ULTRA's Buy ☆ and Sell ☆), the 5-minute, 15-minute,
// 1-hour, 4-hour and daily charts, the pairs Twelve Data serves (GMO does not)
// on 1 hour and up only (「1時間足まで」: its free allowance is 800 reads a day,
// shared with the chart), and one email per signal.
//
// The signal is the chart's own. The chart judges both indicators on the
// closed bars it holds — its history (the 600 closed bars before the
// newest, read as live-chart's "history" reads them, rounded as it draws
// them) — from the start _shared/qtrend.ts anchoredStart picks, counted from
// the newest bar judged on (#155, so a chart left open, a chart opened now
// and this email start at the same bar). This file reads the same bars with
// the same functions (live-chart/logic.ts historyRead / historyOfBars) and
// judges with the same code (_shared/qtrend.ts, _shared/ultra.ts), so a label
// that appears on the chart at a close is the one mailed.
//
// Everything here is Deno-free: src/test/indicator-alerts.test.tsx imports it.

import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../_shared/qtrend.ts";
import { ULTRA_DEFAULTS, ultra, ultraLevels, ultraParamsFor } from "../_shared/ultra.ts";
// #275: the MACD peak-and-valley rule (docs §8.109), the very code it was measured with
import { MACD_DEFAULTS } from "../_shared/macd.ts";
import { N_TR as MACDX_N_TR, WINDOW as MACDX_WINDOW, decideOnWindow } from "../_shared/macd-extreme.ts";
// #324: the MACD email's rule on the 1-hour chart (docs §8.114); #339: from v26 against each pair's own level (§8.116);
// #353: from v28 the blue line at 90% of the top or bottom of the newest 120 bars' MACD pane (§8.119)
// (#397: from v39 the email is the ride's, below; the pane's 120 bars are still this file's)
import { ZONE_BARS } from "../_shared/macd-level.ts";
// #397: the MACD email as a ride (docs §8.150): in at 90% with the flow, told at 96%
import {
  RIDE_IN_PCT,
  RIDE_IN_SHARE,
  RIDE_OUT_PCT,
  RIDE_OUT_SHARE,
  RIDE_RULE_TAG,
  rideRuleId,
  rideZoneSideOf,
  type RideEntry,
  type RideMail,
  type RideRow,
  type RideSide,
  type RideZoneSide,
} from "../_shared/macd-ride.ts";
import { pineAtr } from "../_shared/pine.ts";
// #291: the owner's video's way (docs §8.112), the code the chart's marks are drawn with
import { SWEEPX, sweepCrossOnWindow, sweepPip } from "../_shared/sweep-cross.ts";
// #385: WillyAlgoTrader's AMD Po3 (docs §8.128), the code the chart draws it with
import { AMD_PO3, amdPo3, amdPo3Trades, pineFmt } from "../_shared/amd-po3.ts";
// #387: the owner's video's EMA 20 / 200 way (docs §8.130), the code the chart draws it with
import { EMA_RETURN, emaReturnOnWindow } from "../_shared/ema-return.ts";
// #395: a sharp rise or fall of the 1-hour bar (docs §8.138)
import { SPIKE, spikeOf, spikeRange } from "../_shared/spike.ts";
import { isPossiblyClosedFor } from "../_shared/market-hours.ts";
// #211: the Japanese emails name the pair as 楽天FX does (ユーロ/円)
import { pairJa } from "../_shared/pair-names.ts";
import { CHART_BARS, GOLD, LIVE_PAIRS, LIVE_STEP_MS, isGold, isTwelvePair, splitBars } from "../live-chart/logic.ts";
import { GMO_SYMBOLS, exitSide, fillSide, sideOf, type QuoteCandle } from "../track-outcomes/quotes.ts";
import { APP_URL, assemble, clock, rideHeldText, tfLabel, type Lang, type Mail } from "./logic.ts";
import { STOCKMACD_RULE_ID, isStockmacdChart, renderStockMail } from "./stocks.ts";

// #291: and "sweepx", the owner's video's way on gold's 1-minute chart (the
// low or high taken, then the cross of EMA 20 and EMA 80; docs §8.112)
// #385: and "amdpo3", AMD Po3's DIST (the reference trade opened; docs §8.128)
// #387: and "emarm", the owner's video's EMA 20 / 200 way (the cross, the
// candle back to the 200 EMA, the necklines' break and the return move; docs
// §8.130)
// #391: and "stockmacd", the MACD email's rule on the 22 shares' hourly bars
// (stocks.ts; docs §8.134), judged by the "stocks" run on Yahoo's bars
// #395: and "spike", a sharp rise or fall of the 1-hour bar, seen as the bar
// forms (_shared/spike.ts; docs §8.138)
export const INDICATOR_RULES = ["qtrend", "ultra", "macdx", "sweepx", "amdpo3", "emarm", "stockmacd", "spike"] as const;
export type IndicatorRule = (typeof INDICATOR_RULES)[number];
export const isIndicatorRule = (v: unknown): v is IndicatorRule =>
  v === "qtrend" || v === "ultra" || v === "macdx" || v === "sweepx" || v === "amdpo3" || v === "emarm" || v === "stockmacd" || v === "spike";
// #275: the rules judged on the chart's own bars the way Q-Trend and ULTRA are
// (the measured figures below are kept for these; #324: the MACD rule, now the
// 1-hour one, is not measured; #291: nor is the video's way)
// (#385: nor is AMD Po3; #387: the EMA 20 / 200 way has its own figures, below)
export type ChartRule = Exclude<IndicatorRule, "macdx" | "sweepx" | "amdpo3" | "emarm" | "stockmacd" | "spike">;
// The rule ids kept with each alert (signal_alerts.rule): the settings the
// signal was judged at. #166 left ULTRA's as it was (the video's, sl10): the
// signals do not depend on the stop, the id is part of the key that keeps a
// signal from being mailed twice, and each row keeps the stop it was mailed
// with (signal_alerts.stop; 30 pips on a currency pair from #166, 13 on
// gold and the pairs since #192, which left the id as it was too).
export const QTREND_RULE_ID = `qtrend_${QT_DEFAULTS.period}_${QT_DEFAULTS.atrPeriod}_${QT_DEFAULTS.mult}_v1`;
export const ULTRA_RULE_ID =
  `ultra_rsi${ULTRA_DEFAULTS.rsiLength}_${ULTRA_DEFAULTS.oversold}_${ULTRA_DEFAULTS.overbought}` +
  `_sl${ULTRA_DEFAULTS.sl}_tp${ULTRA_DEFAULTS.tp1}_${ULTRA_DEFAULTS.tp2}_${ULTRA_DEFAULTS.tp3}_v1`;
// #275: the MACD peak-and-valley rule (docs §8.109): MACD(12, 26, 9) crossing
// its signal line, judged on the 600 closed bars ending at the bar, with the
// three conditions' numbers (C1 a quarter of the mean range over 288 bars, C2
// a half of the wave's peak). The id is the key that keeps a signal from being
// mailed twice, so it must differ from ULTRA's.
// #324: the id the 5-minute rule was mailed under (v23 and v24); the studies
// still decide through that rule (macdxSignals, below)
export const MACDX_RULE_ID =
  `macdx_${MACD_DEFAULTS.fast}_${MACD_DEFAULTS.slow}_${MACD_DEFAULTS.signal}_w${MACDX_WINDOW}_n${MACDX_N_TR}_k4_2_v1`;
// #324 (docs §8.114): the MACD email's rule from v25, the owner's: on the
// 1-hour chart, a cross with MACD at or above +8.5 pips (a SELL) or at or
// below -8.5 pips (a BUY) — 0.085 on the yen pairs, as the owner put it on
// USD/JPY's chart, and 0.00085 on EUR/USD and AUD/USD; mailed under
// macdx_12_26_9_w600_1h_lv8.5p_v2.
// #339 (docs §8.116): from v26 the level is each pair's own, MACDH_K times
// its usual hourly move (the mean move from one close to the next over the
// 600 bars judged on): the owner, on AUD/USD's chart, 「通貨のペアによります
// よね？大体紫丸ぐらいの高さ、低さでクロスした時にメールください。どのペアも」,
// then 0.8: it takes in both crosses circled (some 1.2 and 0.9 times the
// usual move); on USD/JPY it is a little above the 0.085 chosen before (some
// 0.75 times it). The subscriptions keep rule = 'macdx' (the app's "MACD
// peak/valley"); this id, which starts as the app reads the rule back from
// it, tells its emails from the 5-minute rule's and from v25's.
// #353 (docs §8.119): from v28 no cross and no level: a SELL where the MACD
// line (the blue line) comes to ZONE_PCT (90; 95 from v30)% or more of the way from the
// zero line to the top of the MACD pane of the newest ZONE_BARS (120) bars
// (the highest of the MACD line, the signal line and the histogram there), a
// BUY likewise toward the pane's bottom, once as it gets there
// (_shared/macd-level.ts decideZoneOnWindow): the owner's 「macdの青い線が上か
// 下の90%以上の所までいったら売買のメールを送る様に」, and for the top 「2で」
// (the pane's, 2026-10-14). Mailed under macdx_12_26_9_w600_1h_z90of120_v4
// (v26 and v27's was macdx_12_26_9_w600_1h_k0.8mv_v3; the id was made for
// the blue line's own top, which was never mailed, and is the pane's rule's);
// the subscriptions are as they were.
// #362 (docs §8.122): from v30 the band starts at 95% (ZONE_PCT 95), the
// owner's 「やっぱりメールの判断を95%に設定して」 (2026-10-19), mailed under
// macdx_12_26_9_w600_1h_z95of120_v6 (not _v5: the 80% cross rule of #359,
// never put out, was made under macdx_12_26_9_w600_1h_x80of120_v5, docs
// §8.121); the pane, the bars and the subscriptions are as they were.
// #384 (docs §8.127): from v31 the same rule on the 15-minute chart in place
// of the 1-hour one (MACDH_INTERVALS), the owner's 「メールの判断15分足に変更して」
// (2026-10-26): the same 600 bars, 120-bar pane and 95%, now 15-minute bars,
// mailed under macdx_12_26_9_w600_15min_z95of120_v7; the subscriptions are
// moved to the 15-minute chart of the same six.
// #386 (docs §8.129): from v33 back on the 1-hour chart (MACDH_INTERVALS),
// the owner's 「やっぱりメールの判断を1時間にしてください」 (2026-10-30): v30's
// rule again (600 bars, 120-bar pane, 95%), mailed under
// macdx_12_26_9_w600_1h_z95of120_v8 (not v6's id again, so the days on the
// 15-minute chart stay apart in the record); the subscriptions are moved back
// to the 1-hour chart of the same six.
// #397 (docs §8.150): from v39 the email is a ride (_shared/macd-ride.ts,
// research/macdride-spec.md), the owner's 「MACD 90%→96%: 足の確定で入ると 96%
// まで行く メールをこれに変更、なので、一つのペアで2回メールを送る」
// (2026-11-12): email 1 at the close of the 1-hour bar at which the blue line
// came into the 90% band of the pane's top (a BUY) or bottom (a SELL) with
// the bar before outside it, an entry with the flow (the opposite side of
// v28 to v38's); a notice in its place where the line is already at 96% at
// that close; email 2 the moment the line reaches 96% of the same edge. The
// 95% email is stopped: its id, macdx_12_26_9_w600_1h_z95of120_v8, is never
// written again. Three ids, one a mail, built from the ride's constants
// (rideRuleId): macdx_12_26_9_w600_1h_ride90to96of120_in_v9 (email 1),
// ..._at_v9 (the notice) and ..._out_v9 (email 2). They start as the app
// reads the rule back from them; the subscriptions keep rule = 'macdx', on
// the same charts.
// MACDH_K is v26's k, kept with the rule it belongs to (decideScaledOnWindow,
// which the morning check's SQL v3 mirrors); no email uses it from v28.
export const MACDH_K = 0.8;
export const MACDH_RIDE_VERSION = 9;
// email 1's (the entry's): what indicatorRuleId gives for 'macdx'
export const MACDH_RULE_ID = rideRuleId("macdx", "in", MACDH_RIDE_VERSION);
// the notice's (already at 96% at the entry bar's close) and email 2's (the
// ride reached 96%)
export const MACDH_AT_RULE_ID = rideRuleId("macdx", "at", MACDH_RIDE_VERSION);
export const MACDH_OUT_RULE_ID = rideRuleId("macdx", "out", MACDH_RIDE_VERSION);
// #291: the video's way (docs §8.112, _shared/sweep-cross.ts): EMA 20 and EMA
// 80, judged on the 600 closed bars ending at the bar, crosses counted from
// its 241st, the stop a pip beyond the last five bars, the targets 15 and 20
// pips
export const SWEEPX_RULE_ID =
  `sweepx_ema${SWEEPX.fast}_${SWEEPX.slow}_w${SWEEPX.window}_from${SWEEPX.warm}` +
  `_sl${SWEEPX.slBars}b${SWEEPX.slPips}p_tp${SWEEPX.tp1Pips}_${SWEEPX.tp2Pips}_v1`;
// #385: AMD Po3 v2.4.0 at its default settings (docs §8.128)
export const AMDPO3_RULE_ID = `amdpo3_${AMD_PO3.version}_defaults_v1`;
// #387: the EMA 20 / 200 way (docs §8.130, research/ema-return-spec.md):
// judged on the 600 closed bars ending at the bar, crosses counted from its
// 401st, swings 3 bars on each side, the 1st and 2nd bars after the break no
// return move
export const EMARM_RULE_ID =
  `emarm_ema${EMA_RETURN.fast}_${EMA_RETURN.slow}_w${EMA_RETURN.window}_from${EMA_RETURN.warm}_piv${EMA_RETURN.piv}_skip${EMA_RETURN.skip}_v1`;
// #395: a sharp rise (fall): the 1-hour bar's high (low) SPIKE.k times the mean
// range of the SPIKE.bars closed bars before it away from its open
export const SPIKE_RULE_ID = `spike_1h_x${SPIKE.k}_r${SPIKE.bars}_v1`;
// The id each rule's emails are recorded under now (#324: 'macdx' under the
// 1-hour rule's; #397: under its email 1's, the ride's other two mails each
// under its own: signalRuleId, below)
export const indicatorRuleId = (rule: IndicatorRule): string =>
  rule === "qtrend"
    ? QTREND_RULE_ID
    : rule === "macdx"
    ? MACDH_RULE_ID
    : rule === "sweepx"
    ? SWEEPX_RULE_ID
    : rule === "amdpo3"
    ? AMDPO3_RULE_ID
    : rule === "emarm"
    ? EMARM_RULE_ID
    : rule === "stockmacd"
    ? STOCKMACD_RULE_ID
    : rule === "spike"
    ? SPIKE_RULE_ID
    : ULTRA_RULE_ID;
// #397: the id a signal's row is written under (signal_alerts.rule, part of
// the key that keeps a mail from being sent twice): its rule's, and for a
// mail of the MACD ride that mail's own — the rule's email 1 id with "in"
// made "at" or "out" (so 'macdx' gives MACDH_AT_RULE_ID and
// MACDH_OUT_RULE_ID, and 'stockmacd' its own three once its id is email 1's;
// an id that is not a ride's is left as it is)
export const rideRuleIdOf = (inId: string, mail: RideMail): string =>
  inId.replace(`_${RIDE_RULE_TAG}_in_`, `_${RIDE_RULE_TAG}_${mail}_`);
export const signalRuleId = (s: Pick<IndicatorSignal, "rule" | "ride">): string =>
  s.ride ? rideRuleIdOf(indicatorRuleId(s.rule), s.ride.mail) : indicatorRuleId(s.rule);

// Every pair the live chart has, on these timeframes; those read from
// Twelve Data on 1 hour and up only, but gold on 15 minutes too (#212, the
// owner 2026-10-07: gold's 15-minute ULTRA emails; one more Twelve Data read
// a 15-minute close, within the day's 800 shared with the chart)
export const INDICATOR_PAIRS: readonly string[] = LIVE_PAIRS;
export const INDICATOR_INTERVALS = ["5min", "15min", "1h", "4h", "1day"] as const;
export const TWELVE_ALERT_INTERVALS = ["1h", "4h", "1day"] as const;
export const GOLD_ALERT_INTERVALS = ["15min", "1h", "4h", "1day"] as const;
export const indicatorIntervalsFor = (pair: string): readonly string[] =>
  isGold(pair) ? GOLD_ALERT_INTERVALS : isTwelvePair(pair) ? TWELVE_ALERT_INTERVALS : INDICATOR_INTERVALS;
export const isIndicatorChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && INDICATOR_PAIRS.includes(pair) &&
  indicatorIntervalsFor(pair).includes(interval);
// Read from GMO (its free public bars), or from Twelve Data
export const isGmoChartPair = (pair: string): boolean => GMO_SYMBOLS[pair] !== undefined && !isTwelvePair(pair);

// #275: the MACD rule is read on the 5-minute chart only (the rule was frozen
// and measured there, §8.109) and on GMO's currency pairs only (the 600
// closed bars it judges on are GMO's own, mid of bid and ask; gold and the
// pairs read from Twelve Data are not offered)
// #324: from v25 that rule is no longer mailed (the 1-hour rule below is, in
// its place), but the studies still decide through it (research/macdx.ts,
// research/ownerhold-data.ts, §8.113's research/chartbest-*): its chart and
// macdxSignals are kept as they were
export const MACDX_INTERVALS = ["5min"] as const;
export const MACDX_PAIRS: readonly string[] = INDICATOR_PAIRS.filter((p) => isGmoChartPair(p) && !isGold(p));
export const isMacdxChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && MACDX_PAIRS.includes(pair) &&
  (MACDX_INTERVALS as readonly string[]).includes(interval) && isIndicatorChart(pair, interval);
// #324: the charts the MACD email ('macdx') is followed on from v25: the
// 1-hour chart of the five pairs the owner chose (「今の5ペア」). The level was
// the owner's number on USD/JPY's chart, so the other GMO pairs were not
// offered (on the cheap yen pairs — HUF/JPY is some 0.4 yen — 0.085 is
// another thing altogether). #339: the level is each pair's own from v26,
// and the owner kept the five pairs (「今の5ペア」)
// #345 (docs §8.118): and gold, from v27 (the owner: 「金も1時間足でmacdのクロス
// でメールを送るようにして」). Its bars are Twelve Data's, not GMO's (GMO has no
// gold), kept by the live chart and read by the sweep as gold's other Twelve
// Data charts are; the level is the same rule's, MACDH_K times gold's usual
// hourly move (dollars), so nothing in the rule is gold's own.
// #353 (docs §8.119): from v28 the zone rule on the same charts (the five
// pairs and gold): each on its own MACD, so nothing in it is a pair's or
// gold's own either.
// #384 (docs §8.127): from v31 their 15-minute chart in place of the 1-hour
// one (the owner: 「メールの判断15分足に変更して」). The five pairs' 15-minute
// bars are GMO's, read 0, 1 and 3 minutes after each quarter hour
// (gmoIntervalsDue); gold's are Twelve Data's, read from a minute after the
// close (twelveCloseDue), one read a close, within the day's reads shared with
// the chart (gold's 15-minute ULTRA emails were read the same way, #212).
// #386 (docs §8.129): from v33 their 1-hour chart again, as up to v30 (the
// owner: 「やっぱりメールの判断を1時間にしてください」): the five pairs' bars
// read 0, 3 and 5 minutes after the hour, gold's from a minute after the close.
export const MACDH_INTERVALS = ["1h"] as const;
export const MACDH_PAIRS: readonly string[] = [
  ...MACDX_PAIRS.filter((p) => ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"].includes(p)),
  GOLD,
];
export const isMacdhChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && MACDH_PAIRS.includes(pair) &&
  (MACDH_INTERVALS as readonly string[]).includes(interval) && isIndicatorChart(pair, interval);
// #291: the video's way is mailed on gold's 1-minute chart only (the owner:
// 「1分足のゴールド専用のゴールドの売買のメールだけはこれで判断して」), whose bars
// are the minutes recorded from Swissquote's prices (gold-minutes.ts); the
// chart draws its marks on every pair and timeframe
export const SWEEPX_PAIRS = ["XAU/USD"] as const;
export const SWEEPX_INTERVALS = ["1min"] as const;
export const isSweepxChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && (SWEEPX_PAIRS as readonly string[]).includes(pair) &&
  (SWEEPX_INTERVALS as readonly string[]).includes(interval);
// #387: the EMA 20 / 200 way is mailed on the 15-minute chart of the five
// pairs and gold (the owner: 「今の5ペア＋金の15分足」, 2026-10-30; the
// video's is GBP/JPY's 15-minute chart); the chart draws it on every pair and
// timeframe
export const EMARM_PAIRS: readonly string[] = MACDH_PAIRS;
export const EMARM_INTERVALS = ["15min"] as const;
export const isEmarmChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && EMARM_PAIRS.includes(pair) &&
  (EMARM_INTERVALS as readonly string[]).includes(interval) && isIndicatorChart(pair, interval);
// #395: a sharp rise or fall is mailed on the 1-hour chart of the five pairs
// and gold (the owner: 「5ペア＋金」, 2026-11-05); the chart draws it on every
// pair's 1-hour chart
export const SPIKE_PAIRS: readonly string[] = MACDH_PAIRS;
export const SPIKE_INTERVALS = ["1h"] as const;
export const isSpikeChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && SPIKE_PAIRS.includes(pair) &&
  (SPIKE_INTERVALS as readonly string[]).includes(interval) && isIndicatorChart(pair, interval);
// Whether a chart can be followed under a rule (#324: 'macdx' on the 1-hour
// rule's charts; #385: 'amdpo3' on Q-Trend's and ULTRA's; #387: 'emarm' on its own;
// #395: 'spike' on its own)
export const isIndicatorChartFor = (rule: unknown, pair: unknown, interval: unknown): boolean =>
  rule === "macdx"
    ? isMacdhChart(pair, interval)
    : rule === "spike"
    ? isSpikeChart(pair, interval)
    : rule === "sweepx"
    ? isSweepxChart(pair, interval)
    : rule === "emarm"
    ? isEmarmChart(pair, interval)
    : rule === "stockmacd"
    ? isStockmacdChart(pair, interval)
    : isIndicatorChart(pair, interval);

// ULTRA's numbers are dollars on gold, pips on a currency pair (the chart's
// `isGoldPair(pair) ? 1 : pipSize(pair)`)
export const ultraUnit = (pair: string): number => (isGold(pair) ? 1 : pair.toUpperCase().includes("JPY") ? 0.01 : 0.0001);

// A signal is mailed while its bar closed at most this long ago: a missed
// run is covered by the next, and past this the price has moved on. The
// hourly and slower ones wait longer: those read from Twelve Data are read
// a few a minute (TWELVE_READS_PER_RUN), up to 48 at midnight UTC (#175:
// 18, six of them on three timeframes; #180: 21, seven).
// #291: gold's 1-minute bars, two minutes (docs §8.112)
export const freshFor = (interval: string): number =>
  interval === "1min" ? 2 * 60_000 : interval === "5min" ? 10 * 60_000 : interval === "15min" ? 20 * 60_000 : 30 * 60_000;

export interface IndicatorSignal {
  rule: IndicatorRule;
  pair: string;
  interval: string;
  side: "BUY" | "SELL";
  // Q-Trend's STRONG (a bar in the last five opened in the 200-bar range's
  // end eighth); false for ULTRA
  strong: boolean;
  // the open of the bar it fired on, and when that bar closed, ISO
  barTime: string;
  closedAt: string;
  close: number;
  // Q-Trend: its trend line at the bar, and ε (ATR(14) of the bar before × 1)
  line: number | null;
  eps: number | null;
  // ULTRA: RSI(14) at the bar and the bar before, the entry (the close), the
  // stop and three targets (#291: the video's way, two)
  rsi: number | null;
  rsiPrev: number | null;
  sl: number | null;
  tps: number[] | null;
  // #275: the MACD rule's numbers at the bar (absent on the other rules')
  macd?: MacdxFacts | null;
  // #291: the video's way's (absent on the other rules')
  sweep?: SweepxFacts | null;
  // #324: the 1-hour MACD rule's (the MACD email's from v25; absent on the others'; #384: the 15-minute chart's from v31;
  // #386: the 1-hour chart's again from v33; #397: no email of the pairs' or gold's carries it from v39 — `ride`, below)
  macdh?: MacdhFacts | null;
  // #385: AMD Po3's (absent on the other rules')
  amd?: AmdFacts | null;
  // #387: the EMA 20 / 200 way's (absent on the other rules')
  emarm?: EmarmFacts | null;
  // #395: a sharp rise's or fall's (absent on the other rules')
  spike?: SpikeFacts | null;
  // #397: the MACD ride's (the MACD email's from v39, and the shares'; absent
  // on the other rules'): which of its three mails this is, and its numbers
  ride?: RideFacts | null;
}

// #397 (docs §8.150): a mail of the MACD ride. `mail`: "in" email 1 (the
// entry), "at" the notice (already at 96% at the entry bar's close: no
// entry), "out" email 2 (the ride reached 96%). `zside`: the side of the
// MACD pane the line is on, the top for a BUY and the bottom for a SELL (the
// opposite of the 95% email's). m, top and bottom: the MACD line and the
// pane's edges at the entry bar's close (in, at); none on an email 2, which
// is written from the ride's row (public.macd_rides keeps the line's share
// only) so that every run mails the same numbers. The entry bar by its open
// and close (ISO) and the price paid there (in, out: a pair's ask close for a
// BUY and bid close for a SELL, gold's and a share's close; at: the bar's
// close, no entry being made). Email 2 alone: when the reach was seen, the
// open of the bar it was reached in, whether it was seen late (in a closed
// bar, after the bar it was reached in had ended) and the price when seen (a
// BUY leaves on the bid, a SELL on the ask).
// On a ride's signal: barTime is the entry bar's open on all three (so one
// email 2 a ride and follower, whatever minute it is seen in), closedAt the
// entry bar's close (in, at) or when the reach was seen (out), close the
// entry bar's close as the chart draws it (in, at) or the price when seen
// (out), and there is no stop and no target (sl and tps null).
export interface RideFacts {
  mail: RideMail;
  zside: RideZoneSide;
  m: number | null;
  top: number | null;
  bottom: number | null;
  entryBar: string;
  entryClosedAt: string;
  entryPrice: number;
  seenAt?: string | null;
  reachedBar?: string | null;
  late?: boolean | null;
  seenPrice?: number | null;
}

// #395: what was seen: the bar's open, how far it went (its high on a rise,
// its low on a fall, at the time seen), the move from the open, the usual
// range R (the mean high − low of the 120 closed bars before it) and the move
// as a multiple of R; whether the bar was still forming, and when it closes.
// A spike's closedAt is when it was seen (the sweep's clock), not the close,
// so the time to send is counted from there (docs §8.138)
export interface SpikeFacts {
  open: number;
  extreme: number;
  move: number;
  r: number;
  x: number;
  forming: boolean;
  closesAt: string;
  // the open hours between the newest bar R was made from and the bar (0;
  // 1 when gold's stored read was a bar behind: spikeRangeFor)
  behind: number;
}

// #387: what made the EMA 20 / 200 way enter: the cross, the touch of the
// 200 EMA, A (the highest high since the cross on a BUY, the lowest low on a
// SELL: target 1) and its bar, B's bar and the horizontal at its high (low),
// the break of both lines, the return move, each bar by its close (ISO), and
// the ratio of the distance to target 1 to the stop's
export interface EmarmFacts {
  crossClosedAt: string;
  touchClosedAt: string;
  a: number;
  aClosedAt: string;
  neck: number;
  neckClosedAt: string;
  breakClosedAt: string;
  retestClosedAt: string;
  rr: number;
}

// #385: what made AMD Po3 open its reference trade: the accumulation range as
// it stood (its high and low, and the bar it began on by its close, ISO), the
// side swept (HIGH: over the range, a SELL; LOW: under it, a BUY) and the
// sweep's tip, the risk (entry to stop) and the R:R as D's tooltip writes it
export interface AmdFacts {
  rangeHigh: number;
  rangeLow: number;
  rangeFromClosedAt: string;
  sweepSide: "HIGH" | "LOW";
  sweepExtreme: number;
  riskR: number;
  rr: string;
}

// #324: what made the 1-hour MACD rule fire, in price units (v25 to v27:
// MACD and its signal line at the cross, and the level held against).
// #353 (docs §8.119): from v28 the zone rule's (_shared/macd-level.ts
// decideZoneOnWindow): the MACD line (the blue line) at the bar, the top and
// bottom of the MACD pane of the ZONE_BARS ending at the bar (the highest and
// lowest of the MACD line, the signal line and the histogram there, and 0),
// and the mark the side's band starts at, ZONE_SHARE times the top (a SELL
// needs m >= mark) or the bottom (a BUY m <= mark), as compared, unrounded
export interface MacdhFacts {
  m: number;
  top: number;
  bottom: number;
  mark: number;
}

// #291: what made the video's way fire: the last wave's low (BUY) or high
// (SELL) that was taken and the bar it was on, how far the leg went past it
// and the bar, the two crosses before the bar's (the leg's start and the
// wave's), each bar by its close (ISO), and the two lines at the bar
export interface SweepxFacts {
  level: number;
  levelClosedAt: string;
  extreme: number;
  extremeClosedAt: string;
  legFromClosedAt: string;
  waveFromClosedAt: string;
  fast: number;
  slow: number;
}

// #275: what made the MACD rule fire, in price units: m the MACD line at the
// bar, x its distance from zero on the side the cross happened (C0: x > 0),
// avgRange the mean true range over the last 288 bars (C1: x at least a
// quarter of it), peak the wave's largest |MACD| (C2: x at least half of it)
export interface MacdxFacts {
  dir: "UP" | "DOWN";
  m: number;
  x: number;
  avgRange: number;
  peak: number;
}

// Every signal of either indicator whose bar closed inside `freshMs`, judged
// as the chart judges it. `closed`: the chart's closed bars for this chart,
// oldest first (live-chart historyRead / historyOfBars: its history, rounded
// as drawn) — ANCHOR_WINDOW of them, or as many as the chart's history
// holds where it holds fewer (GMO's daily bars: this year's file and last
// year's); the caller sees to that (a read cut short is not judged on).
// Fewer than Q-Trend's first line needs: nothing is judged.
export const indicatorSignals = (
  pair: string,
  interval: string,
  closed: ReadonlyArray<Candle>,
  nowMs: number,
  freshMs: number = freshFor(interval),
): IndicatorSignal[] => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined || closed.length <= QT_DEFAULTS.period) return [];
  const times = closed.map((c) => barOpenMs(c.datetime));
  if (times.some((t) => !Number.isFinite(t))) return [];
  const last = closed.length - 1;
  // the chart draws the newest CHART_BARS closed bars (and the one forming)
  const firstShown = Math.max(0, last - (CHART_BARS - 1));
  const from = anchoredStart(times, barStepMs(times.slice(firstShown)), firstShown, QT_DEFAULTS.period, last);
  const bars = closed.slice(from);
  const freshAt = (i: number) => {
    const open = times[i + from];
    const age = nowMs - (open + step);
    return age >= 0 && age <= freshMs ? open : null;
  };
  const out: IndicatorSignal[] = [];
  // #192: the stop 13 and the targets 4, 10 and 16, dollars on gold and pips
  // on a currency pair (before it #166's stop of 30 pips, #168's gold targets
  // of $30, $60 and $90, #173's pair targets of 20, 40 and 60 pips)
  const levels = ultraParamsFor(isGold(pair));
  const qt = qTrend(bars, QT_DEFAULTS, bars.length - 1);
  const atr = pineAtr(bars, QT_DEFAULTS.atrPeriod);
  for (const s of qt.signals) {
    const open = freshAt(s.i);
    if (open === null) continue;
    // what the close broke: the line as it stood (m[1] in Pine, past the
    // first `period` bars) by ε, ATR of the bar before × mult
    const line = s.i > QT_DEFAULTS.period ? qt.line[s.i - 1] : null;
    const a = s.i > 0 ? atr[s.i - 1] : null;
    // #156: ULTRA's stop and targets (the owner's choice), as the chart draws them
    const lv = ultraLevels(s.side, bars[s.i].close, ultraUnit(pair), levels);
    out.push({
      rule: "qtrend",
      pair,
      interval,
      side: s.side,
      strong: s.strong,
      barTime: new Date(open).toISOString(),
      closedAt: new Date(open + step).toISOString(),
      close: bars[s.i].close,
      line: line ?? null,
      eps: a === null ? null : QT_DEFAULTS.mult * a,
      rsi: null,
      rsiPrev: null,
      sl: lv.sl,
      tps: lv.tps,
    });
  }
  const ul = ultra(bars, bars.length - 1, ultraUnit(pair), levels);
  for (const tr of ul.trades) {
    const open = freshAt(tr.i);
    if (open === null) continue;
    out.push({
      rule: "ultra",
      pair,
      interval,
      side: tr.side,
      strong: false,
      barTime: new Date(open).toISOString(),
      closedAt: new Date(open + step).toISOString(),
      close: tr.entry,
      line: null,
      eps: null,
      rsi: ul.rsi[tr.i],
      rsiPrev: tr.i > 0 ? ul.rsi[tr.i - 1] : null,
      sl: tr.sl,
      tps: tr.tps,
    });
  }
  return out;
};

// #275: the MACD peak-and-valley rule (docs §8.109) at the newest closed bar.
// The sweep calls it beside indicatorSignals, not inside it: that one gives
// what the live chart labels (Q-Trend's and ULTRA's; src/test/indicator-
// alerts.test.tsx holds the two to each other), and the chart draws no
// MACD peak/valley label. It is judged as the study judged it: on the 600 closed bars ending at the
// bar and on nothing else (decideOnWindow, the code the rule was measured
// with), so the chart's `closed` — the 600 closed bars the sweep reads — gives
// exactly one decision, the newest bar's. Not on a short history, not on a
// chart the rule is not offered on, and only while the bar is fresh. Its
// stop and targets are ULTRA's (the rule has none of its own; the study
// followed these, docs §8.109 測り方). Only the newest bar is judged, so a bar
// GMO publishes after the reads at +0, +1 and +3 minutes (and not in time for
// the next close) is not judged late, as ULTRA's older bars are within their
// freshness window; the study's "mailed" is the same (docs §8.110).
export const macdxSignals = (
  pair: string,
  interval: string,
  closed: ReadonlyArray<Candle>,
  nowMs: number,
  freshMs: number = freshFor(interval),
): IndicatorSignal[] => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined || !isMacdxChart(pair, interval) || closed.length < MACDX_WINDOW) return [];
  const i = closed.length - 1;
  const open = barOpenMs(closed[i].datetime);
  if (!Number.isFinite(open)) return [];
  const age = nowMs - (open + step);
  if (age < 0 || age > freshMs) return [];
  const d = decideOnWindow(closed, i);
  if (d === null || !d.fire) return [];
  const close = closed[i].close;
  const lv = ultraLevels(d.side, close, ultraUnit(pair), ultraParamsFor(false));
  return [{
    rule: "macdx",
    pair,
    interval,
    side: d.side,
    strong: false,
    barTime: new Date(open).toISOString(),
    closedAt: new Date(open + step).toISOString(),
    close,
    line: null,
    eps: null,
    rsi: null,
    rsiPrev: null,
    sl: lv.sl,
    tps: lv.tps,
    // x is MACD on a down cross and minus MACD on an up cross (price units)
    macd: { dir: d.dir, m: d.dir === "DOWN" ? d.x : -d.x, x: d.x, avgRange: d.S / MACDX_N_TR, peak: d.P },
  }];
};

// #324: the MACD email's rule from v25 (docs §8.114; _shared/macd-level.ts)
// was judged here at the newest closed bar of a 1-hour chart (macdhSignals:
// v25's cross at the owner's level, v26's at the pair's own, §8.116; v27 gold
// too, §8.118; from v28 the zone rule, a SELL at the bar where the blue line
// came into the top band of the newest 120 bars' MACD pane and a BUY into the
// bottom band, §8.119, 95% from v30, §8.122; v31 on the 15-minute chart,
// §8.127; v33 on the 1-hour chart again, §8.129), with ULTRA's stop and
// targets.
// #397 (docs §8.150): from v39 that decision makes no email. The MACD email
// is a ride (_shared/macd-ride.ts; research/macdride-spec.md): what a bar's
// close does is rideEntryAt and rideCloseStep there, on the chart's rides
// kept in public.macd_rides, and a ride is reached by rideTouch (each minute)
// or rideCatchUp (at a close); the sweep (index.ts) reads and writes the
// tables. What is here: the ride's row as read back, its prices, the forming
// hour as the minute's check reads it, and the three mails as signals, all
// pure so that the tests and the shares' run can call them. No stop and no
// target (the owner holds with none; email 2 reports the line, not a profit).

// A row of public.macd_rides as the function reads it back (its times as
// milliseconds): one trade of one chart and trade side, opened by email 1 at
// the close of its entry bar and reached the first time the line is seen at
// 96% of its edge
export interface MacdRide {
  pair: string;
  side: RideSide;
  // the entry bar's open, and when it closed
  entryBar: number;
  entryClosedAt: number;
  // the price paid, and the entry bar's close as the chart draws it
  entryPrice: number;
  entryMid: number;
  // the line's share of the way to its edge at the entry (m / top or bottom)
  share0: number | null;
  status: "open" | "reached";
  // when the reach was seen, the open of the bar it was reached in, the
  // price when seen, whether it was seen late, the line's share at the touch
  reachedAt: number | null;
  reachedBar: number | null;
  seenPrice: number | null;
  late: boolean | null;
  share1: number | null;
}
// The columns a ride is read with (never select=*)
export const MACD_RIDE_COLUMNS =
  "pair,side,entry_bar,entry_closed_at,entry_price,entry_mid,share0,status,reached_at,reached_bar,seen_price,late,share1";
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const timeOf = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};
// A ride from its row; null when the row is not one (no pair, side, entry bar
// or price, or a status that is neither)
export const macdRideOf = (row: unknown): MacdRide | null => {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const entryBar = timeOf(r.entry_bar);
  const entryClosedAt = timeOf(r.entry_closed_at);
  const entryPrice = finite(r.entry_price);
  const entryMid = finite(r.entry_mid);
  if (typeof r.pair !== "string" || (r.side !== "BUY" && r.side !== "SELL") || (r.status !== "open" && r.status !== "reached")) return null;
  if (entryBar === null || entryClosedAt === null || entryPrice === null || entryMid === null) return null;
  return {
    pair: r.pair,
    side: r.side,
    entryBar,
    entryClosedAt,
    entryPrice,
    entryMid,
    share0: finite(r.share0),
    status: r.status,
    reachedAt: timeOf(r.reached_at),
    reachedBar: timeOf(r.reached_bar),
    seenPrice: finite(r.seen_price),
    late: typeof r.late === "boolean" ? r.late : null,
    share1: finite(r.share1),
  };
};
// A ride as rideCloseStep reads it
export const rideRowOf = (r: MacdRide): RideRow => ({ side: r.side, entryBar: r.entryBar, status: r.status, reachedBar: r.reachedBar });

// The price a ride pays at a bar's close and the one it would leave at there,
// from GMO's bar with both sides (as given, unrounded): a BUY is filled on
// the ask and leaves on the bid, a SELL the other way (research/macd90-spec.md).
// Gold and the shares have one price, the bar's close.
export const ridePaidAt = (side: RideSide, q: QuoteCandle): number => sideOf(q, fillSide(side)).close;
export const rideLeaveAt = (side: RideSide, q: QuoteCandle): number => sideOf(q, exitSide(side)).close;

// A pair's 1-hour bar forming at `hourMs`, as the minute's check for 96%
// reads it from GMO's 1-hour read (`quotes`, bid and ask): its high and low
// so far, the mid of the two sides rounded as the chart draws them (as the
// sharp rise reads the forming bar), and the newest bid and ask (its closes
// so far, as given). Null when the read holds no bar forming at that hour.
export const rideFormingOf = (
  pair: string,
  quotes: ReadonlyArray<QuoteCandle>,
  hourMs: number,
  nowMs: number,
): { high: number; low: number; quote: QuoteCandle } | null => {
  const f = splitBars([...quotes], "1h", nowMs);
  if (!f.forming || !f.formingQuote || barOpenMs(f.forming.datetime) !== hourMs) return null;
  const d = decimalsOf(pair);
  const high = Number(f.forming.high.toFixed(d));
  const low = Number(f.forming.low.toFixed(d));
  return Number.isFinite(high) && Number.isFinite(low) ? { high, low, quote: f.formingQuote } : null;
};

// Gold's hour starting at `hourMs` so far, from its recorded minutes
// (public.gold_tick_bars: Swissquote's mid): the highest high and the lowest
// low of the minutes in the hour and the newest minute's close, rounded as
// the chart draws gold (2 decimals). Unlike the sharp rise's bar (goldHourBar)
// the hour's open is not needed, so an hour whose first minutes were not
// recorded is read from the minutes there are. Null with no minute in it.
export const goldHourExtremes = (
  minutes: ReadonlyArray<{ minute: string; high: number; low: number; close: number }>,
  hourMs: number,
): { high: number; low: number; close: number; minutes: number } | null => {
  const inHour = minutes
    .map((m) => ({ ...m, t: Date.parse(m.minute) }))
    .filter((m) => m.t >= hourMs && m.t < hourMs + HOUR_MS && [m.high, m.low, m.close].every((v) => Number.isFinite(v)))
    .sort((a, b) => a.t - b.t);
  if (inHour.length === 0) return null;
  const r2 = (v: number) => Number(v.toFixed(2));
  return {
    high: r2(Math.max(...inHour.map((m) => m.high))),
    low: r2(Math.min(...inHour.map((m) => m.low))),
    close: r2(inHour[inHour.length - 1].close),
    minutes: inHour.length,
  };
};

// How long after a ride was reached its email 2 still goes to a follower who
// has none (a lookup that failed is tried again by the next runs): the
// hourly chart's freshness, half an hour
export const RIDE_OUT_FRESH_MS = 30 * 60_000;

const isoOf = (ms: number): string => new Date(ms).toISOString();

// Email 1 ("in") or the notice ("at") at the close of the bar an entry was
// found at (rideEntryAt), as a signal. `bar`: its open and close (ms), its
// close as the chart draws it, and the price paid (in: a pair's ask close for
// a BUY and bid close for a SELL, gold's and a share's close; the notice
// makes no entry and carries the bar's close). `rule`: 'macdx' (the pairs and
// gold) or 'stockmacd' (the shares).
export const rideCloseSignal = (
  rule: "macdx" | "stockmacd",
  pair: string,
  interval: string,
  mail: "in" | "at",
  entry: RideEntry,
  bar: { openMs: number; closeMs: number; mid: number; paid: number },
): IndicatorSignal => ({
  rule,
  pair,
  interval,
  side: entry.side,
  strong: false,
  barTime: isoOf(bar.openMs),
  closedAt: isoOf(bar.closeMs),
  close: bar.mid,
  line: null,
  eps: null,
  rsi: null,
  rsiPrev: null,
  sl: null,
  tps: null,
  ride: {
    mail,
    zside: entry.zside,
    m: entry.z.m,
    top: entry.z.top,
    bottom: entry.z.bottom,
    entryBar: isoOf(bar.openMs),
    entryClosedAt: isoOf(bar.closeMs),
    entryPrice: mail === "at" ? bar.mid : bar.paid,
  },
});

// Email 2 ("out") of a ride that was reached, as a signal, from its row
// alone: every run that mails it writes the same numbers. Its bar is the
// ride's entry bar and its closedAt when the reach was seen. Null while the
// ride is open, or its row holds no time or price for the reach.
export const rideOutSignal = (rule: "macdx" | "stockmacd", interval: string, ride: MacdRide): IndicatorSignal | null => {
  if (ride.status !== "reached" || ride.reachedAt === null || ride.seenPrice === null) return null;
  return {
    rule,
    pair: ride.pair,
    interval,
    side: ride.side,
    strong: false,
    barTime: isoOf(ride.entryBar),
    closedAt: isoOf(ride.reachedAt),
    close: ride.seenPrice,
    line: null,
    eps: null,
    rsi: null,
    rsiPrev: null,
    sl: null,
    tps: null,
    ride: {
      mail: "out",
      zside: rideZoneSideOf(ride.side),
      m: null,
      top: null,
      bottom: null,
      entryBar: isoOf(ride.entryBar),
      entryClosedAt: isoOf(ride.entryClosedAt),
      entryPrice: ride.entryPrice,
      seenAt: isoOf(ride.reachedAt),
      reachedBar: ride.reachedBar === null ? null : isoOf(ride.reachedBar),
      late: ride.late === true,
      seenPrice: ride.seenPrice,
    },
  };
};

// What a signal's row in public.signal_alerts says of it (the claim's key is
// user_id, kind, pair, interval, bar_time, side, rule). A ride's: under its
// mail's own id, the entry the price paid (the notice: the bar's close), no
// stop, and on email 2 alone the target column holds the price when seen —
// so one email 2 a ride and follower, and it cannot meet a new email 1 or
// notice of the same bar and side.
export const signalRow = (s: IndicatorSignal): {
  bar_time: string;
  closed_at: string;
  side: "BUY" | "SELL";
  entry: number;
  stop: number | null;
  target: number | null;
  rule: string;
} => ({
  bar_time: s.barTime,
  closed_at: s.closedAt,
  side: s.side,
  entry: s.ride ? s.ride.entryPrice : s.close,
  stop: s.ride ? null : s.sl,
  target: s.ride ? (s.ride.mail === "out" ? s.ride.seenPrice ?? null : null) : s.tps ? s.tps[0] : null,
  rule: signalRuleId(s),
});

// How a ride's mail is written in a run's record (the signals of an entry of
// summary.reads): "macdx:BUY" email 1, "macdx-at:BUY" the notice and
// "macdx-out:BUY" email 2 (the shares': "stockmacd:", "stockmacd-at:",
// "stockmacd-out:"), so that a reader of the record who takes what starts
// with "macdx:" (the morning check's Routine) takes email 1 alone
export const rideSignalTag = (s: Pick<IndicatorSignal, "rule" | "side" | "ride">): string =>
  `${s.rule}${s.ride && s.ride.mail !== "in" ? `-${s.ride.mail}` : ""}:${s.side}`;

// Profit or loss since email 1 (research/macdride-spec.md section 2): the
// price when seen less the entry for a BUY, the entry less it for a SELL. A
// pair's in pips (0.01 on a yen pair, 0.0001 on the others) and gold's in
// dollars, worked in whole points of the price's decimals so that a
// difference of prices comes out as written (research/macd90-spec.md).
export const ridePnl = (pair: string, side: RideSide, entry: number, seen: number): { value: number; unit: "pips" | "usd" } => {
  const p = (x: number) => Math.round(x * 10 ** decimalsOf(pair));
  const points = side === "BUY" ? p(seen) - p(entry) : p(entry) - p(seen);
  return isGold(pair) ? { value: points / 100, unit: "usd" } : { value: points / 10, unit: "pips" };
};

// #291: the owner's video's way (docs §8.112) on gold's 1-minute chart. Each
// of the newest closed bars still fresh (two minutes: the minute just closed,
// and one a run that was missed did not judge) is judged on the SWEEPX.window
// closed bars ending at it and on nothing else — sweepCrossOnWindow, the
// code the moving-average chart draws its marks with, on the same bars (the
// minutes recorded, rounded as the chart's history is): a mark drawn on a
// bar the chart holds a full window before is the one mailed. Not on a
// history shorter than the window, nor on a chart the rule is not offered
// on. `closed`: those bars, oldest first.
export const sweepxSignals = (
  pair: string,
  interval: string,
  closed: ReadonlyArray<Candle>,
  nowMs: number,
  freshMs: number = freshFor(interval),
): IndicatorSignal[] => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined || !isSweepxChart(pair, interval) || closed.length < SWEEPX.window) return [];
  const pip = sweepPip(pair);
  const closeOf = (k: number) => new Date(barOpenMs(closed[k].datetime) + step).toISOString();
  const out: IndicatorSignal[] = [];
  // the bars that can still be fresh: a minute's, at most every few
  const first = Math.max(SWEEPX.window - 1, closed.length - 1 - Math.ceil(freshMs / step));
  for (let i = first; i < closed.length; i++) {
    const open = barOpenMs(closed[i].datetime);
    if (!Number.isFinite(open)) continue;
    const age = nowMs - (open + step);
    if (age < 0 || age > freshMs) continue;
    const start = i - SWEEPX.window + 1;
    const d = sweepCrossOnWindow(closed.slice(start, i + 1), pip);
    if (d === null) continue;
    out.push({
      rule: "sweepx",
      pair,
      interval,
      side: d.side,
      strong: false,
      barTime: new Date(open).toISOString(),
      closedAt: new Date(open + step).toISOString(),
      close: d.entry,
      line: null,
      eps: null,
      rsi: null,
      rsiPrev: null,
      sl: d.sl,
      tps: [...d.tps],
      sweep: {
        level: d.level,
        levelClosedAt: closeOf(start + d.levelAt),
        extreme: d.extreme,
        extremeClosedAt: closeOf(start + d.extremeAt),
        legFromClosedAt: closeOf(start + d.legFrom),
        waveFromClosedAt: closeOf(start + d.waveFrom),
        fast: d.fast,
        slow: d.slow,
      },
    });
  }
  return out;
};

// #385 (docs §8.128): AMD Po3's DIST — "manipulation confirmed, reference trade
// opened — the working signal", the alert the original sends at the D bar's
// close — on the charts Q-Trend and ULTRA are mailed on. Judged with the
// chart's code (_shared/amd-po3.ts, at its default settings) on the sweep's
// closed bars, `closed` (the chart's history: 600 on GMO's charts, rounded as
// drawn — fewer on GMO's daily chart, this year's and last year's: some 280 in
// January): each DIST whose bar closed inside `freshMs`. Its levels are the
// original's: the entry the D bar's close, the stop 0.4 × ATR 14 beyond the
// sweep's tip, the target the 1.5 extension of the sweep. A cycle depends on
// the bars before it; on 80 random walks the 600 bars ending at a bar opened
// the run over all of them's trade at every one, 450 bars all but 4 of 1,595,
// 300 bars all but 264 of 1,740 (docs §8.128). Not on fewer bars than its
// first cycle needs.
export const amdpo3Signals = (
  pair: string,
  interval: string,
  closed: ReadonlyArray<Candle>,
  nowMs: number,
  freshMs: number = freshFor(interval),
): IndicatorSignal[] => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined || !isIndicatorChart(pair, interval) || closed.length <= AMD_PO3.statWindow + AMD_PO3.rangeWin) return [];
  const times = closed.map((c) => barOpenMs(c.datetime));
  if (times.some((t) => !Number.isFinite(t))) return [];
  const run = amdPo3(closed.map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close })), { mintick: 1 / 10 ** decimalsOf(pair) });
  const out: IndicatorSignal[] = [];
  for (const tr of amdPo3Trades(run.events)) {
    const open = times[tr.bar];
    const age = nowMs - (open + step);
    if (age < 0 || age > freshMs) continue;
    out.push({
      rule: "amdpo3",
      pair,
      interval,
      side: tr.dir === 1 ? "BUY" : "SELL",
      strong: false,
      barTime: new Date(open).toISOString(),
      closedAt: new Date(open + step).toISOString(),
      close: tr.entry,
      line: null,
      eps: null,
      rsi: null,
      rsiPrev: null,
      sl: tr.stop,
      tps: [tr.target],
      amd: {
        rangeHigh: tr.rangeHigh,
        rangeLow: tr.rangeLow,
        rangeFromClosedAt: new Date(times[tr.rangeStart] + step).toISOString(),
        sweepSide: tr.sweepSide === 1 ? "HIGH" : "LOW",
        sweepExtreme: tr.sweepExtreme,
        riskR: tr.riskR,
        rr: pineFmt(tr.rr, 2),
      },
    });
  }
  return out;
};

// #387 (docs §8.130): the owner's video's EMA 20 / 200 way on the 15-minute
// chart of the five pairs and gold. Each of the newest closed bars still
// fresh (the bar just closed, and one a run that was missed did not judge,
// where `closed` holds the window before it too: gold's kept bars do, GMO's
// 600 hold the newest's only, so a bar no read judged is not mailed later) is
// judged on the EMA_RETURN.window closed bars ending at it and on nothing
// else — emaReturnOnWindow, the code the chart draws its marks with, on the
// same bars (the chart's history: 600 on GMO's charts, rounded as drawn;
// gold's Twelve Data bars kept by the live chart): a mark drawn on a bar the
// chart holds a full window before is the one mailed. Its levels are the
// rule's: the entry the bar's close, the stop the lowest low (highest high)
// from the bar that broke the diagonal to the entry, target 1 A, target 2 wave
// 1's height (when beyond the entry). Not on a history shorter than the
// window, nor on a chart the rule is not offered on.
export const emarmSignals = (
  pair: string,
  interval: string,
  closed: ReadonlyArray<Candle>,
  nowMs: number,
  freshMs: number = freshFor(interval),
): IndicatorSignal[] => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined || !isEmarmChart(pair, interval) || closed.length < EMA_RETURN.window) return [];
  const closeOf = (k: number) => new Date(barOpenMs(closed[k].datetime) + step).toISOString();
  const out: IndicatorSignal[] = [];
  const first = Math.max(EMA_RETURN.window - 1, closed.length - 1 - Math.ceil(freshMs / step));
  for (let i = first; i < closed.length; i++) {
    const open = barOpenMs(closed[i].datetime);
    if (!Number.isFinite(open)) continue;
    const age = nowMs - (open + step);
    if (age < 0 || age > freshMs) continue;
    const start = i - EMA_RETURN.window + 1;
    const d = emaReturnOnWindow(closed.slice(start, i + 1).map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close })));
    if (d === null) continue;
    out.push({
      rule: "emarm",
      pair,
      interval,
      side: d.side,
      strong: false,
      barTime: new Date(open).toISOString(),
      closedAt: new Date(open + step).toISOString(),
      close: d.entry,
      line: null,
      eps: null,
      rsi: null,
      rsiPrev: null,
      sl: d.stop,
      tps: d.tp2 === null ? [d.tp1] : [d.tp1, d.tp2],
      emarm: {
        crossClosedAt: closeOf(start + d.x),
        touchClosedAt: closeOf(start + d.t),
        a: d.a,
        aClosedAt: closeOf(start + d.aAt),
        neck: d.neck,
        neckClosedAt: closeOf(start + d.b),
        breakClosedAt: closeOf(start + d.k),
        retestClosedAt: closeOf(start + d.r),
        rr: d.rr,
      },
    });
  }
  return out;
};

// #395 (docs §8.138): the usual range R of the 1-hour bar opening at
// `openMs`: the mean high − low of the SPIKE.bars bars of `history` (closed,
// oldest first, rounded as the chart draws them) that opened before it,
// counted by the bar, gaps and all (_shared/spike.ts spikeRange). Not worked
// out ("short") with fewer bars than that before it, nor ("stale") when the
// newest of them leaves more than SPIKE_BEHIND_MAX hours the market was open
// (isPossiblyClosedFor: the weekend, gold's daily hour) without a bar before
// the bar (a stored read that was not made again); one is allowed, gold's
// stored read being made a minute after the hour. "zero": R not above zero.
export const SPIKE_BEHIND_MAX = 1;
export interface SpikeRangeRead {
  status: "ok" | "short" | "stale" | "zero";
  r: number | null;
  behind: number;
  lastBar: number | null;
}
export const spikeRangeFor = (pair: string, history: ReadonlyArray<Candle>, openMs: number): SpikeRangeRead => {
  const before = history.filter((c) => barOpenMs(c.datetime) < openMs);
  const lastBar = before.length > 0 ? barOpenMs(before[before.length - 1].datetime) : null;
  if (lastBar === null || !Number.isFinite(lastBar) || before.length < SPIKE.bars) return { status: "short", r: null, behind: 0, lastBar };
  let behind = 0;
  for (let t = lastBar + HOUR_MS; t < openMs; t += HOUR_MS) if (!isPossiblyClosedFor(pair, t)) behind++;
  if (behind > SPIKE_BEHIND_MAX) return { status: "stale", r: null, behind, lastBar };
  const r = spikeRange(before.slice(-SPIKE.bars).map((c) => ({ h: c.high, l: c.low })));
  return r === null ? { status: "zero", r: null, behind, lastBar } : { status: "ok", r, behind, lastBar };
};

// #395: the sharp rises and falls among `candidates` — the 1-hour bar
// forming now (its high and low so far), and the newest closed one while it
// closed at most SPIKE_LATE_MS ago (a move it made in its last minute is seen
// after its close) — each read against its R in `ranges` (by its open:
// spikeRangeFor's, kept for the hour; none, none judged). Each side once: a
// bar can be both. Its "entry" is the price seen (the bar's close so far),
// with no stop or target; its closedAt is when it was seen. Not on a chart
// the rule is not offered on.
export const SPIKE_LATE_MS = 10 * 60_000;
export const spikeSignals = (
  pair: string,
  interval: string,
  candidates: ReadonlyArray<{ bar: Candle; forming: boolean }>,
  ranges: ReadonlyMap<number, { r: number; behind: number }>,
  nowMs: number,
): IndicatorSignal[] => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined || !isSpikeChart(pair, interval)) return [];
  const out: IndicatorSignal[] = [];
  for (const { bar, forming } of candidates) {
    const open = barOpenMs(bar.datetime);
    if (!Number.isFinite(open)) continue;
    const end = open + step;
    if (forming ? !(open <= nowMs && nowMs < end) : !(end <= nowMs && nowMs - end <= SPIKE_LATE_MS)) continue;
    const range = ranges.get(open);
    if (!range || !Number.isFinite(range.r) || !(range.r > 0)) continue;
    const r = range.r;
    const s = spikeOf({ o: bar.open, h: bar.high, l: bar.low }, r);
    const sides = [
      { hit: s.isUp, side: "BUY" as const, extreme: bar.high, move: s.up, x: s.upX },
      { hit: s.isDown, side: "SELL" as const, extreme: bar.low, move: s.down, x: s.downX },
    ];
    for (const f of sides) {
      if (!f.hit) continue;
      out.push({
        rule: "spike",
        pair,
        interval,
        side: f.side,
        strong: false,
        barTime: new Date(open).toISOString(),
        closedAt: new Date(nowMs).toISOString(),
        close: bar.close,
        line: null,
        eps: null,
        rsi: null,
        rsiPrev: null,
        sl: null,
        tps: null,
        spike: { open: bar.open, extreme: f.extreme, move: f.move, r, x: f.x, forming, closesAt: new Date(end).toISOString(), behind: range.behind },
      });
    }
  }
  return out;
};

// #395: gold's 1-hour bar starting at `hourMs` from its recorded minutes
// (public.gold_tick_bars: Swissquote's prices, oldest first): the open the
// hour's first minute's, the high and low the minutes' extremes, the close
// the last minute's, rounded as the chart draws gold (2 decimals); null with
// no minute in the hour, or when its first minute began more than
// SPIKE_GOLD_OPEN_MS after the hour (its open is not known)
export const SPIKE_GOLD_OPEN_MS = 2 * 60_000;
export const goldHourBar = (
  minutes: ReadonlyArray<{ minute: string; open: number; high: number; low: number; close: number }>,
  hourMs: number,
): Candle | null => {
  const inHour = minutes.filter((m) => {
    const t = Date.parse(m.minute);
    return t >= hourMs && t < hourMs + 60 * 60_000 && [m.open, m.high, m.low, m.close].every((v) => Number.isFinite(v));
  });
  if (inHour.length === 0 || Date.parse(inHour[0].minute) - hourMs > SPIKE_GOLD_OPEN_MS) return null;
  const r2 = (v: number) => Number(v.toFixed(2));
  return {
    datetime: new Date(hourMs).toISOString().slice(0, 19).replace("T", " "),
    open: r2(inHour[0].open),
    high: r2(Math.max(...inHour.map((m) => m.high))),
    low: r2(Math.min(...inHour.map((m) => m.low))),
    close: r2(inHour[inHour.length - 1].close),
  };
};

// ---- when each chart is read ---------------------------------------------------------
//
// The sweep runs every minute. #171: a GMO chart is read in the minute its
// bar closes, as soon as GMO has the bar — the owner, on an email that came
// four minutes after its 4-hour close (TP1 was reached in those minutes):
// 「4分後じゃ遅いじゃないですか？一瞬で届く様にはならない？」. Measured
// (research/gmo-lag.py, docs §8.81): GMO's answers pass a CDN and can be a
// few seconds old, but an answer GMO made after the close held the closed
// bar as it finally stood. So an answer made before the close that holds
// the bar is read again, not judged on (staleForClose).
//
// The later reads stay, for a run that failed or did not get a fresh answer
// in time: the 5- and 15-minute charts a minute and three minutes after
// their close, the hourly three and five, the 4-hour and daily four and six,
// apart from each other so a run does not ask GMO for everything at once. A
// chart whose newest bar was already judged is not read again. 4-hour and
// daily bars: GMO's trading day rolls at 06:00 or 07:00 JST (quotes.ts
// jstDayKey), so where they close is not asserted: they are looked at every
// hour, the first chart read telling whether a bar closed this hour
// (hourCloseOf); when none did, the others are not read.
export const gmoIntervalsDue = (nowMs: number): string[] => {
  const m = new Date(nowMs).getUTCMinutes();
  const out: string[] = [];
  if (m % 5 === 0 || m % 5 === 1 || m % 5 === 3) out.push("5min");
  if (m % 15 === 0 || m % 15 === 1 || m % 15 === 3) out.push("15min");
  if (m === 0 || m === 3 || m === 5) out.push("1h");
  if (m === 0 || m === 4 || m === 6) out.push("4h", "1day");
  return out;
};

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

// #171: the newest time a bar of this chart can have closed at — the close a
// read now is for: the grid of its length on the day-keyed charts (5 minutes
// to an hour, on the UTC grid), some hour on the 4-hour and daily ones
export const latestCloseMs = (interval: string, nowMs: number): number => {
  const step = LIVE_STEP_MS[interval] ?? MIN_MS;
  const grid = Math.min(step, HOUR_MS);
  return Math.floor(nowMs / grid) * grid;
};

// When GMO made an answer (its `responsetime`), ms; null when it does not say
export const gmoMadeAt = (body: unknown): number | null => {
  const rt = typeof body === "object" && body !== null ? (body as { responsetime?: unknown }).responsetime : undefined;
  const t = typeof rt === "string" ? Date.parse(rt) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

// #171: whether an answer cannot be judged on for the close at `closeMs`:
// GMO made it before the close (the CDN keeps answers a few seconds) and it
// holds the bar that closed then or a later one, which it may hold short of
// its last prices. An answer holding older bars only (a trading day's file
// that ended earlier, served from the CDN for hours) is as good as ever; one
// that does not say when it was made is taken as it is, as before #171.
export const staleForClose = (body: unknown, closeMs: number, stepMs: number): boolean => {
  const made = gmoMadeAt(body);
  if (made === null || made >= closeMs) return false;
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return false;
  return data.some((b) => {
    const t = typeof b === "object" && b !== null ? Number((b as { openTime?: unknown }).openTime) : Number.NaN;
    return Number.isFinite(t) && t >= closeMs - stepMs;
  });
};
// Read again this long after a stale answer, this many times at most
export const STALE_RETRY_MS = 1_000;
export const STALE_TRIES = 8;

// #171: what a 4-hour or daily chart's newest closed bar (its open) says of
// the hour now, so its other pairs are read only when a bar closed in it:
// "closed" (it closed at this hour), "none" (it closed within the bar's
// length before this hour, so none closed now) or "unknown" (older still: a
// read cut short, or the market's weekend — the next pair is asked). #182:
// GMO's 4-hour bar stamped Sunday 20:00 UTC is kept now, so a week's first
// 4-hour close is Monday 00:00 UTC (09:00 JST), not 04:00.
export type HourClose = "closed" | "none" | "unknown";
export const hourCloseOf = (newestOpenMs: number, interval: string, nowMs: number): HourClose => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined || !Number.isFinite(newestOpenMs)) return "unknown";
  const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const close = newestOpenMs + step;
  if (close === hour) return "closed";
  return close < hour && close > hour - step ? "none" : "unknown";
};

// #171: how long a run waits before reading, from where in the minute it
// starts: the cron starts it at the minute, and a bar that closed then is
// taken as closed from a second after it (a clock a little behind would
// otherwise not count it as closed yet); a run that starts in the last two
// seconds of a minute waits for the next one's
export const FAST_START_MS = 1_000;
export const startWaitMs = (nowMs: number): number => {
  const into = ((nowMs % MIN_MS) + MIN_MS) % MIN_MS;
  if (into >= MIN_MS - 2_000) return MIN_MS - into + FAST_START_MS;
  return into < FAST_START_MS ? FAST_START_MS - into : 0;
};

// Twelve Data's bars close on the grid of their length, shifted by where
// they start: the hourly and daily on the UTC grid, the 4-hour ones at
// 01:00, 05:00 ... UTC (every pair's, gold's too, read 2026-09-28). The
// newest close of this timeframe, if it fell inside its freshness window.
export const twelveCloseDue = (interval: string, nowMs: number, phaseMs = 0): number | null => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined) return null;
  const close = Math.floor((nowMs - phaseMs) / step) * step + phaseMs;
  const age = nowMs - close;
  // a minute after the close at the earliest (Twelve Data has the bar)
  return age >= 60_000 && age <= freshFor(interval) ? close : null;
};

// #212: whether a Twelve Data chart is looked at in this minute. Where its
// bars' phase is known, by its own close (twelveCloseDue). Where it is not —
// and a sweep mostly runs on a fresh instance (docs §8.81, §8.105), so mostly
// it is not — a timeframe shorter than an hour by its own UTC grid (Twelve
// Data's 15-minute bars sit on the quarter hours), an hour and longer in the
// first half hour of every hour, when its stored bars tell. (Before #212 only
// the latter: every Twelve Data chart was an hour or longer, and gold's 15
// minutes would have been looked at only in :01-:29, its :30 close lost.)
export const twelveChartDue = (interval: string, nowMs: number, phaseMs: number | undefined): boolean => {
  if (phaseMs !== undefined) return twelveCloseDue(interval, nowMs, phaseMs) !== null;
  const step = LIVE_STEP_MS[interval];
  if (step !== undefined && step < 3_600_000) return twelveCloseDue(interval, nowMs, 0) !== null;
  return twelveCloseDue("1h", nowMs) !== null;
};

// Where a timeframe's bars start within its length, from the bars
// themselves (the newest's open), so a shift Twelve Data makes (daylight
// saving, say) is followed rather than assumed
export const twelvePhase = (bars: ReadonlyArray<{ datetime: string }>, interval: string): number | null => {
  const step = LIVE_STEP_MS[interval];
  const last = bars[bars.length - 1];
  if (step === undefined || !last) return null;
  const t = barOpenMs(last.datetime);
  return Number.isFinite(t) ? ((t % step) + step) % step : null;
};

// Whether a chart's bars may be read from Twelve Data again for a close,
// by when they were last read (the stored row's time, the chart's reads
// too, so every instance keeps to it): once a minute after the close, and
// once more three minutes later if the bar was not there yet; never a third
// time. 2026-09-28: the 4-hour charts, looked for at the wrong hour, were
// read every minute for half an hour.
export const TWELVE_RETRY_MS = 3 * 60_000;
export const TWELVE_RETRY_WINDOW_MS = 4 * 60_000;
export const twelveReadDue = (closeMs: number, fetchedAtMs: number, nowMs: number): boolean =>
  !Number.isFinite(fetchedAtMs) ||
  fetchedAtMs < closeMs + 60_000 ||
  (fetchedAtMs < closeMs + TWELVE_RETRY_WINDOW_MS && nowMs - fetchedAtMs >= TWELVE_RETRY_MS);

// Twelve Data reads a sweep may make: the key allows eight a minute and the
// live chart makes its own
export const TWELVE_READS_PER_RUN = 3;
// The day's count the alerts may read up to: above the chart's caps (720 at
// most, live-chart logic.ts TWELVE_CAPS), so once the chart has spent its
// share the alerts still read; 20 are left under the key's 800
export const ALERT_TWELVE_CAP = 780;

// ---- GMO's files, kept -----------------------------------------------------------------
//
// Q-Trend needs the 600 closed bars the chart holds: on the hourly chart that
// is some 35 days of GMO's daily files, both sides, 70 requests a pair. A
// file of a day (or year) that has ended does not change, so each is read
// from GMO once and kept (public.gmo_kline_files); a sweep asks GMO only for
// the files still being written. A day's file (06:00 or 07:00 JST to the
// next) has ended by 09:00 JST the next day; a year's by 2 January UTC.

export interface KlineFile {
  symbol: string;
  priceType: string;
  interval: string;
  date: string;
}

export const klineFileOf = (url: string): KlineFile | null => {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith("/klines")) return null;
    const [symbol, priceType, interval, date] = ["symbol", "priceType", "interval", "date"].map((k) => u.searchParams.get(k));
    if (!symbol || !priceType || !interval || !date || !/^\d{4}(\d{4})?$/.test(date)) return null;
    return { symbol, priceType, interval, date };
  } catch {
    return null;
  }
};

export const klineFileEnded = (date: string, nowMs: number): boolean => {
  if (/^\d{8}$/.test(date)) {
    const next = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)) + 1);
    // the next day's 00:00 UTC is 09:00 JST
    return nowMs >= next;
  }
  if (/^\d{4}$/.test(date)) return nowMs >= Date.UTC(Number(date) + 1, 0, 2);
  return false;
};

export const klineFileKey = (f: KlineFile): string => `${f.symbol}|${f.priceType}|${f.interval}|${f.date}`;

// How many days of a day-keyed chart's kept files one read from the table
// brings: the span analyze/price-source.ts fetchRecentQuotes walks for
// `bars` bars (open days, padded for weekends and two more), and a day more
export const klinePreloadDays = (interval: string, bars: number): number => {
  const step = LIVE_STEP_MS[interval];
  if (step === undefined) return 0;
  const perDay = Math.max(1, Math.floor(86_400_000 / step));
  const openDays = Math.ceil(bars / perDay);
  return Math.ceil((openDays * 7) / 5) + 3;
};

// Only a sound answer is kept: GMO's status 0 with its data (a day with no
// bars, a weekend's, is an empty list and is kept as one)
export const keepableKlines = (body: unknown): boolean =>
  typeof body === "object" && body !== null && (body as { status?: unknown }).status === 0 &&
  Array.isArray((body as { data?: unknown }).data);

// ---- the email --------------------------------------------------------------------------
//
// What fired and on which bar, the numbers that made it fire, the stop and
// targets (ULTRA's for the chart's pair, ultraParamsFor: since #192 the stop
// 13 and the targets 4, 10 and 16, dollars on gold and pips on a pair, from a
// second F-INVEST video's chart lines rather than its settings dialog; #156:
// Q-Trend's the same numbers, the owner's choice), where the prices come
// from, and — as plainly as the other alerts — what these levels did on the
// email's own timeframe.

// #157: what the emails' own levels did (research/tf-winrate.ts, docs §8.69):
// GMO's FX pairs, 2024-01-01 to 2026-09-29, each signal the sweep would mail
// entered at its bar's close on the side it fills on (spread paid) and
// followed on 5-minute bid/ask. `win`: the share of those settled that
// reached TP1 before the stop, %; `pips`: a trade's mean when all of it is
// closed at TP1 or the stop (or after five days, where neither was
// reached). Gold: GOLD_MEASURED below; the pairs read from Twelve Data were
// not measured.
// #166: measured again at the currency pairs' stop of 30 pips (tf-winrate
// with SL=30, GitHub Actions run 36587276263, docs §8.78); #157's were at 10.
// #173: measured again at their targets since, TP1 20 pips (TP2 40, TP3 60)
// and the stop 30 (tf-winrate with TP1=20 and SL=30, 2024-01-01 to
// 2026-09-30, GitHub Actions run 36730814776, docs §8.82); #166's were at TP1 5.
// #182: 4h measured again on the bars the sweep reads since, GMO's 4-hour bar
// stamped Sunday 20:00 UTC kept (tf-winrate with WEEKEND=inside, the same end,
// 2026-09-30T14:40:11Z, GitHub Actions run 37134322956, docs §8.93; the other
// timeframes came out the same to the trade). Before: Q-Trend 58.3 / -1.47,
// ULTRA 60.1 / -0.54 (run 37133903888, WEEKEND=stamp, repeating 36730814776).
// #192: measured again at the levels since, the stop 13 and TP1 4 (TP2 10,
// TP3 16): tf-winrate with SL=13, TP1=4, TP2=10, TP3=16, the same end and
// WEEKEND=inside (GitHub Actions run 37191488441, docs §8.98); the same
// program at #173's levels (run 37191489765) came out as the numbers then,
// every one. Those were: Q-Trend 58.0 / -2.03, 58.4 / -1.8, 59.2 / -1.33,
// 59.1 / -1.17, 55.1 / -6.92; ULTRA 58.2 / -1.81, 58.0 / -1.79, 58.4 /
// -1.87, 60.8 / -0.37, 50.0 / -9.5 (5min to 1day).
export const INDICATOR_MEASURED: Record<ChartRule, Record<string, { win: number; pips: number }>> = {
  qtrend: {
    "5min": { win: 70.3, pips: -2.03 },
    "15min": { win: 70.5, pips: -1.9 },
    "1h": { win: 72.6, pips: -1.46 },
    "4h": { win: 73.6, pips: -1.07 },
    "1day": { win: 50.8, pips: -8.88 },
  },
  ultra: {
    "5min": { win: 71.9, pips: -1.62 },
    "15min": { win: 72.0, pips: -1.51 },
    "1h": { win: 72.8, pips: -1.6 },
    "4h": { win: 74.5, pips: -0.94 },
    "1day": { win: 53.0, pips: -8.79 },
  },
};
// #168: gold's, at its levels then (TP1 $30, the stop $10): research/gold.ts
// on Dukascopy's gold, bid and ask, cut into bars as the app holds Twelve
// Data's (docs §8.79, §8.80; the "Study gold" run 36678229867), 2024-01-01
// to 2026-09-28, each signal the sweep would mail entered at its bar's close
// on the side it fills on and followed on 5-minute bid/ask, as the pairs'
// above. `usd`: dollars a trade.
// #192: measured again at the levels since, TP1 $4 and the stop $13 (the
// same program, prices and period: the "Study gold" run 37191490950, its job
// "4h tw, daily tw, fill twelve", the lines "MAIL #192"; its lines "MAIL
// #168" came out as #168's to the digit, docs §8.98). #168's: Q-Trend 25.5 /
// -0.09, 25.6 / -0.01, 25.6 / -0.03, 27.2 / +0.59, 26.5 / +0.21; ULTRA 22.8 /
// -1.14, 21.4 / -1.68, 23.9 / -0.74, 20.8 / -1.97, 15.4 / -4.45 (5min to 1day).
export const GOLD_MEASURED: Record<ChartRule, Record<string, { win: number; usd: number }>> = {
  qtrend: {
    "5min": { win: 74.3, usd: -0.66 },
    "15min": { win: 74.3, usd: -0.65 },
    "1h": { win: 75.3, usd: -0.5 },
    "4h": { win: 73.9, usd: -0.68 },
    "1day": { win: 78.0, usd: -0.19 },
  },
  ultra: {
    "5min": { win: 73.0, usd: -0.87 },
    "15min": { win: 73.6, usd: -0.78 },
    "1h": { win: 72.1, usd: -1.05 },
    "4h": { win: 72.5, usd: -1.02 },
    "1day": { win: 42.3, usd: -6.41 },
  },
};

// the sentence saying so, on this email's timeframe. The share of TP1
// before the stop that breaks even, spread aside: the stop over the stop and
// TP1 (#192: 13 against 4 on gold and the pairs both, 76%; before it 30 pips
// against 20, 60%, and gold's $10 against $30, 25%).
export const breakEvenPct = (gold: boolean): number => {
  const o = ultraParamsFor(gold);
  return Math.round((100 * o.sl) / (o.sl + o.tp1));
};
// #168: gold's, measured on Dukascopy's gold (GOLD_MEASURED)
const goldMeasuredLine = (s: IndicatorSignal, lang: Lang): string => {
  const g = s.rule === "macdx" || s.rule === "sweepx" || s.rule === "amdpo3" || s.rule === "emarm" || s.rule === "stockmacd" || s.rule === "spike" ? undefined : GOLD_MEASURED[s.rule][s.interval];
  const even = breakEvenPct(true);
  if (lang === "en") {
    if (!g) return "This timeframe has not been measured.";
    return `Measured on past ${tfLabel("en", s.interval)} bars (January 2024–September 2026, Dukascopy's gold prices cut into bars as Twelve Data's, spread paid), these levels reached TP1 before the stop ${g.win.toFixed(1)}% of the time (breaking even needs more than ${even}%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) ${g.usd < 0 ? "lost" : "made"} about $${Math.abs(g.usd).toFixed(2)} a trade on average.`;
  }
  if (!g) return "この時間足は測っていません。";
  return `過去の${tfLabel("ja", s.interval)}（2024年1月〜2026年9月、Dukascopy の金の値を Twelve Data と同じ区切りの足にしたもの、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは ${g.win.toFixed(1)}%（損益ゼロには${even}%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約${Math.abs(g.usd).toFixed(2)}ドルの${g.usd < 0 ? "負け" : "勝ち"}でした。`;
};
// #291: the video's way has not been measured (docs §8.112); #324: nor has
// the 1-hour MACD rule (the owner: 「今は測らない」, 2026-10-12; docs §8.114);
// #385: nor has AMD Po3 (its table counts the chart's own, §8.128).
// (The 5-minute MACD rule's measured figures, §8.109, went with its emails:
// they are another rule's.)
// (#397: the MACD email, a ride from v39, has its own measured paragraph:
// rideMeasuredLine, docs §8.149; this line is no longer its)
const notMeasuredLine = (lang: Lang): string =>
  lang === "en"
    ? "This rule's win rate and its profit or loss a trade have not been measured."
    : "この決まりの勝率と1回あたりの損益は、まだ測っていません。";
// #387 (docs §8.130): the EMA 20 / 200 way, measured on the five pairs'
// 15-minute bars (research/emarm.ts, GMO's mid as the chart draws it, the
// 52 weeks to 2026-10-29; the Python written apart agreed on every row: the
// "Research emarm" run 41009164135): 22 entries; with the stop and target 1
// 11 won and 11 lost, +18.22 pips a win and −16.74 a loss on average, +0.74
// a trade, spread not paid; held with no stop to target 1 (CLAUDE.md: the
// profit or loss a trade, how far it went against, how long it was held and
// the ones still open, all with it), 20 reached it (+21.43 pips on average,
// the bars to it 35 in the middle and 1,894 at most) and 2 were still open at
// −786.1 and −607.2 pips (held 18,594 and 11,741 bars), −964.7 pips in all
// and −43.85 a trade with those two at the last close; the price went
// against the entry 7.7 pips in the middle and 861.2 at most. Gold not measured
export const EMARM_MEASURED = {
  entries: 22,
  won: 11,
  lost: 11,
  avgWin: 18.2,
  avgLoss: -16.7,
  perTrade: 0.7,
  ownerReached: 20,
  ownerAvgWin: 21.4,
  ownerBarsMedian: 35,
  ownerBarsMax: 1894,
  ownerOpen: [-786.1, -607.2],
  ownerOpenBars: [18594, 11741],
  ownerTotal: -964.7,
  ownerPerTrade: -43.9,
  maeMedian: 7.7,
  maeMax: 861.2,
} as const;
const emarmMeasuredLine = (s: IndicatorSignal, lang: Lang): string => {
  const m = EMARM_MEASURED;
  const pct = ((100 * m.won) / (m.won + m.lost)).toFixed(1);
  // the minus as the chart's (U+2212)
  const sg = (v: number) => (v < 0 ? `\u2212${Math.abs(v)}` : `+${v}`);
  const open = m.ownerOpen.map(sg);
  const n = (v: number) => v.toLocaleString("en-US");
  if (lang === "en") {
    return `Measured on the 15-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD over the 52 weeks to 2026-10-29 (GMO's mid, as the chart draws them): ${m.entries} entries; with this stop and target 1, ${m.won} won and ${m.lost} lost (${pct}%), ${sg(m.avgWin)} pips a win and ${sg(m.avgLoss)} pips a loss on average, ${sg(m.perTrade)} pips a trade (spread not paid; the video's 60% cannot be confirmed on so few). Held with no stop until target 1, ${m.ownerReached} of the ${m.entries} reached it (${sg(m.ownerAvgWin)} pips on average; ${m.ownerBarsMedian} bars to it in the middle, ${n(m.ownerBarsMax)} at most) and ${open.length} have not yet (open at ${open.join(" and ")} pips, held ${m.ownerOpenBars.map(n).join(" and ")} bars); counting those at the last close, ${sg(m.ownerTotal)} pips in all, ${sg(m.ownerPerTrade)} pips a trade. The price went against the entry ${m.maeMedian} pips in the middle and ${m.maeMax} pips at most.` +
      (isGold(s.pair) ? " Gold itself has not been measured." : "");
  }
  return `ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの15分足の過去52週（2026年10月29日まで、GMO の中値、チャートと同じ足）で測ると、エントリーは${m.entries}回、この損切りと利確1では${m.won}勝${m.lost}敗（勝率${pct}%）、平均で勝ち ${sg(m.avgWin)} pips・負け ${sg(m.avgLoss)} pips、1回あたり ${sg(m.perTrade)} pips でした（スプレッドは引いていません。回数が少なく、動画の言う勝率60%は確かめられません）。損切りなしで利確1まで持つと、${m.entries}回のうち${m.ownerReached}回が届き（平均 ${sg(m.ownerAvgWin)} pips、届くまでの足は中ほど${m.ownerBarsMedian}本・最長${n(m.ownerBarsMax)}本）、${open.length}回はまだ届いていません（含み損 ${open.join(" pips と ")} pips、${m.ownerOpenBars.map(n).join("本と")}本持っている）。この2回を最後の終値で数えると、合計 ${sg(m.ownerTotal)} pips、1回あたり ${sg(m.ownerPerTrade)} pips です。持っている間に逆へ動いた幅は、中ほど${m.maeMedian} pips、最大${m.maeMax} pips でした。` +
    (isGold(s.pair) ? "金そのものは測っていません。" : "");
};
const measuredLine = (s: IndicatorSignal, lang: Lang): string => {
  if (s.rule === "emarm") return emarmMeasuredLine(s, lang);
  if (s.rule === "macdx" || s.rule === "sweepx" || s.rule === "amdpo3" || s.rule === "stockmacd" || s.rule === "spike") return notMeasuredLine(lang);
  if (isGold(s.pair)) return goldMeasuredLine(s, lang);
  const m = INDICATOR_MEASURED[s.rule][s.interval];
  const unmeasured = !isGmoChartPair(s.pair);
  const even = breakEvenPct(false);
  if (lang === "en") {
    if (!m) return "This timeframe has not been measured.";
    return `Measured on past ${tfLabel("en", s.interval)} bars (January 2024–September 2026, GMO's FX pairs, spread paid), these levels reached TP1 before the stop ${m.win.toFixed(1)}% of the time (breaking even needs more than ${even}%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) ${m.pips < 0 ? "lost" : "made"} about ${Math.abs(m.pips).toFixed(2)} pips a trade on average.` +
      (unmeasured ? ` ${s.pair} itself was not measured; these are GMO's FX pairs' figures.` : "");
  }
  if (!m) return "この時間足は測っていません。";
  return `過去の${tfLabel("ja", s.interval)}（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは ${m.win.toFixed(1)}%（損益ゼロには${even}%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約${Math.abs(m.pips).toFixed(2)} pips の${m.pips < 0 ? "負け" : "勝ち"}でした。` +
    (unmeasured ? `${pairJa(s.pair)}そのものは測っていません（GMO の FX の値です）。` : "");
};

const decimalsOf = (pair: string) => (isGold(pair) ? 2 : pair.toUpperCase().includes("JPY") ? 3 : 5);

// #353 (docs §8.119): how the MACD email writes its numbers (the blue line,
// an edge of the newest 120 bars' MACD pane, and the marks on the way to it),
// the minus as the chart's (U+2212), not toFixed's hyphen. In the price's
// decimals, as the chart's MACD pane shows them, or more where the pane's
// edge the mail is about (`end`) would come out with fewer than two
// significant digits in those (a top of 0.0000125 on EUR/USD is written
// 0.000013, not 0.00001); the numbers of a mail in the same decimals, at most
// 20. #397: the edge is the pane's on the ride's side, the top for a BUY and
// the bottom for a SELL (the 95% email took the bottom for a BUY)
const macdNumbers = (pair: string, end: number | null): ((v: number | null) => string) => {
  const d = decimalsOf(pair);
  const md = end !== null && Number.isFinite(end) && end !== 0 ? Math.min(20, Math.max(d, 1 - Math.floor(Math.log10(Math.abs(end))))) : d;
  return (v: number | null) => (v !== null && Number.isFinite(v) ? v.toFixed(md).replace(/^-/, "−") : "—");
};

// #397 (docs §8.149): the ride as measured, on the five pairs' bars only
// (research/macd90m-spec.md way C: in at the 1-hour close, out at the close
// of the first 1-minute bar that touches 96%, held until then; GMO's bars,
// the entries closing 2024-01-01 to 2026-11-10, the spread paid; the Python
// written apart agreed on every row, run 43134981457). `entries`: the trades;
// `reached` of them got to 96%, `plus` at a profit, `minus` at a loss and
// `zero` at none; `perTrade` their mean and `worst` the lowest, pips; `maeMax`
// the largest loss on the way, pips; `longestDays` the longest held
// (40,141 minutes); `open` not reached by the end, at `openPips`; `notices`
// the bars already at 96% at their close (no trade) and `skipped` the entries
// while a ride of the side was held; half of those reached were reached
// within a minute of the entry (the median). Gold and the shares are not
// measured, nor the function's own reading (GMO's 1-hour bar each minute
// where the study read 1-minute bars)
export const RIDE_MEASURED = {
  from: "2024-01",
  to: "2026-11-10",
  entries: 801,
  reached: 800,
  plus: 360,
  minus: 429,
  zero: 11,
  perTrade: 0.43,
  worst: -323.6,
  maeMax: 558.8,
  longestDays: 28,
  open: 1,
  openPips: -6.1,
  notices: 750,
  skipped: 30,
  medianMinutes: 1,
} as const;
// the measured paragraph of email 1 (gold's says first that gold is not measured)
const rideMeasuredLine = (pair: string, lang: Lang): string => {
  const m = RIDE_MEASURED;
  // the minus as the chart's (U+2212)
  const sg = (v: number) => (v < 0 ? `\u2212${Math.abs(v)}` : `+${v}`);
  // "2024-01" as 2024\u5e741\u6708, "2026-11-10" as 2026\u5e7411\u670810\u65e5
  const dayJa = (ymd: string) => {
    const [y, mo, day] = ymd.split("-").map(Number);
    return `${y}\u5e74${mo}\u6708${day === undefined ? "" : `${day}\u65e5`}`;
  };
  const gold = isGold(pair);
  if (lang === "en") {
    return (gold ? "This rule has not been measured on gold; the numbers that follow are the five pairs'. " : "") +
      `Measured on the 1-hour bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD (${m.from} to ${m.to}, after the spread; docs §8.149): ${m.entries} entries, of which ${m.reached} reached ${RIDE_OUT_PCT}% — ${m.plus} of them at a profit, ${m.minus} at a loss and ${m.zero} at zero — ${sg(m.perTrade)} pips an entry on average, the worst ${sg(m.worst)} pips, the largest loss on the way ${m.maeMax} pips, the longest held about ${m.longestDays} days, and ${m.open} not reached yet (${sg(m.openPips)} pips). ${m.notices} more bars were a notice only (already at ${RIDE_OUT_PCT}%), and ${m.skipped} entries were skipped while a ride of the same side was held. Half of those reached were reached within ${m.medianMinutes} minute of the entry. There is no stop, so the share that reaches ${RIDE_OUT_PCT}% is high by construction. On the five pairs the function reads GMO's 1-hour bar each minute where the study read 1-minute bars; that difference has not been measured.`;
  }
  return (gold ? "金では、この決まりを測っていません。次の数字は5ペアのものです。" : "") +
    `ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの1時間足で測ると（${dayJa(m.from)}〜${dayJa(m.to)}、スプレッドを引いたあと。docs §8.149）、入る合図は${m.entries}回で、${m.reached}回が${RIDE_OUT_PCT}%に届きました。届いた時の損益は、プラスが${m.plus}回、マイナスが${m.minus}回、ちょうど0が${m.zero}回で、1回あたり平均 ${sg(m.perTrade)} pips、最悪 ${sg(m.worst)} pips でした。持っている間の含み損は最大 ${m.maeMax} pips、一番長く持ったのは約${m.longestDays}日で、${m.open}回はまだ届いていません（含み損 ${sg(m.openPips)} pips）。このほかに、知らせだけの足（確定でもう${RIDE_OUT_PCT}%）が${m.notices}回、同じ向きを持っている間で見送った入りが${m.skipped}回ありました。届いた取引の半分は、入ってから${m.medianMinutes}分以内に届いています。損切りをしないので、届く割合は作りの上で高く出ます。5ペアのメールは GMO の1時間足を毎分読んで${RIDE_OUT_PCT}%を見ますが、測った時は1分足で見ました。この違いは測っていません。`;
};

// #397: how long a ride was held, as email 2 says it (logic.ts rideHeldText: the pairs', gold's and the shares' mails
// say it the same way; kept there so that stocks.ts takes no value from this file, which reads stocks.ts)
export { rideHeldText };

// #397 (docs §8.150; research/macdride-spec.md section 8): the three mails of
// the MACD ride on the five pairs and gold. Email 1: the bar, that the blue
// line came into the 90% band of the pane's top (bottom) with the bar before
// outside it — an entry with the flow, a BUY (SELL) — its numbers, the price
// paid, what follows and what was measured. The notice: the line came in
// already at 96%, no entry. Email 2: the first email, that the line reached
// 96% (or was found to have, late), the price now, the profit or loss since
// the first email and how long it was held; it reports the line, not a
// profit: of the 800 measured trades that reached 96%, 429 were at a loss.
// The pane's edge is the ride's side's: the top for a BUY, the bottom for a
// SELL.
const renderRideMail = (s: IndicatorSignal, lang: Lang): Mail => {
  const f = s.ride ?? null;
  const mail: RideMail = f?.mail ?? "in";
  const gold = isGold(s.pair);
  const d = decimalsOf(s.pair);
  const px = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
  const buy = s.side === "BUY";
  const top = (f?.zside ?? rideZoneSideOf(s.side)) === "top";
  const edge = f ? (top ? f.top : f.bottom) : null;
  const mx = macdNumbers(s.pair, edge);
  const mark = (share: number) => (edge === null ? null : share * edge);
  const tf = tfLabel(lang, s.interval);
  const entryClose = f ? Date.parse(f.entryClosedAt) : Date.parse(s.closedAt);
  const seen = f?.seenAt ? Date.parse(f.seenAt) : Date.parse(s.closedAt);
  const late = f?.late === true;
  const reachedBar = f?.reachedBar ? Date.parse(f.reachedBar) : Number.NaN;
  const step = LIVE_STEP_MS[s.interval] ?? HOUR_MS;
  const pnl = f && f.seenPrice !== null && f.seenPrice !== undefined ? ridePnl(s.pair, s.side, f.entryPrice, f.seenPrice) : null;
  // the result with its sign (the minus as the chart's, U+2212; ± at exactly zero): a pair's in pips to one
  // decimal, gold's in dollars
  const sign = pnl === null ? "" : pnl.value > 0 ? "+" : pnl.value < 0 ? "\u2212" : "±";
  const amount = pnl === null ? "" : Math.abs(pnl.value).toFixed(pnl.unit === "usd" ? 2 : 1);
  if (lang === "en") {
    const side = buy ? "BUY" : "SELL";
    const end = top ? "top" : "bottom";
    const source = gold
      ? "The bars are Twelve Data's (GMO Coin does not carry XAU/USD), as the app's chart draws them."
      : "The bars are the mid of GMO Coin's public bid and ask, as the app's chart draws them.";
    const stop = "To stop these emails, open Settings → Email alerts in the app and untick the chart under MACD ride.\nThis is reference information, not investment advice. Every trading decision is your own.";
    if (mail === "out") {
      const paid = gold ? "that bar's close" : buy ? "ask" : "bid";
      const leave = gold
        ? late ? "the newest closed Twelve Data bar's close" : "Swissquote's price"
        : `${buy ? "bid" : "ask"}${late ? " at the newest closed bar's close" : ""}`;
      const result = pnl === null ? "—" : pnl.unit === "usd" ? `${sign}$${amount}` : `${sign}${amount} pips`;
      return assemble(`[Sextant] ${s.pair} ${tf} reached ${RIDE_OUT_PCT}% (MACD ride, email 2, the ${side})`, [
        `On ${s.pair}, ${tf} chart, the MACD line (blue) reached ${RIDE_OUT_PCT}% of the way to the ${end} of the MACD pane (MACD ride, email 2, for the ${side}).`,
        [
          `Email 1: a ${side} at the bar closed ${clock(entryClose, 0)} UTC (${clock(entryClose, 9)} JST), ${paid} ${px(f?.entryPrice)}`,
          late && Number.isFinite(reachedBar)
            ? `It had reached ${RIDE_OUT_PCT}% during the bar ${clock(reachedBar, 0)}–${clock(reachedBar + step, 0).slice(11)} UTC (${clock(reachedBar, 9)}–${clock(reachedBar + step, 9).slice(11)} JST). It could not be read then and was found now (${clock(seen, 0)} UTC, ${clock(seen, 9)} JST)`
            : `Seen at ${clock(seen, 0)} UTC (${clock(seen, 9)} JST)`,
          `Price now: ${px(f?.seenPrice)} (${leave})`,
          `Profit or loss since email 1: ${result}`,
          `Time since email 1: ${rideHeldText(seen - entryClose, "en")}`,
        ].join("\n"),
        `This email reports that the line reached ${RIDE_OUT_PCT}%. It does not say the trade is at a profit: the result can be a loss.` +
          (gold
            ? ` Gold's result holds no spread${late ? "; both prices are closes of Twelve Data's bars." : ", and its two prices come from two feeds: email 1's is the close of Twelve Data's bar, the price now is Swissquote's."}`
            : ""),
        `${gold
          ? late
            ? `The bars are Twelve Data's (GMO Coin does not carry XAU/USD); the reach was read on the closed 1-hour bar's ${buy ? "high" : "low"}.`
            : `The bars are Twelve Data's (GMO Coin does not carry XAU/USD); the reach is looked for every minute on this hour's ${buy ? "highest" : "lowest"} price so far in Swissquote's prices, recorded every minute.`
          : late
          ? `The prices are GMO Coin's public bid and ask; the reach was read on the closed 1-hour bar's ${buy ? "high" : "low"} (the mid of bid and ask, as the app's chart draws it).`
          : `The prices are GMO Coin's public bid and ask; the reach is looked for every minute on the 1-hour bar's ${buy ? "high" : "low"} so far (the mid of bid and ask, as the app's chart draws it).`} Check the latest state in the app:\n${APP_URL}`,
        stop,
      ]);
    }
    if (mail === "at") {
      return assemble(`[Sextant] ${s.pair} ${tf} notice: already at ${RIDE_OUT_PCT}% (MACD ride, no entry signal)`, [
        `On ${s.pair}, ${tf} chart, the MACD line (blue) came into the ${RIDE_IN_PCT}% band of the MACD pane's ${end}, and at the bar's close it was already at ${RIDE_OUT_PCT}% or more. No entry signal (it would have been a ${side}) is sent: this is a notice only.`,
        [
          `Bar: closed ${clock(entryClose, 0)} UTC (${clock(entryClose, 9)} JST)`,
          `  MACD = ${mx(f?.m ?? null)}; ${end} of the pane = ${mx(edge)}; ${RIDE_OUT_PCT}% of it = ${mx(mark(RIDE_OUT_SHARE))}`,
        ].join("\n"),
        `This is Sextant's own rule (its numbers are the app owner's), not a published indicator (docs §8.150). The next entry signal for this chart and side is judged at the bar where the line, having left the ${RIDE_IN_PCT}% band, comes back into it.`,
        `${source} Check the latest state in the app:\n${APP_URL}`,
        stop,
      ]);
    }
    return assemble(`[Sextant] ${s.pair} ${tf} ${side} entry signal (MACD ride, email 1)`, [
      `A MACD ride ${side} entry signal fired on ${s.pair}, ${tf} chart (email 1).`,
      [
        `Bar: closed ${clock(entryClose, 0)} UTC (${clock(entryClose, 9)} JST)`,
        `MACD(12, 26, 9): the MACD line (blue) came into the ${end} band of the MACD pane of the newest ${ZONE_BARS} bars: ${RIDE_IN_PCT}% or more of the way from the zero line to the pane's ${end} (the ${top ? "highest" : "lowest"} of the MACD line, the signal line and the histogram). The bar before was outside it, so this is an entry with the flow: a ${side}`,
        `  MACD = ${mx(f?.m ?? null)}; ${end} of the pane = ${mx(edge)}; ${RIDE_IN_PCT}% of it = ${mx(mark(RIDE_IN_SHARE))}; ${RIDE_OUT_PCT}% of it = ${mx(mark(RIDE_OUT_SHARE))}`,
        gold ? `This bar's close: ${px(f?.entryPrice)}` : `${buy ? "Ask" : "Bid"} at this bar's close (the price paid): ${px(f?.entryPrice)}`,
      ].join("\n"),
      `This is Sextant's own rule (its numbers are the app owner's), not a published indicator (docs §8.150). Email 2 is sent when the blue line reaches ${RIDE_OUT_PCT}% of the same edge (the pane's ${end}). There is no stop and no target. Nothing is sent if the line leaves the ${RIDE_IN_PCT}% band, and no new email 1 for this chart and side (${side}) is sent until email 2 has been. The pane's edges are taken without the margin the chart adds as it draws them.`,
      rideMeasuredLine(s.pair, "en"),
      `${source}${gold ? " Email 2 is looked for on Swissquote's prices, recorded every minute (another feed than the bars')." : ""} Check the latest state in the app before you place an order:\n${APP_URL}`,
      stop,
    ]);
  }
  const sideJ = `${buy ? "買い" : "売り"}（${s.side}）`;
  const end = top ? "上" : "下";
  const source = gold
    ? `足は Twelve Data のもの（${pairJa(s.pair)}は GMOコインにないため）で、アプリのチャートと同じです。`
    : "価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ足で判定しています。";
  const stop = "この通知を止めるには、アプリの「設定」→「メール通知」の「MACD の流れ」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。";
  if (mail === "out") {
    const paid = gold ? "その足の終値" : buy ? "買値" : "売値";
    const leave = gold
      ? late ? "Twelve Data の最新の確定足の終値" : "Swissquote の値段"
      : `${late ? "最新の確定足の終値の" : ""}${buy ? "売値" : "買値"}`;
    const result = pnl === null ? "—" : pnl.unit === "usd" ? `${sign}${amount}ドル` : `${sign}${amount} pips`;
    return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${RIDE_OUT_PCT}%に届きました（MACD の流れ・2通目、${buy ? "買い" : "売り"}の分）`, [
      `${pairJa(s.pair)}の${tf}で、MACD の青い線が、枠の${end}の端の${RIDE_OUT_PCT}%に届きました（MACD の流れの2通目。${sideJ}の分）。`,
      [
        `1通目: ${clock(entryClose, 9)}（日本時間）に確定した足で${sideJ}。${paid} ${px(f?.entryPrice)}`,
        late && Number.isFinite(reachedBar)
          ? `${clock(reachedBar, 9)}〜${clock(reachedBar + step, 9).slice(11)}（日本時間）の足の間に届いていました。その時は読めず、今見つけました（${clock(seen, 9)}、日本時間）`
          : `届いたのを見た時刻: ${clock(seen, 9)}（日本時間）`,
        `今の値段: ${px(f?.seenPrice)}（${leave}）`,
        `1通目からの損益: ${result}`,
        `1通目からの時間: ${rideHeldText(seen - entryClose, "ja")}`,
      ].join("\n"),
      `このメールは、青い線が${RIDE_OUT_PCT}%に届いたことの知らせです。損益はプラスとは限りません。` +
        (gold
          ? `金の損益は、スプレッドを含みません。${late ? "どちらの値段も Twelve Data の足の終値です。" : "1通目の値段は Twelve Data の足の終値、今の値段は Swissquote の値段で、配信が別です。"}`
          : ""),
      `${gold
        ? late
          ? `足は Twelve Data のもの（${pairJa(s.pair)}は GMOコインにないため）です。${RIDE_OUT_PCT}%に届いたかは、確定した1時間足の${buy ? "高値" : "安値"}で見ました。`
          : `足は Twelve Data のもの（${pairJa(s.pair)}は GMOコインにないため）です。${RIDE_OUT_PCT}%に届いたかは、Swissquote の値段を毎分記録したもの（この1時間の${buy ? "高値" : "安値"}）で、毎分見ています。`
        : late
        ? `値段は GMOコインの公開レート（買値・売値）です。${RIDE_OUT_PCT}%に届いたかは、確定した1時間足の${buy ? "高値" : "安値"}（買値と売値の中間。アプリのチャートと同じ丸め方）で見ました。`
        : `値段は GMOコインの公開レート（買値・売値）です。${RIDE_OUT_PCT}%に届いたかは、1時間足のその時までの${buy ? "高値" : "安値"}（買値と売値の中間。アプリのチャートと同じ丸め方）で、毎分見ています。`}アプリで最新の状態を確認してください。\n${APP_URL}`,
      stop,
    ]);
  }
  if (mail === "at") {
    return assemble(`【Sextant】${pairJa(s.pair)} ${tf} 知らせ: もう${RIDE_OUT_PCT}%です（MACD の流れ・入る合図なし）`, [
      `${pairJa(s.pair)}の${tf}で、MACD の青い線が、枠の${end}の端の${RIDE_IN_PCT}%の帯に入りましたが、足が確定した時にはもう${RIDE_OUT_PCT}%以上でした。入る合図（${sideJ}）は送りません。知らせだけです。`,
      [
        `判定した足: ${clock(entryClose, 9)}（日本時間）に確定した足`,
        `  MACD = ${mx(f?.m ?? null)}、枠の${end}の端 = ${mx(edge)}（その${RIDE_OUT_PCT}% = ${mx(mark(RIDE_OUT_SHARE))}）`,
      ].join("\n"),
      `この決まりは Sextant 独自のもの（数字はアプリのオーナーが決めたもの）で、公開されているインジケーターではありません（docs §8.150）。このチャートの同じ向きの次の入る合図は、青い線がいったん${RIDE_IN_PCT}%の帯から出て、入り直した足で判定します。`,
      `${source}アプリで最新の状態を確認してください。\n${APP_URL}`,
      stop,
    ]);
  }
  return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${sideJ}で入る合図（MACD の流れ・1通目）`, [
    `${pairJa(s.pair)}の${tf}で、MACD の流れの${sideJ}で入る合図が出ました（1通目）。`,
    [
      `判定した足: ${clock(entryClose, 9)}（日本時間）に確定した足`,
      `MACD(12・26・9): 青い線（MACD）が、新しい${ZONE_BARS}本の MACD の枠の${end}の端（青い線・オレンジの線・棒の${top ? "一番高い" : "一番低い"}所）の${RIDE_IN_PCT}%以上（0の線から測って）に入りました。一つ前の足では入っていなかったので、流れに乗って${buy ? "買い" : "売り"}で入る合図です`,
      `  MACD = ${mx(f?.m ?? null)}、枠の${end}の端 = ${mx(edge)}（その${RIDE_IN_PCT}% = ${mx(mark(RIDE_IN_SHARE))}、${RIDE_OUT_PCT}% = ${mx(mark(RIDE_OUT_SHARE))}）`,
      gold ? `この足の終値: ${px(f?.entryPrice)}` : `${buy ? "買値" : "売値"}（この足の終値の${buy ? "買値" : "売値"}）: ${px(f?.entryPrice)}`,
    ].join("\n"),
    `この決まりは Sextant 独自のもの（数字はアプリのオーナーが決めたもの）で、公開されているインジケーターではありません（docs §8.150）。2通目は、青い線が同じ端（枠の${end}の端）の${RIDE_OUT_PCT}%に届いた時に送ります。損切りも目標もありません。青い線が${RIDE_IN_PCT}%の帯から出ても、何も送りません。2通目を送るまで、このチャートの同じ向き（${buy ? "買い" : "売り"}）の新しい1通目は送りません。枠の端には、チャートが枠を描く時に足す余白は入れていません。`,
    rideMeasuredLine(s.pair, "ja"),
    `${source}${gold ? "2通目は、Swissquote の値段を毎分記録したもの（足とは別の配信）で見ます。" : ""}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    stop,
  ]);
};

// #395 (docs §8.138): how often the rule went off on the five pairs' 1-hour
// bars in the database (GMO's mid rounded as the chart draws it, the bars
// opened 2026-07-19 23:00 to 2026-11-04 20:00 UTC, some 15.4 weeks, read as
// the bar formed: its high or low SPIKE.k times R from its open): 36 rises
// and 116 falls; gold on the
// Twelve Data 1-hour bars the live chart keeps (the bars opened 2026-09-14
// 13:00 to 2026-11-05 01:00 UTC, some 7.4 weeks): 2 and 6. What the price did
// after them has not been measured
export const SPIKE_MEASURED = {
  weeks: 15.4, up: 36, down: 116, from: "2026-07-19", to: "2026-11-04",
  goldWeeks: 7.4, goldUp: 2, goldDown: 6, goldFrom: "2026-09-14", goldTo: "2026-11-05",
} as const;

const renderSpikeMail = (s: IndicatorSignal, lang: Lang): Mail => {
  const f = s.spike;
  const d = decimalsOf(s.pair);
  const px = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
  const gold = isGold(s.pair);
  const unit = ultraUnit(s.pair);
  // a distance in pips, or dollars on gold
  const amt = (v: number) => (gold ? (lang === "en" ? `$${v.toFixed(2)}` : `${v.toFixed(2)}ドル`) : `${(v / unit).toFixed(1)}${lang === "en" ? " pips" : "pips"}`);
  const up = s.side === "BUY";
  const open = Date.parse(s.barTime);
  const closes = f ? Date.parse(f.closesAt) : open + 60 * 60_000;
  const seen = Date.parse(s.closedAt);
  const x = f ? f.x.toFixed(1) : "—";
  const m = SPIKE_MEASURED;
  if (lang === "en") {
    const what = up ? "sharp rise" : "sharp fall";
    return assemble(`[Sextant] ${s.pair} 1-hour ${what} (${x}× its usual range from the open)`, [
      `${s.pair}'s 1-hour bar has ${up ? "risen" : "fallen"} sharply: its ${up ? "high" : "low"} went ${x} times the usual hourly range ${up ? "above" : "below"} its open${f?.forming ? " (seen while the bar was forming)" : ""}.`,
      [
        `Bar: opened ${clock(open, 0)} UTC (${clock(open, 9)} JST), ${f?.forming ? "closes" : "closed"} ${clock(closes, 0).slice(11)} UTC`,
        `Open ${px(f?.open)}, ${up ? "high" : "low"} ${px(f?.extreme)} (${up ? "+" : "−"}${f ? amt(f.move) : "—"} from the open)`,
        f?.forming
          ? `Price when seen: ${px(s.close)} (${clock(seen, 0)} UTC, ${clock(seen, 9).slice(11)} JST)`
          : `Close: ${px(s.close)} (seen after the close, ${clock(seen, 0)} UTC, ${clock(seen, 9).slice(11)} JST)`,
        `The usual hourly range: ${f ? amt(f.r) : "—"} (the mean high − low of the ${SPIKE.bars} closed bars before this one${f && f.behind > 0 ? `; the stored bars were ${f.behind} behind, so the ${SPIKE.bars} up to ${f.behind} bar${f.behind > 1 ? "s" : ""} earlier` : ""}); ${SPIKE.k} times it is ${f ? amt(SPIKE.k * f.r) : "—"}`,
      ].join("\n"),
      `${f?.forming ? "This was seen as the bar formed: the price may come back before the close. " : ""}This is not a signal to buy or sell. On the five pairs' 1-hour bars in the database (${m.from} to ${m.to}, some ${m.weeks} weeks) it went off ${m.up} times for a rise and ${m.down} for a fall${gold ? `; on gold's Twelve Data 1-hour bars (${m.goldFrom} to ${m.goldTo}, some ${m.goldWeeks} weeks) ${m.goldUp} and ${m.goldDown}` : ""}. What the price did after them has not been measured.`,
      `${gold ? "The usual range is from Twelve Data's 1-hour bars and this hour's prices from Swissquote's, recorded every minute." : "The prices are the mid of GMO Coin's public bid and ask, as the app's chart draws them."} The chart's "Sharp rise / fall (1 hour)" marks the bars by the same rule${gold ? ", but the gold chart's forming bar starts from the first price your screen received, so until it closes its mark may differ from this email however large the move (none, another multiple, or one this email does not have); its closed bars are Twelve Data's, so near the line they too may differ" : "; its bars are made a little differently, so near the line a bar may have no mark there or a slightly different multiple"}. Check the latest state in the app:\n${APP_URL}`,
      "To stop these emails, open Settings → Email alerts in the app and untick \"Sharp rise / fall\".\nThis is reference information, not investment advice. Every trading decision is your own.",
    ]);
  }
  const what = up ? "急騰" : "急落";
  return assemble(`【Sextant】${pairJa(s.pair)} 1時間足 ${what}（始値からふだんの値幅の${x}倍）`, [
    `${pairJa(s.pair)}の1時間足が、急に${up ? "上がりました" : "下がりました"}。この足の${up ? "高値" : "安値"}が、始値から、ふだんの1時間の値幅の${x}倍の所まで${up ? "上がりました" : "下がりました"}${f?.forming ? "（足の途中で見た値です）" : ""}。`,
    [
      `足: ${clock(open, 9)}（日本時間）に始まった1時間足（${clock(closes, 9).slice(11)} に確定${f?.forming ? "します" : "した足"}）`,
      `始値 ${px(f?.open)}、${up ? "高値" : "安値"} ${px(f?.extreme)}（始値から ${up ? "+" : "−"}${f ? amt(f.move) : "—"}）`,
      f?.forming
        ? `見た時の値段: ${px(s.close)}（日本時間 ${clock(seen, 9).slice(11)} に見ました）`
        : `終値: ${px(s.close)}（確定のあと、日本時間 ${clock(seen, 9).slice(11)} に見ました）`,
      `ふだんの1時間の値幅: ${f ? amt(f.r) : "—"}（この足の前の確定足${SPIKE.bars}本の「高値 − 安値」の平均${f && f.behind > 0 ? `。保存した足が${f.behind}本遅れていたため、その${f.behind}本前までの${SPIKE.bars}本` : ""}）。その${SPIKE.k}倍は ${f ? amt(SPIKE.k * f.r) : "—"}`,
    ].join("\n"),
    `${f?.forming ? "足の途中で見た値なので、確定までに値段が戻ることがあります。" : ""}売買の合図ではありません。データベースの5ペアの1時間足（${m.from.replace(/-/g, "/")}〜${m.to.replace(/-/g, "/")}、約${m.weeks}週）では、急騰${m.up}回・急落${m.down}回でした${gold ? `（金は Twelve Data の1時間足〈${m.goldFrom.replace(/-/g, "/")}〜${m.goldTo.replace(/-/g, "/")}、約${m.goldWeeks}週〉で、急騰${m.goldUp}回・急落${m.goldDown}回）` : ""}。急騰・急落のあと値段がどう動いたか（続くか戻るか）は測っていません。`,
    `${gold ? "ふだんの値幅は Twelve Data の1時間足、この時間の値段は Swissquote の値段を毎分記録したものです。" : "価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ丸め方です。"}チャートの「急騰・急落（1時間足）」も同じ決まりで印を付けます${gold ? "。ただし金のチャートの作られている途中の足は、その画面が最初に受け取った値段から始まるため、確定するまでは、動きの大きさに関わらず印がこのメールと違うことがあります（印が出ない、倍数が違う、このメールに無い印が出る）。確定足は Twelve Data の足なので、境目の足では食い違うことがあります" : "が、チャートの足は作り方が少し違うため、境目の足では印が出ないことや、倍数が少し違うことがあります"}。アプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」の「急騰・急落」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
  ]);
};

export const renderIndicatorMail = (s: IndicatorSignal, lang: Lang): Mail => {
  // #391: a share's MACD email has its own text (stocks.ts)
  if (s.rule === "stockmacd") return renderStockMail(s, lang);
  // #395: a sharp rise's or fall's
  if (s.rule === "spike") return renderSpikeMail(s, lang);
  // #397: the MACD ride's three mails (the MACD email from v39; docs §8.150)
  if (s.rule === "macdx") return renderRideMail(s, lang);
  const d = decimalsOf(s.pair);
  const px = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : v.toFixed(d));
  const gold = isGold(s.pair);
  const unit = ultraUnit(s.pair);
  // a distance as ULTRA's settings are in: pips, or dollars on gold
  const dist = (v: number) => (gold ? `$${Math.abs(v - s.close).toFixed(2)}` : `${(Math.abs(v - s.close) / unit).toFixed(1)}${lang === "en" ? " pips" : "pips"}`);
  const closeMs = Date.parse(s.closedAt);
  const tf = tfLabel(lang, s.interval);
  const twelve = isTwelvePair(s.pair);
  const r1 = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : v.toFixed(1));
  // #173: a target at or below zero (a sell's TP3 on HUF/JPY, about 0.49
  // yen, when TP3 was 60 pips: 0.60) is no price, and is said to be none.
  // #192's 16 pips (0.16) reach none on the pairs mailed now; kept for a
  // level or a pair to come
  const tpLine = (k: number, v: number) =>
    v > 0
      ? lang === "en" ? `  TP${k + 1} ${px(v)} (${dist(v)})` : `  利確${k + 1} ${px(v)}（${dist(v)}）`
      : lang === "en" ? `  TP${k + 1} — (it would be below zero, so there is none)` : `  利確${k + 1} —（0より下になるため、この目安はありません）`;
  // #291: a bar of the video's way by its close, in the language's time
  // (the day said only when it is not the signal's bar's day)
  const whenClosed = (iso: string, offsetHours: number) => {
    const c = clock(Date.parse(iso), offsetHours);
    return c.slice(0, 10) === clock(closeMs, offsetHours).slice(0, 10) ? c.slice(11) : c;
  };
  // #291: how far beyond the last bars' extreme the stop goes, a pip as the
  // rule counts it ($0.10 on gold)
  const slStep = SWEEPX.slPips * sweepPip(s.pair);
  const slBeyond = gold
    ? lang === "en" ? `$${slStep.toFixed(2)}` : `${slStep}ドル`
    : `${SWEEPX.slPips} pip`;
  if (lang === "en") {
    if (s.rule === "sweepx") {
      const f = s.sweep;
      const buy = s.side === "BUY";
      const side = buy ? "BUY" : "SELL";
      return assemble(`[Sextant] ${s.pair} ${tf} ${side} signal (liquidity sweep + EMA cross)`, [
        `A ${side} signal of the video's way (a liquidity sweep, then the EMA cross) fired on ${s.pair}, ${tf} chart.`,
        [
          `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
          ...(f
            ? [
              buy
                ? `Low taken: the last wave's low ${px(f.level)} (the bar closed ${whenClosed(f.levelClosedAt, 0)} UTC) was broken, down to ${px(f.extreme)} (the bar closed ${whenClosed(f.extremeClosedAt, 0)} UTC)`
                : `High taken: the last wave's high ${px(f.level)} (the bar closed ${whenClosed(f.levelClosedAt, 0)} UTC) was broken, up to ${px(f.extreme)} (the bar closed ${whenClosed(f.extremeClosedAt, 0)} UTC)`,
              `EMA cross: EMA 20 (${px(f.fast)}) crossed ${buy ? "above" : "below"} EMA 80 (${px(f.slow)})`,
            ]
            : []),
        ].join("\n"),
        [
          `Stop and targets (the video's "15 to 20 pips"${gold ? ", a pip being $0.10 on gold" : ""}):`,
          `  Entry ≈ ${px(s.close)}`,
          `  Stop ${px(s.sl)} (${s.sl === null ? "—" : dist(s.sl)}): ${slBeyond} beyond the ${buy ? "lowest low" : "highest high"} of the last ${SWEEPX.slBars} bars`,
          ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
        ].join("\n"),
        `This is the way shown in a gold trader's Instagram video, made into a rule by this app (docs §8.112): the last wave's ${buy ? "low" : "high"} taken once (a liquidity sweep), then the entry on EMA 20 crossing EMA 80; the break of structure is not waited for. The video gives no numbers but "15 to 20 pips", so the window it is judged on (${SWEEPX.window} closed bars), where the stop goes and the like are this app's. ${measuredLine(s, "en")}`,
        `The bars are 1-minute bars made from Swissquote's gold prices (the mid, recorded every few seconds; the minutes before the recording began are Twelve Data's), the same as the app's gold 1-minute chart. Check the latest state in the app before you place an order:\n${APP_URL}`,
        "To stop these emails, open Settings → Email alerts in the app and untick \"Liquidity sweep + EMA cross\".\nThis is reference information, not investment advice. Every trading decision is your own.",
      ]);
    }
    if (s.rule === "emarm") {
      // #387 (docs §8.130): the EMA 20 / 200 way's entry, with its levels
      const f = s.emarm;
      const buy = s.side === "BUY";
      const side = buy ? "BUY" : "SELL";
      const src = twelve
        ? `The bars are Twelve Data's (GMO Coin does not carry ${s.pair}), as the app's chart draws them.`
        : "The bars are the mid of GMO Coin's public bid and ask, as the app's chart draws them.";
      return assemble(`[Sextant] ${s.pair} ${tf} ${side} signal (EMA cross + return move)`, [
        `A ${side} of the video's way (EMA 20 and EMA 200 cross, then the return move) fired on ${s.pair}, ${tf} chart: this bar closed ${buy ? "above" : "below"} the return move's body.`,
        [
          `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
          ...(f
            ? [
              `${buy ? "Golden" : "Dead"} cross (EMA 20 ${buy ? "over" : "under"} EMA 200): the bar closed ${whenClosed(f.crossClosedAt, 0)} UTC`,
              `Back to the 200 EMA: the bar closed ${whenClosed(f.touchClosedAt, 0)} UTC`,
              `The horizontal neckline ${px(f.neck)} (the ${buy ? "high" : "low"} of the bar closed ${whenClosed(f.neckClosedAt, 0)} UTC) and the diagonal from A ${px(f.a)} (the bar closed ${whenClosed(f.aClosedAt, 0)} UTC): both broken by the bar closed ${whenClosed(f.breakClosedAt, 0)} UTC`,
              `The return move to the horizontal: the bar closed ${whenClosed(f.retestClosedAt, 0)} UTC`,
            ]
            : []),
        ].join("\n"),
        [
          "Stop and targets (the rule's, made from the video's):",
          `  Entry ≈ ${px(s.close)}`,
          `  Stop ${px(s.sl)} (${s.sl === null ? "—" : dist(s.sl)}): the ${buy ? "lowest low" : "highest high"} from the bar that broke the diagonal to this one`,
          ...(s.tps ?? []).map((v, k) =>
            k === 0
              ? `  TP1 ${px(v)} (${dist(v)}): A, the ${buy ? "highest high" : "lowest low"} since the cross`
              : `  TP2 ${px(v)} (${dist(v)}): wave 1's height from wave 3's start`
          ),
          `  TP1's distance over the stop's: ${f ? f.rr.toFixed(2) : "—"}`,
        ].join("\n"),
        `This is the way shown in an Instagram video (GBP/JPY scalping on the 15-minute chart), made into a rule by this app (docs §8.130). The video draws its lines by hand, so the swings (3 bars on each side), where the stop goes and the like are this app's. It is judged with the same code as "EMA cross + return move" on the app's chart, on the ${EMA_RETURN.window} closed bars ending at this bar. ${measuredLine(s, "en")}`,
        `${src} Check the latest state in the app before you place an order:\n${APP_URL}`,
        "To stop these emails, open Settings → Email alerts in the app and untick the chart under EMA cross + return move.\nThis is reference information, not investment advice. Every trading decision is your own.",
      ]);
    }
    if (s.rule === "amdpo3") {
      // #385 (docs §8.128): AMD Po3's DIST, with the original's levels
      const f = s.amd;
      const buy = s.side === "BUY";
      const src = twelve
        ? `The bars are Twelve Data's (GMO Coin does not carry ${s.pair}), as the app's chart draws them.`
        : "The bars are the mid of GMO Coin's public bid and ask, as the app's chart draws them.";
      return assemble(`[Sextant] ${s.pair} ${tf} ${buy ? "BUY (D ▲)" : "SELL (D ▼)"} signal (AMD Po3)`, [
        `AMD Po3 marked ${buy ? "D ▲ (BUY)" : "D ▼ (SELL)"} on ${s.pair}, ${tf} chart: the manipulation confirmed and its reference trade opened.`,
        [
          `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
          ...(f
            ? [
              `Accumulation (the range that narrowed): ${px(f.rangeLow)} – ${px(f.rangeHigh)}, from the bar closed ${whenClosed(f.rangeFromClosedAt, 0)} UTC`,
              `Manipulation: the price broke ${f.sweepSide === "HIGH" ? "above the range" : "below the range"} to ${px(f.sweepExtreme)}, then this bar closed back inside it`,
            ]
            : []),
        ].join("\n"),
        [
          "The original's reference levels (entering at the D bar's close):",
          `  Entry ≈ ${px(s.close)}`,
          `  Stop ${px(s.sl)} (${s.sl === null ? "—" : dist(s.sl)}): 0.4 × ATR 14 beyond the sweep's tip`,
          ...(s.tps ?? []).map((v) => `  Target ${px(v)} (${dist(v)}): the 1.5 extension of the sweep — where the distribution is expected to reach, not a take-profit`),
          `  R:R ${f ? f.rr : "—"} (the target's distance over the stop's). Neither reached within ${AMD_PO3.distTimeoutBars} bars: a timeout`,
        ].join("\n"),
        `AMD Po3 with Live Edge Stats is the code WillyAlgoTrader published on TradingView (v2.4.0), ported at its default settings; this email is judged with the same code as the "AMD Po3" on the app's chart (docs §8.128), at the bar the original sends its DIST alert on. The target rate and average R in the chart's table count the bars that chart could read, and are not this email's win rate. ${measuredLine(s, "en")}`,
        `${src} Check the latest state in the app before you place an order:\n${APP_URL}`,
        "To stop these emails, open Settings → Email alerts in the app and untick the chart under AMD Po3.\nThis is reference information, not investment advice. Every trading decision is your own.",
      ]);
    }
    const side = s.side === "BUY" ? "BUY" : "SELL";
    const source = twelve
      ? `The bars are Twelve Data's (GMO Coin does not carry ${s.pair}), as the app's chart draws them.`
      : "The bars are the mid of GMO Coin's public bid and ask, as the app's chart draws them.";
    const footer = [
      `${source} Check the latest state in the app before you place an order:\n${APP_URL}`,
      "To stop these emails, open Settings → Email alerts in the app and untick the chart under Q-Trend or ULTRA.\nThis is reference information, not investment advice. Every trading decision is your own.",
    ];
    if (s.rule === "qtrend") {
      const how = s.side === "BUY" ? "above" : "below";
      return assemble(`[Sextant] ${s.pair} ${tf} ${side}${s.strong ? " (STRONG)" : ""} signal (Q-Trend)`, [
        `A Q-Trend ${side}${s.strong ? " (STRONG)" : ""} signal fired on ${s.pair}, ${tf} chart.`,
        [
          `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
          `Close ${px(s.close)}, ${how} the trend line ${px(s.line)} by more than ε (ATR(14) × 1 = ${px(s.eps)})`,
          ...(s.strong
            ? [`STRONG: one of the last five bars opened in the ${s.side === "BUY" ? "lowest" : "highest"} eighth of the 200-bar range of closes`]
            : []),
        ].join("\n"),
        [
          "Stop and targets (ULTRA's numbers):",
          `  Entry ≈ ${px(s.close)}`,
          `  Stop ${px(s.sl)} (${s.sl === null ? "—" : dist(s.sl)})`,
          ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
        ].join("\n"),
        `Q-Trend (tarasenko_'s open-source Pine script, at its defaults 200, 14, 1) has no stop or target of its own, so these are ULTRA's numbers. ${measuredLine(s, "en")}`,
        ...footer,
      ]);
    }
    const cross = s.side === "BUY" ? "back above 30" : "back below 70";
    return assemble(`[Sextant] ${s.pair} ${tf} ${s.side === "BUY" ? "Buy ☆" : "Sell ☆"} signal (ULTRA)`, [
      `An ULTRA ${s.side === "BUY" ? "Buy ☆" : "Sell ☆"} signal fired on ${s.pair}, ${tf} chart.`,
      [
        `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
        `RSI(14): ${r1(s.rsiPrev)} → ${r1(s.rsi)} (${cross})`,
      ].join("\n"),
      [
        gold ? "ULTRA's levels (the stop $13; the targets $4, $10 and $16):" : "ULTRA's levels (the stop 13 pips; the targets 4, 10 and 16 pips):",
        `  Entry ≈ ${px(s.close)}`,
        `  Stop ${px(s.sl)} (${s.sl === null ? "—" : dist(s.sl)})`,
        ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
      ].join("\n"),
      `ULTRA is built from F-INVEST's video (its code is not published), and its signals are that video's. Its stop and targets follow the chart of a second F-INVEST video (its premium version, on gold, whose table shows TP1 reached 80–82% of the time; its signals have filters this app does not have): the stop 13 and the targets 4, 10 and 16, ${gold ? "dollars on gold" : "pips on currency pairs"}. ${measuredLine(s, "en")}`,
      ...footer,
    ]);
  }
  if (s.rule === "sweepx") {
    const f = s.sweep;
    const buy = s.side === "BUY";
    const sideS = `${buy ? "買い" : "売り"}（${s.side}）`;
    return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${sideS}のサイン（流動性狩り＋EMAクロス）`, [
      `${pairJa(s.pair)}の${tf}で、動画のやり方（流動性狩り → EMAクロス）の${sideS}のサインが出ました。`,
      [
        `判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`,
        ...(f
          ? [
            buy
              ? `安値を狩った: ${whenClosed(f.levelClosedAt, 9)} に確定した足の安値 ${px(f.level)}（一つ前の波の谷）を、${whenClosed(f.extremeClosedAt, 9)} に確定した足で ${px(f.extreme)} まで下回りました（Low taken）`
              : `高値を狩った: ${whenClosed(f.levelClosedAt, 9)} に確定した足の高値 ${px(f.level)}（一つ前の波の山）を、${whenClosed(f.extremeClosedAt, 9)} に確定した足で ${px(f.extreme)} まで上回りました（High taken）`,
            `EMAクロス: EMA20（${px(f.fast)}）が EMA80（${px(f.slow)}）を${buy ? "下から上に" : "上から下に"}抜けました`,
          ]
          : []),
      ].join("\n"),
      [
        `損切り・利確の目安（動画の「15〜20ピップス」${gold ? "。金の1 pip は0.1ドル" : ""}）:`,
        `  エントリー ≈ ${px(s.close)}`,
        `  損切り ${px(s.sl)}（${s.sl === null ? "—" : dist(s.sl)}。直近${SWEEPX.slBars}本の${buy ? "安値の最安値より" : "高値の最高値より"}${slBeyond}${buy ? "下" : "上"}）`,
        ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
      ].join("\n"),
      `この合図は、Instagram の金のトレーダーの動画のやり方（一つ前の波の${buy ? "安値" : "高値"}を一度抜ける「流動性狩り」のあと、EMA20 と EMA80 のクロスで入る）を、このアプリで決まりにしたものです（docs §8.112）。構造の崩壊（BOS）は待ちません。動画には「15〜20ピップス」のほかに数字がないため、判断する範囲（確定足${SWEEPX.window}本）や損切りの置き方などはこのアプリで決めました。${measuredLine(s, "ja")}`,
      `足は Swissquote の金の値段（約3秒ごとに記録した中値）から作った1分足（記録を始める前の分は Twelve Data の1分足）で、アプリのチャートの金の1分足と同じです。注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
      "この通知を止めるには、アプリの「設定」→「メール通知」の「流動性狩り＋EMAクロス」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
    ]);
  }
  if (s.rule === "emarm") {
    // #387 (docs §8.130): the EMA 20 / 200 way's entry, with its levels
    const f = s.emarm;
    const buy = s.side === "BUY";
    const sideA = buy ? "買い（BUY）" : "売り（SELL）";
    const src = twelve
      ? `足は Twelve Data のもの（${pairJa(s.pair)}は GMOコインにないため）で、アプリのチャートと同じです。`
      : "価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ足で判定しています。";
    return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${sideA}のサイン（EMAクロス＋リターンムーブ）`, [
      `${pairJa(s.pair)}の${tf}で、EMAクロス＋リターンムーブ（動画のやり方）の${sideA}が出ました。リターンムーブの足の実体を、終値で${buy ? "上" : "下"}に抜けた足です。`,
      [
        `判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`,
        ...(f
          ? [
            `${buy ? "ゴールデン" : "デッド"}クロス（EMA20 が EMA200 を${buy ? "上" : "下"}に抜けた）: ${whenClosed(f.crossClosedAt, 9)} に確定した足`,
            `EMA200 へのタッチ: ${whenClosed(f.touchClosedAt, 9)} に確定した足`,
            `水平線 ${px(f.neck)}（${whenClosed(f.neckClosedAt, 9)} に確定した足の${buy ? "高値" : "安値"}）と、A ${px(f.a)}（${whenClosed(f.aClosedAt, 9)} に確定した足）からの斜めの線: ${whenClosed(f.breakClosedAt, 9)} に確定した足で両方を抜けました`,
            `水平線へのリターンムーブ: ${whenClosed(f.retestClosedAt, 9)} に確定した足`,
          ]
          : []),
      ].join("\n"),
      [
        "損切りと利確の目安（動画をもとに、このアプリで決めたもの）:",
        `  エントリー ≈ ${px(s.close)}`,
        `  損切り ${px(s.sl)}（${s.sl === null ? "—" : dist(s.sl)}。斜めの線を抜けた足からこの足までの${buy ? "最安値" : "最高値"}）`,
        ...(s.tps ?? []).map((v, k) =>
          k === 0
            ? `  利確1 ${px(v)}（${dist(v)}。A：クロスからの${buy ? "最高値" : "最安値"}、直近${buy ? "高値" : "安値"}）`
            : `  利確2 ${px(v)}（${dist(v)}。1波の値幅分）`
        ),
        `  利確1までの幅 ÷ 損切りまでの幅: ${f ? f.rr.toFixed(2) : "—"}`,
      ].join("\n"),
      `Instagram の動画（GBP/JPY の15分足のスキャルピング）のやり方を、このアプリで決まりにしたものです（docs §8.130）。動画は線を手で引いているため、山・谷（左右3本）や損切りの位置などは、このアプリで決めました。アプリのチャートの「EMAクロス＋リターンムーブ」と同じコードで、この足までの確定足${EMA_RETURN.window}本で判定しています。${measuredLine(s, "ja")}`,
      `${src}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
      "この通知を止めるには、アプリの「設定」→「メール通知」の「EMAクロス＋リターンムーブ」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
    ]);
  }
  if (s.rule === "amdpo3") {
    // #385 (docs §8.128): AMD Po3's DIST, with the original's levels
    const f = s.amd;
    const buy = s.side === "BUY";
    const sideA = buy ? "買い（BUY・D ▲）" : "売り（SELL・D ▼）";
    const src = twelve
      ? `足は Twelve Data のもの（${pairJa(s.pair)}は GMOコインにないため）で、アプリのチャートと同じです。`
      : "価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ足で判定しています。";
    return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${sideA}のサイン（AMD Po3）`, [
      `${pairJa(s.pair)}の${tf}で、AMD Po3 の ${buy ? "D ▲（買い）" : "D ▼（売り）"}が出ました。仕掛けが確定し、基準の売買が始まった足です。`,
      [
        `判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`,
        ...(f
          ? [
            `集積（値幅が縮んだ範囲）: ${px(f.rangeLow)} 〜 ${px(f.rangeHigh)}（${whenClosed(f.rangeFromClosedAt, 9)} に確定した足から）`,
            `仕掛け: 範囲の${f.sweepSide === "HIGH" ? "上" : "下"}を ${px(f.sweepExtreme)} まで抜けたあと、この足の終値で範囲の中に戻りました`,
          ]
          : []),
      ].join("\n"),
      [
        "元のインジケーターの基準の値（D の足の終値で入った場合）:",
        `  エントリー ≈ ${px(s.close)}`,
        `  損切り ${px(s.sl)}（${s.sl === null ? "—" : dist(s.sl)}。抜けた先端から ATR14 の0.4倍外）`,
        ...(s.tps ?? []).map((v) => `  目標 ${px(v)}（${dist(v)}。抜けた幅の1.5倍の延長。利確の指示ではなく、分配が届く目安）`),
        `  R:R ${f ? f.rr : "—"}（目標までの幅 ÷ 損切りまでの幅）。${AMD_PO3.distTimeoutBars}本たっても届かなければ時間切れ`,
      ].join("\n"),
      `AMD Po3 with Live Edge Stats（WillyAlgoTrader が TradingView に公開したコード、v2.4.0）を既定の設定のまま移植したもので、アプリのチャートの「AMD Po3」と同じコードで判定しています（docs §8.128）。元のインジケーターが DIST の通知を出す足（仕掛けが確定し、基準の売買が始まった足）で送ります。チャートの表の目標の割合や平均 R は、そのチャートで読めた足の中で数えたもので、このメールの勝率ではありません。${measuredLine(s, "ja")}`,
      `${src}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
      "この通知を止めるには、アプリの「設定」→「メール通知」の「AMD Po3」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
    ]);
  }
  // Q-Trend's STRONG in the same brackets: 買い（BUY・STRONG）
  const qtSide = `${s.side === "BUY" ? "買い" : "売り"}（${s.side}${s.strong ? "・STRONG" : ""}）`;
  const source = twelve
    ? `足は Twelve Data のもの（${pairJa(s.pair)}は GMOコインにないため）で、アプリのチャートと同じです。`
    : "価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ足で判定しています。";
  const footer = [
    `${source}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」の Q-Trend・ULTRA でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
  ];
  if (s.rule === "qtrend") {
    const how = s.side === "BUY" ? "上" : "下";
    return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${qtSide}のサイン（Q-Trend）`, [
      `${pairJa(s.pair)}の${tf}で、Q-Trend の${qtSide}のサインが出ました。`,
      [
        `判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`,
        `終値 ${px(s.close)} が Q-Trend の線 ${px(s.line)} を、ε（ATR(14)×1 = ${px(s.eps)}）より大きく${how}に抜けました`,
        ...(s.strong ? [`STRONG: 直近5本のうちに、終値の200本の値幅の${s.side === "BUY" ? "下" : "上"}から8分の1の所で始まった足があります`] : []),
      ].join("\n"),
      [
        "損切り・利確の目安（ULTRA と同じ数字）:",
        `  エントリー ≈ ${px(s.close)}`,
        `  損切り ${px(s.sl)}（${s.sl === null ? "—" : dist(s.sl)}）`,
        ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
      ].join("\n"),
      `Q-Trend（tarasenko_ の公開コードを移植、既定の設定 200・14・1）にはもともと損切り・利確の目安がないため、ULTRA と同じ数字を付けています。${measuredLine(s, "ja")}`,
      ...footer,
    ]);
  }
  const sideU = s.side === "BUY" ? "買い（Buy ☆）" : "売り（Sell ☆）";
  const cross = s.side === "BUY" ? "30 を下から上に抜けました" : "70 を上から下に抜けました";
  return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${sideU}のサイン（ULTRA）`, [
    `${pairJa(s.pair)}の${tf}で、ULTRA の${sideU}のサインが出ました。`,
    [`判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`, `RSI(14): ${r1(s.rsiPrev)} → ${r1(s.rsi)}（${cross}）`].join("\n"),
    [
      gold ? "ULTRA の目安（損切りは13ドル、利確は4・10・16ドル）:" : "ULTRA の目安（損切りは13pips、利確は4・10・16pips）:",
      `  エントリー ≈ ${px(s.close)}`,
      `  損切り ${px(s.sl)}（${s.sl === null ? "—" : dist(s.sl)}）`,
      ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
    ].join("\n"),
    `ULTRA は F-INVEST の動画の設定と印から作ったものです（コードは公開されていません）。サインの出し方はその動画のままです。損切り・利確は、F-INVEST のもう一つの動画（上位版・金。表では利確1に届いたのが80〜82%。サインには、このアプリにない絞り込みがあります）のチャートの線に合わせて、損切り13・利確4・10・16（${gold ? "金はドル" : "FX は pips"}）にしています。${measuredLine(s, "ja")}`,
    ...footer,
  ]);
};
