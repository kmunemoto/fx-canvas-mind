// #206 (docs §8.103, 段1: 2「スプレッドの数え方」・3「避ける枠の決め方」・7 の (1)・(9)): the spread of GMO's
// 1-minute bars of the five pairs, 2024-01-01 to 2026-10-03, in UTC's 15-minute slots apart in the US summer
// and winter; the slots to avoid; research/ledger/spread-hours.csv. No signal, no trade and no move after a
// signal is computed here (ownerhold-data.ts imports the signal code when it is loaded; none of it is called).
//
//   MODE=synthetic  7 (1): the five pairs' walks with spreads set by the time of day (the planted slots),
//                   written as GMO's day files and read back the way the real run reads them; the slots the
//                   program avoids against the list written beforehand; the planted errors of 7 (9) on the
//                   same bars, each written out for the Python (spreadhours-check.py), whose answer must differ
//   MODE=real       GMO's 1-minute bars (CACHE_DIR, fetched where missing); the checks of 2; the table and
//                   the file only when every check passed (OUT); nothing of the table is printed
//   MODE=print      the file of a real run that passed (and that the Python agreed with): its rows, sha256,
//                   and what docs §8.103 3 writes down (the slots avoided, base, the threshold, the share)
//   PLANT=prestart|keys (with MODE=synthetic): the two planted errors that read other bars; the run must stop

import { DAY, MINUTE } from "./lib.ts";
import { type LoadStats, type M1, PAIRS, type Source, keysOf, loadM1, newLoadStats, synthesize, writeGmoFiles } from "./ownerhold-data.ts";
import {
  CSV_HEADER, type CsvRow, MAX_AVOID, MIN_BARS, S1_END, S1_KEY_MAX, S1_KEY_MIN, S1_START, SEASONS, SLOTS, type Season,
  avoided, cellOf, csvLine, hhmm, quantileSorted, seasonOf, sha256Hex, slotOf, threshold2, tickScale, twiceMedian,
} from "./spreadhours-lib.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const OUT = env("OUT", "research/out/spreadhours");
const CACHE = env("CACHE_DIR", "research/.cache");
const PLANT = env("PLANT", "");
const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "-");
const log = (...a: unknown[]) => console.log(...a);

// the planted errors of 7 (9) that change the computing (the bars are the same)
const COMPUTE_PLANTS = ["mean", "season", "strict", "baseMean", "usdUnit"] as const;

export interface PairTable {
  pair: string;
  // the day files opened (their first and last key) and the bars kept (the first open, the last close)
  keyMin: string;
  keyMax: string;
  tMin: number;
  tMax: number;
  bars: number;
  dropped: { oneSide: number; crossed: number; closure: number; repeated: number };
  failed: number;
  // spreads that were not a whole 0.1 pips (beyond 1e-6 of one): 0, or the run stops
  notWhole: number;
  base2: number;
  thr2: number;
  // 192 cells: summer's 96 slots, then winter's
  cells: Array<{ season: Season; slot: number; bars: number; med2: number | null; sum: number; p90: number | null; avoid: boolean }>;
}

