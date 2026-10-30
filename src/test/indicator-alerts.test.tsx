import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, type RenderResult } from "@testing-library/react";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { ANCHOR_WINDOW, anchoredStart } from "../lib/qTrend";
import { historyBefore, normalizeLiveRead, normalizeHistory } from "../lib/liveChart";
import { CHART_BARS, HISTORY_BARS, READ_BARS, historyRead, liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import {
  ALERT_TWELVE_CAP,
  FAST_START_MS,
  INDICATOR_INTERVALS,
  INDICATOR_MEASURED,
  MACDH_INTERVALS,
  MACDH_K,
  MACDH_PAIRS,
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
import { WINDOW as MACDX_WINDOW, decideOnWindow, sidesOf } from "../../supabase/functions/_shared/macd-extreme";
import {
  LEVEL_WINDOW,
  ZONE_BARS,
  ZONE_PCT,
  ZONE_SHARE,
  decideLevelOnWindow,
  decideScaledOnWindow,
  decideZoneOnWindow,
  meanMoveOf,
  zoneAt,
  zoneEntryAt,
} from "../../supabase/functions/_shared/macd-level";
import { macd } from "../../supabase/functions/_shared/macd";
import { ULTRA_GOLD, ULTRA_PAIRS, ultraLevels } from "../../supabase/functions/_shared/ultra";
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
    expect(fn).toContain('readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx,amdpo3,emarm)&select=user_id,pair,interval,lang,rule")');
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
  it("the record of a judgment on Twelve Data's bars says when they were read and what the closed bar's close was (docs §9 L)", () => {
    // #345: the whole statement, so that the same words left in a comment would not satisfy it
    expect(fn).toContain("reads.push({ ...(await judge(c.pair, c.interval, closed, expected)), twelve: true, fetched_at: stored!.fetchedAt, close: closed[closed.length - 1].close });");
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
// below its signal line at or above a level, a BUY where it crosses above at or below minus it.
// #339 (docs §8.116): from v26 the level is each pair's own, 0.8 times its usual hourly move (the mean
// move from one close to the next over the 600 bars judged on): the owner, on AUD/USD's chart, 「通貨の
// ペアによりますよね？大体紫丸ぐらいの高さ、低さでクロスした時にメールください。どのペアも」, then 0.8
// #353 (docs §8.119): from v28 the MACD email is the zone rule's (the #353 block below), no cross. This
// rule's code stays (decideScaledOnWindow: the morning check's SQL v3 mirrors it), and so do its checks
// here; what the email does is checked in the #353 block
describe("#339 the 1-hour MACD cross rule (each pair's own level, 0.8 times its usual hourly move), the MACD email of v26 and v27", () => {
  // 2,400 hourly bars of a yen pair, of the waves #275's five-minute bars have (82 crosses over bars
  // 599 to 2,399), and the same in dollars for EUR/USD, a hundredth as far from 1.1
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
  // The rule told again here, apart from _shared/macd-level.ts: the window's usual move (its 599 steps'
  // mean |close - the close before|) and the level 0.8 times it; the side of MACD - signal at each bar of
  // the window (none until both lines are there; 0 keeps the side before), a cross where the newest
  // bar's side differs from the one before's, and MACD there held against the level. Null: no cross;
  // "no": a cross that does not fire
  const moveOf = (bars: Bars, i: number) => {
    const w = windowOf(bars, i);
    let s = 0;
    for (let k = 1; k < w.length; k++) s += Math.abs(w[k].close - w[k - 1].close);
    return s / (w.length - 1);
  };
  const told = (bars: Bars, i: number): "BUY" | "SELL" | "no" | null => {
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
    const level = 0.8 * moveOf(bars, i);
    if (side === -1) return m >= level ? "SELL" : "no";
    return m <= -level ? "BUY" : "no";
  };
  // the crosses over bars 599 to 2,399 by the rule told here: 23 BUYs, 22 SELLs, and 37 that do not fire
  // (26 on the wrong side of zero, 11 short of the level); the same on both pairs
  const N_SCALED = { cross: 82, BUY: 23, SELL: 22, no: 37 };
  const fires = (bars: Bars) => {
    const out: number[] = [];
    for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
      const t = told(bars, i);
      if (t === "BUY" || t === "SELL") out.push(i);
    }
    return out;
  };

  it("is what the subscriptions under 'macdx' follow: the 1-hour chart of the owner's five pairs and gold (v27), under its own id (from v28 the zone rule's)", () => {
    expect([...MACDH_INTERVALS]).toEqual(["1h"]);
    // 「今の5ペア」, in the app's order (kept on #339: 「今の5ペア」), and (#345, v27) gold, last
    expect([...MACDH_PAIRS]).toEqual(["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "XAU/USD"]);
    for (const p of MACDH_PAIRS) {
      expect(isMacdhChart(p, "1h")).toBe(true);
      expect(isIndicatorChartFor("macdx", p, "1h")).toBe(true);
      for (const iv of ["1min", "5min", "15min", "4h", "1day"]) {
        expect(isMacdhChart(p, iv), `${p} ${iv}`).toBe(false);
        expect(isIndicatorChartFor("macdx", p, iv), `${p} ${iv}`).toBe(false);
      }
    }
    // the other GMO pairs are not offered, nor the pairs read from Twelve Data (gold is, from v27)
    const others = MACDX_PAIRS.filter((p) => !MACDH_PAIRS.includes(p));
    expect(others).toHaveLength(9);
    for (const p of [...others, "USD/CAD", "HKD/JPY", "SGD/JPY", "NOK/JPY", "PLN/JPY", "CZK/JPY"]) {
      expect(isMacdhChart(p, "1h")).toBe(false);
      expect(isIndicatorChartFor("macdx", p, "1h")).toBe(false);
    }
    expect(isMacdhChart(undefined, "1h")).toBe(false);
    expect(isMacdhChart("USD/JPY", 1)).toBe(false);
    // its id: the emails are recorded under it (v25's was macdx_12_26_9_w600_1h_lv8.5p_v2, v26 and v27's
    // macdx_12_26_9_w600_1h_k0.8mv_v3; #353: from v28 the zone rule's, v30's macdx_12_26_9_w600_1h_z95of120_v6;
    // #384: v31's on the 15-minute chart, ..._15min_z95of120_v7; #386: from v33 the 1-hour chart's again, under its
    // own id, _v8), and the app reads the rule back from its start
    expect(MACDH_RULE_ID).toBe("macdx_12_26_9_w600_1h_z95of120_v8");
    expect(indicatorRuleId("macdx")).toBe(MACDH_RULE_ID);
    expect(MACDH_RULE_ID.startsWith("macdx")).toBe(true);
    expect(
      new Set([
        MACDH_RULE_ID,
        "macdx_12_26_9_w600_15min_z95of120_v7",
        "macdx_12_26_9_w600_1h_z95of120_v6",
        "macdx_12_26_9_w600_1h_k0.8mv_v3",
        "macdx_12_26_9_w600_1h_lv8.5p_v2",
        MACDX_RULE_ID,
        ULTRA_RULE_ID,
        QTREND_RULE_ID,
      ]).size,
    ).toBe(8);
  });

  it("holds MACD against 0.8 times the window's usual move: the mean |close - the close before| over its 599 steps", () => {
    expect(MACDH_K).toBe(0.8);
    // by hand: 1 → 3 → 2 → 2.5 moves 2, 1 and 0.5: a mean of 3.5 / 3
    expect(meanMoveOf([1, 3, 2, 2.5])).toBe(3.5 / 3);
    expect(meanMoveOf([5, 5, 5])).toBe(0);
    // on the 600 bars ending at the bar: the scale, the level 0.8 times it, the cross as decideLevelOnWindow's at that level
    let crosses = 0;
    for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
      const d = decideScaledOnWindow(yen, i, MACDH_K);
      if (!d) {
        expect(decideLevelOnWindow(yen, i, 0), `bar ${i}`).toBeNull();
        continue;
      }
      crosses++;
      expect(d.scale, `bar ${i}`).toBe(moveOf(yen, i));
      expect(d.level, `bar ${i}`).toBe(0.8 * moveOf(yen, i));
      const { scale: _s, level: _l, ...plain } = d;
      expect(plain, `bar ${i}`).toEqual(decideLevelOnWindow(yen, i, 0.8 * moveOf(yen, i)));
    }
    expect(crosses).toBe(82);
    // each pair on its own scale: EUR/USD's bars are a hundredth of USD/JPY's, and so is its level
    const i = fires(yen)[0];
    const a = decideScaledOnWindow(yen, i, MACDH_K)!;
    const b = decideScaledOnWindow(usd, i, MACDH_K)!;
    expect(b.level / a.level).toBeCloseTo(0.01, 10);
    expect([b.dir, b.fire]).toEqual([a.dir, a.fire]);
    // fewer bars than the window, or a bar past the end: no decision
    expect(decideScaledOnWindow(yen.slice(0, LEVEL_WINDOW - 1), LEVEL_WINDOW - 2, MACDH_K)).toBeNull();
    expect(decideScaledOnWindow(yen, yen.length, MACDH_K)).toBeNull();
  });

  // #353: until v27 this was the email's own check (macdhSignals gave exactly these, with the same numbers);
  // from v28 the email is the zone rule's, and this checks the code kept (decideScaledOnWindow) as strictly
  it("decides exactly the crosses at or beyond the level, judged on the newest 600 closed bars (against the rule told again here)", () => {
    for (const [pair, bars] of [["USD/JPY", yen], ["EUR/USD", usd]] as const) {
      const n = { cross: 0, BUY: 0, SELL: 0, no: 0 };
      for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
        const want = told(bars, i);
        const d = decideScaledOnWindow(windowOf(bars, i), LEVEL_WINDOW - 1, MACDH_K);
        // the same decision on the longer history (the rule reads the newest 600 bars)
        expect(decideScaledOnWindow(bars, i, MACDH_K), `${pair} bar ${i}`).toEqual(d);
        expect(d === null, `${pair} bar ${i}`).toBe(want === null);
        if (want !== null) n.cross++;
        if (want === "BUY" || want === "SELL") {
          n[want]++;
          const r = macd(windowOf(bars, i).map((b) => b.close));
          const move = moveOf(bars, i);
          expect(d, `${pair} bar ${i}`).toEqual({
            dir: want === "SELL" ? "DOWN" : "UP",
            side: want,
            m: r.macd[LEVEL_WINDOW - 1],
            signal: r.signal[LEVEL_WINDOW - 1],
            fire: true,
            level: 0.8 * move,
            scale: move,
          });
          expect(want === "SELL" ? d!.m >= d!.level : d!.m <= -d!.level).toBe(true);
        } else if (want === "no") {
          n.no++;
          expect(d!.fire, `${pair} bar ${i}`).toBe(false);
        }
      }
      // both sides fire, and crosses that do not fire are there for the check to fail on (the same on
      // both pairs: EUR/USD's bars are USD/JPY's shape at a hundredth, and so is its level)
      expect(n, pair).toEqual(N_SCALED);
    }
  });

  it("crosses where the 5-minute rule finds its crosses: the two differ only in what they ask of a cross", () => {
    expect(LEVEL_WINDOW).toBe(MACDX_WINDOW);
    let crosses = 0;
    for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
      const a = decideScaledOnWindow(yen, i, MACDH_K);
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
    // the scaled rule: equality fires, a hair beyond does not (k chosen so the level is that MACD
    // exactly; on these bars k × scale gives MACD back to the last bit), on both sides
    const sd = decideScaledOnWindow(yen, s.i, MACDH_K)!;
    const se = decideScaledOnWindow(yen, s.i, s.m / sd.scale)!;
    expect(se.level).toBe(s.m);
    expect(se.fire).toBe(true);
    expect(decideScaledOnWindow(yen, s.i, (s.m + 1e-9) / sd.scale)!.fire).toBe(false);
    const bd = decideScaledOnWindow(yen, b.i, MACDH_K)!;
    const be = decideScaledOnWindow(yen, b.i, -b.m / bd.scale)!;
    expect(be.level).toBe(-b.m);
    expect(be.fire).toBe(true);
    expect(decideScaledOnWindow(yen, b.i, (-b.m + 1e-9) / bd.scale)!.fire).toBe(false);
    // a cross down below zero is no SELL, and a cross up above zero no BUY, at any level (even 0)
    let wrong = 0;
    for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
      const d = decideScaledOnWindow(yen, i, 0);
      if (d && ((d.dir === "DOWN" && d.m < 0) || (d.dir === "UP" && d.m > 0))) {
        wrong++;
        expect(d.fire, `bar ${i}`).toBe(false);
      }
    }
    expect(wrong).toBe(26);
    expect(decideLevelOnWindow(yen.slice(0, LEVEL_WINDOW - 1), LEVEL_WINDOW - 2, 0)).toBeNull();
    expect(decideLevelOnWindow(yen, yen.length, 0)).toBeNull();
  });

  it("takes h = MACD - signal at exactly 0 as the side before (no side until there is one), so a cross needs the side to change", () => {
    expect(sidesOf([null, 0, 1, 0, 0, -1, 0, 2, null, -3])).toEqual([null, null, 1, 1, 1, -1, -1, 1, null, -1]);
  });

  // #353: what the email does from v28 (freshness, the charts it is judged on, a longer or shorter history, the
  // emails' text) is checked in the #353 block below, on the zone rule's entries

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
    // #353: and the weekend is as it was: the sweep judges nothing while the market may be shut
    // (_shared/market-hours.ts isPossiblyClosed), before any chart is read
    expect(fn).toMatch(
      /const summary: JsonRecord = \{ ok: true, mode: "indicators", version: FUNCTION_VERSION, email_configured: emailConfigured \};\s+if \(isPossiblyClosed\(nowMs\)\) return \{ \.\.\.summary, skipped: "market_closed" \};/,
    );
    expect(fn.indexOf('if (isPossiblyClosed(nowMs)) return { ...summary, skipped: "market_closed" };')).toBeLessThan(
      fn.indexOf("sigs.push(...macdhSignals(pair, interval, closed, nowMs));"),
    );
    // #353: the zone rule's version; #362: v30, its band from 95%; #384: v31, on the 15-minute chart; #385: v32, beside AMD Po3's;
    // #386: v33, back on the 1-hour chart; #387: v34, beside the EMA 20 / 200 way's
    expect(fn).toContain('const FUNCTION_VERSION = "signal-alerts-v34-2026-10-30T07:00:00Z";');
  });

  it("indicatorSignals stays what the live chart labels: Q-Trend's and ULTRA's, not the MACD rule's", () => {
    for (const i of fires(yen).slice(0, 8)) {
      const sigs = indicatorSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000);
      expect(sigs.every((x) => x.rule === "qtrend" || x.rule === "ultra")).toBe(true);
    }
  });
});

