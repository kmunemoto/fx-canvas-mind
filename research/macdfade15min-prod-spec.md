# The MACD fade on each pair's own chart: USD/JPY and AUD/USD on 15-minute bars, EUR/JPY, AUD/JPY, EUR/USD and gold on 1-hour bars, the shares on 15-minute bars (signal-alerts v41)

Status: a production spec, **the per-pair revision**, written 2026-11-19 on branch `claude/app-confirmation-jvmk03` at
e660119 (origin/main is 9ca2054, v40). Nothing of the per-pair form is built. Production runs signal-alerts v40
(`signal-alerts-v40-2026-11-18`, the fade on 1-hour bars, live since 2026-11-18 12:40 UTC; docs/OPERATIONS.md §8.155).
This file is the production spec of v41.
Revised the same day after a review of this revision (24 findings, on the code, the numbers and the release); each
finding was checked against the code, ledgers and records it cites before anything here was changed; and again after a
second review (17 findings, each checked once more against what it cites before a change; all 17 held and are in);
and after a third review (16 findings, on the release's reads, rollback and statements, the texts and the checks; each
checked once more against what it cites before a change; all 16 held, some as wording only, and are in); and after a
fourth review (11 findings, on the code, the texts, the release and the checks; each checked once more against what it
cites before a change; all 11 held, four of them as nits, and are in); and after a fifth review (15 findings, on the
code, the texts, the release and the checks; each checked once more against what it cites before a change; all 15
held, five of them as nits, and are in).

How it came to this: it was first written the same day on top of 3adec21 (which does not hold the file) for the owner's
「メールの判断15分に変更して」 (every pair, gold and the shares on 15-minute bars), committed as 8b3184a, and revised in
b7cab86 and a964994 (the version HEAD holds; "the first version" below means it, and a screen or mail text this file
takes from it is copied here word for word, not referred to); the unfinished build 001a3df (its own message:
「作りかけ・見直し前」; every `macdx` chart on 15 minutes) and the morning check v12 (c9259c6) were made from that
version. Then the owner decided per pair (2026-11-19, section 1). This revision rewrites every section that assumed all
pairs on 15-minute bars, and takes in four review findings on that build (3.5, 7.1, 7.3). Where HEAD's build does what
the first version said and this one no longer does, 3.2 says so: the build is changed to this file before anything is
released.

It keeps the structure and the section numbers of research/macdfade1h-prod-spec.md (the v40 spec, built as written).
Where that spec still holds word for word, this file says "as research/macdfade1h-prod-spec.md N.N" and does not copy
it. For EUR/JPY, AUD/JPY, EUR/USD and gold that spec still describes the rule, the chart, the reads and the mail (v40's,
which v41 keeps for them); what changes for them is listed here (the measured numbers, 4.5; the code they share with the
15-minute pairs, 3.2).

It takes over from research/macdfade15-prod-spec.md (2026-11-17, the same rule on 15-minute bars, marked superseded and
never built). That file's 15-minute facts were used as leads only. Where that file and this one differ, this one governs.

**Paths.** As research/macdfade1h-prod-spec.md "Paths": `index.ts`, `indicators.ts`, `stocks.ts`, `logic.ts` are in
`supabase/functions/signal-alerts/`; `macd-fade.ts`, `macd-fade-measured.ts`, `macd-level.ts`, `macd.ts`,
`market-hours.ts` in `supabase/functions/_shared/`. **Two kinds of line numbers.** A line written `HEAD file:N` was read
by this writer on e660119 for this revision (HEAD holds 001a3df's build, so these are the build's lines). A line written
without `HEAD` was read by the first writer on 3adec21 (the same function files as origin/main 9ca2054: v40's code) and
describes the code before the build; such lines are kept only where the text they support did not change (2.2, the
shares' part of 2.4, 3.3, 4.1, 4.4, and a few marked "v40's lines"); the build reads them again. In the text written for
this revision, lines of other files (tests, i18n, migrations, workflows, the morning check, the study) were read on
e660119 by this writer; in the kept text every line is the first writer's, read on 3adec21.

**The studies it must equal.** research/macdfade15-spec.md (the rule on 15-minute bars with `TF=15min`, on 1-hour bars
with `TF=1h`; built in research/macdfade15.ts, run by .github/workflows/macdfade15.yml, checked by
research/macdfade15-check.py). The runs of record, one per chart, never mixed:
- **15-minute** (USD/JPY, AUD/USD): "Result of the re-run on GMO's files read afresh (2026-11-19, Actions run
  44535888012, main 9ca2054)" (research/macdfade15-spec.md :446-503), summary.json in
  research/ledger/macdfade15-summary.json.
- **1-hour** (EUR/JPY, AUD/JPY, EUR/USD): "Result of the 1-hour re-run on whole GMO files (TF=1h; 2026-11-19, Actions
  run 44555599946, commit e4b16c7)" (:505-555), summary.json in research/ledger/macdfade1h-whole-summary.json. It
  replaces v40's run 44099401423 (research/ledger/macdfade1h-summary.json, which stays as the record of v40's numbers).
- The comparison the owner's choice rests on: "Each pair: 15-minute against 1-hour bars (2026-11-19)" (:557-589).

The study's rule, files and numbers govern: where it reads differently from section 2, this file is corrected before
anything is built.

## 1. What the owner asked

**2026-11-19, the per-pair decision (this revision).** The owner's words, verbatim:

「ていうかメールの判断はペアごとに正確度が違うと思うんです。15分足の合図の方が勝率が高いペアもあると思うし、1時間足のペアの方が勝率が高いやつもあると思う。それぞれ調べて、それぞれのペアに合った時間足で判断のメールを流すようにしましょう。15分足と1時間足だけでいいです。どっちかで全てのペアでどっちの方が勝率高いかを決めて、このペアは15分足、あのペアは1時間足みたいな感じで、勝率が高い方にそれぞれのペアの判断のメールを変えましょう。」

Answers given in the question dialog the same day (relayed to this writer by the workflow that asked; the dialog itself
not seen here):
- **Gold:** 「別の方法で測ってから決める」. Gold stays on 1-hour bars, v40's rule unchanged, until a gold study is made
  (the study has no gold: research/macdfade15-spec.md :593).
- **The shares:** 「15分足のまま（おすすめ）」. The 22 shares move to 15-minute bars, as the first version of this file
  said.

**What was measured for it** (research/macdfade15-spec.md :557-589; both charts on GMO's whole files, 2024-01-01 to
2026-11-10T21:00Z, the same rule: share 0.96, the fade, in at the bar's close, take profit 10, no stop; the win rate is
tp / trades, a trade not at +10 being one still open at the end; pips a trade counts the open ones at their value at
the last minute loaded; in at the bar's close, so no order went unfilled on either chart):

| pair | 15-minute: win (tp / trades), pips a trade, open (count; sum / worst pips) | 1-hour: the same | higher win |
|---|---|---|---|
| USD/JPY | 99.18% (1,207 / 1,217), +2.67, 10 (−8,818.8 / −1,801.1) | 98.91% (271 / 274), −0.26, 3 (−2,781.1 / −1,733.2) | 15-minute |
| EUR/JPY | 98.90% (1,167 / 1,180), +1.29, 13 (−10,151.1 / −1,913.4) | 99.00% (297 / 300), +4.30, 3 (−1,678.9 / −595.5) | 1-hour |
| AUD/JPY | 98.56% (1,167 / 1,184), −0.82, 17 (−12,636.0 / −1,575.3) | 98.61% (284 / 288), +4.44, 4 (−1,561.7 / −561.3) | 1-hour |
| EUR/USD | 98.67% (1,185 / 1,201), +3.86, 16 (−7,220.1 / −950.9) | 98.73% (312 / 316), +3.11, 4 (−2,137.1 / −695.3) | 1-hour |
| AUD/USD | 98.04% (1,200 / 1,224), +4.94, 24 (−5,958.5 / −742.3) | 97.44% (304 / 312), +4.42, 8 (−1,662.1 / −399.9) | 15-minute |

Holding time (:574-576): minutes to +10, median, 15-minute / 1-hour: USD/JPY 68 / 71, EUR/JPY 80 / 63, AUD/JPY 137 /
129.5, EUR/USD 226 / 237, AUD/USD 319.5 / 291.5; the longest to +10 216..545 days (15-minute) and 215..477 days (1-hour);
the longest still open 515..666 days and 327..617 days. (research/macdfade15-spec.md :576 first wrote "516..666": its
lower end, AUD/JPY's `openMinutesMax` 742,290 minutes, is 515.48 days, 515 by the module's own rounding, `Math.round`,
HEAD macd-fade-measured.ts:200-204; checked in python on the ledger copy at the review. That line of the study was
corrected to "515..666" in the commit that holds this revision; no text of this file prints the value, the mails print
only the five-pair maximum.) The win rates
above were checked against the two ledger copies by this writer (tp / trades from `dirs.fade.<pair>`, python,
2026-11-19).

**What the owner was told before deciding** (research/macdfade15-spec.md :577-586): every gap is 0.05 to 0.60 points;
Fisher's exact test gives p 0.51 to 1.00 (and the trades overlap, so the real evidence is weaker still); in the two
halves of the period the higher side turns on three pairs (only USD/JPY has the same side higher in both); no signal
wins about as often (15-minute / 1-hour: USD/JPY 99.42 / 99.42%, EUR/JPY 99.14 / 99.12%, AUD/JPY 98.75 / 98.70%,
EUR/USD 98.48 / 98.51%, AUD/USD 98.31 / 98.31%), since with no stop a win rate this high comes from the construction.
**No pair's gap is more than chance gives.** The owner's rule still governs: the higher win rate.

**What the decision replaced.** Earlier the same day the owner wrote 「メールの判断15分に変更して」, and the dialog's
answer was **"Scope: all"** (the five pairs, gold and the 22 shares on 15-minute bars; relayed, the dialog not seen
here). **That scope is replaced for the pairs and gold:** each pair goes to the chart of its higher win rate, gold stays
on 1-hour bars. For the shares it stands (the answer above). The rest of that dialog stands:
- The owner knows that Yahoo's Tokyo prices come about 15 to 20 minutes late. (Measured: about 15 minutes, 891 to 933
  seconds, on 2026-11-06, docs §8.141. "15 to 20" is the relayed answer's wording, not a measurement; no text here
  writes "20".)

Answers of 2026-11-17 that still stand (research/macdfade15-prod-spec.md section 1, research/macdfade15-spec.md "Why"):
- Only the first bar at 96% (the bar before not at 96%), not every bar while the line stays there.
- The email states only the price in: no take-profit level and no stop. Measured while building; the numbers go in the
  email.
