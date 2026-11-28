import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, cleanup, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import SignalAlertSettings from "../components/SignalAlertSettings";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";
import { AlertRequestError, indicatorChartOffered, normalizeAlertSettings, type AlertSettings } from "../lib/signalAlerts";
import {
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  MACDH_INTERVALS,
  MACDH_INTERVAL_OF,
  MACDH_PAIRS,
  SWEEPX_INTERVALS,
  SWEEPX_PAIRS,
  SWEEPX_RULE_ID,
  indicatorIntervalsFor,
} from "../../supabase/functions/signal-alerts/indicators";
import { FADE_MEASURED_NOTES } from "../../supabase/functions/_shared/macd-fade-measured";
import { readFileSync } from "node:fs";

// 〔switch〕 (research/macdfade15min-prod-spec.md section 5, macdxNotes [0]): the UTC date of v41's first answer, ja
// 「2026年11月D日」, en "D November 2026", written in step 4's PR as FUNCTION_VERSION's date is (3.7); read from the
// function, so that the two dates change together at the release (if v41 first answers on another UTC date than
// FUNCTION_VERSION's, section 5's src/-only PR that corrects 〔switch〕 puts that date here in place of this reading).
// v42 (research/allstocks-prod-spec.md) moved FUNCTION_VERSION on (signal-alerts-v42-…); 〔switch〕 stays v41's first
// answer, so its date is the one v41's version line held (v41 first answered 2026-11-20 08:05 UTC, docs §8.156)
const SWITCH_DATE = "signal-alerts-v41-2026-11-20".match(/^signal-alerts-v41-(\d{4})-(\d{2})-(\d{2})$/)!;
// v42 (research/allstocks-prod-spec.md 6.4): stockmacdNotes [0], ja and en (pinned to that file's text below)
const V42_NOTE0_JA =
  "Yahoo の検索で見つかる米国株と日本株（Yahoo が株として出す、米国の取引所と東証の銘柄）の15分足で判定します。上の「通知する株を探す」で探して足せます。通知する株は、使う人全員で合わせて50銘柄までです（同じ株は、何人がチェックしても1銘柄と数えます）。はじめから表に出している22銘柄（米国株8・日本株14）は、前の決まりで過去の数字を測った銘柄です。今の決まりは、株では測っていません。";
const V42_NOTE0_EN =
  "Judged on the 15-minute chart of US and Japanese stocks that Yahoo's search finds (what Yahoo lists as equities on US exchanges and the Tokyo Stock Exchange). Find one with \"Find a stock to alert\" above and add it. Up to 50 stocks can be alerted for all users together (a stock counts once, however many people tick it). The 22 stocks in the table from the start (8 US, 14 Japanese) are the ones the earlier rule was measured on. The present rule is not measured on stocks.";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SWITCH_JA = `${Number(SWITCH_DATE[1])}年${Number(SWITCH_DATE[2])}月${Number(SWITCH_DATE[3])}日`;
const SWITCH_EN = `${Number(SWITCH_DATE[3])} ${MONTHS[Number(SWITCH_DATE[2]) - 1]} ${SWITCH_DATE[1]}`;

// research/macdfade15min-prod-spec.md 3.5 (review finding (1)): the forbidden-number patterns, the same four in
// src/test/landing.test.tsx and src/test/signal-alert-settings.test.tsx, copied from the spec (pinned to it below): the
// 1-hour runs' numbers (v40's run 44099401423 and run 44555599946), the 15-minute run's (44535888012, and the first run's
// 3.31 / 0.90) with the release's docs section 8.156, the durations the notes print and the minutes behind them, and the
// per-pair comparison the owner's choice rests on
const FORBIDDEN_NUMBERS = [
  /1,?490|1,?468|3\.26|3\.2[01]|2\.08|9,?820|1,?733|2,?243|0\.26|4\.30|3\.28|4\.44|0\.7[57]|3\.11|2\.6[01]|4\.42|5\.16|5\.74|0\.0[56]|5\.34|4\.10|0\.83|5\.42|5\.81|10\.7|8\.155/,
  /6,?006|5,?926|2\.41|3\.3[12]|3\.19|0\.9[01]|0\.78|0\.80|2\.24|2\.25|5\.70|44,?784|1,?913|2,?975|11\.9|2\.67|5\.69|1\.29|3\.41|0\.82|0\.30|3\.86|4\.94|5\.18|5,?681|784,?561|959,?205|8\.156/,
  /約?(545|666|477|617)\s?日|(545|666|477|617) days|4,?489|687,?037|888,?900/,
  /99\.18|98\.91|98\.90|99\.00|98\.56|98\.61|98\.67|98\.73|98\.04|97\.44|99\.42|99\.14|99\.12|98\.75|98\.70|98\.48|98\.51|98\.31|1,?167|1,?180|1,?184|1,?185|1,?200|1,?201|1,?207|1,?217|1,?224|0\.51|0\.72/,
];

// research/macdfade15min-prod-spec.md 4.1 and section 5 ("Tests to change") held v41's texts to name each pair's own
// chart (perPairLeft: 「15分足」 beside USD/JPY, AUD/USD or the shares, 「1時間足」 beside EUR/JPY, AUD/JPY, EUR/USD or gold).
// v43 moved the five pairs to 5-minute bars: chartWordsLeft, below, is that pin for v43's map

// v43 (signal-alerts v43; the owner, 2026-11-26: 「fxと金は全て5分足に切り替えて」, then 「いや、もう本番変えて。 5分足に」;
// 2026-11-27: 「金は1時間足で判断して」): the five pairs' fade emails on 5-minute bars, gold's on 1-hour bars. No spec file
// holds v43's screen texts: each text that named the fade's charts is v41's (research/macdfade15min-prod-spec.md section
// 5) with the swaps below, [v41's words, v43's words], each found once; put back (back43), the text is v41's again,
// which the describe at the end holds against the spec file word for word. macdxNotes [0] is rewritten whole (V43_NOTE0)
type Swap = readonly [string, string];
const back43 = (t: string, swaps: readonly Swap[]): string =>
  swaps.reduce((x, [v41, v43]) => {
    expect(x.split(v43).length - 1, v43.slice(0, 50)).toBe(1);
    return x.replace(v43, v41);
  }, t);
const V43: Record<"timing" | "pairs" | "other" | "win" | "honest" | "intro" | "notes11" | "notes12", Record<"ja" | "en", readonly Swap[]>> = {
  // the card's lead and the FAQ's 「メールはいつ届きますか？」: when the fade is judged
  timing: {
    ja: [["MACD の逆張りは、ドル/円・豪ドル/ドルは15分足の確定の直後・1分後・3分後の読み込みで、ユーロ/円・豪ドル/円・ユーロ/ドルは1時間足の確定の直後・3分後・5分後の読み込みで、", "MACD の逆張りは、ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルは5分足の確定の直後・1分後・3分後の読み込みで、"]],
    en: [["the MACD fade is judged and sent on USD/JPY and AUD/USD at the reads right after the 15-minute close and 1 and 3 minutes after, on EUR/JPY, AUD/JPY and EUR/USD at the reads right after the 1-hour close and 3 and 5 minutes after, ", "the MACD fade is judged and sent on USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD at the reads right after the 5-minute close and 1 and 3 minutes after, "]],
  },
  // the FAQ's chart list
  pairs: {
    ja: [["MACD の逆張りのサインをドル/円・豪ドル/ドルの15分足と、ユーロ/円・豪ドル/円・ユーロ/ドル・金の1時間足から選べます。", "MACD の逆張りのサインをドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの5分足と、金の1時間足から選べます。"]],
    en: [["and for the MACD fade signals on the 15-minute bars of USD/JPY and AUD/USD and the 1-hour bars of EUR/JPY, AUD/JPY, EUR/USD and gold.", "and for the MACD fade signals on the 5-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD and the 1-hour bars of gold."]],
  },
  // the FAQ's 「他のツールと何が違いますか？」: the closes the fade is judged at
  other: {
    ja: [["（MACD の逆張りも、ペアごとに15分足か1時間足の確定で判定します）", "（MACD の逆張りも、5ペアは5分足、金は1時間足の確定で判定します）"]],
    en: [["(the MACD fade too, at 15-minute or 1-hour closes, by pair)", "(the MACD fade too, at 5-minute closes on the five pairs and 1-hour closes on gold)"]],
  },
  // the FAQ's 「勝率はどのくらいですか？」: the measured numbers are not the 5-minute bars' the emails are judged on
  win: {
    ja: [["MACD の逆張りは、5ペアを15分足と1時間足で測った数字が設定の注にあります。", "MACD の逆張りは、5ペアを15分足と1時間足で測った数字が設定の注にあります。5ペアのメールを判定する5分足では、測っていません。"]],
    en: [["The MACD fade has its own numbers, measured on the five pairs only, on 15-minute and on 1-hour bars, in the settings' notes. ", "The MACD fade has its own numbers, measured on the five pairs only, on 15-minute and on 1-hour bars, in the settings' notes. Its emails on the five pairs are judged on 5-minute bars, where it has not been measured. "]],
  },
  // the sales page's honesty section, likewise
  honest: {
    ja: [["勝率では比べません。それ以外のアプリのサインは、", "勝率では比べません。測ったのは15分足と1時間足で、5ペアのメールを判定する5分足では測っていません。それ以外のアプリのサインは、"]],
    en: [["and is not compared by one. Of the app's other signals,", "and is not compared by one. It was measured on 15-minute and 1-hour bars; its emails on the five pairs are judged on 5-minute bars, where it has not been measured. Of the app's other signals,"]],
  },
  // the fade tab's intro: the charts, whose choices, what was measured
  intro: {
    ja: [
      ["ドル/円・豪ドル/ドルの15分足と、ユーロ/円・豪ドル/円・ユーロ/ドルと金（XAU/USD）の1時間足だけです（時間足は、ペアごとにオーナーが選びました）。", "ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの5分足と、金（XAU/USD）の1時間足だけです（時間足は、オーナーが選びました）。"],
      ["96%・足の確定で判定すること・ペアごとの時間足・15分足の MACD の枠を新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリのその時間足のチャートの枠と同じです。", "96%・足の確定で判定すること・時間足・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠は、その時間足の新しい120本（5分足では120本 × 5分 = 10時間）で、アプリのその時間足のチャートの枠と同じです。"],
      ["5ペアを15分足と1時間足で測った数字は下の注に、金では測っていません。", "5ペアを15分足と1時間足で測った数字は下の注にあり、メールを判定する5分足では測っていません。金では測っていません。"],
    ],
    en: [
      ["15-minute bars of USD/JPY and AUD/USD and 1-hour bars of EUR/JPY, AUD/JPY, EUR/USD and gold (XAU/USD) only (the owner chose each pair's timeframe).", "5-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD and 1-hour bars of gold (XAU/USD) only (the owner chose the timeframes)."],
      ["96%, judging at the bar's close, each pair's timeframe, the 15-minute MACD pane of the newest 120 bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the newest 120 bars) is the same as the app's chart's on that timeframe.", "96%, judging at the bar's close, the timeframes, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane is the newest 120 bars of the timeframe (on 5-minute bars, 120 × 5 minutes = 10 hours), the same as the app's chart's on that timeframe."],
      ["Measured on the five pairs on 15-minute and on 1-hour bars (see the notes below); not measured on gold.", "Measured on the five pairs on 15-minute and on 1-hour bars (see the notes below), not on the 5-minute bars their emails are judged on; not measured on gold."],
    ],
  },
  // macdxNotes [11]: whose choices
  notes11: {
    ja: [["96%・足の確定で判定すること・ペアごとの時間足（ドル/円・豪ドル/ドルは15分足、ユーロ/円・豪ドル/円・ユーロ/ドルと金は1時間足）・15分足の MACD の枠を新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリのその時間足のチャートの枠と同じです。", "96%・足の確定で判定すること・時間足（ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルは5分足、金は1時間足）・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠は、その時間足の新しい120本（5分足では120本 × 5分 = 10時間）で、アプリのその時間足のチャートの枠と同じです。"]],
    en: [["96%, judging at the bar's close, each pair's timeframe (15-minute bars for USD/JPY and AUD/USD, 1-hour bars for EUR/JPY, AUD/JPY, EUR/USD and gold), the 15-minute MACD pane of the newest 120 bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the newest 120 bars) is the same as the app's chart's on that timeframe.", "96%, judging at the bar's close, the timeframes (5-minute bars for USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD, 1-hour bars for gold), the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane is the newest 120 bars of the timeframe (on 5-minute bars, 120 × 5 minutes = 10 hours), the same as the app's chart's on that timeframe."]],
  },
  // macdxNotes [12]: the weekend's last bar on GMO's bars (the 5-minute one seen on one US-summer Friday, docs §8.115:
  // GMO's 5-minute files of 2026-10-09, read from the database on 2026-10-13, ran to the bar opened 20:55 UTC; other
  // weeks not counted)
  notes12: {
    ja: [["（GMO の足では、ドル/円・豪ドル/ドルの15分足は金曜 20:45〜21:00 UTC の足、ユーロ/円・豪ドル/円・ユーロ/ドルの1時間足は金曜 20:00〜21:00 UTC の足で、米国の夏時間も冬時間も同じです。金の足は数えていません）。", "（GMO の足では、ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの5分足は金曜 20:55〜21:00 UTC の足です。米国の夏時間の金曜1日〈2026年10月9日〉で見たもので、ほかの週の5分足は数えていません。金の足は数えていません）。"]],
    en: [["(on GMO's bars: on the 15-minute chart of USD/JPY and AUD/USD the bar 20:45–21:00 UTC on Friday, on the 1-hour chart of EUR/JPY, AUD/JPY and EUR/USD the bar 20:00–21:00 UTC on Friday, the same in US summer and winter time. Gold's bars have not been counted).", "(on GMO's bars: on the 5-minute chart of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD the bar 20:55–21:00 UTC on Friday, as seen on one Friday in US summer time, 9 October 2026; the 5-minute bars of other weeks have not been counted. Gold's bars have not been counted)."]],
  },
};
// v43 too (the owner, 2026-11-27: 「信越化学工業 のメールは1時間足で判断して」): Shin-Etsu Chemical's (4063.T) stock MACD
// emails on 1-hour bars, every other share's on 15-minute bars. Each text that said the shares are judged on 15-minute
// bars is v41's or v42's with the swaps below, [the text before, v43's], each found once; put back (back43), the text
// is the one research/macdfade15min-prod-spec.md section 5 or research/allstocks-prod-spec.md 6.4 and 6.5 hold, word
// for word, as the describes below check. Every v43 side names Shin-Etsu Chemical
const V43S: Record<"stockNote" | "faq" | "intro" | "notes0" | "notes1" | "notes2" | "notes3", Record<"ja" | "en", readonly Swap[]>> = {
  // the chart's stock data note: its last parenthesis
  stockNote: {
    ja: [["（Yahoo の検索で見つかる株の15分足。使う人全員で合わせて50銘柄まで）", "（Yahoo の検索で見つかる株の15分足。信越化学工業だけは1時間足。使う人全員で合わせて50銘柄まで）"]],
    en: [["(the 15-minute chart of a stock Yahoo's search finds; up to 50 stocks for all users together)", "(the 15-minute chart of a stock Yahoo's search finds, the 1-hour chart for Shin-Etsu Chemical; up to 50 stocks for all users together)"]],
  },
  // the FAQ's 「メールはいつ届きますか？」: when the shares are judged
  faq: {
    ja: [["、株は15分足の確定の後の読み込みで判定して送ります。", "、株は15分足（信越化学工業は1時間足）の確定の後の読み込みで判定して送ります。"]],
    en: [["and on stocks at a read after each 15-minute close;", "and on stocks at a read after each 15-minute close (each 1-hour close for Shin-Etsu Chemical);"]],
  },
  // the stock tab's intro
  intro: {
    ja: [["米国株と日本株の15分足で、", "米国株と日本株の15分足（信越化学工業〈4063.T〉は1時間足）で、"], ["（1つの足で1通だけ）。15分足が確定した時に、", "（1つの足で1通だけ）。足が確定した時に、"]],
    en: [["on US and Japanese stocks' 15-minute charts. When a 15-minute bar closes with", "on US and Japanese stocks' 15-minute charts (the 1-hour chart for Shin-Etsu Chemical, 4063.T). When a bar closes with"]],
  },
  // stockmacdNotes [0]: which shares, on which chart
  notes0: {
    ja: [["東証の銘柄）の15分足で判定します。", "東証の銘柄）の15分足で判定します（信越化学工業〈4063.T〉だけは1時間足で判定します。2026-11-27 にオーナーが決めました）。"]],
    en: [["Tokyo Stock Exchange). Find one", "Tokyo Stock Exchange); Shin-Etsu Chemical (4063.T) alone is judged on the 1-hour chart (the owner's choice, 2026-11-27). Find one"]],
  },
  // [1]: the closes looked at
  notes1: {
    ja: [["見るのは15分足の確定ごとです。", "見るのは15分足（信越化学工業は1時間足）の確定ごとです。"]],
    en: [["a stock is looked at at each 15-minute close. ", "a stock is looked at at each 15-minute close (Shin-Etsu Chemical at each 1-hour close). "]],
  },
  // [2]: 4063.T's 1-hour closes (v40's), the 15-minute bars' 11:30 row named as theirs, and the Tokyo delay seen on the
  // 1-hour reads (docs §8.141)
  notes2: {
    ja: [
      ["日本株は 9:15〜11:30 と 12:45〜15:30 の15分ごとに足が確定し、", "日本株は 9:15〜11:30 と 12:45〜15:30 の15分ごとに足が確定し（信越化学工業は1時間足で、10:00・11:00・11:30・13:00・14:00・15:00・15:30 に確定します。11:00 の足は昼休みの 11:30 まで、12:00 と書かれた足は 12:30〜13:00、15:00 の足は大引けの 15:30 までです）、"],
      ["確定から45分を過ぎた足は送りません。日本株の前場の引け（11:30）の値段は、", "確定から45分を過ぎた足は送りません。15分足では、日本株の前場の引け（11:30）の値段は、"],
      ["15分ほど後に判定して送ります（15分足で実際に何分後になるかは、まだ測っていません）。", "15分ほど後に判定して送ります（1時間足では、2026-11-06 に、確定の約15分後に判定していました。15分足で実際に何分後になるかは、まだ測っていません）。"],
    ],
    en: [
      ["from 12:45 to 15:30 Tokyo time; a bar is judged", "from 12:45 to 15:30 Tokyo time (Shin-Etsu Chemical's, on the 1-hour chart, at 10:00, 11:00, 11:30, 13:00, 14:00, 15:00 and 15:30: the 11:00 bar ends at the lunch break, 11:30, the bar stamped 12:00 runs from 12:30 to 13:00, and the 15:00 bar ends at the closing auction, 15:30); a bar is judged"],
      ["is not mailed. Tokyo's morning closing price (11:30)", "is not mailed. On 15-minute bars, Tokyo's morning closing price (11:30)"],
      ["after the bar closed (how many minutes on 15-minute bars has not been measured yet);", "after the bar closed (on 1-hour bars they were judged some 15 minutes after the close on 2026-11-06; how many minutes on 15-minute bars has not been measured yet);"],
    ],
  },
  // [3]: the owner's choices, 4063.T's 1-hour bars among them, and its pane stated
  notes3: {
    ja: [
      ["株を15分足で判定すること・", "株を15分足で判定すること（信越化学工業は1時間足。2026-11-27）・"],
      ["この枠は、アプリの15分足のチャートの枠と同じです。", "この枠は、アプリの15分足のチャートの枠と同じです。信越化学工業の MACD の枠は1時間足の新しい120本で、アプリの1時間足のチャートの枠と同じです。"],
    ],
    en: [
      ["judging shares on 15-minute bars,", "judging shares on 15-minute bars (Shin-Etsu Chemical on 1-hour bars, 2026-11-27),"],
      ["That pane is the same as the app's 15-minute chart's.", "That pane is the same as the app's 15-minute chart's. Shin-Etsu Chemical's MACD pane is the newest 120 bars of the 1-hour chart, the same as the app's 1-hour chart's."],
    ],
  },
};
// the other way: the text before with v43's swaps made (each of its sides found once)
const fwd43 = (t: string, swaps: readonly Swap[]): string =>
  swaps.reduce((x, [before, v43]) => {
    expect(x.split(before).length - 1, before.slice(0, 50)).toBe(1);
    return x.replace(before, v43);
  }, t);
// macdxNotes [0], v43's, whole: the charts and their read times, and (its last sentence) the charts before the move
const V43_NOTE0_HISTORY = {
  ja: "5ペアを5分足に移す前は、ドル/円・豪ドル/ドルは15分足（2026年11月18日から2026年11月20日〈UTC〉までは1時間足）で、ユーロ/円・豪ドル/円・ユーロ/ドルは1時間足で、メールを判定していました。",
  en: "Before the five pairs were moved to 5-minute bars, USD/JPY and AUD/USD were judged on 15-minute bars (on 1-hour bars from 18 November 2026 to 20 November 2026 UTC) and EUR/JPY, AUD/JPY and EUR/USD on 1-hour bars.",
};
const V43_NOTE0 = {
  ja:
    "ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルは5分足だけで、金は1時間足だけで判定します（オーナーが選んだ5ペアと、あとから足した金。どの時間足で判定するかも、オーナーが選びました）。" +
    "足が確定した後、5ペアは確定の直後・1分後・3分後（毎時0分・5分・10分…55分と、その1分後・3分後）の読み込みで、金は確定の1分後から30分後までの間に判定して送ります（実際に何分で届くかは測っていません）。" +
    "届いた時の値段は、メールに書いた値段と違うことがあります（その差は測っていません）。" +
    V43_NOTE0_HISTORY.ja,
  en:
    "Judged on the 5-minute chart only for USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD, and on the 1-hour chart only for gold (the five pairs the owner chose, and gold added since; the owner also chose the timeframes). " +
    "After the bar closes it is judged and sent: the five pairs at the reads right after the close and 1 and 3 minutes after (0, 5, 10 … 55 minutes past each hour, and 1 and 3 minutes after those), gold between 1 and 30 minutes after the close (how long it takes to arrive has not been measured). " +
    "The price when it arrives may differ from the price in the email (the difference has not been measured). " +
    V43_NOTE0_HISTORY.en,
};
// v43's 〔mailedOn〕 in the notes' two measured paragraphs (the measured module's, pinned word for word in
// src/test/macd-fade.test.ts)
const V43_MAILED_ON = {
  "15min": {
    ja: "この5ペアのメールは、今はすべて5分足で判定しています。この段落の数字は、どのペアの分も、すべて15分足で測ったもので、5分足で測ったものではありません。",
    en: "The emails of all five pairs are now judged on 5-minute bars. Every number in this paragraph, for every pair, was measured on 15-minute bars, not on 5-minute bars.",
  },
  "1h": {
    ja: "この5ペアのメールは、今はすべて5分足で判定しています。この段落の数字は、どのペアの分も、すべて1時間足で測ったもので、5分足で測ったものではありません。",
    en: "The emails of all five pairs are now judged on 5-minute bars. Every number in this paragraph, for every pair, was measured on 1-hour bars, not on 5-minute bars.",
  },
} as const;

