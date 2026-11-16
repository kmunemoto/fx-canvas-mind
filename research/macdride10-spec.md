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
90%, of them 707 already at 95% in the same minute (a notice, or no mail when a ride of that side was reached by that
minute) and 557 while the same side was held (skipped); 1,274 trades, 1,271 reached 95%, 882 at a profit, 384 at a
loss, 5 at zero; −0.03 pips a trade on average (median +3.10); the worst −541.6 pips; the largest loss on the way 712.0
pips; held up to 29,220 minutes (about 20 days); 3 still open, −247.1 pips together (the worst −99.3). The reach rate
is high by construction (no stop). Gold and the shares are **not measured** in this form. Email 2 is therefore not a
take-profit as a fact (as v9).

What this file does not say is research/macdride-spec.md's. A section here replaces the section of the same subject
there for v10; research/macdride-spec.md itself stays as it is (it is the record of v9).

## 1. The rule of the pairs and gold

As research/macdride-spec.md section 1 (the chart, its closed bars and closes, `LEVEL_WINDOW = 600`,
`ZONE_BARS = 120`, a zone, **at share `s`**, `Z(i)`, `Zp(i)`, the state of a bar and the line with a price `x` in
its forming slot), with:

- `SHARE_IN = 0.90`, `SHARE_OUT = 0.95` (the doubles 90 / 100 and 95 / 100).
- **The bar before, judged in the bar's window**: for a bar `j`, `Zp(j)` — the zone at index 598 of the window of the
  599 closed closes before `j` with any price in slot 599. Nothing at index 598 depends on that price, so
  `Zp(j) = zoneAt(macd(the 599 closed closes before j), 598)` (EMAs are causal). It is the study's `zp[j]` bit for bit
  (checked on 3,440 random windows in the spec's review). It is **not** `Z(j−1)` on its own window (that window starts
  a bar earlier). `Zp(j)` cannot be worked out from the state's five numbers (its pane covers indices 479..598, the
  state's 480..598), so it is kept beside them (section 3).
- **The bar's extremes so far**: while bar `j` forms, `hi` its highest high so far and `lo` its lowest low so far, as
  section 4 reads them; at its close, its final high and low. `hi` only rises and `lo` only falls while a bar forms.
- **Touch** of a share `s` on a pane side, with an extreme of bar `j`: the line with `x = hi` (top side) or `x = lo`
  (bottom side), worked out from the state of bar `j`, is at `s` on that side.

**Why the extremes so far are enough.** On the top side, at `s` needs `m > 0`, so `top ≥ m ≥ s·m`, and the condition
is `m ≥ s·top119`, `m ≥ s·g` and `m ≥ s·h`, where `m − s·g = (1 − s·A9)·m − s·(1 − A9)·sig` and
`m − s·h = (1 − s·(1 − A9))·m + s·(1 − A9)·sig` rise with `m` (both coefficients are positive for `s ≤ 1`), and `m`
rises with `x` (`A12 > A26`). The bottom side is the mirror. So "at `s`" can only switch on as `x` moves toward its
side: a touch once made by the extreme so far stays made for the rest of the bar, the first read that touches sees the
extreme of the moment that touched, and the bar's final extreme touches if and only if some moment of it did (one feed).

### 1.1 The bar's one decision

A bar `j` of a chart has **at most one decision**, the first, made at the first read of bar `j` that has a **hit** —
a minute's read while bar `j` forms (section 4 B), or, for its last moments, the read of its close (the **tail**,
section 4 A.4):

- **hit**: the top side when `Zp(j)` is not at `SHARE_IN` on the top side and the extreme touches `SHARE_IN` on the
  top side; else the bottom side likewise. (When a read finds both, the top side decides, as the study reads a minute
  touching both.) The trade side `D`: top → BUY, bottom → SELL. **Already**: the same extreme also touches `SHARE_OUT`
  on that side.
- **The decision's moment**: a minute's read: the read's moment (section 4); the tail: **bar `j`'s close**
  (`open(j) + 1 hour`), whenever the read is made.