// #353 (docs §8.119): the zone rule told again here, apart from _shared/macd-level.ts: the MACD of the 600 closes
// ending at the bar (macd(), the chart's arithmetic: the MACD line, the signal line and the histogram); at the bar and
// at the bar before, on those same three, the MACD pane's top, the highest of the 360 values of the 120 bars ending
// there and 0 (Math.max of the three slices and 0), and its bottom likewise (Math.min); in the top band when that top
// is above zero and the line is at or above 0.95 times it, in the bottom band when the bottom is below zero and the
// line is at or below 0.95 times it; a SELL where the bar is in the top band and the bar before is not, a BUY likewise
// the bottom band. #362: 0.95 from v30 (0.9 in v28 and v29, docs §8.122)
type ZoneTold = { side: "BUY" | "SELL"; m: number; top: number; bottom: number; mark: number };
type MacdLines = { macd: Array<number | null>; signal: Array<number | null>; hist: Array<number | null> };
const bandsOf = (r: MacdLines, k: number) => {
  const w = [r.macd, r.signal, r.hist].flatMap((xs) => xs.slice(k - 119, k + 1)) as number[];
  const top = Math.max(0, ...w);
  const bottom = Math.min(0, ...w);
  const m = r.macd[k] as number;
  return { m, top, bottom, up: top > 0 && m >= 0.95 * top, down: bottom < 0 && m <= 0.95 * bottom };
};
const toldZone = (closes: number[]): ZoneTold | null => {
  const r = macd(closes);
  const now = bandsOf(r, closes.length - 1);
  const before = bandsOf(r, closes.length - 2);
  if (now.up && !before.up) return { side: "SELL", m: now.m, top: now.top, bottom: now.bottom, mark: 0.95 * now.top };
  if (now.down && !before.down) return { side: "BUY", m: now.m, top: now.top, bottom: now.bottom, mark: 0.95 * now.bottom };
  return null;
};
// the entries over bars 599 to 2,399 of the waves the #339 and #345 blocks' bars have, by the rule told here: 14
// SELLs and 15 BUYs, at the same bars at the three sizes (USD/JPY's, EUR/USD's a hundredth of it, gold's rounded to
// cents); and 128 and 150 bars in the top or bottom band as the bar before was (staying: no email), there for the
// check to fail on. (#362: at 95%; at 90% they were 14 and 16, 168 and 179)
const N_ZONE = { SELL: 14, BUY: 15, stayTop: 128, stayBottom: 150 };

// the crosses over bars 599 to 2,399 of gold's bars by the rule told below: the #339 block's counts (the bars have the
// same waves at gold's size, a usual hourly move of some $8, checked below; rounding them to cents moves none of the 82
// crosses, and the counts do not change with the size: the same 82, 23, 22 and 37 came out at sizes from 200 to 260)
const N_GOLD = { cross: 82, BUY: 23, SELL: 22, no: 37 };

