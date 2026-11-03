// #392 (docs §8.135): the similar-past forecast (似た相場の予測: research/analog-spec.md) measured on the five GMO
// pairs' 15-minute, 1-hour and 4-hour charts, 2024-01-01 to 2026-10-31: how often the grey line's direction was
// right H bars later and what following it came to, how often the price stayed inside the green and red lines, and
// at the bars where the grey line turned (the flips) what the video's way (stop at the band, target at the grey
// line's end) and the owner's way (a limit at the close, 10 pips, no stop) came to. Spread not paid; nothing else
// is assumed. Every rule and number of it: the spec's "The measurement", fixed before any real bar was read.
//
//   GMO's files (research/.cache, fetched when missing: GitHub's runners reach GMO, the development container
//   cannot) -> trend-data loadTf (mergeSides, the weekend "inside") -> the chart's own historyRead (the mid of bid
//   and ask, rounded as drawn) -> _shared/analog-forecast.ts (the code the chart draws with)
//
// MODE=walkfiles: seeded walks (ownerhold-data synthesize, SEED) written as GMO's files under OUT/gmo first (the
// 15-minute day files, and the 1-hour day and 4-hour year files cut from the walk's minutes), and the study read
// from them (no network): the Python is checked on them before any real data is read.
// MODE=print: the summary written by a run before.
//
// Writes OUT/rows.csv (every anchor), OUT/flips.csv (every flip) and OUT/summary.json, the doubles as JS writes
// them; research/analog-check.py builds the bars from the same files with its own code, forecasts with
// research/analog-rule.py (written from the spec alone) and must find the same rows and numbers.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { ANALOG, type AnalogForecast, analogForecast } from "../supabase/functions/_shared/analog-forecast.ts";
import { type LoadStats, type M1, type Source, newLoadStats, synthesize, writeGmoFiles } from "./ownerhold-data.ts";
import { STEP_OF, loadTf, quotesOf, ruleKeyOf, writeWalk } from "./trend-data.ts";
import { emptyBars, fromQuotes, weekendOutOf } from "./trend-labels.ts";
import { HOUR } from "./lib.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
const TFS = ["15min", "1h", "4h"] as const;
type TfName = typeof TFS[number];
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const START = Date.parse(env("START", "2024-01-01T00:00:00Z"));
const END = Date.parse(env("END", "2026-10-31T00:00:00Z"));
const LOAD_FROM = Date.parse(env("LOAD_FROM", "2023-01-01T00:00:00Z"));
const OUT = env("OUT", "research/out/analog");
const { horizon: H, window: W } = ANALOG;

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const pipOf = (pair: string) => (pair.includes("JPY") ? 0.01 : 0.0001);
const g = (x: number | null | undefined) => (x === null || x === undefined ? "" : String(x));

interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
}

const barsOf = (pair: string, tf: TfName, qs: QuoteCandle[]): Bars => {
  const cs = historyRead(pair, tf, qs, END).candles;
  return {
    t: cs.map((x) => Date.parse(x.datetime.replace(" ", "T") + "Z")),
    o: cs.map((x) => x.open),
    h: cs.map((x) => x.high),
    l: cs.map((x) => x.low),
    c: cs.map((x) => x.close),
  };
};

// what the stats need of an anchor (the forecast itself is written to rows.csv and dropped)
interface Anchor {
  year: number;
  has: boolean;
  dir: 1 | -1 | 0;
  c0: number;
  midH: number;
  act: number;
  inside: number;
}

type VRes = "tp" | "stop" | "both" | "time" | "skipped";
interface Video {
  X: number;
  TP: number;
  SL: number;
  res: VRes;
  exit: number | null;
  pips: number | null;
  bars: number | null;
}
interface Owner {
  E: number;
  TP: number;
  filled: boolean;
  fillMode: "open" | "limit" | null;
  F: number | null;
  sameBar: boolean;
  res: "tp" | "held" | "unfilled";
  exit: number | null;
  pips: number | null;
  mae: number | null;
  bars: number | null;
}
interface Flip {
  a: number;
  year: number;
  side: "BUY" | "SELL";
  v: Video;
  o: Owner;
}

