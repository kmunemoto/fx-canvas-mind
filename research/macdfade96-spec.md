# The MACD fade at 96%: one email the moment the line touches 96%, take profit 10 pips, no stop

Status: a production spec, written 2026-11-17 on branch `claude/app-confirmation-jvmk03` (fab0f7e). Nothing in it is
built yet. Production still runs v9 (signal-alerts v39).

**Paths.** Every path in this file is under the repository root `/home/user/fx-canvas-mind/`. Code is cited as
`path:line`. "main" is origin/main. Where this branch and main differ, a line number is this branch's unless "main:"
is written. `index.ts` means `supabase/functions/signal-alerts/index.ts`, `indicators.ts` and `stocks.ts` the files
beside it, and `macd-ride.ts` means `supabase/functions/_shared/macd-ride.ts`.

**What this file replaces.** For production, it replaces research/macdride-spec.md (v9) and
research/macdride10-spec.md (v10, abandoned). Those two files stay as they are, as the records of their forms. Where
this file says "as v9" or "as v10", it means the section of that file named.

**The study it must equal.** research/macd90m-spec.md, section "The 96% touch, one email, take profit 10 (the owner,
2026-11-17)", with its subsection "The same trade with no signal". It is built in research/macd90m.ts
(`touchEntriesOf` :375-402, `tpSideOf` :405, `tpTradeOf` :410-448) and, written apart, in research/macd90m-check.py
(`touch_pair` :611).

**The new form, in short.**
- Five pairs and gold: one email the moment (the minute's check) the MACD line touches 96% of the edge of the 120-bar
  MACD pane. The line is worked out with the forming 1-hour bar's high so far (top) or low so far (bottom) as its
  close. The side must be one where the bar before did not close at 96% (its line at its close; it may have touched
  96% during the bar, and then two bars in a row can each send an email on the same side).
- Fade: a top touch is a SELL. A bottom touch is a BUY. This is the opposite of v9.
- The email states the price in and a target 10 pips away (the take profit). It states no stop.
- At most one email a bar and chart. No skip: a new email goes out even while earlier trades of the same chart and
  side may still be open.
- No second email and no notice.
- Shares: the same 96%, judged at 1-hour closes. Their side is a question for the owner (section 9, Q4; default: fade),
  and so is their take profit (Q1). Whether gold and the shares get the email before they are measured is Q3a / Q3b.

## 1. What the owner asked, and what was measured

### 1.1 The owner's words

On 2026-11-17, after the two-email v10 had been built but not released (research/macd90m-spec.md:157-163):
1. 「やっぱりメールを93%に到達したらすぐ送るに変えて」.
2. Asked which email: 「1通だけ、93%で」. Asked about the shares: 「株も93%に合わせる」.
3. Then: 「やっぱり96%をメールの合図にして」.
4. Measured as 「利確10・損切りなし」. Asked which side the one email is: 「両方を測って決める」.
5. After seeing the numbers of both sides: 「逆張りで作る」.

Earlier standing words that shape this form (CLAUDE.md):
- 2026-10-10: 「私は損切りをしません。なぜなら、どうせ今損をしていても必ず戻ってくると知っているからです。」
  This is recorded as the owner's view, not as a measured fact. No mail, note or screen text of this form says that a
  price will come back (section 6.1 gives the test).
- 2026-10-19: funds are unlimited. So every touch is taken, any number of trades may be open, and no account, margin or
  loss-cut number appears in mails, notes or reports.
- A win rate is never written alone. It goes with the result a trade, the open trades and their loss, the largest loss
  on the way, and the holding time.

So:
- v10 (email 1 at the 90% touch, email 2 at 95%) is abandoned. Its shared code on this branch must not ship as it is
  (section 4.4).
- v9 (email 1 at a 1-hour close in the 90% band, with the flow; email 2 at 96%) stays live until this form is released
  (section 7).

### 1.2 What was measured

**Source.** GitHub Actions runs of .github/workflows/macd90m.yml: 43999915487 (head 261504a: flow and fade) and
44011121510 (head fab0f7e: the same touch trades, sha256 of rows-tp.csv unchanged, plus the baseline). Both had the
synthetic and the real job succeed, and research/macd90m-check.py printed "PYTHON AGREES" (the baseline recomputed by
the Python too). The numbers were read from the runs' printed summaries by the task's runner (scratchpad notes
real-43999915487.md and real-44011121510-base.md) and filled in here after the spec was written; the spec's writer
did not read the runs' files. The per-trade rows were not downloaded (the logs' zip met a proxy 403), so nothing that
needs them was computed. docs/OPERATIONS.md has no section for these runs yet (§8.155 is planned).

**Basis.** Five pairs (USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD). Entry bars closing in [2024-01-01,
2026-11-10T21:00Z). GMO 1-minute bid and ask. After the spread. The study's reading: each minute read once, after it
ends. Open trades valued at the last minute loaded.

| | fade (this form: top SELL, bottom BUY) | flow (the other side) | no signal (the baseline) |
|---|---|---|---|
| trades | 2,471 | 2,471 (the same entries) | 176,402 (each hour's first minute, a BUY and a SELL) |
| reached the target (tp) | 2,430 (98.34%) | 2,439 (98.70%) | 174,301 (98.81%) |
| still open at the end | 41 (1.66%) | 32 (1.30%) | 2,101 (1.19%) |
| open trades' unrealised pips: sum / mean an open trade / worst | −16,987.9 / −414.3 / −1,387.3 | −29,440.9 / −920.0 / −2,295.0 | −1,180,922.5 / −562.1 / −2,241.5 |
| mean a trade (open ones at their unrealised value) | +2.96 pips | −2.04 pips | +3.19 pips |
| largest loss on the way (mae): median / P90 / max | 12.1 / 110.0 / 1,973.6 | 13.7 / 103.2 / 3,310.6 | 13.2 / 106.2 / 3,271.7 |
| minutes to the target: median | 142 | 157 | 218 |
| reached within 1 hour / 1 day / 1 week (share of all trades) | 34.8 / 80.1 / 92.1% | 33.9 / 77.3 / 91.8% | 25.8 / 77.7 / 91.8% |
| how much the worst single trade moves the mean | 0.56 pips | 0.93 pips | 0.013 pips |

Fade, further (run 43999915487's printout):
- Pips a trade: median +10. Sum +7,312.1.
- Minutes to the target: P90 4,751, max 687,104 (about 477 days).
- Longest hold of a trade still open: 888,959 minutes (about 617 days). The worst against an open trade on the way:
  1,973.6 pips. Largest loss on the way of a trade that did reach the target: 1,951.2 pips.
- By side: BUY (bottom) 1,213 trades, 1,196 tp, 17 open (−6,402.7, worst −720.5), mean +4.58. SELL (top) 1,258 trades,
  1,234 tp, 24 open (−10,585.2, worst −1,387.3), mean +1.39.
- Entries by pair (the same for both directions): USD/JPY 436, EUR/JPY 528, AUD/JPY 486, EUR/USD 509, AUD/USD 512.
- Entries not filled: none, by construction. The entry is at the minute's close, not a limit order
  (research/macd90m-spec.md:181-182).

Mean a trade by pair, pips (fade / flow / baseline), with the fade's open trades:

| pair | fade | flow | baseline | fade's open trades (unrealised) |
|---|---|---|---|---|
| USD/JPY | +7.49 | +7.49 | +5.73 | 2 (−1,074.0) |
| EUR/JPY | +5.17 | −12.54 | +3.25 | 5 (−2,499.8) |
| AUD/JPY | +1.85 | −20.26 | −0.79 | 6 (−3,898.7, worst −1,387.3) |
| EUR/USD | −0.83 | +9.50 | +2.56 | 11 (−5,401.5) |
| AUD/USD | +1.63 | +6.46 | +5.18 | 17 (−4,113.9) |

Baseline: 17,631 or 17,654 entry hours a pair (two trades each). Mean by side: BUY +5.67, SELL +0.70.

Still not read (no per-trade rows): whether any difference between the three is beyond chance; the baseline's P90 of
the minutes to the target and its longest hold.

This writer's arithmetic on the given numbers (not a measurement):
- 2,430 / 2,471 = 98.3% reached the target.
- The tp trades made 2,430 × 10 = +24,300 pips. The open trades hold −16,987.9. The sum is +7,312.1, and +7,312.1 /
  2,471 = +2.96, as given.
- So 41 open trades (1.7%) hold losses of about 70% of what the 2,430 tp trades made. The mean rests on them.

**Caveats. Each one travels with the numbers, in every mail, note and report.**
1. The share that reached the target is high only because there is no stop. A trade is held to the last minute loaded.
   The flow side and the baseline reach it about as often. It does not show that the signal works. It is never called
   a win rate on its own.
2. The fade's mean (+2.96) is a little below the baseline's (+3.19): entering both sides at every hour's first
   minute, with the same holding. Whether the difference is beyond chance was not measured. The signal has not been
   shown to beat entering at any hour.
3. EUR/USD's mean is below zero.
4. The open trades are valued at the last minute loaded (2026-11-10). They were not followed further.
5. Gold and the shares were not measured with this form (research/macd90m-spec.md:239).
6. The function's own reading was not measured (section 2.4; R2 in section 8). Even R2 does not model the price at
   the check (section 2.4).

Section 6.5 says how each one is carried in the mails.

## 2. The rule of the five pairs and gold

### 2.1 Terms

As research/macdride-spec.md section 1 and research/macd90m-spec.md ("The line while bar j forms"): the chart's closed
1-hour bars and their closes as the chart draws them, `LEVEL_WINDOW = 600`, `ZONE_BARS = 120`, a zone `{ m, top,
bottom }`, "at share `s`" (`atShare`, macd-ride.ts:157-158), `Z(i)`, `Zp(i)`, the state of a bar, and the line with a
price `x` in the forming slot (`rideLineAt`, macd-ride.ts:342-355; the study's `liveZone`, research/macd90m.ts:120-133,
the same expressions in the same order). With:
- `FADE_SHARE = 0.96` (the double 96 / 100). `FADE_TP_PIPS = 10`.
- `Zp(j)` = `zoneAt(macd(the 599 closed closes before j), 598)` (`rideZpOf`, macd-ride.ts:294-298). It is the study's
  `zp[j]`. It cannot be worked out from the state's five numbers (its pane is 479..598, the state's 480..598), so it is
  kept beside them (section 5.1).
- `hi` and `lo`: bar `j`'s highest high and lowest low so far while it forms (section 2.4 says how each feed gives them);
  at its close, its final high and low.
- **Touch** of share `s` on a side: the line with `x = hi` (top) or `x = lo` (bottom), from bar `j`'s state, is at `s`
  on that side (`rideTouchAt`, macd-ride.ts:370-374).

**Why the extremes so far are enough.** "At `s`" can only switch on as `x` moves toward its side, for any `s <= 1`
(macd-ride.ts:63-67; research/macdride10-spec.md:50-55). So a touch made by the extreme so far stays made for the rest of
the bar. The first read that touches sees the moment that touched (one feed). The bar's final extreme touches if and
only if some moment of the bar did.

### 2.2 The bar's one decision

A bar `j` of a chart has **at most one decision**: the first read of bar `j` that has a **hit**. That read is either a
minute's check while bar `j` forms (section 5.4), or, for a touch the checks did not see, the read of its close (the
**tail**, section 5.3).

- **Hit.** For the top side, then the bottom side:
  - the side is **open** when `Zp(j)` is not at 0.96 on it (the study: `!atShare(zp, zs, TOUCH)`,
    research/macd90m.ts:383). `Zp(j)` is the line at bar `j − 1`'s close. So a bar before that touched 96% during the
    bar (and may have had its own decision on that side) but closed inside 96% leaves the side open in bar `j`. Two
    bars in a row can then each have a decision on the same side. The study does the same;
  - the side is **hit** when it is open and the touch at 0.96 holds on it.
  - The first side hit decides. So when one read finds both, the top decides, as the study reads a minute touching both
    (research/macd90m.ts:386-395).
