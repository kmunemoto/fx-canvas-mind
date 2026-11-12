// #391 (docs §8.134): the MACD email on shares (signal-alerts v35) — the 22 shares' hourly bars from Yahoo, each
// session's bar closes (Tokyo's lunch break and closing auction, New York's 16:00, daylight saving), when a bar is in,
// the run's steps — and its tab in the settings.
// #397 (docs §8.150; research/macdride-spec.md sections 2, 6, 7 and 8): from v39 that email is the ride of the pairs'
// MACD email, judged at 1-hour closes: the three rule ids, what a read of a share's bars does (the rides reached by a
// CLOSE, late or not; the close step at the newest closed bar), the three mails' texts, and the "stocks" run of the
// REAL supabase/functions/signal-alerts/index.ts replayed over fake tables (Yahoo, Supabase's REST, the auth lookup
// and Resend faked, the clock and the sleeps too: nothing waits and nothing reaches the network), each import of the
// module one fresh instance. The rule itself (rideEntryAt, rideCloseStep, rideCatchUpByClose) is checked in
// src/test/macd-ride.test.ts, the pairs' and gold's run in src/test/macd-ride-alerts.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { normalizeAlertSettings } from "../lib/signalAlerts";
import {
  STOCKMACD_AT_RULE_ID,
  STOCKMACD_INTERVALS,
  STOCKMACD_OUT_RULE_ID,
  STOCKMACD_PAIRS,
  STOCKMACD_RIDE_VERSION,
  STOCKMACD_RULE_ID,
  STOCK_FRESH_MS,
  type StockBar,
  localOf,
  renderStockMail,
  stockBarBreak,
  stockBarEnd,
  stockBarFresh,
  stockBarsOf,
  stockCloseDue,
  stockRideClose,
  stockRidePnl,
  stockRidesReached,
  stockSweepOf,
} from "../../supabase/functions/signal-alerts/stocks";
import {
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  MACD_RIDE_COLUMNS,
  indicatorRuleId,
  isIndicatorChartFor,
  isIndicatorRule,
  macdRideOf,
  renderIndicatorMail,
  rideCloseSignal,
  rideOutSignal,
  rideSignalTag,
  signalRow,
  type IndicatorSignal,
} from "../../supabase/functions/signal-alerts/indicators";
import { renderTestMail } from "../../supabase/functions/signal-alerts/logic";
import {
  RIDE_CATCHUP_BARS,
  RIDE_IN_SHARE,
  RIDE_OUT_SHARE,
  atShare,
  rideCatchUp,
  rideEntryAt,
  rideRuleId,
  rideZoneAt,
  shareOf,
  type RideEntry,
  type RideRow,
} from "../../supabase/functions/_shared/macd-ride";
import { JP_STOCKS, US_STOCKS } from "../lib/stocks";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);
const MIN = 60_000;
const H = 60 * MIN;
const at = (iso: string) => Date.parse(iso);

describe("#391 when a share's hourly bar closes (signal-alerts/stocks.ts)", () => {
  it("is the chart's list of shares, on the 1-hour chart, under its own ids: one a mail of the ride, built from its constants", () => {
    expect([...STOCKMACD_PAIRS]).toEqual([...US_STOCKS, ...JP_STOCKS].map((s) => s.symbol));
    expect([...STOCKMACD_INTERVALS]).toEqual(["1h"]);
    // #397: the ride's three ids (email 1, the notice, email 2). They start as the app reads the rule back from them,
    // and the 95% email's (…_z95of120_v1) is not among them
    expect(STOCKMACD_RIDE_VERSION).toBe(2);
    expect(STOCKMACD_RULE_ID).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2");
    expect(STOCKMACD_AT_RULE_ID).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_at_v2");
    expect(STOCKMACD_OUT_RULE_ID).toBe("stockmacd_12_26_9_w600_1h_ride90to96of120_out_v2");
    expect([STOCKMACD_RULE_ID, STOCKMACD_AT_RULE_ID, STOCKMACD_OUT_RULE_ID]).toEqual((["in", "at", "out"] as const).map((m) => rideRuleId("stockmacd", m, 2)));
    for (const id of [STOCKMACD_RULE_ID, STOCKMACD_AT_RULE_ID, STOCKMACD_OUT_RULE_ID]) {
      expect(id.startsWith("stockmacd")).toBe(true);
      expect(id).not.toContain("z95of120");
    }
    expect(INDICATOR_RULES).toContain("stockmacd");
    expect(isIndicatorRule("stockmacd")).toBe(true);
    // indicatorRuleId gives email 1's; each mail's row is written under its own (signalRow, below)
    expect(indicatorRuleId("stockmacd")).toBe(STOCKMACD_RULE_ID);
    expect(isIndicatorChartFor("stockmacd", "AAPL", "1h")).toBe(true);
    expect(isIndicatorChartFor("stockmacd", "7203.T", "1h")).toBe(true);
    expect(isIndicatorChartFor("stockmacd", "IBM", "1h")).toBe(false);
    expect(isIndicatorChartFor("stockmacd", "AAPL", "15min")).toBe(false);
    expect(isIndicatorChartFor("stockmacd", "USD/JPY", "1h")).toBe(false);
    // the FX rules do not take a share
    expect(isIndicatorChartFor("macdx", "AAPL", "1h")).toBe(false);
    expect(isIndicatorChartFor("ultra", "AAPL", "1h")).toBe(false);
  });

  it("is due in the half hour after a session's close, New York's with daylight saving, Tokyo's with the lunch break", () => {
    // Friday 2026-10-30 (New York on daylight time, UTC−4): 10:30 local = 14:30 UTC
    expect(stockCloseDue("AAPL", at("2026-10-30T14:31:20Z"))).toBe(at("2026-10-30T14:30:00Z"));
    expect(stockCloseDue("AAPL", at("2026-10-30T15:00:00Z"))).toBe(at("2026-10-30T14:30:00Z"));
    // 16:00 local, the last
    expect(stockCloseDue("AAPL", at("2026-10-30T20:05:00Z"))).toBe(at("2026-10-30T20:00:00Z"));
    // 9:45 local: nothing has closed yet today
    expect(stockCloseDue("AAPL", at("2026-10-30T13:45:00Z"))).toBeNull();
    // Monday 2026-11-02 (standard time, UTC−5): 10:30 local = 15:30 UTC, not 14:30
    expect(stockCloseDue("AAPL", at("2026-11-02T14:35:00Z"))).toBeNull();
    expect(stockCloseDue("AAPL", at("2026-11-02T15:31:00Z"))).toBe(at("2026-11-02T15:30:00Z"));
    // Saturday
    expect(stockCloseDue("AAPL", at("2026-10-31T14:31:00Z"))).toBeNull();
    // Tokyo, Monday 2026-11-02: 10:00, 11:30 (the morning's end), 13:00, 15:30 JST
    expect(stockCloseDue("7203.T", at("2026-11-02T01:00:30Z"))).toBe(at("2026-11-02T01:00:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T02:35:00Z"))).toBe(at("2026-11-02T02:30:00Z"));
    // 12:05 JST: 35 minutes after the morning's end, nothing due
    expect(stockCloseDue("7203.T", at("2026-11-02T03:05:00Z"))).toBeNull();
    expect(stockCloseDue("7203.T", at("2026-11-02T04:00:00Z"))).toBe(at("2026-11-02T04:00:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T06:45:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
    expect(stockCloseDue("7203.T", at("2026-11-02T07:01:00Z"))).toBeNull();
  });

  it("ends each bar where the session does: Tokyo's 11:00 and 15:00 bars, New York's 15:30, an early close", () => {
    expect(stockBarEnd("AAPL", at("2026-10-30T19:30:00Z"))).toBe(at("2026-10-30T20:00:00Z"));
    expect(stockBarEnd("AAPL", at("2026-10-30T18:30:00Z"))).toBe(at("2026-10-30T19:30:00Z"));
    expect(stockBarEnd("AAPL", at("2026-11-02T20:30:00Z"))).toBe(at("2026-11-02T21:00:00Z"));
    expect(stockBarEnd("7203.T", at("2026-11-02T02:00:00Z"))).toBe(at("2026-11-02T02:30:00Z"));
    expect(stockBarEnd("7203.T", at("2026-11-02T06:00:00Z"))).toBe(at("2026-11-02T06:30:00Z"));
    // the bar stamped 12:00 JST runs 12:30-13:00
    expect(stockBarEnd("7203.T", at("2026-11-02T03:00:00Z"))).toBe(at("2026-11-02T04:00:00Z"));
    // a session that ends at 13:00 local (a half day): its 12:30 bar ends then
    expect(stockBarEnd("AAPL", at("2026-11-27T17:30:00Z"), at("2026-11-27T18:00:00Z"))).toBe(at("2026-11-27T18:00:00Z"));
  });

  // Intel's hourly bars of Friday 2026-10-30 as Yahoo answered (live-chart's stocks.test.tsx), and the same day while
  // it was trading (the last bar forming)
  const intc = (marketTime: number, n = 8, end = 1793390400) => ({
    chart: {
      result: [{
        meta: { symbol: "INTC", gmtoffset: -14400, regularMarketPrice: 65.76, regularMarketTime: marketTime, currentTradingPeriod: { regular: { start: 1793367000, end } } },
        timestamp: [1793367000, 1793370600, 1793374200, 1793377800, 1793381400, 1793385000, 1793388600, 1793390400].slice(0, n),
        indicators: {
          quote: [{
            open: [68.35, 65.94, 65.9796, 64.755, 64.38, 63.7839, 63.875, 65.76].slice(0, n),
            high: [68.76, 67.41, 66.0974, 65.0, 64.3995, 64.2, 65.88, 65.76].slice(0, n),
            low: [64.12, 65.6301, 64.26, 64.105, 63.5, 63.2001, 63.58, 65.76].slice(0, n),
            close: [65.94, 65.9725, 64.7599, 64.385, 63.785, 63.875, 65.88, 65.76].slice(0, n),
          }],
        },
      }],
    },
  });

  it("takes a bar as closed once Yahoo has priced past its end, the last of the session on the closing auction's price", () => {
    // 16:01 local: the closing point is in and joined to the 15:30 bar; every bar closed
    const after = stockBarsOf("INTC", intc(1793390401), at("2026-10-30T20:01:00Z"))!;
    expect(after.bars).toHaveLength(7);
    expect(after.bars.every((b) => b.closed)).toBe(true);
    expect(after.bars[6]).toMatchObject({ datetime: "2026-10-30 19:30:00", close: 65.76, end: at("2026-10-30T20:00:00Z") });
    // 16:00:30 local, Yahoo's last trade 15:59:58 and no closing point yet: the 15:30 bar is not in
    const before = stockBarsOf("INTC", intc(1793390398, 7), at("2026-10-30T20:00:30Z"))!;
    expect(before.bars).toHaveLength(7);
    expect(before.bars[6].closed).toBe(false);
    expect(before.bars[5].closed).toBe(true);
    expect(before.bars[6].close).toBe(65.88);
    // rounded as the chart's history (2 decimals)
    expect(after.bars[2].open).toBe(65.98);
    expect(stockBarsOf("INTC", null, at("2026-10-30T20:01:00Z"))).toBeNull();
  });

  it("judges the newest closed bar once, is done when the bar due is in, and skips a day with no bars", () => {
    const bars = stockBarsOf("INTC", intc(1793390401), at("2026-10-30T20:01:00Z"))!.bars;
    const due = at("2026-10-30T20:00:00Z");
    const first = stockSweepOf("INTC", bars, due, undefined, at("2026-10-30T20:01:00Z"));
    expect(first).toMatchObject({ judge: true, done: true, noSession: false });
    expect(first.newest!.datetime).toBe("2026-10-30 19:30:00");
    // the closed bars are handed on; with fewer than 600 of them there is no entry to mail
    expect(first.closed).toHaveLength(7);
    expect(first.fresh).toBe(true);
    expect(stockRideClose("INTC", first.closed, [], at("2026-10-30T20:01:00Z"))).toMatchObject({ fresh: true, entry: null, step: { step: null } });
    expect(stockRidesReached("INTC", first.closed, [{ side: "BUY", entryBar: first.closed[0].open_ms, status: "open", reachedBar: null }], at("2026-10-30T20:01:00Z"))).toEqual([]);
    const again = stockSweepOf("INTC", bars, due, first.newest!.open_ms, at("2026-10-30T20:02:00Z"));
    expect(again.judge).toBe(false);
    // the bar due (16:00) not in yet: judged what is, not done
    const early = stockBarsOf("INTC", intc(1793390398, 7), at("2026-10-30T20:00:30Z"))!.bars;
    const wait = stockSweepOf("INTC", early, due, undefined, at("2026-10-30T20:00:30Z"));
    expect(wait.done).toBe(false);
    expect(wait.newest!.datetime).toBe("2026-10-30 18:30:00");
    // Monday 10:30 New York with the newest bar Friday's (a holiday): nothing to do that close
    const holiday = stockSweepOf("INTC", bars, at("2026-11-02T15:30:00Z"), undefined, at("2026-11-02T15:31:00Z"));
    expect(holiday).toMatchObject({ noSession: true, done: true, judge: false, closed: [], newest: null });
  });
});

describe("docs §8.140: a bar forming while the session trades is not closed", () => {
  const t = (iso: string) => Date.parse(iso) / 1000;
  // Apple's hourly answer as Yahoo gave it on 2026-11-05 (.github/workflows/yahoo-probe.yml): yesterday's last two
  // bars, today's 14:30 UTC (9:30 New York) bar, the 15:30 bar forming, and one point at the last price, volume 0
  const apple = (last: string, lastVolume = 0, rows = 5) => ({
    chart: {
      result: [{
        meta: { symbol: "AAPL", gmtoffset: -18000, regularMarketPrice: 346.48, regularMarketTime: t(last), currentTradingPeriod: { regular: { start: t("2026-11-05T14:30:00Z"), end: t("2026-11-05T21:00:00Z") } } },
        timestamp: [t("2026-11-04T19:30:00Z"), t("2026-11-04T20:30:00Z"), t("2026-11-05T14:30:00Z"), t("2026-11-05T15:30:00Z"), t(last)].slice(0, rows),
        indicators: {
          quote: [{
            open: [353.1112060546875, 352.1700134277344, 353.8999938964844, 349.82000732421875, 346.4800109863281].slice(0, rows),
            high: [353.2200012207031, 352.8299865722656, 355.3800048828125, 350.3299865722656, 346.4800109863281].slice(0, rows),
            low: [351.510009765625, 348.5199890136719, 348.05999755859375, 345.5, 346.4800109863281].slice(0, rows),
            close: [352.1700134277344, 349.6199951171875, 349.80499267578125, 346.04998779296875, 346.4800109863281].slice(0, rows),
            volume: [5090501, 11375216, 35192996, 79333617, lastVolume].slice(0, rows),
          }],
        },
      }],
    },
  });

  it("at 16:20 UTC judges the 14:30 bar, not the 15:30 one still forming (on 2026-11-05 it judged the forming bar from 15:32 on)", () => {
    const now = at("2026-11-05T16:20:41Z");
    const got = stockBarsOf("AAPL", apple("2026-11-05T16:20:39Z"), now)!;
    expect(got.bars.map((b) => [b.datetime, b.closed])).toEqual([
      ["2026-11-04 19:30:00", true],
      ["2026-11-04 20:30:00", true],
      ["2026-11-05 14:30:00", true],
      ["2026-11-05 15:30:00", false],
    ]);
    const step = stockSweepOf("AAPL", got.bars, at("2026-11-05T15:30:00Z"), undefined, now);
    expect(step.newest!.datetime).toBe("2026-11-05 14:30:00");
    expect(step.done).toBe(true);
    // a later point that traded (not joined to the bar) does not close the bar either: its end has not come
    const traded = stockBarsOf("AAPL", apple("2026-11-05T16:20:39Z", 5), now)!;
    expect(traded.bars).toHaveLength(5);
    expect(traded.bars[3].closed).toBe(false);
    expect(traded.bars[4].closed).toBe(false);
  });

  it("at 16:30 UTC, once Yahoo has priced past it, judges the 15:30 bar (it was not marked judged while it formed)", () => {
    const now = at("2026-11-05T16:30:05Z");
    const got = stockBarsOf("AAPL", apple("2026-11-05T16:30:03Z"), now)!;
    // the point at 16:30:03 opens the next bar
    expect(got.bars.map((b) => [b.datetime, b.closed]).slice(-2)).toEqual([["2026-11-05 15:30:00", true], ["2026-11-05 16:30:03", false]]);
    const before = stockSweepOf("AAPL", stockBarsOf("AAPL", apple("2026-11-05T16:20:39Z"), at("2026-11-05T16:20:41Z"))!.bars, at("2026-11-05T15:30:00Z"), undefined, at("2026-11-05T16:20:41Z"));
    const step = stockSweepOf("AAPL", got.bars, at("2026-11-05T16:30:00Z"), before.newest!.open_ms, now);
    expect(step).toMatchObject({ judge: true, done: true, noSession: false });
    expect(step.newest!.datetime).toBe("2026-11-05 15:30:00");
    // before Yahoo has priced past 16:30 (its last trade 16:29:58, no later point): not in yet, not done
    const early = stockBarsOf("AAPL", apple("2026-11-05T16:29:58Z", 0, 4), at("2026-11-05T16:30:01Z"))!;
    expect(early.bars[3].closed).toBe(false);
    expect(stockSweepOf("AAPL", early.bars, at("2026-11-05T16:30:00Z"), before.newest!.open_ms, at("2026-11-05T16:30:01Z")).done).toBe(false);
    // a later point inside the bar that traded (not joined) does not close it once its end has come either: only a bar
    // that opens at or after its end does
    const inside = stockBarsOf("AAPL", apple("2026-11-05T16:29:58Z", 5), at("2026-11-05T16:30:05Z"))!;
    expect(inside.bars.map((b) => [b.datetime, b.closed]).slice(-2)).toEqual([["2026-11-05 15:30:00", false], ["2026-11-05 16:29:58", false]]);
  });
});

// ---- #397: the bars the ride's tests stand on ------------------------------------------------------------------------
//
// 2,200 hourly bars of a US share on New York's sessions (9:30 … 15:30 local, seven a weekday, daylight saving kept:
// the first opens 13:30 UTC in summer and 14:30 in winter), a slow wave, quicker ones and a drift, rounded to the cent
// as the chart draws a US share. A bar opens at the close before it and has no wick unless a test gives it one. Under
// the ride's rule they hold 25 entry bars, 13 of them a notice (already at 96%), found below with the shared code
const SYM = "AAPL";
const N = 2200;
const times: number[] = [];
for (let day = Date.UTC(2025, 5, 2); times.length < N; day += 24 * H) {
  const wd = new Date(day).getUTCDay();
  if (wd === 0 || wd === 6) continue;
  const first = localOf(SYM, day + 13.5 * H).min === 9 * 60 + 30 ? day + 13.5 * H : day + 14.5 * H;
  for (let h = 0; h < 7 && times.length < N; h++) times.push(first + h * H);
}
const ends = times.map((t) => stockBarEnd(SYM, t));
const wave = (i: number) => 0.9 * Math.sin(i / 90) + 0.35 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7) + 0.03 * Math.sin(i * 1.9) + 0.0004 * i;
const closes = Array.from({ length: N }, (_, i) => Number((200 + 10 * wave(i)).toFixed(2)));
const openOf = (k: number) => (k > 0 ? closes[k - 1] : closes[k]);
const iso = (ms: number) => new Date(ms).toISOString();
const dt = (ms: number) => iso(ms).slice(0, 19).replace("T", " ");
// a timestamptz as PostgREST writes it
const pg = (ms: number) => iso(ms).replace(".000Z", "+00:00");
const closeOf = (k: number) => ends[k];
const shareBar = (k: number, over: Partial<StockBar> = {}): StockBar => ({
  datetime: dt(times[k]), open: openOf(k), high: Math.max(openOf(k), closes[k]), low: Math.min(openOf(k), closes[k]), close: closes[k],
  open_ms: times[k], end: ends[k], closed: true, ...over,
});
// the closed bars up to bar n, as a read brings them
const closedTo = (n: number, over: Record<number, Partial<StockBar>> = {}): StockBar[] => Array.from({ length: n + 1 }, (_, k) => shareBar(k, over[k]));
const entryAt = (i: number): RideEntry | null => rideEntryAt(closes.slice(i - 599, i + 1));
const zAt = (i: number) => rideZoneAt(closes.slice(i - 599, i + 1))!;
const at96 = (k: number, zside: "top" | "bottom") => atShare(zAt(k), zside, RIDE_OUT_SHARE);
// a ride of the chart as the pure functions read it, held from a bar
const heldFrom = (side: "BUY" | "SELL", entryIndex: number): RideRow => ({ side, entryBar: times[entryIndex], status: "open", reachedBar: null });

