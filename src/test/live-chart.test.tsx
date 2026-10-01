import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import { normalizeLiveRead, normalizeTicks, tickLive, unjudgedOf, withRead, type LiveBars, type LiveRead } from "../lib/liveChart";
import {
  CHART_BARS,
  HISTORY_BARS,
  LIVE_INTERVALS,
  READ_BARS,
  fallbackRead,
  fetchLiveQuotes,
  isLiveInterval,
  isMaintenance,
  liveRead,
  parseTicker,
  parseTwelveData,
  splitBars,
} from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-21T00:00:00Z");

// #132: seed 28 — a walk on which both rules fire in the chart's window at
// their current settings (GA 0.7/40/5 and RSI(9) 25/75 fire less often)
const quotes = (n: number, seed = 28): QuoteCandle[] => {
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

  it("reads GMO's ticker for the chart's pairs only (#153: those GMO serves; #175: its yen pairs; #177: and EUR/USD), and never a crossed book", () => {
    const t = parseTicker({
      status: 0,
      data: [
        { symbol: "USD_JPY", bid: "150.120", ask: "150.123", timestamp: "2026-09-25T10:00:01.000Z", status: "OPEN" },
        { symbol: "EUR_JPY", bid: "163.010", ask: "163.000", timestamp: "2026-09-25T10:00:01.000Z", status: "OPEN" },
        { symbol: "AUD_JPY", bid: "98.1", ask: "98.2", status: "OPEN" },
        { symbol: "SEK_JPY", bid: "15.871", ask: "15.879", timestamp: "2026-09-28T17:10:53.315Z", status: "OPEN" },
        // #177: the chart has it again
        { symbol: "EUR_USD", bid: "1.10000", ask: "1.10010", status: "OPEN" },
        // GMO serves these, but the chart no longer has them (#175)
        { symbol: "GBP_USD", bid: "1.33000", ask: "1.33012", status: "OPEN" },
        { symbol: "NOK_SEK", bid: "1.04381", ask: "1.04451", timestamp: "2026-09-28T17:10:53.315Z", status: "OPEN" },
        { symbol: "USD_CHF", bid: "0.83", ask: "0.8301", status: "OPEN" },
        { symbol: "GBP_JPY", bid: "201.5", ask: "201.52", status: "CLOSE" },
      ],
    });
    expect(Object.keys(t).sort()).toEqual(["AUD/JPY", "EUR/USD", "GBP/JPY", "SEK/JPY", "USD/JPY"]);
    expect(t["USD/JPY"].mid).toBeCloseTo(150.1215, 10);
    expect(t["GBP/JPY"].open).toBe(false);
    expect(parseTicker(null)).toEqual({});
  });
});

