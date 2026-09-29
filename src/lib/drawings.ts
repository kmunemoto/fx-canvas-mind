// #160: lines and shapes drawn on the chart by hand, as FX and stock apps
// have them (TradingView, iSPEED FX, MT4/MT5). The owner (2026-09-29):
// 「他のfxと株のアプリみたいにチャートに線引けたりできる様にして 色々機能調べて
// 追加して」.
//
// A drawing is kept in time and price, not in the screen's pixels: its
// points stay on the bars they were put on as the chart is zoomed and panned
// and as new bars come, and — kept per pair, as TradingView keeps them per
// symbol — it shows on every timeframe of the pair, each point on the bar
// whose time holds it. On the screen a drawing is straight in bars (as
// TradingView and MT4 draw it), so a line across a weekend is as straight as
// the candles under it.
//
// This file is the pure part — the tools, where a drawing lands on the
// screen, what a touch is on, what is kept — for the chart
// (components/PriceChart.tsx) and its tests.

// ---- the tools ----------------------------------------------------------------------

export const DRAWING_TOOLS = [
  // lines
  "trend",
  "ray",
  "extended",
  "hline",
  "hray",
  "vline",
  "channel",
  // Fibonacci
  "fib",
  "fibTime",
  "fibFan",
  "fibArc",
  // shapes, marks and measures
  "rect",
  "text",
  "arrowUp",
  "arrowDown",
  "measure",
  "long",
  "short",
] as const;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];

// How many points each tool is put down with
export const POINTS_OF: Record<DrawingTool, number> = {
  trend: 2,
  ray: 2,
  extended: 2,
  hline: 1,
  hray: 1,
  vline: 1,
  channel: 3,
  fib: 2,
  fibTime: 2,
  fibFan: 2,
  fibArc: 2,
  rect: 2,
  text: 1,
  arrowUp: 1,
  arrowDown: 1,
  measure: 2,
  // the entry, and the target (its price) and how far the box runs (its time);
  // the stop starts as far the other way and is moved on its own
  long: 3,
  short: 3,
};

// How many taps (or clicks) put each tool down: a position is put down
// with its entry, its target and stop starting a set distance away
export const TAPS_OF: Record<DrawingTool, number> = { ...POINTS_OF, long: 1, short: 1 };

// The toolbar's groups, as TradingView's and iSPEED FX's menus group them
// (the Fibonacci four are iSPEED FX's: retracement, time zone, fan and arc)
export const TOOL_GROUPS: ReadonlyArray<{ key: "lines" | "fib" | "marks"; tools: ReadonlyArray<DrawingTool> }> = [
  { key: "lines", tools: ["trend", "hline", "vline", "ray", "hray", "extended", "channel"] },
  { key: "fib", tools: ["fib", "fibTime", "fibFan", "fibArc"] },
  { key: "marks", tools: ["rect", "text", "arrowUp", "arrowDown", "measure", "long", "short"] },
];

// Fibonacci retracement: the levels TradingView shows by default, and each
// level's colour (its Charting Library's defaults, as its documentation
// lists them: FibretracementLineToolOverrides)
export const FIB_LEVELS: ReadonlyArray<number> = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236];
export const FIB_COLORS: Readonly<Record<string, string>> = {
  "0": "#787B86",
  "0.236": "#F23645",
  "0.382": "#FF9800",
  "0.5": "#4CAF50",
  "0.618": "#089981",
  "0.786": "#00BCD4",
  "1": "#787B86",
  "1.618": "#2962FF",
  "2.618": "#F23645",
  "3.618": "#9C27B0",
  "4.236": "#E91E63",
};
// Fibonacci time zone: vertical lines this many times the bars between the
// two points on from the first (TradingView's defaults: 0 grey, the rest blue)
export const FIB_TIME_LEVELS: ReadonlyArray<number> = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
// Fibonacci fan: from the first point through the second one's time at the
// retracement's 38.2%, 50% and 61.8% (and the trend line itself, 0)
export const FIB_FAN_LEVELS: ReadonlyArray<number> = [0, 0.382, 0.5, 0.618];
// Fibonacci arcs: around the second point, through the line to the first at
// 38.2%, 50%, 61.8% and 100% of its length
export const FIB_ARC_LEVELS: ReadonlyArray<number> = [0.382, 0.5, 0.618, 1];
const FAN_ARC_COLORS: Readonly<Record<string, string>> = { "0.382": "#FF9800", "0.5": "#089981", "0.618": "#00BCD4", "1": "#787B86" };

