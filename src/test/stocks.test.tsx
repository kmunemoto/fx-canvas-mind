import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { LIVE_PAIR_GROUPS, dowTfsFor as clientDowTfsFor, intervalsFor as clientIntervalsFor, isLiveSymbol, normalizeHits, normalizeLiveRead, ownFeed, type LiveRead, type Tick } from "../lib/liveChart";
import { formatDistance, pipSize, priceDecimals } from "../lib/candleTime";
import { JP_STOCKS, US_STOCKS, learnStockName, matchListed, stockName, type StockHit } from "../lib/stocks";
import {
  STOCK_INTERVALS,
  isStockQuery,
  isStockSymbol,
  parseYahooChart,
  parseYahooQuote,
  parseYahooSearch,
  yahooChartUrl,
  yahooSearchUrl,
} from "../../supabase/functions/live-chart/stocks";
import { dowTfsFor, fallbackRead, intervalsFor } from "../../supabase/functions/live-chart/logic";
import type { Candle } from "../../supabase/functions/analyze/indicators";

// Yahoo's answers as read on 2026-10-31 (.github/workflows/feed-check.yml):
// Intel's and Toyota's hourly bars of Friday 2026-10-30, each session ended
// by the closing auction's point (16:00 New York, 15:30 Tokyo)
const yahoo = (
  symbol: string,
  meta: Record<string, unknown>,
  t: number[],
  q: { open: Array<number | null>; high: Array<number | null>; low: Array<number | null>; close: Array<number | null> },
) => ({
  chart: {
    result: [{ meta: { symbol, ...meta }, timestamp: t, indicators: { quote: [{ ...q, volume: t.map(() => 1) }] } }],
    error: null,
  },
});
const session = (start: number, end: number) => ({ regular: { timezone: "X", start, end, gmtoffset: 0 } });
const INTC = yahoo(
  "INTC",
  { regularMarketPrice: 65.76, regularMarketTime: 1793390401, gmtoffset: -14400, currentTradingPeriod: session(1793367000, 1793390400) },
  [1793367000, 1793370600, 1793374200, 1793377800, 1793381400, 1793385000, 1793388600, 1793390400],
  {
    open: [68.3499984741211, 65.94000244140625, 65.97959899902344, 64.75499725341797, 64.37999725341797, 63.78390121459961, 63.875, 65.76000213623047],
    high: [68.76000213623047, 67.41000366210938, 66.09739685058594, 65.0, 64.39949798583984, 64.19999694824219, 65.87999725341797, 65.76000213623047],
    low: [64.12000274658203, 65.63009643554688, 64.26000213623047, 64.1050033569336, 63.5, 63.20009994506836, 63.58000183105469, 65.76000213623047],
    close: [65.94000244140625, 65.97250366210938, 64.75990295410156, 64.38500213623047, 63.78499984741211, 63.875, 65.87999725341797, 65.76000213623047],
  },
);
const TOYOTA = yahoo(
  "7203.T",
  { regularMarketPrice: 3070, regularMarketTime: 1793341800, gmtoffset: 32400, currentTradingPeriod: session(1793318400, 1793341800) },
  [1793318400, 1793322000, 1793325600, 1793329200, 1793332800, 1793336400, 1793340000, 1793341800],
  {
    open: [3107, 3074, 3073, 3055, 3062, 3068, 3067, 3070],
    high: [3107, 3076, 3075, 3066, 3069, 3068, 3079, 3070],
    low: [3073, 3061, 3050, 3054, 3059, 3058, 3065, 3070],
    close: [3073, 3072, 3053, 3062, 3068, 3067, 3077, 3070],
  },
);
// Saturday 2026-10-31, 13:00 UTC: both markets shut
const SAT = Date.parse("2026-10-31T13:00:00Z");