// One pair's table (2, 3). `plant`: one of COMPUTE_PLANTS, or "".
export const tableOf = (m: M1, st: LoadStats, keys: string[], plant = ""): PairTable => {
  const n = m.n;
  const scale = plant === "usdUnit" ? 1000 : tickScale(m.pair);
  const s = new Int32Array(n);
  const cell = new Uint8Array(n);
  let notWhole = 0;
  for (let k = 0; k < n; k++) {
    const d = (m.ac[k] - m.bc[k]) * scale;
    const r = Math.round(d);
    if (Math.abs(d - r) > 1e-6) notWhole++;
    s[k] = r;
    cell[k] = plant === "season" ? slotOf(m.t[k]) : cellOf(m.t[k]);
  }
  const counts = new Int32Array(2 * SLOTS);
  for (let k = 0; k < n; k++) counts[cell[k]]++;
  const off = new Int32Array(2 * SLOTS + 1);
  for (let c = 0; c < 2 * SLOTS; c++) off[c + 1] = off[c] + counts[c];
  const buf = new Int32Array(n);
  const fill = off.slice(0, 2 * SLOTS);
  for (let k = 0; k < n; k++) buf[fill[cell[k]]++] = s[k];
  const all = Int32Array.from(s).sort();
  let sumAll = 0;
  for (let k = 0; k < n; k++) sumAll += s[k];
  const base2 = !n ? 0 : plant === "baseMean" ? (2 * sumAll) / n : twiceMedian(all)!;
  const thr2 = threshold2(base2);
  const cells: PairTable["cells"] = [];
  for (let c = 0; c < 2 * SLOTS; c++) {
    const sub = buf.subarray(off[c], off[c + 1]).sort();
    let sum = 0;
    for (let i = 0; i < sub.length; i++) sum += sub[i];
    const med2 = twiceMedian(sub);
    const bars = sub.length;
    const by = plant === "mean" ? (bars ? (2 * sum) / bars : null) : med2;
    const avoid = plant === "strict" ? bars >= MIN_BARS && by !== null && by > thr2 : avoided(bars, by, base2);
    cells.push({ season: SEASONS[c < SLOTS ? 0 : 1], slot: c % SLOTS, bars, med2, sum, p90: quantileSorted(sub, 0.9), avoid });
  }
  return {
    pair: m.pair,
    keyMin: keys[0],
    keyMax: keys[keys.length - 1],
    tMin: n ? m.t[0] : NaN,
    tMax: n ? m.t[n - 1] + MINUTE : NaN,
    bars: n,
    dropped: { oneSide: st.oneSide, crossed: st.crossed, closure: st.closure, repeated: st.repeated },
    failed: st.failed,
    notWhole,
    base2,
    thr2,
    cells,
  };
};

// 2's checks on one pair's table (a failure's text, or none)
export const checksOf = (t: PairTable): string[] => {
  const bad: string[] = [];
  if (t.failed !== 0) bad.push(`${t.pair}: ${t.failed} GMO reads failed`);
  if (!(t.keyMin >= S1_KEY_MIN && t.keyMax <= S1_KEY_MAX)) bad.push(`${t.pair}: the day files opened ${t.keyMin}..${t.keyMax}, outside ${S1_KEY_MIN}..${S1_KEY_MAX}`);
  if (!t.bars) bad.push(`${t.pair}: no bar kept`);
  else if (!(t.tMin >= S1_START && t.tMax <= S1_END)) bad.push(`${t.pair}: the bars kept ${iso(t.tMin)}..${iso(t.tMax)}, outside ${iso(S1_START)}..${iso(S1_END)}`);
  if (t.notWhole !== 0) bad.push(`${t.pair}: ${t.notWhole} spreads not a whole 0.1 pips`);
  return bad;
};

const rowsOf = (t: PairTable): CsvRow[] => t.cells.map((c) => ({ pair: t.pair, season: c.season, slot: c.slot, bars: c.bars, med2: c.med2, sum: c.sum, p90: c.p90, base2: t.base2, thr2: t.thr2, avoid: c.avoid }));
const fileOf = (tables: PairTable[]) => [CSV_HEADER, ...tables.flatMap(rowsOf).map(csvLine)].join("\n") + "\n";

