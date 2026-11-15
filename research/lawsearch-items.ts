// 法則探し (docs §8.136, research/lawsearch-spec.md): the registry of items E / B, filters F and the S rows, and the
// reader of the trial ledger (builder B, research/lawsearch-design.md 5.2).
//
// The registry is keyed by the ids of research/ledger/lawsearch-candidates.json. The small trial (spec 19 step 3)
// defines E04, E26, B06, F00 and F01 (and S01 through F01). Step 4's pilot (2026-11-15, the lead) adds E13, E29, E30,
// F02, F02r (and S02 through F02) and B07. Step 4's round A (2026-11-15, the lead) adds E01–E03, E05–E12 and
// E14–E21. Every other id throws "NOT BUILT: <id>", so a mode can refuse a trial
// before it reads a bar. Adding an item later is one entry of ITEMS (or FILTERS) and nothing else.
//
// Each definition follows spec 4.1–4.4, 3.2, 5 and 17.3 (§8.113 C1, C17, C19). The dump columns are lawsearch-dump.md 5's;
// with the hand examples' shrunk params the names keep the default numbers (RSI14, EMA200, HTF_EMA50).

import { DAY, MINUTE } from "./lib.ts";
import { F_ORDER, S_OF_F, TRIAL_STEP3 } from "./lawsearch-rules.ts";
import { bigmoveDefault, insideOf, mean200Of, pdayOf, rsi2Of, xDn, xUp } from "./lawsearch-ind.ts";
import type { FilterBuild, FilterDef, Ind, ItemBuild, ItemDef, ItemKind, ItemParams, SeriesKey, TfKey, TrialDef, TrialKind, Tri } from "./lawsearch-types.ts";

// ---- not built -----------------------------------------------------------------------------------------------

export const notBuilt = (what: string): never => {
  throw new Error("NOT BUILT: " + what);
};
export const isNotBuilt = (e: unknown): boolean => e instanceof Error && e.message.startsWith("NOT BUILT: ");

// ---- the ledger (spec 4.6) -----------------------------------------------------------------------------------

const E_IDS = Array.from({ length: 44 }, (_, k) => `E${String(k + 1).padStart(2, "0")}`);
const S_IDS = ["S01", "S02", "S03", "S04"];
const B_IDS = Array.from({ length: 18 }, (_, k) => `B${String(k + 1).padStart(2, "0")}`);
const TF_OF: Readonly<Record<string, TfKey>> = { "15min": "m15", "1hour": "h1" };

// the spec's table order (4.6): per timeframe (15 minutes, then 1 hour) E01..E44 × F_ORDER, then S01..S04, then
// B01..B18
const tableOrder = (): Array<{ id: string; tf: string; kind: TrialKind; e: string | null; f: string | null; s: string | null; b: string | null }> => {
  const out: Array<{ id: string; tf: string; kind: TrialKind; e: string | null; f: string | null; s: string | null; b: string | null }> = [];
  for (const tf of ["15min", "1hour"]) {
    const p = TF_OF[tf];
    for (const e of E_IDS) for (const f of F_ORDER) out.push({ id: `${p}.${e}.${f}`, tf, kind: "EF", e, f, s: null, b: null });
    for (const s of S_IDS) out.push({ id: `${p}.${s}`, tf, kind: "S", e: null, f: S_OF_F[s], s, b: null });
    for (const b of B_IDS) out.push({ id: `${p}.${b}`, tf, kind: "B", e: null, f: null, s: null, b });
  }
  return out;
};

const KEYS_OF: Readonly<Record<string, readonly string[]>> = {
  EF: ["e", "f", "id", "kind", "name", "order", "tf"],
  S: ["f", "id", "kind", "name", "order", "s", "tf"],
  B: ["b", "id", "kind", "name", "order", "tf"],
};