// The colours a drawing can take (the first is where a new one starts),
// and the widths and line styles
export const DRAWING_COLORS: ReadonlyArray<string> = ["#2962FF", "#F23645", "#089981", "#FF9800", "#9C27B0", "#00BCD4", "#FFEB3B", "#787B86", "#FFFFFF", "#000000"];
export const DRAWING_WIDTHS: ReadonlyArray<number> = [1, 2, 3, 4];
export const LINE_STYLES = ["solid", "dashed", "dotted"] as const;
export type LineStyle = (typeof LINE_STYLES)[number];
export const DASH_OF: Record<LineStyle, string | undefined> = { solid: undefined, dashed: "6 4", dotted: "1.5 3" };

// ---- what is kept ---------------------------------------------------------------------

// A point: `t` a time on the chart's time axis (ms, UTC; between two bars
// when it is), `p` a price
export interface DrawingPoint {
  t: number;
  p: number;
}

export interface Drawing {
  id: string;
  tool: DrawingTool;
  points: DrawingPoint[];
  color: string;
  width: number;
  style: LineStyle;
  // the text tool's words (and a note on any other)
  text?: string;
  // locked: not moved or changed until unlocked (TradingView's lock)
  locked?: boolean;
}

// The drawings of every pair
export type DrawingsByPair = Record<string, Drawing[]>;

// Bounds, so what is kept stays a drawing and not a store of anything
export const MAX_DRAWINGS_PER_PAIR = 200;
export const MAX_TEXT = 200;
const MAX_ID = 40;
const MAX_PAIR = 16;

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// One drawing as kept — in this browser or with the account — or null when
// it is not one this chart can draw
export const drawingFrom = (v: unknown): Drawing | null => {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > MAX_ID) return null;
  if (typeof r.tool !== "string" || !(DRAWING_TOOLS as ReadonlyArray<string>).includes(r.tool)) return null;
  const tool = r.tool as DrawingTool;
  if (!Array.isArray(r.points) || r.points.length !== POINTS_OF[tool]) return null;
  const points: DrawingPoint[] = [];
  for (const pt of r.points) {
    if (pt === null || typeof pt !== "object") return null;
    const { t, p } = pt as Record<string, unknown>;
    if (!finite(t) || !finite(p)) return null;
    points.push({ t, p });
  }
  const out: Drawing = {
    id: r.id,
    tool,
    points,
    color: isHex(r.color) ? r.color : DRAWING_COLORS[0],
    width: DRAWING_WIDTHS.includes(r.width as number) ? (r.width as number) : 1,
    style: (LINE_STYLES as ReadonlyArray<unknown>).includes(r.style) ? (r.style as LineStyle) : "solid",
  };
  if (typeof r.text === "string" && r.text.length > 0) out.text = r.text.slice(0, MAX_TEXT);
  if (r.locked === true) out.locked = true;
  return out;
};

export const drawingListFrom = (v: unknown): Drawing[] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Drawing[] = [];
  for (const x of v) {
    const d = drawingFrom(x);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
    if (out.length >= MAX_DRAWINGS_PER_PAIR) break;
  }
  return out;
};

export const isPairKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_PAIR;

export const drawingsFrom = (v: unknown): DrawingsByPair => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: DrawingsByPair = {};
  for (const [pair, list] of Object.entries(v as Record<string, unknown>)) {
    if (!isPairKey(pair)) continue;
    out[pair] = drawingListFrom(list);
  }
  return out;
};

// A new drawing's id: unique enough for one person's drawings
export const newDrawingId = (): string => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---- the time axis ------------------------------------------------------------------------