- **On 15-minute bars the pane is the newest 120 15-minute bars** (the 15-minute chart's MACD pane), chosen by the owner
  over a 480-bar pane. On 1-hour bars the pane is the newest 120 1-hour bars, as v40 (research/macdfade1h-prod-spec.md
  2.1; not an answer of the owner's, so no text attributes it to the owner).
- The shares are on 15-minute bars too, the owner knowing that Yahoo's Tokyo prices come late.
- Gold and the shares go out with the pairs, not measured with this form; their mails say so and carry no numbers. The
  shares fade too (a SELL is a short sale). Nothing is sent at any target. The name stays 「MACD の逆張り」 / "MACD
  fade".

**The target** (each row is one chart; nothing else is mailed under `macdx` or `stockmacd`):

| instrument | chart | rule id (3.7) | bars | reads (2.4) | numbers in the mail (4.5) |
|---|---|---|---|---|---|
| USD/JPY, AUD/USD | `15min` | `macdx_12_26_9_w600_15min_fade96of120_in_v12` | GMO 15-minute | 0, 1, 3 minutes after each quarter hour; fresh 20 min | the 15-minute run 44535888012 only |
| EUR/JPY, AUD/JPY, EUR/USD | `1h` | `macdx_12_26_9_w600_1h_fade96of120_in_v11` (v40's) | GMO 1-hour | 0, 3, 5 minutes after the hour; fresh 30 min (as v40) | the 1-hour run 44555599946 only |
| XAU/USD | `1h` | `macdx_12_26_9_w600_1h_fade96of120_in_v11` (v40's) | Twelve Data's stored 1-hour | from 1 minute after the close, to :29 (as v40) | none (as v40) |
| the 22 shares | `15min` | `stockmacd_12_26_9_w600_15min_fade96of120_in_v5` | Yahoo `15m` | 3.3 | none |

**Read by this writer, not asked again:**
- 「変えましょう」 / 「変更」 mean a replacement: for USD/JPY, AUD/USD and the shares, v40's 1-hour email stops when v41
  starts; both are not sent (the same reading as v31's 「メールの判断15分足に変更して」 on 2026-10-26, docs §8.127). For
  EUR/JPY, AUD/JPY, EUR/USD and gold nothing of the rule, the chart, the reads or the id changes: v41 sends v40's email;
  only its measured numbers come from run 44555599946 (4.5).
- Everything else of the rule stays as v40: the 600 closes ending at the bar, 96%, the bar before (index 598 of the
  same window) not at 96%, the fade side, the price in (pairs: the bid close for a SELL, the ask close for a BUY; gold
  and shares: the close), no take-profit and no stop price, one side a bar, nothing sent after.

CLAUDE.md: as research/macdfade1h-prod-spec.md section 1, its last paragraph, word for word. Three things are new:
- Each pair's mail shows the numbers of its own chart's run only (4.5), and the text names that chart.
- On 15-minute bars the fade did worse a trade than entering with no signal (fade − base −0.91, below the walks' range);
  on 1-hour bars about the same (+0.05, inside the walks' range). Every text with the numbers says the one for its chart.
- The pairs on each chart were picked by the higher win rate on these same data. So no text shows a total of only the
  pairs mailed on a chart, and no text presents the picked pairs' own numbers (none of the five picked pair-charts has
  a mean below zero) as a finding (4.5).

## 2. The rule (each pair on its own chart; gold and the shares alike)

### 2.1 Terms (the study's: `TF=15min` for USD/JPY, AUD/USD and the shares; `TF=1h` for EUR/JPY, AUD/JPY, EUR/USD and gold)

- A pair's chart is the one the function's per-pair map gives it (`MACDH_INTERVAL_OF`, 3.2 item 1): `15min` for
  USD/JPY and AUD/USD, `1h` for EUR/JPY, AUD/JPY, EUR/USD and XAU/USD. A chart's closed bars, oldest first, their closes
  as the chart draws them: a pair's, GMO's mid rounded on the pair's chart (`historyRead` on the `15min` or the `1h`
  chart, HEAD index.ts:1186); gold's, Twelve Data's stored `1h` bars (as v40, `historyOfBars`); a share's, Yahoo's `15m`
  bars (3.3).
- The rest as research/macdfade1h-prod-spec.md 2.1, word for word (600 closes ending at `n`, `Z(n) = zoneAt(r, 599)`,
  `Zp(n) = zoneAt(r, 598)`, the 120 positions of the pane, the share, `FADE_PCT = 96`). On the 1-hour charts (EUR/JPY,
  AUD/JPY, EUR/USD, gold) it is that spec's reading unchanged. On 15-minute bars: 600 closes are about six and a quarter
  trading days of a pair (research/macdfade15-spec.md "Data"), about 23 US sessions and about 26 Tokyo sessions of a
  share (26 bars a New York session; 23 a Tokyo session: its 22 bars and the 11:30 closing-auction row, which the parser
  keeps as a one-price bar of its own, 3.3 item 6); the pane of 120 bars is 30 hours of a pair, about 4.6 US and 5.2
  Tokyo sessions of a share.

### 2.2 The entry and the side

As research/macdfade1h-prod-spec.md 2.2, word for word. (At 0.95 this is v8's zone rule, which v31 mailed on these
15-minute charts from 2026-10-26 to 10-30, docs §8.127.)

### 2.3 The price in; no target; no stop

- **A pair:** bar `n`'s **ask close for a BUY, bid close for a SELL**, from the same GMO read of the pair's own chart
  the closes come from (15-minute for USD/JPY and AUD/USD, 1-hour for EUR/JPY, AUD/JPY and EUR/USD), as GMO gives them
  (not rounded). This is the study's price ("Prices in": GMO's own bar's bid and ask close, on either `TF`). It takes the
  quote whose open is `n`'s and prices it with `ridePaidAt` (HEAD indicators.ts:675: a BUY the ask close, a SELL the
  bid close), as v40 does. **HEAD's build keeps the quotes of one chart only:** `if (c.interval === MACDH_INTERVALS[0])
  fadeQuotes.set(c.pair, quotes)` (HEAD index.ts:1185), looked up by pair alone (HEAD :969). With two charts that is
  wrong silently: the 1-hour pairs would never get a quote, every entry of theirs would end `no_price` (HEAD
  :971-974), the bar would be left unsettled (HEAD :1036) and read again, and nothing would be mailed; no console line
  says so, only the run's record carries it (`fade.error` `"no_price"`, HEAD :972, in the record through `fade:
  said.fade`, HEAD :1047). So per pair the map is filled from the read of the pair's own chart and keyed by chart (3.2
  item 5).
- **Gold:** the closed bar's close (as v40).
- **A share:** the closed bar's close (as v40, index.ts:1555).
- No target and no stop: as research/macdfade1h-prod-spec.md 2.3, its last item.

### 2.4 When each kind is read and judged

| chart | read | fresh | from |
|---|---|---|---|
| USD/JPY, AUD/USD `15min` (GMO) | minutes with `m % 15` 0, 1 or 3 (HEAD indicators.ts:1055) | 20 min (`freshFor("15min")`, HEAD :355-356) | v31's reads (docs §8.127) |
| EUR/JPY, AUD/JPY, EUR/USD `1h` (GMO) | minutes 0, 3 and 5 (HEAD :1056) | 30 min (`freshFor("1h")`) | v40's, unchanged |
| XAU/USD `1h` (Twelve Data's stored bars) | from 60 seconds after the close while within 30 minutes (`twelveCloseDue`, HEAD :1133-1140; `twelveChartDue`, :1150-1155): minutes 1 to 29 | 30 min | v40's, unchanged |
| the shares `15min` (Yahoo) | 3.3 | 45 min | 3.3 |

Every pairs' and gold's run starts a second into the minute (`startWaitMs`, HEAD indicators.ts:1123; HEAD index.ts:780-782)
and none of them runs in the weekend gate (below; HEAD index.ts:784). The stocks run takes its clock as it is called, with
no `startWaitMs` (HEAD index.ts:1572-1573), and is gated only by its own market's weekdays (`stockCloseDue`, HEAD
stocks.ts:148-157), not by the weekend gate (its branch returns before the gate, HEAD index.ts:1867-1874, :1879); so New
York's Friday 15:45 bar, closing 21:00 UTC in its winter, is still judged (counted from the code; corrected at the fourth
review: this said "every run"). For the pairs and gold, the bar expected is the one that closed at the latest close of
the chart's grid (`latestCloseMs`, HEAD indicators.ts:1067-1071); an answer GMO made before the close is not judged on
(`staleForClose`, as v40); judged once an instance (`judgedBar`, keyed `${pair}|${interval}`: HEAD index.ts:1007,
:1166); a fresh instance judges it again; fewer than 600 closed bars: `short`, not judged (HEAD index.ts:1190-1192).

- **The 15-minute pairs (USD/JPY, AUD/USD):** the `15min` chart, read 0, 1 and 3 minutes after each quarter-hour close.
  An entry is mailed only while its bar closed at most 20 minutes ago; the read at minute 3 meets that unless the run
  is late. These are the reads v31 used (docs §8.127) and that the EMA 20 / 200 email (`emarm`, 15 minutes) uses today.
  The kept-file preload brings 13 days a fresh instance (`klinePreloadDays("15min", 601)`, HEAD indicators.ts:1232-1238).
- **The 1-hour pairs (EUR/JPY, AUD/JPY, EUR/USD):** as research/macdfade1h-prod-spec.md 2.4 (v40's reads, unchanged):
  the `1h` chart read 0, 3 and 5 minutes after the hour, fresh 30 minutes; the kept-file preload brings 40 days a fresh
  instance (`klinePreloadDays("1h", 601)`, worked out by this writer from HEAD indicators.ts:1232-1238).
- **Gold:** as research/macdfade1h-prod-spec.md 2.4 (v40's reads, unchanged): Twelve Data's `1h` bars as the live chart
  keeps them, looked at from a minute after the close for 30 minutes; Twelve Data itself read only when the stored bars lack
  the bar, at most twice a close (`twelveReadDue`, HEAD indicators.ts:1176-1179: at +1 minute and again from +4), within
  the alerts' 780 a day (`ALERT_TWELVE_CAP`, HEAD :1187). (The first version of this file put gold on 15-minute bars;
  the owner's answer of 2026-11-19 keeps it on 1-hour bars, so none of that applies.)
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
    more pushes a read into a minute where its chart is not due, and calls that keep running long back the queue up.
    Then: the 15-minute pairs' three reads of a quarter hour (0, 1, 3) can all be missed, and that quarter hour goes
    unjudged; **the 1-hour pairs' three reads of an hour (0, 3, 5) can all be missed too, and that hour goes unjudged**
    (in Tokyo's hours as under v40; corrected at the fifth review: this said that on 1-hour bars v40 had no stocks run
    read every minute. v40's stocks run read each followed Tokyo share every minute from each of its seven closes, 10:00,
    11:00, 11:30, 13:00, 14:00, 15:00 and 15:30 JST, until that close was done, about 16 minutes after it, 9ca2054
    stocks.ts:107-112, :118-127, with no budget, index.ts:1564-1571; docs/OPERATIONS.md:12316-12318 records it. So the
    1-hour pairs' reads at :00, :03 and :05 of 01, 02, 04, 05 and 06 UTC shared the queue with an every-minute stocks run
    under v40 too, and they do the same hours under v41, whose Tokyo reads fall from 00:15 to about 02:46 and from 03:45
    to about 06:46 UTC, HEAD stocks.ts:130-133, :148-157, now bounded, 3.3 item 10. What v41 adds for them: New York's
    reads at :00 UTC, at every quarter-hour close of its session, HEAD stocks.ts:131, where v40 read New York at :30 and
    at its 16:00 close only, 9ca2054 stocks.ts:108; and Tokyo's reads in the minutes just before the hour); gold, looked
    at each minute to :29, only if the backlog lasts that long. On 15-minute bars a Tokyo share is read every minute of
    the session (above; on 1-hour bars for about 16 minutes after each of seven closes), so this can happen through
    Tokyo's hours (00:00 to 06:30 UTC).
    Measured before the stocks run existed: the longest pg_net call of 2026-10-03 to 10-10 was 37.7 seconds, none over
    60 (docs §8.112). The stocks calls' lengths: not measured. So v41 bounds the stocks run (3.3 item 10) and the release
    watches for it (6.3 step 5a, 6.4).
- **The pairs' run's load, per pair against v40 and HEAD's build** (counted from the code, HEAD; run lengths not
  measured): the run stops starting GMO chart reads once it has spent `FETCH_BUDGET_MS` = 90 seconds (HEAD index.ts:393).
  The `macdx` charts' GMO reads an hour, at most (every due minute, nothing judged yet): v40 15 (5 × 3), HEAD's build 60
  (5 × 12), per pair 33 (2 × 12 + 3 × 3); the most in any one minute is 5 in all three (minutes 0 and 3). A warm instance
  skips a judged chart before any request (HEAD index.ts:1166). So, **counting the `macdx` charts only**, per pair adds
  no minute heavier than v40's or the build's. But the run reads one GMO chart per `pair|interval` followed under any
  of qtrend, ultra, macdx, amdpo3, emarm and spike (HEAD index.ts:797-811), and other rules follow these same charts
  (`emarm` the 15-minute charts of the six, `spike` their 1-hour charts: HEAD indicators.ts:316-317, :324-325). With
  other rules' followers, minutes 0 and 3 can carry up to 3 more GMO chart reads than the build (`emarm` keeps EUR/JPY's,
  AUD/JPY's and EUR/USD's 15-minute charts read, and per pair adds their 1-hour charts) and up to 2 more than v40 (other
  rules keep USD/JPY's and AUD/USD's 1-hour charts read, and per pair adds their 15-minute charts). Counted from the
  code; run lengths not measured. Gold's Twelve Data reads go back to v40's (at most 2 a close, 1 close an hour).
- So the mail is judged and sent some minutes after the close: the 15-minute pairs at the reads 0, 1 or 3 minutes after
  it; the 1-hour pairs at 0, 3 or 5 minutes after it; gold from 1 minute after it to :29; a share at a read after it (a
  Tokyo share about 16 minutes after it, counted from the 2026-11-06 delay, not measured on 15-minute bars). How long
  the mail takes to arrive, and the price's move in that time, are not measured; the mails say so (4.3 item 8, 4.4 item
  8).
- **Never judged:**
  - A pair's or gold's close whose reads all fall in the weekend gate, Friday 21:00 to Sunday 22:00 UTC
    (`isPossiblyClosed`, market-hours.ts:35-43; the sweep returns at once, HEAD index.ts:784). All of a close's reads
    fall in its own bar's span after it (15-minute: 0, 1, 3 minutes; 1-hour: 0, 3, 5; gold: 1 to 29). So every bar
    closing at or after Friday 21:00 UTC is not judged. On GMO's bars that is the week's last bar, in New York's summer
    and winter alike: the 15-minute charts' bar 20:45-21:00, the 1-hour charts' bar 20:00-21:00. (Recounted at the
    fifth review; this said five bars in winter on 15-minute, closing 21:00 to 22:00, and two on 1-hour, 20:00-22:00,
    as v40's live note says, 9ca2054 ja.ts:2151 / en.ts:2046. In both runs of record `noMinute` is 0 on every pair, so
    `judged` less `baseEntries`, the baseline entering every judged bar outside the gate, research/macdfade15-spec.md
    :127-131, :136-140, :178-183, counts the judged bars inside the gate: 149 on every pair of the 1-hour run, 152 on
    every pair of the 15-minute run, python on the ledger copies. The Fridays from 2024-01-05 to 2026-11-06 number 149,
    102 in New York's summer time and 47 in its winter. Two winter bars would make at least 196, five at least 337; a
    GMO bar of Friday 21:00-22:00 would have been loaded, `isMarketClosed` shutting Friday only from 22:00,
    market-hours.ts:19, :148-153. The 15-minute run's 3 more are not identified.) Gold's bars (Twelve Data, in neither
    run) are not counted. Any Sunday bar closing before 22:00 UTC is not judged either. The study reads the gate the
    same way (research/macdfade15-spec.md "The entries") and counts such signals apart (`notMailed`: 3 in the
    15-minute run of record, 11 in the 1-hour one).
  - Gold's daily break: as v40 (one 1-hour bar a day, read, judged and kept in the 600-bar window; research/macdfade1h-
    prod-spec.md 2.4). The first version's four 15-minute break bars do not apply.
  - **Tokyo's 11:30 bar is never mailed** (added at the fourth review): the morning's closing-auction row, a one-price bar
    of its own from 11:30 to 11:45 JST (2.1, 3.3 item 6), in the chart and in the 600-bar window. It is closed only once
    Yahoo's last trade time is at or past 11:45 or a later bar is in the answer (HEAD stocks.ts:203). The reads of the
    11:30 close run to 12:00 at the latest (`stockCloseDue`, HEAD stocks.ts:148-157, `STOCK_POLL_MS`) and stop once that
    close is done (the 11:15 bar in, HEAD stocks.ts:257, index.ts:1625, :1676); the next reads are the 12:45 close's. So
    unless a read from 11:45 to 12:00, before that close is done, sees Yahoo's last trade time at or past 11:45 in the
    lunch break, the bar is first judged at the 12:45 close's reads, once the afternoon's first row is in, an hour or
    more after its end: not fresh (`stockBarFresh`, 45 minutes, HEAD stocks.ts:219-221), so no entry
    (`stockFadeClose`, :234; index.ts:1600) and no mail, every session. Counted from HEAD's code; Yahoo's answer in the
    lunch break (its regularMarketTime) is not yet seen (3.3 "Not yet seen"). The notes say so (`stockmacdNotes` [2],
    section 5). Mailing that bar, or joining it to the 11:15 bar, would be the owner's choice: asked in "Questions for
    the owner" 2 (corrected at the fifth review: "not asked here"); until the owner answers, v41 is built as this file
    says (the bar not mailed, the notes saying so).
  - Also never judged: a 15-minute pair whose newest closed bar is not in GMO's answer by minute 3, a 1-hour pair's by
    minute 5; a pair read `short`; gold's bar not in Twelve Data after its two reads, or on a UTC day whose Twelve Data
    count is spent (`day_spent`); a share's bar overtaken by the next closed bar before any read judged it (only the
    newest is judged); a pair's quarter hour (15-minute) or hour (1-hour) whose three reads were all held past their
    minutes by long calls ahead of them in pg_net's queue (above; gold's, only if every minute to :29 was); failed runs;
    a chart nobody follows. How often: not measured.

### 2.5 One email a bar and chart

As research/macdfade1h-prod-spec.md 2.5 (the claim key: supabase/migrations/20260925180000_signal_alert_rules.sql:30-32,
unique `(user_id, kind, pair, interval, bar_time, side, rule)`; `mailRide`'s read with no side filter: HEAD
index.ts:732-750, by pair, interval, bar and the row's rule id, HEAD :740), except the re-offer times: a follower whose
address lookup failed is mailed when the bar is judged again: a 15-minute pair at minute 1 or 3, a 1-hour pair at
minute 3 or 5, gold at a later minute to :29, each on a fresh instance or when the bar is unsettled. A share's bar: as
there (index.ts:1607-1613).

**On the 1-hour charts v40 and v41 write the same id.** A 1-hour close of EUR/JPY, AUD/JPY, EUR/USD or gold that both
versions look at (around the switch, 6.2) is mailed once a follower: `mailRide` leaves out a follower who has a row for
the bar under the id (HEAD index.ts:749), and the claim key refuses a second row. This holds only if v41 writes those
rows under v40's id on `'1h'` (3.2 item 4); under any other id the two versions' rows would not collide and a bar judged
by both would be mailed twice.

## 3. The code

### 3.1 The shared pure function: `_shared/macd-fade.ts` (unchanged)

No change to its code. `closeEntryAt` and `fadeCloseEntryAt` take the newest 600 closes of any chart, and `fadeRuleId`
(HEAD macd-fade.ts:47-48) already takes the interval and the version, so it gives both `macdx` ids. Only comments
change: HEAD macd-fade.ts:1-5 (「…then, 2026-11-19, 「メールの判断15分に変更して」 (v41)」: add the per-pair decision) and
:22-27 (`fadeRuleId("macdx", MACDH_INTERVALS[0], 12)` becomes the two ids of 3.7). `macd-level.ts`, `macd.ts`,
`market-hours.ts`: no change.

### 3.2 Pairs and gold: `fadeAtClose` on each pair's chart (HEAD index.ts:953-982)

**Already per chart in HEAD's build (001a3df), kept:** `fadeAtClose(pair, interval, closed, newest, out)` (HEAD
index.ts:953) with `step = LIVE_STEP_MS[interval]`, `age = nowMs - (newest + step)`, `freshFor(interval)` and
`fadeSignal("macdx", pair, interval, …, closeMs: newest + step)` (HEAD :958-976); `judge` passes the interval (HEAD
:1020); `judgedBar` keyed `${pair}|${interval}` (HEAD :1007, :1036, :1166); `mailerFor` matches followers on
`x.interval === sig.interval` (HEAD :643) and `mailRide` reads and filters by interval (HEAD :740, :749); `set_many`
deletes per interval (HEAD :2188-2199). Each works on a 1-hour chart as on a 15-minute one. The steps of
research/macdfade1h-prod-spec.md 3.2 (1 not fresh; 2 the entry; 3 the price; 4 the signal and `mailRide`; 5 unsettled
only on `fade.error`) and "nothing read or written each minute for this rule; no state row" are unchanged.

**What HEAD's build assumes and the per-pair form changes.** Each item is needed. The ones marked *silent* fail with no
error: nothing is mailed, or the wrong thing is, and no log line says so.
1. **One map of each pair's chart** (HEAD indicators.ts:291, `MACDH_INTERVALS = ["15min"]`, one chart for all six):
   `MACDH_INTERVAL_OF: Readonly<Record<string, "15min" | "1h">>` = USD/JPY `"15min"`, AUD/USD `"15min"`, EUR/JPY `"1h"`,
   AUD/JPY `"1h"`, EUR/USD `"1h"`, XAU/USD `"1h"`: the one place that says on which chart a pair's mail is judged.
   `MACDH_INTERVALS` stays only as the screen's column list, derived from the map in `INDICATOR_INTERVALS`'s order
   (`["15min", "1h"]`); **no code takes `[0]` of it** (today HEAD indicators.ts:302 and HEAD index.ts:1185 do; a text pin
   in 7.1 keeps it so). The comment at HEAD indicators.ts:280-290 ("This one constant drives …") is rewritten for the map.
2. **`isMacdhChart`** (HEAD indicators.ts:296-298, a cross product of `MACDH_PAIRS` and `MACDH_INTERVALS`): `pair` in
   `MACDH_PAIRS`, `MACDH_INTERVAL_OF[pair] === interval`, and `isIndicatorChart(pair, interval)`. This one change makes
   per pair, with no other edit: `isIndicatorChartFor("macdx", …)` (HEAD :332-334), the run's subscription filter (HEAD
   index.ts:798), `fadeSubs` (HEAD :931), `faded` (HEAD :1017), `set` (HEAD :2132), `set_many` (HEAD :2173) and the econ
   digest's recipients (econ-calendar/mailer.ts:90, which imports it at :13; 3.6). (These uses of
   `isMacdhChart`, with the uses of `MACDH_INTERVALS`, `MACDH_FADE_VERSION` and `MACDH_RULE_ID` in items 3, 5 and 6, are
   all there are outside the tests and comments: a grep of supabase/functions and src on HEAD.) Left as a
   union list, every pair would be offered, read and judged on both charts.
3. **The version and the id per chart** (HEAD indicators.ts:181 `MACDH_FADE_VERSION = 12`, one number; HEAD :302
   `MACDH_RULE_ID = fadeRuleId("macdx", MACDH_INTERVALS[0], MACDH_FADE_VERSION)`, one id):
   `MACDH_FADE_VERSION_OF = { "15min": 12, "1h": 11 }` and `macdhRuleId(interval) = fadeRuleId("macdx", interval,
   MACDH_FADE_VERSION_OF[interval])`, which throws for an interval with no version. The 15-minute id is
   `macdx_12_26_9_w600_15min_fade96of120_in_v12`, the 1-hour id v40's `macdx_12_26_9_w600_1h_fade96of120_in_v11` (3.7).
   `MACDH_RULE_ID` goes, and so does `MACDH_FADE_VERSION` (HEAD :181; outside the tests its only use is HEAD :302, by
   grep of supabase/functions, src, scripts and research): a single version beside the per-chart map would read as the
   one in force.
4. **The row's id from the signal's chart (silent).** `signalRuleId` (HEAD indicators.ts:223) takes
   `Pick<IndicatorSignal, "rule" | "interval">` and gives `macdhRuleId(s.interval)` for `macdx`; every other rule as
   today. `indicatorRuleId(rule)` (HEAD :203-218) has no `macdx` answer any more (it throws for `macdx`); its only
   caller is `signalRuleId` (grep of supabase/functions, HEAD). `signalRow` (HEAD :727) and so `claimRow` and
   `mailRide`'s read (HEAD index.ts:740) then carry the chart's id. Left as one id: the 1-hour pairs' and gold's rows
   would be written under the 15-minute id (or the reverse), the morning check's id filters (back1-v11.part:73,
   back1-v12.part:74) would see every mail as missing, and a 1-hour close judged by both v40 and v41 at the switch would
   be mailed twice (2.5, 6.2).
5. **The price (silent).** HEAD index.ts:1185 `if (c.interval === MACDH_INTERVALS[0]) fadeQuotes.set(c.pair, quotes)`
   becomes ``if (isMacdhChart(c.pair, c.interval)) fadeQuotes.set(`${c.pair}|${c.interval}`, quotes)``, and the
   lookup (HEAD :969) ``fadeQuotes.get(`${pair}|${interval}`)``. (Keyed by chart, so no other chart's read of the same
   pair, followed under another rule, can stand in; a 15-minute read of EUR/JPY for `emarm` is not a `macdx` chart and
   is not kept.) `hourQuotes` (HEAD :1183) stays the sharp rise's. The map's comment (HEAD :915-921) is rewritten.
6. **The status, for the screen.** HEAD index.ts:2106 `macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS }` gains
   `limited: Object.fromEntries(MACDH_PAIRS.map((p) => [p, [MACDH_INTERVAL_OF[p]]]))`, the same field name and shape as
   the base block's per-pair `limited` (HEAD :2101). Without it the deployed app draws the cross product: 12 boxes, of
   which `set` refuses 6 (400, HEAD :2132-2134) and a whole-column tick through `set_many` is refused whole (HEAD
   :2173). The app reads the field after a small change (section 5), published before this function (6.3 step 2).
7. **The mail's words by chart** (`renderFadeMail`, HEAD indicators.ts:1454; 4.3). Item 8 (HEAD en :1480-1483, ja
   :1506-1509) and item 10 (HEAD en :1487, ja :1513) branch on `s.interval`: `"15min"` HEAD's pair sentences; `"1h"`
   v40's sentences word for word (9ca2054 indicators.ts: item 8 en :1448-1449, ja :1474-1475; item 10 en :1454, ja
   :1480), gold's and the pairs'. HEAD's gold-on-15-minutes sentence goes (no gold on 15 minutes). Item 9 calls
   `fadeMeasuredLine(lang, s.pair, s.interval)` (HEAD en :1486, ja :1512; 4.5). **`renderFadeMail` first throws when
   `isMacdhChart(s.pair, s.interval)` is false**: gold on any interval but `"1h"`, USD/JPY or AUD/USD on `"1h"`, the
   other three pairs on `"15min"`, any other interval. (HEAD branches items 8 and 10 on `gold` only, en :1480-1483 /
   ja :1506-1509; branched on the interval alone, a gold signal on `"15min"` would get the pairs' 0, 1 and 3 minutes
   sentence instead of an error. The run never makes such a signal, 3.2 item 2; the throw keeps a test or a later
   caller from mailing one.) 7.1 pins it. In the run such a throw (and `fadeMeasuredLine`'s, 4.5) would come after the
   follower's row is claimed: `mailerFor` claims it with `status: "pending"` (`claimRow`, HEAD index.ts:672) and only
   then calls `renderIndicatorMail` as `deliver`'s argument (:691). It would leave a `pending` row and no mail, the
   read's `fade` would end `failed` (:1018-1024), and the next read's `mailRide` would count that follower as mailed
   (`mine` / `done`, :745-748), so the bar would read as mailed (added at the third review). One more reason the run
   must never reach these throws (6.3 step 5 writes down every `failed`).
8. **Comments and the header**, written for the per-pair form: HEAD indicators.ts:165-180 (the v41 note and the version's
   comment), :280-290, :299-301, :1448-1453; HEAD index.ts:369-388 (the v41 note: "for the five pairs, gold and the shares
   alike", "Recorded under macdx_…_15min_…_in_v12", "each '1h' row gets a '15min' twin") and `FUNCTION_VERSION` (HEAD
   :389, 3.7), :913-952 (the fade's block), :986-992 (`judge`'s v41 note), :1026-1031 ("v41: minutes 1 and 3; gold each
   minute until the next close" becomes "a 15-minute pair at minutes 1 and 3, a 1-hour pair at minutes 3 and 5, gold
   each minute to :29"). Others are found at the build by a grep for "15-minute" and "15min" in the two files.

Which chart is read (no change needed): **pairs**, the GMO loop (HEAD index.ts:1150-1192): a `macdx` follower on
`pair|15min` (USD/JPY, AUD/USD) or `pair|1h` (EUR/JPY, AUD/JPY, EUR/USD) makes `gmoCharts` (HEAD :810-811) take the
chart at the minutes `gmoIntervalsDue` gives; `fetchLiveQuotes(pair, interval, …, HISTORY_BARS + 1)` reads GMO's
day-keyed files; `preload` brings the kept files once an instance (HEAD :876-881). **Gold**, the Twelve Data loop, as
v40 on `1h`.

### 3.3 Shares: `stockFade` on 15-minute bars (stocks.ts; index.ts:1521-1630)

**Built already in 001a3df (HEAD), not to be made again; rechecked against this section at the build:** items 1 to 5,
7 (but for 4.4 item 10's owner sentence, below), 8 and 10 below. Their line numbers below are v40's (the code before the build, kept as the record of what changed);
HEAD's lines, read for this revision: item 1 HEAD stocks.ts:58 (`STOCKMACD_INTERVALS = ["15min"]`); item 2 HEAD
stocks.ts:183 (`parseYahooChart(sym, body, STOCKMACD_INTERVALS[0], nowMs)`), :233 and :255 (`isStockmacdChart(sym,
STOCKMACD_INTERVALS[0])`), HEAD index.ts:1608 (`fadeSignal("stockmacd", sym, STOCKMACD_INTERVALS[0], …)`) and :1636
(`yahooChartUrl(sym, STOCKMACD_INTERVALS[0])`), no `"1h"` left in HEAD stocks.ts (grep); item 3 HEAD stocks.ts:130-133
(`CLOSES`); item 4 :164-167 (`stockBarEnd`); item 5 :265-269 (`stockBarBreak`); item 7 :321 (`tfLabel(lang,
s.interval)`, imported at :47); item 10 HEAD stocks.ts:144 (`STOCK_RUN_BUDGET_MS = 30_000`), HEAD index.ts:1619-1632
(oldest read first, `skipped: "budget"`) and :1697 (`took_ms`). **Left:** item 6's parser change, only if the probe's
timed reads call for it (item 6's texts are decided: removed, as HEAD's build has them; item 6), the half-day pin
of 7.1 (review finding (2)), and 4.4 item 10's owner sentence without 「も」 / "too": HEAD stocks.ts:366 / en :342 still
hold `株も${tf}で判定すること` / `judging shares on ${tf} bars too`, and its eight pins (4.4 item 10) hold the old
sentence, so the tests pass with it (added at the fifth review). Item 9 is unchanged code.

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
- Seen in the timed reads (added after the release, 2026-11-20; shapes and times only, no price; notes of each run
  read in full):
  - New York's close of 11/19 (run 44564231302, AAPL, reads 20:55 to 21:40 UTC): while the session trades, the answer
    ends with a live point at regularMarketTime (one price, volume 0), which `parseYahooChart` joins to the forming
    15:45 bar. At 21:01 the live point is gone (regularMarketTime 20:59:59, the 15:45 bar's close = the last trade); at
    21:03 a 16:00 point (one price, volume 0, = regularMarketPrice, regularMarketTime 21:00:01) is there, and
    currentTradingPeriod still names 11/19's session at 21:40, so the 16:00 point is joined to the 15:45 bar. The
    stocks run takes the 15:45 bar as closed once regularMarketTime is at or past 21:00 (`stockBarsOf`), so it is
    judged on the closing auction's price.
  - Tokyo's lunch of 11/20 (run 44622879795, 7203.T and 6758.T, reads 02:25 to 03:15 UTC): regularMarketTime about 15
    minutes behind the read; the 11:15 bar appears at 02:32 while it is still forming and stops changing (by its flags)
    at 02:47, when regularMarketTime is 11:30:00 and an 11:30 row of one price and volume 0 appears in place of the
    live point; it gains volume 30 to 45 minutes later. currentTradingPeriod stays 9:00 to 15:30 JST (no lunch split)
    and no null 11:45 to 12:15 rows of the day appear by 03:15 UTC. The 11:30 row is 900 s after the 11:15 row, so it
    stays a bar of its own: the 11:15 bar is judged at 02:47 or later on the last continuous trade, not on the lunch
    auction's price.
  - Tokyo's close of 11/20 (run 44656554475, the same shares, reads 06:30 to 07:15 UTC): the 15:15 bar is null at
    06:30 and priced from 06:32 (regularMarketTime 06:16:5x); regularMarketTime stops at 15:24:5x JST (06:41, 06:44:
    the closing auction from 15:25 has no trades); at 06:47 regularMarketTime is 15:30:00 and a 15:30 row of one price
    and volume 0 (= regularMarketPrice) is there, joined to the 15:15 bar (at the session's end, currentTradingPeriod
    still 11/20's at 07:15). So the 15:15 bar, closed once regularMarketTime reaches 15:30, is judged on the closing
    auction's price in these reads (between 06:44 and 06:47 both changed; a read in between was not made).
  - The day before's closing row while the next session trades: gone in the reads made (New York 11/18's 16:00 row at
    20:55 UTC on 11/19; Tokyo 11/19's 15:30 row at 02:25 UTC on 11/20). Before the next session opens, once Yahoo names
    it, the row is still there as a bar of its own in `parseYahooChart` (11/19 13:44 UTC). Not seen: when it goes, and
    so whether it is still in the answer at the next session's first close (a stray one-price bar in that close's
    600-bar window).

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
   **Decided at the second review (2026-11-19): on the shapes seen, the condition cannot hold at Tokyo's 11:15 bar, so
   both texts are removed, ja and en.** Tokyo's 11:30 row has volume and is not the answer's last (seen, above, in the
   older sessions too). Today's parser joins a point only when it is the answer's last, of volume 0, inside the bar
   before it, or when it falls at or after the session end Yahoo names (live-chart/stocks.ts:158-159; Tokyo's named end
   is 15:30, `sessionOf`, :102-107); the candidate above joins only a last volume-0 point. Neither joins the 11:30 row,
   so the 11:15 bar is judged on its close before the auction. HEAD's build already has both texts removed (HEAD
   stocks.ts:36-38, :295-298; HEAD ja.ts:2193 / en.ts:2088 hold no 〔closing〕). Keeping them would take a wider change
   that also joins the 11:30 row (with volume, not last) to the 11:15 bar, a change of the shared chart parser that this
   file does not take. What the probe's timed reads still decide is the candidate change for Tokyo's 15:30 and New York's
   16:00 points, now for the stray bar only (no text depends on it): made only if such a point is seen staying a bar of
   its own while the next session trades. Either way the 11:30 row stays a bar of its own: 23 bars a Tokyo session in
   the 600-bar window (2.1). (If the timed reads ever showed the 11:15 bar getting the auction's price, the texts would
   come back only by a later change, this file corrected first.)
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

As research/macdfade1h-prod-spec.md 3.4, with these differences: the row's `interval` is the pair's chart (`15min` for
USD/JPY and AUD/USD, `1h` for EUR/JPY, AUD/JPY, EUR/USD and gold, `15min` for a share); `closed_at` is the bar's open plus
the chart's length (a share: `stockBarEnd`); `rule` the chart's id (3.7: v12 on `15min`, v11 on `1h`; shares v5).
Today's lines: `fadeSignal` (HEAD indicators.ts:684), `signalRow` (HEAD :712-728), `rideSignalTag` (HEAD :735, `rule:side`,
no id; each read entry of the record carries its `interval`). The record's shape does not change; USD/JPY and AUD/USD
have about four times as many judged entries carrying `fade` as on 1-hour bars, the 1-hour pairs and gold as many as
under v40.

### 3.5 What else changes, and what stays

- **Nothing goes.** v40's code is the fade already; only what is tied to one chart for all changes (3.2, 3.3, 4.3-4.5).
- **The measured paragraph** (`_shared/macd-fade-measured.ts`, unchanged on HEAD since v40: one run, the 1-hour run
  44099401423, and `if (m.tf !== "1h") throw`, HEAD :265): two runs, one per chart (4.5).
- **Stays:** `hourQuotes`, `formingQuotes`, `goldMinutes` and the sharp rise's 1-hour reads; `mailerFor`, `claimRow`,
  `mailRide`; `ridePaidAt`; `macdNumbers`; logic.ts (`tfLabel` has 「15分足」 / "15-minute" and 「1時間足」 / "1-hour";
  the test mail lists each row's own timeframe: as the first writer read them, logic.ts not opened by this writer).
- **The app's code: a small change** (section 5): src/lib/signalAlerts.ts reads `macdx.limited` (the type :160, the
  parse :293, the offer :316) and the grid's "—" cell gets a title of its own for the fade
  (src/components/SignalAlertSettings.tsx:278 uses `indicatorHourOnly` for every rule today). `FADE_ID`
  (src/lib/signalAlerts.ts:70), `RIDE_ID` (:48) and `ruleOfId` (:33-37) read both `macdx` ids and the `stockmacd` id
  (checked in node by this writer with copies of the three: no ride match, fade 96, the right tab). A row's timeframe
  comes from its `interval` (SignalAlertSettings.tsx:112), so a USD/JPY row reads 「15分」 and an EUR/JPY row 「1時間」 with
  no change.
- **The research ledger:** research/ledger/macdfade15-summary.json (15-minute) and
  research/ledger/macdfade1h-whole-summary.json (1-hour) are the runs of record (both in the repository: a964994,
  e660119; sha256 checked by this writer: `eacb7815…`, 16,817 bytes; `d59b64c6…`, 16,648 bytes).
  research/ledger/macdfade1h-summary.json stays as the record of v40's numbers (a rollback).
- **The study check** (research/macdfade-prod-check.ts) takes `TF` `1h` or `15min` already (4b20d06; HEAD :50-52, :57-58,
  :65, :90), and the workflow holds each chart to its run of record (7.2).
- **Tests, by PR** (lines read on HEAD). **Which PR:** HEAD's tests, and main's (9ca2054), pin the notes' measured
  paragraph to the module (`expect(items[7]).toBe(FADE_MEASURED_NOTES.ja)`, HEAD src/test/signal-alert-settings.test.tsx
  :24, :587, :838-839, :980, :1221-1222) and read one `FADE_MEASURED` (src/test/landing.test.tsx:9, :117). So the
  module's per-chart shape (4.5) and section 5's texts cannot be split between PRs with the tests passing on each: **they
  go in one PR, step 4's** (6.3), as v40's texts went into its function PR #281 (docs §8.155, OPERATIONS.md:13007). Step
  7 is the Lovable publish only, with no test change.
  - **Step 2's PR** (the grid, cut from main, 5): `indicatorChartOffered` with and without `macdx.limited` (without it
    the cross product, as today); the grid with the per-pair map (the two columns, the boxes and "—" cells, the "—" title
    the new key, the two all-symbols boxes covering two and four pairs); src/test/i18n.test.ts for the new key. Main's
    test files are not HEAD's: their lines are found there by the same fixture text (`macdx: {` with `pairs` and
    `intervals`).
  - **Step 4's PR** (the function and section 5's texts): every item below.
  - **Tests that read this file** (they pin texts to section 5 by reading it; each text they need is written out there
    whole, 5): src/test/signal-alert-settings.test.tsx:1203-1260 (the card intro whole, `macdxNotes` items word for
    word, `stockmacdNotes` [2] by the regex `「(足と値段は Yahoo Finance の公開データで、チャートの株の足と同じです[^」]*)」`
    and its en, [3], [5]'s sentence, the FAQ 「メールはいつ届きますか？」 whole); src/test/macd-fade.test.ts:174-180 (the
    `FADE_ID` literal, `/${FADE_ID.source}/`); src/test/landing.test.tsx:133-153 (the five 〔adverse〕 clauses each as
    「…」 and "…", and the FAQ 「勝率はどのくらいですか？」, `lp.honestBody` and 「他のツールと何が違いますか？」 whole with
    〔adverse〕 in place). In step 4's PR they change with the texts: the `macdxNotes` indices to section 5's 14 items
    (v40's kept items [1], [2], [13], named in 5 by 9ca2054's lines, pinned as literals copied from 9ca2054), the
    landing test's 〔adverse〕 to section 5's per-chart choice.
  - The version pins (3.7): six pin the whole `"signal-alerts-v41-2026-11-23"` and change when the date is set at the
    release: src/test/amdpo3-alerts.test.tsx:138, emarm-alerts.test.tsx:182, indicator-alerts.test.tsx:1202,
    macd-fade-alerts.test.ts:1271, spike-alerts.test.tsx:257, stockmacd-alerts.test.tsx:896. Two pin the prefix only and
    need no change: stockmacd-alerts.test.tsx:1319 (`toMatch(/^signal-alerts-v41-/)`) and sweepx-alerts.test.ts:295
    (`toContain("signal-alerts-v41")`).
  - **The one-id pins** (3.2 items 3-4: `MACDH_RULE_ID` and `MACDH_FADE_VERSION` go, `indicatorRuleId("macdx")` throws):
    src/test/indicator-alerts.test.tsx:22 and :38 (the imports), :779, :1000-1005, :1374-1375, :1694-1697 (each becomes
    `macdhRuleId("15min")` = the v12 id and `macdhRuleId("1h")` = v40's v11 id, and `indicatorRuleId("macdx")` a throw);
    :1457 (gold's row: `rule` v40's 1-hour id, its fixture's `interval` at :1445 `"1h"`); :2106 (a pair's row in the
    loop over USD/JPY and EUR/USD at :2060: each pair's own chart and id, EUR/USD now `"1h"` and the v11 id).
    src/test/macd-fade.test.ts:46 (the import), :129-140 (`MACDH_FADE_VERSION` 12 and `MACDH_RULE_ID` become
    `MACDH_FADE_VERSION_OF` and the two ids). src/test/macd-fade-alerts.test.ts:21, :24, :29 (the imports), :116-119
    (`fadeRuleId("macdx", MACDH_INTERVALS[0], MACDH_FADE_VERSION)` becomes the two ids), :130-131, :151, :218-221, the
    fake-table rows under `MACDH_RULE_ID` (:864-1170, among them gold's at :1128-1130 on `"15min"`, which become v40's
    1-hour id on `'1h'`), and the code-text pins :1350 and :1352 (they become pins that the two lines are gone).
  - src/test/macd-fade.test.ts: one ledger (:339 `LEDGER` = research/ledger/macdfade1h-summary.json, :349) becomes two,
    each pinned value by value to its own run (4.5); the table pins per chart (:400 `"-0.77"` becomes `"-0.75"` on the
    1-hour run, and the 15-minute run's own rows); the chance pins per chart (:416 `"+0.06"` becomes `"+0.05"`; the
    15-minute run's gap pinned "below their range"). Also v40's run's literals, each to the 1-hour whole-file run: :396
    (`baseMean` `"3.20"` → `"3.21"`), :401 (EUR/USD's base `"2.60"` → `"2.61"`), :405, :511, :534 (`sec` `"8.155"` →
    the release's section, 8.156), :525 and :548 (`baseMean` `"+3.20"` → `"+3.21"`), :556-559 (the per-pair rows:
    AUD/JPY's base `"-0.77"` → `"-0.75"`, EUR/USD's `"+2.60"` → `"+2.61"`; USD/JPY's row stays the 1-hour run's in the
    1-hour table, and the 15-minute table holds the 15-minute run's rows). Two wording traps against research/macdfade15-spec.md, which the new
    pins follow or the study text is aligned with first: its whole-file 1-hour section writes "fade − flow +5.34 (walks
    −5.42..+5.81: inside)" without "pips a trade" (:549), and both new sections write "null.json `…`" without "sha256"
    (:477-478, :536). The texts per chart (:433/:442 and :571/:581 hold 「1時間足の最初の1分」 / "the 1-hour bar's first
    minute"; they and the notes' replacements :584-599 also take 4.5's rewritten 〔baseWhat〕, entry parenthesis and
    weekend sentence, 〔mailedOn〕 and the per-pair chance sentence (added at the fifth review), word for word; :590/:599
    the notes' pairs sentence; :792-793 the AUD/JPY sentence
    with -0.77 becomes -0.75, AUD/JPY being a 1-hour pair); the refusals (:849 `{ ...FADE_MEASURED, tf: "15min" }` → /not 1h/ becomes a refusal of a chart with no
    run or of `m.tf !== tf`); :863 / :873 pin the bar word per chart; :890's count of texts changes with two notes
    paragraphs. The import pin (:185, `["./pair-names.ts"]`) stays. New: the pin of 4.5 that each pair's chart in the
    function's map has a run with that `tf` holding the pair, and that `FADE_MAILED_ON` equals the map (it replaces the
    first version's `FADE_MEASURED_TF === MACDH_INTERVALS[0]`, which cannot hold with two charts).
  - src/test/macd-fade-alerts.test.ts: `MEASURED_USDJPY_JA` / `_EN` (:287-317) hold the 1-hour run's words and numbers;
    USD/JPY is a 15-minute pair, so they become the 15-minute paragraph, and a 1-hour pair's (e.g. EUR/JPY's) is written
    out beside it; the calls at :343 and :369 pass the chart; :384-385, :399, :424; :504-505 ("no 1時間足 left but the
    paragraph's") becomes per chart (a 1-hour pair's mail says 「1時間足」 throughout); the fixture at :514
    (`pairSig(I_SELL, "EUR/JPY")` on 15-minute bars) moves EUR/JPY to 1-hour bars; :556 / :573 (+3.20) become the
    chart's own numbers. The per-pair sentences at :429-434 (all five from v40's run) become each pair's own chart's:
    USD/JPY +2.67 (+5.69) and AUD/USD +4.94 (+5.18) from the 15-minute run; EUR/JPY +4.30 (+3.28), AUD/JPY +4.44
    (−0.75) and EUR/USD +3.11 (+2.61) from the 1-hour whole-file run. Its bars, reads and freshness are built per chart
    (7.1).
  - src/test/indicator-alerts.test.tsx: the pin `expect([...MACDH_INTERVALS]).toEqual(["15min"])` (:973) becomes a pin
    of `MACDH_INTERVAL_OF`; every `isMacdhChart` / `isIndicatorChartFor("macdx", …)` pin per pair; the gold and pair
    mail texts per chart; the code-text pin that no `MACDH_INTERVALS[0]` is left. The EUR/USD mail at :2276-2283
    (subject 「15分足」, 「ユーロ/ドルだけでは平均+3.11 pips（合図なしでは+2.60 pips）です。」 and its en) becomes the
    1-hour pair's: 「1時間足」 / "1-hour" and +2.61.
  - **More pins of the lines 3.2 changes** (added at the second review; the lists above left them out, and each would
    fail loudly, not pass a wrong build): src/test/macd-fade-alerts.test.ts:122-127 (`[...MACDH_INTERVALS]` =
    `["15min"]`, and `isMacdhChart(p, "15min")` true and `isIndicatorChartFor("macdx", p, "1h")` false for every
    `MACDH_PAIRS` entry) becomes the per-pair pin of `MACDH_INTERVAL_OF`; :1281 (`if (c.interval === MACDH_INTERVALS[0])
    fadeQuotes.set(c.pair, quotes);`) and :1284 (`fadeQuotes.get(pair)`), the lines of 3.2 item 5, become pins of the
    per-chart key and its lookup (and that the old lines are gone); :1351 (`export const MACDH_INTERVALS = ["15min"] as
    const;`, 3.2 item 1) becomes a pin that the constant is derived from the map; :1303 and
    src/test/indicator-alerts.test.tsx:1189 (`macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS },`, 3.2 item 6)
    become pins of the line with `limited`; indicator-alerts.test.tsx:1274's helper (`fadeSignal("macdx", pair,
    MACDH_INTERVALS[0], …)`, with `FADE_STEP` 15 minutes at :1269) takes the pair's own chart and step. The gold block
    of macd-fade-alerts.test.ts on `"15min"` (the Twelve Data fake :700-702, the stored-bars write :742, `goldFollow`
    :1106, the record pins :1123 and :1155, besides its alert rows :1128-1130 named above) moves to `"1h"`, as v40's
    tests.
  - src/test/stockmacd-alerts.test.tsx: as the first version (rebuilt on 15-minute answers, the run's budget, the
    closing-price texts absent, 3.3 item 6), and **review finding (2)**: spec 7.1 asked for `stockBarBreak` on a US half
    day and no test pins it (the pins at :195-202 hold New York's 15:45 bar, Tokyo's 11:15 and 15:15, and plain
    bars): a pin that the 12:45 New York bar of a half day gives `null` (7.1). And, only if 3.3 item 6's parser change is
    made, src/test/stocks.test.tsx's `15min` parser cases of 7.1 "A share" (added at the fourth review).
  - src/test/signal-alert-settings.test.tsx: the `macdx` fixtures (:372, :1079) gain the per-pair `limited` (and one
    without it draws the cross product, as today); the offer and grid pins per pair (made in step 2's PR on main's
    copy, above, and carried into the function's branch with main); the notes count (:550-551, 13 → 14);
    `items[1]` `not.toContain("確定から30分")` (:566) inverts (gold's 1-hour wording comes back); the all-symbols box
    `signal-alert-macdx-all-15min` (:618-691) covers USD/JPY and AUD/USD only, and a new pin for the 1時間 box covering
    the other four; the intro's 「15分足」 count (:1254, 6) becomes 3, and its en twin, the "15-minute" count (:1255, 6),
    becomes 3 too (section 5's four en replacements applied to HEAD en.ts:2013, python at the second review); the
    forbidden-number guards below.
  - src/test/econ-mailer.test.ts: the recipients per pair (3.6, 7.1); its lines not read by this writer.
  - src/test/landing.test.tsx: it reads one `FADE_MEASURED` (:9, :117); 〔adverse〕 is chosen per chart (section 5),
    the test evaluating each chart's run; the constants (:77-92) and the spec-text test (:156) follow section 5.
  - **The forbidden-number guards (review finding (1)).** src/test/signal-alert-settings.test.tsx:529-530 and
    src/test/landing.test.tsx:170-171 still hold the first 15-minute run's `3\.31` and `0\.90` (and :530 lacks `0\.78`);
    none holds the numbers of record the texts now show. They become four patterns, the same in both files (the old
    values kept, so that an old text cannot come back; this sentence said "two patterns each" until the second review,
    though the list below holds four), beside the guards each file has besides (`801|800|429|96\s?%` at
    :529, `\d+(\.\d+)?\s?%` at landing :170):
    - 1-hour (v40's run 44099401423 and run 44555599946):
      `/1,?490|1,?468|3\.26|3\.2[01]|2\.08|9,?820|1,?733|2,?243|0\.26|4\.30|3\.28|4\.44|0\.7[57]|3\.11|2\.6[01]|4\.42|5\.16|5\.74|0\.0[56]|5\.34|4\.10|0\.83|5\.42|5\.81|10\.7|8\.155/`
    - 15-minute (run 44535888012, and the first run's 3.31 / 0.90):
      `/6,?006|5,?926|2\.41|3\.3[12]|3\.19|0\.9[01]|0\.78|0\.80|2\.24|2\.25|5\.70|44,?784|1,?913|2,?975|11\.9|2\.67|5\.69|1\.29|3\.41|0\.82|0\.30|3\.86|4\.94|5\.18|5,?681|784,?561|959,?205|8\.156/`
    - the durations the notes print and the minutes behind them (15-minute 約545日 / 約666日, 1-hour 約477日 / 約617日, and
      the 1-hour run's minutes; 約4日 / 約3日 / 約2時間 are too common to forbid):
      `/約?(545|666|477|617)\s?日|(545|666|477|617) days|4,?489|687,?037|888,?900/`
    - the per-pair comparison the owner's choice rests on (section 1; 4.1 forbids its reason without its companions): the
      signal's win rates and no signal's, every pair's 15-minute counts (tp and trades), Fisher's p (corrected at the
      fifth review: it held only USD/JPY's and AUD/USD's trades and USD/JPY's tp of the ten 15-minute counts, and none
      of no signal's win rates; the 1-hour per-pair counts, three digits, are too common to forbid):
      `/99\.18|98\.91|98\.90|99\.00|98\.56|98\.61|98\.67|98\.73|98\.04|97\.44|99\.42|99\.14|99\.12|98\.75|98\.70|98\.48|98\.51|98\.31|1,?167|1,?180|1,?184|1,?185|1,?200|1,?201|1,?207|1,?217|1,?224|0\.51|0\.72/`
    - plus the release's own docs section if it is not 8.156.
    Checked by this writer with python on HEAD: none of the four patterns matches anything in the sales-page texts
    (`lp`, ja.ts :1997-2047, en.ts :1897-1944, the FAQ among them); the 1-hour pattern finds 20 distinct numbers in
    today's notes [7] (ja.ts:2148), and the durations pattern finds 約477日 and 約617日 there (and "477 days", "617 days"
    in en.ts:2043), so they catch real numbers. The first two patterns hold the 15-minute run's raw minutes, which no
    text prints, and not the days that the texts print; the third adds those. The four patterns were run again on the
    texts written out in section 5 (the FAQ answers, `lp.honestBody`, 「他のツールと何が違いますか？」, the card intro):
    no match (python, at the review). The fifth review's additions to the fourth pattern were run the same way on HEAD's
    `lp` (ja.ts :1997-2047, en.ts :1897-1944), on HEAD's ja.ts and en.ts whole, and on section 5: no match (python). Still, no pattern list can hold every number a text could leak; they hold the
    numbers of record named here. (The first version's list at this place, "3.31 … 0.90", was the first run's and is
    gone.)

### 3.6 No schema migration; only the moving charts get 15-minute twins

- **No DDL.** `'15min'` is allowed by `signal_alert_subscriptions_interval_check` (supabase/migrations/20261011120000_gold_minutes_all_day.sql:113-115,
  the last migration that sets it). The rule check holds `macdx` and `stockmacd`
  (20261105060000_signal_alert_spike.sql:19-21). The unique key is `(user_id, pair, interval, rule)`
  (20260925180000_signal_alert_rules.sql:22-24); a row's `created_at` defaults to `now()`
  (20260925120000_signal_alerts.sql:16). `signal_alerts` needs nothing new (research/macdfade1h-prod-spec.md 3.6, its
  first item).
- **Who moves and who does not.**
  - **`macdx` on USD/JPY and AUD/USD, and every `stockmacd` row**: v40 reads, offers and accepts `'1h'` only, v41
    `'15min'` only. A row left on `'1h'` gets no mail under v41, and its owner cannot untick it (`set` and `set_many`
    refuse a chart the rule is not offered on, HEAD index.ts:2132, :2173; the grid draws only offered cells). These get
    twins, a reconcile, a later delete and, in a rollback, a rebuild.
  - **`macdx` on EUR/JPY, AUD/JPY, EUR/USD and XAU/USD**: v40 and v41 read, offer and accept the same `'1h'` row. A tick
    or untick under either version changes the row both read. **No statement below touches them**; their counts are
    read before and after each statement to show it. (The first version's twin statement, for every `macdx` row, would
    have given these four `'15min'` rows that v41 never mails and nobody can untick.)
- Every statement below uses the same set, written out in each so that each can be sent alone:
  `((rule = 'macdx' and pair in ('USD/JPY', 'AUD/USD')) or rule = 'stockmacd')`.
- **The count** (before and after every statement; no user ids), kept broad on purpose so that the four untouched
  charts are seen to be untouched:

  ```sql
  select rule, pair, interval, count(*) from public.signal_alert_subscriptions
   where rule in ('macdx', 'stockmacd') group by 1, 2, 3 order by 1, 2, 3;
  ```
- **Each statement lists what it changed, in the same statement** (added at the fourth review: both versions accept ticks
  and unticks on the four 1-hour charts, and v40 on the `'1h'` rows of USD/JPY, AUD/USD and the shares, between the
  count before and the count after, so an exact before/after equality could fail for a correct statement). Every insert
  and delete below (the twins, (a1), (a2), the later delete, and 6.4's rebuild delete and insert, (b1), (b2) and
  `'15min'` delete) is sent wrapped so that it reports its own rows (no user ids):

  ```sql
  with c as (〔the statement, without its ;〕 returning rule, pair, interval)
  select rule, pair, interval, count(*) from c group by 1, 2, 3 order by 1, 2, 3;
  ```
  (`on conflict … do nothing` returns only the rows inserted.) The check of a statement is that list: only rows of the
  narrowed set, and only of the interval it names (`'15min'` for the twins, (a1), (a2) and 6.4's `'15min'` delete;
  `'1h'` for the later delete, the rebuild's delete and insert, (b1) and (b2)); never a row of the four 1-hour charts.
  The counts before and after stay as context: a change in them that the list does not show is followers' ticks or
  unticks between the reads, written down as such (docs §8.156), not a failed statement. 7.1's local run pins each list.
- **The twins, before the function's merge** (6.3 step 3; T0 = the statement's time, recorded when sent):

  ```sql
  insert into public.signal_alert_subscriptions (user_id, pair, interval, rule, lang)
  select user_id, pair, '15min', rule, lang from public.signal_alert_subscriptions
   where interval = '1h'
     and ((rule = 'macdx' and pair in ('USD/JPY', 'AUD/USD')) or rule = 'stockmacd')
  on conflict (user_id, pair, interval, rule) do nothing;
  ```
  After it: its own list (above) shows only `'15min'` rows of (`macdx`, USD/JPY), (`macdx`, AUD/USD) and `stockmacd`, and
  no row of EUR/JPY, AUD/JPY, EUR/USD or XAU/USD. As context, the counts after it: for (`macdx`, USD/JPY), (`macdx`,
  AUD/USD) and each `stockmacd` pair the `'15min'` count equals the `'1h'` count; (`macdx`, EUR/JPY | AUD/JPY | EUR/USD |
  XAU/USD, `'1h'`) equal their counts before; no `'15min'` `macdx` row appears on those four; a difference the list does
  not explain is a follower's tick or untick between the reads, written down (corrected at the fourth review: these
  counts were the check). (Whether any `'15min'` `macdx` row is there today: production not read; the count before shows
  it, and one found there is told to the owner before anything is sent.)
  - v40 ignores the twins: its filters take `'1h'` only (index.ts:776-778 through `isMacdhChart`; :1525 through
    `isStockmacdChart`; v40's lines). v41 ignores the `'1h'` rows of USD/JPY, AUD/USD and the shares the same way once
    3.2 item 2 is built (HEAD index.ts:798, :931, :1576). So no time needs both, and no follower has a gap: the twin is
    there when v41 first answers, whenever that is. (v31's move, one `update` sent about a minute after v31 answered,
    left one run with no subscriptions, docs §8.127.)
  - `on conflict … do nothing`: a `'15min'` row a follower already has (none can exist under v40, whose `set` refuses
    it) is left as it is. Sent once; a second send adds nothing.
- **The two sets drift apart once the twins are in** (USD/JPY, AUD/USD and the shares only). The twins are a one-time
  copy. A tick or untick changes the row of the interval the screen offers only (`set`: the DELETE of that interval
  only, HEAD index.ts:2151-2157; `set_many`: per interval, HEAD :2188-2199). So (a) between the twins and the end of
  v41's deploy, a v40 untick deletes the `'1h'` row and leaves the twin, which v41 would mail although the v40 screen
  showed the chart off (HEAD :2151-2152: nobody should need a subscription to stop mail); a v40 tick makes a `'1h'` row
  with no twin, which v41 would never mail. (b) Under v41, before step 9, an untick leaves the `'1h'` row and a tick makes
  no `'1h'` row, so a rollback to v40 would mail the first and miss the second (6.4 handles it). So the twins go in as
  close to the merge as the steps allow (6.3 step 3), and **once v41 has answered** (6.3 step 5b) the sets are reconciled
  once, with the owner's confirmation.
  **The times.** M = the function merge's time (from the PR). v41's `set` and `set_many` answer the screen from the end of
  its deploy, which follows M; T1, v41's first answer of the minute run (from the run's record), comes up to about a
  minute after that. So T1 is not a bound for the screen's ticks: a `'15min'` tick under v41 between the deploy and T1
  would have `created_at` before T1. M is: before M only v40 serves the screen, and v40's `set` refuses `'15min'` for
  `macdx` and `stockmacd` (and `set_many` likewise), so a `'15min'` row of these made before M can only be a twin. T1 is
  kept as a record only. (`set` sends no `created_at`, HEAD index.ts:2139-2144, nor does `set_many`, HEAD :2178-2181, so
  a new row takes `now()`, 20260925120000_signal_alerts.sql:16; v40's are the same, 9ca2054 index.ts:2075-2078,
  :2112-2115.)
  **A tick on a row that already exists keeps its old `created_at`** (corrected at the second review). Both upsert with
  `on_conflict=user_id,pair,interval,rule` and `Prefer: resolution=merge-duplicates`, and their body holds only
  user_id, pair, interval, rule and lang, so a conflicting row is updated in those columns and keeps its `created_at`
  (no trigger on this table touches it: a grep of supabase/migrations). And a tick does land on existing rows: the
  all-symbols box sends every offered pair of its column, ticked ones included (`offered(iv)` and `toggleMany(pairs.map(…),
  !all, …)`, src/components/SignalAlertSettings.tsx:228, :244-258). So, as HEAD stands, a follower who unticked a
  USD/JPY `'1h'` row under v40 after T0 (the twin left) and then, under v41, ticked the 15分 all-symbols box, would keep
  the twin with `created_at` = T0, and (a1) would delete it against that last tick (no USD/JPY mail, and no econ digest
  if it was their only `macdx` row). **So v41's `set` and `set_many` (on) put `created_at` (the function's now) in the
  upsert body** (HEAD index.ts:2144 and :2181, beside `lang`; every rule's rows alike). Then every v41 tick, of a new row
  or of one that exists, shows `created_at` at or after v41's deploy, after M, and (a1) cannot delete it. Nothing reads
  a subscription's `created_at` but the status call's and the test mail's order (HEAD index.ts:2049, :2217; grep of
  supabase/functions, econ-calendar's index.ts not read, and of scripts/morning-check/src) and 3.6's and 6.4's own
  statements; 7.1 pins the field. v40's code cannot be changed, so (b1) in a rollback keeps the same limit (6.4).

  ```sql
  -- (a1) twins whose '1h' row was unticked under v40 after the twins went in. A '15min' row of these made before M (the
  -- function merge's time) can only be a twin: v40's set refuses '15min' for macdx and stockmacd. Once v41's deploy has
  -- ended none of these '1h' rows can be unticked: v41's set refuses '1h' for macdx on USD/JPY and AUD/USD and for
  -- stockmacd (it still accepts '1h' for EUR/JPY, AUD/JPY, EUR/USD and XAU/USD, which this statement does not touch).
  -- (Bound by M, not by T1: a v41 tick between its deploy and T1 is not a twin and must stay; it shows created_at at
  -- or after v41's deploy, a tick on an existing twin included, only because v41's set and set_many send created_at.)
  delete from public.signal_alert_subscriptions t
   where t.interval = '15min' and t.created_at < '〔M〕'
     and ((t.rule = 'macdx' and t.pair in ('USD/JPY', 'AUD/USD')) or t.rule = 'stockmacd')
     and not exists (select 1 from public.signal_alert_subscriptions h
                      where h.user_id = t.user_id and h.pair = t.pair and h.rule = t.rule and h.interval = '1h');
  -- (a2) '1h' rows of these ticked under v40 after the twins went in (from a minute before T0, on the safe side: a row
  -- that has its twin already is left as it is)
  insert into public.signal_alert_subscriptions (user_id, pair, interval, rule, lang)
  select user_id, pair, '15min', rule, lang from public.signal_alert_subscriptions
   where interval = '1h' and created_at >= '〔T0 less one minute〕'
     and ((rule = 'macdx' and pair in ('USD/JPY', 'AUD/USD')) or rule = 'stockmacd')
  on conflict (user_id, pair, interval, rule) do nothing;
  ```
  Counted before and after. After it each narrowed `'15min'` count should equal its `'1h'` count; a difference left can
  only be a tick or untick under v41 since its deploy, and is written down as it is (docs §8.156). Sending it soon after
  T1 keeps (a) small; whether any row was ticked or unticked between T0 and the deploy is read from these counts, not
  assumed. **A limit of (a2), written down in docs §8.156:** every `'1h'` row created at or after T0 − 1 minute whose
  `'15min'` row is gone when (a2) is sent is twinned again, even if that `'15min'` row was unticked under v41, and v41
  then mails that follower against the untick. (Corrected at the second review; the first wording named only a `'1h'`
  row ticked under v40 after T0 whose owner, under v41, ticks the 15分 box and unticks it again. A single untick under
  v41 is enough: of a twin made at T0 from a `'1h'` row ticked in the minute before T0, or of an old twin whose `'1h'`
  row was unticked and ticked again under v40 after T0, which (a1) keeps since a `'1h'` row exists again.) Nothing in
  the rows shows such an untick. So 5b is sent as soon as the live-chart check passes (6.3 step 5b), to keep that window
  small.
- **Later** (6.3 step 9, once v41 has run clean, **and only after econ-calendar is deployed again**, 6.3 step 6):

  ```sql
  delete from public.signal_alert_subscriptions
   where interval = '1h'
     and ((rule = 'macdx' and pair in ('USD/JPY', 'AUD/USD')) or rule = 'stockmacd');
  ```
  Counted the same way before and after. **Never the first version's bare `rule in ('macdx', 'stockmacd') and interval
  = '1h'`:** it would delete the live rows of EUR/JPY, AUD/JPY, EUR/USD and gold, which v41 mails from.
- **The econ digest's recipients at every step.** A person is a recipient while some row has `rule = 'macdx'` and
  `isMacdhChart(pair, interval)` (econ-calendar/mailer.ts:90; `stockmacd` rows never count). econ-calendar bundles
  `isMacdhChart` (mailer.ts:13) and is not in the push's default list (deploy-functions.yml:66-70, :76), so the live
  bundle is v40's (deployed by name at v40's release, OPERATIONS.md:13006) until 6.3 step 6. Let A be the people with a
  `'1h'` `macdx` row on EUR/JPY, AUD/JPY, EUR/USD or XAU/USD, B1h those with a `'1h'` `macdx` row on USD/JPY or AUD/USD,
  B15 the same on `'15min'`. v40's bundle sends to A ∪ B1h, the per-pair bundle to A ∪ B15.

  | step (6.3) | econ bundle | recipients | anyone dropped |
  |---|---|---|---|
  | before | v40's | A ∪ B1h | — |
  | 3 twins (T0) | v40's | A ∪ B1h (twins not read) | none |
  | 4 merge, v41 answers (T1) | v40's (a push does not deploy econ) | A ∪ B1h; from v41's deploy B1h is frozen (v41 refuses `'1h'` on these two) | none |
  | 5b reconcile | v40's | A ∪ B1h; B15 made equal to B1h | none |
  | 6 econ by name | per pair | A ∪ B15 (= A ∪ B1h but for v41 ticks and unticks since its deploy, the follower's own) | none wrongly |
  | 9 delete of these `'1h'` rows | per pair | A ∪ B15 (the per-pair bundle never read them) | none |

  Two order rules keep it so: **5b before 6** (else a USD/JPY or AUD/USD `'1h'` row ticked under v40 after T0, with no
  twin yet, drops at step 6 until 5b) and **9 after 6** (else, under v40's bundle, people whose only `macdx` rows were
  USD/JPY or AUD/USD lose it). **HEAD's econ-calendar (15 minutes for all six) is never deployed:** everyone following
  only EUR/JPY, AUD/JPY, EUR/USD or gold would drop. The digest's footer names no timeframe (econ-calendar/digest.ts,
  as the first writer read it): no text change.
- These statements (the twins, the reconcile, the later delete, and 6.4's) are sent by hand **with the owner's
  confirmation** (the Supabase connector asks the owner; a connector timeout is not proof that nothing ran, so the counts
  are read back; or the owner runs it in the SQL Editor). **A send that timed out can also run later** (added at the
  fifth review: scripts/morning-check/README.md:353, of three sends that timed out the second or the third ran after its
  timeout, when and which not known; the read-back shows only what has run so far). So a statement is not sent again
  while an earlier prompt of it may still be answered, and the step that rests on it waits until none may: the owner
  declines every open prompt of it first, or, if that cannot be told, closes them and runs the statement in the SQL
  Editor; this is written in docs §8.156. Above all **the twins before the merge** (a twin run late, after v41's deploy,
  brings back a twin unticked under v41, with `created_at` after M, which (a1) cannot remove, and v41 mails against the
  untick until step 9) and **the rebuild before the revert** (a rebuild run late, after V, deletes `'1h'` rows ticked
  under v40 with no `'15min'` row and brings back `'1h'` rows unticked under v40; (b1) and (b2) repair neither, 6.4;
  its delete is bounded by R for that, 6.4). Whether a prompt the connector stopped waiting for can still be answered,
  and how the owner closes one, is not known here. Each has been run first on a local PostgreSQL (7.1, 6.1); in
  production each delete is first sent as its matching `select rule, pair, interval, created_at` (no user ids) of the
  rows it would remove, read against the cases this section and 6.4 expect, and only then sent; the literals M, T0, R
  and V are written as ISO 8601 UTC with `Z` (added at the third review: the after-count of the reconcile accepts any
  result, so it could not show a wrong (a1)). They are recorded word for word in docs §8.156, not as files
  under supabase/migrations/ (nothing applies those automatically, but a data statement there would read as part of the
  schema). How many rows there are, and on which interval, is not read here (production not read).
- While both rows exist (from T0 to step 9), only one of a follower's two rows of USD/JPY, AUD/USD or a share is mailed:
  under v40 the `'1h'` row (its filters take `'1h'` only, so the twin is not mailed), under v41 the twin (its filters
  take `'15min'` only, so the `'1h'` row is not mailed). The test mail tells the follower that a signal on a chart it
  lists arrives at their address (「登録したチャートで…サインが出ると、このアドレスに届きます」 / "fires a BUY or SELL on a chart you follow, the alert
  arrives at this address", and the list 「登録中のチャート」 / "Charts you follow": `renderTestMail`, logic.ts:501-519),
  and it lists every row, unfiltered (HEAD index.ts:2217-2224). Left so, from T0 to step 9 (a day or more) it would name
  charts that are not mailed. **So v41's test action lists only the rows the running version mails:** before the map
  at HEAD index.ts:2223, `.filter((s) => !isIndicatorRule(s.rule) || isIndicatorChartFor(s.rule, s.pair, s.interval))`
  (`isIndicatorChartFor` takes `macdx` through `isMacdhChart` and `stockmacd` through `isStockmacdChart`, HEAD
  indicators.ts:332-343; the other rules' rows as today); 7.1 pins it. v40's test mail is v40's code and is not changed:
  from T0 to the end of v41's deploy (minutes, 6.3 step 3) it also lists each twin as 「15分足」, and after a rollback,
  from the revert's deploy to 6.4's `'15min'` delete, each `'15min'` row; both spans are written down in docs §8.156.
  A rollback finds those `'1h'` rows still there, but out of date by every tick and untick under v41, so 6.4 rebuilds
  them from the `'15min'` rows before reverting.
- **The screen** offers what the server says: once v41 answers and the app reads `macdx.limited` (section 5), the
  `macdx` grid shows two columns, 15分 (USD/JPY and AUD/USD, ticked where the twin is) and 1時間 (EUR/JPY, AUD/JPY,
  EUR/USD and gold, as under v40), each pair a box on its own chart and "—" on the other; the `stockmacd` grid shows one
  15分 column.

### 3.7 Ids and version

| chart | instruments | id | built |
|---|---|---|---|
| `15min` | USD/JPY, AUD/USD | `macdx_12_26_9_w600_15min_fade96of120_in_v12` | `fadeRuleId("macdx", "15min", 12)` through `macdhRuleId` (3.2 item 3) |
| `1h` | EUR/JPY, AUD/JPY, EUR/USD, XAU/USD | `macdx_12_26_9_w600_1h_fade96of120_in_v11` (v40's) | `fadeRuleId("macdx", "1h", 11)` through `macdhRuleId` |
| `15min` | the 22 shares | `stockmacd_12_26_9_w600_15min_fade96of120_in_v5` | `fadeRuleId("stockmacd", STOCKMACD_INTERVALS[0], 5)` (`STOCKMACD_FADE_VERSION`, HEAD stocks.ts:71-72) |

`fadeRuleId` (HEAD macd-fade.ts:47-48) puts the interval in the id. **The version follows the chart: 12 on `15min`, 11
on `1h`; the shares 5.** Why:
- research/macdfade1h-prod-spec.md 3.7 chose "a number no id ever written holds". Since 2026-11-18 v40 writes
  `…_1h_fade96of120_in_v11` and `…_1h_fade96of120_in_v4`, so 11 and 4 are written numbers; the charts that change get
  the next free ones, 12 (USD/JPY and AUD/USD) and 5 (the shares). Every earlier change of the MACD email's chart raised
  the number: v6 (1 hour) → v7 (15 minutes, v31, docs §8.127) → v8 (1 hour again, v33).
- **EUR/JPY, AUD/JPY, EUR/USD and gold keep v11**: the same rule on the same chart as v40, nothing of the rule changes
  for them. A new number would split one rule's record in two for nothing, and would make the switch on those charts a
  gap-or-overlap question (two ids do not collide under the claim key, 2.5) where under one id it is a plain redeploy
  (6.2).
- The never-built strings of 2026-11-17, `macdx_…_15min_fade96of120_in_v11` and `stockmacd_…_15min_fade96of120_in_v4`
  (research/macdfade15-prod-spec.md:264-265), stay the record of that spec; the tests list them as other ids. They keep
  that meaning. (`…_15min_…_in_v11` and v40's `…_1h_…_in_v11` differ by the interval, so no id names two rules.)
- No `macdx` id ever written holds v12 and no `stockmacd` id holds v5 (the first writer's `git grep`, 2026-11-19; the
  build's ids since are these).
- **Both `macdx` ids live at once.** The `signal_alerts` rows of the two charts differ in pair, interval and rule, and
  `mailRide`'s one-side read is by pair, interval, bar and id (HEAD index.ts:740), so they never meet. The app reads both
  (3.5). The morning check reads each with its own statement (7.3). Nothing else in the function names a `macdx` id
  (3.2 item 4).

`FUNCTION_VERSION` (HEAD index.ts:389, `"signal-alerts-v41-2026-11-23"`) is set to `"signal-alerts-v41-<the deploy's
date>"` at the release, with the per-pair v41 note in the header (HEAD :369-388). Of the eight test lines that name it
(3.5), six pin the whole string and change with the date at the release; two pin only the `signal-alerts-v41` prefix
and do not.

## 4. The emails

### 4.1 Rules for every text

As research/macdfade1h-prod-spec.md 4.1, word for word, with today's lines: the pairs' and gold's how-to-stop line is
indicators.ts:1484 / en :1458; the shares' is stocks.ts:328 / en :304; the econ footer is econ-calendar/digest.ts:425 /
:455 (unchanged: it names no timeframe). Additions: no text writes Tokyo's delay as more than 「約15分」 / "about 15
minutes" (the measured value); no text says how many minutes after the close a mail is sent unless it says that this
was not measured; **a text that names the fade's chart names each pair's own** (never "the five pairs and gold on
15-minute bars"); and **no text gives the reason for a pair's chart** (「勝率の高い方」) unless it gives, beside it, that
pair's numbers on both charts with the companions CLAUDE.md asks for and the finding that every gap is within chance
(section 1). The texts of this file give none: they say the owner chose each pair's timeframe.

### 4.2 Subjects

The timeframe comes from `tfLabel` (logic.ts), so it is the signal's own chart:
- USD/JPY, AUD/USD: 「【Sextant】ドル/円 15分足 売り（SELL）: 青い線が上の端の96%で確定（MACD の逆張り）」 (bottom: 「買い（BUY）:
  青い線が下の端の96%で確定」); en "[Sextant] USD/JPY 15-minute SELL: the MACD line closed at 96% of the top (MACD fade)"
  (HEAD indicators.ts:1470 / ja :1496 build it from `tf`).
- EUR/JPY, AUD/JPY, EUR/USD and gold: v40's, with 「1時間足」 / "1-hour" (unchanged from v40).
- Shares: 「【Sextant】〔name〕（〔code〕）15分足 売り（SELL・空売り）: 青い線が上の端の96%で確定（株の MACD）」; en "[Sextant]
  〔name〕 (〔code〕) 15-minute SELL (short sale): the MACD line closed at 96% of the top (Stock MACD)" (3.3 item 7).

### 4.3 The pairs' and gold's email (`renderFadeMail`, HEAD indicators.ts:1454)

**EUR/JPY, AUD/JPY, EUR/USD and gold (`1h`): v40's email, word for word** (research/macdfade1h-prod-spec.md 4.3; v40's
code at 9ca2054 indicators.ts:1421-1486), with one difference: a pair's item 9 is 4.5's `1h` paragraph (run
44555599946's numbers, the docs section of the release, the 〔mailedOn〕 sentence, the three phrases 4.5 rewrites
for the per-pair form, and 4.5's per-pair chance sentence; so item 9 is no longer v40's word for word). Gold's item 9 stays
v40's word for word ("Not measured on gold … The numbers measured on the five pairs are in the app's settings notes."
/ 「金では測っていません…5ペアで測った数字は、アプリの設定の注にあります。」, HEAD en :1485, ja :1511): still true, the
notes holding both charts' numbers.

**USD/JPY and AUD/USD (`15min`):** items 1 to 7 and 11 as research/macdfade1h-prod-spec.md 4.3, with 「1時間足」 /
"1-hour" read as 「15分足」 / "15-minute". They take `tfLabel` (HEAD indicators.ts:1464), so they change by themselves.
The source line of item 11 then reads 「上の値段は、同じ15分足の売値・買値の終値です。」 / "the price above is the same
15-minute bar's bid or ask close."

8. (rewritten; HEAD ja :1508-1509 / en :1482-1483) 「このメールは、足の確定の直後・1分後・3分後の読み込みで判定して送ります
   （実際に何分で届くかは測っていません）。」 Then, as today: 「届いた時の値段は、上の終値と違うことがあります（その差は測って
   いません）。週末の止まっている時間（日本時間 土曜6:00〜月曜7:00）に確定した足は判定しません。」 (The reads:
   `gmoIntervalsDue`, HEAD indicators.ts:1055.)
9. The measured paragraph of the 15-minute run of record (4.5).
10. (rewritten; HEAD ja :1513 / en :1487) 「この決まりは Sextant 独自のもので、公開されているインジケーターではありません。
    96%・足の確定で判定すること・メールを15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き・
    利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じ
    です。」 The 15-minute pane is the owner's choice (2026-11-17, section 1), so it is attributed to the owner; the 1-hour
    mails keep v40's sentence, which does not attribute the 1-hour pane.

en, the items that change for USD/JPY and AUD/USD:
8. "This email is judged and sent at the reads right after the bar closes and 1 and 3 minutes after (how long it takes
   to arrive has not been measured)." Then, as today: "The price when it arrives may differ from the close above (the
   difference has not been measured). Bars that close in the weekend pause (Friday 21:00 to Sunday 22:00 UTC) are not
   judged."
10. "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging the email on
    15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side and stating no take-profit or stop
    price are the app owner's choices. That pane is the same as the app's 15-minute chart's."

So the code (3.2 item 7): item 8 and item 10 by `s.interval` (`"15min"` the sentences above, HEAD's; `"1h"` v40's,
gold's and the pairs'); HEAD's gold sentence for 15 minutes ("from 1 minute after the bar closes until the next bar
closes" / 「次の足が確定するまで」, HEAD en :1481, ja :1507) goes. A mail of a pair on a chart that is not its own is never
made (`isMacdhChart`, 3.2 item 2).

### 4.4 The shares' email (`renderStockMail`, stocks.ts:261-330)

Items 1 to 7, 9 and 11: as research/macdfade1h-prod-spec.md 4.4, with 「1時間足」 / "1-hour" read as 「15分足」 / "15-minute"
(they take `tfLabel`, 3.3 item 7). The closing-price sentence of item 11 (「取引時間の最後の足は、引けの値段で判定します。」 /
"a session's last bar is judged on its closing price", stocks.ts:327 / :303) is removed, ja and en: the closing-price
condition of 3.3 item 6 cannot hold at Tokyo's 11:15 bar on the shapes seen (decided at the second review; HEAD's build
has already removed it, HEAD stocks.ts:295-298). For the same reason the parenthesis of `stockmacdNotes` [2],
〔closing〕, is empty (section 5).

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
    判定すること・株を15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き（株にも当てはめること）・
    利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。」 /
    "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging shares on 15-minute
    bars, the MACD pane of the newest 120 15-minute bars, the fade side (shares included) and stating no take-profit
    or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's." (The shares'
    15-minute bars and the pane are the owner's choices of 2026-11-17 and 11-19, section 1.) (Corrected at the third
    review: the first version's 「株も15分足で判定すること」 / "judging shares on 15-minute bars too" said, through
    「も」 / "too", that the fade's mails are on 15-minute bars as well; under per pair four of its six charts are 1-hour
    (4.1). v40's own sentence had no 「も」, 9ca2054 stocks.ts:326 / en :302. So HEAD stocks.ts:366 / en :342
    (`株も${tf}` / `on ${tf} bars too`) change, with the pins src/test/stockmacd-alerts.test.tsx:587, :589, :823, :825
    and src/test/signal-alert-settings.test.tsx:805, :807, :814, :821, and `stockmacdNotes` [3], section 5.)

