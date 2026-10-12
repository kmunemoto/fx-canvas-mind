// #318 (docs §8.113 11–16, 20, 22 の 2): one made-up run, end to end — read the day files, the items' and the
// emails' signals, stage 0 (counts only), the look-ahead checks, stage 1 (the first half's blind table, rows,
// the choice), stage 2 (the chosen items' second half: Holm, C1–C5, the judgments, D_U/D_M/D_AB), the
// sentences, the dumps for the Python, checks.json, print.txt (only when every check passed) and summary.json.
// The stages also run as separate processes on one folder (the pipeline rehearsal), through walk-ledger/.
// The stage-0-safe parts live in research/chartbest-run0.ts (re-exported here).

import { type Group, type Half, MEASURES, type MeasureId, SPEC } from "./chartbest-const.ts";
import type { Checks } from "./chartbest-checks.ts";
import type { RunBars } from "./chartbest-core.ts";
import { type BlindTable, CODE_KIND, blindTableOf } from "./chartbest-follow.ts";
import { type BlindRow, type Row, type SigTrade, blindObsOf, blindRowsOf, rowOf, tradesOf } from "./chartbest-rows.ts";
import { suspectOfBlind, suspectOfRow } from "./chartbest-select.ts";
import * as dump from "./chartbest-dump.ts";
import { type Signals, reconcileCounts } from "./chartbest-run0.ts";
import type { Stage0 } from "./chartbest-count.ts";

export * from "./chartbest-run0.ts";

// ---- the rows of a half -------------------------------------------------------------------------------------

export interface HalfRows {
  half: Half;
  bt: BlindTable;
  // the items' rows (their own layer) and the emails' (both layers)
  items: Row[];
  emails: Record<MeasureId, Record<Group, Row>>;
  blind: BlindRow[];
  trades: SigTrade[];
}
export const halfRowsOf = (rb: RunBars, sig: Signals, half: Half, which: string[], plant: string, readEnd: number): HalfRows => {
  const p = rb.period;
  const bt = blindTableOf(rb.bars, rb.holes, half, p, plant, readEnd);
  const obs = { chart: blindObsOf(bt, "chart", p, plant), cal: blindObsOf(bt, "cal", p, plant) };
  const trades: SigTrade[] = [];
  const items: Row[] = [];
  for (const s of sig.items) {
    if (!which.includes(s.src)) continue;
    const tr = tradesOf(s.recs, half, bt, rb.bars);
    trades.push(...tr);
    const g = s.def!.group;
    const r = rowOf(s.src, tr, g, half, bt, rb.bars, obs[g], p, { plant, shift: g === "chart" });
    r.suspicious = suspectOfRow(r);
    items.push(r);
  }
  const emails = {} as HalfRows["emails"];
  for (const m of sig.measures) {
    const tr = tradesOf(m.recs, half, bt, rb.bars);
    trades.push(...tr);
    emails[m.measure!] = {} as Record<Group, Row>;
    for (const g of ["chart", "cal"] as const) {
      const r = rowOf(m.src, tr, g, half, bt, rb.bars, obs[g], p, { plant, shift: g === "chart" });
      r.suspicious = suspectOfRow(r);
      emails[m.measure!][g] = r;
    }
  }
  // the lines are written for every blind row (stats.json); only the direction rows are examined (SQ-16)
  const blind = blindRowsOf(bt, p);
  for (const b of blind) b.suspicious = suspectOfBlind(b);
  return { half, bt, items, emails, blind, trades };
};

// the yardsticks' suspicious hits (13): the blind's direction rows (SQ-16: the pair × direction rows are not
// the half's whole rows) and the emails' rows in both layers
export const isBlindWholeRow = (key: string): boolean =>
  (SPEC.blindSuspectRows as string) === "byDirection" ? key === "BUY" || key === "SELL" : key.includes(" ");
export const yardstickHits = (hr: HalfRows): string[] => {
  const out: string[] = [];
  for (const b of hr.blind) if (isBlindWholeRow(b.key) && b.suspicious.length) out.push(`blind ${b.key}: ${b.suspicious.join(",")}`);
  for (const id of MEASURES) for (const g of ["chart", "cal"] as const) if (hr.emails[id][g].suspicious.length) out.push(`${id} ${g}: ${hr.emails[id][g].suspicious.join(",")}`);
  return out;
};

export const statsJson = (halves: HalfRows[]) => {
  const out: Record<string, unknown> = {};
  for (const hr of halves) {
    for (const r of hr.items) ((out[r.src] ??= {}) as Record<string, unknown>)[hr.half] = { [r.layer]: dump.rowJson(r) };
    for (const id of MEASURES) {
      ((out[id] ??= {}) as Record<string, unknown>)[hr.half] = { chart: dump.rowJson(hr.emails[id].chart), cal: dump.rowJson(hr.emails[id].cal) };
    }
    const blind: Record<string, unknown> = {};
    const pairDir: Record<string, unknown> = {};
    for (const b of hr.blind) {
      if (b.key === "BUY" || b.key === "SELL") blind[b.key] = dump.blindJson(b);
      else pairDir[b.key] = dump.blindJson(b);
    }
    blind.pairDir = pairDir;
    ((out.blind ??= {}) as Record<string, unknown>)[hr.half] = blind;
  }
  return out;
};

// 20 (h): the counts reconcile, per source: every signal = Σ ①〜④ + counted (against stage 0's counts); per
// half that computed the source, its trades = stage 0's counted; resolved + unresolved = counted (winPlOf's own
// tallies); signals with e = counted − (the signal's or the mirror's TP10 trade unresolved, read from the blind
// table's kinds, not from e)
export const reconcile = (checks: Checks, sig: Signals, s0: Stage0, halves: HalfRows[]) => {
  const base = reconcileCounts(sig, s0);
  let bad = base.bad;
  const why = [...base.why];
  for (const s of sig.all) {
    for (const hr of halves) {
      // only the sources this half computed (stage 1: the floor's items; stage 2: the chosen ones; the emails)
      const rows = s.measure ? [hr.emails[s.measure].chart, hr.emails[s.measure].cal] : hr.items.filter((r) => r.src === s.src);
      if (!rows.length) continue;
      const tr = hr.trades.filter((x) => x.src === s.src);
      const want = s0.sources[s.src]?.[hr.half].counted ?? -1;
      if (tr.length !== want) {
        bad++;
        why.push(`${s.src} ${hr.half}: ${tr.length} trades for ${want} counted`);
      }
      const bp = (pi: number) => hr.bt.pairs.find((x) => x.pi === pi)!;
      const eitherOpen = tr.filter((x) => {
        const other = x.dir === 1 ? "s10" : "b10";
        return x.k10 === "open" || CODE_KIND[bp(x.pi).kind[other][x.r]] === "open";
      }).length;
      for (const r of rows) {
        const w = r.w10;
        if (w.n !== tr.length || w.resolved + w.open !== w.n || w.tp + w.sl + w.amb !== w.resolved) {
          bad++;
          why.push(`${s.src} ${hr.half} ${r.layer}: resolved ${w.resolved} + open ${w.open} vs ${w.n}`);
        }
        if (r.nE !== tr.length - eitherOpen) {
          bad++;
          why.push(`${s.src} ${hr.half} ${r.layer}: ${r.nE} with e vs ${tr.length} − ${eitherOpen}`);
        }
      }
    }
  }
  checks.count("count.reconcile", bad, base.n, why.length ? why.slice(0, 5) : undefined);
};
