// #162: the Stoch exit — a signal's trade taken off when Stoch's %K closes
// under 20 (a sell) or over 80 (a buy) — against the email's exit now (all at
// TP1, 5 pips), in pips. The owner (2026-09-29), after #161 (the signals the
// owner's reading calls good could not be told apart at the signal), offered
// this other use of the same reading, answered 「測ってみて」.
//
// THE MEASURE, fixed before any data was read:
//   * the signals: the emails' own (Q-Trend's BUY/SELL and its STRONG ones,
//     ULTRA's Buy/Sell; one trade a bar and side for the two together), as
//     #159/#161: GMO's pairs, 4-hour bars, 2024-01-01 on, only those the
//     sweep mails; and every close either way (the coin), as a yardstick.
//   * both trades enter at the signal bar's close (a buy at the ask, a sell
//     at the bid: the spread is paid) with the email's stop, 10 pips from the
//     bar's mid close, followed on 5-minute bid/ask (a buy sold at the bid, a
//     sell bought back at the ask; a 5-minute bar opening past a level goes
//     out at that open).
//   * now: out at TP1 (5 pips from the mid close) or the stop; a 5-minute bar
//     reaching both counts the stop (as every record in this app).
//   * Stoch: out at the stop, or at the close of the first 4-hour bar whose
//     %K (14, 1, 3) is under 20 (a sell) / over 80 (a buy) — the close's
//     bid/ask, as the sweep would read the bar a few minutes on. A stop inside
//     that bar came first.
//   * either: still in after 30 four-hour bars (five days), out at that close.
//   * told for each (first half, second half; each rule and side): pips per
//     trade with its 95% interval (cluster-robust by week), how many won,
//     the average win and loss, how each went out; and per signal the Stoch
//     exit less the exit now, with its interval.
//   * beyond the coin: the signals' difference (Stoch less now) less the
//     same difference for every close either way (the same side), with an
//     interval taking the two as independent. How a level is filled moves
//     both alike: on random walks (12 pairs each) the difference itself came
//     out −0.67 and −0.17 pips (the walk's 5-minute bars with wicks) or +0.56
//     to +1.30 (without them: a 5-minute step jumps past a level that is
//     then filled at the level), while beyond the coin it was −0.50 to +0.77.
//     On both walks with wicks the call below came out "not clearly better".
//     Told, not what the call below rests on (it was fixed before this was
//     seen).
//   * called clearly better, before any data was read: for the emails' signals
//     (either), the Stoch exit's pips per trade over now's on both halves, and
//     the low end of the difference over 0 on the second. Whether it goes in
//     is the owner's to decide on the numbers.
//
// THE RESULT (2026-09-29, docs §8.74): not clearly better — worse. The
// emails' signals, GMO's 14 pairs with the history, 4-hour bars: now −1.28
// and −1.06 pips a trade (first, second half; 60% and 61% won), the Stoch
// exit −2.44 and −1.66 (24% and 27% won, the average win about +21 pips);
// the difference −1.16 (−2.22 to −0.11) and −0.60 (−1.51 to +0.30). Every
// close either way came out the same under both (−1.66 and −1.62, −1.47 and
// −1.59).

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure, isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { STOCH_DEFAULTS, stochastic } from "../supabase/functions/_shared/stochastic.ts";
import { indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, GMO_STUDY_PAIRS, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, clusterRate, iso } from "./lib.ts";

const TFS = ["5min", "15min", "1h", "4h", "1day"] as const;
type Tf = (typeof TFS)[number];
// #175: the 21 pairs measured before the app kept the yen pairs only
const ALL_PAIRS = GMO_STUDY_PAIRS;
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const SYNTHETIC = Boolean(Deno.env.get("SYNTHETIC"));
const CACHE = "research/.cache";
const OUT = "research/out";
const FINE = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
const KS = [1, 2, 3] as const;
// how far before START each timeframe is read, for the window of the first
// bar judged (600 bars: two days of 5-minute bars, a week of 15-minute, five
// weeks of hourly); the 4-hour and daily ones by their year files
const LEAD_DAYS: Record<Tf, number> = { "5min": 5, "15min": 12, "1h": 45, "4h": 0, "1day": 0 };
// a sample of every n-th bar for the blind entries (hashed, so no hour of
// the day is favoured), about the same number on each timeframe
const BLIND_EVERY: Record<Tf, number> = { "5min": 100, "15min": 33, "1h": 8, "4h": 2, "1day": 1 };
// when the sweep reads each chart, minutes after its close (signal-alerts
// indicators.ts gmoIntervalsDue): a signal is mailed if one of them falls
// while the market is open
const READ_AFTER: Record<Tf, number[]> = { "5min": [1, 3], "15min": [1, 3], "1h": [3, 5], "4h": [4, 6], "1day": [4, 6] };
const mailed = (tf: Tf, closeMs: number): boolean => READ_AFTER[tf].some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// bars checked against indicatorSignals, about 300 a pair on each
const CHECK_EVERY: Record<Tf, number> = { "5min": 661, "15min": 223, "1h": 53, "4h": 13, "1day": 3 };

