// 法則探し (docs §8.136, research/lawsearch-spec.md 17.4, 付録 A): the hand runner, builder D
// (research/lawsearch-design.md 7.6). Every example of research/lawsearch-hand.json that the small trial must pass
// (HAND_REQUIRED, design 9) is fed to the study's own modules by one adapter, and each expect key is compared with the
// module's answer:
//   * points, indices, counts, booleans and texts exactly; doubles by === where spec 17.2 asks for the last digit, else
//     by the class of lawsearch-dump.md 9 (q: |Δ| ≤ 1e−9; p, ln: relative 1e−9);
//   * null equals NaN or null;
//   * a "12 significant digits" string (A.2.12, A.2.31) equals the computed double's toPrecision(12) read as a number;
//   * an explanatory sentence inside a compared object (Prose: A.2.32's shifted_signals) is not compared (listed);
//   * a key matching ALT_KEY at any depth is an alternative answer or a note: not compared;
//   * a key whose computation throws NOT BUILT (an item not written yet) is "skip"; a required key skipped or failed
//     fails the example.
// The caller has checked HAND_JSON_SHA256 (lawsearch.ts' gates). Examples given as bars write temporary GMO files under
// research/out/lawsearch/hand-tmp/<id>/gmo.

import { filterOf, isNotBuilt, itemOf, parseCandidates, sFilterOf, trialWarmup } from "./lawsearch-items.ts";
import { C6_PARTS, DIRECTIONAL_F, LATE_MS, QUESTIONS, REASONS, S_OF_F, STATUS, W0 } from "./lawsearch-rules.ts";
import { MID_DIGITS, N_BARS, PAIRS, POINTS_PER_PRICE, SPLIT, STEP, wk } from "./lawsearch-const.ts";
import { coarsenSeries, dayOf, hourOf, htfIndex, isGmoHoliday, klineNum, loadPairTf, londonSummer, midOf, nySummer, pointsOf, rawPointsOf, reportOfStop, rightFormOf, scanBody, seasonGroupOf, seriesFromMid, seriesOf, tfSetOf } from "./lawsearch-bars.ts";
import { bigmoveDefault, donchianOf, indOf, smaOldest, toF64, xDn, xUp } from "./lawsearch-ind.ts";
import { applyBoth, candidatesOf, exclCtxOf, halfOf, holesOf, r2, r3, r4, r5, r6, reasonOf } from "./lawsearch-events.ts";
import { blindFromRows, blindTable, lateTable, lateTradeOf, rowKey, tradeOf, trialRows, trialRowsExtra } from "./lawsearch-trade.ts";
import { emptyBars } from "./trend-labels.ts";
import { keysFor } from "./trend-data.ts";
import { gmoDayKey } from "./ownerhold-data.ts";
import { barInsideClosure, isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { avoidKey, hhmm, seasonOf, slotOf, SLOTS } from "./spreadhours-lib.ts";
import { DAY, HOUR, MINUTE, WEEK } from "./lib.ts";
import { chooseStage1, failRuleOf, holm, holmThreshold, skipText, stage1Explain, stage2Rows } from "./lawsearch-select.ts";
import type { Stage2In } from "./lawsearch-select.ts";
import { floorPass, gOf, mdeOf, overlapCount, overlapGroups, plEstimate, sameTrials, sigListOf, stage3Estimate } from "./lawsearch-select0.ts";
import { aOf, choose, deltaOf, estA, estDelta, estDiff, estPl, influenceOf, isZero, kappaOf, measureTrial, nGate, nGateL, nonOverlap, plExtras, plOf, point95, pOneSided, shiftMap, strataOf, tCdf, tq, withKappa, zq } from "./lawsearch-stats.ts";
import type { Bars, BigmoveParams, BlindTable, ExclCtx, HandExample, HandKeyResult, HandResult, ItemParams, Pair, SeCand, Series, ShiftRun, Stage1Cand, TfKey, TrialDef, TrialKind, ValueEst } from "./lawsearch-types.ts";

// ---- what the trial requires (lawsearch-design.md 9) ------------------------------------------------------------

const range = (g: number, n: number): string[] => Array.from({ length: n }, (_, k) => `A.${g}.${k + 1}`);
export const HAND_REQUIRED: Readonly<Record<string, "all" | readonly string[]>> = {
  ...Object.fromEntries(range(1, 36).map((id) => [id, "all" as const])),
  ...Object.fromEntries(range(2, 32).map((id) => [id, "all" as const])),
  "A.3.1": "all",
  "A.3.2": ["first_index_shown", "SMA20"],
  "A.3.5": "all",
  "A.3.6": ["TR", "ATR14"],
  "A.3.7": ["up", "dn", "U", "D", "RSI7"],
  "A.3.8": ["RSI7", "RSI14", "RSI21", "signals.E04"],
  "A.3.9": ["up", "dn", "U14", "D14", "RSI14", "RSI7", "U14_eq_D14"],
  "A.3.14": ["EMA12", "EMA26", "EMA5", "EMA35"],
  "A.3.15": ["first_index_shown", "EMA12", "EMA26"],
  "A.3.16": ["first_index_shown", "EMA12", "EMA26"],
  "A.3.17": ["EMA12", "EMA26"],
  "A.3.18": ["EMA5", "EMA20", "EMA50"],
  // the E row naming E04 (RSI14) and the F rows of F00 and F01 (row index in the example's lists)
  "A.3.19": ["E[1]", "F[0]", "F[1]"],
  "A.3.20": ["EMA5", "C_minus_EMA", "F01_buy", "F01_sell", "warmup_k", "F_value_used_signal_excluded_by_warmup_1_at"],
  "A.3.24": ["TR", "ATR14", "SMA5_ATR14"],
  "A.3.25": ["RSI14"],
  "A.3.29": "all",
  "A.3.30": ["first_index_shown", "EMA50", "EMA200", "C_minus_EMA200", "ATR14", "SMA100_ATR14", "first_value_index.EMA50", "first_value_index.EMA200", "first_value_index.SMA100_ATR14"],
  "A.3.31": ["first_index_shown", "SMA20"],
  "A.3.34": ["TR", "ATR14"],
  "A.4.1": "all",
  "A.4.2": ["HH", "LL", "target_s"],
  "A.4.3": ["TR", "ATR10", "EMA20"],
  "A.4.9": ["TR", "ATR14"],
  "A.4.10": ["TR15", "ATR14_14"],
  "A.4.26": "all",
  "A.4.27": "all",
  "A.4.41": "all",
  "A.4.29": ["U", "D", "RSI14"],
  "A.4.30": ["U", "D", "RSI14"],
  "A.4.32": "all",
  "A.4.33": "all",
  "A.4.34": "all",
  "A.4.36": "all",
  "A.4.40": "all",
};

// an alternative answer or a note (lawsearch-design.md 7.6), at any depth
export const ALT_KEY = /MISREADING|misreading|^variant_|_note$|^note$|^tolerance_rel$/;

// ---- values and comparison --------------------------------------------------------------------------------------

export type TolClass = "exact" | "q" | "p" | "ln" | "real";
// a value compared under a class (every number inside it)
export class Tol {
  constructor(readonly v: unknown, readonly cls: TolClass) {}
}
export const tol = (v: unknown, cls: TolClass): Tol => new Tol(v, cls);
// an explanatory list whose elements are compared on these sub-keys only (the rest is prose; reported to the lead)
export class PartialList {
  constructor(readonly v: unknown[], readonly keys: readonly string[]) {}
}
// a key whose computation is not part of the trial yet ("skip" with the reason)
export class Skip {
  constructor(readonly why: string) {}
}
// an explanatory sentence of the example (a prose string inside a compared object): no module makes it, so it is not
// compared (it must be a string in the example); the runner lists it as not compared
export class Prose {
  constructor(readonly what: string) {}
}
// a "12 significant digits" string of the example (Python's "%.12g"): equal when the string and the computed double's
// 12-digit rounding read as the same number (the example's text keeps or drops trailing zeros)
export class Sig12 {
  constructor(readonly x: number) {}
}
// the Prose keys met in a run (reported, not compared)
export const proseSeen: string[] = [];
export type Thunk = () => unknown | Promise<unknown>;
// e: one example of lawsearch-hand.json (HandExample, read loosely)
export type Adapter = (e: J, plant: string) => Record<string, Thunk> | Promise<Record<string, Thunk>>;

const isNum = (x: unknown): x is number => typeof x === "number";
const isNullish = (x: unknown) => x === null || x === undefined || (isNum(x) && Number.isNaN(x));
const toPlain = (x: unknown): unknown => {
  if (ArrayBuffer.isView(x) && !(x instanceof DataView)) return Array.from(x as unknown as ArrayLike<number>);
  return x;
};
const numEq = (g: number, w: number, cls: TolClass): boolean => {
  if (g === w) return true;
  if (!Number.isFinite(g) || !Number.isFinite(w)) return false;
  if (cls === "q" || cls === "real") return Math.abs(g - w) <= 1e-9;
  if (cls === "p" || cls === "ln") return Math.abs(g - w) <= 1e-9 * Math.max(Math.abs(g), Math.abs(w));
  return false;
};
const show = (x: unknown): string => {
  try {
    const s = JSON.stringify(toPlain(x instanceof Tol ? x.v : x), (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : typeof v === "number" && !Number.isFinite(v) ? String(v) : v));
    return s === undefined ? String(x) : s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return String(x);
  }
};
// the first difference of got against want (want's ALT keys skipped), or null when equal
export function diffOf(got: unknown, want: unknown, cls: TolClass = "exact", path = ""): string | null {
  if (got instanceof Tol) return diffOf(got.v, want, got.cls, path);
  if (got instanceof Prose) {
    if (typeof want !== "string") return `${path || "."}: prose expected, want ${show(want)}`;
    proseSeen.push(path || ".");
    return null;
  }
  if (got instanceof Sig12) {
    if (typeof want !== "string") return `${path || "."}: a 12-digit string expected, want ${show(want)}`;
    const g = Number.isFinite(got.x) ? Number(got.x.toPrecision(12)) : NaN;
    return g === Number(want) ? null : `${path || "."}: got ${got.x.toPrecision(12)} (${got.x}), want ${want}`;
  }
  if (got instanceof PartialList) {
    if (!Array.isArray(want) || want.length !== got.v.length) return `${path || "."}: ${got.v.length} elements, want ${Array.isArray(want) ? want.length : "a list"}`;
    for (let k = 0; k < want.length; k++) {
      for (const key of got.keys) {
        const d = diffOf((got.v[k] as Record<string, unknown>)[key], (want[k] as Record<string, unknown>)[key], cls, `${path}[${k}].${key}`);
        if (d) return d;
      }
    }
    return null;
  }
  got = toPlain(got);
  if (isNullish(want) || isNullish(got)) return isNullish(want) && isNullish(got) ? null : `${path || "."}: got ${show(got)}, want ${show(want)}`;
  if (isNum(want)) return isNum(got) && numEq(got, want, cls) ? null : `${path || "."}: got ${show(got)}, want ${show(want)} (${cls})`;
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) return `${path || "."}: got ${show(got)}, want an array`;
    if (got.length !== want.length) return `${path || "."}: length ${got.length}, want ${want.length}`;
    for (let k = 0; k < want.length; k++) {
      const d = diffOf(got[k], want[k], cls, `${path}[${k}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof want === "object") {
    if (typeof got !== "object" || Array.isArray(got)) return `${path || "."}: got ${show(got)}, want an object`;
    for (const k of Object.keys(want as object)) {
      if (ALT_KEY.test(k)) continue;
      const d = diffOf((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], cls, path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return got === want ? null : `${path || "."}: got ${show(got)}, want ${show(want)}`;
}

// expect's value at a key path ("a.b", "a[2]")
const at = (o: unknown, path: string): unknown => {
  let cur: unknown = o;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
};

// ---- small readers of the examples' records ----------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
export type J = any;
export const TF_OF: Readonly<Record<string, TfKey>> = { "15min": "m15", "1hour": "h1", m15: "m15", h1: "h1" };
export const piOf = (pair: string): number => {
  const k = (PAIRS as readonly string[]).indexOf(pair);
  if (k < 0) throw new Error(`no pair ${pair}`);
  return k;
};
export const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`bad time ${iso}`);
  return t;
};
// an example's signal list [{pair, T, d}] as a SigList
const listOf = (sigs: J[]) => sigListOf(sigs.map((s) => piOf(s.pair)), sigs.map((s) => ms(s.T)), sigs.map((s) => s.d));
// the kind and parts of an example's trial name ("E13×F00", "S01", "B06", "h1.E10×F00", "m15.E04×F05")
const partsOf = (name: string): { kind: TrialKind; e: string | null; f: string | null; b: string | null; s: string | null } => {
  const bare = name.replace(/^(m15|h1)\./, "");
  if (/^S\d\d$/.test(bare)) return { kind: "S", e: null, f: S_OF_F[bare] ?? null, b: null, s: bare };
  if (/^B\d\d$/.test(bare)) return { kind: "B", e: null, f: null, b: bare, s: null };
  const m = bare.match(/^(E\d\d)×(F\d\d[rb]?)$/);
  if (!m) throw new Error(`trial name ${name}`);
  return { kind: "EF", e: m[1], f: m[2], b: null, s: null };
};

// A.2.20 / A.2.27's stage-1 records → Stage1Cand
const stage1CandOf = (r: J, tf: TfKey): Stage1Cand => {
  const p = partsOf(r.name);
  const f = p.f === "F00" ? null : p.f;
  return {
    id: r.name,
    tf,
    order: r.table_order,
    f,
    isS: p.kind === "S",
    directionalF: f !== null && DIRECTIONAL_F.includes(f),
    passFloor: r.pass_floor,
    same: r.same_trial,
    checksOk: r.checks_ok,
    hasT: r.t_exists,
    delta: r.delta,
    lb: r.lb,
    pl: r.pl_pips,
    plEx1w: r.pl_ex1week_pips,
    dF: r.D_F,
    suspicious: r.suspicious_hit,
    suspiciousChecksPassed: r.suspicious_checks_all_passed ?? null,
    n: r.n,
    group: r.overlap_group ?? r.name,
  };
};
const tfOfName = (name: string, fallback: TfKey): TfKey => (name.startsWith("h1.") ? "h1" : name.startsWith("m15.") ? "m15" : fallback);
const q4Of = (e: J): "a" | "b" => (String(e.params.question4 ?? `(${QUESTIONS.q4})`).includes("b") ? "b" : "a");
const q2Of = (e: J): "a" | "b" => (String(e.params.question2 ?? `(${QUESTIONS.q2})`).includes("a") ? "a" : "b");
const KIND_JA: Readonly<Record<string, string>> = { week: "週", "4w": "4週", shift: "週ずらし" };

// one ValueEst with given candidates (se, df) of a value (the hand examples that give the SEs directly)
export const estOfCands = (value: number, N: number, cs: ReadonlyArray<{ kind: SeCand["kind"]; se: number; df: number }>): ValueEst => {
  const cands: SeCand[] = cs.map((c) => {
    const t = value / c.se;
    const q975 = tq(0.975, c.df);
    return { kind: c.kind, se: c.se, C: c.df + 1, df: c.df, K: null, t, p: Number.NaN, q975, halfWidth: q975 * c.se };
  });
  let useLB: SeCand["kind"] | null = null;
  let w = -Infinity;
  for (const c of cands) if ((c.halfWidth as number) > w) (w = c.halfWidth as number), (useLB = c.kind);
  return {
    value, N, C_week: 0, C_4w: 0, four: cands.some((c) => c.kind === "4w"), cands, hasT: true, useLB, useP: cands[0].kind, t: cands[0].t, p: Number.NaN,
    lb: value - w, ub: value + w, sums: { week: new Map(), four: new Map() }, shift: null, kappa: 1,
  };
};

// ---- the adapters of the decisions (spec 9, 10, 11; builder D's own modules) --------------------------------------

const SPEC9_TABLE: ReadonlyArray<{ g: number; n2: number; se?: number; pm75: number; pm18?: number; mde75: number; mde18?: number }> = [
  { g: 2, n2: 300, se: 4.08, pm75: 11.1, pm18: 12.1, mde75: 14.5, mde18: 15.6 },
  { g: 2, n2: 1000, se: 2.24, pm75: 6.1, pm18: 6.6, mde75: 8.0, mde18: 8.6 },
  { g: 2, n2: 3000, se: 1.29, pm75: 3.5, pm18: 3.8, mde75: 4.6, mde18: 4.9 },
  { g: 2, n2: 10000, se: 0.71, pm75: 1.9, pm18: 2.1, mde75: 2.5, mde18: 2.7 },
  { g: 2, n2: 30000, se: 0.41, pm75: 1.1, pm18: 1.2, mde75: 1.5, mde18: 1.6 },
  { g: 3, n2: 300, pm75: 13.6, mde75: 17.8 },
  { g: 3, n2: 1000, pm75: 7.4, mde75: 9.7 },
];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

const G_D: Record<string, Adapter> = {
  "A.2.16": (e) => {
    const rows = e.input.trials as J[];
    const res = rows.map((t) => ({ name: t.name, pass_floor: floorPass({ first: { counted: t.n_first, weeks: t.weeks_first }, second: { counted: t.n_second, weeks: t.weeks_second } }) }));
    return { results: () => res, M_1: () => res.filter((r) => r.pass_floor).length };
  },
  "A.2.17": (e) => {
    const rows = (e.input.trials as J[]).map((t) => ({ id: t.name as string, tf: TF_OF[t.tf], order: t.table_order as number, list: listOf(t.first_half_signals) }));
    const m = sameTrials(rows);
    return { results: () => rows.map((r) => ({ name: r.id, same_trial: m.get(r.id) !== null, same_as: m.get(r.id) ?? null })) };
  },
  "A.2.18": (e) => {
    const tf = TF_OF[e.input.tf];
    const step = e.input.bar_length_minutes * 60_000;
    const rows = (e.input.trials as J[]).map((t) => {
      const p = partsOf(t.name);
      return { id: t.name as string, tf, order: t.table_order as number, kind: p.kind, e: p.e, b: p.b, floor: t.pass_floor as boolean, list: listOf(t.first_half_signals) };
    });
    const shares: J[] = [];
    for (let a = 0; a < rows.length; a++) {
      for (let b = a + 1; b < rows.length; b++) {
        const A = rows[a].list;
        const B = rows[b].list;
        const ab = overlapCount(A, B, step);
        const ba = overlapCount(B, A, step);
        const larger = Math.max(ab / A.T.length, ba / B.T.length);
        shares.push({ A: rows[a].id, B: rows[b].id, A_to_B: `${ab}/${A.T.length}`, B_to_A: `${ba}/${B.T.length}`, larger, linked: larger >= 0.5 });
      }
    }
    const g = overlapGroups(rows, { m15: step, h1: step });
    const groups = new Map<string, string[]>();
    for (const r of [...rows].sort((x, y) => x.order - y.order)) {
      const name = g.get(r.id);
      if (name === undefined) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(r.id);
    }
    return {
      pair_shares: () => shares,
      groups: () => [...groups.values()],
      n_groups: () => groups.size,
      not_grouped: () => rows.filter((r) => !g.has(r.id)).map((r) => r.id),
    };
  },
  "A.2.19": (e) => {
    const inp = e.input;
    const t1 = (df: number) => tq(1 - 0.025 / 6, df);
    const rowsOf = (g: number, withDf18: boolean) =>
      (inp.n2_values as number[]).filter((n2) => g === 2 || n2 <= 1000).map((n2) => {
        const a = mdeOf(g, n2, 75, 6);
        const b = mdeOf(g, n2, 18, 6);
        const tab = SPEC9_TABLE.find((r) => r.g === g && r.n2 === n2)!;
        const match = (tab.se === undefined || round2(a.se) === tab.se) && round1(a.passMin) === tab.pm75 && round1(a.mde) === tab.mde75 &&
          (tab.pm18 === undefined || round1(b.passMin) === tab.pm18) && (tab.mde18 === undefined || round1(b.mde) === tab.mde18);
        const row: J = { n2, g, se: a.se, pass_min_df75: tol(a.passMin, "q") };
        if (withDf18) row.pass_min_df18 = tol(b.passMin, "q");
        row.mde_df75 = tol(a.mde, "q");
        if (withDf18) {
          row.mde_df18 = tol(b.mde, "q");
          row.mark_df75 = a.mark;
          row.mark_df18 = b.mark;
        }
        row.matches_spec_rounding = match;
        return row;
      });
    const g = gOf(inp.g_example.mean_used_se_100runs, inp.g_example.n1);
    const pl = plEstimate(inp.pl_example.sd_pips, inp.pl_example.g, inp.pl_example.n2, 75, 6);
    return {
      t_1_minus_0_025_over_6: () => tol({ "75": t1(75), "18": t1(18) }, "q"),
      t_080: () => tol({ "75": tq(0.8, 75), "18": tq(0.8, 18) }, "q"),
      rows_g2: () => rowsOf(2, true),
      rows_g3: () => rowsOf(3, false),
      g_example: () => g,
      se_estimate_n2_500: () => 50 * Math.sqrt(g / inp.g_example.n2),
      pl_se_pips: () => pl.se,
      pl_top_holm_pips: () => tol(pl.topHolm, "q"),
      stage3_count_estimate: () => stage3Estimate(inp.stage3_example.n2),
    };
  },
  "A.2.20": (e, plant) => {
    const q4 = q4Of(e);
    const c15 = (e.input.trials_15min as J[]).map((r) => stage1CandOf(r, "m15"));
    const c1h = (e.input.trials_1hour as J[]).map((r) => stage1CandOf(r, "h1"));
    const out = chooseStage1([...c15, ...c1h], q4, plant);
    const sk = (cs: Stage1Cand[]) => out.skipped.filter((s) => cs.some((c) => c.id === s.id)).map((s) => ({ name: s.id, reason: skipText(s.reason, s.by) }));
    return {
      eligibility_15min: () => c15.map((c) => ({ name: c.id, fail_rule: out.failRule.get(c.id) })),
      order_15min: () => out.order.m15,
      chosen_15min: () => out.chosen.m15,
      skipped_15min: () => sk(c15),
      eligibility_1hour: () => c1h.map((c) => ({ name: c.id, fail_rule: out.failRule.get(c.id) })),
      order_1hour: () => out.order.h1,
      chosen_1hour: () => out.chosen.h1,
      skipped_1hour: () => sk(c1h),
      K_total: () => out.K_total,
    };
  },
  "A.2.21": (e) => {
    const inp = e.input;
    const KIND: Record<string, SeCand["kind"]> = { 週: "week", "4週": "4w", 週ずらし: "shift" };
    const scaled = (value: number, cs: J[], kappa: number) => {
      const est = estOfCands(value, 1000, cs.map((c) => ({ kind: KIND[c.label], se: c.se, df: c.df })));
      for (const c of est.cands) if (c.kind === "shift") c.K = 75;
      const k = withKappa(est, kappa);
      return {
        k,
        out: tol({
          candidates: k.cands.map((c) => ({ label: KIND_JA[c.kind], se: c.se, df: c.df, t: c.t, p: tol(c.p, "p"), t975: c.q975, half_width: c.halfWidth })),
          interval_from: KIND_JA[k.useLB as string], p_from: KIND_JA[k.useP as string], p: tol(k.p, "p"), t: k.t, lb: k.lb, ub: k.ub,
        }, "q"),
      };
    };
    const d = scaled(inp.delta, inp.delta_candidates, inp.kappa_delta);
    const pl = scaled(inp.pl_pips, inp.pl_candidates, inp.kappa_pl);
    const runs = inp.kappa_arith.runs as J[];
    const ka = (v: string, se: string) => {
      const r = kappaOf(runs.map((x) => x[v]), runs.map((x) => x[se]));
      return { sd: r.sd, mean_se: r.meanSe, runs_for_sd: r.runsForSd, runs_for_mean_se: r.runsForMeanSe, runs_without_t: r.runsWithoutT, kappa: r.kappa, kappa_used: r.kappaUsed };
    };
    return {
      delta_scaled: () => d.out,
      pl_scaled: () => pl.out,
      p_delta: () => tol(d.k.p, "p"),
      p_pl: () => tol(pl.k.p, "p"),
      p_iut: () => tol(Math.max(d.k.p, pl.k.p), "p"),
      kappa_arith: () => ({ delta: ka("delta", "se_delta_p"), pl: ka("pl", "se_pl_p") }),
    };
  },
  "A.2.22": (e, plant) => {
    const K = e.params.K_total as number;
    const cs = (e.input.trials as J[]).map((t) => stage2Of({ id: t.name, order: t.table_order, n: t.n, pDelta: t.p_delta, pPl: t.p_pl, tDelta: t.t_delta, tPl: t.t_pl }));
    const h = holm(cs, K, "iut", plant);
    const ranked = [...h.entries()].sort((a, b) => a[1].rank - b[1].rank);
    const oc = (e.input.order_only_case as J[]).map((t) => stage2Of({ id: t.name, order: t.order, n: t.n, pDelta: t.p, pPl: t.p, tDelta: t.tmin, tPl: t.tmin }));
    const ho = holm(oc, K, "iut", plant);
    return {
      p_iut: () => Object.fromEntries(cs.map((c) => [c.id, h.get(c.id)!.p])),
      holm: () => ranked.map(([name, r]) => ({ rank: r.rank, name, p: r.p, threshold: holmThreshold(K, r.rank), passes: r.pass })),
      passed: () => ranked.filter(([, r]) => r.pass).map(([name]) => name),
      order_only_case: () => [...ho.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([name]) => name),
    };
  },
  "A.2.23": (e, plant) => {
    const K = e.params.K_total as number;
    const q2 = q2Of(e);
    const q4 = q4Of(e);
    const t975 = (df: number) => tq(0.975, df);
    const cs: Stage2In[] = (e.input.trials as J[]).map((t) => {
      const dirs = [t.dirs.buy, t.dirs.sell];
      const pairs = PAIRS.map((p) => t.pairs[p] ?? null);
      return {
        ...stage2Of({ id: t.name, order: t.order, n: dirs[0].n + dirs[1].n, pDelta: t.p_delta, pPl: t.p_pl, tDelta: t.delta / t.se, tPl: t.delta / t.se }),
        deltaByDir: [dirs[0].delta, dirs[1].delta],
        countedByDir: [dirs[0].n, dirs[1].n],
        deltaByPair: pairs.map((p) => (p ? p.delta : null)),
        countedByPair: pairs.map((p) => (p ? p.n : 0)),
        lateLb: t.late.delta - t975(t.late.df) * t.late.se,
        plLate: t.late.pl,
        deltaLate: t.late.delta,
        suspicious: t.susp.hit,
        suspiciousChecksPassed: t.susp.checks_all_passed,
        c6: [t.halves[0], t.halves[1]],
        plEx1w: t.pl_ex1week,
        deltaUb: t.delta + t975(t.df) * t.se,
        deltaEst: estOfCands(t.delta, dirs[0].n + dirs[1].n, [{ kind: "week", se: t.se, df: t.df }]),
      };
    });
    const rows = stage2Rows(cs, K, q2, q4, plant);
    const hi = holm(cs, K, "iut", plant);
    const hd = holm(cs, K, "delta", plant);
    const ladder = (h: ReturnType<typeof holm>) => [...h.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([name, r]) => ({ rank: r.rank, name, p: r.p, threshold: holmThreshold(K, r.rank), passes: r.pass }));
    return {
      holm_iut: () => ladder(hi),
      holm_delta_only: () => ladder(hd),
      t_975_df75: () => tol(t975(75), "q"),
      t_1_minus_0_025_over_6_df75: () => tol(tq(1 - 0.025 / K, 75), "q"),
      t_080_df75: () => tol(tq(0.8, 75), "q"),
      results: () =>
        rows.map((r, k) => {
          const t = (e.input.trials as J[])[k];
          const c = cs[k];
          let dF: J = null;
          if (t.D_F) {
            const w = t975(t.D_F.df_week) * t.D_F.se_week;
            const f = t.D_F.C_4week >= 10 ? t975(t.D_F.df_4week) * t.D_F.se_4week : null;
            const use4 = f !== null && f > w;
            const hw = use4 ? (f as number) : w;
            const lower = t.D_F.value - hw;
            dF = tol({ week_half_width: w, four_week_half_width: f, used: use4 ? KIND_JA["4w"] : KIND_JA.week, lower, upper: t.D_F.value + hw, no_uplift_sentence: !(lower > 0) }, "q");
          }
          return {
            name: r.id,
            p_iut: r.pIut,
            conditions: Object.fromEntries(r.C.map((x, j) => [`C${j + 1}`, x])),
            late_lower: tol(c.lateLb, "q"),
            delta_upper: tol(c.deltaUb, "q"),
            delta_only_holm_pass: r.holmDeltaPass,
            verdict: r.verdict,
            label: r.label,
            failed: r.verdict === 3 ? r.failed.map((j) => `C${j}`) : r.verdict === 1 ? [] : null,
            MDE: tol(r.mde, "q"),
            bonferroni_lower: tol(r.simLb, "q"),
            D_F: dF,
          };
        }),
      no_uplift_sentence_text: () => "合図 E を足した分の上積みは言えない（F だけの行と区別できない）",
    };
  },
  "A.2.27": (e, plant) => {
    const vals = e.input.part1_values as number[];
    const m = (e.input.part2_trials as J[]).length;
    const pi = (e.input.part2_trials as J[]).map((t) => ({ name: t.name as string, p: Math.max(t.p_delta, t.p_pl) }));
    const sorted = [...pi].sort((a, b) => a.p - b.p);
    const cands = (e.input.part3_trials as J[]).map((t) => stage1CandOf(t, tfOfName(t.name, "m15")));
    const out = chooseStage1(cands, q4Of(e), plant);
    const ex = stage1Explain(cands, new Map());
    return {
      part1: () => ({ n: vals.length, rank_1based: Math.ceil((95 * vals.length) / 100), p95: point95(vals) }),
      part2: () => ({
        m,
        p_iut: Object.fromEntries(pi.map((x) => [x.name, x.p])),
        sorted: sorted.map((x, k) => ({ k: k + 1, p: x.p, threshold: ((k + 1) * 0.1) / m, le: x.p <= ((k + 1) * 0.1) / m })),
        bh_pass_count: stage1Explain([], new Map(pi.map((x) => [x.name, x.p]))).bhPass,
      }),
      part3: () => ({
        fail_rule: Object.fromEntries(cands.map((c) => [c.id, out.failRule.get(c.id)])),
        K_total: out.K_total,
        open_second_half: out.K_total > 0,
        lb_gt_0_trials: ex.lbPos,
        lb_gt_0_groups: ex.lbPosGroups,
        lb_and_pl_gt_0_trials: ex.lbAndPlPos,
      }),
    };
  },
};

// a Stage2Cand with the fields the Holm examples give (the rest neutral)
function stage2Of(o: { id: string; order: number; n: number; pDelta: number; pPl: number; tDelta: number | null; tPl: number | null }): Stage2In {
  return {
    id: o.id, tf: "m15", order: o.order, n: o.n, weeks: 0, pDelta: o.pDelta, pPl: o.pPl, tDelta: o.tDelta, tPl: o.tPl,
    deltaByDir: [null, null], countedByDir: [0, 0], deltaByPair: [null, null, null, null, null], countedByPair: [0, 0, 0, 0, 0],
    lateLb: null, plLate: null, suspicious: false, suspiciousChecksPassed: null, c6: [null, null], plEx1w: null, deltaUb: null,
  };
}

// ---- the runner -------------------------------------------------------------------------------------------------

// ---- the adapters of groups 1, 3 and 4 (the other builders' modules; their inputs as A's and B's tests read them) ----

const isoOf = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const dateOf = (yyyymmdd: number) => `${String(yyyymmdd).slice(0, 4)}-${String(yyyymmdd).slice(4, 6)}-${String(yyyymmdd).slice(6, 8)}`;
const STEP_OF: Readonly<Record<string, number>> = { "15min": STEP.m15, "1hour": STEP.h1, m15: STEP.m15, h1: STEP.h1 };
const SYMS: Readonly<Record<string, string>> = { "USD/JPY": "USD_JPY", "EUR/JPY": "EUR_JPY", "AUD/JPY": "AUD_JPY", "EUR/USD": "EUR_USD", "AUD/USD": "AUD_USD" };
const HALF_JA: Readonly<Record<string, string>> = { first: "前半", second: "後半", r1: "①", r1b: "①b" };
const MARK: Readonly<Record<string, string>> = { r1: "①", r1w: "①", r1b: "①b", r2: "②", r3: "③", r4: "④", r5: "⑤", r6: "⑥", counted: "数えた" };
const tri = (a: ArrayLike<number>) => Array.from(a, (v) => (v === -1 ? null : v === 1));
const flatMid = (pair: string) => (pair.endsWith("JPY") ? ["150.000", "150.000", "150.000", "150.000"] : ["1.10000", "1.10000", "1.10000", "1.10000"]);
const flatSeries = (pair: string, tf: TfKey, starts: number[]): Series => seriesFromMid(pair as Pair, tf, starts, starts.map(() => flatMid(pair)));
const handTrials = new Map<string, TrialDef>();
// every example by id (an example "same_as" another reads its input)
const handById = new Map<string, J>();
const trialOf = (id: string): TrialDef => {
  const t = handTrials.get(id);
  if (!t) throw new Error(`no trial ${id}`);
  return t;
};
// an example's series from mid strings ("s", or "start" + k × step; or bars [{s, mid}])
const midSeries = (inp: J, plant: string): Series => {
  const tf = TF_OF[inp.tf];
  if (inp.mid) {
    const n = inp.mid.length;
    const s = inp.s ? inp.s.map(ms) : Array.from({ length: n }, (_, k) => ms(inp.start) + k * STEP[tf]);
    return seriesFromMid(inp.pair, tf, s, inp.mid, plant);
  }
  return seriesFromMid(inp.pair, tf, inp.bars.map((b: J) => ms(b.s)), inp.bars.map((b: J) => b.mid), plant);
};
// Bars from rows {s, bid: [o,h,l,c], ask: [o,h,l,c]}
const barsOfRows = (rows: J[]): Bars => {
  const b = emptyBars(rows.length);
  rows.forEach((r: J, i: number) => {
    b.t[i] = ms(r.s);
    [b.bo[i], b.bh[i], b.bl[i], b.bc[i]] = r.bid.map(Number);
    [b.ao[i], b.ah[i], b.al[i], b.ac[i]] = r.ask.map(Number);
    b.key[i] = -1;
  });
  return b;
};
const barRow = (s: Series, k: number) => {
  const d = MID_DIGITS(s.pair);
  return {
    i: k, s: isoOf(s.s[k]),
    bid: [s.bo[k], s.bh[k], s.bl[k], s.bc[k]].map((v) => v.toFixed(d)), ask: [s.ao[k], s.ah[k], s.al[k], s.ac[k]].map((v) => v.toFixed(d)),
    mid: [s.O[k], s.H[k], s.L[k], s.C[k]], P: [s.Po[k], s.Ph[k], s.Pl[k], s.Pc[k]], B: [s.Bo[k], s.Bh[k], s.Bl[k], s.Bc[k]], A: [s.Ao[k], s.Ah[k], s.Al[k], s.Ac[k]],
  };
};
const klineRow = (t: number, p: string[]) => ({ openTime: String(t), open: p[0], high: p[1], low: p[2], close: p[3] });
// GMO day files under research/out/lawsearch/hand-tmp/<tag>/gmo: every key of keysFor written (rows, or raw bodies)
const HAND_TMP = "research/out/lawsearch/hand-tmp";
const writeGmo = async (tag: string, pair: string, tfName: string, from: number, to: number, rows: Map<string, { bid: unknown[]; ask: unknown[] }>, raw?: Map<string, { bid: unknown; ask: unknown }>): Promise<string> => {
  const dir = `${HAND_TMP}/${tag}/gmo`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  const { keys } = keysFor(tfName === "15min" ? "15min" : "1h", from, to);
  for (const side of ["bid", "ask"] as const) await Deno.mkdir(`${dir}/${SYMS[pair]}/${tfName}/${side}`, { recursive: true });
  for (const key of new Set([...keys, ...rows.keys(), ...(raw?.keys() ?? [])])) {
    for (const side of ["bid", "ask"] as const) {
      const body = raw?.get(key)?.[side] ?? { status: 0, data: rows.get(key)?.[side] ?? [] };
      await Deno.writeTextFile(`${dir}/${SYMS[pair]}/${tfName}/${side}/${key}.json`, JSON.stringify(body));
    }
  }
  return dir;
};
const hopts = (plant: string) => ({ purpose: "hand" as const, band: "syn" as const, plant });
const rowsByDay = (starts: number[], bid: string[], ask: string[]) => {
  const rows = new Map<string, { bid: unknown[]; ask: unknown[] }>();
  for (const t of starts) {
    const key = gmoDayKey(t);
    if (!rows.has(key)) rows.set(key, { bid: [], ask: [] });
    rows.get(key)!.bid.push(klineRow(t, bid));
    rows.get(key)!.ask.push(klineRow(t, ask));
  }
  return rows;
};
// the candidates' emitted rows of a trial on one series (the examples' {i, d: BUY|SELL})
const emittedOf = (trial: TrialDef, s: Series, plant: string, params?: ItemParams, warmOnly = false) => {
  const c = candidatesOf(trial, indOf(s, null, plant), { params, plant });
  const out: Array<{ i: number; d: "BUY" | "SELL" }> = [];
  for (let r = 0; r < c.n; r++) {
    if (c.status[r] !== STATUS.indexOf("emit")) continue;
    if (warmOnly && c.warmOk[r] !== 1) continue;
    out.push({ i: c.i[r], d: c.d[r] === 1 ? "BUY" : "SELL" });
  }
  return out;
};
// the first Friday 21:00 UTC at or after T (④'s t_F)
const firstFriday2100 = (T: number): number => {
  const d = new Date(T);
  const mid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let c = mid + ((5 - d.getUTCDay() + 7) % 7) * DAY + 21 * HOUR;
  if (c < T) c += WEEK;
  return c;
};
const avoidFrom = (rows: J[]) => {
  const out = new Set<string>();
  for (const r of rows) {
    const slot = Array.from({ length: SLOTS }, (_, k) => k).find((k) => hhmm(k) === r.slot)!;
    if (r.avoid === "yes") out.add(avoidKey(r.pair, r.season, slot));
  }
  return out;
};
interface HoleCase { tf: TfKey; from: number; count: number; missing: Record<string, number[]>; before?: number[] }
const holeSeries = (c: HoleCase): Series[] =>
  PAIRS.map((p) => {
    const miss = new Set(c.missing[p] ?? []);
    const starts: number[] = [...(c.before ?? [])];
    for (let k = 0; k < c.count; k++) if (!miss.has(k)) starts.push(c.from + k * STEP[c.tf]);
    return flatSeries(p, c.tf, starts);
  });
const holesOut = (c: HoleCase, sigK: number[], plant: string) => {
  const ss = holeSeries(c);
  const step = STEP[c.tf];
  const h = holesOf(c.tf, ss.map((s) => s.s), c.from, c.from + c.count * step);
  const k0 = (c.from - h.fromMs) / step;
  const open = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, h.open[k0 + Number(k)] === 1]));
  const runs: Array<{ from: string; k: number; slots: number }> = [];
  for (let k = 0; k < h.nSlots; k++) {
    if (h.hole[0][k] === 1 && (k === 0 || h.hole[0][k - 1] !== 1)) {
      let e = k;
      while (e < h.nSlots && h.hole[0][e] === 1) e++;
      runs.push({ from: isoOf(h.fromMs + k * step), k: k - k0, slots: e - k });
    }
  }
  const uj = ss[0];
  const sigs = sigK.map((k) => {
    const s0 = c.from + k * step;
    const i = uj.s.indexOf(s0);
    const sFrom = uj.s[Math.max(0, i - 9)];
    return { k, s: isoOf(s0), T: isoOf(s0 + step), i, s_i_minus_9: isoOf(sFrom), k_i_minus_9: (sFrom - c.from) / step, r3: r3(h, 0, sFrom, s0 + step, plant) };
  });
  return { open, runs, sigs, ss };
};
const hitsOf = (ctx: ExclCtx, s: Series, i: number, plant: string): string[] => {
  const T = s.T[i];
  const X = T + N_BARS * s.step;
  const out: string[] = [];
  const h = halfOf(T, X, null, plant);
  if (h === "r1") out.push("①");
  if (h === "r1b") out.push("①b");
  if (r2(T)) out.push("②");
  if (r3(ctx.holes, s.pi, s.s[Math.max(0, i - 9)], T, plant)) out.push("③");
  if (r4(T, X)) out.push("④");
  if (r5(T)) out.push("⑤");
  if (r6(ctx.avoid, s.pair, T, X)) out.push("⑥");
  return out;
};
const orderOut = (ss: Series[], tf: TfKey, avoid: Set<string>, from: number, to: number, bars: Array<{ pi: number; s: number }>, plant: string, extra?: (s: Series, i: number) => Record<string, unknown>) => {
  const set = tfSetOf(tf, ss, plant);
  const ctx = exclCtxOf(set, avoid, from, to, null, plant);
  const counts: Record<string, number> = { "①": 0, "①b": 0, "②": 0, "③": 0, "④": 0, "⑤": 0, "⑥": 0, "数えた": 0 };
  const rows = bars.map((b) => {
    const s = ss[b.pi];
    const i = s.s.indexOf(b.s);
    const mark = MARK[reasonOf(ctx, s, i, true)];
    counts[mark]++;
    return { ...(extra ? extra(s, i) : {}), s: isoOf(b.s), T: isoOf(s.T[i]), X: isoOf(s.T[i] + N_BARS * s.step), hits: hitsOf(ctx, s, i, plant), counted_as: mark };
  });
  return { rows, counts, total: bars.length };
};
const halfJa = (T: number, X: number, plant: string) => HALF_JA[halfOf(T, X, null, plant)];
const sigX = (x: J) => ms(x.T) + N_BARS * STEP_OF[x.tf];
const trade = (s: Series, T: number, X: number, plant: string) => (side: "buy" | "sell") => {
  const d = side === "buy" ? 1 : -1;
  const tr = tradeOf(s, T, X, d, plant);
  if (!tr) return { made: false, X: isoOf(X) };
  const { j, x } = tr;
  return {
    made: true, X: isoOf(X), j, j_s: isoOf(s.s[j]), x, x_s: isoOf(s.s[x]), substitute_exit: tr.subst,
    entry_pts: d === 1 ? s.Ao[j] : s.Bo[j], exit_pts: d === 1 ? s.Bc[x] : s.Ac[x], Po_j: s.Po[j], Pc_x: s.Pc[x],
    m: tr.m, h: tr.h, PL: tr.pl, pips: tr.pl / 10, W: tr.pl > 0 ? 1 : 0,
  };
};
const bmParams = (p: J): ItemParams => {
  const bm: Partial<BigmoveParams> = { sigmaWindow: p.sigma_window, sigmaMinUsable: p.sigma_min_usable, moveBars: p.move_bars, threshold: p.threshold };
  if (p.gap_minutes !== undefined) bm.gapMs = p.gap_minutes * MINUTE;
  for (const k of Object.keys(bm) as Array<keyof BigmoveParams>) if (bm[k] === undefined) delete bm[k];
  return { bigmove: bm };
};
const fromIdx = (a: ArrayLike<number>, off: number) => Array.from(a).slice(off);
// Python's repr of a finite double (an integral value below 1e16 gets ".0"; JS and Python agree on the digits)
const pyRepr = (x: number): string => (Number.isInteger(x) && Math.abs(x) < 1e16 ? `${x}.0` : String(x));
const firstVal = (a: ArrayLike<number>) => Array.from(a).findIndex((v) => !Number.isNaN(v));

const G1: Record<string, Adapter> = {
  "A.1.1": (e) => {
    const w = (e.input.times as string[]).map((t) => wk(ms(t)));
    return {
      wk: () => w,
      block4_first: () => (e.input.block4_first_wk as number[]).map((x) => Math.floor((x - W0.first) / 4)),
      block4_second: () => (e.input.block4_second_wk as number[]).map((x) => Math.floor((x - W0.second) / 4)),
      second_half_part: () => (e.input.block4_second_wk as number[]).map((x) => (x <= C6_PARTS[0][1] ? 1 : 2)),
    };
  },
  "A.1.2": (e, plant) => ({
    X: () => (e.input.signals as J[]).map((x) => isoOf(sigX(x))),
    wkT: () => (e.input.signals as J[]).map((x) => wk(ms(x.T))),
    half: () => (e.input.signals as J[]).map((x) => halfJa(ms(x.T), sigX(x), plant)),
  }),
  "A.1.3": (e, plant) => {
    const half = (e.input.signals as J[]).map((x) => halfJa(ms(x.T), sigX(x), plant));
    const counts: Record<string, number> = {};
    for (const h of half) counts[h] = (counts[h] ?? 0) + 1;
    return { X: () => (e.input.signals as J[]).map((x) => isoOf(sigX(x))), wkT: () => (e.input.signals as J[]).map((x) => wk(ms(x.T))), half: () => half, counts: () => counts };
  },
  "A.1.4": (e, plant) => loadMerge(e, plant),
  "A.1.34": (e, plant) => loadMerge(e, plant),
  "A.1.5": async (e, plant) => {
    const bars = e.input.bars as J[];
    const drop: boolean[] = new Array(bars.length).fill(false);
    for (const tfName of ["15min", "1hour"]) {
      const idx = bars.map((b, k) => [b, k] as const).filter(([b]) => b.len === tfName);
      const dir = await writeGmo(`${e.id}-${tfName}`, "USD/JPY", tfName, ms("2024-01-04T00:00:00Z"), ms("2024-01-09T00:00:00Z"), rowsByDay(idx.map(([b]) => ms(b.s)), ["150.000", "150.010", "149.990", "150.000"], ["150.003", "150.013", "149.993", "150.003"]));
      const { series } = await loadPairTf({ dir, fetch: false }, "USD/JPY", TF_OF[tfName], ms("2024-01-04T00:00:00Z"), ms("2024-01-09T00:00:00Z"), hopts(plant));
      const kept = new Set(Array.from(series.s));
      for (const [b, k] of idx) drop[k] = !kept.has(ms(b.s));
    }
    return {
      s_closed: () => bars.map((b) => isMarketClosed(ms(b.s))),
      end_closed: () => bars.map((b) => isMarketClosed(ms(b.s) + STEP_OF[b.len] - 1)),
      drop: () => drop,
    };
  },
  "A.1.6": async (e, plant) => {
    const from = ms(e.input.fromMs), to = ms(e.input.toMs);
    const out: Record<string, Thunk> = {};
    for (const tfName of ["15min", "1hour"]) {
      const starts: string[] = e.input[`starts_${tfName}`];
      const dir = await writeGmo(`${e.id}-${tfName}`, e.input.pair, tfName, from, to, rowsByDay(starts.map(ms), ["150.000", "150.010", "149.990", "150.000"], ["150.003", "150.013", "149.993", "150.003"]));
      const { series } = await loadPairTf({ dir, fetch: false }, e.input.pair, TF_OF[tfName], from, to, hopts(plant));
      const kept = new Set(Array.from(series.s));
      out[`used_${tfName}`] = () => Array.from({ length: series.n }, (_, k) => ({ i: k, s: isoOf(series.s[k]), prev: k ? isoOf(series.s[k - 1]) : null }));
      out[`status_${tfName}`] = () => starts.map((s) => (kept.has(ms(s)) ? "使う" : ms(s) < from ? "範囲の前" : ms(s) + STEP_OF[tfName] > to ? "範囲の後" : "週末"));
    }
    return out;
  },
  "A.1.7": (e, plant) => ({
    v_exact: () => (e.input.rows as J[]).map((r) => ((Number(r.bid) + Number(r.ask)) / 2).toFixed(80).replace(/0+$/, "").replace(/\.$/, "")),
    mid: () => (e.input.rows as J[]).map((r) => midOf(Number(r.bid), Number(r.ask), r.pair, plant)),
  }),
  "A.1.8": (e, plant) => {
    const mids = (e.input.mid_rows as J[]).map((r) => midOf(Number(r.bid), Number(r.ask), r.pair, plant));
    const bt = e.input.buy_trade;
    return {
      mid: () => mids,
      // the example writes these doubles in Python's repr
      mid_times_mult: () => (e.input.mid_rows as J[]).map((r, k) => pyRepr(mids[k] * POINTS_PER_PRICE(r.pair))),
      P: () => (e.input.mid_rows as J[]).map((r, k) => pointsOf(mids[k], r.pair, plant)),
      raw_points: () => (e.input.raw as J[]).map((r) => rawPointsOf(Number(r.price), r.pair)),
      buy_trade_PL: () => rawPointsOf(Number(bt.Bc_x), bt.pair) - rawPointsOf(Number(bt.Ao_j), bt.pair),
      off_tick: () => {
        try {
          rawPointsOf(Number(e.input.off_tick.price), e.input.off_tick.pair);
          return "no stop";
        } catch (err) {
          return (err as Error).message.startsWith("STOP:") ? "stop" : `other error ${(err as Error).message}`;
        }
      },
    };
  },
  "A.1.9": (e, plant) => {
    const s = seriesOf(e.input.pair, "m15", barsOfRows(e.input.bars), plant);
    const first = new Map<number, number>();
    for (let k = 0; k < s.n; k++) if (!first.has(s.day[k])) first.set(s.day[k], k);
    return {
      t_plus_3h_date: () => Array.from(s.s, (t) => new Date(t + 3 * HOUR).toISOString().slice(0, 10)),
      D: () => Array.from(s.day, dateOf),
      day_open_Po: () => Array.from(s.day, (d) => s.Po[first.get(d)!]),
      day_open_O: () => Array.from(s.day, (d) => s.O[first.get(d)!]),
      mid: () => Array.from({ length: s.n }, (_, k) => [s.O[k], s.H[k], s.L[k], s.C[k]]),
    };
  },
  "A.1.10": (e) => {
    const ts = (e.input.times as string[]).map(ms);
    const label = ["両方冬", "両方夏", "NYだけ夏", "ロンドンだけ夏"];
    return { ny: () => ts.map((t) => (nySummer(t) ? "summer" : "winter")), london: () => ts.map((t) => (londonSummer(t) ? "summer" : "winter")), group: () => ts.map((t) => label[seasonGroupOf(t)]) };
  },
  "A.1.11": (e, plant) => {
    const ts = (e.input.times as string[]).map(ms);
    return {
      D: () => ts.map((t) => dateOf(dayOf(t, plant))),
      holiday: () => ts.map((t) => isGmoHoliday(t)),
      // the example lists isPossiblyClosed only for its last ten rows (market-hours' function)
      in_isPossiblyClosed: () => ts.map((t, k) => (e.expect.in_isPossiblyClosed[k] === null ? null : isPossiblyClosed(t))),
    };
  },
  "A.1.12": (e, plant) => htfOut(e, plant),
  "A.1.13": (e, plant) => htfOut(e, plant),
  "A.1.14": (e) => ({ r2: () => (e.input.T as string[]).map((x) => r2(ms(x))) }),
  "A.1.15": (e, plant) => holesAdapter(e, plant),
  "A.1.16": (e, plant) => holesAdapter(e, plant),
  "A.1.18": (e, plant) => holesAdapter(e, plant),
  "A.1.19": (e, plant) => holesAdapter(e, plant),
  "A.1.17": (e, plant) => {
    const inp = e.input;
    const a = holesOut({ tf: "m15", from: ms(inp.slots_15min.from), count: inp.slots_15min.count, missing: inp.missing_15min }, inp.tf_15min_signal_bars_k, plant);
    const b = holesOut({ tf: "h1", from: ms(inp.slots_1hour.from), count: inp.slots_1hour.count, missing: inp.missing_1hour }, inp.tf_1hour_signal_bars_k, plant);
    return { signals_15min: () => a.sigs, signals_1hour: () => b.sigs };
  },
  "A.1.20": (e) => ({
    X: () => (e.input.signals as J[]).map((x) => isoOf(sigX(x))),
    first_friday_2100: () => (e.input.signals as J[]).map((x) => isoOf(firstFriday2100(ms(x.T)))),
    r4: () => (e.input.signals as J[]).map((x) => r4(ms(x.T), sigX(x))),
  }),
  "A.1.21": (e) => ({ X: () => (e.input.signals as J[]).map((x) => isoOf(sigX(x))), r4: () => (e.input.signals as J[]).map((x) => r4(ms(x.T), sigX(x))) }),
  "A.1.22": (e) => ({ r5: () => (e.input.T as string[]).map((x) => r5(ms(x))) }),
  "A.1.23": (e) => {
    const avoid = avoidFrom(e.input.avoid_table);
    const sigs = e.input.signals as J[];
    return {
      entry_slot: () => sigs.map((x) => ({ season: seasonOf(ms(x.T)), slot: hhmm(slotOf(ms(x.T))) })),
      exit_slot: () => sigs.map((x) => ({ season: seasonOf(sigX(x) - MINUTE), slot: hhmm(slotOf(sigX(x) - MINUTE)) })),
      r6: () => sigs.map((x) => r6(avoid, x.pair, ms(x.T), sigX(x))),
    };
  },
  "A.1.24": (e, plant) => {
    const inp = e.input;
    const tf = TF_OF[inp.tf];
    const c: HoleCase = { tf, from: ms(inp.slots.from), count: inp.slots.count, missing: inp.missing };
    const o = orderOut(holeSeries(c), tf, avoidFrom(inp.avoid_table), c.from, c.from + c.count * STEP[tf], (inp.signal_bars as string[]).map((x) => ({ pi: 0, s: ms(x) })), plant);
    return { signals: () => o.rows, counts: () => o.counts, total: () => o.total };
  },
  "A.1.25": (e, plant) => {
    const inp = e.input;
    const tf = TF_OF[inp.tf];
    const before: number[] = [];
    for (let x = ms("2025-05-16T12:00:00Z"); x <= ms("2025-05-16T21:45:00Z"); x += STEP[tf]) before.push(x);
    const c: HoleCase = { tf, from: ms(inp.slots.from), count: inp.slots.count, missing: inp.missing, before };
    const o = orderOut(holeSeries(c), tf, avoidFrom(inp.avoid_table), before[0], c.from + c.count * STEP[tf], (inp.signal_bars as string[]).map((x) => ({ pi: 0, s: ms(x) })), plant);
    return { signals: () => o.rows, counts: () => o.counts, total: () => o.total };
  },
  "A.1.26": (e, plant) => tradeAdapter(e, plant),
  "A.1.27": (e, plant) => tradeAdapter(e, plant),
  "A.1.28": (e, plant) => tradeAdapter(e, plant),
  "A.1.29": (e, plant) => tradeAdapter(e, plant),
  "A.1.30": (e, plant) => tradeAdapter(e, plant),
  "A.1.31": (e, plant) => tradeAdapter(e, plant),
  "A.1.32": (e, plant) => {
    const avoid = avoidFrom(e.input.avoid_table);
    const rows: J[] = [];
    const counts: Record<string, number> = { "①": 0, "①b": 0, "②": 0, "③": 0, "④": 0, "⑤": 0, "⑥": 0, "数えた": 0 };
    for (const x of e.input.signals as J[]) {
      const tf = TF_OF[x.tf];
      const step = STEP[tf];
      const s0 = ms(x.s);
      const starts: number[] = [];
      for (let k = -20; k <= 1; k++) starts.push(s0 + k * step);
      const ss = PAIRS.map((p) => flatSeries(p, tf, starts));
      const ctx = exclCtxOf(tfSetOf(tf, ss, plant), avoid, starts[0], starts[starts.length - 1] + step, null, plant);
      const s = ss[0];
      const i = s.s.indexOf(s0);
      const T = s.T[i];
      const X = T + N_BARS * step;
      const mark = MARK[reasonOf(ctx, s, i, true)];
      counts[mark]++;
      rows.push({ tf: x.tf, s: x.s, T: isoOf(T), X: isoOf(X), wkT: wk(T), half: halfJa(T, X, plant), hits: hitsOf(ctx, s, i, plant), counted_as: mark });
    }
    return { signals: () => rows, counts: () => counts, total: () => rows.length };
  },
  "A.1.33": (e, plant) => {
    const inp = e.input;
    const tf = TF_OF[inp.tf];
    const c: HoleCase = { tf, from: ms(inp.slots.from), count: inp.slots.count, missing: inp.missing };
    const h = holesOut(c, inp.signal_bars_k, plant);
    const o = orderOut(h.ss, tf, avoidFrom(inp.avoid_table), c.from, c.from + c.count * STEP[tf], (inp.signal_bars_k as number[]).map((k) => ({ pi: 0, s: c.from + k * STEP[tf] })), plant);
    return {
      open_slot: () => h.open(Object.keys(e.expect.open_slot)),
      holes_usdjpy: () => h.runs,
      signals: () => h.sigs.map((x, k) => ({ k: x.k, s: x.s, T: x.T, X: o.rows[k].X, i: x.i, s_i_minus_9: x.s_i_minus_9, k_i_minus_9: x.k_i_minus_9, r3: x.r3, hits: o.rows[k].hits, counted_as: o.rows[k].counted_as })),
      counts: () => o.counts,
      total: () => o.total,
    };
  },
  "A.1.35": (e, plant) => {
    const inp = e.input;
    const k = e.params.k as number;
    const out: J[] = [];
    let warmOnly = 0;
    const counts: Record<string, number> = { "①": 0, "①b": 0, "①を通る": 0 };
    const fNone: Record<string, number> = { 前半: 0, 後半: 0, 数えない: 0 };
    for (const p of inp.pairs as J[]) {
      const starts: number[] = [];
      for (let x = ms(p.first_bar); starts.length < 12; x += HOUR) if (!barInsideClosure(x, HOUR)) starts.push(x);
      const s = flatSeries(p.pair, "h1", starts);
      const ctx = exclCtxOf(tfSetOf("h1", PAIRS.map((q) => (q === p.pair ? s : flatSeries(q, "h1", []))), plant), new Set(), starts[0], starts[starts.length - 1] + HOUR, null, plant);
      for (const i of p.signal_bars_i as number[]) {
        const T = s.T[i];
        const X = T + N_BARS * HOUR;
        const hf = halfOf(T, X, null, plant);
        const row: J = { pair: p.pair, i, s: isoOf(s.s[i]), T: isoOf(T), X: isoOf(X), wkT: wk(T), half: HALF_JA[hf] };
        if (i < inp.F.value_from_i) {
          const where = hf === "first" ? "前半" : hf === "second" ? "後半" : "数えない";
          fNone[where]++;
          Object.assign(row, { F: "無し", step5_4: "F が無し", r1: null, warmup_only: null, f_none_counted_in: where });
        } else {
          const code = reasonOf(ctx, s, i, i >= k);
          const r1 = code === "r1" || code === "r1w" ? "①" : code === "r1b" ? "①b" : "通る";
          counts[r1 === "通る" ? "①を通る" : r1]++;
          if (code === "r1w") warmOnly++;
          Object.assign(row, { F: "真", step5_4: "通る", r1, warmup_only: code === "r1w" ? true : code === "r1" ? false : null, f_none_counted_in: null });
        }
        out.push(row);
      }
    }
    return { signals: () => out, counts: () => counts, "warmup_only_in_①": () => warmOnly, f_none: () => fNone, all_signals: () => out.filter((x) => x.F === "真").length };
  },
  "A.1.36": (e, plant) => loadCounts(e, plant),
};

async function loadMerge(e: J, plant: string): Promise<Record<string, Thunk>> {
  const from = ms("2024-03-06T00:00:00Z"), to = ms("2024-03-07T00:00:00Z");
  const rows = new Map([["20240306", { bid: (e.input.bid_rows as J[]).map((r) => klineRow(ms(r.s), r.p)), ask: (e.input.ask_rows as J[]).map((r) => klineRow(ms(r.s), r.p)) }]]);
  const dir = await writeGmo(e.id, e.input.pair, e.input.tf, from, to, rows);
  const { series, report } = await loadPairTf({ dir, fetch: false }, e.input.pair, TF_OF[e.input.tf], from, to, hopts(plant));
  return {
    bars: () => Array.from({ length: series.n }, (_, k) => barRow(series, k)),
    dropped_ask_close_lt_bid_close: () => report.droppedAskLtBid,
    same_start_bid_rows: () => report.sameStartBidRows,
    ask_lt_bid_by_year_reference: () => Object.fromEntries(report.askLtBidByYear.map((y) => [String(y.year), { num: y.num, den: y.den }])),
  };
}
function htfOut(e: J, plant: string): Record<string, Thunk> {
  const tf = TF_OF[e.input.tf];
  const base = seriesOf(e.input.pair, tf, barsOfRows(e.input.bars), plant);
  const htf = coarsenSeries(base, tf === "m15" ? "h1" : "h4", plant);
  const d = MID_DIGITS(e.input.pair);
  const g = htfIndex(base, htf, plant);
  return {
    htf: () => Array.from({ length: htf.n }, (_, k) => ({
      k, s: isoOf(htf.s[k]), n_base: Array.from(base.s).filter((t) => Math.floor(t / htf.step) * htf.step === htf.s[k]).length,
      bid: [htf.bo[k], htf.bh[k], htf.bl[k], htf.bc[k]].map((v) => v.toFixed(d)), ask: [htf.ao[k], htf.ah[k], htf.al[k], htf.ac[k]].map((v) => v.toFixed(d)),
      mid: [htf.O[k], htf.H[k], htf.L[k], htf.C[k]], P: [htf.Po[k], htf.Ph[k], htf.Pl[k], htf.Pc[k]],
    })),
    usable_htf_for_base_bar: () => Array.from({ length: base.n }, (_, i) => ({ s: isoOf(base.s[i]), T: isoOf(base.T[i]), k: g[i] < 0 ? null : g[i], htf_s: g[i] < 0 ? null : isoOf(htf.s[g[i]]) })),
  };
}
function holesAdapter(e: J, plant: string): Record<string, Thunk> {
  const inp = e.input;
  const h = holesOut({ tf: TF_OF[inp.tf], from: ms(inp.slots.from), count: inp.slots.count, missing: inp.missing }, inp.signal_bars_k, plant);
  return { open_slot: () => h.open(Object.keys(e.expect.open_slot)), holes_usdjpy: () => h.runs, signals: () => h.sigs };
}
function tradeAdapter(e: J, plant: string): Record<string, Thunk> {
  const out: Record<string, Thunk> = {};
  const T = ms(e.input.T);
  const X = T + e.input.N * STEP_OF[e.input.tf];
  if (!e.input.bars) {
    const empty = flatSeries(e.input.pair, TF_OF[e.input.tf], []);
    const f = trade(empty, T, X, plant);
    return { buy: () => f("buy"), sell: () => f("sell") };
  }
  const s = seriesOf(e.input.pair, TF_OF[e.input.tf], barsOfRows(e.input.bars), plant);
  const f = trade(s, T, X, plant);
  if (e.expect.bars_points) out.bars_points = () => Array.from({ length: s.n }, (_, k) => ({ i: k, s: isoOf(s.s[k]), P: [s.Po[k], s.Ph[k], s.Pl[k], s.Pc[k]], B: [s.Bo[k], s.Bh[k], s.Bl[k], s.Bc[k]], A: [s.Ao[k], s.Ah[k], s.Al[k], s.Ac[k]] }));
  out.buy = () => f("buy");
  out.sell = () => f("sell");
  return out;
}
// A.1.36: one loadTf call's numbers. bid_rows and value_variants are explanatory tables: their computed fields are
// compared (partial), the prose is not (reported to the lead)
async function loadCounts(e: J, plant: string): Promise<Record<string, Thunk>> {
  const pair = e.input.pair;
  const from = ms(e.input.fromMs), to = ms(e.input.toMs);
  const raw0 = new Map<string, { bid: J; ask: J }>((e.input.files as J[]).map((f) => [f.key.replaceAll("-", ""), { bid: f.bid_body, ask: f.ask_body }]));
  const run = async (tag: string, raw: Map<string, { bid: J; ask: J }>) => {
    const dir = await writeGmo(`${e.id}-${tag}`, pair, e.input.tf, from, to, new Map(), raw);
    try {
      return { ok: await loadPairTf({ dir, fetch: false }, pair, TF_OF[e.input.tf], from, to, hopts(plant)), err: null as Error | null };
    } catch (err) {
      return { ok: null, err: err as Error };
    }
  };
  const r = await run("main", raw0);
  if (!r.ok) throw r.err;
  const { series, report } = r.ok;
  const names: string[] = [];
  let bn = 0;
  for (const f of e.input.files as J[]) for (const el of f.bid_body.data) {
    bn++;
    if (scanBody({ status: 0, data: [el] }, "t").unparseable) names.push(`b${bn}`);
  }
  const variants = async () => {
    const out: J[] = [];
    for (const [vi, v] of (e.expect.value_variants as J[]).entries()) {
      const raw = new Map([...raw0.entries()].map(([k, x]) => [k, JSON.parse(JSON.stringify(x))]));
      const data: J[] = raw.get("20250101")!.bid.data;
      if (v.name === "high") {
        if (v.value === "<名前が無い>") delete data[6].high;
        else data[6].high = v.value;
      } else if (v.name === "openTime") data[6].openTime = v.value;
      else data[6] = v.value;
      const o = await run(`v${vi}`, raw);
      let result: string;
      if (o.err) result = o.err.message.startsWith("STOP:") && (reportOfStop(o.err)?.valueStops.length ?? 0) > 0 ? "止まる" : `error ${o.err.message}`;
      else result = o.ok!.report.valueStops.length ? "止まる(no throw)" : `落として数える（数にできない行 ${o.ok!.report.unparseableRows - report.unparseableRows + 1}）`;
      // the value's own columns, by the module's readers on the changed element: decimal_form (spec 2's right form)
      // and js_number (parseKlines' num, NaN as null) are null for an element that is not an object;
      // parseKlines_keeps is whether parseKlines keeps the row on this value alone: false for an element that is not
      // an object or a value it cannot read; null for a value it reads when another value of the row already makes it
      // drop the row (the openTime rows keep high "-")
      const el = data[6];
      const isObj = typeof el === "object" && el !== null && !Array.isArray(el);
      const own = v.name === "high" || v.name === "openTime" ? v.name : null;
      const num = isObj && own ? klineNum((el as J)[own]) : NaN;
      const othersKept = isObj && ["openTime", "open", "high", "low", "close"].filter((n) => n !== own).every((n) => Number.isFinite(klineNum((el as J)[n])));
      out.push({
        ...v,
        decimal_form: isObj && own ? rightFormOf(own, (el as J)[own]) : null,
        js_number: Number.isNaN(num) ? null : num,
        parseKlines_keeps: !isObj || !Number.isFinite(num) ? false : othersKept ? true : null,
        result,
      });
    }
    return new PartialList(out, ["name", "decimal_form", "js_number", "parseKlines_keeps", "result"]);
  };
  return {
    files_read: () => report.keys.map((k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`),
    read_failures: () => report.readFailures,
    unparseable_rows: () => report.unparseableRows,
    unparseable_rows_list: () => names,
    stop_by_value_reading: () => report.valueStops.length > 0,
    bars: () => Array.from({ length: series.n }, (_, k) => barRow(series, k)),
    dropped_ask_close_lt_bid_close: () => report.droppedAskLtBid,
    same_start_bid_rows: () => report.sameStartBidRows,
    ask_lt_bid_by_year: () => Object.fromEntries(report.askLtBidByYear.map((y) => [String(y.year), { num: y.num, den: y.den, stop: y.num / y.den > 0.001 }])),
    // the table of each Bid row: its fields made from the files by spec 2's rules (the prose columns bar and why are
    // not compared); the sums must equal the module's report
    bid_rows: () => {
      const step = STEP_OF[e.input.tf];
      const lastAsk = new Map<number, string>();
      for (const f of e.input.files as J[]) for (const el of f.ask_body.data) if (!scanBody({ status: 0, data: [el] }, "t").unparseable) lastAsk.set(Number(el.openTime), el.close);
      const seen = new Set<number>();
      const out: J[] = [];
      let k = 0;
      let num = 0;
      let same = 0;
      for (const f of e.input.files as J[]) {
        for (const el of f.bid_body.data) {
          k++;
          const row: J = { row: `b${k}`, file: f.key };
          if (scanBody({ status: 0, data: [el] }, "t").unparseable) {
            out.push({ ...row, s: el && typeof el === "object" && /^[0-9]+$/.test(String(el.openTime)) ? isoOf(Number(el.openTime)) : undefined, parsed: false });
            continue;
          }
          const t = Number(el.openTime);
          const a = lastAsk.get(t);
          const r = { ...row, s: isoOf(t), parsed: true, year: new Date(t).getUTCFullYear(), range: t < from ? "前" : t + step > to ? "後" : "中", ask_close: a ?? null, bid_close: el.close, den: a === undefined ? 0 : 1, num: a !== undefined && Number(a) < Number(el.close) ? 1 : 0, same_start: seen.has(t) ? 1 : 0 };
          seen.add(t);
          num += r.num;
          same += r.same_start;
          out.push(r);
        }
      }
      if (num !== report.droppedAskLtBid || same !== report.sameStartBidRows) return { sums: `the table's sums ${num}, ${same}; the module's ${report.droppedAskLtBid}, ${report.sameStartBidRows}` };
      return new PartialList(out, ["row", "file", "s", "parsed", "year", "range", "ask_close", "bid_close", "den", "num", "same_start"]);
    },
    value_variants: variants,
  };
}

