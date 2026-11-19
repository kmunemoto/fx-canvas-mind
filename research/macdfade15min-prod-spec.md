# The MACD fade on 15-minute closes: v40's email moved from 1-hour to 15-minute bars (signal-alerts v41)

Status: a production spec, written 2026-11-19 on branch `claude/app-confirmation-jvmk03` at 3adec21 (equal to
origin/main). Nothing in it is built. Production runs signal-alerts v40 (`signal-alerts-v40-2026-11-18`, the fade on
1-hour bars, live since 2026-11-18 12:40 UTC; docs/OPERATIONS.md §8.155). This file is the production spec of v41.
Revised the same day after a review: each finding was checked against the code and records it cited before this file
was changed (the files read for it are listed in section 8, "Read by this writer").
It keeps the structure and the section numbers of research/macdfade1h-prod-spec.md (the v40 spec, built as written).
Where that spec still holds word for word, this file says "as research/macdfade1h-prod-spec.md N.N" and does not copy
it. Everything that changes is written out here.

It takes over from research/macdfade15-prod-spec.md (2026-11-17, the same rule on 15-minute bars, marked superseded and
never built). That file's 15-minute facts were used as leads only. Every one was checked again on today's code; its line
numbers are stale (they were read on the shelved v10 files). Where that file and this one differ, this one governs.

**Paths.** As research/macdfade1h-prod-spec.md "Paths": `index.ts`, `indicators.ts`, `stocks.ts`, `logic.ts` are in
`supabase/functions/signal-alerts/`; `macd-fade.ts`, `macd-fade-measured.ts`, `macd-level.ts`, `macd.ts`,
`market-hours.ts` in `supabase/functions/_shared/`. Every line number here was read by this writer on 3adec21, on
2026-11-19.

**The study it must equal.** research/macdfade15-spec.md (the rule on 15-minute bars, `TF=15min`; built in
research/macdfade15.ts, run by .github/workflows/macdfade15.yml, checked by research/macdfade15-check.py). Its real
15-minute run is that spec's section "Result of the real run (2026-11-17, Actions run 44077464383, commit fff5ddb)"
(:406-440), and for the email's numbers its section "Result of the re-run on GMO's files read afresh (2026-11-19,
Actions run 44535888012, main 9ca2054)" (:442-500; 4.5). The study's rule, files and numbers govern: where it reads differently from section 2, this file is
corrected before anything is built.

## 1. What the owner asked

2026-11-19: 「メールの判断15分に変更して」. Answers given in the question dialog (in English here, not the owner's words;
relayed to this writer by the workflow that asked, the dialog itself not seen here):
- **Scope: all.** The five pairs (USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD), gold (XAU/USD) and the 22 shares all
  move to 15-minute bars.
- The owner knows that Yahoo's Tokyo prices come about 15 to 20 minutes late. (Measured: about 15 minutes, 891 to 933
  seconds, on 2026-11-06, docs §8.141. "15 to 20" is the relayed answer's wording (the dialog not seen here; whether
  "20" came from the owner or from the question is not known here), not a measurement; no text here writes "20".)

Answers of 2026-11-17 that still stand (research/macdfade15-prod-spec.md section 1, research/macdfade15-spec.md "Why"):
- Only the first bar at 96% (the bar before not at 96%), not every bar while the line stays there.
- The email states only the price in: no take-profit level and no stop. Measured while building; the numbers go in the
  email.
- **The pane is the newest 120 15-minute bars** (the 15-minute chart's MACD pane), chosen by the owner over a 480-bar
  pane.
- The shares are on 15-minute bars too, the owner knowing that Yahoo's Tokyo prices come late.
- Gold and the shares go out with the pairs, not measured with this form; their mails say so and carry no numbers. The
  shares fade too (a SELL is a short sale). Nothing is sent at any target. The name stays 「MACD の逆張り」 / "MACD
  fade".

**Read by this writer, not asked again:**
- 「変更」 means a replacement: v40's 1-hour email stops when v41 starts. Both are not sent. (The same reading as v31's
  「メールの判断15分足に変更して」 on 2026-10-26, docs §8.127.)
- Everything else of the rule stays as v40: the 600 closes ending at the bar, 96%, the bar before (index 598 of the
  same window) not at 96%, the fade side, the price in (pairs: the bid close for a SELL, the ask close for a BUY; gold
  and shares: the close), no take-profit and no stop price, one side a bar, nothing sent after.

CLAUDE.md: as research/macdfade1h-prod-spec.md section 1, its last paragraph, word for word. One thing is new: on
15-minute bars the fade did worse a trade than entering with no signal (4.5). Every text with the numbers says so.

## 2. The rule (pairs, gold and shares alike)

### 2.1 Terms (the study's, `TF=15min`)

- A chart's closed **15-minute** bars, oldest first, their closes as the chart draws them: a pair's, GMO's mid rounded
  (`historyRead` on the `15min` chart, index.ts:1149); gold's, Twelve Data's stored `15min` bars (`historyOfBars`,
  index.ts:1051); a share's, Yahoo's `15m` bars (`stockBarsOf` → `parseYahooChart(sym, body, …)`, stocks.ts:151-152,
  with the interval taken from `STOCKMACD_INTERVALS[0]`, 3.3).
- The rest as research/macdfade1h-prod-spec.md 2.1, word for word (600 closes ending at `n`, `Z(n) = zoneAt(r, 599)`,
  `Zp(n) = zoneAt(r, 598)`, the 120 positions of the pane, the share, `FADE_PCT = 96`). Read on 15-minute bars: 600
  closes are about six and a quarter trading days of a pair (research/macdfade15-spec.md "Data"), about 23 US sessions
  and about 27 Tokyo sessions of a share (26 and 22 bars a session, 3.3). The pane of 120 bars is 30 hours of a pair,
  about 4.6 US and 5.5 Tokyo sessions of a share.

### 2.2 The entry and the side

As research/macdfade1h-prod-spec.md 2.2, word for word. (At 0.95 this is v8's zone rule, which v31 mailed on these
15-minute charts from 2026-10-26 to 10-30, docs §8.127.)

### 2.3 The price in; no target; no stop

- **A pair:** bar `n`'s **ask close for a BUY, bid close for a SELL**, from the same GMO 15-minute read the closes come
  from, as GMO gives them (not rounded). This is the study's price ("Prices in": GMO's own 15-minute bar's bid and ask
  close). **Today the function keeps the quotes of the 1-hour read only**: `if (c.interval === "1h")
  hourQuotes.set(c.pair, quotes)` (index.ts:1148), and the fade looks its price up there (index.ts:936). A 15-minute
  read's quotes are dropped, so every pair entry would end as `no_price` and never be mailed. v41 keeps the fade
  chart's read in a map of its own (`fadeQuotes`, 3.2). It takes the quote whose open is `n`'s and prices it with
  `ridePaidAt` (indicators.ts:648: a BUY the ask close, a SELL the bid close), as v40 does.
- **Gold:** the closed bar's close (as v40, index.ts:937).
- **A share:** the closed bar's close (as v40, index.ts:1555).
- No target and no stop: as research/macdfade1h-prod-spec.md 2.3, its last item.

### 2.4 When each kind is read and judged

- **Pairs:** the `15min` chart, read 0, 1 and 3 minutes after each quarter-hour close (`gmoIntervalsDue`,
  indicators.ts:1028: `m % 15` is 0, 1 or 3), from a second into the minute (`startWaitMs`, indicators.ts:1096-1100;
  index.ts:759-761). The bar expected is the one that closed at the latest quarter hour (index.ts:1122, :1170-1173). An
  answer GMO made before the close is not judged on (`staleForClose`, indicators.ts:1059-1068; index.ts:827-838, with
  `latestCloseMs("15min")`, indicators.ts:1040-1044). Judged once an instance (`judgedBar`, index.ts:446, :973, :1131,
  :1174); a fresh instance judges it again. Fewer than 600 closed bars: `short`, not judged (index.ts:1153-1156). An
  entry is mailed only while its bar closed at most 20 minutes ago (`freshFor("15min")`, indicators.ts:331-332); the
  read at minute 3 meets that unless the run is late. These are the reads v31 used (docs §8.127) and that the EMA
  20 / 200 email (`emarm`, 15 minutes, indicators.ts:293) uses today.
- **Gold:** Twelve Data's `15min` bars as the live chart keeps them (`live_chart_fallback`, index.ts:1035;
  `GOLD_ALERT_INTERVALS` already holds `15min`, indicators.ts:219). Looked at from a minute after each quarter-hour close
  until the next close (`twelveChartDue` → `twelveCloseDue`, indicators.ts:1106-1128: it looks at the newest close only,
  from 60 seconds after it, so the 20 minutes of `freshFor("15min")` never bind; in practice minutes 1 to 14 after the
  close). Twelve Data itself is read only when the stored bars lack the bar, at most twice a close (`twelveReadDue`,
  indicators.ts:1149-1152: at +1 minute and again from +4), within the alerts' 780 a day (`ALERT_TWELVE_CAP`,
  indicators.ts:1160; index.ts:1067-1070). This is how v31 read gold's 15 minutes (docs §8.127).
- **Shares:** Yahoo's 15-minute bars (`yahooChartUrl(sym, "15min")`: `interval=15m&range=60d`, live-chart/stocks.ts:51,
  :64-67), read in the 30 minutes after each 15-minute session close (`CLOSES` rewritten, 3.3; `STOCK_POLL_MS` 30
  minutes unchanged, stocks.ts:112; `stockCloseDue`, stocks.ts:118-127), at most once in 50 seconds (index.ts:1567).
  Only the newest closed bar is judged at a read (`stockSweepOf`, stocks.ts:209-228). Fresh 45 minutes
  (`STOCK_FRESH_MS`, stocks.ts:114, unchanged; `stockBarFresh`, :187-190).
  - Tokyo: Yahoo's Tokyo prices came 891 to 933 seconds late on 2026-11-06 (docs §8.141, on 1-hour reads). On
    15-minute bars the bar ending at X is then seen closed about X+15 minutes, when the next bar (ending X+15) is
    already due. So it is judged at the read about X+16 minutes, about 16 minutes after its close, inside 45. And the
    close due is never "done" before the next one starts, so a Tokyo share is read about once a minute through the
    session (9:15 to about 11:46 and 12:45 to about 15:46 JST). Counted from the code; not measured on 15-minute reads.
  - New York: no delay was seen (docs §8.141); a bar is judged at the read right after its close.
  - **The stocks run and the other runs share one queue.** This project's pg_net (0.20.0) sends a call only once the
    one before it has ended (measured 2026-10-11, docs §8.112, OPERATIONS.md:9244, also :552); the stocks run
    (supabase/migrations/20261031160100_stockmacd_sweep.sql:13, :15, :22: every minute, `net.http_post`, 120-second
    timeout) and the pairs' and gold's run (20260929060100_indicator_alerts_sweep.sql:13, :15, :22: the same) both go
    through it. The stocks run reads its shares one after another, each read with a 10-second timeout and no limit on
    the run (index.ts:1564-1571). So while a stocks call runs, the next calls wait. A stocks call of about a minute or
    more pushes the pairs' read at +1 or +3 minutes into a minute where `15min` is not due (indicators.ts:1028), and
    calls that keep running long back the queue up, so all three reads of a quarter hour can be missed: the five
    pairs then go unjudged for that quarter hour (gold, looked at each minute until the next close, only if the
    backlog lasts that long). On 15-minute bars a Tokyo share is read every minute of the
    session (above; on 1-hour bars for about 16 minutes after each of seven closes), so this can happen through
    Tokyo's hours (00:00 to 06:30 UTC). Measured before the stocks run existed: the longest pg_net call of 2026-10-03
    to 10-10 was 37.7 seconds, none over 60 (docs §8.112). The stocks calls' lengths: not measured. So v41 bounds
    the stocks run (3.3 item 10) and the release watches for it (6.3 step 5a, 6.4).
- So the mail is judged and sent some minutes after the close: pairs at the reads 0, 1 or 3 minutes after it; gold
  from 1 minute after it until the next close; a share at a read after it (a Tokyo share about 16 minutes after it,
  counted from the 2026-11-06 delay, not measured on 15-minute bars). How long the mail takes to arrive, and the
  price's move in that time, are not measured; the mails say so (4.3 item 8, 4.4 item 8).
- **Never judged:**
  - A pair's or gold's close whose reads all fall in the weekend gate, Friday 21:00 to Sunday 22:00 UTC
    (`isPossiblyClosed`, market-hours.ts:35-43; the sweep returns at once, index.ts:763). All three reads (0, 1, 3
    minutes) fall in the close's own quarter hour. So every bar closing at or after Friday 21:00 UTC is not judged:
    one bar a week in New York's summer (closing 21:00), five in its winter (closing 21:00 to 22:00, now). Any Sunday
    bar closing before 22:00 UTC is not judged either. The study reads the gate the same way (reads at 0, 1 and 3
    minutes plus a second, research/macdfade15-spec.md "The entries") and counts such signals apart (`notMailed`: 3 in
    the real run).
  - Gold's daily break (an hour; four near-flat 15-minute bars a day, seen in §8.127's stored bars) is **not** gated:
    those bars are read, judged and kept in the 600-bar window (one bar a day on 1-hour bars, four now). Their effect
    on the MACD is not measured (section 8).
  - Also never judged: a pair whose newest closed bar is not in GMO's answer by minute 3; a pair read `short`; gold's
    bar not in Twelve Data after its two reads, or on a UTC day whose Twelve Data count is spent (`day_spent`,
    index.ts:1067-1069); a share's bar overtaken by the next closed bar before any read judged it (only the newest is
    judged); a pair's quarter hour whose three reads were all held past their minutes by long calls ahead of them in
    pg_net's queue (above; gold's, only if every minute until the next close was); failed runs; a chart nobody
    follows. How often: not measured.

### 2.5 One email a bar and chart

As research/macdfade1h-prod-spec.md 2.5, with today's lines (the claim key:
supabase/migrations/20260925180000_signal_alert_rules.sql:32; `mailRide`'s read with no side filter: index.ts:711-740;
the failed address lookup: index.ts:632-643; a pair's or gold's bar not unsettled by it: index.ts:992-1001), except the
re-offer times: a follower whose address
lookup failed is mailed when the bar is judged again: a pair at minute 1 or 3, gold at a later minute before the next
close, each on a fresh instance or when the bar is unsettled. A share's bar: as there (index.ts:1607-1613).

## 3. The code

### 3.1 The shared pure function: `_shared/macd-fade.ts` (unchanged)

No change to its code. `closeEntryAt` and `fadeCloseEntryAt` take the newest 600 closes of any chart. Only comments
change: macd-fade.ts:1-4 and :21-25 name the 1-hour charts and ids; they name the 15-minute ones (3.7). `macd-level.ts`,
`macd.ts`, `market-hours.ts`: no change.

### 3.2 Pairs and gold: `fadeAtClose` on the 15-minute chart (index.ts:921-949)

Each change below is needed. Left out, the first three fail silently: nothing is mailed and no error shows.
1. **The chart:** `MACDH_INTERVALS = ["15min"]` (indicators.ts:268, today `["1h"]`). This one constant drives
   `isMacdhChart` (:273-275) and `isIndicatorChartFor("macdx", …)` (:308-310); the run's subscription filter
   (index.ts:776-778), `fadeSubs` (:902) and `faded` (:983); the status call (index.ts:2040), `set` (:2066) and
   `set_many` (:2107); the rule id (3.7); and the econ digest's recipients (econ-calendar/mailer.ts:90, bundled, so
   econ-calendar is deployed again by name, 6.3).
