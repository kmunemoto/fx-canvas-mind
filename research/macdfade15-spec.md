# The MACD fade on the 15-minute chart: one email at a closed 15-minute bar at 96%, measured as take profit 10, no stop

Status: a study rule, written 2026-11-17 on branch `claude/app-confirmation-jvmk03` (f681256) before its code
(research/macdfade15.ts, .github/workflows/macdfade15.yml). The Python written apart from the TypeScript, from this
text alone (research/macdfade15-check.py; research/macdfade15.ts was not read for it), agrees with every row and
number of walks 1 and 2, of walk 1's untidy files and of GMO's real files (the files byte for byte; Actions run
44077464383, the result at the end). Revised after a review the same day: the noise of the
gaps (driftless walks), the run with `END` a week earlier, the weekend gate by hand, the untidy walk files, the stop
on GMO's minutes not lining up with its 15-minute bars, and the delay before an order listed as not measured. Nothing here changes an email: production stays on v9 until the release
(research/macdfade96-spec.md and the production spec that follows it).

**1-hour bars (2026-11-17, after the real run below).** The owner then said 「やっぱりメールの判断1時間足で」: the email is
judged on 1-hour bars. The same study measures them with `TF=1h` (section "On 1-hour bars (TF=1h)", before the result).
The 15-minute result below stays as the record of the 15-minute form, which is not built.

## Why

