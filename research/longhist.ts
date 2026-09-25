// Does following the daily trend, or collecting the interest-rate
// differential, pay over 25 years of currencies? (#109)
//
// See longhist-lib.ts for why. THE METHOD, fixed before any data was read:
//
//   * Prices: the ECB's daily reference rates since 1999-01-04, crossed into
//     the eleven pairs GMO serves (the app's seven among them). One fixing a
//     day, so these are daily rules held for weeks, not intraday timing.
//   * Rates: FRED's OECD 3-month interbank rates, monthly, one month late
//     (what a position could have known), for the carry. When FRED does not
//     answer for all eight currencies, the BIS's monthly central bank
//     policy rates for all eight instead (never a mix of the two).
//   * Rules (longhist-lib.ts): 12-month momentum, price vs its 200-day
//     average, 50-day vs 200-day average, 55/20-day breakout. Carry: long the
//     higher-yielding currency; carry+trend: the same only when the 200-day
//     rule agrees, flat otherwise.
//   * Every position is scaled to 10% annual volatility on the last 60 days,
//     pays a 1-pip spread on every full change, and — in the "with swap"
//     columns — earns or pays the rate differential less 0.5% a year to the
//     broker, per calendar day held.
//   * THE RULE: the trend rule is chosen on 1999-2012 (Sharpe of the equal-
//     weight portfolio of all pairs, no swap) and judged untouched on 2013
//     onward. Carry has nothing to choose.
//   * Luck: twenty placebo portfolios of random positions that change about
//     every 60 days, scaled and charged the same way.

import { GMO_SYMBOLS } from "../supabase/functions/track-outcomes/quotes.ts";
import {
  TREND_RULES,
  crossSeries,
  ma200,
  parseBisPolicy,
  parseEcb,
  parseFred,
  placebo,
  portfolio,
  rateBefore,
  simulate,
  statsOf,
  type Daily,
  type Stats,
} from "./longhist-lib.ts";

const CACHE = "research/.cache";
const OUT = "research/out";
const SPLIT = Deno.env.get("SPLIT") || "2013-01-01";
const START = "1999-01-01";
const END = "2100-01-01";
const TARGET_VOL = 0.1;
const SPREAD_PIPS = 1;
const HAIRCUT = 0.5;
const PLACEBOS = 20;

const FRED_IDS: Record<string, string> = {
  USD: "IR3TIB01USM156N",
  JPY: "IR3TIB01JPM156N",
  EUR: "IR3TIB01EZM156N",
  GBP: "IR3TIB01GBM156N",
  AUD: "IR3TIB01AUM156N",
  NZD: "IR3TIB01NZM156N",
  CAD: "IR3TIB01CAM156N",
  CHF: "IR3TIB01CHM156N",
};
// the BIS's reference areas for the same currencies (XM: the euro area)
const BIS_AREAS: Record<string, string> = { USD: "US", JPY: "JP", EUR: "XM", GBP: "GB", AUD: "AU", NZD: "NZ", CAD: "CA", CHF: "CH" };

const log = (s = "") => console.log(s);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const f2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(2));
const row = (label: string, s: Stats | null) =>
  s
    ? `${label.padEnd(30)} Sharpe ${f2(s.sharpe).padStart(5)} | ${pct(s.annRet).padStart(6)}/yr vol ${pct(s.annVol)} | max DD ${pct(s.maxDD)} | worst month ${pct(s.worstMonth)} | years up ${s.yearsUp}/${s.years}`
    : `${label.padEnd(30)} n/a`;

