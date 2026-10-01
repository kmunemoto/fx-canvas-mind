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
import { pineAtr } from "../_shared/pine.ts";
import { CHART_BARS, LIVE_PAIRS, LIVE_STEP_MS, isGold, isTwelvePair } from "../live-chart/logic.ts";
import { GMO_SYMBOLS } from "../track-outcomes/quotes.ts";
import { APP_URL, assemble, clock, tfLabel, type Lang, type Mail } from "./logic.ts";

export const INDICATOR_RULES = ["qtrend", "ultra"] as const;
export type IndicatorRule = (typeof INDICATOR_RULES)[number];
export const isIndicatorRule = (v: unknown): v is IndicatorRule => v === "qtrend" || v === "ultra";
// The rule ids kept with each alert (signal_alerts.rule): the settings the
// signal was judged at. #166 left ULTRA's as it was (the video's, sl10): the
// signals do not depend on the stop, the id is part of the key that keeps a
// signal from being mailed twice, and each row keeps the stop it was mailed
// with (signal_alerts.stop; 30 pips on a currency pair since #166).
export const QTREND_RULE_ID = `qtrend_${QT_DEFAULTS.period}_${QT_DEFAULTS.atrPeriod}_${QT_DEFAULTS.mult}_v1`;
export const ULTRA_RULE_ID =
  `ultra_rsi${ULTRA_DEFAULTS.rsiLength}_${ULTRA_DEFAULTS.oversold}_${ULTRA_DEFAULTS.overbought}` +
  `_sl${ULTRA_DEFAULTS.sl}_tp${ULTRA_DEFAULTS.tp1}_${ULTRA_DEFAULTS.tp2}_${ULTRA_DEFAULTS.tp3}_v1`;
export const indicatorRuleId = (rule: IndicatorRule): string => (rule === "qtrend" ? QTREND_RULE_ID : ULTRA_RULE_ID);

// Every pair the live chart has, on these timeframes; those read from
// Twelve Data on 1 hour and up only
export const INDICATOR_PAIRS: readonly string[] = LIVE_PAIRS;
export const INDICATOR_INTERVALS = ["5min", "15min", "1h", "4h", "1day"] as const;
export const TWELVE_ALERT_INTERVALS = ["1h", "4h", "1day"] as const;
export const indicatorIntervalsFor = (pair: string): readonly string[] =>
  isTwelvePair(pair) ? TWELVE_ALERT_INTERVALS : INDICATOR_INTERVALS;
export const isIndicatorChart = (pair: unknown, interval: unknown): boolean =>
  typeof pair === "string" && typeof interval === "string" && INDICATOR_PAIRS.includes(pair) &&
  indicatorIntervalsFor(pair).includes(interval);
// Read from GMO (its free public bars), or from Twelve Data
export const isGmoChartPair = (pair: string): boolean => GMO_SYMBOLS[pair] !== undefined && !isTwelvePair(pair);

// ULTRA's numbers are dollars on gold, pips on a currency pair (the chart's
// `isGoldPair(pair) ? 1 : pipSize(pair)`)
export const ultraUnit = (pair: string): number => (isGold(pair) ? 1 : pair.toUpperCase().includes("JPY") ? 0.01 : 0.0001);