The owner (2026-11-17), after the 96% touch had been measured on 1-hour bars (research/macd90m-spec.md, its last
sections) and an email for it written as a rule (research/macdfade96-spec.md): 「もうシンプル96%の足できたら逆張りのメールちょうだい」,
then 「メールを1時間足から15分足に変更」. Asked further, the owner answered (in English here, not the owner's words):

- the form is the same for the five pairs (USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD), gold (XAU/USD) and the
  shares: at a closed 15-minute bar of the chart, on the 600 closed 15-minute closes ending at it, when the MACD line
  (12/26/9) is at 96% of the pane's top (bottom) at the bar's close and was not at 96% at the bar before's close, one
  email on the **fade** side: top → SELL, bottom → BUY;
- the pane is the newest 120 15-minute bars (the chart's 15-minute pane), chosen over a 480-bar pane;
- the shares are on 15-minute bars too (chosen knowing that Tokyo quotes come about 15 minutes late on Yahoo);
- only the first bar at 96% (the bar before not at 96%) is an email, not every bar while the line stays there;
- the email states only the price in: no take-profit level and no stop; the numbers are measured while it is built
  and put in the email;
- gold and the shares are released with the pairs but are not measured with this form (no bid and ask minutes in the
  study's data): their emails say so and carry no numbers; the shares fade too (a SELL is a short sale); nothing is
  sent at any target.

## How it is measured (CLAUDE.md)

The email states no target and no stop, but the trades are measured as the owner holds (CLAUDE.md, docs §8.102: take
profit 10 pips, no stop; funds unlimited, every email taken). So every number here is "take profit 10, no stop", and
every text that shows them says so. With no stop and the trades followed to the last minute loaded, the share of trades
reaching the target is high by construction: it is never shown alone. With it go the mean pips a trade (open trades at
their unrealized pips), the open trades' count and their unrealized pips (sum and worst), the largest loss on the way
(`maeMax`), the holding time (`tpMinutes*`, `openMinutesMax`), the orders not filled (none: the entry is at a bar's
close, not a limit order) and the same trade with no signal (the baseline below). A result that looks near 100% is first
suspected of look-ahead (the checks below). Nothing here says that a price will come back.

Both directions are measured: **fade** (the email's side) and **flow** (the other side, for comparison only: no email).

**The share reaching the target says little by itself.** With no stop and trades held to the last minute loaded, it is
near 100% for any entry: on random walks with no trend (where no signal can do better than none) fade, flow and the
baseline all reach about 98% over the default period (MODE=null, seeds 1 to 10, run in the development container on
2026-11-17: fade 97.91 to 99.02%, flow 98.15 to 99.00%, base 98.21 to 98.95%; fade − base −0.31 to +0.23 points and
−0.80 to +2.24 pips a trade). So what is read is the
**gap** between fade and the baseline (and fade and flow), and a gap is read only next to a measure of its noise:

- **Driftless walks** (MODE=null, `NULL_SEEDS`, 1 to 10 in the workflow): ownerhold-data.ts `synthesize` with no trend,
  over the run's own `LOAD_FROM`, `START`, `END`, through the same code as the real run (the walk's 15-minute bars cut
  from its minutes, as the checks below). For each walk and each of `all`, each pair, `BUY` and `SELL`: the share of tp
  and of open trades (% of the trades) and the mean pips a trade of fade, flow and base, and the gaps fade − base and
  fade − flow (`null.json`, below). The print gives the real gaps next to the walks' lowest and highest. **A real gap
  inside the walks' range is not evidence** that the email's side does better than no signal (or than the other side).
  The walks' price moves are the generator's, not GMO's (not measured how far they differ), and ten walks give a range,
  not a test: a gap with no edge at all still falls outside the range of `N` walks about 2 times in `N + 1` (18% with
  10), so a gap outside it is not evidence by itself either.
- **The mean a trade apart**: a tp trade's pips are `TP` exactly, so the mean a trade is set mostly by the open trades'
  pips at the last minute; the print gives the open trades' mean (`openPipsSum / open`) next to the mean of all.
- **END a week earlier**: the workflow runs the study again with `END` seven days earlier (the same files; the Python
  run on it too) and prints both side by side: the open trades valued a week earlier and that week's entries left out.
  It shows how much the mean a trade moves with the last minute's price (on the ten driftless walks above, fade's mean
  over the default period went from −10.43 to +3.50 pips: seed 1's −10.43 is mostly its 137 open trades).

## Data

- **Pairs**: the five, in this order: USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD (research/macd90.ts `PAIRS`).
- **Period**: `LOAD_FROM` 2023-12-01T00:00:00Z (15-minute bars before `START` that the first windows read: 600
  15-minute bars are about six and a quarter trading days), `START` 2024-01-01T00:00:00Z, `END` 2026-11-10T21:00:00Z
  (research/macd90m's `START` and `END`). Environment variables of both implementations, these the defaults.
- **The 15-minute chart** (the bars the function judges, read as research/macd15.ts reads them): GMO's 15-minute day
  files (interval `15min`, both sides) through research/trend-data.ts
  `loadTf(src, pair, "15min", LOAD_FROM, END, st, weekendOutOf("inside"))`: the files oldest first; quotes.ts
  `mergeSides` (one bar a time: the first bid row of a time, with the **last** ask row of that time, the newest
  file's, since the asks are put in a map by time; a bar on one side only, or whose ask close is under that bid close,
  left out, and then the time's next bid row, if any, tried the same way); bars opened at or after `LOAD_FROM` and
  closed by `END`; a bar wholly inside the weekend
  closure (market-hours.ts `barInsideClosure`) left out. Then trend-data.ts `quotesOf` and the chart's own
  live-chart/logic.ts `historyRead(pair, "15min", quotes, END)`: the closed bars, each a mid candle (`(bid + ask) / 2`)
  rounded as drawn (3 decimals on a yen pair, 5 on the others). Bar `n` (0-based, oldest first): `t[n]` its open,
  `T(n) = t[n] + 15 minutes` its close, `c[n]` its mid close as drawn. Python: research/macd15-check.py (research/
  flowz-check.py `load_tf`, `round_chart`).
- **Prices in**: bar `n`'s **bid close `bc[n]` and ask close `ac[n]` are GMO's own 15-minute bar's**, the bid and ask
  rows of the 15-minute file the chart bar was made from (the bid row and the ask row `mergeSides` paired above), as
  GMO wrote them (not rounded by the chart, not a 1-minute bar's). Whether GMO's 15-minute close equals the close of the last 1-minute bar inside it is counted (`closeVsMinute`
  below), not assumed: on the walks it does by construction (their 15-minute bars are cut from their minutes); on GMO's
  real files it is what the real run says. **The real run stops** (nothing written) when, on any pair, the close
  differs in more than 1% of the bars in range that have a minute (`differ > 0.01 × (same + differ)`), or no such bar
  has one: it is the one check on the real files that the minutes are labelled as the 15-minute bars are (a minute
  labelled a minute off would put bar `n`'s last minute, before the entry, into the follow). The print shows it per
  pair next to the numbers. The untidy walk files (Checks) must trip it; the tidy walks never do.
- **1-minute bars**: ownerhold-data.ts `loadM1(src, pair, START, END, st)` (Python: research/flowz-check.py `M1`),
  both sides merged as there (a minute on one side only, an ask close under the bid close, a minute inside the weekend
  closure and a repeated time left out), as research/macd90m-spec.md. A minute opened at `u` ends at `u + 1 minute`.
- **Points**: `P(x) = round(x * 10^d)`, `d` = 3 on a yen pair, 5 on the others (research/macd90.ts `P`; 10 points =
  1 pip). Every price is held against another in whole points.

## The line at a bar's close

- `W = 600` (macd-level.ts `LEVEL_WINDOW`), `ZONE_BARS = 120`, MACD 12/26/9 (_shared/macd.ts `macd`, Pine's EMAs).
- **`Z(n)`** (bar `n`, `n >= 599`): `zoneAt(macd(c[n−599..n]), 599)` (macd-level.ts): `m` the MACD line at index 599;
  `top` the highest of 0 and the MACD line, the signal line and the histogram over indices 480..599 (the pane: the
  newest 120 bars, bar `n` among them); `bottom` the lowest of the same.
- **`Zp(n)`**: `zoneAt(macd(c[n−599..n]), 598)`: the line at the bar before's close, on the same window, the pane over
  indices 479..598 (bars `n−120..n−1`). The EMAs are causal, so these are the same numbers as `zoneAt` of the MACD of
  the 599 closes ending at bar `n−1` read at its last index (598): the bar before read on its own 599 closes (the walks
  check that it is so, bit for bit). This is research/macd90.ts `zonesOf`'s `zp`, and the email's own reading of the bar
  before (macd-level.ts `zoneEntryAt`: index `k − 1` of the same window). It is not `Z(n−1)` (the window ending at
  `n−1` starts a bar earlier, so its EMAs are seeded a bar earlier); how often the two disagree at an entry is counted
  (`prevAt` below).
- **At a share `s` on a side** (research/macd90.ts `atShare`): on the top side `top > 0 and m >= s * top`; on the
  bottom side `bottom < 0 and m <= s * bottom`; equality in; the product `s * top` as it comes, unrounded.
- **The share** `SHARE` (an environment variable of both implementations): a number above 0, at most 1; not given or
  empty: 0.96.
- **Both sides cannot hold at one bar**: with `s > 0`, the top side needs `m >= s * top > 0` and the bottom side
  needs `m <= s * bottom < 0`, and `m` cannot be above and below 0 at once. (The TypeScript stops with an error if both
  ever hold; the walks count the bars read: none.)
- `share0` = `m / top` on the top side, `m / bottom` on the bottom side, at `Z(n)`.

## The entries

- **Bars in range**: bar `n` with `T(n)` in [`START`, `END`). One with `n < 599` is counted as `short` (not judged:
  fewer than 600 bars up to it; the real run expects none and stops if there is one). One whose `Z(n)` or `Zp(n)` is
  null (`zoneAt` null: a value not a finite number) is counted apart (`zoneless`; not expected). The rest are
  **judged**.
- **A signal** at bar `n` (judged), on side `S`: `Z(n)` at `SHARE` on `S` and `Zp(n)` not at `SHARE` on `S`. At most
  one side (above).
- **The function's reads** (the weekend gate, as research/macd15.ts): the function reads the 15-minute chart 0, 1 and
  3 minutes after a close (signal-alerts/indicators.ts `gmoIntervalsDue`) and does not run while market-hours.ts
  `isPossiblyClosed` holds. A signal is **mailed** when at least one of `isPossiblyClosed(T(n) + r minutes + 1 second)`,
  `r` in 0, 1, 3, is false (the read a second into its minute, as research/macd15.ts `mailedAt`). On the 15-minute
  grid all three reads fall in the close's own hour, so a bar is not read exactly when it closes at or after Friday
  21:00 UTC and before Sunday 22:00 UTC (the week's last bars on Friday, and any bar GMO has on Sunday before 22:00
  UTC). A signal not mailed is **not an entry**: counted apart as `notMailed`, no trade.
- **An entry** is a mailed signal. `T0 = T(n)` (the bar's close); `zside` = `S` (`top` / `bottom`).
- Every entry is taken (funds unlimited): no skipping, any number of trades of a pair and side open at once. There is no
  limit order on the way in (in at the bar's close), so no entry is left unfilled.

## Two trades an entry

- **fade**: the top side a SELL, the bottom side a BUY (the email's side);
- **flow**: the top side a BUY, the bottom side a SELL (for comparison only).
- **The price in** (`entry`): bar `n`'s 15-minute **ask close `ac[n]` for a BUY, bid close `bc[n]` for a SELL** (Data,
  "Prices in").

## Following a trade

As research/macd90m-spec.md "Following a trade" (the touch's), from the **first 1-minute bar at or after `T0`** (the
lowest `u` with `u >= T0`; its index `kFrom`) through the last one loaded, the minutes in no 15-minute bar of the chart
included (a minute is followed whether or not its 15-minute bar is on the chart):

- the target: a BUY `P(entry) + 10 * TP`, a SELL `P(entry) − 10 * TP`, in whole points; `TP` the take profit in pips
  (an environment variable of both implementations, a whole number >= 1; not given or empty: 10);
- in each minute in time, first the worst against the trade (a BUY `P(entry) − P(bid low)`, a SELL
  `P(ask high) − P(entry)`, kept when larger), then the target test;
- **tp**: the first minute whose `P(bid high) >= target` (BUY) or `P(ask low) <= target` (SELL). Out at the target
  exactly (a minute that opens beyond it is also taken at the target: the pips are `TP` exactly, never more); `T` that
  minute's end;
- **open**: no such minute through the last minute loaded; valued at the last minute's close (the bid close for a BUY,
  the ask close for a SELL; unrealized); `T` the last minute's end;
- no stop and no other way out;
- an entry with no 1-minute bar at or after its `T0` is not valued: the run stops with an error (not expected: the
  minutes are loaded to `END` and every `T0` is before `END`).

Each trade's numbers: `target` = the target in points `/ 10^d` (a price); `exit` (the target, or the last close);
`pips` (`TP` for tp; for open a BUY `(P(bid close) − P(entry)) / 10`, a SELL `(P(entry) − P(ask close)) / 10`);
`mae` the worst against the trade over the minutes followed up to and including the minute out, `/ 10` (0 if never
against); `minutes = (T − T0) / 1 minute`.

## The same trade with no signal (the baseline)

- **Entries**: every bar the entries may come from: judged (in range, at least 600 bars, `Z(n)` and `Zp(n)` read) and
  mailed (the weekend gate above, at `T(n)`), whether or not it has a signal; at the bar's **first 1-minute bar** (the
  lowest `u` in [`t[n]`, `t[n] + 15 minutes`); a bar with none has no baseline entry); `T0` that minute's end, and
  the trade followed from the first minute at or after `T0` (the next minute loaded: GMO's minutes are whole). This is
  research/macd90m-spec.md's baseline on 15-minute bars: it is entered at the bar's first minute, at a 1-minute close,
  about 14 minutes before a signal at the same bar would be; it is the same holding with no signal, not the same entry.
- Each is **two trades**: a BUY in at that minute's ask close and a SELL in at its bid close, followed exactly as above
  from the next minute. An entry minute that is the last minute loaded (no minute after it) stops the run with an
  error, as above (not expected: the last bar in range closes 15 minutes before `END`).
- **Speed**: about 70,600 bars a pair, so about 706,000 baseline trades over the five pairs, some followed to the last
  of about 1,060,000 minutes (the counts of a walk over the default period; GMO's real files have their own). Both implementations find a trade's tp minute and its `mae` without walking each trade
  minute by minute (a segment tree or a sparse table over the minutes' `P(bid high)`, `P(ask low)`, `P(bid low)`,
  `P(ask high)`: the first minute reaching the target, then the range's extreme), and must give the plain walk's
  numbers (checked: every entry trade, and every 97th baseline trade, followed both ways).
- No rows; `summary.json` has `base` and `pairs[].baseEntries`.

## Files

**rows.csv**, one row a trade, ordered by `T0`, then the pairs' order, then **fade before flow**:
`dir, pair, open, T0, zside, side, entry, share0, target, result, T, exit, pips, mae, minutes` (`dir` fade / flow;
`open` = `t[n]`, `T0` = `T(n)`, times as research/macd90.ts `iso` writes them (`2024-01-02T03:15:00Z`); `result` tp /
open; numbers as JavaScript's `String()` writes a double, as research/macd90m-spec.md's rows-tp.csv). The header line
first; every line, the last included, ends with `\n`.

**summary.json** (`JSON.stringify(x, null, 1)`, nothing after the closing brace: no newline at the end):

```
{ meta: { start, end, loadFrom, share, tp, tf },
  pairs: [ { pair, bars, minutes, short, zoneless, judged, signals, entries, notMailed, prevAt, baseEntries,
             closeVsMinute: { bars, same, differ, noMinute, entrySame, entryDiffer, entryNoMinute } } ],
  dirs: { fade: GROUPS, flow: GROUPS },
  base: { all, <each pair>, BUY, SELL } }
```

- `pairs[]`, in the pairs' order: `bars` the chart's 15-minute bars (all, from `LOAD_FROM`); `minutes` the 1-minute
  bars loaded; `short`, `zoneless`, `judged` as above (bars in range); `signals` = `entries + notMailed`; `prevAt` the
  entries whose `Z(n−1)` (the bar before on its own 600-bar window; `n − 1 >= 599` and not null) is at `SHARE` on the
  entry's side; `baseEntries` the baseline's entries.
- `closeVsMinute`: over the chart bars in range (`T(n)` in [`START`, `END`)): `bars` their count; the last 1-minute bar
  loaded inside the bar (the highest `u` in [`t[n]`, `T(n)`)); `noMinute` when there is none; `same` when its bid close
  equals `bc[n]` and its ask close equals `ac[n]` (as doubles), `differ` otherwise (`same + differ + noMinute = bars`);
  `entrySame`, `entryDiffer`, `entryNoMinute` the same over the entries' bars.
- `GROUPS` = `{ all, <each pair>, BUY, SELL, top, bottom }` (BUY and SELL by the trade's side, top and bottom by the
  entry's side; a pair's key its name as `pairs[].pair` writes it, `"USD/JPY"`; the keys in this order, the pairs in
  theirs); `base` the same without top and bottom; each the `G` of research/macd90m-spec.md, its keys in the order
  below:

```
G = { "trades", "tp", "open",
      "pipsSum", "pipsMean", "pipsMedian",               // over all trades, open ones at their unrealized pips
      "tpMinutesMedian", "tpMinutesP90", "tpMinutesMax", // over tp
      "within60", "within1440", "within10080",          // tp with minutes <= 60, <= 1440, <= 10080
      "maeMedian", "maeP90", "maeMax",                  // over all trades
      "tpMaeMax",                                       // over tp
      "openPipsSum", "openPipsWorst", "openMaeMax", "openMinutesMax" }   // over open
```

Sums and means add the trades one by one from 0 in the rows' order (a group's trades in rows.csv's order; the
baseline's in the order its rows would have: by `T0`, then the pairs' order, then the BUY before the SELL); a mean is
that sum divided by the count. Medians: the middle value, or of the two middle ones `(a + b) / 2`. P90 of `n` values:
the value at rank `(9 * n + 9) // 10` (1-based) in ascending order. Null where there is no value (a sum over no trade
included); a count over no trade (`within…`) is 0.

**null.json** (MODE=null; the TypeScript's only: the walks go through the code the Python checks on walks 1 and 2,
the untidy walk and the real files, but the Python does not recompute these numbers):
`{ meta: { start, end, loadFrom, share, tp, tf, seeds }, walks: [ { seed, entries, gaps } ] }`; `gaps` has the keys `all`,
each pair, `BUY`, `SELL`, each `{ fade, flow, base, fadeMinusBase, fadeMinusFlow }`; `fade`, `flow`, `base` each
`{ trades, tpShare, pipsMean, openShare }` (the shares in % of the trades; null with no trade); a gap
`{ tpShare, pipsMean, openShare }`, fade's less the other's (null when either is). The print shows it only when its
`meta` (less `seeds`) equals summary.json's. The run with `END` a week earlier writes its own rows.csv and summary.json
(research/out/macdfade15-end1w in the workflow), checked by the Python like the main run's.

## Checks

On two seeded walks (MODE=synthetic: ownerhold-data.ts `synthesize`, seeds 1 and 2), before any real run:

1. The walk's 15-minute bars rebuilt from its minutes (research/macd90.ts `coarsen` on the 15-minute grid, bars
   opened at or after `LOAD_FROM`, closed by `END`, not wholly inside the weekend closure) are the walk's own
   (`synthesize`'s `q15`, the bars written as GMO's files).
2. The line at the close: at every signal's bar, every entry's bar and every 29th bar in range, `Z(n)` equals `zoneAt`
   on the 600 closes rebuilt, `Zp(n)` equals `zoneAt` at 598 of the MACD of the 599 closes ending at bar `n−1` (bit
   for bit), and the bar's signal read again from them is the same (none, or the same side).
3. No judged bar has `Z(n)` at `SHARE` on both sides.
4. At the email's v8 share (0.95, macd-level.ts `ZONE_SHARE`) the signals' fade side equals the email's own code
   `decideZoneOnWindow` (top SELL, bottom BUY) on every judged bar, whatever `SHARE` is.
5. Each entry's two trades: fade then flow, the same `pair, open, T0, zside, share0`, opposite sides, fade top SELL /
   bottom BUY; the entries bar `n`'s 15-minute ask close (BUY) and bid close (SELL); `T0 = t[n] + 15 minutes`;
   followed from the first minute at or after `T0`; a tp trade's pips `TP`, its exit the target, `T0 < T <=` the last
   minute's end; an open trade's pips below `TP` and `T` the last minute's end; `mae >= 0`; `minutes = (T − T0) / 1
   minute`.
6. Every entry trade followed again with the index (the baseline's segment trees) equals its plain walk; every 97th
   baseline trade followed again minute by minute equals the index's.
7. Look-ahead: for four entries a pair spread over the period (at 10%, 35%, 60% and 85% of its entries, in time),
   every price at or after `T0` moved by ±300 pips: every entry with `T0` at or before the cut stays (bar, side,
   `share0`, the first minute followed, the trades' sides and prices); every price at or after each of its tp trades'
   `T` moved: every tp trade with `T` at or before the cut stays (result, `T`, exit, pips, mae). The same for the
   baseline, on four of its entries spread over the period the same way.
8. The counts add up: fade and flow have the same entries; `tp + open = trades` in every group; trades = entries in
   `all` and in each pair; `BUY + SELL` and `top + bottom` are `all`; fade's `BUY` is flow's `SELL` count and the
   reverse; `signals = entries + notMailed`; `judged + short + zoneless` = the bars in range; the baseline's trades
   = 2 × its entries (all and each pair), its `BUY` and `SELL` one an entry each; the baseline's entries counted again
   from the minutes.
9. Hand-made minutes (research/macdfade15.ts `handCases`): a BUY whose tp minute also sets the worst against it (its
   `mae` counts that minute's bid low), a BUY through a minute that opens beyond the target (out at the target, pips
   `TP`), a SELL never reaching the target (open, valued at the last ask close); each followed both ways and held
   against numbers worked out by hand. (The walks seldom have a minute that both reaches the target and sets the worst,
   so the order "the worst first, then the target" is pinned here.) The Python has its own hand cases, worked out by
   hand apart from these (research/macdfade15-check.py `hand_cases`: the same three, a BUY never against it, and a SELL
   on a /USD pair whose target minute sets the worst). On walks 1 and 2 no minute both reaches the target and sets the
   worst: a follow that tested the target first would give the same rows there, so the order is held between the two
   implementations only by these hand cases and, later, by GMO's real minutes.
10. The weekend gate by hand (research/macdfade15.ts `gateCases`): in the first week whose Friday 20:30 bar closes at
    or after `START`, a signal at bars closing Friday 20:45, Friday 21:00, Friday 21:15, Saturday 12:15, Sunday 21:45,
    Sunday 22:00 and Monday 00:15 UTC, held against a table written by hand from the gate above (mailed: Friday 20:45,
    Sunday 22:00, Monday 00:15; the rest not): the entries and `notMailed` of the study and the baseline's entries.
    And over the walks of a synthetic run, `notMailed` must be above 0 (walk 2 has signals the gate keeps on the syn
    job's period): the gate is also tried on the walks' own bars.

MODE=walkfiles writes a walk as GMO's files (1-minute and 15-minute day files, both sides), reads them back through the
real run's loaders (`loadTf`, `loadM1`), writes rows.csv and summary.json, and stops unless they are byte for byte those
of the same walk computed in memory. The Python (research/macdfade15-check.py, written apart from the TypeScript from
this file) is run on the files of walks 1 and 2 and on the real run's, and must give every row and number. The real run
also follows every entry trade and every 97th baseline trade both ways before it writes anything.

The tidy walks have no minute outside a chart bar and no chart bar without a minute, and every 15-minute row has both
sides. So MODE=walkfiles with MESS=1 makes walk 1's files untidy before they are read back (research/macdfade15.ts
`messFiles`; with `q` = the row's open over 15 minutes and `u` over 1 minute, the first rule that holds): 15-minute rows
on one side (`q % 37 == 0`), crossed (`q % 41 == 1`), a time repeated in the next day's file whose first bid row is
then crossed with the last ask row, so the time's next bid row is taken (`q % 43 == 2`), a time repeated the same
(`q % 47 == 3`), closes moved a point (`q % 53 == 4`); 1-minute rows removed for a whole quarter (`q % 59 == 5`), on
one side (`u % 101 == 7`), crossed (`u % 211 == 8`), repeated in the next day's file 5 points apart (`u % 307 == 9`).
The minutes stay where 15-minute rows go, so some minutes are in no chart bar. The TypeScript stops unless each kind of
row reached the loaders on every pair, some minutes are in no chart bar, some chart bars come from a time's second bid
row, `closeVsMinute` has `differ > 0` and `noMinute > 1`, and the alignment check (Data) trips; it is not held against
the walk in memory (its chart is not the walk's), but the Python is run on the same files and must agree.

## On 1-hour bars (TF=1h)

The owner (2026-11-17, after the 15-minute run below): 「やっぱりメールの判断1時間足で」. `TF`, an environment variable of
both implementations: `15min` (not given or empty: everything above) or `1h`. With `TF=1h` the rule, the two trades,
the follow, the baseline, the files and the checks are the ones above on 1-hour bars, with these differences only:

- **The chart**: GMO's 1-hour day files (interval `1hour`, both sides), read as above through
  `loadTf(src, pair, "1h", LOAD_FROM, END, st, weekendOutOf("inside"))` and `historyRead(pair, "1h", quotes, END)`;
  `T(n) = t[n] + 1 hour`. Python: `load_tf(cache, sym, '1hour', 1 hour, …)`, as research/macd90m-check.py reads them.
- **The window and the pane**: 600 1-hour closes; the pane the newest 120 1-hour bars (the 1-hour chart's pane, v8's
  and v9's: about five trading days).
- **`LOAD_FROM`** 2023-10-01T00:00:00Z (600 1-hour bars are about 25 trading days; research/macd90m's).
- **The function's reads**: 0, 3 and 5 minutes after a close (signal-alerts/indicators.ts `gmoIntervalsDue`: `1h` at
  minutes 0, 3 and 5). All three are in the close's own hour, so the gate is as above: a bar is not read exactly when it
  closes at or after Friday 21:00 UTC and before Sunday 22:00 UTC.
- **Prices in**: GMO's own 1-hour bar's bid close and ask close. `closeVsMinute` and the stop on it as above, the
  minutes against the 1-hour bars.
- **The baseline**: each judged and mailed hour's first minute (research/macd90m-spec.md's baseline: each hour's first
  minute, a BUY and a SELL), about 59 minutes before a signal at the same bar would be. About 17,600 bars a pair.
- **Following**: the minutes in no 1-hour chart bar are followed too.
- **Check 1**: the bars rebuilt from the minutes on the 1-hour grid are held against the walk's 1-hour bars made from
  its own 15-minute bars (research/macdfade15.ts `hoursOf`: each side's open the first quarter's, high and low the
  quarters' highest and lowest, close the last quarter's; the same grid and filter). These are also the 1-hour files
  MODE=walkfiles writes (research/trend-data.ts `writeWalk`, as research/macd90m.ts writes them, its other timeframes
  empty; then the 1-minute and 15-minute files as above).
- **Check 10 by hand**: in the first week whose Friday 19:00 bar closes at or after `START`, a signal at bars closing
  Friday 20:00, 21:00 and 22:00, Saturday 13:00, Sunday 21:00 and 22:00, and Monday 01:00 UTC; mailed: Friday 20:00,
  Sunday 22:00, Monday 01:00. The 599 bars before them start 60 days before that Friday.
- **MESS**: `q` is the row's open over 1 hour; the same rules on the `1hour` rows; 1-minute rows removed for a whole hour
  (`q % 59 == 5`).
- **The syn job's period**: `LOAD_FROM` 2023-10-01, `START` 2023-11-10, `END` 2024-03-08T21:00Z: New York's winter, when
  the walks' market shuts Friday 21:00 UTC (in its summer, 20:00) and opens Sunday 22:00, so a Friday 20:00 bar exists
  and is the one bar a week the gate keeps.
- **Files**: research/out/macdfade1h (and -end1w); the forms above. `summary.json`'s `meta` and `null.json`'s `meta`
  end with `tf` (`"15min"` or `"1h"`; with `15min` too), and the print and its comparisons of `null.json` and of the run
  a week earlier hold `tf` too. With `TF=15min` every other byte written is as before `TF` (checked below).
- **Who wrote it**: the `TF` switch was written into both implementations by one hand, the same day, after their rule
  had been held between them on the 15-minute files. What was written apart is the rule above, not the switch.
- **Checked (the development container, 2026-11-17, before the real run).** `TF=15min` against the code before `TF`
  (commit 9bcfd70), on the syn job's 15-minute period: walks 1 and 2 and the untidy walk 1 written as files give the
  same rows.csv byte for byte and the same summary.json but its added `"tf": "15min"` line; MODE=synthetic prints the
  same lines but its first (which now names `tf`); the Python agrees on all three. `TF=1h` on the 1-hour syn period
  above: MODE=synthetic passes every check (hand cases 6, the gate by hand 7 bars, 4 signals kept by the gate over the
  two walks; walk 1 180 entries, walk 2 189); walks 1 and 2 read back from their files give the walk in memory byte for
  byte (rows.csv sha256 `fe7752b2…c296` and `60d64dc2…82ae`); the untidy walk 1 met every kind of untidy row, tripped the
  alignment check on all five pairs and wrote 350 rows; the Python agrees on all three (`PYTHON AGREES`).

## Result of the real 1-hour run (TF=1h; 2026-11-17, Actions run 44099401423, commit 53f7003)

The syn job passed on the 1-hour syn period (the walks' checks, walks 1 and 2 read back byte for byte, the Python on
them, the untidy walk and the Python on it). The real run read GMO's files (21,860 files: 21,800 from the caches, 60
fetched, none failed; 4,143 1-minute rows on one side left out) and the Python agreed with every row and number
(2,980 rows, 45,371 cells and fields; `PYTHON AGREES`), and again with `END` a week earlier (2,960 rows). Files:
rows.csv sha256 `9bd958cc40bab89ddbf6bef15d4c40bba578c86e0c5fcd52f1a0d21ed38605e9`, summary.json sha256
`60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2`, null.json sha256
`3d285440123d50ac776228092b1a2560db12ff1d114b97bbec676350175b9b96`; with `END` a week earlier rows.csv
`287d358657ba83c60595fbb306b92d306fbc0cfb9e5aa6bca44877235808a695`, summary.json
`ada0b69bcb772c4bc76f7e9e32afcd335291e9201d71e3d57d88e7ff0b075ed1` (artifact `macdfade15-1h-share0.96-tp10-44099401423`,
not downloaded: the development container's proxy refused the artifact host on the 15-minute run, so the numbers below
are copied from the job's printed lines). summary.json itself is in the repository since: the same study run again
(Actions run 44108923903 on d120a30, which printed the same sha256 for rows.csv, summary.json, null.json and the run a
week earlier) printed it as one base64 line, decoded into research/ledger/macdfade1h-summary.json, sha256 the same.

- The chart's 1-hour bars start 2023-10-26T21:00Z on every pair (18,726 bars), not at `LOAD_FROM`; why was not looked
  into. It changes no number here: every bar in range had 600 bars up to it (`short` 0, `zoneless` 0, 17,654 judged a
  pair), and a bar's line reads only the 600 closes ending at it.
- GMO's 1-hour close equalled the last 1-minute close inside the bar in every bar with a minute (differ 0 on all five
  pairs; 23 bars with no minute on USD/JPY, AUD/JPY and EUR/USD). `prevAt` 0 on every pair.
- Signals 1,501: entries 1,490, `notMailed` 11 (USD/JPY 2, AUD/JPY 2, EUR/USD 3, AUD/USD 4). Entries by pair: USD/JPY
  274, EUR/JPY 300, AUD/JPY 288, EUR/USD 316, AUD/USD 312.
- Take profit 10, no stop, from 2024-01-01 to 2026-11-10T21:00Z (open trades valued at the last minute loaded):

| all | trades | tp | open | pips a trade | open: sum / mean / worst | mae median / P90 / max | tp minutes median / P90 / max | open longest (min) |
|---|---|---|---|---|---|---|---|---|
| fade | 1,490 | 1,468 (98.5%) | 22 | +3.26 | −9,820.9 / −446.40 / −1,733.2 | 10.7 / 102.7 / 2,243.6 | 140 / 4,489 / 687,037 | 888,900 |
| flow | 1,490 | 1,469 (98.6%) | 21 | −2.08 | −17,790.6 / −847.17 / −1,941.0 | 14.7 / 109.9 / 2,527.3 | 183 / 6,302 / 1,024,954 | 959,700 |
| base | 174,912 | 172,831 (98.8%) | 2,081 | +3.20 | −1,168,310.8 / −561.42 / −2,241.5 | 13.1 / 105.8 / 3,271.7 | 213 / 6,059 / 1,046,272 | 1,130,939 |

- Fade: pips a trade median +10.00, sum +4,859.1; tp within 1 hour 508, 1 day 1,195, 1 week 1,380 of the 1,468; the
  largest loss on the way of a trade that did reach the target 1,937.9 pips.
- Fade a trade by pair (base): USD/JPY −0.26 (+5.74), EUR/JPY +4.30 (+3.28), AUD/JPY +4.44 (−0.77), EUR/USD +3.11
  (+2.60), AUD/USD +4.42 (+5.16). Open trades by pair: 3, 3, 4, 4, 8. Fade by side: bottom (BUY) 734 trades +5.84,
  open 9 (sum −2,966.9, worst −595.5); top (SELL) 756 trades +0.76, open 13 (sum −6,854.0, worst −1,733.2).
- Gaps against the ten driftless walks: fade − base +0.06 pips a trade (walks −4.10..+0.83: inside), −0.29 points of
  tp share (walks −0.45..+0.15: inside); fade − flow +5.34 pips a trade (walks −5.42..+5.81: inside). So on 1-hour bars
  the fade did not do better than entering with no signal beyond what chance gives on the walks; it is about the same
  as no signal. (Outside the walks' range: AUD/JPY's fade − base +5.20 and fade − flow +23.72; SELL's fade − base tp
  share −0.39 points and fade − flow +12.54; with ten walks about 2 gaps in 11 fall outside by chance alone.)
- With `END` a week earlier (2026-11-03T21:00Z): fade 1,480 trades, 98.5%, open 22, +3.02 a trade (open sum
  −10,110.1); flow −3.10; base +2.86.
- Orders not filled: 0 (in at the bar's close).

## Result of the real run (2026-11-17, Actions run 44077464383, commit fff5ddb)

**Superseded for the email's numbers (2026-11-19)** by "Result of the re-run on GMO's files read afresh" below: this run
read three GMO 1-minute day files that had been kept cut short (2025-06-20, 59 bars instead of 1,440). The 92 bars with
no minute below are those files.

The syn job passed (the walks' checks, walks 1 and 2 read back byte for byte, the Python on them, the untidy walk and
the Python on it). The real run read GMO's files (21,250 files: 21,030 from the caches, 220 fetched, none failed) and
the Python agreed with every row and number (12,012 rows, 180,850 cells and fields; `PYTHON AGREES`), and again with
`END` a week earlier (11,936 rows). Files: rows.csv sha256 `f2d27000b2999a523d3c4317fbe22392d32a54bbe244dbb1f0b6363fb7d65856`,
summary.json sha256 `76c86aa8fa1e4bce9e8ea77418bd32cd043166a5a420a2958747943f932a61e0` (artifact
`macdfade15-share0.96-tp10-44077464383`; not downloaded into the repository: the development container's proxy refused
the artifact host, so the numbers below are copied from the job's printed lines).

- GMO's 15-minute close equalled the last 1-minute close inside the bar in every bar with a minute (differ 0 on all five
  pairs; 92 bars with no minute on three pairs). `prevAt` 0, `short` 0, `zoneless` 0 on every pair.
- Signals 6,009: entries 6,006, `notMailed` 3 (USD/JPY, AUD/JPY, AUD/USD one each).
- Take profit 10, no stop, from 2024-01-01 to 2026-11-10T21:00Z (open trades valued at the last minute loaded):

| all | trades | tp | open | pips a trade | open: sum / mean / worst | mae median / P90 / max | tp minutes median / P90 / max | open longest (min) |
|---|---|---|---|---|---|---|---|---|
| fade | 6,006 | 5,926 (98.7%) | 80 | +2.41 | −44,784.5 / −559.81 / −1,913.4 | 11.9 / 104.0 / 2,975.8 | 144 / 5,740 / 784,561 | 959,205 |
| flow | 6,006 | 5,945 (99.0%) | 61 | +3.19 | −40,269.4 / −660.15 / −2,249.7 | 12.0 / 98.2 / 3,312.1 | 148 / 5,736 / 804,937 | 916,245 |
| base | 704,078 | 695,765 (98.8%) | 8,313 | +3.31 | −4,626,320.8 / −556.52 / −2,284.1 | 13.1 / 106.1 / 3,309.9 | 219 / 6,105 / 1,046,557 | 1,131,209 |

- Fade a trade by pair (base): USD/JPY +2.67 (+5.68), EUR/JPY +1.29 (+3.41), AUD/JPY −0.82 (−0.31), EUR/USD +3.86
  (+2.59), AUD/USD +4.94 (+5.18). Fade by side: bottom (BUY) 2,956 trades +6.29, open 28; top (SELL) 3,050 trades
  −1.35, open 52.
- Gaps against the ten driftless walks: fade − base −0.90 pips a trade (walks −0.80..+2.24: below their range),
  −0.15 points of tp share (walks −0.31..+0.23: inside); fade − flow −0.78 pips a trade (walks −2.25..+5.70: inside).
  So the fade did not do better than entering with no signal; the gap's sign is against it, and a gap outside ten walks'
  range is not a test (about 2 times in 11 by chance alone).
- With `END` a week earlier (2026-11-03T21:00Z): fade 5,968 trades, 98.7%, open 80, +1.96 a trade (open sum
  −47,194.0); flow +2.73; base +2.97.
- Orders not filled: 0 (in at the bar's close).

## Result of the re-run on GMO's files read afresh (2026-11-19, Actions run 44535888012, main 9ca2054)

The 15-minute run for the email's numbers (research/macdfade15min-prod-spec.md 4.5): a `workflow_dispatch` with `tf`
`15min` on main, whose caches did not hold the branch's files, so the study read GMO's files from main's caches and
fetched the rest (its study step took 10 min 52 s; the branch's run 44537377516, on the branch's caches, took 53 s). The
code is run 44077464383's but for 53f7003, which added `tf` to the summary's `meta` and nothing else on 15-minute bars
(walks: byte for byte; research/macdfade15.ts and its imports otherwise unchanged since fff5ddb). The syn job passed, the
Python agreed with every row and number, and again with `END` a week earlier.

**Why the numbers differ from run 44077464383.** The two runs' caches were restored side by side (Actions run
44546585012, .github/workflows/gmo-cache-diff.yml; no price printed): of the 21,250 GMO day files both runs read, 21,247
hold the same bars and status (12,920 the same bytes; 8,327 answered again by GMO, so other `responsetime` bytes); three
differ, all 1-minute files of GMO's day 2025-06-20 (a Friday): AUD_JPY bid, EUR_USD bid and USD_JPY ask. The branch's
copies hold 59 bars, main's 1,440; the 59 are among the 1,440 with the same values. Both copies were made by GMO on
2025-06-22 at 22:00 UTC, so the loader's whole-file test (research/ownerhold-data.ts `wholeDayFile`: made after the day
ended) took the short ones as whole. With one side's minutes missing for 1,381 minutes, 92 of that day's 15-minute bars
had no minute on those three pairs (`closeVsMinute.noMinute` 92 in run 44077464383, 0 here), and every number below that
reads those minutes moved:
- the baseline gains 92 bars on each of the three pairs (184 trades each, 552 in all: 704,078 → 704,630); its mean a
  trade +3.311 → +3.316 (by pair: USD/JPY +5.685 → +5.691, AUD/JPY −0.312 → −0.298, EUR/USD +2.591 → +2.601);
- the fade's and the flow's trades, take-profit counts, open trades, pips (sums and means), open sums, worst, longest
  and mae max are unchanged; the minutes to the target of the trades open over that day are shorter (fade: median 144 →
  143, P90 5,740 → 5,681; flow: P90 5,736 → 5,707), and so are a few within-1-hour / within-1-day counts and medians by
  pair or side (`dirs.fade.SELL.maeMedian` 12.1 → 12.05; `dirs.fade["USD/JPY"].maeP90` 114.3 → 113.6);
- the entries on a bar with no minute: 6 → 0 (USD/JPY 2, AUD/JPY 3, EUR/USD 1).
Every changed value is listed by the comparison of the two summary.json files (research/ledger/macdfade15-summary.json
against run 44537377516's copy, which equals run 44077464383's without its `tf` line). The 1-hour run 44099401423 (v40's
numbers) read the same short files (its 23 bars with no minute on the same three pairs); it is not re-run here.

Files: rows.csv sha256 `b73115a0668b3c50b76f2f4507095adac8423e7ae08a9d68a5309d6cddfb0f37`, summary.json sha256
`eacb7815d7779be716b24e559c0aea139e6455910abcf4b1ec59ab4d8c5eb188` (16,817 bytes; without the bytes `,\n  "tf": "15min"`
`74a4a230a291d68a8e8169ea293a5428f46863ffc0ed86804522f4f509cc888b`), null.json
`a0d390456ebc5ce5747bc88623dc756440165b55e19a2689c44041c7c1d6791e`, the run a week earlier: rows.csv
`12673c1be727ded8f14c3fdf756d5aa6f65bf6a8a2dd7d24ead2e0e4c439d1a8`, summary.json
`505e4fe7b90307f1b42a5d11f8de157cfe086879223ce7784a354d592c4086b6`. summary.json is in the repository:
research/ledger/macdfade15-summary.json, decoded from the job's base64 line, the same sha256.

- GMO's 15-minute close equalled the last 1-minute close inside the bar in every bar (differ 0, no minute 0, on all
  five pairs). `prevAt` 0, `short` 0, `zoneless` 0 on every pair.
- Signals 6,009: entries 6,006, `notMailed` 3 (USD/JPY, AUD/JPY, AUD/USD one each).
- Take profit 10, no stop, from 2024-01-01 to 2026-11-10T21:00Z (open trades valued at the last minute loaded):

| all | trades | tp | open | pips a trade | open: sum / mean / worst | mae median / P90 / max | tp minutes median / P90 / max | open longest (min) |
|---|---|---|---|---|---|---|---|---|
| fade | 6,006 | 5,926 (98.7%) | 80 | +2.41 | −44,784.5 / −559.81 / −1,913.4 | 11.9 / 104.0 / 2,975.8 | 143 / 5,681 / 784,561 | 959,205 |
| flow | 6,006 | 5,945 (99.0%) | 61 | +3.19 | −40,269.4 / −660.15 / −2,249.7 | 12.0 / 98.2 / 3,312.1 | 148 / 5,707 / 804,937 | 916,245 |
| base | 704,630 | 696,317 (98.8%) | 8,313 | +3.32 | −4,626,320.8 / −556.52 / −2,284.1 | 13.1 / 106.1 / 3,309.9 | 219 / 6,093 / 1,046,557 | 1,131,209 |

- Fade a trade by pair (base): USD/JPY +2.67 (+5.69), EUR/JPY +1.29 (+3.41), AUD/JPY −0.82 (−0.30), EUR/USD +3.86
  (+2.60), AUD/USD +4.94 (+5.18). Fade by side: bottom (BUY) 2,956 trades +6.29, open 28; top (SELL) 3,050 trades
  −1.35, open 52.
- Gaps against the ten driftless walks (the walks are the generator's, the same as before): fade − base −0.91 pips a
  trade (walks −0.80..+2.24: below their range), −0.15 points of tp share (walks −0.31..+0.23: inside); fade − flow
  −0.78 pips a trade (walks −2.25..+5.70: inside). The same reading as before: the fade did not do better than entering
  with no signal, and a gap outside ten walks' range is not a test.
- With `END` a week earlier (2026-11-03T21:00Z): fade 5,968 trades, 98.7%, open 80, +1.96 a trade (open sum
  −47,194.0); flow +2.73; base +2.98.
- Orders not filled: 0 (in at the bar's close).

## Not measured here

Gold and the shares (no bid and ask minutes in the study's data); the function's own reading of the bar (GMO's answer
at the time of the read, a bar GMO changes later, a read the function misses); the time between the bar's close and
the owner's order (the function reads 0, 1 and 3 minutes after the close, the email is then sent, and the order is
placed by hand) and the price then: every trade here is in at the bar's exact closing price and may reach its target
from the first minute after the close; what a trade costs beyond the spread paid (GMO's bid and ask); a stop of any
kind; whether the fade does better than no signal beyond chance on GMO's own prices (the driftless walks give a range
on the generator's prices, not a test).
