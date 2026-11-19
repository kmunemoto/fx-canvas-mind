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
// (#397: from v39 the email was the ride's; v40: the fade's, below; the pane's 120 bars are still this file's)
import { ZONE_BARS } from "../_shared/macd-level.ts";
// v40 (docs §8.155; research/macdfade1h-prod-spec.md): the MACD email as the fade at a closed 1-hour bar: one email
// when the line closes at 96% of the pane's top (a SELL) or bottom (a BUY), the bar before not at 96%. The rule is the
// shared one (_shared/macd-fade.ts, which research/macdfade-prod-check.ts holds to the study, research/macdfade15-spec.md
// "On 1-hour bars"); what was measured of it is kept in one place (_shared/macd-fade-measured.ts). v41
// (research/macdfade15min-prod-spec.md): the same fade at a closed 15-minute bar (MACDH_INTERVALS)
import { FADE_PCT, FADE_SHARE, fadeRuleId, type FadeEntry, type FadeZoneSide } from "../_shared/macd-fade.ts";
import { fadeMeasuredLine } from "../_shared/macd-fade-measured.ts";
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
import { CHART_BARS, GOLD, LIVE_PAIRS, LIVE_STEP_MS, isGold, isTwelvePair } from "../live-chart/logic.ts";
import { GMO_SYMBOLS, fillSide, sideOf, type QuoteCandle } from "../track-outcomes/quotes.ts";
import { APP_URL, assemble, clock, tfLabel, type Lang, type Mail } from "./logic.ts";
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
// v40 (docs §8.155; research/macdfade1h-prod-spec.md): the MACD email is the
// fade at a closed 1-hour bar, the owner's 「もうシンプル96%の足できたら逆張り
// のメールちょうだい」, then 「メールを1時間足から15分足に変更」, then 「やっぱり
// メールの判断1時間足で」 (2026-11-17): one email at the close of the 1-hour
// bar at which the blue line is at 96% or more of the pane's top (a SELL) or
// bottom (a BUY), the bar before not at 96% (_shared/macd-fade.ts
// fadeCloseEntryAt, on the 600 closes ending at the bar), with the price in
// only (a pair's ask close for a BUY and bid close for a SELL of GMO's 1-hour
// bar, gold's close): no take-profit and no stop price. v9's ride and its
// three ids are written no more. One id, built from the constants
// (MACDH_RULE_ID, below MACDH_INTERVALS, which stayed the 1-hour chart):
// macdx_12_26_9_w600_1h_fade96of120_in_v11 (v11: a number no id ever written
// held, spec 3.7). The subscriptions kept rule = 'macdx', on the same charts.
// v41 (research/macdfade15min-prod-spec.md): the same fade on the 15-minute
// chart of the five pairs and gold (MACDH_INTERVALS), the owner's 「メールの
// 判断15分に変更して」 (2026-11-19): the 600 closes ending at the bar, 96%,
// the bar before not at 96%, the pane of the newest 120 bars (now 15-minute
// bars), the price in (a pair's ask close for a BUY and bid close for a SELL
// of GMO's 15-minute bar, gold's close), no take-profit and no stop price.
// One id: macdx_12_26_9_w600_15min_fade96of120_in_v12 (v12, not v11: v40
// writes v11, and every change of the MACD email's chart raised the number,
// spec 3.7). The subscriptions keep rule = 'macdx'; each '1h' row gets a
// '15min' twin before the release (spec 3.6), since v41 reads, offers and
// accepts the 15-minute chart only.
// MACDH_K is v26's k, kept with the rule it belongs to (decideScaledOnWindow,
// which the morning check's SQL v3 mirrors); no email uses it from v28.
export const MACDH_K = 0.8;
// v40: the version in the fade's rule id (spec 3.7); v41: 12 (11 is v40's,
// written from 2026-11-18; research/macdfade15min-prod-spec.md 3.7)
export const MACDH_FADE_VERSION = 12;
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
// 1-hour rule's; #397: v39 under its email 1's, the ride's other two mails
// each under its own; v40: the fade's one id)
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
// The id a signal's row is written under (signal_alerts.rule, part of the key
// that keeps a mail from being sent twice): its rule's (indicatorRuleId).
// (#397: v39's ride wrote each of its three mails under that mail's own id;
// v40: the fade has one mail and one id)
export const signalRuleId = (s: Pick<IndicatorSignal, "rule">): string => indicatorRuleId(s.rule);

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
// v40 (docs §8.155; research/macdfade1h-prod-spec.md 2.4, 3.2 and 3.6): the
// MACD fade on the same 1-hour charts, read and judged as v39 read them
// (「やっぱりメールの判断1時間足で」).
// v41 (research/macdfade15min-prod-spec.md 2.4, 3.2 and 3.6): the fade on
// their 15-minute chart (the owner: 「メールの判断15分に変更して」,
// 2026-11-19), read as v31 read it: the five pairs' GMO bars 0, 1 and 3
// minutes after each quarter hour (gmoIntervalsDue), gold's Twelve Data bars
// from a minute after each close until the next (twelveCloseDue), fresh 20
// minutes (freshFor). The charts change, and so do the subscriptions: v41
// reads, offers and accepts 'macdx' on the 15-minute chart only, so each '1h'
// row gets a '15min' twin before the release (spec 3.6). This one constant
// drives isMacdhChart, isIndicatorChartFor('macdx'), the run's subscriptions,
// the status call, set / set_many, the rule id and the econ digest's
// recipients (econ-calendar/mailer.ts).
export const MACDH_INTERVALS = ["15min"] as const;
export const MACDH_PAIRS: readonly string[] = [
  ...MACDX_PAIRS.filter((p) => ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"].includes(p)),
  GOLD,
];
export const isMacdhChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && MACDH_PAIRS.includes(pair) &&
  (MACDH_INTERVALS as readonly string[]).includes(interval) && isIndicatorChart(pair, interval);
// v40 (spec 3.7): the fade's one rule id (what indicatorRuleId gives for
// 'macdx'), every part from a constant: macdx_12_26_9_w600_1h_fade96of120_in_v11;
// v41: macdx_12_26_9_w600_15min_fade96of120_in_v12
export const MACDH_RULE_ID = fadeRuleId("macdx", MACDH_INTERVALS[0], MACDH_FADE_VERSION);
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
  // #386: the 1-hour chart's again from v33; #397: no email of the pairs' or gold's carries it from v39; v40: `fade`, below)
  macdh?: MacdhFacts | null;
  // #385: AMD Po3's (absent on the other rules')
  amd?: AmdFacts | null;
  // #387: the EMA 20 / 200 way's (absent on the other rules')
  emarm?: EmarmFacts | null;
  // #395: a sharp rise's or fall's (absent on the other rules')
  spike?: SpikeFacts | null;
  // v40: the MACD fade's (the MACD email's from v40, and the shares'; absent
  // on the other rules'). (#397: v39's `ride`, its three mails, went with it)
  fade?: FadeFacts | null;
}

