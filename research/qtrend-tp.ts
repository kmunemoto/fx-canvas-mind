// #156: a target and a stop for Q-Trend's signals. Q-Trend (#145) has none
// of its own; the owner, shown the 5-minute chart's BUY and STRONG labels:
// 「buy、sellの合図が出た時にtp出してくれないの？」, and offered three ways to
// set them: 「先に3つを測って比べる」.
//
// THE METHOD, fixed before any data was read:
//
//   * The signals are the emails' (signal-alerts, #155): GMO's 5-minute
//     bid/ask of the 21 pairs the 5-minute alerts cover, rounded as the chart
//     reads them (live-chart historyRead), each closed bar judged as the
//     sweep judges it — its newest 600 closed bars, Q-Trend from
//     anchoredStart — and the signal on that newest bar kept. Checked against
//     indicatorSignals itself on a sample of bars (reported).
//   * The three ways, TP1..TP3 for k = 1, 2, 3:
//       A "line":  the stop where the opposite signal would fire on the next
//                  close (the line after the signal ∓ ATR(14)), TPk k times
//                  that distance
//       B "ultra": ULTRA's numbers, the stop 10 pips, TPk 5k pips
//       C "atr":   the stop 1.5 ATR(14), TPk k ATR
//   * Entry at the signal bar's close on the side of the book it fills on
//     (BUY the ask, SELL the bid); the bars after it on the side it closes
//     on. The whole position out at TPk or the stop, whichever comes first,
//     each k on its own. A bar that reaches both is "ambiguous" and counted
//     as the stop; a bar opening past a level fills at its open; still open
//     after MAX_HOLD bars (a day), closed at that bar's close. Each signal on
//     its own, as the emails send them (they overlap).
//   * Reported in R (the stop's distance, spread paid) and in pips: all, the
//     first period (before SPLIT) and the second, STRONG and not, each pair;
//     95% intervals cluster-robust by calendar week. Nothing is chosen here:
//     the numbers are for the owner to choose from.
//   * Added after the first run (every rule lost about 2.2 pips a trade),
//     to tell the cost from the timing: the spread paid at each entry, each
//     pair's; the signals by the UTC hour they fired in; and blind entries
//     as the yardstick — every BLIND_EVERY-th bar, on the side Q-Trend's
//     trend then points, with the same three exits (TP1) — so a signal is
//     compared with entering the same trend at any other time.

import { GMO_SYMBOLS, dateKeys, jstDayKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure, isMarketClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { pineAtr } from "../supabase/functions/_shared/pine.ts";
import { indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { GMO_STUDY_PAIRS, MINUTE, WEEK, WEEK_OFFSET, iso, wilson } from "./lib.ts";

// #175: the 21 pairs measured before the app kept the yen pairs only
const ALL_PAIRS = GMO_STUDY_PAIRS;
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2026-01-05";
const SPLIT = Deno.env.get("SPLIT") || "2026-05-18";
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const CACHE = "research/.cache";
const OUT = "research/out";
const STEP = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS) and the chart's
const WINDOW = 600;
const MAX_HOLD = 288;
const CHECK_EVERY = 97;
const BLIND_EVERY = 6;
const MAJORS = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "GBP/USD", "AUD/USD"];

