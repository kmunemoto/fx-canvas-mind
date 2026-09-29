// #167: the emails' levels on gold (XAU/USD). The owner (2026-09-29): 「金も
// 測って」, after the stop on the currency pairs went to 30 pips (#166, docs
// §8.78) and gold's stayed at the video's $10, because gold had not been
// measured.
//
// THE MEASURE, fixed before any gold price was read:
//   * the prices: Dukascopy's gold, bid and ask (research/dukascopy.py): its
//     minute candles from 2024-01-01, and its hourly ones from 2021-01 for
//     the windows before. GMO, whose bid/ask the currency pairs were
//     measured on, has no gold, and the app reads gold's bars from Twelve
//     Data, whose key is not on GitHub. So these bars are not the emails'
//     own; how near they come is checked against the Twelve Data bars the
//     app keeps (BAR lines below, compared outside this program).
//   * the bars: mid ((bid + ask) / 2), rounded to cents as the chart draws
//     gold (live-chart historyRead). The 5- and 15-minute bars from the
//     minutes, on the UTC grid; the hourly, 4-hour and daily ones from the
//     hourly candles, on Twelve Data's grid as the bars the app keeps show
//     it (read 2026-09-29, before this study): hourly and daily on the UTC
//     grid (the daily bars since April 2025 include Sunday's two hours as a
//     bar of their own, and the newest, read at 00:11 UTC, held eleven
//     minutes); 4-hour bars from 01:00, 05:00 ... UTC in US summer time. In
//     winter the app's bars do not reach: GRID4=ny moves them with New York
//     (02:00, 06:00 ... UTC), GRID4=utc1 keeps 01:00 all year; the study is
//     run both ways.
//   * the signals: the emails' (indicatorSignals, as #157 and #165): Q-Trend's
//     BUY and SELL (STRONG or not) and ULTRA's, each bar judged with the 600
//     bars to it, from anchoredStart; only those the sweep mails: it reads a
//     Twelve Data chart a minute after the close and again three minutes
//     later, and not while the market may be shut (isPossiblyClosed).
//     Checked against indicatorSignals itself on a sample of bars and every
//     7th signal. The emails offer gold's hourly, 4-hour and daily charts;
//     the 5- and 15-minute ones are measured the same way, as the chart
//     shows them.
//   * the trades: entered at the signal bar's close on the side it fills on
//     (BUY the ask, SELL the bid); TP1 $5 from the bar's mid close (the
//     email's), and the stop S dollars from it, S = 10 (the email's now),
//     15, 20, 30, 50, 100 or none; followed on 5-minute bid/ask bars built
//     from the minutes (as the pairs were on GMO's 5-minute bars), on the
//     side it goes out on: out at whichever a bar reaches first (both in one
//     5-minute bar: the stop; a bar opening past one: at that open), or at
//     the close after L five-minute bars: L = 1380 (five days of gold's 23
//     hours) or, on the 4-hour chart, 5520 too (four weeks). Every rule on
//     the same trades: those whose longest limit lies inside the data.
//   * told, per chart: for each stop (five days), the share out at TP1 of
//     those out at TP1 or at the stop (the email's win rate), and dollars a
//     trade (spread paid; one still in at the limit at that close), with its
//     95% interval by week (and by four weeks), on each half (split
//     2025-05-19) and on the whole; a coin the same way (both sides at a
//     hashed sample of the chart's closes; every close on the 4-hour chart).
//   * THE PICK AND THE CALL, as #165's (§8.77), on the 4-hour chart the
//     owner's emails come from: among S 15, 20, 30, 50, 100 and L five days,
//     four weeks (ten), the one with the most dollars a trade on the first
//     half for the emails' signals (either); called clearly better if on the
//     second half its dollars a trade are above now's (S 10, five days) and
//     the low end of the difference (the lower of the intervals by week and
//     by four weeks) is above 0. Whether anything changes is the owner's to
//     decide on the numbers.
//   * checks: the signals against indicatorSignals; the hourly files'
//     candles against the minutes' (2024 on); the signal bar's close against
//     the 5-minute bar ending there; a trade out at TP1 or at the limit under
//     a stop the same trade under the next wider one; the data's days.
//
// SYNTHETIC=1: a seeded random walk instead (SEED; each 5-minute bar 100
// small steps, as #165's "path" walks; a 5-minute bar's move about $1.2, the
// spread $0.30), every timeframe built from it, gold's hours (the FX week
// less its daily hour): every rule must come out near the spread's cost, and
// the call quiet.
//
// ON RANDOM WALKS (before any gold price was read; 50 seeds, 7 .. 130):
//   * every check 0 differ on every seed.
//   * each rule's dollars a trade against the spread's cost: near it (on
//     the 4-hour chart, z of the difference from −$0.30 mean −0.12 to +0.04
//     and sd 1.08 to 1.21 for S 10 to 50); the email's win rate at S 10 on
//     the 5-minute chart 65.7% (seed 7), a driftless walk's 10/15 = 66.7%
//     less the spread.
//   * THE CALL fired on 5 of the 50 (seeds 29, 43, 104, 119, 124): four times
//     on S 100 (L five days or four weeks), once on S 30. A rule's own
//     interval holds for S 15 to 50 (z of "rule less now" on a half: sd 1.00
//     to 1.17), but not for S 100 (mean z +0.28 to +0.35, sd 1.16 to 1.30): its
//     rare large loss is missing from most halves, which then look better
//     and surer than they are. On the currency pairs (#165, 14 pairs, many
//     more trades) the call was quiet on all ten walks; on gold's one chart
//     a "clearly better" S 100 is not to be trusted on the call alone.
//   * the same walk's 4-hour bars an hour apart (GRID4) gave other signals
//     and, on the second half, now −$0.34 against +$0.38 a trade (seed 7):
//     with about 200 trades a half, a number moves that much by chance.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isGoldBreak, isMarketClosed, isPossiblyClosed, nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ultra } from "../supabase/functions/_shared/ultra.ts";
import { indicatorSignals } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, iso } from "./lib.ts";

