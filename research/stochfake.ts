// #134: can a stochastic signal be told apart from a false one (ダマシ) when it
// fires? The owner, on a 4h chart where %K kept dipping under 80 while the
// price climbed: 「ストキャスが騙しかどうかを判断するためのインジケーター考えて」
//
// THE DESIGN, fixed before any data was read:
//
//   * The signal: the chart's stochastic as the app draws it
//     (src/lib/stochastic.ts, 14·1·3, lines 80/20). A SELL on the bar where
//     %K falls under 80 from at or over it; a BUY where it rises over 20
//     from at or under it.
//   * A false signal is one that loses: the exit is fixed, stop 1 ATR(14),
//     target 2x (r2w, break-even 33.3%), 48 bars at most.
//   * Three warnings, each one reason a stochastic signal fails, read on the
//     signal bar's close (nothing after it):
//       adx    — a strong trend against it: ADX(14) at or over 25 with the
//                DI of the other side on top (+DI over −DI for a SELL);
//       htf    — the timeframe above against it: the app's Dow theory
//                (supabase/functions/_shared/dow.ts) on the next timeframe
//                up (15min→1h, 1h→4h, 4h→day) in a trend the other way;
//       pinned — %K stuck in its zone: at or over 80 (a SELL; at or under 20
//                for a BUY) on 10 or more of the 14 bars before.
//   * The judges: each warning alone (a signal passes without it), "clear"
//     (no warning at all), "majority" (fewer than two warnings), and
//     "confirm" — the textbook wait: pass when, within 5 bars, a close goes
//     beyond the signal bar's low (a SELL; its high for a BUY), and enter at
//     that close.
//   * THE CHOICE: the judge whose passed signals won most often on the FIRST
//     period (before SPLIT), all three timeframes together, among those that
//     passed at least MIN_TRADES there. It WORKS only if, on the SECOND
//     period, its passed signals won more often than its rejected ones with
//     the difference's 95% interval above zero. Every judge is reported,
//     on both periods, passed and rejected, and passed against all signals.
//   * "confirm" has no rejected group to compare: which signals are never
//     confirmed is only known after them, and on the signal bar they are the
//     ones the price then went against — a synthetic random walk showed
//     them winning 2% (research/gmo.ts SYNTHETIC), a look-ahead, not a
//     judgement. Its passed trades are judged against every signal entered
//     on its own bar instead. (Changed after that synthetic run, before any
//     real data was read.)
//   * The same footing as research/tune.ts: GMO's 15-minute bid/ask since
//     2024-01, eleven pairs, read on 15min, 1h and 4h; entries at the close
//     on the side of the book they fill on, spread paid; 15min and 1h leave
//     out 17:00-23:59 UTC; blind entries at every bar of the same pair,
//     timeframe, side and UTC hour as the yardstick; intervals clustered by
//     calendar week.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { DAY, DAY_OFFSET, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, mid, subStarts, type LabelSpec, type Side } from "./lib.ts";
import { revCtxOf, tradeR } from "./reversal.ts";
import { fetchPair } from "./gmo.ts";
import { dowTheory } from "../supabase/functions/_shared/dow.ts";
import { STOCH_DEFAULTS, STOCH_LEVELS, stochastic } from "../src/lib/stochastic.ts";

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
const EXIT: LabelSpec = { stopAtr: 1.0, rr: 2, horizon: 48 };

// the warnings' numbers, fixed above
const ADX_STRONG = 25;
const PIN_BARS = 14;
const PIN_MIN = 10;
const CONFIRM_BARS = 5;

type Judge = "all" | "adx" | "htf" | "pinned" | "clear" | "majority" | "confirm";
const JUDGES: Array<{ key: Judge; ja: string }> = [
  { key: "all", ja: "判定なし（ストキャスのサインすべて）" },
  { key: "adx", ja: "ADX(14)≥25 で逆向きの DI が上なら ダマシ" },
  { key: "htf", ja: "1つ上の時間足のダウ理論が逆向きのトレンドなら ダマシ" },
  { key: "pinned", ja: "直前14本のうち10本以上 %K が80以上（買いは20以下）に張り付いていたら ダマシ" },
  { key: "clear", ja: "3つの警告が1つも無いものだけ本物" },
  { key: "majority", ja: "3つの警告のうち2つ以上なら ダマシ" },
  { key: "confirm", ja: "5本以内に終値がサインの足の安値（買いは高値）を抜けたら本物、その足で入る" },
];

