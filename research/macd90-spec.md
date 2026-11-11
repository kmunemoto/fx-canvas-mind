# Riding the MACD line from 90% to 96% of the pane

The owner (2026-11-11), after asking whether the EUR/USD 1-hour MACD email was near (the blue line was at 94% of the
way to the pane's bottom, the email's mark being 95%): 「90%に届いたらその流れにのって注文を入れて、96%までそのままいく
確率を求めて」. So: when the blue line reaches 90% of the way from the zero line to the pane's top (bottom), an order
is put in the way it is going (a BUY toward the top, a SELL toward the bottom), and the question is how often the
line then goes on to 96%. This file fixes that as numbers, so that a second implementation can reproduce every row.
Nothing here changes an email.

## Data

- Pairs: USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD (GMO's; gold has no GMO files and is not measured).
- 1-hour bars from LOAD_FROM = 2023-10-01T00:00:00Z to END = 2026-11-10T21:00:00Z: trend-data.ts `loadTf` (Python:
  research/flowz-check.py `load_tf`), GMO's 1-hour day files, bid and ask merged, the weekend "inside" rule.
- Each bar's close for the MACD: the chart's mid, `round_chart((bid close + ask close) / 2, d)`, d = 3 on a yen pair
  and 5 on the others (live-chart historyRead, as research/macdlive.ts `midBars`). Bar `i` opens at `t[i]` and
  closes at `T(i) = t[i] + 1 hour`. The bid and ask of bar `i` are the merged bar's own (the same `t`).
- Entries: the bars whose close `T(i)` is in `[START, END)`, START = 2024-01-01T00:00:00Z. A trade is followed on
  every later bar loaded (all close by END).

## Where the blue line stands (v8's pane, unchanged)

For bar `i` (at least 600 bars up to it), the window is the 600 mid closes `t[i−599..i]`, and its MACD 12, 26, 9 as
the email's (_shared/macd.ts: Pine's EMAs seeded with the simple mean of the first n; line = ema12 − ema26; signal =
ema9 of the line from its first value; hist = line − signal). At index `k` of the window, `top(k)` = the highest of
0 and the line, signal and hist over `k−119..k`, `bottom(k)` the lowest (_shared/macd-level.ts `zoneAt`). Write
`m(k)` for the line at `k`.

For a share `s` (0.90 or 0.96) and a side:

- top side: `top(k) > 0 and m(k) >= s * top(k)`
- bottom side: `bottom(k) < 0 and m(k) <= s * bottom(k)`

`Z(i)` is index 599 of bar `i`'s window (the bar itself, judged on its own window); `Zp(i)` is index 598 of the same
window (the bar before, judged in bar `i`'s window, as the email's rule judges "was it out of the band before").

## The entry (the 90% bar)

Bar `i` (close in `[START, END)`) is an entry when, for one side, `Z(i)` is at 90% and `Zp(i)` is not (the line came
into the 90% band at this bar, as the email's 95% entry is read). The two sides cannot both be (the top band is above
zero, the bottom below). The order rides the flow: **top side → BUY, bottom side → SELL**. Entry price: bar `i`'s close
on the side paid, the ask close for a BUY, the bid close for a SELL (the spread is paid). `share0` = `m / top` (top
side) or `m / bottom` (bottom side) at `Z(i)`.

An entry whose `Z(i)` is already at 96% is **already** (the bar jumped past 96% at once): counted, followed no further,
not in the rates below.

## Following it (each later bar judged on its own window)

For `j = i+1, i+2, …` (bars loaded), with `Z(j)`:

- **reached**: `Z(j)` at 96% on the entry's side.
- main way, **A (the band)**: failed at the first `j` where `Z(j)` is not at 90% on the entry's side, if that comes
  before any reached.
- wide way, **B (the zero line)**: failed at the first `j` where the line is on the zero line or the other side
  (`m(Z(j)) <= 0` on the top side, `>= 0` on the bottom side), if that comes before any reached.

Each way ends a trade at its first event (reached or failed); `jx` is that bar. **open**: no event by the last bar
loaded (`jx` = the last bar). One trade per entry; entries are not skipped while another trade of the pair is open
(a new entry needs the line to have left the 90% band and come back, so in way A trades cannot overlap; in way B
they can).

## Each trade's numbers (per way)

- `result`: reached / failed / open.
- `pips`: closed at bar `jx`'s close: a BUY `bid close(jx) − entry`, a SELL `entry − ask close(jx)`, in pips (0.01
  on a yen pair, 0.0001 on the others), the spread paid both ways. For open, the same at the last bar (unrealized).
  Worked in whole points so that both implementations give the same double: `P(x) = round(x * 10^d)` (an integer,
  d = 3 or 5 as above), pips = (difference of the P's) / 10.
- `mae`: the worst it went against the trade over bars `i+1..jx` (bars' own highs and lows on the side that would
  close it: a BUY `entry − min(bid low)`, a SELL `max(ask high) − entry`), in pips, 0 if it never went against.
- `bars`: `jx − i` (1-hour bars held, weekends not counted); `hours`: `(T(jx) − T(i)) / 1 hour`.
- `share_x`: `m / top` or `m / bottom` at `Z(jx)`.

## The numbers (all pairs; each pair; each side)

entries, already, then for each way: reached, failed, open, **reached / (reached + failed)** (%), pips summed (reached
and failed), pips a trade (mean, median; reached and failed apart too), MAE (median, max), bars held (median, max),
and the open trades' count and unrealized pips (summed, worst).

## Rows

rows.csv, one row per entry (already included), ordered by `T(i)`, then the pairs' order above:
`pair, open, T, side, entry, share0, already, A_result, A_T, A_exit, A_pips, A_mae, A_bars, A_share, B_result, B_T,
B_exit, B_pips, B_mae, B_bars, B_share` (times ISO UTC without milliseconds, an already row's A_/B_ cells empty;
`already` 1 or 0; `A_T` is `T(jx)`, `A_exit` the close paid at `jx`; numbers as the language prints a double, the
shares compared within 1e-9, everything else exactly).

summary.json:

```
{ "meta": { "start", "end", "loadFrom" },
  "pairs": [ { "pair", "bars", "entries" } ],                 // bars: 1-hour bars loaded
  "groups": { "all": G, "USD/JPY": G, …, "BUY": G, "SELL": G } }
G = { "entries", "already", "A": W, "B": W }
W = { "reached", "failed", "open", "rate",                    // rate: 100 * reached / (reached + failed), null if none
      "pipsSum", "pipsMean", "pipsMedian",                    // over reached and failed
      "reachedPipsMean", "failedPipsMean",
      "maeMedian", "maeMax", "barsMedian", "barsMax",         // over reached and failed
      "openPipsSum", "openPipsWorst" }                        // the open trades' unrealized pips (worst = lowest)
```

Sums and means add in the rows' order; a median is the middle value, the mean of the two middle ones for an even
count; null where there is no value, a sum over no trade included (`pipsSum`, `openPipsSum`: null, not 0).

## Checks (on seeded walks, before the real run)

- With s = 0.95 the entry test is the email's: on every bar of the walk, the 95% entry computed here equals
  `decideZoneOnWindow` (side included).
- Look-ahead: for a sample of entries, every price after `T(jx)` moved by ±300 pips: the entry and each way's
  result, `jx`, pips and mae stay; every price after `T(i)` moved: the entry stays.
- The counts add up (reached + failed + open + already = entries for each way).
- The Python (research/macd90-check.py, written apart from this file's TypeScript) on the same files gives every row
  and number; the numbers are printed only when they agree.
