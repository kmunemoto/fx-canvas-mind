// #142: which indicator reads the big flow of a chart best? The owner:
// 「ストキャスってようは今のチャートの大きさ流れが読めないんですよ。チャートの
// 大きな流れを読むのに一番適しているインジケーターを探してきて」
//
// THE DESIGN, fixed before any data was read (the arithmetic, the answer key
// and the candidates are in bigflow-lib.ts):
//
//   * Every candidate's reading on every closed bar is scored against the
//     chart's swings as seen afterwards (the zigzag of K × ATR(14); K = 6
//     primary, 3 and 12 reported): right 1, wrong 0, "neither" a half.
//   * THE CHOICE: the candidate with the highest score on the FIRST period
//     (before SPLIT), the three timeframes counting the same (15min, 1h, 4h;
//     each timeframe's share of bars read right, averaged).
//   * IT HOLDS if, on the SECOND period, (a) it reads better than the
//     stochastic (the owner's complaint) — the difference's 95% interval
//     above zero — and (b) it is the second period's best too, or the
//     difference from the best has an interval that covers zero.
//   * Reported for every candidate, not used to choose: each timeframe's
//     score; how often it says "neither"; how often it turns (per 100 bars);
//     how late it shows a new leg (bars after the leg's first bar, median,
//     and the share of legs it never showed); and what happened next — the
//     share of readings the price then went the same way over 48 bars, and
//     the move in ATR in the reading's direction less the pair's drift.
//   * No costs: nothing here is traded. Readings are not signals.
//   * The same data as research/stochfake.ts: GMO's 15-minute bid/ask
//     (mid) since 2024-01, eleven pairs, read on 15min, 1h and 4h. The
//     first 260 bars of each chart only warm the indicators up. Intervals
//     are clustered by calendar month (every pair and timeframe of a month
//     together: the pairs move together and a leg lasts weeks).
//   * SYNTHETIC=1 runs it on a random walk (research/gmo.ts). There the
//     future holds nothing to find, so every score above 50% there is what
//     an indicator gets from the part of the leg already behind it — the
//     floor the real scores should be read against.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { HOUR, MINUTE, aggregate, mid } from "./lib.ts";
import { fetchPair } from "./gmo.ts";
import {
  CANDIDATES,
  addCell,
  credit,
  flipsOf,
  lagsOf,
  pineAtr,
  readingsOf,
  tfMean,
  zigzag,
  type Cells,
  type Zigzag,
} from "./bigflow-lib.ts";

const ALL_PAIRS = "USD/JPY,EUR/JPY,GBP/JPY,AUD/JPY,NZD/JPY,CAD/JPY,CHF/JPY,EUR/USD,GBP/USD,AUD/USD,NZD/USD";
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-07-01";
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const CACHE = "research/.cache";
const OUT = "research/out";
const WARMUP = 260;
const TFS = ["15min", "1h", "4h"] as const;
type Tf = (typeof TFS)[number];
const PRIMARY = 6;
const SCALES = [PRIMARY, 3, 12];
const AHEAD = 48;
type Period = "disc" | "val";
const PERIODS: Period[] = ["disc", "val"];

// ---- accumulation ----------------------------------------------------------------------

const score = new Map<string, Cells>();
const fwdHit = new Map<string, Cells>();
const fwdMove = new Map<string, Cells>();
const cellsOf = (m: Map<string, Cells>, key: string): Cells => {
  let c = m.get(key);
  if (!c) m.set(key, (c = new Map()));
  return c;
};
// per candidate, period and timeframe
const cover = new Map<string, { dir: number; n: number }>();
const turns = new Map<string, { flips: number; bars: number }>();
const lagLists = new Map<string, Array<{ start: number; lag: number | null; length: number }>>();
const legStats = new Map<string, { legs: number; lengths: number; labeled: number; bars: number }>();
const ptk = (id: string, period: Period, tf: string) => `${id}|${period}|${tf}`;

