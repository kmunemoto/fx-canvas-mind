import { describe, it, expect, beforeEach } from "vitest";
import {
  DRAWING_TOOLS,
  FIB_LEVELS,
  MAX_DRAWINGS_PER_PAIR,
  POINTS_OF,
  TAPS_OF,
  channelOffset,
  distanceTo,
  drawingAt,
  drawingFrom,
  drawingListFrom,
  drawingsFrom,
  fibPrice,
  handleAt,
  indexAtTime,
  measureOf,
  moveDrawing,
  movePoint,
  positionOf,
  positionPoints,
  shapeOf,
  snapPrice,
  timeAtIndex,
  timeAxisOf,
  type Drawing,
  type Frame,
  type Words,
} from "../lib/drawings";
import { DRAWINGS_KEY, getDrawings, pairDrawings, replacePairDrawings, resetDrawingsCache, setPairDrawings } from "../lib/drawingsStore";

const H = 3_600_000;
const T0 = Date.parse("2026-09-21T00:00:00Z");
// 10 hourly bars, then (a weekend) 10 more two days on
const opens = [...Array.from({ length: 10 }, (_, i) => T0 + i * H), ...Array.from({ length: 10 }, (_, i) => T0 + 58 * H + i * H)];
const axis = timeAxisOf(opens);

// a plot 100..500 wide, 0..200 high; bar f at 100 + 20 f, price 150 at 100, 1 per 100 px
const frame: Frame = { x: (f) => 100 + 20 * f, y: (p) => 100 - (p - 150) * 100, left: 100, right: 500, top: 0, bottom: 200 };
const words: Words = {
  price: (p) => p.toFixed(3),
  measure: (m) => [`${m.diff.toFixed(3)} ${m.pct === null ? "—" : m.pct.toFixed(2)}%`, `${m.bars} bars`],
  position: (p) => ({ target: `T ${p.target.toFixed(3)}`, stop: `S ${p.stop.toFixed(3)}`, ratio: `R ${p.ratio === null ? "—" : p.ratio.toFixed(2)}` }),
};
const d = (tool: Drawing["tool"], points: Array<[number, number]>, extra: Partial<Drawing> = {}): Drawing => ({
  id: `x-${tool}`,
  tool,
  points: points.map(([f, p]) => ({ t: timeAtIndex(axis, f), p })),
  color: "#2962FF",
  width: 2,
  style: "solid",
  ...extra,
});

describe("#160 a drawing's place in time", () => {
  it("takes one bar's length from the shortest gap (a weekend is a longer one)", () => {
    expect(axis.step).toBe(H);
  });

  it("puts each bar's open on its own index, and a time inside a bar that part of the way on", () => {
    opens.forEach((t, i) => expect(indexAtTime(axis, t)).toBe(i));
    expect(indexAtTime(axis, T0 + 2.5 * H)).toBeCloseTo(2.5);
  });

  it("puts a time in the weekend's gap at the next bar, and runs a bar's length per bar past either end", () => {
    expect(indexAtTime(axis, T0 + 30 * H)).toBe(10);
    expect(indexAtTime(axis, T0 - 3 * H)).toBe(-3);
    expect(indexAtTime(axis, opens[19] + 4 * H)).toBe(23);
  });

  it("gives back the time it was given, for any place on the chart and past its ends", () => {
    for (const f of [-5, -0.5, 0, 3.25, 9, 9.5, 10, 14.75, 19, 25]) {
      expect(indexAtTime(axis, timeAtIndex(axis, f))).toBeCloseTo(f, 9);
    }
  });

  it("keeps a line on the same times on another timeframe: a 1-hour bar's open lands inside the 4-hour bar that holds it", () => {
    const four = timeAxisOf(Array.from({ length: 6 }, (_, i) => T0 + i * 4 * H));
    expect(indexAtTime(four, T0 + 5 * H)).toBeCloseTo(1.25);
    expect(indexAtTime(four, T0 + 8 * H)).toBe(2);
  });
});

