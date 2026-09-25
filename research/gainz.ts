// Does "a big move, then a reversal candle, target twice the stop" pay on
// past charts? And does the app's RSI + SAR rule do better with a target at
// twice the stop? (#106)
//
// The request, after a GainzAlgo V2 Alpha video (gold, 15min, every label
// with a target exactly twice its stop): 「タイミングをどうやって決めてると
// 思う？」 then 「やってみて」.
//
// THE METHOD — the footing of #102/#103, fixed before any data was read:
//
//   * History: GMO's 15-minute bid/ask since 2024-01, all eleven FX pairs,
//     read on 15min, 1h and 4h. (The video is gold; GMO serves no gold, so
//     this is the same timing on currencies.)
//   * Rules: the three readings of the video in reversal.ts, and the app's
//     RSI + SAR rule.
//   * Exits, each priced on the side of the book it fills on, spread paid:
//       app — stop 0.8 ATR, target 1.5x (the app today; break-even 40%)
//       r2  — stop 0.8 ATR, target 2x (the app's stop, the video's ratio)
//       r2w — stop 1.0 ATR, target 2x (the video's ratio with a wider stop)
//     Every exit gives up after 48 bars and closes at the market there.
//   * The measure is EXPECTANCY in R (R = the stop distance): a win earns the
//     target multiple, a loss -1, a trade still open at 48 bars what it was
//     worth then. Above zero makes money after the spread; the win rate is
//     reported beside it with the break-even rate for its ratio.
//   * Yardstick: blind entries at every bar of the same pair, timeframe,
//     side and UTC hour with the same exit. "Lift" is the rule's expectancy
//     minus that — what the timing adds over entering at random.
//   * Hours: 15min and 1h leave out 17:00-23:59 UTC, as the app does.
//   * THE RULE: the reversal reading is chosen on the FIRST period (before
//     SPLIT), on 15min with the r2w exit (the video's chart and ratio), and
//     judged untouched on the second. Nothing is chosen for RSI + SAR: its
//     three exits are simply reported.
//   * Intervals are cluster-robust by calendar week.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, mid, subStarts, type LabelSpec, type Side } from "./lib.ts";
import { REVERSALS, revCtxOf, rsiSarAt, tradeR, type RevCtx } from "./reversal.ts";
import { fetchPair } from "./gmo.ts";

const ALL_PAIRS = "USD/JPY,EUR/JPY,GBP/JPY,AUD/JPY,NZD/JPY,CAD/JPY,CHF/JPY,EUR/USD,GBP/USD,AUD/USD,NZD/USD";
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-07-01";
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const CACHE = "research/.cache";
const OUT = "research/out";

export const EXITS: Record<string, LabelSpec> = {
  app: { stopAtr: 0.8, rr: 1.5, horizon: 48 },
  r2: { stopAtr: 0.8, rr: 2, horizon: 48 },
  r2w: { stopAtr: 1.0, rr: 2, horizon: 48 },
};
const EXIT_NAMES = Object.keys(EXITS);
const PRIMARY_EXIT = "r2w";
const PRIMARY_TF = "15min";
const SIDES: Side[] = ["BUY", "SELL"];
const WARMUP = 210;
const TFS = ["15min", "1h", "4h"] as const;
type Tf = (typeof TFS)[number];
const costly = (tf: Tf, hour: number) => tf !== "4h" && hour >= 17 && hour <= 23;

const RULES: Array<{ id: string; ja: string; at: (x: RevCtx, i: number) => 0 | 1 | -1 }> = [
  ...REVERSALS,
  { id: "rsi_sar", ja: "RSI(14) が30/70から戻し、SAR が同じ側（アプリの今のルール）", at: rsiSarAt },
];
const BLIND = "__blind__";

