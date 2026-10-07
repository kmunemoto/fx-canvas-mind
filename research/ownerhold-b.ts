// #205 (docs §8.102 (b) and 「(b) のプログラムの細部」): the emails sent, from research/ledger/ultra15.csv.
// The pieces that do not need the bars: the ledger's rows and their checks, each row's signal (P is sentAt
// + 1 minute rounded up to the minute), the recomputed signals set beside the emails, the time from a bar's
// close to its email, and the one comparison with (a): the value a day after P, against the weeks of
// research/ledger/ultra15-a.csv. research/ownerhold.ts (MODE=b) reads the bars and runs the accounts.

import { DAY, MINUTE, WEEK } from "./lib.ts";
import { medianOf, quantile } from "./money-stats.ts";
import { PAIRS, type Side, type Sig, digitsOf, unitOf } from "./ownerhold-data.ts";
import { ULTRA_PAIRS, ultraLevels } from "../supabase/functions/_shared/ultra.ts";

const STEP15 = 15 * MINUTE;
export const LEDGER_HEADER = "pair,side,open,T,E,sentAt";
// the rows written: sent from 2026-10-05 16:17 UTC on (§8.102 (b) 書き出す行)
export const LEDGER_FROM = Date.parse("2026-10-05T16:17:00Z");
// the comparison: the week start W0 (Sunday 21:00 UTC), (a)'s period and its file, the count it waits for
export const W0 = Date.parse("2026-10-04T21:00:00Z");
export const A_START = Date.parse("2024-01-01T00:00:00Z");
export const A_END = Date.parse("2026-10-03T00:00:00Z");
export const A_HEADER = "T,pair,side,P,week,v1d";
export const A_SHA256 = "ce4c6acee90bdef30f616b6a018ae34864d4e48d3c443dcfc7e6d27988be70c2";
export const COMPARE_AT = 30;

const iso = (ms: number) => new Date(ms).toISOString();
const isPair = (x: string) => (PAIRS as readonly string[]).includes(x);

export interface LedgerRow {
  pair: string;
  side: Side;
  // the bar's start and close (T), the email's entry, the time it was sent (ms)
  open: number;
  T: number;
  E: number;
  sent: number;
}

// The ledger as Claude writes it from the database: the header, then one row an email in sentAt order.
// Anything else is an input error (a bad cell, a row twice, a time out of order, an email before its close).
export const parseLedger = (text: string): LedgerRow[] => {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l !== "");
  if (lines[0] !== LEDGER_HEADER) throw new Error(`ledger: the header is ${JSON.stringify(lines[0])}, not ${LEDGER_HEADER}`);
  const seen = new Set<string>();
  const rows: LedgerRow[] = [];
  lines.slice(1).forEach((l, k) => {
    const c = l.split(",");
    const at = `ledger row ${k + 1}`;
    if (c.length !== 6) throw new Error(`${at}: ${c.length} cells`);
    const [pair, side] = c;
    const open = Date.parse(c[2]);
    const T = Date.parse(c[3]);
    const E = Number(c[4]);
    const sent = Date.parse(c[5]);
    if (!isPair(pair)) throw new Error(`${at}: pair ${pair}`);
    if (side !== "BUY" && side !== "SELL") throw new Error(`${at}: side ${side}`);
    if (![open, T, E, sent].every(Number.isFinite) || !(E > 0)) throw new Error(`${at}: a time or the entry is not a number`);
    if (open % STEP15 !== 0 || T !== open + STEP15) throw new Error(`${at}: the bar ${c[2]} .. ${c[3]} is not a 15-minute bar`);
    if (sent < T) throw new Error(`${at}: sent ${c[5]} before the bar closed`);
    const key = `${pair}|${side}|${open}`;
    if (seen.has(key)) throw new Error(`${at}: ${pair} ${side} ${c[2]} twice`);
    seen.add(key);
    if (rows.length && sent < rows[rows.length - 1].sent) throw new Error(`${at}: not in sentAt order`);
    rows.push({ pair, side, open, T, E, sent });
  });
  return rows;
};