// research/ledger/lawsearch-candidates.json (already JSON.parse'd): 1,364 rows, order 1..1364, in the spec's table
// order; "15min" → "m15", "1hour" → "h1". Any other shape throws.
// C4f (the lead's H2, defense in depth): every TrialDef is frozen where it is made. A TrialDef holds strings, numbers
// and nulls only, so Object.freeze freezes all of it: no field can be changed and no property added (in these strict
// modules either throws a TypeError, e.g. "Cannot add property __peek, object is not extensible"), so no code can
// keep state on a trial definition (C4e's review: trialStashE04). The guard by construction is H1 (lawsearch.ts: the
// checks get trialCopyOf copies, never these objects); the freeze only makes such a write fail at once.
export function parseCandidates(json: unknown): TrialDef[] {
  const bad = (what: string): never => {
    throw new Error(`lawsearch-candidates.json: ${what}`);
  };
  if (typeof json !== "object" || json === null || Array.isArray(json)) return bad("not an object");
  const o = json as Record<string, unknown>;
  const rows = o.trials;
  if (!Array.isArray(rows)) return bad("no trials array");
  const want = tableOrder();
  if (o.count !== want.length || rows.length !== want.length) return bad(`count ${String(o.count)}, rows ${rows.length}, not ${want.length}`);
  const out: TrialDef[] = [];
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k] as Record<string, unknown>;
    const w = want[k];
    const at = `row ${k + 1}`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) return bad(`${at}: not an object`);
    const keys = Object.keys(r).sort();
    const wantKeys = KEYS_OF[String(r.kind)];
    if (!wantKeys || keys.join(",") !== wantKeys.join(",")) return bad(`${at}: keys ${keys.join(",")}`);
    if (r.order !== k + 1) return bad(`${at}: order ${String(r.order)}`);
    if (r.id !== w.id || r.tf !== w.tf || r.kind !== w.kind) return bad(`${at}: ${String(r.id)} ${String(r.tf)} ${String(r.kind)}, not ${w.id} ${w.tf} ${w.kind}`);
    if ((r.e ?? null) !== w.e || (r.f ?? null) !== w.f || (r.s ?? null) !== w.s || (r.b ?? null) !== w.b) return bad(`${at}: the parts of ${w.id}`);
    if (typeof r.name !== "string" || r.name === "") return bad(`${at}: name`);
    out.push(Object.freeze({ id: w.id, order: k + 1, tf: TF_OF[w.tf], kind: w.kind, e: w.e, f: w.f, s: w.s, b: w.b, name: r.name }));
  }
  return out;
}

// C4f (the lead's H1): a trial definition of the checks' own: a new object with the same fields (structured clone),
// frozen as parseCandidates' are. lawsearch.ts makes the checks' trials with it before any main-run code is handed
// the parsed ones, so no check reads an object the main run holds.
export const trialCopyOf = (t: TrialDef): TrialDef => Object.freeze(structuredClone(t));

// ---- the definitions -----------------------------------------------------------------------------------------

const triOf = (n: number, f: (i: number) => number): Tri => {
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
};

// E01–E06 rsi_back_p_L (spec 4.1): buy X↑(RSI_p, L), sell X↓(RSI_p, 100 − L); a cross item (spec 5); warm-up p + 1.
// E07–E09 rsi_50_p are the same with L = 50 (buy X↑(RSI_p, 50), sell X↓(RSI_p, 50); step 4, round A). The RSI is
// pineRsi's through the Ind's cache (one array per p, shared by every item of that p: E03, E04 and E08 read RSI14).
const rsiBack = (id: string, p0: number, L: number): ItemDef => {
  const pOf = (params?: ItemParams) => params?.rsi ?? p0;
  const warmupFor = (params?: ItemParams) => params?.warmup ?? pOf(params) + 1;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const r = ind.rsi(pOf(params));
      const buy = xUp(r.rsi, L);
      const sell = xDn(r.rsi, 100 - L);
      return {
        kind: "cross",
        cond: [buy, sell],
        keep: null,
        warmup: warmupFor(params),
        // C4b ("free"): U and D are getters, so that they are made only when the dump reads them (lawsearch-ind.ts
        // rsi); the same names in the same order, the same arrays
        columns: {
          [`RSI${p0}`]: r.rsi,
          get [`RSI${p0}_U`]() {
            return r.U;
          },
          get [`RSI${p0}_D`]() {
            return r.D;
          },
          [`${id}_buy`]: buy,
          [`${id}_sell`]: sell,
        },
      };
    },
  };
};

// E26–E27 donchian-A_n (spec 4.1, §8.113 C1): 常に持つ型; buy target s = +1, sell s = −1, never 無し; warm-up n
const donchianA = (id: string, n0: number): ItemDef => {
  const nOf = (params?: ItemParams) => params?.donchian ?? n0;
  const warmupFor = (params?: ItemParams) => params?.warmup ?? nOf(params);
  return {
    id,
    kind: "hold",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const don = ind.donchian(nOf(params));
      const len = ind.series.n;
      return {
        kind: "hold",
        cond: [triOf(len, (i) => (don.s[i] === 1 ? 1 : 0)), triOf(len, (i) => (don.s[i] === -1 ? 1 : 0))],
        keep: null,
        warmup: warmupFor(params),
        columns: { [`DON${n0}_HH`]: don.HH, [`DON${n0}_LL`]: don.LL, [`DON${n0}_s`]: don.s },
      };
    },
  };
};

