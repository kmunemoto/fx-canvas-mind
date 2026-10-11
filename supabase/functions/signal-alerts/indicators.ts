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
import { pineAtr } from "../_shared/pine.ts";
// #211: the Japanese emails name the pair as 楽天FX does (ユーロ/円)
import { pairJa } from "../_shared/pair-names.ts";
import { CHART_BARS, LIVE_PAIRS, LIVE_STEP_MS, isGold, isTwelvePair } from "../live-chart/logic.ts";
import { GMO_SYMBOLS } from "../track-outcomes/quotes.ts";
import { APP_URL, assemble, clock, tfLabel, type Lang, type Mail } from "./logic.ts";

export const INDICATOR_RULES = ["qtrend", "ultra", "macdx"] as const;
export type IndicatorRule = (typeof INDICATOR_RULES)[number];
export const isIndicatorRule = (v: unknown): v is IndicatorRule => v === "qtrend" || v === "ultra" || v === "macdx";
// #275: the rules judged on the chart's own bars the way Q-Trend and ULTRA are
// (the measured figures below are kept for these; the MACD rule's are its own)
export type ChartRule = Exclude<IndicatorRule, "macdx">;
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
export const MACDX_RULE_ID =
  `macdx_${MACD_DEFAULTS.fast}_${MACD_DEFAULTS.slow}_${MACD_DEFAULTS.signal}_w${MACDX_WINDOW}_n${MACDX_N_TR}_k4_2_v1`;
export const indicatorRuleId = (rule: IndicatorRule): string =>
  rule === "qtrend" ? QTREND_RULE_ID : rule === "macdx" ? MACDX_RULE_ID : ULTRA_RULE_ID;

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
export const MACDX_INTERVALS = ["5min"] as const;
export const MACDX_PAIRS: readonly string[] = INDICATOR_PAIRS.filter((p) => isGmoChartPair(p) && !isGold(p));
export const isMacdxChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && MACDX_PAIRS.includes(pair) &&
  (MACDX_INTERVALS as readonly string[]).includes(interval) && isIndicatorChart(pair, interval);
// Whether a chart can be followed under a rule
export const isIndicatorChartFor = (rule: unknown, pair: unknown, interval: unknown): boolean =>
  rule === "macdx" ? isMacdxChart(pair, interval) : isIndicatorChart(pair, interval);

// ULTRA's numbers are dollars on gold, pips on a currency pair (the chart's
// `isGoldPair(pair) ? 1 : pipSize(pair)`)
export const ultraUnit = (pair: string): number => (isGold(pair) ? 1 : pair.toUpperCase().includes("JPY") ? 0.01 : 0.0001);