const PAIR = "XAU/USD";
const TFS = ["5min", "15min", "1h", "4h", "1day"] as const;
type Tf = (typeof TFS)[number];
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const SYNTHETIC = Boolean(Deno.env.get("SYNTHETIC"));
const SEED = Number(Deno.env.get("SEED") || 7);
// the 4-hour grid: "ny" — from 17:00 New York (01:00, 05:00 ... UTC in US
// summer time, 02:00, 06:00 ... in winter); "utc1" — from 01:00 UTC all year
const GRID4 = Deno.env.get("GRID4") === "utc1" ? "utc1" : "ny";
// the daily grid: "utc" — the UTC day (Twelve Data's now); "ny-end" — 17:00
// New York to 17:00, stamped 00:00 UTC of the day it ends (kept for a check)
const GRIDD = Deno.env.get("GRIDD") === "ny-end" ? "ny-end" : "utc";
const GRID = `4h ${GRID4}, daily ${GRIDD}`;
const CACHE = "research/.cache/dukascopy/XAUUSD";
const OUT = "research/out";
const FINE = 5 * MINUTE;
const WINDOW = 600;
const UNIT = 1;
const TP1 = 5;
// the stops, dollars from the bar's mid close (null: none), and the limits,
// 5-minute bars: five days of gold's 23 hours, four weeks
const STOPS = [10, 15, 20, 30, 50, 100, null] as const;
type Stop = (typeof STOPS)[number];
const L5D = 5 * 23 * 12;
const L4W = 4 * L5D;
const LIMITS_OF = (tf: Tf): number[] => (tf === "4h" ? [L5D, L4W] : [L5D]);
const limitName = (l: number) => (l === L5D ? "5d" : "4w");
const ruleKey = (s: Stop, l: number) => `S${s ?? "none"} L${limitName(l)}`;
const NOW_RULE = ruleKey(10, L5D);
const PICKS = [L5D, L4W].flatMap((l) => STOPS.filter((s) => s !== null && s > 10).map((s) => ruleKey(s, l)));
// the sweep reads a Twelve Data chart a minute after the close and again
// three minutes later (signal-alerts twelveCloseDue, TWELVE_RETRY_MS)
const READ_AFTER = [1, 4];
const mailed = (closeMs: number): boolean => READ_AFTER.some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// bars checked against indicatorSignals, and the coin's sample
const CHECK_EVERY: Record<Tf, number> = { "5min": 661, "15min": 223, "1h": 53, "4h": 13, "1day": 3 };
const COIN_EVERY: Record<Tf, number> = { "5min": 100, "15min": 33, "1h": 8, "4h": 1, "1day": 1 };
// the periods the app's Twelve Data bars reach (read 2026-09-29): the bars
// here printed for the comparison
const COMPARE_FROM: Partial<Record<Tf, number>> = {
  "1h": Date.parse("2026-08-26T00:00:00Z"),
  "4h": Date.parse("2026-05-18T00:00:00Z"),
  "1day": Date.parse("2024-04-09T00:00:00Z"),
};

// ---- the prices ----------------------------------------------------------------------

interface Series {
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
const newSeries = (n: number): Series => ({
  n,
  t: new Float64Array(n),
  bo: new Float64Array(n),
  bh: new Float64Array(n),
  bl: new Float64Array(n),
  bc: new Float64Array(n),
  ao: new Float64Array(n),
  ah: new Float64Array(n),
  al: new Float64Array(n),
  ac: new Float64Array(n),
});
type Row = [number, number, number, number, number, number];

const listDir = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".json")) out.push(e.name);
  } catch {
    // none kept
  }
  return out.sort();
};

