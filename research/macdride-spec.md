# The MACD email as a ride: in at 90% with the flow, told at 96%

The owner (2026-11-12): 「MACD 90%→96%: 足の確定で入ると 96% まで行く メールをこれに変更、なので、一つのペアで2回
メールを送る」. Asked, the owner answered:

1. Email 1: at a 1-hour bar's close, the MACD line (blue) has come into the 90% band of the pane's top or bottom (the
   bar before was outside): an entry with the flow (top = BUY, bottom = SELL). Email 2: the moment the line reaches
   96% (「2通目で利確する感じ」).
2. The 95% contrarian email (v8) is stopped and replaced (「止めて入れ替える」).
3. Already at 96% at the entry bar's close: one notice, no entry (「知らせを1通だけ送る」).
4. The five pairs, gold and the shares, all (「5ペア・金・株を全部変える」).
5. The line leaves the band before 96%: held until it gets there, no notice (「96%に届くまで持ち続ける」); while held, no
   new email 1 for that chart and side.
6. Shares: looked at each 1-hour bar's close, not each minute (「1時間足の確定ごとに見る」).

This file fixes what the function does, so that it can be built, reviewed and replayed against the study
(research/macd90m-spec.md way C, docs §8.149). Everything about the line, the pane and "at a share" is
research/macd90-spec.md's and research/macd90m-spec.md's.

Measured (docs §8.149, five pairs, 2024-01-01 to 2026-11-10, after the spread): 801 trades, 800 reached 96%, of them
360 at a profit and 429 at a loss (11 at zero), +0.43 pips a trade on average, the worst −323.6 pips, the largest
loss on the way 558.8 pips, the longest about 28 days, 1 still open at −6.1 pips; 750 notices; 30 entries skipped.
Half of the reached trades were reached within 1 minute of the entry. Gold and the shares are **not measured**.
Email 2 is therefore **not** a take-profit as a fact: it says the line reached 96% and states the profit or loss
since email 1.

## 1. The rule

