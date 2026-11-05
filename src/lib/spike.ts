// #395: a sharp rise or fall of the 1-hour bar on the chart — the same code
// the email decides with (supabase/functions/_shared/spike.ts; docs §8.138)
export * from "../../supabase/functions/_shared/spike";
import { SPIKE, spikeMarks, type SpikeRead } from "../../supabase/functions/_shared/spike";

export const SPIKE_HOUR_MS = 3_600_000;

export interface SpikeChartMark extends SpikeRead {
  // the bar, on the chart's candles
  i: number;
}

// The marks on the chart's candles: `past` the bars before them (oldest
// first), each candle read against the SPIKE.bars bars before it (from the
// past where the chart's own are too few); a candle with fewer before it gets none
export const spikeChartMarks = (
  past: ReadonlyArray<{ open: number; high: number; low: number }>,
  candles: ReadonlyArray<{ open: number; high: number; low: number }>,
): SpikeChartMark[] => {
  const all = [...past, ...candles].map((b) => ({ o: b.open, h: b.high, l: b.low }));
  return spikeMarks(all, SPIKE)
    .filter((m) => m.i >= past.length)
    .map((m) => ({ ...m, i: m.i - past.length }));
};
