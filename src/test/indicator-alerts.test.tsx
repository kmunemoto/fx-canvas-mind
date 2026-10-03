import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, type RenderResult } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { ANCHOR_WINDOW, anchoredStart } from "../lib/qTrend";
import { historyBefore, normalizeLiveRead, normalizeHistory } from "../lib/liveChart";
import { HISTORY_BARS, READ_BARS, historyRead, liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import {
  ALERT_TWELVE_CAP,
  FAST_START_MS,
  INDICATOR_INTERVALS,
  QTREND_RULE_ID,
  STALE_RETRY_MS,
  STALE_TRIES,
  ULTRA_RULE_ID,
  breakEvenPct,
  freshFor,
  gmoIntervalsDue,
  gmoMadeAt,
  hourCloseOf,
  indicatorIntervalsFor,
  indicatorSignals,
  isGmoChartPair,
  isIndicatorChart,
  keepableKlines,
  klineFileEnded,
  klineFileOf,
  latestCloseMs,
  renderIndicatorMail,
  staleForClose,
  startWaitMs,
  TWELVE_RETRY_MS,
  twelveCloseDue,
  twelvePhase,
  twelveReadDue,
  ultraUnit,
} from "../../supabase/functions/signal-alerts/indicators";
import { LIVE_PAIRS as SERVER_PAIRS, TWELVE_CAPS, TWELVE_CAP_REST, TWELVE_DAILY_LIMIT, TWELVE_FX_PAIRS } from "../../supabase/functions/live-chart/logic";
import { klineUrl } from "../../supabase/functions/track-outcomes/quotes";
import { pipSize } from "../lib/candleTime";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const H = 3_600_000;
// a multiple of 200 hours from 1970-01-01 UTC
const G = 200 * H * 2475;
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// 900 hourly bars from 50 hours before a multiple (a slow wave, a trend, a
// quicker wave for ULTRA's RSI to reach 30 and 70, and noise). Started at
// bar 50 (the multiple before #155's rule) Q-Trend's labels in the last 120
// fall elsewhere (805 SELL rather than 808, 864 a STRONG BUY rather than 865)
const N = 900;
const bars = Array.from({ length: N }, (_, i) => {
  const base = 100 + 4 * Math.sin(i / 37) + 0.012 * i + 1.6 * Math.sin(i / 6) + 0.3 * Math.sin(i * 1.7) + 0.2 * Math.cos(i * 0.61);
  const open = base + 0.15 * Math.sin(i * 2.3);
  const close = base;
  return {
    datetime: stamp(G - 50 * H + i * H),
    open,
    high: Math.max(open, close) + 0.2 + 0.1 * Math.abs(Math.sin(i * 0.9)),
    low: Math.min(open, close) - 0.2 - 0.1 * Math.abs(Math.cos(i * 1.1)),
    close,
  };
});
const times = bars.map((b) => Date.parse(b.datetime.replace(" ", "T") + "Z"));

describe("#155 where Q-Trend and ULTRA start: counted from the newest bar judged on", () => {
  it("the bar ANCHOR_WINDOW − 1 before the newest, however far back the bars held reach", () => {
    expect(ANCHOR_WINDOW).toBe(600);
    // the newest bar is 899: counted from bar 300 (G + 250 h), the next
    // multiple is G + 400 h, bar 450
    expect(anchoredStart(times, H, 780, 200, 899)).toBe(450);
    // the same bars held from bar 300 on (a chart opened now): the same bar
    expect(anchoredStart(times.slice(300), H, 480, 200, 599) + 300).toBe(450);
    // and from bar 120
    expect(anchoredStart(times.slice(120), H, 660, 200, 779) + 120).toBe(450);
    // before #155 the first bar held decided: bar 0, the multiple at bar 50
    expect(anchoredStart(times, H, 780, 200, 899, N)).toBe(50);
    // the newest bar judged, not the newest held (a forming bar and the
    // bars the prices made since are not judged on)
    expect(anchoredStart(times, H, 780, 200, 897)).toBe(450);
    expect(anchoredStart(times, H, 780, 200, 849)).toBe(250);
    // fewer bars than the window: the first bar held, as before
    expect(anchoredStart(times.slice(0, 400), H, 280, 200, 399)).toBe(50);
  });

  it("on the chart: a chart left open with the history it read long ago draws the same Q-Trend and ULTRA labels as the chart opened now", () => {
    const labels = () =>
      [...document.querySelectorAll("[data-testid^='chart-qtrend-signal-'], [data-testid^='chart-ultra-signal-']")].map(
        (g) => `${g.getAttribute("data-testid")}@${g.querySelector("rect")!.getAttribute("x")}`,
      );
    const candles = bars.slice(780);
    // opened now: its history is the 600 closed bars before the newest (the
    // 480 before the chart's first bar are kept)
    const fresh = render(<PriceChart candles={candles} pair="USD/JPY" zoneShiftHistory={{ bars: bars.slice(300, 780), status: "ready" }} />);
    const now = labels();
    fresh.unmount();
    // left open: its history, read 300 bars ago, reaches back to bar 0
    render(<PriceChart candles={candles} pair="USD/JPY" zoneShiftHistory={{ bars: bars.slice(0, 780), status: "ready" }} />);
    expect(now.filter((l) => l.startsWith("chart-qtrend")).length).toBeGreaterThan(0);
    expect(now.filter((l) => l.startsWith("chart-ultra")).length).toBeGreaterThan(0);
    expect(labels()).toEqual(now);
  });

  it("on the chart: the bars not judged on yet (the forming one, those the prices made) do not move the start", () => {
    // each label with the candle it points at (by the candle's x)
    const read = () => {
      const xs = [...document.querySelectorAll("[data-testid='chart-candles'] line")].map((l) => l.getAttribute("x1"));
      return {
        total: document.querySelector("[data-testid='chart-ultra-total']")!.textContent,
        qt: [...document.querySelectorAll("[data-testid^='chart-qtrend-signal-']")].map(
          (g) => `${g.getAttribute("data-testid")}@${xs.indexOf(g.querySelector("polygon")!.getAttribute("points")!.split(",")[0])}`,
        ),
      };
    };
    // judged up to bar 648: counted from bar 49, one hour before a
    // multiple, so the start is bar 50; three bars more would count from 52
    // and start at bar 250, where Q-Trend's labels in these bars fall
    // elsewhere (539 SELL rather than 542, 620 rather than 616)
    const history = { bars: bars.slice(0, 529), status: "ready" as const };
    const judged = render(<PriceChart candles={bars.slice(529, 649)} pair="USD/JPY" zoneShiftHistory={history} />);
    const want = read();
    judged.unmount();
    render(<PriceChart candles={bars.slice(529, 652)} unjudged={3} formingLast pair="USD/JPY" zoneShiftHistory={history} />);
    expect(want.qt.length).toBeGreaterThan(0);
    expect(read()).toEqual(want);
  });
});

describe("#155 the email's signal is the chart's label", () => {
  const M5 = 5 * 60_000;
  // USD/JPY 5-minute bid/ask bars as GMO serves them: a wave, a trend, a
  // quicker wave and noise, the spread 0.4 pips
  const T = Date.parse("2026-09-29T00:00:00Z");
  const quotes: QuoteCandle[] = Array.from({ length: 800 }, (_, i) => {
    const iso = new Date(T - (760 - i) * M5).toISOString();
    const mid = 157 + 0.4 * Math.sin(i / 37) + 0.0012 * i + 0.16 * Math.sin(i / 6) + 0.03 * Math.sin(i * 1.7) + 0.02 * Math.cos(i * 0.61);
    const open = mid + 0.015 * Math.sin(i * 2.3);
    const hi = Math.max(open, mid) + 0.02 + 0.01 * Math.abs(Math.sin(i * 0.9));
    const lo = Math.min(open, mid) - 0.02 - 0.01 * Math.abs(Math.cos(i * 1.1));
    const side = (d: number) => ({ datetime: iso, open: open + d, high: hi + d, low: lo + d, close: mid + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

  it("at each close, what the sweep judges on the newest bar is what the live chart labels there", () => {
    let seen = { qtrend: 0, ultra: 0, strong: 0, plans: 0 };
    // 120 closes: bar 639 to bar 758 closing, each read a minute later with
    // the next bar forming
    for (let m = 639; m < 759; m++) {
      const now = T - (760 - m) * M5 + M5 + 60_000;
      const upTo = quotes.slice(0, m + 2);
      // the chart: its bars read and its history read, as live-chart serves them
      const read = normalizeLiveRead(liveRead("USD/JPY", "5min", upTo.slice(-(READ_BARS + 1)), now))!;
      const history = normalizeHistory(historyRead("USD/JPY", "5min", upTo.slice(-(HISTORY_BARS + 1)), now))!;
      const view = render(
        <PriceChart
          candles={read.candles}
          pair="USD/JPY"
          formingLast
          unjudged={1}
          zoneShiftHistory={{ bars: historyBefore(history, read.candles), status: "ready" }}
        />,
      );
      const xs = [...document.querySelectorAll("[data-testid='chart-candles'] line")].map((l) => l.getAttribute("x1"));
      const newest = read.candles.length - 2;
      const onChart = [...document.querySelectorAll("[data-testid^='chart-qtrend-signal-'], [data-testid^='chart-ultra-signal-']")]
        .filter((g) => xs.indexOf(g.querySelector("polygon")!.getAttribute("points")!.split(",")[0]) === newest)
        .map((g) => g.getAttribute("data-testid")!)
        .sort();
      // #156: the stop and targets the chart draws for its newest Q-Trend signal
      const plan = document.querySelector("[data-testid='chart-qtrend-plan'] title")?.textContent ?? null;
      view.unmount();
      // the sweep: the same history, judged by the alert code
      const barTime = new Date(T - (760 - m) * M5).toISOString();
      const judged = indicatorSignals("USD/JPY", "5min", historyRead("USD/JPY", "5min", upTo.slice(-(HISTORY_BARS + 1)), now).candles, now)
        .filter((sg) => sg.barTime === barTime);
      const mailed = judged
        .map((sg) => (sg.rule === "qtrend" ? `chart-qtrend-signal-${sg.side}${sg.strong ? "-strong" : ""}` : `chart-ultra-signal-${sg.side}`))
        .sort();
      expect(mailed, `bar ${m}`).toEqual(onChart);
      // a Q-Trend signal on the newest bar: the email's stop and targets are the chart's
      const q = judged.find((sg) => sg.rule === "qtrend");
      if (q) {
        const f = (v: number) => v.toFixed(3);
        expect(plan, `bar ${m}`).toBe(
          `Q-Trend ${q.side === "BUY" ? "買い" : "売り"}（損切り・利確は ULTRA と同じ数字）: エントリー ${f(q.close)}・損切り ${f(q.sl!)}・TP1 ${f(q.tps![0])}・TP2 ${f(q.tps![1])}・TP3 ${f(q.tps![2])}`,
        );
      }
      seen = {
        qtrend: seen.qtrend + mailed.filter((x) => x.includes("qtrend")).length,
        ultra: seen.ultra + mailed.filter((x) => x.includes("ultra")).length,
        strong: seen.strong + mailed.filter((x) => x.includes("strong")).length,
        plans: seen.plans + (q ? 1 : 0),
      };
    }
    // the stretch has both indicators' signals, a STRONG among them
    expect(seen.qtrend).toBeGreaterThan(2);
    expect(seen.ultra).toBeGreaterThan(1);
    expect(seen.strong).toBeGreaterThan(0);
    expect(seen.plans).toBe(seen.qtrend);
  }, 60_000);

  it("the same where the chart's history holds fewer than 600 bars (GMO's daily bars: two years' files)", () => {
    const D = 24 * 3_600_000;
    const T = Date.parse("2026-09-29T00:00:00Z");
    const daily: QuoteCandle[] = Array.from({ length: 470 }, (_, i) => {
      const iso = new Date(T - (460 - i) * D).toISOString();
      const mid = 150 + 6 * Math.sin(i / 37) + 0.01 * i + 2.4 * Math.sin(i / 6) + 0.5 * Math.sin(i * 1.7);
      const open = mid + 0.2 * Math.sin(i * 2.3);
      const side = (d: number) => ({ datetime: iso, open: open + d, high: Math.max(open, mid) + 0.3 + d, low: Math.min(open, mid) - 0.3 + d, close: mid + d });
      return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
    });
    let seen = 0;
    for (let m = 420; m < 460; m++) {
      const now = T - (460 - m) * D + D + 60_000;
      const upTo = daily.slice(0, m + 2);
      const read = normalizeLiveRead(liveRead("USD/JPY", "1day", upTo.slice(-(READ_BARS + 1)), now))!;
      const history = historyRead("USD/JPY", "1day", upTo.slice(-(HISTORY_BARS + 1)), now);
      expect(history.candles.length).toBeLessThan(600);
      const view = render(
        <PriceChart candles={read.candles} pair="USD/JPY" formingLast unjudged={1} zoneShiftHistory={{ bars: historyBefore(normalizeHistory(history)!, read.candles), status: "ready" }} />,
      );
      const xs = [...document.querySelectorAll("[data-testid='chart-candles'] line")].map((l) => l.getAttribute("x1"));
      const onChart = [...document.querySelectorAll("[data-testid^='chart-qtrend-signal-'], [data-testid^='chart-ultra-signal-']")]
        .filter((g) => xs.indexOf(g.querySelector("polygon")!.getAttribute("points")!.split(",")[0]) === read.candles.length - 2)
        .map((g) => g.getAttribute("data-testid")!)
        .sort();
      view.unmount();
      const barTime = new Date(T - (460 - m) * D).toISOString();
      const mailed = indicatorSignals("USD/JPY", "1day", history.candles, now)
        .filter((sg) => sg.barTime === barTime)
        .map((sg) => (sg.rule === "qtrend" ? `chart-qtrend-signal-${sg.side}${sg.strong ? "-strong" : ""}` : `chart-ultra-signal-${sg.side}`))
        .sort();
      expect(mailed, `day ${m}`).toEqual(onChart);
      seen += mailed.length;
    }
    expect(seen).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe("#155 what the sweep reads, and when", () => {
  it("every pair the chart has, on 5 minutes to daily; those read from Twelve Data on 1 hour and up only", () => {
    expect(INDICATOR_INTERVALS).toEqual(["5min", "15min", "1h", "4h", "1day"]);
    for (const p of SERVER_PAIRS) {
      const twelve = p === "XAU/USD" || (TWELVE_FX_PAIRS as readonly string[]).includes(p);
      expect(indicatorIntervalsFor(p), p).toEqual(twelve ? ["1h", "4h", "1day"] : ["5min", "15min", "1h", "4h", "1day"]);
      expect(isGmoChartPair(p), p).toBe(!twelve);
    }
    // #175: the yen pairs and gold; #177: and EUR/USD, #178: and AUD/USD, from GMO;
    // #180: and USD/CAD, from Twelve Data
    expect(SERVER_PAIRS).toHaveLength(21);
    expect(isIndicatorChart("USD/CAD", "5min")).toBe(false);
    expect(isIndicatorChart("USD/CAD", "1h")).toBe(true);
    expect(isGmoChartPair("USD/CAD")).toBe(false);
    expect(isIndicatorChart("EUR/USD", "5min")).toBe(true);
    expect(isIndicatorChart("AUD/USD", "5min")).toBe(true);
    expect(isIndicatorChart("USD/JPY", "5min")).toBe(true);
    expect(isIndicatorChart("HKD/JPY", "5min")).toBe(false);
    expect(isIndicatorChart("HKD/JPY", "1h")).toBe(true);
    // a pair taken away, on any timeframe: not followed (#175)
    for (const iv of INDICATOR_INTERVALS) {
      expect(isIndicatorChart("GBP/USD", iv)).toBe(false);
      expect(isIndicatorChart("USD/CHF", iv)).toBe(false);
    }
    expect(isIndicatorChart("XAU/USD", "15min")).toBe(false);
    expect(isIndicatorChart("USD/JPY", "1min")).toBe(false);
    expect(isIndicatorChart("CNH/JPY", "1h")).toBe(false);
    // the settings each alert was judged at
    expect(QTREND_RULE_ID).toBe("qtrend_200_14_1_v1");
    expect(ULTRA_RULE_ID).toBe("ultra_rsi14_30_70_sl10_tp5_10_15_v1");
  });

  it("ULTRA's stop and targets in the chart's units: pips on a pair, dollars on gold", () => {
    for (const p of SERVER_PAIRS) expect(ultraUnit(p), p).toBe(p === "XAU/USD" ? 1 : pipSize(p));
  });

  it("#171: GMO's charts in the minute their bars close, and again later (a minute and three after; the hourly and slower a few minutes into the hour)", () => {
    const at = (m: number) => gmoIntervalsDue(Date.UTC(2026, 8, 29, 10, m, 0));
    expect(at(0)).toEqual(["5min", "15min", "1h", "4h", "1day"]);
    expect(at(1)).toEqual(["5min", "15min"]);
    expect(at(2)).toEqual([]);
    expect(at(3)).toEqual(["5min", "15min", "1h"]);
    expect(at(4)).toEqual(["4h", "1day"]);
    expect(at(5)).toEqual(["5min", "1h"]);
    expect(at(6)).toEqual(["5min", "4h", "1day"]);
    expect(at(8)).toEqual(["5min"]);
    expect(at(15)).toEqual(["5min", "15min"]);
    expect(at(16)).toEqual(["5min", "15min"]);
    expect(at(18)).toEqual(["5min", "15min"]);
    expect(at(31)).toEqual(["5min", "15min"]);
    // every close is read in its own minute: each 5-minute close three times
    const minutes = Array.from({ length: 60 }, (_, m) => m);
    for (const m of minutes.filter((x) => x % 5 === 0)) expect(at(m), `${m}`).toContain("5min");
    for (const m of minutes.filter((x) => x % 15 === 0)) expect(at(m), `${m}`).toContain("15min");
    expect(minutes.filter((m) => at(m).includes("5min"))).toHaveLength(36);
    expect(minutes.filter((m) => at(m).includes("4h"))).toEqual([0, 4, 6]);
  });

  it("#171: the close a read is for — the grid of the chart's length, some hour on the 4-hour and daily charts", () => {
    const t = Date.UTC(2026, 8, 30, 13, 7, 30);
    expect(new Date(latestCloseMs("5min", t)).toISOString()).toBe("2026-09-30T13:05:00.000Z");
    expect(new Date(latestCloseMs("15min", t)).toISOString()).toBe("2026-09-30T13:00:00.000Z");
    expect(new Date(latestCloseMs("1h", t)).toISOString()).toBe("2026-09-30T13:00:00.000Z");
    expect(new Date(latestCloseMs("4h", t)).toISOString()).toBe("2026-09-30T13:00:00.000Z");
    expect(new Date(latestCloseMs("1day", t)).toISOString()).toBe("2026-09-30T13:00:00.000Z");
  });

  it("#171: GMO's answer made before the close, holding the closed bar, is not judged on; one made after it, or holding older bars only, is", () => {
    // USD/JPY's 1-minute answers around 08:30:00 UTC, 2026-09-30 (research/gmo-lag.py, run 36689582649):
    // asked 1.46s after the close, the CDN gave one made 0.24s before it — the 08:29 bar still forming
    const close = Date.UTC(2026, 8, 30, 8, 30, 0);
    const bar = (t: string, c: string) => ({ openTime: String(Date.parse(t)), open: "156.959", high: "156.968", low: "156.94", close: c });
    const before = { status: 0, data: [bar("2026-09-30T08:28:00Z", "156.959"), bar("2026-09-30T08:29:00Z", "156.944")], responsetime: "2026-09-30T08:29:59.760Z" };
    const after = { ...before, data: [...before.data, bar("2026-09-30T08:30:00Z", "156.93")], responsetime: "2026-09-30T08:30:03.660Z" };
    expect(gmoMadeAt(before)).toBe(close - 240);
    expect(staleForClose(before, close, 60_000)).toBe(true);
    expect(staleForClose(after, close, 60_000)).toBe(false);
    // made exactly at the close: fresh
    expect(staleForClose({ ...before, responsetime: "2026-09-30T08:30:00.000Z" }, close, 60_000)).toBe(false);
    // an earlier trading day's file, served from the CDN long after it ended: nothing of this close in it
    const ended = { status: 0, data: [bar("2026-09-29T20:00:00Z", "0.69833")], responsetime: "2026-09-29T21:00:01.739Z" };
    expect(staleForClose(ended, Date.UTC(2026, 8, 30, 12, 0, 0), 3_600_000)).toBe(false);
    // the 4-hour year file made before 12:00 holds the 08:00 bar that closes then
    const year = { status: 0, data: [bar("2026-09-30T04:00:00Z", "156.889"), bar("2026-09-30T08:00:00Z", "156.943")], responsetime: "2026-09-30T11:59:57.000Z" };
    expect(staleForClose(year, Date.UTC(2026, 8, 30, 12, 0, 0), 4 * 3_600_000)).toBe(true);
    // an answer that does not say when it was made is taken as before
    expect(gmoMadeAt({ status: 0, data: before.data })).toBeNull();
    expect(staleForClose({ status: 0, data: before.data }, close, 60_000)).toBe(false);
    expect(gmoMadeAt({ responsetime: "not a time" })).toBeNull();
    expect(gmoMadeAt(null)).toBeNull();
    expect(staleForClose(null, close, 60_000)).toBe(false);
    expect(STALE_RETRY_MS * STALE_TRIES).toBeLessThanOrEqual(10_000);
  });

  it("#171: whether a 4-hour or daily bar closed this hour, from the first pair read", () => {
    const H = 3_600_000;
    const at = (iso: string) => Date.parse(iso);
    // the 08:00 4-hour bar closes at 12:00
    expect(hourCloseOf(at("2026-09-30T08:00:00Z"), "4h", at("2026-09-30T12:00:01Z"))).toBe("closed");
    expect(hourCloseOf(at("2026-09-30T08:00:00Z"), "4h", at("2026-09-30T12:06:00Z"))).toBe("closed");
    // at 13:00 the newest closed at 12:00: none closed this hour
    expect(hourCloseOf(at("2026-09-30T08:00:00Z"), "4h", at("2026-09-30T13:00:01Z"))).toBe("none");
    expect(hourCloseOf(at("2026-09-30T08:00:00Z"), "4h", at("2026-09-30T15:59:59Z"))).toBe("none");
    // a read that stopped at last year's file, or one whose newest bar is
    // still Friday's on Monday morning: not told (#182: GMO's Sunday 20:00 bar
    // is kept now, and closes at Monday 00:00 — src/test/weekend-gmo.test.ts)
    expect(hourCloseOf(at("2025-12-31T20:00:00Z"), "4h", at("2026-09-30T12:00:01Z"))).toBe("unknown");
    expect(hourCloseOf(at("2026-09-25T16:00:00Z"), "4h", at("2026-09-28T00:00:01Z"))).toBe("unknown");
    expect(hourCloseOf(at("2026-09-27T20:00:00Z"), "4h", at("2026-09-28T00:00:01Z"))).toBe("closed");
    // a bar that has not closed by the hour (a clock behind): not told either
    expect(hourCloseOf(at("2026-09-30T12:00:00Z"), "4h", at("2026-09-30T12:00:01Z"))).toBe("unknown");
    // the daily bar that closes at GMO's roll
    expect(hourCloseOf(at("2026-09-28T21:00:00Z"), "1day", at("2026-09-29T21:00:02Z"))).toBe("closed");
    expect(hourCloseOf(at("2026-09-28T21:00:00Z"), "1day", at("2026-09-30T08:00:00Z"))).toBe("none");
    expect(hourCloseOf(Number.NaN, "4h", at("2026-09-30T12:00:01Z"))).toBe("unknown");
    expect(hourCloseOf(at("2026-09-30T08:00:00Z"), "2h", at("2026-09-30T12:00:01Z"))).toBe("unknown");
    expect(4 * H).toBe(14_400_000);
  });

  it("#171: a run waits until a second into its minute; one started just before the minute waits for the next", () => {
    const m = Date.UTC(2026, 8, 30, 12, 0, 0);
    expect(FAST_START_MS).toBe(1_000);
    expect(startWaitMs(m + 300)).toBe(700);
    expect(startWaitMs(m)).toBe(1_000);
    expect(startWaitMs(m + 1_000)).toBe(0);
    expect(startWaitMs(m + 1_500)).toBe(0);
    expect(startWaitMs(m + 30_000)).toBe(0);
    expect(startWaitMs(m - 1_500)).toBe(2_500);
    expect(startWaitMs(m - 2_100)).toBe(0);
  });

  it("Twelve Data's bars from a minute after their close, within their freshness", () => {
    const h = Date.UTC(2026, 8, 29, 10, 0, 0);
    expect(twelveCloseDue("1h", h + 30_000)).toBeNull();
    expect(twelveCloseDue("1h", h + 60_000)).toBe(h);
    expect(twelveCloseDue("1h", h + 29 * 60_000)).toBe(h);
    expect(twelveCloseDue("1h", h + 31 * 60_000)).toBeNull();
    // 4 hours: where the bars start (Twelve Data's at 01:00, 05:00 ... UTC)
    const at = (hh: number, mm: number) => Date.UTC(2026, 8, 28, hh, mm, 0);
    expect(twelveCloseDue("4h", at(20, 5), H)).toBeNull();
    expect(twelveCloseDue("4h", at(21, 1), H)).toBe(at(21, 0));
    expect(twelveCloseDue("4h", at(21, 31), H)).toBeNull();
    expect(twelveCloseDue("4h", at(20, 5))).toBe(at(20, 0));
    expect(twelveCloseDue("1day", Date.UTC(2026, 8, 29, 0, 10, 0))).toBe(Date.UTC(2026, 8, 29, 0, 0, 0));
    expect(freshFor("5min")).toBe(10 * 60_000);
    expect(freshFor("15min")).toBe(20 * 60_000);
    expect(freshFor("1h")).toBe(30 * 60_000);
    // the alerts read past the chart's caps, under the key's day
    expect(ALERT_TWELVE_CAP).toBeGreaterThan(Math.max(TWELVE_CAP_REST, ...Object.values(TWELVE_CAPS)));
    expect(ALERT_TWELVE_CAP).toBeLessThan(TWELVE_DAILY_LIMIT);
  });

  it("where Twelve Data's bars start, from the bars themselves", () => {
    // as stored in production, 2026-09-28 (USD/CAD 4h; the hourly; a daily bar as parsed)
    expect(twelvePhase([{ datetime: "2026-09-28 13:00:00" }, { datetime: "2026-09-28 17:00:00" }], "4h")).toBe(H);
    expect(twelvePhase([{ datetime: "2026-09-28 19:00:00" }], "1h")).toBe(0);
    expect(twelvePhase([{ datetime: "2026-09-28 00:00:00" }], "1day")).toBe(0);
    expect(twelvePhase([{ datetime: "2026-11-02 02:00:00" }], "4h")).toBe(2 * H);
    expect(twelvePhase([], "4h")).toBeNull();
  });

  it("reads a close from Twelve Data twice at most, whichever instance runs", () => {
    const close = Date.UTC(2026, 8, 28, 21, 0, 0);
    const m = 60_000;
    // not read since the close (or read before the bar could be there)
    expect(twelveReadDue(close, Number.NaN, close + m)).toBe(true);
    expect(twelveReadDue(close, close - 3 * H, close + m)).toBe(true);
    expect(twelveReadDue(close, close + 30_000, close + m)).toBe(true);
    // read a minute after and the bar was not there: once more, three minutes on
    expect(twelveReadDue(close, close + m, close + 2 * m)).toBe(false);
    expect(twelveReadDue(close, close + m, close + m + TWELVE_RETRY_MS)).toBe(true);
    // read again and still not there: no more
    expect(twelveReadDue(close, close + 4 * m, close + 8 * m)).toBe(false);
    expect(twelveReadDue(close, close + 4 * m, close + 29 * m)).toBe(false);
  });

  it("keeps a GMO file once its day (or year) has ended, and only a sound answer", () => {
    const f = klineFileOf(klineUrl("USD_JPY", "bid", "5min", "20260928"))!;
    expect(f).toEqual({ symbol: "USD_JPY", priceType: "BID", interval: "5min", date: "20260928" });
    expect(klineFileOf(klineUrl("USD_JPY", "ask", "4hour", "2025"))).toEqual({ symbol: "USD_JPY", priceType: "ASK", interval: "4hour", date: "2025" });
    expect(klineFileOf("https://forex-api.coin.z.com/public/v1/ticker")).toBeNull();
    // the day's file of 09-28 (06:00 or 07:00 JST to the next) has ended by 09:00 JST on 09-29
    expect(klineFileEnded("20260928", Date.parse("2026-09-28T23:59:00Z"))).toBe(false);
    expect(klineFileEnded("20260928", Date.parse("2026-09-29T00:00:00Z"))).toBe(true);
    expect(klineFileEnded("2025", Date.parse("2026-01-01T12:00:00Z"))).toBe(false);
    expect(klineFileEnded("2025", Date.parse("2026-01-02T00:00:00Z"))).toBe(true);
    expect(klineFileEnded("2026", Date.parse("2026-09-29T00:00:00Z"))).toBe(false);
    expect(keepableKlines({ status: 0, data: [] })).toBe(true);
    expect(keepableKlines({ status: 0, data: [{ openTime: "1" }] })).toBe(true);
    expect(keepableKlines({ status: 5, messages: [{ message_code: "ERR-5201" }] })).toBe(false);
    expect(keepableKlines(null)).toBe(false);
  });

  it("judges nothing on fewer bars than Q-Trend's first line needs", () => {
    const M5 = 5 * 60_000;
    const T = Date.parse("2026-09-29T00:00:00Z");
    const few = Array.from({ length: 200 }, (_, i) => ({ datetime: new Date(T + i * M5).toISOString().slice(0, 19).replace("T", " "), open: 1, high: 1.1, low: 0.9, close: 1 + (i === 199 ? 0.5 : 0) }));
    expect(indicatorSignals("USD/JPY", "5min", few, T + 200 * M5 + 60_000)).toEqual([]);
  });

  it("an ULTRA signal carries its entry, stop and targets; a Q-Trend one the line it broke", () => {
    const M5 = 5 * 60_000;
    const T = Date.parse("2026-09-29T00:00:00Z");
    const bars = Array.from({ length: 700 }, (_, i) => {
      const mid = 157 + 0.4 * Math.sin(i / 37) + 0.0012 * i + 0.16 * Math.sin(i / 6) + 0.03 * Math.sin(i * 1.7);
      const r = (v: number) => Number(v.toFixed(3));
      return { datetime: new Date(T + i * M5).toISOString().slice(0, 19).replace("T", " "), open: r(mid - 0.01), high: r(mid + 0.03), low: r(mid - 0.03), close: r(mid) };
    });
    // judged at each close in turn, every signal of the last 100 bars
    const all = Array.from({ length: 100 }, (_, k) => 600 + k).flatMap((n) =>
      indicatorSignals("USD/JPY", "5min", bars.slice(0, n), T + n * M5 + 60_000).filter((sg) => sg.barTime === new Date(T + (n - 1) * M5).toISOString()),
    );
    const ul = all.find((sg) => sg.rule === "ultra")!;
    const dir = ul.side === "BUY" ? 1 : -1;
    // #166: a currency pair's stop 30 pips; #173: its targets 20, 40 and 60
    expect(ul.sl).toBeCloseTo(ul.close - dir * 0.3, 9);
    expect(ul.tps![0]).toBeCloseTo(ul.close + dir * 0.2, 9);
    expect(ul.tps![1]).toBeCloseTo(ul.close + dir * 0.4, 9);
    expect(ul.tps![2]).toBeCloseTo(ul.close + dir * 0.6, 9);
    expect(ul.side === "BUY" ? ul.rsi! > 30 && ul.rsiPrev! <= 30 : ul.rsi! < 70 && ul.rsiPrev! >= 70).toBe(true);
    const qt = all.find((sg) => sg.rule === "qtrend")!;
    expect(qt.line).not.toBeNull();
    expect(qt.eps).toBeGreaterThan(0);
    // #156: ULTRA's numbers — the stop 30 pips on a pair (#166), the targets 20, 40 and 60 (#173)
    const qd = qt.side === "BUY" ? 1 : -1;
    expect(qt.sl).toBeCloseTo(qt.close - qd * 0.3, 9);
    expect(qt.tps!.map((v) => (v - qt.close) * qd)).toEqual([0.2, 0.4, 0.6].map((d) => expect.closeTo(d, 9)));
    expect(all.filter((sg) => sg.rule === "qtrend").every((sg) => sg.sl !== null && sg.tps !== null)).toBe(true);
    // the close broke the line by ε
    expect(qt.side === "BUY" ? qt.close > qt.line! + qt.eps! : qt.close < qt.line! - qt.eps!).toBe(true);
    expect(Date.parse(qt.closedAt) - Date.parse(qt.barTime)).toBe(M5);
  });

  it("#168: a gold signal carries the $10 stop and targets of $30, $60 and $90, on either indicator", () => {
    const H1 = 60 * 60_000;
    const T = Date.parse("2026-09-01T00:00:00Z");
    const bars = Array.from({ length: 700 }, (_, i) => {
      const mid = 4300 + 60 * Math.sin(i / 37) + 0.18 * i + 24 * Math.sin(i / 6) + 4.5 * Math.sin(i * 1.7);
      const r = (v: number) => Number(v.toFixed(2));
      return { datetime: new Date(T + i * H1).toISOString().slice(0, 19).replace("T", " "), open: r(mid - 1.5), high: r(mid + 4.5), low: r(mid - 4.5), close: r(mid) };
    });
    const all = Array.from({ length: 100 }, (_, k) => 600 + k).flatMap((n) =>
      indicatorSignals("XAU/USD", "1h", bars.slice(0, n), T + n * H1 + 60_000).filter((sg) => sg.barTime === new Date(T + (n - 1) * H1).toISOString()),
    );
    for (const rule of ["ultra", "qtrend"] as const) {
      const sg = all.find((x) => x.rule === rule)!;
      expect(sg, rule).toBeTruthy();
      const d = sg.side === "BUY" ? 1 : -1;
      expect(sg.sl).toBeCloseTo(sg.close - d * 10, 9);
      expect(sg.tps!.map((v) => (v - sg.close) * d)).toEqual([30, 60, 90].map((x) => expect.closeTo(x, 9)));
    }
  });

  it("#156/#157: a Q-Trend email carries the stop and targets (ULTRA's numbers) and what they did on its own timeframe", () => {
    const sig = {
      rule: "qtrend" as const, pair: "USD/JPY", interval: "5min", side: "SELL" as const, strong: true,
      barTime: "2026-09-29T02:20:00.000Z", closedAt: "2026-09-29T02:25:00.000Z",
      close: 149.749, line: 149.8, eps: 0.02, rsi: null, rsiPrev: null, sl: 150.049, tps: [149.549, 149.349, 149.149] as [number, number, number],
    };
    const ja = renderIndicatorMail(sig, "ja");
    expect(ja.subject).toBe("【Sextant】USD/JPY 5分足 売り（SELL・STRONG）のサイン（Q-Trend）");
    for (const part of [
      "損切り・利確の目安（ULTRA と同じ数字）:",
      "  エントリー ≈ 149.749",
      "  損切り 150.049（30.0pips）",
      "  利確1 149.549（20.0pips）",
      "  利確2 149.349（40.0pips）",
      "  利確3 149.149（60.0pips）",
      "もともと損切り・利確の目安がないため、ULTRA と同じ数字を付けています",
      // #166: measured at the 30-pip stop; #173: at TP1 20, breaking even
      // needs 30 / (30 + 20)
      "過去の5分足（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 58.0%（損益ゼロには60%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約2.03 pips の負けでした。",
    ]) expect(ja.text).toContain(part);
    expect(ja.text).not.toContain("損切り・利確の目安はありません");
    // #157: no longer "other timeframes have not been measured", nor the older 5-minute figure
    expect(ja.text).not.toContain("測っていません");
    expect(ja.text).not.toContain("2.3〜2.4");
    const en = renderIndicatorMail(sig, "en");
    for (const part of [
      "Stop and targets (ULTRA's numbers):", "  Stop 150.049 (30.0 pips)", "  TP1 149.549 (20.0 pips)", "  TP3 149.149 (60.0 pips)",
      "Measured on past 5-minute bars (January 2024–September 2026, GMO's FX pairs, spread paid), these levels reached TP1 before the stop 58.0% of the time (breaking even needs more than 60%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) lost about 2.03 pips a trade on average.",
    ]) {
      expect(en.text).toContain(part);
    }
    expect(en.text).not.toContain("not been measured");
    // #157: the figures are the email's own timeframe's
    const h4 = renderIndicatorMail({ ...sig, interval: "4h", closedAt: "2026-09-29T08:00:00.000Z", barTime: "2026-09-29T04:00:00.000Z" }, "ja");
    expect(h4.text).toContain("過去の4時間足（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 59.1%");
    expect(h4.text).toContain("約1.17 pips の負けでした。");
    // a pair read from Twelve Data was not measured: said so (#175: a yen
    // pair now; this was EUR/CHF)
    const twelve = renderIndicatorMail({ ...sig, pair: "HKD/JPY", interval: "4h", close: 19.123, sl: 19.423, tps: [18.923, 18.723, 18.523] }, "ja");
    expect(twelve.text).toContain("  損切り 19.423（30.0pips）");
    expect(twelve.text).toContain("HKD/JPY そのものは測っていません（GMO の FX の値です）。");
    expect(renderIndicatorMail({ ...sig, pair: "HKD/JPY", interval: "4h" }, "en").text).toContain("HKD/JPY itself was not measured; these are GMO's FX pairs' figures.");
    expect(h4.text).not.toContain("そのものは測っていません");
    // gold in dollars: the video's $10 stop (#166), the targets $30, $60 and
    // $90 (#168), and what they did, measured on Dukascopy's gold (docs §8.80)
    const goldLv = { close: 4327.15, sl: 4337.15, tps: [4297.15, 4267.15, 4237.15] as [number, number, number] };
    const gold = renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "1h", ...goldLv }, "ja");
    expect(gold.text).toContain("  損切り 4337.15（$10.00）");
    expect(gold.text).toContain("  利確1 4297.15（$30.00）");
    expect(gold.text).toContain("  利確3 4237.15（$90.00）");
    // breaking even needs $10 / ($10 + $30)
    expect(gold.text).toContain("過去の1時間足（2024年1月〜2026年9月、Dukascopy の金の値を Twelve Data と同じ区切りの足にしたもの、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 25.6%（損益ゼロには25%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約0.03ドルの負けでした。");
    expect(gold.text).not.toContain("測っていません");
    expect(gold.text).not.toContain("GMO の FX");
    expect(renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "1h", ...goldLv }, "en").text).toContain(
      "Measured on past 1-hour bars (January 2024–September 2026, Dukascopy's gold prices cut into bars as Twelve Data's, spread paid), these levels reached TP1 before the stop 25.6% of the time (breaking even needs more than 25%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) lost about $0.03 a trade on average.",
    );
    // a gain where it was one: Q-Trend on the 4-hour chart
    expect(renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "4h", ...goldLv }, "ja").text).toContain("利確1に届いたのは 27.2%（損益ゼロには25%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約0.59ドルの勝ちでした。");
    expect(renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "4h", ...goldLv }, "en").text).toContain("made about $0.59 a trade on average.");
    const goldUl = renderIndicatorMail({ ...sig, rule: "ultra", pair: "XAU/USD", interval: "1h", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5, ...goldLv }, "ja");
    expect(goldUl.text).toContain("ULTRA の目安（損切りは動画の設定、利確は30・60・90ドル）:");
    expect(goldUl.text).toContain("動画（金）の勝率は79〜80%で、損切りは10です。金では、このアプリで測ったうえで、利確を30・60・90ドルにしています（動画は5・10・15）。過去の1時間足（2024年1月〜2026年9月、Dukascopy の金の値を Twelve Data と同じ区切りの足にしたもの、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 23.9%");
    expect(goldUl.text).toContain("約0.74ドルの負けでした。");
    expect(goldUl.text).not.toContain("損切りを30pips");
    const goldUlEn = renderIndicatorMail({ ...sig, rule: "ultra", pair: "XAU/USD", interval: "4h", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5, ...goldLv }, "en");
    expect(goldUlEn.text).toContain("ULTRA's levels (the video's stop; the targets $30, $60 and $90):");
    expect(goldUlEn.text).toContain("with a stop of 10. On gold this app sets the targets at $30, $60 and $90 (the video's are 5, 10 and 15), chosen after measuring them. Measured on past 4-hour bars");
    expect(goldUlEn.text).toContain("20.8% of the time");
    expect(goldUlEn.text).toContain("lost about $1.97 a trade");
    // #173: HUF/JPY, about 0.49 yen: a sell's TP3 60 pips (0.60) below would be
    // below zero, and is said to be none
    const huf = { ...sig, rule: "ultra" as const, pair: "HUF/JPY", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5, close: 0.488, sl: 0.788, tps: [0.288, 0.088, -0.112] as [number, number, number] };
    const hufJa = renderIndicatorMail(huf, "ja").text;
    expect(hufJa).toContain("  利確1 0.288（20.0pips）");
    expect(hufJa).toContain("  利確2 0.088（40.0pips）");
    expect(hufJa).toContain("  利確3 —（0より下になるため、この目安はありません）");
    expect(hufJa).not.toContain("-0.112");
    const hufEn = renderIndicatorMail(huf, "en").text;
    expect(hufEn).toContain("  TP3 — (it would be below zero, so there is none)");
    expect(hufEn).not.toContain("-0.112");
    expect(renderIndicatorMail({ ...huf, rule: "qtrend", line: 0.49, eps: 0.001 }, "ja").text).toContain("  利確3 —（0より下になるため、この目安はありません）");
    expect(breakEvenPct(true)).toBe(25);
    expect(breakEvenPct(false)).toBe(60);
    // ULTRA's email: the video's figure beside what was measured on its own timeframe
    const ul = renderIndicatorMail({ ...sig, rule: "ultra", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5 }, "ja");
    expect(ul.text).toContain("ULTRA の目安（利確は20・40・60pips、損切りは30pips）:");
    expect(ul.text).toContain("動画（金）の勝率は79〜80%で、損切りは10です。FX では、損切りを30pips（このアプリで測った結果から）、利確を20・40・60pips（動画は5・10・15）にしています。過去の5分足（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 58.2%");
    expect(ul.text).toContain("約1.81 pips の負けでした。");
    const ul4 = renderIndicatorMail({ ...sig, rule: "ultra", interval: "4h", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5 }, "en");
    expect(ul4.text).toContain("ULTRA's levels (the targets 20, 40 and 60 pips; the stop 30 pips):");
    expect(ul4.text).toContain("The video shows a 79–80% win rate (on gold), with a stop of 10. On currency pairs this app sets the stop at 30 pips (from its own measurements) and the targets at 20, 40 and 60 pips (the video's are 5, 10 and 15). Measured on past 4-hour bars");
    expect(ul4.text).toContain("60.8% of the time");
    expect(ul4.text).toContain("lost about 0.37 pips a trade");
  });
});

describe("#155 the two sweeps keep to their own rules", () => {
  const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
  it("the RSI + SAR sweep reads its two rules' subscriptions only (a rule it does not know is not RSI + SAR)", () => {
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(rsi_sar,gainz)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('typeof r.lang === "string" && isRuleKey(r.rule))');
  });
  it("the indicators sweep reads Q-Trend's and ULTRA's, runs on its own mode, and one at a time", () => {
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('if (body.mode === "indicators") {');
    expect(fn).toContain("if (indicatorSweepRunning) return json(");
  });
  it("Twelve Data's charts are read by where their own bars close, twice a close at most", () => {
    expect(fn).toContain("return phase === undefined ? anHourClosed : twelveCloseDue(c.interval, nowMs, phase) !== null;");
    expect(fn).toContain("if (!twelveReadDue(close, stored ? Date.parse(stored.fetchedAt) : Number.NaN, nowMs)) {");
    expect(fn).not.toContain("twelveCloseDue(c.interval, nowMs) as number");
  });
});
