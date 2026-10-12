// #318 (docs §8.113; plan §5): the modes of research/chartbest.ts.

import { AMOUNTS, type Group, type Half, ITEM_TABLE, MEASURES, PAIRS, type Period, SETS, SPEC, SPREAD_HOURS } from "./chartbest-const.ts";
import { Checks, Log, Printer } from "./chartbest-checks.ts";
import { generatePair, gmoWeekBreaks, bandBreaks, parseSpreadTable, writeTickFiles, type GenSet } from "./chartbest-gen.ts";
import { sha256Hex } from "./chartbest-data.ts";
import { type RunCfg, Refused, type HalfRows, type Signals, envOf, halfRowsOf, reconcile, statsJson, yardstickHits } from "./chartbest-run.ts";
import type { RunBars } from "./chartbest-core.ts";
import { type Stage0, floorFromCounts } from "./chartbest-count.ts";
import { NOT_ELIGIBLE_ORDER, type Stage1, type Stage2, chooseStage1, groupOfItem, intervalsSeen1, stage2Of } from "./chartbest-select.ts";
import { alwaysRowsOf, alwaysText, fmt, stage1Text, stage2Text } from "./chartbest-text.ts";
import * as dump from "./chartbest-dump.ts";
import { followFirstCheck, followFixedCheck, followSample, h1OnlyCheck } from "./chartbest-lookfollow.ts";
import { mergeProbes } from "./chartbest-lookahead.ts";
import type { Probe } from "./chartbest-measures.ts";
import { PLANTS, plant as currentPlant, plantDef } from "./chartbest-plants.ts";
import { type HandCase, handPath, runHand } from "./chartbest-hand.ts";
import { usedCand } from "./chartbest-stats.ts";
import { type WalkLedger, exists, finishRun, ledgerRead, ledgerWrite, modeStage0, realGuard, stage0Part } from "./chartbest-stage0.ts";
import { calibTargets, condD, condE, condH, condN, condO, condQ, flipCompare, nSummaryOf, readSums } from "./chartbest-sets.ts";
import { loadRun } from "./chartbest-core.ts";
import { itemsOf } from "./chartbest-items.ts";
import { periodOf } from "./chartbest-const.ts";

export { realGuard };

// ---- gen -------------------------------------------------------------------------------------------------------

export const amountFor = (set: string, seed: number, period: Period): number => {
  if (set === "N" || set === "O") return 0;
  const given = envOf("CB_AMOUNT");
  const trial = SETS.TRIAL.includes(seed) || period.name === "mini";
  if (given !== "") {
    if (!trial) throw new Refused(`CB_AMOUNT is for the trial seeds 901–920 (or the mini period), not seed ${seed}`);
    return Number(given);
  }
  const a = AMOUNTS[set as keyof typeof AMOUNTS];
  if (a === null || a === undefined) throw new Refused(`set ${set}: its amount is not written yet (20 (e) 強さ, SQ-28)`);
  return a;
};

export const genSet = async (cfg: RunCfg, dir: string, checks: Checks): Promise<void> => {
  const set = cfg.set as GenSet;
  if (!["N", "D", "H", "E", "E3", "Q", "O"].includes(set)) throw new Refused(`CB_SET ${cfg.set}: N, D, H, E, E3, Q or O`);
  const amount = amountFor(set, cfg.seed, cfg.period);
  const text = await Deno.readTextFile(SPREAD_HOURS.path);
  const sha = await sha256Hex(new TextEncoder().encode(text));
  Log.sha(SPREAD_HOURS.path, sha);
  checks.count("data.spreadSha", sha === SPREAD_HOURS.sha256 ? 0 : 1, 1);
  const spreads = parseSpreadTable(text);
  let weekBad = 0;
  let bandBad = 0;
  let bars = 0;
  for (const [pi, pair] of PAIRS.entries()) {
    const gp = generatePair(pair, pi, { set, seed: cfg.seed, amount, flip: cfg.flip, period: cfg.period, minutes: cfg.full }, spreads);
    weekBad += gmoWeekBreaks(gp.five, 5 * 60_000);
    bandBad += bandBreaks(gp.five, pair);
    bars += gp.five.n;
    await writeTickFiles(dir, pair, "5min", gp.five, cfg.period);
    if (gp.minutes) {
      weekBad += gmoWeekBreaks(gp.minutes, 60_000);
      bandBad += bandBreaks(gp.minutes, pair);
      await writeTickFiles(dir, pair, "1min", gp.minutes, cfg.period);
    }
    Log.madeup(`gen.${pair.replace("/", "")}.pushes`, gp.diag.pushes);
    Log.madeup(`gen.${pair.replace("/", "")}.bounces`, gp.diag.bounces);
  }
  checks.count("gen.gmoWeek", weekBad, bars);
  checks.count("gen.band", bandBad, bars);
};

export const modeGen = async (cfg: RunCfg): Promise<number> => {
  Log.mode("gen", `set=${cfg.set} seed=${cfg.seed} flip=${cfg.flip ? 1 : 0} period=${cfg.period.name}`);
  const checks = new Checks();
  await genSet(cfg, `${cfg.out}/gmo`, checks);
  await Deno.writeTextFile(`${cfg.out}/gen-checks.json`, checks.json({ mode: "gen", set: cfg.set, seed: cfg.seed, flip: cfg.flip }));
  return checks.ok() ? 0 : 1;
};

