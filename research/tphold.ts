// #164: the email's take-profit with no stop — a signal's trade left open,
// past the email's stop, until it reaches TP1 (5 pips) — against the email's
// exit now (TP1 or the stop, 10 pips), in pips. The owner (2026-09-29), after
// #163 (the Stoch exit with no stop): 「僕が思ったのはもし、損切りのラインに
// いってしまっても利確より先に、そのままポジションを待っていれば利確にいくの
// ではないかという事です」.
//
// THE MEASURE, fixed before any data was read:
//   * the signals, the coin, the entry and the 5-minute bid/ask they are
//     followed on: as #162 and #163 (research/stochexit.ts, stochfree.ts).
//   * now: #162's, unchanged (out at TP1, 5 pips from the bar's mid close,
//     or at the stop, 10 pips from it; a 5-minute bar reaching both counts
//     the stop; a 5-minute bar opening past a level goes out at that open).
//   * hold (the one asked): TP1 only, no stop; out at TP1 (at the open of a
//     5-minute bar opening past it), or, still in after 30 four-hour bars
//     (five days, as #162 and #163), at that close's bid/ask.
//   * hold 120: the same, still in after 120 bars (four weeks), told beside
//     it, against now on the trades whose 120 bars are in the data.
//   * a trade is counted only when its whole time (30 bars; for hold 120,
//     120) lies inside the data, whether it went out sooner or not (as #163).
//   * the owner's question, for the trades now takes off at the stop: how
//     many, held on, reached TP1 (within five days; within four weeks), how
//     many bars in, how far they went against it first; what the rest came
//     to at the limit, and the worst of them; and what the stopped trades
//     came to held on, beside the stop's.
//   * and every trade: pips a trade with its 95% interval by week and by four
//     weeks, how many won, the average win and loss, the worst trade and the
//     worst 5%'s edge, how far each went against it on the way; hold less
//     now, and beyond the coin's, as #163.
//   * called clearly better, as #162 and #163: for the emails' signals
//     (either), hold's pips a trade over now's on both halves, and the low
//     end of the difference (the lower of the two intervals') over 0 on the
//     second. Told the same way for hold 120. Whether it goes in is the
//     owner's to decide on the numbers.
//   * checks: the signals against the emails' own function; where now went
//     out at TP1 or the limit, hold the very same trade; every trade now
//     took off at its stop went past the stop held on; hold's exits at a
//     close against the 4-hour bar's own close.
//
// ON RANDOM WALKS (21 pairs each; ten seeds, SEED=7 .. 101), before any data
// was read: every check 0 differ. The trades now took off at the stop,
// held on, reached TP1 in 82.6% to 86.7% of the halves' (the emails'
// signals; every close either way 84.3% to 85.5%) within five days, 90.3%
// to 93.5% within four weeks; held on they came to −12.47 to −7.94 pips a
// trade (four weeks: −16.20 to −7.17) against −10.20 at the stop. Hold less
// now came out +0.24 on average over the twenty halves (every close either
// way +0.22; −0.76 to +0.80): the walk's 5-minute wicks reach TP1, are
// filled there and come back (as #162: a level filled at the level). The
// call came out "clearly better" on 2 of the 20 (hold on seed 97, hold 120
// on seed 31), "not clearly better" on the rest: an edge that small can
// make the call on its own; beyond the coin's is told beside it.

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { INDICATOR_PAIRS, indicatorIntervalsFor, indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, iso } from "./lib.ts";

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
// the random walks' seed (7: #162's walks); another gives other walks
const SEED = Number(Deno.env.get("SEED") || 7);
const CACHE = "research/.cache";
const OUT = "research/out";
const FINE = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
// how far before START each timeframe is read, for the window of the first
// bar judged (600 bars: two days of 5-minute bars, a week of 15-minute, five
// weeks of hourly); the 4-hour and daily ones by their year files
const LEAD_DAYS: Record<Tf, number> = { "5min": 5, "15min": 12, "1h": 45, "4h": 0, "1day": 0 };
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
  let seed = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, SEED);
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