// v40 (docs §8.155; research/macdfade1h-prod-spec.md 3.4): what made the MACD
// fade's one email, at a closed bar (v40: a 1-hour bar; v41: a 15-minute bar,
// research/macdfade15min-prod-spec.md 3.4). `zside`: the edge of the MACD
// pane the line closed at, the top (a SELL) or the bottom (a BUY). m, top and
// bottom: the MACD line and the pane's edges at the bar's close (Z), as the
// shared code gives them, unrounded; share0 the line's share of that edge (m /
// top or m / bottom). `price`: the price in, a pair's ask close for a BUY and
// bid close for a SELL (GMO's bar of the chart judged, as given), gold's and a
// share's close. On a fade's signal barTime is the bar's open, closedAt its close,
// close its close as the chart draws it; no stop and no target (sl and tps
// null), and no text states either. (#397: v39's RideFacts, a mail of the
// ride, went with it)
export interface FadeFacts {
  zside: FadeZoneSide;
  m: number;
  top: number;
  bottom: number;
  share0: number;
  price: number;
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
// #397 (docs §8.150): from v39 that decision made no email: the MACD email
// was a ride (_shared/macd-ride.ts; research/macdride-spec.md), two emails a
// trade, its rows in public.macd_rides and public.macd_ride_state (not
// written from v40; v9's morning check and a rollback read them).
// v40 (docs §8.155; research/macdfade1h-prod-spec.md sections 2 and 3): the
// MACD email is the fade at a closed bar (v40: 1-hour; v41: 15-minute,
// research/macdfade15min-prod-spec.md sections 2 and 3). What a close does is
// fadeCloseEntryAt (_shared/macd-fade.ts) on the 600 closes ending there; the
// sweep (index.ts fadeAtClose) prices it and mails it, and keeps nothing.
// What is here: the price in, the signal, its row and its tag, all pure so
// that the tests and the shares' run can call them. No take-profit and no
// stop price.

// The price in at a bar's close, from GMO's bar with both sides (as given,
// unrounded): a BUY is filled on the ask, a SELL on the bid (fillSide,
// track-outcomes/quotes.ts): the study's price, GMO's own bar's bid and ask
// close (research/macdfade15-spec.md "Prices in"; v41: the 15-minute bar's,
// from the same read the chart's closes come from, index.ts fadeQuotes). Gold
// and the shares have one price, the bar's close. (v39's ride paid the same;
// research/macdfade-prod-check.ts prices the study's entries with this one)
export const ridePaidAt = (side: "BUY" | "SELL", q: QuoteCandle): number => sideOf(q, fillSide(side)).close;

const isoOf = (ms: number): string => new Date(ms).toISOString();

// The fade's one email at the close of the bar an entry was found at
// (fadeCloseEntryAt), as a signal. `bar`: its open and close (ms), its close
// as the chart draws it, and the price in (a pair's ask close for a BUY and
// bid close for a SELL; gold's and a share's close). `rule`: 'macdx' (the
// pairs and gold) or 'stockmacd' (the shares).
export const fadeSignal = (
  rule: "macdx" | "stockmacd",
  pair: string,
  interval: string,
  entry: FadeEntry,
  bar: { openMs: number; closeMs: number; close: number; price: number },
): IndicatorSignal => ({
  rule,
  pair,
  interval,
  side: entry.side,
  strong: false,
  barTime: isoOf(bar.openMs),
  closedAt: isoOf(bar.closeMs),
  close: bar.close,
  line: null,
  eps: null,
  rsi: null,
  rsiPrev: null,
  sl: null,
  tps: null,
  fade: { zside: entry.zside, m: entry.z.m, top: entry.z.top, bottom: entry.z.bottom, share0: entry.share0, price: bar.price },
});

// What a signal's row in public.signal_alerts says of it (the claim's key is
// user_id, kind, pair, interval, bar_time, side, rule). A fade's: under its
// rule's id, the entry the price in (a pair's bid or ask close, not the mid),
// no stop and no target.
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
  entry: s.fade ? s.fade.price : s.close,
  stop: s.fade ? null : s.sl,
  target: s.fade ? null : s.tps ? s.tps[0] : null,
  rule: signalRuleId(s),
});

