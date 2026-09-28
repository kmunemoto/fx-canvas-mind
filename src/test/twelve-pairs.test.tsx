import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { act, render as rtlRender, screen, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { normalizeLiveRead, ownFeed, type LiveRead, type Tick } from "../lib/liveChart";
import { priceDecimals, toPips } from "../lib/candleTime";
import { resetChartPrefsCache } from "../lib/chartPrefs";
import {
  GOLD,
  GOLD_BARS,
  GOLD_QUOTE_STALE_MS,
  GOLD_QUOTE_URL,
  TWELVE_FX_PAIRS,
  goldRead,
  isTwelvePair,
  parseSwissquote,
  parseSwissquoteFx,
  swissquoteDue,
  swissquoteUrl,
  twelveDataUrl,
  twelveRead,
} from "../../supabase/functions/live-chart/logic";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// Swissquote's NOK/JPY as read on 2026-09-28 (Monday, 17:53 UTC): three
// platforms, only "AT" with a "standard" profile; another answer lists them
// in another order
const NOK_JPY = [
  {
    topo: { platform: "SwissquoteLtd", server: "Live5" },
    spreadProfilePrices: [
      { spreadProfile: "premium", bidSpread: 15.1, askSpread: 15.1, bid: 16.49068, ask: 16.49793 },
      { spreadProfile: "prime", bidSpread: 15.0, askSpread: 15.0, bid: 16.49069, ask: 16.49792 },
      { spreadProfile: "elite", bidSpread: 14.4, askSpread: 14.4, bid: 16.49075, ask: 16.49786 },
    ],
    ts: 1790618032840,
  },
  {
    topo: { platform: "AT", server: "AT" },
    spreadProfilePrices: [
      { spreadProfile: "standard", bidSpread: 12.7, askSpread: 12.7, bid: 16.49092, ask: 16.49769 },
      { spreadProfile: "premium", bidSpread: 12.6, askSpread: 12.6, bid: 16.49093, ask: 16.49768 },
      { spreadProfile: "prime", bidSpread: 12.5, askSpread: 12.5, bid: 16.49094, ask: 16.49767 },
    ],
    ts: 1790618032840,
  },
  {
    topo: { platform: "SwissquoteCapitalMarkets", server: "Live7" },
    spreadProfilePrices: [
      { spreadProfile: "premium", bidSpread: 15.1, askSpread: 15.1, bid: 16.49068, ask: 16.49793 },
      { spreadProfile: "prime", bidSpread: 14.9, askSpread: 14.9, bid: 16.4907, ask: 16.49791 },
      { spreadProfile: "elite", bidSpread: 14.4, askSpread: 14.4, bid: 16.49075, ask: 16.49786 },
    ],
    ts: 1790618032840,
  },
];
// USD/HKD in the same minute: its book last changed at 17:35:20, over 18
// minutes before, while the other pairs' had changed a second before
const USD_HKD = [
  {
    topo: { platform: "AT", server: "AT" },
    spreadProfilePrices: [
      { spreadProfile: "standard", bidSpread: 9.1, askSpread: 9.1, bid: 7.844, ask: 7.8459 },
      { spreadProfile: "premium", bidSpread: 8.5, askSpread: 8.5, bid: 7.84406, ask: 7.84584 },
    ],
    ts: 1790616920449,
  },
];
const READ_AT = Date.parse("2026-09-28T17:53:55Z");

describe("#154 the broker's pairs GMO does not serve, in the live-chart function", () => {
  it("reads each from Twelve Data (bars) and Swissquote (price) by its own symbol, gold's as before", () => {
    expect(TWELVE_FX_PAIRS).toHaveLength(15);
    for (const p of TWELVE_FX_PAIRS) {
      expect(swissquoteUrl(p)).toBe(`https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${p}`);
      const url = new URL(twelveDataUrl(p, "1h", "KEY", GOLD_BARS));
      expect(url.searchParams.get("symbol")).toBe(p);
      expect(url.searchParams.get("outputsize")).toBe(String(GOLD_BARS));
    }
    expect(GOLD_QUOTE_URL).toBe("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD");
    // neither has CNH/JPY or CNH/HKD here
    expect(isTwelvePair("CNH/JPY")).toBe(false);
    expect(isTwelvePair("CNH/HKD")).toBe(false);
  });

  it("takes Swissquote's standard book wherever it is listed, so the spread does not jump from one answer to the next", () => {
    const standard = { bid: 16.49092, ask: 16.49769, mid: (16.49092 + 16.49769) / 2, time: new Date(1790618032840).toISOString(), open: true };
    expect(parseSwissquote(NOK_JPY, READ_AT)).toEqual(standard);
    expect(parseSwissquote([NOK_JPY[1], NOK_JPY[2], NOK_JPY[0]], READ_AT)).toEqual(standard);
    expect(parseSwissquote([NOK_JPY[2], NOK_JPY[0], NOK_JPY[1]], READ_AT)).toEqual(standard);
    // with no standard book anywhere, the first platform's first
    expect(parseSwissquote([NOK_JPY[2], NOK_JPY[0]], READ_AT)!.bid).toBe(16.49068);
    // a crossed standard book is passed over for a sane one
    const crossed = { ...NOK_JPY[1], spreadProfilePrices: [{ spreadProfile: "standard", bid: 2, ask: 1 }] };
    expect(parseSwissquote([crossed, NOK_JPY[0]], READ_AT)!.bid).toBe(16.49068);
    // 0.7 pips, as the price line shows it
    expect(toPips("NOK/JPY", standard.ask - standard.bid)).toBeCloseTo(0.677, 3);
  });

  it("a quiet pair's price is the price now while the FX week is open, however long its book has stood", () => {
    // USD/HKD's, 18 minutes old on a Monday night: trading, stamped when read
    expect(READ_AT - USD_HKD[0].ts).toBeGreaterThan(18 * 60_000);
    const t = parseSwissquoteFx(USD_HKD, READ_AT)!;
    expect(t).toEqual({ bid: 7.844, ask: 7.8459, mid: (7.844 + 7.8459) / 2, time: new Date(READ_AT).toISOString(), open: true });
    // gold's reading of the same book would have called it shut
    expect(parseSwissquote(USD_HKD, READ_AT)!.open).toBe(false);
    // on a Saturday it is shut, with its own time
    const sat = Date.parse("2026-10-03T10:00:00Z");
    expect(parseSwissquoteFx([{ ...USD_HKD[0], ts: sat - 5_000 }], sat)).toMatchObject({ open: false, time: new Date(sat - 5_000).toISOString() });
    // Friday past the latest close, even a fresh quote
    const friLate = Date.parse("2026-10-02T22:30:00Z");
    expect(parseSwissquoteFx([{ ...USD_HKD[0], ts: friLate - 5_000 }], friLate)!.open).toBe(false);
    // in the hours that may or may not be shut, the quote says: moving is open, standing is shut
    for (const edge of [Date.parse("2026-10-02T21:30:00Z"), Date.parse("2026-10-04T21:30:00Z")]) {
      expect(parseSwissquoteFx([{ ...USD_HKD[0], ts: edge - 10_000 }], edge)).toMatchObject({ open: true, time: new Date(edge).toISOString() });
      expect(parseSwissquoteFx([{ ...USD_HKD[0], ts: edge - GOLD_QUOTE_STALE_MS }], edge)).toMatchObject({ open: false, time: new Date(edge - GOLD_QUOTE_STALE_MS).toISOString() });
    }
    expect(parseSwissquoteFx({ error: "x" }, READ_AT)).toBeNull();
  });

  it("reads the stored bars as a chart of the pair's own feed, priced as the broker's are", () => {
    const M1 = 60_000;
    const t0 = Date.parse("2026-09-28T10:00:00Z");
    const bars = Array.from({ length: 300 }, (_, i) => {
      const p = 1.3712 + Math.sin(i / 8) * 0.0021;
      return { datetime: new Date(t0 + i * M1).toISOString().slice(0, 19).replace("T", " "), open: p, high: p + 0.00031, low: p - 0.00029, close: p + 0.00012 };
    });
    const now = t0 + 299 * M1 + 20_000;
    const r = twelveRead("USD/CAD", bars, "1min", now, new Date(now - 5_000).toISOString());
    expect(r.source).toBe("twelvedata");
    expect(r.feed).toBe("twelve");
    expect(r.decimals).toBe(5);
    expect(r.limited).toBe(false);
    expect(r.next_close).toBe(new Date(t0 + 300 * M1).toISOString());
    expect(twelveRead("HKD/JPY", bars, "1min", now, new Date(now).toISOString()).decimals).toBe(3);
    expect(priceDecimals("HKD/JPY")).toBe(3);
    expect(priceDecimals("USD/HKD")).toBe(5);
    // gold's is the same read, marked as gold's
    const g = twelveRead(GOLD, bars, "1min", now, new Date(now).toISOString(), true, null);
    expect(g.feed).toBe("gold");
    expect(g).toEqual(goldRead(bars, "1min", now, new Date(now).toISOString(), true, null));
    // the page takes both as the pair's own feed, a stand-in while GMO is down as not
    expect(ownFeed(normalizeLiveRead(r)!)).toBe(true);
    expect(ownFeed(normalizeLiveRead(g)!)).toBe(true);
    expect(ownFeed({ ...normalizeLiveRead(r)!, feed: "unavailable" })).toBe(false);
  });

  it("asks Swissquote for the pair on screen at every ticker read, and for the others in turn, each at most once a minute", () => {
    const tried = new Map<string, number>();
    const lastTry = (p: string) => tried.get(p);
    // nothing asked yet: the pair on screen, and the first three others
    expect(swissquoteDue("USD/CAD", lastTry, 1_000_000, 2_000, 60_000, 3)).toEqual(["USD/CAD", "USD/CHF", "GBP/CHF", "EUR/CHF"]);
    // a GMO pair (or none) on screen: only the others
    expect(swissquoteDue("USD/JPY", lastTry, 1_000_000, 2_000, 60_000, 3)).toEqual(["USD/CAD", "USD/CHF", "GBP/CHF"]);
    expect(swissquoteDue(null, lastTry, 1_000_000, 2_000, 60_000, 3)).toHaveLength(3);
    // a client asking every 5 seconds with USD/CAD on screen, for three minutes
    const reads = new Map<string, number[]>();
    for (let now = 1_000_000; now < 1_180_000; now += 5_000) {
      const due = swissquoteDue("USD/CAD", lastTry, now, 2_000, 60_000, 3);
      // never more than four requests in one read
      expect(due.length).toBeLessThanOrEqual(4);
      for (const p of due) {
        tried.set(p, now);
        reads.set(p, [...(reads.get(p) ?? []), now]);
      }
    }
    // the pair on screen every time
    expect(reads.get("USD/CAD")).toHaveLength(36);
    for (const p of TWELVE_FX_PAIRS.filter((x) => x !== "USD/CAD")) {
      const at = reads.get(p) ?? [];
      // each within the first 25 seconds, then about once a minute, never more often
      expect(at[0] - 1_000_000, p).toBeLessThanOrEqual(25_000);
      expect(at.length, p).toBeGreaterThanOrEqual(3);
      for (let k = 1; k < at.length; k++) expect(at[k] - at[k - 1], p).toBeGreaterThanOrEqual(60_000);
      for (let k = 1; k < at.length; k++) expect(at[k] - at[k - 1], p).toBeLessThanOrEqual(80_000);
    }
    // after a pause (the page hidden), with more due than one read asks for:
    // the longest untried first
    const ages = new Map<string, number>([["USD/CHF", 70_000], ["GBP/CHF", 300_000], ["EUR/CHF", 90_000], ["AUD/CHF", 200_000], ["NZD/CHF", 61_000]]);
    const pause = (p: string) => (ages.has(p) ? 3_000_000 - ages.get(p)! : 3_000_000 - 1_000);
    expect(swissquoteDue(null, pause, 3_000_000, 2_000, 60_000, 3)).toEqual(["GBP/CHF", "AUD/CHF", "EUR/CHF"]);
    // the pair on screen asked 1 second ago: not again
    tried.set("USD/CAD", 2_000_000 - 1_000);
    expect(swissquoteDue("USD/CAD", lastTry, 2_000_000, 2_000, 60_000, 3)).not.toContain("USD/CAD");
  });

  it("records the pair on screen's price for its bars as gold's is, in a table only the function can use", () => {
    const sql = readFileSync("supabase/migrations/20260929030000_live_tick_bars.sql", "utf8");
    expect(sql).toMatch(/primary key \(pair, minute\)/);
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/revoke all on public\.live_tick_bars from anon, authenticated/);
    expect(sql).toMatch(/record_live_tick\(p_pair text, p_at timestamptz, p_mid numeric\)/);
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/revoke all on function public\.record_live_tick\(text, timestamptz, numeric\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.record_live_tick\(text, timestamptz, numeric\) to service_role/);
    // the function calls it by those names and reads the pair's rows back
    const fn = readFileSync("supabase/functions/live-chart/index.ts", "utf8");
    expect(fn).toContain('rest("rpc/record_live_tick"');
    expect(fn).toContain("p_pair: p, p_at: tick.time, p_mid: tick.mid");
    expect(fn).toContain("live_tick_bars?pair=eq.${encodeURIComponent(pair)}&minute=gte.");
  });
});

