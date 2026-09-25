// The arithmetic behind research/longhist.ts (#109): daily trend following
// and carry over 25 years, kept apart from the downloading so the vitest
// suite can check it (src/test/longhist.test.ts).
//
// The request: 「全部実装お願いします」, to the plan after #108 — test on long
// history the two sources of return the literature on currencies keeps
// finding (time-series momentum / trend following on daily-to-monthly
// horizons, and carry, the interest-rate differential a position earns or
// pays each night), because every short-term timing rule tried so far
// (#102-#107) did no better than entering at random.
//
// Deno-free on purpose.

export interface Daily {
  dates: string[];
  px: number[];
}

// ---- data -------------------------------------------------------------------------

// The ECB's reference rates (eurofxref-hist.csv): one row per business day,
// newest first, "Date,USD,JPY,...", each value the units of that currency one
// euro bought, "N/A" where there was none.
export const parseEcb = (csv: string): Map<string, Map<string, number>> => {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = new Map<string, Map<string, number>>();
  if (lines.length < 2) return out;
  const head = lines[0].split(",").map((h) => h.trim());
  for (const cur of head.slice(1)) if (cur) out.set(cur, new Map());
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const date = cells[0]?.trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (let k = 1; k < head.length; k++) {
      const cur = head[k];
      if (!cur) continue;
      const v = Number(cells[k]);
      if (Number.isFinite(v) && v > 0) out.get(cur)!.set(date, v);
    }
  }
  return out;
};

// BASE/QUOTE from per-euro rates: QUOTE per EUR over BASE per EUR (the euro
// itself is 1). Only days on which both legs were fixed, oldest first.
export const crossSeries = (ecb: Map<string, Map<string, number>>, base: string, quote: string): Daily => {
  const leg = (c: string) => (c === "EUR" ? null : ecb.get(c) ?? new Map<string, number>());
  const b = leg(base);
  const q = leg(quote);
  const days = new Set<string>();
  for (const m of [b, q]) if (m) for (const d of m.keys()) days.add(d);
  const dates = [...days].sort();
  const out: Daily = { dates: [], px: [] };
  for (const d of dates) {
    const bv = b === null ? 1 : b.get(d);
    const qv = q === null ? 1 : q.get(d);
    if (bv === undefined || qv === undefined) continue;
    out.dates.push(d);
    out.px.push(qv / bv);
  }
  return out;
};

// FRED's CSV download: "observation_date,SERIES" (older files say "DATE"),
// one row per month dated its first day, "." where missing.
export const parseFred = (csv: string): Array<[string, number]> => {
  const out: Array<[string, number]> = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(",");
    const x = Number(v);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim()) && Number.isFinite(x)) out.push([d.trim(), x]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
};

// One CSV line, with quoted cells (which may hold commas and "" for a quote)
export const csvCells = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
};

// The BIS's central bank policy rates (WS_CBPOL, the bulk "flat" CSV): one
// observation per row, the columns named "FREQ:Frequency",
// "REF_AREA:Reference area", "TIME_PERIOD:...", "OBS_VALUE:..." (only the
// part before the colon is relied on). The monthly rows of the areas asked
// for, dated the first of their month like FRED's, oldest first. Used when
// FRED cannot be reached (#109): a policy rate, not a 3-month rate — the
// two part most in funding stresses such as late 2008.
export const parseBisPolicy = (csv: string, areas: string[]): Record<string, Array<[string, number]>> => {
  const out: Record<string, Array<[string, number]>> = {};
  for (const a of areas) out[a] = [];
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) return out;
  const head = csvCells(lines[0]).map((h) => h.split(":")[0].trim().toUpperCase());
  const iF = head.indexOf("FREQ");
  const iA = head.indexOf("REF_AREA");
  const iT = head.indexOf("TIME_PERIOD");
  const iV = head.indexOf("OBS_VALUE");
  if (iF < 0 || iA < 0 || iT < 0 || iV < 0) return out;
  const want = new Set(areas);
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = csvCells(line);
    const freq = c[iF]?.split(":")[0].trim();
    const area = c[iA]?.split(":")[0].trim();
    if (freq !== "M" || !area || !want.has(area)) continue;
    const t = c[iT]?.trim() ?? "";
    const v = Number(c[iV]);
    if (!/^\d{4}-\d{2}$/.test(t) || c[iV]?.trim() === "" || !Number.isFinite(v)) continue;
    out[area].push([`${t}-01`, v]);
  }
  for (const a of areas) out[a].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return out;
};

