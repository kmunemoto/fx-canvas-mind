import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { pipSize, priceDecimals } from "../lib/candleTime";
import { resetChartPrefsCache } from "../lib/chartPrefs";
import {
  FALLBACK_TTL_MS,
  GOLD_BARS,
  GOLD_QUOTE_STALE_MS,
  LIVE_PAIRS,
  goldFresh,
  goldRead,
  historyOfBars,
  intervalsFor,
  isGold,
  parseSwissquote,
  parseTicker,
  twelveDataUrl,
} from "../../supabase/functions/live-chart/logic";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-21T00:00:00Z");
// Twelve Data's XAU/USD 15-minute bars as the function keeps them, oldest first
const goldBars = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const open = 4280 + Math.sin(i / 7) * 12;
    const close = 4280 + Math.sin((i + 1) / 7) * 12;
    return {
      datetime: new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " "),
      open,
      high: Math.max(open, close) + 1.234,
      low: Math.min(open, close) - 1.234,
      close,
    };
  });

// Swissquote's public quote for XAU/USD, as read on 2026-09-26
const SWISSQUOTE = [
  {
    topo: { platform: "AT", server: "AT" },
    spreadProfilePrices: [
      { spreadProfile: "standard", bidSpread: 27.0, askSpread: 27.0, bid: 4284.855, ask: 4285.545 },
      { spreadProfile: "premium", bidSpread: 25.65, askSpread: 25.65, bid: 4284.869, ask: 4285.532 },
    ],
    ts: 1790370000092,
  },
];

describe("#127 gold (XAU/USD) in the live-chart function", () => {
  it("is a live pair without the 1-minute chart", () => {
    expect(LIVE_PAIRS).toContain("XAU/USD");
    expect(isGold("xau/usd")).toBe(true);
    expect(intervalsFor("XAU/USD")).toEqual(["15min", "1h", "4h", "1day"]);
    expect(intervalsFor("USD/JPY")).toContain("1min");
  });

  it("asks Twelve Data for GOLD_BARS of XAU/USD", () => {
    const url = twelveDataUrl("XAU/USD", "1h", "KEY", GOLD_BARS);
    expect(url).toContain("symbol=XAU%2FUSD");
    expect(url).toContain(`outputsize=${GOLD_BARS}`);
    expect(GOLD_BARS).toBeGreaterThanOrEqual(720);
  });

  it("keeps stored bars until a bar has closed since they were read (30 minutes while the market may be shut)", () => {
    const boundary = Date.parse("2026-09-24T10:15:00Z");
    expect(goldFresh(boundary + 5_000, boundary + 60_000, "15min", false)).toBe(true);
    expect(goldFresh(boundary - 5_000, boundary + 60_000, "15min", false)).toBe(false);
    // 1h bars open on the hour
    expect(goldFresh(Date.parse("2026-09-24T10:05:00Z"), Date.parse("2026-09-24T10:59:00Z"), "1h", false)).toBe(true);
    expect(goldFresh(Date.parse("2026-09-24T10:05:00Z"), Date.parse("2026-09-24T11:00:30Z"), "1h", false)).toBe(false);
    expect(goldFresh(boundary, boundary + FALLBACK_TTL_MS - 1, "15min", true)).toBe(true);
    expect(goldFresh(boundary, boundary + FALLBACK_TTL_MS, "15min", true)).toBe(false);
    expect(goldFresh(Number.NaN, boundary, "15min", false)).toBe(false);
  });

  it("reads Swissquote's standard quote, open only while it is fresh", () => {
    const ts = SWISSQUOTE[0].ts;
    const t = parseSwissquote(SWISSQUOTE, ts + 1_000)!;
    expect(t).toEqual({ bid: 4284.855, ask: 4285.545, mid: (4284.855 + 4285.545) / 2, time: new Date(ts).toISOString(), open: true });
    expect(parseSwissquote(SWISSQUOTE, ts + GOLD_QUOTE_STALE_MS)!.open).toBe(false);
    expect(parseSwissquote([{ spreadProfilePrices: [{ spreadProfile: "standard", bid: 2, ask: 1 }], ts }], ts)).toBeNull();
    expect(parseSwissquote({ error: "x" }, ts)).toBeNull();
    // GMO's ticker never carries it
    expect(parseTicker({ status: 0, data: [{ symbol: "XAU_USD", bid: "1", ask: "2", status: "OPEN" }] })).toEqual({});
  });

  it("reads the bars as a chart: two decimals, the newest bar forming, marked as gold's own feed", () => {
    const bars = goldBars(300);
    const now = T0 + 299 * M15 + 60_000;
    const r = goldRead(bars, "15min", now, new Date(now - 30_000).toISOString());
    expect(r.source).toBe("twelvedata");
    expect(r.feed).toBe("gold");
    expect(r.decimals).toBe(2);
    expect(r.candles).toHaveLength(121);
    expect(r.candles.every((c) => Number(c.close.toFixed(2)) === c.close)).toBe(true);
    expect(r.next_close).toBe(new Date(T0 + 300 * M15).toISOString());
    // its history is the closed bars only
    expect(historyOfBars("XAU/USD", "15min", bars, now).candles).toHaveLength(299);
  });
});

describe("#127 gold on the live chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const readFor = (pair: string, interval: string): LiveRead => {
    const bars = goldBars(300);
    const now = Date.now();
    // shift the bars so the last one is forming now
    const shift = Math.floor(now / M15) * M15 - (T0 + 299 * M15);
    const moved = bars.map((b, i) => ({ ...b, datetime: new Date(T0 + i * M15 + shift).toISOString().slice(0, 19).replace("T", " ") }));
    const r = normalizeLiveRead(goldRead(moved, "15min", now, new Date(now).toISOString()))!;
    return { ...r, pair, interval };
  };

  it("offers gold beside the pairs, without the 1-minute chart, with its spread in dollars and its own note", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadTicks = vi.fn(async () => ({
      "XAU/USD": { bid: 4284.86, ask: 4285.55, mid: 4285.21, time: new Date().toISOString(), open: true },
    }));
    const loadHistory = vi.fn(async () => []);
    render(<LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={loadTicks} loadHistory={loadHistory} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("USD/JPY", "1min"));
    expect(screen.getByTestId("live-pair-XAU/USD").textContent).toBe("XAU/USD4285.21");

    // from the 1-minute chart, gold opens on the recommended timeframe
    fireEvent.click(screen.getByTestId("live-pair-XAU/USD"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("XAU/USD", "1h"));
    expect(loadBars).not.toHaveBeenCalledWith("XAU/USD", "1min");
    expect(screen.queryByTestId("live-interval-1min")).toBeNull();
    expect(screen.getByTestId("live-interval-15min")).toBeTruthy();

    await waitFor(() => expect(screen.getByTestId("live-price").textContent).toContain("売値 4284.86 / 買値 4285.55 / スプレッド 0.69ドル"));
    expect(screen.getByTestId("live-note").textContent).toContain("Swissquote");
    // Twelve Data is gold's own feed: not the "GMO cannot be read" notice
    expect(screen.queryByTestId("live-fallback")).toBeNull();
  });

  it("formats gold's prices to the cent", () => {
    expect(priceDecimals("XAU/USD")).toBe(2);
    expect(pipSize("XAU/USD")).toBe(0.01);
    expect(priceDecimals("USD/JPY")).toBe(3);
    expect(priceDecimals("EUR/USD")).toBe(5);
  });
});