// ---- accumulation ----------------------------------------------------------------------

type Period = "disc" | "val";
type Group = "pass" | "reject";
interface Acc {
  n: number;
  r: number;
  base: number;
  res: number;
  w: number;
}
const agg = new Map<string, Map<number, Acc>>();
const keyOf = (judge: Judge, group: Group, period: Period, scope: string) => `${judge}|${group}|${period}|${scope}`;
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
// one group's win rate minus another's (a judge's passed against its
// rejected, or against every signal), its standard error clustered by week
// (the delta method on the two ratios; a week's trades in both groups are
// counted together, so overlapping groups are handled)
const diffOf = (judge: Judge, period: Period, scope = "all", against: "reject" | "all" = judge === "confirm" ? "all" : "reject"): { d: number; se: number } | null => {
  const p = agg.get(keyOf(judge, "pass", period, scope));
  const q = agg.get(against === "all" ? keyOf("all", "pass", period, scope) : keyOf(judge, "reject", period, scope));
  if (!p || !q) return null;
  const sum = (m: Map<number, Acc>) => [...m.values()].reduce((s, a) => ({ w: s.w + a.w, res: s.res + a.res }), { w: 0, res: 0 });
  const P = sum(p), Q = sum(q);
  if (P.res === 0 || Q.res === 0) return null;
  const wp = P.w / P.res, wq = Q.w / Q.res;
  const weeks = new Set([...p.keys(), ...q.keys()]);
  let s = 0;
  for (const k of weeks) {
    const a = p.get(k), b = q.get(k);
    const u = (a ? a.w - wp * a.res : 0) / P.res - (b ? b.w - wq * b.res : 0) / Q.res;
    s += u * u;
  }
  const C = weeks.size;
  return { d: wp - wq, se: C > 1 ? Math.sqrt((C / (C - 1)) * s) : Number.NaN };
};

// ---- the timeframe above: its Dow trend on its last bar closed by each close ------

const htfTrendOf = (entry: QuoteCandle[], intervalMs: number, higher: QuoteCandle[], higherMs: number): Int8Array => {
  const states = dowTheory(higher.map(mid)).states;
  const out = new Int8Array(entry.length);
  let j = -1;
  for (let t = 0; t < entry.length; t++) {
    const closeMs = barOpenMs(entry[t].datetime) + intervalMs;
    while (j + 1 < higher.length && barOpenMs(higher[j + 1].datetime) + higherMs <= closeMs) j++;
    out[t] = j < 0 ? 0 : states[j] === "up" ? 1 : states[j] === "down" ? -1 : 0;
  }
  return out;
};

// ---- one timeframe of one pair -----------------------------------------------------------

const warnCount = { adx: 0, htf: 0, pinned: 0, signals: 0 };

