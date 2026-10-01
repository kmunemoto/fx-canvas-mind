import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { render as rtlRender, screen, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import { ja } from "@/lib/i18n/ja";
import { en } from "@/lib/i18n/en";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import {
  LIVE_COMMODITIES,
  LIVE_FX_PAIRS,
  LIVE_PAIRS,
  LIVE_PAIR_GROUPS,
  TWELVE_FX_PAIRS,
  isTwelveFx,
  normalizeLiveRead,
  type LiveRead,
} from "../lib/liveChart";
import {
  LIVE_PAIRS as SERVER_PAIRS,
  TWELVE_FX_PAIRS as SERVER_TWELVE_FX,
  fetchLiveQuotes,
  isTwelvePair,
  liveRead,
} from "../../supabase/functions/live-chart/logic";
import { GMO_SYMBOLS, type QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import { priceDecimals, toPips } from "../lib/candleTime";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// GMO's /public/v1/symbols, read on 2026-09-28 (docs §8.65)
const GMO_LISTED = [
  "USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "NZD_JPY", "CAD_JPY", "CHF_JPY", "EUR_USD", "TRY_JPY", "ZAR_JPY", "MXN_JPY",
  "GBP_USD", "AUD_USD", "NZD_USD", "HUF_JPY", "SEK_JPY", "EUR_GBP", "AUD_NZD", "AUD_CAD", "NZD_CAD", "NOK_SEK",
];
// the owner's broker's (楽天FX) 38 pairs, in its order, as the screenshot has them
const BROKER = [
  "USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "GBP/USD", "AUD/USD", "MXN/JPY", "NZD/JPY", "ZAR/JPY", "CAD/JPY", "CHF/JPY",
  "TRY/JPY", "CNH/JPY", "NZD/USD", "USD/CAD", "USD/CHF", "GBP/CHF", "EUR/GBP", "EUR/CHF", "AUD/CHF", "NZD/CHF", "AUD/NZD", "HKD/JPY",
  "SGD/JPY", "NOK/JPY", "EUR/AUD", "GBP/AUD", "HUF/JPY", "SEK/JPY", "PLN/JPY", "CZK/JPY", "CAD/CHF", "NOK/SEK", "AUD/CAD", "NZD/CAD",
  "CNH/HKD", "USD/HKD",
];

// #175: the app keeps the yen pairs only (and gold)
const isYen = (p: string) => p.endsWith("/JPY");

describe("#153 the pairs the live chart offers", () => {
  it("every yen pair GMO serves (#175: 12 of its 21), each among the broker's, in the broker's order, then gold", () => {
    expect(Object.values(GMO_SYMBOLS).sort()).toEqual([...GMO_LISTED].sort());
    expect(LIVE_FX_PAIRS.filter((p) => GMO_SYMBOLS[p] !== undefined)).toEqual(BROKER.filter((p) => GMO_SYMBOLS[p] !== undefined && isYen(p)));
    expect(LIVE_FX_PAIRS.filter((p) => GMO_SYMBOLS[p] !== undefined)).toHaveLength(12);
    expect(LIVE_COMMODITIES).toEqual(["XAU/USD"]);
    // the function and the page list the same pairs in the same order
    expect([...SERVER_PAIRS]).toEqual(LIVE_PAIRS);
  });

  it("#154: and the broker's other yen pairs but the one with no feed (#175), in its order, each read as gold is", () => {
    expect(LIVE_FX_PAIRS).toEqual(BROKER.filter((p) => isYen(p) && p !== "CNH/JPY"));
    expect(LIVE_FX_PAIRS).toHaveLength(17);
    expect(LIVE_PAIR_GROUPS.map((g) => [g.key, g.pairs.length])).toEqual([["fx", 17], ["commodities", 1]]);
    // those GMO does not serve are those read from Twelve Data and Swissquote
    const notGmo = LIVE_FX_PAIRS.filter((p) => GMO_SYMBOLS[p] === undefined);
    expect(notGmo).toEqual([...SERVER_TWELVE_FX]);
    expect(TWELVE_FX_PAIRS).toEqual([...SERVER_TWELVE_FX]);
    for (const p of LIVE_FX_PAIRS) {
      expect(isTwelveFx(p), p).toBe(GMO_SYMBOLS[p] === undefined);
      expect(isTwelvePair(p), p).toBe(GMO_SYMBOLS[p] === undefined);
    }
    expect(isTwelvePair("XAU/USD")).toBe(true);
    expect(isTwelveFx("XAU/USD")).toBe(false);
    // not GMO's feed: no GMO read is made for them
    expect(GMO_SYMBOLS["HKD/JPY"]).toBeUndefined();
  });

  it("#175: none of the 19 pairs without the yen, on the page or in the function", () => {
    const away = BROKER.filter((p) => !isYen(p) && p !== "CNH/HKD");
    expect(away).toHaveLength(19);
    for (const p of away) {
      expect(LIVE_PAIRS.includes(p), p).toBe(false);
      expect((SERVER_PAIRS as readonly string[]).includes(p), p).toBe(false);
      expect(isTwelveFx(p), p).toBe(false);
      expect(isTwelvePair(p), p).toBe(false);
    }
    expect(LIVE_PAIRS.every((p) => isYen(p) || p === "XAU/USD")).toBe(true);
  });

  it("#175: the database keeps subscriptions, stored bars and prices of those 18 only", () => {
    const sql = readFileSync("supabase/migrations/20261001053000_yen_pairs_only.sql", "utf8");
    const lists = [...sql.matchAll(/array\[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    expect(lists).toHaveLength(4);
    for (const l of lists) expect(l).toEqual([...SERVER_PAIRS]);
    // the subscriptions to the others go before the check that forbids them
    const del = sql.indexOf("delete from public.signal_alert_subscriptions");
    const check = sql.indexOf("add constraint signal_alert_subscriptions_pair_check");
    expect(del).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(del);
    expect(sql).toContain("delete from public.live_chart_fallback");
    expect(sql).toContain("delete from public.live_tick_bars");
    // the record and the emails sent are left as they were
    expect(sql).not.toMatch(/(delete from|update) public\.signal_(events|alerts)\b/);
  });

  it("names each in both languages", () => {
    for (const p of LIVE_PAIRS) {
      expect(ja.live.pairNames[p], p).toBeTruthy();
      expect(en.live.pairNames[p], p).toBeTruthy();
    }
    expect(ja.live.pairNames["NOK/SEK"]).toBe("ノルウェークローネ／スウェーデンクローナ");
    expect(ja.live.pairNames["HUF/JPY"]).toBe("ハンガリーフォリント／円");
    // and as the broker's picker labels them, for the grid
    for (const p of LIVE_PAIRS) expect(ja.live.pairShort[p], p).toBeTruthy();
  });

  it("prices each as GMO does (a yen pair to 0.001, the others to 0.00001) and counts its pips", () => {
    expect(priceDecimals("HUF/JPY")).toBe(3);
    expect(priceDecimals("TRY/JPY")).toBe(3);
    expect(priceDecimals("NOK/SEK")).toBe(5);
    expect(priceDecimals("EUR/GBP")).toBe(5);
    // GMO's HUF/JPY on 2026-09-28: 0.485 / 0.491 — 0.6 pips (a yen pip is 0.01)
    expect(toPips("HUF/JPY", 0.491 - 0.485)).toBeCloseTo(0.6, 10);
    expect(toPips("NOK/SEK", 1.04451 - 1.04381)).toBeCloseTo(7, 10);
  });

  it("reads a new pair's bars from GMO by its symbol", async () => {
    // #175: a yen pair #153 added (NOK/SEK, which this read before, is gone)
    const M15 = 15 * 60_000;
    const NOW = Date.parse("2026-09-24T05:02:00Z");
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      asked.push(u.searchParams.get("symbol")!);
      const key = u.searchParams.get("date")!;
      const start = Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T06:00:00+09:00`);
      return {
        status: 0,
        data: Array.from({ length: 96 }, (_, i) => {
          const p = 14.2 + Math.sin(i / 7) * 0.03;
          return { openTime: String(start + i * M15), open: String(p), high: String(p + 0.005), low: String(p - 0.005), close: String(p + 0.002) };
        }),
      };
    };
    const bars = (await fetchLiveQuotes("SEK/JPY", "15min", NOW, Date.now() + 60_000, fetcher))!;
    expect(new Set(asked)).toEqual(new Set(["SEK_JPY"]));
    expect(bars.length).toBeGreaterThan(100);
    const r = liveRead("SEK/JPY", "15min", bars, NOW);
    expect(r.decimals).toBe(3);
    expect(r.candles.length).toBeGreaterThan(0);
  });
});

describe("#153 choosing among them", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });
  const M15 = 15 * 60_000;
  const T0 = Date.parse("2026-09-01T00:00:00Z");
  const quotes: QuoteCandle[] = Array.from({ length: 260 }, (_, i) => {
    const iso = new Date(T0 + i * M15).toISOString();
    const p = 10 + Math.sin(i / 9) * 0.2;
    const side = (d: number) => ({ datetime: iso, open: p + d, high: p + 0.05 + d, low: p - 0.05 + d, close: p + 0.01 + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes, T0 + 259 * M15 + 60_000))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };

  it("the button before the row opens every pair, grouped as the broker's lists are, and a tap there switches the chart", async () => {
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    const loadTicks = vi.fn(async () => ({ "ZAR/JPY": { bid: 9.58, ask: 9.59, mid: 9.585, time: new Date().toISOString(), open: true } }));
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={loadTicks} loadDow={async () => []} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("USD/JPY", "15min"));
    expect(screen.queryByTestId("live-pair-grid")).toBeNull();
    fireEvent.click(screen.getByTestId("live-pair-grid-open"));
    const grid = screen.getByTestId("live-pair-grid");
    const fx = within(screen.getByTestId("live-pair-group-fx"));
    expect(fx.getByText("FX")).toBeTruthy();
    expect(fx.getAllByRole("button")).toHaveLength(17);
    expect(within(screen.getByTestId("live-pair-group-commodities")).getAllByRole("button")).toHaveLength(1);
    expect(within(grid).getByTestId("live-grid-pair-USD/JPY").getAttribute("aria-pressed")).toBe("true");
    // labelled as the broker's picker labels them
    await waitFor(() => expect(within(grid).getByTestId("live-grid-pair-ZAR/JPY").textContent).toBe("ランド/円ZAR/JPY9.585"));
    expect(within(grid).getByTestId("live-grid-pair-SEK/JPY").textContent).toMatch(/^Sクローナ\/円SEK\/JPY/);
    // #175: no pair without the yen
    expect(within(grid).queryByTestId("live-grid-pair-NOK/SEK")).toBeNull();
    expect(within(grid).queryByTestId("live-grid-pair-EUR/USD")).toBeNull();
    fireEvent.click(within(grid).getByTestId("live-grid-pair-ZAR/JPY"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("ZAR/JPY", "15min"));
    expect(screen.queryByTestId("live-pair-grid")).toBeNull();
    expect(screen.getByTestId("live-pair-ZAR/JPY").getAttribute("aria-selected")).toBe("true");
    // and it is remembered as any pair chosen is
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).live.pair).toBe("ZAR/JPY");
  });

  it("a pair saved before (#141) that the chart still has is where it opens — a new one too", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ live: { pair: "SEK/JPY", interval: "1h", view: "gainz" } }));
    resetChartPrefsCache();
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    render(<LiveChart loadBars={loadBars} loadTicks={async () => ({})} loadDow={async () => []} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("SEK/JPY", "1h"));
  });

  it("#175: a pair saved before that the chart no longer has opens USD/JPY, on the saved timeframe", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ live: { pair: "EUR/USD", interval: "1h", view: "gainz" } }));
    resetChartPrefsCache();
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    render(<LiveChart loadBars={loadBars} loadTicks={async () => ({})} loadDow={async () => []} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("USD/JPY", "1h"));
    expect(loadBars.mock.calls.some(([p]) => p === "EUR/USD")).toBe(false);
    expect(screen.getByTestId("live-pair-USD/JPY").getAttribute("aria-selected")).toBe("true");
  });
});
