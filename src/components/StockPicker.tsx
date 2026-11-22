import { useEffect, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { searchStocks } from "@/lib/liveChart";
import { isStockQuery, matchListed, stockMarketOf, type StockHit } from "@/lib/stocks";

// v42 (research/allstocks-prod-spec.md 6.2): the stock MACD tab's search for a share to alert. The chart's search box
// is a closure inside LiveChart (its state and setPair), so it is not reused as it is; this reuses its data layer, as
// the chart does it: live-chart's `search` (Yahoo's search, through the function; sign-in only), the 22 listed shares
// whose name holds the words (Yahoo refuses Japanese words), the wait for the typing to stop, and the rule that only
// ASCII words are sent to Yahoo; the listed finds first, then Yahoo's less those. A pick gives the hit and the words
// typed when it was shown (`q`, which the function searches again to confirm a share nobody follows yet). LiveChart
// is not changed (its search keeps its own code and tests).

// how long the search waits for the typing to stop (the chart's SEARCH_WAIT_MS)
const SEARCH_WAIT_MS = 400;

interface Props {
  onPick: (hit: StockHit, q: string) => void;
  disabled?: boolean;
  // Injected by tests; the app uses the live chart's search
  loadSearch?: (q: string) => Promise<StockHit[]>;
}

const StockPicker = ({ onPick, disabled = false, loadSearch = searchStocks }: Props) => {
  const { t, locale } = useLocale();
  const l = t.live;
  const a = t.alerts;
  const [stockQ, setStockQ] = useState("");
  const [found, setFound] = useState<{ q: string; hits: StockHit[]; status: "loading" | "ready" | "error" } | null>(null);
  useEffect(() => {
    const q = stockQ.trim();
    // eslint-disable-next-line no-control-regex
    if (!isStockQuery(q) || /[^\x00-\x7F]/.test(q)) {
      setFound(null);
      return;
    }
    let stop = false;
    setFound({ q, hits: [], status: "loading" });
    const id = window.setTimeout(() => {
      loadSearch(q).then(
        (hits) => {
          if (!stop) setFound({ q, hits, status: "ready" });
        },
        () => {
          if (!stop) setFound({ q, hits: [], status: "error" });
        },
      );
    }, SEARCH_WAIT_MS);
    return () => {
      stop = true;
      window.clearTimeout(id);
    };
  }, [stockQ, loadSearch]);

  const q = stockQ.trim();
  const listedFinds = matchListed(stockQ);
  const remote = found && found.q === q ? found : null;
  const hits: StockHit[] = [
    ...listedFinds.map((s) => ({ symbol: s.symbol, name: locale === "ja" ? s.ja : s.en, market: stockMarketOf(s.symbol) })),
    ...(remote?.hits ?? []).filter((h) => !listedFinds.some((s) => s.symbol === h.symbol)),
  ];

  return (
    <section className="space-y-1" data-testid="stockmacd-search">
      <label className="block text-[11px] font-semibold text-muted-foreground" htmlFor="stockmacd-q">{a.stockmacdSearchLabel}</label>
      <input
        id="stockmacd-q"
        type="search"
        value={stockQ}
        onChange={(e) => setStockQ(e.target.value)}
        placeholder={l.stockSearchPlaceholder}
        maxLength={40}
        disabled={disabled}
        data-testid="stockmacd-q"
        className="w-full rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
      />
      {q !== "" && (
        <>
          {hits.length > 0 && (
            <ul className="divide-y divide-border rounded border border-border">
              {hits.map((h) => (
                <li key={h.symbol}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setStockQ("");
                      onPick(h, q);
                    }}
                    data-testid={`stockmacd-hit-${h.symbol}`}
                    className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="font-mono font-semibold">{h.symbol}</span>
                    <span className="flex-1 truncate">{h.name}</span>
                    <span className="text-[10px] text-muted-foreground">{l.stockMarkets[h.market]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {remote?.status === "loading" && <p className="text-[11px] text-muted-foreground" data-testid="stockmacd-searching">{l.stockSearching}</p>}
          {remote?.status === "error" && <p className="text-[11px] text-destructive" data-testid="stockmacd-search-error">{l.stockSearchError}</p>}
          {hits.length === 0 && remote?.status !== "loading" && remote?.status !== "error" && (
            <p className="text-[11px] text-muted-foreground" data-testid="stockmacd-no-hits">{a.stockmacdNoHits}</p>
          )}
        </>
      )}
    </section>
  );
};

export default StockPicker;
