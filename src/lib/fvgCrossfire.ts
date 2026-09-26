// This file is subject to the terms of the Mozilla Public License 2.0 at
// https://mozilla.org/MPL/2.0/ — it is a TypeScript port of the open-source
// Pine Script "FVG Crossfire | Flux Charts" © fluxchart (TradingView script
// uTeXKnH4, version 2.0), whose code is under that licence.
//
// #121: the owner asked for this indicator ("次は、これをインジケーターに
// 追加して。これはコードも公開されてますね"). The port follows the published
// code rule for rule, at its default settings:
//
//   * A Fair Value Gap: three candles with a gap between the first and the
//     third — the third's low over the first's high (bullish), or its high
//     under the first's low (bearish). Gaps are never drawn on their own.
//   * A waiting gap is filled by closes ("Base FVG mitigation: Close") on a
//     three-bar delay, so the move that makes a new gap cannot erase the old
//     one before the two are compared; a gap filled through is dropped.
//   * A new gap on top of the unfilled part of an older opposite gap makes a
//     crossfire zone: just the overlap, in the new gap's direction, with an
//     "origin funnel" drawn from the older gap into it.
//   * A new gap over a live zone of the other direction flips it: the zone
//     is frozen where the new gap began and continues, opposite, on the
//     overlap only — it narrows with each flip. Its flips are counted in
//     stars (★ once formed, ★★ after one flip; 5 or more as "5 ★").
//   * A retest: a candle touching a live zone (any wick) after one that did
//     not — ▲ under a bullish zone's candle, ▼ over a bearish one's.
//   * A zone is finished when a close goes through its far side (under a
//     bullish zone's bottom, over a bearish zone's top); its whole chain
//     stays on the chart, faded ("Show mitigated zones"), without arrows.
//   * Every gap takes part once: one that made or flipped a zone is spent.
//   * Candles next to a daily or weekly session break are not used to find
//     gaps (TradingView's forex day starts at 17:00 New York, as GMO's does).
//   * Evaluated on closed candles only; nothing repaints.
//
// Left out: the alerts, and the settings the owner's screenshots do not
// change (combine overlapping zones, borders, the midline). The chart has
// only the candles it shows (the live chart's 120 closed ones), where the
// original looks back 3,000: zones built on older gaps are not there.
//
// Shown on the chart only: no signal, alert or record is judged on it.

export const FVG_DEFAULTS = {
  // bars the base-gap fill is delayed by (snapBars)
  snapBars: 3,
  maxFvgs: 80,
  maxSegments: 120,
  maxRetestMarks: 20,
  // smallest gap kept, % of price (0: every gap)
  minGapPct: 0,
};

type Bar = { datetime: string; high: number; low: number; close: number };

interface Fvg {
  dir: 1 | -1;
  top: number;
  bottom: number;
  // the part not yet filled
  lagTop: number;
  lagBottom: number;
  startBar: number;
}

export interface CrossfireSegment {
  dir: 1 | -1;
  top: number;
  bottom: number;
  // the bar the box starts on (the new gap's middle candle), and the bar it
  // ends on — null while it is live (it runs to the newest candle)
  from: number;
  to: number | null;
  createBar: number;
  chainId: number;
  // how many times the chain has formed or flipped (the stars)
  flips: number;
  active: boolean;
  done: boolean;
  touching: boolean;
  // bars with a retest arrow (cleared when the chain is finished)
  retests: number[];
  // the older gap the chain grew from, for the origin funnel
  funnel: { dir: 1 | -1; topBar: number; top: number; bottomBar: number; bottom: number } | null;
}

export interface CrossfireRead {
  segments: CrossfireSegment[];
  // the newest closed bar the engine read
  lastClosed: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// New York's offset from UTC at a moment: −4h from the second Sunday of
// March 02:00 to the first Sunday of November 02:00, −5h otherwise
const nyOffset = (ms: number): number => {
  const y = new Date(ms).getUTCFullYear();
  const nthSunday = (month: number, nth: number) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + 7 * (nth - 1);
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6);
  return ms >= start && ms < end ? -4 * HOUR : -5 * HOUR;
};

// The forex trading day a candle opening at `ms` belongs to: days since
// 1970-01-01 of New York's date seven hours on (17:00 New York is midnight)
export const tradingDay = (ms: number): number => Math.floor((ms + nyOffset(ms) + 7 * HOUR) / DAY);
// Monday-based week of a trading day (1970-01-01 was a Thursday)
const weekOf = (day: number): number => Math.floor((day + 3) / 7);

const openMs = (datetime: string): number => {
  const s = datetime.includes("T") ? datetime : datetime.length <= 10 ? `${datetime}T00:00:00` : datetime.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
};

