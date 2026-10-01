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
//     to 8; an exact tie goes to the earlier in the order (counted. First
//     fixed as "none expected"; the program's first try on a walk, before
//     the data, gave 35 of 4,299 closes at L 6 and 23 at L 30: a cross whose
//     rounded close is back where it was L bars before ties with the yen).
//     No volatility scaling, no smoothing, nothing fitted on the sample.
//     The dollar pairs are not in it (USD would count twice): they are
//     traded, and checked against it (tri).
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
//            CHANGED after the data's prices were seen, before any trade
//            was followed:
//              - the first run (36763362396) stopped here. EUR/USD had 39 and
//                GBP/USD 37 of 5,455 bars over 5 pips (0.7%). The medians
//                were 0.07 to 0.11 pips; one bar off, 5.6 to 12.5.
//              - a second run (36763749912) listed those bars, prices only
//                (the bars where a dollar pair is over 5 pips). Most are
//                whole trading days (the six bars 20:00 to 16:00 UTC:
//                2023-04-05, 2024-03-27, 2024-12-24 with its 20:00 bar after,
//                2025-04-16) where the four dollar pairs are off by about the
//                same 3.4 to 6.8 in 1e-4 of their close (at a day's 16:00 or
//                20:00 bar one pair up to 9.1). On 2025-12-24 only its 12:00
//                and 16:00 bars and the 20:00 after are listed; whether its
//                other bars were off is not seen. That points at USD/JPY, the
//                leg they share, being out of line with the crosses (an
//                inference).
//              - also days where EUR/USD and GBP/USD, or EUR/USD alone, are
//                off (2023-04-28, 2024-04-30, 2025-04-30), and single bars at
//                thin hours (16:00 or 20:00 UTC; 26 and 27 December, 3 July,
//                Friday evenings).
//              - the series as a whole is not one bar off: the medians are
//                1/60 to 1/140 of one bar off's. The listed bars were not
//                each checked for a slip; the whole days are taken not to be
//                one because their offset stays about the same all day (a
//                slip would change bar by bar with USD/JPY's move), an
//                inference. The single bars at thin hours are not known.
//              - so the share over 5 pips is now told, not a gate. The median
//                and the slip stay gates. Told beside the call: e without the
//                fires whose meter reads one of those bars (k, k − 1, k − L,
//                k − 1 − L).
//       (p0) at every G bar from 60 days before START (so the bars before
//            START the meter reads too) whose 5-minute bar ending at T_k is
//            in the data, each pair's 4-hour close against that bar's mid
//            close, rounded. (First fixed "at every G bar"; the program read
//            the 5-minute bars from 5 days before START only, which a review
//            before the data found.) Told beside it, not a gate: the bars
//            with no 5-minute bar ending at T_k (the week's last, closing
//            Saturday 00:00 UTC after the market's close, about 1 in 30),
//            their close against the last 5-minute bar inside them. CAD/JPY
//            and CHF/JPY have no dollar pair here for tri: p0 is theirs.
//       (id) Σ s = 0, and s_c − s_JPY = the log of c/JPY's close over its
//            close L bars before, within 1e-12, at every G bar, L 6 and 30.
//       (la) at every signal and every 13th G bar, a second, plain working
//            from each cross's candles cut at T_k (only those closed by
//            then) and its own grid from them: the eight s's (within 1e-12),
//            the ranks (by counting), each pair's states at k and k − 1,
//            whether a fire may be taken there (worked again from T_k), and
//            which way it signals, against the way the program fired, both
//            ways round (a fire where the state is 0 counts: the first
//            working compared only where the plain state was not 0, which a
//            review before the data found). A planted look-ahead
//            (FAULT=LOOKAHEAD: the meter reading the close after) must fail it
//            on a walk at 99% of the bars compared or more (#171-5's first
//            look-ahead check could not fail: §8.84).
//       (c) each meter trade followed again, against the coin's at the same
//           pair, close and side; (a2) the stop and TP1 it used against
//           ultraLevels(side, close, unit, ULTRA_PAIRS); (m) a trade
//           entered at the close its caller has from elsewhere (T_k from G;
//           an email's, its quote's own), followed from the first 5-minute
//           bar opening at or after it; (d) the time-outs' closes against
//           the 4-hour bar's own.
//       (pk) the pick again from the meter and the coin cut at SPLIT: the
//            crosses' candles closed by then (their own grid and meter), the
//            coin followed on the 4-hour and 5-minute bars closed by then;
//            every first-half trade the pick may take the same trade there,
//            and none it may not; the same pick and t. (The first working
//            sliced the same meter and copied the coin, so it could not see
//            a trade reading past SPLIT: found by a review before the data.)
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
//     MISALIGN (USD/JPY without one of its bars, and AUD/JPY joined by
//     position, so after that bar the meter reads AUD's bar before): la must
//     fail (tri reads the closes by time and cannot see it; first written
//     "one cross joined by position after one of its bars is taken out",
//     which cannot misalign: G drops that time too); ORIENT (EUR/USD's state
//     the wrong way round) on a rank walk: its e below 0.
//   * what the walks cannot show: weekend gaps, the spread by the hour,
//     news, the pairs' real co-movement (EUR with CHF, AUD with NZD), GMO's
//     missing bars.
// Then an independent review of the program and the walks, before the data.
// It was three reviewers apart (look-ahead, the statistics, the header
// against the program). It found checks that could not fail: (la) blind to
// a fire where the state is 0, (pk) copying the coin, (m) and (a2) testing
// their own arithmetic. It also found (p0) short of its words, and the seeds
// script not holding the runs to 1,000 placebos and writing widetp's rule
// otherwise. All were fixed before the data (2db6dfa, e53ab98).
//
// THE WALKS' RESULTS (the program as of e53ab98; research/strength-seeds.py
// on the 83 runs, each with 1,000 placebos, and seed 7's eight δ runs):
//   * δ, seed 7. L* 6: δ 0.5 / 1 / 1.5 / 2 gave the planted candidate's
//     second-half e 2.2 / 4.9 / 6.2 / 7.3 standard errors, so δ 1.5. L* 30:
//     1.0 / 2.7 / 4.1 / 5.5, so δ 2.
//   * null, seeds 7 .. 56:
//       - every check 0 differ (la 317,194 compared, pk 1,148,450, p0
//         3,115,200; the p0 told line 2,145 a run, 0 differ).
//       - the call on 0 of the 50, the Bonferroni road on 0.
//       - e, the seeds together: X6 +0.05 (187,784 trades, se 0.06), X30
//         −0.05 (98,825, se 0.10).
//       - z on the halves: X6 sd 0.98 by week, 1.03 by four weeks; X30 0.89
//         and 0.96. The low end over 0 on 0 and 1 of the 100. Both kept.
//       - the placebo gate passed on 50 of 50 (971 of the 50,000 placebos
//         called, 1.9%; the Bonferroni road 880, 1.8%).
//       - told (L 6 / 30): the stale meter +0.02 / +0.18, M +0.02 / +0.03,
//         top 1 +0.08 / +0.11, the rank IC +0.0008 / +0.0016; the coin's TP1
//         first within 1.3 points of (30 − the spread / 2) / 50 on every pair.
//   * the power (the null runs; a pips a trade added to one candidate's e):
//       - X6: +1, +2, +3 called on 11, 40, 50 of the 50.
//       - X30: +1, +2, +3 called on 2, 19, 40.
//       - so an edge of about +2 pips a trade (X6) or +3 (X30), in both
//         halves, is called most of the time; +1 on 11 (X6) and 2 (X30) of
//         the 50.
//   * rank:
//       - L* 6 (δ 1.5, seeds 8 .. 17): called on 10 of 10, X6 picked on 10.
//         Every pair's e above 0 (+3.03 to +5.74; X6 +4.47; M +1.45, the
//         stale meter +0.10).
//       - L* 30 (δ 2, seeds 18 .. 27): called on 10 of 10, X30 picked on 10.
//         Every pair's e +6.72 to +12.15 (X30 +8.70; M +1.33, stale +0.25).
//   * trend (seeds 7 .. 16): every check 0 differ; the call on 0, the
//     Bonferroni road on 0. The second half's e: X6 −0.06 (without the yen
//     −0.16, the stale meter +0.11); X30 +0.05 (+0.03, +0.33). The yen's 8%
//     fall made no call here.
//   * the faults (seed 7):
//       - LOOKAHEAD: la 6,312 of 6,312 differ (the checks aside, it would be
//         called: X6 e +9.51).
//       - MISALIGN: la 6,292 of 6,442.
//       - ORIENT: EUR/USD's e −8.12 (216 trades).
//   * the review's own planted faults, run again on the fixed program:
//       - a fire a bar early: la 4,667 of 6,310.
//       - the pick taking trades that reach past SPLIT: pk 320 of 22,969.
//       - following from the bar's open: m, all 121,704.
//       - the levels taken from the fill: a2, all 5,821. (Run on the program
//         just before e53ab98, whose own control, without the plant, also
//         had 30 of the 5,821 differ: the trades without their 30 bars,
//         compared with no levels. e53ab98 leaves those out: 0 of 5,791.
//         The plant was not run again on e53ab98.)
//   * the first 83 runs (the program as of 5276f0e, before the fixes) gave
//     the same calls and e, except that ORIENT was then run on seed 8 (not
//     7, as written above): EUR/USD's e −5.20 (249 trades), also below 0.
//
// THE RESULT (2026-09-30, docs §8.85, run 36764072301 at 55ce46c; the two
// runs before it stopped at tri, before any trade, as told under tri):
//   * every check 0 differ: la 6,142; pk 22,804; p0 48,004 (the told line
//     1,727, 0 differ); a 8,073; (h) −1.35 of 2,416 and −1.27 of 2,216
//     again. No GMO read failed. G 5,455 bars; 144 weeks (72 and 72).
//   * the placebo gate passed: 14 of the 1,000 called (1.4%), the Bonferroni
//     road 17 (1.7%).
//   * the pick X6 (first half t −0.35; X30 −0.49). Its second-half e +0.23
//     of 1,859 trades in 71 weeks, [−1.32, +1.78] by week, [−1.74, +2.20]
//     by four weeks: NOT CALLED. Above 610 of the 1,000 placebos' picks.
//     X30's +0.09, [−1.61, +1.79] by week, [−1.79, +1.97] by four weeks.
//     Bonferroni: neither above 0.
//   * the words fixed above: the meter does not pick the side clearly better
//     than a coin toss at the same closes (at most about +2.2 pips a trade
//     better). After the spread, over the whole period (144 weeks), its
//     trades lose as the coin does: X6 −1.66 pips a trade (3,866 trades,
//     26.8 a week), X30 −1.93; the coin at every close −1.63; the emails
//     −1.36 (4,742). TP1 first 57.7% and 57.1% (break-even 60%, the spread
//     left out). The second half alone: X6 −1.29 [−2.74, +0.16], X30 −1.57
//     [−3.49, +0.34], the coin −1.59, the emails −1.36 (2,326).
//   * told: e without the fires reading a bar off the triangle (67 fires
//     fewer over the whole period; how many in the second half is not
//     printed): X6 second half +0.28 (whole +0.02), about the same. M (the pair's own
//     momentum): e +0.10 (L 6) and +0.44 (L 30; its second half +1.08,
//     [+0.02, +2.14] by week, [−0.08, +2.24] by four weeks, one told line
//     of many). The rank IC −0.022 (L 6) and −0.002 (L 30), neither away
//     from 0. The stale meter −0.30 and +0.40. The yen the most often among
//     the bottom two (36% and 41%). The emails labelled by the meter at L
//     30: agree −2.95 pips a trade, against −0.82 (the second half, agree
//     less against −3.98 [−7.82, −0.14] by week, [−8.72, +0.77] by four
//     weeks): the strength agreeing with the email did not do better.
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

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ULTRA_PAIRS, ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, iso } from "./lib.ts";
import {
  CROSSES,
  CURRENCIES,
  NC,
  TRADED,
  addTo,
  diffStatOf,
  edgeOf,
  edgesOf,
  firesOf,
  gridOf,
  legsOf,
  lowEndOf,
  mergeAggs,
  momentumState,
  newAgg,
  newTable,
  placeboValues,
  rankFires,
  rankState,
  ranksFor,
  rng,
  spearman,
  statOf,
  strengthAt,
  tQuantile,
  tiesOf,
  tOf,
  verdictOf,
  verdictOn,
  type Agg,
  type Fire,
  type Table,
  type Values,
  type Verdict,
} from "./strength-lib.ts";

