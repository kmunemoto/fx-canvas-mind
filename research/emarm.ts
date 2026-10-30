// #387 (docs §8.130): the owner's video's way (20 EMA and 200 EMA cross, the return move to the horizontal
// neckline: research/ema-return-spec.md) on the 15-minute chart of the five GMO pairs over the last 52 weeks.
// Counting, and the levels followed: how many entries the email would have given, how far each setup ran from its
// cross, whether the 600-bar window decides as one long scan would, and what the video's stop and first target
// (and the owner's way: no stop, the first target only) came to. Spread not paid; nothing else is assumed.
//
//   GMO's day files (research/.cache, fetched when missing: GitHub's runners reach GMO, the development container
//   cannot) -> trend-data loadTf (mergeSides, the weekend "inside") -> the chart's own historyRead (the mid of bid
//   and ask, rounded as drawn) -> _shared/ema-return.ts (the code the chart and the email decide with):
//     window  every closed bar judged on the EMA_RETURN.window bars ending at it alone (emaReturnMarks, `full`):
//             the email's decision
//     long    one scan over every bar loaded (from LOAD_FROM): the same rule with the lines' history unbroken
//   A bar is counted as mailed when one of the sweep's reads of it (indicators.ts gmoIntervalsDue: the 15-minute
//   chart 0, 1 and 3 minutes after its close) is not in isPossiblyClosed.
//
// The levels followed from the bar after the entry to the last bar loaded, bar by bar:
//   video  the stop and the first target (A): a bar opening at or past one is closed at its open; else a bar
//          reaching the stop and the target both is "both" (which came first is not in the bar; no P/L); else the
//          one reached, at its price. Neither by the last bar: "open", at the last close.
//   owner  no stop, the first target only (as above without the stop); the deepest the price went against the
//          entry (MAE, the bars up to and including the exit's) and the bars held. Not reached: "open".
// P/L in pips (0.01 on a yen pair, 0.0001 on the others), the entry the entry bar's close.
//
// MODE=walkfiles: seeded walks (ownerhold-data synthesize, SEED) written as GMO's files under OUT/gmo first, and the
// study read from them (no network): the Python is checked on them before any real data is read.
//
// Writes OUT/rows.csv (every window entry), OUT/long.csv (every long-scan entry) and OUT/summary.json, the doubles
// as JS writes them; research/emarm-check.py builds the bars from the same files with its own code, decides with
// a rule written from the spec alone, and must find the same rows and numbers.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import { EMA_RETURN, emaReturnMarks, emaReturnScan, type ErBar, type ErEntry } from "../supabase/functions/_shared/ema-return.ts";
import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { type LoadStats, type Source, newLoadStats, synthesize, writeGmoFiles } from "./ownerhold-data.ts";
import { loadTf, quotesOf } from "./trend-data.ts";
import { weekendOutOf } from "./trend-labels.ts";
import { DAY, MINUTE } from "./lib.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const START = Date.parse(env("START", "2025-10-26T21:00:00Z"));
const END = Date.parse(env("END", "2026-10-29T21:00:00Z"));
// the bars before START the window reads (600 15-minute bars are some six trading days), and the long scan's run-in
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2025-09-01T00:00:00Z"));
const OUT = env("OUT", "research/out/emarm");
const STEP = 15 * MINUTE;
// indicators.ts gmoIntervalsDue
const READS = [0, 1, 3] as const;
const mailedAt = (T: number): boolean => READS.some((m) => !isPossiblyClosed(T + m * MINUTE + 1000));

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const pipOf = (pair: string) => (pair.includes("JPY") ? 0.01 : 0.0001);

interface Bar extends ErBar {
  t: number;
}

type VideoRes = "tp" | "stop" | "both" | "open";
type OwnerRes = "tp" | "open";
interface Row {
  pair: string;
  e: ErEntry;
  mailed: boolean;
  long: boolean;
  vRes: VideoRes;
  vBars: number;
  vPips: number | null;
  oRes: OwnerRes;
  oBars: number;
  oPips: number;
  oMae: number;
}