const G3: Record<string, Adapter> = {
  "A.3.1": (e) => {
    const a = toF64(e.input.a), b = toF64(e.input.b), L = e.input.L as number;
    return { xup_a_b: () => tri(xUp(a, b)), xdn_a_b: () => tri(xDn(a, b)), xup_a_L: () => tri(xUp(a, L)), xdn_a_L: () => tri(xDn(a, L)) };
  },
  "A.3.2": (e, plant) => smaAdapter(e, plant),
  "A.3.31": (e, plant) => smaAdapter(e, plant),
  "A.3.5": (e, plant) => {
    const x = toF64(e.input.x);
    const ind = indOf(flatSeries("USD/JPY", "m15", [0]), null, plant);
    return { EMA5: () => ind.emaOf(x, 5), RMA5: () => ind.rmaOf(x, 5) };
  },
  "A.3.6": (e, plant) => trAtr(e, plant, "TR", "ATR14", 14),
  "A.3.34": (e, plant) => trAtr(e, plant, "TR", "ATR14", 14),
  "A.3.7": (e, plant) => {
    const r = indOf(midSeries(e.input, plant), null, plant).rsi(7);
    return { up: () => r.up, dn: () => r.dn, U: () => r.U, D: () => r.D, RSI7: () => r.rsi };
  },
  "A.3.8": (e, plant) => {
    const s = midSeries(e.input, plant);
    const ind = indOf(s, null, plant);
    const out: Record<string, Thunk> = { RSI7: () => ind.rsi(7).rsi, RSI14: () => ind.rsi(14).rsi, RSI21: () => ind.rsi(21).rsi };
    for (const k of Object.keys(e.expect.signals)) {
      out[`signals.${k}`] = k === "E04" ? () => {
        const o = emittedOf(trialOf("m15.E04.F00"), s, plant);
        return { buy: o.filter((x) => x.d === "BUY").map((x) => x.i), sell: o.filter((x) => x.d === "SELL").map((x) => x.i) };
      } : () => new Skip(`not built: ${k}`);
    }
    return out;
  },
  "A.3.9": (e, plant) => {
    const ind = indOf(midSeries(e.input, plant), null, plant);
    const r = ind.rsi(14);
    return { up: () => r.up, dn: () => r.dn, U14: () => r.U, D14: () => r.D, RSI14: () => r.rsi, RSI7: () => ind.rsi(7).rsi, U14_eq_D14: () => Array.from(r.U, (u, k) => (Number.isNaN(u) ? null : u === r.D[k])) };
  },
  "A.3.14": (e, plant) => {
    const ind = indOf(midSeries(e.input, plant), null, plant);
    return Object.fromEntries([12, 26, 5, 35].map((p) => [`EMA${p}`, () => ind.ema(p)]));
  },
  "A.3.15": (e, plant) => emaFlat(e, plant),
  "A.3.16": (e, plant) => emaFlat(e, plant),
  "A.3.17": (e, plant) => emaFlat(e, plant),
  "A.3.18": (e, plant) => {
    const ind = indOf(midSeries(e.input, plant), null, plant);
    return Object.fromEntries([5, 20, 50].map((p) => [`EMA${p}`, () => ind.ema(p)]));
  },
  "A.3.19": (e, plant) => {
    // the table column is text ("15（p＋1）", "200", "—"): its leading integer ("—" is 0) must be the module's warm-up;
    // the item and filter names are labels (copied)
    const tableText = (text: string, w: number) => {
      const m = /^([0-9]+)/.exec(text);
      const n = m ? Number(m[1]) : text === "—" ? 0 : NaN;
      return n === w ? text : `the module's warm-up ${w}`;
    };
    const s = midSeries(e.input, plant);
    const ind = indOf(s, null, plant);
    const rowsE = e.expect.E as J[];
    const rowsF = e.expect.F as J[];
    const out: Record<string, Thunk> = {};
    rowsE.forEach((row, k) => {
      out[`E[${k}]`] = String(row.item).includes("E04") ? () => {
        const b = itemOf("E04").build(ind);
        const firstSig = Math.min(...b.cond.map((c) => c.findIndex((v) => v !== -1)));
        return { item: row.item, table: tableText(row.table, itemOf("E04").warmup), first_value_index: firstVal(ind.rsi(14).rsi), first_signal_index: firstSig, keep_from_index: trialWarmup(trialOf("m15.E04.F00")) };
      } : () => new Skip(`not built: ${row.item}`);
    });
    rowsF.forEach((row, k) => {
      const id = String(row.filter);
      out[`F[${k}]`] = id === "F00" || id.startsWith("F01") ? () => {
        const f = filterOf(id.startsWith("F01") ? "F01" : "F00");
        const fb = f.build(ind);
        return { ...row, table: tableText(row.table, f.warmup), first_value_index: fb.f[0].findIndex((v) => v !== -1), keep_from_index: f.warmup };
      } : () => new Skip(`not built: ${id}`);
    });
    return out;
  },
  "A.3.20": (e, plant) => {
    const s = midSeries(e.input, plant);
    const fb = filterOf("F01").build(indOf(s, null, plant), { ema: 5 });
    const ema = fb.columns.EMA200 as Float64Array;
    const usedExcluded: number[] = [];
    for (let i = 0; i < s.n; i++) if (fb.f[0][i] !== -1 && i < fb.warmup) usedExcluded.push(i);
    return {
      EMA5: () => ema, C_minus_EMA: () => Array.from(s.C, (c, k) => c - ema[k]), F01_buy: () => tri(fb.f[0]), F01_sell: () => tri(fb.f[1]),
      F01r_buy: () => new Skip("not built: F01r"), F01r_sell: () => new Skip("not built: F01r"), warmup_k: () => fb.warmup, F_value_used_signal_excluded_by_warmup_1_at: () => usedExcluded,
    };
  },
  "A.3.24": (e, plant) => {
    const ind = indOf(midSeries(e.input, plant), null, plant);
    return { TR: () => ind.tr(), ATR14: () => ind.atr(14), SMA5_ATR14: () => ind.smaOf(ind.atr(14), 5) };
  },
  "A.3.25": (e, plant) => ({ RSI14: () => indOf(midSeries(e.input, plant), null, plant).rsi(14).rsi }),
  "A.3.29": (e) => {
    const rows = e.input.after_step4 as J[];
    let dropped = 0;
    const kept: J[] = [];
    const droppedBars: J[] = [];
    for (const p of PAIRS) {
      const mine = rows.filter((r) => r.pair === p).sort((a, b) => a.i - b.i || b.d - a.d);
      const st = new Uint8Array(mine.length).fill(STATUS.indexOf("emit"));
      dropped += applyBoth(mine.map((r) => r.i), mine.map((r) => r.d), st);
      mine.forEach((r, k) => {
        if (st[k] === STATUS.indexOf("emit")) kept.push(r);
        else if (!droppedBars.some((x) => x.pair === p && x.i === r.i)) droppedBars.push({ pair: p, i: r.i });
      });
    }
    return { emitted: () => rows.filter((r) => kept.includes(r)), both_sides_dropped_signals: () => dropped, dropped: () => droppedBars, signals_after_step5_in_15_identity: () => kept.length };
  },
  "A.3.30": (e, plant) => {
    const s = midSeries(e.input, plant);
    const ind = indOf(s, null, plant);
    const off = e.expect.first_index_shown as number;
    return {
      // the arrays' first shown index (a presentation offset of the example, used to slice the values below)
      first_index_shown: () => off,
      EMA50: () => fromIdx(ind.ema(50), off), EMA200: () => fromIdx(ind.ema(200), off), C_minus_EMA200: () => fromIdx(Array.from(s.C, (x, k) => x - ind.ema(200)[k]), off),
      ATR14: () => fromIdx(ind.atr(14), off), SMA100_ATR14: () => fromIdx(ind.smaOf(ind.atr(14), 100), off),
      "first_value_index.EMA50": () => firstVal(ind.ema(50)), "first_value_index.EMA200": () => firstVal(ind.ema(200)), "first_value_index.SMA100_ATR14": () => firstVal(ind.smaOf(ind.atr(14), 100)),
    };
  },
};
function smaAdapter(e: J, plant: string): Record<string, Thunk> {
  const s = midSeries(e.input, plant);
  const sma = smaOldest(s.C, 20, plant);
  return { first_index_shown: () => firstVal(sma), SMA20: () => fromIdx(sma, e.expect.first_index_shown) };
}
function trAtr(e: J, plant: string, kTR: string, kATR: string, p: number): Record<string, Thunk> {
  const ind = indOf(midSeries(e.input, plant), null, plant);
  return { [kTR]: () => ind.tr(), [kATR]: () => ind.atr(p) };
}
function emaFlat(e: J, plant: string): Record<string, Thunk> {
  const ind = indOf(midSeries(e.input, plant), null, plant);
  const off = (e.expect.first_index_shown as number | undefined) ?? 0;
  const out: Record<string, Thunk> = { EMA12: () => fromIdx(ind.ema(12), off), EMA26: () => fromIdx(ind.ema(26), off) };
  if (e.expect.first_index_shown !== undefined) out.first_index_shown = () => firstVal(ind.ema(12));
  return out;
}

