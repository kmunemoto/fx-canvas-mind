// #318 (docs §8.113 20 (c); SQ-06; plan §5.1): the reproduction of §8.109 / §8.111 rehearsed on made-up files. The real
// reproduction (tf-winrate, macdx.ts MODE=real, ownerhold5's sha256 of §8.111) runs in the real jobs only; here the same
// comparisons run on the reference programs' own walks, so each comparison is shown to work — and to fail on a planted
// difference — before the first real run.
//
//   repro-walk   research/macdx.ts MODE=walk's files (CB_WALK: its walk, dir/SYM/5min/side/all.json; CB_MACDX_OUT: its
//                report.json and decisions.csv). This program's ULTRA measure, counted the tf-winrate way (the on-time
//                signals of bar i's window with START ≤ T, sent, that can be followed 1,440 bars; TP4, SL13; before
//                the halves and the holes), against report.json's whole-period ULTRA row (n, TP, SL, amb, open; the
//                pips a trade within 1e-9) → repro.ultra; its MACD fires (START ≤ T, sent) against decisions.csv's
//                mailed = 1, fire = 1 rows by pair, T and direction → repro.macd.
//   hold-xcheck  research/ownerhold.ts SIGS=ultra5|macdx5 MODE=synthetic FULL=1's folder (CB_OH_DIR: dump/, decisions.txt;
//                CB_OH_DATA its day files, default CB_OH_DIR/gmo). This program's measure on those files, made into the
//                owner-hold list (research/chartbest-hold.ts), against dump/signals.csv → xcheck.sigs; the owner-hold
//                path (the full account through ownerhold.ts's analyse, as a run does it) against decisions.txt →
//                xcheck.decisions.
// 20 (c)「これらの数字はファイルにだけ書き、ログには合否だけを出す」: the numbers go to $CB_OUT/<mode>.json only.

import { DAY } from "./lib.ts";
import { IV5 } from "./ownerhold-data.ts";
import { type Dir, MEASURES, type MeasureId, PAIRS, type Period, STEP } from "./chartbest-const.ts";
import { Checks, Log } from "./chartbest-checks.ts";
import { pairBarsOf } from "./chartbest-bars.ts";
import { loadAllJsonLayout } from "./chartbest-data.ts";
import { loadRun, measureSigs } from "./chartbest-core.ts";
import { macdCands, ultraCands } from "./chartbest-measures.ts";
import { newFollowCtx, tradeOf } from "./chartbest-follow.ts";
import { sent, wk } from "./chartbest-time.ts";
import { underRealCache } from "./chartbest-manifest.ts";
import { Refused, envOf } from "./chartbest-run0.ts";
import { CAP_YEN, START_YEN, holdOne, holdSigsOf, loadStatsOf, m1Window, ownerholdInert, readsOf, synthRates } from "./chartbest-hold.ts";

const periodFrom = (start: number, split: number, end: number, lead: number): Period => ({ name: "main", s0: start - lead, start, split, end, w0: { H1: wk(start), H2: wk(split) } });
const writeOut = async (out: string, name: string, head: Record<string, unknown>, checks: Checks, numbers: unknown) => {
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(`${out}/${name}.json`, JSON.stringify(numbers, null, 1) + "\n");
  await Deno.writeTextFile(`${out}/checks.json`, checks.json(head));
};
const near = (a: number | null, b: number | null, tol = 1e-9) => a !== null && b !== null && Math.abs(a - b) <= tol;

// ---- repro-walk ---------------------------------------------------------------------------------------------------

interface MacdxSummary {
  n: number;
  tp: number;
  sl: number;
  amb: number;
  open: number;
  pips: number | null;
}
interface MacdxReport {
  mode: string;
  start: string;
  split: string;
  end: string;
  pairs: string[];
  dropped?: Record<string, number>;
  tables?: { whole?: { ultra?: MacdxSummary } };
}
// "YYYY-MM-DD" (macdx.ts START / SPLIT) or "YYYY-MM-DD HH:MM:SS" (lib.ts iso, macdx.ts END and closeUtc) as UTC ms
const utcOf = (x: string): number => Date.parse(x.length === 10 ? `${x}T00:00:00Z` : `${x.replace(" ", "T")}Z`);