const barsOf = (pair: string, bars: ReturnType<typeof quotesOf>): Bar[] =>
  historyRead(pair, "15min", bars, END).candles.map((c) => ({ t: Date.parse(c.datetime.replace(" ", "T") + "Z"), o: c.open, h: c.high, l: c.low, c: c.close }));

// the video's levels from the bar after the entry
const followVideo = (bars: Bar[], e: ErEntry, pip: number): { res: VideoRes; bars: number; pips: number | null } => {
  const d = e.side === "BUY" ? 1 : -1;
  const pipsAt = (x: number) => ((x - e.entry) * d) / pip;
  for (let j = e.at + 1; j < bars.length; j++) {
    const b = bars[j];
    const pastStop = (x: number) => (d === 1 ? x <= e.stop : x >= e.stop);
    const pastTp = (x: number) => (d === 1 ? x >= e.tp1 : x <= e.tp1);
    if (pastStop(b.o)) return { res: "stop", bars: j - e.at, pips: pipsAt(b.o) };
    if (pastTp(b.o)) return { res: "tp", bars: j - e.at, pips: pipsAt(b.o) };
    const s = pastStop(d === 1 ? b.l : b.h);
    const t = pastTp(d === 1 ? b.h : b.l);
    if (s && t) return { res: "both", bars: j - e.at, pips: null };
    if (s) return { res: "stop", bars: j - e.at, pips: pipsAt(e.stop) };
    if (t) return { res: "tp", bars: j - e.at, pips: pipsAt(e.tp1) };
  }
  return { res: "open", bars: bars.length - 1 - e.at, pips: pipsAt(bars[bars.length - 1].c) };
};

// the owner's way: no stop, the first target only
const followOwner = (bars: Bar[], e: ErEntry, pip: number): { res: OwnerRes; bars: number; pips: number; mae: number } => {
  const d = e.side === "BUY" ? 1 : -1;
  const pipsAt = (x: number) => ((x - e.entry) * d) / pip;
  let mae = 0;
  for (let j = e.at + 1; j < bars.length; j++) {
    const b = bars[j];
    const against = -pipsAt(d === 1 ? b.l : b.h);
    if (against > mae) mae = against;
    if (d === 1 ? b.o >= e.tp1 : b.o <= e.tp1) return { res: "tp", bars: j - e.at, pips: pipsAt(b.o), mae };
    if (d === 1 ? b.h >= e.tp1 : b.l <= e.tp1) return { res: "tp", bars: j - e.at, pips: pipsAt(e.tp1), mae };
  }
  return { res: "open", bars: bars.length - 1 - e.at, pips: pipsAt(bars[bars.length - 1].c), mae };
};

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
};
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);