const G4: Record<string, Adapter> = {
  "A.4.1": (e, plant) => {
    const s = midSeries(e.input, plant);
    const don = indOf(s, null, plant).donchian(20);
    return { HH: () => don.HH, LL: () => don.LL, target_s: () => Array.from(don.s), signals: () => emittedOf(trialOf("m15.E26.F00"), s, plant) };
  },
  "A.4.2": (e, plant) => {
    const don = donchianOf(midSeries(e.input, plant), 55);
    return { HH: () => don.HH, LL: () => don.LL, target_s: () => Array.from(don.s), signals: () => new Skip("not built: E27") };
  },
  "A.4.3": (e, plant) => {
    const ind = indOf(midSeries(e.input, plant), null, plant);
    return { TR: () => ind.tr(), ATR10: () => ind.atr(10), EMA20: () => ind.ema(20) };
  },
  "A.4.9": (e, plant) => trAtr(e, plant, "TR", "ATR14", 14),
  "A.4.10": (e, plant) => {
    const ind = indOf(midSeries(e.input, plant), null, plant);
    return { TR15: () => ind.tr()[15], ATR14_14: () => ind.atr(14)[14] };
  },
  "A.4.29": (e, plant) => rsiUD(e, plant),
  "A.4.30": (e, plant) => rsiUD(e, plant),
  "A.4.26": (e, plant) => s01Out(e.expect, midSeries(e.input, plant), { ema: 5 }, plant),
  "A.4.27": (e, plant) => s01Out(e.expect, midSeries(e.input, plant), { ema: 10 }, plant),
  "A.4.41": (e, plant) => {
    const s = midSeries(e.input, plant);
    const v = e.expect.variant_150_010;
    const sv = seriesFromMid("USD/JPY", "m15", Array.from(s.s), Array.from({ length: s.n }, () => ["150.010", "150.010", "150.010", "150.010"]), plant);
    return {
      ...s01Out(e.expect, s, undefined, plant),
      alpha: () => 2 / (200 + 1),
      one_minus_alpha: () => 1 - 2 / (200 + 1),
      variant_150_010: async () => {
        const o = s01Out(v, sv, undefined, plant);
        const r: J = {};
        for (const [k, th] of Object.entries(o)) r[k] = await th();
        return r;
      },
    };
  },
  "A.4.32": (e, plant) => b06Out(e, plant),
  "A.4.33": (e, plant) => b06Out(e, plant),
  "A.4.34": (e, plant) => b06Out(e, plant),
  "A.4.36": (e, plant) => b06Out(e, plant),
  "A.4.40": (e, plant) => {
    const s = midSeries(e.input, plant);
    const params = bmParams(e.params);
    const o = { ...bigmoveDefault(s.step), ...params.bigmove };
    const ind = indOf(s, null, plant);
    const bm = ind.bigmove(o);
    const b = itemOf("B06").build(ind, params);
    const gaps: number[] = [];
    for (let k = 1; k < s.n; k++) if (bm.usable[k] === 0) gaps.push(k);
    return {
      gap_bars: () => gaps,
      sigma_first_index: () => firstVal(bm.sigma),
      key_bars: () => (e.expect.key_bars as J[]).map((kb) => {
        const i = kb.i as number;
        let cnt = 0;
        if (i >= o.sigmaWindow) for (let q = i - o.sigmaWindow; q < i; q++) cnt += bm.usable[q];
        const tr = (v: number) => (v === -1 ? null : v === 1);
        const full: J = {
          i, s: isoOf(s.s[i]), C: s.C[i], r: tol(bm.usable[i] === 1 ? bm.r[i] : null, "ln"), usable_r: i >= o.sigmaWindow ? cnt : null,
          sigma: tol(bm.sigma[i], "ln"), z: tol(bm.z[i], "ln"), cond_buy: tr(b.cond[0][i]), cond_sell: tr(b.cond[1][i]), T_excluded: b.keep![0][i] === 0,
        };
        return Object.fromEntries(Object.keys(kb).map((k) => [k, full[k]]));
      }),
      signals: () => emittedOf(trialOf("m15.B06"), s, plant, params).map((x) => ({ ...x, T: isoOf(s.T[x.i]) })),
    };
  },
};
function rsiUD(e: J, plant: string): Record<string, Thunk> {
  const r = indOf(midSeries(e.input, plant), null, plant).rsi(14);
  return { U: () => r.U, D: () => r.D, RSI14: () => r.rsi };
}
function s01Out(ex: J, s: Series, params: ItemParams | undefined, plant: string): Record<string, Thunk> {
  const fb = sFilterOf("S01").build(indOf(s, null, plant), params);
  const ema = fb.columns.EMA200 as Float64Array;
  const out: Record<string, Thunk> = {};
  if (ex.EMA) out.EMA = () => ema;
  if (ex.C_minus_EMA) out.C_minus_EMA = () => Array.from(s.C, (c, k) => c - ema[k]);
  if (ex.F_buy) out.F_buy = () => tri(fb.f[0]);
  if (ex.F_sell) out.F_sell = () => tri(fb.f[1]);
  if (ex.signals) out.signals = () => emittedOf(trialOf("m15.S01"), s, plant, params);
  if (ex.kept_after_warmup) out.kept_after_warmup = () => emittedOf(trialOf("m15.S01"), s, plant, params, true);
  if (ex.seed_sum !== undefined) out.seed_sum = () => {
    let sum = 0;
    for (let k = 0; k < 200; k++) sum += s.C[k];
    return sum;
  };
  return out;
}
function b06Out(e: J, plant: string): Record<string, Thunk> {
  const s = midSeries(e.input, plant);
  const params = bmParams(e.params);
  const o = { ...bigmoveDefault(s.step), ...params.bigmove };
  const bm = indOf(s, null, plant).bigmove(o);
  const b = itemOf("B06").build(indOf(s, null, plant), params);
  const trial = trialOf(s.key === "m15" ? "m15.B06" : "h1.B06");
  return {
    r: () => tol(Array.from(bm.r, (v, k) => (bm.usable[k] === 1 ? v : NaN)), "ln"),
    sigma: () => tol(bm.sigma, "ln"),
    z: () => tol(bm.z, "ln"),
    cond_buy: () => tri(b.cond[0]),
    cond_sell: () => tri(b.cond[1]),
    T_excluded: () => Array.from(b.keep![0], (k) => k === 0),
    signals: () => emittedOf(trial, s, plant, params).map((x) => ({ ...x, T: isoOf(s.T[x.i]) })),
  };
}