### 4.5 The measured paragraph (pairs only; `FADE_MEASURED`, `fadeMeasuredLine`), one run per chart

**HEAD: not done.** `_shared/macd-fade-measured.ts` is v40's file unchanged (one run, the 1-hour run 44099401423,
base +3.20; `if (m.tf !== "1h") throw`, HEAD :265; the bar's word hard-coded 「1時間足」 / "1-hour" at HEAD :227-228,
:300, :313, :325, :336; `chanceOf` with the "both inside" sentence only, HEAD :232-246). So HEAD's 15-minute mails would
carry 1-hour words and v40's numbers; the build's own message lists it as still to do.

**The two runs of record, never mixed.** Each pair's mail reads the run of its own chart only; nothing from the other
chart's run appears in it.

| chart (pairs mailed) | run | summary.json in the repository | sha256 (bytes) | replaces |
|---|---|---|---|---|
| `15min` (USD/JPY, AUD/USD) | Actions run 44535888012, main 9ca2054 (research/macdfade15-spec.md :446-503) | research/ledger/macdfade15-summary.json | `eacb7815d7779be716b24e559c0aea139e6455910abcf4b1ec59ab4d8c5eb188` (16,817); without the bytes `,\n  "tf": "15min"`: `74a4a230a291d68a8e8169ea293a5428f46863ffc0ed86804522f4f509cc888b` | the first run 44077464383 (three GMO 1-minute day files of 2025-06-20 kept cut short) |
| `1h` (EUR/JPY, AUD/JPY, EUR/USD) | Actions run 44555599946, commit e4b16c7 (:505-555) | research/ledger/macdfade1h-whole-summary.json | `d59b64c6212e594f0b3b4a89bb1683a6a5f98652208cafb59f6420bb352c833b` (16,648) | v40's run 44099401423 (research/ledger/macdfade1h-summary.json, `60edab22…`; the same three short files) |

Both copies came in by route 1 (research/macdfade1h-prod-spec.md 4.5: the job's one base64 line decoded, the same
sha256; a964994 and e660119), and the Python agreed with every row and number of each run. Against v40's run, the 1-hour
re-run moved only the no-signal values (base +3.2016 → +3.2070: +3.20 → +3.21; USD/JPY +5.739 → +5.745; AUD/JPY −0.766
→ −0.752: −0.77 → −0.75; EUR/USD +2.601 → +2.610: +2.60 → +2.61); every fade and flow value is the same (research/macdfade15-spec.md
:519-532). The sha256 and sizes above were checked by this writer (2026-11-19).