2. **Freshness and the bar's length:** `fadeAtClose` hard-codes 1 hour three times: `nowMs - (newest + HOUR)` (:926),
   `freshFor("1h")` (:927), and `fadeSignal("macdx", pair, "1h", …, closeMs: newest + HOUR …)` (:943). Left as they are,
   a 15-minute bar would read as not yet closed (age below 0) and nothing would be judged; and a signal with interval
   `1h` would match no follower, since `mailerFor` (:622) and `mailRide` (:728) match followers on `x.interval ===
   sig.interval`. So `judge` (:986) passes its `interval`, and `fadeAtClose` uses `const step = LIVE_STEP_MS[interval]`,
   `age = nowMs - (newest + step)`, `freshFor(interval)`, and `fadeSignal("macdx", pair, interval, entry, { openMs:
   newest, closeMs: newest + step, … })`.
3. **The price:** beside index.ts:1148 add `if (c.interval === MACDH_INTERVALS[0]) fadeQuotes.set(c.pair, quotes)`
   (a new `Map<string, QuoteCandle[]>` next to `hourQuotes`, :895), and at :936 look the quote up in `fadeQuotes`.
   `hourQuotes` stays as it is: the sharp-rise email reads it (index.ts:1210, :1255).
4. **Comments only:** index.ts:892-920 (the fade's block), :992-996 ("minutes 3 and 5; gold each minute to :29"
   becomes "minutes 1 and 3; gold each minute until the next close"), the header's v41 note (3.7); indicators.ts:151-166,
   :264-267 (its "nothing of the charts or the subscriptions changes" becomes false), :276-277, :373-383 (`FadeFacts`
   says "a closed 1-hour bar" and "GMO's 1-hour bar") and :634-647.
5. Unchanged: the steps of research/macdfade1h-prod-spec.md 3.2 (1 not fresh; 2 the entry; 3 the price; 4 the signal
   and `mailRide`; 5 unsettled only on `fade.error`), and "nothing read or written each minute for this rule; no state
   row".

Which chart is read (no change needed):
- **Pairs:** the GMO loop (index.ts:1115-1179). When a `macdx` follower is on `pair|15min`, `gmoCharts` (:790) takes it
  at the minutes `gmoIntervalsDue` gives. `fetchLiveQuotes(pair, "15min", …, HISTORY_BARS + 1)` (:1143) reads GMO's
  day-keyed 15-minute files through `fetchRecentQuotes` (analyze/price-source.ts:181-226: newest day first, 12 calendar
  days at most for 601 bars, whole weekend days skipped). `preload` brings 13 days of kept files from
  `gmo_kline_files` once an instance (index.ts:855-875; `klinePreloadDays("15min", 601)` = 13, indicators.ts:1205-1211).
  Ended day files read from GMO are kept (`storeFile`, index.ts:814-821, :844-850).
- **Gold:** the Twelve Data loop (index.ts:1020-1110): the stored row first (:1035), Twelve Data only when it lacks the
  bar (:1057-1105), 1,400 bars a read (`GOLD_BARS`, :1074), the closes from `historyOfBars` (:1051).

### 3.3 Shares: `stockFade` on 15-minute bars (stocks.ts; index.ts:1521-1630)

**Before building, fit these to a real Yahoo `15m` answer** (research/macdfade15-prod-spec.md 3.3 said the same).
The probe .github/workflows/yahoo-probe15.yml (read only: AAPL, 7203.T and 6758.T) decides the items marked "(probe)"
below. **No Yahoo price and no Yahoo answer goes into this repository** (corrected 2026-11-19): the repository is
public, so are its Actions logs, and Yahoo's terms say 「You must not redistribute information displayed on or provided
by Yahoo Finance」 (help.yahoo.com/kb/SLN2310.html). Since d794649 the probe prints only the rows' times and shapes (a
price or null; one price; volume 0 or not), how prices compare (equal or not; inside a bar's low..high or not), the
answers' times (regularMarketTime, currentTradingPeriod, tradingPeriods), and a 5-day skeleton (stamps and shapes). The
tests' fixtures are built from those shapes with made-up prices. (Its first runs, 44081784066, 44535921376 and
44536526466, printed prices and whole answers into the public log; the owner was told.)

Seen (runs 44535921376, 44536526466, 44538415663; 2026-11-19 between 13:41 and 13:56 UTC, after Tokyo's close of 11/19
and before New York's open):
- New York (AAPL): 26 rows a session, 9:30 to 15:45 local. The latest finished session (11/18) has one more row, 16:00,
  of one price and volume 0, equal to regularMarketPrice (regularMarketTime 16:00:01); the session before it (11/17)
  has none. Yahoo already names the next session (currentTradingPeriod.regular 11/19 9:30 to 16:00), so today's
  `parseYahooChart` keeps that 16:00 row as a bar of its own (it is not inside the 15:45 bar and not at or after the
  named session's end).
- Tokyo (7203.T, 6758.T): rows 9:00 to 11:15 (10 bars), then an 11:30 row of one price **with** volume (the morning's
  closing auction; in the older sessions too), null rows 11:45, 12:00 and 12:15, then 12:30 to 15:15 (12 bars). The
  latest finished session (11/19) has one more row, 15:30, of one price and volume 0, equal to regularMarketPrice
  (regularMarketTime 15:30:00); the session before it (11/18) has none. Yahoo still names 11/19's session (00:00 to
  06:30 UTC), so today's `parseYahooChart` joins the 15:30 row to the 15:15 bar (at or after the session's end), and
  keeps the 11:30 row as a one-price bar of its own.
- The answer's `previousClose` (the day before the latest's close, as Yahoo gives it) is not the close of that day's
  last 15-minute bar: Tokyo, outside that bar's low..high (both shares); New York, inside it but not equal. So the
  older sessions' last bars do not carry the closing auction's price.
- Not yet seen (timed reads dispatched for New York's close of 11/19, and Tokyo's lunch and close of 11/20): when the
  closing row and the 11:30 row appear after the bar before them, and regularMarketTime then; whether the latest
  session's closing row stays in the answer while the next session trades.

Changes in stocks.ts:
1. `STOCKMACD_INTERVALS = ["15min"]` (:49). It drives `isStockmacdChart` (:50-52), the run's subscription filter
   (index.ts:1525), the status call (index.ts:2046), `set` / `set_many` (index.ts:2066, :2107) and the rule id (3.7).
2. **Every hard-coded `"1h"` takes the constant.** Left as `"1h"`, nothing is judged and no error shows:
   `parseYahooChart(sym, body, "1h", nowMs)` (:152; the constant also sets `barMs` to 900,000, live-chart/stocks.ts:
   119-121, :148); `isStockmacdChart(sym, "1h")` in `stockFadeClose` (:201) and in `stockSweepOf` (:223); in index.ts
   `fadeSignal("stockmacd", sym, "1h", …)` (:1557) and `yahooChartUrl(sym, "1h")` (:1571).
3. `CLOSES` (:107-110), the regular session's 15-minute closes in the market's time: New York every 15 minutes from
   9:45 to 16:00 (26 closes; bars 9:30 to 15:45); Tokyo 9:15 to 11:30 (10) and 12:45 to 15:30 (12), 22 closes (bars
   9:00 to 11:15 and 12:30 to 15:15). The Tokyo afternoon stamps 12:30 to 15:15: seen (above).
4. `stockBarEnd` (:132-137): the open plus 15 minutes, or the session's end when earlier (a day that ends early). The
   `half` test goes (no 15-minute bar is a half bar).
5. `stockBarBreak` (:233-237): Tokyo's 15:15 bar "close", its 11:15 bar "lunch"; New York's 15:45 bar "close".
6. **The closing points (probe).** `parseYahooChart` joins a last point of volume 0 to the bar before it only while it
   falls inside that bar (`ms - lastMs < barMs`, live-chart/stocks.ts:158) or at or after the session end Yahoo names
   (:159). Its own comment says that on 30-minute and shorter bars a closing point exactly one bar after the row before
   stays a bar of its own (:136-137). On 15-minute bars Tokyo's 11:30 row and 15:30 point and New York's 16:00 point
   sit exactly one bar after the row before (seen, above; Tokyo's 11:30 row has volume and is not the answer's last). Once Yahoo names the next session (seen on Tokyo after its close, docs §8.141),
   such a point would stay a one-point bar. Then the 15:15 (or 15:45, or 11:15) bar would be judged on its close before
   the auction, so the mail's 「取引時間の最後の足は、引けの値段で判定します」 would be wrong; and a stray bar would sit in
   the chart and in the 600-bar window. The probe decides whether a change is needed. If it is, the candidate is: join a
   last volume-0 point exactly one bar after the row before when it falls at a market's close or lunch time. The change
   is in live-chart/stocks.ts and is shared with the chart. **The closing-price condition**: after the fitting (the
   probe's answer, and this change if made), a test with a fixture of the probe's shapes (made-up prices) shows that a session's
   last bar (Tokyo 11:15 and 15:15, New York 15:45) is judged on the closing point. Every text that says a session's
   last bar is judged on its closing price stays only if this holds: the mail's sentence (4.4, item 11) and the
   parenthesis of `stockmacdNotes` [2] (section 5). If it does not hold, both are removed (or rewritten to say what the
   fitted code does, this file corrected first), ja and en alike.
7. `renderStockMail` (:261-330): every hard-coded 「1時間足」 / "1-hour" (en :286, :287, :289, :290, :302 twice; ja :310,
   :311, :313, :314, :326 twice) takes `tfLabel(lang, s.interval)` (logic.ts:322; import it from ./logic.ts as the file
   imports `APP_URL` today, :41). Items 8 and 10 are rewritten (4.4).
8. Comments: :1-32, :105, :129-131, :149-150, :178-184, :230-232, :248-260.
9. Unchanged, decided: `STOCK_POLL_MS` 30 minutes and `STOCK_FRESH_MS` 45 minutes (keeps a Tokyo bar about 16 minutes
   late inside its freshness); the holiday test (:217, no bar in the six hours before the close due). The holiday test
   gives a harmless `no_session` at Tokyo's 9:15 read: with the delay the 9:00 bar is not yet in, so the newest bar is
   the day before's; the 9:00 bar is judged at the 9:30 close's reads.
10. **A run's time budget (new; 2.4 "The stocks run and the other runs share one queue").** In `stockSweep`
   (index.ts:1521-1630): the followed shares are taken oldest read first (by `stockReadAt`, a share never read first),
   so a share left by one run is read first by the next; no Yahoo read is started once `Date.now() - nowMs` has reached
   `STOCK_RUN_BUDGET_MS` = 30,000 (a new constant beside `STOCK_POLL_MS`), and each share left is recorded in `reads`
   as `{ pair, skipped: "budget" }` (its `stockReadAt` not set, so the next run reads it); the run's summary gains
   `took_ms` (`Date.now() - nowMs` when it returns). The longest run is then about 30 seconds, plus one read's
   10-second timeout, plus the mails of the bars judged. The 50-second spacing (index.ts:1567) and everything else of
   the loop stay. (Chosen over reading Tokyo only from about 15 minutes after a close: that would rest on the delay
   measured on one day, 2026-11-06.)

index.ts: `stockFade` (:1543-1563) and the loop (:1564-1630) unchanged but for (2) and (10). Comments :1498-1520.

live-chart/stocks.ts: nothing else changes (`STOCK_INTERVALS` has `15min`, :45; `15m` over `60d`, :51).

### 3.4 The signal, the `signal_alerts` row, the run's record

As research/macdfade1h-prod-spec.md 3.4, with these differences: the row's `interval` is `15min`; `closed_at` is the
bar's open plus 15 minutes (a share: `stockBarEnd`); `rule` the new id (3.7). Today's lines: `fadeSignal`
(indicators.ts:657-679), `signalRow` (:685-701), `rideSignalTag` (:708), the record (index.ts:1003-1013, :1614-1629).
The record's shape does not change; each pair has about four times as many judged entries carrying `fade`.

### 3.5 What else changes, and what stays

- **Nothing goes.** v40's code is the fade already; only what is tied to 1-hour bars changes (3.2, 3.3, 4.3-4.5).
- **The measured paragraph** (`_shared/macd-fade-measured.ts`): 4.5.
- **Stays:** `hourQuotes`, `formingQuotes`, `goldMinutes` and the sharp rise's 1-hour reads (its followers keep the
  1-hour charts followed, whatever `macdx` is on); `mailerFor`, `claimRow`, `mailRide`; `ridePaidAt`; `macdNumbers`;
  logic.ts (`tfLabel` has 「15分足」 / "15-minute", logic.ts:317-322; `RULE_LABEL`, :496-499, has no timeframe; the test
  mail lists each row's own timeframe, :501-519).
- **The app's code:** no change. `FADE_ID` (src/lib/signalAlerts.ts:70) and `RIDE_ID` (:48) read the new ids as v40's
  (checked in node, 3.7); the grid draws the intervals the server sends (src/components/SignalAlertSettings.tsx:234-292,
  src/lib/signalAlerts.ts:293, :296); a row's timeframe comes from its `interval` (SignalAlertSettings.tsx:112, through
  `t.alerts.intervals`: 「15分」 / "15m"). Only the texts change (section 5).
- **The research ledger:** research/ledger/macdfade1h-summary.json stays (the record of v40's numbers; a rollback).
- **The study check** (research/macdfade-prod-check.ts) and its workflow steps take 15-minute bars too (7.2).
- **Tests** (each in the PR that changes what it tests; line numbers read 2026-11-19):
  - Version pins of `signal-alerts-v40-2026-11-18` (3.7).
  - src/test/macd-fade.test.ts: :128-133 (the intervals and ids), :153 (the list of other ids: it gains the two
    1-hour fade ids, written by v40), :162 and :738 (they read this file in place of the 1-hour spec), :317-401 (the
    ledger, its sha256 and size, the run ids, `meta.tf` "15min", the values), the paragraph's texts (SPEC_JA / SPEC_EN,
    BASE_WHAT, CHANCE, the filled pair texts), and the "not 1h" / "outside gap throws" cases (4.5); and a new pin that
    `FADE_MEASURED_TF` (macd-fade-measured.ts, the literal `"15min"`) equals `MACDH_INTERVALS[0]` (4.5: the module
    must not import indicators.ts).
  - src/test/macd-fade-alerts.test.ts: built on 1-hour bars throughout (2,600 1-hour bars, GMO 1-hour files, gold's
    stored 1-hour bars, reads 0/3/5, fresh 30 minutes, the mail texts): rebuilt on 15-minute bars (7.1). Its :135 list
    of other ids gains the 1-hour fade id.
  - src/test/indicator-alerts.test.tsx: the value pin `expect([...MACDH_INTERVALS]).toEqual(["1h"])` (:970) becomes
    `["15min"]`; every `isMacdhChart(…, "1h")` / `isIndicatorChartFor("macdx", …, "1h")` pin (:791, :974-989,
    :1351-1355, :1471, :2127-2128), the fade helper on `"1h"` (:1263), the gold and pair mail texts. Two code-text pins
    of `fadeAtClose` change with 3.2 item 2: :1171 `'if (age < 0 || age > freshFor("1h")) {'` becomes
    `'if (age < 0 || age > freshFor(interval)) {'` (with a pin of `const step = LIVE_STEP_MS[interval]` and `age =
    nowMs - (newest + step)`), and :1174's pattern `await fadeAtClose\(pair, closed, newest, said\);` becomes the call
    with `interval` in it (`fadeAtClose(pair, interval, closed, newest, said)`, the argument order the build picks,
    pinned as built). The code-text pins at :1165-1166 stay word for word.
  - src/test/stockmacd-alerts.test.tsx: :72 (the interval), :87 (other ids: the 1-hour v4 id joins it), :95-102 (`"1h"`
    charts), :382-391, :710, :732, the code-text pins of `"1h"` (:750, :759, :779-783: they pin the constant), the
    settings tab (:843, :858, :884), the replay (:1096, :1132, :1170, :1194 and the read `60m 1y`), the hourly fixtures:
    rebuilt as 15-minute answers with the probe's stamps and shapes and made-up prices (6.3 step 1b; no Yahoo price in
    the repository, 3.3). New: the run's budget (3.3 item 10) and the
    closing-price condition (3.3 item 6).
  - src/test/signal-alert-settings.test.tsx: the `macdx` pins on `"1h"` (:376-437), the notes and intros, the intro's
    and the FAQ's arrival lead (:488-501, which pin 「足が確定してから数分で届きます」 / "It arrives a few minutes after
    the bar closes" / "Within minutes of the bar closing": they pin section 5's new words and that the old lead is
    gone), and the forbidden-number pattern of the FAQ (:516), which gains the 15-minute numbers (6,006; 5,926; 2.41;
    3.31; 3.19; 44,784; 1,913; 2,975; 0.82; 0.90; the new docs section).
  - src/test/econ-mailer.test.ts: the recipients on `"1h"` (:42, :156, :245, :271, :276) become `"15min"`, with a `"1h"`
    `macdx` row now not a recipient.
  - src/test/landing.test.tsx: :128 and :138 read this file; 〔adverse〕 is four sentences (section 5).

