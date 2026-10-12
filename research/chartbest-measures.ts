// #318 (docs §8.113 10, 20 (b) 今のメールの照合): the two emails as signal sources, the yardsticks.
//
// ULTRA 5分足 (§8.109 (イ), §8.107 2): at a closed bar i with 600 bars ending at it (i ≥ 599), the signal is
// the one ULTRA finds at i on the window [i − 599, i] computed from anchoredStart (tf-winrate's segments: one
// run of ultra() for every bar an anchor serves, as ownerhold-data signalsOf). A late signal — bar i's signal
// found only in window i + 1 where the anchor moved, its side not the on-time one — is counted and kept out
// (tf-winrate, SQ-22: not part of the measure's 全部の合図).
// MACD の山・谷 (§8.109 主): prepare() on the series from S0, decide() at each i ≥ 599: a fire is BUY on an UP
// cross, SELL on a DOWN one (macdx.ts and ownerhold-data macdxReadOf's way).
// The checks (full runs): indicatorSignals / macdxSignals (the sweep's own code) on the 600-bar window at
// every signal and at sampled bars, decideOnWindow against the whole series' decision, and equality with
// §8.111's own readers (signalsOf / macdxReadOf with IV5), whose lists are also the owner's way's signals.

import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { CHART_BARS } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs } from "../supabase/functions/_shared/qtrend.ts";
import { ultra } from "../supabase/functions/_shared/ultra.ts";
import { indicatorSignals, macdxSignals } from "../supabase/functions/signal-alerts/indicators.ts";
import { WINDOW, decide, decideOnWindow, prepare } from "../supabase/functions/_shared/macd-extreme.ts";
import { IV5, macdxReadOf, type Probe, type Sig, type SignalRead, signalsOf } from "./ownerhold-data.ts";
import { MINUTE } from "./lib.ts";
import type { PairBars } from "./chartbest-bars.ts";
import { type Dir, type MeasureId, type Period, STEP } from "./chartbest-const.ts";
import type { Cand } from "./chartbest-events.ts";
import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";

export const ULTRA_EVERY = 661;
export type { Probe };
const newProbe = (): Probe => ({ compared: 0, mismatched: 0, examples: [] });
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

export interface LateSig {
  pi: number;
  i: number;
  T: number;
  dir: Dir;
}
export interface MeasureCands {
  id: MeasureId;
  pi: number;
  cands: Cand[];
  late: LateSig[];
}

// the chart's candles of a pair's bars (indicatorSignals and the readers take them)
export const candlesOf = (pb: PairBars): Candle[] =>
  Array.from({ length: pb.n }, (_, k) => ({ datetime: new Date(pb.t[k]).toISOString(), open: pb.mo[k], high: pb.mh[k], low: pb.ml[k], close: pb.mc[k] }));

// the anchor of bar i's window (tf-winrate anchorOf): the window's first bar and where ULTRA starts
export const ultraAnchor = (t: Float64Array, i: number): { ws: number; s: number } | null => {
  if (i < WINDOW - 1) return null;
  const ws = i - WINDOW + 1;
  if (i - ws + 1 <= QT_DEFAULTS.period) return null;
  const w = Array.from(t.subarray(ws, i + 1));
  const last = i - ws;
  const firstShown = Math.max(0, last - (CHART_BARS - 1));
  return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
};

type UBar = { high: number; low: number; close: number };
const ubars = (pb: PairBars, from: number, to: number): UBar[] => {
  const out: UBar[] = [];
  for (let k = from; k <= to; k++) out.push({ high: pb.mh[k], low: pb.ml[k], close: pb.mc[k] });
  return out;
};