// B06 bigmove (spec 4.4, §8.113 C17, 17.3): a condition item; buy z ≤ −2, sell z ≥ +2 (−1 where z is 無し); spec
// 5 ③ (§8.113 置6) drops the signals whose T has a UTC time of day in [19:35, 24:00) after the rising edge;
// warm-up 288 (the σ window)
const KEEP_FROM = 19 * 60 * MINUTE + 35 * MINUTE;
const bigmoveItem = (id: string): ItemDef => {
  const paramsOf = (step: number, params?: ItemParams) => ({ ...bigmoveDefault(step), ...(params?.bigmove ?? {}) });
  const warmupFor = (params?: ItemParams) => params?.warmup ?? params?.bigmove?.sigmaWindow ?? bigmoveDefault(0).sigmaWindow;
  return {
    id,
    kind: "condition",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const s = ind.series;
      const o = paramsOf(s.step, params);
      const bm = ind.bigmove(o);
      const buy = triOf(s.n, (i) => (Number.isNaN(bm.z[i]) ? -1 : bm.z[i] <= -o.threshold ? 1 : 0));
      const sell = triOf(s.n, (i) => (Number.isNaN(bm.z[i]) ? -1 : bm.z[i] >= o.threshold ? 1 : 0));
      const keep = new Uint8Array(s.n);
      for (let i = 0; i < s.n; i++) {
        const tod = ((s.T[i] % DAY) + DAY) % DAY;
        keep[i] = tod >= KEEP_FROM ? 0 : 1;
      }
      return {
        kind: "condition",
        cond: [buy, sell],
        keep: [keep, keep],
        warmup: warmupFor(params),
        // lawsearch-dump.md 5: BM_r is written only where r may be used (BM_ok = 1), as the hand examples write r
        columns: { BM_r: Float64Array.from(bm.r, (v, i) => (bm.usable[i] === 1 ? v : NaN)), BM_ok: bm.usable, BM_sigma: bm.sigma, BM_z: bm.z, [`${id}_buy`]: buy, [`${id}_sell`]: sell, [`${id}_keep`]: keep },
      };
    },
  };
};

// ---- step 4's pilot (2026-11-15): E13, E29, E30, B07; F02 and F02r below ------------------------------------------

// E13–E14 macd_sig (spec 4.1): buy X↑(MACD line, signal), sell X↓(MACD line, signal) on doubles (3.1); a cross item
// (spec 5); the line and signal are the app's macd (17.1) through the Ind's cache; warm-up s + m − 1 (34 for
// (12, 26, 9), 39 for E14's (5, 35, 5), step 4 round A)
const macdSig = (id: string, f: number, sl: number, m: number): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? sl + m - 1;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const mc = ind.macd(f, sl, m);
      const buy = xUp(mc.line, mc.signal);
      const sell = xDn(mc.line, mc.signal);
      return {
        kind: "cross",
        cond: [buy, sell],
        keep: null,
        warmup: warmupFor(params),
        columns: { [`MACD${f}_${sl}`]: mc.line, [`MACD${f}_${sl}_SIG`]: mc.signal, [`${id}_buy`]: buy, [`${id}_sell`]: sell },
      };
    },
  };
};

// E29 inside_brk (spec 4.1, in points): buy when bar i − 1 is inside bar i − 2 (Ph[i−1] ≤ Ph[i−2], Pl[i−1] ≥
// Pl[i−2]) and Pc[i] > Ph[i−2]; sell inside and Pc[i] < Pl[i−2]; 無し for i < 2. A condition item (spec 5: its
// rising edge, and the first bar whose condition is not 無し, bar 2, gives no signal); warm-up 3
const insideBrk = (id: string): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? 3;
  return {
    id,
    kind: "condition",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const s = ind.series;
      const inside = insideOf(s);
      const buy = triOf(s.n, (i) => (inside[i] === -1 ? -1 : inside[i] === 1 && s.Pc[i] > s.Ph[i - 2] ? 1 : 0));
      const sell = triOf(s.n, (i) => (inside[i] === -1 ? -1 : inside[i] === 1 && s.Pc[i] < s.Pl[i - 2] ? 1 : 0));
      return { kind: "condition", cond: [buy, sell], keep: null, warmup: warmupFor(params), columns: { [`${id}_buy`]: buy, [`${id}_sell`]: sell } };
    },
  };
};

// E30's previous day must have at least this many bars (spec 4.1 E30's notes: 58 on 15 minutes, 15 on 1 hour)
const PDAY_MIN_BARS: Readonly<Partial<Record<SeriesKey, number>>> = Object.freeze({ m15: 58, h1: 15 });

