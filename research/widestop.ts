// #165: the email's TP1 with a wider stop — a signal's trade taken off at
// TP1 (5 pips) or at a stop 15, 20, 30, 50 or 100 pips away, within five
// days or four weeks — against the email's exit now (TP1 or the stop, 10
// pips, within five days), in pips. After #164 (held on with no stop, about
// eight in ten of the trades now stops out reached TP1 within five days, the
// rest lost heavily), a wider stop was offered as the middle way; the owner
// (2026-09-29): 「測ってみて、それで決める」.
//
// THE MEASURE, fixed before any data was read:
//   * the signals, the coin, the entry and the 5-minute bid/ask they are
//     followed on: as #162 to #164 (research/tphold.ts).
//   * the rules: TP1, 5 pips from the bar's mid close, and a stop S pips from
//     it, S = 10 (the email's), 15, 20, 30, 50, 100 or none; out at whichever
//     a 5-minute bar reaches first (both in one 5-minute bar: the stop, as
//     every record here; a bar opening past one: at that open), or, still in
//     after L four-hour bars, at that close's bid/ask; L = 30 (five days) or
//     120 (four weeks). now is S 10, L 30.
//   * every rule on the same trades: those whose 120 bars lie inside the
//     data, whether they went out sooner or not.
//   * the pick: among S 15, 20, 30, 50, 100 and L 30, 120 (ten), the one with
//     the most pips a trade on the first half for the emails' signals
//     (either). The second half is not looked at for the pick.
//   * called clearly better: the pick's pips a trade over now's on the
//     second half, and the low end of the difference (the lower of the
//     intervals by week and by four weeks) over 0: one rule, tested on the
//     half it was not picked on. Whether it goes in is the owner's to decide
//     on the numbers.
//   * told for every rule (each half; each group and side): pips a trade
//     with its 95% interval by week and by four weeks, how many won, the
//     average win and loss, the worst trade and the worst 5%'s edge, how
//     each went out, bars held; the rule less now, and beyond the coin's.
//   * checks: the signals against the emails' own function; S 10 L 30
//     against #164's now, and S none against #164's hold, trade by trade; a
//     trade out at TP1 or the limit under a stop the same trade under every
//     wider one; the exits at a close against the 4-hour bars' own.
//
// ON RANDOM WALKS (21 pairs each), before any data was read; two kinds:
//   * "wicks" (#162's walks; ten seeds, SEED=7 .. 101): every check 0
//     differ. The call came out "clearly better" on 6 of the 10: on these
//     walks a wider stop is better (every close either way, on average over
//     the twenty halves: S10 −0.30 pips a trade, S15 −0.23, S20 −0.19, S30
//     −0.14, S50 −0.10), for a wick the next bar does not follow fills TP1
//     at the level and the price comes back, and the wider the stop, the
//     more trades go out at TP1.
//   * "path" (added for this, SYNTH=path: each 5-minute bar 100 small steps,
//     its high and low the path's own, no such wick; the same ten seeds):
//     every check 0 differ; every rule near the spread's cost (every close
//     either way −0.43 to −0.52 on average); the call "not clearly better"
//     on all ten.
//   The call fires where a wider stop is better and stays quiet where no
//   rule is. On real prices the wicks are prices that were quoted; whether
//   the price comes back from them, as on the first walks, is what the
//   real data tells.
//
// THE RESULT (2026-09-29, docs §8.77), GMO's 14 pairs with the history,
// 4-hour bars; the emails' signals (either), first half and second, pips a
// trade:
//   * L30: S10 (now) −1.28 and −1.07; S15 −1.05 and −0.97; S20 −0.95 and
//     −1.05; S30 −0.61 and −0.99; S50 −0.74 and −0.43; S100 −0.40 and
//     −0.57; none −0.33 and −0.80. L120: S10 −1.32 and −1.11; S15 −1.09 and
//     −1.04; S20 −1.00 and −1.12; S30 −0.62 and −1.08; S50 −0.83 and −0.51;
//     S100 −0.50 and −0.54; none +0.25 and +0.06.
//   * the pick: S100 L30 (first half −0.40). On the second half −0.57
//     against now −1.07; the difference +0.51 (−0.40 to +1.41; by four
//     weeks −0.44 to +1.45): not clearly better.
//   * L30, won: S10 60.0% and 61.0%, S30 81.0% and 79.3%, S50 85.0% and
//     84.9%, S100 88.7% and 88.1%; the average loss −10.2 and −9.8, −22.9
//     and −22.3, −31.2 and −28.6, −39.8 and −38.7 pips; the worst trade
//     −32.0 and −53.3, −41.0 and −88.0, −66.1 and −88.0, −108.5 and −129.4
//     (a 5-minute bar opening past the stop goes out at that open).
//   * every close either way gained by a wider stop too (L30 less now): S30
//     +0.22 and +0.23, S50 +0.13 and +0.32, S100 +0.15 and +0.28.

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
// the walks' 5-minute bars: "wicks" (#162's: a step, and a wick added past
// it that the next bar does not follow, which a level can be filled on and
// the price come back from), or "path" (100 small steps, the high and low
// the path's own: no such wick, a level filled at the level though the
// step crossing it went a little past)
const SYNTH = Deno.env.get("SYNTH") === "path" ? "path" : "wicks";
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
    let h: number;
    let l: number;
    if (SYNTH === "path") {
      // 100 steps a tenth as wide: the 5-minute step's spread kept
      h = o;
      l = o;
      for (let k = 0; k < 100; k++) {
        px += (rnd() - 0.5) * (scale / 10);
        if (px > h) h = px;
        if (px < l) l = px;
      }
    } else {
      px = o + (rnd() - 0.5) * scale;
      h = Math.max(o, px) + rnd() * wick;
      l = Math.min(o, px) - rnd() * wick;
    }
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
// the stops (pips from the bar's mid close; null: none) and the limits (four-
// hour bars: five days, four weeks)
const STOPS = [10, 15, 20, 30, 50, 100, null] as const;
type Stop = (typeof STOPS)[number];
const LIMITS = [30, 120] as const;
type Limit = (typeof LIMITS)[number];
const ruleKey = (s: Stop, l: Limit) => `S${s ?? "none"} L${l}`;
const RULES = LIMITS.flatMap((l) => STOPS.map((s) => ({ key: ruleKey(s, l), stop: s, limit: l })));
const NOW_RULE = ruleKey(10, 30);
const PICKS = RULES.filter((r) => r.stop !== null && r.stop > 10).map((r) => r.key);
// every rule on the trades whose 120 bars are in the data
const NEED = 120;
type Exit = "tp" | "sl" | "amb" | "time";
interface Trade {
  pips: number;
  exit: Exit;
  bars: number;
}

