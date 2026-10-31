// #389: US and Japanese shares on the live chart (docs §8.132). What a share
// is named and read as is supabase/functions/live-chart/stocks.ts, as the
// live-chart function reads it; this adds the shares the picker lists
// before any search, and their names.
export {
  STOCK_INTERVALS,
  isStock,
  isStockQuery,
  isStockSymbol,
  stockDecimals,
  stockMarketOf,
  type StockHit,
  type StockMarket,
} from "../../supabase/functions/live-chart/stocks";

export interface StockListed {
  symbol: string;
  ja: string;
  en: string;
}

// The US shares checked on 2026-10-31 (all on Twelve Data's free plan too),
// the two in that week's news first
export const US_STOCKS: StockListed[] = [
  { symbol: "NVDA", ja: "エヌビディア", en: "NVIDIA" },
  { symbol: "INTC", ja: "インテル", en: "Intel" },
  { symbol: "AAPL", ja: "アップル", en: "Apple" },
  { symbol: "MSFT", ja: "マイクロソフト", en: "Microsoft" },
  { symbol: "GOOGL", ja: "アルファベット（グーグル）", en: "Alphabet (Google)" },
  { symbol: "AMZN", ja: "アマゾン", en: "Amazon" },
  { symbol: "META", ja: "メタ", en: "Meta" },
  { symbol: "TSLA", ja: "テスラ", en: "Tesla" },
];

// The Japanese shares checked on 2026-10-31 (Twelve Data's free plan has
// Toyota alone of them; Yahoo answers them all)
export const JP_STOCKS: StockListed[] = [
  { symbol: "7203.T", ja: "トヨタ自動車", en: "Toyota Motor" },
  { symbol: "6758.T", ja: "ソニーグループ", en: "Sony Group" },
  { symbol: "9984.T", ja: "ソフトバンクグループ", en: "SoftBank Group" },
  { symbol: "8306.T", ja: "三菱UFJフィナンシャル・グループ", en: "Mitsubishi UFJ Financial Group" },
  { symbol: "6861.T", ja: "キーエンス", en: "Keyence" },
  { symbol: "9983.T", ja: "ファーストリテイリング", en: "Fast Retailing" },
  { symbol: "8035.T", ja: "東京エレクトロン", en: "Tokyo Electron" },
  { symbol: "7974.T", ja: "任天堂", en: "Nintendo" },
  { symbol: "9432.T", ja: "NTT", en: "NTT" },
  { symbol: "6501.T", ja: "日立製作所", en: "Hitachi" },
  { symbol: "7267.T", ja: "ホンダ", en: "Honda Motor" },
  { symbol: "6920.T", ja: "レーザーテック", en: "Lasertec" },
  { symbol: "4063.T", ja: "信越化学工業", en: "Shin-Etsu Chemical" },
  { symbol: "8058.T", ja: "三菱商事", en: "Mitsubishi Corporation" },
];

const LISTED = new Map([...US_STOCKS, ...JP_STOCKS].map((s) => [s.symbol, s]));

// Names learned from a search, for a share not listed above (in this tab only)
const learned = new Map<string, string>();
export const learnStockName = (symbol: string, name: string) => {
  if (!LISTED.has(symbol) && name.trim() !== "") learned.set(symbol, name.trim());
};

// A share's name in the app's language: the listed one's, else the one a
// search brought, else none
export const stockName = (symbol: string, lang: "ja" | "en"): string | null => {
  const listed = LISTED.get(symbol);
  if (listed) return listed[lang];
  return learned.get(symbol) ?? null;
};

// The listed shares whose name or symbol holds the words typed: Yahoo's search
// refuses Japanese words, so 「トヨタ」 is found here
export const matchListed = (q: string): StockListed[] => {
  const words = q.trim().toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  return [...US_STOCKS, ...JP_STOCKS].filter((s) => {
    const hay = `${s.symbol} ${s.ja} ${s.en}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
};
