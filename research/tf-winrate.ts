// #157: which timeframe's signals win most often. The owner (2026-09-29),
// receiving the Q-Trend and ULTRA emails on the 5-minute charts of the 21
// pairs GMO serves: 「売買のタイミングのメールを送る時、今は5分足ですが、
// 全体的に何分足の売買のタイミングが勝率が高いか判断してもらってその足で
// メールを送る様にしてください」.
//
// THE METHOD, fixed before any data was read:
//
//   * The signals are the emails' (signal-alerts, #155/#156): Q-Trend's BUY
//     and SELL (STRONG or not) and ULTRA's Buy and Sell, on each timeframe
//     the emails offer these pairs (5min, 15min, 1h, 4h, 1day). Each closed
//     bar is judged as the sweep judges it: GMO's bid/ask bars, mid, rounded
//     as the chart draws them (live-chart historyRead); the window the sweep
//     reads — the newest 600 closed bars, or on the daily chart this JST
//     year's file and last year's (signal-alerts/logic.ts fetchYearQuotes);
//     both indicators from anchoredStart; the signal on the newest bar kept.
//     Checked against indicatorSignals itself on a sample of bars and on a
//     share of the signals (reported). Only the signals the sweep mails: it
//     reads these charts 1 and 3 minutes after a 5- or 15-minute close, 3
//     and 5 after an hourly one, 4 and 6 after a 4-hour or daily one, and
//     does nothing while the market may be shut (isPossiblyClosed: from
//     Friday 21:00 UTC to Sunday 22:00) — a bar closing then is not mailed
//     (how many, reported).
//   * The levels are the email's own prices: the stop 10 pips and TP1..TP3
//     5, 10 and 15 pips from the email's entry (the bar's mid close, rounded;
//     ultraLevels). Entered at the signal bar's close on the side of the
//     book it fills on (BUY the ask, SELL the bid), followed on GMO's
//     5-minute bars from that close on the side it leaves on (BUY the bid,
//     SELL the ask). Out at TPk or the stop, whichever is reached first,
//     each k on its own; a 5-minute bar that reaches both counts as the stop
//     ("ambiguous"); a bar opening past a level fills at its open; still open
//     after MAX_HOLD 5-minute bars (five trading days), closed there ("open").
//     A signal whose five days run past the data is left out.
//   * A win: TP1 before the stop. The win rate: wins over the trades that
//     reached one or the other (ULTRA's table: TOTAL = TP1 + SL), its 95%
//     interval cluster-robust by calendar week. Also pips a trade (spread
//     paid, the open ones at their last price), TP2 and TP3, each half.
//   * THE CHOICE: the timeframe whose TP1 win rate is highest at the low
//     end of its 95% interval — the rate it can be said to reach at least —
//     both indicators' signals pooled as the emails send them, over the
//     whole period, entered at the close. Reported beside it and not used
//     to choose: the ranking by the rates themselves, whether the choice is
//     also first in each half and with the entry five minutes late (the
//     close of the next 5-minute bar; a trade whose level was already passed
//     by then is skipped), its margin over the next timeframe with that
//     difference's interval, pips a trade, and blind entries at that
//     timeframe's closes (both sides, a hashed sample of bars, the same
//     levels): what a coin would win at the same moments.
//     Changed after the synthetic runs, before any real data was read: the
//     first draft chose the highest rate itself, and on the random walk —
//     where every timeframe wins the same — it chose the daily chart both
//     times (83% of 30 trades, then 68% of 379 against 64–66%): the one with
//     the fewest signals and the widest interval, whose rate strays furthest
//     by chance. The low end does not reward that.

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { INDICATOR_PAIRS, indicatorIntervalsFor, indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, clusterRate, iso } from "./lib.ts";

