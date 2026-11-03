# The similar-past forecast (似た相場の予測, #392, docs §8.135): the rule, exactly

The owner (2026-11-02), with a screen recording of an Instagram video (@KFX024, TradingView, 50 s,
captions only): 「これと同じインジケーター作れる？ 過去から似た相場を探してきて、先のチャートの動きを
予測して表示する。」; asked, the owner chose the app's chart (not TradingView) and no email yet (the
chart first, its accuracy measured).

What the video shows (its captions and frames, in order):

1. 「実はこのインジケーター まだ動いていない未来のチャートに この先の値動きを予測して表示してくれます」:
   to the right of the newest bar, about 20 bars ahead, three dashed lines with the area between them
   filled (green above the middle, red below it).
2. 「しかも適当に線を引いているわけではなく 今と似た過去の相場を探して その後どう動いたのかを分析しています」.
3. 「まずこの灰色の点線に注目 値動きの中心的な予測です」「そして上の緑と下の赤いライン これは予測の幅を
   示しています」.
4. 「例えば灰色の線が上向きならロングを検討します」「損切りは緑と赤の予測を頼りに引いて」「利確は灰色の
   線を参考にして決めます」.

The video does not name the indicator nor give its numbers (「インジケーター名と設定方法を知りたい人は
コメントに…DMに送信します」). This file fixes a rule that does what the captions say, every number
marked APP (chosen here, not from the video) or VIDEO, so that the chart and the measurement compute
with one function (`supabase/functions/_shared/analog-forecast.ts`) and a second, independent
implementation can reproduce every forecast.

## Input

`c[0..n-1]`: the closes of closed bars, oldest first (doubles). The anchor (the bar the forecast is
made at) is `a = n-1`: everything below reads only `c[0..a]`.

## Constants

| name | value | source |
|---|---|---|
| `pattern` (L) | 20 | APP: the bars of the shape compared (21 closes) |
| `horizon` (H) | 20 | VIDEO: the forecast reaches about 20 bars past the newest one (frames at 0 s, 24 s) |
| `matches` (K) | 10 | APP: the past places used |
| `window` (W) | 1500 | APP: the bars searched, the anchor's included (the live chart reads 1400 bars of deep history and its own) |
| `gap` (G) | 20 | APP: two places chosen are at least this many bars apart |

## The rule

1. **The pool.** `s = max(0, a - W + 1)`. Every close `c[s..a]` must be a finite number `> 0`, and
   the shape's first bar must be in the pool (`a - L >= s`), else there is no forecast.
2. **The shape now.** For `k = 0..L-1`: `p[k] = c[a-L+k] / c[a] - 1` (in that order: the division,
   then the subtraction). (`k = L` would be `0` on both sides and is left out.)
3. **The candidates.** Every `j` with `s + L <= j <= a - H` (the place's own shape starts in the pool,
   and its `H` bars after are all at or before the anchor: nothing after `a` is read). For each,
   `q[k] = c[j-L+k] / c[j] - 1` and the distance `d(j) = Σ_{k=0..L-1} (q[k] - p[k])²`, summed in the
   order `k = 0, 1, …, L-1` (each term `(q[k] - p[k]) * (q[k] - p[k])`, added to a running sum that
   starts at `0`). No square root.
4. **The places.** The candidates ordered by `d` ascending, ties by `j` descending (the newer first).
   Walk them in that order; take `j` unless a place already taken is fewer than `G` bars from it
   (`|j - t| < G`); stop at `K` places. Fewer than `K` places: there is no forecast.
5. **Each place's path.** For a place `j` and `h = 1..H`: `f_j[h] = c[a] * (c[j+h] / c[j])` (the
   division first). `f_j[0] = c[a]`.
6. **The lines.** For each `h = 0..H`, over the `K` values `f_j[h]` (the places in the order taken):
   - `mid[h]` (the grey dotted line, VIDEO 「値動きの中心的な予測」): the median — the values sorted
     ascending (`v[0] <= … <= v[K-1]`); `K` odd: `v[(K-1)/2]`; `K` even: `(v[K/2-1] + v[K/2]) / 2`.
     APP: the median (the video does not say which centre).
   - `up[h]` (the green line, VIDEO 「予測の幅」): the highest, `v[K-1]`. APP: the highest and lowest of
     the places (the video does not say which width).
   - `lo[h]` (the red line): the lowest, `v[0]`.
   (`mid[0] = up[0] = lo[0] = c[a]`.)
7. **The direction.** `mid[H] > c[a]`: up (`1`); `mid[H] < c[a]`: down (`-1`); equal: flat (`0`).

