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
  INDICATOR_INTERVALS,
  QTREND_RULE_ID,
  ULTRA_RULE_ID,
  freshFor,
  gmoIntervalsDue,
  indicatorIntervalsFor,
  indicatorSignals,
  isGmoChartPair,
  isIndicatorChart,
  keepableKlines,
  klineFileEnded,
  klineFileOf,
  twelveCloseDue,
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
    let seen = { qtrend: 0, ultra: 0, strong: 0 };
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
      view.unmount();
      // the sweep: the same history, judged by the alert code
      const barTime = new Date(T - (760 - m) * M5).toISOString();
      const mailed = indicatorSignals("USD/JPY", "5min", historyRead("USD/JPY", "5min", upTo.slice(-(HISTORY_BARS + 1)), now).candles, now)
        .filter((sg) => sg.barTime === barTime)
        .map((sg) => (sg.rule === "qtrend" ? `chart-qtrend-signal-${sg.side}${sg.strong ? "-strong" : ""}` : `chart-ultra-signal-${sg.side}`))
        .sort();
      expect(mailed, `bar ${m}`).toEqual(onChart);
      seen = {
        qtrend: seen.qtrend + mailed.filter((x) => x.includes("qtrend")).length,
        ultra: seen.ultra + mailed.filter((x) => x.includes("ultra")).length,
        strong: seen.strong + mailed.filter((x) => x.includes("strong")).length,
      };
    }
    // the stretch has both indicators' signals, a STRONG among them
    expect(seen.qtrend).toBeGreaterThan(2);
    expect(seen.ultra).toBeGreaterThan(1);
    expect(seen.strong).toBeGreaterThan(0);
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
    expect(SERVER_PAIRS).toHaveLength(37);
    expect(isIndicatorChart("USD/JPY", "5min")).toBe(true);
    expect(isIndicatorChart("USD/CAD", "5min")).toBe(false);
    expect(isIndicatorChart("USD/CAD", "1h")).toBe(true);
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

  it("GMO's charts a minute after their bars close and two minutes later; the hourly and slower a few minutes into the hour", () => {
    const at = (m: number) => gmoIntervalsDue(Date.UTC(2026, 8, 29, 10, m, 0));
    expect(at(0)).toEqual([]);
    expect(at(1)).toEqual(["5min", "15min"]);
    expect(at(2)).toEqual([]);
    expect(at(3)).toEqual(["5min", "15min", "1h"]);
    expect(at(4)).toEqual(["4h", "1day"]);
    expect(at(5)).toEqual(["1h"]);
    expect(at(6)).toEqual(["5min", "4h", "1day"]);
    expect(at(8)).toEqual(["5min"]);
    expect(at(16)).toEqual(["5min", "15min"]);
    expect(at(18)).toEqual(["5min", "15min"]);
    expect(at(31)).toEqual(["5min", "15min"]);
    // every 5-minute close is looked at twice
    const fives = Array.from({ length: 60 }, (_, m) => m).filter((m) => at(m).includes("5min"));
    expect(fives).toHaveLength(24);
  });

  it("Twelve Data's bars from a minute after their close, within their freshness", () => {
    const h = Date.UTC(2026, 8, 29, 10, 0, 0);
    expect(twelveCloseDue("1h", h + 30_000)).toBeNull();
    expect(twelveCloseDue("1h", h + 60_000)).toBe(h);
    expect(twelveCloseDue("1h", h + 29 * 60_000)).toBe(h);
    expect(twelveCloseDue("1h", h + 31 * 60_000)).toBeNull();
    // 4 hours: on the UTC grid (08:00, 12:00)
    expect(twelveCloseDue("4h", h + 5 * 60_000)).toBeNull();
    expect(twelveCloseDue("4h", Date.UTC(2026, 8, 29, 12, 5, 0))).toBe(Date.UTC(2026, 8, 29, 12, 0, 0));
    expect(twelveCloseDue("1day", Date.UTC(2026, 8, 29, 0, 10, 0))).toBe(Date.UTC(2026, 8, 29, 0, 0, 0));
    expect(freshFor("5min")).toBe(10 * 60_000);
    expect(freshFor("15min")).toBe(20 * 60_000);
    expect(freshFor("1h")).toBe(30 * 60_000);
    // the alerts read past the chart's caps, under the key's day
    expect(ALERT_TWELVE_CAP).toBeGreaterThan(Math.max(TWELVE_CAP_REST, ...Object.values(TWELVE_CAPS)));
    expect(ALERT_TWELVE_CAP).toBeLessThan(TWELVE_DAILY_LIMIT);
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
    expect(ul.sl).toBeCloseTo(ul.close - dir * 0.1, 9);
    expect(ul.tps![0]).toBeCloseTo(ul.close + dir * 0.05, 9);
    expect(ul.tps![2]).toBeCloseTo(ul.close + dir * 0.15, 9);
    expect(ul.side === "BUY" ? ul.rsi! > 30 && ul.rsiPrev! <= 30 : ul.rsi! < 70 && ul.rsiPrev! >= 70).toBe(true);
    const qt = all.find((sg) => sg.rule === "qtrend")!;
    expect(qt.line).not.toBeNull();
    expect(qt.eps).toBeGreaterThan(0);
    // the close broke the line by ε
    expect(qt.side === "BUY" ? qt.close > qt.line! + qt.eps! : qt.close < qt.line! - qt.eps!).toBe(true);
    expect(Date.parse(qt.closedAt) - Date.parse(qt.barTime)).toBe(M5);
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
});
