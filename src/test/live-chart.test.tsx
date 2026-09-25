import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { applyTick, normalizeLiveRead, normalizeTicks, type LiveRead } from "../lib/liveChart";
import { CHART_BARS, liveRead, parseTicker, splitBars } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-21T00:00:00Z");

const quotes = (n: number, seed = 3): QuoteCandle[] => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out: QuoteCandle[] = [];
  let p = 150;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = o + (rnd() - 0.5) * 0.3;
    const mid = { open: o, high: Math.max(o, p) + rnd() * 0.05, low: Math.min(o, p) - rnd() * 0.05, close: p };
    const side = (d: number) => ({ datetime: new Date(T0 + i * M15).toISOString(), open: mid.open + d, high: mid.high + d, low: mid.low + d, close: mid.close + d });
    out.push({ datetime: new Date(T0 + i * M15).toISOString(), bid: side(-0.002), ask: side(0.002) });
  }
  return out;
};

describe("#113 the live read (live-chart/logic.ts)", () => {
  const q = quotes(260);
  // halfway through the last bar: it is forming
  const now = T0 + 259 * M15 + M15 / 2;

  it("keeps the forming bar apart from the closed ones", () => {
    const { closed, forming } = splitBars(q, "15min", now);
    expect(closed).toHaveLength(259);
    expect(forming).not.toBeNull();
    expect(forming!.close).toBeCloseTo((q[259].bid.close + q[259].ask.close) / 2, 10);
  });

  it("draws the last bars with the forming one, every series aligned, both rules' marks, and when to ask again", () => {
    const r = liveRead("USD/JPY", "15min", q, now);
    expect(r.candles).toHaveLength(CHART_BARS + 1);
    expect(r.rsi).toHaveLength(r.candles.length);
    expect(r.sar).toHaveLength(r.candles.length);
    expect(r.sar_below).toHaveLength(r.candles.length);
    // the forming bar has no RSI
    expect(r.rsi[r.rsi.length - 1]).toBeNull();
    expect(r.next_close).toBe(new Date(T0 + 260 * M15).toISOString());
    expect(r.spread).toBeCloseTo(0.004, 6);
    const first = r.candles[0].datetime;
    expect(r.marks.every((m) => m.datetime >= first && (m.rule === "rsi_sar" || m.rule === "gainz"))).toBe(true);
    expect(r.marks.some((m) => m.rule === "gainz")).toBe(true);
    // sorted oldest first
    expect([...r.marks].sort((a, b) => (a.datetime < b.datetime ? -1 : 1)).map((m) => m.datetime)).toEqual(r.marks.map((m) => m.datetime));
  });

  it("reads GMO's ticker for the five pairs only, and never a crossed book", () => {
    const t = parseTicker({
      status: 0,
      data: [
        { symbol: "USD_JPY", bid: "150.120", ask: "150.123", timestamp: "2026-09-25T10:00:01.000Z", status: "OPEN" },
        { symbol: "EUR_USD", bid: "1.10010", ask: "1.10000", timestamp: "2026-09-25T10:00:01.000Z", status: "OPEN" },
        { symbol: "AUD_JPY", bid: "98.1", ask: "98.2", status: "OPEN" },
        { symbol: "GBP_USD", bid: "1.3", ask: "1.30002", status: "CLOSE" },
      ],
    });
    expect(Object.keys(t).sort()).toEqual(["GBP/USD", "USD/JPY"]);
    expect(t["USD/JPY"].mid).toBeCloseTo(150.1215, 10);
    expect(t["GBP/USD"].open).toBe(false);
    expect(parseTicker(null)).toEqual({});
  });
});