const study = (tf: Tf, quotes: QuoteCandle[], intervalMs: number) => {
  const c = quotes.map(mid);
  const n = c.length;
  if (n <= WARMUP + AHEAD) return;
  const close = c.map((b) => b.close);
  const atr = pineAtr(c, 14);
  const R = readingsOf(c);
  const zz: Record<number, Zigzag> = {};
  for (const k of SCALES) zz[k] = zigzag(close, atr, k);

  const periodOf: Period[] = new Array(n);
  const monthOf: string[] = new Array(n);
  for (let t = 0; t < n; t++) {
    const closeMs = barOpenMs(c[t].datetime) + intervalMs;
    periodOf[t] = closeMs < SPLIT_MS ? "disc" : "val";
    monthOf[t] = new Date(closeMs).toISOString().slice(0, 7);
  }

  // the answer key's legs, by the period of their first bar
  for (const k of SCALES) {
    const z = zz[k];
    for (let p = 1; p < z.pivots.length; p++) {
      const start = z.pivots[p - 1].i + 1;
      if (start < WARMUP) continue;
      const key = `${k}|${periodOf[start]}|${tf}`;
      const s = legStats.get(key) ?? { legs: 0, lengths: 0, labeled: 0, bars: 0 };
      s.legs++;
      s.lengths += z.pivots[p].i - start + 1;
      legStats.set(key, s);
    }
    for (let t = WARMUP; t < n; t++) {
      const key = `${k}|${periodOf[t]}|${tf}`;
      const s = legStats.get(key) ?? { legs: 0, lengths: 0, labeled: 0, bars: 0 };
      s.bars++;
      if (z.label[t] !== 0) s.labeled++;
      legStats.set(key, s);
    }
  }

  // the pair's drift over the next AHEAD bars, per period
  const move = new Float64Array(n).fill(Number.NaN);
  const drift: Record<Period, { s: number; n: number }> = { disc: { s: 0, n: 0 }, val: { s: 0, n: 0 } };
  for (let t = WARMUP; t + AHEAD < n; t++) {
    const a = atr[t];
    if (a === null || !(a > 0)) continue;
    move[t] = (close[t + AHEAD] - close[t]) / a;
    drift[periodOf[t]].s += move[t];
    drift[periodOf[t]].n++;
  }

  for (const cand of CANDIDATES) {
    const r = R[cand.id];
    for (let t = WARMUP; t < n; t++) {
      const period = periodOf[t];
      const month = monthOf[t];
      for (const k of SCALES) {
        const L = zz[k].label[t];
        if (L === 0) continue;
        addCell(cellsOf(score, `${cand.id}|${k}|${period}`), month, tf, credit(r[t], L));
        if (k === PRIMARY) {
          const cv = cover.get(ptk(cand.id, period, tf)) ?? { dir: 0, n: 0 };
          cv.n++;
          if (r[t] !== 0) cv.dir++;
          cover.set(ptk(cand.id, period, tf), cv);
        }
      }
      const m = move[t];
      if (r[t] !== 0 && Number.isFinite(m)) {
        const d = drift[period].n > 0 ? drift[period].s / drift[period].n : 0;
        addCell(cellsOf(fwdMove, `${cand.id}|${period}`), month, tf, r[t] * (m - d));
        if (m !== 0) addCell(cellsOf(fwdHit, `${cand.id}|${period}`), month, tf, Math.sign(m) === r[t] ? 1 : 0);
      }
    }
    // turns, per period (the bars of each period are one run)
    for (const period of PERIODS) {
      let from = -1, to = -1;
      for (let t = WARMUP; t < n; t++) {
        if (periodOf[t] !== period) continue;
        if (from < 0) from = t;
        to = t;
      }
      if (from < 0) continue;
      const tk = turns.get(ptk(cand.id, period, tf)) ?? { flips: 0, bars: 0 };
      tk.flips += flipsOf(r, from, to);
      tk.bars += to - from + 1;
      turns.set(ptk(cand.id, period, tf), tk);
    }
    for (const l of lagsOf(r, zz[PRIMARY], WARMUP)) {
      // by the period of the leg's first bar
      const key = ptk(cand.id, periodOf[l.start], tf);
      const list = lagLists.get(key) ?? [];
      list.push(l);
      lagLists.set(key, list);
    }
  }
};

// ---- the report -------------------------------------------------------------------------