// A signal is mailed while its bar closed at most this long ago: a missed
// run is covered by the next, and past this the price has moved on. The
// hourly and slower ones wait longer: those read from Twelve Data are read
// a few a minute (TWELVE_READS_PER_RUN), up to 48 at midnight UTC (#175:
// 18, six of them on three timeframes).
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
  // #166: a currency pair's stop 30 pips; #168: gold's targets $30, $60 and
  // $90 (its stop the video's $10); #173: a currency pair's targets 20, 40
  // and 60 pips
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
// read cut short, or the market's weekend — the next pair is asked)
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
// targets (ULTRA's, the video's settings; #156: Q-Trend's the same numbers,
// the owner's choice), where the prices come from, and — as plainly as the
// other alerts — what these levels did on the email's own timeframe.

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
export const INDICATOR_MEASURED: Record<IndicatorRule, Record<string, { win: number; pips: number }>> = {
  qtrend: {
    "5min": { win: 58.0, pips: -2.03 },
    "15min": { win: 58.4, pips: -1.8 },
    "1h": { win: 59.2, pips: -1.33 },
    "4h": { win: 58.3, pips: -1.47 },
    "1day": { win: 55.1, pips: -6.92 },
  },
  ultra: {
    "5min": { win: 58.2, pips: -1.81 },
    "15min": { win: 58.0, pips: -1.79 },
    "1h": { win: 58.4, pips: -1.87 },
    "4h": { win: 60.1, pips: -0.54 },
    "1day": { win: 50.0, pips: -9.5 },
  },
};
// #168: gold's, at its levels since (TP1 $30, the stop $10): research/gold.ts
// on Dukascopy's gold, bid and ask, cut into bars as the app holds Twelve
// Data's (docs §8.79, §8.80; the "Study gold" run 36678229867), 2024-01-01
// to 2026-09-28, each signal the sweep would mail entered at its bar's close
// on the side it fills on and followed on 5-minute bid/ask, as the pairs'
// above. `usd`: dollars a trade.
export const GOLD_MEASURED: Record<IndicatorRule, Record<string, { win: number; usd: number }>> = {
  qtrend: {
    "5min": { win: 25.5, usd: -0.09 },
    "15min": { win: 25.6, usd: -0.01 },
    "1h": { win: 25.6, usd: -0.03 },
    "4h": { win: 27.2, usd: 0.59 },
    "1day": { win: 26.5, usd: 0.21 },
  },
  ultra: {
    "5min": { win: 22.8, usd: -1.14 },
    "15min": { win: 21.4, usd: -1.68 },
    "1h": { win: 23.9, usd: -0.74 },
    "4h": { win: 20.8, usd: -1.97 },
    "1day": { win: 15.4, usd: -4.45 },
  },
};

