// Which technical indicator times entries best? (#102)
//
// The request: 「今たくさんの過去のチャートを調べて、どのテクニカル指標が一番
// 売買のタイミングを決めるのに勝率が高いか調べて一つだけ」.
//
// THE METHOD
//
//   * History: GMO's 15-minute bid/ask since 2024-01, every pair GMO quotes
//     (eleven), read on 15min, 1h and 4h (the coarser two built from the
//     15-minute bars).
//   * Contestants: the textbook buy/sell rule of each common indicator
//     (indicator-series.ts RULES; standard parameters, none tuned).
//   * One exit for every contestant, the app's own: entry at the close of the
//     signal bar on the ask (BUY) or bid (SELL), stop 0.8 ATR, target 1.5
//     times the stop, 48 bars to resolve, settled on the other side of the
//     book. The exit is held fixed so that the only thing that differs
//     between contestants is WHEN they enter. A second, even exit (stop 1
//     ATR, target 1 ATR) is run as a check that the ranking is not an
//     artefact of the first.
//   * Hours: on 15min and 1h, signals priced 17:00-23:59 UTC are left out,
//     because the app no longer publishes them (#100). 4h keeps every hour.
//   * The yardstick: entering at EVERY eligible bar, on the same pair,
//     timeframe, side, period and UTC hour. An indicator's lift is its win
//     rate minus that of blind entries made in the same place at the same
//     time of day, so an indicator is not credited for firing in a
//     friendlier hour or a trending pair.
//   * THE RULE that makes the answer honest: the winner is chosen on the
//     first period (before SPLIT) only, and then judged, untouched, on the
//     second. Seventeen contestants guarantee that one looks best on any
//     history; only one that stays ahead on data it was not chosen on is an
//     answer.
//   * Placebos: five "indicators" that fire at random bars on a random side,
//     at a similar rate, go through the same pipeline. Their spread of lifts
//     is what luck alone produces here.
//   * Intervals are cluster-robust by calendar week, across all pairs and
//     timeframes at once: the same week on USD/JPY and EUR/JPY is not two
//     independent draws.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { atrSeriesOf, barOpenMs } from "../supabase/functions/analyze/state.ts";
import { HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, holm, labelAt, mid, normCdf, subStarts, type LabelSpec, type Side } from "./lib.ts";
import { RULES, signalsOf } from "./indicator-series.ts";
import { fetchPair } from "./gmo.ts";

const ALL_PAIRS = "USD/JPY,EUR/JPY,GBP/JPY,AUD/JPY,NZD/JPY,CAD/JPY,CHF/JPY,EUR/USD,GBP/USD,AUD/USD,NZD/USD";
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-07-01";
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const CACHE = "research/.cache";
const OUT = "research/out";
const SPECS: Record<string, LabelSpec> = {
  app: { stopAtr: 0.8, rr: 1.5, horizon: 48 },
  even: { stopAtr: 1, rr: 1, horizon: 48 },
};
const SPEC_NAMES = Object.keys(SPECS);
const SIDES: Side[] = ["BUY", "SELL"];
// Every contestant and the yardstick start on the same bar: late enough for
// the 200-bar average and every other series to exist.
const WARMUP = 210;
const PLACEBOS = 5;
const PLACEBO_RATE = 0.02;
const TFS = ["15min", "1h", "4h"] as const;
type Tf = (typeof TFS)[number];
const costly = (tf: Tf, hour: number) => tf !== "4h" && hour >= 17 && hour <= 23;

const log = (s = "") => console.log(s);
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(d)}%`);
const pts = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}`);

// ---- accumulation ------------------------------------------------------------

interface Acc {
  n: number;
  w: number;
  // the sum of the yardstick's win rate over the same trades
  b: number;
}
type Period = "disc" | "val";
const agg = new Map<string, Map<number, Acc>>();
const keyOf = (rule: string, spec: string, period: Period, scope: string) => `${rule}|${spec}|${period}|${scope}`;
const add = (key: string, week: number, win: boolean, base: number) => {
  let m = agg.get(key);
  if (!m) agg.set(key, (m = new Map()));
  const a = m.get(week) ?? { n: 0, w: 0, b: 0 };
  a.n++;
  if (win) a.w++;
  a.b += base;
  m.set(week, a);
};
// signals fired vs signals decided (the rest expired or were ambiguous)
const fired = new Map<string, { fired: number; decided: number }>();

