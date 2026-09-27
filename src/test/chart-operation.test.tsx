import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { emaLine } from "../lib/emaLines";
import { formatCandleLabel } from "../lib/candleTime";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

// jsdom has no PointerEvent: a mouse event that carries the pointer's id and kind
beforeAll(() => {
  if (typeof window.PointerEvent === "undefined") {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
  }
});

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// every bar its own close, so each bar's prices can be told apart
const hourly = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const close = 150 + i * 0.01;
    return {
      datetime: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      open: close - 0.005,
      high: close + 0.2,
      low: close - 0.2,
      close,
    };
  });

// the drawing is 660 wide when nothing measures it (jsdom), 297 high: let
// the screen say so too
const sized = (el: Element) =>
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 660, height: 297, right: 660, bottom: 297, x: 0, y: 0, toJSON: () => ({}) }),
  });
const readout = () => (document.body.textContent ?? "").match(/始 [\d.]+ 高 [\d.]+ 安 [\d.]+ 終 [\d.]+/)?.[0] ?? null;
const candleCount = () => screen.getByTestId("chart-candles").children.length;
const axisPrices = () =>
  [...document.querySelectorAll("[data-testid='chart-price'] text")]
    .map((x) => x.textContent ?? "")
    .filter((x) => /^\d+\.\d{3}$/.test(x))
    .map(Number);
const axisSpan = () => Math.max(...axisPrices()) - Math.min(...axisPrices());
const timeLabels = () => [...document.querySelectorAll("[data-testid='chart-price'] text[data-time-label]")].map((x) => x.textContent);
const touch = (svg: Element, kind: "pointerDown" | "pointerMove" | "pointerUp", clientX: number, clientY = 100) =>
  fireEvent[kind](svg, { pointerId: 1, pointerType: "touch", clientX, clientY });