## Output

`{ a, start: s, places: [{ j, d }] (the order taken), mid[0..H], up[0..H], lo[0..H], dir }`, or
`null` (step 1 or 4). Indices are on `c`.

## On the chart

The newest closed bar is the anchor (a forming bar is not read). The pool is the deep history and the
chart's closed bars, `W` of them at most. The lines start at the anchor's close and step one bar slot
to the right per `h`; slots past the newest bar are kept on screen while the newest bar is. Fewer than
`W` bars read: the forecast is still drawn, and its note says how many were searched (the measurement
uses `W`).

## The measurement (research/analog.ts; fixed before any real bar was read)

### Data

- Pairs (in this order): USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD. Timeframes (in this order): `15min`,
  `1h`, `4h`. `pip` = 0.01 for a yen pair, 0.0001 for the others.
- The bars, as the live chart reads them: GMO's bid and ask files (`research/.cache`, the GMO API's layout:
  `<SYMBOL>/<15min|1hour|4hour>/<bid|ask>/<key>.json`, day keys for 15min and 1hour, year keys for 4hour),
  merged and with the weekend's bars left in (`research/trend-data.ts loadTf`, weekend "inside"), opened at or
  after `LOAD_FROM` and closed by `END`; then the chart's own reading (`live-chart/logic.ts historyRead`: the mid
  of bid and ask for open, high, low and close, each rounded to the chart's decimals, 3 on a yen pair and 5 on
  the others). Bars `i = 0 ..`, oldest first; `t[i]` the open (ms), `step` the timeframe's length.
- `LOAD_FROM` = 2023-01-01T00:00:00Z, `START` = 2024-01-01T00:00:00Z, `END` = 2026-10-31T00:00:00Z.

### Anchors

An anchor is every bar `a` with `a >= W - 1` (the forecast's pool is exactly `W` bars), `t[a] + step >= START`
(closed in the period) and `a + H <= n - 1` (its `H` bars after are loaded). At each anchor the forecast `f` is
`analogForecast(closes, a)` (the closes of all loaded bars; only `c[a-W+1..a]` are read). `f` null: the anchor
counts in `none` and nowhere else.

For an anchor with a forecast:
- `act` = `c[a+H]` (the close `H` bars later). `up` when `act > c[a]`, `down` when `act < c[a]`, else `still`.
- `hit`: `dir != 0` and the actual move has `dir`'s sign; `miss`: `dir != 0` and the other sign; neither when
  `dir == 0` or the close did not move.
- `move` (pips, only when `dir != 0`): `dir * (act - c[a]) / pip` — what following the grey line from the
  anchor's close to `H` bars later came to.
- `errMid` = `abs(act - mid[H]) / pip`, `errFlat` = `abs(act - c[a]) / pip` (the forecast "no change").
- `inside` = the count of `h = 1..H` with `lo[h] <= c[a+h] <= up[h]`.

### Flips (the bars a trade would be taken at)

An anchor `a` with `dir != 0` is a flip when the forecast at `a - 1` exists (`a - 1 >= W - 1`, whether or not it
closed in the period, and not null) and its `dir` differs from `a`'s. `side` = BUY for `dir = 1`, SELL for
`-1`.

- **The video's way** (「灰色の線が上向きならロング」「損切りは緑と赤の予測を頼りに」「利確は灰色の線を参考に」;
  APP: these exact levels). Entry at the next bar's open `X = o[a+1]`. `TP = mid[H]`; `SL` = BUY: the lowest of
  `lo[1..H]`, SELL: the highest of `up[1..H]`. `skipped` when the levels are not on their sides (BUY: not
  `SL < X < TP`; SELL: not `TP < X < SL`). Else walk `k = a+1 .. a+H`: for `k > a+1`, a bar opening at or past
  `SL` (BUY `o[k] <= SL`) is `stop` at `o[k]`, at or past `TP` (BUY `o[k] >= TP`) is `tp` at `o[k]`; then a bar
  whose range reaches both (BUY `l[k] <= SL` and `h[k] >= TP`) is `both` (which came first is not in the bar;
  no P/L); only `SL`: `stop` at `SL`; only `TP`: `tp` at `TP`. None by `a+H`: `time`, out at `c[a+H]`.
  `pips = dir * (exit - X) / pip`; `bars` = the exit bar minus `a+1`.
