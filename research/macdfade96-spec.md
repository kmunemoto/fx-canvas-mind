# The MACD fade at 96%: one email the moment the line touches 96%, take profit 10 pips, no stop

**Superseded (2026-11-17), not to be built.** The owner then asked 「もうシンプル96%の足できたら逆張りのメールちょうだい」 and
「メールを1時間足から15分足に変更」, then 「やっぱりメールの判断1時間足で」; the production spec is now
research/macdfade1h-prod-spec.md (research/macdfade15-prod-spec.md, the 15-minute form, was not built either).

Status: a production spec, written 2026-11-17 on branch `claude/app-confirmation-jvmk03` (fab0f7e), and revised the
same day (on 345a3f4) with the owner's answers to section 9's eight questions (section 1.1, item 6), and again after
three reviews of that revision (section 10). Nothing in it is built yet. Production still runs v9 (signal-alerts v39).

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
- The email states the price in and a target 10 pips away (the take profit; on gold $1.00 an ounce, Q2(a)). It states
  no stop.
- At most one email a bar and chart. No skip: a new email goes out even while earlier trades of the same chart and
  side may still be open.
- **Only the minute checks decide** (the owner's Q8(b), not the recommended option). A pair's or gold's bar is decided
  only by a minute's check made while the bar forms. Nothing is decided at a bar's close. A touch the once-a-minute
  checks do not see gets no email: one after the hour's last check, in the week's first hour, in the release hour, in
  an hour with no state (gold's first hour after each daily break among them), or in missed or failed checks with no
  later check in the same bar (section 2.5).
- No second email and no notice. Nothing at the target, and whether a trade reached it is not recorded or shown
  (Q5(a)).
- Shares: the same 96%, judged at 1-hour closes, fade side too: top SELL (a short sale), bottom BUY (Q4(a)). No
  take-profit level (Q1(a)).
- Gold and the shares are released with the pairs, not measured with this form; their mails and notes say so and give
  no numbers of their own (Q3a(a), Q3b(a)).
- The name: 「MACD の逆張り」 / "MACD fade" (Q7(a)). v9 stops at the release, which waits until no v9 ride is open
  (Q6(a)).

## 1. What the owner asked, and what was measured

### 1.1 The owner's words

On 2026-11-17, after the two-email v10 had been built but not released (research/macd90m-spec.md:157-163):
1. 「やっぱりメールを93%に到達したらすぐ送るに変えて」.
2. Asked which email: 「1通だけ、93%で」. Asked about the shares: 「株も93%に合わせる」.
3. Then: 「やっぱり96%をメールの合図にして」.
4. Measured as 「利確10・損切りなし」. Asked which side the one email is: 「両方を測って決める」.
5. After seeing the numbers of both sides: 「逆張りで作る」.
6. The owner's answers of 2026-11-17 to section 9's questions (given in the question dialog; section 9 keeps each
   question with its options):
   - Q1 (a): the shares state no take-profit level. `target` is null on a share's row, and the share id has no `tp`
     part (`stockmacd_12_26_9_w600_1h_fade96of120_in_v4`).
   - Q2 (a): gold's 10 pips is $1.00 an ounce.
   - Q3a (a): gold is released with the pairs, not measured. Its mails and notes say 「金では測っていません」 and give no
     number of gold's.
   - Q3b (a): the shares are released with the pairs, not measured. Their mails and notes say 「株では測っていません」 and
     give no number.
   - Q4 (a): the shares fade too: top SELL (a short sale), bottom BUY.
   - Q5 (a): nothing at the target. One email only. Whether a trade reached its target is not recorded or shown, and
     the notes say so.
   - Q6 (a): v9 stops at the release. The release waits until no v9 ride is open and none was reached in the last 45
     minutes. If one stays open more than a day, the owner is asked again.
   - Q7 (a): the name becomes 「MACD の逆張り」 / "MACD fade". v9 rows keep 「MACD の流れ」 on the screen. So the tab's
     name, `RULE_LABEL`, the test-mail lists, the how-to-stop lines and the econ digest's footer change, and
     econ-calendar is deployed by name (sections 6.6 and 7).
   - **Q8 (b), which is not the option the spec recommended:** no email for a touch the minute checks did not see.
     There is no decision at a bar's close for the pairs and gold. A pair's or gold's bar is decided only by a minute's
     check made while the bar forms (before its close). A touch after the hour's last check, in the week's first hour,
     in the release hour, in an hour whose state was not written, or in a stretch of missed or failed checks with no
     later check inside the same bar, gets no decision and no email, and nothing happens at the close. The shares are
     not affected: they are judged at closes by their own rule (section 3).

Earlier standing words that shape this form (CLAUDE.md):
- 2026-10-10: 「私は損切りをしません。なぜなら、どうせ今損をしていても必ず戻ってくると知っているからです。」
  This is recorded as the owner's view, not as a measured fact. No mail, note or screen text of this form says that a
  price will come back (section 6.1 gives the test).
- 2026-10-19: funds are unlimited. So every decision is taken (no skip for margin), any number of trades may be open,
  and no account, margin or loss-cut number appears in mails, notes or reports. (Which touches become decisions is
  section 2.5's matter, not the funds'.)
- A win rate is never written alone. It goes with the result a trade, the open trades and their loss, the largest loss
  on the way, the holding time, and the count of orders not filled.

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
7. The mails do not cover every one of these entries. Under Q8(b) a touch the minute checks do not see is not mailed
   (section 2.5), and the study enters at it all the same. How many of the study's entries that leaves out was not
   measured. R2 counts the part it models (〔missed〕, sections 6.5 and 8). Missed or failed checks, closes not judged,
   unfollowed charts and the release hour are not in it; nor are the bars R2 decides on the other side (〔otherSide〕);
   and it may include minute-59 touches the real check in that minute catches.

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

A bar `j` of a chart has **at most one decision**: the first minute's check of bar `j` that has a **hit** (section 5.4).
A check of bar `j` is one made while bar `j` forms: its moment, the run's clock `nowMs`, is before bar `j`'s close
(section 2.4 says that its price can be read a little later). **Nothing is decided at a close** (the owner's Q8(b)).
A touch that no check of bar `j` saw is never decided: not at bar `j`'s close, and not by a later bar's checks, which
read and decide only their own bar.

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
- A bar with no hit at any of its checks has no decision, whatever its final extremes show. Section 2.5 lists when
  that happens; no email goes out for such a bar.

### 2.3 The price, the target, no stop

**The price in** (`price`), from the minute's check that decided:
- A pair: the newest ask for a BUY, the newest bid for a SELL, of GMO's forming 1-hour bar at that read
  (`ridePaidAt(side, f.quote)`, indicators.ts:735, on `rideFormingOf`'s quote, indicators.ts:743-755). This is the
  study's side (research/macd90m.ts:413), at the moment GMO's answer came (`read_at`, section 2.4), not at the touching
  minute's close.
- Gold: one price, Swissquote's mid (section 2.6): the newest recorded minute's close.
- `mid`, for the record: the newest mid (the forming bar's mid close so far, rounded as the chart draws it). Gold: the
  same price.

**The target** (`target`):
- A pair: with `P(v) = round(v · 10^d)`, d = 3 on a yen pair and 5 on the others, the target is
  `(P(price) + 100) / 10^d` for a BUY and `(P(price) − 100) / 10^d` for a SELL. 100 points = 10 pips. This is the
  study's rule (research/macd90m.ts:414-416).
- Gold: `price ± $1.00` (the owner's Q2(a)). This is the same rule at gold's 2 decimals: 100 points of $0.01.
  **Checked in the code:** the app's `decimalsOf` gives 2 for gold (indicators.ts:1589, `isGold(pair) ? 2 : …`; `isGold`
  is `pair.toUpperCase() === "XAU/USD"`, supabase/functions/live-chart/logic.ts:285-286), and gold's price in is
  already rounded to 2 decimals where it is read (`r2`, indicators.ts:772, applied to the newest minute's close at
  :776). So `fadeTargetOf(2, side, price)` = `(round(price · 100) ± 100) / 100` is exactly the price ± $1.00 in whole
  cents. A node check of this expression over 2,000,000 random 2-decimal prices from $1,000.00 to $9,999.99, both
  sides, found the target 100 points from the price every time and equal to the 2-decimal value of the price ± 1.00
  (this writer's check of the arithmetic; `fadeTargetOf` itself is not written yet). `decimalsOf` is not exported
  today (a module constant at :1589, used inside indicators.ts only), so the function's PR exports it or passes the
  decimals from where it is in scope.
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
| when a touch is decided | after the touching minute ends (`T0`) | at the next check of the same bar: normally the run of the next minute, some seconds after `T0`; or the check of the touching minute itself, when the touch came in its seconds before the read. No check of the bar comes after its last minute (the run at minute 0 checks the next bar), so a touch after the hour's last check is not decided (Q8(b), below) | the decision is a few seconds after `T0`, or up to about a minute before it; or none |
| `hi` / `lo` | each minute's own mid extreme | the mid of the hour's highest bid and highest ask so far (the lowest, for `lo`) | the mid of the maxima is at least the max of the mids; rounding keeps the order. So the function's `hi` is never under the study's running `hi`, and its `lo` never over. It can touch earlier, or touch where the study did not. With every check made and the state there, a touch the study first finds in minutes 0 to 58 of the bar is found by the function at that minute's next check or earlier (it may then decide the other side first, when its `lo` touched first) |
| the price | the touching minute's ask / bid close | the newest ask / bid in GMO's answer to the read. The run's clock `nowMs` is taken after the start wait (index.ts:829-831). The forming read is made later, after the closes and the sharp rise, and may start until the run's 90 s budget ends (index.ts:368). So the answer comes some seconds, up to about a minute and a half, after `nowMs`; how long was not measured. In a run at minute 59 it can come after the bar's end. `rideFormingOf` still takes the bar as forming, because it splits the bars at `nowMs` (indicators.ts:743-749). The price is then the bar's final ask / bid close | differs by the price's move in between; not measured. The moment row keeps both times: `decided_at` = `nowMs` (inside the bar, for the morning check) and `read_at` = when the answer came. The mail names `read_at` as the time of its price |
| both sides in one read | within one minute: the top | the top, also when missed checks hold a bottom touch and then a top touch | the study takes the first in time; the function may take the top |
| a missed check (no run, a failed read, past the 90 s budget or in maintenance, index.ts:368, 1654-1655) | — | decided by the next check of the same bar that has the state, at its price (the extremes so far still hold the touch). If no such check comes before the bar's close: no decision, no email (Q8(b)) | later, at a later price; or not mailed |
| a touch after the hour's last check (the touch shown only by minute 59 after its read) | entered in minute 59 at its close | no decision, no email, nothing at the close (Q8(b)). The run at minute 0 checks the next bar only | the study's entry is not mailed. R2 counts these (section 8). R2's last check of a bar is at minute 59's start, so R2 also counts the minute-59 touches that the function's own check in minute 59 may catch in that minute's first seconds; how many: not measured |
| the week | every minute with data | no read in the weekend gate, Friday 21:00 to Sunday 22:00 UTC (`isPossiblyClosed`, supabase/functions/_shared/market-hours.ts:35-43); no decision in the week's first hour (no state) | section 2.5 |

R2 (section 8) measures the `hi` / `lo` reading, the function's week, and the hour's end (no check of a bar at or after
its close). It does not model: the seconds between a minute's end and the read, the seconds until GMO's answer comes,
missed runs, the minutes before a close is judged, an hour whose state was not written for a reason other than the
week or an hour with no bar before it (a close not judged, a chart nobody followed, the release hour), GMO's forming
bar against its own minutes, or the price at the read. For the 90% touch of v10, the replay found R2 differing from R1 in 64 of 2,550 bars (scratchpad
notes of run 43815122929, not verified by this writer). For the 96% fade nothing is measured.

### 2.5 Unwatched moments

Under Q8(b), each moment below that no check of the same bar reads gets **no decision and no email**, and nothing is
done at the bar's close.
- **A minute with no check, or a failed read:** a touch there is decided by the next check of the same bar that has
  the state, at that check's price. If none comes before the bar's close: no email.
- **The part of the hour after its last check:** a touch shown only by minute 59 after that minute's read. No email.
  The run at minute 0 checks the next bar, never this one.
- **The minutes of an hour before its state is written.** Pairs: the close is judged at minute 0, 3 or 5
  (`gmoIntervalsDue`, indicators.ts:1223-1230). Gold: from a minute after the hour, later on a Twelve Data retry
  (indicators.ts:1305-1311). A touch there is decided by the first check after the state is written, at its price. If
  the state is not written in the hour at all (a pair's close not judged by minute 5, gold's not within its 30 minutes;
  as the code reads, not checked against production): no decision in that hour, no email.
- **The week's first hour** (the bar opened Sunday 22:00 UTC): Friday's last close is not judged, so it has no state.
  No decision, no email.
- **A bar after an hour with no bar.** The state of bar `j` is written only by a judged close of the bar opened one hour
  before `j` (`forming = newest + HOUR`, index.ts:1019), and a close is judged only when the newest closed bar is the
  one expected (the pairs: the grid's previous hour, index.ts:1307, 1355; gold: `hasClose`, index.ts:1231-1245). So a
  bar that follows an hour with no bar has no state: no decision, no email. On gold this comes every trading day: the
  first hour after its daily break (17:00–18:00 New York, `isGoldBreak`, supabase/functions/_shared/market-hours.ts:242)
  follows an hour with no bar. This is as the code reads; the app's note says the same (ja:2144 / en:2039: gold's first
  hour after each daily break is not checked minute by minute), and so does v9's spec
  (research/macdride-spec.md:257-259). That Twelve Data has no bar opened at 17:00 New York was not checked. Whether
  GMO's data has hours with no bar inside the week (holidays) was not checked.
- **The bar that closes at Friday 21:00 UTC:** a touch after its last check is never read, like any other hour's. In
  winter, Friday 21:00–22:00 UTC is not watched at all (no run, no state, no close judged): no email.
- **A state written before this form** (no `Zp`): no decision in that hour, none at its close (section 7: the release
  hour). The first possible decision is in the next hour.
- **A chart nobody follows under `macdx` in that run:** it is not read (as v9, index.ts:971-972), and no state is
  written at its close (the close's ride work runs only for a followed chart, index.ts:1165-1168). Its touches make no
  decision. So an hour whose state was not written because nobody followed the chart when its close was judged has no
  decision, even when a follower subscribes during it. A new follower's decisions start from the next hour, whose
  state that hour's close writes.

The study enters at every one of these touches (where its minutes have data), and none that no later check of the
same bar reads is mailed. R2 counts how many of the study's entries it does not decide, by reason (section 8), and the
mails give that count (〔missed〕, section 6.5). R2 does not model missed or failed checks, a close not judged, a chart
nobody followed, or the release hour (section 2.4), so those are not in its count. R2 reads the five pairs only, so
gold's hours are not in it either.

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
- **The first hour after the daily break has no state** (section 2.5): no decision and no email in it, every trading
  day.
- **No read at the close** (Q8(b)). Gold's bar is decided only by a minute's check while it forms. Minutes recorded
  after the hour's last check are never read for that bar, and no read of the closed hour's recorded minutes is made.
- **The target:** $1.00 an ounce (Q2(a); section 2.3 shows it is 100 points at gold's 2 decimals).
- **Not measured** with this form, and released with the pairs (Q3a(a)). Every mail and note says
  「金では測っていません」 before the pairs' numbers, and gives no number of gold's.

## 3. The shares

**The rule** (with the owner's answers Q1(a), Q3b(a) and Q4(a) of 2026-11-17). Q8(b) does not touch the shares: they
are judged at closes by their own rule, below.
- At a share's closed 1-hour bar `n`, on the 600 closed closes ending at `n`: an entry on side `S` when `Z(n)` is at
  0.96 on `S` and `Zp(n)` is not. Both sides cannot hold at one close: the top needs `m > 0`, the bottom `m < 0`
  (macd-ride.ts:218-219).
- The trade side (Q4(a)): fade, as the pairs: top → SELL (a short sale, stocks.ts:18-19), bottom → BUY. The owner's
  earlier words on shares were 「株も93%に合わせる」 (the level); the side was set by the answer to Q4.
- This is v8's share rule (`_shared/macd-level.ts:55-73`) with 0.96 in place of 0.95 (`ZONE_SHARE`,
  macd-level.ts:113-115). It is judged at closes. So a bar whose high touched 96% but closed under it is no entry, unlike
  the pairs' minute touch. A bar that closes at 96% also touched at its extreme (section 2.1). This is argued from the
  code, not measured.
- The price in: the bar's close (Yahoo's last trade, one price, no bid or ask; index.ts:1897-1904).
- The target (Q1(a)): none. The email states no take-profit level, and `target` is null.
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
  `source = 'close'`, `decided_at` = the bar's end, `read_at` = now, `price = mid = x` = the close, `target` null
  (Q1(a)), `m`, `top`, `bottom`, `share0` of `Z(n)`), duplicates ignored, then read the row back.
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
The shares are released with the pairs, not measured (Q3b(a)). Their mails and notes say 「株では測っていません」 with no
numbers.

## 4. Ids, versions and code

### 4.1 FUNCTION_VERSION

`FUNCTION_VERSION` goes from v39 (index.ts:364) to `"signal-alerts-v40-<the deploy's date>"`. The header's version
notes (v39's is index.ts:335-363) gain v40. Seven test files pin "signal-alerts-v39" (a grep of src/test); each changes.

### 4.2 The rule ids

| | rule id | built from |
|---|---|---|
| pairs and gold | `macdx_12_26_9_w600_1h_fade96tp10of120_in_v11` | `fadeRuleId("macdx", FADE_TAG, 11)` |
| shares (no target, Q1(a)) | `stockmacd_12_26_9_w600_1h_fade96of120_in_v4` | `fadeRuleId("stockmacd", FADE_STOCK_TAG, 4)` |

- Built from the constants (`MACD_DEFAULTS`, `LEVEL_WINDOW`, `ZONE_BARS`, `FADE_PCT = 96`, `FADE_TP_PIPS = 10`), never
  typed twice. `indicatorRuleId("macdx")` and `("stockmacd")` give them.
- The owner set no share target (Q1(a)), so the share id has no `tp…` part. (`FADE_ID` below still allows one, so a
  later share target would not need a new parse.)
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
  entry), with its tag chosen from the id (section 6.6): a pair's or gold's 「（MACD の逆張り）」; a share's keeps
  `ruleTag.stockmacd` 「（株の MACD）」. Today's non-ride branch would give both `ruleTagEarlier` (:125), so the fade
  branch comes before it.
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
  add column if not exists zp_bottom double precision,  -- row's hour has no decision, Q8(b))
  add column if not exists fade_error text;             -- a moment row of this bar refused (e.g. 'rest_400'), for the
                                                        -- morning check; null when none was (see the checks below)

create table if not exists public.macd_fade_moments (
  pair text not null,
  bar_time timestamptz not null,           -- the open of the bar decided
  zside text not null check (zside in ('top', 'bottom')),
  side text not null check (side in ('BUY', 'SELL')),
  source text not null check (source in ('minute', 'close')),  -- pairs and gold: 'minute' only (no decision at a
                                           -- close, Q8(b)); shares: 'close' (judged at closes); see the checks below
  decided_at timestamptz not null,         -- pairs and gold: the run's clock nowMs (inside the bar); a share's: the
                                           -- bar's end
  read_at timestamptz not null,            -- when the deciding read's answer came (the time the mail names)
  price double precision not null,         -- the price in (section 2.3; a share's: the close)
  mid double precision not null,           -- the mid at the decision (section 2.3)
  target double precision,                 -- the take-profit level (section 2.3); null on a share (no target,
                                           -- Q1(a)); never null for a pair or gold (the last check below)
  x double precision not null,             -- the extreme read (hi on the top, lo on the bottom; a share's: the close)
  m double precision not null,             -- the line and the pane's edges at x
  top double precision not null,
  bottom double precision not null,
  share0 double precision not null,        -- the line's share at x
  created_at timestamptz not null default now(),
  primary key (pair, bar_time),
  check ((zside = 'top') = (side = 'SELL')),             -- fade on every chart, shares too (Q4(a))
  check ((source = 'minute') = (strpos(pair, '/') > 0)), -- pairs and gold ('USD/JPY', 'XAU/USD'): a minute's
                                                         -- decision only; shares ('NVDA', '7203.T'): 'close' only
  check (source = 'close' or (decided_at >= bar_time and decided_at < bar_time + interval '1 hour')),
                                                         -- a minute's decision is made while its bar forms
  check (target is not null or strpos(pair, '/') = 0)    -- a pair's and gold's row always has its target
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

- **The checks on `source`, `decided_at` and `target` were tightened in the answers revision**, for Q8(b). Before it, a
  pair's or gold's row could be `'close'` (a decision at its close, which that revision removed). Now no pair or gold row
  can be, and a minute's `decided_at` must lie inside its bar. A leftover close path in the code, or a moment taken from
  the wrong clock, then fails at the insert: no row and no mail for that bar, as Q8(b) wants for a decision at a close.
  Alone, such a refusal would show in the morning check only as `touch_not_decided` with `why = checks`, which cannot be
  told apart from a touch after the hour's last check, and the run's record keeps it only about six hours (section
  5.8). So the run that met the refusal also writes it into the state row of the bar it tried to decide (`fade_error`,
  e.g. `"rest_400"`, by a PATCH of that one column), and the morning check reports such a row as an error,
  `moment_refused` (section 8). A later upsert of the state sends only the five numbers and `Zp`, so it leaves
  `fade_error` as it is (PostgREST's merge-duplicates sets only the columns sent: expected, not checked). If that write
  fails too, only the run's record keeps the refusal. The shares write no state row, so a share's refusal is kept only
  in the run's record. Pairs and gold are told from shares by the `/` in the name: every pair and gold is written with
  one (`MACDH_PAIRS`, indicators.ts:287-290; `GOLD = "XAU/USD"`,
  live-chart/logic.ts:285), and no share symbol has one (stocks.ts:54-56: `NVDA` … `7203.T` …). So a chart added later
  of either kind, written the same way, needs no change here. The cost: a violation sends no mail for that bar until the
  code is fixed. Section 5.6 tests that the code never meets these checks. That PostgREST answers a check violation with
  a 4xx is expected, not checked. The shares' `decided_at` (the bar's end) is left unchecked: Q8(b) does not touch the
  shares, and a session's last bar and Tokyo's lunch bar (stocks.ts:289-296) need not end an hour after they open.
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
- The owner's answer to Q5 (section 9) is (a): nothing is sent or shown at the target, and whether a trade reached it
  is not recorded or shown. The notes say so (section 6.6).

### 5.3 At a close (inside `judge`)

Only for a chart in `MACDH_PAIRS` on `1h` with at least one `macdx` follower in this run (`rideSubs`, index.ts:971-972).
Every step in its own try / catch: a failure must never cost another rule's email, nor another chart's. Pairs are judged
at minutes 0, 3 and 5; gold from a minute after the hour while its bar is not judged (as v9, index.ts:1165-1294). `i` is
the newest closed bar.

1. **State.** The state of the bar now forming, `F = open(i) + 1 hour`, and `Zp(F)`, from the 599 newest closed closes
   (`rideStateZpOf`): upserted into `macd_ride_state` with the three `Zp` columns (as index.ts:1017-1046, which writes only
   the five numbers today). Kept in the instance's memo with `Zp`.
2. **Nothing is decided at a close** (Q8(b)). Bar `i`'s decision, if it has one, was made by a minute's check while it
   formed. A touch that bar `i`'s checks did not see stays undecided. The close reads neither bar `i`'s moment row nor
   its final extremes, and works out no state for bar `i` from the closes in hand. So the week's first hour, the release
   hour and an hour whose state was not written have no decision at all.
3. Nothing else at a close. No v9 close entry, no rides read, no catch-up.

A chart is held judged by an instance only when the state was stored (or a 4xx held it judged, below). Otherwise the
bar is judged again, as v9 does (index.ts:1184-1186).

**A schema fault must not become a loop.** If the migration is missing, failed, or not yet seen by the REST API, every
state upsert fails. As v9 holds it, the bar would then count as unsettled every hour: gold is judged again each minute
up to :29, each time re-reading its full stored Twelve Data row (index.ts:1205-1235, the `live_chart_fallback ...
select=bars,fetched_at` read at :1220), which the code itself calls too much to read every minute
(index.ts:1370-1373); the pairs are read again at :03 and :05 (`gmoIntervalsDue`, indicators.ts:1223-1230). And no
decision is made (the minute's reads of section 5.4 fail too, and with no state there is nothing to decide on). So: an
answer of 4xx to the state write (a schema or permission fault, which a retry in the same hour will not mend) holds the
bar judged anyway, and the close's record says `fade.error = "rest_<status>"`. A 5xx, a network failure or an exception
leaves the bar unsettled, as v9.

### 5.4 Each minute

After this run's closes were judged and after the sharp rise (as v9, index.ts:1603-1610). `F` is the open of the hour now.
A check's moment (`decided_at`) is the run's clock `nowMs`, taken after the start wait (index.ts:829-831): it is inside
bar `F`. The price comes from a read made later, whose answer can come after bar `F` has ended (section 2.4). Its
moment is `read_at`: for a pair, the clock when the GMO answer used came back (the chart's own 1-hour read of this run,
or `formingQuotes`' own); for gold, when the read of the recorded minutes came back. A run checks only bar `F`, the bar
its `nowMs` is in: the run at minute 0 checks the new bar and never the one that just closed (Q8(b)). These checks are
the only place a pair's or gold's bar is decided.

1. **Two small reads for all charts followed:**
   - `macd_fade_moments?pair=in.(…)&or=(bar_time.eq.F,read_at.gte.<now − 30 minutes>)`;
   - the state and `Zp` of `F`, for the charts whose memo lacks them (`macd_ride_state?pair=in.(…)&bar_time=eq.F`, the
     five numbers and the three `Zp` columns).
   - Either unread: nothing of the form in this run for the charts it concerns. The record says so.
2. **For each chart followed whose bar `F` has no decision:**
   - The state and `Zp(F)`. No state: `state: null`. `Zp` null (a row written before v40): `state: "nozp"`. Either way
     no decision in this run. A state row with no `Zp` gets none later in the hour either, and none at its close. With
     `state` null or `"nozp"`, no forming read is made for this chart in this run (the sharp rise may still read it for
     itself), and the record's `forming`, `hi` and `lo` are null.
   - The forming bar (only with a state that has `Zp`): a pair's GMO read (`formingQuotes`, shared with the sharp rise
     and with the chart's own 1-hour read; skipped past the deadline or in maintenance, index.ts:1654-1655); gold's
     recorded minutes (`goldMinutes`, shared). None: nothing for this chart in this run.
   - A hit makes the decision: `source = 'minute'`, `decided_at = nowMs`, `read_at` as above, the price and mid from
     this read, `x`, `m`, `top`, `bottom`, `share0`, `target`. Then section 5.5.
3. **Mails left over.** Every run offers each decision of the last 30 minutes (by `read_at`) to each follower with no
   row for it yet (`mailRide`). This covers a follower whose address lookup failed (no row is claimed then,
   index.ts:640-643), a run that failed between the insert and the mail, and a follower who subscribes within the 30
   minutes (section 5.5). After 30 minutes the decision is not offered again (v9's window, `RIDE_OUT_FRESH_MS`,
   indicators.ts:784). The mail names its own moment and price, so it stays true when late. No instance keeps a decision
   as done: each offer is one `signal_alerts` read (index.ts:783-785), and when no follower is left `mailRide` returns
   there, before any lookup (index.ts:787). So every decision costs about 30 such reads (section 5.7).

### 5.5 Keeping and acting on a decision; the `signal_alerts` row

**The claim.** Insert the moment row (`on_conflict=pair,bar_time`, duplicates ignored, `return=representation`). If
nothing comes back, read the row. The row read is **the** decision: another run or instance may have made it first.
Every mail of it is written from the row alone, so every follower gets the same numbers. No state is read again for a
mail.

**The `signal_alerts` row of the email** (the claim key unchanged: `user_id, kind, pair, interval, bar_time, side,
rule`):

| `bar_time` | `closed_at` | `side` | `entry` | `stop` | `target` | `rule` | `event_id` |
|---|---|---|---|---|---|---|---|
| the decided bar's open | `read_at`, for every pair and gold decision (the time of its price, the time the mail names) | `D` | `price` | null | `target` | the new id | null (as v9, index.ts:661) |

The shares' row: `bar_time` the bar's open, `closed_at` the bar's end, `entry` the close, `target` null (Q1(a)), `stop`
null.

`signalRow` (indicators.ts:872-888) already writes `target: s.tps[0]` and `stop: s.sl` for a signal without ride facts. A
fade signal with `sl: null` and `tps: [target]` (`tps: null` for a share, which has no target) needs no change there.

**Who.** Every follower of the chart under `macdx` (shares: `stockmacd`) at the run that mails, each once (the claim). A
follower who subscribes within the 30 minutes also gets it; the mail is in the past tense and names its moment.

### 5.6 Once only, whatever is repeated

To be shown by tests that replay runs (several a minute, instances fresh and kept) over fake tables:
- two runs reading the same touch: one decision, the same numbers in every mail, one email a follower;
- a bar whose bottom was decided, read again after the top also touched: no second decision, no SELL;
- a follower whose lookup failed: mailed by a later run within 30 minutes; not after;
- a follower who subscribes 10 minutes after a decision, on a kept instance whose earlier runs found no follower left:
  mailed; one who subscribes after the 30 minutes: not;
- a decision inserted, the run failing before the mail: mailed by the next run;
- a moment insert refused by a check (a fake 400): no mail; `fade_error` written on that bar's state row; a later upsert
  of the state leaves it;
- a chart with no state, or a state with no `Zp`: no forming read for it in that run, and no decision;
- a touch after the hh:59 check (shown only by the bar's final extremes): no decision and no mail, at the close or
  after; the next bar's checks decide only the next bar (`F`), never the old one, even when the read they use also
  holds the old bar (in the test, it does);
- a close judged after a minute's decision of the bar: nothing at the close; the decision and its mails unchanged;
- a close judged again at minute 3 or 5 on a fresh instance: the same state row, no decision;
- a state row with no `Zp`: no decision in that hour, at any check, and none at its close, even when the bar's final
  extremes touch on an open side;
- an hour with no state row (the week's first hour; a chart nobody followed when the hour's close before was judged;
  a follower who subscribes during the hour): no decision, none at its close;
- missed checks: a touch in a minute with no check, with a later check in the same bar, is decided by that check at
  its price; with no later check before the close, no decision and no mail;
- the moment table's checks (section 5.1) are never met by the code: every pair's and gold's row is `source = 'minute'`
  with `decided_at` inside its bar and a target, every share's row `source = 'close'`;
- the same side in two bars in a row: bar `j − 1` decided on the top by a minute's touch, its close inside 96% (so the
  top is open in bar `j`), bar `j` touching again: a second decision and a second email, each with its own bar; the
  text of the second says the bar before *closed* inside 96% (section 6.3), not that it never reached it;
- a 4xx to the state write at a close: the bar held judged, `fade.error` recorded, gold's stored row not read again
  that hour; a 5xx: judged again, as v9;
- a minute's read whose answer comes after the bar's end: `decided_at` inside the bar, `read_at` after it, the mail
  naming `read_at`;
- shares: Yahoo read again and again in the window: one email a follower; a close revised after a moment row exists:
  the row's side, price and target stand; two stock runs on two instances overlapping on one bar with different closes:
  one moment row, every mail from it;
- shares: a follower whose lookup failed: the bar not held judged, the follower mailed by a later run in the share's
  window, from the moment row; not after the window.

### 5.7 Reads each minute, and egress

**v9 today:** a chart with no open ride costs nothing each minute (index.ts:1699).

**This form**, every minute of every watched hour whose state has `Zp`, until bar `F` is decided (with no state or no
`Zp`, no forming read is made for the chart, section 5.4):
- **Pairs:** one GMO read of the forming 1-hour bar a pair a run (its bid and ask requests, paced as today). None is added
  when the run already read the pair's 1-hour chart for a close, or the sharp rise read it for a `spike` follower. v10's
  spec estimated up to about ten more GMO requests a minute for the five pairs (research/macdride10-spec.md:269-271).
  That is an estimate. It was not measured. These are GMO requests, not database egress.
- **Gold:** one read of the hour's `gold_tick_bars` rows a run, shared with the sharp rise. A few kilobytes (the v10
  spec's words). Not measured.
- **Database:** two small reads for all charts (moments, state). One `signal_alerts` read a minute for each decision
  of the last 30 minutes (so about 30 a decision; no instance stops early, section 5.4 step 3). It is small in egress
  (the followers' ids), not necessarily in database work: it filters by `kind, pair, interval, bar_time, side, rule` with no `user_id`
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
  `"SELL"` / null), `made` (true when this run made the decision), `skipped` (`"deadline"` / `"maintenance"`),
  `signals`, `unsent`. (No `source`: every pair's and gold's decision is a minute's.)
- Written for every chart looked at in this run: its bar not yet decided, decided now, or its mail offered.
- A close's entry gains `fade: { state, stored, error }` (`error`: e.g. `"rest_400"` when a 4xx held the bar judged,
  section 5.3) in place of v9's `ride`. There is nothing about a decision there: no decision is made at a close.
- A minute's entry also carries `read_at` when it decided, whether the read came back after the bar's end, and
  `error` when the moment row's insert or read was refused (e.g. a check of section 5.1 met). A refused insert is also
  written into that bar's state row (`fade_error`, section 5.1).
- What the morning check can count: every decision has its moment row, and every hour's state row says whether that
  hour could be decided (no row: no state; `zp_m` null: no `Zp`; `fade_error` set: a moment row refused). The morning
  check splits the bars it finds touching with no decision from these rows (section 8). The run's record is not used
  for that count: it is kept in `net._http_response` only about six hours (scripts/morning-check/README.md:459). No
  column is added for it beyond `fade_error`.
- A stopped state write or a stopped minute path sends no mail and writes no error row. The morning check sees it
  within a day only through its attention list (verdict `CHECK`): `state_missing`, `zp_missing`, `undecided_checks`
  and gold's `ticks_touch_early` (section 8).
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
- Every mail says whose choices the numbers are. v9's mail said 「この決まりは Sextant 独自のもの（数字はアプリの
  オーナーが決めたもの）」 (indicators.ts:1823); the new texts keep and extend it.
  - The pairs' and gold's (section 6.3 item 11): 96%, the take profit and no stop are the owner's; the take profit and
    no stop were the conditions the study was measured under, not results of it; the fade side was chosen by the owner
    after seeing both sides' numbers (section 1.1); and sending no email for a touch the minute checks do not find, and
    none found after the bar closes, is the owner's choice too (Q8(b)).
  - The shares' (section 6.4 item 9): 96%, no stop and no take-profit level are the owner's; the fade side is the one
    the owner chose on the five pairs, applied to shares (Q4(a)); nothing was measured on shares (Q3b(a)). Nothing is
    said to have been measured under these conditions.
- No text says that a price will come back. A test runs two patterns over every mail variant, the notes, the plan
  line and the sales page texts, in both languages, and finds nothing:
  `/(必ず|いずれ|きっと|そのうち|やがて)[^。]{0,8}戻|戻ってく|戻ってき|戻るはず|戻ります/` (it also catches the owner's own
  「必ず戻ってくる」) and
  `/\b(always|will|surely|certainly|eventually)\s+(come|comes|go|goes)\s+back\b|\b(always|will|surely|certainly|eventually)\s+(return|returns|recover|recovers)\b|\bcomes?\s+back\s+(eventually|in\s+the\s+end)\b/i`.
  The answers' review revision ran both over today's ja.ts and en.ts: the ja pattern matches ja:403, 946, 951 and 957
  (「戻ってき」, 「戻ります」 in chart and data-source texts, none of them a text of this set) and not the FAQ's 「RSI が
  25または75から戻り」 (ja:2038); the en pattern matches nothing.
- No reached share without the mean a trade, the open trades' count and loss, the largest loss on the way, the holding
  time, the flow side, the baseline, the count of orders not filled (none) and 〔missed〕. This binds the notes and the
  pairs' and gold's mails (a share's mail gives no reached share). A test checks each of them for these fields.
- The name of the form (the owner's Q7(a)): 「MACD の逆張り」 / "MACD fade". v9 rows keep 「MACD の流れ」 on the screen.
- Every pair's and gold's mail, and the pairs' and gold's notes, say that a touch the once-a-minute checks do not see
  gets no email (section 6.3 item 8, with the cases of section 2.5). No share text says it.

### 6.2 Subjects

- Pairs and gold, ja: 「【Sextant】ドル/円 1時間足 売り（SELL）: 青い線が上の端の96%に触れました（MACD の逆張り）」
  (bottom: 「買い（BUY）: 青い線が下の端の96%に触れました」).
- Pairs and gold, en: "[Sextant] USD/JPY 1h SELL: the MACD line touched 96% of the top (MACD fade)".
- Shares, ja: 「【Sextant】〔name〕（〔code〕）1時間足 売り（SELL・空売り）: 青い線が上の端の96%以上で確定（株の MACD）」.
- Shares, en: "[Sextant] 〔name〕 (〔code〕) 1h SELL (short sale): the MACD line closed at 96% of the top (stock MACD)".

### 6.3 The pairs' and gold's email

Every pair's and gold's decision is a minute's (Q8(b)). The mail (ja; en the same facts):
1. The bar: 「判定した足: 〔open, JST〕に始まった1時間足（作っている途中の足）」.
2. The moment: 「毎分1回の確認で、〔read_at, JST〕に読んだ値段で見つけました。確認と確認の間に触れた時は、同じ足の次の
   確認で見つけます。値段は、その確認で読んだ時のものです。」 When `read_at` is at or after the bar's close (a run at
   minute 59 whose read came back late, section 2.4), it adds: 「値段を読んだ時には、この足はもう終わっていました。」
3. What happened: 「青い線（MACD）を、この足のその時までの高値を終値とみなして計算すると、直近120本の MACD の枠の上の端の
   96%（0の線から測って）に触れました。一つ前の足は、確定した時（終値で計算した線）、上の端の96%に届いていませんでした
   （一つ前の足が足の途中で96%に触れていても、確定した時に96%より内側なら、この足でもう一度合図になります）。上の端に触れたので、逆張りの
   売り（SELL）の合図です。」 (bottom: 安値, 下の端, 買い（BUY）).
4. The numbers, from the row: 「MACD = 〔m〕、枠の上の端 = 〔top〕（その96% = …）」.
5. The price: a pair 「売値（〔read_at, JST〕に読んだもの）: 〔price〕」 (BUY: 買値); gold 「〔read_at, JST〕に読んだ値段
   （Swissquote の毎分の値段。売値・買値の別はなく、スプレッドを含みません）: 〔price〕」.
6. The target and no stop: 「利確の目安: 〔target〕（売値から10 pips 下）。損切りの値段はありません。これはこの決まりの作り
   で、損切りをしないことを勧めるものではありません。」 Gold (Q2(a)): 「利確の目安: 〔target〕（値段から1.00ドル下）」
   (BUY: 上).
7. One email: 「メールはこの1通だけです。利確の目安に届いても、届かなくても、知らせは送りません。同じチャート・同じ向きの前の
   合図がまだ目安に届いていなくても、次の合図は送ります。」
8. What is not mailed (Q8(b)): 「毎分の確認で見つけられなかった触れには、メールを送りません。足が確定したあとに見つけて
   送ることもしません。そうなるのは、その時間の最後の確認のあとに触れた時、確認がなかったか値段を読めなかった時で同じ足の
   あとの確認もなかった時、週の最初の1時間、土日の止まっている時間、冬時間の週の最後の1時間（日本時間 土曜6:00〜7:00）、
   この形に切り替えた1時間、その時間の判定の元（一つ前の足の確定で作るもの）がない時（その時間の始まりにこのチャートを
   受け取る人がいなかった時、一つ前の1時間に足がなかった時など）です。」 Gold's variant adds: 「金は、毎日の休み
   （ニューヨーク時間17時〜18時）のあとの最初の1時間も、判定の元がないのでメールになりません。」
9. Gold only, before the numbers: 「金では測っていません。下の数字は5ペアのものです。」
10. The measured paragraph (section 6.5).
11. Whose rule: 「この決まりは Sextant 独自のもの（96%・利確10 pips・損切りなしは、アプリのオーナーが決めたものです。
    利確10 pips・損切りなしは、測った結果から選んだのではなく、その持ち方で測りました。逆張りの向きは、オーナーが両方の向き
    の数字を見て選びました。毎分の確認で見つけられなかった触れにメールを送らず、足の確定のあとに見つけて送ることもしない
    のも、オーナーが決めたものです）で、公開されているインジケーターではありません。」 Then, as today: the source line,
    the app link, how to stop (the tab's name, 「MACD の逆張り」, Q7(a); during the switch both names, section 6.6), the
    disclaimer.

There is no mail of a touch found after a bar's close: no such decision exists (Q8(b)).

The English says the same: "Found at the once-a-minute check, on the price read at 〔read_at〕 UTC. A touch between
checks is found at the bar's next check; the price is the one that check read." … "The bar before had not closed at 96%
of the top (its line at its close; it may have touched 96% during the bar)." … "Take-profit level: 〔target〕 (10 pips
below the bid). No stop price is given. That is how this rule is built; it is not advice to hold without a stop." Gold:
"Take-profit level: 〔target〕 ($1.00 below the price)." … "A touch the once-a-minute checks do not find gets no
email, and no touch is looked for after the bar closes. That happens when the touch comes after the hour's last check;
when no check ran or the price could not be read and no later check of the same bar came; in the week's first hour; in
the weekend pause; in winter, in the week's last hour (Friday 21:00–22:00 UTC); in the hour this form was switched on;
and when the hour has no basis to judge on (made at the close of the bar before, e.g. when nobody received this chart's
emails as the hour began, or the hour before had no bar)." Gold adds: "On gold, the first hour after each daily break
(17:00–18:00 New York) has no basis either, so it gets no email." … "Sending no email for a touch the once-a-minute
checks do not find, and not looking for one after the bar closes, is also the owner's choice."

### 6.4 The shares' email

1. The bar: 「〔end, JST〕に確定した1時間足」.
2. What happened (the fade side, Q4(a)): 「この足の終わりで、青い線（MACD）が直近120本の MACD の
   枠の上の端の96%以上でした。一つ前の足の終わりでは、96%に届いていませんでした。上の端なので、逆張りの売り（SELL）の
   合図です。株の売りは空売りです。」.
3. The numbers, as 6.3.
4. The price: 「この足の終値: 〔close〕」.
5. The target (Q1(a)): 「利確の幅は書いていません。損切りの値段もありません。これはこの決まりの作りで、損切りをしない
   ことを勧めるものではありません。」.
6. One email (its own text: a share has no target, Q1(a), so 6.3 item 7's 「目安」 sentences do not apply):
   「メールはこの1通だけです。このあと、この合図について知らせは送りません。同じ株・同じ向きに前の合図があっても、次の
   合図は送ります。」 en: "This is the only email; nothing more is sent about this signal. A later signal for this share
   and side is sent too, whatever came before it." (6.3 item 8 does not apply: a share is judged at its close.)
7. A session's last bar or Tokyo's lunch bar: 「この足の終値では、次に市場が開くまで売買できません。」.
8. 「株では測っていません。」 No numbers (the pairs' do not apply).
9. Whose rule (its own text; 6.3 item 11's measured-under sentence does not hold for shares, Q1(a), Q3b(a)): 「この決まりは
   Sextant 独自のもの（96%・損切りなし・利確の幅を書かないことは、アプリのオーナーが決めたものです。逆張りの向きは、
   オーナーが5ペアで両方の向きの数字を見て選んだものを、株にも当てています。株では測っていません）で、公開されている
   インジケーターではありません。」 en: "This rule is Sextant's own (96%, no stop and no take-profit level are the app
   owner's choices; the fade side is the one the owner chose on the five pairs after seeing both sides' numbers there,
   applied to shares too; it was not measured on shares), not a published indicator." Then, as today: the source line,
   the app link, how to stop, the disclaimer; a Tokyo share keeps its 15-minute sentence.

### 6.5 The measured paragraph

The constants live in one place (`FADE_MEASURED`, replacing `RIDE_MEASURED` and `rideMeasuredLine`,
indicators.ts:1626-1663). The release waits until R2 is measured.

**Where each number comes from.** The paragraph sets numbers from three readings side by side, and says which is which:
- **R2** (the function's reading as R2 approximates it, section 8; fade and flow both followed from R2's decisions):
  〔trades〕, 〔tp〕, 〔open〕, 〔openPipsSum〕, 〔openPipsWorst〕, 〔openDays〕 (`openMinutesMax` / 1,440), 〔mean〕,
  〔maeMedian〕, 〔maeMax〕, 〔tpMinutesMedian〕, 〔tpP90Days〕 (`tpMinutesP90` / 1,440), 〔tpDaysMax〕
  (`tpMinutesMax` / 1,440), 〔flowMean〕 (R2's flow trades), 〔pairMean〕 (the mail's pair), 〔negPairs〕 (every pair
  whose R2 fade mean is below zero, each with its mean, or 「ありません」).
- **R1** (the study's reading; R1 must equal the study, section 8): 〔r1Trades〕 and 〔r1Mean〕 (by the study, 2,471 and
  +2.96).
- **R2 against R1:** 〔missed〕, the study's entries in bars where R2 makes no decision: the sum of R2's printout "the
  study's entries R2 does not decide" over its four reasons (section 8: the last part of the hour, no state, the
  weekend gate, other). 〔otherSide〕, the bars R2 decides on the other side from R1 (section 8's keyed outcome "other
  side"): the study's entry there is not mailed either, and R2's decision there is mailed on the other side. They are
  not in 〔missed〕, and the mail says so. R2's other numbers above are over R2's own decisions, so they are the numbers
  of what the mails would have been under R2's reading, which only approximates the function's (section 2.4 lists what
  it does not model); the study's entries counted in 〔missed〕 are in R1's numbers and not in R2's. R2 does
  not model missed or failed checks, a close not judged, a chart nobody followed, or the release hour, so 〔missed〕
  leaves those out; and R2 has no check inside minute 59, so it may count some minute-59 touches the function's check
  in that minute would catch (section 2.4). Neither is measured.
- **The study's baseline** (it does not depend on how a touch is read, so it is not recomputed under R2): 〔baseMean〕
  (`base.all.pipsMean`, +3.19) and 〔pairBaseMean〕 (`base.<pair>.pipsMean`: USD/JPY +5.73, EUR/JPY +3.25, AUD/JPY
  −0.79, EUR/USD +2.56, AUD/USD +5.18, section 1.2; the code copies them from summary-tp.json of run 44011121510, and a
  test pins them to that file's values). 〔higher〕 says whether R2's fade mean came out above or below 〔baseMean〕.

**How section 1.2's caveats travel.** 1: the sentence on the tp share by construction, with flow and the baseline as high.
2: the three means, which is higher, and that the difference was not tested. 3: 〔negPairs〕, in every mail. 4: the
valuation date (2026-11-10, the last minute loaded) and that open trades were not followed after it. 5: section 6.3
item 9 and section 6.4 item 8. 6: the opening (an approximated reading) and the last sentence, on the check's price.
7: the sentences with 〔missed〕 and 〔otherSide〕, beside section 6.3 item 8. CLAUDE.md's count of unfilled orders:
none, said in the paragraph. CLAUDE.md's holding time: the median, the P90 and the longest time to the target, and the
longest hold of a trade still open.

ja outline (pairs): 「測った数字（5ペア、2024年1月〜2026年11月10日に確定した足、スプレッド込み、docs §8.155。過去の値段を、
このメールの読み方に近づけて（1分ごとの買値・売値の足で、毎分の確認として）読み直したもの。同じ読み方ではなく、確認が
1分のどこで行われるか、値段を読む時、確認の抜けは入っていません）: 合図は〔trades〕回、うち〔tp〕回が利確の目安
（+10 pips）に届きました。〔open〕回は、2026年11月10日（読み込んだ最後の1分）の時点で届いていませんでした（その時の値段で
含み損益を数えました。その後は追っていません。含み損は合わせて〔openPipsSum〕 pips、いちばん大きいもので
〔openPipsWorst〕 pips、いちばん長いもので約〔openDays〕日持ったままでした）。指値ではないので、入らなかった合図は
ありません。1回あたり平均〔mean〕 pips（届いていないものは、その含み損益で数えました）。途中の含み損は中央値
〔maeMedian〕 pips、最大〔maeMax〕 pips。目安に届くまでの時間は中央値〔tpMinutesMedian〕分、10回に1回は約〔tpP90Days〕日
より長く、いちばん長いもので約〔tpDaysMax〕日でした。損切りをしないので、目安に
届く割合は作りの上で高く出ます。同じ合図で逆向き（上で買い・下で売り）に入っても、合図なしで毎時の最初の1分に入っても、同じくらい
高く出ました。1回あたりは、逆向き〔flowMean〕 pips、合図なし〔baseMean〕 pips（合図なしは研究の数字）で、この合図より
合図なしの方が〔higher〕出ました。この差が偶然を超えるかは測っていません。この合図が、合図なしで入るより良いとは
示せていません。〔pair〕だけでは平均〔pairMean〕 pips（合図なしでは〔pairBaseMean〕 pips）です。平均がマイナスだった
ペア: 〔negPairs〕。1分ごとの足で読んだ研究では、〔r1Trades〕回・平均〔r1Mean〕 pips でした。研究の合図のうち〔missed〕回
は、毎分の確認では見つからず、足の確定のあとに見つけて送ることもしない（オーナーの決まり）ので、メールになりません（その
時間の最後の確認のあとに触れたもの・週の最初の1時間・土日の止まっている時間など。研究の数字には入っています）。研究と
逆の向きに決まる足が〔otherSide〕回あり、その足の研究の合図も〔missed〕回には入っていません（その足は逆の向きでメールに
なります）。上の〔trades〕回などの数字は、この近づけた読み方でメールになったはずの合図のものです。確認が
抜けた時などの分は、〔missed〕回に入っていません。逆に、59分の確認がその1分の初めの数秒の触れを見つけてメールにすることも
あり、その分も〔missed〕回に入っています。どちらも測っていません。このメールの値段は確認で読んだ時のものですが、測った
数字は、その1分の終値で入ったとして数えています。その差は測っていません。」

Gold: the same paragraph after 6.3 item 9, with the pair sentence replaced by 「金の数字はありません。」 ("There are no
numbers for gold.") and, after the opening, 「この読み直しは5ペアの GMO の値段でしたもので、金の読み方（Swissquote の
値段）ではありません。」 ("This re-reading was made on the five pairs' GMO prices, not the way gold is read, on
Swissquote's prices.") English says the same facts.

v9's 「半分は1分以内」 and every sentence about email 2 go.

### 6.6 The screen

Japanese src/lib/i18n/ja.ts, English src/lib/i18n/en.ts. ja and en keep the same keys and array lengths
(src/test/i18n.test.ts:36-39).
- **The fade rows' tag**, chosen from the id: a pair's or gold's fade row (`macdx_…`) gets the new tag 「（MACD の逆張り）」 /
  " (MACD fade)". A share's fade row (`stockmacd_…`) keeps `ruleTag.stockmacd` 「（株の MACD）」 / " (Stock MACD)"
  (ja:2110 / en:2005), the same name as its tab and its mail's subject. v9 rows keep 「（MACD の流れ）」 (today's
  `ruleTag.macdx`, ja:2110 / en:2005, stays for them).
- **The tab's name changes** (Q7(a)): `ruleTabs.macdx` (ja:2101 / en:1996) becomes 「MACD の逆張り」 / "MACD fade". This
  is done in the screen's PR (section 7, step 4), with the texts below. The function's PR (section 7, step 3) changes
  what the server sends: `RULE_LABEL` and the test-mail lists (supabase/functions/signal-alerts/logic.ts:507-508, 519,
  526, as the maps cite them; not opened again), the mails' how-to-stop line (indicators.ts:1708, 1771) and the econ
  digest's footer (supabase/functions/econ-calendar/digest.ts:423, 452; pinned by src/test/econ-digest.test.ts:284-285).
  econ-calendar is deployed by name (section 7, step 5). Step 3 goes out before step 4 is live, so where these texts
  tell the reader which tab to untick or which mails they get, they name both during the switch: 「「MACD の逆張り」
  （画面が新しくなる前は「MACD の流れ」）」 / "MACD fade (MACD ride until the screen is updated)". A later small PR may
  drop the old name (section 7, step 7). A grep in the answers revision also found the name in the MACD indicator's
  note (ja:557 / en:514, "only the MACD ride email alert" uses the MACD), the FAQ's list of charts (ja:2035 / en:1932)
  and the card intro (ja:2090, 2092 / en:1987, 1988); the answers' review revision found it also in the last sentence
  of the FAQ answer 「メールはいつ届きますか？」 (ja:2037 「Q-Trend・ULTRA・MACD の流れ・流動性狩り＋EMAクロスは、この時間もメールします。」 /
  en:1934 "Q-Trend, ULTRA, MACD ride and liquidity sweep + EMA cross are emailed at those hours too."). Each says the
  new name, in the screen's PR. Code comments that name the ride (index.ts, indicators.ts) go with the code they
  describe.
- **The plan line** of a fade row says which way the target lies from the entry, by the row's side: ja 「入り 〔entry〕 /
  利確の目安 〔target〕（入りから10 pips 下）/ 損切りなし」 for a SELL and 「…（入りから10 pips 上）…」 for a BUY; en "In
  〔entry〕 / take-profit level 〔target〕 (10 pips below the entry) / no stop" (BUY: above). Gold (Q2(a)):
  「（入りから1.00ドル下）」 / "($1.00 below the entry)" (BUY: 上 / above). A share (no target, Q1(a)): 「入り 〔entry〕 /
  利確・損切りなし」.
- **The time column** shows `closed_at`: for a pair's or gold's decision, `read_at`, the time of its price, the same
  time the mail names; for a share, the bar's end.
- **No outcome is shown** (the owner's Q5(a)). MACD rows have `event_id` null, so no result line
  (SignalAlertSettings.tsx:130-131, 404-406). The notes say that whether a trade reached its target is not recorded or
  shown.
- **Texts to rewrite** (each names 90%, 96%, email 1 / email 2, the flow side, the close entry or v9's numbers):
  the card intro (ja:2090 / en:1987); `indicatorIntro.macdx` (ja:2118 / en:2013); `indicatorIntro.stockmacd` (ja:2127 /
  en:2022); `macdxNotes` (ja:2138-2153 / en:2033-2048; the zoom note and the ULTRA note stay); `stockmacdNotes`
  (ja:2192, 2194, 2195 / en:2087, 2089, 2090). The card intro says only what holds for both kinds, or names which is
  which.
  - **The pairs' and gold's texts** (`indicatorIntro.macdx`, `macdxNotes`) say: the 96% touch at the minute's check
    with the forming bar's high (low) so far; the open side, judged on the bar before's line at its close (so two bars
    in a row can each send an email on the same side, section 2.2); the fade side; the price, and that it is the price
    the check read; the target; no stop, and whose choices 96%, the take profit and no stop are (section 6.1); one
    email; no skip; that a touch the once-a-minute checks do not see gets no email, and that no touch is looked for or
    decided after its bar closes (a decision made while the bar formed can still reach a follower up to 30 minutes
    later, section 5.4, and its mail names its own time), with the cases (section 2.5 and the words of section 6.3 item
    8, gold's first hour after each daily break included), and that this is the owner's choice (Q8(b)); gold's two
    feeds; the measured paragraph with its sources, 〔missed〕 and 〔otherSide〕 (section 6.5).
  - **The shares' texts** (`indicatorIntro.stockmacd`, `stockmacdNotes`) say: 96% at a 1-hour close, with the bar
    before not closed at 96%; the fade side, a SELL being a short sale (Q4(a)); the close as the price; no take-profit
    level and no stop, no stop being how the rule is built and not advice, and whose choices these are (section 6.4 item
    9); one email; no skip; a session's last bar; 「株では測っていません」 with no numbers (Q3b(a)). No sentence on the
    minute checks or on 〔missed〕 (Q8(b) does not touch the shares), and no 「利確の目安」.
- One note says: 「メールの MACD は、その時までの高値（売りの合図は高値、買いの合図は安値）を終値とみなして計算します。チャート
  の作っている途中の足は今の値段で描くので、メールの時、チャートの青い線は96%より内側に見えることがあります。」 (en likewise).
- `rideOut`, `rideAt`, `ridePrices` (ja:2238-2243 / en:2132-2137) stay, for v9 rows.
- **The sales page FAQ** (`lp.faqs`, ja:2030-2040 / en:1927-1937). It may quote no percent
  (src/test/landing.test.tsx:51-58) and, by the page's own rule, no measured number; the FAQ test forbids
  `/801|800|429|96\s?%/` (src/test/signal-alert-settings.test.tsx:492).
  - ja:2033 / en:1930 says more reached trades ended at a loss than at a profit. That is false here: every reached trade
    ends at +10 pips. Its first sentence (that every measured signal falls short of break-even) does not hold for the
    fade either: the fade's mean is above zero (+2.96 pips, open trades at their unrealised value), and so is the
    baseline's. The answer becomes, word for word: 「MACD の逆張りを除き、過去のチャート（スプレッド込み）で測ったサインは、
    どれも損益ゼロに必要な勝率に届いていません。数字はアプリ内の説明に載せています。MACD の逆張り（1時間足）は、5ペアで
    測った数字が設定の注にあります。損切りをしないので、利確の目安に届く割合は作りの上で高く出ます。届かずに大きな含み損の
    まま残る取引があり、合図なしで毎時入った時より良いとは示せていません。損切りをしないのはこの決まりの作りで、損切りを
    しないことを勧めるものではありません。金・株と、流動性狩り＋EMAクロスは、まだ測っていません。勝てる根拠として使わない
    でください。」 en: "Except for the MACD fade, none of the signals measured on past charts (spread paid) reached the
    win rate needed to break even. The numbers are in the app's notes. The MACD fade (1-hour) has its own numbers,
    measured on the five pairs only (in the settings' notes). With no stop, the share of trades that reach the
    take-profit level comes out high by construction; some trades stay open with large unrealised losses, and it has
    not been shown to do better than entering every hour with no signal. Having no stop is how this rule is built; it
    is not advice to hold without a stop. Gold, stocks and the liquidity sweep + EMA cross have not been measured.
    Please do not take them as a reason to expect to win." A test pins both.
  - ja:2037 / en:1934: the one email (pairs and gold) is the exception to "a few minutes after the close": it comes
    at a minute's check while the bar forms, and a touch those checks do not see gets none. Its last sentence names
    the new form 「MACD の逆張り」 / "MACD fade" (the tab's name, above).
  - ja:2032 / en:1929 (「他のツールと何が違いますか？」) says the app shows whether each emailed signal reached its stop or
    its target first, and that signals are judged on closed bars only. Neither holds for this form: it decides on a
    forming bar at a minute's touch, and (Q5(a)) whether a trade reached its target is not recorded or shown. It
    becomes, e.g.: the outcome is shown for the rules that record it, and the MACD fade's is not; signals are judged on
    closed bars, except the MACD fade, judged each minute while the bar forms; a signal mailed never vanishes or moves
    afterwards (en likewise).
- **The sales page's honest section** (`lp.honestBody`, ja:2028 / en:1925) says every signal falls short of the win rate
  needed to break even (checked on 11 pairs, which this form was not: it was measured on five), and that the real record
  of the signals emailed is shown in the app, which does not hold for this form (Q5(a)). It becomes, word for word:
  「過去のチャート（11通貨ペア・スプレッド込み）での検証では、MACD の逆張りを除き、アプリのどのサインも損益ゼロに必要な
  勝率に届いていません。MACD の逆張り（5ペアで測定）は損切りをしない決まりなので、勝率では比べられません。届かずに大きな
  含み損のまま残る取引があり、合図なしで毎時入った時より良いとは示せていません。サインは注文の指示ではなく、判断の材料
  です。通知したサインの実際の成績は、成績を記録している決まりについて、件数とともにアプリ内にそのまま表示します。MACD の
  逆張りの成績は、記録も表示もしていません。」 en: "On past charts (11 pairs, spread paid), none of the app's signals
  except the MACD fade reached the win rate needed to break even. The MACD fade (measured on five pairs) has no stop by
  design, so it cannot be compared by win rate: some trades stay open with large unrealised losses, and it has not been
  shown to do better than entering every hour with no signal. A signal is not an order to trade; it is something to
  weigh. For the rules whose results are recorded, the real record of the signals emailed is shown in the app, with
  how many there were. The MACD fade's results are not recorded or shown." No percent and no measured number
  (src/test/landing.test.tsx:51-58); that the other signals' claim still holds on 11 pairs is today's text, not
  checked here. A test pins both.
- **Tests to change:** the lists that forbid 「利確」 / "take profit" (src/test/macd-ride-alerts.test.ts:376, 408;
  src/test/indicator-alerts.test.tsx:1506, 2139; src/test/stockmacd-alerts.test.tsx:550, 583, 716;
  src/test/signal-alert-settings.test.tsx:417, 565, 853) allow it in the target line only. The v10 rows' test
  (signal-alert-settings.test.tsx:736-771) becomes a fade rows' test. v9 rows' tests (:672-734) and old rows' tests
  (:655-670) stay.

## 7. Cut-over from v9, and rollback

**Open v9 rides** (`macd_rides` rows with `status = 'open'`) wait for email 2 at 96%, in the flow direction. The new code
has no v9 path. An open v9 ride would never get email 2 and would stay `open` for good. How many are open now was not
read. v9's longest hold measured was about 28 days (indicators.ts:1637).

The owner's answer (Q6(a)): **release only when no v9 ride is open and none was reached in the last 45 minutes.** Read
just before the merge: `select count(*) from public.macd_rides where status = 'open' or reached_at > now() - interval
'45 minutes'` is 0 (pairs, gold and shares). Else wait. No row is changed by hand. If a ride stays open more than a day,
the owner is told and asked again (Q6's other options). This is v10's rule (research/macdride10-spec.md:470-475).

Had v9's reach been kept: a v9 BUY ride is reached when the line touches 96% at the top. That is the same moment this
form sends a SELL (when the top is open). Both emails would arrive in the same minute. Q6(a) avoids this.

**Timing.** Merge in minutes 31 to 50 of an hour (v9's close entries are judged by minute 30) and outside the 45 minutes
after any share close (v9's share email 2 window). So no v9 ride opens, and no v9 email 2 is offered, under the new code.
Then see in `net._http_response` that v40 answers before minute 59. If it does not, read `macd_rides` and `signal_alerts`
for any row made by v9 after the merge, and report it.

**The release hour and `live_ms`.** The release hour is the 1-hour bar the merge falls in. Its state row was written by
v39, with no `Zp`, so it has **no decision at all**: no minute decision, and nothing at its close (Q8(b), section 5.3).
A touch in it gets no email. The first possible decision is in the next hour, whose state (with `Zp`) v40 writes at
the release hour's close. The release hour is still the first bar whose close v40 judges (about 2.8% of hours have a
decision, section 5.7, so the first decision can be hours later). `live_ms`, for each chart, stays the open of the
release hour (if v40 first answers only after that bar's close, the open of the first bar whose close v40 judged). This
is how v9's `live_ms` was defined: the open of the first 1-hour bar v39 judged (scripts/morning-check/README.md:32). It
is recorded in docs and in the morning-check README, and the switch-day reading of `mc.pairs_v9` / `mc.gold_v9` uses
the same instant (section 8). The new morning check gates bars before `live_ms`; the release hour itself is after it,
so a touch in the release hour shows there as `touch_not_decided` with `why = no_zp` (section 8), not as an error.

**Followers stay.** No subscription changes (section 4.2).

**v9's code is removed, not left dormant:** `rideAtClose`'s rides read, catch-up and entry (index.ts:1010-1016,
1047-1131); `rideMinute`'s rides read, open filter and reach (index.ts:1632-1713); `stockRide` (index.ts:1841-1932);
`rideCloseSignal` and `rideOutSignal` (indicators.ts:794-864); `renderRideMail` (indicators.ts:1680-1828);
`RIDE_MEASURED` and `rideMeasuredLine` (indicators.ts:1626-1663); the share mails (stocks.ts:329-491). The state write
stays, with `Zp`. Reason: dormant code with v10's 95% constants is the mixed state of section 4.4. (This list is for
the owner's answer, Q6(a).)

**Only if a v9 ride stays open more than a day, and the owner, asked again, then chooses Q6(b)** (keep v9's email 2
for rides already open, no new v9 entries), section 7 changes so:
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
   zp_bottom,fade_error&limit=1` and of `macd_fade_moments?select=pair&limit=1` both answer 200. If either does not, the merge
   waits. (The function also guards against a schema fault, section 5.3.)
3. The function's PR merged, once R1 passed and `FADE_MEASURED` holds R2's numbers (section 8). The merge deploys
   signal-alerts and live-chart from source (research/macdride-spec.md:416). Its how-to-stop lines and the digest's
   footer name both tab names (section 6.6).
4. The screen's PR: the tab's new name (`ruleTabs.macdx`, ja and en) and every text of section 6.6, merged and
   published as soon as step 3's deploy is seen answering (v40 in `net._http_response`). It touches no
   `supabase/functions/**`. Lovable's state is reported as given (for example `pending`), not confirmed. Until it is
   live, the screen shows the tab as 「MACD の流れ」 and v9's notes, while the mails name both tabs; the window's start
   and the publish time are recorded.
5. econ-calendar deployed by name right after step 3, since its footer changes (Q7(a)); the footer names both tabs.
6. The morning Routine's prompt replaced and read back before the next 00:16 UTC run (section 8).
7. Later, and only if wanted: a small PR drops 「MACD の流れ」 / "MACD ride" from the how-to-stop lines and the footer,
   once the new tab is seen on the live screen (Lovable's state alone does not show it). It touches
   `supabase/functions/**`, so its merge deploys signal-alerts again; econ-calendar is deployed again by name.

**Rollback.** Revert the function's merge; v39 (v9) is deployed again (the revert's PR touches `supabase/functions/**`,
so its merge deploys).
- v39 writes the state's five numbers; the `Zp` columns stay null on its rows. Harmless.
- `macd_fade_moments` stays, unused. Mails sent stay sent.
- v9's rides after a rollback depend on the answer to Q6 (the owner's is (a); (b) and (c) apply only if the owner
  chooses again, above):
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
  PR is reverted too and the app published again. The tab's name changed (Q7(a)), so the app's tab name and the econ
  digest's footer are reverted too, and econ-calendar is deployed again by name (it is not in the default deploy list,
  .github/workflows/deploy-functions.yml:76, so reverting the function's PR does not redeploy it). Lovable's state is
  reported as given (for example `pending`), not confirmed. The same window as at the release runs in reverse: v39's
  how-to-stop line names 「MACD の流れ」 only, while the screen shows 「MACD の逆張り」 until the reverted app is live.
  It is recorded, not avoided.
- The Routine's prompt goes back to v9's. A copy of v9's prompt is kept before it is replaced.
- A rollback restores a form the owner abandoned. It is only for a failure, and the owner is told.

## 8. Checks before release

**Unit tests** (vitest) of `_shared/macd-ride.ts`:
- `fadeHit` against the rule written again from section 2.2's sentences: random states and extremes, both sides, top
  first, the `Zp` gate at 0.96 with equality;
- the touch's monotonicity at 0.96 on a price grid, both sides;
- `rideZpOf` bit for bit against `zoneAt` at 598 of the window rebuilt;
- `fadeTargetOf` in whole points, BUY and SELL, d = 3, 5 and 2 (gold: ±100 points = ±$1.00, Q2(a), section 2.3);
- the share close entry at 0.96, fade side; both sides never at once;
- the ids: one a rule, built from the constants, matching `FADE_ID`, not matching `RIDE_ID`.

**Function tests:** section 5.6's replays over fake tables; the `signal_alerts` row; the moment row; each mail variant in
ja and en (a pair's, a pair's read that came back after the bar's end, gold's, a share's, a session's last bar); the
sentence that a touch the minute checks do not see gets no email (section 6.3 item 8) in every pair's and gold's
variant and in no share's; the share variants' own one-email and whose-rule texts (section 6.4 items 6 and 9), and
that no share variant contains 「利確の目安」 or "take-profit level"; the pairs' and gold's whose-rule text naming
Q8(b) as the owner's choice (section 6.3 item 11); section 6.1's reached-share fields in every pair's and gold's
variant; section 6.1's two patterns (no text says a price will come back) over every mail variant, the notes, the
plan line and the sales page texts; the how-to-stop lines and the digest's footer naming both tabs (section 6.6); the
run's record.

**App tests:** fade rows labelled with their tag (a pair's and gold's 「（MACD の逆張り）」, a share's 「（株の MACD）」)
and plan line (below / above the entry by the side); v9 rows as before; v8 and older as 「前の決まり」; the tab name,
checked in `ruleTabs` and in `lp.faqs` (no 「MACD の流れ」 / "MACD ride" left in the FAQ); the sales page texts of
section 6.6 word for word; the notes' reached-share fields (section 6.1); the landing page (no percent); i18n's equal
lengths.

**The replay** (research/macdride-replay.ts reworked; GitHub Actions on the study's data, with research/macd90m.ts real at
TOUCH 0.96 and TP 10). The shared code is driven minute by minute over the five pairs as section 5 does it: the bar's
minute checks (which minutes, per reading, below); the bar's decision; at each close, the state only (no decision is
made at a close, Q8(b)). Decisions only in bars whose close is in `[START, END)` (the study's gate).

**The shipped functions decide.** Under both readings the replay takes the hit, `zside` and `side` from `fadeHit`
(with `fadeSideOf`) and the target from `fadeTargetOf`, the same functions index.ts calls, and takes the price by that
`side` (ask for a BUY, bid for a SELL). It works out none of them itself (v10's replay chose the price by its own
expression on `hit.side`, research/macdride-replay.ts:515). So R1 also tests `fadeSideOf` and `fadeTargetOf`.

**The trades, in full.** Each decision is two trades, as the study's entries are: the fade trade (`side` as decided)
and the flow trade (the same moment and price minute, the opposite side, its price by its own side, its target by
`fadeTargetOf` on its own side). Each is followed exactly as `tpTradeOf` (research/macd90m.ts:410-448). The follow is
written once, in the shared code or beside the replay; research/macd90m.ts exports nothing.
- Every decision is a minute's (Q8(b)). At minute `k`: the price is minute `k`'s ask close (BUY) or bid close (SELL);
  `T0` = minute `k`'s end; followed from minute `k + 1`.
- Then: through the **last 1-minute bar loaded** (minutes in no 1-hour bar too, which `tpTradeOf` follows); mae taken
  before the target test in the same minute; out at the target exactly; or open and valued at the **last minute's**
  close (the bid close for a BUY, the ask close for a SELL). (v10's replay valued an open ride at the last 1-hour bar,
  research/macdride-replay.ts:553-556. That changes.)
- The groups (each direction: all, each pair, BUY, SELL, top, bottom; every field of `G`) add their trades in the rows'
  order: by `T0`, then the pairs' order.

- **R1** (the study's reading: the running extremes of the 1-minute mid highs and lows; a check after **every** minute
  of the bar ends, the last minute included, as the study reads; the price of a check, the minute's ask / bid close; the
  study's week). R1 makes no decision at a close and needs none: its check after the bar's last minute reads that minute
  as the study does, so R1 still checks every minute the study reads and must still equal the study (Q8(b) changes R2,
  not R1). An hour with no minute has no check and no decision, as in the study. R1 never reads the chart's 1-hour bar.
  Its rows must equal the `dir = fade` rows of rows-tp.csv, cell for cell, keyed by pair|open: every column of `HEAD_TP`
  (research/macd90m.ts:848). The groups of summary-tp.json `dirs.fade` (all, each pair, BUY, SELL, top, bottom) must
  equal, every field of G; `meta.touch` 0.96, `meta.tp` 10, `start`, `end`, `loadFrom`; and `pairs[].entries`. Sums add
  in the study's row order (research/macd90m.ts:827-831). A pair|open on one side only (in the study or in the replay),
  or two decisions at one bar, is a difference, as v10's replay counts them (research/macdride-replay.ts:833-853). Any
  difference: the first 20 printed and the run fails. The flow rows and `dirs.flow` are compared the same way; they
  share the entries. Why the running extremes give the study's rows: at the first touching minute the running extreme is
  that minute's own (section 2.1). This held for v10 at 90%. At 96% it has not been run.
- **R2** (the function's reading: the mid of the running bid high and running ask high, and of the lows; a minute check
  of bar `j` only when its moment, `m1.t[k] + 1 minute`, is **before** bar `j`'s close, because the function makes no
  check of bar `j` at or after its close: the run at minute 0 checks the next bar (section 5.4); the price of a check,
  the minute's ask / bid close. **No decision at a close** (Q8(b)): nothing is decided at a close, so a touch first
  shown by the minute that ends at the bar's close is not decided. The function's week and state, as the function
  computes them: no read in the weekend gate; bar `j` has a state only when the bar opened one hour before `j` is in the
  data and its close falls outside the weekend gate, so that it is judged (the function writes the state of
  `open(newest closed bar) + 1 hour`, index.ts:1019, and judges a pair's close only when the newest closed bar is the
  grid's previous hour, index.ts:1307, 1355). So the week's first hour, and any bar after an hour with no bar, have no
  state and no decision. Whether the study's data has hours with no bar inside the week was not checked.) Keyed by
  pair|bar against R1: earlier, later, other side, under one reading only. The count of *other side* bars is
  〔otherSide〕 (section 6.5). Then **the study's entries R2 does not decide** (R1's decisions in bars where R2 has
  none), counted and split by reason: *last part of the hour* (R1's deciding minute ends at the bar's close, so no R2
  check comes after it inside the bar); *no state* (an hour whose state no judged close wrote: the week's first hour, or
  a bar after an hour with no bar); *weekend gate* (the bar is in the gate, so not read); *other* (none expected, by section 2.4's argument; each one printed in full). A bar that meets
  more than one reason is counted under the first that holds in the order weekend gate, no state, last part of the hour.
  The sum is 〔missed〕 (section 6.5). Every field of G is printed over their study trades too (R1's fade rows of those
  bars), so the trades the mails leave out are seen with their results. Then every field of G for R2's fade trades **and
  for R2's flow trades**, with the study's baseline (`base`, all and each pair) printed beside. These are the numbers
  the mails give (section 6.5): R2's fade fields over the decisions R2 makes, R2's flow mean, the study's baseline,
  〔missed〕 and 〔otherSide〕. Not modelled: section 2.4's list.
- **Walks** (synthetic): holes in the minutes (an hour with no minute check: neither R1 nor R2 decides it); moved
  prices (R2's `hi` never under R1's, its `lo` never over); a reading with every minute check removed (R2 decides
  nothing: no decision comes from a close); a touch first shown by the minute that ends at the bar's close (R1 decides
  it at that minute, R2 decides nothing, and R2's checks of the next bar do not decide it; it is counted under *last
  part of the hour*); the same touch in a bar whose minute 59 is missing, so that minute 58 is its last (R2 decides it
  after minute 58); an hour with no bar inside the week (the next bar has no state, and a touch in it is counted under
  *no state*); a trade followed through minutes that lie in no 1-hour bar.
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
  are the study's `Zp`, :129-131); the touch as `tq` (:242-255) at 0.96 with the final rounded mid extremes. The side
  is the fade side.
  - **Errors:** a decision where the bar's final extremes do not touch 0.96 on its side, or on a side that is not
    open (`extra`: the extremes so far never pass the final ones, section 2.1); two decisions in a bar (`dup`; the
    primary key should make it impossible); a wrong side, price or target (`side_differs`, `entry_differs`,
    `target_differs`); a state row with `fade_error` set (`moment_refused`: a moment row refused by a check of section
    5.1, so a decision that sent no mail).
  - **Not an error: `touch_not_decided`.** A bar with an open side and its final extreme touching, but no decision, can
    no longer be called missing (Q8(b)): the hour bar cannot tell whether the touch came after the hour's last check,
    which is then rightly not mailed. Such a bar is reported as its own kind, counted, and never called an error or
    `missing`. Its `why` comes from the stored rows: `no_state` (no state row for the hour: the week's first hour, a
    bar after an hour with no bar such as gold's first hour after its daily break, a chart nobody followed when the
    close before was judged, a close not judged), `no_zp` (a state row with `zp_m` null: the release hour), `checks` (a
    state row with `Zp` and no `fade_error`: the touch came after the hour's last check, or in missed or failed checks;
    the hour bar cannot tell which). The report gives the count by `why` beside R2's 〔missed〕 and says that the two do
    not count the same things.
  - **Attention (verdict `CHECK`: needs a human look, not an error).** `touch_not_decided` alone would let a stopped
    state write or a stopped minute path cut off every mail while the check still answered OK. So:
    `state_missing=N` (a bar opened at or after `live_ms` + 1 hour, outside the weekend gate, not the week's first hour
    and not after an hour with no bar, on a chart with a `macdx` subscription, with no state row); `zp_missing=N` (a
    state row with `zp_m` null for a bar opened after the release hour); `undecided_checks=N` (over the day's bars of
    the five pairs, more `checks` bars than decisions; once R2 has run, the bound is set from R2's *last part of the
    hour* count against its decisions instead). A follower who subscribes during an hour can put that hour into
    `state_missing` rightly; the list is for a look, not a verdict of fault.
  - When both sides are open and both touch, the hour bar cannot tell which was first: a decision there says
    `side_not_recounted`, not `extra`.
  - Gates: before go-live, no subscription, the weekend gate.
- **Against production:** `macd_fade_moments` (one row a decided bar; `x` inside the bar's final mid range and touching
  0.96 on its state; `source = 'minute'` on every pair and gold row; `decided_at` inside the bar and `read_at` not
  before it); `signal_alerts` under the new id (one row a follower; `entry` inside the bar's ask range for a BUY or bid
  range for a SELL; `round(target · 10^d) = round(entry · 10^d) ± 100` exactly; `stop` null; `closed_at` equal to the
  moment row's `read_at`); the state rows (the five numbers and `Zp` against the recount). `mg0` / `us` (:70-93) must
  carry the raw bid and ask highs and lows.
- **The target, recounted at hour precision:** the first bar after the entry bar whose bid high (BUY) or ask low (SELL)
  reaches the target is the tp bar (exact at the hour). In the entry bar it is unknown when the extreme came. Open trades
  are listed with their unrealised pips at the newest stored close, their worst against over the bars after the entry
  bar, and their days held. A trade older than the 40-day load (:18, :22) is reported as not followed. A report carries
  the mean pips a trade (open trades at their unrealised value), the tp count, the open count, the open losses, the
  worst against, the days held, and that no order went unfilled (the entry is not a limit order); never a bare rate.
  These are the real mails' results, recounted at hour precision, not R2's numbers.
- **Gold:** as scripts/morning-check/gold-v9.sql, with its two sources; the target $1.00 (`round(target · 100) =
  round(entry · 100) ± 100`, Q2(a)); the same errors, `touch_not_decided` and attention entries. Gold's recorded
  minutes (kept two days) can tell, for a `touch_not_decided` bar, the first minute whose running extreme touched. When
  that minute is before minute 58 in an hour whose state has `Zp`, the bar goes into the attention list as
  `ticks_touch_early`: a fact about the minutes, not a verdict (a check in that hour may have failed, and the two feeds
  differ, section 2.6).
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

## 9. Questions for the owner, and the answers

The spec was first written with a recommended option for each question. The owner answered all eight on 2026-11-17, in
the question dialog (section 1.1, item 6). Eight of the nine answers (Q3 has two parts) are the recommended option;
**Q8's is not**. The spec is now
written with the answers. Each question is kept short below, with its options and the owner's answer marked.

**Q1. The shares' take profit.** (Only if Q3b is (a).) Shares have no pips.
- (a) No target: the email states the price in and no take-profit level. Recommended. **The owner's answer.**
- (b) A percent of the price in (the owner names it; v8 measured 0.1, 0.25, 0.5 and 1%, docs §8.133).
- (c) Ten price steps ($0.10 on a US share, ¥1.0 on a Tokyo share).
- (d) A money amount ($10 / ¥10 a share).

Why (a) was recommended: pips do not apply to shares; the owner's only word on a share take profit is 「出す、利確幅は
いらない、自分で決める」 (2026-10-31, docs/OPERATIONS.md:12033); no share take profit was measured at 96%. With (a),
`target` is null on a share's row and the share id has no `tp` part (section 4.2).

**Q2. What "10 pips" is on gold.** (Only if Q3a is (a).)
- (a) $1.00 an ounce. Recommended. **The owner's answer.**
- (b) $10.00 an ounce (the app's dollar convention for gold levels, docs/OPERATIONS.md:3444).
- (c) $0.10 an ounce (the chart's cent, which its own code calls no convention, src/lib/candleTime.ts:56-58).

Why (a) was recommended: it is the owner's own 1 pip = $0.10 (2026-10-11, docs/OPERATIONS.md:9206), and it is what the
study's rule (10 points a pip) gives at gold's 2 decimals (checked in the code, section 2.3). Scale measured elsewhere,
not for this form: gold's median 1-hour range was $14.3 (docs/OPERATIONS.md:4093) and its median Dukascopy spread $0.54
(docs/OPERATIONS.md:4127). The app's gold price is a mid with no spread.

**Q3a. Gold is not measured with this form.**
- (a) Release gold with the pairs. Its mails and notes say 「金では測っていません」 and give no number of gold's. Measure
  it later as its own task. Recommended. **The owner's answer.**
- (b) Measure gold first (on Dukascopy bid and ask minutes, research/dukascopy.py). Until then gold gets no MACD email.
- (c) Drop gold from the MACD email.

Why (a) was recommended: v9 and v10 did the same with the same words; gold's followers keep an email; nothing
unmeasured is claimed.

**Q3b. The shares are not measured with this form.**
- (a) Release the shares with the pairs. Their mails and notes say 「株では測っていません」 and give no number. Measure
  them later as their own task. Recommended. **The owner's answer.**
- (b) Measure the shares first (on Yahoo 1-hour closes at 96%). Until then the shares get no MACD email.
- (c) Drop the shares from the MACD email.

Why (a) was recommended: as Q3a.

**Q4. The shares' side.** (Only if Q3b is (a).)
- (a) Fade, as the pairs: top SELL (a short sale), bottom BUY. Recommended. **The owner's answer.**
- (b) Flow, as v9's shares: top BUY, bottom SELL.

Why (a) was recommended: the owner chose 「逆張りで作る」 for the email after seeing both sides measured on the five
pairs; the owner's earlier 「株も93%に合わせる」 was about the level, not the side. The nearest measured share rule (v8,
docs §8.133) is a fade. With (a), the moment table's fade check holds on every chart (section 5.1).

**Q5. Anything when the +10 target is reached?**
- (a) Nothing. One email only. Whether a trade reached its target is not recorded or shown; the notes say so.
  Recommended. **The owner's answer.**
- (b) No email, but the server follows each trade and the app shows "reached" or "still open".
- (c) A second email at the target.

Why (a) was recommended: the owner asked 「1通だけ」; following costs reads all the time; the morning check can recount
the target at hour precision. With (a), the sales page's sentences that the real record of the signals emailed is shown
in the app (ja:2028, 2032 / en:1925, 1929) are narrowed for this form (section 6.6).

**Q6. v9 at the release.**
- (a) v9 stops at the release. Release only when no v9 ride is open and none was reached in the last 45 minutes. If one
  stays open more than a day, ask the owner again. Recommended. **The owner's answer.**
- (b) Keep v9's email 2 for rides already open, with no new v9 entries, until none is open (section 7 names the code
  kept).
- (c) Stop v9 at once even with rides open; those rides stay `open` for good.

Why (a) was recommended: it was v10's rule; the new code needs no v9 path; no follower waits for an email 2 that never
comes; no v9 email 2 and new SELL arrive in the same minute; a rollback starts v9 with no ride open. If a ride stays
open more than a day, (b) and (c) are put to the owner again (section 7).

**Q7. The name.** 「MACD の流れ」 / "MACD ride" says flow; the new form fades.
- (a) 「MACD の逆張り」 / "MACD fade" for the new form; v9 rows keep 「MACD の流れ」 on the screen. Recommended. **The
  owner's answer.**
- (b) Keep 「MACD の流れ」 / "MACD ride".
- (c) Another name the owner gives.

Why (a) was recommended: the name should say what the email does; a per-id tag keeps old rows true. With (a), the tab's
name, `RULE_LABEL`, the test-mail lists, the how-to-stop lines and the econ digest's footer change, and econ-calendar
is deployed by name (sections 6.6 and 7).

**Q8. A touch the minute checks did not see** (after the hour's last check, in the week's first hour, in the release
hour, in an hour whose state was not written, in missed or failed checks with no later check in the same bar).
- (a) One late email after the bar closes, at the bar's close price, saying it is late and that when it touched is not
  known. This was the recommended option.
- (b) No email for that bar. **The owner's answer, which is not the recommended option.**

Why (a) had been recommended: for a touch in the last minute, the bar's close is the study's own entry price (expected,
not checked); without a late email the study's entries there go unmailed.

What (b) means, as the spec now reads: a pair's or gold's bar is decided only by a minute's check made while it forms;
nothing is decided at a close, for any reason (sections 2.2, 2.5, 5.3). The shares are not affected. For the numbers:
- The mails give R2's numbers over the decisions R2 makes (section 6.5). R2 has no check at or after a bar's close
  (section 8).
- The study's entries that the checks miss are not mailed. They stay in the study's (R1's) numbers and are not in R2's.
  R2 counts them by reason (the last part of the hour, no state, the weekend gate, other), and the mails give the sum as
  〔missed〕 (section 6.5). 〔missed〕 is not known yet: R2 has not been run. The bars R2 decides on the other side are
  not in 〔missed〕; their count, 〔otherSide〕, is given beside it.
- R2 does not model missed or failed checks, a close not judged, a chart nobody followed, or the release hour, so
  〔missed〕 leaves those out. R2 also has no check inside minute 59, so it may count some minute-59 touches that the
  function's own check in that minute would catch (section 2.4). Neither effect is measured.
- The morning check can no longer call an undecided touching bar missing; it reports it as `touch_not_decided`
  (section 8).
- No decision is made after a bar's checks end, so no mail's price comes from after its bar's last check began. The
  price of every mail is the one its deciding check read (section 2.3). That check's moment is inside the bar, but its
  answer can come up to about a minute and a half later: in a minute-59 run, after the bar's end (section 2.4). After
  missed or failed checks, or a state written late (a pair's at minute 3 or 5, gold's up to minute 29), the deciding
  check and its price can come most of an hour after the touch (sections 2.4, 2.5).

## 10. What this spec did not read, confirm or measure

- **How this spec was made.** It rests on four maps written for it (the function, the app, the checks, gold and shares;
  not kept in the repository) and on this writer's own reading. This writer read in full research/macdride-spec.md,
  research/macdride10-spec.md and research/macd90m-spec.md; read research/macd90m.ts:1-215 and :330-460; and opened again
  the cited lines of index.ts, indicators.ts, macd-ride.ts, src/lib/signalAlerts.ts, the `macd_rides` and
  `signal_alerts` migrations, and the docs lines on gold's pip and the shares' target. Other cited lines (the screen and
  i18n files, the tests, the morning-check SQL, stocks.ts beyond its constants, gold-minutes.ts, live-chart,
  econ-calendar) are the maps' citations; this writer did not open them again.
- **The first review revision** (after three reviews, 2026-11-17) opened again, and checked the reviews' citations against:
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
- **The answers revision** (2026-11-17, on 345a3f4: the owner's answers to Q1..Q8, section 1.1 item 6). What it did:
  read this whole file first; wrote the answers into the header, section 1.1 and section 9; removed every decision at a
  close for the pairs and gold (Q8(b)) from sections 2.2 to 2.6, 5.3 to 5.8, 6.3, 6.5, 6.6, 7 and 8, and added caveat 7
  to section 1.2 (section 1.2's numbers were not changed); tightened the moment table's checks (section 5.1); added
  〔missed〕 (sections 6.5, 8) and `touch_not_decided` (section 8). What it opened again: research/macd90m.ts:360-450
  (`touchEntriesOf`, `tpSideOf`, `tpTradeOf`); indicators.ts:728-782 (`ridePaidAt`, `rideFormingOf`,
  `goldHourExtremes`), :898-907 (`ridePnl`), :1218-1232 (`gmoIntervalsDue`), :1294-1315 (`startWaitMs`,
  `twelveCloseDue`) and :1585-1590 (`decimalsOf`); indicators.ts:284-295 (`MACDH_PAIRS`); live-chart/logic.ts:285-286
  (`GOLD`, `isGold`); stocks.ts:54-56 (the share symbols) and :289-296 (`stockBarBreak`);
  scripts/morning-check/README.md (a grep, for `net._http_response`, :459); and a grep of src and supabase/functions for
  「MACD の流れ」 / "MACD ride" (section 6.6). It ran one node check of the gold target arithmetic (section 2.3: 2,000,000
  prices, both sides, none off). It did not open logic.ts (the admin list), econ-calendar/digest.ts, the i18n lines
  beyond the grep, or index.ts beyond the grep; it ran no test, no replay and no SQL; it did not check whether GMO's
  1-hour read at minute 0 holds the closed bar beside the forming one (section 5.6's test makes it do so, so the old bar
  is in front of the check); it did not check that the week's first hour has no state in every season (section 2.5 keeps
  the earlier text); and nothing about how many touches Q8(b) leaves unmailed is measured (〔missed〕 waits for R2).
- **The answers' review revision** (2026-11-17, after three reviews of the answers revision). What it did: checked
  each finding against this file and the code and fixed the ones that held: a refused moment row is now kept on the
  state row (`fade_error`, section 5.1) and reported as `moment_refused`, and the morning check has attention entries
  for a stopped state write or minute path (section 8); a decision is offered every run for its 30 minutes, with no
  "done" memo (section 5.4); no forming read without a state with `Zp` (section 5.4); a bar after an hour with no bar,
  gold's first hour after each daily break included, has no state (section 2.5, R2 in section 8); the shares' tag, notes
  and mail texts written out (sections 4.3, 6.4, 6.6); the tab's rename put in the screen's PR, with both names in the
  server's texts during the switch (sections 6.6, 7); the sales page texts written word for word (section 6.6);
  〔otherSide〕, the holding-time tail and the approximated reading in the measured paragraph (section 6.5); the owner's
  Q8(b) named as the owner's choice in the mails (section 6.3); the wider guard patterns (section 6.1); and the wording
  of caveat 7, section 2.5's last paragraph and section 9. Section 1.2's numbers were not changed. What it opened
  again: index.ts:770-800 (`mailRide`), :1005-1030 (`forming = newest + HOUR`), :1160-1295 (the close's ride work and
  gold's close) and :1295-1365 (the pairs' expected bar, `not_yet`); indicators.ts:1295-1320 (`twelveCloseDue`), :1708
  and :1771 (the how-to-stop lines); supabase/functions/_shared/market-hours.ts:205-275 (`isGoldBreak`);
  src/components/SignalAlertSettings.tsx:105-130 (`rowLabel`); ja.ts:2028, 2032, 2033, 2037, 2101, 2110, 2144 and en.ts
  :1925, 1929, 1930, 1934, 1996, 2005, 2039; a grep of econ-calendar/digest.ts for the tab's name (:423, :452);
  research/macd90m.ts:795-815 (G's `tpMinutesP90`, `tpMinutesMax`); research/macdride-spec.md:255-260; and a grep of
  scripts/morning-check/README.md for its verdict words (`SUMMARY` `OK` / `CHECK`, `attention`). It ran the two guard
  patterns over today's ja.ts and en.ts (section 6.1). It did not open logic.ts; it ran no test, no replay and no SQL;
  it did not check that Twelve Data has no gold bar opened at 17:00 New York, or whether GMO's data has hours with no
  bar inside the week.
- **Not read by this writer or the maps:** the real rows-tp.csv and summary-tp.json (not on this machine);
  research/macd90m-check.py beyond its outline; src/test/macd-ride-v10.test.ts; research/macdride-replay.ts beyond the
  lines the maps cite; supabase/functions/signal-alerts/logic.ts beyond the lines naming the rule's label (the admin
  list was not opened); record.ts; the GMO request code beyond `fetchLiveQuotes` and `splitBars`.
- **Not confirmed:** run 43815122929 on GitHub (runs 43999915487 and 44011121510 were checked by the task's runner:
  success, "PYTHON AGREES"); that GMO's 1-hour close equals its last 1-minute close (no mail uses it under Q8(b));
  that Twelve Data's gold price is a mid (only the docs say so); the Lovable state of the live
  screen; that production's `signal_alerts` has no index beyond the repository's migrations; that PostgREST answers 4xx
  (not 5xx) to a missing column or table, or to a check violation (expected, not checked); that a merge-duplicates
  upsert leaves `fade_error`, a column it does not send, as it is (expected, not checked); that Twelve Data has no gold
  bar opened at 17:00 New York; whether GMO's data has hours with no bar inside the week.
- **Not seen (production, by rule):** how many v9 rides are open; how many followers each chart has; whether `spike`
  followers exist on every chart (which decides whether the forming read is already made each minute); which
  subscriptions the owner has; the Routine's prompt.
- **Not run:** any test, the app, the replay.
- **Not measured:** the moment of a check within its minute; how long after `nowMs` the forming read's answer comes,
  and how often a minute-59 read comes back after the bar's end; the added GMO requests; the added database egress,
  database work (the `signal_alerts` reads) and run length; how long the new index takes to build; how often two bars in
  a row are decided on the same side; how often two stock runs overlap; every difference between the function's
  reading and the study's for the 96% fade (R2 will measure part of it); how many of the study's entries the minute
  checks do not mail (〔missed〕, R2 will count the part it models), and how often the function's own check in minute 59
  catches a touch R2 counts as missed; whether the fade's mean differs from the baseline's beyond chance (the per-trade
  rows were not downloaded); how many bars a normal day puts into the morning check's attention entries; gold and
  the shares with this form.
