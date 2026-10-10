// #250 (docs §8.106): the bars research/trend.ts reads the chart's Dow line
// on, and the walk that stands in for them in the checks.
//
//   * GMO's 15-minute and 1-hour day files and 4-hour year files, as the
//     chart reads them: both sides (quotes.ts mergeSides), the bars the
//     weekend leaves (barInsideClosure, §8.106 WEEKEND=inside), each closed
//     by the data's end, each with the key of the file it came from (the
//     chart's window is the bars of the files its walk reads, §8.106 1). A
//     kept day file is taken only if GMO made it after its day ended
//     (ownerhold-data wholeDayFile); the year files are always read again.
//   * GMO files a bar under its GMO day (21:00 UTC to 21:00 UTC: gmoDayKey),
//     a 4-hour bar under the year of that day (GMO's 2025 4-hour file holds
//     2025-01-01 20:00 .. 2025-12-31 20:00 UTC, public.gmo_kline_files). The
//     loader counts the bars found in another file than the rule names.
//   * The walk (MODE=syn): a minute at a time on GMO's week, Sunday 22:00
//     UTC to Friday 21:00 UTC in the US summer (GMO's Friday files of
//     2026-09-18, 09-25 and 10-02 end with the 20:45 15-minute bar, the
//     20:00 hour with prices moving) and 22:00 UTC otherwise (a choice for
//     the checks: its Friday 21:00 hour is filed under Saturday's day key),
//     shut on 12/25 and 1/1 (GMO days). Its 5-minute, 15-minute, 1-hour and
//     4-hour bars are on GMO's grid (a bar starts at floor(t / length) ×
//     length, so the 4-hour bar of Sunday 20:00 UTC holds the week's first
//     two hours), written as GMO's files and read back through the loader.

import { GMO_INTERVALS, GMO_SYMBOLS, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import { type LoadStats, type Source, digitsOf, gmoDayKey, getJson, keysOf, pool, sound, unitOf, wholeDayFile } from "./ownerhold-data.ts";
import { type Bars, type Tf, type WeekendOut, emptyBars, fromQuotes } from "./trend-labels.ts";
import { HOUR, MINUTE } from "./lib.ts";

export const STEP_OF: Record<Tf, number> = { "5min": 5 * MINUTE, "15min": 15 * MINUTE, "1h": HOUR, "4h": 4 * HOUR };

// the key of the file GMO files a bar under: its GMO day, or that day's year
export const gmoYearKey = (t: number): string => gmoDayKey(t).slice(0, 4);
export const ruleKeyOf = (tf: Tf, t: number): number => Number(GMO_INTERVALS[tf].key === "year" ? gmoYearKey(t) : gmoDayKey(t));

// ---- reading GMO's files ----------------------------------------------------------------------

// what the loader saw of one timeframe of one pair
export interface TfDiag {
  pair: string;
  tf: Tf;
  files: number;
  // a bar in two files (the newer file's key is kept), a bar on one side only, an ask closing under the bid
  repeated: number;
  oneSide: number;
  crossed: number;
  // bars kept, the first and last
  bars: number;
  first: number;
  last: number;
  // bars in another file than the rule names (gmoDayKey, or its year), and the first few
  keyMismatch: number;
  keyMismatchEx: string[];
  // Friday day files GMO made before 21:00 UTC (the summer's last hour still going on): their keys
  fridayEarly: string[];
  // the bars whose time is 15:00-20:59 UTC (a day file under that UTC date, not the next JST day's)
  lateUtc: number;
}

// One side of one file: its bars and when GMO made it (null: it could not be read). As ownerhold-data's
// readSide: a kept day file whose day had not ended when GMO made it is read again; a fresh one is read
// from GMO (src.fetch) or the folder (a walk's files, where a missing file is a failure).
const readFile = async (
  src: Source,
  symbol: string,
  interval: string,
  side: "bid" | "ask",
  key: string,
  fresh: boolean,
  st: LoadStats,
): Promise<{ rows: Array<{ t: number; c: Candle }>; made: number } | null> => {
  const path = `${src.dir}/${symbol}/${interval}/${side}/${key}.json`;
  const yearKey = key.length === 4;
  let body: unknown;
  if (!fresh || !src.fetch) {
    try {
      body = JSON.parse(await Deno.readTextFile(path));
    } catch {
      body = undefined;
    }
    if (body !== undefined && !sound(body)) body = undefined;
    if (body !== undefined && src.fetch && (yearKey || !wholeDayFile(body, key))) {
      st.partial++;
      body = undefined;
    }
  }
  if (body === undefined && src.fetch) {
    const r = await getJson(klineUrl(symbol, side, interval, key));
    st.requests++;
    // a 404 kept with the time it was asked (GMO's own answers carry responsetime)
    body = r.status === 404 ? { status: 404, data: [], responsetime: new Date().toISOString() } : r.body;
    if (r.status === 0 || !sound(body)) {
      st.failed++;
      st.failedWhy[r.why] = (st.failedWhy[r.why] ?? 0) + 1;
      if (st.failedExamples.length < 5) st.failedExamples.push(`${symbol} ${interval} ${side} ${key}: ${r.why}`);
      return null;
    }
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(body));
  } else if (body === undefined) {
    st.failed++;
    if (st.failedExamples.length < 5) st.failedExamples.push(`${symbol} ${interval} ${side} ${key}: no file`);
    return null;
  } else {
    st.cached++;
  }
  st.files++;
  const made = Date.parse(String((body as { responsetime?: unknown }).responsetime ?? ""));
  return { rows: parseKlines(body), made };
};

