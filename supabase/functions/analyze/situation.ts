// Which learned rules fit the market in front of us right now.
//
// A rule in the rulebook cites the plans it was drawn from (`supported_by`),
// and every one of those plans kept the indicator snapshot the analyst was
// looking at when it was made (`analyses.context.entry` / `.higher`). So the
// situations a rule was learned in are not a matter of opinion: they are on
// disk, and the range they span can be measured. That measured range is the
// rule's FOOTPRINT, and comparing today's reading against it is the whole of
// what this module does.
//
// The alternative was to ask the model to write a condition next to each rule
// it emits. That was rejected for the reason this project keeps rejecting it:
// a model-authored condition is a claim, and claims here have a habit of
// outrunning their evidence. The live book already shows it. Rule r10 says
// "ADX above 60, RSI around 10" — and one of its four measurable citations
// sits at ADX 39, RSI 25.8. Reading the condition off the citations cannot
// drift from them, because it IS them.
//
// Two properties are load-bearing:
//
//   - The same axes are computed from a live snapshot and from a stored one,
//     by the same function, because both are the same shape. A rule's evidence
//     and today's market are never described in two vocabularies.
//   - A footprint too thin or too wide to discriminate returns "unknown", not
//     a verdict. A range spanning ADX 39 to 75 matches nearly any market;
//     calling that a match would be the computed-verdict-outruns-its-evidence
//     failure wearing a new hat.
//
// One consequence of the first property is worth stating plainly, because it
// cuts against a rule this project keeps elsewhere. Structure and its breaks
// are computed on CLOSED bars only, since a break is a discrete event a
// forming bar can fake. These axes are NOT: they read the same forming-bar
// snapshot the row has always stored. That is not an oversight — the stored
// evidence is forming-bar readings and nothing else was ever kept, so reading
// closed bars live would compare a closed-bar present against a forming-bar
// past, which is worse than comparing like with like. The axes are also
// continuous levels rather than events, and the tolerances (10 ADX, 8 RSI,
// one ATR) are wide next to what a part-formed bar moves them by. If the
// closed-bar snapshots ever reach the row, both sides should move together.
//
// Deno-free on purpose: the vitest suite imports this file directly and runs
// it against snapshots pulled from real rows.

// The shape `analyze` writes into `analyses.context.entry` and each element of
// `.higher` (see `compactSnapshot` in index.ts), read back defensively — these
// rows were written by builds going back months and a missing key must not
// throw. Only the fields the axes need are named.
export interface SnapshotLike {
  price?: unknown;
  sma20?: unknown;
  atr?: unknown;
  adx?: unknown;
  rsi?: unknown;
  bb_upper?: unknown;
  bb_lower?: unknown;
}

