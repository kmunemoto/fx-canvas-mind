// What should RSI be combined with? (#103)
//
// The request: 「全てのテクニカル指標を組み合わせるのがいいと思っていません。
// では、rsiと何を組み合わせて分析するのが一番チャートの上がり下がり、反発
// などが当たっているかたくさんの過去のチャートから調べてください」.
//
// THE METHOD (the same footing as indicators.ts, #102):
//
//   * History: GMO's 15-minute bid/ask since 2024-01, all eleven pairs, read
//     on 15min, 1h and 4h.
//   * Bases: RSI's bounce signal (30/70) and its trend signal (50), both
//     sides (rsi-combos.ts BASES).
//   * Partners: one other indicator at a time, one textbook condition each
//     (rsi-combos.ts PARTNERS). A combination is the RSI signal on the bars
//     where the partner agrees.
//   * "Came true" is measured two ways, fixed before reading any data:
//       even — price went 1 ATR the signal's way before 1 ATR against it
//              (the plainest reading of 当たった; break-even 50%, less the
//              spread). This is the PRIMARY measure.
//       app  — the app's own plan: stop 0.8 ATR, target 1.5 times that.
//   * Hours: 15min and 1h leave out 17:00-23:59 UTC, as the app now does.
//   * Two yardsticks: blind entries at the same pair/timeframe/side/UTC hour
//     (as in #102), and RSI's own signal with no partner. A partner is only
//     worth adding if the signals it keeps beat the signals it throws away.
//   * THE RULE: the winner is chosen on the first period (before SPLIT) and
//     judged, untouched, on the second.
//   * Placebo partners: five that keep a random half of RSI's signals. What
//     they show is what filtering by luck does.
//   * Intervals are cluster-robust by calendar week across all pairs and
//     timeframes.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { alignHigher, atrSeriesOf, barOpenMs } from "../supabase/functions/analyze/state.ts";
import { DAY, DAY_OFFSET, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, holm, labelAt, mid, normCdf, subStarts, type LabelSpec, type Side } from "./lib.ts";
import { BASES, PARTNERS, ctxOf, htfTrend, type Dir } from "./rsi-combos.ts";
import { fetchPair } from "./gmo.ts";

const ALL_PAIRS = "USD/JPY,EUR/JPY,GBP/JPY,AUD/JPY,NZD/JPY,CAD/JPY,CHF/JPY,EUR/USD,GBP/USD,AUD/USD,NZD/USD";
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-07-01";
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const CACHE = "research/.cache";
const OUT = "research/out";
// even first: it is the primary measure
const SPECS: Record<string, LabelSpec> = {
  even: { stopAtr: 1, rr: 1, horizon: 48 },
  app: { stopAtr: 0.8, rr: 1.5, horizon: 48 },
};
const SPEC_NAMES = Object.keys(SPECS);
const SIDES: Side[] = ["BUY", "SELL"];
const WARMUP = 210;
const PLACEBOS = 5;
// a combination the first period saw fewer times than this is not ranked:
// its lift would be mostly noise and the maximum would find it
const MIN_N_DISC = 1000;
const TFS = ["15min", "1h", "4h"] as const;
type Tf = (typeof TFS)[number];
const costly = (tf: Tf, hour: number) => tf !== "4h" && hour >= 17 && hour <= 23;

