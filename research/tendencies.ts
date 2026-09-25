// What was each state of the chart followed by? (#100)
//
// The request: 「精度は過去のチャートを分析して傾向を調べて上げて」 — raise the
// accuracy by studying past charts. This script is the study. It is run by
// .github/workflows/research.yml (GitHub's runners can reach GMO; the
// development container cannot), prints its report to the job log, and
// writes the same numbers as JSON to research/out/ for the artifact.
//
// THE METHOD, and the one rule that makes it honest:
//
//   * Every closed bar of GMO's 15-minute bid/ask history since 2024 is a
//     moment the app could have been asked for a plan. At each one the state
//     of the chart is read with analyze/state.ts — the file the analysis
//     itself uses — and a BUY and a SELL are opened the way a published plan
//     is (entry on the ask/bid, stop 0.8 ATR, target 1.5 times the stop,
//     settled on the other side of the book, a bar that reaches both split
//     on the 15-minute bars).
//   * THE RULE: tendencies are looked for in the first period only (before
//     SPLIT) and then checked, untouched, on the second. Anything that only
//     holds in the period it was found in is the data describing itself, and
//     it is reported as such rather than used.
//   * Consecutive entries share their future, so every interval is
//     cluster-robust by trading day (by week on 4h). Treating ninety-six
//     fifteen-minute entries of one day as ninety-six draws would make every
//     interval about ten times too narrow.
//   * Other pairs are the second check: a tendency of the market, rather
//     than of USD/JPY's last two years, should not vanish on EUR/USD.

import { GMO_SYMBOLS, dateKeys, jstDayKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed } from "../supabase/functions/_shared/market-hours.ts";
import { FEATURES, LEVELS, atrSeriesOf, barOpenMs, stateSeries, type Feature, type StateRow } from "../supabase/functions/analyze/state.ts";
import {
  DAY,
  DAY_OFFSET,
  HOUR,
  MINUTE,
  WEEK,
  WEEK_OFFSET,
  aggregate,
  auc,
  clusterRate,
  fitLogistic,
  holm,
  labelAt,
  mid,
  pOne,
  pTwo,
  predict,
  subStarts,
  type Label,
  type LabelSpec,
  type Side,
} from "./lib.ts";

const PAIRS = (Deno.env.get("PAIRS") ?? "USD/JPY,EUR/USD,EUR/JPY,GBP/JPY,AUD/JPY").split(",").map((s) => s.trim());
const START = Deno.env.get("START") ?? "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") ?? "2025-07-01";
const PRIMARY = PAIRS[0];
const SPEC: LabelSpec = { stopAtr: 0.8, rr: 1.5, horizon: 48 };
const BREAKEVEN = 1 / (1 + SPEC.rr);
const CACHE = "research/.cache";
const OUT = "research/out";
const CONCURRENCY = 8;
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
// A state cell with fewer decided trades than this in either period is not
// reported: its interval would be wider than any effect worth acting on.
const MIN_N_DISC = 300;
const MIN_N_VAL = 150;

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "  n/a" : `${(v * 100).toFixed(d)}%`);
const log = (s = "") => console.log(s);

// ---- the history --------------------------------------------------------------

const cachePath = (symbol: string, side: string, key: string) => `${CACHE}/${symbol}/15min/${side}/${key}.json`;

const readCache = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
};

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

// SYNTHETIC=1: a seeded random walk in place of GMO, so the whole pipeline can
// be run where GMO cannot be reached. Its numbers mean nothing.
const synthetic = (pair: string): QuoteCandle[] => {
  // mulberry32. The first version used `s * 1103515245` in plain doubles,
  // which overflows 2^53 and hands back structured garbage in the low bits —
  // the "random" walk trended and the study duly found tendencies in it.
  let s = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: QuoteCandle[] = [];
  let px = 150;
  for (let ms = Date.parse(`${START}T00:00:00Z`); ms + 15 * MINUTE <= NOW; ms += 15 * MINUTE) {
    if (isMarketClosed(ms)) continue;
    const o = px;
    px = o + (rnd() - 0.5) * 0.12;
    const h = Math.max(o, px) + rnd() * 0.03;
    const l = Math.min(o, px) - rnd() * 0.03;
    const dt = new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const bid = { datetime: dt, open: o, high: h, low: l, close: px };
    out.push({ datetime: dt, bid, ask: { ...bid, open: o + 0.004, high: h + 0.004, low: l + 0.004, close: px + 0.004 } });
  }
  return out;
};