// the bars the scenarios stand on (each checked where it is used)
const I_BUY = 1761; // a BUY entry (not already): the line is at 96% of the top at no close before J_BUY, three bars on
const J_BUY = 1764;
const I_SELL = 2100; // a SELL entry (not already): at 96% of the bottom at the close of J_SELL, two bars on
const J_SELL = 2102;
const I_HELD = 1229; // a SELL entry (not already): at 96% at no close before J_HELD, 24 bars on — itself an already entry of the SELL side
const J_HELD = 1253;
const I_NOTICE = 1822; // an entry bar already at 96% (a SELL's side)
const I_LAST = 951; // a SELL entry at a session's last bar (15:30 New York)
const OLD_BUY = 2040; // a BUY held from here: no close at 96% of the top from here to J_SELL
const OLD_SELL = 1950; // a SELL held from here: no close at 96% of the bottom in the newest 100 bars up to I_SELL + 1; J_SELL is one
const LATE_BUY = 1620; // a BUY held from here (a bar that has left the newest 100 closed bars by I_BUY): first at 96% at the close of J_LATE, long before I_BUY
const J_LATE = 1723;
// a high on bar I_BUY + 1 that touches 96% of the top while that bar's close does not
const WICK = 217.6;

describe("#397 the share bars the ride's tests stand on (found with the shared code)", () => {
  it("are New York's seven bars a weekday, and hold entries on both sides, notices, and rides reached bars later", () => {
    expect(times.every((t) => {
      const l = localOf(SYM, t);
      return l.wd >= 1 && l.wd <= 5 && l.min >= 9 * 60 + 30 && l.min <= 15 * 60 + 30 && (l.min - 30) % 60 === 0;
    })).toBe(true);
    const found: string[] = [];
    for (let i = 620; i < N - 3; i++) {
      const e = entryAt(i);
      if (e) found.push(`${i}:${e.side}${e.already ? ":at" : ""}`);
    }
    expect(found).toHaveLength(25);
    expect(found.filter((x) => x.endsWith(":at"))).toHaveLength(13);
    for (const [i, side, already] of [[I_BUY, "BUY", false], [I_SELL, "SELL", false], [I_HELD, "SELL", false], [I_LAST, "SELL", false], [I_NOTICE, "SELL", true], [J_HELD, "SELL", true]] as const) {
      expect(entryAt(i), `bar ${i}`).toMatchObject({ side, already });
    }
    // the BUY from I_BUY: the next two closes (the day's last two bars) are not at 96%, the next day's first is
    expect([I_BUY + 1, I_BUY + 2, J_BUY].map((k) => at96(k, "top"))).toEqual([false, false, true]);
    expect([I_BUY, I_BUY + 2, J_BUY].map((k) => dt(times[k]))).toEqual(["2026-05-19 17:30:00", "2026-05-19 19:30:00", "2026-05-20 13:30:00"]);
    expect([I_BUY + 1, J_BUY, J_BUY + 1].map((k) => entryAt(k))).toEqual([null, null, null]);
    // the SELL from I_SELL: at J_SELL; the one from I_HELD: at no close before J_HELD
    expect([I_SELL + 1, J_SELL].map((k) => at96(k, "bottom"))).toEqual([false, true]);
    expect(Array.from({ length: J_HELD - I_HELD - 1 }, (_, n) => at96(I_HELD + 1 + n, "bottom")).some(Boolean)).toBe(false);
    expect(at96(J_HELD, "bottom")).toBe(true);
    // the older rides: OLD_BUY is at 96% of the top at no close up to J_SELL; OLD_SELL at none of the newest 100 up to
    // I_SELL + 1; LATE_BUY first at J_LATE, and its entry bar is older than the newest 100 closed bars at I_BUY
    expect(LATE_BUY).toBeLessThan(I_BUY - RIDE_CATCHUP_BARS);
    expect(Array.from({ length: J_SELL - OLD_BUY }, (_, n) => at96(OLD_BUY + 1 + n, "top")).some(Boolean)).toBe(false);
    expect(Array.from({ length: RIDE_CATCHUP_BARS }, (_, n) => at96(I_SELL + 1 - n, "bottom")).some(Boolean)).toBe(false);
    expect(Array.from({ length: J_LATE - LATE_BUY }, (_, n) => at96(LATE_BUY + 1 + n, "top"))).toEqual([...Array(J_LATE - LATE_BUY - 1).fill(false), true]);
    // I_LAST is a session's last bar (15:30 New York, half an hour long)
    expect(localOf(SYM, times[I_LAST]).min).toBe(15 * 60 + 30);
    expect(closeOf(I_LAST) - times[I_LAST]).toBe(30 * MIN);
  });
});