const statsOf = (rows: Row[], longRows: { e: ErEntry; inWindow: boolean }[], weeks: number) => {
  const tp = rows.filter((r) => r.vRes === "tp");
  const st = rows.filter((r) => r.vRes === "stop");
  const decided = [...tp, ...st];
  const ages = rows.map((r) => r.e.at - r.e.x);
  const oTp = rows.filter((r) => r.oRes === "tp");
  const oOpen = rows.filter((r) => r.oRes === "open");
  return {
    entries: rows.length,
    mailed: rows.filter((r) => r.mailed).length,
    buy: rows.filter((r) => r.e.side === "BUY").length,
    sell: rows.filter((r) => r.e.side === "SELL").length,
    perWeek: rows.length / weeks,
    // bars from the cross to the entry
    age: { median: quantile(ages, 0.5), p90: quantile(ages, 0.9), max: ages.length ? Math.max(...ages) : null },
    rr: { median: quantile(rows.map((r) => r.e.rr), 0.5), min: rows.length ? Math.min(...rows.map((r) => r.e.rr)) : null },
    risk: { median: quantile(rows.map((r) => Math.abs(r.e.entry - r.e.stop)), 0.5) },
    tp2: rows.filter((r) => r.e.tp2 !== null).length,
    long: {
      entries: longRows.length,
      both: rows.filter((r) => r.long).length,
      windowOnly: rows.filter((r) => !r.long).length,
      longOnly: longRows.filter((x) => !x.inWindow).length,
      // a cross more than window - warm - 1 bars before the entry: the window cannot see it
      longOnlyOld: longRows.filter((x) => !x.inWindow && x.e.at - x.e.x > EMA_RETURN.window - EMA_RETURN.warm - 1).length,
    },
    video: {
      tp: tp.length,
      stop: st.length,
      both: rows.filter((r) => r.vRes === "both").length,
      open: rows.filter((r) => r.vRes === "open").length,
      winPct: decided.length ? (100 * tp.length) / decided.length : null,
      avgWin: mean(tp.map((r) => r.vPips as number)),
      avgLoss: mean(st.map((r) => r.vPips as number)),
      sumDecided: sum(decided.map((r) => r.vPips as number)),
      perTrade: mean(decided.map((r) => r.vPips as number)),
      openPips: sum(rows.filter((r) => r.vRes === "open").map((r) => r.vPips as number)),
      barsMedian: quantile(decided.map((r) => r.vBars), 0.5),
    },
    owner: {
      tp: oTp.length,
      open: oOpen.length,
      avgWin: mean(oTp.map((r) => r.oPips)),
      openPips: sum(oOpen.map((r) => r.oPips)),
      openWorst: oOpen.length ? Math.min(...oOpen.map((r) => r.oPips)) : null,
      maeMedian: quantile(rows.map((r) => r.oMae), 0.5),
      maeP90: quantile(rows.map((r) => r.oMae), 0.9),
      maeMax: rows.length ? Math.max(...rows.map((r) => r.oMae)) : null,
      barsMedian: quantile(oTp.map((r) => r.oBars), 0.5),
      barsMax: oTp.length ? Math.max(...oTp.map((r) => r.oBars)) : null,
    },
  };
};

const g = (x: number | null) => (x === null ? "" : String(x));