describe("#113 the client side", () => {
  it("takes a read only when its series line up with its candles", () => {
    const r = liveRead("USD/JPY", "15min", quotes(260), T0 + 259 * M15 + 60_000);
    const ok = normalizeLiveRead(r)!;
    expect(ok.candles).toHaveLength(r.candles.length);
    expect(ok.nextClose).toBe(r.next_close);
    const bad = normalizeLiveRead({ ...r, candles: [...r.candles.slice(0, -1), { datetime: "x", open: "1" }] });
    expect(bad).toBeNull();
    // a misaligned series is dropped, not shifted
    const short = normalizeLiveRead({ ...r, rsi: r.rsi.slice(1) })!;
    expect(short.rsi.every((v) => v === null)).toBe(true);
    expect(normalizeTicks({ "USD/JPY": { bid: 150, ask: 149 } })).toEqual({});
  });

  it("moves only the forming bar, and only with a price from inside it", () => {
    const c = [
      { datetime: "2026-09-25 10:00:00", open: 150, high: 150.2, low: 149.9, close: 150.1 },
      { datetime: "2026-09-25 10:15:00", open: 150.1, high: 150.15, low: 150.05, close: 150.12 },
    ];
    const open = Date.parse("2026-09-25T10:15:00Z");
    const moved = applyTick(c, 150.3, open, open + 60_000, M15);
    expect(moved[1]).toEqual({ ...c[1], close: 150.3, high: 150.3 });
    expect(moved[0]).toBe(c[0]);
    const down = applyTick(c, 150.0, open, open + 60_000, M15);
    expect(down[1].low).toBe(150.0);
    // a price from after the bar closed changes nothing
    expect(applyTick(c, 151, open, open + M15 + 1, M15)).toBe(c);
    // no forming bar in the read: nothing moves
    expect(applyTick(c, 151, null, open + 1, M15)).toBe(c);
  });
});

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

describe("#113 the live chart card", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const readFor = (pair: string, interval: string, over: Partial<LiveRead> = {}): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), T0 + 259 * M15 + 60_000))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 60_000).toISOString(), ...over };
  };

  it("shows the five pairs with their prices, the chart and both rules, and switches pair and timeframe", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadTicks = vi.fn(async () => ({
      "USD/JPY": { bid: 150.12, ask: 150.123, mid: 150.1215, time: new Date().toISOString(), open: true },
      "EUR/USD": { bid: 1.1, ask: 1.10002, mid: 1.10001, time: null, open: false },
    }));
    render(<LiveChart defaultInterval="4h" loadBars={loadBars} loadTicks={loadTicks} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(loadBars).toHaveBeenCalledWith("USD/JPY", "4h");
    expect(screen.getAllByRole("tab").filter((b) => b.getAttribute("data-testid")?.startsWith("live-pair-"))).toHaveLength(5);
    await waitFor(() => expect(screen.getByTestId("live-price").textContent).toContain("売値 150.120 / 買値 150.123 / スプレッド 0.3pips"));
    expect(screen.getByTestId("live-pair-USD/JPY").textContent).toBe("USD/JPY150.121");
    expect(screen.getByTestId("live-signals").textContent).toContain("RSI＋SAR");
    expect(screen.getByTestId("live-signals").textContent).toContain("GA型");
    expect(screen.getByTestId("live-next-close").textContent).toContain("次の足の確定");
    fireEvent.click(screen.getByTestId("live-pair-EUR/USD"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/USD", "4h"));
    await waitFor(() => expect(screen.getByTestId("live-closed").textContent).toContain("市場休止中"));
    fireEvent.click(screen.getByTestId("live-interval-1min"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/USD", "1min"));
  });

  it("reads again when the bar closes and says when a new signal appeared", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = readFor("USD/JPY", "15min");
    const fresh = { ...base.marks[0], datetime: "2026-09-25 10:00:00", barsAgo: 0, rule: "gainz", side: "SELL" as const };
    let calls = 0;
    const loadBars = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { ...base, latest: { rsiSar: null, gainz: null }, nextClose: new Date(Date.now() + 10_000).toISOString() }
        : { ...base, latest: { rsiSar: null, gainz: fresh }, nextClose: new Date(Date.now() + 900_000).toISOString() };
    });
    const loadTicks = vi.fn(async () => ({}));
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={loadTicks} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(screen.queryByTestId("live-fresh")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await waitFor(() => expect(loadBars).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("live-fresh").textContent).toBe("新しいサイン: GA型 売り（SELL）"));
  });

  it("says so when the chart cannot be read", async () => {
    const loadBars = vi.fn(async () => {
      throw new Error("feed_unavailable");
    });
    render(<LiveChart loadBars={loadBars} loadTicks={async () => ({})} />);
    await waitFor(() => expect(screen.getByTestId("live-error")).toBeTruthy());
    expect(loadBars).toHaveBeenCalledWith("USD/JPY", "15min");
  });
});
