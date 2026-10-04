// #188: 資金管理と同時に持つ数の上限 — had every email of the 4-hour Q-Trend
// and ULTRA signals been taken, what the account would have done, and how
// many trades were open together. Research only: nothing in the app reads this.
//
// THE MEASURE is docs §8.99, fixed before any data is read (fab8c37); the
// programs' shared names, files and tolerances are in the interface written
// with it. This file runs it; its parts:
//   * research/money-data.ts: the bars (GMO's files, the walks, a fixture) and
//     the settings;
//   * research/money-trades.ts: the trades (#187's 3,958 of CALL9 at the
//     email's levels now, the stop 13 and TP1 4), each variant followed, the
//     union grid G and every trade's path on it; the trade-level numbers;
//   * research/money-stats.ts: the intervals (#187's);
//   * research/money-account.ts: the account (part 2): one engine for every
//     cell and told row (sizing, caps, margin, loss-cut, calls, the order in
//     a 5-minute bar), each run's numbers, E*, the account's identities;
//   * research/money-cells.ts: the 25 cells and the told rows run, checked,
//     printed and written (money-ledger-<key>.csv);
//   * research/money-fixture.ts: FIXTURE=<dir>, its runs against the hand
//     calculation's expectations;
//   * research/money-boot.ts: the weeks rearranged (part 3): the path cut into
//     its weeks and laid down in another order, a new clock and new legs;
//   * research/money-extras.ts: part 3 run and printed: E* in 52-week windows,
//     the 20 orders of one close's emails, the kept and the skipped, the
//     thinning, the weeks rearranged's bands; the owner's table.
//
// Runs (interface.md):
//   (the data)        END fixed; on GitHub's runners only (GMO's API). Gates:
//                     #187's 3,958 trades (each pair's, each half's); every check 0.
//   LEVELS=old        the same trades at the stop 30 and TP1 20 (#187's now):
//                     the three means only (on the data −0.6018, −0.8298, −0.7117).
//   SYNTHETIC=1       the walks: SEED, SYNTH path|wicks|drift|against, DRIFT
//                     (pips a 5-minute bar, 0.10), DUMPDIR (the walk as GMO's files).
//   FIXTURE=<dir>     a hand example: only <dir>/gmo/, <dir>/signals.csv and
//                     <dir>/fixture.json; its runs against its expectations, PASS
//                     or FAIL (exit 1); with PLANT set, a fixture listing it must FAIL.
//   OUTDIR            where the files go (research/out).
//   BOOT, THIN        the rearrangements of each kind (1,000) and the thinning's
//                     draws (200), §8.99's; a test may ask for fewer (0: none).
//   PLANT             a planted error (interface.md §8): the run is made with it,
//                     nothing else printed; research/money-seeds.py --plants
//                     counts what it changed against a clean run.

import { configFromEnv } from "./money-data.ts";
import { C3, CALL9, type Check, VARIANTS, WANT, admissionOrder, bookOf, concurrencyOf, holdOn, iso, loadStudy, newCheck, rakutenSpread, type Signal, statsOf, tally, type Trade, type TradeStats } from "./money-trades.ts";
import { HOUR, MINUTE } from "./lib.ts";
import { runFixture, type TradeRow } from "./money-fixture.ts";
import { runAccountPart } from "./money-cells.ts";
import { runExtras } from "./money-extras.ts";
import { clustered, statOf } from "./money-stats.ts";

const started = performance.now();
const cfg = configFromEnv();
// §8.99: the report's first line (the study's run; not the repro's, which
// prints its three means only, nor a hand example's)
if (cfg.levels === "new" && !cfg.fixture) console.log(`The 8 FX pairs not measured, and TRY/JPY, ZAR/JPY and MXN/JPY (in the 12-pair told row only) — 11 FX pairs in all — mail the same account: the trades open together, the margin and E* come out LOW here.`);
const study = await loadStudy(cfg);
const { signals, checks } = study;
const call9 = signals.filter((s) => s.group === "CALL9");
const c3 = signals.filter((s) => s.group === "C3");