if (import.meta.main) {
  const mode = env("MODE", "real");
  if (mode === "print") {
    console.log(await Deno.readTextFile(`${OUT}/summary.json`));
    Deno.exit(0);
  }
  let src: Source = { dir: env("CACHE", "research/.cache"), fetch: env("FETCH", "yes") === "yes" };
  if (mode === "walkfiles") {
    const dir = `${OUT}/gmo`;
    const seed = Number(env("SEED", "1"));
    for (const pair of PAIRS) {
      const { m1, q15 } = synthesize(pair, PAIRS.indexOf(pair), { seed, trend: 0, startPips: null }, LOAD_FROM, END);
      await writeGmoFiles(dir, pair, { m1, q15 }, LOAD_FROM, END);
    }
    src = { dir, fetch: false };
  }
  const st: LoadStats = newLoadStats();
  const weekend = weekendOutOf("inside");
  const weeks = (END - START) / (7 * DAY);
  const pairs: Record<string, unknown>[] = [];
  const all: Row[] = [];
  const allLong: { pair: string; e: ErEntry; inWindow: boolean }[] = [];
  const allLongIn: { e: ErEntry; inWindow: boolean }[] = [];
  // the loaded bars' times (the rows' indices are theirs; the Python builds its own bars)
  const times = new Map<string, number[]>();
  for (const pair of PAIRS) {
    const got = await loadTf(src, pair, "15min", LOAD_FROM, END, st, weekend);
    const bars = barsOf(pair, quotesOf(got.bars));
    const t = bars.map((b) => b.t);
    times.set(pair, t);
    const inRange = (i: number) => t[i] + STEP >= START && t[i] + STEP <= END;
    let first = bars.findIndex((_, i) => inRange(i));
    if (first < 0) first = bars.length;
    let judged = 0;
    let short = 0;
    for (let i = first; i < bars.length; i++) {
      if (!inRange(i)) continue;
      if (i + 1 < EMA_RETURN.window) short++;
      else judged++;
    }
    const win = emaReturnMarks(bars, Math.max(first, EMA_RETURN.window - 1)).filter((m) => m.full && inRange(m.at));
    const long = emaReturnScan(bars).entries.filter((e) => inRange(e.at));
    const longAt = new Map(long.map((e) => [e.at, e]));
    const winAt = new Map(win.map((m) => [m.at, m]));
    const pip = pipOf(pair);
    const rows: Row[] = win.map((e) => {
      const v = followVideo(bars, e, pip);
      const o = followOwner(bars, e, pip);
      const l = longAt.get(e.at);
      return {
        pair,
        e,
        mailed: mailedAt(t[e.at] + STEP),
        long: l !== undefined && l.side === e.side,
        vRes: v.res,
        vBars: v.bars,
        vPips: v.pips,
        oRes: o.res,
        oBars: o.bars,
        oPips: o.pips,
        oMae: o.mae,
      };
    });
    const longRows = long.map((e) => ({ e, inWindow: winAt.get(e.at)?.side === e.side }));
    all.push(...rows);
    allLong.push(...longRows.map((x) => ({ pair, e: x.e, inWindow: x.inWindow })));
    allLongIn.push(...longRows);
    pairs.push({
      pair,
      bars: bars.length,
      first: bars.length ? iso(t[0]) : null,
      last: bars.length ? iso(t[bars.length - 1]) : null,
      judged,
      short,
      ...statsOf(rows, longRows, weeks),
    });
    console.log(`${pair}: ${bars.length} bars, judged ${judged} (short ${short}), entries ${rows.length}, long ${long.length}`);
  }
  await Deno.mkdir(OUT, { recursive: true });
  const head = "pair,open,side,x,t,aAt,b,k,dk,r,a,neck,entry,stop,tp1,tp2,rr,mailed,long,vRes,vBars,vPips,oRes,oBars,oPips,oMae";
  const at = (pair: string, i: number) => iso((times.get(pair) as number[])[i]);
  await Deno.writeTextFile(
    `${OUT}/rows.csv`,
    [
      head,
      ...all.map((r) =>
        [
          r.pair,
          at(r.pair, r.e.at),
          r.e.side,
          at(r.pair, r.e.x),
          at(r.pair, r.e.t),
          at(r.pair, r.e.aAt),
          at(r.pair, r.e.b),
          at(r.pair, r.e.k),
          at(r.pair, r.e.dk),
          at(r.pair, r.e.r),
          g(r.e.a),
          g(r.e.neck),
          g(r.e.entry),
          g(r.e.stop),
          g(r.e.tp1),
          g(r.e.tp2),
          g(r.e.rr),
          r.mailed ? 1 : 0,
          r.long ? 1 : 0,
          r.vRes,
          r.vBars,
          g(r.vPips),
          r.oRes,
          r.oBars,
          g(r.oPips),
          g(r.oMae),
        ].join(",")
      ),
    ].join("\n") + "\n",
  );
  await Deno.writeTextFile(
    `${OUT}/long.csv`,
    ["pair,open,side,x,entry,stop,tp1,inWindow", ...allLong.map((x) => [x.pair, at(x.pair, x.e.at), x.e.side, at(x.pair, x.e.x), g(x.e.entry), g(x.e.stop), g(x.e.tp1), x.inWindow ? 1 : 0].join(","))].join("\n") + "\n",
  );
  await Deno.writeTextFile(
    `${OUT}/summary.json`,
    JSON.stringify(
      { meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), params: EMA_RETURN }, pairs, total: statsOf(all, allLongIn, weeks), load: st },
      null,
      1,
    ),
  );
  console.log(`rows ${all.length}, long ${allLong.length}; load ${JSON.stringify(st)}`);
}