// ---- run / stage0 / stage1 / stage2 --------------------------------------------------------------------------------

export interface RunState {
  cfg: RunCfg;
  checks: Checks;
  printer: Printer;
  rb: RunBars;
  sig: Signals;
  s0: Stage0;
  h1: HalfRows | null;
  s1: Stage1 | null;
  h2: HalfRows | null;
  s2: Stage2 | null;
  sentences: Array<[string, string]>;
  chosen: string[];
}

const followChecks = (checks: Checks, rb: RunBars, sig: Signals, half: Half, which: string[], plant: string, name: string) => {
  const fixed: Probe[] = [];
  const first: Probe[] = [];
  for (const s of sig.items) {
    if (!which.includes(s.src)) continue;
    const counted = s.recs.filter((r) => r.reason === "counted" && r.half === half);
    for (const pb of rb.bars) {
      const sample = followSample(counted, pb.pi);
      if (!sample.length) continue;
      fixed.push(followFixedCheck(pb, sample, plant));
      first.push(followFirstCheck(pb, sample, plant));
    }
  }
  const f = mergeProbes(fixed);
  const g = mergeProbes(first);
  checks.count(`lookahead.followFixed${name}`, f.mismatched, f.compared, f.examples.length ? f.examples.slice(0, 3) : undefined);
  checks.count(`lookahead.followFirst${name}`, g.mismatched, g.compared, g.examples.length ? g.examples.slice(0, 3) : undefined);
};

// 15: what each stage prints. Stage 1: the 95% interval of Δ and a (items, the emails in both layers) and the
// blind's pair × direction a; W, PL and Δ_late as points. Stage 2: every interval of 14 and 10 (the chosen
// items' Δ, Δ_late, a, W/PL, D_U, D_M; the emails' Δ, a, Δ_late per layer and W/PL; the blind's pair ×
// direction a and W/PL). The count of the printed intervals is checked against intervalsSeen (print.intervals).
const pairKey = (pair: string) => pair.replace("/", "_");
const winPl = (pr: Printer, k: string, w: { wRes: number | null; pl: number | null; wLo: number | null; wHi: number | null; plLo: number | null; plHi: number | null }, n: "1" | "2", lohi: boolean) => {
  pr.line(`${k}.w${n}`, fmt.pct(w.wRes));
  pr.line(`${k}.pl${n}`, fmt.pips(w.pl));
  if (!lohi) return;
  pr.line(`${k}.w${n}Lo`, fmt.pct(w.wLo));
  pr.line(`${k}.w${n}Hi`, fmt.pct(w.wHi));
  pr.line(`${k}.pl${n}Lo`, fmt.pips(w.plLo));
  pr.line(`${k}.pl${n}Hi`, fmt.pips(w.plHi));
};
const printRow = (pr: Printer, stage: "s1" | "s2", hr: HalfRows, r: (typeof hr.items)[number], winPlIntervals: boolean) => {
  const k = `${stage}.${r.src}.${hr.half}.${r.layer}`;
  const s2 = stage === "s2";
  pr.line(`${k}.delta`, fmt.pts(r.delta.est));
  pr.line(`${k}.lo`, fmt.pts(r.delta.lo));
  pr.line(`${k}.hi`, fmt.pts(r.delta.hi));
  pr.line(`${k}.nE`, r.nE);
  pr.line(`${k}.a`, fmt.pts(r.a.est));
  pr.line(`${k}.aLo`, fmt.pts(r.a.lo));
  pr.line(`${k}.aHi`, fmt.pts(r.a.hi));
  pr.line(`${k}.late`, fmt.pts(r.late.est));
  if (s2) {
    pr.line(`${k}.lateLo`, fmt.pts(r.late.lo));
    pr.line(`${k}.lateHi`, fmt.pts(r.late.hi));
  }
  winPl(pr, k, r.w4, "1", s2 && winPlIntervals);
  winPl(pr, k, r.w10, "2", s2 && winPlIntervals);
  pr.line(`${k}.suspicious`, r.suspicious.join(";"));
};
const printRows = (pr: Printer, stage: "s1" | "s2", hr: HalfRows, s2?: Stage2) => {
  for (const r of hr.items) {
    if (stage === "s2" && !s2?.items.some((x) => x.src === r.src)) continue;
    printRow(pr, stage, hr, r, true);
    const x = s2?.items.find((y) => y.src === r.src);
    if (!x) continue;
    const k = `s2.${r.src}.${hr.half}.${r.layer}`;
    for (const [n, e] of [["dU", x.dU], ["dM", x.dM]] as const) {
      pr.line(`${k}.${n}`, fmt.pts(e.est));
      pr.line(`${k}.${n}Lo`, fmt.pts(e.lo));
      pr.line(`${k}.${n}Hi`, fmt.pts(e.hi));
    }
  }
  // the emails: both layers; their W/PL once (they do not depend on the layer)
  for (const id of MEASURES) for (const g of ["chart", "cal"] as const) printRow(pr, stage, hr, hr.emails[id][g], g === "chart");
  for (const b of hr.blind) {
    const whole = b.key === "BUY" || b.key === "SELL";
    const k = whole ? `${stage}.blind.${hr.half}.${b.key}` : `${stage}.blind.${hr.half}.${pairKey(b.key.split(" ")[0])}.${b.key.split(" ")[1]}`;
    pr.line(`${k}.a`, fmt.pts(b.a.est));
    if (!whole) {
      pr.line(`${k}.aLo`, fmt.pts(b.a.lo));
      pr.line(`${k}.aHi`, fmt.pts(b.a.hi));
    }
    winPl(pr, k, b.w4, "1", stage === "s2" && !whole);
    winPl(pr, k, b.w10, "2", stage === "s2" && !whole);
    if (whole) pr.line(`${k}.suspicious`, b.suspicious.join(";"));
  }
};
const printStage2 = (pr: Printer, s2: Stage2) => {
  for (const x of s2.items) {
    const k = `s2.${x.src}`;
    pr.line(`${k}.p`, x.p.toFixed(4));
    pr.line(`${k}.holm`, x.holmPass ? "pass" : "no");
    pr.line(`${k}.c1`, x.c1 ? "yes" : "no");
    pr.line(`${k}.c2`, x.c2 === null ? "n/a" : x.c2 ? "yes" : "no");
    pr.line(`${k}.c3`, x.c3 === null ? "n/a" : x.c3 ? "yes" : "no");
    pr.line(`${k}.c4`, x.c4 ? "yes" : "no");
    pr.line(`${k}.c5`, x.c5 ? "yes" : "no");
    pr.line(`${k}.judgment`, x.judgment);
    pr.line(`${k}.form`, x.form ?? "-");
    pr.line(`${k}.mde`, fmt.pts(x.mde));
    pr.line(`${k}.simLb`, fmt.pts(x.simLb));
    pr.line(`${k}.dULb`, fmt.pts(x.dULb));
    pr.line(`${k}.dMLb`, fmt.pts(x.dMLb));
  }
  for (const g of ["chart", "cal"] as const) pr.line(`s2.promote.${g}`, s2.promote[g] ?? "-");
  for (const d of s2.dAB) {
    const k = `s2.dAB.${d.A}.${d.B}`;
    pr.line(`${k}.est`, fmt.pts(d.est.est));
    pr.line(`${k}.lo`, fmt.pts(d.est.lo));
    pr.line(`${k}.hi`, fmt.pts(d.est.hi));
  }
  pr.line("s2.intervalsSeen", s2.intervalsSeen.total);
};