// ULTRA's on-time signals at every bar with a window, and the late ones
export const ultraCands = (pb: PairBars): MeasureCands & { own: Map<number, Dir>; nextSide: Map<number, Dir | 0> } => {
  const own = new Map<number, Dir>();
  let seg: { s: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!seg) return;
    const bars = ubars(pb, seg.s, seg.to);
    for (const tr of ultra(bars, bars.length - 1, pb.unit).trades) {
      const at = seg.s + tr.i;
      if (at >= seg.from && at <= seg.to) own.set(at, tr.side === "BUY" ? 1 : -1);
    }
    seg = null;
  };
  const anchors: Array<{ ws: number; s: number } | null> = new Array(pb.n).fill(null);
  for (let i = WINDOW - 1; i < pb.n; i++) {
    const a = ultraAnchor(pb.t, i);
    anchors[i] = a;
    if (!a) {
      flush();
      continue;
    }
    if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
    else {
      flush();
      seg = { s: a.s, from: i, to: i };
    }
  }
  flush();
  // late: bar i's signal in window i + 1 where that window's anchor differs from bar i's
  const nextSide = new Map<number, Dir | 0>();
  const late: LateSig[] = [];
  for (let i = 0; i + 1 < pb.n; i++) {
    const a1 = anchors[i + 1];
    if (!a1 || a1.s > i) continue;
    const a0 = anchors[i];
    if (a0 && a0.s === a1.s) continue;
    const bars = ubars(pb, a1.s, i);
    const hit = ultra(bars, bars.length - 1, pb.unit).trades.find((tr) => tr.i === i - a1.s);
    const side: Dir | 0 = hit ? (hit.side === "BUY" ? 1 : -1) : 0;
    nextSide.set(i, side);
    if (side !== 0 && side !== own.get(i)) late.push({ pi: pb.pi, i, T: pb.t[i] + STEP, dir: side });
  }
  const cands: Cand[] = [...own.entries()].sort((a, b) => a[0] - b[0]).map(([i, dir]) => ({ src: "ultra5", pi: pb.pi, i, T: pb.t[i] + STEP, dir, marks: [] }));
  return { id: "ultra5", pi: pb.pi, cands, late, own, nextSide };
};

// MACD's fires at every bar with a 600-bar window (the whole series' MACD)
export const macdCands = (pb: PairBars): MeasureCands & { crosses: number[]; fire: Map<number, Dir> } => {
  const p = prepare(ubars(pb, 0, pb.n - 1));
  const fire = new Map<number, Dir>();
  const crosses: number[] = [];
  for (let i = WINDOW - 1; i < pb.n; i++) {
    const d = decide(p.m, p.sides, p.ms, p.tr, i, 0);
    if (!d) continue;
    crosses.push(i);
    if (d.fire) fire.set(i, d.side === "BUY" ? 1 : -1);
  }
  const cands: Cand[] = [...fire.entries()].map(([i, dir]) => ({ src: "macdx5", pi: pb.pi, i, T: pb.t[i] + STEP, dir, marks: [] }));
  return { id: "macdx5", pi: pb.pi, cands, late: [], crosses, fire };
};

// ---- the checks (full runs) ---------------------------------------------------------------------------------

const bad = (pr: Probe, what: string) => {
  pr.mismatched++;
  if (pr.examples.length < 10) pr.examples.push(what);
};
const sideName = (d: Dir | 0 | undefined) => (d === 1 ? "BUY" : d === -1 ? "SELL" : "");

// ULTRA: indicatorSignals on bar i's window at every on-time signal and every 661st bar; on window i + 1 for
// every late one
export const ultraProbes = (pb: PairBars, candles: Candle[], u: ReturnType<typeof ultraCands>): { indicator: Probe; late: Probe } => {
  const indicator = newProbe();
  const lateP = newProbe();
  const at = new Set<number>([...u.own.keys()]);
  for (let i = WINDOW - 1; i < pb.n; i++) if (i % ULTRA_EVERY === 0) at.add(i);
  for (const i of [...at].sort((a, b) => a - b)) {
    const a = ultraAnchor(pb.t, i);
    if (!a) continue;
    const theirs = indicatorSignals(pb.pair, "5min", candles.slice(a.ws, i + 1), pb.t[i] + STEP + MINUTE, 2 * MINUTE)
      .filter((x) => x.rule === "ultra" && Date.parse(x.barTime) === pb.t[i]).map((x) => x.side).join(",");
    indicator.compared++;
    if (theirs !== sideName(u.own.get(i))) bad(indicator, `${pb.pair} ${iso(pb.t[i])} mine=${sideName(u.own.get(i)) || "-"} theirs=${theirs || "-"}`);
  }
  for (const l of u.late) {
    const a1 = ultraAnchor(pb.t, l.i + 1);
    if (!a1) continue;
    const now = pb.t[l.i + 1] + STEP + MINUTE;
    const theirs = indicatorSignals(pb.pair, "5min", candles.slice(a1.ws, l.i + 2), now, now - l.T)
      .filter((x) => x.rule === "ultra" && Date.parse(x.barTime) === pb.t[l.i]).map((x) => x.side).join(",");
    lateP.compared++;
    if (theirs !== sideName(l.dir)) bad(lateP, `${pb.pair} ${iso(pb.t[l.i])} late mine=${sideName(l.dir)} theirs=${theirs || "-"}`);
  }
  return { indicator, late: lateP };
};

