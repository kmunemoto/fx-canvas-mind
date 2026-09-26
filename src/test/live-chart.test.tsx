import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { applyTick, normalizeLiveRead, normalizeTicks, type LiveRead } from "../lib/liveChart";
import { CHART_BARS, fallbackRead, isMaintenance, liveRead, parseTicker, parseTwelveData, splitBars } from "../../supabase/functions/live-chart/logic";
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

describe("#113 v3: the fallback while GMO cannot be read", () => {
  it("reads Twelve Data's bars oldest first, gives daily bars a time, and drops bars inside the weekend closure", () => {
    const body = {
      status: "ok",
      values: [
        // newest first on the wire; Saturday 2026-09-26 is wholly closed
        { datetime: "2026-09-26", open: "149.5", high: "149.6", low: "149.4", close: "149.5" },
        { datetime: "2026-09-25", open: "149.0", high: "149.9", low: "148.8", close: "149.5" },
        { datetime: "2026-09-24", open: "148.5", high: "149.2", low: "148.3", close: "149.0" },
      ],
    };
    const bars = parseTwelveData(body, "1day")!;
    expect(bars.map((b) => b.datetime)).toEqual(["2026-09-24 00:00:00", "2026-09-25 00:00:00"]);
    expect(parseTwelveData({ status: "error", message: "run out of credits" }, "1h")).toBeNull();
    expect(parseTwelveData(null, "1h")).toBeNull();
  });

  it("draws stored bars like GMO's, says where they came from, and has no spread", () => {
    const bars = quotes(260).map((q) => ({ datetime: q.datetime.slice(0, 19).replace("T", " "), open: q.bid.open, high: q.bid.high, low: q.bid.low, close: q.bid.close }));
    const now = T0 + 262 * M15;
    const r = fallbackRead("USD/JPY", "15min", bars, now, { source: "twelvedata", feed: "maintenance", fetchedAt: "2026-09-26T01:00:00.000Z" });
    expect(r.source).toBe("twelvedata");
    expect(r.feed).toBe("maintenance");
    expect(r.spread).toBeNull();
    // every bar has closed: none forming, RSI to the last candle
    expect(r.candles).toHaveLength(CHART_BARS);
    expect(r.rsi[r.rsi.length - 1]).not.toBeNull();
    expect(liveRead("USD/JPY", "15min", quotes(260), now).source).toBe("gmo");
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
    // #114: the recommended timeframe first
    expect(loadBars).toHaveBeenCalledWith("USD/JPY", "1h");
  });

  it("#114: opens on the GA-style view — its signals only, as filled BUY/SELL labels, no RSI/SAR — with the latest signal's plan", async () => {
    const base = readFor("USD/JPY", "1h");
    const gaMark = { ...base.marks[0], rule: "gainz", side: "SELL" as const, datetime: base.candles[base.candles.length - 3].datetime, barsAgo: 1, entry: 150.1, stop: 150.4, target: 149.5, outcome: "open" as const };
    const rsMark = { ...gaMark, rule: "rsi_sar", side: "BUY" as const, datetime: base.candles[base.candles.length - 10].datetime, barsAgo: 8, outcome: "win" as const };
    const r = { ...base, marks: [rsMark, gaMark], latest: { rsiSar: rsMark, gainz: gaMark } };
    render(<LiveChart loadBars={async () => r} loadTicks={async () => ({})} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(screen.getByTestId("live-view-gainz").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("live-recommended").textContent).toContain("GA型・1時間足");
    const flags = () => [...document.querySelectorAll("[data-rule]")].map((f) => f.getAttribute("data-rule"));
    expect(flags()).toEqual(["gainz"]);
    // the label itself (its hover title still says GA)
    const labels = () => [...document.querySelectorAll("[data-testid='live-chart'] svg[role='img'] text")].map((x) => x.textContent ?? "");
    expect(labels().some((x) => x.startsWith("SELL"))).toBe(true);
    expect(labels().some((x) => x.startsWith("GA "))).toBe(false);
    expect(screen.getByTestId("chart-signal-legend").textContent).toContain("GA型のサイン");
    expect(screen.queryByTestId("chart-gainz-legend")).toBeNull();
    expect(screen.getByTestId("live-latest").textContent).toContain("最新のサイン（GA型）");
    expect(screen.getByTestId("live-latest-plan").textContent).toBe("エントリー 150.100 / TP 149.500 / SL 150.400");
    expect(screen.getByTestId("live-latest-outcome").textContent).toBe("結果: 判定中");
    // both rules, the GA one outlined beside RSI/SAR's
    fireEvent.click(screen.getByTestId("live-view-both"));
    expect(flags()).toEqual(["rsi_sar", "gainz"]);
    expect(labels().some((x) => x.startsWith("GA SELL"))).toBe(true);
    fireEvent.click(screen.getByTestId("live-view-rsi_sar"));
    expect(flags()).toEqual(["rsi_sar"]);
    expect(screen.getByTestId("live-latest").textContent).toContain("最新のサイン（RSI＋SAR）");
    expect(screen.getByTestId("live-latest-outcome").textContent).toBe("結果: 利確に到達");
  });

  it("v3: shows the last bars from the other feed while GMO is down, with no live price and when the market reopens", async () => {
    const r = readFor("USD/JPY", "1h", {
      source: "twelvedata",
      feed: "maintenance",
      fetchedAt: "2026-09-26T01:00:00.000Z",
      reopens: "2026-09-27T22:00:00.000Z",
      nextClose: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const loadBars = vi.fn(async () => r);
    const loadTicks = vi.fn(async () => ({ "USD/JPY": { bid: 150.12, ask: 150.123, mid: 150.1215, time: null, open: true } }));
    render(<LiveChart defaultInterval="1h" loadBars={loadBars} loadTicks={loadTicks} />);
    await waitFor(() => expect(screen.getByTestId("live-fallback").textContent).toContain("別の配信（Twelve Data）の直近の足"));
    expect(screen.getByTestId("live-fallback").textContent).toContain("09-26 10:00 取得");
    expect(screen.getByTestId("live-reopens").textContent).toBe("市場の再開は 09-28 07:00（日本時間）の予定です。");
    expect(screen.getByTestId("live-signals")).toBeTruthy();
    // no price line and no countdown to a close that has passed
    expect(screen.queryByTestId("live-price")).toBeNull();
    expect(screen.queryByTestId("live-next-close")).toBeNull();
  });

  it("recognises GMO's maintenance answer (as seen on 2026-09-26)", () => {
    expect(isMaintenance({ status: 5, messages: [{ message_code: "ERR-5201", message_string: "MAINTENANCE. Please wait for a while" }] })).toBe(true);
    expect(isMaintenance({ status: 0, data: [] })).toBe(false);
    expect(isMaintenance(null)).toBe(false);
  });

  it("says the feed is in maintenance, asks again a minute later, and shows the chart once it is back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const loadBars = vi.fn(async (pair: string, interval: string) => {
      calls++;
      if (calls === 1) throw new Error("maintenance");
      return readFor(pair, interval);
    });
    const loadTicks = vi.fn(async () => {
      throw new Error("maintenance");
    });
    render(<LiveChart defaultInterval="1h" loadBars={loadBars} loadTicks={loadTicks} />);
    await waitFor(() => expect(screen.getByTestId("live-maintenance").textContent).toContain("メンテナンス中"));
    await waitFor(() => expect(screen.getByTestId("live-updated").textContent).toBe("配信メンテナンス中"));
    expect(screen.queryByTestId("live-error")).toBeNull();
    // the price is not asked for every 5 seconds while the feed is down
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(loadTicks).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await waitFor(() => expect(loadBars).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(screen.queryByTestId("live-maintenance")).toBeNull();
  });

  it("does not ask every few seconds when no bar is forming (the market is shut)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval, { nextClose: new Date(Date.now() - 3_600_000).toISOString() }));
    render(<LiveChart defaultInterval="1h" loadBars={loadBars} loadTicks={async () => ({})} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(loadBars).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await waitFor(() => expect(loadBars).toHaveBeenCalledTimes(2));
  });
});
