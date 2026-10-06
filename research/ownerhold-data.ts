// #205 (docs §8.102): the bars and the signals research/ownerhold.ts measures
// on. GMO's 15-minute bid and ask bars make the emails' ULTRA signals the way
// research/tf-winrate.ts makes them; GMO's 1-minute bid and ask bars are what
// the owner's orders are followed on. The synthetic runs (確かめ A) write a
// seeded random walk out as GMO's day files and read it back through the
// same loader, so the program and the Python check (ownerhold-check.py) read
// the same files either way.

import { GMO_SYMBOLS, dateKeys, jstDayKey, klineUrl, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure, isPossiblyClosed, nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs } from "../supabase/functions/_shared/qtrend.ts";
import { ULTRA_PAIRS, ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { freshFor, indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE } from "./lib.ts";

// the five pairs, in Rakuten's list order (the order orders of one minute are taken in)
export const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
export const isUsdPair = (pair: string): boolean => pair.endsWith("/USD");
export const unitOf = (pair: string): number => ultraUnit(pair);
export const digitsOf = (pair: string): number => (pair.includes("JPY") ? 3 : 5);
const STEP15 = 15 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
// 15-minute bars read before START for the first bar's window (tf-winrate LEAD_DAYS)
export const LEAD15 = 12 * DAY;
// when the sweep reads a 15-minute chart, minutes after its close (indicators.ts gmoIntervalsDue)
const READ_AFTER = [1, 3];
const FRESH = freshFor("15min");
// bars checked against indicatorSignals (tf-winrate CHECK_EVERY on 15min), and every 7th signal
const CHECK_EVERY = 223;

export interface M1 {
  pair: string;
  n: number;
  // each bar's open, ms; the bid's and the ask's open, high, low and close
  t: Float64Array;
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
}

export interface LoadStats {
  requests: number;
  cached: number;
  failed: number;
  files: number;
  // bars left out: on one side only, an ask close under the bid's, inside the weekend's closure, a repeated time
  oneSide: number;
  crossed: number;
  closure: number;
  repeated: number;
}
export const newLoadStats = (): LoadStats => ({ requests: 0, cached: 0, failed: 0, files: 0, oneSide: 0, crossed: 0, closure: 0, repeated: 0 });

// ---- GMO's day files ----------------------------------------------------------------------

const getJson = async (url: string): Promise<{ status: number; body: unknown }> => {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (r.status === 404) {
        await r.body?.cancel();
        return { status: 404, body: null };
      }
      if (r.status === 429 || r.status >= 500) {
        await r.body?.cancel();
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        continue;
      }
      return { status: r.status, body: await r.json() };
    } catch {
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  return { status: 0, body: null };
};

// GMO's answer with its bars (a day without any is an empty list), or the 404 of a day it has no file for
const sound = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; data?: unknown };
  return (b.status === 0 || b.status === 404) && Array.isArray(b.data);
};

export interface Source {
  // where the day files are kept: research/.cache (tf-winrate's layout), or a synthetic run's own folder
  dir: string;
  // false: read the folder only (a synthetic run's files); a missing file is a failure
  fetch: boolean;
}

// one side of one day file, its bars (null: it could not be read)
const readSide = async (src: Source, symbol: string, interval: string, side: "bid" | "ask", key: string, fresh: boolean, st: LoadStats) => {
  const path = `${src.dir}/${symbol}/${interval}/${side}/${key}.json`;
  let body: unknown;
  if (!fresh || !src.fetch) {
    try {
      body = JSON.parse(await Deno.readTextFile(path));
    } catch {
      body = undefined;
    }
    if (body !== undefined && !sound(body)) body = undefined;
  }
  if (body === undefined && src.fetch) {
    const r = await getJson(klineUrl(symbol, side, interval, key));
    st.requests++;
    body = r.status === 404 ? { status: 404, data: [] } : r.body;
    if (r.status === 0 || !sound(body)) {
      st.failed++;
      return null;
    }
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(body));
  } else if (body === undefined) {
    st.failed++;
    return null;
  } else {
    st.cached++;
  }
  st.files++;
  return parseKlines(body);
};