// GMO's 5-minute day files, as research/gmo.ts reads the 15-minute ones
// (that file is left as it is: four studies rerun whenever it changes)
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
const fetch5 = async (pair: string): Promise<{ bars: QuoteCandle[]; requests: number; cached: number; failed: number }> => {
  if (Deno.env.get("SYNTHETIC")) {
    // a seeded random walk on 5 minutes (mulberry32, as research/gmo.ts):
    // on it every rule must come out at the spread's cost, no better. (Cutting
    // gmo.ts's 15-minute walk in three would not do: the three bars of each
    // would move one way, a trend a trend-follower profits from.)
    let seed = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const bars: QuoteCandle[] = [];
    let px = 150;
    for (let ms = Date.parse(`${START}T00:00:00Z`); ms + STEP <= NOW; ms += STEP) {
      if (isMarketClosed(ms)) continue;
      const o = px;
      px = o + (rnd() - 0.5) * 0.07;
      const h = Math.max(o, px) + rnd() * 0.02;
      const l = Math.min(o, px) - rnd() * 0.02;
      const dt = iso(ms);
      const bid = { datetime: dt, open: o, high: h, low: l, close: px };
      bars.push({ datetime: dt, bid, ask: { ...bid, open: o + 0.004, high: h + 0.004, low: l + 0.004, close: px + 0.004 } });
    }
    return { bars, requests: 0, cached: 0, failed: 0 };
  }
  const symbol = GMO_SYMBOLS[pair];
  if (!symbol) throw new Error(`no GMO symbol for ${pair}`);
  const today = jstDayKey(NOW);
  const keys = dateKeys(Date.parse(`${START}T00:00:00Z`), NOW, "day").filter((k) => k <= today);
  const fresh = new Set(keys.slice(-3));
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: typeof bid = [];
  let requests = 0;
  let cached = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      for (const side of ["bid", "ask"] as const) {
        const path = `${CACHE}/${symbol}/5min/${side}/${key}.json`;
        let body: unknown;
        if (!fresh.has(key)) {
          try {
            body = JSON.parse(await Deno.readTextFile(path));
          } catch {
            body = undefined;
          }
        }
        if (body === undefined) {
          const r = await getJson(klineUrl(symbol, side, "5min", key));
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
  await Promise.all(Array.from({ length: 8 }, worker));
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  const bars = mergeSides(bid, ask)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && !barInsideClosure(t, STEP) && t + STEP <= NOW;
    })
    .map((q) => ({ ...q, datetime: q.datetime.slice(0, 19).replace("T", " ") }));
  return { bars, requests, cached, failed };
};

type Side = "BUY" | "SELL";
type Rule = "line" | "ultra" | "atr";
const RULES: Rule[] = ["line", "ultra", "atr"];
const KS = [1, 2, 3] as const;
// the stop's distance and TPk's, from what each rule reads at the signal
const levels = (rule: Rule, side: Side, entry: number, lineAfter: number, atr: number, unit: number, k: number) => {
  const dir = side === "BUY" ? 1 : -1;
  if (rule === "line") {
    const sl = lineAfter - dir * QT_DEFAULTS.mult * atr;
    const r = Math.abs(entry - sl);
    return { sl, tp: entry + dir * k * r, r };
  }
  if (rule === "ultra") return { sl: entry - dir * 10 * unit, tp: entry + dir * 5 * k * unit, r: 10 * unit };
  return { sl: entry - dir * 1.5 * atr, tp: entry + dir * k * atr, r: 1.5 * atr };
};
// the win rate at which each breaks even before costs
const breakEven = (rule: Rule, k: number) => (rule === "line" ? 1 / (1 + k) : rule === "ultra" ? 10 / (10 + 5 * k) : 1.5 / (1.5 + k));

type Kind = "tp" | "sl" | "amb" | "exp";
interface Trade {
  pair: string;
  t: number;
  side: Side;
  strong: boolean;
  rule: Rule;
  k: number;
  kind: Kind;
  r: number; // P/L in R
  pips: number;
  slPips: number;
  bars: number;
  blind: boolean;
  hour: number;
  spreadPips: number;
}

const simulate = (qs: QuoteCandle[], i: number, side: Side, sl: number, tp: number): { kind: Kind; exit: number; bars: number } | null => {
  const buy = side === "BUY";
  const last = i + MAX_HOLD;
  if (last > qs.length - 1) return null;
  for (let j = i + 1; j <= last; j++) {
    const x = buy ? qs[j].bid : qs[j].ask;
    if (buy ? x.open <= sl : x.open >= sl) return { kind: "sl", exit: x.open, bars: j - i };
    if (buy ? x.open >= tp : x.open <= tp) return { kind: "tp", exit: x.open, bars: j - i };
    const hitTp = buy ? x.high >= tp : x.low <= tp;
    const hitSl = buy ? x.low <= sl : x.high >= sl;
    if (hitTp && hitSl) return { kind: "amb", exit: sl, bars: j - i };
    if (hitSl) return { kind: "sl", exit: sl, bars: j - i };
    if (hitTp) return { kind: "tp", exit: tp, bars: j - i };
  }
  const x = buy ? qs[last].bid : qs[last].ask;
  return { kind: "exp", exit: x.close, bars: MAX_HOLD };
};

// mean and its 95% interval, cluster-robust by calendar week
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

