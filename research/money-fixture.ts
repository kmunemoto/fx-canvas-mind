// #188: a hand example run by research/money.ts (FIXTURE=<dir>, interface.md
// §6): the account's runs fixture.json names, each compared with what the
// hand calculation expects, PASS or FAIL. Research only: nothing in the app
// reads this.
//
// fixture.json: {name, what, hand, start, end, pairs, digits, runs: [{key,
// sizing, cap, course, losscut, row, start_equity, order, weeks?,
// shift_weeks?}], expect: {<key>:
// {ledger: [rows, with the columns that matter], summary: {...}}}, plants}.
// The tolerances are interface.md §5's: prices 1e-9, yen (balance, equity,
// pnl, margin, E*, the falls) 1e-6, units, kinds, times and counts exactly.
// An expected ledger row with `seq` is compared with that row; without, the
// rows are compared in order and their numbers must agree.

import { type Config } from "./money-data.ts";
import { type Cap, type Row, type RunSpec, type Summary, estarCheck, hashOrder, ledgerCsv, ordersOf, runAccount, runChecks, specOf, summarize, tapeOf } from "./money-account.ts";
import { placedTape, weeksOf } from "./money-boot.ts";
import { type Check, type Study, iso, yenOf } from "./money-trades.ts";

interface FixtureRun {
  key: string;
  sizing: string;
  cap: Cap;
  course?: number | string | null;
  losscut?: number | null;
  row?: Row | "" | null;
  start_equity?: number | null;
  order?: number | null;
  // the weeks rearranged (§8.99: money.ts only, the check does not rearrange):
  // the original weeks (0 the first entry's) in the order placed, and a move
  // of the whole clock by whole weeks
  weeks?: number[] | null;
  shift_weeks?: number | null;
}
interface Fixture {
  name: string;
  what?: string;
  runs: FixtureRun[];
  expect: Record<string, { ledger?: Array<Record<string, unknown>>; summary?: Record<string, unknown> }>;
  plants?: string[];
}

const ALIAS: Record<string, string> = { loss: "negative" };
const LEDGER_COLS = ["seq", "g", "kind", "id", "units", "px", "pnl_yen", "balance", "equity", "margin", "reason"] as const;
const YEN = new Set(["pnl_yen", "balance", "equity", "margin"]);