// select.json and stage2.json (plan §4.3, in the layout the Python writes)
const selectJson = (s1: Stage1, m1: { chart: number; cal: number }) => {
  const notEligibleCount = {} as Record<Group, Record<string, number>>;
  for (const g of ["chart", "cal"] as const) {
    notEligibleCount[g] = Object.fromEntries(NOT_ELIGIBLE_ORDER.map((r) => [r, Object.entries(s1.notEligible).filter(([id, x]) => x === r && groupOfItem(id) === g).length]));
  }
  return {
    eligible: s1.eligible,
    notEligible: s1.notEligible,
    notEligibleCount,
    ranking: s1.ranking,
    chosen: s1.chosen,
    Ktotal: s1.kTotal,
    lbPositive: s1.lbPositive,
    shift95: { items: { mean: s1.shift95.items.mean, q95: s1.shift95.items.p95 }, groups: { mean: s1.shift95.groups.mean, q95: s1.shift95.groups.p95 }, k: s1.shift95.k },
    chanceLb: s1.chanceLb,
    yardstickHit: s1.yardstickHits.length > 0,
    intervalsSeen: intervalsSeen1(m1.chart + m1.cal),
  };
};
const stage2Json = (s2: Stage2, yardstickHit: boolean) => ({
  items: Object.fromEntries(s2.items.map((x) => [x.src, {
    p: x.p, t: x.t, df: x.df, holmRank: x.holmRank, holmPass: x.holmPass,
    c1: x.c1, c2: x.c2, c3: x.c3, c4: x.c4, c5: x.c5, c2c3Applied: { c2: x.c2Applied, c3: x.c3Applied },
    judgment: x.judgment, form: x.form, mde: x.mde, passMin: x.passMin, simLb: x.simLb,
    dU: dump.estJson(x.dU, "diff"), dM: dump.estJson(x.dM, "diff"), dUSimLb: x.dULb, dMSimLb: x.dMLb, marks: x.marks,
  }])),
  promote: s2.promote,
  dAB: s2.dAB.map((d) => ({ A: d.A, B: d.B, est: dump.estJson(d.est, "diff") })),
  Ktotal: s2.kTotal,
  yardstickHit,
  intervalsSeen: s2.intervalsSeen,
});