const writeDump = async (dir: string, tables: PairTable[]) => {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/table.json`, JSON.stringify({ start: S1_START, end: S1_END, keyMin: S1_KEY_MIN, keyMax: S1_KEY_MAX, tables }));
};

const loadPair = async (src: Source, pair: string, from: number, to: number) => {
  const st = newLoadStats();
  const keys = keysOf(from, to).keys;
  const m = await loadM1(src, pair, from, to, st);
  return { m, st, keys };
};

// ---- the synthetic walks (7 (1)) ----------------------------------------------------------------

// the slots planted wide on every pair: New York's 17:00-18:44 (the day's roll), summer 21:00-22:44 UTC and
// winter 22:00-23:44 UTC, +12 pips
const WIDE: Record<Season, number[]> = { summer: [84, 85, 86, 87, 88, 89, 90], winter: [88, 89, 90, 91, 92, 93, 94] };
// Pips added in the minute starting at t (pi: the pair's index in PAIRS). The walks' own spreads: USD/JPY 0.2,
// EUR/JPY 0.5, AUD/JPY 0.6, EUR/USD 0.3, AUD/USD 0.5 (pips), so the thresholds max(3 × base, 1.0) are 1.0, 1.5,
// 1.8, 1.0 and 1.5 pips.
const plantedSpread = (pi: number, t: number): number => {
  const season = seasonOf(t);
  const slot = slotOf(t);
  if (WIDE[season].includes(slot)) return 12;
  if (pi === 0) {
    // USD/JPY: 1.0 pips, the threshold exactly (avoided); 0.9, 0.1 under it (not); 0.8, over 3 × base but
    // under 1.0 pips (not)
    if (slot === 40) return 0.8;
    if (slot === 41) return 0.7;
    if (slot === 48) return 0.6;
  }
  if (pi === 2) {
    // AUD/JPY (base 0.6): 1.2, over 1.0 pips but under 3 × base (not); 1.8, 3 × base exactly (avoided); 1.7 (not)
    if (slot === 48) return 0.6;
    if (slot === 52) return 1.2;
    if (slot === 53) return 1.1;
  }
  // EUR/USD: +20 pips on Fridays only (not: the slot's median is the other days')
  if (pi === 3 && slot === 56 && new Date(t).getUTCDay() === 5) return 20;
  // AUD/USD: +40 pips one day in ten (not: only the mean passes the threshold)
  if (pi === 4 && slot === 60 && Math.floor(t / DAY) % 10 === 0) return 40;
  return 0;
};
// the slots to avoid, written before the run: the wide slots on every pair, and the two set at the threshold
const EXPECTED: Record<string, Record<Season, number[]>> = Object.fromEntries(
  PAIRS.map((p) => {
    const extra = p === "USD/JPY" ? [40] : p === "AUD/JPY" ? [52] : [];
    return [p, { summer: [...WIDE.summer, ...extra].sort((a, b) => a - b), winter: [...WIDE.winter, ...extra].sort((a, b) => a - b) }];
  }),
);
// the synthetic files hold three days before the period, so a read that strays before 2024 finds bars (PLANT)
const SYN_FROM = S1_START - 3 * DAY;

const avoidList = (t: PairTable, season: Season) => t.cells.filter((c) => c.season === season && c.avoid).map((c) => c.slot);
const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// each planted slot where it was meant to be (the walks test what they claim to)
const plantedWhere = (tables: PairTable[]): string[] => {
  const bad: string[] = [];
  const cellAt = (pair: string, season: Season, slot: number) => tables.find((t) => t.pair === pair)!.cells[(season === "summer" ? 0 : SLOTS) + slot];
  const tab = (pair: string) => tables.find((t) => t.pair === pair)!;
  for (const season of SEASONS) {
    const uj = tab("USD/JPY");
    if (cellAt("USD/JPY", season, 40).med2 !== uj.thr2) bad.push(`USD/JPY ${season} 10:00: not at the threshold`);
    if (cellAt("USD/JPY", season, 41).med2 !== uj.thr2 - 2) bad.push(`USD/JPY ${season} 10:15: not 0.1 pips under the threshold`);
    const c48 = cellAt("USD/JPY", season, 48).med2!;
    if (!(c48 >= 3 * uj.base2 && c48 < 20)) bad.push(`USD/JPY ${season} 12:00: not over 3 × base and under 1.0 pips`);
    const aj = tab("AUD/JPY");
    const a48 = cellAt("AUD/JPY", season, 48).med2!;
    if (!(a48 >= 20 && a48 < 3 * aj.base2)) bad.push(`AUD/JPY ${season} 12:00: not over 1.0 pips and under 3 × base`);
    if (cellAt("AUD/JPY", season, 52).med2 !== aj.thr2 || aj.thr2 !== 3 * aj.base2) bad.push(`AUD/JPY ${season} 13:00: not at 3 × base`);
    if (cellAt("AUD/JPY", season, 53).med2 !== aj.thr2 - 2) bad.push(`AUD/JPY ${season} 13:15: not 0.1 pips under the threshold`);
    const eu = cellAt("EUR/USD", season, 56);
    if (!(eu.p90! >= 200 && eu.med2! < tab("EUR/USD").thr2)) bad.push(`EUR/USD ${season} 14:00: the Fridays not wide, or the median wide`);
    const au = cellAt("AUD/USD", season, 60);
    if (!((2 * au.sum) / au.bars >= tab("AUD/USD").thr2 && au.med2! < tab("AUD/USD").thr2)) bad.push(`AUD/USD ${season} 15:00: the mean not over the threshold, or the median over it`);
  }
  return bad;
};

const synthetic = async () => {
  const gmo = `${OUT}/gmo`;
  log(`== 7 (1): the five pairs' walks with the planted spreads, ${iso(SYN_FROM)} .. ${iso(S1_END)}`);
  for (const [pi, pair] of PAIRS.entries()) {
    const w = synthesize(pair, pi, { seed: 1, trend: 0, startPips: null, extraSpread: plantedSpread }, SYN_FROM, S1_END);
    await writeGmoFiles(gmo, pair, w, SYN_FROM, S1_END);
  }
  const src: Source = { dir: gmo, fetch: false };
  if (PLANT === "prestart" || PLANT === "keys") {
    // the reads that stray: one bar before 2024 kept (prestart), or a day file before the list opened (keys)
    const from = PLANT === "prestart" ? S1_START - MINUTE : S1_START - 2 * DAY;
    const bad: string[] = [];
    for (const pair of PAIRS) {
      const { m, st, keys } = await loadPair(src, pair, from, S1_END);
      bad.push(...checksOf(tableOf(m, st, keys)));
    }
    log(bad.length ? `PLANT ${PLANT}: stopped (${bad.length} checks failed; first: ${bad[0]})` : `PLANT ${PLANT}: NOT STOPPED`);
    Deno.exit(bad.length ? 3 : 0);
  }
  const tables: PairTable[] = [];
  const planted: Record<string, PairTable[]> = Object.fromEntries(COMPUTE_PLANTS.map((p) => [p, []]));
  let failed = false;
  for (const pair of PAIRS) {
    const { m, st, keys } = await loadPair(src, pair, S1_START, S1_END);
    const t = tableOf(m, st, keys);
    tables.push(t);
    for (const p of COMPUTE_PLANTS) planted[p].push(tableOf(m, st, keys, p));
    const bad = checksOf(t);
    log(`${pair}: ${t.bars} bars, day files ${t.keyMin}..${t.keyMax}, bars ${iso(t.tMin)}..${iso(t.tMax)}, dropped ${JSON.stringify(t.dropped)}, base ${(t.base2 / 20).toFixed(2)} pips, threshold ${(t.thr2 / 20).toFixed(2)}`);
    for (const b of bad) log(`  CHECK FAILED ${b}`);
    if (bad.length) failed = true;
    for (const season of SEASONS) {
      const got = avoidList(t, season);
      const want = EXPECTED[pair][season];
      const ok = sameList(got, want);
      log(`  ${season}: avoided ${got.map(hhmm).join(" ")} ${ok ? "= the list written before" : `≠ the list written before (${want.map(hhmm).join(" ")})`}`);
      if (!ok) failed = true;
    }
  }
  const where = plantedWhere(tables);
  for (const b of where) log(`  PLANTED SLOT NOT AS MEANT ${b}`);
  if (where.length) failed = true;
  await writeDump(`${OUT}/dump`, tables);
  // each planted error: something it changed, and the list check it fails (the Python's comparison is apart)
  log(`== 7 (9): the planted errors of stage 1`);
  for (const p of COMPUTE_PLANTS) {
    const ts = planted[p];
    const changed = ts.reduce((s, t, i) => s + t.cells.filter((c, j) => c.avoid !== tables[i].cells[j].avoid || c.med2 !== tables[i].cells[j].med2 || c.sum !== tables[i].cells[j].sum).length + (t.base2 !== tables[i].base2 ? 1 : 0), 0);
    const caught = ts.some((t) => SEASONS.some((s) => !sameList(avoidList(t, s), EXPECTED[t.pair][s])));
    log(`  ${p}: changed ${changed} cells or bases; ${caught ? "caught by the list written before" : "NOT CAUGHT by the list"}`);
    if (!changed || !caught) failed = true;
    await writeDump(`${OUT}/plant-${p}`, ts);
  }
  log(failed ? "SYNTHETIC: FAILED" : "SYNTHETIC: passed (the Python's comparisons follow)");
  if (failed) Deno.exit(1);
};