const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
// §8.83's end (the #165 run's)
const END = Deno.env.get("END") || "2026-09-29T14:16:25Z";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const END_ISO = END.includes("T") ? END : END.replace(" ", "T");
const NOW = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(END_ISO) ? END_ISO : `${END_ISO}Z`);
if (!Number.isFinite(NOW)) throw new Error(`END ${END} is not a time`);
const SYNTHETIC = Boolean(Deno.env.get("SYNTHETIC"));
const SEED = Number(Deno.env.get("SEED") || 7);
// the walks (the header): "null", "rank" (the positive control, with LSTAR
// and DELTA), "trend"
const SYNTH = Deno.env.get("SYNTH") || "null";
if (!["null", "rank", "trend"].includes(SYNTH)) throw new Error(`SYNTH ${SYNTH} is not a walk here`);
const LSTAR = Number(Deno.env.get("LSTAR") || 6);
// pips a 4-hour bar, as on a 150-yen pair
const DELTA = Number(Deno.env.get("DELTA") || 1);
// the planted faults (the header): LOOKAHEAD, MISALIGN, ORIENT
const FAULT = Deno.env.get("FAULT") || "";
if (!["", "LOOKAHEAD", "MISALIGN", "ORIENT"].includes(FAULT)) throw new Error(`FAULT ${FAULT} is not a fault here`);
if (!SYNTHETIC && (FAULT || SYNTH !== "null")) throw new Error("the faults and the walks' kinds are for SYNTHETIC runs only");
const PLACEBOS = Number(Deno.env.get("PLACEBOS") || 1000);
const CACHE = "research/.cache";
const OUT = Deno.env.get("OUTDIR") || "research/out";
const FINE = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
const TF = "4h";
const STEP = LIVE_STEP_MS[TF];
// #171: the sweep reads a 4-hour chart 0, 4 and 6 minutes after its close
const READ_AFTER = [0, 4, 6];
const mailed = (closeMs: number): boolean => READ_AFTER.some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
const CHECK_EVERY = 13;
// the 5-minute bars from this many days before START (p0)
const P0_DAYS = 60;

// the email's exit (#166, #173)
if (ULTRA_PAIRS.sl !== 30 || ULTRA_PAIRS.tp1 !== 20) throw new Error("ULTRA_PAIRS is not TP1 20, stop 30: the email's exit has moved");
const TP = ULTRA_PAIRS.tp1;
const SL = ULTRA_PAIRS.sl;
const LIMIT = 30;
// §8.83's trades: those with 120 bars in the data (check h)
const REPRO_NEED = 120;

// the candidates (X6, X30), and the told lines' own settings
const LS = [6, 30];
const TOP = 2;
const STALE = 120;
const IC_AHEAD = 6;
// the alignment gates (g1, tri)
const GRID_GATE = 0.005;
const TRI_MEDIAN = 1;
const TRI_FAR = 5;
const TRI_SLIP = 5;
// the placebo gate
const PLACEBO_GATE = 0.04;

const PAIRS = TRADED;
const LEGS = PAIRS.map(legsOf);
type Side = "BUY" | "SELL";
const sideOf = (x: 1 | -1): Side => (x === 1 ? "BUY" : "SELL");
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);

// ---- GMO's files (as research/prewarn.ts) ----------------------------------------------

const getJson = async (url: string): Promise<{ status: number; body: unknown }> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { status: 404, body: null };
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        continue;
      }
      return { status: r.status, body: await r.json() };
    } catch {
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  return { status: 0, body: null };
};
const sound = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; data?: unknown };
  return (b.status === 0 || b.status === 404) && Array.isArray(b.data);
};
const loadGmo = async (pair: string, tf: "5min" | "4h", fromMs: number): Promise<{ quotes: QuoteCandle[]; failed: number }> => {
  const step = LIVE_STEP_MS[tf];
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[tf];
  if (!symbol || !spec) throw new Error(`no GMO file for ${pair} ${tf}`);
  // the 5-minute bars in day files (the last three read again), the 4-hour
  // in year files (read again)
  let keys: string[];
  let fresh: Set<string>;
  if (spec.key === "day") {
    const today = jstDayKey(NOW);
    keys = dateKeys(fromMs, NOW, "day").filter((k) => k <= today);
    fresh = new Set(keys.slice(-3));
  } else {
    keys = [];
    for (let y = Number(jstYearKey(fromMs)); y <= Number(jstYearKey(NOW)); y++) keys.push(String(y));
    fresh = new Set(keys);
  }
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: typeof bid = [];
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      for (const side of ["bid", "ask"] as const) {
        const path = `${CACHE}/${symbol}/${spec.name}/${side}/${key}.json`;
        let body: unknown;
        if (!fresh.has(key)) {
          try {
            body = JSON.parse(await Deno.readTextFile(path));
          } catch {
            body = undefined;
          }
          if (body !== undefined && !sound(body)) body = undefined;
        }
        if (body === undefined) {
          const r = await getJson(klineUrl(symbol, side, spec.name, key));
          body = r.status === 404 ? { status: 404, data: [] } : r.body;
          if (r.status === 0 || !sound(body)) {
            failed++;
            continue;
          }
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await Deno.writeTextFile(path, JSON.stringify(body));
        }
        (side === "bid" ? bid : ask).push(...parseKlines(body));
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  const quotes = mergeSides(bid, ask).filter((q) => {
    const t = Date.parse(q.datetime);
    return Number.isFinite(t) && t >= fromMs && !isMarketClosed(t) && t + step <= NOW;
  });
  return { quotes, failed };
};

// ---- the 5-minute bars ------------------------------------------------------------------

interface Fine {
  n: number;
  t: Float64Array;
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
}
const newFine = (n: number): Fine => ({ n, t: new Float64Array(n), bo: new Float64Array(n), bh: new Float64Array(n), bl: new Float64Array(n), bc: new Float64Array(n), ao: new Float64Array(n), ah: new Float64Array(n), al: new Float64Array(n), ac: new Float64Array(n) });
const toFine = (qs: QuoteCandle[]): Fine => {
  const f = newFine(qs.length);
  qs.forEach((q, i) => {
    f.t[i] = barOpenMs(q.datetime);
    f.bo[i] = q.bid.open;
    f.bh[i] = q.bid.high;
    f.bl[i] = q.bid.low;
    f.bc[i] = q.bid.close;
    f.ao[i] = q.ask.open;
    f.ah[i] = q.ask.high;
    f.al[i] = q.ask.low;
    f.ac[i] = q.ask.close;
  });
  return f;
};
const lowerBound = (xs: ArrayLike<number>, ms: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < ms) lo = m + 1;
    else hi = m;
  }
  return lo;
};
// the chart's rounding (live-chart logic.ts decimalsOf and round)
const decimalsOf = (pair: string) => (pair.toUpperCase().includes("JPY") ? 3 : 5);
const roundTo = (v: number, d: number): number => Number(v.toFixed(d));

// ---- the walk "basket" (the header) ------------------------------------------------------

// each currency's yen value to start from (made up), its step's size and
// each pair's spread (pips; made up)
const LEVEL = [1, 150, 160, 190, 100, 90, 110, 170];
const AMP = [1.3, 1, 0.8, 1, 1.3, 1.3, 1, 0.8];
const SPREAD_PIPS: Record<string, number> = { "USD/JPY": 0.2, "EUR/JPY": 0.4, "GBP/JPY": 0.9, "AUD/JPY": 0.6, "NZD/JPY": 1.2, "CAD/JPY": 1.5, "CHF/JPY": 1.8, "EUR/USD": 0.3, "GBP/USD": 1.0, "AUD/USD": 0.5, "NZD/USD": 1.3 };
const SUB = 100;
// a pair of two 1× currencies about 2 pips a 5-minute bar on a 150-yen pair:
// the sd of 100 uniform steps of two is BASE × sqrt(200 / 12)
const BASE = 0.02 / 150 / Math.sqrt((2 * SUB) / 12);
const WEEK_SD = 0.3;
const TREND_FALL = Math.log(0.92);

// the walk's own ranking (not the program's: research/strength-lib.ts is
// not used here), for the positive control
const walkTopBottom = (now: Float64Array, before: Float64Array): { top: number[]; bottom: number[] } => {
  const r = Array.from(now, (x, c) => x - before[c]);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const order = r.map((x, c) => ({ s: x - mean, c })).sort((a, b) => b.s - a.s || a.c - b.c);
  return { top: [order[0].c, order[1].c], bottom: [order[NC - 1].c, order[NC - 2].c] };
};