describe("#397 the ride on a share, judged at closes (stocks.ts stockRidesReached, stockRideClose; spec section 6)", () => {
  it("the close step at the newest closed bar while it ended at most 45 minutes ago: email 1, the notice, or nothing", () => {
    const closed = closedTo(I_BUY);
    const now = closeOf(I_BUY) + MIN;
    const c = stockRideClose(SYM, closed, [], now);
    expect(c.fresh).toBe(true);
    expect(c.entry).toEqual(entryAt(I_BUY));
    expect(c.step).toEqual({ step: "in", side: "BUY", zside: "top", own: null, by: null });
    // the pane side is the top for a BUY, and the line is in the 90% band but not at 96%
    expect(shareOf(c.entry!.z, "top")).toBeGreaterThanOrEqual(RIDE_IN_SHARE);
    expect(shareOf(c.entry!.z, "top")).toBeLessThan(RIDE_OUT_SHARE);
    // 45 minutes after the close still, 46 not, nor before its end
    expect(STOCK_FRESH_MS).toBe(45 * MIN);
    expect(stockRideClose(SYM, closed, [], closeOf(I_BUY) + 45 * MIN).step.step).toBe("in");
    expect(stockRideClose(SYM, closed, [], closeOf(I_BUY) + 46 * MIN)).toEqual({ fresh: false, entry: null, step: { step: null, side: null, zside: null, own: null, by: null } });
    expect(stockBarFresh(closed[closed.length - 1], closeOf(I_BUY) - 1)).toBe(false);
    // another share, too few bars, a bar that is no entry: nothing
    expect(stockRideClose("IBM", closed, [], now)).toMatchObject({ fresh: false, entry: null });
    expect(stockRideClose(SYM, closed.slice(-599), [], now)).toMatchObject({ fresh: true, entry: null, step: { step: null } });
    expect(stockRideClose(SYM, closedTo(I_BUY + 1), [], closeOf(I_BUY + 1) + MIN)).toMatchObject({ fresh: true, entry: null, step: { step: null } });
    // already at 96% at the close: the notice, on the side an entry would have been
    expect(stockRideClose(SYM, closedTo(I_NOTICE), [], closeOf(I_NOTICE) + MIN).step).toMatchObject({ step: "at", side: "SELL", zside: "bottom" });
    // judging the bar again with its own ride there (open, or reached since): still email 1, nothing new to open
    const own = heldFrom("BUY", I_BUY);
    expect(stockRideClose(SYM, closed, [own], now).step).toMatchObject({ step: "in", own, by: null });
    expect(stockRideClose(SYM, closed, [{ ...own, status: "reached", reachedBar: times[J_BUY] }], now).step).toMatchObject({ step: "in", by: null });
    // the run takes the closed bars in, and says whether an entry there would still be mailed
    const sweep = stockSweepOf(SYM, closed, closeOf(I_BUY), undefined, now);
    expect(sweep).toMatchObject({ judge: true, fresh: true, done: true, noSession: false });
    expect(sweep.closed).toHaveLength(I_BUY + 1);
    expect(sweep.newest).toBe(closed[I_BUY]);
    expect(stockSweepOf(SYM, closed, closeOf(I_BUY), undefined, closeOf(I_BUY) + 46 * MIN).fresh).toBe(false);
    // a bar still forming (not closed) is no part of them
    const forming = [...closed, shareBar(I_BUY + 1, { closed: false })];
    expect(stockSweepOf(SYM, forming, closeOf(I_BUY), undefined, now).newest).toBe(closed[I_BUY]);
  });

  it("a ride is reached by a CLOSE, not by a high: the first closed bar after the entry whose line, on its own 600 closed bars, is at 96% of its side", () => {
    const ride = heldFrom("BUY", I_BUY);
    const wick = { [I_BUY + 1]: { high: WICK } };
    expect(WICK).toBeGreaterThan(closes[I_BUY + 1]);
    // the pairs' way (by the bar's high) would be reached in bar I_BUY + 1
    const asPairs = closedTo(I_BUY + 1, wick).map((b) => ({ t: b.open_ms, high: b.high, low: b.low, close: b.close }));
    expect(rideCatchUp(asPairs, "top", times[I_BUY])).toMatchObject({ bar: times[I_BUY + 1], x: WICK });
    // a share's is not: neither at that close nor at the next
    for (const n of [I_BUY, I_BUY + 1, I_BUY + 2]) expect(stockRidesReached(SYM, closedTo(n, wick), [ride], closeOf(n) + MIN), `bar ${n}`).toEqual([]);
    // at J_BUY's close it is: the bar's open, the newest closed bar's close as the price, not late, the line's share there
    const got = stockRidesReached(SYM, closedTo(J_BUY, wick), [ride], closeOf(J_BUY) + MIN);
    const z = zAt(J_BUY);
    expect(got).toEqual([{ ride, bar: times[J_BUY], price: closes[J_BUY], late: false, share: z.m / z.top }]);
    expect(got[0].ride).toBe(ride);
    expect(z.m).toBeGreaterThanOrEqual(RIDE_OUT_SHARE * z.top);
    // a low under everything changes nothing either (a BUY rides the top), nor does a ride of the other side find it
    expect(stockRidesReached(SYM, closedTo(J_BUY, { [I_BUY + 1]: { low: 1 } }), [ride], closeOf(J_BUY) + MIN)).toHaveLength(1);
    expect(stockRidesReached(SYM, closedTo(J_BUY), [heldFrom("SELL", I_BUY)], closeOf(J_BUY) + MIN)).toEqual([]);
    // a ride that is not open is passed over; nothing on another chart or with no closed bar
    expect(stockRidesReached(SYM, closedTo(J_BUY), [{ ...ride, status: "reached", reachedBar: times[J_BUY] }], closeOf(J_BUY) + MIN)).toEqual([]);
    expect(stockRidesReached("IBM", closedTo(J_BUY), [ride], closeOf(J_BUY) + MIN)).toEqual([]);
    expect(stockRidesReached(SYM, [], [ride], closeOf(J_BUY) + MIN)).toEqual([]);
    // the entry bar itself is never the bar it is reached in
    expect(stockRidesReached(SYM, closedTo(J_BUY), [heldFrom("BUY", J_BUY)], closeOf(J_BUY) + MIN)).toEqual([]);
  });

  it("late or not: late when the bar is not the newest closed one, or the newest ended more than 45 minutes ago; the price is the newest closed bar's close", () => {
    const ride = heldFrom("BUY", I_BUY);
    const seenAt = (n: number, after: number) => stockRidesReached(SYM, closedTo(n), [ride], closeOf(n) + after)[0];
    expect(seenAt(J_BUY, 1_000)).toMatchObject({ bar: times[J_BUY], late: false, price: closes[J_BUY] });
    expect(seenAt(J_BUY, 45 * MIN)).toMatchObject({ bar: times[J_BUY], late: false });
    // the same bar, the newest, read 46 minutes after it ended (a feed that lagged, a window missed)
    expect(seenAt(J_BUY, 46 * MIN)).toMatchObject({ bar: times[J_BUY], late: true, price: closes[J_BUY] });
    // found at the next close: the bar it was reached in stays, the price is the newest bar's
    expect(seenAt(J_BUY + 1, 1_000)).toMatchObject({ bar: times[J_BUY], late: true, price: closes[J_BUY + 1] });
    expect(closes[J_BUY + 1]).not.toBe(closes[J_BUY]);
    // among the newest RIDE_CATCHUP_BARS closed bars only: a bar that has left them is never seen
    const n = J_BUY + RIDE_CATCHUP_BARS;
    let first = -1;
    for (let k = n - RIDE_CATCHUP_BARS + 1; k <= n && first < 0; k++) if (at96(k, "top")) first = k;
    expect(first).toBeGreaterThan(J_BUY);
    expect(seenAt(n, 1_000)).toMatchObject({ bar: times[first], late: first !== n });
  });

  it("both sides can be open at once: a ride of one side skips nothing of the other, and each is reached on its own side", () => {
    const buy = heldFrom("BUY", OLD_BUY);
    const now = closeOf(I_SELL) + MIN;
    expect(stockRidesReached(SYM, closedTo(I_SELL), [buy], now)).toEqual([]);
    expect(stockRideClose(SYM, closedTo(I_SELL), [buy], now).step).toMatchObject({ step: "in", side: "SELL", zside: "bottom", own: null, by: null });
    // both open: at J_SELL the SELL is reached, the BUY is not
    const sell = heldFrom("SELL", I_SELL);
    const got = stockRidesReached(SYM, closedTo(J_SELL), [buy, sell], closeOf(J_SELL) + MIN);
    expect(got.map((g) => [g.ride.side, g.bar, g.late, g.price])).toEqual([["SELL", times[J_SELL], false, closes[J_SELL]]]);
    expect(got[0].share).toBe(zAt(J_SELL).m / zAt(J_SELL).bottom);
  });

  it("an entry while an older ride of that side is open is skipped; reached in a later bar, still; reached in this bar or before, not", () => {
    const old = heldFrom("SELL", OLD_SELL);
    const closed = closedTo(I_SELL);
    const now = closeOf(I_SELL) + MIN;
    expect(stockRidesReached(SYM, closed, [old], now)).toEqual([]);
    expect(stockRideClose(SYM, closed, [old], now).step).toEqual({ step: "skip", side: "SELL", zside: "bottom", own: null, by: old });
    const reachedIn = (k: number): RideRow => ({ ...old, status: "reached", reachedBar: times[k] });
    expect(stockRideClose(SYM, closed, [reachedIn(J_SELL)], now).step).toMatchObject({ step: "skip" });
    expect(stockRideClose(SYM, closed, [reachedIn(I_SELL)], now).step).toMatchObject({ step: "in", by: null });
    expect(stockRideClose(SYM, closed, [reachedIn(I_SELL - 1)], now).step).toMatchObject({ step: "in", by: null });
    // the old ride is reached at J_SELL's close, as the new one would have been
    expect(stockRidesReached(SYM, closedTo(J_SELL), [old], closeOf(J_SELL) + MIN)).toMatchObject([{ ride: old, bar: times[J_SELL], late: false }]);
  });

  it("a ride reached at a bar that is also an already entry of its side: the reach, and no notice (quiet)", () => {
    const held = heldFrom("SELL", I_HELD);
    const closed = closedTo(J_HELD);
    const now = closeOf(J_HELD) + MIN;
    // not reached at the close before
    expect(stockRidesReached(SYM, closedTo(J_HELD - 1), [held], closeOf(J_HELD - 1) + MIN)).toEqual([]);
    const reached = stockRidesReached(SYM, closed, [held], now);
    expect(reached).toMatchObject([{ ride: held, bar: times[J_HELD], late: false, price: closes[J_HELD] }]);
    // the rows as they stand once the reach is written: quiet
    const after: RideRow = { ...held, status: "reached", reachedBar: reached[0].bar };
    expect(stockRideClose(SYM, closed, [after], now).step).toEqual({ step: "quiet", side: "SELL", zside: "bottom", own: null, by: after });
    // with no ride of the side (or one of the other side) the same close is a notice
    expect(stockRideClose(SYM, closed, [], now).step.step).toBe("at");
    expect(stockRideClose(SYM, closed, [{ ...after, side: "BUY" }], now).step.step).toBe("at");
  });
});

// ---- #397: the three mails (spec section 8) -------------------------------------------------------------------------

type Row = Record<string, unknown>;
const barAt = (i: number) => ({ openMs: times[i], closeMs: closeOf(i), mid: closes[i], paid: closes[i] });
const inSig = (i: number) => rideCloseSignal("stockmacd", SYM, "1h", "in", entryAt(i)!, barAt(i));
const atSig = (i: number) => rideCloseSignal("stockmacd", SYM, "1h", "at", entryAt(i)!, barAt(i));
// a ride of the share as its row in public.macd_rides
const rowOf = (side: "BUY" | "SELL", entryIndex: number, over: Row = {}): Row => ({
  pair: SYM, side, entry_bar: pg(times[entryIndex]), entry_closed_at: pg(closeOf(entryIndex)), entry_price: closes[entryIndex], entry_mid: closes[entryIndex],
  share0: 0.93, status: "open", reached_at: null, reached_bar: null, seen_price: null, late: null, share1: null, ...over,
});
// email 2 of the BUY from I_BUY, reached at J_BUY's close and seen a second after it
const outSig = (over: Row = {}) => rideOutSignal("stockmacd", "1h", macdRideOf(rowOf("BUY", I_BUY, {
  status: "reached", reached_at: pg(closeOf(J_BUY) + 1_000), reached_bar: pg(times[J_BUY]), seen_price: closes[J_BUY], late: false, share1: 0.9717, ...over,
}))!)!;
// a Tokyo share's bar: 11:00 JST (the lunch break follows), 15:00 JST (the session's last), 10:00 JST (neither)
const TOYOTA_LUNCH = { openMs: at("2026-11-02T02:00:00Z"), closeMs: at("2026-11-02T02:30:00Z"), mid: 3070, paid: 3070 };
const toyotaIn = () => rideCloseSignal("stockmacd", "7203.T", "1h", "in", entryAt(I_LAST)!, TOYOTA_LUNCH);
const toyotaOut = (over: Row = {}) => rideOutSignal("stockmacd", "1h", macdRideOf(rowOf("SELL", I_LAST, {
  pair: "7203.T", entry_bar: "2026-11-02T02:00:00+00:00", entry_closed_at: "2026-11-02T02:30:00+00:00", entry_price: 3070, entry_mid: 3070,
  status: "reached", reached_at: "2026-11-02T06:45:04+00:00", reached_bar: "2026-11-02T06:00:00+00:00", seen_price: 3102.5, late: false, share1: 0.97, ...over,
}))!)!;
const allText = (s: IndicatorSignal) => (["ja", "en"] as const).map((l) => renderIndicatorMail(s, l)).map((m) => `${m.subject}\n${m.text}\n${m.html}`).join("\n");

describe("#397 the three rule ids of the shares' ride, and the row of each mail (spec section 2)", () => {
  it("each mail's row: its own id, the entry bar, the price paid (a share's close), no stop, and on email 2 the price when seen", () => {
    expect(signalRow(inSig(I_BUY))).toEqual({
      bar_time: iso(times[I_BUY]), closed_at: iso(closeOf(I_BUY)), side: "BUY", entry: closes[I_BUY], stop: null, target: null, rule: STOCKMACD_RULE_ID,
    });
    expect(signalRow(atSig(I_NOTICE))).toEqual({
      bar_time: iso(times[I_NOTICE]), closed_at: iso(closeOf(I_NOTICE)), side: "SELL", entry: closes[I_NOTICE], stop: null, target: null, rule: STOCKMACD_AT_RULE_ID,
    });
    // email 2: under the ride's ENTRY bar, closed_at when it was seen
    expect(signalRow(outSig())).toEqual({
      bar_time: iso(times[I_BUY]), closed_at: iso(closeOf(J_BUY) + 1_000), side: "BUY", entry: closes[I_BUY], stop: null, target: closes[J_BUY], rule: STOCKMACD_OUT_RULE_ID,
    });
    expect([inSig(I_BUY), atSig(I_NOTICE), outSig()].map(rideSignalTag)).toEqual(["stockmacd:BUY", "stockmacd-at:SELL", "stockmacd-out:BUY"]);
    // a session's last bar closes half an hour after it opens: the row's closed_at is the bar's own end
    expect(signalRow(inSig(I_LAST)).closed_at).toBe(iso(times[I_LAST] + 30 * MIN));
    for (const s of [inSig(I_BUY), atSig(I_NOTICE), outSig()]) expect(s).toMatchObject({ rule: "stockmacd", pair: SYM, interval: "1h", sl: null, tps: null });
  });
});

