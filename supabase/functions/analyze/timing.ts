// The hours in which a short-term plan loses to the cost of the market, not
// to its direction (#100).
//
// What was measured (research/tendencies.ts, GMO 15-minute bid/ask from
// 2024-01 to 2026-09, five pairs; docs/OPERATIONS.md §8.18):
//
//   * GMO widens its spread at the New York close, the daily roll: the
//     median ask-bid at the close of a 15-minute bar in 21:00-21:59 UTC was
//     12.5 pips on USD/JPY, 12.1 at 22:00, 2.9 at 23:00, against 0.2-0.4
//     every other hour. (21:00 in northern summer, 22:00 in winter.)
//   * A plan opened in those hours pays that spread at once: 1.5-4.6% of
//     15-minute plans won. A plan opened in the hours before is still open
//     when the spread spikes, and is stopped by it: of the 1-hour plans
//     opened at 19:00-20:00 UTC that lost, 23-31% lost in the 21-22 UTC
//     bars.
//   * Refusing 15-minute and 1-hour plans opened at 17:00-23:59 UTC
//     (02:00-08:59 JST) raised the win rate of the plans left, in the
//     second period, which the rule was not chosen on, on every one of the
//     five pairs and on both timeframes. The numbers the reader is shown
//     are in COSTLY_EVIDENCE below.
//   * No such effect on 4-hour plans: their stops are wide enough that the
//     spike does not reach them. They are not in the table.
//
// And what was NOT found, which is the other half of why this is the rule
// and not something cleverer: once these hours are set aside, none of the
// chart states the study read (trend, momentum, RSI, ADX, Bollinger
// position, structure, the two rungs above) told which way price would go,
// on any timeframe — in the second period the model built on them ranked
// winners no better than chance (AUC 0.49-0.51).
//
// Deno-free on purpose: src/test/timing.test.ts imports it directly.

// UTC hours, of the moment the plan is priced, in which a plan on each
// entry timeframe is not published.
//
// 15min and 1h: measured, as above.
//
// 1min: NOT measured on one-minute bars. What is measured is the spread
// itself, and a one-minute stop is 1.5-2 pips against a spread of 12: a plan
// opened into it is stopped by the spread alone. A one-minute plan is
// declared over 30 bars, so one opened in the hour before the roll can
// still be open at it. That is arithmetic about a measured spread, not a
// measured win rate, and COSTLY_EVIDENCE says so.
export const COSTLY_HOURS_UTC: Record<string, readonly number[]> = {
  "1min": [20, 21, 22, 23],
  "15min": [17, 18, 19, 20, 21, 22, 23],
  "1h": [17, 18, 19, 20, 21, 22, 23],
};

// The median spread at the roll, in pips, USD/JPY, as measured.
export const ROLLOVER_SPREAD_PIPS = 12.5;

export interface CostlyEvidence {
  // Whether the win rates below were measured on this timeframe
  measured: boolean;
  pair: string;
  // The period the rule was judged on — the second one, never the one it
  // was found in
  period: string;
  // Win rates of plans opened inside and outside the hours, stop 0.8 ATR,
  // target 1.5 times the stop, spread paid (break-even 40%)
  inside: { buy: number; sell: number } | null;
  outside: { buy: number; sell: number } | null;
}

export const COSTLY_EVIDENCE: Record<string, CostlyEvidence> = {
  "1min": { measured: false, pair: "USD/JPY", period: "2025-07〜2026-09", inside: null, outside: null },
  "15min": {
    measured: true,
    pair: "USD/JPY",
    period: "2025-07〜2026-09",
    inside: { buy: 0.215, sell: 0.183 },
    outside: { buy: 0.389, sell: 0.353 },
  },
  "1h": {
    measured: true,
    pair: "USD/JPY",
    period: "2025-07〜2026-09",
    inside: { buy: 0.275, sell: 0.237 },
    outside: { buy: 0.398, sell: 0.356 },
  },
};

// Is a plan on this timeframe, priced at this instant, inside the hours?
export const costlyHourAt = (interval: string, ms: number): boolean => {
  const hours = COSTLY_HOURS_UTC[interval];
  if (!hours || !Number.isFinite(ms)) return false;
  return hours.includes(new Date(ms).getUTCHours());
};
