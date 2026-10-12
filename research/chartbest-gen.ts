// #318 (docs §8.113 20 (e)): the made-up price paths. One minute at a time from S0 to END, on whole ticks
// (0.001 on the yen pairs, 0.00001 on the dollar pairs):
//
//   * a latent mid x (a double, in ticks) from START_MID takes one normal step a minute: σ = 10 ticks (yen)
//     or 6 (dollar) × the UTC hour's factor (00–06 0.8, 07–15 1.2, 16–20 1.0, 21–23 0.6), × 0.6 instead
//     while GMO's week is shut; plus the set's drift. The written mid is x rounded half up (SQ-09).
//   * a minute bar exists only inside GMO's week (money-data gmoWeekShut): O the previous written mid, C this
//     one, H/L their max/min (SQ-09). So Monday's first bar opens with a gap.
//   * the spread of each 15-minute slot: spread-hours.csv's median for the pair, the season (New York's) and
//     the slot, its p90 in a tenth of the slots (one uniform draw a slot, in time); rounded half up to ticks;
//     Bid = mid − floor(s ÷ 2), Ask = Bid + s.
//   * the 5-minute bars aggregate the minutes (both sides).
//   * the sets: D a drift a·σ every minute; H EUR/USD only, −a·σ in New York's 03:00–08:59 and +a·σ in
//     11:00–14:59; E/E3 the generator's own donchian-20 on its 5-minute chart mids, a push of a·σ a minute in
//     the signal's direction for the 120 minutes after its close (pushes add); Q a bounce of
//     round-half-up(a·z) ticks on the last minute's close of each 5-minute bar (both sides; its high and low
//     widened), the next minute opening at the unbounced value. O is N's path (seeds 801–804).
//   * the flip: about c = START_MID, Bid′ = 2c − Ask (high ↔ low), Ask′ = 2c − Bid; bars and minutes.
//
// Random numbers: mulberry32 (research/gmo.ts), u = (x + 0.5) ÷ 2^32; normals by Box–Muller, cos first then
// sin (§8.113 置8); separate streams per pair for the walk, the spread draws and Q's bounces (SQ-30).
// The files are written as GMO's day files (GMO_SYMBOLS, day keys gmoDayKey; every key the reader opens,
// an empty day as {"status":0,"data":[]}).

import { GMO_SYMBOLS } from "../supabase/functions/track-outcomes/quotes.ts";
import { keysOf } from "./ownerhold-data.ts";
import { MINUTE } from "./lib.ts";
import { type Pair, PAIRS, P90_SHARE, type Period, SHUT_FACTOR, SIGMA_TICKS, START_MID_TICKS, STEP, hourFactor } from "./chartbest-const.ts";
import { gmoDayKey, gmoWeekShut, nyLocal } from "./chartbest-time.ts";
import { seasonOf as spreadSeason, slotOf } from "./spreadhours-lib.ts";
import { chartRound, digitsOf, isJpy } from "./chartbest-bars.ts";

// ---- random numbers ------------------------------------------------------------------------------------

export const mulberry = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
};
export const uniformOf = (next: () => number) => () => (next() + 0.5) / 4294967296;
export const normalsOf = (next: () => number) => {
  const u = uniformOf(next);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = u();
    const u2 = u();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
};
export const streamSeed = (seed: number, pi: number, k: 0 | 101 | 211): number => seed * 1009 + pi * 7919 + 17 + k;
// round half up on a double (ticks)
export const halfUp = (x: number): number => Math.floor(x + 0.5);

// ---- the spread table ------------------------------------------------------------------------------------

export interface SpreadCell {
  med: number;
  p90: number;
}
// tenths of a pip written with up to two decimals ("0.35"), as whole ticks rounded half up (exact on the text)
const ticksOfPips = (text: string): number => {
  const m = /^(\d+)\.(\d{1,2})$/.exec(text.trim());
  if (!m) throw new Error(`spread-hours.csv: ${JSON.stringify(text)} is not pips with one or two decimals`);
  const hundredths = Number(m[1]) * 100 + Number(m[2].padEnd(2, "0"));
  return Math.floor((hundredths + 5) / 10);
};
export const parseSpreadTable = (text: string): Map<string, SpreadCell> => {
  const lines = text.split("\n").filter((l) => l !== "");
  const head = lines[0].split(",");
  const col = (name: string) => {
    const k = head.indexOf(name);
    if (k < 0) throw new Error(`spread-hours.csv: no ${name} column`);
    return k;
  };
  const [cp, cs, cl, cm, c9] = [col("pair"), col("season"), col("slot"), col("median"), col("p90")];
  const out = new Map<string, SpreadCell>();
  for (const l of lines.slice(1)) {
    const c = l.split(",");
    if (!(PAIRS as readonly string[]).includes(c[cp])) continue;
    if (c[cm] === "" || c[c9] === "") continue;
    out.set(`${c[cp]}|${c[cs]}|${c[cl]}`, { med: ticksOfPips(c[cm]), p90: ticksOfPips(c[c9]) });
  }
  return out;
};

