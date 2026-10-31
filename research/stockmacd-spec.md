# The 1-hour MACD email's rule on US and Japanese shares (#390, docs §8.133)

The owner (2026-10-31): 「株にも対応してほしい」, then the stocks' chart and email, US and Japanese individual
shares, from Yahoo. The chart is out (#389, docs §8.132). Before any email, the 1-hour MACD email's rule (v8,
`_shared/macd-level.ts decideZoneOnWindow`, docs §8.122/§8.129) is measured here on the shares' past hourly bars,
followed the owner's way (a limit at E, a take-profit, no stop). Shares have no pips, so the take-profit is a share
of the price, four sizes. This file fixes every number, so that a second implementation reproduces every row.

## Data

- Shares (22, in this order): NVDA, INTC, AAPL, MSFT, GOOGL, AMZN, META, TSLA (market `us`); 7203.T, 6758.T, 9984.T,
  8306.T, 6861.T, 9983.T, 8035.T, 7974.T, 9432.T, 6501.T, 7267.T, 6920.T, 4063.T, 8058.T (market `jp`).
- One file per share, Yahoo's answer as it came (JSON), `<DIR>/<SYMBOL>.json`, from
  `https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?interval=60m&range=730d&includePrePost=false`
  (the most hourly bars Yahoo keeps: 730 days).
- END = 2026-10-31T00:00:00Z: only bars that open before END are used (all of them closed by then).

### The bars (as the live chart reads them: `supabase/functions/live-chart/stocks.ts parseYahooChart`, then rounded)

`r = body.chart.result[0]`; `ts = r.timestamp` (seconds); `q = r.indicators.quote[0]` with arrays `open, high, low,
close`; `meta = r.meta`. The session: `meta.currentTradingPeriod.regular.start` and `.end` (seconds), used only when
both are numbers and `end > start` (else there is none).

Walk `k = 0 .. len(ts)-1`, keeping `lastT` = the timestamp (seconds) of the last bar appended (none at first):
1. Skip `k` when `ts[k]` or any of `open[k], high[k], low[k], close[k]` is not a finite number, or `close[k] <= 0`,
   or `low[k] <= 0`, or `high[k] < low[k]`.
2. When there is a session, `ts[k] >= end`, at least one bar has been appended, and `ts[k] - lastT < 86400`: join it
   to the last bar appended (that bar's `high = max(high, high[k])`, `low = min(low, low[k])`, `close = close[k]`;
   its `open` and time stay; `lastT` stays). This is Yahoo's point at the session's close (the closing auction).
3. Else append the bar `(t = ts[k] * 1000 ms, open, high, low, close)` and set `lastT = ts[k]`.

Then keep the bars with `t < END`, and round each of open, high, low and close to the chart's decimals (`us` 2,
`jp` 1) as JavaScript's `Number(v.toFixed(d))` does: on the double's exact value, a half rounded away from zero
(Python: `float(Decimal(v).quantize(Decimal(1).scaleb(-d), ROUND_HALF_UP))`). Everything below uses the rounded
bars, numbered `i = 0 ..` oldest first.

## The rule (v8, unchanged)

For each bar `i >= 599`: the window is the closes of bars `i-599 .. i`. MACD 12, 26, 9 as Pine's (`ema` seeded with
the simple mean of the first `n`, summed oldest first, then `alpha * x + (1 - alpha) * prev`, `alpha = 2 / (n + 1)`;
line = ema12 − ema26; signal = ema9 of the line from its first defined value; hist = line − signal). At index `k`
of the window, `top(k)` = the highest of 0 and the line, signal and hist over `k−119..k`; `bottom(k)` the lowest
(with 0). `inTop(k)`: `top > 0 and line[k] >= 0.95 * top`; `inBottom(k)`: `bottom < 0 and line[k] <= 0.95 * bottom`.
At index 599: SELL if `inTop(599) and not inTop(598)`, BUY if `inBottom(599) and not inBottom(598)`, else none (598
judged in the same window, on its own 120). Each SELL or BUY is an email: side, `E` = the bar's close.

## Each email followed, the owner's way, for each take-profit size

