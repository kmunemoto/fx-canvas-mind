// #206 (docs §8.103 5・6・7): stage 2 on the bars — each email's values for ② (its P moved past Rakuten's stop,
// the end of the last 1-minute bar by P + 24 hours, the value a day after P at the mid and at the exit side,
// entered and out at TP within the day), the checks of 7 (8) (the mid value cut after its bar; the period of
// v inside T's week), the rule's account rows (§8.102's decision path, the avoided emails not ordered), the
// spreads of the period by slot, and the print (only the items 5 lists) and the per-email CSV.
// The pieces with no price are in costhours-lib.ts; the paths, the account and the bars are §8.102's.

import { DAY, MINUTE } from "./lib.ts";
import { nyClosesBetween } from "./money-trades.ts";
import { weekOf } from "./money-stats.ts";
import { type M1, PAIRS, type Sig, unitOf } from "./ownerhold-data.ts";
import { type Book, type Cut, NO_CUT, type Path, follow, lastEnded, makeBook, valueAt } from "./ownerhold-trades.ts";
import { type AccountOut, MAIN_OPTS, type Market, type OrderIn, runAccount } from "./ownerhold-account.ts";
import { accountLineOf } from "./ownerhold-report.ts";
import {
  DONE_ITEMS, type EmailIn, INTERVAL_P, type Judged, PRINT_ITEMS, REASONS, type Summary, WEEKLY_ITEMS, checkItems, judge, meansText,
  summaryOf, verdictOf, verdictText, win1dText,
} from "./costhours-lib.ts";
import { SEASONS, SLOTS, type Season, avoidKey, hhmm, seasonOf, slotOf, tickScale, twiceMedian } from "./spreadhours-lib.ts";

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "-");

// ---- each email's values ----------------------------------------------------------------------------------

// The value a day after P at the mid (5「1日後の値 v」); planted "midAhead": valued a minute past H (a look
// ahead the check below must catch)
export const vMidOf = (bk: Book, p: Path, dir: 1 | -1, H: number, cut: Cut = NO_CUT, plant = ""): number =>
  valueAt(bk, p, dir, plant === "midAhead" ? H + MINUTE : H, cut, "mid").v;

export interface Mails {
  sigs: Sig[];
  // each email's P before the stop moves it ((a), 2023: T + 2 minutes; (b): sentAt + 1 minute rounded up)
  P0: number[];
  // (b): each email's sentAt; else undefined
  sent?: number[];
}

// the stop's books of a run: Rakuten's daily stop over [from − 1 day, end), kept (the main rows')
export const booksOf = (m1s: M1[], from: number, end: number): Book[] => {
  const taus = Float64Array.from(nyClosesBetween(from - DAY, end).map((c) => c.tau));
  return m1s.map((m) => makeBook(m, taus, true));
};

export const emailsOf = (books: Book[], ms: Mails, end: number, plant = ""): { es: EmailIn[]; paths: Path[] } => {
  const paths: Path[] = [];
  const es: EmailIn[] = ms.sigs.map((s, i) => {
    const bk = books[s.pi];
    const p = follow(bk, { dir: s.dir, E: s.E, tp: s.tp, P: ms.P0[i] }, { fill: "touch", endMs: end });
    paths.push(p);
    const H = p.P + DAY;
    const j = lastEnded(bk.m, H);
    const in1d = !p.none && p.fillK !== -2 && (p.fillK >= 0 ? bk.m.t[p.fillK] + MINUTE <= H : p.t0 <= H);
    return {
      T: s.T,
      pair: s.pair,
      dir: s.dir,
      P: p.P,
      sent: ms.sent?.[i],
      none: p.none,
      lastEnd: j >= 0 ? bk.m.t[j] + MINUTE : -Infinity,
      vMid: vMidOf(bk, p, s.dir, H, NO_CUT, plant),
      vExit: valueAt(bk, p, s.dir, H).v,
      in1d,
      tp1d: in1d && p.tpK >= 0 && p.x + MINUTE <= H,
    };
  });
  return { es, paths };
};

