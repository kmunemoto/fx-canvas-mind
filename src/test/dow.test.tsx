import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { dowTfsFor as clientTfsFor, normalizeDow, normalizeLiveRead, type DowTf, type LiveRead } from "../lib/liveChart";
import { DOW_PIVOT, dowTheory } from "../../supabase/functions/_shared/dow";
import { DOW_TFS, closedOf, dowOf, dowTfsFor, liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// #129: a market drawn leg by leg, `per` candles a leg, each candle closing
// on the leg and reaching 0.2 past its open and close — an uptrend (a
// higher high over 115), the first close under its 押し安値 (107.8), a
// lower high (112.2) and a close under the low before it (confirmed down),
// new lows, then the mirror back up
const LEGS = [110, 105, 115, 108, 120, 104, 112, 95, 101, 92, 103, 97, 108];
const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-21T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const legBars = (legs: number[], per = 4) => {
  const pts: number[] = [legs[0]];
  for (let k = 1; k < legs.length; k++) for (let j = 1; j <= per; j++) pts.push(legs[k - 1] + ((legs[k] - legs[k - 1]) * j) / per);
  return pts.map((c, i) => {
    const o = i > 0 ? pts[i - 1] : c;
    return { datetime: stamp(i), open: o, close: c, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2 };
  });
};
const ev = (r: ReturnType<typeof dowTheory>) => r.events.map((e) => `${e.kind}:${e.dir}@${e.i}/${e.level.toFixed(1)}`);

describe("#129 Dow theory, read mechanically", () => {
  it("follows the legs: an update, the first break, the confirmed turn, and the mirror", () => {
    const r = dowTheory(legBars(LEGS), 2);
    expect(r.swings.map((s) => `${s.kind}${s.i}:${s.label}`)).toEqual([
      "L4:null", "H8:null", "L12:HL", "H16:HH", "L20:LL", "H24:LH", "L28:LL", "H32:LH", "L36:LL", "H40:HH", "L44:HL",
    ]);
    expect(ev(r)).toEqual([
      "update:up@15/115.2",
      "break1:down@20/107.8",
      "confirm:down@26/103.8",
      "update:down@35/94.8",
      "break1:up@40/101.2",
      "confirm:up@47/103.2",
    ]);
    // between the first break and the second, the turn is only a sign
    expect(r.states[19]).toBe("up");
    expect(r.states.slice(20, 26).every((s) => s === "toDown")).toBe(true);
    expect(r.states[26]).toBe("down");
    expect(r.states.slice(40, 47).every((s) => s === "toUp")).toBe(true);
    expect(r.state).toBe("up");
    expect(r.since).toBe(47);
    // the new 押し安値: the higher low before the confirming close
    expect(r.key).toEqual({ kind: "pushLow", price: 96.8, i: 44 });
  });

  it("calls the turn off when a close gets back over the old high first", () => {
    const r = dowTheory(legBars([110, 105, 115, 108, 120, 104, 112, 106, 126, 118, 130]), 2);
    expect(ev(r)).toEqual(["update:up@15/115.2", "break1:down@20/107.8", "cancel:up@31/120.2", "update:up@39/126.2"]);
    expect(r.state).toBe("up");
    expect(r.key).toEqual({ kind: "pushLow", price: 117.8, i: 36 });
  });

  it("never repaints: a bar's state is the same read on the bars up to it as on all of them", () => {
    const bars = legBars(LEGS);
    const all = dowTheory(bars, 2).states;
    for (let k = 1; k <= bars.length; k++) expect(dowTheory(bars.slice(0, k), 2).states).toEqual(all.slice(0, k));
    expect(DOW_PIVOT).toBe(5);
  });
});

describe("#129 the live-chart function's Dow reading", () => {
  it("reads 4h, 1h, 15min and 5min, gold without the 5-minute one", () => {
    expect(DOW_TFS).toEqual(["4h", "1h", "15min", "5min"]);
    expect(dowTfsFor("USD/JPY")).toEqual(["4h", "1h", "15min", "5min"]);
    expect(dowTfsFor("XAU/USD")).toEqual(["4h", "1h", "15min"]);
    expect(clientTfsFor("XAU/USD")).toEqual(["4h", "1h", "15min"]);
    expect(clientTfsFor("EUR/USD")).toEqual(["4h", "1h", "15min", "5min"]);
  });

  it("names every point by its bar's datetime, rounds the prices as the chart's, and leaves the forming bar out", () => {
    // eight candles a leg, for its five-candle swings; the turn back up
    // signalled but not yet confirmed
    const bars = legBars(LEGS, 8).slice(0, 93);
    // the last bar opened a minute ago
    const closed = closedOf(bars, "15min", T0 + 92 * M15 + 60_000);
    expect(closed).toHaveLength(92);
    const d = dowOf("USD/JPY", "15min", closed);
    expect(d.tf).toBe("15min");
    expect(d.as_of).toBe(stamp(91));
    expect(d.state).toBe("toUp");
    expect(d.since).toBe(stamp(79));
    expect(d.key).toEqual({ kind: "pullHigh", price: 101.2, at: stamp(64) });
    expect(d.high).toEqual({ price: 103.2, at: stamp(80) });
    // the low at 88 is known five candles later, not yet
    expect(d.low).toEqual({ price: 91.8, at: stamp(72) });
    expect(d.events.at(-1)).toEqual({ kind: "break1", dir: "up", level: 101.2, at: stamp(79) });
    expect(d.swings.every((s) => Number(s.price.toFixed(3)) === s.price)).toBe(true);
  });

  it("is read by the app as it is sent, and a timeframe that could not be read is left out", () => {
    const d = dowOf("USD/JPY", "15min", legBars(LEGS, 8));
    const got = normalizeDow([d, { tf: "5min", error: "unavailable" }, { tf: "1h", state: "sideways" }]);
    expect(got).toHaveLength(1);
    expect(got[0].state).toBe("up");
    expect(got[0].key).toEqual({ kind: "pushLow", price: 96.8, at: stamp(88) });
    expect(got[0].events.map((e) => e.kind)).toEqual(["update", "break1", "confirm", "update", "break1", "confirm"]);
    expect(got[0].asOf).toBe(stamp(96));
    expect(normalizeDow(null)).toEqual([]);
  });
});

describe("#129 Dow theory on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const bars = legBars(LEGS, 8);
  const current = normalizeDow([dowOf("USD/JPY", "15min", bars)])[0];
  const higher: DowTf = {
    tf: "1h",
    state: "down",
    since: stamp(20),
    key: { kind: "pullHigh", price: 110, at: stamp(24) },
    high: { price: 118, at: stamp(16) },
    low: { price: 95, at: stamp(28) },
    swings: [],
    events: [],
    asOf: stamp(44),
  };

  it("labels the swings, draws the key level and marks both breaks, and the higher timeframe's levels", () => {
    render(<PriceChart candles={bars} pair="USD/JPY" dow={{ current, higher: [higher], status: "ready" }} />);
    expect(screen.getAllByTestId("chart-dow-swing-HH")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-dow-swing-HL")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-dow-swing-LH")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-dow-swing-LL")).toHaveLength(3);
    expect(screen.getByTestId("chart-dow-zigzag")).toBeTruthy();
    expect(screen.getByTestId("chart-dow-key-label-pushLow").textContent).toBe("押し安値 96.800");
    expect(screen.getByTestId("chart-dow-break1-down").textContent).toContain("①");
    expect(screen.getByTestId("chart-dow-confirm-down").textContent).toContain("確定");
    expect(screen.getByTestId("chart-dow-break1-up")).toBeTruthy();
    expect(screen.getByTestId("chart-dow-confirm-up").textContent).toContain("2回目: 上昇への転換が確定");
    expect(screen.getByTestId("chart-dow-higher-label-1h-pullHigh").textContent).toBe("1H 戻り高値 110.000");
    expect(screen.getByTestId("chart-dow-higher-label-1h-high").textContent).toBe("1H 高値 118.000");
    expect(screen.getByTestId("chart-dow-higher-label-1h-low").textContent).toBe("1H 安値 95.000");
    expect(screen.getByTestId("chart-dow-key-pushLow")).toBeTruthy();
    expect(screen.getByTestId("chart-dow-higher-1h-pullHigh").getAttribute("stroke-dasharray")).toBe("6 3");
    expect(screen.getByTestId("chart-dow-higher-1h-high").getAttribute("stroke-dasharray")).toBe("2 3");
    const legend = screen.getByTestId("chart-dow-legend").textContent!;
    expect(legend).toContain("オーナーが選んだ");
    expect(legend).toContain("上位足（1H）");
    expect(legend).toContain("過去のチャートでの成績はまだ測っていません");
  });

  it("is listed with a switch, and off draws nothing", () => {
    render(<PriceChart candles={bars} pair="USD/JPY" dow={{ current, higher: [higher], status: "ready" }} />);
    expect(screen.getByTestId("chart-overlay-name-dow").textContent).toBe("ダウ理論");
    fireEvent.click(screen.getByTestId("chart-toggle-dow"));
    expect(screen.getByTestId("chart-toggle-dow").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-dow")).toBeNull();
    expect(screen.queryByTestId("chart-dow-legend")).toBeNull();
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.dow).toBe(false);
  });

  it("is not listed on a chart it is not given to, and says when the chart's own timeframe is not read", () => {
    const { unmount } = render(<PriceChart candles={bars} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-overlay-name-dow")).toBeNull();
    unmount();
    render(<PriceChart candles={bars} pair="USD/JPY" dow={{ current: null, higher: [higher], status: "ready" }} />);
    expect(screen.queryByTestId("chart-dow-key-pushLow")).toBeNull();
    expect(screen.getByTestId("chart-dow-higher-1h-pullHigh")).toBeTruthy();
    expect(screen.getByTestId("chart-dow-legend").textContent).toContain("この時間足は判定の対象外");
  });
});

// ---- the live chart: read while it is on ------------------------------------------

const quotes = (n: number): QuoteCandle[] =>
  Array.from({ length: n }, (_, i) => {
    const iso = new Date(T0 + i * M15).toISOString();
    const mid = 150 + Math.sin(i / 9) * 0.4;
    const side = (d: number) => ({ datetime: iso, open: mid + d, high: mid + 0.05 + d, low: mid - 0.05 + d, close: mid + 0.01 + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#129 Dow theory on the live chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const NOW = T0 + 259 * M15 + 60_000;
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };
  const tf = (name: string, state: DowTf["state"], key: DowTf["key"], since: string | null = null): DowTf => ({
    tf: name, state, since, key, high: null, low: null, swings: [], events: [], asOf: null,
  });
  const dowFor = (read: LiveRead): DowTf[] => {
    const at = (i: number) => read.candles[i].datetime;
    return [
      tf("4h", "up", { kind: "pushLow", price: 149.2, at: null }, "2026-09-18 08:00:00"),
      tf("1h", "toDown", { kind: "pushLow", price: 149.7, at: null }),
      { ...tf("15min", "down", { kind: "pullHigh", price: 150.3, at: at(100) }), swings: [{ kind: "H", label: "LH", price: 150.3, at: at(100) }] },
      tf("5min", "none", null),
    ];
  };

  it("says where each timeframe stands, draws the chart's own and the higher ones, and asks again for the next pair", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const read = readFor("USD/JPY", "15min");
    const loadDow = vi.fn(async () => dowFor(read));
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDow={loadDow} />);
    await waitFor(() => expect(screen.getByTestId("live-dow-state-4h")).toBeTruthy());
    expect(loadDow).toHaveBeenCalledWith("USD/JPY");
    expect(screen.getByTestId("live-dow-4h").textContent).toContain("上昇（高値更新中）");
    expect(screen.getByTestId("live-dow-4h").textContent).toContain("押し安値 149.200");
    // the 4h bar that opened 08:00 UTC closed at 21:00 JST
    expect(screen.getByTestId("live-dow-4h").textContent).toContain("09-18 21:00〜");
    expect(screen.getByTestId("live-dow-1h").textContent).toContain("上昇→下降の兆し");
    expect(screen.getByTestId("live-dow-1h").textContent).toContain("割った押し安値 149.700");
    expect(screen.getByTestId("live-dow-15min").textContent).toContain("下降（安値更新中）");
    expect(screen.getByTestId("live-dow-5min").textContent).toContain("判定なし");
    // on the 15-minute chart: its own key level, and the 1h and 4h ones above it
    expect(screen.getByTestId("chart-dow-key-label-pullHigh").textContent).toBe("戻り高値 150.300");
    expect(screen.getByTestId("chart-dow-swing-LH")).toBeTruthy();
    expect(screen.getByTestId("chart-dow-legend").textContent).toContain("上位足（4H・1H）");

    fireEvent.click(screen.getByTestId("live-pair-EUR/USD"));
    await waitFor(() => expect(loadDow).toHaveBeenCalledWith("EUR/USD"));
  });

  it("is not read while it is off", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { dow: false } }));
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadDow = vi.fn(async () => [] as DowTf[]);
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDow={loadDow} />);
    await waitFor(() => expect(screen.getByTestId("chart-candles")).toBeTruthy());
    expect(loadDow).not.toHaveBeenCalled();
    expect(screen.queryByTestId("live-dow")).toBeNull();
    expect(screen.getByTestId("chart-toggle-dow").getAttribute("aria-pressed")).toBe("false");
  });

  it("says so when it cannot be read", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadDow = vi.fn(async (): Promise<DowTf[]> => {
      throw new Error("feed_unavailable");
    });
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDow={loadDow} />);
    await waitFor(() => expect(screen.getByTestId("live-dow-status").textContent).toContain("読めませんでした"));
  });
});
