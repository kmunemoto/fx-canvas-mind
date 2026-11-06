// 法則探し (docs §8.136, research/lawsearch-spec.md 14.2 裏返し, 23.1; research/lawsearch-design.md 10 FLIP, 11 O-2):
// the flip's conditions, judged on the exact mirror of a synthetic run, and, for information, the FLIP=1 run's dumps
// against the original's. Read only.
//
//   deno run --sloppy-imports --no-config --v8-flags=--max-old-space-size=12288 --allow-read=. \
//     research/lawsearch-flip.ts <run> [<flipped run>] [--ts <the run's dumps>] [--flipped-ts <the flipped run's dumps>]
//
// (--ts and --flipped-ts default to <run>/ts and <flipped run>/ts; a walkfiles run writes its dumps elsewhere.)
//
// JUDGED (spec 23.1, the owner's answer 6): the original run's gmo files read under spec 2 (the pipeline's two loads:
// [S0, SPLIT) for the first half's blind tables, [S0, END) for the signals and the second half's), then every bar of
// the trials' timeframes mirrored exactly about the pair's S (lawsearch-bars.ts mirrorSeries: Bid' = 2S − Ask, Ask' =
// 2S − Bid, mid' = 2S − mid, high' from low and low' from high, in points, with no rounding of spec 2), and everything
// above it rebuilt from the mirror: the higher bars (mirroredHigher), the indicators, every trial's signals (spec 5,
// 6), the blind tables of both halves and timeframes (8.1), the late tables and the trades of the counted signals (7,
// 8.8). S is the pair's first 5-minute mid open of the original run: the generator's start in points (14.1 始値,
// GEN_START), read back from the files as the first bar's Bid open + floor(spread ÷ 2) (the generator's Bid is the mid
// − floor(spread ÷ 2), and the first 15-minute bar opens with the first 5-minute bar); a run whose files do not give
// it is not judged (exit 1). The conditions of 14.2:
//   * every blind bar of both halves and timeframes: the mirror's buy h = the original's sell h, and PL the same (the
//     mirror's buy PL = the original's sell PL, the mirror's sell PL = the original's buy PL; points, |difference| ≤
//     1e−9); the two tables must hold the same bars;
//   * the symmetric items (every trial that is not a B: E04, E26, S01 and their F): the signals (pair, bar,
//     direction, reason, half, warm) match 1-to-1 with the direction reversed; the difference (rows in one only, both
//     ways, ÷ the original's rows) must be ≤ 0.1% per trial;
//   * B06 is not symmetric (log returns of mirrored prices): its name, reason and difference are printed, not judged.
// Also judged, so that the judgement is of the original run: the original's signals and blind tables built here equal
// the run's dumps (signals/<trial>.csv; blind/<tf>_<half>.csv when the run wrote it), and the mirror's higher bars
// equal the mirror of the original's. The trades of the counted signals are printed (information).
// Tied to the run (C3, 2026-11-05; the lead's D3; design 7.9): before a bar is read, <run>/gmo's tree sha256 and file
// count are checked against <run>/manifest.json as lawsearch.ts's gate 3 does (a mismatch prints STOP and exits 3); the
// trials come from <ts>/config.json (missing or unreadable: FAIL, no fallback to the trial's twelve); a missing
// <ts>/signals/<trial>.csv or <ts>/blind/<tf>_first.csv is a FAIL, and so is a missing <ts>/blind/<tf>_second.csv when
// the run opened stage 2 (its <ts>/load.csv has a syn2 row; a missing load.csv is a FAIL too: stage 0 always writes
// it). (C4b, 2026-11-05; the lead's E13; design 7.9) With <flipped run>, its manifest.json must be of this generator,
// FLIP=1 and the original's group and seed, and its gmo's tree sha256 and file count are checked against that manifest
// in the same way, right after the original's and before any bar is read; a mismatch prints the same STOP (naming
// <flipped run>/gmo) and exits 3. Its dumps are only INFO lines, but they must be of the run named.
//
// INFORMATION only (spec 23.1: the FLIP=1 run, its files read under spec 2, is for the TS–Python comparison): with
// <flipped run>, its dumps against the original's, as the trial compared them (the blind bars' h and PL with 11 O-2's
// count; the signals' differences of E04, E26, S01 and B06). These lines start with "INFO" and never fail the run.
//
// Exit: 0 every judged condition passed; 3 a judged failure or a STOP; 1 a crash; 2 usage.