const log = (s = "") => console.log(s);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pt`;
const atrs = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
const ci = (r: { est: number; se: number } | null, f: (v: number) => string) =>
  r ? `${f(r.est)} [${f(r.est - 1.96 * r.se)}〜${f(r.est + 1.96 * r.se)}]` : "n/a";
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const scoreOf = (id: string, k: number, period: Period, tfs: readonly string[] = TFS) => {
  const cells = score.get(`${id}|${k}|${period}`);
  return cells ? tfMean(cells, tfs) : null;
};
const diffOf = (a: string, b: string, k: number, period: Period, tfs: readonly string[] = TFS) => {
  const A = score.get(`${a}|${k}|${period}`), B = score.get(`${b}|${k}|${period}`);
  return A && B ? tfMean(A, tfs, B) : null;
};

const main = async () => {
  const t0 = Date.now();
  log(`# research/bigflow.ts  pairs=${PAIRS.length}  start=${START}  split=${SPLIT}  synthetic=${Deno.env.get("SYNTHETIC") ? "yes" : "no"}`);
  log(`answer key: zigzag on closes, turning at K × ATR(14); K=${PRIMARY} primary, ${SCALES.filter((k) => k !== PRIMARY).join(" and ")} reported`);
  for (const c of CANDIDATES) log(`  ${c.id.padEnd(16)} [${c.where}] ${c.ja}`);
  await Deno.mkdir(OUT, { recursive: true });
  for (const pair of PAIRS) {
    const t1 = Date.now();
    const { bars } = await fetchPair(pair, { start: START, now: NOW, cache: CACHE, concurrency: 8 });
    if (bars.length < 5000) {
      log(`## ${pair}: ${bars.length} bars, skipped`);
      continue;
    }
    study("15min", bars, 15 * MINUTE);
    study("1h", aggregate(bars, HOUR, 0, NOW), HOUR);
    study("4h", aggregate(bars, 4 * HOUR, 0, NOW), 4 * HOUR);
    log(`## ${pair}: ${bars.length} 15min bars ${bars[0].datetime} .. ${bars[bars.length - 1].datetime}, studied in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  }

  log(`\n# the answer key: legs per scale (after the warm-up)`);
  for (const k of SCALES) {
    for (const tf of TFS) {
      const row = PERIODS.map((p) => {
        const s = legStats.get(`${k}|${p}|${tf}`);
        return s ? `${p}: ${s.legs} legs, mean ${(s.lengths / Math.max(1, s.legs)).toFixed(0)} bars, ${pct(s.labeled / Math.max(1, s.bars))} of bars scored` : `${p}: n/a`;
      });
      log(`K=${String(k).padEnd(2)} ${tf.padEnd(5)} ${row.join(" | ")}`);
    }
  }

  const report: Record<string, unknown> = { start: START, split: SPLIT, synthetic: Boolean(Deno.env.get("SYNTHETIC")), generatedAt: new Date(NOW).toISOString(), candidates: {} };
  const rows = CANDIDATES.map((c) => ({ c, disc: scoreOf(c.id, PRIMARY, "disc"), val: scoreOf(c.id, PRIMARY, "val") }))
    .filter((r) => r.disc !== null)
    .sort((a, b) => b.disc!.est - a.disc!.est);

  log(`\n# K=${PRIMARY} (primary): the share of bars read right, the three timeframes averaged — ranked by the FIRST period`);
  rows.forEach((r, i) => {
    const perTf = TFS.map((tf) => `${tf} ${pct(scoreOf(r.c.id, PRIMARY, "val", [tf])?.est)}`).join(" ");
    log(`${String(i + 1).padStart(2)}. ${r.c.id.padEnd(16)} 1st ${ci(r.disc, (v) => pct(v))} | 2nd ${ci(r.val, (v) => pct(v))} | 2nd by timeframe: ${perTf}`);
  });

  log(`\n# the second period, each candidate: says "neither" / turns per 100 bars / late by (median bars, legs never shown) / next 48 bars`);
  for (const r of rows) {
    const id = r.c.id;
    const parts = TFS.map((tf) => {
      const cv = cover.get(ptk(id, "val", tf));
      const tk = turns.get(ptk(id, "val", tf));
      const lags = lagLists.get(ptk(id, "val", tf)) ?? [];
      const shown = lags.filter((l) => l.lag !== null).map((l) => l.lag as number);
      const missed = lags.length ? (lags.length - shown.length) / lags.length : null;
      return `${tf}: ${pct(cv ? 1 - cv.dir / cv.n : null, 0)} / ${tk ? ((100 * tk.flips) / tk.bars).toFixed(1) : "n/a"} / ${median(shown) ?? "n/a"} bars, ${pct(missed, 0)} missed`;
    });
    const hit = fwdHit.get(`${id}|val`);
    const mv = fwdMove.get(`${id}|val`);
    log(`${id.padEnd(16)} ${parts.join(" | ")} | next 48: same way ${ci(hit ? tfMean(hit, TFS) : null, (v) => pct(v))}, move ${ci(mv ? tfMean(mv, TFS) : null, atrs)} ATR`);
  }

  for (const k of SCALES.filter((x) => x !== PRIMARY)) {
    log(`\n# K=${k}: first and second period (ranked by the first)`);
    CANDIDATES.map((c) => ({ c, disc: scoreOf(c.id, k, "disc"), val: scoreOf(c.id, k, "val") }))
      .filter((r) => r.disc !== null)
      .sort((a, b) => b.disc!.est - a.disc!.est)
      .forEach((r, i) => log(`${String(i + 1).padStart(2)}. ${r.c.id.padEnd(16)} 1st ${pct(r.disc!.est)} | 2nd ${ci(r.val, (v) => pct(v))}`));
  }

  log(`\n# 4h alone (the chart the app opens on), K=${PRIMARY}: top 8 of each period`);
  for (const period of PERIODS) {
    const top = CANDIDATES.map((c) => ({ id: c.id, s: scoreOf(c.id, PRIMARY, period, ["4h"]) }))
      .filter((r) => r.s !== null)
      .sort((a, b) => b.s!.est - a.s!.est)
      .slice(0, 8)
      .map((r) => `${r.id} ${pct(r.s!.est)}`);
    log(`${period === "disc" ? "1st" : "2nd"}: ${top.join(", ")}`);
  }

  const chosen = rows[0]?.c ?? null;
  if (chosen) {
    const valBest = [...rows].sort((a, b) => (b.val?.est ?? -1) - (a.val?.est ?? -1))[0].c;
    const vsStoch = diffOf(chosen.id, "stoch", PRIMARY, "val");
    const vsBest = chosen.id === valBest.id ? null : diffOf(chosen.id, valBest.id, PRIMARY, "val");
    const a = vsStoch !== null && Number.isFinite(vsStoch.se) && vsStoch.est - 1.96 * vsStoch.se > 0;
    const b = chosen.id === valBest.id || (vsBest !== null && Number.isFinite(vsBest.se) && vsBest.est + 1.96 * vsBest.se >= 0);
    const valRank = [...rows].sort((x, y) => (y.val?.est ?? -1) - (x.val?.est ?? -1)).findIndex((r) => r.c.id === chosen.id) + 1;
    log(`\n# CHOSEN on the first period: ${chosen.id} — ${chosen.ja}`);
    log(`second period: ${ci(rows[0].val, (v) => pct(v))}, rank ${valRank} of ${rows.length}`);
    for (const tf of TFS) log(`  ${tf}: 1st ${pct(scoreOf(chosen.id, PRIMARY, "disc", [tf])?.est)} | 2nd ${pct(scoreOf(chosen.id, PRIMARY, "val", [tf])?.est)} | stochastic 2nd ${pct(scoreOf("stoch", PRIMARY, "val", [tf])?.est)}`);
    log(`(a) against the stochastic, 2nd: ${ci(vsStoch, pp)} → ${a ? "better" : "not shown better"}`);
    log(`(b) against the 2nd period's best (${valBest.id}): ${vsBest ? ci(vsBest, pp) : "it is the best"} → ${b ? "still among the best" : "behind the best"}`);
    log(`## VERDICT: ${a && b ? "HOLDS" : "DOES NOT HOLD"} on the second period`);
    report.chosen = { id: chosen.id, holds: a && b, vsStoch, vsBest, valBest: valBest.id, valRank };
  }
  for (const c of CANDIDATES) {
    (report.candidates as Record<string, unknown>)[c.id] = Object.fromEntries(
      SCALES.map((k) => [`K${k}`, Object.fromEntries(PERIODS.map((p) => [p, { all: scoreOf(c.id, k, p), ...Object.fromEntries(TFS.map((tf) => [tf, scoreOf(c.id, k, p, [tf])])) }]))]),
    );
  }
  await Deno.writeTextFile(`${OUT}/bigflow${Deno.env.get("SYNTHETIC") ? "-synthetic" : ""}.json`, JSON.stringify(report));
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

if (import.meta.main) await main();