describe("#397 the three mails on a share (stocks.ts renderStockMail; spec section 8)", () => {
  it("email 1 in Japanese: the share's name, the bar, into the 90% band of the pane's TOP for a BUY, the numbers, the close, what follows, and that shares are not measured", () => {
    const s = inSig(I_BUY);
    const f = s.ride!;
    const mail = renderIndicatorMail(s, "ja");
    expect(mail).toEqual(renderStockMail(s, "ja"));
    expect(mail.subject).toBe("【Sextant】アップル（AAPL） 1時間足 買い（BUY）で入る合図（株の MACD・1通目）");
    const t = mail.text;
    expect(t).toContain("アップル（AAPL、米国）の1時間足で、株の MACD の買い（BUY）で入る合図が出ました（1通目）。");
    // I_BUY closes 2026-05-19 18:30 UTC, 03:30 the next day in Japan
    expect(t).toContain("判定した足: 2026-05-20 03:30（日本時間）に確定した足");
    expect(t).toContain("MACD(12・26・9): 青い線（MACD）が、新しい120本の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い所）の90%以上（0の線から測って）に入りました。一つ前の足では入っていなかったので、流れに乗って買いで入る合図です");
    // the edge is the PANE side's, the top for a BUY (the 95% email printed the bottom for a BUY)
    expect(f.top!).toBeGreaterThan(0);
    expect(t).toContain(`\n  MACD = ${f.m!.toFixed(2)}、枠の上の端 = ${f.top!.toFixed(2)}（その90% = ${(RIDE_IN_SHARE * f.top!).toFixed(2)}、96% = ${(RIDE_OUT_SHARE * f.top!).toFixed(2)}）`);
    expect(t).not.toContain("枠の下の端");
    expect(t).toContain(`\nこの足の終値: ${closes[I_BUY].toFixed(2)}ドル`);
    expect(t).toContain("FX の「MACD の流れ」のメールと同じ決まり（Sextant 独自のもの。docs §8.150）を、株の1時間足に当てたものです。");
    expect(t).toContain("2通目は、1時間足が確定するたびに見て、青い線が同じ端（枠の上の端）の96%以上にいた最初の足で送ります。FX のメールと違い、足の途中は見ません");
    expect(t).toContain("損切りも目標もありません。青い線が90%の帯から出ても、何も送りません。2通目を送るまで、この株の同じ向き（買い）の新しい1通目は送りません。");
    // not measured on shares, and no number of any study
    expect(t).toContain("\n\nこの決まりは、株では測っていません。FX の5ペアで測った数字（docs §8.149）は、株には当てはまりません。損切りをしないので、96%に届くまで、含み損のまま持ち続けることがあります。\n\n");
    expect(t).toContain("足と値段は Yahoo Finance の公開データ（公式の配信ではないため、止まることがあります）で、アプリの株のチャートと同じです。取引時間の最後の足は、引けの値段で判定します。");
    expect(t).toContain("取引時間の最後の足の終値では、次に取引が始まるまで売買できず、その時の値段は違うことがあります。");
    expect(t).toContain("https://fx-tactical.jp/");
    expect(t).toContain("「株の MACD」でチェックを外してください");
    expect(t).toContain("本メールは参考情報であり、投資助言ではありません。");
    // a BUY on a US share at a bar inside the session: no short sale, no Tokyo, no "last bar" line
    for (const no of ["空売り", "東証の値段", "この足は、", "昼休み"]) expect(t, no).not.toContain(no);
    // no stop, no targets, nothing of the 95% email, none of docs §8.133's or §8.149's numbers
    for (const no of ["損切り 1", "利確", "エントリー ≈", "95%", "山・谷", "§8.133", "§8.119", "22銘柄", "1,696", "99.36", "1,837.40", "801回", "360回", "429回", "pips", "必ず戻"]) expect(t, no).not.toContain(no);
  });

  it("email 1 for a SELL: the pane's BOTTOM, said to be a short sale, and at a session's last bar that its close cannot be traded until the next session; in English the same", () => {
    const s = inSig(I_LAST);
    const f = s.ride!;
    expect(f.bottom!).toBeLessThan(0);
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】アップル（AAPL） 1時間足 売り（SELL）で入る合図（株の MACD・1通目）");
    expect(ja.text).toContain("株の MACD の売り（SELL）で入る合図が出ました（1通目）。株の売りは空売りです。");
    expect(ja.text).toContain("枠の下の端（青い線・オレンジの線・棒の一番低い所）の90%以上（0の線から測って）に入りました。一つ前の足では入っていなかったので、流れに乗って売りで入る合図です");
    // below zero the minus is the chart's (U+2212), not toFixed's hyphen
    expect(ja.text).toContain(`\n  MACD = −${(-f.m!).toFixed(2)}、枠の下の端 = −${(-f.bottom!).toFixed(2)}（その90% = −${(-RIDE_IN_SHARE * f.bottom!).toFixed(2)}、96% = −${(-RIDE_OUT_SHARE * f.bottom!).toFixed(2)}）`);
    expect(ja.text).not.toContain("= -");
    // I_LAST opens 15:30 in New York: the session's last bar (closes 16:00, 06:00 in Japan)
    expect(ja.text).toContain("判定した足: 2025-12-09 06:00（日本時間）に確定した足");
    expect(ja.text).toContain(`\nこの足の終値: ${closes[I_LAST].toFixed(2)}ドル\nこの足は、取引時間の最後の足です。この終値では、次の取引時間が始まるまで売買できず、その時の値段は違うことがあります\n\n`);
    expect(ja.text).toContain("2通目を送るまで、この株の同じ向き（売り）の新しい1通目は送りません。");
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] Apple (AAPL) 1-hour SELL entry signal (Stock MACD, email 1)");
    const t = en.text;
    expect(t).toContain("A Stock MACD SELL entry signal fired on Apple (AAPL, US), 1-hour chart (email 1). A SELL on a share is a short sale.");
    expect(t).toContain("Bar: closed 2025-12-08 21:00 UTC (2025-12-09 06:00 JST)");
    expect(t).toContain(
      "MACD(12, 26, 9): the MACD line (blue) came into the bottom band of the MACD pane of the newest 120 bars: 90% or more of the way from the zero line to the pane's bottom (the lowest of the MACD line, the signal line and the histogram). The bar before was outside it, so this is an entry with the flow: a SELL",
    );
    expect(t).toContain(`\n  MACD = −${(-f.m!).toFixed(2)}; bottom of the pane = −${(-f.bottom!).toFixed(2)}; 90% of it = −${(-RIDE_IN_SHARE * f.bottom!).toFixed(2)}; 96% of it = −${(-RIDE_OUT_SHARE * f.bottom!).toFixed(2)}`);
    expect(t).toContain(`\nThis bar's close: $${closes[I_LAST].toFixed(2)}\nThis is the session's last bar: this close cannot be traded until the next session opens, and the price then may differ\n\n`);
    expect(t).toContain("This is the rule of the app's MACD ride email on currency pairs (Sextant's own rule, docs §8.150), on the share's 1-hour bars. Email 2 is sent at the first later 1-hour close at which the blue line is at 96% or more of the same edge (the pane's bottom). Unlike the pairs' email it is looked for at closes only");
    expect(t).toContain("There is no stop and no target. Nothing is sent if the line leaves the 90% band, and no new email 1 for this share and side (SELL) is sent until email 2 has been.");
    expect(t).toContain("\n\nThis rule has not been measured on shares. The numbers measured on the five currency pairs (docs §8.149) do not apply to shares. With no stop, a trade can stay at a loss until the line reaches 96%.\n\n");
    expect(t).toContain("The bars and the price are Yahoo Finance's public data (not an official feed; it may stop), the same as the app's stock chart; a session's last bar is judged on its closing price. The close of a session's last bar cannot be traded until the market opens again, and the price then may differ.");
    expect(t).toContain("untick the share under Stock MACD");
    for (const no of ["Stop ", "TP1", "take-profit", "take profit", "95%", "peak/valley", "always comes back", "No stop or target is given", "§8.133", "801 entries", "15 minutes late"]) expect(t, no).not.toContain(no);
    // a BUY's English says no short sale
    expect(renderIndicatorMail(inSig(I_BUY), "en").text).not.toContain("short sale");
  });

  it("a Tokyo share: yen, its market, Yahoo's 15-minute lag kept, and the bar before the lunch break said to be one", () => {
    expect(stockBarBreak("7203.T", at("2026-11-02T02:00:00Z"))).toBe("lunch");
    expect(stockBarBreak("7203.T", at("2026-11-02T06:00:00Z"))).toBe("close");
    expect(stockBarBreak("7203.T", at("2026-11-02T01:00:00Z"))).toBeNull();
    expect(stockBarBreak("7203.T", at("2026-11-02T03:00:00Z"))).toBeNull();
    expect(stockBarBreak(SYM, times[I_LAST])).toBe("close");
    expect(stockBarBreak(SYM, times[I_BUY])).toBeNull();
    const ja = renderStockMail(toyotaIn(), "ja");
    expect(ja.subject).toBe("【Sextant】トヨタ自動車（7203.T） 1時間足 売り（SELL）で入る合図（株の MACD・1通目）");
    expect(ja.text).toContain("トヨタ自動車（7203.T、東証）の1時間足で、");
    expect(ja.text).toContain("判定した足: 2026-11-02 11:30（日本時間）に確定した足");
    expect(ja.text).toContain("\nこの足の終値: 3070.0円\nこの足は、東証の昼休み（11:30〜12:30）の前の最後の足です。この終値では、午後の取引が始まるまで売買できず、その時の値段は違うことがあります\n\n");
    expect(ja.text).toContain("取引時間の最後の足（と、昼休みの前の足）の終値では、次に取引が始まるまで売買できず、その時の値段は違うことがあります。東証の値段は Yahoo では約15分遅れて届くため、このメールは足が確定してから約15分後に送っています（2026-11-06 に測りました）。注文の前にアプリで最新の状態を確認してください。");
    expect(ja.text).not.toContain("まだ確かめていません");
    const en = renderStockMail(toyotaIn(), "en");
    expect(en.subject).toBe("[Sextant] Toyota Motor (7203.T) 1-hour SELL entry signal (Stock MACD, email 1)");
    expect(en.text).toContain("fired on Toyota Motor (7203.T, Tokyo), 1-hour chart (email 1).");
    expect(en.text).toContain("\nThis bar's close: 3070.0 yen\nThis is the last bar before Tokyo's lunch break (11:30–12:30 JST): this close cannot be traded until the afternoon session opens, and the price then may differ\n\n");
    expect(en.text).toContain("The close of a session's last bar (and of the last bar before Tokyo's lunch break) cannot be traded until the market opens again, and the price then may differ. Yahoo's Tokyo prices come about 15 minutes late, so this email is sent about 15 minutes after the bar closed (measured on 2026-11-06). Check the latest state in the app before you place an order:");
    // a bar inside Tokyo's session has no such line
    const inside = renderStockMail(rideCloseSignal("stockmacd", "7203.T", "1h", "in", entryAt(I_LAST)!, { ...TOYOTA_LUNCH, openMs: at("2026-11-02T01:00:00Z"), closeMs: at("2026-11-02T02:00:00Z") }), "ja").text;
    expect(inside).not.toContain("この足は、");
    // the notice and email 2 of a Tokyo share keep the 15-minute sentence too
    expect(renderStockMail(rideCloseSignal("stockmacd", "7203.T", "1h", "at", entryAt(I_NOTICE)!, TOYOTA_LUNCH), "ja").text).toContain("このメールは足が確定してから約15分後に送っています（2026-11-06 に測りました）。");
    expect(renderStockMail(toyotaOut(), "ja").text).toContain("このメールは足が確定してから約15分後に送っています（2026-11-06 に測りました）。");
  });

  it("the notice: the line came into the band already at 96%, no entry, the bar's close and the three numbers", () => {
    const s = atSig(I_NOTICE);
    const e = entryAt(I_NOTICE)!;
    const ja = renderIndicatorMail(s, "ja");
    expect(ja.subject).toBe("【Sextant】アップル（AAPL） 1時間足 知らせ: もう96%です（株の MACD・入る合図なし）");
    expect(ja.text).toContain("アップル（AAPL、米国）の1時間足で、MACD の青い線が、枠の下の端の90%の帯に入りましたが、足が確定した時にはもう96%以上でした。入る合図（売り（SELL）。株では空売り）は送りません。知らせだけです。");
    expect(ja.text).toContain("判定した足: 2026-06-02 01:30（日本時間）に確定した足");
    expect(ja.text).toContain(`\n終値 ${closes[I_NOTICE].toFixed(2)}ドル\n  MACD = −${(-e.z.m).toFixed(2)}、枠の下の端 = −${(-e.z.bottom).toFixed(2)}（その96% = −${(-RIDE_OUT_SHARE * e.z.bottom).toFixed(2)}）`);
    expect(e.z.m).toBeLessThanOrEqual(RIDE_OUT_SHARE * e.z.bottom);
    expect(ja.text).toContain("この株の同じ向きの次の入る合図は、青い線がいったん90%の帯から出て、入り直した足で判定します。この決まりは、株では測っていません。");
    expect(ja.text).toContain("「株の MACD」でチェックを外してください");
    // no entry: no price paid, no 90% mark, nothing of a stop or a result
    for (const no of ["この足の終値:", "その90%", "利確", "損切り", "損益", "必ず戻", "この足は、"]) expect(ja.text, no).not.toContain(no);
    const en = renderIndicatorMail(s, "en");
    expect(en.subject).toBe("[Sextant] Apple (AAPL) 1-hour notice: already at 96% (Stock MACD, no entry signal)");
    expect(en.text).toContain("On Apple (AAPL, US), 1-hour chart, the MACD line (blue) came into the 90% band of the MACD pane's bottom, and at the bar's close it was already at 96% or more. No entry signal (it would have been a SELL, on a share a short sale) is sent: this is a notice only.");
    expect(en.text).toContain(`\nClose $${closes[I_NOTICE].toFixed(2)}\n  MACD = −${(-e.z.m).toFixed(2)}; bottom of the pane = −${(-e.z.bottom).toFixed(2)}; 96% of it = −${(-RIDE_OUT_SHARE * e.z.bottom).toFixed(2)}`);
    expect(en.text).toContain("The next entry signal for this share and side is judged at the bar where the line, having left the 90% band, comes back into it. This rule has not been measured on shares.");
  });

  it("email 2 in Japanese: the first email, the close it was seen on, the price now, the result in the share's currency and in percent of the entry (close to close), how long, and that it reports the line, not a profit", () => {
    const mail = renderIndicatorMail(outSig(), "ja");
    expect(mail.subject).toBe("【Sextant】アップル（AAPL） 1時間足 96%に届きました（株の MACD・2通目、買いの分）");
    const t = mail.text;
    expect(t).toContain("アップル（AAPL、米国）の1時間足で、MACD の青い線が、枠の上の端の96%に届きました（株の MACD の2通目。買い（BUY）の分）。");
    expect(t).toContain(`1通目: 2026-05-20 03:30（日本時間）に確定した足で買い（BUY）。その足の終値 ${closes[I_BUY].toFixed(2)}ドル`);
    expect(t).toContain("\n届いたのを見た時刻: 2026-05-20 23:30（日本時間）。その時の最新の確定足の終値で見ました");
    expect(t).toContain(`\n今の値段: ${closes[J_BUY].toFixed(2)}ドル（最新の確定足の終値）`);
    // 217.45 against 216.44: +1.01 dollars, 0.47% of the entry
    expect([closes[I_BUY], closes[J_BUY]]).toEqual([216.44, 217.45]);
    expect(t).toContain("\n1通目からの損益: +1.01ドル（+0.47%）。終値と終値の比べです");
    expect(t).toContain("\n1通目からの時間: 20時間0分（取引していない時間も入れています）");
    expect(t).toContain("このメールは、青い線が96%に届いたことの知らせです。損益はプラスとは限りません。損益は、1通目の足の終値と、最新の確定足の終値を比べたものです。手数料などの費用は入れていません。実際に売買できる値段は、違うことがあります。この決まりは、株では測っていません。");
    expect(t).toContain("96%に届いたかは、1時間足が確定するたびに、その足の終値で見ています（足の途中は見ていません）。");
    expect(t).toContain("「株の MACD」でチェックを外してください");
    for (const no of ["その時は読めず", "空売り", "東証の値段", "この足は、", "pips", "利確", "必ず戻"]) expect(t, no).not.toContain(no);
    // a loss (the minus as the chart's), and exactly zero
    expect(renderIndicatorMail(outSig({ seen_price: 215 }), "ja").text).toContain("\n1通目からの損益: −1.44ドル（−0.67%）。終値と終値の比べです");
    expect(renderIndicatorMail(outSig({ seen_price: 216.44 }), "ja").text).toContain("\n1通目からの損益: ±0.00ドル（±0.00%）。終値と終値の比べです");
    // a SELL (a short sale) gains when the price fell, on the pane's bottom
    const sell = renderIndicatorMail(outSig({ side: "SELL", seen_price: 215 }), "ja");
    expect(sell.subject).toBe("【Sextant】アップル（AAPL） 1時間足 96%に届きました（株の MACD・2通目、売りの分）");
    expect(sell.text).toContain("枠の下の端の96%に届きました（株の MACD の2通目。売り（SELL）の分）。");
    expect(sell.text).toContain("に確定した足で売り（SELL、空売り）。その足の終値 216.44ドル");
    expect(sell.text).toContain("\n1通目からの損益: +1.44ドル（+0.67%）。終値と終値の比べです");
    expect(sell.text).toContain("手数料などの費用（空売りにかかる費用も）は入れていません。");
    // the numbers behind the text
    expect(stockRidePnl(SYM, "BUY", 216.44, 217.45)).toEqual({ value: 1.01, pct: (101 / 21644) * 100 });
    expect(stockRidePnl(SYM, "SELL", 216.44, 217.45).value).toBe(-1.01);
    expect(stockRidePnl("7203.T", "SELL", 3070, 3102.5)).toEqual({ value: -32.5, pct: (-325 / 30700) * 100 });
  });

  it("email 2 seen late says at which close the line was already at 96%, that it could not be read then, and the price now", () => {
    const late = outSig({ late: true, reached_at: pg(closeOf(J_BUY + 1) + 1_000), seen_price: closes[J_BUY + 1] });
    const ja = renderIndicatorMail(late, "ja").text;
    expect(ja).toContain("\n2026-05-20 23:30（日本時間）に確定した足で、もう96%以上でした。その時は読めず、今見つけました（2026-05-21 00:30、日本時間）");
    expect(ja).not.toContain("届いたのを見た時刻");
    expect(ja).toContain(`\n今の値段: ${closes[J_BUY + 1].toFixed(2)}ドル（最新の確定足の終値）`);
    expect(ja).toContain("\n1通目からの損益: +0.82ドル（+0.38%）。終値と終値の比べです");
    expect(ja).toContain("\n1通目からの時間: 21時間0分");
    const en = renderIndicatorMail(late, "en").text;
    expect(en).toContain("\nThe line was already at 96% or more at the close of the bar closed 2026-05-20 14:30 UTC (2026-05-20 23:30 JST). It could not be read then and was found now (2026-05-20 15:30 UTC, 2026-05-21 00:30 JST)");
    expect(en).toContain(`\nPrice now: $${closes[J_BUY + 1].toFixed(2)} (the newest closed 1-hour bar's close)`);
    expect(en).toContain("\nProfit or loss since email 1: +$0.82 (+0.38%), close to close");
    // a Tokyo share's late email 2 does not say it was sent 15 minutes after the close
    const tokyo = renderStockMail(toyotaOut({ late: true }), "ja").text;
    expect(tokyo).toContain("東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に測りました）。");
    expect(tokyo).not.toContain("約15分後に送っています");
    expect(renderStockMail(toyotaOut({ late: true }), "en").text).toContain("Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06). Check");
  });

  it("email 2 in English says the same; a Tokyo share's in yen, and seen at a session's last bar that the price cannot be traded until the next session", () => {
    const mail = renderIndicatorMail(outSig(), "en");
    expect(mail.subject).toBe("[Sextant] Apple (AAPL) 1-hour reached 96% (Stock MACD, email 2, the BUY)");
    const t = mail.text;
    expect(t).toContain("On Apple (AAPL, US), 1-hour chart, the MACD line (blue) reached 96% of the way to the top of the MACD pane (Stock MACD, email 2, for the BUY).");
    expect(t).toContain("Email 1: a BUY at the bar closed 2026-05-19 18:30 UTC (2026-05-20 03:30 JST), that bar's close $216.44");
    expect(t).toContain("\nSeen at 2026-05-20 14:30 UTC (2026-05-20 23:30 JST), on the close of the newest closed 1-hour bar");
    expect(t).toContain("\nPrice now: $217.45 (the newest closed 1-hour bar's close)");
    expect(t).toContain("\nProfit or loss since email 1: +$1.01 (+0.47%), close to close");
    expect(t).toContain("\nTime since email 1: 20 hours 0 minutes (the hours the market was shut are in it)");
    expect(t).toContain("This email reports that the line reached 96%. It does not say the trade is at a profit: the result can be a loss. The result compares the close of email 1's bar with the newest closed bar's close; it holds no commission or other cost, and the prices you can trade at may differ. This rule has not been measured on shares.");
    expect(t).toContain("Whether the line is at 96% is looked at when each 1-hour bar closes, on that bar's close, not while a bar forms.");
    expect(t).toContain("untick the share under Stock MACD");
    expect(renderIndicatorMail(outSig({ seen_price: 215 }), "en").text).toContain("\nProfit or loss since email 1: −$1.44 (−0.67%), close to close");
    // Toyota, a SELL from 3070.0 seen at 3102.5 at the 15:00 bar's close (the session's last): a loss of 32.5 yen, 1.06%
    const ja = renderStockMail(toyotaOut(), "ja");
    expect(ja.subject).toBe("【Sextant】トヨタ自動車（7203.T） 1時間足 96%に届きました（株の MACD・2通目、売りの分）");
    expect(ja.text).toContain("1通目: 2026-11-02 11:30（日本時間）に確定した足で売り（SELL、空売り）。その足の終値 3070.0円");
    expect(ja.text).toContain("\n届いたのを見た時刻: 2026-11-02 15:45（日本時間）。その時の最新の確定足の終値で見ました");
    expect(ja.text).toContain("\n今の値段: 3102.5円（最新の確定足の終値）\nこの足は、取引時間の最後の足です。この値段では、次の取引時間が始まるまで売買できず、その時の値段は違うことがあります\n1通目からの損益: −32.5円（−1.06%）。終値と終値の比べです");
    const en = renderStockMail(toyotaOut(), "en").text;
    expect(en).toContain("Email 1: a SELL (a short sale) at the bar closed 2026-11-02 02:30 UTC (2026-11-02 11:30 JST), that bar's close 3070.0 yen");
    expect(en).toContain("\nPrice now: 3102.5 yen (the newest closed 1-hour bar's close)\nThis is the session's last bar: this price cannot be traded until the next session opens, and the price then may differ\nProfit or loss since email 1: −32.5 yen (−1.06%), close to close");
    expect(en).toContain("it holds no commission or other cost (a short sale has its own), and the prices you can trade at may differ.");
  });

  it("none of the three calls email 2 a take-profit, says a price always comes back, or carries a study's numbers; each says shares are not measured", () => {
    const mails = [inSig(I_BUY), inSig(I_LAST), toyotaIn(), atSig(I_NOTICE), outSig(), outSig({ late: true }), outSig({ side: "SELL" }), toyotaOut(), toyotaOut({ late: true })];
    for (const s of mails) {
      const t = allText(s);
      for (const no of ["利確", "必ず戻", "take-profit", "take profit", "Take-profit", "always comes back", "always come back", "山・谷", "peak/valley", "§8.133", "1,696", "99.36", "1,837.40", "22銘柄", "22 shares", "z95of120", "95%"]) {
        expect(t, `${s.pair} ${s.ride!.mail} ${no}`).not.toContain(no);
      }
      expect(t).toContain("株では測っていません");
      expect(t).toContain("has not been measured on shares");
      // the HTML part says what the text part says
      expect(renderIndicatorMail(s, "ja").html).toContain("株の MACD");
    }
  });

  it("a tiny edge is written to two significant digits, the numbers of a mail alike, from the PANE side's edge; a signal with no facts is written with dashes", () => {
    const e = entryAt(I_BUY)!;
    const withZ = (side: "top" | "bottom", z: { m: number; top: number; bottom: number }) =>
      rideCloseSignal("stockmacd", SYM, "1h", "in", { ...e, zside: side, side: side === "top" ? "BUY" : "SELL", z }, barAt(I_BUY));
    // a top of 0.0126: in a US share's 2 decimals it would read 0.01 four times
    expect(renderStockMail(withZ("top", { m: 0.0126, top: 0.0126, bottom: -2.2 }), "ja").text).toContain("\n  MACD = 0.013、枠の上の端 = 0.013（その90% = 0.011、96% = 0.012）");
    // the decimals follow the edge on the ride's side: a BUY's tiny BOTTOM changes nothing, a SELL's does
    expect(renderStockMail(withZ("top", { m: 0.19, top: 0.2, bottom: -1e-9 }), "en").text).toContain("\n  MACD = 0.19; top of the pane = 0.20; 90% of it = 0.18; 96% of it = 0.19");
    expect(renderStockMail(withZ("bottom", { m: -0.0095, top: 0.2, bottom: -0.0097 }), "en").text).toContain("\n  MACD = −0.0095; bottom of the pane = −0.0097; 90% of it = −0.0087; 96% of it = −0.0093");
    const bare: IndicatorSignal = { ...inSig(I_BUY), ride: undefined };
    expect(renderStockMail(bare, "ja").text).toContain("MACD = —、枠の上の端 = —");
  });
});