// 7 (8): every mid value taken again with everything after its bar rewritten (both ways): the path followed
// on the cut prices and valued there
export const midLookAhead = (books: Book[], ms: Mails, paths: Path[], end: number, plant = "") => {
  const out = { compared: 0, moved: 0, examples: [] as string[] };
  ms.sigs.forEach((s, i) => {
    const p = paths[i];
    if (p.none) return;
    const bk = books[s.pi];
    const H = p.P + DAY;
    const want = vMidOf(bk, p, s.dir, H, NO_CUT, plant);
    for (const poison of [777.7 * bk.unit, -777.7 * bk.unit]) {
      const c: Cut = { k: lastEnded(bk.m, H), full: true, poison };
      const q = follow(bk, { dir: s.dir, E: s.E, tp: s.tp, P: ms.P0[i] }, { fill: "touch", endMs: end }, c);
      const got = vMidOf(bk, q, s.dir, H, c, plant);
      out.compared++;
      if (got !== want && !(Number.isNaN(got) && Number.isNaN(want))) {
        out.moved++;
        if (out.examples.length < 5) out.examples.push(`${s.pair} ${iso(s.T)} ${poison > 0 ? "+" : "-"}`);
      }
    }
  });
  return out;
};

// 5「区間」: the counted emails whose period of v (P to its evaluation bar) leaves T's week
export const weekOutside = (es: readonly EmailIn[], js: readonly Judged[]): { n: number; examples: string[] } => {
  const out = { n: 0, examples: [] as string[] };
  js.forEach((j, i) => {
    if (!j.counted) return;
    const e = es[i];
    const w = weekOf(e.T);
    if (weekOf(e.P) === w && (e.lastEnd === -Infinity || weekOf(e.lastEnd - MINUTE) === w)) return;
    out.n++;
    if (out.examples.length < 5) out.examples.push(`${e.pair} ${iso(e.T)} P ${iso(e.P)}`);
  });
  return out;
};

// ---- the rule's account rows (5「口座（参考）」) -------------------------------------------------------------

export interface RuleAccounts {
  none: AccountOut;
  rule: AccountOut;
  // the emails the rule did not order (their path not nothing, P avoided); each email ordered by the rule's row
  notOrdered: number;
  ruleOrdered: boolean[];
  lines: Record<"none" | "rule", ReturnType<typeof ruleLineOf>>;
  // lookAheadAccount on both rows: what the clock had not reached rewritten changes nothing
  cut: { ok: boolean; poisoned: number; changed: number };
}

const PLACED = new Set(["tp", "lc", "deadline", "held", "unfilled", "cancelCall", "cancelLc"]);
// each email's fate by its index ("none": not ordered), as analyse hands accountLineOf
const ruleLineOf = (a: AccountOut, orders: OrderIn[], start: number, Ts: number[], end: number) => {
  const fates = Ts.map(() => "none") as AccountOut["fates"];
  orders.forEach((x, k) => (fates[x.sig] = a.fates[k]));
  const l = accountLineOf({ ...a, fates }, start, Ts, end, PAIRS.map((p) => unitOf(p)));
  const placed = fates.filter((f) => PLACED.has(f)).length;
  const emails = Ts.length;
  return { fatesBy: fates as string[], S: l.S, lcs: l.lcs, deadlines: l.deadlines, capped: l.capped, depositTotal: l.depositTotal, placed, emails, placedShare: emails ? placed / emails : null, winRate: l.winRate, pips: l.pips, yen: l.yen, outcomes: l.outcomes, fates: l.fates };
};