// the video's way: entry at the next bar's open, the target the grey line's end, the stop the band's far side
export const followVideo = (b: Bars, a: number, f: AnalogForecast, pip: number): Video => {
  const d = f.dir;
  const X = b.o[a + 1];
  const TP = f.mid[H];
  let SL = d === 1 ? f.lo[1] : f.up[1];
  for (let h = 2; h <= H; h++) SL = d === 1 ? Math.min(SL, f.lo[h]) : Math.max(SL, f.up[h]);
  const ok = d === 1 ? SL < X && X < TP : TP < X && X < SL;
  if (!ok) return { X, TP, SL, res: "skipped", exit: null, pips: null, bars: null };
  const pips = (x: number) => (d * (x - X)) / pip;
  for (let k = a + 1; k <= a + H; k++) {
    if (k > a + 1) {
      if (d === 1 ? b.o[k] <= SL : b.o[k] >= SL) return { X, TP, SL, res: "stop", exit: b.o[k], pips: pips(b.o[k]), bars: k - (a + 1) };
      if (d === 1 ? b.o[k] >= TP : b.o[k] <= TP) return { X, TP, SL, res: "tp", exit: b.o[k], pips: pips(b.o[k]), bars: k - (a + 1) };
    }
    const s = d === 1 ? b.l[k] <= SL : b.h[k] >= SL;
    const t = d === 1 ? b.h[k] >= TP : b.l[k] <= TP;
    if (s && t) return { X, TP, SL, res: "both", exit: null, pips: null, bars: null };
    if (s) return { X, TP, SL, res: "stop", exit: SL, pips: pips(SL), bars: k - (a + 1) };
    if (t) return { X, TP, SL, res: "tp", exit: TP, pips: pips(TP), bars: k - (a + 1) };
  }
  const x = b.c[a + H];
  return { X, TP, SL, res: "time", exit: x, pips: pips(x), bars: H - 1 };
};

// the owner's way: a limit at the anchor's close, 10 pips, no stop, held to the last bar loaded
export const followOwner = (b: Bars, a: number, d: 1 | -1, pip: number): Owner => {
  const E = b.c[a];
  const TP = E + d * 10 * pip;
  const last = b.t.length - 1;
  let f = -1;
  let F = NaN;
  let mode: "open" | "limit" | null = null;
  for (let j = a + 1; j <= last; j++) {
    if (d === 1 ? b.o[j] <= E : b.o[j] >= E) {
      f = j;
      F = b.o[j];
      mode = "open";
      break;
    }
    if (d === 1 ? b.l[j] <= E : b.h[j] >= E) {
      f = j;
      F = E;
      mode = "limit";
      break;
    }
  }
  if (f < 0) return { E, TP, filled: false, fillMode: null, F: null, sameBar: false, res: "unfilled", exit: null, pips: null, mae: null, bars: null };
  const sameBar = mode === "limit" && (d === 1 ? b.h[f] >= TP : b.l[f] <= TP);
  let ex = -1;
  let exit = NaN;
  for (let k = mode === "open" ? f : f + 1; k <= last; k++) {
    if (d === 1 ? b.o[k] >= TP : b.o[k] <= TP) {
      ex = k;
      exit = b.o[k];
      break;
    }
    if (d === 1 ? b.h[k] >= TP : b.l[k] <= TP) {
      ex = k;
      exit = TP;
      break;
    }
  }
  const held = ex < 0;
  const end = held ? last : ex;
  if (held) exit = b.c[last];
  let mae = 0;
  for (let k = f; k <= end; k++) {
    const adv = d === 1 ? b.l[k] : b.h[k];
    const v = (d * (F - adv)) / pip;
    if (v > mae) mae = v;
  }
  return { E, TP, filled: true, fillMode: mode, F, sameBar, res: held ? "held" : "tp", exit, pips: (d * (exit - F)) / pip, mae, bars: end - f };
};

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
};
const sum = (xs: number[]) => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
const ratio = (x: number, y: number) => (y > 0 ? x / y : null);

interface Rec {
  pair: string;
  an: Anchor;
}
interface FRec {
  pair: string;
  fl: Flip;
}