// ---- group 2: the measures (builder C's lawsearch-trade.ts, lawsearch-stats.ts) ------------------------------------
//
// Every example of group 2 gives its blind table as numbers (blindFromRows) or as bars (blindTable / lateTable on a
// series built from the example), and its signals as (pair, T, d). The adapters call the module functions only; what
// they add is the example's presentation (labels, ISO times, the order of a listing = the example's input order).

const SEASON_JA = ["両方冬", "両方夏", "NYだけ夏", "ロンドンだけ夏"];
// a blind table from the example's blind rows, and the table rows of its signals (absent ones counted)
const tableOf = (inp: J, late = false) => {
  const t = blindFromRows(TF_OF[inp.tf], "first", late, (inp.blind as J[]).map((b) => ({ pi: piOf(b.pair), T: ms(b.T), m: b.m, plBuy: b.pl_buy, plSell: b.pl_sell })));
  const { rows, absent } = rowsIn(t, (inp.signals ?? []) as J[]);
  return { t, rows, absent };
};
// the rows of an example's signals in a table (ascending = 21.5's row order), and the signals without one
const rowsIn = (t: BlindTable, sigs: J[]) => {
  const found: number[] = [];
  const absent: J[] = [];
  for (const x of sigs) {
    const r = t.index.get(rowKey(piOf(x.pair), ms(x.T), x.d));
    if (r === undefined) absent.push(x);
    else found.push(r);
  }
  return { rows: Int32Array.from(found.sort((a, b) => a - b)), absent };
};
const stratumKey = (id: number) => ({ pair: PAIRS[Math.floor(id / 192)], d: Math.floor(id / 96) % 2 === 0 ? 1 : -1, hour: Math.floor(id / 4) % 24, season: SEASON_JA[id % 4] });
const strataRows = (t: BlindTable, rows: Int32Array, plant: string) =>
  strataOf(t, rows, plant).strata.filter((x) => x.n > 0).map((x) => ({ stratum: stratumKey(x.id), n_s: x.n, m_s: x.m, B_s: x.B, signal_mean_h_half: x.sigMean }));