// the day keys a window touches (dateKeys, padded a day each way), none past END's own day;
// the last three read again from GMO (a file kept while its day was going on is not whole)
const keysOf = (fromMs: number, toMs: number) => {
  const last = jstDayKey(toMs);
  const keys = dateKeys(fromMs, toMs, "day").filter((k) => k <= last);
  return { keys, fresh: new Set(keys.slice(-3)) };
};

const pool = async <T>(items: T[], n: number, f: (x: T) => Promise<void>) => {
  let cursor = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) await f(items[cursor++]);
  }));
};

// GMO's 1-minute bars of a pair, both sides, opened at or after `fromMs` and
// closed by `toMs`: a bar on one side only, an ask closing under the bid
// (quotes.ts mergeSides), a bar inside the weekend's closure (usableBars) and
// a repeated time are left out and counted
export const loadM1 = async (src: Source, pair: string, fromMs: number, toMs: number, st: LoadStats): Promise<M1> => {
  const symbol = GMO_SYMBOLS[pair];
  if (!symbol) throw new Error(`${pair}: not a GMO symbol`);
  const { keys, fresh } = keysOf(fromMs, toMs);
  const days = new Map<string, Array<{ t: number; b: Candle; a: Candle }>>();
  await pool(keys, 8, async (key) => {
    const bid = await readSide(src, symbol, "1min", "bid", key, fresh.has(key), st);
    const ask = await readSide(src, symbol, "1min", "ask", key, fresh.has(key), st);
    if (!bid || !ask) return;
    const asks = new Map(ask.map((x) => [x.t, x.c]));
    const rows: Array<{ t: number; b: Candle; a: Candle }> = [];
    for (const x of bid) {
      const a = asks.get(x.t);
      if (!a) {
        st.oneSide++;
        continue;
      }
      asks.delete(x.t);
      if (a.close < x.c.close) {
        st.crossed++;
        continue;
      }
      rows.push({ t: x.t, b: x.c, a });
    }
    st.oneSide += asks.size;
    days.set(key, rows);
  });
  let n = 0;
  for (const rows of days.values()) n += rows.length;
  const m: M1 = { pair, n: 0, t: new Float64Array(n), bo: new Float64Array(n), bh: new Float64Array(n), bl: new Float64Array(n), bc: new Float64Array(n), ao: new Float64Array(n), ah: new Float64Array(n), al: new Float64Array(n), ac: new Float64Array(n) };
  let k = 0;
  let last = -Infinity;
  for (const key of keys) {
    for (const r of days.get(key) ?? []) {
      if (r.t < fromMs || r.t + MINUTE > toMs) continue;
      if (barInsideClosure(r.t, MINUTE)) {
        st.closure++;
        continue;
      }
      if (r.t <= last) {
        st.repeated++;
        continue;
      }
      last = r.t;
      m.t[k] = r.t;
      m.bo[k] = r.b.open;
      m.bh[k] = r.b.high;
      m.bl[k] = r.b.low;
      m.bc[k] = r.b.close;
      m.ao[k] = r.a.open;
      m.ah[k] = r.a.high;
      m.al[k] = r.a.low;
      m.ac[k] = r.a.close;
      k++;
    }
  }
  // the arrays cut to the bars kept (a search over them must not meet the unused tail)
  const cut = (xs: Float64Array) => xs.subarray(0, k);
  return { pair, n: k, t: cut(m.t), bo: cut(m.bo), bh: cut(m.bh), bl: cut(m.bl), bc: cut(m.bc), ao: cut(m.ao), ah: cut(m.ah), al: cut(m.al), ac: cut(m.ac) };
};

