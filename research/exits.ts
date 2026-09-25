// Does letting winners run pay where a fixed target did not? (#110)
//
// The request: 「全部実装お願いします」, to the plan after #108. Every entry
// tried so far was scored with a fixed target (1.5x or 2x the stop), which
// takes the small wins and never the large ones. The Parabolic SAR was
// designed as a trailing stop — its own author's use of it is to stay in
// until price trades through it — so this study keeps the app's entry and
// changes only the exit.
//
// THE METHOD, fixed before any data was read (the footing of #106):
//
//   * History: GMO's 15-minute bid/ask since 2024-01, eleven pairs, read on
//     1h, 4h and 1day (the timeframes the spread does not eat alive, §8.21).
//   * Entries: the app's RSI + SAR rule; the SAR flip itself (the classic
//     stop-and-reverse entry); and every bar on the side the SAR is on (the
//     yardstick for the trailing exits).
//   * Exits, all filled and settled on the side of the book they would be:
//       fixed     stop 0.8 ATR, target 1.5x, 48 bars (the app today)
//       sar       stop at the SAR, moved every bar, out when price trades
//                 through it (at the SAR, or at the open if it gapped
//                 through); 500 bars at most
//       chandelier stop 3 ATR below the highest high since entry (above the
//                 lowest low for a sell), never loosened; 500 bars at most
//   * The measure is the result in ATR of the entry bar (so exits with
//     different stop distances compare), beside the win rate and the average
//     hold. Blind entries on the same pair, timeframe, side and UTC hour with
//     the same exit are the yardstick; "lift" is the difference.
//   * THE RULE: the exit is chosen for the app's entry on the FIRST period
//     (before 2025-07-01), on 4h, by lift; it is judged untouched on the
//     second. 1h leaves out 17:00-23:59 UTC as the app does.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { atrSeriesOf, barOpenMs } from "../supabase/functions/analyze/state.ts";
import { DAY, DAY_OFFSET, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, mid, subStarts, type Side } from "./lib.ts";
import { revCtxOf, rsiSarAt, tradeR } from "./reversal.ts";
import { chandelierExit, sarExit, sarStops, type Exit } from "./exits-lib.ts";
import { fetchPair } from "./gmo.ts";

// ---- the study --------------------------------------------------------------------------

const ALL_PAIRS = "USD/JPY,EUR/JPY,GBP/JPY,AUD/JPY,NZD/JPY,CAD/JPY,CHF/JPY,EUR/USD,GBP/USD,AUD/USD,NZD/USD";
const EXITS = ["fixed", "sar", "chandelier"] as const;
type ExitName = (typeof EXITS)[number];
const ENTRIES = ["rsi_sar", "sar_flip"] as const;
const TFS = ["1h", "4h", "1day"] as const;
type Tf = (typeof TFS)[number];
const PRIMARY_TF: Tf = "4h";
const FIXED = { stopAtr: 0.8, rr: 1.5, horizon: 48 };
const WARMUP = 60;
const costly = (tf: Tf, hour: number) => tf === "1h" && hour >= 17 && hour <= 23;

interface Acc {
  n: number;
  s: number;
  base: number;
  wins: number;
  bars: number;
  risk: number;
}
type Period = "disc" | "val";
const agg = new Map<string, Map<number, Acc>>();
const add = (key: string, week: number, x: Exit, base: number) => {
  let m = agg.get(key);
  if (!m) agg.set(key, (m = new Map()));
  const a = m.get(week) ?? { n: 0, s: 0, base: 0, wins: 0, bars: 0, risk: 0 };
  a.n++;
  a.s += x.atr;
  a.base += base;
  if (x.atr > 0) a.wins++;
  a.bars += x.bars;
  a.risk += x.risk;
  m.set(week, a);
};
const statOf = (key: string) => {
  const m = agg.get(key);
  if (!m) return null;
  let n = 0, s = 0, b = 0, w = 0, bars = 0, risk = 0;
  for (const a of m.values()) {
    n += a.n;
    s += a.s;
    b += a.base;
    w += a.wins;
    bars += a.bars;
    risk += a.risk;
  }
  if (n === 0) return null;
  const e = s / n;
  const lift = e - b / n;
  const C = m.size;
  let se = 0, sl = 0;
  for (const a of m.values()) {
    se += (a.s - e * a.n) ** 2;
    sl += (a.s - a.base - lift * a.n) ** 2;
  }
  const f = C > 1 ? C / (C - 1) : Number.NaN;
  return { n, e, seE: Math.sqrt(f * se) / n, base: b / n, lift, seL: Math.sqrt(f * sl) / n, win: w / n, hold: bars / n, risk: risk / n };
};

