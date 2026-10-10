// #272 (docs §8.109): would mailing the MACD extreme crosses (the rule in
// research/macdx-lib.ts, frozen in PR #197 before any of the measured period
// was read) win more than the ULTRA 5-minute emails the owner gets now?
//
// Built from research/tf-winrate.ts's 5-minute path (the same GMO files and
// cache, the chart's mid bars from historyRead, the sweep's read times, the
// emails' levels, entries at the signal bar's close, the follow on 5-minute
// bid/ask, the week clusters), with:
//   main   the MACD rule's fires (SELL on DOWN, BUY on UP)
//   (イ)   ULTRA's 5-minute signals alone, found exactly as tf-winrate finds
//          them (anchoredStart windows, checked against indicatorSignals)
//   (ロ)   every MACD cross, C0..C2 not applied
//   (ハ)   blind entries: both sides at a hashed sample of 5-minute closes
//
// MODE (§8.109 確かめ):
//   real   the 5 pairs, 2024-01-01 .. 2026-10-09 00:00 UTC (dispatch only)
//   real21 the same on the 21 pairs of the 71.9%, a reference only: (a)(b)(c)
//          are printed but not judged, and no sentence is given
//   walk   the same on a seeded random walk (SEED), for 確かめ 2; also writes
//          the walk as GMO-shaped files for the Python re-computation
//   repro  ULTRA alone on the 21 pairs to 2026-09-30 14:40:11 UTC, compared
//          with run 37191488441's row (確かめ 5); no MACD number is computed
// The look-ahead check (確かめ 1) runs in real and walk before any result is
// printed and stops the run on a single mismatch.
//
// Runs on GitHub's runners (GMO's public API is not reachable from the
// development container). Read-only: it prints to the job log and writes
// research/out/macdx; it holds no secret.

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure, isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs } from "../supabase/functions/_shared/qtrend.ts";
import { ULTRA_PAIRS, ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, GMO_STUDY_PAIRS, MINUTE, WEEK, WEEK_OFFSET, clusterRate, iso } from "./lib.ts";
import { wholeDayFile } from "./ownerhold-data.ts";
import { WINDOW, c2Variant, decide, decideOnWindow, prepare, type Decision } from "./macdx-lib.ts";

const MODE = Deno.env.get("MODE") || "walk";
if (!["real", "real21", "walk", "repro"].includes(MODE)) throw new Error(`MODE ${MODE}: real, real21, walk or repro`);
// real21: the same study on the 21 pairs of the 71.9% (§8.109 測り方 ペア: a reference only;
// (a)(b)(c) and the sentence are not judged on it)
const REFERENCE = MODE === "real21";
const FIVE = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
const PAIRS = (Deno.env.get("PAIRS") || (MODE === "repro" || MODE === "real21" ? GMO_STUDY_PAIRS.join(",") : FIVE.join(","))).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
const END = Deno.env.get("END") || (MODE === "repro" ? "2026-09-30T14:40:11Z" : "2026-10-09T00:00:00Z");
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.parse(END);
if (![START_MS, SPLIT_MS, NOW].every(Number.isFinite)) throw new Error("START, SPLIT or END is not a time");
const SEED = Number(Deno.env.get("SEED") || "1");
const SYNTHETIC = MODE === "walk";
// the emails' levels on the currency pairs since #192 (§8.109: SL 13, TP 4/10/16)
const LEVELS = ULTRA_PAIRS;
const CACHE = "research/.cache";
const OUT = "research/out/macdx";
const WALK_DIR = "research/.cache-walk";
const FINE = 5 * MINUTE;
const STEP = LIVE_STEP_MS["5min"];
const MAX_HOLD = 5 * 288;
const KS = [1, 2, 3] as const;
const LEAD = 5 * DAY;
const BLIND_EVERY = 100;
const CHECK_EVERY = 661;
// §8.109 合図の決まり 9: the sweep reads a 5-minute chart 0, 1 and 3 minutes after the close
const READ_AFTER = [0, 1, 3];
const mailed = (closeMs: number): boolean => READ_AFTER.some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// run 37191488441's whole-period ULTRA 5-minute row (確かめ 5), as its job log prints it
// (job 111404429207, "== the whole period, entered at the close": "5min ultra n= 79554 TP1
// first 71.9% [ 71.2%, 72.6%] of 75086 (tp 53978 sl 20590 amb 518 open 4468) pips/trade -1.62
// [-1.76, -1.49]"); docs §8.98 gives its 71.9% and -1.62
const REPRO_EXPECT = { n: 79554, resolved: 75086, tp: 53978, sl: 20590, amb: 518, open: 4468, win: "71.9", winLo: "71.2", winHi: "72.6", pips: "-1.62", pipsLo: "-1.76", pipsHi: "-1.49" };