const TFS = ["5min", "15min", "1h", "4h", "1day"] as const;
type Tf = (typeof TFS)[number];
const ALL_PAIRS = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).includes("5min"));
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
const MAX_HOLD = 5 * 288;
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
        .filter((q) => !isMarketClosed(barOpenMs(q.datetime)))
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
  // the bars the sweep keeps (quotes.ts usableBars), closed by now
  const quotes = mergeSides(bid, ask)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && t >= fromMs && !isMarketClosed(t) && t + step <= NOW;
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
type Kind = "tp" | "sl" | "amb" | "open";
// out at `tp` or `sl` from 5-minute bar `from` on; null when the data ends
// before MAX_HOLD bars
const follow = (f: Fine, from: number, side: Side, sl: number, tp: number): { kind: Kind; exit: number; bars: number } | null => {
  const last = from + MAX_HOLD - 1;
  if (from < 0 || last > f.n - 1) return null;
  const buy = side === "BUY";
  const o = buy ? f.bo : f.ao;
  const h = buy ? f.bh : f.ah;
  const l = buy ? f.bl : f.al;
  for (let j = from; j <= last; j++) {
    if (buy ? o[j] <= sl : o[j] >= sl) return { kind: "sl", exit: o[j], bars: j - from + 1 };
    if (buy ? o[j] >= tp : o[j] <= tp) return { kind: "tp", exit: o[j], bars: j - from + 1 };
    const hitTp = buy ? h[j] >= tp : l[j] <= tp;
    const hitSl = buy ? l[j] <= sl : h[j] >= sl;
    if (hitTp && hitSl) return { kind: "amb", exit: sl, bars: j - from + 1 };
    if (hitSl) return { kind: "sl", exit: sl, bars: j - from + 1 };
    if (hitTp) return { kind: "tp", exit: tp, bars: j - from + 1 };
  }
  return { kind: "open", exit: buy ? f.bc[last] : f.ac[last], bars: MAX_HOLD };
};

// ---- the records -----------------------------------------------------------------------

type Rule = "qtrend" | "ultra" | "blind";
type Entry = "close" | "late";
interface Rec {
  tf: Tf;
  rule: Rule;
  pair: string;
  // the signal bar's close
  t: number;
  side: Side;
  strong: boolean;
  entry: Entry;
  k: number;
  kind: Kind;
  pips: number;
  bars: number;
  hour: number;
  spread: number;
}
const recs: Rec[] = [];
const lateSkipped: Record<string, number> = {};

// a hashed sample of bars (murmur3's finaliser)
const mix = (a: number): number => {
  a ^= a >>> 16;
  a = Math.imul(a, 0x85ebca6b);
  a ^= a >>> 13;
  a = Math.imul(a, 0xc2b2ae35);
  a ^= a >>> 16;
  return a >>> 0;
};
const sampled = (pairIdx: number, t: number, every: number): boolean => every <= 1 || mix(mix(pairIdx * 7919 + 1) ^ Math.floor(t / MINUTE)) % every === 0;

// ---- each pair -------------------------------------------------------------------------

interface Cover {
  pair: string;
  tf: Tf;
  bars: number;
  first: string | null;
  last: string | null;
  judged: number;
  firstJudged: string | null;
  noWindow: number;
  // signals on bars that close while the sweep does not run (left out)
  unmailed: number;
  qtrend: number;
  strong: number;
  ultra: number;
  requests: number;
  cached: number;
  failed: number;
  // the timeframe's close against the 5-minute bar ending there (bid and ask)
  closeSame: number;
  closeDiffer: number;
  closeNoFine: number;
  openHours: Record<number, number>;
}
const coverage: Cover[] = [];
const check: Record<string, { compared: number; mismatched: number; examples: string[] }> = Object.fromEntries(TFS.map((tf) => [tf, { compared: 0, mismatched: 0, examples: [] }]));