### 3.6 No schema migration; the subscriptions get 15-minute twins

- **No DDL.** `'15min'` is allowed by `signal_alert_subscriptions_interval_check` (supabase/migrations/20261011120000_gold_minutes_all_day.sql:113-115,
  the last migration that sets it). The rule check holds `macdx` and
  `stockmacd` (20261105060000_signal_alert_spike.sql:19-21). The unique key is `(user_id, pair, interval, rule)`
  (20260925180000_signal_alert_rules.sql:22-24). `signal_alerts` needs nothing new (research/macdfade1h-prod-spec.md
  3.6, its first item).
- **A data change is needed.** v41 reads, offers and accepts `macdx` and `stockmacd` on `'15min'` only (3.2 item 1, 3.3
  item 1). A row left on `'1h'` gets no mail, and its owner cannot untick it: `set` and `set_many` refuse a chart the
  rule is not offered on (index.ts:2066-2069, :2107), and the grid draws only the server's intervals.
- **How: twins first, the `'1h'` rows later.** Before the function's merge (6.3 step 3), a `'15min'` row is added beside
  every `'1h'` `macdx` and `stockmacd` row, with the same user, pair, rule and `lang`:

  ```sql
  insert into public.signal_alert_subscriptions (user_id, pair, interval, rule, lang)
  select user_id, pair, '15min', rule, lang from public.signal_alert_subscriptions
   where rule in ('macdx', 'stockmacd') and interval = '1h'
  on conflict (user_id, pair, interval, rule) do nothing;
  ```
  - v40 ignores the twins: its filters take `'1h'` only (index.ts:776-778 through `isMacdhChart`; :1525 through
    `isStockmacdChart`). v41 ignores the `'1h'` rows the same way. So no time needs both, and no follower has a gap:
    the twin is there when v41 first answers, whenever that is. (v31's move, one `update` sent about a minute after
    v31 answered, left one run with no subscriptions, docs §8.127.)
  - **The two sets drift apart once the twins are in.** The twins are a one-time copy. A tick or untick changes the
    row of the interval the screen offers only (`set`: index.ts:2066 `isIndicatorChartFor(body.rule, body.pair,
    body.interval)`, the DELETE of that interval only at :2087-2090; `set_many`: :2107, :2123-2127; the grid shows
    only `MACDH_INTERVALS` / `STOCKMACD_INTERVALS`, :2040, :2046). So (a) between the twins and v41's first answer,
    a v40 untick deletes the `'1h'` row and leaves the twin, which v41 would mail although the v40 screen showed the
    chart off (index.ts:2085-2086: nobody should need a subscription to stop mail); a v40 tick makes a `'1h'` row with
    no twin, which v41 would never mail. (b) Under v41, before step 9, an untick leaves the `'1h'` row and a tick makes
    no `'1h'` row, so a rollback to v40 would mail the first and miss the second (6.4 handles it). So the twins go in
    as close to the merge as the steps allow (6.3 step 3: just before it), and **once v41 has answered** (6.3 step 5b,
    right after its first check) the two sets are reconciled once, with the owner's confirmation, T0 being the twin
    statement's time (recorded when sent; the statement's rows carry it as `created_at`, 20260925120000_signal_alerts.sql:16)
    and T1 v41's first answer (from the run's record):

    ```sql
    -- (a1) twins whose '1h' row was unticked under v40 after the twins went in (a '15min' row made before T1 can only
    -- be a twin: v40's set refuses '15min'; after T1 no '1h' row can be unticked: v41's set refuses '1h')
    delete from public.signal_alert_subscriptions t
     where t.rule in ('macdx', 'stockmacd') and t.interval = '15min' and t.created_at < '〔T1〕'
       and not exists (select 1 from public.signal_alert_subscriptions h
                        where h.user_id = t.user_id and h.pair = t.pair and h.rule = t.rule and h.interval = '1h');
    -- (a2) '1h' rows ticked under v40 after the twins went in (from a minute before T0, on the safe side: a row that
    -- has its twin already is left as it is)
    insert into public.signal_alert_subscriptions (user_id, pair, interval, rule, lang)
    select user_id, pair, '15min', rule, lang from public.signal_alert_subscriptions
     where rule in ('macdx', 'stockmacd') and interval = '1h' and created_at >= '〔T0 less one minute〕'
    on conflict (user_id, pair, interval, rule) do nothing;
    ```
    Counted before and after per rule, pair and interval (`select rule, pair, interval, count(*) from
    public.signal_alert_subscriptions where rule in ('macdx', 'stockmacd') group by 1, 2, 3`), with no user ids. After
    it each `'15min'` count should equal its `'1h'` count; a difference left can only be a tick or untick under v41
    since T1, and is written down as it is (docs §8.156). Sending it soon after T1 keeps (a) small; whether any row was
    ticked or unticked between T0 and T1 is read from these counts, not assumed.
  - The econ digest goes once to each person with a `macdx` row on `isMacdhChart` (econ-calendar/mailer.ts:83-95). With
    both rows there, the same people get it before and after econ-calendar is deployed again.
  - `on conflict … do nothing`: a `'15min'` row a follower already has (none can exist under v40, whose `set` refuses
    it) is left as it is. Sent once; a second send adds nothing.
  - The counts are read before and after, with no user ids, per rule, pair and interval: `select rule, pair, interval,
    count(*) from public.signal_alert_subscriptions where rule in ('macdx', 'stockmacd') group by 1, 2, 3`. After: each
    rule and pair's `'15min'` count equals its `'1h'` count.
  - Later (6.3 step 9), once v41 has run clean: `delete from public.signal_alert_subscriptions where rule in ('macdx',
    'stockmacd') and interval = '1h'`, counted the same way before and after. Not before econ-calendar is deployed again
    (else its recipients drop to none until it is).
  - These statements (the twins, the reconcile, the later delete, and 6.4's) are sent by hand **with the owner's confirmation** (the Supabase connector asks the owner; a
    connector timeout is not proof that nothing ran, so the counts are read back; or the owner runs it in the SQL
    Editor). They are recorded word for word in docs §8.156, not as files under supabase/migrations/ (nothing applies
    those automatically, but a data statement there would read as part of the schema). How many rows there are, and on
    which interval, is not read here (production not read).
  - While both rows exist: the test mail lists each chart twice, 「1時間足」 and 「15分足」 (index.ts:2151-2158 reads every
    row); a rollback finds the `'1h'` rows still there, but out of date by every tick and untick under v41, so 6.4
    rebuilds them from the `'15min'` rows before reverting.
- **The screen** offers what the server says: once v41 answers, the `macdx` and `stockmacd` grids show one `15min`
  column, ticked where the twin is. No app code change.
- **The econ digest** follows `isMacdhChart` once econ-calendar is deployed again by name (6.3 step 6). Its footer
  names no timeframe (econ-calendar/digest.ts:425, :455): no text change.

### 3.7 Ids and version

| | id | built |
|---|---|---|
| pairs and gold | `macdx_12_26_9_w600_15min_fade96of120_in_v12` | `fadeRuleId("macdx", MACDH_INTERVALS[0], 12)` (`MACDH_FADE_VERSION`, indicators.ts:168) |
| shares | `stockmacd_12_26_9_w600_15min_fade96of120_in_v5` | `fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], 5)` (`STOCKMACD_FADE_VERSION`, stocks.ts:59) |

`fadeRuleId` (macd-fade.ts:45-46) puts the interval in the id from the constant, so `MACDH_INTERVALS` and
`STOCKMACD_INTERVALS` give `15min`. **The version numbers are raised: 11 → 12 and 4 → 5.** Why:
- research/macdfade1h-prod-spec.md 3.7 chose "a number no id ever written holds" (indicators.ts:161-163 says the same). Since 2026-11-18 v40 writes `…_1h_fade96of120_in_v11` and `…_1h_fade96of120_in_v4` in production.
  So 11 and 4 are written numbers now; the next free ones are 12 and 5.
- Every earlier change of the MACD email's chart raised the number: v6 (1 hour) → v7 (15 minutes, v31, docs §8.127) →
  v8 (1 hour again, v33; not v6 again, "so the days on the 15-minute chart stay apart in the record", indicators.ts:
  131-136).
- The never-built strings of 2026-11-17, `macdx_…_15min_fade96of120_in_v11` and `stockmacd_…_15min_fade96of120_in_v4`
  (research/macdfade15-prod-spec.md:264-265), stay the record of that spec. Today's tests list them as other ids
  (src/test/macd-fade.test.ts:153, src/test/stockmacd-alerts.test.tsx:87, src/test/macd-fade-alerts.test.ts:135);
  they keep that meaning.
- A `git grep` of the repository (2026-11-19) for `(macdx|stockmacd)_12_26_9_w600_` finds the ids of
  research/macdfade1h-prod-spec.md 3.7 and the two 1-hour fade ids; no `macdx` id holds v12 and no `stockmacd` id holds
  v5. So each new id names one rule.
- Checked in node with copies of the app's regexes: neither new id matches `RIDE_ID` (src/lib/signalAlerts.ts:48);
  both match `FADE_ID` (:70) with pct 96, and `ruleOfId` (:33-37) sends them to the `macdx` and `stockmacd` tabs.

`FUNCTION_VERSION` (index.ts:368) → `"signal-alerts-v41-<the deploy's date>"`, with a v41 note in the header (beside
:344-367). The seven test files pinning v40 change: src/test/amdpo3-alerts.test.tsx:138, emarm-alerts.test.tsx:181,
indicator-alerts.test.tsx:1194, macd-fade-alerts.test.ts:1135, spike-alerts.test.tsx:257, stockmacd-alerts.test.tsx:726
and :1120, sweepx-alerts.test.ts:295.

## 4. The emails

### 4.1 Rules for every text

As research/macdfade1h-prod-spec.md 4.1, word for word, with today's lines: the pairs' and gold's how-to-stop line is
indicators.ts:1484 / en :1458; the shares' is stocks.ts:328 / en :304; the econ footer is econ-calendar/digest.ts:425 /
:455 (unchanged: it names no timeframe). One addition: no text writes Tokyo's delay as more than 「約15分」 / "about 15
minutes" (the measured value), and no text says how many minutes after the close a 15-minute mail is sent unless it says
that this was not measured.

### 4.2 Subjects

The timeframe comes from `tfLabel` (logic.ts:317-322):
- Pairs and gold: 「【Sextant】ドル/円 15分足 売り（SELL）: 青い線が上の端の96%で確定（MACD の逆張り）」 (bottom: 「買い（BUY）:
  青い線が下の端の96%で確定」); en "[Sextant] USD/JPY 15-minute SELL: the MACD line closed at 96% of the top (MACD fade)"
  (indicators.ts:1437, :1463).
- Shares: 「【Sextant】〔name〕（〔code〕）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）」; en "[Sextant]
  〔name〕 (〔code〕) 15-minute SELL (short sale): the MACD line closed at 96% of the top (Stock MACD)" (stocks.ts:286, :310,
  which take `tfLabel`, 3.3 item 7).

### 4.3 The pairs' and gold's email (`renderFadeMail`, indicators.ts:1421-1486)

Items 1 to 7 and 11: as research/macdfade1h-prod-spec.md 4.3, with 「1時間足」 / "1-hour" read as 「15分足」 /
"15-minute". They take `tfLabel`, so they change by themselves (indicators.ts:1431). The source line of item 11 then
reads 「上の値段は、同じ15分足の売値・買値の終値です。」 / "the price above is the same 15-minute bar's bid or ask close."
(:1483 / :1457).

8. (rewritten; indicators.ts:1473-1476 / en :1447-1450) A pair: 「このメールは、足の確定の直後・1分後・3分後の読み込みで判定
   して送ります（実際に何分で届くかは測っていません）。」 Gold: 「このメールは、足の確定の1分後から、次の足が確定するまで（確定
   から15分より前）の間に判定して送ります（実際に何分で届くかは測っていません）。」 Then both, as today: 「届いた時の値段は、
   上の終値と違うことがあります（その差は測っていません）。週末の止まっている時間（日本時間 土曜6:00〜月曜7:00）に確定した足は
   判定しません。」 (The reads: `gmoIntervalsDue`, indicators.ts:1028; gold's window: `twelveCloseDue`, :1106-1113.)
9. Pairs: the measured paragraph (4.5). Gold: as research/macdfade1h-prod-spec.md 4.3 item 9, word for word.
10. (rewritten; :1480 / en :1454) 「この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の
    確定で判定すること・メールを15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き・利確と損切りの
    値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。」 The pane is
    now the owner's choice (2026-11-17, section 1), so it is attributed to the owner, unlike the 1-hour text.

en, the items that change:
8. A pair: "This email is judged and sent at the reads right after the bar closes and 1 and 3 minutes after (how long it
   takes to arrive has not been measured)." Gold: "This email is judged and sent from 1 minute after the bar closes
   until the next bar closes, under 15 minutes after it (how long it takes to arrive has not been measured)." Then both,
   as today: "The price when it arrives may differ from the close above (the difference has not been measured). Bars
   that close in the weekend pause (Friday 21:00 to Sunday 22:00 UTC) are not judged."
10. "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging the email on
    15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side and stating no take-profit or stop
    price are the app owner's choices. That pane is the same as the app's 15-minute chart's."

### 4.4 The shares' email (`renderStockMail`, stocks.ts:261-330)

