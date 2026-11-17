# The MACD fade on 1-hour closes: one email when the line closes at 96%, no target, no stop

Status: a production spec, written 2026-11-17 on branch `claude/app-confirmation-jvmk03` on 53f7003 (the draft
committed in 6cbee35), then revised the same day after three reviews (24 findings, each checked against the code and
the sources; section 8 says what that revision read). Nothing in it is built. Production still runs v9 (signal-alerts
v39, 1-hour bars). For production it replaces research/macdfade15-prod-spec.md (the same rule on 15-minute closes,
dropped by the owner's 「やっぱりメールの判断1時間足で」, never built), which stays as the record of that form, as
research/macdride-spec.md (v9) and research/macdfade96-spec.md (the minute touch, never built) stay for theirs (6.3
step 1 marks the 15-minute spec as superseded and points macdfade96-spec.md's head to this file). **The measured numbers are filled (2026-11-17, 6.3 step 1a).** The study's real `TF=1h` run is
research/macdfade15-spec.md's section "Result of the real 1-hour run" (commit d96bf56): Actions run 44099401423 on
53f7003, the Python agreeing with every row and number. Its summary.json (sha256
`60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2`) is in the repository as
research/ledger/macdfade1h-summary.json, by 4.5's route 1 (the same study run again, run 44108923903 on d120a30, printing
the file as one base64 line; the copy's sha256 is the same). Every ⟨1h run: …⟩ of the first draft is filled from that
file (4.5's table), and sections 4-5 were read against the numbers. An
earlier, unreviewed 1-hour draft of this rule (scratchpad, never committed) was used only as a source of 1-hour facts,
each checked again in the code.

**Paths.** Under the repository root. `index.ts`, `indicators.ts`, `stocks.ts`, `logic.ts` are in
`supabase/functions/signal-alerts/`; `macd-level.ts`, `macd-ride.ts`, `macd.ts`, `market-hours.ts` in
`supabase/functions/_shared/`. Line numbers are this branch's, read 2026-11-17; `supabase/`, `src/` and `scripts/` are
byte for byte origin/main's (`git diff --stat origin/main -- supabase src scripts` is empty since 9bcfd70, which put the
shelved v10 files back). Several line numbers differ from research/macdfade15-prod-spec.md's, which were read on the
v10 files.

**The study it must equal.** research/macdfade15-spec.md, section "On 1-hour bars (TF=1h)" (:314-351), built in
research/macdfade15.ts (`TF=1h`, commit 53f7003) and .github/workflows/macdfade15.yml (default `TF` `1h`, :52-54, :68),
checked by research/macdfade15-check.py. Its real 1-hour run on GMO's prices is recorded in that spec's section
"Result of the real 1-hour run" (d96bf56, run 44099401423; see Status); the job's log and its artifact were not read by
this writer. Its rule, files and numbers govern: where it reads differently from section 2, this file is corrected
before anything is built.

## 1. What the owner asked

2026-11-17: 「もうシンプル96%の足できたら逆張りのメールちょうだい」, then 「メールを1時間足から15分足に変更」, then
「やっぱりメールの判断1時間足で」. Answers given in the question dialog (in English here, not the owner's words), which
stand:
- Only the first bar at 96% (the bar before not at 96%), not every bar while the line stays there.
- The email states only the price in: **no take-profit level and no stop**. Measure while building; put the numbers in
  the email.

Two readings of this writer, **not asked again**:
- **The pane.** On 15-minute bars the owner chose the chart's own pane (the newest 120 15-minute bars, over a 480-bar
  pane). On 1-hour bars this spec reads "the chart's own pane" as the 1-hour chart's: the newest 120 1-hour bars (v8's
  and v9's, about five trading days), on the 600 closes ending at the bar.
- **The shares.** The dialog put the shares on 15-minute bars with the email. With the email on 1-hour bars they stay
  on the 1-hour bars production already judges them on (`stockmacd`, v9: Yahoo's `60m` bars, stocks.ts:57,
  live-chart/stocks.ts:53). So nothing of the 15-minute share form (its closes, Yahoo `15m`, the Tokyo lunch fitting)
  is needed.
- No mail, note or screen text calls either reading the owner's choice (4.3 item 10, 4.4 item 10): they state the pane
  and the shares' 1-hour bars as facts of the rule. What the texts attribute to the owner is only what the owner said:
  96%, judging when the bar is done (「足できたら」, read as its close), the email judged on 1-hour bars (for the pairs
  and gold), the fade side (the shares too, research/macdfade96-spec.md 1.1 Q4(a)), and no take-profit or stop price.

Earlier answers that still stand (research/macdfade96-spec.md 1.1): gold and the shares go out with the pairs, not
measured with this form; their mails say so and carry no numbers. The shares fade too (a SELL is a short sale).
Nothing is sent at any target. v9 stops at the release, which waits until no v9 ride is open and none was reached in
the last 45 minutes (if one stays open over a day, the owner is asked again). The name becomes 「MACD の逆張り」 /
"MACD fade"; v9 rows keep 「MACD の流れ」.

CLAUDE.md: the numbers may follow the owner's way of holding (take profit 10 pips, no stop), so they are measured as
TP 10 / no stop although the email states no target, and every text says so. A share of trades reaching +10 is never
written alone: with it go the mean a trade, the open trades' count and unrealised result (sum and worst), the largest
loss on the way, the holding time, the orders not filled (none: not a limit order) and the no-signal baseline. No text
asserts that a price recovers.

## 2. The rule (pairs, gold and shares alike)

### 2.1 Terms (the study's, `TF=1h`)

- A chart's closed **1-hour** bars, oldest first, their closes as the chart draws them: a pair's, GMO's mid rounded
  (`historyRead` on the `1h` chart, index.ts:1334); gold's, Twelve Data's stored `1h` bars (`historyOfBars`,
  index.ts:1236); a share's, Yahoo's `60m` bars (`stockBarsOf` → `parseYahooChart(sym, body, "1h", …)`,
  stocks.ts:160-185).
- For a closed bar `n` with at least 600 closed bars up to it: `w` = the 600 closes ending at `n`, `r = macd(w)`
  (macd.ts:16, 12/26/9), **`Z(n) = zoneAt(r, 599)`**, **`Zp(n) = zoneAt(r, 598)`** (macd-level.ts:199-215). Each is
  `{ m, top, bottom }`: the MACD line at that index, and the highest and lowest of the line, the signal line and the
  histogram over the 120 positions ending there, 0 included; unrounded.
- `Zp(n)` is "the bar before, read in bar n's own window". It equals `zoneAt(macd(the 599 closes before n), 598)` bit
  for bit (the EMAs are causal). It is **not** `Z(n−1)` on bar n−1's own window, which starts a bar earlier (the study
  counts the entries where that would matter, `prevAt`). v8's reading is the same: `zoneEntryAt` reads `k` and `k − 1`
  of one window (macd-level.ts:237-245), called at index 599 by `decideZoneOnWindow` (:251-254). These are the study's
  definitions ("The line at a bar's close").
- **At share `s`**, top: `top > 0 && m >= s * top`; bottom: `bottom < 0 && m <= s * bottom` (equality in, the product
  as it comes). `FADE_PCT = 96`, `FADE_SHARE = FADE_PCT / 100`.

### 2.2 The entry and the side

At a judged close of bar `n`: an entry on side `S` when `Z(n)` is at 0.96 on `S` and `Zp(n)` is not. Both sides cannot
hold at once (the top needs `m > 0`, the bottom `m < 0`). The side is the **fade**: top → SELL, bottom → BUY (a
share's SELL is a short sale). No entry while the line stays at 96%; it enters again only after a close below 96% and a
close back at it. No skip: an entry goes out whatever came before it. (At 0.95 this is v8's zone rule exactly, the rule
v33 to v38 mailed on these 1-hour charts, indicators.ts:140-145, docs §8.129.)

### 2.3 The price in; no target; no stop

- **A pair:** bar `n`'s **ask close for a BUY, bid close for a SELL**, from the same GMO 1-hour read the closes come
  from, as GMO gives them (not rounded). The function keeps that read's bid and ask bars already: `hourQuotes`
  (index.ts:965), set at :1333 from the read whose `historyRead` gives `closed` (:1334), just before `judge` (:1363).
  The fade takes the quote whose open is `n`'s, as v9 does (index.ts:1051), and prices it with `ridePaidAt`
  (indicators.ts:719: `fillSide`, BUY ask / SELL bid, track-outcomes/quotes.ts:99-102), as v9's email 1 does
  (index.ts:1103). **No new quote map** (the 15-minute form's `quarterQuotes` is not needed). This is the study's
  price: GMO's own 1-hour bar's bid and ask close ("On 1-hour bars", "Prices in").
- **Gold:** the closed bar's close (Twelve Data, one price, no bid or ask; as index.ts:1103).
- **A share:** the closed bar's close (Yahoo's last trade; as index.ts:1902).
- No target and no stop: the `signal_alerts` row has `stop` null and `target` null; no text states either price.

### 2.4 When each kind is read and judged (as v9 today)

- **Pairs:** the `1h` chart, read 0, 3 and 5 minutes after each hour (`gmoIntervalsDue`, indicators.ts:1212), from a
  second into the minute (`startWaitMs`, indicators.ts:1279-1283; index.ts:829-830), the bar expected being the one
  that closed at the hour (index.ts:1307, :1355-1357), never from a GMO answer made before the close (`staleForClose`,
  indicators.ts:1242-1251; index.ts:903). Judged once an instance (`judgedBar`, index.ts:442, :1155, :1316, :1359); a
  fresh instance judges it again. Fewer than 600 closed bars: `short`, not judged (index.ts:1338-1341). An entry is
  mailed only while its bar closed at most 30 minutes ago (`freshFor("1h")`, indicators.ts:330-331), which a read at
  minute 5 meets unless the run is late.
- **Gold:** Twelve Data's `1h` bars as the live chart keeps them (`live_chart_fallback`, index.ts:1220;
  `GOLD_ALERT_INTERVALS`, indicators.ts:225), looked at from a minute after each hour's close to 30 minutes after it
  (`twelveChartDue` → `twelveCloseDue`, indicators.ts:1289-1296, :1306-1311; index.ts:1178 says "gold each minute to
  :29"); Twelve Data itself read at most twice a close (`twelveReadDue`, :1332-1335) within the alerts' 780 a day
  (`ALERT_TWELVE_CAP`, :1343). Fresh 30 minutes.
- **Shares:** Yahoo's 1-hour bars (`yahooChartUrl(sym, "1h")`: `interval=60m&range=1y`, live-chart/stocks.ts:53,
  :64-67; index.ts:1940), read in the 30 minutes after each 1-hour session close (`CLOSES`, stocks.ts:116-119;
  `STOCK_POLL_MS`, :121; `stockCloseDue`, :127-136), at most once a minute (index.ts:1936); only the newest closed bar
  is judged at a read (`stockSweepOf`, stocks.ts:265-284). Fresh 45 minutes (`STOCK_FRESH_MS`, :123; `stockBarFresh`,
  :197-200): Yahoo's Tokyo prices come about 15 minutes late (stocks.ts:437, measured 2026-11-06), so a Tokyo share's
  bar is mailed about 15 minutes after its close. `CLOSES`, `stockBarEnd` (:141-146), `stockBarBreak` (:289-293) and
  the closing-point join (live-chart/stocks.ts:123-137, :158-162) are today's, unchanged.
- So the mail is judged and sent some minutes after the close (pairs at the reads 0, 3 or 5 minutes after it; gold
  from 1 to 30 minutes after it; a share at a read after it, a bar more than 45 minutes past its close not mailed;
  Tokyo shares about 15 minutes after it, measured 2026-11-06), at a price that may have moved since. How long the mail
  takes to arrive, and the price's move, are not measured; the mails say so (4.3 item 8, 4.4 item 8).
- **Never judged:** a pair's or gold's close whose reads all fall in the weekend gate, Friday 21:00 to Sunday 22:00 UTC
  (`isPossiblyClosed`, market-hours.ts:35-43; the sweep does not run, index.ts:833). The three reads (0, 3, 5 minutes)
  are all in the close's own hour, so a bar closing at or after Friday 21:00 and before Sunday 22:00 UTC is never
  judged: Friday's 21:00 close every week, Friday's 22:00 close in New York's winter, and any Sunday bar before 22:00
  the feed holds (today's weekend note says the same, ja:2152). The study reads the gate the same way (a read a second
  into minute 0, 3 or 5 after the close, research/macdfade15.ts:78-79) and counts such signals apart, `notMailed`, with
  no trade: they are not in its numbers. Also never judged: a pair whose newest closed bar is not in GMO's answer by
  minute 5, gold's bar not in Twelve Data after its two reads, a share's bar not seen closed by a read within its
  45 minutes, failed runs, a chart nobody follows. How often: not measured.

### 2.5 One email a bar and chart

- The decision is worked out again at each judging, from the closed bars alone (no table keeps it). Each follower gets
  it once: the claim key of `signal_alerts` (`user_id, kind, pair, interval, bar_time, side, rule`,
  supabase/migrations/20260925180000_signal_alert_rules.sql:32) and `mailRide`'s read of who already has a row
  (index.ts:776-799).
- **One side a bar.** `mailRide`'s read loses its `side` filter (index.ts:784): it reads the bar's rows under the new
  id whatever their side. A row of the other side there: nothing mailed, the record says `other_side` (the bar stays
  judged). Only a feed that changed the closed bars between two judgings can cause it.
- **Re-offers, as v9's close path:** a follower whose address lookup failed (no row is claimed, index.ts:640-643) is
  mailed when the bar is judged again: a pair at minute 3 or 5, gold at a later minute up to :29, each on a fresh
  instance or when the bar is unsettled. The lookup failure alone does not unsettle a pair's or gold's bar
  (index.ts:1174-1186). A share's bar is held judged only once no follower is left unsent, so the next run in its window
  tries again (index.ts:1931, :1976-1982).

## 3. The code

### 3.1 The shared pure function: `_shared/macd-fade.ts` (new)

Pure, no clock, no I/O; imports `macd`, `MACD_DEFAULTS` (macd.ts:8, :16) and `LEVEL_WINDOW`, `ZONE_BARS`, `zoneAt`
(macd-level.ts:105, :113, :199). Not macd-ride.ts.
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

`MACDH_INTERVALS = ["1h"]` stays (indicators.ts:270). `fadeAtClose` is called from `judge` where v9 calls
`rideAtClose` (index.ts:1160-1187): for a chart with `isMacdhChart(pair, interval)` and a `macdx` follower in this run
(`rideSubs`, `ridePairs`, index.ts:971-972, renamed), in its own try / catch, after the other rules' mails. With
`closed`, `newest`:
1. Not fresh (`age < 0` or over `freshFor("1h")`, as index.ts:1076-1081): nothing (`fade.fresh = false`).
2. `entry = fadeCloseEntryAt(closed.map((c) => c.close))`. None: nothing (`fade.entry = null`).
3. The price (2.3): a pair's from `hourQuotes` as index.ts:1051 and :1103; gold's the last close. Not finite:
   `fade.error = "no_price"`.
4. The signal (3.4), then `mailRide` (2.5) to the chart's `macdx` followers.
5. The bar is left unsettled (`judgedBar` deleted) only on `fade.error` (`no_price`, an exception).
Nothing is read or written each minute for this rule; no state row is written.

### 3.3 Shares: `stockFade` in place of `stockRide` (index.ts:1841-1932), on 1-hour bars as today

- Nothing of the shares' bars changes: `STOCKMACD_INTERVALS = ["1h"]` (stocks.ts:57), `yahooChartUrl(sym, "1h")`
  (index.ts:1940), `stockBarsOf` (stocks.ts:160-185), `CLOSES`, `stockBarEnd`, `stockBarBreak`, `stockCloseDue`,
  `stockSweepOf` (2.4) and the stock sweep's loop (index.ts:1933-1998). No fitting to a Yahoo answer is needed (the
  15-minute form's; its probe, .github/workflows/yahoo-probe15.yml, is not needed for this form).
- On a read whose newest closed bar is to be judged (`stockSweepOf`): fresh by `stockBarFresh`; `entry =
  fadeCloseEntryAt(closed.map((b) => b.close))`; the price `newest.close`; the signal; `mailRide` to the share's
  `stockmacd` followers. "Settled" only with no error and no follower left unsent (as v9, index.ts:1931).
  `stockRideClose` (stocks.ts:250-260) becomes `stockFadeClose(sym, closed, nowMs) → { fresh, entry }`, keeping its
  `isStockmacdChart(sym, "1h")` guard (:256).

### 3.4 The signal, the `signal_alerts` row, the run's record

- A new optional field `fade` on `IndicatorSignal` (`{ zside, m, top, bottom, share0, price }`) in place of `ride`;
  `sl` and `tps` null; `close` the bar's close as the chart draws it. `fadeSignal(rule, pair, interval, entry, {
  openMs, closeMs, close, price })` builds it.
- `signalRow` (indicators.ts:856-872): `entry` = `s.fade.price` (today :868 would take `s.close`, the mid); `stop` null;
  `target` null; `interval` `1h`; `bar_time` the bar's open; `closed_at` the bar's close (a share: `stockBarEnd`);
  `rule` the new id (`signalRuleId`, :215-216, gives `indicatorRuleId` for a signal with no `ride`); `event_id` null
  (as today, index.ts:661).
- The judged chart's record gains `fade: { fresh, entry, price, error?, other_side? }` in place of `ride`; its
  `signals` say `macdx:SELL` / `macdx:BUY` (shares `stockmacd:…`; `rideSignalTag`, indicators.ts:879-880, gives that
  for a signal with no `ride`) when a row was made in this run or was there. No user id, address or row id in the
  record or the log.
- `renderIndicatorMail`'s `macdx` branch (indicators.ts:1881) calls `renderFadeMail`.

### 3.5 What goes and what stays

**Goes:**
- index.ts: `rideAtClose` whole (rides read, state write and its 8-day delete, catch-up, entry, notice; :1001-1131);
  `rideMinute` and its block (:1612-1713); `stockRide` (:1841-1932); `readRides`, `rideKey`, `rideNow`, `openRide`,
  `reachRide`, `rideMailThere` (:694-812); `rideStateMemo`, `RIDE_STATE_MEMO_MAX`, `RIDE_STATE_KEEP_MS` (:451-454); the
  ride imports.
- indicators.ts: the ride ids (:163-169) and `rideRuleIdOf` / the ride branch of `signalRuleId` (:213-216); `RideFacts`;
  `rideCloseSignal`, `rideOutSignal` (:778-848); `MacdRide`, `MACD_RIDE_COLUMNS`, `macdRideOf`, `rideRowOf`;
  `rideLeaveAt`, `rideFormingOf`, `goldHourExtremes`, `RIDE_OUT_FRESH_MS`, `ridePnl` (:720-768, :887 on);
  `RIDE_MEASURED`, `rideMeasuredLine`, `renderRideMail` (:1610 on, :1664).
- stocks.ts: the ride ids (:66-69), `stockRidesReached` (:220-237), `stockRideClose` (:250-260, replaced),
  `stockRidePnl` (:299-304), the three ride mails (`renderStockMail` :326-488, rewritten). logic.ts: `rideHeldText`
  (:330, email 2 only).
- **The tests of the removed code**, with it (they import it or read its text, so `npm test` or `npx tsc --noEmit`,
  release preconditions, would fail). Line numbers read 2026-11-17:
  - src/test/macd-ride-alerts.test.ts whole (every block tests v9's ride; its imports :14-57; the checks of
    `ridePaidAt`, which stays, in its :265 block move to the fade's tests).
  - src/test/stockmacd-alerts.test.tsx: the #397 describes (:317-739 and :1045 to the end) go. In the #391 describes:
    the v9 ids (:84-98: `STOCKMACD_RIDE_VERSION` and the three ride ids, and `indicatorRuleId("stockmacd")` giving
    email 1's) are rewritten to the fade's id (3.7), the interval pins (:83, :99-103) staying; :189 is re-pointed to
    `stockFadeClose` and :190 (`stockRidesReached`) goes. The #397 `it` inside "#391 the shares' run and the database"
    (:758-776): :762-766 (`reachRide`, `rideOutSignal`, `sendRide(rideCloseSignal(…))`, `stockRide(…)`) go; its general
    lines are re-pointed to `stockFade` and kept (:767-768 the failure log without an address; :769-775 no state row,
    no minute read, no `z95of120`, no `decideZoneOnWindow`). The v9 names among the imports (:22-72) go with the
    blocks that used them (`_shared/macd-ride.ts` stays, so its names at :60-72 would still resolve; they go only as
    unused).
  - src/test/indicator-alerts.test.tsx: the imports `MACDH_AT_RULE_ID`, `MACDH_OUT_RULE_ID` (:21-22) and
    `rideCloseSignal` (:53); the ride's helpers (`toldRide`, `rideMailAt`, :1238-1259) and the v9 tests of the #345
    and #353 blocks that use them. Rewritten, not dropped: the id tests (:995-1004 pin v9's three ids and
    `indicatorRuleId("macdx")`; they pin the fade's id, and the set of distinct ids at :1000-1014 keeps v9's three
    as written strings, its size counted again); the ride's code-text lines (:1164-1167, `rideSubs` / `ridden` /
    `rideEntryAt` / `rideCloseStep`) become the fade's (3.2), :1168's freshness line staying if `fadeAtClose` keeps it
    word for word;
    **the two order guards are re-pointed to `fadeAtClose` and kept**: the MACD rule in its own try / catch after the
    other rules' mails (:1171-1173, 3.2) and the weekend return before it (:1185-1187, 2.4); :1454's check of
    `rideCloseSignal`'s body (`sl: null, tps: null` twice) becomes `fadeSignal`'s (once). The v39 pin at :1190 is one
    of 3.7's seven.
  In their place, 7.1's fade tests. src/test/macd-ride.test.ts stays (it tests main's macd-ride.ts, which stays).
- **The shelved v10 code:** already gone. 9bcfd70 put `_shared/macd-ride.ts`, `indicators.ts`, `stocks.ts`,
  `src/test/macd-ride.test.ts`, `research/macdride-replay.ts` and `.github/workflows/macdride.yml` back to origin/main's
  bytes and deleted `src/test/macd-ride-v10.test.ts` (the 15-minute spec's step 0). After the build no file under
  `supabase/functions/` imports `macd-ride.ts`; it stays as main's v9 file for the v9 morning-check bench
  (scripts/morning-check/bench/sim.ts), v9's replay, and a rollback.

**Stays:** the judging of closes and its timing (2.4); `hourQuotes`, `formingQuotes`, `goldMinutes` (the sharp rise
uses them, index.ts:1393-1399 and on); `mailerFor`, `claimRow`, `mailRide` (2.5); `ridePaidAt` (its side typed
`"BUY" | "SELL"`); `macdNumbers` (indicators.ts:1584); `rideSignalTag`; the tables `macd_rides` and `macd_ride_state`
(no longer written; v9's morning check and a rollback read them). Every `"1h"` written in the share functions that stay
(`stockBarsOf` :161, `stockSweepOf` :279) stays.

### 3.6 No schema migration; no subscription move

- `signal_alerts` already has `interval`, `bar_time`, `closed_at`, `side`, `entry`, `stop`, `target`, `rule`
  (supabase/migrations/20260925120000_signal_alerts.sql:35-48; `rule` is free text, no check on its values found by a
  grep of supabase/migrations) and the claim key with `rule` (20260925180000_signal_alert_rules.sql:32). No decision
  table (a close's decision is a pure function of closed bars), no index (`mailRide`'s read runs only at an entry), no
  state.
- **No subscription row moves (no DML).** The code follows, offers and accepts `macdx` and `stockmacd` on `'1h'` only,
  and the fade keeps that:
  - `isIndicatorChartFor` (indicators.ts:307-318) sends `'macdx'` to `isMacdhChart` (:275-277: the five pairs and gold,
    `MACDH_INTERVALS = ["1h"]`, :270-274) and `'stockmacd'` to `isStockmacdChart` (stocks.ts:58-60: the 22 shares,
    `STOCKMACD_INTERVALS = ["1h"]`, :57).
  - The runs read only the rows that pass them (index.ts:846-848 for the pairs and gold, :1816-1818 for the shares);
    the status call offers those intervals (`macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS }`, :2408;
    `stockmacd`, :2414); `set` and `set_many` accept only them (:2434, :2475).
  - The fade changes neither constant, so v40 reads, offers and accepts exactly the rows v39 does. A row of these rules
    on another interval, if any exists, is mailed by neither version. How many rows there are on which interval is not
    read here (production not read).
- **The screen** offers what the server says (`settings.indicator.macdx` / `.stockmacd`,
  src/components/SignalAlertSettings.tsx:220): the same `1h` column as today. No app change for that; the texts change
  (section 5).
- **The econ digest** goes to `macdx` followers on `isMacdhChart` (econ-calendar/mailer.ts:13, :90): unchanged. It is
  deployed again by name only for its footer (econ-calendar/digest.ts:423, :452; 4.1).
- The morning check v11 needs no DDL if each statement fits one call (7.3).

### 3.7 Ids and version

| | id | built |
|---|---|---|
| pairs and gold | `macdx_12_26_9_w600_1h_fade96of120_in_v11` | `fadeRuleId("macdx", MACDH_INTERVALS[0], 11)` (`MACDH_FADE_VERSION`) |
| shares | `stockmacd_12_26_9_w600_1h_fade96of120_in_v4` | `fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], 4)` (`STOCKMACD_FADE_VERSION`) |

- `fadeRuleId(prefix, interval, version)` = `` `${prefix}_${fast}_${slow}_${signal}_w${LEVEL_WINDOW}_${interval}_${FADE_TAG}_in_v${version}` ``,
  every part from a constant. `indicatorRuleId("macdx")` / `("stockmacd")` give them (indicators.ts:191-206).
- A `git grep` of the repository (2026-11-17, `(macdx|stockmacd)_12_26_9_w600_`) finds every earlier id: `macdx`
  `…_n288_k4_2_v1`, `…_1h_lv8.5p_v2`, `…_1h_k0.8mv_v3`, `…_1h_z90of120_v4`, `…_1h_x80of120_v5` (never put out),
  `…_1h_z95of120_v6`, `…_15min_z95of120_v7`, `…_1h_z95of120_v8`, `…_1h_ride90to96of120_{in,at,out}_v9`,
  `…_1h_touch90to95of120_{in,at,out}_v10` (shelved); `stockmacd` `…_1h_z95of120_v1`,
  `…_1h_ride90to96of120_{in,at,out}_v2`, `…_1h_ride90to95of120_{in,at,out}_v3` (shelved); and never-built fade ids:
  `macdx_…_1h_fade96tp10of120_in_v11` (research/macdfade96-spec.md:413), `macdx_…_15min_fade96of120_in_v11` and
  `stockmacd_…_15min_fade96of120_in_v4` (research/macdfade15-prod-spec.md:261-262), and
  `stockmacd_…_1h_fade96of120_in_v4` (research/macdfade96-spec.md:61, :414).
- **The pairs' id** differs from every one of them.
- **The shares' id equals research/macdfade96-spec.md's share id, string for string.** That spec's share rule
  (section 3, :353-366) is this rule: at a share's closed 1-hour bar, on the 600 closes ending at it, `Z(n)` at 0.96
  and `Zp(n)` not, fade side, the close as the price, no target, no stop. It was never built (its head, :3-4: "not to
  be built"), and no code under `supabase/` or `src/` holds a fade rule id today (`git grep -i fade` there finds only
  CSS animation names and comment words).
  So the string names one rule only, and no production code ever wrote it. Production's `signal_alerts` was not read
  (by rule), so "no row carries it" rests on the code, not on the table. The two specs differ only in how a share's
  decision is kept (that spec claimed it in a moment table, `macd_fade_moments`; this one works it out again at each
  judging, 2.5), not in the rule.
- v11 / v4 reuse only the numbers of never-written ids, so no id names two rules.
- Checked in node with copies of the app's regexes: neither matches `RIDE_ID` (src/lib/signalAlerts.ts:48); both match
  the proposed `FADE_ID` (pct 96) and go to the `macdx` / `stockmacd` tab (`ruleOfId`, :33-37); `fadeRuleId` as above
  rebuilds both strings.
- `FUNCTION_VERSION` (index.ts:364) → `"signal-alerts-v40-<the deploy's date>"`, a v40 note in the header; the seven
  test files pinning `signal-alerts-v39` change (amdpo3-alerts, emarm-alerts, indicator-alerts, macd-ride-alerts,
  spike-alerts, stockmacd-alerts, sweepx-alerts).

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
- No text asserts that a price recovers: research/macdfade96-spec.md 6.1's two guard patterns run over every mail
  variant, the notes, the plan line and the sales page texts, in both languages, and find nothing.
- A count reaching +10 never appears without the fields of 4.5; a test checks them.
- The name 「MACD の逆張り」 / "MACD fade". The pairs' and gold's mails' how-to-stop line (today's indicators.ts:1755 /
  en :1692) names the tab 「MACD の逆張り」（画面が新しくなる前は「MACD の流れ」） / "MACD fade (MACD ride until the screen
  is updated)" until the later small PR of 6.3 step 7. The shares' mail keeps 「株の MACD」 / "Stock MACD" (stocks.ts:442
  / en :379): that tab keeps its name.
- **The econ digest's footer** (econ-calendar/digest.ts:423 / :452) names the rule twice; both change, word for word
  (only the parts shown change; the rest of each line is today's):
  - ja: 「このメールは、売買のメール（MACD の逆張り）を受け取っている方に、日本時間の平日の朝に1通送っています。」 and
    「止めるには、アプリの「設定」→「メール通知」で「MACD の逆張り」（画面が新しくなる前は「MACD の流れ」）のチェックを
    外してください（売買のメールも止まります）。」
  - en: "This email goes to those who receive the trade emails (MACD fade), once each weekday morning in Japan." and
    "There is no switch for this email alone yet: unticking \"MACD fade\" (\"MACD ride\" until the screen is updated)
    under Settings → Email alerts stops it, and the trade emails too."
  - src/test/econ-digest.test.ts:284-285 pin these instead of today's two, in the function's PR (6.3 step 3, which
    changes the footer); its `not.toContain("1時間足")` stays.

### 4.2 Subjects

- Pairs and gold: 「【Sextant】ドル/円 1時間足 売り（SELL）: 青い線が上の端の96%で確定（MACD の逆張り）」 (bottom: 「買い
  （BUY）: 青い線が下の端の96%で確定」); en "[Sextant] USD/JPY 1-hour SELL: the MACD line closed at 96% of the top (MACD
  fade)". The timeframe from `tfLabel` (logic.ts:316-322: 「1時間足」 / "1-hour").
- Shares: 「【Sextant】〔name〕（〔code〕）1時間足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）」; en
  "[Sextant] 〔name〕 (〔code〕) 1-hour SELL (short sale): the MACD line closed at 96% of the top (Stock MACD)" (the
  tab's name as today's share mails write it, stocks.ts:379, :411).

### 4.3 The pairs' and gold's email (`renderFadeMail`)

1. 「〔pair〕の1時間足で、MACD の逆張りの売り（SELL）の合図が出ました。」
2. 「判定した足: 〔close, JST〕（日本時間）に確定した1時間足」
3. 「この足の終わりで、青い線（MACD）が、新しい120本（1時間足）の MACD の枠の上の端（青い線・オレンジの線・棒の一番高い
   所）の96%以上（0の線から測って）でした。一つ前の足の終わりでは、96%に届いていませんでした。上の端なので、逆張りの
   売り（SELL）の合図です。」 (bottom: 下の端・一番低い所・買い（BUY）).
4. 「MACD = 〔m〕、枠の上の端 = 〔top〕（その96% = 〔0.96 × top〕）」 (`macdNumbers`).
5. A pair: 「売値（この足の終値の売値）: 〔price〕」 (BUY: 買値). Gold: 「この足の終値: 〔price〕（売値・買値の別はありません）」.
6. 「利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。」
7. 「メールはこの1通だけです。このあと、この合図について知らせは送りません。同じチャート・同じ向きに前の合図があって
   も、次の合図は送ります。」
8. A pair: 「このメールは、足の確定の直後・3分後・5分後の読み込みで判定して送ります（実際に何分で届くかは測っていませ
   ん）。」 Gold: 「このメールは、足の確定の1分後から30分後までの間に判定して送ります（実際に何分で届くかは測っていませ
   ん）。」 Then both: 「届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。週末の止まっている時間
   （日本時間 土曜6:00〜月曜7:00）に確定した足は判定しません。」 (The reads: `gmoIntervalsDue`, indicators.ts:1212;
   gold's window: `twelveCloseDue`, :1289-1296. Neither says how long the mail takes; today's note says the same,
   ja:2138 「実際に何秒で届くかは、まだ確かめていません」.)
9. Pairs: the measured paragraph (4.5). Gold instead: 「金では測っていません（足は Twelve Data のもので、売値・買値の別は
   ありません）。5ペアで測った数字は、アプリの設定の注にあります。」 No number.
10. 「この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・メール
    を1時間足で判定すること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の
    枠（新しい120本）は、アプリの1時間足のチャートの枠と同じです。」 (Only what the owner said is the owner's; the pane is
    stated as a fact of the rule, not as the owner's choice: section 1.)
11. As today: the source line, the app link, how to stop (4.1), the disclaimer. A pair's source line changes, as
    today's (indicators.ts:1754, 「価格は GMOコインの公開レート（買値と売値の中間）で…」) would call item 5's bid or ask
    the mid: 「足は GMOコインの公開レート（買値と売値の中間）で、アプリのチャートと同じです。上の値段は、同じ1時間足の
    売値・買値の終値です。」 Gold's stays (:1753).

en, item by item:
1. "A MACD fade SELL signal on 〔pair〕's 1-hour chart." (BUY likewise.)
2. "Bar judged: the 1-hour bar that closed at 〔close, UTC〕 UTC (〔close, JST〕 JST)"
3. "At this bar's close the MACD line (blue) was at 96% or more of the top of the MACD pane of the newest 120 bars
   (1-hour) (the highest of the blue line, the orange line and the bars), measured from the zero line. At the close of
   the bar before, it was below 96%. It is the top, so this is a fade SELL signal." (bottom: "of the bottom", "the
   lowest", "a fade BUY signal").
4. "MACD = 〔m〕, the pane's top = 〔top〕 (96% of it = 〔0.96 × top〕)" (bottom: "the pane's bottom").
5. A pair: "Bid at this bar's close: 〔price〕" (BUY: "Ask at this bar's close"). Gold: "This bar's close: 〔price〕 (no
   separate bid and ask)".
6. "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a
   stop."
7. "This is the only email: nothing more is sent about this signal. A later signal on the same chart and side is sent
   too, whatever came before it."
8. A pair: "This email is judged and sent at the reads right after the bar closes and 3 and 5 minutes after (how long
   it takes to arrive has not been measured)." Gold: "This email is judged and sent between 1 and 30 minutes after the
   bar closes (how long it takes to arrive has not been measured)." Then both: "The price when it arrives may differ
   from the close above (the difference has not been measured). Bars that close in the weekend pause (Friday 21:00 to
   Sunday 22:00 UTC) are not judged."
9. Pairs: the measured paragraph (4.5, en). Gold instead: "Not measured on gold (its bars are Twelve Data's, with no
   separate bid and ask). The numbers measured on the five pairs are in the app's settings notes." No number.
10. "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging the email on
    1-hour bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the
    newest 120 bars) is the same as the app's 1-hour chart's."
11. As today's en: the source line, the app link, how to stop (4.1), the disclaimer. A pair's source line: "The bars
    are the mid of GMO Coin's public bid and ask, as the app's chart draws them; the price above is the same 1-hour bar's
    bid or ask close." (today's :1691). Gold's stays (indicators.ts:1690).

### 4.4 The shares' email (`renderStockMail` rewritten)

In this order, ja / en (〔market〕 as today's share mail names it: 東証 / 米国, en Tokyo / US, stocks.ts:428 / :365):
1. 「〔name〕（〔code〕、〔market〕）の1時間足で、MACD の逆張りの売り（SELL）の合図が出ました。株の売りは空売りです。」 /
   "A MACD fade SELL signal on 〔name〕 (〔code〕, 〔market〕), 1-hour chart. A SELL on a share is a short sale." (BUY:
   without the short-sale sentence.)
2. 「判定した足: 〔end, JST〕（日本時間）に確定した1時間足」 / "Bar judged: the 1-hour bar that closed at 〔end, UTC〕 UTC
   (〔end, JST〕 JST)" (the end is `stockBarEnd`).
3. and 4. As 4.3 items 3 and 4, ja and en.
5. 「この足の終値: 〔close〕」 / "This bar's close: 〔close〕". On a session's last bar or Tokyo's bar before lunch
   (`stockBarBreak`), then: 「この足の終値では、次に市場が開くまで売買できません。」 / "At this bar's close nothing can be
   traded until the market opens again."
6. and 7. As 4.3 items 6 and 7, ja and en.
8. The timing, a share's own (not 4.3 item 8, whose reads are the pairs' and gold's and whose weekend sentence is about
   them): a US share 「このメールは、足の確定の後の読み込みで判定して送ります（確定から45分を過ぎた足は送りません。実際に
   何分で届くかは測っていません）。」 / "This email is judged and sent at a read after the bar closes (a bar more than 45
   minutes past its close is not sent; how long it takes to arrive has not been measured)." (`stockCloseDue`,
   `STOCK_FRESH_MS`, stocks.ts:121-136; today's share mail states no delay for a US share); a Tokyo share only today's
   delay sentence (stocks.ts:437 / en :374: 「東証の値段は Yahoo では約15分遅れて届く
   ため、このメールは足が確定してから約15分後に送っています（2026-11-06 に測りました）。」 / "Yahoo's Tokyo prices come
   about 15 minutes late, so this email is sent about 15 minutes after the bar closed (measured on 2026-11-06)."); then,
   every share, 「届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。」 / "The price when it
   arrives may differ from the close above (the difference has not been measured)."
9. 「株では測っていません。」 / "Not measured on shares." No numbers.
10. 「この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・逆張り
    の向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。株は1時間足で
    判定し、MACD の枠（新しい120本）は、アプリの1時間足のチャートの枠と同じです。」 / "This rule is Sextant's own, not a
    published indicator. 96%, judging at the bar's close, the fade side (shares included) and stating no take-profit or
    stop price are the app owner's choices. Shares are judged on 1-hour bars, and the MACD pane (the newest 120 bars) is
    the same as the app's 1-hour chart's." (The shares' 1-hour bars and the pane are stated as facts of the rule, not as
    the owner's choices: section 1.)
11. As today's share mail: the Yahoo source line (stocks.ts:431 / en :368), the app link, how to stop under 「株の MACD」 /
    "Stock MACD" and the disclaimer (stocks.ts:442 / en :379).

### 4.5 The measured paragraph (pairs only; `FADE_MEASURED`, `fadeMeasuredLine`)

The numbers are the study's real `TF=1h` run: Actions run 44099401423 on 53f7003, recorded in research/macdfade15-spec.md
"Result of the real 1-hour run" (d96bf56): the Python agreed with every row and number, `closeVsMinute` differs in no
bar on any pair (the study's own stop passed), summary.json sha256 `60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2`
(research/macdfade15-spec.md "Files" and "On 1-hour bars" give its form). They are filled below
from research/ledger/macdfade1h-summary.json (route 1). The 15-minute run's numbers (research/macdfade15-spec.md, run
44077464383) are not these.

**How the numbers get into the code (route 1 was taken, 2026-11-17).** The artifact of
that run was not downloaded (the development container's proxy refused the artifact host on the 15-minute run, and the
1-hour run's numbers were copied from the job's printed lines), and the workflow prints summary.json only as a sha256
(.github/workflows/macdfade15.yml:254-260). So:
1. **The file (taken).** The real job of .github/workflows/macdfade15.yml gained a last step, "summary.json whole
   (base64, one line)", that prints the file's sha256 and size and the whole file as one base64 line (d120a30; base64
   so that no whitespace of the log can change a byte). Pushed without `[skip ci]`, it ran the study again: Actions run
   44108923903, TF `1h`, the defaults, GMO's files from the caches; it printed the same sha256 as run 44099401423 for rows.csv
   (`9bd958cc40bab89ddbf6bef15d4c40bba578c86e0c5fcd52f1a0d21ed38605e9`), summary.json (`60edab22…a9e2`, 16,630 bytes),
   null.json and the run a week earlier. The base64 line was taken
   from that job's log and decoded in the development container into research/ledger/macdfade1h-summary.json: 16,630
   bytes, sha256 `60edab22302e5fe755c70b38f87b8b28fa27389ccc1bb10c1a0c0c88c448a9e2`, the same. `FADE_MEASURED` is
   written from that copy, and a test reads the copy and pins every value of `FADE_MEASURED` to it, `meta.tf` `"1h"`,
   `meta.share` 0.96 and `meta.tp` 10 included.
2. **Not used** (route 1 worked): `FADE_MEASURED` would have been pinned to the printed lines of run 44099401423,
   copied whole from its job log into research/ledger/macdfade1h-print.txt and checked against
   research/macdfade15-spec.md's 1-hour result section; the values are then as printed (a mean to 2 decimals, a sum,
   the worst and the largest loss on the way to 1, minutes whole: `fmt`, research/macdfade15.ts:550-561), and the test
   pins `FADE_MEASURED` to that file. The printed lines carry every slot below (`meta`, each `pair` line, each group's
   lines and the side-by-side lines, :566-591).
docs §8 records the run ids, the summary.json sha256, and that route 1 was taken.

| slot | summary.json | value (from research/ledger/macdfade1h-summary.json, written as below) |
|---|---|---|
| 〔from〕, 〔to〕 | `meta.start`, `meta.end` (the entries' closes in [start, end): `from` included, `to` not; open trades valued at the last minute loaded), each written in UTC: ja 「2024年1月1日 0:00（UTC）」, en "1 January 2024, 00:00 UTC" (the minutes always written) | `2024-01-01T00:00:00Z`, `2026-11-10T21:00:00Z`: ja 「2024年1月1日 0:00（UTC）」, 「2026年11月10日 21:00（UTC）」; en "1 January 2024, 00:00 UTC", "10 November 2026, 21:00 UTC" |
| 〔trades〕, 〔tp〕, 〔open〕 | `dirs.fade.all.trades`, `.tp`, `.open` | 1490, 1468, 22 (written 1,490 / 1,468 / 22) |
| 〔mean〕 | `dirs.fade.all.pipsMean` (open trades at their unrealised pips) | 3.261140939597316: +3.26 |
| 〔maeMedian〕, 〔maeMax〕 | `dirs.fade.all.maeMedian`, `.maeMax` | 10.7, 2243.6 (written 2,243.6) |
| 〔tpMedian〕, 〔tpP90〕, 〔tpMax〕 | `dirs.fade.all.tpMinutesMedian`, `.tpMinutesP90`, `.tpMinutesMax` | 140, 4489, 687037 minutes: ja 「約2時間」「約3日」「約477日」, en "about 2 hours", "about 3 days", "about 477 days" |
| 〔openPipsSum〕, 〔openPipsWorst〕, 〔openLongest〕 | `dirs.fade.all.openPipsSum`, `.openPipsWorst`, `.openMinutesMax` | −9820.9 (−9,820.900000000003 as stored), −1733.2, 888900 minutes: −9,820.9, −1,733.2, ja 「約617日」, en "about 617 days" |
| 〔flowMean〕 | `dirs.flow.all.pipsMean` | −2.080939597315436: −2.08 |
| 〔baseMean〕 | `base.all.pipsMean` | 3.201605378704711: +3.20 |
| 〔pairMean〕, 〔pairBaseMean〕 | `dirs.fade.<pair>.pipsMean`, `base.<pair>.pipsMean`, each of the five | USD/JPY −0.26 (+5.74), EUR/JPY +4.30 (+3.28), AUD/JPY +4.44 (−0.77), EUR/USD +3.11 (+2.60), AUD/USD +4.42 (+5.16) |
| 〔negPairs〕 | every pair whose fade mean is below zero, in the pairs' order, each with its mean: ja 「ドル/円（〔its mean〕 pips）」 joined by 「・」, en "USD/JPY (〔its mean〕 pips)" joined by ", "; with none, ja 「ありません」, en "none" | ja 「ドル/円（-0.26 pips）」, en "USD/JPY (-0.26 pips)" |
| 〔notMailed〕 | the sum of `pairs[].notMailed` | 11 (USD/JPY 2, EUR/JPY 0, AUD/JPY 2, EUR/USD 3, AUD/USD 4) |
| 〔sec〕 | the docs §8 section that records the run | 8.155 (the next section of docs/OPERATIONS.md, whose last is §8.154; written at the release, 6.3) |

The values were written out by a script reading the ledger copy (not copied by hand), and they equal the numbers the
job printed (research/macdfade15-spec.md's 1-hour result). A minus is written as the code writes it (`toFixed`:
"-0.26"); the "−" in this table is only this file's typography. Thousands separators: the code writes none unless 4.3's
builder adds them with one rule for ja and en; either way a test pins the mail as built.

- Durations written in minutes under 2 hours, hours under 2 days, days beyond, to the nearest whole unit, with 「約」 /
  "about" before one that was rounded. Pips as the study prints them (a mean to 2 decimals; a sum, the worst and the
  largest loss on the way to 1; research/macdfade15.ts:550-561), a mean, a sum and the worst with their sign.
  〔openPipsSum〕 is the open trades' net unrealised result (an open trade is only short of +10, so it can be in profit)
  and 〔openPipsWorst〕 their lowest; the text says a minus is a loss.
- 〔baseWhat〕 「このメールが判定する1時間足ごとの最初の1分に（買いと売りを1回ずつ）」 / "at the first minute of every
  1-hour bar this email judges (a BUY and a SELL)": the study's baseline takes only the bars that are judged and mailed
  (in range, 600 bars, `Z` and `Zp` read, outside the weekend gate: `baseBar`, research/macdfade15.ts:342-345;
  research/macdfade15-spec.md "The same trade with no signal" and :331-332), about 59 minutes before a signal at the
  same bar would be, so the same holding with no signal, not the same entry; the parenthesis after 〔baseMean〕 says so.
- **Variants fixed here, so the text never prints a null or a vacuous clause** (the study writes `openPipsSum` null and
  `openPipsWorst` / `openMinutesMax` null with no open trade, research/macdfade15.ts:507-510, and the tp times null with
  no tp trade):
  - 〔open〕 = 0: ja 「〔open〕回は〔to〕の時点でまだ届いておらず、…持ったままでした（その後は追っていません）。」 becomes
    「〔to〕の時点でまだ届いていないものはありませんでした。」 and 「（届いていないものは、その時の含み損益で数えました）」
    goes; en "〔open〕 had not reached it by 〔to〕; … (not followed after that)." becomes "None was still short of it by
    〔to〕." and "(those not reached counted at their unrealised result then)" goes.
  - 〔tp〕 = 0: ja 「+10 pips に届くまでの時間は…でした。」 becomes 「+10 pips に届いたものはありませんでした。」; en "Time to
    +10 pips: … longest 〔tpMax〕." becomes "None reached +10 pips."
  - 〔trades〕 = 0: the paragraph is not built; the build stops (a run with no fade trade is not used).

ja: 「測った数字（5ペア、〔from〕以後、〔to〕より前に確定した1時間足、スプレッド込み、docs §〔sec〕）。過去の GMO の
足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。このメールの決まりで足の
終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていま
せん）: 合図は〔trades〕回、うち〔tp〕回が+10 pips に届きました。〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は
合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕
持ったままでした（その後は追っていません）。1回あたり平均〔mean〕 pips（届いていないものは、その時の含み損益で数えまし
た）。途中の含み損は中央値〔maeMedian〕 pips、最大〔maeMax〕 pips。+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に
1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。足の終値で入るので指値ではなく、入らなかった注文はありません
（メールした合図はすべて入ったとして数えました）。損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。同じ
合図で逆向き（上で買い・下で売り）に入ると1回あたり〔flowMean〕 pips、合図なしで〔baseWhat〕入ると〔baseMean〕 pips でした
（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく1時間足の最初の1分に入ったもので、同じ
入りではありません）。〔chance〕〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは
〔pairBaseMean〕 pips）です。平均がマイナスだったペア: 〔negPairs〕。ほかに〔notMailed〕回、週末の止まっている時間に確定
した足に合図がありましたが、このメールでは判定しないので、上の数字に入れていません。」

en: "Measured (five pairs, 1-hour bars that closed from 〔from〕 up to, not including, 〔to〕, spread paid, docs
§〔sec〕). It re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured). Entered by this
email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this
email states no take-profit price): 〔trades〕 signals, of which 〔tp〕 reached +10 pips. 〔open〕 had not reached it by
〔to〕; their unrealised result was 〔openPipsSum〕 pips in all (a minus is a loss), the worst 〔openPipsWorst〕 pips, the
longest held 〔openLongest〕 (not followed after that). The mean was 〔mean〕 pips a trade (those not reached counted at
their unrealised result then). The largest loss on the way: median 〔maeMedian〕 pips, largest 〔maeMax〕 pips. Time to
+10 pips: median 〔tpMedian〕, longer than 〔tpP90〕 one time in ten, longest 〔tpMax〕. The entry is at the bar's close,
not a limit order, so no order went unfilled (every signal emailed is counted as entered). With no stop, the share
reaching +10 pips comes out high by construction. Entering the other way on the same signals (a BUY at the top, a SELL
at the bottom) gave 〔flowMean〕 pips a trade, and entering with no signal 〔baseWhat〕 gave 〔baseMean〕 pips (held the
same way, +10 pips and no stop, but entered at the 1-hour bar's first minute, not at its close, so not the same entry).
〔chance〕 On 〔pair〕 alone the mean was 〔pairMean〕 pips (with
no signal, 〔pairBaseMean〕 pips). Pairs whose mean was below zero: 〔negPairs〕. Besides these, 〔notMailed〕
signals fell on bars that closed in the weekend pause; this email does not judge those bars, so they are not in the
numbers above."

**The notes' version** (section 5, `macdxNotes`; one paragraph shared by the five pairs and gold, so no 〔pair〕 and no
「このメール」). The paragraph above, ja and en, with these changes only (the 〔open〕 / 〔tp〕 variants as above):
- ja 「このメールの決まりで」 → 「メールの決まりで」; 「このメールでは判定しないので」 → 「メールでは判定しないので」
  (「メールの読み込みが失敗した時」 and 「メールには利確の値段を書いていません」 stay as they are).
- en "times this email's reads failed" → "times the email's reads failed"; "Entered by this email's rule" → "Entered by
  the email's rule"; "this email states no take-profit price" → "the email states no take-profit price"; "this email
  does not judge those bars" → "the email does not judge those bars".
- The 〔pair〕 sentence (ja 「〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。」, en "On 〔pair〕
  alone the mean was 〔pairMean〕 pips (with no signal, 〔pairBaseMean〕 pips).") becomes all five, in the pairs' order:
  ja 「ペアごとの1回あたりの平均は、ドル/円〔USD/JPY's pairMean〕 pips（合図なしでは〔its pairBaseMean〕 pips）・ユーロ/円
  〔…〕 pips（〔…〕 pips）・豪ドル/円〔…〕 pips（〔…〕 pips）・ユーロ/ドル〔…〕 pips（〔…〕 pips）・豪ドル/ドル〔…〕 pips
  （〔…〕 pips）でした。」; en "The mean a trade by pair: USD/JPY 〔USD/JPY's pairMean〕 pips (with no signal, 〔its
  pairBaseMean〕 pips), EUR/JPY 〔…〕 pips (〔…〕 pips), AUD/JPY 〔…〕 pips (〔…〕 pips), EUR/USD 〔…〕 pips (〔…〕 pips),
  AUD/USD 〔…〕 pips (〔…〕 pips)." (the values of 4.5's table, 〔pairMean〕 and 〔pairBaseMean〕.)
A test pins the notes' version word for word, apart from the mails' version.

- 〔chance〕 (in the mails' and the notes' paragraph): the study prints fade − base and fade − flow beside the same gaps
  on ten driftless walks (research/macdfade15-spec.md "How it is measured"; run 44099401423, and 44108923903 printed the
  same null.json sha256 `3d285440123d50ac776228092b1a2560db12ff1d114b97bbec676350175b9b96`): fade − base +0.06 pips a trade
  inside the walks' −4.10..+0.83, fade − flow +5.34 inside −5.42..+5.81 (`all`). Both inside, so the sentence is: ja
  「合図なしとの差も、逆向きとの差も、値動きに傾きのない作り物の値段10本で同じように測った差の幅の中でした（偶然で出る幅
  の中なので、どちらより良いとも言えません。作り物の値段は GMO のものではなく、10本で分かるのは幅だけで、確かめ〈検定〉
  ではありません）。」 en "The differences from no signal and from the other way were both within the range of the same
  differences measured on ten made-up price walks with no trend (a range chance alone gives, so it is not shown to do
  better than either; the walks' prices are not GMO's, and ten walks give a range, not a test)." (Had either been
  outside, the sentence would have said which, and that ten walks still put about 2 gaps in 11 outside by chance; it is
  not needed for these numbers.) The walks' ranges are not in summary.json: the test pins this sentence word for word,
  and docs §8 records the ranges with null.json's sha256.

The numbers being in, every sentence of sections 4 and 5 was read against them (2026-11-17): none says the fade did
better than no signal or than the other way; the measured paragraph's 〔open〕 and 〔tp〕 are both above 0, so its full
form is used; the sales page's 〔adverse〕 is chosen in section 5.

## 5. The screen and the sales page

- **Id parse** (src/lib/signalAlerts.ts): beside `RIDE_ID` (:48), `FADE_ID =
  /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/` fills a new `AlertRow` field `fade: { pct: number } |
  null`. `RIDE_ID` stays: v9 rows read as today, v8 and older as 「前の決まり」.
- **Tag** (`rowLabel`, SignalAlertSettings.tsx:110-127; a fade branch before the earlier-rule one at :125): the side
  in side colour; a pair's or gold's fade row 「（MACD の逆張り）」 / " (MACD fade)" (new `ruleTagFade.macdx`); a share's
  fade row 「（株の MACD・逆張り）」 / " (Stock MACD fade)" (new `ruleTagFade.stockmacd`), so it does not read like a v9
  share email-1 row, which falls to `ruleTag.stockmacd` 「（株の MACD）」 (ja:2110 / en:2005; :124-126) with the side the
  other way round. `ruleTag.macdx` 「（MACD の流れ）」 and `ruleTag.stockmacd` stay for v9 rows.
- **Plan line** of a fade row: 「入り 〔entry〕 / 利確・損切りなし」 / "In 〔entry〕 / no take profit, no stop" (new `fadePlan`;
  today's `plan` shows only with a stop, :411-413). The time column shows `closed_at`, the bar's close. The row's
  timeframe reads 「1時間足」 from its `interval`.
- **Tab name** `ruleTabs.macdx` (ja:2101 / en:1996): 「MACD の逆張り」 / "MACD fade". The grid's column stays `1h` (3.6).
- **Notes and intros** rewritten (ja and en, the same keys and array lengths, src/test/i18n.test.ts:36-39): the card
  intro (ja:2090, 2092 / en:1987, 1988), `indicatorIntro.macdx` (ja:2118; `indicatorIntro` ja:2115 / en:2010),
  `macdxNotes` (ja:2137-2154 / en:2032-2049), `indicatorIntro.stockmacd` (ja:2127), `stockmacdNotes` (ja:2190-2198 /
  en:2085 on; ja:2193's list of 1-hour closes stays as it is), the MACD indicator note (ja:557 / en:514), the FAQ's chart
  list (ja:2035 / en:1932) and 「メールはいつ届きますか？」 (ja:2037 / en:1934; v9's email-2 parenthesis goes, 「MACD の
  流れ」 becomes 「MACD の逆張り」). They say: 96% at a 1-hour close with the bar before not at 96% (one email a bar; none
  more while the line stays); the 120-bar pane of the 1-hour chart; the fade side; the price; no take-profit and no stop
  price (how the rule is built, not advice), whose choices these are, attributed as 4.3 item 10 does (the pane and the
  shares' 1-hour bars as facts, not as the owner's); one email, no skip; when closes are judged (pairs at the reads 0, 3
  and 5 minutes after the hour, gold from 1 to 30 minutes after, a share at a read after its close, Tokyo's about 15
  minutes after) and that how long the mail takes to arrive is not measured; the weekend gate; that whether a trade
  reached +10 is not recorded or shown; the measured paragraph's notes' version (4.5) in the pairs' notes;
  「金では測っていません」 / 「株では測っていません」 with no numbers. Every sentence on 90%, email 2, the notice, the minute check and v9's numbers
  goes. `rideOut`, `rideAt`, `ridePrices` stay for v9 rows.
  `macdxNotes` item by item (ja:2138-2153 / en:2033-2048, the same order):
  - **Stay** (already on 1-hour bars; changed only where said): gold's Twelve Data notes (ja:2139, 2140; ja:2139's
    「確定から30分」 is `freshFor("1h")`); the zoom note (ja:2146); the pane-margin note (ja:2147) and the unrounded
    note (ja:2148), naming 96% only (the pane-margin note's last sentence, on email 2's forming pane and email 1's closed one, becomes
    「メールは、確定した足までの新しい120本で決めます。」); the ULTRA note (ja:2150); the weekend note (ja:2152, its bar
    counts already the 1-hour ones) and gold's break note (ja:2153).
  - **Rewritten**: ja:2138 (the charts, and when closes are judged: pairs 0, 3 and 5 minutes after the hour, gold from a
    minute after the close; its 「2通目は毎分見ています」 goes), ja:2141 (the rule of 2.1-2.2 and the fade side), ja:2151
    (no take-profit and no stop price, how the rule is built and not advice; nothing recorded).
  - **Go**: ja:2142-2145 (the notice, email 2, the catch-up, the band) and ja:2149 (v9's numbers), in their place the
    measured paragraph's notes' version (4.5) and 「金では測っていません」 (the array keeps ja and en the same length).
- **Sales page** (no percent and no measured number, src/test/landing.test.tsx:51-58; the FAQ's forbidden pattern,
  signal-alert-settings.test.tsx:492). Word for word below, ja and en. The MACD fade is named first, with the reason it is
  left out of the break-even comparison (with no stop it has no break-even win rate), before the sentence on the other
  signals, so no clause can be read as the fade having reached it. 「…良いとは示せていません」 holds whatever the numbers
  (no test of chance is run). Today's FAQ states one adverse measured fact of the MACD rule (ja:2033 「届いた取引は、
  損失で終わったものの方が、利益で終わったものより多くありました」, pinned at signal-alert-settings.test.tsx:489-490);
  the fade's texts keep that practice through 〔adverse〕, chosen once the numbers are in (below). A test pins each text
  with the 〔adverse〕 chosen.
  - `lp.faqs` 「勝率はどのくらいですか？」 (ja:2033): 「MACD の逆張りは、損切りをしない決まりで、損益ゼロに必要な勝率という
    ものがないため、勝率では比べません。それ以外の、過去のチャート（スプレッド込み）で測ったサインは、どれも損益ゼロに
    必要な勝率に届いていません。数字はアプリ内の説明に載せています。MACD の逆張り（1時間足）は、5ペアで測った数字が設定の
    注にあります。損切りをしないので、含み損のまま残る取引が出ることがあり、合図なしで入った時より良いとは示せていません。
    〔adverse〕損切りをしないのはこの決まりの作りで、損切りをしないことを勧めるものではありません。金・株と、流動性狩り＋
    EMAクロスは、まだ測っていません。勝てる根拠として使わないでください。」 en (:1930): "The MACD fade has no stop by
    design, so it has no break-even win rate and is not compared by one. Of the other signals measured on past charts
    (spread paid), none reached the win rate needed to break even. The numbers are in the app's notes. The MACD fade
    (1-hour) has its own numbers, measured on the five pairs only, in the settings' notes. With no stop, some trades can
    stay open at an unrealised loss, and it has not been shown to do better than entering with no signal. 〔adverse〕Having
    no stop is how this rule is built; it is not advice to hold without a stop. Gold, stocks and the liquidity sweep +
    EMA cross have not been measured. Please do not take them as a reason to expect to win."
  - `lp.honestBody` (ja:2028): 「MACD の逆張り（5ペアで測定）は、損切りをしない決まりで、損益ゼロに必要な勝率がないため、
    勝率では比べません。それ以外のアプリのサインは、過去のチャート（11通貨ペア・スプレッド込み）での検証で、どれも損益
    ゼロに必要な勝率に届いていません。MACD の逆張りは、損切りをしないので、含み損のまま残る取引が出ることがあり、合図
    なしで入った時より良いとは示せていません。〔adverse〕サインは注文の指示ではなく、判断の材料です。通知したサインの実際の
    成績は、成績を記録している決まりについて、件数とともにアプリ内にそのまま表示します。MACD の逆張りの成績は、記録も表示
    もしていません。」 en (:1925): "The MACD fade (measured on five pairs) has no stop by design, so it has no break-even
    win rate and is not compared by one. Of the app's other signals, none reached the win rate needed to break even on
    past charts (11 pairs, spread paid). With no stop, some MACD fade trades can stay open at an unrealised loss, and it
    has not been shown to do better than entering with no signal. 〔adverse〕A signal is not an order to trade; it is
    something to weigh. For the rules whose results are recorded, the real record of the signals emailed is shown in the
    app, with how many there were. The MACD fade's results are not recorded or shown."
  - **〔adverse〕**: every clause below whose condition the filled numbers meet, in this order, each ending its sentence;
    none met, 〔adverse〕 is empty. No measured number and no percent in any (the page quotes none). The conditions read
    the same values as 4.5's slots:
    - 〔mean〕 < 0: 「測った期間では、1回あたりの平均はマイナスでした。」 / "Over the period measured, its
      mean a trade was below zero."
    - 〔mean〕 < 〔baseMean〕: 「合図なしで入った時より、1回あたりの平均が低くありました。」 /
      "Its mean a trade was below entering with no signal."
    - 〔mean〕 < 〔flowMean〕: 「同じ合図で逆向きに入った時より、1回あたりの平均が低くありま
      した。」 / "Its mean a trade was below entering the other way on the same signals."
    - some pair's fade pipsMean < 0 (〔negPairs〕 not none): 「5ペアのうち、1回あたりの
      平均がマイナスのペアがありました。」 / "On some of the five pairs its mean a trade was below zero."
    - 〔open〕 > 0 and 〔openPipsWorst〕 < 0: 「測った期間の終わりに、含み損のまま残っていた取引
      がありました。」 / "At the end of the period measured, some trades were still open at an unrealised loss."
    The choice and its reason (the values compared) are written in this file when the numbers are filled (4.5), and the
    clauses are run through 4.1's guards like every other text.
    **Chosen (2026-11-17, from research/macdfade1h-summary.json):** fade pipsMean +3.26 is not below 0, not below base
    +3.20 and not below flow −2.08, so the first three are not met; USD/JPY's fade pipsMean −0.26 is below 0, and 22
    trades were open with the worst at −1,733.2 pips, so the last two are met. 〔adverse〕 = ja
    「5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引があり
    ました。」, en "On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades
    were still open at an unrealised loss."
  - 「他のツールと何が違いますか？」 (ja:2032): 「サインの成績を隠さない点です。過去のチャートでの検証結果と、成績を記録して
    いる決まりについては、通知したサインが実際に損切りと利確のどちらに先に届いたかを、勝てていない場合もそのまま表示し
    ます。MACD の逆張りは、利確と損切りの値段を書かない決まりで、その成績は記録も表示もしていません。売買のサインは確定
    した足で判定し（MACD の逆張りも、1時間足の確定で判定します）、後から消えたり動いたりしません。」 en (:1929): "It does
    not hide the record. How each rule did on past charts, and, for the rules whose results are recorded, whether each
    signal emailed reached its stop or its target first, are shown as they are, losing ones included. The MACD fade
    states no take-profit or stop price, and its results are not recorded or shown. Trade signals are judged on closed
    bars (the MACD fade too, at 1-hour closes) and never vanish or move afterwards."
  - Not checked here, kept from today's texts: that the other signals fall short on 11 pairs; that every other trade
    signal is judged on closed bars (「売買の」 / "Trade" leaves out the sharp-rise notice, judged each minute, which
    its own text calls not a trade signal, ja:448: 「売買の合図ではありません」).
- **Tests to change:** the lists forbidding 「利確」 / "take profit" that stay (src/test/indicator-alerts.test.tsx:1506,
  2139; signal-alert-settings.test.tsx:417, 565, 853) first strip exactly the sentences 4.1 allows, each written out in
  the test (4.3 items 6 and 10 and their en; the shares' item 10; the notes' and intros' no-take-profit sentence; the
  measured paragraph of 4.5; the plan line's 「利確・損切りなし」 / "no take profit, no stop"; the sales page's fade
  sentences above), then find none; 「利確の目安」 and "take-profit level" are forbidden outright. The lists in
  macd-ride-alerts.test.ts (:376, :408) and stockmacd-alerts.test.tsx (:550, :583, :716) go with their blocks (3.5);
  the fade mails' tests carry the same guard. Each change goes in the PR that changes what it tests (6.3), so `npm
  test` passes on every PR:
  - **Step 2's PR** (id parse, tag, plan line): the v10 rows' test (signal-alert-settings.test.tsx:739-771, its
    comment :736-738) becomes the fade rows' test (a pair's, gold's and a share's fade row: the tags 「（MACD の逆張り）」
    and 「（株の MACD・逆張り）」 and their en, the plan line, ja and en); the v9 and older rows' tests (:655-734) stay.
  - **Step 3's PR** (the function): 3.5's removals and 7.1's fade tests; the forbid lists of the mails
    (indicator-alerts.test.tsx:1506, 2139); econ-digest.test.ts:284-285 (the footer, 4.1); the seven v39 pins (3.7).
  - **Step 6's PR** (the screen's texts): the tab name, intros, notes and FAQ pins (signal-alert-settings.test.tsx
    :397-567, :773-868, with its forbid lists :417, 565, 853); the stock tab's intro and notes pinned in v9's words in
    stockmacd-alerts.test.tsx:805-819 (「FX と同じ「MACD の流れ」のメール（2通）を送ります」, :807; 「…2通目は「96%に
    届いた」という知らせで…」, :817); the landing and FAQ tests of the sales texts with the 〔adverse〕 chosen.
  The tests pinning `'1h'` for `macdx` / `stockmacd` (e.g. stockmacd-alerts.test.tsx:83, :99-103) stay as they are.

## 6. Release

### 6.1 Preconditions

- **No v9 ride open** (the owner's answer), read twice: just before the function's merge, and again once v40 answers
  (6.3 step 4). The read: `select status, count(*) from public.macd_rides where status = 'open' or reached_at > now() -
  interval '45 minutes' group by 1` returns no row. Before the merge: else wait; no row is changed by hand; open over a
  day: the owner is asked again. The second read is needed because the merge only starts a deploy (below): until v40
  answers, v39 still judges 1-hour closes and opens a ride at a fresh entry (index.ts:1075-1130, `openRide` at :1108;
  a share's at :1897), and v40 never sends that ride's email 2.
- **A merge alone ships it.** A push to main touching `supabase/functions/**` deploys the default eight functions one
  after another, signal-alerts seventh and live-chart last (.github/workflows/deploy-functions.yml:22-27, :76-85). The
  deploys share one concurrency group with `cancel-in-progress: false` (:35-39): a deploy already running finishes
  first; a pending one in the group is replaced by this one, which deploys main's head (GitHub's documented rule for
  concurrency groups; not seen in this repository's runs). No workflow runs the tests on a pull request.
  So every PR before the function's has `git diff --stat origin/main...<head> -- supabase/functions` empty (true today:
  this branch differs from origin/main only under `research/` and in three study workflows, none of them among the
  deploy's paths, :24-27).
- The tests and static checks of 7.1 pass on the function's branch; `FADE_MEASURED` holds the 1-hour run's numbers by
  4.5's route (6.3 step 1a); 7.2 passed on the function's branch, on the walk files and on the real 1-hour run, with
  the re-run's summary.json sha256 equal to run 44099401423's (6.3 step 2a), its run id recorded in the function's PR.
- (The 15-minute form's precondition "the owner has confirmed the subscription statement" goes: there is none, 3.6.)

### 6.2 Timing

Unlike the 15-minute form, v39 and v40 judge **the same 1-hour closes**, so the switch must fall between two closes'
judging windows:
- v39 reads a pair's 1-hour close at :00, :03 and :05 (indicators.ts:1212) and looks at gold's from :01 until it is 30
  minutes old (indicators.ts:1295, `freshFor("1h")` :330-331; in practice to :29, index.ts:1178). From :30 to :59 no
  pair's or gold's 1-hour close is being judged by either version.
- A share's close is read in the 30 minutes after it and mailed up to 45 minutes after it (stocks.ts:116-123). New
  York's 1-hour closes are 10:30, 11:30, 12:30, 13:30, 14:30, 15:30 and 16:00 New York time, Tokyo's 10:00, 11:00,
  11:30, 13:00, 14:00, 15:00 and 15:30 JST, so many minutes :31-:50 inside either session fall within 45 minutes of
  some share's close, though not all (New York's 09:31-09:59, before its first close, and Tokyo's 12:31-12:50, in its
  lunch break, do not). The rule below is written against the closes themselves, not against "every :31".

So: **merge the function's PR in minutes 31-50 of an hour, outside the 45 minutes after any 1-hour share close (in
practice outside the Tokyo and New York sessions and the 45 minutes after each one's last close), with no v9 ride open.**
When v40 first answers in :31-:59, v39 has judged that hour's close and v40 judges the next one: no close is judged by
both versions, and none by neither (no subscription moves, so nothing waits for a move). v39's own deploy ran from
07:33:15 to 07:33:36 UTC after a merge at about 07:33:05, and v39 answered from the 07:34:00 call
(scripts/morning-check/README.md:33-34), so a merge at :31-:50 normally lands well before :00; but signal-alerts is the
seventh of eight in the deploy (deploy-functions.yml:76) and a deploy already running finishes first (6.1), so it can
run past :00 or into a share's window. The time of v40's first answer is noted from the run's record
(`net._http_response`). If it is at or after the next :00, or inside a share's window, that close may be judged by both: v39's ride email 1 or notice (and a
ride opened) and v40's fade, for one bar. The second `macd_rides` read (6.3 step 4) catches the ride; the rows of that
hour's bars under v9's ids and the new id are counted (`select rule, pair, bar_time, count(*) from
public.signal_alerts where kind = 'signal' and interval = '1h' and (rule like 'macdx%' or rule like 'stockmacd%') and
bar_time >= <that hour's bars' open> group by 1, 2, 3`: no user ids), and the owner is told.
`live_ms` (for the morning check), per chart: the open of the first 1-hour bar v40 judged, read from the run's record
(as v9's was defined, scripts/morning-check/README.md:32).

### 6.3 Order

0. Done: the shelved v10 files are main's bytes again (9bcfd70, 3.5).
1. This spec and the study's files: a PR with nothing under `supabase/functions/**`. In it, the specs this one replaces
   are marked so no builder starts from them: research/macdfade15-prod-spec.md gets, under its title, the line
   "**Superseded (2026-11-17) by research/macdfade1h-prod-spec.md, not to be built.** The owner then said
   「やっぱりメールの判断1時間足で」; its line numbers were read on the shelved v10 files, which 9bcfd70 put back to
   main's."; research/macdfade96-spec.md:3-4, which send the reader to the 15-minute spec as "the production spec", name
   this file instead.
1a. The numbers, before any of the function's code is written (done 2026-11-17): 4.5's route 1 (run 44108923903 and
   the research/ledger copy), every ⟨1h run: …⟩ filled, sections 4-5 read against them, 〔chance〕 written (4.5) and the
   sales page's 〔adverse〕 chosen (section 5); this file and the research/ledger copy are merged as step 1 is (nothing
   under `supabase/functions/**`).
2. The app's id parse, tag and plan line (section 5's first three items only), cut from origin/main; merged and
   published. Lovable's state is reported as given (e.g. `pending`).
2a. The study check (7.2) on the function's branch, before the function's PR is merged (merging deploys at once,
   6.1). The branch carries `_shared/macd-fade.ts`, research/macdfade-prod-check.ts and the workflow's new steps (7.2),
   with `research/macdfade-prod-check.ts`, `supabase/functions/_shared/macd-fade.ts` and
   `supabase/functions/signal-alerts/indicators.ts` (where `ridePaidAt` is) added to the workflow's push `paths`. The
   workflow runs there by `workflow_dispatch` with `tf` `1h` (GitHub offers a dispatch only for a workflow on the
   default branch, so after step 1's merge) or, in that PR, by adding the branch to its push `branches`
   (.github/workflows/macdfade15.yml:25-28 list only the research branch today). The real job takes up to 180 minutes
   (:151). Its run id is recorded in the function's PR; a failure, or a summary.json sha256 other than run 44099401423's,
   stops the release.
3. The function's PR (sections 3-4, logic.ts's `RULE_LABEL` (:506-509) and test-mail lists, the econ footer), merged per
   6.1-6.2.
4. Once v40 is seen answering (its `FUNCTION_VERSION` in the run's record): the `macd_rides` read of 6.1 again, with
   v40's first answer time noted against the next :00 and the 1-hour share closes. If it returns a row (a ride v39
   opened or reached between the first read and v40's first answer), nothing more is done and the owner is told and
   asked what to do with it, as the earlier answer says: an open ride gets no email 2 from v40 (one way is to revert to
   v39 by 6.4 until it is reached and 45 minutes have passed: the subscriptions are on `'1h'` as v39 reads them); a
   reached one's email 2 went out, but a follower whose address lookup failed gets no re-offer. If v40 first answered at
   or after :00 or in a share's window: the count of 6.2, reported. (No subscription statement: 3.6.)
5. econ-calendar deployed by name right after (its footer changed; it is not in the default list, deploy-functions.yml:
   66-70, :76).
6. The screen's texts (the rest of section 5), merged and published as soon as v40 answers; state reported as given.
   Until it is live the screen shows v9's texts beside the same `1h` column.
7. The morning check of 7.3 merged, and the Routine's prompt replaced and read back before the next 00:16 UTC run.
   Later, if wanted: a small PR drops 「MACD の流れ」 / "MACD ride" from the how-to-stop lines and the footer (it deploys
   again; econ-calendar too).

### 6.4 Rollback

Revert the function's merge in minutes 31-50 of an hour, outside the 45 minutes after any share's close (6.2, the
same reasoning the other way): v39 is deployed again and reads the same `'1h'` subscriptions; nothing to move back, no
schema to undo. **Except** when v40 judges nothing (its runs fail every time, so no close is judged by it): then the
revert is made at once, whatever the minute, since there is no judging of v40's for v39's to overlap and every minute
of waiting costs every rule's mails. Deploy econ-calendar by name; revert and publish the screen's text PR; put the
Routine's v9 prompt back (a copy kept before step 7). v39 starts with no ride open when the second read of 6.3 step 4
returned no row (v40 opens none); when it returned one, the owner's answer then decides. Fade rows and mails stay; the
app keeps reading both ids. **The v40 window** (from v40's first answer to v39's first answer again, both read from the
run's record) is written down, and the restored Routine's prompt reads every bar opened in it as not v9's (v40 wrote no
v9 entry and no `macd_ride_state` row there, so v9's check would otherwise expect what was never written), as the
switch day does (7.3). A rollback restores a form the owner left: only for a failure, and the owner is told.

## 7. Checks

### 7.1 Tests and static checks

`npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and econ-calendar, and `deno
check scripts/morning-check/bench/sim.ts` (the v9 bench, on main's macd-ride.ts). No import of `macd-ride.ts` under
`supabase/functions/` (grep). 3.2's "nothing read or written each minute, no state row" is held two ways: a code-text
check that no `rest(` or `readRows(` call in index.ts names `macd_rides` or `macd_ride_state` (today :695, :719,
:750, :1025, :1040, :1641; comments may still name the tables, so the check reads calls, not every line), and, in the
fake-table tests below, a pairs run, a gold run and a shares run each make no request to either table. Function tests
over fake tables: a pair's close judged at minutes 0, 3 and 5 (fresh instances): one email a follower, the same price (the 1-hour ask / bid close of the bar, from `hourQuotes`); a follower
whose lookup failed, mailed at the next judging; a row of the other side: nothing, `other_side`; not fresh (31
minutes): nothing; a missing quote: `no_price`, judged again; gold judged a minute after a close and again up to :29;
a share read again in its window: one email a follower; a Tokyo bar arriving 15 minutes late: judged and mailed (fresh
at 45); the row's `interval` `1h`, `entry`, null `stop` and `target`, `closed_at`, `rule`; each mail variant in ja and
en (a pair's BUY and SELL, gold's, a US and a Tokyo share's, a session's last bar), each pinned to the words of
4.3-4.5: among them each kind's timing sentence of item 8 (a pair's reads, gold's 1 to 30 minutes, a US share's
45-minute sentence, a Tokyo share's measured delay; none says 「数分後」 / "a few minutes"), each with 「実際に何分で届く
かは測っていません」 / "how long it takes to arrive has not been measured" where 4.3-4.4 give it, and the arrival-price
sentence; item 10 of the pairs' and gold's mails and of the shares' (the owner named only for what 4.3 / 4.4 item 10
list; the pane, and the shares' 1-hour bars, as facts); the share mails' Yahoo source line, app link, 「株の MACD」 /
"Stock MACD" how-to-stop line and disclaimer (4.4 item 11); the measured paragraph's re-read clause, 「（マイナスが
損）」 / "(a minus is a loss)", 「入らなかった注文はありません」 / "no order went unfilled", the baseline's 〔baseWhat〕
and its parenthesis after 〔baseMean〕, and the 〔open〕 = 0 and 〔tp〕 = 0 variants built from summaries made for the
test (4.5); the econ footer's two sentences (4.1) and the econ digest's recipients unchanged (`1h`); 4.1's guards;
the record's `fade` and tags. In the PRs of 6.3 steps 2 and 6 (section 5's tests): the fade rows' tags, the shares'
「（株の MACD・逆張り）」 / " (Stock MACD fade)" among them; the notes' version of the measured paragraph (4.5) word for
word; the sales page's three texts of section 5, ja and en, with the 〔adverse〕 chosen. The two order guards of
indicator-alerts.test.tsx, re-pointed to `fadeAtClose` (3.5), stay. The shares' bar functions (`stockBarEnd`,
`CLOSES`, `stockBarBreak`) are unchanged and keep their #391 tests.

### 7.2 The study check: the shared function gives the study's entries

`research/macdfade-prod-check.ts` (new). **What it reads:** `TF` (must be `1h`), `MODE`, `OUT`, `START`, `END` and
`LOAD_FROM` from the environment as the study does (research/macdfade15.ts:50-59), and the files from the same place:
with `MODE=walkfiles` the walk's files under `$OUT/gmo`, never fetched; with `MODE=real` research/.cache (:1227). It
loads the five pairs' 1-hour bars exactly as the study does (:1057-1069: `loadTf(src, pair, TF, LOAD_FROM, END, st,
weekendOutOf("inside"))` → `quotesOf` → `chartOf`'s `historyRead(pair, TF, qs, END)`, :85-95), and for every bar `n`
with its close in `[START, END)` and 600 bars up to it calls `fadeCloseEntryAt` on the 600 closes ending at `n`, with
the price from the bar's own quote through `ridePaidAt`. A bar whose three reads (`T` + 0, 3, 5 minutes + 1 second;
:78-79) all fall in `isPossiblyClosed` is counted as not mailed. Against the study's `$OUT/rows.csv` (`dir = fade`) and
`$OUT/summary.json`, keyed by pair|open: the mailed entries are the same set of bars, each with the same `zside`,
`side`, entry and `share0`; per pair, the not-mailed ones equal `notMailed` and all of them `signals`. Any difference:
the first 20 printed and the job fails.

**Where it runs:** in .github/workflows/macdfade15.yml, as steps added on the function's branch (6.3 step 2a): in the
syn job after each `walkfiles` step (walks 1 and 2, and the untidy walk 1, each with that step's `OUT` and the syn
job's 1-hour period, :81-83, :97-137), and in the real job after "The Python on the same files and rows" (:217-218),
with the real job's `OUT` (research/out/macdfade1h, :153) and the workflow's defaults (:68-74). The real job's step
also stops unless that run's summary.json sha256 is run 44099401423's (`60edab22…a9e2`, 4.5): the study and its files
are then those whose numbers fill `FADE_MEASURED`. The study is written apart from the shared code and checked by its
own Python; this check ties the shipped function to it.

### 7.3 The morning check of the new form (statements `pairs-v11` / `gold-v11`; README section)

- **Pairs**, from scripts/morning-check/pairs-v8.sql (v33's 1-hour statement: the stored `1hour` day files, 40 days back
  (:14, :18), `live_ms`, the weekend window, interval `1h`; its rule is v8's zone rule, so the side is already the fade
  side, :163-166): the share 0.95 → 0.96 for Z and Zp (:172-173, :192-193, :199); the rule id → the new one (:5, :226,
  :236, :453); the go-live constant (:24-31); the FRONT of v9 (src/front-pairs-v9.part, pairs-v9.sql:26, :66-74, which
  carries the BID and ASK closes) so the mail's `entry` is compared with the ask close (BUY) or bid close (SELL), as
  pairs-v9.sql:97 and :505 do, not with the mid close (pairs-v8.sql:155, :364-365); new verdict parts `other_side`
  (rows of both sides in one bar), `stop_or_target` (either not null).
- **The files are stored:** the sweep stores each ended 1-hour GMO day file it reads (`storeFile`, index.ts:884-891,
  called at :919) and deletes them after 60 days (index.ts:837-840). The 1-hour charts of the six have been read since
  v33 (2026-10-30; v9 reads them too), so no day should be missing; not read in production.
- **Gold**, from gold-v8.sql likewise (0.96 at :144-145, :164-165, :171; its price the close; the stored Twelve Data
  `1h` row, :5-8).
- **Shares**: rows against mails only (their bars are not stored): one side a bar under the new id, one entry in every
  row of a bar, `stop` and `target` null.
- v8's statements were 25,048 and 22,054 characters (scripts/morning-check/README.md:125), sent by the Routine one call
  each. The new ones add v9's FRONT and two verdicts; their size is not measured. If one outgrows one call, the
  function form (owner-confirmed DDL) as v9's (README v9.7).
- The Routine's prompt is replaced and read back before the first 00:16 UTC run after the release. On the switch day it
  runs `mc.pairs_v9` / `mc.gold_v9` and reads every line of a bar opened at or after `live_ms` as not v9's (the
  subscriptions stay, so v9's statement expects its entries there and finds none: not errors), and v11 from `live_ms`.
  Until v11 is in, every report says 「新しい形（1時間足・確定96%・逆張り）の判定は数え直していません」.

## 8. Not measured, not checked

- **Measured, now in this file:** the five pairs' numbers of this form (the study's `TF=1h` real run, run
  44099401423, recorded in research/macdfade15-spec.md by d96bf56), filled in 4.5 from research/ledger/
  macdfade1h-summary.json (route 1: run 44108923903 printed the file; the copy's sha256 equals the run's). The artifact
  itself was still not downloaded; null.json and rows.csv are not in the repository (their sha256 are recorded).
- **Not measured:** gold and the shares with this form; the minutes between a close and the mail (pairs, gold, US
  shares; Tokyo's delay was measured 2026-11-06) and the price's move in them; how often a close is not judged; the
  Twelve Data reads a day (up to two a gold close, 24 closes a day); whether the fade's mean differs from the
  baseline's beyond chance (the study sets its gaps beside ten driftless walks' and calls that not a test).
- **Not checked:** whether production's GMO 1-hour bars (`fetchLiveQuotes`) equal the study's loader's (`mergeSides`);
  whether a feed revises a closed bar between judgings (`other_side`); who follows which chart and how many `macdx` /
  `stockmacd` rows there are on which interval (3.6's "no DML" rests on the code); how many v9 rides are open; whether
  every 1-hour day file since v33 is stored; the Routine's prompt; Lovable's live state; how long v40's deploy will take
  (6.2: the second `macd_rides` read and the count decide); the size of the v11 statements; the claims kept from today's
  sales texts (section 5, the sales page's last sub-item); a real concurrent run of v39 and v40 during the switch;
  GitHub's concurrency and `workflow_dispatch` behaviour in this repository's runs (6.1, 6.3 step 2a: from GitHub's
  documented rules only); whether a re-run of the real 1-hour job prints the same summary.json (6.3 steps 1a and 2a
  stop if not); whether the job log's copy of summary.json keeps its bytes (4.5 checks its sha256); whether
  research/macdfade-prod-check.ts can import `ridePaidAt` from signal-alerts/indicators.ts as a research script.
- **Writer's readings, not asked again (section 1):** the pane on 1-hour bars (the newest 120 1-hour bars on 600
  closes); the shares staying on their 1-hour bars.
- **Read:** the 15-minute production spec whole; the study spec whole; the earlier 1-hour draft whole (its facts checked
  again here); research/macdfade96-spec.md :1-75, :351-425 and the 6.1 guard lines; in the code every line cited above
  (index.ts :355-372, :440-460, :620-1400, :1600-1716, :1790-2000, :2396-2490; indicators.ts :120-360, :700-890,
  :1195-1345, :1686-1692, :1750-1755; stocks.ts whole; live-chart/stocks.ts whole; macd-level.ts :190-254;
  market-hours.ts :1-80; logic.ts :312-330, :504-509; econ-calendar mailer.ts's lines naming `isMacdhChart` and
  digest.ts's two footer lines; src/lib/signalAlerts.ts :25-60; SignalAlertSettings.tsx :108-128, :220, :409-414; the
  cited ja.ts / en.ts lines; deploy-functions.yml whole; the migrations' signal_alerts columns and keys; the tests'
  cited lines and describe heads; morning-check README :1-40, :123-140, pairs-v8.sql's head and its 0.95 / id / entry
  lines, gold-v8.sql's head and 0.95 lines, pairs-v9.sql's FRONT and price lines; research/macdfade15.ts :26-95 and
  :1057-1066 and the workflow's `TF` lines).
  **Read by the revision after the three reviews** (2026-11-17, on 6cbee35): research/macdfade15-spec.md :176-440
  (its 1-hour section and both results, d96bf56); .github/workflows/macdfade15.yml whole; research/macdfade15.ts
  :50-100, :336-348, :495-515, :548-600, :1040-1080, :1195-1240; deploy-functions.yml :18-40, :60-90; indicators.ts
  :325-333, :1284-1345; index.ts :1170-1190 and the lines naming `macd_rides` / `macd_ride_state`; stocks.ts :110-147,
  :368-380, :430-445 and its `Stock MACD` lines; src/test/indicator-alerts.test.tsx :14-60, :990-1022, :1160-1192,
  :1236-1262, :1450-1457, :1506, :2139; src/test/stockmacd-alerts.test.tsx :1-104, :180-200, :755-822 and its describe
  and it heads; src/test/signal-alert-settings.test.tsx :410-420, :484-495, :565, :736-774, :853, :862-872 and its it
  heads; src/test/econ-digest.test.ts :275-290; src/test/landing.test.tsx :45-60; econ-calendar/digest.ts :418-456;
  SignalAlertSettings.tsx :105-130; ja.ts :2106-2114, :2135-2155; en.ts :2005-2007 and its date lines;
  research/macdfade15-prod-spec.md :1-60 and its item 10; research/macdfade96-spec.md :1-80.
  **Not read:** production (by rule); logic.ts's admin list; the run's job log and its artifact; research/
  macdfade15-check.py; docs §8.
- **Run by this writer:** `git diff --stat origin/main` (empty under `supabase/`, `src/`, `scripts/`); `git grep` of
  the ids and of `fade` under `supabase/` and `src/`; one node check of the two ids against copies of the app's regexes
  and of `fadeRuleId`. The revision ran only `git log`, `git show --stat`, `git diff --stat origin/main`, `git grep`
  of the ids and of `fade`, `git log -S fade96of120` under `supabase/` and `src/` (empty), 4.1's two guard patterns
  over sections 4-5 (node), and file reads. Nothing else: no test, no app, no function, no study, no workflow, no
  production.
