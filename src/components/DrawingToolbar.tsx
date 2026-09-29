import { useState, type ReactNode } from "react";
import { ChevronDown, Copy, Eye, EyeOff, Lock, LockOpen, Magnet, PencilLine, Redo2, Trash2, Type, Undo2, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { DRAWING_COLORS, DRAWING_WIDTHS, LINE_STYLES, TOOL_GROUPS, type Drawing, type DrawingTool, type LineStyle, type MagnetMode } from "@/lib/drawings";

// #160: the drawing tools' bar (the tools, as TradingView's and iSPEED FX's
// menus have them, and the magnet, "stay in drawing mode", hide, undo and
// delete all), and the bar a selected drawing gets (its colour, width,
// line, text, lock, a copy, delete). The chart holds what is drawn and
// what is chosen; these only show it and say what was pressed.

// Each tool's icon, drawn as its drawing looks
const ICON: Record<DrawingTool, ReactNode> = {
  trend: (
    <>
      <line x1="4" y1="16" x2="16" y2="4" />
      <circle cx="4" cy="16" r="1.8" />
      <circle cx="16" cy="4" r="1.8" />
    </>
  ),
  ray: (
    <>
      <line x1="4" y1="15" x2="19" y2="3" />
      <circle cx="4" cy="15" r="1.8" />
      <circle cx="10" cy="10.2" r="1.8" />
    </>
  ),
  extended: (
    <>
      <line x1="1" y1="17" x2="19" y2="3" />
      <circle cx="7" cy="12.3" r="1.8" />
      <circle cx="13" cy="7.7" r="1.8" />
    </>
  ),
  hline: (
    <>
      <line x1="1" y1="10" x2="19" y2="10" />
      <circle cx="10" cy="10" r="1.8" />
    </>
  ),
  hray: (
    <>
      <line x1="6" y1="10" x2="19" y2="10" />
      <circle cx="6" cy="10" r="1.8" />
    </>
  ),
  vline: (
    <>
      <line x1="10" y1="1" x2="10" y2="19" />
      <circle cx="10" cy="10" r="1.8" />
    </>
  ),
  channel: (
    <>
      <line x1="2" y1="13" x2="14" y2="4" />
      <line x1="6" y1="17" x2="18" y2="8" />
      <line x1="4" y1="15" x2="16" y2="6" strokeDasharray="1.5 2" />
    </>
  ),
  fib: (
    <>
      <line x1="2" y1="3" x2="18" y2="3" />
      <line x1="2" y1="8" x2="18" y2="8" />
      <line x1="2" y1="12" x2="18" y2="12" />
      <line x1="2" y1="17" x2="18" y2="17" />
      <line x1="3" y1="17" x2="17" y2="3" strokeDasharray="1.5 2" />
    </>
  ),
  fibTime: (
    <>
      <line x1="3" y1="3" x2="3" y2="17" />
      <line x1="6" y1="3" x2="6" y2="17" />
      <line x1="9" y1="3" x2="9" y2="17" />
      <line x1="13" y1="3" x2="13" y2="17" />
      <line x1="19" y1="3" x2="19" y2="17" />
    </>
  ),
  fibFan: (
    <>
      <line x1="3" y1="17" x2="18" y2="3" />
      <line x1="3" y1="17" x2="18" y2="8" />
      <line x1="3" y1="17" x2="18" y2="12" />
      <circle cx="3" cy="17" r="1.6" />
    </>
  ),
  fibArc: (
    <>
      <path d="M4 16 A 7 7 0 0 1 18 16" />
      <path d="M8 16 A 3.5 3.5 0 0 1 14 16" />
      <line x1="11" y1="16" x2="4" y2="3" strokeDasharray="1.5 2" />
    </>
  ),
  rect: <rect x="3" y="5" width="14" height="10" rx="1" />,
  text: <path d="M5 5 H15 M10 5 V16" />,
  arrowUp: <path d="M10 3 L15 9 H12 V17 H8 V9 H5 Z" />,
  arrowDown: <path d="M10 17 L15 11 H12 V3 H8 V11 H5 Z" />,
  measure: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1" strokeDasharray="1.5 2" />
      <line x1="10" y1="6" x2="10" y2="14" />
      <path d="M7.5 8.5 L10 6 L12.5 8.5" />
    </>
  ),
  long: (
    <>
      <rect x="3" y="3" width="14" height="7" fill="currentColor" fillOpacity="0.25" />
      <rect x="3" y="10" width="14" height="5" />
      <path d="M6 8 L10 4.5 L14 8" />
    </>
  ),
  short: (
    <>
      <rect x="3" y="5" width="14" height="5" />
      <rect x="3" y="10" width="14" height="7" fill="currentColor" fillOpacity="0.25" />
      <path d="M6 12 L10 15.5 L14 12" />
    </>
  ),
};