interface Stat {
  n: number;
  p: number;
  base: number;
  lift: number;
  seP: number;
  seL: number;
  weeks: number;
}
const statOf = (key: string): Stat | null => {
  const m = agg.get(key);
  if (!m || m.size === 0) return null;
  let n = 0, w = 0, b = 0;
  for (const a of m.values()) {
    n += a.n;
    w += a.w;
    b += a.b;
  }
  if (n === 0) return null;
  const p = w / n;
  const base = b / n;
  const lift = p - base;
  const C = m.size;
  let sp = 0, sl = 0;
  for (const a of m.values()) {
    sp += (a.w - p * a.n) ** 2;
    sl += (a.w - a.b - lift * a.n) ** 2;
  }
  const f = C > 1 ? C / (C - 1) : Number.NaN;
  return { n, p, base, lift, seP: Math.sqrt(f * sp) / n, seL: Math.sqrt(f * sl) / n, weeks: C };
};

// ---- one timeframe of one pair ---------------------------------------------------

const rngOf = (seed: string) => {
  let s = [...seed].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 17);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const PLACEBO_IDS = Array.from({ length: PLACEBOS }, (_, k) => `placebo_${k + 1}`);
const ALL = "__every_bar__";

const study = (pair: string, tf: Tf, entry: QuoteCandle[], intervalMs: number, sub: QuoteCandle[] | null) => {
  const n = entry.length;
  const mids = entry.map(mid);
  const atr = atrSeriesOf(mids);
  const sig = signalsOf(mids);
  for (const id of PLACEBO_IDS) {
    const r = rngOf(`${pair}|${tf}|${id}`);
    const s = new Int8Array(n);
    for (let i = 0; i < n; i++) if (r() < PLACEBO_RATE) s[i] = r() < 0.5 ? 1 : -1;
    sig[id] = s;
  }
  const subIdx = sub ? { bars: sub, startOf: subStarts(entry, sub) } : null;

  const eligible = new Uint8Array(n);
  const hourOf = new Int8Array(n);
  const periodOf: Period[] = new Array(n);
  const weekOf = new Int32Array(n);
  // label[spec][side][t]: 1 win, 0 loss, -1 neither
  const label: Record<string, Record<Side, Int8Array>> = {};
  for (const sp of SPEC_NAMES) label[sp] = { BUY: new Int8Array(n).fill(-1), SELL: new Int8Array(n).fill(-1) };
  // the yardstick: [spec][period][side][hour] -> {n, w}
  const base: Record<string, { n: number; w: number }> = {};
  const baseKey = (sp: string, period: Period, side: Side, hour: number) => `${sp}|${period}|${side}|${hour}`;

  for (let t = WARMUP; t < n; t++) {
    const a = atr[t];
    if (a === null || !(a > 0)) continue;
    const decisionMs = barOpenMs(entry[t].datetime) + intervalMs;
    const hour = new Date(decisionMs).getUTCHours();
    if (costly(tf, hour)) continue;
    eligible[t] = 1;
    hourOf[t] = hour;
    const period: Period = decisionMs < SPLIT_MS ? "disc" : "val";
    periodOf[t] = period;
    weekOf[t] = Math.floor((decisionMs - WEEK_OFFSET) / WEEK);
    for (const sp of SPEC_NAMES) {
      for (const side of SIDES) {
        const l = labelAt(entry, t, a, side, SPECS[sp], intervalMs, subIdx);
        const v = l.outcome === "win" ? 1 : l.outcome === "loss" ? 0 : -1;
        label[sp][side][t] = v;
        if (v >= 0) {
          const k = baseKey(sp, period, side, hour);
          const c = base[k] ?? (base[k] = { n: 0, w: 0 });
          c.n++;
          c.w += v;
        }
      }
    }
  }
  const baseRate = (sp: string, period: Period, side: Side, hour: number) => {
    const c = base[baseKey(sp, period, side, hour)];
    return c && c.n > 0 ? c.w / c.n : null;
  };

  const record = (rule: string, sp: string, period: Period, side: Side, week: number, win: boolean, b: number) => {
    for (const scope of ["all", `tf:${tf}`, `pair:${pair}`, `side:${side}`]) add(keyOf(rule, sp, period, scope), week, win, b);
  };

  const ids = [...RULES.map((r) => r.id), ...PLACEBO_IDS];
  for (let t = WARMUP; t < n; t++) {
    if (!eligible[t]) continue;
    const period = periodOf[t];
    const week = weekOf[t];
    const hour = hourOf[t];
    for (const sp of SPEC_NAMES) {
      // the yardstick itself, entered at every bar on both sides
      for (const side of SIDES) {
        const v = label[sp][side][t];
        const b = baseRate(sp, period, side, hour);
        if (v >= 0 && b !== null) record(ALL, sp, period, side, week, v === 1, b);
      }
      for (const id of ids) {
        const s = sig[id][t];
        if (s === 0) continue;
        const side: Side = s > 0 ? "BUY" : "SELL";
        const fk = `${id}|${sp}|${period}`;
        const f = fired.get(fk) ?? { fired: 0, decided: 0 };
        f.fired++;
        const v = label[sp][side][t];
        const b = baseRate(sp, period, side, hour);
        if (v >= 0 && b !== null) {
          f.decided++;
          record(id, sp, period, side, week, v === 1, b);
        }
        fired.set(fk, f);
      }
    }
  }
};

