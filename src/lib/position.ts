// How much to trade, given how far away the stop is.
//
// The settings panel used to offer "stop width" and "target width" in pips.
// Those two numbers were never sent anywhere — the analyzer derives the stop
// from ATR and structure and the entry gate enforces its own bounds, so a
// fixed 30/60 could not have been honoured even if it had been wired up. A
// single width is also wrong on its face: 30 pips is a wide stop on a 15min
// plan and a very tight one on a daily.
//
// What genuinely belongs to the trader is the other half of the decision:
// the market sets the distance, you set the size. Given the balance and the
// share of it you are willing to lose on one trade, this turns the plan's own
// stop distance into a position size.

export interface PositionInput {
  // Account balance, in the account's currency
  balance: number;
  // Share of the balance risked if the stop is hit, in percent
  riskPercent: number;
  entry: number;
  stop: number;
  pair: string;
}

export interface PositionSize {
  // What is at risk if the stop is hit, in the account currency
  riskAmount: number;
  // Distance to the stop, in price units and in pips
  stopDistance: number;
  stopPips: number;
  // Units of the base currency (10,000 units = 1 standard lot in Japan)
  units: number;
  lots: number;
}

// A JPY-quoted pair moves in 0.01; everything else in 0.0001
export const pipSize = (pair: string): number => (pair.toUpperCase().includes("JPY") ? 0.01 : 0.0001);

export const quoteCurrency = (pair: string): string => {
  const parts = pair.toUpperCase().split(/[/_]/);
  return parts.length === 2 ? parts[1] : "";
};

// The risk per unit is denominated in the pair's quote currency. Sizing from a
// yen balance therefore only works directly when the quote currency is yen;
// anything else would need a conversion rate this app does not hold, and a
// guessed one would be worse than none.
export const canSizeInYen = (pair: string): boolean => quoteCurrency(pair) === "JPY";

export const positionSize = (input: PositionInput): PositionSize | null => {
  const { balance, riskPercent, entry, stop, pair } = input;
  if (![balance, riskPercent, entry, stop].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  if (balance <= 0 || riskPercent <= 0) return null;
  // Rounded to the quote's own precision before anything divides by it:
  // 158.4 − 158.0 is 0.40000000000000568 in binary floating point, and
  // dividing by that turns 25,000 units into 24,999.
  const stopDistance = Number(Math.abs(entry - stop).toFixed(5));
  if (stopDistance <= 0) return null;

  const riskAmount = balance * (riskPercent / 100);
  // Units such that (units × stopDistance) = riskAmount, in the quote currency
  const units = riskAmount / stopDistance;
  return {
    riskAmount: Math.round(riskAmount),
    stopDistance,
    stopPips: Number((stopDistance / pipSize(pair)).toFixed(1)),
    units: Math.floor(units),
    // Japanese retail convention: 1 lot = 10,000 units
    lots: Number((units / 10_000).toFixed(2)),
  };
};