- **The step**, with the chart's rides of side `D` as they stand after this read's reaches (section 4) — v9's
  `rideCloseStep` (research/macdride-spec.md section 1) with the bar `j` as the bar, and one addition (a ride of the
  side entered in a bar after `j`; for the shares it cannot happen):
  - **at** (the notice): already, and no ride of the side has `reached_bar = open(j)`;
  - **quiet** (no mail): already, and a ride of the side has `reached_bar = open(j)` (normally reached by this very
    read; also one reached by another run in the same minute, or by an earlier run that failed before deciding): its
    email 2 says the same; or already, and a ride of the side was entered in a bar after `j` (only a tail decided late
    can meet one: a later decision of the side has been mailed, and a notice for an earlier moment would come after it);
  - **skip** (no mail): not already, and a ride of the side entered in a bar before `j` is open, or was reached in a
    bar after `j` (`reached_bar > open(j)`: only a tail can see such a ride, one reached in the next bar before the
    close was read); or not already, and a ride of the side was entered in a bar after `j`, open or reached (only a
    tail decided late, by a later judge of the close, can meet one);
  - **in** (email 1): not already, and no such ride.

  An already decision is never skipped and skips nothing (research/macd90m-spec.md way C). For a minute's read, "a
  ride reached in a bar after `j`" cannot exist yet, so skip is "a ride of the side is open after this read's reaches":
  the study's `T0 < T` (an entry at the very minute a ride is reached is taken).
- The decision is kept (section 3) and stands: no later read of bar `j` makes another, on either side, whatever it
  reads. A bar with no hit by its close has no decision.

So a bar has at most one entry, as the study's "at most one moment entry a bar" (the first minute, either side,
already or skipped included).

### 1.2 A ride

A **ride** is one trade of one chart and trade side, opened by an **in** decision: its **entry moment** is the
decision's moment, its **entry price** section 2's. It is followed by the reads whose moment is after the entry
moment: its **reach** is the first such read that touches `SHARE_OUT` on its side, in bar `j` itself (a minute
decision: the later reads of the same bar) or a later bar. No other way out. At most one open ride a chart and side;
both sides can be open at once (as v9).

A minute ride can be reached in its entry bar: the bar's extreme at the entry read did not touch `SHARE_OUT` (else the
decision would have been already), so a later touch in the same bar comes from a price after the entry read (one feed;
section 10 says where gold's two feeds break this). A tail ride's entry moment is the bar's close, so it is followed
from the next bar's first moment, as v9's close entry.

## 2. The mails

| mail | when | rule id (pairs and gold) | rule id (shares) |
|---|---|---|---|
| **in** (email 1) | an in decision (pairs and gold) / v9's in step (shares) | `macdx_12_26_9_w600_1h_touch90to95of120_in_v10` | `stockmacd_12_26_9_w600_1h_ride90to95of120_in_v3` |
| **at** (notice) | an at decision / v9's at step | `…_touch90to95of120_at_v10` | `…_ride90to95of120_at_v3` |
| **out** (email 2) | a ride reached | `…_touch90to95of120_out_v10` | `…_ride90to95of120_out_v3` |

Each id is `rideRuleId(prefix, tag, mail, version)`, built from the constants (`MACD_DEFAULTS`, `LEVEL_WINDOW`,
`ZONE_BARS`, 90, 95, the entry's word — `touch` for the pairs and gold, `ride` for the shares' close entry — and the
version: macdx 10, stockmacd 3), never typed twice and **never made by replacing text inside another id** (v9's
`rideRuleIdOf` goes): a signal's rule id comes from its rule and its mail. A test pins all six ids, and that each
rule's in, at and out ids are three different strings. v9's and v2's ids are never used again. The subscription rule
names stay `macdx` and `stockmacd`; `indicatorRuleId` gives the **in** id. The app tells a ride's mail and its exit
level from the full rule id (`_(touch|ride)(\d+)to(\d+)of120_(in|at|out)_`): a v9 row still reads 96%, a v10 row 95%.

The `signal_alerts` row of each (the claim's key unchanged):

| | `bar_time` | `closed_at` | `side` | `entry` | `stop` | `target` |
|---|---|---|---|---|---|---|
| in (pairs, gold) | the entry bar's open | **the decision's moment** | `D` | the entry price | null | null |
| at (pairs, gold) | the bar's open | **the decision's moment** | `D` | the decision's mid | null | null |
| out | the ride's entry bar's open | when it was seen | the ride's `D` | the ride's entry price | null | the price when seen |
| in, at (shares) | as v9 | as v9 | as v9 | as v9 | null | null |

One email 1 a bar and side (one decision a bar), one notice a bar, one email 2 a ride and follower.

**Prices and numbers of a decision** (pairs and gold), kept in its row (section 3) and the only source of every mail
of it:
- a minute's decision, from the read that made it: the entry price, a pair's newest ask for a BUY and newest bid for a
  SELL (the forming 1-hour bar's ask / bid close so far, as GMO gives it), gold's newest recorded minute's close (one
  price, no bid and ask); the decision's mid, a pair's newest mid (the forming bar's mid close so far, rounded as the
  chart draws it), gold's newest recorded minute's close;
- a tail's, bar `j`'s close: a pair's ask close for a BUY and bid close for a SELL (GMO's closed bar, as given), its mid
  close as the chart draws it; gold's last recorded minute of bar `j`'s close;
- `x` the extreme the decision was made with, `m`, `top`, `bottom` the line and the pane's edges at `x` (the state of
  bar `j`), `share0` the line's share there.