for (const [pi, pair] of PAIRS.entries()) {
  const unit = ultraUnit(pair);
  const fineGot = await load(pair, "5min", START_MS - LEAD_DAYS["5min"] * DAY);
  const fine = toFine(fineGot.quotes);
  const eps = unit / 100;
  for (const tf of TFS) {
    const step = LIVE_STEP_MS[tf];
    const from = tf === "4h" || tf === "1day" ? Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) - 9 * HOUR : START_MS - LEAD_DAYS[tf] * DAY;
    const got = tf === "5min" ? fineGot : await load(pair, tf, from);
    // the chart's bars: mid, rounded as drawn, closed only
    const candles = historyRead(pair, tf, got.quotes, NOW).candles;
    const byOpen = new Map(got.quotes.map((q) => [barOpenMs(q.datetime), q]));
    const n = candles.length;
    const times = new Float64Array(n);
    candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
    const qs = Array.from(times, (t) => byOpen.get(t)!);
    if (qs.some((q) => !q)) throw new Error(`${pair} ${tf}: a chart bar without its quote`);

    // the window the sweep reads with bar i the newest, or null where the
    // data does not hold it
    const windowStart = (i: number): number | null => {
      if (tf !== "1day") return i >= WINDOW - 1 ? i - WINDOW + 1 : null;
      // this JST year's file and last year's, as of the sweep after the close
      const y = Number(jstYearKey(times[i] + step + 5 * MINUTE)) - 1;
      const yearStart = Date.UTC(y, 0, 1) - 9 * HOUR;
      if (n === 0 || times[0] > yearStart + 7 * DAY) return null;
      const s = lowerBound(times, yearStart);
      return i - s + 1 > WINDOW ? i - WINDOW + 1 : s;
    };
    // where the sweep starts both indicators with bar i the newest
    // (indicatorSignals: nothing judged on a window of `period` bars or fewer)
    const anchorOf = (i: number): { ws: number; s: number } | null => {
      const ws = windowStart(i);
      if (ws === null || i - ws + 1 <= QT_DEFAULTS.period) return null;
      const w = times.subarray(ws, i + 1) as unknown as number[];
      const last = i - ws;
      const firstShown = Math.max(0, last - (CHART_BARS - 1));
      return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
    };

    // the bars judged: closed at or after START
    const i0 = lowerBound(times, START_MS - step);
    const signals: Array<{ i: number; rule: "qtrend" | "ultra"; side: Side; strong: boolean }> = [];
    const sample = new Set<number>();
    let noWindow = 0;
    let judged = 0;
    let firstJudged: number | null = null;
    // Both indicators read only the bars up to each one, so one run from an
    // anchor gives every newest bar that anchor serves
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
      seg = null;
    };
    for (let i = Math.max(0, i0); i < n; i++) {
      if (times[i] + step < START_MS) continue;
      const a = anchorOf(i);
      if (!a) {
        noWindow++;
        flush();
        continue;
      }
      judged++;
      if (firstJudged === null) firstJudged = times[i];
      if (i % CHECK_EVERY[tf] === 0) sample.add(i);
      if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
      else {
        flush();
        seg = { s: a.s, from: i, to: i };
      }
    }
    flush();
    signals.sort((a, b) => a.i - b.i);

    // the check: the emails' own function on a sample of newest bars, and on
    // every 7th signal found (a sample of bars would miss most of them)
    const mine = new Map<number, typeof signals>();
    for (const s of signals) mine.set(s.i, [...(mine.get(s.i) ?? []), s]);
    const key = (x: { rule: string; side: string; strong: boolean }) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`;
    const probe = (i: number) => {
      const a = anchorOf(i);
      if (!a) return;
      const theirs = indicatorSignals(pair, tf, candles.slice(a.ws, i + 1), times[i] + step + 60_000, 120_000)
        .filter((x) => Date.parse(x.barTime) === times[i])
        .map(key)
        .sort()
        .join(",");
      const ours = (mine.get(i) ?? []).map(key).sort().join(",");
      const c = check[tf];
      c.compared++;
      if (theirs !== ours) {
        c.mismatched++;
        if (c.examples.length < 10) c.examples.push(`${pair} ${iso(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
      }
    };
    for (const i of sample) probe(i);
    signals.forEach((s, k) => {
      if (k % 7 === 0) probe(s.i);
    });

    // the entries: the signals mailed
    const sent = signals.filter((s) => mailed(tf, times[s.i] + step));
    const cover: Cover = {
      pair,
      tf,
      bars: n,
      first: n ? iso(times[0]) : null,
      last: n ? iso(times[n - 1]) : null,
      judged,
      firstJudged: firstJudged === null ? null : iso(firstJudged),
      noWindow,
      unmailed: signals.length - sent.length,
      qtrend: sent.filter((s) => s.rule === "qtrend").length,
      strong: sent.filter((s) => s.rule === "qtrend" && s.strong).length,
      ultra: sent.filter((s) => s.rule === "ultra").length,
      requests: got.requests,
      cached: got.cached,
      failed: got.failed,
      closeSame: 0,
      closeDiffer: 0,
      closeNoFine: 0,
      openHours: {},
    };
    for (let i = 0; i < n; i++) {
      const h = new Date(times[i]).getUTCHours();
      cover.openHours[h] = (cover.openHours[h] ?? 0) + 1;
    }
    const enter = (i: number, rule: Rule, side: Side, strong: boolean, ks: readonly number[], late: boolean) => {
      const T = times[i] + step;
      const buy = side === "BUY";
      const q = qs[i];
      const lv = ultraLevels(side, candles[i].close, unit);
      const e = lowerBound(fine.t, T);
      const spread = (q.ask.close - q.bid.close) / unit;
      const hour = new Date(times[i]).getUTCHours();
      const fill = buy ? q.ask.close : q.bid.close;
      for (const k of ks) {
        const tp = lv.tps[k - 1];
        const res = follow(fine, e, side, lv.sl, tp);
        if (!res) continue;
        const pnl = buy ? res.exit - fill : fill - res.exit;
        recs.push({ tf, rule, pair, t: T, side, strong, entry: "close", k, kind: res.kind, pips: pnl / unit, bars: res.bars, hour, spread });
      }
      if (!late || e >= fine.n) return;
      // five minutes late: the close of the next 5-minute bar, the email's
      // levels unchanged; not entered where one was already passed
      const lateFill = buy ? fine.ac[e] : fine.bc[e];
      const exitNow = buy ? fine.bc[e] : fine.ac[e];
      const passed = buy ? exitNow >= lv.tps[0] || exitNow <= lv.sl : exitNow <= lv.tps[0] || exitNow >= lv.sl;
      if (passed) {
        const kk = `${tf}:${rule}`;
        lateSkipped[kk] = (lateSkipped[kk] ?? 0) + 1;
        return;
      }
      const res = follow(fine, e + 1, side, lv.sl, lv.tps[0]);
      if (!res) return;
      const pnl = buy ? res.exit - lateFill : lateFill - res.exit;
      recs.push({ tf, rule, pair, t: T, side, strong, entry: "late", k: 1, kind: res.kind, pips: pnl / unit, bars: res.bars, hour, spread: (fine.ac[e] - fine.bc[e]) / unit });
    };
    for (const s of sent) {
      // the close the email enters at, against the 5-minute bar ending there
      const T = times[s.i] + step;
      const j = lowerBound(fine.t, T - FINE);
      if (j < fine.n && fine.t[j] === T - FINE) {
        const same = Math.abs(fine.bc[j] - qs[s.i].bid.close) < eps && Math.abs(fine.ac[j] - qs[s.i].ask.close) < eps;
        if (same) cover.closeSame++;
        else cover.closeDiffer++;
      } else cover.closeNoFine++;
      enter(s.i, s.rule, s.side, s.strong, KS, true);
    }
    // the yardstick: both sides at a sample of this timeframe's closes
    for (let i = Math.max(0, i0); i < n; i++) {
      if (times[i] + step < START_MS || !mailed(tf, times[i] + step) || !sampled(pi, times[i], BLIND_EVERY[tf])) continue;
      if (!anchorOf(i)) continue;
      enter(i, "blind", "BUY", false, [1], false);
      enter(i, "blind", "SELL", false, [1], false);
    }
    coverage.push(cover);
    console.log(
      `${pair} ${tf.padEnd(5)}: ${n} bars ${cover.first ?? "-"} .. ${cover.last ?? "-"}, judged ${judged} from ${cover.firstJudged ?? "-"} (${noWindow} without a window); ` +
        `Q-Trend ${cover.qtrend} (${cover.strong} STRONG), ULTRA ${cover.ultra}, not mailed ${cover.unmailed}; close = 5-min ${cover.closeSame}, differs ${cover.closeDiffer}, no 5-min ${cover.closeNoFine}; ` +
        `GMO ${got.requests} read, ${got.cached} cached, ${got.failed} failed`,
    );
  }
}

