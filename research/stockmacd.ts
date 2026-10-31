// #390 (docs §8.133): the 1-hour MACD email's rule (v8: _shared/macd-level.ts decideZoneOnWindow, the email's own
// code) on US and Japanese shares' hourly bars from Yahoo, each email followed the owner's way (a limit at E, a
// take-profit of 0.1 / 0.25 / 0.5 / 1 percent of E, no stop). The owner (2026-10-31): 「株にも対応してほしい」, the
// stocks' email among it; this is measured first. The rule, the data and the output: research/stockmacd-spec.md.
// The bars are read as the live chart reads them (live-chart/stocks.ts parseYahooChart, rounded as historyOfBars).
//
//   MODE=real       DIR's Yahoo files (written by .github/workflows/stockmacd.yml), OUT/{rows.csv,summary.json}
//   MODE=synthetic  seeded walks written as Yahoo's files under OUT/yahoo (sessions, gaps, missing prices, the
//                   closing point), the study run on them, and the look-ahead check: every email's decision
//                   taken again with every bar after it moved (it must not change). What research/stockmacd-check.py
//                   is run on first.
//   MODE=print      the summary the real run wrote.
//
// Nothing here sends an email; the numbers are the study's only.

import { decideZoneOnWindow, LEVEL_WINDOW } from "../supabase/functions/_shared/macd-level.ts";
import { parseYahooChart, stockDecimals, stockMarketOf } from "../supabase/functions/live-chart/stocks.ts";

export const SYMBOLS = [
  "NVDA", "INTC", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA",
  "7203.T", "6758.T", "9984.T", "8306.T", "6861.T", "9983.T", "8035.T", "7974.T", "9432.T", "6501.T", "7267.T",
  "6920.T", "4063.T", "8058.T",
];
export const SIZES = [0.1, 0.25, 0.5, 1];
const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const END = Date.parse(env("END", "2026-10-31T00:00:00Z"));
const DIR = env("DIR", "research/.cache/yahoo");
const OUT = env("OUT", "research/out/stockmacd");
const HOUR = 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export interface Bar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// the chart's bars (parseYahooChart, then Number(v.toFixed(d)) as historyOfBars), those opening before END
export const barsOf = (sym: string, body: unknown, end: number): Bar[] => {
  const got = parseYahooChart(sym, body, "1h", end);
  if (!got) throw new Error(`${sym}: no bars in Yahoo's answer`);
  const d = stockDecimals(sym);
  const r = (v: number) => Number(v.toFixed(d));
  return got.bars
    .map((c) => ({ t: Date.parse(c.datetime.replace(" ", "T") + "Z"), open: r(c.open), high: r(c.high), low: r(c.low), close: r(c.close) }))
    .filter((b) => b.t < end);
};

export interface Mail {
  sym: string;
  i: number;
  side: "BUY" | "SELL";
  E: number;
}

export const mailsOf = (sym: string, bars: Bar[]): Mail[] => {
  const out: Mail[] = [];
  for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
    const d = decideZoneOnWindow(bars, i);
    if (d) out.push({ sym, i, side: d.side, E: bars[i].close });
  }
  return out;
};

export interface Row {
  sym: string;
  market: string;
  i: number;
  open: number;
  side: "BUY" | "SELL";
  E: number;
  x: number;
  TP: number;
  filled: boolean;
  fillMode: "open" | "limit" | null;
  fillT: number | null;
  F: number | null;
  exitMode: "open" | "limit" | null;
  exitT: number | null;
  exit: number | null;
  held: boolean;
  pct: number | null;
  mae: number | null;
  holdH: number | null;
  holdBars: number | null;
  sameBar: boolean;
}