// v43's pin of the charts (v41's perPairLeft, for v43's map): a text that names the fade's chart names the five
// pairs' 5-minute chart and gold's 1-hour chart, never a pair on 15-minute or 1-hour bars as its chart now. Once the
// measured runs named together, the 5-minute pane's hours, the not-measured clauses, the 5-minute bars not counted and
// [0]'s last sentence (the charts before the move) are taken out, no 「15分足」 / "15-minute" is left, every 「5分足」 /
// "5-minute" (not the end of 「15分足」 / "15-minute") stands beside the five pairs (or 「5ペア」 / "the five pairs")
// and not gold, and every 「1時間足」 / "1-hour" beside gold and none of the five. Beside: as v41's perPairLeft read it:
// in ja, the names between the bar word and the 「。」, 「、」 or bar word before it (ja names the instrument first); in en,
// the names between the bar word and the next ".", ";", "(", ")" or bar word, or, where there are none, between it and
// the ".", ";", "," or "(" before it.
// Gives what does not hold (empty when every one does)
const PAIR_5 = { ja: /(?<!豪)ドル\/円|豪ドル\/ドル|ユーロ\/円|豪ドル\/円|ユーロ\/ドル|5ペア/g, en: /USD\/JPY|AUD\/USD|EUR\/JPY|AUD\/JPY|EUR\/USD|five pairs/g };
const GOLD_ONLY = { ja: /金(?!曜)|XAU\/USD/g, en: /gold|XAU\/USD/g };
const V43_OUT = {
  ja: ["15分足と1時間足", "（5分足では120本 × 5分 = 10時間）", "メールを判定する5分足では測っていません", "ほかの週の5分足は数えていません", V43_NOTE0_HISTORY.ja],
  en: ["on 15-minute and on 1-hour bars", "(on 5-minute bars, 120 × 5 minutes = 10 hours)", "not on the 5-minute bars their emails are judged on", "the 5-minute bars of other weeks have not been counted", V43_NOTE0_HISTORY.en],
};
const chartWordsLeft = (text: string, lang: "ja" | "en"): string[] => {
  const t = V43_OUT[lang].reduce((x, k) => x.split(k).join(""), text);
  const occ = [...t.matchAll(/15分足|(?<!1)5分足|1時間足|15-minute|(?<!1)5-minute|1-hour/g)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, word: m[0] }));
  const has = (re: RegExp, x: string) => (x.match(re) ?? []).length > 0;
  const left: string[] = [];
  occ.forEach((o, j) => {
    if (o.word === "15分足" || o.word === "15-minute") {
      left.push(`${o.word} left`);
      return;
    }
    const before = (stops: string) => {
      const lo = Math.max(...[...stops].map((c) => t.lastIndexOf(c, o.at - 1)), j ? occ[j - 1].end - 1 : -1);
      return t.slice(lo + 1, o.at);
    };
    let span = "";
    if (lang === "ja") span = before("。、");
    else {
      const ends = [...".;()"].map((c) => t.indexOf(c, o.end)).filter((x) => x >= 0);
      span = t.slice(o.end, Math.min(...ends, j + 1 < occ.length ? occ[j + 1].at : t.length));
      if (!has(PAIR_5.en, span) && !has(GOLD_ONLY.en, span)) span = before(".;,(");
    }
    const five = o.word === "5分足" || o.word === "5-minute";
    const own = has(five ? PAIR_5[lang] : GOLD_ONLY[lang], span);
    const other = has(five ? GOLD_ONLY[lang] : PAIR_5[lang], span);
    if (!own || other) left.push(`${o.word} beside 「${span}」`);
  });
  return left;
};

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const payload = (over: Record<string, unknown> = {}) => ({
  ok: true,
  allowed: true,
  email_configured: true,
  email: "me@example.com",
  pairs: ["USD/JPY", "EUR/JPY"],
  intervals: ["15min", "1h", "4h", "1day"],
  subscriptions: [{ pair: "USD/JPY", interval: "15min" }],
  alerts: [
    {
      id: "a1",
      kind: "signal",
      pair: "USD/JPY",
      interval: "15min",
      side: "BUY",
      closed_at: "2026-09-25T01:00:00.000Z",
      entry: 149.5,
      stop: 149.42,
      target: 149.62,
      status: "sent",
      skip_reason: null,
      created_at: "2026-09-25T01:02:10.000Z",
    },
    {
      id: "a2",
      kind: "signal",
      pair: "USD/JPY",
      interval: "15min",
      side: "SELL",
      closed_at: "2026-09-24T19:00:00.000Z",
      entry: 149.9,
      stop: 149.98,
      target: 149.78,
      status: "skipped",
      skip_reason: "costly_hours",
      created_at: "2026-09-24T19:02:05.000Z",
    },
    { id: "bad", kind: "signal", status: "sent" },
  ],
  ...over,
});

const settings = (over: Record<string, unknown> = {}): AlertSettings => normalizeAlertSettings(payload(over))!;

beforeEach(() => {
  toast.success.mockReset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe("the settings as they arrive", () => {
  it("keep the well-formed rows and drop the rest", () => {
    const s = settings();
    expect(s.alerts.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(s.alerts[1].skipReason).toBe("costly_hours");
    expect(normalizeAlertSettings({ ok: false })).toBeNull();
    expect(normalizeAlertSettings({ ok: true, allowed: true })).toBeNull();
  });
});

describe("the email-alert card", () => {
  it("shows what is followed and saves a tick in the app's language", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? settings({ subscriptions: [{ pair: "USD/JPY", interval: "15min" }, { pair: "EUR/JPY", interval: "1h" }] }) : settings()
    );
    render(<SignalAlertSettings call={call} />);
    const on = await screen.findByTestId("signal-alert-USD/JPY-15min");
    expect((on as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/me@example\.com/)).toBeTruthy();
    const off = screen.getByTestId("signal-alert-EUR/JPY-1h") as HTMLInputElement;
    expect(off.checked).toBe(false);
    fireEvent.click(off);
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "EUR/JPY", interval: "1h", on: true, rule: "rsi_sar", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-EUR/JPY-1h") as HTMLInputElement).checked).toBe(true));
  });

  it("#112: follows the GA-style rule separately, with its own record and what it was measured at", async () => {
    const ga = { rule: "gainz_v2a_050_50_5_atr1_v1" };
    const gaPerf = {
      mine: { n: 0, wins: 0, losses: 0, expired: 0, open: 0, winRate: null, meanR: null, ciR: null, sumR: 0 },
      all: { n: 4, wins: 1, losses: 3, expired: 0, open: 2, winRate: 0.25, meanR: -0.26, ciR: null, sumR: -1.04 },
      costly: { n: 0, wins: 0, losses: 0, expired: 0, open: 0, winRate: null, meanR: null, ciR: null, sumR: 0 },
      byTf: {},
      backtest: { period: "2025-07〜2026-09", n: 10757, winRate: 0.288, meanR: -0.134, breakeven: 1 / 3 },
    };
    const base = {
      mine: gaPerf.mine,
      all: { ...gaPerf.all, n: 7, wins: 3, losses: 4, winRate: 0.43, meanR: 0.1 },
      costly: gaPerf.costly,
      byTf: {},
      backtest: { period: "2025-07〜2026-09", n: 1255, winRate: 0.35, meanR: -0.125, breakeven: 0.4 },
    };
    const withGa = (subs: unknown[]) => settings({
      subscriptions: subs,
      performance: { days: 365, ...base, gainz: gaPerf },
      alerts: [{ id: "g1", kind: "signal", pair: "USD/JPY", interval: "4h", side: "SELL", closed_at: "2026-09-25T04:00:00.000Z", entry: 150, stop: 150.3, target: 149.4, status: "sent", created_at: "2026-09-25T04:02:00.000Z", ...ga }],
    });
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set"
        ? withGa([{ pair: "USD/JPY", interval: "15min", rule: "rsi_sar" }, { pair: "USD/JPY", interval: "4h", rule: "gainz" }])
        : withGa([{ pair: "USD/JPY", interval: "15min", rule: "rsi_sar" }])
    );
    render(<SignalAlertSettings call={call} />);
    await waitFor(() => expect(screen.getByTestId("signal-alerts-grid")).toBeTruthy());
    // RSI + SAR first, as before; its own record
    expect((screen.getByTestId("signal-alert-USD/JPY-15min") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("signal-alerts-record-all").textContent).toContain("7回");
    expect(screen.getAllByTestId("signal-alert-row")[0].textContent).toContain("（GA型）");
    fireEvent.click(screen.getByTestId("signal-alerts-rule-gainz"));
    // the GA grid: the RSI + SAR tick does not carry over
    expect((screen.getByTestId("signal-alert-gainz-USD/JPY-15min") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("signal-alerts-gainz-intro").textContent).toContain("GainzAlgo");
    expect(screen.getByTestId("signal-alerts-notes").textContent).toContain("30.1%");
    expect(screen.getByTestId("signal-alerts-record").textContent).toContain("GA型の通知の成績");
    expect(screen.getByTestId("signal-alerts-record-all").textContent).toContain("4回");
    expect(screen.getByTestId("signal-alerts-record").textContent).toContain("33%");
    fireEvent.click(screen.getByTestId("signal-alert-gainz-USD/JPY-4h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "USD/JPY", interval: "4h", on: true, rule: "gainz", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-gainz-USD/JPY-4h") as HTMLInputElement).checked).toBe(true));
    // and back: RSI + SAR's 4h is still unticked
    fireEvent.click(screen.getByTestId("signal-alerts-rule-rsi_sar"));
    expect((screen.getByTestId("signal-alert-USD/JPY-4h") as HTMLInputElement).checked).toBe(false);
  });

  it("without Pro nothing new can be ticked, but a tick can still be removed", async () => {
    render(<SignalAlertSettings call={async () => settings({ allowed: false })} />);
    expect(await screen.findByTestId("signal-alerts-pro-only")).toBeTruthy();
    expect((screen.getByTestId("signal-alert-EUR/JPY-1h") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("signal-alert-USD/JPY-15min") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("signal-alerts-test") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says plainly when no email can be sent yet", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "test" ? settings({ email_configured: false, test: "not_configured" }) : settings({ email_configured: false })
    );
    render(<SignalAlertSettings call={call} />);
    expect(await screen.findByTestId("signal-alerts-not-configured")).toBeTruthy();
    fireEvent.click(screen.getByTestId("signal-alerts-test"));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("lists what was sent and what was held back, and why", async () => {
    render(<SignalAlertSettings call={async () => settings()} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("09-25 10:00");
    expect(rows[0].textContent).toContain("買い");
    expect(rows[0].textContent).toContain("送信済み");
    expect(rows[0].textContent).toContain("149.500");
    expect(rows[1].textContent).toContain("損失の大きい時間帯");
  });

  it("a test inside the cooldown is refused with the reason", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) => {
      if (body.action === "test") throw new AlertRequestError("test_cooldown");
      return settings();
    });
    render(<SignalAlertSettings call={call} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-test"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("One test email every 5 minutes"));
  });

  it("shows what the alerts did afterwards, and says when there are too few to read anything into", async () => {
    const perf = {
      days: 365,
      mine: { n: 3, wins: 1, losses: 2, expired: 0, open: 1, winRate: 1 / 3, meanR: -0.18, ciR: null, sumR: -0.54 },
      all: { n: 12, wins: 4, losses: 7, expired: 1, open: 3, winRate: 4 / 12, meanR: -0.11, ciR: 0.62, sumR: -1.32 },
      costly: { n: 2, wins: 0, losses: 2, expired: 0, open: 0, winRate: 0, meanR: -1, ciR: null, sumR: -2 },
      byTf: {},
      backtest: { period: "2025-07〜2026-09", n: 1255, winRate: 0.35, meanR: -0.125, breakeven: 0.4 },
    };
    const alerts = [
      { ...payload().alerts[0], status: "sent", event: { outcome: "win", r: 1.4875, bars: 2, exit_at: null } },
      { ...payload().alerts[1], id: "a3", status: "sent", skip_reason: null, event: { outcome: null, r: null, bars: null, exit_at: null } },
    ];
    render(<SignalAlertSettings call={async () => normalizeAlertSettings(payload({ performance: perf, alerts }))!} />);
    const record = await screen.findByTestId("signal-alerts-record");
    expect(record.textContent).toContain("あなたに届いた通知");
    expect(screen.getByTestId("signal-alerts-record-mine").textContent).toContain("3回：勝ち1・負け2・期限切れ0");
    expect(screen.getByTestId("signal-alerts-record-mine").textContent).toContain("決着待ち 1回");
    const all = screen.getByTestId("signal-alerts-record-all").textContent!;
    expect(all).toContain("勝率 33%");
    expect(all).toContain("−0.11R");
    expect(all).toContain("±0.62R");
    expect(record.textContent).toContain("勝率 35%・平均 −0.13R");
    expect(screen.getByTestId("signal-alerts-record-small")).toBeTruthy();
    const results = screen.getAllByTestId("signal-alert-result").map((e) => e.textContent);
    expect(results).toEqual(["勝ち +1.49R", "決着待ち"]);
  });

  it("the warning about small numbers goes once thirty signals have settled", async () => {
    const big = { n: 40, wins: 14, losses: 24, expired: 2, open: 0, winRate: 0.35, meanR: -0.1, ciR: 0.4, sumR: -4 };
    const perf = { days: 365, mine: big, all: big, costly: big, byTf: {}, backtest: null };
    render(<SignalAlertSettings call={async () => normalizeAlertSettings(payload({ performance: perf }))!} />);
    await screen.findByTestId("signal-alerts-record");
    expect(screen.queryByTestId("signal-alerts-record-small")).toBeNull();
  });

  it("a load that fails says so instead of spinning", async () => {
    render(<SignalAlertSettings call={async () => { throw new Error("down"); }} />);
    expect(await screen.findByTestId("signal-alerts-error")).toBeTruthy();
  });
});

// #155: Q-Trend's and ULTRA's alerts, on every pair of the live chart
describe("#155 Q-Trend and ULTRA in the email-alert card", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
  const gmo = INDICATOR_PAIRS.filter((p) => !twelve.includes(p));
  const indicator = {
    rules: ["qtrend", "ultra"],
    pairs: INDICATOR_PAIRS,
    intervals: INDICATOR_INTERVALS,
    limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
  };
  const withInd = (over: Record<string, unknown> = {}) => settings({ indicator, ...over });

  it("reads the charts offered, each rule's subscriptions and a STRONG alert as they arrive", () => {
    const s = withInd({
      subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "qtrend" }, { pair: "HKD/JPY", interval: "1h", rule: "ultra" }],
      alerts: [
        { id: "q1", kind: "signal", rule: "qtrend_200_14_1_v1", strong: true, pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-09-29T02:50:00.000Z", entry: 157.209, stop: null, target: null, status: "sent", created_at: "2026-09-29T02:51:30.000Z" },
        { id: "u1", kind: "signal", rule: "ultra_rsi14_30_70_sl10_tp5_10_15_v1", pair: "XAU/USD", interval: "1h", side: "BUY", closed_at: "2026-09-29T02:00:00.000Z", entry: 4139.89, stop: 4129.89, target: 4144.89, status: "sent", created_at: "2026-09-29T02:03:00.000Z" },
      ],
    });
    // #175: the yen pairs and gold (#177: and EUR/USD; #178: and AUD/USD;
    // #180: and USD/CAD); 6 of the pairs and gold from Twelve Data
    expect(s.indicator!.pairs).toHaveLength(21);
    expect(twelve).toHaveLength(7);
    expect(s.subscriptions.map((x) => x.rule)).toEqual(["qtrend", "ultra"]);
    expect(s.alerts.map((r) => [r.rule, r.strong])).toEqual([["qtrend", true], ["ultra", false]]);
    expect(indicatorChartOffered(s, "USD/JPY", "5min")).toBe(true);
    expect(indicatorChartOffered(s, "EUR/USD", "5min")).toBe(true);
    expect(indicatorChartOffered(s, "AUD/USD", "5min")).toBe(true);
    expect(indicatorChartOffered(s, "HKD/JPY", "5min")).toBe(false);
    expect(indicatorChartOffered(s, "HKD/JPY", "1h")).toBe(true);
    // a pair taken away (#175) is not offered on any timeframe
    expect(indicatorChartOffered(s, "USD/CHF", "1h")).toBe(false);
    // #180: USD/CAD again, from 1 hour as the others read from Twelve Data
    expect(indicatorChartOffered(s, "USD/CAD", "5min")).toBe(false);
    expect(indicatorChartOffered(s, "USD/CAD", "1h")).toBe(true);
    // #212: gold on 15 minutes too, not on 5
    expect(indicatorChartOffered(s, "XAU/USD", "15min")).toBe(true);
    expect(indicatorChartOffered(s, "XAU/USD", "5min")).toBe(false);
    expect(indicatorChartOffered(s, "HKD/JPY", "15min")).toBe(false);
    expect(indicatorChartOffered(s, "XAU/USD", "1h")).toBe(true);
    // a server that does not send them yet: nothing offered
    expect(indicatorChartOffered(settings(), "USD/JPY", "5min")).toBe(false);
  });

  it("lists every pair on 5 minutes to daily, those read from Twelve Data from 1 hour, and saves a tick as Q-Trend's", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withInd({ subscriptions: [{ pair: "HKD/JPY", interval: "1h", rule: "qtrend" }] }) : withInd()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-qtrend"));
    expect(screen.getByTestId("signal-alerts-indicator-intro").textContent).toContain("STRONG");
    const rows = screen.getByTestId("signal-alerts-grid").querySelectorAll("tbody tr");
    // the all-symbols row, then the 21 (#175: 18; #177: and EUR/USD; #178: and AUD/USD; #180: and USD/CAD)
    expect(rows).toHaveLength(22);
    expect(screen.getByTestId("signal-alert-qtrend-USD/JPY-5min")).toBeTruthy();
    expect(screen.getByTestId("signal-alert-qtrend-HKD/JPY-5min-none").textContent).toBe("—");
    expect(screen.queryByTestId("signal-alert-qtrend-USD/CHF-1h")).toBeNull();
    // #180: USD/CAD from 1 hour, as the others read from Twelve Data
    expect(screen.getByTestId("signal-alert-qtrend-USD/CAD-1h")).toBeTruthy();
    expect(screen.getByTestId("signal-alert-qtrend-USD/CAD-5min-none").textContent).toBe("—");
    // #212: gold on 15 minutes too, not on 5
    expect(screen.getByTestId("signal-alert-qtrend-XAU/USD-15min")).toBeTruthy();
    expect(screen.getByTestId("signal-alert-qtrend-XAU/USD-5min-none").textContent).toBe("—");
    expect(screen.getByTestId("signal-alert-qtrend-XAU/USD-5min-none").getAttribute("title")).toContain("金は15分足も");
    fireEvent.click(screen.getByTestId("signal-alert-qtrend-HKD/JPY-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "HKD/JPY", interval: "1h", on: true, rule: "qtrend", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-qtrend-HKD/JPY-1h") as HTMLInputElement).checked).toBe(true));
    // ULTRA's is its own
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect((screen.getByTestId("signal-alert-ultra-HKD/JPY-1h") as HTMLInputElement).checked).toBe(false);
    // no record is kept of these signals, and their own notes are shown
    expect(screen.queryByTestId("signal-alerts-record")).toBeNull();
    expect(screen.getByTestId("signal-alerts-notes").textContent).toContain("1日100通");
  });

  it("the all-symbols row follows a timeframe on every pair offered at once, and shows how much of it is followed", async () => {
    const all5 = gmo.map((pair) => ({ pair, interval: "5min", rule: "ultra" }));
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set_many"
        ? withInd({ subscriptions: body.on ? all5 : [] })
        : withInd({ subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "ultra" }] })
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-ultra"));
    const five = screen.getByTestId("signal-alert-ultra-all-5min") as HTMLInputElement;
    // one of 14 followed (#175: 12; #177: and EUR/USD; #178: and AUD/USD): neither ticked nor clear
    expect(five.checked).toBe(false);
    expect(five.indeterminate).toBe(true);
    fireEvent.click(five);
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "ultra", on: true, lang: "ja" })));
    const sent = call.mock.calls.find((c) => c[0].action === "set_many")![0] as { charts: Array<{ pair: string; interval: string }> };
    // the 14 GMO pairs (#177, #178): the 7 read from Twelve Data (#180) have no 5-minute alerts
    expect(gmo).toHaveLength(14);
    expect(sent.charts.map((c) => c.pair)).toEqual(gmo);
    expect(new Set(sent.charts.map((c) => c.interval))).toEqual(new Set(["5min"]));
    await waitFor(() => expect((screen.getByTestId("signal-alert-ultra-all-5min") as HTMLInputElement).checked).toBe(true));
    expect((screen.getByTestId("signal-alert-ultra-all-5min") as HTMLInputElement).indeterminate).toBe(false);
    // untick: every pair off again
    fireEvent.click(screen.getByTestId("signal-alert-ultra-all-5min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "ultra", on: false })));
    // the hourly one takes all 21 (#180: USD/CAD among them)
    fireEvent.click(screen.getByTestId("signal-alert-ultra-all-1h"));
    await waitFor(() => expect(call.mock.calls.filter((c) => c[0].action === "set_many")).toHaveLength(3));
    const hourly = call.mock.calls.filter((c) => c[0].action === "set_many")[2][0] as { charts: Array<{ pair: string }> };
    expect(hourly.charts).toHaveLength(21);
    expect(hourly.charts.map((c) => c.pair)).toContain("USD/CAD");
  });

  it("names a STRONG Q-Trend alert in the recent list, with no stop or target to show", async () => {
    const call = vi.fn(async () =>
      withInd({
        alerts: [
          { id: "q1", kind: "signal", rule: "qtrend_200_14_1_v1", strong: true, pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-09-29T02:50:00.000Z", entry: 157.209, stop: null, target: null, status: "sent", created_at: "2026-09-29T02:51:30.000Z" },
          { id: "u1", kind: "signal", rule: "ultra_rsi14_30_70_sl10_tp5_10_15_v1", pair: "XAU/USD", interval: "1h", side: "BUY", closed_at: "2026-09-29T02:00:00.000Z", entry: 4139.89, stop: 4129.89, target: 4144.89, status: "sent", created_at: "2026-09-29T02:03:00.000Z" },
        ],
      })
    );
    render(<SignalAlertSettings call={call} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows[0].textContent).toContain("USD/JPY 5分 売り・STRONG（Q-Trend）");
    expect(rows[0].textContent).not.toContain("損切り");
    expect(rows[1].textContent).toContain("XAU/USD 1時間 買い（ULTRA）");
    expect(rows[1].textContent).toContain("目安 4139.89 / 損切り 4129.89 / 利確 4144.89");
  });
});