// the keys a read of [fromMs, toMs) opens: day files as ownerhold-data keysOf (the last three read
// again), year files every year from the first bar's to the last's (all read again)
export const keysFor = (tf: Tf, fromMs: number, toMs: number): { keys: string[]; fresh: Set<string> } => {
  if (GMO_INTERVALS[tf].key === "day") return keysOf(fromMs, toMs);
  const keys: string[] = [];
  for (let y = Number(gmoYearKey(fromMs)); y <= Number(gmoYearKey(toMs - 1)); y++) keys.push(String(y));
  return { keys, fresh: new Set(keys) };
};

// The bars of one pair and timeframe opened at or after fromMs and closed by toMs, the chart's way
export const loadTf = async (src: Source, pair: string, tf: Tf, fromMs: number, toMs: number, st: LoadStats, weekendOut: WeekendOut): Promise<{ bars: Bars; diag: TfDiag }> => {
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[tf];
  if (!symbol || !spec) throw new Error(`no GMO file for ${pair} ${tf}`);
  const step = STEP_OF[tf];
  const { keys, fresh } = keysFor(tf, fromMs, toMs);
  const got = new Map<string, { bid: Awaited<ReturnType<typeof readFile>>; ask: Awaited<ReturnType<typeof readFile>> }>();
  await pool(keys, 8, async (key) => {
    const bid = await readFile(src, symbol, spec.name, "bid", key, fresh.has(key), st);
    const ask = await readFile(src, symbol, spec.name, "ask", key, fresh.has(key), st);
    got.set(key, { bid, ask });
  });
  const diag: TfDiag = { pair, tf, files: 0, repeated: 0, oneSide: 0, crossed: 0, bars: 0, first: NaN, last: NaN, keyMismatch: 0, keyMismatchEx: [], fridayEarly: [], lateUtc: 0 };
  // oldest file first, as the chart's walk puts each older file in front (mergeSides keeps the first bid)
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: Array<{ t: number; c: Candle }> = [];
  const keyOfT = new Map<number, number>();
  for (const key of keys) {
    const g = got.get(key);
    if (!g || !g.bid || !g.ask) continue;
    diag.files++;
    const kn = Number(key);
    for (const x of g.bid.rows) {
      const was = keyOfT.get(x.t);
      if (was !== undefined) diag.repeated++;
      if (was === undefined || kn > was) keyOfT.set(x.t, kn);
      bid.push(x);
    }
    ask.push(...g.ask.rows);
    if (spec.key === "day" && new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)))).getUTCDay() === 5) {
      const end = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)), 21);
      if (g.bid.rows.length > 0 && (g.bid.made < end || g.ask.made < end)) diag.fridayEarly.push(key);
    }
  }
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  const asks = new Map(ask.map((x) => [x.t, x.c]));
  for (const x of bid) {
    const a = asks.get(x.t);
    if (!a) diag.oneSide++;
    else if (a.close < x.c.close) diag.crossed++;
  }
  const qs = mergeSides(bid, ask).filter((q) => {
    const t = Date.parse(q.datetime);
    return Number.isFinite(t) && t >= fromMs && t + step <= toMs && !weekendOut(t, step);
  });
  const bars = fromQuotes(qs, (t) => keyOfT.get(t) ?? -1);
  diag.bars = bars.n;
  diag.first = bars.n ? bars.t[0] : NaN;
  diag.last = bars.n ? bars.t[bars.n - 1] : NaN;
  for (let i = 0; i < bars.n; i++) {
    const rule = ruleKeyOf(tf, bars.t[i]);
    if (bars.key[i] !== rule) {
      diag.keyMismatch++;
      if (diag.keyMismatchEx.length < 5) diag.keyMismatchEx.push(`${new Date(bars.t[i]).toISOString()} in ${bars.key[i]}, rule ${rule}`);
    }
    const h = new Date(bars.t[i]).getUTCHours();
    if (spec.key === "day" && h >= 15 && h < 21) diag.lateUtc++;
  }
  return { bars, diag };
};