Sizes `x` (percent of E, in this order): 0.1, 0.25, 0.5, 1. `dir` = +1 for BUY, −1 for SELL.
`TP = E * (1 + dir * x / 100)` (evaluated in that order, doubles; not rounded).

- **Fill** (a limit at E from the next bar; better prices fill at once): walk `j = i+1 ..` (the last bar at most):
  BUY: if `open[j] <= E` filled at `open[j]` (mode `open`); else if `low[j] <= E` filled at `E` (mode `limit`).
  SELL: `open[j] >= E` at `open[j]`; else `high[j] >= E` at `E`. The first `j` that fills is the fill bar `f`, `F`
  the fill price. None: unfilled.
- **Take-profit** (a limit at TP; no stop): walk `k = f ..` (the last bar at most), but when the fill's mode was
  `limit` start at `k = f + 1` (in the fill bar, whether TP came after the fill cannot be told from hourly bars:
  `sameBar` = 1 when that bar touched TP: BUY `high[f] >= TP`, SELL `low[f] <= TP`; else 0). For a fill of mode
  `open`, the fill bar is walked too (the open is the bar's first price). BUY: if `open[k] >= TP` out at `open[k]`
  (mode `open`; a gap past TP fills better); else if `high[k] >= TP` out at `TP` (mode `limit`). SELL: `open[k] <= TP`
  at `open[k]`; else `low[k] <= TP` at `TP`. The first such `k` is the exit bar. None: held at END, out at the last
  bar's close (`held` = 1).
- **pct** = `dir * (exit - F) / F * 100` (that order).
- **mae** (percent, the worst move against the trade from F, 0 at least): the highest of `dir * (F - adv) / F * 100`
  over bars `f .. ex` (the exit bar, or the last bar when held), `adv` = `low` for BUY and `high` for SELL; then
  `max(0, that)`. (The fill bar's own low may be before the fill, and the exit bar's after the exit: this can only
  make it larger than it was.)
- **holdH** = `(t[ex] - t[f]) / 3600000` (calendar hours between the two bars' opens), **holdBars** = `ex - f`.

## Output (OUT/rows.csv, OUT/summary.json; written by research/stockmacd.ts)

rows.csv, header `sym,market,i,open,side,E,x,TP,filled,fillMode,fillT,F,exitMode,exitT,exit,held,pct,mae,holdH,holdBars,sameBar`:
one row per email and size, ordered by the shares' order above, then `i`, then `x`. `open` and the times: ISO
`YYYY-MM-DDTHH:MM:SSZ` (`fillT`, `exitT`: the opens of bars `f` and `ex`). Numbers as JavaScript's `String(x)` writes
them (the shortest form that reads back to the same double); flags `1`/`0`. Unfilled: `fillMode`, `fillT`, `F`,
`exitMode`, `exitT`, `exit`, `pct`, `mae`, `holdH`, `holdBars` empty, `held` 0, `sameBar` 0. Held at END:
`exitMode` empty, `exitT` the last bar's open, `exit` its close.

summary.json:
- `meta`: `end` (ISO), `sizes` ([0.1, 0.25, 0.5, 1]), `symbols` (the 22).
- `shares`: one per share: `sym`, `market`, `bars` (after the walk and END), `first`, `last` (ISO opens),
  `judged` (bars with 600 up to them), `mails`, `buys`, `sells`.
- `sizes`: for each size (key `String(x)`): `all`, `us`, `jp`, and one per share, each the stats of its rows:
  `mails, filled, unfilled, tp, held, sameBar, gapExits, win, pctSum, pctMean, pctMedian, heldPctSum, heldPctMin,
  maeMedian, maeMax, holdMedian, holdMax` — `win` = 100 × tp / filled; `gapExits` = exits of mode `open`; sums and
  means over the filled rows in their order above (`pctSum` the TP's and the held rows' together); medians the mean
  of the two middle values of an even count; `heldPct*` over the held rows; `mae*` and `hold*` (`holdH`) over the
  filled rows; a sum of nothing is 0 (as research/macdlive-spec.md's), any other number of nothing is null.

A second implementation (research/stockmacd-check.py) parses the same files with its own code, decides with its own
MACD, follows each email with its own code, and must find the same rows (every column; numbers equal as doubles)
and the same numbers (equal, or within 1e-9 relative for sums and means).