export const ceilMinute = (ms: number): number => Math.ceil(ms / MINUTE) * MINUTE;

// Each row sent before END_b as a signal: E the email's entry, TP2 from it (E ± 10 pips, as (a)), base the
// sent time rounded up to the minute (P = base + 1 minute; the supplement's base + 5 = sentAt + 5 minutes
// rounded up). In P's order, then Rakuten's pair order, BUY first, then the bar (as (a)'s signals).
// planted "pFloor": base rounded down (the Python, which makes P from sentAt on its own, must see it)
export const ledgerSigs = (rows: LedgerRow[], endB: number, plant = ""): Sig[] => {
  const sigs: Sig[] = rows.filter((r) => r.sent < endB).map((r) => {
    const pi = PAIRS.indexOf(r.pair as (typeof PAIRS)[number]);
    const base = plant === "pFloor" ? Math.floor(r.sent / MINUTE) * MINUTE : ceilMinute(r.sent);
    return { pair: r.pair, pi, side: r.side, dir: r.side === "BUY" ? 1 : -1, open: r.open, T: r.T, E: r.E, tp: ultraLevels(r.side, r.E, unitOf(r.pair), ULTRA_PAIRS).tps[1], late: false, base, bidC: NaN, askC: NaN, sent: r.sent };
  });
  sigs.sort((a, b) => a.base - b.base || a.pi - b.pi || b.dir - a.dir || a.open - b.open);
  return sigs;
};

// The emails against the signals recomputed from GMO's 15-minute bars (signalsOf, as (a)), those whose
// email goes (base: T, or T + 15 minutes for a late one) in [LEDGER_FROM, END_b): matched by (pair, side,
// the bar's start). Counted from the emails; listed, never a failure.
export interface Recompute {
  emails: number;
  recomputed: number;
  matched: number;
  emailOnly: string[];
  recomputeOnly: string[];
  eDiff: string[];
  lateDiff: string[];
}
export const compareRecompute = (rows: LedgerRow[], rec: Sig[], endB: number): Recompute => {
  const sent = rows.filter((r) => r.sent < endB);
  const recIn = rec.filter((s) => s.base >= LEDGER_FROM && s.base < endB);
  const key = (pair: string, side: string, open: number) => `${pair}|${side}|${open}`;
  const byRec = new Map(recIn.map((s) => [key(s.pair, s.side, s.open), s]));
  const byRow = new Set(sent.map((r) => key(r.pair, r.side, r.open)));
  const out: Recompute = { emails: sent.length, recomputed: recIn.length, matched: 0, emailOnly: [], recomputeOnly: [], eDiff: [], lateDiff: [] };
  for (const r of sent) {
    const s = byRec.get(key(r.pair, r.side, r.open));
    const what = `${r.pair} ${r.side} ${iso(r.open)}`;
    if (!s) {
      out.emailOnly.push(`${what} (sent ${iso(r.sent)}, E ${r.E})`);
      continue;
    }
    out.matched++;
    const d = digitsOf(r.pair);
    if (Number(r.E.toFixed(d)) !== Number(s.E.toFixed(d))) out.eDiff.push(`${what}: email ${r.E}, recomputed ${s.E}`);
    // on time: sent within 15 minutes of the close (以内: 15 minutes exactly is on time)
    const lateEmail = r.sent - r.T > STEP15;
    if (lateEmail !== s.late) out.lateDiff.push(`${what}: email sent ${Math.round((r.sent - r.T) / 1000)} s after the close, recomputed ${s.late ? "late (in the next bar's window only)" : "on time"}`);
  }
  for (const s of recIn) if (!byRow.has(key(s.pair, s.side, s.open))) out.recomputeOnly.push(`${s.pair} ${s.side} ${iso(s.open)} (E ${s.E}${s.late ? ", late" : ""})`);
  return out;
};