// The chart's bars on the time axis: each bar's open time, and one bar's length
export interface TimeAxis {
  opens: ReadonlyArray<number>;
  step: number;
}

// The bars' opens (ms), and their length: the shortest gap between two
// (a weekend is a longer one)
export const timeAxisOf = (opens: ReadonlyArray<number>): TimeAxis => {
  let step = Infinity;
  for (let i = 1; i < opens.length; i++) {
    const d = opens[i] - opens[i - 1];
    if (Number.isFinite(d) && d > 0 && d < step) step = d;
  }
  return { opens, step: Number.isFinite(step) ? step : 60_000 };
};

// Where a time is, in bars: bar i's open is i, a time inside it that part
// of the way to the next bar (a time in a gap, such as a weekend, is at the
// next bar); before the first bar and after the last one, a bar's length
// per bar
export const indexAtTime = (axis: TimeAxis, t: number): number => {
  const { opens, step } = axis;
  const n = opens.length;
  if (n === 0 || !Number.isFinite(t)) return 0;
  if (t < opens[0]) return (t - opens[0]) / step;
  // the last bar that opened at or before t
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (opens[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const frac = (t - opens[lo]) / step;
  return lo === n - 1 ? lo + frac : lo + Math.min(1, frac);
};

// The time at a place in bars: the inverse of indexAtTime
export const timeAtIndex = (axis: TimeAxis, f: number): number => {
  const { opens, step } = axis;
  const n = opens.length;
  if (n === 0 || !Number.isFinite(f)) return 0;
  if (f < 0) return opens[0] + f * step;
  const i = Math.min(n - 1, Math.floor(f));
  return opens[i] + (f - i) * step;
};

// ---- on the screen ------------------------------------------------------------------------

// Where the chart puts things: `x` of a place in bars, `y` of a price, and
// the plot's edges
export interface Frame {
  x: (f: number) => number;
  y: (p: number) => number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // drawn dashed (a channel's middle, a measure's arrows are not)
  dash?: string;
  // a line of its own colour (the Fibonacci levels)
  color?: string;
  opacity?: number;
  width?: number;
}
export interface Area {
  points: Array<[number, number]>;
  color?: string;
  opacity: number;
}
export interface Label {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  color?: string;
  // the box behind a label, as a measure's and a position's have
  fill?: string;
}
// a half circle: around (cx, cy), r across, on the side above the centre
// (up) or below it
export interface Arc {
  cx: number;
  cy: number;
  r: number;
  up: boolean;
  color?: string;
}
export interface Shape {
  segments: Segment[];
  arcs: Arc[];
  areas: Area[];
  labels: Label[];
  // the points a selected drawing is moved by
  handles: Array<{ x: number; y: number; k: number }>;
  // a mark drawn as a filled arrow (arrowUp, arrowDown)
  arrows: Array<{ x: number; y: number; up: boolean }>;
}

// A line through two screen points carried to the plot's edges: to the
// right (a ray the way it was drawn), or both ways (an extended line)
const carry = (x1: number, y1: number, x2: number, y2: number, frame: Frame, both: boolean): Segment => {
  const far = (frame.right - frame.left + frame.bottom - frame.top) * 4;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x1, y1, x2, y2 };
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: both ? x1 - ux * far : x1,
    y1: both ? y1 - uy * far : y1,
    x2: x2 + ux * far,
    y2: y2 + uy * far,
  };
};

// The labels' prices and distances are the chart's to write (its decimals,
// pips, words); a shape asks for them through this
export interface Words {
  price: (p: number) => string;
  // a measure: the price move, its percent, the bars and the time between
  measure: (m: Measure) => string[];
  // a position: the target's and the stop's distances and their ratio
  position: (p: PositionRead) => { target: string; stop: string; ratio: string };
}

export interface Measure {
  diff: number;
  pct: number | null;
  bars: number;
  ms: number;
}