// the spec's "each email followed, the owner's way"
export const follow = (bars: Bar[], m: Mail, x: number): Row => {
  const dir = m.side === "BUY" ? 1 : -1;
  const E = m.E;
  const TP = E * (1 + dir * x / 100);
  const base: Row = {
    sym: m.sym, market: stockMarketOf(m.sym), i: m.i, open: bars[m.i].t, side: m.side, E, x, TP,
    filled: false, fillMode: null, fillT: null, F: null, exitMode: null, exitT: null, exit: null,
    held: false, pct: null, mae: null, holdH: null, holdBars: null, sameBar: false,
  };
  let f = -1;
  let F = Number.NaN;
  let fillMode: "open" | "limit" = "limit";
  for (let j = m.i + 1; j < bars.length; j++) {
    const b = bars[j];
    if (dir === 1 ? b.open <= E : b.open >= E) {
      f = j;
      F = b.open;
      fillMode = "open";
      break;
    }
    if (dir === 1 ? b.low <= E : b.high >= E) {
      f = j;
      F = E;
      fillMode = "limit";
      break;
    }
  }
  if (f < 0) return base;
  const sameBar = fillMode === "limit" && (dir === 1 ? bars[f].high >= TP : bars[f].low <= TP);
  let ex = -1;
  let exit = Number.NaN;
  let exitMode: "open" | "limit" | null = null;
  for (let k = fillMode === "limit" ? f + 1 : f; k < bars.length; k++) {
    const b = bars[k];
    if (dir === 1 ? b.open >= TP : b.open <= TP) {
      ex = k;
      exit = b.open;
      exitMode = "open";
      break;
    }
    if (dir === 1 ? b.high >= TP : b.low <= TP) {
      ex = k;
      exit = TP;
      exitMode = "limit";
      break;
    }
  }
  const held = ex < 0;
  if (held) {
    ex = bars.length - 1;
    exit = bars[ex].close;
  }
  let worst = Number.NEGATIVE_INFINITY;
  for (let k = f; k <= ex; k++) {
    const adv = dir === 1 ? bars[k].low : bars[k].high;
    const v = dir * (F - adv) / F * 100;
    if (v > worst) worst = v;
  }
  return {
    ...base,
    filled: true,
    fillMode,
    fillT: bars[f].t,
    F,
    exitMode,
    exitT: bars[ex].t,
    exit,
    held,
    pct: dir * (exit - F) / F * 100,
    mae: Math.max(0, worst),
    holdH: (bars[ex].t - bars[f].t) / HOUR,
    holdBars: ex - f,
    sameBar,
  };
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);

export const statsOf = (rows: Row[]) => {
  const filled = rows.filter((r) => r.filled);
  const tp = filled.filter((r) => !r.held);
  const held = filled.filter((r) => r.held);
  const pcts = filled.map((r) => r.pct!);
  return {
    mails: rows.length,
    filled: filled.length,
    unfilled: rows.length - filled.length,
    tp: tp.length,
    held: held.length,
    sameBar: filled.filter((r) => r.sameBar).length,
    gapExits: filled.filter((r) => r.exitMode === "open").length,
    win: filled.length ? (100 * tp.length) / filled.length : null,
    pctSum: filled.length ? sum(pcts) : null,
    pctMean: mean(pcts),
    pctMedian: median(pcts),
    heldPctSum: held.length ? sum(held.map((r) => r.pct!)) : null,
    heldPctMin: min(held.map((r) => r.pct!)),
    maeMedian: median(filled.map((r) => r.mae!)),
    maeMax: max(filled.map((r) => r.mae!)),
    holdMedian: median(filled.map((r) => r.holdH!)),
    holdMax: max(filled.map((r) => r.holdH!)),
  };
};

const HEADER = "sym,market,i,open,side,E,x,TP,filled,fillMode,fillT,F,exitMode,exitT,exit,held,pct,mae,holdH,holdBars,sameBar";
const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
const csvOf = (rows: Row[]) =>
  [
    HEADER,
    ...rows.map((r) =>
      [
        r.sym, r.market, r.i, iso(r.open), r.side, r.E, r.x, r.TP, r.filled, r.fillMode, r.fillT === null ? null : iso(r.fillT), r.F,
        r.exitMode, r.exitT === null ? null : iso(r.exitT), r.exit, r.held, r.pct, r.mae, r.holdH, r.holdBars, r.sameBar,
      ].map(cell).join(",")
    ),
  ].join("\n") + "\n";