// The time from a bar's close to its email (seconds), every row sent before END_b
export const delaysOf = (rows: LedgerRow[], endB: number): { n: number; median: number | null; max: number | null } => {
  const xs = rows.filter((r) => r.sent < endB).map((r) => (r.sent - r.T) / 1000);
  return { n: xs.length, median: medianOf(xs), max: xs.length ? Math.max(...xs) : null };
};

export interface ARow {
  T: number;
  pair: string;
  side: string;
  P: number;
  week: number;
  v: number;
}
export const parseACsv = (text: string): ARow[] => {
  const lines = text.split("\n").filter((l) => l !== "");
  if (lines[0] !== A_HEADER) throw new Error(`ultra15-a.csv: the header is ${JSON.stringify(lines[0])}`);
  return lines.slice(1).map((l, k) => {
    const c = l.split(",");
    const r = { T: Date.parse(c[0]), pair: c[1], side: c[2], P: Date.parse(c[3]), week: Number(c[4]), v: Number(c[5]) };
    if (c.length !== 6 || ![r.T, r.P, r.week, r.v].every(Number.isFinite) || !isPair(r.pair)) throw new Error(`ultra15-a.csv row ${k + 1}: ${l}`);
    if (r.P + DAY > A_END) throw new Error(`ultra15-a.csv row ${k + 1}: P + 1 day after (a)'s END`);
    return r;
  });
};

// one counted email of (b): its P (moved past Rakuten's stop) and its value a day after P (the signal's side, pips)
export interface BValue {
  P: number;
  v: number;
}
export interface Window {
  n: number;
  nPrev: number;
  due: boolean;
  o1?: number;
  o2?: number;
  b?: { n: number; value: number };
  a?: { values: number; empty: number; q05: number; q95: number; counts: { min: number; median: number; max: number }; list: Array<{ W: string; n: number; value: number }> };
  verdict?: "inside" | "above" | "below";
}
// The one comparison (§8.102 (b) の読み方、細部): made on the first END_b whose count of emails with P + 1 day
// ≦ END_b reaches 30 (the week before had fewer). `vals`: (b)'s emails whose path is not nothing, P + 1 day ≦ END_b.
// planted "windowNo24h": o2 without the 24 hours; "compareEvery": compared on every END_b at 30 or more
export const windowOf = (vals: BValue[], sB: number, endB: number, aRows: ARow[], plant = ""): Window => {
  const n = vals.filter((x) => x.P + DAY <= endB).length;
  const nPrev = vals.filter((x) => x.P + DAY <= endB - WEEK).length;
  const due = plant === "compareEvery" ? n >= COMPARE_AT : n >= COMPARE_AT && nPrev < COMPARE_AT;
  if (!due) return { n, nPrev, due };
  const o1 = sB - W0;
  const o2 = endB - (plant === "windowNo24h" ? 0 : DAY) - W0;
  const bs = vals.filter((x) => x.P >= sB && x.P <= endB - DAY);
  const bValue = bs.reduce((s, x) => s + x.v, 0) / bs.length;
  const list: Array<{ W: string; n: number; value: number }> = [];
  let empty = 0;
  for (let k = 1; ; k++) {
    const W = W0 - k * WEEK;
    if (W + o1 < A_START) break;
    if (W + o2 + DAY > A_END) continue;
    const xs = aRows.filter((r) => r.P >= W + o1 && r.P <= W + o2);
    if (!xs.length) {
      empty++;
      continue;
    }
    list.push({ W: iso(W), n: xs.length, value: xs.reduce((s, r) => s + r.v, 0) / xs.length });
  }
  const values = list.map((x) => x.value);
  if (!values.length) throw new Error("the comparison: no week of (a) with an email in its window");
  const q05 = quantile(values, 0.05)!;
  const q95 = quantile(values, 0.95)!;
  const ns = list.map((x) => x.n);
  return {
    n,
    nPrev,
    due,
    o1,
    o2,
    b: { n: bs.length, value: bValue },
    a: { values: values.length, empty, q05, q95, counts: { min: Math.min(...ns), median: medianOf(ns)!, max: Math.max(...ns) }, list },
    verdict: bValue > q95 ? "above" : bValue < q05 ? "below" : "inside",
  };
};
