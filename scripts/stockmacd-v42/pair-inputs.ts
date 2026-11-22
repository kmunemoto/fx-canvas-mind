// The local check of signal-alerts v42's migration (research/allstocks-prod-spec.md section 9, "Local PostgreSQL"): the
// made-up inputs of the pair check, each with what the app's own isStockSymbol (live-chart/stocks.ts) says of it, printed
// as a SQL VALUES list (label, accepted by the subscriptions' check, accepted by signal_alert_stocks's check, the input
// as UTF-8 hex, so that no quoting can change it). The subscriptions' check takes the 21 FX and gold names too.
//   deno run --allow-read pair-inputs.ts
import { isStockSymbol } from "../../supabase/functions/live-chart/stocks.ts";

const FX = new Set(["USD/JPY", "XAU/USD"]);
const inputs: Array<[string, string]> = [
  ["us_4", "AAPL"],
  ["us_3", "XYZ"],
  ["us_1", "F"],
  ["us_5", "GOOGL"],
  ["us_class", "BRK-B"],
  ["us_class2", "ABC-WS"],
  ["jp_4", "7203.T"],
  ["jp_letter", "130A.T"],
  ["jp_0first", "0ABC.T"],
  ["lowercase", "aapl"],
  ["mixed_case", "Aapl"],
  ["lower_t", "7203.t"],
  ["fullwidth_letters", "ＡＡＰＬ"],
  ["fullwidth_digits", "７２０３.T"],
  ["arabic_indic_digits", "٧٢٠٣.T"],
  ["trailing_newline", "AAPL\n"],
  ["trailing_newline_jp", "7203.T\n"],
  ["leading_space", " AAPL"],
  ["trailing_space", "AAPL "],
  ["empty", ""],
  ["nine_chars", "ABCDEFGHI"],
  ["six_letters", "ABCDEF"],
  ["long_class", "BRK-BBB"],
  ["no_dot_t", "7203"],
  ["any_char_for_dot", "7203xT"],
  ["letter_first_jp", "A0AA.T"],
  ["five_jp", "72030.T"],
  ["fx_in_list", "USD/JPY"],
  ["gold_in_list", "XAU/USD"],
  ["fx_not_in_list", "GBP/USD"],
];
const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
const rows = inputs.map(([label, v]) => `  ('${label}', ${FX.has(v) || isStockSymbol(v)}, ${isStockSymbol(v)}, convert_from(decode('${hex(v)}', 'hex'), 'UTF8'))`);
console.log(`(values\n${rows.join(",\n")}\n)`);
