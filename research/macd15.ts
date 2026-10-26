// #384 (docs §8.127): counting only. The owner moved the MACD email (v6's zone rule: the blue line into the top or
// bottom 95% band of the newest 120 bars' MACD pane, judged on 600 closed bars) from the 1-hour chart to the
// 15-minute chart of the same instruments (「メールの判断15分足に変更して」, 2026-10-26). How many emails would the
// 15-minute chart of the five GMO pairs have given over the last 52 weeks, and the 1-hour chart over the same weeks?
// No win rate, no profit: nothing is followed after the bar.
//
//   GMO's day files (research/.cache, tf-winrate's layout; fetched when missing: GitHub's runners reach GMO, the
//   development container cannot) -> trend-data loadTf (mergeSides, the weekend "inside") -> the chart's own
//   historyRead (rounded as drawn) -> _shared/macd-level.ts decideZoneOnWindow at every closed bar (the code the
//   sweep mails with), on the LEVEL_WINDOW bars ending at it alone.
//   A bar is counted as mailed when one of the sweep's reads of it (indicators.ts gmoIntervalsDue: the 15-minute
//   chart 0, 1 and 3 minutes after its close, the 1-hour chart 0, 3 and 5) is not in isPossiblyClosed (the sweep
//   does not run then); a decision on a bar no read can see is counted apart (notMailed).
//
// Writes OUT/rows.csv (every decision, the doubles written as JS writes them) and OUT/summary.json; research/
// macd15-check.py reads the same files with its own code and must find the same rows and counts.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import { decideZoneOnWindow, LEVEL_WINDOW, ZONE_BARS } from "../supabase/functions/_shared/macd-level.ts";
import { macd } from "../supabase/functions/_shared/macd.ts";
import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { type LoadStats, type Source, newLoadStats } from "./ownerhold-data.ts";
import { loadTf, quotesOf } from "./trend-data.ts";
import { weekendOutOf } from "./trend-labels.ts";
import { DAY, HOUR, MINUTE } from "./lib.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const START = Date.parse(env("START", "2025-10-26T21:00:00Z"));
const END = Date.parse(env("END", "2026-10-24T00:00:00Z"));
// the bars before START the 600-bar window reads (600 15-minute bars are some six trading days; 600 hourly bars
// some five weeks)
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2025-09-01T00:00:00Z"));
const OUT = env("OUT", "research/out/macd15");
// the chart adds this share of the pane's height above and below as it draws the MACD pane (docs §8.119)
const MARGIN = 0.08;

type Tf = "15min" | "1h";
const STEP: Record<Tf, number> = { "15min": 15 * MINUTE, "1h": HOUR };
// indicators.ts gmoIntervalsDue
const READS: Record<Tf, readonly number[]> = { "15min": [0, 1, 3], "1h": [0, 3, 5] };
const mailedAt = (tf: Tf, T: number): boolean => READS[tf].some((m) => !isPossiblyClosed(T + m * MINUTE + 1000));

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
// GMO's day: 21:00 UTC to 21:00 UTC (the morning check's day)
const gmoDay = (t: number) => iso(Math.floor((t + 3 * HOUR) / DAY) * DAY).slice(0, 10);

interface Bar {
  t: number;
  close: number;
}
interface Row {
  tf: Tf;
  pair: string;
  open: number;
  side: "BUY" | "SELL";
  m: number;
  s: number;
  top: number;
  bottom: number;
  mailed: boolean;
  // which line set the side's edge: the MACD line, the signal line or the histogram
  edgeBy: "m" | "s" | "h";
  // the MACD line as a share of the way from zero to the drawn edge (the 120 closed bars' pane with the margin)
  drawn: number;
}

const barsOf = (pair: string, tf: Tf, bars: ReturnType<typeof quotesOf>): Bar[] =>
  historyRead(pair, tf, bars, END).candles.map((c) => ({ t: Date.parse(c.datetime.replace(" ", "T") + "Z"), close: c.close }));

const decide = (pair: string, tf: Tf, bars: Bar[]): { rows: Row[]; judged: number; short: number } => {
  const rows: Row[] = [];
  let judged = 0;
  let short = 0;
  for (let i = 0; i < bars.length; i++) {
    const T = bars[i].t + STEP[tf];
    if (T < START || T > END) continue;
    if (i + 1 < LEVEL_WINDOW) {
      short++;
      continue;
    }
    judged++;
    const d = decideZoneOnWindow(bars, i);
    if (d === null) continue;
    const r = macd(bars.slice(i - LEVEL_WINDOW + 1, i + 1).map((b) => b.close));
    const k = LEVEL_WINDOW - 1;
    const s = r.signal[k] as number;
    const sell = d.side === "SELL";
    let edgeBy: Row["edgeBy"] = "m";
    let best = 0;
    for (const [name, xs] of [["m", r.macd], ["s", r.signal], ["h", r.hist]] as const) {
      for (let j = k - ZONE_BARS + 1; j <= k; j++) {
        const v = xs[j] as number;
        if (sell ? v > best : v < best) {
          best = v;
          edgeBy = name;
        }
      }
    }
    const height = d.top - d.bottom;
    const drawnEdge = sell ? d.top + MARGIN * height : d.bottom - MARGIN * height;
    rows.push({ tf, pair, open: bars[i].t, side: d.side, m: d.m, s, top: d.top, bottom: d.bottom, mailed: mailedAt(tf, T), edgeBy, drawn: d.m / drawnEdge });
  }
  return { rows, judged, short };
};

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
};

