// #318 (docs §8.113 1, 2, 6, 8): the clock. Weeks and 4-week blocks, New York's and London's summer time,
// the season group of a time, New York's local fields, whether a signal is sent (6 ②), GMO's week (6 ③),
// GMO's day key. Pure; no bar in here.

import { HOUR, MINUTE, WEEK, WEEK_OFFSET } from "./lib.ts";
import { isPossiblyClosed, nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import { gmoDayKey } from "./ownerhold-data.ts";
import type { Half, Period } from "./chartbest-const.ts";

export { gmoDayKey, nyOffsetMs };

// 1: the week, Sunday 21:00 UTC (lib.ts)
export const wk = (t: number): number => Math.floor((t - WEEK_OFFSET) / WEEK);
// 1: the 4-week block of a half
export const block4 = (t: number, h: Half, p: Period): number => Math.floor((wk(t) - p.w0[h]) / 4);

// 2: New York's summer is nyOffsetMs's (−4 hours)
export const nySummer = (t: number): boolean => nyOffsetMs(t) === -4 * HOUR;

// the last Sunday of a month, 01:00 UTC
const lastSunday0100 = (y: number, month: number): number => {
  const last = new Date(Date.UTC(y, month + 1, 0));
  const day = last.getUTCDate() - last.getUTCDay();
  return Date.UTC(y, month, day, 1);
};
// 2: London's summer, the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC
// (the plant "londonDstAsNy" switches it on New York's days, which hand.time.dst must catch)
export const londonSummer = (t: number, plant = ""): boolean => {
  if (plant === "londonDstAsNy") return nySummer(t);
  const y = new Date(t).getUTCFullYear();
  return t >= lastSunday0100(y, 2) && t < lastSunday0100(y, 9);
};

// 8: the season group at T: both winter 0, both summer 1, New York only summer (the shifted weeks) 2,
// London only summer 3 (never in 2024–2026; counted if it appears)
export const SEASON_NAMES = ["WW", "SS", "SW", "WS"] as const;
export const seasonOf = (t: number, plant = ""): 0 | 1 | 2 | 3 => {
  const ny = nySummer(t);
  const lon = londonSummer(t, plant);
  return !ny && !lon ? 0 : ny && lon ? 1 : ny ? 2 : 3;
};

// New York's local clock at t
export interface NyLocal {
  // 0 Sunday … 6 Saturday
  weekday: number;
  date: string;
  hour: number;
  minute: number;
}
export const nyLocal = (t: number): NyLocal => {
  const d = new Date(t + nyOffsetMs(t));
  return { weekday: d.getUTCDay(), date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
};
// the UTC instant of a New York local date ("YYYY-MM-DD") and time
export const nyToUtc = (date: string, hour: number, minute: number): number => {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  // the offset at the local time read as UTC, then once more at the instant found (the switch is at 02:00 local)
  const t1 = guess - nyOffsetMs(guess + 5 * HOUR);
  return guess - nyOffsetMs(t1);
};

// 6 ②: the sweep reads 0, 1 and 3 minutes after the close; a signal is sent when one of the reads falls
// outside isPossiblyClosed (the plant "countUnsent" counts every signal, which hand.sent must catch)
export const sent = (T: number, plant = ""): boolean => plant === "countUnsent" || [0, 1, 3].some((m) => !isPossiblyClosed(T + m * MINUTE));

// 6 ③ (§8.107 3): GMO's week, Sunday 22:00 UTC to Friday 21:00 UTC (fixed UTC)
export const gmoWeekOpen = (t: number): boolean => {
  const d = new Date(t);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && h >= 21) return false;
  if (day === 0 && h < 22) return false;
  return true;
};

// 20 (e): the made-up bars' week (money-data.ts gmoWeekShut): Friday from 20:00 UTC in the US summer, 21:00 in
// winter, Saturday, Sunday before 22:00
export const gmoWeekShut = (t: number): boolean => {
  const d = new Date(t);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  if (day === 6) return true;
  if (day === 0) return h < 22;
  if (day === 5) return h >= (nySummer(t) ? 20 : 21);
  return false;
};

// SQ-23: τ, New York 17:00, the instants in [a, b)
export const tausBetween = (a: number, b: number): number[] => {
  const out: number[] = [];
  let date = nyLocal(a - 2 * 24 * HOUR).date;
  for (let k = 0; k < 4000; k++) {
    const t = nyToUtc(date, 17, 0);
    if (t >= b) break;
    if (t >= a) out.push(t);
    const next = new Date(Date.parse(`${date}T12:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
    date = next;
  }
  return out;
};
// New York's midnights in [a, b) (breedon's own day bound: D is the New York date)
export const nyMidnightsBetween = (a: number, b: number): number[] => {
  const out: number[] = [];
  let date = nyLocal(a - 2 * 24 * HOUR).date;
  for (let k = 0; k < 4000; k++) {
    const t = nyToUtc(date, 0, 0);
    if (t >= b) break;
    if (t >= a) out.push(t);
    date = new Date(Date.parse(`${date}T12:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
  }
  return out;
};

export const isoMin = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");
export const isoDate = (t: number): string => new Date(t).toISOString().slice(0, 10);
