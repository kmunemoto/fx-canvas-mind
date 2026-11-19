# The MACD fade on 15-minute closes: one email when the line closes at 96%, no target, no stop

**Superseded (2026-11-17) by research/macdfade1h-prod-spec.md, not to be built.** The owner then said
「やっぱりメールの判断1時間足で」; its line numbers were read on the shelved v10 files, which 9bcfd70 put back to main's. The 15-minute form is
built from research/macdfade15min-prod-spec.md (2026-11-19).

Status: a production spec, written 2026-11-17 on branch `claude/app-confirmation-jvmk03` (f681256). Nothing in it is
built. Production still runs v9 (signal-alerts v39, 1-hour bars). For production it replaces research/macdride-spec.md
(v9) and research/macdfade96-spec.md (the minute touch, never built); both stay as the records of their forms. A
1-hour draft of this same rule (scratchpad, never committed) is dropped; what fits was taken from it. Revised the same
day after a review of 16 findings, each checked against the code (section 8 says what that revision read).

**Paths.** Under the repository root. `index.ts`, `indicators.ts`, `stocks.ts`, `logic.ts` are in
`supabase/functions/signal-alerts/`; `macd-level.ts`, `macd-ride.ts`, `macd.ts`, `market-hours.ts` in
`supabase/functions/_shared/`. Line numbers are this branch's (index.ts, logic.ts and the app are the same as
origin/main's).

**The study it must equal.** research/macdfade15-spec.md (written the same day by another hand, built in
research/macdfade15.ts and .github/workflows/macdfade15.yml, checked by research/macdfade15-check.py, which agreed on
GMO's real files in Actions run 44077464383: the numbers for 4.5 are in the study spec's last sections). Its spec was
read here after this file's first draft, and sections 2, 4.5 and 7.2 were aligned with it; its code was not read by
the writer. Its rule, files and numbers govern: where it reads differently from section 2, this file is corrected before
anything is built.

## 1. What the owner asked

2026-11-17: 「もうシンプル96%の足できたら逆張りのメールちょうだい」, then 「メールを1時間足から15分足に変更」. Answers given
in the question dialog (in English here, not the owner's words):
- Only the first bar at 96% (the bar before not at 96%), not every bar while the line stays there.
- The email states only the price in: **no take-profit level and no stop**. Measure while building; put the numbers in
  the email.
- The pane is the newest 120 15-minute bars (the 15-minute chart's MACD pane; chosen over a 480-bar pane).
- The shares are on 15-minute bars too, the owner knowing that Yahoo's Tokyo prices come about 15 minutes late.

Earlier answers that still stand (research/macdfade96-spec.md 1.1): gold and the shares go out with the pairs, not
measured with this form; their mails say so and carry no numbers. The shares fade too (a SELL is a short sale).
Nothing is sent at any target. v9 stops at the release, which waits until no v9 ride is open and none was reached in
the last 45 minutes (if one stays open over a day, the owner is asked again). The name becomes 「MACD の逆張り」 /
"MACD fade"; v9 rows keep 「MACD の流れ」.

CLAUDE.md: the numbers may follow the owner's way of holding (take profit 10 pips, no stop), so they are measured as
TP 10 / no stop although the email states no target, and every text says so. A share of trades reaching +10 is never
written alone: with it go the mean a trade, the open trades' count and unrealised result (sum and worst), the largest
loss on the way, the holding time, the orders not filled (none: not a limit order) and the no-signal baseline. No text
says a price will come back.

## 2. The rule (pairs, gold and shares alike)

### 2.1 Terms (the study's)

- A chart's closed **15-minute** bars, oldest first, their closes as the chart draws them: a pair's, GMO's mid rounded
  (`historyRead` on the `15min` chart); gold's, Twelve Data's stored `15min` bars (`historyOfBars`); a share's,
  Yahoo's `15m` bars (`parseYahooChart(sym, body, "15min", …)`, section 3.3).
- For a closed bar `n` with at least 600 closed bars up to it: `w` = the 600 closes ending at `n`, `r = macd(w)`
  (macd.ts, 12/26/9), **`Z(n) = zoneAt(r, 599)`**, **`Zp(n) = zoneAt(r, 598)`** (macd-level.ts:199-215). Each is
  `{ m, top, bottom }`: the MACD line at that index, and the highest and lowest of the line, the signal line and the
  histogram over the 120 positions ending there, 0 included; unrounded.
- `Zp(n)` is "the bar before, read in bar n's own window". It equals `zoneAt(macd(the 599 closes before n), 598)` bit
  for bit (the EMAs are causal). It is **not** `Z(n−1)` on bar n−1's own window, which starts a bar earlier (the study
  counts the entries where that would matter, `prevAt`). v8's `decideZoneOnWindow` reads the same two (macd-level.ts:
  237-254: its "k−1" is index 598 of the same window). These are the study's definitions word for word ("The line at a
  bar's close").
- **At share `s`**, top: `top > 0 && m >= s * top`; bottom: `bottom < 0 && m <= s * bottom` (equality in, the product
  as it comes). `FADE_PCT = 96`, `FADE_SHARE = FADE_PCT / 100`.

### 2.2 The entry and the side

At a judged close of bar `n`: an entry on side `S` when `Z(n)` is at 0.96 on `S` and `Zp(n)` is not. Both sides cannot
hold at once (the top needs `m > 0`, the bottom `m < 0`). The side is the **fade**: top → SELL, bottom → BUY (a
share's SELL is a short sale). No entry while the line stays at 96%; it enters again only after a close below 96% and a
close back at it. No skip: an entry goes out whatever came before it. (At 0.95 this is v8's zone rule exactly, the rule
v31 mailed on 15-minute bars in October, docs §8.127.)

### 2.3 The price in; no target; no stop

- **A pair:** bar `n`'s **ask close for a BUY, bid close for a SELL**, from the same GMO 15-minute read the closes come
  from, as GMO gives them (not rounded). `fetchLiveQuotes` returns bid and ask bars (`QuoteCandle`) and `historyRead`
  makes the mid closes from them, but today the function keeps a read's quotes for the **1-hour** chart only
  (`if (c.interval === "1h") hourQuotes.set(…)`, index.ts:1333). It must keep the 15-minute read's too (a map
  `quarterQuotes`, set beside it for `"15min"`), take the quote whose open is `n`'s (as index.ts:1051 does on the
  hour) and price it with `ridePaidAt` (indicators.ts:735). This is the study's price: `ac[n]` / `bc[n]`, the bid and
  ask rows of GMO's own 15-minute file, not rounded ("Data", "Prices in").
- **Gold:** the closed bar's close (Twelve Data, one price, no bid or ask).
- **A share:** the closed bar's close (Yahoo's last trade).
- No target and no stop: the `signal_alerts` row has `stop` null and `target` null; no text states either price.

### 2.4 When each kind is read and judged

- **Pairs:** the `15min` chart, read 0, 1 and 3 minutes after each quarter-hour close (`gmoIntervalsDue`,
  indicators.ts:1223-1230), from a second into the minute (`startWaitMs`), never from a GMO answer made before the close
  (`staleForClose`). Judged once an instance (`judgedBar`); a fresh instance judges it again. Fewer than 600 closed
  bars: `short`, not judged. An entry is mailed only while its bar closed at most 20 minutes ago (`freshFor("15min")`,
  indicators.ts:346-347).
- **Gold:** Twelve Data's `15min` bars as the live chart keeps them (`live_chart_fallback`; `GOLD_ALERT_INTERVALS`,
  indicators.ts:241), looked at from a minute after each quarter-hour close until the next (`twelveChartDue`,
  `twelveCloseDue`, indicators.ts:1305-1327); Twelve Data itself read at most twice a close (`twelveReadDue`, :1346-1351)
  within the alerts' 780 a day (`ALERT_TWELVE_CAP`, :1359). This is how v31 read gold's 15 minutes (docs §8.127). Fresh
  20 minutes.