Items 1 to 7, 9 and 11: as research/macdfade1h-prod-spec.md 4.4, with 「1時間足」 / "1-hour" read as 「15分足」 / "15-minute"
(they take `tfLabel`, 3.3 item 7). The closing-price sentence of item 11 (「取引時間の最後の足は、引けの値段で判定します。」 /
"a session's last bar is judged on its closing price", stocks.ts:327 / :303) stays only if the closing-price
condition of 3.3 item 6 holds (the probe's answer, as fitted); otherwise it is removed, ja and en. The same condition
governs the parenthesis of `stockmacdNotes` [2] (section 5).

8. (rewritten; stocks.ts:321-324 / en :297-300) A US share: 「このメールは、足の確定の後の読み込みで判定して送ります（読み込み
   で判定するのは、その時に確定している一番新しい足だけです。確定から45分を過ぎた足は送りません。実際に何分で届くかは測って
   いません）。」 / "This email is judged and sent at a read after the bar closes (a read judges only the newest bar closed by
   then; a bar more than 45 minutes past its close is not sent; how long it takes to arrive has not been measured)." A
   Tokyo share: 「東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、
   このメールは足が確定してから15分ほど後に判定して送ります（15分足で実際に何分後になるかは、まだ測っていません）。」 / "Yahoo's
   Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so this email is judged and sent
   some 15 minutes after the bar closed (how many minutes on 15-minute bars has not been measured yet)." Then every
   share, as today: 「届いた時の値段は、上の終値と違うことがあります（その差は測っていません）。」 / "The price when it arrives may
   differ from the close above (the difference has not been measured)."
10. (rewritten; :326 / en :302) 「この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で
    判定すること・株も15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き（株にも当てはめること）・
    利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。」 /
    "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging shares on 15-minute
    bars too, the MACD pane of the newest 120 15-minute bars, the fade side (shares included) and stating no take-profit
    or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's." (The shares'
    15-minute bars and the pane are the owner's choices of 2026-11-17 and 11-19, section 1.)

### 4.5 The measured paragraph (pairs only; `FADE_MEASURED`, `fadeMeasuredLine`)

**Corrected 2026-11-19 (step 4 below happened).** The numbers are the study's 15-minute re-run on GMO's files read
afresh: Actions run 44535888012 on main 9ca2054, recorded in research/macdfade15-spec.md :442-500, its summary.json in
**research/ledger/macdfade15-summary.json** (sha256 `eacb7815d7779be716b24e559c0aea139e6455910abcf4b1ec59ab4d8c5eb188`,
16,817 bytes; without the bytes `,\n  "tf": "15min"`, `74a4a230a291d68a8e8169ea293a5428f46863ffc0ed86804522f4f509cc888b`;
rows.csv `b73115a0668b3c50b76f2f4507095adac8423e7ae08a9d68a5309d6cddfb0f37`). The Python agreed with every row and
number. The first real run (44077464383 on fff5ddb, research/macdfade15-spec.md :406-440; rows.csv `f2d27000…5856`,
summary.json `76c86aa8…1e61e0`) read three GMO 1-minute day files of 2025-06-20 that had been kept cut short (59 bars of
1,440: AUD_JPY bid, EUR_USD bid, USD_JPY ask; gmo-cache-diff run 44546585012). The re-run reads them whole. The fade's
and the flow's trades, counts, pips, open trades, worst and longest are the same; the baseline gains 552 trades (+3.31
→ +3.32 a trade), the fade's time to the target is a little shorter (median 144 → 143 minutes, P90 5,740 → 5,681), and
fade − base is −0.91 (was −0.90). Run 44077464383's file is reproduced by the branch's run 44537377516 from the
branch's caches (the same three short files; without its `tf` line, `76c86aa8…`). The 1-hour numbers
(research/ledger/macdfade1h-summary.json) are not these.

**How the file gets into research/ledger (route 1, as research/macdfade1h-prod-spec.md 4.5 took it for 1 hour).**
.github/workflows/macdfade15.yml already prints summary.json whole as one base64 line, with its sha256 and size
(:313-316, step "summary.json whole (base64, one line)"; it has no TF condition). A push runs `TF=1h` only (:80), so the
15-minute run is a `workflow_dispatch` with `tf` `15min` and the defaults `share` 0.96 and `tp` 10 (:61-74). Its real
job reads GMO's files from the caches (or fetches them), runs the study and the Python, and prints. Then:
1. The base64 line is copied from the job's log and decoded in the development container into
   **research/ledger/macdfade15-summary.json**. Its sha256 and size must equal the job's printed ones.
