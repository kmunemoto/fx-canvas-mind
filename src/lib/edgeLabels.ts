// #145: where labels by a candle go (Q-Trend's BUY / SELL / STRONG and the
// 3✓ badges): under the candle for a buy and over it for a sell, `off` px
// from it. One that does not fit there (a sell on a bar at the top of the
// plot was cut off) goes to the other side; one that would land on a label
// already placed (two a few bars apart printed one over the other) is moved
// a row further out, or to the other side of the candle when its own side
// is full — never onto the candle. All stay inside the plot. Placed in the
// order given; one with nowhere free keeps its first place.

export interface EdgeLabel {
  key: string;
  // the label's middle, and its candle's high and low, in px
  x: number;
  highY: number;
  lowY: number;
  w: number;
  h: number;
  off: number;
  buy: boolean;
}

export const placeEdgeLabels = (
  labels: ReadonlyArray<EdgeLabel>,
  plotTop: number,
  plotBottom: number,
): Map<string, { top: number; under: boolean }> => {
  const out = new Map<string, { top: number; under: boolean }>();
  const boxes: Array<{ left: number; top: number; w: number; h: number }> = [];
  for (const l of labels) {
    const left = l.x - l.w / 2;
    const below = l.lowY + l.off;
    const above = l.highY - l.off - l.h;
    const first = l.buy ? below + l.h <= plotBottom || above < plotTop : above < plotTop;
    const clampTop = (v: number) => Math.min(Math.max(v, plotTop), plotBottom - l.h);
    const side = (under: boolean) =>
      [0, 1, 2, 3].map((k) => ({ top: clampTop((under ? below : above) + k * (under ? 1 : -1) * (l.h + 2)), under }));
    const free = ({ top }: { top: number }) =>
      !boxes.some((o) => left < o.left + o.w + 1 && o.left < left + l.w + 1 && top < o.top + o.h + 1 && o.top < top + l.h + 1);
    const tries = [...side(first), ...side(!first)];
    const spot = tries.find(free) ?? tries[0];
    boxes.push({ left, top: spot.top, w: l.w, h: l.h });
    out.set(l.key, spot);
  }
  return out;
};