// the light-run summary the sets read (20 (e))
const summaryOf = (st: RunState) => {
  const items: Record<string, unknown> = {};
  for (const s of st.sig.items) {
    const r1 = st.h1?.items.find((r) => r.src === s.src) ?? null;
    const c = r1 ? usedCand(r1.delta) : null;
    const wide = r1 ? r1.delta.cands.filter((x) => x.kind !== "shift").reduce<null | (typeof r1.delta.cands)[number]>((a, x) => (!a || x.half > a.half ? x : a), null) : null;
    const x2 = st.s2?.items.find((x) => x.src === s.src) ?? null;
    const r2 = st.h2?.items.find((r) => r.src === s.src) ?? null;
    items[s.src] = {
      floor: st.s0.sources[s.src].floor,
      H1: r1 ? { delta: r1.delta.est, se: c?.se ?? null, seKind: r1.delta.use, df: c?.df ?? null, seWide: wide?.se ?? null, t: r1.delta.t, p: c && r1.delta.t !== null ? 1 - tcdfOf(r1.delta.t, c.df) : null, nE: r1.nE, a: r1.a.est, aSe: usedCand(r1.a)?.se ?? null, lateT: r1.late.t, suspicious: r1.suspicious } : null,
      chosen: st.chosen.includes(s.src),
      H2: x2 && r2 ? { delta: r2.delta.est, t: r2.delta.t, c1: x2.c1, judgment: x2.judgment } : null,
    };
  }
  const blind: Record<string, unknown> = {};
  for (const hr of [st.h1, st.h2]) {
    if (!hr) continue;
    blind[hr.half] = Object.fromEntries(hr.blind.filter((b) => b.key === "BUY" || b.key === "SELL").map((b) => [b.key, { a: b.a.est, w1: b.w4.wRes }]));
  }
  const confirmed = (st.s2?.items ?? []).filter((x) => x.judgment === "confirmed").map((x) => x.src);
  return {
    set: st.cfg.set, seed: st.cfg.seed, flip: st.cfg.flip, period: st.cfg.period.name, full: st.cfg.full,
    checksOk: st.checks.ok(), failed: st.checks.failed(), stopped: st.s1?.stopped ?? false,
    items, blind, chosen: st.chosen, confirmed,
    confirmedChart: confirmed.filter((id) => groupOfItem(id) === "chart"),
    confirmedCal: confirmed.filter((id) => groupOfItem(id) === "cal"),
    m1: st.s0.M1,
  };
};
import { tcdf as tcdfOf } from "./chartbest-stats.ts";

