// 法則探し (docs §8.136, research/lawsearch-spec.md): the program, builder D (research/lawsearch-design.md 7.7).
//
// MODE (environment):
//   hand        the hand examples (lawsearch-hand.ts), one line per example; exit 4 when a required one fails
//   syn         writeRun(OUT, genSpecOf(GEN, SEED, FLIP, STRENGTH)), then the pipeline on OUT (dumps in OUT/ts)
//   walkfiles   the pipeline on an existing run folder RUN (read only); the dumps go to OUT (default RUN/ts; a plant
//               run RUN/plant-<name>)
//   stage0, stage1, calib, stage2, stage3, h1spread, print
//               refused (exit 2, before any read) while the small trial has not passed (TRIAL_PASSED_SHA256 null)
// Other variables: TRIALS (comma-separated ids; default the trial's twelve), LS_PLANT, KAPPA_DELTA, KAPPA_PL (default
// 1: not calibrated, step 7), G_FILE (JSON {trial: g}), HAND_IDS, CUT_MAX (development only: caps the cut's targets
// per pair; never in CI or a formal run).
//
// Exit codes (design 2.3): 0 every check passed; 2 refused by a gate; 3 a spec 2 / 15 check failed or a STOP was
// raised (the run goes on through the stages it can and writes its dumps first); 4 a required hand example failed;
// 1 any other error. No mode reads research/.cache and none fetches (no --allow-net).
//
// The one-process pipeline (design 7.7): config.json; stage 0 (load [S0, END), runStage0); stage 1 (load [S0, SPLIT),
// h1Only, signals again, stage 1 = stage 0 on the first half, the first-half blind and late tables, trial rows,
// measures of the floor-passing trials that are not same trials, the blind rows, suspicion and 13's checks, the
// follow-bar checks, rules 1–6 and the choice; choice.json); stage 2 (load [S0, END), the second-half tables, the
// chosen trials only, κ, Holm, C1–C7, verdicts); then checks.csv, suspect.csv and print.txt.

import { END, N_BARS, PAIRS, S0, SPLIT, SPREAD_H1_SHA256 } from "./lawsearch-const.ts";
import { DIRECTIONAL_F, PLANTS, POISON_1000, QUESTIONS, S_OF_F, SEEDS, TRIAL_STEP3, W0 } from "./lawsearch-rules.ts";
import { loadUniverse } from "./lawsearch-bars.ts";
import { GEN_VERSION, genSpecOf, treeSha256, writeRun } from "./lawsearch-gen.ts";
import { parseCandidates, trialBuilt } from "./lawsearch-items.ts";
import { avoidOf, blindBarsOf, trialSignals } from "./lawsearch-events.ts";
import { blindTable, followBarChecks, lateTable, lateWhyOf, trialRows } from "./lawsearch-trade.ts";
import { measureBlindRows, measureTrial, withKappa } from "./lawsearch-stats.ts";
import { chooseStage1, skipText, stage1Explain, stage2Rows, suspectOf } from "./lawsearch-select.ts";
import type { Stage2In } from "./lawsearch-select.ts";
import { checkRulesFiles, ctxOfUniverse, cutCheck, cutTargets, dataCheck, h1OnlyCheck, poisonCheck, presenceCheck, printCheck, retraceCheck, sameFirstHalfCheck, sampleOf } from "./lawsearch-checks.ts";
import { indsOf, runStage0 } from "./lawsearch-stage0.ts";
import type { Stage0Out } from "./lawsearch-stage0.ts";
import { checksRows, dumpBlind, dumpChecks, dumpConfig, dumpLoad, dumpMeasures, dumpStage1, dumpStage2, dumpSuspect, dumpTrades } from "./lawsearch-dump.ts";
import { handLines, runHand } from "./lawsearch-hand.ts";
import type { BlindTable, CheckResult, GenManifest, RunConfig, Stage0Row, Stage1Cand, SuspectRow, TfKey, TrialDef, TrialMeasures, TrialRows, TrialSignals, Universe } from "./lawsearch-types.ts";

// the lead sets this after the small trial has passed (spec 19 step 3); every real-data mode refuses until then
export const TRIAL_PASSED_SHA256: string | null = null;

