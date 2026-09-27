// #132: which setting of each indicator wins most often? The owner:
// 「それぞれのインジケーターを無理やりどういう設定にしたら勝率が上がるか検証して、
// 一番勝率の高い設定を探してそれをそのインジケーターに設定してください。
// それぞれのインジケーターの分析の仕方はもちろん守って」
//
// THE METHOD, fixed before any data was read:
//
//   * Each indicator keeps its own way of reading the chart: only its numeric
//     settings are searched, over a grid set here in advance (the current
//     setting is on every grid).
//   * Its exit is its own and never searched: a closer target alone would
//     raise any win rate without the timing being any better. The GA rule and
//     every chart-only indicator: stop 1 ATR(14), target 2x (r2w, break-even
//     33.3%); RSI + SAR: the app's plan, stop 0.8 ATR, target 1.5x (break-even
//     40%). With the exit fixed, a higher win rate is a higher expectancy.
//   * The same footing as research/gainz.ts: GMO's 15-minute bid/ask since
//     2024-01, eleven pairs, read on 15min, 1h and 4h; entries at the signal
//     bar's close on the side of the book they fill on, spread paid; 15min
//     and 1h leave out 17:00-23:59 UTC; 48 bars at most; blind entries at
//     every bar of the same pair, timeframe, side and UTC hour as the
//     yardstick; intervals cluster-robust by calendar week.
//   * THE CHOICE: the setting with the highest win rate on the FIRST period
//     (before SPLIT), all three timeframes together, among those with at
//     least MIN_TRADES trades there (so a handful of lucky trades cannot
//     win). The SECOND period, never seen by the choice, says whether it
//     holds. Both are reported, with the current setting beside them.
//   * The Weighted Volume Profile draws no signal, so it has no win rate.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, mid, subStarts, type LabelSpec, type Side } from "./lib.ts";
import { revCtxOf, tradeR, type RevCtx } from "./reversal.ts";
import { fetchPair } from "./gmo.ts";
import { engulfs, trueRange } from "../supabase/functions/analyze/gainz.ts";
import { parabolicSar, wilderRsi } from "../supabase/functions/analyze/rsisar.ts";
import { kalmanSupertrend } from "../src/lib/kalmanSupertrend.ts";
import { zoneShift } from "../src/lib/zoneShift.ts";
import { dowTheory } from "../supabase/functions/_shared/dow.ts";
import { gainzPro, GP_DEFAULTS } from "../src/lib/gainzPro.ts";
import { stochastic } from "../src/lib/stochastic.ts";
import { fvgCrossfire, FVG_DEFAULTS } from "../src/lib/fvgCrossfire.ts";

const ALL_PAIRS = "USD/JPY,EUR/JPY,GBP/JPY,AUD/JPY,NZD/JPY,CAD/JPY,CHF/JPY,EUR/USD,GBP/USD,AUD/USD,NZD/USD";
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-07-01";
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const CACHE = "research/.cache";
const OUT = "research/out";
const WARMUP = 210;
const MIN_TRADES = 300;
const TFS = ["15min", "1h", "4h"] as const;
type Tf = (typeof TFS)[number];
const costly = (tf: Tf, hour: number) => tf !== "4h" && hour >= 17 && hour <= 23;

const EXITS: Record<"r2w" | "app" | "r1w", LabelSpec> = {
  r2w: { stopAtr: 1.0, rr: 2, horizon: 48 },
  app: { stopAtr: 0.8, rr: 1.5, horizon: 48 },
  // not searched on: RSI + SAR's "hit" evidence (1 ATR either way first),
  // which the app quotes beside its win rate
  r1w: { stopAtr: 1.0, rr: 1, horizon: 48 },
};
type Exit = keyof typeof EXITS;

// ---- the indicators, their settings and their grids ------------------------------

type Params = Record<string, number>;
// what one pair and timeframe's signal generators may keep between settings
type Memo = Map<string, unknown>;
const memo = <T>(m: Memo, key: string, f: () => T): T => {
  if (!m.has(key)) m.set(key, f());
  return m.get(key) as T;
};