// GMO's 15-minute bars of a pair (tf-winrate.ts load, 15min, WEEKEND inside):
// both sides, opened at or after `fromMs`, closed by `toMs`
export const load15 = async (src: Source, pair: string, fromMs: number, toMs: number, st: LoadStats): Promise<QuoteCandle[]> => {
  const symbol = GMO_SYMBOLS[pair];
  if (!symbol) throw new Error(`${pair}: not a GMO symbol`);
  const { keys, fresh } = keysOf(fromMs, toMs);
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: typeof bid = [];
  await pool(keys, 8, async (key) => {
    const b = await readSide(src, symbol, "15min", "bid", key, fresh.has(key), st);
    const a = await readSide(src, symbol, "15min", "ask", key, fresh.has(key), st);
    if (b) bid.push(...b);
    if (a) ask.push(...a);
  });
  bid.sort((x, y) => x.t - y.t);
  ask.sort((x, y) => x.t - y.t);
  const asks = new Map(ask.map((x) => [x.t, x.c]));
  const out: QuoteCandle[] = [];
  const seen = new Set<number>();
  for (const x of bid) {
    if (seen.has(x.t)) continue;
    const a = asks.get(x.t);
    if (!a || a.close < x.c.close) continue;
    seen.add(x.t);
    if (x.t < fromMs || x.t + STEP15 > toMs || barInsideClosure(x.t, STEP15)) continue;
    out.push({ datetime: x.c.datetime, bid: x.c, ask: a });
  }
  return out;
};

// ---- the synthetic walk ---------------------------------------------------------------------

// each pair's walk: where it starts (pips), its spread and how far a minute
// moves (pips, the standard deviation; about GMO's: a day's move some 60 to
// 90 pips on the yen pairs, 40 to 50 on the dollar pairs)
const SYN: Record<string, { start: number; spread: number; sigma: number }> = {
  "USD/JPY": { start: 15_000, spread: 0.2, sigma: 1.5 },
  "EUR/JPY": { start: 16_000, spread: 0.5, sigma: 1.6 },
  "AUD/JPY": { start: 10_000, spread: 0.6, sigma: 1.4 },
  "EUR/USD": { start: 10_800, spread: 0.3, sigma: 1.0 },
  "AUD/USD": { start: 6_600, spread: 0.5, sigma: 0.9 },
};

export interface SynthSpec {
  seed: number;
  // pips a minute added in the signal-less direction of each pair: + on the
  // 1st, 3rd and 5th pairs of PAIRS, − on the 2nd and 4th (§8.102 確かめ A (2))
  trend: number;
  // every pair starts here (pips) instead of SYN's (100,000 for the trend sets)
  startPips: number | null;
}

// the key of GMO's day file a bar is in: its day starts at 06:00 JST (21:00 UTC; research/gotobi.ts fileKeyOf)
export const gmoDayKey = (t: number): string => jstDayKey(t - 6 * HOUR);

// mulberry32 (research/gmo.ts)
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

// the forex week of the walk: shut from Friday 21:00 UTC (22:00 outside the
// US summer) to Sunday 21:00 (22:00), New York's offset (market-hours nyOffsetMs)
export const synthOpen = (ms: number): boolean => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  const roll = nyOffsetMs(ms) === -4 * HOUR ? 21 : 22;
  if (day === 6) return false;
  if (day === 5 && h >= roll) return false;
  if (day === 0 && h < roll) return false;
  return true;
};

const fixed = (x: number, d: number) => x.toFixed(d);