// `start`: the account's start (2023: START; (b): its own S_b), `end`: END
export const ruleAccounts = (m1s: M1[], ms: Mails, paths: Path[], js: readonly Judged[], start: number, end: number, plant = ""): RuleAccounts => {
  const closes = nyClosesBetween(start - DAY, end);
  const mk: Market = { books: m1s, closes, split: end, end, from: start };
  const o = { ...MAIN_OPTS, start: 300_000, cap: 1_000_000 };
  const all: OrderIn[] = ms.sigs.map((s, i) => ({ sig: i, pi: s.pi, dir: s.dir, E: s.E, tp: s.tp, P: ms.P0[i] }));
  const oNone = all.filter((_x, i) => !paths[i].none);
  // planted: the rule's row orders the avoided emails too
  const oRule = oNone.filter((x) => plant === "ruleOrdersAvoided" || !js[x.sig].avoided);
  const none = runAccount(mk, oNone, o);
  const rule = runAccount(mk, oRule, o);
  const Ts = ms.sigs.map((s) => s.T);
  let poisoned = 0;
  let changed = 0;
  for (const [orders, base] of [[oNone, none], [oRule, rule]] as const) {
    for (const pp of [777.7, -777.7]) {
      const c = runAccount(mk, orders, { ...o, poisonPips: pp });
      poisoned += c.poisoned;
      if (JSON.stringify({ ...c, poisoned: 0 }) !== JSON.stringify({ ...base, poisoned: 0 })) changed++;
    }
  }
  return {
    none,
    rule,
    notOrdered: oNone.length - ms.sigs.filter((_s, i) => !paths[i].none && !js[i].avoided).length,
    ruleOrdered: (() => {
      const by = ms.sigs.map(() => false);
      for (const x of oRule) by[x.sig] = true;
      return by;
    })(),
    lines: { none: ruleLineOf(none, oNone, 300_000, Ts, end), rule: ruleLineOf(rule, oRule, 300_000, Ts, end) },
    cut: { ok: poisoned === 0 && changed === 0, poisoned, changed },
  };
};

// ---- the spreads of the period, by slot (5「2023年のスプレッド」) -----------------------------------------------

export interface SpreadPair {
  pair: string;
  // twice the median, 0.1 pips, of every bar in an avoided slot, and in a kept one (null: none)
  avoided2: number | null;
  kept2: number | null;
  avoidedBars: number;
  hasAvoided: boolean;
  thr2: number | null;
  slots: Array<{ season: Season; slot: number; bars: number; med2: number | null; avoided: boolean }>;
}
// the bars that open in [from, to), each judged in its own slot and season
export const spreadsOf = (m1s: M1[], avoid: ReadonlySet<string>, thr2: ReadonlyMap<string, number> | null, from: number, to: number): SpreadPair[] =>
  m1s.map((m) => {
    const sc = tickScale(m.pair);
    const cells: number[][] = Array.from({ length: 2 * SLOTS }, () => []);
    for (let k = 0; k < m.n; k++) {
      const t = m.t[k];
      if (t < from || t >= to) continue;
      cells[(seasonOf(t) === "summer" ? 0 : SLOTS) + slotOf(t)].push(Math.round((m.ac[k] - m.bc[k]) * sc));
    }
    const av: number[] = [];
    const kp: number[] = [];
    const slots: SpreadPair["slots"] = [];
    let hasAvoided = false;
    cells.forEach((xs, c) => {
      const season = SEASONS[c < SLOTS ? 0 : 1];
      const slot = c % SLOTS;
      const a = avoid.has(avoidKey(m.pair, season, slot));
      if (a) hasAvoided = true;
      (a ? av : kp).push(...xs);
      if (xs.length) slots.push({ season, slot, bars: xs.length, med2: twiceMedian([...xs].sort((x, y) => x - y)), avoided: a });
    });
    av.sort((x, y) => x - y);
    kp.sort((x, y) => x - y);
    return { pair: m.pair, avoided2: twiceMedian(av), kept2: twiceMedian(kp), avoidedBars: av.length, hasAvoided, thr2: thr2?.get(m.pair) ?? null, slots };
  });

// ---- the print and the CSV ------------------------------------------------------------------------------

const f2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(2));
const pct = (x: number | null) => (x === null ? "-" : (100 * x).toFixed(1));
const yen = (x: number | null) => (x === null ? "-" : Math.round(x).toLocaleString("en-US"));
const pips2 = (x2: number | null) => (x2 === null ? "-" : (x2 / 20).toFixed(2));

export interface PrintIn {
  where: string;
  kind: "2023" | "b";
  s: Summary;
  spreads: SpreadPair[];
  acc: RuleAccounts;
  // 5「数字の後の調べ」: what was compared, and whether everything held
  after: string[];
  checks: Record<string, boolean>;
  sha256: Record<string, string>;
  weeks: number;
}
export type Item = { item: string; text: string };