// #353: from v28 gold's MACD email is the zone rule's, as the pairs' is: checked here on gold's bars (its numbers in
// dollars, its stop and targets gold's); the cross rule's checks on gold's bars stay for the code kept
describe("#345 gold on the 1-hour MACD email (from v27): Twelve Data's bars, in dollars; from v28 the zone rule, as the pairs'", () => {
  // 2,400 hourly bars of gold, the waves of the #339 block's bars at gold's size (a usual hourly move of some $8,
  // as gold's stored 1-hour bars have), rounded to the two decimals the chart rounds gold to
  const H0 = Date.UTC(2026, 6, 1);
  const wave = (i: number) => 0.9 * Math.sin(i / 90) + 0.35 * Math.sin(i / 23) + 0.12 * Math.sin(i / 7) + 0.03 * Math.sin(i * 1.9) + 0.0004 * i;
  const r2 = (v: number) => Number(v.toFixed(2));
  const SIZE = 240;
  const gold = Array.from({ length: 2400 }, (_, i) => {
    const close = 4150 + SIZE * wave(i);
    const open = close + SIZE * 0.02 * Math.sin(i * 2.3);
    return {
      datetime: stamp(H0 + i * H),
      open: r2(open),
      high: r2(Math.max(open, close) + SIZE * (0.03 + 0.01 * Math.abs(Math.sin(i * 0.9)))),
      low: r2(Math.min(open, close) - SIZE * (0.03 + 0.01 * Math.abs(Math.cos(i * 1.1)))),
      close: r2(close),
    };
  });
  const closeMsOf = (i: number) => H0 + (i + 1) * H;
  const windowOf = (i: number) => gold.slice(i - LEVEL_WINDOW + 1, i + 1);
  // the rule told again here, apart from _shared/macd-level.ts (as the #339 block's)
  const moveOf = (i: number) => {
    const w = windowOf(i);
    let s = 0;
    for (let k = 1; k < w.length; k++) s += Math.abs(w[k].close - w[k - 1].close);
    return s / (w.length - 1);
  };
  const told = (i: number): "BUY" | "SELL" | "no" | null => {
    const r = macd(windowOf(i).map((b) => b.close));
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
    const level = 0.8 * moveOf(i);
    if (side === -1) return m >= level ? "SELL" : "no";
    return m <= -level ? "BUY" : "no";
  };
  // #353: the zone rule's entries on gold's bars, by the rule told above the block
  const zoneTold = (i: number) => toldZone(windowOf(i).map((b) => b.close));
  let zoneBars: number[] | null = null;
  const zoneFires = () => {
    if (zoneBars) return zoneBars;
    zoneBars = [];
    for (let i = LEVEL_WINDOW - 1; i < gold.length; i++) if (zoneTold(i)) zoneBars.push(i);
    return zoneBars;
  };

  it("the bars are the size of gold's stored ones: a usual hourly move of some $8 (the stored bars' 7.70 to 8.96)", () => {
    for (const i of [LEVEL_WINDOW - 1, 1200, 2399]) {
      expect(moveOf(i)).toBeGreaterThan(7.5);
      expect(moveOf(i)).toBeLessThan(8.5);
    }
  });

  it("is offered on gold's 1-hour chart and on no other of gold's, under the same rule id as the pairs'", () => {
    expect(isMacdhChart("XAU/USD", "1h")).toBe(true);
    expect(isIndicatorChartFor("macdx", "XAU/USD", "1h")).toBe(true);
    // gold's other charts (the 15-minute and 4-hour and daily ones are Q-Trend's and ULTRA's) are not the MACD rule's
    for (const iv of ["1min", "5min", "15min", "4h", "1day"]) {
      expect(isMacdhChart("XAU/USD", iv), iv).toBe(false);
      expect(isIndicatorChartFor("macdx", "XAU/USD", iv), iv).toBe(false);
    }
    // gold's 1-minute chart is the video's way's ('sweepx'), not this rule's
    expect(isIndicatorChartFor("sweepx", "XAU/USD", "1min")).toBe(true);
    expect(isIndicatorChartFor("sweepx", "XAU/USD", "1h")).toBe(false);
    // the rule is the same rule: its id is the pairs' (the claim key holds the pair); #353: from v28 the zone rule's
    expect(indicatorRuleId("macdx")).toBe(MACDH_RULE_ID);
    expect(MACDH_RULE_ID).toBe("macdx_12_26_9_w600_1h_z95of120_v8");
    // the numbers are in the bars' own units: gold's, dollars (the stop and targets are dollars too)
    expect(ultraUnit("XAU/USD")).toBe(1);
  });

  // #353: until v27 this was gold's email's own check; from v28 it checks the cross rule's code kept, as strictly
  it("the cross rule (v27's email, its code kept) decides exactly the crosses at or beyond the level on gold's bars, against the rule told again here", () => {
    const n = { cross: 0, BUY: 0, SELL: 0, no: 0 };
    for (let i = LEVEL_WINDOW - 1; i < gold.length; i++) {
      const want = told(i);
      const d = decideScaledOnWindow(windowOf(i), LEVEL_WINDOW - 1, MACDH_K);
      expect(d === null, `bar ${i}`).toBe(want === null);
      if (want !== null) n.cross++;
      if (want === "BUY" || want === "SELL") {
        n[want]++;
        const r = macd(windowOf(i).map((b) => b.close));
        const move = moveOf(i);
        expect(d, `bar ${i}`).toEqual({
          dir: want === "SELL" ? "DOWN" : "UP",
          side: want,
          m: r.macd[LEVEL_WINDOW - 1],
          signal: r.signal[LEVEL_WINDOW - 1],
          fire: true,
          level: 0.8 * move,
          scale: move,
        });
        expect(want === "SELL" ? d!.m >= d!.level : d!.m <= -d!.level).toBe(true);
      } else if (want === "no") {
        n.no++;
        expect(d!.fire, `bar ${i}`).toBe(false);
      }
    }
    // both sides fire, and crosses that do not fire are there for the check to fail on
    expect(n.cross).toBe(n.BUY + n.SELL + n.no);
    expect(n.BUY).toBeGreaterThan(5);
    expect(n.SELL).toBeGreaterThan(5);
    expect(n.no).toBeGreaterThan(5);
    expect(n).toEqual(N_GOLD);
  });

  it("#353: mails exactly the zone rule's entries on gold's bars (against the rule told again here), with gold's stop and targets in dollars", () => {
    const n = { SELL: 0, BUY: 0, stayTop: 0, stayBottom: 0 };
    for (let i = LEVEL_WINDOW - 1; i < gold.length; i++) {
      const want = zoneTold(i);
      const r = macd(windowOf(i).map((b) => b.close));
      const now = bandsOf(r, LEVEL_WINDOW - 1);
      const before = bandsOf(r, LEVEL_WINDOW - 2);
      if (now.up && before.up) n.stayTop++;
      if (now.down && before.down) n.stayBottom++;
      expect(decideZoneOnWindow(windowOf(i), LEVEL_WINDOW - 1), `bar ${i}`).toEqual(want ? { ...want, fire: true } : null);
      const sigs = macdhSignals("XAU/USD", "1h", windowOf(i), closeMsOf(i) + 30_000);
      if (want === null) {
        expect(sigs, `bar ${i}`).toEqual([]);
        continue;
      }
      n[want.side]++;
      expect(sigs, `bar ${i}`).toHaveLength(1);
      const g = sigs[0];
      expect(g.rule).toBe("macdx");
      expect(g.side).toBe(want.side);
      expect(g.pair).toBe("XAU/USD");
      expect(g.interval).toBe("1h");
      expect(g.barTime).toBe(new Date(H0 + i * H).toISOString());
      expect(g.closedAt).toBe(new Date(closeMsOf(i)).toISOString());
      expect(g.close).toBe(gold[i].close);
      // ULTRA's stop $13 and targets $4, $10 and $16 from the close, in dollars
      const lv = ultraLevels(want.side, gold[i].close, 1, ULTRA_GOLD);
      expect(g.sl).toBe(lv.sl);
      expect(g.tps).toEqual(lv.tps);
      expect(Math.abs((g.sl as number) - g.close)).toBeCloseTo(13, 9);
      expect((g.tps as number[]).map((v) => Math.abs(v - g.close))).toEqual([4, 10, 16].map((x) => expect.closeTo(x, 9)));
      expect(g.macdh).toEqual({ m: want.m, top: want.top, bottom: want.bottom, mark: want.mark });
      expect(g.macd).toBeUndefined();
    }
    // both sides, and bars in a band that mail nothing (staying), for the check to fail on: the pairs' counts (the same waves)
    expect(n).toEqual(N_ZONE);
    // gold's stop and targets are ULTRA_GOLD's: today they hold the same numbers as the pairs' (ULTRA_PAIRS), so only
    // the code can tell which is taken (macdhSignals, ultraParamsFor(isGold(pair)))
    const fn = readFileSync("supabase/functions/signal-alerts/indicators.ts", "utf8");
    const body = fn.slice(fn.indexOf("export const macdhSignals = ("), fn.indexOf("export const sweepxSignals = ("));
    expect(body).toContain("const lv = ultraLevels(d.side, close, ultraUnit(pair), ultraParamsFor(isGold(pair)));");
  });

  it("is mailed while its bar is fresh (half an hour), and is not judged on another chart of gold's", () => {
    const i = zoneFires()[3];
    const w = windowOf(i);
    const at = closeMsOf(i);
    expect(macdhSignals("XAU/USD", "1h", w, at - 1)).toEqual([]);
    expect(macdhSignals("XAU/USD", "1h", w, at)).toHaveLength(1);
    expect(macdhSignals("XAU/USD", "1h", w, at + 30 * 60_000)).toHaveLength(1);
    expect(macdhSignals("XAU/USD", "1h", w, at + 30 * 60_000 + 1)).toEqual([]);
    for (const iv of ["1min", "5min", "15min", "4h", "1day"]) expect(macdhSignals("XAU/USD", iv, w, at + 30_000), iv).toEqual([]);
    // fewer bars than the window: none
    expect(macdhSignals("XAU/USD", "1h", w.slice(1), at + 30_000)).toEqual([]);
  });

  it("indicatorSignals stays what the live chart labels on gold: Q-Trend's and ULTRA's, not the MACD rule's", () => {
    for (const i of zoneFires().slice(0, 8)) {
      const sigs = indicatorSignals("XAU/USD", "1h", windowOf(i), closeMsOf(i) + 30_000);
      expect(sigs.every((x) => x.rule === "qtrend" || x.rule === "ultra")).toBe(true);
    }
  });

  const sample = (side: "BUY" | "SELL") => {
    const i = zoneFires().find((k) => zoneTold(k)!.side === side)!;
    return macdhSignals("XAU/USD", "1h", windowOf(i), closeMsOf(i) + 30_000)[0];
  };

  it("the Japanese email gives the blue line, the pane's top or bottom and its 95% in gold's digits, names gold, and speaks of no pips", () => {
    const g = sample("SELL");
    const f = g.macdh!;
    const mail = renderIndicatorMail(g, "ja");
    expect(mail.subject).toBe("【Sextant】金 1時間足 売り（SELL）のサイン（MACD の山・谷）");
    const t = mail.text;
    expect(t).toContain("金の1時間足で、MACD の山・谷の売り（SELL）のサインが出ました。");
    expect(t).toContain("MACD(12・26・9): 青い線（MACD）が、新しい120本の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い所）の95%以上（0の線から測って）に届きました");
    expect(f.m).toBeGreaterThan(0);
    expect(t).toContain(`\n  MACD = ${f.m.toFixed(2)}、枠の上の端 = ${f.top.toFixed(2)}（その95% = ${f.mark.toFixed(2)}）`);
    expect(t).toContain("損切り・利確の目安（ULTRA と同じ数字）:");
    expect(t).toContain("（$13.00）");
    expect(t).toContain("利確1");
    expect(t).toContain("足は Twelve Data のもの（金は GMOコインにないため）");
    expect(t).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません。");
    expect(t).toContain("「MACD の山・谷」でチェックを外してください");
    expect(t).not.toContain("pips");
    expect(t).not.toContain("このペア");
    // nothing of the cross rule's (v25 to v27; the orange line is named from v28 as one that sets the pane's edges)
    for (const no of ["クロス", "シグナル", "ふだんの動き", "0.8倍"]) expect(t, no).not.toContain(no);
    const buy = sample("BUY");
    const fb = buy.macdh!;
    const bt = renderIndicatorMail(buy, "ja");
    expect(bt.subject).toBe("【Sextant】金 1時間足 買い（BUY）のサイン（MACD の山・谷）");
    expect(bt.text).toContain("MACD(12・26・9): 青い線（MACD）が、新しい120本の MACD の枠の下の端（青い線・オレンジの線・棒の一番低い所）の95%以上（0の線から測って）に届きました");
    expect(fb.m).toBeLessThan(0);
    expect(bt.text).toContain(`\n  MACD = −${(-fb.m).toFixed(2)}、枠の下の端 = −${(-fb.bottom).toFixed(2)}（その95% = −${(-fb.mark).toFixed(2)}）`);
  });

  it("the English email says the same in gold's digits", () => {
    const g = sample("BUY");
    const f = g.macdh!;
    const mail = renderIndicatorMail(g, "en");
    expect(mail.subject).toBe("[Sextant] XAU/USD 1-hour BUY signal (MACD peak/valley)");
    const t = mail.text;
    expect(t).toContain("A MACD peak/valley BUY signal fired on XAU/USD, 1-hour chart.");
    expect(t).toContain(
      "MACD(12, 26, 9): the MACD line (blue) reached the bottom band of the MACD pane of the newest 120 bars: 95% or more of the way from the zero line to the pane's bottom (the lowest of the MACD line, the signal line and the histogram)",
    );
    expect(f.m).toBeLessThan(0);
    expect(t).toContain(`\n  MACD = −${(-f.m).toFixed(2)}; bottom of the pane = −${(-f.bottom).toFixed(2)}; 95% of it = −${(-f.mark).toFixed(2)}`);
    expect(t).toContain("($13.00)");
    expect(t).toContain("The bars are Twelve Data's (GMO Coin does not carry XAU/USD)");
    expect(t).toContain("This rule's win rate and its profit or loss a trade have not been measured.");
    expect(t).not.toContain("pips");
    expect(t).not.toContain("this pair");
    // (the signal line and the orange line are named from v28 as setting the pane's edges)
    for (const no of ["cross", "usual", "0.8 times"]) expect(t, no).not.toContain(no);
  });

  it("the pairs' emails speak of pips and GMO's bars; gold's dollars and Twelve Data did not leak into them", () => {
    // (the #353 block checks the pairs' emails to the word; here only that gold's wording did not leak into them)
    const bars = Array.from({ length: 2400 }, (_, i) => {
      const close = 150 + wave(i);
      return { datetime: stamp(H0 + i * H), open: close, high: close + 0.05, low: close - 0.05, close };
    });
    const i = (() => {
      for (let k = LEVEL_WINDOW - 1; k < bars.length; k++) {
        if (macdhSignals("USD/JPY", "1h", bars.slice(k - LEVEL_WINDOW + 1, k + 1), H0 + (k + 1) * H + 30_000).length) return k;
      }
      return -1;
    })();
    expect(i).toBeGreaterThan(0);
    const g = macdhSignals("USD/JPY", "1h", bars.slice(i - LEVEL_WINDOW + 1, i + 1), H0 + (i + 1) * H + 30_000)[0];
    const ja = renderIndicatorMail(g, "ja").text;
    const en = renderIndicatorMail(g, "en").text;
    expect(ja).toContain("（13.0pips）");
    expect(en).toContain("(13.0 pips)");
    expect(ja).toContain("価格は GMOコインの公開レート（買値と売値の中間）");
    expect(en).toContain("The bars are the mid of GMO Coin's public bid and ask");
    for (const t of [ja, en]) {
      expect(t).not.toContain("Twelve Data");
      expect(t).not.toContain("$");
    }
    expect(ja).not.toContain("金");
    expect(en).not.toContain("gold");
  });
});