// bid and ask candles of the files named in both sides' folders, joined on
// their time (a candle on one side only is counted and left out)
const readJoined = async (kind: "m1" | "h1", keep: (name: string) => boolean) => {
  const names = (await listDir(`${CACHE}/${kind}/BID`)).filter(keep);
  const askNames = new Set((await listDir(`${CACHE}/${kind}/ASK`)).filter(keep));
  const rows: Array<[Row, Row]> = [];
  let oneSide = 0;
  let files = 0;
  const unmatchedFiles: string[] = [];
  for (const name of names) {
    if (!askNames.has(name)) {
      unmatchedFiles.push(name);
      continue;
    }
    files++;
    const b: Row[] = JSON.parse(await Deno.readTextFile(`${CACHE}/${kind}/BID/${name}`)).rows;
    const a: Row[] = JSON.parse(await Deno.readTextFile(`${CACHE}/${kind}/ASK/${name}`)).rows;
    const am = new Map(a.map((r) => [r[0], r]));
    for (const r of b) {
      const x = am.get(r[0]);
      if (x) {
        rows.push([r, x]);
        am.delete(r[0]);
      } else oneSide++;
    }
    oneSide += am.size;
  }
  for (const name of askNames) if (!names.includes(name)) unmatchedFiles.push(name);
  rows.sort((p, q) => p[0][0] - q[0][0]);
  const s = newSeries(rows.length);
  rows.forEach(([b, a], i) => {
    s.t[i] = b[0];
    s.bo[i] = b[1];
    s.bh[i] = b[2];
    s.bl[i] = b[3];
    s.bc[i] = b[4];
    s.ao[i] = a[1];
    s.ah[i] = a[2];
    s.al[i] = a[3];
    s.ac[i] = a[4];
  });
  return { series: s, files, oneSide, unmatchedFiles };
};

// a series put on a coarser grid: `keyOf` gives each candle's bar and
// `openOf` that bar's opening time
const regroup = (s: Series, keyOf: (t: number) => number, openOf: (k: number) => number): Series => {
  const idx: number[] = [];
  let last = Number.NaN;
  for (let i = 0; i < s.n; i++) {
    const k = keyOf(s.t[i]);
    if (k !== last) {
      idx.push(i);
      last = k;
    }
  }
  const out = newSeries(idx.length);
  idx.forEach((from, j) => {
    const to = j + 1 < idx.length ? idx[j + 1] : s.n;
    out.t[j] = openOf(keyOf(s.t[from]));
    out.bo[j] = s.bo[from];
    out.ao[j] = s.ao[from];
    out.bc[j] = s.bc[to - 1];
    out.ac[j] = s.ac[to - 1];
    let bh = -Infinity, bl = Infinity, ah = -Infinity, al = Infinity;
    for (let i = from; i < to; i++) {
      if (s.bh[i] > bh) bh = s.bh[i];
      if (s.bl[i] < bl) bl = s.bl[i];
      if (s.ah[i] > ah) ah = s.ah[i];
      if (s.al[i] < al) al = s.al[i];
    }
    out.bh[j] = bh;
    out.bl[j] = bl;
    out.ah[j] = ah;
    out.al[j] = al;
  });
  return out;
};

// the grids: each timeframe's bar key for a moment, and that bar's stamp
const nyLocal = (t: number) => t + nyOffsetMs(t);
const GRIDS: Record<Tf, { key: (t: number) => number; open: (k: number, t: number) => number }> = {
  "5min": { key: (t) => Math.floor(t / FINE), open: (k) => k * FINE },
  "15min": { key: (t) => Math.floor(t / (15 * MINUTE)), open: (k) => k * 15 * MINUTE },
  "1h": { key: (t) => Math.floor(t / HOUR), open: (k) => k * HOUR },
  "4h": GRID4 === "ny"
    ? { key: (t) => Math.floor((nyLocal(t) - HOUR) / (4 * HOUR)), open: (k, t) => k * 4 * HOUR + HOUR - nyOffsetMs(t) }
    : { key: (t) => Math.floor((t - HOUR) / (4 * HOUR)), open: (k) => k * 4 * HOUR + HOUR },
  "1day": GRIDD === "ny-end"
    // 17:00 New York to 17:00, stamped the UTC midnight of the day it ends
    ? { key: (t) => Math.floor((nyLocal(t) - 17 * HOUR) / DAY), open: (k) => (k + 1) * DAY }
    : { key: (t) => Math.floor(t / DAY), open: (k) => k * DAY },
};
// where a bar's prices end (its close), which for a daily bar stamped the
// day it ends is not its stamp and a day
const dataEndOf = (tf: Tf, stamp: number): number => {
  if (tf === "1day" && GRIDD === "ny-end") {
    // 17:00 New York on the stamped day
    const guess = stamp + 21 * HOUR;
    return stamp + 17 * HOUR - nyOffsetMs(guess);
  }
  return stamp + LIVE_STEP_MS[tf];
};
const put = (s: Series, tf: Tf): Series => {
  const g = GRIDS[tf];
  // the stamp is found from the first candle in the bar (a daily bar's DST
  // offset is its own)
  const firstT = new Map<number, number>();
  for (let i = 0; i < s.n; i++) {
    const k = g.key(s.t[i]);
    if (!firstT.has(k)) firstT.set(k, s.t[i]);
  }
  return regroup(s, g.key, (k) => g.open(k, firstT.get(k)!));
};

const quotesOf = (s: Series): QuoteCandle[] => {
  const out: QuoteCandle[] = new Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const dt = new Date(s.t[i]).toISOString();
    out[i] = {
      datetime: dt,
      bid: { datetime: dt, open: s.bo[i], high: s.bh[i], low: s.bl[i], close: s.bc[i] },
      ask: { datetime: dt, open: s.ao[i], high: s.ah[i], low: s.al[i], close: s.ac[i] },
    };
  }
  return out;
};