const statsOf = (rs: Rec[], fs: FRec[]) => {
  let none = 0, dirUp = 0, dirDown = 0, dirFlat = 0, hit = 0, miss = 0, actUp = 0, actDown = 0, insideSum = 0, allInside = 0;
  const moves: number[] = [];
  const errMid: number[] = [];
  const errFlat: number[] = [];
  let withF = 0;
  for (const { pair, an } of rs) {
    if (!an.has) {
      none++;
      continue;
    }
    withF++;
    const pip = pipOf(pair);
    const c0 = an.c0;
    if (an.dir === 1) dirUp++;
    else if (an.dir === -1) dirDown++;
    else dirFlat++;
    const mv = an.act > c0 ? 1 : an.act < c0 ? -1 : 0;
    if (mv === 1) actUp++;
    else if (mv === -1) actDown++;
    if (an.dir !== 0 && mv !== 0) {
      if (mv === an.dir) hit++;
      else miss++;
    }
    if (an.dir !== 0) moves.push((an.dir * (an.act - c0)) / pip);
    errMid.push(Math.abs(an.act - an.midH) / pip);
    errFlat.push(Math.abs(an.act - c0) / pip);
    insideSum += an.inside;
    if (an.inside === H) allInside++;
  }
  const vs = fs.map((x) => x.fl.v);
  const vDone = vs.filter((v) => v.res === "tp" || v.res === "stop" || v.res === "time");
  const os = fs.map((x) => x.fl.o);
  const oFilled = os.filter((o) => o.filled);
  const oTp = os.filter((o) => o.res === "tp");
  const oHeld = os.filter((o) => o.res === "held");
  return {
    anchors: rs.length,
    none,
    dirUp,
    dirDown,
    dirFlat,
    hit,
    miss,
    hitRate: ratio(hit, hit + miss),
    actUp,
    actDown,
    upShare: ratio(actUp, actUp + actDown),
    moveMean: mean(moves),
    errMidMean: mean(errMid),
    errFlatMean: mean(errFlat),
    insideShare: ratio(insideSum, H * withF),
    allInside,
    flips: {
      n: fs.length,
      buy: fs.filter((x) => x.fl.side === "BUY").length,
      sell: fs.filter((x) => x.fl.side === "SELL").length,
      video: {
        tp: vs.filter((v) => v.res === "tp").length,
        stop: vs.filter((v) => v.res === "stop").length,
        both: vs.filter((v) => v.res === "both").length,
        time: vs.filter((v) => v.res === "time").length,
        skipped: vs.filter((v) => v.res === "skipped").length,
        winRate: ratio(vs.filter((v) => v.res === "tp").length, vs.filter((v) => v.res === "tp" || v.res === "stop").length),
        perTrade: mean(vDone.map((v) => v.pips as number)),
        avgWin: mean(vs.filter((v) => v.res === "tp").map((v) => v.pips as number)),
        avgLoss: mean(vs.filter((v) => v.res === "stop").map((v) => v.pips as number)),
        timeMean: mean(vs.filter((v) => v.res === "time").map((v) => v.pips as number)),
        barsMedian: quantile(vDone.map((v) => v.bars as number), 0.5),
      },
      owner: {
        filled: oFilled.length,
        unfilled: os.length - oFilled.length,
        tp: oTp.length,
        held: oHeld.length,
        sameBar: os.filter((o) => o.sameBar).length,
        winRate: ratio(oTp.length, oFilled.length),
        perTrade: mean(oFilled.map((o) => o.pips as number)),
        heldSum: sum(oHeld.map((o) => o.pips as number)),
        heldWorst: oHeld.length ? Math.min(...oHeld.map((o) => o.pips as number)) : null,
        maeMedian: quantile(oFilled.map((o) => o.mae as number), 0.5),
        maeP90: quantile(oFilled.map((o) => o.mae as number), 0.9),
        maeMax: oFilled.length ? Math.max(...oFilled.map((o) => o.mae as number)) : null,
        tpBarsMedian: quantile(oTp.map((o) => o.bars as number), 0.5),
        tpBarsMax: oTp.length ? Math.max(...oTp.map((o) => o.bars as number)) : null,
        heldBarsMax: oHeld.length ? Math.max(...oHeld.map((o) => o.bars as number)) : null,
      },
    },
  };
};

