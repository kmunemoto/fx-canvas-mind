import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { formatCandleLabel } from "../lib/candleTime";
import { MIN_VISIBLE_BARS, panView, visibleRange, zoomView } from "../lib/chartView";
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

describe("#116 which bars are on screen (lib/chartView)", () => {
  it("shows every bar until zoomed, and never fewer than the minimum or more than there are", () => {
    expect(visibleRange(120, null)).toEqual({ from: 0, to: 120 });
    expect(visibleRange(120, { count: 40, offset: 0 })).toEqual({ from: 80, to: 120 });
    expect(visibleRange(120, { count: 40, offset: 10 })).toEqual({ from: 70, to: 110 });
    expect(visibleRange(120, { count: 3, offset: 0 })).toEqual({ from: 120 - MIN_VISIBLE_BARS, to: 120 });
    expect(visibleRange(120, { count: 40, offset: 500 })).toEqual({ from: 0, to: 40 });
    expect(visibleRange(10, { count: 40, offset: 0 })).toEqual({ from: 0, to: 10 });
    expect(visibleRange(0, null)).toEqual({ from: 0, to: 0 });
  });

  it("zooms about a point, keeping the bar under it in place, and back out to every bar", () => {
    // about the right edge: the newest bar stays the last one drawn
    expect(zoomView(120, null, 1.5, 1)).toEqual({ count: 80, offset: 0 });
    // about the middle of bars 40..119: bar 80 stays in the middle
    const v = zoomView(120, { count: 80, offset: 0 }, 2, 0.5)!;
    expect(v.count).toBe(40);
    const r = visibleRange(120, v);
    expect(r.from + (r.to - r.from) / 2).toBe(80);
    // out past every bar is every bar
    expect(zoomView(120, { count: 80, offset: 0 }, 1 / 1.5, 1)).toBeNull();
    expect(zoomView(120, null, 1 / 1.5, 1)).toBeNull();
    // no nearer than the minimum
    expect(zoomView(120, { count: 16, offset: 0 }, 4, 1)).toEqual({ count: MIN_VISIBLE_BARS, offset: 0 });
  });

  it("drags within the bars there are", () => {
    expect(panView(120, { count: 40, offset: 0 }, 10)).toEqual({ count: 40, offset: 10 });
    expect(panView(120, { count: 40, offset: 10 }, -30)).toEqual({ count: 40, offset: 0 });
    expect(panView(120, { count: 40, offset: 0 }, 1000)).toEqual({ count: 40, offset: 80 });
    // every bar on screen: nowhere to go
    expect(panView(120, null, 10)).toBeNull();
  });
});

const hourly = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    datetime: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
    open: 150,
    // bar 5 is the window's only spike
    high: i === 5 ? 155 : 150.4,
    low: 149.6,
    close: 150.1,
  }));

const candleCount = () => screen.getByTestId("chart-candles").children.length;
const axisPrices = () =>
  [...document.querySelectorAll("[data-testid='chart-price'] text")]
    .map((x) => x.textContent ?? "")
    .filter((x) => /^\d+\.\d{3}$/.test(x))
    .map(Number);
const timeLabels = () =>
  [...document.querySelectorAll("[data-testid='chart-price'] text[data-time-label]")].map((x) => x.textContent);
const lastTime = () => timeLabels().at(-1);
// the drawing is 660 wide when nothing measures it (jsdom): let the screen say so too
const sized = (el: Element) =>
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: 660, height: 300, right: 660, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }),
  });