const summarize = (ts: Trade[]) => {
  const n = ts.length;
  const count = (k: Kind) => ts.filter((x) => x.kind === k).length;
  const tp = count("tp");
  const r = meanCi(ts.map((x) => ({ t: x.t, v: x.r })));
  const w = wilson(tp, n);
  const pips = ts.reduce((a, x) => a + x.pips, 0);
  const sorted = ts.map((x) => x.slPips).sort((a, b) => a - b);
  return {
    n,
    tp,
    sl: count("sl"),
    amb: count("amb"),
    exp: count("exp"),
    win: n ? tp / n : null,
    winLo: w?.lo ?? null,
    winHi: w?.hi ?? null,
    meanR: r.mean,
    rLo: r.lo,
    rHi: r.hi,
    meanPips: n ? pips / n : null,
    totalPips: pips,
    medianSlPips: n ? sorted[Math.floor(n / 2)] : null,
    meanBars: n ? ts.reduce((a, x) => a + x.bars, 0) / n : null,
  };
};

const trades: Trade[] = [];
const coverage: Array<{ pair: string; bars: number; first: string | null; last: string | null; signals: number; strong: number; requests: number; cached: number; failed: number }> = [];
const check = { compared: 0, mismatched: 0, examples: [] as string[] };

for (const pair of PAIRS) {
  const got = await fetch5(pair);
  // the chart's bars: mid, rounded as drawn, closed only
  const candles = historyRead(pair, "5min", got.bars, NOW).candles;
  const byOpen = new Map(got.bars.map((q) => [barOpenMs(q.datetime), q]));
  const times = candles.map((c) => barOpenMs(c.datetime));
  const qs = times.map((t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);
  const unit = ultraUnit(pair);
  const n = candles.length;

  // where the sweep would start Q-Trend with bar i the newest (its window)
  const firstShown = WINDOW - CHART_BARS;
  const anchorOf = (i: number) => {
    const w = times.slice(i - WINDOW + 1, i + 1);
    return i - WINDOW + 1 + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, WINDOW - 1);
  };
  // Q-Trend reads only the bars up to each one, so one run from an anchor
  // gives every newest bar that anchor serves
  const signals: Array<{ i: number; side: Side; strong: boolean; lineAfter: number; atr: number }> = [];
  const blinds: typeof signals = [];
  let g0 = WINDOW - 1;
  let s0 = n > g0 ? anchorOf(g0) : -1;
  for (let i = g0 + 1; i <= n && n > WINDOW - 1; i++) {
    const s = i < n ? anchorOf(i) : -1;
    if (s === s0) continue;
    const seg = candles.slice(s0, i);
    const qt = qTrend(seg, QT_DEFAULTS, seg.length - 1);
    const atr = pineAtr(seg, QT_DEFAULTS.atrPeriod);
    for (const sig of qt.signals) {
      const at = s0 + sig.i;
      if (at < g0 || at > i - 1) continue;
      const lineAfter = qt.line[sig.i];
      const a = atr[sig.i];
      if (lineAfter === null || a === null || !Number.isFinite(lineAfter) || !Number.isFinite(a)) continue;
      signals.push({ i: at, side: sig.side, strong: sig.strong, lineAfter, atr: a });
    }
    // the yardstick: the same trend entered at any bar
    for (let at = g0; at <= i - 1; at++) {
      if (at % BLIND_EVERY !== 0) continue;
      const tr = qt.trend[at - s0];
      const lineAfter = qt.line[at - s0];
      const a = atr[at - s0];
      if ((tr !== 1 && tr !== -1) || lineAfter === null || a === null || !Number.isFinite(lineAfter) || !Number.isFinite(a)) continue;
      blinds.push({ i: at, side: tr === 1 ? "BUY" : "SELL", strong: false, lineAfter, atr: a });
    }
    g0 = i;
    s0 = s;
  }

  // the check: the emails' own function on a sample of newest bars
  const mine = new Map(signals.map((x) => [x.i, x]));
  for (let i = WINDOW - 1; i < n; i += CHECK_EVERY) {
    const theirs = indicatorSignals(pair, "5min", candles.slice(i - WINDOW + 1, i + 1), times[i] + STEP + 60_000, 120_000)
      .filter((x) => x.rule === "qtrend" && Date.parse(x.barTime) === times[i]);
    const m = mine.get(i);
    const same = theirs.length === (m ? 1 : 0) && (!m || (theirs[0].side === m.side && theirs[0].strong === m.strong));
    check.compared++;
    if (!same) {
      check.mismatched++;
      if (check.examples.length < 10) check.examples.push(`${pair} ${iso(times[i])} mine=${m ? m.side : "-"} theirs=${theirs.map((x) => x.side).join(",") || "-"}`);
    }
  }
  // and every signal found, on the bars around it (a sample would miss them)
  for (const m of signals.filter((_, k) => k % 7 === 0)) {
    const theirs = indicatorSignals(pair, "5min", candles.slice(m.i - WINDOW + 1, m.i + 1), times[m.i] + STEP + 60_000, 120_000)
      .filter((x) => x.rule === "qtrend" && Date.parse(x.barTime) === times[m.i]);
    check.compared++;
    if (!(theirs.length === 1 && theirs[0].side === m.side && theirs[0].strong === m.strong)) {
      check.mismatched++;
      if (check.examples.length < 10) check.examples.push(`${pair} ${iso(times[m.i])} mine=${m.side} theirs=${theirs.map((x) => x.side).join(",") || "-"}`);
    }
  }

  for (const sg of [...signals.map((x) => ({ ...x, blind: false })), ...blinds.map((x) => ({ ...x, blind: true }))]) {
    const buy = sg.side === "BUY";
    const entry = buy ? qs[sg.i].ask.close : qs[sg.i].bid.close;
    const spreadPips = (qs[sg.i].ask.close - qs[sg.i].bid.close) / unit;
    const hour = new Date(times[sg.i]).getUTCHours();
    for (const rule of RULES) {
      for (const k of sg.blind ? [1] : KS) {
        const lv = levels(rule, sg.side, entry, sg.lineAfter, sg.atr, unit, k);
        if (!(lv.r > 0)) continue;
        const res = simulate(qs, sg.i, sg.side, lv.sl, lv.tp);
        if (!res) continue;
        const pnl = buy ? res.exit - entry : entry - res.exit;
        trades.push({ pair, t: times[sg.i], side: sg.side, strong: sg.strong, rule, k, kind: res.kind, r: pnl / lv.r, pips: pnl / unit, slPips: lv.r / unit, bars: res.bars, blind: sg.blind, hour, spreadPips });
      }
    }
  }
  coverage.push({
    pair,
    bars: n,
    first: n ? iso(times[0]) : null,
    last: n ? iso(times[n - 1]) : null,
    signals: signals.length,
    strong: signals.filter((x) => x.strong).length,
    requests: got.requests,
    cached: got.cached,
    failed: got.failed,
  });
  console.log(`${pair}: ${n} bars ${n ? iso(times[0]) : "-"} .. ${n ? iso(times[n - 1]) : "-"}, ${signals.length} signals (${signals.filter((x) => x.strong).length} STRONG); GMO ${got.requests} read, ${got.cached} cached, ${got.failed} failed`);
}