// ---- the bars against each other ----------------------------------------------------------------

// The 1-hour and 4-hour bars against the 15-minute bars inside them (the first open, the highest high,
// the lowest low, the last close, each side): how many coarse bars hold 15-minute bars, how many of
// them differ, and how many of those lie in a Friday file GMO made before 21:00 UTC
export interface Agree {
  compared: number;
  differ: number;
  differFridayEarly: number;
  // coarse bars with no 15-minute bar inside, and 15-minute bars with no coarse bar over them
  coarseAlone: number;
  fineAlone: number;
  examples: string[];
}
export const agreeWith15 = (coarse: Bars, step: number, fine: Bars, fridayEarly: Set<number>): Agree => {
  const res: Agree = { compared: 0, differ: 0, differFridayEarly: 0, coarseAlone: 0, fineAlone: 0, examples: [] };
  const at = new Map<number, number>();
  for (let i = 0; i < coarse.n; i++) at.set(coarse.t[i], i);
  const seen = new Set<number>();
  let j = 0;
  while (j < fine.n) {
    const s = Math.floor(fine.t[j] / step) * step;
    let e = j;
    while (e + 1 < fine.n && Math.floor(fine.t[e + 1] / step) * step === s) e++;
    const i = at.get(s);
    if (i === undefined) res.fineAlone += e - j + 1;
    else {
      seen.add(i);
      res.compared++;
      let bh = -Infinity, bl = Infinity, ah = -Infinity, al = Infinity;
      for (let k = j; k <= e; k++) {
        bh = Math.max(bh, fine.bh[k]);
        bl = Math.min(bl, fine.bl[k]);
        ah = Math.max(ah, fine.ah[k]);
        al = Math.min(al, fine.al[k]);
      }
      const same = coarse.bo[i] === fine.bo[j] && coarse.ao[i] === fine.ao[j] && coarse.bc[i] === fine.bc[e] && coarse.ac[i] === fine.ac[e] &&
        coarse.bh[i] === bh && coarse.bl[i] === bl && coarse.ah[i] === ah && coarse.al[i] === al;
      if (!same) {
        res.differ++;
        if (fridayEarly.has(coarse.key[i])) res.differFridayEarly++;
        if (res.examples.length < 5) res.examples.push(`${new Date(s).toISOString()} (file ${coarse.key[i]})`);
      }
    }
    j = e + 1;
  }
  for (let i = 0; i < coarse.n; i++) if (!seen.has(i)) res.coarseAlone++;
  return res;
};

// ---- the walk ---------------------------------------------------------------------------------

// each pair's walk: where it starts (pips), its spread and how far a minute moves (pips; ownerhold-data's)
const SYN: Record<string, { start: number; spread: number; sigma: number }> = {
  "USD/JPY": { start: 15_000, spread: 0.2, sigma: 1.5 },
  "EUR/JPY": { start: 16_000, spread: 0.5, sigma: 1.6 },
  "AUD/JPY": { start: 10_000, spread: 0.6, sigma: 1.4 },
  "EUR/USD": { start: 10_800, spread: 0.3, sigma: 1.0 },
  "AUD/USD": { start: 6_600, spread: 0.5, sigma: 0.9 },
};

// GMO's week for the walk (above): open from Sunday 22:00 UTC to Friday 21:00 UTC in the US summer and
// 22:00 UTC otherwise, shut on the GMO days 12/25 and 1/1
export const walkOpen = (ms: number): boolean => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && h >= (nyOffsetMs(ms) === -4 * HOUR ? 21 : 22)) return false;
  if (day === 0 && h < 22) return false;
  const md = gmoDayKey(ms).slice(4);
  return md !== "1225" && md !== "0101";
};