describe("#116 zoom, pan and full screen on the chart", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("zooms in and out with the buttons, and the price scale fits the bars on screen", () => {
    const candles = hourly(60);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    expect(candleCount()).toBe(60);
    expect(Math.max(...axisPrices())).toBeGreaterThan(155);
    expect(screen.getByTestId("chart-zoom-out")).toBeDisabled();
    expect(screen.queryByTestId("chart-zoom-reset")).toBeNull();

    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    expect(candleCount()).toBe(40);
    expect(screen.getByTestId("chart-zoom-count").textContent).toBe("40/60本");
    // the spike on bar 5 is off screen: the scale is the bars that are
    expect(Math.max(...axisPrices())).toBeLessThan(151);
    // the newest bar is still the last one
    expect(lastTime()).toBe(formatCandleLabel(candles[59].datetime, "ja-JP"));

    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    expect(candleCount()).toBe(MIN_VISIBLE_BARS);
    expect(screen.getByTestId("chart-zoom-in")).toBeDisabled();

    fireEvent.click(screen.getByTestId("chart-zoom-reset"));
    expect(candleCount()).toBe(60);
    expect(screen.queryByTestId("chart-zoom-count")).toBeNull();
  });

  it("drags back in time once zoomed, and a double click shows every bar again", () => {
    const candles = hourly(60);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    // every bar on screen: a drag moves nothing
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: "mouse", clientX: 500 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: "mouse", clientX: 500 });
    expect(candleCount()).toBe(60);

    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    // 40 bars across a plot 606 wide (660, less the left pad and a 46-wide
    // price axis — no plan levels, so no pill lane): 100 units is 6.6 bars
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: "mouse", clientX: 400 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: "mouse", clientX: 400 });
    expect(candleCount()).toBe(40);
    expect(lastTime()).toBe(formatCandleLabel(candles[52].datetime, "ja-JP"));

    fireEvent.doubleClick(svg);
    expect(candleCount()).toBe(60);
  });

  it("pinches with two fingers, and the wheel zooms only with Ctrl on the page", () => {
    render(<PriceChart candles={hourly(60)} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    fireEvent.wheel(svg, { deltaY: -100, clientX: 400 });
    expect(candleCount()).toBe(60);
    fireEvent.wheel(svg, { deltaY: -100, clientX: 400, ctrlKey: true });
    expect(candleCount()).toBe(50);

    fireEvent.click(screen.getByTestId("chart-zoom-reset"));
    // two fingers 100 apart spread to 200: half the bars
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: "touch", clientX: 250 });
    fireEvent.pointerDown(svg, { pointerId: 2, pointerType: "touch", clientX: 350 });
    fireEvent.pointerMove(svg, { pointerId: 2, pointerType: "touch", clientX: 450 });
    fireEvent.pointerUp(svg, { pointerId: 2, pointerType: "touch", clientX: 450 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: "touch", clientX: 250 });
    expect(candleCount()).toBe(30);
  });

  it("taps a bar for its prices on a touch screen", () => {
    const candles = hourly(60);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: "touch", clientX: 400 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: "touch", clientX: 400 });
    expect(document.body.textContent).toContain("O 150.000 H 150.400 L 149.600 C 150.100");
  });

  it("opens full screen over the page and closes it with the button or Esc", async () => {
    render(<PriceChart candles={hourly(60)} pair="USD/JPY" heading="USD/JPY · 1時間足" />);
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    expect(overlay.getAttribute("role")).toBe("dialog");
    // drawn into <body>, not inside the card
    expect(overlay.parentElement).toBe(document.body);
    expect(screen.getByTestId("chart-fullscreen-placeholder").textContent).toContain("全画面で表示しています");
    expect(document.body.style.overflow).toBe("hidden");
    // #118: the settings sheet holds the gesture hint, and Esc closes the
    // sheet before full screen
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    expect(within(overlay).getByTestId("chart-zoom-hint").textContent).toContain("ピンチ");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("chart-sheet")).toBeNull());
    expect(screen.getByTestId("chart-fullscreen-overlay")).toBeTruthy();
    // in full screen a plain wheel zooms
    const svg = within(overlay).getByTestId("chart-price");
    sized(svg);
    fireEvent.wheel(svg, { deltaY: -100, clientX: 400 });
    expect(candleCount()).toBe(50);

    fireEvent.click(within(overlay).getByTestId("chart-fullscreen-close"));
    expect(screen.queryByTestId("chart-fullscreen-overlay")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    // the zoom is kept
    expect(candleCount()).toBe(50);

    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    expect(screen.getByTestId("chart-fullscreen-overlay")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("chart-fullscreen-overlay")).toBeNull());
  });

  it("goes back to the newest bars on another series, at the same zoom, and has no controls when turned off", () => {
    const candles = hourly(60);
    const { rerender } = render(<PriceChart candles={candles} pair="USD/JPY" seriesKey="a" />);
    const svg = screen.getByTestId("chart-price");
    sized(svg);
    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: "mouse", clientX: 400 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: "mouse", clientX: 400 });
    expect(lastTime()).toBe(formatCandleLabel(candles[52].datetime, "ja-JP"));
    rerender(<LocaleProvider initial="ja"><PriceChart candles={candles} pair="USD/JPY" seriesKey="b" /></LocaleProvider>);
    expect(candleCount()).toBe(40);
    expect(lastTime()).toBe(formatCandleLabel(candles[59].datetime, "ja-JP"));

    rerender(<LocaleProvider initial="ja"><PriceChart candles={candles} pair="USD/JPY" interactive={false} /></LocaleProvider>);
    // no zoom and no full screen; the background can still be chosen
    expect(screen.queryByTestId("chart-zoom-in")).toBeNull();
    expect(screen.queryByTestId("chart-fullscreen")).toBeNull();
    expect(screen.getByTestId("chart-theme-toggle")).toBeTruthy();
    expect(candleCount()).toBe(60);
  });
});