// The walk of one pair, minute by minute from `fromMs` to `toMs`, written as
// GMO's 1-minute and 15-minute day files (both sides) under `dir`. A minute
// is four steps of the mid; the bid and ask are the mid ∓ half the spread,
// rounded to GMO's digits. After the weekend the mid jumps (three 15-minute
// moves' worth).
export const writeSynthetic = async (dir: string, pair: string, pi: number, spec: SynthSpec, fromMs: number, toMs: number) => {
  const symbol = GMO_SYMBOLS[pair];
  const p = SYN[pair];
  const unit = unitOf(pair);
  const dg = digitsOf(pair);
  const rnd = rng(spec.seed * 1009 + pi * 7919 + 17);
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = rnd();
    const v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const mu = spec.trend * (pi % 2 === 0 ? 1 : -1);
  let x = spec.startPips ?? p.start;
  let shut = false;
  type Row = { openTime: string; open: string; high: string; low: string; close: string };
  const files = new Map<string, { bid: Row[]; ask: Row[] }>();
  const q15 = new Map<string, Map<number, { bid: number[]; ask: number[] }>>();
  const half = p.spread / 2;
  for (let t = Math.floor(fromMs / MINUTE) * MINUTE; t + MINUTE <= toMs; t += MINUTE) {
    if (!synthOpen(t)) {
      shut = true;
      continue;
    }
    if (shut) {
      x += 3 * p.sigma * Math.sqrt(15) * gauss();
      shut = false;
    }
    const o = x;
    let h = x;
    let l = x;
    for (let s = 0; s < 4; s++) {
      x += mu / 4 + (p.sigma / 2) * gauss();
      if (x > h) h = x;
      if (x < l) l = x;
    }
    if (l - half <= 0) throw new Error(`${pair} seed ${spec.seed}: the walk reached 0`);
    const side = (sgn: number) => {
      const r = (v: number) => Number(((v + sgn * half) * unit).toFixed(dg));
      const [ro, rc] = [r(o), r(x)];
      return { o: ro, h: Math.max(r(h), ro, rc), l: Math.min(r(l), ro, rc), c: rc };
    };
    const b = side(-1);
    const a = side(1);
    const key = gmoDayKey(t);
    let f = files.get(key);
    if (!f) files.set(key, (f = { bid: [], ask: [] }));
    const row = (s: { o: number; h: number; l: number; c: number }): Row => ({ openTime: String(t), open: fixed(s.o, dg), high: fixed(s.h, dg), low: fixed(s.l, dg), close: fixed(s.c, dg) });
    f.bid.push(row(b));
    f.ask.push(row(a));
    // the 15-minute bar it is in, kept under the day key of the bar's open
    const t15 = Math.floor(t / STEP15) * STEP15;
    const k15 = gmoDayKey(t15);
    let m15 = q15.get(k15);
    if (!m15) q15.set(k15, (m15 = new Map()));
    const g = m15.get(t15);
    if (!g) m15.set(t15, { bid: [b.o, b.h, b.l, b.c], ask: [a.o, a.h, a.l, a.c] });
    else {
      for (const [arr, s] of [[g.bid, b], [g.ask, a]] as const) {
        arr[1] = Math.max(arr[1], s.h);
        arr[2] = Math.min(arr[2], s.l);
        arr[3] = s.c;
      }
    }
  }
  // every day key a read of the window asks for, a day without bars an empty list (as GMO answers a weekend)
  for (const key of keysOf(fromMs, toMs).keys) {
    const f = files.get(key) ?? { bid: [], ask: [] };
    for (const side of ["bid", "ask"] as const) {
      const path = `${dir}/${symbol}/1min/${side}/${key}.json`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, JSON.stringify({ status: 0, data: f[side] }));
    }
    const m15 = q15.get(key) ?? new Map<number, { bid: number[]; ask: number[] }>();
    for (const side of ["bid", "ask"] as const) {
      const data = [...m15.entries()].sort((u, v) => u[0] - v[0]).map(([t15, g]) => {
        const s = g[side];
        return { openTime: String(t15), open: fixed(s[0], dg), high: fixed(s[1], dg), low: fixed(s[2], dg), close: fixed(s[3], dg) };
      });
      const path = `${dir}/${symbol}/15min/${side}/${key}.json`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, JSON.stringify({ status: 0, data }));
    }
  }
};

// ---- the signals --------------------------------------------------------------------------