2. **Its sha256 is checked against run 44077464383's.** The re-run's file is not byte for byte that run's: 53f7003 added
   `tf` to `meta` (research/macdfade15.ts:537; research/macdfade15-spec.md :347-349: with `TF=15min` every other byte
   is as before). The file is `JSON.stringify(summary, null, 1)` (research/macdfade15.ts:746), so `meta` ends
   `"tp": 10,\n  "tf": "15min"\n },`. Removing the exact bytes `,\n  "tf": "15min"` (17 bytes) must give a file whose
   sha256 is `76c86aa8fa1e4bce9e8ea77418bd32cd043166a5a420a2958747943f932a61e0`. The printed rows.csv sha256 must be
   `f2d27000…5856`. **(2026-11-19: main's run 44535888012 gave `74a4a230…` and `b73115a0…`; step 4 was taken.)**
3. The printed lines are read against research/macdfade15-spec.md :416-436, every number. The walks' ranges printed
   beside the gaps must be −0.80..+2.24 (fade − base) and −2.25..+5.70 (fade − flow). null.json's sha256 is printed
   (:309) and recorded (the 15-minute run's is recorded nowhere yet).
4. **If any of 1-3 fails, nothing is built.** A difference means GMO's files are not those of run 44077464383 (the
   caches evicted and files fetched again, or GMO changed a file). The re-run's numbers are then new measurements: they
   are recorded in research/macdfade15-spec.md as a new result section and told to the owner before anything goes on.
   **Taken 2026-11-19:** the cause was found (three short files in the branch's caches, above), the re-run on the whole
   files is the run of record (research/macdfade15-spec.md :442-500), its walks' ranges are the same (−0.80..+2.24 and
   −2.25..+5.70), and the owner was told. The study check (7.2) now holds summary.json to `74a4a230…` without its `tf`
   line and to the ledger copy whole, and restores run 44535888012's cache last on `15min` so a branch run reads the
   whole files.
5. `FADE_MEASURED` is written out from the ledger copy by a script (not copied by hand), and a test reads the copy and
   pins every value of `FADE_MEASURED` to it: `meta.tf` `"15min"`, `meta.share` 0.96 and `meta.tp` 10 included.
   `FADE_MEASURED_SOURCE` (macd-fade-measured.ts:73-80): run 44535888012, commit 9ca2054 (main), the first run
   44077464383 and why it was replaced (three short GMO files), `research/ledger/macdfade15-summary.json`, the copy's
   sha256 (with its `tf` line).

docs §8.156 records the run ids, both sha256 (with and without the `tf` line), null.json's and that route 1 was taken.

**The values** (the ledger copy's, run 44535888012; the build writes them by the script):

| slot | summary.json | value, written as the code writes it |
|---|---|---|
| 〔from〕, 〔to〕 | `meta.start`, `meta.end` | as the 1-hour run's: ja 「2024年1月1日 0:00（UTC）」, 「2026年11月10日 21:00（UTC）」; en "1 January 2024, 00:00 UTC", "10 November 2026, 21:00 UTC" |
| 〔trades〕, 〔tp〕, 〔open〕 | `dirs.fade.all.trades`, `.tp`, `.open` | 6,006 / 5,926 / 80 |
| 〔mean〕 | `dirs.fade.all.pipsMean` | +2.41 |
| 〔maeMedian〕, 〔maeMax〕 | `.maeMedian`, `.maeMax` | 11.9, 2,975.8 (P90 104.0, not in the paragraph) |
| 〔tpMedian〕, 〔tpP90〕, 〔tpMax〕 | `.tpMinutesMedian`, `.tpMinutesP90`, `.tpMinutesMax` | 143, 5,681, 784,561 minutes: ja 「約2時間」「約4日」「約545日」, en "about 2 hours", "about 4 days", "about 545 days" |
| 〔openPipsSum〕, 〔openPipsWorst〕, 〔openLongest〕 | `.openPipsSum`, `.openPipsWorst`, `.openMinutesMax` | −44,784.5, −1,913.4, 959,205 minutes: ja 「約666日」, en "about 666 days" |
| 〔flowMean〕 | `dirs.flow.all.pipsMean` | +3.19 |
| 〔baseMean〕 | `base.all.pipsMean` (704,630 trades) | +3.32 |
| 〔pairMean〕 (〔pairBaseMean〕) | `dirs.fade.<pair>.pipsMean`, `base.<pair>.pipsMean` | USD/JPY +2.67 (+5.69), EUR/JPY +1.29 (+3.41), AUD/JPY −0.82 (−0.30), EUR/USD +3.86 (+2.60), AUD/USD +4.94 (+5.18) |
| 〔negPairs〕 | as the 1-hour spec | ja 「豪ドル/円（-0.82 pips）」, en "AUD/JPY (-0.82 pips)" |
| 〔notMailed〕 | the sum of `pairs[].notMailed` | 3 (USD/JPY, AUD/JPY and AUD/USD one each) |
| 〔sec〕 | the docs §8 section of the release | 8.156 (the next section after §8.155; if another section takes it first, the next free one, written at the release) |
| 〔gapBase〕, 〔gapFlow〕 | `fade.pipsMean − baseMean`, `fade.pipsMean − flowMean`, unrounded, then to 2 decimals with the sign | -0.91, -0.78 (the print's gaps, research/macdfade15-spec.md :430-431) |
| 〔baseLo〕〜〔baseHi〕, 〔flowLo〕〜〔flowHi〕 | not in summary.json: the walks' ranges as printed, held in `FADE_MEASURED.chance` | -0.80〜+2.24, -2.25〜+5.70 |

Durations, signs, thousands separators and the minus as research/macdfade1h-prod-spec.md 4.5 (the code's rules,
macd-fade-measured.ts:181-217). The durations above were worked out with those rules from the printed minutes; a
median stored with .5 would not change their words. The table's "−" is this file's typography; the code writes "-".

**Read against the numbers (2026-11-19, the re-run's):** the fade's mean (+2.41) is below the no-signal baseline (+3.32) and below
entering the other way (+3.19). Fade − base is −0.91 pips a trade, below the ten driftless walks' range (−0.80..+2.24);
fade − flow is −0.78, inside its range (−2.25..+5.70). With `END` a week earlier the order is the same (fade +1.96, flow
+2.73, base +2.98). Four of the five pairs' fade means are below their baselines (only EUR/USD's is above). By side,
bottom (BUY) 2,956 trades +6.29 a trade, top (SELL) 3,050 trades −1.35 a trade. So no sentence says the fade did better
than no signal or than the other way, and 〔chance〕 says it did worse than no signal (below). On 1-hour bars fade − base
was +0.06, inside its range; the 15-minute result is worse. About 40 entries a week over the five pairs (6,006 over the
2 years and 10 months measured), against about 10 on 1-hour bars (1,490): about four times the mail. These are the
study's counts, not a new measurement.

- 〔baseWhat〕 「このメールが判定する15分足ごとの最初の1分に（買いと売りを1回ずつ）」 / "at the first minute of every 15-minute bar this email judges (a BUY and a SELL)": the study's baseline takes only the bars that are judged and mailed (research/macdfade15-spec.md "The same trade with no signal"), about 14 minutes before a signal at the same bar would be, so the same holding with no signal, not the same entry; the parenthesis after 〔baseMean〕 says so.
- The 〔open〕 = 0, 〔tp〕 = 0 and 〔trades〕 = 0 variants: as research/macdfade1h-prod-spec.md 4.5, word for word.

ja: 「測った数字（5ペア、〔from〕以後、〔to〕より前に確定した15分足、スプレッド込み、docs §〔sec〕）。過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。このメールの決まりで足の終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていません）: 合図は〔trades〕回、うち〔tp〕回が+10 pips に届きました。〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕持ったままでした（その後は追っていません）。1回あたり平均〔mean〕 pips（届いていないものは、その時の含み損益で数えました）。途中の含み損は中央値〔maeMedian〕 pips、最大〔maeMax〕 pips。+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。足の終値で入るので指値ではなく、入らなかった注文はありません（メールした合図はすべて入ったとして数えました）。損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり〔flowMean〕 pips、合図なしで〔baseWhat〕入ると〔baseMean〕 pips でした（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく15分足の最初の1分に入ったもので、同じ入りではありません）。〔chance〕〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。平均がマイナスだったペア: 〔negPairs〕。ほかに〔notMailed〕回、週末の止まっている時間に確定した足に合図がありましたが、このメールでは判定しないので、上の数字に入れていません。」

en: "Measured (five pairs, 15-minute bars that closed from 〔from〕 up to, not including, 〔to〕, spread paid, docs §〔sec〕). It re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured). Entered by this email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this email states no take-profit price): 〔trades〕 signals, of which 〔tp〕 reached +10 pips. 〔open〕 had not reached it by 〔to〕; their unrealised result was 〔openPipsSum〕 pips in all (a minus is a loss), the worst 〔openPipsWorst〕 pips, the longest held 〔openLongest〕 (not followed after that). The mean was 〔mean〕 pips a trade (those not reached counted at their unrealised result then). The largest loss on the way: median 〔maeMedian〕 pips, largest 〔maeMax〕 pips. Time to +10 pips: median 〔tpMedian〕, longer than 〔tpP90〕 one time in ten, longest 〔tpMax〕. The entry is at the bar's close, not a limit order, so no order went unfilled (every signal emailed is counted as entered). With no stop, the share reaching +10 pips comes out high by construction. Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave 〔flowMean〕 pips a trade, and entering with no signal 〔baseWhat〕 gave 〔baseMean〕 pips (held the same way, +10 pips and no stop, but entered at the 15-minute bar's first minute, not at its close, so not the same entry). 〔chance〕 On 〔pair〕 alone the mean was 〔pairMean〕 pips (with no signal, 〔pairBaseMean〕 pips). Pairs whose mean was below zero: 〔negPairs〕. Besides these, 〔notMailed〕 signals fell on bars that closed in the weekend pause; this email does not judge those bars, so they are not in the numbers above."

The two texts are research/macdfade1h-prod-spec.md 4.5's with only these changes: 「確定した1時間足」 → 「確定した15分足」,
「1時間足の最初の1分」 → 「15分足の最初の1分」; "1-hour bars that closed" → "15-minute bars that closed", "the 1-hour bar's
first minute" → "the 15-minute bar's first minute". In the code (macd-fade-measured.ts:300, :313, :325, :336 and
〔baseWhat〕 :224-228) the bar's word comes from `m.tf` ("15min" → 「15分足」 / "15-minute"; "1h" → 「1時間足」 / "1-hour";
any other value stops the build), and the check at :265 becomes `if (m.tf !== FADE_MEASURED_TF) throw …`, with
`export const FADE_MEASURED_TF = "15min"` a literal in macd-fade-measured.ts. **It must not read `MACDH_INTERVALS`**
(indicators.ts:268, its only definition): indicators.ts imports this module (indicators.ts:40), and this module runs
`paragraphOf` at load through `FADE_MEASURED_NOTES` (:353-356). In production indicators.ts is always entered first
(signal-alerts/index.ts:76-82, econ-calendar/mailer.ts:13, live-chart/index.ts:110; the bench's sim11.ts:9), so an
import back would read `MACDH_INTERVALS` before indicators.ts has set it: a `ReferenceError` ("Cannot access
'MACDH_INTERVALS' before initialization") while the modules load, and signal-alerts (every rule's mail), econ-calendar
and live-chart would not start (a minimal ESM model of the cycle in node, 2026-11-19, fails that way). The module keeps
importing nothing from signal-alerts (today only ./pair-names.ts, :30). A test pins `FADE_MEASURED_TF` equal to
`MACDH_INTERVALS[0]` (src/test/macd-fade.test.ts, which may import both; 3.5).

**The notes' version:** as research/macdfade1h-prod-spec.md 4.5 "The notes' version", word for word (the same
changes, no others), on the texts above. A test pins it word for word.

**〔chance〕 for these numbers: fade − base below the walks' range, fade − flow inside it.** Today `chanceOf`
(macd-fade-measured.ts:237-246) writes only the "both inside" sentence and throws on any other case. With the 15-minute
numbers it would throw while the module loads (`FADE_MEASURED_NOTES`, :353-356), so the function and every test that
imports it would fail. So `chanceOf` gets this branch, written word for word below, with the slots of the table above.
The "both inside" sentence stays as research/macdfade1h-prod-spec.md 4.5 writes it. Any other case still stops the
build. The case is chosen from the unrounded gaps against the ranges held in `FADE_MEASURED.chance` (fade − base below
`lo`, fade − flow within `[lo, hi]`).

The sentence, ja 「合図なしとの差（この決まり − 合図なし）は1回あたり〔gapBase〕 pips で、合図なしで入った時より低くありました。値動きに傾きのない作り物の値段10本で同じように測った差は〔baseLo〕〜〔baseHi〕 pips で、この差はその幅より下（合図なしより悪い側）でした。逆向きとの差は〔gapFlow〕 pips で、10本の幅（〔flowLo〕〜〔flowHi〕 pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。」 en "The difference from no signal (this rule less no signal) was 〔gapBase〕 pips a trade: lower than entering with no signal. The same difference measured on ten made-up price walks with no trend ranged from 〔baseLo〕 to 〔baseHi〕 pips, and this one was below that range (on the side of doing worse than no signal). The difference from the other way was 〔gapFlow〕 pips, within the walks' range (〔flowLo〕 to 〔flowHi〕 pips; a range chance alone gives, so it is not shown to do better or worse than the other way). Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's)."

Filled with the 15-minute numbers, ja 「合図なしとの差（この決まり − 合図なし）は1回あたり-0.91 pips で、合図なしで入った時より低くありました。値動きに傾きのない作り物の値段10本で同じように測った差は-0.80〜+2.24 pips で、この差はその幅より下（合図なしより悪い側）でした。逆向きとの差は-0.78 pips で、10本の幅（-2.25〜+5.70 pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。」 en "The difference from no signal (this rule less no signal) was -0.91 pips a trade: lower than entering with no signal. The same difference measured on ten made-up price walks with no trend ranged from -0.80 to +2.24 pips, and this one was below that range (on the side of doing worse than no signal). The difference from the other way was -0.78 pips, within the walks' range (-2.25 to +5.70 pips; a range chance alone gives, so it is not shown to do better or worse than the other way). Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's)."

(The gaps written are the unrounded differences to 2 decimals, which is how the study's print writes them,
research/macdfade15.ts gap and `fmt`; a test pins them to −0.91 and −0.78. The walks' ranges are held as printed. The
sentence holds 「−」 as a word, 「この決まり − 合図なし」, not as a number's sign.)

## 5. The screen and the sales page

- **Id parse, tag, plan line:** no change. `FADE_ID = /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/`
  (src/lib/signalAlerts.ts:70) reads the new ids; the tags (`ruleTagFade`, ja:2237 / en:2140) and the plan line stay; a
  row's timeframe reads 「15分」 / "15m" from its `interval` through `t.alerts.intervals` (SignalAlertSettings.tsx:112;
  ja:2099 / en:1995). v40's 1-hour fade rows keep reading as fade rows, 「1時間」 / "1h". No code change.
- **Notes and intros** (ja and en, the same keys and array lengths, src/test/i18n.test.ts:35-39). Only what is tied to
  1-hour bars changes; everything else stays word for word. The v31 diff (19d049a, src/lib/i18n) is the precedent for
  the 15-minute wording.
  - Card intro (ja:2090 / en:1987), the lead too: today's 「足が確定してから数分で届きます」 / "It arrives a few minutes
    after the bar closes" states an arrival time that was not measured, and the parenthesis after it (gold judged until
    the next close, up to about 14 minutes) would contradict it; so it goes. The whole text, ja:
    「チェックしたチャートで、下で選んだ種類（RSI＋SAR・GA型・Q-Trend・ULTRA・MACD の逆張り・流動性狩り＋EMAクロス）の買い（BUY）・売り（SELL）のサインが出たら、${email} にメールでお知らせします。足が確定した後の読み込みで判定して送ります（MACD の逆張りは、5ペアは確定の直後・1分後・3分後の読み込みで、金は確定の1分後から、次の足が確定するまでの間に判定して送ります。実際に何分で届くかは測っていません）。」
    en: "When the kind chosen below (RSI + SAR, GA style, Q-Trend, ULTRA, MACD fade or Liquidity sweep + EMA cross) fires a BUY or SELL on a chart you tick, we email ${email}. It is judged and sent at a read after the bar closes (the MACD fade is judged and sent on the five pairs at the reads right after the close and 1 and 3 minutes after, and on gold from 1 minute after the close until the next bar closes; how long it takes to arrive has not been measured)."
  - `indicatorIntro.macdx` (ja:2118 / en:2013): every 「1時間足」 / "1-hour" becomes 「15分足」 / "15-minute" (five times),
    and the owner's sentence is item 10's of 4.3 (the pane attributed to the owner).
  - `indicatorIntro.stockmacd` (ja:2127 / en:2022): 「1時間足」 / "1-hour" → 「15分足」 / "15-minute" (twice).
  - `macdxNotes` (ja:2139-2153 / en:2034-2048), item by item. Each item that changes is written out whole, ja and en
    (the same facts and the same "not measured" words in both; the tests pin both, 7.1):
    - [0] (ja:2140 / en:2035) the charts and the reads, with one sentence added at its end (〔switch〕 the time of v41's
      first answer, written at the release). ja:
      「ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金の15分足だけで判定します（オーナーが選んだ5ペアと、あとから足した金）。足が確定した後、5ペアは確定の直後・1分後・3分後（毎時0分・15分・30分・45分と、その1分後・3分後）の読み込みで、金は確定の1分後から、次の足が確定するまで（確定から15分より前まで）の間に判定して送ります（実際に何分で届くかは測っていません）。届いた時の値段は、メールに書いた値段と違うことがあります（その差は測っていません）。2026年11月18日から〔switch〕（UTC）までは、メールを1時間足で判定していました。」
      en: "Judged on the 15-minute chart of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold only (the five pairs the owner chose, and gold added since). After the bar closes it is judged and sent: the five pairs at the reads right after the close and 1 and 3 minutes after (0, 15, 30 and 45 minutes past each hour, and 1 and 3 minutes after those), gold from 1 minute after the close until the next bar closes, under 15 minutes after it (how long it takes to arrive has not been measured). The price when it arrives may differ from the price in the email (the difference has not been measured). From 18 November 2026 to 〔switch〕 UTC the email was judged on 1-hour bars."
    - [1] (ja:2141 / en:2036) gold's reads; only the last two sentences change (v31's wording, 19d049a). ja:
      「金の足は Twelve Data のものです（GMOコインに金がないため。Twelve Data の1日の読み込み回数は、チャートや金のほかの通知と分け合っています。1日の上限に達した日は、足を読めずに、金のメールが出ないことがあります）。足は小数2桁に丸めた値で、MACD もその値で計算します。確定の1分後から判定します。足は、すでに保存されている足（チャートや、サーバーの前回までの確認が読んで保存したもの）にその足があればそれを使い（金のチャートを開いていると、確定の数秒後に保存されることがあります）、なければ Twelve Data から読みます。読めたのに足がまだ無い時は、確定の約4分後にもう1回だけ読み、それでも無ければその足は送りません。読み込みそのものが失敗した時は、次の足が確定するまで（確定から15分より前まで）、1〜3分おきに読み直します。次の足が確定した後は、その前の足は送りません。」
      en: "Gold's bars are Twelve Data's (GMO Coin does not carry gold; Twelve Data's daily allowance of reads is shared with the chart and gold's other alerts, and on a day it runs out the bar cannot be read and no gold email may come). The bars are rounded to 2 decimals and MACD is worked out on those. Judging starts a minute after the close. The bar is taken from the bars already stored (read and kept by the chart or by the server's earlier checks) if they have it (a gold chart left open may have kept it a few seconds after the close), otherwise it is read from Twelve Data. If the read works but the bar is not there yet, it is read once more about four minutes after the close, and if it is still not there the bar is not sent. If the read itself fails, it is tried again every one to three minutes until the next bar closes (under 15 minutes after the close); once the next bar has closed, the one before it is not sent."
    - [2] (ja:2142 / en:2037). ja: 「金の足は、確定の直後（数秒後〜1分後）に読んだ足が、あとで読み直した足と同じかは、まだ確かめていません。金の15分足を、本番で確定の何秒後に送るかも、まだ見ていません。」
      en: "Whether a bar read soon after its close (a few seconds to a minute) is the same as one read again later has not been checked, and how many seconds after the close gold's 15-minute alert is sent has not been seen in production yet."
    - [7] (ja:2147) the measured paragraph's notes' version (4.5), 15-minute, ja and en (`FADE_MEASURED_NOTES`).
    - [10] (ja:2150 / en:2045) the owner's sentence as 4.3 item 10 (the pane now the owner's choice). ja:
      「利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・メールを15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。通知は注文の指示ではありません。届いたサインの成績（+10 pips に届いたかどうかも）は、記録も表示もしていません。」
      en: "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop. This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging the email on 15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's. An alert is not an instruction to trade. The alerts' results (whether one reached +10 pips included) are not recorded or shown."
    - [11] (ja:2151 / en:2046) the weekend bars (v31's counts, 19d049a; 2.4). ja:
      「週末は、判定しない時間を広めに取っています。金曜 21:00 UTC（日本時間 土曜 6:00）以後、日曜 22:00 UTC（日本時間 月曜 7:00）より前に確定する足は判定しないので、週末の前の最後の足は判定されません（米国の夏時間は金曜 20:45〜21:00 UTC の1本、冬時間は金曜 20:45〜22:00 UTC の5本）。」
      en: "The time over the weekend when nothing is judged is drawn wide: a bar that closes at or after Friday 21:00 UTC (Saturday 6:00 Japan time) and before Sunday 22:00 UTC (Monday 7:00 Japan time) is not judged, so the last bar before the weekend is not judged either (in US summer time the one bar 20:45–21:00 UTC on Friday, in winter time the five bars 20:45–22:00 UTC)."
    - [12] (ja:2152 / en:2047) gold's break. On 1-hour bars the break's bar closed at its end (22:00 UTC in summer
      time), so only the mail of the bar closing at its start came during it; on 15-minute bars the break's bars close
      inside it and are judged (2.4), so their mails come during it too: in US summer time the bars closing 21:00,
      21:15, 21:30 and 21:45 UTC (the break's four near-flat bars open 21:00 to 21:45, §8.127 at OPERATIONS.md:11826;
      the one closing at 22:00 is judged from 22:01, after it). ja:
      「金は、毎日の休み（1時間。15分足では4本）の足と、日曜に市場が開く前の足（日曜 22:00 UTC 以後に確定するもの）にも、Twelve Data がほとんど動かない足を返すので、それらの足は判定します（合図が出れば送ります）。金曜の引け後の足（15分足では4本）と、日曜の市場が開く前の数時間の足（日曜 22:00 UTC より前に確定するもの）は、判定はしませんが、MACD の計算と、新しい120本には入ります。これは、保存された1時間足（2026年8月16日〜10月12日）と15分足（2026年10月11日〜26日）、どちらも米国の夏時間で見たことです。冬時間（11月1日から）の足と、祝日の足の動きは、まだ見ていません（祝日だけの決まりもありません）。毎日の休みの頭に確定する足と、休みの間に確定する足（米国の夏時間は 21:00〜21:45 UTC に確定する4本、日本時間 6:00〜6:45）のメールは、休みの間に届きます。休みの間に注文が通るかは、確かめていません。」
      en: "On gold, Twelve Data returns a bar that barely moves for the daily break (one hour: four bars on the 15-minute chart) and for the hour before the market opens on Sunday (a bar that closes from 22:00 UTC on Sunday), and those bars are judged (a signal is sent if one fires). The bars after Friday's close (four on the 15-minute chart) and the bars of the hours before Sunday's open (those that close before 22:00 UTC on Sunday) are not judged, but they count in MACD and in the newest 120 bars. This is what the stored 1-hour bars of 16 August to 12 October 2026 and the stored 15-minute bars of 11 to 26 October 2026, both in US summer time, show; winter-time bars (from 1 November) and the bars of holidays have not been looked at yet (there is no rule for holidays either). The emails for the bar that closes at the start of the daily break and for the bars that close inside it (in US summer time the four that close from 21:00 to 21:45 UTC, 6:00 to 6:45 Japan time) arrive during the break; whether an order goes through during the break has not been checked."
    - The others ([3] to [6], [8], [9]) stay word for word.
  - `stockmacdNotes` (ja:2189-2197 / en:2084-2092):
    - [0] (ja:2190 / en:2085) 「の1時間足だけで判定します」 → 「の15分足だけで判定します」; en "Judged on the 1-hour chart
      of 8 US stocks" → "Judged on the 15-minute chart of 8 US stocks". Nothing else changes.
    - [1] (ja:2191 / en:2086) 「見るのは1時間足の確定ごとです」 → 「見るのは15分足の確定ごとです」; en "looked at at each
      1-hour close" → "looked at at each 15-minute close". Nothing else changes.
    - [2] (ja:2192 / en:2087) the closes (fitted to the probe, 3.3), the Tokyo sentence as 4.4 item 8, the US sentence,
      and 〔closing〕: ja 「（取引時間の最後の足は、引けの値段が出てから判定します）」, en " (the session's last bar once
      the closing price is out)" — kept only if the closing-price condition of 3.3 item 6 holds; otherwise 〔closing〕 is
      empty (or a sentence saying what the fitted code does, this file corrected first). ja:
      「足と値段は Yahoo Finance の公開データで、チャートの株の足と同じです（公式の配信ではないため、止まることがあります）。足が確定してから送ります。米国株はニューヨークの 9:45〜16:00 の15分ごと、日本株は 9:15〜11:30 と 12:45〜15:30 の15分ごとに足が確定し、Yahoo の最後の約定の時刻がそれを過ぎたら判定します〔closing〕。確定から45分を過ぎた足は送りません。東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、日本株のメールは足が確定してから15分ほど後に判定して送ります（15分足で実際に何分後になるかは、まだ測っていません）。米国株は、1時間足の時に、確定の数秒後に送っていました（2026-11-05 の2通。15分足では、まだ見ていません）。受信箱に届くまでの時間は確かめていません。」
      en: "The bars and the price are Yahoo Finance's public data, the same as the app's stock chart (not an official feed; it may stop). Mailed once the bar has closed: US bars close every 15 minutes from 9:45 to 16:00 New York time, Japanese ones every 15 minutes from 9:15 to 11:30 and from 12:45 to 15:30 Tokyo time; a bar is judged once Yahoo's last trade is past its close〔closing〕. A bar that closed more than 45 minutes ago is not mailed. Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so Japanese stocks' emails are judged and sent some 15 minutes after the bar closed (how many minutes on 15-minute bars has not been measured yet); US stocks' were sent a few seconds after the close on 1-hour bars (the two on 2026-11-05; not yet seen on 15-minute bars). How long they take to reach the inbox has not been checked."
    - [3] (ja:2193 / en:2088) the owner's sentence as 4.4 item 10; the sentence before it and the one after it stay. ja:
      「利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・株も15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。取引時間の最後の足の終値は、次の取引時間の始まりまで売買できないことがあります（測っていません）。」
      en: "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop. This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging shares on 15-minute bars too, the MACD pane of the newest 120 15-minute bars, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's. The close of a session's last bar may not be tradable until the next session opens (not measured)."
    - [5] (ja:2195) 「米国の取引が早く終わる日は、最後の足を、終わってから30分後に判定します。」 → 「米国の取引が早く終わる日
      は、最後の足（終わりの15分）も、ほかの足と同じく確定の後の読み込みで判定します（本物の早く終わる日では、まだ見ていま
      せん）。」 / "On a US half day the last bar (the last 15 minutes) is judged at a read after its close like any other
      (not yet seen on a real half day)." (`CLOSES` holds 13:00, 3.3.)
    - The others ([4], [6]) stay word for word.
  - The stock data note (ja:954 / en:902): 「（決まった22銘柄の1時間足だけ）」 / "(the 22 listed stocks' 1-hour charts only)"
    → 15分足 / 15-minute.
  - FAQ 「どの通貨ペアに対応していますか？」 (ja:2035 / en:1932): 「MACD の逆張りのサインを…金の1時間足から選べます」 →
    15分足; en "on the 1-hour bars of USD/JPY, …" → "on the 15-minute bars of USD/JPY, …".
  - FAQ 「メールはいつ届きますか？」 (ja:2037 / en:1934), the lead too (as the card intro: 「足が確定してから数分で届きます」 /
    "Within minutes of the bar closing" goes). The whole answer, ja:
    「足が確定した後の読み込みで判定して送ります（MACD の逆張りは、5ペアは確定の直後・1分後・3分後の読み込みで、金は確定の1分後から次の足が確定するまでの間に、株は15分足の確定の後の読み込みで判定して送ります。日本株は Yahoo の値段が約15分遅れて届くため、確定の15分ほど後です（15分足では、まだ測っていません）。MACD の逆張りが実際に何分で届くかは測っていません）。RSI＋SAR・GA型の15分足・1時間足で日本時間 2:00〜8:59 に確定したサインは、過去の検証で損失が大きかったためメールしません（アプリの履歴には残ります）。Q-Trend・ULTRA・MACD の逆張り・流動性狩り＋EMAクロスは、この時間もメールします。」
    en: "It is judged and sent at a read after the bar closes (the MACD fade is judged and sent on the five pairs at the reads right after the close and 1 and 3 minutes after, on gold from 1 minute after the close until the next bar closes, and on stocks at a read after each 15-minute close; Yahoo's Tokyo prices come about 15 minutes late, so Japanese stocks' emails come some 15 minutes after the close (not yet measured on 15-minute bars); how long the MACD fade's emails take to arrive has not been measured). RSI + SAR and GA-style signals on 15-minute and 1-hour bars closing 17:00–23:59 UTC are not emailed, as those hours lost most on past charts (they stay in the app's log). Q-Trend, ULTRA, MACD fade and liquidity sweep + EMA cross are emailed at those hours too."
  - Comments naming the 1-hour spec (ja:2136-2138, :2235 / en:2031, :2138) point to this file.
