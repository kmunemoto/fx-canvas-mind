import { useSyncExternalStore } from "react";
import { drawingListFrom, drawingsFrom, type Drawing, type DrawingsByPair } from "./drawings";

// #160: the drawings of every pair, kept in this browser — and, signed in,
// with the account (drawingsSync.ts), so another device opens the same
// lines. Per pair, as TradingView keeps them per symbol: a line drawn on the
// 1-hour chart is on the 4-hour one too.

export const DRAWINGS_KEY = "sextant.chart.drawings.v1";

let current: DrawingsByPair | null = null;
const listeners = new Set<() => void>();
const NONE: Drawing[] = [];

const read = (): DrawingsByPair => {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(DRAWINGS_KEY);
    return raw ? drawingsFrom(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
};

export const getDrawings = (): DrawingsByPair => (current ??= read());

export const pairDrawings = (pair: string): Drawing[] => getDrawings()[pair] ?? NONE;

const save = () => {
  try {
    localStorage.setItem(DRAWINGS_KEY, JSON.stringify(getDrawings()));
  } catch {
    // kept for this page only
  }
  listeners.forEach((l) => l());
};

// One pair's drawings, as they are now
export const setPairDrawings = (pair: string, list: ReadonlyArray<Drawing>): void => {
  current = { ...getDrawings(), [pair]: drawingListFrom(list) };
  save();
};

// The account's drawings of these pairs, taken as this browser's (the
// others kept as they are)
export const replacePairDrawings = (byPair: DrawingsByPair): void => {
  const next = { ...getDrawings() };
  for (const [pair, list] of Object.entries(drawingsFrom(byPair))) next[pair] = list;
  current = next;
  save();
};

export const subscribeDrawings = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const usePairDrawings = (pair: string): Drawing[] =>
  useSyncExternalStore(subscribeDrawings, () => pairDrawings(pair), () => NONE);

// Tests start each case from what storage holds
export const resetDrawingsCache = (): void => {
  current = null;
};