// ---- the report ------------------------------------------------------------------------
const pct = (x: number | null) => (x === null ? "   -  " : `${(100 * x).toFixed(1).padStart(5)}%`);
const num = (x: number | null, d = 3) => (x === null ? "-" : x.toFixed(d));
const row = (label: string, s: ReturnType<typeof summarize>, be: number) =>
  `${label.padEnd(22)} n=${String(s.n).padStart(6)}  TP ${pct(s.win)} [${pct(s.winLo)},${pct(s.winHi)}] (break-even ${pct(be)})  SL ${String(s.sl).padStart(5)} amb ${String(s.amb).padStart(4)} exp ${String(s.exp).padStart(4)}  ` +
  `R ${num(s.meanR)} [${num(s.rLo)}, ${num(s.rHi)}]  pips/trade ${num(s.meanPips, 2)}  total ${num(s.totalPips, 0)}  stop ${num(s.medianSlPips, 1)} pips  held ${num(s.meanBars, 0)} bars`;

const report: Record<string, unknown> = { start: START, split: SPLIT, now: iso(NOW), maxHold: MAX_HOLD, pairs: PAIRS, coverage, check };
const sections: Record<string, (x: Trade) => boolean> = {
  all: (x) => !x.blind,
  first: (x) => !x.blind && x.t < SPLIT_MS,
  second: (x) => !x.blind && x.t >= SPLIT_MS,
  strong: (x) => !x.blind && x.strong,
  normal: (x) => !x.blind && !x.strong,
};
console.log(`\n#156 Q-Trend's signals on 5 minutes, ${START} .. ${iso(NOW)} (split ${SPLIT}); the whole position out at TPk or the stop; ${MAX_HOLD} bars at most`);
console.log(`check against indicatorSignals: ${check.mismatched} of ${check.compared} differ${check.examples.length ? ": " + check.examples.join("; ") : ""}`);
const tables: Record<string, unknown> = {};
for (const [name, keep] of Object.entries(sections)) {
  console.log(`\n== ${name}`);
  const t: Record<string, unknown> = {};
  for (const rule of RULES) {
    for (const k of KS) {
      const s = summarize(trades.filter((x) => x.rule === rule && x.k === k && keep(x)));
      t[`${rule}-tp${k}`] = s;
      console.log(row(`${rule} TP${k}`, s, breakEven(rule, k)));
    }
  }
  tables[name] = t;
}
console.log("\n== the yardstick (TP1): the signals, and the same trend entered at every " + BLIND_EVERY + "th bar");
const yard: Record<string, unknown> = {};
const groups: Array<[string, (x: Trade) => boolean]> = [["all pairs", () => true], ["7 majors", (x) => MAJORS.includes(x.pair)]];
for (const [name, keep] of groups) {
  for (const rule of RULES) {
    const sig = summarize(trades.filter((x) => !x.blind && x.rule === rule && x.k === 1 && keep(x)));
    const bl = summarize(trades.filter((x) => x.blind && x.rule === rule && x.k === 1 && keep(x)));
    yard[`${name}-${rule}`] = { signals: sig, blind: bl };
    console.log(row(`${name} ${rule} signals`, sig, breakEven(rule, 1)));
    console.log(row(`${name} ${rule} blind`, bl, breakEven(rule, 1)));
  }
}
report.yardstick = yard;

