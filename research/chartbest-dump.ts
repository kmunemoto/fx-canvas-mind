// #318 (docs §8.113 20 (d); plan §4): the dumps the Python check compares, written by the TS into <out>/ts/.
// CSV: a header line, "," between cells, LF, no quoting (lists joined by ";"), an empty cell for none.
// Integers decimal; times integer ms UTC; prices (bid/ask/mid/E) toFixed(d); other reals the shortest
// round-trip (String(x)), "NaN" for not-a-number. JSON: plain numbers, null for none (the influence maps of
// an estimate are not written). sentences.tsv: id TAB text.

import { PAIRS, dirName } from "./chartbest-const.ts";
import { type BlindTable, CODE_KIND, KIND_LETTER, NO_E, TRADE_KEYS } from "./chartbest-follow.ts";
import type { PairBars } from "./chartbest-bars.ts";
import type { BlindRow, Row, SigTrade } from "./chartbest-rows.ts";
import type { Est } from "./chartbest-stats.ts";
import { stratumOf } from "./chartbest-strata.ts";
import { csv, real, write } from "./chartbest-dump0.ts";

export * from "./chartbest-dump0.ts";

export const writeBlind = async (dir: string, bt: BlindTable, bars: PairBars[]) => {
  const rows: string[][] = [];
  for (const bp of bt.pairs) {
    const d = bars[bp.pi].digits;
    for (let r = 0; r < bp.n; r++) {
      const cells = [PAIRS[bp.pi], String(bp.k[r]), String(bp.T[r]), bp.E[r].toFixed(d), String(bp.hour[r]), String(bp.season[r]), String(bp.week[r]), String(bp.block[r])];
      for (const key of TRADE_KEYS) cells.push(KIND_LETTER[CODE_KIND[bp.kind[key][r]]], real(bp.pips[key][r]), String(bp.bars[key][r]));
      cells.push(bp.eBuy[r] === NO_E ? "" : String(bp.eBuy[r]));
      rows.push(cells);
    }
  }
  const head = ["pair", "k", "T", "E", "hour", "season", "week", "block"];
  for (const key of TRADE_KEYS) head.push(`${key}k`, `${key}p`, `${key}n`);
  head.push("eBuy");
  await write(dir, `blind-${bt.half}.csv`, csv(head, rows));
};

const y = (k: string): string => (k === "tp" ? "1" : k === "open" ? "" : "0");
export const tradeRows = (trades: SigTrade[], plant = ""): string[][] =>
  trades.map((x) => [
    x.src, PAIRS[x.pi], String(x.i), String(x.T), dirName(x.dir), x.half,
    String(stratumOf("chart", x.pi, x.dir, x.T, plant)), String(stratumOf("cal", x.pi, x.dir, x.T, plant)),
    x.e === null ? "" : String(x.e), y(x.k4), y(x.k10), real(x.p4), real(x.p10), real(x.mp4), real(x.mp10),
    x.lateT === null ? "" : String(x.lateT), x.eLate === null ? "" : String(x.eLate),
    x.lateT === null ? "" : String(stratumOf("chart", x.pi, x.dir, x.lateT, plant)), x.lateT === null ? "" : String(stratumOf("cal", x.pi, x.dir, x.lateT, plant)),
    x.nextOk ? "1" : "0",
  ]);
export const TRADE_HEAD = ["src", "pair", "i", "T", "dir", "half", "sChart", "sCal", "e", "y4", "y10", "p4", "p10", "mp4", "mp10", "lateT", "eLate", "sLateChart", "sLateCal", "nextOk"];
export const writeTrades = async (dir: string, rows: string[][]) => write(dir, "trades.csv", csv(TRADE_HEAD, rows));

// an estimate as JSON (plan §4.3): est, N, strata, dropped, cands, use, t, lo, hi, lb. The unaligned a has no
// strata (null); a difference D (D_U, D_M, D_AB) has neither N nor strata (null) — the layout the Python writes
export type EstKind = "delta" | "a" | "diff";
export const estJson = (e: Est, kind: EstKind = "delta") => ({
  est: e.est, N: kind === "diff" ? null : e.N, strata: kind === "delta" ? e.strata : null, dropped: e.dropped,
  cands: e.cands, use: e.use, t: e.t, lo: e.lo, hi: e.hi, lb: e.lb,
});
// a row of stats.json: the shift's summary (of Δ) only on the chart layer; the counts live in counts.json/trades.csv
export const rowJson = (r: Row) => ({
  delta: estJson(r.delta), a: estJson(r.a, "a"), late: estJson(r.late),
  w4: r.w4, w10: r.w10, blindW1: r.blindW1, blindPl1: r.blindPl1, byDir: r.byDir, byPair: r.byPair,
  nonOverlap: r.nonOverlap, perWeek: r.perWeek,
  ...(r.layer === "chart" ? { shift: r.shift ? shiftJson(r.shift.delta) : null } : {}),
  suspicious: r.suspicious,
});
const shiftJson = (s: NonNullable<Row["shift"]>["delta"]) => ({ n: s.n, mean: s.mean, q025: s.q025, q975: s.q975, rank: s.rank, sd: s.sd });
export const blindJson = (b: BlindRow) => ({ a: estJson(b.a, "a"), w4: b.w4, w10: b.w10, suspicious: b.suspicious });

// shift.csv (plan §4.3): Δ_k per k (Δ_late's shift enters only its SE candidate, in stats.json)
export const shiftRows = (r: Row): string[][] => {
  if (!r.shift) return [];
  const s = r.shift;
  return s.delta.k.map((k, j) => [r.src, r.half, r.layer, String(k), real(s.delta.delta[j]), String(s.delta.dropped[j]), String(s.delta.seasonCross[j])]);
};
export const SHIFT_HEAD = ["src", "half", "layer", "k", "delta", "dropped", "seasonCross"];
export const writeShift = async (dir: string, rows: string[][]) => write(dir, "shift.csv", csv(SHIFT_HEAD, rows));

// sentences.tsv: a header line "id<TAB>text", then one sentence a line
export const writeSentences = async (dir: string, lines: Array<[string, string]>) =>
  write(dir, "sentences.tsv", ["id\ttext", ...lines.map(([id, t]) => `${id}\t${t.replace(/[\t\n]/g, " ")}`)].join("\n") + "\n");
export { write as writeText };