const fetchPair = async (pair: string): Promise<{ bars: QuoteCandle[]; requests: number; cached: number; failed: number }> => {
  if (Deno.env.get("SYNTHETIC")) return { bars: synthetic(pair), requests: 0, cached: 0, failed: 0 };
  const symbol = GMO_SYMBOLS[pair];
  if (!symbol) throw new Error(`no GMO symbol for ${pair}`);
  const today = jstDayKey(NOW);
  const keys = dateKeys(Date.parse(`${START}T00:00:00Z`), NOW, "day").filter((k) => k <= today);
  const bid: Array<{ t: number; c: import("../supabase/functions/analyze/indicators.ts").Candle }> = [];
  const ask: typeof bid = [];
  let requests = 0;
  let cached = 0;
  let failed = 0;
  let cursor = 0;
  // The last three days are refetched every run: today's file is still
  // growing and the previous one only settles at the roll.
  const fresh = new Set(keys.slice(-3));
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      for (const side of ["bid", "ask"] as const) {
        const path = cachePath(symbol, side, key);
        let body = fresh.has(key) ? undefined : await readCache(path);
        if (body === undefined) {
          const r = await getJson(klineUrl(symbol, side, "15min", key));
          requests++;
          if (r.status === 0) {
            failed++;
            continue;
          }
          body = r.status === 404 ? { status: 404, data: [] } : r.body;
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await Deno.writeTextFile(path, JSON.stringify(body));
        } else {
          cached++;
        }
        (side === "bid" ? bid : ask).push(...parseKlines(body));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  const bars = mergeSides(bid, ask)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && !isMarketClosed(t) && t + 15 * MINUTE <= NOW;
    })
    .map((q) => ({ ...q, datetime: q.datetime.slice(0, 19).replace("T", " ") }));
  return { bars, requests, cached, failed };
};

// ---- samples ------------------------------------------------------------------

interface Sample {
  t: number;
  decisionMs: number;
  period: "disc" | "val";
  cluster: number;
  state: StateRow;
  label: Record<Side, Label>;
  // UTC hour the plan would have been opened at (the entry bar's close)
  hour: number;
  // The spread paid at entry, as a share of the stop distance
  spreadShare: number;
  spreadPips: number;
  // UTC hour of the bar that settled it, per side (null when unsettled)
  resolvedHour: Record<Side, number | null>;
}

interface Tf {
  name: string;
  intervalMs: number;
  entry: QuoteCandle[];
  h1: { candles: QuoteCandle[]; intervalMs: number };
  h2: { candles: QuoteCandle[]; intervalMs: number };
  sub: QuoteCandle[] | null;
  clusterMs: number;
  clusterOffset: number;
  pip: number;
}

const samplesOf = (tf: Tf): Sample[] => {
  const entryMid = tf.entry.map(mid);
  const states = stateSeries([
    { candles: entryMid, intervalMs: tf.intervalMs },
    { candles: tf.h1.candles.map(mid), intervalMs: tf.h1.intervalMs },
    { candles: tf.h2.candles.map(mid), intervalMs: tf.h2.intervalMs },
  ]);
  const atr = atrSeriesOf(entryMid);
  const sub = tf.sub ? { bars: tf.sub, startOf: subStarts(tf.entry, tf.sub) } : null;
  const out: Sample[] = [];
  for (let t = 0; t < tf.entry.length; t++) {
    const a = atr[t];
    if (a === null || a <= 0) continue;
    const decisionMs = barOpenMs(tf.entry[t].datetime) + tf.intervalMs;
    const buy = labelAt(tf.entry, t, a, "BUY", SPEC, tf.intervalMs, sub);
    const sell = labelAt(tf.entry, t, a, "SELL", SPEC, tf.intervalMs, sub);
    const spread = tf.entry[t].ask.close - tf.entry[t].bid.close;
    const hourOf = (l: Label) =>
      l.bars === null || t + l.bars >= tf.entry.length ? null : new Date(barOpenMs(tf.entry[t + l.bars].datetime)).getUTCHours();
    out.push({
      t,
      decisionMs,
      period: decisionMs < SPLIT_MS ? "disc" : "val",
      cluster: Math.floor((decisionMs - tf.clusterOffset) / tf.clusterMs),
      state: states[t],
      label: { BUY: buy, SELL: sell },
      hour: new Date(decisionMs).getUTCHours(),
      spreadShare: spread / (SPEC.stopAtr * a),
      spreadPips: spread / tf.pip,
      resolvedHour: { BUY: hourOf(buy), SELL: hourOf(sell) },
    });
  }
  return out;
};