// the walk's 1-minute bars cut into GMO's grid of `step` (first open, highest high, lowest low, last close, each
// side), as research/flowz.ts writes its walk's 1-hour and 4-hour files
const coarsen = (m: M1, step: number): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  let cur: QuoteCandle | null = null;
  let curT = NaN;
  for (let k = 0; k < m.n; k++) {
    const t = Math.floor(m.t[k] / step) * step;
    if (t !== curT) {
      if (cur) out.push(cur);
      curT = t;
      const datetime = new Date(t).toISOString();
      cur = { datetime, bid: { datetime, open: m.bo[k], high: m.bh[k], low: m.bl[k], close: m.bc[k] }, ask: { datetime, open: m.ao[k], high: m.ah[k], low: m.al[k], close: m.ac[k] } };
    } else if (cur) {
      cur.bid.high = Math.max(cur.bid.high, m.bh[k]);
      cur.bid.low = Math.min(cur.bid.low, m.bl[k]);
      cur.bid.close = m.bc[k];
      cur.ask.high = Math.max(cur.ask.high, m.ah[k]);
      cur.ask.low = Math.min(cur.ask.low, m.al[k]);
      cur.ask.close = m.ac[k];
    }
  }
  if (cur) out.push(cur);
  return out;
};

const writeWalkFiles = async (dir: string, seed: number) => {
  for (const pair of PAIRS) {
    const { m1, q15 } = synthesize(pair, PAIRS.indexOf(pair), { seed, trend: 0, startPips: null }, LOAD_FROM, END);
    const coarse = (qs: QuoteCandle[], tf: "1h" | "4h") => fromQuotes(qs, (t) => ruleKeyOf(tf, t));
    await writeWalk(dir, pair, { "5min": emptyBars(0), "15min": emptyBars(0), "1h": coarse(coarsen(m1, HOUR), "1h"), "4h": coarse(coarsen(m1, 4 * HOUR), "4h") }, LOAD_FROM, END);
    await writeGmoFiles(dir, pair, { m1, q15 }, LOAD_FROM, END);
  }
};

