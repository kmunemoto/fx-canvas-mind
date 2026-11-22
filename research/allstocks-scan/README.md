# A one-off scan of every listed US and Tokyo share with the stock MACD email's rule

The owner asked (2026-11-22) which shares have a sell signal, over all listed US and Tokyo shares
(「全ての株で調べて」, then 「米国・日本の上場株すべて」). This folder reads each share's 15-minute bars from Yahoo
once and judges its last session with the app's own code. It is not part of the app and changes nothing in production.

- `list.py`: the share list from the public listing files: JPX's list of listed issues and Nasdaq Trader's symbol
  directory. It keeps Tokyo's Prime, Standard and Growth shares (domestic and foreign), and US common shares, ADRs and
  the other share kinds. It leaves out ETFs, test issues, warrants, rights, units, preferred shares, notes and
  closed-end funds, and any symbol that is not the app's shape. The headers are the ones of 2026-11-18 (run
  44343329657 of `.github/workflows/stocklist-probe.yml`); a changed header stops it.
- `judge.ts`: the judgment, the production code's own.
  - The bars come from `stockBarsOf`. A bar is judged when its end is a regular close (`CLOSES`). Tokyo's
    11:30-11:45 bar is in the closes but is never judged, as in the run.
  - The entry is `fadeCloseEntryAt` on the closed bars up to the judged one, never a later one.
  - The zone is `closeZonesAt` at the newest closed bar.
- `scan.ts`: reads Yahoo one share at a time, at most one read every 0.6 s. A 429 waits 60 s and is tried again, up
  to 3 times. The scan stops after 3 shares in a row are refused. A stopped scan goes on from where it stopped.
  Yahoo's answers are not kept; each output line holds the symbol, the outcome, times, sides and the line's share of
  the pane's end. No price is written.
- `report.ts`: a Markdown summary of the results.
- `judge_test.ts`, `scan_test.ts`, `fake.ts`: tests on made-up prices and a fake Yahoo (no network).

## Rules

- **Nothing of Yahoo goes into the repository or the Actions logs**: no bars, no prices, no results. The listing
  files, `symbols.json`, `results.jsonl` and `report.md` stay in the session's scratchpad. Reports to the owner give
  symbols, names, sides and times, never prices.
- Run it only where the session's own network allows `query1.finance.yahoo.com`, `www.jpx.co.jp` and
  `www.nasdaqtrader.com` (the "fx-canvas-mind" environment allows the last two; the first must be added by the owner).
  Do not route around a proxy refusal.

## Steps

```sh
W=<the scratchpad>/allstocks-scan; D=$W/lists; mkdir -p $D
curl -sSf -o $D/data_j.xlsx https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx
curl -sSf -o $D/data_e.xlsx https://www.jpx.co.jp/english/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_e.xlsx
curl -sSf -o $D/nasdaqlisted.txt https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt
curl -sSf -o $D/otherlisted.txt https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt
/usr/bin/python3 -I research/allstocks-scan/list.py $D $W/symbols.json   # needs openpyxl
deno test --allow-env --allow-read --allow-write research/allstocks-scan/
```

1. **Check first, on the 22 shares** (stop if this does not match):
   - Write a list of the app's 22 (`STOCKMACD_PAIRS`) as `$W/check22.json`, then scan it into `$W/check22.jsonl`.
   - Compare its US entries of 2026-11-20 with production's mails of that day. Read them with a read-only query of
     `public.signal_alerts`, naming its columns: `pair, side, bar_time`, where `kind = 'signal'` and
     `rule = 'stockmacd_12_26_9_w600_15min_fade96of120_in_v5'`. Do not `select *` and do not read the error column.
   - Production mailed 8, all BUY (opens, UTC): NVDA 14:30 and 19:45, TSLA 15:15, AMZN 15:45 and 19:15, AAPL 18:00
     and 20:30, GOOGL 20:45.
   - The scan must give exactly these for the 8 US shares that day.
   - Tokyo cannot be checked this way: production judged Tokyo's 15-minute bars from v41 on, after Friday's Tokyo
     session.
2. **The whole list:**
   `deno run --allow-env --allow-net=query1.finance.yahoo.com --allow-read --allow-write=$W research/allstocks-scan/scan.ts $W/symbols.json $W/results.jsonl`.
   - About 9,600 shares at 0.6 s each: about 1.5 to 2 hours.
   - It prints counts every 200 shares. Run it again to go on after a stop.
3. `deno run --allow-read --allow-write=$W research/allstocks-scan/report.ts $W/symbols.json $W/results.jsonl $W/report.md`.
4. Report to the owner in Japanese:
   - how many shares were listed, read, not read, and too short (fewer than 600 bars);
   - the last session's date;
   - the SELL entries (symbol, name, the bar's time) and how many BUY entries;
   - the shares in the zone at the last bar.
   - Say that this rule's results on shares are not measured, that a SELL on a share is a short sale, and that a signal
     is not an order.

## Not measured, not checked

- The listing files' formats after 2026-11-18. `list.py` checks the headers but not every value.
- Whether Yahoo answers ~9,600 reads in a row without refusing. The scan reads more slowly than the app's run and
  stops on refusals.
- The scan's Tokyo judgments against production: see step 1.