// ---- the real bars ------------------------------------------------------------------------------

const real = async () => {
  const src: Source = { dir: CACHE, fetch: true };
  const tables: PairTable[] = [];
  const bad: string[] = [];
  for (const pair of PAIRS) {
    const { m, st, keys } = await loadPair(src, pair, S1_START, S1_END);
    const t = tableOf(m, st, keys);
    tables.push(t);
    // 2: the four values written to the log, the bars left out, the checks
    log(`${pair}: day files ${t.keyMin}..${t.keyMax} (${keys.length}), bars ${iso(t.tMin)}..${iso(t.tMax)} (${t.bars}), left out ${JSON.stringify(t.dropped)}, GMO reads ${st.requests} (failed ${st.failed}), kept files read ${st.cached}`);
    if (st.failed) log(`  failed reads: ${JSON.stringify(st.failedWhy)} ${st.failedExamples.join("; ")}`);
    bad.push(...checksOf(t));
  }
  for (const b of bad) log(`CHECK FAILED ${b}`);
  if (bad.length) {
    log("REAL: a check failed; no table and no file were written");
    Deno.exit(1);
  }
  await writeDump(`${OUT}/dump`, tables);
  await Deno.writeTextFile(`${OUT}/spread-hours.csv`, fileOf(tables));
  log("REAL: every check passed; the table and spread-hours.csv written (printed by MODE=print once the Python agrees)");
};

