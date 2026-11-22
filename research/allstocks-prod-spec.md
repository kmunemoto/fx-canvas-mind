# The stock MACD email on any share Yahoo's search finds, up to 50 shares for all users together (signal-alerts v42)

Status: a production spec, written 2026-11-21 on branch `claude/app-confirmation-jvmk03` at 76867a9 (origin/main is
b62c63b, v41; `git diff b62c63b 76867a9 -- supabase/functions src supabase/migrations` is empty, so every code line
cited here is v41's code). Nothing of it is built. Production runs signal-alerts v41 (`signal-alerts-v41-2026-11-20`,
live since 2026-11-20 08:05 UTC; docs/OPERATIONS.md §8.156). This file is the production spec of v42.
Revised on 2026-11-21 after one review of 37 findings (three reviewers: the code, the release's safety, the texts and
the owner's questions), each checked against the code and the documents it cites before any change: all 37 held, none
was refuted (several with the fix adapted or only partly taken, said where it is applied).

It is laid out like research/macdfade15min-prod-spec.md (the v41 spec), with its own section numbers. The rule the
shares are judged by is that spec's (2.4, 3.3, 4.4) and is not changed here: rule `stockmacd`, the MACD fade on
Yahoo's `15m` bars over `60d`, the 600 closed bars, 96%, one email a bar, no take-profit and no stop.

**Paths.** `SA` is `supabase/functions/signal-alerts/`, `LC` is `supabase/functions/live-chart/`, `MIG` is
`supabase/migrations/`, `OPS` is `docs/OPERATIONS.md`. **Line numbers.** Every `file:N` was read by this writer on
76867a9. Lines of econ-calendar are of `mailer.ts`, `digest.ts` and `events.ts` only; its entry file was not read.

**Yahoo.** No Yahoo price, no Yahoo answer and no Yahoo data goes into this repository (the repository is public and
Yahoo's help page SLN2310 says its information must not be redistributed). Test fixtures use made-up prices and
made-up names (for example "Example Holdings"). No company name Yahoo gave is written here.

## 1. What the owner asked

**2026-11-21 (this change).** Relayed by the lead (the dialogs themselves not seen here; `git grep` finds none of
these words in the repository yet):
- 「他の株は入れられた？」. Shown two options for the listing — 1: no listing in the app, any share found by Yahoo's
  search may be chosen; 2: ask JPX and Nasdaq for permission and put their lists in — the owner answered 「1で」.
- The cap on the shares the stock MACD email follows (all users together, distinct shares): 「50銘柄まで（おすすめ）」.
  The option's text, as relayed: it fits the current reads (one after another, 30 s a run); at production's speed
  about 56 shares fit in 30 s, so 50 leaves some room; at the cap the screen says no new share can be added.
- How to proceed: 「ワークフローで進める（おすすめ）」 (this spec about 9 agents, the build about 8).

What was read for option 2 (the lead, 2026-11-18; not used, since the owner chose 1): JPX's terms of use forbid
secondary use and redistribution of the site's information without JPX's permission and ask that high-frequency
automated fetching not be done; Nasdaq Trader's terms forbid copying or use without Nasdaq's prior written consent,
except fair use and personal non-commercial copies, and say Nasdaq's stock symbols are Nasdaq's. No list of JPX or
Nasdaq is used or kept.

**Earlier words about shares** (verbatim, with where they are written):
- 2026-10-31: 「株にも対応してほしい」; the dialog's answers 「出来るだけ多くの個別株」, 日本株は「Yahoo から取る」,
  動く値段は「Yahoo の値段で動かす」 (OPS:11993; LC/stocks.ts:3-8).
- 2026-10-31, shown docs §8.133's numbers: 「出す、利確幅はいらない、自分で決める」 (OPS:12033; SA/stocks.ts:4-5).
- 2026-11-05: 「株も売り買いのメール送って」 (OPS:12270).
- 2026-11-19: 「メールの判断15分に変更して」; for the shares 「15分足のまま（おすすめ）」 (relayed then;
  research/macdfade15min-prod-spec.md:18, :66-70; SA/stocks.ts:26-29).
- 2026-11-20: 「もう本番入れてね」 (OPS:13016).

The owner does not use a stop (CLAUDE.md, the owner's view, not a measured fact; this file never writes that a price
comes back). Nothing of the fade is measured on shares, so no win rate is given for shares anywhere here.

**What changes.** The stock MACD email may follow any share the app's chart search would offer (2.1), not only the 22
fixed today; at most 50 distinct shares are followed across all users (section 3). The 22 stay listed on the settings
screen as the shares shown before any search. **What does not change:** the rule, its chart (15 minutes), its id
(4.5), how a run reads and judges a share (SA/index.ts:1595-1721) apart from the four points of 4.2 (the paged
subscription read; the order of the shares an instance has not read yet; each read's timeout; one read and one write of
`signal_alert_stocks` a run), the reads' speed (one share after another, the 30 s budget; reading faster is not in
this change, 3.6), the chart (apart from one sentence, 6.5), the morning check.

## 2. What a share must be to be followed

### 2.1 Today's code

- A share symbol has one of two shapes: US `^[A-Z]{1,5}(-[A-Z]{1,2})?$`, Tokyo `^[0-9][0-9A-Z]{3}\.T$`
  (LC/stocks.ts:28-30, `isStockSymbol`); the market is the `.T` suffix (LC/stocks.ts:34).
- The chart's search keeps only Yahoo's hits with `quoteType` `EQUITY` and a symbol of that shape, a Tokyo one on
  exchange `JPX`, a US one on `NMS`, `NGM`, `NCM`, `NYQ`, `ASE`, `PCX` or `BTS` (not OTC, not other countries); the
  name is `longname`, else `shortname`, else the symbol, trimmed (LC/stocks.ts:175-194, `parseYahooSearch`). What
  Yahoo labels `EQUITY` is Yahoo's own label and is not checked further (10). It asks
  Yahoo in Japanese (`lang=ja-JP&region=JP`, LC/stocks.ts:70-72). Japanese words are never sent to Yahoo; they find
  only the 22 (LiveChart.tsx:188, src/lib/stocks.ts:70-79).
- The chart opens any symbol of that shape. The email side does not: `isStockmacdChart` requires one of the 22
  (SA/stocks.ts:51-55, :60-62), and it gates the run's subscriptions (SA/index.ts:1598-1600), the judgment
  (SA/stocks.ts:234, :256), `set` (SA/index.ts:2159), `set_many` (:2205) and the test mail's list (:2264), through
  `isIndicatorChartFor` (SA/indicators.ts:390-391). The status call offers the 22 only (SA/index.ts:2139), and the
  database check holds the 22 (MIG/20261031160000_signal_alert_stockmacd.sql:20-28; no later migration changes it).

### 2.2 Decision: the symbol's shape, then Yahoo's search at the time a share is first added

The shape alone is not enough. `isStockSymbol` takes any string of the shape: ETFs (the search drops them as not
`EQUITY`), OTC shares, and symbols that do not exist. Under the shape alone a made-up symbol would take one of the 50
places, would be read every minute of its due windows (about 406 reads a US weekday, about 362 a Tokyo one, counted
from SA/stocks.ts:131-158 and SA/index.ts:1661-1675: an error sets no `done`, and a new instance, which the runs
usually are, 3.5, knows no `done` at all), and would carry no name. It would also let the email follow what the
chart's search would never offer, which is not the owner's option 1.

So `set` with `on: true` under `stockmacd`, for a share that is **not one of the 22 and not followed by anyone yet**,
runs Yahoo's search once and accepts the share only if a hit, parsed by `parseYahooSearch` (unchanged), has exactly
that symbol. The query is the `q` the screen sends (what the user typed when the hit was shown, checked with
`isStockQuery`, LC/stocks.ts:196-197, and ASCII only, as LiveChart.tsx:188), else the symbol itself. The hit the user
picked may come from live-chart's search cache, up to 10 minutes old (live-chart/index.ts:238, :600-602), and Yahoo
gives 10 quotes a search (LC/stocks.ts:71-72), so when the `q` search has no hit with the symbol and `q` is not the
symbol, the symbol itself is searched once more before the share is refused: at most two searches for a newly added
share, both a confirmation by Yahoo's search. The hit's name is kept (4.1, section 5). A share already followed by
someone, and any of the 22, is accepted with no search.

Weighed against the other ways:
- **A chart read at set time** (Yahoo `15m` over `60d`, as the run reads it) would show that bars exist, but gives no
  name and no `EQUITY` or exchange check (parseYahooChart reads none, LC/stocks.ts:138-168), costs about 120 KB
  (probe #93's median answer), and the run reads the share within a minute of its next close anyway (2.3 says what
  the screen shows when it has too few bars). Not used.
- **Cost of the search:** one Yahoo search per share newly added, two when the first has no hit with the symbol (not
  per user and not per tick), 8 s timeout each as the
  chart's (live-chart/index.ts:604). The chart's own search (live-chart/index.ts:597-623) has no per-user limit
  either; none is added here.
- **When Yahoo is down:** adding a new share is refused with its own error (`stock_check_unavailable`, 4.2) and the
  screen says so (6.4); the 22, shares others already follow, unticking, and the run's reads are not affected.

### 2.3 Shares Yahoo stops answering (delisted, renamed, halted)

What Yahoo answers for such a symbol is not checked. From the code:
- **An error or an answer with no bars** (`yahoo_<status>`, `yahoo_unavailable`, `yahoo_no_bars`): the close is not
  done, so the share is read again every minute of its due windows (SA/index.ts:1661-1675): about 406 reads a US
  weekday, about 362 a Tokyo one. No mail.
- **A read that hangs:** v41 gives each read 10 s (SA/index.ts:1659) and checks the budget only before a read starts
  (:1652), so three hanging reads use the whole 30 s and the shares after them are left. v42 gives each read the
  smaller of 5 s and the budget left, starts no read with under 1 s of it left, and records each read's
  milliseconds (4.2). A share Yahoo answers slowly still costs up to 5 s a minute of its due windows.
- **Old bars only** (no bar in the six hours before the close): `noSession`, the close is done after one read
  (SA/stocks.ts:250, SA/index.ts:1677-1681), but `done` is in memory (SA/index.ts:509-512): on a warm instance one
  read a close (26 a US weekday, 22 a Tokyo one), on a new instance, which the runs usually are (3.5), one read a
  minute of the due windows, as above. No mail.
- **Fewer than 600 closed bars** in `60d` (a new listing, thin trading; a bar with any null price is dropped,
  LC/stocks.ts:156): never an entry (_shared/macd-fade.ts:80-81), so never a mail. Today nothing tells the follower.
- **A renamed symbol** is a new share: the old one behaves as above; the user adds the new one by the search.

v42 changes no read for these (a back-off would risk a missed bar after a short Yahoo failure). What it adds is a note
on the screen: once a UTC day per share (kept in the table, so a new instance does not write it again), the run writes
the newest bar's open and the number of closed bars it got into `signal_alert_stocks` (4.2, section 5). The settings
row of a followed share then says 「アプリが Yahoo から読めた一番新しい足は 〔日付〕（日本時間）のものです」 when
that bar is more than 7 calendar days old (longer than the exchanges' usual closures; their calendars not checked), and
「Yahoo から読めた15分足が〔N〕本で、600本に届くまで判定しません」 when it has fewer than 600 (6.4). The notes say
what the app read, not what Yahoo has: if the run stops, or the note's write keeps failing (only logged), the date
ages in the same way, and `N` counts the closed bars left after the parse drops a bar with a null price
(LC/stocks.ts:156). A share that never answered has no daily note (a share outside the 22 has a row from its search
that holds only the name; 10).

Such a share **keeps its place in the 50** while anyone follows it; nothing is removed automatically. That is the
owner's to decide (question 2, section 11); until answered, built as written here.

## 3. The cap of 50

### 3.1 What is counted

The distinct `pair` values of the rows with `rule = 'stockmacd'` and `interval = '15min'`, all users together: the
shares the run reads (SA/index.ts:1598-1600, :1642-1645). The 22 count like any other share while followed; a share
nobody follows does not count. The old `'1h'` `stockmacd` rows are not counted (v41's run drops them, SA/index.ts:1599; v42's does not read
them; they are to be deleted after the Tue 2026-11-24 check with the owner's OK, OPS:13311). This is the morning check's
`shares_followed_15min` (scripts/morning-check/src/stocks-v12.part:25, :113), so it can watch the cap. `STOCKMACD_CAP
= 50` (4.1). No per-user limit: one user may take all 50 (question 1, section 11).

The rows are counted whatever the follower's plan. A plan is checked only when a share is ticked (SA/index.ts:2167;
unticking is always allowed, :2182-2184) and when a mail is due (`mailerFor` counts `not_allowed` and leaves the row,
:659-666). Nothing removes the rows of a user whose alerts have ended. So a share followed only by such users keeps its
place in the 50 and is read at every due minute; on its signal bar `mailRide` says `not_allowed`, `stockFade` returns
false (:1631-1636) and the bar is judged again at each read of its window (:1698-1699), mailing nobody. One user could
fill the 50 and then lose alerts, and the cap would stay full. v42 counts no such shares (the run looks a follower's
plan up only when a mail is due); it is the owner's to decide (question 4, section 11).

### 3.2 Where it is enforced, and two users at once

- **In the database, in one call:** `public.stockmacd_follow(...)` (section 5) takes a transaction-level advisory
  lock, counts the distinct shares followed together with the ones asked for, and inserts the rows only if no share
  asked for is new or the count is at most the cap; it answers `true` (saved) or `false` (refused at the cap). `set`
  and `set_many` with `on: true` under `stockmacd` call it in place of today's upsert (SA/index.ts:2173-2177,
  :2213-2217). Other rules keep the upsert.
- **Two users adding the 51st at once:** say 49 are followed and user A adds new share P while user B adds new share
  Q. Both pass the function's early count (49) and both searches. A's call takes the lock, counts 50, inserts, and
  commits, which frees the lock; B's call has waited on the lock, then counts afresh (each statement of a volatile
  plpgsql function takes a new snapshot under read committed, PostgreSQL's default level; this project's level is
  not checked: the read-back of section 5 reads it, the function refuses under any other level, and the local run of
  section 9 tests it), finds 51 with Q new, and
  answers `false`: B is told the cap is reached and nothing of B's is saved. If both add the same new share P, the
  second finds P followed and is saved; the count stays 50. Deleting (unticking) takes no lock: a concurrent add can
  at worst count one share more and refuse.