const decided = (s: Sample, side: Side) => s.label[side].outcome === "win" || s.label[side].outcome === "loss";
const rate = (list: Sample[], side: Side) =>
  clusterRate(list.filter((s) => decided(s, side)).map((s) => ({ cluster: s.cluster, win: s.label[side].outcome === "win" })));

// ---- the model's columns --------------------------------------------------------

const COLUMNS: Array<{ feature: Feature; level: string }> = FEATURES.flatMap((f) => LEVELS[f].map((level) => ({ feature: f, level })));
const COLUMN_INDEX = new Map(COLUMNS.map((c, i) => [`${c.feature}=${c.level}`, i]));
const rowOf = (s: StateRow): number[] =>
  FEATURES.flatMap((f) => {
    const v = s[f];
    if (v === null) return [];
    const i = COLUMN_INDEX.get(`${f}=${v}`);
    return i === undefined ? [] : [i];
  });

// ---- the analysis ----------------------------------------------------------------

interface CellResult {
  feature: Feature;
  level: string;
  side: Side;
  disc: { n: number; p: number; lo: number; hi: number } | null;
  val: { n: number; p: number; lo: number; hi: number } | null;
  discLift: number | null;
  valLift: number | null;
  pDisc: number;
  pDiscHolm: number;
  pVal: number | null;
  validated: boolean;
}

const ci = (r: ReturnType<typeof clusterRate>) =>
  r === null ? null : { n: r.n, p: r.p, lo: Math.max(0, r.p - 1.96 * r.se), hi: Math.min(1, r.p + 1.96 * r.se) };

const analyseCells = (samples: Sample[], side: Side, features: readonly Feature[] = FEATURES): CellResult[] => {
  const disc = samples.filter((s) => s.period === "disc");
  const val = samples.filter((s) => s.period === "val");
  const cells: CellResult[] = [];
  for (const f of features) {
    for (const level of LEVELS[f]) {
      const inD = disc.filter((s) => s.state[f] === level);
      const outD = disc.filter((s) => s.state[f] !== null && s.state[f] !== level);
      const inV = val.filter((s) => s.state[f] === level);
      const outV = val.filter((s) => s.state[f] !== null && s.state[f] !== level);
      const a = rate(inD, side);
      const b = rate(outD, side);
      const c = rate(inV, side);
      const d = rate(outV, side);
      if (!a || !b || a.n < MIN_N_DISC) continue;
      const zD = (a.p - b.p) / Math.sqrt(a.se ** 2 + b.se ** 2);
      const zV = c && d && c.n >= MIN_N_VAL ? (c.p - d.p) / Math.sqrt(c.se ** 2 + d.se ** 2) : null;
      cells.push({
        feature: f,
        level,
        side,
        disc: ci(a),
        val: c && c.n >= MIN_N_VAL ? ci(c) : null,
        discLift: a.p - b.p,
        valLift: c && d ? c.p - d.p : null,
        pDisc: Number.isFinite(zD) ? pTwo(zD) : 1,
        pDiscHolm: 1,
        // one-sided, in the direction the first period found
        pVal: zV === null || !Number.isFinite(zV) ? null : pOne(Math.sign(a.p - b.p) * zV),
        validated: false,
      });
    }
  }
  const adj = holm(cells.map((c) => c.pDisc));
  cells.forEach((c, i) => (c.pDiscHolm = adj[i]));
  const found = cells.filter((c) => c.pDiscHolm < 0.05);
  // Bonferroni over what the first period put forward
  for (const c of found) c.validated = c.pVal !== null && c.pVal < 0.05 / Math.max(1, found.length);
  return cells;
};

interface ModelResult {
  side: Side;
  weights: number[];
  aucDisc: number | null;
  aucVal: number | null;
  // Validation win rate by quintile of the score, quintile edges set on the
  // first period
  quintiles: Array<{ from: number; to: number; n: number; p: number | null; lo: number | null; hi: number | null }>;
  edges: number[];
}

