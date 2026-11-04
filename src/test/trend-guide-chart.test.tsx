// #394: the owner's ① ② ④ on the chart — on unless switched off, drawn from
// the closed candles on screen (src/lib/trendGuide.ts)
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, act, type RenderResult } from "@testing-library/react";
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
// the words drawn in a group (its <title> for the tooltip left out)
const drawn = (id: string) => [...screen.getByTestId(id).querySelectorAll("text")].map((t) => t.textContent).join("");

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
    expect(drawn("chart-trendguide-main-break")).toBe("①を上抜け");
    expect(drawn("chart-trendguide-steep-break")).toBe("②を上抜け");
    expect(screen.queryByTestId("chart-trendguide-counter")).toBeNull();
    expect(drawn("chart-trendguide-extreme")).toBe("④ 安値 0.98460（上昇の線は次の押し安値ができてから）");
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
    expect(drawn("chart-trendguide-extreme")).toBe("④ 安値 0.98460");
    expect(screen.queryByTestId("chart-trendguide-waiting")).toBeNull();
    expect(screen.queryByTestId("chart-trendguide-counter-break")).toBeNull();
  });

  it("marks a close under ④'s line as 「④の線を下抜け」", () => {
    render(<PriceChart candles={candlesOf([...DOWN, 0.995, 1.004, 0.99, 1.0])} pair="EUR/USD" />);
    expect(drawn("chart-trendguide-counter-break")).toBe("④の線を下抜け");
  });

  // the labels' room in the jsdom render (no fonts), as the chart estimates it: a
  // circled number 1.5em, a full-width glyph 1em, a space 0.32em, the rest 0.66em.
  // Measured with the real fonts in Chromium (Inter with IPA P Gothic, DejaVu Sans
  // with IPA Gothic) on 1,256 charts of 240 to 900 px, the drawn widths stayed
  // within it, but for a lone circled number at a small size (up to 0.5 px wider)
  const labelBoxes = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-testid="chart-trendguide"] text, [data-testid="chart-srzone-labels"] text')].map((t) => {
      const x = Number(t.getAttribute("x"));
      const y = Number(t.getAttribute("y"));
      const fs = Number(t.getAttribute("font-size"));
      const s = t.textContent ?? "";
      const w = [...s].reduce((a, ch) => {
        const c = ch.codePointAt(0)!;
        return a + (c >= 0x2460 && c <= 0x24ff ? 1.5 : (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ? 1 : c === 0x20 ? 0.32 : 0.66);
      }, 0) * fs;
      const end = t.getAttribute("text-anchor") === "end";
      const x0 = end ? x - w : x;
      return { s, x, end, x0, x1: x0 + w, y, y0: y - fs * 0.78, y1: y + fs * 0.2 };
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
  // 1-minute USD/JPY bars where ULTRA has a trade open (its price tags at the right)
  const ultraCandles = (seed: number) => {
    let s = seed;
    let c = 1500000;
    const rnd = () => (s = (s * 16807) % 2147483647);
    const t0 = 200 * 60_000 * 149213;
    return Array.from({ length: 400 }, (_, i) => {
      const o = c;
      c = o + (rnd() % 401) - 200 + (Math.floor(i / 30) % 2 === 0 ? 30 : -30);
      const hi = Math.max(o, c) + (rnd() % 200);
      const lo = Math.min(o, c) - (rnd() % 200);
      return { datetime: new Date(t0 + i * 60_000).toISOString().replace("T", " ").slice(0, 19), open: o / 10000, high: hi / 10000, low: lo / 10000, close: c / 10000 };
    });
  };
  const ultraChart = (seed: number) => {
    const c = ultraCandles(seed);
    return <PriceChart candles={c.slice(280)} pair="USD/JPY" zoneShiftHistory={{ bars: c.slice(0, 280), status: "ready" }} formingLast />;
  };
  // every label in the bars' part of the plot, off the price tags, the rings and one
  // another; ④'s price and note one block; no break's text, ④ or number left out
  const checkLabels = (root: ParentNode) => {
    const svg = root.querySelector('svg[data-testid="chart-price"]')!;
    const clip = svg.querySelector("defs > clipPath > rect")!;
    const cx0 = Number(clip.getAttribute("x"));
    const cy0 = Number(clip.getAttribute("y"));
    const cx1 = cx0 + Number(clip.getAttribute("width"));
    const cy1 = cy0 + Number(clip.getAttribute("height"));
    // the guide's lines end at the bars' right edge, before the price tags' column
    // (with no line drawn, the plot's; the tags are checked on their own below)
    const ends = [...svg.querySelectorAll('[data-testid="chart-trendguide"] line')].map((l) => Number(l.getAttribute("x2")));
    const barsRight = ends.length > 0 ? Math.max(...ends) : cx1;
    const boxes = labelBoxes(svg as unknown as HTMLElement);
    const bad: string[] = [];
    for (const b of boxes) {
      if (b.x0 < cx0 || b.x1 > cx1 || b.y0 < cy0 || b.y1 > cy1) bad.push(`「${b.s}」 out of the plot`);
      if (b.x1 > barsRight) bad.push(`「${b.s}」 past the bars' right edge`);
    }
    const tags = [...svg.querySelectorAll('[data-testid^="chart-ultra-tag-"] rect, [data-testid^="chart-qtrend-tag-"] rect')].map((r) => {
      const x = Number(r.getAttribute("x"));
      const y = Number(r.getAttribute("y"));
      return { x0: x, x1: x + Number(r.getAttribute("width")), y0: y, y1: y + Number(r.getAttribute("height")) };
    });
    const rings = [...svg.querySelectorAll('[data-testid="chart-trendguide"] circle')].map((c) => {
      const [x, y, r] = ["cx", "cy", "r"].map((a) => Number(c.getAttribute(a)));
      return { x0: x - r, x1: x + r, y0: y - r, y1: y + r };
    });
    for (const b of boxes) {
      for (const t of tags) if (b.x0 < t.x1 && t.x0 < b.x1 && b.y0 < t.y1 && t.y0 < b.y1) bad.push(`「${b.s}」 on a price tag`);
      for (const r of rings) if (b.x0 < r.x1 && r.x0 < b.x1 && b.y0 < r.y1 && r.y0 < b.y1) bad.push(`「${b.s}」 on a ring`);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) bad.push(`「${a.s}」 on 「${b.s}」`);
      }
    for (const g of svg.querySelectorAll('[data-testid$="-break"][data-testid^="chart-trendguide-"]'))
      if (!g.querySelector("text")) bad.push(`${g.getAttribute("data-testid")} without its words`);
    const ex = [...svg.querySelectorAll('[data-testid="chart-trendguide-extreme"] text')];
    if (svg.querySelector('[data-testid="chart-trendguide-extreme"]') && ex.length === 0) bad.push("④ without its words");
    if (ex.length === 2) {
      const [h, n] = ex.map((t) => ({ x: t.getAttribute("x"), a: t.getAttribute("text-anchor"), y: Number(t.getAttribute("y")) }));
      if (h.x !== n.x || h.a !== n.a || n.y <= h.y) bad.push("④'s two lines apart");
    }
    for (const id of ["main", "steep", "counter"])
      if (svg.querySelector(`[data-testid="chart-trendguide-${id}"]`) && !svg.querySelector(`[data-testid="chart-trendguide-${id}-num"]`)) bad.push(`${id} without its number`);
    return { bad, count: boxes.length };
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
        const r = checkLabels(container);
        expect(r.count).toBeGreaterThanOrEqual(3);
        expect(r.bad).toEqual([]);
      });

  describe("on a phone's width, in full screen, with ULTRA's price tags and in a moved view", () => {
    // the chart's width as a ResizeObserver reports it (jsdom has none)
    const size = { w: 660, h: 0 };
    beforeEach(() => {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        constructor(private cb: (e: Array<{ contentRect: { width: number; height: number } }>) => void) {}
        observe() {
          this.cb([{ contentRect: { width: size.w, height: size.h } }]);
        }
        unobserve() {}
        disconnect() {}
      };
    });
    afterEach(() => {
      delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    });
    const cards: Array<[string, number, () => ReactElement]> = [
      ["DOWN", 300, () => <PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />],
      ["DOWN", 360, () => <PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />],
      ["walk 6", 360, () => <PriceChart candles={walk(80, 6 * 7919)} pair="EUR/USD" />],
      ["walk 18", 390, () => <PriceChart candles={walk(80, 18 * 7919)} pair="EUR/USD" />],
      ["ULTRA open 777", 300, () => ultraChart(777)],
      ["ULTRA open 781", 360, () => ultraChart(781)],
      ["ULTRA open 784", 390, () => ultraChart(784)],
    ];
    for (const [name, w, el] of cards)
      for (const loc of ["ja", "en"] as const)
        it(`a ${w} px card (${name}, ${loc})`, () => {
          size.w = w;
          size.h = 0;
          const { container } = render(el(), loc);
          expect(screen.getByTestId("chart-price").getAttribute("viewBox")!.split(" ")[2]).toBe(String(w));
          expect(checkLabels(container).bad).toEqual([]);
        });
    for (const [name, el] of [["DOWN", () => <PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />], ["ULTRA open 777", () => ultraChart(777)]] as Array<[string, () => ReactElement]>)
      for (const loc of ["ja", "en"] as const)
        it(`full screen on a 360 × 640 phone (${name}, ${loc})`, () => {
          size.w = 360;
          size.h = 640;
          render(el(), loc);
          fireEvent.click(screen.getByTestId("chart-fullscreen"));
          const overlay = screen.getByTestId("chart-fullscreen-overlay");
          expect(checkLabels(overlay).bad).toEqual([]);
        });
    for (const loc of ["ja", "en"] as const)
      it(`a view zoomed in and dragged back, ULTRA's trade still open (${loc})`, () => {
        size.w = 390;
        size.h = 0;
        const { container } = render(ultraChart(784), loc);
        fireEvent.click(screen.getByTestId("chart-zoom-in"));
        fireEvent.click(screen.getByTestId("chart-zoom-in"));
        const svg = screen.getByTestId("chart-price");
        const [, , W, H] = svg.getAttribute("viewBox")!.split(" ").map(Number);
        svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON() {} }) as DOMRect;
        // jsdom has no PointerEvent: a MouseEvent with the pointer's fields
        const ev = (type: string, x: number) => {
          const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: H / 2, button: 0 });
          Object.defineProperty(e, "pointerId", { value: 1 });
          Object.defineProperty(e, "pointerType", { value: "mouse" });
          return e;
        };
        act(() => {
          svg.dispatchEvent(ev("pointerdown", W / 2));
        });
        act(() => {
          svg.dispatchEvent(ev("pointermove", W / 2 + 180));
        });
        act(() => {
          svg.dispatchEvent(ev("pointerup", W / 2 + 180));
        });
        // the newest bar off the screen, ULTRA's tags still drawn
        expect(container.querySelectorAll('[data-testid^="chart-ultra-tag-"]').length).toBeGreaterThan(0);
        expect(checkLabels(container).bad).toEqual([]);
      });
  });

  it("mirrors an up move", () => {
    render(<PriceChart candles={candlesOf(DOWN.map((v) => 2 - v))} pair="EUR/USD" />);
    expect(drawn("chart-trendguide-main-break")).toBe("①を下抜け");
    expect(drawn("chart-trendguide-extreme")).toBe("④ 高値 1.01540（下降の線は次の戻り高値ができてから）");
  });

  it("speaks English", () => {
    render(<PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />, "en");
    expect(screen.getByTestId("chart-overlay-name-trendGuide").textContent).toBe("Trend lines ① ② and ④ (automatic)");
    expect(drawn("chart-trendguide-main-break")).toBe("① broken up");
    expect(drawn("chart-trendguide-extreme")).toBe("④ low 0.98460(rising line once the next higher low forms)");
    expect(screen.getByTestId("chart-trendguide-waiting").textContent).toBe("(rising line once the next higher low forms)");
  });
});