describe("#160 what is kept", () => {
  it("reads every tool back with the points it takes", () => {
    for (const tool of DRAWING_TOOLS) {
      const pts = Array.from({ length: POINTS_OF[tool] }, (_, k) => ({ t: T0 + k * H, p: 150 + k }));
      expect(drawingFrom({ id: "a", tool, points: pts, color: "#F23645", width: 3, style: "dashed" })).toEqual({
        id: "a",
        tool,
        points: pts,
        color: "#F23645",
        width: 3,
        style: "dashed",
      });
    }
  });

  it("drops what is not a drawing it can draw: an unknown tool, the wrong number of points, a point that is not a number", () => {
    expect(drawingFrom({ id: "a", tool: "pitchfork", points: [{ t: 1, p: 1 }] })).toBeNull();
    expect(drawingFrom({ id: "a", tool: "trend", points: [{ t: 1, p: 1 }] })).toBeNull();
    expect(drawingFrom({ id: "a", tool: "hline", points: [{ t: 1, p: "1" }] })).toBeNull();
    expect(drawingFrom({ id: "", tool: "hline", points: [{ t: 1, p: 1 }] })).toBeNull();
    expect(drawingFrom(null)).toBeNull();
  });

  it("puts a colour, width or line style it does not know back to the defaults, and cuts a long text", () => {
    const r = drawingFrom({ id: "a", tool: "text", points: [{ t: 1, p: 1 }], color: "red", width: 9, style: "wavy", text: "x".repeat(500), locked: "yes" });
    expect(r).toEqual({ id: "a", tool: "text", points: [{ t: 1, p: 1 }], color: "#2962FF", width: 1, style: "solid", text: "x".repeat(200) });
  });

  it("keeps one of each id, at most 200 a pair, and only pairs with a short name", () => {
    const one = { id: "a", tool: "hline", points: [{ t: 1, p: 1 }] };
    expect(drawingListFrom([one, one])).toHaveLength(1);
    const many = Array.from({ length: 250 }, (_, i) => ({ ...one, id: `a${i}` }));
    expect(drawingListFrom(many)).toHaveLength(MAX_DRAWINGS_PER_PAIR);
    expect(Object.keys(drawingsFrom({ "USD/JPY": [one], [" ".repeat(20)]: [one], "": [one] }))).toEqual(["USD/JPY"]);
    expect(drawingsFrom([one])).toEqual({});
  });

  it("puts a position down with one tap and keeps its three points", () => {
    expect(TAPS_OF.long).toBe(1);
    expect(POINTS_OF.long).toBe(3);
    expect(TAPS_OF.channel).toBe(3);
    expect(TAPS_OF.trend).toBe(2);
  });
});

