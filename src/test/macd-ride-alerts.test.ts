// #397 (docs §8.150; research/macdride-spec.md): the MACD email as a ride, in the function.
//
// Two parts. The first holds what indicators.ts adds for it (the three rule ids, each mail's
// row and text, the prices, the forming hour as the minute's check reads it) to the spec.
// The second runs the REAL supabase/functions/signal-alerts/index.ts — imported here with
// `Deno` stubbed and every outside call faked (Supabase's REST with the tables the run uses,
// the auth lookup, GMO's klines, Resend; the clock and the sleeps too, so nothing waits and
// nothing reaches the network) — and replays runs over the same fake tables, each import of
// the module one fresh instance: section 7's "once only, whatever is repeated". The rule
// itself (rideEntryAt, rideCloseStep, rideTouch, rideCatchUp) is checked in
// src/test/macd-ride.test.ts; here it is what the function does with it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  MACDH_AT_RULE_ID,
  MACDH_OUT_RULE_ID,
  MACDH_PAIRS,
  MACDH_RIDE_VERSION,
  MACDH_RULE_ID,
  MACD_RIDE_COLUMNS,
  RIDE_MEASURED,
  RIDE_OUT_FRESH_MS,
  goldHourExtremes,
  indicatorRuleId,
  macdRideOf,
  renderIndicatorMail,
  rideCloseSignal,
  rideFormingOf,
  rideHeldText,
  rideLeaveAt,
  rideOutSignal,
  ridePaidAt,
  ridePnl,
  rideRowOf,
  rideRuleIdOf,
  rideSignalTag,
  signalRow,
  signalRuleId,
  spikeSignals,
  type IndicatorSignal,
  type MacdRide,
} from "../../supabase/functions/signal-alerts/indicators";
import {
  RIDE_IN_SHARE,
  RIDE_OUT_SHARE,
  rideCatchUp,
  rideEntryAt,
  rideRuleId,
  rideStateOf,
  rideTouch,
  shareOf,
  type RideBar,
  type RideEntry,
  type RideZoneSide,
} from "../../supabase/functions/_shared/macd-ride";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";

const H = 3_600_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const dt = (ms: number) => iso(ms).slice(0, 19).replace("T", " ");
// a timestamptz as PostgREST writes it
const pg = (ms: number) => iso(ms).replace(".000Z", "+00:00");

// ---- the bars: 2,200 hourly bars of a yen pair over the hours the market is open (winter: shut Friday 22:00 to Sunday
// 22:00 UTC), a slow wave, quicker ones and a drift, rounded as the chart draws a yen pair. A bar opens at the close
// before it and has no wick unless a test gives it one. Under the ride's rule they hold 25 entry bars, 13 of them a
// notice (already at 96%), found below with the shared code
const shut = (t: number) => {
  const d = new Date(t);
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day === 6 || (day === 5 && h >= 22) || (day === 0 && h < 22);
};
const N = 2200;
const times: number[] = [];
for (let t = Date.UTC(2026, 6, 1); times.length < N; t += H) if (!shut(t)) times.push(t);
const indexOfTime = new Map(times.map((t, i) => [t, i]));
const wave = (i: number) => 0.9 * Math.sin(i / 90) + 0.35 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7) + 0.03 * Math.sin(i * 1.9) + 0.0004 * i;
const closes = Array.from({ length: N }, (_, i) => Number((150 + wave(i)).toFixed(3)));
const openOf = (k: number) => (k > 0 ? closes[k - 1] : closes[k]);
const plainBar = (k: number): RideBar => ({ t: times[k], high: Math.max(openOf(k), closes[k]), low: Math.min(openOf(k), closes[k]), close: closes[k] });
const entryAt = (i: number): RideEntry | null => rideEntryAt(closes.slice(i - 599, i + 1));
// the state of bar j (from the 599 closes before it), and the first price, a thousandth at a time from the bar's
// open toward the side, at which the line with it as the bar's price touches 96% there
const stateOf = (j: number) => rideStateOf(closes.slice(j - 599, j))!;
const touchPrice = (j: number, zside: RideZoneSide): number => {
  const st = stateOf(j);
  for (let n = 0; n <= 5000; n++) {
    const x = Number((openOf(j) + (zside === "top" ? n : -n) * 0.001).toFixed(3));
    if (rideTouch(st, zside, x, x) !== null) return x;
  }
  throw new Error(`no touch within 5 yen at bar ${j}`);
};
const bid = (mid: number) => Number((mid - 0.005).toFixed(3));
const ask = (mid: number) => Number((mid + 0.005).toFixed(3));

// the bars the scenarios stand on (each checked where it is used)
const I_BUY = 1761; // an entry (BUY, not already) whose next bar, flat at its open, does not touch 96%
const I_SELL = 1229; // the same, a SELL
const I_HELD = 2100; // a SELL entry with no touch of the bottom's 96% in the 100 bars before it
const I_AT_ONCE = 951; // a SELL entry whose next bar touches 96% at its very open
const I_NOTICE = 1822; // an entry bar already at 96% (a SELL's side)
const I_QUIET = 809; // another

describe("#397 the series the scenarios stand on (found with the shared code)", () => {
  it("holds entries on both sides, notices, an entry reached at the next bar's open and ones that are not", () => {
    const found: string[] = [];
    for (let i = 620; i < N - 3; i++) {
      const e = entryAt(i);
      if (e) found.push(`${i}:${e.side}${e.already ? ":at" : ""}`);
    }
    expect(found).toHaveLength(25);
    expect(found.filter((x) => x.endsWith(":at"))).toHaveLength(13);
    for (const [i, side, already] of [[I_BUY, "BUY", false], [I_SELL, "SELL", false], [I_HELD, "SELL", false], [I_AT_ONCE, "SELL", false], [I_NOTICE, "SELL", true], [I_QUIET, "SELL", true]] as const) {
      expect(entryAt(i), `bar ${i}`).toMatchObject({ side, already });
      // the next two bars follow at once (no weekend between)
      expect(times[i + 1] - times[i]).toBe(H);
      expect(times[i + 2] - times[i + 1]).toBe(H);
    }
    const flat = (i: number) => rideTouch(stateOf(i + 1), entryAt(i)!.zside, closes[i], closes[i]) !== null;
    expect([I_BUY, I_SELL, I_HELD, I_AT_ONCE].map(flat)).toEqual([false, false, false, true]);
    // no touch of the bottom's 96% in the newest 100 bars up to I_HELD: a ride held from long before is still open there
    expect(rideCatchUp(Array.from({ length: I_HELD + 1 }, (_, k) => plainBar(k)), "bottom", times[I_HELD - 150])).toBeNull();
  });
});

// ---- part 1: what indicators.ts adds -------------------------------------------------------------------------------

const entryOf = (i: number) => entryAt(i)!;
const barOf = (i: number, paid: number) => ({ openMs: times[i], closeMs: times[i] + H, mid: closes[i], paid });
const rideRow = (over: Partial<Record<string, unknown>> = {}) => ({
  pair: "USD/JPY",
  side: "BUY",
  entry_bar: pg(times[I_BUY]),
  entry_closed_at: pg(times[I_BUY] + H),
  entry_price: ask(closes[I_BUY]),
  entry_mid: closes[I_BUY],
  share0: 0.9019,
  status: "open",
  reached_at: null,
  reached_bar: null,
  seen_price: null,
  late: null,
  share1: null,
  ...over,
});

describe("#397 the three rule ids, and the row of each mail (spec section 2)", () => {
  it("are built from the ride's constants, start as the app reads the rule back, and v8's is not among them", () => {
    expect(MACDH_RIDE_VERSION).toBe(9);
    expect(MACDH_RULE_ID).toBe("macdx_12_26_9_w600_1h_ride90to96of120_in_v9");
    expect(MACDH_AT_RULE_ID).toBe("macdx_12_26_9_w600_1h_ride90to96of120_at_v9");
    expect(MACDH_OUT_RULE_ID).toBe("macdx_12_26_9_w600_1h_ride90to96of120_out_v9");
    expect([MACDH_RULE_ID, MACDH_AT_RULE_ID, MACDH_OUT_RULE_ID]).toEqual((["in", "at", "out"] as const).map((m) => rideRuleId("macdx", m, 9)));
    // indicatorRuleId gives email 1's; each mail's row is written under its own
    expect(indicatorRuleId("macdx")).toBe(MACDH_RULE_ID);
    for (const id of [MACDH_RULE_ID, MACDH_AT_RULE_ID, MACDH_OUT_RULE_ID]) {
      expect(id.startsWith("macdx")).toBe(true);
      expect(id).not.toContain("z95of120");
    }
    // the 95% email's id is never produced again: it is in the history comment only
    const src = readFileSync("supabase/functions/signal-alerts/indicators.ts", "utf8");
    expect(src).toContain("macdx_12_26_9_w600_1h_z95of120_v8, is never\n// written again");
    expect(src.split("\n").filter((l) => l.includes("z95of120") && !l.trimStart().startsWith("//"))).toEqual([]);
    expect(src).not.toContain("decideZoneOnWindow(closed");
    expect(src).not.toContain("export const macdhSignals");
  });

  it("signalRuleId: a rule's own id, and a ride's mail under that mail's (the shares' three from their email 1's)", () => {
    const sig = (mail: "in" | "at" | "out") => ({ rule: "macdx" as const, ride: { mail } as IndicatorSignal["ride"] });
    expect(signalRuleId(sig("in"))).toBe(MACDH_RULE_ID);
    expect(signalRuleId(sig("at"))).toBe(MACDH_AT_RULE_ID);
    expect(signalRuleId(sig("out"))).toBe(MACDH_OUT_RULE_ID);
    // no ride: the rule's id, as before
    for (const rule of ["qtrend", "ultra", "macdx", "sweepx", "amdpo3", "emarm", "stockmacd", "spike"] as const) {
      expect(signalRuleId({ rule }), rule).toBe(indicatorRuleId(rule));
    }
    // the shares': email 1's id with "in" made "at" or "out" (so nothing is typed twice); an id that is no ride's stays
    const stockIn = rideRuleId("stockmacd", "in", 2);
    expect(stockIn).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2");
    expect(rideRuleIdOf(stockIn, "in")).toBe(stockIn);
    expect(rideRuleIdOf(stockIn, "at")).toBe(rideRuleId("stockmacd", "at", 2));
    expect(rideRuleIdOf(stockIn, "out")).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_out_v2");
    expect(rideRuleIdOf("stockmacd_12_26_9_w600_1h_z95of120_v1", "out")).toBe("stockmacd_12_26_9_w600_1h_z95of120_v1");
  });

  it("email 1: the entry bar, the trade side, the price paid, no stop, no target, the pane's side and numbers", () => {
    const e = entryOf(I_BUY);
    const s = rideCloseSignal("macdx", "USD/JPY", "1h", "in", e, barOf(I_BUY, ask(closes[I_BUY])));
    expect(s).toMatchObject({ rule: "macdx", pair: "USD/JPY", interval: "1h", side: "BUY", strong: false, sl: null, tps: null, close: closes[I_BUY] });
    expect([s.line, s.eps, s.rsi, s.rsiPrev]).toEqual([null, null, null, null]);
    expect(s.barTime).toBe(iso(times[I_BUY]));
    expect(s.closedAt).toBe(iso(times[I_BUY] + H));
    expect(s.macdh).toBeUndefined();
    expect(s.ride).toEqual({
      mail: "in", zside: "top", m: e.z.m, top: e.z.top, bottom: e.z.bottom,
      entryBar: iso(times[I_BUY]), entryClosedAt: iso(times[I_BUY] + H), entryPrice: ask(closes[I_BUY]),
    });
    // a BUY is on the pane's TOP (the 95% email sold there): the line at 90% of it or more, short of 96%
    expect(e.z.m).toBeGreaterThanOrEqual(RIDE_IN_SHARE * e.z.top);
    expect(e.z.m).toBeLessThan(RIDE_OUT_SHARE * e.z.top);
    expect(signalRow(s)).toEqual({
      bar_time: iso(times[I_BUY]), closed_at: iso(times[I_BUY] + H), side: "BUY", entry: ask(closes[I_BUY]), stop: null, target: null, rule: MACDH_RULE_ID,
    });
    expect(rideSignalTag(s)).toBe("macdx:BUY");
    // a SELL on the bottom
    const sell = rideCloseSignal("macdx", "USD/JPY", "1h", "in", entryOf(I_SELL), barOf(I_SELL, bid(closes[I_SELL])));
    expect(sell.side).toBe("SELL");
    expect(sell.ride!.zside).toBe("bottom");
    expect(signalRow(sell).entry).toBe(bid(closes[I_SELL]));
  });

  it("the notice: the side an entry would have been, the bar's close, under its own id", () => {
    const e = entryOf(I_NOTICE);
    expect(e.already).toBe(true);
    const s = rideCloseSignal("macdx", "USD/JPY", "1h", "at", e, barOf(I_NOTICE, 999));
    expect(s.ride).toMatchObject({ mail: "at", zside: "bottom", entryPrice: closes[I_NOTICE] });
    expect(signalRow(s)).toEqual({
      bar_time: iso(times[I_NOTICE]), closed_at: iso(times[I_NOTICE] + H), side: "SELL", entry: closes[I_NOTICE], stop: null, target: null, rule: MACDH_AT_RULE_ID,
    });
    expect(rideSignalTag(s)).toBe("macdx-at:SELL");
  });

  it("email 2, from the ride's row alone: under the entry bar, closed_at when seen, the entry price and the price when seen", () => {
    const seenAt = times[I_BUY] + H + 4 * MIN + 1_000;
    const row = rideRow({ status: "reached", reached_at: pg(seenAt), reached_bar: pg(times[I_BUY] + H), seen_price: 150.9, late: false, share1: 0.9612 });
    const ride = macdRideOf(row)!;
    expect(ride).toEqual({
      pair: "USD/JPY", side: "BUY", entryBar: times[I_BUY], entryClosedAt: times[I_BUY] + H, entryPrice: ask(closes[I_BUY]), entryMid: closes[I_BUY],
      share0: 0.9019, status: "reached", reachedAt: seenAt, reachedBar: times[I_BUY] + H, seenPrice: 150.9, late: false, share1: 0.9612,
    } satisfies MacdRide);
    expect(rideRowOf(ride)).toEqual({ side: "BUY", entryBar: times[I_BUY], status: "reached", reachedBar: times[I_BUY] + H });
    const s = rideOutSignal("macdx", "1h", ride)!;
    expect(s).toMatchObject({ rule: "macdx", pair: "USD/JPY", interval: "1h", side: "BUY", sl: null, tps: null, close: 150.9 });
    expect(s.ride).toEqual({
      mail: "out", zside: "top", m: null, top: null, bottom: null,
      entryBar: iso(times[I_BUY]), entryClosedAt: iso(times[I_BUY] + H), entryPrice: ask(closes[I_BUY]),
      seenAt: iso(seenAt), reachedBar: iso(times[I_BUY] + H), late: false, seenPrice: 150.9,
    });
    // one out row a ride and follower whatever minute it is seen in, and it cannot meet a new in or at row of that bar
    expect(signalRow(s)).toEqual({
      bar_time: iso(times[I_BUY]), closed_at: iso(seenAt), side: "BUY", entry: ask(closes[I_BUY]), stop: null, target: 150.9, rule: MACDH_OUT_RULE_ID,
    });
    expect(rideSignalTag(s)).toBe("macdx-out:BUY");
    // an open ride has no email 2; nor a row that holds no time or price for the reach
    expect(rideOutSignal("macdx", "1h", macdRideOf(rideRow())!)).toBeNull();
    expect(rideOutSignal("macdx", "1h", macdRideOf(rideRow({ status: "reached", reached_at: pg(seenAt) }))!)).toBeNull();
    // the row is read by its named columns, and what is not a ride's row is none
    expect(MACD_RIDE_COLUMNS.split(",")).toEqual(Object.keys(rideRow()));
    for (const bad of [null, {}, rideRow({ side: "HOLD" }), rideRow({ status: "closed" }), rideRow({ entry_bar: "soon" }), rideRow({ entry_price: "150" }), rideRow({ pair: 7 })]) {
      expect(macdRideOf(bad)).toBeNull();
    }
  });

  it("a rule that is no ride keeps its row as it was (the stop, the first target, its own id)", () => {
    const up = spikeSignals("USD/JPY", "1h", [{ bar: { datetime: dt(times[700]), open: 100, high: 100.4, low: 99.95, close: 100.3 }, forming: true }], new Map([[times[700], { r: 0.125, behind: 0 }]]), times[700] + 60_000)[0];
    expect(signalRow(up)).toEqual({ bar_time: up.barTime, closed_at: up.closedAt, side: "BUY", entry: 100.3, stop: null, target: null, rule: indicatorRuleId("spike") });
    const ultra: IndicatorSignal = { ...up, rule: "ultra", sl: 99.87, tps: [100.34, 100.4, 100.46], spike: undefined };
    expect(signalRow(ultra)).toMatchObject({ entry: 100.3, stop: 99.87, target: 100.34, rule: indicatorRuleId("ultra") });
  });
});