// one value against the expected: times as times, numbers to `tol` (exact
// where tol is 0), the rest as strings; "" and null the same
const timeOf = (x: unknown): number | null => (typeof x === "string" && /^\d{4}-\d\d-\d\dT/.test(x) ? Date.parse(x) : null);
const same = (want: unknown, got: unknown, tol: number): boolean => {
  const blank = (x: unknown) => x === null || x === undefined || x === "";
  if (blank(want) || blank(got)) return blank(want) && blank(got);
  const tw = timeOf(want);
  const tg = typeof got === "number" ? got : timeOf(got);
  if (tw !== null && tg !== null) return tw === tg;
  if (typeof want === "number" || typeof got === "number") {
    const a = Number(want);
    const b = Number(got);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) <= tol : a === b;
  }
  if (typeof want === "boolean" || typeof got === "boolean") return want === got;
  return String(want) === String(got);
};
// a summary's tolerance by its name: counts exactly, yen and the falls 1e-6, shares 1e-9
const COUNTS = new Set(["taken", "calls", "cures", "deadlines", "losscuts", "trades", "net_only", "positions", "left_open", "calls_while_open", "stale_marks", "stale_usdjpy"]);
const tolOf = (path: string, want: unknown): number => {
  const last = path.split(".").pop()!.replace(/\[.*\]$/, "");
  if (typeof want === "number" && Number.isInteger(want) && (COUNTS.has(last) || /^(skipped|exits)\./.test(path))) return 0;
  return /yen|balance|equity|margin|estar|value|lost|^C$|mdd|shortfall|below/.test(path) ? 1e-6 : 1e-9;
};
// every field the expectation gives, against the summary (nested objects by
// name; arrays of named objects by name, others in order)
const compareSummary = (want: unknown, got: unknown, path: string, out: string[]) => {
  if (want !== null && typeof want === "object" && !Array.isArray(want)) {
    if (got === null || typeof got !== "object") {
      out.push(`${path}: expected an object, got ${JSON.stringify(got)}`);
      return;
    }
    for (const [k, v] of Object.entries(want as Record<string, unknown>)) compareSummary(v, (got as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) {
      out.push(`${path}: expected a list, got ${JSON.stringify(got)}`);
      return;
    }
    const named = want.every((x) => x && typeof x === "object" && "name" in x);
    want.forEach((w, j) => {
      // E*'s last term: "negative" here and in money-check.py, "loss" in some fixtures
      const name = named ? ALIAS[(w as { name: string }).name] ?? (w as { name: string }).name : "";
      const g = named ? got.find((x) => x && typeof x === "object" && x.name === name) : got[j];
      if (named && g) w = { ...(w as object), name };
      compareSummary(w, g, `${path}[${named ? (w as { name: string }).name : j}]`, out);
    });
    if (!named && want.length !== got.length) out.push(`${path}: ${want.length} expected, ${got.length} got`);
    return;
  }
  if (!same(want, got, tolOf(path, want))) out.push(`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

// one fixture run's settings from its line (interface.md §6)
const specOfRun = (r: FixtureRun, plant: string, zero: { yen: number; r: number }): RunSpec => {
  const row = r.row || "";
  const spec = specOf(`${row ? `row_${row}_` : ""}${r.sizing}_${r.cap}`, plant, zero);
  const course = String(r.course ?? 25).replace(/x/i, "");
  if (course === "10") {
    spec.rate = 0.1;
    spec.calls = false;
  } else if (course === "25") {
    spec.rate = 0.04;
  } else throw new Error(`${r.key}: course ${r.course} is neither 25 nor 10`);
  if (row === "x10") {
    spec.rate = 0.1;
    spec.calls = false;
  }
  if (r.losscut !== null && r.losscut !== undefined) spec.losscut = r.losscut;
  if (r.start_equity !== null && r.start_equity !== undefined) spec.start = r.start_equity;
  return { ...spec, key: r.key };
};

// the fixture's runs against its expectations; PASS/FAIL lines, the outputs
// in cfg.out; true when every item passed
export const runFixture = async (study: Study, cfg: Config): Promise<{ pass: boolean; checks: Record<string, Check>; results: Record<string, { pass: boolean; problems: string[]; summary: Summary }> }> => {
  const fx = JSON.parse(await Deno.readTextFile(`${cfg.fixture}/fixture.json`)) as Fixture;
  // the zero row's δ from the fixture's own trades (as the data's from the 3,958)
  const grid = study.grids.CALL9!;
  const main = study.trades.main.filter((t) => t.sig.group === "CALL9" && t.exit !== "passed");
  const zero = main.length ? { yen: -main.reduce((a, t) => a + yenOf(grid, t), 0) / main.length, r: -main.reduce((a, t) => a + t.pips / 13, 0) / main.length } : { yen: 0, r: 0 };
  const results: Record<string, { pass: boolean; problems: string[]; summary: Summary }> = {};
  // the account's own identities on every run too (as on the data's)
  const checks: Record<string, Check> = {};
  console.log(`\nFIXTURE ${fx.name}${fx.what ? `: ${fx.what}` : ""}`);
  for (const r of fx.runs ?? []) {
    const spec = specOfRun(r, cfg.plant, zero);
    if (spec.set === "P12" && !study.grids.P12) throw new Error(`${r.key}: the 12-pair row with no C3 pair in the fixture`);
    let orders = ordersOf(study, spec);
    // order r (1..20): the close's emails by sha256; 0 or none: the broker's order
    if (r.order) orders = await hashOrder(orders, r.order);
    let tape = tapeOf(study, spec.variant, spec.set);
    // the weeks laid down in another order: a new clock and the emails on it
    if (r.weeks) ({ tape, orders } = placedTape(tape, weeksOf(tape, orders), r.weeks, r.shift_weeks ?? 0));
    const run = runAccount(tape, orders, spec);
    const summary = summarize(run, cfg.splitMs);
    runChecks(run, checks, false);
    if (summary.estar) estarCheck(tape, orders, spec, summary.estar.value, checks);
    await Deno.writeTextFile(`${cfg.out}/money-ledger-${r.key}.csv`, ledgerCsv(run));
    const problems: string[] = [];
    const want = fx.expect?.[r.key];
    if (!want) problems.push("no expectation for this run");
    // the ledger, row by row
    const rows = run.ledger.map((x) => Object.fromEntries(LEDGER_COLS.map((c, j) => [c, x[j]])) as Record<string, unknown>);
    const wantRows = want?.ledger ?? [];
    const bySeq = wantRows.length > 0 && wantRows.every((w) => w.seq !== undefined && w.seq !== null);
    if (!bySeq && want?.ledger && wantRows.length !== rows.length) problems.push(`ledger: ${wantRows.length} rows expected, ${rows.length} written`);
    wantRows.forEach((w, j) => {
      const got = bySeq ? rows.find((x) => x.seq === Number(w.seq)) : rows[j];
      if (!got) {
        problems.push(`ledger row ${bySeq ? `seq ${w.seq}` : j + 1}: not written`);
        return;
      }
      for (const [c, v] of Object.entries(w)) {
        if (!(LEDGER_COLS as readonly string[]).includes(c)) continue;
        const tol = c === "px" ? 1e-9 : YEN.has(c) ? 1e-6 : 0;
        if (!same(v, got[c], tol)) problems.push(`ledger row ${got.seq} ${c}: expected ${JSON.stringify(v)}, got ${JSON.stringify(c === "g" ? iso(got.g as number) : got[c])}`);
      }
    });
    if (want?.summary) compareSummary(want.summary, summary, "", problems);
    const pass = problems.length === 0;
    results[r.key] = { pass, problems, summary };
    console.log(`  ${r.key}: ${pass ? "PASS" : "FAIL"}`);
    for (const p of problems.slice(0, 20)) console.log(`    ${p}`);
    if (problems.length > 20) console.log(`    … and ${problems.length - 20} more`);
  }
  for (const [name, c] of Object.entries(checks)) console.log(`  ${name}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.slice(0, 5).join("; ") : ""}`);
  const pass = Object.values(results).every((x) => x.pass) && (fx.runs ?? []).length > 0 && Object.values(checks).every((c) => c.mismatched === 0);
  if (cfg.plant && (fx.plants ?? []).includes(cfg.plant)) console.log(`  planted ${cfg.plant}: this fixture lists it, so it must FAIL: ${pass ? "it PASSED (the plant was NOT caught)" : "it failed (caught)"}`);
  return { pass, checks, results };
};