describe("#160 where a drawing lands on the screen", () => {
  it("draws a trend line between its two points, and a ray and an extended line on past them", () => {
    const trend = shapeOf(d("trend", [[1, 150], [3, 151]]), axis, frame, words);
    expect(trend.segments[0]).toEqual({ x1: 120, y1: 100, x2: 160, y2: 0 });
    const ray = shapeOf(d("ray", [[1, 150], [3, 151]]), axis, frame, words).segments[0];
    expect([ray.x1, ray.y1]).toEqual([120, 100]);
    expect(ray.y2).toBeLessThan(-1000);
    // the same slope
    expect((ray.y2 - ray.y1) / (ray.x2 - ray.x1)).toBeCloseTo(-2.5);
    const ext = shapeOf(d("extended", [[1, 150], [3, 151]]), axis, frame, words).segments[0];
    expect(ext.x1).toBeLessThan(frame.left);
    expect(ext.x2).toBeGreaterThan(160);
  });

  it("draws a horizontal line across the plot, a horizontal ray from its point, a vertical line top to bottom", () => {
    expect(shapeOf(d("hline", [[4, 149.5]]), axis, frame, words).segments[0]).toEqual({ x1: 100, y1: 150, x2: 500, y2: 150 });
    expect(shapeOf(d("hray", [[4, 149.5]]), axis, frame, words).segments[0]).toEqual({ x1: 180, y1: 150, x2: 500, y2: 150 });
    expect(shapeOf(d("vline", [[4, 149.5]]), axis, frame, words).segments[0]).toEqual({ x1: 180, y1: 0, x2: 180, y2: 200 });
  });

  it("puts the Fibonacci levels between the two points, 1 at the first and 0 at the second, with their prices", () => {
    expect(fibPrice({ t: 0, p: 100 }, { t: 1, p: 200 }, 0)).toBe(200);
    expect(fibPrice({ t: 0, p: 100 }, { t: 1, p: 200 }, 1)).toBe(100);
    expect(fibPrice({ t: 0, p: 100 }, { t: 1, p: 200 }, 0.618)).toBeCloseTo(138.2);
    const s = shapeOf(d("fib", [[1, 150], [5, 151]]), axis, frame, words);
    // the dotted line from point to point, then a line for each level
    expect(s.segments).toHaveLength(1 + FIB_LEVELS.length);
    expect(s.labels.map((l) => l.text)).toContain("0.5 (150.500)");
    expect(s.labels.map((l) => l.text)).toContain("0 (151.000)");
    expect(s.labels.map((l) => l.text)).toContain("1 (150.000)");
  });

  it("puts the Fibonacci time zone's lines 0, 1, 2, 3, 5, 8 … times the bars between the points on from the first", () => {
    const s = shapeOf(d("fibTime", [[2, 150], [4, 151]]), axis, frame, words);
    const xsOf = s.segments.filter((g) => g.y1 === frame.top && g.y2 === frame.bottom).map((g) => g.x1);
    expect(xsOf.slice(0, 6)).toEqual([140, 180, 220, 260, 340, 460]);
    expect(s.labels.slice(0, 6).map((l) => l.text)).toEqual(["0", "1", "2", "3", "5", "8"]);
  });

  it("draws the Fibonacci fan from the first point through the second one's time at 38.2%, 50% and 61.8%", () => {
    const s = shapeOf(d("fibFan", [[0, 150], [5, 151]]), axis, frame, words);
    // at the second point's x (200), each ray is at its level's price
    const at200 = (g: { x1: number; y1: number; x2: number; y2: number }) => g.y1 + ((g.y2 - g.y1) * (200 - g.x1)) / (g.x2 - g.x1);
    const rays = s.segments.slice(0, 4);
    expect(rays.map((g) => g.x1)).toEqual([100, 100, 100, 100]);
    expect(rays.map((g) => at200(g))).toEqual([frame.y(151), frame.y(150.618), frame.y(150.5), frame.y(150.382)].map((v) => expect.closeTo(v, 6)));
    expect(s.labels.map((l) => l.text)).toEqual(["38.2%", "50%", "61.8%"]);
  });

  it("draws the Fibonacci arcs around the second point, through the line to the first at its levels, bulging toward the first", () => {
    const s = shapeOf(d("fibArc", [[0, 151], [3, 150.2]]), axis, frame, words);
    const len = Math.hypot(160 - 100, frame.y(150.2) - frame.y(151));
    expect(s.arcs.map((a) => a.r)).toEqual([0.382, 0.5, 0.618, 1].map((k) => expect.closeTo(len * k, 6)));
    // the first point is above: the arcs bulge up
    expect(s.arcs.every((a) => a.up && a.cx === 160)).toBe(true);
    // a touch on the half-way arc, above the centre, is on it; below the centre it is not
    const r = len * 0.5;
    expect(distanceTo(s, 160, frame.y(150.2) - r)).toBeCloseTo(0, 5);
    expect(distanceTo(s, 160, frame.y(150.2) + r)).toBeGreaterThan(5);
  });

  it("draws a channel's parallel line as far from the first as its third point, and a dashed middle", () => {
    expect(channelOffset([{ f: 0, p: 150 }, { f: 4, p: 152 }, { f: 2, p: 150 }])).toBeCloseTo(-1);
    const s = shapeOf(d("channel", [[0, 150], [4, 152], [2, 150]]), axis, frame, words);
    expect(s.segments[1]).toEqual({ x1: 100, y1: frame.y(149), x2: 180, y2: frame.y(151) });
    expect(s.segments[2].dash).toBe("4 4");
    expect(s.handles).toHaveLength(3);
  });

  it("measures the price move, its percent, and the bars between two points", () => {
    const m = measureOf({ t: opens[2], p: 150 }, { t: opens[12], p: 151.5 }, axis);
    expect(m.diff).toBeCloseTo(1.5);
    expect(m.pct).toBeCloseTo(1);
    expect(m.bars).toBe(10);
    const s = shapeOf(d("measure", [[2, 150], [12, 151.5]]), axis, frame, words);
    expect(s.labels.map((l) => l.text)).toEqual(["1.500 1.00%", "10 bars"]);
  });

  it("puts a long position's target above its entry and its stop as far below, and a short's the other way", () => {
    const e = { t: opens[3], p: 150 };
    const long = positionPoints("long", e, 0.5, opens[8]);
    expect(long.map((p) => p.p)).toEqual([150, 150.5, 149.5]);
    const short = positionPoints("short", e, 0.5, opens[8]);
    expect(short.map((p) => p.p)).toEqual([150, 149.5, 150.5]);
    const read = positionOf({ ...d("long", [[3, 150], [8, 151]]), points: [e, { t: opens[8], p: 151 }, { t: e.t, p: 149.5 }] });
    expect(read.ratio).toBeCloseTo(2);
  });
});