describe("#146 the 5-minute chart for every pair", () => {
  // GMO's 5-minute bars, one JST day file (06:00 JST on) at a time
  const M5 = 5 * 60_000;
  const dayFile = (key: string, side: "bid" | "ask") => {
    const start = Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T06:00:00+09:00`);
    return {
      status: 0,
      data: Array.from({ length: 288 }, (_, i) => {
        const p = 150 + Math.sin(i / 9) * 0.2 + (side === "ask" ? 0.003 : 0);
        return { openTime: String(start + i * M5), open: String(p), high: String(p + 0.02), low: String(p - 0.02), close: String(p + 0.01) };
      }),
    };
  };
  // a Thursday, 14:02 JST
  const NOW = Date.parse("2026-09-24T05:02:00Z");

  it("is offered beside the others, in order", () => {
    expect(LIVE_INTERVALS).toEqual(["1min", "5min", "15min", "1h", "4h", "1day"]);
    expect(isLiveInterval("5min")).toBe(true);
  });

  it("reads GMO's 5-minute bars for the chart and for the history", async () => {
    const asked: string[] = [];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      asked.push(u.searchParams.get("interval")!);
      return dayFile(u.searchParams.get("date")!, u.searchParams.get("priceType")!.toLowerCase() as "bid" | "ask");
    };
    const bars = (await fetchLiveQuotes("USD/JPY", "5min", NOW, Date.now() + 60_000, fetcher))!;
    expect(new Set(asked)).toEqual(new Set(["5min"]));
    expect(bars).toHaveLength(READ_BARS + 1);
    const times = bars.map((b) => Date.parse(b.datetime));
    expect(times.slice(1).every((t, i) => t - times[i] === M5)).toBe(true);
    // the newest is the one forming now (14:00 JST)
    expect(times.at(-1)).toBe(NOW - 2 * 60_000);
    const r = liveRead("USD/JPY", "5min", bars, NOW);
    expect(r.candles).toHaveLength(CHART_BARS + 1);
    expect(r.next_close).toBe(new Date(NOW + 3 * 60_000).toISOString());
    const history = (await fetchLiveQuotes("USD/JPY", "5min", NOW, Date.now() + 60_000, fetcher, HISTORY_BARS + 1))!;
    expect(history).toHaveLength(HISTORY_BARS + 1);
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

  const c = [
    { datetime: "2026-09-25 10:00:00", open: 150, high: 150.2, low: 149.9, close: 150.1 },
    { datetime: "2026-09-25 10:15:00", open: 150.1, high: 150.15, low: 150.05, close: 150.12 },
  ];
  const open = Date.parse("2026-09-25T10:15:00Z");

  it("moves the forming bar with each price: its close the newest, its high and low #147: the furthest the price has gone", () => {
    const live: LiveBars = { candles: c, formingOpen: open };
    const up = tickLive(live, 150.3, open + 60_000, M15);
    expect(up.candles[1]).toEqual({ ...c[1], close: 150.3, high: 150.3 });
    expect(up.candles[0]).toBe(c[0]);
    // the price turning back leaves the wick where it went
    const back = tickLive(up, 150.0, open + 120_000, M15);
    expect(back.candles[1]).toEqual({ ...c[1], close: 150.0, high: 150.3, low: 150.0 });
    const again = tickLive(back, 150.1, open + 180_000, M15);
    expect(again.candles[1]).toEqual({ ...c[1], close: 150.1, high: 150.3, low: 150.0 });
    expect(again.formingOpen).toBe(open);
    // a price from before the newest bar changes nothing
    expect(tickLive(live, 151, open - 1, M15)).toBe(live);
    expect(tickLive(live, Number.NaN, open + 1, M15)).toBe(live);
  });

  it("#147: once the forming bar's time is up, the next price starts the next bar there, on the bars' grid", () => {
    const live: LiveBars = { candles: c, formingOpen: open };
    const next = tickLive(live, 150.4, open + M15 + 2_000, M15);
    expect(next.candles).toHaveLength(3);
    // the bar it was in stays as the price left it
    expect(next.candles[1]).toBe(c[1]);
    expect(next.candles[2]).toEqual({ datetime: "2026-09-25 10:30:00", open: 150.4, high: 150.4, low: 150.4, close: 150.4 });
    expect(next.formingOpen).toBe(open + M15);
    const moved = tickLive(next, 150.5, open + M15 + 30_000, M15);
    expect(moved.candles[2]).toEqual({ datetime: "2026-09-25 10:30:00", open: 150.4, high: 150.5, low: 150.4, close: 150.5 });
    // bars with no price in them are not made: the next price's own bar
    const later = tickLive(live, 150.6, open + 3 * M15 + 5_000, M15);
    expect(later.candles[2].datetime).toBe("2026-09-25 11:00:00");
    // a 4-hour chart whose bars open at 21:00 UTC keeps that grid
    const h4 = [{ datetime: "2026-09-24 21:00:00", open: 150, high: 150.2, low: 149.9, close: 150.1 }];
    const H4 = 4 * 3_600_000;
    const four = tickLive({ candles: h4, formingOpen: Date.parse("2026-09-24T21:00:00Z") }, 150.2, Date.parse("2026-09-25T02:30:00Z"), H4);
    expect(four.candles[1].datetime).toBe("2026-09-25 01:00:00");
  });

  it("#147: with no bar forming in the read, a price inside the newest bar's time leaves it as read; a later one starts the next", () => {
    const live: LiveBars = { candles: c, formingOpen: null };
    expect(tickLive(live, 151, open + 60_000, M15)).toBe(live);
    const next = tickLive(live, 151, open + M15 + 1_000, M15);
    expect(next.candles).toHaveLength(3);
    expect(next.formingOpen).toBe(open + M15);
  });

  it("#149: leaves out of the indicators' judging everything after the read's last closed bar", () => {
    // a read with its bar forming, nothing made since: only the forming one
    expect(unjudgedOf(121, true, 121)).toBe(1);
    // the prices started the next bar: the read's forming one (now closed on screen) and the new one
    expect(unjudgedOf(121, true, 122)).toBe(2);
    // a read with nothing forming (the market shut): none
    expect(unjudgedOf(120, false, 120)).toBe(0);
    // a read that could not be refreshed, and two bars the prices made since
    expect(unjudgedOf(120, false, 122)).toBe(2);
  });

  it("#147: a new read replaces what the prices made, except bars newer than its own", () => {
    const made = tickLive({ candles: c, formingOpen: open }, 150.4, open + M15 + 2_000, M15);
    // a read with the new bar forming: it is the chart
    const fresh = [...c, { datetime: "2026-09-25 10:30:00", open: 150.41, high: 150.45, low: 150.39, close: 150.42 }];
    expect(withRead(fresh, open + M15, made)).toEqual({ candles: fresh, formingOpen: open + M15 });
    // a read that could not be refreshed (the same bars, nothing forming):
    // the bar the prices started stays
    const stale = withRead(c, null, made);
    expect(stale.candles).toHaveLength(3);
    expect(stale.candles[2]).toBe(made.candles[2]);
    expect(stale.formingOpen).toBe(open + M15);
    // no earlier state: the read alone
    expect(withRead(c, open, null)).toEqual({ candles: c, formingOpen: open });
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

  it("shows the five pairs (#127: and gold) with their prices, the chart and both rules, and switches pair and timeframe", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadTicks = vi.fn(async () => ({
      "USD/JPY": { bid: 150.12, ask: 150.123, mid: 150.1215, time: new Date().toISOString(), open: true },
      "EUR/JPY": { bid: 163.1, ask: 163.102, mid: 163.101, time: null, open: false },
    }));
    render(<LiveChart defaultInterval="4h" loadBars={loadBars} loadTicks={loadTicks} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(loadBars).toHaveBeenCalledWith("USD/JPY", "4h");
    // #153: GMO's pairs in the broker's (楽天FX) order, then gold; #154:
    // with more of the broker's among them, in its order. #175: the yen
    // pairs only, and gold; #177: and EUR/USD, in its place
    expect(screen.getAllByRole("tab").map((b) => b.getAttribute("data-testid") ?? "").filter((id) => id.startsWith("live-pair-"))).toEqual(
      [
        "USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "MXN/JPY", "NZD/JPY", "ZAR/JPY", "CAD/JPY", "CHF/JPY",
        "TRY/JPY", "HKD/JPY", "SGD/JPY", "NOK/JPY", "HUF/JPY", "SEK/JPY", "PLN/JPY", "CZK/JPY", "XAU/USD",
      ].map((p) => `live-pair-${p}`),
    );
    await waitFor(() => expect(screen.getByTestId("live-price").textContent).toContain("売値 150.120 / 買値 150.123 / スプレッド 0.3pips"));
    expect(screen.getByTestId("live-pair-USD/JPY").textContent).toBe("USD/JPY150.121");
    expect(screen.getByTestId("live-signals").textContent).toContain("RSI＋SAR");
    expect(screen.getByTestId("live-signals").textContent).toContain("GA型");
    expect(screen.getByTestId("live-next-close").textContent).toContain("次の足の確定");
    fireEvent.click(screen.getByTestId("live-pair-EUR/JPY"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/JPY", "4h"));
    await waitFor(() => expect(screen.getByTestId("live-closed").textContent).toContain("市場休止中"));
    fireEvent.click(screen.getByTestId("live-interval-1min"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/JPY", "1min"));
    // #146: and the 5-minute chart, between the 1- and 15-minute ones
    const tfs = screen.getAllByRole("tab").map((b) => b.getAttribute("data-testid") ?? "").filter((id) => id.startsWith("live-interval-"));
    expect(tfs).toEqual(["1min", "5min", "15min", "1h", "4h", "1day"].map((tf) => `live-interval-${tf}`));
    fireEvent.click(screen.getByTestId("live-interval-5min"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/JPY", "5min"));
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
    // #138: the base timeframe first (4h)
    expect(loadBars).toHaveBeenCalledWith("USD/JPY", "4h");
  });

  it("#114: opens on the GA-style view — its signals only, as filled BUY/SELL labels, no RSI/SAR — with the latest signal's plan", async () => {
    const base = readFor("USD/JPY", "1h");
    const gaMark = { ...base.marks[0], rule: "gainz", side: "SELL" as const, datetime: base.candles[base.candles.length - 3].datetime, barsAgo: 1, entry: 150.1, stop: 150.4, target: 149.5, outcome: "open" as const };
    const rsMark = { ...gaMark, rule: "rsi_sar", side: "BUY" as const, datetime: base.candles[base.candles.length - 10].datetime, barsAgo: 8, outcome: "win" as const };
    const r = { ...base, marks: [rsMark, gaMark], latest: { rsiSar: rsMark, gainz: gaMark } };
    render(<LiveChart loadBars={async () => r} loadTicks={async () => ({})} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(screen.getByTestId("live-view-gainz").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("live-recommended").textContent).toContain("基本の時間足は4時間足");
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

  it("#115: draws each signal's position as a box to where it settled, an × there, a line on its bar, and the SAR as a band", async () => {
    const base = readFor("USD/JPY", "1h");
    const n = base.candles.length;
    const at = (i: number) => base.candles[i].datetime;
    const e1 = base.candles[n - 60].close;
    const win = { ...base.marks[0], rule: "gainz", side: "BUY" as const, datetime: at(n - 60), barsAgo: 58, entry: e1, stop: e1 - 0.1, target: e1 + 0.2, outcome: "win" as const, bars: 5 };
    const e2 = base.candles[n - 4].close;
    const open = { ...win, side: "SELL" as const, datetime: at(n - 4), barsAgo: 2, entry: e2, stop: e2 + 0.1, target: e2 - 0.2, outcome: "open" as const, bars: null };
    const e3 = base.candles[n - 100].close;
    const expired = { ...win, rule: "rsi_sar", datetime: at(n - 100), barsAgo: 98, entry: e3, stop: e3 - 0.1, target: e3 + 0.2, outcome: "expired" as const, bars: null };
    const r = { ...base, marks: [expired, win, open], latest: { rsiSar: expired, gainz: open } };
    render(<LiveChart loadBars={async () => r} loadTicks={async () => ({})} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    const num = (el: Element | null | undefined, a: string) => Number(el?.getAttribute(a));

    // the won buy: green over the entry, red under it, running to the bar
    // that settled it, with the dashed line ending on the target at an ×
    const box = screen.getByTestId("chart-position-BUY-win");
    const [tp, sl] = [...box.querySelectorAll("rect")];
    expect(num(tp, "y")).toBeLessThan(num(sl, "y"));
    expect(num(tp, "y") + num(tp, "height")).toBeCloseTo(num(sl, "y"), 6);
    const exit = screen.getByTestId("chart-exit-win");
    const path = exit.querySelector("line");
    expect(num(path, "y2")).toBeCloseTo(num(tp, "y"), 6);
    expect(num(path, "x2")).toBeCloseTo(num(tp, "x") + num(tp, "width"), 6);
    expect(exit.textContent).toBe("TP");
    // settled 5 bars on: one bar's width
    const slot = num(tp, "width") / 5;
    // the open sell: the target under the entry, no × yet
    const [tp2, sl2] = [...screen.getByTestId("chart-position-SELL-open").querySelectorAll("rect")];
    expect(num(tp2, "y")).toBeGreaterThan(num(sl2, "y"));
    expect(screen.getByTestId("chart-exit-open").querySelector("path")).toBeNull();
    expect(screen.getAllByTestId("chart-signal-line")).toHaveLength(2);
    // the GA view: the SAR as a band only, said in the legend
    expect(screen.getByTestId("chart-cloud").querySelectorAll("polygon").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("chart-sar")).toBeNull();
    expect(screen.getByTestId("chart-position-legend").textContent).toContain("箱=サインの建玉");
    expect(screen.getByTestId("chart-position-legend").textContent).toContain("帯=パラボリックSAR");
    expect(screen.getByTestId("chart-signal-legend").textContent).toContain("GA型の判定には使っていません");

    // both rules: the dots come back beside the band, and the expired one
    // ends at the 48th bar
    fireEvent.click(screen.getByTestId("live-view-both"));
    expect(screen.getByTestId("chart-sar")).toBeTruthy();
    expect(screen.getByTestId("chart-cloud")).toBeTruthy();
    expect(screen.getAllByTestId("chart-signal-line")).toHaveLength(3);
    expect(screen.getByTestId("chart-exit-expired").textContent).toBe("期限");
    const [tp3] = [...screen.getByTestId("chart-position-BUY-expired").querySelectorAll("rect")];
    expect(num(tp3, "width")).toBeCloseTo(slot * 48, 4);
    expect(screen.getByTestId("chart-signal-legend").textContent).not.toContain("点線");
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

  it("#147: starts the next bar as soon as its time comes, without waiting for the next read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const M1 = 60_000;
    const formingAt = Math.floor(Date.now() / M1) * M1;
    const base = readFor("USD/JPY", "1min");
    const n = base.candles.length;
    const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const first: LiveRead = {
      ...base,
      candles: base.candles.map((k, i) => ({ ...k, datetime: at(formingAt - (n - 1 - i) * M1) })),
      nextClose: new Date(formingAt + M1).toISOString(),
    };
    let calls = 0;
    // the read after the close never answers
    const loadBars = vi.fn((): Promise<LiveRead> => (++calls === 1 ? Promise.resolve(first) : new Promise<LiveRead>(() => {})));
    const loadTicks = vi.fn(async () => ({
      "USD/JPY": { bid: 150.2, ask: 150.203, mid: 150.2015, time: new Date(Date.now()).toISOString(), open: true },
    }));
    const jst = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16);
    render(<LiveChart defaultInterval="1min" loadBars={loadBars} loadTicks={loadTicks} />);
    await waitFor(() => expect(screen.getByTestId("live-next-close").textContent).toContain(jst(formingAt + M1)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(formingAt + M1 - Date.now() + 6_000);
    });
    // the next read was asked for and has not answered: the chart is on the next bar anyway
    expect(loadBars.mock.calls.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(screen.getByTestId("live-next-close").textContent).toContain(jst(formingAt + 2 * M1)));
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
