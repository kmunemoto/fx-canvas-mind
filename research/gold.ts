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
//     minutes, on the UTC grid. The hourly, 4-hour and daily ones from hourly
//     candles (built from the minutes where they are held, Dukascopy's hourly
//     files before: the month in progress has no hourly file yet; the two
//     agree, checked below), cut as the app holds Twelve Data's (GRID4=tw,
//     GRIDD=tw, FILL=twelve), which was found before this study's results
//     were seen, from the Twelve Data bars the app keeps against Dukascopy's
//     mid at the hour (the CLOSE lines of the "Research gold" workflow; read
//     2026-09-29 and 30):
//     - Twelve Data prices every hour from Sunday 17:00 UTC to Friday 21:00
//       as the app keeps them (it drops a bar wholly inside the weekend,
//       barFullyClosed): the Sunday hours before the open, Friday's hour
//       after the close (US summer) and the daily hour off, all at about the
//       last price (a range of $0.3 to $1.7 at the median; five weeks of
//       hourly bars, 19 of 4-hour). Dukascopy has no prices then. FILL=twelve
//       puts in a flat bar at the last bid and ask for each such hour: on a
//       Friday after its last hour to 21:00, on a Sunday from 17:00 to the
//       open, and a gap of one or two hours on a weekday (FILL=none: not).
//     - the 4-hour bars from 01:00, 05:00 ... UTC (kept 2026-05-19 to 09-30).
//     - the daily bars (kept from 2025-11-11, the feed as it is now) end at
//       07:00 Sydney: 21:00 UTC, and 20:00 while Sydney keeps summer time
//       (the first Sunday of October to the first Sunday of April); each
//       weekday alike, the close $0.39 to $0.91 from the mid then at the
//       median, against $2.9 to $9.7 an hour off. A bar is stamped the UTC
//       date it ends on. So there is a small bar on Sunday (the hours before
//       the open; 46 of 46 weeks), and in Sydney's summer Friday's last
//       hours fall in a bar stamped Saturday, which the app drops.
//     - not known: the 4-hour grid while Sydney keeps summer time (the kept
//       bars do not reach it). GRID4=tw takes it with the day (00:00, 04:00
//       ... UTC), GRID4=ny with 17:00 New York (02:00, 06:00 ... in US
//       winter), GRID4=utc1 at 01:00 all year; the study is run each way.
//     Twelve Data cut its daily bars other ways before (17:00 New York to
//     2025-04-16, then some other way); the emails read them as they are now.
//     The daily email comes at 00:01 UTC, three or four hours after the bar
//     ends; its trade is still entered at the bar's close, as every chart's.
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
//     (BUY the ask, SELL the bid); the target and the stop from the bar's
//     mid close (as the email's); followed on 5-minute bid/ask bars built
//     from the minutes (as the pairs were on GMO's 5-minute bars), on the
//     side it goes out on: out at whichever a bar reaches first (both in one
//     5-minute bar: the stop; a bar opening past one: at that open), or at
//     the close after L five-minute bars: L = 1380 (five days of gold's 23
//     hours) or, on the 4-hour chart, 5520 too (four weeks). Every rule on
//     the same trades: those whose longest limit lies inside the data.
//   * the rules: the target T and the stop S in dollars, T = 5 (the email's
//     TP1 now), 15, 30 or 50, and S = 10 (the email's now), 15, 20, 30, 50,
//     100 or none; and six set by the chart's own range, ATR(14) at the
//     signal bar (Pine's, as Q-Trend's ε): T 0.5, 1 or 2 times it and S 1 or
//     2 times it. Now: T 5, S 10, five days.
//     The targets and the range-set rules were added before any gold price
//     was read: the owner, shown gold's 4-hour chart with TP1..TP3 inside
//     one bar's range, asked 「tp低すぎない？」; told that the app's gold bars
//     range $3.4 (5 minutes), $6.6 (15), $14.3 (hourly) and $30.3 (4-hour)
//     at the median, and offered wider targets measured: 「1で」.
//   * told, per chart: for each rule (five days), the share out at the
//     target of those out at the target or the stop (the email's win rate
//     at T 5), and dollars a trade (spread paid; one still in at the limit
//     at that close), with its 95% interval by week (and by four weeks), on
//     each half (split 2025-05-19) and on the whole; a coin the same way
//     (both sides at a hashed sample of the chart's closes; every close on
//     the 4-hour chart).
//   * THE PICK AND THE CALL, as #165's (§8.77), on the 4-hour chart the
//     owner's emails come from: among every rule but now and those with a
//     stop of $100 or none, both limits (51), the one with the most dollars
//     a trade on the first half for the emails' signals (either); called
//     clearly better if on the second half its dollars a trade are above
//     now's and the low end of the difference (the lower of the intervals
//     by week and by four weeks) is above 0. The stops of $100 and none are
//     told but not called: on the random walks their intervals do not hold
//     (below). Whether anything changes is the owner's to decide on the
//     numbers.
//   * checks: the signals against indicatorSignals; the hourly files'
//     candles against the minutes' (2024 on); the signal bar's close against
//     the last 5-minute bar before its end; a trade out at the target or at
//     the limit under a stop the same trade under the next wider one (the
//     same target); the data's days.
//
// SYNTHETIC=1: a seeded random walk instead (SEED; each 5-minute bar 100
// small steps, as #165's "path" walks; a 5-minute bar's move about $1.2, the
// spread $0.30), every timeframe built from it, gold's hours (the FX week
// less its daily hour): every rule must come out near the spread's cost, and
// the call quiet.
//
// ON RANDOM WALKS, the stops alone (T 5), before the targets were added
// (before any gold price was read; 50 seeds, 7 .. 130; this section and the
// next with the bars cut GRID4=ny, daily on the UTC day, no flat hours):
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
//
// ON RANDOM WALKS, with the targets (the same 50 seeds, still before any
// gold price was read):
//   * every check 0 differ on every seed.
//   * a rule's interval against the walks, "rule less now" on the 4-hour
//     chart, each half (100): for the stops up to $50 and the range-set
//     rules, z's sd 0.87 to 1.12 by week (0.94 to 1.19 by four weeks) and
//     its mean −0.05 to +0.27; for a stop of $100 or none, sd 0.96 to 1.59
//     and mean +0.12 to +0.67 (T5 none, four weeks: z above 1.96 on 17 of
//     the 100 halves) — the rare large loss again.
//   * with every rule a candidate (67), the pick was a stop of $100 or none
//     on 31 of the 50 and the call fired on 3 (seeds 31, 41, 101; all none,
//     four weeks). With those left out (51, as fixed above) it fired on 1
//     (seed 106, T30 S50 five days). Replayed from the runs' output, the 67
//     reproduce the program's own pick and call on all 50.
//
// ON RANDOM WALKS, the bars cut as the app holds Twelve Data's (GRID4=tw,
// GRIDD=tw, FILL=twelve; the same 50 seeds, before any of this study's
// results on gold were seen):
//   * every check 0 differ on every seed (350).
//   * "rule less now" on the 4-hour chart, each half (100): for the
//     candidates, z's sd 0.89 to 1.08 by week (0.95 to 1.15 by four weeks),
//     its mean −0.08 to +0.19; for a stop of $100 or none, sd 0.96 to 1.46
//     and mean +0.10 to +0.47 (T50 none, four weeks: z above 1.96 on 19 of
//     the 100 halves).
//   * the call (51 candidates) fired on 1 of the 50 (seed 53, T50 S50 four
//     weeks); with every rule a candidate (67) on 2 (seeds 41 and 53, both
//     none, four weeks), and the pick was a stop of $100 or none on 29.
//     Replayed from the runs' output, the 51 reproduce the program's own
//     pick and call on all 50.
//
// THE RESULT (2026-09-30, docs §8.79; the "Study gold" run 36657390402),
// 2024-01-01 to 2026-09-28, the bars cut as Twelve Data's (GRID4=tw,
// GRIDD=tw, FILL=twelve); the emails' signals (either), dollars a trade:
//   * the data: the minutes of 871 days (the three missing are Good
//     Fridays); the hourly files against the minutes, 3 of 15,978 hours
//     differ; every check 0 differ. These bars against the app's Twelve
//     Data bars: the daily 276 of 276 on the same stamps (the close $0.71
//     apart at the median; Twelve Data's Christmas bar not here), every one
//     of Twelve Data's 602 4-hour bars ($0.79), the hourly 557 ($0.87; three
//     of theirs, a US holiday's afternoon, not here). The one gold email in
//     the data's span (1h ULTRA BUY at 2026-09-28 22:00, RSI 30.12) is here
//     at 18:00 and 23:00, not at 22:00.
//   * now (T5 S10, five days): 5min −0.77 (TP first 64%), 15min −0.74
//     (64%), 1h −0.69 (64%), 4h −0.77 (63%), daily −1.36 (61%); the spread
//     paid $0.54 at the median ($0.73 daily); the coin on the 4-hour chart
//     −0.65 (64%).
//   * the 4-hour chart, whole, five days: T5 with S10 −0.77, S15 −0.86, S20
//     −1.59, S30 −1.75, S50 −1.26; S10 with T15 −0.88, T30 −0.09, T50
//     −0.06; T50 S50 +1.13; ATR T1×S2 +0.74, T2×S2 +1.66. The halves far
//     apart: T50 S50 −3.44 and +6.13, ATR T2×S2 −0.86 and +4.42.
//   * the pick: T50 S10 L4w (first half +0.51, now −0.74). On the second
//     half −0.33 against now −0.80; the difference +0.47 (its low end
//     −3.10): not clearly better. Its gain is the BUYs' (+4.63 a trade,
//     SELL −3.54), as the coin's (BUY +3.61, SELL −3.03): gold rose.
//   * the other cuts (GRID4=ny, GRID4=utc1, FILL=none): now on the 4-hour
//     chart −1.04, −0.68, −1.07; the pick T30 S15 L5d, T15 S20 L5d, T15 S30
//     L5d, each not clearly better (the second half's difference −0.72,
//     −1.41, −0.04). T50 S50 L5d's second half, +6.13 here, is −0.16,
//     +0.41 and +1.36 there.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barFullyClosed, isGoldBreak, isMarketClosed, isPossiblyClosed, nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ultra } from "../supabase/functions/_shared/ultra.ts";
import { pineAtr } from "../supabase/functions/_shared/pine.ts";
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
// the 4-hour grid (THE MEASURE, the bars): "tw" — with the day of 07:00
// Sydney (00:00, 04:00 ... UTC while Sydney keeps summer time, 01:00, 05:00
// ... else); "ny" — from 17:00 New York (01:00 ... in US summer time, 02:00
// ... in winter); "utc1" — from 01:00 UTC all year
const GRID4 = (["tw", "ny", "utc1"] as const).find((g) => g === Deno.env.get("GRID4")) ?? "tw";
// the daily grid: "tw" — 07:00 to 07:00 Sydney, stamped the UTC date it ends
// on (Twelve Data's now); "utc" — the UTC day; "ny-end" — 17:00 New York to
// 17:00, stamped the day it ends (Twelve Data's to 2025-04-16)
const GRIDD = (["tw", "utc", "ny-end"] as const).find((g) => g === Deno.env.get("GRIDD")) ?? "tw";
// the hours Twelve Data prices and Dukascopy does not: "twelve" — a flat bar
// at the last bid and ask; "none" — left out
const FILL = Deno.env.get("FILL") === "none" ? "none" : "twelve";
const GRID = `4h ${GRID4}, daily ${GRIDD}, fill ${FILL}`;
const CACHE = "research/.cache/dukascopy/XAUUSD";
const OUT = "research/out";
const FINE = 5 * MINUTE;
const WINDOW = 600;
const UNIT = 1;
// the targets and the stops, dollars from the bar's mid close (a stop null:
// none); the range-set ones, times the chart's ATR(14) at the signal bar;
// the limits, 5-minute bars: five days of gold's 23 hours, four weeks
const TARGETS = [5, 15, 30, 50] as const;
const STOPS = [10, 15, 20, 30, 50, 100, null] as const;
type Stop = (typeof STOPS)[number];
const ATR_RULES = [[0.5, 1], [0.5, 2], [1, 1], [1, 2], [2, 1], [2, 2]] as const;
const L5D = 5 * 23 * 12;
const L4W = 4 * L5D;
const LIMITS_OF = (tf: Tf): number[] => (tf === "4h" ? [L5D, L4W] : [L5D]);
const limitName = (l: number) => (l === L5D ? "5d" : "4w");
const ruleKey = (t: number, s: Stop, l: number) => `T${t} S${s ?? "none"} L${limitName(l)}`;
const atrKey = (k: number, m: number, l: number) => `T${k}atr S${m}atr L${limitName(l)}`;
interface Rule {
  key: string;
  // dollars, or times the ATR
  target: number;
  stop: number | null;
  atr: boolean;
  limit: number;
}
const rulesOf = (limits: number[]): Rule[] =>
  limits.flatMap((l) => [
    ...TARGETS.flatMap((t) => STOPS.map((s) => ({ key: ruleKey(t, s, l), target: t, stop: s, atr: false, limit: l }))),
    ...ATR_RULES.map(([k, m]) => ({ key: atrKey(k, m, l), target: k, stop: m, atr: true, limit: l })),
  ]);
