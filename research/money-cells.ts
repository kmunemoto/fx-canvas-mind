// #188: the account's cells and told rows as research/money.ts prints and
// writes them (docs §8.99 表・見出し・説明用の行・出すもの ますごと), part 2 of its
// three: each of the 25 cells (sizing × cap) and the told rows run through
// research/money-account.ts, its ledger written, its numbers summed up, its
// identities checked (E* exactly, the account again by another loop, …).
// Research only: nothing in the app reads this.

import type { Config } from "./money-data.ts";
import { CELLS, ROWS, type Run, type Summary, estarCheck, ledgerCsv, ordersOf, rowKey, runAccount, runChecks, specOf, summarize, tapeOf, tinyKIdentity, unitsIdentity } from "./money-account.ts";
import { type Check, type Study, type TradeStats, yenOf } from "./money-trades.ts";

const num = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const yen = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${x < 0 ? "−" : ""}¥${Math.abs(Math.round(x)).toLocaleString("en-US")}`);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${(100 * x).toFixed(d)}%`);

// every cell and told row: run, checked, written; the numbers money.json holds
export const runAccountPart = async (study: Study, cfg: Config, main: TradeStats, suspect: string[]) => {
  const checks: Record<string, Check> = {};
  const drifting = cfg.synthetic && cfg.synth === "drift";
  // the zero row's δ (§8.99 損益ゼロ): from the 3,958 trades' mean (here the
  // run's CALL9 main trades), yen a trade at 10,000 units and R
  const grid9 = study.grids.CALL9!;
  const trades = study.trades.main.filter((t) => t.sig.group === "CALL9" && t.exit !== "passed");
  const zero = { yen: -trades.reduce((a, t) => a + yenOf(grid9, t, cfg.plant), 0) / trades.length, r: -trades.reduce((a, t) => a + t.pips / 13, 0) / trades.length };
  const cells: Record<string, Summary & { estar_check?: unknown }> = {};
  const rows: Record<string, Summary & { estar_check?: unknown }> = {};
  let nomarginRun: Run | null = null;
  await Deno.mkdir(cfg.out, { recursive: true });
  const t0 = performance.now();
  for (const key of [...CELLS, ...ROWS.map(([r, c]) => rowKey(r, c))]) {
    const spec = specOf(key, cfg.plant, zero);
    if (spec.set === "P12" && !study.grids.P12) continue;
    const tape = tapeOf(study, spec.variant, spec.set);
    const orders = ordersOf(study, spec);
    const run = runAccount(tape, orders, spec);
    runChecks(run, checks, drifting);
    const s: Summary & { estar_check?: unknown } = summarize(run, cfg.splitMs);
    // E* exactly: just above it nothing happens, just below something does
    if (s.estar) s.estar_check = estarCheck(tape, orders, spec, s.estar.value, checks);
    (key.startsWith("row_") ? rows : cells)[key] = s;
    await Deno.writeTextFile(`${cfg.out}/money-ledger-${key}.csv`, ledgerCsv(run));
    if (key === rowKey("nomargin", "FF1_C0")) nomarginRun = run;
  }
  // caps and margin off: the yen again from every trade; k tiny: Σ R
  const identities = { units_sum: nomarginRun ? unitsIdentity(nomarginRun, checks) : null, tiny_k: tinyKIdentity(study, checks, cfg.plant) };
  const runMs = performance.now() - t0;
  const differ = Object.values(checks).reduce((a, c) => a + c.mismatched, 0);

  // ---- printed ----------------------------------------------------------------------------
  console.log(`\n== THE ACCOUNT (§8.99 口座; ${Object.keys(cells).length} cells, ${Object.keys(rows).length} told-row cells, ${(runMs / 1000).toFixed(1)} s)`);
  console.log(`  (as the report's first line says: 11 FX pairs not in here mail the same account, so the trades open together, the margin and E* come out LOW)`);
  for (const [name, c] of Object.entries(checks)) console.log(`  ${name}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.slice(0, 5).join("; ") : ""}`);
  console.log(differ === 0 ? "  THE ACCOUNT'S CHECKS: EVERY ONE 0 DIFFER" : `  THE ACCOUNT'S CHECKS DIFFER (${differ}): the numbers below are not to be read`);

  const head = cells.F10k_C0;
  if (head?.estar) {
    const e = head.estar;
    const z = rows[rowKey("zero", "F10k_C0")]?.estar;
    console.log(`\n== THE HEADLINE (§8.99 見出し): the account it took, looking back over this period, for every email to be taken at 10,000 units with no cap and no call, loss-cut or shortfall (E*, yen a 10,000 units; a 1,000 units a tenth): ${yen(e.value)}`);
    console.log(`   set by the ${e.set_by} term at ${e.g}: ${yen(e.lost)} lost by then + ${yen(e.margin)} the margin then. The terms: ${e.terms.map((t) => `${t.name} ${yen(t.value)} (${t.g})`).join(", ")}`);
    console.log(`   beside it: TP1 first ${pct(main.win_all)} of all (${pct(main.win_resolved)} of those ended); ${num(main.mean_pips, 2)} pips a trade [${num(main.ci_week[0], 2)}, ${num(main.ci_week[1], 2)}] (4 wk [${num(main.ci_4wk[0], 2)}, ${num(main.ci_4wk[1], 2)}]); ${num(main.mean_yen)} yen a trade at 10,000 units [${num(main.yen_ci_week[0])}, ${num(main.yen_ci_week[1])}], ${num(main.yen_year)} a year; with the P/L made 0 (the zero row, δ ${num(zero.yen, 1)} yen a trade) E* ${yen(z?.value)}`);
  }
  const line = (key: string, s: Summary) => {
    const f10k = s.sizing === "F10k";
    const money = f10k ? `yen ${num(s.total_yen)}` : `ends ${yen(s.final_equity)} (${num(100 * (s.final_pct ?? 0), 1)}%)`;
    const sk = s.skipped;
    return `  ${key.padEnd(22)} taken ${String(s.taken).padStart(5)}, skipped call ${sk.call} cap ${sk.cap} lot ${sk.lot} margin ${sk.margin}${sk.passed ? ` passed ${sk.passed}` : ""}; ${money}; fall ${yen(s.mdd_yen)} (${pct(s.mdd_pct)}${f10k ? " of E*+peak" : ""}), worst week ${yen(s.worst_week_yen)}, day ${yen(s.worst_day_yen)}; calls ${s.calls} (cured ${s.cures}, deadlines ${s.deadlines}), loss-cuts ${s.losscuts}${s.shortfall_yen ? `, SHORTFALL ${yen(s.shortfall_yen)}` : ""}; TP1 first ${pct(s.win_all)}, ${num(s.mean_pips, 2)} pips a trade${s.estar ? `; E* ${yen(s.estar.value)} (${s.estar.set_by})` : ""}`;
  };
  console.log(`\n== THE 25 CELLS (k%: from ${yen(1_000_000)}, 25×, loss-cut 50%; F10k: yen at 10,000 units, every email but the cap's skips, ratios against its own E*)`);
  for (const [k, s] of Object.entries(cells)) console.log(line(k, s));
  console.log(`\n== THE TOLD ROWS (one thing changed; TP1 first and pips a trade beside each)`);
  for (const [k, s] of Object.entries(rows)) console.log(line(k, s));
  for (const [k, s] of Object.entries({ ...cells, ...rows })) {
    const more: string[] = [];
    if (s.first_lot_skip) more.push(`first under 1,000 units ${s.first_lot_skip}`);
    if (s.net_only) more.push(`emails used whole to close the other side ${s.net_only}`);
    if (s.call_list.length) more.push(`calls: ${s.call_list.slice(0, 3).map((c) => `${c.tau} C ${yen(c.C)} → ${c.outcome} ${c.at ?? ""}`).join("; ")}${s.call_list.length > 3 ? " …" : ""}`);
    if (s.losscut_list.length) more.push(`loss-cuts: ${s.losscut_list.slice(0, 3).map((l) => `${l.g} equity ${yen(l.equity)} → ${yen(l.balance_after)}`).join("; ")}${s.losscut_list.length > 3 ? " …" : ""}`);
    if (more.length) console.log(`  ${k}: ${more.join("; ")}`);
  }
  console.log(`\n  identities: caps and margin off, the yen ${identities.units_sum ? `${num(identities.units_sum.yen, 6)} = Σ units × dir × (exit − fill) × USD/JPY ${num(identities.units_sum.again, 6)}` : "-"}; k = 1e-6 from ¥1: (final − 1) ÷ k ${num(identities.tiny_k.got, 4)}, Σ R in yen ${num(identities.tiny_k.sum_r, 4)}`);

  // the look-ahead to look for before reporting (§8.99 先読みを疑うとき, the account's part)
  const before = suspect.length;
  for (const [k, s] of Object.entries({ ...cells, ...rows })) {
    if (k.includes("row_zero")) continue; // a reference made with the mean: left out of these
    if (s.sizing === "F10k" ? s.total_yen >= 0 : s.final_equity > s.start) suspect.push(`${k}: the account grew (${s.sizing === "F10k" ? `yen ${num(s.total_yen)}` : `ends ${yen(s.final_equity)}`})`);
    if ((s.mean_pips ?? 0) > 0) suspect.push(`${k}: the trades taken ${num(s.mean_pips, 2)} pips a trade, over 0`);
    if ((s.win_resolved ?? 0) >= 0.765) suspect.push(`${k}: TP1 first ${pct(s.win_resolved)} of those ended${s.win_resolved === 1 ? " — 100%" : ""}`);
    if (s.mdd_yen < s.mdd_exits.yen - 1e-6) suspect.push(`${k}: the fall with the open P/L ${yen(s.mdd_yen)} under the exits' ${yen(s.mdd_exits.yen)}`);
  }
  for (const c of ["F10k_C0", "FF1_C0"]) {
    for (const r of ["late", "nights"]) {
      const a = rows[rowKey(r as "late", c)];
      const b = cells[c];
      if (a && b && (a.mean_pips ?? -Infinity) > (b.mean_pips ?? Infinity)) suspect.push(`${rowKey(r as "late", c)}: better a trade than ${c} (${num(a.mean_pips, 2)} against ${num(b.mean_pips, 2)} pips)`);
    }
  }
  console.log(`\n== LOOK-AHEAD TO CHECK BEFORE REPORTING (the account: ${suspect.length - before})`);
  for (const x of suspect.slice(before)) console.log(`  ${x}`);

  return { cells, rows, checks, differ, extra: { zero_delta: zero, identities, ledgers: [...Object.keys(cells), ...Object.keys(rows)].map((k) => `money-ledger-${k}.csv`) } };
};