const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${(100 * x).toFixed(d)}%`);
const checkLine = (what: string, c: Check) => `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
const halfOf = (xs: Signal[], h: 0 | 1) => xs.filter((s) => s.half === h).length;

console.log(`\n#188 the trades (docs §8.99) on 4 hours, ${cfg.start} .. ${iso(cfg.now)} (first half before ${cfg.split})${cfg.synthetic ? ` — SYNTHETIC (${cfg.synth}${cfg.drift ? `, ${cfg.drift} pip a 5-minute bar the signal's way` : ""}), seed ${cfg.seed}` : ""}${cfg.fixture ? ` — FIXTURE ${cfg.fixture}` : ""}${cfg.plant ? ` — PLANTED ${cfg.plant}` : ""}; ${cfg.levels === "old" ? "LEVELS=old: the stop 30, TP1 20" : "the stop 13, TP1 4 (TP2 10, TP3 16)"}`);

// ---- the gates: #187's trades again (the data's run only) ------------------------------------

const perPair = CALL9.map((p) => call9.filter((s) => s.pair === p).length);
const halves = [halfOf(call9, 0), halfOf(call9, 1)];
const real = !cfg.synthetic && !cfg.fixture;
const sameCount = call9.length === WANT.n && perPair.every((x, k) => x === WANT.perPair[k]) && halves.every((x, k) => x === WANT.halves[k]);
console.log(`trades (CALL9): ${call9.length} (${CALL9.map((p, k) => `${p} ${perPair[k]}`).join(", ")}; halves ${halves.join("/")}); #187's ${WANT.n} (${WANT.perPair.join("/")}; ${WANT.halves.join("/")}): ${real ? (sameCount ? "THE SAME" : "NOT THE SAME") : "not checked (not the data)"}`);
console.log(`C3 (the 12-pair row only): ${c3.length} (${C3.map((p) => `${p} ${c3.filter((s) => s.pair === p).length}`).join(", ")})`);
for (const c of study.cover) console.log(`  ${c.pair.padEnd(8)} 4-hour bars ${c.bars}, judged ${c.judged}, signals ${c.signals}, trades ${c.trades}; left out by #187's exclusions: no N or A ${c.noNA}, a rule not followed to its end ${c.unheld}; GMO failed ${c.failed}`);

// ---- LEVELS=old: #187's now, the three means, nothing else -----------------------------------

const baseChecks = (): Record<string, Check> => (cfg.fixture ? { fixture: checks.fixture, closes: checks.closes } : { signals: checks.signals, levels: checks.levels, closes: checks.closes });
if (cfg.levels === "old") {
  const mean = (xs: Signal[]) => (xs.length ? xs.reduce((a, s) => a + s.oldPips!, 0) / xs.length : Number.NaN);
  const got = [mean(call9.filter((s) => s.half === 0)), mean(call9.filter((s) => s.half === 1)), mean(call9)];
  const same = got.every((m, k) => Number(m.toFixed(4)) === WANT.old[k]);
  const differ = Object.values(baseChecks()).reduce((a, c) => a + c.mismatched, 0) + study.failedReads;
  console.log(checkLine("(a) signals against indicatorSignals", checks.signals));
  console.log(checkLine("(a2) the email's close, stop and targets against 13 and 4/10/16", checks.levels));
  console.log(`(g) GMO reads that failed: ${study.failedReads}`);
  console.log(`\n== #187's NOW AGAIN (the stop 30, TP1 20, the same trades), pips a trade: first half ${got[0].toFixed(4)}, second half ${got[1].toFixed(4)}, the whole period ${got[2].toFixed(4)}; #187's ${WANT.old.map((x) => x.toFixed(4)).join(", ")}: ${real ? (same ? "THE SAME" : "NOT THE SAME") : "not checked (not the data)"}`);
  if (real && (!same || !sameCount || differ !== 0)) Deno.exit(1);
  Deno.exit(0);
}

// ---- the checks of the trades ---------------------------------------------------------------