// a seeded random walk on 5 minutes, gold's hours; 100 small steps a bar
const synthetic5 = (fromMs: number, toMs: number): Series => {
  let seed = (SEED * 2654435761) | 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // a 5-minute bar's move about $1.2 (the sd of 100 steps of ±scale/20)
  const scale = 4.2;
  const spread = 0.3;
  const ts: number[] = [];
  const b: number[][] = [];
  let px = 2000;
  for (let ms = Math.floor(fromMs / FINE) * FINE; ms + FINE <= toMs; ms += FINE) {
    if (isMarketClosed(ms) || isGoldBreak(ms)) continue;
    const o = px;
    let h = o;
    let l = o;
    for (let k = 0; k < 100; k++) {
      px += (rnd() - 0.5) * (scale / 10);
      if (px > h) h = px;
      if (px < l) l = px;
    }
    ts.push(ms);
    b.push([o, h, l, px]);
  }
  const s = newSeries(ts.length);
  ts.forEach((t, i) => {
    s.t[i] = t;
    [s.bo[i], s.bh[i], s.bl[i], s.bc[i]] = b[i];
    s.ao[i] = b[i][0] + spread;
    s.ah[i] = b[i][1] + spread;
    s.al[i] = b[i][2] + spread;
    s.ac[i] = b[i][3] + spread;
  });
  return s;
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

// ---- load ------------------------------------------------------------------------------

const dataInfo: Record<string, unknown> = {};
let fine: Series;
let hourly: Series;
if (SYNTHETIC) {
  const from = Date.UTC(2021, 0, 1);
  const to = Date.UTC(2026, 8, 29);
  const s = synthetic5(from, to);
  fine = s;
  hourly = regroup(s, GRIDS["1h"].key, (k) => GRIDS["1h"].open(k, 0));
  dataInfo.synthetic = { seed: SEED, bars5: s.n };
} else {
  const m1 = await readJoined("m1", (name) => name.slice(0, 10) >= new Date(START_MS - 14 * DAY).toISOString().slice(0, 10));
  const h1 = await readJoined("h1", () => true);
  fine = regroup(m1.series, GRIDS["5min"].key, (k) => GRIDS["5min"].open(k, 0));
  hourly = h1.series;
  // the data's days: weekdays (and Sundays) from START with no minute
  const haveDays = new Set<string>();
  for (let i = 0; i < m1.series.n; i++) haveDays.add(new Date(m1.series.t[i]).toISOString().slice(0, 10));
  const lastDay = m1.series.n ? new Date(m1.series.t[m1.series.n - 1]).toISOString().slice(0, 10) : START;
  const missing: string[] = [];
  for (let t = START_MS; new Date(t).toISOString().slice(0, 10) <= lastDay; t += DAY) {
    const d = new Date(t);
    const day = d.getUTCDay();
    // Saturdays closed; a Friday or Sunday may hold only a few hours
    if (day === 6) continue;
    const key = d.toISOString().slice(0, 10);
    // 25 Dec and 1 Jan: gold may not trade
    if (key.endsWith("-12-25") || key.endsWith("-01-01")) continue;
    if (!haveDays.has(key)) missing.push(key);
  }
  // the hourly files against the minutes (2024 on): every hour both hold
  const hm = regroup(m1.series, GRIDS["1h"].key, (k) => GRIDS["1h"].open(k, 0));
  let compared = 0;
  let differ = 0;
  const examples: string[] = [];
  const at = new Map<number, number>();
  for (let i = 0; i < hourly.n; i++) at.set(hourly.t[i], i);
  for (let j = 0; j < hm.n; j++) {
    const i = at.get(hm.t[j]);
    if (i === undefined) continue;
    compared++;
    const d = Math.max(
      Math.abs(hm.bo[j] - hourly.bo[i]), Math.abs(hm.bh[j] - hourly.bh[i]), Math.abs(hm.bl[j] - hourly.bl[i]), Math.abs(hm.bc[j] - hourly.bc[i]),
      Math.abs(hm.ao[j] - hourly.ao[i]), Math.abs(hm.ah[j] - hourly.ah[i]), Math.abs(hm.al[j] - hourly.al[i]), Math.abs(hm.ac[j] - hourly.ac[i]),
    );
    if (d > 0.0015) {
      differ++;
      if (examples.length < 10) examples.push(`${iso(hm.t[j])} by ${d.toFixed(3)}`);
    }
  }
  const hourlyOnly = hourly.n ? [iso(hourly.t[0]), iso(hourly.t[hourly.n - 1])] : null;
  dataInfo.minutes = { candles: m1.series.n, files: m1.files, oneSide: m1.oneSide, unmatchedFiles: m1.unmatchedFiles.slice(0, 20), first: m1.series.n ? iso(m1.series.t[0]) : null, last: m1.series.n ? iso(m1.series.t[m1.series.n - 1]) : null, missingDays: missing };
  dataInfo.hours = { candles: hourly.n, files: h1.files, oneSide: h1.oneSide, unmatchedFiles: h1.unmatchedFiles.slice(0, 20), span: hourlyOnly };
  dataInfo.hoursAgainstMinutes = { compared, differ, examples };
}
// the data's end: the last 5-minute bar's close
const NOW = fine.t[fine.n - 1] + FINE;
console.log(`data: ${JSON.stringify(dataInfo)}`);

// ---- the records -----------------------------------------------------------------------

type Side = "BUY" | "SELL";
type Exit = "tp" | "sl" | "amb" | "time";
interface Trade {
  usd: number;
  exit: Exit;
  bars: number;
}
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
const addTo = (a: Agg, week: number, usd: number, t?: Trade) => {
  a.n++;
  a.sum += usd;
  a.all.push(usd);
  if (usd > 0) {
    a.wins++;
    a.winSum += usd;
  } else a.lossSum += usd;
  if (t) {
    a.bars += t.bars;
    a.exits[t.exit]++;
  }
  for (const [m, k] of [[a.weeks, week], [a.blocks, Math.floor(week / 4)]] as const) {
    const w = m.get(k) ?? { n: 0, s: 0 };
    w.n++;
    w.s += usd;
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
const tailOf = (a: Agg) => {
  if (a.n === 0) return { worst: null as number | null, p5: null as number | null };
  const xs = [...a.all].sort((x, y) => x - y);
  return { worst: xs[0], p5: xs[Math.floor(0.05 * (xs.length - 1))] };
};
// the email's win rate: out at TP1 of those out at TP1 or at the stop
const tpRate = (a: Agg): number | null => {
  const d = a.exits.tp + a.exits.sl + a.exits.amb;
  return d ? a.exits.tp / d : null;
};
// group ("<tf> <set>") → [first half, second half, all] of each rule (by its
// key) and each rule less now (its key and " − now")
const HALVES = [0, 1, 2] as const;
type Half = (typeof HALVES)[number];
const groups = new Map<string, Array<Map<string, Agg>>>();
const aggOf = (key: string, half: Half, series: string) => {
  let g = groups.get(key);
  if (!g) {
    g = [new Map(), new Map(), new Map()];
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
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
const same = (a: Trade, b: Trade) => a.usd === b.usd && a.exit === b.exit && a.bars === b.bars;
const newCheck = () => ({ compared: 0, mismatched: 0, examples: [] as string[] });
const check = Object.fromEntries(TFS.map((tf) => [tf, newCheck()])) as Record<Tf, ReturnType<typeof newCheck>>;
const nestCheck = newCheck();
const closeCheck = newCheck();
const spreadPaid: Record<string, number[]> = {};
interface Cover {
  tf: Tf;
  bars: number;
  first: string | null;
  last: string | null;
  judged: number;
  noWindow: number;
  signals: number;
  unmailed: number;
  qtrend: number;
  strong: number;
  ultra: number;
  trades: number;
  tooLate: number;
}
const coverage: Cover[] = [];
const compareLines: string[] = [];

// a trade from 5-minute bar `from` on: out at `tp`, at `sl` (none: null) or
// after `limit` bars at the close; null when the data ends first
const follow = (from: number, side: Side, fill: number, tp: number, sl: number | null, limit: number): Trade | null => {
  const last = from + limit - 1;
  if (from < 0 || last > fine.n - 1) return null;
  const buy = side === "BUY";
  const o = buy ? fine.bo : fine.ao;
  const h = buy ? fine.bh : fine.ah;
  const l = buy ? fine.bl : fine.al;
  const c = buy ? fine.bc : fine.ac;
  const usdOf = (exit: number) => (buy ? exit - fill : fill - exit);
  for (let j = from; j <= last; j++) {
    const bars = j - from + 1;
    if (sl !== null && (buy ? o[j] <= sl : o[j] >= sl)) return { usd: usdOf(o[j]), exit: "sl", bars };
    if (buy ? o[j] >= tp : o[j] <= tp) return { usd: usdOf(o[j]), exit: "tp", bars };
    const hitSl = sl !== null && (buy ? l[j] <= sl : h[j] >= sl);
    const hitTp = buy ? h[j] >= tp : l[j] <= tp;
    if (hitSl && hitTp) return { usd: usdOf(sl!), exit: "amb", bars };
    if (hitSl) return { usd: usdOf(sl!), exit: "sl", bars };
    if (hitTp) return { usd: usdOf(tp), exit: "tp", bars };
  }
  return { usd: usdOf(c[last]), exit: "time", bars: limit };
};

// a hashed sample of bars (murmur3's finaliser)
const mix = (a: number): number => {
  a ^= a >>> 16;
  a = Math.imul(a, 0x85ebca6b);
  a ^= a >>> 13;
  a = Math.imul(a, 0xc2b2ae35);
  a ^= a >>> 16;
  return a >>> 0;
};
const sampled = (t: number, every: number): boolean => every <= 1 || mix(mix(7919) ^ Math.floor(t / MINUTE)) % every === 0;

// ---- each chart ------------------------------------------------------------------------

for (const tf of TFS) {
  const step = LIVE_STEP_MS[tf];
  const base = tf === "5min" ? fine : tf === "15min" ? put(fine, "15min") : tf === "1h" ? hourly : put(hourly, tf);
  const quotes = quotesOf(base);
  // the chart's bars: mid, rounded to cents, closed by the data's end
  const candles = historyRead(PAIR, tf, quotes, NOW).candles;
  const byOpen = new Map(quotes.map((q) => [barOpenMs(q.datetime), q]));
  const n = candles.length;
  const times = new Float64Array(n);
  candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
  const qs = Array.from(times, (t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${tf}: a chart bar without its quote`);

  const anchorOf = (i: number): { ws: number; s: number } | null => {
    if (i < WINDOW - 1) return null;
    const ws = i - WINDOW + 1;
    const w = times.subarray(ws, i + 1) as unknown as number[];
    const last = i - ws;
    const firstShown = Math.max(0, last - (CHART_BARS - 1));
    return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
  };

  // the bars judged: those closing (as the app counts) at or after START
  const i0 = lowerBound(times, START_MS - step);
  const signals: Array<{ i: number; rule: "qtrend" | "ultra"; side: Side; strong: boolean }> = [];
  const judgedBar = new Uint8Array(n);
  let noWindow = 0;
  let judged = 0;
  let seg: { s: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!seg) return;
    const bars = candles.slice(seg.s, seg.to + 1);
    const qt = qTrend(bars, QT_DEFAULTS, bars.length - 1);
    for (const x of qt.signals) {
      const at = seg.s + x.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "qtrend", side: x.side, strong: x.strong });
    }
    const ul = ultra(bars, bars.length - 1, UNIT);
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
    judgedBar[i] = 1;
    if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
    else {
      flush();
      seg = { s: a.s, from: i, to: i };
    }
  }
  flush();
  signals.sort((a, b) => a.i - b.i || a.rule.localeCompare(b.rule));

  // the check: the emails' own function on a sample of bars and every 7th signal
  const mine = new Map<number, string[]>();
  const key = (x: { rule: string; side: string; strong: boolean }) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`;
  for (const s of signals) mine.set(s.i, [...(mine.get(s.i) ?? []), key(s)]);
  const probe = (i: number) => {
    const a = anchorOf(i);
    if (!a) return;
    const theirs = indicatorSignals(PAIR, tf, candles.slice(a.ws, i + 1), times[i] + step + 60_000, 120_000)
      .filter((x) => Date.parse(x.barTime) === times[i])
      .map(key)
      .sort()
      .join(",");
    const ours = [...(mine.get(i) ?? [])].sort().join(",");
    const c = check[tf];
    c.compared++;
    if (theirs !== ours) {
      c.mismatched++;
      if (c.examples.length < 10) c.examples.push(`${iso(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
    }
  };
  for (let i = 0; i < n; i += CHECK_EVERY[tf]) if (judgedBar[i]) probe(i);
  signals.forEach((s, k) => {
    if (k % 7 === 0) probe(s.i);
  });

  // for the comparison with the app's Twelve Data bars
  const cmpFrom = COMPARE_FROM[tf];
  if (cmpFrom !== undefined && !SYNTHETIC) {
    for (let i = lowerBound(times, cmpFrom); i < n; i++) {
      const c = candles[i];
      compareLines.push(`BAR ${tf} ${iso(times[i])} ${c.open} ${c.high} ${c.low} ${c.close}`);
    }
    for (const s of signals) if (times[s.i] >= cmpFrom) compareLines.push(`SIG ${tf} ${iso(times[s.i])} ${key(s)}`);
  }

  // the trades
  const limits = LIMITS_OF(tf);
  const rules = limits.flatMap((l) => STOPS.map((s) => ({ key: ruleKey(s, l), stop: s, limit: l })));
  const need = Math.max(...limits);
  const sets4h = tf === "4h";
  let tooLate = 0;
  // every rule on one trade at bar i's close; false when the data does not hold it
  const recordAt = (i: number, side: Side, sets: string[]): boolean => {
    const T = dataEndOf(tf, times[i]);
    const e = lowerBound(fine.t, T);
    if (e + need - 1 > fine.n - 1) {
      tooLate++;
      return false;
    }
    const buy = side === "BUY";
    const q = qs[i];
    const fill = buy ? q.ask.close : q.bid.close;
    const close = candles[i].close;
    const dir = buy ? 1 : -1;
    const tp = close + dir * TP1 * UNIT;
    const got = new Map<string, Trade>();
    for (const r of rules) {
      const t = follow(e, side, fill, tp, r.stop === null ? null : close - dir * r.stop * UNIT, r.limit);
      if (!t) return false;
      got.set(r.key, t);
    }
    const tag = `${tf} ${iso(T)} ${side}`;
    for (const l of limits) {
      for (let k = 0; k + 1 < STOPS.length; k++) {
        const a = got.get(ruleKey(STOPS[k], l))!;
        if (a.exit !== "tp" && a.exit !== "time") continue;
        const b = got.get(ruleKey(STOPS[k + 1], l))!;
        nestCheck.compared++;
        if (!same(a, b)) {
          nestCheck.mismatched++;
          if (nestCheck.examples.length < 10) nestCheck.examples.push(`${tag} ${ruleKey(STOPS[k], l)} ${a.exit} ${a.usd} / ${ruleKey(STOPS[k + 1], l)} ${b.exit} ${b.usd}`);
        }
      }
    }
    const half: Half = T < SPLIT_MS ? 0 : 1;
    const week = weekOf(T);
    const now = got.get(NOW_RULE)!;
    for (const set of sets) {
      for (const h of [half, 2] as const) {
        for (const r of rules) {
          const t = got.get(r.key)!;
          addTo(aggOf(`${tf} ${set}`, h, r.key), week, t.usd, t);
          if (r.key !== NOW_RULE) addTo(aggOf(`${tf} ${set}`, h, r.key + DIFF), week, t.usd - now.usd);
        }
      }
    }
    return true;
  };

  const sent = signals.filter((s) => mailed(times[s.i] + step));
  let trades = 0;
  const eitherSeen = new Set<string>();
  for (const sg of sent) {
    // the signal bar's close against the 5-minute bar ending there
    const T = dataEndOf(tf, times[sg.i]);
    const j = lowerBound(fine.t, T - FINE);
    closeCheck.compared++;
    if (!(j < fine.n && fine.t[j] === T - FINE && Math.abs(fine.bc[j] - qs[sg.i].bid.close) < 0.0015 && Math.abs(fine.ac[j] - qs[sg.i].ask.close) < 0.0015)) {
      closeCheck.mismatched++;
      if (closeCheck.examples.length < 10) closeCheck.examples.push(`${tf} ${iso(times[sg.i])} bar ${qs[sg.i].bid.close}/${qs[sg.i].ask.close} 5-min ${j < fine.n ? `${iso(fine.t[j])} ${fine.bc[j]}/${fine.ac[j]}` : "none"}`);
    }
    const sets = sg.rule === "qtrend" ? ["qtrend", ...(sg.strong ? ["strong"] : [])] : ["ultra"];
    const ek = `${sg.i}:${sg.side}`;
    const first = !eitherSeen.has(ek);
    if (first) sets.push("either");
    if (sets4h) sets.push(...sets.map((s) => `${s} ${sg.side}`));
    if (!recordAt(sg.i, sg.side, sets) || !first) continue;
    eitherSeen.add(ek);
    trades++;
    const sp = spreadPaid[tf] ?? (spreadPaid[tf] = []);
    sp.push(qs[sg.i].ask.close - qs[sg.i].bid.close);
  }
  // the coin: both sides at a sample of the bars judged (every one on 4h)
  for (let i = 0; i < n; i++) {
    if (!judgedBar[i] || !mailed(times[i] + step) || !sampled(times[i], COIN_EVERY[tf])) continue;
    for (const side of ["BUY", "SELL"] as const) recordAt(i, side, sets4h ? ["coin", `coin ${side}`] : ["coin"]);
  }
  const cover: Cover = {
    tf,
    bars: n,
    first: n ? iso(times[0]) : null,
    last: n ? iso(times[n - 1]) : null,
    judged,
    noWindow,
    signals: signals.length,
    unmailed: signals.length - sent.length,
    qtrend: sent.filter((s) => s.rule === "qtrend").length,
    strong: sent.filter((s) => s.rule === "qtrend" && s.strong).length,
    ultra: sent.filter((s) => s.rule === "ultra").length,
    trades,
    tooLate,
  };
  coverage.push(cover);
  console.log(`${tf.padEnd(5)}: ${n} bars ${cover.first} .. ${cover.last}, judged ${judged} (${noWindow} without a window); mailed Q-Trend ${cover.qtrend} (${cover.strong} STRONG), ULTRA ${cover.ultra}, not mailed ${cover.unmailed}; trades (either) ${trades}`);
}

// ---- the report ------------------------------------------------------------------------

const num = (x: number | null, d = 2) => (x === null ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pct = (a: number | null) => (a === null ? "  -  " : `${(100 * a).toFixed(1)}%`);
const ci = (r: { lo: number | null; hi: number | null }, r4: { lo: number | null; hi: number | null }) => `[${num(r.lo)},${num(r.hi)}] (4 wk [${num(r4.lo)},${num(r4.hi)}])`;
const checkLine = (what: string, c: { compared: number; mismatched: number; examples: string[] }) =>
  `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
const halfName = (h: Half) => (h === 0 ? "first half" : h === 1 ? "second half" : "whole");

console.log(`\n#167 the emails' levels on gold (${PAIR}), ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? ` — SYNTHETIC, seed ${SEED}` : ""}; grid ${GRID}; TP1 $${TP1}; stops ${STOPS.map((s) => s ?? "none").join(", ")} dollars; limits ${L5D} (5d) and, on 4h, ${L4W} (4w) five-minute bars`);
for (const tf of TFS) console.log(checkLine(`signals against indicatorSignals, ${tf}`, check[tf]));
console.log(checkLine("out at TP1 or the limit under a stop, the same under the next wider", nestCheck));
console.log(checkLine("the signal bar's close against the 5-minute bar ending there", closeCheck));
for (const [tf, xs] of Object.entries(spreadPaid)) {
  const s = [...xs].sort((a, b) => a - b);
  console.log(`spread paid at the signals' closes, ${tf}: median $${s[Math.floor(s.length / 2)]?.toFixed(3)}, 90% $${s[Math.floor(0.9 * (s.length - 1))]?.toFixed(3)} (${s.length})`);
}
console.log(`trades not taken, their limit past the data's end: ${coverage.map((c) => `${c.tf} ${c.tooLate}`).join(", ")}`);

// A. each chart, each stop (five days): the email's win rate and dollars a trade
console.log(`\n== A. each chart and stop, five days: out at TP1 of those out at TP1 or the stop; dollars a trade [95% by week] (first half; second half); trades; still in at five days`);
for (const tf of TFS) {
  for (const set of ["either", "qtrend", "strong", "ultra", "coin"]) {
    const g = groups.get(`${tf} ${set}`);
    if (!g) continue;
    console.log(`-- ${tf} ${set}`);
    for (const s of STOPS) {
      const k = ruleKey(s, L5D);
      const a = g[2].get(k)!;
      const r = meanOf(a);
      const f = meanOf(g[0].get(k) ?? newAgg()).m;
      const sc = meanOf(g[1].get(k) ?? newAgg()).m;
      console.log(`  S${String(s ?? "none").padEnd(4)} TP1 first ${pct(tpRate(a))}  ${num(r.m)} [${num(r.lo)},${num(r.hi)}] (${num(f)}; ${num(sc)})  n ${a.n}  time ${pct(a.n ? a.exits.time / a.n : null)}`);
    }
  }
}

// B. the 4-hour chart, as #165: every rule, each half, less now, the pick and the call
const ruleLine = (key: string, half: Half, rule: string) => {
  const a = groups.get(key)![half].get(rule)!;
  const r = meanOf(a);
  const r4 = meanOf(a, "blocks");
  const t = tailOf(a);
  const out = (Object.keys(a.exits) as Exit[]).filter((k) => a.exits[k] > 0).map((k) => `${k} ${pct(a.exits[k] / a.n)}`).join(" ");
  const head = `  ${(rule + (rule === NOW_RULE ? " (now)" : "")).padEnd(17)} ${num(r.m)} ${ci(r, r4)} $/trade of ${String(a.n).padStart(5)}; TP1 first ${pct(tpRate(a))}, won ${pct(a.wins / Math.max(1, a.n))}, avg win ${num(a.wins ? a.winSum / a.wins : null, 1)}, avg loss ${num(a.n - a.wins ? a.lossSum / (a.n - a.wins) : null, 1)}, worst ${num(t.worst, 1)}, worst 5% from ${num(t.p5, 1)}, 5-min bars ${(a.bars / Math.max(1, a.n)).toFixed(0)}; ${out}`;
  if (rule === NOW_RULE) return head;
  const d = groups.get(key)![half].get(rule + DIFF)!;
  return `${head}\n  ${"".padEnd(17)} less now ${num(meanOf(d).m)} ${ci(meanOf(d), meanOf(d, "blocks"))}`;
};
const RULES_4H = LIMITS_OF("4h").flatMap((l) => STOPS.map((s) => ruleKey(s, l)));
for (const set of ["either", "either BUY", "either SELL", "qtrend", "strong", "ultra", "coin", "coin BUY", "coin SELL"]) {
  const key = `4h ${set}`;
  if (!groups.has(key)) continue;
  for (const half of HALVES) {
    console.log(`\n== B. ${key}, ${halfName(half)}`);
    for (const r of RULES_4H) console.log(ruleLine(key, half, r));
  }
}
const e = groups.get("4h either");
let verdict = "no signals";
let pick: string | null = null;
if (e) {
  console.log(`\n== THE PICK: the emails' signals on the 4-hour chart, first half, dollars a trade`);
  let best = -Infinity;
  for (const k of PICKS) {
    const m = meanOf(e[0].get(k)!).m ?? -Infinity;
    console.log(`  ${k.padEnd(12)} ${num(m)}`);
    if (m > best) {
      best = m;
      pick = k;
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

if (compareLines.length) {
  console.log("\nCOMPARE BEGIN");
  for (const l of compareLines) console.log(l);
  console.log("COMPARE END");
}

const aggOut = (a: Agg) => ({ ...meanOf(a), lo4: meanOf(a, "blocks").lo, hi4: meanOf(a, "blocks").hi, ...tailOf(a), n: a.n, wins: a.wins, tpFirst: tpRate(a), exits: a.exits, bars: a.n ? a.bars / a.n : null });
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(
  `${OUT}/gold${SYNTHETIC ? `-synthetic-${SEED}` : ""}-${GRID4}-${GRIDD}.json`,
  JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), grid: GRID, synthetic: SYNTHETIC, seed: SEED, data: dataInfo, coverage, check, nestCheck, closeCheck, groups: Object.fromEntries([...groups].map(([k, g]) => [k, g.map((h) => Object.fromEntries([...h].map(([s, a]) => [s, aggOut(a)])))])), pick, verdict }, null, 1),
);