// ---- the sets ----------------------------------------------------------------------------------------------

export type GenSet = "N" | "D" | "H" | "E" | "E3" | "Q" | "O";
export interface GenSpec {
  set: GenSet;
  seed: number;
  // the set's amount a (D, H, E, E3, Q); ignored for N and O
  amount: number;
  flip: boolean;
  period: Period;
  // keep the 1-minute bars (full runs); a light run makes them in memory and drops them
  minutes: boolean;
}

// One pair's bars in ticks: open times, and the bid's and the ask's OHLC
export interface TickBars {
  n: number;
  t: Float64Array;
  bo: Int32Array;
  bh: Int32Array;
  bl: Int32Array;
  bc: Int32Array;
  ao: Int32Array;
  ah: Int32Array;
  al: Int32Array;
  ac: Int32Array;
}
const newTick = (cap: number): TickBars => ({
  n: 0, t: new Float64Array(cap), bo: new Int32Array(cap), bh: new Int32Array(cap), bl: new Int32Array(cap), bc: new Int32Array(cap),
  ao: new Int32Array(cap), ah: new Int32Array(cap), al: new Int32Array(cap), ac: new Int32Array(cap),
});
const cutTick = (b: TickBars): TickBars => ({
  n: b.n, t: b.t.slice(0, b.n), bo: b.bo.slice(0, b.n), bh: b.bh.slice(0, b.n), bl: b.bl.slice(0, b.n), bc: b.bc.slice(0, b.n),
  ao: b.ao.slice(0, b.n), ah: b.ah.slice(0, b.n), al: b.al.slice(0, b.n), ac: b.ac.slice(0, b.n),
});

export interface GenPair {
  pair: Pair;
  pi: number;
  five: TickBars;
  minutes: TickBars | null;
  // what the generator did: E's pushes, Q's bounces, the p90 slots
  diag: Record<string, number>;
}

// E/E3: the generator's own donchian-20, written apart from the item (a short recursive form): on each closed
// 5-minute bar, the previous 20 bars' highest high and lowest low of the chart's mids; a close above the high
// sets +1, below the low −1; a change is a signal
class Donchian20 {
  private hs: number[] = [];
  private ls: number[] = [];
  private s = 0;
  // the signal's direction at this bar (0: none)
  step(h: number, l: number, c: number): number {
    let sig = 0;
    if (this.hs.length === 20) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let k = 0; k < 20; k++) {
        if (this.hs[k] > hh) hh = this.hs[k];
        if (this.ls[k] < ll) ll = this.ls[k];
      }
      if (c > hh && this.s !== 1) {
        this.s = 1;
        sig = 1;
      } else if (c < ll && this.s !== -1) {
        this.s = -1;
        sig = -1;
      }
      this.hs.shift();
      this.ls.shift();
    }
    this.hs.push(h);
    this.ls.push(l);
    return sig;
  }
}

const priceOf = (v: number, d: number): number => v / 10 ** d;

