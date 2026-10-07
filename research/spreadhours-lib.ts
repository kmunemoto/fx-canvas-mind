// #206 (docs §8.103): the pieces of ②'s rule both stages use, with no bar and no price in them.
//
//   * the slots (1): UTC's 15 minutes (slot 0 = 0:00-0:14, ..., slot 95 = 23:45-23:59), apart in the US
//     summer and winter, the season by New York's offset (market-hours nyOffsetMs: −4 hours is summer);
//   * the slot to avoid (3): its median ≥ max(3 × base, 1.0 pips) and at least 1,000 bars, compared in
//     whole numbers (twice the median and base, in GMO's last digit, 0.1 pips);
//   * research/ledger/spread-hours.csv: its header, its rows, and reading it back (stage 2 reads only the
//     pair, the season, the slot and whether it is avoided, after checking the file's sha256).

import { DAY, HOUR, MINUTE } from "./lib.ts";
import { nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";

export const SLOT = 15 * MINUTE;
export const SLOTS = 96;
export const SEASONS = ["summer", "winter"] as const;
export type Season = (typeof SEASONS)[number];
// stage 1's period (2): the bars opened from 2024-01-01 00:00 UTC, before 2026-10-03 00:00 UTC ((a)'s)
export const S1_START = Date.parse("2024-01-01T00:00:00Z");
export const S1_END = Date.parse("2026-10-03T00:00:00Z");
// the day files stage 1 may open: the period a day wider each way, in JST dates (2)
export const S1_KEY_MIN = "20231231";
export const S1_KEY_MAX = "20261003";
// 3: at least this many bars; 1.0 pips in 0.1 pips, twice (the comparison's units); the stop at 8 hours
export const MIN_BARS = 1000;
export const FLOOR2 = 20;
export const MAX_AVOID = 32;

export const seasonOf = (t: number): Season => (nyOffsetMs(t) === -4 * HOUR ? "summer" : "winter");
export const slotOf = (t: number): number => Math.floor((((t % DAY) + DAY) % DAY) / SLOT);
// 0..191: the season's 96 slots, summer first
export const cellOf = (t: number): number => (seasonOf(t) === "summer" ? 0 : SLOTS) + slotOf(t);
export const hhmm = (slot: number): string => `${String(Math.floor(slot / 4)).padStart(2, "0")}:${String((slot % 4) * 15).padStart(2, "0")}`;
// GMO's last digit: 0.001 on the yen pairs, 0.00001 on the dollar pairs (0.1 pips)
export const tickScale = (pair: string): number => (pair.includes("JPY") ? 1000 : 100000);

// twice the median of whole numbers (an odd count: twice the middle one; an even one: the two middle ones
// summed), so it stays a whole number; null for none
export const twiceMedian = (sorted: ArrayLike<number>): number | null => {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? 2 * sorted[(n - 1) / 2] : sorted[n / 2 - 1] + sorted[n / 2];
};
// money-stats quantile's way: the sorted value at floor(q × (n − 1))
export const quantileSorted = (sorted: ArrayLike<number>, q: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : null;

// 3: the threshold, twice, in 0.1 pips; whether a slot is avoided
export const threshold2 = (base2: number): number => Math.max(3 * base2, FLOOR2);
export const avoided = (bars: number, med2: number | null, base2: number): boolean => bars >= MIN_BARS && med2 !== null && med2 >= threshold2(base2);

export const CSV_HEADER = "pair,season,slot,utc,bars,median,mean,p90,base,threshold,avoid";
export interface CsvRow {
  pair: string;
  season: Season;
  slot: number;
  bars: number;
  // in 0.1 pips: twice the median, the sum (for the mean), the 90% point; twice base and the threshold
  med2: number | null;
  sum: number;
  p90: number | null;
  base2: number;
  thr2: number;
  avoid: boolean;
}
// pips, written so the same numbers always give the same text: the median, base and the threshold are
// halves of 0.1 pips (two decimals hold them exactly), the 90% point a whole 0.1 pips, the mean four decimals
export const csvLine = (r: CsvRow): string =>
  [
    r.pair,
    r.season,
    String(r.slot),
    hhmm(r.slot),
    String(r.bars),
    r.med2 === null ? "" : (r.med2 / 20).toFixed(2),
    r.bars ? (r.sum / r.bars / 10).toFixed(4) : "",
    r.p90 === null ? "" : (r.p90 / 10).toFixed(1),
    (r.base2 / 20).toFixed(2),
    (r.thr2 / 20).toFixed(2),
    r.avoid ? "yes" : "no",
  ].join(",");

export type AvoidSet = ReadonlySet<string>;
export const avoidKey = (pair: string, season: Season, slot: number): string => `${pair}|${season}|${slot}`;

// The file read back (stage 2): every pair × season × slot once, in the header's columns; the slots avoided
export const parseSpreadHours = (text: string, pairs: readonly string[]): Set<string> => {
  const lines = text.split("\n").filter((l) => l !== "");
  if (lines[0] !== CSV_HEADER) throw new Error(`spread-hours.csv: the header is ${JSON.stringify(lines[0])}`);
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const [k, l] of lines.slice(1).entries()) {
    const c = l.split(",");
    const at = `spread-hours.csv row ${k + 1}`;
    if (c.length !== 11) throw new Error(`${at}: ${c.length} cells`);
    const [pair, season, slotText, utc, , , , , , , avoid] = c;
    const slot = Number(slotText);
    if (!pairs.includes(pair) || !(SEASONS as readonly string[]).includes(season) || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS || utc !== hhmm(slot)) throw new Error(`${at}: ${l}`);
    if (avoid !== "yes" && avoid !== "no") throw new Error(`${at}: avoid ${avoid}`);
    const key = avoidKey(pair, season as Season, slot);
    if (seen.has(key)) throw new Error(`${at}: ${key} twice`);
    seen.add(key);
    if (avoid === "yes") out.add(key);
  }
  if (seen.size !== pairs.length * 2 * SLOTS) throw new Error(`spread-hours.csv: ${seen.size} rows, not ${pairs.length * 2 * SLOTS}`);
  return out;
};

export const sha256Hex = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, "0")).join("");