// ---- GMO's files (as tf-winrate) -----------------------------------------------------------

const failWhy: Record<string, number> = {};
const sound = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; data?: unknown };
  return (b.status === 0 || b.status === 404) && Array.isArray(b.data);
};
const getJson = async (url: string): Promise<{ status: number; body: unknown; why: string }> => {
  let why = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { status: 404, body: null, why: "" };
      if (r.status === 429 || r.status >= 500) {
        await r.body?.cancel();
        why = `HTTP ${r.status}`;
      } else {
        const body = await r.json();
        if (sound(body)) return { status: r.status, body, why: "" };
        const b = (typeof body === "object" && body !== null ? body : {}) as { status?: unknown };
        why = `HTTP ${r.status}, GMO status ${String(b.status)}`;
      }
    } catch (e) {
      why = e instanceof Error ? e.name : "error";
    }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  return { status: 0, body: null, why };
};

// a seeded random walk on 5 minutes (tf-winrate's synthetic5, the seed mixed with SEED)
const synthetic5 = (pair: string, fromMs: number): QuoteCandle[] => {
  let seed = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);
  seed = (seed ^ Math.imul(SEED, 0x9e3779b1)) | 0;
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
    const dt = new Date(ms).toISOString();
    const bid = { datetime: dt, open: o, high: h, low: l, close: px };
    bars.push({ datetime: dt, bid, ask: { ...bid, open: o + spread, high: h + spread, low: l + spread, close: px + spread } });
  }
  return bars;
};