interface Family {
  key: string;
  title: string;
  exit: Exit;
  // exits also counted (reported for the current and the chosen setting)
  alsoExits?: Exit[];
  current: Params;
  grid: Params[];
  // +1 buy, -1 sell, 0 none, per bar
  signals: (x: RevCtx, p: Params, m: Memo) => Int8Array;
}

const product = (axes: Record<string, number[]>): Params[] => {
  let out: Params[] = [{}];
  for (const [k, vs] of Object.entries(axes)) out = out.flatMap((p) => vs.map((v) => ({ ...p, [k]: v })));
  return out;
};
const nameOf = (p: Params) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ");
const fromMap = (n: number, entries: Iterable<[number, 1 | -1]>) => {
  const out = new Int8Array(n);
  for (const [i, d] of entries) if (i >= 0 && i < n) out[i] = d;
  return out;
};

const FAMILIES: Family[] = [
  {
    // analyze/gainz.ts: engulfing, a stable body, RSI(14) on its side, the
    // close against `delta` bars back
    key: "ga",
    title: "GA型（GainzAlgo V2 Alpha 型）: 包み足・実体の割合・RSI(14)・N本前との比較",
    exit: "r2w",
    current: { stability: 0.5, rsiLevel: 50, delta: 5 },
    grid: product({ stability: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8], rsiLevel: [30, 40, 50, 60, 70], delta: [2, 3, 5, 7, 10, 15] }),
    signals: (x, p, m) => {
      const rsi = memo(m, "rsi14", () => wilderRsi(x.c.map((c) => c.close)).rsi);
      const out = new Int8Array(x.c.length);
      for (let i = Math.max(1, p.delta); i < x.c.length; i++) {
        const r = rsi[i];
        const tr = trueRange(x.c, i);
        if (r === null || !(tr > 0) || Math.abs(x.c[i].close - x.c[i].open) / tr <= p.stability) continue;
        const then = x.c[i - p.delta].close;
        if (engulfs(x.c, i, "BUY") && r < p.rsiLevel && x.c[i].close < then) out[i] = 1;
        else if (engulfs(x.c, i, "SELL") && r > 100 - p.rsiLevel && x.c[i].close > then) out[i] = -1;
      }
      return out;
    },
  },
  {
    // analyze/rsisar.ts: RSI back across its level with the SAR on that side
    key: "rsi_sar",
    title: "RSI＋SAR（アプリの分析）: RSI が売られすぎの水準から戻し、SAR が同じ側",
    exit: "app",
    alsoExits: ["r1w"],
    current: { period: 14, level: 30, sarStep: 0.02, sarMax: 0.2 },
    grid: product({ period: [7, 9, 14, 21], level: [20, 25, 30, 35, 40], sarStep: [0.01, 0.02, 0.03] }).map((p) => ({ ...p, sarMax: p.sarStep * 10 })),
    signals: (x, p, m) => {
      const rsi = memo(m, `rsi${p.period}`, () => wilderRsi(x.c.map((c) => c.close), p.period).rsi);
      const long = memo(m, `sar${p.sarStep}/${p.sarMax}`, () => parabolicSar(x.c, p.sarStep, p.sarMax).long);
      const out = new Int8Array(x.c.length);
      for (let i = 1; i < x.c.length; i++) {
        const a = rsi[i - 1];
        const b = rsi[i];
        if (a === null || b === null) continue;
        if (a <= p.level && b > p.level && long[i] === true) out[i] = 1;
        else if (a >= 100 - p.level && b < 100 - p.level && long[i] === false) out[i] = -1;
      }
      return out;
    },
  },
  {
    // src/lib/kalmanSupertrend.ts: a turn of the Supertrend with RSI(14) on
    // its side of 50
    key: "spectra",
    title: "SPECTRA型: カルマン平滑のスーパートレンドの反転、RSI(14) が50の側",
    exit: "r2w",
    current: { factor: 3, atrLength: 10, r: 0.1 },
    grid: product({ factor: [1.5, 2, 2.5, 3, 4], atrLength: [7, 10, 14, 20], r: [0.02, 0.1, 0.5] }),
    signals: (x, p) =>
      fromMap(x.c.length, kalmanSupertrend(x.c, { q: 0.01, r: p.r, atrLength: p.atrLength, factor: p.factor, rsiLength: 14 }).flips
        .filter((f) => f.passed)
        .map((f) => [f.i, f.side === "BUY" ? 1 : -1] as [number, 1 | -1])),
  },
  {
    // src/lib/zoneShift.ts: its turns and its retest diamonds, each in the
    // trend's direction (both are what the chart marks)
    key: "zone_shift",
    title: "Zone Shift: トレンドの転換（足の色が変わる足）と再テスト◆、トレンドの向きに",
    exit: "r2w",
    current: { length: 100, rangeLength: 200, retestGap: 5 },
    grid: product({ length: [50, 75, 100, 150, 200], rangeLength: [100, 200, 400], retestGap: [3, 5, 10] }),
    signals: (x, p) => {
      const z = zoneShift(x.c, x.c.length - 1, { length: p.length, rangeLength: p.rangeLength, retestGap: p.retestGap });
      const out = new Int8Array(x.c.length);
      for (const r of z.retests) out[r.i] = r.up ? 1 : -1;
      for (let i = 1; i < z.up.length; i++) if (z.up[i] !== z.up[i - 1]) out[i] = z.up[i] ? 1 : -1;
      return out;
    },
  },
  {
    // supabase/functions/_shared/dow.ts: the confirmed turn (the reel's
    // "もう1回…確定"), in the new direction
    key: "dow",
    title: "ダウ理論: 2回目の確定（転換の確定）で新しい向きに。設定は山と谷の左右の本数",
    exit: "r2w",
    current: { pivot: 5 },
    grid: product({ pivot: [2, 3, 4, 5, 6, 8, 10, 12] }),
    signals: (x, p) =>
      fromMap(x.c.length, dowTheory(x.c, p.pivot).events.filter((e) => e.kind === "confirm").map((e) => [e.i, e.dir === "up" ? 1 : -1] as [number, 1 | -1])),
  },
  {
    // src/lib/gainzPro.ts: the four parts ranked, the score's rank at or over
    // the threshold on a bar with the structure
    key: "gainz_pro",
    title: "Pro型（点数）: 4つの部品の順位の平均が直近の上位に入った陰線→陽線の足（売りは鏡像）",
    exit: "r2w",
    current: { window: 100, threshold: 0.95, emaLength: 50 },
    grid: product({ window: [50, 100, 200], threshold: [0.8, 0.9, 0.95, 0.98], emaLength: [20, 50, 100] }),
    signals: (x, p) =>
      fromMap(x.c.length, gainzPro(x.c, { ...GP_DEFAULTS, window: p.window, threshold: p.threshold, emaLength: p.emaLength }).signals
        .map((s) => [s.i, s.side === "BUY" ? 1 : -1] as [number, 1 | -1])),
  },
  {
    // src/lib/stochastic.ts: %K leaving its zone — a sell on the first bar
    // under `level` from at or over it, a buy over 100 − level from at or
    // under it (research/gainz.ts st_out)
    key: "stoch",
    title: "ストキャス: %K が上の水準を上から下に抜けたら売り、下の水準を下から上に抜けたら買い",
    exit: "r2w",
    current: { kLength: 14, kSmoothing: 1, level: 80 },
    grid: product({ kLength: [5, 9, 14, 21], kSmoothing: [1, 3, 5], level: [70, 75, 80, 85, 90] }),
    signals: (x, p, m) => {
      const k = memo(m, `k${p.kLength}/${p.kSmoothing}`, () => stochastic(x.c, { kLength: p.kLength, kSmoothing: p.kSmoothing, dSmoothing: 3 }).k);
      const out = new Int8Array(x.c.length);
      for (let i = 1; i < k.length; i++) {
        const a = k[i - 1];
        const b = k[i];
        if (a === null || b === null) continue;
        if (a >= p.level && b < p.level) out[i] = -1;
        else if (a <= 100 - p.level && b > 100 - p.level) out[i] = 1;
      }
      return out;
    },
  },
  {
    // src/lib/fvgCrossfire.ts: the retest arrows, in the zone's direction
    key: "fvg",
    title: "FVG Crossfire: 再テストの矢印（▲買い・▼売り）。設定は埋まり判定の遅れと最小のギャップ幅",
    exit: "r2w",
    current: { snapBars: 3, minGapPct: 0 },
    grid: product({ snapBars: [1, 2, 3, 5], minGapPct: [0, 0.005, 0.01, 0.02, 0.05] }),
    signals: (x, p) =>
      fromMap(x.c.length, fvgCrossfire(x.c, x.c.length - 1, { ...FVG_DEFAULTS, snapBars: p.snapBars, minGapPct: p.minGapPct }).retestEvents
        .map((e) => [e.i, e.dir] as [number, 1 | -1])),
  },
];
// the current setting on every grid, once
for (const f of FAMILIES) {
  if (!f.grid.some((p) => nameOf(p) === nameOf(f.current))) f.grid.unshift(f.current);
}