describe("#391 the shares' run and the database", () => {
  it("runs every minute as its own mode, reads only its own subscriptions, and the database takes the shares and the rule", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v39-2026-11-12T12:00:00Z";');
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=eq.stockmacd&select=user_id,pair,interval,lang,rule")');
    // the other rules' run does not take them
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm,spike)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('if (body.mode === "stocks") {');
    expect(fn).toContain("stockmacd: { pairs: STOCKMACD_PAIRS, intervals: STOCKMACD_INTERVALS },");
    expect(renderTestMail([{ pair: "AAPL", interval: "1h", rule: "stockmacd" }], "ja").text).toContain("AAPL 1時間足（株の MACD）");
    const mig = readFileSync("supabase/migrations/20261031160000_signal_alert_stockmacd.sql", "utf8");
    expect(mig).toContain("'emarm', 'stockmacd']));");
    for (const s of STOCKMACD_PAIRS) expect(mig).toContain(`'${s}'`);
    const cron = readFileSync("supabase/migrations/20261031160100_stockmacd_sweep.sql", "utf8");
    expect(cron).toContain("'signal-alerts-stocks',\n  '* * * * *',");
    expect(cron).toContain(`body := '{"mode":"stocks"}'::jsonb,`);
  });

  it("#397: the ride of a share is judged in its own try / catch, its mails written from the ride's row; the 95% decision is called nowhere", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    const run = fn.slice(fn.indexOf("const stockSweep = async"), fn.indexOf("const goldTicks = async"));
    // reached: the shared patch of a row still open, then email 2 from the row as it stands
    expect(run).toContain("const row = await reachRide(c.ride, { at: nowMs, bar: c.bar, price: c.price, late: c.late, share: c.share });");
    expect(run).toContain('const sig = rideOutSignal("stockmacd", "1h", row);');
    // email 1: the row first (inserted or already there), the mail from the row
    expect(run).toContain('await sendRide(rideCloseSignal("stockmacd", sym, "1h", "in", entry, { openMs: own.entryBar, closeMs: own.entryClosedAt, mid: own.entryMid, paid: own.entryPrice }), out);');
    expect(run).toContain("settled = await stockRide(sym, step.closed, step.newest, said);");
    // what is logged of a failure holds no address (a lookup's URL holds a follower's id)
    expect(run).toContain('console.error("stockmacd failed:", sym, errText(err));');
    // shares keep no state rows and read no minute
    expect(run).not.toContain("macd_ride_state");
    expect(run).not.toContain("select=*");
    const src = readFileSync("supabase/functions/signal-alerts/stocks.ts", "utf8");
    expect(src.split("\n").filter((l) => l.includes("z95of120") && !l.trimStart().startsWith("//"))).toEqual([]);
    for (const gone of ["decideZoneOnWindow(", "ZONE_PCT", "export const stockmacdSignals", "macdh"]) expect(src, gone).not.toContain(gone);
  });
});

describe("#391 the MACD email on shares in the settings", () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    ok: true,
    allowed: true,
    email_configured: true,
    email: "me@example.com",
    pairs: ["USD/JPY"],
    intervals: ["15min", "1h", "4h", "1day"],
    subscriptions: [],
    alerts: [],
    indicator: {
      rules: INDICATOR_RULES,
      pairs: INDICATOR_PAIRS,
      intervals: INDICATOR_INTERVALS,
      limited: {},
      stockmacd: { pairs: STOCKMACD_PAIRS, intervals: STOCKMACD_INTERVALS },
    },
    ...over,
  });

  it("has its own tab with the 22 shares named on the 1-hour chart, its notes, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      normalizeAlertSettings(body.action === "set" ? payload({ subscriptions: [{ pair: "7203.T", interval: "1h", rule: "stockmacd" }] }) : payload())!
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("株の MACD");
    // #397: the tab describes the ride (the screen's text is src/lib/i18n's; pinned here as it stood when this was written)
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("FX と同じ「MACD の流れ」のメール（2通）を送ります");
    expect(intro).toContain("株の売りは空売りです");
    expect(intro).toContain("株では測っていません。");
    const rows = screen.getByTestId("signal-alerts-grid").querySelectorAll("tbody tr");
    // the shares, and the row for all of them
    expect(rows.length).toBe(STOCKMACD_PAIRS.length + 1);
    expect(screen.getByTestId("signal-alerts-grid").textContent).toContain("7203.Tトヨタ自動車");
    expect(screen.getByTestId("signal-alert-stockmacd-AAPL-1h")).toBeTruthy();
    expect(screen.queryByTestId("signal-alert-stockmacd-AAPL-15min")).toBeNull();
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("損切りも目標もありません。2通目は「96%に届いた」という知らせで、利確の合図とは言えません。");
    expect(notes).toContain("株では測っていません。5ペアで測った数字は、株には当てはまりません。");
    // none of docs §8.133's numbers (the 95% rule's), nor that a price always comes back
    for (const no of ["1,696回", "99.36%", "−1,837.40%", "95%", "必ず戻"]) expect(`${intro}\n${notes}`, no).not.toContain(no);
    fireEvent.click(screen.getByTestId("signal-alert-stockmacd-7203.T-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "7203.T", interval: "1h", on: true, rule: "stockmacd", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-stockmacd-7203.T-1h") as HTMLInputElement).checked).toBe(true));
  });

  it("from a server that does not send its charts: says it is not available yet", async () => {
    const call = vi.fn(async () => normalizeAlertSettings(payload({ indicator: { rules: INDICATOR_RULES, pairs: INDICATOR_PAIRS, intervals: INDICATOR_INTERVALS, limited: {} } }))!);
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-stockmacd-unavailable")).toBeTruthy();
  });
});