const fitModel = (samples: Sample[], side: Side): ModelResult => {
  const disc = samples.filter((s) => s.period === "disc" && decided(s, side));
  const val = samples.filter((s) => s.period === "val" && decided(s, side));
  const X = disc.map((s) => rowOf(s.state));
  const y = disc.map((s) => (s.label[side].outcome === "win" ? 1 : 0));
  const w = fitLogistic(X, y, COLUMNS.length, 5);
  const sDisc = X.map((r) => predict(w, r));
  const sVal = val.map((s) => predict(w, rowOf(s.state)));
  const yVal = val.map((s) => (s.label[side].outcome === "win" ? 1 : 0));
  const sorted = [...sDisc].sort((a, b) => a - b);
  const edges = [0.2, 0.4, 0.6, 0.8].map((q) => sorted[Math.floor(q * (sorted.length - 1))]);
  const bucket = (p: number) => edges.filter((e) => p >= e).length;
  const quintiles = [0, 1, 2, 3, 4].map((qi) => {
    const items = val
      .map((s, i) => ({ s, p: sVal[i] }))
      .filter((x) => bucket(x.p) === qi)
      .map((x) => ({ cluster: x.s.cluster, win: x.s.label[side].outcome === "win" }));
    const r = clusterRate(items);
    return {
      from: qi === 0 ? 0 : edges[qi - 1],
      to: qi === 4 ? 1 : edges[qi],
      n: r?.n ?? 0,
      p: r?.p ?? null,
      lo: r ? Math.max(0, r.p - 1.96 * r.se) : null,
      hi: r ? Math.min(1, r.p + 1.96 * r.se) : null,
    };
  });
  return { side, weights: w, aucDisc: auc(sDisc, y), aucVal: auc(sVal, yVal), quintiles, edges };
};

const scoreOther = (model: ModelResult, samples: Sample[]) => {
  const val = samples.filter((s) => s.period === "val" && decided(s, model.side));
  const scores = val.map((s) => predict(model.weights, rowOf(s.state)));
  const y = val.map((s) => (s.label[model.side].outcome === "win" ? 1 : 0));
  const bucket = (p: number) => model.edges.filter((e) => p >= e).length;
  const top = val.filter((_, i) => bucket(scores[i]) === 4).map((s) => ({ cluster: s.cluster, win: s.label[model.side].outcome === "win" }));
  const bottom = val.filter((_, i) => bucket(scores[i]) === 0).map((s) => ({ cluster: s.cluster, win: s.label[model.side].outcome === "win" }));
  return { auc: auc(scores, y), top: clusterRate(top), bottom: clusterRate(bottom), base: clusterRate(val.map((s) => ({ cluster: s.cluster, win: s.label[model.side].outcome === "win" }))) };
};

// ---- timing: when not to open, and why ------------------------------------------

// The windows the first run found: GMO widens its spread around the daily
// roll (21:00-22:00 UTC, 06:00-07:00 JST), and a plan opened in the hours
// before it is still open when the spread spikes.
export const LATE_HOURS = (h: number) => h >= 17 && h <= 23;
const expectancy = (p: number | null) => (p === null ? null : p * SPEC.rr - (1 - p));
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