describe("#154 those pairs on the live chart", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    resetChartPrefsCache();
  });
  const M1 = 60_000;
  // Twelve Data's USD/CAD 1-minute bars, the last one forming now
  const readFor = (pair: string, interval: string, over: Partial<LiveRead> = {}): LiveRead => {
    const now = Date.now();
    const last = Math.floor(now / M1) * M1;
    const bars = Array.from({ length: 300 }, (_, i) => {
      const p = 1.3712 + Math.sin(i / 8) * 0.0021;
      return { datetime: new Date(last - (299 - i) * M1).toISOString().slice(0, 19).replace("T", " "), open: p, high: p + 0.00031, low: p - 0.00029, close: p + 0.00012 };
    });
    const r = normalizeLiveRead(twelveRead("USD/CAD", bars, "1min", now, new Date(now).toISOString()))!;
    return { ...r, pair, interval, ...over };
  };
  const cad: Tick = { bid: 1.37101, ask: 1.37117, mid: 1.37109, time: new Date().toISOString(), open: true };

  it("opens one from the list, tells the ticker which is on screen at once, and moves its chart with Swissquote's price", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    // each answer new, as each read of the function is
    const loadTicks = vi.fn(async (p?: string): Promise<Record<string, Tick>> => (p === "USD/CAD" ? { "USD/CAD": { ...cad, time: new Date().toISOString() } } : {}));
    const loadHistory = vi.fn(async () => []);
    render(<LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={loadTicks} loadHistory={loadHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadTicks).toHaveBeenCalledWith("USD/JPY"));
    fireEvent.click(screen.getByTestId("live-pair-grid-open"));
    const grid = screen.getByTestId("live-pair-grid");
    expect(within(grid).getByTestId("live-grid-pair-USD/CAD").textContent).toMatch(/^ドル\/カナダドルUSD\/CAD/);
    expect(within(grid).getByTestId("live-grid-pair-USD/HKD").textContent).toMatch(/^ドル\/香港ドルUSD\/HKD/);
    expect(within(grid).queryByTestId("live-grid-pair-CNH/JPY")).toBeNull();
    expect(screen.getByTestId("live-pair-grid-note").textContent).toContain("表示中のペア以外は1〜3分ほど前");
    fireEvent.click(within(grid).getByTestId("live-grid-pair-USD/CAD"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("USD/CAD", "1min"));
    // at once, not at the next 5-second tick
    await waitFor(() => expect(loadTicks).toHaveBeenCalledWith("USD/CAD"), { timeout: 1_000 });
    await waitFor(() => expect(screen.getByTestId("live-price").textContent).toContain("売値 1.37101 / 買値 1.37117 / スプレッド 1.6pips"));
    // the pair's own feed: not the "GMO cannot be read" notice, its history read as a GMO pair's is
    expect(screen.queryByTestId("live-fallback")).toBeNull();
    expect(screen.queryByTestId("live-ticks-limited")).toBeNull();
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/CAD", "1min"));
    const note = screen.getByTestId("live-note").textContent!;
    expect(note).toContain("GMOコインにないため、足は Twelve Data");
    expect(note).toContain("金と分け合い");
    // the forming bar closes at the price by the next tick
    expect(readFor("USD/CAD", "1min").candles.at(-1)!.close.toFixed(5)).not.toBe("1.37109");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    expect(within(screen.getByTestId("chart-fullscreen-overlay")).getByTestId("chart-fullscreen-price").textContent).toContain("1.37109");
  });

  it("says when its bars are made from Swissquote's prices, and that only its own chart records them", async () => {
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i, { limited: true, ticksFrom: "2026-09-28T05:04:00.000Z" }));
    render(<LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDow={async () => []} />);
    fireEvent.click(await screen.findByTestId("live-pair-USD/CAD"));
    expect((await screen.findByTestId("live-ticks-limited")).textContent).toBe(
      "ドル/カナダドルの1分足は、きょうの Twelve Data の読み込み上限（日本時間の朝9時に戻ります）に達したため、09-28 14:04 からの足を Swissquote の価格（数秒ごと）から作っています。価格はこのペアのチャートが開かれている間だけ記録するので、誰も開いていなかった時間の足は抜けます。",
    );
  });

  it("opening on a saved pair far along the row, keeps it in sight once the prices have widened the row", async () => {
    localStorage.setItem("sextant.chart.prefs.v1", JSON.stringify({ live: { pair: "USD/HKD", interval: "1min", view: "gainz" } }));
    resetChartPrefsCache();
    const seen: string[] = [];
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this.getAttribute("data-testid") ?? "");
    };
    try {
      let answer: ((v: Record<string, Tick>) => void) | null = null;
      const loadTicks = vi.fn(() => new Promise<Record<string, Tick>>((res) => (answer ??= res)));
      render(<LiveChart loadBars={async (p, i) => readFor(p, i)} loadTicks={loadTicks} loadHistory={async () => []} loadDow={async () => []} />);
      await waitFor(() => expect(seen).toContain("live-pair-USD/HKD"));
      const before = seen.length;
      answer!({ "USD/HKD": { bid: 7.8449, ask: 7.8451, mid: 7.845, time: new Date().toISOString(), open: true } });
      await waitFor(() => expect(seen.length).toBeGreaterThan(before));
      expect(seen.at(-1)).toBe("live-pair-USD/HKD");
    } finally {
      Element.prototype.scrollIntoView = had;
    }
  });

  it("drops a price answer older than the one shown (asked before the pair changed)", async () => {
    let first: ((v: Record<string, Tick>) => void) | null = null;
    const loadTicks = vi.fn((p?: string) =>
      p === "USD/JPY" && !first ? new Promise<Record<string, Tick>>((res) => (first = res)) : Promise.resolve(p === "USD/CAD" ? { "USD/CAD": cad } : {}),
    );
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    render(<LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={loadTicks} loadHistory={async () => []} loadDow={async () => []} />);
    await waitFor(() => expect(first).not.toBeNull());
    fireEvent.click(screen.getByTestId("live-pair-USD/CAD"));
    await waitFor(() => expect(screen.getByTestId("live-price").textContent).toContain("売値 1.37101"));
    // the answer asked for with USD/JPY on screen arrives last, without USD/CAD's price
    first!({ "USD/JPY": { bid: 150.12, ask: 150.123, mid: 150.1215, time: new Date().toISOString(), open: true } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("live-price").textContent).toContain("売値 1.37101");
  });
});