// ---- the file printed (once the Python agreed) --------------------------------------------------

const jst = (slot: number) => hhmm((slot + 36) % SLOTS);
const printFile = async () => {
  const text = await Deno.readTextFile(`${OUT}/spread-hours.csv`);
  const { tables } = JSON.parse(await Deno.readTextFile(`${OUT}/dump/table.json`)) as { tables: PairTable[] };
  if (text !== fileOf(tables)) throw new Error("spread-hours.csv is not the table's");
  log(`== research/ledger/spread-hours.csv (${text.split("\n").length - 2} rows), sha256 ${await sha256Hex(text)}`);
  log(text.trimEnd());
  log(`== the slots avoided (UTC, and JST), base, the threshold, and the share of the pair's 1-minute bars in them`);
  const stops: string[] = [];
  for (const t of tables) {
    for (const season of SEASONS) {
      const cs = t.cells.filter((c) => c.season === season);
      const av = cs.filter((c) => c.avoid);
      const share = av.reduce((s, c) => s + c.bars, 0) / Math.max(1, cs.reduce((s, c) => s + c.bars, 0));
      log(`${t.pair} ${season}: ${av.length} slots ${av.map((c) => `${hhmm(c.slot)}(JST ${jst(c.slot)})`).join(" ") || "none"}; base ${(t.base2 / 20).toFixed(2)} pips, threshold ${(t.thr2 / 20).toFixed(2)}; ${(100 * share).toFixed(2)}% of the season's bars`);
      if (av.length > MAX_AVOID) stops.push(`${t.pair} ${season}: ${av.length} slots (over ${MAX_AVOID})`);
    }
    const few = t.cells.filter((c) => c.bars < MIN_BARS);
    if (few.length) log(`${t.pair}: ${few.length} slots under ${MIN_BARS} bars (not avoided): ${few.map((c) => `${c.season} ${hhmm(c.slot)} ${c.bars}`).join(", ")}`);
  }
  const winter = tables.some((t) => t.cells.some((c) => c.season === "winter" && c.avoid));
  const any = tables.some((t) => t.cells.some((c) => c.avoid));
  log(`== 3's stops: ${stops.length ? stops.join("; ") : "no pair and season over 32 slots"}; ${winter ? "winter slots avoided on some pair" : "NO WINTER SLOT AVOIDED (2023 cannot test the rule)"}; ${any ? "" : "NO SLOT AVOIDED AT ALL"}`);
};

if (MODE === "synthetic") await synthetic();
else if (MODE === "real") await real();
else if (MODE === "print") await printFile();
else throw new Error(`MODE ${MODE}`);