export const generatePair = (pair: Pair, pi: number, spec: GenSpec, spreads: Map<string, SpreadCell>): GenPair => {
  const p = spec.period;
  const d = digitsOf(pair);
  const sb = isJpy(pair) ? SIGMA_TICKS.jpy : SIGMA_TICKS.usd;
  const walk = normalsOf(mulberry(streamSeed(spec.seed, pi, 0)));
  const sp = uniformOf(mulberry(streamSeed(spec.seed, pi, 101)));
  const bounce = normalsOf(mulberry(streamSeed(spec.seed, pi, 211)));
  const a = spec.amount;
  const from = Math.floor(p.s0 / MINUTE) * MINUTE;
  const cap = Math.ceil((p.end - from) / MINUTE) + 1;
  const mins = spec.minutes ? newTick(cap) : null;
  const five = newTick(Math.ceil(cap / 5) + 1);
  const diag: Record<string, number> = { minutes: 0, fiveBars: 0, p90Slots: 0, slots: 0, pushes: 0, bounces: 0 };
  const dc = spec.set === "E" || spec.set === "E3" ? new Donchian20() : null;
  // E's pushes: [until, direction]
  const pushes: Array<[number, number]> = [];
  let x = START_MID_TICKS[pair];
  let prevW = START_MID_TICKS[pair];
  let p90 = false;
  // the 5-minute bar being built
  let cur = -1;
  let fo = 0, fh = 0, fl = 0, fcb = 0, fca = 0, fhb = 0, flb = 0, fha = 0, fla = 0, fob = 0, foa = 0;
  for (let t = from; t + MINUTE <= p.end; t += MINUTE) {
    if (t % (15 * MINUTE) === 0) {
      p90 = sp() < P90_SHARE;
      diag.slots++;
      if (p90) diag.p90Slots++;
    }
    const shut = gmoWeekShut(t);
    const sigma = sb * (shut ? SHUT_FACTOR : hourFactor(new Date(t).getUTCHours()));
    let drift = 0;
    if (spec.set === "D") drift += a * sb;
    if (spec.set === "H" && pair === "EUR/USD") {
      const h = nyLocal(t).hour;
      if (h >= 3 && h <= 8) drift -= a * sb;
      else if (h >= 11 && h <= 14) drift += a * sb;
    }
    if (dc) {
      while (pushes.length && pushes[0][0] <= t) pushes.shift();
      for (const [, dir] of pushes) drift += dir * a * sb;
    }
    x += drift + sigma * walk();
    const w = halfUp(x);
    if (!shut) {
      const cell = spreads.get(`${pair}|${spreadSeason(t)}|${slotOf(t)}`);
      if (!cell) throw new Error(`spread-hours.csv: no row for ${pair} ${spreadSeason(t)} slot ${slotOf(t)}`);
      const s = p90 ? cell.p90 : cell.med;
      const half = Math.floor(s / 2);
      const O = prevW;
      let C = w;
      let H = Math.max(O, C);
      let L = Math.min(O, C);
      const lastOfFive = t % STEP === STEP - MINUTE;
      if (spec.set === "Q" && lastOfFive) {
        const b = halfUp(a * bounce());
        diag.bounces++;
        C += b;
        H = Math.max(H, C);
        L = Math.min(L, C);
      }
      const bO = O - half, bH = H - half, bL = L - half, bC = C - half;
      if (mins) {
        const k = mins.n++;
        mins.t[k] = t;
        mins.bo[k] = bO;
        mins.bh[k] = bH;
        mins.bl[k] = bL;
        mins.bc[k] = bC;
        mins.ao[k] = bO + s;
        mins.ah[k] = bH + s;
        mins.al[k] = bL + s;
        mins.ac[k] = bC + s;
      }
      diag.minutes++;
      const slot5 = Math.floor(t / STEP) * STEP;
      if (slot5 !== cur) {
        cur = slot5;
        fo = 1;
        fob = bO;
        foa = bO + s;
        fhb = bH;
        flb = bL;
        fha = bH + s;
        fla = bL + s;
      } else {
        fhb = Math.max(fhb, bH);
        flb = Math.min(flb, bL);
        fha = Math.max(fha, bH + s);
        fla = Math.min(fla, bL + s);
      }
      fcb = bC;
      fca = bC + s;
      fh = fhb;
      fl = flb;
      if (lastOfFive && fo === 1) {
        const k = five.n++;
        five.t[k] = cur;
        five.bo[k] = fob;
        five.bh[k] = fhb;
        five.bl[k] = flb;
        five.bc[k] = fcb;
        five.ao[k] = foa;
        five.ah[k] = fha;
        five.al[k] = fla;
        five.ac[k] = fca;
        diag.fiveBars++;
        fo = 0;
        if (dc) {
          // the chart's mids, as the reader will make them from the written prices
          const mh = chartRound((priceOf(fh, d) + priceOf(fha, d)) / 2, d);
          const ml = chartRound((priceOf(fl, d) + priceOf(fla, d)) / 2, d);
          const mc = chartRound((priceOf(fcb, d) + priceOf(fca, d)) / 2, d);
          const sig = dc.step(mh, ml, mc);
          if (sig !== 0) {
            pushes.push([cur + STEP + 120 * MINUTE, sig]);
            diag.pushes++;
          }
        }
      }
    }
    prevW = w;
  }
  let fiveOut = cutTick(five);
  let minOut = mins ? cutTick(mins) : null;
  if (spec.flip) {
    fiveOut = flipTicks(fiveOut, START_MID_TICKS[pair]);
    if (minOut) minOut = flipTicks(minOut, START_MID_TICKS[pair]);
  }
  return { pair, pi, five: fiveOut, minutes: minOut, diag };
};