// a cluster's S_g map as the examples write it ({"2817": …})
const sumsObj = (m: Map<number, number>) => Object.fromEntries([...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));
const seOfKind = (v: ValueEst, kind: SeCand["kind"]) => v.cands.find((c) => c.kind === kind)?.se ?? null;
// spec 8–11's "> 0" (the zero rule of 8.5 first)
const gt0 = (x: number | null) => x !== null && !isZero(x) && x > 0;
// a candidate list and the choices (8.5) as the examples write them: se, t exact; p by p; t(0.975), the half width
// and the ends by q (lawsearch-dump.md 9)
const candRows = (v: { cands: SeCand[] }) =>
  v.cands.map((c) => ({ label: KIND_JA[c.kind], se: c.se, C: c.C, df: c.df, K: c.K, t: c.t, p: tol(c.p, "p"), t975: tol(c.q975, "q"), half_width: tol(c.halfWidth, "q") }));
const choiceOf = (v: Pick<ValueEst, "hasT" | "useLB" | "useP" | "t" | "p" | "lb" | "ub"> & { cands: SeCand[] }) => ({
  candidates: candRows(v),
  interval_from: v.useLB ? KIND_JA[v.useLB] : null,
  p_from: v.useP ? KIND_JA[v.useP] : null,
  p: tol(v.p, "p"),
  t: v.t,
  lb: tol(v.lb, "q"),
  ub: tol(v.ub, "q"),
  lower: tol(v.lb, "q"),
  upper: tol(v.ub, "q"),
  has_t: v.hasT,
  no_t_candidates: v.cands.filter((c) => c.t === null).map((c) => KIND_JA[c.kind]),
});
// rule 3 of spec 10 by the select module itself (rules 1, 2 passed; rule 4 onwards cannot be reached first)
const rule3Ok = (v: ValueEst) =>
  failRuleOf({ id: "x", tf: "m15", order: 1, f: null, isS: false, directionalF: false, passFloor: true, same: false, checksOk: true, hasT: v.hasT, delta: v.value, lb: v.lb, pl: 1, plEx1w: 1, dF: null, suspicious: false, suspiciousChecksPassed: null, n: v.N, group: "x" }, "a") !== 3;
