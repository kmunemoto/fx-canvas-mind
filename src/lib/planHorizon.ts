import type { Dict } from "@/lib/i18n/locales";
import type { PlanHorizon } from "@/lib/types";
import { formatJst } from "@/lib/candleTime";

// The declared trade horizon, turned into the lines two different screens show
// (#91).
//
// One module rather than two copies because the fresh result and the history
// panel show the SAME plan at different ages, and a period that read one way
// on the day and another way a week later would be worse than showing nothing.
//
// Everything here is derived from the row itself. In particular the length of
// the period is `bars x bar_ms`, both stored on the row, NOT looked up in a
// client-side copy of the per-timeframe table: the client holding its own copy
// is how this app came to have four horizons that disagreed in the first
// place. A row written under a later table still renders its own period.

// How long a period has to be before it reads better in days than in hours.
// 48 and not 24: "about 36 hours" is a normal thing to say about a trade, and
// "about 1.5 days" is not.
const DAYS_FROM_MS = 48 * 60 * 60 * 1000;

export interface HorizonLines {
  // "12 bars of the 1H chart (about 12 hours of open market)"
  bars: string;
  // Where the period ends, in the reader's clock. Null when `ends_at` is not a
  // time — an older row, or a shape the server changed — because a line
  // reading "to about Invalid Date" is worse than no line.
  endsAt: string | null;
  notACutoff: string;
  tpRoles: string;
}

// `calendar_covers_horizon` is NOT rendered, and that is a decision rather
// than an oversight.
//
// It was going to be a warning shown "only where the calendar fell short".
// Measured over four weeks of hourly starts, it is false on 31% / 35% / 56% /
// 99% of plans for 15min / 1h / 4h / 1day. The mechanism explains it: the
// period is walked in MARKET time, so `ends_at` can only ever be later than
// `priced_at + lookahead`, never earlier — the flag really says "this window
// crossed a market closure", and a 5-day window always crosses a weekend.
//
// The sentence would have been TRUE every time and useless nearly every time,
// which is the failure this file's own comment warned about one paragraph up:
// a line printed on every plan is read as boilerplate and stops being read.
// The field stays ON THE ROW — it is a real fact worth having when the two
// clocks are compared later — it simply is not a warning.

const spanText = (t: Dict, ms: number): string => {
  const h = t.result.horizon.span;
  return ms >= DAYS_FROM_MS
    ? h.days(Math.round(ms / (24 * 60 * 60 * 1000)))
    : h.hours(Math.round(ms / (60 * 60 * 1000)));
};

export const horizonLines = (
  horizon: PlanHorizon | null | undefined,
  t: Dict,
  intlLocale: string,
): HorizonLines | null => {
  if (!horizon) return null;
  const { bars, bar_ms: barMs } = horizon;
  // A period of zero bars, or one built from a bar length of zero, is not a
  // period. Refuse rather than render "0 bars (about 0 hours)", which reads
  // as a plan that is already over.
  if (!Number.isFinite(bars) || bars <= 0) return null;
  if (!Number.isFinite(barMs) || barMs <= 0) return null;

  const label = t.control.intervals[horizon.interval as keyof typeof t.control.intervals]
    ?? horizon.interval;
  const endsAtMs = Date.parse(horizon.ends_at);

  return {
    bars: t.result.horizon.bars(label, bars, spanText(t, bars * barMs)),
    endsAt: Number.isFinite(endsAtMs)
      ? t.result.horizon.endsAt(formatJst(horizon.ends_at, intlLocale))
      : null,
    notACutoff: t.result.horizon.notACutoff,
    tpRoles: t.result.horizon.tpRoles,
  };
};