const grid9 = study.grids.CALL9!;
const gridFor = (s: Signal) => (s.group === "CALL9" ? grid9 : study.grids.P12!);
const more = {
  usdjpy: newCheck(), // (u) USD/JPY's 5-minute bars through the dollar pairs' trades
  paths: newCheck(), // (p) each path on G: its length, its end at x, its marks
  identity: newCheck(), // (c) Σ hold_grid = Σ the trades open at each g
};
// (u) a dollar pair's trade is marked in yen at USD/JPY's mid: at T and at
// each g it is held where its own pair has a bar, USD/JPY's last bar is at
// most 12 closes of G old — an hour of the market's own time: a weekend or a
// holiday shut has no closes, so USD/JPY's week opening a bar after the
// dollar pair's is 1 close old, not two days (§8.99 足が無い時刻: a shorter
// gap is carried forward and counted; a longer one fails the data's run)
const USD_MAX_CLOSES = 12;
let usdStale = 0;
let usdStaleMax = 0;
const books = VARIANTS.map((v) => bookOf(study, v, "CALL9"));
for (const book of books) {
  const g = book.grid.g;
  const U = book.grid.usd;
  for (const t of book.trades) {
    if (t.exit === "passed") continue;
    // (p) the path: (t0, x] on G, the last mark its exit bar's close (moved)
    const buy = t.sig.dir === 1;
    const end = t.hold > 0 ? t.mark[t.hold - 1] : Number.NaN;
    const want = (buy ? t.book.bc[t.fx] : t.book.ac[t.fx]) + t.mu * (t.fx - t.f0 + 1);
    const ok = t.hold === holdOn(book.grid, t.t0, t.x) && g[t.giX] === t.x && g[t.gi0] > t.t0 && (t.gi0 === 0 || g[t.gi0 - 1] <= t.t0) && Math.abs(end - want) <= 1e-12 && t.mark.every(Number.isFinite) && t.worst.every(Number.isFinite);
    tally(more.paths, ok, () => `${t.sig.id} ${book.variant}: hold ${t.hold}, gi ${t.gi0}..${t.giX}, end ${end}/${want}`);
    if (!t.pd.usd || book.variant !== "main") continue;
    for (const gi of [book.giAt(t.sig.T), ...Array.from({ length: t.hold }, (_, k) => t.gi0 + k)]) {
      if (gi !== book.giAt(t.sig.T) && !book.grid.own[t.pi][gi]) continue;
      const f = book.grid.last[U][gi];
      const pdU = study.pairs.get("USD/JPY")!;
      const lastEnd = f >= 0 ? pdU.fine.t[f] + 5 * MINUTE : Number.NaN;
      // the closes of G after USD/JPY's last bar's end, up to this g (0: its own bar ends here)
      const age = f >= 0 ? gi - book.giAt(lastEnd) : Infinity;
      if (age > 0) usdStale++;
      usdStaleMax = Math.max(usdStaleMax, age);
      tally(more.usdjpy, age <= USD_MAX_CLOSES, () => `${t.sig.id} at ${iso(g[gi])}: USD/JPY's last bar ${Number.isFinite(age) ? `${age} closes of G (${(g[gi] - lastEnd) / MINUTE} minutes)` : "none"} old`);
    }
  }
}
const mainBook = books[0];
const conc = concurrencyOf(grid9, study.trades.main.filter((t) => t.sig.group === "CALL9"));
const holdSum = mainBook.trades.reduce((a, t) => a + t.hold, 0);
tally(more.identity, holdSum === conc.sum_all_g, () => `Σ hold_grid ${holdSum} / Σ open ${conc.sum_all_g}`);
const pathStale = mainBook.trades.reduce((a, t) => a + t.stale, 0);

const allChecks = { ...baseChecks(), placement: checks.placement, ...more };
for (const [k, c] of Object.entries(allChecks)) console.log(checkLine(k, c));
console.log(`(g) GMO reads that failed: ${study.failedReads}`);
const differ = Object.values(allChecks).reduce((a, c) => a + c.mismatched, 0) + study.failedReads;
console.log(differ === 0 ? "EVERY CHECK 0 DIFFER" : `CHECKS DIFFER (${differ}): the numbers below are not to be read`);
console.log(`G (CALL9): ${grid9.g.length} closes, ${iso(grid9.g[0])} .. ${iso(grid9.g[grid9.g.length - 1])}${study.grids.P12 ? `; G (12 pairs): ${study.grids.P12.g.length}` : ""}. Carried forward on the main trades' paths (its pair without a bar at that g): ${pathStale} of ${holdSum}; USD/JPY's at the dollar pairs' times: ${usdStale} (at most ${usdStaleMax} closes of G old; the data's run fails past ${USD_MAX_CLOSES})`);