import { END, PAIRS, POINTS_PER_PRICE, S0, SPLIT, SPREAD_H1_SHA256 } from "./lawsearch-const.ts";
import { REASONS } from "./lawsearch-rules.ts";
import { loadUniverse, mirrorSeries, mirrorUniverse } from "./lawsearch-bars.ts";
import { GEN_START, GEN_VERSION, treeSha256 } from "./lawsearch-gen.ts";
import { parseCandidates, trialBuilt } from "./lawsearch-items.ts";
import { avoidOf, blindBarsOf, trialSignals } from "./lawsearch-events.ts";
import { ctxOfUniverse } from "./lawsearch-checks.ts";
import { indsOf } from "./lawsearch-stage0.ts";
import { blindTable, lateTable, rowKey, trialRows } from "./lawsearch-trade.ts";
import type { BlindTable, Dir, Pair, TfKey, TfSet, TrialDef, TrialSignals, Universe } from "./lawsearch-types.ts";

type Row = Record<string, string>;

const readCsv = async (path: string): Promise<Row[] | null> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const f = l.split(",");
    const r: Row = {};
    head.forEach((h, k) => (r[h] = f[k] ?? ""));
    return r;
  });
};

export interface FlipBlind {
  file: string;
  bars: number;
  barsOnlyOne: number;
  plDiff: number;
  hDiff: number;
  hDiffByAbsM: Record<string, number>;
  mOutOfRange: number;
  examples: string[];
}

// INFO: the FLIP=1 run's blind dump against the original's (the trial's comparison; 11 O-2's h differences counted)
export function compareBlind(file: string, a: Row[], b: Row[]): FlipBlind {
  const key = (r: Row) => `${r.pair}|${r.i}|${r.T}|${r.d}`;
  const A = new Map(a.map((r) => [key(r), r]));
  const B = new Map(b.map((r) => [key(r), r]));
  const out: FlipBlind = { file, bars: 0, barsOnlyOne: 0, plDiff: 0, hDiff: 0, hDiffByAbsM: {}, mOutOfRange: 0, examples: [] };
  const seen = new Set<string>();
  for (const r of [...a, ...b]) {
    const bar = `${r.pair}|${r.i}|${r.T}`;
    if (seen.has(bar)) continue;
    seen.add(bar);
    const aBuy = A.get(`${bar}|1`);
    const aSell = A.get(`${bar}|-1`);
    const bBuy = B.get(`${bar}|1`);
    const bSell = B.get(`${bar}|-1`);
    if (!aBuy || !aSell || !bBuy || !bSell) {
      out.barsOnlyOne++;
      if (out.examples.length < 8) out.examples.push(`${file} ${bar}: in one run only`);
      continue;
    }
    out.bars++;
    // the flipped buy is the original sell, and the flipped sell the original buy
    for (const [f, o] of [[bBuy, aSell], [bSell, aBuy]] as const) {
      if (f.pl !== o.pl) {
        out.plDiff++;
        if (out.examples.length < 8) out.examples.push(`${file} ${bar} d=${f.d}: pl ${f.pl}, original d=${o.d} pl ${o.pl}`);
      }
      const e = Number(f.m) - Number(o.m);
      if (Math.abs(e) > 2) {
        out.mOutOfRange++;
        if (out.examples.length < 8) out.examples.push(`${file} ${bar} d=${f.d}: m ${f.m}, original d=${o.d} m ${o.m} (more than 2 points apart)`);
      }
    }
    if (bBuy.h !== aSell.h) {
      const am = String(Math.abs(Number(aSell.m)));
      out.hDiff++;
      out.hDiffByAbsM[am] = (out.hDiffByAbsM[am] ?? 0) + 1;
      if (Math.abs(Number(aSell.m)) > 2 && out.examples.length < 8) out.examples.push(`${file} ${bar}: flipped buy h ${bBuy.h}, original sell h ${aSell.h} at |m| ${am}`);
    }
  }
  return out;
}

export interface FlipSignals {
  trial: string;
  rows: number;
  rowsFlipped: number;
  onlyOriginal: number;
  onlyFlipped: number;
  share: number;
  judged: boolean;
  examples: string[];
}

