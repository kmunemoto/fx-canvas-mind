# The 1-hour MACD email sent at its close, or the moment the forming bar reaches the band (#388, docs §8.131)

The owner (2026-10-30), after the 1-hour MACD BUY email of USD/JPY at 21:00 JST: asked whether the email could be
sent in the middle of a bar, as soon as the blue line reaches the band (the chart shows the forming bar), and told
that a bar that comes back before its close would then have mailed a signal that is gone: 「一回どっちが儲かるか
測って」. This file fixes both ways as numbers, so that a second implementation can reproduce every row.

## Data

- Pairs: USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD (GMO's; gold has no GMO 1-minute bars and is not measured).
- Period: the bars whose close `T(i)` is in `[START, END)` (both ways judge the same bars), START =
  2024-01-01T00:00:00Z, END = 2026-10-29T21:00:00Z. 1-hour bars read from LOAD_FROM = 2023-10-01T00:00:00Z; 1-minute
  bars from START to END. (Both values are read from summary.json's `meta`.)
- 1-hour bars: research/flowz-check.py's `load_tf` (GMO's 1-hour day files, bid and ask merged, the weekend
  "inside" rule), each bar's close the chart's mid: `round_chart((bid close + ask close) / 2, d)`, d = 3 on a yen
  pair and 5 on the others. Bar `i` opens at `t[i]` and closes at `T(i) = t[i] + 1 hour`.
- 1-minute bars: research/flowz-check.py's `M1` (from START to END, bid and ask). The price at a moment `τ`
  (a minute boundary) is the mid of the 1-minute bar that opened at `τ − 1 minute`:
  `round_chart((bc + ac) / 2, d)`; none when that 1-minute bar is not there.

## The rule (v6/v8, unchanged: _shared/macd-level.ts `decideZoneOnWindow`)

For a window of 600 closes `w[0..599]` (the bar judged last): MACD 12, 26, 9 as Pine's (`ema` seeded with the
simple mean of the first `n`, then `alpha * x + (1 - alpha) * prev`, `alpha = 2 / (n + 1)`; line = ema12 − ema26;
signal = ema9 of the line from its first defined value; hist = line − signal). At index `k` of the window,
`top(k)` = the highest of 0 and the line, signal and hist over `k−119..k`; `bottom(k)` the lowest (with 0).
`inTop(k)`: `top > 0 and line[k] >= 0.95 * top`; `inBottom(k)`: `bottom < 0 and line[k] <= 0.95 * bottom`.
The decision at index 599: SELL if `inTop(599) and not inTop(598)`, BUY if `inBottom(599) and not inBottom(598)`,
else none (598 judged in the same window, on its own 120).

## The two ways

**close** (the email now): for each bar `i` (600 bars up to it) whose close `T(i)` is in `[START, END)`, the
decision on the window `t[i−599..i]` of closed closes. Mailed when one of the reads 0, 3 and 5 minutes after the
close (each a second in) is not in `is_possibly_closed`. The email: side, `τ = T(i)`, `E` = the bar's close.

**live** (the email in the middle of the bar): for the same bars, the forming bar `i` is judged each minute: at
`τ = t[i] + k minutes`, `k = 1 .. 59`, the window is the closes of bars `i−599 .. i−1` and, as the close of bar `i`,
the price at `τ` (a minute without a price is not judged). The first `k` whose decision is not none and whose
`τ + 1 second` is not in `is_possibly_closed` is the email: side, `τ`, `E` = the price at `τ`. No such `k`: the
bar's own close is judged as in **close** (the same decision, `τ = T(i)`, mailed by the same reads) and that is the
email, if any. At most one email a bar. (Bar `i−1` in the window is always its closed close, so an email in bar `i`
that its close then undoes does not stop bar `i+1` from mailing again.)

For each **live** email: `early` = it was sent before the bar's close (`τ < T(i)`); `minutes` = `(T(i) − τ)` in
minutes; `gone` = early and the **close** decision at bar `i` is none (the bar closed out of the band).

## Each email followed (both ways alike)

research/flowz-check.py's `follow(pr, P0 = τ + 2 minutes, dirn, E, END)`: the owner's way (§8.102's main row: a limit
at `E` two minutes after the email, market if already better, TP `E ± 10 pips`, no stop; Rakuten's stop times as
there), and from the same fill the email's guide (stop `E ∓ 13 pips`, TP `E ± 4 pips`, the first reached; both in one
1-minute bar: the stop). Pips in 0.01 on yen pairs, 0.0001 on the others. Funds unlimited: every email is a trade.

## The numbers, for each way (all pairs; and each pair)

emails, filled, unfilled, TP reached, still held at END (their pips summed, and the worst), TP / filled (%), pips
summed over the filled (TP and held at END's price), pips a filled trade (mean, median), MAE (median, max), hours
held (median, max); the guide: TP, stop, held, both, TP / (filled) (%), pips summed and a trade. For **live**:
early, gone, and the minutes early (median, max).

## Output (OUT/rows.csv and OUT/summary.json, written by research/macdlive.ts)

rows.csv, header
`way,pair,open,tau,side,E,early,minutes,gone,filled,market,fillT,fill,tp,tpT,exit,endPx,pips,mae,hold,g_result,g_pips,g_both`:
one row per email of either way, ordered by `tau`, then the pair's place in the list above, then way (`close`
before `live`). Times ISO `YYYY-MM-DDTHH:MM:SSZ`; numbers as JavaScript's `String(x)` writes them (the shortest
form that reads back to the same double); flags `1`/`0`. On a **close** row `early`, `minutes`, `gone` are `0`. The
owner's and the guide's columns as research/flowz.ts writes them (its `csvOf`, from `filled` on): `market` the
market flag of the path, `fillT`/`fill` only when filled, `tpT`/`exit` only when TP was reached, `endPx` only when
held at END, `pips`/`mae`/`hold` empty when not filled, `g_*` empty when not filled. (`hold` in hours.)

summary.json:
- `meta`: `start`, `end`, `loadFrom` (ISO).
- `ways`: `close` and `live`, each an object with `all` and one key per pair, each the stats of its rows:
  `mails, filled, unfilled, tp, held, win, pipsSum, pipsMean, pipsMedian, maeMedian, maeMax, holdMedian, holdMax,
  heldPipsSum, heldPipsMin, guideTp, guideSl, guideHeld, guideBoth, guideWin, guidePipsSum, guidePipsMean`
  (research/flowz-lib.ts `statsOf`, plus the two sums: a median is the mean of the two middle values of an even
  count; sums and means add the rows in their order above; `win` = 100 × tp / filled; `guideWin` = 100 × guide TP /
  filled; null where there is nothing to take it of).
- `live`: `early`, `gone`, `minutesMedian`, `minutesMax` (over the early live emails), all pairs.
- `pairs`: one per pair: `pair`, `bars1h`, `judged` (bars with 600 up to them and a close in `[START, END)`).
- `load`: the loader's counts (not compared).

A second implementation (research/macdlive-check.py) builds its own bars from the same files, decides both ways
with its own code, follows each email with research/flowz-check.py's `follow`, and must find the same rows (every
column; numbers equal as doubles) and the same numbers (equal, or within 1e-9 relative for sums and means).