- **The trade side `D` (fade):** top → SELL, bottom → BUY (`tpSideOf("fade", …)`, research/macd90m.ts:405).
- **Every decision is an email.** There is no step. No skip while a trade of the side is open, no notice, no "already"
  (the study: research/macd90m-spec.md:180-182). Several trades of one chart and side can be open at once.
- **The decision stands.** No later read of bar `j` makes another, on either side, whatever it reads. A bar whose bottom
  was decided (a BUY) and whose top touches later gets no SELL.
- A bar with no hit by its close, tail included, has no decision.

### 2.3 The price, the target, no stop

**The price in** (`price`), from the read that decided:
- A pair, a minute's decision: the newest ask for a BUY, the newest bid for a SELL, of GMO's forming 1-hour bar at that
  read (`ridePaidAt(side, f.quote)`, indicators.ts:735, on `rideFormingOf`'s quote, indicators.ts:743-755). This is the
  study's side (research/macd90m.ts:413), at the moment GMO's answer came (`read_at`, section 2.4), not at the touching
  minute's close.
- A pair, a tail: bar `j`'s ask close (BUY) or bid close (SELL), from GMO's closed bar as given.
- Gold: one price, Swissquote's mid (section 2.6). A minute's decision: the newest recorded minute's close. A tail: the
  close of bar `j`'s last recorded minute.
- `mid`, for the record: the newest mid (the forming bar's mid close so far, rounded as the chart draws it; at a tail the
  closed bar's mid close). Gold: the same price.

**The target** (`target`):
- A pair: with `P(v) = round(v · 10^d)`, d = 3 on a yen pair and 5 on the others, the target is
  `(P(price) + 100) / 10^d` for a BUY and `(P(price) − 100) / 10^d` for a SELL. 100 points = 10 pips. This is the
  study's rule (research/macd90m.ts:414-416).
- Gold: `price ± U`, with `U` the owner's answer to Q2 (section 9). The recommended default is $1.00, which is the same
  rule at gold's 2 decimals (100 points of $0.01).
- It is written with the price's decimals.

**No stop.** The `signal_alerts` row's `stop` is null. The email says that no stop price is given. It says this is how
the rule is built, and that it is not advice to hold without a stop.

**No second email.** Nothing is sent when the target is reached or not reached. The function does not follow the
target (section 5.2).

### 2.4 How the function's read maps onto the study's minute

**The study** (research/macd90m-spec.md:14-17, 34-37, 166-179): each minute is read once, after it ends, from its own
1-minute bar. `hi = round((bid high + ask high) / 2, d)` and `lo` likewise, of that minute alone. The entry is that
minute's ask close (BUY) or bid close (SELL). `T0` is the minute's end.

**The function (pairs).** pg_cron starts the indicators run every minute. The run waits until at least 1 second into
the minute (`startWaitMs`, `FAST_START_MS`, indicators.ts:1294-1299). It judges the closes and the sharp rise first,
and only then the minute's path (index.ts:1603-1691). So a read happens some seconds into minute `M`. How many seconds
was not measured. It reads GMO's forming 1-hour bar (`formingQuotes`, index.ts:1393-1401; `rideFormingOf`,
indicators.ts:743-755):
- `hi = round((highest bid so far + highest ask so far) / 2, d)`, and `lo` likewise, over the hour so far. This holds
  the full minutes before `M` and the part of minute `M` before GMO's answer.
- The price is the newest bid or ask in that answer.

| | the study | the function | effect |
|---|---|---|---|
| when a touch is decided | after the touching minute ends (`T0`) | at the next check: normally the run of the next minute, some seconds after `T0`; or the check of the touching minute itself, when the touch came in its seconds before the read | the decision is a few seconds after `T0`, or up to about a minute before it |
| `hi` / `lo` | each minute's own mid extreme | the mid of the hour's highest bid and highest ask so far (the lowest, for `lo`) | the mid of the maxima is at least the max of the mids; rounding keeps the order. So the function's `hi` is never under the study's running `hi`, and its `lo` never over. It can touch earlier, or touch where the study did not. With every check made and the state there, it never touches later |
| the price | the touching minute's ask / bid close | the newest ask / bid in GMO's answer to the read. The run's clock `nowMs` is taken after the start wait (index.ts:829-831). The forming read is made later, after the closes and the sharp rise, and may start until the run's 90 s budget ends (index.ts:368). So the answer comes some seconds, up to about a minute and a half, after `nowMs`; how long was not measured. In a run at minute 59 it can come after the bar's end. `rideFormingOf` still takes the bar as forming, because it splits the bars at `nowMs` (indicators.ts:743-749). The price is then the bar's final ask / bid close | differs by the price's move in between; not measured. The moment row keeps both times: `decided_at` = `nowMs` (inside the bar, for the morning check) and `read_at` = when the answer came. The mail names `read_at` as the time of its price |
| both sides in one read | within one minute: the top | the top, also when missed checks hold a bottom touch and then a top touch | the study takes the first in time; the function may take the top |
| a missed check (no run, a failed read, past the 90 s budget or in maintenance, index.ts:368, 1654-1655) | — | decided by the next check that has the state, at its price (the extremes so far still hold the touch) | later, at a later price |
| a touch after the hour's last check (hh:59) | entered in minute 59 at its close | the tail at the close: the closed bar's final extremes; the price is the bar's ask / bid close | the email comes after the close (pairs: minute 0, 3 or 5). For a touch in minute 59 the bar's close should be the study's own entry price; that GMO's hour close equals its last minute's close is expected, not checked |
| the week | every minute with data | no read in the weekend gate, Friday 21:00 to Sunday 22:00 UTC (`isPossiblyClosed`, supabase/functions/_shared/market-hours.ts:35-43) | section 2.5 |

R2 (section 8) measures the `hi` / `lo` reading, the function's week and the tail. It does not model: the seconds
between a minute's end and the read, the seconds until GMO's answer comes, missed runs, the minutes before a close is
judged, GMO's forming bar against its own minutes, or the price at the read. For the 90% touch of v10, the replay found
R2 differing from R1 in 64 of 2,550 bars (scratchpad notes of run 43815122929, not verified by this writer). For the
96% fade nothing is measured.

### 2.5 Unwatched moments

- **A minute with no check, or a failed read:** a touch there is decided by the next check that has the state, at that
  check's price. If none comes before the bar ends, the tail decides it at the close.
- **The minutes of an hour before its state is written.** Pairs: the close is judged at minute 0, 3 or 5
  (`gmoIntervalsDue`, indicators.ts:1223-1230). Gold: from a minute after the hour, later on a Twelve Data retry
  (indicators.ts:1305-1311). Decided by the first check after the state is written, at its price.
- **The week's first hour** (the bar opened Sunday 22:00 UTC): Friday's last close is not judged, so it has no state.
  No minute decision. The tail decides it at its close, with the state worked out from the closes in hand.
- **The bar that closes at Friday 21:00 UTC:** a touch after its last check is never read (its close is in the weekend
  gate: no tail). In winter, Friday 21:00–22:00 UTC is not watched at all (no run, no state, no close judged).
- **A state written before this form** (no `Zp`): no minute decision in that hour. The tail at the next close works the
  state out from the closes in hand (section 7: the release hour).
- **A bar judged more than 30 minutes after its close** (GMO late, Twelve Data late): no tail. A touch there is lost.
- **A chart nobody follows under `macdx` in that run:** it is not read (as v9, index.ts:971-972), and no state is
  written at its close (the close's ride work runs only for a followed chart, index.ts:1165-1168). Its touches make no
  decision. A new follower of a chart nobody followed gets no minute decision in the hour they subscribe: that hour has
  no state. The tail at that hour's close decides the hour (its state worked out from the closes in hand). That tail
  can mail a touch made before the subscription; the mail names its own times. Minute decisions start from the next
  hour, whose state that close writes.

The study enters at every one of these touches. So R2 counts them (section 8).

### 2.6 Gold

Mechanically gold is decided as the pairs are. v9 already reads gold's hour each minute for email 2 (index.ts:1651-1666).
The differences:
- **Two feeds.** The state and `Zp` come from Twelve Data's 599 closed closes. `hi` and `lo` come from Swissquote's mid,
  recorded each minute in `public.gold_tick_bars` (`goldHourExtremes`, indicators.ts:763-779). The gap between the two
  feeds was never measured (docs/OPERATIONS.md:9230).
- **Sampled minutes.** A recorded minute's high and low are the highest and lowest of mids read about every 3 seconds
  (supabase/functions/signal-alerts/gold-minutes.ts:34-36). A wick tip may be missed. Not measured
  (docs/OPERATIONS.md:9207).
- **Mid only.** No bid or ask is stored (supabase/migrations/20260928080000_gold_tick_bars.sql:16-26; index.ts:2064).
  So gold's price in is a mid, with no spread. The study's entry needs bid and ask; gold cannot give them. This form
  uses the mid, as v9 does (indicators.ts:731-736).
- **The state comes late.** Gold's close is judged from a minute after the hour (indicators.ts:1305-1311). A touch in
  those first minutes is decided late, at a later price.
- **The tail** reads bar `j`'s recorded minutes `[open(j), open(j) + 1 hour)`. The run's own gold read covers the hour
  before only while it closed at most 10 minutes ago (index.ts:954-955), so the tail makes its own small read when
  needed.
- **The target unit** is the owner's question (Q2).
- **Not measured** with this form. Whether gold gets the email before it is measured is Q3a. Under the default, every
  mail and note says 「金では測っていません」 before the pairs' numbers.

## 3. The shares

**The rule** (pending the owner's Q1, Q3b and Q4; the defaults are written here):
- At a share's closed 1-hour bar `n`, on the 600 closed closes ending at `n`: an entry on side `S` when `Z(n)` is at
  0.96 on `S` and `Zp(n)` is not. Both sides cannot hold at one close: the top needs `m > 0`, the bottom `m < 0`
  (macd-ride.ts:218-219).
- The trade side: the owner has not said it for shares. The owner's words on shares were 「株も93%に合わせる」 (the
  level). Default (Q4): fade, as the pairs: top → SELL (a short sale, stocks.ts:18-19), bottom → BUY.
- This is v8's share rule (`_shared/macd-level.ts:55-73`) with 0.96 in place of 0.95 (`ZONE_SHARE`,
  macd-level.ts:113-115). It is judged at closes. So a bar whose high touched 96% but closed under it is no entry, unlike
  the pairs' minute touch. A bar that closes at 96% also touched at its extreme (section 2.1). This is argued from the
  code, not measured.
- The price in: the bar's close (Yahoo's last trade, one price, no bid or ask; index.ts:1897-1904).
- The target: the owner's answer to Q1. The default is none: the email states no take-profit level, and `target` is
  null.
- No stop. One email a bar and share. No skip, no email 2, no notice, no `macd_rides` row, no state row. One moment
  row a decided bar (below).

**When.** As v9: a share is read from Yahoo only in the 30 minutes after a close (`STOCK_POLL_MS`, stocks.ts:124;
`stockCloseDue`, stocks.ts:130-139), at most once a minute (index.ts:1933-1937). An entry is mailed while its bar ended
at most 45 minutes ago (`STOCK_FRESH_MS`, stocks.ts:126).

**The first decision stands: a claim a bar.** A read of `signal_alerts` alone would not be a claim. Two stock runs on
different instances can overlap: the guard is per instance (`stockSweepRunning`, index.ts:476-479), and each share's
Yahoo read may take up to 10 s (index.ts:1938-1941), so a run over 22 shares can outlast its minute. Both could find
no row, read different Yahoo closes, and mail different prices to different followers. So a share's decision is
claimed as the pairs' is (section 5.5), in `macd_fade_moments`:
- Each read of bar `n` first reads its moment row (`pair` = the share, `bar_time = open(n)`). If it is there, it is the
  decision, whatever this read of Yahoo shows. Unread: nothing for this share in this run; the bar is not held judged.