// ---- #397: the "stocks" run of the real index.ts over fake tables (spec sections 6 and 7) ---------------------------
//
// (Last in this file: it stubs the clock, the timers and fetch, and puts them back when it is done.)

const SB = "https://sb.test";
const TIME_COLS = new Set(["bar_time", "entry_bar", "entry_closed_at", "reached_at", "reached_bar", "closed_at", "created_at"]);
const world = {
  subs: [] as Row[],
  rides: [] as Row[],
  alerts: [] as Row[],
  sent: [] as Array<{ to: string; subject: string; text: string }>,
  // a closed bar's wick (by its open)
  wicks: new Map<number, { high?: number; low?: number }>(),
  // how far behind the clock Yahoo's answer is (its newest bar and its last trade)
  yahooLag: 0,
  yahooStatus: 200,
  // Yahoo's reads, as "symbol interval range"
  yahoo: [] as string[],
  // followers whose plan lookup fails (a 503); how the rides' table answers (200; 404 when it is not there), and the
  // shares it fails for alone
  failPlanFor: new Set<string>(),
  ridesStatus: 200,
  ridesFailFor: new Set<string>(),
  // the rides' table refuses a new row (a 500)
  ridesNoInsert: false,
  // called once when a ride is about to be patched: another run getting there first, or the table failing from then
  onRidePatch: null as (() => void) | null,
  // every REST read as "table select", every request that no route took
  reads: [] as string[],
  unrouted: [] as string[],
  ids: 0,
};
const resetWorld = () => {
  Object.assign(world, { subs: [], rides: [], alerts: [], sent: [], yahooLag: 0, yahooStatus: 200, yahoo: [], ridesStatus: 200, ridesNoInsert: false, onRidePatch: null, reads: [], unrouted: [], ids: 0 });
  world.wicks.clear();
  world.failPlanFor.clear();
  world.ridesFailFor.clear();
};
let clock = 0;

// A Tokyo share's bars: the same wave in yen (a tenth of a yen, as the chart draws a Tokyo share), seven bars a weekday
// stamped 9:00 … 15:00 JST (00:00 … 06:00 UTC; the 11:00 bar ends at the lunch break, the 15:00 one at 15:30)
const TOKYO = (() => {
  const sym = "7203.T";
  const t: number[] = [];
  for (let day = Date.UTC(2025, 5, 2); t.length < N; day += 24 * H) {
    const wd = new Date(day).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (let h = 0; h < 7 && t.length < N; h++) t.push(day + h * H);
  }
  return { sym, times: t, ends: t.map((x) => stockBarEnd(sym, x)), closes: Array.from({ length: N }, (_, i) => Number((3000 + 100 * wave(i)).toFixed(1))) };
})();

// Yahoo's hourly answer at the clock (less its lag): a year of bars at most (1,750), each bar opened by then, the one
// still forming flat at its open, and Yahoo's last trade then. Every US share is given the same bars, a Tokyo share
// TOKYO's.
const yahooAnswer = (sym: string) => {
  const seen = clock - world.yahooLag;
  const S = sym.endsWith(".T") ? TOKYO : { times, ends, closes };
  let last = -1;
  for (let k = 0; k < N && S.times[k] <= seen; k++) last = k;
  const ts: number[] = [];
  const q = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[] };
  for (let k = Math.max(0, last - 1749); k <= last; k++) {
    const open = k > 0 ? S.closes[k - 1] : S.closes[k];
    const close = S.ends[k] <= seen ? S.closes[k] : open;
    const w = world.wicks.get(S.times[k]) ?? {};
    ts.push(S.times[k] / 1000);
    q.open.push(open);
    q.high.push(Math.max(open, close, w.high ?? -Infinity));
    q.low.push(Math.min(open, close, w.low ?? Infinity));
    q.close.push(close);
    q.volume.push(1000);
  }
  return { chart: { result: [{ meta: { symbol: sym, gmtoffset: -14400, regularMarketPrice: q.close[q.close.length - 1], regularMarketTime: Math.floor(seen / 1000) }, timestamp: ts, indicators: { quote: [q] } }] } };
};