describe("#397 the prices and the forming hour (spec sections 2 and 5)", () => {
  const q = (bidClose: number, askClose: number, over: Partial<QuoteCandle["bid"]> = {}): QuoteCandle => ({
    datetime: iso(times[I_BUY] + H),
    bid: { datetime: iso(times[I_BUY] + H), open: 150, high: 150.4, low: 149.8, close: bidClose, ...over },
    ask: { datetime: iso(times[I_BUY] + H), open: 150.01, high: 150.41, low: 149.81, close: askClose },
  });

  it("a BUY pays the ask and leaves on the bid, a SELL the other way", () => {
    const quote = q(150.118, 150.128);
    expect(ridePaidAt("BUY", quote)).toBe(150.128);
    expect(rideLeaveAt("BUY", quote)).toBe(150.118);
    expect(ridePaidAt("SELL", quote)).toBe(150.118);
    expect(rideLeaveAt("SELL", quote)).toBe(150.128);
  });

  it("the profit or loss since email 1: (seen − entry) for a BUY, (entry − seen) for a SELL; pips on a pair, dollars on gold", () => {
    expect(ridePnl("USD/JPY", "BUY", 150.128, 150.205)).toEqual({ value: 7.7, unit: "pips" });
    expect(ridePnl("USD/JPY", "BUY", 150.128, 150.118)).toEqual({ value: -1, unit: "pips" });
    expect(ridePnl("USD/JPY", "SELL", 150.118, 150.128)).toEqual({ value: -1, unit: "pips" });
    expect(ridePnl("USD/JPY", "SELL", 150.118, 149.5)).toEqual({ value: 61.8, unit: "pips" });
    // 0.0001 a pip on the others, to a tenth of a pip
    expect(ridePnl("EUR/USD", "BUY", 1.10013, 1.10248)).toEqual({ value: 23.5, unit: "pips" });
    expect(ridePnl("AUD/USD", "SELL", 0.65432, 0.65432)).toEqual({ value: 0, unit: "pips" });
    // gold: dollars, one price a side
    expect(ridePnl("XAU/USD", "BUY", 4150.12, 4162.5)).toEqual({ value: 12.38, unit: "usd" });
    expect(ridePnl("XAU/USD", "SELL", 4150.12, 4162.5)).toEqual({ value: -12.38, unit: "usd" });
  });

  it("how long it was held: minutes under 2 hours, then hours and minutes, then days and hours", () => {
    expect(rideHeldText(20_000, "ja")).toBe("1分未満");
    expect(rideHeldText(20_000, "en")).toBe("under a minute");
    expect(rideHeldText(MIN, "en")).toBe("1 minute");
    expect(rideHeldText(119 * MIN + 59_000, "ja")).toBe("119分");
    expect(rideHeldText(119 * MIN, "en")).toBe("119 minutes");
    expect(rideHeldText(2 * H, "ja")).toBe("2時間0分");
    expect(rideHeldText(47 * H + 59 * MIN, "en")).toBe("47 hours 59 minutes");
    expect(rideHeldText(48 * H, "ja")).toBe("2日0時間");
    // the longest measured: 40,141 minutes
    expect(rideHeldText(40_141 * MIN, "ja")).toBe("27日21時間");
    expect(rideHeldText(40_141 * MIN, "en")).toBe("27 days 21 hours");
  });

  it("a pair's forming hour: the mid of bid and ask highs and lows so far, rounded as the chart draws, and the newest bid and ask", () => {
    const hour = times[I_BUY] + H;
    const closed = { ...q(150.1, 150.11), datetime: iso(times[I_BUY]) };
    const forming = q(150.118, 150.128);
    const got = rideFormingOf("USD/JPY", [closed, forming], hour, hour + 4 * MIN)!;
    expect(got.high).toBe(150.405);
    expect(got.low).toBe(149.805);
    expect(got.quote).toBe(forming);
    // no bar forming at that hour in the read (GMO has not served it yet; or the read is of another hour): none
    expect(rideFormingOf("USD/JPY", [closed], hour, hour + 4 * MIN)).toBeNull();
    expect(rideFormingOf("USD/JPY", [closed, forming], hour + H, hour + H + MIN)).toBeNull();
    // once the hour is over the bar is closed, not forming
    expect(rideFormingOf("USD/JPY", [closed, forming], hour, hour + H)).toBeNull();
  });

  it("gold's hour so far: the extremes of the minutes recorded in it and the newest minute's close, 2 decimals, with no need of the hour's open", () => {
    const hour = Date.UTC(2026, 10, 4, 6);
    const m = (minute: number, high: number, low: number, close: number) => ({ minute: pg(hour + minute * MIN), high, low, close });
    // the hour's first minutes were not recorded (the day's first hour after the break): read from the minutes there are
    const minutes = [m(-1, 4990, 4000, 4100), m(7, 4151.236, 4149.004, 4150.5), m(5, 4150.2, 4148.666, 4149.9), m(9, 4150.9, 4149.5, 4150.777), m(60, 4999, 4001, 4500)];
    expect(goldHourExtremes(minutes, hour)).toEqual({ high: 4151.24, low: 4148.67, close: 4150.78, minutes: 3 });
    expect(goldHourExtremes(minutes, hour - 2 * H)).toBeNull();
    expect(goldHourExtremes([], hour)).toBeNull();
    // a minute with a price that is no number is left out
    expect(goldHourExtremes([m(1, Number.NaN, 4149, 4150), m(2, 4150.5, 4149.5, 4150)], hour)).toEqual({ high: 4150.5, low: 4149.5, close: 4150, minutes: 1 });
  });
});

