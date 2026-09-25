// #111: what the spread alone costs on each timeframe, and what a stop costs
// per 10,000 units.
//
// The share is the average, over both periods of the #106 study (§8.21), of
// the result of entering at EVERY bar with the app's exit (stop 0.8 ATR,
// target 1.5x), spread paid: with no timing at all, that is what the spread
// takes, as a fraction of the stop. 1min and 1day were not part of that
// study, so no number is given for them.
export const SPREAD_SHARE_OF_STOP: Record<string, number | null> = {
  "1min": null,
  "15min": 0.14,
  "1h": 0.08,
  "4h": 0.06,
  "1day": null,
};

// The loss if the stop is hit, per 10,000 units, in the pair's quote
// currency: yen for the yen crosses, dollars for the dollar pairs. Nothing
// is converted — a rate the app did not read would be a number it made up.
export const lossPer10k = (pair: string, entry: number, stop: number): { amount: number; currency: "JPY" | "USD" } | null => {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry === stop) return null;
  const quote = pair.toUpperCase().split("/")[1];
  if (quote !== "JPY" && quote !== "USD") return null;
  return { amount: Math.abs(entry - stop) * 10_000, currency: quote };
};

export const formatLoss = (x: { amount: number; currency: "JPY" | "USD" }): string =>
  x.currency === "JPY" ? `¥${Math.round(x.amount).toLocaleString("ja-JP")}` : `$${x.amount.toFixed(2)}`;