// PostgREST's filters, as far as the run uses them
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
  const val = unquote(expr.slice(dot + 1));
  if (op === "eq") return (r) => r[col] !== null && r[col] !== undefined && same(col, r[col], val);
  if (op === "gte" || op === "lt") {
    return (r) => {
      if (r[col] === null || r[col] === undefined) return false;
      const d = TIME_COLS.has(col) ? Date.parse(String(r[col])) - Date.parse(val) : Number(r[col]) - Number(val);
      return op === "gte" ? d >= 0 : d < 0;
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
  if (url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")) {
    const u = new URL(url);
    const sym = decodeURIComponent(u.pathname.split("/").pop()!);
    world.yahoo.push(`${sym} ${u.searchParams.get("interval")} ${u.searchParams.get("range")}`);
    return world.yahooStatus === 200 ? reply(yahooAnswer(sym)) : reply({}, world.yahooStatus);
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
  if (table === "signal_alerts") {
    if (method === "GET") return reply(world.alerts.filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      const key = (r: Row) => [r.user_id, r.kind, r.pair, r.interval, Date.parse(String(r.bar_time)), r.side, r.rule].join("|");
      if (world.alerts.some((r) => key(r) === key(body))) return reply([], 201);
      const row = { ...body, id: `alert-${++world.ids}` };
      world.alerts.push(row);
      return reply([{ id: row.id }], 201);
    }
    if (method === "PATCH") {
      for (const r of world.alerts.filter(where)) Object.assign(r, body);
      return empty(204);
    }
  }
  if (table === "macd_rides") {
    if (method === "PATCH") {
      const hook = world.onRidePatch;
      world.onRidePatch = null;
      hook?.();
    }
    if (world.ridesStatus !== 200) return reply({ message: 'relation "public.macd_rides" does not exist' }, world.ridesStatus);
    const pair = (u.searchParams.get("pair") ?? "").slice(3) || String(body?.pair ?? "");
    if (world.ridesFailFor.has(pair)) return reply({ message: "boom" }, 503);
    if (method === "GET") return reply(world.rides.filter(where).map((r) => pick(r, select)));
    if (method === "POST") {
      if (world.ridesNoInsert) return reply({ message: "boom" }, 500);
      // the primary key (duplicates ignored), then the one open ride a chart and side
      if (world.rides.some((r) => r.pair === body.pair && r.side === body.side && same("entry_bar", r.entry_bar, body.entry_bar))) return empty(201);
      if (world.rides.some((r) => r.pair === body.pair && r.side === body.side && r.status === "open")) {
        return reply({ code: "23505", message: 'duplicate key value violates unique constraint "macd_rides_one_open"' }, 409);
      }
      world.rides.push({ share0: null, reached_at: null, reached_bar: null, seen_price: null, late: null, share1: null, ...body, entry_bar: pg(Date.parse(body.entry_bar)), entry_closed_at: pg(Date.parse(body.entry_closed_at)) });
      return empty(201);
    }
    if (method === "PATCH") {
      const hit = world.rides.filter(where);
      for (const r of hit) Object.assign(r, body, { reached_at: pg(Date.parse(body.reached_at)), reached_bar: pg(Date.parse(body.reached_bar)) });
      return prefer.includes("return=representation") ? reply(hit.map((r) => pick(r, select))) : empty(204);
    }
  }
  world.unrouted.push(`${method} ${table}?${u.searchParams.toString().slice(0, 90)}`);
  return reply([], 200);
};

type Handler = (req: Request) => Promise<Response>;
type Read = Record<string, unknown> & { pair?: string; signals?: string[]; ride?: Record<string, unknown> };
type Summary = Record<string, unknown> & { reads?: Read[] };

describe("#397 the shares' run: the real index.ts replayed over fake tables (spec sections 6 and 7)", () => {
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
    // the function's sleeps (Resend two a second) pass at once, the clock moved on by them
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
  // a run of the "stocks" mode at `when` (a second past the minute)
  const run = async (h: Handler, when: number): Promise<Summary> => {
    clock = when;
    const res = await h(new Request("https://fn.test/signal-alerts", { method: "POST", headers: { "x-sweep-token": "tok", "Content-Type": "application/json" }, body: JSON.stringify({ mode: "stocks" }) }));
    expect(res.status).toBe(200);
    const text = await res.text();
    // no run's record holds a follower, an address or a row id
    for (const no of ["userA", "userB", "userC", "example.test", "alert-", "user_id"]) expect(text, no).not.toContain(no);
    return JSON.parse(text) as Summary;
  };
  const fresh = async (when: number) => run(await instance(), when);
  // `minute` minutes and a second after bar i closed
  const after = (i: number, minute: number) => closeOf(i) + minute * MIN + 1_000;
  const follow = (user: string, pair = SYM) => ({ user_id: user, pair, interval: "1h", lang: "ja", rule: "stockmacd" });
  const readOf = (s: Summary, pair = SYM): Read | undefined => (s.reads ?? []).find((r) => r.pair === pair);
  const mails = () => world.sent.map((m) => `${m.to.split("@")[0]}: ${m.subject}`);
  const alertsOf = (rule: string) => world.alerts.filter((r) => r.rule === rule);
  const IN_SUBJECT = (side: "買い（BUY）" | "売り（SELL）") => `【Sextant】アップル（AAPL） 1時間足 ${side}で入る合図（株の MACD・1通目）`;
  const OUT_SUBJECT = (side: "買い" | "売り") => `【Sextant】アップル（AAPL） 1時間足 96%に届きました（株の MACD・2通目、${side}の分）`;
  const AT_SUBJECT = "【Sextant】アップル（AAPL） 1時間足 知らせ: もう96%です（株の MACD・入る合図なし）";
  // nothing the run asked for went unanswered; no read took every column, none read an alert's error, and a share
  // keeps no state rows
  const clean = () => {
    expect(world.unrouted).toEqual([]);
    for (const r of world.reads) {
      expect(r, r).not.toMatch(/ \*$/);
      expect(r, r).not.toContain("error");
      if (r.startsWith("signal_alerts ")) expect(r).toBe("signal_alerts user_id");
      if (r.startsWith("macd_rides ")) expect(r).toBe(`macd_rides ${MACD_RIDE_COLUMNS}`);
      expect(r.startsWith("macd_ride_state")).toBe(false);
    }
    for (const y of world.yahoo) expect(y).toMatch(/^[A-Z0-9.]+ 60m 1y$/);
  };

  it("an entry at a close: the ride's row, email 1 with the row's numbers under email 1's id; the same close judged again by fresh instances opens no second ride and mails nobody twice, and a follower whose lookup failed gets email 1 from a later run", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.failPlanFor.add("userB");
    const s0 = await fresh(after(I_BUY, 0));
    expect(s0).toMatchObject({ ok: true, mode: "stocks", version: "signal-alerts-v39-2026-11-12T12:00:00Z", subscriptions: 2, sent: 1, not_allowed: 1 });
    // (the follower whose lookup failed got no row: said, with no name)
    expect(readOf(s0)).toMatchObject({
      pair: SYM, due: iso(closeOf(I_BUY)), bars: 1749, newest: dt(times[I_BUY]), close: closes[I_BUY], judged: true, signals: ["stockmacd:BUY"],
      ride: { rows: "ok", caught: [], step: "in", unsent: ["in(not_allowed)"] },
    });
    // the ride: one row, open, the price paid the bar's close, the line's share
    const e = entryAt(I_BUY)!;
    expect(world.rides).toHaveLength(1);
    expect(world.rides[0]).toMatchObject({
      pair: SYM, side: "BUY", status: "open", entry_bar: pg(times[I_BUY]), entry_closed_at: pg(closeOf(I_BUY)), entry_price: closes[I_BUY], entry_mid: closes[I_BUY],
      share0: shareOf(e.z, e.zside), reached_at: null,
    });
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`]);
    expect(world.sent[0].text).toContain(`\nこの足の終値: ${closes[I_BUY].toFixed(2)}ドル`);
    expect(world.sent[0].text).toContain(`\n  MACD = ${e.z.m.toFixed(2)}、枠の上の端 = ${e.z.top.toFixed(2)}（その90% = ${(RIDE_IN_SHARE * e.z.top).toFixed(2)}、96% = ${(RIDE_OUT_SHARE * e.z.top).toFixed(2)}）`);
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({
      user_id: "userA", kind: "signal", pair: SYM, interval: "1h", bar_time: iso(times[I_BUY]), closed_at: iso(closeOf(I_BUY)), side: "BUY",
      entry: closes[I_BUY], stop: null, target: null, rule: STOCKMACD_RULE_ID, status: "sent",
    });
    // the next five minutes, a fresh instance each, the lookup working: the same bar judged again
    world.failPlanFor.clear();
    for (let m = 1; m <= 5; m++) {
      const s = await fresh(after(I_BUY, m));
      expect(readOf(s), `minute ${m}`).toMatchObject({ judged: true, newest: dt(times[I_BUY]), signals: ["stockmacd:BUY"], ride: { rows: "ok", caught: [], step: "in" } });
      expect(readOf(s)!.ride).not.toHaveProperty("unsent");
      expect(s.sent ?? 0, `minute ${m}`).toBe(m === 1 ? 1 : 0);
    }
    expect(world.rides).toHaveLength(1);
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`, `userB: ${IN_SUBJECT("買い（BUY）")}`]);
    // the same numbers in both mails (the second written from the row the first run made)
    expect(world.sent[1].text).toBe(world.sent[0].text);
    expect(alertsOf(STOCKMACD_RULE_ID).map((r) => r.user_id)).toEqual(["userA", "userB"]);
    expect(world.alerts).toHaveLength(2);
    // Yahoo was read once a run, a year of hourly bars
    expect(world.yahoo).toEqual(Array(6).fill("AAPL 60m 1y"));
    clean();
  });

  it("the reach by the CLOSE, not by the high: reached at the first later close at 96%, by one patch of a row still open; email 2 from the row to every follower once, a follower whose lookup failed within the 45 minutes after, not later", async () => {
    world.subs = [follow("userA"), follow("userB")];
    // bar I_BUY + 1's high touches 96% (the pairs' ride would be reached there); its close does not
    world.wicks.set(times[I_BUY + 1], { high: WICK });
    await fresh(after(I_BUY, 0));
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`, `userB: ${IN_SUBJECT("買い（BUY）")}`]);
    for (const n of [I_BUY + 1, I_BUY + 2]) {
      const s = await fresh(after(n, 0));
      expect(readOf(s), `bar ${n}`).toMatchObject({ newest: dt(times[n]), judged: true, signals: [], ride: { rows: "ok", caught: [], step: null } });
      expect(world.rides[0].status).toBe("open");
    }
    expect(world.sent).toHaveLength(2);
    // the next day's first close: the line is at 96% of the top. One follower's lookup fails in this run
    world.failPlanFor.add("userB");
    const s3 = await fresh(after(J_BUY, 0));
    expect(readOf(s3)).toMatchObject({
      newest: dt(times[J_BUY]), judged: true, signals: ["stockmacd-out:BUY"],
      ride: { rows: "ok", step: null, caught: [{ side: "BUY", entry_bar: iso(times[I_BUY]), reached_bar: iso(times[J_BUY]), late: false }], unsent: ["out(not_allowed)"] },
    });
    const z = zAt(J_BUY);
    expect(world.rides).toHaveLength(1);
    expect(world.rides[0]).toMatchObject({
      status: "reached", reached_at: pg(after(J_BUY, 0)), reached_bar: pg(times[J_BUY]), seen_price: closes[J_BUY], late: false, share1: z.m / z.top,
      entry_bar: pg(times[I_BUY]), entry_price: closes[I_BUY],
    });
    expect(mails().slice(2)).toEqual([`userA: ${OUT_SUBJECT("買い")}`]);
    // email 2's row: under the ride's ENTRY bar and email 2's id, closed_at when it was seen, the entry price, the price when seen
    expect(alertsOf(STOCKMACD_OUT_RULE_ID)).toHaveLength(1);
    expect(alertsOf(STOCKMACD_OUT_RULE_ID)[0]).toMatchObject({
      user_id: "userA", kind: "signal", pair: SYM, interval: "1h", bar_time: iso(times[I_BUY]), closed_at: iso(after(J_BUY, 0)), side: "BUY",
      entry: closes[I_BUY], stop: null, target: closes[J_BUY], status: "sent",
    });
    const text = world.sent[2].text;
    expect(text).toContain(`1通目: 2026-05-20 03:30（日本時間）に確定した足で買い（BUY）。その足の終値 ${closes[I_BUY].toFixed(2)}ドル`);
    expect(text).toContain("\n届いたのを見た時刻: 2026-05-20 23:30（日本時間）。その時の最新の確定足の終値で見ました");
    expect(text).toContain("\n今の値段: 217.45ドル（最新の確定足の終値）");
    expect(text).toContain("\n1通目からの損益: +1.01ドル（+0.47%）。終値と終値の比べです");
    // a minute later, a fresh instance, the lookup working: the ride is reached already; the follower left gets the
    // same mail, from the row
    world.failPlanFor.clear();
    const s4 = await fresh(after(J_BUY, 1));
    expect(readOf(s4)).toMatchObject({ judged: true, signals: ["stockmacd-out:BUY"], ride: { rows: "ok", caught: [], step: null } });
    expect(readOf(s4)!.ride).not.toHaveProperty("unsent");
    expect(mails().slice(3)).toEqual([`userB: ${OUT_SUBJECT("買い")}`]);
    expect(world.sent[3].text).toBe(text);
    expect(world.rides[0].reached_at).toBe(pg(after(J_BUY, 0)));
    // judged again and again: nothing new
    for (const m of [2, 3, 15, 30]) await fresh(after(J_BUY, m));
    expect(world.sent).toHaveLength(4);
    expect(world.rides).toHaveLength(1);
    expect(alertsOf(STOCKMACD_OUT_RULE_ID).map((r) => r.user_id)).toEqual(["userA", "userB"]);
    // an hour on (the next close), a follower who has no row is not mailed: the 45 minutes are over
    world.subs.push(follow("userC"));
    const s5 = await fresh(after(J_BUY + 1, 0));
    expect(readOf(s5)).toMatchObject({ newest: dt(times[J_BUY + 1]), judged: true, signals: [], ride: { rows: "ok", caught: [], step: null } });
    expect(world.sent).toHaveLength(4);
    clean();
  });

  it("late: a reach whose close was not read is found at the next close, in the bar it was reached in, at the newest closed bar's price; and a bar read more than 45 minutes after it ended is late too", async () => {
    world.subs = [follow("userA")];
    world.rides = [rowOf("BUY", I_BUY)];
    // no run in J_BUY's half hour; the next close
    const s0 = await fresh(after(J_BUY + 1, 0));
    expect(readOf(s0)).toMatchObject({
      newest: dt(times[J_BUY + 1]), signals: ["stockmacd-out:BUY"],
      ride: { rows: "ok", step: null, caught: [{ side: "BUY", entry_bar: iso(times[I_BUY]), reached_bar: iso(times[J_BUY]), late: true }] },
    });
    expect(world.rides[0]).toMatchObject({ status: "reached", reached_bar: pg(times[J_BUY]), reached_at: pg(after(J_BUY + 1, 0)), late: true, seen_price: closes[J_BUY + 1] });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("買い")}`]);
    expect(world.sent[0].text).toContain("\n2026-05-20 23:30（日本時間）に確定した足で、もう96%以上でした。その時は読めず、今見つけました（2026-05-21 00:30、日本時間）");
    expect(world.sent[0].text).toContain(`\n今の値段: ${closes[J_BUY + 1].toFixed(2)}ドル（最新の確定足の終値）`);
    expect(alertsOf(STOCKMACD_OUT_RULE_ID)[0]).toMatchObject({ bar_time: iso(times[I_BUY]), target: closes[J_BUY + 1] });
    clean();

    // Yahoo twenty minutes behind at the next close: its newest closed bar is still J_BUY, ended an hour ago
    resetWorld();
    world.subs = [follow("userA")];
    world.rides = [rowOf("BUY", I_BUY)];
    world.yahooLag = 20 * MIN;
    const s1 = await fresh(after(J_BUY + 1, 0));
    expect(readOf(s1)).toMatchObject({
      newest: dt(times[J_BUY]), judged: true, signals: ["stockmacd-out:BUY"],
      ride: { rows: "ok", step: null, fresh: false, caught: [{ side: "BUY", reached_bar: iso(times[J_BUY]), late: true }] },
    });
    expect(world.rides[0]).toMatchObject({ status: "reached", reached_bar: pg(times[J_BUY]), late: true, seen_price: closes[J_BUY] });
    expect(world.sent).toHaveLength(1);
    // once Yahoo has the bar due, it is judged; the ride is reached already and nobody is mailed twice
    const s2 = await fresh(after(J_BUY + 1, 21));
    expect(readOf(s2)).toMatchObject({ newest: dt(times[J_BUY + 1]), judged: true, signals: ["stockmacd-out:BUY"], ride: { caught: [], step: null } });
    expect(world.sent).toHaveLength(1);
    clean();
  });

  it("two runs reaching the same ride: one transition, the numbers of the run that made it in the mail, one email 2 a follower", async () => {
    world.subs = [follow("userA")];
    world.rides = [rowOf("BUY", I_BUY)];
    // another run (begun a minute earlier, by its clock) gets there between this run's read and its patch
    const theirs = { status: "reached", reached_at: pg(after(J_BUY, 0)), reached_bar: pg(times[J_BUY]), seen_price: closes[J_BUY], late: false, share1: 0.97 };
    world.onRidePatch = () => Object.assign(world.rides[0], theirs);
    const s0 = await fresh(after(J_BUY, 1));
    expect(world.onRidePatch).toBeNull();
    expect(world.rides[0]).toMatchObject(theirs);
    expect(readOf(s0)).toMatchObject({ signals: ["stockmacd-out:BUY"], ride: { caught: [{ side: "BUY", reached_bar: iso(times[J_BUY]), late: false }] } });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("買い")}`]);
    // the mail and its row carry the other run's time, not this run's
    expect(alertsOf(STOCKMACD_OUT_RULE_ID)[0]).toMatchObject({ closed_at: iso(after(J_BUY, 0)), target: closes[J_BUY] });
    expect(world.sent[0].text).toContain("\n届いたのを見た時刻: 2026-05-20 23:30（日本時間）");
    await fresh(after(J_BUY, 2));
    expect(world.sent).toHaveLength(1);
    clean();
  });

  it("both sides open at once: a SELL entry while a BUY is held opens its own ride, and each is reached on its own side", async () => {
    world.subs = [follow("userA")];
    world.rides = [rowOf("BUY", OLD_BUY)];
    const s0 = await fresh(after(I_SELL, 0));
    expect(readOf(s0)).toMatchObject({ signals: ["stockmacd:SELL"], ride: { rows: "ok", caught: [], step: "in" } });
    expect(world.rides.map((r) => [r.side, r.status, r.entry_bar])).toEqual([["BUY", "open", pg(times[OLD_BUY])], ["SELL", "open", pg(times[I_SELL])]]);
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("売り（SELL）")}`]);
    // a SELL on a share is said to be a short sale
    expect(world.sent[0].text).toContain("株の売りは空売りです。");
    const s1 = await fresh(after(I_SELL + 1, 0));
    expect(readOf(s1)).toMatchObject({ signals: [], ride: { caught: [], step: null } });
    // the SELL is reached at J_SELL's close; the BUY stays open
    const s2 = await fresh(after(J_SELL, 0));
    expect(readOf(s2)).toMatchObject({ signals: ["stockmacd-out:SELL"], ride: { step: null, caught: [{ side: "SELL", entry_bar: iso(times[I_SELL]), reached_bar: iso(times[J_SELL]), late: false }] } });
    expect(world.rides.map((r) => [r.side, r.status])).toEqual([["BUY", "open"], ["SELL", "reached"]]);
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("売り（SELL）")}`, `userA: ${OUT_SUBJECT("売り")}`]);
    // a SELL from 197.80 seen at 197.23: +0.57 dollars
    expect([closes[I_SELL], closes[J_SELL]]).toEqual([197.8, 197.23]);
    expect(world.sent[1].text).toContain("\n1通目からの損益: +0.57ドル（+0.29%）。終値と終値の比べです");
    clean();
  });

  it("a ride reached at a bar that is also an already entry of its side: email 2 and no notice (quiet), however often the bar is judged; with no ride the same bar is a notice, once", async () => {
    world.subs = [follow("userA")];
    world.rides = [rowOf("SELL", I_HELD)];
    const q0 = await fresh(after(J_HELD, 0));
    expect(readOf(q0)).toMatchObject({ signals: ["stockmacd-out:SELL"], ride: { rows: "ok", step: "quiet", caught: [{ side: "SELL", entry_bar: iso(times[I_HELD]), reached_bar: iso(times[J_HELD]), late: false }] } });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("売り")}`]);
    expect(alertsOf(STOCKMACD_AT_RULE_ID)).toEqual([]);
    expect(world.rides).toHaveLength(1);
    for (const m of [1, 2, 3]) expect(readOf(await fresh(after(J_HELD, m)))).toMatchObject({ signals: ["stockmacd-out:SELL"], ride: { step: "quiet", caught: [] } });
    expect(world.sent).toHaveLength(1);
    expect(world.alerts.map((r) => r.rule)).toEqual([STOCKMACD_OUT_RULE_ID]);
    clean();

    // no ride: the notice, under its own id, and no ride is opened
    resetWorld();
    world.subs = [follow("userA")];
    const n0 = await fresh(after(J_HELD, 0));
    expect(readOf(n0)).toMatchObject({ signals: ["stockmacd-at:SELL"], ride: { rows: "ok", step: "at", caught: [] } });
    expect(mails()).toEqual([`userA: ${AT_SUBJECT}`]);
    expect(world.rides).toEqual([]);
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({ rule: STOCKMACD_AT_RULE_ID, bar_time: iso(times[J_HELD]), closed_at: iso(closeOf(J_HELD)), side: "SELL", entry: closes[J_HELD], stop: null, target: null });
    for (const m of [1, 2, 3]) expect(readOf(await fresh(after(J_HELD, m)))).toMatchObject({ signals: ["stockmacd-at:SELL"], ride: { step: "at" } });
    expect(world.sent).toHaveLength(1);
    clean();
  });

  it("an entry while an older ride of that side is open is skipped: no ride, no mail; the older ride's email 2 names its own entry bar", async () => {
    world.subs = [follow("userA")];
    world.rides = [rowOf("SELL", OLD_SELL)];
    for (const m of [0, 1, 2]) {
      const s = await fresh(after(I_SELL, m));
      expect(readOf(s), `minute ${m}`).toMatchObject({ judged: true, signals: [], ride: { rows: "ok", caught: [], step: "skip" } });
    }
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    // the older ride is reached at J_SELL's close
    await fresh(after(I_SELL + 1, 0));
    const s2 = await fresh(after(J_SELL, 0));
    expect(readOf(s2)).toMatchObject({ signals: ["stockmacd-out:SELL"], ride: { caught: [{ side: "SELL", entry_bar: iso(times[OLD_SELL]), reached_bar: iso(times[J_SELL]), late: false }] } });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("売り")}`]);
    expect(alertsOf(STOCKMACD_OUT_RULE_ID)[0]).toMatchObject({ bar_time: iso(times[OLD_SELL]), entry: closes[OLD_SELL], target: closes[J_SELL] });
    expect(alertsOf(STOCKMACD_RULE_ID)).toEqual([]);
    clean();
    // without the older ride the same bar is an entry (the check above can fail)
    resetWorld();
    world.subs = [follow("userA")];
    expect(readOf(await fresh(after(I_SELL, 0)))).toMatchObject({ signals: ["stockmacd:SELL"], ride: { step: "in" } });
  });

  it("an older ride found reached at an earlier close, and the newest bar a new entry of that side: email 2 (seen late) first, then email 1 for the new ride; a follower whose lookups failed gets both from the next run", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.failPlanFor.add("userB");
    world.rides = [rowOf("BUY", LATE_BUY)];
    const s0 = await fresh(after(I_BUY, 0));
    expect(readOf(s0)).toMatchObject({
      signals: ["stockmacd-out:BUY", "stockmacd:BUY"],
      ride: { rows: "ok", step: "in", caught: [{ side: "BUY", entry_bar: iso(times[LATE_BUY]), reached_bar: iso(times[J_LATE]), late: true }], unsent: ["out(not_allowed)", "in(not_allowed)"] },
    });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("買い")}`, `userA: ${IN_SUBJECT("買い（BUY）")}`]);
    expect(world.rides).toHaveLength(2);
    expect(world.rides[0]).toMatchObject({ entry_bar: pg(times[LATE_BUY]), status: "reached", reached_bar: pg(times[J_LATE]), late: true, seen_price: closes[I_BUY] });
    expect(world.rides[1]).toMatchObject({ entry_bar: pg(times[I_BUY]), side: "BUY", status: "open" });
    // the two rows of the two mails do not meet (other bar, other rule)
    expect(world.alerts.map((r) => [r.rule, r.bar_time])).toEqual([[STOCKMACD_OUT_RULE_ID, iso(times[LATE_BUY])], [STOCKMACD_RULE_ID, iso(times[I_BUY])]]);
    // judged again by a fresh instance, the lookup working: no second ride; the follower left gets email 1 of the
    // new ride, and email 2 of the old one — which is read now only because it was reached in the last 45 minutes
    // (it is not open, its entry bar has left the newest 100 bars and it was reached in a bar before this one)
    world.failPlanFor.clear();
    const s1 = await fresh(after(I_BUY, 1));
    expect(readOf(s1)).toMatchObject({ signals: ["stockmacd:BUY", "stockmacd-out:BUY"], ride: { step: "in", caught: [] } });
    expect(readOf(s1)!.ride).not.toHaveProperty("unsent");
    expect(world.rides).toHaveLength(2);
    expect(mails().slice(2)).toEqual([`userB: ${IN_SUBJECT("買い（BUY）")}`, `userB: ${OUT_SUBJECT("買い")}`]);
    expect(world.sent[3].text).toBe(world.sent[0].text);
    expect(world.sent[2].text).toBe(world.sent[1].text);
    // and again: nothing twice
    const s2 = await fresh(after(I_BUY, 2));
    expect(readOf(s2)).toMatchObject({ signals: ["stockmacd:BUY", "stockmacd-out:BUY"], ride: { step: "in", caught: [] } });
    expect(world.sent).toHaveLength(4);
    expect(world.alerts).toHaveLength(4);
    clean();
  });

  it("a Tokyo share, Yahoo fifteen minutes behind: the bar is judged a quarter of an hour after it closed, still as an entry; the reach at a later close is not late; yen in both mails", async () => {
    const T = TOKYO;
    const tEntry = (k: number) => rideEntryAt(T.closes.slice(k - 599, k + 1));
    const tAt96 = (k: number, zside: "top" | "bottom") => atShare(rideZoneAt(T.closes.slice(k - 599, k + 1))!, zside, RIDE_OUT_SHARE);
    // the first entry (not already) whose line is at 96% at no close before the one two or more bars on
    let i = -1;
    let j = -1;
    for (let k = 620; k < N - 120 && i < 0; k++) {
      const e = tEntry(k);
      if (!e || e.already || tAt96(k + 1, e.zside)) continue;
      for (let n = k + 2; n <= k + 90 && j < 0; n++) if (tAt96(n, e.zside)) j = n;
      if (j > 0) i = k;
    }
    expect(i).toBeGreaterThan(0);
    const e = tEntry(i)!;
    const sideJa = e.side === "BUY" ? "買い" : "売り";
    world.subs = [follow("userA", T.sym)];
    world.yahooLag = 15 * MIN;
    // at the close itself Yahoo's newest closed bar is the one before: judged, no entry there, and the close is not done
    const s0 = await fresh(T.ends[i] + 1_000);
    expect(readOf(s0, T.sym)).toMatchObject({ due: iso(T.ends[i]), newest: dt(T.times[i - 1]), judged: true, signals: [], ride: { rows: "ok", caught: [], step: null } });
    expect(world.sent).toEqual([]);
    // fifteen minutes on Yahoo has priced past the bar's end: the entry, 15 minutes old, is still mailed
    const s1 = await fresh(T.ends[i] + 15 * MIN + 1_000);
    expect(readOf(s1, T.sym)).toMatchObject({ newest: dt(T.times[i]), close: T.closes[i], judged: true, signals: [`stockmacd:${e.side}`], ride: { rows: "ok", caught: [], step: "in" } });
    expect(readOf(s1, T.sym)!.judged_after_ms).toBeGreaterThanOrEqual(15 * MIN);
    expect(world.rides).toHaveLength(1);
    expect(world.rides[0]).toMatchObject({ pair: T.sym, side: e.side, status: "open", entry_bar: pg(T.times[i]), entry_closed_at: pg(T.ends[i]), entry_price: T.closes[i] });
    expect(mails()).toEqual([`userA: 【Sextant】トヨタ自動車（7203.T） 1時間足 ${sideJa}（${e.side}）で入る合図（株の MACD・1通目）`]);
    expect(world.sent[0].text).toContain(`\nこの足の終値: ${T.closes[i].toFixed(1)}円`);
    expect(world.sent[0].text).toContain("東証の値段は Yahoo では約15分遅れて届くため、このメールは足が確定してから約15分後に送っています（2026-11-06 に測りました）。");
    // the close at which the line is at 96%, read fifteen minutes after it: reached there, not late
    const s2 = await fresh(T.ends[j] + 15 * MIN + 1_000);
    expect(readOf(s2, T.sym)).toMatchObject({
      newest: dt(T.times[j]), signals: [`stockmacd-out:${e.side}`],
      ride: { rows: "ok", caught: [{ side: e.side, entry_bar: iso(T.times[i]), reached_bar: iso(T.times[j]), late: false }] },
    });
    expect(world.rides[0]).toMatchObject({ status: "reached", reached_bar: pg(T.times[j]), late: false, seen_price: T.closes[j] });
    expect(mails().slice(1)).toEqual([`userA: 【Sextant】トヨタ自動車（7203.T） 1時間足 96%に届きました（株の MACD・2通目、${sideJa}の分）`]);
    const pnl = stockRidePnl(T.sym, e.side, T.closes[i], T.closes[j]);
    const sign = pnl.value > 0 ? "+" : pnl.value < 0 ? "−" : "±";
    expect(world.sent[1].text).toContain(`\n今の値段: ${T.closes[j].toFixed(1)}円（最新の確定足の終値）`);
    expect(world.sent[1].text).toContain(`\n1通目からの損益: ${sign}${Math.abs(pnl.value).toFixed(1)}円（${sign}${Math.abs(pnl.pct).toFixed(2)}%）。終値と終値の比べです`);
    expect(world.sent[1].text).not.toContain("その時は読めず");
    expect(alertsOf(STOCKMACD_OUT_RULE_ID)[0]).toMatchObject({ pair: T.sym, bar_time: iso(T.times[i]), entry: T.closes[i], target: T.closes[j] });
    clean();
  });

  it("the rides' table unread: nothing of the ride is done and the record says so; one share's failure does not cost another its judgment", async () => {
    world.subs = [follow("userA")];
    world.ridesStatus = 404;
    const s0 = await fresh(after(I_BUY, 0));
    expect(readOf(s0)).toMatchObject({ pair: SYM, newest: dt(times[I_BUY]), judged: true, signals: [], ride: { rows: "unread" } });
    expect(readOf(s0)!.ride).toEqual({ rows: "unread" });
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    expect(world.rides).toEqual([]);
    expect(s0.sent ?? 0).toBe(0);
    clean();

    // two shares followed, the table failing for one of them
    resetWorld();
    world.subs = [follow("userA"), follow("userA", "MSFT")];
    world.ridesFailFor.add(SYM);
    const s1 = await fresh(after(I_BUY, 0));
    expect(readOf(s1, SYM)).toMatchObject({ signals: [], ride: { rows: "unread" } });
    expect(readOf(s1, "MSFT")).toMatchObject({ signals: ["stockmacd:BUY"], ride: { rows: "ok", step: "in" } });
    expect(mails()).toEqual(["userA: 【Sextant】マイクロソフト（MSFT） 1時間足 買い（BUY）で入る合図（株の MACD・1通目）"]);
    expect(world.rides.map((r) => r.pair)).toEqual(["MSFT"]);
    // the ride's row could not be written: no email 1 without it (said in the record); written by the next run, mailed then
    resetWorld();
    world.subs = [follow("userA")];
    world.ridesNoInsert = true;
    const s2 = await fresh(after(I_BUY, 0));
    expect(readOf(s2)).toMatchObject({ judged: true, signals: [], ride: { rows: "ok", caught: [], step: "in", opened: "no_row" } });
    expect(world.rides).toEqual([]);
    expect(world.sent).toEqual([]);
    expect(world.alerts).toEqual([]);
    world.ridesNoInsert = false;
    expect(readOf(await fresh(after(I_BUY, 1)))).toMatchObject({ signals: ["stockmacd:BUY"], ride: { step: "in" } });
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`]);
    // a reach that could not be written: no email 2 without the row saying so
    resetWorld();
    world.subs = [follow("userA")];
    world.rides = [rowOf("BUY", I_BUY)];
    world.onRidePatch = () => {
      world.ridesFailFor.add(SYM);
    };
    const s3 = await fresh(after(J_BUY, 0));
    expect(readOf(s3)).toMatchObject({ signals: [], ride: { rows: "ok", caught: [{ side: "BUY", reached_bar: iso(times[J_BUY]), error: "not_written" }], step: null } });
    expect(world.rides[0].status).toBe("open");
    expect(world.sent).toEqual([]);
    world.ridesFailFor.clear();
    expect(readOf(await fresh(after(J_BUY, 1)))).toMatchObject({ signals: ["stockmacd-out:BUY"], ride: { caught: [{ side: "BUY", late: false }] } });
    expect(mails()).toEqual([`userA: ${OUT_SUBJECT("買い")}`]);
    // Yahoo failing for a read: said, nothing judged
    resetWorld();
    world.subs = [follow("userA")];
    world.yahooStatus = 429;
    expect((await fresh(after(I_BUY, 0))).reads).toEqual([{ pair: SYM, error: "yahoo_429" }]);
    expect(world.rides).toEqual([]);
  });

  it("an instance kept warm: a bar is held judged (and Yahoo left alone) only once nothing is left to try again — a follower whose lookup failed is mailed by the same instance's next run", async () => {
    world.subs = [follow("userA"), follow("userB")];
    world.failPlanFor.add("userB");
    const h = await instance();
    const s0 = await run(h, after(I_BUY, 0));
    expect(readOf(s0)).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], ride: { step: "in", unsent: ["in(not_allowed)"] } });
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`]);
    // the next minute, the same instance, the lookup working: read and judged again
    world.failPlanFor.clear();
    const s1 = await run(h, after(I_BUY, 1));
    expect(readOf(s1)).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], ride: { step: "in" } });
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`, `userB: ${IN_SUBJECT("買い（BUY）")}`]);
    expect(world.yahoo).toHaveLength(2);
    // nothing left: the close is done for this instance — Yahoo is not read again in its half hour
    for (const m of [2, 3, 10]) expect((await run(h, after(I_BUY, m))).reads).toEqual([]);
    expect(world.yahoo).toHaveLength(2);
    expect(world.rides).toHaveLength(1);
    expect(world.sent).toHaveLength(2);
    // the next close is read again
    const s5 = await run(h, after(I_BUY + 1, 0));
    expect(readOf(s5)).toMatchObject({ judged: true, newest: dt(times[I_BUY + 1]), signals: [], ride: { rows: "ok", step: null } });
    expect(world.yahoo).toHaveLength(3);
    // a warm instance whose rides' table could not be read tries again the next minute
    resetWorld();
    world.subs = [follow("userA")];
    world.ridesStatus = 404;
    const g = await instance();
    expect(readOf(await run(g, after(I_BUY, 0)))).toMatchObject({ judged: true, ride: { rows: "unread" } });
    world.ridesStatus = 200;
    expect(readOf(await run(g, after(I_BUY, 1)))).toMatchObject({ judged: true, signals: ["stockmacd:BUY"], ride: { rows: "ok", step: "in" } });
    expect(mails()).toEqual([`userA: ${IN_SUBJECT("買い（BUY）")}`]);
    clean();
  });

  it("nobody follows a share under 'stockmacd': nothing is read; a bar judged over 45 minutes after it ended starts no ride", async () => {
    const s0 = await fresh(after(I_BUY, 0));
    expect(s0).toMatchObject({ ok: true, mode: "stocks", subscriptions: 0 });
    expect(s0.reads).toBeUndefined();
    expect(world.yahoo).toEqual([]);
    expect(world.reads).toEqual(["signal_alert_subscriptions user_id,pair,interval,lang,rule"]);
    // Yahoo twenty minutes behind at the close after I_BUY's: the newest closed bar is I_BUY, ended an hour ago
    resetWorld();
    world.subs = [follow("userA")];
    world.yahooLag = 20 * MIN;
    const s1 = await fresh(after(I_BUY + 1, 0));
    expect(readOf(s1)).toMatchObject({ newest: dt(times[I_BUY]), judged: true, signals: [], ride: { rows: "ok", caught: [], step: null, fresh: false } });
    expect(world.rides).toEqual([]);
    expect(world.sent).toEqual([]);
    clean();
  });
});
