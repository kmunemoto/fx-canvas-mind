// 法則探し (docs §8.136, research/lawsearch-spec.md 17.2): the comparison files of research/lawsearch-dump.md, builder D
// (research/lawsearch-design.md 7.5). The TS writes them under <RUN>/ts/; the Python writes the same names under
// <RUN>/py/ and its comparator matches them under spec 17.2's rules. File names, columns, row order and number
// formats are lawsearch-dump.md's. This module imports only types, rules and const (no study module), so that
// `deno info` of the stage-0 program lists no trade, stats or select module through it.
//
// Additions to lawsearch-design.md 7.5's signatures (reported to the lead; each optional where it can be):
//   * dumpBlind keeps the base table's counts until its late table is dumped, then writes the one blind_counts.csv
//     row of (tf, half) (the row holds both tables' numbers);
//   * dumpTrades takes the late table's per-base-row reason (0 kept, 1 no entry, 2 ④, 3 end) for late_why;
//   * dumpStage1 takes the IUT p map (p_iut) and the skip label function (the labels live in lawsearch-select.ts);
//   * dumpStage2 takes κ and rows with the label and D_F's interval (lawsearch-select.ts Stage2RowX).

import { MID_DIGITS, PAIRS } from "./lawsearch-const.ts";
import { REASONS } from "./lawsearch-rules.ts";
import type {
  BlindTable,
  CheckResult,
  CutFailRow,
  ExclCtx,
  RunConfig,
  SkipReason,
  Stage0Row,
  Stage1Cand,
  Stage1Explain,
  Stage1Out,
  Stage2Cand,
  Stage2Row,
  SuspectRow,
  TfKey,
  TfSet,
  TrialMeasures,
  TrialRows,
  TrialSignals,
  Universe,
  ValueEst,
} from "./lawsearch-types.ts";

// ---- formats (lawsearch-dump.md 3) ------------------------------------------------------------------------------

export function fmtInt(x: number | null): string {
  if (x === null || x === undefined) return "";
  if (!Number.isInteger(x)) throw new Error(`fmtInt: ${x} is not an integer`);
  return String(x);
}
export function fmtReal(x: number | null): string {
  return x === null || x === undefined || Number.isNaN(x) ? "" : String(x);
}
export function fmtBool(x: boolean | null): string {
  return x === null || x === undefined ? "" : x ? "1" : "0";
}
export function fmtTri(x: number): string {
  return x === 1 ? "1" : x === 0 ? "0" : "";
}
const fmtDec = (x: number, d: number): string => (Number.isNaN(x) ? "" : x.toFixed(d));
const SYM = (pair: string): string => pair.replace("/", "_");
const HALF_TEXT: Readonly<Record<number, string>> = { 0: "", 1: "first", 2: "second", 3: "stage3" };

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const checkField = (f: string, path: string): string => {
  if (f.includes(",") || f.includes("\n") || f.includes("\r")) throw new Error(`writeCsv ${path}: a field holds a comma or a line end: ${JSON.stringify(f)}`);
  return f;
};
const enc = new TextEncoder();

// UTF-8, LF, one header line, no quoting (a field with a comma stops the run)
export async function writeCsv(path: string, header: readonly string[], rows: Iterable<readonly string[]>): Promise<void> {
  await writeCsvMode(path, header, rows, false);
}
async function writeCsvMode(path: string, header: readonly string[], rows: Iterable<readonly string[]>, append: boolean): Promise<void> {
  const dir = parentOf(path);
  if (dir) await Deno.mkdir(dir, { recursive: true });
  let exists = false;
  if (append) {
    try {
      await Deno.stat(path);
      exists = true;
    } catch {
      exists = false;
    }
  }
  const parts: string[] = [];
  if (!exists) parts.push(header.map((h) => checkField(h, path)).join(",") + "\n");
  for (const r of rows) {
    if (r.length !== header.length) throw new Error(`writeCsv ${path}: a row of ${r.length} fields, the header ${header.length}`);
    parts.push(r.map((f) => checkField(f, path)).join(",") + "\n");
  }
  const text = parts.join("");
  const f = await Deno.open(path, append ? { write: true, create: true, append: true } : { write: true, create: true, truncate: true });
  try {
    const bytes = enc.encode(text);
    let off = 0;
    while (off < bytes.length) off += await f.write(bytes.subarray(off));
  } finally {
    f.close();
  }
}
const appendCsv = (path: string, header: readonly string[], rows: Iterable<readonly string[]>) => writeCsvMode(path, header, rows, true);

// ---- 2. config.json ---------------------------------------------------------------------------------------------