// INFO: the FLIP=1 run's signals dump against the original's (the trial's comparison)
export function compareSignals(trial: string, a: Row[], b: Row[]): FlipSignals {
  const ka = new Set(a.map((r) => `${r.pair}|${r.i}|${r.d}|${r.reason}`));
  // the flipped run's rows with the direction reversed
  const kb = new Set(b.map((r) => `${r.pair}|${r.i}|${-Number(r.d)}|${r.reason}`));
  const examples: string[] = [];
  let onlyA = 0;
  let onlyB = 0;
  for (const k of ka) {
    if (kb.has(k)) continue;
    onlyA++;
    if (examples.length < 5) examples.push(`${trial}: original ${k}, no flipped twin`);
  }
  for (const k of kb) {
    if (ka.has(k)) continue;
    onlyB++;
    if (examples.length < 10) examples.push(`${trial}: flipped (d reversed) ${k}, no original twin`);
  }
  const judged = !/\.B\d\d$/.test(trial);
  return { trial, rows: a.length, rowsFlipped: b.length, onlyOriginal: onlyA, onlyFlipped: onlyB, share: a.length > 0 ? (onlyA + onlyB) / a.length : onlyB > 0 ? 1 : 0, judged, examples };
}

// ---- INFO: the FLIP=1 run's dumps (the trial's comparison, now information only) -------------------------------------

// the flipped run's manifest.json: of this generator, FLIP=1, and the original's group and seed (anything else is a
// crash, exit 1, as for the original's manifest); used by flipJudge's tree check and by flipInfo
async function flippedManifest(run: string, flipped: string): Promise<{ version: string; files: number; treeSha256: string; spec: { group: string; seed: number; flip: boolean } }> {
  const mb = JSON.parse(await Deno.readTextFile(`${flipped}/manifest.json`));
  const ma = JSON.parse(await Deno.readTextFile(`${run}/manifest.json`)).spec;
  if (mb.version !== GEN_VERSION) throw new Error(`${flipped}/manifest.json: version ${mb.version}, not ${GEN_VERSION}`);
  if (mb.spec.flip !== true) throw new Error(`${flipped}: manifest flip ${mb.spec.flip}, expected true`);
  if (ma.group !== mb.spec.group || ma.seed !== mb.spec.seed) throw new Error(`the runs are ${ma.group} ${ma.seed} and ${mb.spec.group} ${mb.spec.seed}`);
  return mb;
}

// (the flipped run's gmo tree is checked by flipJudge(run, tsDir, flipped), before any bar is read; main calls it so)
export async function flipInfo(run: string, flipped: string, tsA: string, tsB: string): Promise<string[]> {
  const lines: string[] = [];
  const mb = (await flippedManifest(run, flipped)).spec;
  lines.push(`INFO FLIP=1 ${mb.group} ${mb.seed}: ${tsA} vs ${tsB} (the flipped files read under spec 2; not judged, spec 23.1)`);
  for (const tf of ["m15", "h1"]) {
    for (const half of ["first", "second"]) {
      const f = `blind/${tf}_${half}.csv`;
      const a = await readCsv(`${tsA}/${f}`);
      const b = await readCsv(`${tsB}/${f}`);
      if (!a || !b) {
        lines.push(`INFO BLIND ${f}: not in both runs (original ${a ? "yes" : "no"}, flipped ${b ? "yes" : "no"}; the second half is written only when stage 2 runs)`);
        continue;
      }
      const c = compareBlind(f, a, b);
      lines.push(`INFO BLIND ${f}: bars ${c.bars}, in one run only ${c.barsOnlyOne}, pl differences ${c.plDiff}, |m′ − m| > 2: ${c.mOutOfRange}, h differences ${c.hDiff} (by |m| of the original sell: ${JSON.stringify(c.hDiffByAbsM)}; 11 O-2)`);
      for (const x of c.examples) lines.push(`INFO   ${x}`);
    }
  }
  const names = new Set<string>();
  for await (const e of Deno.readDir(`${tsA}/signals`)) names.add(e.name);
  for (const name of [...names].sort()) {
    const trial = name.replace(/\.csv$/, "");
    if (!/\.(E04|E26|S01|B06)/.test(trial)) continue;
    const a = await readCsv(`${tsA}/signals/${name}`);
    const b = await readCsv(`${tsB}/signals/${name}`);
    if (!a || !b) {
      lines.push(`INFO SIGNALS ${trial}: missing in the flipped run`);
      continue;
    }
    const c = compareSignals(trial, a, b);
    lines.push(`INFO SIGNALS ${trial}: original ${c.rows}, flipped ${c.rowsFlipped}, only original ${c.onlyOriginal}, only flipped ${c.onlyFlipped}, difference ${(100 * c.share).toFixed(4)}%${c.judged ? "" : " (B06: not symmetric)"}`);
    for (const x of c.examples.slice(0, 4)) lines.push(`INFO   ${x}`);
  }
  return lines;
}