// ---- accumulation (as research/gainz.ts) -----------------------------------------------

interface Acc {
  n: number;
  r: number;
  base: number;
  res: number;
  w: number;
}
type Period = "disc" | "val";
const agg = new Map<string, Map<number, Acc>>();
const keyOf = (fam: string, setting: string, period: Period, scope: string) => `${fam}|${setting}|${period}|${scope}`;
const add = (key: string, week: number, r: number, base: number, outcome: string) => {
  let m = agg.get(key);
  if (!m) agg.set(key, (m = new Map()));
  const a = m.get(week) ?? { n: 0, r: 0, base: 0, res: 0, w: 0 };
  a.n++;
  a.r += r;
  a.base += base;
  if (outcome !== "expired") {
    a.res++;
    if (outcome === "win") a.w++;
  }
  m.set(week, a);
};
interface Stat {
  n: number;
  // trades that reached the stop or the target (the win rate's count)
  res: number;
  win: number | null;
  seW: number | null;
  e: number;
  seE: number;
  lift: number;
  seL: number;
}
const statOf = (key: string): Stat | null => {
  const m = agg.get(key);
  if (!m || m.size === 0) return null;
  let n = 0, r = 0, b = 0, res = 0, w = 0;
  for (const a of m.values()) {
    n += a.n;
    r += a.r;
    b += a.base;
    res += a.res;
    w += a.w;
  }
  if (n === 0) return null;
  const e = r / n;
  const lift = e - b / n;
  const win = res > 0 ? w / res : null;
  const C = m.size;
  let se = 0, sl = 0, sw = 0;
  for (const a of m.values()) {
    se += (a.r - e * a.n) ** 2;
    sl += (a.r - a.base - lift * a.n) ** 2;
    if (win !== null) sw += (a.w - win * a.res) ** 2;
  }
  const f = C > 1 ? C / (C - 1) : Number.NaN;
  return { n, res, win, seW: win === null || res === 0 ? null : Math.sqrt(f * sw) / res, e, seE: Math.sqrt(f * se) / n, lift, seL: Math.sqrt(f * sl) / n };
};