// A signal is mailed while its bar closed at most this long ago: a missed
// run is covered by the next, and past this the price has moved on. The
// hourly and slower ones wait longer: those read from Twelve Data are read
// a few a minute (TWELVE_READS_PER_RUN), up to 48 at midnight UTC (#175:
// 18, six of them on three timeframes; #180: 21, seven).
export const freshFor = (interval: string): number =>
  interval === "5min" ? 10 * 60_000 : interval === "15min" ? 20 * 60_000 : 30 * 60_000;

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
  // stop and three targets
  rsi: number | null;
  rsiPrev: number | null;
  sl: number | null;
  tps: [number, number, number] | null;
  // #275: the MACD rule's numbers at the bar (absent on the other rules')
  macd?: MacdxFacts | null;
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
// followed these, docs §8.109 測り方).
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
  const g = s.rule === "macdx" ? undefined : GOLD_MEASURED[s.rule][s.interval];
  const even = breakEvenPct(true);
  if (lang === "en") {
    if (!g) return "This timeframe has not been measured.";
    return `Measured on past ${tfLabel("en", s.interval)} bars (January 2024–September 2026, Dukascopy's gold prices cut into bars as Twelve Data's, spread paid), these levels reached TP1 before the stop ${g.win.toFixed(1)}% of the time (breaking even needs more than ${even}%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) ${g.usd < 0 ? "lost" : "made"} about $${Math.abs(g.usd).toFixed(2)} a trade on average.`;
  }
  if (!g) return "この時間足は測っていません。";
  return `過去の${tfLabel("ja", s.interval)}（2024年1月〜2026年9月、Dukascopy の金の値を Twelve Data と同じ区切りの足にしたもの、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは ${g.win.toFixed(1)}%（損益ゼロには${even}%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約${Math.abs(g.usd).toFixed(2)}ドルの${g.usd < 0 ? "負け" : "勝ち"}でした。`;
};
// #275: the MACD peak-and-valley rule's own figures (docs §8.109,
// research/macdx.ts; the "Research MACD extreme crosses" workflow): GMO's
// bars, 2024-01-01 to 2026-10-08 (the signals up to 2026-10-09 00:00 UTC),
// each signal entered at its bar's close on the side it fills on (spread
// paid) and followed on 5-minute bid/ask, the stop 13 and TP1 4 (the same as
// ULTRA's, the rule has none of its own), all of it closed at TP1 or the
// stop, or after five trading days where neither was reached. `five`: the
// emails' five pairs (31,624 signals; run 38068838023); `ref`: the 21 GMO
// pairs of the reference run (94,819; run 38070630317). `ultraWin`,
// `ultraPips`: the ULTRA 5-minute signals over the same pairs and period. The
// rule was not shown to be better than ULTRA (d = -0.10 pips a trade, 95%
// interval -0.24 to 0.04, on the five).
export const MACDX_MEASURED = {
  five: ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as readonly string[],
  fiveFigures: { win: 72.3, pips: -1.28, ultraWin: 72.9, ultraPips: -1.18 },
  refFigures: { win: 71.7, pips: -1.67, ultraWin: 71.9, ultraPips: -1.62 },
};
const macdxMeasuredLine = (s: IndicatorSignal, lang: Lang): string => {
  const five = MACDX_MEASURED.five.includes(s.pair);
  const m = five ? MACDX_MEASURED.fiveFigures : MACDX_MEASURED.refFigures;
  const even = breakEvenPct(false);
  const loss = (v: number) => Math.abs(v).toFixed(2);
  if (lang === "en") {
    return `Measured on past ${tfLabel("en", s.interval)} bars (January 2024–8 October 2026, GMO's ${five ? `five pairs (${MACDX_MEASURED.five.join(", ")})` : "21 pairs, measured as a reference"}, spread paid), these levels reached TP1 before the stop ${m.win.toFixed(1)}% of the time (breaking even needs more than ${even}%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) ${m.pips < 0 ? "lost" : "made"} about ${loss(m.pips)} pips a trade on average. ULTRA's ${tfLabel("en", s.interval)} signals over the same period: ${m.ultraWin.toFixed(1)}% and about ${loss(m.ultraPips)} pips ${m.ultraPips < 0 ? "lost" : "made"} a trade; this rule was not shown to be better than ULTRA.` +
      (five ? "" : ` ${s.pair} itself was not the main subject of the measurement; these are the 21 pairs' figures.`);
  }
  return `過去の${tfLabel("ja", s.interval)}（2024年1月〜2026年10月8日、GMO の${five ? `5ペア（${MACDX_MEASURED.five.map(pairJa).join("・")}）` : "21ペア（参考として測ったもの）"}、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは ${m.win.toFixed(1)}%（損益ゼロには${even}%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約${loss(m.pips)} pips の${m.pips < 0 ? "負け" : "勝ち"}でした。同じ期間の ULTRA の${tfLabel("ja", s.interval)}は ${m.ultraWin.toFixed(1)}%・1回あたり約${loss(m.ultraPips)} pips の${m.ultraPips < 0 ? "負け" : "勝ち"}で、この決まりのほうが良いとは言えませんでした。` +
    (five ? "" : `${pairJa(s.pair)}そのものを主に測ったわけではありません（上の数字は21ペア全体のものです）。`);
};
const measuredLine = (s: IndicatorSignal, lang: Lang): string => {
  if (s.rule === "macdx") return macdxMeasuredLine(s, lang);
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

export const renderIndicatorMail = (s: IndicatorSignal, lang: Lang): Mail => {
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
  if (lang === "en") {
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
    if (s.rule === "macdx") {
      const f = s.macd;
      const buy = s.side === "BUY";
      return assemble(`[Sextant] ${s.pair} ${tf} ${side} signal (MACD peak/valley)`, [
        `A MACD peak/valley ${side} signal fired on ${s.pair}, ${tf} chart.`,
        [
          `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
          `MACD(12, 26, 9): the MACD line (blue) crossed ${buy ? "above" : "below"} its signal line (orange), ${buy ? "near a valley" : "near a peak"}`,
          ...(f
            ? [
              `  MACD = ${px(f.m)}, ${(f.x / unit).toFixed(1)} pips from zero on the ${buy ? "negative" : "positive"} side`,
              `  Far from zero: ${(f.x / f.avgRange).toFixed(2)} × the mean range of the last 24 hours (288 bars); the rule needs at least 0.25`,
              `  Near the wave's extreme: ${(100 * f.x / f.peak).toFixed(0)}% of the current wave's peak; the rule needs at least 50%`,
            ]
            : []),
        ].join("\n"),
        [
          "Stop and targets (ULTRA's numbers):",
          `  Entry ≈ ${px(s.close)}`,
          `  Stop ${px(s.sl)} (${s.sl === null ? "—" : dist(s.sl)})`,
          ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
        ].join("\n"),
        `This is Sextant's own rule, not a published indicator (docs §8.109): of the MACD(12, 26, 9) crosses it mails only those that happen on the far side of zero (a SELL above zero, a BUY below it), at least a quarter of the mean range away from zero, and before MACD has come back past half of the wave's peak. It has no stop or target of its own, so these are ULTRA's numbers. ${measuredLine(s, "en")}`,
        `${source} Check the latest state in the app before you place an order:\n${APP_URL}`,
        "To stop these emails, open Settings → Email alerts in the app and untick the chart under MACD peak/valley.\nThis is reference information, not investment advice. Every trading decision is your own.",
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
  if (s.rule === "macdx") {
    const f = s.macd;
    const buy = s.side === "BUY";
    const sideM = `${buy ? "買い" : "売り"}（${s.side}）`;
    return assemble(`【Sextant】${pairJa(s.pair)} ${tf} ${sideM}のサイン（MACD の山・谷）`, [
      `${pairJa(s.pair)}の${tf}で、MACD の山・谷のクロスの${sideM}のサインが出ました。`,
      [
        `判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`,
        `MACD(12・26・9)の青線がオレンジ線を${buy ? "下から上に" : "上から下に"}抜けました（${buy ? "谷" : "山"}の近く）`,
        ...(f
          ? [
            `  MACD = ${px(f.m)}（0の${buy ? "下" : "上"}、0から ${(f.x / unit).toFixed(1)}pips 離れています）`,
            `  0から遠い: 直近24時間（288本）の平均の値幅の ${(f.x / f.avgRange).toFixed(2)} 倍（0.25 倍以上が条件）`,
            `  波の頂点に近い: 今の波の頂点の ${(100 * f.x / f.peak).toFixed(0)}%（50%以上が条件）`,
          ]
          : []),
      ].join("\n"),
      [
        "損切り・利確の目安（ULTRA と同じ数字）:",
        `  エントリー ≈ ${px(s.close)}`,
        `  損切り ${px(s.sl)}（${s.sl === null ? "—" : dist(s.sl)}）`,
        ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
      ].join("\n"),
      `この決まりは Sextant 独自のもので、公開されているインジケーターではありません（docs §8.109）。MACD(12・26・9)のクロスのうち、売りは0より上・買いは0より下で、0から直近24時間の平均の値幅の4分の1以上離れていて、MACD が今の波の頂点の半分より0に近づく前のものだけを送ります。損切り・利確の目安はもともとないため、ULTRA と同じ数字を付けています。${measuredLine(s, "ja")}`,
      `${source}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
      "この通知を止めるには、アプリの「設定」→「メール通知」の「MACD の山・谷」でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
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