// ---- JUDGED: the exact mirror (spec 23.1) --------------------------------------------------------------------------

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const pct = (x: number) => `${(100 * x).toFixed(4)}%`;
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const setOf = (u: Universe, tf: TfKey): TfSet => (tf === "m15" ? u.m15 : u.h1);

// S per pair (points): the generator's start, checked against the original's first bar (its Bid open + floor(spread
// ÷ 2)) on both timeframes; the first bar must open at the walk's first minute (the manifest's fromMs)
export function startsOf(u: Universe, fromMs: number): { S: number[]; lines: string[] } {
  const S: number[] = [];
  const lines: string[] = [];
  PAIRS.forEach((pair, pi) => {
    const want = Math.round(GEN_START[pair as Pair] * POINTS_PER_PRICE(pair));
    for (const tf of ["m15", "h1"] as const) {
      const s = setOf(u, tf).pairs[pi];
      if (s.n === 0 || s.s[0] !== fromMs) throw new Error(`${pair} ${tf}: the first bar is not at the walk's first minute (${s.n ? iso(s.s[0]) : "no bar"}); S cannot be read from the files`);
      const got = s.Bo[0] + Math.floor((s.Ao[0] - s.Bo[0]) / 2);
      if (got !== want) throw new Error(`${pair} ${tf}: the first bar's Bid open + floor(spread ÷ 2) is ${got} points, the generator's start ${want}`);
    }
    S.push(want);
    lines.push(`${pair} S ${want} (spec 2's rounded first mid open ${setOf(u, "m15").pairs[pi].Po[0]})`);
  });
  return { S, lines };
}

// the mirror's higher bars against the mirror of the original's (mirroredHigher's promise)
const higherCheck = (o: Universe, m: Universe, S: readonly number[]): string[] => {
  const bad: string[] = [];
  const keys = ["s", "Bo", "Bh", "Bl", "Bc", "Ao", "Ah", "Al", "Ac", "Po", "Ph", "Pl", "Pc", "O", "H", "L", "C"] as const;
  for (const tf of ["m15", "h1"] as const) {
    setOf(o, tf).pairs.forEach((p, pi) => {
      const want = mirrorSeries(setOf(o, tf).htf[pi], S[pi]);
      const got = setOf(m, tf).htf[pi];
      if (want.n !== got.n) {
        bad.push(`${p.pair} ${tf}'s higher bars: ${got.n} rebuilt, ${want.n} mirrored`);
        return;
      }
      for (const k of keys) for (let i = 0; i < want.n; i++) if (want[k][i] !== got[k][i]) {
        bad.push(`${p.pair} ${tf}'s higher bar ${i} ${k}: rebuilt ${got[k][i]}, mirrored ${want[k][i]}`);
        return;
      }
    });
  }
  return bad;
};

interface Built {
  u: Universe;
  sig: Map<string, TrialSignals>;
  table: Record<string, BlindTable>;
  late: Record<string, BlindTable>;
}

// the pipeline's pieces on one universe, as stage 1 (half first, the [S0, SPLIT) load) or stage 2 (half second, the
// [S0, END) load, whose signals are stage 0's) makes them: every trial's signals, the half's blind and late tables
function build(u: Universe, trials: TrialDef[], avoid: ReadonlySet<string>, answerKnowing: boolean, half: "first" | "second"): Built {
  const ctx = ctxOfUniverse(u, avoid, "");
  const inds = { m15: indsOf(u.m15, ""), h1: indsOf(u.h1, "") };
  const sig = new Map<string, TrialSignals>();
  for (const t of trials) sig.set(t.id, trialSignals(t, setOf(u, t.tf), inds[t.tf], ctx[t.tf], { plant: "", answerKnowing }));
  const table: Record<string, BlindTable> = {};
  const late: Record<string, BlindTable> = {};
  for (const tf of ["m15", "h1"] as const) {
    const t = blindTable(setOf(u, tf), half, blindBarsOf(ctx[tf], setOf(u, tf), half), "");
    table[tf] = t;
    late[tf] = lateTable(t, u.m15, half === "first" ? SPLIT : END, "");
  }
  return { u, sig, table, late };
}