export const modeReproWalk = async (): Promise<number> => {
  const walk = envOf("CB_WALK");
  const mx = envOf("CB_MACDX_OUT");
  const out = envOf("CB_OUT", "research/out/chartbest/repro-walk");
  Log.mode("repro-walk", "");
  if (!walk || !mx) throw new Refused("repro-walk needs CB_WALK (macdx.ts MODE=walk's walk files) and CB_MACDX_OUT (its report.json and decisions.csv)");
  if ((await underRealCache(walk)) || (await underRealCache(mx))) throw new Refused("repro-walk is made-up only: not research/.cache");
  const report = JSON.parse(await Deno.readTextFile(`${mx}/report.json`)) as MacdxReport;
  if (report.mode !== "walk") throw new Refused(`repro-walk is the made-up rehearsal: report.json is macdx.ts MODE=${report.mode}'s, not MODE=walk's`);
  if (report.pairs.join(",") !== PAIRS.join(",")) throw new Refused(`repro-walk: macdx.ts's pairs ${report.pairs.join(",")}, not the five`);
  const start = utcOf(report.start);
  const split = utcOf(report.split);
  const end = utcOf(report.end);
  // macdx.ts reads its 5-minute bars from START − 5 days (its LEAD); the whole series' MACD starts there too
  const period = periodFrom(start, split, end, 5 * DAY);
  const checks = new Checks();
  const bars = [];
  for (const [pi, pair] of PAIRS.entries()) {
    const q = await loadAllJsonLayout(walk, pair, period);
    bars.push(pairBarsOf(pair, pi, q.quotes, period.end));
  }
  // ULTRA, the tf-winrate way: bar i's own window, START ≤ T, sent, followed 1,440 bars (TP4, SL13), entered at the close
  const mine = { n: 0, tp: 0, sl: 0, amb: 0, open: 0, dropped: 0, pipsSum: 0 };
  const ctx = newFollowCtx("", Infinity);
  for (const pb of bars) {
    for (const c of ultraCands(pb).cands) {
      if (c.T < start || !sent(c.T)) continue;
      const tr = tradeOf(pb, c.i, c.dir, 4, c.i + 1, ctx, pb.mc[c.i]);
      if (!tr) {
        mine.dropped++;
        continue;
      }
      mine.n++;
      mine[tr.kind]++;
      mine.pipsSum += tr.pips;
    }
  }
  const theirs = report.tables?.whole?.ultra ?? null;
  const pips = mine.n ? mine.pipsSum / mine.n : null;
  const uBad: string[] = [];
  if (!theirs) uBad.push("report.json has no whole-period ULTRA row");
  else {
    for (const k of ["n", "tp", "sl", "amb", "open"] as const) if (mine[k] !== theirs[k]) uBad.push(`${k}`);
    if (!(near(pips, theirs.pips) || (pips === null && theirs.pips === null))) uBad.push("pips");
    if (report.dropped && (report.dropped.ultra ?? 0) !== mine.dropped) uBad.push("dropped");
  }
  checks.count("repro.ultra", uBad.length, 6, uBad.length ? uBad : undefined);
  // MACD: this program's fires (START ≤ T, sent) against decisions.csv's mailed = 1, fire = 1 rows (pair, T, direction)
  const text = await Deno.readTextFile(`${mx}/decisions.csv`);
  const [head, ...rows] = text.trim().split("\n");
  const col = Object.fromEntries(head.split(",").map((h, k) => [h, k]));
  for (const h of ["pair", "closeUtc", "dir", "mailed", "fire"]) if (col[h] === undefined) throw new Refused(`decisions.csv has no column ${h}`);
  const theirsM = new Set<string>();
  for (const r of rows) {
    const c = r.split(",");
    if (c[col.mailed] !== "1" || c[col.fire] !== "1") continue;
    theirsM.add(`${c[col.pair]}|${utcOf(c[col.closeUtc])}|${c[col.dir] === "UP" ? 1 : c[col.dir] === "DOWN" ? -1 : 0}`);
  }
  const mineM = new Set<string>();
  for (const pb of bars) {
    for (const [i, dir] of macdCands(pb).fire) {
      const T = pb.t[i] + STEP;
      if (T < start || !sent(T)) continue;
      mineM.add(`${pb.pair}|${T}|${dir as Dir}`);
    }
  }
  const onlyMine = [...mineM].filter((k) => !theirsM.has(k));
  const onlyTheirs = [...theirsM].filter((k) => !mineM.has(k));
  const mBad = onlyMine.length + onlyTheirs.length + (mineM.size === 0 ? 1 : 0);
  checks.count("repro.macd", mBad, Math.max(mineM.size, theirsM.size), mBad ? { onlyMine: onlyMine.length, onlyTheirs: onlyTheirs.length } : undefined);
  await writeOut(out, "repro-walk", { mode: "repro-walk" }, checks, {
    period: { start: report.start, split: report.split, end: report.end },
    ultra: { mine: { ...mine, pips }, theirs },
    macd: { mine: mineM.size, theirs: theirsM.size, onlyMine: onlyMine.slice(0, 20), onlyTheirs: onlyTheirs.slice(0, 20) },
  });
  return checks.ok() ? 0 : 1;
};

// ---- hold-xcheck --------------------------------------------------------------------------------------------------