if (import.meta.main) {
  const mode = env("MODE", "real");
  if (mode === "print") {
    console.log(await Deno.readTextFile(`${OUT}/summary.json`));
    Deno.exit(0);
  }
  let src: Source = { dir: env("CACHE", "research/.cache"), fetch: env("FETCH", "yes") === "yes" };
  await Deno.mkdir(OUT, { recursive: true });
  if (mode === "walkfiles") {
    const dir = `${OUT}/gmo`;
    await writeWalkFiles(dir, Number(env("SEED", "1")));
    src = { dir, fetch: false };
  }
  const st: LoadStats = newLoadStats();
  const weekend = weekendOutOf("inside");
  const rowsFile = await Deno.open(`${OUT}/rows.csv`, { write: true, create: true, truncate: true });
  const flipsFile = await Deno.open(`${OUT}/flips.csv`, { write: true, create: true, truncate: true });
  const enc = new TextEncoder();
  const put = async (file: Deno.FsFile, text: string) => {
    const buf = enc.encode(text);
    let off = 0;
    while (off < buf.length) off += await file.write(buf.subarray(off));
  };
  await put(rowsFile, "tf,pair,open,dir,places,midH,upH,loH,midSum,upSum,loSum,act,inside\n");
  await put(flipsFile, "tf,pair,open,side,X,TP,SL,vRes,vExit,vPips,vBars,E,oTP,filled,fillMode,F,sameBar,oRes,oExit,oPips,mae,oBars\n");
  const tfsOut: Record<string, unknown> = {};
  for (const tf of TFS) {
    const step = STEP_OF[tf];
    const pairsOut: Record<string, unknown>[] = [];
    const recs: Rec[] = [];
    const frecs: FRec[] = [];
    for (const pair of PAIRS) {
      const got = await loadTf(src, pair, tf, LOAD_FROM, END, st, weekend);
      const b = barsOf(pair, tf, quotesOf(got.bars));
      const n = b.t.length;
      const pip = pipOf(pair);
      const isAnchor = (a: number) => a >= W - 1 && b.t[a] + step >= START && a + H <= n - 1;
      let first = -1;
      for (let a = W - 1; a < n; a++) {
        if (isAnchor(a)) {
          first = a;
          break;
        }
      }
      let lines = "";
      let flines = "";
      let prev: AnalogForecast | null = first > W - 1 ? analogForecast(b.c, first - 1) : null;
      let count = 0;
      let lastA = -1;
      if (first >= 0) {
        for (let a = first; a < n && isAnchor(a); a++) {
          const f = analogForecast(b.c, a);
          const an: Anchor = { year: new Date(b.t[a] + step).getUTCFullYear(), has: f !== null, dir: f ? f.dir : 0, c0: b.c[a], midH: f ? f.mid[H] : NaN, act: b.c[a + H], inside: 0 };
          if (f) {
            let ins = 0;
            for (let h = 1; h <= H; h++) if (f.lo[h] <= b.c[a + h] && b.c[a + h] <= f.up[h]) ins++;
            an.inside = ins;
            let ms = 0, us = 0, ls = 0;
            for (let h = 1; h <= H; h++) {
              ms += f.mid[h];
              us += f.up[h];
              ls += f.lo[h];
            }
            lines += [tf, pair, iso(b.t[a]), f.dir, f.places.map((p) => a - p.j).join(";"), g(f.mid[H]), g(f.up[H]), g(f.lo[H]), g(ms), g(us), g(ls), g(an.act), ins].join(",") + "\n";
            if (f.dir !== 0 && prev !== null && prev.dir !== f.dir) {
              const d = f.dir;
              const v = followVideo(b, a, f, pip);
              const o = followOwner(b, a, d, pip);
              const fl: Flip = { a, year: an.year, side: d === 1 ? "BUY" : "SELL", v, o };
              frecs.push({ pair, fl });
              flines += [
                tf, pair, iso(b.t[a]), fl.side, g(v.X), g(v.TP), g(v.SL), v.res, g(v.exit), g(v.pips), g(v.bars),
                g(o.E), g(o.TP), o.filled ? 1 : 0, o.fillMode ?? "", g(o.F), o.sameBar ? 1 : 0, o.res, g(o.exit), g(o.pips), g(o.mae), g(o.bars),
              ].join(",") + "\n";
            }
          }
          recs.push({ pair, an });
          prev = f;
          count++;
          lastA = a;
          if (lines.length > 4_000_000) {
            await put(rowsFile, lines);
            lines = "";
          }
        }
      }
      await put(rowsFile, lines);
      await put(flipsFile, flines);
      pairsOut.push({
        pair,
        bars: n,
        first: n ? iso(b.t[0]) : null,
        last: n ? iso(b.t[n - 1]) : null,
        anchors: count,
        firstAnchor: first >= 0 ? iso(b.t[first]) : null,
        lastAnchor: lastA >= 0 ? iso(b.t[lastA]) : null,
      });
      console.log(`${tf} ${pair}: ${n} bars, anchors ${count}, flips ${frecs.filter((x) => x.pair === pair).length}`);
    }
    const byPair: Record<string, unknown> = {};
    for (const pair of PAIRS) byPair[pair] = statsOf(recs.filter((r) => r.pair === pair), frecs.filter((x) => x.pair === pair));
    const years = [...new Set(recs.map((r) => r.an.year))].sort((x, y) => x - y);
    const byYear: Record<string, unknown> = {};
    for (const y of years) byYear[String(y)] = statsOf(recs.filter((r) => r.an.year === y), frecs.filter((x) => x.fl.year === y));
    tfsOut[tf] = { pairs: pairsOut, all: statsOf(recs, frecs), byPair, byYear };
  }
  rowsFile.close();
  flipsFile.close();
  await Deno.writeTextFile(
    `${OUT}/summary.json`,
    JSON.stringify({ meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), params: ANALOG, tfs: TFS, pairs: PAIRS }, tfs: tfsOut, load: st }, null, 1),
  );
  console.log(`load ${JSON.stringify(st)}`);
}