// One analysis's decision-time reading: the timeframe traded, plus the
// timeframes above it. `higher[0]` is the next one up, which is the one the
// multi-timeframe axis asks about.
export interface ContextLike {
  entry?: SnapshotLike | null;
  higher?: SnapshotLike[] | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Stored numbers arrive as numbers, but a row written by an older build can
// carry a string or a null; anything not finite is "not measured", never 0.
const numOf = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// The axes. Few, numeric, and each one something a rule in the live book
// actually turns on: trend strength, momentum extreme, how far price has run
// from its mean, where it sits in its band, and whether the timeframe above
// agrees. `tolerance` is in the axis's own unit and widens a footprint into
// the band where "close enough to count" lives.
//
// Every axis is deliberately SCALE-FREE — dimensionless (ADX, RSI) or divided
// by something that carries the timeframe's scale (ATR, the band's own width).
// That is not decoration: rules cite plans from several timeframes at once
// (r10 cites both 1h and 1day plans), so an axis carrying a price or a pip
// count would compare a daily range against an hourly one and call the
// difference a change of situation. It also means a footprint says nothing
// about WHICH timeframe its evidence came from, which is a real limit and is
// recorded as one rather than papered over with a timeframe axis that would,
// on the evidence available today, leave nothing comparable at all.
export interface Axis {
  key: string;
  // Rendered in the prompt when a mismatch has to be named
  label_ja: string;
  label_en: string;
  tolerance: number;
  of: (ctx: ContextLike) => number | null;
}

const entryOf = (ctx: ContextLike): SnapshotLike | null =>
  isRecord(ctx.entry) ? (ctx.entry as SnapshotLike) : null;

const higherOf = (ctx: ContextLike): SnapshotLike | null => {
  const list = Array.isArray(ctx.higher) ? ctx.higher : [];
  const first = list.find((s) => isRecord(s));
  return first ? (first as SnapshotLike) : null;
};

export const AXES: Axis[] = [
  {
    key: "adx",
    label_ja: "ADX",
    label_en: "ADX",
    tolerance: 10,
    of: (ctx) => numOf(entryOf(ctx)?.adx),
  },
  {
    key: "rsi",
    label_ja: "RSI",
    label_en: "RSI",
    tolerance: 8,
    of: (ctx) => numOf(entryOf(ctx)?.rsi),
  },
  {
    // Signed on purpose: five ATR below the mean and five above are opposite
    // situations, and a rule learned in one does not transfer to the other.
    key: "stretch",
    label_ja: "SMA20乖離(ATR倍)",
    label_en: "SMA20 distance (ATR)",
    tolerance: 1,
    of: (ctx) => {
      const s = entryOf(ctx);
      const price = numOf(s?.price);
      const sma20 = numOf(s?.sma20);
      const atr = numOf(s?.atr);
      if (price === null || sma20 === null || atr === null || atr <= 0) return null;
      return (price - sma20) / atr;
    },
  },
  {
    // 0 at the lower band, 1 at the upper; outside the band goes past either
    // end, which is exactly the reading the "walked out of the band" rules
    // were learned in.
    key: "bb_pos",
    label_ja: "BB内の位置",
    label_en: "position in Bollinger band",
    tolerance: 0.25,
    of: (ctx) => {
      const s = entryOf(ctx);
      const price = numOf(s?.price);
      const upper = numOf(s?.bb_upper);
      const lower = numOf(s?.bb_lower);
      if (price === null || upper === null || lower === null) return null;
      const width = upper - lower;
      if (!(width > 0)) return null;
      return (price - lower) / width;
    },
  },
  {
    key: "htf_adx",
    label_ja: "上位足ADX",
    label_en: "higher-timeframe ADX",
    tolerance: 10,
    of: (ctx) => numOf(higherOf(ctx)?.adx),
  },
];

// A footprint axis needs at least this many measured cases before its range
// means anything. One case is a point, not a range: it cannot say what the
// rule does or does not cover, and dressing it up as a range would invent
// evidence the rule does not have.
export const MIN_FOOTPRINT_CASES = 2;
// A range wider than this many tolerances no longer discriminates: it would
// mark nearly any market as a match, which reads as a finding and is not one.
// Such an axis is reported as `wide` and excluded from the verdict.
export const WIDE_FACTOR = 3;

export interface AxisFootprint {
  min: number;
  max: number;
  // How many of the rule's cited plans actually had this axis measured
  n: number;
  // Too wide to tell situations apart
  wide: boolean;
}

export interface Footprint {
  // Per axis key; an axis absent here was never measured on any cited plan
  axes: Record<string, AxisFootprint>;
  // Cited plans whose snapshot could be read at all
  cases: number;
  // Cited plans in total, including those with nothing stored to read. The
  // gap between the two is the part of a rule's support the footprint could
  // not see, and it is reported rather than quietly dropped.
  cited: number;
}

// The measured range of each axis across the plans a rule was drawn from.
export const footprintOf = (contexts: ContextLike[], cited = contexts.length): Footprint => {
  const axes: Record<string, AxisFootprint> = {};
  for (const axis of AXES) {
    let min = Infinity;
    let max = -Infinity;
    let n = 0;
    for (const ctx of contexts) {
      const v = axis.of(ctx);
      if (v === null) continue;
      n += 1;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (n === 0) continue;
    axes[axis.key] = { min, max, n, wide: max - min > WIDE_FACTOR * axis.tolerance };
  }
  return { axes, cases: contexts.length, cited };
};

// Per-axis comparison of today against a footprint.
//   in       today's reading is inside the range the rule was learned in
//   near     outside it, but within one tolerance of it
//   out      further away than that
//   thin     the footprint has too few cases on this axis to say
//   wide     the footprint's range on this axis is too broad to discriminate
//   unknown  today's reading is not available
export type AxisMatch = "in" | "near" | "out" | "thin" | "wide" | "unknown";

export const matchAxis = (
  axis: Axis,
  print: AxisFootprint | undefined,
  now: number | null,
): AxisMatch => {
  if (print === undefined || print.n < MIN_FOOTPRINT_CASES) return "thin";
  if (print.wide) return "wide";
  if (now === null) return "unknown";
  if (now >= print.min && now <= print.max) return "in";
  if (now >= print.min - axis.tolerance && now <= print.max + axis.tolerance) return "near";
  return "out";
};

// The verdict for one rule.
//   match    every axis that could be compared puts today inside or beside
//            the rule's evidence
//   off      at least one comparable axis puts today outside it
//   unknown  fewer than two axes could be compared at all — the honest answer
//            when the evidence is too thin, too wide, or too old to say
export type RuleFit = "match" | "off" | "unknown";

// Two axes agreeing is a weak signal, but one axis agreeing is noise: a single
// comparable axis would let "RSI is in the same band" pass for "this is the
// same situation".
export const MIN_COMPARABLE_AXES = 2;

export interface RuleSituation {
  fit: RuleFit;
  // Per axis, what the comparison found — kept whole so the reason a rule was
  // called off is recoverable from the stored plan, not just the verdict
  axes: Record<string, AxisMatch>;
  // Axes that actually counted toward the verdict
  comparable: string[];
  // Comparable axes that came out `out`, in the order the axes are declared —
  // this is what the prompt names when it says a rule does not fit
  missed: string[];
  cases: number;
  cited: number;
}

export const situationFor = (print: Footprint, now: ContextLike): RuleSituation => {
  const axes: Record<string, AxisMatch> = {};
  const comparable: string[] = [];
  const missed: string[] = [];
  for (const axis of AXES) {
    const verdict = matchAxis(axis, print.axes[axis.key], axis.of(now));
    axes[axis.key] = verdict;
    if (verdict === "in" || verdict === "near" || verdict === "out") {
      comparable.push(axis.key);
      if (verdict === "out") missed.push(axis.key);
    }
  }
  const fit: RuleFit = comparable.length < MIN_COMPARABLE_AXES
    ? "unknown"
    : missed.length === 0
      ? "match"
      : "off";
  return { fit, axes, comparable, missed, cases: print.cases, cited: print.cited };
};

// Today's reading, in the same shape a stored plan carries, so the live path
// and the replay path go through one function. `higher` keeps only what the
// axes read.
export const contextFrom = (
  entry: SnapshotLike | null,
  higher: SnapshotLike[] = [],
): ContextLike => ({ entry, higher });

// Read a stored `analyses.context` jsonb into the shape the axes want.
// Anything malformed becomes an empty context, which measures nothing and is
// counted as a case the footprint could not see.
export const contextFromStored = (value: unknown): ContextLike => {
  if (!isRecord(value)) return { entry: null, higher: [] };
  const entry = isRecord(value.entry) ? (value.entry as SnapshotLike) : null;
  const higher = Array.isArray(value.higher)
    ? value.higher.filter((s): s is SnapshotLike => isRecord(s))
    : [];
  return { entry, higher };
};

// Whether a context carries anything the axes can read. A stored plan from
// before the snapshot existed reads as empty here, and is excluded from the
// footprint's case count rather than counted as a case that measured nothing.
export const hasReading = (ctx: ContextLike): boolean =>
  AXES.some((axis) => axis.of(ctx) !== null);

// A rule with nothing to compare against: no citations, or no cited plan kept
// a snapshot to read. Deliberately distinct from a rule that was compared and
// ruled out — the prompt says "cannot compare", and the ordering puts it above
// the rules we actually measured as belonging to another market.
export const UNCOMPARED: RuleSituation = {
  fit: "unknown",
  axes: {},
  comparable: [],
  missed: [],
  cases: 0,
  cited: 0,
};