const basket = (): Map<string, Fine> => {
  const r = rng(SEED);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  const from = Math.floor(Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) / FINE) * FINE;
  const times: number[] = [];
  for (let ms = from; ms + FINE <= NOW; ms += FINE) if (!isMarketClosed(ms)) times.push(ms);
  const n = times.length;
  const out = new Map<string, Fine>(PAIRS.map((p) => [p, newFine(n)]));
  const fines = PAIRS.map((p) => out.get(p)!);
  const half = PAIRS.map((p) => (SPREAD_PIPS[p] * ultraUnit(p)) / 2);
  const ratio = LEGS.map(([a, b]) => LEVEL[a] / LEVEL[b]);
  const v = new Float64Array(NC);
  const drift = new Float64Array(NC);
  // the trend walk: the yen's fall spread evenly over the second half's steps
  const secondSteps = times.filter((t) => t >= SPLIT_MS).length;
  const jpyFall = SYNTH === "trend" && secondSteps ? TREND_FALL / secondSteps / SUB : 0;
  // the rank walk: the kept 4-hour bars' closes (the load keeps a bar whose
  // open the market is not shut at)
  const closes: Float64Array[] = [];
  const dLog = (DELTA * 0.01) / 150 / (STEP / FINE) / SUB;
  let week = Number.NaN;
  let mult = 1;
  let bucket = Number.NaN;
  let bucketKept = false;
  const x = new Float64Array(PAIRS.length);
  const hi = new Float64Array(PAIRS.length);
  const lo = new Float64Array(PAIRS.length);
  for (let i = 0; i < n; i++) {
    const ms = times[i];
    const w = weekOf(ms);
    if (w !== week) {
      week = w;
      mult = Math.exp(WEEK_SD * gauss());
    }
    const bk = Math.floor(ms / STEP);
    if (bk !== bucket) {
      if (bucketKept) closes.push(Float64Array.from(v));
      bucket = bk;
      bucketKept = !isMarketClosed(bk * STEP);
      drift.fill(0);
      if (SYNTH === "rank" && closes.length > LSTAR) {
        const tb = walkTopBottom(closes[closes.length - 1], closes[closes.length - 1 - LSTAR]);
        for (const c of tb.top) drift[c] = dLog;
        for (const c of tb.bottom) drift[c] = -dLog;
      }
    }
    const fall = ms >= SPLIT_MS ? jpyFall : 0;
    for (let p = 0; p < PAIRS.length; p++) {
      x[p] = v[LEGS[p][0]] - v[LEGS[p][1]];
      hi[p] = x[p];
      lo[p] = x[p];
    }
    const open = Float64Array.from(x);
    for (let k = 0; k < SUB; k++) {
      for (let c = 0; c < NC; c++) v[c] += (r() - 0.5) * BASE * AMP[c] * mult + drift[c];
      v[0] += fall;
      for (let p = 0; p < PAIRS.length; p++) {
        const y = v[LEGS[p][0]] - v[LEGS[p][1]];
        if (y > hi[p]) hi[p] = y;
        if (y < lo[p]) lo[p] = y;
        x[p] = y;
      }
    }
    for (let p = 0; p < PAIRS.length; p++) {
      const f = fines[p];
      const m = ratio[p];
      const o = m * Math.exp(open[p]);
      const h = m * Math.exp(hi[p]);
      const l = m * Math.exp(lo[p]);
      const c = m * Math.exp(x[p]);
      const s = half[p];
      f.t[i] = ms;
      f.bo[i] = o - s;
      f.bh[i] = h - s;
      f.bl[i] = l - s;
      f.bc[i] = c - s;
      f.ao[i] = o + s;
      f.ah[i] = h + s;
      f.al[i] = l + s;
      f.ac[i] = c + s;
    }
  }
  return out;
};
// a walk's 4-hour bars from its 5-minute ones, on GMO's grid (0, 4, 8 … UTC),
// kept as the load keeps them
const fourHour = (f: Fine): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  let i = 0;
  while (i < f.n) {
    const open = Math.floor(f.t[i] / STEP) * STEP;
    let j = i;
    let bh = -Infinity;
    let bl = Infinity;
    let ah = -Infinity;
    let al = Infinity;
    while (j < f.n && f.t[j] < open + STEP) {
      bh = Math.max(bh, f.bh[j]);
      bl = Math.min(bl, f.bl[j]);
      ah = Math.max(ah, f.ah[j]);
      al = Math.min(al, f.al[j]);
      j++;
    }
    if (!isMarketClosed(open) && open + STEP <= NOW) {
      const dt = new Date(open).toISOString();
      out.push({ datetime: dt, bid: { datetime: dt, open: f.bo[i], high: bh, low: bl, close: f.bc[j - 1] }, ask: { datetime: dt, open: f.ao[i], high: ah, low: al, close: f.ac[j - 1] } });
    }
    i = j;
  }
  return out;
};

// ---- the checks -------------------------------------------------------------------------

const newCheck = () => ({ compared: 0, mismatched: 0, examples: [] as string[] });
type Check = ReturnType<typeof newCheck>;
const tally = (c: Check, ok: boolean, example: () => string) => {
  c.compared++;
  if (!ok) {
    c.mismatched++;
    if (c.examples.length < 10) c.examples.push(example());
  }
};
const checks = {
  identity: newCheck(), // (id)
  lookahead: newCheck(), // (la)
  again: newCheck(), // (c)
  levels: newCheck(), // (a2)
  follow: newCheck(), // (m)
  closes: newCheck(), // (d)
  pick: newCheck(), // (pk)
  closeMid: newCheck(), // (p0)
  signals: newCheck(), // (a)
};
let failedReads = 0;
// (p0, told) the 4-hour bars without a 5-minute bar ending at their close
const closeMidLast = newCheck();
let closeMidNone = 0;

// ---- the 4-hour bars of the eleven --------------------------------------------------------

interface Chart {
  pair: string;
  unit: number;
  candles: Candle[];
  times: Float64Array;
  qs: QuoteCandle[];
  byTime: Map<number, number>;
}
const walkFines = SYNTHETIC ? basket() : null;
const charts: Chart[] = [];
for (const pair of PAIRS) {
  const from = Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) - 9 * HOUR;
  let quotes: QuoteCandle[];
  if (walkFines) {
    quotes = fourHour(walkFines.get(pair)!).filter((q) => barOpenMs(q.datetime) >= from);
    // MISALIGN: USD/JPY without one of its bars (the meter then joins AUD/JPY
    // by position below)
    if (FAULT === "MISALIGN" && pair === "USD/JPY") quotes = quotes.filter((_q, i) => i !== 1000);
  } else {
    const got = await loadGmo(pair, TF, from);
    failedReads += got.failed;
    quotes = got.quotes;
  }
  const candles = historyRead(pair, TF, quotes, NOW).candles;
  const byOpen = new Map(quotes.map((q) => [barOpenMs(q.datetime), q]));
  const times = Float64Array.from(candles, (c) => barOpenMs(c.datetime));
  const qs = Array.from(times, (t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);
  charts.push({ pair, unit: ultraUnit(pair), candles, times, qs, byTime: new Map(Array.from(times, (t, i) => [t, i])) });
}
const chartOf = (pair: string) => charts[PAIRS.indexOf(pair)];
const crossCharts = CROSSES.map(chartOf);

// ---- the alignment (g1, tri): before anything else ----------------------------------------

