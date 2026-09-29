// #116: which bars a chart shows while it is zoomed and panned.
//
// A view is `count` bars ending `offset` bars before the newest one. Offset 0
// follows the newest bar as new ones arrive (the live chart); null is every
// bar, the chart as it always was. The chart has only the bars it was given,
// so zooming out stops at all of them.
//
// #160: and `ahead`, room for that many bars to the right of the newest one,
// dragged into view past it (as TradingView's chart has room there), so a
// line can be drawn on into the time to come. Only with offset 0.

export interface ChartView {
  count: number;
  offset: number;
  ahead?: number;
}

// Fewer bars than this is a few candles filling the screen: no more reading
export const MIN_VISIBLE_BARS = 15;
// One press of ＋ or −
export const ZOOM_STEP = 1.5;
// One notch of the wheel
export const WHEEL_STEP = 1.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// #160: the most room past the newest bar: half the bars on screen (at least 10)
export const maxAhead = (count: number): number => Math.max(10, Math.round(count / 2));

// #160: the room past the newest bar, in bars
export const aheadOf = (n: number, view: ChartView | null): number => {
  if (!view || n <= 0) return 0;
  const { from, to } = visibleRange(n, view);
  return to < n ? 0 : clamp(Math.round(view.ahead ?? 0), 0, maxAhead(to - from));
};

// The view with this much room past the newest bar (none: no `ahead`)
const withAhead = (v: ChartView, ahead: number): ChartView => (ahead > 0 ? { ...v, ahead } : { count: v.count, offset: v.offset });

// The bars on screen, [from, to), out of n
export const visibleRange = (n: number, view: ChartView | null): { from: number; to: number } => {
  if (n <= 0) return { from: 0, to: 0 };
  if (!view) return { from: 0, to: n };
  const count = clamp(Math.round(view.count), Math.min(MIN_VISIBLE_BARS, n), n);
  const offset = clamp(Math.round(view.offset), 0, n - count);
  return { from: n - offset - count, to: n - offset };
};

// Zoomed by `factor` (above 1 shows fewer bars, below 1 more) about a point
// `at` of the way across the plot (0 its left edge, 1 its right edge): the
// bar under that point stays under it. Zooming out to every bar is null.
export const zoomView = (n: number, view: ChartView | null, factor: number, at = 1): ChartView | null => {
  if (n <= 0 || !Number.isFinite(factor) || factor <= 0) return view;
  const { from, to } = visibleRange(n, view);
  const count = to - from;
  const next = clamp(Math.round(count / factor), Math.min(MIN_VISIBLE_BARS, n), n);
  if (next >= n) return null;
  const a = clamp(at, 0, 1);
  const anchor = from + a * count;
  const nextFrom = Math.round(anchor - a * next);
  const offset = clamp(n - (nextFrom + next), 0, n - next);
  // the room past the newest bar stays while the newest bar does
  return withAhead({ count: next, offset }, offset === 0 ? Math.min(aheadOf(n, view), maxAhead(next)) : 0);
};

// Dragged `bars` bars to the right: older bars come in from the left. #160:
// dragged to the left past the newest bar, room opens to its right (up to
// maxAhead), even on a chart showing every bar; dragged back, it closes
// before older bars come in.
export const panView = (n: number, view: ChartView | null, bars: number): ChartView | null => {
  if (n <= 0 || !Number.isFinite(bars)) return view;
  if (!view && Math.round(bars) >= 0) return view;
  const { from, to } = visibleRange(n, view);
  const count = to - from;
  const pos = n - to - aheadOf(n, view) + Math.round(bars);
  const offset = clamp(pos, 0, n - count);
  return withAhead({ count, offset }, clamp(-pos, 0, maxAhead(count)));
};
