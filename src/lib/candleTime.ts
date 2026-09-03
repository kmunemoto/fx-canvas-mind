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
  opts: { withTime?: boolean } = {},
): string => {
  const ms = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return String(input);
  const withTime = opts.withTime ?? true;
  return new Date(ms).toLocaleString(intlLocale, {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    // h23, not hour12:false — the latter has rendered midnight as "24:00" in
    // some engines
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  });
};

// Axis label for a candle: date only for daily bars, date + time otherwise
export const formatCandleLabel = (datetime: string, intlLocale: string): string => {
  const ms = parseUtcCandleTime(datetime);
  if (!Number.isFinite(ms)) return datetime.slice(5, 16);
  const hasTime = datetime.includes(":") || datetime.includes("T");
  return formatJst(ms, intlLocale, { withTime: hasTime });
};

export const pipSize = (pair: string): number => (pair.toUpperCase().includes("JPY") ? 0.01 : 0.0001);

export const toPips = (pair: string, priceDiff: number): number => priceDiff / pipSize(pair);

export const priceDecimals = (pair: string): number => (pair.toUpperCase().includes("JPY") ? 3 : 5);