const align: { grid: Record<string, { lacks: number; share: number; offGrid: number; examples: string[] }>; union: number; tri: Record<string, { n: number; median: number; far: number; farShare: number; max: number; slipMedians: number[]; examples: string[] }>; triBars: Array<{ t: string; rel: number[] }>; stopped: string[] } = { grid: {}, union: 0, tri: {}, triBars: [], stopped: [] };
{
  const union = new Set<number>();
  for (const c of crossCharts) for (const t of c.times) union.add(t);
  align.union = union.size;
  for (const ch of charts) {
    const offGrid = Array.from(ch.times).filter((t) => t % STEP !== 0).length;
    const isCross = CROSSES.includes(ch.pair);
    const lacking = isCross ? [...union].filter((t) => !ch.byTime.has(t)).sort((a, b) => a - b) : [];
    const share = isCross ? lacking.length / union.size : 0;
    align.grid[ch.pair] = { lacks: lacking.length, share, offGrid, examples: lacking.slice(0, 10).map(iso) };
    if (offGrid > 0) align.stopped.push(`(g1) ${ch.pair}: ${offGrid} bars not opening at 0, 4, 8, 12, 16 or 20 UTC`);
    if (share > GRID_GATE) align.stopped.push(`(g1) ${ch.pair} lacks ${(100 * share).toFixed(2)}% of the crosses' times`);
  }
}
const G = gridOf(crossCharts.map((c) => c.times));
const nG = G.length;
const T_OF = (k: number) => G[k] + STEP;
const gIndex = new Map(G.map((t, k) => [t, k]));
// each cross's close at each G bar (by time)
const closeAt = crossCharts.map((ch) => Float64Array.from(G, (t) => ch.candles[ch.byTime.get(t)!].close));
// G's bars where a dollar pair is over TRI_FAR pips off the triangle (told)
const triFlag = new Uint8Array(nG);
{
  const uj = closeAt[0];
  for (const pair of ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"]) {
    const ch = chartOf(pair);
    const x = closeAt[CROSSES.indexOf(`${pair.slice(0, 3)}/JPY`)];
    const res = (shift: number) => {
      const out: number[] = [];
      for (let k = 0; k < nG; k++) {
        const i = ch.byTime.get(G[k]);
        const ku = k + shift;
        if (i === undefined || ku < 0 || ku >= nG) continue;
        out.push(Math.abs(ch.candles[i].close - x[k] / uj[ku]) / ch.unit);
      }
      return out.sort((a, b) => a - b);
    };
    const r0 = res(0);
    const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : Number.NaN);
    const far = r0.filter((d) => d > TRI_FAR).length;
    const slips = [res(-1), res(1)].map(med);
    const examples: string[] = [];
    for (let k = 0; k < nG && examples.length < 10; k++) {
      const i = ch.byTime.get(G[k]);
      if (i === undefined) continue;
      const d = Math.abs(ch.candles[i].close - x[k] / uj[k]) / ch.unit;
      if (d > TRI_FAR) examples.push(`${iso(G[k])} ${d.toFixed(1)}`);
    }
    align.tri[pair] = { n: r0.length, median: med(r0), far, farShare: r0.length ? far / r0.length : 0, max: r0.length ? r0[r0.length - 1] : Number.NaN, slipMedians: slips, examples };
    if (!(med(r0) <= TRI_MEDIAN)) align.stopped.push(`(tri) ${pair}: median ${med(r0).toFixed(2)} pips`);
    // the share over TRI_FAR pips: told, not a gate (the header: changed
    // after the data's prices were seen, before any trade)
    if (!slips.every((m) => m >= TRI_SLIP * Math.max(med(r0), 1e-9))) align.stopped.push(`(tri) ${pair}: one bar off, the median ${slips.map((m) => m.toFixed(2)).join(" / ")} against ${med(r0).toFixed(2)}: the check cannot see a slip`);
  }
  // every bar where a dollar pair is over TRI_FAR, with the four pairs'
  // signed residuals relative to their own close (in 1e-4): the same on all
  // four points at USD/JPY, the leg they share (prices only; told)
  const usd = ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"];
  for (let k = 0; k < nG; k++) {
    const rel = usd.map((pair) => {
      const ch = chartOf(pair);
      const i = ch.byTime.get(G[k]);
      if (i === undefined) return Number.NaN;
      const implied = closeAt[CROSSES.indexOf(`${pair.slice(0, 3)}/JPY`)][k] / uj[k];
      return ((ch.candles[i].close - implied) / ch.candles[i].close) * 1e4;
    });
    const far = usd.some((pair, j) => Number.isFinite(rel[j]) && Math.abs(rel[j] * chartOf(pair).candles[chartOf(pair).byTime.get(G[k])!].close) > TRI_FAR);
    if (far) {
      align.triBars.push({ t: iso(G[k]), rel: rel.map((r) => Number(r.toFixed(2))) });
      triFlag[k] = 1;
    }
  }
}
const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pctOf = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "  -  " : `${(100 * x).toFixed(1)}%`);
console.log(`\n#174 currency strength, ${START} .. ${iso(NOW)} (halves at ${SPLIT}); the email's exit TP1 ${TP}, stop ${SL}, ${LIMIT} bars${SYNTHETIC ? `; SYNTHETIC ${SYNTH}${SYNTH === "rank" ? ` L* ${LSTAR} δ ${DELTA}` : ""} seed ${SEED}${FAULT ? ` FAULT ${FAULT}` : ""}` : ""}`);
console.log(`\n== ALIGNMENT (before any trade)`);
console.log(`(g1) the crosses' times: ${align.union}; G (all seven): ${nG}`);
for (const [pair, g] of Object.entries(align.grid)) console.log(`  ${pair.padEnd(8)} off the grid ${g.offGrid}${CROSSES.includes(pair) ? `, lacks ${g.lacks} (${pctOf(g.share)})${g.examples.length ? ": " + g.examples.join(", ") : ""}` : ""}`);
for (const [pair, t] of Object.entries(align.tri)) console.log(`(tri) ${pair.padEnd(8)} ${t.n} bars: median ${t.median.toFixed(3)} pips, over ${TRI_FAR} ${t.far} (${pctOf(t.farShare)}), max ${t.max.toFixed(2)}; USD/JPY one bar off: medians ${t.slipMedians.map((m) => m.toFixed(2)).join(" / ")}${t.examples.length ? "; " + t.examples.join(", ") : ""}`);
if (align.triBars.length) {
  // by month, and the bars themselves (the four dollar pairs' residuals, 1e-4
  // of their own close: EUR/USD, GBP/USD, AUD/USD, NZD/USD)
  const byMonth = new Map<string, number>();
  for (const b of align.triBars) byMonth.set(b.t.slice(0, 7), (byMonth.get(b.t.slice(0, 7)) ?? 0) + 1);
  const fromMs = START_MS - P0_DAYS * DAY;
  const inStudy = align.triBars.filter((b) => Date.parse(`${b.t.replace(" ", "T")}Z`) >= fromMs).length;
  console.log(`(tri) bars with a dollar pair over ${TRI_FAR} pips: ${align.triBars.length} (from ${P0_DAYS} days before START: ${inStudy}); by month: ${[...byMonth].map(([m, n]) => `${m} ${n}`).join(", ")}`);
  for (const b of align.triBars) console.log(`  ${b.t}  ${b.rel.map((r) => (r >= 0 ? "+" : "") + r.toFixed(2)).join("  ")}`);
}
const stopEarly = async () => {
  console.log(`\nSTOPPED before any trade was followed:\n  ${align.stopped.join("\n  ")}`);
  await Deno.mkdir(OUT, { recursive: true });
  await Deno.writeTextFile(`${OUT}/strength${SYNTHETIC ? `-${SYNTH}${FAULT ? "-" + FAULT : ""}-${SEED}` : ""}.json`, JSON.stringify({ stopped: align.stopped, align, failedReads }));
  Deno.exit(2);
};
if (align.stopped.length) await stopEarly();

// ---- the meter ---------------------------------------------------------------------------

// v by time (the program's): the log of each cross's close at G's bars
const vTrue: Values = [new Float64Array(nG), ...closeAt.map((cl) => Float64Array.from(cl, Math.log))];
let v: Values = vTrue;
if (FAULT === "LOOKAHEAD") {
  // the meter reading the close after
  v = vTrue.map((a) => Float64Array.from(a, (_x, k) => a[Math.min(k + 1, nG - 1)]));
}
if (FAULT === "MISALIGN") {
  // AUD/JPY joined by position from G's first bar
  const ch = chartOf("AUD/JPY");
  const i0 = ch.byTime.get(G[0])!;
  v = vTrue.slice();
  v[CURRENCIES.indexOf("AUD")] = Float64Array.from(G, (_t, k) => Math.log(ch.candles[Math.min(i0 + k, ch.candles.length - 1)].close));
}
// ORIENT: EUR/USD's state the wrong way round
const RULE_LEGS: Array<[number, number]> = LEGS.map(([a, b], p) => (FAULT === "ORIENT" && PAIRS[p] === "EUR/USD" ? [b, a] : [a, b]));

// where a fire may be taken: in the period, mailed, the pair's own bar
const table: Table = newTable(nG, PAIRS.length);
for (let k = 0; k < nG; k++) {
  const T = T_OF(k);
  table.week[k] = weekOf(T);
  table.half[k] = T < START_MS || T > NOW ? -1 : T < SPLIT_MS ? 0 : 1;
}
const ownBar = (p: number, k: number) => charts[p].byTime.get(G[k]);
for (let p = 0; p < PAIRS.length; p++) {
  for (let k = 0; k < nG; k++) {
    if (table.half[k] >= 0 && mailed(T_OF(k)) && ownBar(p, k) !== undefined) table.ok[p * nG + k] = 1;
  }
}
const okAt = (p: number, k: number) => table.ok[p * nG + k] === 1;

const ranks = new Map(LS.map((L) => [L, ranksFor(v, L)]));
const firesX = new Map(LS.map((L) => [L, rankFires(ranks.get(L)!, RULE_LEGS, table, TOP)]));

// (id): Σ s = 0, and s_c − s_JPY against the cross's own candles
{
  const s = new Float64Array(NC);
  for (const L of LS) {
    for (let k = L; k < nG; k++) {
      strengthAt(v, k, L, s);
      const sum = s.reduce((a, b) => a + b, 0);
      let ok = Math.abs(sum) <= 1e-12;
      let worst = "";
      for (let c = 1; c < NC && ok; c++) {
        const ch = crossCharts[c - 1];
        const own = Math.log(ch.candles[ch.byTime.get(G[k])!].close / ch.candles[ch.byTime.get(G[k - L])!].close);
        if (Math.abs(s[c] - s[0] - own) > 1e-12) {
          ok = false;
          worst = `${CURRENCIES[c]} ${s[c] - s[0]} / ${own}`;
        }
      }
      tally(checks.identity, ok, () => `L${L} ${iso(G[k])} Σ ${sum} ${worst}`);
    }
  }
}

// (la): a second, plain working from each cross's candles cut at T_k, its
// own grid from them (walked back from the last bar closed by then)
const plainAt = (T: number, L: number): { t: number; s: number[]; sPrev: number[] } | null => {
  const need = L + 2;
  const ptr = crossCharts.map((ch) => lowerBound(ch.times, T - STEP + 1) - 1);
  const common: number[][] = [];
  const at: number[] = [];
  while (common.length < need) {
    if (ptr.some((q) => q < 0)) return null;
    const tops = ptr.map((q, c) => crossCharts[c].times[q]);
    const least = Math.min(...tops);
    if (tops.every((t) => t === least)) {
      common.push(ptr.map((q, c) => crossCharts[c].candles[q].close));
      at.push(least);
      for (let c = 0; c < ptr.length; c++) ptr[c]--;
    } else {
      for (let c = 0; c < ptr.length; c++) if (tops[c] > least) ptr[c]--;
    }
  }
  const strengths = (a: number, b: number) => {
    // the yen first, its value 1 throughout
    const r = [0, ...common[a].map((x, c) => Math.log(x) - Math.log(common[b][c]))];
    const mean = r.reduce((x, y) => x + y, 0) / r.length;
    return r.map((x) => x - mean);
  };
  return { t: at[0], s: strengths(0, L), sPrev: strengths(1, L + 1) };
};
const plainRanks = (s: number[]) => s.map((x, c) => 1 + s.filter((y, d) => y > x || (y === x && d < c)).length);
const plainState = (r: number[], a: number, b: number) => (r[a] <= TOP && r[b] >= NC + 1 - TOP ? 1 : r[a] >= NC + 1 - TOP && r[b] <= TOP ? -1 : 0);
{
  const firesAt = new Map(LS.map((L) => [L, new Set(firesX.get(L)!.map((f) => `${f.p}:${f.k}:${f.side}`))]));
  const toCheck = new Set<number>();
  for (const L of LS) for (const f of firesX.get(L)!) toCheck.add(f.k);
  for (let k = 0; k < nG; k += CHECK_EVERY) toCheck.add(k);
  const s = new Float64Array(NC);
  for (const k of [...toCheck].sort((a, b) => a - b)) {
    for (const L of LS) {
      if (k - L - 1 < 0) continue;
      const pl = plainAt(T_OF(k), L);
      const bad: string[] = [];
      if (!pl) bad.push("no plain working");
      else {
        if (pl.t !== G[k]) bad.push(`its last bar ${iso(pl.t)}`);
        strengthAt(v, k, L, s);
        for (let c = 0; c < NC; c++) if (Math.abs(s[c] - pl.s[c]) > 1e-12) bad.push(`s ${CURRENCIES[c]} ${s[c]} / ${pl.s[c]}`);
        const rk = ranks.get(L)!;
        const pr = plainRanks(pl.s);
        const pp = plainRanks(pl.sPrev);
        for (let c = 0; c < NC; c++) if (rk[k * NC + c] !== pr[c]) bad.push(`rank ${CURRENCIES[c]} ${rk[k * NC + c]} / ${pr[c]}`);
        for (let p = 0; p < PAIRS.length; p++) {
          const [a, b] = LEGS[p];
          const now = plainState(pr, a, b);
          const prev = plainState(pp, a, b);
          const mine = rankState(rk, k, RULE_LEGS[p][0], RULE_LEGS[p][1], TOP);
          const minePrev = rankState(rk, k - 1, RULE_LEGS[p][0], RULE_LEGS[p][1], TOP);
          if (mine !== now || minePrev !== prev) bad.push(`${PAIRS[p]} states ${minePrev}→${mine} / ${prev}→${now}`);
          // whether a fire may be taken, worked again here: the close in the
          // period, mailed, and the pair's own bar at the plain grid's last
          const T = pl.t + STEP;
          const own = charts[p].times;
          const at = lowerBound(own, pl.t);
          const mayFire = T >= START_MS && T <= NOW && mailed(T) && at < own.length && own[at] === pl.t;
          // the side the plain working signals, against the side the program
          // fired (either way: a fire where the state is 0 counts too)
          const plainSide = now !== 0 && now !== prev && mayFire ? now : 0;
          const fs = firesAt.get(L)!;
          const progSide = fs.has(`${p}:${k}:1`) ? 1 : fs.has(`${p}:${k}:-1`) ? -1 : 0;
          if (plainSide !== progSide) bad.push(`${PAIRS[p]} signals ${progSide} / ${plainSide}`);
        }
      }
      tally(checks.lookahead, bad.length === 0, () => `L${L} ${iso(G[k])}: ${bad.slice(0, 3).join("; ")}`);
    }
  }
}