- **Sales page** (no percent and no measured number, src/test/landing.test.tsx; the FAQ's forbidden pattern,
  src/test/signal-alert-settings.test.tsx:516, which gains the 15-minute numbers). The rules of
  research/macdfade1h-prod-spec.md section 5 hold (the fade named first, with the reason it is left out of the break-even
  comparison; 〔adverse〕 chosen from the numbers). Word for word, ja and en (written out here because the landing test
  reads its texts from one file; honestBody is unchanged but for 〔adverse〕):
  - `lp.faqs` 「勝率はどのくらいですか？」 (ja:2033): 「MACD の逆張りは、損切りをしない決まりで、損益ゼロに必要な勝率というものがないため、勝率では比べません。それ以外の、過去のチャート（スプレッド込み）で測ったサインは、どれも損益ゼロに必要な勝率に届いていません。数字はアプリ内の説明に載せています。MACD の逆張り（15分足）は、5ペアで測った数字が設定の注にあります。損切りをしないので、含み損のまま残る取引が出ることがあり、合図なしで入った時より良いとは示せていません。〔adverse〕損切りをしないのはこの決まりの作りで、損切りをしないことを勧めるものではありません。金・株と、流動性狩り＋EMAクロスは、まだ測っていません。勝てる根拠として使わないでください。」 en (:1930): "The MACD fade has no stop by design, so it has no break-even win rate and is not compared by one. Of the other signals measured on past charts (spread paid), none reached the win rate needed to break even. The numbers are in the app's notes. The MACD fade (15-minute) has its own numbers, measured on the five pairs only, in the settings' notes. With no stop, some trades can stay open at an unrealised loss, and it has not been shown to do better than entering with no signal. 〔adverse〕Having no stop is how this rule is built; it is not advice to hold without a stop. Gold, stocks and the liquidity sweep + EMA cross have not been measured. Please do not take them as a reason to expect to win."
  - `lp.honestBody` (ja:2028): 「MACD の逆張り（5ペアで測定）は、損切りをしない決まりで、損益ゼロに必要な勝率がないため、勝率では比べません。それ以外のアプリのサインは、過去のチャート（11通貨ペア・スプレッド込み）での検証で、どれも損益ゼロに必要な勝率に届いていません。MACD の逆張りは、損切りをしないので、含み損のまま残る取引が出ることがあり、合図なしで入った時より良いとは示せていません。〔adverse〕サインは注文の指示ではなく、判断の材料です。通知したサインの実際の成績は、成績を記録している決まりについて、件数とともにアプリ内にそのまま表示します。MACD の逆張りの成績は、記録も表示もしていません。」 en (:1925): "The MACD fade (measured on five pairs) has no stop by design, so it has no break-even win rate and is not compared by one. Of the app's other signals, none reached the win rate needed to break even on past charts (11 pairs, spread paid). With no stop, some MACD fade trades can stay open at an unrealised loss, and it has not been shown to do better than entering with no signal. 〔adverse〕A signal is not an order to trade; it is something to weigh. For the rules whose results are recorded, the real record of the signals emailed is shown in the app, with how many there were. The MACD fade's results are not recorded or shown."
  - 「他のツールと何が違いますか？」 (ja:2032): 「サインの成績を隠さない点です。過去のチャートでの検証結果と、成績を記録している決まりについては、通知したサインが実際に損切りと利確のどちらに先に届いたかを、勝てていない場合もそのまま表示します。MACD の逆張りは、利確と損切りの値段を書かない決まりで、その成績は記録も表示もしていません。売買のサインは確定した足で判定し（MACD の逆張りも、15分足の確定で判定します）、後から消えたり動いたりしません。」 en (:1929): "It does not hide the record. How each rule did on past charts, and, for the rules whose results are recorded, whether each signal emailed reached its stop or its target first, are shown as they are, losing ones included. The MACD fade states no take-profit or stop price, and its results are not recorded or shown. Trade signals are judged on closed bars (the MACD fade too, at 15-minute closes) and never vanish or move afterwards."
  - **〔adverse〕**: research/macdfade1h-prod-spec.md section 5's five clauses, in its order, each whose condition the
    filled numbers meet (listed again because the landing test reads them from one file):
    - 〔mean〕 < 0: 「測った期間では、1回あたりの平均はマイナスでした。」 / "Over the period measured, its mean a trade was below zero."
    - 〔mean〕 < 〔baseMean〕: 「合図なしで入った時より、1回あたりの平均が低くありました。」 / "Its mean a trade was below entering with no signal."
    - 〔mean〕 < 〔flowMean〕: 「同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。」 / "Its mean a trade was below entering the other way on the same signals."
    - some pair's fade pipsMean < 0: 「5ペアのうち、1回あたりの平均がマイナスのペアがありました。」 / "On some of the five pairs its mean a trade was below zero."
    - 〔open〕 > 0 and 〔openPipsWorst〕 < 0: 「測った期間の終わりに、含み損のまま残っていた取引がありました。」 / "At the end of the period measured, some trades were still open at an unrealised loss."
    **Chosen (2026-11-19, from the printed lines; the build checks it against the ledger copy):** fade +2.41 is not
    below 0; it is below base +3.32 and below flow +3.19; AUD/JPY's fade −0.82 is below 0; 80 trades were open with the
    worst at −1,913.4. So the last four are met.
    〔adverse〕 = ja「合図なしで入った時より、1回あたりの平均が低くありました。同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引がありました。」
    en "Its mean a trade was below entering with no signal. Its mean a trade was below entering the other way on the same signals. On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades were still open at an unrealised loss."
    In en a non-empty 〔adverse〕 is followed by one space (as the 1-hour spec says).
  - Not checked here, kept from today's texts: as research/macdfade1h-prod-spec.md section 5.
