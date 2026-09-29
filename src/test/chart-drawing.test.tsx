import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render as rtlRender, renderHook, screen, fireEvent, act, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { DRAWINGS_KEY, resetDrawingsCache, setPairDrawings } from "../lib/drawingsStore";
import { CHART_DRAWINGS_TABLE, useChartDrawingsSync } from "../lib/drawingsSync";
import { CHART_PREFS_KEY, getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";
import type { Drawing } from "../lib/drawings";

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

const H1 = 3_600_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
// every bar its own close, 0.01 apart, 0.4 high to low
const bars = (n: number, step = H1) =>
  Array.from({ length: n }, (_, i) => {
    const close = 150 + i * 0.01;
    return {
      datetime: new Date(T0 + i * step).toISOString().slice(0, 19).replace("T", " "),
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
const tap = (svg: Element, x: number, y: number, kind: "touch" | "mouse" = "touch") => {
  fireEvent.pointerDown(svg, { pointerId: 1, pointerType: kind, clientX: x, clientY: y, button: 0 });
  fireEvent.pointerUp(svg, { pointerId: 1, pointerType: kind, clientX: x, clientY: y, button: 0 });
};
const drag = (svg: Element, from: [number, number], to: [number, number], kind: "touch" | "mouse" = "touch") => {
  fireEvent.pointerDown(svg, { pointerId: 1, pointerType: kind, clientX: from[0], clientY: from[1], button: 0 });
  fireEvent.pointerMove(svg, { pointerId: 1, pointerType: kind, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2 });
  fireEvent.pointerMove(svg, { pointerId: 1, pointerType: kind, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(svg, { pointerId: 1, pointerType: kind, clientX: to[0], clientY: to[1], button: 0 });
};
const kept = (pair = "USD/JPY"): Drawing[] => JSON.parse(localStorage.getItem(DRAWINGS_KEY) ?? "{}")[pair] ?? [];
const drawnEls = () => [...document.querySelectorAll("[data-testid^='chart-drawing-d']")];

const setup = (props: Partial<Parameters<typeof PriceChart>[0]> = {}) => {
  const r = render(<PriceChart candles={bars(60)} pair="USD/JPY" drawable {...props} />);
  const svg = screen.getByTestId("chart-price");
  sized(svg);
  return { ...r, svg };
};
const openTools = () => fireEvent.click(screen.getByTestId("chart-draw-open"));
// a tool from the list under the picker (open when the bar opens with no tool)
const pick = (tool: string) => {
  if (!screen.queryByTestId(`chart-draw-tool-${tool}`)) fireEvent.click(screen.getByTestId("chart-draw-picker"));
  fireEvent.click(screen.getByTestId(`chart-draw-tool-${tool}`));
};

beforeEach(() => {
  localStorage.clear();
  resetDrawingsCache();
  resetChartPrefsCache();
});

describe("#160 drawing on the chart", () => {
  it("has the drawing tools only where the chart allows them", () => {
    render(<PriceChart candles={bars(60)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-draw-open")).toBeNull();
  });

  it("opens the tools, says how to start, and lists the lines, the Fibonacci four and the marks", () => {
    setup();
    openTools();
    expect(screen.getByTestId("chart-draw-bar")).toBeTruthy();
    expect(screen.getByTestId("chart-draw-hint").textContent).toContain("「ツール」から線の種類を選び");
    for (const k of ["trend", "hline", "vline", "ray", "hray", "extended", "channel", "fib", "fibTime", "fibFan", "fibArc", "rect", "text", "arrowUp", "arrowDown", "measure", "long", "short"]) {
      expect(screen.getByTestId(`chart-draw-tool-${k}`)).toBeTruthy();
    }
    // a tool picked, the list closes and the picker names it
    pick("fib");
    expect(screen.queryByTestId("chart-draw-tools")).toBeNull();
    expect(screen.getByTestId("chart-draw-picker").textContent).toBe("リトレース");
  });

  it("draws a trend line with two taps, keeps it, selects it and leaves the tool", () => {
    const { svg } = setup();
    openTools();
    pick("trend");
    expect(screen.getByTestId("chart-draw-hint").textContent).toContain("1点目");
    tap(svg, 200, 100);
    expect(screen.getByTestId("chart-draw-hint").textContent).toContain("あと1点");
    // the line follows to where the second tap will be
    expect(screen.getByTestId("chart-drawing-draft")).toBeTruthy();
    tap(svg, 400, 180);
    const list = kept();
    expect(list).toHaveLength(1);
    expect(list[0].tool).toBe("trend");
    // on the bars tapped (bar 19 and bar 38 of 60, 10.1 wide from 8)
    expect(list[0].points.map((p) => p.t)).toEqual([T0 + 19 * H1, T0 + 38 * H1]);
    // the first point is the higher price (higher on the screen)
    expect(list[0].points[0].p).toBeGreaterThan(list[0].points[1].p);
    expect(drawnEls()).toHaveLength(1);
    expect(screen.getByTestId("chart-draw-selected")).toBeTruthy();
    // the tool let go: the picker names none
    expect(screen.getByTestId("chart-draw-picker").textContent).toBe("ツール");
  });

  it("draws with one drag too: the first point where it began, the second where it was let go", () => {
    const { svg } = setup();
    openTools();
    pick("trend");
    drag(svg, [150, 200], [500, 60]);
    const [d] = kept();
    // bars 14 and 48 (x 150 and 500)
    expect(d.points.map((p) => p.t)).toEqual([T0 + 14 * H1, T0 + 48 * H1]);
    expect(d.points[1].p).toBeGreaterThan(d.points[0].p);
  });

  it("takes a finger's small wobble in a tap as a tap, not a drag that ends the line", () => {
    const { svg } = setup();
    openTools();
    pick("trend");
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: "touch", clientX: 206, clientY: 104 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: "touch", clientX: 206, clientY: 104 });
    expect(kept()).toHaveLength(0);
    expect(screen.getByTestId("chart-draw-hint").textContent).toContain("あと1点");
    tap(svg, 400, 180);
    expect(kept()).toHaveLength(1);
  });

  it("says so when a pair has as many drawings as it takes, and draws no more", () => {
    const many = Array.from({ length: 200 }, (_, i): Drawing => ({ id: `m${i}`, tool: "hline", points: [{ t: T0, p: 140 + i * 0.001 }], color: "#2962FF", width: 1, style: "solid" }));
    setPairDrawings("USD/JPY", many);
    const { svg } = setup();
    openTools();
    pick("hline");
    expect(screen.getByTestId("chart-draw-hint").textContent).toContain("200本まで");
    tap(svg, 300, 100);
    expect(kept()).toHaveLength(200);
  });

  it("puts a horizontal line down with one tap, with its price on the axis", () => {
    const { svg } = setup();
    openTools();
    pick("hline");
    tap(svg, 300, 140);
    const [d] = kept();
    expect(d.tool).toBe("hline");
    const tags = screen.getAllByTestId("chart-draw-axis-tag");
    expect(tags.some((g) => g.textContent === d.points[0].p.toFixed(3))).toBe(true);
  });

  it("draws with the mouse: a click, the line follows the mouse, a click", () => {
    const { svg } = setup();
    openTools();
    pick("trend");
    tap(svg, 200, 100, "mouse");
    fireEvent.mouseMove(svg, { clientX: 350, clientY: 150 });
    // on bar 33, where the mouse is
    const draft = screen.getByTestId("chart-drawing-draft").querySelector("line:last-of-type")!;
    expect(Number(draft.getAttribute("x2"))).toBeCloseTo(8 + 10.1 * 33 + 5.05, 1);
    tap(svg, 350, 150, "mouse");
    expect(kept()[0].points[1].t).toBe(T0 + 33 * H1);
  });

  it("two quick clicks while drawing are two points, not a double click back to every bar", () => {
    const { svg } = setup();
    fireEvent.click(screen.getByTestId("chart-zoom-in"));
    const shown = screen.getByTestId("chart-zoom-count").textContent;
    openTools();
    pick("trend");
    tap(svg, 200, 100, "mouse");
    tap(svg, 260, 120, "mouse");
    fireEvent.doubleClick(svg);
    expect(screen.getByTestId("chart-zoom-count").textContent).toBe(shown);
    expect(kept()).toHaveLength(1);
  });

  it("selects a drawing with a tap and lets it go with a tap on nothing", () => {
    setPairDrawings("USD/JPY", [{ id: "h1", tool: "hline", points: [{ t: T0 + 30 * H1, p: 150.3 }], color: "#2962FF", width: 2, style: "solid" }]);
    const { svg } = setup();
    const line = screen.getByTestId("chart-drawing-h1").querySelector("line")!;
    const py = Number(line.getAttribute("y1"));
    tap(svg, 300, py + 3);
    expect(screen.getByTestId("chart-draw-selected-name").textContent).toBe("水平線");
    expect(screen.getByTestId("chart-drawing-h1").getAttribute("data-selected")).toBe("true");
    tap(svg, 300, py + 60);
    expect(screen.queryByTestId("chart-draw-selected")).toBeNull();
  });

  it("moves a selected drawing by dragging it, and one point by dragging its handle; a locked one stays", () => {
    setPairDrawings("USD/JPY", [{ id: "t1", tool: "trend", points: [{ t: T0 + 10 * H1, p: 150.2 }, { t: T0 + 40 * H1, p: 150.5 }], color: "#2962FF", width: 2, style: "solid" }]);
    const { svg } = setup();
    const seg = () => screen.getByTestId("chart-drawing-t1").querySelector("line:last-of-type")!;
    const mid = () => [(Number(seg().getAttribute("x1")) + Number(seg().getAttribute("x2"))) / 2, (Number(seg().getAttribute("y1")) + Number(seg().getAttribute("y2"))) / 2];
    const [mx, my] = mid();
    tap(svg, mx, my);
    // the whole line, 5 bars on
    drag(svg, [mx, my], [mx + 5 * 10.1, my]);
    let d = kept()[0];
    expect(d.points.map((p) => p.t)).toEqual([T0 + 15 * H1, T0 + 45 * H1]);
    expect(d.points[0].p).toBeCloseTo(150.2, 6);
    // its second point, by its handle
    const h = screen.getByTestId("chart-drawing-handle-1");
    drag(svg, [Number(h.getAttribute("cx")), Number(h.getAttribute("cy"))], [Number(h.getAttribute("cx")) + 3 * 10.1, Number(h.getAttribute("cy"))]);
    d = kept()[0];
    expect(d.points.map((p) => p.t)).toEqual([T0 + 15 * H1, T0 + 48 * H1]);
    // locked: dragging it moves the bars, not the line
    fireEvent.click(screen.getByTestId("chart-draw-lock"));
    const [lx, ly] = mid();
    drag(svg, [lx, ly], [lx + 50, ly]);
    expect(kept()[0].points).toEqual(d.points);
    expect(kept()[0].locked).toBe(true);
  });

  it("changes a drawing's colour, width and line, and a new one starts with them", () => {
    const { svg } = setup();
    openTools();
    pick("trend");
    tap(svg, 200, 100);
    tap(svg, 400, 180);
    fireEvent.click(screen.getByTestId("chart-draw-color"));
    fireEvent.click(screen.getByTestId("chart-draw-color-F23645"));
    fireEvent.click(screen.getByTestId("chart-draw-width"));
    fireEvent.click(screen.getByTestId("chart-draw-style"));
    const d = kept()[0];
    expect([d.color, d.width, d.style]).toEqual(["#F23645", 3, "dashed"]);
    expect(getChartPrefs().drawing).toMatchObject({ color: "#F23645", width: 3, style: "dashed" });
    pick("vline");
    tap(svg, 300, 100);
    expect(kept()[1]).toMatchObject({ tool: "vline", color: "#F23645", width: 3, style: "dashed" });
  });

  it("deletes the selected drawing (its button, or the Delete key), undoes and redoes", () => {
    const { svg } = setup();
    openTools();
    pick("hline");
    tap(svg, 300, 100);
    pick("hline");
    tap(svg, 300, 200);
    expect(kept()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("chart-draw-delete"));
    expect(kept()).toHaveLength(1);
    fireEvent.click(screen.getByTestId("chart-draw-undo"));
    expect(kept()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("chart-draw-redo"));
    expect(kept()).toHaveLength(1);
    // the one left, selected with a tap, and the Delete key
    const py = Number(document.querySelector("[data-testid^='chart-drawing-d'] line")!.getAttribute("y1"));
    tap(svg, 300, py);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(kept()).toHaveLength(0);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(kept()).toHaveLength(1);
  });

  it("hides every drawing and shows them again, and removes them all after asking", () => {
    const { svg } = setup();
    openTools();
    pick("hline");
    tap(svg, 300, 100);
    pick("vline");
    tap(svg, 300, 100);
    expect(drawnEls()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("chart-draw-hide"));
    expect(drawnEls()).toHaveLength(0);
    expect(getChartPrefs().drawing.hidden).toBe(true);
    fireEvent.click(screen.getByTestId("chart-draw-hide"));
    expect(drawnEls()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("chart-draw-clear"));
    expect(kept()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("chart-draw-clear-yes"));
    expect(kept()).toHaveLength(0);
  });

  it("Esc lets go of a drawing being put down, then of the tool", () => {
    const { svg } = setup();
    openTools();
    pick("trend");
    tap(svg, 200, 100);
    expect(screen.getByTestId("chart-drawing-draft")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("chart-drawing-draft")).toBeNull();
    expect(screen.getByTestId("chart-draw-picker").textContent).toBe("トレンド");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("chart-draw-picker").textContent).toBe("ツール");
    expect(kept()).toHaveLength(0);
  });

  it("keeps the tool on after a drawing with 続けて描く", () => {
    const { svg } = setup();
    openTools();
    fireEvent.click(screen.getByTestId("chart-draw-keep"));
    pick("hline");
    tap(svg, 300, 100);
    tap(svg, 300, 150);
    expect(kept()).toHaveLength(2);
    expect(screen.getByTestId("chart-draw-picker").textContent).toBe("水平線");
  });

  it("the magnet puts a point on the bar's open, high, low or close", () => {
    const { svg } = setup();
    openTools();
    fireEvent.click(screen.getByTestId("chart-draw-magnet"));
    fireEvent.click(screen.getByTestId("chart-draw-magnet"));
    expect(screen.getByTestId("chart-draw-magnet").getAttribute("data-mode")).toBe("strong");
    pick("hline");
    tap(svg, 300, 90);
    const [d] = kept();
    // x 300 is bar 28
    const bar = bars(60)[28];
    expect([bar.open, bar.high, bar.low, bar.close].some((v) => Math.abs(v - d.points[0].p) < 1e-9)).toBe(true);
  });

  it("writes a text: its field opens as it is put down", () => {
    const { svg } = setup();
    openTools();
    pick("text");
    tap(svg, 300, 100);
    const input = screen.getByTestId("chart-draw-text-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "押し目" } });
    expect(kept()[0].text).toBe("押し目");
    expect(screen.getByTestId(`chart-drawing-${kept()[0].id}`).textContent).toContain("押し目");
  });

  it("puts a long position down with one tap: its target and stop as far each way, and the ratio", () => {
    const { svg } = setup();
    openTools();
    pick("long");
    tap(svg, 300, 150);
    const [d] = kept();
    expect(d.points).toHaveLength(3);
    expect(d.points[1].p - d.points[0].p).toBeCloseTo(d.points[0].p - d.points[2].p, 9);
    expect(d.points[1].p).toBeGreaterThan(d.points[0].p);
    const text = screen.getByTestId(`chart-drawing-${d.id}`).textContent ?? "";
    expect(text).toContain("リスクリワード 1:1.00");
    expect(text).toContain("利確");
    expect(text).toContain("pips");
  });

  it("measures a price move and the bars between two points", () => {
    const { svg } = setup();
    openTools();
    pick("measure");
    tap(svg, 200, 200);
    tap(svg, 402, 100);
    const [d] = kept();
    const text = screen.getByTestId(`chart-drawing-${d.id}`).textContent ?? "";
    expect(text).toContain("+");
    expect(text).toContain("pips");
    expect(text).toContain("20本");
  });

  it("keeps the drawings per pair, and shows a pair's on another timeframe on the same times", () => {
    const { svg, rerender } = setup();
    openTools();
    pick("vline");
    tap(svg, 8 + 10.1 * 40 + 5, 100);
    expect(kept()[0].points[0].t).toBe(T0 + 40 * H1);
    rerender(<LocaleProvider initial="ja"><PriceChart candles={bars(60)} pair="EUR/USD" drawable /></LocaleProvider>);
    expect(drawnEls()).toHaveLength(0);
    // the 4-hour chart of the same pair: 40 hours on is 4-hour bar 10
    rerender(<LocaleProvider initial="ja"><PriceChart candles={bars(60, 4 * H1)} pair="USD/JPY" drawable /></LocaleProvider>);
    const line = drawnEls()[0].querySelector("line")!;
    expect(Number(line.getAttribute("x1"))).toBeCloseTo(8 + 10.1 * 10 + 5.05, 1);
  });

  it("opens room past the newest bar when the bars are dragged past it, to draw into it", () => {
    const { svg } = setup();
    const lastX = () => {
      const bodies = screen.getByTestId("chart-candles").children;
      return Number(bodies[bodies.length - 1].querySelector("rect")?.getAttribute("x") ?? "NaN");
    };
    const before = lastX();
    fireEvent.pointerDown(svg, { pointerId: 1, pointerType: "touch", clientX: 500, clientY: 150 });
    fireEvent.pointerMove(svg, { pointerId: 1, pointerType: "touch", clientX: 400, clientY: 150 });
    fireEvent.pointerUp(svg, { pointerId: 1, pointerType: "touch", clientX: 400, clientY: 150 });
    expect(lastX()).toBeLessThan(before - 50);
    openTools();
    pick("vline");
    tap(svg, 600, 100);
    expect(kept()[0].points[0].t).toBeGreaterThan(T0 + 59 * H1);
  });
});

describe("#160 the drawings follow the account", () => {
  type Row = { pair: string; drawings: unknown };
  const client = (rows: Row[] | null, error: unknown = null) => {
    const upserts: Array<Array<Record<string, unknown>>> = [];
    const c = {
      from: (table: string) => {
        expect(table).toBe(CHART_DRAWINGS_TABLE);
        return {
          select: () => ({ eq: () => Promise.resolve({ data: rows, error }) }),
          upsert: (r: Array<Record<string, unknown>>) => {
            upserts.push(r);
            return Promise.resolve({ error: null });
          },
        };
      },
    };
    return { c: c as never, upserts };
  };
  const line = (id: string): Drawing => ({ id, tool: "hline", points: [{ t: T0, p: 150 }], color: "#2962FF", width: 2, style: "solid" });

  it("takes the account's pairs on signing in, and gives it a pair only this browser has", async () => {
    setPairDrawings("USD/JPY", [line("mine")]);
    setPairDrawings("EUR/USD", [line("here")]);
    const { c, upserts } = client([{ pair: "USD/JPY", drawings: [line("theirs")] }]);
    renderHook(() => useChartDrawingsSync("u1", c));
    await waitFor(() => expect(kept("USD/JPY").map((d) => d.id)).toEqual(["theirs"]));
    expect(kept("EUR/USD").map((d) => d.id)).toEqual(["here"]);
    await waitFor(() => expect(upserts).toHaveLength(1));
    expect(upserts[0].map((r) => r.pair)).toEqual(["EUR/USD"]);
    expect(upserts[0][0]).toMatchObject({ user_id: "u1", pair: "EUR/USD", drawings: [line("here")] });
  });

  it("writes a change back a moment later, only the pair that changed", async () => {
    vi.useFakeTimers();
    try {
      const { c, upserts } = client([{ pair: "USD/JPY", drawings: [] }]);
      renderHook(() => useChartDrawingsSync("u1", c));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(upserts).toHaveLength(0);
      act(() => setPairDrawings("USD/JPY", [line("a")]));
      act(() => setPairDrawings("USD/JPY", [line("a"), line("b")]));
      expect(upserts).toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(900);
      });
      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toHaveLength(1);
      expect((upserts[0][0].drawings as Drawing[]).map((d) => d.id)).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps this browser's when the account cannot be read, without writing over it", async () => {
    setPairDrawings("USD/JPY", [line("mine")]);
    const { c, upserts } = client(null, { message: "no table" });
    renderHook(() => useChartDrawingsSync("u1", c));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => setPairDrawings("USD/JPY", [line("mine"), line("more")]));
    await new Promise((r) => setTimeout(r, 900));
    expect(upserts).toHaveLength(0);
    expect(kept("USD/JPY").map((d) => d.id)).toEqual(["mine", "more"]);
  });

  it("keeps the drawing tools' settings with the chart's, which the account already follows", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ drawing: { magnet: "weak", keep: true, color: "#089981", width: 9 } }));
    resetChartPrefsCache();
    expect(getChartPrefs().drawing).toEqual({ magnet: "weak", keep: true, hidden: false, color: "#089981", width: 2, style: "solid" });
  });
});