const study = (tf: Tf, entry: QuoteCandle[], intervalMs: number, higher: QuoteCandle[], higherMs: number, sub: QuoteCandle[] | null) => {
  const n = entry.length;
  const x = revCtxOf(entry.map(mid));
  const subIdx = sub ? { bars: sub, startOf: subStarts(entry, sub) } : null;
  const htf = htfTrendOf(entry, intervalMs, higher, higherMs);
  const k = stochastic(x.c, STOCH_DEFAULTS).k;
  const { upper, lower } = STOCH_LEVELS;
  const { adx, plus, minus } = x.b.dmi;

  const eligible = new Uint8Array(n);
  const hourOf = new Int8Array(n);
  const periodOf: Period[] = new Array(n);
  const weekOf = new Int32Array(n);
  const R: Record<Side, Float64Array> = { BUY: new Float64Array(n).fill(Number.NaN), SELL: new Float64Array(n).fill(Number.NaN) };
  const O: Record<Side, Array<string | null>> = { BUY: new Array(n).fill(null), SELL: new Array(n).fill(null) };
  const base: Record<string, { n: number; r: number }> = {};
  const baseKey = (period: Period, side: Side, hour: number) => `${period}|${side}|${hour}`;
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
    for (const side of ["BUY", "SELL"] as Side[]) {
      const tr = tradeR(entry, t, a, side, EXIT, intervalMs, subIdx);
      if (!tr) continue;
      R[side][t] = tr.r;
      O[side][t] = tr.outcome;
      const c = base[baseKey(period, side, hour)] ?? (base[baseKey(period, side, hour)] = { n: 0, r: 0 });
      c.n++;
      c.r += tr.r;
    }
  }
  const baseAt = (period: Period, side: Side, hour: number) => {
    const c = base[baseKey(period, side, hour)];
    return c && c.n > 0 ? c.r / c.n : null;
  };
  // a trade at bar t into one judge's group
  const record = (judge: Judge, group: Group, t: number, side: Side) => {
    if (!eligible[t]) return;
    const r = R[side][t];
    const b = baseAt(periodOf[t], side, hourOf[t]);
    if (Number.isNaN(r) || b === null) return;
    for (const scope of ["all", `tf:${tf}`]) add(keyOf(judge, group, periodOf[t], scope), weekOf[t], r, b, O[side][t]!);
  };

  const confirmed = new Set<string>();
  for (let t = Math.max(WARMUP, PIN_BARS); t < n; t++) {
    const a = k[t - 1], b = k[t];
    if (a === null || b === null) continue;
    const sell = a >= upper && b < upper;
    const buy = a <= lower && b > lower;
    if (!sell && !buy) continue;
    const side: Side = sell ? "SELL" : "BUY";
    const A = adx[t], P = plus[t], M = minus[t];
    const wAdx = A !== null && P !== null && M !== null && A >= ADX_STRONG && (sell ? P > M : M > P);
    const wHtf = htf[t] === (sell ? 1 : -1);
    let pinned = 0;
    for (let j = t - PIN_BARS; j < t; j++) {
      const v = k[j];
      if (v !== null && (sell ? v >= upper : v <= lower)) pinned++;
    }
    const wPin = pinned >= PIN_MIN;
    const warnings = Number(wAdx) + Number(wHtf) + Number(wPin);
    if (eligible[t]) {
      warnCount.signals++;
      warnCount.adx += Number(wAdx);
      warnCount.htf += Number(wHtf);
      warnCount.pinned += Number(wPin);
    }
    const pass: Record<Exclude<Judge, "confirm">, boolean> = {
      all: true,
      adx: !wAdx,
      htf: !wHtf,
      pinned: !wPin,
      clear: warnings === 0,
      majority: warnings < 2,
    };
    for (const [judge, ok] of Object.entries(pass) as Array<[Exclude<Judge, "confirm">, boolean]>) record(judge, ok ? "pass" : "reject", t, side);
    // the wait: entered at the first close beyond the signal bar's extreme
    // (no rejected group: see the top)
    let u = -1;
    for (let j = t + 1; j <= Math.min(n - 1, t + CONFIRM_BARS); j++) {
      if (sell ? x.c[j].close < x.c[t].low : x.c[j].close > x.c[t].high) {
        u = j;
        break;
      }
    }
    if (u >= 0 && !confirmed.has(`${u}|${side}`)) {
      confirmed.add(`${u}|${side}`);
      record("confirm", "pass", u, side);
    }
  }
};