- **The owner's way** (CLAUDE.md, §8.102's main line: a limit at `E`, take-profit 10 pips, no stop). `E = c[a]`,
  `TP = E + dir * 10 * pip` (evaluated left to right). Fill: walk `j = a+1 ..` (the last loaded bar at most):
  BUY `o[j] <= E` fills at `o[j]` (mode `open`), else `l[j] <= E` at `E` (mode `limit`); SELL `o[j] >= E` /
  `h[j] >= E`. The first such `j` is `f`, `F` its price; none: `unfilled`. Take-profit: walk `k` from `f` (mode
  `open`) or `f+1` (mode `limit`; `sameBar` = 1 when the fill bar reached `TP`: BUY `h[f] >= TP`, SELL
  `l[f] <= TP`; else, and for a fill of mode `open` or none, `sameBar` = 0) to the last bar: BUY `o[k] >= TP` out at `o[k]`, else `h[k] >= TP` out at `TP` (SELL mirrored).
  None: `held`, valued at the last bar's close. `pips = dir * (exit - F) / pip`; `mae` = the largest of 0 and
  `dir * (F - adv) / pip` over bars `f ..` the exit bar (the last bar when held), `adv` = `l` for BUY, `h` for
  SELL; `bars` = the exit bar (the last bar when held) minus `f`.
- Spread is not paid (mid prices); nothing else is assumed.

### Output (OUT/rows.csv, OUT/flips.csv, OUT/summary.json)

Rows in the order timeframe, pair, `a`. Numbers as JavaScript's `String(x)` writes them; flags `1`/`0`; times ISO
`YYYY-MM-DDTHH:MM:SSZ`.

- rows.csv `tf,pair,open,dir,places,midH,upH,loH,midSum,upSum,loSum,act,inside`: one per anchor with a forecast.
  `places`: `a - j` of each place in the order taken, joined by `;`. `midSum` etc.: the sum of `mid[1..H]` (from
  0, `h = 1, 2, …` in order).
- flips.csv `tf,pair,open,side,X,TP,SL,vRes,vExit,vPips,vBars,E,oTP,filled,fillMode,F,sameBar,oRes,oExit,oPips,
  mae,oBars`: one per flip. `vRes` one of `tp, stop, both, time, skipped` (`vExit`, `vPips`, `vBars` empty when
  `both` or `skipped`); `oRes` `tp`, `held` or `unfilled` (unfilled: `filled` 0, `sameBar` 0, and `fillMode`,
  `F`, `oExit`, `oPips`, `mae`, `oBars` empty).
- summary.json: `meta` (`start`, `end`, `loadFrom`, `params` = the constants, `tfs`, `pairs`); `tfs`: for each
  timeframe, `pairs` (per pair: `bars`, `first`, `last`, `anchors`, `firstAnchor`, `lastAnchor`) and `all`, `byPair`
  (each pair), `byYear` (the anchor's close's UTC year) each holding:
  - `anchors`, `none`, `dirUp`, `dirDown`, `dirFlat`, `hit`, `miss`, `hitRate` (`hit / (hit + miss)`),
    `actUp`, `actDown`, `upShare` (`actUp / (actUp + actDown)`), `moveMean`, `errMidMean`, `errFlatMean`,
    `insideShare` (the sum of `inside` / (`H` × anchors with a forecast)), `allInside` (anchors with
    `inside = H`);
  - `flips`: `n`, `buy`, `sell`; `video`: `tp`, `stop`, `both`, `time`, `skipped`, `winRate` (`tp / (tp + stop)`),
    `perTrade` (the mean of `pips` over `tp`, `stop` and `time`), `avgWin` (over `tp`), `avgLoss` (over `stop`),
    `timeMean` (over `time`), `barsMedian` (over `tp`, `stop`, `time`); `owner`: `filled`, `unfilled`, `tp`,
    `held`, `sameBar`, `winRate` (`tp / filled`), `perTrade` (over the filled, `held` at the last close),
    `heldSum`, `heldWorst`, `maeMedian`, `maeP90`, `maeMax` (over the filled), `tpBarsMedian`, `tpBarsMax` (over
    `tp`), `heldBarsMax` (over `held`).
  Means and sums in row order (a sum of nothing 0, a mean of nothing null); a `q`-quantile is the sorted values'
  `[max(0, ceil(q * n) - 1)]` (`barsMedian`, `maeMedian`, `tpBarsMedian`: `q = 0.5`; `maeP90`: `0.9`); nothing:
  null.

A second implementation (research/analog-check.py, with research/analog-rule.py written from this file alone)
builds the bars from the same files with its own code, forecasts with its own code, follows each flip with its
own code, and must find the same rows (every column; numbers equal as doubles) and the same numbers (equal, or
within 1e-9 relative for means).