// ---- the coin, the emails, and the meter's trades followed again, pair by pair -----------

type Exit = 1 | 2 | 3 | 4; // tp, sl, amb (both in one bar: the stop), time
const EXITS = ["", "tp", "sl", "amb", "time"];
interface Trade {
  pips: number;
  exit: Exit;
  // the levels the trade used (a2)
  tp: number;
  sl: number;
}
const exitB = new Int8Array(nG * PAIRS.length);
const exitS = new Int8Array(nG * PAIRS.length);
const store = new Map<string, Agg>();
const put = (series: string, half: 0 | 1, week: number, x: number) => {
  const k = `${series}|${half}`;
  let a = store.get(k);
  if (!a) {
    a = newAgg();
    store.set(k, a);
  }
  addTo(a, week, x);
};
const aggAt = (series: string, half: 0 | 1 | "full"): Agg | undefined => (half === "full" ? mergeAggs([store.get(`${series}|0`), store.get(`${series}|1`)]) : store.get(`${series}|${half}`));
const exitCounts = new Map<string, number[]>();
const countExit = (series: string, e: Exit) => {
  const c = exitCounts.get(series) ?? [0, 0, 0, 0, 0];
  c[e]++;
  exitCounts.set(series, c);
};
const reproAgg = [newAgg(), newAgg()];
interface Cover {
  pair: string;
  bars: number;
  inG: number;
  ok: number;
  coin: number;
  signals: number;
}
const coverage: Cover[] = [];

// (pk)'s own data, cut at SPLIT: the crosses' candles closed by then, their
// own grid and meter, and a coin followed on the bars closed by then only
// (filled in the pair loop): a first-half trade that reads past SPLIT is
// then missing from it
const cutCross = crossCharts.map((ch) => {
  const m = lowerBound(ch.times, SPLIT_MS - STEP + 1);
  return { times: ch.times.subarray(0, m), close: new Map(Array.from(ch.times.subarray(0, m), (t, i) => [t, ch.candles[i].close])) };
});
const Gc = gridOf(cutCross.map((c) => c.times));
const vCut: Values = [new Float64Array(Gc.length), ...cutCross.map((c) => Float64Array.from(Gc, (t) => Math.log(c.close.get(t)!)))];
const tCut: Table = newTable(Gc.length, PAIRS.length);
for (let k = 0; k < Gc.length; k++) {
  const T = Gc[k] + STEP;
  tCut.week[k] = weekOf(T);
  tCut.half[k] = T < START_MS || T > NOW ? -1 : T < SPLIT_MS ? 0 : 1;
  for (let p = 0; p < PAIRS.length; p++) {
    const own = charts[p].times;
    const at = lowerBound(own, Gc[k]);
    if (tCut.half[k] >= 0 && mailed(T) && at < own.length && own[at] === Gc[k] && own[at] + STEP <= SPLIT_MS) tCut.ok[p * Gc.length + k] = 1;
  }
}