const synthetic = (): { ecb: Map<string, Map<string, number>>; fred: Record<string, Array<[string, number]>> } => {
  let s = 7;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const ecb = new Map<string, Map<string, number>>();
  const curs = ["USD", "JPY", "GBP", "AUD", "NZD", "CAD", "CHF"];
  const start = Date.parse("1999-01-04T00:00:00Z");
  for (const c of curs) {
    const m = new Map<string, number>();
    let v = c === "JPY" ? 130 : 1.2;
    for (let k = 0; k < 9800; k++) {
      const d = new Date(start + k * 86_400_000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      v *= Math.exp((rnd() - 0.5) * 0.012);
      m.set(d.toISOString().slice(0, 10), v);
    }
    ecb.set(c, m);
  }
  const fred: Record<string, Array<[string, number]>> = {};
  for (const c of [...curs, "EUR"]) {
    const rows: Array<[string, number]> = [];
    for (let y = 1998; y <= 2026; y++) for (let mo = 1; mo <= 12; mo++) rows.push([`${y}-${String(mo).padStart(2, "0")}-01`, 2]);
    fred[c] = rows;
  }
  return { ecb, fred };
};

const main = async () => {
  const t0 = Date.now();
  let ecb: Map<string, Map<string, number>>;
  const fred: Record<string, Array<[string, number]>> = {};
  let source = "FRED 3-month interbank";
  if (Deno.env.get("SYNTHETIC")) {
    const s = synthetic();
    source = "synthetic";
    ecb = s.ecb;
    Object.assign(fred, s.fred);
  } else {
    ecb = parseEcb(await Deno.readTextFile(`${CACHE}/ecb/eurofxref-hist.csv`));
    for (const [cur, id] of Object.entries(FRED_IDS)) {
      try {
        fred[cur] = parseFred(await Deno.readTextFile(`${CACHE}/fred/${id}.csv`));
      } catch {
        fred[cur] = [];
      }
    }
    if (Object.values(fred).some((rows) => rows.length < 12)) {
      source = "BIS policy rates";
      let csv = "";
      try {
        for await (const e of Deno.readDir(`${CACHE}/bis`)) {
          if (e.isFile && e.name.toLowerCase().endsWith(".csv")) csv = await Deno.readTextFile(`${CACHE}/bis/${e.name}`);
        }
      } catch {
        csv = "";
      }
      const bis = parseBisPolicy(csv, Object.values(BIS_AREAS));
      for (const [cur, area] of Object.entries(BIS_AREAS)) fred[cur] = bis[area] ?? [];
    }
  }
  log(`# research/longhist.ts  split=${SPLIT}  target vol ${pct(TARGET_VOL, 0)}  spread ${SPREAD_PIPS} pip  swap haircut ${HAIRCUT}%/yr`);
  log(`rates from: ${source}`);
  for (const [cur, rows] of Object.entries(fred)) {
    log(`rates ${cur}: ${rows.length} months ${rows[0]?.[0] ?? "-"} .. ${rows[rows.length - 1]?.[0] ?? "-"}`);
  }

  const pairs = Object.keys(GMO_SYMBOLS);
  const data: Record<string, Daily> = {};
  for (const pair of pairs) {
    const [b, q] = pair.split("/");
    const d = crossSeries(ecb, b, q);
    if (d.px.length < 1000) {
      log(`${pair}: too short (${d.px.length})`);
      continue;
    }
    data[pair] = d;
    log(`${pair}: ${d.px.length} days ${d.dates[0]} .. ${d.dates[d.dates.length - 1]}`);
  }
  const pipOf = (pair: string) => (pair.endsWith("JPY") ? 0.01 : 0.0001);
  const diffOf = (pair: string, d: Daily) => {
    const [b, q] = pair.split("/");
    const rb = fred[b] ?? [];
    const rq = fred[q] ?? [];
    return (t: number): number | null => {
      const x = rateBefore(rb, d.dates[t]);
      const y = rateBefore(rq, d.dates[t]);
      return x === null || y === null ? null : x - y;
    };
  };

  type Leg = { pair: string; dates: string[]; pnl: number[]; skip?: boolean[]; turnover: number };
  const run = (name: string, posOf: (pair: string, d: Daily) => number[], withCarry: boolean): Leg[] =>
    Object.entries(data).map(([pair, d]) => {
      const pos = posOf(pair, d);
      const sim = simulate(d, pos, {
        pip: pipOf(pair),
        spreadPips: SPREAD_PIPS,
        targetVol: TARGET_VOL,
        carry: withCarry ? diffOf(pair, d) : undefined,
        haircut: HAIRCUT,
      });
      void name;
      return { pair, dates: d.dates, pnl: sim.pnl, skip: withCarry ? sim.carryKnown.map((k) => !k) : undefined, turnover: sim.turnover };
    });
  const pstats = (legs: Leg[], from: string, to: string) => {
    const p = portfolio(legs);
    return statsOf(p.dates, p.pnl, from, to, p.skip);
  };
  const tradesPerYear = (legs: Leg[]) => {
    const years = legs.reduce((a, l) => a + l.dates.length / 252, 0);
    return legs.reduce((a, l) => a + l.turnover, 0) / years / 2;
  };

  // 1. trend rules, no swap
  log(`\n# 1. Trend rules, equal-weight portfolio of ${Object.keys(data).length} pairs, no swap`);
  const results: Record<string, { a: Stats | null; b: Stats | null; legs: Leg[] }> = {};
  for (const [name, rule] of Object.entries(TREND_RULES)) {
    const legs = run(name, (_p, d) => rule(d.px), false);
    const a = pstats(legs, START, SPLIT);
    const b = pstats(legs, SPLIT, END);
    results[name] = { a, b, legs };
    log(row(`${name} 1999-${SPLIT.slice(0, 4)}`, a));
    log(row(`${name} ${SPLIT.slice(0, 4)}-`, b) + `  (~${tradesPerYear(legs).toFixed(1)} position turns/yr/pair)`);
  }
  const winner = Object.entries(results).filter(([, r]) => r.a).sort((x, y) => y[1].a!.sharpe - x[1].a!.sharpe)[0]?.[0] ?? null;
  log(`WINNER (first period): ${winner}`);

  // 2. luck
  const placeboB: number[] = [];
  const placeboA: number[] = [];
  for (let k = 0; k < PLACEBOS; k++) {
    const legs = run(`placebo${k}`, (pair, d) => placebo(d.px.length, 1 / 60, 1000 * k + pair.length * 7 + pair.charCodeAt(0)), false);
    const a = pstats(legs, START, SPLIT);
    const b = pstats(legs, SPLIT, END);
    if (a) placeboA.push(a.sharpe);
    if (b) placeboB.push(b.sharpe);
  }
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : Number.NaN;
  };
  log(`\n# 2. Luck: ${PLACEBOS} random portfolios (same scaling, spread, ~60-day holds)`);
  log(`Sharpe 1st period: median ${f2(q(placeboA, 0.5))}, 95th pct ${f2(q(placeboA, 0.95))} | 2nd period: median ${f2(q(placeboB, 0.5))}, 95th pct ${f2(q(placeboB, 0.95))}`);

  // 3. the winner, second period, per pair
  if (winner) {
    log(`\n# 3. ${winner}, second period (${SPLIT} on), per pair, no swap`);
    let up = 0;
    for (const leg of results[winner].legs) {
      const s = statsOf(leg.dates, leg.pnl, SPLIT, END);
      if (s && s.sharpe > 0) up++;
      log(row(`  ${leg.pair}`, s));
    }
    log(`  pairs with a positive Sharpe: ${up}/${results[winner].legs.length}`);
  }

  // 4. swap: carry, carry + trend, and every trend rule with its swap
  log(`\n# 4. With swap (rate differential less ${HAIRCUT}%/yr, per calendar day held); days without a known rate left out`);
  const carryLegs = run("carry", (pair, d) => {
    const diff = diffOf(pair, d);
    return d.px.map((_, t) => {
      const x = diff(t);
      return x === null ? 0 : Math.sign(x);
    });
  }, true);
  log(row("carry 1999-" + SPLIT.slice(0, 4), pstats(carryLegs, START, SPLIT)));
  log(row("carry " + SPLIT.slice(0, 4) + "-", pstats(carryLegs, SPLIT, END)));
  const ctLegs = run("carry_trend", (pair, d) => {
    const diff = diffOf(pair, d);
    const tr = ma200(d.px);
    return d.px.map((_, t) => {
      const x = diff(t);
      if (x === null) return 0;
      const c = Math.sign(x);
      return c !== 0 && c === tr[t] ? c : 0;
    });
  }, true);
  log(row("carry+trend 1999-" + SPLIT.slice(0, 4), pstats(ctLegs, START, SPLIT)));
  log(row("carry+trend " + SPLIT.slice(0, 4) + "-", pstats(ctLegs, SPLIT, END)));
  for (const [name, rule] of Object.entries(TREND_RULES)) {
    const legs = run(name, (_p, d) => rule(d.px), true);
    log(row(`${name}+swap 1999-${SPLIT.slice(0, 4)}`, pstats(legs, START, SPLIT)));
    log(row(`${name}+swap ${SPLIT.slice(0, 4)}-`, pstats(legs, SPLIT, END)));
  }
  // the carry unwinds the app's users would remember
  const month = (legs: Leg[], m: string) => {
    const p = portfolio(legs);
    let s = 0;
    for (let t = 0; t < p.dates.length; t++) if (p.dates[t].startsWith(m) && !p.skip[t]) s += p.pnl[t];
    return s;
  };
  log(`carry in 2008-10: ${pct(month(carryLegs, "2008-10"))}, 2024-08: ${pct(month(carryLegs, "2024-08"))} | carry+trend in 2008-10: ${pct(month(ctLegs, "2008-10"))}, 2024-08: ${pct(month(ctLegs, "2024-08"))}`);

  await Deno.mkdir(OUT, { recursive: true });
  await Deno.writeTextFile(
    `${OUT}/longhist.json`,
    JSON.stringify({ split: SPLIT, winner, trend: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { a: v.a, b: v.b }])), placeboA, placeboB }),
  );
  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
};

if (import.meta.main) await main();