// ---- GMO's files ---------------------------------------------------------------------

const getJson = async (url: string): Promise<{ status: number; body: unknown }> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { status: 404, body: null };
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        continue;
      }
      return { status: r.status, body: await r.json() };
    } catch {
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  return { status: 0, body: null };
};

// GMO's answer with its bars (a day without any, a weekend's, is an empty
// list), or the 404 of a day it has no file for
const sound = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; data?: unknown };
  return (b.status === 0 || b.status === 404) && Array.isArray(b.data);
};

interface Loaded {
  quotes: QuoteCandle[];
  requests: number;
  cached: number;
  failed: number;
}

// a seeded random walk on 5 minutes (mulberry32, as research/gmo.ts), the
// other timeframes built from it: on it every timeframe must come out at the
// spread's cost, no better
const synthetic5 = (pair: string, fromMs: number): QuoteCandle[] => {
  let seed = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const jpy = pair.includes("JPY");
  const scale = jpy ? 0.07 : 0.0007;
  const wick = jpy ? 0.02 : 0.0002;
  const spread = jpy ? 0.004 : 0.00004;
  const bars: QuoteCandle[] = [];
  let px = jpy ? 150 : 1.2;
  for (let ms = Math.floor(fromMs / FINE) * FINE; ms + FINE <= NOW; ms += FINE) {
    if (isMarketClosed(ms)) continue;
    const o = px;
    px = o + (rnd() - 0.5) * scale;
    const h = Math.max(o, px) + rnd() * wick;
    const l = Math.min(o, px) - rnd() * wick;
    // stamped as GMO's are once parsed (quotes.ts parseKlines)
    const dt = new Date(ms).toISOString();
    const bid = { datetime: dt, open: o, high: h, low: l, close: px };
    bars.push({ datetime: dt, bid, ask: { ...bid, open: o + spread, high: h + spread, low: l + spread, close: px + spread } });
  }
  return bars;
};
const syntheticCache = new Map<string, QuoteCandle[]>();

const load = async (pair: string, tf: Tf, fromMs: number): Promise<Loaded> => {
  const step = LIVE_STEP_MS[tf];
  if (SYNTHETIC) {
    let fine = syntheticCache.get(pair);
    if (!fine) {
      fine = synthetic5(pair, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1));
      syntheticCache.set(pair, fine);
    }
    // GMO's 4-hour and daily bars start at its trading day's roll (21:00 UTC
    // in summer); the walk's are put there too
    const offset = tf === "4h" || tf === "1day" ? 21 * HOUR : 0;
    const quotes = tf === "5min"
      ? fine
      : aggregate(fine, step, offset, NOW)
        .filter((q) => !barInsideClosure(barOpenMs(q.datetime), step))
        .map((q) => {
          const dt = new Date(barOpenMs(q.datetime)).toISOString();
          return { datetime: dt, bid: { ...q.bid, datetime: dt }, ask: { ...q.ask, datetime: dt } };
        });
    return { quotes: quotes.filter((q) => barOpenMs(q.datetime) >= fromMs), requests: 0, cached: 0, failed: 0 };
  }
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[tf];
  if (!symbol || !spec) throw new Error(`no GMO file for ${pair} ${tf}`);
  let keys: string[];
  let fresh: Set<string>;
  if (spec.key === "day") {
    const today = jstDayKey(NOW);
    keys = dateKeys(fromMs, NOW, "day").filter((k) => k <= today);
    fresh = new Set(keys.slice(-3));
  } else {
    // a year's file grows until the year ends: read every one again
    keys = [];
    for (let y = Number(jstYearKey(fromMs)); y <= Number(jstYearKey(NOW)); y++) keys.push(String(y));
    fresh = new Set(keys);
  }
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: typeof bid = [];
  let requests = 0;
  let cached = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      for (const side of ["bid", "ask"] as const) {
        const path = `${CACHE}/${symbol}/${spec.name}/${side}/${key}.json`;
        let body: unknown;
        if (!fresh.has(key)) {
          try {
            body = JSON.parse(await Deno.readTextFile(path));
          } catch {
            body = undefined;
          }
          // a file kept by another study with an error in it is read again
          if (body !== undefined && !sound(body)) body = undefined;
        }
        if (body === undefined) {
          const r = await getJson(klineUrl(symbol, side, spec.name, key));
          requests++;
          body = r.status === 404 ? { status: 404, data: [] } : r.body;
          if (r.status === 0 || !sound(body)) {
            failed++;
            continue;
          }
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await Deno.writeTextFile(path, JSON.stringify(body));
        } else {
          cached++;
        }
        (side === "bid" ? bid : ask).push(...parseKlines(body));
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  // the bars the sweep keeps (quotes.ts usableBars; #182: a bar is thrown
  // away only when the market was shut for all of it), closed by now
  const quotes = mergeSides(bid, ask)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && t >= fromMs && !barInsideClosure(t, step) && t + step <= NOW;
    });
  return { quotes, requests, cached, failed };
};