// ---- the trades ----------------------------------------------------------------------

const TF: Tf = "4h";
// how long a trade is followed: 30 four-hour bars (five days, as #162 and
// #163); hold 120's, 120 (four weeks)
const MAX_BARS = 30;
const LONG_BARS = 120;
type Rule = "now" | "hold";
type Exit = "tp" | "sl" | "amb" | "time";
interface Trade {
  pips: number;
  exit: Exit;
  bars: number;
  // hold's: how far it went against it on the way, in pips from the fill,
  // and whether that reached the email's stop
  against: number;
  past: boolean;
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
  // and per four weeks: a trade held for days runs into the next week
  blocks: Map<number, { n: number; s: number }>;
  all: number[];
  againstSum: number;
  againstMax: number;
  against30: number;
  past: number;
}
const newAgg = (): Agg => ({ n: 0, sum: 0, wins: 0, winSum: 0, lossSum: 0, bars: 0, exits: { tp: 0, sl: 0, amb: 0, time: 0 }, weeks: new Map(), blocks: new Map(), all: [], againstSum: 0, againstMax: 0, against30: 0, past: 0 });
const addTo = (a: Agg, week: number, pips: number, t?: Trade) => {
  a.n++;
  a.sum += pips;
  a.all.push(pips);
  if (pips > 0) {
    a.wins++;
    a.winSum += pips;
  } else a.lossSum += pips;
  if (t) {
    a.bars += t.bars;
    a.exits[t.exit]++;
    a.againstSum += t.against;
    a.againstMax = Math.max(a.againstMax, t.against);
    if (t.against >= 30) a.against30++;
    if (t.past) a.past++;
  }
  for (const [m, k] of [[a.weeks, week], [a.blocks, Math.floor(week / 4)]] as const) {
    const w = m.get(k) ?? { n: 0, s: 0 };
    w.n++;
    w.s += pips;
    m.set(k, w);
  }
};
// the mean and its 95% interval, cluster-robust by week (or by four weeks)
const meanOf = (a: Agg, by: "weeks" | "blocks" = "weeks") => {
  if (a.n === 0) return { m: null as number | null, lo: null as number | null, hi: null as number | null };
  const m = a.sum / a.n;
  const C = a[by].size;
  let s = 0;
  for (const g of a[by].values()) s += (g.s - m * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / a.n : Number.NaN;
  return { m, lo: Number.isFinite(se) ? m - 1.96 * se : null, hi: Number.isFinite(se) ? m + 1.96 * se : null };
};
// the worst trade and the edge of the worst 5%
const tailOf = (a: Agg) => {
  if (a.n === 0) return { worst: null as number | null, p5: null as number | null };
  const xs = [...a.all].sort((x, y) => x - y);
  return { worst: xs[0], p5: xs[Math.floor(0.05 * (xs.length - 1))] };
};

// the owner's question: the trades now took off at the stop, held on
interface Rescue {
  // now went out at the stop (amb: a 5-minute bar reached TP1 and the stop
  // both, which now counts as the stop)
  stopped: number;
  amb: number;
  // held on, reached TP1: bars from the entry to TP1, and to now's stop
  reached: number;
  reachedBars: number;
  stopBars: number;
  // held on, not reached: out at the limit's close
  rest: number;
  restSum: number;
  restWorst: number;
  // held on, all of them: pips, and how far they went against it
  heldSum: number;
  stopSum: number;
  againstSum: number;
  againstMax: number;
}
const newRescue = (): Rescue => ({ stopped: 0, amb: 0, reached: 0, reachedBars: 0, stopBars: 0, rest: 0, restSum: 0, restWorst: Infinity, heldSum: 0, stopSum: 0, againstSum: 0, againstMax: 0 });
const rescueAdd = (r: Rescue, now: Trade, hold: Trade) => {
  if (now.exit !== "sl" && now.exit !== "amb") return;
  r.stopped++;
  if (now.exit === "amb") r.amb++;
  r.heldSum += hold.pips;
  r.stopSum += now.pips;
  r.againstSum += hold.against;
  r.againstMax = Math.max(r.againstMax, hold.against);
  if (hold.exit === "tp") {
    r.reached++;
    r.reachedBars += hold.bars;
    r.stopBars += now.bars;
  } else {
    r.rest++;
    r.restSum += hold.pips;
    r.restWorst = Math.min(r.restWorst, hold.pips);
  }
};

// group → [first half, second half] of each series: now, hold and their
// difference on the 30-bar trades, and the same on the trades with 120 bars
// in the data; and the stopped trades held on, for each
const SERIES = ["now", "hold", "holdNow", "longNow", "longHold", "longDiff"] as const;
type Series = (typeof SERIES)[number];
type Half = Record<Series, Agg> & { r30: Rescue; r120: Rescue };
const groups = new Map<string, Half[]>();
const groupOf = (key: string) => {
  let g = groups.get(key);
  if (!g) {
    g = [0, 1].map(() => ({ ...(Object.fromEntries(SERIES.map((s) => [s, newAgg()])) as Record<Series, Agg>), r30: newRescue(), r120: newRescue() }));
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
  longTrades: number;
  failed: number;
}
const coverage: Cover[] = [];
const check = { compared: 0, mismatched: 0, examples: [] as string[] };
// where now went out at TP1 or the limit, hold must be the very same trade
const sameCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
// every trade now took off at its stop must have gone past the stop held on
const pastCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
// the close a trade goes out at (the last 5-minute bar's) against the 4-hour
// bar's own
const closeCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);

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

  // a trade entered at bar i's close, taken off by `rule` or after `cap`
  // bars; null when not a signal the sweep would mail, or when its `need`
  // bars are not all in the data
  const tradeAt = (i: number, side: Side, rule: Rule, cap: number, need = cap): Trade | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    if (i + need >= n) return null;
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
    let against = 0;
    let past = false;
    const out = (pips: number, exit: Exit, bars: number): Trade => ({ pips, exit, bars, against, past });
    let f = lowerBound(fine.t, T);
    if (f >= fine.n) return null;
    for (let j = i + 1; j <= i + cap; j++) {
      if (j >= n) return null;
      const end = times[j] + step;
      const bars = j - i;
      while (f < fine.n && fine.t[f] < end) {
        if (rule === "now") {
          if (buy ? o[f] <= lv.sl : o[f] >= lv.sl) return out(pipsOf(o[f]), "sl", bars);
          if (buy ? o[f] >= tp : o[f] <= tp) return out(pipsOf(o[f]), "tp", bars);
          const hitSl = buy ? l[f] <= lv.sl : h[f] >= lv.sl;
          const hitTp = buy ? h[f] >= tp : l[f] <= tp;
          if (hitSl && hitTp) return out(pipsOf(lv.sl), "amb", bars);
          if (hitSl) return out(pipsOf(lv.sl), "sl", bars);
          if (hitTp) return out(pipsOf(tp), "tp", bars);
        } else {
          // TP1 only: a bar opening past it goes out at the open, before
          // anything in it; else how far it went, then whether it reached
          if (buy ? o[f] >= tp : o[f] <= tp) return out(pipsOf(o[f]), "tp", bars);
          against = Math.max(against, buy ? (fill - l[f]) / unit : (h[f] - fill) / unit);
          if (buy ? l[f] <= lv.sl : h[f] >= lv.sl) past = true;
          if (buy ? h[f] >= tp : l[f] <= tp) return out(pipsOf(tp), "tp", bars);
        }
        f++;
      }
      if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
      if (f === 0) return null;
      if (j === i + cap) {
        // bar j's close, where it is taken off at the limit
        const closePx = c[f - 1];
        if (rule === "hold") {
          const own = buy ? qs[j].bid.close : qs[j].ask.close;
          closeCheck.compared++;
          if (Math.abs(closePx - own) > unit / 1000) {
            closeCheck.mismatched++;
            if (closeCheck.examples.length < 10) closeCheck.examples.push(`${pair} ${iso(times[j])} ${side} ${closePx}/${own}`);
          }
        }
        return out(pipsOf(closePx), "time", bars);
      }
    }
    return null;
  };
  // the 30-bar trades, and the 120-bar ones where the data holds them
  const recordAt = (i: number, side: Side, keys: string[]): boolean => {
    const now = tradeAt(i, side, "now", MAX_BARS);
    const hold = tradeAt(i, side, "hold", MAX_BARS);
    if (!now || !hold) return false;
    const T = times[i] + step;
    if (now.exit === "tp" || now.exit === "time") {
      sameCheck.compared++;
      if (now.pips !== hold.pips || now.bars !== hold.bars || now.exit !== hold.exit) {
        sameCheck.mismatched++;
        if (sameCheck.examples.length < 10) sameCheck.examples.push(`${pair} ${iso(T)} ${side} now ${now.exit} ${now.pips} ${now.bars} / hold ${hold.exit} ${hold.pips} ${hold.bars}`);
      }
    }
    if (now.exit === "sl" || now.exit === "amb") {
      pastCheck.compared++;
      if (!hold.past) {
        pastCheck.mismatched++;
        if (pastCheck.examples.length < 10) pastCheck.examples.push(`${pair} ${iso(T)} ${side} now ${now.exit} ${now.pips} ${now.bars} / hold ${hold.exit} ${hold.pips} ${hold.bars}`);
      }
    }
    const half = T < SPLIT_MS ? 0 : 1;
    const week = weekOf(T);
    const nowL = tradeAt(i, side, "now", MAX_BARS, LONG_BARS);
    const holdL = tradeAt(i, side, "hold", LONG_BARS);
    for (const key of keys) {
      const g = groupOf(key)[half];
      addTo(g.now, week, now.pips, now);
      addTo(g.hold, week, hold.pips, hold);
      addTo(g.holdNow, week, hold.pips - now.pips);
      rescueAdd(g.r30, now, hold);
      if (nowL && holdL) {
        addTo(g.longNow, week, nowL.pips, nowL);
        addTo(g.longHold, week, holdL.pips, holdL);
        addTo(g.longDiff, week, holdL.pips - nowL.pips);
        rescueAdd(g.r120, nowL, holdL);
      }
    }
    return true;
  };

  // the coin: every close either way
  for (let i = 0; i < n; i++) {
    for (const side of ["BUY", "SELL"] as const) recordAt(i, side, ["coin", `coin ${side}`]);
  }
  // the signals: each rule's, and the emails' together (one trade a bar and side)
  let trades = 0;
  let longTrades = 0;
  const eitherSeen = new Set<string>();
  for (const sg of signals) {
    const keys = sg.rule === "qtrend" ? [`qtrend`, `qtrend ${sg.side}`, ...(sg.strong ? ["strong", `strong ${sg.side}`] : [])] : [`ultra`, `ultra ${sg.side}`];
    const ek = `${sg.i}:${sg.side}`;
    const first = !eitherSeen.has(ek);
    if (first) keys.push("either", `either ${sg.side}`);
    if (!recordAt(sg.i, sg.side, keys) || !first) continue;
    eitherSeen.add(ek);
    trades++;
    if (sg.i + LONG_BARS < n) longTrades++;
  }
  coverage.push({ pair, bars: n, judged, signals: signals.length, trades, longTrades, failed: fineGot.failed + got.failed });
  console.log(`${pair} ${TF}: ${n} bars, judged ${judged}, signals ${signals.length} (trades ${trades}, with 120 bars ${longTrades}); GMO failed ${fineGot.failed + got.failed}`);
}