describe("#116 the live chart in full screen", () => {
  const quotes = (n: number): QuoteCandle[] => {
    const T0 = Date.parse("2026-09-21T00:00:00Z");
    const out: QuoteCandle[] = [];
    let p = 150;
    for (let i = 0; i < n; i++) {
      const o = p;
      p = o + Math.sin(i / 5) * 0.08;
      const mid = { open: o, high: Math.max(o, p) + 0.03, low: Math.min(o, p) - 0.03, close: p };
      const side = (d: number) => ({ datetime: new Date(T0 + i * 3_600_000).toISOString(), open: mid.open + d, high: mid.high + d, low: mid.low + d, close: mid.close + d });
      out.push({ datetime: new Date(T0 + i * 3_600_000).toISOString(), bid: side(-0.002), ask: side(0.002) });
    }
    return out;
  };
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), Date.parse("2026-09-21T00:00:00Z") + 259 * 3_600_000 + 60_000))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };

  it("#118: switches the pair, timeframe and signals from sheets at the bottom, without leaving full screen", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadTicks = vi.fn(async () => ({
      "USD/JPY": { bid: 150.12, ask: 150.123, mid: 150.1215, time: new Date().toISOString(), open: true },
      "EUR/USD": { bid: 1.1, ask: 1.10002, mid: 1.10001, time: new Date().toISOString(), open: true },
    }));
    render(<LiveChart loadBars={loadBars} loadTicks={loadTicks} />);
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = () => screen.getByTestId("chart-fullscreen-overlay");
    // the pair's price and move at the top, the bid/ask under it
    await waitFor(() => expect(within(overlay()).getByTestId("chart-fullscreen-status").textContent).toContain("150.120"));
    expect(within(overlay()).getByTestId("chart-fullscreen-price").textContent).toContain("前の足比");
    expect(within(overlay()).getByTestId("chart-sheet-symbol-open").textContent).toBe("USDJPY");
    expect(within(overlay()).getByTestId("chart-sheet-interval-open").textContent).toBe("1時間");

    fireEvent.click(within(overlay()).getByTestId("chart-sheet-symbol-open"));
    const row = within(overlay()).getByTestId("live-sheet-pair-EUR/USD");
    expect(row.textContent).toContain("ユーロ／米ドル");
    expect(row.textContent).toContain("1.10001");
    expect(within(overlay()).getByTestId("live-sheet-pair-USD/JPY").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(row);
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/USD", "1h"));
    expect(screen.queryByTestId("chart-sheet")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(overlay()).getByTestId("chart-sheet-symbol-open").textContent).toBe("EURUSD");

    fireEvent.click(within(overlay()).getByTestId("chart-sheet-interval-open"));
    fireEvent.click(within(overlay()).getByTestId("live-sheet-interval-4h"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/USD", "4h"));
    fireEvent.click(within(overlay()).getByTestId("chart-sheet-interval-open"));
    fireEvent.click(within(overlay()).getByTestId("live-sheet-view-both"));
    expect(screen.getByTestId("live-view-both").getAttribute("aria-selected")).toBe("true");
    // the backdrop closes a sheet too
    fireEvent.click(within(overlay()).getByTestId("chart-sheet-symbol-open"));
    fireEvent.click(within(overlay()).getByTestId("chart-sheet-backdrop"));
    expect(screen.queryByTestId("chart-sheet")).toBeNull();
    expect(screen.getByTestId("chart-fullscreen-overlay")).toBeTruthy();
  });
});