// the rows of one trial's signals as keys (pair, bar, direction (reversed for the mirror), reason, half, warm)
const sigKeys = (sig: TrialSignals, reverse: boolean): string[] => {
  const out: string[] = [];
  for (const c of sig.pairs) for (let r = 0; r < c.n; r++) out.push(`${PAIRS[c.pi]}|${c.i[r]}|${reverse ? -c.d[r] : c.d[r]}|${REASONS[c.reason[r]]}|${c.half[r]}|${c.warmOk[r]}`);
  return out;
};
const setDiff = (a: readonly string[], b: readonly string[]): { onlyA: number; onlyB: number; examples: string[] } => {
  const A = new Set(a);
  const B = new Set(b);
  const examples: string[] = [];
  let onlyA = 0;
  let onlyB = 0;
  for (const k of A) if (!B.has(k)) {
    onlyA++;
    if (examples.length < 4) examples.push(`original ${k}, no mirrored twin`);
  }
  for (const k of B) if (!A.has(k)) {
    onlyB++;
    if (examples.length < 8) examples.push(`mirror (direction reversed) ${k}, no original twin`);
  }
  return { onlyA, onlyB, examples };
};

// one blind table of the mirror against the original's: the same bars; mirror buy h = original sell h; PL buy ↔ sell
export function mirrorBlind(o: BlindTable, m: BlindTable): { bars: number; onlyOne: number; hDiff: number; mDiff: number; plDiff: number; plMax: number; examples: string[] } {
  const out = { bars: 0, onlyOne: 0, hDiff: 0, mDiff: 0, plDiff: 0, plMax: 0, examples: [] as string[] };
  const at = (t: BlindTable, pi: number, T: number, d: Dir) => t.index.get(rowKey(pi, T, d));
  // every bar of either table (a bar has a buy row and a sell row, or none)
  const seen = new Set<number>();
  for (const t of [o, m]) {
    for (let r = 0; r < t.n; r++) {
      const pi = t.pi[r];
      const T = t.T[r];
      const key = rowKey(pi, T, 1);
      if (seen.has(key)) continue;
      seen.add(key);
      const oBuy = at(o, pi, T, 1);
      const oSell = at(o, pi, T, -1);
      const mBuy = at(m, pi, T, 1);
      const mSell = at(m, pi, T, -1);
      if (oBuy === undefined || oSell === undefined || mBuy === undefined || mSell === undefined || o.i[oBuy] !== m.i[mBuy]) {
        out.onlyOne++;
        if (out.examples.length < 8) out.examples.push(`${PAIRS[pi]} ${iso(T)}: in one table only`);
        continue;
      }
      out.bars++;
      if (m.h[mBuy] !== o.h[oSell]) {
        out.hDiff++;
        if (out.examples.length < 8) out.examples.push(`${PAIRS[pi]} ${iso(T)}: mirror buy h ${m.h[mBuy]}, original sell h ${o.h[oSell]}`);
      }
      if (m.m[mBuy] !== o.m[oSell] || m.m[mSell] !== o.m[oBuy]) out.mDiff++;
      for (const [mr, or] of [[mBuy, oSell], [mSell, oBuy]] as const) {
        const d = Math.abs(m.pl[mr] - o.pl[or]);
        if (d > out.plMax) out.plMax = d;
        if (d > 1e-9) {
          out.plDiff++;
          if (out.examples.length < 8) out.examples.push(`${PAIRS[pi]} ${iso(T)} mirror d=${m.d[mr]} pl ${m.pl[mr]}, original d=${o.d[or]} pl ${o.pl[or]}`);
        }
      }
    }
  }
  return out;
}

