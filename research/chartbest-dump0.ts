// #318 (docs §8.113 20 (d); plan §4): the stage-0 dumps (bars, signals, prefilter, holes, JSON) the Python
// compares, written by the TS into <out>/ts/ (no follow code: stage 0 imports this file).
// CSV: a header line, "," between cells, LF, no quoting (lists joined by ";"), an empty cell for none.
// Integers decimal; times integer ms UTC; prices (bid/ask/mid/E) toFixed(d); other reals the shortest
// round-trip (String(x)), "NaN" for not-a-number. JSON: plain numbers, null for none (the influence maps of
// an estimate are not written). sentences.tsv: id TAB text.

import { GMO_SYMBOLS } from "../supabase/functions/track-outcomes/quotes.ts";
import type { PairBars } from "./chartbest-bars.ts";
import { PAIRS, dirName } from "./chartbest-const.ts";
import type { SourceSigs } from "./chartbest-core.ts";
import type { Holes } from "./chartbest-events.ts";

export const real = (x: number | null | undefined): string => (x === null || x === undefined ? "" : Number.isNaN(x) ? "NaN" : String(x));
export const csv = (head: string[], rows: string[][]): string => [head.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
export const write = async (dir: string, name: string, text: string) => {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/${name}`, text);
};

export const writeBars = async (dir: string, bars: PairBars[]) => {
  for (const pb of bars) {
    const d = pb.digits;
    const rows: string[][] = [];
    for (let k = 0; k < pb.n; k++) rows.push([String(k), String(pb.t[k]), pb.mo[k].toFixed(d), pb.mh[k].toFixed(d), pb.ml[k].toFixed(d), pb.mc[k].toFixed(d)]);
    await write(dir, `bars-${GMO_SYMBOLS[pb.pair]}.csv`, csv(["i", "t", "mo", "mh", "ml", "mc"], rows));
  }
};

export const writeSignals = async (dir: string, sources: SourceSigs[], bars: PairBars[]) => {
  const rows: string[][] = [];
  for (const s of sources) {
    for (const r of s.recs) {
      rows.push([s.src, PAIRS[r.pi], String(r.i), String(r.T), dirName(r.dir), r.E.toFixed(bars[r.pi].digits), r.reason, r.half ?? "-", r.marks.join(";")]);
    }
  }
  await write(dir, "signals.csv", csv(["src", "pair", "i", "T", "dir", "E", "reason", "half", "marks"], rows));
  const pre: string[][] = [];
  for (const s of sources) {
    s.prefilter.forEach((p, pi) => {
      if (s.def && !s.def.pairs.includes(PAIRS[pi])) return;
      pre.push([s.src, PAIRS[pi], String(p.bothSuppressed), String(p.firstSkipped), String(p.nullPrevSkipped), String(p.late)]);
    });
  }
  await write(dir, "prefilter.csv", csv(["src", "pair", "bothSuppressed", "firstSkipped", "nullPrevSkipped", "late"], pre));
};

export const writeHoles = async (dir: string, holes: Holes) => {
  const rows: string[][] = [];
  holes.byPair.forEach((h, pi) => {
    for (let k = 0; k < h.length; k += 2) rows.push([PAIRS[pi], String(h[k]), String(h[k + 1])]);
  });
  await write(dir, "holes.csv", csv(["pair", "a", "b"], rows));
};

export const writeJson = async (dir: string, name: string, v: unknown) => write(dir, name, JSON.stringify(v, jsonReplacer, 1) + "\n");
// NaN as null; an estimate's influence maps left out
export const jsonReplacer = (k: string, v: unknown): unknown => {
  if (k === "inf") return undefined;
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  if (v instanceof Map) return Object.fromEntries(v);
  return v;
};
