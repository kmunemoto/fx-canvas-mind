// Pure outcome-evaluation logic for track-outcomes, kept Deno-free so the
// vitest suite can import it directly.

import type { Candle } from "../analyze/indicators.ts";

export interface OpenRow {
  id: string;
  pair: string;
  interval: string;
  signal: "BUY" | "SELL";
  entry_point: number;
  stop_loss: number;
  take_profit_1: number;
  created_at: string;
}

// Evaluation candles per plan timeframe: fine enough to order SL/TP touches,
// long enough (≈500 bars) to cover the plan's realistic lifetime.
export const EVAL_INTERVAL: Record<string, string> = {
  "15min": "15min",
  "1h": "1h",
  "4h": "4h",
  "1day": "1day",
};

// Days after which an undecided plan is closed as expired
export const EXPIRY_DAYS: Record<string, number> = {
  "15min": 5,
  "1h": 20,
  "4h": 60,
  "1day": 180,
};

export type Verdict = { outcome: "win" | "loss"; price: number; at: string } | null;

export const evaluatePlan = (row: OpenRow, candles: Candle[]): Verdict => {
  const created = Date.parse(row.created_at);

  for (const c of candles) {
    const t = Date.parse(c.datetime.includes("T") ? c.datetime : `${c.datetime.replace(" ", "T")}Z`);
    if (!Number.isFinite(t) || t < created) continue;

    const hitsTp = row.signal === "BUY" ? c.high >= row.take_profit_1 : c.low <= row.take_profit_1;
    const hitsSl = row.signal === "BUY" ? c.low <= row.stop_loss : c.high >= row.stop_loss;

    if (hitsTp && hitsSl) return null; // same candle spans both — undecidable
    if (hitsTp) return { outcome: "win", price: row.take_profit_1, at: c.datetime };
    if (hitsSl) return { outcome: "loss", price: row.stop_loss, at: c.datetime };
  }

  return null;
};