// the counted signals of one half as a trial's Classified rows (every row counted, in the half), for trialRows
const countedSigs = (tf: TfKey, half: "first" | "second", sigs: ReadonlyArray<{ pi: number; T: number; d: number; X: number }>) => {
  const code = half === "first" ? 1 : 2;
  const COUNTED = REASONS.indexOf("counted");
  return {
    trial: { id: "hand", order: 0, tf, kind: "EF" as TrialKind, e: null, f: null, s: null, b: null, name: "hand" },
    tf,
    pairs: PAIRS.map((_, pi) => {
      const mine = sigs.filter((s) => s.pi === pi);
      const n = mine.length;
      return {
        trial: "hand", tf, pi, n,
        i: new Int32Array(n).fill(-1), d: Int8Array.from(mine.map((s) => s.d)), status: new Uint8Array(n), warmOk: new Uint8Array(n).fill(1),
        T: Float64Array.from(mine.map((s) => s.T)), X: Float64Array.from(mine.map((s) => s.X)),
        reason: new Uint8Array(n).fill(COUNTED), half: new Uint8Array(n).fill(code),
      };
    }),
  };
};
const sigsOf = (xs: J[], tf: TfKey, nBars = N_BARS) => xs.map((x) => ({ pi: piOf(x.pair), T: ms(x.T), d: x.d as number, X: ms(x.T) + nBars * STEP[tf] }));
const emptySeries = (pi: number, tf: TfKey) => seriesOf(PAIRS[pi], tf, emptyBars(0));
const fiveOf = (tf: TfKey, given: Record<number, Series>) => PAIRS.map((_, pi) => given[pi] ?? emptySeries(pi, tf));
const sigItem = (x: { pi: number; T: number; d: number }) => ({ pair: PAIRS[x.pi], T: isoOf(x.T), d: x.d });
// the example's listing order: the position of (pair, T, d) in its input signals
const orderBy = (sigs: J[]) => {
  const pos = new Map<number, number>();
  sigs.forEach((x, q) => pos.set(rowKey(piOf(x.pair), ms(x.T), x.d), q));
  return (t: BlindTable, r: number) => pos.get(rowKey(t.pi[r], t.T[r], t.d[r] as 1 | -1)) ?? 1e9 + r;
};
// the week shifts of spec 8.5 as the examples list them (k = 1 … W_h − 1): the module's ShiftRun of each value (N_k,
// dropped, the value; null when skipped), and shiftMap's moves for the lists (in the example's order). droppedList:
// the example writes "dropped" as the list of dropped signals (else as the count, with "dropped_list").
const shiftsOut = (t: BlindTable, rows: Int32Array, plant: string, runs: Record<string, ShiftRun | null>, pos: (t: BlindTable, r: number) => number, droppedList: boolean) => {
  const first = Object.values(runs).find((x) => x !== null) ?? null;
  const nk = Math.max(0, t.weeks.length - 1);
  const out: J[] = [];
  for (let k = 1; k <= nk; k++) {
    const m = shiftMap(t, rows, k, plant);
    const moved: Array<{ p: number; v: J }> = [];
    const dropped: Array<{ p: number; v: J }> = [];
    for (let q = 0; q < m.from.length; q++) {
      const r = m.from[q];
      const T2 = Number.isNaN(m.T2[q]) ? null : isoOf(m.T2[q]);
      const base = { pair: PAIRS[t.pi[r]], T: isoOf(t.T[r]), d: t.d[r], T_shifted: T2, shifted_T: T2 };
      const r2 = m.to[q];
      if (r2 < 0) dropped.push({ p: pos(t, r), v: base });
      else moved.push({ p: pos(t, r), v: { ...base, h: t.h[r2], late_hour: t.hour[r2], season_from: SEASON_JA[t.season[r]], season_to: SEASON_JA[t.season[r2]] } });
    }
    const byPos = (a: { p: number }, b: { p: number }) => a.p - b.p;
    const row: J = { k, N_k: first ? first.n[k - 1] : null, dropped: first ? first.dropped[k - 1] : null };
    if (droppedList) row.dropped = dropped.sort(byPos).map((x) => x.v);
    else row.dropped_list = dropped.sort(byPos).map((x) => x.v);
    row.moved = moved.sort(byPos).map((x) => x.v);
    for (const [name, run] of Object.entries(runs)) row[name] = run === null || Number.isNaN(run.v[k - 1]) ? null : run.v[k - 1];
    out.push(row);
  }
  return out;
};
const droppedIsList = (shifts: J): boolean => Array.isArray(shifts) && shifts.some((s: J) => Array.isArray(s.dropped));
const kUnused = (run: ShiftRun | null) => (run ? Array.from(run.k).filter((_, q) => Number.isNaN(run.v[q])) : []);
// a trade of spec 7 / 8.8 as the examples write it (s: the series the trade's j and x index)
const tradeRow = (s: Series, tr: { j: number; x: number; subst: boolean | number; m: number; h: number; pl: number } | null, d: number) =>
  tr === null ? "excluded" : {
    entry_bar_start: isoOf(s.s[tr.j]), exit_bar_start: isoOf(s.s[tr.x]), exit_is_substitute: tr.subst === true || tr.subst === 1,
    Po: s.Po[tr.j], Pc: s.Pc[tr.x], m: tr.m, h: tr.h, entry_price_pts: d === 1 ? s.Ao[tr.j] : s.Bo[tr.j], exit_price_pts: d === 1 ? s.Bc[tr.x] : s.Ac[tr.x], pl: tr.pl,
  };
const lateRowTrade = (late: BlindTable, pi: number, T: number, d: 1 | -1) => {
  const r = late.index.get(rowKey(pi, T, d));
  return r === undefined ? null : { j: late.j[r], x: late.x[r], subst: late.subst[r], m: late.m[r], h: late.h[r], pl: late.pl[r] };
};
const dKey = (T: number, d: number) => `${isoOf(T)} ${d === 1 ? "+1" : "-1"}`;
const LATE_WHY_JA: Readonly<Record<number, string>> = { 1: "遅れた入りの足が無い", 2: "④（X＋15分）", 3: "期間の終わり" };
// the bars of a base table that its late table (from rows) leaves out, with the clock's reason (trialRows' reading
// for a late table without reasons: ④ at X + 15 min, else no late entry)
const lateOutBars = (base: BlindTable, late: BlindTable, nBars: number) => {
  const out: Array<{ T: number; why: 1 | 2 }> = [];
  for (let r = 0; r < base.n; r += 2) {
    if (late.index.has(rowKey(base.pi[r], base.T[r], 1))) continue;
    const X = base.T[r] + nBars * STEP[base.tf];
    out.push({ T: base.T[r], why: r4(base.T[r], X + LATE_MS) ? 2 : 1 });
  }
  return out;
};
// the influence rows of spec 8.5 in row order (a signal row before its blind row); blindAll: every blind row, else
// the blind rows of strata with signals
const influenceRows = (t: BlindTable, rows: Int32Array, plant: string, blindAll: boolean) => {
  const fd = influenceOf(t, rows, "delta", plant);
  const fp = influenceOf(t, rows, "pl", plant);
  const st = new Map(strataOf(t, rows, plant).strata.map((x) => [x.id, x]));
  const out: J[] = [];
  for (let r = 0; r < t.n; r++) {
    const head = { pair: PAIRS[t.pi[r]], T: isoOf(t.T[r]), d: t.d[r], week: t.week[r] };
    const s = st.get(t.stratum[r]);
    if (fd.isSig[r] === 1) out.push({ kind: "signal", ...head, infl_delta: fd.sig[r], infl_pl: fp.sig[r], d_i: t.h[r] / 2 - (s ? s.B : NaN) });
    if (blindAll || (s && s.n > 0)) out.push({ kind: "blind", ...head, infl_delta: (fd.blind as Float64Array)[r], infl_pl: 0 });
  }
  return out;
};
// a table of bars from the example's rows {pair, T, flags/late {m, pl_buy, pl_sell}}
const lateRowsOf = (bars: J[]) => bars.filter((b) => b.ordinary_trade && b.late).map((b) => ({ pi: piOf(b.pair), T: ms(b.T), m: b.late.m, plBuy: b.late.pl_buy, plSell: b.late.pl_sell }));
const baseRowsOf = (bars: J[]) => bars.filter((b) => b.ordinary_trade).map((b) => ({ pi: piOf(b.pair), T: ms(b.T), m: b.late?.m ?? 0, plBuy: b.late?.pl_buy ?? 0, plSell: b.late?.pl_sell ?? 0 }));
// the 1st and 2nd parts of A.2.29 and the like: Δ (with a and PL) and its SE pieces on one table
const deltaPart = (t: BlindTable, rows: Int32Array, w0: number, plant: string, exShifts: J) => {
  const o = { w0, shift: true, plant };
  const d = estDelta(t, rows, o);
  const pl = estPl(t, rows, o);
  return {
    d, pl,
    out: {
      N: d.N, delta: d.value, a: aOf(t, rows), pl_mean_pips: pl.value, strata: strataRows(t, rows, plant),
      week_S_g_delta: sumsObj(d.sums.week), week_S_g_pl: sumsObj(pl.sums.week), C_week: d.C_week, se_week_delta: seOfKind(d, "week"), se_week_pl: seOfKind(pl, "week"),
      C_4week: d.C_4w, use_4week: d.four, weeks_with_blind: Array.from(t.weeks), W_h: t.weeks.length,
      K: d.shift?.used ?? null, sd_shift_delta: d.shift?.sd ?? null, sd_shift_pl: pl.shift?.sd ?? null, k_unused_N0: kUnused(d.shift),
      delta_has_t: d.hasT, p_delta: tol(d.p, "p"), lb: tol(d.lb, "q"), ub: tol(d.ub, "q"), pl_has_t: pl.hasT, p_pl: tol(pl.p, "p"),
      selectable_rule3: rule3Ok(d), delta_choice: choiceOf(d), pl_choice: choiceOf(pl),
      shifts: shiftsOut(t, rows, plant, { delta_k: d.shift, pl_k_pips: pl.shift }, () => 0, droppedIsList(exShifts)),
    } as J,
  };
};
// Δ_late and its SE pieces on a late table (A.2.26, A.2.32 part 2)
const latePart = (late: BlindTable, lateRows: Int32Array, w0: number, plant: string, exShifts: J, pos: (t: BlindTable, r: number) => number) => {
  const d = estDelta(late, lateRows, { w0, shift: true, plant });
  const pl = plOf(late, lateRows);
  return {
    d,
    out: {
      late_blind_bars: late.n / 2, N: d.N, delta_late: d.value, pl_late_pips: pl, strata: strataRows(late, lateRows, plant),
      week_S_g_delta_late: sumsObj(d.sums.week), C_week: d.C_week, se_week: seOfKind(d, "week"), C_4week: d.C_4w, use_4week: d.four,
      weeks_with_blind: Array.from(late.weeks), weeks_with_late_blind: Array.from(late.weeks), W_h: late.weeks.length,
      shifts: shiftsOut(late, lateRows, plant, { delta_k: d.shift }, pos, droppedIsList(exShifts)),
      k_unused_N0: kUnused(d.shift), K: d.shift?.used ?? null, sd_shift: d.shift?.sd ?? null, choice: choiceOf(d),
      C4_lower_gt_0: gt0(d.lb), pl_late_gt_0: gt0(pl),
    } as J,
  };
};
// the 12-significant-digit strings of A.2.12 and A.2.31: Python's "%.12g" of the double (compared as numbers: the
// text keeps or drops trailing zeros)
const sig12 = (x: number) => new Sig12(x);
const qOf = (s: string) => (s === "1-0.025/6" ? 1 - 0.025 / 6 : Number(s));
// the series of an example's bars {s, bid[4], ask[4]}
const seriesOfBars = (pair: string, tf: TfKey, bars: J[]) => seriesOf(pair as Pair, tf, barsOfRows(bars));
const flatBars = (from: string, to: string, step: number) => {
  const out: J[] = [];
  for (let t = ms(from); t <= ms(to); t += step) out.push({ s: isoOf(t), bid: ["150.000", "150.010", "149.990", "150.000"], ask: ["150.002", "150.012", "149.992", "150.002"] });
  return out;
};