// The rate a position held on `date` could have known: the value of the
// month BEFORE it (a monthly average is not published until its month is
// over), carried for at most three more months when the series stops.
export const rateBefore = (monthly: Array<[string, number]>, date: string): number | null => {
  const month = date.slice(0, 7);
  let best: [string, number] | null = null;
  for (const row of monthly) {
    if (row[0].slice(0, 7) >= month) break;
    best = row;
  }
  if (!best) return null;
  const [y1, m1] = best[0].slice(0, 7).split("-").map(Number);
  const [y2, m2] = month.split("-").map(Number);
  const gap = (y2 - y1) * 12 + (m2 - m1);
  return gap <= 4 ? best[1] : null;
};

// ---- rules ----------------------------------------------------------------------------
// Each returns the position held from the close of day t to the close of day
// t+1, decided on closes up to t only: +1 long, -1 short, 0 flat.

const sma = (px: number[], n: number, t: number): number | null => {
  if (t < n - 1) return null;
  let s = 0;
  for (let j = t - n + 1; j <= t; j++) s += px[j];
  return s / n;
};

export type Rule = (px: number[]) => number[];

export const tsmom252: Rule = (px) => px.map((p, t) => (t < 252 ? 0 : Math.sign(p / px[t - 252] - 1)));

export const ma200: Rule = (px) =>
  px.map((p, t) => {
    const m = sma(px, 200, t);
    return m === null ? 0 : Math.sign(p - m);
  });

export const ma50x200: Rule = (px) =>
  px.map((_, t) => {
    const a = sma(px, 50, t);
    const b = sma(px, 200, t);
    return a === null || b === null ? 0 : Math.sign(a - b);
  });

// In on a close beyond the last 55 closes, out on a close back beyond the
// last 20 the other way (the long-standing "System 2" breakout).
export const donchian55x20: Rule = (px) => {
  const out: number[] = px.map(() => 0);
  let pos = 0;
  for (let t = 55; t < px.length; t++) {
    let hi55 = -Infinity, lo55 = Infinity, hi20 = -Infinity, lo20 = Infinity;
    for (let j = t - 55; j < t; j++) {
      hi55 = Math.max(hi55, px[j]);
      lo55 = Math.min(lo55, px[j]);
      if (j >= t - 20) {
        hi20 = Math.max(hi20, px[j]);
        lo20 = Math.min(lo20, px[j]);
      }
    }
    const p = px[t];
    if (pos === 1 && p < lo20) pos = 0;
    else if (pos === -1 && p > hi20) pos = 0;
    if (pos === 0) {
      if (p > hi55) pos = 1;
      else if (p < lo55) pos = -1;
    }
    out[t] = pos;
  }
  return out;
};

export const TREND_RULES: Record<string, Rule> = { tsmom252, ma200, ma50x200, donchian55x20 };

// ---- simulation ---------------------------------------------------------------------------

export interface SimOptions {
  // the price of one pip, for the spread
  pip: number;
  // spread paid on a full change of position, in pips
  spreadPips: number;
  // annualised volatility each position is scaled to
  targetVol: number;
  // the base-minus-quote interest differential (% a year) a position held
  // on day t earns, or null where it is not known; absent: no carry at all
  carry?: (t: number) => number | null;
  // what a broker keeps from the differential, % a year, on either side
  haircut?: number;
}

export interface Sim {
  // day-by-day result of the position held into day t (0 on day 0)
  pnl: number[];
  // whether the carry for that day was known (always true without carry)
  carryKnown: boolean[];
  turnover: number;
}

