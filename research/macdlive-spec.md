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

## One hour after each close email: the email's side or the other side (docs §8.144, 2026-11-07)

The owner (2026-11-07): when a SELL (BUY) email comes, is it better one hour later to enter as the email says (against
the overbought / oversold move) or the other way (with the move), 20,000 units a trade, as a probability. Only the
**close** way's emails (the email as it is sent now). Nothing else above changes; this adds a file and a key.

For each **close** email (pair, bar `i`, side, `τ = T(i)`), with `m` the pair's 1-minute bars (as above: `t`, bid close
`bc`, ask close `ac`) and `dir` = +1 for BUY, −1 for SELL:

- Entry quote: the 1-minute bar that opened at `τ − 1 minute` (the bar the price at `τ` is read from): `eb` = its `bc`,
  `ea` = its `ac`. No such bar: status `noEntry` (nothing else on the row).
- Exit quote: the first 1-minute bar whose open is at or after `τ + 59 minutes` (the bar that closes one hour after
  `τ`, or the first after it). None among the loaded bars: status `noExit`. Else `xOpen` = its open, `xb` = its `bc`,
  `xa` = its `ac`, `late` = (`xOpen` − (`τ + 59 minutes`)) / 1 minute (an integer; 0 when on time). Status `ok` when
  `late` ≤ 5, `late` when `late` > 5 (a market close or a gap in between: listed, not in the main numbers).
- The email's side (`mail`): BUY `dm = xb − ea`; SELL `dm = eb − xa`. The other side (`opp`): BUY email (so a sell)
  `do = eb − xa`; SELL email (so a buy) `do = xb − ea`. Each a double subtraction of the two quotes as read.
- `move` = `dir × ((xb + xa) / 2 − (eb + ea) / 2)`: the mid's move in the email's direction (> 0: the email's way).
- Pips: `dm / u` and `do / u`, `u` = 0.01 on a yen pair, 0.0001 on the others (double literals).
- Yen for 20,000 units: on a yen pair `d * 20000`; on the others `d * 20000 * U` (left to right), where `U` = USD/JPY's
  `(bc + ac) / 2` of its 1-minute bar that opened at `xOpen`, or, when USD/JPY has none at that minute, of its last
  1-minute bar that opened before `xOpen`; no such bar at all: status `noRate` (it takes precedence over `late`), the
  yen columns empty (not in the numbers). `U` is not rounded.

Output OUT/hour1.csv, header `pair,open,tau,side,st,eb,ea,xOpen,late,xb,xa,u,mailPips,oppPips,mailYen,oppYen,move`, one
row per **close** email in rows.csv's order (by `tau`, then the pair's place). `open`, `tau`, `xOpen` ISO as above;
numbers as JavaScript's `String(x)`; `u` empty on a yen pair; every column after `st` empty when it cannot be taken
(`noEntry`: all; `noExit`: from `xOpen` on, but `eb`, `ea` kept; `noRate`: `u`, `mailYen`, `oppYen`).

