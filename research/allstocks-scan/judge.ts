// A one-off scan of every listed US and Tokyo share with the stock MACD email's rule (signal-alerts v42: the fade on
// 15-minute bars, the close at 96% of the MACD pane's end, research/macdfade15min-prod-spec.md 3.3), as the app's
// production code judges it. This file is the pure part: given a share's bars as stockBarsOf makes them from Yahoo's
// answer, which bars of its last session the production run would judge, and the entry (if any) at each.
//
// Nothing here is new judgment code: the entry is _shared/macd-fade.ts fadeCloseEntryAt on the closed bars ending at
// the bar judged (the 600 newest of them, as the run passes them), the bars judged are the ones whose end is one of
// the regular closes (signal-alerts/stocks.ts CLOSES: the run reads at those closes; Tokyo's 11:30-11:45 bar, whose end
// is no close, is in the 600 but never judged), and the "zone" is closeZonesAt at the newest closed bar.
// No price leaves this file: the result holds times, sides and the line's share of the pane's end only.

import { CLOSES, localOf, type StockBar } from "../../supabase/functions/signal-alerts/stocks.ts";
import { closeZonesAt, FADE_SHARE, fadeCloseEntryAt, type FadeSide } from "../../supabase/functions/_shared/macd-fade.ts";
import { LEVEL_WINDOW } from "../../supabase/functions/_shared/macd-level.ts";
import { isStockSymbol, stockMarketOf } from "../../supabase/functions/live-chart/stocks.ts";

const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

// The market's own date of a time (YYYY-MM-DD): Tokyo's (UTC+9, no summer time) or New York's
export const marketDate = (sym: string, ms: number): string =>
  stockMarketOf(sym) === "jp" ? new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10) : NY_DATE.format(new Date(ms));

export interface SessionSignal {
  // the judged bar's open, ISO (UTC)
  open: string;
  side: FadeSide;
}

export interface SessionJudgment {
  // the market date of the newest closed bar (the last session), null with no closed bar
  day: string | null;
  // closed bars Yahoo gave (all sessions)
  closedBars: number;
  // bars of the last session that the run judges (their end is a regular close)
  sessionBars: number;
  // of those, how many had fewer than LEVEL_WINDOW closed bars up to them (the run makes no entry there)
  shortBars: number;
  // the entries of the last session, oldest first
  signals: SessionSignal[];
  // at the newest closed bar: the MACD line's share of the pane's top (when the line is above 0 and the top is above 0)
  // or of its bottom (below 0), and whether it is at FADE_SHARE or more on that side ("SELL" at the top, "BUY" at the
  // bottom). null when closeZonesAt is null (fewer than LEVEL_WINDOW bars, a bad close)
  zone: { side: FadeSide | null; share: number | null } | null;
}

export const judgeLastSession = (sym: string, bars: ReadonlyArray<StockBar>): SessionJudgment => {
  if (!isStockSymbol(sym)) throw new Error(`judgeLastSession: not a share symbol: ${sym}`);
  const closed = bars.filter((b) => b.closed);
  const empty: SessionJudgment = { day: null, closedBars: closed.length, sessionBars: 0, shortBars: 0, signals: [], zone: null };
  if (closed.length === 0) return empty;
  const day = marketDate(sym, closed[closed.length - 1].open_ms);
  const closes = closed.map((b) => b.close);
  const regular = CLOSES[stockMarketOf(sym)];
  const signals: SessionSignal[] = [];
  let sessionBars = 0;
  let shortBars = 0;
  for (let k = 0; k < closed.length; k++) {
    const b = closed[k];
    if (marketDate(sym, b.open_ms) !== day) continue;
    if (!regular.includes(localOf(sym, b.end).min)) continue;
    sessionBars++;
    if (k + 1 < LEVEL_WINDOW) {
      shortBars++;
      continue;
    }
    // the closed bars up to and including the judged one, never a later one
    const e = fadeCloseEntryAt(closes.slice(0, k + 1));
    if (e) signals.push({ open: new Date(b.open_ms).toISOString(), side: e.side });
  }
  const zs = closeZonesAt(closes);
  let zone: SessionJudgment["zone"] = null;
  if (zs) {
    const { m, top, bottom } = zs.z;
    if (m > 0 && top > 0) zone = { side: m >= FADE_SHARE * top ? "SELL" : null, share: m / top };
    else if (m < 0 && bottom < 0) zone = { side: m <= FADE_SHARE * bottom ? "BUY" : null, share: m / bottom };
    else zone = { side: null, share: null };
  }
  return { day, closedBars: closed.length, sessionBars, shortBars, signals, zone };
};