describe("#397 the three mails (spec section 8)", () => {
  const inMail = (i: number, pair = "USD/JPY") => {
    const e = entryOf(i);
    const paid = pair === "XAU/USD" ? closes[i] : e.side === "BUY" ? ask(closes[i]) : bid(closes[i]);
    return rideCloseSignal("macdx", pair, "1h", "in", e, barOf(i, paid));
  };
  const outMail = (over: Partial<Record<string, unknown>> = {}) => rideOutSignal("macdx", "1h", macdRideOf(rideRow({
    status: "reached", reached_at: pg(times[I_BUY] + H + 4 * MIN + 2_000), reached_bar: pg(times[I_BUY] + H), seen_price: 150.9, late: false, share1: 0.9612, ...over,
  }))!)!;
  const allText = (s: IndicatorSignal) => (["ja", "en"] as const).map((l) => renderIndicatorMail(s, l)).map((m) => `${m.subject}\n${m.text}\n${m.html}`).join("\n");

  it("email 1 in Japanese: the bar, into the 90% band of the pane's TOP for a BUY with the bar before outside, the numbers, the price paid, what follows, what was measured", () => {
    const s = inMail(I_BUY);
    const f = s.ride!;
    const mail = renderIndicatorMail(s, "ja");
    expect(mail.subject).toBe("【Sextant】ドル/円 1時間足 買い（BUY）で入る合図（MACD の流れ・1通目）");
    const t = mail.text;
    expect(t).toContain("ドル/円の1時間足で、MACD の流れの買い（BUY）で入る合図が出ました（1通目）。");
    // I_BUY closes 2026-10-12 10:00 UTC, 19:00 in Japan
    expect(t).toContain("判定した足: 2026-10-12 19:00（日本時間）に確定した足");
    expect(t).toContain("MACD(12・26・9): 青い線（MACD）が、新しい120本の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い所）の90%以上（0の線から測って）に入りました。一つ前の足では入っていなかったので、流れに乗って買いで入る合図です");
    // the edge is the PANE side's, the top for a BUY (the 95% email printed the bottom for a BUY)
    expect(f.top!).toBeGreaterThan(0);
    expect(t).toContain(`\n  MACD = ${f.m!.toFixed(3)}、枠の上の端 = ${f.top!.toFixed(3)}（その90% = ${(RIDE_IN_SHARE * f.top!).toFixed(3)}、96% = ${(RIDE_OUT_SHARE * f.top!).toFixed(3)}）`);
    expect(t).not.toContain("枠の下の端");
    expect(t).toContain(`\n買値（この足の終値の買値）: ${ask(closes[I_BUY]).toFixed(3)}`);
    expect(t).toContain("2通目は、青い線が同じ端（枠の上の端）の96%に届いた時に送ります。損切りも目標もありません。青い線が90%の帯から出ても、何も送りません。2通目を送るまで、このチャートの同じ向き（買い）の新しい1通目は送りません。");
    expect(t).toContain("公開されているインジケーターではありません（docs §8.150）。");
    // the measured paragraph: docs §8.149's numbers, as measured
    expect(t).toContain(
      "ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの1時間足で測ると（2024年1月〜2026年11月10日、スプレッドを引いたあと。docs §8.149）、入る合図は801回で、800回が96%に届きました。届いた時の損益は、プラスが360回、マイナスが429回、ちょうど0が11回で、1回あたり平均 +0.43 pips、最悪 −323.6 pips でした。持っている間の含み損は最大 558.8 pips、一番長く持ったのは約28日で、1回はまだ届いていません（含み損 −6.1 pips）。",
    );
    expect(t).toContain("知らせだけの足（確定でもう96%）が750回、同じ向きを持っている間で見送った入りが30回ありました。届いた取引の半分は、入ってから1分以内に届いています。損切りをしないので、届く割合は作りの上で高く出ます。");
    expect(t).toContain("5ペアのメールは GMO の1時間足を毎分読んで96%を見ますが、測った時は1分足で見ました。この違いは測っていません。");
    expect(t).not.toContain("金では");
    expect(t).toContain("価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ足で判定しています。");
    expect(t).toContain("https://fx-tactical.jp/");
    expect(t).toContain("「MACD の流れ」でチェックを外してください");
    expect(t).toContain("本メールは参考情報であり、投資助言ではありません。");
    // no stop, no targets, nothing of the 95% email, no old name
    for (const no of ["損切り 1", "利確", "エントリー ≈", "ULTRA", "95%", "山・谷", "§8.119", "まだ測っていません", "必ず戻"]) expect(t, no).not.toContain(no);
  });

  it("email 1 for a SELL is on the pane's BOTTOM, with the bid; in English it says the same", () => {
    const s = inMail(I_SELL);
    const f = s.ride!;
    expect(f.bottom!).toBeLessThan(0);
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】ドル/円 1時間足 売り（SELL）で入る合図（MACD の流れ・1通目）");
    expect(ja.text).toContain("枠の下の端（青い線・オレンジの線・棒の一番低い所）の90%以上（0の線から測って）に入りました。一つ前の足では入っていなかったので、流れに乗って売りで入る合図です");
    // below zero the minus is the chart's (U+2212), not toFixed's hyphen
    expect(ja.text).toContain(`\n  MACD = −${(-f.m!).toFixed(3)}、枠の下の端 = −${(-f.bottom!).toFixed(3)}（その90% = −${(-RIDE_IN_SHARE * f.bottom!).toFixed(3)}、96% = −${(-RIDE_OUT_SHARE * f.bottom!).toFixed(3)}）`);
    expect(ja.text).not.toContain("= -");
    expect(ja.text).toContain(`\n売値（この足の終値の売値）: ${bid(closes[I_SELL]).toFixed(3)}`);
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] USD/JPY 1-hour SELL entry signal (MACD ride, email 1)");
    const t = en.text;
    expect(t).toContain("A MACD ride SELL entry signal fired on USD/JPY, 1-hour chart (email 1).");
    expect(t).toContain("Bar: closed 2026-09-10 06:00 UTC (2026-09-10 15:00 JST)");
    expect(t).toContain(
      "MACD(12, 26, 9): the MACD line (blue) came into the bottom band of the MACD pane of the newest 120 bars: 90% or more of the way from the zero line to the pane's bottom (the lowest of the MACD line, the signal line and the histogram). The bar before was outside it, so this is an entry with the flow: a SELL",
    );
    expect(t).toContain(`\n  MACD = −${(-f.m!).toFixed(3)}; bottom of the pane = −${(-f.bottom!).toFixed(3)}; 90% of it = −${(-RIDE_IN_SHARE * f.bottom!).toFixed(3)}; 96% of it = −${(-RIDE_OUT_SHARE * f.bottom!).toFixed(3)}`);
    expect(t).toContain(`\nBid at this bar's close (the price paid): ${bid(closes[I_SELL]).toFixed(3)}`);
    expect(t).toContain("Email 2 is sent when the blue line reaches 96% of the same edge (the pane's bottom). There is no stop and no target. Nothing is sent if the line leaves the 90% band, and no new email 1 for this chart and side (SELL) is sent until email 2 has been.");
    expect(t).toContain(
      "Measured on the 1-hour bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD (2024-01 to 2026-11-10, after the spread; docs §8.149): 801 entries, of which 800 reached 96% — 360 of them at a profit, 429 at a loss and 11 at zero — +0.43 pips an entry on average, the worst −323.6 pips, the largest loss on the way 558.8 pips, the longest held about 28 days, and 1 not reached yet (−6.1 pips).",
    );
    expect(t).toContain("750 more bars were a notice only (already at 96%), and 30 entries were skipped while a ride of the same side was held. Half of those reached were reached within 1 minute of the entry. There is no stop, so the share that reaches 96% is high by construction.");
    expect(t).toContain("On the five pairs the function reads GMO's 1-hour bar each minute where the study read 1-minute bars; that difference has not been measured.");
    expect(t).toContain("untick the chart under MACD ride");
    for (const no of ["Stop ", "TP1", "take-profit", "take profit", "ULTRA", "95%", "peak/valley", "always comes back", "has not been measured on gold"]) expect(t, no).not.toContain(no);
  });

  it("the measured numbers are docs §8.149's, kept in one place", () => {
    expect(RIDE_MEASURED).toEqual({
      from: "2024-01", to: "2026-11-10", entries: 801, reached: 800, plus: 360, minus: 429, zero: 11, perTrade: 0.43, worst: -323.6,
      maeMax: 558.8, longestDays: 28, open: 1, openPips: -6.1, notices: 750, skipped: 30, medianMinutes: 1,
    });
    expect(RIDE_MEASURED.plus + RIDE_MEASURED.minus + RIDE_MEASURED.zero).toBe(RIDE_MEASURED.reached);
    expect(RIDE_MEASURED.reached + RIDE_MEASURED.open).toBe(RIDE_MEASURED.entries);
    // typed once: the mail's numbers come from the constant
    const src = readFileSync("supabase/functions/signal-alerts/indicators.ts", "utf8");
    const mailCode = src.slice(src.indexOf("const rideMeasuredLine = "), src.indexOf("export const renderIndicatorMail = "))
      .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    for (const typed of ["801", "800", "360", "429", "0.43", "323.6", "558.8", "750"]) expect(mailCode, typed).not.toContain(typed);
  });

  it("gold's email 1 says first that gold is not measured, gives the bar's close and no pips of its own, and names both feeds", () => {
    const s = inMail(I_BUY, "XAU/USD");
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】金 1時間足 買い（BUY）で入る合図（MACD の流れ・1通目）");
    expect(ja.text).toContain("\n\n金では、この決まりを測っていません。次の数字は5ペアのものです。ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの1時間足で測ると");
    expect(ja.text).toContain(`\nこの足の終値: ${closes[I_BUY].toFixed(2)}`);
    expect(ja.text).not.toContain("買値");
    expect(ja.text).toContain("足は Twelve Data のもの（金は GMOコインにないため）で、アプリのチャートと同じです。2通目は、Swissquote の値段を毎分記録したもの（足とは別の配信）で見ます。");
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] XAU/USD 1-hour BUY entry signal (MACD ride, email 1)");
    expect(en.text).toContain("\n\nThis rule has not been measured on gold; the numbers that follow are the five pairs'. Measured on the 1-hour bars of USD/JPY");
    expect(en.text).toContain(`\nThis bar's close: ${closes[I_BUY].toFixed(2)}`);
    expect(en.text).toContain("The bars are Twelve Data's (GMO Coin does not carry XAU/USD), as the app's chart draws them. Email 2 is looked for on Swissquote's prices, recorded every minute (another feed than the bars').");
  });

  it("the notice: the line came into the band already at 96%, no entry, the three numbers", () => {
    const e = entryOf(I_NOTICE);
    const s = rideCloseSignal("macdx", "USD/JPY", "1h", "at", e, barOf(I_NOTICE, closes[I_NOTICE]));
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】ドル/円 1時間足 知らせ: もう96%です（MACD の流れ・入る合図なし）");
    expect(ja.text).toContain("ドル/円の1時間足で、MACD の青い線が、枠の下の端の90%の帯に入りましたが、足が確定した時にはもう96%以上でした。入る合図（売り（SELL））は送りません。知らせだけです。");
    expect(ja.text).toContain("判定した足: 2026-10-15 08:00（日本時間）に確定した足");
    expect(ja.text).toContain(`\n  MACD = −${(-e.z.m).toFixed(3)}、枠の下の端 = −${(-e.z.bottom).toFixed(3)}（その96% = −${(-RIDE_OUT_SHARE * e.z.bottom).toFixed(3)}）`);
    expect(e.z.m).toBeLessThanOrEqual(RIDE_OUT_SHARE * e.z.bottom);
    expect(ja.text).toContain("このチャートの同じ向きの次の入る合図は、青い線がいったん90%の帯から出て、入り直した足で判定します。");
    expect(ja.text).toContain("「MACD の流れ」でチェックを外してください");
    // no entry: no price paid, no measured paragraph
    for (const no of ["この足の終値の", "その90%", "測ると", "利確", "損切り", "必ず戻"]) expect(ja.text, no).not.toContain(no);
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] USD/JPY 1-hour notice: already at 96% (MACD ride, no entry signal)");
    expect(en.text).toContain("On USD/JPY, 1-hour chart, the MACD line (blue) came into the 90% band of the MACD pane's bottom, and at the bar's close it was already at 96% or more. No entry signal (it would have been a SELL) is sent: this is a notice only.");
    expect(en.text).toContain(`\n  MACD = −${(-e.z.m).toFixed(3)}; bottom of the pane = −${(-e.z.bottom).toFixed(3)}; 96% of it = −${(-RIDE_OUT_SHARE * e.z.bottom).toFixed(3)}`);
  });

  it("email 2 in Japanese: the first email, seen at, the price now on the side a BUY leaves on, the result with its sign, how long, and that it reports the line, not a profit", () => {
    const paid = ask(closes[I_BUY]);
    const loss = outMail({ seen_price: Number((paid - 0.023).toFixed(3)) });
    const mail = renderIndicatorMail(loss, "ja");
    expect(mail.subject).toBe("【Sextant】ドル/円 1時間足 96%に届きました（MACD の流れ・2通目、買いの分）");
    const t = mail.text;
    expect(t).toContain("ドル/円の1時間足で、MACD の青い線が、枠の上の端の96%に届きました（MACD の流れの2通目。買い（BUY）の分）。");
    expect(t).toContain(`1通目: 2026-10-12 19:00（日本時間）に確定した足で買い（BUY）。買値 ${paid.toFixed(3)}`);
    expect(t).toContain("\n届いたのを見た時刻: 2026-10-12 19:04（日本時間）");
    expect(t).toContain(`\n今の値段: ${(paid - 0.023).toFixed(3)}（売値）`);
    // the minus as the chart's
    expect(t).toContain("\n1通目からの損益: −2.3 pips");
    expect(t).toContain("\n1通目からの時間: 4分");
    expect(t).toContain("このメールは、青い線が96%に届いたことの知らせです。損益はプラスとは限りません。");
    expect(t).toContain("96%に届いたかは、1時間足のその時までの高値（買値と売値の中間。アプリのチャートと同じ丸め方）で、毎分見ています。");
    expect(t).toContain("「MACD の流れ」でチェックを外してください");
    expect(t).not.toContain("その時は読めず");
    // a profit, and exactly zero
    expect(renderIndicatorMail(outMail({ seen_price: Number((paid + 0.418).toFixed(3)) }), "ja").text).toContain("\n1通目からの損益: +41.8 pips");
    expect(renderIndicatorMail(outMail({ seen_price: paid }), "ja").text).toContain("\n1通目からの損益: ±0.0 pips");
    // a SELL leaves on the ask (買値) and gains when the price fell
    const sell = outMail({ side: "SELL", entry_price: 150.118, seen_price: 149.9 });
    const st = renderIndicatorMail(sell, "ja");
    expect(st.subject).toBe("【Sextant】ドル/円 1時間足 96%に届きました（MACD の流れ・2通目、売りの分）");
    expect(st.text).toContain("枠の下の端の96%に届きました");
    expect(st.text).toContain("で売り（SELL）。売値 150.118");
    expect(st.text).toContain("\n今の値段: 149.900（買値）");
    expect(st.text).toContain("\n1通目からの損益: +21.8 pips");
    expect(st.text).toContain("その時までの安値");
  });

  it("email 2 seen late says in which bar it had reached, that it could not be read then, and the price now", () => {
    const found = times[I_BUY] + 3 * H + 1_000;
    const late = outMail({ late: true, reached_bar: pg(times[I_BUY] + H), reached_at: pg(found), seen_price: 150.3 });
    const ja = renderIndicatorMail(late, "ja").text;
    expect(ja).toContain("\n2026-10-12 19:00〜20:00（日本時間）の足の間に届いていました。その時は読めず、今見つけました（2026-10-12 21:00、日本時間）");
    expect(ja).not.toContain("届いたのを見た時刻");
    expect(ja).toContain("\n今の値段: 150.300（最新の確定足の終値の売値）");
    expect(ja).toContain("\n1通目からの時間: 2時間0分");
    expect(ja).toContain("96%に届いたかは、確定した1時間足の高値（買値と売値の中間。アプリのチャートと同じ丸め方）で見ました。");
    const en = renderIndicatorMail(late, "en").text;
    expect(en).toContain("\nIt had reached 96% during the bar 2026-10-12 10:00–11:00 UTC (2026-10-12 19:00–20:00 JST). It could not be read then and was found now (2026-10-12 12:00 UTC, 2026-10-12 21:00 JST)");
    expect(en).toContain("\nPrice now: 150.300 (bid at the newest closed bar's close)");
    expect(en).toContain("\nTime since email 1: 2 hours 0 minutes");
  });

  it("email 2 in English says the same", () => {
    const paid = ask(closes[I_BUY]);
    const mail = renderIndicatorMail(outMail({ seen_price: Number((paid - 0.023).toFixed(3)) }), "en");
    expect(mail.subject).toBe("[Sextant] USD/JPY 1-hour reached 96% (MACD ride, email 2, the BUY)");
    const t = mail.text;
    expect(t).toContain("On USD/JPY, 1-hour chart, the MACD line (blue) reached 96% of the way to the top of the MACD pane (MACD ride, email 2, for the BUY).");
    expect(t).toContain(`Email 1: a BUY at the bar closed 2026-10-12 10:00 UTC (2026-10-12 19:00 JST), ask ${paid.toFixed(3)}`);
    expect(t).toContain("\nSeen at 2026-10-12 10:04 UTC (2026-10-12 19:04 JST)");
    expect(t).toContain(`\nPrice now: ${(paid - 0.023).toFixed(3)} (bid)`);
    expect(t).toContain("\nProfit or loss since email 1: −2.3 pips");
    expect(t).toContain("\nTime since email 1: 4 minutes");
    expect(t).toContain("This email reports that the line reached 96%. It does not say the trade is at a profit: the result can be a loss.");
    expect(t).toContain("untick the chart under MACD ride");
  });

  it("gold's email 2: dollars, no spread, and whether its two prices are of two feeds (seen in the minutes) or one (found late, at a close)", () => {
    const gold = (over: Partial<Record<string, unknown>> = {}) => outMail({ pair: "XAU/USD", entry_price: 4150.12, entry_mid: 4150.12, seen_price: 4162.5, ...over });
    const ja = renderIndicatorMail(gold(), "ja");
    expect(ja.subject).toBe("【Sextant】金 1時間足 96%に届きました（MACD の流れ・2通目、買いの分）");
    expect(ja.text).toContain("で買い（BUY）。その足の終値 4150.12");
    expect(ja.text).toContain("\n今の値段: 4162.50（Swissquote の値段）");
    expect(ja.text).toContain("\n1通目からの損益: +12.38ドル");
    expect(ja.text).toContain("損益はプラスとは限りません。金の損益は、スプレッドを含みません。1通目の値段は Twelve Data の足の終値、今の値段は Swissquote の値段で、配信が別です。");
    expect(ja.text).toContain("96%に届いたかは、Swissquote の値段を毎分記録したもの（この1時間の高値）で、毎分見ています。");
    expect(ja.text).not.toContain("pips");
    const en = renderIndicatorMail(gold({ seen_price: 4140 }), "en").text;
    expect(en).toContain("\nPrice now: 4140.00 (Swissquote's price)");
    expect(en).toContain("\nProfit or loss since email 1: −$10.12");
    expect(en).toContain("Gold's result holds no spread, and its two prices come from two feeds: email 1's is the close of Twelve Data's bar, the price now is Swissquote's.");
    // found late, at a close: both prices are Twelve Data's closes
    const late = renderIndicatorMail(gold({ late: true, reached_at: pg(times[I_BUY] + 3 * H + 61_000) }), "ja").text;
    expect(late).toContain("\n今の値段: 4162.50（Twelve Data の最新の確定足の終値）");
    expect(late).toContain("金の損益は、スプレッドを含みません。どちらの値段も Twelve Data の足の終値です。");
    expect(late).toContain("96%に届いたかは、確定した1時間足の高値で見ました。");
    expect(renderIndicatorMail(gold({ late: true }), "en").text).toContain("Gold's result holds no spread; both prices are closes of Twelve Data's bars.");
  });

  it("none of the three calls email 2 a take-profit or says a price always comes back, in either language, on a pair or on gold", () => {
    const mails = [
      inMail(I_BUY), inMail(I_SELL), inMail(I_BUY, "XAU/USD"),
      rideCloseSignal("macdx", "USD/JPY", "1h", "at", entryOf(I_NOTICE), barOf(I_NOTICE, closes[I_NOTICE])),
      outMail(), outMail({ late: true }), outMail({ pair: "XAU/USD" }), outMail({ pair: "XAU/USD", late: true }), outMail({ side: "SELL" }),
    ];
    for (const s of mails) {
      const t = allText(s);
      for (const no of ["利確", "必ず戻", "take-profit", "take profit", "Take-profit", "always comes back", "always come back", "山・谷", "peak/valley"]) expect(t, `${s.ride!.mail} ${no}`).not.toContain(no);
      // the HTML part says what the text part says
      expect(renderIndicatorMail(s, "ja").html).toContain("MACD の流れ");
    }
  });

  it("the rule is named 「MACD の流れ」 / \"MACD ride\" in the test email too (the subscription's rule stays 'macdx')", () => {
    const ja = renderTestMail([{ pair: "USD/JPY", interval: "1h", rule: "macdx" }], "ja").text;
    expect(ja).toContain("登録中のチャート: ドル/円 1時間足（MACD の流れ）");
    expect(ja).toContain("Q-Trend、ULTRA、MACD の流れ、流動性狩り＋EMAクロス");
    expect(ja).not.toContain("山・谷");
    const en = renderTestMail([{ pair: "XAU/USD", interval: "1h", rule: "macdx" }], "en").text;
    expect(en).toContain("Charts you follow: XAU/USD 1-hour (MACD ride)");
    expect(en).toContain("Q-Trend, ULTRA, MACD ride, Liquidity sweep + EMA cross");
    expect(en).not.toContain("peak/valley");
  });

  it("a tiny edge is written to two significant digits, the numbers of a mail alike, from the PANE side's edge", () => {
    const e = entryOf(I_BUY);
    const withZ = (pair: string, side: "top" | "bottom", z: { m: number; top: number; bottom: number }) =>
      rideCloseSignal("macdx", pair, "1h", "in", { ...e, zside: side, side: side === "top" ? "BUY" : "SELL", z }, barOf(I_BUY, 1.1));
    // EUR/USD, a top of 0.0000125: in the price's 5 decimals it would read 0.00001 four times
    const top = 1.2519827838231024e-5;
    const eur = renderIndicatorMail(withZ("EUR/USD", "top", { m: top, top, bottom: -0.0022 }), "ja").text;
    expect(eur).toContain("\n  MACD = 0.000013、枠の上の端 = 0.000013（その90% = 0.000011、96% = 0.000012）");
    // the decimals follow the edge on the ride's side: a BUY's tiny BOTTOM changes nothing
    const yen = renderIndicatorMail(withZ("USD/JPY", "top", { m: 0.19, top: 0.2, bottom: -1e-9 }), "en").text;
    expect(yen).toContain("\n  MACD = 0.190; top of the pane = 0.200; 90% of it = 0.180; 96% of it = 0.192");
    // a SELL's tiny bottom does
    const sell = renderIndicatorMail(withZ("USD/JPY", "bottom", { m: -0.0095, top: 0.2, bottom: -0.0097 }), "en").text;
    expect(sell).toContain("\n  MACD = −0.0095; bottom of the pane = −0.0097; 90% of it = −0.0087; 96% of it = −0.0093");
    // a signal with no facts (none is made so) is written with dashes, not thrown on
    const bare: IndicatorSignal = { ...inMail(I_BUY), ride: undefined };
    expect(renderIndicatorMail(bare, "ja").text).toContain("MACD = —、枠の上の端 = —");
    expect(shareOf(e.z, e.zside)).toBeGreaterThanOrEqual(0.9);
  });
});