const timing = (pair: string, tfName: string, samples: Sample[]) => {
  const out: Record<string, unknown> = {};
  const hours: unknown[] = [];
  const primary = pair === PRIMARY;
  if (primary) log(`timing ${pair} ${tfName}: UTC hour of entry -> win rate (both periods), median spread at entry, share of losses settled 21-22 UTC`);
  for (let h = 0; h < 24; h++) {
    const at = samples.filter((s) => s.hour === h);
    if (at.length === 0) continue;
    const b = rate(at, "BUY");
    const se = rate(at, "SELL");
    const losses = at.flatMap((s) => (["BUY", "SELL"] as Side[]).filter((side) => s.label[side].outcome === "loss").map((side) => s.resolvedHour[side]));
    const atRoll = losses.filter((x) => x === 21 || x === 22).length / Math.max(1, losses.length);
    const sp = median(at.map((s) => s.spreadPips));
    hours.push({ hour: h, n: at.length, buy: b?.p ?? null, sell: se?.p ?? null, spreadPips: sp, lossesAtRoll: atRoll });
    if (primary) log(`  ${String(h).padStart(2, "0")}h n=${String(at.length).padStart(5)} BUY ${pct(b?.p)} SELL ${pct(se?.p)} spread ${sp?.toFixed(2)}p  losses@21-22 ${pct(atRoll, 0)}`);
  }
  out.hours = hours;
  // the spread paid at entry, as a share of the stop
  const edges = [0.05, 0.1, 0.2, 0.4];
  const names = ["<5%", "5-10%", "10-20%", "20-40%", ">=40%"];
  const shares = names.map((name, i) => {
    const lo = i === 0 ? -Infinity : edges[i - 1];
    const hi = i === edges.length ? Infinity : edges[i];
    const inBin = samples.filter((s) => s.spreadShare >= lo && s.spreadShare < hi);
    return { bin: name, n: inBin.length, buy: rate(inBin, "BUY")?.p ?? null, sell: rate(inBin, "SELL")?.p ?? null };
  });
  out.spreadShare = shares;
  if (primary) log(`  spread/stop: ${shares.map((x) => `${x.bin} n=${x.n} BUY ${pct(x.buy)} SELL ${pct(x.sell)}`).join(" | ")}`);
  // the candidate rules, judged on the SECOND period only
  const rules: Array<{ name: string; drop: (s: Sample) => boolean }> = [
    { name: "late(17-23UTC)", drop: (s) => LATE_HOURS(s.hour) },
    { name: "late+quiet", drop: (s) => LATE_HOURS(s.hour) || s.state.vol === "quiet" },
    { name: "spread>=20%", drop: (s) => s.spreadShare >= 0.2 },
  ];
  const val = samples.filter((s) => s.period === "val");
  const judged = rules.map((r) => {
    const kept = val.filter((s) => !r.drop(s));
    const dropped = val.filter((s) => r.drop(s));
    const row: Record<string, unknown> = { rule: r.name, keptShare: kept.length / Math.max(1, val.length) };
    for (const side of ["BUY", "SELL"] as Side[]) {
      const k = rate(kept, side);
      const d = rate(dropped, side);
      const all = rate(val, side);
      row[side] = {
        all: all?.p ?? null,
        kept: k?.p ?? null,
        keptLo: k ? k.p - 1.96 * k.se : null,
        keptHi: k ? k.p + 1.96 * k.se : null,
        dropped: d?.p ?? null,
        eAll: expectancy(all?.p ?? null),
        eKept: expectancy(k?.p ?? null),
      };
    }
    return row;
  });
  out.rules = judged;
  for (const r of judged) {
    const b = r.BUY as Record<string, number | null>;
    const se = r.SELL as Record<string, number | null>;
    log(`  rule ${pair} ${tfName} ${String(r.rule).padEnd(15)} keep ${pct(r.keptShare as number, 0)} | BUY all ${pct(b.all)} -> kept ${pct(b.kept)} [${pct(b.keptLo)}-${pct(b.keptHi)}] dropped ${pct(b.dropped)} E ${b.eAll?.toFixed(2)}R -> ${b.eKept?.toFixed(2)}R | SELL all ${pct(se.all)} -> kept ${pct(se.kept)} [${pct(se.keptLo)}-${pct(se.keptHi)}] dropped ${pct(se.dropped)} E ${se.eAll?.toFixed(2)}R -> ${se.eKept?.toFixed(2)}R`);
  }
  return out;
};

// Once the costly hours are set aside, is there a DIRECTIONAL tendency left?
// Only the features that could say which way price goes are tested here.
const DIRECTIONAL: readonly Feature[] = FEATURES.filter((f) => !["session", "dow", "vol"].includes(f));
const cleanDirection = (pair: string, tfName: string, samples: Sample[]) => {
  const clean = samples.filter((s) => !LATE_HOURS(s.hour) && s.state.vol !== "quiet");
  const out: Record<string, unknown> = { n: clean.length };
  for (const side of ["BUY", "SELL"] as Side[]) {
    const cells = analyseCells(clean, side, DIRECTIONAL);
    const found = cells.filter((c) => c.pDiscHolm < 0.05).sort((a, b) => Math.abs(b.discLift ?? 0) - Math.abs(a.discLift ?? 0));
    log(`clean ${pair} ${tfName} ${side}: ${clean.length} entries outside late hours and quiet volatility; ${cells.length} directional cells, ${found.length} significant first, ${found.filter((c) => c.validated).length} confirmed`);
    for (const c of found) {
      log(`  ${c.validated ? "OK " : "-- "}${side} ${c.feature}=${c.level}: disc ${pct(c.disc?.p)} n=${c.disc?.n} lift ${pct(c.discLift)} | val ${pct(c.val?.p)} n=${c.val?.n ?? 0} lift ${pct(c.valLift)} p=${c.pVal === null ? "n/a" : c.pVal.toExponential(1)}`);
    }
    const m = fitModel(clean, side);
    log(`  clean model ${side}: AUC disc ${m.aucDisc?.toFixed(3)} val ${m.aucVal?.toFixed(3)}  val quintiles ${m.quintiles.map((q) => pct(q.p, 0)).join(" / ")}`);
    out[side] = { cells: found, aucDisc: m.aucDisc, aucVal: m.aucVal, quintiles: m.quintiles };
  }
  return out;
};

