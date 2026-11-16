# The MACD ride, v10: email 1 the moment the line touches 90%, email 2 at 95%

The owner (2026-11-16), after the MACD ride (v9, research/macdride-spec.md) had gone live: 「やっぱりメール 90% に
届いた時点で送って」. Told that email 1 is sent at the 1-hour bar's close and what the study measured for each form
(docs §8.149), the owner answered 「やっぱり95%に届いた時点に変える、あとこの場合を測ってみて」, and, asked which email,
「1通目90%触れ・2通目95%」; the shares 「今のまま」. Shown the measured numbers of the forms (docs §8.154), the owner
chose 「90%触れ→95%に変える」.

So, from v10:

1. **The five pairs and gold**: email 1 the moment (the minute's run) the MACD line, worked out with the forming 1-hour
   bar's high so far (top side) or low so far (bottom side) as that bar's close, touches 90% of the pane's top (a BUY)
   or bottom (a SELL), the bar before having closed outside the 90% band on that side. Email 2 the moment the line
   touches 95% of the same edge. This is research/macd90m-spec.md's **moment** entry with **way C** and `REACH = 0.95`.
2. **The shares**: email 1 stays at the 1-hour bar's close (v9's), email 2 and the notice move from 96% to 95%.
3. Everything else of v9 stays (research/macdride-spec.md): one notice and no entry when the line is already at the
   exit level (「知らせを1通だけ送る」), held until it gets there with no other way out and no new email 1 for that chart and
   side meanwhile (「96%に届くまで持ち続ける」, now 95%), both sides apart, no stop and no target, the subscription rule
   names `macdx` / `stockmacd`, the tables, the claim, the language rules of the mails.

Measured (docs §8.154, five pairs, 2024-01-01 to 2026-11-10, after the spread; the study's reading): 2,538 touches of
90%, of them 707 already at 95% in the same minute (notices) and 557 while the same side was held (skipped); 1,274
trades, 1,271 reached 95%, 882 at a profit, 384 at a loss, 5 at zero; −0.03 pips a trade on average (median +3.10);
the worst −541.6 pips; the largest loss on the way 712.0 pips; held up to 29,220 minutes (about 20 days); 3 still
open, −247.1 pips together. The reach rate is high by construction (no stop). Gold and the shares are **not measured**
in this form. Email 2 is therefore not a take-profit as a fact (as v9).

What this file does not say is research/macdride-spec.md's. A section here replaces the section of the same subject
there for v10; research/macdride-spec.md itself stays as it is (it is the record of v9).

## 1. The rule of the pairs and gold

As research/macdride-spec.md section 1 (the chart, its closed bars and closes, `LEVEL_WINDOW = 600`,
`ZONE_BARS = 120`, a zone, **at share `s`**, `Z(i)`, `Zp(i)`, the state of a bar and the line with a price `x` in
its forming slot), with:

- `SHARE_IN = 0.90`, `SHARE_OUT = 0.95` (the doubles 90 / 100 and 95 / 100).
- **The bar before, judged in the bar's window**: for the forming bar `j`, `Zp(j)` — the zone at index 598 of the
  window of the 599 closed closes before `j` with any price in slot 599. Nothing at index 598 depends on that price,
  so `Zp(j) = zoneAt(macd(the 599 closed closes before j), 598)` (EMAs are causal: research/macd90m-spec.md). It is the
  study's `zp[j]` bit for bit. It is **not** `Z(j−1)` on its own window (that window starts a bar earlier). `Zp(j)`
  cannot be worked out from the state's five numbers (its pane covers indices 479..598, the state's 480..598), so it
  is kept beside them (section 3).
- **The bar's running extremes**: while bar `j` forms, `hi` its highest high so far and `lo` its lowest low so far,
  as section 4 reads them. `hi` only rises and `lo` only falls while a bar forms.
- **Touch** of a share `s` on a pane side at a read of bar `j`: the line with `x = hi` (top side) or `x = lo`
  (bottom side), worked out from the state of bar `j`, is at `s` on that side.