// A measure from a to b: the price move (and percent of a), and the bars
// and time between them
export const measureOf = (a: DrawingPoint, b: DrawingPoint, axis: TimeAxis): Measure => ({
  diff: b.p - a.p,
  pct: a.p !== 0 ? ((b.p - a.p) / a.p) * 100 : null,
  bars: Math.round(indexAtTime(axis, b.t) - indexAtTime(axis, a.t)),
  ms: b.t - a.t,
});

// A long or short position's three prices from its points: the entry
// (points[0]), the target (points[1]'s price; points[1]'s time is where the
// box ends) and the stop (points[2]'s price)
export interface PositionRead {
  side: "long" | "short";
  entry: number;
  target: number;
  stop: number;
  // the target's distance over the stop's (null while the stop is at the entry)
  ratio: number | null;
}
export const positionOf = (d: Drawing): PositionRead => {
  const [e, tp, sl] = d.points;
  const risk = Math.abs(e.p - sl.p);
  return {
    side: d.tool === "short" ? "short" : "long",
    entry: e.p,
    target: tp.p,
    stop: sl.p,
    ratio: risk > 0 ? Math.abs(tp.p - e.p) / risk : null,
  };
};

// The price of the Fibonacci level `level` between a (its 1) and b (its 0),
// as TradingView and MT4 place them: 0 at the second point
export const fibPrice = (a: DrawingPoint, b: DrawingPoint, level: number): number => b.p + (a.p - b.p) * level;

// A channel's parallel line: as far from the line through a and b (in
// price, at the same bar) as c is
export const channelOffset = (pts: ReadonlyArray<{ f: number; p: number }>): number => {
  const [a, b, c] = pts;
  if (Math.abs(b.f - a.f) < 1e-9) return c.p - a.p;
  const at = a.p + ((b.p - a.p) * (c.f - a.f)) / (b.f - a.f);
  return c.p - at;
};