// ---- the 5-minute bars trades are followed on ------------------------------------------

interface Fine {
  n: number;
  t: Float64Array;
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
}
const toFine = (qs: QuoteCandle[]): Fine => {
  const n = qs.length;
  const f: Fine = { n, t: new Float64Array(n), bo: new Float64Array(n), bh: new Float64Array(n), bl: new Float64Array(n), bc: new Float64Array(n), ao: new Float64Array(n), ah: new Float64Array(n), al: new Float64Array(n), ac: new Float64Array(n) };
  qs.forEach((q, i) => {
    f.t[i] = barOpenMs(q.datetime);
    f.bo[i] = q.bid.open;
    f.bh[i] = q.bid.high;
    f.bl[i] = q.bid.low;
    f.bc[i] = q.bid.close;
    f.ao[i] = q.ask.open;
    f.ah[i] = q.ask.high;
    f.al[i] = q.ask.low;
    f.ac[i] = q.ask.close;
  });
  return f;
};
// the first index at or after `ms`
const lowerBound = (xs: ArrayLike<number>, ms: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < ms) lo = m + 1;
    else hi = m;
  }
  return lo;
};

type Side = "BUY" | "SELL";


// ---- the trades ----------------------------------------------------------------------

const TF: Tf = "4h";
// how long a trade is followed: 30 four-hour bars (five days)
const MAX_BARS = 30;
const RULES = ["now", "stoch"] as const;
type Rule = (typeof RULES)[number];
type Exit = "tp" | "sl" | "amb" | "stoch" | "time";
interface Trade {
  pips: number;
  exit: Exit;
  bars: number;
}

// per group and half: the trades' pips, and per week for the interval
interface Agg {
  n: number;
  sum: number;
  wins: number;
  winSum: number;
  lossSum: number;
  bars: number;
  exits: Record<Exit, number>;
  weeks: Map<number, { n: number; s: number }>;
}
const newAgg = (): Agg => ({ n: 0, sum: 0, wins: 0, winSum: 0, lossSum: 0, bars: 0, exits: { tp: 0, sl: 0, amb: 0, stoch: 0, time: 0 }, weeks: new Map() });
const addTo = (a: Agg, week: number, pips: number, exit?: Exit, bars = 0) => {
  a.n++;
  a.sum += pips;
  a.bars += bars;
  if (pips > 0) {
    a.wins++;
    a.winSum += pips;
  } else a.lossSum += pips;
  if (exit) a.exits[exit]++;
  const w = a.weeks.get(week) ?? { n: 0, s: 0 };
  w.n++;
  w.s += pips;
  a.weeks.set(week, w);
};
// the mean and its 95% interval, cluster-robust by week
const meanOf = (a: Agg) => {
  if (a.n === 0) return { m: null as number | null, lo: null as number | null, hi: null as number | null };
  const m = a.sum / a.n;
  const C = a.weeks.size;
  let s = 0;
  for (const g of a.weeks.values()) s += (g.s - m * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / a.n : Number.NaN;
  return { m, lo: Number.isFinite(se) ? m - 1.96 * se : null, hi: Number.isFinite(se) ? m + 1.96 * se : null };
};
// group → [first half, second half] of: now, stoch, the difference
const groups = new Map<string, Array<Record<Rule | "diff", Agg>>>();
const groupOf = (key: string) => {
  let g = groups.get(key);
  if (!g) {
    g = [0, 1].map(() => ({ now: newAgg(), stoch: newAgg(), diff: newAgg() }));
    groups.set(key, g);
  }
  return g;
};

interface Cover {
  pair: string;
  bars: number;
  judged: number;
  signals: number;
  trades: number;
  failed: number;
}
const coverage: Cover[] = [];
const check = { compared: 0, mismatched: 0, examples: [] as string[] };
const kCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
const nz = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? Number.NaN : v);

