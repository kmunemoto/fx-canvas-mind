// #206 (docs §8.103 5・6・7): stage 2's pieces with no price in them — which emails are counted and why not,
// whether an email is avoided (from its P and the fixed file only), its cell, Δ and its interval, the sentences
// written beforehand, and the items a print may hold. The values (v) come in from research/costhours.ts.
//
//   * avoided (5, 7 (8)): the slot of P (the order's time, moved past Rakuten's stop) in the season of P, in
//     the file's slots of the pair; no price is handed in.
//   * not counted, the first reason only, in this order (5「数えるメール」): the path is nothing at all; P on
//     a Friday (UTC); P + 24 hours after END; the evaluation came early (the end of the last 1-minute bar
//     ended by P + 24 hours at least 60 minutes before min(P + 24 hours, the first GMO weekend start after P),
//     bar times only); and, for an avoided email only, no counted kept email in its cell.
//   * the cell: (the week of T — Sunday 21:00 UTC, weekOf —, the pair, the side); x = v − the mean v of the
//     cell's counted kept emails; Δ = the mean x; its interval t(C − 1), two-sided, clustered by T's week.

import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET } from "./lib.ts";
import { nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import { clustered, intervalOf, weekOf } from "./money-stats.ts";
import { CSV_HEADER, MIN_BARS, SEASONS, SLOTS, type Season, avoidKey, hhmm, parseSpreadHours, seasonOf, sha256Hex, slotOf } from "./spreadhours-lib.ts";

// ---- the fixed times and numbers (TS and Python each hold their own; neither from an input) ----------------

// 5: 2023's period; its 15-minute bars from START − LEAD15 (12 days); the day files each read may open
export const Y23_START = Date.parse("2023-11-08T00:00:00Z");
export const Y23_END = Date.parse("2023-12-30T00:00:00Z");
export const Y23_FROM15 = Date.parse("2023-10-27T00:00:00Z");
export const Y23_KEYS_M1 = ["20231106", "20231230"] as const;
export const Y23_KEYS_M15 = ["20231026", "20231230"] as const;
// 6: R (the first 00:00 UTC after this rule was merged, PR #175 at 2026-10-07 10:24:27 UTC), the deadline
// END_b, the count that makes a run the comparing run
export const R_MS = Date.parse("2026-10-08T00:00:00Z");
export const END_B_DEADLINE = Date.parse("2027-03-13T00:00:00Z");
export const COMPARE_AT = 100;
// 5「足りる数」
export const ENOUGH_EMAILS = 30;
export const ENOUGH_WEEKS = 5;
// 7 (4): the interval's side (0.975 two-sided 95%; 0.995 only if the synthetic walks of (4) say so)
export const INTERVAL_P = 0.975;
// 7 (0): research/ledger/spread-hours.csv's sha256 (step 3: stage 1's real run 37634829079, whose file the Python
// agreed with). Were it empty, the 2023 mode would stop before it reads GMO and the weekly (b) run write no ② row.
export const SPREAD_HOURS_PATH = "research/ledger/spread-hours.csv";
export const SPREAD_HOURS_SHA256 = "2b325574297a9891bc4760717ab3f6e3891d073725b01b46b0faa7b89605bb93";

// 7 (0), (6): the provisional slots the synthetic modes alone read (never research/ledger/spread-hours.csv):
// every pair, New York's 17:00 hour (summer 21:00-21:59 UTC, winter 22:00-22:59), and (6)'s wide one, four
// hours a day holding it (summer 18:00-21:59, winter 19:00-22:59)
const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
export const PROVISIONAL_1H: Record<Season, number[]> = { summer: span(84, 87), winter: span(88, 91) };
export const PROVISIONAL_4H: Record<Season, number[]> = { summer: span(72, 87), winter: span(76, 91) };

// a provisional file in spread-hours.csv's form: the slots given avoided, 5,000 bars in every slot, the other
// columns filler (stage 2 reads the pair, the season, the slot, the bars and whether it is avoided)
export const provisionalCsv = (pairs: readonly string[], slots: Record<Season, number[]>): string => {
  const lines = [CSV_HEADER];
  for (const pair of pairs) {
    for (const season of SEASONS) {
      for (let slot = 0; slot < SLOTS; slot++) {
        const avoid = slots[season].includes(slot);
        lines.push([pair, season, slot, hhmm(slot), 5000, avoid ? "9.00" : "1.00", avoid ? "9.0000" : "1.0000", avoid ? "9.0" : "1.0", "1.00", "3.00", avoid ? "yes" : "no"].join(","));
      }
    }
  }
  return lines.join("\n") + "\n";
};

// ---- the file of the slots ------------------------------------------------------------------------------

export interface SlotsFile {
  avoid: Set<string>;
  // each slot's bars (2024-2026), for the count of emails whose P fell in a slot under 1,000 bars
  bars: Map<string, number>;
  // each pair's threshold, twice, in 0.1 pips (2024-2026): 2023's spreads are set beside it
  thr2: Map<string, number>;
}
export const readSlotsFile = (text: string, pairs: readonly string[]): SlotsFile => {
  const avoid = parseSpreadHours(text, pairs);
  const bars = new Map<string, number>();
  const thr2 = new Map<string, number>();
  for (const l of text.split("\n").filter((x) => x !== "").slice(1)) {
    const c = l.split(",");
    const n = Number(c[4]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`spread-hours.csv: bars ${c[4]}`);
    bars.set(avoidKey(c[0], c[1] as Season, Number(c[2])), n);
    const t2 = Math.round(Number(c[9]) * 20);
    if (!Number.isFinite(t2) || Math.abs(Number(c[9]) * 20 - t2) > 1e-9) throw new Error(`spread-hours.csv: threshold ${c[9]}`);
    const was = thr2.get(c[0]);
    if (was !== undefined && was !== t2) throw new Error(`spread-hours.csv: ${c[0]} has two thresholds`);
    thr2.set(c[0], t2);
  }
  return { avoid, bars, thr2 };
};

// The rule's file, only when its sha256 is the one written in the program (7 (0)): an empty constant, a slot
// changed or a provisional file put at the path all stop here, before any price is read.
export class RuleFileError extends Error {}
export const ruleFileOf = async (text: string, pairs: readonly string[], want: string): Promise<SlotsFile> => {
  if (!want) throw new RuleFileError("the sha256 of spread-hours.csv is not written in the program yet (stage 1 not committed)");
  const got = await sha256Hex(text);
  if (got !== want) throw new RuleFileError(`spread-hours.csv: sha256 ${got}, not the ${want} written in the program`);
  return readSlotsFile(text, pairs);
};

// ---- the times ------------------------------------------------------------------------------------------

// the first GMO weekend start after t: Friday 20:00 UTC in the US summer, 21:00 otherwise (synthOpen's)
export const gmoWeekendAfter = (t: number): number => {
  const d = new Date(t);
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (let k = 0; k <= 7; k++) {
    const day = day0 + k * DAY;
    if (new Date(day).getUTCDay() !== 5) continue;
    const at20 = day + 20 * HOUR;
    const ws = nyOffsetMs(at20) === -4 * HOUR ? at20 : day + 21 * HOUR;
    if (ws > t) return ws;
  }
  throw new Error(`no Friday after ${new Date(t).toISOString()}`);
};
// 5 理由 4: `lastEnd` the end of the last 1-minute bar ended by P + 24 hours (−Infinity: none)
export const evalEarly = (P: number, lastEnd: number): boolean => lastEnd <= Math.min(P + DAY, gmoWeekendAfter(P)) - 60 * MINUTE;
export const isFriday = (t: number): boolean => new Date(t).getUTCDay() === 5;

// ---- the emails -----------------------------------------------------------------------------------------

export interface EmailIn {
  // the signal bar's close, the pair, the side; P (moved past Rakuten's stop: the path's)
  T: number;
  pair: string;
  dir: 1 | -1;
  P: number;
  // (b): the time the email was sent (the run's END_b and R select on it); (a)'s and 2023's: undefined
  sent?: number;
  // the path is nothing at all (P at or past END, or no bar before P)
  none: boolean;
  // the end of the last 1-minute bar ended by P + 24 hours (−Infinity: none)
  lastEnd: number;
  // the value a day after P, pips, the signal's side: held trades at the mid close (main) and at the exit side's
  vMid: number;
  vExit: number;
  // entered by P + 24 hours; out at TP by then
  in1d: boolean;
  tp1d: boolean;
}

export const REASONS = ["none", "friday", "pastEnd", "evalEarly", "noKept"] as const;
export type Reason = (typeof REASONS)[number];

export interface Judged {
  season: Season;
  slot: number;
  avoided: boolean;
  // the first reason it is not counted, or null (counted); "noKept" only on an avoided email
  reason: Reason | null;
  // counted (none of the first four) and, for an avoided one, aligned (a counted kept email in its cell)
  counted: boolean;
  aligned: boolean;
  cell: string;
  // an aligned email's v less its cell's counted kept mean (main and exit-side); null otherwise
  x: number | null;
  xExit: number | null;
}

export interface JudgeOpts {
  end: number;
  // a planted error of 7 (9) ("" for none)
  plant?: string;
}

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Each email's slot, whether avoided, why not counted, and its x (5). `avoid` the file's slots.
export const judge = (es: readonly EmailIn[], avoid: ReadonlySet<string>, o: JudgeOpts): Judged[] => {
  const plant = o.plant ?? "";
  const out: Judged[] = es.map((e) => {
    // planted: the slot of the signal bar's open (T − 15 minutes) instead of P's
    const at = plant === "slotFromOpen" ? e.T - 15 * MINUTE : e.P;
    const season = seasonOf(at);
    const slot = slotOf(at);
    const avoided = avoid.has(avoidKey(e.pair, season, slot));
    let reason: Reason | null = null;
    if (e.none) reason = "none";
    else if (isFriday(e.P) && plant !== "fridayIn") reason = "friday";
    else if (e.P + DAY > o.end && plant !== "pastEndIn") reason = "pastEnd";
    else if (evalEarly(e.P, e.lastEnd) && plant !== "holidayIn") reason = "evalEarly";
    const cell = plant === "noWeekCell" ? `${e.pair}|${e.dir}` : `${weekOf(e.T)}|${e.pair}|${e.dir}`;
    return { season, slot, avoided, reason, counted: reason === null, aligned: false, cell, x: null, xExit: null };
  });
  // the cells' counted kept emails (planted: every kept email whose path is not nothing, counted or not)
  const kept = new Map<string, { v: number[]; vx: number[] }>();
  out.forEach((j, i) => {
    if (j.avoided) return;
    if (!(plant === "keptMeanAll" ? j.reason !== "none" : j.counted)) return;
    const c = kept.get(j.cell) ?? { v: [], vx: [] };
    c.v.push(es[i].vMid);
    c.vx.push(es[i].vExit);
    kept.set(j.cell, c);
  });
  out.forEach((j, i) => {
    if (!j.avoided || !j.counted) return;
    const c = kept.get(j.cell);
    if (!c) {
      j.reason = "noKept";
      return;
    }
    j.aligned = true;
    // planted: v at the exit side's price as the main value
    const v = plant === "vExit" ? es[i].vExit : es[i].vMid;
    const mk = plant === "vExit" ? meanOf(c.vx)! : meanOf(c.v)!;
    j.x = v - mk;
    j.xExit = es[i].vExit - meanOf(c.vx)!;
  });
  return out;
};

// Δ and its interval: the aligned emails' x, clustered by T's week (planted "blocks4": by four weeks)
export const deltaOf = (es: readonly EmailIn[], js: readonly Judged[], plant = "", p = INTERVAL_P, keep: (e: EmailIn) => boolean = () => true) => {
  const xs: Array<{ x: number; week: number }> = [];
  js.forEach((j, i) => {
    if (j.aligned && keep(es[i])) xs.push({ x: j.x!, week: weekOf(es[i].T) });
  });
  const iv = intervalOf(clustered(xs), plant === "blocks4" ? "blocks" : "weeks", p);
  return { n: xs.length, weeks: new Set(xs.map((x) => x.week)).size, m: iv.m, lo: iv.lo, hi: iv.hi, C: iv.C };
};

export interface Summary {
  emails: number;
  notCounted: Record<Reason, number>;
  counted: number;
  countedAvoided: number;
  aligned: number;
  kept: number;
  weeks: number;
  enough: boolean;
  delta: { n: number; weeks: number; m: number | null; lo: number | null; hi: number | null; C: number };
  // beside it, points only (5「並べる数字」): Δ on the exit side's values; Δ of the four pairs without USD/JPY
  deltaExit: number | null;
  delta4: { n: number; m: number | null };
  means: Record<"avoided" | "kept" | "all", { n: number; mean: number | null; sum: number }>;
  win1d: Record<"avoided" | "kept", { of: number; tp: number; held: number; notIn: number; rate: number | null; pips: number | null }>;
  evalEarlyDates: string[];
  // emails (the path not nothing) whose P fell in a slot of fewer than 1,000 bars
  underBars: number;
  // counted avoided and counted kept, by pair and by week (the week's Sunday 21:00 UTC)
  byPair: Record<string, { avoided: number; kept: number }>;
  byWeek: Record<string, { avoided: number; kept: number }>;
}

const iso = (ms: number) => new Date(ms).toISOString();

export const summaryOf = (es: readonly EmailIn[], js: readonly Judged[], bars: ReadonlyMap<string, number> | null, plant = "", p = INTERVAL_P): Summary => {
  const notCounted = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<Reason, number>;
  for (const j of js) if (j.reason) notCounted[j.reason]++;
  const delta = deltaOf(es, js, plant, p);
  const exits = js.filter((j) => j.aligned).map((j) => j.xExit!);
  const d4 = deltaOf(es, js, plant, p, (e) => e.pair !== "USD/JPY");
  const group = (f: (j: Judged) => boolean) => {
    const vs = js.map((j, i) => (j.counted && f(j) ? es[i].vMid : null)).filter((v): v is number => v !== null);
    const sum = vs.reduce((s, v) => s + v, 0);
    return { n: vs.length, mean: vs.length ? sum / vs.length : null, sum };
  };
  const win = (f: (j: Judged) => boolean) => {
    let of = 0;
    let tp = 0;
    let n = 0;
    let pips = 0;
    js.forEach((j, i) => {
      if (!j.counted || !f(j)) return;
      n++;
      if (!es[i].in1d) return;
      of++;
      pips += es[i].vMid;
      if (es[i].tp1d) tp++;
    });
    return { of, tp, held: of - tp, notIn: n - of, rate: of ? tp / of : null, pips: of ? pips / of : null };
  };
  const byPair: Summary["byPair"] = {};
  const byWeek: Summary["byWeek"] = {};
  js.forEach((j, i) => {
    if (!j.counted) return;
    const k = j.avoided ? "avoided" : "kept";
    (byPair[es[i].pair] ??= { avoided: 0, kept: 0 })[k]++;
    (byWeek[iso(weekOf(es[i].T) * WEEK + WEEK_OFFSET)] ??= { avoided: 0, kept: 0 })[k]++;
  });
  const counted = js.filter((j) => j.counted).length;
  const countedAvoided = js.filter((j) => j.counted && j.avoided).length;
  return {
    emails: es.length,
    notCounted,
    counted,
    countedAvoided,
    aligned: delta.n,
    kept: counted - countedAvoided,
    weeks: delta.weeks,
    enough: delta.n >= ENOUGH_EMAILS && delta.weeks >= ENOUGH_WEEKS,
    delta,
    deltaExit: meanOf(exits),
    delta4: { n: d4.n, m: d4.m },
    means: { avoided: group((j) => j.avoided), kept: group((j) => !j.avoided), all: group(() => true) },
    win1d: { avoided: win((j) => j.avoided), kept: win((j) => !j.avoided) },
    evalEarlyDates: js.map((j, i) => (j.reason === "evalEarly" ? iso(es[i].P) : null)).filter((x): x is string => x !== null),
    underBars: bars ? js.filter((j, i) => !es[i].none && (bars.get(avoidKey(es[i].pair, j.season, j.slot)) ?? 0) < MIN_BARS).length : 0,
    byPair,
    byWeek,
  };
};

// ---- the sentences written beforehand (5「書く文」) ---------------------------------------------------------

export type Verdict = "short" | "worse" | "better" | "neither";
export const verdictOf = (s: Summary): Verdict => {
  if (!s.enough) return "short";
  if (s.delta.hi !== null && s.delta.hi < 0) return "worse";
  if (s.delta.lo !== null && s.delta.lo > 0) return "better";
  return "neither";
};
const f2 = (x: number | null) => (x === null ? "-" : x.toFixed(2));
// the interval's name: 95% (or 99%, if 7 (4) switched INTERVAL_P)
const IV = `${Math.round(200 * INTERVAL_P - 100)}%区間`;
const pct = (x: number | null) => (x === null ? "-" : (100 * x).toFixed(1));
// `where`: 「2023年11〜12月」 or 「これからのメール（R〜END_b）」
export const verdictText = (s: Summary, where: string, unseen: string): string => {
  const d = s.delta;
  switch (verdictOf(s)) {
    case "short":
      return `${where}では、避けた時間帯のメールが ${s.aligned} 通（${s.weeks} 週）で、決めた数（30通・5週）に届かない。このデータでは、ルールが効くかは言えない。`;
    case "worse":
      return `${where}（${unseen}）では、避けた時間帯のメールは、同じ週・同じペア・同じ向きの残したメールより、P から1日後の値が1通あたり ${f2(-d.m!)} pips 悪かった（${IV} ${f2(-d.hi!)}〜${f2(-d.lo!)} pips。避けた ${s.aligned} 通・${s.weeks} 週）。1日後の時点の比べで、利確まで持った最後の損益の比べではない。時刻の違うメールどうしの比べなので、スプレッドのせいか、その時刻のほかの性質のせいかは分けられない。`;
    case "better":
      return `${where}では、避けた時間帯のメールの方が、1日後の値が1通あたり ${f2(d.m)} pips 良かった（${IV} ${f2(d.lo)}〜${f2(d.hi)} pips。${s.aligned} 通・${s.weeks} 週）。このルールは、良いメールを外す側だった。`;
    case "neither": {
      const far = Math.abs(d.lo!) >= Math.abs(d.hi!) ? d.lo! : d.hi!;
      return `${where}では、避けた時間帯のメールが悪いとも良いとも言えない（差 ${f2(d.m)} pips、${IV} ${f2(d.lo)}〜${f2(d.hi)} pips。${s.aligned} 通・${s.weeks} 週）。区間（${f2(d.lo)}〜${f2(d.hi)} pips）の中のどの差も、このデータと合う。1通あたり ${f2(far)} pips くらいの差があっても、この数では見分けられなかったことがありうる。差が無いという意味ではない。`;
    }
  }
};
// 「どの場合も」: the means and sums, and what avoiding would do to them
export const meansText = (s: Summary): string[] => {
  const a = s.means.avoided;
  const k = s.means.kept;
  const all = s.means.all;
  const out: string[] = [];
  out.push(`数えたメールのうち、避けたメールは ${a.n} 通（うち、そろえた ${s.aligned} 通）で、1日後の値の平均は ${f2(a.mean)} pips（合計 ${f2(a.sum)} pips）。残したメールは ${k.n} 通で、平均 ${f2(k.mean)} pips。この2つの平均は、週・ペア・向きをそろえていないので、相場の上げ下げの差が混ざる。判断は Δ で行う。`);
  if (a.mean !== null && a.mean > 0) out.push("避けたメールも、平均では1日後に勝っていた。");
  const way = all.mean === null || k.mean === null ? "変わらず" : k.mean > all.mean ? "上がり" : k.mean < all.mean ? "下がり" : "変わらず";
  const tot = -a.sum;
  const totWay = tot > 0 ? `${f2(tot)} pips 増える` : tot < 0 ? `${f2(-tot)} pips 減る` : "変わらない";
  out.push(`このデータで避けると（そろえずに数えると）、1通あたりの平均は ${f2(all.mean)} pips から ${f2(k.mean)} pips に${way}、合計は ${totWay}。`);
  return out;
};
export const win1dText = (s: Summary): string => {
  const w = (x: Summary["win1d"]["kept"]) => `${pct(x.rate)}%（${x.of} 件中 ${x.tp} 件。1回あたり ${f2(x.pips)} pips。1日の時点でまだ持っている ${x.held} 件、1日以内に入らなかった ${x.notIn} 件）`;
  return `1日以内の勝率（数えたメールのうち、P から1日以内に入った取引で、1日以内に利確した割合）: 避けたメール ${w(s.win1d.avoided)}、残したメール ${w(s.win1d.kept)}。損切りが無いので、作りの上で高く出る。ルールが効く証拠でも、この持ち方がうまくいく証拠でもない。`;
};

// ---- the items a print may hold (5「見る数字を絞る」, 6「毎週の run」) ---------------------------------------

// 2023 (and (b)'s comparing run): the sentences and the numbers 5 writes, nothing else
export const PRINT_ITEMS = [
  "checks", "sha256", "verdict", "means", "win1d", "spread", "spreadSlots", "account", "closing",
  "notCounted", "evalEarlyDates", "underBars", "byPair", "byWeek", "deltaExit", "delta4", "after",
] as const;
// (b)'s weekly run before the comparing one: five outputs only; after it: one line
export const WEEKLY_ITEMS = ["alignedAvoided", "weeks", "kept", "enough", "compareRun"] as const;
export const DONE_ITEMS = ["done"] as const;
export class PrintItemsError extends Error {}
// stops (throws) on an item not in the list, before anything is printed
export const checkItems = (items: ReadonlyArray<{ item: string }>, allowed: readonly string[]): void => {
  const bad = items.map((x) => x.item).filter((k) => !allowed.includes(k));
  if (bad.length) throw new PrintItemsError(`items not allowed in this print: ${bad.join(", ")}`);
};

// ---- (b): which run compares (6「比べるのは1回だけ」) ----------------------------------------------------------

export type BStatus = { kind: "before" | "compare" | "done"; compareEnd: number | null };
// `alignedAt(e)`: the aligned avoided emails counted with END_b = e (the emails sent before e). The comparing
// run: the first Saturday END_b (from R on) whose count reached 100 — the one before it under 100 — or the
// deadline if none had by then. Planted: "bCompareEvery" (every run at 100 or over compares), "bNoDeadline".
export const bStatusOf = (endB: number, alignedAt: (e: number) => number, plant = ""): BStatus => {
  const first = firstSaturdayAfter(R_MS);
  if (plant === "bCompareEvery") return { kind: alignedAt(endB) >= COMPARE_AT ? "compare" : "before", compareEnd: null };
  for (let e = first; e <= endB; e += WEEK) {
    const deadline = e === END_B_DEADLINE && plant !== "bNoDeadline";
    if (alignedAt(e) >= COMPARE_AT || deadline) return { kind: e === endB ? "compare" : "done", compareEnd: e };
  }
  return { kind: "before", compareEnd: null };
};
export const firstSaturdayAfter = (t: number): number => {
  let d = Math.floor(t / DAY) * DAY;
  if (d <= t) d += DAY;
  while (new Date(d).getUTCDay() !== 6) d += DAY;
  return d;
};