export const printItemsOf = (x: PrintIn, plant = ""): Item[] => {
  const s = x.s;
  const items: Item[] = [];
  const add = (item: string, text: string) => items.push({ item, text });
  add("checks", Object.entries(x.checks).map(([k, ok]) => `${k}: ${ok ? "ok" : "FAILED"}`).join("\n"));
  add("sha256", Object.entries(x.sha256).map(([k, h]) => `${k} ${h}`).join("\n"));
  add("verdict", verdictText(s, x.where, "ルールを決めたときに見ていないデータ"));
  add("means", meansText(s).join("\n"));
  add("win1d", win1dText(s));
  add("spread", x.spreads.map((p) => {
    if (!p.hasAvoided) return `${p.pair}: 避ける枠なし（残した枠の中央値 ${pips2(p.kept2)} pips）`;
    const lines = [`${p.pair}: ${x.kind === "2023" ? "2023年の" : "この期間の"}、避けた枠のスプレッドの中央値は ${pips2(p.avoided2)} pips（${p.avoidedBars} 本）、残した枠は ${pips2(p.kept2)} pips`];
    if (p.avoided2 !== null && p.thr2 !== null && p.avoided2 < p.thr2) lines.push(`  ${p.pair}では、${x.kind === "2023" ? "2023年の" : "この期間の"}この時間は、ルールを決めた 2024〜2026年ほど広くなかった（しきい値 ${pips2(p.thr2)} pips）`);
    return lines.join("\n");
  }).join("\n"));
  add("spreadSlots", x.spreads.map((p) => [`${p.pair} (season slot utc bars median pips avoided)`, ...p.slots.map((c) => `  ${c.season} ${c.slot} ${hhmm(c.slot)} ${c.bars} ${pips2(c.med2)} ${c.avoided ? "yes" : "no"}`)].join("\n")).join("\n"));
  const a = x.acc.lines;
  const ends = (l: typeof a.none) => Object.entries(l.outcomes).map(([k, v]) => `${k} ${v}`).join("・") || "なし";
  add("account", `30万円の口座（§8.102 の判断の道筋の作りで、${x.kind === "2023" ? "START から END まで" : "R 以後のメールで"}）: ルールなし ${yen(a.none.S)} 円・ロスカット ${a.none.lcs} 回・期限の決済 ${a.none.deadlines} 回・上限で入金し切れなかった追証 ${a.none.capped} 回、ルールあり ${yen(a.rule.S)} 円・${a.rule.lcs} 回・${a.rule.deadlines} 回・${a.rule.capped} 回（入金を引いた損益）。入れたお金の合計 ${yen(a.none.depositTotal)} 円・${yen(a.rule.depositTotal)} 円、置けた割合 ${pct(a.none.placedShare)}%・${pct(a.rule.placedShare)}%（ルールで注文しなかった ${x.acc.notOrdered} 件は、置けなかったメールと分けて数える）、勝率 ${pct(a.none.winRate)}%・${pct(a.rule.winRate)}%（1回あたり ${f2(a.none.pips)}・${f2(a.rule.pips)} pips、${yen(a.none.yen)}・${yen(a.rule.yen)} 円。終わり方: ルールなし ${ends(a.none)}、ルールあり ${ends(a.rule)}）。1本の道筋で約${x.weeks}週だけなので、幅は付けず、判断には使わない。`);
  add("closing", x.kind === "2023"
    ? "これは約8週（すべて米国の冬時間。感謝祭と年末を含む）・GMO の値段・P から1日後の値での結果。楽天での成績や、口座が増えるかを確かめたものではない。ドル円の 2023年11〜12月は、§8.96（ゴトー日）で一部を見たデータ。ルールを使っていく確かめは (b) で行う。"
    : `これは ${x.where}（約${x.weeks}週）・GMO の値段・P から1日後の値での結果。楽天での成績や、口座が増えるかを確かめたものではない。`);
  add("notCounted", `すべてのメール ${s.emails} 通、数えた ${s.counted} 通（避けた ${s.countedAvoided}・残した ${s.kept}）。数えなかった（理由の順に1つ）: ${REASONS.map((r) => `${r} ${s.notCounted[r]}`).join("・")}`);
  add("evalEarlyDates", s.evalEarlyDates.length ? s.evalEarlyDates.join(", ") : "なし");
  add("underBars", `1,000本より少ない枠に P が入ったメール ${s.underBars} 通`);
  add("byPair", Object.entries(s.byPair).map(([k, v]) => `${k}: 避けた ${v.avoided}・残した ${v.kept}`).join("\n"));
  add("byWeek", Object.entries(s.byWeek).sort().map(([k, v]) => `${k.slice(0, 10)}: 避けた ${v.avoided}・残した ${v.kept}`).join("\n"));
  add("deltaExit", `決済する側の値段で評価した v での Δ ${f2(s.deltaExit)} pips（点だけ）。決済する側で評価すると、避けたメールは、評価の時刻の広がりの分だけ悪く出る作り。`);
  if (x.kind === "2023") add("delta4", `ドル円を除いた4ペアの Δ ${f2(s.delta4.m)} pips（点だけ。そろえた避けたメール ${s.delta4.n} 通）。ドル円の 2023年は §8.96 で一部を見たデータなので、それを除いた数字。`);
  add("after", x.after.join("\n"));
  // planted (7 (9)): ③'s d in the print — the list of allowed items must stop it
  if (plant === "printD") add("thirdD", "d");
  return items;
};