describe("#389 a share, named as Yahoo names it (live-chart/stocks.ts)", () => {
  it("takes a US ticker (a class after a dash) and a Tokyo code on .T, and nothing else", () => {
    for (const s of ["AAPL", "INTC", "BRK-B", "F", "7203.T", "130A.T"]) expect(isStockSymbol(s)).toBe(true);
    for (const s of ["USD/JPY", "XAU/USD", "aapl", "7203", "7203.TO", "AAPL;", "TOOLONG", "", null, 7203]) expect(isStockSymbol(s)).toBe(false);
    expect(yahooChartUrl("7203.T", "1h")).toBe("https://query1.finance.yahoo.com/v8/finance/chart/7203.T?interval=60m&range=1y&includePrePost=false");
    expect(yahooChartUrl("AAPL", "1min")).toContain("interval=1m&range=5d");
    expect(yahooSearchUrl("sony")).toContain("q=sony&quotesCount=10&newsCount=0&lang=ja-JP&region=JP");
  });

  it("reads the hourly bars, the closing auction's point joined to the last bar, not a bar of its own", () => {
    const intc = parseYahooChart("INTC", INTC, "1h", SAT)!;
    expect(intc.bars).toHaveLength(7);
    expect(intc.bars[0]).toEqual({ datetime: "2026-10-30 13:30:00", open: 68.3499984741211, high: 68.76000213623047, low: 64.12000274658203, close: 65.94000244140625 });
    // the 15:30 bar (19:30 UTC) closes at the auction's 65.76, its high and low kept
    expect(intc.bars[6]).toEqual({ datetime: "2026-10-30 19:30:00", open: 63.875, high: 65.87999725341797, low: 63.58000183105469, close: 65.76000213623047 });
    expect(intc.quote).toEqual({ price: 65.76, time: new Date(1793390401 * 1000).toISOString(), open: false });
    const toyota = parseYahooChart("7203.T", TOYOTA, "1h", SAT)!;
    expect(toyota.bars.map((b) => b.datetime)).toEqual(
      ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"].map((h) => `2026-10-30 ${h}:00`),
    );
    expect(toyota.bars[6]).toEqual({ datetime: "2026-10-30 06:00:00", open: 3067, high: 3079, low: 3065, close: 3070 });
  });

  it("leaves out a bar with a price missing, and stamps a day's bars with the exchange's own date", () => {
    const gap = yahoo("AAPL", { currentTradingPeriod: session(100, 200) }, [10, 20, 30], {
      open: [1, null, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3],
    });
    expect(parseYahooChart("AAPL", gap, "1min", SAT)!.bars.map((b) => b.close)).toEqual([1, 3]);
    // New York's day opens 13:30 UTC; Tokyo's month stamped at its midnight (15:00 UTC the day before)
    const day = yahoo("AAPL", { gmtoffset: -14400 }, [1793367000], { open: [1], high: [2], low: [1], close: [2] });
    expect(parseYahooChart("AAPL", day, "1day", SAT)!.bars[0].datetime).toBe("2026-10-30");
    const month = yahoo("7203.T", { gmtoffset: 32400 }, [Date.parse("2026-09-30T15:00:00Z") / 1000], { open: [1], high: [2], low: [1], close: [2] });
    expect(parseYahooChart("7203.T", month, "1month", SAT)!.bars[0].datetime).toBe("2026-10-01");
    expect(parseYahooChart("AAPL", { chart: { result: null } }, "1h", SAT)).toBeNull();
    expect(parseYahooChart("AAPL", null, "1h", SAT)).toBeNull();
  });

  it("says the market is open only inside the regular session, and not in Tokyo's lunch break", () => {
    const meta = (start: string, end: string) => ({ regularMarketPrice: 100, regularMarketTime: 1, currentTradingPeriod: session(Date.parse(start) / 1000, Date.parse(end) / 1000) });
    const ny = meta("2026-11-02T14:30:00Z", "2026-11-02T21:00:00Z");
    expect(parseYahooQuote("AAPL", ny, Date.parse("2026-11-02T15:00:00Z"))!.open).toBe(true);
    expect(parseYahooQuote("AAPL", ny, Date.parse("2026-11-02T21:00:00Z"))!.open).toBe(false);
    const tokyo = meta("2026-11-02T00:00:00Z", "2026-11-02T06:30:00Z");
    expect(parseYahooQuote("7203.T", tokyo, Date.parse("2026-11-02T02:00:00Z"))!.open).toBe(true);
    // 11:45 JST: lunch
    expect(parseYahooQuote("7203.T", tokyo, Date.parse("2026-11-02T02:45:00Z"))!.open).toBe(false);
    // 12:30 JST: the afternoon
    expect(parseYahooQuote("7203.T", tokyo, Date.parse("2026-11-02T03:30:00Z"))!.open).toBe(true);
    expect(parseYahooQuote("AAPL", { regularMarketPrice: null }, SAT)).toBeNull();
  });

  it("finds US and Tokyo shares only (not over-the-counter or other countries'), named in Japanese where Yahoo has it", () => {
    const hits = parseYahooSearch({
      quotes: [
        { symbol: "SONY", shortname: "Sony Group Corporation", longname: "ソニーグループ株式会社", exchange: "NYQ", quoteType: "EQUITY" },
        { symbol: "6758.T", shortname: "SONY GROUP CORPORATION", longname: "ソニーグループ", exchange: "JPX", quoteType: "EQUITY" },
        { symbol: "SFGYY", shortname: "Sony Financial Group Inc.", exchange: "PNK", quoteType: "EQUITY" },
        { symbol: "SONA.SG", shortname: "Sony Group Corp. (ADRs)", exchange: "STU", quoteType: "EQUITY" },
        { symbol: "7203.SR", shortname: "Elm Co", exchange: "SAU", quoteType: "EQUITY" },
        { symbol: "SONYETF", shortname: "a fund", exchange: "NYQ", quoteType: "ETF" },
        { symbol: "INTC", shortname: "Intel Corporation", exchange: "NMS", quoteType: "EQUITY" },
      ],
    });
    expect(hits).toEqual([
      { symbol: "SONY", name: "ソニーグループ株式会社", market: "us" },
      { symbol: "6758.T", name: "ソニーグループ", market: "jp" },
      { symbol: "INTC", name: "Intel Corporation", market: "us" },
    ]);
    expect(parseYahooSearch(null)).toEqual([]);
    expect(isStockQuery("sony")).toBe(true);
    expect(isStockQuery("トヨタ")).toBe(true);
    expect(isStockQuery("")).toBe(false);
    expect(isStockQuery("a;b")).toBe(false);
    expect(isStockQuery("x".repeat(41))).toBe(false);
  });

  it("has the timeframes Yahoo has, the Dow reading without 4 hours, and a share's prices to the cent or the tenth of a yen", () => {
    expect([...STOCK_INTERVALS]).toEqual(["1min", "2min", "5min", "15min", "30min", "1h", "1day", "1week", "1month"]);
    expect([...intervalsFor("7203.T")]).toEqual([...STOCK_INTERVALS]);
    expect(intervalsFor("USD/JPY")).toContain("4h");
    expect([...dowTfsFor("AAPL")]).toEqual(["1h", "15min", "5min"]);
    expect([...dowTfsFor("USD/JPY")]).toEqual(["4h", "1h", "15min", "5min"]);
    const bars: Candle[] = parseYahooChart("7203.T", TOYOTA, "1h", SAT)!.bars;
    const r = fallbackRead("7203.T", "1h", bars, SAT, { source: "yahoo", feed: "stock", fetchedAt: new Date(SAT).toISOString() });
    expect(r.decimals).toBe(1);
    expect(r.source).toBe("yahoo");
    expect(r.feed).toBe("stock");
    expect(r.candles).toHaveLength(7);
    expect(r.candles[6].close).toBe(3070);
    const read = normalizeLiveRead(r)!;
    expect(read.source).toBe("yahoo");
    expect(ownFeed(read)).toBe(true);
  });
});