- **No trigger.** Only the function writes subscriptions (service role; users may only read their own rows,
  MIG/20260925120000_signal_alerts.sql:4-7, :20-26), so the one call above covers every write the app makes. A
  trigger would also fire on hand-sent statements and reach the function as `save_failed` (SA/index.ts:2178-2181).
- **No re-check in the run.** The count can pass 50 by a statement sent by hand, or during a rollback to v41, whose
  `set` and `set_many` upsert any of the 22 with no count (SA/index.ts:2173-2177, :2213-2217): then at most 22 plus
  the shares beyond the 22 followed at the rollback. The run still starts no read after 30 s (SA/stocks.ts:145,
  SA/index.ts:1652-1655); the shares left are taken early in the next run (4.2: first on a warm instance, by the
  order's turn on a new one); the screen shows the count as it is. Before any re-release after a rollback,
  `shares_followed_15min` is read, and if it is over 50 the owner is asked first (8, Rollback).
- **The early count** (`rpc/stockmacd_followed_count`) is read by `set` before the search only to refuse at once,
  without a Yahoo search, when the cap is already full; the locked call decides.

### 3.3 What a user sees at the cap

The stock MACD tab shows 「通知している株（使う人全員の合計）: 〔N〕/50銘柄」 and, at 50 or more,
「全員の合計が50銘柄に達しています。まだだれも通知していない株は、足せません。」 (6.4). The search stays usable:
a share somebody already follows can still be added, since it does not add a share. Picking a share that would make
a 51st (a new one, or one of the 22 nobody follows), or an "all" row whose new shares would take the total past 50
(say 45 followed and 10 of the row's shares followed by nobody: refused at 45, 3.2), gives the toast
「足すと全員の合計が50銘柄を超えるため、足せませんでした。」, and the screen reads the status again so that the count
line is current (6.3).

What this tells a user about others: the count before and after a tick or an untick tells a user, at any count, whether
some other user follows that share (ticking a share nobody follows raises it by one; unticking lowers it only when the
user was its last follower). So do the answers only a share nobody follows can get (the search's `stock_not_found` and
`stock_check_unavailable`, 4.2) and, at the cap, the refusal. No identity and no other share is shown; with few users,
this can come close to telling who follows what. The status call sends no other user's shares (4.2). Whether the count
is shown at all is the owner's to decide (question 6, section 11); until answered it is shown.

### 3.4 When a share's last follower stops

The row is deleted (`set` / `set_many` with `on: false`, as today, SA/index.ts:2182-2192, :2222-2235); the count falls
at once (it is counted from the rows); from the next minute the run no longer reads the share (it is built from the
rows each run, SA/index.ts:1642). Its `signal_alert_stocks` row (no user id: the name and the daily note) is kept; if
the share is added again while nobody follows it, the search runs again and the name is written afresh, and the
locked call clears the old daily note when it saves a share nobody followed (section 5), so a share added again after
a gap (one of the 22 too) shows no old note until the run's next read writes a new one. The run's in-memory maps keep a
small stale entry (SA/index.ts:509-511), as today. (Deleting the row at the last untick was weighed and not taken: a
delete outside the locked call could remove the name a concurrent add has just written.)

### 3.5 The arithmetic (from the facts and the code)

- **Production:** v41 judged 8 US shares at the 14:45 UTC close of Fri 2026-11-20 in one call, `took_ms` 4,220
  (OPS:13051): about 0.53 s a share, the read, the parse and the judgment together. That call most likely included
  one mail too (NVDA's, sent at 14:45:05, OPS:13052; the next stocks call starts at 14:46:00), so the cost of a read
  alone is lower and the arithmetic below is on the safe side.
- **The budget:** 30,000 ms / 530 ms ≈ 56 shares a run. **50 x 0.53 s = 26.5 s**, leaving about 3.5 s for the paged
  subscription read (two or three requests at these counts), the one read and the one write of `signal_alert_stocks`
  (4.2) and the mails (none of these timed). Mails are sent inside the loop, at least 600 ms apart (SA/index.ts:515,
  :612-617), so a close with many signals and followers passes the budget, inside the 45-minute window
  (SA/stocks.ts:140).
- **Runs usually start on a new instance.** The docs say so of signal-alerts' every-minute runs (OPS:7407; OPS:11209:
  359 runs of 2026-10-12/13 with no `judged` skip; OPS:13299), and OPS:12785 records the same instance answering at
  times. v41's stocks record fits it: the 15:00 close of 2026-11-20 was judged by 7 shares at 15:00:00 and by 8 at
  15:01 (OPS:13051), where a warm instance would have skipped the 7 (their close done, SA/index.ts:1648). Not counted
  over a session for the stocks run. A new instance starts with `stockDone`, `stockReadAt` and `stockJudged` empty
  (SA/index.ts:509-512), so the 50-second gap (:1649) does nothing, and a share is read at **every run while a close is
  due** (SA/stocks.ts:131-158: always, in the half hours after the closes): every minute of 9:45 to 16:30 New York
  time, about **406 reads a US share a weekday**, and of 9:15 to 12:00 and 12:45 to 16:00 Japan time, about **362 a
  Tokyo share**. On a warm instance fewer: a US share once or a few times a close (26 closes), a Tokyo share about 330
  (Yahoo's Tokyo prices come about 15 minutes late, OPS:12315-12318 on 1-hour reads, so `done` is reached only after
  the 11:30 and 15:30 closes; SA/index.ts:1584-1588). The figures below take the new instance's, the likely one. The two
  markets' due windows do not overlap in UTC (Tokyo 00:15-03:00 and 03:45-07:00, New York 14:45-21:30 in winter), so a
  run reads at most the followed shares of one market.
- **Per day, 50 shares of one market:** about 50 x 406 ≈ **20,300 US reads** a weekday, or 50 x 362 ≈ **18,100 Tokyo
  reads** (the lead's round figure for Tokyo: about 15,000), with runs near 26.5 s every minute of that market's due
  windows (about 6 ¾ hours for New York, 6 for Tokyo). A holiday costs the same on new instances (`noSession`'s `done`
  is in memory, SA/stocks.ts:250, SA/index.ts:1677-1681), with no mail; so does a US half day (2026-11-27 by the usual
  calendar, not checked). With the shares split between the markets, each session's runs read fewer.
- **When a run reaches the budget:** on a warm instance the shares left are read first by the next run (oldest read
  first, SA/index.ts:1642-1645). On a new instance every share is "never read", and v41 then takes them in the
  subscription read's order, so a run at the budget would leave the same last shares every minute and their followers
  would never be mailed. v42 breaks those ties in the subscription read's order on an even UTC minute and in the
  reverse order on an odd one (4.2): on new instances, as long as at most half the due shares are left, no share is
  left in two runs in a row. (A start that moves on by one share a minute was weighed: with 8 of 50 left, 7 of them
  would be left again the next minute.)
- **Probe #93** (GitHub's runner, not Supabase's address, markets closed, Sat 2026-11-21): 120 shares one after
  another, all HTTP 200, 18.5 s in all (median 0.14 s a read); 60 shares at the start of each minute for 10 minutes,
  600 reads, all 200, 9.1 to 15.8 s a minute; 60 shares 4 at a time in 4.0 s. Its reads are faster than production's
  0.53 s, which also holds the parse and the judgment; the production figure is the one the cap rests on.

### 3.6 Not in this change, and not measured

Reading faster (Tokyo only after its delay, or 4 at a time) is **not** in this change: the owner chose the 50 that
fits the current reads (per run, it still does: 26.5 s of 30). What the owner was not shown is how many minutes are at
that load: every minute of both markets' due windows, not only at the closes (3.5); that is put to the owner in
question 5 (section 11) before the release (8).

**The FX emails' queue.** This project's pg_net (0.20.0) sends a call only after the one before it has ended
(measured 2026-10-11, OPS:552, :9244; OPS:9274: a 60-second call once delayed the other mails). The stocks run and the
pairs' and gold's run are both every-minute `net.http_post` calls with a 120 s timeout
(MIG/20261031160100_stockmacd_sweep.sql:11-23, MIG/20260929060100_indicator_alerts_sweep.sql:11-23), and the
quarter-hour sweeps use the same queue (OPS:547). At 50 shares of one market a stocks call holds the queue about
26.5-30 s of every minute of that market's due windows, so the FX pairs' and gold's call can wait behind it. The
longest pg_net call measured before the stocks run existed was 37.7 s (OPS:9244); 37.7 + 26.5 is over 60, so a backlog
is possible, and a long stocks call can leave a 15-minute pair's quarter hour, or a 1-hour pair's hour, unjudged
(research/macdfade15min-prod-spec.md:230-253). How much it delays them is **not measured** (OPS:13059). The release
watches the FX run's records for it and rolls back on it (8, step 6 and Rollback).

Not measured: reads from Supabase's address at these counts; a weekday with the markets open; more than 60 shares a
minute; hours of it (about 20,300 US or 18,100 Tokyo reads a weekday at 50 shares of one market); whether Yahoo refuses
(HTTP 429) at those counts; the FX run's delay above; whether the stocks runs land on new instances as often as the
pairs' runs (3.5).

## 4. The function's changes, file by file

### 4.1 SA/stocks.ts

- **Imports (:45):** add `isStockSymbol` from `../live-chart/stocks.ts`.
- **`STOCKMACD_PAIRS` (:50-55):** unchanged, the 22 in the chart's order; its comment becomes "the 22 listed from the
  start: the screen's rows before any search (the shares docs §8.133 measured); v42: any share of the search may be
  followed too". It stays equal to src/lib/stocks.ts US_STOCKS + JP_STOCKS (src/test/stockmacd-alerts.test.tsx:86).
- **New:** `export const STOCKMACD_CAP = 50;` and `export const isListedStock = (p: string) =>
  STOCKMACD_PAIRS.includes(p);`.
- **`isStockmacdChart` (:60-62)** becomes the shape, not the list:
  ```ts
  export const isStockmacdChart = (pair: unknown, interval: unknown): boolean =>
    isStockSymbol(pair) && typeof interval === "string" && (STOCKMACD_INTERVALS as readonly string[]).includes(interval);
  ```
  The cap is not in it: it is the database call's (3.2). Through it the run's filter (SA/index.ts:1598-1600), the two
  checks in the judgment (SA/stocks.ts:234, :256), `set`, `set_many` and the test mail's list take any share.
- **Names (:75-100):** `NAMES` unchanged (the 22's ja and en names, the app's own). `stockNameOf(sym, lang, stored:
  string | null = null): string | null` = `NAMES[sym]?.[lang] ?? (stored === sym ? null : stored)`, no longer the
  symbol (a share with no name is written once by its code, 7). New `export const stockNameClean = (v: unknown, sym:
  string): string | null`: a string with U+0000-U+001F and U+007F replaced by a space, runs of spaces made one,
  trimmed, cut to 100 code points (`[...s].slice(0, 100).join("")`, so no half of a surrogate pair is left; a cut
  by UTF-16 units could leave one, which `JSON.stringify` writes as a lone `\udXXX` escape, expected to be refused by
  PostgreSQL's JSON input; not run here); null when empty, not a string, or equal to `sym` (a Yahoo hit with no
  `longname` or `shortname` has its symbol as its name, LC/stocks.ts:190; stored as it is, the mail would say
  "XYZ（XYZ）"). Every name stored or mailed goes through it. A name is only ever the search's hit (2.2), never a name
  from the request body.
- **`renderStockMail` (:302-373):** the name comes from `stockNameOf(s.pair, lang, s.stockName ?? null)` (:313); the
  subject and first line write `〔name〕（〔code〕）` / `〔name〕 (〔code〕)` with a name and the code alone without one,
  and the source line (:346, :370) names the name as Yahoo's when the name is a stored one (exact texts in 7).
  Nothing else of the mail changes; the 22's mails stay byte for byte.
- **Rule id (:72-73):** unchanged (4.5).

### 4.2 SA/index.ts

- **Imports (:160-171):** add `STOCKMACD_CAP`, `isListedStock`, `stockNameClean`; from `../live-chart/stocks.ts` add
  `yahooSearchUrl`, `parseYahooSearch`, `isStockQuery` (LC/stocks.ts:71-72, :179-194, :196-197; LC/stocks.ts itself
  unchanged).
- **`FUNCTION_VERSION` (:402):** `"signal-alerts-v42-<the build's date>"`, e.g. `"signal-alerts-v42-2026-11-22"`.
- **In-memory (:509-511):** nothing added. The daily note's day is kept in the table (`noted_at`, section 5), not in
  memory, since the runs usually start on a new instance (3.5).
- **The run's subscription read (:1598):** `signal_alert_subscriptions?rule=eq.stockmacd&interval=eq.15min&select=
  id,user_id,pair,interval,lang,rule&order=id.asc&limit=1000`, then the same with `&id=gt.<the last id of the page
  before>`, until a page comes back empty. Paged by key, not by offset: with offset paging, an untick between two pages
  moves a later row back past the offset and no page returns it (ids are random uuids,
  MIG/20260925120000_signal_alerts.sql:10; an untick deletes with no lock, SA/index.ts:2185-2188, :2226-2229); by key,
  a row that exists through the whole read is never skipped (one added during the read may be missed and is read the
  next minute). It stops at an empty page, not at a page shorter than 1,000: this project's row limit is not checked,
  and a lower one would end the read early. Each page is read with `rest()` and taken only when the answer is ok and
  an array, as `mailRide` reads (:752-757); `readRows` (:539-544) is not used for it, since it gives `[]` for a failed
  read, which would pass for the last page. Anything else ends the run with `{ ok: false, mode: "stocks", error:
  "subscriptions_unread" }` and no Yahoo read: a run on part of the rows could hold a bar judged with a follower never
  mailed (:1698-1701). With 50 shares the rows can pass the API's row limit (Supabase's default 1,000; this project's
  not checked). The `id` is used for the paging only and goes into no record. The filter (:1599) stays. The summary
  adds `shares: followed.length` (a count; no user id).
- **The order of the shares (:1642-1645):** as v41 (oldest read in this instance first, a share never read in it
  before them), but the ties among the shares never read in this instance follow the subscription read's order on an
  even UTC minute and the reverse order on an odd one (why: 3.5, "When a run reaches the budget"):
  ```ts
  const uniq = [...new Set(subs.map((x) => x.pair))];
  const back = Math.floor(nowMs / 60_000) % 2 === 1;
  const followed = uniq
    .map((sym, k) => ({ sym, k: back ? uniq.length - 1 - k : k, at: stockReadAt.get(sym) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.k - b.k)
    .map((x) => x.sym);
  ```
- **Each Yahoo read (:1652-1670):** no read is started with under 1 s of the budget left (`Date.now() - nowMs >=
  STOCK_RUN_BUDGET_MS - 1_000`: `skipped: "budget"`, as today), and each read's timeout is `Math.min(5_000,
  STOCK_RUN_BUDGET_MS - (Date.now() - nowMs))` in place of 10 s (:1659), so no read goes on past the budget and a
  hanging read costs at most 5 s (2.3). A read cut by it is `yahoo_unavailable`, as any timeout is today (:1666-1670).
  Each entry of `reads` that read Yahoo adds `ms`, the read's milliseconds (the request and its body).
- **The stored rows, one read a run:** before the run's first Yahoo read (so a run with nothing due makes no such
  request), one read with `rest()` of `signal_alert_stocks?pair=in.(<the followed shares, quoted as set_many quotes,
  :2225-2227>)&select=pair,name,noted_at`. It gives each share outside the 22 its name for the mail
  (`stockNameClean(name, sym)`; none is read for the 22, whose names are the app's) and says whether each share's daily
  note is from today. A read that fails or gives no list: no stored name in this run's mails (the code alone, 7) and no
  daily note this run, logged without its URL (`errText`, :722-723); not an error of the run.
- **The name in the mail (in `stockFade`, :1617-1637):** `sig.stockName` from that read, set before `fadeSignal` /
  `mailRide` (:1631-1632). No read inside the loop.
- **The daily note, one write a run:** while the loop reads, for each share whose `got` has bars (`noSession`
  included) and whose stored `noted_at` is not of today's UTC date (or that has no row), a note `{ pair, last_bar_at:
  <the open of the newest bar in got.bars, ISO>, bars: <got.bars.filter((b) => b.closed).length>, noted_at: <now, ISO>
  }` is kept (`stockSweepOf` gives no closed bars for `noSession`, SA/stocks.ts:250, so the count is taken from
  `got.bars`). After the loop, the notes go in **one** upsert `signal_alert_stocks?on_conflict=pair` (`Prefer:
  resolution=merge-duplicates, return=minimal`, a JSON array; `name` and `checked_at` are not in it and are left as
  they are). In its own try / catch; a failure is logged without its URL and changes nothing of the judgment. So at
  most one note a share a UTC day, whatever the instance, and the write is not among the budget's reads (it is in
  `took_ms`).
- **The status call (:2070-2151), `indicator.stockmacd` (:2139):**
  ```ts
  stockmacd: { pairs, intervals: STOCKMACD_INTERVALS, cap: STOCKMACD_CAP, followed, shares },
  ```
  - `pairs`: the 22 (`STOCKMACD_PAIRS`, in order), then **this user's own** `'15min'` `stockmacd` shares outside them,
    in the order of the user's rows (read `order=created_at.asc`, :2072).
  - `followed`: `rpc/stockmacd_followed_count` (a number; `null` when it cannot be read).
  - `shares`: an object keyed by the symbol, for each share this user follows, `{ [pair]: { name, last_bar_at, bars,
    stale } }` (snake_case, as the rest of the answer), from one read of `signal_alert_stocks?pair=in.(...)` (quoted as
    set_many quotes, :2225-2227); `name` is null for the 22 (the screen names them itself) and is
    `stockNameClean(name, pair)` for the others; `stale` is true when `last_bar_at` is a time more than 7 days ago
    (false when it is null).
  - Why only the user's own and not every followed share: what other users follow is theirs and the screen does not
    need it; the count is enough for the cap. The new `stockmacd` block holds no user id, address or row id, and no
    other user's share; the rest of the status (the user's own address, `email`, :2114, and their own alert rows with
    their ids, :2074, :2149) is as today; `subscriptions` stays the user's own rows (:2143-2147). The comment at :2138
    ("1-hour chart", "22 shares") is rewritten.
- **`set` (:2156-2195)** under `stockmacd`: `chartOk` is the new `isStockmacdChart` (:2159), so any well-formed share
  on `15min` passes, for `on` and for `off`; `off` deletes as today (:2182-2192), plan or not. With `on: true`, in this
  order:
  1. `plan_required` 403 if not allowed (:2167).
  2. If the share is not one of the 22: one read with `rest()` of whether any `'15min'` `stockmacd` row has it
     (`limit=1`); not ok or not a list → 500 `save_failed`. If none has it: (a) `stock_cap_full` 409 if `followed` ≥ 50
     (this early refusal is skipped when the count cannot be read); (b) the search (2.2), by `q`, then by the symbol
     when no hit has it and `q` is not the symbol: `stock_check_unavailable` 503 on a Yahoo error or timeout of a
     search made, `stock_not_found` 422 when no hit has the symbol; (c) upsert `signal_alert_stocks` `{ pair, name:
     stockNameClean(hit.name, pair), checked_at: now }`; not ok → 500 `save_failed`, before the rpc, with no
     subscription saved.
  3. `rpc/stockmacd_follow` with `{ p_user, p_pairs: [pair], p_lang, p_at: now, p_cap: 50 }`: a body of exactly `true`
     → the status as today; exactly `false` → 409 `{ ok: false, error: "stock_cap_full", cap: 50 }`; anything else
     (not ok, unreadable, not a boolean) → 500 `save_failed`. (Not read as `take_twelve_data_credit`'s is,
     :637-642, which lets any doubt count as yes.)
- **`set_many` (:2199-2237)** under `stockmacd`: the 200-chart bound stays (:2200); every chart must pass the new
  `isStockmacdChart` (:2205). With `on: true`, every share must be one of the 22 or one this user already follows (one
  read of the user's rows), else 400 `invalid_request` (a new share comes only through `set`, which confirms it); then
  one `rpc/stockmacd_follow` with all of them, its body read as in `set`: `false` → 409 `stock_cap_full`, nothing
  saved. This refusal can come with fewer than 50 followed, whenever the batch's new shares would take the total past
  50 (3.3). `on: false` as today.
- **The test mail (:2239-2270):** no code change; its filter (:2264) now keeps any share's `'15min'` row; the label
  stays the code (SA/logic.ts:501-505; _shared/pair-names.ts:19).
- No other run changes: the indicators run reads no `stockmacd` row (:810).

### 4.3 SA/indicators.ts

- `IndicatorSignal` (:407-444): add `stockName?: string | null` (the share's stored name, set by the stocks run; absent
  on the other rules'). It never reaches a row: `signalRow` lists its fields (:764-781), and so does the claim's body
  (SA/index.ts:685-697).
- `isIndicatorChartFor` (:381-392): no change (it calls `isStockmacdChart`). The comment at :67 ("the 22 shares'
  hourly bars") is rewritten.

### 4.4 What does not change

- LC/stocks.ts and live-chart/index.ts: no change. A push to main that touches `supabase/functions/**` redeploys
  **all eight** functions of the default list (deploy-functions.yml:21-27, :76: analyze, position-review, postmortem,
  track-outcomes, noise-floor, version-compare, signal-alerts, live-chart; OPS:13002 records the eight), the other
  seven with the same code and version. A deploy during a long postmortem run loses that call's answer (OPS:832-835).
- SA/logic.ts: no change.
- econ-calendar: no change and no redeploy. It imports `isMacdhChart` from SA/indicators.ts (econ-calendar/mailer.ts:13),
  which imports SA/stocks.ts (SA/indicators.ts:59), so the changed file is in its module graph (checked by deno check,
  section 9), but nothing econ runs calls the shares' code, and its recipients are those with a `macdx` row
  (mailer.ts:86-96). Unchanged and pre-existing: its digest lists
  every pair a recipient follows, any rule (mailer.ts:86-89, digest.ts:166, :419, :450), so a recipient who also
  follows shares sees their codes there; currenciesOf gives a share no currency (events.ts:126-129). With more shares
  that list can be longer. Not checked in a real digest.
  **A risk econ gains from v42, not changed by it:** econ reads every rule's subscription rows in one request with no
  paging (`signal_alert_subscriptions?select=user_id,pair,interval,rule,lang&order=pair.asc`, mailer.ts:83, through
  its `readRows`, :67-75), and builds its recipients from them (:84-96). v42 is what makes that table grow (shares
  × followers). At the API's row limit (Supabase's default 1,000; this project's not checked) the rows that sort last
  by pair are cut with no error: most share symbols (digits, and most tickers) sort before `USD/JPY` and `XAU/USD`
  (the column's collation not checked), so a person whose `macdx` rows are among the cut gets no digest. v42 does not
  change econ (its own function, outside this change). The total row count of the table (a count only) is read at the
  release's read-back and in the Watch (8); when it reaches 800, econ's read is paged in a change of its own, with its
  own PR and redeploy, before anything else.
- The cron (MIG/20261031160100_stockmacd_sweep.sql:11-25): no change.

### 4.5 The rule id and the versions

The judgment is unchanged, so the rule id stays `stockmacd_12_26_9_w600_15min_fade96of120_in_v5`
(`STOCKMACD_FADE_VERSION = 5`, SA/stocks.ts:72-73; the number rises with a change of the chart, :69, and the chart
does not change). The morning check hard-codes that id (scripts/morning-check/src/stocks-v12.part:20, :31, :109), so
nothing there is rebuilt. The subscriptions keep `rule = 'stockmacd'`. Only `FUNCTION_VERSION` rises (4.2).

## 5. The database

One migration, `MIG/20261122010000_stockmacd_any_share.sql` (it must sort after the newest file,
`20261113140000_morning_check_v9_fix.sql`):

```sql
-- v42 (research/allstocks-prod-spec.md): the stock MACD email on any share Yahoo's search finds, at most 50 shares
-- for all users together (the owner, 2026-11-21: 「1で」, 「50銘柄まで（おすすめ）」).
--
-- 1. The subscriptions' pair check: the 21 FX and gold names as before, and any share symbol of the app's two
--    shapes (live-chart/stocks.ts US_SYMBOL, JP_SYMBOL). The function says which shares may be followed; this check
--    only bounds what can be stored.
-- 2. public.signal_alert_stocks: a row a share, no user id: the name Yahoo's search gave when the share was added,
--    and the stocks run's daily note (the newest bar's open, the closed bars' count, when the note was written).
-- 3. stockmacd_followed_count(): the distinct shares followed on '15min'. stockmacd_follow(...): saves a user's
--    shares only while the count stays at most p_cap or nothing new is asked, one call at a time; a share nobody
--    followed has its old daily note cleared when it is saved.
--
-- Applied before the function that uses them (docs §10: migration → functions → screen). No row is changed. Each
-- revoke follows its create at once (whether the connector applies the file in one transaction is not checked).
-- The patterns write the dot as [.] (not a backslash), so they do not depend on standard_conforming_strings.

alter table public.signal_alert_subscriptions drop constraint if exists signal_alert_subscriptions_pair_check;
alter table public.signal_alert_subscriptions add constraint signal_alert_subscriptions_pair_check
  check (
    pair = any (array[
      'USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD', 'MXN/JPY', 'NZD/JPY', 'ZAR/JPY', 'CAD/JPY', 'CHF/JPY',
      'TRY/JPY', 'USD/CAD', 'HKD/JPY', 'SGD/JPY', 'NOK/JPY', 'HUF/JPY', 'SEK/JPY', 'PLN/JPY', 'CZK/JPY', 'XAU/USD'
    ])
    or pair ~ '^[A-Z]{1,5}(-[A-Z]{1,2})?$'
    or pair ~ '^[0-9][0-9A-Z]{3}[.]T$'
  );

create table if not exists public.signal_alert_stocks (
  pair text primary key check (pair ~ '^[A-Z]{1,5}(-[A-Z]{1,2})?$' or pair ~ '^[0-9][0-9A-Z]{3}[.]T$'),
  name text check (name is null or char_length(name) between 1 and 100),
  checked_at timestamptz,
  last_bar_at timestamptz,
  bars integer check (bars is null or bars >= 0),
  noted_at timestamptz
);
alter table public.signal_alert_stocks enable row level security;
revoke all on public.signal_alert_stocks from anon, authenticated;
grant all on public.signal_alert_stocks to service_role;

create or replace function public.stockmacd_followed_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct pair)::integer
  from public.signal_alert_subscriptions
  where rule = 'stockmacd' and "interval" = '15min';
$$;
revoke all on function public.stockmacd_followed_count() from public, anon, authenticated;
grant execute on function public.stockmacd_followed_count() to service_role;

create or replace function public.stockmacd_follow(p_user uuid, p_pairs jsonb, p_lang text, p_at timestamptz, p_cap integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  asked text[];
  n integer;
begin
  select array_agg(distinct v) into asked from jsonb_array_elements_text(p_pairs) as t(v);
  if p_user is null or asked is null or p_lang is null or p_lang not in ('ja', 'en') or p_at is null or p_cap is null
     or exists (select 1 from unnest(asked) as a(pair)
                where not (a.pair ~ '^[A-Z]{1,5}(-[A-Z]{1,2})?$' or a.pair ~ '^[0-9][0-9A-Z]{3}[.]T$')) then
    raise exception 'stockmacd_follow: bad arguments';
  end if;
  -- the count after the lock sees the rows committed while waiting only under read committed (a statement's own
  -- snapshot); under another level it could count an old snapshot, so it refuses instead
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'stockmacd_follow: needs read committed';
  end if;
  -- one call at a time: a second call waits here until the first has committed, then counts its rows
  perform pg_advisory_xact_lock(391042);
  select count(*) into n from (
    select pair from public.signal_alert_subscriptions where rule = 'stockmacd' and "interval" = '15min'
    union
    select unnest(asked)
  ) s;
  if n > p_cap and exists (
    select 1 from unnest(asked) as a(pair)
    where not exists (select 1 from public.signal_alert_subscriptions x
                      where x.rule = 'stockmacd' and x."interval" = '15min' and x.pair = a.pair)
  ) then
    return false;
  end if;
  -- a share nobody followed: its old daily note (from before a gap) is not shown again
  update public.signal_alert_stocks s set last_bar_at = null, bars = null, noted_at = null
  where s.pair = any (asked)
    and not exists (select 1 from public.signal_alert_subscriptions x
                    where x.rule = 'stockmacd' and x."interval" = '15min' and x.pair = s.pair);
  insert into public.signal_alert_subscriptions (user_id, pair, "interval", rule, lang, created_at)
  select p_user, a.pair, '15min', 'stockmacd', p_lang, p_at from unnest(asked) as a(pair)
  on conflict (user_id, pair, "interval", rule) do update set lang = excluded.lang, created_at = excluded.created_at;
  return true;
end;
$$;
revoke all on function public.stockmacd_follow(uuid, jsonb, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.stockmacd_follow(uuid, jsonb, text, timestamptz, integer) to service_role;
```

- The 21 literals are 20261031160000's (:23-24), unchanged; the 22 shares' literals go, since the patterns take them.
  The patterns are LC/stocks.ts:28-29's, with the escaped dot `\.` written `[.]` (the same in a POSIX regex, and with
  no backslash, so whatever `standard_conforming_strings` is). Adding the check validates the existing rows; from the
  repository every stored pair is one of the old list's 43 values, which the new check takes. Production's rows and
  constraint were
  not read.
- `on conflict (user_id, pair, "interval", rule)` is the unique key of MIG/20260925180000_signal_alert_rules.sql:22-24;
  the update is what today's merge upsert writes (`lang`, `created_at`, SA/index.ts:2173-2177).
- `p_pairs` is `jsonb` so PostgREST passes the function's JSON array as it is.
- The lock key `391042` (the rule's issue #391, v42) is used by nothing else (no advisory lock in MIG).
- `security definer` with `search_path = public` and the grants follow `take_twelve_data_credit`
  (MIG/20260928060000_twelve_data_usage.sql:27-34, :52-53). PostgreSQL grants EXECUTE to PUBLIC on a new function, so
  each REVOKE / GRANT comes right after its CREATE; if the connector does not apply the file in one transaction (not
  checked), the window in which a function that takes any `p_user` is open is one statement long.
  `signal_alert_stocks` has no policy: no user reads it; the status call sends what a user may see.
- **Two users at once rests on read committed** (3.2). The function refuses under any other level (`needs read
  committed`, which `set` gives as 500 `save_failed`) rather than count an old snapshot; the read-back below reads the
  level before the release.
- **Applied** with the owner's confirmation through the Supabase connector, before the function (OPS:13333; the order
  of MIG/20261031160000:13-14), and read back: `pg_get_constraintdef` of the pair check, the table's columns and RLS,
  the two functions' definitions (md5 of their source against the file's), their grants, `show
  default_transaction_isolation`, and of `pg_roles.rolconfig` for `authenticator` and `service_role` only the
  `default_transaction_isolation=` entries (no other setting is printed); and the total row count of
  `signal_alert_subscriptions` (a count only, for econ's read, 4.4). The reads return definitions and counts only, no
  rows. v41 keeps working on the new schema: it offers and accepts only the 22 (SA/stocks.ts:60-62, SA/index.ts:2159)
  and does not use the new table or functions.

## 6. The screen

### 6.1 src/lib/signalAlerts.ts

- The type (:168-169) and the normalizer (:304): `stockmacd: { pairs, intervals, cap: number | null, followed: number
  | null, shares: Record<string, { name: string | null; lastBarAt: string | null; bars: number | null; stale: boolean
  }> }`, read from the server's object keyed by the symbol with snake_case fields (`last_bar_at`, 4.2); anything
  malformed is dropped (as :274-311 do). A v41 server sends no `cap`: then `cap` is null.
- `indicatorChartOffered` (:333): no change (the user's own shares are in `pairs`). `callSignalAlerts` already throws
  the server's error code (:357-359).
- The comment at :168 ("the 22 shares, 1 hour") is rewritten.

### 6.2 New src/components/StockPicker.tsx

The chart's search box is a closure inside LiveChart that uses its state and `setPair` (LiveChart.tsx:183-209,
:624-678), so it cannot be reused as it is. A small component reuses its data layer: `searchStocks`
(src/lib/liveChart.ts:456, through live-chart's `search`, which needs sign-in only), `matchListed`, `isStockQuery`, the
400 ms wait and the ASCII-only rule (LiveChart.tsx:115, :188, :194-203), listed finds first, then Yahoo's minus
duplicates (LiveChart.tsx:627-629). Props: `onPick(hit, q)`, `disabled`, `loadSearch` (for tests). A hit shows its
symbol, its name (a listed one's in the locale; a Yahoo hit's as given) and the market (`t.live.stockMarkets`). Test
ids `stockmacd-search`, `stockmacd-q`, `stockmacd-hit-<symbol>`, `stockmacd-searching`, `stockmacd-search-error`,
`stockmacd-no-hits`. LiveChart is not changed in this release (its search keeps its own code and tests).

### 6.3 SignalAlertSettings 「株の MACD」

- Above the grid, only when `ind.cap` is a number (a v42 server): the count line and, at `followed` ≥ `cap`, the full
  message, both only when `ind.followed` is a number (when it is null, `stockmacdCountUnread` in their place: no
  「0/50」 and no guess); and the StockPicker (disabled while `busy` or when `!settings.allowed`; it stays when the
  count is unread, since the locked call decides). Picking sends `{ action: "set", pair: hit.symbol, interval:
  "15min", on: true, rule: "stockmacd", lang, q }`. Errors by code: `stock_cap_full`, `stock_not_found`,
  `stock_check_unavailable`, else `saveFailed` (today's toggles show `saveFailed` for every error, :77, :89; for
  `stockmacd` they use the same mapping). After a `stock_cap_full` from `set` or `set_many`, the screen calls `load()`
  (the status, SignalAlertSettings.tsx:58-65) again, so the count line and the full message match the cap: on an error
  today's toggles keep the old status on screen (:74-80, :86-92), and `callSignalAlerts` keeps only the code
  (signalAlerts.ts:357-359).
- The grid: rows are `ind.pairs` as today (:268), so the user's own shares beyond the 22 get rows. The name beside a
  symbol: `ind.shares[pair]?.name ?? stockName(pair, locale)` (today `stockName` only, :273). Under a row's name, when
  `shares[pair]` says so, the stale note or the short-bars note (6.4). The header is 「銘柄」 / "Stock" for
  `stockmacd` (today `pairHeader` 「通貨ペア」, :233). No "—" cell can appear for `stockmacd` (every row is offered on
  its one column), so no new title.
- The "all" row (:241-267) stays and gets its own label 「表の銘柄すべて」 / "All stocks in the table"; it ticks the
  rows shown (the 22 and the user's own), through `set_many`, and is refused when its new shares would take the total
  past the cap (which can happen below it, 3.3).
- **To stop:** untick the share's box, as the mails say (SA/stocks.ts:347, :371). A share beyond the 22 then leaves the
  table (the status no longer sends it); to follow it again, search for it.
- `macdxUnavailable` (:225-226) stays for a server that sends no block; from v42 `pairs` always holds the 22, so a user
  who follows nothing still sees the table. The comment at :222 is rewritten.

### 6.4 The new and changed texts (ja / en, word for word)

`alerts` (src/lib/i18n/ja.ts, en.ts):
- `stockmacdNotes[0]` (replaces ja.ts:2194 / en.ts:2089; [1]-[6] unchanged):
  - ja: 「Yahoo の検索で見つかる米国株と日本株（Yahoo が株として出す、米国の取引所と東証の銘柄）の15分足で判定します。上の「通知する株を探す」で探して足せます。通知する株は、使う人全員で合わせて50銘柄までです（同じ株は、何人がチェックしても1銘柄と数えます）。はじめから表に出している22銘柄（米国株8・日本株14）は、前の決まりで過去の数字を測った銘柄です。今の決まりは、株では測っていません。」
  - en: "Judged on the 15-minute chart of US and Japanese stocks that Yahoo's search finds (what Yahoo lists as equities on US exchanges and the Tokyo Stock Exchange). Find one with \"Find a stock to alert\" above and add it. Up to 50 stocks can be alerted for all users together (a stock counts once, however many people tick it). The 22 stocks in the table from the start (8 US, 14 Japanese) are the ones the earlier rule was measured on. The present rule is not measured on stocks."
- `stockmacdSearchLabel`: 「通知する株を探す」 / "Find a stock to alert"
- `stockmacdNoHits`: 「見つかりませんでした。Yahoo の検索は、ティッカー（AAPL）・4桁のコード（7203）・英語の名前（sony）で探せます。日本語の名前は、はじめから表に出している22銘柄の中だけから探します。」 / "Nothing found. Yahoo's search finds a ticker (AAPL), a four-digit Tokyo code (7203) or an English name (sony); Japanese names are looked for among the 22 stocks in the table from the start only."
- `stockmacdHeader`: 「銘柄」 / "Stock"
- `stockmacdAllRow`: 「表の銘柄すべて」 / "All stocks in the table"
- `stockmacdCount: (n: number, cap: number)`: `通知している株（使う人全員の合計）: ${n}/${cap}銘柄` / `Stocks alerted (all users together): ${n} of ${cap}`
- `stockmacdCountUnread`: 「通知している株の数（使う人全員の合計）を、いま読めませんでした。」 / "Could not read how many stocks are alerted (all users together) just now."
- `stockmacdFull: (cap: number)`: `全員の合計が${cap}銘柄に達しています。まだだれも通知していない株は、足せません。` / `All users together have reached ${cap} stocks. A stock nobody alerts yet cannot be added.`
- `stockmacdCapRefused: (cap: number)` (for `set` and `set_many` alike; true in both, since a batch can be refused below the cap, 3.3): `足すと全員の合計が${cap}銘柄を超えるため、足せませんでした。` / `Not added: it would take all users together past ${cap} stocks.`
- `stockmacdNotFound`: 「Yahoo の検索で、この株を確かめられませんでした。足せるのは、Yahoo が株として出す、米国の取引所と東証の銘柄だけです。」 / "Yahoo's search did not confirm this stock. Only what Yahoo lists as equities on US exchanges and the Tokyo Stock Exchange can be added."
- `stockmacdCheckFailed`: 「Yahoo が答えなかったため、この株を確かめられませんでした。少し後にもう一度お試しください。」 / "Could not check this stock (Yahoo did not answer). Please try again in a moment."
- `stockmacdStale: (day: string)` (day: the date, in Japan time, of the newest bar the app read, YYYY-MM-DD): `アプリが Yahoo から読めた一番新しい足は ${day}（日本時間）のものです` / `The newest bar the app could read from Yahoo is from ${day} (Japan time)`
- `stockmacdShortBars: (n: number)`: `Yahoo から読めた15分足が${n}本で、600本に届くまで判定しません` / `${n} 15-minute bars could be read from Yahoo; not judged until there are 600`

What Yahoo marks `EQUITY` is not checked (2.1, 10), so the texts say what is checked (Yahoo's own label and the
exchange), not "individual stocks".

The search's placeholder, "searching", error and market labels are the chart's (`t.live.stockSearchPlaceholder`,
`stockSearching`, `stockSearchError`, `stockMarkets`; ja.ts:890-895, en.ts:841-846). `stockNoHits` (ja.ts:892-893) is
not reused: its 「上の一覧」 is the chart's list.

### 6.5 The chart

Only the last sentence of `live.stockNote` changes (ja.ts:954, en.ts:902):
- ja: 「（決まった22銘柄の15分足だけ）」 → 「（Yahoo の検索で見つかる株の15分足。使う人全員で合わせて50銘柄まで）」
- en: "(the 22 listed stocks' 15-minute charts only)" → "(the 15-minute chart of a stock Yahoo's search finds; up to 50
  stocks for all users together)"

Nothing else of the chart changes: its list (src/lib/stocks.ts:24-52), its search, and names learned in the tab
(:56-68). A listing of all shares in the chart is not in this change (option 1).

## 7. The emails

Only the share's label changes (SA/stocks.ts:329-330, :353-354). With a name (the 22's own, or the stored one):
- ja subject 「【Sextant】〔name〕（〔code〕）〔15分足〕 …」, first line 「〔name〕（〔code〕、〔東証 / 米国〕）の…」 — as today.
- en subject "[Sextant] 〔name〕 (〔code〕) 〔15-minute〕 …", first line "… on 〔name〕 (〔code〕, 〔Tokyo / US〕), …" — as today.

Without one: ja 「【Sextant】〔code〕 15分足 …」 and 「〔code〕（〔東証 / 米国〕）の15分足で、…」; en "[Sextant] 〔code〕
15-minute …" and "A MACD fade 〔side〕 signal on 〔code〕 (〔Tokyo / US〕), 15-minute chart." (today the code would be
written twice, "XYZ（XYZ）", SA/stocks.ts:100; a hit whose name is its symbol is stored with no name, 4.1). The
stored name is one string, as Yahoo's search gave it under `lang=ja-JP`, and serves both languages (as the chart
already shows it, src/lib/stocks.ts:56-68). So **a Tokyo share added by the search carries its Japanese name in the
English mail too** (by the code's own note, LC/stocks.ts:70: "in Japanese, so a Tokyo share's name comes in
Japanese"; checked only in how the chart's search is written, not in a Yahoo answer here); what language Yahoo gives a
US share's name under `ja-JP` is not checked.

**The source line** (SA/stocks.ts:346, :370), for a share mailed with a stored name (one outside the 22) only, names
the name as Yahoo's too: ja 「足と値段と銘柄の名前は Yahoo Finance の公開データ（公式の配信ではないため、止まることが
あります）で、アプリの株のチャートと同じです。…」, en "The bars, the price and the stock's name are Yahoo Finance's
public data (not an official feed; it may stop), the same as the app's stock chart. …" (the rest of the line as
today). The 22's mails and a share mailed with no name keep today's line.

Everything else stays word for word: 「株では測っていません。」 / "Not measured on shares." (SA/stocks.ts:344, :368);
the Tokyo delay sentence (SA/stocks.ts:340-343, :364-367), whose delay was measured on 2026-11-06 on 1-hour reads of
the 14 Tokyo shares followed then only (OPS:12316: 891-933 s over 1,418 reads); for other Tokyo shares, and for thinly
traded ones, it is not measured, and such a share's bar may be judged later than the sentence says, or not at all
within the 45 minutes: a bar counts as closed only once Yahoo's last trade time reaches its end or a later bar is
there (SA/stocks.ts:204; `regularMarketTime`, the last trade, :188) (10); the US / Tokyo words and money format by
the `.T` suffix (:304-306). No mail says 22 (the guard at src/test/stockmacd-alerts.test.tsx:941 stays). The test mail
is unchanged.

## 8. Release

**Preconditions**
- This file merged; the build (function, migration file, screen, texts, tests) in one PR, reviewed by separate
  agents, every check of section 9 passed, the local PostgreSQL run included.
- The owner's answers to section 11 are not required first: until answered, it is built as this file says.
  Question 5 (the load of 50 shares, corrected in 3.5) is put to the owner before the release, since the 50 was chosen
  on a description of the reads that left that load out.
- None of the next scheduled reads is disturbed (Mon 2026-11-23 00:40 UTC, the weekend FX open read; Tue 2026-11-24
  00:16 UTC, the Routine's morning check; Tue 01:05 UTC, the first Tokyo session read; the `'1h'` rows' delete after
  the Tue check with the owner's OK, OPS:13311).

**Timing.** No share session may be open: Tokyo 00:00 to about 07:00 UTC with the reads after the 15:30 JST close,
New York 14:30 to about 21:30 UTC (winter time). Preferred: **Sun 2026-11-22, done by 22:00 UTC** (weekend: no
session, and clear of Monday's 00:40 read). If not ready: Mon 2026-11-23 01:00-13:30 UTC (Tokyo closed for 勤労感謝の
日 by the usual calendar, not checked; FX open, so the merge minute is chosen clear of the pairs' reads, OPS:13350);
else Tue 2026-11-24 07:00-13:30 UTC, after the Tue check. If released on the weekend, Monday's US session and
Tuesday's first Tokyo session on 15-minute bars run on v42 (the same rule and id as v41).

**Order** (OPS:13324-13333):
1. **Migration** (section 5) with the owner's confirmation through the Supabase connector, then its read-back (with
   the isolation level and the total row count; if the level is not read committed, stop and tell the owner).
2. **Function:** merge the PR (squash message written by hand, without "[skip ci]", which stopped v40's push deploy,
   OPS:13348); the push redeploys all eight functions of the default list, signal-alerts and live-chart among them
   (deploy-functions.yml:21-27, :76; 4.4). Check that the deployed source matches main (sha256) and that the "stocks"
   run answers `version` `signal-alerts-v42-…`.
3. **The runs' records:** on the weekend a stocks run reads nothing (no close due) and its record gives `version`,
   `subscriptions` and `shares`; read once after the deploy.
4. **Screen:** the Lovable publish of main once the function answers v42; its state (pending or other) is reported as
   it is, without checking that it shows.
5. **Morning check and Routine:** nothing to rebuild or replace (4.5; stocks-v12 names no share and counts
   `shares_followed_15min`, stocks-v12.part:25, :113; the Routine's prompt names shares only as the record of v9's
   open trades, scripts/morning-check/routine/prompt-v12-switch.txt:7, and tells a US share from a Tokyo one by its
   lag, :128). The Tue 2026-11-24 00:16 UTC check runs as scheduled and covers Monday's US session under v42. One
   thing to know when reading it: it compares a bar's mail rows with the subscriptions at check time
   (stocks-v12.part:25), so a share unticked after its mail and before the check shows `dup` (:59) or
   `no_subscription_row` (:94) and a CHECK verdict. Under v42 users may untick shares to free places in the 50, so such
   flags can come from an untick, not from a wrong mail; §8.157 says so, and, if the owner wants, one line is added to
   the Routine's next prompt revision.
6. **Watch** (scheduled reads by the merging session; records are kept about 6 hours, and at v41's release both
   scheduled reads did not run, OPS:13053, so each window gets more than one read): Monday's US session at about
   15:30, 20:00 and 21:40 UTC, and Tuesday's Tokyo session at 01:05 (already scheduled), about 04:30 and 07:10 UTC;
   again in the first session after the morning check's `shares_followed_15min` first passes 30. In the stocks run's
   records: `version`, `shares`, no `subscriptions_unread`, `took_ms` under 30,000, `skipped: "budget"` only when many
   shares are due and never the same share in two runs in a row, the reads' `ms`, the count of `yahoo_unavailable`
   a run, and no run of `yahoo_429`. **In the pairs' and gold's run's records** (the "indicators" run) at the same
   reads: each USD/JPY and AUD/USD 15-minute close judged at its minute-0, 1 or 3 read and none left unjudged, and the
   `macdx` `judged_after_ms` (SA/index.ts:1068) in the minutes of the share sessions against the same in the hours with
   no share session (07:00-14:30 UTC, on the same day, so no v41 record is needed). Also the total row count of
   `signal_alert_subscriptions` (a count; 4.4). Which reads ran is written in §8.157; for a session none of whose reads
   ran, §8.157 says plainly that it was not checked.
7. **docs §8.157** last: what was done, the times, the counts (no user id, no Yahoo answer).

**Rollback.** Decided by the session from the runs' records, or by the owner. Triggers: a `subscriptions_unread`;
`yahoo_429` runs; `yahoo_unavailable` in most runs of a session; runs at the budget every minute with few shares; a
share left for the budget in two runs in a row; an error in `set`; an FX 15-minute close left unjudged; or the FX
pairs' minute-0 judgments in the share sessions 30 s or more later than outside them in most quarter hours.
How: revert only `supabase/functions/**` and `src/**` (the function, the screen, the texts and the tests) on main, and
keep `MIG/20261122010000_stockmacd_any_share.sql` in main, as production keeps its schema; give the reverted function
its own `FUNCTION_VERSION` (for example `signal-alerts-v41-rollback-<date>`, and the test line that names it), so that
the runs' records tell the rollback from the original v41. The push redeploys all eight functions (4.4): on a weekday
the merge minute is chosen clear of the quarter-hour sweeps and the FX closes, or postmortem is paused first
(OPS:832-835). Publish the reverted screen. The migration stays: v41 does not use the table or the functions and the
wider check is harmless to it. Under v41 the rows of shares outside the 22 are not read (SA/index.ts:1598-1600 with
v41's predicate), so their followers get no mail, and v41 refuses to untick them (SA/index.ts:2159-2162); v41's `set`
and `set_many` add rows of the 22 with no cap, so the count can pass 50 (3.2). If the rollback lasts, the rows outside
the 22 are deleted with the owner's confirmation, the delete first sent as its select (a count by share, no user id).
Before any re-release of v42, `shares_followed_15min` is read; if it is over 50, the owner is asked first.

## 9. Checks

**Tests to change**
- src/test/stockmacd-alerts.test.tsx: :1 (header "the 22 shares'"); :85-115 (:86 stays: the 22 are the chart's list;
  :115 becomes true for `isIndicatorChartFor("stockmacd", "IBM", "15min")`, false for "ibm", "7203", "IBM " and
  `"7203.T"` on `"1h"`); :964-976 (`FUNCTION_VERSION` v42 at :967, the paged read's text at :968, the status block's
  text at :972; :976 still reads the old migration and stays; the new migration file is checked as below); :1097-1133
  (rows = 22 + the user's own + "all"; names from `shares`); :1150 stays (no block: not available); :1677-1681 stay
  (the 8 US of the 22) and a 50-share case is added; :1680-1706 (the order of the shares never read now turns with the
  minute's parity, 4.2) and :1719-1726 (the source-text checks of the order, the budget's 1 s floor and the read's
  timeout).
- src/test/signal-alert-settings.test.tsx: :640-649 (header 「銘柄」 / "Stock", still no "—"); :1268-1299 and
  :1517-1528 (notes [0], ja and en, as 6.4); :1537-1546 (the stock note's new parenthesis, as 6.5).
- src/test/stocks.test.tsx :233-245, :291-315, :320-339: unchanged (the chart's list and search; the note still holds
  「「株の MACD」で選べます」).

**Tests to add** (the function over the test's fake tables and a fake Yahoo with made-up prices and names). **The fake
world** at src/test/stockmacd-alerts.test.tsx:1165-1311 gains: `rpc/stockmacd_follow` with the SQL's logic (the note
cleared for a share nobody followed) and `rpc/stockmacd_followed_count`; `signal_alert_stocks` (GET with `pair=in.`
and a POST upsert of an array, routed in the run tests, since `clean()` refuses an unrouted request, :1375); query2's
search; and the paging: today `META` is `select`, `order`, `limit` and `on_conflict` (:1237), any other parameter goes
to `condOf`, which knows only `eq.` and throws (:1230-1235), and `limit` is ignored (:1285), so the subscriptions' route
gains `limit` and `id=gt.` (its rows given made-up ids) and a page that answers 503:
- **Cap:** 49 followed, a new share → saved, 50; 50, a new share → 409 `stock_cap_full`, no row, no search; 50, a share
  another user follows → saved; 50, one of the 22 nobody follows → 409; `set_many` that would pass 50 → 409, nothing
  saved; **45 followed, `set_many` with 10 shares nobody follows → 409 at 45**, nothing saved; 51 rows put in by hand,
  a re-tick of a followed share → saved; the rpc answering `null`, a non-boolean or a 500 → 500 `save_failed`.
- **Refusals:** lowercase, no ".T", "1h", not a string → 400; `set_many` on with a share neither of the 22 nor the
  user's → 400; no plan → 403 before any search or count; `off` of any share, plan or not → deleted.
- **The search:** a hit with the symbol, `EQUITY`, an allowed exchange → saved and its name stored; as an ETF, on
  `PNK`, or absent → 422; Yahoo 5xx or timeout → 503; never searched for the 22 or a followed share; a `name` in the
  request body is ignored; `q` not ASCII or not `isStockQuery` → the symbol is searched; a `q` search without the
  symbol and a symbol search with it → saved, two searches; `q` equal to the symbol → one search; the
  `signal_alert_stocks` upsert failing → 500 `save_failed`, no rpc, no subscription.
- **Names:** a stored "Example Holdings" in the ja and en subject and first line, and the source line naming the name
  as Yahoo's; no name → the code once; a hit with no `longname` or `shortname` → stored with name null, its mail
  writing the code once; a name with a newline or 150 characters → cleaned and cut; a name of over 100 code points
  whose 100th is half of a surrogate pair in UTF-16 → cut by code points, no lone surrogate; the 22's mails byte-equal
  to v41's on the same made-up bars.
- **Status:** `pairs` = the 22 + the user's own in their order; `shares` an object keyed by the symbol; another user's
  share never in `pairs` or `shares` but in `followed`; no user id anywhere in the answer; `stale` at 7 days; a share
  followed again after a gap (one of the 22 too) shows no old note.
- **The run:** any shape read and judged (made-up `XYZ`, `BRK-B`, `130A.T`); 1,500 rows over two pages read by key;
  an untick between two pages leaves no other row unread; a failed page (503, or a body that is not a list) →
  `subscriptions_unread`, no Yahoo read; `'1h'` rows not read; one daily note a share a UTC day **across new
  instances**, all in one request after the loop; a failing note write leaves the judgment as it was; a failing read of
  `signal_alert_stocks` → the code alone in the mail, no note, the judgment as it was; 50 Tokyo shares at 530 ms a read
  → all read, `took_ms` 26,500; at 700 ms → the rest `skipped: "budget"`, and **on a new instance each minute no share
  is left in two runs in a row**; a read that hangs is cut at the smaller of 5 s and the budget left, and none is
  started with under 1 s left; each read's `ms` in `reads`.
- **The screen:** the picker (fake timers: one search 400 ms after typing stops; Japanese → listed only); a pick sends
  `set` with `pair`, `interval` "15min", `rule` "stockmacd", `q`; the count and the full message; `followed` null →
  `stockmacdCountUnread`, no count line, no full message, the picker kept; each error's toast; after `stock_cap_full`
  (from `set` and from the "all" row) the status read again and the count line updated; the own share's row with its
  stored name and its notes; untick; a v41 status (no `cap`) → no picker, as today.
- **The migration file:** the 21 literals; both patterns equal to LC/stocks.ts:28-29 (read from that file's text, with
  `[.]` read as `\.`); no backslash in the file's patterns; each REVOKE right after its CREATE; the grants; the
  isolation guard.

**Static:** `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`; `deno check` of
`supabase/functions/signal-alerts/index.ts`, `supabase/functions/live-chart/index.ts` and
`supabase/functions/econ-calendar/mailer.ts` (the module that imports SA/indicators.ts, mailer.ts:13).

**Local PostgreSQL** (as v41's checks were run): the migration on a copy of the schema with rows of every current
pair; the pair check against `isStockSymbol` on the same made-up inputs (lowercase, full-width letters, other digits,
a trailing newline, empty, `BRK-B`, `130A.T`, 9 characters); `stockmacd_follow` at 49 / 50 / 51 and with an empty or
non-array `p_pairs`; **two sessions at once** (the first holds its transaction open after the call, the second waits
and then refuses); the call under `repeatable read` → refused; the note cleared for a share nobody followed and kept
for one followed; `authenticated` cannot execute either function or read the table.

**Dry run:** the stocks run in the test world with 50 made-up shares, both markets, through one Tokyo session and one
US session of made-up bars, **with a new module instance every minute** (as OPS:3656's runs were) and once with one
instance throughout, checking reads per share against 3.5's counts (about 406 a US share and 362 a Tokyo one on new
instances), the budget's leftovers, and one note a share a day.

## 10. Not measured, not checked

- Nothing of the fade is measured on shares (as v41). No win rate, no result a trade, no open trade is given for
  shares.
- Not measured: Yahoo reads from Supabase's address at these counts (probe #93 ran on GitHub's runner); a weekday with
  the markets open; more than 60 shares a minute; hours of it (about 20,300 US or 18,100 Tokyo reads a weekday at 50
  shares of one market, on new instances, 3.5); whether Yahoo answers 429 then; how slowly Yahoo answers from
  Supabase's address (probe #93's slowest read, 0.47 s, was from GitHub's runner on a closed weekend), so how often a
  read is cut at 5 s; a stocks call's length with 50 shares and **its delay of the FX pairs' and gold's call in
  pg_net's queue** (3.6); how often the stocks runs start on a new instance (3.5 rests on the docs about the pairs' run
  and one v41 stocks record); the mails' time inside a run, and the time of the run's new read and write of
  `signal_alert_stocks`; Tokyo's delay on 15-minute reads (measured on 1-hour reads, OPS:12316; Yahoo's help page
  SLN2310 names 20 minutes for Tokyo, the lead's reading; no text here writes 20), and on any Tokyo share but the 14
  measured, or a thinly traded share of either market: such a share's bar may be judged later than the mail says, or
  not at all within the 45 minutes (7).
- Not checked: what Yahoo answers for an unknown, delisted or halted symbol; whether Yahoo's search finds a share by its
  own symbol (the fallback query); what language it gives a US share's name under `ja-JP` (a Tokyo share's comes in
  Japanese by the code's note, LC/stocks.ts:70, not by a Yahoo answer here); **what Yahoo marks `EQUITY`** (preferred
  shares of the `-[A-Z]{1,2}` shape, ADRs, REITs, closed-end funds, SPAC units or warrants of the five-letter shape may
  be among them), so the texts say "what Yahoo lists as equities", not "individual stocks" (6.4); signal-alerts' own
  search from Supabase's address (live-chart's search runs from there in production; not measured); the exchanges'
  holiday and half-day calendars (11/23 Tokyo, 11/26-27 US); production's constraint, rows and how many shares are
  followed now; this project's API row limit; this project's transaction isolation (read at the read-back; the
  function refuses under any level but read committed, section 5); whether the connector applies the migration file
  in one transaction; the `pair` column's collation (which rows econ's read would cut, 4.4); PostgREST's handling of
  the jsonb argument and the advisory lock under concurrent calls (local only, section 9); a real econ digest with
  many shares. (`standard_conforming_strings` is no longer relied on: the patterns write `[.]`.)
- **What the count tells a user about others** (3.3): at any count, whether some other user follows a share they tick
  or untick (no identity, no other share); with few users this can come close to telling who follows what. Question 6.
- **Shares of users whose alerts have ended** count in the 50 and are read, mailing nobody; nothing removes their rows
  and nothing counts them (3.1). Question 4.
- **econ-calendar's digest** reads every subscription row in one request; past the API's row limit, the recipients
  whose `macdx` rows sort last get no digest and no error (4.4). Not changed in v42; the row count is read and watched.
- A share that never answered Yahoo has no daily note, so the screen shows nothing for it (a share outside the 22 has
  only its name in its row); only the run's record says `yahoo_<status>`.
- Rounding: 2 decimals in the US, 1 in Tokyo (LC/stocks.ts:36-38), chosen for TOPIX 100's step (OPS:12003); not
  checked for other Tokyo shares or for US shares under $1.
- Yahoo's terms: whether storing Yahoo's search names (kept after nobody follows the share, 3.4), showing them on the
  followers' settings screens and writing them in emails fits SLN2310 is not concluded (the mails already carry Yahoo's
  price, SA/stocks.ts:335, :359); nor is storing and showing the daily note, which is also data read from Yahoo (the
  newest bar's time and the count of its bars, 4.2). Whether Yahoo's API terms (REV 3-2022) cover the keyless
  endpoints the app uses is not stated on that page and not concluded.
- Nasdaq's terms say its stock symbols are proprietary to Nasdaq (section 1). Whether that bears on the app storing
  and mailing a US ticker a user picks through Yahoo's search (as it already does for the 8) is not concluded. No
  Nasdaq list is used or kept.
- econ-calendar's entry file was not read (the privacy hook refuses it). No production table, log or row was read for
  this file; no test, build or app was run.

## 11. Questions for the owner

Until answered, it is built as this file says (the first answer of each). The answers go into docs §8.157, and an
answer other than the first changes this file first.

**Answered 2026-11-22 (UTC), before the build:** the owner chose the first answer of all six, word for word as the
dialog's options: 1 「付けない（おすすめ）」, 2 「自動では外さない（おすすめ）」, 3 「Yahooの名前を出す（おすすめ）」,
4 「そのままにする（おすすめ）」, 5 「50のまま出す（おすすめ）」, 6 「数を出す（おすすめ）」. So nothing of this file changes;
question 5, which section 8 puts to the owner before the release, is answered.

1. **1人で使える銘柄の数.**
   「株の MACD のメールで通知する株は、使う人全員で合わせて50銘柄までにします。この作り（v42）では、1人で50銘柄
   すべてを使うこともできます（そのあとは、ほかの人は、まだだれも通知していない株を足せません）。どうしますか？
   1. 1人の上限は付けない（おすすめ）。全員で50銘柄までだけにします。設定の画面に「〔N〕/50銘柄」と出ます。
   2. 1人あたりの上限も付ける（例: 1人20銘柄まで）。」

2. **Yahoo が足を出さなくなった株.**
   「上場廃止や銘柄コードの変更などで、Yahoo がある株の足を出さなくなることがあります（その時に Yahoo が何を
   答えるかは、まだ確かめていません）。その株では、メールは出ません。どうしますか？
   1. 自動では外さない（おすすめ）。設定の画面のその株の行に「アプリが Yahoo から読めた一番新しい足は
      〔日付〕（日本時間）のものです」と出し、チェックが外されるまで、50銘柄の1つに数えます。
   2. 足が届かない日が30日続いたら、その株のチェックを自動で外す（50銘柄の枠が1つ空きます。外したことは、
      メールでは知らせません）。」

3. **株の名前（保存・設定の画面・メール）.**
   「はじめからの22銘柄のほかに足した株は、Yahoo の検索が答えた名前を、アプリのデータベースに保存します（だれも
   通知しなくなった後も残します）。その名前を、その株を通知している人の設定の画面と、メールの件名と1行目に
   出します（チャートの検索に出る名前と同じです）。東証の株は、英語のメールでも日本語の名前になります（コードの
   注記による。確かめたのは、チャートの検索の作りだけです）。その株のメールの出どころの行は「足と値段と銘柄の
   名前は Yahoo Finance の公開データ」にします。別に、毎日1回、その株の一番新しい足の時刻と足の数（Yahoo から
   読んだもの）を保存して、設定の画面の注に使います（これは、どちらの答えでも同じです）。Yahoo のヘルプには
   『Yahoo Finance の情報を再配信してはいけない』と書かれています。メールには今も Yahoo の値段（足の終値）を
   書いていて、名前も Yahoo の情報です（規約に合うかどうかは、まだ結論を出していません）。どうしますか？
   1. Yahoo の検索の名前を保存し、設定の画面とメールに出す（おすすめ）。
   2. 名前は保存も表示もせず、設定の画面とメールは銘柄コードだけ（AAPL、7203.T のような形）にする。」

4. **株のメールが使えなくなった人の株.**
   「プランが終わるなどで株のメールが使えなくなった人のチェックは、この作り（v42）では消えません。その株は50銘柄の
   1つに数えたままで、Yahoo からも読み続けます（メールはだれにも送りません）。そういう株がいくつあるかも、今は
   数えていません。1人が50銘柄を埋めたまま使えなくなると、ほかの人は、まだだれも通知していない株を足せません。
   どうしますか？
   1. そのままにする（おすすめ）。枠が埋まって困った時は、オーナーの確認を1回ごとに取ってから、その行を外します。
   2. 株のメールが使えなくなった人のチェックを、自動で外す（作りが増えるので、別の変更として作ります）。」

5. **50銘柄のときの読みの重さ.**
   「上限の50銘柄は、1回の読みが30秒に収まることで選びました。これは今も同じです（50銘柄で約26.5秒。本番の
   速さからの計算で、50銘柄では測っていません）。ただ、見直しで、毎分の読みはふつう毎回新しく立ち上がった所で
   動くことが、記録から分かりました（FX の読みの記録から。株の読みでは、記録の1件がそれに合うだけで、数えては
   いません）。その場合、株は取引時間のあいだ、足の確定ごとではなく毎分読まれます。1つの市場で50銘柄だと、Yahoo の読みは
   1日に約2万回（米国株だけなら約20,300回、日本株だけなら約18,100回）、その市場の取引時間のあいだ（それぞれ
   約6〜7時間）、毎分約26.5秒かかります。FX と金のメールの判定は、同じ順番待ちの列で、この読みの後ろに並ぶ
   ことがあり、判定が遅れるかどうかは測っていません。通知される株が増えるほど重くなり、今いくつ通知されて
   いるかは、まだ読んでいません。どうしますか？
   1. 50銘柄のまま出す（おすすめ）。出した後、FX の判定が遅れていないかを記録で見て、遅れたら元に戻します。
   2. 測れるまで、上限を下げて出す（例: 25銘柄）。」

6. **「〔N〕/50銘柄」の表示で分かること.**
   「設定の画面に、使う人全員の合計「〔N〕/50銘柄」を出します。このため、株にチェックを入れた時や外した時に
   数が変わるかどうかで、ほかのだれかがその株を通知しているかが分かります（だれかは分かりません。ほかの株の
   ことも分かりません）。使う人が少ないと、だれかの見当がつくこともあります。どうしますか？
   1. 数を出す（おすすめ）。上限まであと何銘柄かが分かります。
   2. 数は出さず、上限に達した時だけ「足せません」と出す（それでも、足せなかったことや、Yahoo の確かめの
      答えから、その株をまだだれも通知していないことは分かります）。」