// MACD: decideOnWindow and macdxSignals at every cross and fire and about 300 evenly spaced bars
export const macdProbes = (pb: PairBars, candles: Candle[], m: ReturnType<typeof macdCands>): { window: Probe; macdx: Probe } => {
  const win = newProbe();
  const mx = newProbe();
  const p = prepare(ubars(pb, 0, pb.n - 1));
  const judged = pb.n - (WINDOW - 1);
  const every = Math.max(1, Math.floor(judged / 300));
  const sample: number[] = [];
  for (let i = WINDOW - 1; i < pb.n; i += every) sample.push(i);
  const at = [...new Set([...m.crosses, ...sample])].sort((a, b) => a - b);
  for (const i of at) {
    const whole = decide(p.m, p.sides, p.ms, p.tr, i, 0);
    const w = decideOnWindow(candles, i);
    const ka = whole ? `${whole.dir}:${whole.fire}` : "-";
    const kb = w ? `${w.dir}:${w.fire}` : "-";
    win.compared++;
    if (ka !== kb) bad(win, `${pb.pair} ${iso(pb.t[i])} whole=${ka} window=${kb}`);
  }
  for (const i of [...new Set([...m.fire.keys(), ...sample])].sort((a, b) => a - b)) {
    const theirs = macdxSignals(pb.pair, "5min", candles.slice(i - WINDOW + 1, i + 1), pb.t[i] + STEP + MINUTE, 2 * MINUTE)
      .filter((x) => x.rule === "macdx" && Date.parse(x.barTime) === pb.t[i]).map((x) => x.side).join(",");
    mx.compared++;
    if (theirs !== sideName(m.fire.get(i))) bad(mx, `${pb.pair} ${iso(pb.t[i])} mine=${sideName(m.fire.get(i)) || "-"} theirs=${theirs || "-"}`);
  }
  return { window: win, macdx: mx };
};

// the mailed lists of §8.111's readers over [START, END) against this program's: (pair, open, side, E, TP2,
// base, bid close, ask close); on time and late
const sigKey = (s: Sig) => `${s.pair}|${s.open}|${s.side}|${s.E}|${s.tp}|${s.base}|${s.bidC}|${s.askC}|${s.late ? 1 : 0}`;
export const readerOf = (id: MeasureId, pb: PairBars, quotes: QuoteCandle[], p: Period): SignalRead =>
  id === "ultra5" ? signalsOf(pb.pair, pb.pi, quotes, p.start, p.end, false, "", IV5) : macdxReadOf(pb.pair, pb.pi, quotes, p.start, p.end, false, "", IV5);

// a late ULTRA signal is mailed when the read of window i + 1 (at its close + 0, 1, 3 minutes) is fresh and open
const lateMailed = (pb: PairBars, l: LateSig): boolean => {
  if (l.i + 1 >= pb.n) return false;
  const base = pb.t[l.i + 1] + STEP;
  return IV5.readAfter.some((m) => {
    const at = base + m * MINUTE;
    return at - l.T >= 0 && at - l.T < IV5.fresh && !isPossiblyClosed(at);
  });
};
export const readerEquality = (id: MeasureId, pb: PairBars, mine: { cands: Cand[]; late: LateSig[] }, read: SignalRead, p: Period, sentAt: (T: number) => boolean): Probe => {
  const pr = newProbe();
  const unit = pb.unit;
  const ours: string[] = [];
  const mk = (i: number, dir: Dir, late: boolean): string => {
    const side = dir === 1 ? "BUY" : "SELL";
    const E = pb.mc[i];
    const tp = E + dir * 10 * unit;
    const base = late ? pb.t[i + 1] + STEP : pb.t[i] + STEP;
    return sigKey({ pair: pb.pair, pi: pb.pi, side, dir, open: pb.t[i], T: pb.t[i] + STEP, E, tp, late, base, bidC: pb.bc[i], askC: pb.ac[i] });
  };
  for (const c of mine.cands) if (c.T >= p.start && c.T < p.end && sentAt(c.T)) ours.push(mk(c.i, c.dir, false));
  if (id === "ultra5") for (const l of mine.late) if (l.T >= p.start && l.T < p.end && lateMailed(pb, l)) ours.push(mk(l.i, l.dir, true));
  const theirs = read.signals.map(sigKey);
  const a = new Set(ours);
  const b = new Set(theirs);
  pr.compared = Math.max(a.size, b.size);
  for (const k of a) if (!b.has(k)) bad(pr, `mine only ${k}`);
  for (const k of b) if (!a.has(k)) bad(pr, `reader only ${k}`);
  return pr;
};