// #353 (docs §8.119): the MACD email from v28. The owner, 2026-10-13: 「やっぱりめーるですが、macdの青い線が上か下の
// 90%以上の所までいったら売買のメールを送る様にしてください。意味わかりますか？」. Asked, the owner chose: 90% of the way
// from the zero line to the top (bottom) of the newest 120 bars (what the chart shows when opened); the email at the
// closed bar that gets there (no cross waited for), one to a peak or valley, none again until the line has gone back
// inside the 90% mark; in place of the cross email (the five pairs and gold). Asked again (2026-10-14) what the top
// is, the owner chose 「2で」: the chart's MACD pane's edge, the highest of the blue line, the orange line and the bars
// (and the bottom the lowest), not the blue line's own highest
describe("#353 the 1-hour MACD email from v28 (#362: 95% from v30): the blue line at 95% or more of the top (a SELL) or bottom (a BUY) of the newest 120 bars' MACD pane", () => {
  // the #339 block's bars: 2,400 hourly bars of a yen pair, and the same at a hundredth for EUR/USD
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
  const zoneTold = (bars: Bars, i: number) => toldZone(windowOf(bars, i).map((b) => b.close));
  const fired = new Map<Bars, number[]>();
  const zoneFires = (bars: Bars) => {
    const got = fired.get(bars);
    if (got) return got;
    const out: number[] = [];
    for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) if (zoneTold(bars, i)) out.push(i);
    fired.set(bars, out);
    return out;
  };
  // a hand-made line of a MACD: `length` values at `base`, some set apart
  const line = (length: number, base: number, set: Record<number, number> = {}): Array<number | null> =>
    Array.from({ length }, (_, j) => set[j] ?? base);
  // a hand-made MACD: the MACD line, and the signal line and the histogram (zero all along where not given). The rule
  // takes the three as they come (only the line comes into a band; the three and 0 set the pane's edges), so these
  // need not hold histogram = line - signal
  const pane = (ms: Array<number | null>, ss = line(ms.length, 0), hs = line(ms.length, 0)) => ({ macd: ms, signal: ss, hist: hs });
  // the next double toward zero: a hair short of x, on either side of zero
  const towardZero = (x: number) => {
    const f = new Float64Array([x]);
    const u = new BigInt64Array(f.buffer);
    u[0] -= 1n;
    return f[0];
  };
  const entriesOf = (r: ReturnType<typeof pane>) => {
    const out: string[] = [];
    for (let k = 0; k < r.macd.length; k++) {
      const d = zoneEntryAt(r, k);
      if (d) out.push(`${d.side}@${k}`);
    }
    return out;
  };
  // the negative of a number, with zero kept the zero the rule starts its edges at (not -0)
  const neg = (x: number) => (x === 0 ? 0 : -x);

  it("its numbers: the newest 120 bars (as many as the chart draws), 95%, the 600-bar window, and the rule id that says them", () => {
    expect(ZONE_BARS).toBe(120);
    expect(ZONE_BARS).toBe(CHART_BARS);
    // #362: 95 from v30 (90 in v28 and v29)
    expect(ZONE_PCT).toBe(95);
    // the share held against is 95 / 100, the double 0.95 is (the id is made of ZONE_PCT, a whole number)
    expect(ZONE_SHARE).toBe(0.95);
    expect(ZONE_SHARE).toBe(ZONE_PCT / 100);
    expect(LEVEL_WINDOW).toBe(600);
    expect(MACDH_RULE_ID).toBe("macdx_12_26_9_w600_1h_z95of120_v8");
    expect(indicatorRuleId("macdx")).toBe(MACDH_RULE_ID);
    // the app reads the rule back from the id's start
    expect(MACDH_RULE_ID.startsWith("macdx")).toBe(true);
  });

  it("on a hand-made MACD whose edge is the line's own: the first bar in the top band is the SELL; staying in it is not; out (back inside the 95% mark) and in again is another", () => {
    // the line 0 until 129; 0.5 at 130 (the top of its pane: the band from 0.475); 0.8 (a new top), then 0.77 (at or
    // above 0.76: still in); 0.6 and 0.7 (inside the 95% mark, still above zero); 0.78 (in again, under the top); then 0.
    // The signal line and the histogram at 0 all along: the pane's top is the line's own highest. (#362: at 95%; at 90%
    // the bar after the new top was 0.75, at or above 0.72)
    const r = pane(line(200, 0, { 130: 0.5, 131: 0.8, 132: 0.77, 133: 0.6, 134: 0.7, 135: 0.78 }));
    expect(entriesOf(r)).toEqual(["SELL@130", "SELL@135"]);
    expect([130, 131, 132, 133, 134, 135, 136].map((k) => zoneAt(r, k)!.inTop)).toEqual([true, true, true, false, false, true, false]);
    expect(zoneEntryAt(r, 130)).toEqual({ side: "SELL", m: 0.5, top: 0.5, bottom: 0, mark: ZONE_SHARE * 0.5, fire: true });
    expect(zoneEntryAt(r, 135)).toEqual({ side: "SELL", m: 0.78, top: 0.8, bottom: 0, mark: ZONE_SHARE * 0.8, fire: true });
    // the BUY is its mirror: the same line below zero gives BUYs at the same bars
    const down = pane(r.macd.map((v) => neg(v as number)));
    expect(entriesOf(down)).toEqual(["BUY@130", "BUY@135"]);
    expect([130, 131, 132, 133, 134, 135, 136].map((k) => zoneAt(down, k)!.inBottom)).toEqual([true, true, true, false, false, true, false]);
    expect(zoneEntryAt(down, 135)).toEqual({ side: "BUY", m: -0.78, top: 0, bottom: -0.8, mark: ZONE_SHARE * -0.8, fire: true });
  });

  it("the orange line (the signal) sets the edge where it is the highest: the line short of 95% of it is not in the band, past 95% of it it is", () => {
    // the line 0.8 at 130 and 0.97 at 135; the signal line 1.0 at 125, a high above the line's: the pane's top is 1.0
    // (the band from 0.95), and the line's 0.8 is no SELL (by its own highest, 0.8 would have been the top, and a SELL);
    // at 0.97 it is in: the SELL (#362: 0.95 at 90%, the mark itself now)
    const ms = line(200, 0, { 130: 0.8, 135: 0.97 });
    const r = pane(ms, line(200, 0, { 125: 1.0 }));
    expect(zoneAt(r, 130)).toMatchObject({ m: 0.8, top: 1.0, topMark: ZONE_SHARE * 1.0, inTop: false });
    expect(zoneAt(pane(ms), 130)).toMatchObject({ m: 0.8, top: 0.8, inTop: true });
    expect(entriesOf(r)).toEqual(["SELL@135"]);
    expect(zoneEntryAt(r, 135)).toEqual({ side: "SELL", m: 0.97, top: 1.0, bottom: 0, mark: ZONE_SHARE * 1.0, fire: true });
    // the bottom likewise: the signal line's low below the line's
    const down = pane(ms.map((v) => neg(v as number)), line(200, 0, { 125: -1.0 }));
    expect(entriesOf(down)).toEqual(["BUY@135"]);
    expect(zoneEntryAt(down, 135)).toEqual({ side: "BUY", m: -0.97, top: 0, bottom: -1.0, mark: ZONE_SHARE * -1.0, fire: true });
  });

  it("the bars (the histogram) set the edge where they are the highest; the line at the mark itself is in the band, a hair short of it is not, on both sides; the mark is 0.95 times the edge as it comes, unrounded", () => {
    const mark = ZONE_SHARE * 0.7;
    // the bars at 0.7 at 130 (the line 0 there, the signal line -0.7: 0 - (-0.7)), then the line at the mark at 140
    const high = (m: number) => pane(line(200, 0, { 140: m }), line(200, 0, { 130: -0.7 }), line(200, 0, { 130: 0.7 }));
    expect(zoneAt(high(mark), 140)).toMatchObject({ m: mark, top: 0.7, bottom: -0.7, topMark: mark, inTop: true });
    expect(zoneEntryAt(high(mark), 140)).toEqual({ side: "SELL", m: mark, top: 0.7, bottom: -0.7, mark, fire: true });
    expect(towardZero(mark)).toBeLessThan(mark);
    expect(zoneEntryAt(high(towardZero(mark)), 140)).toBeNull();
    // 0.95 × 0.7 is not the double 0.665 (it comes out a hair below 0.665, 0.6649999999999999): the band starts there,
    // so a line at 0.665 is in it, and so is one at the product itself, a hair lower (#362: at 0.9 the edge here was
    // 0.8, whose 90% came out a hair above 0.72, so a line at 0.72 was not in the band)
    expect(mark).not.toBe(0.665);
    expect(mark).toBeLessThan(0.665);
    expect(zoneEntryAt(high(0.665), 140)).toEqual({ side: "SELL", m: 0.665, top: 0.7, bottom: -0.7, mark, fire: true });
    // the bottom: the bars at -0.7 (the signal line 0.7 over the line's 0)
    const bmark = ZONE_SHARE * -0.7;
    const low = (m: number) => pane(line(200, 0, { 140: m }), line(200, 0, { 130: 0.7 }), line(200, 0, { 130: -0.7 }));
    expect(zoneEntryAt(low(bmark), 140)).toEqual({ side: "BUY", m: bmark, top: 0.7, bottom: -0.7, mark: bmark, fire: true });
    expect(towardZero(bmark)).toBeGreaterThan(bmark);
    expect(zoneEntryAt(low(towardZero(bmark)), 140)).toBeNull();
    expect(zoneEntryAt(low(-0.665), 140)).toEqual({ side: "BUY", m: -0.665, top: 0.7, bottom: -0.7, mark: bmark, fire: true });
  });

  it("no top band while none of the 360 values is above zero (no SELL even at the line's own high), and an edge just above zero has one; the bottom likewise", () => {
    // the line rising all the way below zero, the signal line and the bars below zero too: the bar is the line's highest
    // of its 120, the pane's top is 0, and there is no band to be in
    const rising = pane(Array.from({ length: 200 }, (_, j) => -1 + j / 200), line(200, -1), line(200, -0.5));
    expect(zoneAt(rising, 199)).toMatchObject({ m: rising.macd[199], top: 0, topMark: 0, inTop: false });
    expect(Math.max(...(rising.macd.slice(80, 200) as number[]))).toBe(rising.macd[199]);
    expect(entriesOf(rising)).toEqual([]);
    // at exactly zero the top is 0, not above zero (0.95 × 0 is 0, so without that the line at 0 would be in the band)
    expect(zoneAt(pane(line(200, -0.5, { 199: 0 })), 199)).toMatchObject({ m: 0, top: 0, topMark: 0, inTop: false });
    expect(zoneEntryAt(pane(line(200, -0.5, { 199: 0 })), 199)).toBeNull();
    // an edge just above zero: the band starts just above zero, and the line there is a SELL
    expect(zoneEntryAt(pane(line(200, -0.5, { 199: 1e-12 })), 199)).toEqual({ side: "SELL", m: 1e-12, top: 1e-12, bottom: -0.5, mark: ZONE_SHARE * 1e-12, fire: true });
    // the bottom: at exactly zero none, just below zero a BUY
    expect(zoneAt(pane(line(200, 0.5, { 199: 0 })), 199)).toMatchObject({ m: 0, bottom: 0, bottomMark: 0, inBottom: false });
    expect(zoneEntryAt(pane(line(200, 0.5, { 199: 0 })), 199)).toBeNull();
    expect(zoneEntryAt(pane(line(200, 0.5, { 199: -1e-12 })), 199)).toEqual({ side: "BUY", m: -1e-12, top: 0.5, bottom: -1e-12, mark: ZONE_SHARE * -1e-12, fire: true });
  });

  it("on these closes (a long fall, then a rise at the same pace): just past zero the orange line is still below zero, the bars stand well above the line and set the pane's top, and there is no SELL there (by the line's own highest there would be one); the SELL comes where the line has become the pane's top itself", () => {
    // a fall of 0.05 a bar, then a rise at the same pace from bar 500: the MACD line from about -0.35 up through zero
    const closes = Array.from({ length: LEVEL_WINDOW }, (_, j) => (j < 500 ? 150 - 0.05 * j : 125 + 0.05 * (j - 500)));
    const r = macd(closes);
    const ms = r.macd as number[];
    // below zero from its first value to bar 514, above it at 515, the highest of its own 120 there (by the line's own
    // highest, round 1's rule, the bar would be in the top band and the bar before not: a SELL)
    expect(ms.slice(25, 515).every((v) => v < 0)).toBe(true);
    expect(ms[515]).toBeGreaterThan(0);
    expect(Math.max(...ms.slice(396, 516))).toBe(ms[515]);
    // the orange line still below zero, the bars (the line less the orange line) above the line: they set the pane's top,
    // and the line is near the zero line, under a twentieth of the way to it
    expect(r.signal[515]).toBeLessThan(0);
    expect(r.hist[515]).toBeGreaterThan(ms[515]);
    const z = zoneAt(r, 515)!;
    expect(z.top).toBe(Math.max(...(r.hist.slice(396, 516) as number[])));
    expect(z.inTop).toBe(false);
    expect(ms[515]).toBeLessThan(0.05 * z.top);
    expect(zoneEntryAt(r, 515)).toBeNull();
    // the SELL is at 520, where the line has become the top of the pane itself; nothing else on these bars
    expect(entriesOf(r)).toEqual(["SELL@520"]);
    expect(zoneEntryAt(r, 520)).toMatchObject({ side: "SELL", m: ms[520], top: ms[520], mark: ZONE_SHARE * ms[520] });
    // at the newest of 600 bars, as the email reads them: the rise from bar 584, the line past zero at the newest
    const late = Array.from({ length: LEVEL_WINDOW }, (_, j) => (j < 584 ? 150 - 0.05 * j : 150 - 0.05 * 584 + 0.05 * (j - 584)));
    const lm = macd(late).macd as number[];
    expect(lm[598]).toBeLessThan(0);
    expect(lm[599]).toBeGreaterThan(0);
    expect(Math.max(...lm.slice(480))).toBe(lm[599]);
    expect(decideZoneOnWindow(late.map((close) => ({ close })), LEVEL_WINDOW - 1)).toBeNull();
    // and the mirror: just past zero after a long rise, no BUY
    expect(decideZoneOnWindow(late.map((close) => ({ close: -close })), LEVEL_WINDOW - 1)).toBeNull();
  });

  it("on closes: just past zero after a long fall the line CAN come into the band with the orange line still below zero (the top is at least the bar's own bars, m - s, so it takes m >= 19 |s|): one bar up gives the SELL at the crossing bar itself, and the mirror a BUY; a smaller bar up gives none", () => {
    // the notes say there is USUALLY no SELL just past zero, not never: 2 of the 110 entries on the stored bars came
    // with the orange line still on the other side of zero, both at the bar after the line crossed it (docs §8.122; at
    // 90%, 2 of the 124, the same two bars, §8.119). (#362: at 95% it takes m >= 19 |s|, at 90% it took 9 |s|; the
    // three bars up below give the same answers at both)
    // Here: flat at 150 (259 bars), a fall of 0.01 a bar (300 bars), flat (40 bars), then the newest bar up by `jump`
    const closesUp = (jump: number) => {
      const out: number[] = [];
      let p = 150;
      for (let j = 0; j < 259; j++) out.push(p);
      for (let j = 0; j < 300; j++) out.push((p -= 0.01));
      for (let j = 0; j < 40; j++) out.push(p);
      out.push(p + jump);
      return out;
    };
    const k = LEVEL_WINDOW - 1;
    // up 0.40: the line crosses zero at the newest bar, after 340 bars below it; the orange line still below zero, the
    // bars above the line and the pane's top; the line at 19 |s| or more, so at 95% of the bars or more: the SELL
    const up = closesUp(0.4);
    expect(up).toHaveLength(LEVEL_WINDOW);
    const r = macd(up);
    const ms = r.macd as number[];
    const s = r.signal[k] as number;
    const h = r.hist[k] as number;
    expect(ms.slice(259, k).every((v) => v < 0)).toBe(true);
    expect(ms[k]).toBeGreaterThan(0);
    expect(s).toBeLessThan(0);
    expect(h).toBeGreaterThan(ms[k]);
    expect(zoneAt(r, k)!.top).toBe(h);
    expect(ms[k]).toBeGreaterThanOrEqual(19 * Math.abs(s));
    expect(zoneAt(r, k - 1)!.inTop).toBe(false);
    const d = decideZoneOnWindow(up.map((close) => ({ close })), k);
    expect(d).toMatchObject({ side: "SELL", m: ms[k], top: h, mark: ZONE_SHARE * h });
    // the mirror: the closes negated give the BUY at the same bar, the numbers negated
    expect(decideZoneOnWindow(up.map((close) => ({ close: -close })), k)).toEqual({ side: "BUY", m: -d!.m, top: -d!.bottom, bottom: -d!.top, mark: -d!.mark, fire: true });
    // up 0.30: the line crosses zero at the newest bar too, but the orange line is further below zero (the line under
    // 19 |s|): the bars set the top, the line is short of 95% of them, and there is no SELL
    const small = closesUp(0.3);
    const rs = macd(small);
    const ss = rs.signal[k] as number;
    expect(rs.macd[k - 1]).toBeLessThan(0);
    expect(rs.macd[k]).toBeGreaterThan(0);
    expect(ss).toBeLessThan(0);
    expect(rs.macd[k] as number).toBeLessThan(19 * Math.abs(ss));
    expect(zoneAt(rs, k)).toMatchObject({ top: rs.hist[k], inTop: false });
    expect(decideZoneOnWindow(small.map((close) => ({ close })), k)).toBeNull();
    // up 0.50: the orange line crosses zero at that bar as well, and the line is the pane's top itself: a SELL too
    const big = closesUp(0.5);
    const rb = macd(big);
    expect(rb.macd[k - 1]).toBeLessThan(0);
    expect(rb.signal[k]).toBeGreaterThan(0);
    expect(decideZoneOnWindow(big.map((close) => ({ close })), k)).toMatchObject({ side: "SELL", m: rb.macd[k], top: rb.macd[k] });
  });

  it("on closes: a market still falling, its MACD line rising to its own 120-bar high below zero, gives no SELL (and the mirror no BUY)", () => {
    // a steady fall, then the fall slowing over the last 80 bars (still falling at every bar)
    const closes: number[] = [];
    for (let j = 0; j < LEVEL_WINDOW; j++) {
      if (j < 520) closes.push(150 - 0.05 * j);
      else closes.push(closes[j - 1] - (0.05 - 0.04 * ((j - 519) / 80)));
    }
    expect(closes.every((c, j) => j === 0 || c < closes[j - 1])).toBe(true);
    const r = macd(closes);
    const ms = r.macd as number[];
    // the line rising over the last 60 bars, the highest of its own 120 at the newest, below zero
    expect(ms.slice(LEVEL_WINDOW - 60).every((v, k, a) => k === 0 || v > a[k - 1])).toBe(true);
    expect(Math.max(...ms.slice(LEVEL_WINDOW - 120))).toBe(ms[LEVEL_WINDOW - 1]);
    expect(ms[LEVEL_WINDOW - 1]).toBeLessThan(0);
    // the pane's top is above zero (the bars: the line has risen above its orange line), and the line below zero is not
    // in the band
    const z = zoneAt(r, LEVEL_WINDOW - 1)!;
    expect(z.top).toBe(Math.max(...(r.hist.slice(LEVEL_WINDOW - 120) as number[])));
    expect(z.top).toBeGreaterThan(0);
    expect(z.inTop).toBe(false);
    expect(decideZoneOnWindow(closes.map((close) => ({ close })), LEVEL_WINDOW - 1)).toBeNull();
    expect(decideZoneOnWindow(closes.map((close) => ({ close: -close })), LEVEL_WINDOW - 1)).toBeNull();
  });

  it("an old edge leaving the 120 brings it toward zero: the line can come into the band without moving (a hand-made MACD, and the waves' bars)", () => {
    // the line 0 until 99, then 0.6 all along; the signal line 1.0 at 100 (the old top): in the 120 ending at 219 the top
    // is 1.0 (the band from 0.95); at 220 the old top has left them, the top is the line's 0.6, and the line, not moved,
    // is in the band
    const r = pane(line(260, 0.6, Object.fromEntries(Array.from({ length: 100 }, (_, j) => [j, 0]))), line(260, 0, { 100: 1.0 }));
    expect(entriesOf(r)).toEqual(["SELL@220"]);
    expect(r.macd[220]).toBe(r.macd[219]);
    expect(zoneAt(r, 219)).toMatchObject({ m: 0.6, top: 1.0, inTop: false });
    expect(zoneEntryAt(r, 220)).toEqual({ side: "SELL", m: 0.6, top: 0.6, bottom: 0, mark: ZONE_SHARE * 0.6, fire: true });
    // on the waves' bars: the SELL at bar 1,329 came as the line fell, the top of the bar before's pane (the orange line at
    // its oldest bar, window index 479) gone from the bar's 120; the new top is the line's own, from inside the 120
    // (two bars back, window index 597).
    // (#362: at 95%; at 90% the SELL came a bar earlier, at 1,328, the new top the orange line's at window index 480)
    const i = 1329;
    expect(decideZoneOnWindow(yen, i)!.side).toBe("SELL");
    const w = macd(windowOf(yen, i).map((b) => b.close));
    const lw = w.macd as number[];
    expect(lw[599]).toBeLessThan(lw[598]);
    const before = zoneAt(w, 598)!;
    const now = zoneAt(w, 599)!;
    expect(before.inTop).toBe(false);
    expect(now.inTop).toBe(true);
    expect(now.top).toBeLessThan(before.top);
    expect(before.top).toBe(w.signal[479]);
    expect([...w.macd.slice(480), ...w.signal.slice(480), ...w.hist.slice(480)]).not.toContain(before.top);
    expect(now.top).toBe(w.macd[597]);
  });

  it("on closes: decides exactly the zone rule's entries on the newest 600 closed bars (against the rule told again here), at both sizes", () => {
    for (const bars of [yen, usd]) {
      const n = { SELL: 0, BUY: 0, stayTop: 0, stayBottom: 0 };
      for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
        const want = zoneTold(bars, i);
        const d = decideZoneOnWindow(windowOf(bars, i), LEVEL_WINDOW - 1);
        // the same decision on the longer history (the rule reads the newest 600 bars)
        expect(decideZoneOnWindow(bars, i), `bar ${i}`).toEqual(d);
        expect(d, `bar ${i}`).toEqual(want ? { ...want, fire: true } : null);
        if (want) n[want.side]++;
        const r = macd(windowOf(bars, i).map((b) => b.close));
        const now = bandsOf(r, LEVEL_WINDOW - 1);
        const before = bandsOf(r, LEVEL_WINDOW - 2);
        if (now.up && before.up) n.stayTop++;
        if (now.down && before.down) n.stayBottom++;
      }
      // both sides, and bars staying in a band (no decision) for the check to fail on; EUR/USD's bars are USD/JPY's at a
      // hundredth, and give the same entries
      expect(n).toEqual(N_ZONE);
    }
    expect(zoneFires(usd)).toEqual(zoneFires(yen));
  });

  it("on closes, each of the three sets the pane's edge at some entries (the waves' bars): the line at most, the orange line and the bars at others", () => {
    const by: Record<"macd" | "signal" | "hist", number[]> = { macd: [], signal: [], hist: [] };
    for (const i of zoneFires(yen)) {
      const d = decideZoneOnWindow(yen, i)!;
      const r = macd(windowOf(yen, i).map((b) => b.close));
      const edge = d.side === "SELL" ? d.top : d.bottom;
      by[(["macd", "signal", "hist"] as const).find((k) => r[k].slice(LEVEL_WINDOW - ZONE_BARS).includes(edge))!].push(i);
    }
    // (#362: at 95%; at 90% the line set it at 21 entries, the orange line at 6 and the bars at 3)
    expect(by.macd).toHaveLength(24);
    expect(by.signal).toEqual([1526, 1902]);
    expect(by.hist).toEqual([1222, 1822, 2274]);
  });

  it("on closes: the line going out of the band and in again within the same peak or valley is another entry (the waves' bars)", () => {
    // an entry whose window's line was in the same band at an earlier bar, and on that side of zero all the way since
    const again: string[] = [];
    for (const i of zoneFires(yen)) {
      const d = zoneTold(yen, i)!;
      const r = macd(windowOf(yen, i).map((b) => b.close));
      const ms = r.macd as number[];
      const inSame = (k: number) => (d.side === "SELL" ? bandsOf(r, k).up : bandsOf(r, k).down);
      let j = LEVEL_WINDOW - 3;
      while (j >= 119 && !inSame(j)) j--;
      if (j < 119) continue;
      const since = ms.slice(j);
      if (d.side === "SELL" ? since.every((v) => v > 0) : since.every((v) => v < 0)) again.push(`${d.side}@${i}`);
    }
    // 4 BUYs and 3 SELLs of the 29 entries (#362: at 95%; at 90%, 5 and 3 of 30)
    expect(again).toEqual(["BUY@690", "BUY@809", "BUY@1253", "BUY@1378", "SELL@1764", "SELL@2204", "SELL@2330"]);
    // and each of them is mailed (the email does not keep a gap after the first)
    for (const k of again) {
      const i = Number(k.split("@")[1]);
      expect(macdhSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000), k).toHaveLength(1);
    }
  });

  it("the BUY is the SELL's mirror on closes: the closes negated negate the MACD, and give the BUYs at the SELLs' bars with the numbers negated", () => {
    const negBars = yen.map((b) => ({ close: -b.close }));
    let sells = 0;
    let buys = 0;
    for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
      const a = decideZoneOnWindow(yen, i);
      const b = decideZoneOnWindow(negBars, i);
      if (a === null) {
        expect(b, `bar ${i}`).toBeNull();
        continue;
      }
      expect(b, `bar ${i}`).toEqual({ side: a.side === "SELL" ? "BUY" : "SELL", m: -a.m, top: neg(a.bottom), bottom: neg(a.top), mark: -a.mark, fire: true });
      if (a.side === "SELL") sells++;
      else buys++;
    }
    expect({ sells, buys }).toEqual({ sells: N_ZONE.SELL, buys: N_ZONE.BUY });
  });

  it("fewer values than the rule needs give nothing: 120 bars for a band, one more for an entry; a gap in any of the three among them, nothing; fewer than 600 bars, nothing", () => {
    const r = pane(line(200, 0, { 130: 0.5 }));
    expect(zoneAt(r, 118)).toBeNull();
    expect(zoneAt(r, 119)).not.toBeNull();
    expect(zoneAt(r, 200)).toBeNull();
    // 121 bars: an entry at the last; 120: none (no bar before with its own 120)
    expect(zoneEntryAt(pane(line(121, 0, { 120: 0.5 })), 120)).toEqual({ side: "SELL", m: 0.5, top: 0.5, bottom: 0, mark: ZONE_SHARE * 0.5, fire: true });
    expect(zoneEntryAt(pane(line(120, 0, { 119: 0.5 })), 119)).toBeNull();
    // 130's entry reads 11..130 and the bar before's 10..129: a gap (none, or not a number) in any of the three there
    // gives nothing; one before them, no matter
    expect(zoneEntryAt(r, 130)).toEqual({ side: "SELL", m: 0.5, top: 0.5, bottom: 0, mark: ZONE_SHARE * 0.5, fire: true });
    for (const key of ["macd", "signal", "hist"] as const) {
      for (const [k, v] of [[10, null], [11, null], [60, Number.NaN], [129, Number.POSITIVE_INFINITY]] as const) {
        const gap = { ...r, [key]: [...r[key]] };
        gap[key][k] = v;
        expect(zoneEntryAt(gap, 130), `${key} ${k}`).toBeNull();
      }
      const outside = { ...r, [key]: [...r[key]] };
      outside[key][9] = null;
      expect(zoneEntryAt(outside, 130), key).toEqual(zoneEntryAt(r, 130));
    }
    // a signal line or a histogram that stops short of the bar: nothing (what is missing is no number)
    expect(zoneEntryAt({ ...r, hist: r.hist.slice(0, 130) }, 130)).toBeNull();
    expect(zoneEntryAt({ ...r, signal: r.signal.slice(0, 125) }, 130)).toBeNull();
    // on bars: fewer than 600 ending at the bar, or a bar past the end: no decision
    const i = zoneFires(yen)[0];
    expect(decideZoneOnWindow(windowOf(yen, i), LEVEL_WINDOW - 1)).not.toBeNull();
    expect(decideZoneOnWindow(windowOf(yen, i).slice(1), LEVEL_WINDOW - 2)).toBeNull();
    expect(decideZoneOnWindow(yen.slice(0, LEVEL_WINDOW - 1), LEVEL_WINDOW - 2)).toBeNull();
    expect(decideZoneOnWindow(yen, yen.length)).toBeNull();
  });

  it("mails exactly those entries, the newest bar's, with ULTRA's stop and targets and the numbers that made it (USD/JPY and EUR/USD)", () => {
    for (const [pair, bars] of [["USD/JPY", yen], ["EUR/USD", usd]] as const) {
      let n = 0;
      for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
        const want = zoneTold(bars, i);
        const sigs = macdhSignals(pair, "1h", windowOf(bars, i), closeMsOf(i) + 30_000);
        if (want === null) {
          expect(sigs, `${pair} bar ${i}`).toEqual([]);
          continue;
        }
        n++;
        expect(sigs, `${pair} bar ${i}`).toHaveLength(1);
        const g = sigs[0];
        expect(g.rule).toBe("macdx");
        expect(g.side).toBe(want.side);
        expect(g.pair).toBe(pair);
        expect(g.interval).toBe("1h");
        expect(g.barTime).toBe(new Date(H0 + i * H).toISOString());
        expect(g.closedAt).toBe(new Date(closeMsOf(i)).toISOString());
        expect(g.close).toBe(bars[i].close);
        // ULTRA's stop 13 and targets 4, 10 and 16 pips from the close
        const lv = ultraLevels(want.side, bars[i].close, ultraUnit(pair), ULTRA_PAIRS);
        expect(g.sl).toBe(lv.sl);
        expect(g.tps).toEqual(lv.tps);
        expect(g.macdh).toEqual({ m: want.m, top: want.top, bottom: want.bottom, mark: want.mark });
        expect(want.side === "SELL" ? g.macdh!.m >= g.macdh!.mark : g.macdh!.m <= g.macdh!.mark).toBe(true);
        expect(g.macd).toBeUndefined();
        expect(g.sweep).toBeUndefined();
        expect(g.strong).toBe(false);
        expect([g.rsi, g.rsiPrev, g.line, g.eps]).toEqual([null, null, null, null]);
      }
      expect(n, pair).toBe(N_ZONE.SELL + N_ZONE.BUY);
    }
  });

  it("is no longer the cross rule: on the waves' bars the cross rule fires at 45 bars and the email at 29 others, never at the same bar", () => {
    let crossOnly = 0;
    let mailedOnly = 0;
    let both = 0;
    for (let i = LEVEL_WINDOW - 1; i < yen.length; i++) {
      const cross = decideScaledOnWindow(windowOf(yen, i), LEVEL_WINDOW - 1, MACDH_K)?.fire === true;
      const mailed = macdhSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000).length > 0;
      if (cross && !mailed) crossOnly++;
      if (mailed && !cross) mailedOnly++;
      if (mailed && cross) both++;
    }
    // (45: the #339 block's 23 BUYs and 22 SELLs of the cross rule on these bars)
    expect({ crossOnly, mailedOnly, both }).toEqual({ crossOnly: 45, mailedOnly: N_ZONE.SELL + N_ZONE.BUY, both: 0 });
  });

  it("a longer history gives the same email (the rule reads the newest 600 bars), a shorter one none", () => {
    const i = zoneFires(yen)[5];
    const want = macdhSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000);
    expect(want).toHaveLength(1);
    expect(macdhSignals("USD/JPY", "1h", yen.slice(0, i + 1), closeMsOf(i) + 30_000)).toEqual(want);
    expect(macdhSignals("USD/JPY", "1h", windowOf(yen, i).slice(1), closeMsOf(i) + 30_000)).toEqual([]);
    expect(macdhSignals("USD/JPY", "1h", [], closeMsOf(i))).toEqual([]);
  });

  it("reads the 600 bars ending at the bar and nothing before them: bars before them, however far off, change no number", () => {
    // (on the waves' bars a MACD line worked out from the first bar comes out the same as the 600 bars' to the last
    // bit, the average's start long forgotten; so these checks put 300 bars at 10^12 before them, which a line
    // worked out from the first bar would still carry at the 600th bar)
    const far = Array.from({ length: 300 }, (_, j) => ({ ...yen[0], datetime: stamp(H0 - (300 - j) * H), close: 1e12 }));
    const bars = [...far, ...yen];
    for (const i of zoneFires(yen).slice(0, 6)) {
      const d = decideZoneOnWindow(windowOf(yen, i), LEVEL_WINDOW - 1);
      expect(d, `bar ${i}`).not.toBeNull();
      expect(decideZoneOnWindow(bars, i + far.length), `bar ${i}`).toEqual(d);
      const sigs = macdhSignals("USD/JPY", "1h", bars.slice(0, i + far.length + 1), closeMsOf(i) + 30_000);
      expect(sigs, `bar ${i}`).toEqual(macdhSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000));
      expect(sigs, `bar ${i}`).toHaveLength(1);
    }
    // the far bars do make a difference to a line worked out from the first bar (so the check above can fail)
    const i = zoneFires(yen)[0];
    const fromFirst = macd(bars.slice(0, i + far.length + 1).map((b) => b.close)).macd.slice(-LEVEL_WINDOW);
    const fromWindow = macd(windowOf(yen, i).map((b) => b.close)).macd;
    expect(fromFirst[LEVEL_WINDOW - 1]).not.toBe(fromWindow[LEVEL_WINDOW - 1]);
  });

  it("is mailed while its bar is fresh: closed at most half an hour ago (the hourly reads at +0, +3 and +5 minutes), not before", () => {
    const i = zoneFires(yen)[3];
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
    const i = zoneFires(yen)[3];
    const w = windowOf(yen, i);
    const at = closeMsOf(i) + 30_000;
    expect(macdhSignals("USD/JPY", "1h", w, at)).toHaveLength(1);
    for (const iv of ["5min", "15min", "4h"]) expect(macdhSignals("USD/JPY", iv, w, at), iv).toEqual([]);
    for (const p of ["USD/CAD", "HKD/JPY", "GBP/JPY", "HUF/JPY"]) expect(macdhSignals(p, "1h", w, at), p).toEqual([]);
    // the 5-minute rule's function gives nothing on the hourly chart (the studies call it on 5 minutes)
    expect(macdxSignals("USD/JPY", "1h", w, at)).toEqual([]);
  });

  it("indicatorSignals stays what the live chart labels: Q-Trend's and ULTRA's, not the MACD rule's", () => {
    for (const i of zoneFires(yen).slice(0, 8)) {
      const sigs = indicatorSignals("USD/JPY", "1h", windowOf(yen, i), closeMsOf(i) + 30_000);
      expect(sigs.every((x) => x.rule === "qtrend" || x.rule === "ultra")).toBe(true);
    }
  });

  const sample = (side: "BUY" | "SELL", pair = "USD/JPY") => {
    const bars = pair.includes("JPY") ? yen : usd;
    const i = zoneFires(bars).find((k) => zoneTold(bars, k)!.side === side)!;
    return macdhSignals(pair, "1h", windowOf(bars, i), closeMsOf(i) + 30_000)[0];
  };

  it("the Japanese email: the blue line, the pane's top or bottom and its 95%, ULTRA's levels, the rule, that it is not measured, how to stop it", () => {
    const g = sample("SELL");
    const f = g.macdh!;
    const mail = renderIndicatorMail(g, "ja");
    expect(mail.subject).toBe("【Sextant】ドル/円 1時間足 売り（SELL）のサイン（MACD の山・谷）");
    const t = mail.text;
    expect(t).toContain("ドル/円の1時間足で、MACD の山・谷の売り（SELL）のサインが出ました。");
    expect(t).toContain("MACD(12・26・9): 青い線（MACD）が、新しい120本の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い所）の95%以上（0の線から測って）に届きました");
    expect(f.m).toBeGreaterThan(0);
    expect(t).toContain(`\n  MACD = ${f.m.toFixed(3)}、枠の上の端 = ${f.top.toFixed(3)}（その95% = ${f.mark.toFixed(3)}）`);
    expect(t).toContain("損切り・利確の目安（ULTRA と同じ数字）:");
    expect(t).toContain("（13.0pips）");
    expect(t).toContain("利確1");
    expect(t).toContain("この決まりは Sextant 独自のもの（数字はアプリのオーナーが決めたもの）で、公開されているインジケーターではありません（docs §8.119・§8.122・§8.129）。");
    expect(t).toContain(
      "1時間足の MACD(12・26・9)の青い線が、新しい120本（判定した足までの120本。チャートを開いた時に見える本数）の MACD の枠の上の端（青い線・オレンジの線・棒のうち一番高い値）の95%以上（0の線から測って）に届いた足で売り、枠の下の端（一番低い値）の95%以上に届いた足で買いを送ります。",
    );
    expect(t).toContain("枠の端には、チャートが枠を描く時に足す余白は入れていません。");
    expect(t).toContain("一つの山・谷では1通だけで、青い線が95%の所より内側に戻るまでは、次を送りません（戻ってからまた届けば、もう1通送ります）。");
    expect(t).toContain("損切り・利確の目安はもともとないため、ULTRA と同じ数字を付けています。");
    expect(t).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません。");
    expect(t).toContain("価格は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じ足で判定しています。");
    expect(t).toContain("「MACD の山・谷」でチェックを外してください");
    // nothing of the cross rules (v25 to v27), nor of the 5-minute rule (the orange line is named from v28 as one that
    // sets the pane's edges)
    for (const no of ["クロス", "シグナル", "ふだんの動き", "0.8倍", "8.5 pips", "直近288本", "波の頂点", "§8.109", "§8.114", "§8.116"]) {
      expect(t, no).not.toContain(no);
    }
    // nor of the first make of v28, never mailed: the blue line's own highest or lowest of the 120 bars
    for (const no of ["120本の一番上", "120本の一番下", "一番高い値の90%", "一番低い値の90%", "一番高い値の95%", "一番低い値の95%"]) expect(t, no).not.toContain(no);
    const buy = sample("BUY");
    const fb = buy.macdh!;
    const bt = renderIndicatorMail(buy, "ja");
    expect(bt.subject).toBe("【Sextant】ドル/円 1時間足 買い（BUY）のサイン（MACD の山・谷）");
    expect(bt.text).toContain("ドル/円の1時間足で、MACD の山・谷の買い（BUY）のサインが出ました。");
    expect(bt.text).toContain("MACD(12・26・9): 青い線（MACD）が、新しい120本の MACD の枠の下の端（青い線・オレンジの線・棒の一番低い所）の95%以上（0の線から測って）に届きました");
    // below zero the minus is the chart's (U+2212), not toFixed's hyphen
    expect(fb.m).toBeLessThan(0);
    expect(bt.text).toContain(`\n  MACD = −${(-fb.m).toFixed(3)}、枠の下の端 = −${(-fb.bottom).toFixed(3)}（その95% = −${(-fb.mark).toFixed(3)}）`);
    expect(bt.text).not.toContain("= -");
    for (const no of ["120本の一番上", "120本の一番下", "一番高い値の90%", "一番低い値の90%", "一番高い値の95%", "一番低い値の95%"]) expect(bt.text, no).not.toContain(no);
  });

  it("the English email says the same", () => {
    const g = sample("BUY");
    const f = g.macdh!;
    const mail = renderIndicatorMail(g, "en");
    expect(mail.subject).toBe("[Sextant] USD/JPY 1-hour BUY signal (MACD peak/valley)");
    const t = mail.text;
    expect(t).toContain("A MACD peak/valley BUY signal fired on USD/JPY, 1-hour chart.");
    // "95% or more of the way from the zero line", as the rule paragraph says it (not "at or below 95% of the lowest",
    // which could be read as a distance from zero, the other way round)
    expect(t).toContain(
      "MACD(12, 26, 9): the MACD line (blue) reached the bottom band of the MACD pane of the newest 120 bars: 95% or more of the way from the zero line to the pane's bottom (the lowest of the MACD line, the signal line and the histogram)",
    );
    expect(t).not.toContain("at or below 95%");
    expect(f.m).toBeLessThan(0);
    expect(t).toContain(`\n  MACD = −${(-f.m).toFixed(3)}; bottom of the pane = −${(-f.bottom).toFixed(3)}; 95% of it = −${(-f.mark).toFixed(3)}`);
    expect(t).not.toContain("= -");
    expect(t).toContain("Stop and targets (ULTRA's numbers):");
    expect(t).toContain("(13.0 pips)");
    expect(t).toContain(
      "This is Sextant's own rule (its numbers are the app owner's), not a published indicator (docs §8.119, §8.122, §8.129): it mails a SELL when the 1-hour chart's MACD(12, 26, 9) blue line first reaches 95% or more of the way from the zero line to the top of the MACD pane of the newest 120 bars (the 120 up to the bar judged, what the chart shows when it is opened; the top is the highest of the blue line (the MACD line), the orange line (the signal line) and the bars (the histogram)), and a BUY when it first reaches 95% or more of the way to the pane's bottom (the lowest of them).",
    );
    expect(t).toContain("The pane's edges are taken without the margin the chart adds as it draws them.");
    expect(t).toContain("One email per peak or valley: no next one until the line has gone back inside the 95% mark (if it then comes back to the mark, another is sent).");
    expect(t).toContain("It has no stop or target of its own, so these are ULTRA's numbers.");
    expect(t).toContain("This rule's win rate and its profit or loss a trade have not been measured.");
    expect(t).toContain("untick the chart under MACD peak/valley");
    // nothing of the cross rules or the 5-minute rule (the signal line and the orange line are named from v28 as setting
    // the pane's edges), nor of the first make of v28, never mailed (the blue line's own highest or lowest)
    for (const no of [
      "cross", "usual", "0.8 times", "8.5 pips", "288 bars", "wave's peak", "§8.109", "§8.114", "§8.116",
      "highest MACD of the newest 120 bars", "highest of the 120 bars", "lowest of the 120 bars", "to their highest", "to their lowest",
    ]) {
      expect(t, no).not.toContain(no);
    }
    const sell = sample("SELL");
    const fs = sell.macdh!;
    const st = renderIndicatorMail(sell, "en").text;
    expect(st).toContain(
      "MACD(12, 26, 9): the MACD line (blue) reached the top band of the MACD pane of the newest 120 bars: 95% or more of the way from the zero line to the pane's top (the highest of the MACD line, the signal line and the histogram)",
    );
    expect(st).not.toContain("at or above 95%");
    expect(st).toContain(`\n  MACD = ${fs.m.toFixed(3)}; top of the pane = ${fs.top.toFixed(3)}; 95% of it = ${fs.mark.toFixed(3)}`);
    for (const no of ["highest of the 120 bars", "to their highest"]) expect(st, no).not.toContain(no);
  });

  it("on EUR/USD the line, the top or bottom and the mark are in its own digits", () => {
    const g = sample("SELL", "EUR/USD");
    const f = g.macdh!;
    // the same shape as USD/JPY's at a hundredth: so are the numbers
    expect(f.top / sample("SELL").macdh!.top).toBeCloseTo(0.01, 10);
    const mail = renderIndicatorMail(g, "ja");
    expect(mail.subject).toBe("【Sextant】ユーロ/ドル 1時間足 売り（SELL）のサイン（MACD の山・谷）");
    expect(mail.text).toContain(`\n  MACD = ${f.m.toFixed(5)}、枠の上の端 = ${f.top.toFixed(5)}（その95% = ${f.mark.toFixed(5)}）`);
    const b = sample("BUY", "EUR/USD").macdh!;
    expect(renderIndicatorMail(sample("BUY", "EUR/USD"), "en").text).toContain(
      `\n  MACD = −${(-b.m).toFixed(5)}; bottom of the pane = −${(-b.bottom).toFixed(5)}; 95% of it = −${(-b.mark).toFixed(5)}`,
    );
  });

  // a top (bottom) so small that the price's decimals leave it fewer than two significant digits is written with more
  // decimals, the three numbers alike. The numbers below were entries of the first make of v28 (the blue line's own top
  // or bottom, never mailed) on GMO's stored 1-hour bars, each at the line's first bar past zero (after 63, 31 and 155
  // bars on the other side), where the pane's edge was the bars' (the line at some 3%, 11% and 23% of it: no entry of
  // the pane rule); of the pane rule's 124 entries on the same bars (2026-05-27 to 10-12, the bars production judges)
  // none had an edge that small (#362: nor had its 110 at 95%). The digits stay for one that comes: in the price's 5 decimals EUR/USD's numbers below
  // read 0.00001 three times
  it("a tiny top or bottom is written to two significant digits, the three numbers alike; an ordinary one keeps the price's decimals", () => {
    const withFacts = (g: ReturnType<typeof sample>, macdh: NonNullable<ReturnType<typeof sample>["macdh"]>) => ({ ...g, macdh });
    // EUR/USD, the bar that opened 2026-09-21 00:00 UTC (the first make's SELL at the line's own new top, just above zero)
    const top = 1.2519827838231024e-5;
    expect(ZONE_SHARE * top).toBe(1.1893836446319471e-5);
    const sell = withFacts(sample("SELL", "EUR/USD"), { m: top, top, bottom: -0.002224448448828964, mark: ZONE_SHARE * top });
    expect(renderIndicatorMail(sell, "ja").text).toContain("\n  MACD = 0.000013、枠の上の端 = 0.000013（その95% = 0.000012）");
    expect(renderIndicatorMail(sell, "en").text).toContain("\n  MACD = 0.000013; top of the pane = 0.000013; 95% of it = 0.000012");
    // AUD/USD, the bar that opened 2026-09-09 19:00 UTC (the first make's BUY at the line's own new bottom, just below zero)
    const bottom = -2.7212390874331582e-5;
    expect(ZONE_SHARE * bottom).toBe(-2.5851771330615e-5);
    const buy = withFacts(sample("BUY", "AUD/USD"), { m: bottom, top: 0.0011648807783815052, bottom, mark: ZONE_SHARE * bottom });
    expect(buy.pair).toBe("AUD/USD");
    expect(renderIndicatorMail(buy, "ja").text).toContain("\n  MACD = −0.000027、枠の下の端 = −0.000027（その95% = −0.000026）");
    expect(renderIndicatorMail(buy, "en").text).toContain("\n  MACD = −0.000027; bottom of the pane = −0.000027; 95% of it = −0.000026");
    // USD/JPY, the bar that opened 2026-07-27 01:00 UTC (the first make's BUY): the yen's 3 decimals made 4 (they read −0.010,
    // −0.010, −0.009)
    const low = -0.009667768969592316;
    const yenBuy = withFacts(sample("BUY"), { m: low, top: 0.20580689070584413, bottom: low, mark: ZONE_SHARE * low });
    expect(renderIndicatorMail(yenBuy, "ja").text).toContain("\n  MACD = −0.0097、枠の下の端 = −0.0097（その95% = −0.0092）");
    // the decimals follow the end on the signal's side only (a SELL's tiny bottom changes nothing), and two significant
    // digits at the price's decimals keep them: 0.010 on a yen pair is 3 decimals, 0.0099 is 4
    const yenSell = sample("SELL");
    const f = yenSell.macdh!;
    expect(renderIndicatorMail(withFacts(yenSell, { ...f, bottom: -1e-9 }), "ja").text).toContain(
      `\n  MACD = ${f.m.toFixed(3)}、枠の上の端 = ${f.top.toFixed(3)}（その95% = ${f.mark.toFixed(3)}）`,
    );
    // (#362: the mark is 95% of 0.010, the double nearest 0.0095, which is a hair under 0.0095: 0.009 in 3 decimals)
    expect(ZONE_SHARE * 0.01).toBe(0.0095);
    expect((0.0095).toFixed(3)).toBe("0.009");
    expect(renderIndicatorMail(withFacts(yenSell, { m: 0.01, top: 0.01, bottom: -1, mark: ZONE_SHARE * 0.01 }), "ja").text).toContain(
      "\n  MACD = 0.010、枠の上の端 = 0.010（その95% = 0.009）",
    );
    expect(renderIndicatorMail(withFacts(yenSell, { m: 0.0099, top: 0.0099, bottom: -1, mark: ZONE_SHARE * 0.0099 }), "ja").text).toContain(
      "\n  MACD = 0.0099、枠の上の端 = 0.0099（その95% = 0.0094）",
    );
    // gold keeps its 2 decimals on its ordinary numbers (the #345 block's gold emails); a top of a few cents gets more
    const goldSell = withFacts(sample("SELL"), { m: 0.04, top: 0.04, bottom: -9, mark: ZONE_SHARE * 0.04 });
    expect(renderIndicatorMail({ ...goldSell, pair: "XAU/USD" }, "ja").text).toContain("\n  MACD = 0.040、枠の上の端 = 0.040（その95% = 0.038）");
    // nothing throws on a top far below any price's digits (at most 20 decimals), and a number that is none is a dash
    const far = withFacts(yenSell, { m: 1e-30, top: 1e-30, bottom: -1, mark: ZONE_SHARE * 1e-30 });
    expect(renderIndicatorMail(far, "en").text).toContain(`\n  MACD = ${(1e-30).toFixed(20)}; top of the pane = ${(1e-30).toFixed(20)}; 95% of it = ${(ZONE_SHARE * 1e-30).toFixed(20)}`);
    expect(renderIndicatorMail(withFacts(yenSell, { ...f, mark: Number.NaN }), "ja").text).toContain("（その95% = —）");
  });
});