**The module** (`_shared/macd-fade-measured.ts`):
- `FadeTf = "15min" | "1h"`; `FADE_MEASURED: Readonly<Record<FadeTf, FadeMeasured>>` and `FADE_MEASURED_SOURCE` keyed
  the same way (the run, the commit, the run it replaces and why, the ledger path, its sha256; the 15-minute one also
  the sha256 without its `tf` line). Each run written out from its ledger copy by a script (not by hand); a test reads
  each copy and pins every value of its run to it, `meta.tf`, `meta.share` 0.96 and `meta.tp` 10 included. `FadeMeasured`
  needs no new field (`tf` is in it, HEAD :36-70).
- `fadeMeasuredLine(lang, pair, tf, m = FADE_MEASURED[tf])`: it throws if `tf` has no run, if `m.tf !== tf`, or if
  `pair` is not among `m.pairs`. `renderFadeMail` passes the signal's own chart (`s.interval`), so the paragraph's numbers
  and its bar word are always those of the chart the bar was judged on, the same chart `tfLabel` names in the mail. In
  the run these throws would come after `claimRow` and leave a `pending` row with no mail (3.2 item 7), so the run must
  never reach them (the pin of each pair's chart to a run that holds the pair, 〔mailedOn〕 below, is what keeps them
  unreachable for the run's own signals).
- **The bar's word from `m.tf`** at the six places (HEAD :227-228 〔baseWhat〕, :300, :313, :325, :336): `"15min"` →
  「15分足」 / "15-minute", `"1h"` → 「1時間足」 / "1-hour"; any other value stops the build. The check at HEAD :265
  becomes "`m.tf` is `"15min"` or `"1h"`".
- **〔mailedOn〕** (new, below) from a literal in the module, `FADE_MAILED_ON: Record<FadeTf, readonly string[]>` =
  `"15min"`: USD/JPY, AUD/USD; `"1h"`: EUR/JPY, AUD/JPY, EUR/USD. A test (src/test/macd-fade.test.ts, which may import
  both files) pins it to the function's map: for every one of the five pairs, `MACDH_INTERVAL_OF[pair]` has a run here
  with that `tf`, the pair is among that run's pairs, and the pair is in `FADE_MAILED_ON[MACDH_INTERVAL_OF[pair]]`; and
  no pair is in both lists. (This replaces the first version's `FADE_MEASURED_TF` literal and its pin
  `FADE_MEASURED_TF === MACDH_INTERVALS[0]`, which cannot hold with two charts.)
- **The module still imports nothing from signal-alerts** (today only ./pair-names.ts, HEAD :30; pinned by
  src/test/macd-fade.test.ts:185). Why, as the first version found: indicators.ts imports this module (HEAD
  indicators.ts:41), and this module builds `FADE_MEASURED_NOTES` while it loads (HEAD :353-356); an import back would
  read indicators.ts's constants before they are set, a `ReferenceError` while the modules load, and signal-alerts (every
  rule's mail), econ-calendar and live-chart would not start (a minimal ESM model of the cycle in node, 2026-11-19, the
  first writer). Passing `s.interval` in avoids any import.
- `chanceOf` carries both sentences below, each chosen from its run's unrounded gaps against its own `chance` ranges;
  any other case still stops the build. Both runs' paragraphs are built while the module loads, so a run that cannot be
  written stops the module in the tests (and would stop the three functions: so both are built in the tests).
- `fadeMeasuredNotes(lang, tf)` and `FADE_MEASURED_NOTES: Record<FadeTf, Record<FadeLang, string>>`: one notes paragraph
  per chart (section 5, notes [7] and [8]).

**Which "all" numbers a pair's mail shows: its own chart's five-pair totals, named as five pairs on that chart, with its
own pair's sentence from the same run, and a sentence saying which pairs are mailed on that chart.** Never a total of
only the two or three pairs mailed on the chart, and never the other chart's numbers. Why (the honest and the simplest
choice):
- The five-pair total on one chart is what the study measured and the Python checked (`dirs.fade.all`, `dirs.flow.all`,
  `base.all`). A total of only the pairs mailed on a chart is in neither summary.json: its medians and P90s cannot be
  made from them, and the walks' ranges that 〔chance〕 needs were printed for the five-pair gaps only
  (research/macdfade15-spec.md :497-500, :548-550; null.json is not in the repository), so such a paragraph would be a
  new measurement.
- The pairs on each chart were picked by the higher win rate on these same data; a total of only the picked pairs would
  look better through the picking itself.
- The sentence 〔mailedOn〕 keeps the five-pair numbers from being misread: without it a 1-hour mail's 〔negPairs〕 reads
  「ドル/円（-0.26 pips）」, though USD/JPY is mailed on 15-minute bars (+2.67 there), and a 15-minute mail's reads
  「豪ドル/円（-0.82 pips）」, though AUD/JPY is mailed on 1-hour bars (+4.44 there). So it says three things: which
  pairs' mails are judged on this chart; that the other pairs' mails are judged on the other chart and carry the
  numbers measured there; and that **every number in this paragraph, the other pairs' included, was measured on this
  chart** (the paragraph prints the other chart's pairs' numbers of this chart: 〔negPairs〕, and in the notes every
  pair's mean). (Corrected at the review: the first wording, 「…は1時間足で判定し、その数字は1時間足で測ったものです」,
  said those pairs' numbers in the paragraph were the other chart's, which the paragraph itself contradicts.)

This is a writing choice, not the owner's: the owner is not asked (the numbers shown are measured ones, named as what
they are).

**〔mailedOn〕**, right after the first sentence of the paragraph, in the mail and in the notes alike (each pinned word
for word, ja and en, 7.1):
- `15min`: ja 「この5ペアのうち、メールを15分足で判定するのはドル/円・豪ドル/ドルです。ユーロ/円・豪ドル/円・ユーロ/ドルのメールは1時間足で判定し、そのメールには1時間足で測った数字を載せています（この段落の数字は、どのペアの分も、すべて15分足で測ったものです）。」
  en "Of these five pairs, the email is judged on 15-minute bars for USD/JPY and AUD/USD. The emails of EUR/JPY, AUD/JPY and EUR/USD are judged on 1-hour bars and carry the numbers measured on 1-hour bars (every number in this paragraph, for every pair, was measured on 15-minute bars)."
- `1h`: ja 「この5ペアのうち、メールを1時間足で判定するのはユーロ/円・豪ドル/円・ユーロ/ドルです。ドル/円・豪ドル/ドルのメールは15分足で判定し、そのメールには15分足で測った数字を載せています（この段落の数字は、どのペアの分も、すべて1時間足で測ったものです）。」
  en "Of these five pairs, the email is judged on 1-hour bars for EUR/JPY, AUD/JPY and EUR/USD. The emails of USD/JPY and AUD/USD are judged on 15-minute bars and carry the numbers measured on 15-minute bars (every number in this paragraph, for every pair, was measured on 1-hour bars)."
(The pair names: `pairJa` in ja, the codes in en, in `FADE_MAILED_ON`'s order; the other chart's list is the run's
pairs not in it, in the run's order. No count of pairs is written, so the code needs no number word.)

**The values** (the ledger copies', as stored; the build writes them by the script; checked by this writer with python):

| slot | summary.json | `15min` (USD/JPY, AUD/USD mails) | `1h` (EUR/JPY, AUD/JPY, EUR/USD mails) |
|---|---|---|---|
| 〔from〕, 〔to〕 | `meta.start`, `meta.end` | ja 「2024年1月1日 0:00（UTC）」, 「2026年11月10日 21:00（UTC）」; en "1 January 2024, 00:00 UTC", "10 November 2026, 21:00 UTC" | the same |
| the bar's word | `meta.tf` | 「15分足」 / "15-minute" | 「1時間足」 / "1-hour" |
| 〔trades〕, 〔tp〕, 〔open〕 | `dirs.fade.all.trades`, `.tp`, `.open` | 6,006 / 5,926 / 80 | 1,490 / 1,468 / 22 |
| 〔mean〕 | `dirs.fade.all.pipsMean` | +2.41 (2.410173160173158) | +3.26 (3.261140939597316) |
| 〔maeMedian〕, 〔maeMax〕 | `.maeMedian`, `.maeMax` | 11.9, 2,975.8 | 10.7, 2,243.6 |
| 〔tpMedian〕, 〔tpP90〕, 〔tpMax〕 | `.tpMinutesMedian`, `.tpMinutesP90`, `.tpMinutesMax` | 143, 5,681, 784,561 minutes: ja 「約2時間」「約4日」「約545日」, en "about 2 hours", "about 4 days", "about 545 days" | 140, 4,489, 687,037 minutes: ja 「約2時間」「約3日」「約477日」, en "about 2 hours", "about 3 days", "about 477 days" |
| 〔openPipsSum〕, 〔openPipsWorst〕, 〔openLongest〕 | `.openPipsSum`, `.openPipsWorst`, `.openMinutesMax` | −44,784.5, −1,913.4, 959,205 minutes: ja 「約666日」, en "about 666 days" | −9,820.9, −1,733.2, 888,900 minutes: ja 「約617日」, en "about 617 days" |
| 〔flowMean〕 | `dirs.flow.all.pipsMean` | +3.19 | −2.08 |
| 〔baseMean〕 | `base.all.pipsMean` | +3.32 (704,630 trades) | +3.21 (175,050 trades; v40 showed +3.20) |
| 〔pairMean〕 (〔pairBaseMean〕) | `dirs.fade.<pair>.pipsMean`, `base.<pair>.pipsMean` | USD/JPY +2.67 (+5.69), EUR/JPY +1.29 (+3.41), AUD/JPY −0.82 (−0.30), EUR/USD +3.86 (+2.60), AUD/USD +4.94 (+5.18) | USD/JPY −0.26 (+5.74), EUR/JPY +4.30 (+3.28), AUD/JPY +4.44 (−0.75), EUR/USD +3.11 (+2.61), AUD/USD +4.42 (+5.16) |
| the pair sentence a mail carries | its own pair's row | USD/JPY, AUD/USD | EUR/JPY, AUD/JPY, EUR/USD |
| 〔negPairs〕 | as the 1-hour spec | ja 「豪ドル/円（-0.82 pips）」, en "AUD/JPY (-0.82 pips)" | ja 「ドル/円（-0.26 pips）」, en "USD/JPY (-0.26 pips)" |
| 〔notMailed〕 | the sum of `pairs[].notMailed` | 3 (USD/JPY, AUD/JPY and AUD/USD one each) | 11 (2, 0, 2, 3, 4) |
| 〔sec〕 | the docs §8 section of the release | 8.156 (the next after §8.155, OPERATIONS.md:12975; if another takes it first, the next free one, written at the release) | the same section: §8.155 records run 44099401423, not this run, so the 1-hour mails no longer say 8.155 |
| 〔gapBase〕, 〔gapFlow〕 | `fade.pipsMean − baseMean`, `fade.pipsMean − flowMean`, unrounded, then to 2 decimals with the sign | −0.91 (−0.906247088751817), −0.78 (−0.7833999333999344), written in its sentence | +0.05 (0.05417607241652034), +5.34 (5.342080536912752), not written (the "both inside" sentence has no number) |
| 〔baseLo〕〜〔baseHi〕, 〔flowLo〕〜〔flowHi〕 | not in summary.json: the walks' ranges as printed, held in `FADE_MEASURED[tf].chance` | −0.80〜+2.24, −2.25〜+5.70 (null.json `a0d39045…`, research/macdfade15-spec.md :477-478, :497-499) | −4.10〜+0.83, −5.42〜+5.81 (null.json `3d285440…`, :536, :548-549; the generator's walks, as v40's run's), not written |
| 〔chance〕 | — | the "base below, flow inside" sentence (below) | the "both inside" sentence (research/macdfade1h-prod-spec.md 4.5; v40's, HEAD :233-234) |

Durations, signs, thousands separators and the minus as research/macdfade1h-prod-spec.md 4.5 (the code's rules, HEAD
macd-fade-measured.ts:181-217). The table's "−" is this file's typography; the code writes "-".

**Read against the numbers.**
- `15min` (run 44535888012): the fade's mean (+2.41) is below the no-signal baseline (+3.32) and below entering the other
  way (+3.19). Fade − base is −0.91 pips a trade, below the ten driftless walks' range (−0.80..+2.24); fade − flow is
  −0.78, inside its range (−2.25..+5.70). With `END` a week earlier the order is the same (fade +1.96, flow +2.73, base
  +2.98). Four of the five pairs' fade means are below their baselines (only EUR/USD's is above). By side, bottom (BUY)
  2,956 trades +6.29 a trade, top (SELL) 3,050 trades −1.35 a trade. So no sentence says the fade did better than no
  signal or than the other way, and 〔chance〕 says it did worse than no signal.
- `1h` (run 44555599946): the fade's mean (+3.26) is about the same as no signal (+3.21; fade − base +0.05, inside
  −4.10..+0.83) and above the other way (−2.08; fade − flow +5.34, inside −5.42..+5.81). With `END` a week earlier: fade
  +3.02, flow −3.10, base +2.86. So no sentence says the fade did better than no signal; 〔chance〕 says both gaps are
  within what chance gives (research/macdfade15-spec.md :548-554).
- The pairs mailed on each chart: USD/JPY +2.67 (no signal +5.69) and AUD/USD +4.94 (+5.18) on `15min`, both below their
  own no-signal; EUR/JPY +4.30 (+3.28), AUD/JPY +4.44 (−0.75) and EUR/USD +3.11 (+2.61) on `1h`, all above theirs. They
  were picked after looking (section 1, CLAUDE.md), and AUD/JPY's gap of +5.19 is one of the gaps outside the walks'
  range that chance gives about 2 times in 11 (:550-552); no text presents these as a finding. Each mail states only
  its own pair's sentence, as the study printed it, and right after it **the per-pair chance sentence** (added at the
  fifth review: 〔chance〕 speaks of the five-pair gaps only, HEAD macd-fade-measured.ts:232-246, and comes right before
  the pair's sentence, :314-315, :337-338, so the pair's own gap, AUD/JPY's +5.19 among them, stood with no chance
  wording). It gives no reason for the pair's chart (4.1). ja 「ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。」
  en "Each pair's difference from no signal has not been shown to be larger than chance gives (chance alone puts a gap outside the range of ten made-up price walks with no trend about 2 times in 11)."
  The same sentence follows the notes' pairs sentence (notes [7] and [8]), on both charts.
- Mail count: about 40 entries a week over the five pairs on 15-minute bars (6,006 in 2 years and 10 months) against
  about 10 on 1-hour bars (1,490). Per pair on its chart (the study's counts): USD/JPY 1,217 and AUD/USD 1,224 on
  15-minute bars, EUR/JPY 300, AUD/JPY 288 and EUR/USD 316 on 1-hour bars. Under v41 (each pair on its chart): about
  3,345 entries in the period (1,217 + 1,224 + 300 + 288 + 316), about 22 a week (over about 149.3 weeks), against v40's
  1,490, about 10. These are the study's counts summed, not a new measurement.

- 〔baseWhat〕 (from `m.tf`): `15min` 「5ペアの15分足ごとの最初の1分に（週末の止まっている時間に確定した足を除く。買いと売りを1回ずつ）」
  / "at the first minute of every 15-minute bar of the five pairs (bars that closed in the weekend pause left out; a BUY
  and a SELL)"; `1h` the same with 「1時間足」 / "1-hour". The study's baseline takes every bar of the five pairs on its
  chart that is in range, has 600 bars and does not close in the weekend gate, signal or not (research/macdfade15-spec.md
  "The same trade with no signal" :178-183), at the bar's first minute, so the same holding with no signal, not the same
  entry; the parenthesis after 〔baseMean〕 says so. (v40's 「このメールが判定する1時間足ごとの」 / "every 1-hour bar this
  email judges" was true when every pair was mailed on one chart; now three of the 15-minute baseline's five pairs, and
  two of the 1-hour one's, are not judged on that chart by any mail.)
- The 〔open〕 = 0, 〔tp〕 = 0 and 〔trades〕 = 0 variants: as research/macdfade1h-prod-spec.md 4.5, word for word.

ja, `15min` (〔mailedOn〕 its `15min` sentence): 「測った数字（5ペア、〔from〕以後、〔to〕より前に確定した15分足、スプレッド込み、docs §〔sec〕）。〔mailedOn〕過去の GMO の足を読み直して測ったもので、メールの読み込みが失敗した時などは入っていません（その回数は測っていません）。このメールの決まりで足の終値で入り、+10 pips で利確・損切りなしで持ったとして測りました（オーナーの持ち方です。メールには利確の値段を書いていません）: 合図は〔trades〕回、うち〔tp〕回が+10 pips に届きました。〔open〕回は〔to〕の時点でまだ届いておらず、その含み損益は合わせて〔openPipsSum〕 pips（マイナスが損）、いちばん悪いもので〔openPipsWorst〕 pips、いちばん長いもので〔openLongest〕持ったままでした（その後は追っていません）。1回あたり平均〔mean〕 pips（届いていないものは、その時の含み損益で数えました）。途中の含み損は中央値〔maeMedian〕 pips、最大〔maeMax〕 pips。+10 pips に届くまでの時間は中央値〔tpMedian〕、10回に1回は〔tpP90〕より長く、いちばん長いもので〔tpMax〕でした。足の終値で入るので指値ではなく、入らなかった注文はありません（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）。損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。同じ合図で逆向き（上で買い・下で売り）に入ると1回あたり〔flowMean〕 pips、合図なしで〔baseWhat〕入ると〔baseMean〕 pips でした（合図なしは、同じ持ち方〈+10 pips で利確・損切りなし〉ですが、足の終値ではなく15分足の最初の1分に入ったもので、同じ入りではありません）。〔chance〕〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。ペアごとの合図なしとの差は、偶然で出る差より大きいとは示せていません（値動きに傾きのない作り物の値段10本の幅の外には、偶然だけでも11回に約2回は出ます）。平均がマイナスだったペア: 〔negPairs〕。ほかに〔notMailed〕回、週末の止まっている時間に確定した足に合図がありましたが、その足はどのペアのメールでも判定しないので、上の数字に入れていません。」

en, `15min`: "Measured (five pairs, 15-minute bars that closed from 〔from〕 up to, not including, 〔to〕, spread paid, docs §〔sec〕). 〔mailedOn〕 The measurement re-reads GMO's past bars; times this email's reads failed and the like are not in it (how often: not measured). Entered by this email's rule at the bar's close and held with a take profit of +10 pips and no stop (the owner's way of holding; this email states no take-profit price): 〔trades〕 signals, of which 〔tp〕 reached +10 pips. 〔open〕 had not reached it by 〔to〕; their unrealised result was 〔openPipsSum〕 pips in all (a minus is a loss), the worst 〔openPipsWorst〕 pips, the longest held 〔openLongest〕 (not followed after that). The mean was 〔mean〕 pips a trade (those not reached counted at their unrealised result then). The largest loss on the way: median 〔maeMedian〕 pips, largest 〔maeMax〕 pips. Time to +10 pips: median 〔tpMedian〕, longer than 〔tpP90〕 one time in ten, longest 〔tpMax〕. The entry is at the bar's close, not a limit order, so no order went unfilled (every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe). With no stop, the share reaching +10 pips comes out high by construction. Entering the other way on the same signals (a BUY at the top, a SELL at the bottom) gave 〔flowMean〕 pips a trade, and entering with no signal 〔baseWhat〕 gave 〔baseMean〕 pips (held the same way, +10 pips and no stop, but entered at the 15-minute bar's first minute, not at its close, so not the same entry). 〔chance〕 On 〔pair〕 alone the mean was 〔pairMean〕 pips (with no signal, 〔pairBaseMean〕 pips). Each pair's difference from no signal has not been shown to be larger than chance gives (chance alone puts a gap outside the range of ten made-up price walks with no trend about 2 times in 11). Pairs whose mean was below zero: 〔negPairs〕. Besides these, 〔notMailed〕 signals fell on bars that closed in the weekend pause; no pair's email judges those bars, so they are not in the numbers above."

`1h`: the same two texts with 「確定した15分足」 → 「確定した1時間足」, 「15分足の最初の1分」 → 「1時間足の最初の1分」; "15-minute bars that
closed" → "1-hour bars that closed", "the 15-minute bar's first minute" → "the 1-hour bar's first minute"; 〔mailedOn〕
its `1h` sentence. In both, the parts are joined as the code joins them today (ja with no space, en with one space,
HEAD :262-342).

**Not v40's text word for word any more** (corrected at the review). Against research/macdfade1h-prod-spec.md 4.5 (v40's
mail, written when all five pairs were mailed on one chart), the `1h` text has 〔mailedOn〕 added and three phrases
rewritten, because the five-pair totals now hold signals and bars of pairs whose mails are judged on the other chart (the
15-minute fade total 6,006 holds EUR/JPY's, AUD/JPY's and EUR/USD's 1,180 + 1,184 + 1,201 = 3,565 trades, its baseline
704,630 holds their 3 × 140,926 = 422,778; the 1-hour fade total 1,490 holds USD/JPY's and AUD/USD's 274 + 312 = 586,
its baseline 175,050 holds 2 × 35,010 = 70,020; the ledger copies, python, at the review):
- the entry's parenthesis: v40's 「（メールした合図はすべて入ったとして数えました）」 / "(every signal emailed is counted as
  entered)" → 「（週末の止まっている時間に確定した足のもの〈下〉を除き、この決まりの合図は、そのペアのメールをこの時間足で判定するかどうかに関わらず、すべて入ったとして数えました）」 /
  "(every signal of this rule, but those on bars that closed in the weekend pause (below), is counted as entered, whether or not that pair's email is judged on this timeframe)"
  (corrected at the second review: the first rewrite said every signal of the rule was counted, while the same
  paragraph's last sentence leaves out the 〔notMailed〕 signals of the weekend pause, 3 on the 15-minute run and 11 on
  the 1-hour run; v40's "every signal emailed" had left them out by its own words; the weekend sentence is always
  written, HEAD macd-fade-measured.ts:317 / :340, so 〈下〉 / "(below)" always has its sentence);
- 〔baseWhat〕: v40's 「このメールが判定する1時間足ごとの最初の1分に（買いと売りを1回ずつ）」 → as above;
- the weekend sentence: v40's 「…このメールでは判定しないので、上の数字に入れていません。」 / "this email does not judge those
  bars" → 「…その足はどのペアのメールでも判定しないので、上の数字に入れていません。」 / "no pair's email judges those bars"
  (the weekend gate is the same on both charts, 2.4).
The `15min` text has the same three. Both also have the per-pair chance sentence after the 〔pair〕 sentence (above;
added at the fifth review), in the mail and the notes versions. Tests pin the new wording word for word (7.1). And in en only, the sentence after
〔mailedOn〕: v40's "It re-reads GMO's past bars; …" (HEAD macd-fade-measured.ts:326, right after the "Measured (…)"
sentence its "It" meant) → "The measurement re-reads GMO's past bars; …", in both charts' mail and notes versions
(corrected at the third review: with 〔mailedOn〕 between them, "It" would read as the emails or the paragraph; ja has no
subject there, 「過去の GMO の足を読み直して測ったもので」, HEAD :301, and is unchanged).

**The notes' version:** research/macdfade1h-prod-spec.md 4.5 "The notes' version" applied to the texts above, one
paragraph per chart. With the three phrases rewritten, its changes are now: ja 「このメールの決まりで」 → 「メールの決まりで」;
en "times this email's reads failed" → "times the email's reads failed", "Entered by this email's rule" → "Entered by the
email's rule", "this email states no take-profit price" → "the email states no take-profit price"; the 〔pair〕 sentence
becomes all five pairs' means of that chart's run, as that item writes it, and the per-pair chance sentence follows it
unchanged. Its other items (「このメールでは判定しないので」 /
"this email does not judge those bars" and 〔baseWhat〕's 「このメールが判定する」 / "this email judges") have nothing left
to change: the rewritten phrases hold no 「このメール」 / "this email". 〔mailedOn〕 is in both versions as written (it says
「メール」 / "the email", not 「このメール」). A test pins each word for word.

**〔chance〕, `15min`: fade − base below the walks' range, fade − flow inside it.** Today `chanceOf` (HEAD
macd-fade-measured.ts:237-246) writes only the "both inside" sentence and throws on any other case; with the 15-minute
numbers it would throw while the module loads (HEAD :353-356). So it gets this branch, word for word, with the slots of
the table. The "both inside" sentence stays as research/macdfade1h-prod-spec.md 4.5 writes it, and is the `1h` run's. The
case is chosen from the unrounded gaps against the ranges held in `FADE_MEASURED[tf].chance` (fade − base below `lo`,
fade − flow within `[lo, hi]`).

The sentence, ja 「合図なしとの差（この決まり − 合図なし）は1回あたり〔gapBase〕 pips で、合図なしで入った時より低くありました。値動きに傾きのない作り物の値段10本で同じように測った差は〔baseLo〕〜〔baseHi〕 pips で、この差はその幅より下（合図なしより悪い側）でした。逆向きとの差は〔gapFlow〕 pips で、10本の幅（〔flowLo〕〜〔flowHi〕 pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。」 en "The difference from no signal (this rule less no signal) was 〔gapBase〕 pips a trade: lower than entering with no signal. The same difference measured on ten made-up price walks with no trend ranged from 〔baseLo〕 to 〔baseHi〕 pips, and this one was below that range (on the side of doing worse than no signal). The difference from the other way was 〔gapFlow〕 pips, within the walks' range (〔flowLo〕 to 〔flowHi〕 pips; a range chance alone gives, so it is not shown to do better or worse than the other way). Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's)."

Filled with the 15-minute numbers, ja 「合図なしとの差（この決まり − 合図なし）は1回あたり-0.91 pips で、合図なしで入った時より低くありました。値動きに傾きのない作り物の値段10本で同じように測った差は-0.80〜+2.24 pips で、この差はその幅より下（合図なしより悪い側）でした。逆向きとの差は-0.78 pips で、10本の幅（-2.25〜+5.70 pips）の中でした（偶然で出る幅の中なので、逆向きより良いとも悪いとも言えません）。10本の幅の外には偶然だけでも11回に約2回は出るので、幅の外に出たことも確かめ〈検定〉ではありません（作り物の値段は GMO のものではありません）。」 en "The difference from no signal (this rule less no signal) was -0.91 pips a trade: lower than entering with no signal. The same difference measured on ten made-up price walks with no trend ranged from -0.80 to +2.24 pips, and this one was below that range (on the side of doing worse than no signal). The difference from the other way was -0.78 pips, within the walks' range (-2.25 to +5.70 pips; a range chance alone gives, so it is not shown to do better or worse than the other way). Chance alone puts a gap outside ten walks' range about 2 times in 11, so being outside it is not a test either (the walks' prices are not GMO's)."

