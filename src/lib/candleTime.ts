// Candle timestamps arrive as "YYYY-MM-DD HH:mm:ss" (or a bare date) in UTC
// and are shown in JST, the zone the whole app reports times in.

export const parseUtcCandleTime = (datetime: string): number => {
  if (!datetime) return NaN;
  if (datetime.includes("T")) return Date.parse(datetime);
  const [date, time] = datetime.split(" ");
  return Date.parse(`${date}T${time || "00:00:00"}Z`);
};

export const formatJst = (
  input: string | number,
  intlLocale: string,
  opts: { withTime?: boolean; withYear?: boolean } = {},
): string => {
  const ms = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return String(input);
  const withTime = opts.withTime ?? true;
  return new Date(ms).toLocaleString(intlLocale, {
    timeZone: "Asia/Tokyo",
    ...(opts.withYear ? { year: "numeric" as const } : {}),
    month: "2-digit",
    day: "2-digit",
    // h23, not hour12:false — the latter has rendered midnight as "24:00" in
    // some engines
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  });
};

// Axis label for a candle: date only for daily bars, date + time otherwise.
// #181: on a chart of weeks or months (`long`), the date with its year: a
// chart of them spans years
export const formatCandleLabel = (datetime: string, intlLocale: string, opts: { long?: boolean } = {}): string => {
  const ms = parseUtcCandleTime(datetime);
  if (!Number.isFinite(ms)) return datetime.slice(5, 16);
  if (opts.long) return formatJst(ms, intlLocale, { withTime: false, withYear: true });
  const hasTime = datetime.includes(":") || datetime.includes("T");
  return formatJst(ms, intlLocale, { withTime: hasTime });
};

// #181: bars at least this far apart, on the whole, are weeks or months
export const LONG_BAR_MS = 6 * 24 * 60 * 60 * 1000;
// The middle gap between neighbouring candles (ms), or NaN with fewer than two
export const medianGapMs = (datetimes: readonly string[]): number => {
  const gaps: number[] = [];
  for (let i = 1; i < datetimes.length; i++) {
    const g = parseUtcCandleTime(datetimes[i]) - parseUtcCandleTime(datetimes[i - 1]);
    if (Number.isFinite(g) && g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return Number.NaN;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
};

// #127: gold (XAU/USD) is quoted in dollars to the cent. It has no pip
// convention the app relies on — its spread is shown in dollars — so its
// "pip" here is the cent, only so that nothing divides by a currency's pip.
export const isGoldPair = (pair: string): boolean => pair.toUpperCase() === "XAU/USD";

export const pipSize = (pair: string): number => (isGoldPair(pair) ? 0.01 : pair.toUpperCase().includes("JPY") ? 0.01 : 0.0001);

export const toPips = (pair: string, priceDiff: number): number => priceDiff / pipSize(pair);

export const priceDecimals = (pair: string): number => (isGoldPair(pair) ? 2 : pair.toUpperCase().includes("JPY") ? 3 : 5);

// #128: a price distance in the unit it is read in — pips for a currency
// pair, dollars for gold ("12 pips", "$12.34"); `signed` puts + or − in front
export const formatDistance = (pair: string, diff: number, opts: { signed?: boolean; digits?: number } = {}): string => {
  const sign = opts.signed ? (diff >= 0 ? "+" : "−") : diff < 0 ? "−" : "";
  if (isGoldPair(pair)) return `${sign}$${Math.abs(diff).toFixed(2)}`;
  return `${sign}${Math.abs(toPips(pair, diff)).toFixed(opts.digits ?? 0)}pips`;
};