The price when seen and the profit or loss of email 2: as v9 (section 2 there).

## 3. What is kept

One migration (applied before the function goes out), modelled on `20261112120000_macd_rides.sql` (RLS on, all
revoked from `anon` and `authenticated`, all granted to `service_role`; written and read by signal-alerts only, no
user column):

```sql
alter table public.macd_ride_state
  add column zp_m double precision,       -- Zp of the bar the state is for: the line, and the pane's top and bottom
  add column zp_top double precision,     -- (null on a row written before v10: such a row starts no minute decision)
  add column zp_bottom double precision;

create table public.macd_ride_moments (
  pair text not null,
  bar_time timestamptz not null,           -- the open of the bar decided
  side text not null check (side in ('BUY', 'SELL')),
  step text not null check (step in ('in', 'at', 'skip', 'quiet')),
  decided_at timestamptz not null,         -- the decision's moment (a minute's read; the tail: the bar's close)
  source text not null check (source in ('minute', 'close')),
  read_at timestamptz not null,            -- when the read that decided was made (= decided_at for a minute's)
  price double precision not null,         -- the entry price (section 2)
  mid double precision not null,           -- the decision's mid (section 2)
  x double precision not null,             -- the extreme read (hi or lo)
  m double precision not null,             -- the line and the pane's edges at x
  top double precision not null,
  bottom double precision not null,
  share0 double precision not null,        -- the line's share at x
  created_at timestamptz not null default now(),
  primary key (pair, bar_time)
);
```