- None there and a hit on this read: insert the bar's moment row (`pair` = the share's symbol, `bar_time = open(n)`, `zside`, `side`,
  `source = 'close'`, `decided_at` = the bar's end, `read_at` = now, `price = mid = x` = the close, `target` per Q1
  (null under the default), `m`, `top`, `bottom`, `share0` of `Z(n)`), duplicates ignored, then read the row back.
  This is v9's insert-ignore-then-read (`openRide`, index.ts:716-736) on the new table.
- The row read is the decision. Every mail of the bar is written from it: its side, price and target. A later read in
  which Yahoo revised the close, or no longer shows the touch, changes nothing that is mailed.
- No row back and none readable: nothing is mailed in this run, and the bar is not held judged.

**Mails left over, and when a bar is held judged.** As v9 (index.ts:1931, 1976-1982): a share's bar is held judged,
and its close done, only when the moment row was read and no follower was left for a reason a later run may not meet
(a lookup that failed, index.ts:640-643: no row is claimed then). Until then the next run in the share's 30-minute
window reads it again and mails, from the row, each follower with no row yet. After that window nothing is read, so
such a follower gets no mail (as v9).

**A session's last bar.** New York 15:30 and Tokyo 15:00, and Tokyo's 11:00 bar before lunch, cannot be traded at their
close until the market opens again (`stockBarBreak`, stocks.ts:292-297). They are mailed as today, and the mail says so.

**Not measured.** The nearest measured rule is docs §8.133 (v8's fade at 95%, judged at closes, 22 shares, a limit from
the next bar, take profit in percent, no stop). It is a different rule, so its numbers are not quoted for this form.
Whether the shares get the email before they are measured is Q3b. Under the default, mails and notes say
「株では測っていません」 with no numbers.

## 4. Ids, versions and code

### 4.1 FUNCTION_VERSION

`FUNCTION_VERSION` goes from v39 (index.ts:364) to `"signal-alerts-v40-<the deploy's date>"`. The header's version
notes (v39's is index.ts:335-363) gain v40. Seven test files pin "signal-alerts-v39" (a grep of src/test); each changes.

### 4.2 The rule ids

| | rule id | built from |
|---|---|---|
| pairs and gold | `macdx_12_26_9_w600_1h_fade96tp10of120_in_v11` | `fadeRuleId("macdx", FADE_TAG, 11)` |
| shares (default: no target) | `stockmacd_12_26_9_w600_1h_fade96of120_in_v4` | `fadeRuleId("stockmacd", FADE_STOCK_TAG, 4)` |

- Built from the constants (`MACD_DEFAULTS`, `LEVEL_WINDOW`, `ZONE_BARS`, `FADE_PCT = 96`, `FADE_TP_PIPS = 10`), never
  typed twice. `indicatorRuleId("macdx")` and `("stockmacd")` give them.
- If the owner sets a share target (Q1), its tag names it with a `tp…` part. The tag is fixed with the answer.
- The `_in_` part is kept, so "which mail" sits where it sits in the v9 ids. There is one mail.
- **Why v11 and v4, not v10 and v3.** "v10" and "v3" already name the abandoned two-email ids in merged files:
  research/macdride10-spec.md, the comment at src/lib/signalAlerts.ts:39-46, and src/test/signal-alert-settings.test.tsx
  :736-771. One id must not name two rules.
- **Why this shape.** The id must start with `macdx` / `stockmacd`, so the app keeps it on its tab (`ruleOfId`,
  src/lib/signalAlerts.ts:33-37) and the subscription keys stay. It must **not** match the app's `RIDE_ID`
  (src/lib/signalAlerts.ts:48), or today's screen reads it as a two-email flow ride. It must differ from every v9 and v10
  id, so a new row never meets a v9 row under the claim key (supabase/migrations/20260925180000_signal_alert_rules.sql:32).
- **Subscriptions do not change.** Pairs and gold stay `rule = 'macdx'`, interval `1h`, on `MACDH_PAIRS` (the five pairs
  and gold, indicators.ts:286-293). Shares stay `rule = 'stockmacd'`. No subscription migration. The econ digest keeps its
  recipients (supabase/functions/econ-calendar/mailer.ts:90). Which subscriptions exist in production was not read.

### 4.3 The app's reading of the ids

The app must learn the new id **before** the function writes the first new row (section 7). Today's screen shows an id
that does not match `RIDE_ID` as an earlier rule, 「（MACD・前の決まり）」, in side colour
(src/components/SignalAlertSettings.tsx:125-126).
- Add a second parse beside `RIDE_ID`: `FADE_ID = /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/`. It fills
  a new `AlertRow` field, `fade: { touchPct: number } | null`.
- `rowLabel` (src/components/SignalAlertSettings.tsx:110-127) gains a fade branch: the side in side colour (it is an
  entry), with the new form's own tag (section 6.6), chosen from the id.
- A new plan line for fade rows, from `entry` and `target` (`stop` is null, so today's plan line never shows,
  :411-413). Section 6.6 gives the text.
- `RIDE_ID` stays as it is. So every v9 row still reads 「96%に届いた（買いの分）」 and 「知らせ（もう96%）」, and v8 and
  older rows still read 「前の決まり」. `RIDE_ID`'s `touch` branch reads only the abandoned v10 ids; removing it is a
  choice, not a need.

### 4.4 The shelved v10 code on this branch

This branch holds v10's shared code (commit 905d17e, restored by 9e0c56e). **It must not ship as it is.** index.ts is
v9's, but the shared code has `RIDE_OUT_PCT = 95` (macd-ride.ts:98) and the v10 ids (indicators.ts:169-178,
stocks.ts:69-72). Deployed now, it would run v9's logic at 95% under v10's ids. The commit message says some alert
tests fail on it; this writer did not run them.

**A merge alone ships it.** Any push to main that touches `supabase/functions/**` deploys the functions at once
(.github/workflows/deploy-functions.yml:22-25; its default list includes signal-alerts and live-chart, :76). No
workflow runs the tests on a pull request (only chartbest.yml has a `pull_request` trigger, and no workflow runs
vitest). CLAUDE.md has PRs merged without asking. So a PR from this branch as it stands would deploy the mixed state.
For PR #278 the code was taken out by hand (d658ea6) and put back after the merge (9e0c56e). The rule:
- Every PR before the function's PR (this spec itself, the study's files, step 1's app PR in section 7) is cut from
  origin/main, or carries no change under `supabase/functions/**`. It also carries neither src/test/macd-ride-v10.test.ts
  nor research/macdride-replay.ts as they stand here: both import the shelved code.
- Before each such merge: `git diff --stat origin/main...<head> -- supabase/functions` is empty.
- Only the function's PR (section 7, step 3) changes `supabase/functions/**`, with the shelved code replaced as below.

**Kept unchanged** (pure, no clock, no I/O): `atShare` and `shareOf` (macd-ride.ts:157-162), `zoneOf` (:175-178),
`newestOf`, `isNum`, `rideStateOf` and `rideStateFrom`, `rideZpOf` (:294-298), `rideStateZpOf` (:305-312), `rideZpFrom`
(:331-337), `rideLineAt` (:342-355), `rideTouchAt` (:370-374). In indicators.ts: `rideFormingOf` (:743-755),
`goldHourExtremes` (:763-779), `ridePaidAt` (:735), and the whole-point arithmetic of `ridePnl` (:903-907) for the target.
In index.ts, the patterns: insert-ignore-then-read-back (`openRide`, :716-736), `mailRide` (:776-799).

**Replaced:**
- `rideHit` (macd-ride.ts:404-414) by `fadeHit(state, zp, hi, lo)`: the same top-first loop, with 0.96 for both the
  `Zp` gate and the touch, no `already`, and the fade side.
- `rideEntryAt` (macd-ride.ts:223-232, fixed at 0.90, flow side) by a share close entry at 0.96 with the fade side.

**Added:** `FADE_PCT`, `FADE_SHARE`, `FADE_TP_PIPS`, `fadeSideOf(zside)`, `fadeTargetOf(decimals, side, price)` (whole
points), the tags and `fadeRuleId(prefix, tag, version)`.

**Removed** (they exist for v9's or v10's two emails): `RIDE_IN_*` / `RIDE_OUT_*`, `RIDE_TOUCH_TAG`, `RIDE_CLOSE_TAG`, the
three-mail `rideRuleId`, `RideStepEntry` and `already`, `rideCloseStep`, `rideTouch` at the out share, `rideCatchUp`,
`rideCatchUpByClose`, `RIDE_CATCHUP_*`, `RideRow` and `rideRowOf`; the v10 ids (indicators.ts:169-178, stocks.ts:69-72)
and `rideRuleIdOf` (indicators.ts:225-232); v9's paths in index.ts (section 7). The tests of removed code go with it.
src/test/macd-ride-v10.test.ts was not read by this writer; its tests of the kept functions (the touch's monotonicity on
a price grid, `rideZpOf` bit for bit) are moved into the new form's tests, the rest dropped.

**The v9 morning-check bench** imports from macd-ride.ts `rideCatchUp`, `rideCloseStep`, `rideEntryAt`, `rideTouch` and
the types `RideBar`, `RideEntry`, `RideRow`, `RideState` (scripts/morning-check/bench/sim.ts:7-21). The removals above
break it, and no workflow runs it, so nothing would say so. The v9 check still runs on the switch day and after any
rollback. So the function's PR copies v9's versions of what the bench needs, from origin/main's macd-ride.ts (96%,
not the shelved 95%), into the bench (e.g. scripts/morning-check/bench/v9-ride.ts), points sim.ts at that copy, and
adds `deno check scripts/morning-check/bench/sim.ts` to the static checks (section 8).

**The replay** (research/macdride-replay.ts) and its workflow (.github/workflows/macdride.yml) are reworked for this
form (section 8).

## 5. What the function stores and reads

### 5.1 The migration

Applied before the function goes out, read back in SQL (a connector "timeout" once applied anyway,
scripts/morning-check/README.md:89-91), and seen through the REST API (section 7, step 2). Modelled on supabase/migrations/20261112120000_macd_rides.sql: RLS on, all
revoked from `anon` and `authenticated`, all granted to `service_role`. Written and read by signal-alerts only. No user
column.

```sql
alter table public.macd_ride_state
  add column if not exists zp_m double precision,       -- Zp of the bar the state is for: the line, and the pane's
  add column if not exists zp_top double precision,     -- top and bottom (null on a row written before v40: such a
  add column if not exists zp_bottom double precision;  -- row starts no minute decision)

create table if not exists public.macd_fade_moments (
  pair text not null,
  bar_time timestamptz not null,           -- the open of the bar decided
  zside text not null check (zside in ('top', 'bottom')),
  side text not null check (side in ('BUY', 'SELL')),
  source text not null check (source in ('minute', 'close')),
  decided_at timestamptz not null,         -- a minute's: the run's clock nowMs (inside the bar); a close's: the bar's
                                           -- close (a share's: the bar's end)
  read_at timestamptz not null,            -- when the deciding read's answer came (the time the mail names)
  price double precision not null,         -- the price in (section 2.3; a share's: the close)
  mid double precision not null,           -- the mid at the decision (section 2.3)
  target double precision,                 -- the take-profit level (section 2.3); null only on a share with no
                                           -- target (Q1(a)); the code never writes null for a pair or gold
  x double precision not null,             -- the extreme read (hi on the top, lo on the bottom; a share's: the close)
  m double precision not null,             -- the line and the pane's edges at x
  top double precision not null,
  bottom double precision not null,
  share0 double precision not null,        -- the line's share at x
  created_at timestamptz not null default now(),
  primary key (pair, bar_time),
  check ((zside = 'top') = (side = 'SELL'))   -- fade (Q4(b), flow for shares, would change this check)
);
alter table public.macd_fade_moments enable row level security;
revoke all on public.macd_fade_moments from anon, authenticated;
grant all on public.macd_fade_moments to service_role;

-- each decision's mail is offered again each minute for 30 minutes (section 5.4 step 3); its read filters
-- signal_alerts by pair, interval, bar_time, side and rule with no user_id, which no index in the repository's
-- migrations serves (section 5.7)
create index if not exists signal_alerts_pair_bar_rule_idx on public.signal_alerts (pair, bar_time, rule);

notify pgrst, 'reload schema';
```