// ---- the numbers -----------------------------------------------------------------------

const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
const meanCi = (xs: Array<{ t: number; v: number }>) => {
  const n = xs.length;
  if (n === 0) return { mean: null as number | null, lo: null as number | null, hi: null as number | null };
  const mean = xs.reduce((a, x) => a + x.v, 0) / n;
  const by = new Map<number, { s: number; c: number }>();
  for (const x of xs) {
    const w = weekOf(x.t);
    const g = by.get(w) ?? { s: 0, c: 0 };
    g.s += x.v;
    g.c++;
    by.set(w, g);
  }
  const W = by.size;
  let v = 0;
  for (const g of by.values()) v += (g.s - mean * g.c) ** 2;
  const se = W > 1 ? Math.sqrt((v * W) / (W - 1)) / n : 0;
  return { mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se };
};
const resolved = (x: Rec) => x.kind !== "open";
const won = (x: Rec) => x.kind === "tp";

const summarize = (ts: Rec[]) => {
  const res = ts.filter(resolved);
  const cr = clusterRate(res.map((x) => ({ cluster: weekOf(x.t), win: won(x) })));
  const p = meanCi(ts.map((x) => ({ t: x.t, v: x.pips })));
  const sp = ts.map((x) => x.spread).sort((a, b) => a - b);
  return {
    n: ts.length,
    resolved: res.length,
    tp: ts.filter((x) => x.kind === "tp").length,
    sl: ts.filter((x) => x.kind === "sl").length,
    amb: ts.filter((x) => x.kind === "amb").length,
    open: ts.filter((x) => x.kind === "open").length,
    win: cr ? cr.p : null,
    winLo: cr && Number.isFinite(cr.se) ? cr.p - 1.96 * cr.se : null,
    winHi: cr && Number.isFinite(cr.se) ? cr.p + 1.96 * cr.se : null,
    pips: p.mean,
    pipsLo: p.lo,
    pipsHi: p.hi,
    spread: sp.length ? sp[Math.floor(sp.length / 2)] : null,
    held: ts.length ? ts.reduce((a, x) => a + x.bars, 0) / ts.length : null,
  };
};
type Summary = ReturnType<typeof summarize>;