console.log("\n== by the UTC hour the signal fired (TP1): mean R / pips a trade / median spread paid");
const buckets: Array<[string, number, number]> = [["00-05", 0, 5], ["06-11", 6, 11], ["12-16", 12, 16], ["17-20", 17, 20], ["21-23", 21, 23]];
const byHour: Record<string, unknown> = {};
for (const [label, a, b] of buckets) {
  const cells = RULES.map((rule) => summarize(trades.filter((x) => !x.blind && x.rule === rule && x.k === 1 && x.hour >= a && x.hour <= b)));
  const sp = trades.filter((x) => !x.blind && x.rule === "line" && x.k === 1 && x.hour >= a && x.hour <= b).map((x) => x.spreadPips).sort((p, q) => p - q);
  byHour[label] = { n: cells[0].n, medianSpread: sp.length ? sp[Math.floor(sp.length / 2)] : null, ...Object.fromEntries(RULES.map((rule, k) => [rule, { meanR: cells[k].meanR, meanPips: cells[k].meanPips, win: cells[k].win }])) };
  console.log(`${label} UTC  n=${String(cells[0].n).padStart(6)}  spread ${num(sp.length ? sp[Math.floor(sp.length / 2)] : null, 2)} pips  ` + RULES.map((rule, k) => `${rule} ${num(cells[k].meanR, 2)}R ${num(cells[k].meanPips, 2)}p ${pct(cells[k].win)}`).join("   "));
}
report.byHour = byHour;

console.log("\n== each pair: median spread paid; mean R (TP1 / TP2 / TP3); pips a trade at TP1");
const perPair: Record<string, unknown> = {};
for (const pair of PAIRS) {
  const cells = RULES.map((rule) => KS.map((k) => summarize(trades.filter((x) => !x.blind && x.pair === pair && x.rule === rule && x.k === k))));
  const sp = trades.filter((x) => !x.blind && x.pair === pair && x.rule === "line" && x.k === 1).map((x) => x.spreadPips).sort((p, q) => p - q);
  const spread = sp.length ? sp[Math.floor(sp.length / 2)] : null;
  perPair[pair] = { spread, ...Object.fromEntries(RULES.map((rule, a) => [rule, cells[a].map((s) => ({ n: s.n, meanR: s.meanR, win: s.win, meanPips: s.meanPips, stopPips: s.medianSlPips }))])) };
  console.log(`${pair.padEnd(8)} spread ${num(spread, 2).padStart(5)}  ` + RULES.map((rule, a) => `${rule} ${cells[a].map((s) => num(s.meanR, 2).padStart(6)).join(" ")} (${num(cells[a][0].meanPips, 2)}p, stop ${num(cells[a][0].medianSlPips, 1)})`).join("  ") + `  n=${cells[0][0].n}`);
}
report.tables = tables;
report.perPair = perPair;
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/qtrend-tp.json`, JSON.stringify(report, null, 1));