// ---- main -------------------------------------------------------------------------

const main = async () => {
  log(`# research/tendencies.ts  pairs=${PAIRS.join(",")}  start=${START}  split=${SPLIT}  spec=stop ${SPEC.stopAtr}ATR rr ${SPEC.rr} horizon ${SPEC.horizon}  breakeven=${pct(BREAKEVEN)}`);
  await Deno.mkdir(OUT, { recursive: true });
  const report: Record<string, unknown> = { pairs: PAIRS, start: START, split: SPLIT, spec: SPEC, breakeven: BREAKEVEN, generatedAt: new Date(NOW).toISOString(), byPair: {} };
  const models: Record<string, Record<string, ModelResult>> = {};
  const samplesByPairTf: Record<string, Record<string, Sample[]>> = {};

  for (const pair of PAIRS) {
    const t0 = Date.now();
    const { bars, requests, cached, failed } = await fetchPair(pair);
    log(`\n## ${pair}: ${bars.length} 15min bars ${bars[0]?.datetime ?? "-"} .. ${bars[bars.length - 1]?.datetime ?? "-"}  (requests ${requests}, cached ${cached}, failed ${failed}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (bars.length < 5000) continue;
    const pip = pair.includes("JPY") ? 0.01 : 0.0001;
    const h1 = aggregate(bars, HOUR, 0, NOW);
    const h4 = aggregate(bars, 4 * HOUR, 0, NOW);
    const d1 = aggregate(bars, DAY, DAY_OFFSET, NOW);
    const w1 = aggregate(bars, WEEK, WEEK_OFFSET, NOW);
    const tfs: Tf[] = [
      { name: "15min", intervalMs: 15 * MINUTE, entry: bars, h1: { candles: h1, intervalMs: HOUR }, h2: { candles: h4, intervalMs: 4 * HOUR }, sub: null, clusterMs: DAY, clusterOffset: DAY_OFFSET, pip },
      { name: "1h", intervalMs: HOUR, entry: h1, h1: { candles: h4, intervalMs: 4 * HOUR }, h2: { candles: d1, intervalMs: DAY }, sub: bars, clusterMs: DAY, clusterOffset: DAY_OFFSET, pip },
      { name: "4h", intervalMs: 4 * HOUR, entry: h4, h1: { candles: d1, intervalMs: DAY }, h2: { candles: w1, intervalMs: WEEK }, sub: bars, clusterMs: WEEK, clusterOffset: WEEK_OFFSET, pip },
    ];
    samplesByPairTf[pair] = {};
    const pairReport: Record<string, unknown> = {};
    for (const tf of tfs) {
      const samples = samplesOf(tf);
      samplesByPairTf[pair][tf.name] = samples;
      const outcomes = (side: Side) => {
        const c: Record<string, number> = {};
        for (const s of samples) c[s.label[side].outcome] = (c[s.label[side].outcome] ?? 0) + 1;
        return c;
      };
      const tfReport: Record<string, unknown> = { bars: tf.entry.length, samples: samples.length, outcomes: { BUY: outcomes("BUY"), SELL: outcomes("SELL") } };
      log(`\n### ${pair} ${tf.name}: ${samples.length} entries  BUY ${JSON.stringify(outcomes("BUY"))}  SELL ${JSON.stringify(outcomes("SELL"))}`);
      for (const side of ["BUY", "SELL"] as Side[]) {
        const d = rate(samples.filter((s) => s.period === "disc"), side);
        const v = rate(samples.filter((s) => s.period === "val"), side);
        log(`base ${side}: disc ${pct(d?.p)} ±${pct(d ? 1.96 * d.se : null)} (n=${d?.n ?? 0}, clusters ${d?.clusters ?? 0})  val ${pct(v?.p)} ±${pct(v ? 1.96 * v.se : null)} (n=${v?.n ?? 0})`);
        tfReport[`base_${side}`] = { disc: ci(d), val: ci(v) };
      }
      if (pair === PRIMARY || PAIRS.length === 1) {
        models[tf.name] = {};
        for (const side of ["BUY", "SELL"] as Side[]) {
          const cells = analyseCells(samples, side);
          const found = cells.filter((c) => c.pDiscHolm < 0.05).sort((a, b) => Math.abs(b.discLift ?? 0) - Math.abs(a.discLift ?? 0));
          log(`cells ${side}: ${cells.length} tested, ${found.length} significant in the first period (Holm 5%), ${found.filter((c) => c.validated).length} confirmed on the second`);
          for (const c of found) {
            log(`  ${c.validated ? "OK " : "-- "}${side} ${c.feature}=${c.level}: disc ${pct(c.disc?.p)} [${pct(c.disc?.lo)}-${pct(c.disc?.hi)}] n=${c.disc?.n} lift ${c.discLift! >= 0 ? "+" : ""}${pct(c.discLift)} | val ${pct(c.val?.p)} [${pct(c.val?.lo)}-${pct(c.val?.hi)}] n=${c.val?.n ?? 0} lift ${c.valLift !== null && c.valLift >= 0 ? "+" : ""}${pct(c.valLift)} p=${c.pVal === null ? "n/a" : c.pVal.toExponential(1)}`);
          }
          tfReport[`cells_${side}`] = cells;
          const m = fitModel(samples, side);
          models[tf.name][side] = m;
          log(`model ${side}: AUC disc ${m.aucDisc?.toFixed(3)} val ${m.aucVal?.toFixed(3)}  val win rate by quintile (edges from disc):`);
          for (const q of m.quintiles) log(`    q ${pct(q.from, 0)}-${pct(q.to, 0)}: ${pct(q.p)} [${pct(q.lo)}-${pct(q.hi)}] n=${q.n}`);
          tfReport[`model_${side}`] = { aucDisc: m.aucDisc, aucVal: m.aucVal, quintiles: m.quintiles, edges: m.edges };
        }
      }
      if (tf.name !== "4h") tfReport.timing = timing(pair, tf.name, samples);
      if (pair === PRIMARY && tf.name !== "4h") tfReport.clean = cleanDirection(pair, tf.name, samples);
      pairReport[tf.name] = tfReport;
    }
    (report.byPair as Record<string, unknown>)[pair] = pairReport;
  }

  // The second check: the primary pair's models on the other pairs' second period
  log(`\n## the ${PRIMARY} models on the other pairs (second period only)`);
  const cross: Record<string, unknown> = {};
  for (const pair of PAIRS.slice(1)) {
    for (const tfName of Object.keys(models)) {
      const samples = samplesByPairTf[pair]?.[tfName];
      if (!samples) continue;
      for (const side of ["BUY", "SELL"] as Side[]) {
        const r = scoreOther(models[tfName][side], samples);
        log(`  ${pair} ${tfName} ${side}: AUC ${r.auc?.toFixed(3)}  top quintile ${pct(r.top?.p)} (n=${r.top?.n ?? 0})  bottom ${pct(r.bottom?.p)} (n=${r.bottom?.n ?? 0})  base ${pct(r.base?.p)}`);
        cross[`${pair}|${tfName}|${side}`] = { auc: r.auc, top: r.top, bottom: r.bottom, base: r.base };
      }
    }
  }
  report.cross = cross;

  // What the app would carry: the fitted weights and their validation calibration
  const modelOut = {
    pair: PRIMARY,
    start: START,
    split: SPLIT,
    spec: SPEC,
    columns: COLUMNS.map((c) => `${c.feature}=${c.level}`),
    models: Object.fromEntries(Object.entries(models).map(([tf, m]) => [tf, Object.fromEntries(Object.entries(m).map(([side, r]) => [side, {
      weights: r.weights.map((x) => Number(x.toFixed(4))),
      edges: r.edges.map((x) => Number(x.toFixed(4))),
      aucDisc: r.aucDisc,
      aucVal: r.aucVal,
      quintiles: r.quintiles,
    }]))])),
  };
  await Deno.writeTextFile(`${OUT}/report.json`, JSON.stringify(report));
  await Deno.writeTextFile(`${OUT}/model.json`, JSON.stringify(modelOut));
  const bytes = new TextEncoder().encode(JSON.stringify(modelOut));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
  log(`\nmodel.json ${bytes.length} bytes sha256 ${hash}`);
};

await main();