summary.json `hour1`: `{ counts, groups }`. `counts`: `ok`, `late`, `noEntry`, `noExit`, `noRate` over all close emails.
`groups`: `all`, one key per pair, and one per UTC year of `tau` (`"2024"`, `"2025"`, `"2026"`), each over its rows with
status `ok` (rows in hour1.csv's order): `n`, `mailWin` (`dm > 0`), `mailLoss` (`dm < 0`), `mailDraw` (`dm == 0`), `oppWin`,
`oppLoss`, `oppDraw` (on `do`), `moveMail` (`move > 0`), `moveOpp` (`move < 0`), `moveFlat`, `mailPipsSum`,
`mailPipsMean`, `oppPipsSum`, `oppPipsMean`, `mailYenSum`, `mailYenMean`, `mailYenMin`, `mailYenMax`, `oppYenSum`,
`oppYenMean`, `oppYenMin`, `oppYenMax` (sums add the rows in order; mean = sum / n; null where n = 0).

The second implementation builds the same rows from its own close emails and its own 1-minute bars and must find the
same hour1.csv (every column; numbers equal as doubles) and the same `hour1` (counts equal; sums and means equal or
within 1e-9 relative; the rest equal).

## Other holding times (docs §8.145, 2026-11-07)

The owner (2026-11-07), after §8.144: 「他のいろんな待ち時間で調べてみて」 (the same comparison with other waits). Exactly
"One hour after each close email" above, with the hour replaced by each holding time `H` (minutes) in
HOLDS = 5, 15, 30, 60, 120, 240, 480, 720, 1440, 2880, 10080:

- Entry quote: as there (the 1-minute bar that opened at `τ − 1 minute`; none: `noEntry`).
- Exit quote: the first 1-minute bar whose open is at or after `τ + (H − 1) minutes`; none among the loaded bars:
  `noExit`. `late` = (`xOpen` − (`τ + (H − 1) minutes`)) / 1 minute; status `ok` when `late` ≤ 5, `late` when `late` > 5
  (a weekend or a gap in between: listed, not in the main numbers); `noRate` as there (precedence over `late`).
- `dm`, `do`, `move`, pips, yen and `U`: as there.

Output OUT/holds.csv, header `hold,pair,open,tau,side,st,eb,ea,xOpen,late,xb,xa,u,mailPips,oppPips,mailYen,oppYen,move`
(`hold` = `H`), the rows of each `H` in hour1.csv's order, the `H`s ascending. The cells as in hour1.csv. With `H` = 60 the
rows (from `pair` on) are hour1.csv's rows.

summary.json `holds`: an object keyed by `H` written as a decimal string (`"5"`, `"15"`, …, `"10080"`), each
`{ counts, groups }` exactly as `hour1`'s (the counts over all close emails; the groups `all`, each pair, each UTC year of
`tau` over all close emails, each over its rows with status `ok`).

The second implementation builds the same rows for every `H` and must find the same holds.csv (every column; numbers
equal as doubles) and the same `holds` (as for `hour1`).

## The 15-minute emails (TF = 15min, docs §8.146, 2026-11-07)

The owner (2026-11-07): 「15分足のメールでも同じように調べて」 — the same comparison for the 15-minute MACD email (v7:
the same rule on the 15-minute chart, docs §8.127; mailed 2026-10-26 to 10-30). Both implementations read an environment
variable `TF`: `1h` (the default: everything above, unchanged) or `15min`. With `TF = 15min`:

- Bars: GMO's 15-minute day files instead of the 1-hour ones (research/flowz-check.py's `load_tf` with `15min`, the same
  merge and weekend rule), each bar's close the chart's mid as above. Bar `i` opens at `t[i]` and closes at
  `T(i) = t[i] + 15 minutes`. `pairs[].bars1h` and `judged` count these 15-minute bars (the key names stay).
- The rule: exactly as above (600 closes, 120 bars, 95%), on the 15-minute closes.
- Only the **close** way: no **live** email is computed (no `live` row in rows.csv; `ways.live` holds the stats of no rows,
  each pair too; `live` is `{ early: 0, gone: 0, minutesMedian: null, minutesMax: null }`).
  The stats of no rows: the counts (`mails`, `filled`, `unfilled`, `tp`, `held`, `guideTp`, `guideSl`, `guideHeld`,
  `guideBoth`) 0, the sums (`pipsSum`, `heldPipsSum`, `guidePipsSum`) 0, and `win`, `pipsMean`, `pipsMedian`, `maeMedian`,
  `maeMax`, `holdMedian`, `holdMax`, `heldPipsMin`, `guideWin`, `guidePipsMean` null.
- Mailed when one of the reads 0, 1 and 3 minutes after the close (each a second in) is not in `is_possibly_closed`
  (the 15-minute chart's reads, signal-alerts `gmoIntervalsDue`).
- The email: side, `τ = T(i)`, `E` = the bar's close; followed (owner's way, guide), hour1 and holds exactly as above.
- summary.json `meta` gains `tf` (`"1h"` or `"15min"`) in both modes.

The run with `TF = 15min` writes to its own OUT folder. The second implementation, run with the same `TF`, must find the
same files as above.