export const modeRun = async (cfg: RunCfg, mode: string, plant: string): Promise<number> => {
  Log.mode(mode, `set=${cfg.set} seed=${cfg.seed} flip=${cfg.flip ? 1 : 0} period=${cfg.period.name} full=${cfg.full ? 1 : 0}${plant ? ` plant=${plant}` : ""}`);
  if (cfg.data === "real") {
    if (mode === "run") throw new Refused("CB_MODE=run is made-up only; the real stages are stage0, stage1, stage2");
    // 11: the real stage 0 runs from research/chartbest-stage0.ts, whose program loads no follow code
    if (mode === "stage0") throw new Refused("the real stage 0 runs from research/chartbest-stage0.ts (no follow code loaded)");
    await realGuard(mode);
  }
  if (plant && cfg.data === "real") throw new Refused("a planted error never runs on real data");
  if (!cfg.data) throw new Refused("CB_DATA (the day files' folder) is not given");
  if (mode === "stage0") return modeStage0(cfg, plant);
  const checks = new Checks();
  const printer = new Printer();
  const w: WalkLedger = { dir: `${cfg.out}/walk-ledger` };
  await Deno.mkdir(cfg.out, { recursive: true });
  const head = { mode, set: cfg.set, seed: cfg.seed, flip: cfg.flip, period: cfg.period.name, plant, full: cfg.full };
  const finish = async (code: number, st?: Partial<RunState>): Promise<number> => {
    const c = await finishRun(cfg.out, head, checks, printer, code, plant);
    if (st && st.s0 && mode === "run") await Deno.writeTextFile(`${cfg.out}/summary.json`, JSON.stringify(summaryOf(st as RunState), dump.jsonReplacer, 1) + "\n");
    return c;
  };
  // the walk ledger is read against its sha256 before any bar: a changed file stops the stage (exit 2)
  const ledgerCounts = mode === "stage1" ? await ledgerRead<Record<string, unknown>>(w, "counts.json", envOf("CB_WALK_COUNTS_SHA256")) : null;
  const ledgerChoice = mode === "stage2" ? await ledgerRead<{ chosen: Record<Group, string[]> }>(w, "choice.json", envOf("CB_WALK_CHOICE_SHA256")) : null;
  // ---- the gates and stage 0 (research/chartbest-stage0.ts)
  const z = await stage0Part(cfg, mode, plant, checks, printer, head);
  if (!z) return 2;
  const { rb, sig, s0, counts, madeUp, dumps, tsDir } = z;
  const st: RunState = { cfg, checks, printer, rb, sig, s0, h1: null, s1: null, h2: null, s2: null, sentences: [], chosen: [] };
  // ---- stage 1 (the counts as stage 0 fixed them)
  let floor = s0.floorItems;
  let groups = s0.groups;
  if (ledgerCounts) {
    const c = ledgerCounts;
    const f = floorFromCounts(c.v);
    floor = f.floor;
    groups = f.groups;
    // the counts stage 0 fixed must be the counts these bars give (the same data, the same program)
    const same = JSON.stringify(c.v, dump.jsonReplacer) === JSON.stringify(counts, dump.jsonReplacer);
    checks.count("gate.counts", same ? 0 : 1, 1);
  }
  if (mode === "run" || mode === "stage1") {
    const h1 = halfRowsOf(rb, sig, "H1", floor, plant, cfg.period.split);
    st.h1 = h1;
    const hits = yardstickHits(h1);
    const countsOnly = SPEC.suspicionCountsOnly.includes(cfg.set);
    checks.count("suspect.yardstick", hits.length && !countsOnly ? hits.length : 0, MEASURES.length * 2 + 2, hits.length ? hits : undefined);
    if (cfg.full) {
      followChecks(checks, rb, sig, "H1", sig.items.map((s) => s.src), plant, "");
      const followedT = h1.bt.pairs.flatMap((bp) => Array.from(bp.T));
      const h1p = h1OnlyCheck(h1.bt.maxReadClose, h1.bt.pastReadEnd, followedT, cfg.period.split);
      checks.count("lookahead.h1Only", h1p.mismatched, h1p.compared, h1p.examples.length ? h1p.examples : undefined);
    } else for (const n of ["lookahead.followFixed", "lookahead.followFirst", "lookahead.h1Only"]) checks.skip(n, "light run");
    const s1 = chooseStage1({ rows: h1.items, groups, checksOk: checks.ok(), plant, countsOnly, yardstickHits: hits });
    st.s1 = s1;
    printRows(printer, "s1", h1);
    for (const g of ["chart", "cal"] as const) printer.line(`s1.chosen.${g}`, s1.chosen[g].join(";"));
    printer.line("s1.kTotal", s1.kTotal);
    const seen1 = intervalsSeen1(floor.length);
    printer.line("s1.intervalsSeen", seen1.total);
    const printed1 = printer.intervals("s1.");
    checks.count("print.intervals1", printed1 === seen1.total ? 0 : 1, printed1, printed1 === seen1.total ? undefined : { printed: printed1, counted: seen1.total });
    // made-up only: a forced choice (CB_FORCE_CHOICE) is what the walk ledger hands to the stage-2 process (the
    // pipeline rehearsal computes those items); stage 1's own choice is kept beside it and printed as it is
    const forced = cfg.forceChoice && madeUp ? { chart: cfg.forceChoice.filter((id) => groupOfItem(id) === "chart"), cal: cfg.forceChoice.filter((id) => groupOfItem(id) === "cal") } : null;
    const choice = { chosen: forced ?? s1.chosen, forced: forced !== null, stage1Chosen: s1.chosen, kTotal: s1.kTotal, groups, floor };
    await ledgerWrite(w, "choice.json", choice);
    st.sentences.push(...stage1Text(s1, { m1: s0.M1, rows: h1.items, kTotal: s1.kTotal }, groupOfItem));
    st.sentences.push(alwaysText("always.s1", alwaysRowsOf(h1.items, MEASURES.map((id) => h1.emails[id].chart), h1.blind, "前半"), null));
    if (dumps) {
      await dump.writeBlind(tsDir, h1.bt, rb.bars);
      await dump.writeJson(tsDir, "select.json", selectJson(s1, { chart: floor.filter((id) => groupOfItem(id) === "chart").length, cal: floor.filter((id) => groupOfItem(id) === "cal").length }));
    }
  }
  // ---- stage 2 (only the chosen items, or the made-up forced choice)
  if (mode === "run" || mode === "stage2") {
    let chosen: string[];
    if (ledgerChoice) {
      const c = ledgerChoice;
      chosen = [...c.v.chosen.chart, ...c.v.chosen.cal];
      checks.count("gate.choice", 0, 1);
    } else chosen = cfg.forceChoice ?? [...(st.s1?.chosen.chart ?? []), ...(st.s1?.chosen.cal ?? [])];
    if (cfg.forceChoice && !madeUp) throw new Refused("CB_FORCE_CHOICE is for made-up runs only");
    chosen = ITEM_TABLE.filter((r) => chosen.includes(r.id)).map((r) => r.id);
    // the gate (14): stage 2 computes the chosen items only (the plant computes one more, which the gate catches)
    const computed = plant === "stage2Unselected" ? [...chosen, ...sig.items.map((s) => s.src).filter((id) => !chosen.includes(id)).slice(0, 1)] : chosen;
    const extra = computed.filter((id) => !chosen.includes(id));
    checks.count("gate.unselected", extra.length, computed.length, extra.length ? extra : undefined);
    st.chosen = chosen;
    if (chosen.length) {
      const h2 = halfRowsOf(rb, sig, "H2", computed, plant, cfg.period.end);
      st.h2 = h2;
      const rows2 = h2.items.filter((r) => chosen.includes(r.src));
      const countsOnly = SPEC.suspicionCountsOnly.includes(cfg.set);
      // 13: the yardsticks' second-half rows; a hit stops everything (the made-up H only counts it)
      const hits2 = yardstickHits(h2);
      checks.count("suspect.yardstick2", hits2.length && !countsOnly ? hits2.length : 0, MEASURES.length * 2 + 2, hits2.length ? hits2 : undefined);
      const s2 = stage2Of({ rows: rows2, ultra: h2.emails.ultra5, macd: h2.emails.macdx5, plant, countsOnly });
      st.s2 = s2;
      if (cfg.full) followChecks(checks, rb, sig, "H2", chosen, plant, "2");
      printRows(printer, "s2", h2, s2);
      printStage2(printer, s2);
      const printed2 = printer.intervals("s2.");
      checks.count("print.intervals2", printed2 === s2.intervalsSeen.total ? 0 : 1, printed2, printed2 === s2.intervalsSeen.total ? undefined : { printed: printed2, counted: s2.intervalsSeen.total });
      const holdText = new Map<string, string>();
      st.sentences.push(...stage2Text(s2, { kTotal: s2.kTotal, m1: s0.M1.chart + s0.M1.cal, rows: new Map(rows2.map((r) => [r.src, r])), ultra: h2.emails.ultra5[groupOfItem(chosen[0])], macd: h2.emails.macdx5[groupOfItem(chosen[0])], hold: holdText }));
      st.sentences.push(alwaysText("always.s2", alwaysRowsOf(rows2, MEASURES.map((id) => h2.emails[id].chart), h2.blind, "後半"), null));
      if (dumps) {
        await dump.writeBlind(tsDir, h2.bt, rb.bars);
        await dump.writeJson(tsDir, "stage2.json", stage2Json(s2, hits2.length > 0));
      }
    } else checks.skip("lookahead.followFixed2", "no item chosen");
  }
  reconcile(checks, sig, s0, [st.h1, st.h2].filter((x): x is HalfRows => x !== null));
  if (dumps) {
    const halves = [st.h1, st.h2].filter((x): x is HalfRows => x !== null);
    await dump.writeJson(tsDir, "stats.json", statsJson(halves));
    await dump.writeTrades(tsDir, halves.flatMap((hr) => dump.tradeRows(hr.trades, plant)));
    await dump.writeShift(tsDir, halves.flatMap((hr) => [...hr.items, ...MEASURES.map((id) => hr.emails[id].chart)].flatMap((r) => dump.shiftRows(r))));
    await dump.writeSentences(tsDir, st.sentences);
  }
  for (const [id, text] of st.sentences) printer.line(`text.${id}`, text);
  // the planted errors of the printer (20 (f)): a number not in the list, a number to the log
  if (plant === "printExtraItem") printer.line("delta.raw", "0.123");
  if (plant === "printToLog") Log.raw(`delta ${fmt.pts(0.0123)}`);
  return finish(0, st);
};