for (const pair of PAIRS) {
  const unit = ultraUnit(pair);
  const fineGot = await load(pair, "5min", START_MS - LEAD_DAYS["5min"] * DAY);
  const fine = toFine(fineGot.quotes);
  const step = LIVE_STEP_MS[TF];
  const got = await load(pair, TF, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) - 9 * HOUR);
  const candles = historyRead(pair, TF, got.quotes, NOW).candles;
  const byOpen = new Map(got.quotes.map((q) => [barOpenMs(q.datetime), q]));
  const n = candles.length;
  const times = new Float64Array(n);
  candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
  const qs = Array.from(times, (t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);

  // the sweep's window and start, as #157's
  const anchorOf = (i: number): { ws: number; s: number } | null => {
    if (i < WINDOW - 1) return null;
    const ws = i - WINDOW + 1;
    const w = times.subarray(ws, i + 1) as unknown as number[];
    const last = i - ws;
    const firstShown = Math.max(0, last - (CHART_BARS - 1));
    return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
  };

  // Stoch's %K on every bar (checked against the chart's window below)
  const kAll = stochastic(candles, STOCH_DEFAULTS).k;
  const judgedBar = new Uint8Array(n);
  const signals: Array<{ i: number; rule: "qtrend" | "ultra"; side: Side; strong: boolean }> = [];
  let seg: { s: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!seg) return;
    const bars = candles.slice(seg.s, seg.to + 1);
    const qt = qTrend(bars, QT_DEFAULTS, bars.length - 1);
    for (const x of qt.signals) {
      const at = seg.s + x.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "qtrend", side: x.side, strong: x.strong });
    }
    const ul = ultra(bars, bars.length - 1, unit);
    for (const tr of ul.trades) {
      const at = seg.s + tr.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "ultra", side: tr.side, strong: false });
    }
    // %K as the chart's window reads it, against the whole history's
    const k = stochastic(bars, STOCH_DEFAULTS).k;
    for (let at = seg.from; at <= seg.to; at++) {
      const v = nz(k[at - seg.s]);
      if (Number.isNaN(v)) continue;
      kCheck.compared++;
      if (v !== nz(kAll[at])) {
        kCheck.mismatched++;
        if (kCheck.examples.length < 10) kCheck.examples.push(`${pair} ${iso(times[at])} ${v}/${kAll[at]}`);
      }
    }
    seg = null;
  };
  const i0 = lowerBound(times, START_MS - step);
  let judged = 0;
  for (let i = Math.max(0, i0); i < n; i++) {
    if (times[i] + step < START_MS) continue;
    const a = anchorOf(i);
    if (!a) {
      flush();
      continue;
    }
    judged++;
    judgedBar[i] = 1;
    if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
    else {
      flush();
      seg = { s: a.s, from: i, to: i };
    }
  }
  flush();

  // the check: the signals against the emails' own function
  const mine = new Map<number, string[]>();
  for (const s of signals) mine.set(s.i, [...(mine.get(s.i) ?? []), `${s.rule}:${s.side}:${s.strong ? "S" : "-"}`]);
  for (let i = 0; i < n; i += CHECK_EVERY[TF]) {
    if (!judgedBar[i]) continue;
    const a = anchorOf(i)!;
    const theirs = indicatorSignals(pair, TF, candles.slice(a.ws, i + 1), times[i] + step + 60_000, 120_000)
      .filter((x) => Date.parse(x.barTime) === times[i])
      .map((x) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`)
      .sort()
      .join(",");
    const ours = (mine.get(i) ?? []).sort().join(",");
    check.compared++;
    if (theirs !== ours) {
      check.mismatched++;
      if (check.examples.length < 10) check.examples.push(`${pair} ${iso(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
    }
  }

  // a trade entered at bar i's close, taken off by `rule`; null when not a
  // signal the sweep would mail, or when the data ends first
  const tradeAt = (i: number, side: Side, rule: Rule): Trade | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    const buy = side === "BUY";
    const lv = ultraLevels(side, candles[i].close, unit);
    const tp = lv.tps[0];
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const pipsOf = (exit: number) => (buy ? exit - fill : fill - exit) / unit;
    // the prices it goes out at: a buy's bid, a sell's ask
    const o = buy ? fine.bo : fine.ao;
    const h = buy ? fine.bh : fine.ah;
    const l = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    let f = lowerBound(fine.t, T);
    if (f >= fine.n) return null;
    for (let j = i + 1; j <= i + MAX_BARS; j++) {
      if (j >= n) return null;
      const end = times[j] + step;
      const bars = j - i;
      while (f < fine.n && fine.t[f] < end) {
        if (buy ? o[f] <= lv.sl : o[f] >= lv.sl) return { pips: pipsOf(o[f]), exit: "sl", bars };
        if (rule === "now" && (buy ? o[f] >= tp : o[f] <= tp)) return { pips: pipsOf(o[f]), exit: "tp", bars };
        const hitSl = buy ? l[f] <= lv.sl : h[f] >= lv.sl;
        const hitTp = rule === "now" && (buy ? h[f] >= tp : l[f] <= tp);
        if (hitSl && hitTp) return { pips: pipsOf(lv.sl), exit: "amb", bars };
        if (hitSl) return { pips: pipsOf(lv.sl), exit: "sl", bars };
        if (hitTp) return { pips: pipsOf(tp), exit: "tp", bars };
        f++;
      }
      if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
      if (f === 0) return null;
      // bar j's close, where it is taken off at the bar's close
      const closePx = c[f - 1];
      if (rule === "stoch") {
        const k = nz(kAll[j]);
        if (!Number.isNaN(k) && (buy ? k > 80 : k < 20)) return { pips: pipsOf(closePx), exit: "stoch", bars };
      }
      if (j === i + MAX_BARS) return { pips: pipsOf(closePx), exit: "time", bars };
    }
    return null;
  };
  const record = (keys: string[], half: 0 | 1, week: number, now: Trade, sto: Trade) => {
    for (const key of keys) {
      const g = groupOf(key)[half];
      addTo(g.now, week, now.pips, now.exit, now.bars);
      addTo(g.stoch, week, sto.pips, sto.exit, sto.bars);
      addTo(g.diff, week, sto.pips - now.pips);
    }
  };

  // the coin: every close either way
  for (let i = 0; i < n; i++) {
    for (const side of ["BUY", "SELL"] as const) {
      const a = tradeAt(i, side, "now");
      const b = tradeAt(i, side, "stoch");
      if (!a || !b) continue;
      const T = times[i] + step;
      record(["coin", `coin ${side}`], T < SPLIT_MS ? 0 : 1, weekOf(T), a, b);
    }
  }
  // the signals: each rule's, and the emails' together (one trade a bar and side)
  let trades = 0;
  const eitherSeen = new Set<string>();
  for (const sg of signals) {
    const a = tradeAt(sg.i, sg.side, "now");
    const b = tradeAt(sg.i, sg.side, "stoch");
    if (!a || !b) continue;
    const T = times[sg.i] + step;
    const keys = sg.rule === "qtrend" ? [`qtrend`, `qtrend ${sg.side}`, ...(sg.strong ? ["strong", `strong ${sg.side}`] : [])] : [`ultra`, `ultra ${sg.side}`];
    const ek = `${sg.i}:${sg.side}`;
    if (!eitherSeen.has(ek)) {
      eitherSeen.add(ek);
      keys.push("either", `either ${sg.side}`);
      trades++;
    }
    record(keys, T < SPLIT_MS ? 0 : 1, weekOf(T), a, b);
  }
  coverage.push({ pair, bars: n, judged, signals: signals.length, trades, failed: fineGot.failed + got.failed });
  console.log(`${pair} ${TF}: ${n} bars, judged ${judged}, signals ${signals.length} (trades ${trades}); GMO failed ${fineGot.failed + got.failed}`);
}