const NOW_RULE = ruleKey(5, 10, L5D);
// THE PICK's candidates: every rule but now and those with a stop of $100 or
// none, whose interval does not hold on the random walks (below)
const PICKS = rulesOf(LIMITS_OF("4h")).filter((r) => r.key !== NOW_RULE && (r.atr || (r.stop !== null && r.stop <= 50))).map((r) => r.key);
// the sweep reads a Twelve Data chart a minute after the close and again
// three minutes later (signal-alerts twelveCloseDue, TWELVE_RETRY_MS)
const READ_AFTER = [1, 4];
const mailed = (closeMs: number): boolean => READ_AFTER.some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// bars checked against indicatorSignals, and the coin's sample
const CHECK_EVERY: Record<Tf, number> = { "5min": 661, "15min": 223, "1h": 53, "4h": 13, "1day": 3 };
const COIN_EVERY: Record<Tf, number> = { "5min": 100, "15min": 33, "1h": 8, "4h": 1, "1day": 1 };
// the periods the app's Twelve Data bars reach (read 2026-09-29; the daily
// ones as the feed is now): the bars here printed for the comparison
const COMPARE_FROM: Partial<Record<Tf, number>> = {
  "1h": Date.parse("2026-08-26T00:00:00Z"),
  "4h": Date.parse("2026-05-18T00:00:00Z"),
  "1day": Date.parse("2025-11-10T00:00:00Z"),
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

// Sydney's offset from UTC: summer time (+11) from the first Sunday of
// October, 02:00 standard time, to the first Sunday of April, 03:00 summer
// time — each 16:00 UTC the day before (the rule since 2008; the same as the
// tz database's Australia/Sydney at every quarter hour 2020-2026)
const sydneyOffsetMs = (ms: number): number => {
  const y = new Date(ms).getUTCFullYear();
  const firstSunday = (month: number) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7);
  };
  const end = Date.UTC(y, 3, firstSunday(3) - 1, 16);
  const start = Date.UTC(y, 9, firstSunday(9) - 1, 16);
  return ms < end || ms >= start ? 11 * HOUR : 10 * HOUR;
};
// GRID4=tw: the 4-hour grid's first hour, with the day of 07:00 Sydney
const twStart4 = (t: number) => (sydneyOffsetMs(t) === 11 * HOUR ? 0 : HOUR);

