// #188: the account's numbers beyond the one path (docs §8.99 見出し 52週の窓,
// 順番の幅, 上限と証拠金の確かめ, 区間・幅), part 3 of research/money.ts: each
// on research/money-account.ts runAccount with its own emails or its own
// clock, then the table §8.99 shows the owner. Research only: nothing in the
// app reads this.
//
// WHAT IS RUN (§8.99 and interface.md §2–§4, fixed before any data):
//   * the 52-week windows of E*: every window of 52 weeks starting at a week's
//     start (Sunday 21:00 UTC) from the first entry's week; only the emails
//     that came in inside it, each followed to its own exit, the P/L 0 at its
//     start (F10k_C0, the headline's run); a window ending after the data's
//     last entry not used;
//   * the orders: the 12 owner-facing cells whose path depends on the order of
//     one close's emails, again with each close's emails in the order of
//     sha256(`${r}|${pair}|${side}|${T_iso}`), r = 1..20;
//   * the thinning (the cap cells and FF1_C0, FF2_C0): draw d = 1..THIN skips,
//     in each week, as many of the week's emails as the cell skipped there, the
//     smallest sha256(`${d}|${pair}|${side}|${T_iso}`) first, and runs the rest
//     with the cell's sizing, course, margin, calls and loss-cut and no cap;
//     the cell's final account, fall and worst week placed among the draws;
//   * the kept and the skipped (the same cells): the mean R (pips ÷ 13, the
//     email's own trade) of the emails the cell took less of those it skipped;
//     its 95% band from 1,000 rearrangements of taken/skipped within each week
//     (the week's counts kept), and within each week and pair; and the same
//     difference with the spread paid added back;
//   * the weeks rearranged (research/money-boot.ts) for the 13 owner-facing
//     cells, BOOT one-week and BOOT four-week rearrangements, each number's
//     5–95% band from the wider of the two; first, the weeks in their own
//     order must give the path itself (and moved a week, the path a week on).
// WHERE §8.99 LEAVES A CHOICE (told in the report as well):
//   * a thinning draw skips as many as the cell skipped for any reason (on
//     these cells: the cap's, or the margin's on FF1_C0 and FF2_C0; a call's
//     or a lot's when there are any); its own run may skip more (its margin,
//     a call), so its count taken is told;
//   * the permutation bands are 95% (2.5–97.5%, the design's), mulberry32
//     seeded 188 a cell; "the spread added back" is pips + the spread paid at
//     the entry (ask − bid at T), over 13;
//   * a rank: how many draws came out below the cell's (and how many equal).

import { createHash } from "node:crypto";
import { WEEK } from "./lib.ts";
import { type Order, type Run, type RunSpec, type Summary, hashOrder, ledgerCsv, ordersOf, runAccount, specOf, summarize, tapeOf } from "./money-account.ts";
import { placedTape, rearrangements, weekStart, weeksOf, mulberry32 } from "./money-boot.ts";
import type { Config } from "./money-data.ts";
import { medianOf, quantile, weekOf } from "./money-stats.ts";
import { type Check, SL, type Study, type TradeStats, iso, newCheck, tally } from "./money-trades.ts";

// ---- what is fixed (§8.99, interface.md §3) -------------------------------------------------

// the cells §8.99 shows the owner: the k% cells with no cap, the caps at
// 10,000 units and at 0.5%
export const OWNER = ["F10k_C0", "FF025_C0", "FF05_C0", "FF1_C0", "FF2_C0", "F10k_T1", "F10k_T3", "F10k_P1", "F10k_J2", "FF05_T1", "FF05_T3", "FF05_P1", "FF05_J2"];
// those whose path depends on the order of one close's emails (all but F10k_C0)
const ORDER_CELLS = OWNER.filter((k) => k !== "F10k_C0");
// the cells whose skips are looked into: the caps, and the margin's at 1% and 2%
const THIN_CELLS = ["F10k_T1", "F10k_T3", "F10k_P1", "F10k_J2", "FF05_T1", "FF05_T3", "FF05_P1", "FF05_J2", "FF1_C0", "FF2_C0"];
const ORDERS = 20;
const PERM = 1000;
// the numbers a rearrangement band is given for (E* on the F10k cells only)
const BAND_NUMBERS = ["final_equity", "total_yen", "mdd_yen", "mdd_pct", "worst_week_yen", "worst_day_yen", "below_start_max", "taken", "calls", "losscuts", "estar"] as const;
type BandNumber = (typeof BAND_NUMBERS)[number];

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const keyOf = (prefix: number, o: Order) => sha256hex(`${prefix}|${o.sig.pair}|${o.sig.side}|${iso(o.T)}`);