const statsOf = (rows: Row[], bars: Bar[], tf: Tf) => {
  const mailed = rows.filter((r) => r.mailed);
  const days = new Map<string, number>();
  for (const r of mailed) days.set(gmoDay(r.open + STEP[tf]), (days.get(gmoDay(r.open + STEP[tf])) ?? 0) + 1);
  // the peaks and valleys: runs of the MACD line on one side of zero (from the bars' own MACD, every bar), how many
  // emails each run had
  const perRun: Record<string, number> = {};
  if (mailed.length) {
    const r = macd(bars.map((b) => b.close));
    const idx = new Map(bars.map((b, i) => [b.t, i]));
    let run = 0;
    let sign = 0;
    const runOf = new Int32Array(bars.length);
    for (let i = 0; i < bars.length; i++) {
      const v = r.macd[i];
      const sg = v === null ? 0 : v > 0 ? 1 : v < 0 ? -1 : sign;
      if (sg !== sign) run++;
      sign = sg;
      runOf[i] = run;
    }
    const per = new Map<number, number>();
    for (const x of mailed) {
      const i = idx.get(x.open)!;
      per.set(runOf[i], (per.get(runOf[i]) ?? 0) + 1);
    }
    for (const n of per.values()) perRun[n >= 4 ? "4+" : String(n)] = (perRun[n >= 4 ? "4+" : String(n)] ?? 0) + 1;
  }
  const drawn = mailed.map((r) => r.drawn);
  return {
    entries: rows.length,
    mailed: mailed.length,
    notMailed: rows.length - mailed.length,
    sell: mailed.filter((r) => r.side === "SELL").length,
    buy: mailed.filter((r) => r.side === "BUY").length,
    perWeek: mailed.length / ((END - START) / (7 * DAY)),
    daysWithMail: days.size,
    maxInADay: Math.max(0, ...days.values()),
    // the signal line on the other side of zero from the MACD line at the entry (the line just across zero)
    crossZero: mailed.filter((r) => (r.side === "SELL" ? r.s < 0 : r.s > 0)).length,
    edgeBy: { m: mailed.filter((r) => r.edgeBy === "m").length, s: mailed.filter((r) => r.edgeBy === "s").length, h: mailed.filter((r) => r.edgeBy === "h").length },
    drawn: { min: drawn.length ? Math.min(...drawn) : null, median: quantile(drawn, 0.5), max: drawn.length ? Math.max(...drawn) : null, at95: drawn.filter((x) => x >= 0.95).length, at90: drawn.filter((x) => x >= 0.9).length },
    perRun,
  };
};

const g = (x: number) => String(x);

if (import.meta.main) {
  const mode = env("MODE", "real");
  if (mode === "print") {
    console.log(await Deno.readTextFile(`${OUT}/summary.json`));
    Deno.exit(0);
  }
  const src: Source = { dir: env("CACHE", "research/.cache"), fetch: env("FETCH", "yes") === "yes" };
  const st: LoadStats = newLoadStats();
  const weekend = weekendOutOf("inside");
  const pairs: Record<string, unknown>[] = [];
  const all: Row[] = [];
  for (const pair of PAIRS) {
    const out: Record<string, unknown> = { pair };
    for (const tf of ["15min", "1h"] as const) {
      const got = await loadTf(src, pair, tf, LOAD_FROM, END, st, weekend);
      const bars = barsOf(pair, tf, quotesOf(got.bars));
      const d = decide(pair, tf, bars);
      all.push(...d.rows);
      out[tf] = { bars: bars.length, first: bars.length ? iso(bars[0].t) : null, last: bars.length ? iso(bars[bars.length - 1].t) : null, judged: d.judged, short: d.short, ...statsOf(d.rows, bars, tf) };
      console.log(`${pair} ${tf}: ${bars.length} bars, judged ${d.judged} (short ${d.short}), entries ${d.rows.length}`);
    }
    pairs.push(out);
  }
  await Deno.mkdir(OUT, { recursive: true });
  const head = "tf,pair,open,side,m,s,top,bottom,mailed,edgeBy,drawn";
  await Deno.writeTextFile(
    `${OUT}/rows.csv`,
    [head, ...all.map((r) => [r.tf, r.pair, iso(r.open), r.side, g(r.m), g(r.s), g(r.top), g(r.bottom), r.mailed ? 1 : 0, r.edgeBy, g(r.drawn)].join(","))].join("\n") + "\n",
  );
  await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify({ meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), margin: MARGIN }, pairs, load: st }, null, 1));
  console.log(`rows ${all.length}; load ${JSON.stringify(st)}`);
}
