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

// How many bars at the END of an ascending series the market was shut for.
//
// Providers keep emitting bars while the market is closed and they are flat:
// a weekend 1h series came back with the ATR at a tenth of Friday's, a
// Bollinger band two pips wide, and price, both SMAs and both ichimoku lines
// collapsed onto one number. Nothing is wrong with the feed — those hours
// simply had no trading in them.
//
// Uses the NARROW predicate, which is the one that answers "may I throw this
// bar away?" and is deliberately conservative about saying yes; the same
// predicate already drops the same bars in the tracker.
//
// Counts only the tail, so a caller slicing by it never opens a gap in the
// middle of a series. A non-finite timestamp stops the count rather than
// being assumed shut — an unreadable bar is not evidence of a closed market.
export const closedTail = (times: number[]): number => {
  let n = 0;
  for (let i = times.length - 1; i >= 0; i -= 1) {
    const t = times[i];
    if (!Number.isFinite(t) || !isMarketClosed(t)) break;
    n += 1;
  }
  return n;
};