// E30's raw signals of one direction from its day-wise condition (spec 4.1 E30's notes, 5): the condition is a
// separate condition for each day, so at a day's first bar the condition of bar i − 1 counts as not holding (it is
// not compared with the previous day's last bar, and it is not 無し); within a day the rising edge is spec 5's (the
// condition is 無し on every bar of a day or on none, since it is 無し exactly when the previous day is). Spec 5's
// "the first bar after S0 whose condition is not 無し gives no signal" is applied once for the whole item, not per day.
// raw: 1 a raw signal (②), 0 none, −1 where the condition is 無し. keep (③, §8.113 置6): once per day and direction,
// 0 at a raw signal when an earlier raw signal of the direction stands on the same day (the condition and the raw
// signals are not changed by it, so the next bar still compares with ①'s value).
const dayEdge = (cond: Tri, first: Uint8Array, day: Int32Array): { raw: Tri; keep: Uint8Array } => {
  const n = cond.length;
  const raw = new Int8Array(n).fill(-1);
  const keep = new Uint8Array(n).fill(1);
  const firstSet = cond.findIndex((v) => v !== -1);
  let lastDay = -1;
  for (let i = 0; i < n; i++) {
    if (cond[i] === -1) continue;
    const before = first[i] === 1 ? 0 : cond[i - 1];
    raw[i] = cond[i] === 1 && before === 0 && i !== firstSet ? 1 : 0;
    if (raw[i] !== 1) continue;
    if (day[i] === lastDay) keep[i] = 0;
    lastDay = day[i];
  }
  return { raw, keep };
};

// E30 pday_brk (spec 4.1 and its notes): the condition is C > PDH (sell C < PDL) on doubles, PDH and PDL the previous
// day's high and low (lawsearch-ind.ts pdayOf: 無し when that day has fewer than 58 bars on 15 minutes, 15 on 1 hour);
// a signal is the first bar of the day whose close goes beyond the previous day's high (the day's first bar too), once
// per day and direction. Spec 5's generic rising edge (cond[i − 1]) cannot express the day-wise edge, so the build
// hands candidatesOf the raw signals as a cross item's formula (② emits where it is 1) and once per day as the keep
// rule (③). The dump columns are the day-wise condition before spec 5's rules (lawsearch-dump.md 5). Warm-up: spec 5's
// table says "前の日がそろうこと": the condition is 無し until the previous day has its bars, so no signal can stand
// before it and no bar index is needed (0).
const pdayBrk = (id: string): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? 0;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const s = ind.series;
      const minBars = PDAY_MIN_BARS[s.key];
      if (minBars === undefined) throw new Error(`${id}: no previous-day bar count for ${s.key}`);
      const pd = pdayOf(s, minBars);
      const buy = triOf(s.n, (i) => (Number.isNaN(pd.PDH[i]) ? -1 : s.C[i] > pd.PDH[i] ? 1 : 0));
      const sell = triOf(s.n, (i) => (Number.isNaN(pd.PDL[i]) ? -1 : s.C[i] < pd.PDL[i] ? 1 : 0));
      const b = dayEdge(buy, pd.first, s.day);
      const x = dayEdge(sell, pd.first, s.day);
      return {
        kind: "cross",
        cond: [b.raw, x.raw],
        keep: [b.keep, x.keep],
        warmup: warmupFor(params),
        columns: { PD_H: pd.PDH, PD_L: pd.PDL, [`${id}_buy`]: buy, [`${id}_sell`]: sell },
      };
    },
  };
};

// B07 rsi2 (spec 4.4, §8.113 C19, 17.3): a condition item on the point closes; buy B = up and RSI2 < 10 (9 × AG <
// AL), sell S = dn and RSI2 > 90 (AG > 9 × AL); 無し where either part is (AG before bar 2, the 200-bar mean before bar
// 199); warm-up 200 (§8.113's count: signals at bar 200 or later)
const rsi2Item = (id: string): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? 200;
  return {
    id,
    kind: "condition",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const s = ind.series;
      const r = rsi2Of(s);
      const mp = mean200Of(s);
      const buy = triOf(s.n, (i) => (Number.isNaN(r.AG[i]) || mp.up[i] === -1 ? -1 : mp.up[i] === 1 && 9 * r.AG[i] < r.AL[i] ? 1 : 0));
      const sell = triOf(s.n, (i) => (Number.isNaN(r.AG[i]) || mp.dn[i] === -1 ? -1 : mp.dn[i] === 1 && r.AG[i] > 9 * r.AL[i] ? 1 : 0));
      return {
        kind: "condition",
        cond: [buy, sell],
        keep: null,
        warmup: warmupFor(params),
        columns: { RSI2_AG: r.AG, RSI2_AL: r.AL, [`${id}_up`]: mp.up, [`${id}_dn`]: mp.dn, [`${id}_buy`]: buy, [`${id}_sell`]: sell },
      };
    },
  };
};

