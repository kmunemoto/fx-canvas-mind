// #395 (docs §8.138): the sharp rise's and fall's words clear their triangles in full
// screen too, where the strips leave the price plot short (the room above the highest
// bar and below the lowest is kept in pixels, not only as a share of the prices)
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { resetChartPrefsCache } from "../lib/chartPrefs";

let size = { w: 800, h: 360 };
class FakeResizeObserver {
  cb: (e: Array<{ contentRect: { width: number; height: number } }>) => void;
  constructor(cb: FakeResizeObserver["cb"]) {
    this.cb = cb;
  }
  observe() {
    this.cb([{ contentRect: { width: size.w, height: size.h } }]);
  }
  unobserve() {}
  disconnect() {}
}
const realRO = globalThis.ResizeObserver;

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetChartPrefsCache();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
});

// 200 one-hour bars of 0.125 around 150: a 4 R rise on bar 195 (the highest on screen)
// and a fall on bar 190 (the lowest)
const candles = () => {
  const t0 = Date.UTC(2026, 9, 1);
  return Array.from({ length: 200 }, (_, i) => ({
    datetime: new Date(t0 + i * 3600_000).toISOString().slice(0, 19).replace("T", " "),
    open: 150,
    high: i === 195 ? 150.5 : 150.0625,
    low: i === 190 ? 149.5 : 149.9375,
    close: i === 195 ? 150.4 : i === 190 ? 149.6 : 150,
  }));
};
const triY = (g: Element) => g.querySelector("polygon")!.getAttribute("points")!.trim().split(/\s+/).map((p) => Number(p.split(",")[1]));
const words = (g: Element) => {
  const t = g.querySelector("text")!;
  const y = Number(t.getAttribute("y"));
  const f = Number(t.getAttribute("font-size"));
  return { top: y - 0.8 * f, bottom: y + 0.25 * f };
};

describe("#395 the marks' words in full screen", () => {
  for (const [w, h] of [[800, 300], [420, 300], [844, 300], [800, 260], [800, 360]] as Array<[number, number]>) {
    it(`clear their triangles at ${w} × ${h}`, () => {
      size = { w, h };
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
      render(
        <LocaleProvider initial="ja">
          <PriceChart candles={candles()} pair="USD/JPY" />
        </LocaleProvider>,
      );
      fireEvent.click(screen.getByTestId("chart-fullscreen"));
      const up = screen.getByTestId("chart-spike-up");
      const down = screen.getByTestId("chart-spike-down");
      expect(words(up).bottom).toBeLessThanOrEqual(Math.min(...triY(up)) + 1e-9);
      expect(words(down).top).toBeGreaterThanOrEqual(Math.max(...triY(down)) - 1e-9);
    });
  }
});
