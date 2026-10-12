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
  INDICATOR_MEASURED,
  MACDH_INTERVALS,
  MACDH_PAIRS,
  MACDH_PIPS,
  MACDH_RULE_ID,
  MACDX_INTERVALS,
  MACDX_PAIRS,
  MACDX_RULE_ID,
  QTREND_RULE_ID,
  STALE_RETRY_MS,
  STALE_TRIES,
  GOLD_MEASURED,
  ULTRA_RULE_ID,
  breakEvenPct,
  freshFor,
  gmoIntervalsDue,
  gmoMadeAt,
  hourCloseOf,
  indicatorIntervalsFor,
  indicatorRuleId,
  indicatorSignals,
  isGmoChartPair,
  isIndicatorChart,
  isIndicatorChartFor,
  isIndicatorRule,
  isMacdhChart,
  isMacdxChart,
  keepableKlines,
  klineFileEnded,
  klineFileOf,
  latestCloseMs,
  macdhLevel,
  macdhSignals,
  macdxSignals,
  renderIndicatorMail,
  staleForClose,
  startWaitMs,
  TWELVE_RETRY_MS,
  twelveChartDue,
  twelveCloseDue,
  twelvePhase,
  twelveReadDue,
  ultraUnit,
} from "../../supabase/functions/signal-alerts/indicators";
import { LIVE_PAIRS as SERVER_PAIRS, TWELVE_CAPS, TWELVE_CAP_REST, TWELVE_DAILY_LIMIT, TWELVE_FX_PAIRS } from "../../supabase/functions/live-chart/logic";
import { klineUrl } from "../../supabase/functions/track-outcomes/quotes";
import { WINDOW as MACDX_WINDOW, decideOnWindow } from "../../supabase/functions/_shared/macd-extreme";
import { LEVEL_WINDOW, decideLevelOnWindow } from "../../supabase/functions/_shared/macd-level";
import { macd } from "../../supabase/functions/_shared/macd";
import { ULTRA_PAIRS, ultraLevels } from "../../supabase/functions/_shared/ultra";
import { pipSize } from "../lib/candleTime";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";

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
  it("every pair the chart has, on 5 minutes to daily; those read from Twelve Data on 1 hour and up only (#212: gold on 15 minutes too)", () => {
    expect(INDICATOR_INTERVALS).toEqual(["5min", "15min", "1h", "4h", "1day"]);
    for (const p of SERVER_PAIRS) {
      const twelve = p === "XAU/USD" || (TWELVE_FX_PAIRS as readonly string[]).includes(p);
      expect(indicatorIntervalsFor(p), p).toEqual(p === "XAU/USD" ? ["15min", "1h", "4h", "1day"] : twelve ? ["1h", "4h", "1day"] : ["5min", "15min", "1h", "4h", "1day"]);
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
    // #212: gold on 15 minutes too (not on 5)
    expect(isIndicatorChart("XAU/USD", "15min")).toBe(true);
    expect(isIndicatorChart("XAU/USD", "5min")).toBe(false);
    expect(isIndicatorChart("HKD/JPY", "15min")).toBe(false);
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

  // #212: a sweep mostly runs on a fresh instance, which has not learned any
  // chart's phase; gold's 15 minutes are then looked at by their own grid, so
  // the :30 and :45 closes are judged as soon as the :00 and :15 ones
  it("#212 which Twelve Data charts a sweep looks at in a minute, on a fresh instance and on one that has seen the bars", () => {
    const h = Date.UTC(2026, 9, 7, 11, 0, 1);
    const minutes = (iv: string, phase: number | undefined) =>
      Array.from({ length: 60 }, (_, m) => m).filter((m) => twelveChartDue(iv, h + m * 60_000, phase));
    const quarter = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const every = [...quarter, ...quarter.map((m) => m + 15), ...quarter.map((m) => m + 30), ...quarter.map((m) => m + 45)];
    // 15 minutes: every quarter hour's close, from a minute after it to its 20 minutes' freshness or the next close
    expect(minutes("15min", undefined)).toEqual(every);
    expect(minutes("15min", 0)).toEqual(every);
    expect(twelveChartDue("15min", h + 31 * 60_000, undefined)).toBe(true);
    expect(twelveChartDue("15min", h + 46 * 60_000, undefined)).toBe(true);
    // an hour and longer, its phase not known: the first half hour of every hour (as before)
    expect(minutes("1h", undefined)).toEqual(Array.from({ length: 29 }, (_, m) => m + 1));
    expect(minutes("4h", undefined)).toEqual(Array.from({ length: 29 }, (_, m) => m + 1));
    // the 4-hour chart, its phase known (bars from 01:00 UTC): only where its own bar closed
    expect(minutes("4h", H)).toEqual([]);
    expect(twelveChartDue("4h", Date.UTC(2026, 9, 7, 13, 1, 1), H)).toBe(true);
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
    // #192: a currency pair's stop 13 pips, its targets 4, 10 and 16
    expect(ul.sl).toBeCloseTo(ul.close - dir * 0.13, 9);
    expect(ul.tps![0]).toBeCloseTo(ul.close + dir * 0.04, 9);
    expect(ul.tps![1]).toBeCloseTo(ul.close + dir * 0.1, 9);
    expect(ul.tps![2]).toBeCloseTo(ul.close + dir * 0.16, 9);
    expect(ul.side === "BUY" ? ul.rsi! > 30 && ul.rsiPrev! <= 30 : ul.rsi! < 70 && ul.rsiPrev! >= 70).toBe(true);
    const qt = all.find((sg) => sg.rule === "qtrend")!;
    expect(qt.line).not.toBeNull();
    expect(qt.eps).toBeGreaterThan(0);
    // #156: ULTRA's numbers — #192's stop 13 pips on a pair, its targets 4, 10 and 16
    const qd = qt.side === "BUY" ? 1 : -1;
    expect(qt.sl).toBeCloseTo(qt.close - qd * 0.13, 9);
    expect(qt.tps!.map((v) => (v - qt.close) * qd)).toEqual([0.04, 0.1, 0.16].map((d) => expect.closeTo(d, 9)));
    expect(all.filter((sg) => sg.rule === "qtrend").every((sg) => sg.sl !== null && sg.tps !== null)).toBe(true);
    // the close broke the line by ε
    expect(qt.side === "BUY" ? qt.close > qt.line! + qt.eps! : qt.close < qt.line! - qt.eps!).toBe(true);
    expect(Date.parse(qt.closedAt) - Date.parse(qt.barTime)).toBe(M5);
  });

  it("#192: a gold signal carries the $13 stop and targets of $4, $10 and $16, on either indicator", () => {
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
      expect(sg.sl).toBeCloseTo(sg.close - d * 13, 9);
      expect(sg.tps!.map((v) => (v - sg.close) * d)).toEqual([4, 10, 16].map((x) => expect.closeTo(x, 9)));
    }
  });

  it("#156/#157: a Q-Trend email carries the stop and targets (ULTRA's numbers) and what they did on its own timeframe", () => {
    // #192: a sell with the levels since, the stop 13 pips above and the targets 4, 10 and 16 below
    const sig = {
      rule: "qtrend" as const, pair: "USD/JPY", interval: "5min", side: "SELL" as const, strong: true,
      barTime: "2026-09-29T02:20:00.000Z", closedAt: "2026-09-29T02:25:00.000Z",
      close: 149.749, line: 149.8, eps: 0.02, rsi: null, rsiPrev: null, sl: 149.879, tps: [149.709, 149.649, 149.589] as [number, number, number],
    };
    const ja = renderIndicatorMail(sig, "ja");
    // #211: the Japanese email names the pair as 楽天FX does; the English one keeps the code
    expect(ja.subject).toBe("【Sextant】ドル/円 5分足 売り（SELL・STRONG）のサイン（Q-Trend）");
    expect(ja.text.split("\n\n")[0]).toBe("ドル/円の5分足で、Q-Trend の売り（SELL・STRONG）のサインが出ました。");
    expect(ja.text).not.toContain("USD/JPY");
    for (const part of [
      "損切り・利確の目安（ULTRA と同じ数字）:",
      "  エントリー ≈ 149.749",
      "  損切り 149.879（13.0pips）",
      "  利確1 149.709（4.0pips）",
      "  利確2 149.649（10.0pips）",
      "  利確3 149.589（16.0pips）",
      "もともと損切り・利確の目安がないため、ULTRA と同じ数字を付けています",
      // #192: measured at the stop 13 and TP1 4 (docs §8.98), breaking even
      // needs 13 / (13 + 4)
      "過去の5分足（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 70.3%（損益ゼロには76%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約2.03 pips の負けでした。",
    ]) expect(ja.text).toContain(part);
    expect(ja.text).not.toContain("損切り・利確の目安はありません");
    // #157: no longer "other timeframes have not been measured", nor the older 5-minute figure
    expect(ja.text).not.toContain("測っていません");
    expect(ja.text).not.toContain("2.3〜2.4");
    const en = renderIndicatorMail(sig, "en");
    for (const part of [
      "Stop and targets (ULTRA's numbers):", "  Stop 149.879 (13.0 pips)", "  TP1 149.709 (4.0 pips)", "  TP3 149.589 (16.0 pips)",
      "Measured on past 5-minute bars (January 2024–September 2026, GMO's FX pairs, spread paid), these levels reached TP1 before the stop 70.3% of the time (breaking even needs more than 76%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) lost about 2.03 pips a trade on average.",
    ]) {
      expect(en.text).toContain(part);
    }
    expect(en.text).not.toContain("not been measured");
    // #157: the figures are the email's own timeframe's
    const h4 = renderIndicatorMail({ ...sig, interval: "4h", closedAt: "2026-09-29T08:00:00.000Z", barTime: "2026-09-29T04:00:00.000Z" }, "ja");
    expect(h4.text).toContain("過去の4時間足（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 73.6%");
    expect(h4.text).toContain("約1.07 pips の負けでした。");
    // a pair read from Twelve Data was not measured: said so (#175: a yen
    // pair now; this was EUR/CHF)
    const twelve = renderIndicatorMail({ ...sig, pair: "HKD/JPY", interval: "4h", close: 19.123, sl: 19.253, tps: [19.083, 19.023, 18.963] }, "ja");
    expect(twelve.text).toContain("  損切り 19.253（13.0pips）");
    expect(twelve.text).toContain("香港ドル/円そのものは測っていません（GMO の FX の値です）。");
    expect(twelve.text).toContain("足は Twelve Data のもの（香港ドル/円は GMOコインにないため）");
    expect(twelve.text).not.toContain("HKD/JPY");
    expect(renderIndicatorMail({ ...sig, pair: "HKD/JPY", interval: "4h" }, "en").text).toContain("HKD/JPY itself was not measured; these are GMO's FX pairs' figures.");
    expect(h4.text).not.toContain("そのものは測っていません");
    // gold in dollars: #192's $13 stop and targets of $4, $10 and $16, and
    // what they did, measured on Dukascopy's gold (docs §8.98)
    const goldLv = { close: 4327.15, sl: 4340.15, tps: [4323.15, 4317.15, 4311.15] as [number, number, number] };
    const gold = renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "1h", ...goldLv }, "ja");
    expect(gold.text).toContain("  損切り 4340.15（$13.00）");
    expect(gold.text).toContain("  利確1 4323.15（$4.00）");
    expect(gold.text).toContain("  利確3 4311.15（$16.00）");
    // breaking even needs $13 / ($13 + $4)
    expect(gold.text).toContain("過去の1時間足（2024年1月〜2026年9月、Dukascopy の金の値を Twelve Data と同じ区切りの足にしたもの、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 75.3%（損益ゼロには76%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約0.50ドルの負けでした。");
    expect(gold.text).not.toContain("測っていません");
    expect(gold.text).not.toContain("GMO の FX");
    expect(renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "1h", ...goldLv }, "en").text).toContain(
      "Measured on past 1-hour bars (January 2024–September 2026, Dukascopy's gold prices cut into bars as Twelve Data's, spread paid), these levels reached TP1 before the stop 75.3% of the time (breaking even needs more than 76%, and more to pay the spread); closing all of it at TP1 or the stop (or after five days, where neither was reached) lost about $0.50 a trade on average.",
    );
    // Q-Trend on the 4-hour chart: a loss now (#168's levels made $0.59 there)
    expect(renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "4h", ...goldLv }, "ja").text).toContain("利確1に届いたのは 73.9%（損益ゼロには76%より上、スプレッドの分さらに上が要ります）で、利確1か損切りで全部決済すると（5日たっても決着しなければその時点で決済）1回あたり平均で約0.68ドルの負けでした。");
    // a gain is said as one: no figure measured now is, so one is set here and put back
    const kept = GOLD_MEASURED.qtrend["4h"];
    try {
      GOLD_MEASURED.qtrend["4h"] = { win: 80.0, usd: 0.59 };
      expect(renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "4h", ...goldLv }, "ja").text).toContain("1回あたり平均で約0.59ドルの勝ちでした。");
      expect(renderIndicatorMail({ ...sig, pair: "XAU/USD", interval: "4h", ...goldLv }, "en").text).toContain("made about $0.59 a trade on average.");
    } finally {
      GOLD_MEASURED.qtrend["4h"] = kept;
    }
    const goldUl = renderIndicatorMail({ ...sig, rule: "ultra", pair: "XAU/USD", interval: "1h", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5, ...goldLv }, "ja");
    expect(goldUl.text).toContain("ULTRA の目安（損切りは13ドル、利確は4・10・16ドル）:");
    expect(goldUl.text).toContain("サインの出し方はその動画のままです。損切り・利確は、F-INVEST のもう一つの動画（上位版・金。表では利確1に届いたのが80〜82%。サインには、このアプリにない絞り込みがあります）のチャートの線に合わせて、損切り13・利確4・10・16（金はドル）にしています。過去の1時間足（2024年1月〜2026年9月、Dukascopy の金の値を Twelve Data と同じ区切りの足にしたもの、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 72.1%");
    expect(goldUl.text).toContain("約1.05ドルの負けでした。");
    expect(goldUl.text).not.toContain("FX は pips");
    const goldUlEn = renderIndicatorMail({ ...sig, rule: "ultra", pair: "XAU/USD", interval: "4h", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5, ...goldLv }, "en");
    expect(goldUlEn.text).toContain("ULTRA's levels (the stop $13; the targets $4, $10 and $16):");
    expect(goldUlEn.text).toContain("its signals have filters this app does not have): the stop 13 and the targets 4, 10 and 16, dollars on gold. Measured on past 4-hour bars");
    expect(goldUlEn.text).toContain("72.5% of the time");
    expect(goldUlEn.text).toContain("lost about $1.02 a trade");
    // #173: a target at or below zero is said to be none (then HUF/JPY at
    // about 0.49 yen, a sell's TP3 60 pips below). #192's 16 pips go below
    // zero only under 0.16 yen, a price no pair mailed has: a made-up 0.13
    const huf = { ...sig, rule: "ultra" as const, pair: "HUF/JPY", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5, close: 0.13, sl: 0.26, tps: [0.09, 0.03, -0.03] as [number, number, number] };
    const hufJa = renderIndicatorMail(huf, "ja").text;
    expect(hufJa).toContain("  利確1 0.090（4.0pips）");
    expect(hufJa).toContain("  利確2 0.030（10.0pips）");
    expect(hufJa).toContain("  利確3 —（0より下になるため、この目安はありません）");
    expect(hufJa).not.toContain("-0.030");
    const hufEn = renderIndicatorMail(huf, "en").text;
    expect(hufEn).toContain("  TP3 — (it would be below zero, so there is none)");
    expect(hufEn).not.toContain("-0.030");
    expect(renderIndicatorMail({ ...huf, rule: "qtrend", line: 0.14, eps: 0.001 }, "ja").text).toContain("  利確3 —（0より下になるため、この目安はありません）");
    // #192: 13 / (13 + 4), on gold and the pairs both
    expect(breakEvenPct(true)).toBe(76);
    expect(breakEvenPct(false)).toBe(76);
    // ULTRA's email: where its levels come from beside what was measured on its own timeframe
    const ul = renderIndicatorMail({ ...sig, rule: "ultra", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5 }, "ja");
    // #211: the owner's 15-minute ULTRA email on EUR/JPY, as 楽天FX names the pair (ユーロ/円), and gold (金)
    const ulEj = renderIndicatorMail({ ...sig, rule: "ultra", pair: "EUR/JPY", interval: "15min", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5 }, "ja");
    expect(ulEj.subject).toBe("【Sextant】ユーロ/円 15分足 売り（Sell ☆）のサイン（ULTRA）");
    expect(ulEj.text.split("\n\n")[0]).toBe("ユーロ/円の15分足で、ULTRA の売り（Sell ☆）のサインが出ました。");
    expect(ulEj.text).not.toContain("EUR/JPY");
    expect(ulEj.html).toContain("ユーロ/円の15分足で");
    expect(goldUl.subject).toBe("【Sextant】金 1時間足 売り（Sell ☆）のサイン（ULTRA）");
    const ulEjEn = renderIndicatorMail({ ...sig, rule: "ultra", pair: "EUR/JPY", interval: "15min", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5 }, "en");
    expect(ulEjEn.subject).toContain("EUR/JPY");
    expect(ulEjEn.subject + ulEjEn.text).not.toContain("ユーロ");
    expect(ul.text).toContain("ULTRA の目安（損切りは13pips、利確は4・10・16pips）:");
    expect(ul.text).toContain("のチャートの線に合わせて、損切り13・利確4・10・16（FX は pips）にしています。過去の5分足（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 71.9%");
    expect(ul.text).toContain("約1.62 pips の負けでした。");
    expect(ul.text).not.toContain("79〜80%");
    const ul4 = renderIndicatorMail({ ...sig, rule: "ultra", interval: "4h", strong: false, line: null, eps: null, rsi: 69.2, rsiPrev: 71.5 }, "en");
    expect(ul4.text).toContain("ULTRA's levels (the stop 13 pips; the targets 4, 10 and 16 pips):");
    expect(ul4.text).toContain("ULTRA is built from F-INVEST's video (its code is not published), and its signals are that video's. Its stop and targets follow the chart of a second F-INVEST video (its premium version, on gold, whose table shows TP1 reached 80–82% of the time; its signals have filters this app does not have): the stop 13 and the targets 4, 10 and 16, pips on currency pairs. Measured on past 4-hour bars");
    expect(ul4.text).toContain("74.5% of the time");
    expect(ul4.text).toContain("lost about 0.94 pips a trade");
  });
});

