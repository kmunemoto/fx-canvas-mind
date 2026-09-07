// When the forex market is shut.
//
// Two predicates, because two different questions are asked of the same week
// and the safe answer differs.
//
// Deno-free on purpose: the vitest suite imports this directly.

// May I throw this bar away? / How much market time has passed?
//
// Names only the hours that are shut under every daylight-saving rule. Being
// wrong here destroys real data, or stops the clock on a plan while the market
// was trading, so it is deliberately narrow: all of Saturday, Friday from the
// latest possible close, and Sunday before the earliest possible open.
export const isMarketClosed = (ms: number): boolean => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return true; // Saturday
  if (day === 5 && hour >= 22) return true; // Friday, past the latest close
  if (day === 0 && hour < 21) return true; // Sunday, before the earliest open
  return false;
};

// Is this absence evidence that the feed failed? / Is "enter now" an
// available action?
//
// The opposite safe answer: the WIDEST possible closure, because an hour that
// might have been shut is not evidence of anything — and has no reliable "now"
// to enter at, which is why analyze refuses on this predicate, not the narrow
// one (a narrow refusal left a one-hour hole every week). Using the narrow predicate
// for coverage counted the summer band between the real 21:00Z Friday close
// and the notional 22:00Z as open market with no bars in it — four missing
// 15min intervals, past the tolerance — so every 15min window spanning a
// weekend was judged incomplete and silently sent back to the mid feed.
export const isPossiblyClosed = (ms: number): boolean => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return true; // Saturday
  if (day === 5 && hour >= 21) return true; // Friday, from the earliest close
  if (day === 0 && hour < 22) return true; // Sunday, until the latest open
  return false;
};

// The longest unbroken run of hours `isMarketClosed` calls shut: Friday 22:00
// UTC to Sunday 21:00 UTC. Measured off the predicate itself in the suite
// rather than trusted here, so widening `isMarketClosed` without moving this
// number fails loudly instead of quietly deleting real bars.
export const CLOSED_WINDOW_MS = 47 * 60 * 60 * 1000;

// Sunday, from this hour UTC, the feed is already pricing the new week.
//
// Not a claim about when the market opens — `isMarketClosed` keeps that, and
// keeps it at 21:00. This is a claim about the DATA, and it is measured. The
// 4h bar stamped 2026-09-06 17:00Z, which spans Sunday 17:00-21:00Z and by
// every rule below is wholly inside the closure, came back with a range of
// 0.518 against 0.018-0.092 on the bars either side of it, a low of 155.86375
// that was the week's opening low, and a close that is the next bar's open to
// five decimals. The weekend gap is priced in that bar. The 4h grid was
// confirmed start-labelled first, by aggregating the 1h bars: 21:00+22:00+
// 23:00+00:00 reproduce the 4h bar stamped 2026-09-04 21:00 exactly.
//
// So a whole-span test on `isMarketClosed` alone deletes the bar carrying the
// weekly open on 15min, 1h and 4h — precisely the data destruction the narrow
// predicate exists to prevent, committed by the filter that was added to
// protect ATR. 17:00 is the coarsest bucket boundary the measurement pins: the
// prints are somewhere in 17:00-21:00Z and one prompt cannot say where, so the
// conservative edge is the start of the bucket that holds them.
export const SUNDAY_PREOPEN_UTC_HOUR = 17;