// ---- step 4, round A (2026-11-15): E01–E03, E05–E12, E14–E21 ------------------------------------------------------
// Every one is a cross item of spec 5 (its formula holds X↑ or X↓, so the rising edge is in the formula and spec 5's
// two "合図にしない足" are not applied: the first bar where the cross is not 無し may give a signal). A tri is 1, 0, or −1
// where a value of the formula is 無し. Every comparison is on doubles with no tolerance (spec 3.1, 21.5). The dump
// columns are lawsearch-dump.md 5's round-A table; each build also gives the indicator columns its formula reads (as
// E04 gives RSI14 and F02r F02's), so that a run holding only that item still writes them (dumpInd checks that two
// builds of one column hold the same values). Params: only the generic warm-up override (no hand example shrinks these
// items; F01's ema param must not reach E18's or E21's EMA200).

// E10–E11 stoch_kd_k (spec 4.1, 3.2): buy X↑(%K, %D) and %K[i] < 20, sell X↓(%K, %D) and %K[i] > 80, the slow
// stochastic (k, 3, 3) of Ind.stoch; warm-up k + 4
const stochKd = (id: string, k: number): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? k + 4;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const st = ind.stoch(k);
      const up = xUp(st.K, st.D);
      const dn = xDn(st.K, st.D);
      const n = ind.series.n;
      const buy = triOf(n, (i) => (up[i] === -1 ? -1 : up[i] === 1 && st.K[i] < 20 ? 1 : 0));
      const sell = triOf(n, (i) => (dn[i] === -1 ? -1 : dn[i] === 1 && st.K[i] > 80 ? 1 : 0));
      return {
        kind: "cross",
        cond: [buy, sell],
        keep: null,
        warmup: warmupFor(params),
        columns: { [`STOCH${k}_K`]: st.K, [`STOCH${k}_D`]: st.D, [`${id}_buy`]: buy, [`${id}_sell`]: sell },
      };
    },
  };
};

// E12 rci_9 (spec 4.1, 3.2): buy X↑(RCI9, −80), sell X↓(RCI9, +80), RCI9 by the app's rci (src/lib/rci.ts, length 9;
// Ind.rci); warm-up 9 (spec 5's table). The decisions where RCI[i] or RCI[i−1] is within 1e−9 of ±80 may differ from
// the Python's (spec 3.2's note, 17.2; lawsearch-dump.md 9.2b): the comparator takes the TS's there
const rciItem = (id: string, n0: number): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? n0;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const r = ind.rci(n0);
      const buy = xUp(r, -80);
      const sell = xDn(r, 80);
      return { kind: "cross", cond: [buy, sell], keep: null, warmup: warmupFor(params), columns: { [`RCI${n0}`]: r, [`${id}_buy`]: buy, [`${id}_sell`]: sell } };
    },
  };
};

// E15 macd_zero (spec 4.1): buy X↑(MACD(12, 26) line, 0), sell X↓(line, 0); the line of the app's macd through the
// Ind's cache. The line does not depend on the signal's m (macd.ts: pineEma(C, f) − pineEma(C, s)), so the build
// reads macd(f, s, 9), E13's, and both give the same MACD12_26 column. Warm-up s (spec 5's table: 「MACD の線だけ
// （E15）」 s = 26, not s + m − 1; A.3.17)
const macdZero = (id: string, f: number, sl: number): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? sl;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const line = ind.macd(f, sl, 9).line;
      const buy = xUp(line, 0);
      const sell = xDn(line, 0);
      return { kind: "cross", cond: [buy, sell], keep: null, warmup: warmupFor(params), columns: { [`MACD${f}_${sl}`]: line, [`${id}_buy`]: buy, [`${id}_sell`]: sell } };
    },
  };
};

// E16–E18 ema2 (spec 4.1): buy X↑(EMA_f, EMA_s), sell X↓(EMA_f, EMA_s), both pineEma of the mid close (Ind.ema);
// warm-up the slower s (spec 5's table 「EMA の2本の交差」, 21.5)
const ema2 = (id: string, f: number, sl: number): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? sl;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const fast = ind.ema(f);
      const slow = ind.ema(sl);
      const buy = xUp(fast, slow);
      const sell = xDn(fast, slow);
      return { kind: "cross", cond: [buy, sell], keep: null, warmup: warmupFor(params), columns: { [`EMA${f}`]: fast, [`EMA${sl}`]: slow, [`${id}_buy`]: buy, [`${id}_sell`]: sell } };
    },
  };
};