describe("#160 what a touch is on", () => {
  const shapes = [
    { id: "h", shape: shapeOf(d("hline", [[4, 150]]), axis, frame, words) },
    { id: "r", shape: shapeOf(d("rect", [[8, 149]], { points: [{ t: opens[8], p: 149 }, { t: opens[12], p: 148 }] }), axis, frame, words) },
  ];

  it("finds a line within the tolerance, and not beyond it", () => {
    expect(drawingAt(shapes, 300, 105, 8)).toBe("h");
    expect(drawingAt(shapes, 300, 120, 8)).toBeNull();
  });

  it("finds a rectangle by its inside as well as its edges", () => {
    // the rectangle spans x 260..340 and y 200..300 (under the plot, but hit anyway)
    expect(drawingAt(shapes, 300, 250, 8)).toBe("r");
  });

  it("takes the drawing on top first", () => {
    const both = [...shapes, { id: "h2", shape: shapeOf(d("hline", [[4, 150]]), axis, frame, words) }];
    expect(drawingAt(both, 300, 100, 8)).toBe("h2");
  });

  it("finds the handle nearest the touch", () => {
    const s = shapeOf(d("trend", [[1, 150], [3, 151]]), axis, frame, words);
    expect(handleAt(s, 121, 101, 10)).toBe(0);
    expect(handleAt(s, 158, 3, 10)).toBe(1);
    expect(handleAt(s, 140, 50, 10)).toBeNull();
    expect(distanceTo(s, 140, 50)).toBeCloseTo(0, 5);
  });
});

describe("#160 putting points down and moving them", () => {
  const bar = { open: 150.1, high: 150.4, low: 149.8, close: 150.2 };

  it("the magnet: off leaves the price, weak takes a price near the bar, strong always the nearest of its four", () => {
    expect(snapPrice(bar, 150.38, "off", 100)).toBe(150.38);
    expect(snapPrice(bar, 150.38, "weak", 100)).toBe(150.4);
    // 0.35 from the high is 35 px: too far for the weak one
    expect(snapPrice(bar, 150.75, "weak", 100)).toBe(150.75);
    expect(snapPrice(bar, 150.75, "strong", 100)).toBe(150.4);
    expect(snapPrice(undefined, 150.75, "strong", 100)).toBe(150.75);
  });

  it("moves a drawing whole, or one point of it, and leaves a locked one where it is", () => {
    const tr = d("trend", [[1, 150], [3, 151]]);
    const moved = moveDrawing(tr, H, 0.5);
    expect(moved.points.map((p) => p.p)).toEqual([150.5, 151.5]);
    expect(moved.points[0].t).toBe(tr.points[0].t + H);
    expect(movePoint(tr, 1, { t: 0, p: 1 }).points[1]).toEqual({ t: 0, p: 1 });
    const locked = { ...tr, locked: true };
    expect(moveDrawing(locked, H, 1)).toBe(locked);
    expect(movePoint(locked, 0, { t: 0, p: 0 })).toBe(locked);
  });

  it("moves a position's stop up and down only", () => {
    const pos: Drawing = { ...d("long", [[3, 150], [8, 151]]), points: [{ t: 5, p: 150 }, { t: 9, p: 151 }, { t: 5, p: 149.5 }] };
    expect(movePoint(pos, 2, { t: 99, p: 149 }).points[2]).toEqual({ t: 5, p: 149 });
  });
});

describe("#160 the drawings kept in this browser", () => {
  beforeEach(() => {
    localStorage.clear();
    resetDrawingsCache();
  });

  it("keeps each pair's drawings and reads them back after a reload", () => {
    const tr = d("trend", [[1, 150], [3, 151]]);
    setPairDrawings("USD/JPY", [tr]);
    resetDrawingsCache();
    expect(pairDrawings("USD/JPY")).toEqual([tr]);
    expect(pairDrawings("EUR/USD")).toEqual([]);
    expect(JSON.parse(localStorage.getItem(DRAWINGS_KEY) ?? "{}")).toEqual({ "USD/JPY": [tr] });
  });

  it("takes the account's pairs as they are and leaves the others", () => {
    const a = d("hline", [[1, 150]]);
    const b = { ...d("vline", [[2, 150]]), id: "b" };
    setPairDrawings("USD/JPY", [a]);
    setPairDrawings("EUR/USD", [a]);
    replacePairDrawings({ "USD/JPY": [b] });
    expect(getDrawings()).toEqual({ "USD/JPY": [b], "EUR/USD": [a] });
  });

  it("reads nothing it cannot use from storage", () => {
    localStorage.setItem(DRAWINGS_KEY, "not json");
    expect(getDrawings()).toEqual({});
  });
});

describe("#160 a label's width", () => {
  it("counts a Japanese character a full size and a figure 0.6 of it", async () => {
    const { textWidth } = await import("../lib/drawings");
    expect(textWidth("150.732", 10)).toBeCloseTo(42);
    expect(textWidth("損切 1", 10)).toBeCloseTo(20 + 6 + 6);
  });
});
