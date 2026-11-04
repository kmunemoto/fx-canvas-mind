// #394: the owner's ① ② ④ on the chart — on unless switched off, drawn from
// the closed candles on screen (src/lib/trendGuide.ts)
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

// 1-hour candles: closes in straight steps between the turning points (5 bars a
// leg), each bar ±0.0004 around its close
const candlesOf = (points: number[], legBars = 5) => {
  const closes: number[] = [];
  for (let k = 0; k + 1 < points.length; k++) for (let j = 0; j < legBars; j++) closes.push(points[k] + ((points[k + 1] - points[k]) * j) / legBars);
  closes.push(points[points.length - 1]);
  const t0 = Date.UTC(2026, 8, 1);
  return closes.map((c, i) => ({
    datetime: new Date(t0 + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
    open: c, high: c + 0.0004, low: c - 0.0004, close: c,
  }));
};
const DOWN = [1.0, 1.02, 1.01, 1.016, 1.006, 1.012, 1.002, 1.009, 0.997, 1.005, 0.994, 1.0005, 0.985, 1.008];

describe("#394 the owner's ① ② ④ on the chart", () => {
  it("is on until switched off, and listed on the chart", () => {
    expect(getChartPrefs().overlays.trendGuide).toBe(true);
    render(<PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-overlay-name-trendGuide").textContent).toBe("トレンドライン①②と④（自動）");
    expect(screen.getByTestId("chart-trendguide")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-toggle-trendGuide"));
    expect(getChartPrefs().overlays.trendGuide).toBe(false);
    expect(screen.queryByTestId("chart-trendguide")).toBeNull();
  });

  it("draws ①, ②, their breaks and ④ waiting for the next higher low", () => {
    render(<PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-trendguide-main-num").textContent).toBe("①");
    expect(screen.getByTestId("chart-trendguide-steep-num").textContent).toBe("②");
    expect(screen.getByTestId("chart-trendguide-main-break").textContent).toBe("①を上抜け");
    expect(screen.getByTestId("chart-trendguide-steep-break").textContent).toBe("②を上抜け");
    expect(screen.queryByTestId("chart-trendguide-counter")).toBeNull();
    expect(screen.getByTestId("chart-trendguide-extreme").textContent).toBe("④ 安値 0.98460（上昇の線は次の押し安値ができてから）");
    // the note on its own line, under the price (the label is over the low)
    const head = screen.getByTestId("chart-trendguide-extreme").querySelector("text")!;
    const wait = screen.getByTestId("chart-trendguide-waiting");
    expect(wait.textContent).toBe("（上昇の線は次の押し安値ができてから）");
    expect(Number(wait.getAttribute("y"))).toBeGreaterThan(Number(head.getAttribute("y")));
    // ① reaches the plot's right edge
    const line = screen.getByTestId("chart-trendguide-main").querySelector("line")!;
    const svg = screen.getByTestId("chart-price");
    const width = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    expect(Number(line.getAttribute("x2"))).toBeGreaterThan(width * 0.8);
    expect(screen.getByTestId("chart-trendguide-legend").textContent).toContain("過去の検証はまだしていません");
  });

  it("draws ④'s rising line once a higher low is confirmed (not broken yet), without the waiting note", () => {
    render(<PriceChart candles={candlesOf([...DOWN, 0.995, 1.004])} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-trendguide-counter-num").textContent).toBe("④");
    expect(screen.getByTestId("chart-trendguide-extreme").textContent).toBe("④ 安値 0.98460");
    expect(screen.queryByTestId("chart-trendguide-waiting")).toBeNull();
    expect(screen.queryByTestId("chart-trendguide-counter-break")).toBeNull();
  });

  it("marks a close under ④'s line as 「④の線を下抜け」", () => {
    render(<PriceChart candles={candlesOf([...DOWN, 0.995, 1.004, 0.99, 1.0])} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-trendguide-counter-break").textContent).toBe("④の線を下抜け");
  });

  // the labels' room in the jsdom render (no fonts): a circled number about 1.4em
  // (Inter's), a full-width glyph 1em, the rest 0.62em; measured with the real
  // fonts (Inter with IPA Gothic, DejaVu Sans) in Chromium the drawn widths stayed
  // within these, on 836 charts of 360 to 660 px
  const labelBoxes = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="chart-trendguide"] text, [data-testid="chart-srzone-labels"] text')].map((t) => {
      const x = Number(t.getAttribute("x"));
      const y = Number(t.getAttribute("y"));
      const fs = Number(t.getAttribute("font-size"));
      const s = t.textContent ?? "";
      const w = [...s].reduce((a, ch) => {
        const c = ch.codePointAt(0)!;
        return a + (c >= 0x2460 && c <= 0x24ff ? 1.4 : (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ? 1 : 0.62);
      }, 0) * fs;
      const x0 = t.getAttribute("text-anchor") === "end" ? x - w : x;
      return { s, x0, x1: x0 + w, y0: y - fs * 0.78, y1: y + fs * 0.2 };
    });
  const walk = (n: number, seed: number) => {
    let s = seed;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    let c = 1.1;
    const t0 = Date.UTC(2026, 8, 1);
    return Array.from({ length: n }, (_, i) => {
      const o = c;
      c = o + (rnd() - 0.5) * 0.004 + Math.sin(i / 17) * 0.0006;
      return { datetime: new Date(t0 + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "), open: o, high: Math.max(o, c) + rnd() * 0.0012, low: Math.min(o, c) - rnd() * 0.0012, close: c };
    });
  };
  const CASES: Array<[string, ReturnType<typeof candlesOf>]> = [
    ["DOWN", candlesOf(DOWN)],
    ["DOWN and ④'s line broken", candlesOf([...DOWN, 0.995, 1.004, 0.99, 1.0])],
    ["the mirrored up move", candlesOf(DOWN.map((v) => 2 - v))],
    // random walks where the labels once ran out of the plot or onto one another
    ...[19, 38, 59, 14, 306].map((seed): [string, ReturnType<typeof candlesOf>] => [`walk ${seed}`, walk(60 + (seed % 5) * 20, seed * 7919)]),
  ];
  for (const [name, candles] of CASES)
    for (const loc of ["ja", "en"] as const)
      it(`keeps every label in the bars' part of the plot, off the rings and off one another (${name}, ${loc})`, () => {
        const { container } = render(<PriceChart candles={candles} pair="EUR/USD" />, loc);
        const clip = container.querySelector('svg[data-testid="chart-price"] defs > clipPath > rect')!;
        const cx0 = Number(clip.getAttribute("x"));
        const cy0 = Number(clip.getAttribute("y"));
        const cx1 = cx0 + Number(clip.getAttribute("width"));
        const cy1 = cy0 + Number(clip.getAttribute("height"));
        // the guide's lines end at the bars' right edge, before the price tags' column
        const ends = [...container.querySelectorAll('[data-testid="chart-trendguide"] line')].map((l) => Number(l.getAttribute("x2")));
        const barsRight = Math.max(...ends);
        const boxes = labelBoxes(container);
        expect(boxes.length).toBeGreaterThanOrEqual(3);
        const bad: string[] = [];
        for (const b of boxes) {
          if (b.x0 < cx0 || b.x1 > cx1 || b.y0 < cy0 || b.y1 > cy1) bad.push(`「${b.s}」 out of the plot`);
          if (b.x1 > barsRight + 6) bad.push(`「${b.s}」 over the price tags`);
        }
        const rings = [...container.querySelectorAll('[data-testid="chart-trendguide"] circle')].map((c) => ({ x: Number(c.getAttribute("cx")), y: Number(c.getAttribute("cy")), r: Number(c.getAttribute("r")) }));
        for (const b of boxes) for (const r of rings) if (b.x0 < r.x + r.r && r.x - r.r < b.x1 && b.y0 < r.y + r.r && r.y - r.r < b.y1) bad.push(`「${b.s}」 on a ring`);
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const [a, b] = [boxes[i], boxes[j]];
            if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) bad.push(`「${a.s}」 on 「${b.s}」`);
          }
        expect(bad).toEqual([]);
      });

  it("mirrors an up move", () => {
    render(<PriceChart candles={candlesOf(DOWN.map((v) => 2 - v))} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-trendguide-main-break").textContent).toBe("①を下抜け");
    expect(screen.getByTestId("chart-trendguide-extreme").textContent).toBe("④ 高値 1.01540（下降の線は次の戻り高値ができてから）");
  });

  it("speaks English", () => {
    render(<PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />, "en");
    expect(screen.getByTestId("chart-overlay-name-trendGuide").textContent).toBe("Trend lines ① ② and ④ (automatic)");
    expect(screen.getByTestId("chart-trendguide-main-break").textContent).toBe("① broken up");
    expect(screen.getByTestId("chart-trendguide-extreme").textContent).toBe("④ low 0.98460(rising line once the next higher low forms)");
    expect(screen.getByTestId("chart-trendguide-waiting").textContent).toBe("(rising line once the next higher low forms)");
  });
});