// E19–E21 c_ema (spec 4.1): buy X↑(C, EMA_n), sell X↓(C, EMA_n), C the mid close (double) and EMA_n pineEma's
// (Ind.ema; E21's EMA200 is F01's array); warm-up n (spec 5's table 「EMA_n」)
const cEma = (id: string, n0: number): ItemDef => {
  const warmupFor = (params?: ItemParams) => params?.warmup ?? n0;
  return {
    id,
    kind: "cross",
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const ema = ind.ema(n0);
      const buy = xUp(ind.series.C, ema);
      const sell = xDn(ind.series.C, ema);
      return { kind: "cross", cond: [buy, sell], keep: null, warmup: warmupFor(params), columns: { [`EMA${n0}`]: ema, [`${id}_buy`]: buy, [`${id}_sell`]: sell } };
    },
  };
};

// F00 (spec 4.2): always true; no warm-up
const f00: FilterDef = {
  id: "F00",
  directional: false,
  warmup: 0,
  warmupFor: () => 0,
  build(ind: Ind): FilterBuild {
    const len = ind.series.n;
    return { f: [new Int8Array(len).fill(1), new Int8Array(len).fill(1)], warmup: 0, warmOk: null, columns: {} };
  },
};

// F01 (spec 4.2): d × (C − EMA200) > 0, on doubles with no tolerance (an equal value is false for both
// directions); −1 where EMA200 is 無し; warm-up 200 (spec 5)
const f01: FilterDef = (() => {
  const eOf = (params?: ItemParams) => params?.ema ?? 200;
  const warmupFor = (params?: ItemParams) => params?.fWarmup ?? eOf(params);
  return {
    id: "F01",
    directional: true,
    warmup: warmupFor(),
    warmupFor,
    build(ind: Ind, params?: ItemParams): FilterBuild {
      const ema = ind.ema(eOf(params));
      const C = ind.series.C;
      const len = ind.series.n;
      const buy = triOf(len, (i) => {
        const x = C[i] - ema[i];
        return Number.isNaN(x) ? -1 : 1 * x > 0 ? 1 : 0;
      });
      const sell = triOf(len, (i) => {
        const x = C[i] - ema[i];
        return Number.isNaN(x) ? -1 : -1 * x > 0 ? 1 : 0;
      });
      return { f: [buy, sell], warmup: warmupFor(params), warmOk: null, columns: { EMA200: ema, F01_buy: buy, F01_sell: sell } };
    },
  };
})();

// F02 / F02r (spec 4.2 and 2 上位足; step 4's pilot): with g the last higher bar whose grid slot has ended by T_i
// (Ind.g, lawsearch-bars.ts htfIndex: the clock decides, even when base bars are missing), x = EMA50[g] − EMA50[g−1]
// on the higher bars' mid close (pineEma through the higher Ind's cache; g − 1 is the higher series' previous bar, so
// an hour without bars is closed up as spec 2's numbering does); F02 buy x > 0 and sell −x > 0, F02r buy x < 0 and sell
// x > 0, on doubles with no tolerance (an equal value is false for every one); −1 where g < 1 or either EMA50 is 無し.
// The index warm-up is 0; the higher warm-up (spec 5 F の温め: 上位足の51本; 21.5: kept only where g ≥ 51) is the
// per-bar warmOk. Params: the hand examples' htfEma shrinks EMA50 (and the higher warm-up to htfEma + 1).
// The dump columns are F02's (lawsearch-dump.md 5: HTF_G, HTF_EMA50, HTF_EMA50_PREV, F02_buy, F02_sell); F02r has none
// of its own (its truth is the other side's F02 column), so its build gives the same F02 columns, and a run with only
// F02r trials dumps the same values (dumpInd checks that two builds of a column hold the same values).
const HTF_EMA = 50;
const htfSlopeOf = (ind: Ind, params?: ItemParams) => {
  if (ind.higher === null || ind.g === null) throw new Error("F02: the Ind has no higher timeframe (lawsearch-ind.ts indOf(series, higher))");
  const p = params?.htfEma ?? HTF_EMA;
  const warmG = p + 1;
  const ema = ind.higher.ema(p);
  const g = ind.g;
  const n = ind.series.n;
  const G = new Float64Array(n).fill(NaN);
  const cur = new Float64Array(n).fill(NaN);
  const prev = new Float64Array(n).fill(NaN);
  const buy = new Int8Array(n);
  const sell = new Int8Array(n);
  const warmOk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = g[i];
    if (k >= 0) {
      G[i] = k;
      cur[i] = ema[k];
    }
    if (k >= 1) prev[i] = ema[k - 1];
    const x = cur[i] - prev[i];
    buy[i] = Number.isNaN(x) ? -1 : 1 * x > 0 ? 1 : 0;
    sell[i] = Number.isNaN(x) ? -1 : -1 * x > 0 ? 1 : 0;
    warmOk[i] = k >= warmG ? 1 : 0;
  }
  return { buy, sell, warmOk, columns: { HTF_G: G, HTF_EMA50: cur, HTF_EMA50_PREV: prev, F02_buy: buy, F02_sell: sell } };
};
const htfFilter = (id: "F02" | "F02r"): FilterDef => ({
  id,
  directional: true,
  warmup: 0,
  warmupFor: (params?: ItemParams) => params?.fWarmup ?? 0,
  build(ind: Ind, params?: ItemParams): FilterBuild {
    const x = htfSlopeOf(ind, params);
    return { f: id === "F02" ? [x.buy, x.sell] : [x.sell, x.buy], warmup: params?.fWarmup ?? 0, warmOk: x.warmOk, columns: x.columns };
  },
});

