# Riding the MACD line from 90% to 96%: the moment it gets there, not the bar's close

The owner (2026-11-11), after research/macd90-spec.md's numbers (docs §8.147: the line judged at each 1-hour bar's
close): 「足の確定ではなく、96%に到達した瞬間があればいい」. So the line counts as having reached 96% at the first
moment it is there while the bar is forming, not only at a close. This file fixes that as numbers, so that a second
implementation can reproduce every row. Everything not said here is research/macd90-spec.md's (its pairs, its 1-hour
bars and their mid closes, `Z(i)`, `Zp(i)`, the shares 0.90 and 0.96, "at a share" on a side, the pips in whole
points, the summary's group shape). Nothing here changes an email.

## Data

- research/macd90-spec.md's 1-hour bars (LOAD_FROM 2023-10-01, END 2026-11-10T21:00:00Z, entries' closes in
  [START = 2024-01-01, END)).
- 1-minute bars from START to END: ownerhold-data.ts `loadM1` (Python: research/flowz-check.py `M1`), bid and ask
  merged as there. A 1-minute bar opened at `u` belongs to the 1-hour bar `j` with `t[j] <= u < t[j] + 1 hour`.
- The moment is the minute: a minute is read once, when it has ended, from its 1-minute bar (a moment inside a
  minute is not seen apart from the minute's high and low). A minute with no 1-minute bar is not read.

## The line while bar j forms

For bar `j` (at least 600 bars up to it), the window is the 600 mid closes `t[j−599..j]` with bar `j`'s close
replaced by a price `x`: the email's MACD (_shared/macd.ts) of that window, read at index 599 with `zoneAt`. Up to
index 598 nothing depends on `x`; at 599 (Pine's EMAs, alpha = 2 / (n + 1)):

```
f = A12 * x + (1 − A12) * ema12[598]      s = A26 * x + (1 − A26) * ema26[598]
m = f − s                                  sig = A9 * m + (1 − A9) * signal[598]      h = m − sig
top = max(0, the line, signal and hist over 480..598, m, sig, h)     bottom = min(the same)
```

(research/macdlive.ts `prepare` / `liveAt` compute exactly this, and were checked against the window rebuilt.) With
`x` = bar `j`'s own mid close this is `Z(j)`.

The minute's price toward a side: for a 1-minute bar with bid high/low `bh, bl` and ask high/low `ah, al`,
`hi = round_chart((bh + ah) / 2, d)` and `lo = round_chart((bl + al) / 2, d)`. On the top side the line is highest
where the price is highest (m rises with x), so a minute **touches** a share `s` on the top side when the line with
`x = hi` is at `s` on the top side; on the bottom side, with `x = lo` on the bottom side.

## Two ways in

**close** (research/macd90-spec.md's entries, unchanged): bar `i` whose `Z(i)` is at 90% on a side and `Zp(i)` is
not; in at bar `i`'s close (the ask close for a BUY, the bid close for a SELL). The entry is **already** when `Z(i)` is
at 96% (as there). Followed from the first minute of bar `i+1`.

**moment**: bar `i` (close in [START, END), at least 600 bars up to it) whose `Zp(i)` is not at 90% on a side, and a
minute of bar `i` that touches 90% on that side: the first such minute (in time; if minutes touch on both sides, the
first minute decides, and a minute touching both is read on the top side). In at that minute's close (the 1-minute
bar's ask close for a BUY, bid close for a SELL; top side → BUY, bottom side → SELL, as there). The entry is
**already** when the same minute also touches 96% on that side. Followed from the next minute (the rest of bar `i`,
then bar `i+1` on). At most one moment entry a bar.

`share0` is the share of the line at the entry: for close, at `Z(i)` (as there); for moment, with that minute's `hi`
(top) or `lo` (bottom).

## Following it

Through the minutes after the entry, in time, and the closes of bars (a bar's close is after its last minute):

- **reached**: the first minute that touches 96% on the entry's side. Out at that minute's close (the 1-minute bar's
  bid close for a BUY, ask close for a SELL).
- at the close of each bar `j` the trade has been followed into (for a moment entry, bar `i`'s own close included),
  as research/macd90-spec.md with `Z(j)`: way **A** failed when `Z(j)` is not at 90% on the side; way **B** failed
  when the line is on the zero line or the other side. Out at bar `j`'s close (the 1-hour bar's bid close for a BUY,
  ask close for a SELL).
- **open**: neither by the last bar loaded; valued at its close.

A minute's touch is read before its bar's close. Each way ends at its first event.

## Each trade's numbers (per way in and way A / B)

As research/macd90-spec.md, with: `T` the moment out (a minute's end `u + 1 minute`, or a bar's close `T(j)`), `exit`
the price paid out, `pips` in whole points, `mae` the worst against the trade over the 1-minute bars after the entry's
minute (close: from the first minute of bar `i+1`) up to and including the minute out (out at a bar's close: its last
minute), a BUY `entry − min(bid low)`, a SELL `max(ask high) − entry`, 0 if never against; `minutes` = `(T − entry
moment) / 1 minute` (the entry moment: bar `i`'s close, or the entry minute's end); `share` the line's share at the
event (a touch: with that minute's hi / lo; a close: at `Z(j)`).

## Rows and summary

rows.csv, one row per entry of either way (already included), ordered by the entry moment, then the pairs' order,
then close before moment: `way, pair, open, T0, side, entry, share0, already, A_result, A_T, A_exit, A_pips, A_mae,
A_minutes, A_share, B_result, B_T, B_exit, B_pips, B_mae, B_minutes, B_share` (`open` the 1-hour bar `i`'s open, `T0`
the entry moment; formats as there).

summary.json: `{ meta, pairs: [{ pair, bars, minutes, close, moment }], ways: { close: GROUPS, moment: GROUPS } }`,
GROUPS as research/macd90-spec.md's `groups` (all, each pair, BUY, SELL), each W with `barsMedian, barsMax` replaced by
`minutesMedian, minutesMax`. `minutes` in pairs: 1-minute bars loaded.

## Way C: held until it gets there (the owner, 2026-11-12)

The owner, asked what the email should do when the line leaves the 90% band before 96%: 「96%に届くまで持ち続ける」
(no stop, no notice), and while a trade is held no new entry of the same pair and side is mailed. So a third way out,
**C**, beside A and B, for both ways in:

- **reached**: as A and B (the first minute after the entry that touches 96% on the entry's side; out at that
  minute's close). No failure: a trade not reached by the last bar loaded is **open**, valued at its close.
- **skipped**: within one way in, one pair and one side, the entries are taken in time order; an entry (not
  already) whose entry moment `T0` is before the moment out `T` of the last entry of that way in, pair and side that
  was not skipped (or that entry is open) is skipped: no trade. An entry at `T0 >= T` is taken. Already entries start
  no trade and skip nothing.
- Numbers of a C trade as A's and B's: `T`, `exit`, `pips`, `mae`, `minutes`, `share`.

rows.csv gains seven columns after `B_share`: `C_result` (reached / open / skipped; empty on an already row), `C_T`,
`C_exit`, `C_pips`, `C_mae`, `C_minutes`, `C_share` (empty when skipped or already).

summary.json: every group gains `"C"`:

```
C = { "reached", "open", "skipped",
      "plus", "minus",                                   // reached trades with pips > 0, with pips < 0
      "pipsSum", "pipsMean", "pipsMedian", "pipsMin",   // over reached
      "maeMedian", "maeP90", "maeMax",                  // over reached
      "minutesMedian", "minutesP90", "minutesMax",      // over reached
      "within60", "within1440", "within10080",          // reached with minutes <= 60, <= 1440, <= 10080
      "openPipsSum", "openPipsWorst", "openMaeMax", "openMinutesMax" }   // over open
```

P90 of n values: the value at rank `(9 * n + 9) // 10` (1-based, whole-number division: the ceiling of 0.9 n) of the
values in ascending order. Null where there is
no value (a sum over no trade included).

Checks on the walks: a C trade that is reached and whose A is reached has the same `T`, pips and mae as A; a C trade's
`T` is never before its A's or B's; no two taken C trades of one way in, pair and side overlap; the look-ahead check
covers C (the future after its `T` rewritten: the row's C cells stay).

## The reach share as a number given to the run (the owner, 2026-11-12)

The owner: 「確定じゃなくて、90に到達した瞬間に注文入れたら、95か96に到達する確率？」. 96% is this file's; for 95% the
same study is run with the reach share changed and nothing else:

- `REACH` (an environment variable of both implementations): a number `r` with `0.90 < r <= 1`. Not given or empty:
  0.96, and every row and number is as before.
- With `REACH = r`, every "96%" above is `r`: a close entry is **already** when `Z(i)` is at `r`; a moment entry is
  already when its minute also touches `r`; **reached** (ways A, B and C) is the first minute after the entry that
  touches `r`. The entries (90%), way A's and B's failures, the prices, `mae`, `minutes`, the skipping of way C and the
  rows' and the summary's shape do not change. (Fewer entries are followed at a lower `r`: more of them are already.)
- summary.json: `meta.reach` = `r` (a number). The Python counts a `meta.reach` that is not its own share as a
  difference.
- The walks' check "the close way's entries equal research/macd90.ts's" compares bars, sides and prices; the already
  flag too when `r` is 0.96 (research/macd90.ts's flag is at 0.96).

## Checks (on seeded walks, before the real run)

- The line at a minute, computed from the prepared state, equals `zoneAt` on the window rebuilt with that price
  (every entry's and every touch's minute, and a sample of the others).
- The close way's entries equal research/macd90.ts's (the same bars, sides, prices).
- Look-ahead: for a sample of trades, every price after the entry moment moved by ±300 pips: the entry stays; every
  price after each way's `T` moved: that way's result, `T`, pips and mae stay.
- The counts add up; on each way in, way A reached implies way B reached at the same moment.
- The Python (research/macd90m-check.py, written apart from the TypeScript) gives every row and number.