// ---- part 2: the real index.ts over fake tables --------------------------------------------------------------------

type Row = Record<string, unknown>;
const SB = "https://sb.test";
const TIME_COLS = new Set(["bar_time", "entry_bar", "entry_closed_at", "reached_at", "reached_bar", "closed_at", "minute", "last_bar", "source_read_at", "created_at"]);

const world = {
  subs: [] as Row[],
  rides: [] as Row[],
  states: [] as Row[],
  alerts: [] as Row[],
  ranges: [] as Row[],
  klineFiles: new Map<string, Row>(),
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  // a closed bar's wick, and the forming bar so far (by its open); none: no wick, and flat at its open
  wicks: new Map<number, { high?: number; low?: number }>(),
  forming: new Map<number, { high: number; low: number; close: number }>(),
  // followers whose plan lookup fails (a 503), and how the rides' table answers (200; 404 when it is not there)
  failPlanFor: new Set<string>(),
  ridesStatus: 200,
  // called once when a ride is about to be patched: another run getting there first
  onRidePatch: null as (() => void) | null,
  gold: null as null | { bars: Row[]; fetched_at: string },
  goldMinutes: [] as Row[],
  gmoCalls: 0,
  // every REST read as "table select", every request that no route took
  reads: [] as string[],
  unrouted: [] as string[],
  ids: 0,
};
const resetWorld = () => {
  Object.assign(world, {
    subs: [], rides: [], states: [], alerts: [], ranges: [], sent: [], ridesStatus: 200, onRidePatch: null, gold: null, goldMinutes: [], gmoCalls: 0, reads: [], unrouted: [], ids: 0,
  });
  world.klineFiles.clear();
  world.wicks.clear();
  world.forming.clear();
  world.failPlanFor.clear();
};
let clock = 0;

// GMO's 1-hour file of a JST day key: the bars opened from 22:00 UTC the day before (winter's roll), bid and ask a
// spread of 0.010 around the mid; the forming bar as far as it has got
const midBar = (k: number) => {
  const t = times[k];
  const open = openOf(k);
  if (t + H > clock) {
    const f = world.forming.get(t) ?? { high: open, low: open, close: open };
    return { o: open, h: Math.max(open, f.high), l: Math.min(open, f.low), c: f.close };
  }
  const w = world.wicks.get(t) ?? {};
  return { o: open, h: Math.max(open, closes[k], w.high ?? -Infinity), l: Math.min(open, closes[k], w.low ?? Infinity), c: closes[k] };
};
const gmoFile = (side: string, key: string) => {
  const start = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8))) - 2 * H;
  const data: Row[] = [];
  for (let t = start; t < start + 24 * H; t += H) {
    const k = indexOfTime.get(t);
    if (k === undefined || t > clock) continue;
    const m = midBar(k);
    const f = (v: number) => (v + (side === "BID" ? -0.005 : 0.005)).toFixed(3);
    data.push({ openTime: String(t), open: f(m.o), high: f(m.h), low: f(m.l), close: f(m.c) });
  }
  return { status: 0, data, responsetime: iso(clock) };
};

