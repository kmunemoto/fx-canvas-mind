import type { AnalysisResult } from "./types";

// The server writes "Not detected" as the empty value
export const stopHuntOf = (result: AnalysisResult): string | null =>
  result.stop_hunt_zone && result.stop_hunt_zone !== "Not detected" ? result.stop_hunt_zone : null;

// Whether there is anything to open the "market context and levels"
// disclosure for
export const hasMarketContext = (result: AnalysisResult): boolean =>
  !!result.market_context_detail || !!result.market_context ||
  (Array.isArray(result.support_levels) && result.support_levels.length > 0) ||
  (Array.isArray(result.resistance_levels) && result.resistance_levels.length > 0) ||
  stopHuntOf(result) !== null;