interface Loaded {
  quotes: QuoteCandle[];
  requests: number;
  cached: number;
  failed: number;
  partial: number;
}
const load = async (pair: string, fromMs: number): Promise<Loaded> => {
  if (SYNTHETIC) {
    const fine = synthetic5(pair, fromMs).filter((q) => !barInsideClosure(barOpenMs(q.datetime), STEP));
    // the walk in GMO's shape for the Python re-computation (one file a side)
    const symbol = GMO_SYMBOLS[pair];
    for (const side of ["bid", "ask"] as const) {
      const dir = `${WALK_DIR}/seed${SEED}/${symbol}/5min/${side}`;
      await Deno.mkdir(dir, { recursive: true });
      const data = fine.map((q) => ({ openTime: String(barOpenMs(q.datetime)), open: String(q[side].open), high: String(q[side].high), low: String(q[side].low), close: String(q[side].close) }));
      await Deno.writeTextFile(`${dir}/all.json`, JSON.stringify({ status: 0, data }));
    }
    return { quotes: fine, requests: 0, cached: 0, failed: 0, partial: 0 };
  }
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS["5min"];
  if (!symbol || !spec) throw new Error(`no GMO file for ${pair}`);
  const today = jstDayKey(NOW);
  const keys = dateKeys(fromMs, NOW, "day").filter((k) => k <= today);
  const fresh = new Set(keys.slice(-3));
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: typeof bid = [];
  let requests = 0;
  let cached = 0;
  let failed = 0;
  let partial = 0;
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
          if (body !== undefined && !sound(body)) body = undefined;
          // on real data, a kept file GMO made before its day had ended (another study read it
          // while the day was going on) is read again (research/ownerhold-data.ts wholeDayFile);
          // repro reads the cache as tf-winrate did
          if (body !== undefined && MODE !== "repro" && !wholeDayFile(body, key)) {
            partial++;
            body = undefined;
          }
        }
        if (body === undefined) {
          const r = await getJson(klineUrl(symbol, side, spec.name, key));
          requests++;
          body = r.status === 404 ? { status: 404, data: [], responsetime: new Date().toISOString() } : r.body;
          if (r.status === 0 || !sound(body)) {
            failed++;
            failWhy[r.why] = (failWhy[r.why] ?? 0) + 1;
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
  const quotes = mergeSides(bid, ask).filter((q) => {
    const t = Date.parse(q.datetime);
    return Number.isFinite(t) && t >= fromMs && !barInsideClosure(t, STEP) && t + STEP <= NOW;
  });
  return { quotes, requests, cached, failed, partial };
};

// ---- the 5-minute bars trades are followed on ------------------------------------------------

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
// out at `tp` or `sl` from 5-minute bar `from` on (tf-winrate's follow); null when the
// data ends before MAX_HOLD bars; `gap` when filled at a bar's open past the level
const follow = (f: Fine, from: number, side: Side, sl: number, tp: number): { kind: Kind; exit: number; bars: number; gap: boolean } | null => {
  const last = from + MAX_HOLD - 1;
  if (from < 0 || last > f.n - 1) return null;
  const buy = side === "BUY";
  const o = buy ? f.bo : f.ao;
  const h = buy ? f.bh : f.ah;
  const l = buy ? f.bl : f.al;
  for (let j = from; j <= last; j++) {
    if (buy ? o[j] <= sl : o[j] >= sl) return { kind: "sl", exit: o[j], bars: j - from + 1, gap: true };
    if (buy ? o[j] >= tp : o[j] <= tp) return { kind: "tp", exit: o[j], bars: j - from + 1, gap: true };
    const hitTp = buy ? h[j] >= tp : l[j] <= tp;
    const hitSl = buy ? l[j] <= sl : h[j] >= sl;
    if (hitTp && hitSl) return { kind: "amb", exit: sl, bars: j - from + 1, gap: false };
    if (hitSl) return { kind: "sl", exit: sl, bars: j - from + 1, gap: false };
    if (hitTp) return { kind: "tp", exit: tp, bars: j - from + 1, gap: false };
  }
  return { kind: "open", exit: buy ? f.bc[last] : f.ac[last], bars: MAX_HOLD, gap: false };
};

// ---- the records -----------------------------------------------------------------------------

type Rule = "macd" | "all" | "ultra" | "blind";
type Entry = "close" | "late";
interface Rec {
  rule: Rule;
  pair: string;
  t: number;
  side: Side;
  entry: Entry;
  k: number;
  kind: Kind;
  pips: number;
  bars: number;
  spread: number;
  gap: boolean;
  // the MACD rule's own diagnostics (main only)
  first?: boolean;
  gapWindow?: boolean;
  afterGap?: boolean;
}
const recs: Rec[] = [];
const dropped: Record<string, number> = {};
const lateSkipped: Record<string, number> = {};
const mix = (a: number): number => {
  a ^= a >>> 16;
  a = Math.imul(a, 0x85ebca6b);
  a ^= a >>> 13;
  a = Math.imul(a, 0xc2b2ae35);
  a ^= a >>> 16;
  return a >>> 0;
};
const sampled = (pairIdx: number, t: number, every: number): boolean => every <= 1 || mix(mix(pairIdx * 7919 + 1) ^ Math.floor(t / MINUTE)) % every === 0;

// ---- each pair -------------------------------------------------------------------------------

interface Diag {
  pair: string;
  bars: number;
  first: string | null;
  last: string | null;
  crosses: number;
  short: number;
  fires: number;
  unmailed: number;
  rejC0: number;
  rejC1only: number;
  rejC2only: number;
  rejBoth: number;
  gapWindowDecisions: number;
  gapWindowFires: number;
  variantBeyondChanged: number;
  variantNearChanged: number;
  ultra: number;
  ultraUnmailed: number;
  requests: number;
  cached: number;
  failed: number;
  xPips: number[];
  aPips: number[];
}
const diags: Diag[] = [];
const ahead = { compared: 0, mismatched: 0, examples: [] as string[] };
const ultraCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
const decisionsCsv: string[] = ["pair,closeUtc,dir,mailed,x,S,P,c0,c1,c2,fire"];
const tradesCsv: string[] = ["rule,pair,closeUtc,side,entry,k,kind,pips,bars"];
const barsCount: string[] = ["pair,bars,first,last"];

for (const [pi, pair] of PAIRS.entries()) {
  const unit = ultraUnit(pair);
  const got = await load(pair, START_MS - LEAD);
  const fine = toFine(got.quotes);
  const candles = historyRead(pair, "5min", got.quotes, NOW).candles;
  const n = candles.length;
  const times = new Float64Array(n);
  candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
  const byOpen = new Map(got.quotes.map((q) => [barOpenMs(q.datetime), q]));
  const qs = Array.from(times, (t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);
  barsCount.push(`${pair},${n},${n ? iso(times[0]) : ""},${n ? iso(times[n - 1]) : ""}`);
  const i0 = lowerBound(times, START_MS - STEP);
  const judged = (i: number) => times[i] + STEP >= START_MS;

  const d: Diag = { pair, bars: n, first: n ? iso(times[0]) : null, last: n ? iso(times[n - 1]) : null, crosses: 0, short: 0, fires: 0, unmailed: 0, rejC0: 0, rejC1only: 0, rejC2only: 0, rejBoth: 0, gapWindowDecisions: 0, gapWindowFires: 0, variantBeyondChanged: 0, variantNearChanged: 0, ultra: 0, ultraUnmailed: 0, requests: got.requests, cached: got.cached, failed: got.failed, xPips: [], aPips: [] };

  const enter = (i: number, rule: Rule, side: Side, ks: readonly number[], late: boolean, extra: Partial<Rec> = {}) => {
    const T = times[i] + STEP;
    const buy = side === "BUY";
    const q = qs[i];
    const lv = ultraLevels(side, candles[i].close, unit, LEVELS);
    const e = lowerBound(fine.t, T);
    const spread = (q.ask.close - q.bid.close) / unit;
    const fill = buy ? q.ask.close : q.bid.close;
    for (const k of ks) {
      const res = follow(fine, e, side, lv.sl, lv.tps[k - 1]);
      if (!res) {
        if (k === 1) dropped[rule] = (dropped[rule] ?? 0) + 1;
        continue;
      }
      const pnl = buy ? res.exit - fill : fill - res.exit;
      const rec: Rec = { rule, pair, t: T, side, entry: "close", k, kind: res.kind, pips: pnl / unit, bars: res.bars, spread, gap: res.gap, ...extra };
      recs.push(rec);
      if (k === 1 && rule !== "blind") tradesCsv.push(`${rule},${pair},${iso(T)},${side},close,1,${res.kind},${rec.pips.toFixed(6)},${res.bars}`);
    }
    if (!late || e >= fine.n) return;
    const lateFill = buy ? fine.ac[e] : fine.bc[e];
    const exitNow = buy ? fine.bc[e] : fine.ac[e];
    const passed = buy ? exitNow >= lv.tps[0] || exitNow <= lv.sl : exitNow <= lv.tps[0] || exitNow >= lv.sl;
    if (passed) {
      lateSkipped[rule] = (lateSkipped[rule] ?? 0) + 1;
      return;
    }
    const res = follow(fine, e + 1, side, lv.sl, lv.tps[0]);
    if (!res) return;
    const pnl = buy ? res.exit - lateFill : lateFill - res.exit;
    recs.push({ rule, pair, t: T, side, entry: "late", k: 1, kind: res.kind, pips: pnl / unit, bars: res.bars, spread: (fine.ac[e] - fine.bc[e]) / unit, gap: res.gap, ...extra });
  };

  // ---- (イ) ULTRA, as tf-winrate finds it ----
  {
    const windowStart = (i: number): number | null => (i >= 600 - 1 ? i - 600 + 1 : null);
    const anchorOf = (i: number): { ws: number; s: number } | null => {
      const ws = windowStart(i);
      if (ws === null || i - ws + 1 <= QT_DEFAULTS.period) return null;
      const w = times.subarray(ws, i + 1) as unknown as number[];
      const last = i - ws;
      const firstShown = Math.max(0, last - (CHART_BARS - 1));
      return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
    };
    const signals: Array<{ i: number; side: Side }> = [];
    const sample = new Set<number>();
    let seg: { s: number; from: number; to: number } | null = null;
    const flush = () => {
      if (!seg) return;
      const bars = candles.slice(seg.s, seg.to + 1);
      const ul = ultra(bars, bars.length - 1, unit);
      for (const tr of ul.trades) {
        const at = seg.s + tr.i;
        if (at >= seg.from && at <= seg.to) signals.push({ i: at, side: tr.side });
      }
      seg = null;
    };
    for (let i = Math.max(0, i0); i < n; i++) {
      if (!judged(i)) continue;
      const a = anchorOf(i);
      if (!a) {
        flush();
        continue;
      }
      if (i % CHECK_EVERY === 0) sample.add(i);
      if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
      else {
        flush();
        seg = { s: a.s, from: i, to: i };
      }
    }
    flush();
    signals.sort((a, b) => a.i - b.i);
    const mine = new Map<number, string>();
    for (const s of signals) mine.set(s.i, [...(mine.get(s.i) ? [mine.get(s.i)!] : []), s.side].sort().join(","));
    const probe = (i: number) => {
      const a = anchorOf(i);
      if (!a) return;
      const theirs = indicatorSignals(pair, "5min", candles.slice(a.ws, i + 1), times[i] + STEP + 60_000, 120_000)
        .filter((x) => Date.parse(x.barTime) === times[i] && x.rule === "ultra")
        .map((x) => x.side)
        .sort()
        .join(",");
      const ours = mine.get(i) ?? "";
      ultraCheck.compared++;
      if (theirs !== ours) {
        ultraCheck.mismatched++;
        if (ultraCheck.examples.length < 10) ultraCheck.examples.push(`${pair} ${iso(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
      }
    };
    for (const i of sample) probe(i);
    signals.forEach((s, k) => {
      if (k % 7 === 0) probe(s.i);
    });
    for (const s of signals) {
      if (!mailed(times[s.i] + STEP)) {
        d.ultraUnmailed++;
        continue;
      }
      d.ultra++;
      enter(s.i, "ultra", s.side, KS, true);
    }
  }

  // ---- the MACD rule (main) and every cross (ロ) ----
  if (MODE !== "repro") {
    const p = prepare(candles);
    const fires: Array<{ i: number; dec: Decision }> = [];
    const crossAt: number[] = [];
    const lastFireRun = new Map<number, true>();
    let lastGap = -Infinity;
    for (let i = Math.max(1, i0 - 36); i < n; i++) {
      if (times[i] - times[i - 1] > FINE) lastGap = i;
      if (i < i0 || !judged(i)) continue;
      const short = i < WINDOW - 1;
      const dec = short ? null : decide(p.m, p.sides, p.ms, p.tr, i, 0);
      if (short) {
        const a = p.sides[i - 1];
        const b = p.sides[i];
        if (a !== null && b !== null && a !== b) d.short++;
        continue;
      }
      if (!dec) continue;
      d.crosses++;
      crossAt.push(i);
      const isMailed = mailed(times[i] + STEP);
      decisionsCsv.push(`${pair},${iso(times[i] + STEP)},${dec.dir},${isMailed ? 1 : 0},${dec.x},${dec.S},${dec.P},${dec.c0 ? 1 : 0},${dec.c1 ? 1 : 0},${dec.c2 ? 1 : 0},${dec.fire ? 1 : 0}`);
      if (!isMailed) {
        d.unmailed++;
        continue;
      }
      // (ロ) every cross
      enter(i, "all", dec.side, [1], true);
      // gaps inside the 288 TR window (TR[k] reads bar k-1: bars i-288 .. i)
      let gapIn = false;
      for (let k = i - 287; k <= i; k++) if (times[k] - times[k - 1] > FINE) gapIn = true;
      if (gapIn) d.gapWindowDecisions++;
      // the two wave variants, reporting only
      if (dec.c0 && dec.c1) {
        if (c2Variant(p.m, i, dec.x, dec.S, "beyond") !== dec.c2) d.variantBeyondChanged++;
        if (c2Variant(p.m, i, dec.x, dec.S, "near") !== dec.c2) d.variantNearChanged++;
      }
      if (!dec.c0) d.rejC0++;
      else if (!dec.c1 && !dec.c2) d.rejBoth++;
      else if (!dec.c1) d.rejC1only++;
      else if (!dec.c2) d.rejC2only++;
      if (!dec.fire) continue;
      d.fires++;
      if (gapIn) d.gapWindowFires++;
      d.xPips.push(dec.x / unit);
      d.aPips.push(dec.S / 288 / unit);
      const first = !lastFireRun.has(dec.run);
      lastFireRun.set(dec.run, true);
      fires.push({ i, dec });
      enter(i, "macd", dec.side, KS, true, { first, gapWindow: gapIn, afterGap: i - lastGap < 36 });
    }
    // (ハ) the yardstick: both sides at a hashed sample of mailed 5-minute closes
    for (let i = Math.max(WINDOW - 1, i0); i < n; i++) {
      if (!judged(i) || !mailed(times[i] + STEP) || !sampled(pi, times[i], BLIND_EVERY)) continue;
      enter(i, "blind", "BUY", [1], false);
      enter(i, "blind", "SELL", [1], false);
    }
    // 確かめ 1: the decision on the sweep's own 600-bar window (MACD on those bars alone, as the
    // email would compute it) against the whole-series shortcut, at every cross judged and at
    // about 300 evenly spaced bars (where both must find no cross or the same one)
    const every = Math.max(1, Math.floor((n - i0) / 300));
    const probeAt = new Set<number>(crossAt);
    for (let i = Math.max(WINDOW - 1, i0); i < n; i += every) probeAt.add(i);
    for (const i of probeAt) {
      if (!judged(i) || i < WINDOW - 1) continue;
      const a = decide(p.m, p.sides, p.ms, p.tr, i, 0);
      const b = decideOnWindow(candles, i);
      ahead.compared++;
      const ka = a ? `${a.dir}:${a.fire}` : "-";
      const kb = b ? `${b.dir}:${b.fire}` : "-";
      if (ka !== kb) {
        ahead.mismatched++;
        if (ahead.examples.length < 10) ahead.examples.push(`${pair} ${iso(times[i])} whole=${ka} window=${kb}`);
      }
    }
  }
  diags.push(d);
  console.log(`${pair}: ${n} bars ${d.first ?? "-"} .. ${d.last ?? "-"}; GMO ${got.requests} read, ${got.cached} cached, ${got.failed} failed, ${got.partial} kept before their day ended (read again); ULTRA ${d.ultra} mailed, ${d.ultraUnmailed} not mailed`);
}

// ---- the numbers -----------------------------------------------------------------------------

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/bars.csv`, barsCount.join("\n") + "\n");
const fails = diags.reduce((a, x) => a + x.failed, 0);
console.log(`\n#272 ${MODE === "walk" ? `RANDOM WALK seed ${SEED}` : MODE === "repro" ? "ULTRA REPRODUCTION" : "REAL DATA"}: ${PAIRS.join(" ")}, ${START} .. ${iso(NOW)} (split ${SPLIT}); the stop ${LEVELS.sl} and TP ${LEVELS.tp1}/${LEVELS.tp2}/${LEVELS.tp3} pips`);
console.log(`GMO reads that failed: ${fails}${fails ? ` ${JSON.stringify(failWhy)}` : ""}`);
console.log(`ULTRA against indicatorSignals: ${ultraCheck.mismatched} of ${ultraCheck.compared} differ${ultraCheck.examples.length ? ": " + ultraCheck.examples.join("; ") : ""}`);
if (fails > 0) throw new Error("GMO reads failed: stopped before any result");
if (ultraCheck.mismatched > 0) throw new Error("ULTRA differs from indicatorSignals: stopped before any result");
if (MODE !== "repro") {
  console.log(`確かめ 1 (look-ahead): the decision on the 600-bar window against the whole series: ${ahead.mismatched} of ${ahead.compared} differ${ahead.examples.length ? ": " + ahead.examples.join("; ") : ""}`);
  if (ahead.mismatched > 0 || ahead.compared === 0) throw new Error("look-ahead check failed: stopped before any result");
}

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
    gap: ts.filter((x) => x.gap).length,
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
// the difference of two means (pips, or wins as 0/1), its interval by week
// (tf-winrate's diffCi: the delta method, both sets sharing the weeks)
const diffCi = (a: Rec[], b: Rec[], v: (x: Rec) => number) => {
  if (!a.length || !b.length) return null;
  const ma = a.reduce((s, x) => s + v(x), 0) / a.length;
  const mb = b.reduce((s, x) => s + v(x), 0) / b.length;
  const by = new Map<number, number>();
  for (const x of a) by.set(weekOf(x.t), (by.get(weekOf(x.t)) ?? 0) + (v(x) - ma) / a.length);
  for (const x of b) by.set(weekOf(x.t), (by.get(weekOf(x.t)) ?? 0) - (v(x) - mb) / b.length);
  const C = by.size;
  let s = 0;
  for (const r of by.values()) s += r * r;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) : Number.NaN;
  return { d: ma - mb, lo: ma - mb - 1.96 * se, hi: ma - mb + 1.96 * se };
};
const pct = (x: number | null) => (x === null ? "   -  " : `${(100 * x).toFixed(1).padStart(5)}%`);
const num = (x: number | null, dg = 2) => (x === null || !Number.isFinite(x) ? "-" : x.toFixed(dg));
const row = (label: string, s: Summary, k = 1) =>
  `${label.padEnd(22)} n=${String(s.n).padStart(7)}  TP${k} first ${pct(s.win)} [${pct(s.winLo)},${pct(s.winHi)}] of ${String(s.resolved).padStart(7)}` +
  `  (tp ${s.tp} sl ${s.sl} amb ${s.amb} open ${s.open}; at an open ${s.gap})  pips/trade ${num(s.pips)} [${num(s.pipsLo)}, ${num(s.pipsHi)}]  spread ${num(s.spread)}  held ${num(s.held, 0)} bars`;
const sel = (f: (x: Rec) => boolean) => recs.filter(f);
const k1 = (rule: Rule, more: (x: Rec) => boolean = () => true) => sel((x) => x.rule === rule && x.entry === "close" && x.k === 1 && more(x));
const report: Record<string, unknown> = { mode: MODE, seed: SEED, start: START, split: SPLIT, end: iso(NOW), pairs: PAIRS, levels: LEVELS, diags, ahead, ultraCheck, dropped, lateSkipped };

if (MODE === "repro") {
  const s = summarize(k1("ultra"));
  console.log(row("5min ultra", s));
  const got = { n: s.n, resolved: s.resolved, tp: s.tp, sl: s.sl, amb: s.amb, open: s.open, win: (100 * (s.win ?? 0)).toFixed(1), winLo: (100 * (s.winLo ?? 0)).toFixed(1), winHi: (100 * (s.winHi ?? 0)).toFixed(1), pips: num(s.pips), pipsLo: num(s.pipsLo), pipsHi: num(s.pipsHi) };
  const same = JSON.stringify(got) === JSON.stringify(REPRO_EXPECT);
  console.log(`確かめ 5 (run 37191488441's ULTRA 5-minute row): ${same ? "REPRODUCED" : "DIFFERS"}\n  expected ${JSON.stringify(REPRO_EXPECT)}\n  got      ${JSON.stringify(got)}`);
  report.repro = { expected: REPRO_EXPECT, got, same };
  await Deno.writeTextFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  if (!same) throw new Error("ULTRA not reproduced");
  Deno.exit(0);
}

await Deno.writeTextFile(`${OUT}/decisions.csv`, decisionsCsv.join("\n") + "\n");
await Deno.writeTextFile(`${OUT}/trades.csv`, tradesCsv.join("\n") + "\n");

const periods: Array<[string, (x: Rec) => boolean]> = [["whole", () => true], ["first half", (x) => x.t < SPLIT_MS], ["second half", (x) => x.t >= SPLIT_MS]];
const tables: Record<string, unknown> = {};
for (const [pname, inP] of periods) {
  console.log(`\n== ${pname}, entered at the close (TP1: the whole position at TP1 or the stop)`);
  const t: Record<string, Summary> = {};
  for (const [label, rule] of [["main (MACD rule)", "macd"], ["(イ) ULTRA", "ultra"], ["(ロ) every cross", "all"], ["(ハ) blind", "blind"]] as Array<[string, Rule]>) {
    t[rule] = summarize(k1(rule, inP));
    console.log(row(label, t[rule]));
  }
  tables[pname] = t;
}
report.tables = tables;

// the comparison (§8.109 測り方 主と (イ) の差; 勧め方 (a)(b)(c))
const pipsOf = (x: Rec) => x.pips;
const winOf = (x: Rec) => (x.kind === "tp" ? 1 : 0);
const dWhole = diffCi(k1("macd"), k1("ultra"), pipsOf);
const dFirst = diffCi(k1("macd", (x) => x.t < SPLIT_MS), k1("ultra", (x) => x.t < SPLIT_MS), pipsOf);
const dSecond = diffCi(k1("macd", (x) => x.t >= SPLIT_MS), k1("ultra", (x) => x.t >= SPLIT_MS), pipsOf);
const lateMain = summarize(sel((x) => x.rule === "macd" && x.entry === "late"));
const lateUltra = summarize(sel((x) => x.rule === "ultra" && x.entry === "late"));
const dWin = diffCi(k1("macd", resolved), k1("ultra", resolved), winOf);
const main = tables["whole"] as Record<string, Summary>;
const a = dWhole !== null && dWhole.lo > 0;
const b = dFirst !== null && dSecond !== null && dFirst.d > 0 && dSecond.d > 0;
const c = lateMain.pips !== null && lateUltra.pips !== null && lateMain.pips >= lateUltra.pips;
console.log(`\n== main against (イ) ULTRA`);
console.log(`d (pips a trade, main - ULTRA): whole ${num(dWhole?.d ?? null)} [${num(dWhole?.lo ?? null)}, ${num(dWhole?.hi ?? null)}]; first half ${num(dFirst?.d ?? null)}; second half ${num(dSecond?.d ?? null)}`);
console.log(`win-rate difference (TP1 first, main - ULTRA): ${dWin ? `${num(100 * dWin.d, 1)} points [${num(100 * dWin.lo, 1)}, ${num(100 * dWin.hi, 1)}]` : "-"}`);
console.log(row("main 5 min late", lateMain) + `  (skipped: a level already passed ${lateSkipped["macd"] ?? 0})`);
console.log(row("(イ) 5 min late", lateUltra) + `  (skipped: a level already passed ${lateSkipped["ultra"] ?? 0})`);
const refNote = REFERENCE ? " (not judged: real21 is a reference only)" : "";
console.log(`(a) whole-period d's interval above 0: ${a ? "yes" : "no"}; (b) d above 0 in both halves: ${b ? "yes" : "no"}; (c) five minutes late, main's pips a trade >= ULTRA's: ${c ? "yes" : "no"}${refNote}`);
const mainPips = main["macd"];
// §8.109 勧め方 M7: the sentence says what main's own pips a trade are, besides the comparison
//   mean <= 0                    1回あたりはマイナス
//   mean > 0, the interval to 0  1回あたりがプラスとは言えない (95% の幅が 0 をまたぐ)
//   mean > 0, the interval > 0   1回あたりはプラス
const own = mainPips.pips === null || mainPips.pips <= 0 ? "minus" : mainPips.pipsLo === null || mainPips.pipsLo <= 0 ? "unsure" : "plus";
const ownText = { minus: "1回あたりはマイナス", unsure: "1回あたりがプラスとは言えない（95%の幅が0をまたぐ）", plus: "1回あたりはプラス" }[own];
const mainText = `主の1回あたり ${num(mainPips.pips)} pips [${num(mainPips.pipsLo)}, ${num(mainPips.pipsHi)}]`;
const sentence = a && b && c
  ? `MACD の山・谷に替えるのがよい（3つの条件を満たした）。${mainText}。` + (own === "plus" ? `${ownText}。` : `ただし ULTRA より負けが小さいだけで、${ownText}。`)
  : `ULTRA より良いとは言えない（(a) ${a ? "満たす" : "満たさない"}・(b) ${b ? "満たす" : "満たさない"}・(c) ${c ? "満たす" : "満たさない"}）。${mainText}、${ownText}。`;
console.log(REFERENCE ? `THE SENTENCE: not judged on real21 (a reference only); main's own: ${mainText}、${ownText}` : `THE SENTENCE (§8.109 勧め方): ${sentence}`);
for (const r of ["macd", "ultra", "all", "blind"] as Rule[]) {
  const w = main[r].win;
  if (w !== null && w >= 0.9) console.log(`SUSPICIOUS: ${r} wins ${pct(w)} — check for look-ahead before reading anything else (CLAUDE.md, docs §8.84)`);
}
report.comparison = { dWhole, dFirst, dSecond, dWin, lateMain, lateUltra, a, b, c, own, judged: !REFERENCE, sentence: REFERENCE ? null : sentence };

// reporting only
console.log(`\n== reporting only (not used to choose)`);
const weeks = (NOW - START_MS) / WEEK;
for (const r of ["macd", "ultra"] as Rule[]) {
  const s = main[r];
  // the signals a week count the ones dropped at the data's end too (they were mailed)
  const sent = s.n + (dropped[r] ?? 0);
  console.log(`${r}: ${num(sent / weeks, 1)} signals a week over ${weeks.toFixed(1)} weeks (all pairs; ${sent} = ${s.n} traded + ${dropped[r] ?? 0} dropped at the data's end); pips a week ${num(((s.pips ?? 0) * s.n) / weeks, 1)} (the traded ones)`);
}
const dNoOpen = diffCi(k1("macd", resolved), k1("ultra", resolved), pipsOf);
console.log(`d without the open trades: ${num(dNoOpen?.d ?? null)} [${num(dNoOpen?.lo ?? null)}, ${num(dNoOpen?.hi ?? null)}]`);
const perPair: Record<string, unknown> = {};
const ds: number[] = [];
for (const pair of PAIRS) {
  const m = summarize(k1("macd", (x) => x.pair === pair));
  const u = summarize(k1("ultra", (x) => x.pair === pair));
  const dp = diffCi(k1("macd", (x) => x.pair === pair), k1("ultra", (x) => x.pair === pair), pipsOf);
  if (dp) ds.push(dp.d);
  perPair[pair] = { macd: m, ultra: u, d: dp };
  console.log(`${pair.padEnd(8)} main ${pct(m.win)} ${num(m.pips)}p (n ${m.n})  ULTRA ${pct(u.win)} ${num(u.pips)}p (n ${u.n})  d ${num(dp?.d ?? null)} [${num(dp?.lo ?? null)}, ${num(dp?.hi ?? null)}]`);
}
console.log(`d with the pairs weighted equally: ${ds.length ? num(ds.reduce((s, x) => s + x, 0) / ds.length) : "-"}`);
report.perPair = perPair;
const sum = (f: (x: Diag) => number) => diags.reduce((s, x) => s + f(x), 0);
console.log(`crosses judged ${sum((x) => x.crosses)} (not mailed ${sum((x) => x.unmailed)}, short windows ${sum((x) => x.short)}); fires ${sum((x) => x.fires)}; not fired by C0 ${sum((x) => x.rejC0)}, C1 only ${sum((x) => x.rejC1only)}, C2 only ${sum((x) => x.rejC2only)}, C1 and C2 ${sum((x) => x.rejBoth)}`);
console.log(`decisions with a gap in the 288-bar TR window ${sum((x) => x.gapWindowDecisions)} (fires ${sum((x) => x.gapWindowFires)}); the wave variants would change ${sum((x) => x.variantBeyondChanged)} ("beyond 0.2a") and ${sum((x) => x.variantNearChanged)} ("near 0.2a") decisions`);
console.log(row("main, after a gap (36)", summarize(k1("macd", (x) => x.afterGap === true))));
console.log(row("main, first in its wave", summarize(k1("macd", (x) => x.first === true))));
console.log(row("main, later in its wave", summarize(k1("macd", (x) => x.first === false))));
const q = (xs: number[], p: number) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((u, v) => u - v);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const xs = diags.flatMap((x) => x.xPips);
const as = diags.flatMap((x) => x.aPips);
console.log(`at the fires, x (pips) 10/50/90%: ${num(q(xs, 0.1))} / ${num(q(xs, 0.5))} / ${num(q(xs, 0.9))}; the mean range S/288 (pips): ${num(q(as, 0.1))} / ${num(q(as, 0.5))} / ${num(q(as, 0.9))}`);
for (const k of [2, 3]) {
  for (const [label, rule] of [["main", "macd"], ["(イ) ULTRA", "ultra"]] as Array<[string, Rule]>) {
    const s = summarize(sel((x) => x.rule === rule && x.entry === "close" && x.k === k));
    console.log(row(`${label}, all held to TP${k}`, s, k));
  }
}
console.log(`break-even: TP 4 against the stop 13 needs more than 13/17 = 76.5% TP1 first, and more to pay the spread`);
report.diags = diags.map((x) => ({ ...x, xPips: undefined, aPips: undefined }));
await Deno.writeTextFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