for (let p = 0; p < PAIRS.length; p++) {
  const pair = PAIRS[p];
  const ch = charts[p];
  const { unit, candles, times, qs } = ch;
  const n = candles.length;
  let fine: Fine;
  if (walkFines) fine = walkFines.get(pair)!;
  else {
    // from 60 days before START, so (p0) also sees the bars before START the
    // meter reads (L 30, and the stale meter's 120 bars before)
    const got = await loadGmo(pair, "5min", START_MS - P0_DAYS * DAY);
    failedReads += got.failed;
    fine = toFine(got.quotes);
  }
  const dec = decimalsOf(pair);

  // a trade at bar i's close (a buy at the ask, a sell at the bid), TP1 and
  // the stop from the mid close, followed on the 5-minute bid/ask until the
  // close of bar i + LIMIT (as research/widetp.ts tradeAt); null when its 30
  // bars are not all in the data. `nb` and `fn`: the 4-hour and 5-minute
  // bars it may read (all, or those closed by SPLIT for (pk)); `closeMs`:
  // the close as the caller has it from elsewhere (G, or the quote), (m)
  const followOn = (nb: number, fn: number, main: boolean) => (i: number, side: Side, closeMs: number): Trade | null => {
    if (i + LIMIT >= nb) return null;
    const T = times[i] + STEP;
    const buy = side === "BUY";
    const dir = buy ? 1 : -1;
    const close = candles[i].close;
    const tp = close + dir * TP * unit;
    const sl = close - dir * SL * unit;
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const pipsOf = (x: number) => (buy ? x - fill : fill - x) / unit;
    const o = buy ? fine.bo : fine.ao;
    const h = buy ? fine.bh : fine.ah;
    const l = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    let f = lowerBound(fine.t, T);
    if (f >= fn) return null;
    const f0 = f;
    // (m) the trade is entered at the close the caller has (T_k from G, or
    // the quote's own), and followed from the first 5-minute bar opening at
    // or after it
    if (main) tally(checks.follow, T === closeMs && fine.t[f0] >= closeMs && (f0 === 0 || fine.t[f0 - 1] < closeMs), () => `${pair} ${iso(closeMs)}: entered at ${iso(T)}, follows from ${iso(fine.t[f0])}`);
    for (let j = i + 1; j <= i + LIMIT; j++) {
      const end = times[j] + STEP;
      while (f < fn && fine.t[f] < end) {
        if (buy ? o[f] <= sl : o[f] >= sl) return { pips: pipsOf(o[f]), exit: 2, tp, sl };
        if (buy ? o[f] >= tp : o[f] <= tp) return { pips: pipsOf(o[f]), exit: 1, tp, sl };
        const hitSl = buy ? l[f] <= sl : h[f] >= sl;
        const hitTp = buy ? h[f] >= tp : l[f] <= tp;
        if (hitSl && hitTp) return { pips: pipsOf(sl), exit: 3, tp, sl };
        if (hitSl) return { pips: pipsOf(sl), exit: 2, tp, sl };
        if (hitTp) return { pips: pipsOf(tp), exit: 1, tp, sl };
        f++;
      }
      if (f >= fn && fine.t[fn - 1] + FINE < end) return null;
      if (j === i + LIMIT) {
        // no 5-minute bar in the whole 30 (as research/prewarn.ts follow)
        if (f === f0) return null;
        const closePx = c[f - 1];
        const own = buy ? qs[j].bid.close : qs[j].ask.close;
        // (d) the time-out's close against the 4-hour bar's own
        if (main) tally(checks.closes, Math.abs(closePx - own) <= unit / 1000, () => `${pair} ${iso(times[j])} ${side} ${closePx}/${own}`);
        return { pips: pipsOf(closePx), exit: 4, tp, sl };
      }
    }
    return null;
  };
  const follow = followOn(n, fine.n, true);
  // what a follow has with the data cut at SPLIT (the 4-hour bars closed by
  // then, the 5-minute bars ended by then), for (pk)
  const followCut = followOn(lowerBound(times, SPLIT_MS - STEP + 1), lowerBound(fine.t, SPLIT_MS - FINE + 1), false);
  const quoteClose = (i: number) => barOpenMs(qs[i].datetime) + STEP;

  // the coin at every G bar a fire may be taken at
  let inG = 0;
  let nOk = 0;
  let nCoin = 0;
  for (let k = 0; k < nG; k++) {
    const i = ownBar(p, k);
    if (i === undefined) continue;
    inG++;
    const T = T_OF(k);
    // (p0) the 5-minute bar ending at the close: its mid close, rounded
    if (T <= NOW) {
      const fz = lowerBound(fine.t, T - FINE);
      if (fz < fine.n && fine.t[fz] === T - FINE) {
        const mid = roundTo((fine.bc[fz] + fine.ac[fz]) / 2, dec);
        tally(checks.closeMid, mid === candles[i].close, () => `${pair} ${iso(times[i])} 5-minute mid ${mid} / close ${candles[i].close}`);
      } else if (fz > 0 && fine.t[fz - 1] >= G[k]) {
        // (p0, told) no 5-minute bar ends at the close (the week's last bar,
        // whose 5-minute bars stop at the market's close): the last one
        // inside the bar
        const mid = roundTo((fine.bc[fz - 1] + fine.ac[fz - 1]) / 2, dec);
        tally(closeMidLast, mid === candles[i].close, () => `${pair} ${iso(times[i])} the last 5-minute mid ${mid} (${iso(fine.t[fz - 1])}) / close ${candles[i].close}`);
      } else closeMidNone++;
    }
    if (!okAt(p, k)) continue;
    nOk++;
    const b = follow(i, "BUY", T);
    const s = follow(i, "SELL", T);
    if (!b || !s) continue;
    nCoin++;
    const at = p * nG + k;
    table.buy[at] = b.pips;
    table.sell[at] = s.pips;
    exitB[at] = b.exit;
    exitS[at] = s.exit;
    if (table.half[k] === 0 && times[i + LIMIT] + STEP <= SPLIT_MS) table.pickable[at] = 1;
  }
  // (pk): the coin again on the bars closed by SPLIT; a trade there is one
  // the pick may take, and it must be the same trade
  for (let k = 0; k < Gc.length; k++) {
    const atCut = p * Gc.length + k;
    if (!tCut.ok[atCut]) continue;
    const i = ch.byTime.get(Gc[k])!;
    const T = Gc[k] + STEP;
    const b = followCut(i, "BUY", T);
    const s = followCut(i, "SELL", T);
    const kk = gIndex.get(Gc[k]);
    const at = kk === undefined ? -1 : p * nG + kk;
    const inCut = b !== null && s !== null && tCut.half[k] === 0;
    if (inCut) {
      tCut.buy[atCut] = b.pips;
      tCut.sell[atCut] = s.pips;
      tCut.pickable[atCut] = 1;
    }
    const same = at >= 0 && (table.pickable[at] === 1) === inCut && (!inCut || (table.buy[at] === b.pips && table.sell[at] === s.pips));
    tally(checks.pick, same, () => `${pair} ${iso(Gc[k])}: pickable ${at >= 0 ? table.pickable[at] : "-"}, on the bars cut at SPLIT ${inCut ? `${b!.pips}/${s!.pips}` : "none"}`);
  }

  // (c) and (a2): the meter's trades followed again, and their levels
  // against the email's own
  for (const L of LS) {
    for (const f of firesX.get(L)!) {
      if (f.p !== p) continue;
      const i = ownBar(p, f.k)!;
      const side = sideOf(f.side);
      const again = follow(i, side, T_OF(f.k));
      const at = p * nG + f.k;
      const want = f.side === 1 ? table.buy[at] : table.sell[at];
      tally(checks.again, again === null ? Number.isNaN(want) : again.pips === want && again.exit === (f.side === 1 ? exitB[at] : exitS[at]), () => `${pair} ${iso(times[i])} ${side} ${again?.pips} / ${want}`);
      const close = candles[i].close;
      const dir = f.side;
      const lv = ultraLevels(side, close, unit, ULTRA_PAIRS);
      // the levels the trade used, against the email's own (and the close's
      // ∓ 30 and ± 20 worked here)
      // (none where the trade has no 30 bars in the data: (c) sees that)
      if (again) tally(checks.levels, again.sl === lv.sl && again.tp === lv.tps[0] && lv.sl === close - dir * SL * unit && lv.tps[0] === close + dir * TP * unit, () => `${pair} ${iso(times[i])} ${side} used sl ${again.sl} tp ${again.tp}; ultraLevels sl ${lv.sl} tp ${lv.tps[0]}`);
    }
  }

  // the emails' signals (as research/widetp.ts): on the bars the sweep judges
  const anchorOf = (i: number): { ws: number; s: number } | null => {
    if (i < WINDOW - 1) return null;
    const ws = i - WINDOW + 1;
    const w = times.subarray(ws, i + 1) as unknown as number[];
    const last = i - ws;
    const firstShown = Math.max(0, last - (CHART_BARS - 1));
    return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
  };
  const judgedBar = new Uint8Array(n);
  const signals: Array<{ i: number; rule: "qtrend" | "ultra"; side: Side; strong: boolean }> = [];
  let seg: { s: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!seg) return;
    const bars = candles.slice(seg.s, seg.to + 1);
    const qt = qTrend(bars, QT_DEFAULTS, bars.length - 1);
    for (const x of qt.signals) {
      const at = seg.s + x.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "qtrend", side: x.side, strong: x.strong });
    }
    const ul = ultra(bars, bars.length - 1, unit, ULTRA_PAIRS);
    for (const tr of ul.trades) {
      const at = seg.s + tr.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "ultra", side: tr.side, strong: false });
    }
    seg = null;
  };
  for (let i = 0; i < n; i++) {
    if (times[i] + STEP < START_MS) continue;
    const a = anchorOf(i);
    if (!a) {
      flush();
      continue;
    }
    judgedBar[i] = 1;
    if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
    else {
      flush();
      seg = { s: a.s, from: i, to: i };
    }
  }
  flush();
  // (a) against the email's own function, on every 13th bar and every bar
  // with a signal
  {
    const mine = new Map<number, string[]>();
    for (const s of signals) mine.set(s.i, [...(mine.get(s.i) ?? []), `${s.rule}:${s.side}:${s.strong ? "S" : "-"}`]);
    const toCheck = new Set<number>(signals.map((s) => s.i));
    for (let i = 0; i < n; i += CHECK_EVERY) toCheck.add(i);
    for (const i of [...toCheck].sort((x, y) => x - y)) {
      if (!judgedBar[i]) continue;
      const a = anchorOf(i)!;
      const xs = indicatorSignals(pair, TF, candles.slice(a.ws, i + 1), times[i] + STEP + 60_000, 120_000).filter((x) => Date.parse(x.barTime) === times[i]);
      const theirs = xs.map((x) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`).sort().join(",");
      const ours = (mine.get(i) ?? []).sort().join(",");
      tally(checks.signals, theirs === ours, () => `${pair} ${iso(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
    }
  }
  // (h) §8.83's T20: the email's trades, one a bar and side, those with 120
  // bars in the data
  {
    const seen = new Set<string>();
    for (const s of signals) {
      const T = times[s.i] + STEP;
      if (!mailed(T) || s.i + REPRO_NEED >= n) continue;
      const key = `${s.i}:${s.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = follow(s.i, s.side, quoteClose(s.i));
      if (t) addTo(reproAgg[T < SPLIT_MS ? 0 : 1], weekOf(T), t.pips);
    }
  }
  // the emails (told): their trades (those with 30 bars in the data), e at
  // their own closes, and the meter's label at each
  {
    const sEach = LS.map(() => new Float64Array(NC));
    for (const rule of ["either", "qtrend", "ultra"] as const) {
      const seen = new Set<string>();
      for (const s of signals) {
        if (rule !== "either" && s.rule !== rule) continue;
        const T = times[s.i] + STEP;
        if (T > NOW || !mailed(T)) continue;
        const key = `${s.i}:${s.side}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const t = follow(s.i, s.side, quoteClose(s.i));
        const o = follow(s.i, s.side === "BUY" ? "SELL" : "BUY", quoteClose(s.i));
        if (!t || !o) continue;
        const half: 0 | 1 = T < SPLIT_MS ? 0 : 1;
        const w = weekOf(T);
        const e = (t.pips - o.pips) / 2;
        put(`em ${rule} pips`, half, w, t.pips);
        put(`em ${rule} e`, half, w, e);
        const k = gIndex.get(times[s.i]);
        LS.forEach((L, li) => {
          let label = "no meter";
          if (k !== undefined && strengthAt(v, k, L, sEach[li])) {
            const [a, b] = LEGS[p];
            const sa = sEach[li][a];
            const sb = sEach[li][b];
            const dir = s.side === "BUY" ? 1 : -1;
            label = dir * sa > 0 && dir * sb < 0 ? "agree" : dir * sa < 0 && dir * sb > 0 ? "against" : "mixed";
          }
          put(`em ${rule} L${L} ${label} pips`, half, w, t.pips);
          put(`em ${rule} L${L} ${label} e`, half, w, e);
        });
      }
    }
  }
  coverage.push({ pair, bars: n, inG, ok: nOk, coin: nCoin, signals: signals.length });
  console.log(`${pair}: ${n} 4-hour bars, in G ${inG}, closes a fire may be taken at ${nOk}, the coin at ${nCoin}; the emails' signals ${signals.length}`);
}

// ---- the meter's trades, and the told lines -------------------------------------------------

const quarterOf = (T: number) => Math.min(3, Math.max(0, Math.floor((4 * (T - SPLIT_MS)) / (NOW - SPLIT_MS))));
// a rule's trades into the store: pips and e by half; by pair, side, and
// (the second half) quarter; leave one currency out
const keep = (name: string, fires: Fire[], detail: boolean) => {
  let lost = 0;
  for (const f of fires) {
    const at = f.p * nG + f.k;
    const b = table.buy[at];
    const s = table.sell[at];
    if (Number.isNaN(b) || Number.isNaN(s)) {
      lost++;
      continue;
    }
    const T = T_OF(f.k);
    const half = table.half[f.k] as 0 | 1;
    const w = table.week[f.k];
    const pips = f.side === 1 ? b : s;
    const e = edgeOf(b, s, f.side);
    put(`${name} pips`, half, w, pips);
    put(`${name} e`, half, w, e);
    put(`${name} coin`, half, w, (b + s) / 2);
    countExit(`${name}|${half}`, (f.side === 1 ? exitB[at] : exitS[at]) as Exit);
    if (!detail) continue;
    put(`${name} e @${PAIRS[f.p]}`, half, w, e);
    put(`${name} e ${sideOf(f.side)}`, half, w, e);
    if (half === 1) put(`${name} e q${quarterOf(T) + 1}`, 1, w, e);
    for (let c = 0; c < NC; c++) if (LEGS[f.p][0] !== c && LEGS[f.p][1] !== c) put(`${name} e -${CURRENCIES[c]}`, half, w, e);
  }
  return lost;
};
const lostX = new Map<number, number>();
for (const L of LS) lostX.set(L, keep(`X${L}`, firesX.get(L)!, true));
// told: the same without the fires whose meter reads a bar off the triangle
// by more than TRI_FAR pips (k, k − 1, k − L, k − 1 − L)
const offTri = new Map<number, number>();
for (const L of LS) {
  const reads = (k: number) => [k, k - 1, k - L, k - 1 - L].some((j) => j >= 0 && triFlag[j] === 1);
  const clean = firesX.get(L)!.filter((f) => !reads(f.k));
  offTri.set(L, firesX.get(L)!.length - clean.length);
  keep(`X${L}c`, clean, false);
}
// top one and bottom one; M; the stale meter
for (const L of LS) {
  keep(`T1_${L}`, rankFires(ranks.get(L)!, RULE_LEGS, table, 1), false);
  keep(`M${L}`, firesOf((p, k) => momentumState(v, k, L, RULE_LEGS[p][0], RULE_LEGS[p][1]), PAIRS.length, nG, okAt), false);
  keep(`S${L}`, rankFires(ranks.get(L)!, RULE_LEGS, table, TOP, STALE), true);
}
// the coin at every close it has
for (let p = 0; p < PAIRS.length; p++) {
  for (let k = 0; k < nG; k++) {
    const at = p * nG + k;
    if (Number.isNaN(table.buy[at])) continue;
    const half = table.half[k] as 0 | 1;
    put("coin all", half, table.week[k], (table.buy[at] + table.sell[at]) / 2);
    put(`coin @${PAIRS[p]}`, half, table.week[k], (table.buy[at] + table.sell[at]) / 2);
    countExit(`coin @${PAIRS[p]}`, exitB[at] as Exit);
    countExit(`coin @${PAIRS[p]}`, exitS[at] as Exit);
  }
}
// the rank IC, the shares of the top and bottom two, ties, and the hours a
// lookback spans
const shares = new Map<number, { top: number[]; bottom: number[]; bars: number }>();
const ties = new Map<number, number>();
const spans = new Map<number, number[]>();
{
  const s = new Float64Array(NC);
  const ahead = new Float64Array(NC);
  for (const L of LS) {
    const sh = { top: new Array(NC).fill(0), bottom: new Array(NC).fill(0), bars: 0 };
    let tie = 0;
    const sp: number[] = [];
    const rk = ranks.get(L)!;
    for (let k = L; k < nG; k++) {
      if (table.half[k] < 0) continue;
      strengthAt(v, k, L, s);
      if (tiesOf(s) > 0) tie++;
      sh.bars++;
      for (let c = 0; c < NC; c++) {
        if (rk[k * NC + c] <= TOP) sh.top[c]++;
        if (rk[k * NC + c] >= NC + 1 - TOP) sh.bottom[c]++;
      }
      sp.push((G[k] - G[k - L]) / HOUR);
      if (k + IC_AHEAD < nG && strengthAt(v, k + IC_AHEAD, IC_AHEAD, ahead)) put(`ic ${L}`, table.half[k] as 0 | 1, table.week[k], spearman(s, ahead));
    }
    shares.set(L, sh);
    ties.set(L, tie);
    spans.set(L, sp.sort((a, b) => a - b));
  }
}
// states entered where no fire may be taken (the market shut at the reads,
// or the pair without its bar), in the period
const lostStates = new Map<number, number>();
for (const L of LS) {
  const all = firesOf((p, k) => rankState(ranks.get(L)!, k, RULE_LEGS[p][0], RULE_LEGS[p][1], TOP), PAIRS.length, nG, (_p, k) => table.half[k] >= 0);
  lostStates.set(L, all.filter((f) => !okAt(f.p, f.k)).length);
}

// ---- the pick and the call ----------------------------------------------------------------

const edges = LS.map((L) => edgesOf(firesX.get(L)!, table));
const verdict: Verdict = verdictOf(
  edges.map((x) => x.first),
  edges.map((x) => x.second),
);
// (pk) the pick again from the meter and the coin cut at SPLIT (built above
// from the candles closed by then, and the coin followed on them)
{
  const again = LS.map((L) => edgesOf(rankFires(ranksFor(vCut, L), RULE_LEGS, tCut, TOP), tCut).first);
  const tAgain = again.map((a) => tOf(a));
  const pickAgain = verdictOf(again, again.map(() => newAgg())).pick;
  tally(checks.pick, pickAgain === verdict.pick && tAgain.every((t, c) => t === verdict.t[c]), () => `the pick ${verdict.pick} t ${verdict.t.join(", ")} / again ${pickAgain} t ${tAgain.join(", ")}`);
}
// the placebo gate
let placeboCalled = 0;
let placeboBonf = 0;
const placeboE: number[] = [];
for (let seed = 1; seed <= PLACEBOS; seed++) {
  const pv = verdictOn(placeboValues(seed, nG), LS, RULE_LEGS, table, TOP);
  if (pv.called) placeboCalled++;
  if (pv.bonf.some(Boolean)) placeboBonf++;
  if (pv.pick !== null) {
    const x = edgesOf(rankFires(ranksFor(placeboValues(seed, nG), LS[pv.pick]), RULE_LEGS, table, TOP), table).second;
    placeboE.push(x.n ? x.sum / x.n : Number.NaN);
  }
}
const placeboRate = PLACEBOS ? placeboCalled / PLACEBOS : Number.NaN;
const placeboBonfRate = PLACEBOS ? placeboBonf / PLACEBOS : Number.NaN;
const placeboPassed = PLACEBOS > 0 && placeboRate <= PLACEBO_GATE && placeboBonfRate <= PLACEBO_GATE;

// ---- the report --------------------------------------------------------------------------

const ci = (a: Agg | undefined) => {
  const part = (by: "weeks" | "blocks") => {
    const st = statOf(a, by);
    if (!st || !(st.C > 1)) return "[-]";
    const q = tQuantile(0.975, st.C - 1);
    return `[${num(st.m - q * st.se)},${num(st.m + q * st.se)}]`;
  };
  return `${part("weeks")} (4 wk ${part("blocks")})`;
};
const mean = (a: Agg | undefined) => (a && a.n ? a.sum / a.n : null);
const checkLine = (what: string, c: Check) => `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
console.log(`\n== CHECKS`);
console.log(checkLine("(id) Σ s = 0 and s_c − s_JPY against the cross's own candles", checks.identity));
console.log(checkLine("(la) the meter, its ranks, states and signals worked again from the candles cut at the close", checks.lookahead));
console.log(checkLine("(c) the meter's trades followed again, against the coin's", checks.again));
console.log(checkLine("(a2) their stop and TP1 against ultraLevels", checks.levels));
console.log(checkLine("(m) following starts at the first 5-minute bar at or after the close", checks.follow));
console.log(checkLine("(d) time-out closes against the 4-hour bar's own", checks.closes));
console.log(checkLine("(pk) the pick again from the meter and the coin cut at SPLIT", checks.pick));
console.log(checkLine("(p0) the 5-minute mid at the close against the bar's close", checks.closeMid));
console.log(checkLine("(p0, told) no 5-minute bar ending at the close: the last one inside the bar", closeMidLast) + `; no 5-minute bar inside ${closeMidNone}`);
console.log(checkLine("(a) the emails' signals against indicatorSignals", checks.signals));
console.log(`(g) GMO reads that failed: ${failedReads}`);
// (h) holds for the run fixed above only (as research/widetp.ts)
const hApplies = !SYNTHETIC && START === "2024-01-01" && SPLIT === "2025-05-19" && NOW === Date.parse("2026-09-29T14:16:25Z");
let hDiffer: number | null = null;
if (!SYNTHETIC && !hApplies) console.log("(h) does not apply: not the run fixed in the header");
if (hApplies) {
  const want = [{ m: "−1.35", n: 2416 }, { m: "−1.27", n: 2216 }];
  hDiffer = 0;
  const parts: string[] = [];
  for (const half of [0, 1] as const) {
    const a = reproAgg[half];
    const m = a.n ? num(a.sum / a.n) : "-";
    const ok = m === want[half].m && a.n === want[half].n;
    if (!ok) hDiffer++;
    parts.push(`${half === 0 ? "first" : "second"} ${m} of ${a.n} (§8.83: ${want[half].m} of ${want[half].n})`);
  }
  console.log(`(h) §8.83's T20 again, ${hDiffer} of 2 differ: ${parts.join("; ")}`);
}
const allDiffer = Object.values(checks).reduce((s, c) => s + c.mismatched, 0) + failedReads + (hDiffer ?? 0);
console.log(allDiffer === 0 ? "EVERY CHECK 0 DIFFER" : `CHECKS DIFFER (${allDiffer}): the numbers below are not to be read`);