const log = (s = "") => console.log(s);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const rr = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}R`);

// ---- accumulation ------------------------------------------------------------

interface Acc {
  n: number;
  r: number;
  base: number;
  res: number;
  w: number;
  exp: number;
}
type Period = "disc" | "val";
const agg = new Map<string, Map<number, Acc>>();
const keyOf = (rule: string, exit: string, period: Period, scope: string) => `${rule}|${exit}|${period}|${scope}`;
const add = (key: string, week: number, r: number, base: number, outcome: string) => {
  let m = agg.get(key);
  if (!m) agg.set(key, (m = new Map()));
  const a = m.get(week) ?? { n: 0, r: 0, base: 0, res: 0, w: 0, exp: 0 };
  a.n++;
  a.r += r;
  a.base += base;
  if (outcome === "expired") a.exp++;
  else {
    a.res++;
    if (outcome === "win") a.w++;
  }
  m.set(week, a);
};

interface Stat {
  n: number;
  e: number;
  seE: number;
  base: number;
  lift: number;
  seL: number;
  win: number | null;
  seW: number | null;
  expired: number;
  weeks: number;
}
const statOf = (key: string): Stat | null => {
  const m = agg.get(key);
  if (!m || m.size === 0) return null;
  let n = 0, r = 0, b = 0, res = 0, w = 0, exp = 0;
  for (const a of m.values()) {
    n += a.n;
    r += a.r;
    b += a.base;
    res += a.res;
    w += a.w;
    exp += a.exp;
  }
  if (n === 0) return null;
  const e = r / n;
  const base = b / n;
  const lift = e - base;
  const win = res > 0 ? w / res : null;
  const C = m.size;
  let se = 0, sl = 0, sw = 0;
  for (const a of m.values()) {
    se += (a.r - e * a.n) ** 2;
    sl += (a.r - a.base - lift * a.n) ** 2;
    if (win !== null) sw += (a.w - win * a.res) ** 2;
  }
  const f = C > 1 ? C / (C - 1) : Number.NaN;
  return {
    n,
    e,
    seE: Math.sqrt(f * se) / n,
    base,
    lift,
    seL: Math.sqrt(f * sl) / n,
    win,
    seW: win === null || res === 0 ? null : Math.sqrt(f * sw) / res,
    expired: exp / n,
    weeks: C,
  };
};

// ---- one timeframe of one pair -------------------------------------------------

const study = (pair: string, tf: Tf, entry: QuoteCandle[], intervalMs: number, sub: QuoteCandle[] | null) => {
  const n = entry.length;
  const x = revCtxOf(entry.map(mid));
  const subIdx = sub ? { bars: sub, startOf: subStarts(entry, sub) } : null;

  const eligible = new Uint8Array(n);
  const hourOf = new Int8Array(n);
  const periodOf: Period[] = new Array(n);
  const weekOf = new Int32Array(n);
  // R of a trade opened at each bar, per exit and side; NaN where it cannot
  // be known (the trade is still open at the end of the history)
  const R: Record<string, Record<Side, Float64Array>> = {};
  const O: Record<string, Record<Side, Array<string | null>>> = {};
  for (const ex of EXIT_NAMES) {
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
    for (const ex of EXIT_NAMES) {
      for (const side of SIDES) {
        const tr = tradeR(entry, t, a, side, EXITS[ex], intervalMs, subIdx);
        if (!tr) continue;
        R[ex][side][t] = tr.r;
        O[ex][side][t] = tr.outcome;
        const k = baseKey(ex, period, side, hour);
        const c = base[k] ?? (base[k] = { n: 0, r: 0 });
        c.n++;
        c.r += tr.r;
      }
    }
  }
  const baseAt = (ex: string, period: Period, side: Side, hour: number) => {
    const c = base[baseKey(ex, period, side, hour)];
    return c && c.n > 0 ? c.r / c.n : null;
  };

  let fired = 0;
  for (let t = WARMUP; t < n; t++) {
    if (!eligible[t]) continue;
    const period = periodOf[t];
    const week = weekOf[t];
    const hour = hourOf[t];
    // which rules fire here — decided before any outcome is read
    const hits: Array<{ id: string; side: Side }> = [];
    for (const rule of RULES) {
      const d = rule.at(x, t);
      if (d !== 0) hits.push({ id: rule.id, side: d === 1 ? "BUY" : "SELL" });
    }
    fired += hits.length;
    for (const ex of EXIT_NAMES) {
      for (const side of SIDES) {
        const r = R[ex][side][t];
        const b = baseAt(ex, period, side, hour);
        if (!Number.isNaN(r) && b !== null) {
          for (const scope of ["all", `tf:${tf}`]) add(keyOf(BLIND, ex, period, scope), week, r, b, O[ex][side][t]!);
        }
      }
      for (const h of hits) {
        const r = R[ex][h.side][t];
        const b = baseAt(ex, period, h.side, hour);
        if (Number.isNaN(r) || b === null) continue;
        for (const scope of ["all", `tf:${tf}`, `side:${h.side}`, `pair:${pair}`, `tfside:${tf}:${h.side}`]) {
          add(keyOf(h.id, ex, period, scope), week, r, b, O[ex][h.side][t]!);
        }
      }
    }
  }
  return fired;
};

// ---- the report --------------------------------------------------------------------

const ci = (x: number, se: number, f: (v: number) => string) => `${f(x)} [${f(x - 1.96 * se)}〜${f(x + 1.96 * se)}]`;
const eStr = (s: Stat | null) => (s ? ci(s.e, s.seE, (v) => rr(v)) : "n/a");
const lStr = (s: Stat | null) => (s ? ci(s.lift, s.seL, (v) => rr(v)) : "n/a");
const wStr = (s: Stat | null) => (s && s.win !== null && s.seW !== null ? ci(s.win, s.seW, (v) => pct(v)) : "n/a");
const line = (label: string, s: Stat | null) =>
  `${label.padEnd(26)} n=${String(s?.n ?? 0).padStart(6)} win ${wStr(s)} expired ${pct(s?.expired, 0)} | E ${eStr(s)} | blind ${rr(s?.base)} lift ${lStr(s)}`;

const main = async () => {
  const t0 = Date.now();
  log(`# research/gainz.ts  pairs=${PAIRS.length} (${PAIRS.join(",")})  start=${START}  split=${SPLIT}`);
  log(`exits: ${Object.entries(EXITS).map(([k, s]) => `${k}=stop ${s.stopAtr}ATR target ${s.rr}x (break-even win ${pct(1 / (1 + s.rr))}) horizon ${s.horizon}`).join(" | ")}`);
  log(`rules: ${RULES.map((r) => r.id).join(", ")}  primary: ${PRIMARY_TF} / ${PRIMARY_EXIT}, reversal reading chosen on the first period`);
  await Deno.mkdir(OUT, { recursive: true });
  const barsByPair: Record<string, number> = {};

  for (const pair of PAIRS) {
    const t1 = Date.now();
    const { bars, requests, cached, failed } = await fetchPair(pair, { start: START, now: NOW, cache: CACHE, concurrency: 8 });
    log(`## ${pair}: ${bars.length} 15min bars ${bars[0]?.datetime ?? "-"} .. ${bars[bars.length - 1]?.datetime ?? "-"}  (requests ${requests}, cached ${cached}, failed ${failed})`);
    if (bars.length < 5000) continue;
    barsByPair[pair] = bars.length;
    const h1 = aggregate(bars, HOUR, 0, NOW);
    const h4 = aggregate(bars, 4 * HOUR, 0, NOW);
    const f15 = study(pair, "15min", bars, 15 * MINUTE, null);
    const f1 = study(pair, "1h", h1, HOUR, bars);
    const f4 = study(pair, "4h", h4, 4 * HOUR, bars);
    log(`   signals 15min ${f15} / 1h ${f1} / 4h ${f4}  studied in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }

  const report: Record<string, unknown> = { pairs: barsByPair, start: START, split: SPLIT, exits: EXITS, generatedAt: new Date(NOW).toISOString() };
  const S = (rule: string, ex: string, period: Period, scope: string) => statOf(keyOf(rule, ex, period, scope));

  // 1. the reading of the video, chosen on the first period
  const ranked = REVERSALS
    .map((r) => ({ id: r.id, ja: r.ja, disc: S(r.id, PRIMARY_EXIT, "disc", `tf:${PRIMARY_TF}`), val: S(r.id, PRIMARY_EXIT, "val", `tf:${PRIMARY_TF}`) }))
    .filter((r) => r.disc && r.disc.n > 0)
    .sort((a, b) => b.disc!.lift - a.disc!.lift);
  const winner = ranked[0]?.id ?? null;
  log(`\n# 1. "A big move, then a reversal candle" — ${PRIMARY_TF}, exit ${PRIMARY_EXIT}, ranked by the FIRST period's lift over blind entries`);
  for (const r of ranked) {
    log(line(`${r.id} 1st`, r.disc));
    log(line(`${r.id} 2nd`, r.val));
  }
  log(`WINNER (first period): ${winner}`);

  // 2. every rule, every exit, every timeframe, both periods (descriptive)
  for (const ex of EXIT_NAMES) {
    log(`\n# exit "${ex}" — stop ${EXITS[ex].stopAtr} ATR, target ${EXITS[ex].rr}x, break-even win ${pct(1 / (1 + EXITS[ex].rr))}`);
    for (const period of ["disc", "val"] as Period[]) {
      log(`## ${period === "disc" ? "first period (before " + SPLIT + ")" : "second period (" + SPLIT + " on)"}`);
      log(line("blind, all", S(BLIND, ex, period, "all")));
      for (const tf of TFS) log(line(`blind, ${tf}`, S(BLIND, ex, period, `tf:${tf}`)));
      for (const rule of RULES) {
        log(line(`${rule.id}, all`, S(rule.id, ex, period, "all")));
        for (const tf of TFS) log(line(`${rule.id}, ${tf}`, S(rule.id, ex, period, `tf:${tf}`)));
      }
    }
  }

  // 3. the two answers, on the second period only
  log(`\n# ANSWERS (second period, ${SPLIT} on — nothing below was chosen on it)`);
  if (winner) {
    for (const ex of EXIT_NAMES) {
      log(line(`${winner} ${PRIMARY_TF} ${ex}`, S(winner, ex, "val", `tf:${PRIMARY_TF}`)));
    }
    for (const side of SIDES) log(line(`${winner} ${PRIMARY_TF} ${PRIMARY_EXIT} ${side}`, S(winner, PRIMARY_EXIT, "val", `tfside:${PRIMARY_TF}:${side}`)));
    let up = 0, total = 0;
    const per: string[] = [];
    for (const pair of Object.keys(barsByPair)) {
      const s = S(winner, PRIMARY_EXIT, "val", `pair:${pair}`);
      if (!s) continue;
      total++;
      if (s.e > 0) up++;
      per.push(`${pair} ${rr(s.e, 2)} (n=${s.n})`);
    }
    log(`   pairs with positive expectancy (all timeframes, ${PRIMARY_EXIT}): ${up}/${total}  ${per.join(" | ")}`);
  }
  for (const tf of TFS) {
    for (const ex of EXIT_NAMES) log(line(`rsi_sar ${tf} ${ex}`, S("rsi_sar", ex, "val", `tf:${tf}`)));
  }
  for (const ex of EXIT_NAMES) log(line(`rsi_sar all ${ex}`, S("rsi_sar", ex, "val", "all")));

  const dump: Record<string, unknown> = {};
  for (const rule of [...RULES.map((r) => r.id), BLIND]) {
    for (const ex of EXIT_NAMES) {
      for (const period of ["disc", "val"] as Period[]) {
        for (const scope of ["all", ...TFS.map((t) => `tf:${t}`), ...SIDES.map((s) => `side:${s}`)]) {
          const s = S(rule, ex, period, scope);
          if (s) dump[keyOf(rule, ex, period, scope)] = s;
        }
      }
    }
  }
  report.winner = winner;
  report.stats = dump;
  await Deno.writeTextFile(`${OUT}/gainz.json`, JSON.stringify(report));
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

if (import.meta.main) await main();