// the difference of two win rates, its interval cluster-robust by week
// (the delta method: both sets share the weeks)
const diffCi = (a: Rec[], b: Rec[]) => {
  const ra = a.filter(resolved);
  const rb = b.filter(resolved);
  if (!ra.length || !rb.length) return null;
  const pa = ra.filter(won).length / ra.length;
  const pb = rb.filter(won).length / rb.length;
  const by = new Map<number, number>();
  for (const x of ra) by.set(weekOf(x.t), (by.get(weekOf(x.t)) ?? 0) + ((won(x) ? 1 : 0) - pa) / ra.length);
  for (const x of rb) by.set(weekOf(x.t), (by.get(weekOf(x.t)) ?? 0) - ((won(x) ? 1 : 0) - pb) / rb.length);
  const C = by.size;
  let v = 0;
  for (const r of by.values()) v += r * r;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * v) : Number.NaN;
  return { d: pa - pb, lo: pa - pb - 1.96 * se, hi: pa - pb + 1.96 * se };
};

const pct = (x: number | null) => (x === null ? "   -  " : `${(100 * x).toFixed(1).padStart(5)}%`);
const num = (x: number | null, d = 2) => (x === null ? "-" : x.toFixed(d));
const row = (label: string, s: Summary) =>
  `${label.padEnd(24)} n=${String(s.n).padStart(7)}  TP1 first ${pct(s.win)} [${pct(s.winLo)},${pct(s.winHi)}] of ${String(s.resolved).padStart(7)}` +
  `  (tp ${s.tp} sl ${s.sl} amb ${s.amb} open ${s.open})  pips/trade ${num(s.pips)} [${num(s.pipsLo)}, ${num(s.pipsHi)}]  spread ${num(s.spread)}  held ${num(s.held, 0)} bars`;

const sel = (f: (x: Rec) => boolean) => recs.filter(f);
const both = (x: Rec) => x.rule === "qtrend" || x.rule === "ultra";
const report: Record<string, unknown> = { start: START, split: SPLIT, now: iso(NOW), synthetic: SYNTHETIC, maxHold: MAX_HOLD, pairs: PAIRS, coverage, check, lateSkipped };

