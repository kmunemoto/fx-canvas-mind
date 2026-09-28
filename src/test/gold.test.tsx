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
  TWELVE_DAILY_LIMIT,
  goldFresh,
  goldRead,
  historyOfBars,
  intervalsFor,
  isGold,
  parseSwissquote,
  parseTicker,
  twelveCapFor,
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
  it("is a live pair with every timeframe — #146: the 1- and 5-minute ones too, as every pair", () => {
    expect(LIVE_PAIRS).toContain("XAU/USD");
    expect(isGold("xau/usd")).toBe(true);
    for (const pair of LIVE_PAIRS) expect(intervalsFor(pair)).toEqual(["1min", "5min", "15min", "1h", "4h", "1day"]);
  });

  it("#146: caps the day's Twelve Data reads per timeframe — the 1-minute chart stops first, the 5-minute next, the rest last, under the key's 800", () => {
    expect(TWELVE_DAILY_LIMIT).toBe(800);
    expect(twelveCapFor("1min")).toBeLessThan(twelveCapFor("5min"));
    for (const tf of ["15min", "1h", "4h", "1day"]) expect(twelveCapFor("5min")).toBeLessThan(twelveCapFor(tf));
    expect(new Set(["15min", "1h", "4h", "1day"].map(twelveCapFor)).size).toBe(1);
    // room left for the other functions' reads, which are not counted
    expect(TWELVE_DAILY_LIMIT - twelveCapFor("1day")).toBeGreaterThanOrEqual(50);
    // a 5-minute chart and every longer one open all day (288 + 96 + 24 +
    // 6 + 1 reads) fit under the last cap, and the 5-minute one alone under its own
    expect(288 + 96 + 24 + 6 + 1).toBeLessThanOrEqual(twelveCapFor("1day"));
    expect(288).toBeLessThanOrEqual(twelveCapFor("5min"));
  });

  it("#146: keeps 1- and 5-minute bars until the next one has closed", () => {
    const boundary = Date.parse("2026-09-24T10:15:00Z");
    expect(goldFresh(boundary + 4_000, boundary + 59_000, "1min", false)).toBe(true);
    expect(goldFresh(boundary + 4_000, boundary + 60_000, "1min", false)).toBe(false);
    expect(goldFresh(boundary + 4_000, boundary + 299_000, "5min", false)).toBe(true);
    expect(goldFresh(boundary + 4_000, boundary + 300_000, "5min", false)).toBe(false);
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
    expect(r.limited).toBe(false);
  });

  it("#146: bars that could not be read again: the bar forming when they were read is not a closed bar, none is forming, and a spent day says so", () => {
    const bars = goldBars(300);
    // read 30 seconds into bar 298 (so bar 298 the newest read); it is now
    // two minutes into bar 299
    const fetchedAt = new Date(T0 + 298 * M15 + 30_000).toISOString();
    const now = T0 + 299 * M15 + 120_000;
    const stale = bars.slice(0, 299);
    const r = goldRead(stale, "15min", now, fetchedAt, true);
    expect(r.limited).toBe(true);
    // bar 298 (what was read of it stops 30 seconds in) is left out, and bar
    // 299 was not read at all
    expect(r.candles.at(-1)!.datetime).toBe(bars[297].datetime);
    expect(r.candles).toHaveLength(120);
    expect(r.now.datetime).toBe(bars[297].datetime);
    // no forming bar: its close is in the past, so the chart looks again in a minute
    expect(Date.parse(r.next_close!)).toBeLessThan(now);
    expect(historyOfBars("XAU/USD", "15min", stale, now, fetchedAt).candles).toHaveLength(298);
    // counted from `now` alone, bar 298 would have passed as closed
    expect(historyOfBars("XAU/USD", "15min", stale, now).candles).toHaveLength(299);
    // read after bar 298 closed: complete, and bar 299 forming
    const fresh = goldRead(bars, "15min", now, new Date(T0 + 299 * M15 + 4_000).toISOString());
    expect(fresh.candles.at(-1)!.datetime).toBe(bars[299].datetime);
    expect(fresh.now.datetime).toBe(bars[298].datetime);
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

  it("offers gold beside the pairs, on every timeframe (#146), with its spread in dollars and its own note", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadTicks = vi.fn(async () => ({
      "XAU/USD": { bid: 4284.86, ask: 4285.55, mid: 4285.21, time: new Date().toISOString(), open: true },
    }));
    const loadHistory = vi.fn(async () => []);
    render(<LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={loadTicks} loadHistory={loadHistory} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("USD/JPY", "1min"));
    expect(screen.getByTestId("live-pair-XAU/USD").textContent).toBe("XAU/USD4285.21");

    // #146: from the 1-minute chart, gold opens on its own 1-minute chart
    fireEvent.click(screen.getByTestId("live-pair-XAU/USD"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("XAU/USD", "1min"));
    expect(screen.getByTestId("live-interval-1min")).toBeTruthy();
    expect(screen.getByTestId("live-interval-5min").textContent).toBe("5分足");
    fireEvent.click(screen.getByTestId("live-interval-5min"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("XAU/USD", "5min"));
    expect(screen.queryByTestId("live-gold-limited")).toBeNull();

    await waitFor(() => expect(screen.getByTestId("live-price").textContent).toContain("売値 4284.86 / 買値 4285.55 / スプレッド 0.69ドル"));
    expect(screen.getByTestId("live-note").textContent).toContain("Swissquote");
    // Twelve Data is gold's own feed: not the "GMO cannot be read" notice
    expect(screen.queryByTestId("live-fallback")).toBeNull();
  });

  it("#146: says when gold's timeframe has used the day's reads, and when they come back", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string): Promise<LiveRead> => ({ ...readFor(pair, interval), limited: true, fetchedAt: "2026-09-28T05:04:10.000Z" }));
    render(<LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} />);
    fireEvent.click(await screen.findByTestId("live-pair-XAU/USD"));
    const note = await screen.findByTestId("live-gold-limited");
    expect(note.textContent).toBe(
      "金の1分足は、きょうの Twelve Data の読み込み上限に達したため、09-28 14:04 に読んだ足までを表示しています（足は動きません）。上限は日本時間の朝9時に戻ります。時間足が長いほど上限は後まで残ります。",
    );
    // not the notice for GMO's feed being down
    expect(screen.queryByTestId("live-fallback")).toBeNull();
  });

  it("formats gold's prices to the cent", () => {
    expect(priceDecimals("XAU/USD")).toBe(2);
    expect(pipSize("XAU/USD")).toBe(0.01);
    expect(priceDecimals("USD/JPY")).toBe(3);
    expect(priceDecimals("EUR/USD")).toBe(5);
  });
});