export type Side = "BUY" | "SELL";
export interface Sig {
  pair: string;
  pi: number;
  side: Side;
  dir: 1 | -1;
  // the 15-minute bar's open and close (T), ms
  open: number;
  T: number;
  // the email's entry (the bar's mid close as the chart rounds it) and its TP2 (E ± 10 pips)
  E: number;
  tp: number;
  // first seen in the next bar's window: its email goes when that bar is read (base T + 15 min)
  late: boolean;
  base: number;
}

export interface Probe {
  compared: number;
  mismatched: number;
  examples: string[];
}

export interface SignalRead {
  pair: string;
  bars: number;
  first: string | null;
  last: string | null;
  // bars closed in [START, END) judged, and those whose window the data did not hold
  judged: number;
  noWindow: number;
  signals: Sig[];
  // found but not mailed: closed while the market may be shut (isPossiblyClosed), on time and late
  unmailed: number;
  lateUnmailed: number;
  // in the next bar's window too (a duplicate, mailed once) and in it only (late)
  late: number;
  // the check against the emails' own function (indicatorSignals): sampled bars and every 7th signal; every late one
  check: Probe;
  checkLate: Probe;
}

const isoOf = (ms: number) => new Date(ms).toISOString();

// The ULTRA signals the sweep mails from GMO's 15-minute bars: each closed bar
// judged with it the newest of the 600 the sweep reads, from anchoredStart
// (tf-winrate.ts, the same steps); a bar's signal found only in the next bar's
// window (where the anchor moved) is mailed when that bar is read, if still
// inside the 20 minutes indicatorSignals keeps a signal fresh.
export const signalsOf = (pair: string, pi: number, quotes: QuoteCandle[], startMs: number, endMs: number): SignalRead => {
  const unit = unitOf(pair);
  const candles = historyRead(pair, "15min", quotes, endMs).candles;
  const n = candles.length;
  const times = new Float64Array(n);
  candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
  const windowStart = (i: number): number | null => (i >= WINDOW - 1 ? i - WINDOW + 1 : null);
  const anchorOf = (i: number): { ws: number; s: number } | null => {
    const ws = windowStart(i);
    if (ws === null || i - ws + 1 <= QT_DEFAULTS.period) return null;
    const w = times.subarray(ws, i + 1) as unknown as number[];
    const last = i - ws;
    const firstShown = Math.max(0, last - (CHART_BARS - 1));
    return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
  };
  const inPeriod = (i: number) => times[i] + STEP15 >= startMs && times[i] + STEP15 < endMs;
  // on-time: bar i in its own window, one run of ultra() for every bar an anchor serves
  const own = new Map<number, Side>();
  let seg: { s: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!seg) return;
    const bars = candles.slice(seg.s, seg.to + 1);
    for (const tr of ultra(bars, bars.length - 1, unit).trades) {
      const at = seg.s + tr.i;
      if (at >= seg.from && at <= seg.to) own.set(at, tr.side);
    }
    seg = null;
  };
  let judged = 0;
  let noWindow = 0;
  const sample: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!inPeriod(i)) continue;
    const a = anchorOf(i);
    if (!a) {
      noWindow++;
      flush();
      continue;
    }
    judged++;
    if (i % CHECK_EVERY === 0) sample.push(i);
    if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
    else {
      flush();
      seg = { s: a.s, from: i, to: i };
    }
  }
  flush();
  // late: bar i's signal in window i+1 where that window's anchor differs
  const nextSide = new Map<number, Side | null>();
  for (let i = 0; i + 1 < n; i++) {
    if (!inPeriod(i)) continue;
    const a1 = anchorOf(i + 1);
    if (!a1 || a1.s > i) continue;
    const a0 = anchorOf(i);
    if (a0 && a0.s === a1.s) continue;
    const bars = candles.slice(a1.s, i + 1);
    const hit = ultra(bars, bars.length - 1, unit).trades.find((tr) => tr.i === i - a1.s);
    nextSide.set(i, hit ? hit.side : null);
  }
  const mailedAt = (readBase: number, T: number) => READ_AFTER.some((m) => {
    const at = readBase + m * MINUTE;
    return at - T >= 0 && at - T <= FRESH && !isPossiblyClosed(at);
  });
  const signals: Sig[] = [];
  let unmailed = 0;
  let lateUnmailed = 0;
  let late = 0;
  const mk = (i: number, side: Side, base: number | null): Sig => {
    const E = candles[i].close;
    return { pair, pi, side, dir: side === "BUY" ? 1 : -1, open: times[i], T: times[i] + STEP15, E, tp: ultraLevels(side, E, unit, ULTRA_PAIRS).tps[1], late: base !== null, base: base ?? times[i] + STEP15 };
  };
  for (let i = 0; i < n; i++) {
    if (!inPeriod(i)) continue;
    const T = times[i] + STEP15;
    const side = own.get(i);
    if (side) {
      if (mailedAt(T, T)) signals.push(mk(i, side, null));
      else unmailed++;
    }
    const ns = nextSide.get(i);
    if (ns && ns !== side) {
      late++;
      // window i+1 is read at its own close; a gap before bar i+1 leaves the signal stale
      if (i + 1 < n && mailedAt(times[i + 1] + STEP15, T)) signals.push(mk(i, ns, times[i + 1] + STEP15));
      else lateUnmailed++;
    }
  }
  // the check: indicatorSignals itself on bar i's window (ULTRA only), and on window i+1 for the late ones
  const check: Probe = { compared: 0, mismatched: 0, examples: [] };
  const probe = (i: number) => {
    const a = anchorOf(i);
    if (!a) return;
    const theirs = indicatorSignals(pair, "15min", candles.slice(a.ws, i + 1), times[i] + STEP15 + 60_000, 120_000)
      .filter((x) => x.rule === "ultra" && Date.parse(x.barTime) === times[i])
      .map((x) => x.side)
      .join(",");
    const ours = own.get(i) ?? "";
    check.compared++;
    if (theirs !== ours) {
      check.mismatched++;
      if (check.examples.length < 10) check.examples.push(`${pair} ${isoOf(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
    }
  };
  for (const i of sample) probe(i);
  const ownList = [...own.keys()].filter(inPeriod).sort((u, v) => u - v);
  ownList.forEach((i, k) => {
    if (k % 7 === 0) probe(i);
  });
  const checkLate: Probe = { compared: 0, mismatched: 0, examples: [] };
  for (const [i, ns] of nextSide) {
    const a1 = anchorOf(i + 1);
    if (!a1) continue;
    // every anchor move with a signal either way, and every 7th without
    if (!ns && !own.get(i) && i % 7 !== 0) continue;
    // fresh enough to hold bar i whatever the gap before bar i+1: this compares what the window finds, not when
    const now = times[i + 1] + STEP15 + 60_000;
    const theirs = indicatorSignals(pair, "15min", candles.slice(a1.ws, i + 2), now, now - (times[i] + STEP15))
      .filter((x) => x.rule === "ultra" && Date.parse(x.barTime) === times[i])
      .map((x) => x.side)
      .join(",");
    checkLate.compared++;
    if (theirs !== (ns ?? "")) {
      checkLate.mismatched++;
      if (checkLate.examples.length < 10) checkLate.examples.push(`${pair} ${isoOf(times[i])} window+1 mine=${ns ?? "-"} theirs=${theirs || "-"}`);
    }
  }
  return {
    pair,
    bars: n,
    first: n ? isoOf(times[0]) : null,
    last: n ? isoOf(times[n - 1]) : null,
    judged,
    noWindow,
    signals,
    unmailed,
    lateUnmailed,
    late,
    check,
    checkLate,
  };
};

// the time an email's order is sent (P): `delay` minutes after its base (T, or T + 15 for a late one)
export const pOf = (s: Sig, delayMin: number): number => s.base + delayMin * MINUTE;

// Rakuten's daily stop (§8.99): from the NY close τ (20:55 UTC in the US
// summer, 21:55 otherwise; the summer as nyClosesBetween reads it) for 15 minutes
export const MAINT = 15 * MINUTE;