const G2: Record<string, Adapter> = {
  "A.2.1": (e, plant) => {
    const { t, rows } = tableOf(e.input);
    const x = plExtras(t, rows);
    return {
      strata: () => strataRows(t, rows, plant),
      N: () => strataOf(t, rows, plant).N,
      delta: () => deltaOf(t, rows, plant),
      a: () => aOf(t, rows),
      signals_dropped_no_blind: () => strataOf(t, rows, plant).noBlind,
      pl_mean_pips: () => plOf(t, rows),
      W_count: () => x.wCount,
      W_rate: () => x.wRate,
      blind_pl_weighted_pips: () => x.blindPlW,
      pl_minus_blind_pips: () => x.plMinusBlind,
      pl_by_pair_pips: () => Object.fromEntries(PAIRS.map((p, k) => [p, x.plByPair[k]]).filter(([, v]) => v !== null)),
      pl_by_direction_pips: () => ({ buy: x.plByDir[0], sell: x.plByDir[1] }),
    };
  },
  "A.2.2": (e, plant) => {
    const inp = e.input;
    const { t } = tableOf(inp);
    const late = blindFromRows("m15", "first", true, []);
    // USD/JPY's 15-minute bars 2024-01-09 10:00–11:15 (the stop case's 10:00 signal has an entry bar; nothing starts
    // in [11:30, 13:30), so the 11:30 signal and the 11:30 blind bar have no trade)
    const uj = seriesOfBars("USD/JPY", "m15", flatBars("2024-01-09T10:00:00Z", "2024-01-09T11:15:00Z", STEP.m15));
    const series = fiveOf("m15", { 0: uj });
    const sigs = sigsOf(inp.signals, "m15");
    const tr = trialRows(t, late, countedSigs("m15", "first", sigs), "first", series, plant);
    const ex = sigsOf([inp.stop_case.extra_signal], "m15");
    const tr2 = trialRows(t, late, countedSigs("m15", "first", [...sigs, ...ex]), "first", series, plant);
    return {
      no_trade_signals: () => tr.noTrade,
      no_trade_signals_list: () => trialRowsExtra(tr)!.noTradeList.map(sigItem),
      // the given bars that passed ①–⑥: no trade either way (spec 7) and so no row of the table (8.1)
      blind_no_trade_bars: () => (inp.blind_no_trade_bars as J[]).filter((b) => {
        const pi = piOf(b.pair);
        const T = ms(b.T);
        const X = T + N_BARS * STEP.m15;
        return tradeOf(series[pi], T, X, 1, plant) === null && tradeOf(series[pi], T, X, -1, plant) === null && !t.index.has(rowKey(pi, T, 1));
      }).length,
      signals_dropped_no_blind: () => tr.noBlind,
      strata: () => strataRows(t, tr.rows, plant),
      N: () => tr.rows.length,
      delta: () => deltaOf(t, tr.rows, plant),
      a: () => aOf(t, tr.rows),
      pl_mean_pips: () => plOf(t, tr.rows),
      W_count: () => plExtras(t, tr.rows).wCount,
      W_rate: () => plExtras(t, tr.rows).wRate,
      stop_case: () => {
        let stops = false;
        try {
          measureTrial(t, late, tr2, { w0: W0.first, plant, dF: null });
        } catch (err) {
          stops = String((err as Error).message).startsWith("STOP:");
        }
        return { stops, signals_no_blind: tr2.noBlind };
      },
    };
  },
  "A.2.3": (e) => {
    // one blind row per signal (its pl as the buy PL); the weeks' sums in points
    const sigs = e.input.signals as J[];
    const t = blindFromRows(TF_OF[e.input.tf], "first", false, sigs.map((x) => ({ pi: piOf(x.pair), T: ms(x.T), m: 1, plBuy: x.pl, plSell: -x.pl })));
    const rows = Int32Array.from(sigs.map((x) => t.index.get(rowKey(piOf(x.pair), ms(x.T), x.d))!).sort((a, b) => a - b));
    const x = plExtras(t, rows);
    const sums: Record<string, number> = {};
    for (const r of rows) sums[String(t.week[r])] = (sums[String(t.week[r])] ?? 0) + t.pl[r];
    return {
      pl_mean_pips: () => plOf(t, rows),
      week_pl_sum_points: () => sums,
      excluded_week: () => x.ex1wWeek,
      pl_ex1week_pips: () => x.plEx1w,
      n_after: () => Array.from(rows).filter((r) => t.week[r] !== x.ex1wWeek).length,
    };
  },
  "A.2.4": (e, plant) => {
    const { t, rows } = tableOf(e.input);
    const o = { w0: e.input.w0 as number, shift: true, plant };
    const d = estDelta(t, rows, o);
    const pl = estPl(t, rows, o);
    return {
      delta: () => d.value,
      pl_mean_pips: () => pl.value,
      N: () => d.N,
      influence: () => influenceRows(t, rows, plant, true),
      week_S_g_delta: () => sumsObj(d.sums.week),
      week_S_g_pl: () => sumsObj(pl.sums.week),
      C_week: () => d.C_week,
      se_week_delta: () => seOfKind(d, "week"),
      se_week_pl: () => seOfKind(pl, "week"),
      C_4week: () => d.C_4w,
      use_4week: () => d.four,
      weeks_with_blind: () => Array.from(t.weeks),
      W_h: () => t.weeks.length,
      shifts: () => shiftsOut(t, rows, plant, { delta_k: d.shift, pl_k_pips: pl.shift }, orderBy(e.input.signals), droppedIsList(e.expect.shifts)),
      sd_shift_delta: () => d.shift?.sd ?? null,
      sd_shift_pl: () => pl.shift?.sd ?? null,
      delta_choice: () => choiceOf(d),
      pl_choice: () => choiceOf(pl),
    };
  },
  "A.2.5": (e, plant) => {
    const { t, rows } = tableOf(e.input);
    const o = { w0: e.input.w0 as number, shift: true, plant };
    const d = estDelta(t, rows, o);
    const pl = estPl(t, rows, o);
    const pos = orderBy(e.input.signals);
    return {
      strata: () => strataRows(t, rows, plant),
      N: () => d.N,
      delta: () => d.value,
      pl_mean_pips: () => pl.value,
      C_week: () => d.C_week,
      se_week_delta: () => seOfKind(d, "week"),
      se_week_pl: () => seOfKind(pl, "week"),
      blocks_4week: () => sumsObj(d.sums.four),
      C_4week: () => d.C_4w,
      use_4week: () => d.four,
      se_4week_delta: () => seOfKind(d, "4w"),
      se_4week_pl: () => seOfKind(pl, "4w"),
      weeks_with_blind: () => Array.from(t.weeks),
      W_h: () => t.weeks.length,
      shifts: () => shiftsOut(t, rows, plant, { delta_k: d.shift, pl_k_pips: pl.shift }, pos, droppedIsList(e.expect.shifts)),
      // the signals whose shifted row (k = 1) is in another season group than their own (8.5: the found row's stratum)
      restratified_at_k1: () => (shiftsOut(t, rows, plant, { delta_k: d.shift }, pos, false)[0]?.moved ?? [])
        .filter((m: J) => m.season_from !== m.season_to)
        .map((m: J) => ({ T: m.T, shifted_T: m.shifted_T, d: m.d, season_from: m.season_from, season_to: m.season_to })),
      sd_shift_delta: () => d.shift?.sd ?? null,
      sd_shift_pl: () => pl.shift?.sd ?? null,
      delta_choice: () => choiceOf(d),
      pl_choice: () => choiceOf(pl),
    };
  },
  "A.2.6": (e, plant) => {
    const { t, rows } = tableOf(e.input);
    const d = estDelta(t, rows, { w0: W0.first, shift: true, plant });
    return {
      N: () => d.N,
      delta: () => d.value,
      strata: () => strataRows(t, rows, plant),
      week_S_g_delta: () => sumsObj(d.sums.week),
      C_week: () => d.C_week,
      se_week_delta: () => seOfKind(d, "week"),
      df_week: () => d.cands.find((c) => c.kind === "week")?.df ?? null,
    };
  },
  "A.2.7": (e) => ({
    cases: () => (e.input.cases as J[]).map((c) => {
      const KIND: Record<string, SeCand["kind"]> = { "週": "week", "4週": "4w", "週ずらし": "shift" };
      // the shift candidate is given with its se (K ≥ 2 is implied: it has a t)
      const cands: SeCand[] = (c.candidates as J[]).map((w) => ({ kind: KIND[w.label], se: w.se, C: w.df + 1, df: w.df, K: KIND[w.label] === "shift" ? 2 : null, t: null, p: 1, q975: null, halfWidth: null }));
      const ch = choose(c.estimate, 100, cands);
      return { case: c.case, ...choiceOf({ ...ch, cands }) };
    }),
  }),
  "A.2.8": (e, plant) => g2Small(e, plant),
  "A.2.9": (e, plant) => g2Small(e, plant),
  "A.2.10": (e, plant) => {
    const { t, rows } = tableOf(e.input);
    const d = estDelta(t, rows, { w0: W0.first, shift: true, plant });
    return {
      strata: () => strataRows(t, rows, plant),
      N: () => d.N,
      delta_double: () => d.value,
      delta_treated_as_zero: () => isZero(d.value as number),
      delta_gt_0: () => gt0(d.value),
      eligible_rule3: () => rule3Ok(d),
    };
  },
  "A.2.11": (e, plant) => {
    const { t, rows } = tableOf(e.input);
    const d = estDelta(t, rows, { w0: W0.first, shift: true, plant });
    return {
      strata: () => strataRows(t, rows, plant),
      N: () => d.N,
      delta: () => d.value,
      week_S_g_delta: () => sumsObj(d.sums.week),
      C_week: () => d.C_week,
      se_week_double: () => seOfKind(d, "week"),
      se_week_treated_as_zero: () => isZero(seOfKind(d, "week") as number),
      C_4week: () => d.C_4w,
      use_4week: () => d.four,
      shifts: () => shiftsOut(t, rows, plant, { delta_k: d.shift }, orderBy(e.input.signals), droppedIsList(e.expect.shifts)),
      sd_shift_delta: () => d.shift?.sd ?? null,
      delta_choice: () => choiceOf(d),
      selectable_rule3: () => rule3Ok(d),
      // the rows of week 2819 in row order (a signal row, then the blind rows of strata with signals)
      week_2819_rows_delta: () => influenceRows(t, rows, plant, false).filter((x) => x.week === 2819),
    };
  },
  "A.2.12": (e) => ({
    quantiles: () => (e.expect.quantiles as J[]).map((w) => {
      const v = tq(qOf(w.q), w.df);
      return { q: w.q, df: w.df, value_12sig: sig12(v), double: tol(v, "q") };
    }),
    cdf: () => (e.expect.cdf as J[]).map((w) => {
      const T = tCdf(w.x, w.df);
      const p = pOneSided(w.x, w.df);
      return { x: w.x, df: w.df, T_12sig: sig12(T), T_double: tol(T, "q"), p_double: tol(p, "p"), p_12sig: sig12(p) };
    }),
  }),
  "A.2.13": (e, plant) => dfAdapter(e, plant),
  "A.2.25": (e, plant) => dfAdapter(e, plant),
  "A.2.14": (e, plant) => {
    const inp = e.input;
    const s = seriesOfBars("USD/JPY", "m15", inp.bars);
    const tfs = tfSetOf("m15", fiveOf("m15", { 0: s }));
    const blindT = new Set((inp.blind_bars_T as string[]).map(ms));
    const passing = tfs.pairs.map((p) => Uint8Array.from(Array.from(p.T, (T) => (p.pi === 0 && blindT.has(T) ? 1 : 0))));
    const base = blindTable(tfs, "first", passing, plant);
    const late = lateTable(base, tfs, SPLIT, plant);
    const sigs = sigsOf(inp.signals, "m15");
    const tr = trialRows(base, late, countedSigs("m15", "first", sigs), "first", tfs.pairs, plant);
    const lateOut = trialRowsExtra(tr)!.lateOut;
    return {
      late_trades_signals: () => Object.fromEntries(sigs.map((x) => [dKey(x.T, x.d), tradeRow(s, lateRowTrade(late, x.pi, x.T, x.d as 1 | -1), x.d)])),
      late_trades_blind: () => Object.fromEntries([...blindT].sort((a, b) => a - b).flatMap((T) => [1, -1].map((d) => [dKey(T, d), tradeRow(s, lateRowTrade(late, 0, T, d as 1 | -1), d)]))),
      excluded_from_delta_late: () => lateOut.map((x) => ({ ...sigItem(x), X_plus_15: isoOf(x.T + N_BARS * STEP.m15 + LATE_MS), friday_21: x.why === 2 ? isoOf(firstFriday2100(x.T)) : null })),
      n_excluded: () => tr.lateExcluded.noEntry + tr.lateExcluded.r4 + tr.lateExcluded.end,
      strata: () => strataRows(late, tr.lateRows, plant),
      N: () => tr.lateRows.length,
      delta_late: () => deltaOf(late, tr.lateRows, plant),
      pl_late_mean_pips: () => plOf(late, tr.lateRows),
      normal_trades: () => Object.fromEntries(sigs.map((x) => [dKey(x.T, x.d), tradeRow(s, tradeOf(s, x.T, x.X, x.d as 1 | -1, plant), x.d)])),
      // the late table counts rows (2 per bar: both directions are left out together); the example counts bars
      late_excluded_by_4: () => ({ signals: tr.lateExcluded.r4, blind_bars: late.lateExcluded.r4 / 2 }),
      late_excluded_no_late_entry: () => ({ signals: tr.lateExcluded.noEntry, blind_bars: late.lateExcluded.noEntry / 2 }),
    };
  },
  "A.2.15": (e, plant) => {
    const inp = e.input;
    const m15 = seriesOfBars(inp.pair, "m15", inp.bars_15min);
    const h1 = seriesOfBars(inp.pair, "h1", inp.bars_1hour);
    const T = ms(inp.signal.T);
    const d = inp.signal.d as 1 | -1;
    // the example's N is 2 (its params), not the trial's 8
    const X = T + (e.params.N as number) * STEP.h1;
    return {
      X: () => isoOf(X),
      X_plus_15: () => isoOf(X + LATE_MS),
      late_stratum_hour: () => hourOf(T + LATE_MS),
      late_trade: () => tradeRow(m15, lateTradeOf(m15, T, X, d), d),
      normal_trade_1hour: () => tradeRow(h1, tradeOf(h1, T, X, d, plant), d),
    };
  },
  "A.2.24": (e, plant) => {
    // flat bars of USD/JPY on 2024-12-24: 15-minute 11:00–21:00 (starts), 1-hour 11:00–20:00
    const m15 = tfSetOf("m15", fiveOf("m15", { 0: seriesOfBars("USD/JPY", "m15", flatBars("2024-12-24T11:00:00Z", "2024-12-24T21:00:00Z", STEP.m15)) }));
    const h1 = tfSetOf("h1", fiveOf("h1", { 0: seriesOfBars("USD/JPY", "h1", flatBars("2024-12-24T11:00:00Z", "2024-12-24T20:00:00Z", STEP.h1)) }));
    return {
      trials: () => (e.input.trials as J[]).map((t0) => {
        const tf = TF_OF[t0.tf];
        const set = tf === "m15" ? m15 : h1;
        const sigs = sigsOf(t0.signals, tf);
        // the bars pass ①–③, ⑤, ⑥ (the example); ④ is the module's on [T, X)
        const pass = new Set(sigs.filter((x) => !r4(x.T, x.X)).map((x) => x.T));
        const passing = set.pairs.map((p) => Uint8Array.from(Array.from(p.T, (T) => (p.pi === 0 && pass.has(T) ? 1 : 0))));
        const base = blindTable(set, "first", passing, plant);
        const late = lateTable(base, m15, SPLIT, plant);
        const counted = sigs.filter((x) => pass.has(x.T));
        const tr = trialRows(base, late, countedSigs(tf, "first", counted), "first", set.pairs, plant);
        return {
          tf: t0.tf,
          signals: sigs.map((x) => ({
            ...sigItem(x), X: isoOf(x.X), X_plus_15: isoOf(x.X + LATE_MS),
            counted: base.index.has(rowKey(x.pi, x.T, x.d as 1 | -1)), reason_4: r4(x.T, x.X) ? "④" : null,
            late: late.index.has(rowKey(x.pi, x.T, x.d as 1 | -1)) ? "in" : "excluded",
          })),
          n_excluded_from_delta_late: tr.lateExcluded.noEntry + tr.lateExcluded.r4 + tr.lateExcluded.end,
        };
      }),
    };
  },
  "A.2.26": (e, plant) => {
    const inp = e.input;
    const nBars = e.params.N as number;
    const bb = inp.blind_bars as J[];
    // the example gives flags, not bars: the normal table holds the bars with an ordinary trade, the late table those
    // with a late trade too (both with the late m and PL; the normal values are not used by Δ_late)
    const base = blindFromRows("m15", "first", false, baseRowsOf(bb));
    const late = blindFromRows("m15", "first", true, lateRowsOf(bb));
    const sigs = sigsOf(inp.signals, "m15", nBars);
    const tr = trialRows(base, late, countedSigs("m15", "first", sigs), "first", fiveOf("m15", {}), plant);
    const lo = trialRowsExtra(tr)!.lateOut;
    const lp = latePart(late, tr.lateRows, inp.w0, plant, e.expect.shifts, orderBy(inp.signals));
    const outBars = lateOutBars(base, late, nBars);
    return {
      late_excluded_no_late_entry: () => ({
        signals: tr.lateExcluded.noEntry,
        signals_list: lo.filter((x) => x.why === 1).map(sigItem),
        blind_bars: outBars.filter((x) => x.why === 1).length,
        blind_bars_list: outBars.filter((x) => x.why === 1).map((x) => isoOf(x.T)),
      }),
      not_in_8_1_table: () => bb.filter((b) => !base.index.has(rowKey(piOf(b.pair), ms(b.T), 1))).map((b) => isoOf(ms(b.T))),
      ...Object.fromEntries(Object.keys(lp.out).map((k) => [k, () => lp.out[k]])),
    };
  },
  "A.2.28": (e) => {
    const inp = e.input;
    const withTrade = (inp.signals as J[]).filter((s) => s.trade);
    // one buy row per signal with a trade (m = h, the buy PL given); the signal without a trade has no row
    const t = blindFromRows("m15", "first", false, withTrade.map((s) => ({ pi: piOf(s.pair), T: ms(s.T), m: s.h, plBuy: s.pl, plSell: 0 })));
    const { rows, absent } = rowsIn(t, inp.signals);
    const nov = nonOverlap(t, rows, inp.N);
    const kept = new Set(Array.from(nov.rows));
    return {
      kept: () => Array.from(nov.rows, (r) => isoOf(t.T[r])),
      removed: () => Array.from(rows).filter((r) => !kept.has(r)).map((r) => isoOf(t.T[r])),
      no_trade_neither: () => absent.map((x) => isoOf(ms(x.T))),
      pl_mean_pips_counted_with_trade: () => plOf(t, rows),
      pl_mean_pips_non_overlapping: () => nov.pl,
    };
  },
  "A.2.29": (e, plant) => {
    const inp = e.input;
    const part = (k: "part1" | "part2") => {
      const t = blindFromRows(TF_OF[inp.tf], "first", false, (inp[`${k}_blind`] as J[]).map((b) => ({ pi: piOf(b.pair), T: ms(b.T), m: b.m, plBuy: b.pl_buy, plSell: b.pl_sell })));
      const { rows } = rowsIn(t, inp[`${k}_signals`]);
      return deltaPart(t, rows, inp.w0, plant, e.expect[k].shifts).out;
    };
    return { part1: () => part("part1"), part2: () => part("part2") };
  },
  "A.2.30": (e, plant) => {
    const src = handById.get(e.input.same_as)!.input;
    const { t, rows } = tableOf(src);
    const a = estA(t, rows, { w0: src.w0, shift: true, plant });
    const fa = influenceOf(t, rows, "a", plant);
    const pos = orderBy(src.signals);
    return {
      a: () => a.value,
      a_prime: () => (a.value === null ? null : a.value / 100),
      N: () => a.N,
      influence_a: () => Array.from(rows).sort((x, y) => pos(t, x) - pos(t, y)).map((r) => ({ T: isoOf(t.T[r]), d: t.d[r], week: t.week[r], block: Math.floor((t.week[r] - src.w0) / 4), infl_a: fa.sig[r] })),
      week_S_g_a: () => sumsObj(a.sums.week),
      C_week: () => a.C_week,
      se_week_a: () => seOfKind(a, "week"),
      four_week_S_g_a: () => sumsObj(a.sums.four),
      C_4week: () => a.C_4w,
      se_4week_a: () => seOfKind(a, "4w"),
      shifts: () => shiftsOut(t, rows, plant, { a_k: a.shift }, pos, false),
      K: () => a.shift?.used ?? null,
      sd_shift_a: () => a.shift?.sd ?? null,
      a_choice: () => choiceOf(a),
    };
  },
  "A.2.31": (e) => {
    const rows = (e.input.trials as J[]).map((r) => ({ name: r.name as string, sd: Number(r.sd_delta_100runs), meanUsed: Number(r.mean_se_used), meanWider: Number(r.mean_se_wider_week_4week) }));
    const part = (rs: typeof rows, M: number) => {
      const g = nGate(rs, M);
      const z = zq(1 - 0.01 / M);
      return {
        M, r_used: g.rUsed, r_cl: g.rCl, r_used_sorted: g.rUsed.slice().sort((a, b) => a - b), r_cl_sorted: g.rCl.slice().sort((a, b) => a - b),
        r_used_median: g.rUsedMedian, r_cl_median: g.rClMedian, z_q: `1-0.01/${M}`, z_12sig: sig12(z), z_double: tol(z, "q"), L_12sig: sig12(g.L), L_double: tol(g.L, "q"),
        gate: { r_used_median_in_range: g.usedInRange, r_cl_median_le_115: g.clLe115, all_le_L: g.allLeL, pass: g.pass },
      };
    };
    return {
      even: () => part(rows, e.params.M as number),
      // the example's odd case: M = 5 without h1.S01 (input.odd_case)
      odd: () => part(rows.filter((r) => r.name !== "h1.S01"), 5),
      L_M1364_double: () => tol(nGateL(1364), "q"),
    };
  },
  "A.2.32": (e, plant) => {
    const inp = e.input;
    // part 1: the normal table; the signal without a trade (no bar: an empty series) is counted as no trade
    const t1 = blindFromRows("m15", "first", false, (inp.part1_blind as J[]).map((b) => ({ pi: piOf(b.pair), T: ms(b.T), m: b.m, plBuy: b.pl_buy, plSell: b.pl_sell })));
    const tr1 = trialRows(t1, blindFromRows("m15", "first", true, []), countedSigs("m15", "first", sigsOf(inp.part1_signals, "m15")), "first", fiveOf("m15", {}), plant);
    const p1 = deltaPart(t1, tr1.rows, inp.w0, plant, e.expect.part1.shifts);
    p1.out.shifts = shiftsOut(t1, tr1.rows, plant, { delta_k: p1.d.shift, pl_k_pips: p1.pl.shift }, orderBy(inp.part1_signals), droppedIsList(e.expect.part1.shifts));
    // part 2: the late table from the flags of the ordinary bars
    const ob = inp.part2_ordinary_bars as J[];
    const base2 = blindFromRows("m15", "first", false, baseRowsOf(ob));
    const late2 = blindFromRows("m15", "first", true, lateRowsOf(ob));
    const tr2 = trialRows(base2, late2, countedSigs("m15", "first", sigsOf(inp.part2_signals, "m15")), "first", fiveOf("m15", {}), plant);
    const lo = trialRowsExtra(tr2)!.lateOut;
    const outBars = lateOutBars(base2, late2, N_BARS);
    const p2 = latePart(late2, tr2.lateRows, inp.w0, plant, e.expect.part2.shifts, orderBy(inp.part2_signals));
    return {
      part1: () => ({
        no_trade_signals: tr1.noTrade,
        no_trade_signals_list: trialRowsExtra(tr1)!.noTradeList.map(sigItem),
        shifted_signals: new Prose("which signals are shifted (prose)"),
        ...p1.out,
      }),
      part2: () => ({
        late_excluded: {
          signals: tr2.lateExcluded.noEntry + tr2.lateExcluded.r4 + tr2.lateExcluded.end,
          signals_list: lo.map((x) => ({ ...sigItem(x), reason: LATE_WHY_JA[x.why] })),
          blind_bars: outBars.length,
          blind_bars_list: outBars.map((x) => isoOf(x.T)),
        },
        shifted_signals: new Prose("which signals are shifted (prose)"),
        ...p2.out,
      }),
    };
  },
};