// 20 (g): the hand examples (research/chartbest/hand.json) through the program's own functions; writes
// hand-results.json (with the sha256 of the hand.json it ran, which the run's gate compares) and checks.json.
// A plant run (CB_PLANT of hook "hand") completes with exit 0; plant-sum reads which cases failed.
export const mode_hand = async (): Promise<number> => {
  const plant = currentPlant();
  const out = envOf("CB_OUT", "research/out/chartbest/hand");
  const path = envOf("CB_HAND", handPath);
  Log.mode("hand", plant ? `plant=${plant}` : "");
  const text = await Deno.readTextFile(path);
  const sha = await sha256Hex(new TextEncoder().encode(text));
  Log.sha(path, sha);
  const doc = JSON.parse(text) as { cases: HandCase[] };
  const res = await runHand(doc.cases, plant);
  const checks = new Checks();
  for (const [id, r] of Object.entries(res)) checks.set(`hand.${id}`, r.ok ? { ok: true, n: 1 } : { ok: false, n: 1, detail: r.detail });
  const ok = checks.ok();
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(`${out}/hand-results.json`, JSON.stringify({ ok, plant, handSha: sha, cases: res }, null, 1) + "\n");
  await Deno.writeTextFile(`${out}/checks.json`, checks.json({ mode: "hand", plant }));
  return ok || plant ? 0 : 1;
};

export const mode_plants_list = async (): Promise<number> => {
  Log.json(PLANTS.filter((p) => p.status === "trial").map((p) => ({ name: p.name, hook: p.hook, expect: p.expect })));
  return 0;
};