// the grids: each timeframe's bar key for a moment, and that bar's stamp
const nyLocal = (t: number) => t + nyOffsetMs(t);
const GRIDS: Record<Tf, { key: (t: number) => number; open: (k: number, t: number) => number }> = {
  "5min": { key: (t) => Math.floor(t / FINE), open: (k) => k * FINE },
  "15min": { key: (t) => Math.floor(t / (15 * MINUTE)), open: (k) => k * 15 * MINUTE },
  "1h": { key: (t) => Math.floor(t / HOUR), open: (k) => k * HOUR },
  "4h": GRID4 === "tw"
    ? { key: (t) => Math.floor((t - twStart4(t)) / (4 * HOUR)), open: (k, t) => k * 4 * HOUR + twStart4(t) }
    : GRID4 === "ny"
    ? { key: (t) => Math.floor((nyLocal(t) - HOUR) / (4 * HOUR)), open: (k, t) => k * 4 * HOUR + HOUR - nyOffsetMs(t) }
    : { key: (t) => Math.floor((t - HOUR) / (4 * HOUR)), open: (k) => k * 4 * HOUR + HOUR },
  "1day": GRIDD === "tw"
    // 07:00 to 07:00 Sydney, stamped the UTC midnight of the day it ends
    // (the Sydney date it starts on)
    ? { key: (t) => Math.floor((t + sydneyOffsetMs(t) - 7 * HOUR) / DAY), open: (k) => k * DAY }
    : GRIDD === "ny-end"
    // 17:00 New York to 17:00, stamped the UTC midnight of the day it ends
    ? { key: (t) => Math.floor((nyLocal(t) - 17 * HOUR) / DAY), open: (k) => (k + 1) * DAY }
    : { key: (t) => Math.floor(t / DAY), open: (k) => k * DAY },
};
// where a bar's prices end (its close), which for a daily bar stamped the
// day it ends is not its stamp and a day
const dataEndOf = (tf: Tf, stamp: number): number => {
  if (tf === "1day" && GRIDD === "tw") {
    // 07:00 Sydney the next day: 21:00 UTC on the stamped day, 20:00 in
    // Sydney's summer
    return stamp + 31 * HOUR - sydneyOffsetMs(stamp + 20 * HOUR);
  }
  if (tf === "1day" && GRIDD === "ny-end") {
    // 17:00 New York on the stamped day
    const guess = stamp + 21 * HOUR;
    return stamp + 17 * HOUR - nyOffsetMs(guess);
  }
  return stamp + LIVE_STEP_MS[tf];
};
// FILL=twelve: the hours Twelve Data prices and Dukascopy does not (THE
// MEASURE, the bars), each a flat hour at the last bid and ask: on a Friday
// after its last hour to 21:00, on a Sunday from 17:00 (the app's
// SUNDAY_PREOPEN_UTC_HOUR) to the open, and a gap of one or two hours on a
// weekday (the daily hour off). A longer gap (a day the data lacks) is left.
const fillCount = { friday: 0, sunday: 0, weekday: 0 };
const fillAsTwelve = (s: Series): Series => {
  const at: number[] = [];
  const src: number[] = [];
  const add = (t: number, i: number) => {
    at.push(t);
    src.push(i);
  };
  for (let i = 0; i < s.n; i++) {
    add(s.t[i], -1 - i);
    if (i + 1 >= s.n) break;
    const a = s.t[i];
    const b = s.t[i + 1];
    if (b - a <= HOUR) continue;
    if (b - a > DAY) {
      if (new Date(a).getUTCDay() === 5) {
        for (let h = a + HOUR; h <= Math.floor(a / DAY) * DAY + 21 * HOUR && h < b; h += HOUR) {
          add(h, i);
          fillCount.friday++;
        }
      }
      if (new Date(b).getUTCDay() === 0) {
        for (let h = Math.max(Math.floor(b / DAY) * DAY + 17 * HOUR, a + HOUR); h < b; h += HOUR) {
          add(h, i);
          fillCount.sunday++;
        }
      }
    } else if (b - a <= 3 * HOUR) {
      for (let h = a + HOUR; h < b; h += HOUR) {
        add(h, i);
        fillCount.weekday++;
      }
    }
  }
  const out = newSeries(at.length);
  at.forEach((t, j) => {
    out.t[j] = t;
    const k = src[j];
    if (k < 0) {
      const i = -1 - k;
      out.bo[j] = s.bo[i];
      out.bh[j] = s.bh[i];
      out.bl[j] = s.bl[i];
      out.bc[j] = s.bc[i];
      out.ao[j] = s.ao[i];
      out.ah[j] = s.ah[i];
      out.al[j] = s.al[i];
      out.ac[j] = s.ac[i];
    } else {
      out.bo[j] = out.bh[j] = out.bl[j] = out.bc[j] = s.bc[k];
      out.ao[j] = out.ah[j] = out.al[j] = out.ac[j] = s.ac[k];
    }
  });
  return out;
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
  // the hours used: from the minutes where they are held, the hourly files
  // before (the month in progress has no hourly file yet)
  if (hm.n) {
    const cut = lowerBound(hourly.t, hm.t[0]);
    const joined = newSeries(cut + hm.n);
    for (const k of ["t", "bo", "bh", "bl", "bc", "ao", "ah", "al", "ac"] as const) {
      joined[k].set(hourly[k].subarray(0, cut), 0);
      joined[k].set(hm[k], cut);
    }
    hourly = joined;
    dataInfo.hoursUsed = { fromFiles: cut, fromMinutes: hm.n, span: [iso(hourly.t[0]), iso(hourly.t[hourly.n - 1])] };
  }
}
if (FILL === "twelve") {
  hourly = fillAsTwelve(hourly);
  dataInfo.filledHours = fillCount;
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
  noAtr: number;
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
  // less the bars wholly inside the weekend, as the app drops Twelve Data's
  // (parseTwelveData): on the daily chart the one stamped Saturday
  const quotes = quotesOf(base).filter((q) => !barFullyClosed(barOpenMs(q.datetime), step));
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
  const rules = rulesOf(limits);
  const need = Math.max(...limits);
  const sets4h = tf === "4h";
  // the chart's ATR(14) at each bar (Pine's, from the first bar held)
  const atr = pineAtr(candles, 14);
  let tooLate = 0;
  let noAtr = 0;
  // every rule on one trade at bar i's close; false when the data does not hold it
  const recordAt = (i: number, side: Side, sets: string[]): boolean => {
    const T = dataEndOf(tf, times[i]);
    const e = lowerBound(fine.t, T);
    if (e + need - 1 > fine.n - 1) {
      tooLate++;
      return false;
    }
    const a = atr[i];
    if (a === null || !(a > 0)) {
      noAtr++;
      return false;
    }
    const buy = side === "BUY";
    const q = qs[i];
    const fill = buy ? q.ask.close : q.bid.close;
    const close = candles[i].close;
    const dir = buy ? 1 : -1;
    const got = new Map<string, Trade>();
    for (const r of rules) {
      const size = r.atr ? a : UNIT;
      const tp = close + dir * r.target * size;
      const sl = r.stop === null ? null : close - dir * r.stop * size;
      const t = follow(e, side, fill, tp, sl, r.limit);
      if (!t) return false;
      got.set(r.key, t);
    }
    const tag = `${tf} ${iso(T)} ${side}`;
    for (const l of limits) {
      for (const tgt of TARGETS) {
        for (let k = 0; k + 1 < STOPS.length; k++) {
          const x = got.get(ruleKey(tgt, STOPS[k], l))!;
          if (x.exit !== "tp" && x.exit !== "time") continue;
          const y = got.get(ruleKey(tgt, STOPS[k + 1], l))!;
          nestCheck.compared++;
          if (!same(x, y)) {
            nestCheck.mismatched++;
            if (nestCheck.examples.length < 10) nestCheck.examples.push(`${tag} ${ruleKey(tgt, STOPS[k], l)} ${x.exit} ${x.usd} / ${ruleKey(tgt, STOPS[k + 1], l)} ${y.exit} ${y.usd}`);
          }
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
    // the signal bar's close against the last 5-minute bar before its end
    // (the one ending there, or for a flat hour the last price)
    const T = dataEndOf(tf, times[sg.i]);
    const j = lowerBound(fine.t, T) - 1;
    closeCheck.compared++;
    if (!(j >= 0 && fine.t[j] >= times[sg.i] - 3 * DAY && Math.abs(fine.bc[j] - qs[sg.i].bid.close) < 0.0015 && Math.abs(fine.ac[j] - qs[sg.i].ask.close) < 0.0015)) {
      closeCheck.mismatched++;
      if (closeCheck.examples.length < 10) closeCheck.examples.push(`${tf} ${iso(times[sg.i])} bar ${qs[sg.i].bid.close}/${qs[sg.i].ask.close} 5-min ${j >= 0 ? `${iso(fine.t[j])} ${fine.bc[j]}/${fine.ac[j]}` : "none"}`);
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
    noAtr,
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

console.log(`\n#167 the emails' levels on gold (${PAIR}), ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? ` — SYNTHETIC, seed ${SEED}` : ""}; grid ${GRID}; targets ${TARGETS.join(", ")} and stops ${STOPS.map((s) => s ?? "none").join(", ")} dollars; ATR(14) × ${ATR_RULES.map(([k, m]) => `${k}/${m}`).join(", ")} (target/stop); limits ${L5D} (5d) and, on 4h, ${L4W} (4w) five-minute bars`);
for (const tf of TFS) console.log(checkLine(`signals against indicatorSignals, ${tf}`, check[tf]));
console.log(checkLine("out at the target or the limit under a stop, the same under the next wider", nestCheck));
console.log(checkLine("the signal bar's close against the last 5-minute bar before its end", closeCheck));
for (const [tf, xs] of Object.entries(spreadPaid)) {
  const s = [...xs].sort((a, b) => a - b);
  console.log(`spread paid at the signals' closes, ${tf}: median $${s[Math.floor(s.length / 2)]?.toFixed(3)}, 90% $${s[Math.floor(0.9 * (s.length - 1))]?.toFixed(3)} (${s.length})`);
}
console.log(`trades not taken, their limit past the data's end: ${coverage.map((c) => `${c.tf} ${c.tooLate}`).join(", ")}; no ATR yet: ${coverage.map((c) => `${c.tf} ${c.noAtr}`).join(", ")}`);

// A. each chart, five days: every target and stop, dollars a trade and the
// share out at the target of those out at the target or the stop
const cell = (a: Agg | undefined, withRate = true) => {
  if (!a || a.n === 0) return "      -       ";
  const m = meanOf(a).m!;
  return withRate ? `${num(m).padStart(7)} (${(100 * (tpRate(a) ?? 0)).toFixed(0).padStart(3)}%)` : num(m).padStart(7);
};
const matrix = (g: Array<Map<string, Agg>>, half: Half, withRate: boolean) => {
  console.log(`         ${STOPS.map((s) => `S${s ?? "none"}`.padStart(withRate ? 14 : 7)).join(" ")}`);
  for (const t of TARGETS) console.log(`  T${String(t).padEnd(4)}  ${STOPS.map((s) => cell(g[half].get(ruleKey(t, s, L5D)), withRate)).join(" ")}`);
  console.log(`  ATR    ${ATR_RULES.map(([k, m]) => `T${k}×S${m} ${cell(g[half].get(atrKey(k, m, L5D)), withRate)}`).join("  ")}`);
};
console.log(`\n== A. each chart, five days: dollars a trade (out at the target of those out at the target or the stop)`);
for (const tf of TFS) {
  for (const set of ["either", "qtrend", "ultra", "coin"]) {
    const g = groups.get(`${tf} ${set}`);
    if (!g) continue;
    const now = g[2].get(NOW_RULE);
    console.log(`-- ${tf} ${set}, whole: ${now?.n ?? 0} trades; now (T5 S10) ${num(now ? meanOf(now).m : null)} [${num(now ? meanOf(now).lo : null)},${num(now ? meanOf(now).hi : null)}]`);
    matrix(g, 2, true);
    if (set === "either") {
      for (const h of [0, 1] as const) {
        console.log(`-- ${tf} ${set}, ${halfName(h)}: ${g[h].get(NOW_RULE)?.n ?? 0} trades`);
        matrix(g, h, false);
      }
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
  const head = `  ${(rule + (rule === NOW_RULE ? " (now)" : "")).padEnd(21)} ${num(r.m)} ${ci(r, r4)} $/trade of ${String(a.n).padStart(5)}; target first ${pct(tpRate(a))}, won ${pct(a.wins / Math.max(1, a.n))}, avg win ${num(a.wins ? a.winSum / a.wins : null, 1)}, avg loss ${num(a.n - a.wins ? a.lossSum / (a.n - a.wins) : null, 1)}, worst ${num(t.worst, 1)}, worst 5% from ${num(t.p5, 1)}, 5-min bars ${(a.bars / Math.max(1, a.n)).toFixed(0)}; ${out}`;
  if (rule === NOW_RULE) return head;
  const d = groups.get(key)![half].get(rule + DIFF)!;
  return `${head}\n  ${"".padEnd(21)} less now ${num(meanOf(d).m)} ${ci(meanOf(d), meanOf(d, "blocks"))}`;
};
const RULES_4H = rulesOf(LIMITS_OF("4h")).map((r) => r.key);
for (const half of HALVES) {
  if (!groups.has("4h either")) break;
  console.log(`\n== B. 4h either, ${halfName(half)}`);
  for (const r of RULES_4H) console.log(ruleLine("4h either", half, r));
}
const e = groups.get("4h either");
let verdict = "no signals";
let pick: string | null = null;
if (e) {
  console.log(`\n== THE PICK: the emails' signals on the 4-hour chart, first half, dollars a trade`);
  let best = -Infinity;
  for (const k of PICKS) {
    const m = meanOf(e[0].get(k)!).m ?? -Infinity;
    console.log(`  ${k.padEnd(21)} ${num(m)}`);
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
  console.log(`\n== the pick and now on the 4-hour chart's other sets, whole`);
  for (const set of ["either BUY", "either SELL", "qtrend", "strong", "ultra", "coin", "coin BUY", "coin SELL"]) {
    if (!groups.has(`4h ${set}`)) continue;
    console.log(`-- 4h ${set}`);
    console.log(ruleLine(`4h ${set}`, 2, NOW_RULE));
    console.log(ruleLine(`4h ${set}`, 2, pick!));
  }
}

// #168: the emails' gold levels since the owner's choice on THE RESULT (docs
// §8.80: TP1 $30, TP2 $60 and TP3 $90, the stop $10), as the email tells
// them: on each chart and for each indicator, the share out at TP1 of those
// out at TP1 or the stop, and dollars a trade (all of it out at TP1 or the
// stop, or after five days)
const MAIL_RULE = ruleKey(30, 10, L5D);
console.log(`\n== MAIL: ${MAIL_RULE} (the emails' TP1 and stop since #168), whole: out at TP1 of those out at TP1 or the stop %, dollars a trade`);
for (const tf of TFS) {
  for (const set of ["qtrend", "ultra", "either"]) {
    const a = groups.get(`${tf} ${set}`)?.[2].get(MAIL_RULE);
    if (!a) continue;
    const r = meanOf(a);
    console.log(`MAIL ${tf} ${set} n=${a.n} win=${(100 * (tpRate(a) ?? 0)).toFixed(1)} usd=${num(r.m)} [${num(r.lo)},${num(r.hi)}]`);
  }
}

if (compareLines.length) {
  console.log("\nCOMPARE BEGIN");
  for (const l of compareLines) console.log(l);
  console.log("COMPARE END");
}

const aggOut = (a: Agg) => ({ ...meanOf(a), lo4: meanOf(a, "blocks").lo, hi4: meanOf(a, "blocks").hi, ...tailOf(a), n: a.n, wins: a.wins, tpFirst: tpRate(a), exits: a.exits, bars: a.n ? a.bars / a.n : null });
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(
  `${OUT}/gold${SYNTHETIC ? `-synthetic-${SEED}` : ""}-${GRID4}-${GRIDD}-${FILL}.json`,
  JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), grid: GRID, synthetic: SYNTHETIC, seed: SEED, data: dataInfo, coverage, check, nestCheck, closeCheck, groups: Object.fromEntries([...groups].map(([k, g]) => [k, g.map((h) => Object.fromEntries([...h].map(([s, a]) => [s, aggOut(a)])))])), pick, verdict }, null, 1),
);
