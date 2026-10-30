# EMA cross + return move (#387, docs §8.130): the rule, exactly

The owner (2026-10-30), with a screen recording of an Instagram video ("勝率60% リスクリワード1:1.2
のスキャルピング手法を一分で解説", GBPJPY 15分足, captions only): 「この機能追加して」; asked, the
owner chose the chart and the email, the email on the 15-minute chart of the five pairs and gold.

The video's steps (its captions, in order):

1. 表示するのは15分足。20EMA と 200EMA を用意し、ゴールデンクロス、またはデッドクロスを待つ。
2. クロス後にローソク足が 200EMA にタッチするのを待つ。
3. タッチ後、切り上げ・切り下げラインと水平ラインの2本のネックラインを引く。
4. 水平と斜めライン抜け確定後、水平ラインに対しリターンムーブを待ち、プライスアクションを確認して
   エントリー。ブレイクしてすぐ1、2本でリターンムーブはノーカウント。プライスアクションは、リター
   ンムーブした足を実体レベルで抜けて確定した足でエントリー。
5. 損切りは「今回の場合はここ」（the bars where the diagonal line was broken; 「本来の位置は3波の起点
   となるここなんだけど、もしこの損切を割った場合、本来の損切位置も高確率で割るので、ここにするよ」）。
6. 利確は基本的には直近高値まで。長期足の環境認識ができて、さらに伸ばせる環境なら、1波の値幅分伸ば
   してみるのも良い。

The lines in steps 3 and 5 are drawn by hand in the video. This file fixes them as numbers (marked
APP: where the video gives no number), so that the chart and the email decide with one function and a
second, independent implementation can reproduce every decision.

## Input

`w[0..n-1]`: closed bars, oldest first, each `{o, h, l, c}` (floats). The bar judged is `n-1`.

## Constants

| name | value | source |
|---|---|---|
| FAST | 20 | video (20EMA) |
| SLOW | 200 | video (200EMA) |
| WINDOW | 600 | APP: the closed bars the email judges on (the sweep's history of a 15-minute chart) |
| WARM | 400 | APP: a cross counts from window index WARM on (EMA 200 seeded at 199, two of its spans more) |
| PIV | 3 | APP: a swing high (low) is a bar higher (lower) than the 3 bars on each side |
| SKIP | 2 | video: the 1st and 2nd bars after the break do not count as a return move |

## Lines

- `ema(xs, len)` as Pine's `ta.ema` with its seed: undefined at `k < len-1`; at `len-1` the mean of
  `xs[0..len-1]` (summed left to right from 0.0, then divided by `len`); after that
  `alpha*xs[k] + (1-alpha)*prev`, `alpha = 2/(len+1)` (exactly this expression and order).
- `fast = ema(c, FAST)`, `slow = ema(c, SLOW)`.
- `cross(k)` for `k >= 1` with both lines defined at `k-1` and `k`: `+1` (golden) if
  `fast[k-1] <= slow[k-1]` and `fast[k] > slow[k]`; `-1` (dead) if `fast[k-1] >= slow[k-1]` and
  `fast[k] < slow[k]`; else `0`.
- swing high at `p` (needs `p-PIV >= 0`): `h[p] > h[j]` for every `j` in `p+1..p+PIV` and
  `h[p] >= h[j]` for every `j` in `p-PIV..p-1`. It is known at bar `p+PIV` (confirmed), not before.
  Swing low mirrored (`<`, `<=` on `l`).

## The scan

At most one setup is alive. For `k = WARM .. n-1`, in order:

1. If `cross(k) != 0`: a new setup replaces any other: `dir = cross(k)` (+1 BUY, -1 SELL),
   `x = k`, phase TOUCH, `A = h[k]` (BUY) / `l[k]` (SELL), `aAt = k`. Nothing else happens at `k`.
2. Else, with no setup or one in phase DONE, nothing happens.
3. Else by phase. BUY is written; SELL is the mirror (h <-> l, max <-> min, > <-> <, >= <-> <=,
   above <-> below; the touch is `h[k] >= slow[k]`).

**TOUCH** (waiting for the candle to reach the 200 EMA):
- if `h[k] > A`: `A = h[k]`, `aAt = k` (the earliest bar of a maximum is kept);
- then if `l[k] <= slow[k]`: phase LINES, `t = k`.

**LINES** (the two necklines, and their break):
- `B` = among the swing highs `p` with `t < p`, `p + PIV <= k` and `h[p] < A`, the one with the
  highest `h[p]` (the latest of equal highs). None: no lines yet.
- the horizontal line `H = h[B]`; the diagonal line through `(aAt, A)` and `(B, h[B])`:
  `diag(j) = A + (h[B] - A) * (j - aAt) / (B - aAt)` (descending: 切り下げライン; SELL ascending).
- if `B` exists and `c[k] > H` and `c[k] > diag(k)`: the break. If `h[k] >= A`: phase DONE (the
  target reached at the break itself, before an entry). Else phase RETEST, `K = k`, `Dk` = the
  first `j` in `B+1 .. K` with `c[j] > diag(j)` (the diagonal's break), no return move yet.
- else if `h[k] > A`: a new high above A before a break: phase TOUCH again, `A = h[k]`, `aAt = k`
  (a new touch of the 200 EMA is waited for; nothing else happens at `k`: the touch is looked for
  from `k+1`).

The swing highs that `B` is chosen from are those confirmed while the setup is in LINES or RETEST
with its current `t` (each `p` with `t < p` and `p + PIV <= k`, found at `k = p + PIV`); a return to
TOUCH forgets them. In RETEST the lines of the break (`B`, `H`, the diagonal, `Dk`) stay as they were
at `K`; on a failed break, `B` is chosen again (among all those swing highs, the ones confirmed during
RETEST included) from the next bar.

**RETEST** (the return move and the entry):
- if `h[k] >= A`: phase DONE (the target was reached before an entry).
- else if `c[k] < H`: the break failed: phase LINES (the same `A`, `aAt`, `t`; `B` is chosen again
  on the next bars).
- else if a return move `R` exists and `c[k] > max(o[R], c[R])`: **the entry at `k`**; phase DONE.
- else if `k >= K + SKIP + 1` and `l[k] <= H`: `R = k` (the latest return move).

DONE: nothing until the next cross.

The decision at the last bar: an entry at `k = n-1`. On the chart every bar is judged on the
WINDOW bars ending at it (fewer where the chart holds fewer, marked so).

## The levels (BUY; SELL mirrored)

- entry `E = c[k]`.
- stop: the lowest low of `Dk .. k` (the bars from the diagonal's break to the entry, the return
  move's among them). (Video step 5; no buffer: APP.)
- target 1: `A` (直近高値: the highest high from the cross to the touch, as last updated).
- target 2: `L2 + (h[B] - L1)`, `L1` the lowest low of `t .. B` (wave 1's start), `L2` the lowest low
  of `B .. K` (wave 3's start): 1波の値幅分. None if it is not above `E`.
- R:R `(A - E) / (E - stop)`.

## Output (for the comparison)

Every entry of a scan over the whole input (one scan, from WARM): `{bar, dir, x, t, aAt, A, B, H, K,
Dk, R, entry, stop, tp1, tp2}` (tp2 null when none). Numbers in full precision.