// v41 per pair (research/macdfade15min-prod-spec.md section 5; the function's status line, 3.2 item 6): the MACD fade's
// block holds its two timeframes and, in `limited`, each pair's own. v43: the five pairs on 5 minutes, gold on 1 hour
// (v41 and v42: USD/JPY and AUD/USD on 15 minutes, EUR/JPY, AUD/JPY, EUR/USD and gold on 1 hour). Written out here (and
// pinned below to the function's map)
const MACDX_ON_5 = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
const MACDX_ON_1H = ["XAU/USD"];
const MACDX_LIMITED: Record<string, string[]> = Object.fromEntries([
  ...MACDX_ON_5.map((p) => [p, ["5min"]]),
  ...MACDX_ON_1H.map((p) => [p, ["1h"]]),
]);
// the "—" cell's title of the fade's grid, section 5's new key, word for word (pinned to the spec below)
const MACDX_OTHER_CHART_JA = "このペアは、この時間足では判定しません（ペアごとに、オーナーが選んだ1つの時間足だけで判定します）";
const MACDX_OTHER_CHART_EN = "Not judged on this timeframe for this pair (each pair is judged on the one timeframe the owner chose only)";

// #275: the MACD peak-and-valley rule, on its own charts (GMO's currency pairs; #324: on 1 hour,
// the owner's levels, from signal-alerts v25 — what the server sends now)
describe("#275 the MACD ride (once the peak-and-valley rule) in the email-alert card", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
  const indicator = {
    rules: ["qtrend", "ultra", "macdx"],
    pairs: INDICATOR_PAIRS,
    intervals: INDICATOR_INTERVALS,
    limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
    macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS, limited: MACDX_LIMITED },
  };
  const withMacdx = (over: Record<string, unknown> = {}) => settings({ indicator, ...over });
  const box = (id: string) => screen.getByTestId(id) as HTMLInputElement;
  // each pair on its own chart: its interval in section 5's map
  const chartOf = (pair: string) => ({ pair, interval: MACDX_LIMITED[pair][0] });

  it("reads the charts the rule is offered on, each pair on its own timeframe (v41's `limited`; v43: the five pairs on 5 minutes, gold on 1 hour), and offers nothing when the server sends none", () => {
    const s = withMacdx({ subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "macdx" }, { pair: "USD/JPY", interval: "5min", rule: "ultra" }] });
    expect(s.indicator!.macdx).toEqual({ pairs: [...MACDH_PAIRS], intervals: ["5min", "1h"], limited: MACDX_LIMITED });
    expect(s.subscriptions.map((x) => x.rule)).toEqual(["macdx", "ultra"]);
    // section 5's map is the function's (3.2 items 1 and 6: the status line's `limited` is built from MACDH_INTERVAL_OF)
    expect(MACDX_LIMITED).toEqual(Object.fromEntries(MACDH_PAIRS.map((p) => [p, [MACDH_INTERVAL_OF[p]]])));
    expect([...MACDX_ON_5, ...MACDX_ON_1H].sort()).toEqual([...MACDH_PAIRS].sort());
    // its own charts (v43): the five pairs on 5 minutes only, gold (#345, v27) on 1 hour only
    for (const p of MACDX_ON_5) {
      expect(indicatorChartOffered(s, p, "5min", "macdx"), p).toBe(true);
      expect(indicatorChartOffered(s, p, "1h", "macdx"), p).toBe(false);
    }
    for (const p of MACDX_ON_1H) {
      expect(indicatorChartOffered(s, p, "1h", "macdx"), p).toBe(true);
      expect(indicatorChartOffered(s, p, "5min", "macdx"), p).toBe(false);
    }
    // no other timeframe (v41 and v42's 15-minute chart among them), no other pair
    for (const p of MACDH_PAIRS) for (const iv of ["15min", "4h", "1day"]) expect(indicatorChartOffered(s, p, iv, "macdx"), `${p} ${iv}`).toBe(false);
    for (const p of ["GBP/JPY", "HKD/JPY"]) for (const iv of ["5min", "15min", "1h"]) expect(indicatorChartOffered(s, p, iv, "macdx"), `${p} ${iv}`).toBe(false);
    // the others' are as they were (the base block's own `limited`)
    expect(indicatorChartOffered(s, "XAU/USD", "15min", "ultra")).toBe(true);
    expect(indicatorChartOffered(s, "USD/JPY", "1h", "ultra")).toBe(true);
    expect(indicatorChartOffered(s, "EUR/JPY", "15min", "qtrend")).toBe(true);
    expect(indicatorChartOffered(s, "HKD/JPY", "1h")).toBe(true);
    expect(indicatorChartOffered(s, "HKD/JPY", "5min")).toBe(false);
    // a server that does not send them yet: nothing offered for the rule, the others still are
    const old = settings({ indicator: { ...indicator, macdx: undefined } });
    expect(old.indicator!.macdx).toBeNull();
    expect(indicatorChartOffered(old, "USD/JPY", "5min", "macdx")).toBe(false);
    expect(indicatorChartOffered(old, "USD/JPY", "5min", "ultra")).toBe(true);
  });

  // research/macdfade15min-prod-spec.md section 5: "With no `limited` (v40, or any server before the per-pair v41) the
  // app behaves exactly as today, which is why it can go first"
  it("with no `limited` in the rule's block (v40, or any server before the per-pair v41), offers the cross product, as before", () => {
    const cross = settings({ indicator: { ...indicator, macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS } } });
    expect(cross.indicator!.macdx).toEqual({ pairs: [...MACDH_PAIRS], intervals: ["5min", "1h"], limited: {} });
    for (const p of MACDH_PAIRS) for (const iv of ["5min", "1h"]) expect(indicatorChartOffered(cross, p, iv, "macdx"), `${p} ${iv}`).toBe(true);
    expect(indicatorChartOffered(cross, "USD/JPY", "15min", "macdx")).toBe(false);
    expect(indicatorChartOffered(cross, "GBP/JPY", "1h", "macdx")).toBe(false);
    // v40's own block (the six on 1 hour): every one of them on 1 hour, none on 15 minutes
    const v40 = settings({ indicator: { ...indicator, macdx: { pairs: MACDH_PAIRS, intervals: ["1h"] } } });
    expect(v40.indicator!.macdx).toEqual({ pairs: [...MACDH_PAIRS], intervals: ["1h"], limited: {} });
    for (const p of MACDH_PAIRS) {
      expect(indicatorChartOffered(v40, p, "1h", "macdx"), p).toBe(true);
      expect(indicatorChartOffered(v40, p, "15min", "macdx"), p).toBe(false);
    }
    // read as the base block's `limited` is: one that is not an object is none; a pair's entry keeps its strings only
    const odd = settings({ indicator: { ...indicator, macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS, limited: ["1h"] } } });
    expect(odd.indicator!.macdx!.limited).toEqual({});
    expect(indicatorChartOffered(odd, "EUR/JPY", "5min", "macdx")).toBe(true);
    const mixed = settings({ indicator: { ...indicator, macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS, limited: { "EUR/JPY": ["1h", 5], "USD/JPY": "5min" } } } });
    expect(mixed.indicator!.macdx!.limited).toEqual({ "EUR/JPY": ["1h"], "USD/JPY": [] });
    expect(indicatorChartOffered(mixed, "USD/JPY", "5min", "macdx")).toBe(false);
    expect(indicatorChartOffered(mixed, "EUR/JPY", "1h", "macdx")).toBe(true);
    expect(indicatorChartOffered(mixed, "EUR/JPY", "5min", "macdx")).toBe(false);
    expect(indicatorChartOffered(mixed, "AUD/USD", "1h", "macdx")).toBe(true);
    expect(indicatorChartOffered(mixed, "AUD/USD", "5min", "macdx")).toBe(true);
  });

  it("has its own tab, with two columns (v43: 5分 and 1時間), each pair a box on its own chart and \"—\" titled as the fade's own on the other, and saves a tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withMacdx({ subscriptions: [{ pair: "USD/JPY", interval: "5min", rule: "macdx" }] }) : withMacdx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD の逆張り");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    // the MACD fade (research/macdfade15min-prod-spec.md section 5): one email when the blue line closes at 96% with the
    // bar before not at 96%, the fade side, the price in, no take-profit and no stop price, whose choices these are
    // (the timeframes the owner's too), on each pair's own chart (v43: the five pairs on 5-minute bars, gold on 1-hour
    // bars; the pane 120 bars of the timeframe, 10 hours on 5-minute bars)
    expect(intro).toBe(ja.alerts.indicatorIntro.macdx);
    expect(intro).toContain("MACD(12・26・9)の青い線を使った、逆張りのサインです。");
    expect(intro).toContain(
      "足が確定した時に、青い線が、新しい120本の MACD の枠の上の端（青い線・オレンジの線・棒のうち一番高い所）の96%以上（0の線から測って）にいて、一つ前の足の終わりでは96%に届いていなかった時は売り（SELL）、下の端（一番低い所）の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった時は買い（BUY）です（上の端で売り、下の端で買いの、逆張りの向きです）。",
    );
    expect(intro).toContain("メールは1つの足で1通だけで、入りの値段（5ペアは、売りはその足の終値の売値、買いは買値。金はその足の終値）を書きます。");
    expect(intro).toContain("青い線が96%以上にいる間は、次のメールは送りません。一度96%より下で確定し、また96%以上で確定した時に、次のメールを送ります。");
    expect(intro).toContain("同じチャート・同じ向きに前の合図があっても、次の合図は送ります。");
    expect(intro).toContain(NO_TP_JA);
    expect(intro).toContain("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの5分足と、金（XAU/USD）の1時間足だけです（時間足は、オーナーが選びました）。");
    expect(intro).toContain(OWNER_INTRO_JA);
    expect(intro).toContain("5ペアを15分足と1時間足で測った数字は下の注にあり、メールを判定する5分足では測っていません。金では測っていません。");
    // each pair's own chart named (v43: the five on 5 minutes, gold on 1 hour), never the five pairs and gold on one
    expect(chartWordsLeft(intro, "ja")).toEqual([]);
    // nothing of v9's two emails (in at 90%, the notice, email 2 at 96%), nor of the rules before it
    for (const no of ["90%", "1通目", "2通目", "知らせ", "毎分", "流れに乗って", "MACD の流れ", "95%", "山・谷", "一つの山", "ULTRA", "損切り・利確の目安", "目標", "0.085"]) expect(intro, no).not.toContain(no);
    expectFadeGuards(intro, "ja", "the intro");
    const grid = screen.getByTestId("signal-alerts-grid");
    // two timeframes (v43: 5分 and 1時間; v41: 15分 and 1時間); the all-symbols row, the owner's five pairs and gold
    expect([...grid.querySelectorAll("thead th")].map((e) => e.textContent)).toEqual([ja.alerts.pairHeader, "5分", "1時間"]);
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(1 + MACDH_PAIRS.length);
    expect(MACDH_PAIRS).toHaveLength(6);
    // the five pairs a box under 5分 and "—" under 1時間; gold "—" under 5分 and a box under 1時間; every "—" titled with
    // the fade's own key (indicatorHourOnly speaks of the symbols GMO Coin does not carry, and would be wrong here)
    const cells = (pair: string) => ({ on: chartOf(pair).interval, off: chartOf(pair).interval === "5min" ? "1h" : "5min" });
    for (const p of MACDH_PAIRS) {
      const { on, off } = cells(p);
      expect(box(`signal-alert-macdx-${p}-${on}`).tagName, p).toBe("INPUT");
      expect(screen.queryByTestId(`signal-alert-macdx-${p}-${off}`), p).toBeNull();
      const none = screen.getByTestId(`signal-alert-macdx-${p}-${off}-none`);
      expect(none.textContent, p).toBe("—");
      expect(none.getAttribute("title"), p).toBe(MACDX_OTHER_CHART_JA);
      expect(screen.queryByTestId(`signal-alert-macdx-${p}-${on}-none`), p).toBeNull();
    }
    for (const p of MACDX_ON_5) expect(screen.getByTestId(`signal-alert-macdx-${p}-5min`)).toBeTruthy();
    for (const p of MACDX_ON_1H) expect(screen.getByTestId(`signal-alert-macdx-${p}-1h`)).toBeTruthy();
    // six boxes and six "—" cells in the pairs' rows, besides the all-symbols row's two boxes
    expect(grid.querySelectorAll("tbody input")).toHaveLength(2 + MACDH_PAIRS.length);
    const nones = [...grid.querySelectorAll("[data-testid$='-none']")];
    expect(nones).toHaveLength(MACDH_PAIRS.length);
    for (const n of nones) expect(n.getAttribute("title")).toBe(ja.alerts.macdxOtherChart);
    expect(ja.alerts.macdxOtherChart).toBe(MACDX_OTHER_CHART_JA);
    expect(nones.some((n) => n.getAttribute("title") === ja.alerts.indicatorHourOnly)).toBe(false);
    // the all-symbols row: a box under each timeframe
    expect(box("signal-alert-macdx-all-5min").tagName).toBe("INPUT");
    expect(box("signal-alert-macdx-all-1h").tagName).toBe("INPUT");
    for (const no of ["GBP/JPY", "HKD/JPY"]) for (const iv of ["5min", "1h"]) expect(screen.queryByTestId(`signal-alert-macdx-${no}-${iv}`)).toBeNull();
    // no 15分 column (v41 and v42's)
    expect(screen.queryByTestId("signal-alert-macdx-USD/JPY-15min")).toBeNull();
    expect(screen.queryByTestId("signal-alert-macdx-all-15min")).toBeNull();
    fireEvent.click(screen.getByTestId("signal-alert-macdx-USD/JPY-5min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "USD/JPY", interval: "5min", on: true, rule: "macdx", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-USD/JPY-5min") as HTMLInputElement).checked).toBe(true));
    // ULTRA's tick on the same chart is its own, and its "—" keeps indicatorHourOnly's title
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect((screen.getByTestId("signal-alert-ultra-USD/JPY-5min") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("signal-alerts-grid").querySelectorAll("thead th")).toHaveLength(1 + INDICATOR_INTERVALS.length);
    expect(screen.getByTestId("signal-alert-ultra-HKD/JPY-5min-none").getAttribute("title")).toBe(ja.alerts.indicatorHourOnly);
  });

  it("the fade's grid in English: the two columns (v43: 5m and 1h) and the \"—\" title of its own (section 5's en text)", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const grid = screen.getByTestId("signal-alerts-grid");
    expect([...grid.querySelectorAll("thead th")].map((e) => e.textContent)).toEqual([en.alerts.pairHeader, en.alerts.intervals["5min"], en.alerts.intervals["1h"]]);
    expect(en.alerts.intervals["5min"]).toBe("5m");
    const nones = [...grid.querySelectorAll("[data-testid$='-none']")];
    expect(nones.map((n) => n.getAttribute("data-testid"))).toEqual(MACDH_PAIRS.map((p) => `signal-alert-macdx-${p}-${MACDX_ON_5.includes(p) ? "1h" : "5min"}-none`));
    for (const n of nones) expect(n.getAttribute("title")).toBe(MACDX_OTHER_CHART_EN);
    expect(en.alerts.macdxOtherChart).toBe(MACDX_OTHER_CHART_EN);
  });

  // research/macdfade15min-prod-spec.md section 5: the new key, ja and en, as the spec writes it (its lines joined: ja with
  // nothing between, en with a space)
  it("the \"—\" title's new key is section 5's text, word for word, ja and en", () => {
    const spec = readFileSync("research/macdfade15min-prod-spec.md", "utf8");
    const at = spec.indexOf("a new key `alerts.macdxOtherChart`");
    expect(at).toBeGreaterThan(0);
    const para = spec.slice(at, spec.indexOf("\n  - ", at));
    expect(para.replace(/\n +/g, "")).toContain(`ja 「${ja.alerts.macdxOtherChart}」`);
    expect(para.replace(/\n +/g, " ")).toContain(`en "${en.alerts.macdxOtherChart}"`);
    expect(ja.alerts.macdxOtherChart).toBe(MACDX_OTHER_CHART_JA);
    expect(en.alerts.macdxOtherChart).toBe(MACDX_OTHER_CHART_EN);
  });

  // research/macdfade15min-prod-spec.md 6.3 step 2: the grid PR goes before the function; against v40 it draws v40's one
  // 1時間 column, as today; and an old bundle that does not read `limited` is not this one
  it("against v40's block (no `limited`, the six on 1 hour) draws v40's one 1時間 column with six boxes and no \"—\"", async () => {
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, macdx: { pairs: MACDH_PAIRS, intervals: ["1h"] } } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const grid = screen.getByTestId("signal-alerts-grid");
    expect([...grid.querySelectorAll("thead th")].map((e) => e.textContent)).toEqual([ja.alerts.pairHeader, "1時間"]);
    for (const p of MACDH_PAIRS) expect(box(`signal-alert-macdx-${p}-1h`).tagName, p).toBe("INPUT");
    expect(grid.querySelector("[data-testid$='-none']")).toBeNull();
    expect(grid.querySelectorAll("tbody input")).toHaveLength(1 + MACDH_PAIRS.length);
  });

  // with no `limited` and both timeframes the app draws the cross product (as any bundle before this change would
  // against the per-pair v41: section 5, "an old bundle draws the 12 boxes")
  it("with no `limited` and both timeframes, draws the cross product: twelve boxes, no \"—\"", async () => {
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS } } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const grid = screen.getByTestId("signal-alerts-grid");
    expect([...MACDH_INTERVALS]).toEqual(["5min", "1h"]);
    for (const p of MACDH_PAIRS) for (const iv of MACDH_INTERVALS) expect(box(`signal-alert-macdx-${p}-${iv}`).tagName, `${p} ${iv}`).toBe("INPUT");
    expect(grid.querySelector("[data-testid$='-none']")).toBeNull();
    expect(grid.querySelectorAll("tbody input")).toHaveLength(2 + 2 * MACDH_PAIRS.length);
  });

  // section 5: "The `stockmacd` grid is unchanged (one 15分 column)"; v42 (research/allstocks-prod-spec.md 6.3, section
  // 9): its header is 「銘柄」 / "Stock" (not 「通貨ペア」), still no "—"
  it("leaves the stock MACD's grid as it was: one 15分 column, a box a share, no \"—\"; v42: its header 「銘柄」 / \"Stock\"", async () => {
    const stockIndicator = { ...indicator, rules: ["qtrend", "ultra", "macdx", "stockmacd"], stockmacd: { pairs: ["AAPL", "7203.T"], intervals: ["15min"] } };
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    const grid = screen.getByTestId("signal-alerts-grid");
    expect([...grid.querySelectorAll("thead th")].map((e) => e.textContent)).toEqual(["銘柄", "15分"]);
    expect(ja.alerts.stockmacdHeader).toBe("銘柄");
    expect(box("signal-alert-stockmacd-AAPL-15min").tagName).toBe("INPUT");
    expect(box("signal-alert-stockmacd-7203.T-15min").tagName).toBe("INPUT");
    expect(grid.querySelector("[data-testid$='-none']")).toBeNull();
    cleanup();
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    const gridEn = screen.getByTestId("signal-alerts-grid");
    expect([...gridEn.querySelectorAll("thead th")].map((e) => e.textContent)).toEqual(["Stock", en.alerts.intervals["15min"]]);
    expect(gridEn.querySelector("[data-testid$='-none']")).toBeNull();
    // (the other rules keep 「通貨ペア」 / "Pair")
    expect([ja.alerts.pairHeader, en.alerts.pairHeader]).toEqual(["通貨ペア", "Pair"]);
  });

  it("shows RSI + SAR's record on its own tab only: not under the MACD tab, nor ULTRA's or Q-Trend's (a fixture that has a record, so the check can fail)", async () => {
    const big = { n: 40, wins: 14, losses: 24, expired: 2, open: 0, winRate: 0.35, meanR: -0.1, ciR: 0.4, sumR: -4 };
    const performance = { days: 365, mine: big, all: big, costly: big, byTf: {}, backtest: null, gainz: null };
    render(<SignalAlertSettings call={async () => withMacdx({ performance })} />);
    // RSI + SAR first: its record is there
    expect(await screen.findByTestId("signal-alerts-record")).toBeTruthy();
    for (const k of ["macdx", "ultra", "qtrend"]) {
      fireEvent.click(screen.getByTestId(`signal-alerts-rule-${k}`));
      expect(screen.queryByTestId("signal-alerts-record"), k).toBeNull();
    }
    fireEvent.click(screen.getByTestId("signal-alerts-rule-rsi_sar"));
    expect(screen.getByTestId("signal-alerts-record")).toBeTruthy();
  });

  it("against a server that sends no charts for the rule, says so instead of drawing an empty table (the other tabs still work)", async () => {
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, macdx: undefined } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-macdx-unavailable").textContent).toContain("まだ使えません");
    expect(screen.queryByTestId("signal-alerts-grid")).toBeNull();
    // the others are as they were
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect(screen.queryByTestId("signal-alerts-macdx-unavailable")).toBeNull();
    expect(screen.getByTestId("signal-alert-ultra-USD/JPY-5min")).toBeTruthy();
    // and a server that sends the rule an empty list is told the same
    cleanup();
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, macdx: { pairs: [], intervals: ["5min"] } } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-macdx-unavailable")).toBeTruthy();
  });

  it("the MACD pane's note on the chart names the fade, the card's intro names all five kinds, and the FAQ says of the fade what section 5 does", async () => {
    expect(ja.chart.macd.note).not.toContain("サインの判定には使っていません");
    expect(ja.chart.macd.note).toContain("メール通知の「MACD の逆張り」と「株の MACD」だけが、この MACD（12・26・9）を使います。");
    expect(en.chart.macd.note).not.toContain("no signal uses it");
    expect(en.chart.macd.note).toContain("only the \"MACD fade\" and \"Stock MACD\" email alerts do.");
    expect(ja.chart.macd.note).not.toContain("MACD の流れ");
    expect(en.chart.macd.note).not.toContain("MACD ride");
    expect(ja.alerts.intro("a@b.c")).toContain("・ULTRA・MACD の逆張り・流動性狩り＋EMAクロス）");
    expect(ja.alerts.introNoEmail).toContain("・ULTRA・MACD の逆張り・流動性狩り＋EMAクロス）");
    expect(en.alerts.intro("a@b.c")).toContain("ULTRA, MACD fade or Liquidity sweep + EMA cross)");
    expect(en.alerts.introNoEmail).toContain("ULTRA, MACD fade or Liquidity sweep + EMA cross)");
    // v43: the five pairs are judged at the reads 0, 1 and 3 minutes after the 5-minute close, gold between 1 and 30
    // minutes after the 1-hour close, and how long the fade's mail takes to arrive is not measured (v41 per pair: USD/JPY
    // and AUD/USD at 0, 1 and 3 minutes after the 15-minute close, EUR/JPY, AUD/JPY and EUR/USD at 0, 3 and 5 minutes
    // after the 1-hour close); the lead's arrival time (「足が確定してから数分で届きます」 / "It arrives a few minutes after
    // the bar closes"), never measured, is gone
    expect(ja.alerts.intro("a@b.c")).toContain("足が確定した後の読み込みで判定して送ります（MACD の逆張りは、ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルは5分足の確定の直後・1分後・3分後の読み込みで、金は1時間足の確定の1分後から30分後までの間に判定して送ります。実際に何分で届くかは測っていません）。");
    expect(en.alerts.intro("a@b.c")).toContain("It is judged and sent at a read after the bar closes (the MACD fade is judged and sent on USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD at the reads right after the 5-minute close and 1 and 3 minutes after, and on gold between 1 and 30 minutes after the 1-hour close; how long it takes to arrive has not been measured).");
    expect(ja.alerts.intro("a@b.c")).not.toContain("数分で届きます");
    expect(en.alerts.intro("a@b.c")).not.toContain("a few minutes");
    for (const t of [ja.alerts.intro("a@b.c"), ja.alerts.introNoEmail]) expect(t).not.toMatch(/MACD の流れ|2通目|96%/);
    for (const t of [en.alerts.intro("a@b.c"), en.alerts.introNoEmail]) expect(t).not.toMatch(/MACD ride|email 2|96%/);
    // the FAQ: the chart list and when the emails arrive name the fade (v9's email-2 parenthesis gone); its numbers are
    // in the settings' notes
    const faq = (d: typeof ja | typeof en) => d.lp.faqs.map((x: { q: string; a: string }) => `${x.q} ${x.a}`).join("\n");
    expect(faq(ja)).toContain("MACD の逆張りのサインをドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの5分足と、金の1時間足から選べます。");
    expect(faq(en)).toContain("and for the MACD fade signals on the 5-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD and the 1-hour bars of gold.");
    expect(faq(ja)).toContain(
      "足が確定した後の読み込みで判定して送ります（MACD の逆張りは、ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルは5分足の確定の直後・1分後・3分後の読み込みで、金は1時間足の確定の1分後から30分後までの間に、株は15分足（信越化学工業は1時間足）の確定の後の読み込みで判定して送ります。日本株は Yahoo の値段が約15分遅れて届くため、確定の15分ほど後です（15分足では、まだ測っていません）。MACD の逆張りが実際に何分で届くかは測っていません）。",
    );
    expect(faq(en)).toContain(
      "It is judged and sent at a read after the bar closes (the MACD fade is judged and sent on USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD at the reads right after the 5-minute close and 1 and 3 minutes after, on gold between 1 and 30 minutes after the 1-hour close, and on stocks at a read after each 15-minute close (each 1-hour close for Shin-Etsu Chemical); Yahoo's Tokyo prices come about 15 minutes late, so Japanese stocks' emails come some 15 minutes after the close (not yet measured on 15-minute bars); how long the MACD fade's emails take to arrive has not been measured).",
    );
    // the old leads are gone
    expect(faq(ja)).not.toContain("足が確定してから数分で届きます");
    expect(faq(en)).not.toContain("Within minutes of the bar closing");
    expect(faq(ja)).toContain("Q-Trend・ULTRA・MACD の逆張り・流動性狩り＋EMAクロスは、この時間もメールします。");
    expect(faq(en)).toContain("Q-Trend, ULTRA, MACD fade and liquidity sweep + EMA cross are emailed at those hours too.");
    expect(faq(ja)).toContain("MACD の逆張りは、5ペアを15分足と1時間足で測った数字が設定の注にあります。5ペアのメールを判定する5分足では、測っていません。");
    expect(faq(en)).toContain("The MACD fade has its own numbers, measured on the five pairs only, on 15-minute and on 1-hour bars, in the settings' notes. Its emails on the five pairs are judged on 5-minute bars, where it has not been measured.");
    // v43: the closes the fade is judged at, in 「他のツールと何が違いますか？」
    expect(faq(ja)).toContain("（MACD の逆張りも、5ペアは5分足、金は1時間足の確定で判定します）");
    expect(faq(en)).toContain("(the MACD fade too, at 5-minute closes on the five pairs and 1-hour closes on gold)");
    expect(faq(ja)).not.toContain("ペアごとに15分足か1時間足の確定で判定します");
    expect(faq(en)).not.toContain("at 15-minute or 1-hour closes, by pair");
    expect(faq(ja)).toContain("金・株と、流動性狩り＋EMAクロスは、まだ測っていません");
    expect(faq(en)).toContain("Gold, stocks and the liquidity sweep + EMA cross have not been measured.");
    // the sales page quotes no number (src/test/landing.test.tsx, which also pins its three texts on the fade word for
    // word): what the numbers cannot hide is said without one (〔adverse〕 of section 5, chosen per chart: on 15-minute
    // bars below no signal and below the other way, a pair's mean below zero, trades left open at a loss at the end of
    // the period)
    expect(faq(ja)).toContain("15分足では、合図なしで入った時より、1回あたりの平均が低くありました。15分足では、同じ合図で逆向きに入った時より、1回あたりの平均が低くありました。5ペアのうち、1回あたりの平均がマイナスのペアがありました。測った期間の終わりに、含み損のまま残っていた取引がありました。");
    expect(faq(en)).toContain("On 15-minute bars, its mean a trade was below entering with no signal. On 15-minute bars, its mean a trade was below entering the other way on the same signals. On some of the five pairs its mean a trade was below zero. At the end of the period measured, some trades were still open at an unrealised loss. ");
    for (const d of [ja, en]) {
      // neither v9's numbers nor the fade's: the four forbidden-number patterns of research/macdfade15min-prod-spec.md
      // 3.5 (both charts' runs of record, v40's run, the durations, the per-pair comparison, docs 8.155 and 8.156)
      expect(faq(d)).not.toMatch(/801|800|429|96\s?%/);
      for (const p of FORBIDDEN_NUMBERS) expect(faq(d), p.source.slice(0, 30)).not.toMatch(p);
      expect(faq(d)).not.toMatch(/MACD の流れ|MACD ride|2通目|email 2/);
      expect(faq(d)).not.toContain("山・谷");
      expect(faq(d)).not.toContain("peak/valley");
      expect(BACK_JA.test(faq(d))).toBe(false);
      expect(BACK_EN.test(faq(d))).toBe(false);
    }
  });

  // the MACD fade's notes (research/macdfade1h-prod-spec.md section 5, item by item, the same order; v41's per-pair
  // rewrites, research/macdfade15min-prod-spec.md section 5, pinned to that file in the describe below): each pair's
  // chart and when its closes are judged; gold's bars as v40's; the rule and the fade side; the zoom, pane-margin and
  // unrounded notes naming 96% only; the two measured paragraphs' notes' version (4.5) word for word, the 15-minute run's
  // then the 1-hour run's, then gold not measured; ULTRA's; no take-profit and no stop price, whose choices, nothing
  // recorded; the weekend; gold's quiet bars as v40's
  it("says in the notes what the one email is, when it is judged, the measured numbers of both charts (the notes' version of 4.5, five pairs only), and that it comes apart from ULTRA's", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    const items = ja.alerts.macdxNotes;
    // v9's 16 items: 5 went (the notice, email 2, the catch-up, the band, v9's numbers), 2 came in their place; v41 per
    // pair adds the 1-hour run's paragraph after the 15-minute run's
    expect(items).toHaveLength(14);
    expect(en.alerts.macdxNotes).toHaveLength(14);
    expect(notes).toBe(items.join(""));
    // rewritten (v43): each chart (the five pairs on 5 minutes, gold on 1 hour), and when its closes are judged (the five
    // pairs at the reads 0, 1 and 3 minutes after each 5-minute close, gold from 1 to 30 minutes after the close); how
    // long the mail takes is not measured; and the charts before the move (v41's 〔switch〕, 2026-11-20, among them)
    expect(items[0]).toBe(V43_NOTE0.ja);
    expect(items[0]).toContain(`（2026年11月18日から${SWITCH_JA}〈UTC〉までは1時間足）`);
    // gold's Twelve Data notes, v40's word for word (re-read until half an hour after the close)
    expect(items[1]).toContain("金の足は Twelve Data のものです（GMOコインに金がないため。");
    expect(items[1]).toContain("足は小数2桁に丸めた値で、MACD もその値で計算します");
    expect(items[1]).toContain("確定の1分後から判定します。足は、すでに保存されている足（チャートや、サーバーの前回までの確認が読んで保存したもの）にその足があればそれを使い");
    expect(items[1]).toContain("Twelve Data の1日の読み込み回数は、チャートや金のほかの通知と分け合っています。1日の上限に達した日は、足を読めずに、金のメールが出ないことがあります");
    expect(items[1]).toContain("読めたのに足がまだ無い時は、確定の約4分後にもう1回だけ読み、それでも無ければその足は送りません");
    expect(items[1]).toContain("読み込みそのものが失敗した時は、確定から30分まで、1〜3分おきに読み直します。確定から30分を過ぎた足は送りません。");
    expect(items[1]).toContain("確定から30分");
    expect(items[1]).not.toContain("次の足が確定するまで");
    expect(items[2]).toBe("金の足は、確定の直後（数秒後〜1分後）に読んだ足が、あとで読み直した足と同じかは、まだ確かめていません。金の1時間足を、本番で確定の何秒後に送るかも、まだ見ていません。");
    // rewritten: the rule of 2.1-2.2 and the fade side; one email a bar, none more while the line stays, no skip; the price
    expect(items[3]).toBe(
      "確定した足で、青い線（MACD）が、その足までの新しい120本の MACD の枠の上の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった時は売り、枠の下の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった時は買いです（どちらも0の線から測ります。上の端で売り、下の端で買いの、逆張りの向きです）。" +
        "枠の上の端は、その120本の青い線・オレンジの線（シグナル）・棒（ヒストグラム）のうち一番高い値で、どれも0より上に無い時は0です。下の端は一番低い値で、どれも0より下に無い時は0です（チャートの MACD の枠と同じ決め方です）。" +
        "端がオレンジの線や棒で決まっている時は、青い線がその96%まで行かないと出ません。96%の所に届いたかは、青い線だけで見ます（オレンジの線と棒は、端を決めるのにだけ使います）。" +
        "MACD は、判定する足で終わる600本の足から計算し、一つ前の足の終わりも、同じ600本の中で見ます。オレンジの線とのクロスは待ちません。" +
        "メールは1つの足で1通だけです。青い線が96%以上にいる間は、次のメールは送りません。一度96%より下で確定し、また96%以上で確定した時に、次のメールを送ります。同じチャート・同じ向きに前の合図があっても、次の合図は送ります。" +
        "入りの値段は、5ペアは、売りはその足の終値の売値、買いは買値で、金はその足の終値です（金には売値・買値の別はありません）。ほかのペアは選べません。",
    );
    // stay: the zoom note; the pane-margin and unrounded notes naming 96% only, the pane-margin note's last sentence the
    // closed bars'
    expect(items[4]).toBe("チャートを拡大・縮小すると MACD の枠の高さは変わりますが、メールはいつも新しい120本で決めます。チャートの MACD は、チャートが読んだ足から計算するので、メールの600本で出した値とわずかに違うことがあります。");
    expect(items[5]).toBe(
      "チャートは、MACD の枠を描く時に、上と下に枠の高さの8%ずつ余白を足しますが、メールの枠の端には、この余白を入れていません。そのため、画面で青い線が、描かれた枠の端から見て、メールの96%の所より内側に見えることがあります。また、チャートは作っている途中の足（まだ確定していない足）も入れて枠を決めます。メールは、確定した足までの新しい120本で決めます。",
    );
    expect(items[6]).toBe("青い線と96%の所は、丸めない値で比べます。チャートは MACD を丸めて見せる（円のペアは小数3桁、金は小数2桁）ので、96%の所のすぐ手前は、画面では届いて見えても出ないことがあります。");
    // in place of v9's numbers: the two measured paragraphs' notes' version (4.5), word for word as the function's shared
    // code builds them, [7] the 15-minute run's (44535888012) and [8] the 1-hour run's (44555599946), each with its
    // 〔mailedOn〕; then gold not measured (no number)
    expect(items[7]).toBe(FADE_MEASURED_NOTES["15min"].ja);
    expect(items[7]).toContain(`確定した15分足、スプレッド込み、docs §8.156）。${V43_MAILED_ON["15min"].ja}`);
    expect(items[7]).toContain("合図は6,006回、うち5,926回が+10 pips に届きました。80回は2026年11月10日 21:00（UTC）の時点でまだ届いておらず、その含み損益は合わせて-44,784.5 pips（マイナスが損）");
    expect(items[8]).toBe(FADE_MEASURED_NOTES["1h"].ja);
    expect(items[8]).toContain(`確定した1時間足、スプレッド込み、docs §8.156）。${V43_MAILED_ON["1h"].ja}`);
    expect(items[8]).toContain("合図は1,490回、うち1,468回が+10 pips に届きました。22回は2026年11月10日 21:00（UTC）の時点でまだ届いておらず、その含み損益は合わせて-9,820.9 pips（マイナスが損）");
    for (const k of [7, 8]) {
      expect(items[k]).toContain("メールの決まりで足の終値で入り、");
      expect(items[k]).not.toContain("このメールの決まりで");
      expect(items[k]).not.toContain("このメールでは判定しないので");
    }
    expect(items[9]).toBe("金では測っていません（足は Twelve Data のもので、売値・買値の別はありません）。上の2つの数字（15分足と1時間足）は5ペアのもので、金には当てはまりません。");
    expect(items[9]).not.toMatch(/pips|回|%/);
    // stay: ULTRA's
    expect(items[10]).toBe("ULTRA のメールとは別に届きます。両方をオンにすると、同じ時刻に2通届くことがあります。");
    // rewritten: no take-profit and no stop price, how the rule is built and not advice; whose choices (v43: the
    // timeframes, named; the pane 120 bars of the timeframe, 10 hours on 5-minute bars, not named a choice); nothing
    // recorded
    expect(items[11]).toBe(`${NO_TP_JA}${OWNER_NOTES_JA}通知は注文の指示ではありません。届いたサインの成績（+10 pips に届いたかどうかも）は、記録も表示もしていません。`);
    // rewritten (v41, the fifth review): the weekend's last bar per chart on GMO's bars, the same in US summer and winter
    // time; gold's quiet bars v40's word for word (its 1-hour bars)
    expect(items[12]).toContain("金曜 21:00 UTC（日本時間 土曜 6:00）以後、日曜 22:00 UTC（日本時間 月曜 7:00）より前に確定する足は判定しない");
    // (v43: the 5-minute chart's last bar, seen on one US-summer Friday only)
    expect(items[12]).toContain("週末の前の最後の足は判定されません（GMO の足では、ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの5分足は金曜 20:55〜21:00 UTC の足です。米国の夏時間の金曜1日〈2026年10月9日〉で見たもので、ほかの週の5分足は数えていません。金の足は数えていません）。");
    expect(items[12]).not.toMatch(/5本|2本/);
    expect(items[13]).toContain("金は、毎日の休み（1時間）の足と、日曜に市場が開く前の足（日曜 22:00 UTC 以後に確定するもの）にも、Twelve Data がほとんど動かない足を返すので、それらの足は判定します");
    expect(items[13]).toContain("金曜の引け後の1本と、日曜の市場が開く前の数時間の足（日曜 22:00 UTC より前に確定するもの）は、判定はしませんが、MACD の計算と、新しい120本には入ります");
    // what went: v9's two emails, the notice, the minute checks, the catch-up, the band, v9's numbers; and older rules'
    for (const no of ["90%", "1通目", "2通目", "知らせを", "毎分", "帯", "持ち続ける", "§8.150", "§8.149", "801回", "+0.19", "−323.6", "95%", "山・谷", "0.190", "ULTRA と同じ", "損切り・利確の目安", "損切りも目標もありません", "MACD の流れ"]) {
      expect(notes, no).not.toContain(no);
    }
    expectFadeGuards(notes, "ja", "the notes");
  });

  // v41 per pair (research/macdfade15min-prod-spec.md section 5): the all-symbols row has a box under each timeframe, and
  // each ticks the pairs offered there (v43: the 5分 one the five pairs, the 1時間 one gold); never a chart the rule is
  // not offered on (the function refuses a set_many holding one, 3.2 item 6)
  it("the all-symbols row's 5分 box follows the five pairs at once, and its 1時間 box gold", async () => {
    // a server that keeps what it is sent
    let subs: Array<{ pair: string; interval: string; rule: string }> = [];
    const call = vi.fn(async (body: Record<string, unknown>) => {
      if (body.action === "set_many") {
        const charts = body.charts as Array<{ pair: string; interval: string }>;
        subs = subs.filter((s) => !charts.some((c) => c.pair === s.pair && c.interval === s.interval));
        if (body.on) subs = [...subs, ...charts.map((c) => ({ ...c, rule: "macdx" }))];
      }
      return withMacdx({ subscriptions: subs });
    });
    const sets = () => call.mock.calls.filter((c) => c[0].action === "set_many").map((c) => c[0] as { on: boolean; charts: Array<{ pair: string; interval: string }> });
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    fireEvent.click(box("signal-alert-macdx-all-5min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "macdx", on: true, lang: "ja" })));
    expect(sets()).toHaveLength(1);
    expect(sets()[0].charts).toEqual(MACDH_PAIRS.filter((p) => MACDX_ON_5.includes(p)).map((pair) => ({ pair, interval: "5min" })));
    expect(new Set(sets()[0].charts.map((c) => c.pair))).toEqual(new Set(MACDX_ON_5));
    await waitFor(() => expect(box("signal-alert-macdx-all-5min").checked).toBe(true));
    for (const p of MACDX_ON_5) expect(box(`signal-alert-macdx-${p}-5min`).checked, p).toBe(true);
    // the 1時間 box is untouched: gold not followed
    expect(box("signal-alert-macdx-all-1h").checked).toBe(false);
    expect(box("signal-alert-macdx-all-1h").indeterminate).toBe(false);
    for (const p of MACDX_ON_1H) expect(box(`signal-alert-macdx-${p}-1h`).checked, p).toBe(false);
    fireEvent.click(box("signal-alert-macdx-all-1h"));
    await waitFor(() => expect(sets()).toHaveLength(2));
    expect(sets()[1].on).toBe(true);
    expect(sets()[1].charts).toEqual([{ pair: "XAU/USD", interval: "1h" }]);
    await waitFor(() => expect(box("signal-alert-macdx-all-1h").checked).toBe(true));
    for (const p of MACDX_ON_1H) expect(box(`signal-alert-macdx-${p}-1h`).checked, p).toBe(true);
    expect(box("signal-alert-macdx-all-5min").checked).toBe(true);
    // untick the 5分 box: its five only, gold's 1時間 stays
    fireEvent.click(box("signal-alert-macdx-all-5min"));
    await waitFor(() => expect(sets()).toHaveLength(3));
    expect(sets()[2].on).toBe(false);
    expect(sets()[2].charts).toEqual(sets()[0].charts);
    await waitFor(() => expect(box("signal-alert-macdx-all-5min").checked).toBe(false));
    expect(box("signal-alert-macdx-all-1h").checked).toBe(true);
    // every chart sent is a pair's own
    for (const s of sets()) for (const c of s.charts) expect(MACDX_LIMITED[c.pair], `${c.pair} ${c.interval}`).toEqual([c.interval]);
  });

  // #345: the owner already follows the five pairs when gold is added (docs §8.118). v41 per pair: gold shared the
  // 1時間 column with EUR/JPY, AUD/JPY and EUR/USD, so that column's box stood part-ticked. v43: gold is alone on 1時間
  // and the five on 5分, so the 5分 box is ticked and the 1時間 box is not (not part-ticked); a click on it ticks gold
  // only, and takes none of the five off
  it("with the five pairs ticked on their 5-minute charts and gold not, the 5分 all-symbols box is ticked and the 1時間 one is not (gold alone there); a click on it ticks gold, the five stay", async () => {
    const five = MACDH_PAIRS.filter((p) => p !== "XAU/USD");
    expect(five).toHaveLength(5);
    const mine = five.map((pair) => ({ ...chartOf(pair), rule: "macdx" }));
    expect(mine.every((r) => r.interval === "5min")).toBe(true);
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set_many"
        ? withMacdx({ subscriptions: [...mine, { pair: "XAU/USD", interval: "1h", rule: "macdx" }] })
        : withMacdx({ subscriptions: mine })
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(box("signal-alert-macdx-all-5min").checked).toBe(true);
    expect(box("signal-alert-macdx-all-5min").indeterminate).toBe(false);
    const before = box("signal-alert-macdx-all-1h");
    expect(before.checked).toBe(false);
    expect(before.indeterminate).toBe(false);
    expect(box("signal-alert-macdx-USD/JPY-5min").checked).toBe(true);
    expect(box("signal-alert-macdx-EUR/JPY-5min").checked).toBe(true);
    expect(box("signal-alert-macdx-XAU/USD-1h").checked).toBe(false);
    fireEvent.click(before);
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.objectContaining({ action: "set_many", rule: "macdx", on: true, lang: "ja" })));
    const sent = call.mock.calls.find((c) => c[0].action === "set_many")![0] as { charts: Array<{ pair: string; interval: string }> };
    expect(sent.charts).toEqual([{ pair: "XAU/USD", interval: "1h" }]);
    await waitFor(() => expect(box("signal-alert-macdx-XAU/USD-1h").checked).toBe(true));
    const after = box("signal-alert-macdx-all-1h");
    expect(after.checked).toBe(true);
    expect(after.indeterminate).toBe(false);
    expect(box("signal-alert-macdx-all-5min").checked).toBe(true);
  });

  it("gold's own tick saves under the MACD rule on 1 hour (its own chart), and ULTRA's gold ticks are another rule's", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withMacdx({ subscriptions: [{ pair: "XAU/USD", interval: "1h", rule: "macdx" }] }) : withMacdx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alert-macdx-XAU/USD-5min-none").textContent).toBe("—");
    fireEvent.click(screen.getByTestId("signal-alert-macdx-XAU/USD-1h"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "XAU/USD", interval: "1h", on: true, rule: "macdx", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-macdx-XAU/USD-1h") as HTMLInputElement).checked).toBe(true));
    // ULTRA's tick on gold's 1-hour chart is its own
    fireEvent.click(screen.getByTestId("signal-alerts-rule-ultra"));
    expect((screen.getByTestId("signal-alert-ultra-XAU/USD-1h") as HTMLInputElement).checked).toBe(false);
  });

  it("without Pro gold cannot be newly ticked under the MACD rule (nor the all-symbols row), but a tick already there can be taken off", async () => {
    render(
      <SignalAlertSettings
        call={async () => withMacdx({ allowed: false, subscriptions: [{ pair: "XAU/USD", interval: "1h", rule: "macdx" }] })}
      />
    );
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-pro-only")).toBeTruthy();
    expect(box("signal-alert-macdx-XAU/USD-1h").checked).toBe(true);
    expect(box("signal-alert-macdx-XAU/USD-1h").disabled).toBe(false);
    // (v43: the five pairs on 5分)
    expect(box("signal-alert-macdx-USD/JPY-5min").disabled).toBe(true);
    expect(box("signal-alert-macdx-EUR/JPY-5min").disabled).toBe(true);
    expect(box("signal-alert-macdx-all-5min").disabled).toBe(true);
    // v43: gold is alone on 1時間, so its ticked row makes that column's all-symbols box full, and a full box can be
    // taken off without Pro as a tick can (v41: gold shared 1時間 with three pairs not ticked, and the box was off)
    expect(box("signal-alert-macdx-all-1h").checked).toBe(true);
    expect(box("signal-alert-macdx-all-1h").disabled).toBe(false);
  });

  it("without Pro, with the five pairs ticked on their own charts and gold not, gold cannot be newly ticked and the 1時間 all-symbols box is off, while the five ticks (and the full 5分 box) can be taken off", async () => {
    const five = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
    render(<SignalAlertSettings call={async () => withMacdx({ allowed: false, subscriptions: five.map((pair) => ({ ...chartOf(pair), rule: "macdx" })) })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-pro-only")).toBeTruthy();
    expect(box("signal-alert-macdx-XAU/USD-1h").checked).toBe(false);
    expect(box("signal-alert-macdx-XAU/USD-1h").disabled).toBe(true);
    expect(box("signal-alert-macdx-all-1h").disabled).toBe(true);
    // the five ticked (v43: all on 5分): the 5分 box is full, and can be taken off
    expect(box("signal-alert-macdx-all-5min").checked).toBe(true);
    expect(box("signal-alert-macdx-all-5min").disabled).toBe(false);
    for (const pair of five) {
      const { interval } = chartOf(pair);
      expect(box(`signal-alert-macdx-${pair}-${interval}`).checked, pair).toBe(true);
      expect(box(`signal-alert-macdx-${pair}-${interval}`).disabled, pair).toBe(false);
    }
  });

  it("names a MACD alert in the recent list, whatever the rule id's tail", async () => {
    const alerts = [
          // #324: the 1-hour rule's id (v25), and the 5-minute rule's (v23–v24) on the rows mailed before
          { id: "m2", kind: "signal", rule: "macdx_12_26_9_w600_1h_lv8.5p_v2", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-10-12T14:00:00.000Z", entry: 158.4, stop: 158.27, target: 158.44, status: "sent", created_at: "2026-10-12T14:00:20.000Z" },
          { id: "m1", kind: "signal", rule: "macdx_12_26_9_w600_n288_k4_2_v1", pair: "USD/JPY", interval: "5min", side: "SELL", closed_at: "2026-10-11T02:50:00.000Z", entry: 157.209, stop: 157.339, target: 157.169, status: "sent", created_at: "2026-10-11T02:50:20.000Z" },
    ];
    render(<SignalAlertSettings call={async () => withMacdx({ alerts })} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    // (#397: a MACD row that is not a ride's is tagged as an earlier rule's, not as the ride)
    expect(rows[0].textContent).toContain("USD/JPY 1時間 買い（MACD・前の決まり）");
    expect(rows[0].textContent).toContain("目安 158.400 / 損切り 158.270 / 利確 158.440");
    expect(rows[1].textContent).toContain("USD/JPY 5分 売り（MACD・前の決まり）");
    expect(rows[1].textContent).toContain("目安 157.209 / 損切り 157.339 / 利確 157.169");
    // an old row has no ride kind
    expect(withMacdx({ alerts }).alerts.map((r) => r.ride)).toEqual([null, null]);
  });

  // #397 (docs §8.150): the three mails of the MACD ride, told apart by the full rule id the server sends
  const rideRows = [
    { id: "r-in", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_in_v9", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-11-12T01:00:00.000Z", entry: 158.4, stop: null, target: null, status: "sent", created_at: "2026-11-12T01:00:20.000Z" },
    { id: "r-at", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_at_v9", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-12T02:00:00.000Z", entry: 158.2, stop: null, target: null, status: "sent", created_at: "2026-11-12T02:00:20.000Z" },
    { id: "r-out", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_out_v9", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-11-12T03:10:00.000Z", entry: 158.4, stop: null, target: 158.9, status: "sent", created_at: "2026-11-12T03:10:05.000Z" },
    { id: "r-out-sell", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_out_v9", pair: "EUR/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-12T03:11:00.000Z", entry: 171.2, stop: null, target: 171.5, status: "sent", created_at: "2026-11-12T03:11:05.000Z" },
    { id: "r-old", kind: "signal", rule: "macdx_12_26_9_w600_1h_z95of120_v8", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-11T01:00:00.000Z", entry: 158.0, stop: 158.13, target: 157.96, status: "sent", created_at: "2026-11-11T01:00:20.000Z" },
  ];

  it("#397 tells the ride's three mails apart in the recent list: the entry as an entry, email 2 and the notice in a neutral colour", async () => {
    render(<SignalAlertSettings call={async () => withMacdx({ alerts: rideRows })} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows).toHaveLength(5);
    const label = (i: number) => rows[i].querySelector("span:not(.font-mono)") as HTMLElement;
    // email 1: an entry as before (green for a BUY), with the new label and no stop, so no plan line
    expect(rows[0].textContent).toContain("USD/JPY 1時間 買い（MACD の流れ）");
    expect(label(0).className).toContain("text-success");
    expect(rows[0].textContent).not.toContain("目安");
    expect(rows[0].textContent).not.toContain("損切り");
    // the notice: neutral, not a side
    expect(rows[1].textContent).toContain("USD/JPY 1時間 知らせ（もう96%）（MACD の流れ）");
    expect(rows[1].textContent).not.toContain("売り（");
    expect(label(1).className).toContain("text-foreground");
    expect(label(1).className).not.toContain("text-destructive");
    expect(rows[1].textContent).not.toContain("目安");
    // email 2: neutral, named for its side, with the first email's price and the price when seen
    expect(rows[2].textContent).toContain("USD/JPY 1時間 96%に届いた（買いの分）（MACD の流れ）");
    expect(label(2).className).toContain("text-foreground");
    expect(label(2).className).not.toContain("text-success");
    expect(rows[2].querySelector("[data-testid='signal-alert-ride-prices']")!.textContent).toBe("1通目の値段 158.400 / 見えた時の値段 158.900");
    expect(rows[2].textContent).not.toContain("利確");
    expect(rows[3].textContent).toContain("EUR/JPY 1時間 96%に届いた（売りの分）（MACD の流れ）");
    expect(label(3).className).not.toContain("text-destructive");
    expect(rows[3].querySelector("[data-testid='signal-alert-ride-prices']")!.textContent).toBe("1通目の値段 171.200 / 見えた時の値段 171.500");
    // an old v8 row (the 95% email's) keeps its side in colour and its plan line, under a tag that does not call it
    // the ride (that email had a stop and a target, and its side was the other way round)
    expect(rows[4].textContent).toContain("USD/JPY 1時間 売り（MACD・前の決まり）");
    expect(rows[4].textContent).not.toContain("MACD の流れ");
    expect(label(4).className).toContain("text-destructive");
    expect(rows[4].textContent).toContain("目安 158.000 / 損切り 158.130 / 利確 157.960");
    expect(rows[4].querySelector("[data-testid='signal-alert-ride-prices']")).toBeNull();
    // the kind, read from the id
    expect(withMacdx({ alerts: rideRows }).alerts.map((r) => r.ride)).toEqual(["in", "at", "out", "out", null]);
  });

  it("#397 does the same for the share's ride mails (their own ids), and a sell of a SELL-side ride is red only as an entry", async () => {
    const stockRows = [
      { id: "s-in", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2", pair: "NVDA", interval: "1h", side: "SELL", closed_at: "2026-11-12T15:30:00.000Z", entry: 180.12, stop: null, target: null, status: "sent", created_at: "2026-11-12T15:30:40.000Z" },
      { id: "s-at", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_at_v2", pair: "NVDA", interval: "1h", side: "BUY", closed_at: "2026-11-12T16:30:00.000Z", entry: 181, stop: null, target: null, status: "sent", created_at: "2026-11-12T16:30:40.000Z" },
      { id: "s-out", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_out_v2", pair: "NVDA", interval: "1h", side: "SELL", closed_at: "2026-11-12T17:30:00.000Z", entry: 180.12, stop: null, target: 178.5, status: "sent", created_at: "2026-11-12T17:30:40.000Z" },
    ];
    render(<SignalAlertSettings call={async () => withMacdx({ alerts: stockRows })} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    const label = (i: number) => rows[i].querySelector("span:not(.font-mono)") as HTMLElement;
    expect(rows[0].textContent).toContain("NVDA 1時間 売り（株の MACD）");
    expect(label(0).className).toContain("text-destructive");
    expect(rows[1].textContent).toContain("NVDA 1時間 知らせ（もう96%）（株の MACD）");
    expect(label(1).className).toContain("text-foreground");
    expect(rows[2].textContent).toContain("NVDA 1時間 96%に届いた（売りの分）（株の MACD）");
    expect(label(2).className).toContain("text-foreground");
    expect(rows[2].querySelector("[data-testid='signal-alert-ride-prices']")!.textContent).toMatch(/^1通目の値段 .*180.* \/ 見えた時の値段 .*178\.5/);
    expect(withMacdx({ alerts: stockRows }).alerts.map((r) => [r.rule, r.ride])).toEqual([["stockmacd", "in"], ["stockmacd", "at"], ["stockmacd", "out"]]);
  });

  // the MACD fade (research/macdfade1h-prod-spec.md section 5): one email a bar, an entry with the price in only (no
  // take-profit or stop price), its id "…_1h_fade96of120_in_v11" (the shares' "…_v4", 3.7); tagged as the fade, a share's
  // as the stock MACD's fade (not as a v9 share email 1, whose side was the other way round), its side in its colour,
  // and the plan line 「入り 〔entry〕 / 利確・損切りなし」. v9's and older rows read as before (the tests above)
  const fadeRows = [
    { id: "f-pair", kind: "signal", rule: "macdx_12_26_9_w600_1h_fade96of120_in_v11", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-18T02:00:00.000Z", entry: 158.412, stop: null, target: null, status: "sent", created_at: "2026-11-18T02:05:02.000Z" },
    { id: "f-gold", kind: "signal", rule: "macdx_12_26_9_w600_1h_fade96of120_in_v11", pair: "XAU/USD", interval: "1h", side: "BUY", closed_at: "2026-11-18T03:00:00.000Z", entry: 4139.89, stop: null, target: null, status: "sent", created_at: "2026-11-18T03:01:20.000Z" },
    { id: "f-share", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_fade96of120_in_v4", pair: "NVDA", interval: "1h", side: "SELL", closed_at: "2026-11-18T15:30:00.000Z", entry: 180.12, stop: null, target: null, status: "sent", created_at: "2026-11-18T15:30:40.000Z" },
    { id: "v9-share-in", kind: "signal", rule: "stockmacd_12_26_9_w600_1h_ride90to96of120_in_v2", pair: "NVDA", interval: "1h", side: "BUY", closed_at: "2026-11-12T15:30:00.000Z", entry: 181, stop: null, target: null, status: "sent", created_at: "2026-11-12T15:30:40.000Z" },
    { id: "v9-in", kind: "signal", rule: "macdx_12_26_9_w600_1h_ride90to96of120_in_v9", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-11-12T01:00:00.000Z", entry: 158.4, stop: null, target: null, status: "sent", created_at: "2026-11-12T01:00:20.000Z" },
    { id: "v8", kind: "signal", rule: "macdx_12_26_9_w600_1h_z95of120_v8", pair: "USD/JPY", interval: "1h", side: "SELL", closed_at: "2026-11-11T01:00:00.000Z", entry: 158.0, stop: 158.13, target: 157.96, status: "sent", created_at: "2026-11-11T01:00:20.000Z" },
  ];
  // research/macdfade96-spec.md 6.1's two patterns (no text says a price will come back), as 4.1 runs them
  const BACK_JA = /(必ず|いずれ|きっと|そのうち|やがて)[^。]{0,8}戻|戻ってく|戻ってき|戻るはず|戻ります/;
  const BACK_EN =
    /\b(always|will|surely|certainly|eventually)\s+(come|comes|go|goes)\s+back\b|\b(always|will|surely|certainly|eventually)\s+(return|returns|recover|recovers)\b|\bcomes?\s+back\s+(eventually|in\s+the\s+end)\b/i;
  // the screen's texts on the fade (research/macdfade15min-prod-spec.md section 5): no take-profit and no stop price, how
  // the rule is built, not advice (4.3 item 6, the notes' and intros' sentence), and whose choices these are (v41 per
  // pair: each pair's timeframe and the 15-minute MACD pane of the newest 120 bars; v43: the timeframes, the pane
  // stated as 120 bars of the timeframe, 10 hours on 5-minute bars, and not as a choice; in the intro and in the notes
  // [11], which names the timeframes; the shares' 4.4 item 10, judging shares on 15-minute bars, with no 「も」 / "too")
  const NO_TP_JA = "利確の値段も損切りの値段もありません。これはこの決まりの作りで、損切りをしないことを勧めるものではありません。";
  const NO_TP_EN = "There is no take-profit price and no stop price. That is how this rule is built; it is not advice to hold without a stop.";
  const OWNER_INTRO_JA =
    "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・時間足・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠は、その時間足の新しい120本（5分足では120本 × 5分 = 10時間）で、アプリのその時間足のチャートの枠と同じです。";
  const OWNER_INTRO_EN =
    "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, the timeframes, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane is the newest 120 bars of the timeframe (on 5-minute bars, 120 × 5 minutes = 10 hours), the same as the app's chart's on that timeframe.";
  const OWNER_NOTES_JA =
    "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・時間足（ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルは5分足、金は1時間足）・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠は、その時間足の新しい120本（5分足では120本 × 5分 = 10時間）で、アプリのその時間足のチャートの枠と同じです。";
  const OWNER_NOTES_EN =
    "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, the timeframes (5-minute bars for USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD, 1-hour bars for gold), the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane is the newest 120 bars of the timeframe (on 5-minute bars, 120 × 5 minutes = 10 hours), the same as the app's chart's on that timeframe.";
  const STOCK_OWNER_JA =
    "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・株を15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。";
  const STOCK_OWNER_EN =
    "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, judging shares on 15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's.";
  // v43's (V43S.notes3: 4063.T's 1-hour bars named, and its pane)
  const STOCK_OWNER_JA_V43 = fwd43(STOCK_OWNER_JA, V43S.notes3.ja);
  const STOCK_OWNER_EN_V43 = fwd43(STOCK_OWNER_EN, V43S.notes3.en);
  // 4.1: 「利確」 / "take profit" only in the sentences it allows, each written out here (the no-take-profit sentence, the
  // owner's choices in the intro, the notes and the shares' notes, the two measured paragraphs of 4.5, the plan line's
  // words), stripped before none is looked for; 「利確の目安」 / "take-profit level" never; and the two patterns find nothing
  const SENTENCES_JA = [
    "利確の値段も損切りの値段もありません。",
    "96%・足の確定で判定すること・時間足・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。",
    "96%・足の確定で判定すること・時間足（ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルは5分足、金は1時間足）・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。",
    // (v43: 4063.T's 1-hour bars named in it)
    "96%・足の確定で判定すること・株を15分足で判定すること（信越化学工業は1時間足。2026-11-27）・MACD の枠を15分足の新しい120本にすること・逆張りの向き（株にも当てはめること）・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。",
  ];
  const SENTENCES_EN = [
    "There is no take-profit price and no stop price.",
    "96%, judging at the bar's close, the timeframes, the fade side and stating no take-profit or stop price are the app owner's choices.",
    "96%, judging at the bar's close, the timeframes (5-minute bars for USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD, 1-hour bars for gold), the fade side and stating no take-profit or stop price are the app owner's choices.",
    "96%, judging at the bar's close, judging shares on 15-minute bars (Shin-Etsu Chemical on 1-hour bars, 2026-11-27), the MACD pane of the newest 120 15-minute bars, the fade side (shares included) and stating no take-profit or stop price are the app owner's choices.",
  ];
  const ALLOWED_JA = [...SENTENCES_JA, FADE_MEASURED_NOTES["15min"].ja, FADE_MEASURED_NOTES["1h"].ja, "利確・損切りなし"];
  const ALLOWED_EN = [...SENTENCES_EN, FADE_MEASURED_NOTES["15min"].en, FADE_MEASURED_NOTES["1h"].en, "no take profit, no stop"];
  const expectFadeGuards = (t: string, lang: "ja" | "en", what: string) => {
    expect(BACK_JA.test(t), what).toBe(false);
    expect(BACK_EN.test(t), what).toBe(false);
    if (lang === "ja") {
      expect(t, what).not.toContain("利確の目安");
      expect(ALLOWED_JA.reduce((rest, a) => rest.split(a).join(""), t), what).not.toContain("利確");
    } else {
      expect(t.toLowerCase(), what).not.toContain("take-profit level");
      expect(ALLOWED_EN.reduce((rest, a) => rest.split(a).join(""), t), what).not.toMatch(/take.?profit/i);
    }
  };
  // the allowed sentences are in the texts as written (so the strip above takes out what it says)
  it("4.1's allowed sentences are the screen's own, and the guards catch a sentence they do not allow", () => {
    for (const tf of ["15min", "1h"] as const) {
      expect(ja.alerts.macdxNotes).toContain(FADE_MEASURED_NOTES[tf].ja);
      expect(en.alerts.macdxNotes).toContain(FADE_MEASURED_NOTES[tf].en);
    }
    for (const a of SENTENCES_JA) expect(`${ja.alerts.indicatorIntro.macdx}${ja.alerts.macdxNotes.join("")}${ja.alerts.stockmacdNotes.join("")}`, a).toContain(a);
    for (const a of SENTENCES_EN) expect(`${en.alerts.indicatorIntro.macdx} ${en.alerts.macdxNotes.join(" ")} ${en.alerts.stockmacdNotes.join(" ")}`, a).toContain(a);
    expect(ja.alerts.fadePlan("1")).toContain(ALLOWED_JA[ALLOWED_JA.length - 1]);
    expect(en.alerts.fadePlan("1")).toContain(ALLOWED_EN[ALLOWED_EN.length - 1]);
    expect(() => expectFadeGuards(`${NO_TP_JA}利確は10 pipsです。`, "ja", "planted")).toThrow();
    expect(() => expectFadeGuards(`${NO_TP_JA}利確の目安`, "ja", "planted")).toThrow();
    expect(() => expectFadeGuards("どうせ必ず戻ってくる", "ja", "planted")).toThrow();
    expect(() => expectFadeGuards(`${NO_TP_EN} Take profit at 10 pips.`, "en", "planted")).toThrow();
    expect(() => expectFadeGuards("the price will come back", "en", "planted")).toThrow();
    expect(() => expectFadeGuards(`${NO_TP_JA}${OWNER_INTRO_JA}${OWNER_NOTES_JA}${STOCK_OWNER_JA_V43}`, "ja", "clean")).not.toThrow();
    expect(() => expectFadeGuards(`${NO_TP_EN} ${OWNER_INTRO_EN} ${OWNER_NOTES_EN} ${STOCK_OWNER_EN_V43}`, "en", "clean")).not.toThrow();
  });

  it("the MACD fade's rows: a pair's, gold's and a share's, each an entry in its side's colour, tagged as the fade, with the price in and no take-profit or stop, in Japanese and English", async () => {
    const read = withMacdx({ alerts: fadeRows }).alerts;
    // the fade is read from the id (its level 96); a ride's and an older row's are not the fade's, and a fade row is no ride's
    expect(read.map((r) => [r.rule, r.ride, r.rideOutPct, r.fade])).toEqual([
      ["macdx", null, null, { pct: 96 }],
      ["macdx", null, null, { pct: 96 }],
      ["stockmacd", null, null, { pct: 96 }],
      ["stockmacd", "in", 96, null],
      ["macdx", "in", 96, null],
      ["macdx", null, null, null],
    ]);
    expect(read.map((r) => [r.interval, r.closedAt, r.entry, r.stop, r.target])).toEqual([
      ["1h", "2026-11-18T02:00:00.000Z", 158.412, null, null],
      ["1h", "2026-11-18T03:00:00.000Z", 4139.89, null, null],
      ["1h", "2026-11-18T15:30:00.000Z", 180.12, null, null],
      ["1h", "2026-11-12T15:30:00.000Z", 181, null, null],
      ["1h", "2026-11-12T01:00:00.000Z", 158.4, null, null],
      ["1h", "2026-11-11T01:00:00.000Z", 158.0, 158.13, 157.96],
    ]);
    // the v9 rows' and the earlier rule's tests above hold for every other id
    for (const r of [...rideRows, { ...rideRows[0], rule: "macdx_12_26_9_w600_1h_touch90to95of120_in_v10" }, { ...rideRows[0], rule: "stockmacd_12_26_9_w600_1h_z95of120_v1" }]) {
      expect(withMacdx({ alerts: [r] }).alerts[0].fade, r.rule).toBeNull();
    }
    const { unmount } = render(<SignalAlertSettings call={async () => withMacdx({ alerts: fadeRows })} />);
    let rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows).toHaveLength(6);
    const label = (i: number) => rows[i].querySelector("span:not(.font-mono)") as HTMLElement;
    const time = (i: number) => rows[i].querySelector("span.font-mono") as HTMLElement;
    const plan = (i: number) => rows[i].querySelector("[data-testid='signal-alert-fade-plan']");
    // a pair's: SELL in red, the bar's close as the time (JST), the 1-hour timeframe from its interval
    expect(label(0).textContent).toBe("USD/JPY 1時間 売り（MACD の逆張り）");
    expect(label(0).className).toContain("text-destructive");
    expect(time(0).textContent).toBe("11-18 11:00");
    expect(plan(0)!.textContent).toBe("入り 158.412 / 利確・損切りなし");
    // gold's: BUY in green
    expect(label(1).textContent).toBe("XAU/USD 1時間 買い（MACD の逆張り）");
    expect(label(1).className).toContain("text-success");
    expect(time(1).textContent).toBe("11-18 12:00");
    expect(plan(1)!.textContent).toBe("入り 4139.89 / 利確・損切りなし");
    // a share's: tagged as the stock MACD's fade, not as a v9 share email 1
    expect(label(2).textContent).toBe("NVDA 1時間 売り（株の MACD・逆張り）");
    expect(label(2).className).toContain("text-destructive");
    expect(time(2).textContent).toBe("11-19 00:30");
    expect(plan(2)!.textContent).toBe("入り 180.12 / 利確・損切りなし");
    // v9's rows keep their tags, and no fade plan line; the earlier rule's row its own plan line
    expect(label(3).textContent).toBe("NVDA 1時間 買い（株の MACD）");
    expect(label(4).textContent).toBe("USD/JPY 1時間 買い（MACD の流れ）");
    expect(label(5).textContent).toBe("USD/JPY 1時間 売り（MACD・前の決まり）");
    expect(rows[5].textContent).toContain("目安 158.000 / 損切り 158.130 / 利確 157.960");
    for (const i of [3, 4, 5]) expect(plan(i), String(i)).toBeNull();
    for (const i of [0, 1, 2]) {
      const t = rows[i].textContent!;
      // no price is labelled a take-profit or a stop: 「利確」 and 「損切り」 only in the plan line's 「利確・損切りなし」
      expect(t.replace("利確・損切りなし", ""), String(i)).not.toMatch(/利確|損切り|目安/);
      expect(t, String(i)).not.toContain("MACD の流れ");
      expect(t, String(i)).not.toContain("前の決まり");
      expect(rows[i].querySelector("[data-testid='signal-alert-ride-prices']"), String(i)).toBeNull();
      expect(BACK_JA.test(t), String(i)).toBe(false);
    }
    unmount();
    render(<SignalAlertSettings call={async () => withMacdx({ alerts: fadeRows })} />, "en");
    rows = await screen.findAllByTestId("signal-alert-row");
    expect(label(0).textContent).toBe("USD/JPY 1h Sell (MACD fade)");
    expect(plan(0)!.textContent).toBe("In 158.412 / no take profit, no stop");
    expect(label(1).textContent).toBe("XAU/USD 1h Buy (MACD fade)");
    expect(plan(1)!.textContent).toBe("In 4139.89 / no take profit, no stop");
    expect(label(2).textContent).toBe("NVDA 1h Sell (Stock MACD fade)");
    expect(plan(2)!.textContent).toBe("In 180.12 / no take profit, no stop");
    expect(label(3).textContent).toBe("NVDA 1h Buy (Stock MACD)");
    expect(label(4).textContent).toBe("USD/JPY 1h Buy (MACD ride)");
    for (const i of [0, 1, 2]) {
      const t = rows[i].textContent!;
      expect(t.replace("no take profit, no stop", "").toLowerCase(), String(i)).not.toMatch(/take.profit|stop|target/);
      expect(t, String(i)).not.toContain("MACD ride");
      expect(BACK_EN.test(t), String(i)).toBe(false);
    }
    // the two new texts themselves
    for (const [d, tag] of [[ja, "（MACD の逆張り）"], [en, " (MACD fade)"]] as const) expect(d.alerts.ruleTagFade.macdx).toBe(tag);
    expect(ja.alerts.ruleTagFade.stockmacd).toBe("（株の MACD・逆張り）");
    expect(en.alerts.ruleTagFade.stockmacd).toBe(" (Stock MACD fade)");
    expect(ja.alerts.fadePlan("1")).not.toContain("利確の目安");
    expect(en.alerts.fadePlan("1").toLowerCase()).not.toContain("take-profit level");
  });

  it("is in English too", async () => {
    render(<SignalAlertSettings call={async () => withMacdx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-macdx"));
    expect(screen.getByTestId("signal-alerts-rule-macdx").textContent).toBe("MACD fade");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toBe(en.alerts.indicatorIntro.macdx);
    expect(intro).toContain("A fade signal from the MACD(12, 26, 9) blue line.");
    expect(intro).toContain(
      "When a bar closes with the blue line at 96% or more of the top of the MACD pane of the newest 120 bars (the highest of the blue line, the orange line and the bars), measured from the zero line, and it was below 96% at the close of the bar before, a SELL; at 96% or more of the bottom (the lowest) and below 96% at the close of the bar before, a BUY (the fade side: a SELL at the top, a BUY at the bottom).",
    );
    expect(intro).toContain("One email a bar, with the price in (on the five pairs the bar's bid close for a SELL and its ask close for a BUY; on gold the bar's close).");
    expect(intro).toContain("No further email while the blue line stays at 96% or more; the next comes after a close below 96% and then a close at 96% or more.");
    expect(intro).toContain("A later signal on the same chart and side is sent too, whatever came before it.");
    expect(intro).toContain(NO_TP_EN);
    expect(intro).toContain("5-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD and 1-hour bars of gold (XAU/USD) only (the owner chose the timeframes).");
    expect(intro).toContain(OWNER_INTRO_EN);
    expect(chartWordsLeft(intro, "en")).toEqual([]);
    expect(intro).toContain("Measured on the five pairs on 15-minute and on 1-hour bars (see the notes below), not on the 5-minute bars their emails are judged on; not measured on gold.");
    for (const no of ["90%", "Email 1", "Email 2", "email 2", "notice", "every minute", "with the flow", "MACD ride", "95%", "ULTRA", "peak", "valley", "0.190", "target"]) expect(intro, no).not.toContain(no);
    expectFadeGuards(intro, "en", "the intro (en)");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    const items = en.alerts.macdxNotes;
    expect(notes).toBe(items.join(""));
    expect(items[0]).toBe(V43_NOTE0.en);
    expect(items[0]).toContain(`(on 1-hour bars from 18 November 2026 to ${SWITCH_EN} UTC)`);
    expect(items[1]).toContain("Gold's bars are Twelve Data's (GMO Coin does not carry gold;");
    expect(items[1]).toContain("If the read itself fails, it is tried again every one to three minutes until half an hour after the close. A bar more than half an hour after its close is not sent.");
    expect(items[1]).not.toContain("until the next bar closes");
    expect(items[2]).toContain("Whether a bar read soon after its close (a few seconds to a minute) is the same as one read again later has not been checked");
    expect(items[2]).toContain("gold's 1-hour alert");
    expect(items[3]).toBe(
      "Sent at a closed bar where the blue line (MACD) is at 96% or more of the top of the MACD pane of the newest 120 bars up to that bar and was below 96% at the close of the bar before (a SELL), or at 96% or more of the pane's bottom and below 96% at the close of the bar before (a BUY); both are measured from the zero line (the fade side: a SELL at the top, a BUY at the bottom). " +
        "The pane's top is the highest of those 120 bars' blue line, orange line (signal) and bars (histogram), or 0 if none is above 0; the bottom is the lowest, or 0 if none is below 0 (as the chart's MACD pane decides it). " +
        "Where the orange line or the bars set the edge, the blue line has to get to 96% of that. Whether it has reached 96% is judged on the blue line alone (the orange line and the bars only set the edge). " +
        "MACD is worked out from the 600 bars ending at the bar judged, and the close of the bar before is read within the same 600 bars. A cross with the orange line is not waited for. " +
        "One email a bar. No further email while the blue line stays at 96% or more; the next comes after a close below 96% and then a close at 96% or more. A later signal on the same chart and side is sent too, whatever came before it. " +
        "The price in is, on the five pairs, the bar's bid close for a SELL and its ask close for a BUY, and on gold the bar's close (gold has no separate bid and ask). No other pair can be chosen.",
    );
    expect(items[4]).toBe("Zooming the chart in or out changes the height of its MACD pane, but the email always goes by the newest 120 bars. The chart works MACD out from the bars it has read, so it can differ a little from the email's, worked out on 600 bars.");
    expect(items[5]).toBe(
      "The chart adds a margin of 8% of the pane's height above and below as it draws the MACD pane; the email's edges do not include it, so the blue line on the screen can look inside the email's 96% mark, seen from the drawn edge. The chart also takes the bar still forming (not closed yet) into its pane. The email goes by the newest 120 bars up to the closed bar.",
    );
    expect(items[6]).toBe("The blue line and the 96% mark are compared unrounded. The chart shows MACD rounded (to 3 decimals on the yen pairs, to 2 on gold), so just short of the mark it can look reached on the chart while nothing is sent.");
    expect(items[7]).toBe(FADE_MEASURED_NOTES["15min"].en);
    expect(items[8]).toBe(FADE_MEASURED_NOTES["1h"].en);
    expect(items[7]).toContain(`docs §8.156). ${V43_MAILED_ON["15min"].en} `);
    expect(items[8]).toContain(`docs §8.156). ${V43_MAILED_ON["1h"].en} `);
    for (const k of [7, 8]) {
      expect(items[k]).toContain("Entered by the email's rule at the bar's close");
      expect(items[k]).toContain("The measurement re-reads GMO's past bars;");
      expect(items[k]).not.toContain("this email's rule");
    }
    expect(items[9]).toBe("Not measured on gold (its bars are Twelve Data's, with no separate bid and ask). The numbers above (on 15-minute and on 1-hour bars) are the five pairs' and do not apply to gold.");
    expect(items[10]).toBe("It arrives apart from ULTRA's emails: with both on, two emails can come at the same time.");
    expect(items[11]).toBe(`${NO_TP_EN} ${OWNER_NOTES_EN} An alert is not an instruction to trade. The alerts' results (whether one reached +10 pips included) are not recorded or shown.`);
    expect(items[12]).toContain("The time over the weekend when nothing is judged is drawn wide: a bar that closes at or after Friday 21:00 UTC");
    expect(items[12]).toContain("(on GMO's bars: on the 5-minute chart of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD the bar 20:55–21:00 UTC on Friday, as seen on one Friday in US summer time, 9 October 2026; the 5-minute bars of other weeks have not been counted. Gold's bars have not been counted).");
    expect(items[13]).toContain("are not judged, but they count in MACD and in the newest 120 bars.");
    for (const no of ["90%", "Email 1", "Email 2", "email 1", "email 2", "notice", "every minute", "minute by minute", "band", "§8.150", "§8.149", "801", "+0.19", "95%", "peak", "valley", "0.190", "There is no stop and no target", "MACD ride"]) {
      expect(notes, no).not.toContain(no);
    }
    expectFadeGuards(notes, "en", "the notes (en)");
  });

  // the shares' tab (research/macdfade15min-prod-spec.md section 5): the same fade, one email a bar, judged at each
  // 15-minute close; not measured; the shares, the list of 15-minute closes with the Tokyo delay (measured on the 1-hour
  // reads), the weekend and the US half day, "not an order"
  it("the stock MACD tab describes the fade's one email judged at each 15-minute close, says it is not measured, and keeps the Tokyo delay's note (measured on the 1-hour reads)", async () => {
    const stockIndicator = { ...indicator, rules: ["qtrend", "ultra", "stockmacd"], stockmacd: { pairs: ["AAPL", "7203.T"], intervals: ["15min"] } };
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("株の MACD");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toBe(ja.alerts.indicatorIntro.stockmacd);
    // (v43: 4063.T on 1-hour bars, the intro's one 1-hour word)
    expect(intro).toContain("米国株と日本株の15分足（信越化学工業〈4063.T〉は1時間足）で、FX と同じ「MACD の逆張り」のメールを送ります（1つの足で1通だけ）。足が確定した時に、");
    expect(intro.split("1時間足").length - 1).toBe(1);
    expect(intro).toContain("一つ前の足の終わりでは96%に届いていなかった時は売り（株の売りは空売りです）");
    expect(intro).toContain("入りの値段は、その足の終値です。青い線が96%以上にいる間は、次のメールは送りません。同じ株・同じ向きに前の合図があっても、次の合図は送ります。");
    expect(intro).toContain(NO_TP_JA);
    expect(intro).toContain("株では測っていません。");
    for (const no of ["90%", "1通目", "2通目", "知らせ", "毎分", "MACD の流れ", "目標", "メールに損切り・利確の目安は入りません"]) expect(intro, no).not.toContain(no);
    expectFadeGuards(intro, "ja", "the stock intro");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    const items = ja.alerts.stockmacdNotes;
    expect(items).toHaveLength(7);
    expect(en.alerts.stockmacdNotes).toHaveLength(7);
    expect(notes).toBe(items.join(""));
    expect(items[1]).toBe(
      "決まりは FX の「MACD の逆張り」と同じで、見るのは15分足（信越化学工業は1時間足）の確定ごとです。" +
        "その足で終わる確定足600本から計算した MACD(12・26・9)の青い線が、新しい120本の枠の上の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった足で売り、下の端の96%以上にいて、一つ前の足の終わりでは96%に届いていなかった足で買いです（逆張りの向きです。株の売りは空売りで、メールにもそう書きます）。" +
        "メールは1つの足で1通だけで、入りの値段はその足の終値です。青い線が96%以上にいる間は、次のメールは送りません。一度96%より下で確定し、また96%以上で確定した時に、次のメールを送ります。同じ株・同じ向きに前の合図があっても、次の合図は送ります。" +
        "届いた時の値段は、メールに書いた終値と違うことがあります（その差は測っていません）。",
    );
    expect(items[3]).toBe(`${NO_TP_JA}${STOCK_OWNER_JA_V43}取引時間の最後の足の終値は、次の取引時間の始まりまで売買できないことがあります（測っていません）。`);
    expect(items[4]).toBe("株では測っていません。5ペアで測った数字は、株には当てはまりません。損切りをしないので、含み損のまま残る取引が出ることがあります。その株に誰もチェックを入れていない間は、見ていません。");
    // v41: the shares on the 15-minute chart; the list of 15-minute closes (with Tokyo's 11:30 bar, never mailed, the
    // Tokyo delay, measured on the 1-hour reads, and "not checked" for the inbox; 〔closing〕 empty: spec 3.3 item 6's
    // condition does not hold today); the weekend and the US half day; "not an order"
    // v42 (research/allstocks-prod-spec.md 6.4): [0] any share Yahoo's search finds, at most 50 for all users together.
    // v43: [0] and [2] with V43S's swaps (4063.T on 1-hour bars, its closes)
    expect(items[0]).toBe(fwd43(V42_NOTE0_JA, V43S.notes0.ja));
    expect(back43(items[2], V43S.notes2.ja)).toBe(
      "足と値段は Yahoo Finance の公開データで、チャートの株の足と同じです（公式の配信ではないため、止まることがあります）。足が確定してから送ります。米国株はニューヨークの 9:45〜16:00 の15分ごと、日本株は 9:15〜11:30 と 12:45〜15:30 の15分ごとに足が確定し、Yahoo の最後の約定の時刻がそれを過ぎたら判定します。確定から45分を過ぎた足は送りません。日本株の前場の引け（11:30）の値段は、Yahoo では1本の足（11:30〜11:45）になり、チャートと MACD の600本に入りますが、その足ではメールを送りません。その足を判定できるのは 12:45 からの午後の読み込みで、確定から45分を過ぎているためです（コードから数えたもので、昼休みの間の Yahoo の答えは、まだ見ていません）。東証の値段は Yahoo では約15分遅れて届きます（2026-11-06 に、1時間足の読み込みで測りました）。そのため、日本株のメールは足が確定してから15分ほど後に判定して送ります（15分足で実際に何分後になるかは、まだ測っていません）。米国株は、1時間足の時に、確定の数秒後に送っていました（2026-11-05 の2通。15分足では、まだ見ていません）。受信箱に届くまでの時間は確かめていません。",
    );
    expect(items[5]).toBe("週末と、足が無い日（祝日など）は判定しません。米国の取引が早く終わる日は、最後の足（終わりの15分）も、ほかの足と同じく確定の後の読み込みで判定します（本物の早く終わる日では、まだ見ていません）。");
    expect(items[6]).toBe("通知は注文の指示ではありません。届いたサインの勝ち負けの記録は付けていません。");
    // docs §8.133's numbers belong to an earlier rule; v9's two emails are gone
    for (const no of ["1,696回", "99.36%", "−1,837.40%", "1,709通", "95%", "90%", "山・谷", "1通目", "2通目", "損切りも目標もありません", "損切り・利確の目安は付けていません", "MACD の流れ"]) expect(notes, no).not.toContain(no);
    expectFadeGuards(notes, "ja", "the stock notes");
    cleanup();
    render(<SignalAlertSettings call={async () => settings({ indicator: stockIndicator })} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-stockmacd"));
    expect(screen.getByTestId("signal-alerts-rule-stockmacd").textContent).toBe("Stock MACD");
    const introEn = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(introEn).toBe(en.alerts.indicatorIntro.stockmacd);
    expect(introEn).toContain("The MACD fade (the same email as on the currency pairs, one a bar) on US and Japanese stocks' 15-minute charts (the 1-hour chart for Shin-Etsu Chemical, 4063.T). When a bar closes with");
    expect(introEn.split("1-hour").length - 1).toBe(1);
    expect(introEn).toContain("and it was below 96% at the close of the bar before, a SELL (a SELL on a stock is a short sale)");
    expect(introEn).toContain("The price in is the bar's close. No further email while the blue line stays at 96% or more. A later signal on the same stock and side is sent too, whatever came before it.");
    expect(introEn).toContain(NO_TP_EN);
    expect(introEn).toContain("Not measured on stocks.");
    for (const no of ["90%", "Email 1", "Email 2", "notice", "every minute", "MACD ride", "target"]) expect(introEn, no).not.toContain(no);
    expectFadeGuards(introEn, "en", "the stock intro (en)");
    const notesEn = screen.getByTestId("signal-alerts-notes").textContent!;
    const itemsEn = en.alerts.stockmacdNotes;
    expect(notesEn).toBe(itemsEn.join(""));
    expect(itemsEn[0]).toBe(fwd43(V42_NOTE0_EN, V43S.notes0.en));
    expect(itemsEn[1]).toBe(
      "The rule is the same as the currency pairs' MACD fade; a stock is looked at at each 15-minute close (Shin-Etsu Chemical at each 1-hour close). " +
        "The MACD(12, 26, 9) blue line, computed on the 600 closed bars ending at the bar, is at 96% or more of the top of the newest 120 bars' pane and was below 96% at the close of the bar before: a SELL; at 96% or more of its bottom and below 96% at the close of the bar before: a BUY (the fade side; a SELL on a stock is a short sale, and the email says so). " +
        "One email a bar, with the bar's close as the price in. No further email while the blue line stays at 96% or more; the next comes after a close below 96% and then a close at 96% or more. A later signal on the same stock and side is sent too, whatever came before it. " +
        "The price when it arrives may differ from the close in the email (the difference has not been measured).",
    );
    expect(itemsEn[3]).toBe(`${NO_TP_EN} ${STOCK_OWNER_EN_V43} The close of a session's last bar may not be tradable until the next session opens (not measured).`);
    expect(itemsEn[4]).toBe("Not measured on stocks. The numbers measured on the five pairs do not apply to stocks. With no stop, some trades can stay open at an unrealised loss. While nobody has a stock ticked it is not watched.");
    expect(back43(itemsEn[2], V43S.notes2.en)).toBe(
      "The bars and the price are Yahoo Finance's public data, the same as the app's stock chart (not an official feed; it may stop). Mailed once the bar has closed: US bars close every 15 minutes from 9:45 to 16:00 New York time, Japanese ones every 15 minutes from 9:15 to 11:30 and from 12:45 to 15:30 Tokyo time; a bar is judged once Yahoo's last trade is past its close. A bar that closed more than 45 minutes ago is not mailed. Tokyo's morning closing price (11:30) is a bar of its own on Yahoo (11:30 to 11:45); it is in the chart and in the MACD's 600 bars, but no email is sent on that bar. It can be judged only at the afternoon's reads, from 12:45, more than 45 minutes after it closed (counted from the code; Yahoo's answer during the lunch break has not been seen yet). Yahoo's Tokyo prices come about 15 minutes late (measured on 2026-11-06, on the 1-hour reads), so Japanese stocks' emails are judged and sent some 15 minutes after the bar closed (how many minutes on 15-minute bars has not been measured yet); US stocks' were sent a few seconds after the close on 1-hour bars (the two on 2026-11-05; not yet seen on 15-minute bars). How long they take to reach the inbox has not been checked.",
    );
    expect(itemsEn[5]).toBe("Not judged at weekends or on a day with no bars (a holiday). On a US half day the last bar (the last 15 minutes) is judged at a read after its close like any other (not yet seen on a real half day).");
    for (const no of ["1,696", "99.36%", "1,837.40%", "95%", "90%", "peak", "valley", "Email 1", "Email 2", "There is no stop and no target", "MACD ride"]) expect(notesEn, no).not.toContain(no);
    expectFadeGuards(notesEn, "en", "the stock notes (en)");
  });
});

// #291: the owner's video's way (liquidity sweep + EMA cross), on its own chart (gold, 1 minute)
describe("#291 the video's way in the email-alert card", () => {
  const twelve = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).length < INDICATOR_INTERVALS.length);
  const indicator = {
    rules: ["qtrend", "ultra", "macdx", "sweepx"],
    pairs: INDICATOR_PAIRS,
    intervals: INDICATOR_INTERVALS,
    limited: Object.fromEntries(twelve.map((p) => [p, indicatorIntervalsFor(p)])),
    macdx: { pairs: MACDH_PAIRS, intervals: MACDH_INTERVALS, limited: MACDX_LIMITED },
    sweepx: { pairs: SWEEPX_PAIRS, intervals: SWEEPX_INTERVALS },
  };
  const withSweepx = (over: Record<string, unknown> = {}) => settings({ indicator, ...over });

  it("reads its one chart (gold, 1 minute), and offers nothing when the server sends none", () => {
    const s = withSweepx({ subscriptions: [{ pair: "XAU/USD", interval: "1min", rule: "sweepx" }, { pair: "XAU/USD", interval: "15min", rule: "ultra" }] });
    expect(s.indicator!.sweepx).toEqual({ pairs: ["XAU/USD"], intervals: ["1min"] });
    expect(s.subscriptions.map((x) => x.rule)).toEqual(["sweepx", "ultra"]);
    expect(indicatorChartOffered(s, "XAU/USD", "1min", "sweepx")).toBe(true);
    for (const [pair, iv] of [["XAU/USD", "5min"], ["XAU/USD", "15min"], ["USD/JPY", "1min"], ["USD/JPY", "5min"]]) {
      expect(indicatorChartOffered(s, pair, iv, "sweepx"), `${pair} ${iv}`).toBe(false);
    }
    // the others' are as they were: no rule but this one has gold's 1-minute chart
    expect(indicatorChartOffered(s, "XAU/USD", "15min", "ultra")).toBe(true);
    expect(indicatorChartOffered(s, "XAU/USD", "1min", "ultra")).toBe(false);
    expect(indicatorChartOffered(s, "XAU/USD", "1min", "macdx")).toBe(false);
    // a server that does not send it yet (older than v24): nothing offered for the rule, the others still are
    const old = settings({ indicator: { ...indicator, sweepx: undefined } });
    expect(old.indicator!.sweepx).toBeNull();
    expect(indicatorChartOffered(old, "XAU/USD", "1min", "sweepx")).toBe(false);
    expect(indicatorChartOffered(old, "USD/JPY", "5min", "macdx")).toBe(true);
  });

  it("has its own tab with one tick (gold, 1 minute), no all-symbols row, and saves the tick under its own rule", async () => {
    const call = vi.fn(async (body: Record<string, unknown>) =>
      body.action === "set" ? withSweepx({ subscriptions: [{ pair: "XAU/USD", interval: "1min", rule: "sweepx" }] }) : withSweepx()
    );
    render(<SignalAlertSettings call={call} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    expect(screen.getByTestId("signal-alerts-rule-sweepx").textContent).toBe("流動性狩り＋EMAクロス");
    const intro = screen.getByTestId("signal-alerts-indicator-intro").textContent!;
    expect(intro).toContain("EMA20 が EMA80 を上に抜けたら買い");
    expect(intro).toContain("金の1分足だけです");
    expect(intro).toContain("まだ測っていません");
    const grid = screen.getByTestId("signal-alerts-grid");
    expect(grid.querySelectorAll("thead th")).toHaveLength(2);
    expect(grid.querySelectorAll("thead th")[1].textContent).toBe("1分");
    expect(grid.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(screen.queryByTestId("signal-alerts-all-row")).toBeNull();
    expect(screen.queryByTestId("signal-alert-sweepx-all-1min")).toBeNull();
    expect(grid.querySelector("[data-testid$='-none']")).toBeNull();
    expect(screen.getAllByRole("checkbox").filter((el) => grid.contains(el))).toHaveLength(1);
    fireEvent.click(screen.getByTestId("signal-alert-sweepx-XAU/USD-1min"));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ action: "set", pair: "XAU/USD", interval: "1min", on: true, rule: "sweepx", lang: "ja" }));
    await waitFor(() => expect((screen.getByTestId("signal-alert-sweepx-XAU/USD-1min") as HTMLInputElement).checked).toBe(true));
    // the other rules' tables keep their all-symbols rows, and have no 1-minute column
    for (const k of ["ultra", "macdx"]) {
      fireEvent.click(screen.getByTestId(`signal-alerts-rule-${k}`));
      expect(screen.getByTestId("signal-alerts-all-row"), k).toBeTruthy();
      expect(screen.queryByTestId(`signal-alert-${k}-XAU/USD-1min`), k).toBeNull();
    }
    // no record is kept of these signals
    fireEvent.click(screen.getByTestId("signal-alerts-rule-sweepx"));
    expect(screen.queryByTestId("signal-alerts-record")).toBeNull();
  });

  it("its notes say what its bars are, when it is sent, and that it has not been measured", async () => {
    render(<SignalAlertSettings call={async () => withSweepx()} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("Swissquote の金の価格をサーバーが約3秒ごとに記録して作った1分足");
    expect(notes).toContain("確定から2分を過ぎた足は送りません");
    expect(notes).toContain("実際に何秒で届くかは、まだ確かめていません");
    expect(notes).toContain("1日100通");
    expect(notes).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません");
    // the hours it is not judged, and a winter Friday's last hour told as it
    // is: gold trades on, nothing is recorded or judged
    expect(notes).toContain("金曜 21:00〜日曜 22:00 UTC〈日本時間 土曜 6:00〜月曜 7:00〉）は、記録も判定もしません");
    expect(notes).toContain("閉まる直前の1本も、ほかの足と同じく、閉まった5秒後から判定して送ります");
    expect(notes).toContain("毎日の休みと夏時間の週末では、そのメールは、市場が開くまで注文できない時間に届きます");
    expect(notes).toContain("米国の冬時間（11月初め〜3月半ば）の金曜は、金は 22:00 UTC（日本時間 土曜 7:00）まで取引していますが、21:00 UTC からの1時間は記録も判定もしません");
    expect(en.alerts.sweepxNotes.at(-1)).toContain("In US winter time (early November to mid-March) gold trades on Fridays until 22:00 UTC, but its hour from 21:00 UTC is neither recorded nor judged.");
    // not the MACD rule's, nor Q-Trend's and ULTRA's
    expect(notes).not.toContain("GMOコインの通貨ペアだけで判定します");
    expect(notes).not.toContain("Twelve Data の無料枠");
    // the card's intro names all six kinds
    expect(ja.alerts.intro("a@b.c")).toContain("流動性狩り＋EMAクロス");
    expect(ja.alerts.introNoEmail).toContain("流動性狩り＋EMAクロス");
    expect(en.alerts.intro("a@b.c")).toContain("Liquidity sweep + EMA cross");
    expect(en.alerts.introNoEmail).toContain("Liquidity sweep + EMA cross");
  });

  it("against a server that sends no chart for the rule, says so instead of drawing an empty table", async () => {
    render(<SignalAlertSettings call={async () => settings({ indicator: { ...indicator, sweepx: undefined } })} />);
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    expect(screen.getByTestId("signal-alerts-sweepx-unavailable").textContent).toContain("まだ使えません");
    expect(screen.queryByTestId("signal-alerts-grid")).toBeNull();
    fireEvent.click(screen.getByTestId("signal-alerts-rule-macdx"));
    expect(screen.queryByTestId("signal-alerts-sweepx-unavailable")).toBeNull();
    expect(screen.getByTestId("signal-alert-macdx-USD/JPY-5min")).toBeTruthy();
  });

  it("names its alert in the recent list, with its stop and first target", async () => {
    const call = vi.fn(async () =>
      withSweepx({
        alerts: [
          { id: "s1", kind: "signal", rule: SWEEPX_RULE_ID, pair: "XAU/USD", interval: "1min", side: "BUY", closed_at: "2026-10-12T01:23:00.000Z", entry: 4021.35, stop: 4019.85, target: 4022.85, status: "sent", created_at: "2026-10-12T01:24:06.000Z" },
        ],
      })
    );
    render(<SignalAlertSettings call={call} />);
    const rows = await screen.findAllByTestId("signal-alert-row");
    expect(rows[0].textContent).toContain("XAU/USD 1分 買い（流動性狩り＋EMAクロス）");
    expect(rows[0].textContent).toContain("目安 4021.35 / 損切り 4019.85 / 利確 4022.85");
  });

  it("is in English too", async () => {
    render(<SignalAlertSettings call={async () => withSweepx()} />, "en");
    fireEvent.click(await screen.findByTestId("signal-alerts-rule-sweepx"));
    expect(screen.getByTestId("signal-alerts-rule-sweepx").textContent).toBe("Liquidity sweep + EMA cross");
    expect(screen.getByTestId("signal-alerts-indicator-intro").textContent).toContain("On gold's 1-minute chart only");
    expect(screen.getByTestId("signal-alerts-grid").querySelectorAll("thead th")[1].textContent).toBe("1m");
    const notes = screen.getByTestId("signal-alerts-notes").textContent!;
    expect(notes).toContain("recorded by the server every 3 seconds or so");
    expect(notes).toContain("have not been measured");
  });
});

// v41 per pair (research/macdfade15min-prod-spec.md section 5): every text section 5 writes out whole is the screen's,
// word for word, ja and en (v43: the texts that name the fade's charts with V43's swaps put back, back43; macdxNotes [0]
// is v43's own, V43_NOTE0) (〔switch〕 is the date of v41's first answer, written in step 4's PR as FUNCTION_VERSION's
// date is, and read here from FUNCTION_VERSION; 〔closing〕 is empty: spec 3.3 item 6's closing-price condition does not
// hold today, src/test/stockmacd-alerts.test.tsx); v40's kept items word for word, copied from 9ca2054; what it changes in
// part is pinned as it says; each pair's chart named as section 5 names it (the per-pair pin); and the forbidden-number
// patterns are the spec's
describe("v41 the screen's texts on the fade, word for word against research/macdfade15min-prod-spec.md section 5", () => {
  const spec = readFileSync("research/macdfade15min-prod-spec.md", "utf8");
  // the spec's lines joined: ja with nothing between, en with a space (as src/test/landing.test.tsx reads it)
  const specJa = spec.replace(/\n +/g, "");
  const specEn = spec.replace(/\n +/g, " ");
  const inJa = (t: string) => expect(specJa, t.slice(0, 60)).toContain(`「${t}」`);
  const inEn = (t: string) => expect(specEn, t.slice(0, 60)).toContain(`"${t}"`);

  it("the card intro (its lead too), ja and en (v43: the fade's timing swapped back to v41's)", () => {
    inJa(back43(ja.alerts.intro("${email}"), V43.timing.ja));
    inEn(back43(en.alerts.intro("${email}"), V43.timing.en));
  });

  it("macdxNotes: 14 items; [9] whole, ja and en; [11] and [12] with v43's swaps put back; [0] v43's own (v41's 〔switch〕 date in its last sentence); [1], [2] and [13] v40's word for word; [7] and [8] the two runs' notes' version", () => {
    expect(ja.alerts.macdxNotes).toHaveLength(14);
    expect(en.alerts.macdxNotes).toHaveLength(14);
    // v43: [0] rewritten whole (the five pairs on 5 minutes, gold on 1 hour, the charts before the move)
    expect(ja.alerts.macdxNotes[0]).toBe(V43_NOTE0.ja);
    expect(en.alerts.macdxNotes[0]).toBe(V43_NOTE0.en);
    inJa(ja.alerts.macdxNotes[9]);
    inEn(en.alerts.macdxNotes[9]);
    inJa(back43(ja.alerts.macdxNotes[11], V43.notes11.ja));
    inEn(back43(en.alerts.macdxNotes[11], V43.notes11.en));
    inJa(back43(ja.alerts.macdxNotes[12], V43.notes12.ja));
    inEn(back43(en.alerts.macdxNotes[12], V43.notes12.en));
    // 〔switch〕: v41's first answer's date, in section 5's form (no mark left), now in [0]'s sentence on the charts before
    expect(SWITCH_JA).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
    expect(SWITCH_EN).toMatch(/^\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/);
    expect(ja.alerts.macdxNotes[0]).toContain(`ドル/円・豪ドル/ドルは15分足（2026年11月18日から${SWITCH_JA}〈UTC〉までは1時間足）で、`);
    expect(en.alerts.macdxNotes[0]).toContain(`USD/JPY and AUD/USD were judged on 15-minute bars (on 1-hour bars from 18 November 2026 to ${SWITCH_EN} UTC)`);
    for (const t of [...ja.alerts.macdxNotes, ...en.alerts.macdxNotes]) expect(t).not.toContain("〔switch〕");
    // v40's items kept word for word (9ca2054 src/lib/i18n/ja.ts:2141, :2142, :2152; en.ts:2036, :2037, :2047)
    expect(ja.alerts.macdxNotes[1]).toBe("金の足は Twelve Data のものです（GMOコインに金がないため。Twelve Data の1日の読み込み回数は、チャートや金のほかの通知と分け合っています。1日の上限に達した日は、足を読めずに、金のメールが出ないことがあります）。足は小数2桁に丸めた値で、MACD もその値で計算します。確定の1分後から判定します。足は、すでに保存されている足（チャートや、サーバーの前回までの確認が読んで保存したもの）にその足があればそれを使い（金のチャートを開いていると、確定の数秒後に保存されることがあります）、なければ Twelve Data から読みます。読めたのに足がまだ無い時は、確定の約4分後にもう1回だけ読み、それでも無ければその足は送りません。読み込みそのものが失敗した時は、確定から30分まで、1〜3分おきに読み直します。確定から30分を過ぎた足は送りません。");
    expect(ja.alerts.macdxNotes[2]).toBe("金の足は、確定の直後（数秒後〜1分後）に読んだ足が、あとで読み直した足と同じかは、まだ確かめていません。金の1時間足を、本番で確定の何秒後に送るかも、まだ見ていません。");
    expect(ja.alerts.macdxNotes[13]).toBe("金は、毎日の休み（1時間）の足と、日曜に市場が開く前の足（日曜 22:00 UTC 以後に確定するもの）にも、Twelve Data がほとんど動かない足を返すので、それらの足は判定します（合図が出れば送ります）。金曜の引け後の1本と、日曜の市場が開く前の数時間の足（日曜 22:00 UTC より前に確定するもの）は、判定はしませんが、MACD の計算と、新しい120本には入ります。これは、保存された足（2026年8月16日〜10月12日、米国の夏時間）で見たことです。冬時間（11月1日から）の足と、祝日の足の動きは、まだ見ていません（祝日だけの決まりもありません）。毎日の休みの頭に確定する足（米国の夏時間は 21:00 UTC、日本時間 6:00）のメールは、休みの間に届きます。休みの間に注文が通るかは、確かめていません。");
    expect(en.alerts.macdxNotes[1]).toBe("Gold's bars are Twelve Data's (GMO Coin does not carry gold; Twelve Data's daily allowance of reads is shared with the chart and gold's other alerts, and on a day it runs out the bar cannot be read and no gold email may come). The bars are rounded to 2 decimals and MACD is worked out on those. Judging starts a minute after the close. The bar is taken from the bars already stored (read and kept by the chart or by the server's earlier checks) if they have it (a gold chart left open may have kept it a few seconds after the close), otherwise it is read from Twelve Data. If the read works but the bar is not there yet, it is read once more about four minutes after the close, and if it is still not there the bar is not sent. If the read itself fails, it is tried again every one to three minutes until half an hour after the close. A bar more than half an hour after its close is not sent.");
    expect(en.alerts.macdxNotes[2]).toBe("Whether a bar read soon after its close (a few seconds to a minute) is the same as one read again later has not been checked, and how many seconds after the close gold's 1-hour alert is sent has not been seen in production yet.");
    expect(en.alerts.macdxNotes[13]).toBe("On gold, Twelve Data returns a bar that barely moves for the daily break (one hour) and for the hour before the market opens on Sunday (a bar that closes from 22:00 UTC on Sunday), and those bars are judged (a signal is sent if one fires). The bar after Friday's close and the bars of the hours before Sunday's open (those that close before 22:00 UTC on Sunday) are not judged, but they count in MACD and in the newest 120 bars. This is what the stored bars of 16 August to 12 October 2026 (US summer time) show; winter-time bars (from 1 November) and the bars of holidays have not been looked at yet (there is no rule for holidays either). The email for a bar that closes at the start of the daily break (21:00 UTC, 6:00 Japan time, in US summer time) arrives during the break; whether an order goes through during the break has not been checked.");
    // the two measured paragraphs: the 15-minute run's, then the 1-hour run's (4.5)
    for (const [k, tf] of [[7, "15min"], [8, "1h"]] as const) {
      expect(ja.alerts.macdxNotes[k]).toBe(FADE_MEASURED_NOTES[tf].ja);
      expect(en.alerts.macdxNotes[k]).toBe(FADE_MEASURED_NOTES[tf].en);
    }
  });

  it("stockmacdNotes [2] (〔closing〕 empty), [3] and [5]'s sentence; [0] and [1] changed as section 5 says (v43: [0] to [3] with V43S's swaps put back)", () => {
    const j2 = specJa.match(/「(足と値段は Yahoo Finance の公開データで、チャートの株の足と同じです[^」]*)」/)![1];
    expect(back43(ja.alerts.stockmacdNotes[2], V43S.notes2.ja)).toBe(j2.replace("〔closing〕", ""));
    const e2 = specEn.match(/"(The bars and the price are Yahoo Finance's public data, the same as the app's stock chart[^"]*)"/)![1];
    expect(back43(en.alerts.stockmacdNotes[2], V43S.notes2.en)).toBe(e2.replace("〔closing〕", ""));
    inJa(back43(ja.alerts.stockmacdNotes[3], V43S.notes3.ja));
    inEn(back43(en.alerts.stockmacdNotes[3], V43S.notes3.en));
    expect(specJa).toContain("「米国の取引が早く終わる日は、最後の足（終わりの15分）も、ほかの足と同じく確定の後の読み込みで判定します（本物の早く終わる日では、まだ見ていません）。」");
    expect(ja.alerts.stockmacdNotes[5]).toContain("米国の取引が早く終わる日は、最後の足（終わりの15分）も、ほかの足と同じく確定の後の読み込みで判定します（本物の早く終わる日では、まだ見ていません）。");
    expect(en.alerts.stockmacdNotes[5]).toContain("On a US half day the last bar (the last 15 minutes) is judged at a read after its close like any other (not yet seen on a real half day).");
    // v42 (research/allstocks-prod-spec.md 6.4): [0] replaced; word for word against that spec in its own describe below
    expect(back43(ja.alerts.stockmacdNotes[0], V43S.notes0.ja)).toBe(V42_NOTE0_JA);
    expect(back43(en.alerts.stockmacdNotes[0], V43S.notes0.en)).toBe(V42_NOTE0_EN);
    expect(ja.alerts.stockmacdNotes[0]).not.toContain("の15分足だけで判定します");
    expect(en.alerts.stockmacdNotes[0]).not.toContain("Judged on the 15-minute chart of 8 US stocks");
    expect(back43(ja.alerts.stockmacdNotes[1], V43S.notes1.ja)).toContain("見るのは15分足の確定ごとです");
    expect(specEn).toContain("\"The rule is the same as the currency pairs' MACD fade; a stock is looked at at each 15-minute close.\"");
    expect(back43(en.alerts.stockmacdNotes[1], V43S.notes1.en).startsWith("The rule is the same as the currency pairs' MACD fade; a stock is looked at at each 15-minute close. ")).toBe(true);
    // v43's own: [1] names 4063.T's 1-hour closes
    expect(ja.alerts.stockmacdNotes[1]).toContain("見るのは15分足（信越化学工業は1時間足）の確定ごとです");
    expect(en.alerts.stockmacdNotes[1].startsWith("The rule is the same as the currency pairs' MACD fade; a stock is looked at at each 15-minute close (Shin-Etsu Chemical at each 1-hour close). ")).toBe(true);
    // the owner's sentence of 4.4 item 10, with no 「も」 / "too" (the third review)
    expect(ja.alerts.stockmacdNotes[3]).not.toContain("株も");
    expect(en.alerts.stockmacdNotes[3]).not.toContain("15-minute bars too");
  });

  it("the FAQ's 「メールはいつ届きますか？」 whole and its chart list, the stock data note, the intros' 15-minute words, ja and en (v43: the fade's charts swapped back to v41's)", () => {
    const answer = (d: typeof ja | typeof en, q: string) => d.lp.faqs.find((f: { q: string; a: string }) => f.q === q)!.a;
    inJa(back43(back43(answer(ja, "メールはいつ届きますか？"), V43S.faq.ja), V43.timing.ja));
    inEn(back43(back43(answer(en, "When do the emails arrive?"), V43S.faq.en), V43.timing.en));
    inJa(V43.pairs.ja[0][0]);
    inEn(V43.pairs.en[0][0]);
    expect(answer(ja, "どの通貨ペアに対応していますか？")).toContain(V43.pairs.ja[0][1]);
    expect(answer(en, "Which currency pairs are covered?")).toContain(V43.pairs.en[0][1]);
    expect(back43(answer(ja, "どの通貨ペアに対応していますか？"), V43.pairs.ja)).toContain(V43.pairs.ja[0][0]);
    expect(back43(answer(en, "Which currency pairs are covered?"), V43.pairs.en)).toContain(V43.pairs.en[0][0]);
    // v42 (research/allstocks-prod-spec.md 6.5): the stock data note's last parenthesis (v43: V43S's swap put back)
    expect(back43(ja.live.stockNote, V43S.stockNote.ja).endsWith("「株の MACD」で選べます（Yahoo の検索で見つかる株の15分足。使う人全員で合わせて50銘柄まで）。")).toBe(true);
    expect(back43(en.live.stockNote, V43S.stockNote.en).endsWith("→ Stock MACD (the 15-minute chart of a stock Yahoo's search finds; up to 50 stocks for all users together).")).toBe(true);
    expect(ja.live.stockNote.endsWith("「株の MACD」で選べます（Yahoo の検索で見つかる株の15分足。信越化学工業だけは1時間足。使う人全員で合わせて50銘柄まで）。")).toBe(true);
    expect(en.live.stockNote.endsWith("→ Stock MACD (the 15-minute chart of a stock Yahoo's search finds, the 1-hour chart for Shin-Etsu Chemical; up to 50 stocks for all users together).")).toBe(true);
    expect(JSON.stringify(ja)).not.toContain("（決まった22銘柄の15分足だけ）");
    expect(JSON.stringify(en)).not.toContain("(the 22 listed stocks' 15-minute charts only)");
    // indicatorIntro.macdx after section 5's four replacements (v41's: v43's swaps put back): 「15分足」 / "15-minute"
    // three times (USD/JPY's and AUD/USD's chart, the owner's 15-minute pane, the 15-minute run), each pair's own chart
    // named. v43's own: once (the 15-minute run, named with the 1-hour one)
    const introJa41 = back43(ja.alerts.indicatorIntro.macdx, V43.intro.ja);
    const introEn41 = back43(en.alerts.indicatorIntro.macdx, V43.intro.en);
    expect(introJa41.split("15分足").length - 1).toBe(3);
    expect(introEn41.split("15-minute").length - 1).toBe(3);
    expect(ja.alerts.indicatorIntro.macdx.split("15分足").length - 1).toBe(1);
    expect(en.alerts.indicatorIntro.macdx.split("15-minute").length - 1).toBe(1);
    for (const [o, n] of [["15分足の MACD(12・26・9)の青い線を使った、逆張りのサインです。15分足が確定した時に、", "MACD(12・26・9)の青い線を使った、逆張りのサインです。足が確定した時に、"], ["ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金（XAU/USD）の15分足だけです。", "ドル/円・豪ドル/ドルの15分足と、ユーロ/円・豪ドル/円・ユーロ/ドルと金（XAU/USD）の1時間足だけです（時間足は、ペアごとにオーナーが選びました）。"], ["96%・足の確定で判定すること・メールを15分足で判定すること・MACD の枠を15分足の新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。この枠は、アプリの15分足のチャートの枠と同じです。", "96%・足の確定で判定すること・ペアごとの時間足・15分足の MACD の枠を新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリのその時間足のチャートの枠と同じです。"], ["5ペアで測った数字は下の注に、金では測っていません。", "5ペアを15分足と1時間足で測った数字は下の注に、金では測っていません。"]] as Array<[string, string]>) {
      expect(introJa41).not.toContain(o);
      expect(introJa41).toContain(n);
      inJa(o);
      inJa(n);
    }
    for (const [o, n] of [["A fade signal from the 15-minute chart's MACD(12, 26, 9) blue line. When a 15-minute bar closes with", "A fade signal from the MACD(12, 26, 9) blue line. When a bar closes with"], ["15-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold (XAU/USD) only.", "15-minute bars of USD/JPY and AUD/USD and 1-hour bars of EUR/JPY, AUD/JPY, EUR/USD and gold (XAU/USD) only (the owner chose each pair's timeframe)."], ["96%, judging at the bar's close, judging the email on 15-minute bars, the MACD pane of the newest 120 15-minute bars, the fade side and stating no take-profit or stop price are the app owner's choices. That pane is the same as the app's 15-minute chart's.", "96%, judging at the bar's close, each pair's timeframe, the 15-minute MACD pane of the newest 120 bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the newest 120 bars) is the same as the app's chart's on that timeframe."], ["Measured on the five pairs (see the notes below); not measured on gold.", "Measured on the five pairs on 15-minute and on 1-hour bars (see the notes below); not measured on gold."]] as Array<[string, string]>) {
      expect(introEn41).not.toContain(o);
      expect(introEn41).toContain(n);
      inEn(o);
      inEn(n);
    }
    expect(introJa41).toContain(OWNER_JA_V41);
    expect(introEn41).toContain(OWNER_EN_V41);
    // v43: the owner's sentence is v43's (OWNER_INTRO_*), not v41's
    expect(ja.alerts.indicatorIntro.macdx).not.toContain(OWNER_JA_V41);
    expect(en.alerts.indicatorIntro.macdx).not.toContain(OWNER_EN_V41);
    expect(ja.alerts.indicatorIntro.macdx).toContain(OWNER_INTRO_JA_V43);
    expect(en.alerts.indicatorIntro.macdx).toContain(OWNER_INTRO_EN_V43);
    // the stock intro: v41's two 「15分足」 / "15-minute" (V43S's swaps put back); v43's one, beside 4063.T's 1-hour chart
    expect(back43(ja.alerts.indicatorIntro.stockmacd, V43S.intro.ja).split("15分足").length - 1).toBe(2);
    expect(back43(en.alerts.indicatorIntro.stockmacd, V43S.intro.en).split("15-minute").length - 1).toBe(2);
    expect(ja.alerts.indicatorIntro.stockmacd.split("15分足").length - 1).toBe(1);
    expect(en.alerts.indicatorIntro.stockmacd.split("15-minute").length - 1).toBe(1);
  });

  it("v43: each pair's own chart: 「5分足」 / \"5-minute\" only beside the five pairs, 「1時間足」 / \"1-hour\" only beside gold, no 「15分足」 / \"15-minute\" but where the measured runs or the charts before the move are named; the shares' texts 15-minute but for their two 1-hour reads", () => {
    // the fade's intro and notes (the two measured paragraphs are their runs', pinned above)
    const fade = (d: typeof ja | typeof en) => [d.alerts.indicatorIntro.macdx, ...d.alerts.macdxNotes.filter((_, k) => k !== 7 && k !== 8)];
    for (const t of fade(ja)) expect(chartWordsLeft(t, "ja"), t.slice(0, 40)).toEqual([]);
    for (const t of fade(en)) expect(chartWordsLeft(t, "en"), t.slice(0, 40)).toEqual([]);
    // the measured paragraphs: [7] the 15-minute run's, [8] the 1-hour run's, each with v43's 〔mailedOn〕
    expect(ja.alerts.macdxNotes[7]).toContain("確定した15分足、");
    expect(ja.alerts.macdxNotes[8]).toContain("確定した1時間足、");
    expect(en.alerts.macdxNotes[7]).toContain("15-minute bars that closed from");
    expect(en.alerts.macdxNotes[8]).toContain("1-hour bars that closed from");
    for (const [k, tf] of [[7, "15min"], [8, "1h"]] as const) {
      expect(ja.alerts.macdxNotes[k]).toContain(V43_MAILED_ON[tf].ja);
      expect(en.alerts.macdxNotes[k]).toContain(V43_MAILED_ON[tf].en);
    }
    // the pin catches what it is for: v41's per-pair texts, a pair on 15-minute or 1-hour bars, gold on 5-minute bars,
    // the five pairs and gold on one chart
    for (const t of [
      "ドル/円・豪ドル/ドルの15分足と、ユーロ/円・豪ドル/円・ユーロ/ドルと金（XAU/USD）の1時間足だけです。",
      "ドル/円の15分足だけです。",
      "ユーロ/円の1時間足だけです。",
      "金の5分足だけです。",
      "ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルと金の5分足だけで判定します。",
      "5ペアの1時間足だけです。",
      "金の1時間足と5ペアの15分足です。",
    ])
      expect(chartWordsLeft(t, "ja"), t).not.toEqual([]);
    for (const t of [
      "15-minute bars of USD/JPY and AUD/USD and 1-hour bars of EUR/JPY, AUD/JPY, EUR/USD and gold (XAU/USD) only.",
      "Judged on the 1-hour chart only for EUR/JPY.",
      "Judged on the 5-minute chart of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD and gold only.",
      "Judged on the 5-minute chart only for gold.",
      "Measured on the five pairs on 15-minute bars.",
    ])
      expect(chartWordsLeft(t, "en"), t).not.toEqual([]);
    // and lets v43's own sentences through
    expect(chartWordsLeft("ドル/円・ユーロ/円・豪ドル/円・ユーロ/ドル・豪ドル/ドルの5分足と、金（XAU/USD）の1時間足だけです。", "ja")).toEqual([]);
    expect(chartWordsLeft("5-minute bars of USD/JPY, EUR/JPY, AUD/JPY, EUR/USD and AUD/USD and 1-hour bars of gold (XAU/USD) only.", "en")).toEqual([]);
    // the shares' intro and notes: only 15-minute bars, but for the two 1-hour reads section 5 keeps (the Tokyo delay
    // measured on the 1-hour reads, the US mails sent a few seconds after the close on 1-hour bars) and, v43, the third
    // (the Tokyo bars judged some 15 minutes after the close on 1-hour bars, 2026-11-06), and 4063.T's own: every other
    // 「1時間足」 / "1-hour" in a sentence that names Shin-Etsu Chemical
    const strip = (t: string, keep: string[]) => keep.reduce((x, k) => x.split(k).join(""), t);
    const hourLeft = (t: string, sep: RegExp, word: string, name: string) => t.split(sep).filter((x) => x.includes(word) && !x.includes(name));
    const jaShares = strip([ja.alerts.indicatorIntro.stockmacd, ...ja.alerts.stockmacdNotes].join("\n"), ["1時間足の読み込みで測りました", "1時間足の時に、確定の数秒後に送っていました", "1時間足では、2026-11-06 に、確定の約15分後に判定していました"]);
    expect(hourLeft(jaShares, /。|\n/, "1時間足", "信越化学工業")).toEqual([]);
    // (the intro, [0], [1] and [2] once each, [3] three times: the owner's choice, the pane, the app's chart)
    expect(jaShares.split("1時間足").length - 1).toBe(7);
    const enShares = strip([en.alerts.indicatorIntro.stockmacd, ...en.alerts.stockmacdNotes].join("\n"), ["on the 1-hour reads", "after the close on 1-hour bars", "on 1-hour bars they were judged some 15 minutes after the close on 2026-11-06"]);
    expect(hourLeft(enShares, /\. |\n/, "1-hour", "Shin-Etsu Chemical")).toEqual([]);
    expect(enShares.split("1-hour").length - 1).toBe(7);
    // with V43S's swaps put back, v41's and v42's texts: no 1-hour word but the two reads
    const before = (d: typeof ja | typeof en, lang: "ja" | "en") =>
      [back43(d.alerts.indicatorIntro.stockmacd, V43S.intro[lang]), ...d.alerts.stockmacdNotes.map((t, k) => (k <= 3 ? back43(t, V43S[`notes${k}` as "notes0"][lang]) : t))].join("\n");
    expect(strip(before(ja, "ja"), ["1時間足の読み込みで測りました", "1時間足の時に、確定の数秒後に送っていました"])).not.toContain("1時間足");
    expect(strip(before(en, "en"), ["on the 1-hour reads", "after the close on 1-hour bars"])).not.toContain("1-hour");
    // the check catches a share on 1-hour bars that names no 4063.T
    expect(hourLeft("トヨタ自動車は1時間足で判定します。", /。|\n/, "1時間足", "信越化学工業")).not.toEqual([]);
    expect(hourLeft("Toyota Motor is judged on the 1-hour chart. ", /\. |\n/, "1-hour", "Shin-Etsu Chemical")).not.toEqual([]);
    // v43's pane, stated in the intro and the notes [11] (120 bars of the timeframe; on 5-minute bars, 10 hours), and not
    // v41's owner's 15-minute pane
    for (const p of ["（5分足では120本 × 5分 = 10時間）"]) {
      expect(ja.alerts.indicatorIntro.macdx).toContain(p);
      expect(ja.alerts.macdxNotes[11]).toContain(p);
    }
    expect(en.alerts.indicatorIntro.macdx).toContain("(on 5-minute bars, 120 × 5 minutes = 10 hours)");
    expect(en.alerts.macdxNotes[11]).toContain("(on 5-minute bars, 120 × 5 minutes = 10 hours)");
    for (const t of [ja.alerts.indicatorIntro.macdx, ...ja.alerts.macdxNotes]) expect(t).not.toContain("15分足の MACD の枠を新しい120本にすること");
    for (const t of [en.alerts.indicatorIntro.macdx, ...en.alerts.macdxNotes]) expect(t).not.toContain("the 15-minute MACD pane of the newest 120 bars");
    expect(ja.alerts.stockmacdNotes[2]).toContain("1時間足の読み込みで測りました");
    expect(ja.alerts.stockmacdNotes[2]).toContain("1時間足の時に、確定の数秒後に送っていました");
    expect(en.alerts.stockmacdNotes[2]).toContain("on the 1-hour reads");
    expect(en.alerts.stockmacdNotes[2]).toContain("after the close on 1-hour bars");
  });

  it("the forbidden-number patterns are the four of research/macdfade15min-prod-spec.md 3.5, and they catch the numbers they are for", () => {
    expect(FORBIDDEN_NUMBERS).toHaveLength(4);
    for (const p of FORBIDDEN_NUMBERS) expect(spec, p.source.slice(0, 30)).toContain(`\`/${p.source}/\``);
    // each finds the numbers the notes print, so it would catch them on the sales page
    for (const tf of ["15min", "1h"] as const) {
      expect(FORBIDDEN_NUMBERS.some((p) => p.test(FADE_MEASURED_NOTES[tf].ja)), tf).toBe(true);
      expect(FORBIDDEN_NUMBERS.some((p) => p.test(FADE_MEASURED_NOTES[tf].en)), tf).toBe(true);
    }
    expect(FORBIDDEN_NUMBERS[2].test("約545日")).toBe(true);
    expect(FORBIDDEN_NUMBERS[2].test("617 days")).toBe(true);
    expect(FORBIDDEN_NUMBERS[3].test("99.18")).toBe(true);
    // none in the sales page's texts, ja and en (the FAQ among them)
    for (const d of [ja, en]) for (const p of FORBIDDEN_NUMBERS) expect(JSON.stringify(d.lp), p.source.slice(0, 30)).not.toMatch(p);
  });

  it("v43's 5-minute fade rows read as fade rows, their timeframe 「5分」 / \"5m\" from their interval (no app code changes), and gold's 1-hour ones (v11) as before", async () => {
    const rows = [
      { id: "f5-pair", kind: "signal", rule: "macdx_12_26_9_w600_5min_fade96of120_in_v13", pair: "EUR/JPY", interval: "5min", side: "BUY", closed_at: "2026-11-30T01:05:00.000Z", entry: 181.234, stop: null, target: null, status: "sent", created_at: "2026-11-30T01:05:02.000Z" },
      { id: "f1h-gold", kind: "signal", rule: "macdx_12_26_9_w600_1h_fade96of120_in_v11", pair: "XAU/USD", interval: "1h", side: "SELL", closed_at: "2026-11-30T01:00:00.000Z", entry: 4150.12, stop: null, target: null, status: "sent", created_at: "2026-11-30T01:01:10.000Z" },
    ];
    const s = settings({ alerts: rows });
    expect(s.alerts.map((r) => [r.rule, r.interval, r.fade])).toEqual([
      ["macdx", "5min", { pct: 96 }],
      ["macdx", "1h", { pct: 96 }],
    ]);
    render(<SignalAlertSettings call={async () => settings({ alerts: rows })} />);
    const shown = await screen.findAllByTestId("signal-alert-row");
    expect(shown.map((r) => (r.querySelector("span:not(.font-mono)") as HTMLElement).textContent)).toEqual([
      "EUR/JPY 5分 買い（MACD の逆張り）",
      "XAU/USD 1時間 売り（MACD の逆張り）",
    ]);
  });

  it("v41's 15-minute fade rows read as fade rows, their timeframe 「15分」 / \"15m\" from their interval (no app code changes); v40's 1-hour ones still read as fade rows", async () => {
    const rows = [
      { id: "f15-pair", kind: "signal", rule: "macdx_12_26_9_w600_15min_fade96of120_in_v12", pair: "USD/JPY", interval: "15min", side: "SELL", closed_at: "2026-11-23T13:15:00.000Z", entry: 158.412, stop: null, target: null, status: "sent", created_at: "2026-11-23T13:15:02.000Z" },
      { id: "f15-share", kind: "signal", rule: "stockmacd_12_26_9_w600_15min_fade96of120_in_v5", pair: "NVDA", interval: "15min", side: "BUY", closed_at: "2026-11-23T15:00:00.000Z", entry: 180.12, stop: null, target: null, status: "sent", created_at: "2026-11-23T15:00:40.000Z" },
      { id: "f1h-pair", kind: "signal", rule: "macdx_12_26_9_w600_1h_fade96of120_in_v11", pair: "USD/JPY", interval: "1h", side: "BUY", closed_at: "2026-11-23T12:00:00.000Z", entry: 158.2, stop: null, target: null, status: "sent", created_at: "2026-11-23T12:00:20.000Z" },
    ];
    const s = settings({ alerts: rows });
    expect(s.alerts.map((r) => [r.rule, r.interval, r.fade])).toEqual([
      ["macdx", "15min", { pct: 96 }],
      ["stockmacd", "15min", { pct: 96 }],
      ["macdx", "1h", { pct: 96 }],
    ]);
    render(<SignalAlertSettings call={async () => settings({ alerts: rows })} />);
    const shown = await screen.findAllByTestId("signal-alert-row");
    expect(shown.map((r) => (r.querySelector("span:not(.font-mono)") as HTMLElement).textContent)).toEqual([
      "USD/JPY 15分 売り（MACD の逆張り）",
      "NVDA 15分 買い（株の MACD・逆張り）",
      "USD/JPY 1時間 買い（MACD の逆張り）",
    ]);
  });
});
// the intro's owner sentence (section 5's third replacement, after the sentence before it)
const OWNER_JA_V41 =
  "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・ペアごとの時間足・15分足の MACD の枠を新しい120本にすること・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠（新しい120本）は、アプリのその時間足のチャートの枠と同じです。";
const OWNER_EN_V41 =
  "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, each pair's timeframe, the 15-minute MACD pane of the newest 120 bars, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane (the newest 120 bars) is the same as the app's chart's on that timeframe.";
// v43's (the timeframes the owner's; the pane stated as 120 bars of the timeframe, 10 hours on 5-minute bars, not as a
// choice of the owner's)
const OWNER_INTRO_JA_V43 =
  "この決まりは Sextant 独自のもので、公開されているインジケーターではありません。96%・足の確定で判定すること・時間足・逆張りの向き・利確と損切りの値段を書かないことは、アプリのオーナーが決めたものです。MACD の枠は、その時間足の新しい120本（5分足では120本 × 5分 = 10時間）で、アプリのその時間足のチャートの枠と同じです。";
const OWNER_INTRO_EN_V43 =
  "This rule is Sextant's own, not a published indicator. 96%, judging at the bar's close, the timeframes, the fade side and stating no take-profit or stop price are the app owner's choices. The MACD pane is the newest 120 bars of the timeframe (on 5-minute bars, 120 × 5 minutes = 10 hours), the same as the app's chart's on that timeframe.";

// v42 (research/allstocks-prod-spec.md 6.4, 6.5): the stock MACD tab's new and changed texts and the chart's one
// sentence, word for word against that file: a ja text as 「…」 there, an en text as its JSON string there (the spec
// writes the inner quotes of notes [0] as \"), a text with a number as its template there (`…${n}…`)
describe("v42 the stock MACD tab's texts, word for word against research/allstocks-prod-spec.md 6.4 and 6.5", () => {
  const spec = readFileSync("research/allstocks-prod-spec.md", "utf8");
  const specOne = spec.replace(/\n +/g, " ");
  const T = (s: string) => s as unknown as number;
  it("the plain texts, ja and en", () => {
    const keys = ["stockmacdSearchLabel", "stockmacdNoHits", "stockmacdHeader", "stockmacdAllRow", "stockmacdCountUnread", "stockmacdNotFound", "stockmacdCheckFailed"] as const;
    for (const k of keys) {
      expect(spec, k).toContain(`「${ja.alerts[k]}」`);
      expect(spec, k).toContain(JSON.stringify(en.alerts[k]));
    }
    // (v43: V43S's swap put back)
    expect(spec).toContain(`「${back43(ja.alerts.stockmacdNotes[0], V43S.notes0.ja)}」`);
    expect(spec).toContain(JSON.stringify(back43(en.alerts.stockmacdNotes[0], V43S.notes0.en)));
    expect([back43(ja.alerts.stockmacdNotes[0], V43S.notes0.ja), back43(en.alerts.stockmacdNotes[0], V43S.notes0.en)]).toEqual([V42_NOTE0_JA, V42_NOTE0_EN]);
    // [1]-[6] unchanged (7 in all)
    expect([ja.alerts.stockmacdNotes.length, en.alerts.stockmacdNotes.length]).toEqual([7, 7]);
  });

  it("the texts with a number, as their templates, ja and en; and filled in", () => {
    const tpl = [
      ja.alerts.stockmacdCount(T("${n}"), T("${cap}")), en.alerts.stockmacdCount(T("${n}"), T("${cap}")),
      ja.alerts.stockmacdFull(T("${cap}")), en.alerts.stockmacdFull(T("${cap}")),
      ja.alerts.stockmacdCapRefused(T("${cap}")), en.alerts.stockmacdCapRefused(T("${cap}")),
      ja.alerts.stockmacdStale("${day}"), en.alerts.stockmacdStale("${day}"),
      ja.alerts.stockmacdShortBars(T("${n}")), en.alerts.stockmacdShortBars(T("${n}")),
    ];
    for (const x of tpl) expect(spec, x).toContain("`" + x + "`");
    expect(ja.alerts.stockmacdCount(48, 50)).toBe("通知している株（使う人全員の合計）: 48/50銘柄");
    expect(en.alerts.stockmacdCount(48, 50)).toBe("Stocks alerted (all users together): 48 of 50");
    expect(ja.alerts.stockmacdShortBars(412)).toBe("Yahoo から読めた15分足が412本で、600本に届くまで判定しません");
    expect(en.alerts.stockmacdShortBars(412)).toBe("412 15-minute bars could be read from Yahoo; not judged until there are 600");
  });

  it("the chart's stock note: only its last parenthesis changed (6.5)", () => {
    expect(spec).toContain("「（決まった22銘柄の15分足だけ）」 → 「（Yahoo の検索で見つかる株の15分足。使う人全員で合わせて50銘柄まで）」");
    expect(specOne).toContain("\"(the 22 listed stocks' 15-minute charts only)\" → \"(the 15-minute chart of a stock Yahoo's search finds; up to 50 stocks for all users together)\"");
    expect(back43(ja.live.stockNote, V43S.stockNote.ja)).toContain("（Yahoo の検索で見つかる株の15分足。使う人全員で合わせて50銘柄まで）");
    expect(back43(en.live.stockNote, V43S.stockNote.en)).toContain("(the 15-minute chart of a stock Yahoo's search finds; up to 50 stocks for all users together)");
    // the rest as before: the way to the tab stays (src/test/stocks.test.tsx reads it on the chart)
    expect(ja.live.stockNote).toContain("株のメール通知は、「設定」→「メール通知」の「株の MACD」で選べます（");
    expect(en.live.stockNote).toContain("Stock emails can be chosen under Settings → Email alerts → Stock MACD (");
  });
});