console.log(`\n#157 the emails' signals by timeframe, ${START} .. ${iso(NOW)} (split ${SPLIT})${SYNTHETIC ? " — SYNTHETIC" : ""}; the email's stop 10 and TP 5/10/15 pips, followed on 5-minute bid/ask`);
for (const tf of TFS) {
  const c = check[tf];
  console.log(`check against indicatorSignals, ${tf}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`);
}
const fails = coverage.reduce((a, c) => a + c.failed, 0);
console.log(`GMO reads that failed: ${fails}`);
for (const tf of TFS) {
  const cs = coverage.filter((c) => c.tf === tf);
  const same = cs.reduce((a, c) => a + c.closeSame, 0);
  const differ = cs.reduce((a, c) => a + c.closeDiffer, 0);
  const none = cs.reduce((a, c) => a + c.closeNoFine, 0);
  const unmailed = cs.reduce((a, c) => a + c.unmailed, 0);
  const sentN = cs.reduce((a, c) => a + c.qtrend + c.ultra, 0);
  const firsts = cs.map((c) => c.firstJudged).filter((x): x is string => x !== null).sort();
  const hours = cs.reduce((acc, c) => {
    for (const [h, k] of Object.entries(c.openHours)) acc[Number(h)] = (acc[Number(h)] ?? 0) + k;
    return acc;
  }, {} as Record<number, number>);
  const top = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, k]) => `${h}h:${k}`).join(" ");
  console.log(`${tf.padEnd(5)}: first judged ${firsts[0] ?? "-"} .. ${firsts[firsts.length - 1] ?? "-"} (across pairs); signals mailed ${sentN}, not mailed (the market possibly shut at the reads) ${unmailed}; signal closes = the 5-minute close ${same}, differ ${differ}, no 5-minute bar ${none}; bar opens by UTC hour ${top}`);
}

const tables: Record<string, unknown> = {};
const periods: Array<[string, (x: Rec) => boolean]> = [["all", () => true], ["first", (x) => x.t < SPLIT_MS], ["second", (x) => x.t >= SPLIT_MS]];
for (const [pname, inP] of periods) {
  console.log(`\n== ${pname === "all" ? "the whole period" : pname === "first" ? `the first half (before ${SPLIT})` : `the second half (from ${SPLIT})`}, entered at the close`);
  const t: Record<string, unknown> = {};
  for (const tf of TFS) {
    const cell: Record<string, unknown> = {};
    for (const [rname, keep] of [["both", both], ["qtrend", (x: Rec) => x.rule === "qtrend"], ["ultra", (x: Rec) => x.rule === "ultra"]] as Array<[string, (x: Rec) => boolean]>) {
      for (const k of KS) {
        const s = summarize(sel((x) => x.tf === tf && keep(x) && x.entry === "close" && x.k === k && inP(x)));
        cell[`${rname}-tp${k}`] = s;
        if (k === 1) console.log(row(`${tf} ${rname}`, s));
      }
    }
    const tp2 = cell["both-tp2"] as Summary;
    const tp3 = cell["both-tp3"] as Summary;
    console.log(`${"".padEnd(24)} (both, whole position at TP2: first ${pct(tp2.win)}, ${num(tp2.pips)} pips/trade; at TP3: ${pct(tp3.win)}, ${num(tp3.pips)} pips/trade)`);
    t[tf] = cell;
  }
  tables[pname] = t;
}
report.tables = tables;

console.log("\n== entered five minutes late (TP1), and the blind entries at each timeframe's closes (both sides)");
const lateT: Record<string, unknown> = {};
for (const tf of TFS) {
  const late = summarize(sel((x) => x.tf === tf && both(x) && x.entry === "late"));
  const blind = summarize(sel((x) => x.tf === tf && x.rule === "blind" && x.k === 1));
  const skipped = (lateSkipped[`${tf}:qtrend`] ?? 0) + (lateSkipped[`${tf}:ultra`] ?? 0);
  lateT[tf] = { late, lateSkipped: skipped, blind };
  console.log(row(`${tf} late`, late) + `  (skipped: a level already passed ${skipped})`);
  console.log(row(`${tf} blind`, blind));
}
report.lateAndBlind = lateT;