// Was the market shut for the WHOLE of this bar?
//
// `isMarketClosed` answers about an INSTANT, which is the same question only
// for a bar shorter than the hours it names. Asked of a bar's open stamp it
// deletes the Sunday-stamped 1day bar that carries the week's open and the
// weekend gap, and the ~29% of 1month bars stamped on a weekend 1st
// (production monthly bars are stamped the 1st; 2026-08-01 was a Saturday).
// Asked of the whole span it is identical on 15min/1h/4h — the timeframes the
// weekend actually ruins — and right on the coarse ones with no exclusion
// list to maintain.
//
// On the coarse timeframes the stamp is a LABEL, not the bar's UTC start, and
// this tests the labelled day rather than the bar. Production says so: the
// daily bar stamped 2026-09-05 is exactly the 4h bars 09-04 21:00 through
// 09-05 17:00, i.e. Friday 21:00Z to Saturday 21:00Z, and the one stamped
// 2026-09-06 is Saturday 21:00Z to Sunday 21:00Z — the provider anchors its
// forex day at the 17:00 New York close and names it for the date it ends on.
// The question this then asks of a daily bar is "is the trading day NAMED
// Saturday a trading day at all", which is the right question and has the
// right answer. Modelling the true span instead would be worse, not better:
// Friday 21:00-22:00Z is open under the narrow predicate, so a span test would
// KEEP the Saturday-named bar — the one that is 23/24 filler — and the Sunday
// pre-open rule above already keeps the Sunday-named bar that holds the gap.
//
// Deliberately NOT combined with a flat-bar test. The filler bars are not
// flat: the Sunday 2026-09-06 07:55Z run sat 34 hours into the closure, so
// all twenty Bollinger closes were filler, and it still stored bb_upper
// 156.250 against bb_lower 156.229 — a 2.1-pip band, a standard deviation
// that is small but not zero. An AND with "open === close" would have kept
// every one of those bars and the filter would silently do nothing.
//
// Keeps the bar wherever it cannot answer. An unreadable timestamp is not
// evidence of a closed market (the rule the tail counter this replaced also
// stated, and parseCandles sorts undated bars to the FRONT, so they are
// interior by construction and NaN comparisons returning false would only be
// right by accident). An
// interval of zero means the caller has no length for this timeframe, so the
// span is unknown. And a bar longer than the longest closure always contains
// trading — which is the whole of the 1week/1month answer, and is also what
// makes the two-endpoint test sound: a bar of 47h or less cannot begin inside
// one shut window and end inside the next without spanning the 121-hour
// trading week between them.
export const barFullyClosed = (openMs: number, intervalMs: number): boolean => {
  if (!Number.isFinite(openMs)) return false;
  if (!(intervalMs > 0) || intervalMs > CLOSED_WINDOW_MS) return false;
  const endMs = openMs + intervalMs - 1;
  // Reaching into the Sunday pre-open band is enough to keep the bar. A span
  // of 47h or less that starts inside the closure and ends on a Sunday at or
  // after this hour ends in that band by construction, so the end instant is
  // the whole test.
  const end = new Date(endMs);
  if (end.getUTCDay() === 0 && end.getUTCHours() >= SUNDAY_PREOPEN_UTC_HOUR) return false;
  return isMarketClosed(openMs) && isMarketClosed(endMs);
};

// When does it open again?
//
// Only meaningful while `isPossiblyClosed(ms)` is true — it answers the
// question that predicate raises and nothing else. It returns the LATEST
// possible open (Sunday 22:00 UTC, i.e. Monday 07:00 JST), matching the wide
// predicate: telling someone the market is back at 06:00 when the analyst
// will still refuse until 07:00 would be a worse answer than one hour late.
//
// The market may in fact be trading before this — the hour between the
// earliest and latest open moves with daylight saving, and neither predicate
// pretends to know which. So this is the time the app itself starts working
// again, which is the thing the person asking actually wants to know.
export const nextOpen = (ms: number): number => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  // Sunday is day 0, so from any day in the shut window the coming Sunday is
  // this many days ahead; on Sunday itself it is today.
  const daysAhead = day === 0 ? 0 : 7 - day;
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + daysAhead,
    22,
    0,
    0,
    0,
  );
};

// When did it last trade?
//
// The mirror of `nextOpen`, and it exists for one specific job: deciding how
// stale a price series is. `seriesHealth` measures the newest bar against
// "now" and calls anything older than a few intervals a feed failure — which
// is right on a Tuesday and wrong every weekend, when the newest bar is
// Friday's close by definition and there is nothing wrong with it at all.
// Measured against the close instead, a weekend series is as fresh as it can
// possibly be.
//
// Returns the EARLIEST possible close (Friday 21:00 UTC), matching the wide
// predicate that decides the market is shut: the two have to agree, or an
// hour exists that is "shut" while its own last close has not happened yet.
export const lastClose = (ms: number): number => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  // Friday is day 5. Only the shut days can reach here: Sunday goes back two
  // days, Saturday one, and Friday evening is already past its own close.
  const daysBack = day === 0 ? 2 : day === 6 ? 1 : 0;
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysBack,
    21,
    0,
    0,
    0,
  );
};