The line's "at `s`" can only switch on as `x` moves toward its side: on the top side `m`, the signal and the
histogram all rise with `x` (`A12 > A26`), and `m ≥ s · max(top119, m, g, h)` is then monotone in `x`; the bottom
side likewise. With running extremes, a touch once made stays made for the rest of the bar, and the first read that
touches sees the extreme of the moment that touched (research/macdride-replay.ts's header; to be shown again by
section 9's R1).

### 1.1 The bar's one decision

A bar `j` of a chart has **at most one decision**, the first, made at the first read of bar `j` (with its state and
`Zp(j)` in hand) that has a **hit**:

- **hit**: the top side when `Zp(j)` is not at `SHARE_IN` on the top side and the read touches `SHARE_IN` on the top
  side; else the bottom side likewise. (The top side is looked at first: when a read finds both, which only happens
  when reads were missed, the top side decides; the study reads a minute touching both on the top side.) The trade
  side `D`: top → BUY, bottom → SELL. **Already**: the read also touches `SHARE_OUT` on that side.
- The **step** of the decision, with the chart's rides as they stand after this read's reaches (section 4 B.3):
  - **at** (the notice): already, and no ride of the chart and side was reached by this same read;
  - **quiet** (no mail): already, and a ride of the chart and side was reached by this same read (its email 2 says
    the same);
  - **skip** (no mail): not already, and a ride of the chart and side is open;
  - **in** (email 1): not already, and no ride of the chart and side is open.

  An already decision is never skipped and skips nothing (research/macd90m-spec.md way C).
- The decision is kept (section 3) and stands: no later read of bar `j` makes another, on either side, whatever it
  reads. A bar with no hit by its end has no decision.

So a bar has at most one entry, as the study's "at most one moment entry a bar" (the first minute, either side,
already or skipped included).

### 1.2 A ride

A **ride** is one trade of one chart and trade side, opened by an **in** decision at its read (the **entry
moment**), at the **entry price** (section 2). It is followed from the next read on: its **reach** is the first later
read, of bar `j` or a later bar, that touches `SHARE_OUT` on its side. No other way out. At most one open ride a
chart and side; both sides can be open at once (as v9).