export async function dumpConfig(dir: string, cfg: RunConfig): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/config.json`, JSON.stringify(cfg) + "\n");
}

// ---- 4. load.csv, askbid.csv ------------------------------------------------------------------------------------

const LOAD_HEADER = ["stage", "pair", "tf", "from_ms", "to_ms", "keys_first", "keys_last", "keys", "files_read", "read_failures", "unparseable_rows", "value_stops", "dropped_ask_lt_bid", "same_start_bid_rows", "bars", "first_s", "last_s", "ohlc_bad", "dup_starts", "band_bad"];
const TF_ORDER: Readonly<Record<string, number>> = { m15: 0, h1: 1 };

export async function dumpLoad(dir: string, u: Universe, stage: string): Promise<void> {
  const reps = [...u.load].sort((a, b) => PAIRS.indexOf(a.pair) - PAIRS.indexOf(b.pair) || TF_ORDER[a.tf] - TF_ORDER[b.tf]);
  await appendCsv(`${dir}/load.csv`, LOAD_HEADER, reps.map((r) => [
    stage, r.pair, r.tf, fmtInt(r.fromMs), fmtInt(r.toMs), r.keys[0] ?? "", r.keys[r.keys.length - 1] ?? "", fmtInt(r.keys.length), fmtInt(r.filesRead), fmtInt(r.readFailures),
    fmtInt(r.unparseableRows), fmtInt(r.valueStops.length), fmtInt(r.droppedAskLtBid), fmtInt(r.sameStartBidRows), fmtInt(r.bars), Number.isNaN(r.first) ? "" : fmtInt(r.first),
    Number.isNaN(r.last) ? "" : fmtInt(r.last), fmtInt(r.ohlcBad), fmtInt(r.dupStarts), fmtInt(r.bandBad),
  ]));
  const ab: string[][] = [];
  for (const r of reps) {
    for (const y of [...r.askLtBidByYear].sort((a, b) => a.year - b.year)) {
      if (y.den === 0) continue;
      ab.push([stage, r.pair, r.tf, fmtInt(y.year), fmtInt(y.num), fmtInt(y.den)]);
    }
  }
  await appendCsv(`${dir}/askbid.csv`, ["stage", "pair", "tf", "year", "num", "den"], ab);
}

// ---- 5. bars, htf, holes, ind -----------------------------------------------------------------------------------

const BAR_HEADER = ["i", "s", "bo", "bh", "bl", "bc", "ao", "ah", "al", "ac", "O", "H", "L", "C", "Po", "Ph", "Pl", "Pc", "Bo", "Bh", "Bl", "Bc", "Ao", "Ah", "Al", "Ac", "day", "g"];
const HTF_HEADER = ["i", "s", "bo", "bh", "bl", "bc", "ao", "ah", "al", "ac", "O", "H", "L", "C", "Po", "Ph", "Pl", "Pc"];

function* barRows(tf: TfSet, pi: number, higher: boolean): Generator<string[]> {
  const s = higher ? tf.htf[pi] : tf.pairs[pi];
  const d = MID_DIGITS(s.pair);
  const g = tf.g[pi];
  for (let i = 0; i < s.n; i++) {
    const row = [
      fmtInt(i), fmtInt(s.s[i]),
      fmtDec(s.bo[i], d), fmtDec(s.bh[i], d), fmtDec(s.bl[i], d), fmtDec(s.bc[i], d), fmtDec(s.ao[i], d), fmtDec(s.ah[i], d), fmtDec(s.al[i], d), fmtDec(s.ac[i], d),
      fmtReal(s.O[i]), fmtReal(s.H[i]), fmtReal(s.L[i]), fmtReal(s.C[i]),
      fmtInt(s.Po[i]), fmtInt(s.Ph[i]), fmtInt(s.Pl[i]), fmtInt(s.Pc[i]),
    ];
    if (!higher) {
      row.push(fmtInt(s.Bo[i]), fmtInt(s.Bh[i]), fmtInt(s.Bl[i]), fmtInt(s.Bc[i]), fmtInt(s.Ao[i]), fmtInt(s.Ah[i]), fmtInt(s.Al[i]), fmtInt(s.Ac[i]), fmtInt(s.day[i]), fmtInt(g[i]));
    }
    yield row;
  }
}

export async function dumpBars(dir: string, u: Universe): Promise<void> {
  for (const tf of [u.m15, u.h1]) {
    for (let pi = 0; pi < PAIRS.length; pi++) {
      const sym = SYM(PAIRS[pi]);
      await writeCsv(`${dir}/bars/${tf.tf}_${sym}.csv`, BAR_HEADER, barRows(tf, pi, false));
      await writeCsv(`${dir}/htf/${tf.tf}_${sym}.csv`, HTF_HEADER, barRows(tf, pi, true));
    }
  }
}

export async function dumpHoles(dir: string, ctx: Record<TfKey, ExclCtx>): Promise<void> {
  const sum: string[][] = [];
  for (const tf of ["m15", "h1"] as const) {
    const h = ctx[tf].holes;
    let open = 0;
    for (let k = 0; k < h.nSlots; k++) open += h.open[k];
    const slots: string[][] = [];
    for (let pi = 0; pi < PAIRS.length; pi++) {
      let present = 0;
      let hole = 0;
      for (let k = 0; k < h.nSlots; k++) {
        present += h.present[pi][k];
        if (h.hole[pi][k]) {
          hole++;
          slots.push([PAIRS[pi], fmtInt(h.fromMs + k * h.step)]);
        }
      }
      sum.push([tf, PAIRS[pi], fmtInt(h.fromMs), fmtInt(h.nSlots), fmtInt(open), fmtInt(present), fmtInt(hole)]);
    }
    await writeCsv(`${dir}/holes/${tf}.csv`, ["pair", "slot"], slots);
  }
  await writeCsv(`${dir}/holes/summary.csv`, ["tf", "pair", "from_ms", "n_slots", "open_slots", "present_slots", "hole_slots"], sum);
}

// lawsearch-dump.md 5: the fixed column order (later items append theirs in table order) and each column's format
export const IND_COLUMNS: readonly string[] = ["RSI14", "RSI14_U", "RSI14_D", "E04_buy", "E04_sell", "DON20_HH", "DON20_LL", "DON20_s", "EMA200", "F01_buy", "F01_sell", "BM_r", "BM_ok", "BM_sigma", "BM_z", "B06_buy", "B06_sell", "B06_keep"];
const indFormat = (name: string): "tri" | "int" | "bool" | "real" => {
  if (/_(buy|sell)$/.test(name)) return "tri";
  if (name === "DON20_s") return "int";
  if (name === "BM_ok" || /_keep$/.test(name)) return "bool";
  return "real";
};

// builds: the dump columns of the built items and filters of the run's trials, per pair (several builds of one pair
// are merged; a column made twice must hold the same values)
export async function dumpInd(dir: string, tf: TfSet, builds: ReadonlyArray<{ pi: number; columns: Record<string, Float64Array | Int8Array | Uint8Array> }>, sigs: TrialSignals[]): Promise<void> {
  for (let pi = 0; pi < PAIRS.length; pi++) {
    const s = tf.pairs[pi];
    const cols = new Map<string, Float64Array | Int8Array | Uint8Array>();
    for (const b of builds) {
      if (b.pi !== pi) continue;
      for (const [name, arr] of Object.entries(b.columns)) {
        if (arr.length !== s.n) throw new Error(`dumpInd: ${name} of pair ${pi} has ${arr.length} values, the series ${s.n}`);
        const had = cols.get(name);
        if (had) {
          for (let i = 0; i < s.n; i++) if (!Object.is(had[i], arr[i]) && !(Number.isNaN(had[i]) && Number.isNaN(arr[i]))) throw new Error(`dumpInd: two builds of ${name} differ at ${i}`);
        } else cols.set(name, arr);
      }
    }
    const names = [...IND_COLUMNS.filter((c) => cols.has(c)), ...[...cols.keys()].filter((c) => !IND_COLUMNS.includes(c))];
    const want = new Uint8Array(s.n);
    for (let i = 0; i < s.n; i += 97) want[i] = 1;
    for (const sig of sigs) {
      if (sig.tf !== tf.tf) continue;
      const c = sig.pairs[pi];
      for (let r = 0; r < c.n; r++) want[c.i[r]] = 1;
    }
    const rows: string[][] = [];
    for (let i = 0; i < s.n; i++) {
      if (!want[i]) continue;
      const row = [fmtInt(i)];
      for (const name of names) {
        const v = cols.get(name)![i];
        const f = indFormat(name);
        row.push(f === "tri" ? fmtTri(v) : f === "bool" ? fmtBool(v === 1) : f === "int" ? fmtInt(v) : fmtReal(v));
      }
      rows.push(row);
    }
    await writeCsv(`${dir}/ind/${tf.tf}_${SYM(PAIRS[pi])}.csv`, ["i", ...names], rows);
  }
}

// ---- 6. signals -------------------------------------------------------------------------------------------------

export async function dumpSignals(dir: string, sig: TrialSignals): Promise<void> {
  const all: Array<{ pi: number; T: number; d: number; row: string[] }> = [];
  for (const c of sig.pairs) {
    for (let r = 0; r < c.n; r++) {
      all.push({
        pi: c.pi, T: c.T[r], d: c.d[r],
        row: [PAIRS[c.pi], fmtInt(c.i[r]), fmtInt(c.d[r]), fmtInt(c.T[r]), fmtInt(c.X[r]), REASONS[c.reason[r]], HALF_TEXT[c.half[r]], fmtBool(c.warmOk[r] === 1)],
      });
    }
  }
  all.sort((a, b) => a.T - b.T || a.pi - b.pi || (a.d === 1 ? 0 : 1) - (b.d === 1 ? 0 : 1));
  await writeCsv(`${dir}/signals/${sig.trial.id}.csv`, ["pair", "i", "d", "T", "X", "reason", "half", "warm"], all.map((x) => x.row));
}

// ---- 7. stage 0 -------------------------------------------------------------------------------------------------

export async function dumpStage0(dir: string, rows: Stage0Row[]): Promise<void> {
  const out: string[][] = [];
  const totals = { first: { pd: new Array<number>(10).fill(0), reason: new Array<number>(REASONS.length).fill(0) }, second: { pd: new Array<number>(10).fill(0), reason: new Array<number>(REASONS.length).fill(0) } };
  for (const r of rows) {
    const put = (k: string, v: string) => out.push([r.trial, k, v]);
    for (const half of ["first", "second"] as const) {
      const h = r[half];
      put(`${half}.counted`, fmtInt(h.counted));
      put(`${half}.weeks`, fmtInt(h.weeks));
      h.byPairDir.forEach((x, k) => (totals[half].pd[k] += x));
      h.byReason.forEach((x, k) => (totals[half].reason[k] += x));
      // spec 9 後半 (23.3): the second half's per-trial breakdown is not written before stage 2; the totals below are
      if (half === "second") continue;
      PAIRS.forEach((p, pi) => {
        put(`${half}.pd.${SYM(p)}.buy`, fmtInt(h.byPairDir[pi * 2]));
        put(`${half}.pd.${SYM(p)}.sell`, fmtInt(h.byPairDir[pi * 2 + 1]));
      });
      REASONS.forEach((code, k) => put(`${half}.reason.${code}`, fmtInt(h.byReason[k])));
      put(`${half}.no_trade`, fmtInt(h.noTrade));
      put(`${half}.no_blind`, fmtInt(h.noBlind));
      put(`${half}.per_week`, fmtReal(h.perWeek));
    }
    // C3 (the lead's D1): the whole-range counts all.emitted, all.r1, all.r1w and all.r1b are not written per trial
    // (with the first-half keys they gave the trial's second-half ① count and r2–r6 total: spec 9 後半, 23.3); only
    // adds_up is, and the four counts go into stage0_totals.csv as per-timeframe sums
    put("all.adds_up", fmtBool(r.addsUp));
    put("floor", fmtBool(r.floor));
    put("same_as", r.sameAs ?? "");
    put("group", r.group);
    put("g", fmtReal(r.g));
    put("df", fmtInt(r.df));
    put("pass_min", fmtReal(r.passMin));
    put("mde", fmtReal(r.mde));
    put("mark", fmtBool(r.mark));
    put("stage3_estimate", fmtReal(r.stage3Estimate));
  }
  await writeCsv(`${dir}/stage0.csv`, ["trial", "key", "value"], out);
  const tot: string[][] = [];
  for (const half of ["first", "second"] as const) {
    PAIRS.forEach((p, pi) => {
      tot.push([half, `pd.${SYM(p)}.buy`, fmtInt(totals[half].pd[pi * 2])]);
      tot.push([half, `pd.${SYM(p)}.sell`, fmtInt(totals[half].pd[pi * 2 + 1])]);
    });
    REASONS.forEach((code, k) => tot.push([half, `reason.${code}`, fmtInt(totals[half].reason[k])]));
  }
  for (const tf of ["m15", "h1"] as const) tot.push(["", `groups.${tf}`, fmtInt(new Set(rows.filter((r) => r.tf === tf && r.group !== "").map((r) => r.group)).size)]);
  for (const tf of ["m15", "h1"] as const) tot.push(["", `floor.${tf}`, fmtInt(rows.filter((r) => r.tf === tf && r.floor).length)]);
  // C3 (D1): each trial's whole-range counts summed over the timeframe's trials (table order, int addition)
  const sumOf = (tf: TfKey, f: (r: Stage0Row) => number) => rows.filter((r) => r.tf === tf).reduce((a, r) => a + f(r), 0);
  for (const [key, f] of [["all.emitted", (r: Stage0Row) => r.emitted], ["all.r1", (r: Stage0Row) => r.r1All], ["all.r1w", (r: Stage0Row) => r.r1w], ["all.r1b", (r: Stage0Row) => r.r1b]] as const) {
    for (const tf of ["m15", "h1"] as const) tot.push(["", `${key}.${tf}`, fmtInt(sumOf(tf, f))]);
  }
  await writeCsv(`${dir}/stage0_totals.csv`, ["half", "key", "value"], tot);
}

// ---- 8. blind and late tables, trades ---------------------------------------------------------------------------

const BLIND_COLS = ["pair", "i", "T", "d", "j", "x", "subst", "m", "h", "pl", "absm", "hour", "season", "stratum", "week"];
const tableRow = (t: BlindTable, r: number): string[] => [
  PAIRS[t.pi[r]], fmtInt(t.i[r]), fmtInt(t.T[r]), fmtInt(t.d[r]), fmtInt(t.j[r]), fmtInt(t.x[r]), fmtBool(t.subst[r] === 1), fmtInt(t.m[r]), fmtInt(t.h[r]), fmtInt(t.pl[r]),
  fmtInt(t.absm[r]), fmtInt(t.hour[r]), fmtInt(t.season[r]), fmtInt(t.stratum[r]), fmtInt(t.week[r]),
];
// the base tables waiting for their late table (blind_counts.csv's row holds both)
const pendingBase = new Map<string, BlindTable>();

// blind/<tf>_<half>.csv or late/<tf>_<half>.csv; with the late table, blind_counts.csv's row of (tf, half)
export async function dumpBlind(dir: string, t: BlindTable): Promise<void> {
  const key = `${dir}|${t.tf}|${t.half}`;
  if (!t.late) {
    const rows: string[][] = [];
    for (let r = 0; r < t.n; r++) rows.push([fmtInt(r), ...tableRow(t, r)]);
    await writeCsv(`${dir}/blind/${t.tf}_${t.half}.csv`, ["row", ...BLIND_COLS], rows);
    pendingBase.set(key, t);
    return;
  }
  const base = pendingBase.get(key);
  if (!base) throw new Error(`dumpBlind: the late table ${t.tf} ${t.half} came before its base table`);
  pendingBase.delete(key);
  if (!t.baseRow) throw new Error(`dumpBlind: the late table ${t.tf} ${t.half} has no baseRow`);
  const rows: string[][] = [];
  for (let r = 0; r < t.n; r++) rows.push([fmtInt(r), fmtInt(t.baseRow[r]), ...tableRow(t, r)]);
  await writeCsv(`${dir}/late/${t.tf}_${t.half}.csv`, ["row", "base_row", ...BLIND_COLS], rows);
  await appendCsv(`${dir}/blind_counts.csv`, ["tf", "half", "rows", "passed_bars", "no_trade_bars", "weeks", "late_rows", "late_no_entry", "late_r4", "late_end"], [[
    base.tf, base.half, fmtInt(base.n), fmtInt(base.passedBars), fmtInt(base.noTradeBars), fmtInt(base.weeks.length), fmtInt(t.n), fmtInt(t.lateExcluded.noEntry), fmtInt(t.lateExcluded.r4), fmtInt(t.lateExcluded.end),
  ]]);
}

const LATE_WHY_TEXT: Readonly<Record<number, string>> = { 1: "no_entry", 2: "r4", 3: "end" };

// trades/<trial>_<half>.csv. lateWhy: per base row, 0 kept, 1 no late entry, 2 ④ at X + 15 min, 3 past the end
// (lawsearch-trade.ts lateWhyOf)
export async function dumpTrades(dir: string, t: BlindTable, late: BlindTable, tr: TrialRows, lateWhy: Uint8Array | null = null): Promise<void> {
  const lateOf = new Map<number, number>();
  if (late.baseRow) for (let r = 0; r < late.n; r++) lateOf.set(late.baseRow[r], r);
  const rows: string[][] = [];
  for (const r of tr.rows) {
    const lr = lateOf.get(r);
    const row = [PAIRS[t.pi[r]], fmtInt(t.i[r]), fmtInt(t.T[r]), fmtInt(t.d[r]), fmtInt(r), fmtInt(t.j[r]), fmtInt(t.x[r]), fmtBool(t.subst[r] === 1), fmtInt(t.m[r]), fmtInt(t.h[r]), fmtInt(t.pl[r]), fmtInt(t.stratum[r]), fmtInt(t.week[r])];
    if (lr === undefined) {
      const why = lateWhy ? LATE_WHY_TEXT[lateWhy[r]] : undefined;
      if (!why) throw new Error(`dumpTrades: ${tr.trial} row ${r} has no late row and no reason`);
      row.push("-1", why, "", "", "");
    } else row.push(fmtInt(lr), "", fmtInt(late.m[lr]), fmtInt(late.h[lr]), fmtInt(late.pl[lr]));
    rows.push(row);
  }
  await writeCsv(`${dir}/trades/${tr.trial}_${tr.half}.csv`, ["pair", "i", "T", "d", "row", "j", "x", "subst", "m", "h", "pl", "stratum", "week", "late_row", "late_why", "late_m", "late_h", "late_pl"], rows);
}

// ---- 8. measures, strata, shift, clusters -----------------------------------------------------------------------

const valueKeys = (name: string, e: ValueEst, withShift: boolean, put: (k: string, v: string) => void) => {
  put(`${name}.value`, fmtReal(e.value));
  put(`${name}.N`, fmtInt(e.N));
  put(`${name}.C_week`, fmtInt(e.C_week));
  put(`${name}.C_4w`, fmtInt(e.C_4w));
  put(`${name}.four`, fmtBool(e.four));
  put(`${name}.has_t`, fmtBool(e.hasT));
  put(`${name}.use_lb`, e.useLB ?? "");
  put(`${name}.use_p`, e.useP ?? "");
  put(`${name}.t`, fmtReal(e.t));
  put(`${name}.p`, fmtReal(e.p));
  put(`${name}.lb`, fmtReal(e.lb));
  put(`${name}.ub`, fmtReal(e.ub));
  put(`${name}.kappa`, fmtReal(e.kappa));
  for (const c of e.cands) {
    if (c.kind === "4w" && !e.four) continue;
    if (c.kind === "shift" && !withShift) continue;
    const p = `${name}.${c.kind}`;
    put(`${p}.se`, fmtReal(c.se));
    put(`${p}.C`, fmtInt(c.C));
    put(`${p}.df`, fmtInt(c.df));
    put(`${p}.K`, fmtInt(c.K));
    put(`${p}.t`, fmtReal(c.t));
    put(`${p}.p`, fmtReal(c.p));
    put(`${p}.q975`, fmtReal(c.q975));
    put(`${p}.half_width`, fmtReal(c.halfWidth));
  }
  if (withShift && e.shift) {
    put(`${name}.shift.used`, fmtInt(e.shift.used));
    put(`${name}.shift.skipped`, fmtInt(e.shift.skipped));
    put(`${name}.shift.sd`, fmtReal(e.shift.sd));
  }
};
const isBlindRow = (m: TrialMeasures) => m.trial.startsWith("blind.");

// measures.csv (long), strata.csv, shift.csv, clusters.csv, appended per stage. ms: the trials in table order, then
// the 20 blind rows. strata, shift and clusters are written for the trials only (lawsearch-dump.md 8 names the
// blind rows for measures.csv only).
export async function dumpMeasures(dir: string, stage: "stage1" | "stage2", ms: TrialMeasures[]): Promise<void> {
  const out: string[][] = [];
  const strata: string[][] = [];
  const shift: string[][] = [];
  const clusters: string[][] = [];
  for (const m of ms) {
    const put = (k: string, v: string) => out.push([stage, m.half, m.trial, k, v]);
    const blind = isBlindRow(m);
    put("counted", fmtInt(m.counted));
    put("no_trade", fmtInt(m.noTrade));
    put("no_blind", fmtInt(m.noBlind));
    put("N", fmtInt(m.delta.N));
    put("weeks", fmtInt(m.weeks));
    put("strata", fmtInt(m.strata.filter((s) => s.n > 0).length));
    const values: Array<[string, ValueEst, boolean]> = blind
      ? [["a", m.a, true], ["pl", m.pl, true]]
      : [["delta", m.delta, true], ["a", m.a, true], ["pl", m.pl, true], ["delta_late", m.deltaLate, true]];
    if (!blind && m.dF) values.push(["dF", m.dF, false]);
    for (const [name, e, withShift] of values) valueKeys(name, e, withShift, put);
    const x = m.extras;
    put("pl_ex1w", fmtReal(x.plEx1w));
    put("ex1w_week", fmtInt(x.ex1wWeek));
    put("w_count", fmtInt(x.wCount));
    put("w_rate", fmtReal(x.wRate));
    put("blind_pl_w", fmtReal(x.blindPlW));
    put("pl_minus_blind", fmtReal(x.plMinusBlind));
    put("M", fmtReal(x.M));
    PAIRS.forEach((p, pi) => put(`pl_pair.${SYM(p)}`, fmtReal(x.plByPair[pi])));
    PAIRS.forEach((p, pi) => put(`n_pair.${SYM(p)}`, fmtInt(x.nByPair[pi])));
    put("pl_buy", fmtReal(x.plByDir[0]));
    put("pl_sell", fmtReal(x.plByDir[1]));
    put("n_buy", fmtInt(x.nByDir[0]));
    put("n_sell", fmtInt(x.nByDir[1]));
    if (blind) continue;
    put("pl_late", fmtReal(m.plLate));
    put("late_N", fmtInt(m.lateN));
    put("late_excl.no_entry", fmtInt(m.lateExcluded.noEntry));
    put("late_excl.r4", fmtInt(m.lateExcluded.r4));
    put("late_excl.end", fmtInt(m.lateExcluded.end));
    put("dF.against", m.dFAgainst ?? "");
    put("nov.N", fmtInt(m.nonOverlap.N));
    put("nov.delta", fmtReal(m.nonOverlap.delta));
    put("nov.pl", fmtReal(m.nonOverlap.pl));
    if (stage === "stage2") {
      put("delta_dir.buy", fmtReal(m.deltaByDir[0]));
      put("delta_dir.sell", fmtReal(m.deltaByDir[1]));
      put("counted_dir.buy", fmtInt(m.countedByDir[0]));
      put("counted_dir.sell", fmtInt(m.countedByDir[1]));
      PAIRS.forEach((p, pi) => put(`delta_pair.${SYM(p)}`, fmtReal(m.deltaByPair[pi])));
      PAIRS.forEach((p, pi) => put(`counted_pair.${SYM(p)}`, fmtInt(m.countedByPair[pi])));
      put("c6.a", fmtReal(m.c6[0]));
      put("c6.b", fmtReal(m.c6[1]));
    }
    for (const s of m.strata) {
      if (s.n <= 0) continue;
      strata.push([stage, m.half, m.trial, fmtInt(s.id), fmtInt(s.n), fmtInt(s.m), fmtReal(s.sigMean), fmtReal(s.B), fmtReal(s.blindPlMean), fmtReal(s.absMMean)]);
    }
    for (const [name, e] of [["delta", m.delta], ["pl", m.pl], ["a", m.a], ["delta_late", m.deltaLate]] as const) {
      const sh = e.shift;
      if (!sh) continue;
      for (let k = 0; k < sh.k.length; k++) shift.push([stage, m.half, m.trial, name, fmtInt(sh.k[k]), fmtInt(sh.n[k]), fmtInt(sh.dropped[k]), fmtReal(sh.v[k])]);
    }
    const cl: Array<[string, ValueEst | null]> = [["delta", m.delta], ["a", m.a], ["pl", m.pl], ["delta_late", m.deltaLate], ["dF", m.dF]];
    for (const [name, e] of cl) {
      if (!e) continue;
      for (const [kind, map] of [["week", e.sums.week], ["4w", e.sums.four]] as const) {
        if (kind === "4w" && !e.four) continue;
        for (const g of [...map.keys()].sort((a, b) => a - b)) clusters.push([stage, m.half, m.trial, name, kind, fmtInt(g), fmtReal(map.get(g)!)]);
      }
    }
  }
  await appendCsv(`${dir}/measures.csv`, ["stage", "half", "trial", "key", "value"], out);
  await appendCsv(`${dir}/strata.csv`, ["stage", "half", "trial", "stratum", "n", "m", "sig_mean", "B", "blind_pl_mean", "absm_mean"], strata);
  await appendCsv(`${dir}/shift.csv`, ["stage", "half", "trial", "value", "k", "n", "dropped", "v"], shift);
  await appendCsv(`${dir}/clusters.csv`, ["stage", "half", "trial", "value", "kind", "g", "S_g"], clusters);
}

// ---- 8. stage 1 and 2 -------------------------------------------------------------------------------------------

// stage1.csv (long, the trials with first-half measures in table order) and stage1_summary.csv
export async function dumpStage1(dir: string, cands: Stage1Cand[], out: Stage1Out, explain: Stage1Explain, pIut: ReadonlyMap<string, number> = new Map(), label: (r: SkipReason, by: string) => string = (r, by) => `${r}:${by}`): Promise<void> {
  const rows: string[][] = [];
  const sorted = [...cands].sort((a, b) => a.order - b.order);
  const skipped = new Map(out.skipped.map((s) => [s.id, s]));
  for (const c of sorted) {
    const put = (k: string, v: string) => rows.push([c.id, k, v]);
    put("pass_floor", fmtBool(c.passFloor));
    put("same", fmtBool(c.same));
    put("checks_ok", fmtBool(c.checksOk));
    put("has_t", fmtBool(c.hasT));
    put("delta", fmtReal(c.delta));
    put("lb", fmtReal(c.lb));
    put("pl", fmtReal(c.pl));
    put("pl_ex1w", fmtReal(c.plEx1w));
    put("dF", fmtReal(c.dF));
    put("suspicious", fmtBool(c.suspicious));
    put("sus_checks_passed", fmtBool(c.suspiciousChecksPassed));
    put("n", fmtInt(c.n));
    put("group", c.group);
    put("fail_rule", fmtInt(out.failRule.get(c.id) ?? null));
    const rank = out.order[c.tf].indexOf(c.id);
    put("rank", rank >= 0 ? fmtInt(rank + 1) : "");
    put("chosen", fmtBool(out.chosen[c.tf].includes(c.id)));
    const s = skipped.get(c.id);
    put("skipped_reason", s ? label(s.reason, s.by) : "");
    put("skipped_by", s ? s.by : "");
    put("p_iut", fmtReal(pIut.get(c.id) ?? null));
  }
  await writeCsv(`${dir}/stage1.csv`, ["trial", "key", "value"], rows);
  await writeCsv(`${dir}/stage1_summary.csv`, ["key", "value"], [
    ["K_total", fmtInt(out.K_total)],
    ["chosen.m15", out.chosen.m15.join("|")],
    ["chosen.h1", out.chosen.h1.join("|")],
    ["lb_pos", fmtInt(explain.lbPos)],
    ["lb_pos_groups", fmtInt(explain.lbPosGroups)],
    ["lb_and_pl_pos", fmtInt(explain.lbAndPlPos)],
    ["bh_m", fmtInt(explain.bhM)],
    ["bh_pass", fmtInt(explain.bhPass)],
  ]);
}

// stage2.csv (long, the chosen trials in table order). rows: lawsearch-select.ts Stage2RowX
export async function dumpStage2(dir: string, cands: Stage2Cand[], rows: ReadonlyArray<Stage2Row & { label: string; dFLo: number | null; dFHi: number | null; noUplift: boolean | null }>, kappa: { delta: number; pl: number } = { delta: 1, pl: 1 }): Promise<void> {
  const out: string[][] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of [...cands].sort((a, b) => a.order - b.order)) {
    const r = byId.get(c.id);
    if (!r) throw new Error(`dumpStage2: no row for ${c.id}`);
    const put = (k: string, v: string) => out.push([c.id, k, v]);
    put("kappa_delta", fmtReal(kappa.delta));
    put("kappa_pl", fmtReal(kappa.pl));
    put("p_delta", fmtReal(c.pDelta));
    put("p_pl", fmtReal(c.pPl));
    put("p_iut", fmtReal(r.pIut));
    put("t_delta", fmtReal(c.tDelta));
    put("t_pl", fmtReal(c.tPl));
    put("holm_rank", fmtInt(r.holmRank));
    put("holm_pass", fmtBool(r.holmPass));
    put("holm_delta_rank", fmtInt(r.holmDeltaRank));
    put("holm_delta_pass", fmtBool(r.holmDeltaPass));
    r.C.forEach((x, k) => put(`C${k + 1}`, fmtBool(x)));
    put("verdict", fmtInt(r.verdict));
    put("label", r.label);
    put("failed", r.failed.map((k) => `C${k}`).join("・"));
    put("mde", fmtReal(r.mde));
    put("sim_lb", fmtReal(r.simLb));
    put("delta_ub", fmtReal(c.deltaUb));
    put("late_lb", fmtReal(c.lateLb));
    put("dF_lo", fmtReal(r.dFLo));
    put("dF_hi", fmtReal(r.dFHi));
    put("no_uplift", fmtBool(r.noUplift));
  }
  await writeCsv(`${dir}/stage2.csv`, ["trial", "key", "value"], out);
}

// suspect.csv: the trials with measures, then the blind rows (the caller's order), appended per stage
export async function dumpSuspect(dir: string, rows: SuspectRow[]): Promise<void> {
  const stageOf = (h: string) => (h === "first" ? "stage1" : h === "second" ? "stage2" : h);
  await appendCsv(`${dir}/suspect.csv`, ["stage", "half", "id", "looked", "hit_delta", "hit_a", "hit_pl", "hit_late", "hit_W", "hit", "cut", "poison1000", "presence", "retrace", "hand", "checks_passed"], rows.map((r) => [
    stageOf(r.half), r.half, r.id, fmtBool(r.looked), fmtBool(r.hitDelta), fmtBool(r.hitA), fmtBool(r.hitPl), fmtBool(r.hitLate), fmtBool(r.hitW), fmtBool(r.hit),
    r.hit ? fmtBool(r.checks.cut) : "", r.hit ? fmtBool(r.checks.poison1000) : "", r.hit ? fmtBool(r.checks.presence) : "", r.hit ? fmtBool(r.checks.retrace) : "", r.hit ? r.checks.hand : "", r.hit ? fmtBool(r.checksPassed) : "",
  ]));
}

// checks.csv (TS only): trial,name,passed,detail,stage. A probe named by a trial id ("m15.…", "h1.…") is that trial's
// row; the other probes of a check make its one "*" row (the whole run's; absent when every probe is a trial's).
// Commas and line ends in the detail become ";" and " ". stage (lawsearch-dump.md 8, TS only): gate, stage0, stage1,
// stage1end (spec 23.2's cut of the chosen trials, after the choice), stage2 or end. The Python reads it for rule 2:
// checks_ok = every "*" row and every row of that trial passed, among the rows of stages gate, stage0 and stage1
// (the checks made before the choice). stages: one per CheckResult (the stage column is left out without it).
export const isTrialProbe = (name: string): boolean => /^(m15|h1)\./.test(name);
export function checksRows(rs: CheckResult[], stages?: readonly string[]): string[][] {
  const clean = (s: string) => s.replace(/,/g, ";").replace(/[\r\n]+/g, " ");
  if (stages && stages.length !== rs.length) throw new Error(`checksRows: ${rs.length} checks, ${stages.length} stages`);
  const out: string[][] = [];
  rs.forEach((r, q) => {
    const tail = stages ? [stages[q]] : [];
    const own = r.probes.filter((p) => !isTrialProbe(p.name));
    if (own.length > 0 || r.probes.length === 0) {
      const passed = r.probes.length === 0 ? r.passed : own.every((p) => p.mismatched === 0);
      out.push(["*", clean(r.name), fmtBool(passed), clean(r.detail), ...tail]);
    }
    for (const p of r.probes) {
      if (!isTrialProbe(p.name)) continue;
      out.push([p.name, clean(r.name), fmtBool(p.mismatched === 0), clean(`${p.mismatched} of ${p.compared} differ${p.examples.length ? ": " + p.examples.join(" | ") : ""}`), ...tail]);
    }
  });
  return out;
}
export async function dumpChecks(dir: string, rs: CheckResult[], stages: readonly string[]): Promise<void> {
  await writeCsv(`${dir}/checks.csv`, ["trial", "name", "passed", "detail", "stage"], checksRows(rs, stages));
}

// cut_fail.csv (TS only, C3; lawsearch-dump.md 8, the lead's D6): every failing bar of the checks cut, cut.chosen.first
// and cut.chosen.second; always written, with its header. Order: check, trial (table order), pair (table order), k,
// kinds. Columns check,stage,trial,pair,k,s,T,kinds,cut,uncut: T (C4a, the lead's E7) is bar k's close, the time the
// checks.csv detail and the STOP line print. Sealed until stage 2 (lawsearch-dump.md 12; the lead's E5).
const CUT_CHECK_ORDER: Readonly<Record<string, number>> = { cut: 0, "cut.chosen.first": 1, "cut.chosen.second": 2 };
export async function dumpCutFail(dir: string, rows: ReadonlyArray<CutFailRow>): Promise<void> {
  const rank = (c: string) => {
    const x = CUT_CHECK_ORDER[c];
    if (x === undefined) throw new Error(`dumpCutFail: ${c} is not a cut check of cut_fail.csv`);
    return x;
  };
  for (const r of rows) rank(r.check);
  const sorted = [...rows].sort((a, b) => rank(a.check) - rank(b.check) || a.order - b.order || a.pi - b.pi || a.k - b.k || (a.kinds < b.kinds ? -1 : a.kinds > b.kinds ? 1 : 0));
  await writeCsv(`${dir}/cut_fail.csv`, ["check", "stage", "trial", "pair", "k", "s", "T", "kinds", "cut", "uncut"], sorted.map((r) => [r.check, r.stage, r.trial, PAIRS[r.pi], fmtInt(r.k), fmtInt(r.s), fmtInt(r.T), r.kinds, r.cut, r.uncut]));
}