const REAL_MODES = ["stage0", "stage1", "calib", "stage2", "stage3", "h1spread", "print"];

class Refused extends Error {}
export const refuse = (what: string): never => {
  throw new Refused("REFUSED: " + what);
};
const isRefused = (e: unknown) => e instanceof Refused || (e instanceof Error && e.message.startsWith("REFUSED: "));
const isStop = (e: unknown) => e instanceof Error && e.message.startsWith("STOP: ");

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

// ---- the stage checks, kept with their stage ------------------------------------------------------------------

type StageTag = "gate" | "stage0" | "stage1" | "stage2" | "end";
interface Tagged {
  stage: StageTag;
  r: CheckResult;
}
const failedOf = (cs: Tagged[]) => cs.filter((c) => !c.r.passed);

// rule 2 of spec 10: every "*" row and every row of the trial passed (checks.csv, as the Python reads it)
const checksOkOf = (cs: Tagged[]) => {
  const rows = checksRows(cs.map((c) => c.r));
  const allOk = rows.filter((r) => r[0] === "*").every((r) => r[2] === "1");
  const bad = new Set(rows.filter((r) => r[0] !== "*" && r[2] !== "1").map((r) => r[0]));
  return (id: string) => allOk && !bad.has(id);
};

// ---- environment ------------------------------------------------------------------------------------------------

const env = (k: string): string | undefined => {
  const v = Deno.env.get(k);
  return v === undefined || v === "" ? undefined : v;
};
const numEnv = (k: string, def: number): number => {
  const v = env(k);
  if (v === undefined) return def;
  const x = Number(v);
  if (!Number.isFinite(x) || !(x > 0)) refuse(`${k} ${JSON.stringify(v)} is not a positive number`);
  return x;
};

// ---- the pipeline -----------------------------------------------------------------------------------------------

interface RunCtx {
  mode: "syn" | "walkfiles";
  run: string;
  out: string;
  trials: TrialDef[];
  all: TrialDef[];
  plant: string;
  manifest: GenManifest;
  cfg: RunConfig;
  cutMax?: number;
  times: Record<string, number>;
}

const setOf = (u: Universe, tf: TfKey) => (tf === "m15" ? u.m15 : u.h1);
const blindId = (id: string) => id.startsWith("blind.");