A chart is a pair (or gold, or a share) on its 1-hour bars. Closed bars oldest first, their closes as the chart
draws them (the five pairs: GMO's mid rounded, `historyRead`; gold: Twelve Data's stored bars, `historyOfBars`; a
share: Yahoo's, `stockBarsOf`).

- `SHARE_IN = 0.90`, `SHARE_OUT = 0.96` (the doubles 90 / 100 and 96 / 100), `LEVEL_WINDOW = 600`, `ZONE_BARS = 120`.
- A zone is `{ m, top, bottom }`. **At share `s`** on the top side: `top > 0 && m >= s * top`; on the bottom side:
  `bottom < 0 && m <= s * bottom` (research/macd90.ts `atShare`, the same expression).
- For a closed bar `i` with at least 600 closed bars up to it: `r = macd(the 600 closes ending at i)`;
  `Z(i) = zoneAt(r, 599)`, `Zp(i) = zoneAt(r, 598)` (their `m`, `top`, `bottom`).
- **Entry at bar `i`** on a pane side `S`: `Z(i)` at `SHARE_IN` on `S` and `Zp(i)` not at `SHARE_IN` on `S`. The
  trade side `D`: top → BUY, bottom → SELL. **Already**: `Z(i)` at `SHARE_OUT` on `S`.
- **The forming bar's line.** For a bar `j` whose 599 closed bars before it are `c[0..598]` (oldest first):
  `r = macd(c[0..598] + [any finite number])`, `e12 = pineEma(…, 12)[598]`, `e26 = pineEma(…, 26)[598]`,
  `sig = r.signal[598]`, `top119` / `bottom119` = the highest / lowest of `r.macd`, `r.signal`, `r.hist` over indices
  480..598, and 0 (research/macd90m.ts `prepare`). With a price `x` in the forming slot (`liveZone`):

  ```
  f = A12 * x + (1 − A12) * e12      s = A26 * x + (1 − A26) * e26      m = f − s
  g = A9 * m + (1 − A9) * sig        h = m − g
  top = max(top119, m, g, h)         bottom = min(bottom119, m, g, h)        A_n = 2 / (n + 1)
  ```

  This is the **state** of bar `j`: `{ e12, e26, sig, top119, bottom119 }`. It is bit for bit what `zoneAt` reads at
  index 599 of the window rebuilt with `x`.
- **Touch** of a ride on bar `j`: the line with `x` = the bar's high (top side) or low (bottom side) is at
  `SHARE_OUT` on the ride's pane side.

A **ride** is one trade of one chart and trade side: opened by email 1 at the close of its entry bar `e`, followed
from the first moment of bar `e + 1`, ended at the first touch (pairs and gold) or the first later closed bar `j`
whose `Z(j)` is at `SHARE_OUT` on its side (shares). No other way out. At most one open ride a chart and side; both
sides can be open at once.

**Skipped entry.** An entry (not already) at bar `i` on trade side `D` is skipped (nothing mailed) when another
ride of that chart and side with an entry bar before `i` is open, or was reached in a bar after `i`
(`reached_bar > open(i)`). A ride reached in bar `i` or earlier does not skip it (the study's `T0 >= T`).

**Quiet notice.** An already entry at bar `i` sends the notice, except when a ride of that chart and side was
reached in bar `i` itself (`reached_bar = open(i)`): the 96% email of that ride says the same thing. (Not the
study's concern: an already entry is no trade.)

## 2. The three mails

| mail | when | rule id (pairs and gold) | rule id (shares) |
|---|---|---|---|
| **in** (email 1) | an entry, not already, not skipped | `macdx_12_26_9_w600_1h_ride90to96of120_in_v9` | `stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2` |
| **at** (notice) | an already entry, not quiet | `…_ride90to96of120_at_v9` | `…_ride90to96of120_at_v2` |
| **out** (email 2) | a ride reached | `…_ride90to96of120_out_v9` | `…_ride90to96of120_out_v2` |

Built from the constants (`MACD_DEFAULTS`, `LEVEL_WINDOW`, `ZONE_BARS`, 90, 96), never typed twice. The ids start
with `macdx` / `stockmacd` (the app's list and the morning check go by the prefix); v8's ids are never used again.
The subscription rule names stay `macdx` and `stockmacd` (no subscription migration; the morning events email's
recipients are untouched). `indicatorRuleId("macdx")` / `("stockmacd")` give the **in** id; the row of each mail
is written under its own id.

The `signal_alerts` row of each (the claim's unique key is `user_id, kind, pair, interval, bar_time, side, rule`):

| | `bar_time` | `closed_at` | `side` | `entry` | `stop` | `target` |
|---|---|---|---|---|---|---|
| in | the entry bar's open | its close | `D` | the price paid (below) | null | null |
| at | the bar's open | its close | `D` (what an entry would have been) | the bar's close (mid) | null | null |
| out | **the ride's entry bar's open** | when it was seen | the ride's `D` | the ride's entry price | null | the price when seen (below) |

So one out row a ride and follower, whatever minute it is seen in; and an out row cannot collide with a new in or
at row of the same bar and side.

**Prices.** Entry price: the five pairs, the entry bar's ask close for a BUY and bid close for a SELL (GMO's, as
given); gold and shares, the bar's close (one price; no bid and ask). Price when seen: the five pairs, the leaving
side's newest price in the read that saw it (a BUY leaves on the bid, a SELL on the ask: the forming bar's bid / ask
close so far, or at a bar's close the newest closed bar's); gold, the newest recorded minute's close (per minute) or
the newest closed Twelve Data bar's close (at a close); a share, the newest closed bar's close. Profit or loss since
email 1: `(seen − entry)` for a BUY, `(entry − seen)` for a SELL; the pairs in pips (0.01 a pip on the yen pairs,
0.0001 on the others) to one decimal; gold in dollars (2 decimals) and said to hold no spread and two feeds; a
share in its currency and in percent of the entry, said to be close to close.

**Who.** Every follower of the chart under `macdx` (`stockmacd`) at the run that mails, each once (the claim). A
follower who came after email 1 gets email 2 alone; it names the entry bar and price, so it reads on its own.
Rides exist only on charts somebody follows under the rule at the time of the entry; a chart nobody follows is not
read, and its open rides wait.

## 3. What is kept

A migration (applied before the function goes out), modelled on `20261105060000_signal_alert_spike.sql`: RLS on, all
revoked from `anon` and `authenticated`, all granted to `service_role`. Written and read by signal-alerts only.

```sql
create table public.macd_rides (
  pair text not null,
  side text not null check (side in ('BUY', 'SELL')),
  entry_bar timestamptz not null,          -- the entry bar's open
  entry_closed_at timestamptz not null,
  entry_price double precision not null,   -- the price paid (section 2)
  entry_mid double precision not null,     -- the entry bar's close as the chart draws it
  share0 double precision,                 -- m / top (or bottom) at the entry
  status text not null default 'open' check (status in ('open', 'reached')),
  reached_at timestamptz,                  -- when it was seen
  reached_bar timestamptz,                 -- the open of the bar it was reached in
  seen_price double precision,             -- the price when seen (section 2)
  late boolean,                            -- seen in a closed bar, after the bar it was reached in had ended
  share1 double precision,                 -- m / top (or bottom) at the touch
  created_at timestamptz not null default now(),
  primary key (pair, side, entry_bar)
);
create unique index macd_rides_one_open on public.macd_rides (pair, side) where status = 'open';

create table public.macd_ride_state (
  pair text not null,
  bar_time timestamptz not null,           -- the open of the bar the state is for (the forming one when made)
  e12 double precision not null,
  e26 double precision not null,
  sig double precision not null,
  top119 double precision not null,
  bottom119 double precision not null,
  last_bar timestamptz not null,           -- the open of the newest closed bar used
  source_read_at timestamptz,              -- gold: the stored read it was made from
  computed_at timestamptz not null default now(),
  primary key (pair, bar_time)
);
```

Ride rows are never deleted by the function (a row is some 150 bytes; the record of how each ride turned out is
these rows). State rows over 8 days old are deleted when a state is written (the Tuesday check counts Friday).
Shares keep no state rows: every read brings the bars.

Nothing else survives a run: an instance's memory may hold a copy (as `spikeRangeMemo`), never the only one.

## 4. The shared code: `supabase/functions/_shared/macd-ride.ts`

Pure functions, no clock, no I/O, used by the function and by the replay (section 9). `_shared/macd-level.ts` is
**not changed** (`ZONE_PCT`, `ZONE_SHARE`, `zoneAt`, `zoneEntryAt`, `decideZoneOnWindow` stay as they are: research
files and the old ids rest on them). At least:

- `atShare(z, zside, s)`; `shareOf(z, zside)`.
- `rideEntryAt(closes600)` → `null` or `{ zside, side, already, z: Z(i), zp: Zp(i) }` (null on fewer than 600, on a
  MACD with a gap, or no entry).
- `rideStateOf(closes599)` → the state, or null (fewer than 599 finite closes, a gap).
- `rideLineAt(state, x)` → `{ m, top, bottom }`.
- `rideTouch(state, zside, high, low)` → null or `{ m, top, bottom, share }`.
- `rideCloseStep(...)`: what a bar's close does, from the entry at the bar and the chart's ride rows: `in`, `at`,
  `skip`, `quiet` or nothing (the rules of section 1), so that the function and the replay cannot differ.
- the first touched bar among closed bars after a ride's entry bar (section 5's catch-up; shares' by the close).

`_shared/macd-ride.ts` is imported by `signal-alerts/indicators.ts` and `stocks.ts`, so it must be added to the paths
of `.github/workflows/lawsearch-audit.yml` (its import-graph check), and it enters live-chart's and econ-calendar's
bundles (pure code; nothing else of theirs changes).

## 5. The five pairs and gold (the "indicators" run, every minute)

Only for a chart in `MACDH_PAIRS` on `1h` with at least one `macdx` follower in this run. Every step in its own
try / catch: a failure here must never cost Q-Trend's, ULTRA's, AMD Po3's, the EMA way's or the spike's emails, nor
another pair's ride.

**A. At a close** (inside `judge`, on the runs that have the chart's closed bars in hand: the pairs at minutes 0, 3
and 5, gold from a minute after the hour while its bar is not judged), with `i` the newest closed bar:

1. Read the chart's ride rows: the open ones and those whose entry bar is in the newest 100 closed bars (small rows).
   The table unread (an error, not there): nothing of the ride is done for this chart in this run (no state, no
   mail), and the run's record says so. Never a fallback that reads more.
2. **State** of the bar now forming: from the 599 newest closed closes (when at least 599 are in hand), upserted
   into `macd_ride_state` under the forming bar's open (`open(i) + 1 hour`); state rows over 8 days old deleted.
3. **Catch-up.** For each open ride with entry bar `e`: the closed bars `j` after `e` among the newest 100, oldest
   first; the first whose high (top side) / low (bottom side), as the chart draws them, touches (the line of bar `j`
   from the closed bars before it: the EMAs and signal of the 600 closes in hand read at the index before `j`, the
   pane over the 119 before `j`). For `j = i` this is bit for bit the study's state of bar `i`; for an older `j` the
   EMA's seed is at most 100 bars later than the study's, a difference under 1e-12 of the price (not bit-equal;
   said in section 10). A touch → the ride is **reached**, `reached_bar = open(j)`, `late = true`, the price when
   seen the newest closed bar's (section 2).
4. **Entry** at bar `i`, while it closed at most `freshFor("1h")` (30 minutes) ago: `rideCloseStep`, on the ride
   rows as they stand after step 3 (a ride reached there counts as reached in its `reached_bar`). `in`: insert the
   ride row (`on_conflict=pair,side,entry_bar`, duplicates ignored), then read it back; mail email 1 only when the
   row for this bar exists (inserted now or by an earlier run). `at`: mail the notice. `skip`, `quiet`: no mail; the
   run's record says which.

**B. Each minute** (beside the spike block, after the closes of this run were judged, so a ride opened in this run
is followed in this run): read `macd_rides` rows that are open or were reached in the last 30 minutes (one small
read for all charts). For each chart with an open ride whose entry bar is before the forming bar:

1. The forming bar's state: the instance's memo, else its row in `macd_ride_state` (a few bytes). None → this
   chart's forming bar is not judged in this run (`state: null` in the record). It is never worked out here from the
   big rows (the database's egress); the next close's catch-up covers the hour.
2. The forming bar's high and low so far: the five pairs, GMO's forming 1-hour bar (mid of bid and ask, rounded as
   the chart draws, exactly as the spike block reads it: the same read is shared, one GMO read a pair a run at
   most); gold, the highest high and lowest low of the minutes recorded this hour in `public.gold_tick_bars`
   (rounded to 2 decimals; no need for the hour's open, unlike the spike's bar).
3. A touch → **reached**, `reached_bar` = the forming bar's open, `late = false`, the price when seen the newest in
   that read (section 2).

So emails 1 and 2 can go out in the same run (a touch in the first seconds of the bar after the entry): in the
study half of the reached trades were reached within a minute. Email 1 is mailed before email 2.

**Reached** (from A.3 or B.3): `PATCH macd_rides` where the row is still `open` (`status=eq.open` in the filter),
setting `status`, `reached_at`, `reached_bar`, `seen_price`, `late`, `share1`, with `return=representation`. No row
back: another run did it; read the row. Email 2 is written from the **row**, so every run mails the same numbers.
Then, for every ride reached in the last 30 minutes (B's read), email 2 to each follower with no out row for it yet
(the rows already there are read first and left out before any lookup, as the spike block does); the claim's key
keeps two runs from both mailing. A send that failed is not sent again (as every email here); a follower whose
lookup failed is tried again by the next run within the 30 minutes.

**The run's record** (`summary.reads`, read by the morning Routine from `net._http_response`): the judged chart's
entry keeps its shape and gains `ride` (`rows`: `ok` / `unread`; `state`: `ok` / `short`; `step`: `in` / `at` /
`skip` / `quiet` / null; `caught`: the rides reached by the catch-up). Its `signals` say `macdx:BUY` for email 1,
`macdx-at:BUY` for the notice and `macdx-out:BUY` for email 2 (the shares' run: `stockmacd:`, `stockmacd-at:`,
`stockmacd-out:`), each only when a row was made for it in this run or was already there. B's entries are separate
and carry `ride: true` (as the spike's carry `spike: true`), only for a chart with an open ride or a ride mailed in
this run: `forming`, `state`, `open` (how many), `high`, `low`, `signals`. No user id, address or row id is ever
written into the record or the log.

**Unwatched time** (said in section 10): the hours the function does not run (the weekend gate, market closed), an
hour whose state could not be made (GMO late at 0, 3 and 5; gold's first hour after its daily break and the first
minutes of every hour), a failed run. A touch in them is seen by the next close's catch-up, and its email 2 says it
was seen late, in which bar, and the price now.

## 6. The shares (the "stocks" run)

For a share somebody follows under `stockmacd`, on a read of Yahoo's bars in which the newest closed bar `n` has
not been judged by this instance (as today):

1. Read the share's ride rows (open ones and the recent). Unread → nothing of the ride in this run.
2. For each open ride with entry bar `e`: the closed bars `j` after `e` among the newest 100, oldest first; the
   first whose `Z(j)` (on its own 600 closed bars) is at `SHARE_OUT` on the ride's side → **reached**,
   `reached_bar = open(j)`, `late = (j is not n, or n ended more than STOCK_FRESH_MS ago)`, the price when seen
   `n`'s close.
3. Entry at `n`, while it ended at most `STOCK_FRESH_MS` (45 minutes) ago: `rideCloseStep`, as section 5 A.4.
4. Email 2 for the rides reached in the last 45 minutes to the followers with no out row yet.

No state rows, no minute reads. Both sides can be open on one share; a SELL on a share is a short sale and the mail
says so.

## 7. Once only, whatever is repeated

The same closed bar is judged again and again (the pairs at 0, 3 and 5 on a fresh instance, gold every minute to
29, a share some 30 times a window), and a ride often ends within a minute of its entry. Required, and to be shown
by tests that replay a run several times over the same fake tables:

- re-judging an entry bar whose ride is already open, or already reached: no second ride, no second email 1 to a
  follower who has one, email 1 still goes to a follower whose earlier lookup failed;
- re-judging after an older ride of that side was reached in a later bar: still skipped;
- two runs reaching the same ride: one transition, the same numbers in both mails, one email 2 a follower;
- a ride reached in bar `k`, and bar `k` closing as a new entry on that side: email 2, then email 1 for the new
  ride (or no notice when already: quiet);
- the state row written twice is the same row.

## 8. The mails and the screen

Japanese and English, the same facts in both. The tab and label `MACD の山・谷` / `MACD peak/valley` no longer says
what the rule does (it buys near the top): renamed **「MACD の流れ」 / "MACD ride"** everywhere it is shown
(`RULE_LABEL`, the test email's list, the settings tabs and tags, the chart's and FAQ's mentions, the mails'
how-to-stop lines, and the morning events email's footer in `econ-calendar/digest.ts`, which is deployed by name).
`株の MACD` / `Stock MACD` stays. The subscription keys do not change.

**Subjects** (ja; en likewise): in 「【Sextant】ドル/円 1時間足 買い（BUY）で入る合図（MACD の流れ・1通目）」; at
「【Sextant】ドル/円 1時間足 知らせ: もう96%です（MACD の流れ・入る合図なし）」; out 「【Sextant】ドル/円 1時間足
96%に届きました（MACD の流れ・2通目、買いの分）」. Shares: the share's name and code as today, 「株の MACD」 in
place of 「MACD の流れ」.

**Email 1** says: the bar judged; that the blue line came into the 90% band of the top (bottom) of the newest 120
bars' MACD pane with the bar before outside it, so the entry is with the flow, a BUY (SELL); `MACD`, the pane's
edge on that side, its 90% and its 96% (the edge is the **pane** side: top for a BUY, bottom for a SELL — the
opposite of v8's mails; decimals as `macdNumbers` picks them from that edge); the price paid (pairs: 「買値」 / 「売値」
of the close; gold and shares: the close); that the second email comes when the blue line reaches 96% of the same
edge, that there is no stop and no target, that nothing is sent if the line leaves the band, and that no new first
email comes for this chart and side until then; the measured paragraph below; the source line, the app link, how
to stop, the disclaimer (as today).

**The notice** says: the bar; that the line came into the 90% band and was already at 96% or more at the close, so
no entry is sent; the three numbers.

**Email 2** says: the first email's bar, side and price; that the blue line reached 96% of the top (bottom), seen
at (JST) — or, late, 「〔その足〕の間に届いていました。その時は読めず、今見つけました」; the price now and the profit or
loss since the first email (section 2), with its sign; how long it was held; and that this email reports the line
reaching 96%, **not** that the trade is at a profit (「損益はプラスとは限りません」). The word 「利確」 / "take-profit" is
not used for it as a fact, and 「必ず戻る」 / "always comes back" is written nowhere.

**The measured paragraph** (email 1 and the settings notes; the numbers of docs §8.149, as constants in one place):
the five pairs, 2024-01 to 2026-11-10, after the spread: 801 entries, 800 reached 96%, of them 360 at a profit and
429 at a loss, +0.43 pips an entry on average, the worst −323.6 pips, the largest loss on the way 558.8 pips, the
longest about 28 days, 1 not reached yet (−6.1 pips); the reach rate is high by construction (no stop); the
function reads GMO's 1-hour bar each minute, the study read 1-minute bars, and that difference is measured by the
replay (section 9) or said not to be. Gold: 「金では測っていません」 before the pairs' numbers. Shares: 「株では測って
いません」 and no numbers (docs §8.133's belong to the rule replaced); a Tokyo share keeps the 15-minute sentence.

**No stop or target** is printed or stored for these mails (ULTRA's numbers go; `sl` and `tps` null).

**The screen.** The settings' intro and notes of both tabs describe this rule and its measured numbers (ja and en
keep the same keys and array lengths). The recent list tells the three apart from the full rule id (`_in_`, `_at_`,
`_out_`): in as an entry (green / red as today), out as 「96%に届いた（買いの分）」 and at as 「知らせ（もう96%）」 in a
neutral colour, the out row's two prices labelled the first email's and the one when seen. FAQ answers that say
the MACD email "is not measured" or "arrives minutes after the bar closes" are corrected. Nothing new is drawn on
the chart.

## 9. Checks

- **Unit tests** (vitest) of `_shared/macd-ride.ts`: the state and line against `zoneAt` on the window rebuilt (bit
  for bit, random walks); `rideEntryAt` against research/macd90.ts's entries; `rideCloseStep`'s table of cases.
- **Function tests**: section 7's replays over fake tables; the row of each mail; the texts.
- **The replay** (`research/macdride-replay.ts`, run in GitHub Actions on the study's data): the shared code driven
  bar by bar and minute by minute over the five pairs' real bars, as the function would (close steps, state, touch,
  skip), with an in-memory ride table. Reading R1, each hour's high and low so far as the running extremes of the
  1-minute mid highs and lows (the study's reading): its trades must equal research/macd90m.ts's way C close rows
  (entries, already, skipped, the minute reached), all of them, or the run fails. Reading R2, as the function reads
  GMO's forming 1-hour bar (the mid of the running bid high and running ask high, and of the lows): the count of
  trades reached in another minute than R1's and the profit or loss a trade, printed: the measurement of the
  function's own reading.
- `npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and econ-calendar.

## 10. Known differences from the study, and what is not measured

- The function sees a touch when a run reads it (seconds to a minute after), and prices email 2 then; the study
  left at the touching minute's close.
- R2's reading against R1's (section 9), measured by the replay.
- Catch-up bars older than the newest closed one: EMA seeds up to 100 bars later than the study's (under 1e-12).
- Unwatched time (section 5): a touch seen late; a touch in a bar that has left the newest 100 closed bars
  unseen (the function not running for over four trading days) is never seen, and the ride waits for the next.
- An entry bar that could not be judged in its 30 (45) minutes starts no ride; the stored rides are what the
  function goes by.
- Gold: the state from Twelve Data's closes, the minute's price from Swissquote's mid, no bid and ask: **not
  measured**. Shares: Yahoo's bars, judged at closes, a SELL is a short sale, a session's last bar cannot be traded
  until the next open: **not measured**.
- When the function goes live there is no ride; a line already inside the 90% band starts none until it has left
  the band and come back (the entry needs the bar before outside).
- No function settles the rides into a daily report; `macd_rides` holds each ride's entry, price seen and times.

## 11. Release

`FUNCTION_VERSION` raised (pinned in six test files). Order: the migration applied → the merge (deploys
signal-alerts and live-chart from source) → econ-calendar deployed by name (the footer's tab name) → the screen
published. The merge in minutes 30 to 59 of an hour (no pair or gold bar is being judged) and outside the 45
minutes after any share close, so no bar is mailed by both versions. The morning check (scripts/morning-check) and
the Routine's prompt are rebuilt for the new ids at the same time; its earlier files stay byte for byte.