// ---- the report ------------------------------------------------------------------------

const num = (x: number | null, d = 2) => (x === null ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const checkLine = (what: string, c: { compared: number; mismatched: number; examples: string[] }) =>
  `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
const ruleLine = (label: string, a: Agg) => {
  const r = meanOf(a);
  const out = (Object.keys(a.exits) as Exit[]).filter((k) => a.exits[k] > 0).map((k) => `${k} ${a.exits[k]}`).join(" ");
  return `  ${label.padEnd(6)} ${num(r.m)} [${num(r.lo)},${num(r.hi)}] pips/trade of ${String(a.n).padStart(5)}; won ${((100 * a.wins) / Math.max(1, a.n)).toFixed(1)}%, avg win ${num(a.wins ? a.winSum / a.wins : null, 1)}, avg loss ${num(a.n - a.wins ? a.lossSum / (a.n - a.wins) : null, 1)}, bars ${(a.bars / Math.max(1, a.n)).toFixed(1)}; ${out}`;
};
console.log(`\n#162 the Stoch exit against the exit now on ${TF}, ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? " — SYNTHETIC" : ""}; stop 10 pips; now: TP1 5 pips; Stoch: %K under 20 (sell) / over 80 (buy) at a close; out after ${MAX_BARS} bars`);
console.log(checkLine("signals against indicatorSignals", check));
console.log(checkLine("%K on the whole history against the window's", kCheck));
console.log(`GMO reads that failed: ${coverage.reduce((a, c) => a + c.failed, 0)}`);
// the difference beyond the coin's (the same side), with an interval
// taking the two as independent
const beyondCoin = (key: string, half: 0 | 1) => {
  const side = key.endsWith("BUY") ? " BUY" : key.endsWith("SELL") ? " SELL" : "";
  const c = groups.get(`coin${side}`);
  const g = groups.get(key);
  if (!c || !g) return null;
  const a = meanOf(g[half].diff);
  const b = meanOf(c[half].diff);
  if (a.m === null || b.m === null || a.lo === null || b.lo === null || a.hi === null || b.hi === null) return null;
  const se = Math.sqrt(((a.hi - a.lo) / 3.92) ** 2 + ((b.hi - b.lo) / 3.92) ** 2);
  const m = a.m - b.m;
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se };
};
const ORDER = ["either", "either BUY", "either SELL", "qtrend", "qtrend BUY", "qtrend SELL", "strong", "strong BUY", "strong SELL", "ultra", "ultra BUY", "ultra SELL", "coin", "coin BUY", "coin SELL"];
for (const key of ORDER) {
  const g = groups.get(key);
  if (!g) continue;
  for (const half of [0, 1] as const) {
    const d = meanOf(g[half].diff);
    const bc = key.startsWith("coin") ? null : beyondCoin(key, half);
    console.log(`\n== ${key}, ${half === 0 ? "first" : "second"} half: Stoch − now ${num(d.m)} [${num(d.lo)},${num(d.hi)}] pips/trade${bc ? `; beyond the coin's ${num(bc.m)} [${num(bc.lo)},${num(bc.hi)}]` : ""}`);
    console.log(ruleLine("now", g[half].now));
    console.log(ruleLine("Stoch", g[half].stoch));
  }
}

// CLEARLY BETTER?
const e = groups.get("either");
let verdict = "no signals";
if (e) {
  const [f, s] = e;
  const better = (x: Record<Rule | "diff", Agg>) => (meanOf(x.stoch).m ?? -Infinity) > (meanOf(x.now).m ?? Infinity);
  const lo = meanOf(s.diff).lo;
  const clearly = better(f) && better(s) && lo !== null && lo > 0;
  verdict = clearly ? "the Stoch exit is clearly better for the emails' signals" : "the Stoch exit is not clearly better for the emails' signals";
  console.log(`\n== VERDICT: Stoch over now on the first half: ${better(f)}, on the second: ${better(s)}; the difference's low end on the second ${num(lo)} → ${verdict}`);
}

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/stochexit.json`, JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), synthetic: SYNTHETIC, coverage, check, kCheck, groups: Object.fromEntries([...groups].map(([k, g]) => [k, g.map((h) => ({ now: { ...meanOf(h.now), n: h.now.n, wins: h.now.wins, exits: h.now.exits }, stoch: { ...meanOf(h.stoch), n: h.stoch.n, wins: h.stoch.wins, exits: h.stoch.exits }, diff: meanOf(h.diff) }))])), verdict }, null, 1));