(The gaps written are the unrounded differences to 2 decimals, which is how the study's print writes them; a test pins
them to −0.91 and −0.78, and the 1-hour run's unwritten gaps to +0.05 and +5.34. The walks' ranges are held as printed.
The sentence holds 「−」 as a word, 「この決まり − 合図なし」, not as a number's sign.)

## 5. The screen and the sales page

- **The grid: today's app cannot show two pairs on 15分 and four on 1時間, so it changes (src/).** The app's `macdx` block
  is `{ pairs; intervals }` (src/lib/signalAlerts.ts:160); the parse keeps only those two fields (:293), so any per-pair
  field the server adds is dropped; the offer is a cross product, `ind.macdx.pairs.includes(pair) &&
  ind.macdx.intervals.includes(interval)` (:316; the `limited` check at :321-323 is reached only by the rules of the base
  block). The grid (src/components/SignalAlertSettings.tsx) draws a column per `ind.intervals` (:234-236) and a row per
  `ind.pairs` (:268), a box where `indicatorChartOffered` is true and "—" with the title `a.indicatorHourOnly` where it
  is not (:276-281); the all-symbols row ticks the offered pairs of a column (`offered(iv)`, :228, :241-266). So with
  `intervals` `["15min", "1h"]` and no per-pair limit, today's app would draw 12 boxes; `set` refuses the 6 not offered
  and `set_many` refuses a whole column (3.2 item 6): 「保存できませんでした」 (the toast, :77, :89), nothing saved. Read from
  the code; the app was not run.
- **The change** (one PR, src/ only, published before the function, 6.3 step 2). **Cut from main** (9ca2054 or later),
  not from this branch: it carries none of 001a3df's build, in particular not its src/lib/i18n texts (every pair on 15
  minutes), so what it publishes is v40's texts plus this change. The function's branch takes main after it.
  - src/lib/signalAlerts.ts: `macdx: { pairs: string[]; intervals: string[]; limited: Record<string, string[]> } | null`
    (:160); the parse reads `rec(ind.macdx).limited` the way the base block's is read (:279-281); the offer (:316)
    `… && (!only || only.includes(interval))` with `only = ind.macdx.limited[pair]`. With no `limited` (v40, or any server
    before the per-pair v41) the app behaves exactly as today, which is why it can go first.
  - The "—" cell of the fade's grid gets a title of its own: a new key `alerts.macdxOtherChart`, ja 「このペアは、この時間足では
    判定しません（ペアごとに、オーナーが選んだ1つの時間足だけで判定します）」, en "Not judged on this timeframe for this pair
    (each pair is judged on the one timeframe the owner chose only)"; SignalAlertSettings.tsx:278 uses it when `rule ===
    "macdx"` and `indicatorHourOnly` otherwise (that text, ja:2200 / en:2095, speaks of symbols GMO Coin does not carry
    and would be wrong here). Both dictionaries get the key (src/test/i18n.test.ts: the same keys).
  - Then, once v41 answers: two columns, 15分 and 1時間; USD/JPY and AUD/USD a box under 15分 and "—" under 1時間;
    EUR/JPY, AUD/JPY, EUR/USD and gold "—" under 15分 and a box under 1時間; the 15分 all-symbols box covers the two, the
    1時間 box the four. No other grid code changes. The `stockmacd` grid is unchanged (one 15分 column).
  - Between the function's deploy and a published app, an old bundle draws the 12 boxes and refuses the 6 not offered:
    confusing, nothing saved wrongly. Lovable's state is reported as given (CLAUDE.md); whether it is live is not checked.
- **Id parse, tag, plan line:** no change (3.5). `FADE_ID = /^(?:macdx|stockmacd)_.*_fade(\d+)(?:tp[0-9a-z]+)?of120_in_/`
  (src/lib/signalAlerts.ts:70) reads both `macdx` ids and the `stockmacd` id; `RIDE_ID` (:48) and `ruleOfId` (:33-37)
  as today. A row's timeframe reads 「15分」 / 「1時間」 from its `interval`.
- **Notes and intros** (ja and en, the same keys and array lengths, src/test/i18n.test.ts:35-39). Only what names the
  fade's chart, its reads or its numbers changes; everything else stays word for word. The texts quoted "v40's" are at
  9ca2054 (src/lib/i18n is the same there as at 001a3df^); "HEAD" ones are the build's.
  - Card intro (`alerts.intro`, HEAD ja:2089-2090 / en:1986-1987): only its parenthesis changes; the lead stays
    「足が確定した後の読み込みで判定して送ります」 / "It is judged and sent at a read after the bar closes" (no arrival time).
    The whole text (`${email}` as the test passes it), ja:
    「チェックしたチャートで、下で選んだ種類（RSI＋SAR・GA型・Q-Trend・ULTRA・MACD の逆張り・流動性狩り＋EMAクロス）の買い（BUY）・売り（SELL）のサインが出たら、${email} にメールでお知らせします。足が確定した後の読み込みで判定して送ります（MACD の逆張りは、ドル/円・豪ドル/ドルは15分足の確定の直後・1分後・3分後の読み込みで、ユーロ/円・豪ドル/円・ユーロ/ドルは1時間足の確定の直後・3分後・5分後の読み込みで、金は1時間足の確定の1分後から30分後までの間に判定して送ります。実際に何分で届くかは測っていません）。」
    en: "When the kind chosen below (RSI + SAR, GA style, Q-Trend, ULTRA, MACD fade or Liquidity sweep + EMA cross) fires a BUY or SELL on a chart you tick, we email ${email}. It is judged and sent at a read after the bar closes (the MACD fade is judged and sent on USD/JPY and AUD/USD at the reads right after the 15-minute close and 1 and 3 minutes after, on EUR/JPY, AUD/JPY and EUR/USD at the reads right after the 1-hour close and 3 and 5 minutes after, and on gold between 1 and 30 minutes after the 1-hour close; how long it takes to arrive has not been measured)."
  - `indicatorIntro.macdx` (HEAD ja:2118 / en:2013), these sentences change, the rest stays:
    - ja 「15分足の MACD(12・26・9)の青い線を使った、逆張りのサインです。15分足が確定した時に、」 → 「MACD(12・26・9)の青い線を
      使った、逆張りのサインです。足が確定した時に、」; en "A fade signal from the 15-minute chart's MACD(12, 26, 9) blue line.
      When a 15-minute bar closes with" → "A fade signal from the MACD(12, 26, 9) blue line. When a bar closes with".
    - ja 「ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金（XAU/USD）の15分足だけです。」 → 「ドル/円・豪ドル/ドルの
      15分足と、ユーロ/円・豪ドル/円・ユーロ/ドルと金（XAU/USD）の1時間足だけです（時間足は、ペアごとにオーナーが選びました）。」;
      en "15-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold (XAU/USD) only." → "15-minute bars of
      USD/JPY and AUD/USD and 1-hour bars of EUR/JPY, AUD/JPY, EUR/USD and gold (XAU/USD) only (the owner chose each
      pair's timeframe)."
    - ja 「96%・足の確定で判定すること・メールを15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き・
      利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。」 →
      「96%・足の確定で判定すること・ペアごとの時間足・15分足の MACD の枠を新しい120本にすること・逆張りの向き・利確と損切りの
      値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリのその時間足のチャートの枠と同じ
      です。」; en "96%, judging at the bar's close, judging the email on 15-minute bars, the MACD pane of the newest 120
      15-minute bars, the fade side and stating no take-profit or stop price are the app owner's choices. That pane is the
      same as the app's 15-minute chart's." → "96%, judging at the bar's close, each pair's timeframe, the 15-minute MACD
      pane of the newest 120 bars, the fade side and stating no take-profit or stop price are the app owner's choices. The
      MACD pane (the newest 120 bars) is the same as the app's chart's on that timeframe."
    - ja 「5ペアで測った数字は下の注に、金では測っていません。」 → 「5ペアを15分足と1時間足で測った数字は下の注に、金では
      測っていません。」; en "Measured on the five pairs (see the notes below); not measured on gold." → "Measured on the five
      pairs on 15-minute and on 1-hour bars (see the notes below); not measured on gold."
    - So 「15分足」 is in the ja text 3 times and "15-minute" in the en text 3 times (the pins at
      src/test/signal-alert-settings.test.tsx:1254 and :1255 say 6 today).
  - **The shares' texts: as a964994's version of this file (the first version as revised), copied here word for
    word**, but for [3]'s 「株も」 / "too", dropped at the third review (4.4 item 10); HEAD (001a3df) already holds them
    (its [3] with the 「も」). Their line numbers are 9ca2054's (v40's), as that version wrote them; on
    HEAD `stockmacdNotes` is ja:2190-2198 / en:2085-2093 and the stock data note ja:954 / en:902.
  - `indicatorIntro.stockmacd` (ja:2127 / en:2022): 「1時間足」 / "1-hour" → 「15分足」 / "15-minute" (twice).
  - `stockmacdNotes` (ja:2189-2197 / en:2084-2092):
    - [0] (ja:2190 / en:2085) 「の1時間足だけで判定します」 → 「の15分足だけで判定します」; en "Judged on the 1-hour chart
      of 8 US stocks" → "Judged on the 15-minute chart of 8 US stocks". Nothing else changes.
    - [1] (ja:2191 / en:2086) 「見るのは1時間足の確定ごとです」 → 「見るのは15分足の確定ごとです」; en "The rule is the currency
      pairs' MACD fade, looked at at each 1-hour close." → "The rule is the same as the currency pairs' MACD fade; a stock
      is looked at at each 15-minute close." Nothing else changes. (Corrected at the fourth review: this changed only
      "1-hour" to "15-minute", as HEAD en.ts:2087 holds, which reads as the currency pairs' fade looked at on 15-minute
      closes, untrue for EUR/JPY, AUD/JPY, EUR/USD and gold; the ja, 「…と同じで、見るのは…」, gives the shares' closes in a
      clause of its own. Its word-for-word pin, HEAD src/test/signal-alert-settings.test.tsx:1055, changes with it.)
    - [2] (ja:2192 / en:2087) the closes (fitted to the probe, 3.3), the Tokyo sentence as 4.4 item 8, the US sentence,
      and 〔closing〕, which is **empty**, ja and en: the first version's 〔closing〕 (ja 「（取引時間の最後の足は、引けの値段が
      出てから判定します）」, en " (the session's last bar once the closing price is out)") is not written, since the
      closing-price condition of 3.3 item 6 cannot hold at Tokyo's 11:15 bar (decided at the second review; HEAD ja:2193 /
      en:2088 already hold no 〔closing〕). After the 45-minute sentence, the sentence on Tokyo's 11:30 bar (added at the
      fourth review: the closes listed leave out that bar, which the chart draws and the 600-bar window holds but no read
      mails, 2.4 "Never judged"; counted from the code, the lunch-time answer not yet seen). It sits inside the quote, so
      the regex of 3.5 still takes the whole item, and after the two sentences HEAD src/test/stockmacd-alerts.test.tsx
      :403-404 pins together; the literal pins HEAD src/test/signal-alert-settings.test.tsx:1029-1030 and :1062-1063
      change with it. ja (the slot left in the text, empty):
      「足と値段は Yahoo Finance の公開データで、チャートの株の足と同じです（公式の配信ではないため、止まることがあります）。足が確定してから送ります。米国株はニューヨークの 9:45〜16:00 の15分ごと、日本株は 9:15〜11:30 と 12:45〜15:30 の15分ごとに足が確定し、Yahoo の最後の約定の時刻がそれを過ぎたら判定します〔closing〕。確定から45分を過ぎた足は送りません。日本株の前場の引け（11:30）の値段は、Yahoo では1本の足（11:30〜11:45）になり、チャートと MACD の600本に入りますが、その足ではメールを送りません。その足を判定できるのは 12:45 からの午後の読み込みで、確定から45分を過ぎているためです（コードから数えたもので、昼休みの間の Yahoo の答えは、まだ見ていません）。東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、日本株のメールは足が確定してから15分ほど後に判定して送ります（15分足で実際に何分後になるかは、まだ測っていません）。米国株は、1時間足の時に、確定の数秒後に送っていました（2026-11-05 の2通。15分足では、まだ見ていません）。受信箱に届くまでの時間は確かめていません。」
      en: "The bars and the price are Yahoo Finance's public data, the same as the app's stock chart (not an official feed; it may stop). Mailed once the bar has closed: US bars close every 15 minutes from 9:45 to 16:00 New York time, Japanese ones every 15 minutes from 9:15 to 11:30 and from 12:45 to 15:30 Tokyo time; a bar is judged once Yahoo's last trade is past its close〔closing〕. A bar that closed more than 45 minutes ago is not mailed. Tokyo's morning closing price (11:30) is a bar of its own on Yahoo (11:30 to 11:45); it is in the chart and in the MACD's 600 bars, but no email is sent on that bar. It can be judged only at the afternoon's reads, from 12:45, more than 45 minutes after it closed (counted from the code; Yahoo's answer during the lunch break has not been seen yet). Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so Japanese stocks' emails are judged and sent some 15 minutes after the bar closed (how many minutes on 15-minute bars has not been measured yet); US stocks' were sent a few seconds after the close on 1-hour bars (the two on 2026-11-05; not yet seen on 15-minute bars). How long they take to reach the inbox has not been checked."
    - [3] (ja:2193 / en:2088) the owner's sentence as 4.4 item 10; the sentence before it and the one after it stay. ja:
      「利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・株を15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。取引時間の最後の足の終値は、次の取引時間の始まりまで売買できないことがあります（測っていません）。」
      en: "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop. This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging shares on 15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's. The close of a session's last bar may not be tradable until the next session opens (not measured)."
    - [5] (ja:2195) 「米国の取引が早く終わる日は、最後の足を、終わってから30分後に判定します。」 → 「米国の取引が早く終わる日
      は、最後の足（終わりの15分）も、ほかの足と同じく確定の後の読み込みで判定します（本物の早く終わる日では、まだ見ていま
      せん）。」 / "On a US half day the last bar (the last 15 minutes) is judged at a read after its close like any other
      (not yet seen on a real half day)." (`CLOSES` holds 13:00, 3.3.)
    - The others ([4], [6]) stay word for word.
  - The stock data note (ja:954 / en:902): 「（決まった22銘柄の1時間足だけ）」 / "(the 22 listed stocks' 1-hour charts only)"
    → 15分足 / 15-minute.
  - `chart.macd.note` (HEAD ja:557 / en:514): names no timeframe; its last sentence, ja:
    「メール通知の「MACD の逆張り」と「株の MACD」だけが、この MACD（12・26・9）を使います。」 Unchanged. (The rewrite before this
    review sent it to "the first version", which does not name it.)
  - `macdxNotes` (HEAD ja:2140-2154 / en:2035-2049): **13 items become 14** (the 1-hour paragraph is added after the
    15-minute one), item by item:
    - [0] the charts and the reads, ja:
      「ドル/円・豪ドル/ドルは15分足だけで、ユーロ/円・豪ドル/円・ユーロ/ドルと金は1時間足だけで判定します（オーナーが選んだ5ペアと、あとから足した金。どの時間足で判定するかも、ペアごとにオーナーが選びました）。足が確定した後、ドル/円・豪ドル/ドルは確定の直後・1分後・3分後（毎時0分・15分・30分・45分と、その1分後・3分後）の読み込みで、ユーロ/円・豪ドル/円・ユーロ/ドルは確定の直後・3分後・5分後（毎時0分・3分・5分）の読み込みで、金は確定の1分後から30分後までの間に判定して送ります（実際に何分で届くかは測っていません）。届いた時の値段は、メールに書いた値段と違うことがあります（その差は測っていません）。ドル/円・豪ドル/ドルは、2026年11月18日から〔switch〕（UTC）まで、メールを1時間足で判定していました。」
      en: "Judged on the 15-minute chart only for USD/JPY and AUD/USD, and on the 1-hour chart only for EUR/JPY, AUD/JPY, EUR/USD and gold (the five pairs the owner chose, and gold added since; the owner also chose each pair's timeframe). After the bar closes it is judged and sent: USD/JPY and AUD/USD at the reads right after the close and 1 and 3 minutes after (0, 15, 30 and 45 minutes past each hour, and 1 and 3 minutes after those), EUR/JPY, AUD/JPY and EUR/USD at the reads right after the close and 3 and 5 minutes after (0, 3 and 5 minutes past each hour), gold between 1 and 30 minutes after the close (how long it takes to arrive has not been measured). The price when it arrives may differ from the price in the email (the difference has not been measured). USD/JPY and AUD/USD were judged on 1-hour bars from 18 November 2026 to 〔switch〕 UTC."
      (〔switch〕 the UTC date of v41's first answer, ja 「2026年11月D日」 (「（UTC）」 follows it in the text), en "D
      November 2026" (" UTC" follows it), e.g. 「2026年11月24日」 / "24 November 2026". It is written in step 4's PR,
      as `FUNCTION_VERSION`'s date is (3.7): the merge goes at about H:07 to H:09 UTC with H from 08 to 14 (6.2), so v41's
      first answer falls on the merge's UTC date; if the release moves to another day, both dates change before the
      merge, and if v41 first answers on another UTC date than the merge's, a src/-only PR corrects 〔switch〕 (and its
      pins) before step 7's publish. The tests that read this file put that date in place of 〔switch〕 in its text, as
      they put nothing in place of 〔closing〕. (Corrected at the third review: this first said "the time of v41's first
      answer, written at the release", with no format; that time is known only after step 4's merge, step 7 publishes
      main as step 4 merged it, with no PR and no test change, and no step wrote it, so the published note would have
      shown the mark itself.) Before 2026-11-18 the fade was not mailed, so the sentence starts there; EUR/JPY, AUD/JPY,
      EUR/USD and gold have no switch.)
    - [1] gold's reads: v40's text word for word (9ca2054 ja.ts:2141 / en.ts:2036: re-read 「確定から30分まで」 / "until
      half an hour after the close"). HEAD's 15-minute wording goes.
    - [2] gold: v40's text word for word (9ca2054 ja.ts:2142 / en.ts:2037: 「金の1時間足を、本番で確定の何秒後に送るかも、まだ
      見ていません。」 / "… gold's 1-hour alert …"). Whether a v40 gold mail has been looked at in production since
      2026-11-18 was not checked here; if one has, the sentence is rewritten to say what was seen (this file corrected
      first).
    - [3] to [6]: unchanged.
    - [7] the 15-minute run's notes paragraph (4.5, with its 〔mailedOn〕).
    - [8] **new**: the 1-hour run's notes paragraph (4.5, with its 〔mailedOn〕). It replaces nothing: HEAD's [7] holds v40's
      1-hour paragraph with run 44099401423's +3.20 (ja:2148), which goes.
    - [9] (HEAD [8]) gold not measured, ja 「金では測っていません（足は Twelve Data のもので、売値・買値の別はありません）。上の
      2つの数字（15分足と1時間足）は5ペアのもので、金には当てはまりません。」 en "Not measured on gold (its bars are Twelve
      Data's, with no separate bid and ask). The numbers above (on 15-minute and on 1-hour bars) are the five pairs' and do
      not apply to gold."
    - [10] (HEAD [9]) unchanged.
    - [11] (HEAD [10]) the owner's sentence, ja:
      「利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・ペアごとの時間足（ドル/円・豪ドル/ドルは15分足、ユーロ/円・豪ドル/円・ユーロ/ドルと金は1時間足）・15分足の MACD の枠を新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリのその時間足のチャートの枠と同じです。通知は注文の指示ではありません。届いたサインの成績（+10 pips に届いたかどうかも）は、記録も表示もしていません。」
      en: "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop. This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, each pair's timeframe (15-minute bars for USD/JPY and AUD/USD, 1-hour bars for EUR/JPY, AUD/JPY, EUR/USD and gold), the 15-minute MACD pane of the newest 120 bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the newest 120 bars) is the same as the app's chart's on that timeframe. An alert is not an instruction to trade. The alerts' results (whether one reached +10 pips included) are not recorded or shown."
    - [12] (HEAD [11]) the weekend's bars, as recounted at the fifth review (2.4 "Never judged": on GMO's bars the week's
      last bar in both seasons; the winter counts this item gave before, five 15-minute bars and two 1-hour bars, as
      v40's live note, 9ca2054 ja.ts:2151 / en.ts:2046, describe bars GMO's charts do not have; docs §8.156 records that
      v40's live note had the same error; gold's bars are not counted, and [13] says what was seen of them). If the
      15-minute run's 3 unidentified bars (2.4) prove to be Friday bars after 21:00, this item is corrected, this file
      first. Its pin, HEAD src/test/signal-alert-settings.test.tsx:602, changes with it. ja:
      「週末は、判定しない時間を広めに取っています。金曜 21:00 UTC（日本時間 土曜 6:00）以後、日曜 22:00 UTC（日本時間 月曜 7:00）より前に確定する足は判定しないので、週末の前の最後の足は判定されません（GMO の足では、ドル/円・豪ドル/ドルの15分足は金曜 20:45〜21:00 UTC の足、ユーロ/円・豪ドル/円・ユーロ/ドルの1時間足は金曜 20:00〜21:00 UTC の足で、米国の夏時間も冬時間も同じです。金の足は数えていません）。」
      en: "The time over the weekend when nothing is judged is drawn wide: a bar that closes at or after Friday 21:00 UTC (Saturday 6:00 Japan time) and before Sunday 22:00 UTC (Monday 7:00 Japan time) is not judged, so the last bar before the weekend is not judged either (on GMO's bars: on the 15-minute chart of USD/JPY and AUD/USD the bar 20:45–21:00 UTC on Friday, on the 1-hour chart of EUR/JPY, AUD/JPY and EUR/USD the bar 20:00–21:00 UTC on Friday, the same in US summer and winter time. Gold's bars have not been counted)."
    - [13] (HEAD [12]) gold's break: v40's text word for word (9ca2054 ja.ts:2152 / en.ts:2047). HEAD's 15-minute wording
      goes.
  - FAQ 「どの通貨ペアに対応していますか？」 (HEAD ja:2035 / en:1932): ja 「MACD の逆張りのサインをドル/円・ユーロ/円・豪ドル/円・
    ユーロ/ドル・豪ドル/ドル・金の15分足から選べます。」 → 「MACD の逆張りのサインをドル/円・豪ドル/ドルの15分足と、ユーロ/円・
    豪ドル/円・ユーロ/ドル・金の1時間足から選べます。」; en "and for the MACD fade signals on the 15-minute bars of USD/JPY,
    EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold." → "and for the MACD fade signals on the 15-minute bars of USD/JPY and
    AUD/USD and the 1-hour bars of EUR/JPY, AUD/JPY, EUR/USD and gold."
  - FAQ 「メールはいつ届きますか？」 (HEAD ja:2037 / en:1934): only the fade's clauses of its parenthesis change (the five
    pairs' and gold's become each pair's chart and reads, as in the card intro); the rest as HEAD. The whole answer, ja:
    「足が確定した後の読み込みで判定して送ります（MACD の逆張りは、ドル/円・豪ドル/ドルは15分足の確定の直後・1分後・3分後の読み込みで、ユーロ/円・豪ドル/円・ユーロ/ドルは1時間足の確定の直後・3分後・5分後の読み込みで、金は1時間足の確定の1分後から30分後までの間に、株は15分足の確定の後の読み込みで判定して送ります。日本株は Yahoo の値段が約15分遅れて届くため、確定の15分ほど後です（15分足では、まだ測っていません）。MACD の逆張りが実際に何分で届くかは測っていません）。RSI＋SAR・GA型の15分足・1時間足で日本時間 2:00〜8:59 に確定したサインは、過去の検証で損失が大きかったためメールしません（アプリの履歴には残ります）。Q-Trend・ULTRA・MACD の逆張り・流動性狩り＋EMAクロスは、この時間もメールします。」
    en: "It is judged and sent at a read after the bar closes (the MACD fade is judged and sent on USD/JPY and AUD/USD at the reads right after the 15-minute close and 1 and 3 minutes after, on EUR/JPY, AUD/JPY and EUR/USD at the reads right after the 1-hour close and 3 and 5 minutes after, on gold between 1 and 30 minutes after the 1-hour close, and on stocks at a read after each 15-minute close; Yahoo's Tokyo prices come about 15 minutes late, so Japanese stocks' emails come some 15 minutes after the close (not yet measured on 15-minute bars); how long the MACD fade's emails take to arrive has not been measured). RSI + SAR and GA-style signals on 15-minute and 1-hour bars closing 17:00–23:59 UTC are not emailed, as those hours lost most on past charts (they stay in the app's log). Q-Trend, ULTRA, MACD fade and liquidity sweep + EMA cross are emailed at those hours too."
  - The comments naming the specs (HEAD ja:2136-2137, :2236 / en:2031-2032, :2139-2140, found by a grep for
    "macdfade") say the per-pair form.
- **Sales page** (no percent and no measured number, src/test/landing.test.tsx; the FAQ's forbidden-number patterns,
  3.5, finding (1)). The rules of research/macdfade1h-prod-spec.md section 5 hold (the fade named first, with the reason
  it is left out of the break-even comparison; 〔adverse〕 chosen from the numbers). Word for word, ja and en:
  - `lp.faqs` 「勝率はどのくらいですか？」 (HEAD ja:2033 / en:1930): 「MACD の逆張りは、損切りをしない決まりで、損益ゼロに必要な勝率というものがないため、勝率では比べません。それ以外の、過去のチャート（スプレッド込み）で測ったサインは、どれも損益ゼロに必要な勝率に届いていません。数字はアプリ内の説明に載せています。MACD の逆張りは、5ペアを15分足と1時間足で測った数字が設定の注にあります。損切りをしないので、含み損のまま残る取引が出ることがあり、合図なしで入った時より良いとは示せていません。〔adverse〕損切りをしないのはこの決まりの作りで、損切りをしないことを勧めるものではありません。金・株と、流動性狩り＋EMAクロスは、まだ測っていません。勝てる根拠として使わないでください。」 en: "The MACD fade has no stop by design, so it has no break-even win rate and is not compared by one. Of the other signals measured on past charts (spread paid), none reached the win rate needed to break even. The numbers are in the app's notes. The MACD fade has its own numbers, measured on the five pairs only, on 15-minute and on 1-hour bars, in the settings' notes. With no stop, some trades can stay open at an unrealised loss, and it has not been shown to do better than entering with no signal. 〔adverse〕Having no stop is how this rule is built; it is not advice to hold without a stop. Gold, stocks and the liquidity sweep + EMA cross have not been measured. Please do not take them as a reason to expect to win." (「合図なしで入った時より良いとは示せていません」 holds on both charts: below no signal on 15-minute bars, within chance on 1-hour bars.)
  - `lp.honestBody` (HEAD ja:2028 / en:1925; a964994's text, unchanged but for 〔adverse〕): 「MACD の逆張り（5ペアで測定）は、損切りをしない決まりで、損益ゼロに必要な勝率がないため、勝率では比べません。それ以外のアプリのサインは、過去のチャート（11通貨ペア・スプレッド込み）での検証で、どれも損益ゼロに必要な勝率に届いていません。MACD の逆張りは、損切りをしないので、含み損のまま残る取引が出ることがあり、合図なしで入った時より良いとは示せていません。〔adverse〕サインは注文の指示ではなく、判断の材料です。通知したサインの実際の成績は、成績を記録している決まりについて、件数とともにアプリ内にそのまま表示します。MACD の逆張りの成績は、記録も表示もしていません。」 en (:1925): "The MACD fade (measured on five pairs) has no stop by design, so it has no break-even win rate and is not compared by one. Of the app's other signals, none reached the win rate needed to break even on past charts (11 pairs, spread paid). With no stop, some MACD fade trades can stay open at an unrealised loss, and it has not been shown to do better than entering with no signal. 〔adverse〕A signal is not an order to trade; it is something to weigh. For the rules whose results are recorded, the real record of the signals emailed is shown in the app, with how many there were. The MACD fade's results are not recorded or shown."
  - 「他のツールと何が違いますか？」 (HEAD ja:2032 / en:1929): only its parenthesis changes, ja 「（MACD の逆張りも、15分足の
    確定で判定します）」 → 「（MACD の逆張りも、ペアごとに15分足か1時間足の確定で判定します）」, en "(the MACD fade too, at
    15-minute closes)" → "(the MACD fade too, at 15-minute or 1-hour closes, by pair)". The whole answer, ja:
    「サインの成績を隠さない点です。過去のチャートでの検証結果と、成績を記録している決まりについては、通知したサインが実際に損切りと利確のどちらに先に届いたかを、勝てていない場合もそのまま表示します。MACD の逆張りは、利確と損切りの値段を書かない決まりで、その成績は記録も表示もしていません。売買のサインは確定した足で判定し（MACD の逆張りも、ペアごとに15分足か1時間足の確定で判定します）、後から消えたり動いたりしません。」
    en: "It does not hide the record. How each rule did on past charts, and, for the rules whose results are recorded, whether each signal emailed reached its stop or its target first, are shown as they are, losing ones included. The MACD fade states no take-profit or stop price, and its results are not recorded or shown. Trade signals are judged on closed bars (the MACD fade too, at 15-minute or 1-hour closes, by pair) and never vanish or move afterwards."
  - The five clauses of research/macdfade1h-prod-spec.md section 5, as a964994's version of this file listed them (word
    for word; src/test/landing.test.tsx:133-141 finds each, ja and en, in both files):
    - 〔mean〕 < 0: 「測った期間では、1回あたりの平均はマイナスでした。」 / "Over the period measured, its mean a trade was below zero."
    - 〔mean〕 < 〔baseMean〕: 「合図なしで入った時より、1回あたりの平均が低くありました。」 / "Its mean a trade was below entering with no signal."
    - 〔mean〕 < 〔flowMean〕: 「同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。」 / "Its mean a trade was below entering the other way on the same signals."
    - some pair's fade pipsMean < 0: 「5ペアのうち、1回あたりの平均がマイナスのペアがありました。」 / "On some of the five pairs its mean a trade was below zero."
    - 〔open〕 > 0 and 〔openPipsWorst〕 < 0: 「測った期間の終わりに、含み損のまま残っていた取引がありました。」 / "At the end of the period measured, some trades were still open at an unrealised loss."
  - **〔adverse〕 per chart.** research/macdfade1h-prod-spec.md section 5's five clauses, in its order, evaluated on each
    chart's run (the landing test reads both, `FADE_MEASURED["15min"]` and `FADE_MEASURED["1h"]`, in place of the one
    `FADE_MEASURED` at :9, :117): a clause met on both charts is written as that spec writes it; a clause met on one chart
    only is written with 「15分足では、」 / 「1時間足では、」 in front (en "On 15-minute bars, " / "On 1-hour bars, " in front,
    the clause's first word in lower case); a clause met on neither is left out. Why: the sales page speaks of the fade as
    mailed, on both charts; keeping only the clauses true on both would hide that on the chart of USD/JPY's and AUD/USD's
    mails the fade did worse a trade than no signal and than the other way.

    | clause | `15min` (run 44535888012) | `1h` (run 44555599946) |
    |---|---|---|
    | 〔mean〕 < 0 | no (+2.41) | no (+3.26) |
    | 〔mean〕 < 〔baseMean〕 | yes (+2.41 < +3.32) | no (+3.26 > +3.21) |
    | 〔mean〕 < 〔flowMean〕 | yes (+2.41 < +3.19) | no (+3.26 > −2.08) |
    | some pair's fade mean < 0 | yes (AUD/JPY −0.82) | yes (USD/JPY −0.26) |
    | 〔open〕 > 0 and 〔openPipsWorst〕 < 0 | yes (80, −1,913.4) | yes (22, −1,733.2) |

    **Chosen** (from the ledger copies, checked by this writer; the build checks it against the copies):
    〔adverse〕 = ja「15分足では、合図なしで入った時より、1回あたりの平均が低くありました。15分足では、同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引がありました。」
    en "On 15-minute bars, its mean a trade was below entering with no signal. On 15-minute bars, its mean a trade was below entering the other way on the same signals. On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades were still open at an unrealised loss."
    In en a non-empty 〔adverse〕 is followed by one space (as the 1-hour spec says). (HEAD's texts hold the 1-hour spec's
    choice, the last two clauses only, ja:2033.)
  - Not checked here, kept from today's texts: as research/macdfade1h-prod-spec.md section 5.
- **Tests to change** (3.5 lists the lines): the guard lists of research/macdfade1h-prod-spec.md section 5 "Tests to
  change", on the texts above; the forbidden-number patterns (finding (1)); every item written out above pinned word for
  word in ja and en (with 〔switch〕 as step 4's PR fills it, the date above); `macdxNotes` 14 items; no sentence left
  that puts the five pairs and gold on one chart (the pin that today forbids 「1時間足」 in `macdxNotes` and the intro, src/test/
  signal-alert-settings.test.tsx:1262-1281, becomes a per-pair pin: each pair's chart named as above, 「15分足」 only
  beside USD/JPY, AUD/USD, the shares or the 15-minute run, 「1時間足」 only beside EUR/JPY, AUD/JPY, EUR/USD, gold, the
  1-hour run or the time before 〔switch〕; and, as HEAD's strip list keeps them (test :1263-1277), three phrases section
  5 itself requires: the owner's pane 「15分足の MACD の枠を新しい120本にすること」 / "the 15-minute MACD pane of the newest
  120 bars" (`indicatorIntro.macdx` and `macdxNotes` [11]), and the shares' 「1時間足の読み込みで測りました」 / "on the
  1-hour reads" and 「1時間足の時に、確定の数秒後に送っていました」 / "after the close on 1-hour bars" (`stockmacdNotes`
  [2]); without them the pin fails on the texts it pins); the intro's and FAQ's leads with no arrival time (as HEAD's
  pins, :493-498 and the FAQ's after them); the landing tests per chart.

## 6. Release

### 6.1 Preconditions

- **The numbers are in:** research/ledger/macdfade15-summary.json (run 44535888012, `eacb7815…`, without its `tf` line
  `74a4a230…`) and research/ledger/macdfade1h-whole-summary.json (run 44555599946, `d59b64c6…`) are in the repository
  (a964994, e660119), and `FADE_MEASURED` holds each run's values, each pinned to its own copy (4.5).
- **The shares are fitted** (6.3 step 1b): the probe's shapes and times are written in 3.3 (no price, 3.3), and 3.3
  items 3-6 match them (or are changed to match them, with this file corrected first). 3.3 item 6's texts are decided
  (removed, 4.4, section 5); its parser change is made only if the probe's timed reads call for it (3.3 item 6).
- **The study check passed on both charts at the function PR's last commit that touches a file the check runs** (7.2;
  corrected at the fifth review: this asked for the PR's final head commit, and its last sentence then asked for new
  runs only after a commit touching such a file, two different rules): a `tf` `15min` run and a `tf` `1h` run of
  macdfade15.yml whose head SHA equals that commit, both run ids and the SHA written in the PR, each run's summary.json
  its chart's run of record. The files the check runs are research/macdfade-prod-check.ts's imports followed through
  (on HEAD, relative imports only, 35 files under research/ and supabase/functions/, signal-alerts' indicators.ts and
  stocks.ts and `_shared/macd-fade-measured.ts` among them, neither signal-alerts/index.ts nor src/lib/i18n; listed by
  this writer at the fifth review) and the workflow's push paths (:38-62). The commits after that SHA are listed in the
  PR with their files, and none touches such a file; so a commit that changes only the release date (`FUNCTION_VERSION`
  in index.ts, 3.7; 〔switch〕 in ja.ts / en.ts, section 5 [0]) needs no new run. A push runs the workflow on `TF=1h` only (.github/workflows/macdfade15.yml:82,
  its push paths :38-62 include research/macdfade-prod-check.ts, `_shared/macd-fade.ts` and `signal-alerts/indicators.ts`),
  and only on the branch claude/app-confirmation-jvmk03 (:35-37); so the 1-hour run can be the push's at that commit
  when the PR's head branch is that branch and the commit touches a push path; otherwise it is a dispatch. The 15-minute
  one is always a dispatch. Any later commit that touches
  a file the check runs needs both again before the merge.
- **The app reads the per-pair offer** (6.3 step 2): the grid PR (section 5) merged and published to Lovable, its state
  reported as given.
- **The morning check is built before the function** (7.3), as v11 was before v40 (scripts/morning-check/README.md v11):
  `pairs-v12` cut to USD/JPY and AUD/USD, the new three-pair `pairs1h-v11`, `stocks-v12`, the bench redone, merged before
  step 4; the Routine's switch-day prompt and its rollback prompt (7.3, 6.4) written and kept ready. Then step 8 only
  sets the constants and rebuilds.
- The tests and static checks of 7.1 pass on the function's branch (section 5's texts in it: 3.5 "Tests, by PR").
- **The subscription statements were run on a local PostgreSQL before step 3** (7.1, "The subscription statements"):
  every statement of 3.6 and 6.4, with the rows each leaves as those sections say (added at the third review).
- **The twins are in** (3.6; 6.3 step 3): the statement's own list shows only `'15min'` rows of the narrowed set and no
  row of the four 1-hour charts (3.6); the counts read back as context (a change in the four 1-hour charts' `macdx`
  counts between the reads is followers' ticks, written down, not a failed precondition; corrected at the fourth review).
- No v40 state to wait for: v40 keeps no open trade and no state row (research/macdfade1h-prod-spec.md 3.2).
- **A merge alone ships it** (deploy-functions.yml:21-27: a push to main touching `supabase/functions/**`; :76: the
  default list, econ-calendar not in it). So every PR before the function's has nothing under `supabase/functions/**`.
  The function's squash message is written by hand and holds none of `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip
  actions]`, `[actions skip]` (v40's push deploy did not run for that reason, docs §8.155). About a minute after the
  merge, check that "Deploy edge functions" runs for the merge's SHA; if not, dispatch it at once with the input empty
  (the default eight). Then check that the run succeeds (its conclusion, and its "Report what is live" step,
  deploy-functions.yml:86-87, showing signal-alerts and live-chart updated): the loop deploys the slugs one by one under
  `set -euo pipefail` (:62-84), so a run that stops on an earlier slug leaves the old bundles live (corrected at the
  third review: "runs" only, before).
  **If the deploy does not reach signal-alerts** (added at the fourth review: no step was given): the run fails before
  signal-alerts' slug (seventh of the eight, :76; a failure on any earlier slug, or the token step, :51-56, stops it), or
  no run deploys the merge's SHA, and no run record says v41. Then v40 serves the minute runs and the screen throughout.
  The default list is dispatched once more, only while v41's first answer can still land by H:18; otherwise, or if that
  run fails too, the merge is reverted at once (its message written by hand), so that no later push touching
  `supabase/functions/**` (:21-27), or a dispatch, deploys v41 unattended at a minute outside 6.2's window. In that case
  6.4's reconcile, rebuild, (b1) and (b2) are not sent: under v40 throughout, the `'1h'` rows are current (v40's ticks
  and unticks change `'1h'` rows only, 3.6) and the `'15min'` rows are only the twins. The twins are removed with 6.4's
  narrowed `'15min'` delete, after its matching select (3.6), counted, with the owner's confirmation, and written in docs
  §8.156; econ-calendar is not redeployed (step 6 was not reached; its live bundle is v40's, which never read the twins,
  3.6). A run that stops after signal-alerts, at live-chart, leaves v41 live: that is 6.3 step 5b's case (live-chart
  dispatched by name once more; 6.4 only if that fails too, corrected at the fifth review).

### 6.2 Timing

What the timing decides differs by chart. Let H be an hour, and "first answer" the first run whose record says v41.
- **USD/JPY and AUD/USD** (the only `macdx` charts that move). v40 and v41 never judge the same bar (1-hour against
  15-minute bars, under different ids and rows); the timing decides a **gap** (a span judged by neither) or an
  **overlap** (v41's 15-minute bars inside v40's last 1-hour bar, both mailed). v40 reads the 1-hour close at H:00 at
  H:00, H:03 and H:05 (HEAD indicators.ts:1056, unchanged from v40); v41 reads each 15-minute close at +0, +1 and +3
  (HEAD :1055). A first answer from H:06 to H:18: v40 has made all three reads of the H:00 close, and v41's first bar
  is H:00-H:15 (read at H:15, H:16, H:18): no gap, no overlap, when one of those reads judged the hour. When none of
  v40's reads of the H:00 close judged it (each can end `not_yet`, `unavailable` or `maintenance`, 6.3 step 5), v40's
  last judged bar ends at H-1:00 and the hour H-1:00 to H:00 is a gap of four bars, at any first answer from H:04 on
  (added at the third review). A first answer at H:00: v40 made no read of the H:00 close, so its last judged 1-hour
  bar ends at H-1:00, while v41's first bar opens at H-0:15 (its read at H:00 is of the H:00 close): a gap of three bars, H-1:00 to H-0:15 (corrected at the second review: this first said one overlapping
  bar). From H:01 to H:03: v41 also judges the bar H-0:15 to H:00 (one overlapping bar), or, if v40's H:00 read did not
  judge the hour, the same three-bar gap. At H:04 or H:05: v40's later reads of the H:00 close are lost (they matter
  only when the earlier ones failed: then the four-bar gap above). After H:18: the bar H:00-H:15 is judged by nobody (a
  gap of one bar, one more for each later quarter; the four-bar gap before it too, if no read of v40's judged the
  hour). (The counting: scripts/morning-check/src/back1-v12.part:110-116.)
- **EUR/JPY, AUD/JPY, EUR/USD and gold.** v40 and v41 read the same `'1h'` chart at the same minutes and write the same
  id (3.7). A close both look at is mailed once a follower (2.5: `mailRide` and the claim key,
  20260925180000_signal_alert_rules.sql:30-32). So the switch is a plain redeploy for them at any minute: no gap, no
  overlap. (Under the first version gold moved too, and its overlap set the lower bound of the window; it does not move
  now.) This holds only with 3.2 item 4 built (the row's id from the chart).
- **Shares.** v40 mails a share's 1-hour bar up to 45 minutes after its close (stocks.ts:114). Tokyo trades 00:00 to
  06:30 UTC (last close +45: 07:15); New York, in its winter (now), 14:30 to 21:00 UTC (last close +45: 21:45). A switch
  between 07:15 and 14:30 UTC has neither form's share bars open: the last Tokyo session is v40's, the next New York one
  v41's.
- **So: aim v41's first answer at H:06 to H:18 UTC, H from 08 to 14, Monday to Thursday** (17:06 to 23:18 JST). The
  merge goes at about H:07 to H:09: v31 answered about a minute after its merge (docs §8.127); v40's first answer came
  about 73 seconds after its merge (merge 12:38:47, the deploy dispatched by hand, first answer 12:40:00, docs §8.155,
  OPERATIONS.md:13002-13003). That leaves some nine minutes for a slow deploy. Not Friday: the weekend gate starts at 21:00
  UTC and the switch day's morning check would wait over the weekend.
- If the first answer lands at H:00, USD/JPY and AUD/USD have a gap of three bars; from H:01 to H:03, one overlapping
  bar (or that gap, if v40's H:00 read did not judge the hour); at H:04 or H:05, a lost read; if after H:18, a gap of one
  bar or more; and at any first answer from H:04 on, a gap of four bars if none of v40's reads of the H:00 close judged
  the hour. With H = 14 a late first answer reaches the shares too (added at the fourth review): in New York's winter
  its session opens at 14:30 UTC and v40's first 1-hour close of it is 15:30 UTC, and v41 judges only the newest
  closed bar at a read (2.4). A first answer up to 14:59 leaves them clean (v41 judges the 14:30 bar at the 14:45
  close's reads); from 15:00 on, the New York bars from 14:30 up to v41's first judged bar are judged by neither, a gap
  of one 15-minute bar, one more for each later quarter (if v40 judged its 15:30 close before v41 answered, its bar
  14:30-15:30 covers them, and v41's first bar inside it is an overlap instead). Counted from the code. Either is
  written down (docs §8.156) and told to the owner; nothing else is done.
- Recorded from the run's records (`net._http_response`): v40's last answer and v41's first; for USD/JPY and AUD/USD the
  end of the last 1-hour bar v40 judged (`end_1h_ms`) and the open of the first 15-minute bar v41 judged (`live_ms`, for
  the morning check, 7.3); for EUR/JPY, AUD/JPY, EUR/USD and gold, v40's last judged 1-hour bar and v41's first (docs
  only: they should follow on with no gap).

### 6.3 Order

1. **This spec:** a PR with nothing under `supabase/functions/**`. In it: research/macdfade1h-prod-spec.md gets under
   its title "**For production (2026-11-19, signal-alerts v41, research/macdfade15min-prod-spec.md): USD/JPY, AUD/USD and
   the shares move to 15-minute bars; EUR/JPY, AUD/JPY, EUR/USD and gold keep this spec's rule, chart and id, their mails'
   numbers taken from run 44555599946** (the owner's per-pair decision). It stays the record of v40."; research/macdfade15-prod-spec.md's
   superseded line gains "The 15-minute form is built, per pair, from research/macdfade15min-prod-spec.md (2026-11-19)."
1a. **The numbers: done.** Both ledger copies are in (6.1), the study check takes both `TF`s (4b20d06), and
   macdfade15.yml holds each chart to its run of record (7.2). `FADE_MEASURED`'s two runs, `chanceOf`'s new branch, the
   `m.tf` word and `FADE_MAILED_ON` go only in step 4's function PR, with section 5's texts (3.5 "Tests, by PR": the
   notes' paragraphs are pinned to `FADE_MEASURED_NOTES`): merged alone they would push-deploy with v40's code
   or HEAD's, and a module that throws at load stops signal-alerts (every rule's mail) and live-chart (both load it
   through HEAD indicators.ts:41, both in the push's list, deploy-functions.yml:76), and econ-calendar the next time it is
   deployed.
1b. **The probe:** .github/workflows/yahoo-probe15.yml dispatched (read only; since d794649 it prints no price, 3.3). What
   it shows is written in 3.3, and 3.3 items 3-6 are fitted to it (this file corrected first where it differs).
2. **The app's grid PR, before the function** (section 5; src/ only, so its merge deploys no function): `macdx.limited`
   read and the new "—" title. **Cut from main, without 001a3df's src/lib/i18n texts** (or any of its build), so what it
   publishes is v40's texts with this change; the function's branch then takes main. Merged and published to Lovable well before step 4 (the day before if the release day
   allows); Lovable's state reported as given (e.g. `pending`), not checked further (CLAUDE.md). Against v40 it draws v40's
   one 1時間 column, as today.
2a. **The study check on the function's branch** (7.2), at the commit 6.1 names (the PR's last commit that touches a
   file the check runs): a dispatch of macdfade15.yml with
   `tf` `15min`, and a `tf` `1h` run (the push's at that commit, or a dispatch); both run ids and the head SHA written in
   the PR. A failure, or a summary.json other than its chart's run of record, stops the release.
3. **The twins** (3.6, narrowed to USD/JPY, AUD/USD and the shares), with the owner's confirmation, just before the merge
   (T0 recorded); its own list of rows only `'15min'` rows of the narrowed set, none of the four 1-hour charts (3.6); the
   counts read before and after, per rule, pair and interval, as context (3.6).
4. **The function's PR** (sections 3-4: index.ts, indicators.ts, stocks.ts, live-chart/stocks.ts if the probe needs it,
   macd-fade-measured.ts, macd-fade.ts's comments; **section 5's texts**, src/lib/i18n/ja.ts and en.ts, in place of
   001a3df's all-15-minute texts, with 〔switch〕 written as the merge's UTC date, section 5; the tests, 3.5), merged per
   6.1-6.2. Merging puts the texts on main; they reach the app only at step 7's publish (as v40's did: #281 carried them, published after v40 answered, docs §8.155,
   OPERATIONS.md:13007).
5. **Once v41 answers:** the times of 6.2 recorded (M, the merge's time, and T1, v41's first answer, among them). In the
   run's record `newest` is the bar's open (HEAD index.ts:1042). A close counts as judged when a read of it has a
   `fade` field without `error`: a `fade` that ended `failed` or `no_price` judged nothing (below). Per chart, **each
   chart with a `macdx` row on the pair's own interval** (as step 3's and 5b's counts show): a chart nobody follows under
   `macdx` is not judged for the fade (`fadeSubs` and `faded`, HEAD index.ts:931-932, :1017), and with no follower under
   any of the six rules it is not read at all (`followed`, `gmoCharts`, HEAD :797-811), so it leaves no `fade` field and
   no read in the records. Such a chart is written down as not followed and checked no further, here, in 5a or in 6.4
   (corrected at the third review: these checks named the six charts with no follower condition, so a chart nobody
   follows, which 2.4 lists as never judged, would have counted against v41).
   - USD/JPY and AUD/USD: by H:20, each record shows the bar opened at H:00 (closing H:15) judged, its `newest` H:00 and
     a `fade` field without `error` (from the read at H:15, H:16 or H:18); and no `no_price` on any of their entries
     either (v40 priced them from `hourQuotes`, 9ca2054 index.ts:936, :1148; the chart-keyed `fadeQuotes` of 3.2 item 5
     is new on both charts).
   - EUR/JPY, AUD/JPY and EUR/USD: the 1-hour bar opened at H:00 (closing H+1:00) judged at H+1:00, :03 or :05, `newest`
     H:00 and a `fade` field without `error`; and no `no_price` on any of their entries in the first hours (the price
     now comes from `fadeQuotes` keyed by chart, 3.2 item 5; an entry is not certain to come in that time).
   - Gold: at v41's first answer (H:06 to H:18) gold's close at H:00 (the bar opened at H−1:00) is still due
     (`twelveCloseDue`: 60 seconds to `freshFor("1h")`, 30 minutes, after the close, HEAD indicators.ts:1133-1140), and a
     fresh instance has no `judgedBar` for it (HEAD index.ts:1062-1085). So v41's first gold judgment is that bar, under
     v40's same id: if it had an entry, v40's rows of it are found and nothing is mailed again (`mailRide` leaves out a
     follower with a row, HEAD :749; 2.5). Then the bar opened at H:00, from H+1:01, as v40 judged gold's first bar
     (13:01 to 13:28 UTC, docs §8.155).
   - If a close is not judged, the reason is read from the record's entries of its reads and written down. The values
     the record writes (HEAD index.ts): the run's summary `skipped: "market_closed"` (the weekend gate, :784); per read
     `skipped` `judged` (already judged by this instance: not a miss), `not_yet` (a pair's newest bar not in GMO's
     answer, :1207-1208; gold's bar not in Twelve Data's stored or read bars, :1095, :1137), `waiting` (gold, between its
     Twelve Data reads, :1099), `deadline` or `maintenance` (the run's 90-second fetch budget, `FETCH_BUDGET_MS` :393,
     spent, or GMO in maintenance, before the read, :1171); `error` `short` (fewer than 600 closed bars, :1191),
     `unavailable` or `maintenance` (GMO's read failed, :1180), `twelve_unavailable` (:1112, :1129), `day_spent` (:1103);
     and on an entry of a chart the fade is judged on, `fade.error` `no_price` (:972) or `failed` (any exception out of
     `fadeAtClose`, :1018-1024, a failed `signal_alerts` read in `mailRide` among them, `rows_unread`, :744; the entry
     still carries its `fade`, :1047). There is no `stale` (`files.stale`, :855, is a counter).
     **Expected** (the sources' side of 2.4's "Never judged"; written down, no rollback): `market_closed`, `not_yet`,
     `waiting`, `twelve_unavailable`, `day_spent`, `unavailable`, `maintenance`, `short`, and a chart with no `macdx`
     follower on its own interval (above). **Not explained** (6.4's triggers count them; 2.4 lists some among "Never
     judged" too, but they are v41's own side): a close of a followed chart none of whose minutes has a read of the
     chart in the records (the queue, 2.4; but for the 1-hour pairs' Tokyo closes that 6.4 excepts, added at the fifth
     review), `deadline` on every read of it (the run spent its budget before the chart: 2.4 counts the `macdx` charts' reads as no heavier than v40's or the build's, but with
     other rules' followers minutes 0 and 3 can carry up to 2 more GMO chart reads than v40; run lengths not measured), a
     failed run, a `fade` that ended `failed` (v41's own code), and `no_price` on any `macdx` entry, the 15-minute pairs'
     included (corrected at the third review: `failed` was not listed, and `no_price` was counted on the 1-hour pairs
     only, though 3.2 item 5 rewrites the 15-minute pairs' price path too). Every `failed` is written down, even when a
     later read judged the bar: a throw after `claimRow` leaves a `pending` row and no mail, and the later read counts
     that follower as mailed (3.2 item 7). If v41 judges nothing at all, 6.4's exception applies at
     once. The run's records are kept about 6 hours (docs §8.141, OPERATIONS.md:5081): every check here reads them
     within that, and **from v41's first answer to the end of 5a's Tokyo span they are read at most about 5 hours
     apart**, each read covering every chart's closes since the read before (corrected at the second review: with only
     the reads of steps 5 and 5a, the closes from about 15:15 to about 18:15 UTC, and with H = 08 some after about
     09:05, would have no read before their records were gone). So, besides the reads at H:20, H+1:05, 5a's New York
     span and 5a's Tokyo span: with H 08 or 09, one about 12:00 to 13:00 UTC; for every H, one about 19:30 to 20:00 UTC
     (between the New York and the Tokyo span). After 5a's Tokyo span the records are not read on a schedule: a close
     not judged after it is seen only by the morning check, and only where the recount finds an entry on it
     (`missing`); a close with no entry leaves no trace there.
     **Who makes each read, and how** (added at the third review: no one was named, and some reads fall at night in
     Japan: 5a's New York span is 23:45 to 00:15 JST, the read of 19:30 to 20:00 UTC is 04:30 to 05:00 JST). The session
     that merged the function makes every read of steps 5 and 5a itself, each one read-only `select` on
     `net._http_response` through the Supabase connector (or the owner runs it in the SQL Editor), and at the release it
     sets a scheduled task of its own session for each read time above, so that no read rests on someone being awake.
     Each read writes, per chart, the closes judged and the closes not explained, as counts and bar times only (no user
     ids, no addresses, no prices), into the docs §8.156 draft. Whether the connector asks the owner before a read-only
     query at that hour is not known here (3.6 names its confirmation for the statements only); if it asks and nobody
     answers, that read is missed. **A missed read:** the closes whose records expired before any read are written down
     in docs §8.156 as not checked; nothing shows them judged or not, so they are no trigger of 6.4.
   **5b, 6 and 7 do not wait for 5a**: they follow step 5 within the hour; 5a's watch (to the next day's Tokyo session)
   runs beside them, and only its failure leads to 6.4.
5a. **The shares and the queue** (2.4, 3.3 item 10). At the first New York close after v41 answers (14:45 UTC in New
   York's winter; its reads to 15:15 UTC): the stocks run's records show each followed US share with `bars` 600 or more,
   `judged` true, `newest` the bar opened at 14:30, no `yahoo_*` error, and `took_ms`. In the first Tokyo session (the
   next day, 00:15 to 01:00 UTC at least): each followed Tokyo share's bars judged once each about 15-16 minutes after
   their close (`judged_after_ms`), no `yahoo_*` error; no stocks call timed out (`net._http_response` `timed_out`,
   `error_msg`); `took_ms` and any `skipped: "budget"` written down; and in the same span **every followed chart's closes
   judged** (a chart with a `macdx` row on the pair's own interval, step 5): USD/JPY's and AUD/USD's every quarter hour,
   EUR/JPY's, AUD/JPY's and EUR/USD's every hour (a read at :00, :03 or :05) and gold's every hour (a `fade` field
   without `error` for each bar, `judged_after_ms` as the reads give). The 1-hour charts are watched as closely as the
   15-minute ones; in Tokyo's hours their reads at :00, :03 and :05 shared the queue with an every-minute stocks run
   under v40 too, with no budget (2.4; corrected at the fifth review: this said v40 never did), so a 1-hour pair's close
   missed there only behind a stocks call is written down and is no trigger (6.4). Each finding goes to docs §8.156; a
   failure is 6.4's.
5b. **live-chart and the reconcile.** live-chart is deployed in the same push and loads indicators.ts and
   macd-fade-measured.ts (HEAD indicators.ts:41), and the shared Yahoo parser if 3.3 item 6 changes it. Right after the
   deploy: the app's chart opened on a pair's 15-minute and 1-hour chart and on a stock's 15-minute chart shows bars
   (when 3.3 item 6's parser change was made, a Tokyo stock's too, its last bars looked at: the 11:30 bar of its own and
   the session's last bar as 7.1's parser cases say; added at the fourth review), and the deploy's log shows live-chart
   deployed. If the log does not show live-chart deployed (the run stopped at its slug, the last of the default list,
   deploy-functions.yml:76, so the old live-chart stays live, :62-84, with v41 live), `live-chart` is dispatched by name
   once more at once, as step 6 does for econ, and checked again (the run's conclusion, its "Report what is live" step,
   :86-87, and the chart check above). **6.4 at once** (which sends the reconcile first, 6.4) only if a deployed
   live-chart does not show bars, or that second dispatch fails too (corrected at the fifth review: a live-chart not
   deployed went to 6.4 at once, though the old live-chart still serves the chart and one dispatch can fix it). Then, as
   soon as that check passes, the reconcile of 3.6 (narrowed; (a1) bounded by M; with the owner's confirmation), its counts
   read before and after. **Before step 6** (3.6, the econ order).
6. **econ-calendar** deployed by name right after 5b (it bundles `isMacdhChart`, econ-calendar/mailer.ts:13; it is not in
   the default list). Its recipients are then A ∪ B15 (3.6). Never HEAD's econ (all six on 15 minutes). **Checked
   before anything that rests on it** (added at the third review: nothing checked that this deploy happened, and step 9
   and 6.4's `'15min'` delete drop digest recipients if the old bundle is still live): the dispatched run's conclusion
   is success, and its "Report what is live" step (deploy-functions.yml:86-87) shows econ-calendar's version or updated
   time changed; both written in docs §8.156; if not, the dispatch is made again. A failed run leaves the old bundle
   live (the slugs are deployed one by one under `set -euo pipefail`, :62-84).
7. **The screen's texts published:** main (holding section 5's texts since step 4) published to Lovable once v41
   answers; no PR and no test change. Lovable's state is reported as given. Until it is live the app shows what step 2
   published: the per-pair grid (once v41 answers) beside v40's texts, which name USD/JPY, AUD/USD and the shares on 1-hour
   bars (wrong for them from v41's first answer until the publish) and hold v40's measured paragraph (run 44099401423,
   +3.20); the four 1-hour charts are named rightly. So step 7 follows step 5 within the hour.
8. **The morning check** (7.3; built and merged before step 4): the go-live constants (`live_ms`, `end_1h_ms`) of USD/JPY
   and AUD/USD set from the run's records and rebuilt (`build.sh`, v3.md5), merged; the Routine's prompt replaced by the
   switch-day prompt (7.3) and read back before the first 00:16 UTC run after the switch (a copy of the v11 prompt kept,
   and the rollback prompt of 7.3 ready beside it, 6.4).
   If v12's constants are not in by then, the switch-day prompt goes in all the same: it runs v11 for the switch day, reads
   USD/JPY's and AUD/USD's 1-hour bars from `end_1h_ms` on as not v11's, and says 7.3's sentence for what is not
   recounted.
9. **Later, with the owner's confirmation, and only after step 6:** after the first morning check of the new form that
   reads clean, the `'1h'` rows of `macdx` on USD/JPY and AUD/USD and of `stockmacd` are deleted (3.6, the narrowed
   statement), counted before and after; its own list of rows (3.6) only `'1h'` rows of the narrowed set: the four 1-hour
   charts' `macdx` rows are not touched. Before it, step 6's
   checks have passed, and the econ answer of a Japanese morning after step 6's deploy (its `recipients`, a count,
   econ-calendar/mailer.ts:96-107, read from the run's record) equals a count of A ∪ B15 (3.6) read from the
   subscription table near that run (counts only, no ids); a difference that the ticks between the two reads do not
   explain is written down and step 9 waits (added at the third review).
10. docs/OPERATIONS.md §8.156 (the release, each chart's run and numbers with every field CLAUDE.md asks for, the
    statements sent, the times, `live_ms`, what is not measured); §8.155 gets a last line "→ §8.156 (EUR/JPY, AUD/JPY,
    EUR/USD and gold keep v40's rule; their mails' numbers from run 44555599946)"; §9 gets the first real data to check
    (section 8); §10's checklist gains "moving an email to another bar length, per pair: that pair's subscription rows
    first, the function, the old rows later; the rows of the pairs that do not move are not touched; the merge window".

### 6.4 Rollback

Only for a failure; the owner is told. Revert the function's merge so that v40's first answer again falls from H:06 to
H:14 UTC, H from 08 to 14, Monday to Friday (outside the share sessions, as 6.2). Friday is allowed here, unlike the
switch (corrected at the second review): a switch on Thursday has its first Tokyo watch on Friday 00:15-01:00 UTC
(6.3 step 5a), and a failure found there would otherwise run through Friday's trading to the 21:00 UTC gate and again
from Sunday 22:00 UTC to Monday's window. A Friday window H:06 to H:14, H 08 to 14, is outside both share sessions and
well before the gate. Its cost: the morning check of a Friday v41 window waits for Tuesday's run (the Saturday run
finds no Friday day file, and the Tuesday run counts the previous Friday's key as well, scripts/morning-check/README.md
:122, :860); that delay is taken over the hours of a failing v41. Then USD/JPY and AUD/USD are clean:
v41 has made its three reads of the 15-minute close at H:00 (H:00, H:01, H:03), v40's read of the 1-hour close at H:00
at minute 5 has passed (so v40 does not judge the hour v41 covered with its 15-minute bars), v41 has not judged the bar
H:00-H:15 (it would at H:15), and v40 judges the 1-hour bar opening at H:00 at H+1:00. EUR/JPY, AUD/JPY, EUR/USD and
gold are a plain redeploy again (the same id and chart in both versions, 6.2). The revert's merge goes at about H:05 to
H:07 (v40's first answer came about 73 seconds after its merge, docs §8.155, as 6.2), which leaves some seven minutes
for a slow deploy. If v40's first answer lands outside H:06 to H:14 (added at the third review: no merge minute and no
such list were given): at H:00 to H:05, v40 reads the 1-hour close at H:00 (HEAD indicators.ts:1056) and judges the
hour v41 has covered with its 15-minute bars, an overlap of up to four bars on USD/JPY and AUD/USD; at H:15, none (v41's
last answer, at H:14 or before, never read the H:15 close); at H:16 to H:18, an overlap of one bar if v41 answered at
H:15 or later; later, one more for each quarter v41 still judged. With H = 14, a v40 first answer after 14:45 UTC
(New York's winter) overlaps on the shares too (added at the fourth review): v41 has judged New York's 15-minute bars
from 14:30 at each quarter close from 14:45 to its last answer, and v40 judges the 1-hour bar 14:30-15:30 at 15:30, its
first close of that session: an overlap of one 15-minute bar for each quarter close from 14:45 that v41 still judged
(counted from the code). Each is written down (docs §8.156) and told to the owner. The revert's message is written by
hand; check that the deploy runs and succeeds (as 6.1).
- **Only for a v41 that served the screen** (added at the fourth review; corrected at the fifth: its last sentence sent
  6.3 step 5's "v41 judges nothing at all" and 5b's live-chart case to 6.1's branch, though on both v41 served the
  screen, against 5b's "sends the reconcile first" and 6.1's last sentence): the reconcile, the rebuild, (b1) and (b2)
  below rest on v41 having served the screen from its deploy on (the rebuild: "under v41 an untick leaves the `'1h'` row
  and a tick makes none"; (b1)'s bound V: "before V only v41 serves the screen"). The path is decided by the run's
  records, not by the step that sent the session here. **If any record of any of signal-alerts' modes says v41** (the
  minute runs' summaries carry `version`, HEAD index.ts:783, :1574, :1876, and `gold-ticks` answers with it at once,
  :1862; a v41 that loads also serves the screen's `status` and `set`, :2088, :2126-2200), the full path below is
  taken: the reconcile if not yet sent, the rebuild, the revert, (b1) and (b2). 6.3 step 5's case and 5b's are always on
  it (step 5 is reached only once v41 answers). A run that throws inside answers `internal_error` with no version (the
  outer catch, HEAD index.ts:2231-2233), but a loaded v41's other modes still say v41. **Only if no record ever says
  v41** (the deploy stopped before signal-alerts' slug, 6.1, so v40 served throughout; or v41 was deployed but fails at
  load, so it answered no request, the screen's included, and no row changed under it) does 6.1's branch apply instead:
  the merge reverted at once, without waiting for the owner (no statement goes before it), then the twins removed by
  the narrowed `'15min'` delete after its matching select, with the owner's confirmation; no reconcile, nothing rebuilt,
  no (b1) or (b2). Under v40 those statements would act against v40's own ticks and unticks.
- **First, if 3.6's reconcile has not been sent** (a revert "at once" from step 5 or 5b can come before it): (a1) and (a2)
  of 3.6 are sent before anything below, with the owner's confirmation, counted before and after; (a1) is bounded by M
  (the function merge's time), which exists whether or not v41 ever answered (there may be no T1). Without it the
  rebuild below starts from sets out of step: its delete would remove a USD/JPY, AUD/USD or share `'1h'` row ticked
  under v40 after T0 (no twin yet), so that follower loses v40's mail, and the econ digest if it was their only `macdx`
  row; its insert would bring back the `'1h'` row of a twin whose `'1h'` row was unticked under v40 after T0, so v40
  mails a follower who unticked.
- **The `'1h'` rows of USD/JPY's and AUD/USD's `macdx` and of `stockmacd` are rebuilt from their `'15min'` rows before
  the revert** (R = the time written into the statement just before it is sent, as 3.6 writes M, T0 and V; it was "the
  statement's time" before the fifth review), whether or not step 9 has run, with the owner's confirmation, counted
  before and after, and no earlier prompt of it still open when the revert goes (3.6). Under v41 an untick leaves the
  `'1h'` row and a tick makes none (3.6), so those `'1h'` rows are out of date:

  ```sql
  -- '1h' rows of these follows unticked under v41. Bounded by R (added at the fifth review): before V no tick makes a
  -- '1h' row of these (v41's set refuses '1h' for them), so every row to delete is older than R; a run of this
  -- statement after V (a send that timed out, 3.6) then spares the '1h' rows v40's ticks make
  delete from public.signal_alert_subscriptions h
   where h.interval = '1h' and h.created_at < '〔R〕'
     and ((h.rule = 'macdx' and h.pair in ('USD/JPY', 'AUD/USD')) or h.rule = 'stockmacd')
     and not exists (select 1 from public.signal_alert_subscriptions t
                      where t.user_id = h.user_id and t.pair = h.pair and t.rule = h.rule and t.interval = '15min');
  -- '1h' rows of these follows ticked under v41 (every row of these, when step 9 has run)
  insert into public.signal_alert_subscriptions (user_id, pair, interval, rule, lang)
  select user_id, pair, '1h', rule, lang from public.signal_alert_subscriptions
   where interval = '15min'
     and ((rule = 'macdx' and pair in ('USD/JPY', 'AUD/USD')) or rule = 'stockmacd')
  on conflict (user_id, pair, interval, rule) do nothing;
  ```
  Between this and the end of the revert's deploy, v41 still serves the screen, and its ticks and unticks change these
  `'15min'` rows only; so once v40 answers again (T2), they are reconciled once more, the intervals swapped. The bound
  of (b1) is V, the revert merge's time, not T2: before V only v41 serves the screen, and v41's `set` refuses `'1h'` for
  these, so a `'1h'` row of these made before V is an old row or a rebuilt one; v40's `set` serves from the end of the
  revert's deploy, before T2, and a v40 tick that makes a new `'1h'` row then has `created_at` after V and stays. T2 is
  kept as a record only. But a v40 tick that lands on a `'1h'` row that exists already (an old or rebuilt one: the
  all-symbols box resends every offered pair of its column, 3.6) keeps that row's `created_at`, before V (v40's `set`
  and `set_many` send none, and v40's code cannot be changed, 3.6); if that follow's `'15min'` row was unticked under
  v41, (b1) deletes the `'1h'` row against that last tick, and v40 never mails it. (Corrected at the second review: this
  paragraph first said that every v40 tick made then stays.) So (b1) and (b2) are sent as soon as T2 is read, to keep
  that span to minutes.

  ```sql
  -- (b1) '1h' rows made before V (the revert merge's time) whose '15min' row was unticked under v41 after the rebuild
  -- (under v40 again a '15min' row of these can no longer change: v40 refuses '15min')
  delete from public.signal_alert_subscriptions h
   where h.interval = '1h' and h.created_at < '〔V〕'
     and ((h.rule = 'macdx' and h.pair in ('USD/JPY', 'AUD/USD')) or h.rule = 'stockmacd')
     and not exists (select 1 from public.signal_alert_subscriptions t
                      where t.user_id = h.user_id and t.pair = h.pair and t.rule = h.rule and t.interval = '15min');
  -- (b2) '15min' rows of these ticked under v41 after the rebuild
  insert into public.signal_alert_subscriptions (user_id, pair, interval, rule, lang)
  select user_id, pair, '1h', rule, lang from public.signal_alert_subscriptions
   where interval = '15min' and created_at >= '〔R less one minute〕'
     and ((rule = 'macdx' and pair in ('USD/JPY', 'AUD/USD')) or rule = 'stockmacd')
  on conflict (user_id, pair, interval, rule) do nothing;
  ```
  **The limits of (b1) and (b2), written down in docs §8.156 beside (a2)'s (3.6):** (b1) as the paragraph above says (a
  v40 tick on a `'1h'` row that exists already, made before (b1) is sent, can be deleted); (b2), as (a2) mirrored:
  every `'15min'` row whose `created_at` is at or after R − 1 minute (a v41 tick re-stamps an existing row, 3.6) and
  whose `'1h'` row is gone when (b2) is sent gets its `'1h'` row back, even if that `'1h'` row was unticked under v40
  after the revert's deploy, and v40 then mails that follower against the untick (a `'15min'` row ticked under v41 after
  R whose `'1h'` row the follower then ticks and unticks under v40; one ticked in the minute before R, rebuilt at R,
  whose `'1h'` row is unticked once under v40; or an existing `'15min'` row re-ticked under v41 after R, e.g. through
  the 15分 all-symbols box, whose rebuilt `'1h'` row is unticked once under v40). Nothing in the rows shows such an
  untick. (Corrected at the third review: the limit said "created", and the re-ticked row was missing.)
  Then econ-calendar is deployed by name on the reverted code, its run checked as 6.3 step 6 (success, and econ's live
  version or updated time changed), and **only after that, and after the morning check that covers the window's last
  GMO day has run** (with the rollback prompt, 7.3), these `'15min'` rows are deleted (v40 neither reads nor shows them),
  with the owner's confirmation and counted. Before the delete, as 6.3 step 9, a Japanese morning's econ `recipients`
  after the redeploy is compared with a count of A ∪ B1h (3.6). Why the morning check first (added at the third
  review): `pairs-v12` and `stocks-v12` count the current `'15min'` rows as the day's subscriptions
  (back1-v12.part:87, stocks-v12.part:25), so a delete before that run would make every expected entry of the window's
  last days `no_subscription` and a bar mailed to two followers `dup` (back2-v12.part:40, :49; `no_subscription_row`,
  stocks-v12.part:94). Until the delete, v40's test mail lists each `'15min'` row (3.6), for a Friday window to
  Tuesday's run; the span is written down.

  ```sql
  delete from public.signal_alert_subscriptions
   where interval = '15min'
     and ((rule = 'macdx' and pair in ('USD/JPY', 'AUD/USD')) or rule = 'stockmacd');
  ```
  **The order is: reconcile (if not yet sent) → rebuild → revert (V) → T2 → b1 / b2 → econ by name (checked) → the
  morning check of the window's last GMO day → the `'15min'` delete**, each step only once no earlier prompt of the
  statement before it is still open (3.6; added at the fifth review). Deleting while econ still runs the per-pair
  bundle drops people whose only `macdx` rows were USD/JPY or AUD/USD; deploying econ before b1 / b2 drops anyone who
  ticked one of those two between R and T2 and has no other `macdx` row (until b2). The `macdx` rows of
  EUR/JPY, AUD/JPY, EUR/USD and gold are not touched by any of these. A later attempt starts again from 3.6's twins.
- **Triggers.** Revert **at once, whatever the minute**: v41 judges nothing (its runs fail every time), or a deployed
  live-chart does not show bars, or live-chart's second dispatch fails too (6.3 step 5b; corrected at the fifth review:
  "live-chart fails after the deploy", which took in a live-chart not deployed). Revert **in the window above**, on a
  chart with a `macdx` row on the pair's own interval (6.3 step 5; a chart nobody follows is not judged for the fade and is no trigger): USD/JPY or AUD/USD has two
  quarter-hour closes within one hour, each with no read that judged it, or **EUR/JPY, AUD/JPY, EUR/USD or gold has a
  1-hour close that none of v41's reads judged** (v41 changes `fadeAtClose`'s price for them too: 3.2 item 5) — in each
  case no read of that bar has a `fade` record without `error` (a `fade` that ended `failed` or `no_price` judged
  nothing) and its reads' records are not explained by a value 6.3 step 5 calls expected (`market_closed`, `not_yet`,
  `waiting`, `twelve_unavailable`, `day_spent`, `unavailable`, `maintenance`, `short`), in Tokyo's hours or any other
  that the reads of 6.3 steps 5 and 5a cover (every hour from v41's first answer to the end of 5a's Tokyo span, the
  records being read at most about 5 hours apart, 6.3 step 5; after it, only what the morning check shows, 6.3 step 5)
  (the queue of 2.4: the stocks calls' `took_ms` and timeouts read first; no read in the close's minutes, or `deadline`
  on every read, counts against v41, but for a close of EUR/JPY, AUD/JPY or EUR/USD at 01:00, 02:00, 04:00, 05:00 or
  06:00 UTC on a Tokyo trading day whose reads were held only by a stocks call that started in the close's own minutes,
  :00 to :05 (the stocks run's records: its minute, `took_ms`, a timeout): v40's stocks run read every minute then too,
  with no budget (2.4), so a revert to v40 would not cure it; it is written down, not a trigger (added at the fifth
  review); closes whose records expired before any read are not checked and are no trigger, 6.3 step 5); or any pair's
  `macdx` entry ends `no_price` (corrected at the third review: "no `fade` record", which a
  read ending `failed` still leaves, "a quarter-hour close that none of its reads judged twice within one hour", which
  read as one close judged twice, and `no_price` on the 1-hour pairs only);
  or the shares fail on their own (every followed share's reads `yahoo_*`, `bars` below 600, or a New York or Tokyo
  session's bars never `judged`, 6.3 step 5a). Each is written down with its records (docs §8.156) and told to the
  owner.
  **When the owner cannot confirm at once** (added at the fourth review: the reads run by scheduled task at night too,
  6.3 step 5, but the statements before the revert are sent with the owner's confirmation, 3.6): an at-once revert on
  the full path waits for the owner's confirmation of the reconcile (if not yet sent) and the rebuild, and never goes
  before the rebuild (once v40 serves the screen, a v40 tick makes a `'1h'` row with no `'15min'` row, which the
  rebuild's delete would remove). At night it waits until the owner answers. So do (b1) and (b2) after T2, and the
  matching select before (b1)'s delete (3.6): their limits (above: a v40 tick on an existing `'1h'` row deleted by (b1);
  (b2) bringing back a `'1h'` row unticked under v40) grow with every minute from T2 to their send, and that span is
  written in docs §8.156 beside the wait. The session tells the owner at once (a push notification) and writes the wait,
  from the trigger to each confirmation, in docs §8.156; if v41's runs fail every time, no rule's mail goes out
  meanwhile (6.3 step 1a). 6.1's branch (no record says v41, above) does not wait: no statement goes before its revert.
  (Corrected at the fifth review: this offered to ask at the release whether the session may send the reconcile and the
  rebuild alone. Every statement here goes through the connector's prompt to the owner or the owner's SQL Editor, 3.6,
  and nothing in this file gives a way to send one without the owner, so a yes at the release would not have removed
  the prompt; the offer is dropped.)
- Then: section 5's texts came in the function's PR (6.3 step 4), so the revert takes them back too; the reverted main
  is published to Lovable (state reported as given; the grid PR of step 2 stays: against v40 it draws v40's column);
  the Routine's prompt replaced by the rollback prompt (7.3, written and kept ready, 6.1) for the GMO days the window
  touches, and by the v11 prompt from the day after the window (corrected at the third review: this said "the v11
  Routine prompt put back", which sends v11's three statements only and holds no window, so it cannot make the reading
  below). **The v41 window** (from v41's first answer to v40's first answer again, both from the run's records) is
  written down. On the days it touches, v11 reads USD/JPY's and AUD/USD's 1-hour bars from END_1H to v40's first judged
  1-hour bar again as not v11's (the other four charts are v11's throughout, the window included), and `pairs-v12` every
  15-minute bar opened after v41's last judged 15-minute bar as not v12's (7.3; corrected at the fifth review: "inside
  the window" and "after it"). From the day after the window, the five-pair `pairs-v11` again.

## 7. Checks

### 7.1 Tests and static checks

`npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and econ-calendar, and `deno
check` of the morning-check bench (`scripts/morning-check/bench/sim.ts`, `sim11.ts`, `sim12.ts`). Function tests over
fake tables, **each pair on its own chart**:
- **USD/JPY and AUD/USD (`15min`):** a close judged at minutes 0, 1 and 3 (fresh instances): one email a follower, the
  same price (the 15-minute bar's ask or bid close, from `fadeQuotes` under `USD/JPY|15min`); a missing 15-minute quote
  gives `no_price` and the bar is judged again. Not fresh at 21 minutes: nothing; fresh at 19: mailed. The row has
  `interval` `15min`, `closed_at` the open plus 15 minutes and the v12 id.
- **EUR/JPY, AUD/JPY and EUR/USD (`1h`):** a close judged at minutes 0, 3 and 5 under v40's v11 id on `'1h'`, priced
  from `fadeQuotes` under `EUR/JPY|1h`; fresh at 29 minutes, not at 31. A 15-minute read of EUR/JPY (followed under
  another rule, e.g. `emarm`) neither judges the fade nor prices it (`isMacdhChart("EUR/JPY", "15min")` is false; no
  `EUR/JPY|15min` key). A v40 row of the same bar under the v11 id (as at the switch): no second mail (`mailRide`, the
  claim key).
- **Gold (`1h`):** v40's tests (judged from a minute after the close to :29, Twelve Data read at most twice a close).
- **Per pair, the followers and the offer:** a USD/JPY `'15min'` follower is mailed and its `'1h'` row is not; an EUR/JPY
  `'1h'` follower is mailed and a `'15min'` row is not (dropped by the run's filter). The status's `macdx.limited` gives
  each pair its one chart; `set` refuses EUR/JPY on `15min` and USD/JPY on `1h` (400); `set_many` refuses a batch with one
  chart not offered and accepts the 15分 column of USD/JPY and AUD/USD and the 1時間 column of the other four.
- **The ids:** `macdhRuleId("15min")` and `macdhRuleId("1h")` equal the two strings of 3.7; `signalRuleId` gives the
  chart's id for `macdx` and throws for an interval with no version; a code-text pin that no `MACDH_INTERVALS[0]` and no
  `MACDH_RULE_ID` is left in the code of indicators.ts and index.ts (comment lines aside: index.ts's history comments of
  v25 to v40 name `MACDH_RULE_ID` as the record of those versions and stay; the build's reading, 2026-11-19), and that
  `fadeAtClose` holds no interval literal.
- A follower whose lookup failed, mailed at the next judging (a 15-minute pair at minute 1 or 3, a 1-hour pair at 3 or
  5); a row of the other side: nothing, `other_side`.
- **The test mail** (3.6): a follower with a USD/JPY `macdx` row on `'1h'` and its twin on `'15min'`, and a share's two
  rows, gets a list that names only the `'15min'` rows; an EUR/JPY `'1h'` row is listed and an EUR/JPY `'15min'` row is
  not; a row of a rule that is not an indicator rule (e.g. `rsi_sar`) is listed as today; and rows of the other
  indicator rules on their offered charts are listed as today, e.g. an `emarm` row on USD/JPY `'15min'` and a `spike`
  row on USD/JPY `'1h'` (added at the third review: the filter covers all eight indicator rules, HEAD indicators.ts:69,
  and `isIndicatorChartFor` branches per rule, :332-345, so a filter built wrong for them would pass the cases above).
- **The subscription statements** (3.6, 6.4; added at the third review: no test or preview covered them, and the
  reconcile's after-count accepts any result, 3.6): every statement of 3.6 (the twins, (a1), (a2), step 9's delete) and
  of 6.4 (the rebuild's delete and insert, (b1), (b2), the `'15min'` delete) run on a local PostgreSQL holding
  `signal_alert_subscriptions` as the migrations make it (user_id, lang, `created_at` default `now()`,
  20260925120000_signal_alerts.sql:9-18; the unique key `(user_id, pair, interval, rule)`,
  20260925180000_signal_alert_rules.sql:22-24; the later migrations' checks). The morning check's bench cannot serve:
  its table has no user_id, `created_at` or unique key (scripts/morning-check/bench/schema-v11.sql:11). One made-up row
  per case those sections name: a twin; a `'1h'` row unticked under v40 after T0; a `'1h'` row ticked under v40 after T0
  or in the minute before it; a fresh v41 tick; a v41 re-tick through the all-symbols box carrying `created_at`; a v41
  untick of a twin; and rows of the four 1-hour charts, which no statement may touch. And 6.4's own cases, placed after
  R (added at the fourth review: every case above falls before the rollback, and after the rebuild the two sets match,
  so (b1) and (b2) would act only on rows where they change nothing, and one built without `h.created_at < V` or without
  the R − 1 minute bound would pass): a `'15min'` row unticked under v41 between R and V ((b1) deletes its `'1h'` row);
  a `'15min'` row ticked under v41 between R and V, and an existing `'15min'` row re-ticked then ((b2) inserts the
  `'1h'` row); a v40 tick after the revert's deploy that makes a new `'1h'` row, `created_at` after V ((b1) keeps it); a
  v40 tick then on an existing `'1h'` row whose `'15min'` row was unticked under v41 ((b1) deletes it: its documented
  limit, pinned as such); the (b2) limit cases of 6.4; and a run with step 9's delete sent before the rebuild (the
  rebuild's insert brings back a `'1h'` row for every `'15min'` row of the narrowed set). The rows left after each
  statement, and the list each statement reports of its own rows (3.6), are pinned. The literals M, T0, R and V are
  written as ISO 8601 UTC with `Z` (e.g. `'2026-11-24T09:08:00Z'`), in this run and in production. In production each
  delete is first sent as its matching `select rule, pair, interval, created_at` (no user ids) of the rows it would
  remove, read against the cases expected, and only then sent (3.6).
- **The upserts' `created_at`** (3.6): the upsert request of `set` (on) and of `set_many` (on), as the fake fetch
  receives it, holds `created_at` (the run's now) in every row of its body, beside `lang`, with
  `resolution=merge-duplicates` as today.
- **A share:** `CLOSES`, `stockBarEnd` and `stockBarBreak` on 15-minute bars (US, Tokyo lunch, Tokyo close, a US half
  day), from fixtures with the probe's stamps and shapes (made-up prices); a Tokyo bar arriving 15 minutes late: judged at
  the next close's reads and mailed (fresh at 45); a bar overtaken before any read judged it: not judged; read again in
  its window: one email a follower. Tokyo's 11:30 bar (2.4 "Never judged"; added at the fourth review): on the probe's
  shapes (the 11:30 row of one price with volume, null rows 11:45 to 12:15, then the afternoon's rows; made-up prices,
  as the fixture at HEAD src/test/stockmacd-alerts.test.tsx:345-376), a read of the 11:30 close up to 12:00 with Yahoo's last
  trade time at the auction does not take the 11:30 bar as closed, and a read of the 12:45 close once the 12:30 row is
  in takes it as the newest closed bar, not fresh: no entry, no mail. The closing-price texts (3.3 item 6, decided at
  the second review): the mail's sentence and the note's 〔closing〕 absent, ja and en (HEAD pins this today:
  src/test/stockmacd-alerts.test.tsx:402, src/test/signal-alert-settings.test.tsx:1228-1232).
  **Review finding (2):** HEAD pins `stockBarBreak` on New York's 15:45 bar, Tokyo's 11:15 and 15:15 and plain bars
  (src/test/stockmacd-alerts.test.tsx:195-202) but not on a US half day, which the first version of this item asked for.
  The pin: the bar opening 12:45 New York on a half day gives `null` (`stockBarBreak` reads the regular hours, HEAD
  stocks.ts:262-269, so a half day's last bar reads as any other; its close at 13:00 is one of `CLOSES`, HEAD
  stocks.ts:130-132), e.g. `stockBarBreak("AAPL", at("2026-11-27T17:45:00Z"))` is `null` (12:45 New York in its winter
  time; 2026-11-27, the Friday after Thanksgiving, is taken as a half day from NYSE's usual calendar, not checked here;
  the pin needs only a 12:45 bar), with `stockBarEnd` of that bar 13:00 New York, so the mail of that bar says nothing of
  a session's end (`stockmacdNotes` [5]).
  **If 3.3 item 6's parser change is made** (added at the fourth review: no test was named for it; it is in
  live-chart/stocks.ts and shared by the mail and the chart): src/test/stocks.test.tsx, whose `parseYahooChart` cases are
  on `1h`, `5min`, `1min`, `1day` and `1month` only today (:75-171), gains `15min` cases from fixtures of the probe's
  shapes (made-up prices), with Yahoo naming the next session: Tokyo's 15:30 volume-0 last point joins the 15:15 bar, and
  New York's 16:00 joins the 15:45 bar; Tokyo's 11:30 row, with volume and not the answer's last, stays a bar of its own
  (as HEAD src/test/stockmacd-alerts.test.tsx:378-389 pins through `stockBarsOf`); a volume-0 last point exactly one bar
  after the row before at a time that is not a close or lunch time (a forming bar's first print mid-session) stays a bar
  of its own; the bars before the last are unchanged in every case.
- The stocks run's budget (3.3 item 10): with Yahoo reads made slow (a fake fetch), no read starts once 30 seconds have
  passed; the shares left are in `reads` as `skipped: "budget"` and are the first read by the next run; `took_ms` is in
  the summary; with fast reads every followed share is read as today.
- **The measured paragraph:** each run built from its ledger copy and pinned value by value (4.5); `fadeMeasuredLine`
  refuses a chart with no run, `m.tf !== tf` and a pair not measured; the bar's word per chart; the 〔chance〕 branch of
  each chart word for word; 〔mailedOn〕's four texts (two charts, ja and en) word for word, and the three phrases 4.5
  rewrote for the per-pair form (the entry's parenthesis, 〔baseWhat〕, the weekend sentence), the per-pair chance
  sentence right after the pair's sentence (4.5; added at the fifth review), and en's "The measurement
  re-reads GMO's past bars" word for word in both charts' mail and notes versions; the pin of `FADE_MAILED_ON` and of each pair's run to
  `MACDH_INTERVAL_OF` (4.5); `_shared/macd-fade-measured.ts` imports nothing from `signal-alerts/` (the pin at
  src/test/macd-fade.test.ts:185 stays); the 〔open〕 = 0 and 〔tp〕 = 0 variants from summaries made for the test.
- **Each mail variant in ja and en**: a 15-minute pair's BUY and SELL (USD/JPY), a 1-hour pair's BUY and SELL (EUR/JPY),
  gold's, a US and a Tokyo share's, a session's last bar; each pinned to the words of 4.3-4.5 for its chart (gold's
  equals v40's; a 1-hour pair's equals v40's but for item 9, 4.5's `1h` paragraph; a 15-minute pair's items 8 and 10 as
  4.3); 4.1's guards (no text puts the five pairs and gold on one chart); the record's `fade` and tags.
  `renderFadeMail` (through `renderIndicatorMail`) throws for a signal off its pair's chart: gold on `"15min"`, USD/JPY
  on `"1h"`, EUR/JPY on `"15min"` (3.2 item 7).
- **The econ digest's recipients per pair** (src/test/econ-mailer.test.ts): a `macdx` `'15min'` row on USD/JPY or AUD/USD
  makes a recipient and its `'1h'` row does not; a `'1h'` row on EUR/JPY, AUD/JPY, EUR/USD or XAU/USD makes one and a
  `'15min'` row does not; a `stockmacd` row never does.
- The code-text pins: no `"1h"` left in `stockFadeClose`, `stockSweepOf`, `stockBarsOf`, `stockFade`'s `fadeSignal` and
  the share read's URL (each takes its constant).
- **In the app's grid PR** (6.3 step 2): `indicatorChartOffered` with and without `macdx.limited` (without it, the cross
  product as today); the grid with the per-pair map: the two columns, the boxes and the "—" cells as section 5 says, the
  "—" title the new key, the two all-symbols boxes covering two and four pairs; the i18n shape test.
- **The screen's texts, in the function's PR** (6.3 step 4; step 7 is only their publish, 3.5 "Tests, by PR"): the
  notes' two measured paragraphs word for word; the notes and intros of section 5, every item written out there pinned
  word for word in ja and in en (the tests that read this file, 3.5, find each there); the leads with no arrival time;
  the sales page's three texts with the 〔adverse〕 chosen per chart; the forbidden-number patterns of 3.5 (finding (1)
  and the two patterns the review added).

### 7.2 The study check on both charts

research/macdfade-prod-check.ts takes `TF` `1h` or `15min` (4b20d06, the first version's 7.2 built: HEAD :50-52 the
`TF` and the bar's length, :57-58 `LOAD_FROM` and `OUT`, :65 the reads 0/3/5 or 0/1/3, :90 `meta.tf` must be the `TF`).
.github/workflows/macdfade15.yml runs its study-check steps on either and stops the real job unless summary.json is the
chart's run of record (the step "summary.json must be the run of record", HEAD :375-412): on `1h` run 44555599946's
(`d59b64c6…`, and the ledger copy research/ledger/macdfade1h-whole-summary.json byte for byte, :378-394); on `15min` run
44535888012's (`74a4a230…` without the `tf` line, and the ledger copy whole, :395-412). Both restore run 44535888012's
cache last (`gmo-macdfade15-44535888012`, :242-246), so the three GMO 1-minute day files kept short in the branch's caches
are read whole; if that cache is gone (GitHub drops a cache unused for 7 days), both stop. (The first version's "on
`1h`, sha256 `60edab22…` as today" is gone: since e660119 the 1-hour record is run 44555599946's; :379-380's comment that
v40's `FADE_MEASURED` is still run 44099401423's is rewritten in the function PR.)

At the function PR's last commit that touches a file the check runs both are run (6.1, 6.3 step 2a): a `tf` `15min`
dispatch, and a `tf` `1h` run (the
push's, the default `TF`, :82, when that commit touches a push path, :38-62, and the PR's head branch is
claude/app-confirmation-jvmk03, the only branch the push trigger lists, :35-37; otherwise a dispatch). The shipped entry
rule and price function (`fadeCloseEntryAt`, `ridePaidAt`) then equal the study's on each chart. Which chart each pair
is judged and priced on (the per-pair map, `isMacdhChart`, the chart-keyed `fadeQuotes` of 3.2 item 5) is not in this
check: it imports none of them and takes its reads from its own literal (research/macdfade-prod-check.ts:32-41, :65),
so it rests on 7.1's tests (corrected at the third review: this said the shipped function judges each pair's chart as
the study did).

### 7.3 The morning check per pair's chart (README v12, rewritten)

HEAD's v12 (c9259c6) was built for every pair and gold on 15-minute bars. Per pair it changes as follows; nothing of v3
to v11 changes byte for byte (`v3.md5`, `git status`).

**Which statements for which GMO day K:**

| K | USD/JPY, AUD/USD | EUR/JPY, AUD/JPY, EUR/USD | gold | shares |
|---|---|---|---|---|
| before the switch day | `pairs-v11` (five pairs, as now) | the same `pairs-v11` | `gold-v11` | `stocks-v11` |
| the switch day | `pairs-v11` (these two read from END_1H on as not v11's) and `pairs-v12` (these two) | `pairs-v11`, read as any v11 day | `gold-v11`, read as any day | `stocks-v11` and `stocks-v12` |
| after it | `pairs-v12` | **`pairs1h-v11`** (new, below) | `gold-v11` | `stocks-v12` |

`gold-v12` is never sent (gold stays on v11's form until a gold study; its markers, src/syms-gold-v12.part, keep it from
running if sent by mistake). It stays in the repository unchanged, with its bench scenarios, as a record; it is not a
release check.

- **`pairs-v12`: USD/JPY and AUD/USD only.** src/syms-pairs-v12.part:17-19 holds all five pairs; it keeps the two rows
  `('USD_JPY', 'USD/JPY', 1, …)` and `('AUD_USD', 'AUD/USD', 5, …)` as they are and drops the other three. Nothing else
  of the v12 statement changes but the RUN count below, and the pairs-only comments say two pairs (added at the fourth
  review: src/header-pairs-v12.part:1 says "the FIVE PAIRS" and src/syms-pairs-v12.part:1 "FRONT (five pairs)"; both
  parts are pairs-v12's only, src/build.sh:95-96, and the `.min.sql` drops comment lines, src/assemble.py:39-46, so only
  pairs-v12.sql changes by it): every CTE is scoped by `syms` (its files, mails, other rows, `late1h`, `swb`: back1-v12.part:74,
  :87, :88-95 with :92, :99-106, :110-116). For those two, everything it counts stays right: their mails under the v12 id
  on `'15min'` (:74), their `'15min'` `macdx` subscriptions (:87), their other `macdx` rows on `'1h'` or `'15min'`
  (:91: v40's v11 `'1h'` rows of the switch day expected, any later one a finding), `late1h`, the gap and overlap. The
  three 1-hour pairs must not be in it: every 15-minute entry of theirs would be `missing`, and v41's own v11 `'1h'` rows
  would count in `other_macdx_1h_rule_rows` and in `late1h` every day.
- **`pairs1h-v11` (new): EUR/JPY, AUD/JPY and EUR/USD on v11's form.** v11's text is right for them unchanged (v41 writes
  their rows under the v11 id on `'1h'`: back1-v11.part:73, :84, :88; their `live_ms` 1795003200000 as in
  src/syms-pairs-v11.part:12-13). But `pairs-v11` holds all five: run after the switch day, its USD/JPY and AUD/USD rows
  would be `missing` at every 1-hour entry (its statements have a start and no end, README v12.1) and, after step 9,
  `no_subscription` (back2-v11.part:37), a `CHECK` on two charts every morning. So a new build from v11's parts with a
  three-row syms part (EUR_JPY 2, AUD_JPY 3, EUR_USD 4, `live_ms` 1795003200000, decimals 3, 3, 5, as
  syms-pairs-v11.part:12-13), its own header part, and `--sub SQLNAME=pairs1h.sql` (its RUN row says `pairs1h.sql v11`),
  built by build.sh beside v11's lines. No markers: built and merged with v12 before step 4, used from the day after the
  switch. `pairs-v11.*` stay byte for byte (the switch day, a rollback). Its check: on the v11 bench days every SUMMARY and
  LINE row of EUR/JPY, AUD/JPY and EUR/USD equals `pairs-v11`'s (the CTEs are per symbol; only RUN differs), and v11.5's
  structure checks (ASCII, strip, no `;` and no DDL word, `{{START_MS}}` / `{{END_MS}}` once).
- **`gold-v11`** unchanged, every day: v41 judges gold as v40 (the same id and chart), so gold has no switch day.
- **`stocks-v12`** as HEAD's (the shares move as the first version said).
- **A blind spot closed:** a stray `'15min'` `macdx` row on EUR/JPY, AUD/JPY, EUR/USD or gold (v41 judging a chart that is
  not the pair's) would be read by no statement (`pairs-v12`'s `syms` holds two pairs; v11's other rows read `'1h'` only,
  back1-v11.part:88; README v11.7 states that limit for v11). So `pairs-v12`'s RUN row gains a count,
  `macdx_15min_rows_other_pairs` (the day's `signal_alerts` rows with `kind = 'signal'`, `interval = '15min'`, `rule
  like 'macdx%'` and a pair not in its `syms`), a finding when above 0; a scenario of the bench pins it. **Where it
  goes** (added at the third review: back2-v12.part, which holds the RUN row, :143-144, is the same text in `pairs-v12`
  and `gold-v12`, its line 1 and build.sh:95-98, so a count written into it would change `gold-v12` too, and there
  count every USD/JPY and AUD/USD row): through a slot in the RUN row that build.sh fills per file with `--sub`
  (assemble.py replaces every `{{NAME}}`), the count's field for `pairs-v12` and an empty string for `gold-v12`, placed
  so that `gold-v12.sql` and `gold-v12.min.sql` stay byte for byte (their md5 checked unchanged in v12.5).
- **The bench (README v12.4) is redone for two pairs.** bench/check12.py compares every simulated entry, and sim12.ts and
  gen12.py hold the five pairs and gold. **In the pairs' run, sim12.ts's followers and the rows it writes narrow to
  USD/JPY and AUD/USD** (gen12.py may keep the five; check12.py then compares those two pairs' lines; the gold run of
  sim12.ts stays as it is). Narrowing only the comparison would not do (corrected at the second review): sim12.ts writes
  `'15min'` subscriptions and `signal_alerts` rows under the v12 id for every pair it follows (bench/sim12.ts:22, :24,
  :49, :89-96), run12.sh loads them into mc12p (run12.sh:26-29), the database scen12.py uses for the pairs (scen12.py:23),
  so the new `macdx_15min_rows_other_pairs` (above) would be above 0 on every clean bench day and its scenario would
  have no zero to start from. With the narrowed simulation a clean bench day shows 0, and the scenario pins 0 → 1.
  bench/scen12.py: the switch-day scenarios use `SP = "EUR/JPY"` (:267), which no longer switches, so `SP` becomes `"AUD/USD"`; the picks `pair != "USD/JPY"` (:77-79) take AUD/USD; a scenario for the new RUN count;
  the counts of README v12.4 (2,194 lines, 1,618 ok, the 27 teeth) and the structure check's "five times each in the
  pairs' files" (README :102) become the two-pair build's. **The weekend scenarios must still run** (added at the fifth
  review): p33 and p34 run only when the first seed has a `weekend_window` entry of a pair other than USD/JPY
  (scen12.py:85, `if PW:` :318) and p37 only when it has an entry on a Friday bar opened 20:00 to 20:30 (`PF`, `if PF:`
  :324-326); a skipped scenario is no failure (scen12.py exits 1 only on a FAIL, :421) and teeth12.py prints
  `NOT CAUGHT` with no exit code (:103-105), while README :99 says two of the 27 teeth (the weekend window an hour later,
  and the close time an hour after the open in the weekend window, "caught by p37 only") were caught only by these
  scenarios on seed 1 (run12.sh hands seed 1 to both by default). With the simulation cut to USD/JPY and AUD/USD, seed 1
  has neither kind (the review's port, and its run of the real sim12.ts on seeds 1 and 3; not run by this writer). So
  scen12.py fails, not skips, when `PW` or `PF` is missing; teeth12.py exits 1 when a change is not caught; the first
  seed is one whose two-pair walk has both kinds, confirmed with the real sim12.ts (by the review's port seeds 3, 5 and 7
  do; the build found that scenario p21 also needs, on the switch day, an entry before LIVE and one from it, which seed 3
  lacks — a run with seed 3 first gave 68 of 69 — so run12.sh's first seed is 5; seeds 5 and 7 meet all three cases), or
  fixture rows give the two cases; and the README's two-pair counts are written only once p33, p34 and p37 run
  and all 27 changes are caught. The gold half of check12 and teeth12 may stay in run12.sh (its text is unchanged) but
  is not a release check.
- **Review finding (4):** README v12.4 (:98) says "The five pairs (37)" and "The shares (`stocks-v12`, 17": scen12.py
  holds 68 `scen("` calls, pairs 38 (p00 to p37), gold 14 (g00 to g13), shares 16 (s00 to s15) (counted by this writer
  with grep). So the record of the five-pair bench of 2026-11-19 is corrected to "(38)" and "16" (the total 68 and gold's
  14 are right), and the two-pair bench's numbers are written beside it as they come.
- **The go-live constants** (`live_ms`, `end_1h_ms`): only in USD/JPY's and AUD/USD's rows of src/syms-pairs-v12.part,
  set at the release from the run's records (6.2, 6.3 step 8). With a first answer from H:06 to H:18, `live_ms` is H:00
  and `end_1h_ms` H:00 for both.
- **The switch day's reading** (README v12.1, rewritten):
  - `pairs-v11`: every LINE of USD/JPY or AUD/USD of a 1-hour bar opened at or after `end_1h_ms` is not v11's (a
    `missing` there, and a SUMMARY `CHECK` with `missing=N` from those lines only, is not an error); their lines before it,
    and every line of EUR/JPY, AUD/JPY and EUR/USD, are read as on any v11 day. **Review finding (3):** if USD/JPY's or
    AUD/USD's 1-hour day file of the switch day is not stored (only something that still reads that 1-hour chart after
    the day ends stores it: the sharp-rise email's followers or the live chart; who does is not known here),
    `pairs-v11` answers `NO_DATA` for that pair and day (guard-pairs.part:51-52, :55, counting only the files of the
    day's key, head.part:8-9). Then **none of the day's v40 bars of that pair is recounted**: the whole GMO day from 21:00
    UTC of the day before to `end_1h_ms`, not only the last bars; its mails of the day are `unchecked`
    (back2-v11.part:48), and the SUMMARY's verdict is `NO_DATA` (:76). (README :41 says "v40's last bars are not
    checked": too narrow; it is corrected.) EUR/JPY's, AUD/JPY's and EUR/USD's 1-hour files keep being stored (v41 reads
    those charts, and the sweep keeps an ended file when it reads one), so this does not reach them.
  - `gold-v11` has no switch reading now. **Review finding (3), gold's half:** README :146 (the prompt) tells the reader
    to write, when `gold-v11` answers `STALE_ROW`, that v40's last bars could not be checked. That is wrong: `STALE_ROW`
    (guard-gold.part:29) still recounts every bar the stored row holds, and only bars after the row's newest closed bar
    cannot be told "no fire" from "not read yet" (guard-gold.part:35-37); README :41's gold sentence says so rightly.
    Under per pair the clause leaves the switch-day reading, and `STALE_ROW` keeps its everyday meaning.
  - `pairs-v12` (two pairs): bars before `live_ms` are `before_go_live`; `other_macdx_1h_rule_rows` (v40's 1-hour rows of
    the day) expected while `macdx_1h_rows_after_end_1h` is absent; `switch_overlap_bars` can only come from a first answer
    at H:01 to H:03 (6.2), no longer from gold; `switch_gap_bars` from one at H:00 (three bars), at H:01 to H:03 when
    v40's H:00 read did not judge the hour, at any minute from H:04 on when none of v40's reads of the H:00 close judged
    the hour (four bars; added at the third review), or after H:18 (6.2); `history_files_missing` as HEAD's README says.
  - `stocks-v11` / `stocks-v12`: as HEAD's README says.
- **The Routine's switch-day prompt** (README v12.6, rewritten; Japanese; the values in 〔…〕 at the release). What
  changes against HEAD's text (README :127-152):
  - The title: 「毎朝の照合（MACD の逆張り・USD/JPY と AUD/USD を1時間足から15分足へ切り替える前後の版・EUR/JPY・AUD/JPY・EUR/USD と
    金は1時間足のまま・株は15分足へ・火〜土）」.
  - The values: END_1H and LIVE 「USD/JPY と AUD/USD で違えば銘柄ごと」 (not 「5ペアと金で」).
  - Step 2: K が K_SWITCH より前: pairs-v11.min.sql、gold-v11.min.sql、stocks-v11.min.sql。K = K_SWITCH: その3つと、
    pairs-v12.min.sql、stocks-v12.min.sql。K が K_SWITCH より後: pairs1h-v11.min.sql、gold-v11.min.sql、pairs-v12.min.sql、
    stocks-v12.min.sql。「gold-v12.min.sql は、どの日も送らない。」 The marker rule for `pairs-v12` only.
  - Step 4, the v11 bullet: 「v11 の答え: USD/JPY と AUD/USD の行で、bar_open_utc が END_1H 以後の1時間足の行は、v11 のものでは
    ない（v40 はもう判定していない）。そこの missing と、それだけから来る SUMMARY の CHECK（missing=N）は、誤りとして扱わない。
    END_1H より前の足の行と、EUR/JPY・AUD/JPY・EUR/USD の行は、いつもの v11 の日と同じに読む（この3ペアは v41 も同じ ID・1時間足で
    判定するので、切り替えはない）。gold-v11 も、いつもの日と同じに読む。stocks-v11 の other_stockmacd_rule_rows（v41 の15分足の
    株の行）は、切り替えの日は予定どおり。stocks-v11 の RUN の stockmacd_subscriptions_not_1h（切り替えの前に入れた '15min' の
    購読）も、切り替えの日は予定どおり。USD/JPY か AUD/USD の切り替えの日の1時間足のファイルが保存されておらず、pairs-v11 が
    その銘柄で NO_DATA になった時は、そう書き、その銘柄のその日の v40 の足は、END_1H より前の足も含めて1本も数え直していない
    （その日のメールの行は unchecked になる）と書く。」 (stocks-v11's RUN field `stockmacd_subscriptions_not_1h`,
    scripts/morning-check/src/stocks-v11.part:113, counts the `'15min'` share twins of step 3; README :215 calls such
    rows "mailed by neither version", which is not so under v41: the README line is corrected with v12's.)
  - Step 4, the v12 bullet: 「switch_gap_bars（どちらの形でも判定されなかった15分足の本数。v41 が最初に答えたのが毎時0分の
    時〈3本〉、毎時1〜3分で v40 の0分の読み込みが判定しなかった時、毎時4分以後で、毎時0分に確定した1時間足を v40 がどの読み込みでも判定しなかった時〈4本〉、毎時18分より後の時に、USD/JPY と AUD/USD で起こりうる）」 and
    「switch_overlap_bars（両方で判定された15分足の本数。v41 が最初に答えたのが毎時1〜3分の時に、USD/JPY と AUD/USD で
    起こりうる）」 (corrected at the second review: 「毎時0〜3分」 before; 6.2); and 「macdx_15min_rows_other_pairs は、どの日でも 0 でなければ見つけたこととして報告
    する（ほかのペアの15分足の行）。」
  - Step 5, its condition: 「pairs-v12 を送らなかった日（手順 2 の印が残っている、または 1回で送れなかった）」 (in place
    of HEAD's 「pairs-v12 と gold-v12 を送らなかった日（…）」, README :150; gold-v12 is never sent and its markers stay,
    so with gold-v12 left in, the condition would read as met every day and every report would carry the sentence below,
    even on days when pairs-v12 ran and recounted those bars; corrected at the second review). Step 5, the interim
    sentence: 「USD/JPY と AUD/USD の新しい形（15分足・確定96%・逆張り）の判定は数え直していません」 (in place of HEAD's
    「新しい形（15分足・確定96%・逆張り）の判定は数え直していません」); the shares' sentence as HEAD's.
  - It was written without reading the v11 prompt (the Routine's prompts are not in the repository): whoever puts it in
    compares it with the v11 prompt first, as HEAD's README says.
- **The Routine's rollback prompt** (new, README v12.6; Japanese; written now beside the switch-day prompt and kept
  ready, 6.1; its values in 〔…〕 at a rollback, 6.4). Added at the third review: 6.4 said "the v11 Routine prompt put
  back", which sends v11's three statements only and holds no window, and the switch-day prompt cannot serve, for after
  K_SWITCH it sends v12's statements only and holds no window end (README :142). What it holds:
  - The values, for each of USD/JPY and AUD/USD, from the run's records (6.2, 6.4): END_1H and LIVE as the switch-day
    prompt holds them (`end_1h_ms`, the end of the last 1-hour bar v40 judged before the switch; `live_ms`, the open of
    v41's first judged 15-minute bar); v41's last judged 15-minute bar; v40's first judged 1-hour bar again; K_SWITCH;
    and the GMO day keys the window touches. (Corrected at the fifth review: the values were only the window's start,
    v41's first judged 15-minute bar, and its end, v40's first judged 1-hour bar again.)
  - Step 2, per GMO day K: on a day the window touches, `pairs-v11`, `gold-v11`, `stocks-v11`, `pairs-v12` and
    `stocks-v12`; after the window, v11's three only (the five-pair `pairs-v11`, 6.4).
  - The readings: `pairs-v11`'s USD/JPY and AUD/USD lines of 1-hour bars opened at or after END_1H and before v40's
    first judged 1-hour bar again are not v11's (a `missing` there, and a SUMMARY `CHECK` from those lines only, is not
    an error; read from END_1H, not from v41's first judged 15-minute bar: in 6.2's four-bar gap the 1-hour bar before
    LIVE was judged by neither version; corrected at the fifth review); the other three pairs' lines and gold's as on any
    v11 day. `pairs-v12`'s lines of 15-minute bars opened after v41's last judged 15-minute bar are not v12's (`missing`
    there is expected: its statements have a start and no end; corrected at the fifth review: "after the window's end",
    read against v40's first judged 1-hour bar again, left the bar opened at H:00, which v41 never judged, 6.4, as
    v12's); `macdx_1h_rows_after_end_1h` and `other_macdx_1h_rule_rows` from v40's 1-hour rows after the window are
    expected (README :45), and on a day that holds both kinds, v40's 1-hour rows before END_1H in
    `other_macdx_1h_rule_rows` too; `stocks-v11`'s `other_stockmacd_rule_rows` (v41's 15-minute share rows) and
    `stocks-v12`'s (v40's 1-hour share rows) on the window's days are expected, and so are both RUN subscription counts,
    `stocks-v11`'s `stockmacd_subscriptions_not_1h` (the `'15min'` share rows, stocks-v11.part:113) and `stocks-v12`'s
    `stockmacd_subscriptions_not_15min` (the `'1h'` share rows 6.4 rebuilt, stocks-v12.part:114), on every day the
    prompt runs: both sets exist from the rebuild to 6.4's `'15min'` delete, which waits for the window's last day's run
    (added at the fifth review).
  - **K_SWITCH, when the window holds it and the switch-day prompt has not read it** (a revert before the first 00:16
    UTC run after the switch; added at the fifth review): K_SWITCH is also read with the switch-day prompt's step 4
    readings ("The switch day's reading" above): bars before LIVE `before_go_live`; `switch_gap_bars` and
    `switch_overlap_bars` told; `history_files_missing` expected; `pairs-v11` answering `NO_DATA` for a pair whose
    1-hour day file of the day is not stored, said as that prompt says it; `stocks-v11`'s RUN
    `stockmacd_subscriptions_not_1h` expected; `pairs-v12`'s `other_macdx_1h_rule_rows` (v40's rows of the day) expected
    while `macdx_1h_rows_after_end_1h` is absent, as on the switch day (added at the build, 2026-11-19).
  - The switch-day prompt's step 5 sentence for any day a v12 statement was not sent.
  - The `'15min'` delete of 6.4 waits for the run of the window's last GMO day (6.4).
- **The 15-minute files:** as the first version said, for USD/JPY and AUD/USD only: the sweep stores each ended 15-minute
  GMO day file it reads; since v33 only other rules' 15-minute followers and the live chart's reads stored them, so days
  may be missing before v41's first read, and `history_files_missing` is expected on the switch day.
- README: the v12 section's title and lead (README :1, :3, :11-17: "the five pairs, gold and the shares" becomes the
  per-pair form), v12.1 to v12.7 as above (README :42's "after step 9 it should be 0" gains "unless a rollback has
  rebuilt the `'1h'` share rows: then expected until 6.4's `'15min'` delete", and :45's window is read as the rollback
  prompt reads it; added at the fifth review), §10's constants and §12's rebuild (`pairs1h-v11`), build.sh's lines; v12.5's
  md5 for the changed `pairs-v12` and the new `pairs1h-v11` files, and `gold-v12`'s checked unchanged.

## 8. Not measured, not checked

(After the release, 2026-11-20: the timed reads of 3.3 were made. What they showed of New York's close and Tokyo's lunch
and close is in 3.3 "Seen in the timed reads"; the items below that call those "not yet seen" are answered there, but
for when the day before's closing row leaves Yahoo's answer.)

- **Measured, now in this file:** the five pairs' numbers of this form on both charts (the 15-minute run 44535888012 and
  the 1-hour run 44555599946, both on GMO's whole files; their summary.json in research/ledger/), and the per-pair
  comparison the owner's choice rests on (research/macdfade15-spec.md :557-589). On 15-minute bars the fade did worse a
  trade than no signal (−0.91, below ten walks' range) and than the other way (−0.78, inside); on 1-hour bars about the
  same as no signal (+0.05) and above the other way (+5.34), both inside. Ten walks give a range, not a test. Every pair's
  win-rate gap between the charts is within chance (Fisher p 0.51..1.00). The bars in the weekend gate, recounted at the
  fifth review from the two ledger copies (2.4 "Never judged"): 149 a pair on 1-hour bars and 152 on 15-minute bars over
  149 Fridays, so one a week in both seasons; the 15-minute run's 3 more not identified, gold's not counted.
- **In the repository:** both summary.json files. **Not:** their null.json and rows.csv (their sha256 are recorded in
  research/macdfade15-spec.md :475-481, :534-540).
- **Not measured:**
  - Gold and the shares with this form (the study has no bid and ask minutes for them). Gold on 15-minute against 1-hour
    bars: waits for a gold study (the owner's answer).
  - A total of only the pairs mailed on one chart, with its medians and its walks' range (4.5: not in either summary).
  - The shares' 15-minute bars as Yahoo gives them: the rows of `15m` over `60d` (600 closed bars are assumed to fit:
    about 39-41 US and 36 or more Tokyo sessions in 60 calendar days, a calendar count, not read). The rows' stamps and
    the closing and lunch rows' shapes were seen (3.3 "Seen", runs 44535921376, 44536526466, 44538415663: Tokyo's
    afternoon stamps 12:30 to 15:15 among them); not yet seen is when the closing and 11:30 rows appear and whether the
    latest session's closing row stays while the next session trades (3.3 "Not yet seen"). (Corrected at the second
    review: this item first listed Tokyo's afternoon stamps and the closing and lunch points as not measured.)
  - The Tokyo delay's effect on 15-minute mails: when a Tokyo mail goes out (counted at about 16 minutes after the close
    from the 2026-11-06 delay), how often a Tokyo bar is overtaken before it is judged, the delay on any day but
    2026-11-06.
  - Yahoo's limits at the new rate. Counted from the code (all 22 shares followed, a run every minute): about 1,600 to
    4,700 reads a day on 1-hour bars and about 4,900 to 8,300 on 15-minute bars; whether Yahoo refuses (429) at the new
    rate: not measured. Without a budget (v40's loop, 2.4) a run of 14 Tokyo reads at a 10-second timeout each could
    pass the 120-second call timeout (supabase/migrations/20261031160100_stockmacd_sweep.sql:22); v41's budget starts no
    read once 30 seconds have passed (3.3 item 10; HEAD stocks.ts:144, index.ts:1629-1630), so a v41 run is about 30
    seconds, plus one 10-second read, plus the mails of the bars judged. How long real calls take: not measured
    (corrected at the second review: this item first stated the 14-read case without saying it is v40's).
  - How long the stocks calls take, and so how often they hold up the other calls: pg_net here sends one call at a time
    (docs §8.112), so a long stocks call delays the next calls and can make a quarter hour's three reads of USD/JPY and
    AUD/USD, an hour's three reads of the 1-hour pairs, or gold's minutes all miss (2.4). v41 bounds the stocks run at
    about 30 seconds of reads (3.3 item 10); the calls' lengths are not measured, and the first Tokyo session is watched
    for it (6.3 step 5a). How long the indicators run takes with two charts: not measured (counted, 2.4: the `macdx`
    charts add no minute heavier than v40's; with other rules' followers minutes 0 and 3 can carry up to 2 more GMO chart
    reads than v40).
  - The minutes between a close and the mail, and the price's move in them; how often a close is not judged.
  - Whether 12 calendar days hold 600 GMO 15-minute bars of USD/JPY and AUD/USD over Christmas and New Year.
- **Not checked:**
  - Yahoo's 15-minute answer around a close and through the next session (3.3 "Not yet seen"), and so whether 3.3 item
    6's parser change is needed for the stray closing points. The closing-price sentences are removed (3.3 item 6: on
    the shapes seen they cannot hold at Tokyo's 11:15 bar).
  - That Tokyo's 11:30 bar is never mailed (2.4 "Never judged", `stockmacdNotes` [2]): counted from HEAD's code; Yahoo's
    answer in the lunch break, and its regularMarketTime then, not yet seen (3.3 "Not yet seen"). (Added at the fourth
    review.)
  - Which rows will be ticked or unticked between the twins and v41's first answer, or under v41 before a rollback (3.6
    and 6.4 reconcile them for USD/JPY, AUD/USD and the shares; the counts are read then).
  - Whether a re-run of either study on the branch gives its run of record (7.2 stops if not; both rest on run
    44535888012's cache, which GitHub drops after 7 days unused).
  - Why no fade or flow trade moved in the 1-hour re-run (research/macdfade15-spec.md :528-529 says it was not looked
    into).
  - Whether production's GMO bars equal the study's loader's (the study check ties the shipped function to the study on
    the study's files only).
  - Who follows which chart, how many `macdx` / `stockmacd` rows there are on which interval, and whether any `'15min'`
    `macdx` row exists today on the four 1-hour charts (production not read); which 15-minute GMO day files of USD/JPY
    and AUD/USD are stored today; whether anything keeps storing USD/JPY's and AUD/USD's 1-hour day files after the
    switch.
  - Whether a v40 gold mail has been looked at in production since 2026-11-18 (notes [2]'s wording, section 5).
  - The grid with the per-pair map, and the 12-box grid of an old bundle: read from the code, the app not run.
  - The Routine's prompt; Lovable's live state; how long v41's deploy will take (6.2).
  - The subscription statements of 3.6 and 6.4: run nowhere yet (7.1's local run is still to come; the bench's table
    cannot hold them, scripts/morning-check/bench/schema-v11.sql:11). The rollback prompt (7.3): its contents are listed,
    its text not written. The `--sub` slot of 7.3's new RUN count: not tried. Whether the Supabase connector asks the
    owner before a read-only query (6.3 step 5): not known. (Added at the third review.)
  - econ-calendar/index.ts: not read by any writer of this file (added at the fourth review). So (a) whether it reads a
    subscription's `created_at` is not known: 3.6's `created_at` in every rule's upserts rests on "nothing else reads
    it", a grep that left that file out (econ-calendar/mailer.ts:82 selects no `created_at`, checked at this review);
    and (b) whether the econ run's record (`net._http_response`) carries `mailDigests`' `recipients`
    (econ-calendar/mailer.ts:95-107 builds it) is not known; docs/OPERATIONS.md shows no such record (no match for
    `recipients` or `mailDigests`). 6.3 step 9 and 6.4's `'15min'` delete wait on that count. The build reads the file;
    if the record lacks the count, this file says how step 9 and 6.4 get it before either delete is sent.
  - The answers of 2026-11-19 in the owner's own words: the per-pair words above are verbatim as relayed by the
    workflow; the dialog's two answers and the earlier "Scope: all" were relayed, the dialog not seen here.
- **Read by this writer for the per-pair revision** (on e660119, 2026-11-19): this file whole; research/macdfade15-spec.md
  :440-599; HEAD indicators.ts :160-240, :270-360, :675, :684, :712-735, :1045-1075, :1125-1160, :1176-1188, :1225-1240,
  :1440-1530; HEAD index.ts :364-395, :636-760, :782-815, :905-1045, :1150-1192, :2094-2230 and single lines found by grep;
  9ca2054 indicators.ts's `renderFadeMail` items 8 to 10 and v40's i18n `macdxNotes` [0]-[2], [10]-[12] (ja and en); HEAD
  macd-fade-measured.ts :1-35, :70-180, :218-360; HEAD macd-fade.ts :1-6, :20-48; HEAD stocks.ts :118-175, :255-275;
  econ-calendar/mailer.ts :10-14, :76-100; supabase/migrations/20260925180000_signal_alert_rules.sql :18-34;
  deploy-functions.yml :18-30, :60-80; macdfade15.yml :30-62, :228-275, :370-412; research/macdfade-prod-check.ts's `TF`
  lines; src/lib/signalAlerts.ts :33-37, :48, :70-75, :155-163, :278-326; src/components/SignalAlertSettings.tsx :224-284;
  HEAD ja.ts and en.ts lines of section 5; the test lines of 3.5 and 7.1 (grep and short reads); scripts/morning-check
  README.md :1-45, :90-170 and the part lines of 7.3; scen12.py :74-82 and its `scen("` count. The four map notes of
  this workflow were used as leads; each fact taken from them and written here was checked in the files above.
- **Run by this writer:** `git log`, `git status`, `git diff --stat`; `sha256sum` and `wc -c` of the two ledger copies;
  python reading their values (the tables of section 1 and 4.5, the gaps); a node check of the three ids against copies
  of the app's regexes; a python check of the two forbidden-number patterns against the sales-page texts and notes [7];
  greps. Nothing else: no test, no app, no function, no study, no workflow, no production, no outside service, no
  connector.
- **At the review (2026-11-19), read and run to check each finding:** HEAD index.ts :393, :728-760, :778-790, :850-860,
  :965-982, :1000-1010, :1036-1050, :1060-1215, :1615-1640, :2126-2160, :2170-2205 (grep), :2205-2235; HEAD indicators.ts :350-358,
  :1125-1160, :1454-1516; HEAD stocks.ts lines of 3.3's lead (grep and single lines); HEAD macd-fade-measured.ts
  :181-217; the test lines named in 3.5 (grep and short reads); .github/workflows/macdfade15.yml :30-90;
  scripts/morning-check/src/stocks-v11.part :105-118 and README :41-43, :146-149, :210-218; docs/OPERATIONS.md §8.155
  (grep: #281 and the screen's texts, :13000-13007); research/macdfade1h-prod-spec.md :600-720 and :775-832;
  research/macdfade15-spec.md :176-190 and :570-580; this file at a964994 (copied from it in section 5). Run: python on
  the two ledger copies (per-pair trades, means, minutes, the rounding of the durations), the four forbidden-number
  patterns on HEAD's `lp` and notes and on section 5's texts, a simulation of the three test files' reads of this file
  (the joins they use, the regex of `stockmacdNotes` [2], the clauses, `FADE_ID`, `honestBody`); no test, no build, no
  production.
- **At the third review (2026-11-19), read and run to check each finding** (on e660119, this file in the working tree):
  HEAD index.ts :535-560, :660-700, :736-760, :790-815, :924-936, :950-1050, :1160-1215, :2215-2226 and single lines
  found by grep; 9ca2054 index.ts's `hourQuotes` lines (grep); HEAD indicators.ts :69-72, :314-346, :1580-1592; HEAD
  and 9ca2054 stocks.ts's owner sentence (:342, :366; :302, :326) and a964994's copy of this file (grep); HEAD
  macd-fade-measured.ts :301 (grep), :320-330; src/test/signal-alert-settings.test.tsx :1195-1230 and the test lines
  of 4.4 item 10 (grep); src/components/SignalAlertSettings.tsx :224-260; econ-calendar/mailer.ts :1-14, :76-110;
  .github/workflows/deploy-functions.yml :1-100; scripts/morning-check README.md :40-46, :118-152, src/build.sh :90-100,
  src/assemble.py (grep of `--sub`), back1-v11.part :82-85, back1-v12.part :84-117, back2-v11.part :44-49,
  back2-v12.part :1, :36-52, :140-146, stocks-v11.part :92-95, stocks-v12.part :23-26, :92-95, bench/schema-v11.sql
  :9-13; supabase/migrations/20260925120000_signal_alerts.sql :9-18 and 20260925180000_signal_alert_rules.sql :18-26;
  research/macdfade-prod-check.ts :20-66. Run: `git show`, `git diff --stat`, `grep`, `sed`, and python to make the
  edits. No test, no build, no production, no connector.
- **At the fourth review (2026-11-19), read and run to check each finding** (HEAD e1faa2e, whose code equals e660119's;
  this file in the working tree): HEAD index.ts :775-790, :1565-1580, :1650-1685, :1860-1882, :2126-2136, :2168-2176 and
  single lines found by grep (:1600, :1625, :1676); HEAD stocks.ts :100-275; live-chart/stocks.ts :95-110, :130-168;
  _shared/market-hours.ts :30-45; econ-calendar/mailer.ts :76-110; .github/workflows/deploy-functions.yml :1-88; HEAD
  ja.ts :2189-2193 and en.ts :2084-2088, 9ca2054 en.ts :2086; src/test/signal-alert-settings.test.tsx :1025-1029, :1050-1063 and
  grep of the `stockmacdNotes` [2] pins; src/test/stockmacd-alerts.test.tsx :328-405 and greps; src/test/stocks.test.tsx
  (grep of `parseYahooChart`); scripts/morning-check/src/header-pairs-v12.part:1-2, syms-pairs-v12.part:1-2, build.sh
  :90-100, assemble.py :36-48; docs/OPERATIONS.md (grep: `recipients`, `mailDigests`). Run: `git log`, `git status`,
  `git diff`, `grep`, `sed`, and a python check of the tests' reads of section 5's [2] (the regexes of 3.5, the pins
  :403-404, the forbidden-number patterns). econ-calendar/index.ts not read. No test, no build, no database, no
  production, no connector.
- **At the fifth review (2026-11-19), read and run to check each finding** (HEAD e1faa2e; this file in the working
  tree): 9ca2054 stocks.ts :95-135 and index.ts :1540-1600; HEAD stocks.ts :120-160, :340-344, :364-368; HEAD
  index.ts :1615-1640, :1835-1876, :2047-2092 (grep and short reads), :2126, :2231-2233; HEAD indicators.ts
  :1045-1075; HEAD macd-fade-measured.ts :228-248, :308-342; _shared/market-hours.ts :1-60, :140-160;
  docs/OPERATIONS.md :12312-12320; research/macdfade15-spec.md :120-150, :172-186, :544-556, :577-590; 9ca2054 ja.ts
  :2151-2152 / en.ts :2046-2047; src/test/signal-alert-settings.test.tsx :596-606 and greps of the 4.4 item 10 pins;
  .github/workflows/deploy-functions.yml :1-90; .github/workflows/macdfade15.yml :30-100, :180-190;
  research/macdfade-prod-check.ts :28-45; scripts/morning-check README.md :40-46, :95-99, :351, :353,
  src/stocks-v11.part:113, src/stocks-v12.part:114, bench/scen12.py :75-86, :315-330, :415-421, bench/teeth12.py (grep),
  bench/run12.sh :1-45. Run: python on the two ledger copies (`judged`, `baseEntries`, `noMinute`, the pairs' means),
  a count of the Fridays in the study's period (zoneinfo), the import graph of research/macdfade-prod-check.ts (relative
  imports), the fourth forbidden-number pattern on HEAD's ja.ts and en.ts and on section 5; `git show`, `git status`,
  `grep`, `sed`. Not run: gen12.py, sim12.ts or any bench (the two-pair seed claims of 7.3 are the review's); no test, no
  build, no database, no production, no connector.

## Questions for the owner

One open from this revision, question 2 below (corrected at the fifth review: this said none, though 2.4 named Tokyo's
11:30 bar as the owner's choice, not asked). The choices this file makes itself, and why, are in 4.5 (each mail shows
its own chart's five-pair numbers and names the pairs mailed on that chart) and 4.1 / section 5 (the texts say the
owner chose each pair's timeframe and give no reason, since a reason would need every pair's numbers on both charts and
the finding that every gap is within chance beside it). (The fourth review's offer, to ask at the release whether the
session may send the reconcile and the rebuild alone in an at-once rollback, is dropped, 6.4, so it is not a question.)

1. **(Asked 2026-11-19 with the first 15-minute run's numbers; answered by the per-pair decision of section 1.)** The
   question said the 15-minute numbers were worse than the 1-hour ones (15-minute fade +2.41 a trade against no signal
   +3.31 and the other way +3.19, the gap −0.90 below the walks' range; 1-hour +3.26 against +3.20). The re-runs on whole
   GMO files moved no signal to +3.32 (15-minute) and +3.21 (1-hour) and the gaps to −0.91 and +0.05; the rest is the
   same. The owner then chose each pair's chart by the higher win rate (section 1). As put to the owner (Japanese,
   CLAUDE.md; the first run's numbers, kept as asked):
   「15分足の数字は、1時間足より悪い数字でした。15分足で測ると、MACD の逆張り（5ペア、2024年1月1日〜2026年11月10日 21:00 UTC に確定した足、スプレッド込み、+10 pips で利確・損切りなし）は、合図が6,006回、うち5,926回が +10 pips に届き、1回あたり平均 +2.41 pips でした。届かずに残った取引は80回で、その含み損益は合わせて -44,784.5 pips、いちばん悪いもので -1,913.4 pips、いちばん長いもので約666日持ったままでした。途中の含み損は中央値 11.9 pips、最大 2,975.8 pips。+10 pips に届くまでの時間は中央値 約2時間、10回に1回は約4日より長く、いちばん長いもので約545日でした。足の終値で入るので、入らなかった注文は0回です。損切りをしないので、+10 pips に届く割合は作りの上で高く出ます。合図なしで入ると1回あたり +3.31 pips、同じ合図で逆向きに入ると +3.19 pips でした。向き別では、売り（上の端）が1回あたり -1.35 pips、買い（下の端）が +6.29 pips でした。合図なしとの差（-0.90 pips）は、作り物の値段10本で出た幅より下でした。確かめ〈検定〉ではありませんが、悪い側を指しています。1時間足では、合図なしとほぼ同じでした（+3.26 pips と +3.20 pips）。メールと画面には、これをそのまま書きます。この仕様は、言われたとおり15分足で進めます。この数字を見て、1時間足のままにしたい場合は教えてください。」

2. **Tokyo's 11:30 bar (open; added at the fifth review).** 2.4 "Never judged": on 15-minute bars the morning's
   closing-auction row is a bar of its own, 11:30 to 11:45 JST, in the chart and the 600-bar window, and no mail is
   ever sent on it. Counted from HEAD's code; Yahoo's answer in the lunch break has not been seen (3.3 "Not yet seen").
   The owner chose 「15分足のまま（おすすめ）」 for the shares; whether the owner was told of this bar then is not known
   here (the dialog not seen, section 1). To be put to the owner (Japanese, CLAUDE.md); until answered, v41 is built as
   this file says (2.4). The answer is written in docs §8.156, and an answer other than leaving it unmailed changes this
   file first (3.3, 4.4, section 5):
   「株を15分足にすると、東証の前場の引け（11:30）の値段は、Yahoo では 11:30〜11:45 の1本の足になります。この足はチャートと MACD の600本には入りますが、この足ではメールが出ません。Yahoo の東証の値段は約15分遅れて届くので、この足が確定したと分かるのは早くても 11:45 ごろで、昼休みの間にそれが分からなければ、判定は 12:45 からの午後の読み込みになり、確定から45分を過ぎているため送りません。これはコードから数えたもので、昼休みの間の Yahoo の答えは、まだ見ていません。このまま、この足ではメールを送らない形でよいですか。送る形（この足でも送る、11:15 の足とまとめる）は、まだ作り方を決めていません。」