// ---- FIXTURE: the hand example's runs against its expectations (interface.md §6) ------------

// the trades table (money-trades.csv, interface.md §4.2): a row a signal and
// variant; hold_grid, cal_ms, weekend and nights_ny all from T (a late
// trade's too); a late trade not in (a level passed) without its exit's
// columns. Times in ms here, written as ISO; a fixture's expect_trades rows
// are compared with these (decisions R7)
const TRADE_COLS = ["id", "variant", "fill", "mid_close", "sl", "tp", "entry_g", "exit_kind", "exit_open", "x", "exit_px", "pips", "hold_grid", "cal_ms", "weekend", "nights_ny"] as const;
const TRADE_TIMES = new Set<string>(["entry_g", "exit_open", "x"]);
const tradeTable = (): TradeRow[] => {
  const rows: TradeRow[] = [];
  for (let k = 0; k < signals.length; k++) {
    for (const v of VARIANTS) {
      const t = study.trades[v][k];
      const out = t.exit !== "passed";
      const ifOut = (x: number) => (out ? x : null);
      rows.push({ id: t.sig.id, variant: v, fill: t.fill, mid_close: t.sig.close, sl: t.sl, tp: t.tp, entry_g: t.entryG, exit_kind: t.exit, exit_open: ifOut(t.exitOpen), x: ifOut(t.x), exit_px: ifOut(t.exitPx), pips: ifOut(t.pips), hold_grid: out ? holdOn(gridFor(t.sig), t.sig.T, t.x) : null, cal_ms: ifOut(t.calMs), weekend: ifOut(t.weekend), nights_ny: ifOut(t.nightsNy) });
    }
  }
  return rows;
};
const writeTables = async (trades: TradeRow[]) => {
  await Deno.mkdir(cfg.out, { recursive: true });
  const sigRows = signals.map((s) => [s.id, s.pair, s.group, iso(s.barOpen), iso(s.T), s.side, s.rules].join(","));
  await Deno.writeTextFile(`${cfg.out}/money-signals.csv`, ["id,pair,group,bar_open,T,side,rules", ...sigRows].join("\n") + "\n");
  const cell = (c: string, x: string | number | null) => (x === null ? "" : TRADE_TIMES.has(c) ? iso(x as number) : String(x));
  const rows = trades.map((r) => TRADE_COLS.map((c) => cell(c, r[c])).join(","));
  await Deno.writeTextFile(`${cfg.out}/money-trades.csv`, [TRADE_COLS.join(","), ...rows].join("\n") + "\n");
};
if (cfg.fixture) {
  const trades = tradeTable();
  await writeTables(trades);
  console.log(`\nFIXTURE: ${signals.length} signals followed (money-trades.csv in ${cfg.out})`);
  const fx = await runFixture(study, cfg, trades);
  // a hand example is not the data: the data's gates (the count, the repro,
  // USD/JPY's bars at most 12 closes of G old) are told, not judged (interface.md §6)
  const fxDiffer = Object.entries(allChecks).reduce((a, [k, c]) => a + (k === "usdjpy" ? 0 : c.mismatched), 0) + study.failedReads;
  if (allChecks.usdjpy?.mismatched) console.log(`  (usdjpy: ${allChecks.usdjpy.mismatched} of ${allChecks.usdjpy.compared} past ${USD_MAX_CLOSES} closes of G old: told, not judged in a fixture)`);
  const ok = fx.pass && fxDiffer === 0;
  await Deno.writeTextFile(`${cfg.out}/money.json`, JSON.stringify({ meta: { fixture: cfg.fixture, plant: cfg.plant || null }, checks: { ...allChecks, ...fx.checks }, fixture: fx.results, pass: ok }));
  console.log(ok ? "FIXTURE PASS" : `FIXTURE FAIL${fxDiffer ? ` (the trades' checks differ: ${fxDiffer})` : ""}`);
  Deno.exit(ok ? 0 : 1);
}

// ---- the trades' numbers (§8.99 出すもの 取引ごと) ---------------------------------------------

const ofGroup = (v: (typeof VARIANTS)[number], g: "CALL9" | "C3" | "P12") => study.trades[v].filter((t) => g === "P12" || t.sig.group === g);
const half = (ts: Trade[], h: 0 | 1) => ts.filter((t) => t.sig.half === h);
const main = ofGroup("main", "CALL9");
const stats = {
  main: statsOf(main, grid9, cfg.plant),
  halves: [statsOf(half(main, 0), grid9, cfg.plant), statsOf(half(main, 1), grid9, cfg.plant)],
  variants: Object.fromEntries(VARIANTS.filter((v) => v !== "main").map((v) => [v, statsOf(ofGroup(v, "CALL9"), grid9, cfg.plant)])) as Record<string, TradeStats>,
  coin: statsOf(study.coin, grid9),
  coinHalves: [statsOf(half(study.coin, 0), grid9), statsOf(half(study.coin, 1), grid9)],
  p12: study.grids.P12 ? statsOf(ofGroup("main", "P12"), study.grids.P12, cfg.plant) : null,
};
// the share of trades in at Rakuten's advertised spread (the rest at GMO's, §8.99)
const rakutenShare = main.length ? main.filter((t) => rakutenSpread(t.sig.pair, t.sig.T) !== null).length / main.length : null;
const nightsOut = (t: Trade) => [16, 20].includes(new Date(t.sig.T).getUTCHours());
const noNights = statsOf(main.filter((t) => !nightsOut(t)), grid9, cfg.plant);

// the intervals printed (§8.99: the program counts them): a line's five
// (pips and yen by week and by four weeks, the year's yen)
let tradeIntervals = 0;
const line = (name: string, s: TradeStats) => {
  tradeIntervals += 5;
  return [
    `  ${name.padEnd(18)} ${String(s.n).padStart(5)} trades${s.passed ? ` (and ${s.passed} not in: a level passed before the fill)` : ""}. WIN RATE (TP1 first of all) ${pct(s.win_all)}, of those ended ${pct(s.win_resolved)}; timed out ${pct(s.time_share)} (those ${num(s.time_mean, 1)} pips). ${num(s.mean_pips)} pips a trade [${num(s.ci_week[0])},${num(s.ci_week[1])}] (4 wk [${num(s.ci_4wk[0])},${num(s.ci_4wk[1])}]), median ${num(s.median_pips, 1)}, R ${num(s.mean_r, 3)}`,
    `  ${"".padEnd(18)} ¥ a trade at 10,000 units ${num(s.mean_yen, 0)} [${num(s.yen_ci_week[0], 0)},${num(s.yen_ci_week[1], 0)}] (4 wk [${num(s.yen_ci_4wk[0], 0)},${num(s.yen_ci_4wk[1], 0)}]); a year (${num(s.per_year, 0)} trades) ${num(s.yen_year, 0)} (${num(s.yen_year_low, 0)} to ${num(s.yen_year_high, 0)}); avg win ${num(s.avg_win, 1)}, avg loss ${num(s.avg_loss, 1)}, worst ${num(s.worst_pips, 1)} (R ${num(s.worst_r, 2)}); out past the stop at an open ${s.gap_n}${s.gap_n ? ` (those ${num(s.gap_mean, 1)})` : ""}; spread paid ${num(s.spread_median, 2)} pips (median)`,
  ];
};
console.log(`\n== THE TRADES: CALL9, the emails' signals (one a bar and side), in at the close; pips with the spread; 95% intervals by week and by four weeks (#187's)`);
for (const l of line("main (TP1 whole)", stats.main)) console.log(l);
for (const h of [0, 1] as const) for (const l of line(h === 0 ? "  first half" : "  second half", stats.halves[h])) console.log(l);
for (const v of ["tp2", "tp3", "late", "rakuten"]) for (const l of line(v, stats.variants[v])) console.log(l);
console.log(`  late: ${stats.variants.late.passed} not in (a level passed before the fill), spread paid ${num(stats.variants.late.spread_median)} pips (median); rakuten: ${pct(rakutenShare)} of the trades in at Rakuten's advertised spread; the nights (16:00 and 20:00 UTC) left out: ${noNights.n} trades, spread paid ${num(noNights.spread_median)} pips (median)`);
for (const l of line("the coin", stats.coin)) console.log(l);
console.log(`  the signals' TP1 first less the coin's: ${num(100 * ((stats.main.win_all ?? 0) - (stats.coin.win_all ?? 0)), 1)} points; the coin's trades ${stats.coin.n} (#187's coin had ${WANT.coin}, its own levels: ${real ? (stats.coin.n === WANT.coin ? "the same count" : "NOT the same count") : "not checked"})`);
if (stats.p12) for (const l of line("12 pairs (p12)", stats.p12)) console.log(l);

// the premise (§8.99 前提の1行): is the 9 pairs' mean a trade below 0? On the
// higher of the high ends by week and by four weeks; the halves beside
const below = [stats.main, ...stats.halves].map((s) => ({ high: s.high_end, below: s.high_end !== null && s.high_end < 0 }));
console.log(`\n== BELOW 0? the 9 pairs at 13 and 4, a trade, the higher high end (by week, by four weeks): the whole period ${num(below[0].high)} → ${below[0].below ? "YES" : "not shown"}; first half ${num(below[1].high)} → ${below[1].below ? "yes" : "not shown"}; second half ${num(below[2].high)} → ${below[2].below ? "yes" : "not shown"}`);

const hs = stats.main;
console.log(`\n== HELD (main): 5-minute closes of G (T, x]: median ${hs.hold_grid.median}, 95% ${hs.hold_grid.p95}, most ${hs.hold_grid.max}; calendar: median ${((hs.cal_ms.median ?? 0) / HOUR).toFixed(2)} h, 95% ${((hs.cal_ms.p95 ?? 0) / HOUR).toFixed(2)} h, most ${((hs.cal_ms.max ?? 0) / HOUR).toFixed(2)} h; over a weekend ${hs.weekend.trades} trades (${hs.weekend.total} weekends); through Rakuten's NY close ${hs.ny.trades} trades (${hs.ny.total} closes), swap days ${hs.ny.swap_days} (${num(hs.ny.swap_days_mean, 3)} a trade): a swap of ¥${hs.swap_for_100 === null ? "-" : hs.swap_for_100.toFixed(0)} a day at 10,000 units would move the yen a trade by ¥100`);
console.log(`== OPEN TOGETHER (main, CALL9, at each close of G from the first entry to the last exit, ${conc.span_g} closes): most ${conc.max} (${conc.max_at}); 1 or more ${pct(conc.share_1)}, 3 or more ${pct(conc.share_3)}, 5 or more ${pct(conc.share_5)} of the time; mean ${num(conc.mean, 3)}; yen pairs one way at most ${conc.jpy_same_way_max}; each pair at most ${Object.entries(conc.pair_max).map(([p, m]) => `${p} ${m}`).join(", ")}; hedges ${conc.hedges} (a pair both ways ${pct(conc.share_1 === null ? null : conc.hedge_time_share)} of the time); emails a close ${Object.entries(conc.emails_per_bar).map(([k, m]) => `${k}: ${m}`).join(", ")}; yen pairs one way in one close at most ${conc.same_bar_jpy_way_max}; Σ hold_grid ${holdSum} = Σ open ${conc.sum_all_g}`);

// the look-ahead to look for before reporting (§8.99 先読みを疑うとき, the trades' part)
const suspect: string[] = [];
for (const [name, s] of [["main", stats.main], ...Object.entries(stats.variants), ["12 pairs", stats.p12]] as Array<[string, TradeStats | null]>) {
  if (!s) continue;
  if ((s.mean_pips ?? 0) > 0) suspect.push(`${name}: ${num(s.mean_pips)} pips a trade, over 0`);
  if ((s.win_resolved ?? 0) >= 0.765) suspect.push(`${name}: TP1 first ${pct(s.win_resolved)} of those ended (76.5% breaks even without the spread)${s.win_resolved === 1 ? " — 100%" : ""}`);
}
console.log(`\n== LOOK-AHEAD TO CHECK BEFORE REPORTING (the trades: ${suspect.length})`);
for (const x of suspect) console.log(`  ${x}`);

// ---- the account: the 25 cells and the told rows (part 2 of 3, research/money-cells.ts) -----------

const account = await runAccountPart(study, cfg, stats.main, suspect);

// ---- part 3: the windows, the orders, the kept and the skipped, the thinning, the weeks rearranged ----

const extras = await runExtras(study, cfg, stats.main, account.cells, account.rows, suspect, { trades: tradeIntervals });

// for research/money-seeds.py's gates (interface.md §9): the half spread paid
// a trade (its mean, pips) and the mean's standard error by week
const hMean = main.length ? main.reduce((a, t) => a + t.h, 0) / main.length : null;
const seWeek = statOf(clustered(main.map((t) => ({ x: t.pips, week: t.sig.week }))), "weeks")?.se ?? null;

// ---- the files ------------------------------------------------------------------------------------

await writeTables(tradeTable());
const runtimeMs = performance.now() - started;
const json: Record<string, unknown> = {
  meta: { start: cfg.start, split: cfg.split, end: iso(cfg.now), synthetic: cfg.synthetic, synth: cfg.synth, seed: cfg.seed, drift: cfg.drift || null, levels: { sl: 13, tp: [4, 10, 16] }, pairs: { CALL9, C3, admission: admissionOrder("P12") }, grid: { CALL9: grid9.g.length, P12: study.grids.P12?.g.length ?? null }, runtime_ms: runtimeMs, counts: extras.json.counts, version: "parts 1 to 3: the trades, the account, the windows, orders, thinning, kept and rearranged weeks" },
  plant: cfg.plant || null,
  checks: { ...allChecks, ...account.checks, ...extras.checks },
  failed_reads: study.failedReads,
  gates: { real, same_count: sameCount, want: WANT },
  trades: {
    ...stats.main,
    n: call9.length,
    per_pair: Object.fromEntries(CALL9.map((p, k) => [p, perPair[k]])),
    halves,
    c3: { n: c3.length, per_pair: Object.fromEntries(C3.map((p) => [p, c3.filter((s) => s.pair === p).length])) },
    by_half: stats.halves,
    variants: stats.variants,
    rakuten_share: rakutenShare,
    no_nights: noNights,
    coin: { ...stats.coin, by_half: stats.coinHalves },
    p12: stats.p12,
    below0: below,
    h_mean: hMean,
    se_week: Number.isFinite(seWeek) ? seWeek : null,
    concurrency: conc,
    carried: { path_uses: pathStale, path_g: holdSum, usdjpy_uses: usdStale, usdjpy_most_closes: Number.isFinite(usdStaleMax) ? usdStaleMax : null },
    cover: study.cover,
  },
  suspect,
  cells: account.cells,
  rows: account.rows,
  account: account.extra,
  windows: extras.json.windows,
  orders: extras.json.orders,
  order_ranges: extras.json.order_ranges,
  kept: extras.json.kept,
  thin: extras.json.thin,
  thin_ranks: extras.json.thin_ranks,
  boot: extras.json.boot,
  looked: extras.json.looked,
  times_ms: extras.json.times_ms,
};
await Deno.writeTextFile(`${cfg.out}/money.json`, JSON.stringify(json));
if (cfg.synthetic) await Deno.writeTextFile(`${cfg.out}/money-${cfg.synth}-${cfg.seed}.json`, JSON.stringify(json));
console.log(`\nruntime ${(runtimeMs / 1000).toFixed(1)} s; files in ${cfg.out}: money-signals.csv, money-trades.csv, money.json${cfg.synthetic ? `, money-${cfg.synth}-${cfg.seed}.json` : ""}`);
// the data's run fails when its own checks differ or #187's trades are not
// these (the outputs kept for looking into it): its numbers are not to be read
if (real && (differ !== 0 || account.differ !== 0 || extras.differ !== 0 || !sameCount)) Deno.exit(1);