// #192: the chart's notes carry the emails' measured figures, copied by
// hand: every one of them (40, in each language) as the tables hold them
describe("#192 the chart's notes state the emails' measured figures", () => {
  const TFS = ["5min", "15min", "1h", "4h", "1day"] as const;
  const JA_TF = ["5分足", "15分足", "1時間足", "4時間足", "日足"];
  const EN_TF = ["5-minute bars", "15-minute", "1-hour", "4-hour", "daily"];
  const andList = (xs: string[]) => `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  it("each timeframe's share of TP1 first and loss a trade, FX and gold, Q-Trend and ULTRA, in Japanese and English", () => {
    for (const [rule, key] of [["qtrend", "qTrendNote"], ["ultra", "ultraNote"]] as const) {
      const fx = TFS.map((tf) => INDICATOR_MEASURED[rule][tf]);
      const gold = TFS.map((tf) => GOLD_MEASURED[rule][tf]);
      // every figure a loss now, as the notes word them
      expect([...fx.map((m) => m.pips), ...gold.map((g) => g.usd)].every((v) => v < 0)).toBe(true);
      const jaWins = (ws: number[]) => ws.map((w, k) => `${JA_TF[k]} ${w.toFixed(1)}%`).join("・");
      expect(ja.chart[key]).toContain(`届いたのは ${jaWins(fx.map((m) => m.win))} でした`);
      expect(ja.chart[key]).toContain(`届いたのは ${jaWins(gold.map((g) => g.win))} でした`);
      expect(ja.chart[key]).toContain(`1回あたり平均で ${fx.map((m) => Math.abs(m.pips).toFixed(2)).join("・")} pips の負けです`);
      expect(ja.chart[key]).toContain(`1回あたり平均で ${gold.map((g) => Math.abs(g.usd).toFixed(2)).join("・")} ドルの負けです`);
      const enWins = (ws: number[]) => andList(ws.map((w, k) => `${w.toFixed(1)}%${k === 0 ? " of the time" : ""} on ${EN_TF[k]}`));
      expect(en.chart[key]).toContain(`TP1 came before the stop ${enWins(fx.map((m) => m.win))}`);
      expect(en.chart[key]).toContain(`reached TP1 before the stop ${enWins(gold.map((g) => g.win))}`);
      expect(en.chart[key]).toContain(`lost ${andList(fx.map((m) => Math.abs(m.pips).toFixed(2)))} pips a trade on average`);
      expect(en.chart[key]).toContain(`losing ${andList(gold.map((g) => `$${Math.abs(g.usd).toFixed(2)}`))} a trade on average`);
    }
    // the break-even share the notes give, as the emails work it out
    expect(ja.chart.qTrendNote).toContain(`損益ゼロには${breakEvenPct(false)}%より上`);
    expect(en.chart.qTrendNote).toContain(`breaking even needs more than ${breakEvenPct(true)}%`);
  });
});

describe("#155 the two sweeps keep to their own rules", () => {
  const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
  it("the RSI + SAR sweep reads its two rules' subscriptions only (a rule it does not know is not RSI + SAR)", () => {
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(rsi_sar,gainz)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('typeof r.lang === "string" && isRuleKey(r.rule))');
  });
  it("the indicators sweep reads Q-Trend's, ULTRA's and the MACD rule's, runs on its own mode, and one at a time", () => {
    // #275: the MACD peak-and-valley rule beside the two
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx)&select=user_id,pair,interval,lang,rule")');
    expect(fn).toContain('if (body.mode === "indicators") {');
    expect(fn).toContain("if (indicatorSweepRunning) return json(");
  });
  it("Twelve Data's charts are read by where their own bars close, twice a close at most", () => {
    // #212: chosen by twelveChartDue (tested above), its phase when this instance knows it
    expect(fn).toContain("isTwelvePair(c.pair) && twelveChartDue(c.interval, nowMs, twelvePhaseOf.get(`${c.pair}|${c.interval}`))");
    expect(fn).not.toContain("anHourClosed");
    expect(fn).toContain("if (!twelveReadDue(close, stored ? Date.parse(stored.fetchedAt) : Number.NaN, nowMs)) {");
    expect(fn).not.toContain("twelveCloseDue(c.interval, nowMs) as number");
  });
});

// #275: the MACD peak-and-valley rule (docs §8.109) in the emails
// #324: the 5-minute rule is no longer mailed (v25 mails the 1-hour rule, below, in its place), but
// the studies decide through macdxSignals and isMacdxChart (research/macdx.ts, ownerhold-data.ts,
// chartbest-measures.ts): what they give is held as it was
describe("#275 the 5-minute MACD peak-and-valley rule (mailed in v23 and v24, kept for the studies)", () => {
  const FIVE = 300_000;
  // 2,400 five-minute bars of a pair: a slow wave, a quicker one, a quicker
  // still and noise, so that crosses far from zero and near it both happen
  // (40 fire over bars 599 to 2,399: 18 BUYs and 22 SELLs)
  const M0 = Date.UTC(2026, 8, 1);
  const m5 = Array.from({ length: 2400 }, (_, i) => {
    const base = 150 + 0.9 * Math.sin(i / 90) + 0.35 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7) + 0.03 * Math.sin(i * 1.9) + 0.0004 * i;
    const open = base + 0.02 * Math.sin(i * 2.3);
    const close = base;
    return {
      datetime: stamp(M0 + i * FIVE),
      open,
      high: Math.max(open, close) + 0.03 + 0.01 * Math.abs(Math.sin(i * 0.9)),
      low: Math.min(open, close) - 0.03 - 0.01 * Math.abs(Math.cos(i * 1.1)),
      close,
    };
  });
  const closeMsOf = (i: number) => M0 + (i + 1) * FIVE;
  const fireBars = () => {
    const out: number[] = [];
    for (let i = MACDX_WINDOW - 1; i < m5.length; i++) if (decideOnWindow(m5, i)?.fire) out.push(i);
    return out;
  };
  const windowAt = (i: number) => m5.slice(i - MACDX_WINDOW + 1, i + 1);

  it("is a rule of its own: its id differs from ULTRA's and Q-Trend's, and the app reads it back from the id", () => {
    expect(isIndicatorRule("macdx")).toBe(true);
    expect(isIndicatorRule("macd")).toBe(false);
    // the id its emails were recorded under; #324: the MACD emails' from v25 is the 1-hour rule's
    expect(MACDX_RULE_ID).toBe("macdx_12_26_9_w600_n288_k4_2_v1");
    expect(indicatorRuleId("macdx")).toBe(MACDH_RULE_ID);
    expect(new Set([MACDX_RULE_ID, ULTRA_RULE_ID, QTREND_RULE_ID]).size).toBe(3);
    // src/lib/signalAlerts.ts ruleOfId reads the rule from the start of the id
    expect(MACDX_RULE_ID.startsWith("macdx")).toBe(true);
    expect(ULTRA_RULE_ID.startsWith("macdx")).toBe(false);
  });

  it("is read on the 5-minute chart of GMO's currency pairs, and nowhere else (#324: the subscriptions follow the 1-hour rule's chart)", () => {
    expect([...MACDX_INTERVALS]).toEqual(["5min"]);
    for (const p of ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "GBP/JPY", "MXN/JPY", "NZD/JPY", "ZAR/JPY", "CAD/JPY", "CHF/JPY", "TRY/JPY", "HUF/JPY", "SEK/JPY"]) {
      expect(isMacdxChart(p, "5min")).toBe(true);
      expect(isIndicatorChartFor("macdx", p, "5min")).toBe(false);
      expect(isIndicatorChartFor("macdx", p, "1h")).toBe(MACDH_PAIRS.includes(p));
      expect(isMacdxChart(p, "15min")).toBe(false);
      expect(isMacdxChart(p, "1h")).toBe(false);
    }
    // gold and the pairs read from Twelve Data (GMO has no such bars): not offered (Q-Trend's and ULTRA's still are, on their own timeframes)
    for (const p of ["XAU/USD", "USD/CAD", "HKD/JPY", "SGD/JPY", "NOK/JPY", "PLN/JPY", "CZK/JPY"]) {
      expect(isMacdxChart(p, "5min")).toBe(false);
      expect(isIndicatorChartFor("macdx", p, "5min")).toBe(false);
    }
    expect(isIndicatorChartFor("ultra", "USD/CAD", "1h")).toBe(true);
    expect(isIndicatorChartFor("ultra", "USD/JPY", "5min")).toBe(true);
    expect(isIndicatorChartFor("qtrend", "XAU/USD", "15min")).toBe(true);
    expect(isIndicatorChartFor("macdx", "XAU/USD", "15min")).toBe(false);
    expect(isMacdxChart(undefined, "5min")).toBe(false);
    expect(isMacdxChart("USD/JPY", 5)).toBe(false);
    expect(MACDX_PAIRS.every((p) => isGmoChartPair(p))).toBe(true);
    expect(MACDX_PAIRS).not.toContain("XAU/USD");
    // every pair of the five the study measured is among them
    for (const p of ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"]) expect(MACDX_PAIRS).toContain(p);
  });

  it("gives what the study decides, on the newest bar's 600 closed bars: one signal where the rule fires, none where it does not", () => {
    const fires = fireBars();
    const sides = new Set(fires.map((i) => decideOnWindow(m5, i)!.side));
    expect(fires.length).toBeGreaterThan(20);
    expect(sides).toEqual(new Set(["BUY", "SELL"]));
    for (let i = MACDX_WINDOW - 1; i < m5.length; i++) {
      const d = decideOnWindow(m5, i);
      const sigs = macdxSignals("USD/JPY", "5min", windowAt(i), closeMsOf(i) + 30_000);
      if (d?.fire) {
        expect(sigs, `bar ${i}`).toHaveLength(1);
        const g = sigs[0];
        expect(g.rule).toBe("macdx");
        expect(g.side).toBe(d.side);
        expect(g.pair).toBe("USD/JPY");
        expect(g.interval).toBe("5min");
        expect(g.barTime).toBe(new Date(M0 + i * FIVE).toISOString());
        expect(g.closedAt).toBe(new Date(closeMsOf(i)).toISOString());
        expect(g.close).toBe(m5[i].close);
        // ULTRA's stop 13 and targets 4, 10 and 16 pips from the close
        const lv = ultraLevels(d.side, m5[i].close, 0.01, ULTRA_PAIRS);
        expect(g.sl).toBe(lv.sl);
        expect(g.tps).toEqual(lv.tps);
        expect(g.macd).toEqual({ dir: d.dir, m: d.dir === "DOWN" ? d.x : -d.x, x: d.x, avgRange: d.S / 288, peak: d.P });
        // the three conditions, as the rule states them
        expect(g.macd!.x).toBeGreaterThan(0);
        expect(g.macd!.x / g.macd!.avgRange).toBeGreaterThanOrEqual(0.25);
        expect(g.macd!.x / g.macd!.peak).toBeGreaterThanOrEqual(0.5);
        expect(g.strong).toBe(false);
        expect(g.rsi).toBeNull();
      } else {
        expect(sigs, `bar ${i}`).toEqual([]);
      }
    }
  });

  it("a longer history gives the same decision (the rule reads the newest 600 bars), a shorter one none", () => {
    const i = fireBars()[5];
    const want = macdxSignals("USD/JPY", "5min", windowAt(i), closeMsOf(i) + 30_000);
    expect(want).toHaveLength(1);
    expect(macdxSignals("USD/JPY", "5min", m5.slice(0, i + 1), closeMsOf(i) + 30_000)).toEqual(want);
    expect(macdxSignals("USD/JPY", "5min", windowAt(i).slice(1), closeMsOf(i) + 30_000)).toEqual([]);
    expect(macdxSignals("USD/JPY", "5min", [], closeMsOf(i))).toEqual([]);
  });

  it("is given while its bar is fresh (it closed at most freshFor ago, and not before it closed)", () => {
    const i = fireBars()[3];
    const w = windowAt(i);
    const at = closeMsOf(i);
    expect(freshFor("5min")).toBe(10 * 60_000);
    expect(macdxSignals("USD/JPY", "5min", w, at - 1)).toEqual([]);
    expect(macdxSignals("USD/JPY", "5min", w, at)).toHaveLength(1);
    expect(macdxSignals("USD/JPY", "5min", w, at + 10 * 60_000)).toHaveLength(1);
    expect(macdxSignals("USD/JPY", "5min", w, at + 10 * 60_000 + 1)).toEqual([]);
  });

  it("is not judged on a chart it is not offered on, even on bars where it fires", () => {
    const i = fireBars()[3];
    const w = windowAt(i);
    const at = closeMsOf(i) + 30_000;
    expect(macdxSignals("USD/JPY", "5min", w, at)).toHaveLength(1);
    expect(macdxSignals("USD/JPY", "15min", w, at)).toEqual([]);
    expect(macdxSignals("USD/JPY", "1h", w, at)).toEqual([]);
    expect(macdxSignals("XAU/USD", "5min", w, at)).toEqual([]);
    expect(macdxSignals("USD/CAD", "5min", w, at)).toEqual([]);
    expect(macdxSignals("HKD/JPY", "5min", w, at)).toEqual([]);
  });

  it("indicatorSignals stays what the live chart labels: Q-Trend's and ULTRA's, not the MACD rule's", () => {
    for (const i of fireBars().slice(0, 8)) {
      const sigs = indicatorSignals("USD/JPY", "5min", windowAt(i), closeMsOf(i) + 30_000);
      expect(sigs.every((x) => x.rule === "qtrend" || x.rule === "ultra")).toBe(true);
    }
  });

  it("the migration lets a subscription name the rule, and changes nothing else", () => {
    const sql = readFileSync("supabase/migrations/20261011090000_macdx_alerts.sql", "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).toContain("drop constraint if exists signal_alert_subscriptions_rule_check");
    expect(code).toContain("check (rule = any (array['rsi_sar', 'gainz', 'qtrend', 'ultra', 'macdx']));");
    // only the one constraint: no row is touched, nothing is dropped
    expect(code).not.toMatch(/\b(delete|update|insert|truncate)\b/i);
    expect((code.match(/drop constraint/gi) ?? []).length).toBe(1);
  });
});

// #324 (docs §8.114): the MACD email's rule from v25, the owner's (「上は0.085以上、下は−0.085以下の
// クロスでメールを出して」, on USD/JPY's 1-hour chart): on the 1-hour chart, a SELL where MACD crosses
// below its signal line at or above +8.5 pips, a BUY where it crosses above at or below -8.5 pips
describe("#324 the 1-hour MACD rule (the owner's levels), the MACD email from v25", () => {
  // 2,400 hourly bars of a yen pair, of the waves #275's five-minute bars have (82 crosses over bars
  // 599 to 2,399: 24 at or beyond the level — 9 BUYs and 15 SELLs —, 32 short of it and 26 on the
  // wrong side of zero), and the same in dollars for EUR/USD, a hundredth as far from 1.1
  const H0 = Date.UTC(2026, 6, 1);
  const wave = (i: number) => 0.9 * Math.sin(i / 90) + 0.35 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7) + 0.03 * Math.sin(i * 1.9) + 0.0004 * i;
  const barsOf = (mid: number, scale: number) =>
    Array.from({ length: 2400 }, (_, i) => {
      const close = mid + scale * wave(i);
      const open = close + scale * 0.02 * Math.sin(i * 2.3);
      return {
        datetime: stamp(H0 + i * H),
        open,
        high: Math.max(open, close) + scale * (0.03 + 0.01 * Math.abs(Math.sin(i * 0.9))),
        low: Math.min(open, close) - scale * (0.03 + 0.01 * Math.abs(Math.cos(i * 1.1))),
        close,
      };
    });
  const yen = barsOf(150, 1);
  const usd = barsOf(1.1, 0.01);
  type Bars = typeof yen;
  const closeMsOf = (i: number) => H0 + (i + 1) * H;
  const windowOf = (bars: Bars, i: number) => bars.slice(i - LEVEL_WINDOW + 1, i + 1);
  // The rule told again here, apart from _shared/macd-level.ts: the side of MACD - signal at each
  // bar of the window (none until both lines are there; 0 keeps the side before), a cross where the
  // newest bar's side differs from the one before's, and MACD there held against the level. Null:
  // no cross; "no": a cross that does not fire
  const told = (bars: Bars, i: number, level: number): "BUY" | "SELL" | "no" | null => {
    const r = macd(windowOf(bars, i).map((b) => b.close));
    let before: number | null = null;
    let side: number | null = null;
    for (let k = 0; k < LEVEL_WINDOW; k++) {
      before = side;
      const m = r.macd[k];
      const g = r.signal[k];
      if (m === null || g === null) side = null;
      else if (m - g > 0) side = 1;
      else if (m - g < 0) side = -1;
    }
    if (before === null || side === null || before === side) return null;
    const m = r.macd[LEVEL_WINDOW - 1] as number;
    if (side === -1) return m >= level ? "SELL" : "no";
    return m <= -level ? "BUY" : "no";
  };
  const fires = (bars: Bars, pair: string) => {
    const out: number[] = [];
    for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
      const t = told(bars, i, macdhLevel(pair));
      if (t === "BUY" || t === "SELL") out.push(i);
    }
    return out;
  };

  it("is what the subscriptions under 'macdx' follow from v25: the 1-hour chart of the owner's five pairs, under its own id", () => {
    expect([...MACDH_INTERVALS]).toEqual(["1h"]);
    // 「今の5ペア」, in the app's order
    expect([...MACDH_PAIRS]).toEqual(["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"]);
    for (const p of MACDH_PAIRS) {
      expect(isMacdhChart(p, "1h")).toBe(true);
      expect(isIndicatorChartFor("macdx", p, "1h")).toBe(true);
      for (const iv of ["1min", "5min", "15min", "4h", "1day"]) {
        expect(isMacdhChart(p, iv), `${p} ${iv}`).toBe(false);
        expect(isIndicatorChartFor("macdx", p, iv), `${p} ${iv}`).toBe(false);
      }
    }
    // the other GMO pairs are not offered (the level is the owner's number on USD/JPY's chart),
    // nor gold and the pairs read from Twelve Data
    const others = MACDX_PAIRS.filter((p) => !MACDH_PAIRS.includes(p));
    expect(others).toHaveLength(9);
    for (const p of [...others, "XAU/USD", "USD/CAD", "HKD/JPY", "SGD/JPY", "NOK/JPY", "PLN/JPY", "CZK/JPY"]) {
      expect(isMacdhChart(p, "1h")).toBe(false);
      expect(isIndicatorChartFor("macdx", p, "1h")).toBe(false);
    }
    expect(isMacdhChart(undefined, "1h")).toBe(false);
    expect(isMacdhChart("USD/JPY", 1)).toBe(false);
    // its id: the emails are recorded under it, and the app reads the rule back from its start
    expect(MACDH_RULE_ID).toBe("macdx_12_26_9_w600_1h_lv8.5p_v2");
    expect(indicatorRuleId("macdx")).toBe(MACDH_RULE_ID);
    expect(MACDH_RULE_ID.startsWith("macdx")).toBe(true);
    expect(new Set([MACDH_RULE_ID, MACDX_RULE_ID, ULTRA_RULE_ID, QTREND_RULE_ID]).size).toBe(4);
  });

  it("holds MACD against 8.5 pips, written as the owner put it on USD/JPY: 0.085 on a yen pair, 0.00085 on EUR/USD and AUD/USD", () => {
    expect(MACDH_PIPS).toBe(8.5);
    expect(macdhLevel("USD/JPY")).toBe(0.085);
    expect(macdhLevel("EUR/JPY")).toBe(0.085);
    expect(macdhLevel("AUD/JPY")).toBe(0.085);
    expect(macdhLevel("EUR/USD")).toBe(0.00085);
    expect(macdhLevel("AUD/USD")).toBe(0.00085);
    for (const p of MACDX_PAIRS) expect(macdhLevel(p), p).toBe(p.includes("JPY") ? 0.085 : 0.00085);
  });

  it("mails exactly the crosses at or beyond the level, judged on the newest 600 closed bars (against the rule told again here)", () => {
    for (const [pair, bars] of [["USD/JPY", yen], ["EUR/USD", usd]] as const) {
      const level = macdhLevel(pair);
      const n = { cross: 0, BUY: 0, SELL: 0, no: 0 };
      for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
        const want = told(bars, i, level);
        const sigs = macdhSignals(pair, "1h", windowOf(bars, i), closeMsOf(i) + 30_000);
        if (want !== null) n.cross++;
        if (want === "BUY" || want === "SELL") {
          n[want]++;
          expect(sigs, `${pair} bar ${i}`).toHaveLength(1);
          const g = sigs[0];
          expect(g.rule).toBe("macdx");
          expect(g.side).toBe(want);
          expect(g.pair).toBe(pair);
          expect(g.interval).toBe("1h");
          expect(g.barTime).toBe(new Date(H0 + i * H).toISOString());
          expect(g.closedAt).toBe(new Date(closeMsOf(i)).toISOString());
          expect(g.close).toBe(bars[i].close);
          // ULTRA's stop 13 and targets 4, 10 and 16 pips from the close
          const lv = ultraLevels(want, bars[i].close, ultraUnit(pair), ULTRA_PAIRS);
          expect(g.sl).toBe(lv.sl);
          expect(g.tps).toEqual(lv.tps);
          const r = macd(windowOf(bars, i).map((b) => b.close));
          expect(g.macdh).toEqual({ dir: want === "SELL" ? "DOWN" : "UP", m: r.macd[LEVEL_WINDOW - 1], signal: r.signal[LEVEL_WINDOW - 1], level });
          expect(want === "SELL" ? g.macdh!.m >= level : g.macdh!.m <= -level).toBe(true);
          expect(g.macd).toBeUndefined();
          expect(g.strong).toBe(false);
          expect(g.rsi).toBeNull();
        } else {
          if (want === "no") n.no++;
          expect(sigs, `${pair} bar ${i}`).toEqual([]);
        }
      }
      // both sides fire, and crosses that do not fire are there for the check to fail on
      expect(n, pair).toEqual({ cross: 82, BUY: 9, SELL: 15, no: 58 });
    }
  });

  it("crosses where the 5-minute rule finds its crosses: the two differ only in what they ask of a cross", () => {
    expect(LEVEL_WINDOW).toBe(MACDX_WINDOW);
    let crosses = 0;
    for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
      const a = decideLevelOnWindow(yen, i, macdhLevel("USD/JPY"));
      const b = decideOnWindow(yen, i);
      expect(a === null, `bar ${i}`).toBe(b === null);
      if (a && b) {
        crosses++;
        expect(a.dir, `bar ${i}`).toBe(b.dir);
        expect(a.side, `bar ${i}`).toBe(b.side);
      }
    }
    expect(crosses).toBe(82);
  });

  it("fires at the level itself and not a hair short of it, and never on the wrong side of zero", () => {
    const first = (side: "BUY" | "SELL") => {
      for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
        const d = decideLevelOnWindow(yen, i, 0.085);
        if (d?.fire && d.side === side) return { i, m: d.m };
      }
      throw new Error(`no ${side}`);
    };
    const s = first("SELL");
    expect(decideLevelOnWindow(yen, s.i, s.m)!.fire).toBe(true);
    expect(decideLevelOnWindow(yen, s.i, s.m + 1e-12)!.fire).toBe(false);
    const b = first("BUY");
    expect(decideLevelOnWindow(yen, b.i, -b.m)!.fire).toBe(true);
    expect(decideLevelOnWindow(yen, b.i, -b.m + 1e-12)!.fire).toBe(false);
    // a cross down below zero is no SELL, and a cross up above zero no BUY, at any level (even 0)
    let wrong = 0;
    for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
      const d = decideLevelOnWindow(yen, i, 0);
      if (d && ((d.dir === "DOWN" && d.m < 0) || (d.dir === "UP" && d.m > 0))) {
        wrong++;
        expect(d.fire, `bar ${i}`).toBe(false);
      }
    }
    expect(wrong).toBe(26);
    // fewer bars than the window, or a bar past the end: no decision
    expect(decideLevelOnWindow(yen.slice(0, LEVEL_WINDOW - 1), LEVEL_WINDOW - 2, 0)).toBeNull();
    expect(decideLevelOnWindow(yen, yen.length, 0)).toBeNull();
  });

  it("a longer history gives the same decision (the rule reads the newest 600 bars), a shorter one none", () => {
    const i = fires(yen, "USD/JPY")[5];
    const want = macdhSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000);
    expect(want).toHaveLength(1);
    expect(macdhSignals("USD/JPY", "1h", yen.slice(0, i + 1), closeMsOf(i) + 30_000)).toEqual(want);
    expect(macdhSignals("USD/JPY", "1h", windowOf(yen, i).slice(1), closeMsOf(i) + 30_000)).toEqual([]);
    expect(macdhSignals("USD/JPY", "1h", [], closeMsOf(i))).toEqual([]);
  });

  it("is mailed while its bar is fresh: closed at most half an hour ago (the hourly reads at +0, +3 and +5 minutes), not before", () => {
    const i = fires(yen, "USD/JPY")[3];
    const w = windowOf(yen, i);
    const at = closeMsOf(i);
    expect(freshFor("1h")).toBe(30 * 60_000);
    expect(macdhSignals("USD/JPY", "1h", w, at - 1)).toEqual([]);
    expect(macdhSignals("USD/JPY", "1h", w, at)).toHaveLength(1);
    expect(macdhSignals("USD/JPY", "1h", w, at + 30 * 60_000)).toHaveLength(1);
    expect(macdhSignals("USD/JPY", "1h", w, at + 30 * 60_000 + 1)).toEqual([]);
    for (const m of [0, 3, 5]) expect(gmoIntervalsDue(Date.UTC(2026, 9, 12, 14, m)), `:0${m}`).toContain("1h");
    for (const m of [1, 2, 4, 6, 30]) expect(gmoIntervalsDue(Date.UTC(2026, 9, 12, 14, m)), `:${m}`).not.toContain("1h");
  });

  it("is not judged on a chart it is not offered on, and the two MACD rules keep to their own charts", () => {
    const i = fires(yen, "USD/JPY")[3];
    const w = windowOf(yen, i);
    const at = closeMsOf(i) + 30_000;
    expect(macdhSignals("USD/JPY", "1h", w, at)).toHaveLength(1);
    for (const iv of ["5min", "15min", "4h"]) expect(macdhSignals("USD/JPY", iv, w, at), iv).toEqual([]);
    for (const p of ["XAU/USD", "USD/CAD", "HKD/JPY", "GBP/JPY", "HUF/JPY"]) expect(macdhSignals(p, "1h", w, at), p).toEqual([]);
    // the 5-minute rule's function gives nothing on the hourly chart (the studies call it on 5 minutes)
    expect(macdxSignals("USD/JPY", "1h", w, at)).toEqual([]);
  });

  const sample = (side: "BUY" | "SELL", pair = "USD/JPY") => {
    const bars = pair.includes("JPY") ? yen : usd;
    const i = fires(bars, pair).find((k) => told(bars, k, macdhLevel(pair)) === side)!;
    return macdhSignals(pair, "1h", windowOf(bars, i), closeMsOf(i) + 30_000)[0];
  };

  it("the Japanese email: the cross, MACD and its signal line, the level, ULTRA's levels, that it is not measured, how to stop it", () => {
    const g = sample("SELL");
    const mail = renderIndicatorMail(g, "ja");
    expect(mail.subject).toBe("【Sextant】ドル/円 1時間足 売り（SELL）のサイン（MACD の山・谷）");
    const t = mail.text;
    expect(t).toContain("ドル/円の1時間足で、MACD の山・谷のクロスの売り（SELL）のサインが出ました。");
    expect(t).toContain("MACD(12・26・9)の青線がオレンジ線を上から下に抜けました（高い位置）");
    expect(t).toContain(`MACD = ${g.macdh!.m.toFixed(3)}、シグナル = ${g.macdh!.signal.toFixed(3)}`);
    expect(t).toContain("売りの条件: クロスした時の MACD が +0.085 以上（8.5 pips）");
    expect(t).toContain("損切り・利確の目安（ULTRA と同じ数字）:");
    expect(t).toContain("（13.0pips）");
    expect(t).toContain("利確1");
    expect(t).toContain("1時間足の MACD(12・26・9)のクロスのうち、売りは MACD が +8.5 pips 以上、買いは −8.5 pips 以下の所で起きたものだけを送ります（円のペアは 0.085、ユーロ/ドル・豪ドル/ドルは 0.00085）。");
    expect(t).toContain("数字はアプリのオーナーが決めたもの");
    expect(t).toContain("docs §8.114");
    expect(t).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません。");
    expect(t).toContain("「MACD の山・谷」でチェックを外してください");
    // nothing of the 5-minute rule's: its conditions and its measured figures are another rule's
    for (const no of ["直近288本", "波の頂点", "72.3", "§8.109"]) expect(t, no).not.toContain(no);
    const buy = renderIndicatorMail(sample("BUY"), "ja");
    expect(buy.subject).toBe("【Sextant】ドル/円 1時間足 買い（BUY）のサイン（MACD の山・谷）");
    expect(buy.text).toContain("MACD(12・26・9)の青線がオレンジ線を下から上に抜けました（低い位置）");
    expect(buy.text).toContain("買いの条件: クロスした時の MACD が −0.085 以下（8.5 pips）");
  });

  it("the English email says the same", () => {
    const g = sample("BUY");
    const mail = renderIndicatorMail(g, "en");
    expect(mail.subject).toBe("[Sextant] USD/JPY 1-hour BUY signal (MACD peak/valley)");
    const t = mail.text;
    expect(t).toContain("A MACD peak/valley BUY signal fired on USD/JPY, 1-hour chart.");
    expect(t).toContain("the MACD line (blue) crossed above its signal line (orange), low in the pane");
    // a BUY's MACD and signal line are below zero: the minus is the level's (U+2212), not a hyphen
    expect(g.macdh!.m).toBeLessThan(0);
    expect(t).toContain(`MACD = −${(-g.macdh!.m).toFixed(3)}, signal = −${(-g.macdh!.signal).toFixed(3)}`);
    expect(t).not.toContain("MACD = -");
    expect(t).toContain("A BUY needs MACD at the cross at or below −0.085 (8.5 pips)");
    expect(t).toContain("Stop and targets (ULTRA's numbers):");
    expect(t).toContain("of the 1-hour chart's MACD(12, 26, 9) crosses it mails only a SELL where MACD is at or above +8.5 pips and a BUY where it is at or below −8.5 pips (0.085 on a yen pair, 0.00085 on EUR/USD and AUD/USD)");
    expect(t).toContain("This rule's win rate and its profit or loss a trade have not been measured.");
    expect(t).toContain("untick the chart under MACD peak/valley");
    for (const no of ["288 bars", "wave's peak", "72.3", "§8.109"]) expect(t, no).not.toContain(no);
    expect(renderIndicatorMail(sample("SELL"), "en").text).toContain("crossed below its signal line (orange), high in the pane");
  });

  it("on EUR/USD the level and MACD are in its own digits (0.00085)", () => {
    const g = sample("SELL", "EUR/USD");
    expect(g.macdh!.level).toBe(0.00085);
    const mail = renderIndicatorMail(g, "ja");
    expect(mail.subject).toBe("【Sextant】ユーロ/ドル 1時間足 売り（SELL）のサイン（MACD の山・谷）");
    expect(mail.text).toContain("売りの条件: クロスした時の MACD が +0.00085 以上（8.5 pips）");
    expect(mail.text).toContain(`MACD = ${g.macdh!.m.toFixed(5)}、シグナル = ${g.macdh!.signal.toFixed(5)}`);
    expect(renderIndicatorMail(sample("BUY", "EUR/USD"), "en").text).toContain("A BUY needs MACD at the cross at or below −0.00085 (8.5 pips)");
  });

  it("the sweep judges the subscriptions' charts with it beside Q-Trend's and ULTRA's, and tells the app its charts", () => {
    const fn = readFileSync("supabase/functions/signal-alerts/index.ts", "utf8");
    // a chart is followed under a rule only where that rule is offered
    expect(fn).toContain("const chartOk = indicator ? isIndicatorChartFor(body.rule, body.pair, body.interval)");
    expect(fn).toContain("if (!charts.every((c) => isIndicatorChartFor(rule, c.pair, c.interval)))");
    // (#291: the video's way, 'sweepx', is the gold-ticks run's own, never this sweep's)
    expect(fn).toContain('isIndicatorRule(r.rule) && r.rule !== "sweepx" && isIndicatorChartFor(r.rule, r.pair, r.interval)');
    expect(fn).not.toMatch(/\bisIndicatorChart\(/);
    // judged beside indicatorSignals, mailed with the rule's own id; the 5-minute rule no longer
    expect(fn).toContain("const sigs = indicatorSignals(pair, interval, closed, nowMs);");
    expect(fn).toContain("sigs.push(...macdhSignals(pair, interval, closed, nowMs));");
    expect(fn).not.toContain("macdxSignals(pair");
    // a failure of the MACD rule costs the other two no email
    expect(fn).toMatch(/try \{\s+sigs\.push\(\.\.\.macdhSignals\(pair, interval, closed, nowMs\)\);\s+\} catch \(err\) \{\s+console\.error\("macdx failed:"/);
    expect(fn).toContain("rule: indicatorRuleId(sig.rule),");
    expect(fn).toContain("strong: sig.rule === \"qtrend\" ? sig.strong : null,");
    // the app is told which charts the rule may be followed on
    expect(fn).toContain("macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS },");
    expect(fn).toContain("signal-alerts-v25");
  });

  it("indicatorSignals stays what the live chart labels: Q-Trend's and ULTRA's, not the MACD rule's", () => {
    for (const i of fires(yen, "USD/JPY").slice(0, 8)) {
      const sigs = indicatorSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000);
      expect(sigs.every((x) => x.rule === "qtrend" || x.rule === "ultra")).toBe(true);
    }
  });
});