const log = (s = "") => console.log(s);
const a3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(3)}`);
const ci = (x: number, se: number) => `${a3(x)} [${a3(x - 1.96 * se)}〜${a3(x + 1.96 * se)}]`;
const line = (label: string, s: ReturnType<typeof statOf>) =>
  s
    ? `${label.padEnd(30)} n=${String(s.n).padStart(6)} win ${(s.win * 100).toFixed(1)}% hold ${s.hold.toFixed(1)} bars risk ${s.risk.toFixed(2)}ATR | E ${ci(s.e, s.seE)} ATR | blind ${a3(s.base)} lift ${ci(s.lift, s.seL)}`
    : `${label.padEnd(30)} n/a`;

const study = (pair: string, tf: Tf, entry: QuoteCandle[], intervalMs: number, sub: QuoteCandle[] | null, split: number) => {
  const n = entry.length;
  const mids = entry.map(mid);
  const atr = atrSeriesOf(mids);
  const x = revCtxOf(mids);
  const stops = sarStops(mids);
  const subIdx = sub ? { bars: sub, startOf: subStarts(entry, sub) } : null;
  const exitOf = (ex: ExitName, t: number, side: Side, a: number): Exit | null => {
    if (ex === "fixed") {
      const r = tradeR(entry, t, a, side, FIXED, intervalMs, subIdx);
      return r ? { atr: r.r * FIXED.stopAtr, bars: 0, risk: FIXED.stopAtr } : null;
    }
    if (ex === "sar") return sarExit(entry, stops, t, side, a);
    return chandelierExit(entry, t, side, a);
  };
  // blind yardstick: every bar, the side the SAR is on for the next bar
  const base = new Map<string, { n: number; s: number }>();
  const rows: Array<{ t: number; period: Period; week: number; hour: number; side: Side; ex: ExitName; x: Exit }> = [];
  for (let t = WARMUP; t < n - 1; t++) {
    const a = atr[t];
    if (a === null || !(a > 0)) continue;
    const decisionMs = barOpenMs(entry[t].datetime) + intervalMs;
    const hour = new Date(decisionMs).getUTCHours();
    if (costly(tf, hour)) continue;
    const period: Period = decisionMs < split ? "disc" : "val";
    const week = Math.floor((decisionMs - WEEK_OFFSET) / WEEK);
    const side: Side | null = stops.long[t + 1] === true ? "BUY" : stops.long[t + 1] === false ? "SELL" : null;
    if (!side) continue;
    for (const ex of EXITS) {
      const r = exitOf(ex, t, side, a);
      if (!r) continue;
      const k = `${ex}|${period}|${side}|${hour}`;
      const c = base.get(k) ?? { n: 0, s: 0 };
      c.n++;
      c.s += r.atr;
      base.set(k, c);
      rows.push({ t, period, week, hour, side, ex, x: r });
    }
  }
  const baseAt = (ex: string, period: Period, side: Side, hour: number) => {
    const c = base.get(`${ex}|${period}|${side}|${hour}`);
    return c && c.n > 0 ? c.s / c.n : null;
  };
  for (const r of rows) {
    const b = baseAt(r.ex, r.period, r.side, r.hour);
    if (b !== null) add(`blind|${r.ex}|${r.period}|tf:${tf}`, r.week, r.x, b);
  }
  // the entries
  for (let t = WARMUP; t < n - 1; t++) {
    const a = atr[t];
    if (a === null || !(a > 0)) continue;
    const decisionMs = barOpenMs(entry[t].datetime) + intervalMs;
    const hour = new Date(decisionMs).getUTCHours();
    if (costly(tf, hour)) continue;
    const period: Period = decisionMs < split ? "disc" : "val";
    const week = Math.floor((decisionMs - WEEK_OFFSET) / WEEK);
    const fired: Array<{ id: string; side: Side }> = [];
    const d = rsiSarAt(x, t);
    if (d !== 0) fired.push({ id: "rsi_sar", side: d === 1 ? "BUY" : "SELL" });
    if (stops.long[t + 1] !== null && stops.long[t] !== null && stops.long[t + 1] !== stops.long[t]) {
      fired.push({ id: "sar_flip", side: stops.long[t + 1] ? "BUY" : "SELL" });
    }
    for (const f of fired) {
      for (const ex of EXITS) {
        const r = exitOf(ex, t, f.side, a);
        const b = baseAt(ex, period, f.side, hour);
        if (!r || b === null) continue;
        for (const scope of [`tf:${tf}`, "all", `pair:${pair}|tf:${tf}`]) add(`${f.id}|${ex}|${period}|${scope}`, week, r, b);
      }
    }
  }
};

const main = async () => {
  const t0 = Date.now();
  const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS).split(",").map((s) => s.trim()).filter(Boolean);
  const START = Deno.env.get("START") || "2024-01-01";
  const SPLIT = Deno.env.get("SPLIT") || "2025-07-01";
  const split = Date.parse(`${SPLIT}T00:00:00Z`);
  const NOW = Date.now();
  log(`# research/exits.ts  pairs=${PAIRS.length}  start=${START}  split=${SPLIT}  primary: rsi_sar on ${PRIMARY_TF}, exit chosen on the first period`);
  const pairsSeen: string[] = [];
  for (const pair of PAIRS) {
    const { bars } = await fetchPair(pair, { start: START, now: NOW, cache: "research/.cache", concurrency: 8 });
    if (bars.length < 5000) continue;
    pairsSeen.push(pair);
    const h1 = aggregate(bars, HOUR, 0, NOW);
    const h4 = aggregate(bars, 4 * HOUR, 0, NOW);
    const d1 = aggregate(bars, DAY, DAY_OFFSET, NOW);
    study(pair, "1h", h1, HOUR, bars, split);
    study(pair, "4h", h4, 4 * HOUR, bars, split);
    study(pair, "1day", d1, DAY, bars, split);
    log(`## ${pair}: ${bars.length} 15min bars -> 1h ${h1.length} / 4h ${h4.length} / 1day ${d1.length}`);
  }
  void MINUTE;
  const S = (k: string) => statOf(k);

  const ranked = EXITS.map((ex) => ({ ex, disc: S(`rsi_sar|${ex}|disc|tf:${PRIMARY_TF}`), val: S(`rsi_sar|${ex}|val|tf:${PRIMARY_TF}`) }))
    .filter((r) => r.disc)
    .sort((a, b) => b.disc!.lift - a.disc!.lift);
  log(`\n# 1. The app's entry on ${PRIMARY_TF}, each exit, ranked by the FIRST period's lift (units: ATR of the entry bar)`);
  for (const r of ranked) {
    log(line(`${r.ex} 1st`, r.disc));
    log(line(`${r.ex} 2nd`, r.val));
  }
  const winner = ranked[0]?.ex ?? null;
  log(`WINNER (first period): ${winner}`);

  log(`\n# 2. Every entry, exit and timeframe (descriptive)`);
  for (const period of ["disc", "val"] as Period[]) {
    log(`## ${period === "disc" ? `first period (before ${SPLIT})` : `second period (${SPLIT} on)`}`);
    for (const tf of TFS) {
      for (const ex of EXITS) {
        log(line(`blind ${tf} ${ex}`, S(`blind|${ex}|${period}|tf:${tf}`)));
        for (const en of ENTRIES) log(line(`${en} ${tf} ${ex}`, S(`${en}|${ex}|${period}|tf:${tf}`)));
      }
    }
  }
  if (winner) {
    log(`\n# 3. ${winner} on the app's entry, second period, per pair (${PRIMARY_TF})`);
    let up = 0, total = 0;
    for (const pair of pairsSeen) {
      const s = S(`rsi_sar|${winner}|val|pair:${pair}|tf:${PRIMARY_TF}`);
      if (!s) continue;
      total++;
      if (s.e > 0) up++;
      log(line(`  ${pair}`, s));
    }
    log(`  pairs with a positive result: ${up}/${total}`);
  }
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

if (import.meta.main) await main();