// ---- the report ------------------------------------------------------------------------

const num = (x: number | null, d = 2) => (x === null ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
// an interval by week, and by four weeks
const ci = (r: { lo: number | null; hi: number | null }, r4: { lo: number | null; hi: number | null }) => `[${num(r.lo)},${num(r.hi)}] (4 wk [${num(r4.lo)},${num(r4.hi)}])`;
const checkLine = (what: string, c: { compared: number; mismatched: number; examples: string[] }) =>
  `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
const ruleLine = (label: string, a: Agg, held = false) => {
  const r = meanOf(a);
  const r4 = meanOf(a, "blocks");
  const t = tailOf(a);
  const out = (Object.keys(a.exits) as Exit[]).filter((k) => a.exits[k] > 0).map((k) => `${k} ${a.exits[k]}`).join(" ");
  const lines = [`  ${label.padEnd(8)} ${num(r.m)} ${ci(r, r4)} pips/trade of ${String(a.n).padStart(5)}; won ${pct(a.wins, a.n)}, avg win ${num(a.wins ? a.winSum / a.wins : null, 1)}, avg loss ${num(a.n - a.wins ? a.lossSum / (a.n - a.wins) : null, 1)}, worst ${num(t.worst, 1)}, worst 5% from ${num(t.p5, 1)}, bars ${(a.bars / Math.max(1, a.n)).toFixed(1)}; ${out}`];
  if (held && a.n) {
    lines.push(`  ${"".padEnd(8)} went against it: avg ${(a.againstSum / a.n).toFixed(1)} pips, most ${a.againstMax.toFixed(1)}, 30+ pips ${pct(a.against30, a.n)}; past the email's stop ${a.past} (${pct(a.past, a.n)})`);
  }
  return lines.join("\n");
};
const rescueLine = (label: string, r: Rescue, all: number) =>
  `  ${label}: stopped under now ${r.stopped} (${pct(r.stopped, all)} of the trades; amb ${r.amb}); held on, reached TP1 ${r.reached} (${pct(r.reached, r.stopped)}), avg ${(r.reachedBars / Math.max(1, r.reached)).toFixed(1)} bars in (the stop at ${(r.stopBars / Math.max(1, r.reached)).toFixed(1)}); not reached ${r.rest} (${pct(r.rest, r.stopped)}), avg ${num(r.rest ? r.restSum / r.rest : null, 1)} pips at the limit, worst ${num(r.rest ? r.restWorst : null, 1)}; the stopped ones held on avg ${num(r.stopped ? r.heldSum / r.stopped : null, 2)} pips (at the stop ${num(r.stopped ? r.stopSum / r.stopped : null, 2)}), went against it avg ${(r.againstSum / Math.max(1, r.stopped)).toFixed(1)}, most ${r.againstMax.toFixed(1)}`;