// Stage 1 / 2's 13 checks (i)–(iv) of a hit trial on the stage's universe; (v) is another agent's hand trace (not run
// on synthetic runs, so a hit row is not selectable: 11 O-5)
async function suspicionChecks(c: RunCtx, u: Universe, trial: TrialDef, sig: TrialSignals, table: BlindTable, tr: TrialRows, avoid: ReadonlySet<string>, answerKnowing: boolean, tagged: Tagged[], stage: StageTag): Promise<SuspectRow["checks"] & { passed: boolean }> {
  const targets = (() => {
    const out: Array<{ tf: TfKey; pi: number; k: number; kinds: string[] }> = [];
    const seen = new Set<string>();
    for (const p of sig.pairs) {
      for (let r = 0; r < p.n; r++) {
        const key = `${p.pi}:${p.i[r]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tf: trial.tf, pi: p.pi, k: p.i[r], kinds: ["signal13"] });
      }
    }
    return out.sort((a, b) => a.pi - b.pi || a.k - b.k);
  })();
  const o = { answerKnowing, plant: c.plant };
  const cut = cutCheck(u, [trial], [sig], targets, avoid, { ...o, maxTargets: c.cutMax });
  const poison = poisonCheck(u, [trial], [sig], avoid, { ...o, n: POISON_1000, seed: SEEDS.poison1000 });
  const presence = presenceCheck(u, [trial], [sig], avoid, { ...o, seed: SEEDS.poison1000, n: POISON_1000 });
  const picks = sampleOf(Array.from(tr.rows), 6, SEEDS.poison1000);
  const retrace = await retraceCheck(c.run, picks.map((r) => ({ pair: PAIRS[table.pi[r]], tf: trial.tf, T: table.T[r], d: table.d[r] as 1 | -1, pl: table.pl[r], m: table.m[r] })));
  for (const [name, r] of [["suspect13.cut", cut], ["suspect13.poison1000", poison], ["suspect13.presence", presence], ["suspect13.retrace", retrace]] as const) {
    tagged.push({ stage, r: { ...r, name: `${name}.${stage}`, probes: r.probes.map((p) => ({ ...p, name: p.name === "retrace" ? trial.id : p.name })) } });
  }
  return { cut: cut.passed, poison1000: poison.passed, presence: presence.passed, retrace: retrace.passed, hand: "not-run", passed: false };
}

const sTrialOf = (all: TrialDef[], tf: TfKey, f: string): TrialDef | null => {
  const s = Object.entries(S_OF_F).find(([, ff]) => ff === f)?.[0];
  return s ? all.find((t) => t.tf === tf && t.kind === "S" && t.s === s) ?? null : null;
};

async function pipeline(c: RunCtx): Promise<number> {
  const tagged: Tagged[] = [];
  const t0 = Date.now();
  const dir = c.out;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  await dumpConfig(dir, c.cfg);
  const src = { dir: `${c.run}/gmo`, fetch: false };
  const answerKnowing = c.manifest.spec.group === "O";
  const print: Array<[string, string]> = [];
  const put = (k: string, v: string | number) => print.push([k, String(v).replace(/[\r\n]+/g, " ")]);
  put("run", c.run);
  put("mode", c.mode);
  put("group", c.manifest.spec.group);
  put("seed", c.manifest.spec.seed);
  put("flip", c.manifest.spec.flip ? 1 : 0);
  put("plant", c.plant);
  put("trials", c.trials.map((t) => t.id).join("|"));
  put("kappa.delta", c.cfg.kappaDelta);
  put("kappa.pl", c.cfg.kappaPl);
  put("kappa.from", c.cfg.kappaFrom);
  put("g.from", c.cfg.gFrom);
  if (c.times.gen !== undefined) put("time.gen.ms", c.times.gen);

  // gate 4: the avoid table actually read (plant avoidFull: the table with the second half) against its sha256
  const avoidPath = c.plant === "avoidFull" ? "research/ledger/spread-hours.csv" : "research/ledger/spread-hours-h1.csv";
  const avoidBytes = await Deno.readFile(avoidPath);
  const avoidSha = await sha256(avoidBytes);
  const avoidOk = avoidSha === SPREAD_H1_SHA256;
  tagged.push({ stage: "gate", r: { name: "avoid", passed: avoidOk, detail: `${avoidPath}: sha256 ${avoidSha}${avoidOk ? "" : `, not ${SPREAD_H1_SHA256}`}`, probes: [] } });
  let stopped = !avoidOk;
  let code = 0;
  const finish = async (): Promise<number> => {
    put("time.total.ms", Date.now() - t0);
    for (const t of tagged) {
      const key = t.r.name.replace(/[^A-Za-z0-9_.]/g, "_");
      put(`check.${key}.passed`, t.r.passed ? 1 : 0);
      put(`check.${key}.detail`, t.r.detail.slice(0, 400));
    }
    for (const st of ["stage0", "stage1", "stage2"] as const) if (tagged.some((t) => t.stage === st && !t.r.passed)) put(`withheld.${st}`, 1);
    if (code === 0 && failedOf(tagged).length > 0) code = 3;
    put("exit", code);
    const pc = printCheck(print.map(([k]) => k));
    tagged.push({ stage: "end", r: pc });
    await dumpChecks(dir, tagged.map((t) => t.r));
    if (pc.passed) await Deno.writeTextFile(`${dir}/print.txt`, print.map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    else code = 3;
    console.log(`exit ${pc.passed ? code : 3}: ${failedOf(tagged).map((t) => t.r.name).join(", ") || "every check passed"}`);
    return pc.passed ? code : 3;
  };
  if (stopped) return await finish();
  const avoid = avoidOf(new TextDecoder().decode(avoidBytes));
  const withheld = (st: StageTag) => tagged.some((t) => t.stage === st && !t.r.passed);

  const say = (what: string) => console.error(`[lawsearch ${new Date().toISOString()}] ${what}`);
  // ---- stage 0
  say("stage 0");
  let s0: Stage0Out;
  try {
    const ts = Date.now();
    const u0 = await loadUniverse(src, S0, END, { purpose: "syn0", band: "syn", plant: c.plant });
    s0 = await runStage0(u0, c.trials, c.cfg, avoid, { answerKnowing, plant: c.plant, dumpDir: dir, cutMaxTargets: c.cutMax });
    for (const r of s0.checks) tagged.push({ stage: "stage0", r });
    for (const [k, v] of Object.entries(s0.times)) if (k !== "stage0") put(`time.${k}.ms`, v);
    put("time.stage0.ms", Date.now() - ts);
    if (!withheld("stage0")) {
      for (const r of s0.rows) {
        put(`count.stage0.${r.trial}.first`, r.first.counted);
        put(`count.stage0.${r.trial}.second`, r.second.counted);
        if (r.sameAs) put(`same.${r.trial}`, r.sameAs);
      }
      for (const tf of ["m15", "h1"] as const) {
        put(`floor.${tf}`, s0.rows.filter((r) => r.tf === tf && r.floor).length);
        put(`groups.${tf}`, new Set(s0.rows.filter((r) => r.tf === tf && r.group !== "").map((r) => r.group)).size);
      }
    }
  } catch (e) {
    if (!isStop(e)) throw e;
    tagged.push({ stage: "stage0", r: { name: "stop.stage0", passed: false, detail: (e as Error).message, probes: [] } });
    return await finish();
  }
  const row0 = new Map<string, Stage0Row>(s0.rows.map((r) => [r.trial, r]));

  // ---- stage 1
  say("stage 1");
  let chosen: Record<TfKey, string[]> = { m15: [], h1: [] };
  let K = 0;
  try {
    const ts = Date.now();
    const u1 = await loadUniverse(src, S0, SPLIT, { purpose: "syn1", band: "syn", plant: c.plant });
    await dumpLoad(dir, u1, "syn1");
    tagged.push({ stage: "stage1", r: dataCheck(u1) });
    tagged.push({ stage: "stage1", r: h1OnlyCheck(u1) });
    const ctx1 = ctxOfUniverse(u1, avoid, c.plant);
    const inds1 = { m15: indsOf(u1.m15, c.plant), h1: indsOf(u1.h1, c.plant) };
    const sigOf1 = new Map<string, TrialSignals>();
    const sig1 = (t: TrialDef) => {
      let s = sigOf1.get(t.id);
      if (!s) sigOf1.set(t.id, (s = trialSignals(t, setOf(u1, t.tf), inds1[t.tf], ctx1[t.tf], { plant: c.plant, answerKnowing })));
      return s;
    };
    const sigs1 = c.trials.map(sig1);
    tagged.push({ stage: "stage1", r: sameFirstHalfCheck(s0.sigs, sigs1) });
    const tables: Record<TfKey, { t: BlindTable; late: BlindTable }> = {} as Record<TfKey, { t: BlindTable; late: BlindTable }>;
    for (const tf of ["m15", "h1"] as const) {
      const t = blindTable(setOf(u1, tf), "first", blindBarsOf(ctx1[tf], setOf(u1, tf), "first"), c.plant);
      const late = lateTable(t, u1.m15, SPLIT, c.plant);
      tables[tf] = { t, late };
      await dumpBlind(dir, t);
      await dumpBlind(dir, late);
      tagged.push({ stage: "stage1", r: followBarChecks(setOf(u1, tf), t) });
    }
    const trOf = new Map<string, TrialRows>();
    const rowsOf = (t: TrialDef) => {
      let r = trOf.get(t.id);
      if (!r) {
        const tb = tables[t.tf];
        trOf.set(t.id, (r = trialRows(tb.t, tb.late, sig1(t), "first", setOf(u1, t.tf).pairs, c.plant)));
      }
      return r;
    };
    const measured = c.trials.filter((t) => row0.get(t.id)!.floor && row0.get(t.id)!.sameAs === null);
    const ms: TrialMeasures[] = [];
    for (const t of measured) {
      const tr = rowsOf(t);
      let dF: { rows: Int32Array; against: string } | null = null;
      if (t.kind === "EF" && t.f !== null && DIRECTIONAL_F.includes(t.f)) {
        const sT = sTrialOf(c.all, t.tf, t.f);
        if (sT && trialBuilt(sT)) dF = { rows: rowsOf(sT).rows, against: sT.id };
      }
      ms.push(measureTrial(tables[t.tf].t, tables[t.tf].late, tr, { w0: W0.first, plant: c.plant, dF }));
      await dumpTrades(dir, tables[t.tf].t, tables[t.tf].late, tr, lateWhyOf(tables[t.tf].late)?.why ?? null);
    }
    const blind = [...measureBlindRows(tables.m15.t, tables.m15.late, W0.first), ...measureBlindRows(tables.h1.t, tables.h1.late, W0.first)];
    await dumpMeasures(dir, "stage1", [...ms, ...blind]);
    // spec 13
    const sus: SuspectRow[] = [];
    for (const m of [...ms, ...blind]) {
      const s = suspectOf(m);
      let checks: SuspectRow["checks"] = { cut: null, poison1000: null, presence: null, retrace: null, hand: "not-run" };
      let checksPassed: boolean | null = null;
      if (s.hit && !blindId(m.trial)) {
        const t = c.trials.find((x) => x.id === m.trial)!;
        const r = await suspicionChecks(c, u1, t, sig1(t), tables[t.tf].t, rowsOf(t), avoid, answerKnowing, tagged, "stage1");
        checks = { cut: r.cut, poison1000: r.poison1000, presence: r.presence, retrace: r.retrace, hand: r.hand };
        checksPassed = r.passed;
      }
      if (s.hit && blindId(m.trial)) tagged.push({ stage: "stage1", r: { name: "suspect.blind.stage1", passed: false, detail: `the blind row ${m.trial} hits spec 13's lines (spec 13: stop and look)`, probes: [] } });
      sus.push({ ...s, checks, checksPassed });
    }
    await dumpSuspect(dir, sus);
    // spec 10
    const ok = checksOkOf(tagged);
    const susOf = new Map(sus.map((s) => [s.id, s]));
    const cands: Stage1Cand[] = ms.map((m) => {
      const t = c.trials.find((x) => x.id === m.trial)!;
      const r0 = row0.get(t.id)!;
      const f = t.kind === "B" || t.f === "F00" ? null : t.f;
      const s = susOf.get(t.id)!;
      return {
        id: t.id, tf: t.tf, order: t.order, f, isS: t.kind === "S", directionalF: f !== null && DIRECTIONAL_F.includes(f), passFloor: r0.floor, same: r0.sameAs !== null,
        checksOk: ok(t.id), hasT: m.delta.hasT, delta: m.delta.value, lb: m.delta.lb, pl: m.pl.value, plEx1w: m.extras.plEx1w, dF: m.dF ? m.dF.value : null,
        suspicious: s.hit, suspiciousChecksPassed: s.hit ? s.checksPassed : null, n: m.counted, group: r0.group,
      };
    });
    const out = chooseStage1(cands, QUESTIONS.q4, c.plant);
    const pIut = new Map(ms.map((m) => [m.trial, Math.max(m.delta.p, m.pl.p)]));
    const explain = stage1Explain(cands, pIut);
    await dumpStage1(dir, cands, out, explain, pIut, skipText);
    chosen = out.chosen;
    K = out.K_total;
    const choice = JSON.stringify({ m15: chosen.m15, h1: chosen.h1 });
    await Deno.writeTextFile(`${dir}/choice.json`, choice + "\n");
    console.log(`choice.json sha256 ${await sha256(enc.encode(choice + "\n"))}`);
    put("time.stage1.ms", Date.now() - ts);
    if (!withheld("stage1")) {
      put("chosen.m15", chosen.m15.join("|"));
      put("chosen.h1", chosen.h1.join("|"));
      put("K_total", K);
    }
  } catch (e) {
    if (!isStop(e)) throw e;
    tagged.push({ stage: "stage1", r: { name: "stop.stage1", passed: false, detail: (e as Error).message, probes: [] } });
    return await finish();
  }

  // ---- stage 2 (spec 11): the chosen trials only; no chosen trial → the second half is not opened. The plant
  // secondHalfAll (spec 16: the second half of trials not chosen is computed) asks for it whatever K is, so that the
  // stage-2 gate meets it even when nothing was chosen.
  if (K === 0 && c.plant !== "secondHalfAll") {
    put("note.stage2", "no trial was chosen: the second half is not opened (spec 10)");
    return await finish();
  }
  say("stage 2");
  try {
    const ts = Date.now();
    const u2 = await loadUniverse(src, S0, END, { purpose: "syn2", band: "syn", plant: c.plant });
    await dumpLoad(dir, u2, "syn2");
    tagged.push({ stage: "stage2", r: dataCheck(u2) });
    const ctx2 = ctxOfUniverse(u2, avoid, c.plant);
    const inds2 = { m15: indsOf(u2.m15, c.plant), h1: indsOf(u2.h1, c.plant) };
    const isChosen = (id: string) => chosen.m15.includes(id) || chosen.h1.includes(id);
    const tables: Record<TfKey, { t: BlindTable; late: BlindTable }> = {} as Record<TfKey, { t: BlindTable; late: BlindTable }>;
    for (const tf of ["m15", "h1"] as const) {
      const t = blindTable(setOf(u2, tf), "second", blindBarsOf(ctx2[tf], setOf(u2, tf), "second"), c.plant);
      const late = lateTable(t, u2.m15, END, c.plant);
      tables[tf] = { t, late };
      await dumpBlind(dir, t);
      await dumpBlind(dir, late);
      tagged.push({ stage: "stage2", r: followBarChecks(setOf(u2, tf), t) });
    }
    const sigOf2 = new Map<string, TrialSignals>();
    const sig2 = (t: TrialDef) => {
      let s = sigOf2.get(t.id);
      if (!s) sigOf2.set(t.id, (s = trialSignals(t, setOf(u2, t.tf), inds2[t.tf], ctx2[t.tf], { plant: c.plant, answerKnowing })));
      return s;
    };
    const trOf = new Map<string, TrialRows>();
    const rowsOf = (t: TrialDef) => {
      let r = trOf.get(t.id);
      if (!r) {
        const tb = tables[t.tf];
        trOf.set(t.id, (r = trialRows(tb.t, tb.late, sig2(t), "second", setOf(u2, t.tf).pairs, c.plant)));
      }
      return r;
    };
    // spec 10 記録 / 20: the program refuses the second half of a trial that was not chosen
    const measure2 = (t: TrialDef): TrialMeasures => {
      if (!isChosen(t.id)) refuse(`stage 2 of a trial not chosen (${t.id})`);
      let dF: { rows: Int32Array; against: string } | null = null;
      if (t.kind === "EF" && t.f !== null && DIRECTIONAL_F.includes(t.f)) {
        const sT = sTrialOf(c.all, t.tf, t.f);
        if (sT && trialBuilt(sT)) dF = { rows: rowsOf(sT).rows, against: sT.id };
      }
      return measureTrial(tables[t.tf].t, tables[t.tf].late, rowsOf(t), { w0: W0.second, plant: c.plant, dF });
    };
    const asked = c.plant === "secondHalfAll" ? c.trials : c.trials.filter((t) => isChosen(t.id));
    const ms = asked.map(measure2);
    for (const t of asked) await dumpTrades(dir, tables[t.tf].t, tables[t.tf].late, rowsOf(t), lateWhyOf(tables[t.tf].late)?.why ?? null);
    const blind = [...measureBlindRows(tables.m15.t, tables.m15.late, W0.second), ...measureBlindRows(tables.h1.t, tables.h1.late, W0.second)];
    const msK = ms.map((m) => ({ ...m, delta: withKappa(m.delta, c.cfg.kappaDelta), pl: withKappa(m.pl, c.cfg.kappaPl) }));
    await dumpMeasures(dir, "stage2", [...msK, ...blind]);
    const sus: SuspectRow[] = [];
    for (const m of [...ms, ...blind]) {
      const s = suspectOf(m);
      let checks: SuspectRow["checks"] = { cut: null, poison1000: null, presence: null, retrace: null, hand: "not-run" };
      let checksPassed: boolean | null = null;
      if (s.hit && !blindId(m.trial)) {
        const t = c.trials.find((x) => x.id === m.trial)!;
        const r = await suspicionChecks(c, u2, t, sig2(t), tables[t.tf].t, rowsOf(t), avoid, answerKnowing, tagged, "stage2");
        checks = { cut: r.cut, poison1000: r.poison1000, presence: r.presence, retrace: r.retrace, hand: r.hand };
        checksPassed = r.passed;
      }
      if (s.hit && blindId(m.trial)) tagged.push({ stage: "stage2", r: { name: "suspect.blind.stage2", passed: false, detail: `the blind row ${m.trial} hits spec 13's lines (spec 13: stop and look)`, probes: [] } });
      sus.push({ ...s, checks, checksPassed });
    }
    await dumpSuspect(dir, sus);
    const susOf = new Map(sus.map((s) => [s.id, s]));
    const cands: Stage2In[] = msK.map((m) => {
      const t = c.trials.find((x) => x.id === m.trial)!;
      const s = susOf.get(t.id)!;
      return {
        id: t.id, tf: t.tf, order: t.order, n: m.counted, weeks: m.weeks, pDelta: m.delta.p, pPl: m.pl.p, tDelta: m.delta.t, tPl: m.pl.t,
        deltaByDir: m.deltaByDir, countedByDir: m.countedByDir, deltaByPair: m.deltaByPair, countedByPair: m.countedByPair,
        lateLb: m.deltaLate.lb, plLate: m.plLate, suspicious: s.hit, suspiciousChecksPassed: s.hit ? s.checksPassed : null, c6: m.c6, plEx1w: m.extras.plEx1w,
        deltaUb: m.delta.ub, deltaLate: m.deltaLate.value, deltaEst: m.delta, dF: m.dF,
      };
    }).sort((a, b) => a.order - b.order);
    const rows = stage2Rows(cands, K, QUESTIONS.q2, QUESTIONS.q4, c.plant);
    await dumpStage2(dir, cands, rows, { delta: c.cfg.kappaDelta, pl: c.cfg.kappaPl });
    put("time.stage2.ms", Date.now() - ts);
    if (!withheld("stage2")) for (const r of rows) put(`verdict.${r.id}`, `${r.verdict} ${r.label}`);
  } catch (e) {
    if (!isStop(e)) throw e;
    tagged.push({ stage: "stage2", r: { name: "stop.stage2", passed: false, detail: (e as Error).message, probes: [] } });
  }
  put("note.kappa", "not run yet: step 7");
  put("note.g", "none: step 4");
  return await finish();
}

// ---- the gates and the modes ------------------------------------------------------------------------------------

async function readManifest(run: string): Promise<GenManifest> {
  if (run.split("/").some((p) => p === ".cache")) refuse(`the run folder ${run} is under a .cache folder`);
  let m: GenManifest;
  try {
    m = JSON.parse(await Deno.readTextFile(`${run}/manifest.json`));
  } catch (e) {
    return refuse(`${run}/manifest.json: ${(e as Error).message}`);
  }
  if (m.version !== GEN_VERSION) refuse(`${run}/manifest.json: version ${JSON.stringify(m.version)}, not ${GEN_VERSION}`);
  return m;
}

async function main(): Promise<number> {
  const mode = env("MODE") ?? "";
  // real data: refused before any read
  if (REAL_MODES.includes(mode)) {
    if (TRIAL_PASSED_SHA256 === null) refuse("the small trial has not passed (TRIAL_PASSED_SHA256 is null)");
    refuse(`MODE=${mode} is not built yet`);
  }
  if (!["hand", "syn", "walkfiles"].includes(mode)) refuse(`MODE ${JSON.stringify(mode)} is not one of hand, syn, walkfiles, ${REAL_MODES.join(", ")}`);
  const plant = env("LS_PLANT") ?? "";
  if (plant && !PLANTS.includes(plant)) refuse(`LS_PLANT ${plant} is not a planted error of spec 16`);
  // gate 1: the rules files
  const rules = await checkRulesFiles();
  if (!rules.passed) refuse(`the rules files: ${rules.detail}`);
  if (mode === "hand") {
    const ids = (env("HAND_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const rs = await runHand({ plant, ids });
    for (const line of handLines(rs)) console.log(line);
    const failed = rs.filter((r) => r.status === "fail").length;
    console.log(`hand: ${rs.filter((r) => r.status === "pass").length} pass, ${failed} fail, ${rs.filter((r) => r.status === "skip").length} skip${plant ? ` (plant ${plant})` : ""}`);
    return failed > 0 ? 4 : 0;
  }
  // gate 2: the trials, every one built
  const all = parseCandidates(JSON.parse(await Deno.readTextFile("research/ledger/lawsearch-candidates.json")));
  const ids = (env("TRIALS") ?? TRIAL_STEP3.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const trials: TrialDef[] = [];
  for (const id of ids) {
    const t = all.find((x) => x.id === id);
    if (!t) refuse(`trial ${id} is not in the ledger`);
    if (!trialBuilt(t!)) refuse(`trial ${id} is not built`);
    trials.push(t!);
  }
  trials.sort((a, b) => a.order - b.order);
  // gate 3: the run folder
  const times: Record<string, number> = {};
  let run: string;
  let out: string;
  let manifest: GenManifest;
  if (mode === "syn") {
    run = env("OUT") ?? refuse("OUT is needed");
    const spec = genSpecOf({ GEN: env("GEN"), SEED: env("SEED"), FLIP: env("FLIP"), STRENGTH: env("STRENGTH") });
    const tg = Date.now();
    manifest = await writeRun(run, spec);
    times.gen = Date.now() - tg;
    out = `${run}/${plant ? `plant-${plant}` : "ts"}`;
  } else {
    run = env("RUN") ?? refuse("RUN is needed");
    manifest = await readManifest(run);
    out = env("OUT") ?? `${run}/${plant ? `plant-${plant}` : "ts"}`;
  }
  if (out.split("/").some((p) => p === ".cache" || p === "gmo")) refuse(`OUT ${out} is not a dump folder`);
  const tree = await treeSha256(`${run}/gmo`);
  if (tree.sha256 !== manifest.treeSha256 || tree.files !== manifest.files) {
    console.log(`STOP: ${run}/gmo: tree sha256 ${tree.sha256} (${tree.files} files), the manifest's ${manifest.treeSha256} (${manifest.files})`);
    return 3;
  }
  let g: Record<string, number> = {};
  let gFrom = "none: step 4";
  const gFile = env("G_FILE");
  if (gFile) {
    g = JSON.parse(await Deno.readTextFile(gFile));
    gFrom = gFile;
  }
  const kappaDelta = numEnv("KAPPA_DELTA", 1);
  const kappaPl = numEnv("KAPPA_PL", 1);
  const cfg: RunConfig = {
    mode: mode as "syn" | "walkfiles",
    run,
    trials: trials.map((t) => t.id),
    N: N_BARS,
    questions: { ...QUESTIONS },
    kappaDelta,
    kappaPl,
    kappaFrom: env("KAPPA_DELTA") || env("KAPPA_PL") ? "env" : "not calibrated: step 7",
    g,
    gFrom,
    plant,
    spreadH1Sha256: SPREAD_H1_SHA256,
  };
  const cutMaxS = env("CUT_MAX");
  return await pipeline({ mode: mode as "syn" | "walkfiles", run, out, trials, all, plant, manifest, cfg, cutMax: cutMaxS ? Number(cutMaxS) : undefined, times });
}

if (import.meta.main) {
  let code: number;
  try {
    code = await main();
  } catch (e) {
    if (isRefused(e)) {
      console.log((e as Error).message);
      code = 2;
    } else if (isStop(e)) {
      console.log((e as Error).message);
      code = 3;
    } else {
      console.error(e);
      code = 1;
    }
  }
  Deno.exit(code);
}