const weeksWith = (half: 0 | 1 | "full") => {
  const s = new Set<number>();
  for (let k = 0; k < nG; k++) if (table.half[k] >= 0 && (half === "full" || table.half[k] === half)) s.add(table.week[k]);
  return s.size;
};
const cand = (c: number) => `X${LS[c]}`;
console.log(`\n== THE CALL (A+B, top ${TOP} / bottom ${TOP}, once on entering; e = pips less the coin's mean at the same close)`);
LS.forEach((L, c) => {
  const x = edges[c];
  const st1 = statOf(x.first, "weeks");
  const st2 = statOf(x.second, "weeks");
  console.log(`  X${L}: first half (pickable) e ${num(st1?.m)} of ${x.first.n}, t ${num(verdict.t[c])}; second half e ${num(st2?.m)} ${ci(x.second)} of ${x.second.n} in ${x.second.weeks.size} weeks, Bonferroni low end ${num(verdict.bonfLow[c])}${verdict.bonf[c] && c !== verdict.pick ? (placeboPassed && allDiffer === 0 ? " (above 0 after the correction)" : " (above 0, not told so: the placebo gate or the checks)") : ""}; fires without their 30 bars ${lostX.get(L)}`);
});
console.log(`  the pick: ${verdict.pick === null ? "none" : cand(verdict.pick)}; its low end ${num(verdict.low)} in ${verdict.weeks} weeks: ${verdict.called ? "CALLED" : "not called"}`);
console.log(`  the placebo gate: ${placeboCalled} of ${PLACEBOS} made-up meters called (${pctOf(placeboRate)}), the Bonferroni road ${placeboBonf} (${pctOf(placeboBonfRate)}): ${placeboPassed ? "passed" : "NOT PASSED: the intervals were too narrow for this data, and nothing is called"}`);
if (verdict.pick !== null && placeboE.length) {
  const real = mean(edges[verdict.pick].second);
  const below = placeboE.filter((x) => real !== null && x < real).length;
  console.log(`  the pick's second-half e among the placebos' picks: above ${below} of ${placeboE.length}`);
}
const cannot: string[] = [];
if (verdict.pick !== null && verdict.weeks < 30) cannot.push(`the pick's second-half trades in ${verdict.weeks} weeks`);
if (!placeboPassed) cannot.push("the placebo gate: the intervals were too narrow for this data");
const finalCall = verdict.called && placeboPassed && allDiffer === 0;
console.log(`  RESULT: ${finalCall ? `CALLED: ${cand(verdict.pick!)} picks the side better than a coin toss at the same closes` : `not called${cannot.length ? ` (cannot say: ${cannot.join("; ")})` : ""}`}`);