- **Shares:** Yahoo's 15-minute bars (`yahooChartUrl(sym, "15min")`: `interval=15m&range=60d`,
  live-chart/stocks.ts:51), read in the 30 minutes after each 15-minute session close (`STOCK_POLL_MS`, unchanged), at
  most once a minute (index.ts:1936); only the newest closed bar is judged at a read. Fresh 45 minutes
  (`STOCK_FRESH_MS`, unchanged): Yahoo's Tokyo prices come about 15 minutes late (stocks.ts:439-440, measured
  2026-11-06), so a Tokyo share's bar is mailed about 15 minutes after its close, about when the next bar closes. Kept
  at 45 so a late Tokyo bar or a missed run is still mailed.
- So the mail comes some minutes after the close (pairs 0-3 minutes and the sending, gold 1 minute or more, Tokyo shares
  about 15), at a price that may have moved since (not measured).
- **Never judged:** a pair's or gold's close whose reads all fall in the weekend gate, Friday 21:00 to Sunday 22:00 UTC
  (`isPossiblyClosed`, market-hours.ts:35-43; the sweep does not run, index.ts:833): Friday's 21:00 close every week,
  and any later Friday or earlier Sunday bar the feed holds. The study reads the gate the same way (a read a second
  into minute 0, 1 or 3 after the close) and counts such signals apart, `notMailed`, with no trade: they are not in its
  numbers. Also never judged: a pair whose three reads all fail, gold's bar not in Twelve Data after its two
  reads, a share's bar overtaken by the next before any read saw it closed, failed runs, a chart nobody follows. How
  often: not measured.

### 2.5 One email a bar and chart

- The decision is worked out again at each judging, from the closed bars alone (no table keeps it). Each follower gets
  it once: the claim key of `signal_alerts` (`user_id, kind, pair, interval, bar_time, side, rule`) and `mailRide`'s
  read of who already has a row (index.ts:776-799).
- **One side a bar.** `mailRide`'s read loses its `side` filter: it reads the bar's rows under the new id whatever their
  side. A row of the other side there: nothing mailed, the record says `other_side` (the bar stays judged). Only a feed
  that changed the closed bars between two judgings can cause it.
- **Re-offers, as v9's close path:** a follower whose address lookup failed (no row is claimed, index.ts:640-643) is
  mailed when the bar is judged again: a pair at minute 1 or 3 on a fresh instance, or when the bar is unsettled; gold
  each later minute up to the next close. The lookup failure alone does not unsettle a pair's or gold's bar
  (index.ts:1174-1186). A share's bar is held judged only once no follower is left unsent, so the next run in its window
  tries again (index.ts:1976-1982).

## 3. The code

### 3.1 The shared pure function: `_shared/macd-fade.ts` (new)

Pure, no clock, no I/O; imports `macd`, `MACD_DEFAULTS` (macd.ts) and `LEVEL_WINDOW`, `ZONE_BARS`, `zoneAt`
(macd-level.ts). Not macd-ride.ts.
- `FADE_PCT = 96`, `FADE_SHARE`, `FADE_TAG = \`fade${FADE_PCT}of${ZONE_BARS}\``, `fadeSideOf(zside)` (top SELL,
  bottom BUY), `fadeRuleId(prefix, interval, version)` (3.7).
- `closeEntryAt(closes, s)`: the newest 600 of `closes` (null on fewer, a non-finite close, or a MACD with a gap);
  `Z`, `Zp` as 2.1; returns `{ zside, side, z, zp, share0 }` (`share0` = `m / top` or `m / bottom` at `Z`) or null.
  `fadeCloseEntryAt(closes) = closeEntryAt(closes, FADE_SHARE)`. **One function for pairs, gold and shares.**
- **Unit tests** (vitest): against the rule written again from 2.1-2.2 on random walks (`zoneAt` at 599 and 598 of the
  window rebuilt), equality at the share included; `closeEntryAt(w, 0.95)`'s side equal to `decideZoneOnWindow`'s at
  every walk bar; `Zp` bit for bit against `zoneAt(macd(599 closes), 598)`; both sides never at once; null on 599
  closes and on a NaN close; the ids built from the constants, matching the app's `FADE_ID`, not `RIDE_ID`.

### 3.2 Pairs and gold: `fadeAtClose` in place of `rideAtClose` (index.ts:1001-1131)

`MACDH_INTERVALS = ["15min"]` (indicators.ts:286). `fadeAtClose` is called from `judge` where v9 calls `rideAtClose`
(index.ts:1160-1187): for a chart with `isMacdhChart(pair, interval)` and a `macdx` follower in this run, in its own
try / catch, after the other rules' mails. With `closed`, `newest`:
1. Not fresh (`age < 0` or over `freshFor("15min")`): nothing (`fade.fresh = false`).
2. `entry = fadeCloseEntryAt(closed.map((c) => c.close))`. None: nothing (`fade.entry = null`).
3. The price (2.3). Not finite: `fade.error = "no_price"`.
4. The signal (3.4), then `mailRide` (2.5) to the chart's `macdx` followers.
5. The bar is left unsettled (`judgedBar` deleted) only on `fade.error` (`no_price`, an exception).
Nothing is read or written each minute for this rule; no state row is written.

### 3.3 Shares: `stockFade` in place of `stockRide` (index.ts:1841-1932), on 15-minute bars

- stocks.ts: `STOCKMACD_INTERVALS = ["15min"]`; the hard-coded `"1h"` in `stockBarsOf` (`parseYahooChart`, :164) and
  in `isStockmacdChart(sym, "1h")` (:229, :259, :282) take the constant; index.ts reads `yahooChartUrl(sym, "15min")`
  (:1940).
- `CLOSES` (:119-122) become every 15 minutes of the regular session: New York 9:45 … 16:00; Tokyo 9:15 … 11:30 and
  12:45 … 15:30 JST. `stockBarEnd` (:144-149): the open + 15 minutes, or the session's end when earlier (a day that ends
  early). `stockBarBreak` (:292-297): New York's 15:45 and Tokyo's 15:15 bar "close", Tokyo's 11:15 bar "lunch".
- **Before building, fit these to a real Yahoo `15m` answer** for one US and one Tokyo share (how Yahoo stamps Tokyo's
  afternoon bars, and whether a past session ends with a closing point that `parseYahooChart` keeps as a bar of its own,
  live-chart/stocks.ts:136-137). Not seen by this writer. Whatever they are, the shares' bars are the chart's.
- On a read whose newest closed bar is to be judged (`stockSweepOf`, unchanged): fresh by `stockBarFresh`; `entry =
  fadeCloseEntryAt(closed.map((b) => b.close))`; the price `newest.close`; the signal; `mailRide` to the share's
  `stockmacd` followers. "Settled" only with no error and no follower left unsent (as v9). `stockRideClose` becomes
  `stockFadeClose(sym, closed, nowMs) → { fresh, entry }`.

### 3.4 The signal, the `signal_alerts` row, the run's record