const log = (s = "") => console.log(s);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const pts = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}`);

// ---- accumulation (as indicators.ts) ------------------------------------------

interface Acc {
  n: number;
  w: number;
  b: number;
}
type Period = "disc" | "val";
const agg = new Map<string, Map<number, Acc>>();
const keyOf = (id: string, spec: string, period: Period, scope: string) => `${id}|${spec}|${period}|${scope}`;
const add = (key: string, week: number, win: boolean, base: number) => {
  let m = agg.get(key);
  if (!m) agg.set(key, (m = new Map()));
  const a = m.get(week) ?? { n: 0, w: 0, b: 0 };
  a.n++;
  if (win) a.w++;
  a.b += base;
  m.set(week, a);
};

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

const rngOf = (seed: string) => {
  let s = [...seed].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 23);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const PLACEBO_IDS = Array.from({ length: PLACEBOS }, (_, k) => `placebo_${k + 1}`);
const ALL = "__every_bar__";

// ---- one timeframe of one pair ------------------------------------------------------

const study = (
  pair: string,
  tf: Tf,
  entry: QuoteCandle[],
  intervalMs: number,
  sub: QuoteCandle[] | null,
  higher: QuoteCandle[],
  higherMs: number,
) => {
  const n = entry.length;
  const mids = entry.map(mid);
  const higherMids = higher.map(mid);
  const htf = alignHigher(mids, intervalMs, higherMids, higherMs, htfTrend(higherMids));
  const ctx = ctxOf(mids, htf);
  const atr = atrSeriesOf(mids);
  const subIdx = sub ? { bars: sub, startOf: subStarts(entry, sub) } : null;
  const placebo = Object.fromEntries(PLACEBO_IDS.map((id) => [id, rngOf(`${pair}|${tf}|${id}`)]));

  const base: Record<string, { n: number; w: number }> = {};
  const baseKey = (sp: string, period: Period, side: Side, hour: number) => `${sp}|${period}|${side}|${hour}`;
  const eligible = new Uint8Array(n);
  const hourOf = new Int8Array(n);
  const periodOf: Period[] = new Array(n);
  const weekOf = new Int32Array(n);
  const label: Record<string, Record<Side, Int8Array>> = {};
  for (const sp of SPEC_NAMES) label[sp] = { BUY: new Int8Array(n).fill(-1), SELL: new Int8Array(n).fill(-1) };

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
        const x = l.outcome === "win" ? 1 : l.outcome === "loss" ? 0 : -1;
        label[sp][side][t] = x;
        if (x >= 0) {
          const k = baseKey(sp, period, side, hour);
          const c = base[k] ?? (base[k] = { n: 0, w: 0 });
          c.n++;
          c.w += x;
        }
      }
    }
  }
  const rateAt = (sp: string, period: Period, side: Side, hour: number) => {
    const c = base[baseKey(sp, period, side, hour)];
    return c && c.n > 0 ? c.w / c.n : null;
  };

  for (let t = WARMUP; t < n; t++) {
    if (!eligible[t]) continue;
    const period = periodOf[t];
    const week = weekOf[t];
    const hour = hourOf[t];
    // which RSI signals fire here, and which partners agree with each —
    // decided once per bar, before any outcome is looked at
    const fired: Array<{ base: string; side: Side; tags: string[] }> = [];
    for (const bs of BASES) {
      const d = bs.at(ctx, t);
      if (d === 0) continue;
      const tags: string[] = [bs.id];
      for (const p of PARTNERS) tags.push(`${bs.id}${p[bs.id].ok(ctx, t, d as Dir) ? "+" : "-"}${p.id}`);
      for (const id of PLACEBO_IDS) tags.push(`${bs.id}${placebo[id]() < 0.5 ? "+" : "-"}${id}`);
      fired.push({ base: bs.id, side: d === 1 ? "BUY" : "SELL", tags });
    }
    for (const sp of SPEC_NAMES) {
      for (const side of SIDES) {
        const x = label[sp][side][t];
        const b = rateAt(sp, period, side, hour);
        if (x >= 0 && b !== null) add(keyOf(ALL, sp, period, "all"), week, x === 1, b);
      }
      for (const f of fired) {
        const x = label[sp][f.side][t];
        const b = rateAt(sp, period, f.side, hour);
        if (x < 0 || b === null) continue;
        for (const tag of f.tags) {
          for (const scope of ["all", `tf:${tf}`, `pair:${pair}`, `side:${f.side}`]) add(keyOf(tag, sp, period, scope), week, x === 1, b);
        }
      }
    }
  }
};

// ---- the report ------------------------------------------------------------------------

const ci = (s: Stat | null, which: "p" | "lift") => {
  if (!s) return "n/a";
  const x = which === "p" ? s.p : s.lift;
  const se = which === "p" ? s.seP : s.seL;
  return which === "p" ? `${pct(x)} [${pct(x - 1.96 * se)}〜${pct(x + 1.96 * se)}]` : `${pts(x)} [${pts(x - 1.96 * se)}〜${pts(x + 1.96 * se)}]`;
};
// lift of the kept signals minus lift of the dropped ones: what the partner
// adds to RSI. Treating the two groups as independent overstates the error
// (they share weeks, positively), so this errs on the side of "not proven".
const gain = (inS: Stat | null, outS: Stat | null) =>
  inS && outS ? { d: inS.lift - outS.lift, se: Math.sqrt(inS.seL ** 2 + outS.seL ** 2) } : null;
const gainStr = (g: { d: number; se: number } | null) => (g ? `${pts(g.d)} [${pts(g.d - 1.96 * g.se)}〜${pts(g.d + 1.96 * g.se)}]` : "n/a");
const pDir = (g: { d: number; se: number } | null, sign: number) => (g && g.se > 0 ? 1 - normCdf((sign || 1) * (g.d / g.se)) : 1);

const main = async () => {
  const t0 = Date.now();
  log(`# research/rsi-pairs.ts  pairs=${PAIRS.length} (${PAIRS.join(",")})  start=${START}  split=${SPLIT}`);
  log(`measures: ${Object.entries(SPECS).map(([k, s]) => `${k}=stop ${s.stopAtr}ATR target ${s.rr}x horizon ${s.horizon}`).join(" | ")}  (even is primary)`);
  log(`bases: ${BASES.map((b) => b.id).join(", ")}  partners: ${PARTNERS.map((p) => p.id).join(", ")}  +${PLACEBOS} placebo partners keeping a random half`);
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
    const d1 = aggregate(bars, DAY, DAY_OFFSET, NOW);
    study(pair, "15min", bars, 15 * MINUTE, null, h1, HOUR);
    study(pair, "1h", h1, HOUR, bars, h4, 4 * HOUR);
    study(pair, "4h", h4, 4 * HOUR, bars, d1, DAY);
    log(`   studied in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }

  const report: Record<string, unknown> = { pairs: barsByPair, start: START, split: SPLIT, specs: SPECS, generatedAt: new Date(NOW).toISOString() };
  let winnerId: string | null = null;

  for (const sp of SPEC_NAMES) {
    const rr = SPECS[sp].rr;
    const y = { disc: statOf(keyOf(ALL, sp, "disc", "all")), val: statOf(keyOf(ALL, sp, "val", "all")) };
    log(`\n# measure "${sp}" (break-even ${pct(1 / (1 + rr))} before the spread)`);
    log(`blind entries at every bar: 1st ${pct(y.disc?.p)} (n=${y.disc?.n})  2nd ${pct(y.val?.p)} (n=${y.val?.n})`);
    const alone: Record<string, { disc: Stat | null; val: Stat | null }> = {};
    for (const bs of BASES) {
      alone[bs.id] = { disc: statOf(keyOf(bs.id, sp, "disc", "all")), val: statOf(keyOf(bs.id, sp, "val", "all")) };
      log(`RSI alone, ${bs.id}: 1st win ${pct(alone[bs.id].disc?.p)} lift ${pts(alone[bs.id].disc?.lift)} n=${alone[bs.id].disc?.n} | 2nd win ${ci(alone[bs.id].val, "p")} lift ${ci(alone[bs.id].val, "lift")} n=${alone[bs.id].val?.n}`);
    }

    type Row = {
      id: string;
      base: string;
      partner: string;
      indicator: string;
      placebo: boolean;
      keptDisc: number | null;
      disc: Stat | null;
      val: Stat | null;
      gainDisc: { d: number; se: number } | null;
      gainVal: { d: number; se: number } | null;
    };
    const rows: Row[] = [];
    for (const bs of BASES) {
      const partners = [...PARTNERS.map((p) => ({ id: p.id, indicator: p.indicator, placebo: false })), ...PLACEBO_IDS.map((id) => ({ id, indicator: "placebo", placebo: true }))];
      for (const p of partners) {
        const inD = statOf(keyOf(`${bs.id}+${p.id}`, sp, "disc", "all"));
        const outD = statOf(keyOf(`${bs.id}-${p.id}`, sp, "disc", "all"));
        const inV = statOf(keyOf(`${bs.id}+${p.id}`, sp, "val", "all"));
        const outV = statOf(keyOf(`${bs.id}-${p.id}`, sp, "val", "all"));
        rows.push({
          id: `${bs.id}+${p.id}`,
          base: bs.id,
          partner: p.id,
          indicator: p.indicator,
          placebo: p.placebo,
          keptDisc: inD && outD ? inD.n / (inD.n + outD.n) : inD ? 1 : null,
          disc: inD,
          val: inV,
          gainDisc: gain(inD, outD),
          gainVal: gain(inV, outV),
        });
      }
    }
    const real = rows.filter((r) => !r.placebo && r.disc && r.val && r.disc.n >= MIN_N_DISC).sort((a, b) => b.disc!.lift - a.disc!.lift);
    const small = rows.filter((r) => !r.placebo && r.disc && r.disc.n < MIN_N_DISC).map((r) => `${r.id}(n=${r.disc!.n})`);
    const dirP = real.map((r) => pDir(r.gainVal, Math.sign(r.gainDisc?.d ?? 1)));
    const adj = holm(dirP);
    log(`\nRSI + one partner, ranked by the FIRST period's lift over blind entries; "adds" = kept signals minus dropped signals (what the partner adds to RSI alone)`);
    real.forEach((r, i) => {
      log(`${String(i + 1).padStart(2)}. ${r.id.padEnd(22)} keeps ${pct(r.keptDisc, 0).padStart(4)} | 1st n=${String(r.disc!.n).padStart(6)} win ${pct(r.disc!.p)} lift ${pts(r.disc!.lift)} adds ${pts(r.gainDisc?.d)} | 2nd n=${String(r.val!.n).padStart(6)} win ${ci(r.val, "p")} lift ${ci(r.val, "lift")} adds ${gainStr(r.gainVal)} p=${dirP[i].toExponential(1)} holm=${adj[i].toFixed(3)}`);
    });
    if (small.length) log(`not ranked (first period n < ${MIN_N_DISC}): ${small.join(", ")}`);
    log(`placebo partners (keep a random half): ${rows.filter((r) => r.placebo).map((r) => `${r.id} 1st ${pts(r.disc?.lift)} adds ${pts(r.gainDisc?.d)} | 2nd ${pts(r.val?.lift)} adds ${pts(r.gainVal?.d)}`).join(" || ")}`);

    const rank = (xs: number[]) => {
      const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
      const r = new Array(xs.length);
      idx.forEach(([, i], k) => (r[i] = k + 1));
      return r as number[];
    };
    const m = real.length;
    const rd = rank(real.map((r) => r.disc!.lift));
    const rv = rank(real.map((r) => r.val!.lift));
    const rho = m > 1 ? 1 - (6 * rd.reduce((s, x, i) => s + (x - rv[i]) ** 2, 0)) / (m * (m * m - 1)) : Number.NaN;
    log(`rank correlation of lift, first vs second period, over ${m} combinations: ${rho.toFixed(2)}`);
    log(`top by the SECOND period alone (descriptive, chosen after seeing it): ${[...real].sort((a, b) => b.val!.lift - a.val!.lift).slice(0, 3).map((r) => `${r.id} win ${pct(r.val!.p)} lift ${pts(r.val!.lift)}`).join(" | ")}`);

    // each partner's better combination by the first period
    const byPartner = new Map<string, Row>();
    for (const r of real) if (!byPartner.has(r.partner)) byPartner.set(r.partner, r);
    log(`each partner at its better base (1st lift -> 2nd lift, 2nd adds): ${[...byPartner.values()].map((r) => `${r.indicator}:${r.base} ${pts(r.disc!.lift)} -> ${pts(r.val!.lift)} (${pts(r.gainVal?.d)})`).join(" | ")}`);

    // The winner is chosen once, on the primary measure's first period, and
    // the other measure reports the same combination.
    if (winnerId === null) winnerId = real[0]?.id ?? null;
    const w = rows.find((r) => r.id === winnerId);
    if (w) {
      const [b, p] = [w.base, w.partner];
      log(`\nWINNER (chosen on the first period of "${SPEC_NAMES[0]}"): ${w.id}`);
      log(`  2nd period: win ${ci(w.val, "p")} vs blind ${pct(w.val?.base)} lift ${ci(w.val, "lift")} | RSI alone ${pct(alone[b].val?.p)} lift ${pts(alone[b].val?.lift)} | adds ${gainStr(w.gainVal)} one-sided p ${pDir(w.gainVal, 1).toExponential(2)} | E ${w.val ? (w.val.p * rr - (1 - w.val.p)).toFixed(3) : "n/a"}R`);
      for (const tf of TFS) {
        const inV = statOf(keyOf(`${b}+${p}`, sp, "val", `tf:${tf}`));
        const outV = statOf(keyOf(`${b}-${p}`, sp, "val", `tf:${tf}`));
        const al = statOf(keyOf(b, sp, "val", `tf:${tf}`));
        log(`    ${tf}: n=${inV?.n} win ${ci(inV, "p")} lift ${ci(inV, "lift")} | RSI alone win ${pct(al?.p)} | adds ${gainStr(gain(inV, outV))}`);
      }
      for (const side of SIDES) {
        const inV = statOf(keyOf(`${b}+${p}`, sp, "val", `side:${side}`));
        const outV = statOf(keyOf(`${b}-${p}`, sp, "val", `side:${side}`));
        log(`    ${side}: n=${inV?.n} win ${ci(inV, "p")} adds ${gainStr(gain(inV, outV))}`);
      }
      let up = 0, total = 0;
      const per: string[] = [];
      for (const pair of Object.keys(barsByPair)) {
        const inV = statOf(keyOf(`${b}+${p}`, sp, "val", `pair:${pair}`));
        const outV = statOf(keyOf(`${b}-${p}`, sp, "val", `pair:${pair}`));
        const g = gain(inV, outV);
        if (!g) continue;
        total++;
        if (g.d > 0) up++;
        per.push(`${pair} ${pts(g.d)}`);
      }
      log(`    pairs where the partner added in the 2nd period: ${up}/${total}  ${per.join(" | ")}`);
    }

    report[sp] = {
      blind: y,
      alone,
      ranking: real.map((r, i) => ({ id: r.id, kept: r.keptDisc, disc: r.disc, val: r.val, gainDisc: r.gainDisc, gainVal: r.gainVal, p: dirP[i], holm: adj[i] })),
      placebos: rows.filter((r) => r.placebo).map((r) => ({ id: r.id, disc: r.disc, val: r.val, gainDisc: r.gainDisc, gainVal: r.gainVal })),
      rho,
      winner: winnerId,
    };
  }

  await Deno.writeTextFile(`${OUT}/rsi-pairs.json`, JSON.stringify(report));
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

await main();
