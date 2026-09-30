// #174: currency strength (通貨の強弱). The owner (2026-09-30), showing the
// GBP/JPY 4-hour chart: 「この画像以外に加えるべき違う指標のインジケーター
// 考えて、買いか売りを判断するためにこの画像以外の指標で買い売り判断できる
// やつ」; of the kinds offered, the owner chose currency strength: the eight
// currencies' strength worked from the pairs, buying the strong against the
// weak. Measured before anything is built; the owner decides from the numbers
// whether it goes on the chart or in the emails. Every indicator measured
// here so far lost after the spread on the 4-hour emails (docs §8.69, §8.77,
// §8.83): nothing is expected of this one for being new.
//
// THE MEASURE, fixed before any strength was worked on the data (the data is
// §8.83's, whose emails' signals and trades have been seen; no strength's).
// Drawn from three designs made apart (one for a signal of its own, one for
// a filter on the emails, one looking for what could mislead) and one
// merging them:
//   * the data: GMO's 4-hour bars and 5-minute bid/ask, START 2024-01-01 to
//     END 2026-09-29 14:16:25 UTC (§8.83's, so its numbers come out again:
//     check h), the halves split at SPLIT 2025-05-19. The 4-hour bars from
//     the year before START (as research/widetp.ts), so the meter has bars
//     before START. One run on the data.
//   * the pairs: A+B, widetp.ts's eleven: the yen crosses USD/JPY, EUR/JPY,
//     GBP/JPY, AUD/JPY, NZD/JPY, CAD/JPY, CHF/JPY and the dollar pairs
//     EUR/USD, GBP/USD, AUD/USD, NZD/USD. C (TRY/JPY, ZAR/JPY, MXN/JPY) is
//     not made of the eight currencies. The pairs GMO added in #153 have no
//     4-hour history and Twelve Data's no 5-minute: not measured.
//   * THE METER: from the seven yen crosses' chart 4-hour candles
//     (historyRead: the closed bars' mids, rounded as drawn). G: the open
//     times all seven have, joined by time (never by position), nothing
//     filled in; a time one of them lacks has no meter, and no signal on any
//     pair. k counts G's bars (a weekend is skipped, not counted); T_k is
//     bar k's close. For the eight currencies, in this order JPY, USD, EUR,
//     GBP, AUD, NZD, CAD, CHF: v_c(k) the log of c/JPY's close, v_JPY 0;
//     r_c(k; L) = v_c(k) − v_c(k − L); the strength s_c(k; L) = r_c less the
//     mean of the eight r's (so the eight sum to 0). Ranked 1 (the strongest)
//     to 8; an exact tie goes to the earlier in the order (counted: none
//     expected). No volatility scaling, no smoothing, nothing fitted on the
//     sample. The dollar pairs are not in it (USD would count twice): they
//     are traded, and checked against it (tri).
//   * what it can add: s_A − s_B is A/B's own L-bar log return (exactly on
//     the yen crosses; on the dollar pairs up to the triangle's residual).
//     "A stronger than B" is the pair's own momentum; the meter adds only
//     where A and B stand among the eight. Hence the M line (told).
//   * THE SIGNAL, on each A+B pair A/B at bar k: the state +1 when A ranks 1
//     or 2 and B 7 or 8; −1 when A ranks 7 or 8 and B 1 or 2; else 0. A BUY
//     (+1) or a SELL (−1) where the state at k is not 0 and differs from the
//     state at k − 1 (the G bar before, worked from the bars closed by then):
//     once on entering, as Q-Trend's first of a run. Only where the email
//     would send it: T_k from START to END, read by the sweep 0, 4 or 6
//     minutes after it with the market open (#171; a state entered at the
//     week's last close, Saturday 00:00 UTC, is lost, as an email's signal
//     there is), and the pair with its own bar at T_k.
//   * the candidates, two: X6 (L = 6 bars, a day) and X30 (L = 30, five
//     days, the exit's own limit). Ties go to X6. The rest above is fixed.
//   * THE TRADE, the email's (#173): entered at T_k's close, a buy at the
//     ask, a sell at the bid; TP1 20 pips and the stop 30 from the mid close;
//     followed on the 5-minute bid/ask from the first 5-minute bar opening at
//     or after T_k, out at whichever a bar reaches first (both in one bar:
//     the stop; a bar opening past one: at that open); else at the close of
//     the pair's 30th 4-hour bar after (the bid for a buy, the ask for a
//     sell). Only trades whose 30 bars are in the data.
//   * the coin: at every such close of each pair, both sides, the same trade.
//   * THE YARDSTICK, e: a trade's pips less the mean of the coin's two at the
//     same pair and close, e = (pips(its side) − pips(the other side)) / 2.
//     The spread, the pair, the hour and the exit's lean cancel; with no edge
//     its mean is 0 by symmetry, whichever closes are chosen. A trade's pips
//     are the coin's mean at its close plus e.
//   * the pick: on the first half (T_k before SPLIT, less the trades whose
//     30 bars reach past it: they would read second-half prices), the
//     candidate with the higher t of e: its mean over the larger of its
//     standard errors by week and by four weeks (weeks from Sunday 21:00
//     UTC, research/lib.ts; a week's trades on every pair in one cluster).
//   * called "picks the side better than a coin toss at the same closes":
//     the pick's second-half mean e above 0, and the low end of its interval
//     above 0: the lower of by week and by four weeks, each the mean less
//     t(C − 1) × its standard error at one side 2.5%, C the weeks (blocks)
//     holding trades. Every interval here is so.
//   * the Bonferroni road beside it: both candidates' second-half e at one
//     side 2.5% / 2; the one not picked is told "above 0 after the
//     correction" only when that low end is.
//   * THE PLACEBO GATE: 1,000 made-up meters (seeds 1 .. 1000: the eight
//     currencies' v independent Gaussian walks on G, a step a bar), each
//     through the same L's, states, entries, pick and call, on the real
//     coin's e. Their states last as the real one's do, but they know
//     nothing: the share of them called is how often these intervals say
//     "better" on this data by chance (the trades crossing weeks, the pairs
//     moving together, the tails, all as they are in the data). Over 4.0%
//     (40 of the 1,000; 41 or more come by chance 0.18% of the time were
//     the placebos apart, at the nominal 2.5%), for the call or for the
//     Bonferroni road: "the intervals were too narrow for this data", and
//     nothing is called (the numbers still told). The placebos share one
//     data set: 4% is a rule of thumb, not a test. What it does not test: a
//     trend lasting months, which the real meter follows and a placebo does
//     not (for that, the stale meter, leave one out and the trend walk).
//   * cannot say (no call, fixed now): an alignment gate below fails (the
//     run then stops before any trade is followed: prices only are looked
//     at, and any change is written here before the data is run again); the
//     pick's second-half trades in fewer than 30 weeks; the placebo gate.
//   * the words, fixed now: a call says only that the meter picks the side
//     better than a coin toss at the same closes with this exit. Beside it,
//     in the same report: whether it beats the spread (its pips a trade),
//     how the pair's own momentum does (M), and whether it rests on one
//     currency (leave one out, the stale meter).
//   * told, not called on (the whole period and the halves, the same
//     intervals):
//       - the money: each candidate's pips a trade after the spread; TP1
//         first against the break-even 30 / (30 + 20) (the spread left out);
//         how the trades went out (tp, sl, amb, time); trades a week; the
//         coin's mean at the meter's closes and at every close (the hour and
//         the pair: the part of the pips that is not e).
//       - M: the same rule on the sign of s_A − s_B (the pair's own L-bar
//         momentum as the meter sees it), once on each change, the same
//         filters and yardstick; X less M, its standard error from the two's
//         week (block) sums together. The extremes pick the larger moves, so
//         X can beat M with no cross-sectional effect at all: no walk here
//         gauges that, and X less M is read as a comparison only.
//       - the rank IC: at every G close in the period, Spearman's
//         correlation across the eight between s(k; L) and s(k + 6; 6) (the
//         next day's basket-relative move), L 6 and 30; its mean, by week and
//         by four weeks. No spread, no exit: the line with the most power,
//         and not a trade.
//       - the stale meter: the rule on the strength of 120 bars before (about
//         four weeks): what it gains is the period's lasting trends, not the
//         meter's timing. Leave one currency out: e without the pairs holding
//         it, eight rows. Each currency's share of the top two and the bottom
//         two. Each pair; each side; the second half by quarter.
//       - top 1 and bottom 1 (the owner's words: the strongest against the
//         weakest), L 6 and 30.
//       - the emails (A+B; either, Q-Trend, ULTRA; the same trade): their e
//         at their own closes; each labelled by the meter at its close, L 6
//         and 30: agree (s_A above 0 and s_B below it for a buy, the mirror
//         for a sell), against (the mirror), mixed; for each label, the
//         trades, pips a trade and e; agree less against, with the joint
//         standard error. Picking a filter from these lines would be a choice
//         made after seeing them: not offered as measured.
//       - coverage: G's bars; each cross's missing times; states lost to
//         closes not mailed; the hours a lookback spans.
//   * checks, every one 0 differ on every walk and on the data before any
//     number is read:
//       (g1) the grid: every A+B pair's 4-hour opens at 0, 4, 8, 12, 16 or 20
//            UTC (§8.69); for each yen cross, the share of the seven's times
//            it lacks: over 0.5% stops the run (the times listed).
//       (tri) at every G bar, each dollar pair's mid close against X/JPY ÷
//            USD/JPY, in its pips: the median and the share over 5 pips
//            told; a median over 1 pip, or more than 0.1% of the bars over 5
//            pips, stops the run (bounds guessed before the data's prices
//            were seen). Again with USD/JPY one bar off either way: the
//            median at least 5 times the one in step, or the check could not
//            see a slip.
//       (p0) at every G bar, each pair's 4-hour close against the mid close,
//            rounded, of its 5-minute bar ending at T_k.
//       (id) Σ s = 0, and s_c − s_JPY = the log of c/JPY's close over its
//            close L bars before, within 1e-12, at every G bar, L 6 and 30.
//       (la) at every signal and every 13th G bar, a second, plain working
//            from each cross's candles cut at T_k (only those closed by
//            then) and its own grid from them: the eight s's (within 1e-12),
//            the ranks (by counting), each pair's states at k and k − 1 and
//            whether it signals. A planted look-ahead (LOOKAHEAD=1: the meter
//            reading the close after) must fail it on a walk at 99% of the
//            bars compared or more (#171-5's first look-ahead check could not
//            fail: §8.84).
//       (c) each meter trade followed again, against the coin's at the same
//           pair, close and side; (a2) its stop and targets against
//           ultraLevels(side, close, unit, ULTRA_PAIRS); (m) following
//           starts at the first 5-minute bar opening at or after T_k; (d)
//           the time-outs' closes against the 4-hour bar's own.
//       (pk) the pick again from the meter and the coin cut at SPLIT: the
//            same pick and t.
//       (a) the emails' signals against indicatorSignals, on every 13th bar
//           and every bar with a signal; (g) no GMO read failed; (h) §8.83's
//           T20 again (A+B, either, the trades with 120 bars in the data,
//           each half's trades and pips a trade to two places: −1.35 of 2,416
//           and −1.27 of 2,216), on the run fixed above only.
//
// ON RANDOM WALKS (SYNTHETIC=1), before any data is read (research/strength-
// seeds.py on their JSON). The walk "basket", new (the old ones move each
// pair alone, so their triangles do not hold and nothing moves together):
// the eight currencies' log values, 100 small uniform steps a 5-minute bar,
// sized so a pair of two 1× currencies moves about 2 pips a 5-minute bar (as
// #165's); JPY, AUD and NZD 1.3×, EUR and CHF 0.8×, the rest 1×, and a
// weekly factor on all (log-normal, sd 0.3) (these made up); each pair the
// ratio of its two, so every triangle holds; a fixed spread by pair (0.2 to
// 1.8 pips, made up); the market's shut hours skipped; the 4-hour bars on
// GMO's grid.
//   * "null" (nothing predicts), seeds 7 .. 56: every check 0 differ; the
//     call on at most 3 of the 50 (more than 3 by chance 3.6% at the nominal
//     2.5%), the Bonferroni road on at most 3; e, the seeds together, within
//     ±0.3 pips and three standard errors of 0 for each candidate; each
//     candidate's z of e on the halves (100) near a standard normal: one
//     whose low end is over 0 on 7 or more of the 100 (7 or more by chance
//     1.3%), or whose z has an sd over 1.25, is left out before the data
//     (told; widetp's rule); the placebo gate passed on at least 47 of the
//     50. Told: the coin's TP1 first against (30 − the spread / 2) / 50, the
//     stale meter, the IC, M.
//   * "rank" (the positive control): the walk's own code (not the
//     program's) ranks the eight at each 4-hour close from its own values L*
//     bars before, and over the next 4-hour bar moves the top two up and the
//     bottom two down by δ pips (as on a 150-yen pair), spread over the bar's
//     5-minute steps. L* = 6 on seeds 8 .. 17, 30 on seeds 18 .. 27. δ is
//     fixed on seed 7 before those are run: the smallest of 0.5, 1, 1.5 and 2
//     at which the planted candidate's second-half e is 5 standard errors or
//     more. The call on at least 9 of each 10, and every pair's e above 0
//     (the seeds together), else the program is looked into; δ is not raised
//     to pass.
//   * "trend" (seeds 7 .. 16, told): the null with JPY falling 8% evenly
//     over the second half, nothing predictive: what one currency's trend
//     does to the call, to leave-JPY-out and to the stale meter.
//   * the power (the null runs): 1, 2 or 3 pips a trade added to one
//     candidate's e: how often it is picked, and called.
//   * planted faults, once each on seed 7 (told): LOOKAHEAD (above);
//     MISALIGN (one cross joined by position after one of its bars is taken
//     out): tri or la must fail; ORIENT (EUR/USD's state the wrong way
//     round) on a rank walk: its e below 0.
//   * what the walks cannot show: weekend gaps, the spread by the hour,
//     news, the pairs' real co-movement (EUR with CHF, AUD with NZD), GMO's
//     missing bars.
// Then an independent review of the program and the walks, before the data.
//
// POWER, a rough guess from the design (a small simulation on made-up walks,
// not this program, not the data): about 1,850 (X6) and 1,000 (X30) trades in
// the second half, standard errors of e about 0.7 and 0.95 pips; so about +2
// pips a trade of e would be called most of the time: about the spread's
// cost again. "Not called" is not "no edge": the interval is told as a
// bound. The walks' power line gives this program's own numbers.
//
// NOT MEASURED: the other timeframes; the pairs above; a filter on the
// emails (told only); swap; slippage; the time from an email to an order;
// whether production could read all seven crosses at a close in time.

export {};