// the print, only once every item is on the list (5「見る数字を絞る」; throws before anything is written)
export const printTextOf = (items: Item[]): string => {
  checkItems(items, PRINT_ITEMS as unknown as string[]);
  return items.map((x) => `== ${x.item}\n${x.text}`).join("\n\n") + "\n";
};

// (b)'s weekly ② output (6「毎週の run」): five items before the comparing run, one after it
export const weeklyItemsOf = (s: Summary, kind: "before" | "compare" | "done", compareEnd: number | null, plant = ""): Item[] => {
  if (kind === "done") return [{ item: "done", text: `② の比べは END_b ＝ ${iso(compareEnd!).slice(0, 10)} の run で済んだ` }];
  const items: Item[] = [
    { item: "alignedAvoided", text: String(s.aligned) },
    { item: "weeks", text: String(s.weeks) },
    { item: "kept", text: String(s.kept) },
    { item: "enough", text: s.enough ? "yes" : "no" },
    { item: "compareRun", text: kind === "compare" ? "yes" : "no" },
  ];
  // planted: Δ every week — the weekly list must stop it
  if (plant === "bWeeklyDelta") items.push({ item: "delta", text: f2(s.delta.m) });
  checkItems(items, WEEKLY_ITEMS as unknown as string[]);
  return items;
};
export const doneItemsOk = (items: Item[]) => checkItems(items, DONE_ITEMS as unknown as string[]);

// research/ledger/ultra15-2023.csv: the signal's side only
export const CSV_2023_HEADER = "T,pair,side,P,season,slot,avoided,counted,reason,vMid,vExit";
export const csv2023Of = (es: readonly EmailIn[], js: readonly Judged[]): string =>
  [CSV_2023_HEADER, ...es.map((e, i) => {
    const j = js[i];
    return [iso(e.T), e.pair, e.dir === 1 ? "BUY" : "SELL", iso(e.P), j.season, hhmm(j.slot), j.avoided ? "yes" : "no", j.counted ? "yes" : "no", j.reason ?? "", String(e.vMid), String(e.vExit)].join(",");
  })].join("\n") + "\n";

// every number of ② for the Python (its own reading compared to these)
export const costDumpOf = (es: readonly EmailIn[], js: readonly Judged[], s: Summary, acc: RuleAccounts | null, spreads: SpreadPair[] | null): Record<string, string> => ({
  "cost-emails.csv": ["i,P,season,slot,avoided,reason,counted,aligned,cell,x,xExit,vMid,vExit,lastEnd,in1d,tp1d", ...es.map((e, i) => {
    const j = js[i];
    return [i, e.P, j.season, j.slot, +j.avoided, j.reason ?? "", +j.counted, +j.aligned, j.cell, j.x ?? "", j.xExit ?? "", e.vMid, e.vExit, e.lastEnd, +e.in1d, +e.tp1d].join(",");
  })].join("\n"),
  "cost-summary.json": JSON.stringify({ ...s, verdict: verdictOf(s), intervalP: INTERVAL_P }),
  ...(acc ? { "cost-accounts.json": JSON.stringify({ notOrdered: acc.notOrdered, lines: acc.lines, cut: acc.cut }) } : {}),
  ...(spreads ? { "cost-spreads.json": JSON.stringify(spreads) } : {}),
});

export { judge, summaryOf };