// How a signal is written in a run's record (the signals of an entry of
// summary.reads): "macdx:SELL", "macdx:BUY" (the shares' "stockmacd:SELL").
// (#397: v39's notice and email 2 were "macdx-at:" and "macdx-out:"; v40 has
// neither, so a reader of the record who takes what starts with "macdx:", the
// morning check's Routine, takes the fade's email)
export const rideSignalTag = (s: Pick<IndicatorSignal, "rule" | "side">): string => `${s.rule}:${s.side}`;

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
// (#397: the MACD email, a ride in v39, had its own measured paragraph; v40:
// the fade's is fadeMeasuredLine, _shared/macd-fade-measured.ts; this line is
// not its)
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
// 20. #397: the edge was the pane's on the ride's side, the top for a BUY and
// the bottom for a SELL (the 95% email took the bottom for a BUY); v40: the
// fade's side, the top for a SELL and the bottom for a BUY, as the 95% email's
const macdNumbers = (pair: string, end: number | null): ((v: number | null) => string) => {
  const d = decimalsOf(pair);
  const md = end !== null && Number.isFinite(end) && end !== 0 ? Math.min(20, Math.max(d, 1 - Math.floor(Math.log10(Math.abs(end))))) : d;
  return (v: number | null) => (v !== null && Number.isFinite(v) ? v.toFixed(md).replace(/^-/, "−") : "—");
};