export const ToolIcon = ({ tool }: { tool: DrawingTool }) => (
  <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICON[tool]}
  </svg>
);

const StyleIcon = ({ style }: { style: LineStyle }) => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="2" y1="10" x2="18" y2="10" strokeDasharray={style === "dashed" ? "5 3" : style === "dotted" ? "0.5 3.5" : undefined} />
  </svg>
);

const btn = "flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-30";
const on = "bg-primary/15 text-primary";

interface BarProps {
  tool: DrawingTool | null;
  onTool: (t: DrawingTool | null) => void;
  magnet: MagnetMode;
  onMagnet: () => void;
  keep: boolean;
  onKeep: () => void;
  hidden: boolean;
  onHidden: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  count: number;
  onClear: () => void;
  onClose: () => void;
  // what to do next with the tool chosen (how many taps), or how to start
  hint: string;
  // the tools' list opens upward (full screen's bar sits at the bottom)
  dropUp?: boolean;
}

export const DrawingBar = ({ tool, onTool, magnet, onMagnet, keep, onKeep, hidden, onHidden, canUndo, canRedo, onUndo, onRedo, count, onClear, onClose, hint, dropUp = false }: BarProps) => {
  const t = useT();
  const w = t.chart.draw;
  // deleting every drawing asks once more, in the bar
  const [confirming, setConfirming] = useState(false);
  // the tools, listed under the button that names the one chosen (open
  // when the bar opens with none chosen) — over the chart, so it does not
  // move when the list closes; on a phone a row of 18 did not fit
  const [picking, setPicking] = useState(tool === null);
  return (
    <div className="relative space-y-1 rounded-lg border border-border bg-background/95 p-1" data-testid="chart-draw-bar">
      <div className="flex items-center gap-0.5" role="toolbar" aria-label={w.title}>
        <button
          type="button"
          aria-expanded={picking}
          aria-label={w.pick}
          title={w.pick}
          onClick={() => setPicking((v) => !v)}
          data-testid="chart-draw-picker"
          className={`flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-1 text-xs ${tool ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-foreground"}`}
        >
          {tool ? <ToolIcon tool={tool} /> : <PencilLine className="h-4 w-4" />}
          <span className="truncate">{tool ? w.short[tool] : w.pickShort}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            aria-pressed={magnet !== "off"}
            aria-label={`${w.magnet}: ${w.magnetModes[magnet]}`}
            title={`${w.magnet}: ${w.magnetModes[magnet]}`}
            onClick={onMagnet}
            data-testid="chart-draw-magnet"
            data-mode={magnet}
            className={`${btn} relative ${magnet !== "off" ? on : ""}`}
          >
            <Magnet className="h-4 w-4" />
            {magnet !== "off" && <span className="absolute -bottom-0.5 right-0 text-[8px] font-bold leading-none">{w.magnetModes[magnet]}</span>}
          </button>
          <button
            type="button"
            aria-pressed={keep}
            aria-label={w.keep}
            title={w.keep}
            onClick={onKeep}
            data-testid="chart-draw-keep"
            className={`${btn} ${keep ? on : ""}`}
          >
            <PencilLine className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-pressed={hidden}
            aria-label={hidden ? w.showAll : w.hideAll}
            title={hidden ? w.showAll : w.hideAll}
            onClick={onHidden}
            data-testid="chart-draw-hide"
            className={`${btn} ${hidden ? on : ""}`}
          >
            {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <button type="button" aria-label={w.undo} title={w.undo} onClick={onUndo} disabled={!canUndo} data-testid="chart-draw-undo" className={btn}>
            <Undo2 className="h-4 w-4" />
          </button>
          <button type="button" aria-label={w.redo} title={w.redo} onClick={onRedo} disabled={!canRedo} data-testid="chart-draw-redo" className={btn}>
            <Redo2 className="h-4 w-4" />
          </button>
          <button type="button" aria-label={w.clearAll} title={w.clearAll} onClick={() => setConfirming(true)} disabled={count === 0} data-testid="chart-draw-clear" className={btn}>
            <Trash2 className="h-4 w-4" />
          </button>
          <button type="button" aria-label={w.close} title={w.close} onClick={onClose} data-testid="chart-draw-close" className={btn}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center justify-end gap-1 px-1" data-testid="chart-draw-clear-confirm">
          <span className="text-[11px] text-muted-foreground">{w.clearAsk}</span>
          <button
            type="button"
            onClick={() => {
              onClear();
              setConfirming(false);
            }}
            data-testid="chart-draw-clear-yes"
            className="rounded-md bg-destructive px-2 py-1 text-[11px] font-semibold text-destructive-foreground"
          >
            {w.clearYes(count)}
          </button>
          <button type="button" onClick={() => setConfirming(false)} data-testid="chart-draw-clear-no" className="rounded-md border border-border px-2 py-1 text-[11px]">
            {w.clearNo}
          </button>
        </div>
      )}
      {picking && (
        <div
          className={`absolute inset-x-0 z-40 max-h-[60vh] space-y-1 overflow-y-auto rounded-lg border border-border bg-background p-1.5 shadow-xl ${dropUp ? "bottom-full mb-1" : "top-full mt-1"}`}
          data-testid="chart-draw-tools"
        >
          {TOOL_GROUPS.map((g) => (
            <section key={g.key} className="space-y-0.5">
              <h4 className="text-[10px] text-muted-foreground">{w.groups[g.key]}</h4>
              <div className="flex flex-wrap gap-0.5">
                {g.tools.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={tool === k}
                    aria-label={w.tools[k]}
                    title={w.tools[k]}
                    onClick={() => {
                      onTool(tool === k ? null : k);
                      setPicking(false);
                    }}
                    data-testid={`chart-draw-tool-${k}`}
                    className={`${btn} w-[3.6rem] flex-col gap-0.5 px-0.5 ${tool === k ? on : ""}`}
                  >
                    <ToolIcon tool={k} />
                    <span className="w-full truncate text-center text-[9px] leading-none">{w.short[k]}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <p className="px-1 text-[10px] leading-snug text-muted-foreground" data-testid="chart-draw-hint">
        {hint}
      </p>
    </div>
  );
};

interface SelectedProps {
  d: Drawing;
  onChange: (patch: Partial<Drawing>) => void;
  onCopy: () => void;
  onDelete: () => void;
  onClose: () => void;
  // the text field open (a text is put down with it open)
  editing: boolean;
  onEditing: (v: boolean) => void;
}

// the tools a text belongs to (a text's words, and an arrow's note)
const HAS_TEXT: ReadonlyArray<DrawingTool> = ["text", "arrowUp", "arrowDown"];

export const SelectedBar = ({ d, onChange, onCopy, onDelete, onClose, editing, onEditing }: SelectedProps) => {
  const t = useT();
  const w = t.chart.draw;
  const [colors, setColors] = useState(false);
  const nextWidth = DRAWING_WIDTHS[(DRAWING_WIDTHS.indexOf(d.width) + 1) % DRAWING_WIDTHS.length];
  const nextStyle = LINE_STYLES[(LINE_STYLES.indexOf(d.style) + 1) % LINE_STYLES.length];
  const locked = d.locked === true;
  return (
    <div className="pointer-events-auto flex max-w-full flex-col items-center gap-1" data-testid="chart-draw-selected">
      {colors && !locked && (
        <div className="flex flex-wrap justify-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow" data-testid="chart-draw-colors">
          {DRAWING_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              aria-pressed={d.color.toUpperCase() === c}
              onClick={() => {
                onChange({ color: c });
                setColors(false);
              }}
              data-testid={`chart-draw-color-${c.slice(1)}`}
              className={`h-6 w-6 rounded-full border ${d.color.toUpperCase() === c ? "ring-2 ring-primary" : "border-border"}`}
              style={{ background: c }}
            />
          ))}
        </div>
      )}
      {editing && !locked && HAS_TEXT.includes(d.tool) && (
        <input
          autoFocus
          type="text"
          maxLength={200}
          defaultValue={d.text ?? ""}
          placeholder={w.textPlaceholder}
          aria-label={w.text}
          // the words a text starts with selected, so typing takes their place
          onFocus={(e) => {
            if (e.currentTarget.value === w.defaultText) e.currentTarget.select();
          }}
          onChange={(e) => onChange({ text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") onEditing(false);
            // the chart's keys (Delete, Esc) are not for the text
            e.stopPropagation();
          }}
          data-testid="chart-draw-text-input"
          className="w-56 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
      )}
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/95 p-0.5 shadow" role="toolbar" aria-label={w.tools[d.tool]}>
        <span className="max-w-[5rem] truncate px-1 text-[10px] text-muted-foreground" title={w.tools[d.tool]} data-testid="chart-draw-selected-name">
          {w.short[d.tool]}
        </span>
        <button
          type="button"
          aria-label={w.color}
          title={w.color}
          disabled={locked}
          onClick={() => setColors((v) => !v)}
          data-testid="chart-draw-color"
          className={btn}
        >
          <span className="h-4 w-4 rounded-full border border-border" style={{ background: d.color }} />
        </button>
        <button
          type="button"
          aria-label={`${w.width}: ${d.width}px`}
          title={`${w.width}: ${d.width}px`}
          disabled={locked}
          onClick={() => onChange({ width: nextWidth })}
          data-testid="chart-draw-width"
          className={`${btn} gap-0.5 text-[10px] font-mono`}
        >
          <span className="inline-block w-3 rounded" style={{ height: d.width, background: "currentColor" }} />
          {d.width}
        </button>
        <button
          type="button"
          aria-label={`${w.style}: ${w.styles[d.style]}`}
          title={`${w.style}: ${w.styles[d.style]}`}
          disabled={locked}
          onClick={() => onChange({ style: nextStyle })}
          data-testid="chart-draw-style"
          data-style={d.style}
          className={btn}
        >
          <StyleIcon style={d.style} />
        </button>
        {HAS_TEXT.includes(d.tool) && (
          <button
            type="button"
            aria-pressed={editing}
            aria-label={w.text}
            title={w.text}
            disabled={locked}
            onClick={() => onEditing(!editing)}
            data-testid="chart-draw-text"
            className={`${btn} ${editing ? on : ""}`}
          >
            <Type className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          aria-pressed={locked}
          aria-label={locked ? w.unlock : w.lock}
          title={locked ? w.unlock : w.lock}
          onClick={() => onChange({ locked: !locked })}
          data-testid="chart-draw-lock"
          className={`${btn} ${locked ? on : ""}`}
        >
          {locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
        </button>
        <button type="button" aria-label={w.copy} title={w.copy} onClick={onCopy} data-testid="chart-draw-copy" className={btn}>
          <Copy className="h-4 w-4" />
        </button>
        <button type="button" aria-label={w.remove} title={w.remove} onClick={onDelete} data-testid="chart-draw-delete" className={`${btn} hover:text-destructive`}>
          <Trash2 className="h-4 w-4" />
        </button>
        <button type="button" aria-label={w.deselect} title={w.deselect} onClick={onClose} data-testid="chart-draw-deselect" className={btn}>
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