// ---- one timeframe of one pair ---------------------------------------------------------

const study = (tf: Tf, entry: QuoteCandle[], intervalMs: number, sub: QuoteCandle[] | null) => {
  const n = entry.length;
  const x = revCtxOf(entry.map(mid));
  const subIdx = sub ? { bars: sub, startOf: subStarts(entry, sub) } : null;
  const eligible = new Uint8Array(n);
  const hourOf = new Int8Array(n);
  const periodOf: Period[] = new Array(n);
  const weekOf = new Int32Array(n);
  const R: Record<Exit, Record<Side, Float64Array>> = {} as never;
  const O: Record<Exit, Record<Side, Array<string | null>>> = {} as never;
  for (const ex of Object.keys(EXITS) as Exit[]) {
    R[ex] = { BUY: new Float64Array(n).fill(Number.NaN), SELL: new Float64Array(n).fill(Number.NaN) };
    O[ex] = { BUY: new Array(n).fill(null), SELL: new Array(n).fill(null) };
  }
  const base: Record<string, { n: number; r: number }> = {};
  const baseKey = (ex: string, period: Period, side: Side, hour: number) => `${ex}|${period}|${side}|${hour}`;
  for (let t = WARMUP; t < n; t++) {
    const a = x.atr[t];
    if (a === null || !(a > 0)) continue;
    const decisionMs = barOpenMs(entry[t].datetime) + intervalMs;
    const hour = new Date(decisionMs).getUTCHours();
    if (costly(tf, hour)) continue;
    eligible[t] = 1;
    hourOf[t] = hour;
    const period: Period = decisionMs < SPLIT_MS ? "disc" : "val";
    periodOf[t] = period;
    weekOf[t] = Math.floor((decisionMs - WEEK_OFFSET) / WEEK);
    for (const ex of Object.keys(EXITS) as Exit[]) {
      for (const side of ["BUY", "SELL"] as Side[]) {
        const tr = tradeR(entry, t, a, side, EXITS[ex], intervalMs, subIdx);
        if (!tr) continue;
        R[ex][side][t] = tr.r;
        O[ex][side][t] = tr.outcome;
        const c = base[baseKey(ex, period, side, hour)] ?? (base[baseKey(ex, period, side, hour)] = { n: 0, r: 0 });
        c.n++;
        c.r += tr.r;
      }
    }
  }
  const baseAt = (ex: string, period: Period, side: Side, hour: number) => {
    const c = base[baseKey(ex, period, side, hour)];
    return c && c.n > 0 ? c.r / c.n : null;
  };
  for (const fam of FAMILIES) {
    const m: Memo = new Map();
    for (const p of fam.grid) {
      const sig = fam.signals(x, p, m);
      const setting = nameOf(p);
      for (let t = WARMUP; t < n; t++) {
        const d = sig[t];
        if (d === 0 || !eligible[t]) continue;
        const side: Side = d === 1 ? "BUY" : "SELL";
        const r = R[fam.exit][side][t];
        const b = baseAt(fam.exit, periodOf[t], side, hourOf[t]);
        if (Number.isNaN(r) || b === null) continue;
        for (const scope of ["all", `tf:${tf}`]) add(keyOf(fam.key, setting, periodOf[t], scope), weekOf[t], r, b, O[fam.exit][side][t]!);
        for (const ex of fam.alsoExits ?? []) {
          const r2 = R[ex][side][t];
          const b2 = baseAt(ex, periodOf[t], side, hourOf[t]);
          if (Number.isNaN(r2) || b2 === null) continue;
          for (const scope of ["all", `tf:${tf}`]) add(keyOf(fam.key, `${setting}|${ex}`, periodOf[t], scope), weekOf[t], r2, b2, O[ex][side][t]!);
        }
      }
    }
  }
};