export const fvgCrossfire = (
  bars: ReadonlyArray<Bar>,
  lastClosed: number = bars.length - 1,
  opts: Partial<typeof FVG_DEFAULTS> = {},
): CrossfireRead => {
  const o = { ...FVG_DEFAULTS, ...opts };
  const n = Math.min(bars.length, lastClosed + 1);
  const times = bars.map((b) => openMs(b.datetime));
  // intraday unless the candles are a day or more apart
  const steps: number[] = [];
  for (let i = 1; i < Math.min(bars.length, 50); i++) if (Number.isFinite(times[i] - times[i - 1])) steps.push(times[i] - times[i - 1]);
  steps.sort((a, b) => a - b);
  const intraday = steps.length === 0 || steps[Math.floor(steps.length / 2)] < 20 * HOUR;
  const day = times.map((t) => (Number.isFinite(t) ? (intraday ? tradingDay(t) : Math.floor(t / DAY)) : Number.NaN));
  const dayChange = (i: number) => i > 0 && day[i] !== day[i - 1];
  const weekChange = (i: number) => i > 0 && weekOf(day[i]) !== weekOf(day[i - 1]);

  let fvgs: Fvg[] = [];
  let segs: CrossfireSegment[] = [];
  let chainSeq = 0;

  const newSegment = (dir: 1 | -1, t: number, bot: number, cid: number, flips: number, handoff: number, bar: number): CrossfireSegment => {
    const s: CrossfireSegment = {
      dir, top: t, bottom: bot, from: handoff, to: null, createBar: bar, chainId: cid, flips,
      active: true, done: false, touching: false, retests: [], funnel: null,
    };
    segs.push(s);
    return s;
  };

  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const blockGap = (intraday && (dayChange(i) || dayChange(i - 1))) || weekChange(i) || weekChange(i - 1);

    // the delayed fill of the waiting gaps; a gap filled through drops out
    for (let k = fvgs.length - 1; k >= 0; k--) {
      const f = fvgs[k];
      if (f.startBar < i - o.snapBars) {
        const past = bars[i - o.snapBars];
        if (f.dir === 1) {
          if (past.close < f.lagTop) f.lagTop = Math.max(past.close, f.lagBottom);
        } else if (past.close > f.lagBottom) {
          f.lagBottom = Math.min(past.close, f.lagTop);
        }
      }
      if (f.lagTop <= f.lagBottom) fvgs.splice(k, 1);
    }

    // a new gap on this candle
    let fresh: Fvg | null = null;
    if (!blockGap && i >= 2) {
      const two = bars[i - 2];
      if (bar.low > two.high) {
        const t = bar.low;
        const b = two.high;
        if (((t - b) / bar.close) * 100 >= o.minGapPct) fresh = { dir: 1, top: t, bottom: b, lagTop: t, lagBottom: b, startBar: i };
      } else if (bar.high < two.low) {
        const t = two.low;
        const b = bar.high;
        if (((t - b) / bar.close) * 100 >= o.minGapPct) fresh = { dir: -1, top: t, bottom: b, lagTop: t, lagBottom: b, startBar: i };
      }
    }

    if (fresh) {
      let consumed = false;
      const handoff = fresh.startBar - 1;
      // it first flips any opposite live zone it overlaps...
      const nSeg = segs.length;
      for (let k = 0; k < nSeg; k++) {
        const z = segs[k];
        if (!z.active || z.done || z.dir !== -fresh.dir) continue;
        const t = Math.min(fresh.top, z.top);
        const bot = Math.max(fresh.bottom, z.bottom);
        if (bot < t) {
          z.to = handoff;
          z.active = false;
          newSegment(fresh.dir, t, bot, z.chainId, z.flips + 1, handoff, i);
          consumed = true;
        }
      }
      // ...then strikes the opposite waiting gaps; a struck gap is spent
      for (let k = fvgs.length - 1; k >= 0; k--) {
        const a = fvgs[k];
        if (a.dir !== -fresh.dir) continue;
        const t = Math.min(a.lagTop, fresh.top);
        const bot = Math.max(a.lagBottom, fresh.bottom);
        if (bot < t) {
          const s = newSegment(fresh.dir, t, bot, chainSeq, 1, handoff, i);
          s.funnel = {
            dir: a.dir,
            topBar: a.dir === 1 ? a.startBar : a.startBar - 2,
            top: a.top,
            bottomBar: a.dir === 1 ? a.startBar - 2 : a.startBar,
            bottom: a.bottom,
          };
          chainSeq += 1;
          consumed = true;
          fvgs.splice(k, 1);
        }
      }
      // one that made or flipped nothing waits as a base gap
      if (!consumed) fvgs.push(fresh);
    }

    // retests and the end of live zones (by close through the far side)
    for (const s of segs) {
      if (!s.active || s.done || s.createBar >= i) continue;
      const touch = bar.high >= s.bottom && bar.low <= s.top;
      if (touch && !s.touching) {
        s.retests.push(i);
        if (s.retests.length > o.maxRetestMarks) s.retests.shift();
      }
      s.touching = touch;
      const through = s.dir === 1 ? bar.close <= s.bottom : bar.close >= s.top;
      if (through) {
        for (const c of segs) {
          if (c.chainId !== s.chainId || c.done) continue;
          c.done = true;
          c.retests = [];
          if (c.active) c.to = i;
          c.active = false;
        }
      }
    }

    if (fvgs.length > o.maxFvgs) fvgs = fvgs.slice(fvgs.length - o.maxFvgs);
    if (segs.length > o.maxSegments) segs = segs.slice(segs.length - o.maxSegments);
  }
  return { segments: segs, lastClosed: n - 1 };
};

// The star counter: ★ per formation up to four, then a count
export const starText = (flips: number): string => (flips <= 4 ? "★".repeat(flips) : `${flips} ★`);