export const study = (files: Map<string, unknown>, symbols: string[], end: number) => {
  const rows: Row[] = [];
  const shares = [];
  const barsBy = new Map<string, Bar[]>();
  const mailsBy = new Map<string, Mail[]>();
  for (const sym of symbols) {
    const body = files.get(sym);
    if (body === undefined) throw new Error(`${sym}: no file`);
    const bars = barsOf(sym, body, end);
    const mails = mailsOf(sym, bars);
    barsBy.set(sym, bars);
    mailsBy.set(sym, mails);
    for (const m of mails) for (const x of SIZES) rows.push(follow(bars, m, x));
    shares.push({
      sym,
      market: stockMarketOf(sym),
      bars: bars.length,
      first: bars.length ? iso(bars[0].t) : null,
      last: bars.length ? iso(bars[bars.length - 1].t) : null,
      judged: Math.max(0, bars.length - (LEVEL_WINDOW - 1)),
      mails: mails.length,
      buys: mails.filter((m) => m.side === "BUY").length,
      sells: mails.filter((m) => m.side === "SELL").length,
    });
  }
  const sizes: Record<string, Record<string, ReturnType<typeof statsOf>>> = {};
  for (const x of SIZES) {
    const own = rows.filter((r) => r.x === x);
    const s: Record<string, ReturnType<typeof statsOf>> = {
      all: statsOf(own),
      us: statsOf(own.filter((r) => r.market === "us")),
      jp: statsOf(own.filter((r) => r.market === "jp")),
    };
    for (const sym of symbols) s[sym] = statsOf(own.filter((r) => r.sym === sym));
    sizes[String(x)] = s;
  }
  return { rows, summary: { meta: { end: iso(end), sizes: SIZES, symbols }, shares, sizes }, barsBy, mailsBy };
};

// ---- the synthetic walks, as Yahoo's files ---------------------------------------------------------------------

const mulberry32 = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// weekdays' sessions: New York 13:30-20:00 UTC (7 hourly bars, the last half an hour), Tokyo 00:00-06:30 UTC (7),
// a missing price now and then, a gap between days, and the closing point after the last day's last bar
export const synthYahoo = (sym: string, seed: number, days: number, end: number) => {
  const rnd = mulberry32(seed);
  const jp = sym.endsWith(".T");
  const d = jp ? 1 : 2;
  const t: number[] = [];
  const q = { open: [] as Array<number | null>, high: [] as Array<number | null>, low: [] as Array<number | null>, close: [] as Array<number | null> };
  let p = jp ? 3000 : 200;
  const step = jp ? 6 : 0.6;
  let day = Date.UTC(2023, 0, 2);
  let made = 0;
  let lastDay = 0;
  while (made < days) {
    day += 86_400_000;
    const wd = new Date(day).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (day + 86_400_000 > end) break;
    made++;
    lastDay = day;
    p += (rnd() - 0.5) * step * 6;
    const open0 = day + (jp ? 0 : 13.5 * HOUR);
    for (let h = 0; h < 7; h++) {
      const o = p;
      p = Math.max(1, o + (rnd() - 0.5) * step * 2);
      const hi = Math.max(o, p) + rnd() * step;
      const lo = Math.max(0.5, Math.min(o, p) - rnd() * step);
      const miss = rnd() < 0.01;
      t.push((open0 + h * HOUR) / 1000);
      q.open.push(miss ? null : Number(o.toFixed(d + 3)));
      q.high.push(Number(hi.toFixed(d + 3)));
      q.low.push(Number(lo.toFixed(d + 3)));
      q.close.push(Number(p.toFixed(d + 3)));
    }
  }
  const sessionEnd = (lastDay + (jp ? 6.5 : 20) * HOUR) / 1000;
  t.push(sessionEnd);
  for (const a of [q.open, q.high, q.low, q.close]) a.push(Number(p.toFixed(d)));
  const start = (lastDay + (jp ? 0 : 13.5) * HOUR) / 1000;
  return {
    chart: {
      result: [{
        meta: { symbol: sym, gmtoffset: jp ? 32400 : -14400, regularMarketPrice: p, regularMarketTime: sessionEnd, currentTradingPeriod: { regular: { start, end: sessionEnd } } },
        timestamp: t,
        indicators: { quote: [{ ...q, volume: t.map(() => 1) }] },
      }],
      error: null,
    },
  };
};