// A.2.8 and A.2.9: one small table (no t: one week, or no signal)
function g2Small(e: J, plant: string): Record<string, Thunk> {
  const { t, rows } = tableOf(e.input);
  const o = { w0: W0.first, shift: true, plant };
  const d = estDelta(t, rows, o);
  const a = estA(t, rows, o);
  const pl = estPl(t, rows, o);
  return {
    N: () => d.N,
    delta: () => d.value,
    a: () => a.value,
    pl_mean_pips: () => pl.value,
    C_week: () => d.C_week,
    C_4week: () => d.C_4w,
    W_h: () => t.weeks.length,
    shifts: () => shiftsOut(t, rows, plant, { delta_k: d.shift }, orderBy(e.input.signals), false),
    se_week: () => seOfKind(d, "week"),
    sd_shift: () => d.shift?.sd ?? null,
    t: () => d.t,
    p: () => tol(d.p, "p"),
    lb: () => tol(d.lb, "q"),
    ub: () => tol(d.ub, "q"),
    p_pl: () => tol(pl.p, "p"),
    selectable_rule3: () => rule3Ok(d),
  };
}

// A.2.13 and A.2.25: D_F of spec 8.6 (week and 4 weeks, the wider one)
function dfAdapter(e: J, plant: string): Record<string, Thunk> {
  const inp = e.input;
  const t = blindFromRows(TF_OF[inp.tf], "first", false, (inp.blind as J[]).map((b) => ({ pi: piOf(b.pair), T: ms(b.T), m: b.m, plBuy: b.pl_buy, plSell: b.pl_sell })));
  const rA = rowsIn(t, inp.trial_EF_signals).rows;
  const rB = rowsIn(t, inp.S_F_signals).rows;
  // S01 (A.2.25): the same bars as S_F01r with the direction reversed (the example's note)
  const r01 = rowsIn(t, (inp.S_F_signals as J[]).map((x) => ({ ...x, d: -x.d }))).rows;
  const D = estDiff(t, rA, rB, { w0: inp.w0, shift: false, plant });
  const part = (kind: "week" | "4w", sums: Map<number, number>, C: number) => {
    const c = D.cands.find((x) => x.kind === kind);
    return { C, S_g: sumsObj(sums), se: c?.se ?? null, df: c?.df ?? null, t975: tol(c?.q975 ?? null, "q"), half_width: tol(c?.halfWidth ?? null, "q") };
  };
  return {
    delta_EF: () => deltaOf(t, rA, plant),
    delta_SF: () => deltaOf(t, rB, plant),
    N_EF: () => rA.length,
    N_SF: () => rB.length,
    strata_EF: () => strataRows(t, rA, plant),
    strata_SF: () => strataRows(t, rB, plant),
    delta_S01_for_reference: () => deltaOf(t, r01, plant),
    delta_SF_equals_minus_delta_S01_exactly: () => deltaOf(t, rB, plant) === -(deltaOf(t, r01, plant) as number),
    D_F: () => D.value,
    week: () => part("week", D.sums.week, D.C_week),
    four_week: () => part("4w", D.sums.four, D.C_4w),
    used: () => (D.useLB ? KIND_JA[D.useLB] : null),
    lower: () => tol(D.lb, "q"),
    upper: () => tol(D.ub, "q"),
    lower_gt_0: () => gt0(D.lb),
  };
}

// the adapters of the other builders' modules (groups 1–4)
const G_OTHERS: Record<string, Adapter> = { ...G1, ...G2, ...G3, ...G4 };

const ADAPTERS: Record<string, Adapter> = { ...G_OTHERS, ...G_D };

async function runOne(e: HandExample, plant: string): Promise<HandResult> {
  const req = HAND_REQUIRED[e.id];
  const keys: HandKeyResult[] = [];
  if (req === undefined) return { id: e.id, status: "skip", keys: [{ key: "*", status: "skip", why: "not in the trial's set (its items are not built)" }] };
  const adapter = ADAPTERS[e.id];
  const required = req === "all" ? Object.keys(e.expect).filter((k) => !ALT_KEY.test(k)) : [...req];
  let thunks: Record<string, Thunk> = {};
  let setupErr: string | null = null;
  if (!adapter) setupErr = "no adapter";
  else {
    try {
      thunks = await adapter(e, plant);
    } catch (err) {
      setupErr = isNotBuilt(err) ? `skip: ${(err as Error).message}` : `threw: ${(err as Error).message}`;
    }
  }
  // an adapter may serve several examples of one shape: a key the example does not have is not asked
  const asked = new Set<string>([...required, ...Object.keys(thunks).filter((k) => at(e.expect, k) !== undefined)]);
  for (const key of asked) {
    if (ALT_KEY.test(key)) continue;
    const want = at(e.expect, key);
    if (setupErr !== null) {
      keys.push({ key, status: setupErr.startsWith("skip") ? "skip" : "fail", why: setupErr });
      continue;
    }
    const th = thunks[key];
    if (!th) {
      keys.push({ key, status: "skip", why: "no adapter for this key" });
      continue;
    }
    try {
      const got = await th();
      if (got instanceof Skip) {
        keys.push({ key, status: "skip", why: got.why });
        continue;
      }
      const d = diffOf(got, want);
      if (d === null) keys.push({ key, status: "pass", why: "" });
      else {
        let why = d;
        if (plant) {
          // informational: does the planted output equal one of the example's alternative answers?
          const alt = Object.keys(e.expect).filter((k) => ALT_KEY.test(k) && diffOf(got, (e.expect as J)[k]) === null);
          if (alt.length) why += ` (= ${alt.join(", ")})`;
        }
        keys.push({ key, status: "fail", why });
      }
    } catch (err) {
      keys.push({ key, status: isNotBuilt(err) ? "skip" : "fail", why: isNotBuilt(err) ? (err as Error).message : `threw: ${(err as Error).message}` });
    }
  }
  const reqSet = new Set(required);
  const bad = keys.some((k) => reqSet.has(k.key) && k.status !== "pass") || keys.some((k) => k.status === "fail");
  return { id: e.id, status: bad ? "fail" : "pass", keys };
}

export async function runHand(o: { plant: string; ids?: string[] }): Promise<HandResult[]> {
  const doc = JSON.parse(await Deno.readTextFile(new URL("./lawsearch-hand.json", import.meta.url)));
  if (handTrials.size === 0) for (const t of parseCandidates(JSON.parse(await Deno.readTextFile(new URL("./ledger/lawsearch-candidates.json", import.meta.url))))) handTrials.set(t.id, t);
  const all = doc.examples as HandExample[];
  for (const e of all) handById.set(e.id, e);
  const pick = o.ids && o.ids.length ? all.filter((e) => o.ids!.includes(e.id)) : all;
  const out: HandResult[] = [];
  for (const e of pick) out.push(await runOne(e, o.plant));
  return out;
}

// one line per example: "<status> <id> [<key>: <why>; …]"
export function handLines(rs: HandResult[]): string[] {
  return rs.map((r) => {
    const notes = r.keys.filter((k) => k.status !== "pass").map((k) => `${k.key} ${k.status}${k.why ? `: ${k.why}` : ""}`);
    return `${r.status.toUpperCase().padEnd(4)} ${r.id}${notes.length ? "  " + notes.join("; ") : ""}`;
  });
}

if (import.meta.main) {
  const plant = Deno.env.get("LS_PLANT") ?? "";
  const ids = (Deno.env.get("HAND_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rs = await runHand({ plant, ids });
  for (const line of handLines(rs)) console.log(line);
  const failed = rs.filter((r) => r.status === "fail").length;
  console.log(`hand: ${rs.filter((r) => r.status === "pass").length} pass, ${failed} fail, ${rs.filter((r) => r.status === "skip").length} skip`);
  Deno.exit(failed > 0 ? 4 : 0);
}