describe("#144 the chart worked as iSPEED FX's is", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.style.overflow = "";
  });

  it("a finger held still brings up the crosshair, which follows it and stays where it is let go; a tap hides it", () => {
    vi.useFakeTimers();
    render(<PriceChart candles={hourly(60)} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    touch(svg, "pointerDown", 400);
    expect(readout()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const first = readout();
    expect(first).not.toBeNull();
    // the finger moves: the crosshair follows, the bars stay
    touch(svg, "pointerMove", 200);
    const second = readout();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(candleCount()).toBe(60);
    touch(svg, "pointerUp", 200);
    expect(readout()).toBe(second);
    // a tap takes it away
    touch(svg, "pointerDown", 300);
    touch(svg, "pointerUp", 300);
    expect(readout()).toBeNull();
  });

  it("a finger that moves before then drags the bars instead", () => {
    vi.useFakeTimers();
    render(<PriceChart candles={hourly(60)} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    const before = timeLabels().at(-1);
    touch(svg, "pointerDown", 300);
    touch(svg, "pointerMove", 400);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    touch(svg, "pointerUp", 400);
    expect(readout()).toBeNull();
    expect(timeLabels().at(-1)).not.toBe(before);
  });

  it("one finger down the price scale squeezes the prices, up spreads them, and 自動 fits them again", () => {
    render(<PriceChart candles={hourly(60)} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    const fitted = axisSpan();
    expect(screen.queryByTestId("chart-price-auto")).toBeNull();
    // on the price scale (right of the plot)
    touch(svg, "pointerDown", 650, 100);
    touch(svg, "pointerMove", 650, 250);
    touch(svg, "pointerUp", 650, 250);
    expect(axisSpan()).toBeGreaterThan(fitted * 2);
    // the bars were not moved or zoomed, and no crosshair came up
    expect(candleCount()).toBe(60);
    expect(readout()).toBeNull();

    fireEvent.click(screen.getByTestId("chart-price-auto"));
    expect(axisSpan()).toBeCloseTo(fitted, 6);
    expect(screen.queryByTestId("chart-price-auto")).toBeNull();

    touch(svg, "pointerDown", 650, 250);
    touch(svg, "pointerMove", 650, 100);
    touch(svg, "pointerUp", 650, 100);
    expect(axisSpan()).toBeLessThan(fitted);
    // a double click fits it too
    fireEvent.doubleClick(svg);
    expect(axisSpan()).toBeCloseTo(fitted, 6);
  });

  it("one finger along the time scale zooms, the newest bar kept at the right", () => {
    const candles = hourly(60);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    // on the time scale (under the plot)
    touch(svg, "pointerDown", 300, 290);
    touch(svg, "pointerMove", 420, 290);
    touch(svg, "pointerUp", 420, 290);
    expect(candleCount()).toBeLessThan(30);
    expect(timeLabels().at(-1)).toBe(formatCandleLabel(candles[59].datetime, "ja-JP"));
    touch(svg, "pointerDown", 420, 290);
    touch(svg, "pointerMove", 100, 290);
    touch(svg, "pointerUp", 100, 290);
    expect(candleCount()).toBe(60);
  });

  it("the chart comes first, and what it all means is folded under it", () => {
    render(<PriceChart candles={hourly(120)} pair="USD/JPY" />);
    const notes = screen.getByTestId("chart-notes");
    expect(notes.tagName).toBe("DETAILS");
    expect(notes.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("chart-price").compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notes.contains(screen.getByTestId("chart-gesture-note"))).toBe(true);
    expect(screen.getByTestId("chart-gesture-note").textContent).toContain("長押しで十字カーソル");
    expect(notes.contains(screen.getByTestId("chart-ema-legend"))).toBe(true);
  });

  it("the settings list is grouped as iSPEED FX groups it, each indicator's note behind its ⓘ", () => {
    render(<PriceChart candles={hourly(120)} pair="USD/JPY" rsi={hourly(120).map(() => 50)} />);
    const trend = screen.getByTestId("chart-group-trend");
    const osc = screen.getByTestId("chart-group-oscillator");
    expect(trend.textContent).toContain("トレンド系（チャートに重ねる）");
    expect(trend.contains(screen.getByTestId("chart-overlay-name-ema50"))).toBe(true);
    expect(trend.contains(screen.getByTestId("chart-overlay-name-supertrend"))).toBe(true);
    expect(osc.textContent).toContain("オシレーター系（チャートの下）");
    for (const k of ["rsi", "stoch", "pctB", "rci"]) expect(osc.contains(screen.getByTestId(`chart-overlay-name-${k}`))).toBe(true);

    expect(screen.queryByTestId("chart-info-text-ema50")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-info-ema50"));
    expect(screen.getByTestId("chart-info-text-ema50").textContent).toContain("71.6%");
    fireEvent.click(screen.getByTestId("chart-info-supertrend"));
    expect(screen.queryByTestId("chart-info-text-ema50")).toBeNull();
    expect(screen.getByTestId("chart-info-text-supertrend").textContent).toContain("SuperTrend");
  });

  it("the top left says what is drawn over the price, with the EMA values at the crosshair's bar", () => {
    const candles = hourly(120);
    const e50 = emaLine(candles.map((c) => c.close), 50);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    const legend = screen.getByTestId("chart-overlay-legend");
    // it takes no touches: the chart's gestures go through it
    expect(legend.className).toContain("pointer-events-none");
    expect(screen.getByTestId("chart-legend-ema50").textContent).toBe(`EMA 50 ${(e50[119] as number).toFixed(3)}`);
    // 120 bars need more than EMA 200 has
    expect(screen.getByTestId("chart-legend-ema200").textContent).toBe("EMA 200 —");
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    touch(svg, "pointerDown", 300);
    touch(svg, "pointerUp", 300);
    expect(screen.getByTestId("chart-legend-ema50").textContent).not.toBe(`EMA 50 ${(e50[119] as number).toFixed(3)}`);
  });
});

describe("#144 a phone turned on its side", () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
    document.body.style.overflow = "";
  });
  const phone = (landscape: { on: boolean }) => {
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes("landscape") && landscape.on;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })) as unknown as typeof window.matchMedia;
    return () => act(() => listeners.forEach((f) => f()));
  };

  it("opens the chart in full screen, and upright again closes it", () => {
    const side = { on: true };
    const turn = phone(side);
    render(<PriceChart candles={hourly(60)} pair="USD/JPY" landscapeFullscreen />);
    expect(screen.getByTestId("chart-fullscreen-overlay")).toBeTruthy();
    side.on = false;
    turn();
    expect(screen.queryByTestId("chart-fullscreen-overlay")).toBeNull();
    side.on = true;
    turn();
    expect(screen.getByTestId("chart-fullscreen-overlay")).toBeTruthy();
  });

  it("only where the chart asks for it, and a full screen opened by hand stays when turned upright", () => {
    const side = { on: true };
    const turn = phone(side);
    const { unmount } = render(<PriceChart candles={hourly(60)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-fullscreen-overlay")).toBeNull();
    unmount();

    side.on = false;
    render(<PriceChart candles={hourly(60)} pair="USD/JPY" landscapeFullscreen />);
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    turn();
    expect(screen.getByTestId("chart-fullscreen-overlay")).toBeTruthy();
  });
});

const quotes = (n: number): QuoteCandle[] =>
  hourly(n).map((c) => {
    const iso = new Date(Date.parse(c.datetime.replace(" ", "T") + "Z")).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#144 the live chart's card", () => {
  it("puts the pairs in one row that scrolls sideways, and the note on the base timeframe folded under the chart", async () => {
    const now = Date.parse("2026-09-01T00:00:00Z") + 259 * 3_600_000 + 60_000;
    const readFor = (pair: string, interval: string): LiveRead => {
      const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), now))!;
      return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
    };
    render(<LiveChart loadBars={async (p, i) => readFor(p, i)} loadTicks={async () => ({})} loadHistory={async () => []} loadDow={async () => []} />);
    await screen.findByTestId("live-signals");
    const pairs = screen.getByTestId("live-pairs");
    expect(pairs.className).toContain("overflow-x-auto");
    expect(pairs.className).not.toContain("flex-wrap");
    const fold = screen.getByTestId("live-recommended-fold");
    expect(fold.tagName).toBe("DETAILS");
    expect(fold.contains(screen.getByTestId("live-recommended"))).toBe(true);
    expect(screen.getByTestId("chart-price").compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