// THE CHOICE: by the low end of each rate's interval
const lowOf = (tf: Tf, f: (x: Rec) => boolean) => summarize(sel((x) => x.tf === tf && both(x) && f(x))).winLo ?? -1;
const winOf = (tf: Tf, f: (x: Rec) => boolean) => summarize(sel((x) => x.tf === tf && both(x) && f(x))).win ?? -1;
const rank = (f: (x: Rec) => boolean) => [...TFS].sort((a, b) => lowOf(b, f) - lowOf(a, f));
const byRate = [...TFS].sort((a, b) => winOf(b, (x) => x.entry === "close" && x.k === 1) - winOf(a, (x) => x.entry === "close" && x.k === 1));
const main = rank((x) => x.entry === "close" && x.k === 1);
const best = main[0];
const second = main[1];
const dc = diffCi(sel((x) => x.tf === best && both(x) && x.entry === "close" && x.k === 1), sel((x) => x.tf === second && both(x) && x.entry === "close" && x.k === 1));
const r1 = rank((x) => x.entry === "close" && x.k === 1 && x.t < SPLIT_MS);
const r2 = rank((x) => x.entry === "close" && x.k === 1 && x.t >= SPLIT_MS);
const rl = rank((x) => x.entry === "late");
const vsBlind = diffCi(sel((x) => x.tf === best && both(x) && x.entry === "close" && x.k === 1), sel((x) => x.tf === best && x.rule === "blind" && x.k === 1));
console.log(`\n== THE CHOICE (TP1 first, both indicators pooled, whole period, at the close; by the low end of the 95% interval)`);
console.log(`ranked by the low end: ${main.map((tf) => `${tf} ${pct(lowOf(tf, (x) => x.entry === "close" && x.k === 1))} (rate ${pct(winOf(tf, (x) => x.entry === "close" && x.k === 1))})`).join("  >  ")}`);
console.log(`ranked by the rate itself (not used to choose): ${byRate.join(" > ")}`);
console.log(`chosen: ${best}; over ${second} by ${dc ? `${num(100 * dc.d, 1)} points [${num(100 * dc.lo, 1)}, ${num(100 * dc.hi, 1)}]` : "-"}`);
console.log(`its place by the low end: first half ${r1.indexOf(best) + 1} of 5 (${r1.join(" > ")}), second half ${r2.indexOf(best) + 1} (${r2.join(" > ")}), five minutes late ${rl.indexOf(best) + 1} (${rl.join(" > ")})`);
console.log(`against the blind entries at its closes: ${vsBlind ? `${num(100 * vsBlind.d, 1)} points [${num(100 * vsBlind.lo, 1)}, ${num(100 * vsBlind.hi, 1)}]` : "-"}`);
report.choice = { rankedByLow: main, rankedByRate: byRate, best, second, overSecond: dc, firstHalf: r1, secondHalf: r2, late: rl, vsBlind };

console.log("\n== Q-Trend STRONG and not (TP1, at the close)");
const strongT: Record<string, unknown> = {};
for (const tf of TFS) {
  const s = summarize(sel((x) => x.tf === tf && x.rule === "qtrend" && x.strong && x.entry === "close" && x.k === 1));
  const o = summarize(sel((x) => x.tf === tf && x.rule === "qtrend" && !x.strong && x.entry === "close" && x.k === 1));
  strongT[tf] = { strong: s, normal: o };
  console.log(row(`${tf} STRONG`, s));
  console.log(row(`${tf} not STRONG`, o));
}
report.strong = strongT;

console.log("\n== by the UTC hour of the signal bar's open (TP1, both, at the close): TP1 first / pips a trade / median spread paid");
const buckets: Array<[string, number, number]> = [["00-05", 0, 5], ["06-11", 6, 11], ["12-16", 12, 16], ["17-20", 17, 20], ["21-23", 21, 23]];
const byHour: Record<string, unknown> = {};
for (const tf of TFS) {
  const cells = buckets.map(([, a, b]) => summarize(sel((x) => x.tf === tf && both(x) && x.entry === "close" && x.k === 1 && x.hour >= a && x.hour <= b)));
  byHour[tf] = Object.fromEntries(buckets.map(([label], k) => [label, cells[k]]));
  console.log(`${tf.padEnd(5)} ` + buckets.map(([label], k) => `${label} n=${cells[k].n} ${pct(cells[k].win)} ${num(cells[k].pips)}p sp ${num(cells[k].spread)}`).join(" | "));
}
report.byHour = byHour;

console.log("\n== each pair (TP1, both, at the close): TP1 first (resolved n) on 5min / 15min / 1h / 4h / 1day");
const perPair: Record<string, unknown> = {};
for (const pair of PAIRS) {
  const cells = TFS.map((tf) => summarize(sel((x) => x.pair === pair && x.tf === tf && both(x) && x.entry === "close" && x.k === 1)));
  perPair[pair] = Object.fromEntries(TFS.map((tf, k) => [tf, { n: cells[k].n, resolved: cells[k].resolved, open: cells[k].open, win: cells[k].win, pips: cells[k].pips, spread: cells[k].spread }]));
  console.log(`${pair.padEnd(8)} ` + TFS.map((tf, k) => `${tf} ${pct(cells[k].win)} (${cells[k].resolved}${cells[k].open ? `, open ${cells[k].open}` : ""})`).join("  "));
}
report.perPair = perPair;

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/tf-winrate.json`, JSON.stringify(report, null, 1));