// ---- the report ---------------------------------------------------------------------------

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const rr = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}R`);
const ci = (x: number, se: number, f: (v: number) => string) => `${f(x)} [${f(x - 1.96 * se)}〜${f(x + 1.96 * se)}]`;
const line = (label: string, s: Stat | null) =>
  `${label.padEnd(44)} n=${String(s?.n ?? 0).padStart(6)} (settled ${String(s?.res ?? 0).padStart(6)}) win ${s && s.win !== null && s.seW !== null ? ci(s.win, s.seW, (v) => pct(v)) : "n/a"} | E ${s ? ci(s.e, s.seE, (v) => rr(v)) : "n/a"} | lift ${s ? ci(s.lift, s.seL, (v) => rr(v)) : "n/a"}`;
const log = (s = "") => console.log(s);

const main = async () => {
  const t0 = Date.now();
  log(`# research/tune.ts  pairs=${PAIRS.length}  start=${START}  split=${SPLIT}  min trades (first period)=${MIN_TRADES}`);
  for (const f of FAMILIES) log(`${f.key}: ${f.grid.length} settings, exit ${f.exit} (stop ${EXITS[f.exit].stopAtr} ATR, target ${EXITS[f.exit].rr}x, break-even ${pct(1 / (1 + EXITS[f.exit].rr))})`);
  await Deno.mkdir(OUT, { recursive: true });
  for (const pair of PAIRS) {
    const t1 = Date.now();
    const { bars } = await fetchPair(pair, { start: START, now: NOW, cache: CACHE, concurrency: 8 });
    if (bars.length < 5000) {
      log(`## ${pair}: ${bars.length} bars, skipped`);
      continue;
    }
    study("15min", bars, 15 * MINUTE, null);
    study("1h", aggregate(bars, HOUR, 0, NOW), HOUR, bars);
    study("4h", aggregate(bars, 4 * HOUR, 0, NOW), 4 * HOUR, bars);
    log(`## ${pair}: ${bars.length} 15min bars ${bars[0].datetime} .. ${bars[bars.length - 1].datetime}, studied in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  }

  const report: Record<string, unknown> = { start: START, split: SPLIT, minTrades: MIN_TRADES, generatedAt: new Date(NOW).toISOString(), families: {} };
  for (const f of FAMILIES) {
    const S = (p: Params, period: Period, scope = "all") => statOf(keyOf(f.key, nameOf(p), period, scope));
    const ranked = f.grid
      .map((p) => ({ p, disc: S(p, "disc"), val: S(p, "val") }))
      .filter((r) => r.disc && r.disc.n >= MIN_TRADES && r.disc.win !== null)
      .sort((a, b) => b.disc!.win! - a.disc!.win! || b.disc!.n - a.disc!.n);
    const best = ranked[0] ?? null;
    log(`\n# ${f.key}: ${f.title}`);
    log(`## exit ${f.exit}; ${f.grid.length} settings, ${ranked.length} with at least ${MIN_TRADES} trades in the first period`);
    log(`## current: ${nameOf(f.current)}`);
    log(line("current 1st", S(f.current, "disc")));
    log(line("current 2nd", S(f.current, "val")));
    for (const tf of TFS) log(line(`current ${tf} 2nd`, S(f.current, "val", `tf:${tf}`)));
    if (best) {
      log(`## CHOSEN (highest first-period win rate): ${nameOf(best.p)}`);
      log(line("chosen 1st", best.disc));
      log(line("chosen 2nd", best.val));
      for (const tf of TFS) {
        log(line(`chosen ${tf} 1st`, S(best.p, "disc", `tf:${tf}`)));
        log(line(`chosen ${tf} 2nd`, S(best.p, "val", `tf:${tf}`)));
      }
    }
    for (const ex of f.alsoExits ?? []) {
      for (const [label, p] of [["current", f.current], ...(best ? [["chosen", best.p] as const] : [])] as Array<readonly [string, Params]>) {
        const X = (period: Period, scope: string) => statOf(keyOf(f.key, `${nameOf(p)}|${ex}`, period, scope));
        log(line(`${label} ${ex} all 2nd`, X("val", "all")));
        for (const tf of TFS) log(line(`${label} ${ex} ${tf} 2nd`, X("val", `tf:${tf}`)));
      }
    }
    log(`## the ten best on the first period, and how each did on the second`);
    for (const r of ranked.slice(0, 10)) {
      log(line(`${nameOf(r.p)} 1st`, r.disc));
      log(line(`${nameOf(r.p)} 2nd`, r.val));
    }
    // how often a setting's first-period rank carried to the second: the
    // rank correlation over every setting with enough trades
    const both = ranked.filter((r) => r.val && r.val.win !== null);
    if (both.length > 2) {
      const rankOf = (xs: number[]) => {
        const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
        const out = new Array(xs.length);
        idx.forEach(([, i], k) => (out[i] = k));
        return out as number[];
      };
      const a = rankOf(both.map((r) => r.disc!.win!));
      const b = rankOf(both.map((r) => r.val!.win!));
      const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
      const ma = mean(a), mb = mean(b);
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < a.length; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
      }
      log(`## first-period vs second-period win rate, rank correlation over ${both.length} settings: ${(num / Math.sqrt(da * db)).toFixed(2)}`);
    }
    (report.families as Record<string, unknown>)[f.key] = {
      exit: f.exit,
      current: { setting: f.current, disc: S(f.current, "disc"), val: S(f.current, "val") },
      chosen: best ? { setting: best.p, disc: best.disc, val: best.val } : null,
      ranked: ranked.map((r) => ({ setting: r.p, disc: r.disc, val: r.val })),
    };
  }
  await Deno.writeTextFile(`${OUT}/tune.json`, JSON.stringify(report));
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

if (import.meta.main) await main();