// the original's blind table against the run's dump (pair, i, T, d, j, x, subst, m, h, pl)
const tableVsDump = (t: BlindTable, rows: Row[]): string | null => {
  if (rows.length !== t.n) return `${t.n} rows built, ${rows.length} in the dump`;
  for (let r = 0; r < t.n; r++) {
    const x = rows[r];
    const want = [PAIRS[t.pi[r]], t.i[r], t.T[r], t.d[r], t.j[r], t.x[r], t.subst[r], t.m[r], t.h[r], t.pl[r]].map(String);
    const got = [x.pair, x.i, x.T, x.d, x.j, x.x, x.subst, x.m, x.h, x.pl];
    if (want.some((v, k) => v !== got[k])) return `row ${r}: built ${want.join(",")}, dump ${got.join(",")}`;
  }
  return null;
};
const sigVsDump = (sig: TrialSignals, rows: Row[]): string | null => {
  const built = sigKeys(sig, false).sort();
  const dump = rows.map((x) => `${x.pair}|${x.i}|${x.d}|${x.reason}|${x.half === "first" ? 1 : x.half === "second" ? 2 : 0}|${x.warm === "1" ? 1 : 0}`).sort();
  if (built.length !== dump.length) return `${built.length} rows built, ${dump.length} in the dump`;
  for (let k = 0; k < built.length; k++) if (built[k] !== dump[k]) return `built ${built[k]}, dump ${dump[k]}`;
  return null;
};

// a STOP of the judgement (the run's or the flipped run's gmo is not its manifest's): printed, exit 3
class FlipStop extends Error {}

// a run's gmo files are its manifest's (lawsearch.ts's gate 3: the tree sha256 and the file count); a mismatch is a
// STOP. The text after "TREE " on a match.
async function treeOf(run: string, man: { treeSha256: string; files: number }): Promise<string> {
  const tree = await treeSha256(`${run}/gmo`);
  if (tree.sha256 !== man.treeSha256 || tree.files !== man.files) throw new FlipStop(`STOP: ${run}/gmo: tree sha256 ${tree.sha256} (${tree.files} files), the manifest's ${man.treeSha256} (${man.files})`);
  return `${run}/gmo: sha256 ${tree.sha256} (${tree.files} files), the manifest's PASS`;
}