// the sentence saying so, on this email's timeframe. The share of TP1
// before the stop that breaks even, spread aside: the stop over the stop and
// TP1 (30 pips against 20: 60%, #173; gold's $10 against $30: 25%).
export const breakEvenPct = (gold: boolean): number => {
  const o = ultraParamsFor(gold);
  return Math.round((100 * o.sl) / (o.sl + o.tp1));
};
// #168: gold's, measured on Dukascopy's gold (GOLD_MEASURED)
const goldMeasuredLine = (s: IndicatorSignal, lang: Lang): string => {
  const g = GOLD_MEASURED[s.rule][s.interval];
  const even = breakEvenPct(true);
  if (lang === "en") {
    if (!g) return "This timeframe has not been measured.";
    return `Measured on past ${tfLabel("en", s.interval)} bars (January 2024–September 2026, Dukascopy's gold prices cut into bars as Twelve Data's, spread paid), these levels reached TP1 before the stop ${g.win.toFixed(1)}% of the time (breaking even needs more than ${even}%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) ${g.usd < 0 ? "lost" : "made"} about $${Math.abs(g.usd).toFixed(2)} a trade on average.`;
  }
  if (!g) return "この時間足は測っていません。";
  return `過去の${tfLabel("ja", s.interval)}（2024年1月〜2026年9月、Dukascopy の金の値を Twelve Data と同じ区切りの足にしたもの、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは ${g.win.toFixed(1)}%（損益ゼロには${even}%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約${Math.abs(g.usd).toFixed(2)}ドルの${g.usd < 0 ? "負け" : "勝ち"}でした。`;
};
const measuredLine = (s: IndicatorSignal, lang: Lang): string => {
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
    (unmeasured ? `${s.pair} そのものは測っていません（GMO の FX の値です）。` : "");
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
  // yen: 60 pips is 0.60) is no price, and is said to be none
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
    const cross = s.side === "BUY" ? "back above 30" : "back below 70";
    return assemble(`[Sextant] ${s.pair} ${tf} ${s.side === "BUY" ? "Buy ☆" : "Sell ☆"} signal (ULTRA)`, [
      `An ULTRA ${s.side === "BUY" ? "Buy ☆" : "Sell ☆"} signal fired on ${s.pair}, ${tf} chart.`,
      [
        `Bar: closed ${clock(closeMs, 0)} UTC (${clock(closeMs, 9)} JST)`,
        `RSI(14): ${r1(s.rsiPrev)} → ${r1(s.rsi)} (${cross})`,
      ].join("\n"),
      [
        gold ? "ULTRA's levels (the video's stop; the targets $30, $60 and $90):" : "ULTRA's levels (the targets 20, 40 and 60 pips; the stop 30 pips):",
        `  Entry ≈ ${px(s.close)}`,
        `  Stop ${px(s.sl)} (${s.sl === null ? "—" : dist(s.sl)})`,
        ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
      ].join("\n"),
      `ULTRA is built from F-INVEST's video (its code is not published). The video shows a 79–80% win rate (on gold), with a stop of 10.${gold ? " On gold this app sets the targets at $30, $60 and $90 (the video's are 5, 10 and 15), chosen after measuring them." : " On currency pairs this app sets the stop at 30 pips (from its own measurements) and the targets at 20, 40 and 60 pips (the video's are 5, 10 and 15)."} ${measuredLine(s, "en")}`,
      ...footer,
    ]);
  }
  // Q-Trend's STRONG in the same brackets: 買い（BUY・STRONG）
  const qtSide = `${s.side === "BUY" ? "買い" : "売り"}（${s.side}${s.strong ? "・STRONG" : ""}）`;
  const source = twelve
    ? `足は Twelve Data のもの（${s.pair} は GMOコインにないため）で、アプリのチャートと同じです。`
    : "価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ足で判定しています。";
  const footer = [
    `${source}注文の前にアプリで最新の状態を確認してください。\n${APP_URL}`,
    "この通知を止めるには、アプリの「設定」→「メール通知」の Q-Trend・ULTRA でチェックを外してください。\n本メールは参考情報であり、投資助言ではありません。取引の最終判断はご自身の責任で行ってください。",
  ];
  if (s.rule === "qtrend") {
    const how = s.side === "BUY" ? "上" : "下";
    return assemble(`【Sextant】${s.pair} ${tf} ${qtSide}のサイン（Q-Trend）`, [
      `${s.pair} の${tf}で、Q-Trend の${qtSide}のサインが出ました。`,
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
  return assemble(`【Sextant】${s.pair} ${tf} ${sideU}のサイン（ULTRA）`, [
    `${s.pair} の${tf}で、ULTRA の${sideU}のサインが出ました。`,
    [`判定した足: ${clock(closeMs, 9)}（日本時間）に確定した足`, `RSI(14): ${r1(s.rsiPrev)} → ${r1(s.rsi)}（${cross}）`].join("\n"),
    [
      gold ? "ULTRA の目安（損切りは動画の設定、利確は30・60・90ドル）:" : "ULTRA の目安（利確は20・40・60pips、損切りは30pips）:",
      `  エントリー ≈ ${px(s.close)}`,
      `  損切り ${px(s.sl)}（${s.sl === null ? "—" : dist(s.sl)}）`,
      ...(s.tps ?? []).map((v, k) => tpLine(k, v)),
    ].join("\n"),
    `ULTRA は F-INVEST の動画の設定と印から作ったものです（コードは公開されていません）。動画（金）の勝率は79〜80%で、損切りは10です。${gold ? "金では、このアプリで測ったうえで、利確を30・60・90ドルにしています（動画は5・10・15）。" : "FX では、損切りを30pips（このアプリで測った結果から）、利確を20・40・60pips（動画は5・10・15）にしています。"}${measuredLine(s, "ja")}`,
    ...footer,
  ]);
};
