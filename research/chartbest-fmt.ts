// #318 (docs §8.113 21 数字の書き方, SQ-32): the numbers' formatting of the sentences and of print.txt. Pure.
// Points and % one decimal, pips two, yen whole; a sign on differences, hits and pips, none on win rates; the exact
// binary value rounded half up (toFixed); an all-zero result "+0.0" ("+0.00" for pips) whatever its sign;
// negatives with U+2212.

import { SPEC } from "./chartbest-const.ts";

const MINUS = SPEC.minusSign;
// a signed number with d decimals ("+0.0" for an all-zero result)
export const signed = (x: number, d: number): string => {
  const s = x.toFixed(d);
  const zero = /^-?0\.?0*$/.test(s);
  if (zero) return `+${(0).toFixed(d)}`;
  return s.startsWith("-") ? `${MINUS}${s.slice(1)}` : `+${s}`;
};
export const fmt = {
  // a value of e ÷ 2 as points (× 100)
  pts: (x: number | null): string => (x === null ? "—" : signed(100 * x, 1)),
  pct: (p: number | null): string => (p === null ? "—" : `${(100 * p).toFixed(1)}%`),
  pips: (x: number | null): string => (x === null ? "—" : signed(x, 2)),
  yen: (x: number, sign = true): string => {
    const r = Math.round(Math.abs(x));
    const s = r.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    if (!sign) return s;
    return r === 0 ? `+${s}` : x < 0 ? `${MINUS}${s}` : `+${s}`;
  },
  int: (n: number): string => String(n),
};
