// #385: WillyAlgoTrader's AMD Po3 with Live Edge Stats, ported in
// supabase/functions/_shared/amd-po3.ts, where the email decides with the
// same code (docs §8.128)
import { priceDecimals } from "@/lib/candleTime";
import type { PineColor } from "../../supabase/functions/_shared/amd-po3";

export * from "../../supabase/functions/_shared/amd-po3";

// syminfo.mintick: the price's last decimal (as this app rounds the bars)
export const amdMintick = (pair: string): number => 1 / 10 ** priceDecimals(pair);

// a Pine colour (hex, transparency 0..100) as CSS
export const pineCss = (c: PineColor | null): string => {
  if (!c) return "transparent";
  const [r, g, b] = [1, 3, 5].map((k) => parseInt(c[0].slice(k, k + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${(100 - c[1]) / 100})`;
};

// TradingView's timeframe.period for the bars' usual step ("15" is the
// timeframe the indicator is tuned for; its table warns on the others)
export const tvPeriodOf = (stepMs: number): string => {
  const min = Math.round(stepMs / 60_000);
  if (min <= 0) return "?";
  if (min < 1440) return String(min);
  if (min < 7 * 1440) return "D";
  if (min < 28 * 1440) return "W";
  return "M";
};
