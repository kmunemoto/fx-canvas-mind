import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { stochastic } from "../lib/stochastic";
import { formatCandleLabel } from "../lib/candleTime";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const walk = (n: number, seed = 11) => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = o + (rnd() - 0.5) * 0.3;
    return {
      datetime: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      open: o,
      high: Math.max(o, p) + 0.01 + rnd() * 0.05,
      low: Math.min(o, p) - 0.01 - rnd() * 0.05,
      close: p,
    };
  });
};
const sized = (el: Element, w: number, h: number) =>
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }),
  });

describe("#118 the chart made easier to read and to use", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
    document.body.style.overflow = "";
  });

  it("chooses a white background, keeps the choice, and full screen follows it", () => {
    const c = walk(80);
    const { container, unmount } = render(<PriceChart candles={c} pair="USD/JPY" />);
    const card = () => container.querySelector("[data-theme]")!;
    expect(card().getAttribute("data-theme")).toBe("dark");
    expect(card().className).not.toContain("chart-light");
    fireEvent.click(screen.getByTestId("chart-theme-toggle"));
    expect(card().getAttribute("data-theme")).toBe("light");
    expect(card().className).toContain("chart-light");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).theme).toBe("light");
    unmount();
    resetChartPrefsCache();
    render(<PriceChart candles={c} pair="USD/JPY" />);
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    expect(overlay.className).toContain("chart-light");
    // and back to dark from the settings sheet
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    fireEvent.click(within(overlay).getByTestId("chart-sheet-theme-dark"));
    expect(screen.getByTestId("chart-fullscreen-overlay").className).not.toContain("chart-light");
    expect(within(overlay).getByTestId("chart-sheet-theme-dark").getAttribute("aria-pressed")).toBe("true");
  });

  it("marks the price now on the axis, in the newest bar's colour", () => {
    const c = walk(80);
    const up = { ...c[79], open: c[79].close - 0.05 };
    const { unmount } = render(<PriceChart candles={[...c.slice(0, 79), up]} pair="USD/JPY" />);
    const tag = screen.getByTestId("chart-price-now");
    expect(tag.textContent).toBe(up.close.toFixed(3));
    expect(tag.querySelector("rect")?.getAttribute("fill")).toBe("hsl(var(--success))");
    unmount();
    render(<PriceChart candles={[...c.slice(0, 79), { ...up, open: up.close + 0.05 }]} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-price-now").querySelector("rect")?.getAttribute("fill")).toBe("hsl(var(--destructive))");
  });

  it("shows the crosshair's price on the axis and its bar on the time axis", () => {
    const c = walk(80);
    render(<PriceChart candles={c} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    const h = Number(svg.getAttribute("viewBox")!.split(" ")[3]);
    sized(svg, 660, h);
    const priceAt = (clientY: number) => {
      fireEvent.mouseMove(svg, { clientX: 300, clientY });
      return Number(screen.getByTestId("chart-cross-price").textContent);
    };
    const high = priceAt(h * 0.25);
    const low = priceAt(h * 0.75);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThan(Math.max(...c.map((x) => x.high)) + 1);
    // the bar under x = 300: (300 − 8) / (606 / 80)
    const idx = Math.floor((300 - 8) / (606 / 80));
    expect(screen.getByTestId("chart-cross-time").textContent).toBe(formatCandleLabel(c[idx].datetime, "ja-JP"));
    fireEvent.mouseLeave(svg);
    expect(screen.queryByTestId("chart-cross-price")).toBeNull();
  });

  it("tags %K and %D on the stochastic's axis in their colours", () => {
    const c = walk(120);
    render(<PriceChart candles={c} pair="USD/JPY" />);
    const { k, d } = stochastic(c);
    const lastOf = (xs: Array<number | null>) => [...xs].reverse().find((v): v is number => v !== null)!;
    const kTag = screen.getByTestId("chart-stoch-tag-K");
    const dTag = screen.getByTestId("chart-stoch-tag-D");
    expect(kTag.textContent).toBe(lastOf(k).toFixed(2));
    expect(dTag.textContent).toBe(lastOf(d).toFixed(2));
    expect(kTag.querySelector("rect")?.getAttribute("fill")).toBe("#2962FF");
    expect(dTag.querySelector("rect")?.getAttribute("fill")).toBe("#FF6D00");
    // never on top of each other
    const ky = Number(kTag.querySelector("rect")!.getAttribute("y"));
    const dy = Number(dTag.querySelector("rect")!.getAttribute("y"));
    const tagH = Number(kTag.querySelector("rect")!.getAttribute("height"));
    expect(Math.abs(ky - dy)).toBeGreaterThanOrEqual(tagH - 1e-9);
  });

  it("gives the candles the width the plan's lane took when there is no plan, and labels more times", () => {
    const c = walk(80);
    const clipW = () => Number(document.querySelector("[data-testid='chart-price'] clipPath rect")!.getAttribute("width"));
    const { unmount } = render(<PriceChart candles={c} pair="USD/JPY" />);
    const bare = clipW();
    expect(document.querySelectorAll("[data-testid='chart-price'] text[data-time-label]").length).toBeGreaterThanOrEqual(5);
    unmount();
    render(<PriceChart candles={c} pair="USD/JPY" entry="150.1" stopLoss="149.8" takeProfits={["150.5"]} />);
    expect(bare - clipW()).toBe(84);
  });

  it("puts the pair's price and its move since the previous bar at the top of full screen, in larger print", () => {
    const c = walk(80);
    render(<PriceChart candles={c} pair="USD/JPY" heading="USD/JPY · 1時間足" />);
    const cardSize = Number(document.querySelector("[data-testid='chart-price'] text")!.getAttribute("font-size"));
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    const price = within(overlay).getByTestId("chart-fullscreen-price").textContent ?? "";
    const move = c[79].close - c[78].close;
    expect(price).toContain(c[79].close.toFixed(3));
    expect(price).toContain(`${move > 0 ? "+" : "−"}${Math.abs(move).toFixed(3)}`);
    expect(price).toContain("前の足比");
    const fullSize = Number(within(overlay).getByTestId("chart-price").querySelector("text")!.getAttribute("font-size"));
    expect(fullSize).toBeGreaterThan(cardSize);
    // the card's switches are in the settings sheet in full screen
    expect(within(overlay).queryByTestId("chart-indicators")).toBeNull();
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    fireEvent.click(within(overlay).getByTestId("chart-sheet-stoch"));
    expect(within(overlay).queryByTestId("chart-stoch")).toBeNull();
  });
});