// plant-sum: each plant's run (CB_PLANT_DIR/<name>/checks.json or hand-results.json): the checks that failed,
// and whether one of the expected ones did (20 (f))
export const mode_plant_sum = async (): Promise<number> => {
  const dir = envOf("CB_PLANT_DIR", "research/out/chartbest/plants");
  const period = envOf("CB_PERIOD", "main");
  const checks = new Checks();
  Log.mode("plant-sum", `dir=${dir}`);
  const out: Record<string, unknown> = {};
  for (const p of PLANTS.filter((x) => x.status === "trial")) {
    let failed: string[] = [];
    let found = false;
    for (const f of ["checks.json", "hand-results.json", "py-hand.json"]) {
      const path = `${dir}/${p.name}/${f}`;
      if (!(await exists(path))) continue;
      const j = JSON.parse(await Deno.readTextFile(path)) as { failed?: string[]; cases?: Record<string, { ok: boolean }>; period?: string; plant?: string };
      // a file counts only when it is that plant's run (the Python's twin writes py-hand.json without the field)
      if (f !== "py-hand.json" && j.plant !== p.name) continue;
      found = true;
      if (f === "checks.json" && p.hook === "run" && (j.period ?? period) === "mini" && envOf("CB_PLANT_MINI_OK") !== "1") throw new Refused(`plant ${p.name}: a run-hook plant's run must be the main period, not mini`);
      if (j.failed) failed = failed.concat(j.failed);
      if (j.cases) failed = failed.concat(Object.entries(j.cases).filter(([, c]) => !c.ok).map(([k]) => `hand.${k}`));
    }
    const caught = p.expect.some((e) => failed.some((f) => f === e || f.startsWith(`${e}.`)));
    out[p.name] = { found, failed: [...new Set(failed)].sort(), expect: p.expect, caught };
    checks.count(`plant.${p.name}`, found && caught ? 0 : 1, 1, found ? (caught ? undefined : "書いた確かめでは見つからなかった") : "no run found");
  }
  await Deno.writeTextFile(`${dir}/plant-sum.json`, JSON.stringify(out, null, 1) + "\n");
  return checks.ok() ? 0 : 1;
};

export const plantInfo = plantDef;

// the real stages' gates alone (plan §5.4), the first step of each real job in the yml, before any step that reads a
// real price: exit 0 when every gate passes, 2 when refused (in step 2 they never pass: 55 of the 59 items are not built)
export const mode_guard = async (): Promise<number> => {
  const stage = envOf("CB_STAGE");
  Log.mode("guard", `stage=${stage || "-"}`);
  if (!["stage0", "stage1", "stage2"].includes(stage)) throw new Refused(`CB_STAGE ${stage}: stage0, stage1 or stage2`);
  if (envOf("CB_DATA") !== "real") throw new Refused("the guard is for CB_DATA=real");
  await realGuard(stage);
  Log.ok("gate.real", 1);
  return 0;
};


// ---- 20 (e): the sets ---------------------------------------------------------------------------------------------

// flip-cmp: an original run's dumps (CB_ORIG) against its flipped run's (CB_FLIPPED), with the original's day files
// (CB_ORIG_DATA) for SQ-02's exact-touch exceptions
export const mode_flip_cmp = async (): Promise<number> => {
  const orig = envOf("CB_ORIG");
  const flip = envOf("CB_FLIPPED");
  const data = envOf("CB_ORIG_DATA");
  const flipData = envOf("CB_FLIPPED_DATA");
  const out = envOf("CB_OUT", `${flip}/..`);
  if (!orig || !flip || !data || !flipData) throw new Refused("flip-cmp needs CB_ORIG, CB_FLIPPED (the runs' ts/ folders), CB_ORIG_DATA and CB_FLIPPED_DATA (their day files)");
  const period = periodOf(envOf("CB_PERIOD", "main"));
  Log.mode("flip-cmp", `period=${period.name}`);
  const rb = await loadRun({ dir: data, real: false }, period, true, false, false);
  const rf = await loadRun({ dir: flipData, real: false }, period, true, false, false);
  const symmetricDefs = itemsOf(false).filter((d) => d.symmetric);
  const r = await flipCompare(orig, flip, rb.bars, rf.bars, symmetricDefs);
  const checks = new Checks();
  // the blind table: every compared row equal outside SQ-02's two exceptions; both halves dumped; some rows compared
  // exactly (a run of exceptions only, or no dump at all, is not a pass)
  const blindBad = r.blind.differ + r.blind.missing.length + (r.blind.exact === 0 ? 1 : 0);
  checks.count("flip.blind", blindBad, r.blind.compared, blindBad ? { differ: r.blind.differ, missing: r.blind.missing, exact: r.blind.exact, examples: r.blind.examples } : undefined);
  // the symmetric items: one to one and reversed, at most 0.1% differing (20 (e) 裏返し); an item with no signal compared fails
  for (const d of symmetricDefs) {
    const x = r.items[d.id] ?? { compared: 0, differ: 0, tieExcepted: 0, onsets: 0, tieOnsets: 0, share: 0, examples: [] };
    const bad = x.compared === 0 ? 1 : x.share > 0.001 ? x.differ : 0;
    checks.count(`flip.item.${d.id}`, bad, x.compared, x.compared === 0 ? (r.signalsMissing ? "no signals dump" : "no signal compared") : bad ? { differ: x.differ, examples: x.examples } : undefined);
    // 20 (e): the count of the examples on the line (SQ-37's tie stretches), printed
    Log.madeup(`flip.item.${d.id}.tieExcepted`, x.tieExcepted);
    Log.madeup(`flip.item.${d.id}.onsets`, `${x.tieOnsets}/${x.onsets}`);
  }
  Log.madeup("flip.exact", r.blind.exact);
  Log.madeup("flip.halfTickE", r.blind.halfTickE);
  Log.madeup("flip.exactTouch", r.blind.exactTouch);
  const notSym = itemsOf(false).filter((d) => !d.symmetric).map((d) => ({ id: d.id, why: d.symmetricWhy }));
  await Deno.mkdir(out, { recursive: true });
  await Deno.writeTextFile(`${out}/flip-cmp.json`, JSON.stringify({ ...r, notSymmetric: notSym }, null, 1) + "\n");
  await Deno.writeTextFile(`${out}/checks.json`, checks.json({ mode: "flip-cmp" }));
  return checks.ok() ? 0 : 1;
};