`macd_rides` is unchanged. A v10 ride's row: `entry_bar` the entry bar's open, **`entry_closed_at` the entry moment**
(the column keeps its name; a tail ride's is its bar's close, as v9's), `entry_price`, `entry_mid` the decision's
price and mid, `share0` its share; the rest as v9. A ride of the pairs or gold is v10's if and only if a moment row with
step `in` has its pair, side and `bar_time = entry_bar`. Moment rows are never deleted (a few a day; the record of each
bar's decision). State rows over 8 days old are deleted as in v9.

When v10 goes out no ride is open and none was reached in the last 45 minutes (section 12): every ride row a v10
function reads, open or reached, is a v10 ride, followed to 95%.

## 4. The function: the pairs and gold

Only for a chart in `MACDH_PAIRS` on `1h` with at least one `macdx` follower in this run, every step in its own try /
catch as v9 (a failure must never cost another rule's email, nor another chart's ride). `F` is the open of the hour
now (the forming bar). **A read's moment** is the run's clock `nowMs` (taken after the start wait, as v9's
`reached_at`); `decided_at` of a minute's decision, `read_at`, `reached_at` and the 30-minute windows use it.

**Reading the forming bar's extremes and newest prices** (one read a chart a run at most):
- the five pairs: GMO's forming 1-hour bar (`rideFormingOf`): `hi` / `lo` the mid of the bid and ask highs / lows so
  far rounded as the chart draws them, the newest bid and ask, and the newest mid (rounded); the read shared with the
  sharp rise (one GMO read a pair a run at most: its bid and ask requests, paced as today), skipped past the deadline
  or in maintenance (as v9);
- gold: this hour's recorded minutes (`public.gold_tick_bars`, Swissquote's mid, 2 decimals): `hi` / `lo` the highest
  high / lowest low of the minutes of the hour, the newest minute's close as the price and the mid.

### A. At a close (inside `judge`, on the runs that have the chart's closed bars in hand; `i` the newest closed bar)

1. Read the chart's ride rows as v9 (5 A.1). Unread → nothing of the ride for this chart in this run (as v9).
2. **State** of the bar now forming (`F = open(i) + 1 hour`): v9's five numbers and `Zp(F)` from the 599 newest closed
   closes, upserted into `macd_ride_state` (as v9, with the three new columns).
3. **Catch-up** (as v9 5 A.3 at `SHARE_OUT`): for each open ride, the closed bars after its entry bar among the newest
   100 (v9's), and in addition **its entry bar, when its entry moment is before that bar's close** (a minute ride) and
   that bar is `i` (it is judged at its own close only): for the pairs from the closed bar's high / low as the chart
   draws them, for gold from bar `i`'s recorded minutes (gold's close reads them: `gold_tick_bars` of `[open(i),
   open(i) + 1 hour)`, its own read). By section 1's argument a touch of the entry bar's final extreme is a touch after
   the entry read (one feed). A touch → reached, `late = true`, email 2 at once (before step 4).
4. **The tail of bar `i`** (a touch in its last moments, after its last minute's read): while bar `i` closed at most
   `freshFor("1h")` (30 minutes) ago and bar `i` has no decision (its moment row read; unread → nothing): the state of
   bar `i` and `Zp(i)` from the memo, the row, or else worked out from the closes in hand (the 599 before bar `i`; so
   the week's first hour, whose state no close wrote, is decided at its close); a hit read from bar `i`'s **final**
   extremes (the pairs: the closed bar's high / low as the chart draws them; gold: the extremes of bar `i`'s recorded
   minutes) makes bar `i`'s decision, `source = 'close'`, its moment bar `i`'s close, its prices bar `i`'s (section 2),
   `read_at` this read's moment. The step as section 1.1, with the rides as they stand after step 3. Then as B.5 below.
5. No other entry at a close (v9's close entry is not used for the pairs and gold).

A ridden chart is held judged by an instance only when the ride's work on the bar finished (as v9).

### B. Each minute (after this run's closes were judged and after the sharp rise, as v9)

1. **One read** of `macd_rides` for all charts followed (open, or reached in the last 30 minutes, or reached in bar `F`:
   `or=(status.eq.open,reached_at.gte.<now − 30 minutes>,reached_bar.gte.<F>)`, so that quiet sees every ride
   reached in the bar decided), one of
   `macd_ride_moments` (bars `F` and `F − 1 hour`, all charts followed), and the state of `F` (memo, else one read of
   `macd_ride_state` for all charts followed whose memo lacks it; `bar_time = F`, the five numbers and the three new
   columns). Any of these unread → nothing of the ride in this run for the charts it concerns (the record says which).
2. For each chart followed: the state of `F` and `Zp(F)` (none, or `Zp` null → `state: null`: no decision for bar `F`
   in this run; the reaches below still need the state's five numbers). Then the forming bar's extremes and newest
   prices (one read). None → nothing judged for this chart in this run.
3. **Reaches first**: each open ride of the chart whose entry moment is before this read's moment (so not one opened by
   this run's minute decision; a tail ride opened at a close is followed from the next bar's first moment, and the
   forming bar's extremes are all after its entry) — a touch of `SHARE_OUT` on its side → reached (as v9: `reached_bar
   = F`, `late = false`, the price when seen the newest on the side it leaves on, `share1`), PATCHed where still open,
   email 2 written from the row.
4. **Then the decision**, while bar `F` has none: a hit (section 1.1) makes it, `source = 'minute'`, with the step from
   the rides as they stand after step 3.
5. **Keeping and acting on a decision** (here and in A.4): insert the moment row (`on_conflict=pair,bar_time`,
   duplicates ignored), then read it back: the row is **the** decision (another run may have made it first; its
   numbers are what every run mails, and no state is read again for a mail of it). Then by its step:
   - **in**: insert the ride row from the decision (`entry_bar = bar`, `entry_closed_at = decided_at`, the prices and
     share; duplicates ignored), read it back; email 1 only while the ride row exists and is still **open** (a ride
     already reached gets no email 1 any more: `over`, as v9). The insert refused (another ride of the chart and side
     opened between this run's read and the insert: `macd_rides_one_open`) → no ride and no email 1 for this decision,
     now or later (`no_row`);
   - **at**: the notice;
   - **skip**, **quiet**: no mail; the record says which.
6. **Mails left over**: for each decision of the last 30 minutes (by `read_at`):
   - **in** with its ride row there: email 1 to each follower with no row for it yet, while the ride is open;
   - **in** with no ride row (a run failed between the two inserts): a later run writes the ride row from the decision
     (as 5) only when no other ride of the chart and side was entered after the decision's moment, and none entered
     before it was open at it (open now, or `reached_at` after the decision's moment); else no ride and no email 1,
     ever (`no_row`). Then as above;
   - **at**: the notice to each follower with no row for it yet;

   and for each ride reached in the last 30 minutes, email 2 (as v9). Of one ride, email 1 before email 2 in a run.

**The run's record**: B's entries (carrying `ride: true`) say, for a chart: `forming`, `state` (`ok` / null), `hi`,
`lo`, `decided` (the bar's step, null when none), `made` (true when this run made it), `source`, `open` (how many rides
open), `signals` (`macdx:BUY` email 1, `macdx-at:BUY` the notice, `macdx-out:BUY` email 2: as v9, a mail's tag when a
row was made for it in this run or was already there, so a re-offered mail repeats it; a reader counts mails from
`signal_alerts`, not from these tags), `unsent`, `no_row` — written for a chart whose bar was looked at in this run (no
decision yet, or one made now), or that has an open ride, or that mailed. A's entries gain `tail` (the step made at the
close, or null) beside v9's `ride`. No user id, address or row id is ever written.

**Cost**: per minute and chart followed, until the bar is decided: the forming bar's read — for a pair GMO's bid and
ask requests (more at GMO's day roll), paced 200 ms as today, which v9 made only for a pair with an open ride or a
spike follower: up to about ten more GMO requests a minute for the five pairs; for gold this hour's recorded minutes, a
few kilobytes — three small database reads shared by all charts (rides, moments, state), and one small `signal_alerts`
read each minute for each mail still re-offered. Once the bar is decided and no ride of the chart is open, nothing more
is read for that chart in that bar. The closed bars are never read each minute (the database's egress; v9's comment).
The run's length is to be watched after the deploy (not measured before).

**Unwatched moments** (section 10):
- a minute with no run, or whose forming read failed: a touch there is decided by the next read that has the state, at
  that read's prices (the extremes so far still hold it), or, if none comes before the bar ends, by the close's tail;
- the minutes of an hour before its state is written (the pairs: the close is judged at minutes 0, 3 and 5; gold: from
  a minute after the hour): decided by the first read after it, at its prices;
- the week's first hour (no state: Friday's last close is not judged): no minute decision; decided at its close by the
  tail (its state worked out from the closes in hand), at its close's price;
- the bar that closes at Friday 21:00 UTC: its last moments after its last minute's read are never read (its close is
  in the weekend gate: no tail); in winter the whole of Friday 21:00–22:00 UTC (no run, no state, no close judged);
- a state written before v10 (no `Zp`): no minute decision in that hour; its tail at the next close works the state out
  from the closes in hand.

## 5. The shares

As research/macdride-spec.md section 6, at `SHARE_OUT = 0.95` (the notice when `Z(i)` is at 95%, the reach when a
later closed bar's `Z` is at 95%) and with the v3 ids. The share mails no longer say the rule is the currency pairs'
(stocks.ts's 「FX の「MACD の流れ」のメールと同じ決まり」 / "the rule of the app's MACD ride email on currency pairs"):
they say email 1 comes at a 1-hour close, the notice and email 2 at 95% of the edge judged at closes, while the
pairs' email 1 comes at the minute's check; a reference to the pairs' numbers names the v10 docs section. Nothing else
changes.

## 6. The shared code: `supabase/functions/_shared/macd-ride.ts`

Pure, no clock, no I/O, used by the function and the replay (as v9). At least:

- `RIDE_IN_PCT = 90`, `RIDE_OUT_PCT = 95`, their shares; the tags (`touch90to95of120`, `ride90to95of120`) and
  `rideRuleId(prefix, tag, mail, version)`.
- `rideZpOf(closes599)` → `Zp` of the bar after them, or null; `rideStateOf` unchanged, and a way to have both from one
  window (the function keeps both).
- `rideLineAt` unchanged; `rideTouchAt(state, zside, x, share)` → null or the touch (`rideTouch` at `SHARE_OUT` stays
  its special case).
- `rideHit(state, zp, hi, lo)` → null or `{ zside, side, x, z, share0, already }` (section 1.1's hit: top first).
- the step: `rideCloseStep` (v9's) with an entry built from the hit, and section 1.1's addition (a ride of the side
  entered in a bar after the bar judged: skip, or quiet when already); the shares' calls are unchanged by it.
- the catch-up (`rideCatchUp`) able to include the entry bar (section 4 A.3), and the shares' by close (as v9) at 95%.
- `rideEntryAt` / `rideCloseStep` stay for the shares (already at 95%).

## 7. Once only, whatever is repeated

As research/macdride-spec.md section 7, with, to be shown by tests replaying runs (several each minute, instances fresh
and kept) over fake tables:

- two runs reading the same touch: one decision, one ride, the same numbers in every mail, one email 1 a follower;
- a later read of a decided bar with another extreme (the other side touched, or 95% now): no second decision, no
  notice on top of an email 1;
- a decision made but its ride row not written (a failure between): the next run writes the ride from the decision and
  mails email 1; but not when another ride of the side was entered after it or was open at its moment (`no_row`);
- a ride insert refused because another ride of the side opened between the read and the insert: no email 1, and no
  ride written later even after that ride is reached;
- a ride opened at a read and the same bar touching 95% at a later read: reached in the entry bar, email 2;
- a minute ride whose entry bar's last moments touch 95% after the last minute's read: reached by the close's catch-up
  (late), in the entry bar;
- a touch in the last moments of a bar seen by the close's tail: one decision (`source = 'close'`, at the bar's close
  and price), not doubled by the next minute's read of the new bar; its ride followed from the new bar's first moment
  (the new bar's first read at 95% reaches it, and the new bar's own decision at that read is quiet);
- a tail decision while a ride of the side was reached in the new bar before the tail was read: skip;
- a close judged again (a later instance) after the new bar's ride of the same side was opened (and perhaps reached):
  the tail is skip (quiet when already), no email 1;
- a ride reached by a read whose touch is also the bar's first 90% touch on that side: email 2, the decision quiet;
  the same when the reach was PATCHed by a run that failed before deciding, or by another run in the same minute;
- a skip while a ride of the side is open, and an in at a read after that ride was reached;
- a follower whose lookup failed gets email 1 (the notice) at a later run within 30 minutes, never after the ride is
  reached.

## 8. The mails and the screen

As research/macdride-spec.md section 8, with these changes (Japanese and English, the same facts; a test pins each
variant in both):

- **Subjects**: in 「【Sextant】ドル/円 1時間足 買い（BUY）で入る合図（MACD の流れ・1通目）」 (unchanged); at 「…知らせ:
  もう95%です（MACD の流れ・入る合図なし）」; out 「…95%に届きました（MACD の流れ・2通目、買いの分）」. Shares: 95% in
  place of 96%.
- **Email 1 and the notice** (pairs, gold) are written from the moment row alone and in the past tense, so they stay
  true whenever they are sent (a later run's re-offer included): the bar named by its open, the decision's moment
  (JST). A minute's decision: the blue line, worked out with that bar's high (low) up to that moment as its close,
  touched 90% of the top (bottom) of the 120-bar MACD pane, the bar before having closed outside the band, so the
  entry is with the flow, a BUY (SELL); the price 「この時の買値」 / 「売値」 (gold: 「この時の値段（Swissquote の毎分の
  値段）」); the moment is the minute's check (a touch between checks is seen at the next, at its price). A tail's: the
  touch came in the bar's last moments, after its last minute's check, and was found at its close with the bar's final
  high (low); the price is the bar's close (pairs: 「この足の終値の買値」 / 「売値」; gold: 「この足の最後の毎分の値段
  （Swissquote）」), and the mail says it was sent after the close (its time) and that the price now may differ. Both:
  `MACD` at the touch, the edge, its 90% and its 95% (from the row); email 1: that email 2 comes when the line touches
  95% of the same edge, with no stop and no target, that nothing is sent if the line leaves the band, and no new email 1
  for this chart and side until then; the measured paragraph; the rest as today. The notice: the line touched 90% and
  was already at 95% or more, so no entry.
- **Email 2**: as v9 at 95%, with 「1通目の時刻からの時間」 (the time since the entry moment) in place of the time since the
  entry bar's close, and the entry bar named by its open and email 1's moment. Gold: email 1's price is 「1通目の時の値段
  （Swissquote）」, never 「その足の終値」; not late: 「どちらの値段も Swissquote の値段で、スプレッドを含みません」; late, from a
  bar after the entry bar: 「1通目の値段は Swissquote の値段、今の値段は Twelve Data の確定足の終値で、配信が別です」; late in
  the entry bar (A.3, from the hour's recorded minutes): the reach 「毎分記録した Swissquote の値段（その1時間の高値・
  安値）で、足の確定のあとに見つけました」, the price when seen named by its source.
- **The measured paragraph** (`RIDE_MEASURED`): for the replay with the function's own reading (section 9's R2) and for
  the study's (R1 = docs §8.154) alike: trades; reached; at a profit / at a loss / at zero; mean and median a trade;
  the worst; the largest loss on the way (median, max); held (median, max); open trades and their loss together;
  notices sent; quiet; skipped. The mail and the notes say each of them, with what differs between the two readings;
  that the reach rate is high by construction (no stop). The sentence comparing profits and losses is written from R2's
  numbers after R2 is measured, as R2 shows (R1: more reached at a profit than at a loss, but the losses were larger
  and the mean is about zero after the spread). v9's 「半分は1分以内」 goes. Gold 「金では測っていません」, shares
  「株では測っていません」 (no numbers), as v9.
- **The screen**: the intros and notes say the v10 rule (both emails of the pairs and gold at the minute's checks, a
  touch in a bar's last moments found at its close; the shares' at closes with 95%) and its numbers; every note stating
  v9's timing or pane is rewritten (ja.ts 2138, 2142, 2143, 2145, 2147, 2149, 2152, 2153; en.ts 2033–2048 likewise),
  keeping i18n.test.ts's equal lengths; one note adds 「メールの MACD は、その時までの高値（売りは安値）を終値とみなして
  計算します。チャートの作っている途中の足は今の値段で描くので、1通目の時、チャートの青い線は90%より内側に見えることが
  あります」 (en likewise). The recent list labels a ride's out and at rows with the row's own exit level (v9 96%, v10
  95%) read from the id. The sales page (`lp`) quotes no number and no percent (src/test/landing.test.tsx): the FAQ
  「他のツールと何が違いますか？」 becomes 「…売買サインは確定した足で判定し、後から消えたり動いたりしません（FX と金の
  MACD の流れのメールは、足の途中の毎分の確認でも決め、決めたことは後から変えません。株は1時間足の確定ごとです）」 (en
  likewise); the win-rate answer says, with no number, what
  R2 shows about profits against losses; the answer saying only email 2 is off the close is corrected. The econ
  digest's footer (「MACD の流れ」) does not change.

## 9. Checks

- **Unit tests** of `_shared/macd-ride.ts`: `rideZpOf` against `zoneAt` at 598 of the 600-window rebuilt (bit for
  bit, random walks) and against v9's `Zp` from `rideEntryAt`; the monotonicity of a touch in `x` over a price grid on
  both sides at 0.90 and 0.95; `rideHit` against the rule written again from section 1.1's sentences; the step's table
  of cases (in, at, quiet, skip; minute and tail); the catch-up including the entry bar; the six ids.
- **Function tests**: section 7's replays over fake tables; the row of each mail; the texts (each variant, ja and
  en); the moment row.
- **The replay** (`research/macdride-replay.ts`, in GitHub Actions on the study's data, the study run with
  `REACH = 0.95`): the shared code driven minute by minute over the five pairs as section 4 does it, with in-memory
  rides and moments: a read of a bar after each of its minutes has ended, at that minute's end (`m1.t[k] + 1 minute`),
  the bar's last minute included (in the function a bar's moments after its hh:59 read are seen by the close's tail
  and catch-up, at the bar's close and its price: section 10); reaches first, then the decision; at each close the
  catch-up and the tail. Under every reading a decision (a minute's or a tail's) is made only in a bar whose close
  (`open + 1 hour`) is in `[START, END)` (research/macd90m.ts's gate; no tail decision in the hours before START,
  which have 1-hour bars but no minutes); reaches, mae and the catch-up go on through the last bar and minute loaded,
  and a ride still open there is valued at that bar (the study's open, as v9's replay). A minute's decision at minute
  `k`: T0 that minute's end, the entry its ask close (BUY) or bid close (SELL), `share0` and already at the extreme
  so far; its ride put among the held rides after minute `k`'s reaches and decision, its reaches and mae from minute
  `k + 1` (mae over every 1-minute bar to the minute out, those in no 1-hour bar included, as v9's replay). A tail
  decision: T0 the bar's close, the entry the bar's ask / bid close, followed from the next bar's first minute. A
  catch-up reach: out at the close it runs at, at that bar's bid / ask close, as v9.
  - **R1** (the study's reading: the extremes so far are the running extremes of the 1-minute mid highs and lows, the
    price of a read the minute's close; the closed bar's high and low that the tail and the catch-up read are what R1
    ended that hour with — an hour with no minute read has none, so no touch): its rows must equal research/macd90m.ts's
    **moment** rows with way C at `REACH = 0.95`, all of them (`pair, open, T0, side, entry, share0, already,
    C_result, C_T, C_exit, C_pips, C_mae, C_minutes, C_share`), and, of the study's `ways.moment` groups (all, each
    pair, BUY, SELL): entries, already and every field of C; the study's `meta.start`, `meta.end`, `meta.loadFrom`
    equal the replay's and `meta.reach` equals `RIDE_OUT_SHARE`; the tail and the catch-up find nothing; or the run
    fails.
  - **R2** (as the function reads: GMO's forming 1-hour bar — the mid of the running bid high and running ask high, and
    of the lows — and the closed bars as the chart draws them; and the function's week: no read in the weekend gate
    (`isPossiblyClosed`), no minute decision or reach in the week's first hour, whose decision is its close's tail and
    whose reaches the close's catch-up): entries may differ from R1 (earlier touches, another side, a bar with no R1
    entry); keyed by pair and bar, the differences counted and printed (and how many R1 decisions fall in the hours the
    function does not watch), and every number of section 8's list: the measurement of the function's own reading and
    week. Not modelled: missed runs, the minutes before a close is judged, the seconds between a minute's end and a
    run's read.
  - **Walks** (synthetic): holes in the minutes — an hour with no minute read is decided by the tail iff its chart
    extreme touches 90% on a side its `Zp` is not at, and R1 decides nothing there; moved prices — R2's running high is
    never under R1's nor its low over R1's, and R2 differs from R1 somewhere; the lone reading (no minute read) —
    decides the same bars as R2 (any step), on R2's side unless both sides touched 90% in the bar (then the top side),
    already wherever R2's decision on that side is, every reach late, out at the close of the bar it is found in.
- `npm test`, `npm run lint`, `npx tsc --noEmit`, `deno check` of signal-alerts, live-chart and econ-calendar.

## 10. Known differences from the study, and what is not measured

- The function reads once a minute (a run's moment), the study after each minute's end: an entry is priced at the read,
  the study at the touching minute's close; a reach likewise (as v9). A touch after a bar's hh:59 read is decided by
  the close's tail at minute 0, 3 or 5 of the next hour (gold from minute 1, up to 30 minutes), at the bar's close and
  its price: the mail is later than the moment it names.
- R2 against R1, and the function's week against the study's: measured by the replay (section 9). Not measured: missed
  runs, the minutes before a close is judged, the seconds between a minute's end and the run's read, GMO's forming bar
  against its own minutes.
- Unwatched moments (section 4): decided late at a later price, or never (the bar closing at Friday 21:00 UTC's last
  moments; in winter Friday 21:00–22:00 UTC). A ride the study opens there is missing, and so are the skips it would
  cause after it.
- Gold: the decision and the minutes' reaches from Swissquote's recorded minutes, the state and the catch-up of bars
  after the entry bar from Twelve Data's closes: two feeds, no bid and ask, **not measured**. A catch-up of a later bar
  from Twelve Data's high can touch where Swissquote's minutes did not, and the reverse.
- The shares: v9's rule at 95%, **not measured**.
- When v10 goes live there is no ride; the state rows written by v9 carry no `Zp`, so the hour of the deploy makes no
  minute decision (its tail at the next close decides it); a line already inside the band on a side starts none until a
  bar has closed outside it.

## 11. The morning check

The morning check (scripts/morning-check, `mc.pairs_v9` / `mc.gold_v9`) knows v9's close entries only. A v10 check is
built after this (its own spec): the moment decisions cannot be recounted from the stored 1-hour bars, but they can be
held against them (a decision's `x` within the bar's final extremes and touching 90%, already iff at 95%; a bar whose
final extreme touches 90% on a side its `Zp` was not at, with its state written, has a decision; a skip had a ride of
its side open at its moment; a ride reached in a bar whose final extreme touches 95%, and in the entry bar iff the entry
bar's does). Until it is in, the morning Routine says that v10's decisions are not recounted (section 12).

## 12. Release

`FUNCTION_VERSION` raised (pinned in the test files). Before it, in its own PR merged and published: the app's reading
of the ids (both tags, the exit level from the id), so that no v10 row is ever shown as an earlier rule. The v10 merge
only after the replay's R1 passed and `RIDE_MEASURED` holds R2's numbers.

Order: the migration applied (and read back: a connector "timeout" can have applied it) → the merge (deploys
signal-alerts and live-chart from source) → the screen published. The merge only when, read just before, **no ride is
open and none was reached in the last 45 minutes** (`select count(*) from public.macd_rides where status = 'open' or
reached_at > now() - interval '45 minutes'` is 0: pairs, gold and shares; else wait — no row is changed by hand, and if
a ride stays open more than a day the owner is told), in minutes 31 to 50 of an hour (v9's close entries of the pairs
and gold are judged by minute 30) and outside the 45 minutes after any share close: so no v9 ride can open, and no v9
email 2 be re-offered, under v10. Then see in `net._http_response` that v10 answers before minute 59 of the merge
hour; if it does not, read `macd_rides` and `signal_alerts` for any row made by v9 after the merge and report it. Record
v10's first decided bar (as v9's `live_ms`) in docs and the morning-check README. econ-calendar is not deployed (its
footer is unchanged).

Before the next 00:16 UTC run, the morning Routine's prompt is replaced and read back: on the switch day it runs
`mc.pairs_v9` / `mc.gold_v9` and reads every line for a bar from v10's first decided bar on as not counted (an
expected v9 entry there is not a missing mail, a ride there is v10's, `other_macdx_1h_rule_rows` there are v10's
mails); from the next day, until the v10 check is in, only read-only matching (moment rows against in / at mails,
rides against in / out mails, open rides, subscriptions; the shares' step with the v3 ids), and every report says
「v10 の決定は数え直していません」.