- **Tests to change:** the guard lists of research/macdfade1h-prod-spec.md section 5 "Tests to change", on the texts
  above; the forbidden-number pattern (signal-alert-settings.test.tsx:516); the notes and intros pins on 15-minute
  words, every item written out above pinned word for word in ja and in en (with 〔switch〕 and 〔closing〕 as the
  release fills them), and no 「1時間足」 / "1-hour" left in `macdxNotes`, `stockmacdNotes` and the two
  `indicatorIntro` texts but where they name the time before the switch (`macdxNotes` [0]'s last sentence and [12]'s
  stored 1-hour bars; `stockmacdNotes` [2]'s Tokyo and US sentences); the intro's and FAQ's new leads and the old
  ones gone (signal-alert-settings.test.tsx:488-501); the landing tests on this file.

## 6. Release

### 6.1 Preconditions

- **The numbers are in** (6.3 step 1a): research/ledger/macdfade15-summary.json passed the checks of 4.5 (it is run
  44535888012's, `eacb7815…`, and without its `tf` line `74a4a230…`; rows.csv `b73115a0…`; the walks' ranges as
  printed), and `FADE_MEASURED` holds its values.
- **The shares are fitted** (6.3 step 1b): the probe's shapes and times are written in 3.3 (no price, 3.3), and 3.3
  items 3-6 match them (or are changed to match them, with this file corrected first).
- **The study check passed on the 15-minute real run** (7.2) on the function's branch **at the function PR's final head
  commit**: the `tf` `15min` dispatch's head SHA equals that commit, and both (the run id and the SHA) are written in
  the PR; its summary.json sha256 equals the ledger copy's. A push runs the workflow on `TF=1h` only
  (.github/workflows/macdfade15.yml:80; its push paths :36-60 include research/macdfade-prod-check.ts,
  `_shared/macd-fade.ts` and `signal-alerts/indicators.ts`), so any later commit that touches a file the check runs
  needs a new `15min` dispatch before the merge.
- **The morning check v12 is built before the function** (7.3), as v11 was before v40 (scripts/morning-check/README.md:11):
  `pairs-v12` / `gold-v12` / `stocks-v12` with the go-live markers in place of `live_ms` and `end_1h_ms`, benched
  (`sim12.ts`, the scenarios, the teeth) and merged before step 4. Then step 8 only sets the constants and rebuilds.
  The Routine's interim prompt (7.3 "The switch day") is written and kept ready with it.
- The tests and static checks of 7.1 pass on the function's branch.
- **The twins are in** (3.6; 6.3 step 3): the counts read back.
- No v40 state to wait for: v40 keeps no open trade and no state row (research/macdfade1h-prod-spec.md 3.2), so there
  is no "no ride open" wait as there was for v39.
- **A merge alone ships it** (deploy-functions.yml:21-27: a push to main touching `supabase/functions/**`; :74-77:
  signal-alerts seventh of eight; :35-39: one concurrency group). So every PR before the function's has nothing under
  `supabase/functions/**`. The function's squash message is written by hand and holds none of `[skip ci]`, `[ci skip]`,
  `[no ci]`, `[skip actions]`, `[actions skip]` (v40's push deploy did not run for that reason, docs §8.155). About a
  minute after the merge, check that "Deploy edge functions" runs for the merge's SHA; if not, dispatch it at once with
  the input empty (the default eight).

### 6.2 Timing

v40 and v41 never judge the same bar (1-hour against 15-minute bars, under different ids and subscription rows). What
the timing decides is a **gap** (a span judged by neither) or an **overlap** (v41's 15-minute bars inside v40's last
1-hour bar, both mailed). Let H be an hour, and "first answer" the first run whose record says v41.
- **Pairs.** v40 reads the 1-hour close at H:00 at H:00, H:03 and H:05 (indicators.ts:1029). v41 reads each 15-minute
  close at +0, +1 and +3 (:1028). A first answer from H:06 to H:18: v40 has made all three reads of the H:00 close, and
  v41's first bar is H:00-H:15 (read at H:15, H:16, H:18): no gap, no overlap. Before H:06: v40's later reads of the
  H:00 close are lost (they matter only when H:00's failed), and before H:04 v41 also judges the bar H-0:15 to H:00
  (overlap). After H:18: the bar H:00-H:15 is judged by nobody (a gap of one bar, and one more for each later quarter).
- **Gold.** v40 looks at its H:00 close from H:01 to H:30 (twelveCloseDue on `1h`, :1106-1113; v40 judged gold from
  13:01 in §8.155). v41 looks at gold's newest 15-minute close from a minute after it until the next close. A first
  answer from H:06 to H:14 makes v41 judge gold's bar H-0:15 to H:00 (overlap: both forms may mail for that quarter
  hour, under different rows; not a duplicate). From H:15 to H:29: no overlap (at H:15 nothing is due for gold; at H:16
  its H:15 close).
- **Shares.** v40 mails a share's 1-hour bar up to 45 minutes after its close (stocks.ts:114). Tokyo trades 00:00 to
  06:30 UTC (last close +45: 07:15); New York, in its winter (now), 14:30 to 21:00 UTC (last close +45: 21:45). A switch
  between 07:15 and 14:30 UTC has neither form's share bars open: the last Tokyo session is v40's, the next New York
  one v41's.
- **So: aim v41's first answer at H:15 to H:18 UTC, H from 08 to 14, Monday to Thursday** (17:15 to 23:18 JST). That
  is clean for the pairs, gold and the shares. The merge goes at about H:13:30 to H:14:00: v31 answered about a minute
  after its merge (merge about 10:23, deploy 10:23:27-10:23:57, first answer 10:24:00, docs §8.127); v40's first
  answer came about 73 seconds after its merge and 27 seconds after its hand-started deploy began (merge 12:38:47,
  the push deploy not run, the deploy dispatched by hand, its deploy step 12:39:33-12:39:53, first answer 12:40:00,
  docs §8.155, OPERATIONS.md:13002-13003). Not Friday: the weekend gate starts at 21:00 UTC and the switch day's morning check would wait over the
  weekend.
- If the first answer lands from H:06 to H:14, gold has one overlapping bar; if after H:18, the pairs have a gap of one
  bar or more. Either is written down (docs §8.156) and told to the owner; nothing else is done.
- Recorded from the run's records (`net._http_response`): v40's last answer and v41's first; per chart, the end of the
  last 1-hour bar v40 judged (`end_1h_ms`) and the open of the first 15-minute bar v41 judged (`live_ms`, for the
  morning check; as v40's was defined, scripts/morning-check/README.md:27).

### 6.3 Order

1. **This spec:** a PR with nothing under `supabase/functions/**`. In it: research/macdfade1h-prod-spec.md gets under
   its title "**For production, replaced (2026-11-19) by research/macdfade15min-prod-spec.md at signal-alerts v41** (the
   owner's 「メールの判断15分に変更して」). It stays the record of v40."; research/macdfade15-prod-spec.md's superseded
   line gains "The 15-minute form is built from research/macdfade15min-prod-spec.md (2026-11-19)."
1a. **The numbers**, before any of the function's code: research/macdfade-prod-check.ts takes `TF=15min` (7.2) and the
   workflow's study-check steps run for it (research and .github only). A `workflow_dispatch` of macdfade15.yml with
   `tf` `15min`; the real job takes up to 180 minutes (:183). Then 4.5's route steps 1-4: the ledger copy
   (research/ledger/macdfade15-summary.json) and its checks. The run id, both sha256 and null.json's are recorded in
   research/macdfade15-spec.md (a short note under its 15-minute result) and in this file. A failed check stops here
   (4.5 step 4). **This PR holds nothing under `supabase/functions/**`** (6.1): `FADE_MEASURED` written from the copy
   (4.5 step 5), `chanceOf`'s new branch and the `m.tf` check (`FADE_MEASURED_TF`) are in
   `_shared/macd-fade-measured.ts` and go only in step 4's function PR, together with `MACDH_INTERVALS = ["15min"]`.
   Merged alone, the 15-minute numbers would push-deploy v40's code with them, and the module would throw at load
   (today's `m.tf !== "1h"`, :265, and `chanceOf`'s throw for a gap outside the walks' range, :241-243, both run at
   load through `FADE_MEASURED_NOTES`, :353-356): signal-alerts (every rule's mail) and live-chart would stop (both
   load it through indicators.ts:40 and both are in the list a push deploys, deploy-functions.yml:22-25, :76), and
   econ-calendar the next time it is deployed.
1b. **The probe:** .github/workflows/yahoo-probe15.yml dispatched (read only; a public Yahoo read from GitHub's
   runners; since d794649 it prints no price, 3.3). What it shows is written in 3.3, and 3.3 items 3-6 are fitted to
   it (this file corrected first where it differs). Best run after a Tokyo and a New York session have both ended, so the closing
   points are in the answer.
2. **No app PR before the function:** the id parse, tags and plan line already read the new ids (section 5).
2a. **The study check on the function's branch** (7.2): a dispatch of macdfade15.yml with `tf` `15min` on that branch
   (GitHub runs a dispatch with the workflow file of the ref chosen), at the PR's final head commit (6.1: its head SHA
   and run id written in the PR; a later commit touching a file the check runs needs a new dispatch). A failure, or a
   summary.json sha256 other than the ledger copy's, stops the release.
3. **The twins** (3.6), with the owner's confirmation, just before the merge (as close to it as the owner's
   confirmation allows; the statement's time recorded as T0); the counts read before and after, per rule, pair and
   interval.
4. **The function's PR** (sections 3-4: index.ts, indicators.ts, stocks.ts, live-chart/stocks.ts if the probe needs
   it, macd-fade-measured.ts, macd-fade.ts's comments, the ledger, the tests), merged per 6.1-6.2.
5. **Once v41 answers:** the times of 6.2 recorded (T1, v41's first answer, among them). In the run's record `newest`
   is the bar's open (index.ts:1007, :1150), so: by H:20, each of the six charts' records shows the bar opened at H:00
   (closing H:15) judged, its `newest` H:00 and a `fade` field (a pair's from the read at H:15, H:16 or H:18; gold's
   from H:16). If not, the reason is read from the record (`short`, `stale`, `unavailable`, `day_spent`) and written
   down. If v41 judges nothing at all, 6.4's exception applies at once. The run's records (`net._http_response`) are
   kept about 6 hours (docs §8.141): every check below reads them within that.
5a. **The shares and the queue** (2.4, 3.3 item 10). At the first New York close after v41 answers (14:45 UTC in New
   York's winter; its reads to 15:15 UTC): the stocks run's records show each followed US share with `bars` 600 or
   more, `judged` true, `newest` the bar opened at 14:30, no `yahoo_*` error, and `took_ms`. In the first Tokyo
   session (the next day, 00:15 to 01:00 UTC at least): each followed Tokyo share's bars judged once each about 15-16
   minutes after their close (`judged_after_ms`), no `yahoo_*` error; no stocks call timed out (`net._http_response`
   `timed_out`, `error_msg`); `took_ms` and any `skipped: "budget"` written down; and in the same span the pairs' and
   gold's records judge every quarter-hour close (a `fade` field for each bar, `judged_after_ms` as the reads give).
   Each finding goes to docs §8.156; a failure is 6.4's.
5b. **live-chart and the reconcile.** live-chart is deployed in the same push (deploy-functions.yml:76) and loads
   indicators.ts and macd-fade-measured.ts (live-chart/index.ts:110; indicators.ts:40), and the shared Yahoo parser
   if 3.3 item 6 changes it. Right after the deploy: the app's chart opened on a pair's 15-minute chart and on a
   stock's 15-minute chart shows bars, and the deploy's log shows live-chart deployed; if not, 6.4 at once. Then the
   reconcile of 3.6 (with the owner's confirmation), its counts read before and after.
6. **econ-calendar** deployed by name right after (it bundles `isMacdhChart`; it is not in the default list,
   deploy-functions.yml:66-77). Its recipients are then the `'15min'` rows' people.
7. **The screen's texts** (section 5) merged and published to Lovable once v41 answers. Lovable's state is reported as
   given (e.g. `pending`). Until it is live, the grid already shows the `15min` column beside v40's texts.
8. **The morning check v12** (7.3; built and merged before step 4, 6.1): its go-live constants (`live_ms` per chart,
   `end_1h_ms`) set from the run's records and rebuilt (`build.sh`, v3.md5), merged; the Routine's prompt replaced by
   the switch-day prompt (7.3 "The switch day") and read back before the first 00:16 UTC run after the switch (a copy
   of the v11 prompt kept). If v12's constants are not in by then, the switch-day prompt goes in all the same: it runs
   v11 for the switch day only, reads every 1-hour bar from `end_1h_ms` on as not v11's, and says 7.3's sentences for
   what is not recounted.
9. **Later, with the owner's confirmation:** after the first v12 morning check that reads clean, the `'1h'` `macdx` and
   `stockmacd` rows are deleted (3.6), counted before and after.
10. docs/OPERATIONS.md §8.156 (the release, the run and its numbers with every field CLAUDE.md asks for, the statements
    sent, the times, `live_ms`, what is not measured); §8.155 gets a last line "→ §8.156"; §9 gets the first real data
    to check (section 8); §10's checklist gains "moving an email to another bar length: the new length's subscription
    rows first, the function, the old rows later; the merge window".

### 6.4 Rollback

Only for a failure; the owner is told. Revert the function's merge so that v40's first answer again falls from H:06
to H:14 UTC, H from 08 to 14, Monday to Thursday (outside the share sessions, as 6.2). Then the pairs are clean: v41 has
made its three reads of the 15-minute close at H:00, and v40 judges the 1-hour bar opening at H:00 at H+1:00. Gold is
not: v40 looks at gold's 1-hour close at H:00 for 30 minutes, so it may judge the hour whose four 15-minute bars v41
already judged (one hour of overlap, written down). No window avoids that for gold: from H:31 on, v41 would have judged
15-minute bars inside v40's first hour instead. The revert's message is written by hand; check that the deploy runs.
- **The `'1h'` rows are rebuilt from the `'15min'` rows before the revert**, whether or not step 9 has run, with the
  owner's confirmation, counted per rule, pair and interval before and after. Under v41 an untick leaves the `'1h'`
  row and a tick makes none (3.6), so the `'1h'` rows are out of date:

  ```sql
  -- '1h' rows of follows unticked under v41
  delete from public.signal_alert_subscriptions h
   where h.rule in ('macdx', 'stockmacd') and h.interval = '1h'
     and not exists (select 1 from public.signal_alert_subscriptions t
                      where t.user_id = h.user_id and t.pair = h.pair and t.rule = h.rule and t.interval = '15min');
  -- '1h' rows of follows ticked under v41 (every row, when step 9 has run)
  insert into public.signal_alert_subscriptions (user_id, pair, interval, rule, lang)
  select user_id, pair, '1h', rule, lang from public.signal_alert_subscriptions
   where rule in ('macdx', 'stockmacd') and interval = '15min'
  on conflict (user_id, pair, interval, rule) do nothing;
  ```
  Between this and v40's first answer again (T2), v41 still answers, and its ticks and unticks change the `'15min'`
  rows only; so once v40 answers, the two sets are reconciled once more, as 3.6 with the intervals swapped (delete the
  `'1h'` rows made before T2 that have no `'15min'` row; add `'1h'` rows for the `'15min'` rows made after the
  rebuild). Then the `'15min'` `macdx` and `stockmacd` rows are deleted (v40 neither reads nor shows them), with the
  owner's confirmation and counted; a later attempt starts again from 3.6's twins.
- **Triggers.** Revert **at once, whatever the minute**: v41 judges nothing (its runs fail every time), or live-chart
  fails after the deploy (6.3 step 5b). Revert **in the window above**: the pairs or gold have a quarter-hour close
  that none of its reads judged (no `fade` record for that bar, not explained by `short`, `stale`, `unavailable`,
  `day_spent` or the weekend gate) twice within one hour, in Tokyo's hours or any other (the queue of 2.4: the stocks
  calls' `took_ms` and timeouts read first); or the shares fail on their own (every followed share's reads
  `yahoo_*`, `bars` below 600, or a New York or Tokyo session's bars never `judged`, 6.3 step 5a). Each is written
  down with its records (docs §8.156) and told to the owner.
- Then: econ-calendar deployed by name; the screen's text PR reverted and published; the v11 Routine prompt put back.
  **The v41 window** (from v41's first answer to v40's first answer again, both from the run's records) is written
  down. On the days it touches, v11 reads every 1-hour bar inside the window as not v11's, and v12 every 15-minute bar
  after it as not v12's (7.3).

## 7. Checks

### 7.1 Tests and static checks

`npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and econ-calendar, and `deno
check` of the morning-check bench (`scripts/morning-check/bench/sim.ts`, `sim11.ts`, and the new `sim12.ts`). Function
tests over fake tables, on 15-minute bars:
- A pair's close judged at minutes 0, 1 and 3 (fresh instances): one email a follower, the same price (the 15-minute
  bar's ask or bid close, from `fadeQuotes`); the quote of a 1-hour read in `hourQuotes` is not used for it; a missing
  15-minute quote gives `no_price` and the bar is judged again.
- Not fresh at 21 minutes: nothing. Fresh at 19: mailed. A 15-minute signal's row has `interval` `15min` and
  `closed_at` the open plus 15 minutes, and a `'15min'` follower is mailed while a `'1h'` follower of the same pair is
  not.
- Gold judged a minute after a quarter-hour close and again at later minutes before the next close; not at the next
  close's minute; Twelve Data read at most twice a close.
- A follower whose lookup failed, mailed at the next judging; a row of the other side: nothing, `other_side`.
- A share: `CLOSES`, `stockBarEnd` and `stockBarBreak` on 15-minute bars (US, Tokyo lunch, Tokyo close, a US half day),
  from fixtures with the probe's stamps and shapes (made-up prices); a Tokyo bar arriving 15 minutes late: judged at the next close's reads and
  mailed (fresh at 45); a bar overtaken before any read judged it: not judged; read again in its window: one email a
  follower. The closing-price condition (3.3 item 6) on those fixtures: a session's last bar judged on its closing
  point, or, if it does not hold, the mail's and the note's sentence absent (ja and en).
- The stocks run's budget (3.3 item 10): with Yahoo reads made slow (a fake fetch), no read starts once 30 seconds have
  passed; the shares left are in `reads` as `skipped: "budget"` and are the first read by the next run; `took_ms` is in
  the summary; with fast reads every followed share is read as today.
- `FADE_MEASURED_TF` equals `MACDH_INTERVALS[0]`, and `_shared/macd-fade-measured.ts` imports nothing from
  `signal-alerts/` (a text pin on its imports; 4.5).
- Each mail variant in ja and en (a pair's BUY and SELL, gold's, a US and a Tokyo share's, a session's last bar), each
  pinned to the words of 4.3-4.5, the new items 8 and 10 among them; 4.1's guards; the measured paragraph built from
  the ledger copy, the 〔chance〕 branch of 4.5 word for word, and the 〔open〕 = 0 and 〔tp〕 = 0 variants from summaries
  made for the test; the record's `fade` and tags; the econ digest's recipients on `15min`.
- The code-text pins: no `"1h"` left in `fadeAtClose`, `stockFadeClose`, `stockSweepOf`, `stockBarsOf`, `stockFade`'s
  `fadeSignal` and the share read's URL (each takes its constant).
- In the screen's PR: the notes' version of the measured paragraph word for word; the notes and intros of section 5,
  every item written out there pinned word for word in ja and in en; the intro's and FAQ's new arrival leads (the old
  「数分で届きます」 / "a few minutes" / "Within minutes" gone); the sales page's three texts with the 〔adverse〕 chosen;
  the FAQ's forbidden numbers.

### 7.2 The study check on 15-minute bars

research/macdfade-prod-check.ts (today 1-hour only: it refuses any `TF` but `1h`, :46-47) takes `TF` `1h` or `15min`.
On `15min`: the bar's length 15 minutes (:48 `STEP`); the reads 0, 1 and 3 minutes plus a second (:58-61 `READS`, as
research/macdfade15-spec.md "The entries"); `loadTf(src, pair, "15min", …)` and `historyRead(pair, "15min", …)`
(:122, :128); `LOAD_FROM` default 2023-12-01T00:00:00Z and `OUT` default research/out/macdfade15 (:53-54, as the
workflow's, macdfade15.yml:84, :185); `meta.tf` must be `"15min"` (:85); the words of its print (:184). Everything else
as research/macdfade1h-prod-spec.md 7.2.

In .github/workflows/macdfade15.yml the four study-check steps (:119-124, :133-138, :164-169, :254-262) run when `TF`
is `1h` or `15min` (share 0.96, take profit 10). The real job's step stops unless summary.json is the run of record:
on `1h`, sha256 `60edab22…a9e2` as today; on `15min`, the sha256 of the file with the bytes `,\n  "tf": "15min"`
removed must be `74a4a230…c888b` (run 44535888012's, 4.5), and the whole file's sha256 must be the ledger copy's. On
`15min` the real job restores run 44535888012's cache (`gmo-macdfade15-44535888012`) last, over the branch's caches,
so the three GMO files that were kept short there are read whole; if that cache is gone, the check stops the job.
The syn job's 15-minute period is the workflow's (:93-95).

### 7.3 The morning check of the new form (`pairs-v12` / `gold-v12` / `stocks-v12`; README v12)

Built from v7's 15-minute parts and v11's fade parts (scripts/morning-check/src/build.sh: v7 :44-47, v11 :81-86):
- **Pairs:** v7's head (13 days, src/head-v7.part:13), v7's 15-minute FRONT (src/front-pairs-v7.part: interval
  `'15min'` :8, `ot + 899999` :46) with v9's bid and ask closes and `paid` (as src/front-pairs-v9.part carries them for
  1-hour files), v7's guard and day's end (src/guard-pairs-v7.part, src/dayend-pairs-v7.part), and v11's back parts
  with `'15min'`, the new id, the subscriptions on `'15min'` (src/back1-v11.part:73, :84, :88) and the 15-minute week's
  end (src/back2-v11.part:17-18, :101, :135: `900000`, `'v12'`). 0.96, `other_side`, `stop_or_target` as v11.
- **Gold:** v7's gold FRONT (src/front-gold-v7.part: `'15min'` :4, `ot + 900000` :29) with an empty `paid` (as
  src/front-gold-v11.part), v7's gold guard (src/guard-gold-v7.part), the rest as the pairs.
- **Shares:** src/stocks-v11.part with the new id (:19, :30, :108), the subscriptions on `'15min'` (:24), `n_iv` on
  `'15min'` (:42), and `closed_at` within 900 seconds after the open (:43), fitted to `stockBarEnd` (3.3); the RUN row's
  counts (:112-113): `shares_followed_1h` and `subscriptions_1h` become `_15min` (from the `'15min'` subs), and
  `stockmacd_subscriptions_not_1h` (rows not on `'1h'`) becomes `stockmacd_subscriptions_not_15min` (rows not on
  `'15min'`; until step 9 it counts the `'1h'` rows, expected, and is read so); the labels `interval_not_1h` and
  `closed_at_not_within_1h` (:55-56, :67, :84, :90-91, :102) become `interval_not_15min` and
  `closed_at_not_within_15min`; the comments :12, :14, :22, :36. The Routine's prompt reads the new names.
- **The bench:** v11's (`gen.py`, `gen_gold.py`, `sim11.ts`, `scen11.py`, `teeth11.py`, `run11.sh`) made on 15-minute
  bars (`sim12.ts`: reads at +0, +1 and +3 minutes, gold from +1 to before the next close, fresh 20 minutes; go-live
  apart for pairs and gold), with the switch day in its scenarios (v40's 1-hour fade rows there, day files missing
  before v41's first read).
- **The 15-minute files:** the sweep stores each ended 15-minute GMO day file it reads (index.ts:814-821, :844-850) and
  deletes them after 60 days (:767-770). The live chart stores the ended day files it reads in the same table
  (live-chart/index.ts:458-465, :518; docs §8.127 found stored 15-minute files that came from chart opens,
  OPERATIONS.md:11815). Since v33 (2026-10-30) only other rules' 15-minute followers and the live chart's reads stored
  them (who follows what, and who opened which chart: not read here), so days may be missing before v41's first read. The first reads fill the 13 days
  the window needs, as at v31 (docs §8.127). On the switch day `history_files_missing` is then expected.
- Their sizes are not measured (v11's were sent by the Routine in one call each, README v11.5-v11.6); if one outgrows
  a call, the function form of README v9.7 (owner-confirmed DDL).
- **v12 is built before the switch** (6.1), with the go-live markers in place of `live_ms` and `end_1h_ms`, as v11 was
  before v40 (README.md:11); at the release only the constants are set and the files rebuilt (6.3 step 8).
- **The switch day** (the Routine's switch-day prompt, written with v12 and in place before the first 00:16 UTC run
  after the switch, 6.3 step 8): v11 runs for the switch day only and reads every 1-hour bar from `end_1h_ms` on as not
  v11's (its statements have a start, `live_ms`, and no end, README.md:31: without this they would report every later
  bar `missing`); from the next GMO day on, v11 is not run. v12 reads every bar before `live_ms` as `before_go_live`;
  the gold overlap of 6.2, if any, is expected. A report made while v12's constants are not in says
  「新しい形（15分足・確定96%・逆張り）の判定は数え直していません」 and, for the shares, 「株は足が保存されていないので、
  判定は数え直していません（行どうしの確かめだけです）」.
- README: a v12 section (v12.1 to v12.7, today's line numbers), its title and lead, §10's constants, §12's rebuild;
  build.sh's v12 lines; v3 to v11's files unchanged byte for byte (`v3.md5`, `git status`).

## 8. Not measured, not checked

- **Measured, now in this file:** the five pairs' numbers of this form on 15-minute bars (the study's re-run 44535888012,
  recorded in research/macdfade15-spec.md :442-500, its summary.json in research/ledger/; the first run 44077464383
  read three short GMO files). The fade did worse a
  trade than no signal (−0.91, below ten walks' range) and than the other way (−0.78, inside its range); ten walks give
  a range, not a test.
- **In the repository:** the 15-minute summary.json (research/ledger/macdfade15-summary.json). **Not:** its null.json and
  rows.csv (their sha256 are recorded in research/macdfade15-spec.md :442-500).
- **Not measured:**
  - Gold and the shares with this form (the study has no bid and ask minutes for them).
  - The shares' 15-minute bars as Yahoo gives them: the rows of `15m` over `60d` (600 closed bars are assumed to fit:
    about 39-41 US and 36 or more Tokyo sessions in 60 calendar days, a calendar count, not read), Tokyo's afternoon
    stamps, the closing and lunch points (3.3).
  - The Tokyo delay's effect on 15-minute mails: when a Tokyo mail goes out (counted at about 16 minutes after the close
    from the 2026-11-06 delay), how often a Tokyo bar is overtaken before it is judged, the delay on any day but
    2026-11-06.
  - Yahoo's limits at the new rate. Counted from the code (all 22 shares followed, a run every minute): about 1,600 to
    4,700 reads a day on 1-hour bars (warm to fresh instances) and about 4,900 to 8,300 on 15-minute bars, about twice
    to three times; Tokyo's shares are read about once a minute through the session. 1,418 Tokyo reads were measured in
    a session on 2026-11-06 (docs §8.141). Whether Yahoo refuses (429) at the new rate: not measured. A run of 14 Tokyo
    reads at a 10-second timeout each can pass the 120-second call timeout (supabase/migrations/20261031160100_stockmacd_sweep.sql:22); it happens on more minutes a day now.
  - How long the stocks calls take, and so how often they hold up the pairs' and gold's calls: pg_net here sends one
    call at a time (docs §8.112, measured 2026-10-11), so a long stocks call delays the next calls and can make a
    quarter hour's three reads of the pairs and gold all miss (2.4). v41 bounds the stocks run at about 30 seconds of
    reads (3.3 item 10); the calls' lengths themselves are not measured, and the first Tokyo session is watched for it
    (6.3 step 5a).
  - The Twelve Data count at 15-minute gold reads. Counted from the code: 96 gold closes a weekday (84 on Friday, 8 on
    Sunday), each 0 to 2 reads: 0 to 192 a weekday for the alerts, against 0 to 48 on 1-hour bars. 0 when gold's
    15-minute chart is already followed and its stored row has the bar (another rule's follower, the live chart). Who
    follows gold's 15-minute chart today: not read. Measured before: 26 to 76 a day from 10/12 to 10/26, 136 and 170 on
    10/7 and 10/8 when gold's 15-minute ULTRA was mailed (docs §8.127). The alerts stop at 780 a day, the chart at 450,
    600 or 720 by timeframe (shared count); once the day is spent gold's 15-minute closes are not judged until 00:00 UTC.
  - The database's egress: gold's stored row (about 120 KB a read, index.ts:1186) read in 14 minutes of every 15 on a
    fresh instance (30 of every 60 on 1-hour bars); the pairs' kept files preloaded on more runs (12 an hour against 3,
    each about 1.3 times the bytes: 13 days of 96 bars against 40 days of 24). Counted from the code; how often an
    instance is fresh is not known.
  - Gold's daily-break bars (four near-flat bars a day in the window) and their effect on the MACD.
  - The minutes between a close and the mail, and the price's move in them; how often a close is not judged; whether
    the fade's mean differs from the baseline's beyond chance.
  - Whether 12 calendar days hold 600 GMO 15-minute bars over Christmas and New Year.
- **Not checked:**
  - Yahoo's 15-minute answer around a close and through the next session (3.3 "Not yet seen"), and so whether the
    closing-price sentences hold (3.3 item 6).
  - Which `macdx` / `stockmacd` rows will be ticked or unticked between the twins and v41's first answer, or under v41
    before a rollback (3.6 and 6.4 reconcile them; the counts are read then).
  - Whether a re-run of the 15-minute study on the branch gives run 44535888012's file (7.2 stops if not; it rests on
    that run's cache, which GitHub drops after 7 days unused).
  - The 1-hour run of v40's numbers (44099401423) read the same three short GMO files (23 bars with no minute on the
    same pairs); it was not re-run, so how much v40's measured paragraph would move is not measured.
  - Whether production's GMO 15-minute bars equal the study's loader's (the study check ties the shipped function to
    the study on the study's files only).
  - Who follows which chart, and how many `macdx` / `stockmacd` rows there are on which interval (production not read);
    which 15-minute GMO day files are stored today; the age of gold's stored 15-minute row.
  - Whether Twelve Data's 15-minute bar is there at +1 and +4 minutes.
  - The Routine's prompt; Lovable's live state; how long v41's deploy will take (6.2).
  - The answers of 2026-11-19 in the owner's own words (section 1: relayed).
- **Read by this writer:** research/macdfade1h-prod-spec.md whole; research/macdfade15-prod-spec.md whole;
  research/macdfade15-spec.md whole; docs/OPERATIONS.md §8.127, §8.155 and the Tokyo lines of §8.141; in the code every
  line cited above (index.ts :340-380, :590-1215, :1490-1630, :2030-2169; indicators.ts :120-345, :360-400, :630-720,
  :1005-1215, :1395-1490; stocks.ts whole; live-chart/stocks.ts :40-197; macd-fade.ts :1-60; macd-fade-measured.ts
  whole; market-hours.ts :25-45; analyze/price-source.ts :181-226; econ-calendar/mailer.ts :76-100 and digest.ts's
  footer lines; logic.ts :317-322, :494-520; src/lib/signalAlerts.ts :25-75, :286-325; the ja.ts / en.ts lines cited;
  the migrations cited; deploy-functions.yml :14-90; macdfade15.yml :14-90 and its TF and check lines;
  research/macdfade-prod-check.ts's TF lines; research/macdfade15.ts :537, :545-600, :746; the head of
  yahoo-probe15.yml; the morning-check parts' 1-hour and 15-minute lines, build.sh :44-47 and :70-86, README's
  headings and :1-12; the tests' lines cited). The workflow's four readers' notes were used as leads; each fact taken
  from them was checked in the code here. For the reviewers' findings (2026-11-19, the fix round), also read:
  index.ts :465-480, :921-1013, :1145-1160, :1518-1630, :1795-1815, :2036-2135; indicators.ts :35-45, :255-280,
  :1100-1160; macd-fade-measured.ts :230-275, :345-360 and its imports; live-chart/index.ts :106-140, :455-522;
  econ-calendar/mailer.ts :10-15; scripts/morning-check/bench/sim11.ts :5-12; deploy-functions.yml :18-80;
  macdfade15.yml :14-90; supabase/migrations/20260925120000_signal_alerts.sql :9-24, 20260925180000 :1-40,
  20260929060100_indicator_alerts_sweep.sql and 20261031160100_stockmacd_sweep.sql; SignalAlertSettings.tsx :108-116;
  ja.ts :2035-2037, :2090, :2099, :2140-2152, :2189-2197; en.ts :1932-1934, :1987, :1995, :2035-2047, :2084-2092;
  signal-alert-settings.test.tsx :488-501; indicator-alerts.test.tsx :965-992, :1160-1180; stocks-v11.part's 1-hour
  lines; back1-v11.part and back2-v11.part's 1-hour lines; README.md :1-40; OPERATIONS.md :552, :9244, :11813-11826,
  :12305-12330, :13002-13003; v31's i18n diff (19d049a); research/macdfade15-spec.md :400-436;
  research/ledger/macdfade1h-summary.json (its `meta` and `dirs.fade.all`, flow and base means).
- **Run by this writer:** `git status`, `git log`, `git grep` of the ids; one node check of the two new ids against
  copies of the app's regexes; `sha256sum` and `wc -c` of research/ledger/macdfade1h-summary.json (to see the form of
  `meta`); file reads; in the fix round, a minimal ESM model in node of the import cycle 4.5 forbids (it fails with
  "Cannot access 'MACDH_INTERVALS' before initialization") and a read of the 1-hour ledger's numbers with python.
  Nothing else: no test, no app, no function, no study, no workflow, no production, no outside service.

## Questions for the owner

1. **The 15-minute numbers are worse than the 1-hour ones.** On 15-minute bars the fade averaged +2.41 pips a trade
   (take profit 10, no stop; 6,006 trades, 5,926 reached +10, 80 still open at −44,784.5 pips in all, the worst
   −1,913.4, the longest held about 666 days; the largest loss on the way: median 11.9, up to 2,975.8 pips; time to +10:
   median about 2 hours, one in ten longer than about 4 days, the longest about 545 days; no order unfilled). With no
   stop, the share reaching +10 comes out high by construction. Entering
   with no signal averaged +3.31, and entering the other way +3.19. By side, the SELLs (at the top) averaged −1.35 a
   trade and the BUYs +6.29. The gap to no signal (−0.90) is below what ten made-up price walks gave; that is not a test, but it
   points the wrong way. On 1-hour bars the fade was about the same as no signal (+3.26 against +3.20). The emails and
   the screen will say this plainly. This spec goes ahead on 15-minute bars as asked; please say if you want to stay on
   1-hour bars after seeing these numbers. (As asked, from the first run; the re-run of 2026-11-19 on whole GMO files
   moved no-signal to +3.32 and the gap to −0.91, the rest the same; the owner was told.)

   **The question as put to the owner (in Japanese, CLAUDE.md; the same numbers, from research/macdfade15-spec.md
   :416-436 and research/ledger/macdfade1h-summary.json):**
   「15分足の数字は、1時間足より悪い数字でした。15分足で測ると、MACD の逆張り（5ペア、2024年1月1日〜2026年11月10日 21:00 UTC に確定した足、スプレッド込み、+10 pips で利確・損切りなし）は、合図が6,006回、うち5,926回が +10 pips に届き、1回あたり平均 +2.41 pips でした。届かずに残った取引は80回で、その含み損益は合わせて -44,784.5 pips、いちばん悪いもので -1,913.4 pips、いちばん長いもので約666日持ったままでした。途中の含み損は中央値 11.9 pips、最大 2,975.8 pips。+10 pips に届くまでの時間は中央値 約2時間、10回に1回は約4日より長く、いちばん長いもので約545日でした。足の終値で入るので、入らなかった注文は0回です。損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。合図なしで入ると1回あたり +3.31 pips、同じ合図で逆向きに入ると +3.19 pips でした。向き別では、売り（上の端）が1回あたり -1.35 pips、買い（下の端）が +6.29 pips でした。合図なしとの差（-0.90 pips）は、作り物の値段10本で出た幅より下でした。確かめ〈検定〉ではありませんが、悪い側を指しています。1時間足では、合図なしとほぼ同じでした（+3.26 pips と +3.20 pips）。メールと画面には、これをそのまま書きます。この仕様は、言われたとおり15分足で進めます。この数字を見て、1時間足のままにしたい場合は教えてください。」