const yen = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${x < 0 ? "−" : ""}¥${Math.abs(Math.round(x)).toLocaleString("en-US")}`);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${(100 * x).toFixed(d)}%`);
const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const count = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : Math.round(x).toLocaleString("en-US"));

// a summary's number by name (E* its value; null where it has none)
const numberOf = (s: Summary, name: BandNumber): number | null => {
  if (name === "estar") return s.estar ? s.estar.value : null;
  const v = s[name];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const minMedMax = (xs: number[]) => (xs.length ? { min: Math.min(...xs), median: medianOf(xs)!, max: Math.max(...xs) } : null);

// a cell run once on the path itself, in the broker's order
const baseRun = (study: Study, key: string, plant: string): { spec: RunSpec; orders: Order[]; run: Run; summary: Summary } => {
  const spec = specOf(key, plant);
  const orders = ordersOf(study, spec);
  const run = runAccount(tapeOf(study, spec.variant, spec.set), orders, spec);
  return { spec, orders, run, summary: summarize(run, study.cfg.splitMs) };
};

// ---- the 52-week windows of E* (§8.99 見出し) -----------------------------------------------------

const windowsOf = (study: Study, plant: string) => {
  const spec = specOf("F10k_C0", plant);
  const tape = tapeOf(study, spec.variant, spec.set);
  const orders = ordersOf(study, spec);
  const lastT = orders.reduce((a, o) => Math.max(a, o.T), -Infinity);
  const list: Array<{ start: string; end: string; estar: number; set_by: string; g: string | null; lost: number; margin: number; emails: number }> = [];
  for (let w = orders.length ? weekOf(orders[0].T) : 0; orders.length && weekStart(w) + 52 * WEEK <= lastT; w++) {
    const from = weekStart(w);
    const to = from + 52 * WEEK;
    const inside = orders.filter((o) => o.T >= from && o.T < to);
    const run = runAccount(tape, inside, { ...spec, key: `window ${iso(from)}` });
    const best = run.estar!.reduce((a, t) => (t.value > a.value ? t : a));
    list.push({ start: iso(from), end: iso(to), estar: best.value, set_by: best.name, g: best.g === null ? null : iso(best.g), lost: best.lost, margin: best.margin, emails: inside.length });
  }
  const values = list.map((x) => x.estar);
  const most = list.reduce((a, x) => (a === null || x.estar > a.estar ? x : a), null as (typeof list)[number] | null);
  return { count: list.length, median: medianOf(values), max: most?.estar ?? null, max_start: most?.start ?? null, max_set_by: most?.set_by ?? null, list };
};

// ---- the orders (§8.99 順番の幅) ----------------------------------------------------------------

const ORDER_NUMBERS = ["final_equity", "total_yen", "mdd_yen", "mdd_pct", "worst_week_yen", "worst_day_yen", "taken", "calls", "losscuts", "win_all", "mean_pips"] as const;

const ordersPart = async (study: Study, plant: string) => {
  const finals: Record<string, number[]> = {};
  const per: Record<string, Record<string, number[]>> = {};
  const base = ordersOf(study, specOf(ORDER_CELLS[0], plant));
  for (const key of ORDER_CELLS) {
    // every one of these cells takes the same emails (each whole at TP1)
    const own = ordersOf(study, specOf(key, plant));
    if (own.length !== base.length || own.some((o, j) => o.id !== base[j].id)) throw new Error(`${key}: not the same emails as ${ORDER_CELLS[0]}`);
    finals[key] = [];
    per[key] = Object.fromEntries([...ORDER_NUMBERS, "skipped_cap", "skipped_margin"].map((n) => [n, [] as number[]]));
  }
  for (let r = 1; r <= ORDERS; r++) {
    const orders = await hashOrder(base, r);
    for (const key of ORDER_CELLS) {
      const spec = specOf(key, plant);
      const s = summarize(runAccount(tapeOf(study, spec.variant, spec.set), orders, { ...spec, key: `${key} order ${r}` }), study.cfg.splitMs);
      finals[key].push(s.final_equity);
      for (const n of ORDER_NUMBERS) {
        const v = s[n];
        if (typeof v === "number" && Number.isFinite(v)) per[key][n].push(v);
      }
      per[key].skipped_cap.push(s.skipped.cap);
      per[key].skipped_margin.push(s.skipped.margin);
    }
  }
  const ranges = Object.fromEntries(ORDER_CELLS.map((k) => [k, Object.fromEntries(Object.entries(per[k]).map(([n, xs]) => [n, minMedMax(xs)]))]));
  return { finals, ranges };
};

// ---- the kept and the skipped (§8.99 上限と証拠金の確かめ) ----------------------------------------------

// the emails a run took and skipped (by id), from its entries and its ledger
const keptAndSkipped = (run: Run) => {
  const kept = new Set(run.entries.filter((e) => !e.passed).map((e) => e.id));
  const skipped = new Set(run.ledger.filter((r) => r[2] === "skip").map((r) => r[3]));
  return { kept, skipped };
};

// the 95% band of the difference with the labels rearranged inside each stratum
const permBand = (strata: Array<{ r: number[]; k: number }>, seed: number) => {
  const rnd = mulberry32(seed);
  const total = strata.reduce((a, s) => a + s.r.reduce((b, x) => b + x, 0), 0);
  const K = strata.reduce((a, s) => a + s.k, 0);
  const N = strata.reduce((a, s) => a + s.r.length, 0);
  if (K === 0 || K === N) return null;
  const diffs: number[] = [];
  for (let p = 0; p < PERM; p++) {
    let kept = 0;
    for (const s of strata) {
      const n = s.r.length;
      if (s.k === 0) continue;
      if (s.k === n) {
        kept += s.r.reduce((a, x) => a + x, 0);
        continue;
      }
      // the first k of a Fisher–Yates shuffle (on a copy of the stratum)
      const a = s.r.slice();
      for (let i = 0; i < s.k; i++) {
        const j = i + Math.floor(rnd() * (n - i));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        kept += a[i];
      }
    }
    diffs.push(kept / K - (total - kept) / (N - K));
  }
  return [quantile(diffs, 0.025)!, quantile(diffs, 0.975)!] as [number, number];
};

const keptPart = (orders: Order[], run: Run) => {
  const { kept, skipped } = keptAndSkipped(run);
  // the email's own trade: R = pips ÷ 13; with the spread paid at the entry added back
  const R = (o: Order) => o.legs[0].pips / SL;
  const Rn = (o: Order) => (o.legs[0].pips + (o.sig.askClose - o.sig.bidClose) / o.legs[0].unit) / SL;
  const mean = (xs: Order[], f: (o: Order) => number) => (xs.length ? xs.reduce((a, o) => a + f(o), 0) / xs.length : null);
  const ks = orders.filter((o) => kept.has(o.id));
  const ss = orders.filter((o) => skipped.has(o.id));
  const mk = mean(ks, R);
  const ms = mean(ss, R);
  const diff = mk !== null && ms !== null ? mk - ms : null;
  const nk = mean(ks, Rn);
  const ns = mean(ss, Rn);
  // the strata: the week; the week and the pair (only the emails taken or skipped)
  const strataOf = (by: (o: Order) => string) => {
    const m = new Map<string, { r: number[]; k: number }>();
    for (const o of [...ks, ...ss]) {
      const s = m.get(by(o)) ?? { r: [], k: 0 };
      s.r.push(R(o));
      if (kept.has(o.id)) s.k++;
      m.set(by(o), s);
    }
    return [...m.values()];
  };
  return {
    kept: ks.length,
    skipped: ss.length,
    mean_r_kept: mk,
    mean_r_skipped: ms,
    diff,
    perm_band: diff === null ? null : permBand(strataOf((o) => String(weekOf(o.T))), 188),
    perm_pair_band: diff === null ? null : permBand(strataOf((o) => `${weekOf(o.T)}|${o.sig.pair}`), 188),
    diff_nospread: nk !== null && ns !== null ? nk - ns : null,
  };
};

// ---- the thinning (§8.99 でたらめに見送る) ----------------------------------------------------------

const thinPart = (study: Study, cells: Record<string, { orders: Order[]; run: Run; summary: Summary; spec: RunSpec }>, draws: number, checks: Record<string, Check>) => {
  const out: Record<string, Array<{ taken: number; final_equity: number; mdd_yen: number; worst_week_yen: number }>> = {};
  const plan: Record<string, { orders: Order[]; byWeek: Map<number, Order[]>; skip: Map<number, number>; total: number }> = {};
  for (const key of THIN_CELLS) {
    const { orders, run } = cells[key];
    const { skipped } = keptAndSkipped(run);
    const byWeek = new Map<number, Order[]>();
    const skip = new Map<number, number>();
    for (const o of orders) {
      const w = weekOf(o.T);
      byWeek.set(w, [...(byWeek.get(w) ?? []), o]);
      if (skipped.has(o.id)) skip.set(w, (skip.get(w) ?? 0) + 1);
    }
    plan[key] = { orders, byWeek, skip, total: skipped.size };
    out[key] = [];
  }
  // the emails' keys for draw d are the same for every cell (the same emails)
  const all = cells[THIN_CELLS[0]].orders;
  for (let d = 1; d <= draws; d++) {
    const keys = new Map<Order, string>();
    const keyFor = (o: Order) => {
      let k = keys.get(o);
      if (k === undefined) keys.set(o, (k = keyOf(d, o)));
      return k;
    };
    for (const o of all) keyFor(o);
    for (const key of THIN_CELLS) {
      const p = plan[key];
      const out1 = new Set<Order>();
      for (const [w, n] of p.skip) {
        const week = [...p.byWeek.get(w)!].sort((a, b) => (keyFor(a) < keyFor(b) ? -1 : keyFor(a) > keyFor(b) ? 1 : 0));
        for (const o of week.slice(0, n)) out1.add(o);
      }
      const rest = p.orders.filter((o) => !out1.has(o));
      tally((checks.thin_skips ??= newCheck()), out1.size === p.total && rest.length === p.orders.length - p.total, () => `${key} draw ${d}: ${out1.size} skipped, the cell ${p.total}`);
      const spec = cells[key].spec;
      const s = summarize(runAccount(tapeOf(study, spec.variant, spec.set), rest, { ...spec, cap: "C0", key: `${key} thinned ${d}` }), study.cfg.splitMs);
      out[key].push({ taken: s.taken, final_equity: s.final_equity, mdd_yen: s.mdd_yen, worst_week_yen: s.worst_week_yen });
    }
  }
  // the cell among its draws: how many came out below it, and equal
  const ranks = Object.fromEntries(THIN_CELLS.map((key) => {
    const s = cells[key].summary;
    const xs = out[key];
    const place = (f: (x: (typeof xs)[number]) => number, v: number) => ({ below: xs.filter((x) => f(x) < v).length, equal: xs.filter((x) => f(x) === v).length, of: xs.length });
    return [key, {
      final_equity: place((x) => x.final_equity, s.final_equity),
      mdd_yen: place((x) => x.mdd_yen, s.mdd_yen),
      worst_week_yen: place((x) => x.worst_week_yen, s.worst_week_yen),
      taken: minMedMax(xs.map((x) => x.taken)),
      cell_taken: s.taken,
    }];
  }));
  return { draws: out, ranks };
};

// ---- the weeks rearranged (§8.99 口座の数字の幅) -----------------------------------------------------

const bootPart = (study: Study, plant: string, count: number, checks: Record<string, Check>, cells: Record<string, { summary: Summary; run: Run }>) => {
  const specs = OWNER.map((k) => specOf(k, plant));
  for (const s of specs) if (s.variant !== "main" || s.set !== "CALL9" || s.thirds || s.nights) throw new Error(`${s.key}: not one leg an email on the 9 pairs`);
  const tape = tapeOf(study, "main", "CALL9");
  const orders = ordersOf(study, specs[0]);
  const wk = weeksOf(tape, orders);
  const L = wk.L;

  // the weeks in their own order: the path itself, row for row (§8.99 確かめ);
  // and all moved a week on: the same rows a week later (the moved clock and
  // the trades carried over a weekend read at their own times)
  const same = placedTape(tape, wk, Int32Array.from({ length: L }, (_, j) => j), 0);
  const moved = placedTape(tape, wk, Int32Array.from({ length: L }, (_, j) => j), 1);
  for (const spec of specs) {
    const a = runAccount(same.tape, same.orders, spec);
    const b = cells[spec.key].run;
    const strip = (csv: string) => csv.replace(/@\d+/g, "");
    const sa = summarize(a, study.cfg.splitMs);
    const sb = cells[spec.key].summary;
    const keyNums = (s: Summary) => JSON.stringify([s.final_balance, s.final_equity, s.mdd, s.mdd_4h, s.mdd_exits, s.mdd_worst, s.worst_week, s.worst_day, s.taken, s.skipped, s.calls, s.cures, s.deadlines, s.losscuts, s.shortfall_yen, s.win_all, s.mean_pips, s.mean_yen, s.estar, s.concurrency, s.margin_ratio, s.halves_yen, s.years_yen]);
    tally((checks.boot_identity ??= newCheck()), strip(ledgerCsv(a)) === ledgerCsv(b) && keyNums(sa) === keyNums(sb) && a.leftOpen === 0, () => `${spec.key}: the weeks in their own order do not give the path (${a.ledger.length}/${b.ledger.length} rows; final ${sa.final_equity}/${sb.final_equity})`);
    const m = runAccount(moved.tape, moved.orders, spec);
    const sm = summarize(m, study.cfg.splitMs);
    const rowsOk = m.ledger.length === b.ledger.length && m.ledger.every((r, i) => {
      const o = b.ledger[i];
      return r[1] - WEEK === o[1] && r[2] === o[2] && r[3].replace(/@\d+$/, "") === o[3] && r.slice(4).every((x, j) => x === o[4 + j]);
    });
    const movedNums = (s: Summary) => JSON.stringify([s.final_balance, s.final_equity, s.mdd_yen, s.mdd_pct, s.worst_week_yen, s.worst_day_yen, s.taken, s.skipped, s.calls, s.losscuts, s.win_all, s.mean_pips, s.estar?.value ?? null, s.estar?.set_by ?? null]);
    tally((checks.boot_moved ??= newCheck()), rowsOk && movedNums(sm) === movedNums(sb) && m.leftOpen === 0, () => `${spec.key}: the weeks a week on do not give the path a week on (${m.ledger.length}/${b.ledger.length} rows; final ${sm.final_equity}/${sb.final_equity})`);
  }

  // the rearrangements: the same ones for every cell
  const plans = rearrangements(L, count);
  const values: Record<string, Record<"w1" | "w4", Record<BandNumber, number[]>>> = {};
  for (const k of OWNER) values[k] = { w1: Object.fromEntries(BAND_NUMBERS.map((n) => [n, []])) as unknown as Record<BandNumber, number[]>, w4: Object.fromEntries(BAND_NUMBERS.map((n) => [n, []])) as unknown as Record<BandNumber, number[]> };
  for (const kind of ["w1", "w4"] as const) {
    for (const placement of plans[kind]) {
      const t = placedTape(tape, wk, placement);
      specs.forEach((spec) => {
        const run = runAccount(t.tape, t.orders, spec);
        tally((checks.boot_closed ??= newCheck()), run.leftOpen === 0, () => `${spec.key} (${kind}): ${run.leftOpen} positions left open at the clock's end`);
        const s = summarize(run, study.cfg.splitMs);
        for (const n of BAND_NUMBERS) {
          const v = numberOf(s, n);
          if (v !== null) values[spec.key][kind][n].push(v);
        }
      });
    }
  }
  // each number's 5–95% band, one-week and four-week; the wider told
  const bands = Object.fromEntries(OWNER.map((k) => {
    const s = cells[k].summary;
    const b: Record<string, { point: number | null; w1: [number, number] | null; w4: [number, number] | null; lo: number | null; hi: number | null; by: string | null }> = {};
    const f10k = s.sizing === "F10k";
    for (const n of BAND_NUMBERS) {
      const point = numberOf(s, n);
      if (point === null && n === "estar") continue;
      // not banded: an F10k cell's calls and loss-cuts (none by its rule) and
      // its final (its yen from 0, the same as its total); a k% cell's total
      if (f10k ? n === "calls" || n === "losscuts" || n === "final_equity" : n === "total_yen") continue;
      const q = (xs: number[]) => (xs.length ? [quantile(xs, 0.05)!, quantile(xs, 0.95)!] as [number, number] : null);
      const w1 = q(values[k].w1[n]);
      const w4 = q(values[k].w4[n]);
      const wide = !w1 ? w4 : !w4 ? w1 : w4[1] - w4[0] > w1[1] - w1[0] ? w4 : w1;
      b[n] = { point, w1, w4, lo: wide ? wide[0] : null, hi: wide ? wide[1] : null, by: wide ? (wide === w4 ? "4wk" : "1wk") : null };
    }
    return [k, { rearrangements: { w1: plans.w1.length, w4: plans.w4.length }, numbers: b }];
  }));
  return { weeks: L, first_week: iso(weekStart(wk.first)), bands };
};

// ---- all of part 3, printed --------------------------------------------------------------------

export const runExtras = async (study: Study, cfg: Config, main: TradeStats, cellsIn: Record<string, Summary>, rowsIn: Record<string, Summary>, suspect: string[], intervals: { trades: number }) => {
  const checks: Record<string, Check> = {};
  const plant = cfg.plant;
  const times: Record<string, number> = {};
  const clock = (name: string, t0: number) => (times[name] = performance.now() - t0);

  // the cells again on the path itself (their runs: the kept and skipped, the identity)
  let t0 = performance.now();
  const cells: Record<string, ReturnType<typeof baseRun>> = {};
  for (const k of new Set([...OWNER, ...THIN_CELLS])) {
    cells[k] = baseRun(study, k, plant);
    // the same run as part 2's (the numbers printed above)
    tally((checks.extras_same_cells ??= newCheck()), cells[k].summary.final_equity === cellsIn[k]?.final_equity && cells[k].summary.mdd_yen === cellsIn[k]?.mdd_yen, () => `${k}: run again ${cells[k].summary.final_equity}, part 2's ${cellsIn[k]?.final_equity}`);
  }
  clock("cells", t0);

  t0 = performance.now();
  const windows = windowsOf(study, plant);
  clock("windows", t0);
  t0 = performance.now();
  const orders = await ordersPart(study, plant);
  clock("orders", t0);
  t0 = performance.now();
  const kept = Object.fromEntries(THIN_CELLS.map((k) => [k, keptPart(cells[k].orders, cells[k].run)]));
  clock("kept", t0);
  t0 = performance.now();
  const thin = cfg.thin > 0 ? thinPart(study, cells, cfg.thin, checks) : null;
  clock("thin", t0);
  t0 = performance.now();
  const boot = bootPart(study, plant, cfg.boot, checks, cells);
  clock("boot", t0);
  const differ = Object.values(checks).reduce((a, c) => a + c.mismatched, 0);

  // ---- printed ------------------------------------------------------------------------------
  console.log(`\n== PART 3: the windows, the orders, the kept and the skipped, the thinning, the weeks rearranged (${Object.entries(times).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(", ")})`);
  for (const [name, c] of Object.entries(checks)) console.log(`  ${name}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.slice(0, 5).join("; ") : ""}`);
  console.log(differ === 0 ? "  PART 3'S CHECKS: EVERY ONE 0 DIFFER" : `  PART 3'S CHECKS DIFFER (${differ}): the numbers below are not to be read`);

  const beside = (s: Summary) => `TP1 first ${pct(s.win_all)} (of those ended ${pct(s.win_resolved)}), ${num(s.mean_pips)} pips a trade, ${yen(s.mean_yen)} a trade`;
  console.log(`\n== E* IN 52-WEEK WINDOWS (F10k_C0; each window's own emails followed to their exits, its P/L 0 at its start; windows ending after the last entry not used): ${windows.count} windows, median ${yen(windows.median)}, most ${yen(windows.max)} (the window from ${windows.max_start}, set by its ${windows.max_set_by} term); the whole period's ${yen(cellsIn.F10k_C0?.estar?.value)}`);

  console.log(`\n== THE ORDER OF ONE CLOSE'S EMAILS (${ORDERS} orders by sha256; min / median / max; the broker's order beside)`);
  let orderRanges = 0;
  for (const k of ORDER_CELLS) {
    const r = orders.ranges[k];
    const s = cellsIn[k];
    const f10k = s.sizing === "F10k";
    const mm = (n: string, f: (x: number) => string) => {
      const x = r[n];
      orderRanges++;
      return x ? `${f(x.min)} / ${f(x.median)} / ${f(x.max)}` : "-";
    };
    console.log(`  ${k.padEnd(9)} ${f10k ? "yen" : "ends"} ${mm(f10k ? "total_yen" : "final_equity", yen)} (broker's ${yen(f10k ? s.total_yen : s.final_equity)}); fall ${mm("mdd_yen", yen)}; worst week ${mm("worst_week_yen", yen)}; taken ${mm("taken", count)}; TP1 first ${mm("win_all", (x) => pct(x))}, pips a trade ${mm("mean_pips", (x) => num(x))}`);
  }

  console.log(`\n== THE CAPS AND THE MARGIN AGAINST TAKING FEWER (§8.99 上限と証拠金の確かめ; R = pips ÷ 13 of each email's own trade)`);
  let permBands = 0;
  for (const k of THIN_CELLS) {
    const x = kept[k];
    const band = (b: [number, number] | null) => {
      if (b) permBands++;
      return b ? `[${num(b[0], 3)}, ${num(b[1], 3)}]` : "-";
    };
    const s = cellsIn[k];
    console.log(`  ${k.padEnd(9)} kept ${x.kept} (R ${num(x.mean_r_kept, 3)}), skipped ${x.skipped} (R ${num(x.mean_r_skipped, 3)}): kept less skipped ${num(x.diff, 3)} R; 95% within the week ${band(x.perm_band)}, within the week and pair ${band(x.perm_pair_band)}; the spread added back ${num(x.diff_nospread, 3)} R; the cell: ${beside(s)}`);
    if (thin) {
      const t = thin.ranks[k];
      const place = (p: { below: number; equal: number; of: number }) => `${p.below} of ${p.of} below it${p.equal ? `, ${p.equal} equal` : ""}`;
      console.log(`  ${"".padEnd(9)} skipping as many at random in each week (${t.final_equity.of} draws, no cap; taken ${t.taken ? `${t.taken.min}..${t.taken.max}, median ${t.taken.median}` : "-"}, the cell ${t.cell_taken}): the cell's ${s.sizing === "F10k" ? "yen" : "final account"} ${yen(s.final_equity)}: ${place(t.final_equity)}; its fall ${yen(s.mdd_yen)}: ${place(t.mdd_yen)}; its worst week ${yen(s.worst_week_yen)}: ${place(t.worst_week_yen)}`);
    }
  }

  // the owner's table: each cell with its band, its orders' range, its halves and years
  let bootBands = 0;
  console.log(`\n== THE OWNER'S TABLE (the 13 cells §8.99 shows; [the 5–95% band from ${cfg.boot} one-week and ${cfg.boot} four-week rearrangements of the ${boot.weeks} weeks from ${boot.first_week}, the wider of the two]; TP1 first and pips a trade beside each)`);
  if (!cfg.boot) console.log(`  (BOOT=0: no rearrangements, no bands)`);
  for (const k of OWNER) {
    const s = cellsIn[k];
    const b = boot.bands[k].numbers;
    const f10k = s.sizing === "F10k";
    const band = (n: string, f: (x: number) => string) => {
      const x = b[n];
      if (!x || x.lo === null || x.hi === null) return "";
      bootBands++;
      return ` [${f(x.lo)} .. ${f(x.hi)}, ${x.by}]`;
    };
    const money = f10k ? `yen ${yen(s.total_yen)}${band("total_yen", yen)}` : `ends ${yen(s.final_equity)} (${num(100 * (s.final_pct ?? 0), 1)}%)${band("final_equity", yen)}`;
    console.log(`  ${k.padEnd(9)} ${money}; fall ${yen(s.mdd_yen)}${band("mdd_yen", yen)} (${pct(s.mdd_pct)}${f10k ? " of E*+peak" : ""}${band("mdd_pct", (x) => pct(x))}); worst week ${yen(s.worst_week_yen)}${band("worst_week_yen", yen)}, day ${yen(s.worst_day_yen)}${band("worst_day_yen", yen)}${f10k && s.estar ? `; E* ${yen(s.estar.value)}${band("estar", yen)}` : ""}`);
    console.log(`  ${"".padEnd(9)} taken ${count(s.taken)}${band("taken", count)} (skipped cap ${s.skipped.cap}, margin ${s.skipped.margin}, lot ${s.skipped.lot}, call ${s.skipped.call}); ${f10k ? "no call or loss-cut (by the F10k rule)" : `calls ${s.calls}${band("calls", count)}, loss-cuts ${s.losscuts}${band("losscuts", count)}`}${s.shortfall_yen ? `, SHORTFALL ${yen(s.shortfall_yen)}` : ""}; ${beside(s)}`);
    console.log(`  ${"".padEnd(9)} halves ${yen(s.halves_yen[0])} / ${yen(s.halves_yen[1])}; years ${Object.entries(s.years_yen).map(([y, v]) => `${y} ${yen(v)}`).join(", ")}; a year ${f10k ? yen(s.a_year) : pct(s.a_year)}${ORDER_CELLS.includes(k) ? `; ${ORDERS} orders: ${f10k ? "yen" : "ends"} ${yen(orders.ranges[k][f10k ? "total_yen" : "final_equity"]?.min)} .. ${yen(orders.ranges[k][f10k ? "total_yen" : "final_equity"]?.max)}` : "; the order of one close's emails does not matter here"}`);
  }
  if (cellsIn.F10k_C0?.estar) {
    const e = cellsIn.F10k_C0.estar;
    const z = rowsIn["row_zero_F10k_C0"]?.estar;
    console.log(`\n== THE HEADLINE AGAIN: E* ${yen(e.value)} (${e.set_by} at ${e.g}: ${yen(e.lost)} lost by then + ${yen(e.margin)} the margin)${boot.bands.F10k_C0.numbers.estar?.lo != null ? `; the weeks rearranged [${yen(boot.bands.F10k_C0.numbers.estar.lo)} .. ${yen(boot.bands.F10k_C0.numbers.estar.hi)}, ${boot.bands.F10k_C0.numbers.estar.by}]` : ""}; 52-week windows median ${yen(windows.median)}, most ${yen(windows.max)}; the P/L made 0 ${yen(z?.value)}; beside it TP1 first ${pct(main.win_all)} (of those ended ${pct(main.win_resolved)}), ${num(main.mean_pips)} pips a trade [${num(main.low_end)}, ${num(main.high_end)}], ${yen(main.mean_yen)} a trade at 10,000 units [${yen(main.yen_low_end)}, ${yen(main.yen_high_end)}], ${yen(main.yen_year)} a year [${yen(main.yen_year_low)}, ${yen(main.yen_year_high)}]`);
    console.log(`   looking back over this period: the longer it runs, the more is lost; the bands are "the same weeks in another order", not a forecast (nothing like 2015's Swiss franc is in them)`);
  }

  // the look-ahead to look for before reporting (§8.99 先読みを疑うとき, part 3's)
  const before = suspect.length;
  for (const k of THIN_CELLS) {
    const x = kept[k];
    if (x.diff === null) continue;
    const over = [x.perm_band, x.perm_pair_band].filter((b) => b && x.diff! > b[1]);
    if (over.length) suspect.push(`${k}: the kept less the skipped ${num(x.diff, 3)} R a trade, above the top of ${over.length === 2 ? "both bands" : x.perm_band && x.diff > x.perm_band[1] ? "the within-week band" : "the within-week-and-pair band"} (tops ${num(x.perm_band?.[1], 3)} and ${num(x.perm_pair_band?.[1], 3)}): the kept looking better than chance`);
  }
  console.log(`\n== LOOK-AHEAD TO CHECK BEFORE REPORTING (part 3: ${suspect.length - before}; all: ${suspect.length})`);
  for (const x of suspect) console.log(`  ${x}`);

  // §8.99: the intervals and bands looked at, counted by the program
  const looked = { trades: intervals.trades, boot_bands: bootBands, perm_bands: permBands, order_ranges: orderRanges };
  console.log(`\n== INTERVALS AND BANDS PRINTED: ${Object.values(looked).reduce((a, x) => a + x, 0)} (the trades' intervals ${looked.trades}, the rearrangements' bands ${looked.boot_bands}, the permutation bands ${looked.perm_bands}, the orders' ranges ${looked.order_ranges}); none is a reason to change anything before it is fixed in advance and seen on trades from 2026-10-05 (§8.24 ④)`);

  return {
    checks,
    differ,
    json: {
      windows,
      orders: orders.finals,
      order_ranges: orders.ranges,
      kept,
      thin: thin?.draws ?? null,
      thin_ranks: thin?.ranks ?? null,
      boot: { weeks: boot.weeks, first_week: boot.first_week, count: cfg.boot, ...boot.bands },
      looked,
      times_ms: times,
      counts: { boot: cfg.boot, thin: cfg.thin, perm: PERM, orders: ORDERS },
    },
  };
};