// Log returns, positions scaled to a constant volatility using the last 60
// days (known at t), spread paid on every change of position, carry accrued
// per calendar day held (weekends included: a position held over Friday
// night is paid three nights of swap on the next roll).
export const simulate = (d: Daily, pos: number[], o: SimOptions): Sim => {
  const n = d.px.length;
  const pnl = new Array<number>(n).fill(0);
  const carryKnown = new Array<boolean>(n).fill(true);
  const r = d.px.map((p, t) => (t === 0 ? 0 : Math.log(p / d.px[t - 1])));
  const dailyTarget = o.targetVol / Math.sqrt(252);
  let prevW = 0;
  let turnover = 0;
  for (let t = 0; t < n - 1; t++) {
    let v = 0;
    let m = 0;
    for (let j = Math.max(1, t - 59); j <= t; j++) {
      v += r[j] * r[j];
      m++;
    }
    const sigma = m >= 20 ? Math.sqrt(v / m) : 0;
    const w = sigma > 0 ? Math.min(5, dailyTarget / sigma) * pos[t] : 0;
    const change = Math.abs(w - prevW);
    turnover += change;
    const cost = change * 0.5 * (o.spreadPips * o.pip) / d.px[t];
    let carry = 0;
    if (o.carry && w !== 0) {
      const diff = o.carry(t);
      if (diff === null) carryKnown[t + 1] = false;
      else {
        const days = Math.max(1, Math.round((Date.parse(d.dates[t + 1]) - Date.parse(d.dates[t])) / 86_400_000));
        carry = ((w * diff - Math.abs(w) * (o.haircut ?? 0)) / 100) * (days / 365);
      }
    }
    pnl[t + 1] = w * r[t + 1] - cost + carry;
    prevW = w;
  }
  return { pnl, carryKnown, turnover };
};

// ---- statistics -----------------------------------------------------------------------------

export interface Stats {
  days: number;
  annRet: number;
  annVol: number;
  sharpe: number;
  maxDD: number;
  yearsUp: number;
  years: number;
  worstMonth: number;
}

// Over the days in [from, to), with any day `skip` marks left out
export const statsOf = (dates: string[], pnl: number[], from: string, to: string, skip?: boolean[]): Stats | null => {
  const xs: number[] = [];
  const byYear = new Map<string, number>();
  const byMonth = new Map<string, number>();
  let eq = 0, peak = 0, dd = 0;
  for (let t = 1; t < dates.length; t++) {
    const d = dates[t];
    if (d < from || d >= to || (skip && skip[t])) continue;
    xs.push(pnl[t]);
    eq += pnl[t];
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq - peak);
    byYear.set(d.slice(0, 4), (byYear.get(d.slice(0, 4)) ?? 0) + pnl[t]);
    byMonth.set(d.slice(0, 7), (byMonth.get(d.slice(0, 7)) ?? 0) + pnl[t]);
  }
  if (xs.length < 60) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  const years = [...byYear.values()];
  return {
    days: xs.length,
    annRet: mean * 252,
    annVol: sd * Math.sqrt(252),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    maxDD: dd,
    yearsUp: years.filter((y) => y > 0).length,
    years: years.length,
    worstMonth: Math.min(...byMonth.values()),
  };
};

// Equal-weight portfolio of several pairs' daily results, aligned by date.
// A leg whose result is not known that day (its carry was unknown) is left
// out of that day's average rather than voiding the day for every pair; a
// day is skipped only when no leg is known.
export const portfolio = (legs: Array<{ dates: string[]; pnl: number[]; skip?: boolean[] }>): { dates: string[]; pnl: number[]; skip: boolean[] } => {
  const sum = new Map<string, { s: number; k: number }>();
  for (const leg of legs) {
    for (let t = 1; t < leg.dates.length; t++) {
      const e = sum.get(leg.dates[t]) ?? { s: 0, k: 0 };
      if (!leg.skip?.[t]) {
        e.s += leg.pnl[t];
        e.k++;
      }
      sum.set(leg.dates[t], e);
    }
  }
  const dates = [...sum.keys()].sort();
  return {
    dates,
    pnl: dates.map((d) => (sum.get(d)!.k > 0 ? sum.get(d)!.s / sum.get(d)!.k : 0)),
    skip: dates.map((d) => sum.get(d)!.k === 0),
  };
};

// Placebo positions: random direction, changed with probability `flip` each
// day, so they trade about as often as a real rule and are scaled and
// charged the same way. What a portfolio of them earns is what luck earns.
export const placebo = (n: number, flip: number, seed: number): number[] => {
  let s = seed | 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  let p = rnd() < 0.5 ? 1 : -1;
  for (let t = 0; t < n; t++) {
    if (rnd() < flip) p = -p;
    out.push(t < 252 ? 0 : p);
  }
  return out;
};