// calib: the trial seeds (901–920) of one set at CB_AMOUNT: the targets' values (no judgment; docs takes the amount)
export const mode_calib = async (): Promise<number> => {
  const set = envOf("CB_SET");
  const dir = envOf("CB_SETS_DIR", "research/out/chartbest/calib");
  Log.mode("calib", `set=${set}`);
  const { runs, missing } = await readSums(dir, set, SETS.TRIAL);
  const t = calibTargets(set, runs);
  Log.madeup(`calib.${set}.runs`, runs.length);
  Log.madeup(`calib.${set}.missing`, missing.length);
  for (const [k, v] of Object.entries(t)) Log.madeup(`calib.${set}.${k}`, v === null ? "none" : v.toFixed(6));
  await Deno.writeTextFile(`${dir}/calib-${set}.json`, JSON.stringify({ set, amount: envOf("CB_AMOUNT"), runs: runs.length, missing, targets: t }, null, 1) + "\n");
  return 0;
};

// sets-sum: 20 (e)'s pass conditions over every formal seed's summary.json (CB_SETS_DIR/<set>-<seed>/), and the
// flip (CB_SETS_DIR/flip-<seed>/checks.json); writes sets-pass.json and n-summary.json (the projections' g).
// CB_SETS_ONLY=O,flip judges only the named sets (the push jobs' answer and flip): it writes sets-part.json, never
// sets-pass.json, so a part can never stand for the whole that the real stages' gate reads.
export const mode_sets_sum = async (): Promise<number> => {
  const dir = envOf("CB_SETS_DIR", "research/out/chartbest/sets");
  const onlyText = envOf("CB_SETS_ONLY");
  const only = onlyText ? onlyText.split(",").map((x) => x.trim()).filter(Boolean) : null;
  const known = ["N", "D", "H", "E", "E3", "Q", "O", "flip"];
  const unknown = (only ?? []).filter((x) => !known.includes(x));
  if (unknown.length) throw new Refused(`CB_SETS_ONLY: ${unknown.join(", ")} not a set (${known.join(", ")})`);
  const want = (set: string) => only === null || only.includes(set);
  Log.mode("sets-sum", only ? `only=${only.join(",")}` : "");
  const checks = new Checks();
  const conds: Record<string, unknown> = {};
  const put = (name: string, c: { ok: boolean; value: unknown; need: string }) => {
    conds[name] = c;
    checks.set(name, { ok: c.ok, n: c.ok ? 1 : 1, detail: c.ok ? undefined : c.need });
  };
  const missingAll: Record<string, number[]> = {};
  const read = async (set: string) => {
    const r = await readSums(dir, set, SETS[set]);
    missingAll[set] = r.missing;
    // a run that crashed or whose checks failed is not a pass of its set
    const bad = r.runs.filter((x) => !x.checksOk && set !== "O").map((x) => x.seed);
    put(`set.${set}.runs`, { ok: r.missing.length === 0 && bad.length === 0, value: { runs: r.runs.length, missing: r.missing, checksFailed: bad }, need: `all ${SETS[set].length} seeds ran with every check passed` });
    return r.runs;
  };
  const n = want("N") ? await read("N") : null;
  if (n) for (const [k, c] of Object.entries(condN(n))) put(k, c);
  if (want("D")) for (const [k, c] of Object.entries(condD(await read("D")))) put(k, c);
  if (want("H")) for (const [k, c] of Object.entries(condH(await read("H")))) put(k, c);
  if (want("E")) put("set.E", condE(await read("E")));
  if (want("E3")) {
    const e3 = await read("E3");
    conds["set.E3.counts"] = { confirmedA20: e3.filter((r) => r.confirmed.includes("donchian-A20")).length };
  }
  if (want("Q")) put("set.Q", condQ(await read("Q")));
  if (want("O")) put("set.O", condO(await read("O")));
  // the flip: every seed's flip-cmp passed
  if (want("flip")) {
    let flipBad = 0;
    for (const seed of SETS.FLIP) {
      try {
        const c = JSON.parse(await Deno.readTextFile(`${dir}/flip-${seed}/checks.json`)) as { failed: string[] };
        if (c.failed.length) flipBad++;
      } catch {
        flipBad++;
      }
    }
    put("set.flip", { ok: flipBad === 0, value: flipBad, need: "flip-cmp passed on seeds 101–105" });
  }
  const ok = checks.ok();
  await Deno.writeTextFile(`${dir}/${only ? "sets-part.json" : "sets-pass.json"}`, JSON.stringify({ ok, only, conditions: conds, missing: missingAll }, null, 1) + "\n");
  if (n) await Deno.writeTextFile(`${dir}/n-summary.json`, JSON.stringify(nSummaryOf(n), null, 1) + "\n");
  await Deno.writeTextFile(`${dir}/checks.json`, checks.json({ mode: "sets-sum", only }));
  return ok ? 0 : 1;
};