// mulberry32
const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface WalkSpec {
  seed: number;
  // #250 段1の作り 8: an effect added to the walk's moves (none, or absent: stage 0's walk, unchanged). The
  // effect draws from a stream of its own, so the walk's own moves are those of the walk without it.
  //   on     each pair has a direction (up or down) that turns with chance 5 / (60 × hours) at each 5-minute
  //          bar; a minute moves direction × strength × the pair's minute (the trend goes on)
  //   back   the mid is pulled to a centre at ln 2 / (60 × hours) of the distance a minute (hours: the
  //          half-life); the centre moves strength × the pair's minute a minute at random (the trend turns back)
  //   drift  a minute moves strength × the pair's minute, up or down by pair (DRIFT_SIGN): the same all along
  kind?: "none" | "on" | "back" | "drift";
  strength?: number;
  hours?: number;
}
// the drift walks' direction of each pair (PAIRS' order): up, all five (a drift down strong enough to tell BUY from
// SELL would take the lower starts to 0 within the period)
export const DRIFT_SIGN = [1, 1, 1, 1, 1];

// One pair's walk as 5-minute bars (both sides, GMO's digits) from fromMs to toMs: a minute is four steps
// of the mid, a 5-minute bar five minutes; after a closure the mid jumps (three 15-minute moves' worth)
export const walk5 = (pair: string, pi: number, spec: WalkSpec, fromMs: number, toMs: number): Bars => {
  const p = SYN[pair];
  if (!p) throw new Error(`no walk for ${pair}`);
  const unit = unitOf(pair);
  const dg = digitsOf(pair);
  const rnd = rng(spec.seed * 1009 + pi * 7919 + 250);
  const kind = spec.kind ?? "none";
  const strength = spec.strength ?? 0;
  const hours = spec.hours ?? 0;
  if (kind !== "none" && !(strength >= 0 && (kind === "drift" || hours > 0))) throw new Error(`${pair}: walk ${kind} strength ${strength} hours ${hours}`);
  const eff = rng(spec.seed * 1009 + pi * 7919 + 250 + 500_000);
  let effSpare: number | null = null;
  const effGauss = () => {
    if (effSpare !== null) {
      const v = effSpare;
      effSpare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = eff();
    const v = eff();
    const rr = Math.sqrt(-2 * Math.log(u));
    effSpare = rr * Math.sin(2 * Math.PI * v);
    return rr * Math.cos(2 * Math.PI * v);
  };
  let way = kind === "on" ? (eff() < 0.5 ? 1 : -1) : 0;
  let centre = p.start;
  const pull = kind === "back" ? Math.log(2) / (60 * hours) : 0;
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = rnd();
    const v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const r = (v: number) => Number((v * unit).toFixed(dg));
  const half = p.spread / 2;
  const from = Math.ceil(fromMs / (5 * MINUTE)) * 5 * MINUTE;
  const cap = Math.ceil((toMs - from) / (5 * MINUTE)) + 1;
  const b = emptyBars(cap);
  let x = p.start;
  let shut = false;
  let k = 0;
  for (let t = from; t + 5 * MINUTE <= toMs; t += 5 * MINUTE) {
    if (!walkOpen(t)) {
      shut = true;
      continue;
    }
    if (shut) {
      x += 3 * p.sigma * Math.sqrt(15) * gauss();
      shut = false;
    }
    if (kind === "on" && eff() < 5 / (60 * hours)) way = -way;
    if (kind === "back") centre += strength * p.sigma * Math.sqrt(5) * effGauss();
    const o = x;
    let h = x;
    let l = x;
    for (let st = 0; st < 20; st++) {
      x += (p.sigma / 2) * gauss();
      // a step is a quarter of a minute
      if (kind === "on") x += (way * strength * p.sigma) / 4;
      else if (kind === "drift") x += (DRIFT_SIGN[pi] * strength * p.sigma) / 4;
      else if (kind === "back") x -= (pull / 4) * (x - centre);
      if (x > h) h = x;
      if (x < l) l = x;
    }
    if (l - half <= 0) throw new Error(`${pair} seed ${spec.seed}: the walk reached 0`);
    b.t[k] = t;
    const ro = r(o - half), rc = r(x - half);
    b.bo[k] = ro;
    b.bc[k] = rc;
    b.bh[k] = Math.max(r(h - half), ro, rc);
    b.bl[k] = Math.min(r(l - half), ro, rc);
    const ao = r(o + half), ac = r(x + half);
    b.ao[k] = ao;
    b.ac[k] = ac;
    b.ah[k] = Math.max(r(h + half), ao, ac);
    b.al[k] = Math.min(r(l + half), ao, ac);
    b.key[k] = ruleKeyOf("5min", t);
    k++;
  }
  const cut = (xs: Float64Array) => xs.slice(0, k);
  return { n: k, t: cut(b.t), bo: cut(b.bo), bh: cut(b.bh), bl: cut(b.bl), bc: cut(b.bc), ao: cut(b.ao), ah: cut(b.ah), al: cut(b.al), ac: cut(b.ac), key: b.key.slice(0, k) };
};

// coarser bars from the 5-minute ones on GMO's grid (start = floor(t / step) × step), each filed by the rule
export const coarsen = (f: Bars, tf: Tf): Bars => {
  const step = STEP_OF[tf];
  const starts: number[] = [];
  for (let i = 0; i < f.n; i++) if (i === 0 || Math.floor(f.t[i] / step) !== Math.floor(f.t[i - 1] / step)) starts.push(i);
  const out = emptyBars(starts.length);
  starts.forEach((s, j) => {
    const e = j + 1 < starts.length ? starts[j + 1] - 1 : f.n - 1;
    const t = Math.floor(f.t[s] / step) * step;
    out.t[j] = t;
    out.bo[j] = f.bo[s];
    out.ao[j] = f.ao[s];
    out.bc[j] = f.bc[e];
    out.ac[j] = f.ac[e];
    let bh = -Infinity, bl = Infinity, ah = -Infinity, al = Infinity;
    for (let i = s; i <= e; i++) {
      bh = Math.max(bh, f.bh[i]);
      bl = Math.min(bl, f.bl[i]);
      ah = Math.max(ah, f.ah[i]);
      al = Math.min(al, f.al[i]);
    }
    out.bh[j] = bh;
    out.bl[j] = bl;
    out.ah[j] = ah;
    out.al[j] = al;
    out.key[j] = ruleKeyOf(tf, t);
  });
  return out;
};

// A walk written as GMO's files under dir: 5min, 15min and 1hour day files for every day key a read of
// [fromMs, toMs) opens (a day without bars an empty list, as GMO answers a weekend), 4hour year files.
// `emptyDays`: day keys of one timeframe written empty (a file GMO lost: the planted hole of the checks).
export const writeWalk = async (dir: string, pair: string, bars: Record<"5min" | "15min" | "1h" | "4h", Bars>, fromMs: number, toMs: number, emptyDays: Array<{ tf: Tf; key: string }> = []) => {
  const symbol = GMO_SYMBOLS[pair];
  const dg = digitsOf(pair);
  const f = (v: number) => v.toFixed(dg);
  for (const tf of ["5min", "15min", "1h", "4h"] as const) {
    const b = bars[tf];
    const files = new Map<string, { bid: unknown[]; ask: unknown[] }>();
    for (let i = 0; i < b.n; i++) {
      const key = String(b.key[i]);
      let d = files.get(key);
      if (!d) files.set(key, (d = { bid: [], ask: [] }));
      const ot = String(b.t[i]);
      d.bid.push({ openTime: ot, open: f(b.bo[i]), high: f(b.bh[i]), low: f(b.bl[i]), close: f(b.bc[i]) });
      d.ask.push({ openTime: ot, open: f(b.ao[i]), high: f(b.ah[i]), low: f(b.al[i]), close: f(b.ac[i]) });
    }
    const { keys } = keysFor(tf, fromMs, toMs);
    for (const key of new Set([...keys, ...files.keys()])) {
      const blank = emptyDays.some((x) => x.tf === tf && x.key === key);
      const d = blank ? { bid: [], ask: [] } : files.get(key) ?? { bid: [], ask: [] };
      for (const side of ["bid", "ask"] as const) {
        const path = `${dir}/${symbol}/${GMO_INTERVALS[tf].name}/${side}/${key}.json`;
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        await Deno.writeTextFile(path, JSON.stringify({ status: 0, data: d[side] }));
      }
    }
  }
};

// the walk's 15-minute bars as the quotes signalsOf reads (load15 reads the same from the files)
export const quotesOf = (b: Bars): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  for (let i = 0; i < b.n; i++) {
    const datetime = new Date(b.t[i]).toISOString();
    out.push({ datetime, bid: { datetime, open: b.bo[i], high: b.bh[i], low: b.bl[i], close: b.bc[i] }, ask: { datetime, open: b.ao[i], high: b.ah[i], low: b.al[i], close: b.ac[i] } });
  }
  return out;
};