console.log(`\n#164 the email's TP1 with no stop on ${TF}, ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? ` — SYNTHETIC, seed ${SEED}` : ""}; now: TP1 5 pips or the stop, 10; hold: TP1 only, no stop; out after ${MAX_BARS} bars (hold 120: ${LONG_BARS})`);
console.log(checkLine("signals against indicatorSignals", check));
console.log(checkLine("hold against now where now went out at TP1 or the limit", sameCheck));
console.log(checkLine("stopped under now but not past the stop held on", pastCheck));
console.log(checkLine("hold's exit closes against the 4-hour bar's own", closeCheck));
console.log(`GMO reads that failed: ${coverage.reduce((a, c) => a + c.failed, 0)}`);
// a difference beyond the coin's (the same side), with an interval taking
// the two as independent
const beyondCoin = (key: string, half: 0 | 1, series: Series, by: "weeks" | "blocks" = "weeks") => {
  const side = key.endsWith("BUY") ? " BUY" : key.endsWith("SELL") ? " SELL" : "";
  const c = groups.get(`coin${side}`);
  const g = groups.get(key);
  if (!c || !g) return null;
  const a = meanOf(g[half][series], by);
  const b = meanOf(c[half][series], by);
  if (a.m === null || b.m === null || a.lo === null || b.lo === null || a.hi === null || b.hi === null) return null;
  const se = Math.sqrt(((a.hi - a.lo) / 3.92) ** 2 + ((b.hi - b.lo) / 3.92) ** 2);
  const m = a.m - b.m;
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se };
};
const diffLine = (what: string, key: string, half: 0 | 1, series: Series) => {
  const d = meanOf(groups.get(key)![half][series]);
  const d4 = meanOf(groups.get(key)![half][series], "blocks");
  const bc = !key.startsWith("coin") ? beyondCoin(key, half, series) : null;
  const bc4 = !key.startsWith("coin") ? beyondCoin(key, half, series, "blocks") : null;
  return `  ${what}: ${num(d.m)} ${ci(d, d4)} pips/trade${bc && bc4 ? `; beyond the coin's ${num(bc.m)} ${ci(bc, bc4)}` : ""}`;
};
const ORDER = ["either", "either BUY", "either SELL", "qtrend", "qtrend BUY", "qtrend SELL", "strong", "strong BUY", "strong SELL", "ultra", "ultra BUY", "ultra SELL", "coin", "coin BUY", "coin SELL"];
for (const key of ORDER) {
  const g = groups.get(key);
  if (!g) continue;
  for (const half of [0, 1] as const) {
    const h = g[half];
    console.log(`\n== ${key}, ${half === 0 ? "first" : "second"} half`);
    console.log(ruleLine("now", h.now));
    console.log(ruleLine("hold", h.hold, true));
    console.log(diffLine("hold − now", key, half, "holdNow"));
    console.log(rescueLine("30 bars", h.r30, h.now.n));
    console.log(`  -- with 120 bars in the data:`);
    console.log(ruleLine("now", h.longNow));
    console.log(ruleLine("hold 120", h.longHold, true));
    console.log(diffLine("hold 120 − now", key, half, "longDiff"));
    console.log(rescueLine("120 bars", h.r120, h.longNow.n));
  }
}