// Where a drawing lands on the screen now
export const shapeOf = (d: Drawing, axis: TimeAxis, frame: Frame, words: Words): Shape => {
  const out: Shape = { segments: [], arcs: [], areas: [], labels: [], handles: [], arrows: [] };
  const f = d.points.map((pt) => indexAtTime(axis, pt.t));
  const xs = f.map((v) => frame.x(v));
  const ys = d.points.map((pt) => frame.y(pt.p));
  const handle = (k: number) => out.handles.push({ x: xs[k], y: ys[k], k });
  switch (d.tool) {
    case "trend":
      out.segments.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1] });
      handle(0);
      handle(1);
      break;
    case "ray":
      out.segments.push(carry(xs[0], ys[0], xs[1], ys[1], frame, false));
      handle(0);
      handle(1);
      break;
    case "extended":
      out.segments.push(carry(xs[0], ys[0], xs[1], ys[1], frame, true));
      handle(0);
      handle(1);
      break;
    case "hline":
      out.segments.push({ x1: frame.left, y1: ys[0], x2: frame.right, y2: ys[0] });
      handle(0);
      break;
    case "hray":
      out.segments.push({ x1: xs[0], y1: ys[0], x2: frame.right, y2: ys[0] });
      handle(0);
      break;
    case "vline":
      out.segments.push({ x1: xs[0], y1: frame.top, x2: xs[0], y2: frame.bottom });
      handle(0);
      break;
    case "channel": {
      const off = channelOffset(d.points.map((pt, k) => ({ f: f[k], p: pt.p })));
      const y2a = frame.y(d.points[0].p + off);
      const y2b = frame.y(d.points[1].p + off);
      const ma = frame.y(d.points[0].p + off / 2);
      const mb = frame.y(d.points[1].p + off / 2);
      out.areas.push({ points: [[xs[0], ys[0]], [xs[1], ys[1]], [xs[1], y2b], [xs[0], y2a]], opacity: 0.1 });
      out.segments.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1] });
      out.segments.push({ x1: xs[0], y1: y2a, x2: xs[1], y2: y2b });
      out.segments.push({ x1: xs[0], y1: ma, x2: xs[1], y2: mb, dash: "4 4", opacity: 0.7 });
      handle(0);
      handle(1);
      // the parallel line's handle at its middle
      out.handles.push({ x: (xs[0] + xs[1]) / 2, y: (y2a + y2b) / 2, k: 2 });
      break;
    }
    case "fib": {
      const x1 = Math.min(xs[0], xs[1]);
      const x2 = Math.max(xs[0], xs[1]);
      // the trend line from the first point to the second, dotted
      out.segments.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1], dash: "2 3", opacity: 0.6 });
      let prevY: number | null = null;
      FIB_LEVELS.forEach((lv) => {
        const price = fibPrice(d.points[0], d.points[1], lv);
        const yy = frame.y(price);
        const color = FIB_COLORS[String(lv)] ?? d.color;
        if (prevY !== null) out.areas.push({ points: [[x1, prevY], [x2, prevY], [x2, yy], [x1, yy]], color, opacity: 0.08 });
        prevY = yy;
        out.segments.push({ x1, y1: yy, x2, y2: yy, color });
        out.labels.push({ x: x1 - 3, y: yy, text: `${lv} (${words.price(price)})`, anchor: "end", color });
      });
      handle(0);
      handle(1);
      break;
    }
    case "fibTime": {
      const span = f[1] - f[0];
      FIB_TIME_LEVELS.forEach((lv) => {
        const xx = frame.x(f[0] + lv * span);
        const color = lv === 0 ? "#787B86" : d.color;
        out.segments.push({ x1: xx, y1: frame.top, x2: xx, y2: frame.bottom, color });
        out.labels.push({ x: xx + 3, y: frame.bottom - 4, text: String(lv), anchor: "start", color });
      });
      // the two points, on a dotted line
      out.segments.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1], dash: "2 3", opacity: 0.6 });
      handle(0);
      handle(1);
      break;
    }
    case "fibFan": {
      FIB_FAN_LEVELS.forEach((lv) => {
        const yy = frame.y(fibPrice(d.points[0], d.points[1], lv));
        const color = lv === 0 ? undefined : FAN_ARC_COLORS[String(lv)];
        out.segments.push({ ...carry(xs[0], ys[0], xs[1], yy, frame, false), color });
        if (lv > 0) out.labels.push({ x: xs[1] + 4, y: yy - 3, text: `${(lv * 100).toFixed(1).replace(/\.0$/, "")}%`, anchor: "start", color });
      });
      // where the levels are read: at the second point's time
      out.segments.push({ x1: xs[1], y1: ys[1], x2: xs[1], y2: ys[0], dash: "2 3", opacity: 0.6 });
      handle(0);
      handle(1);
      break;
    }
    case "fibArc": {
      const len = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]);
      // bulging back toward the first point's price
      const up = ys[0] < ys[1];
      FIB_ARC_LEVELS.forEach((lv) => {
        const color = FAN_ARC_COLORS[String(lv)];
        out.arcs.push({ cx: xs[1], cy: ys[1], r: len * lv, up, color });
        out.labels.push({ x: xs[1], y: ys[1] + (up ? -len * lv - 3 : len * lv + 12), text: String(lv), anchor: "middle", color });
      });
      out.segments.push({ x1: xs[0], y1: ys[0], x2: xs[1], y2: ys[1], dash: "2 3", opacity: 0.6 });
      handle(0);
      handle(1);
      break;
    }
    case "rect": {
      const [x1, x2] = [Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])];
      const [y1, y2] = [Math.min(ys[0], ys[1]), Math.max(ys[0], ys[1])];
      out.areas.push({ points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], opacity: 0.15 });
      out.segments.push({ x1, y1, x2, y2: y1 }, { x1: x2, y1, x2, y2 }, { x1: x2, y1: y2, x2: x1, y2 }, { x1, y1: y2, x2: x1, y2: y1 });
      handle(0);
      handle(1);
      break;
    }
    case "text":
      out.labels.push({ x: xs[0], y: ys[0], text: d.text ?? "", anchor: "start" });
      handle(0);
      break;
    case "arrowUp":
    case "arrowDown":
      out.arrows.push({ x: xs[0], y: ys[0], up: d.tool === "arrowUp" });
      if (d.text) out.labels.push({ x: xs[0], y: d.tool === "arrowUp" ? ys[0] + 26 : ys[0] - 26, text: d.text, anchor: "middle" });
      handle(0);
      break;
    case "measure": {
      const m = measureOf(d.points[0], d.points[1], axis);
      const up = m.diff >= 0;
      const color = up ? "#2962FF" : "#F23645";
      const [x1, x2] = [Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])];
      const [y1, y2] = [Math.min(ys[0], ys[1]), Math.max(ys[0], ys[1])];
      out.areas.push({ points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], color, opacity: 0.15 });
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      // arrows across the box: up and down, and the way time went
      out.segments.push({ x1: cx, y1: ys[0], x2: cx, y2: ys[1], color }, { x1: xs[0], y1: cy, x2: xs[1], y2: cy, color });
      const lines = words.measure(m);
      const below = !up;
      lines.forEach((text, k) => {
        out.labels.push({
          x: cx,
          y: below ? y2 + 14 + k * 13 : y1 - 8 - (lines.length - 1 - k) * 13,
          text,
          anchor: "middle",
          color: "#FFFFFF",
          fill: color,
        });
      });
      handle(0);
      handle(1);
      break;
    }
    case "long":
    case "short": {
      const pos = positionOf(d);
      const [xe, xEnd] = [xs[0], xs[1]];
      const [x1, x2] = [Math.min(xe, xEnd), Math.max(xe, xEnd)];
      const ye = ys[0];
      const yt = frame.y(pos.target);
      const ys2 = frame.y(pos.stop);
      out.areas.push({ points: [[x1, ye], [x2, ye], [x2, yt], [x1, yt]], color: "#089981", opacity: 0.25 });
      out.areas.push({ points: [[x1, ye], [x2, ye], [x2, ys2], [x1, ys2]], color: "#F23645", opacity: 0.25 });
      out.segments.push({ x1, y1: ye, x2, y2: ye, color: "#787B86" });
      const w = words.position(pos);
      const cx = (x1 + x2) / 2;
      out.labels.push({ x: cx, y: yt + (yt < ye ? -8 : 16), text: w.target, anchor: "middle", color: "#FFFFFF", fill: "#089981" });
      out.labels.push({ x: cx, y: ys2 + (ys2 < ye ? -8 : 16), text: w.stop, anchor: "middle", color: "#FFFFFF", fill: "#F23645" });
      out.labels.push({ x: cx, y: ye + (yt < ye ? 16 : -8), text: w.ratio, anchor: "middle", color: "#FFFFFF", fill: "#787B86" });
      out.handles.push({ x: xe, y: ye, k: 0 }, { x: xEnd, y: yt, k: 1 }, { x: xEnd, y: ys2, k: 2 });
      break;
    }
  }
  return out;
};