const exitLine = (series: string) => {
  const c = [0, 1].map((h) => exitCounts.get(`${series}|${h}`) ?? [0, 0, 0, 0, 0]).reduce((a, b) => a.map((x, i) => x + b[i]));
  const lvl = c[1] + c[2] + c[3];
  return `tp ${c[1]}, sl ${c[2]}, amb ${c[3]}, time ${c[4]}; TP1 first ${pctOf(lvl ? c[1] / lvl : null)} (break-even ${pctOf(SL / (SL + TP))}, the spread left out)`;
};
const told = (name: string, label: string) => {
  for (const half of ["full", 0, 1] as const) {
    const e = aggAt(`${name} e`, half);
    const pips = aggAt(`${name} pips`, half);
    const coin = aggAt(`${name} coin`, half);
    const weeks = weeksWith(half);
    console.log(`  ${label} ${half === "full" ? "whole" : half === 0 ? "first" : "second"}: ${pips?.n ?? 0} trades (${num(weeks ? (pips?.n ?? 0) / weeks : null, 1)} a week); pips ${num(mean(pips))} ${ci(pips)}; e ${num(mean(e))} ${ci(e)}; the coin at its closes ${num(mean(coin))}`);
  }
};
console.log(`\n== TOLD: the money and the yardstick (the whole period, the halves)`);
for (const L of LS) {
  told(`X${L}`, `X${L}`);
  console.log(`    how X${L} went out: ${exitLine(`X${L}`)}`);
  console.log(`    X${L} without the ${offTri.get(L)} fires whose meter reads a bar over ${TRI_FAR} pips off the triangle: e whole ${num(mean(aggAt(`X${L}c e`, "full")))} ${ci(aggAt(`X${L}c e`, "full"))}, second ${num(mean(aggAt(`X${L}c e`, 1)))} ${ci(aggAt(`X${L}c e`, 1))}`);
}
console.log(`  the coin at every close: whole ${num(mean(aggAt("coin all", "full")))} ${ci(aggAt("coin all", "full"))}, first ${num(mean(aggAt("coin all", 0)))}, second ${num(mean(aggAt("coin all", 1)))}`);
console.log(`\n== TOLD: beyond the pair's own momentum (M: the sign of s_A − s_B, once on each change)`);
for (const L of LS) {
  told(`M${L}`, `M${L}`);
  for (const half of ["full", 1] as const) {
    const x = aggAt(`X${L} e`, half);
    const m = aggAt(`M${L} e`, half);
    const dw = diffStatOf(x, m, "weeks");
    const db = diffStatOf(x, m, "blocks");
    const q = (d: typeof dw) => (d && d.C > 1 ? `[${num(d.m - tQuantile(0.975, d.C - 1) * d.se)},${num(d.m + tQuantile(0.975, d.C - 1) * d.se)}]` : "[-]");
    console.log(`    X${L} less M${L}, e, ${half === "full" ? "whole" : "second"}: ${num(dw?.m)} ${q(dw)} (4 wk ${q(db)}); a comparison only (no walk gauges it)`);
  }
}
console.log(`\n== TOLD: the rank IC (Spearman across the eight, s(k; L) against the next ${IC_AHEAD} bars' s)`);
for (const L of LS) for (const half of ["full", 0, 1] as const) console.log(`  L${L} ${half === "full" ? "whole" : half === 0 ? "first" : "second"}: ${num(mean(aggAt(`ic ${L}`, half)), 4)} ${ci(aggAt(`ic ${L}`, half))} of ${aggAt(`ic ${L}`, half)?.n ?? 0} closes`);
console.log(`\n== TOLD: one currency's trend? (the stale meter: the ranks of ${STALE} bars before; leave one out)`);
for (const L of LS) {
  told(`S${L}`, `stale X${L}`);
  for (const half of ["full", 1] as const) {
    console.log(`    X${L} ${half === "full" ? "whole" : "second"}, e without each currency: ${CURRENCIES.map((c) => `${c} ${num(mean(aggAt(`X${L} e -${c}`, half)))} (${aggAt(`X${L} e -${c}`, half)?.n ?? 0})`).join(", ")}`);
  }
  const sh = shares.get(L)!;
  console.log(`    X${L}: each currency's share of the top ${TOP} / bottom ${TOP} (${sh.bars} closes): ${CURRENCIES.map((c, i) => `${c} ${pctOf(sh.top[i] / sh.bars)}/${pctOf(sh.bottom[i] / sh.bars)}`).join(", ")}`);
}
console.log(`\n== TOLD: each pair, each side, the second half by quarter (e)`);
for (const L of LS) {
  console.log(`  X${L} by pair (whole): ${PAIRS.map((p) => `${p} ${num(mean(aggAt(`X${L} e @${p}`, "full")))} (${aggAt(`X${L} e @${p}`, "full")?.n ?? 0})`).join(", ")}`);
  console.log(`  X${L} by side (whole): ${(["BUY", "SELL"] as const).map((s) => `${s} ${num(mean(aggAt(`X${L} e ${s}`, "full")))} (${aggAt(`X${L} e ${s}`, "full")?.n ?? 0})`).join(", ")}`);
  console.log(`  X${L} second half by quarter: ${[1, 2, 3, 4].map((q) => `q${q} ${num(mean(aggAt(`X${L} e q${q}`, 1)))} (${aggAt(`X${L} e q${q}`, 1)?.n ?? 0})`).join(", ")}`);
}
console.log(`\n== TOLD: top one and bottom one (the strongest against the weakest)`);
for (const L of LS) told(`T1_${L}`, `top 1 L${L}`);
console.log(`\n== TOLD: the emails (A+B, their own trades, those with 30 bars in the data), and the meter's label at their close`);
for (const rule of ["either", "qtrend", "ultra"]) {
  for (const half of ["full", 1] as const) {
    const pips = aggAt(`em ${rule} pips`, half);
    const e = aggAt(`em ${rule} e`, half);
    console.log(`  ${rule} ${half === "full" ? "whole" : "second"}: ${pips?.n ?? 0} trades, pips ${num(mean(pips))} ${ci(pips)}, e ${num(mean(e))} ${ci(e)}`);
    for (const L of LS) {
      const parts = ["agree", "against", "mixed", "no meter"].map((lb) => {
        const a = aggAt(`em ${rule} L${L} ${lb} pips`, half);
        const ae = aggAt(`em ${rule} L${L} ${lb} e`, half);
        return `${lb} ${a?.n ?? 0}: pips ${num(mean(a))}, e ${num(mean(ae))}`;
      });
      const d = diffStatOf(aggAt(`em ${rule} L${L} agree pips`, half), aggAt(`em ${rule} L${L} against pips`, half), "weeks");
      const d4 = diffStatOf(aggAt(`em ${rule} L${L} agree pips`, half), aggAt(`em ${rule} L${L} against pips`, half), "blocks");
      const q = (x: typeof d) => (x && x.C > 1 ? `[${num(x.m - tQuantile(0.975, x.C - 1) * x.se)},${num(x.m + tQuantile(0.975, x.C - 1) * x.se)}]` : "[-]");
      console.log(`    L${L}: ${parts.join("; ")}; agree less against (pips) ${num(d?.m)} ${q(d)} (4 wk ${q(d4)})`);
    }
  }
}
console.log(`  (picking a filter from these lines would be a choice made after seeing them: not offered as measured)`);
console.log(`\n== COVERAGE`);
console.log(`  G: ${nG} bars (${G.length ? `${iso(G[0])} .. ${iso(G[nG - 1])}` : "-"}); weeks with a close in the period ${weeksWith("full")} (first ${weeksWith(0)}, second ${weeksWith(1)})`);
for (const L of LS) {
  const sp = spans.get(L)!;
  console.log(`  L${L}: the lookback spans ${sp.length ? `${sp[Math.floor(sp.length / 2)]} hours (median), ${sp[0]} .. ${sp[sp.length - 1]}` : "-"}; closes with an exact tie ${ties.get(L)}; states entered where no fire may be taken ${lostStates.get(L)}`);
}
for (const c of coverage) console.log(`  ${c.pair.padEnd(8)} bars ${c.bars}, in G ${c.inG}, a fire may be taken ${c.ok}, the coin ${c.coin}, the emails' signals ${c.signals}`);
if (SYNTHETIC) console.log(`  the coin's TP1 first by pair (a walk: (30 − the spread / 2) / 50): ${PAIRS.map((p) => {
  const c = exitCounts.get(`coin @${p}`) ?? [0, 0, 0, 0, 0];
  const lvl = c[1] + c[2] + c[3];
  return `${p} ${pctOf(lvl ? c[1] / lvl : null)} (${pctOf((30 - SPREAD_PIPS[p] / 2) / 50)})`;
}).join(", ")}`);

// ---- the numbers out, for the walks' summary ------------------------------------------------

const aggOut = (a: Agg | undefined) => {
  if (!a || !a.n) return null;
  const w = statOf(a, "weeks")!;
  const b = statOf(a, "blocks")!;
  return { n: a.n, sum: a.sum, m: w.m, se: Number.isFinite(w.se) ? w.se : null, se4: Number.isFinite(b.se) ? b.se : null, C: w.C, C4: b.C, low: lowEndOf(a) };
};
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(
  `${OUT}/strength${SYNTHETIC ? `-${SYNTH}${SYNTH === "rank" ? `${LSTAR}` : ""}${FAULT ? "-" + FAULT : ""}-${SEED}` : ""}.json`,
  JSON.stringify({
    start: START,
    split: SPLIT,
    now: iso(NOW),
    synthetic: SYNTHETIC,
    synth: SYNTH,
    seed: SEED,
    lstar: SYNTH === "rank" ? LSTAR : null,
    delta: SYNTH === "rank" ? DELTA : null,
    fault: FAULT,
    Ls: LS,
    align,
    checks,
    failedReads,
    hDiffer,
    allDiffer,
    verdict,
    candidates: LS.map((L, c) => ({ L, first: aggOut(edges[c].first), second: aggOut(edges[c].second), all: aggOut(edges[c].all) })),
    placebo: { n: PLACEBOS, called: placeboCalled, bonf: placeboBonf, passed: placeboPassed },
    finalCall,
    coverage,
    coinTp1: Object.fromEntries(PAIRS.map((p) => [p, exitCounts.get(`coin @${p}`) ?? null])),
    store: Object.fromEntries([...store].map(([k, a]) => [k, aggOut(a)])),
  }),
);