- Moment rows are never deleted. They are a few a day: the record of each decision, for the morning check and for
  counting real results later (task #68). State rows over 8 days old are deleted as today (index.ts:454, 1040-1045).
- The shares write no state row. They write a moment row for each decided bar, as their claim (section 3). Their
  `signal_alerts` rows are the record of who was mailed.
- `notify pgrst, 'reload schema'` asks PostgREST to reload its schema cache. No earlier migration in the repository uses
  it. The REST check of section 7, step 2, is what shows that the API sees the new columns.
- The index is built while the migration runs; it holds writes to `signal_alerts` until it is done (a mail's claim
  waits, it is not lost). The table's size in production was not read, so how long that takes is not known. Which
  indexes production has beyond the migrations was not read either.
- `macd_rides` stays as it is. The new form writes no row there (section 5.2).

### 5.2 Why not `macd_rides`, and why the target is not followed

**`macd_rides` cannot hold this form.** Its unique index allows one open ride a chart and side
(supabase/migrations/20261112120000_macd_rides.sql:69). The new form takes every touch. Its status allows only `open` and
`reached`, where `reached` means v9's 96% (:52). It has no version column. The email itself needs no ride row.

**The +10 target is not followed in production.**
- The owner asked for one email.
- Following each trade every minute would read all the time. With a median of 142 minutes to the target (P90 4,751
  minutes) and open trades held up to about 617 days in the study, some chart would almost always hold an open trade.
- Following at each close (from the 1-hour bid and ask bars of `hourQuotes`, index.ts:965) is exact only after the entry
  bar, and gold's Twelve Data bars have no bid or ask.
- Either way it needs a new table and more reads, for no email.
- The decision rows (price, target, side, moment) plus GMO's stored 1-hour bid and ask files let the morning check recount
  the target at hour precision (section 8). The files are deleted 60 days after they are fetched (index.ts:838).
- Q5 (section 9) asks the owner whether anything should be sent or shown at the target. The default is no.

### 5.3 At a close (inside `judge`)

Only for a chart in `MACDH_PAIRS` on `1h` with at least one `macdx` follower in this run (`rideSubs`, index.ts:971-972).
Every step in its own try / catch: a failure must never cost another rule's email, nor another chart's. Pairs are judged
at minutes 0, 3 and 5; gold from a minute after the hour while its bar is not judged (as v9, index.ts:1165-1294). `i` is
the newest closed bar.

1. **State.** The state of the bar now forming, `F = open(i) + 1 hour`, and `Zp(F)`, from the 599 newest closed closes
   (`rideStateZpOf`): upserted into `macd_ride_state` with the three new columns (as index.ts:1017-1046, which writes only
   the five numbers today). Kept in the instance's memo with `Zp`.
2. **The tail of bar `i`**, while bar `i` closed at most `freshFor("1h")` (30 minutes) ago:
   - read bar `i`'s moment row. Unread: nothing more for this chart in this run. There: nothing to do.
   - None: bar `i`'s state and `Zp(i)` from the memo, the row (with `Zp`), or else worked out from the closes in hand
     (the 599 before bar `i`). So the week's first hour and the release hour are decided here.
   - A hit (section 2.2) from bar `i`'s **final** extremes: a pair's closed bar's mid high and low as the chart draws
     them; gold's extremes of bar `i`'s recorded minutes.
   - A hit makes bar `i`'s decision: `source = 'close'`, `decided_at` = bar `i`'s close, the prices bar `i`'s (section
     2.3), `read_at` = now. Then section 5.5.
3. Nothing else at a close. No v9 close entry, no rides read, no catch-up.

A chart is held judged by an instance only when the state was stored and the tail's work finished. Otherwise the bar is
judged again, as v9 does (index.ts:1184-1186).