// ---- the report ---------------------------------------------------------------------

const ci = (s: Stat | null, which: "p" | "lift") => {
  if (!s) return "n/a";
  const v = which === "p" ? s.p : s.lift;
  const se = which === "p" ? s.seP : s.seL;
  return which === "p" ? `${pct(v)} [${pct(v - 1.96 * se)}〜${pct(v + 1.96 * se)}]` : `${pts(v)} [${pts(v - 1.96 * se)}〜${pts(v + 1.96 * se)}]`;
};
// one-sided p that the lift is above zero
const pAbove = (s: Stat | null) => (s && s.seL > 0 ? 1 - normCdf(s.lift / s.seL) : null);
const expectancy = (p: number, rr: number) => p * rr - (1 - p);

const main = async () => {
  const t0 = Date.now();
  log(`# research/indicators.ts  pairs=${PAIRS.length} (${PAIRS.join(",")})  start=${START}  split=${SPLIT}`);
  log(`exits: ${Object.entries(SPECS).map(([k, s]) => `${k}=stop ${s.stopAtr}ATR target ${s.rr}x horizon ${s.horizon}`).join(" | ")}`);
  log(`rules: ${RULES.length} (+${PLACEBOS} placebos at ${pct(PLACEBO_RATE, 0)} of bars)  warmup ${WARMUP} bars  15min/1h exclude 17-23 UTC`);
  await Deno.mkdir(OUT, { recursive: true });
  const barsByPair: Record<string, { bars: number; from: string; to: string }> = {};

  for (const pair of PAIRS) {
    const t1 = Date.now();
    const { bars, requests, cached, failed } = await fetchPair(pair, { start: START, now: NOW, cache: CACHE, concurrency: 8 });
    log(`\n## ${pair}: ${bars.length} 15min bars ${bars[0]?.datetime ?? "-"} .. ${bars[bars.length - 1]?.datetime ?? "-"}  (requests ${requests}, cached ${cached}, failed ${failed}, ${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    if (bars.length < 5000) {
      log(`  skipped: too few bars`);
      continue;
    }
    barsByPair[pair] = { bars: bars.length, from: bars[0].datetime, to: bars[bars.length - 1].datetime };
    const h1 = aggregate(bars, HOUR, 0, NOW);
    const h4 = aggregate(bars, 4 * HOUR, 0, NOW);
    study(pair, "15min", bars, 15 * MINUTE, null);
    study(pair, "1h", h1, HOUR, bars);
    study(pair, "4h", h4, 4 * HOUR, bars);
    log(`  studied 15min ${bars.length} / 1h ${h1.length} / 4h ${h4.length} bars in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }

  const report: Record<string, unknown> = { pairs: barsByPair, start: START, split: SPLIT, specs: SPECS, generatedAt: new Date(NOW).toISOString() };

  for (const sp of SPEC_NAMES) {
    const rr = SPECS[sp].rr;
    const all = { disc: statOf(keyOf(ALL, sp, "disc", "all")), val: statOf(keyOf(ALL, sp, "val", "all")) };
    log(`\n# exit "${sp}" (break-even ${pct(1 / (1 + rr))})`);
    log(`every eligible bar (the yardstick): first period ${pct(all.disc?.p)} n=${all.disc?.n}  second ${pct(all.val?.p)} n=${all.val?.n}`);
    const rows = [...RULES.map((r) => ({ id: r.id, indicator: r.indicator, placebo: false })), ...PLACEBO_IDS.map((id) => ({ id, indicator: "placebo", placebo: true }))].map((r) => {
      const d = statOf(keyOf(r.id, sp, "disc", "all"));
      const v = statOf(keyOf(r.id, sp, "val", "all"));
      const fd = fired.get(`${r.id}|${sp}|disc`);
      const fv = fired.get(`${r.id}|${sp}|val`);
      return { ...r, disc: d, val: v, firedDisc: fd, firedVal: fv, pVal: pAbove(v) };
    });
    const real = rows.filter((r) => !r.placebo && r.disc && r.val);
    real.sort((a, b) => (b.disc!.lift) - (a.disc!.lift));
    // Holm over the second-period tests of every real rule, one-sided in the
    // direction the first period pointed
    const dirP = real.map((r) => {
      const v = r.val!;
      if (!(v.seL > 0)) return 1;
      const z = v.lift / v.seL;
      return 1 - normCdf(Math.sign(r.disc!.lift || 1) * z);
    });
    const adj = holm(dirP);
    log(`\nrank by the FIRST period's lift; the second period is the check (win rate [95%], lift = win rate minus blind entries at the same pair/timeframe/side/hour, in points)`);
    real.forEach((r, i) => {
      log(`${String(i + 1).padStart(2)}. ${r.id.padEnd(15)} ${r.indicator.padEnd(12)} | 1st n=${String(r.disc!.n).padStart(6)} win ${pct(r.disc!.p)} lift ${pts(r.disc!.lift)}±${(1.96 * r.disc!.seL * 100).toFixed(1)} | 2nd n=${String(r.val!.n).padStart(6)} win ${ci(r.val, "p")} lift ${ci(r.val, "lift")} p(dir)=${dirP[i].toExponential(1)} holm=${adj[i].toFixed(3)} | E ${expectancy(r.val!.p, rr).toFixed(3)}R | decided ${pct(r.firedVal ? r.firedVal.decided / r.firedVal.fired : null, 0)}`);
    });
    log(`placebos (random bars, random side): ${rows.filter((r) => r.placebo).map((r) => `${r.id} 1st ${pts(r.disc?.lift)} 2nd ${pts(r.val?.lift)} (n=${r.val?.n})`).join(" | ")}`);

    // does the ranking persist at all? Spearman between the two periods' lifts
    const rank = (xs: number[]) => {
      const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      const r = new Array(xs.length);
      idx.forEach(([, i], k) => (r[i] = k + 1));
      return r as number[];
    };
    const rd = rank(real.map((r) => r.disc!.lift));
    const rv = rank(real.map((r) => r.val!.lift));
    const m = real.length;
    const rho = 1 - (6 * rd.reduce((s, x, i) => s + (x - rv[i]) ** 2, 0)) / (m * (m * m - 1));
    log(`rank correlation of lift, first vs second period, over ${m} rules: ${rho.toFixed(2)}`);

    const byVal = [...real].sort((a, b) => b.val!.lift - a.val!.lift).slice(0, 3);
    log(`top by the SECOND period alone (descriptive; chosen after seeing it): ${byVal.map((r) => `${r.id} ${pts(r.val!.lift)} win ${pct(r.val!.p)}`).join(" | ")}`);

    // per timeframe: the first period's leader and how it did afterwards
    for (const tf of TFS) {
      const tfRows = RULES.map((r) => ({ id: r.id, d: statOf(keyOf(r.id, sp, "disc", `tf:${tf}`)), v: statOf(keyOf(r.id, sp, "val", `tf:${tf}`)) })).filter((r) => r.d && r.v);
      tfRows.sort((a, b) => b.d!.lift - a.d!.lift);
      const lead = tfRows[0];
      const y = { d: statOf(keyOf(ALL, sp, "disc", `tf:${tf}`)), v: statOf(keyOf(ALL, sp, "val", `tf:${tf}`)) };
      log(`  ${tf}: yardstick 1st ${pct(y.d?.p)} 2nd ${pct(y.v?.p)} | leader ${lead?.id} 1st ${pts(lead?.d?.lift)} -> 2nd win ${ci(lead?.v ?? null, "p")} lift ${ci(lead?.v ?? null, "lift")} | top3 1st: ${tfRows.slice(0, 3).map((r) => r.id).join(", ")}`);
    }

    // the winner, examined
    const win = real[0];
    if (win) {
      log(`\nWINNER on the first period: ${win.id} (${win.indicator})`);
      log(`  second period: win ${ci(win.val, "p")} vs blind ${pct(win.val!.base)} lift ${ci(win.val, "lift")} one-sided p ${pAbove(win.val)?.toExponential(2)} weeks ${win.val!.weeks} E ${expectancy(win.val!.p, rr).toFixed(3)}R`);
      for (const tf of TFS) {
        const v = statOf(keyOf(win.id, sp, "val", `tf:${tf}`));
        log(`    ${tf}: n=${v?.n} win ${ci(v, "p")} lift ${ci(v, "lift")}`);
      }
      for (const side of SIDES) {
        const v = statOf(keyOf(win.id, sp, "val", `side:${side}`));
        log(`    ${side}: n=${v?.n} win ${ci(v, "p")} lift ${ci(v, "lift")}`);
      }
      let up = 0, total = 0;
      const perPair: string[] = [];
      for (const pair of Object.keys(barsByPair)) {
        const v = statOf(keyOf(win.id, sp, "val", `pair:${pair}`));
        if (!v) continue;
        total++;
        if (v.lift > 0) up++;
        perPair.push(`${pair} ${pts(v.lift)} (n=${v.n})`);
      }
      log(`    pairs with a positive lift in the second period: ${up}/${total}  ${perPair.join(" | ")}`);
    }

    // one best rule per indicator, by the first period
    const byIndicator = new Map<string, (typeof real)[number]>();
    for (const r of real) if (!byIndicator.has(r.indicator)) byIndicator.set(r.indicator, r);
    log(`best rule of each indicator (first period) -> second period lift: ${[...byIndicator.values()].map((r) => `${r.indicator}:${r.id} ${pts(r.disc!.lift)} -> ${pts(r.val!.lift)}`).join(" | ")}`);

    report[sp] = {
      yardstick: all,
      ranking: real.map((r, i) => ({ id: r.id, indicator: r.indicator, disc: r.disc, val: r.val, pDir: dirP[i], holm: adj[i], firedDisc: r.firedDisc, firedVal: r.firedVal })),
      placebos: rows.filter((r) => r.placebo).map((r) => ({ id: r.id, disc: r.disc, val: r.val })),
      rho,
      winner: win?.id ?? null,
      winnerByTf: Object.fromEntries(TFS.map((tf) => [tf, statOf(keyOf(win?.id ?? "", sp, "val", `tf:${tf}`))])),
      winnerByPair: Object.fromEntries(Object.keys(barsByPair).map((pair) => [pair, statOf(keyOf(win?.id ?? "", sp, "val", `pair:${pair}`))])),
    };
  }

  await Deno.writeTextFile(`${OUT}/indicators.json`, JSON.stringify(report));
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

await main();