// flipped: the FLIP=1 run whose dumps flipInfo prints (its tree is checked here, before any bar is read)
export async function flipJudge(run: string, tsDir: string, flipped?: string): Promise<{ lines: string[]; passed: boolean }> {
  const lines: string[] = [];
  let passed = true;
  let fails = 0;
  const fail = (line: string) => {
    passed = false;
    fails++;
    lines.push(line);
  };
  const man = JSON.parse(await Deno.readTextFile(`${run}/manifest.json`));
  if (man.version !== GEN_VERSION) throw new Error(`${run}/manifest.json: version ${man.version}, not ${GEN_VERSION}`);
  if (man.spec.flip !== false) throw new Error(`${run}: manifest flip ${man.spec.flip}; the exact mirror is made from the original (FLIP=0) run`);
  // the run's files are its manifest's (lawsearch.ts's gate 3), before any bar is read
  lines.push(`TREE ${await treeOf(run, man)}`);
  // (C4b, 2026-11-05; the lead's E13; design 7.9) the flipped run's files are its manifest's too, checked in the same
  // way right after the original's: before, only its manifest's flip was read, so a FLIP=1 folder whose gmo was not
  // its manifest's gave INFO lines unseen
  if (flipped !== undefined) lines.push(`TREE ${await treeOf(flipped, await flippedManifest(run, flipped))} (the flipped run, whose dumps the INFO lines compare)`);
  const answerKnowing = man.spec.group === "O";
  // the avoid table, as the pipeline reads it
  const avoidBytes = await Deno.readFile("research/ledger/spread-hours-h1.csv");
  const avoidSha = hex(await crypto.subtle.digest("SHA-256", avoidBytes));
  if (avoidSha !== SPREAD_H1_SHA256) throw new Error(`research/ledger/spread-hours-h1.csv: sha256 ${avoidSha}, not ${SPREAD_H1_SHA256}`);
  const avoid = avoidOf(new TextDecoder().decode(avoidBytes));
  // the trials: the run's config.json (no fallback: without it the judgement is not of the run's trials)
  let ids: string[] = [];
  try {
    const cfg = JSON.parse(await Deno.readTextFile(`${tsDir}/config.json`));
    if (!Array.isArray(cfg.trials) || cfg.trials.length === 0 || !cfg.trials.every((x: unknown) => typeof x === "string")) throw new Error("its trials are not a list of trial ids");
    ids = cfg.trials;
  } catch (e) {
    fail(`CONFIG ${tsDir}/config.json: ${(e as Error).message}; the run's trials are not known, so its signals are not judged FAIL`);
  }
  const all = parseCandidates(JSON.parse(await Deno.readTextFile("research/ledger/lawsearch-candidates.json")));
  const trials = ids.map((id) => {
    const t = all.find((x) => x.id === id);
    if (!t || !trialBuilt(t)) throw new Error(`trial ${id} is not built`);
    return t;
  }).sort((a, b) => a.order - b.order);
  lines.push(`FLIP ${man.spec.group} ${man.spec.seed}: the exact mirror of ${run} (spec 23.1), trials ${trials.map((t) => t.id).join("|")}`);
  const src = { dir: `${run}/gmo`, fetch: false };
  const u2 = await loadUniverse(src, S0, END, { purpose: "syn2", band: "syn", plant: "" });
  const u1 = await loadUniverse(src, S0, SPLIT, { purpose: "syn1", band: "syn", plant: "" });
  const { S, lines: sLines } = startsOf(u2, man.spec.fromMs);
  lines.push(`S (the first 5-minute mid open, points): ${sLines.join("; ")}`);
  const m2 = mirrorUniverse(u2, S);
  const m1 = mirrorUniverse(u1, S);
  for (const [o, m] of [[u1, m1], [u2, m2]] as const) {
    const bad = higherCheck(o, m, S);
    if (bad.length) fail(`HIGHER ${o.purpose}: the rebuilt higher bars are not the mirror of the original's: ${bad.slice(0, 4).join("; ")} FAIL`);
    else lines.push(`HIGHER ${o.purpose}: the mirror's higher bars, rebuilt from the mirrored bars, equal the mirror of the original's PASS`);
  }
  const o2 = build(u2, trials, avoid, answerKnowing, "second");
  const n2 = build(m2, trials, avoid, answerKnowing, "second");
  const o1 = build(u1, trials, avoid, answerKnowing, "first");
  const n1 = build(m1, trials, avoid, answerKnowing, "first");
  // the original built here is the run's (its dumps)
  const before = fails;
  for (const t of trials) {
    const rows = await readCsv(`${tsDir}/signals/${t.id}.csv`);
    if (!rows) {
      fail(`ORIGINAL ${t.id}: no ${tsDir}/signals/${t.id}.csv (stage 0 writes it for every trial) FAIL`);
      continue;
    }
    const d = sigVsDump(o2.sig.get(t.id)!, rows);
    if (d) fail(`ORIGINAL ${t.id}: the signals built here differ from the run's dump: ${d} FAIL`);
  }
  // did the run open stage 2? its load.csv has a syn2 row (stage 2 writes it right after loading)
  const load = await readCsv(`${tsDir}/load.csv`);
  if (!load) fail(`ORIGINAL ${tsDir}/load.csv: missing (stage 0 always writes it) FAIL`);
  const stage2 = load !== null && load.some((r) => r.stage === "syn2");
  for (const [half, ob] of [["first", o1], ["second", o2]] as const) {
    for (const tf of ["m15", "h1"] as const) {
      const rows = await readCsv(`${tsDir}/blind/${tf}_${half}.csv`);
      if (!rows) {
        if (half === "first" || stage2 || !load) fail(`ORIGINAL blind/${tf}_${half}.csv: not in the run's dumps (${half === "first" ? "stage 1 writes it" : load ? "the run opened stage 2: its load.csv has a syn2 row" : "no load.csv to tell whether the run opened stage 2"}) FAIL`);
        else lines.push(`ORIGINAL blind/${tf}_${half}.csv: not in the run's dumps (the run did not open stage 2: no syn2 row in load.csv); built here only`);
        continue;
      }
      const d = tableVsDump(ob.table[tf], rows);
      if (d) fail(`ORIGINAL blind/${tf}_${half}.csv: the table built here differs from the run's dump: ${d} FAIL`);
    }
  }
  const origOk = fails === before && ids.length > 0;
  lines.push(`ORIGINAL: the signals and blind tables built here ${origOk ? "equal the run's dumps (every one the run wrote) PASS" : "are not all shown equal to the run's dumps (a dump differs, is missing, or the trials are not known) FAIL"}`);
  // condition 1 and 2 of 14.2: every blind bar of both halves and timeframes
  for (const [half, ob, mb] of [["first", o1, n1], ["second", o2, n2]] as const) {
    for (const tf of ["m15", "h1"] as const) {
      const c = mirrorBlind(ob.table[tf], mb.table[tf]);
      const ok = c.onlyOne === 0 && c.hDiff === 0 && c.plDiff === 0;
      const line = `BLIND ${tf} ${half}: bars ${c.bars}, in one table only ${c.onlyOne}, h differences (mirror buy vs original sell) ${c.hDiff}, PL differences (buy ↔ sell) ${c.plDiff} (max |difference| ${c.plMax} points), m differences ${c.mDiff} ${ok ? "PASS" : "FAIL"}`;
      if (ok) lines.push(line);
      else fail(line);
      for (const x of c.examples) lines.push(`  ${x}`);
    }
  }
  // condition 3: the symmetric items' signals 1-to-1 reversed (≤ 0.1% per trial); B06 printed
  for (const t of trials) {
    const a = sigKeys(o2.sig.get(t.id)!, false);
    const b = sigKeys(n2.sig.get(t.id)!, true);
    const d = setDiff(a, b);
    const share = a.length > 0 ? (d.onlyA + d.onlyB) / a.length : d.onlyB > 0 ? 1 : 0;
    const judged = t.kind !== "B";
    const ok = !judged || share <= 0.001;
    const line = `SIGNALS ${t.id}: original ${a.length}, mirror ${b.length}, only original ${d.onlyA}, only mirror ${d.onlyB}, difference ${pct(share)} ${judged ? (ok ? "PASS (≤ 0.1%)" : "FAIL (> 0.1%)") : "(not symmetric: log returns of mirrored prices; printed, not judged)"}`;
    if (ok) lines.push(line);
    else fail(line);
    for (const x of d.examples.slice(0, 4)) lines.push(`  ${t.id}: ${x}`);
  }
  // information: the trades of the counted signals (the mirror's reversed-direction row against the original's)
  for (const t of trials) {
    for (const [half, ob, mb] of [["first", o1, n1], ["second", o2, n2]] as const) {
      const tf = t.tf;
      const tro = trialRows(ob.table[tf], ob.late[tf], ob.sig.get(t.id)!, half, setOf(ob.u, tf).pairs, "");
      const trm = trialRows(mb.table[tf], mb.late[tf], mb.sig.get(t.id)!, half, setOf(mb.u, tf).pairs, "");
      const mt = mb.table[tf];
      const mRows = new Set(trm.rows);
      let matched = 0;
      let differ = 0;
      let missing = 0;
      for (const r of tro.rows) {
        const ot = ob.table[tf];
        const mr = mt.index.get(rowKey(ot.pi[r], ot.T[r], (-ot.d[r]) as Dir));
        if (mr === undefined || !mRows.has(mr)) {
          missing++;
          continue;
        }
        if (mt.m[mr] === ot.m[r] && mt.h[mr] === ot.h[r] && mt.pl[mr] === ot.pl[r]) matched++;
        else differ++;
      }
      lines.push(`TRADES ${t.id} ${half}: original Δ rows ${tro.rows.length}, mirror Δ rows ${trm.rows.length}; the mirror's reversed-direction trade equal ${matched}, different ${differ}, not a mirror Δ row ${missing} (information)`);
    }
  }
  lines.push(passed ? "RESULT pass" : "RESULT fail");
  return { lines, passed };
}

if (import.meta.main) {
  const args = [...Deno.args];
  const opt = (name: string): string | undefined => {
    const k = args.indexOf(name);
    if (k < 0) return undefined;
    const v = args[k + 1];
    args.splice(k, 2);
    return v;
  };
  const tsA = opt("--ts");
  const tsB = opt("--flipped-ts");
  const [run, flipped] = args;
  if (!run || args.length > 2) {
    console.log("usage: lawsearch-flip.ts <run> [<flipped run>] [--ts <the run's dumps>] [--flipped-ts <the flipped run's dumps>]");
    Deno.exit(2);
  }
  try {
    const { lines, passed } = await flipJudge(run, tsA ?? `${run}/ts`, flipped);
    for (const l of lines) console.log(l);
    // the same condition as flipJudge's tree check of the flipped run, so that no INFO line comes from an unchecked run
    if (flipped !== undefined) for (const l of await flipInfo(run, flipped, tsA ?? `${run}/ts`, tsB ?? `${flipped}/ts`)) console.log(l);
    Deno.exit(passed ? 0 : 3);
  } catch (e) {
    if (e instanceof FlipStop) {
      console.log(e.message);
      Deno.exit(3);
    }
    console.error(e);
    Deno.exit(1);
  }
}