**A schema fault must not become a loop.** If the migration is missing, failed, or not yet seen by the REST API, every
state upsert and every moment read fails. As v9 holds it, the bar would then count as unsettled every hour: gold is
judged again each minute up to :29, each time re-reading its full stored Twelve Data row (index.ts:1205-1235, the
`live_chart_fallback ... select=bars,fetched_at` read at :1220), which the code itself calls too much to read every
minute (index.ts:1370-1373); the pairs are read again at :03 and :05 (`gmoIntervalsDue`, indicators.ts:1223-1230). And
no decision is made. So: an answer of 4xx to the state write or the moment read (a schema or permission fault, which a
retry in the same hour will not mend) holds the bar judged anyway, and the close's record says `fade.error =
"rest_<status>"`. A 5xx, a network failure or an exception leaves the bar unsettled, as v9.

### 5.4 Each minute

After this run's closes were judged and after the sharp rise (as v9, index.ts:1603-1610). `F` is the open of the hour now.
A check's moment (`decided_at`) is the run's clock `nowMs`, taken after the start wait (index.ts:829-831): it is inside
bar `F`. The price comes from a read made later, whose answer can come after bar `F` has ended (section 2.4). Its
moment is `read_at`: for a pair, the clock when the GMO answer used came back (the chart's own 1-hour read of this run,
or `formingQuotes`' own); for gold, when the read of the recorded minutes came back.

1. **Two small reads for all charts followed:**
   - `macd_fade_moments?pair=in.(…)&or=(bar_time.eq.F,read_at.gte.<now − 30 minutes>)`;
   - the state and `Zp` of `F`, for the charts whose memo lacks them (`macd_ride_state?pair=in.(…)&bar_time=eq.F`, the
     five numbers and the three new columns).
   - Either unread: nothing of the form in this run for the charts it concerns. The record says so.
2. **For each chart followed whose bar `F` has no decision:**
   - The state and `Zp(F)`. No state: `state: null`. `Zp` null (a row written before v40): `state: "nozp"`. Either way
     no decision in this run.
   - The forming bar: a pair's GMO read (`formingQuotes`, shared with the sharp rise and with the chart's own 1-hour
     read; skipped past the deadline or in maintenance, index.ts:1654-1655); gold's recorded minutes (`goldMinutes`,
     shared). None: nothing for this chart in this run.
   - A hit makes the decision: `source = 'minute'`, `decided_at = nowMs`, `read_at` as above, the price and mid from
     this read, `x`, `m`, `top`, `bottom`, `share0`, `target`. Then section 5.5.
3. **Mails left over.** For each decision of the last 30 minutes (by `read_at`), the email to each follower with no row
   for it yet (`mailRide`). This covers a follower whose address lookup failed (no row is claimed then, index.ts:640-643)
   and a run that failed between the insert and the mail. After 30 minutes the decision is not offered again (v9's
   window, `RIDE_OUT_FRESH_MS`, indicators.ts:784). The mail names its own moment and price, so it stays true when late.
   When a run's offer finds no follower left (`mailRide` returns before any lookup, index.ts:787), the instance keeps
   the decision as done and does not offer it again; a fresh instance reads once and does the same (section 5.7).

### 5.5 Keeping and acting on a decision; the `signal_alerts` row

**The claim.** Insert the moment row (`on_conflict=pair,bar_time`, duplicates ignored, `return=representation`). If
nothing comes back, read the row. The row read is **the** decision: another run or instance may have made it first.
Every mail of it is written from the row alone, so every follower gets the same numbers. No state is read again for a
mail.

**The `signal_alerts` row of the email** (the claim key unchanged: `user_id, kind, pair, interval, bar_time, side,
rule`):

| `bar_time` | `closed_at` | `side` | `entry` | `stop` | `target` | `rule` | `event_id` |
|---|---|---|---|---|---|---|---|
| the decided bar's open | a minute's: `read_at` (the time of its price, the time the mail names); a tail's: the bar's close | `D` | `price` | null | `target` | the new id | null (as v9, index.ts:661) |

The shares' row: `bar_time` the bar's open, `closed_at` the bar's end, `entry` the close, `target` per Q1 (default null),
`stop` null.

`signalRow` (indicators.ts:872-888) already writes `target: s.tps[0]` and `stop: s.sl` for a signal without ride facts. A
fade signal with `sl: null` and `tps: [target]` (or `tps: null` for a share with no target) needs no change there.

**Who.** Every follower of the chart under `macdx` (shares: `stockmacd`) at the run that mails, each once (the claim). A
follower who subscribes within the 30 minutes also gets it; the mail is in the past tense and names its moment.

### 5.6 Once only, whatever is repeated

To be shown by tests that replay runs (several a minute, instances fresh and kept) over fake tables:
- two runs reading the same touch: one decision, the same numbers in every mail, one email a follower;
- a bar whose bottom was decided, read again after the top also touched: no second decision, no SELL;
- a follower whose lookup failed: mailed by a later run within 30 minutes; not after;
- a decision inserted, the run failing before the mail: mailed by the next run;
- a touch after the hh:59 check: one decision by the tail at the close (`source = 'close'`, at the close's price), not
  doubled by the new bar's checks (they decide `F`, a different bar);
- a tail when a minute's decision exists: nothing;
- a close judged again at minute 3 or 5 on a fresh instance: the same state row, no second decision;
- a state row with no `Zp`: no minute decision; the tail decides the bar at its close;
- the same side in two bars in a row: bar `j − 1` decided on the top by a minute's touch, its close inside 96% (so the
  top is open in bar `j`), bar `j` touching again: a second decision and a second email, each with its own bar; the
  text of the second says the bar before *closed* inside 96% (section 6.3), not that it never reached it;
- a 4xx to the state write or the moment read: the bar held judged, `fade.error` recorded, gold's stored row not read
  again that hour; a 5xx: judged again, as v9;
- a minute's read whose answer comes after the bar's end: `decided_at` inside the bar, `read_at` after it, the mail
  naming `read_at`;
- shares: Yahoo read again and again in the window: one email a follower; a close revised after a moment row exists:
  the row's side, price and target stand; two stock runs on two instances overlapping on one bar with different closes:
  one moment row, every mail from it;
- shares: a follower whose lookup failed: the bar not held judged, the follower mailed by a later run in the share's
  window, from the moment row; not after the window.

### 5.7 Reads each minute, and egress

**v9 today:** a chart with no open ride costs nothing each minute (index.ts:1699).

**This form**, every minute of every watched hour until bar `F` is decided:
- **Pairs:** one GMO read of the forming 1-hour bar a pair a run (its bid and ask requests, paced as today). None is added
  when the run already read the pair's 1-hour chart for a close, or the sharp rise read it for a `spike` follower. v10's
  spec estimated up to about ten more GMO requests a minute for the five pairs (research/macdride10-spec.md:269-271).
  That is an estimate. It was not measured. These are GMO requests, not database egress.
- **Gold:** one read of the hour's `gold_tick_bars` rows a run, shared with the sharp rise. A few kilobytes (the v10
  spec's words). Not measured.
- **Database:** two small reads for all charts (moments, state). One `signal_alerts` read a minute for each decision
  still offered (up to 30 minutes, until a run finds no follower left). It is small in egress (the followers' ids), not
  necessarily in database work: it filters by `kind, pair, interval, bar_time, side, rule` with no `user_id`
  (index.ts:783-785), and the only indexes on `signal_alerts` in the repository's migrations are `(user_id, created_at)`
  (supabase/migrations/20260925120000_signal_alerts.sql:66), `(event_id)` (20260925160000_signal_events.sql:61) and the
  unique keys that lead with `user_id` (20260925120000_signal_alerts.sql:63, 20260925180000_signal_alert_rules.sql:32).
  So each read could scan the table. The migration adds an index on `(pair, bar_time, rule)` (section 5.1). v9's email 2
  and the sharp rise make the same read today (index.ts:784, 1566). The database work was not measured.
- Once bar `F` is decided, nothing more is read for that chart in that bar, except the offer of its mail for 30 minutes.

How often an hour is decided, from the given numbers (this writer's arithmetic, not a measurement): 2,471 entries over
five pairs of about 17,600 bars each (research/macd90m-spec.md:260) is about 2.8% of hours. So the minute reads go on
through almost every watched hour, on every followed chart. The closed bars are never read each minute: they are some
120 KB (gold) or 150 KB (a pair) a read, "too much to read every minute against the database's egress"
(index.ts:1370-1373). The added egress and the run's length were not measured; they are watched after the deploy.

### 5.8 The run's record

- Each minute's entries carry `fade: true` (not v9's `ride: true`, so a reader of v9's entries does not take them for
  rides): `pair`, `interval: "1h"`, `forming`, `state` (`"ok"` / `"nozp"` / null), `hi`, `lo`, `decided` (`"BUY"` /
  `"SELL"` / null), `made` (true when this run made the decision), `source`, `skipped` (`"deadline"` /
  `"maintenance"`), `signals`, `unsent`.
- Written for every chart looked at in this run: its bar not yet decided, decided now, or its mail offered.
- A close's entry gains `fade: { state, stored, tail, error }` (`tail`: the side decided at the close, or null; `error`:
  e.g. `"rest_400"` when a 4xx held the bar judged, section 5.3) in place of v9's `ride`.
- A minute's entry also carries `read_at` when it decided, and whether the read came back after the bar's end.
- `signals` tags: `macdx:SELL` / `macdx:BUY` (shares: `stockmacd:SELL` / `stockmacd:BUY`), when a row was made for the
  mail in this run or was already there. There is no `-at` or `-out` tag any more. A reader counts mails from
  `signal_alerts`, not from these tags.
- No user id, address or row id is ever written into the record or the log.

## 6. The emails and the screen

### 6.1 Rules for every text

- Japanese and English say the same facts. A test pins each variant in both languages.
- Written from the decision row alone, in the past tense, so a re-offered mail stays true.
- 「利確」 / "take-profit level" names the stated target only. It is never written as a fact that a trade will reach it.
- No stop is said to be how the rule is built, not advice. Every mail, shares' included, says so.
- Every mail says whose choices the numbers are: 96%, the take profit and no stop are the owner's; the take profit
  and no stop were the conditions the study was measured under, not results of it; the fade side was chosen by the
  owner after seeing both sides' numbers (section 1.1). v9's mail said 「この決まりは Sextant 独自のもの（数字はアプリの
  オーナーが決めたもの）」 (indicators.ts:1823); the new text keeps and extends it (section 6.3 item 10).
- No text says that a price will come back. A test runs two patterns over every mail variant, the notes, the plan
  line and the sales page texts, in both languages, and finds nothing: `/必ず戻/` (it also catches the owner's own
  「必ず戻ってくる」, 「必ず戻ります」, 「必ず戻って」) and
  `/\b(always|will|surely|certainly)\s+(come|comes|go|goes)\s+back\b|\balways\s+returns?\b/i`.
- No reached share without the open trades, their loss, the largest loss on the way, the holding time, and the baseline.
- The name of the form: 「MACD の逆張り」 / "MACD fade" in this section, the recommended default of Q7 (section 9). If the
  owner keeps 「MACD の流れ」, every text uses that.

### 6.2 Subjects

- Pairs and gold, ja: 「【Sextant】ドル/円 1時間足 売り（SELL）: 青い線が上の端の96%に触れました（MACD の逆張り）」
  (bottom: 「買い（BUY）: 青い線が下の端の96%に触れました」).
- Pairs and gold, en: "[Sextant] USD/JPY 1h SELL: the MACD line touched 96% of the top (MACD fade)".
- Shares, ja: 「【Sextant】〔name〕（〔code〕）1時間足 売り（SELL・空売り）: 青い線が上の端の96%以上で確定（株の MACD）」.
- Shares, en: "[Sextant] 〔name〕 (〔code〕) 1h SELL (short sale): the MACD line closed at 96% of the top (stock MACD)".

### 6.3 The pairs' and gold's email

A minute's decision (ja; en the same facts):
1. The bar: 「判定した足: 〔open, JST〕に始まった1時間足（作っている途中の足）」.
2. The moment: 「毎分1回の確認で、〔read_at, JST〕に読んだ値段で見つけました。確認と確認の間に触れた時は、次の確認で
   見つけます。値段は、その確認で読んだ時のものです。」 When `read_at` is at or after the bar's close (a run at minute 59
   whose read came back late, section 2.4), it adds: 「値段を読んだ時には、この足はもう終わっていました。」
3. What happened: 「青い線（MACD）を、この足のその時までの高値を終値とみなして計算すると、直近120本の MACD の枠の上の端の
   96%（0の線から測って）に触れました。一つ前の足は、確定した時（終値で計算した線）、上の端の96%に届いていませんでした
   （一つ前の足が足の途中で96%に触れていても、確定した時に96%より内側なら、この足でもう一度合図になります）。上の端に触れたので、逆張りの
   売り（SELL）の合図です。」 (bottom: 安値, 下の端, 買い（BUY）).
4. The numbers, from the row: 「MACD = 〔m〕、枠の上の端 = 〔top〕（その96% = …）」.
5. The price: a pair 「売値（〔read_at, JST〕に読んだもの）: 〔price〕」 (BUY: 買値); gold 「〔read_at, JST〕に読んだ値段
   （Swissquote の毎分の値段。売値・買値の別はなく、スプレッドを含みません）: 〔price〕」.
6. The target and no stop: 「利確の目安: 〔target〕（売値から10 pips 下）。損切りの値段はありません。これはこの決まりの作り
   で、損切りをしないことを勧めるものではありません。」 Gold: the unit of Q2 (default 「値段から1.00ドル下」).
7. One email: 「メールはこの1通だけです。利確の目安に届いても、届かなくても、知らせは送りません。同じチャート・同じ向きの前の
   合図がまだ目安に届いていなくても、次の合図は送ります。」
8. Gold only, before the numbers: 「金では測っていません。下の数字は5ペアのものです。」
9. The measured paragraph (section 6.5).
10. Whose rule: 「この決まりは Sextant 独自のもの（96%・利確10 pips・損切りなしは、アプリのオーナーが決めたものです。
    利確10 pips・損切りなしは、測った結果から選んだのではなく、その持ち方で測りました。逆張りの向きは、オーナーが両方の向き
    の数字を見て選びました）で、公開されているインジケーターではありません。」 Then, as today: the source line, the app
    link, how to stop (the tab's name), the disclaimer.

A tail says, in place of 2 and 5, only what is known: 「毎分の確認では、この触れを見つけていませんでした（この時間に確認が
なかった・値段を読めなかった・最後の確認のあとに触れた、のどれかです）。足の確定（〔close, JST〕）のあとに、確定した足の
高値（安値）で見つけました。いつ触れたかは分かりません。値段はこの足の終値の売値（買値）で、触れた時の値段とは違うことが
あります（1時間近くあとの値段のこともあります）。メールは確定のあとに送っています。今の値段とも違うことがあります。」
Gold: 「値段はこの足の最後に記録した Swissquote の値段です」. The tail's cases are section 2.5's: the week's first hour,
the release hour, an hour whose checks were missed or failed, and a touch after the hour's last check.

The English says the same: "Found at the once-a-minute check, on the price read at 〔read_at〕 UTC. A touch between
checks is found at the next check; the price is the one that check read." … "The bar before had not closed at 96% of
the top (its line at its close; it may have touched 96% during the bar)." … "Take-profit level: 〔target〕 (10 pips
below the bid). No stop price is given. That is how this rule is built; it is not advice to hold without a stop." A
tail: "The minute checks did not find this touch (no check ran, the price could not be read, or the touch came after
the last check). It was found after the bar closed (〔close〕 UTC), on the closed bar's high (low). When it touched is
not known. The price is the bar's closing bid (ask); it can differ from the price at the touch, by up to most of an
hour."

### 6.4 The shares' email

1. The bar: 「〔end, JST〕に確定した1時間足」.
2. What happened (the side per Q4; the default fade is written): 「この足の終わりで、青い線（MACD）が直近120本の MACD の
   枠の上の端の96%以上でした。一つ前の足の終わりでは、96%に届いていませんでした。上の端なので、逆張りの売り（SELL）の
   合図です。株の売りは空売りです。」.
3. The numbers, as 6.3.
4. The price: 「この足の終値: 〔close〕」.
5. The target: the owner's answer to Q1. Default: 「利確の幅は書いていません。損切りの値段もありません。これはこの決まりの
   作りで、損切りをしないことを勧めるものではありません。」.
6. One email, as 6.3 item 7.
7. A session's last bar or Tokyo's lunch bar: 「この足の終値では、次に市場が開くまで売買できません。」.
8. 「株では測っていません。」 No numbers (the pairs' do not apply).
9. Whose rule, as 6.3 item 10, with the shares' numbers (96%, no stop, and the take profit only if Q1 sets one; the
   side as Q4 sets it). Then, as today: the source line, the app link, how to stop, the disclaimer; a Tokyo share keeps
   its 15-minute sentence.

### 6.5 The measured paragraph

The constants live in one place (`FADE_MEASURED`, replacing `RIDE_MEASURED` and `rideMeasuredLine`,
indicators.ts:1626-1663). The release waits until R2 is measured.

**Where each number comes from.** The paragraph sets numbers from three readings side by side, and says which is which:
- **R2** (the function's own reading, section 8; fade and flow both followed from R2's decisions): 〔trades〕, 〔tp〕,
  〔open〕, 〔openPipsSum〕, 〔openPipsWorst〕, 〔openDays〕 (`openMinutesMax` / 1,440), 〔mean〕, 〔maeMedian〕,
  〔maeMax〕, 〔tpMinutesMedian〕, 〔flowMean〕 (R2's flow trades), 〔pairMean〕 (the mail's pair), 〔negPairs〕 (every
  pair whose R2 fade mean is below zero, each with its mean, or 「ありません」).
- **R1** (the study's reading; R1 must equal the study, section 8): 〔r1Trades〕 and 〔r1Mean〕 (by the study, 2,471 and
  +2.96).
- **The study's baseline** (it does not depend on how a touch is read, so it is not recomputed under R2): 〔baseMean〕
  (`base.all.pipsMean`, +3.19) and 〔pairBaseMean〕 (`base.<pair>.pipsMean`: USD/JPY +5.73, EUR/JPY +3.25, AUD/JPY
  −0.79, EUR/USD +2.56, AUD/USD +5.18, section 1.2; the code copies them from summary-tp.json of run 44011121510, and a
  test pins them to that file's values). 〔higher〕 says whether R2's fade mean came out above or below 〔baseMean〕.

**How section 1.2's caveats travel.** 1: the sentence on the tp share by construction, with flow and the baseline as high.
2: the three means, which is higher, and that the difference was not tested. 3: 〔negPairs〕, in every mail. 4: the
valuation date (2026-11-10, the last minute loaded) and that open trades were not followed after it. 5: section 6.3
item 8 and section 6.4 item 8. 6: the last sentence, on the check's price. CLAUDE.md's count of unfilled orders: none,
said in the paragraph.

ja outline (pairs): 「測った数字（5ペア、2024年1月〜2026年11月10日に確定した足、スプレッド込み、docs §8.155。過去の値段を、
このメールと同じ読み方（毎分の確認と、足の確定のあと）で読み直したもの）: 合図は〔trades〕回、うち〔tp〕回が利確の目安
（+10 pips）に届きました。〔open〕回は、2026年11月10日（読み込んだ最後の1分）の時点で届いていませんでした（その時の値段で
含み損益を数えました。その後は追っていません。含み損は合わせて〔openPipsSum〕 pips、いちばん大きいもので
〔openPipsWorst〕 pips、いちばん長いもので約〔openDays〕日持ったままでした）。指値ではないので、入らなかった合図は
ありません。1回あたり平均〔mean〕 pips（届いていないものは、その含み損益で数えました）。途中の含み損は中央値
〔maeMedian〕 pips、最大〔maeMax〕 pips。目安に届くまでの時間は中央値〔tpMinutesMedian〕分。損切りをしないので、目安に
届く割合は作りの上で高く出ます。同じ合図で逆向き（上で買い・下で売り）に入っても、合図なしで毎時の最初の1分に入っても、同じくらい
高く出ました。1回あたりは、逆向き〔flowMean〕 pips、合図なし〔baseMean〕 pips（合図なしは研究の数字）で、この合図より
合図なしの方が〔higher〕出ました。この差が偶然を超えるかは測っていません。この合図が、合図なしで入るより良いとは
示せていません。〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。平均がマイナスだった
ペア: 〔negPairs〕。1分ごとの足で読んだ研究では、〔r1Trades〕回・平均〔r1Mean〕 pips でした。このメールの値段は確認で
読んだ時のものですが、測った数字は、その1分の終値（確定のあとに見つけたものは足の終値）で入ったとして数えています。
その差は測っていません。」

Gold: the same paragraph after 6.3 item 8, with the pair sentence replaced by 「金の数字はありません。」 ("There are no
numbers for gold.") English says the same facts.

v9's 「半分は1分以内」 and every sentence about email 2 go.

### 6.6 The screen

Japanese src/lib/i18n/ja.ts, English src/lib/i18n/en.ts. ja and en keep the same keys and array lengths
(src/test/i18n.test.ts:36-39).
- **The new form's tag**, chosen from the id: 「（MACD の逆張り）」 / " (MACD fade)". v9 rows keep 「（MACD の流れ）」.
  If the tab's name changes (Q7), it also changes in `RULE_LABEL` and the test-mail lists
  (supabase/functions/signal-alerts/logic.ts:507-508, 519, 526), the mails' how-to-stop line (indicators.ts:1708, 1771)
  and the econ digest's footer (supabase/functions/econ-calendar/digest.ts:423, 452; pinned by
  src/test/econ-digest.test.ts:284-285), and econ-calendar is deployed by name.
- **The plan line** of a fade row: ja 「入り 〔entry〕 / 利確の目安 〔target〕（+10 pips）/ 損切りなし」, en "In 〔entry〕 /
  take-profit level 〔target〕 (+10 pips) / no stop". Gold names its unit (Q2). A share with no target: 「入り 〔entry〕 /
  利確・損切りなし」.
- **The time column** shows `closed_at`: for a minute's decision, `read_at`, the time of its price, the same time the
  mail names; for a tail, the bar's close.
- **No outcome is shown** (under Q5(a)). MACD rows have `event_id` null, so no result line (SignalAlertSettings.tsx:130-131,
  404-406). The notes say that whether a trade reached its target is not recorded or shown.
- **Texts to rewrite** (each names 90%, 96%, email 1 / email 2, the flow side, the close entry or v9's numbers):
  the card intro (ja:2090 / en:1987); `indicatorIntro.macdx` (ja:2118 / en:2013); `indicatorIntro.stockmacd` (ja:2127 /
  en:2022); `macdxNotes` (ja:2138-2153 / en:2033-2048; the zoom note and the ULTRA note stay); `stockmacdNotes`
  (ja:2192, 2194, 2195 / en:2087, 2089, 2090). The notes say: the 96% touch at the minute's check with the forming bar's
  high (low) so far; the open side, judged on the bar before's line at its close (so two bars in a row can each send
  an email on the same side, section 2.2); the fade side; the price, and that it is the price the check read; the
  target; no stop, and whose choices 96%, the take profit and no stop are (section 6.1); one email; no skip; the tail
  (and that its time of touch is not known) and the unwatched hours; gold's two feeds; the measured paragraph with its
  sources (section 6.5).
- One note says: 「メールの MACD は、その時までの高値（売りの合図は高値、買いの合図は安値）を終値とみなして計算します。チャート
  の作っている途中の足は今の値段で描くので、メールの時、チャートの青い線は96%より内側に見えることがあります。」 (en likewise).
- `rideOut`, `rideAt`, `ridePrices` (ja:2238-2243 / en:2132-2137) stay, for v9 rows.
- **The sales page FAQ** (`lp.faqs`, ja:2030-2040 / en:1927-1937). It may quote no percent
  (src/test/landing.test.tsx:51-58) and, by the page's own rule, no measured number; the FAQ test forbids
  `/801|800|429|96\s?%/` (src/test/signal-alert-settings.test.tsx:492).
  - ja:2033 / en:1930 says more reached trades ended at a loss than at a profit. That is false here: every reached trade
    ends at +10 pips. It becomes, e.g.: 「MACD の逆張り（1時間足）は、5ペアで測った数字が設定の注にあります。損切りをしない
    ので、利確の目安に届く割合は作りの上で高く出ます。届かずに大きな含み損のまま残る取引があり、合図なしで毎時入った時より
    良いとは示せていません。」 (en likewise).
  - The sentence before it (that every measured signal falls short of break-even) is checked against this form: the fade's
    mean is above zero, but so is the baseline's. It must not claim either way more than the numbers show.
  - ja:2037 / en:1934: the one email (pairs and gold) is the exception to "a few minutes after the close".
  - ja:2032 / en:1929 (「他のツールと何が違いますか？」) says the app shows whether each emailed signal reached its stop or
    its target first, and that signals are judged on closed bars only. Neither holds for this form: it decides on a
    forming bar at a minute's touch, and (under Q5(a)) whether a trade reached its target is not recorded or shown. It
    becomes, e.g.: the outcome is shown for the rules that record it, and the MACD fade's is not; signals are judged on
    closed bars, except the MACD fade, judged each minute while the bar forms; a signal mailed never vanishes or moves
    afterwards (en likewise).
- **The sales page's honest section** (`lp.honestBody`, ja:2028 / en:1925) says every signal falls short of the win rate
  needed to break even, and that the real record of the signals emailed is shown in the app. The first is checked as
  ja:2033's first sentence above. The second does not hold for this form under Q5(a): it is narrowed to the rules
  whose outcome is recorded, and says that the MACD fade's is not shown. No percent and no measured number
  (src/test/landing.test.tsx:51-58).
- **Tests to change:** the lists that forbid 「利確」 / "take profit" (src/test/macd-ride-alerts.test.ts:376, 408;
  src/test/indicator-alerts.test.tsx:1506, 2139; src/test/stockmacd-alerts.test.tsx:550, 583, 716;
  src/test/signal-alert-settings.test.tsx:417, 565, 853) allow it in the target line only. The v10 rows' test
  (signal-alert-settings.test.tsx:736-771) becomes a fade rows' test. v9 rows' tests (:672-734) and old rows' tests
  (:655-670) stay.

## 7. Cut-over from v9, and rollback

**Open v9 rides** (`macd_rides` rows with `status = 'open'`) wait for email 2 at 96%, in the flow direction. The new code
has no v9 path. An open v9 ride would never get email 2 and would stay `open` for good. How many are open now was not
read. v9's longest hold measured was about 28 days (indicators.ts:1637).

Default (Q6): **release only when no v9 ride is open and none was reached in the last 45 minutes.** Read just before the
merge: `select count(*) from public.macd_rides where status = 'open' or reached_at > now() - interval '45 minutes'` is
0 (pairs, gold and shares). Else wait. No row is changed by hand. If a ride stays open more than a day, the owner is told
and asked to choose (Q6's other options). This is v10's rule (research/macdride10-spec.md:470-475).

Had v9's reach been kept: a v9 BUY ride is reached when the line touches 96% at the top. That is the same moment this
form sends a SELL (when the top is open). Both emails would arrive in the same minute. The default avoids this.

**Timing.** Merge in minutes 31 to 50 of an hour (v9's close entries are judged by minute 30) and outside the 45 minutes
after any share close (v9's share email 2 window). So no v9 ride opens, and no v9 email 2 is offered, under the new code.
Then see in `net._http_response` that v40 answers before minute 59. If it does not, read `macd_rides` and `signal_alerts`
for any row made by v9 after the merge, and report it.

**The release hour and `live_ms`.** The release hour is the 1-hour bar the merge falls in. Its state row was written by
v39, with no `Zp`, so it makes no minute decision. Its tail at its close decides it (section 5.3). It is the first bar
whose close v40 judges, whether or not anything is decided in it (about 2.8% of hours are, section 5.7, so the first
decision can be hours later). `live_ms`, for each chart, is the open of the release hour (if v40 first answers only
after that bar's close, the open of the first bar whose close v40 judged). This is how v9's `live_ms` was defined: the
open of the first 1-hour bar v39 judged (scripts/morning-check/README.md:32). It is recorded in docs and in the
morning-check README, and the switch-day reading of `mc.pairs_v9` / `mc.gold_v9` uses the same instant (section 8).

**Followers stay.** No subscription changes (section 4.2).

**v9's code is removed, not left dormant:** `rideAtClose`'s rides read, catch-up and entry (index.ts:1010-1016,
1047-1131); `rideMinute`'s rides read, open filter and reach (index.ts:1632-1713); `stockRide` (index.ts:1841-1932);
`rideCloseSignal` and `rideOutSignal` (indicators.ts:794-864); `renderRideMail` (indicators.ts:1680-1828);
`RIDE_MEASURED` and `rideMeasuredLine` (indicators.ts:1626-1663); the share mails (stocks.ts:329-491). The state write
stays, with `Zp`. Reason: dormant code with v10's 95% constants is the mixed state of section 4.4. (This list is for
the default, Q6(a).)

**If the owner answers Q6(b)** (keep v9's email 2 for rides already open, no new v9 entries), section 7 changes so:
- Kept until no v9 ride is open: `rideMinute`'s rides read, open filter and reach (index.ts:1632-1713); the close's
  catch-up (index.ts:1047-1074, `rideCatchUp`); in `stockRide`, the shares' reach (`stockRidesReached`,
  stocks.ts:223, with `rideCatchUpByClose`) and email 2's re-offer; `rideOutSignal` (indicators.ts:832); email 2's
  part of `renderRideMail` and its measured line; `rideTouch`, `RIDE_CATCHUP_*`, and `RIDE_OUT_PCT` at main's 96 (not
  the shelved 95).
- Still removed: every v9 entry (`rideEntryAt`, `rideCloseStep`'s entry, `rideCloseSignal`, email 1, the notice), so
  no new ride opens.
- The release check above (no v9 ride open) is dropped. A v9 BUY ride reached at the top and a fade SELL can then
  arrive in the same minute; each mail says which form it is.
- The kept parts are removed by their own later PR, once `macd_rides` has no open row.
- Under Q6(c), the list above stands, and the open rides stay `open` for good (nothing reaches them).

**Order.** Every PR before step 3 (this spec, the study's files, step 1) follows section 4.4's rule: cut from
origin/main, or with no change under `supabase/functions/**`, checked with `git diff --stat origin/main...<head> --
supabase/functions` (empty) before the merge. A merge to main that touches `supabase/functions/**` deploys at once.
1. The app's reading of the new id (section 4.3), its own PR, merged and published. It adds the fade row's label and
   plan line only; no intro, note or FAQ text changes yet. Lovable reports its state (for example `pending`); it is
   reported as given, not confirmed. Until the new screen is live, a fade row would read as 「前の決まり」.
2. The migration (section 5.1), applied and read back in SQL; then seen through the REST API, since a read back in SQL
   does not show that PostgREST sees the new columns: a service-role `select` of `macd_ride_state?select=zp_m,zp_top,
   zp_bottom&limit=1` and of `macd_fade_moments?select=pair&limit=1` both answer 200. If either does not, the merge
   waits. (The function also guards against a schema fault, section 5.3.)
3. The function's PR merged, once R1 passed and `FADE_MEASURED` holds R2's numbers (section 8). The merge deploys
   signal-alerts and live-chart from source (research/macdride-spec.md:416).
4. The screen's texts (section 6.6) published.
5. econ-calendar deployed by name, only if the tab's name changed (Q7).
6. The morning Routine's prompt replaced and read back before the next 00:16 UTC run (section 8).

**Rollback.** Revert the function's merge; v39 (v9) is deployed again (the revert's PR touches `supabase/functions/**`,
so its merge deploys).
- v39 writes the state's five numbers; the `Zp` columns stay null on its rows. Harmless.
- `macd_fade_moments` stays, unused. Mails sent stay sent.
- v9's rides after a rollback depend on the answer to Q6:
  - (a): no v9 ride was open at the release and v40 opens none. So v9 starts with no ride open; its first entry comes
    at a close.
  - (b): the rides still open at the rollback are caught up by v39 at its first close. Any whose line touched 96% in
    one of the newest 100 closed bars after its entry is reached there, late, at the newest close's price, and its
    email 2 goes out at once (index.ts:1047-1074; main's macd-ride.ts `rideCatchUp`, `RIDE_CATCHUP_BARS = 100`).
  - (c): the rides open at the release stayed `open` under v40 (`status` allows only `open` or `reached`,
    supabase/migrations/20261112120000_macd_rides.sql:52). The rollback gives each the late catch-up of (b), possibly
    weeks after its entry. While one stays open, v9 sends no new email 1 on that chart and side (its own rule, and one
    open ride a chart and side, :69).
  - Under (b) or (c): before the rollback, read the open rides and tell the owner which would get a late email 2.
- The app keeps reading both ids.
- The screen's texts (step 4) describe the fade (top = SELL), while v9 mails the flow (top = BUY). So the screen-text
  PR is reverted too and the app published again. If the tab's name changed (Q7), the app's tab name and the econ
  digest's footer are reverted too, and econ-calendar is deployed again by name (it is not in the default deploy list,
  .github/workflows/deploy-functions.yml:76, so reverting the function's PR does not redeploy it). Lovable's state is
  reported as given (for example `pending`), not confirmed.
- The Routine's prompt goes back to v9's. A copy of v9's prompt is kept before it is replaced.
- A rollback restores a form the owner abandoned. It is only for a failure, and the owner is told.

## 8. Checks before release

**Unit tests** (vitest) of `_shared/macd-ride.ts`:
- `fadeHit` against the rule written again from section 2.2's sentences: random states and extremes, both sides, top
  first, the `Zp` gate at 0.96 with equality;
- the touch's monotonicity at 0.96 on a price grid, both sides;
- `rideZpOf` bit for bit against `zoneAt` at 598 of the window rebuilt;
- `fadeTargetOf` in whole points, BUY and SELL, d = 3 and 5 (gold per Q2);
- the share close entry at 0.96, fade side; both sides never at once;
- the ids: one a rule, built from the constants, matching `FADE_ID`, not matching `RIDE_ID`.

**Function tests:** section 5.6's replays over fake tables; the `signal_alerts` row; the moment row; each mail variant in
ja and en (a minute's, a minute's read that came back after the bar's end, a tail's, gold's, a share's, a session's
last bar); section 6.1's two patterns (no text says a price will come back) over every mail variant, the notes, the plan
line and the sales page texts; the run's record.

**App tests:** fade rows labelled with their tag and plan line; v9 rows as before; v8 and older as 「前の決まり」; the
landing page (no percent); i18n's equal lengths.

**The replay** (research/macdride-replay.ts reworked; GitHub Actions on the study's data, with research/macd90m.ts real at
TOUCH 0.96 and TP 10). The shared code is driven minute by minute over the five pairs as section 5 does it: the bar's
minute checks (which minutes, per reading, below); the bar's decision; at each close, the tail. Decisions only in bars
whose close is in `[START, END)` (the study's gate).

**The shipped functions decide.** Under both readings the replay takes the hit, `zside` and `side` from `fadeHit`
(with `fadeSideOf`) and the target from `fadeTargetOf`, the same functions index.ts calls, and takes the price by that
`side` (ask for a BUY, bid for a SELL). It works out none of them itself (v10's replay chose the price by its own
expression on `hit.side`, research/macdride-replay.ts:515). So R1 also tests `fadeSideOf` and `fadeTargetOf`.

**The trades, in full.** Each decision is two trades, as the study's entries are: the fade trade (`side` as decided)
and the flow trade (the same moment and price minute, the opposite side, its price by its own side, its target by
`fadeTargetOf` on its own side). Each is followed exactly as `tpTradeOf` (research/macd90m.ts:410-448). The follow is
written once, in the shared code or beside the replay; research/macd90m.ts exports nothing.
- A minute's decision at minute `k`: the price is minute `k`'s ask close (BUY) or bid close (SELL); `T0` = minute `k`'s
  end; followed from minute `k + 1`.
- A tail of bar `j`: `T0` = bar `j`'s close; the price is GMO's 1-hour ask close (BUY) or bid close (SELL) of bar `j`, as
  the chart's bars give it; followed from the first 1-minute bar at or after the close (`lowerBound(m1.t, close)`).
  (v10's replay started a tail at the next 1-hour bar's first minute, research/macdride-replay.ts:551. That skips
  minutes in no 1-hour bar, which `tpTradeOf` follows. That changes.)
- Then, for both: through the **last 1-minute bar loaded** (minutes in no 1-hour bar too); mae taken before the target
  test in the same minute; out at the target exactly; or open and valued at the **last minute's** close (the bid close
  for a BUY, the ask close for a SELL). (v10's replay valued an open ride at the last 1-hour bar,
  research/macdride-replay.ts:553-556. That changes.)
- The groups (each direction: all, each pair, BUY, SELL, top, bottom; every field of `G`) add their trades in the rows'
  order: by `T0`, then the pairs' order.

- **R1** (the study's reading: the running extremes of the 1-minute mid highs and lows; a check after **every** minute
  of the bar ends, the last minute included, as the study reads; the price of a check, the minute's ask / bid close;
  the study's week). R1's tail reads the high and low **R1 ended the hour with** (NaN where no minute was read, so an
  hour with no minute has no touch), as v10's replay did (research/macdride-replay.ts:385-387), never the chart's 1-hour
  bar: that would decide hours with missing minutes and fail R1 for a reason that is not a rule difference. Its rows
  must equal the `dir = fade` rows of rows-tp.csv, cell for cell, keyed by pair|open: every column of `HEAD_TP`
  (research/macd90m.ts:848). The groups of summary-tp.json `dirs.fade` (all, each pair, BUY, SELL, top, bottom) must
  equal, every field of G; `meta.touch` 0.96, `meta.tp` 10, `start`, `end`, `loadFrom`; and `pairs[].entries`. Sums add
  in the study's row order (research/macd90m.ts:827-831). The tail finds nothing. A pair|open on one side only (in the
  study or in the replay), or two decisions at one bar, is a difference, as v10's replay counts them
  (research/macdride-replay.ts:833-853). Any difference: the first 20 printed and the run fails. The flow rows and
  `dirs.flow` are compared the same way; they share the entries.
  Why the running extremes give the study's rows: at the first touching minute the running extreme is that minute's own
  (section 2.1). This held for v10 at 90%. At 96% it has not been run.
- **R2** (the function's reading: the mid of the running bid high and running ask high, and of the lows; a minute
  check of bar `j` only when its moment, `m1.t[k] + 1 minute`, is **before** bar `j`'s close, because the function
  makes no check of bar `j` at its close: the run at minute 0 checks the next bar (section 5.4). So a touch that only
  the bar's last minute shows is left to the tail, which reads the closed bar as the chart draws it; the function's
  week: no read in the weekend gate, no minute decision in an hour whose state no judged close wrote; the tail at the
  close at the bar's ask / bid close). Keyed by pair|bar against R1: earlier, later, other side, under one reading
  only, and R1's decisions in hours the function does not watch. Then every field of G for R2's fade trades **and for
  R2's flow trades**, with the study's baseline (`base`, all and each pair) printed beside. These are the numbers the
  mails give (section 6.5): R2's fade fields, R2's flow mean, and the study's baseline. It also prints how many of
  R2's decisions were tails, and every field of G over the tail trades alone (Q8). Not modelled: section 2.4's list.
- **Walks** (synthetic): holes in the minutes (the tail decides an hour with no check iff its final extreme touches 0.96
  on an open side; R1 decides nothing there); moved prices (R2's `hi` never under R1's, its `lo` never over); a reading
  with no minute check at all (only the tail); a touch shown only by a bar's last minute (R1 decides it at that minute,
  R2 by the tail at the close, at the 1-hour ask / bid close, followed from the first minute at or after the close); a
  tail followed through minutes that lie in no 1-hour bar.
- **Workflow** (.github/workflows/macdride.yml): drop `REACH: "0.95"` (:55, :112); set TOUCH and TP explicitly; add
  rows-tp.csv and summary-tp.json to `sha256sum` and the artifact (:120, :142-145); add research/macd90m.ts to the push
  paths. How long the baseline (about 176,000 trades) takes in this job: not measured.

**Static checks:** `npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and
econ-calendar, and `deno check scripts/morning-check/bench/sim.ts` (the v9 bench, section 4.4). Before each merge before
the function's PR: `git diff --stat origin/main...<head> -- supabase/functions` is empty (section 4.4).

**The morning check of the new form** (its own spec or README section; functions `mc.pairs_v11` / `mc.gold_v11`, named
after the rule's version; the task list calls it "morning check v10"):
- **Pairs, the recount** from the stored 1-hour BID and ASK files (`public.gmo_kline_files`, as
  scripts/morning-check/pairs-v9.sql:37-46): open sides as :190 with 0.96 in place of 0.9 (the engine's `tp`, `bp`, `mp`
  are the study's `Zp`, :129-131); the touch as `tq` (:242-255) at 0.96 with the final rounded mid extremes. A bar with
  its state written, an open side and its final extreme touching must have a decision (section 2.1). The side is the
  fade side. When both sides are open and both touch, the hour bar cannot tell which was first: the line says
  `side_not_recounted`, not `extra` or `missing`. Gates: before go-live, no subscription, the weekend gate, an hour with
  no state and no tail.
- **Against production:** `macd_fade_moments` (one row an expected bar; `x` inside the bar's final mid range and touching
  0.96 on its state; `source`; a minute's `decided_at` inside the bar and its `read_at` not before it); `signal_alerts`
  under the new id (one row a
  follower; `entry` inside the bar's ask range for a BUY or bid range for a SELL; `round(target · 10^d) = round(entry ·
  10^d) ± 100` exactly; `stop` null); the state rows (the five numbers and `Zp` against the recount). `mg0` / `us`
  (:70-93) must carry the raw bid and ask highs and lows.
- **The target, recounted at hour precision:** the first bar after the entry bar whose bid high (BUY) or ask low (SELL)
  reaches the target is the tp bar (exact at the hour). In the entry bar it is unknown when the extreme came. Open trades
  are listed with their unrealised pips at the newest stored close, their worst against over the bars after the entry
  bar, and their days held. A trade older than the 40-day load (:18, :22) is reported as not followed. A report carries
  the tp count, the open count, the open losses, the worst against and the days held; never a bare rate.
- **Gold:** as scripts/morning-check/gold-v9.sql, with its two sources; the target per Q2.
- **Shares:** moment rows against mails, with the new id (one moment row a mailed bar; every mail's side, entry and
  target equal to its row's). Their bars are not stored, so the touch is not recounted.
- **Build:** new parts, a new `MIG` name (scripts/morning-check/src/build.sh:64-73), `mkfn.py` reused, `pieces.py`'s cut
  lines redone, and a new bench (bench/sim.ts and gen.py are close-only and 1-hour-only; a fade bench needs prices inside
  the hour and a target column).
- **Production:** the DDL needs the owner's confirmation. Read it back after each send. The RUN row's md5 must equal the
  `.fn.sql` file's (scripts/morning-check/src/run-v9-fn.part:9-14).
- **The Routine** (`trig_01KQXAvMQ5n7M3evSFwbHAoQ`, docs/OPERATIONS.md:11355; its prompt is not in the repository): its
  prompt is replaced and read back before the first 00:16 UTC run after release. On the switch day it runs
  `mc.pairs_v9` / `mc.gold_v9` and reads every line of a bar opened at or after `live_ms` (the open of the release hour,
  section 7; not the first decided bar) as not v9's: an expected v9 entry there is not a missing mail (its
  `other_macdx_1h_rule_rows` will count the new mails). Until the new check is in: read-only matching only (moment rows
  against mails, subscriptions, the shares' rows with the new id), and every report says 「新しい形（96%触れ・逆張り）の
  決定は数え直していません」.

## 9. Questions for the owner

Each has a recommended default. The spec is written with the defaults; an answer changes only the parts named. Each
question can be answered on its own, except that Q2 applies only if Q3a is (a), and Q1 and Q4 only if Q3b is (a).

**Q1. The shares' take profit.** (Only if Q3b is (a).) Shares have no pips.
- (a) No target: the email states the price in and no take-profit level. **Recommended.**
- (b) A percent of the price in (the owner names it; v8 measured 0.1, 0.25, 0.5 and 1%, docs §8.133).
- (c) Ten price steps ($0.10 on a US share, ¥1.0 on a Tokyo share).
- (d) A money amount ($10 / ¥10 a share).

Why (a): pips do not apply to shares; the owner's only word on a share take profit is 「出す、利確幅はいらない、自分で
決める」 (2026-10-31, docs/OPERATIONS.md:12033); no share take profit was measured at 96%.

**Q2. What "10 pips" is on gold.** (Only if Q3a is (a).)
- (a) $1.00 an ounce. **Recommended.**
- (b) $10.00 an ounce (the app's dollar convention for gold levels, docs/OPERATIONS.md:3444).
- (c) $0.10 an ounce (the chart's cent, which its own code calls no convention, src/lib/candleTime.ts:56-58).

Why (a): it is the owner's own 1 pip = $0.10 (2026-10-11, docs/OPERATIONS.md:9206), and it is what the study's rule
(10 points a pip) gives at gold's 2 decimals. Scale measured elsewhere, not for this form: gold's median 1-hour range was
$14.3 (docs/OPERATIONS.md:4093) and its median Dukascopy spread $0.54 (docs/OPERATIONS.md:4127). The app's gold price is
a mid with no spread.

**Q3a. Gold is not measured with this form.**
- (a) Release gold with the pairs. Its mails and notes say 「金では測っていません」 and give no number of gold's. Measure
  it later as its own task. **Recommended.**
- (b) Measure gold first (on Dukascopy bid and ask minutes, research/dukascopy.py). Until then gold gets no MACD email.
- (c) Drop gold from the MACD email.

Why (a): v9 and v10 did the same with the same words; gold's followers keep an email; nothing unmeasured is claimed.

**Q3b. The shares are not measured with this form.**
- (a) Release the shares with the pairs. Their mails and notes say 「株では測っていません」 and give no number. Measure
  them later as their own task. **Recommended.**
- (b) Measure the shares first (on Yahoo 1-hour closes at 96%). Until then the shares get no MACD email.
- (c) Drop the shares from the MACD email.

Why (a): as Q3a. Q1 and Q4 apply only if this answer is (a).

**Q4. The shares' side.** (Only if Q3b is (a).)
- (a) Fade, as the pairs: top SELL (a short sale), bottom BUY. **Recommended.**
- (b) Flow, as v9's shares: top BUY, bottom SELL. (Then the moment table's fade check, section 5.1, must allow the
  shares' flow rows.)

Why (a): the owner chose 「逆張りで作る」 for the email after seeing both sides measured on the five pairs. On shares the
owner said 「株も93%に合わせる」: that was about the level (which then became 96%), not the side. The side for shares was
not said. The nearest measured share rule (v8, docs §8.133) is a fade.

**Q5. Anything when the +10 target is reached?**
- (a) Nothing. One email only. Whether a trade reached its target is not recorded or shown; the notes say so.
  **Recommended.**
- (b) No email, but the server follows each trade and the app shows "reached" or "still open" (a new table and reads
  every minute or every hour).
- (c) A second email at the target.

Why (a): the owner asked 「1通だけ」; following costs reads all the time; the morning check can recount the target at hour
precision from the decisions and the stored bars. Note: the sales page says the real record of the signals emailed is
shown in the app (ja:2028, 2032 / en:1925, 1929). Under (a) that is not true for this form, so those texts are narrowed
for it (section 6.6). Under (b) it would stay true.

**Q6. v9 at the release.**
- (a) v9 stops at the release. Release only when no v9 ride is open and none was reached in the last 45 minutes. If one
  stays open more than a day, ask again. **Recommended.**
- (b) Keep v9's email 2 (the reach at 96%) for rides already open, with no new v9 entries, until none is open. This
  keeps part of v9's code until then (section 7 names it), and a v9 email 2 and a fade SELL can arrive in the same
  minute. A rollback while rides are open sends them late email 2s (section 7).
- (c) Stop v9 at once even with rides open. Their followers get no email 2; the owner is told which rides. Those rides
  stay `open` for good, and a rollback would send them late email 2s, possibly weeks after their entry (section 7).

Why (a): it was v10's rule; the new code needs no v9 path; no follower is left waiting for an email 2 that never comes;
no v9 email 2 and new SELL arrive in the same minute; a rollback starts v9 with no ride open.

**Q7. The name.** 「MACD の流れ」 / "MACD ride" says flow; the new form fades.
- (a) 「MACD の逆張り」 / "MACD fade" for the new form; v9 rows keep 「MACD の流れ」 on the screen. **Recommended.**
- (b) Keep 「MACD の流れ」 / "MACD ride".
- (c) Another name the owner gives (with no % sign: the sales page names it).

Why (a): the name should say what the email does; a per-id tag keeps old rows true.

**Q8. A touch the minute checks did not see** (after the hour's last check, in the week's first hour, in the release
hour, in an hour whose checks were missed or failed).
- (a) One late email after the bar closes, at the bar's close price, saying it is late and that when it touched is not
  known. **Recommended.**
- (b) No email for that bar.

Why (a): for a touch in the last minute, the bar's close is the study's own entry price (expected, not checked);
otherwise the study's entries there go missing. The email names its time. But for a touch earlier in the hour (the
week's first hour, the release hour, failed checks), the late email's price can be up to an hour later than the
study's entry. R2 measures how often a tail decides, and with what result (section 8).

## 10. What this spec did not read, confirm or measure

- **How this spec was made.** It rests on four maps written for it (the function, the app, the checks, gold and shares;
  not kept in the repository) and on this writer's own reading. This writer read in full research/macdride-spec.md,
  research/macdride10-spec.md and research/macd90m-spec.md; read research/macd90m.ts:1-215 and :330-460; and opened again
  the cited lines of index.ts, indicators.ts, macd-ride.ts, src/lib/signalAlerts.ts, the `macd_rides` and
  `signal_alerts` migrations, and the docs lines on gold's pip and the shares' target. Other cited lines (the screen and
  i18n files, the tests, the morning-check SQL, stocks.ts beyond its constants, gold-minutes.ts, live-chart,
  econ-calendar) are the maps' citations; this writer did not open them again.
- **This revision** (after three reviews, 2026-11-17) opened again, and checked the reviews' citations against:
  research/macd90m.ts:360-460 and research/macd90m-spec.md:155-271; research/macdride-replay.ts:370-400, 460-560 and
  820-860; index.ts:364-370, 470-482, 630-800, 822-840, 950-1080, 1160-1240, 1365-1402, 1598-1720 and 1838-1990;
  indicators.ts:725-790, 1218-1232 and 1760-1830; live-chart/logic.ts:661-673 (`splitBars`); main's macd-ride.ts
  :60-90 and :365-410; the `macd_rides` migration :45-72; the `signal_alerts` index and unique-key lines of the
  migrations; .github/workflows/deploy-functions.yml:1-40 and :70-80; scripts/morning-check/bench/sim.ts:1-25;
  scripts/morning-check/README.md:25-40; src/lib/i18n/ja.ts:2026-2040 and en.ts:1923-1937; src/test/landing.test.tsx
  :49-60 and signal-alert-settings.test.tsx:488-494; and commits d658ea6, 9e0c56e and 905d17e. It ran no test and no
  replay.
- **Section 1.2's numbers** were filled in by the task's runner, after the reviews, from the runs' printed summaries
  (section 1.2, "Source"). The runner checked the spec's rule against research/macd90m.ts:375-448 (`touchEntriesOf`,
  `tpSideOf`, `tpTradeOf`, `touchAt` with the minute's own extreme) and opened again index.ts:364, 638-644 and
  1695-1701, macd-ride.ts:96-99, indicators.ts:743-756 and 1823, src/lib/signalAlerts.ts:46-49,
  SignalAlertSettings.tsx:123-127, the `macd_rides` migration :50-53 and :67-70, and deploy-functions.yml:20-26 and
  :74-77; each says what the spec says. Seven test files pin "signal-alerts-v39". `FADE_ID` matches both new ids and not
  v9's; `RIDE_ID` matches v9's and neither new one (run in node).
- **Not read by this writer or the maps:** the real rows-tp.csv and summary-tp.json (not on this machine);
  research/macd90m-check.py beyond its outline; src/test/macd-ride-v10.test.ts; research/macdride-replay.ts beyond the
  lines the maps cite; supabase/functions/signal-alerts/logic.ts beyond the lines naming the rule's label (the admin
  list was not opened); record.ts; the GMO request code beyond `fetchLiveQuotes` and `splitBars`.
- **Not confirmed:** run 43815122929 on GitHub (runs 43999915487 and 44011121510 were checked by the task's runner:
  success, "PYTHON AGREES"); that GMO's 1-hour close equals
  its last 1-minute close; that Twelve Data's gold price is a mid (only the docs say so); the Lovable state of the live
  screen; that production's `signal_alerts` has no index beyond the repository's migrations; that PostgREST answers 4xx
  (not 5xx) to a missing column or table (expected, not checked).
- **Not seen (production, by rule):** how many v9 rides are open; how many followers each chart has; whether `spike`
  followers exist on every chart (which decides whether the forming read is already made each minute); which
  subscriptions the owner has; the Routine's prompt.
- **Not run:** any test, the app, the replay.
- **Not measured:** the moment of a check within its minute; how long after `nowMs` the forming read's answer comes,
  and how often a minute-59 read comes back after the bar's end; the added GMO requests; the added database egress,
  database work (the `signal_alerts` reads) and run length; how long the new index takes to build; how often two bars in
  a row are decided on the same side; how often two stock runs overlap; every difference between the function's
  reading and the study's for the 96% fade (R2 will measure part of it); whether the fade's mean differs from the
  baseline's beyond chance (the per-trade rows were not downloaded); gold and the shares with this form.