// About how wide a text is in the chart's print: a Japanese character a
// full `size`, a letter or figure (monospace) 0.6 of it
export const textWidth = (text: string, size: number): number => {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) ?? 0) > 0xff ? 1 : 0.6;
  return w * size;
};

// ---- what a touch is on ---------------------------------------------------------------------

const distToSegment = (px: number, py: number, s: Segment): number => {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2)) : 0;
  return Math.hypot(px - (s.x1 + u * dx), py - (s.y1 + u * dy));
};

const inside = (px: number, py: number, poly: ReadonlyArray<[number, number]>): boolean => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi) hit = !hit;
  }
  return hit;
};

// How far a screen point is from a shape: 0 inside one of its areas (a
// rectangle, a channel, a measure, a position box), else the nearest line,
// text or arrow
export const distanceTo = (shape: Shape, px: number, py: number): number => {
  let best = Infinity;
  for (const s of shape.segments) best = Math.min(best, distToSegment(px, py, s));
  for (const a of shape.areas) if (inside(px, py, a.points)) return 0;
  for (const a of shape.arcs) {
    const onSide = a.up ? py <= a.cy + 1 : py >= a.cy - 1;
    if (onSide) best = Math.min(best, Math.abs(Math.hypot(px - a.cx, py - a.cy) - a.r));
  }
  for (const a of shape.arrows) best = Math.min(best, Math.hypot(px - a.x, py - (a.up ? a.y + 10 : a.y - 10)) - 10);
  for (const l of shape.labels) {
    // a text's box: about its length in the chart's print, above its baseline
    const w = Math.max(12, textWidth(l.text, 11));
    const x1 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
    if (px >= x1 - 2 && px <= x1 + w + 2 && py >= l.y - 14 && py <= l.y + 4) return 0;
  }
  return Math.max(0, best);
};