const ITEM_MAP: ReadonlyMap<string, ItemDef> = new Map<string, ItemDef>([
  // step 4, round A: E01–E03, E05, E06 rsi_back_p_L ((7,20) (7,30) (14,20) (21,20) (21,30)) and E07–E09 rsi_50_p
  ["E01", rsiBack("E01", 7, 20)],
  ["E02", rsiBack("E02", 7, 30)],
  ["E03", rsiBack("E03", 14, 20)],
  ["E04", rsiBack("E04", 14, 30)],
  ["E05", rsiBack("E05", 21, 20)],
  ["E06", rsiBack("E06", 21, 30)],
  ["E07", rsiBack("E07", 7, 50)],
  ["E08", rsiBack("E08", 14, 50)],
  ["E09", rsiBack("E09", 21, 50)],
  // step 4, round A: E10, E11 stoch_kd_k (k = 5, 14) and E12 rci_9
  ["E10", stochKd("E10", 5)],
  ["E11", stochKd("E11", 14)],
  ["E12", rciItem("E12", 9)],
  ["E13", macdSig("E13", 12, 26, 9)],
  // step 4, round A: E14 macd_sig (5, 35, 5), E15 macd_zero (12, 26), E16–E18 ema2 ((5,20) (20,50) (50,200)), E19–E21
  // c_ema (n = 20, 50, 200)
  ["E14", macdSig("E14", 5, 35, 5)],
  ["E15", macdZero("E15", 12, 26)],
  ["E16", ema2("E16", 5, 20)],
  ["E17", ema2("E17", 20, 50)],
  ["E18", ema2("E18", 50, 200)],
  ["E19", cEma("E19", 20)],
  ["E20", cEma("E20", 50)],
  ["E21", cEma("E21", 200)],
  ["E26", donchianA("E26", 20)],
  ["E29", insideBrk("E29")],
  ["E30", pdayBrk("E30")],
  ["B06", bigmoveItem("B06")],
  ["B07", rsi2Item("B07")],
]);
const FILTER_MAP: ReadonlyMap<string, FilterDef> = new Map<string, FilterDef>([
  ["F00", f00],
  ["F01", f01],
  ["F02", htfFilter("F02")],
  ["F02r", htfFilter("F02r")],
]);

// C4b (hardening of the speed-up): lawsearch-events.ts keeps an Ind's item and F builds under the definition's id
// (BUILDS: "item:<id>", "filter:<def.id>"; answerKnowingE26 apart, under "item:E26:answerKnowing"). That is exact only
// while each id names one definition: every key of ITEM_MAP and FILTER_MAP must equal its definition's id (the keys of
// a Map are distinct, so the ids of one map are then distinct too, and no definition sits under two keys). A registry
// that broke this could let two different items or F's share one build, so it stops the program as soon as this
// module is loaded, before any file is read.
const checkRegistry = (what: string, map: ReadonlyMap<string, { id: string }>): void => {
  for (const [key, def] of map) {
    if (def.id !== key) throw new Error(`lawsearch-items: ${what} key ${key} holds the definition ${def.id}`);
  }
};
checkRegistry("ITEM_MAP", ITEM_MAP);
checkRegistry("FILTER_MAP", FILTER_MAP);