// per group, half and rule (or a rule less now): the trades' pips, and per
// week (and per four weeks) for the interval
interface Agg {
  n: number;
  sum: number;
  wins: number;
  winSum: number;
  lossSum: number;
  bars: number;
  exits: Record<Exit, number>;
  weeks: Map<number, { n: number; s: number }>;
  blocks: Map<number, { n: number; s: number }>;
  all: number[];
}
const newAgg = (): Agg => ({ n: 0, sum: 0, wins: 0, winSum: 0, lossSum: 0, bars: 0, exits: { tp: 0, sl: 0, amb: 0, time: 0 }, weeks: new Map(), blocks: new Map(), all: [] });
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
// group → [first half, second half] of: each rule (by its key), and each
// rule less now (its key and " − now")
const groups = new Map<string, Array<Map<string, Agg>>>();
const aggOf = (key: string, half: 0 | 1, series: string) => {
  let g = groups.get(key);
  if (!g) {
    g = [new Map(), new Map()];
    groups.set(key, g);
  }
  let a = g[half].get(series);
  if (!a) {
    a = newAgg();
    g[half].set(series, a);
  }
  return a;
};
const DIFF = " − now";

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
// S 10 L 30 against #164's now, S none against #164's hold, trade by trade
const refCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
// a trade out at TP1 or the limit under a stop: the same under the next wider
const nestCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
// the close a trade goes out at (the last 5-minute bar's) against the 4-hour
// bar's own
const closeCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
const same = (a: Trade, b: Trade) => a.pips === b.pips && a.exit === b.exit && a.bars === b.bars;

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

  // a trade entered at bar i's close, out at TP1 or at the stop `stop` pips
  // away (none: null), or at the close after `limit` bars; null when not a
  // signal the sweep would mail, or when its 120 bars are not all in the data
  const tradeAt = (i: number, side: Side, stop: Stop, limit: number): Trade | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    if (i + NEED >= n) return null;
    const buy = side === "BUY";
    const dir = buy ? 1 : -1;
    const tp = ultraLevels(side, candles[i].close, unit).tps[0];
    const sl = stop === null ? null : candles[i].close - dir * stop * unit;
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const pipsOf = (exit: number) => (buy ? exit - fill : fill - exit) / unit;
    // the prices it goes out at: a buy's bid, a sell's ask
    const o = buy ? fine.bo : fine.ao;
    const h = buy ? fine.bh : fine.ah;
    const l = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    let f = lowerBound(fine.t, T);
    if (f >= fine.n) return null;
    for (let j = i + 1; j <= i + limit; j++) {
      const end = times[j] + step;
      const bars = j - i;
      while (f < fine.n && fine.t[f] < end) {
        if (sl !== null && (buy ? o[f] <= sl : o[f] >= sl)) return { pips: pipsOf(o[f]), exit: "sl", bars };
        if (buy ? o[f] >= tp : o[f] <= tp) return { pips: pipsOf(o[f]), exit: "tp", bars };
        const hitSl = sl !== null && (buy ? l[f] <= sl : h[f] >= sl);
        const hitTp = buy ? h[f] >= tp : l[f] <= tp;
        if (sl !== null && hitSl && hitTp) return { pips: pipsOf(sl), exit: "amb", bars };
        if (sl !== null && hitSl) return { pips: pipsOf(sl), exit: "sl", bars };
        if (hitTp) return { pips: pipsOf(tp), exit: "tp", bars };
        f++;
      }
      if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
      if (f === 0) return null;
      if (j === i + limit) {
        // bar j's close, where it is taken off at the limit
        const closePx = c[f - 1];
        const own = buy ? qs[j].bid.close : qs[j].ask.close;
        closeCheck.compared++;
        if (Math.abs(closePx - own) > unit / 1000) {
          closeCheck.mismatched++;
          if (closeCheck.examples.length < 10) closeCheck.examples.push(`${pair} ${iso(times[j])} ${side} ${closePx}/${own}`);
        }
        return { pips: pipsOf(closePx), exit: "time", bars };
      }
    }
    return null;
  };

  // #164's own code (research/tphold.ts), for the check: now, and hold
  const refAt = (i: number, side: Side, rule: "now" | "hold", cap: number): Trade | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    if (i + NEED >= n) return null;
    const buy = side === "BUY";
    const lv = ultraLevels(side, candles[i].close, unit);
    const tp = lv.tps[0];
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const pipsOf = (exit: number) => (buy ? exit - fill : fill - exit) / unit;
    const o = buy ? fine.bo : fine.ao;
    const h = buy ? fine.bh : fine.ah;
    const l = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    const out = (pips: number, exit: Exit, bars: number): Trade => ({ pips, exit, bars });
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
          if (buy ? o[f] >= tp : o[f] <= tp) return out(pipsOf(o[f]), "tp", bars);
          if (buy ? h[f] >= tp : l[f] <= tp) return out(pipsOf(tp), "tp", bars);
        }
        f++;
      }
      if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
      if (f === 0) return null;
      if (j === i + cap) return out(pipsOf(c[f - 1]), "time", bars);
    }
    return null;
  };

  // every rule on one trade; false when the data does not hold it
  const recordAt = (i: number, side: Side, keys: string[]): boolean => {
    const got = new Map<string, Trade>();
    for (const r of RULES) {
      const t = tradeAt(i, side, r.stop, r.limit);
      if (!t) return false;
      got.set(r.key, t);
    }
    const T = times[i] + step;
    const tag = `${pair} ${iso(T)} ${side}`;
    // the checks
    const refs: Array<[string, Trade | null]> = [[NOW_RULE, refAt(i, side, "now", 30)], [ruleKey(null, 30), refAt(i, side, "hold", 30)], [ruleKey(null, 120), refAt(i, side, "hold", 120)]];
    for (const [key, ref] of refs) {
      refCheck.compared++;
      const t = got.get(key)!;
      if (!ref || !same(ref, t)) {
        refCheck.mismatched++;
        if (refCheck.examples.length < 10) refCheck.examples.push(`${tag} ${key} ${t.exit} ${t.pips} ${t.bars} / #164 ${ref ? `${ref.exit} ${ref.pips} ${ref.bars}` : "none"}`);
      }
    }
    for (const lim of LIMITS) {
      for (let k = 0; k + 1 < STOPS.length; k++) {
        const a = got.get(ruleKey(STOPS[k], lim))!;
        if (a.exit !== "tp" && a.exit !== "time") continue;
        const b = got.get(ruleKey(STOPS[k + 1], lim))!;
        nestCheck.compared++;
        if (!same(a, b)) {
          nestCheck.mismatched++;
          if (nestCheck.examples.length < 10) nestCheck.examples.push(`${tag} ${ruleKey(STOPS[k], lim)} ${a.exit} ${a.pips} ${a.bars} / ${ruleKey(STOPS[k + 1], lim)} ${b.exit} ${b.pips} ${b.bars}`);
        }
      }
    }
    const half = T < SPLIT_MS ? 0 : 1;
    const week = weekOf(T);
    const now = got.get(NOW_RULE)!;
    for (const key of keys) {
      for (const r of RULES) {
        const t = got.get(r.key)!;
        addTo(aggOf(key, half, r.key), week, t.pips, t);
        if (r.key !== NOW_RULE) addTo(aggOf(key, half, r.key + DIFF), week, t.pips - now.pips);
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
  const eitherSeen = new Set<string>();
  for (const sg of signals) {
    const keys = sg.rule === "qtrend" ? [`qtrend`, `qtrend ${sg.side}`, ...(sg.strong ? ["strong", `strong ${sg.side}`] : [])] : [`ultra`, `ultra ${sg.side}`];
    const ek = `${sg.i}:${sg.side}`;
    const first = !eitherSeen.has(ek);
    if (first) keys.push("either", `either ${sg.side}`);
    if (!recordAt(sg.i, sg.side, keys) || !first) continue;
    eitherSeen.add(ek);
    trades++;
  }
  coverage.push({ pair, bars: n, judged, signals: signals.length, trades, failed: fineGot.failed + got.failed });
  console.log(`${pair} ${TF}: ${n} bars, judged ${judged}, signals ${signals.length} (trades ${trades}); GMO failed ${fineGot.failed + got.failed}`);
}

// ---- the report ------------------------------------------------------------------------

const num = (x: number | null, d = 2) => (x === null ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
// an interval by week, and by four weeks
const ci = (r: { lo: number | null; hi: number | null }, r4: { lo: number | null; hi: number | null }) => `[${num(r.lo)},${num(r.hi)}] (4 wk [${num(r4.lo)},${num(r4.hi)}])`;
const checkLine = (what: string, c: { compared: number; mismatched: number; examples: string[] }) =>
  `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
// a difference beyond the coin's (the same side), with an interval taking
// the two as independent
const beyondCoin = (key: string, half: 0 | 1, series: string, by: "weeks" | "blocks" = "weeks") => {
  const side = key.endsWith("BUY") ? " BUY" : key.endsWith("SELL") ? " SELL" : "";
  const c = groups.get(`coin${side}`)?.[half].get(series);
  const g = groups.get(key)?.[half].get(series);
  if (!c || !g) return null;
  const a = meanOf(g, by);
  const b = meanOf(c, by);
  if (a.m === null || b.m === null || a.lo === null || b.lo === null || a.hi === null || b.hi === null) return null;
  const se = Math.sqrt(((a.hi - a.lo) / 3.92) ** 2 + ((b.hi - b.lo) / 3.92) ** 2);
  const m = a.m - b.m;
  return { m, lo: m - 1.96 * se, hi: m + 1.96 * se };
};
const ruleLine = (key: string, half: 0 | 1, rule: string) => {
  const a = groups.get(key)![half].get(rule)!;
  const r = meanOf(a);
  const r4 = meanOf(a, "blocks");
  const t = tailOf(a);
  const out = (Object.keys(a.exits) as Exit[]).filter((k) => a.exits[k] > 0).map((k) => `${k} ${pct(a.exits[k], a.n)}`).join(" ");
  const head = `  ${(rule + (rule === NOW_RULE ? " (now)" : "")).padEnd(17)} ${num(r.m)} ${ci(r, r4)} pips/trade of ${String(a.n).padStart(5)}; won ${pct(a.wins, a.n)}, avg win ${num(a.wins ? a.winSum / a.wins : null, 1)}, avg loss ${num(a.n - a.wins ? a.lossSum / (a.n - a.wins) : null, 1)}, worst ${num(t.worst, 1)}, worst 5% from ${num(t.p5, 1)}, bars ${(a.bars / Math.max(1, a.n)).toFixed(1)}; ${out}`;
  if (rule === NOW_RULE) return head;
  const d = groups.get(key)![half].get(rule + DIFF)!;
  const dm = meanOf(d);
  const dm4 = meanOf(d, "blocks");
  const bc = !key.startsWith("coin") ? beyondCoin(key, half, rule + DIFF) : null;
  const bc4 = !key.startsWith("coin") ? beyondCoin(key, half, rule + DIFF, "blocks") : null;
  return `${head}\n  ${"".padEnd(17)} less now ${num(dm.m)} ${ci(dm, dm4)}${bc && bc4 ? `; beyond the coin's ${num(bc.m)} ${ci(bc, bc4)}` : ""}`;
};
console.log(`\n#165 the email's TP1 with a wider stop on ${TF}, ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? ` — SYNTHETIC (${SYNTH}), seed ${SEED}` : ""}; TP1 5 pips; stops ${STOPS.map((s) => s ?? "none").join(", ")}; limits ${LIMITS.join(", ")} bars; every rule on the trades with ${NEED} bars in the data`);
console.log(checkLine("signals against indicatorSignals", check));
console.log(checkLine("S10 L30 against #164's now, Snone against #164's hold", refCheck));
console.log(checkLine("out at TP1 or the limit under a stop, the same under the next wider", nestCheck));
console.log(checkLine("exit closes against the 4-hour bar's own", closeCheck));
console.log(`GMO reads that failed: ${coverage.reduce((a, c) => a + c.failed, 0)}`);
const ORDER = ["either", "either BUY", "either SELL", "qtrend", "qtrend BUY", "qtrend SELL", "strong", "strong BUY", "strong SELL", "ultra", "ultra BUY", "ultra SELL", "coin", "coin BUY", "coin SELL"];
for (const key of ORDER) {
  if (!groups.has(key)) continue;
  for (const half of [0, 1] as const) {
    console.log(`\n== ${key}, ${half === 0 ? "first" : "second"} half`);
    for (const r of RULES) console.log(ruleLine(key, half, r.key));
  }
}

// THE PICK, on the first half; THE CALL, on the second
const e = groups.get("either");
let verdict = "no signals";
let pick: string | null = null;
if (e) {
  console.log(`\n== THE PICK: the emails' signals, first half, pips a trade`);
  let best = -Infinity;
  for (const key of PICKS) {
    const m = meanOf(e[0].get(key)!).m ?? -Infinity;
    console.log(`  ${key.padEnd(12)} ${num(m)}`);
    if (m > best) {
      best = m;
      pick = key;
    }
  }
  const s = e[1];
  const pm = meanOf(s.get(pick!)!).m;
  const nm = meanOf(s.get(NOW_RULE)!).m;
  const d = s.get(pick! + DIFF)!;
  const los = [meanOf(d).lo, meanOf(d, "blocks").lo];
  const lo = los.some((x) => x === null) ? null : Math.min(...(los as number[]));
  const clearly = pm !== null && nm !== null && pm > nm && lo !== null && lo > 0;
  verdict = clearly ? `${pick} is clearly better than now for the emails' signals` : `${pick} is not clearly better than now for the emails' signals`;
  console.log(`  the pick: ${pick} (first half ${num(best)}; now ${num(meanOf(e[0].get(NOW_RULE)!).m)})`);
  console.log(`\n== VERDICT: on the second half ${pick} ${num(pm)} against now ${num(nm)}; the difference ${num(meanOf(d).m)}, its low end ${num(lo)} → ${verdict}`);
}

const aggOut = (a: Agg) => ({ ...meanOf(a), lo4: meanOf(a, "blocks").lo, hi4: meanOf(a, "blocks").hi, ...tailOf(a), n: a.n, wins: a.wins, exits: a.exits, bars: a.n ? a.bars / a.n : null });
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/widestop.json`, JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), synthetic: SYNTHETIC, synth: SYNTH, seed: SEED, coverage, check, refCheck, nestCheck, closeCheck, groups: Object.fromEntries([...groups].map(([k, g]) => [k, g.map((h) => Object.fromEntries([...h].map(([s, a]) => [s, aggOut(a)])))])), pick, verdict }, null, 1));