// ---- the report -------------------------------------------------------------------------

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;
const rr = (x: number | null | undefined, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}R`);
const ci = (x: number, se: number, f: (v: number) => string) => `${f(x)} [${f(x - 1.96 * se)}〜${f(x + 1.96 * se)}]`;
const line = (label: string, s: Stat | null) =>
  `${label.padEnd(30)} n=${String(s?.n ?? 0).padStart(6)} (settled ${String(s?.res ?? 0).padStart(6)}) win ${s && s.win !== null && s.seW !== null ? ci(s.win, s.seW, (v) => pct(v)) : "n/a"} | E ${s ? ci(s.e, s.seE, (v) => rr(v)) : "n/a"} | lift ${s ? ci(s.lift, s.seL, (v) => rr(v)) : "n/a"}`;
const diffLine = (label: string, d: { d: number; se: number } | null, against = "rejected") =>
  `${label.padEnd(30)} passed − ${against} win rate ${d ? ci(d.d, d.se, pp) : "n/a"}`;
const log = (s = "") => console.log(s);

const main = async () => {
  const t0 = Date.now();
  log(`# research/stochfake.ts  pairs=${PAIRS.length}  start=${START}  split=${SPLIT}  min passed (first period)=${MIN_TRADES}`);
  log(`signal: stochastic ${STOCH_DEFAULTS.kLength}·${STOCH_DEFAULTS.kSmoothing}·${STOCH_DEFAULTS.dSmoothing}, ${STOCH_LEVELS.upper}/${STOCH_LEVELS.lower}; exit stop ${EXIT.stopAtr} ATR, target ${EXIT.rr}x (break-even ${pct(1 / (1 + EXIT.rr))})`);
  for (const j of JUDGES) log(`  ${j.key.padEnd(9)} ${j.ja}`);
  await Deno.mkdir(OUT, { recursive: true });
  for (const pair of PAIRS) {
    const t1 = Date.now();
    const { bars } = await fetchPair(pair, { start: START, now: NOW, cache: CACHE, concurrency: 8 });
    if (bars.length < 5000) {
      log(`## ${pair}: ${bars.length} bars, skipped`);
      continue;
    }
    const h1 = aggregate(bars, HOUR, 0, NOW);
    const h4 = aggregate(bars, 4 * HOUR, 0, NOW);
    const d1 = aggregate(bars, DAY, DAY_OFFSET, NOW);
    study("15min", bars, 15 * MINUTE, h1, HOUR, null);
    study("1h", h1, HOUR, h4, 4 * HOUR, bars);
    study("4h", h4, 4 * HOUR, d1, DAY, bars);
    log(`## ${pair}: ${bars.length} 15min bars ${bars[0].datetime} .. ${bars[bars.length - 1].datetime}, studied in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  }
  log(`\n## warnings on the ${warnCount.signals} signals (both periods): adx ${pct(warnCount.adx / warnCount.signals)}, htf ${pct(warnCount.htf / warnCount.signals)}, pinned ${pct(warnCount.pinned / warnCount.signals)}`);

  const S = (j: Judge, g: Group, period: Period, scope = "all") => statOf(keyOf(j, g, period, scope));
  log(`\n# every judge, passed and rejected, both periods (all timeframes)`);
  for (const j of JUDGES) {
    log(`## ${j.key}: ${j.ja}`);
    for (const period of ["disc", "val"] as Period[]) {
      const label = period === "disc" ? "1st" : "2nd";
      log(line(`${j.key} pass ${label}`, S(j.key, "pass", period)));
      if (j.key === "all") continue;
      if (j.key !== "confirm") {
        log(line(`${j.key} reject ${label}`, S(j.key, "reject", period)));
        log(diffLine(`${j.key} ${label}`, diffOf(j.key, period)));
      }
      log(diffLine(`${j.key} ${label}`, diffOf(j.key, period, "all", "all"), "all signals"));
    }
  }

  const ranked = JUDGES.filter((j) => j.key !== "all")
    .map((j) => ({ j, disc: S(j.key, "pass", "disc") }))
    .filter((r) => r.disc && r.disc.n >= MIN_TRADES && r.disc.win !== null)
    .sort((a, b) => b.disc!.win! - a.disc!.win! || b.disc!.n - a.disc!.n);
  const best = ranked[0] ?? null;
  const report: Record<string, unknown> = { start: START, split: SPLIT, generatedAt: new Date(NOW).toISOString(), warnings: warnCount, judges: {} };
  for (const j of JUDGES) {
    (report.judges as Record<string, unknown>)[j.key] = Object.fromEntries(
      (["disc", "val"] as Period[]).map((p) => [p, { pass: S(j.key, "pass", p), reject: S(j.key, "reject", p), diff: diffOf(j.key, p) }]),
    );
  }
  if (best) {
    const k = best.j.key;
    log(`\n# CHOSEN (highest first-period win rate of the passed): ${k} — ${best.j.ja}`);
    for (const tf of TFS) {
      for (const period of ["disc", "val"] as Period[]) {
        const label = `${tf} ${period === "disc" ? "1st" : "2nd"}`;
        log(line(`${k} pass ${label}`, S(k, "pass", period, `tf:${tf}`)));
        if (k !== "confirm") log(line(`${k} reject ${label}`, S(k, "reject", period, `tf:${tf}`)));
        log(line(`all signals ${label}`, S("all", "pass", period, `tf:${tf}`)));
        log(diffLine(`${k} ${label}`, diffOf(k, period, `tf:${tf}`), k === "confirm" ? "all signals" : "rejected"));
      }
    }
    const d = diffOf(k, "val");
    const works = d !== null && Number.isFinite(d.se) && d.d - 1.96 * d.se > 0;
    log(`## VERDICT: ${works ? "WORKS" : "DOES NOT WORK"} on the second period (passed − ${k === "confirm" ? "all signals" : "rejected"} ${d ? ci(d.d, d.se, pp) : "n/a"})`);
    report.chosen = { judge: k, works };
  }
  await Deno.writeTextFile(`${OUT}/stochfake.json`, JSON.stringify(report));
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

if (import.meta.main) await main();
