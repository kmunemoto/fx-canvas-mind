// 法則探し (docs §8.136, research/lawsearch-spec.md): the registry of items E / B, filters F and the S rows, and the
// reader of the trial ledger (builder B, research/lawsearch-design.md 5.2).
//
// The registry is keyed by the ids of research/ledger/lawsearch-candidates.json. The small trial (spec 19 step 3)
// defines E04, E26, B06, F00 and F01 (and S01 through F01). Every other id throws "NOT BUILT: <id>", so a mode can
// refuse a trial before it reads a bar. Adding an item later is one entry of ITEMS (or FILTERS) and nothing else.
//
// Each definition follows spec 4.1–4.4, 5 and 17.3 (§8.113 C1, C17). The dump columns are lawsearch-dump.md 5's;
// with the hand examples' shrunk params the names keep the default numbers (RSI14, EMA200).

import { DAY, MINUTE } from "./lib.ts";
import { F_ORDER, S_OF_F, TRIAL_STEP3 } from "./lawsearch-rules.ts";
import { bigmoveDefault, xDn, xUp } from "./lawsearch-ind.ts";
import type { FilterBuild, FilterDef, Ind, ItemBuild, ItemDef, ItemKind, ItemParams, TfKey, TrialDef, TrialKind, Tri } from "./lawsearch-types.ts";

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
    out.push({ id: w.id, order: k + 1, tf: TF_OF[w.tf], kind: w.kind, e: w.e, f: w.f, s: w.s, b: w.b, name: r.name });
  }
  return out;
}

// ---- the definitions -----------------------------------------------------------------------------------------

const triOf = (n: number, f: (i: number) => number): Tri => {
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
};

// E01–E06 rsi_back_p_L (spec 4.1): buy X↑(RSI_p, L), sell X↓(RSI_p, 100 − L); a cross item (spec 5); warm-up p + 1
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

const ITEM_MAP: ReadonlyMap<string, ItemDef> = new Map<string, ItemDef>([
  ["E04", rsiBack("E04", 14, 30)],
  ["E26", donchianA("E26", 20)],
  ["B06", bigmoveItem("B06")],
]);
const FILTER_MAP: ReadonlyMap<string, FilterDef> = new Map<string, FilterDef>([
  ["F00", f00],
  ["F01", f01],
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

// the items written now (spec 19 step 3): E04, E26, B06
export const ITEMS: ReadonlyMap<string, ItemDef> = ITEM_MAP;
// the filters written now: F00, F01
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