// v40 (docs §8.155; research/macdfade1h-prod-spec.md 4.1 to 4.3): the MACD
// fade's one email on the five pairs and gold, the spec's words, ja and en:
// the bar, that the blue line closed at 96% or more of the pane's top
// (bottom) with the bar before not at 96% (a fade SELL, BUY), its numbers, the
// price in, that there is no take-profit and no stop price (how the rule is
// built, not advice), that it is the only email, when it is judged and sent,
// what was measured (the pairs': _shared/macd-fade-measured.ts; gold: not
// measured, no number) and whose choices these are. The pane's edge is the
// side's: the top for a SELL, the bottom for a BUY. No price is labelled a
// take-profit or a stop, and nothing says a price will come back. (#397:
// v39's three mails, renderRideMail and its measured paragraph, went with the
// ride)
// v41 (research/macdfade15min-prod-spec.md 4.2 and 4.3): on the 15-minute
// chart; the bar's word comes from the signal's interval (tfLabel). Rewritten:
// when it is judged and sent (a pair at the reads right after the close and 1
// and 3 minutes after, gmoIntervalsDue; gold from 1 minute after the close
// until the next bar closes, twelveCloseDue) and whose choices these are (the
// pane of the newest 120 15-minute bars is the owner's choice too, 2026-11-17)
const renderFadeMail = (s: IndicatorSignal, lang: Lang): Mail => {
  const f = s.fade ?? null;
  const gold = isGold(s.pair);
  const d = decimalsOf(s.pair);
  const px = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
  const buy = s.side === "BUY";
  const top = (f?.zside ?? (buy ? "bottom" : "top")) === "top";
  const edge = f ? (top ? f.top : f.bottom) : null;
  const mx = macdNumbers(s.pair, edge);
  const mark = edge === null ? null : FADE_SHARE * edge;
  const tf = tfLabel(lang, s.interval);
  const close = Date.parse(s.closedAt);
  const price = f ? f.price : null;
  if (lang === "en") {
    const side = buy ? "BUY" : "SELL";
    const end = top ? "top" : "bottom";
    return assemble(`[Sextant] ${s.pair} ${tf} ${side}: the MACD line closed at ${FADE_PCT}% of the ${end} (MACD fade)`, [
      `A MACD fade ${side} signal on ${s.pair}'s ${tf} chart.`,
      [
        `Bar judged: the ${tf} bar that closed at ${clock(close, 0)} UTC (${clock(close, 9)} JST)`,
        `At this bar's close the MACD line (blue) was at ${FADE_PCT}% or more of the ${end} of the MACD pane of the newest ${ZONE_BARS} bars (${tf}) (the ${top ? "highest" : "lowest"} of the blue line, the orange line and the bars), measured from the zero line. At the close of the bar before, it was below ${FADE_PCT}%. It is the ${end}, so this is a fade ${side} signal.`,
        `MACD = ${mx(f?.m ?? null)}, the pane's ${end} = ${mx(edge)} (${FADE_PCT}% of it = ${mx(mark)})`,
        gold ? `This bar's close: ${px(price)} (no separate bid and ask)` : `${buy ? "Ask" : "Bid"} at this bar's close: ${px(price)}`,
      ].join("\n"),
      "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop.",
      "This is the only email: nothing more is sent about this signal. A later signal on the same chart and side is sent too, whatever came before it.",
      (gold
        ? "This email is judged and sent from 1 minute after the bar closes until the next bar closes, under 15 minutes after it (how long it takes to arrive has not been measured)."
        : "This email is judged and sent at the reads right after the bar closes and 1 and 3 minutes after (how long it takes to arrive has not been measured).") +
        " The price when it arrives may differ from the close above (the difference has not been measured). Bars that close in the weekend pause (Friday 21:00 to Sunday 22:00 UTC) are not judged.",
      gold
        ? "Not measured on gold (its bars are Twelve Data's, with no separate bid and ask). The numbers measured on the five pairs are in the app's settings notes."
        : fadeMeasuredLine("en", s.pair),
      `This rule is Sextant's own, not a published indicator. ${FADE_PCT}%, judging at the bar's close, judging the email on ${tf} bars, the MACD pane of the newest ${ZONE_BARS} ${tf} bars, the fade side and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's ${tf} chart's.`,
      `${gold
        ? "The bars are Twelve Data's (GMO Coin does not carry XAU/USD), as the app's chart draws them."
        : `The bars are the mid of GMO Coin's public bid and ask, as the app's chart draws them; the price above is the same ${tf} bar's bid or ask close.`} Check the latest state in the app before you place an order:\n${APP_URL}`,
      "To stop these emails, open Settings → Email alerts in the app and untick the chart under MACD fade (MACD ride until the screen is updated).\nThis is reference information, not investment advice. Every trading decision is your own.",
    ]);
  }
  const sideJ = `${buy ? "買い" : "売り"}（${s.side}）`;
  const end = top ? "上" : "下";
  return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${sideJ}: 青い線が${end}の端の${FADE_PCT}%で確定（MACD の逆張り）`, [
    `${pairJa(s.pair)}の${tf}で、MACD の逆張りの${sideJ}の合図が出ました。`,
    [
      `判定した足: ${clock(close, 9)}（日本時間）に確定した${tf}`,
      `この足の終わりで、青い線（MACD）が、新しい${ZONE_BARS}本（${tf}）の MACD の枠の${end}の端（青い線・オレンジの線・棒の${top ? "一番高い" : "一番低い"}所）の${FADE_PCT}%以上（0の線から測って）でした。一つ前の足の終わりでは、${FADE_PCT}%に届いていませんでした。${end}の端なので、逆張りの${sideJ}の合図です。`,
      `MACD = ${mx(f?.m ?? null)}、枠の${end}の端 = ${mx(edge)}（その${FADE_PCT}% = ${mx(mark)}）`,
      gold ? `この足の終値: ${px(price)}（売値・買値の別はありません）` : `${buy ? "買値" : "売値"}（この足の終値の${buy ? "買値" : "売値"}）: ${px(price)}`,
    ].join("\n"),
    "利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。",
    "メールはこの1通だけです。このあと、この合図について知らせは送りません。同じチャート・同じ向きに前の合図があっても、次の合図は送ります。",
    (gold
      ? "このメールは、足の確定の1分後から、次の足が確定するまで（確定から15分より前）の間に判定して送ります（実際に何分で届くかは測っていません）。"
      : "このメールは、足の確定の直後・1分後・3分後の読み込みで判定して送ります（実際に何分で届くかは測っていません）。") +
      "届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。週末の止まっている時間（日本時間 土曜6:00〜月曜7:00）に確定した足は判定しません。",
    gold
      ? "金では測っていません（足は Twelve Data のもので、売値・買値の別はありません）。5ペアで測った数字は、アプリの設定の注にあります。"
      : fadeMeasuredLine("ja", s.pair),
    `この決まりは Sextant 独自のもので、公開されているインジケーターではありません。${FADE_PCT}%・足の確定で判定すること・メールを${tf}で判定すること・MACD の枠を${tf}の新しい${ZONE_BARS}本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの${tf}のチャートの枠と同じです。`,
    `${gold
      ? `足は Twelve Data のもの（${pairJa(s.pair)}は GMOコインにないため）で、アプリのチャートと同じです。`
      : `足は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じです。上の値段は、同じ${tf}の売値・買値の終値です。`}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」の「MACD の逆張り」（画面が新しくなる前は「MACD の流れ」）でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
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
  // v40: the MACD fade's one email (the MACD email from v40; docs §8.155). (#397: v39's ride's three mails before it)
  if (s.rule === "macdx") return renderFadeMail(s, lang);
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