// the flip about c: Bid′ = 2c − Ask (O, C; H′ = 2c − L, L′ = 2c − H), Ask′ = 2c − Bid
export const flipTicks = (b: TickBars, c: number): TickBars => {
  const o = newTick(b.n);
  o.n = b.n;
  for (let k = 0; k < b.n; k++) {
    o.t[k] = b.t[k];
    o.bo[k] = 2 * c - b.ao[k];
    o.bc[k] = 2 * c - b.ac[k];
    o.bh[k] = 2 * c - b.al[k];
    o.bl[k] = 2 * c - b.ah[k];
    o.ao[k] = 2 * c - b.bo[k];
    o.ac[k] = 2 * c - b.bc[k];
    o.ah[k] = 2 * c - b.bl[k];
    o.al[k] = 2 * c - b.bh[k];
  }
  return o;
};

// ---- the files ----------------------------------------------------------------------------------------------

// a tick count as GMO writes a price (d decimals), exactly
export const tickText = (v: number, d: number): string => {
  const neg = v < 0;
  const a = Math.abs(v);
  const s = String(a).padStart(d + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`;
};

export const writeTickFiles = async (dir: string, pair: Pair, interval: "5min" | "1min", b: TickBars, period: Period): Promise<number> => {
  const symbol = GMO_SYMBOLS[pair];
  const d = digitsOf(pair);
  const byKey = new Map<string, { bid: string[]; ask: string[] }>();
  for (let k = 0; k < b.n; k++) {
    const key = gmoDayKey(b.t[k]);
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { bid: [], ask: [] }));
    const ot = String(b.t[k]);
    e.bid.push(`{"openTime":"${ot}","open":"${tickText(b.bo[k], d)}","high":"${tickText(b.bh[k], d)}","low":"${tickText(b.bl[k], d)}","close":"${tickText(b.bc[k], d)}"}`);
    e.ask.push(`{"openTime":"${ot}","open":"${tickText(b.ao[k], d)}","high":"${tickText(b.ah[k], d)}","low":"${tickText(b.al[k], d)}","close":"${tickText(b.ac[k], d)}"}`);
  }
  let files = 0;
  for (const side of ["bid", "ask"] as const) await Deno.mkdir(`${dir}/${symbol}/${interval}/${side}`, { recursive: true });
  for (const key of keysOf(period.s0, period.end).keys) {
    const e = byKey.get(key) ?? { bid: [], ask: [] };
    for (const side of ["bid", "ask"] as const) {
      await Deno.writeTextFile(`${dir}/${symbol}/${interval}/${side}/${key}.json`, `{"status":0,"data":[${e[side].join(",")}]}`);
      files++;
    }
  }
  return files;
};

// 20 (e): the made-up bars' times are GMO's week (no bar opening Friday from 20:00 UTC in the US summer or
// 21:00 in winter, Saturday, or Sunday before 22:00): the bars that break it
export const gmoWeekBreaks = (b: TickBars, step: number): number => {
  let bad = 0;
  for (let k = 0; k < b.n; k++) {
    // every minute of the bar must be inside GMO's week
    for (let m = 0; m < step; m += MINUTE) {
      if (gmoWeekShut(b.t[k] + m)) {
        bad++;
        break;
      }
    }
  }
  return bad;
};
// 20 (a), made-up: every bid and ask OHLC within 0.25–2.5 × the first mid
export const bandBreaks = (b: TickBars, pair: Pair): number => {
  const c = START_MID_TICKS[pair];
  const lo = 0.25 * c;
  const hi = 2.5 * c;
  let bad = 0;
  for (let k = 0; k < b.n; k++) {
    const vs = [b.bo[k], b.bh[k], b.bl[k], b.bc[k], b.ao[k], b.ah[k], b.al[k], b.ac[k]];
    if (vs.some((v) => !(v >= lo && v <= hi))) bad++;
  }
  return bad;
};