- A new optional field `fade` on `IndicatorSignal` (`{ zside, m, top, bottom, share0, price }`) in place of `ride`;
  `sl` and `tps` null; `close` the bar's close as the chart draws it. `fadeSignal(rule, pair, interval, entry, {
  openMs, closeMs, close, price })` builds it.
- `signalRow` (indicators.ts:872-888): `entry` = `s.fade.price` (today it would take `s.close`, the mid); `stop` null;
  `target` null; `interval` `15min`; `bar_time` the bar's open; `closed_at` the bar's close (a share: `stockBarEnd`);
  `rule` the new id; `event_id` null (as today).
- The judged chart's record gains `fade: { fresh, entry, price, error?, other_side? }` in place of `ride`; its
  `signals` say `macdx:SELL` / `macdx:BUY` (shares `stockmacd:…`) when a row was made in this run or was there. No user
  id, address or row id in the record or the log.

### 3.5 What goes and what stays

**Goes:**
- index.ts: `rideAtClose` whole (rides read, state write and its 8-day delete, catch-up, entry, notice); `rideMinute`
  and its block (:1612-1713); `stockRide`; `readRides`, `rideKey`, `rideNow`, `openRide`, `reachRide`, `rideMailThere`
  (:694-812); `rideStateMemo`, `RIDE_STATE_MEMO_MAX`, `RIDE_STATE_KEEP_MS` (:451-454); the ride imports.
- indicators.ts: the ride ids and `rideRuleIdOf` / the ride branch of `signalRuleId`; `RideFacts`; `rideCloseSignal`,
  `rideOutSignal`; `MacdRide`, `MACD_RIDE_COLUMNS`, `macdRideOf`, `rideRowOf`; `rideLeaveAt`, `rideFormingOf`,
  `goldHourExtremes`, `RIDE_OUT_FRESH_MS`, `ridePnl`; `RIDE_MEASURED`, `rideMeasuredLine`, `renderRideMail`.
- stocks.ts: the ride ids, `stockRidesReached`, `stockRideClose`, `stockRidePnl`, the three ride mails. logic.ts:
  `rideHeldText` (email 2 only).
- **The tests of the removed code**, with it (they import it, so `npm test`, a release precondition, would fail):
  src/test/macd-ride-alerts.test.ts whole (every block tests v9's ride; it imports `rideCloseSignal`, `rideOutSignal`,
  `RIDE_MEASURED`, `MACD_RIDE_COLUMNS`, `rideHeldText` and more, :14-57; the checks of `ridePaidAt`, which stays, in its
  :265 block move to the fade's tests); in src/test/stockmacd-alerts.test.tsx the #397 blocks (:317-739 and :1045 to
  the end), the v9 lines of the #391 blocks (:86-91, :189-190, :763-766) and the v9 imports (:22-58); in
  src/test/indicator-alerts.test.tsx the ride's helpers (`toldRide`, `rideMailAt`, :1238-1259; `rideCloseSignal`
  imported at :53), the v9 tests of the #345 and #353 blocks that use them, and the ride's code-text checks (:1164-1167,
  :1454). In their place, 7.1's fade tests (the same waves read with `fadeCloseEntryAt`, the mail variants, 4.1's
  guards, the function over fake tables). src/test/macd-ride.test.ts stays (it tests main's macd-ride.ts, which
  stays); src/test/macd-ride-v10.test.ts goes at step 0 (below).
- **The shelved v10 code**, as the build's first commit (6.3 step 0): `_shared/macd-ride.ts`, `indicators.ts`,
  `stocks.ts`, `src/test/macd-ride.test.ts`, `research/macdride-replay.ts` and `.github/workflows/macdride.yml` go back
  to origin/main's bytes, and `src/test/macd-ride-v10.test.ts` is deleted. Afterwards no file under
  `supabase/functions/` imports `macd-ride.ts`; it stays as main's v9 file for the v9 morning-check bench
  (scripts/morning-check/bench/sim.ts), v9's replay, and a rollback.

**Stays:** the judging of closes and its timing; `hourQuotes`, `formingQuotes`, `goldMinutes` (the sharp rise uses
them); `mailerFor`, `claimRow`, `mailRide` (2.5); `ridePaidAt` (its side typed `"BUY" | "SELL"`); `macdNumbers`; the
tables `macd_rides` and `macd_ride_state` (no longer written; v9's morning check and a rollback read them). The sharp
rise keeps its own 1-hour reads: its followers make the 1-hour charts followed (index.ts:855), whatever `macdx` is
on.

### 3.6 No schema migration; the subscriptions move

- `signal_alerts` already has `entry`, `stop`, `target`, `closed_at` and the claim key with `rule`. No decision table
  (a close's decision is a pure function of closed bars), no index (`mailRide`'s read runs only at an entry), no state.
- **Subscriptions.** Today's followers are `rule = 'macdx'`, `interval = '1h'` (five pairs and gold) and `rule =
  'stockmacd'`, `interval = '1h'` (22 shares). After the function's change the server offers and reads `'15min'` only
  (`isIndicatorChartFor` / `isStockmacdChart`: the reads at index.ts:847, :1817; subscribing at :2434, :2475), so the
  rows move, as v31 and v33 moved them with one statement each way (docs §8.127, §8.129), here in a form that cannot
  collide (below):

  ```sql
  begin;
  delete from public.signal_alert_subscriptions o
   where o.rule in ('macdx', 'stockmacd') and o.interval = '1h'
     and exists (select 1 from public.signal_alert_subscriptions n
                  where n.user_id = o.user_id and n.pair = o.pair and n.rule = o.rule and n.interval = '15min');
  update public.signal_alert_subscriptions set interval = '15min'
   where rule in ('macdx', 'stockmacd') and interval = '1h';
  commit;
  ```
  - `'15min'` is allowed by `signal_alert_subscriptions_interval_check`
    (supabase/migrations/20261011120000_gold_minutes_all_day.sql:113-115). No DDL.
  - The unique key is `(user_id, pair, interval, rule)` (20260925180000_signal_alert_rules.sql:24). Before v40 the server
    refuses a `'15min'` `macdx` / `stockmacd` row, but once v40 answers, its status call offers `'15min'` and its `set` /
    `set_many` accept it (index.ts:2408, :2414, :2433-2440, :2475), and the screen shows that column. A follower who
    ticks it before the move has a `'15min'` row beside the `'1h'` one; a plain update would then hit the unique key and
    fail whole, leaving every follower on `'1h'`, where v40 mails nothing. So the `'1h'` row whose `'15min'` twin exists
    is deleted first (that follower is on the new chart already; the twin's `lang` is kept), then the rest move, in one
    transaction. The counts (no user ids: `select rule, interval, count(*) from public.signal_alert_subscriptions where
    rule in ('macdx', 'stockmacd') group by 1, 2`) are read after v40 answers, just before the send, and again after it.
    Should it fail anyway, nothing changes, and no follower is mailed until it is sent again.
  - It moves every follower, not only the owner's rows (who follows what: not read here; at v31 only the owner had
    `macdx` rows). `lang` stays.
  - Kept for the record as supabase/migrations/`<ts>`_macd_fade15_subscriptions.sql (data only: the delete and the
    update; idempotent, a second run finds nothing to do; `begin` / `commit` written when it is sent), sent by hand
    at 6.3 step 4 **with the owner's confirmation** (the Supabase connector asks the owner; a connector timeout is not
    proof that nothing ran, so read back; or the owner runs it in the SQL Editor). Nothing deploys it.
- **The screen offers** what the server says: the `macdx` and `stockmacd` grids show one `15min` column
  (`indicator.macdx.intervals`, `indicator.stockmacd.intervals`, index.ts:2408, :2414;
  src/components/SignalAlertSettings.tsx:224-291). No app code change for that; the texts change (section 5).
- The econ digest goes to `macdx` followers on `isMacdhChart` (econ-calendar/mailer.ts:90), so it follows the move once
  econ-calendar is deployed again by name (it bundles `isMacdhChart`).

### 3.7 Ids and version

| | id | built |
|---|---|---|
| pairs and gold | `macdx_12_26_9_w600_15min_fade96of120_in_v11` | `fadeRuleId("macdx", MACDH_INTERVALS[0], 11)` (`MACDH_FADE_VERSION`) |
| shares | `stockmacd_12_26_9_w600_15min_fade96of120_in_v4` | `fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], 4)` (`STOCKMACD_FADE_VERSION`) |

- `fadeRuleId(prefix, interval, version)` = `` `${prefix}_${fast}_${slow}_${signal}_w${LEVEL_WINDOW}_${interval}_${FADE_TAG}_in_v${version}` ``,
  every part from a constant. `indicatorRuleId("macdx")` / `("stockmacd")` give them.
- A grep of the repository (2026-11-17, `macdx_12_26_9_w600_` and `stockmacd_12_26_9_w600_`) finds every earlier id:
  `macdx` v1 to v10 (v31's 15-minute email `…_15min_z95of120_v7` among them), `stockmacd` v1 to v3, and two never-built
  1-hour fade ids in research/macdfade96-spec.md (`macdx_…_1h_fade96tp10of120_in_v11`, `stockmacd_…_1h_fade96of120_in_v4`).
  Both new ids differ from all (`15min`); v11 / v4 reuse only those never-written ids' numbers, so no id names two
  rules.
- Checked in node with copies of the app's regexes: neither matches `RIDE_ID` (src/lib/signalAlerts.ts:48); both match
  the proposed `FADE_ID` (pct 96) and go to the `macdx` / `stockmacd` tab (`ruleOfId`, :33-37).
- `FUNCTION_VERSION` (index.ts:364) → `"signal-alerts-v40-<the deploy's date>"`, a v40 note in the header; the seven
  test files pinning `signal-alerts-v39` change.

## 4. The emails

### 4.1 Rules for every text

- Japanese and English say the same facts; a test pins each variant in both.
- No price is labelled a take-profit or a stop. In this form's texts (its mails, notes, intros and plan line, and the
  sales page's sentences on the MACD fade), 「利確」 / "take profit" appears only in: the sentences saying there is no
  take-profit price (4.3 items 6 and 10 and their en, which the shares' mail takes too; the notes' and intros' matching
  sentence; the sales page's 「利確と損切りの値段を書かない決まり」 and its en), the measured paragraph (4.5), and the
  plan line's 「利確・損切りなし」 / "no take profit, no stop". 「利確の目安」, "take-profit level" and any price labelled
  as a target are forbidden. The shared pages' sentences about other rules (e.g. the FAQ's 「損切りと利確のどちらに先に
  届いたか」, today's text) are not this rule's.
- No stop is said to be how the rule is built, not advice to hold without one.
- No text says a price will come back: research/macdfade96-spec.md 6.1's two patterns run over every mail variant, the
  notes, the plan line and the sales page texts, in both languages, and find nothing.
- A count reaching +10 never appears without the fields of 4.5; a test checks them.
- The name 「MACD の逆張り」 / "MACD fade". The pairs' and gold's mails' how-to-stop line (today's in indicators.ts:1771
  / en :1708) and the econ digest's footer (econ-calendar/digest.ts:423, :452) name the tab 「MACD の逆張り」（画面が新しく
  なる前は「MACD の流れ」） / "MACD fade (MACD ride until the screen is updated)" until the later small PR of 6.3 step 8.
  The shares' mail keeps 「株の MACD」 / "Stock MACD" (stocks.ts:445 / en :382): that tab keeps its name.

### 4.2 Subjects

- Pairs and gold: 「【Sextant】ドル/円 15分足 売り（SELL）: 青い線が上の端の96%で確定（MACD の逆張り）」 (bottom: 「買い
  （BUY）: 青い線が下の端の96%で確定」); en "[Sextant] USD/JPY 15-minute SELL: the MACD line closed at 96% of the top
  (MACD fade)". The timeframe from `tfLabel` (logic.ts:317-322: 「15分足」 / "15-minute").
- Shares: 「【Sextant】〔name〕（〔code〕）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）」; en
  "[Sextant] 〔name〕 (〔code〕) 15-minute SELL (short sale): the MACD line closed at 96% of the top (stock MACD)".

### 4.3 The pairs' and gold's email (`renderFadeMail`)

1. 「〔pair〕の15分足で、MACD の逆張りの売り（SELL）の合図が出ました。」
2. 「判定した足: 〔close, JST〕（日本時間）に確定した15分足」
3. 「この足の終わりで、青い線（MACD）が、新しい120本（15分足）の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い
   所）の96%以上（0の線から測って）でした。一つ前の足の終わりでは、96%に届いていませんでした。上の端なので、逆張りの
   売り（SELL）の合図です。」 (bottom: 下の端・一番低い所・買い（BUY）).
4. 「MACD = 〔m〕、枠の上の端 = 〔top〕（その96% = 〔0.96 × top〕）」 (`macdNumbers`).
5. A pair: 「売値（この足の終値の売値）: 〔price〕」 (BUY: 買値). Gold: 「この足の終値: 〔price〕（売値・買値の別はありません）」.
6. 「利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。」
7. 「メールはこの1通だけです。このあと、この合図について知らせは送りません。同じチャート・同じ向きに前の合図があって
   も、次の合図は送ります。」
8. 「このメールは足の確定から数分後に届きます。届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。
   週末の止まっている時間（日本時間 土曜6:00〜月曜7:00）に確定した足は判定しません。」
9. Pairs: the measured paragraph (4.5). Gold instead: 「金では測っていません（足は Twelve Data のもので、売値・買値の別は
   ありません）。5ペアで測った数字は、アプリの設定の注にあります。」 No number.
10. 「この決まりは Sextant 独自のもの（96%・15分足の確定で判定すること・新しい120本の枠・逆張りの向き・利確と損切りの
    値段を書かないことは、アプリのオーナーが決めたものです）で、公開されているインジケーターではありません。」
11. As today: the source line, the app link, how to stop (4.1), the disclaimer. A pair's source line changes, as
    today's (indicators.ts:1770, 「価格は GMOコインの公開レート（買値と売値の中間）で…」) would call item 5's bid or ask
    the mid: 「足は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じです。上の値段は、同じ15分足の
    売値・買値の終値です。」 Gold's stays.

en, item by item:
1. "A MACD fade SELL signal on 〔pair〕's 15-minute chart." (BUY likewise.)
2. "Bar judged: the 15-minute bar that closed at 〔close, UTC〕 UTC (〔close, JST〕 JST)"
3. "At this bar's close the MACD line (blue) was at 96% or more of the top of the MACD pane of the newest 120 bars
   (15-minute) (the highest of the blue line, the orange line and the bars), measured from the zero line. At the close
   of the bar before, it was below 96%. It is the top, so this is a fade SELL signal." (bottom: "of the bottom", "the
   lowest", "a fade BUY signal").
4. "MACD = 〔m〕, the pane's top = 〔top〕 (96% of it = 〔0.96 × top〕)" (bottom: "the pane's bottom").
5. A pair: "Bid at this bar's close: 〔price〕" (BUY: "Ask at this bar's close"). Gold: "This bar's close: 〔price〕 (no
   separate bid and ask)".
6. "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a
   stop."
7. "This is the only email: nothing more is sent about this signal. A later signal on the same chart and side is sent
   too, whatever came before it."
8. "This email arrives a few minutes after the bar closes. The price when it arrives may differ from the close above
   (the difference has not been measured). Bars that close in the weekend pause (Friday 21:00 to Sunday 22:00 UTC) are
   not judged."
9. Pairs: the measured paragraph (4.5, en). Gold instead: "Not measured on gold (its bars are Twelve Data's, with no
   separate bid and ask). The numbers measured on the five pairs are in the app's settings notes." No number.
10. "This rule is Sextant's own (96%, judging at the 15-minute close, the pane of the newest 120 bars, the fade side and
    stating no take-profit or stop price are the app owner's choices), not a published indicator."
11. As today's en: the source line, the app link, how to stop (4.1), the disclaimer. A pair's source line: "The bars
    are the mid of GMO Coin's public bid and ask, as the app's chart draws them; the price above is the same 15-minute
    bar's bid or ask close." Gold's stays (indicators.ts:1705-1707).

### 4.4 The shares' email (`renderStockMail` rewritten)

In this order, ja / en (〔market〕 as today's share mail names it: 東証 / 米国, en Tokyo / US, stocks.ts:431 / :368):
1. 「〔name〕（〔code〕、〔market〕）の15分足で、MACD の逆張りの売り（SELL）の合図が出ました。株の売りは空売りです。」 /
   "A MACD fade SELL signal on 〔name〕 (〔code〕, 〔market〕), 15-minute chart. A SELL on a share is a short sale." (BUY:
   without the short-sale sentence.)
2. 「判定した足: 〔end, JST〕（日本時間）に確定した15分足」 / "Bar judged: the 15-minute bar that closed at 〔end, UTC〕 UTC
   (〔end, JST〕 JST)" (the end is `stockBarEnd`).
3. and 4. As 4.3 items 3 and 4, ja and en.
5. 「この足の終値: 〔close〕」 / "This bar's close: 〔close〕". On a session's last bar or Tokyo's bar before lunch
   (`stockBarBreak`), then: 「この足の終値では、次に市場が開くまで売買できません。」 / "At this bar's close nothing can be
   traded until the market opens again."
6. and 7. As 4.3 items 6 and 7, ja and en.
8. The timing, a share's own (not 4.3 item 8, whose 「数分後」 is wrong for Tokyo and whose weekend sentence is about the
   pairs): a US share 「このメールは足の確定から数分後に届きます。」 / "This email arrives a few minutes after the bar
   closes."; a Tokyo share only today's delay sentence (stocks.ts:440 / en :377: 「東証の値段は Yahoo では約15分遅れて届く
   ため、このメールは足が確定してから約15分後に送っています（2026-11-06 に測りました）。」 / "Yahoo's Tokyo prices come
   about 15 minutes late, so this email is sent about 15 minutes after the bar closed (measured on 2026-11-06)."); then,
   every share, 「届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。」 / "The price when it
   arrives may differ from the close above (the difference has not been measured)."
9. 「株では測っていません。」 / "Not measured on shares." No numbers.
10. 「この決まりは Sextant 独自のもの（96%・15分足の確定で判定すること・新しい120本の枠・逆張りの向き・利確と損切りの
    値段を書かないことは、アプリのオーナーが決めたもので、逆張りの向きは株にも当てはめました）で、公開されている
    インジケーターではありません。」 / "This rule is Sextant's own (96%, judging at the 15-minute close, the pane of the
    newest 120 bars, the fade side and stating no take-profit or stop price are the app owner's choices, the fade side
    applied to shares too), not a published indicator."
11. As today's share mail: the Yahoo source line (stocks.ts:434 / en :371), the app link, how to stop under 「株の MACD」 /
    "Stock MACD" and the disclaimer (stocks.ts:445 / en :382).

### 4.5 The measured paragraph (pairs only; `FADE_MEASURED`, `fadeMeasuredLine`)

The numbers are the study's real run, from its summary.json (research/macdfade15-spec.md "Files"; a copy committed as
research/ledger/macdfade15-summary.json; a test pins `FADE_MEASURED` to it; docs §8 records the run id). **The release
waits for them** (the study prints no real number until its Python agrees).
- `dirs.fade.all`: 〔trades〕 `trades`, 〔tp〕 `tp`, 〔open〕 `open`, 〔mean〕 `pipsMean` (open trades at their unrealised
  pips), 〔maeMedian〕, 〔maeMax〕, 〔tpMedian〕 `tpMinutesMedian`, 〔tpP90〕 `tpMinutesP90`, 〔tpMax〕 `tpMinutesMax`,
  〔openPipsSum〕, 〔openPipsWorst〕, 〔openLongest〕 `openMinutesMax`. Durations written in minutes under 2 hours, hours
  under 2 days, days beyond. 〔openPipsSum〕 is the open trades' net unrealised result (an open trade is only short of
  +10, so it can be in profit) and 〔openPipsWorst〕 their lowest; both are written with their sign, and the text says
  a minus is a loss.
- 〔flowMean〕 `dirs.flow.all.pipsMean`. 〔baseMean〕 `base.all.pipsMean`; 〔baseWhat〕 「15分足ごとの最初の1分に（買いと
  売りを1回ずつ）」 / "at every 15-minute bar's first minute (a BUY and a SELL)": about 14 minutes before a signal at the
  same bar would be, so the same holding with no signal, not the same entry; the parenthesis after 〔baseMean〕 says so.
- 〔pairMean〕 `dirs.fade.<pair>.pipsMean`, 〔pairBaseMean〕 `base.<pair>.pipsMean`; 〔negPairs〕: every pair whose fade
  mean is below zero, with its mean, or 「ありません」.
- 〔from〕, 〔to〕 `meta.start`, `meta.end` (the entries' closes in [start, end); open trades valued at the last minute
  loaded); `meta.share` 0.96 and `meta.tp` 10 checked by the test. 〔notMailed〕 the sum of `pairs[].notMailed`.

ja: 「測った数字（5ペア、〔from〕〜〔to〕に確定した15分足、スプレッド込み、docs §〔sec〕）。過去の GMO の足を読み直して
測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。このメールの決まりで足の
終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていま
せん）: 合図は〔trades〕回、うち〔tp〕回が+10 pips に届きました。〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は
合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕
持ったままでした（その後は追っていません）。1回あたり平均〔mean〕 pips（届いていないものは、その時の含み損益で数えまし
た）。途中の含み損は中央値〔maeMedian〕 pips、最大〔maeMax〕 pips。+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に
1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。足の終値で入るので指値ではなく、入らなかった注文はありません
（メールした合図はすべて入ったとして数えました）。損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。同じ
合図で逆向き（上で買い・下で売り）に入ると1回あたり〔flowMean〕 pips、合図なしで〔baseWhat〕入ると〔baseMean〕 pips でした
（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく15分足の最初の1分に入ったもので、同じ
入りではありません）。この差が偶然を超えるかは測っていません。〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは
〔pairBaseMean〕 pips）です。平均がマイナスだったペア: 〔negPairs〕。ほかに〔notMailed〕回、週末の止まっている時間に確定
した足に合図がありましたが、このメールでは判定しないので、上の数字に入れていません。」

en: "Measured (five pairs, 15-minute bars that closed from 〔from〕 to 〔to〕, spread paid, docs §〔sec〕). It re-reads
GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured). Entered by this
email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this
email states no take-profit price): 〔trades〕 signals, of which 〔tp〕 reached +10 pips. 〔open〕 had not reached it by
〔to〕; their unrealised result was 〔openPipsSum〕 pips in all (a minus is a loss), the worst 〔openPipsWorst〕 pips, the
longest held 〔openLongest〕 (not followed after that). The mean was 〔mean〕 pips a trade (those not reached counted at
their unrealised result then). The largest loss on the way: median 〔maeMedian〕 pips, largest 〔maeMax〕 pips. Time to
+10 pips: median 〔tpMedian〕, longer than 〔tpP90〕 one time in ten, longest 〔tpMax〕. The entry is at the bar's close,
not a limit order, so no order went unfilled (every signal emailed is counted as entered). With no stop, the share
reaching +10 pips comes out high by construction. Entering the other way on the same signals (a BUY at the top, a SELL
at the bottom) gave 〔flowMean〕 pips a trade, and entering with no signal 〔baseWhat〕 gave 〔baseMean〕 pips (held the
same way, +10 pips and no stop, but entered at the 15-minute bar's first minute, not at its close, so not the same
entry). Whether these differences are beyond chance has not been measured. On 〔pair〕 alone the mean was 〔pairMean〕
pips (with no signal, 〔pairBaseMean〕 pips). Pairs whose mean was below zero: 〔negPairs〕 (or "none"). Besides these,
〔notMailed〕 signals fell on bars that closed in the weekend pause; this email does not judge those bars, so they are
not in the numbers above."

## 5. The screen and the sales page

- **Id parse** (src/lib/signalAlerts.ts): beside `RIDE_ID`, `FADE_ID =
  /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/` fills a new `AlertRow` field `fade: { pct: number } |
  null`. `RIDE_ID` stays: v9 rows read as today, v8 and older (v7's 15-minute rows too) as 「前の決まり」.
- **Tag** (`rowLabel`, SignalAlertSettings.tsx:110-127; a fade branch before the earlier-rule one at :125): the side in
  side colour; a pair's or gold's fade row 「（MACD の逆張り）」 / " (MACD fade)" (new `ruleTagFade.macdx`); a share's
  「（株の MACD）」 (`ruleTag.stockmacd`). `ruleTag.macdx` 「（MACD の流れ）」 stays for v9 rows.
- **Plan line** of a fade row: 「入り 〔entry〕 / 利確・損切りなし」 / "In 〔entry〕 / no take profit, no stop" (new `fadePlan`;
  today's `plan` shows only with a stop, :411-413). The time column shows `closed_at`, the bar's close. The row's
  timeframe reads 「15分足」 from its `interval`.
- **Tab name** `ruleTabs.macdx` (ja:2101 / en:1996): 「MACD の逆張り」 / "MACD fade". The interval shown in the grid comes
  from the server (3.6).
- **Notes and intros** rewritten (ja and en, the same keys and array lengths, src/test/i18n.test.ts:36-39): the card
  intro (ja:2090, 2092 / en:1987, 1988), `indicatorIntro.macdx` (ja:2118), `macdxNotes` (ja:2137-2154),
  `indicatorIntro.stockmacd` (ja:2127), `stockmacdNotes` (ja:2190-2198, with ja:2193's list of hourly closes becoming
  the 15-minute ones), the MACD indicator note (ja:557), the FAQ's chart list (ja:2035) and 「メールはいつ届きますか？」
  (ja:2037; v9's email-2 parenthesis goes). They say: 96% at a 15-minute close with the bar before not at 96% (one email a
  bar; none more while the line stays); the 120-bar pane of the 15-minute chart; the fade side; the price; no
  take-profit and no stop price (how the rule is built, not advice), whose choices these are (4.3 item 10); one email, no
  skip; when closes are judged and that the mail comes minutes after the close (Tokyo shares about 15); the weekend
  gate; that whether a trade reached +10 is not recorded or shown; the measured paragraph (4.5) in the pairs' notes;
  「金では測っていません」 / 「株では測っていません」 with no numbers; that until the switch day the email was on 1-hour bars.
  Every sentence on 90%, email 2, the notice, the minute check and v9's numbers goes. `rideOut`, `rideAt`, `ridePrices`
  stay for v9 rows. The v31 commit 19d049a shows where the texts named the timeframe last time.
  `macdxNotes` item by item (ja:2138-2153 / en:2033-2048, the same order):
  - **Stay**, every 「1時間足」 / "1-hour" in them becoming 「15分足」 / "15-minute": gold's Twelve Data notes (ja:2139,
    2140; ja:2139's 「確定から30分まで」 and 「確定から30分を過ぎた足は送りません」 take v31's 15-minute wording, 19d049a:
    「次の足が確定するまで（確定から15分まで）…次の足が確定した後は、その前の足は送りません」); the zoom note (ja:2146);
    the margin note (ja:2147) and the unrounded note (ja:2148), naming 96% only (the margin note's last sentence, on
    email 2's forming pane and email 1's closed one, becomes 「メールは、確定した足までの新しい120本で決めます。」); the
    ULTRA note (ja:2150); the weekend note (ja:2152) and gold's break note (ja:2153), their bar counts taking v31's
    15-minute wording (19d049a:
    「（15分足では、米国の夏時間は金曜 20:45〜21:00 UTC の1本、冬時間は金曜 20:45〜22:00 UTC の5本）」, 「毎日の休み
    （1時間。15分足では4本）」, 「金曜の引け後の足（15分足では4本）」).
  - **Rewritten**: ja:2138 (the charts, and when closes are judged: pairs 0, 1 and 3 minutes after each quarter-hour close,
    gold from a minute after it; no minute check), ja:2141 (the rule of 2.1-2.2 and the fade side), ja:2151 (no
    take-profit and no stop price, how the rule is built and not advice; nothing recorded).
  - **Go**: ja:2142-2145 (the notice, email 2, the catch-up, the band) and ja:2149 (v9's numbers), in their place the
    measured paragraph (4.5) and 「金では測っていません」 (the array keeps ja and en the same length).
- **Sales page** (no percent and no measured number, src/test/landing.test.tsx:51-58; the FAQ's forbidden pattern,
  signal-alert-settings.test.tsx:492). Word for word below, ja and en; none depends on the numbers (no test of chance is
  run, so 「…良いとは示せていません」 always holds; the MACD fade is always outside the break-even comparison, with the
  reason, because with no stop it has no break-even win rate). A test pins each.
  - `lp.faqs` 「勝率はどのくらいですか？」 (ja:2033): 「過去のチャート（スプレッド込み）で測ったサインは、MACD の逆張りを
    除き、どれも損益ゼロに必要な勝率に届いていません。MACD の逆張りを除くのは、損切りをしない決まりで、損益ゼロに必要な
    勝率というものがなく、勝率では比べられないためです（届いたという意味ではありません）。数字はアプリ内の説明に載せて
    います。MACD の逆張り（15分足）は、5ペアで測った数字が設定の注にあります。損切りをしないので、含み損のまま残る取引が
    出ることがあり、合図なしで入った時より良いとは示せていません。損切りをしないのはこの決まりの作りで、損切りをしない
    ことを勧めるものではありません。金・株と、流動性狩り＋EMAクロスは、まだ測っていません。勝てる根拠として使わないで
    ください。」 en (:1930): "On past charts (spread paid), none of the signals measured reached the win rate needed to
    break even, except the MACD fade. The MACD fade is left out because it has no stop by design, so there is no
    break-even win rate to compare it by (it does not mean it reached one). The numbers are in the app's notes. The MACD
    fade (15-minute) has its own numbers, measured on the five pairs only, in the settings' notes. With no stop, some
    trades can stay open at an unrealised loss, and it has not been shown to do better than entering with no signal.
    Having no stop is how this rule is built; it is not advice to hold without a stop. Gold, stocks and the liquidity
    sweep + EMA cross have not been measured. Please do not take them as a reason to expect to win."
  - `lp.honestBody` (ja:2028): 「過去のチャート（11通貨ペア・スプレッド込み）での検証では、MACD の逆張りを除き、アプリの
    どのサインも損益ゼロに必要な勝率に届いていません。MACD の逆張り（5ペアで測定）を除くのは、損切りをしない決まりで、
    勝率では比べられないためです（届いたという意味ではありません）。損切りをしないので、含み損のまま残る取引が出ることが
    あり、合図なしで入った時より良いとは示せていません。サインは注文の指示ではなく、判断の材料です。通知したサインの実際の
    成績は、成績を記録している決まりについて、件数とともにアプリ内にそのまま表示します。MACD の逆張りの成績は、記録も表示
    もしていません。」 en (:1925): "On past charts (11 pairs, spread paid), none of the app's signals reached the win rate
    needed to break even, except the MACD fade. The MACD fade (measured on five pairs) is left out because it has no stop
    by design, so it cannot be compared by win rate (it does not mean it reached one). With no stop, some trades can stay
    open at an unrealised loss, and it has not been shown to do better than entering with no signal. A signal is not an
    order to trade; it is something to weigh. For the rules whose results are recorded, the real record of the signals
    emailed is shown in the app, with how many there were. The MACD fade's results are not recorded or shown."
  - 「他のツールと何が違いますか？」 (ja:2032): 「サインの成績を隠さない点です。過去のチャートでの検証結果と、成績を記録して
    いる決まりについては、通知したサインが実際に損切りと利確のどちらに先に届いたかを、勝てていない場合もそのまま表示し
    ます。MACD の逆張りは、利確と損切りの値段を書かない決まりで、その成績は記録も表示もしていません。売買のサインは確定
    した足で判定し（MACD の逆張りも、15分足の確定で判定します）、後から消えたり動いたりしません。」 en (:1929): "It does
    not hide the record. How each rule did on past charts, and, for the rules whose results are recorded, whether each
    signal emailed reached its stop or its target first, are shown as they are, losing ones included. The MACD fade
    states no take-profit or stop price, and its results are not recorded or shown. Trade signals are judged on closed
    bars (the MACD fade too, at 15-minute closes) and never vanish or move afterwards."
  - Not checked here, kept from today's texts: that the other signals fall short on 11 pairs; that every other trade
    signal is judged on closed bars (「売買の」 / "Trade" leaves out the sharp-rise notice, judged each minute, which
    its own text calls not a trade signal, ja:448).
- **Tests to change:** the lists forbidding 「利確」 / "take profit" that stay (src/test/indicator-alerts.test.tsx:1506,
  2139; signal-alert-settings.test.tsx:417, 565, 853) first strip exactly the sentences 4.1 allows, each written out in
  the test (4.3 items 6 and 10 and their en; the shares' item 10; the notes' and intros' no-take-profit sentence; the
  measured paragraph of 4.5; the plan line's 「利確・損切りなし」 / "no take profit, no stop"; the sales page's fade
  sentences above), then find none; 「利確の目安」 and "take-profit level" are forbidden outright. The lists in
  macd-ride-alerts.test.ts (:376, :408) and stockmacd-alerts.test.tsx (:550, :583, :716) go with their blocks (3.5);
  the fade mails' tests carry the same guard. The v10 rows' test (signal-alert-settings:736-771) becomes the fade
  rows'; v9 and older rows' tests (:655-734) stay; the tab name, intros, notes and FAQ pins (:397-567, :773-860;
  econ-digest.test.ts:284-285) follow the new texts; the tests pinning `'1h'` for `macdx` / `stockmacd` that stay
  (indicator-alerts, signal-alert-settings, stockmacd-alerts' #391 blocks, econ-mailer) take `'15min'`.

## 6. Release

### 6.1 Preconditions

- **No v9 ride open** (the owner's answer), read twice: just before the function's merge, and again once v40 answers
  (6.3 step 4). The read: `select status, count(*) from public.macd_rides where status = 'open' or reached_at > now() -
  interval '45 minutes' group by 1` returns no row. Before the merge: else wait; no row is changed by hand; open over a
  day: the owner is asked again. The second read is needed because the merge only starts a deploy (below): until v40
  answers, v39 still judges 1-hour closes and opens a ride at a fresh entry (index.ts:1075-1130, `openRide` at :1108;
  a share's at :1897), and v40 never sends that ride's email 2.
- **The owner has confirmed the subscription statement** (3.6) before the merge, so it can be sent at step 4 at once.
- **A merge alone ships it.** A push to main touching `supabase/functions/**` deploys the default eight functions one
  after another, signal-alerts seventh and live-chart last (.github/workflows/deploy-functions.yml:22-25, :74-85); a
  deploy already queued runs first (`cancel-in-progress: false`, :35-39). No workflow runs the tests on a pull request.
  So every PR before the function's has `git diff --stat origin/main...<head> -- supabase/functions` empty (true from
  step 0 on).
- The tests and static checks of 7.1 pass, 7.2 passed on the real run, `FADE_MEASURED` holds the real numbers.

### 6.2 Timing

Merge the function's PR in minutes 31-50 of an hour (v9's 1-hour closes are judged by :29: pairs :00-:05, gold to
:29), outside the 45 minutes after any 1-hour share close (v9's share window, stocks.ts:119-126: in practice outside the
Tokyo and New York sessions), with no v9 ride open. The merge only starts the deploy (6.1), and v39 judges until v40
answers: v31's deploy ran 10:23:27-10:23:57 and v31 answered from 10:24:00 (docs §8.127), so a merge at :31-:50
normally lands well before the next :00, but a queued or slow deploy can run past it, or past a share close. The time of
v40's first answer is noted (from the run's record); whatever it is, the second read of 6.1 (6.3 step 4) decides
whether to go on. The two forms never judge the same bar (1-hour against 15-minute). `live_ms` (for the morning check),
per chart: the open of the first 15-minute bar v40 judged with a `15min` follower, read from the run's record in
`net._http_response` after the subscription move. Bars closing between v40's first answer and the move are judged for
nobody (as at v31, docs §8.127: about two minutes).

### 6.3 Order

0. The build's first commit restores the shelved v10 files (3.5).
1. This spec and the study's files: a PR with nothing under `supabase/functions/**`.
2. The app's id parse, tag and plan line (section 5's first three items only), cut from origin/main; merged and
   published. Lovable's state is reported as given (e.g. `pending`).
3. The function's PR (sections 3-4, logic.ts's `RULE_LABEL` and test-mail lists, the econ footer), merged per 6.1-6.2.
4. Once v40 is seen answering (its `FUNCTION_VERSION` in the run's record): first the `macd_rides` read of 6.1 again,
   with v40's first answer time noted against the next :00 and the 1-hour share closes. If it returns a row (a ride v39
   opened or reached between the first read and v40's first answer), nothing more is done and the owner is told and
   asked what to do with it, as the earlier answer says: an open ride gets no email 2 from v40 (one way is to revert to
   v39 by 6.4 until it is reached and 45 minutes have passed: the subscriptions are still on `'1h'`, so v39 runs as
   before); a reached one's email 2 went out, but a follower whose address lookup failed gets no re-offer. Only when it
   returns no row: the counts of 3.6 read, the subscription statement (3.6) sent, and the counts read back (`macdx` /
   `stockmacd`, `'15min'`, none left on `'1h'`).
5. econ-calendar deployed by name right after (its footer and `isMacdhChart` changed; it is not in the default list).
6. The screen's texts (the rest of section 5), merged and published as soon as v40 answers; state reported as given.
   Until it is live the screen shows v9's texts beside a `15min` column.
7. The morning check of 7.3 merged, and the Routine's prompt replaced and read back before the next 00:16 UTC run.
8. Later, if wanted: a small PR drops 「MACD の流れ」 / "MACD ride" from the how-to-stop lines and the footer (it
   deploys again; econ-calendar too).

### 6.4 Rollback

Revert the function's merge (v39 is deployed again); once v39 answers, if step 4 moved them, move the subscriptions
back with the owner's confirmation, collision-proof as in 3.6 the other way (v39's `set` accepts `'1h'` again): in one transaction, delete the
`'15min'` `macdx` / `stockmacd` rows whose `'1h'` twin exists, then `update public.signal_alert_subscriptions set
interval = '1h' where rule in ('macdx', 'stockmacd') and interval = '15min'`; deploy econ-calendar by name; revert and
publish the screen's text PR; put the Routine's v9 prompt back (a copy kept before step 7). No schema to undo. v39
starts with no ride open when the second read of 6.3 step 4 returned no row (v40 opens none); when it returned one, the
owner's answer then decides. Fade rows and mails stay; the app keeps reading both ids. A rollback restores a form the
owner left: only for a failure, and the owner is told.

## 7. Checks

### 7.1 Tests and static checks

`npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and econ-calendar, and `deno
check scripts/morning-check/bench/sim.ts` (the v9 bench, on main's macd-ride.ts). No import of `macd-ride.ts` under
`supabase/functions/` (grep). Function tests over fake tables: a pair's close judged at minutes 0, 1 and 3 (fresh
instances): one email a follower, the same price (the 15-minute ask / bid close of the bar, from the kept quotes); a
follower whose lookup failed, mailed at the next judging; a row of the other side: nothing, `other_side`; not fresh (21
minutes): nothing; a missing quote: `no_price`, judged again; gold judged a minute after a close and again up to the
next close; a share read again in its window: one email a follower; a Tokyo bar arriving 15 minutes late: judged and
mailed (fresh at 45); `stockBarEnd`, the closes list and `stockBarBreak` on 15-minute bars (US, Tokyo lunch, an
early close); the row's `interval` `15min`, `entry`, null `stop` and `target`, `closed_at`, `rule`; each mail
variant in ja and en (a pair's BUY and SELL, gold's, a US and a Tokyo share's, a session's last bar), each pinned to
the words of 4.3-4.5: among them the share mails' timing and arrival-price sentences (4.4 item 8: a Tokyo share's
without 「数分後」) and their Yahoo source line, app link, 「株の MACD」 / "Stock MACD" how-to-stop line and disclaimer
(4.4 item 11), and the measured paragraph's re-read clause, 「（マイナスが損）」 / "(a minus is a loss)", 「入らなかった
注文はありません」 / "no order went unfilled" and the baseline's parenthesis after 〔baseMean〕 (4.5); 4.1's guards; the
sales page's three texts of section 5, ja and en; the record's `fade` and tags; the econ digest's recipients on
`15min`.

### 7.2 The study check: the shared function gives the study's entries

`research/macdfade15-prod-check.ts` (new; run in .github/workflows/macdfade15.yml after the study, on the walk files of
`MODE=walkfiles` and on the real run). It loads the five pairs' 15-minute bars exactly as the study does
(`loadTf(src, pair, "15min", LOAD_FROM, END, st, weekendOutOf("inside"))` → `quotesOf` → `historyRead`, the study's
`LOAD_FROM`, `START`, `END`), and for every bar `n` with its close in `[START, END)` and 600 bars up to it calls
`fadeCloseEntryAt` on the 600 closes ending at `n`, with the price from the bar's own quote through `ridePaidAt`. A bar
whose three reads (`T` + 0, 1, 3 minutes + 1 second) all fall in `isPossiblyClosed` is counted as not mailed. Against
the study's rows.csv (`dir = fade`), keyed by pair|open: the mailed entries are the same set of bars, each with the same
`zside`, `side`, entry and `share0`; per pair, the not-mailed ones equal `notMailed` and all of them `signals`. Any
difference: the first 20 printed and the job fails. The study is written apart from the shared code and checked by its
own Python; this check ties the shipped function to it.

### 7.3 The morning check of the new form (statements `pairs-v11` / `gold-v11`; README section)

- **Pairs**, from scripts/morning-check/pairs-v7.sql (v31's 15-minute statement: the stored `15min` day files, 13 days
  back, `live_ms`, the weekend window, interval `15min`): the share 0.95 → 0.96 for Z and Zp (:183-184, :203-204, :210);
  the rule id → the new one (:237, :249); the go-live constant; the FRONT carries the BID and ASK closes (as
  `front-pairs-v9.part` does for the 1-hour files) so the mail's `entry` is compared with the ask close (BUY) or bid close
  (SELL), not the mid (:401-402); new verdict parts `other_side` (rows of both sides in one bar), `stop_or_target`
  (either not null). The side is already the fade side (v7's rule was the zone rule).
- **The files are stored:** the sweep stores each ended 15-minute GMO day file it reads (`storeFile`, index.ts:884-891)
  and deletes them after 60 days (index.ts:838); between v33 (2026-10-30) and the release only the `15min` charts of
  other rules' followers were read, so the first reads after the release fill the missing days (as at v31).
- **Gold**, from gold-v7.sql likewise (its price the close; the stored Twelve Data `15min` row).
- **Shares**: rows against mails only (their bars are not stored): one side a bar under the new id, one entry in every
  row of a bar, `stop` and `target` null.
- v7's statements are about 25,600 and 22,100 characters, small enough for the Routine to send as it sent v8's, so
  **no DDL** is needed. If the new ones outgrow one call, the function form (owner-confirmed DDL) as v9's.
- The Routine's prompt is replaced and read back before the first 00:16 UTC run after the release. On the switch day
  it runs `mc.pairs_v9` / `mc.gold_v9` for the 1-hour part (after the move they read `no_subscription`: not errors) and
  v11 for the 15-minute part from `live_ms`. Until v11 is in, every report says 「新しい形（15分足・確定96%・逆張り）の
  判定は数え直していません」.

## 8. Not measured, not checked

- **Not read:** the study's code (research/macdfade15.ts; its Python and workflow not written yet) and any of its
  output; its spec was read once, as it stood about 10:10 UTC, after this file's first draft. logic.ts beyond the
  timeframe labels (the admin list not opened); econ-calendar beyond its recipients and footer lines; the
  morning-check SQL beyond pairs-v7.sql's head and its 0.95 and mail lines; the tests beyond their names and the maps'
  citations. The four maps (scratchpad `fade96/map/`) were written for the 1-hour minute form; the code they cite and
  this file relies on was opened again (gmoIntervalsDue, twelveCloseDue, freshFor, hourQuotes, judge, rideAtClose,
  mailRide, signalRow, the stock sweep and stocks.ts, parseYahooChart, macd-level.ts, the subscription constraints, the
  status call's intervals, the econ recipients, docs §8.127 and §8.129).
- **Not checked:** a real Yahoo `15m` answer (Tokyo's afternoon stamps, a past session's closing point); whether
  production's GMO 15-minute bars equal the study's loader's; whether a feed revises a closed bar between judgings
  (`other_side`); who follows which chart and how many `macdx` / `stockmacd` rows there are (production not read); how
  many v9 rides are open; the Routine's prompt; Lovable's live state; how long v40's deploy will take (6.2: the second
  `macd_rides` read decides); whether any follower ticks the `15min` column before the move (3.6 is written so that
  it does not matter); the claims kept from today's sales texts (section 5, the sales page's last sub-item).
- **Not measured:** this form's numbers (the study is not run yet); gold and the shares with this form; the minutes
  between a close and the mail and the price's move in them; how often a close is not judged; Yahoo's answers and the
  stock run's length when Tokyo shares are read about once a minute through the session (their bar comes about 15
  minutes late, so the next close is due before the last is in); the Twelve Data reads a day (up to two a gold close,
  96 closes a day); the database egress of judging every quarter hour (v31 ran so for four days, not measured then
  either); whether the fade's mean differs from the baseline's beyond chance.
- **Run by this writer:** one node check of the two ids against copies of the app's regexes (3.7). `git fetch` of
  origin once (it changed nothing). Nothing else: no test, no app, no function, no study.
- **The revision after the review (16 findings):** read again deploy-functions.yml; index.ts's v39 entry and
  `openRide` (:1075-1130), status / `set` / `set_many` (:2400-2490) and the lines cited in sections 2-3; the imports
  and describe blocks of macd-ride-alerts.test.ts, stockmacd-alerts.test.tsx and indicator-alerts.test.tsx and the
  guard lines of section 5; stocks.ts's mail lines (:371-445); indicators.ts's how-to-stop lines, `isIndicatorChartFor`
  and the Twelve Data timing; ja.ts / en.ts's notes, intros and sales texts at the cited lines; the 19d049a diff of
  ja.ts; research/macdfade96-spec.md 6.6; the 1-hour draft's 4.3-5; macd_rides' columns. Ran only greps and reads:
  no test, no app, no function, no study, no production.