// CLEARLY BETTER?
const verdicts: Record<string, string> = {};
const e = groups.get("either");
if (e) {
  const [f, s] = e;
  for (const [what, rule, base, diff] of [["hold", "hold", "now", "holdNow"], ["hold 120", "longHold", "longNow", "longDiff"]] as const) {
    const better = (x: Half) => (meanOf(x[rule]).m ?? -Infinity) > (meanOf(x[base]).m ?? Infinity);
    // the lower of the two intervals' low ends (by week, by four weeks)
    const los = [meanOf(s[diff]).lo, meanOf(s[diff], "blocks").lo];
    const lo = los.some((x) => x === null) ? null : Math.min(...(los as number[]));
    const clearly = better(f) && better(s) && lo !== null && lo > 0;
    verdicts[what] = clearly ? `${what} is clearly better than now for the emails' signals` : `${what} is not clearly better than now for the emails' signals`;
    console.log(`\n== VERDICT (${what}): over now on the first half: ${better(f)}, on the second: ${better(s)}; the difference's low end on the second ${num(lo)} → ${verdicts[what]}`);
  }
}

const aggOut = (a: Agg) => ({ ...meanOf(a), lo4: meanOf(a, "blocks").lo, hi4: meanOf(a, "blocks").hi, ...tailOf(a), n: a.n, wins: a.wins, exits: a.exits, against: a.n ? a.againstSum / a.n : null, againstMax: a.againstMax, against30: a.against30, past: a.past });
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/tphold.json`, JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), synthetic: SYNTHETIC, seed: SEED, coverage, check, sameCheck, pastCheck, closeCheck, groups: Object.fromEntries([...groups].map(([k, g]) => [k, g.map((h) => ({ ...Object.fromEntries(SERIES.map((s) => [s, aggOut(h[s])])), r30: h.r30, r120: h.r120 }))])), verdicts }, null, 1));