A read of the entry bar after the entry moment can reach the ride: the bar's running extreme at the entry read did not
touch `SHARE_OUT` (else the decision would have been already), so a later touch in the same bar comes from a price
after the entry read (one feed; section 10 says where gold's two feeds break this).

## 2. The mails

| mail | when | rule id (pairs and gold) | rule id (shares) |
|---|---|---|---|
| **in** (email 1) | an in decision (pairs and gold) / v9's in step (shares) | `macdx_12_26_9_w600_1h_touch90to95of120_in_v10` | `stockmacd_12_26_9_w600_1h_ride90to95of120_in_v3` |
| **at** (notice) | an at decision / v9's at step | `…_touch90to95of120_at_v10` | `…_ride90to95of120_at_v3` |
| **out** (email 2) | a ride reached | `…_touch90to95of120_out_v10` | `…_ride90to95of120_out_v3` |

Built from the constants (`MACD_DEFAULTS`, `LEVEL_WINDOW`, `ZONE_BARS`, 90, 95, and the entry's word: `touch` for
the pairs and gold, `ride` for the shares' close entry), never typed twice. v9's and v2's ids are never used again.
The subscription rule names stay `macdx` and `stockmacd`; `indicatorRuleId` gives the **in** id. The app tells a
ride's mail and its exit level from the full rule id (`_(touch|ride)(\d+)to(\d+)of120_(in|at|out)_`): a v9 row still
reads 96%, a v10 row 95%.

The `signal_alerts` row of each (the claim's key unchanged):

| | `bar_time` | `closed_at` | `side` | `entry` | `stop` | `target` |
|---|---|---|---|---|---|---|
| in (pairs, gold) | the entry bar's open | **the entry moment** | `D` | the entry price | null | null |
| at (pairs, gold) | the bar's open | **the decision's moment** | `D` | the decision's mid (below) | null | null |
| out | the ride's entry bar's open | when it was seen | the ride's `D` | the ride's entry price | null | the price when seen |
| in, at (shares) | as v9 | as v9 | as v9 | as v9 | null | null |

One email 1 a bar and side (one decision a bar), one notice a bar, one email 2 a ride and follower.

**Prices of a decision** (pairs and gold), all from the read that made it:
- the entry price: a pair's newest ask for a BUY and newest bid for a SELL (the forming 1-hour bar's ask / bid close
  so far, as GMO gives it); gold's newest recorded minute's close (one price, no bid and ask);
- the decision's mid: a pair's newest mid (the forming bar's mid close so far, rounded as the chart draws it); gold's
  newest recorded minute's close;
- `x`: the running extreme the decision was made with (`hi` or `lo`), and `share0` the line's share there.

The price when seen and the profit or loss of email 2: as v9 (section 2 there).

## 3. What is kept

One migration (applied before the function goes out), modelled on `20261112120000_macd_rides.sql` (RLS on, all
revoked from `anon` and `authenticated`, all granted to `service_role`; written and read by signal-alerts only, no
user column):

```sql
alter table public.macd_ride_state
  add column zp_m double precision,       -- Zp of the bar the state is for: the line, and the pane's top and bottom
  add column zp_top double precision,     -- (null on a row written before v10: such a row starts no decision)
  add column zp_bottom double precision;

create table public.macd_ride_moments (
  pair text not null,
  bar_time timestamptz not null,           -- the open of the bar decided
  side text not null check (side in ('BUY', 'SELL')),
  step text not null check (step in ('in', 'at', 'skip', 'quiet')),
  decided_at timestamptz not null,         -- the read's moment (for in: the entry moment)
  source text not null check (source in ('minute', 'close')),  -- a minute's read (4 B) or a close's tail (4 A.4)
  price double precision not null,         -- the entry price (section 2)
  mid double precision not null,           -- the decision's mid (section 2)
  x double precision not null,             -- the running extreme read (hi or lo)
  share0 double precision not null,        -- the line's share at x
  created_at timestamptz not null default now(),
  primary key (pair, bar_time)
);
```

`macd_rides` is unchanged. A v10 ride's row: `entry_bar` the entry bar's open, **`entry_closed_at` the entry moment**
(the column keeps its name), `entry_price` the entry price, `entry_mid` the decision's mid, `share0` at `x`; the rest
as v9. Moment rows are never deleted (a few a day; the record of each bar's decision). State rows over 8 days old are
deleted as in v9.

Before v10 goes out no ride may be open (section 12); every open row a v10 function reads is a v10 ride, followed to
95%.

## 4. The function: the pairs and gold

Only for a chart in `MACDH_PAIRS` on `1h` with at least one `macdx` follower in this run, every step in its own try /
catch as v9 (a failure must never cost another rule's email, nor another chart's ride). `F` is the open of the hour
now (the forming bar).

**Reading the bar's running extremes and newest prices** (one read a chart a run at most):
- the five pairs: GMO's forming 1-hour bar (`rideFormingOf`): `hi` / `lo` the mid of the bid and ask highs / lows so
  far rounded as the chart draws them, the newest bid and ask, and the newest mid (rounded); the read shared with the
  sharp rise (one GMO read a pair a run at most), skipped past the deadline or in maintenance (as v9);
- gold: this hour's recorded minutes (`public.gold_tick_bars`, Swissquote's mid, 2 decimals): `hi` / `lo` the highest
  high / lowest low of the minutes of the hour, the newest minute's close as the price and the mid.

### A. At a close (inside `judge`, on the runs that have the chart's closed bars in hand; `i` the newest closed bar)

1. Read the chart's ride rows as v9 (5 A.1), with one change: also those whose entry bar is `i` itself. Unread →
   nothing of the ride for this chart in this run (as v9).
2. **State** of the bar now forming (`F = open(i) + 1 hour`): v9's five numbers and `Zp(F)` from the 599 newest closed
   closes, upserted into `macd_ride_state` (as v9, with the three new columns).
3. **Catch-up** (as v9 5 A.3 at `SHARE_OUT`, with one change): for a ride entered at a moment, the closed bars `j` with
   `open(j) ≥ entry bar` are judged — the entry bar too (section 1.2) — for the pairs from the closed bar's high / low
   as the chart draws them; for gold the entry bar is judged from the hour's recorded minutes after the entry minute
   (none recorded, or no longer kept: the entry bar is not judged), the later bars from Twelve Data's bars as v9. A
   touch → reached, `late = true`, email 2 at once (before step 4).
4. **The tail of bar `i`** (a touch in its last moments, after the last minute's read): while bar `i` closed at most
   `freshFor("1h")` (30 minutes) ago, bar `i` has no decision (its moment row read; unread → nothing), and the state
   of bar `i` with its `Zp(i)` is in hand (memo or row): a hit read from bar `i`'s **final** extremes (the pairs: the
   closed bar's high / low as the chart draws them; gold: the extremes of the hour's recorded minutes) makes bar `i`'s
   decision, `source = 'close'`, its prices the newest of this read (a pair's: the forming bar's newest bid / ask / mid
   when GMO gives one, else bar `i`'s closes; gold's: the newest recorded minute's close), its moment this read's. The
   step as section 1.1, with the rides as they stand after step 3 (quiet: a ride of the side reached by step 3 in bar
   `i`). Then as B.5 below.
5. No other entry at a close (v9's close entry, `rideEntryAt` / `rideCloseStep`, is not used for the pairs and gold).

A ridden chart is held judged by an instance only when the ride's work on the bar finished (as v9).

### B. Each minute (after this run's closes were judged and after the sharp rise, as v9)

1. **One read** of `macd_rides` for all charts followed (as v9: open, or reached in the last 30 minutes), one of
   `macd_ride_moments` (bar `F` and the bar before, all charts followed), and the state of `F` (memo, else one read of
   `macd_ride_state` for all charts followed whose memo lacks it; `bar_time = F`, the five numbers and the three new
   columns). Any of these unread → nothing of the ride in this run for the charts it concerns (the record says which).
2. For each chart followed: the state of `F` and `Zp(F)` (none, or `Zp` null → `state: null`, nothing judged for this
   chart's forming bar). Then the bar's running extremes and newest prices (one read). None → nothing judged.
3. **Reaches first**: each open ride of the chart whose entry moment is before this read (not a ride opened by this
   run) — a touch of `SHARE_OUT` on its side → reached (as v9: `reached_bar = F`, `late = false`, the price when seen
   the newest on the side it leaves on, `share1`), PATCHed where still open, email 2 written from the row.
4. **Then the decision**, while bar `F` has none: a hit (section 1.1) makes it, `source = 'minute'`, with the step from
   the rides as they stand after step 3.
5. **Keeping and acting on a decision** (here and in A.4): insert the moment row (`on_conflict=pair,bar_time`,
   duplicates ignored), then read it back: the row is **the** decision (another run may have made it first; its
   numbers are what every run mails). Then by its step:
   - **in**: insert the ride row from the decision (`entry_bar = bar`, `entry_closed_at = decided_at`, the prices;
     duplicates ignored), read it back; email 1 only while the ride row exists and is still **open** (a ride already
     reached gets no email 1 any more: `over`, as v9);
   - **at**: the notice;
   - **skip**, **quiet**: no mail; the record says which.
6. **Mails left over**: for each decision of the last 30 minutes (`decided_at`), email 1 (in, ride still open) or the
   notice (at) to each follower with no row for it yet; for each ride reached in the last 30 minutes, email 2 (as v9).
   Of one ride, email 1 before email 2 in a run (a ride opened and reached in the same run cannot happen: B.3 skips a
   ride opened by this run).

**The run's record**: B's entries (carrying `ride: true`) say, for a chart: `forming`, `state` (`ok` / null), `hi`,
`lo`, `decided` (the bar's step, null when none), `made` (true when this run made it), `source`, `open` (how many rides
open), `signals` (`macdx:BUY` email 1, `macdx-at:BUY` the notice, `macdx-out:BUY` email 2), `unsent` — written for a
chart whose bar was looked at in this run (no decision yet, or one made now), or that has an open ride, or that mailed.
A's entries gain `tail` (the step made at the close, or null) beside v9's `ride`. No user id, address or row id is
ever written.

**Cost**: per minute and chart followed, until the bar is decided: the forming bar's read (a pair's shared with the
sharp rise; gold's recorded minutes of the hour, a few kilobytes) and three small reads shared by all charts (rides,
moments, state). Once the bar is decided and no ride of the chart is open, nothing more is read for that chart in that
bar. The closed bars are never read each minute (the database's egress; v9's comment).

**Unwatched moments** (section 10): a minute with no run, a run whose forming read failed, the minutes of an hour
before its state is written (the pairs: the close is judged at minutes 0, 3 and 5; gold: from a minute after the
hour), the week's first hour (its state is made from Friday's close, which is not judged), a state written before v10
(no `Zp`). A touch there is decided by the first later read that has the state — at that read's prices — or, in the
bar's last moments, by the close's tail; an hour with no state is never decided.

## 5. The shares

As research/macdride-spec.md section 6, at `SHARE_OUT = 0.95` (the notice when `Z(i)` is at 95%, the reach when a
later closed bar's `Z` is at 95%) and with the v3 ids. Nothing else changes.

## 6. The shared code: `supabase/functions/_shared/macd-ride.ts`

Pure, no clock, no I/O, used by the function and the replay (as v9). At least:

- `RIDE_IN_PCT = 90`, `RIDE_OUT_PCT = 95`, their shares; the tags (`touch90to95of120`, `ride90to95of120`) and
  `rideRuleId(prefix, tag, mail, version)`.
- `rideZpOf(closes599)` → `Zp` of the bar after them, or null; `rideStateOf` unchanged, and a state that carries `Zp`
  (or both returned together) for the function to keep.
- `rideTouchAt(state, zside, x, share)` → null or the touch (`rideTouch` at `SHARE_OUT` stays its special case).
- `rideHit(state, zp, hi, lo)` → null or `{ zside, side, x, z, share0, already }` (section 1.1's hit: top first).
- `rideMomentStep(hit, rides, reachedNow)` → `in` / `at` / `skip` / `quiet` (section 1.1), from the chart's open rides
  and those reached by this read.
- the catch-up (`rideCatchUp`) able to include the entry bar (section 4 A.3), and the shares' by close (as v9) at 95%.
- `rideEntryAt` / `rideCloseStep` stay for the shares (already at 95%).

## 7. Once only, whatever is repeated

As research/macdride-spec.md section 7, with, to be shown by tests replaying runs (several each minute, instances fresh
and kept) over fake tables:

- two runs reading the same touch: one decision, one ride, the same numbers in every mail, one email 1 a follower;
- a later read of a decided bar with another extreme (the other side touched, or 95% now): no second decision, no
  notice on top of an email 1;
- a decision made but its ride row not written (a failure between): the next run writes the ride from the decision and
  mails email 1;
- a ride opened at a read and the same bar touching 95% at a later read: reached in the entry bar, email 2;
- a touch in the last moments of a bar seen by the close's tail: one decision (`source = 'close'`), not doubled by the
  next minute's read of the new bar;
- a ride reached by a read whose touch is also the bar's first 90% touch on that side: email 2, the decision quiet;
- a skip while a ride of the side is open, and an in at a read after that ride was reached;
- a follower whose lookup failed gets email 1 (the notice) at a later run within 30 minutes, never after the ride is
  reached.

## 8. The mails and the screen

As research/macdride-spec.md section 8, with these changes (Japanese and English, the same facts):

- **Subjects**: in 「【Sextant】ドル/円 1時間足 買い（BUY）で入る合図（MACD の流れ・1通目）」 (unchanged); at 「…知らせ:
  もう95%です（MACD の流れ・入る合図なし）」; out 「…95%に届きました（MACD の流れ・2通目、買いの分）」. Shares: 95% in
  place of 96%.
- **Email 1** (pairs, gold): the bar (its open, forming) and the moment seen (JST); that the blue line, worked out
  with this bar's high (low) so far as its close, touched 90% of the top (bottom) of the 120-bar MACD pane, the bar
  before having closed outside the band, so the entry is with the flow, a BUY (SELL); `MACD` at the touch, the edge,
  its 90% and its 95%; the price paid (pairs: 「この時の買値」 / 「売値」; gold: the newest minute's price); that email 2
  comes when the line touches 95% of the same edge, with no stop and no target, that nothing is sent if the line leaves
  the band, and no new email 1 for this chart and side until then; that the moment is the minute's check (a touch
  between checks is seen at the next, at its price); the measured paragraph; the rest as today.
- **The notice**: the bar and moment; that the line touched 90% and was already at 95% or more at that read, so no
  entry; the numbers.
- **Email 2**: as v9 at 95%, with 「1通目の時刻からの時間」 (the time since the entry moment) in place of the time since the
  entry bar's close, and the entry bar named by its open and email 1's moment.
- **The measured paragraph** (`RIDE_MEASURED`): the numbers of the replay with the function's own reading (section 9's
  R2) beside the study's (R1 = docs §8.154: 1,274 trades, 882 at a profit, 384 at a loss, −0.03 pips a trade, the
  largest loss on the way 712.0 pips, held up to about 20 days, 3 open), with what differs; that the reach rate is high
  by construction; that more reached at a profit than at a loss but the losses were larger, so the mean is about zero
  after the spread. Gold 「金では測っていません」, shares 「株では測っていません」 (no numbers), as v9.
- **The screen**: the intros and notes say the v10 rule (both emails of the pairs and gold at the minute's checks; the
  shares' at closes with 95%) and its numbers; the recent list labels a ride's out and at rows with the row's own exit
  level (v9 96%, v10 95%) read from the id; the sales page (`lp`) quotes no number and no percent
  (src/test/landing.test.tsx) — its FAQ answer that "more of the reached entries ended at a loss than at a profit" is
  replaced (false for v10), and the one saying only email 2 is off the close is corrected. The econ digest's footer
  (「MACD の流れ」) does not change.

## 9. Checks

- **Unit tests** of `_shared/macd-ride.ts`: `rideZpOf` against `zoneAt` at 598 of the 600-window rebuilt (bit for
  bit, random walks) and against v9's `Zp` from `rideEntryAt`; `rideHit` against the rule written again from section
  1.1's sentences; `rideMomentStep`'s table of cases; the catch-up including the entry bar.
- **Function tests**: section 7's replays over fake tables; the row of each mail; the texts; the moment row.
- **The replay** (`research/macdride-replay.ts`, in GitHub Actions on the study's data, `REACH = 0.95` for the study):
  the shared code driven minute by minute over the five pairs as section 4 does it (a read of the bar after each of its
  minutes has ended, the bar's last minute included — in the function a bar's last moments are read by the close's
  tail and catch-up instead, at the same prices and moment; the running extremes, reaches first then the decision, the
  tail and catch-up at closes), with in-memory rides and moments.
  - **R1** (the study's reading: the running extremes of the 1-minute mid highs and lows, the price of a read the
    minute's close): its rows must equal research/macd90m.ts's **moment** rows with way C at `REACH = 0.95`, all of
    them (`pair, open, T0, side, entry, share0, already, C_result, C_T, C_exit, C_pips, C_mae, C_minutes, C_share`;
    `meta.reach` 0.95), and the study's moment groups; the tail and the catch-up find nothing; or the run fails.
  - **R2** (as the function reads GMO's forming 1-hour bar: the mid of the running bid high and running ask high, and
    of the lows): entries may differ from R1 (earlier touches, another side, a bar with no R1 entry); keyed by pair and
    bar, the differences counted and printed, and every number of way C: the measurement of the function's own reading.
  - Walks: holes in the minutes (the tail and the catch-up then decide and reach), moved prices, the lone reading (no
    minute read: every decision is a tail's).
- `npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and econ-calendar.

## 10. Known differences from the study, and what is not measured

- The function reads once a minute (a run's moment), the study after each minute's end: an entry is priced at the read,
  the study at the touching minute's close; a reach likewise (as v9).
- R2 against R1: measured by the replay (section 9). Not measured: the seconds between a minute's end and the run's
  read, and GMO's forming bar against its own minutes.
- Unwatched moments (section 4): a touch there is decided late at a later price, or never (an hour with no state).
- Gold: the decision and the minutes' reaches from Swissquote's recorded minutes, the state and the older catch-up bars
  from Twelve Data's closes: two feeds, no bid and ask, **not measured**. A catch-up of a bar after the entry bar from
  Twelve Data's high can touch where Swissquote's minutes did not, and the reverse.
- The shares: v9's rule at 95%, **not measured**.
- When v10 goes live there is no ride; the state rows written by v9 carry no `Zp`, so the hour of the deploy starts no
  decision; a line already inside the band on a side starts none until a bar has closed outside it.

## 11. The morning check

The morning check (scripts/morning-check, `mc.pairs_v9` / `mc.gold_v9`) knows v9's close entries only. A v10 check is
built after this (its own spec): the moment decisions cannot be recounted from the stored 1-hour bars, but they can be
held against them (a decision's `x` within the bar's final extremes and touching 90%, already iff at 95%; a bar whose
final extreme touches 90% on a side its `Zp` was not at, with its state written, has a decision; a skip had a ride of
its side open at its moment; a ride reached in a bar whose final extreme touches 95%, and in the entry bar iff the entry
bar's does). Until it is in, the morning Routine is told that v10 rows are not recounted.

## 12. Release

`FUNCTION_VERSION` raised (pinned in the test files). Order: the migration applied (and read back) → the merge (deploys
signal-alerts and live-chart from source) → the screen published. The merge only when **no ride is open** (read just
before) and in minutes 31 to 50 of an hour (v9's close entries of the pairs and gold are judged by minute 30) and
outside the 45 minutes after any share close: so no v9 ride can open before v10 answers. Then see in
`net._http_response` that v10 answers. econ-calendar is not deployed (its footer is unchanged).