// PostgREST's filters, as far as the function uses them
const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);
const splitTop = (list: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of list) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
};
const same = (col: string, a: unknown, b: string) => (TIME_COLS.has(col) ? Date.parse(String(a)) === Date.parse(b) : String(a) === b);
const condOf = (col: string, expr: string): ((r: Row) => boolean) => {
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  if (op === "in") {
    const list = splitTop(raw.slice(1, -1)).map(unquote);
    return (r) => r[col] !== null && r[col] !== undefined && list.some((v) => same(col, r[col], v));
  }
  const val = unquote(raw);
  if (op === "eq") return (r) => r[col] !== null && r[col] !== undefined && same(col, r[col], val);
  if (op === "gte" || op === "gt" || op === "lt" || op === "lte") {
    return (r) => {
      if (r[col] === null || r[col] === undefined) return false;
      const d = TIME_COLS.has(col) ? Date.parse(String(r[col])) - Date.parse(val) : Number(r[col]) - Number(val);
      return op === "gte" ? d >= 0 : op === "gt" ? d > 0 : op === "lt" ? d < 0 : d <= 0;
    };
  }
  throw new Error(`a filter the fake does not know: ${col}=${expr}`);
};
const META = new Set(["select", "order", "limit", "on_conflict"]);
const whereOf = (u: URL): ((r: Row) => boolean) => {
  const conds: Array<(r: Row) => boolean> = [];
  for (const [k, v] of u.searchParams) {
    if (META.has(k)) continue;
    if (k === "or") {
      const any = splitTop(v.slice(1, -1)).map((clause) => condOf(clause.slice(0, clause.indexOf(".")), clause.slice(clause.indexOf(".") + 1)));
      conds.push((r) => any.some((c) => c(r)));
    } else conds.push(condOf(k, v));
  }
  return (r) => conds.every((c) => c(r));
};
const pick = (r: Row, select: string | null): Row => (select === null || select === "*" ? { ...r } : Object.fromEntries(select.split(",").map((c) => [c, r[c] ?? null])));
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const empty = (status: number) => new Response(null, { status });

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  const prefer = String((init?.headers as Record<string, string> | undefined)?.Prefer ?? "");
  if (url.startsWith("https://forex-api.coin.z.com/public/v1/klines")) {
    world.gmoCalls++;
    const u = new URL(url);
    if (u.searchParams.get("symbol") !== "USD_JPY" || u.searchParams.get("interval") !== "1hour") return reply({ status: 0, data: [], responsetime: iso(clock) });
    return reply(gmoFile(u.searchParams.get("priceType")!, u.searchParams.get("date")!));
  }
  if (url === "https://api.resend.com/emails") {
    world.sent.push({ to: body.to[0], subject: body.subject, text: body.text });
    return reply({ id: `re_${world.sent.length}` });
  }
  if (url.startsWith(`${SB}/auth/v1/admin/users/`)) {
    const uid = decodeURIComponent(url.split("/").pop()!);
    return reply({ id: uid, email: `${uid}@example.test` });
  }
  if (!url.startsWith(`${SB}/rest/v1/`)) {
    world.unrouted.push(`${method} ${url.slice(0, 90)}`);
    return new Response("not found", { status: 404 });
  }
  const u = new URL(url);
  const table = u.pathname.slice("/rest/v1/".length);
  const select = u.searchParams.get("select");
  const where = whereOf(u);
  if (method === "GET") world.reads.push(`${table} ${select ?? "*"}`);
  if (table === "rpc/track_outcomes_sweep_token") return reply("tok");
  if (table === "signal_alert_subscriptions" && method === "GET") return reply(world.subs.filter(where).map((r) => pick(r, select)));
  if (table === "profiles" && method === "GET") {
    const uid = u.searchParams.get("id")!.slice(3);
    return world.failPlanFor.has(uid) ? reply({ message: "boom" }, 503) : reply([{ plan: "light" }]);
  }
  if (table === "gmo_kline_files") {
    if (method === "GET") return reply([...world.klineFiles.values()].filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      world.klineFiles.set(`${body.symbol}|${body.price_type}|${body.interval}|${body.date_key}`, body);
      return empty(201);
    }
  }
  if (table === "live_chart_fallback" && method === "GET") {
    return reply(world.gold && u.searchParams.get("pair") === "eq.XAU/USD" && u.searchParams.get("interval") === "eq.1h" ? [pick(world.gold, select)] : []);
  }
  if (table === "gold_tick_bars" && method === "GET") {
    return reply(world.goldMinutes.filter(where).filter((m) => Date.parse(String(m.minute)) <= clock).map((r) => pick(r, select)));
  }
  if (table === "spike_ranges") {
    if (method === "GET") return reply(world.ranges.filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      world.ranges = [...world.ranges.filter((r) => !(r.pair === body.pair && same("bar_time", r.bar_time, body.bar_time))), body];
      return empty(201);
    }
    if (method === "DELETE") {
      world.ranges = world.ranges.filter((r) => !where(r));
      return empty(204);
    }
  }
  if (table === "signal_alerts") {
    if (method === "GET") return reply(world.alerts.filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      const key = (r: Row) => [r.user_id, r.kind, r.pair, r.interval, Date.parse(String(r.bar_time)), r.side, r.rule].join("|");
      if (world.alerts.some((r) => key(r) === key(body))) return reply([], 201);
      const row = { ...body, id: `alert-${++world.ids}`, n: world.alerts.length };
      world.alerts.push(row);
      return reply([{ id: row.id }], 201);
    }
    if (method === "PATCH") {
      for (const r of world.alerts.filter(where)) Object.assign(r, body);
      return empty(204);
    }
  }
  if (table === "macd_rides") {
    if (world.ridesStatus !== 200) return reply({ message: 'relation "public.macd_rides" does not exist' }, world.ridesStatus);
    if (method === "GET") return reply(world.rides.filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      // the primary key (duplicates ignored), then the one open ride a chart and side
      if (world.rides.some((r) => r.pair === body.pair && r.side === body.side && same("entry_bar", r.entry_bar, body.entry_bar))) return empty(201);
      if (world.rides.some((r) => r.pair === body.pair && r.side === body.side && r.status === "open")) {
        return reply({ code: "23505", message: 'duplicate key value violates unique constraint "macd_rides_one_open"' }, 409);
      }
      world.rides.push({ share0: null, reached_at: null, reached_bar: null, seen_price: null, late: null, share1: null, ...body, entry_bar: pg(Date.parse(body.entry_bar)), entry_closed_at: pg(Date.parse(body.entry_closed_at)) });
      return empty(201);
    }
    if (method === "PATCH") {
      const hook = world.onRidePatch;
      world.onRidePatch = null;
      hook?.();
      const hit = world.rides.filter(where);
      for (const r of hit) Object.assign(r, body, { reached_at: pg(Date.parse(body.reached_at)), reached_bar: pg(Date.parse(body.reached_bar)) });
      return prefer.includes("return=representation") ? reply(hit.map((r) => pick(r, select))) : empty(204);
    }
  }
  if (table === "macd_ride_state") {
    if (method === "GET") return reply(world.states.filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      const at = world.states.findIndex((r) => r.pair === body.pair && same("bar_time", r.bar_time, body.bar_time));
      if (at >= 0) world.states[at] = { ...world.states[at], ...body, writes: Number(world.states[at].writes) + 1 };
      else world.states.push({ ...body, writes: 1 });
      return empty(201);
    }
    if (method === "DELETE") {
      world.states = world.states.filter((r) => !where(r));
      return empty(204);
    }
  }
  world.unrouted.push(`${method} ${table}?${u.searchParams.toString().slice(0, 90)}`);
  return reply([], 200);
};

type Handler = (req: Request) => Promise<Response>;
type Read = Record<string, unknown> & { pair?: string; interval?: string; signals?: string[] };
type Summary = Record<string, unknown> & { reads?: Read[] };