interface OhMeta {
  start: number;
  end: number;
  split: number;
  delay: number;
  startYen: number;
  cap: number;
  step?: number;
  sigs?: string;
}
const SIG_HEADER = "i,pair,side,open,T,E,tp,late,base";

export const modeHoldXcheck = async (): Promise<number> => {
  const dir = envOf("CB_OH_DIR");
  const data = envOf("CB_OH_DATA", `${dir}/gmo`);
  const out = envOf("CB_OUT", "research/out/chartbest/hold-xcheck");
  Log.mode("hold-xcheck", "");
  if (!dir) throw new Refused("hold-xcheck needs CB_OH_DIR (ownerhold.ts MODE=synthetic FULL=1's syn-none-<seed> folder)");
  if ((await underRealCache(dir)) || (await underRealCache(data))) throw new Refused("hold-xcheck is made-up only: not research/.cache");
  const meta = JSON.parse(await Deno.readTextFile(`${dir}/dump/meta.json`)) as OhMeta;
  const src = meta.sigs as MeasureId;
  if (!MEASURES.includes(src)) throw new Refused(`hold-xcheck: dump/meta.json's sigs ${meta.sigs}, not ultra5 or macdx5 (ownerhold.ts SIGS)`);
  if (meta.step !== 5 || meta.delay !== 2 || meta.startYen !== START_YEN || meta.cap !== CAP_YEN) throw new Refused("hold-xcheck: dump/meta.json is not a 5-minute run of §8.111's account");
  // ownerhold.ts reads the 5-minute bars from START − its 5-minute lead (IV5.lead), its 1-minute bars from START − 1 day
  const period = periodFrom(meta.start, meta.split, meta.end, IV5.lead);
  const checks = new Checks();
  const rb = await loadRun({ dir: data, real: false }, period, true, true, false);
  const ms = measureSigs(src, rb, "");
  const sigs = holdSigsOf(ms.recs, ms.late, rb.bars, meta.start, meta.end);
  // (1) the list: this program's measure made into the owner-hold emails, against ownerhold.ts's dump/signals.csv
  const mineSig = [SIG_HEADER, ...sigs.map((s, i) => `${i},${s.pair},${s.side},${s.open},${s.T},${s.E},${s.tp},${s.late ? 1 : 0},${s.base}`)];
  const theirsSig = (await Deno.readTextFile(`${dir}/dump/signals.csv`)).trim().split("\n");
  let sBad = Math.abs(mineSig.length - theirsSig.length);
  const sEx: number[] = [];
  for (let k = 0; k < Math.min(mineSig.length, theirsSig.length); k++) {
    if (mineSig[k] === theirsSig[k]) continue;
    sBad++;
    if (sEx.length < 5) sEx.push(k);
  }
  checks.count("xcheck.sigs", sBad, mineSig.length - 1, sBad ? { rows: theirsSig.length - 1, ownRows: mineSig.length - 1, firstDifferingLines: sEx } : undefined);
  // (2) the owner-hold path (the full account, as a stage-2 run makes it) against ownerhold.ts's decisions.txt
  const oh = await ownerholdInert();
  const ctx = { start: meta.start, end: meta.end, split: meta.split, startYen: meta.startYen, cap: meta.cap };
  const one = await holdOne(oh, {
    src, account: "full", email: true, sigs, reads: readsOf(rb.bars, sigs, ctx.start, ctx.end),
    m1s: rb.m1!.map((m) => m1Window(m, ctx.start - DAY, ctx.end)), ctx, rates: synthRates, load: loadStatsOf(rb.diags), outDir: `${out}/hold`,
  });
  const mineDec = (await Deno.readTextFile(`${one.dir}/decisions.txt`)).split("\n");
  const theirsDec = (await Deno.readTextFile(`${dir}/decisions.txt`)).split("\n");
  let dBad = Math.abs(mineDec.length - theirsDec.length);
  const dEx: number[] = [];
  for (let k = 0; k < Math.min(mineDec.length, theirsDec.length); k++) {
    if (mineDec[k] === theirsDec[k]) continue;
    dBad++;
    if (dEx.length < 5) dEx.push(k);
  }
  checks.count("xcheck.decisions", dBad, mineDec.length, dBad ? { lines: theirsDec.length, ownLines: mineDec.length, firstDifferingLines: dEx } : undefined);
  // the owner-hold path's own checks on these files (§8.111's, through analyse)
  for (const [k, c] of Object.entries(one.checks)) checks.set(`xcheck.hold.${k}`, c);
  await writeOut(out, "hold-xcheck", { mode: "hold-xcheck", sigs: src }, checks, {
    sigs: src, period: { start: meta.start, split: meta.split, end: meta.end }, signals: sigs.length, theirSignals: theirsSig.length - 1,
    decisions: mineDec.length, theirDecisions: theirsDec.length,
  });
  return checks.ok() ? 0 : 1;
};