// The drawing under a screen point, the one drawn last (on top) first, if
// one is within `tolerance` pixels
export const drawingAt = (
  shapes: ReadonlyArray<{ id: string; shape: Shape }>,
  px: number,
  py: number,
  tolerance: number,
): string | null => {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (distanceTo(shapes[i].shape, px, py) <= tolerance) return shapes[i].id;
  }
  return null;
};

// The handle of a shape under a screen point, if one is within `tolerance`
export const handleAt = (shape: Shape, px: number, py: number, tolerance: number): number | null => {
  let best: number | null = null;
  let bestD = Infinity;
  for (const h of shape.handles) {
    const dd = Math.hypot(px - h.x, py - h.y);
    if (dd <= tolerance && dd < bestD) {
      best = h.k;
      bestD = dd;
    }
  }
  return best;
};

// ---- putting points down and moving them ----------------------------------------------------

// The magnet: a price put down near a bar's open, high, low or close is put
// on it (TradingView's weak magnet), or always on the nearest of them
// (its strong one)
export type MagnetMode = "off" | "weak" | "strong";
export const MAGNET_PX = 24;
export const snapPrice = (
  bar: { open: number; high: number; low: number; close: number } | undefined,
  price: number,
  mode: MagnetMode,
  pxPerPrice: number,
): number => {
  if (!bar || mode === "off") return price;
  let best = price;
  let bestD = Infinity;
  for (const v of [bar.open, bar.high, bar.low, bar.close]) {
    const dd = Math.abs(v - price);
    if (dd < bestD) {
      best = v;
      bestD = dd;
    }
  }
  if (mode === "weak" && bestD * pxPerPrice > MAGNET_PX) return price;
  return best;
};

// A drawing moved whole by a time and a price (a locked one stays)
export const moveDrawing = (d: Drawing, dt: number, dp: number): Drawing =>
  d.locked ? d : { ...d, points: d.points.map((pt) => ({ t: pt.t + dt, p: pt.p + dp })) };

// A drawing moved whole by `df` bars and a price (a locked one stays):
// each point that many bars on, so a line moved across a weekend keeps its
// shape in bars
export const shiftDrawing = (d: Drawing, axis: TimeAxis, df: number, dp: number): Drawing =>
  d.locked ? d : { ...d, points: d.points.map((pt) => ({ t: timeAtIndex(axis, indexAtTime(axis, pt.t) + df), p: pt.p + dp })) };

// A drawing with one of its points moved (a channel's third handle moves its
// parallel line; a position's second its target and length, its third its
// stop)
export const movePoint = (d: Drawing, k: number, pt: DrawingPoint): Drawing => {
  if (d.locked || k < 0 || k >= d.points.length) return d;
  const points = d.points.map((x, i) => (i === k ? { ...pt } : x));
  if ((d.tool === "long" || d.tool === "short") && k === 2) points[2] = { t: d.points[2].t, p: pt.p };
  return { ...d, points };
};

// A long or short position put down at `entry`: its target `dist` away the
// way it trades and its stop as far the other way, running `bars` bars on
export const positionPoints = (side: "long" | "short", entry: DrawingPoint, dist: number, endT: number): DrawingPoint[] => {
  const sign = side === "long" ? 1 : -1;
  return [entry, { t: endT, p: entry.p + sign * dist }, { t: entry.t, p: entry.p - sign * dist }];
};
