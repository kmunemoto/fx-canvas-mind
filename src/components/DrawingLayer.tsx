import { DASH_OF, textWidth, type Drawing, type Shape } from "@/lib/drawings";

// #160: the drawings over the price, inside the plot (the chart clips them
// to it), from their shapes (lib/drawings.ts shapeOf). The chart puts the
// prices of a horizontal line and of a selected drawing's points on its
// axes itself. Nothing here takes a touch: the chart finds what a touch is
// on from the same shapes.

interface Item {
  d: Drawing;
  shape: Shape;
}

interface Props {
  items: ReadonlyArray<Item>;
  selectedId: string | null;
  // the drawing being put down, drawn as it will be
  draft: Item | null;
  clipId: string;
  fontSize: number;
  // a handle's radius (larger for a finger)
  handleR: number;
  // the plot's left and right, which a boxed label stays inside
  left: number;
  right: number;
}

// an arrow mark's outline, its tip at (x, y): pointing up from below the
// point, or down from above it
const arrowPath = (x: number, y: number, up: boolean) => {
  const s = up ? 1 : -1;
  const p = (dx: number, dy: number) => `${x + dx},${y + s * dy}`;
  return `M${p(0, 0)} L${p(-8, 10)} L${p(-3.5, 10)} L${p(-3.5, 22)} L${p(3.5, 22)} L${p(3.5, 10)} L${p(8, 10)} Z`;
};

const one = ({ d, shape }: Item, key: string, fontSize: number, selected: boolean, handleR: number, testid: string, left: number, right: number) => {
  const dash = DASH_OF[d.style];
  const textSize = d.tool === "text" ? fontSize * 1.35 : fontSize;
  return (
    <g key={key} data-testid={testid} data-tool={d.tool} data-selected={selected ? "true" : undefined}>
      {shape.areas.map((a, k) => (
        <polygon key={`a${k}`} points={a.points.map(([x, y]) => `${x},${y}`).join(" ")} fill={a.color ?? d.color} opacity={a.opacity} />
      ))}
      {/* a selected drawing is lit from behind, so it can be told from the rest */}
      {selected &&
        shape.segments.map((s, k) => (
          <line key={`h${k}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color ?? d.color} strokeWidth={(s.width ?? d.width) + 6} opacity={0.18} strokeLinecap="round" />
        ))}
      {shape.segments.map((s, k) => (
        <line
          key={`s${k}`}
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
          stroke={s.color ?? d.color}
          strokeWidth={s.width ?? d.width}
          strokeDasharray={s.dash ?? dash}
          opacity={s.opacity ?? 1}
          strokeLinecap="round"
        />
      ))}
      {shape.arcs.map((a, k) => (
        <path
          key={`c${k}`}
          d={`M${a.cx - a.r},${a.cy} A${a.r},${a.r} 0 0 ${a.up ? 1 : 0} ${a.cx + a.r},${a.cy}`}
          fill="none"
          stroke={a.color ?? d.color}
          strokeWidth={d.width}
          strokeDasharray={dash}
        />
      ))}
      {shape.arrows.map((a, k) => (
        <path key={`r${k}`} d={arrowPath(a.x, a.y, a.up)} fill={d.color} stroke="hsl(var(--background))" strokeWidth="0.8" />
      ))}
      {shape.labels.map((l, k) => {
        if (l.fill) {
          const w = textWidth(l.text, fontSize) + 10;
          const x0 = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
          // inside the plot, where the chart would cut it
          const x = Math.max(left + 1, Math.min(right - w - 1, x0));
          return (
            <g key={`l${k}`}>
              <rect x={x} y={l.y - fontSize - 2} width={w} height={fontSize + 6} rx="3" fill={l.fill} opacity="0.92" />
              <text x={x + w / 2} y={l.y} fontSize={fontSize} fill={l.color ?? "#fff"} fontFamily="monospace" textAnchor="middle">
                {l.text}
              </text>
            </g>
          );
        }
        return (
          <text
            key={`l${k}`}
            x={l.x}
            y={l.y + (d.tool === "fib" ? fontSize * 0.35 : 0)}
            fontSize={textSize}
            fontWeight={d.tool === "text" ? 600 : undefined}
            fill={l.color ?? d.color}
            fontFamily={d.tool === "text" ? undefined : "monospace"}
            textAnchor={l.anchor}
            // readable over the candles
            stroke="hsl(var(--background))"
            strokeWidth={d.tool === "text" ? 3 : 2.5}
            paintOrder="stroke"
            strokeLinejoin="round"
          >
            {l.text}
          </text>
        );
      })}
      {selected &&
        shape.handles.map((h) => (
          <circle
            key={`k${h.k}`}
            cx={h.x}
            cy={h.y}
            r={handleR}
            fill="hsl(var(--background))"
            stroke={d.color}
            strokeWidth="1.8"
            data-testid={`chart-drawing-handle-${h.k}`}
          />
        ))}
    </g>
  );
};

const DrawingLayer = ({ items, selectedId, draft, clipId, fontSize, handleR, left, right }: Props) => (
  <g clipPath={`url(#${clipId})`} data-testid="chart-drawings" pointerEvents="none">
    {items.map((it) => one(it, it.d.id, fontSize, it.d.id === selectedId, handleR, `chart-drawing-${it.d.id}`, left, right))}
    {draft && one(draft, "draft", fontSize, true, handleR, "chart-drawing-draft", left, right)}
  </g>
);

export default DrawingLayer;