const writeOut = async (out: string, rows: Row[], summary: unknown) => {
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(`${out}/rows.csv`, csvOf(rows));
  await Deno.writeTextFile(`${out}/summary.json`, JSON.stringify(summary, null, 1) + "\n");
};

const readFiles = async (dir: string, symbols: string[]) => {
  const files = new Map<string, unknown>();
  for (const sym of symbols) files.set(sym, JSON.parse(await Deno.readTextFile(`${dir}/${sym}.json`)));
  return files;
};

const fmt = (v: number | null, d = 2) => (v === null ? "—" : v.toFixed(d));
const printSummary = (s: ReturnType<typeof study>["summary"]) => {
  console.log(`END ${s.meta.end}`);
  for (const sh of s.shares) {
    console.log(`${sh.sym.padEnd(7)} ${sh.market} bars ${sh.bars} ${sh.first}..${sh.last} judged ${sh.judged} mails ${sh.mails} (buy ${sh.buys}, sell ${sh.sells})`);
  }
  for (const x of s.meta.sizes) {
    const by = s.sizes[String(x)];
    console.log(`\n== TP ${x}% ==`);
    for (const k of ["all", "us", "jp", ...s.meta.symbols]) {
      const a = by[k];
      console.log(
        `${k.padEnd(7)} mails ${a.mails} filled ${a.filled} unfilled ${a.unfilled} tp ${a.tp} held ${a.held} win ${fmt(a.win)}% ` +
          `pct sum ${fmt(a.pctSum)} mean ${fmt(a.pctMean, 3)} median ${fmt(a.pctMedian, 3)} held sum ${fmt(a.heldPctSum)} worst ${fmt(a.heldPctMin)} ` +
          `mae med ${fmt(a.maeMedian)} max ${fmt(a.maeMax)} hold med ${fmt(a.holdMedian, 1)}h max ${fmt(a.holdMax, 0)}h sameBar ${a.sameBar} gap ${a.gapExits}`,
      );
    }
  }
};

if (import.meta.main) {
  if (MODE === "synthetic") {
    const syms = ["AAPL", "INTC", "7203.T"];
    const files = new Map<string, unknown>();
    await Deno.mkdir(`${OUT}/yahoo`, { recursive: true });
    syms.forEach((s, k) => files.set(s, synthYahoo(s, 11 + k, 320, END)));
    for (const [s, body] of files) await Deno.writeTextFile(`${OUT}/yahoo/${s}.json`, JSON.stringify(body));
    const r = study(files, syms, END);
    // the look-ahead check: each email's decision with every bar after it moved by up to ±5%
    const rnd = mulberry32(99);
    let checked = 0;
    for (const s of syms) {
      const bars = r.barsBy.get(s)!;
      for (const m of r.mailsBy.get(s)!) {
        const moved = bars.map((b, j) => {
          if (j <= m.i) return b;
          const k = 1 + (rnd() - 0.5) * 0.1;
          return { ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k };
        });
        const d = decideZoneOnWindow(moved, m.i);
        if (!d || d.side !== m.side) throw new Error(`look-ahead: ${s} bar ${m.i} changed`);
        checked++;
      }
    }
    const mails = [...r.mailsBy.values()].reduce((a, b) => a + b.length, 0);
    if (mails < 20) throw new Error(`too few synthetic emails to check: ${mails}`);
    // the counts add up
    for (const x of SIZES) {
      const a = r.summary.sizes[String(x)].all;
      if (a.mails !== mails || a.filled + a.unfilled !== a.mails || a.tp + a.held !== a.filled) throw new Error(`counts do not add up at ${x}`);
    }
    await writeOut(OUT, r.rows, r.summary);
    console.log(`synthetic: ${syms.join(",")} emails ${mails}, look-ahead checked ${checked}, rows ${r.rows.length} -> ${OUT}`);
  } else if (MODE === "real") {
    const files = await readFiles(DIR, SYMBOLS);
    const r = study(files, SYMBOLS, END);
    await writeOut(OUT, r.rows, r.summary);
    console.log(`real: rows ${r.rows.length} -> ${OUT}`);
  } else if (MODE === "print") {
    printSummary(JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`)));
  } else {
    throw new Error(`MODE ${MODE}?`);
  }
}