describe("#397 the ride in the function: the real index.ts replayed over fake tables (spec sections 5 and 7)", () => {
  let captured: Handler | null = null;
  const realSetTimeout = globalThis.setTimeout;
  beforeAll(() => {
    vi.stubGlobal("Deno", {
      env: { get: (k: string) => ({ SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc", RESEND_API_KEY: "re_test" } as Record<string, string>)[k] },
      serve: (h: Handler) => {
        captured = h;
      },
    });
    vi.stubGlobal("fetch", fakeFetch);
    // the function's sleeps (GMO a request at a time, Resend two a second) pass at once, the clock moved on by them
    vi.stubGlobal("setTimeout", (fn: () => void, ms?: number) => {
      clock += Math.max(0, ms ?? 0);
      return realSetTimeout(fn, 0);
    });
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // (absent in the test DOM, always there in Deno)
    const signal = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
    if (typeof signal.timeout !== "function") signal.timeout = () => new AbortController().signal;
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => resetWorld());

  // one import of the module is one instance: nothing of an earlier one's memory is in it
  const INDEX = "../../supabase/functions/signal-alerts/index.ts";
  const instance = async (): Promise<Handler> => {
    vi.resetModules();
    captured = null;
    await import(/* @vite-ignore */ INDEX);
    if (!captured) throw new Error("the function did not start");
    return captured;
  };
  // a run of the "indicators" mode at `at` (a second past the minute, as the cron's run reads its clock)
  const sweep = async (h: Handler, at: number): Promise<Summary> => {
    clock = at;
    const res = await h(new Request("https://fn.test/signal-alerts", { method: "POST", headers: { "x-sweep-token": "tok", "Content-Type": "application/json" }, body: JSON.stringify({ mode: "indicators" }) }));
    expect(res.status).toBe(200);
    const text = await res.text();
    // no run's record holds a follower, an address or a row id
    for (const no of ["userA", "userB", "userC", "example.test", "alert-", "user_id"]) expect(text, no).not.toContain(no);
    return JSON.parse(text) as Summary;
  };
  const fresh = async (at: number) => sweep(await instance(), at);
  const closeOf = (i: number) => times[i] + H;
  const at = (i: number, minute: number) => closeOf(i) + minute * MIN + 1_000;
  const follow = (user: string, rule = "macdx", pair = "USD/JPY") => ({ user_id: user, pair, interval: "1h", lang: "ja", rule });
  // the judged chart's entry of a run's record, its signals the ride's alone (Q-Trend's and ULTRA's are told there too)
  const judged = (s: Summary, pair = "USD/JPY"): Read | undefined => {
    const r = (s.reads ?? []).find((x) => x.pair === pair && x.interval === "1h" && typeof x.ride === "object" && x.ride !== null);
    return r ? { ...r, signals: (r.signals ?? []).filter((x) => x.startsWith("macdx")) } : undefined;
  };
  const minuteOf = (s: Summary, pair = "USD/JPY") => (s.reads ?? []).find((r) => r.pair === pair && r.ride === true);
  const mails = () => world.sent.map((m) => `${m.to.split("@")[0]}: ${m.subject}`);
  const alertsOf = (rule: string) => world.alerts.filter((r) => r.rule === rule);
  const IN_SUBJECT = (side: "買い（BUY）" | "売り（SELL）") => `【Sextant】ドル/円 1時間足 ${side}で入る合図（MACD の流れ・1通目）`;
  const OUT_SUBJECT = (side: "買い" | "売り") => `【Sextant】ドル/円 1時間足 96%に届きました（MACD の流れ・2通目、${side}の分）`;
  const AT_SUBJECT = "【Sextant】ドル/円 1時間足 知らせ: もう96%です（MACD の流れ・入る合図なし）";
  // an older ride of the chart, as its row
  const oldRide = (side: "BUY" | "SELL", entryIndex: number): Row => ({
    pair: "USD/JPY", side, entry_bar: pg(times[entryIndex]), entry_closed_at: pg(closeOf(entryIndex)), entry_price: side === "BUY" ? ask(closes[entryIndex]) : bid(closes[entryIndex]),
    entry_mid: closes[entryIndex], share0: 0.93, status: "open", reached_at: null, reached_bar: null, seen_price: null, late: null, share1: null,
  });
  // nothing the function asked for went unanswered, no read took every column, none read an alert's error
  const clean = () => {
    expect(world.unrouted).toEqual([]);
    for (const r of world.reads) {
      expect(r, r).not.toMatch(/ \*$/);
      if (r.startsWith("signal_alerts ")) expect(r).toBe("signal_alerts user_id");
      if (r.startsWith("macd_rides ")) expect(r).toBe(`macd_rides ${MACD_RIDE_COLUMNS}`);
      if (r.startsWith("macd_ride_state ")) expect(r).toBe("macd_ride_state e12,e26,sig,top119,bottom119");
    }
  };

  it("an entry at a close: the ride's row, the forming bar's state, email 1 with the row's numbers; the same close judged again by fresh instances opens no second ride and mails nobody twice, and a follower whose lookup failed gets email 1 from a later run", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.failPlanFor.add("userB");
    // state rows of earlier hours: the chart's of nine days ago, of seven days ago, and another chart's of nine days ago
    const D = 24 * H;
    const earlier = (pair: string, daysAgo: number): Row => ({ pair, bar_time: iso(closeOf(I_BUY) - daysAgo * D), e12: 150, e26: 150, sig: 0, top119: 0.1, bottom119: -0.1, last_bar: iso(times[I_BUY] - daysAgo * D), source_read_at: null, writes: 1 });
    world.states = [earlier("USD/JPY", 9), earlier("USD/JPY", 7), earlier("EUR/JPY", 9)];
    const s0 = await fresh(at(I_BUY, 0));
    // rows over eight days old are dropped when a state is written: the chart's own only
    expect(world.states.map((r) => [r.pair, r.bar_time])).toEqual([["USD/JPY", iso(closeOf(I_BUY) - 7 * D)], ["EUR/JPY", iso(closeOf(I_BUY) - 9 * D)], ["USD/JPY", iso(closeOf(I_BUY))]]);
    world.states = world.states.filter((r) => r.pair === "USD/JPY" && r.bar_time === iso(closeOf(I_BUY)));
    const j0 = judged(s0)!;
    // (the follower whose lookup failed got no row: said, with no name)
    expect(j0).toMatchObject({ pair: "USD/JPY", interval: "1h", bars: 600, newest: iso(times[I_BUY]), signals: ["macdx:BUY"], ride: { rows: "ok", state: "ok", step: "in", caught: [], unsent: ["in(not_allowed)"] } });
    // the ride: one row, open, the price paid GMO's ask close, the entry bar's close as the chart draws it, the line's share
    const e = entryOf(I_BUY);
    expect(world.rides).toHaveLength(1);
    expect(world.rides[0]).toMatchObject({
      pair: "USD/JPY", side: "BUY", status: "open", entry_bar: pg(times[I_BUY]), entry_closed_at: pg(closeOf(I_BUY)), entry_price: ask(closes[I_BUY]), entry_mid: closes[I_BUY],
      share0: shareOf(e.z, e.zside), reached_at: null,
    });
    // the state of the bar now forming, bit for bit the shared code's on the 599 closes before it
    expect(world.states).toHaveLength(1);
    expect(world.states[0]).toMatchObject({ pair: "USD/JPY", bar_time: iso(closeOf(I_BUY)), last_bar: iso(times[I_BUY]), source_read_at: null, ...stateOf(I_BUY + 1), writes: 1 });
    // email 1 to the follower whose lookup worked; the other has no row (and is not counted as a signal's row)
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`]);
    expect(world.sent[0].text).toContain(`\n買値（この足の終値の買値）: ${ask(closes[I_BUY]).toFixed(3)}`);
    expect(world.sent[0].text).toContain(`\n  MACD = ${e.z.m.toFixed(3)}、枠の上の端 = ${e.z.top.toFixed(3)}（その90% = ${(RIDE_IN_SHARE * e.z.top).toFixed(3)}、96% = ${(RIDE_OUT_SHARE * e.z.top).toFixed(3)}）`);
    expect(alertsOf(MACDH_RULE_ID)).toHaveLength(1);
    expect(alertsOf(MACDH_RULE_ID)[0]).toMatchObject({
      user_id: "userA", kind: "signal", pair: "USD/JPY", interval: "1h", bar_time: iso(times[I_BUY]), closed_at: iso(closeOf(I_BUY)), side: "BUY",
      entry: ask(closes[I_BUY]), stop: null, target: null, rule: MACDH_RULE_ID, status: "sent",
    });
    expect(s0).toMatchObject({ signals: 1, sent: 1, not_allowed: 1 });
    // the minute's look in the same run: the ride is followed at once (the forming bar, flat at its open, does not touch)
    expect(minuteOf(s0)).toMatchObject({ ride: true, forming: dt(closeOf(I_BUY)), state: "ok", open: 1, high: closes[I_BUY], low: closes[I_BUY], signals: [] });

    // minute 3, a fresh instance, the lookup working: the same bar judged again
    world.failPlanFor.clear();
    const s3 = await fresh(at(I_BUY, 3));
    expect(judged(s3)).toMatchObject({ signals: ["macdx:BUY"], ride: { rows: "ok", state: "ok", step: "in" } });
    expect(judged(s3)!.ride).not.toHaveProperty("unsent");
    expect(world.rides).toHaveLength(1);
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`, `userB: ${IN_SUBJECT("買い（BUY）")}`]);
    // the same numbers in both mails (the second written from the row the first run made)
    expect(world.sent[1].text).toBe(world.sent[0].text);
    expect(alertsOf(MACDH_RULE_ID).map((r) => r.user_id)).toEqual(["userA", "userB"]);
    // the state row written twice is the same row
    expect(world.states).toHaveLength(1);
    expect(world.states[0]).toMatchObject({ ...stateOf(I_BUY + 1), writes: 2 });

    // minute 5, another fresh instance: nothing new
    const s5 = await fresh(at(I_BUY, 5));
    expect(judged(s5)).toMatchObject({ signals: ["macdx:BUY"], ride: { step: "in" } });
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toHaveLength(2);
    expect(s5.sent ?? 0).toBe(0);
    clean();
  });

  it("the forming bar touches 96%: reached by one conditional patch, email 2 from the row to every follower once; the entry bar judged again after its ride was reached opens no second ride and sends no second email 1", async () => {
    world.subs = [follow("userA"), follow("userB")];
    await fresh(at(I_BUY, 0));
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`, `userB: ${IN_SUBJECT("買い（BUY）")}`]);
    // minute 1: the forming bar a thousandth short of the touch: nothing
    const x = touchPrice(I_BUY + 1, "top");
    world.forming.set(closeOf(I_BUY), { high: Number((x - 0.001).toFixed(3)), low: closes[I_BUY], close: Number((x - 0.002).toFixed(3)) });
    world.gmoCalls = 0;
    const s1 = await fresh(at(I_BUY, 1));
    expect(minuteOf(s1)).toMatchObject({ state: "ok", open: 1, high: Number((x - 0.001).toFixed(3)), signals: [] });
    expect(world.rides[0].status).toBe("open");
    // a minute not 0, 3 or 5: the chart is not read; GMO was asked for the forming bar's file alone (bid and ask)
    expect(judged(s1)).toBeUndefined();
    expect(world.gmoCalls).toBe(2);
    // minute 2: the high at the touch; the price now has come off a little (the bid a BUY leaves on)
    const now = Number((x - 0.004).toFixed(3));
    world.forming.set(closeOf(I_BUY), { high: x, low: closes[I_BUY], close: now });
    const s2 = await fresh(at(I_BUY, 2));
    expect(minuteOf(s2)).toMatchObject({ ride: true, forming: dt(closeOf(I_BUY)), state: "ok", open: 1, high: x, low: closes[I_BUY], signals: ["macdx-out:BUY"] });
    const touch = rideTouch(stateOf(I_BUY + 1), "top", x, closes[I_BUY])!;
    expect(world.rides).toHaveLength(1);
    expect(world.rides[0]).toMatchObject({
      status: "reached", reached_at: pg(at(I_BUY, 2)), reached_bar: pg(closeOf(I_BUY)), seen_price: bid(now), late: false, share1: touch.share,
    });
    expect(mails().slice(2)).toEqual([`userA: ${OUT_SUBJECT("買い")}`, `userB: ${OUT_SUBJECT("買い")}`]);
    const pips = ((bid(now) - ask(closes[I_BUY])) * 100).toFixed(1).replace("-", "−");
    expect(world.sent[2].text).toContain(`\n今の値段: ${bid(now).toFixed(3)}（売値）`);
    expect(world.sent[2].text).toContain(`\n1通目からの損益: ${pips.startsWith("−") ? pips : `+${pips}`} pips`);
    expect(world.sent[2].text).toContain("\n1通目からの時間: 2分");
    expect(world.sent[3].text).toBe(world.sent[2].text);
    // email 2's row: under the ride's ENTRY bar, closed_at when seen, the entry price, the price when seen as target
    expect(alertsOf(MACDH_OUT_RULE_ID)).toHaveLength(2);
    expect(alertsOf(MACDH_OUT_RULE_ID)[0]).toMatchObject({
      bar_time: iso(times[I_BUY]), closed_at: iso(at(I_BUY, 2)), side: "BUY", entry: ask(closes[I_BUY]), stop: null, target: bid(now), rule: MACDH_OUT_RULE_ID, status: "sent",
    });
    // minute 3 (the chart is read again, a fresh instance): the entry bar's own ride is reached; still "in", nothing new
    const s3 = await fresh(at(I_BUY, 3));
    expect(judged(s3)).toMatchObject({ signals: ["macdx:BUY"], ride: { rows: "ok", step: "in", caught: [] } });
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toHaveLength(4);
    // minutes 4 to 31: no second email 2, and nothing is read of GMO for a chart with no open ride
    world.gmoCalls = 0;
    for (const m of [4, 17, 31]) expect(minuteOf(await fresh(at(I_BUY, m)))).toBeUndefined();
    expect(world.gmoCalls).toBe(0);
    expect(world.sent).toHaveLength(4);
    expect(alertsOf(MACDH_OUT_RULE_ID)).toHaveLength(2);
    clean();
  });

  it("two runs reaching the same ride: one transition, the numbers of the run that made it in both runs' mails, one email 2 a follower; a follower whose lookup failed is mailed by a later run within the half hour, not after", async () => {
    world.subs = [follow("userA"), follow("userB")];
    await fresh(at(I_SELL, 0));
    expect(world.rides[0]).toMatchObject({ side: "SELL", status: "open", entry_price: bid(closes[I_SELL]) });
    const x = touchPrice(I_SELL + 1, "bottom");
    world.forming.set(closeOf(I_SELL), { high: closes[I_SELL], low: x, close: x });
    // this run reads the ride as open and sees the touch; before its patch lands another run has made the transition
    // (seen a moment earlier, at another price)
    const other = { reached_at: pg(at(I_SELL, 1) - 400), reached_bar: pg(closeOf(I_SELL)), seen_price: 149.555, late: false, share1: 0.9777 };
    world.onRidePatch = () => Object.assign(world.rides[0], { status: "reached", ...other });
    world.failPlanFor.add("userB");
    const s1 = await fresh(at(I_SELL, 1));
    expect(world.onRidePatch).toBeNull();
    // one transition: the other run's numbers stand, this run's patch changed nothing
    expect(world.rides).toHaveLength(1);
    expect(world.rides[0]).toMatchObject({ status: "reached", ...other });
    // and this run's email 2 is written from the row: the other run's price and time, not its own
    expect(mails().slice(2)).toEqual([`userA: ${OUT_SUBJECT("売り")}`]);
    expect(world.sent[2].text).toContain("\n今の値段: 149.555（買値）");
    expect(world.sent[2].text).not.toContain(ask(x).toFixed(3));
    expect(minuteOf(s1)).toMatchObject({ open: 1, signals: ["macdx-out:SELL"], unsent: ["out(not_allowed)"] });
    expect(alertsOf(MACDH_OUT_RULE_ID).map((r) => [r.user_id, r.closed_at, r.target])).toEqual([["userA", iso(at(I_SELL, 1) - 400), 149.555]]);
    // the next minute, a fresh instance: the follower whose lookup failed gets the same mail; the first gets no second
    world.failPlanFor.clear();
    const s2 = await fresh(at(I_SELL, 2));
    expect(mails().slice(3)).toEqual([`userB: ${OUT_SUBJECT("売り")}`]);
    expect(world.sent[3].text).toBe(world.sent[2].text);
    expect(minuteOf(s2)).toMatchObject({ open: 0, signals: ["macdx-out:SELL"] });
    // every later run: nothing more
    for (const m of [3, 4, 29]) await fresh(at(I_SELL, m));
    expect(world.sent).toHaveLength(4);
    expect(alertsOf(MACDH_OUT_RULE_ID)).toHaveLength(2);

    // a follower who comes after the half hour gets no email 2 of that ride
    world.subs.push(follow("userC"));
    await fresh(at(I_SELL, 31) + RIDE_OUT_FRESH_MS);
    expect(world.sent).toHaveLength(4);
    // one who comes within it gets email 2 alone (it names the entry bar and price, so it reads on its own)
    resetWorld();
    world.subs = [follow("userA")];
    await fresh(at(I_SELL, 0));
    world.forming.set(closeOf(I_SELL), { high: closes[I_SELL], low: x, close: x });
    await fresh(at(I_SELL, 1));
    world.subs.push(follow("userC"));
    await fresh(at(I_SELL, 2));
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("売り（SELL）")}`, `userA: ${OUT_SUBJECT("売り")}`, `userC: ${OUT_SUBJECT("売り")}`]);
    expect(world.sent[2].text).toContain(`で売り（SELL）。売値 ${bid(closes[I_SELL]).toFixed(3)}`);
    clean();
  });

  it("an entry while an older ride of the side is held is skipped; that ride reached in a LATER bar, the entry bar judged again is still skipped (a ride older than the newest 100 bars too)", async () => {
    world.subs = [follow("userA")];
    world.rides = [oldRide("SELL", I_HELD - 150)];
    const s0 = await fresh(at(I_HELD, 0));
    expect(judged(s0)).toMatchObject({ signals: [], ride: { rows: "ok", state: "ok", step: "skip", caught: [] } });
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toEqual([]);
    // the old ride is watched in the bar now forming
    expect(minuteOf(s0)).toMatchObject({ state: "ok", open: 1, signals: [] });
    // minute 1: it is reached, in the bar after the entry bar
    const x = touchPrice(I_HELD + 1, "bottom");
    world.forming.set(closeOf(I_HELD), { high: closes[I_HELD], low: x, close: x });
    await fresh(at(I_HELD, 1));
    expect(world.rides[0]).toMatchObject({ status: "reached", reached_bar: pg(closeOf(I_HELD)), late: false });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("売り")}`]);
    // email 2 names the OLD ride's entry bar, and is keyed on it
    expect(alertsOf(MACDH_OUT_RULE_ID)[0]).toMatchObject({ bar_time: iso(times[I_HELD - 150]), entry: bid(closes[I_HELD - 150]) });
    // minute 3, a fresh instance: the entry bar again. The old ride is reached now, but in a later bar: still skipped
    const s3 = await fresh(at(I_HELD, 3));
    expect(judged(s3)).toMatchObject({ signals: [], ride: { rows: "ok", step: "skip" } });
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toHaveLength(1);
    expect(alertsOf(MACDH_RULE_ID)).toEqual([]);
    // without the old ride the same bar is an entry (the check above can fail)
    resetWorld();
    world.subs = [follow("userA")];
    expect(judged(await fresh(at(I_HELD, 0)))).toMatchObject({ signals: ["macdx:SELL"], ride: { step: "in" } });
    clean();
  });

  it("a ride reached in bar k, found at k's close, and bar k a new entry on that side: email 2 (seen late), then email 1 for the new ride", async () => {
    // an older BUY, held from 5 bars before; bar I_BUY's high (a wick) touches 96% while its close is a new entry
    const older = I_BUY - 5;
    const wick = touchPrice(I_BUY, "top");
    world.wicks.set(times[I_BUY], { high: wick });
    expect(wick).toBeGreaterThan(closes[I_BUY]);
    const bars = Array.from({ length: I_BUY + 1 }, (_, k) => (k === I_BUY ? { ...plainBar(k), high: wick } : plainBar(k)));
    expect(rideCatchUp(bars, "top", times[older])).toMatchObject({ bar: times[I_BUY], newest: true });
    world.subs = [follow("userA")];
    world.rides = [oldRide("BUY", older)];
    const s0 = await fresh(at(I_BUY, 0));
    expect(judged(s0)).toMatchObject({
      signals: ["macdx-out:BUY", "macdx:BUY"],
      ride: { rows: "ok", step: "in", caught: [{ side: "BUY", entry_bar: iso(times[older]), reached_bar: iso(times[I_BUY]) }] },
    });
    // email 2 first, then email 1
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("買い")}`, `userA: ${IN_SUBJECT("買い（BUY）")}`]);
    // the old ride: reached in bar k, seen late, at the newest closed bar's bid
    expect(world.rides).toHaveLength(2);
    expect(world.rides[0]).toMatchObject({ entry_bar: pg(times[older]), status: "reached", reached_bar: pg(times[I_BUY]), reached_at: pg(at(I_BUY, 0)), late: true, seen_price: bid(closes[I_BUY]) });
    expect(world.sent[0].text).toContain("\n2026-10-12 18:00〜19:00（日本時間）の足の間に届いていました。その時は読めず、今見つけました（2026-10-12 19:00、日本時間）");
    expect(world.sent[0].text).toContain(`\n今の値段: ${bid(closes[I_BUY]).toFixed(3)}（最新の確定足の終値の売値）`);
    // the new ride of the same side: open, and the two rows of the two mails do not meet (other bar, other rule)
    expect(world.rides[1]).toMatchObject({ entry_bar: pg(times[I_BUY]), side: "BUY", status: "open" });
    expect(world.alerts.map((r) => [r.rule, r.bar_time])).toEqual([[MACDH_OUT_RULE_ID, iso(times[older])], [MACDH_RULE_ID, iso(times[I_BUY])]]);
    // judged again by a fresh instance: the same, nothing twice
    const s3 = await fresh(at(I_BUY, 3));
    expect(judged(s3)).toMatchObject({ signals: ["macdx:BUY"], ride: { step: "in", caught: [] } });
    expect(world.rides).toHaveLength(2);
    expect(world.sent).toHaveLength(2);
    clean();
  });

  it("an entry bar already at 96%: the notice, once; and no notice when a ride of the side was reached in that very bar (its email 2 says the same)", async () => {
    world.subs = [follow("userA")];
    const s0 = await fresh(at(I_NOTICE, 0));
    expect(judged(s0)).toMatchObject({ signals: ["macdx-at:SELL"], ride: { rows: "ok", state: "ok", step: "at", caught: [] } });
    expect(mails()).toEqual([`userA: ${AT_SUBJECT}`]);
    // a notice opens no ride; its row is the bar's, under its own id, the bar's close as "entry"
    expect(world.rides).toEqual([]);
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({ rule: MACDH_AT_RULE_ID, bar_time: iso(times[I_NOTICE]), closed_at: iso(closeOf(I_NOTICE)), side: "SELL", entry: closes[I_NOTICE], stop: null, target: null });
    expect(minuteOf(s0)).toBeUndefined();
    for (const m of [3, 5]) expect(judged(await fresh(at(I_NOTICE, m)))).toMatchObject({ signals: ["macdx-at:SELL"], ride: { step: "at" } });
    expect(world.sent).toHaveLength(1);

    // quiet: an older SELL is held, and the bar that closes already at 96% is the bar it is reached in
    resetWorld();
    let older = 0;
    const bars = Array.from({ length: I_QUIET + 1 }, (_, k) => plainBar(k));
    for (let back = 2; back < 40 && older === 0; back++) if (rideCatchUp(bars, "bottom", times[I_QUIET - back])?.bar === times[I_QUIET]) older = I_QUIET - back;
    expect(older).toBeGreaterThan(0);
    world.subs = [follow("userA")];
    world.rides = [oldRide("SELL", older)];
    const q0 = await fresh(at(I_QUIET, 0));
    expect(judged(q0)).toMatchObject({ signals: ["macdx-out:SELL"], ride: { step: "quiet", caught: [{ side: "SELL", reached_bar: iso(times[I_QUIET]) }] } });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("売り")}`]);
    expect(alertsOf(MACDH_AT_RULE_ID)).toEqual([]);
    // judged again: still quiet
    expect(judged(await fresh(at(I_QUIET, 3)))).toMatchObject({ ride: { step: "quiet", caught: [] } });
    expect(world.sent).toHaveLength(1);
    clean();
  });

  it("emails 1 and 2 in the same run, email 1 first, when the bar after the entry touches 96% at its open", async () => {
    world.subs = [follow("userA")];
    const s0 = await fresh(at(I_AT_ONCE, 0));
    expect(judged(s0)).toMatchObject({ signals: ["macdx:SELL"], ride: { step: "in" } });
    expect(minuteOf(s0)).toMatchObject({ state: "ok", open: 1, signals: ["macdx-out:SELL"] });
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("売り（SELL）")}`, `userA: ${OUT_SUBJECT("売り")}`]);
    // in at the bid, out at the ask a second later: minus the spread
    expect(world.rides[0]).toMatchObject({ status: "reached", late: false, reached_bar: pg(closeOf(I_AT_ONCE)), entry_price: bid(closes[I_AT_ONCE]), seen_price: ask(closes[I_AT_ONCE]) });
    expect(world.sent[1].text).toContain("\n1通目からの損益: −1.0 pips");
    expect(world.sent[1].text).toContain("\n1通目からの時間: 1分未満");
    expect(s0).toMatchObject({ signals: 2, sent: 2 });
    // minute 3: the entry bar again, its ride reached in the next bar: no new ride, no mail
    expect(judged(await fresh(at(I_AT_ONCE, 3)))).toMatchObject({ ride: { step: "in" } });
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toHaveLength(2);
    clean();
  });

  it("an instance kept warm does what fresh ones do from the tables: its memory is a copy (the hour's state), never the only one", async () => {
    const x = touchPrice(I_BUY + 1, "top");
    const scenario = async (warm: boolean) => {
      resetWorld();
      world.subs = [follow("userA"), follow("userB")];
      let h = await instance();
      const run = async (minute: number) => {
        if (!warm) h = await instance();
        return sweep(h, at(I_BUY, minute));
      };
      const records = [await run(0), await run(1)];
      world.forming.set(closeOf(I_BUY), { high: x, low: closes[I_BUY], close: Number((x - 0.004).toFixed(3)) });
      records.push(await run(2), await run(3), await run(4));
      return {
        rides: world.rides.map((r) => ({ ...r })),
        states: world.states.map(({ writes: _w, ...r }) => r),
        alerts: world.alerts.map(({ id: _i, n: _n, provider_id: _p, sent_at: _s, ...r }) => r),
        sent: world.sent.map((m) => ({ ...m })),
        minutes: records.map((r) => minuteOf(r) ?? null),
      };
    };
    const fromTables = await scenario(false);
    const kept = await scenario(true);
    expect(fromTables.sent.map((m) => `${m.to.split("@")[0]}: ${m.subject}`)).toEqual([
      `userA: ${IN_SUBJECT("買い（BUY）")}`, `userB: ${IN_SUBJECT("買い（BUY）")}`, `userA: ${OUT_SUBJECT("買い")}`, `userB: ${OUT_SUBJECT("買い")}`,
    ]);
    expect(kept).toEqual(fromTables);
    // the warm instance read the hour's state from its own copy: with the row gone it still judges, a fresh one does not
    resetWorld();
    world.subs = [follow("userA")];
    const h = await instance();
    await sweep(h, at(I_BUY, 0));
    world.states = [];
    expect(minuteOf(await sweep(h, at(I_BUY, 1)))).toMatchObject({ state: "ok", open: 1 });
    expect(minuteOf(await fresh(at(I_BUY, 2)))).toMatchObject({ state: null, open: 1 });
    clean();
  });

  it("a touch in an hour nothing was read (no run after the entry's): found by the next close's catch-up, seen late, at that close's price", async () => {
    world.subs = [follow("userA")];
    await fresh(at(I_BUY, 0));
    // the bar after the entry bar touches at some time in its hour; no run sees it forming
    const x = touchPrice(I_BUY + 1, "top");
    world.wicks.set(times[I_BUY + 1], { high: Math.max(x, closes[I_BUY + 1]) });
    const s = await fresh(at(I_BUY + 1, 0));
    expect(judged(s)!.ride).toMatchObject({ rows: "ok", caught: [{ side: "BUY", entry_bar: iso(times[I_BUY]), reached_bar: iso(times[I_BUY + 1]) }] });
    expect(world.rides[0]).toMatchObject({ status: "reached", late: true, reached_bar: pg(times[I_BUY + 1]), reached_at: pg(at(I_BUY + 1, 0)), seen_price: bid(closes[I_BUY + 1]) });
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`, `userA: ${OUT_SUBJECT("買い")}`]);
    expect(world.sent[1].text).toContain("その時は読めず、今見つけました");
    expect(world.sent[1].text).toContain("\n1通目からの時間: 60分");
    // the state of the hour before is still kept (rows are dropped after eight days), the new hour's beside it
    expect(world.states.map((r) => r.bar_time)).toEqual([iso(closeOf(I_BUY)), iso(closeOf(I_BUY + 1))]);
    clean();
  });

  it("an hour with no state row is not judged from the bars (state: null), and GMO is not asked", async () => {
    world.subs = [follow("userA")];
    await fresh(at(I_BUY, 0));
    world.states = [];
    world.forming.set(closeOf(I_BUY), { high: touchPrice(I_BUY + 1, "top"), low: closes[I_BUY], close: closes[I_BUY] });
    world.gmoCalls = 0;
    const s = await fresh(at(I_BUY, 1));
    expect(minuteOf(s)).toMatchObject({ ride: true, forming: null, state: null, open: 1, high: null, low: null, signals: [] });
    expect(world.gmoCalls).toBe(0);
    expect(world.rides[0].status).toBe("open");
    // no big row was read for it
    expect(world.reads.filter((r) => r.startsWith("gmo_kline_files") || r.startsWith("live_chart_fallback"))).toEqual(["gmo_kline_files price_type,date_key,body"]);
    clean();
  });

  it("the rides' table unread (not there): nothing of the ride is done, the record says so, and the other rules' judgment is as it was", async () => {
    world.subs = [follow("userA"), follow("userA", "ultra")];
    world.ridesStatus = 404;
    const s0 = await fresh(at(I_BUY, 0));
    const read = (s0.reads ?? []).find((r) => r.pair === "USD/JPY" && r.interval === "1h" && r.bars !== undefined)!;
    expect(read).toMatchObject({ bars: 600, newest: iso(times[I_BUY]), ride: { rows: "unread" } });
    expect(read.signals!.filter((x) => x.startsWith("macdx"))).toEqual([]);
    expect((s0.reads ?? []).filter((r) => r.ride === true)).toEqual([{ interval: "1h", ride: true, error: "rides_unread" }]);
    expect(world.states).toEqual([]);
    expect(world.sent.filter((m) => m.subject.includes("MACD"))).toEqual([]);
    expect(s0.ok).toBe(true);
    clean();
  });

  it("nobody follows the chart under 'macdx': nothing of the ride is read or written, whatever else it is followed under", async () => {
    world.subs = [follow("userA", "ultra"), follow("userA", "spike")];
    world.rides = [oldRide("BUY", I_BUY - 5)];
    const s0 = await fresh(at(I_BUY, 0));
    const read = (s0.reads ?? []).find((r) => r.pair === "USD/JPY" && r.interval === "1h" && r.bars !== undefined)!;
    expect(read.ride).toBeUndefined();
    expect((s0.reads ?? []).filter((r) => r.ride === true)).toEqual([]);
    expect(world.reads.filter((r) => r.startsWith("macd_"))).toEqual([]);
    expect(world.states).toEqual([]);
    expect(world.rides[0].status).toBe("open");
    clean();
  });

  it("the forming bar's GMO read is shared with the sharp rise: one read of it a run, whichever of the two needs it", async () => {
    world.subs = [follow("userA"), follow("userA", "spike")];
    await fresh(at(I_BUY, 0));
    expect(world.rides[0].status).toBe("open");
    // minute 7 (the chart is not read): the sharp rise and the ride both look at the forming bar
    world.gmoCalls = 0;
    const s7 = await fresh(at(I_BUY, 7));
    expect((s7.reads ?? []).find((r) => r.spike === true)).toMatchObject({ pair: "USD/JPY", forming: dt(closeOf(I_BUY)) });
    expect(minuteOf(s7)).toMatchObject({ state: "ok", open: 1, forming: dt(closeOf(I_BUY)) });
    // GMO: the newest file once, bid and ask
    expect(world.gmoCalls).toBe(2);
    clean();
  });
});

describe("#397 gold in the function: Twelve Data's stored bars at the close, the recorded minutes each minute", () => {
  // gold's bars: the same waves at gold's size, rounded to cents, as its stored 1-hour bars are
  const gcloses = Array.from({ length: N }, (_, i) => Number((4150 + 240 * wave(i)).toFixed(2)));
  const gEntry = (i: number) => rideEntryAt(gcloses.slice(i - 599, i + 1));
  const gState = (j: number) => rideStateOf(gcloses.slice(j - 599, j))!;
  // an entry (not already) whose next hour does not touch 96% at the entry bar's close price
  let G = 0;
  for (let i = 700; i < N - 3 && G === 0; i++) {
    const e = gEntry(i);
    if (e && !e.already && times[i + 1] - times[i] === H && rideTouch(gState(i + 1), e.zside, gcloses[i], gcloses[i]) === null) G = i;
  }
  const stored = (i: number, readAt: number) => ({
    bars: Array.from({ length: 700 }, (_, n) => {
      const k = i - 699 + n;
      const open = gcloses[k - 1];
      return { datetime: dt(times[k]), open, high: Math.max(open, gcloses[k]), low: Math.min(open, gcloses[k]), close: gcloses[k] };
    }),
    fetched_at: iso(readAt),
  });
  const minute = (t: number, high: number, low: number, close: number): Row => ({ minute: pg(t), open: close, high, low, close });

  let captured: Handler | null = null;
  const realSetTimeout = globalThis.setTimeout;
  beforeAll(() => {
    vi.stubGlobal("Deno", {
      env: { get: (k: string) => ({ SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc", RESEND_API_KEY: "re_test" } as Record<string, string>)[k] },
      serve: (h: Handler) => {
        captured = h;
      },
    });
    vi.stubGlobal("fetch", fakeFetch);
    vi.stubGlobal("setTimeout", (fn: () => void, ms?: number) => {
      clock += Math.max(0, ms ?? 0);
      return realSetTimeout(fn, 0);
    });
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const signal = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
    if (typeof signal.timeout !== "function") signal.timeout = () => new AbortController().signal;
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => resetWorld());
  const INDEX = "../../supabase/functions/signal-alerts/index.ts";
  const fresh = async (at: number): Promise<Summary> => {
    vi.resetModules();
    captured = null;
    await import(/* @vite-ignore */ INDEX);
    clock = at;
    const res = await captured!(new Request("https://fn.test/signal-alerts", { method: "POST", headers: { "x-sweep-token": "tok", "Content-Type": "application/json" }, body: JSON.stringify({ mode: "indicators" }) }));
    const text = await res.text();
    for (const no of ["userA", "example.test", "alert-", "user_id"]) expect(text, no).not.toContain(no);
    return JSON.parse(text) as Summary;
  };

  it("email 1 at the close from the stored bars (the bar's close as the price), the state kept with the read it was made from; email 2 from the hour's recorded minutes, in dollars", async () => {
    expect(G).toBeGreaterThan(0);
    const e = gEntry(G)!;
    const close = times[G] + H;
    world.subs = [{ user_id: "userA", pair: "XAU/USD", interval: "1h", lang: "ja", rule: "macdx" }];
    // minute 0: Twelve Data's bar is not read before a minute past the close: gold is not judged, no state yet
    world.gold = stored(G - 1, times[G] + 61_000);
    await fresh(close + 1_000);
    expect(world.rides).toEqual([]);
    expect(world.states).toEqual([]);
    // minute 1: the stored read holds the closed bar
    world.gold = stored(G, close + 61_000);
    world.goldMinutes = [minute(close, gcloses[G] + 0.4, gcloses[G] - 0.4, gcloses[G]), minute(close + MIN, gcloses[G] + 0.3, gcloses[G] - 0.2, gcloses[G] + 0.1)];
    const s1 = await fresh(close + MIN + 2_000);
    const j = (s1.reads ?? []).find((r) => r.pair === "XAU/USD" && r.twelve === true)!;
    expect(j).toMatchObject({ newest: iso(times[G]), ride: { rows: "ok", state: "ok", step: "in", caught: [] } });
    expect(j.signals!.filter((x) => x.startsWith("macdx"))).toEqual([`macdx:${e.side}`]);
    expect(world.rides).toHaveLength(1);
    // one price: the bar's close is the price paid
    expect(world.rides[0]).toMatchObject({ pair: "XAU/USD", side: e.side, status: "open", entry_bar: pg(times[G]), entry_price: gcloses[G], entry_mid: gcloses[G], share0: shareOf(e.z, e.zside) });
    expect(world.states).toHaveLength(1);
    expect(world.states[0]).toMatchObject({ pair: "XAU/USD", bar_time: iso(close), last_bar: iso(times[G]), source_read_at: iso(close + 61_000), ...gState(G + 1) });
    expect(world.sent.map((m) => m.subject)).toEqual([`【Sextant】金 1時間足 ${e.side === "BUY" ? "買い（BUY）" : "売り（SELL）"}で入る合図（MACD の流れ・1通目）`]);
    expect(world.sent[0].text).toContain(`\nこの足の終値: ${gcloses[G].toFixed(2)}`);
    expect(world.sent[0].text).toContain("金では、この決まりを測っていません。");
    // the minute's look in the same run: the hour's two minutes, their extremes (no touch yet)
    const m1 = (s1.reads ?? []).find((r) => r.pair === "XAU/USD" && r.ride === true)!;
    expect(m1).toMatchObject({ state: "ok", open: 1, high: Number((gcloses[G] + 0.4).toFixed(2)), low: Number((gcloses[G] - 0.4).toFixed(2)), signals: [] });
    // minute 2: a minute whose extreme touches 96%; the newest minute's close is the price when seen
    const top = e.zside === "top";
    let x = gcloses[G];
    while (rideTouch(gState(G + 1), e.zside, x, x) === null) x = Number((x + (top ? 0.01 : -0.01)).toFixed(2));
    const seen = Number((x + (top ? -0.5 : 0.5)).toFixed(2));
    world.goldMinutes.push(minute(close + 2 * MIN, top ? x : seen, top ? seen : x, seen));
    const s2 = await fresh(close + 2 * MIN + 2_000);
    expect((s2.reads ?? []).find((r) => r.pair === "XAU/USD" && r.ride === true)).toMatchObject({ open: 1, signals: [`macdx-out:${e.side}`] });
    expect(world.rides[0]).toMatchObject({ status: "reached", late: false, reached_bar: pg(close), seen_price: seen });
    expect(world.sent).toHaveLength(2);
    const dollars = Math.abs(seen - gcloses[G]).toFixed(2);
    const gain = top ? seen > gcloses[G] : seen < gcloses[G];
    expect(world.sent[1].subject).toBe(`【Sextant】金 1時間足 96%に届きました（MACD の流れ・2通目、${e.side === "BUY" ? "買い" : "売り"}の分）`);
    expect(world.sent[1].text).toContain(`\n今の値段: ${seen.toFixed(2)}（Swissquote の値段）`);
    expect(world.sent[1].text).toContain(`\n1通目からの損益: ${gain ? "+" : "−"}${dollars}ドル`);
    expect(world.sent[1].text).toContain("金の損益は、スプレッドを含みません。1通目の値段は Twelve Data の足の終値、今の値段は Swissquote の値段で、配信が別です。");
    // the entry bar judged again each minute to :29 by fresh instances: one ride, two mails
    for (const m of [3, 4, 29]) await fresh(close + m * MIN + 2_000);
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toHaveLength(2);
    expect(world.unrouted).toEqual([]);
  });
});

describe("#397 the function's code, read as text", () => {
  const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
  it("is v39; the ride is judged in its own try / catch after the other rules' mails; a ride is reached by a patch of a row still open", () => {
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v39-2026-11-12T12:00:00Z";');
    expect(fn).toMatch(/if \(sigs\.length > 0\) await mailSignals\(sigs\);[\s\S]{0,700}try \{\s+await rideAtClose\(pair, closed, newest, said\);\s+\} catch \(err\) \{\s+console\.error\("macdx failed:", pair, interval, errText\(err\)\);/);
    expect(fn).toMatch(/try \{\s+const read = await rideMinute\(pair, mine\);\s+if \(read\) reads\.push\(read\);\s+\} catch \(err\) \{\s+console\.error\("macdx ride failed:", pair, errText\(err\)\);/);
    // the ride's catches log a text with every URL taken out (a lookup's URL holds a follower's id), in both runs
    expect(fn).toContain('console.error("macdx rides failed:", errText(err));');
    expect(fn).toContain('(err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/https?:\\/\\/\\S+/g, "(url)");');
    expect(fn).toContain("const res = await rest(`macd_rides?${rideKey(ride)}&status=eq.open&select=${MACD_RIDE_COLUMNS}`, {");
    expect(fn).toContain('headers: { Prefer: "return=representation" },');
    expect(fn).toContain('const res = await rest("macd_rides?on_conflict=pair,side,entry_bar", {');
    expect(fn).toContain('rest("macd_ride_state?on_conflict=pair,bar_time", {');
    // every mail's row under its own id, by the signal
    expect(fn).toContain("...signalRow(sig),");
    expect(fn).not.toContain("rule: indicatorRuleId(sig.rule),");
    // the rides are never deleted, nor is anything of a follower logged with them
    expect(fn).not.toMatch(/macd_rides[^\n]*\n?[^\n]*method: "DELETE"/);
    for (const line of fn.split("\n").filter((l) => l.includes("console.error") && /macd ride|macdx/.test(l))) expect(line, line).not.toMatch(/user_id|email|\bid\b/);
    // the charts and the subscriptions are as they were
    expect(fn).toContain("macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS },");
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm,spike)&select=user_id,pair,interval,lang,rule")');
    expect([...MACDH_PAIRS]).toEqual(["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "XAU/USD"]);
  });

  it("the tables the function writes are the migration's, column for column", () => {
    const mig = readFileSync("supabase/migrations/20261112120000_macd_rides.sql", "utf8");
    expect(mig).toContain("create table if not exists public.macd_rides (");
    expect(mig).toContain("create table if not exists public.macd_ride_state (");
    for (const col of MACD_RIDE_COLUMNS.split(",")) expect(mig, col).toMatch(new RegExp(`\\n  ${col} `));
    for (const col of ["e12", "e26", "sig", "top119", "bottom119", "last_bar", "source_read_at", "bar_time"]) expect(mig, col).toMatch(new RegExp(`\\n  ${col} `));
    expect(mig).toContain("primary key (pair, side, entry_bar)");
    expect(mig).toContain("on public.macd_rides (pair, side) where status = 'open'");
    expect(mig).toContain("primary key (pair, bar_time)");
  });
});