describe("#389 shares in the app (src/lib)", () => {
  it("lists the US and Japanese shares checked, finds them by Japanese name, and names a searched one as Yahoo did", () => {
    expect(LIVE_PAIR_GROUPS.map((g) => g.key)).toEqual(["fx", "commodities", "usStocks", "jpStocks"]);
    expect(LIVE_PAIR_GROUPS[2].pairs).toEqual(["NVDA", "INTC", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"]);
    expect(LIVE_PAIR_GROUPS[3].pairs).toHaveLength(14);
    expect([...US_STOCKS, ...JP_STOCKS].every((s) => isStockSymbol(s.symbol))).toBe(true);
    expect(matchListed("トヨタ").map((s) => s.symbol)).toEqual(["7203.T"]);
    expect(matchListed("sony").map((s) => s.symbol)).toEqual(["6758.T"]);
    expect(matchListed("   ")).toEqual([]);
    expect(stockName("7203.T", "ja")).toBe("トヨタ自動車");
    expect(stockName("7203.T", "en")).toBe("Toyota Motor");
    expect(stockName("IBM", "ja")).toBeNull();
    learnStockName("IBM", "International Business Machines");
    expect(stockName("IBM", "ja")).toBe("International Business Machines");
    expect(isLiveSymbol("IBM")).toBe(true);
    expect(isLiveSymbol("USD/JPY")).toBe(true);
    expect(isLiveSymbol("GBP/USD")).toBe(false);
    expect(clientIntervalsFor("IBM")).toEqual([...STOCK_INTERVALS]);
    expect(clientDowTfsFor("IBM")).toEqual(["1h", "15min", "5min"]);
    expect(normalizeHits([{ symbol: "IBM", name: "IBM", market: "us" }, { symbol: "bad", name: "x", market: "us" }, null])).toEqual([
      { symbol: "IBM", name: "IBM", market: "us" },
    ]);
  });

  it("writes a share's price and distances in its own money", () => {
    expect(priceDecimals("AAPL")).toBe(2);
    expect(priceDecimals("7203.T")).toBe(1);
    expect(pipSize("AAPL")).toBeCloseTo(0.01, 12);
    expect(pipSize("7203.T")).toBeCloseTo(0.1, 12);
    expect(formatDistance("AAPL", 1.234, { signed: true })).toBe("+$1.23");
    expect(formatDistance("7203.T", -12.34)).toBe("−¥12.3");
    // the pairs as before
    expect(priceDecimals("USD/JPY")).toBe(3);
    expect(formatDistance("USD/JPY", 0.12)).toBe("12pips");
  });
});

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

describe("#389 the live chart with shares", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const H = 3_600_000;
  // an hourly walk for any pair or share, its newest bar forming
  const readFor = (pair: string, interval: string): LiveRead => {
    const now = Date.now();
    const start = Math.floor(now / H) * H - 199 * H;
    const bars: Candle[] = Array.from({ length: 200 }, (_, i) => {
      const p = 3000 + Math.sin(i / 7) * 30;
      return { datetime: new Date(start + i * H).toISOString().slice(0, 19).replace("T", " "), open: p, high: p + 5, low: p - 5, close: p + 1 };
    });
    const r = fallbackRead(pair, interval, bars, now, { source: pair.includes("/") ? "gmo" : "yahoo", feed: pair.includes("/") ? null : "stock", fetchedAt: new Date(now).toISOString() });
    return normalizeLiveRead(r)!;
  };
  const toyotaTick: Record<string, Tick> = { "7203.T": { bid: 3070, ask: 3070, mid: 3070, time: new Date().toISOString(), open: false } };

  it("lists the US and Japanese shares, opens one on its hourly chart with its price, its timeframes and Yahoo's note", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadTicks = vi.fn(async (pair?: string) => (pair === "7203.T" ? toyotaTick : {}));
    render(<LiveChart loadBars={loadBars} loadTicks={loadTicks} loadSearch={async () => []} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("USD/JPY", "4h"));
    fireEvent.click(screen.getByTestId("live-pair-grid-open"));
    const grid = screen.getByTestId("live-pair-grid");
    expect(within(grid).getByTestId("live-pair-group-usStocks").textContent).toContain("米国株");
    expect(within(grid).getByTestId("live-grid-pair-NVDA").textContent).toContain("エヌビディア");
    expect(within(grid).getByTestId("live-pair-group-jpStocks").textContent).toContain("日本株");
    expect(within(grid).getByTestId("live-grid-pair-7203.T").textContent).toContain("トヨタ自動車");
    fireEvent.click(within(grid).getByTestId("live-grid-pair-7203.T"));
    // the 4-hour chart a share has not: its hourly one
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("7203.T", "1h"));
    await waitFor(() => expect(loadTicks).toHaveBeenCalledWith("7203.T"));
    await waitFor(() => expect(screen.getByTestId("live-price").textContent).toContain("値段 3070.0円（最後に約定した値段）"));
    expect(screen.getByTestId("live-closed").textContent).toContain("市場休止中");
    const tfs = screen.getAllByRole("tab").map((b) => b.getAttribute("data-testid") ?? "").filter((id) => id.startsWith("live-interval-"));
    expect(tfs).toEqual([...STOCK_INTERVALS].map((tf) => `live-interval-${tf}`));
    // the share on screen leads the row
    const row = screen.getAllByRole("tab").map((b) => b.getAttribute("data-testid") ?? "").filter((id) => id.startsWith("live-pair-"));
    expect(row[0]).toBe("live-pair-7203.T");
    expect(row[1]).toBe("live-pair-USD/JPY");
    await waitFor(() => expect(screen.getByTestId("live-note").textContent).toContain("Yahoo Finance"));
    expect(screen.getByTestId("live-note").textContent).toContain("株のメール通知は、まだありません");
  });

  it("finds a share by Yahoo's search once the typing stops, and a Japanese name in the list without asking Yahoo", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadSearch = vi.fn(async (q: string): Promise<StockHit[]> =>
      q === "sony"
        ? [
          { symbol: "SONY", name: "ソニーグループ株式会社", market: "us" },
          { symbol: "6758.T", name: "ソニーグループ", market: "jp" },
        ]
        : [],
    );
    render(<LiveChart loadBars={loadBars} loadTicks={async () => ({})} loadSearch={loadSearch} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("USD/JPY", "4h"));
    fireEvent.click(screen.getByTestId("live-pair-grid-open"));
    const q = screen.getByTestId("live-stock-q");
    // Japanese: the list only
    fireEvent.change(q, { target: { value: "トヨタ" } });
    expect(screen.getByTestId("live-stock-hit-7203.T").textContent).toContain("トヨタ自動車");
    await new Promise((r) => setTimeout(r, 500));
    expect(loadSearch).not.toHaveBeenCalled();
    // English: the list's Sony first, then Yahoo's other find (once each)
    fireEvent.change(q, { target: { value: "sony" } });
    await waitFor(() => expect(loadSearch).toHaveBeenCalledWith("sony"));
    await waitFor(() => expect(screen.getByTestId("live-stock-hit-SONY")).toBeTruthy());
    expect(screen.getAllByTestId("live-stock-hit-6758.T")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("live-stock-hit-SONY"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("SONY", "1h"));
    expect(screen.queryByTestId("live-pair-grid")).toBeNull();
    expect(stockName("SONY", "ja")).toBe("ソニーグループ株式会社");
    // nothing found says how to search
    fireEvent.click(screen.getByTestId("live-pair-grid-open"));
    fireEvent.change(screen.getByTestId("live-stock-q"), { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByTestId("live-stock-no-hits").textContent).toContain("見つかりませんでした"));
  });

  it("says when Yahoo's search does not answer", async () => {
    const loadSearch = vi.fn(async () => {
      throw new Error("feed_unavailable");
    });
    render(<LiveChart loadBars={async (p, iv) => readFor(p, iv)} loadTicks={async () => ({})} loadSearch={loadSearch} />);
    fireEvent.click(screen.getByTestId("live-pair-grid-open"));
    fireEvent.change(screen.getByTestId("live-stock-q"), { target: { value: "ibm" } });
    await waitFor(() => expect(screen.getByTestId("live-stock-search-error").textContent).toContain("探せませんでした"));
  });
});