// the items written now: E04, E26, B06 (spec 19 step 3); E13, E29, E30, B07 (step 4's pilot); E01–E03, E05–E12,
// E14–E21 (step 4, round A)
export const ITEMS: ReadonlyMap<string, ItemDef> = ITEM_MAP;
// the filters written now: F00, F01 (step 3); F02, F02r (step 4's pilot; S02 is F02 through S_OF_F)
export const FILTERS: ReadonlyMap<string, FilterDef> = FILTER_MAP;

export function itemOf(id: string): ItemDef {
  return ITEM_MAP.get(id) ?? notBuilt(id);
}
export function filterOf(id: string): FilterDef {
  return FILTER_MAP.get(id) ?? notBuilt(id);
}
// an S row's filter (spec 4.3: S01 = F01, S02 = F02, S03 = F05, S04 = F07); notBuilt when the F is not written
export function sFilterOf(sId: string): FilterDef {
  const f = S_OF_F[sId];
  if (f === undefined) return notBuilt(sId);
  return FILTER_MAP.get(f) ?? notBuilt(`${sId} (${f})`);
}

// every part of the trial has a definition (R trials: step 4)
export function trialBuilt(t: TrialDef): boolean {
  switch (t.kind) {
    case "EF":
      return t.e !== null && t.f !== null && ITEM_MAP.has(t.e) && FILTER_MAP.has(t.f);
    case "S":
      return t.s !== null && S_OF_F[t.s] !== undefined && FILTER_MAP.has(S_OF_F[t.s]);
    case "B":
      return t.b !== null && ITEM_MAP.has(t.b);
    default:
      return false;
  }
}

// spec 5 温め, 21.5: an E × F trial keeps the bars at or past both warm-ups; an S row its F's; a B row its own
// (§8.113's count). params: the hand examples' shrunk windows.
export function trialWarmup(t: TrialDef, params?: ItemParams): number {
  switch (t.kind) {
    case "EF": {
      const e = (ITEM_MAP.get(t.e ?? "") ?? notBuilt(t.e ?? t.id)).warmupFor(params);
      const f = (FILTER_MAP.get(t.f ?? "") ?? notBuilt(t.f ?? t.id)).warmupFor(params);
      return Math.max(e, f);
    }
    case "S": {
      const f = sFilterOf(t.s ?? "");
      return f.warmupFor(params);
    }
    case "B":
      return (ITEM_MAP.get(t.b ?? "") ?? notBuilt(t.b ?? t.id)).warmupFor(params);
    default:
      return notBuilt(t.id);
  }
}

// Set O (spec 14.2, lawsearch-design.md 5.2): E26 with the planted error that knows the answer. The target is +1
// when C[i+1] > C[i], −1 when C[i+1] < C[i], otherwise the previous target (0 at the start; the last bar, which has
// no next bar, keeps the previous one). It reads the next bar on purpose: spec 15's cut and poison must catch it.
// Used only when the run's manifest says group O.
export function answerKnowingE26(): ItemDef {
  const real = ITEM_MAP.get("E26")!;
  const kind: ItemKind = "hold";
  return {
    id: "E26",
    kind,
    warmup: real.warmup,
    warmupFor: real.warmupFor,
    build(ind: Ind, params?: ItemParams): ItemBuild {
      const base = real.build(ind, params);
      const C = ind.series.C;
      const len = ind.series.n;
      const target = new Int8Array(len);
      let t = 0;
      for (let i = 0; i < len; i++) {
        if (i + 1 < len) {
          if (C[i + 1] > C[i]) t = 1;
          else if (C[i + 1] < C[i]) t = -1;
        }
        target[i] = t;
      }
      return {
        kind,
        cond: [triOf(len, (i) => (target[i] === 1 ? 1 : 0)), triOf(len, (i) => (target[i] === -1 ? 1 : 0))],
        keep: null,
        warmup: base.warmup,
        columns: { ...base.columns, DON20_s: target },
      };
    },
  };
}

// the twelve trials of the small trial (lawsearch-rules.ts TRIAL_STEP3), in table order; throws when any is
// missing from the ledger
export function stepThree(all: TrialDef[]): TrialDef[] {
  const want = new Set(TRIAL_STEP3);
  const out = all.filter((t) => want.has(t.id)).sort((a, b) => a.order - b.order);
  if (out.length !== want.size) {
    const have = new Set(out.map((t) => t.id));
    throw new Error(`stepThree: not in the ledger: ${TRIAL_STEP3.filter((id) => !have.has(id)).join(", ")}`);
  }
  return out;
}
