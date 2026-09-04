// Language of the generated analysis. The UI strings live in src/lib/i18n, but
// the analysis body, thesis, key factors and warnings are written by the model,
// so the locale has to reach the prompt or a viewer reading the app in English
// still gets a Japanese trade rationale.
//
// Deno-free on purpose: src/test/locale.test.ts imports this file directly.

export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export type AnalysisLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_ANALYSIS_LOCALE: AnalysisLocale = "ja";

// Accepts what the client sends ("ja", "en-GB", "JA_jp") and anything else
// falls back rather than producing a prompt in no language at all.
export const resolveAnalysisLocale = (value: unknown): AnalysisLocale => {
  if (typeof value !== "string") return DEFAULT_ANALYSIS_LOCALE;
  const base = value.toLowerCase().replace("_", "-").split("-")[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as AnalysisLocale)
    : DEFAULT_ANALYSIS_LOCALE;
};

interface LocaleStrings {
  // Appended to the system prompt: the analytical method is identical, only
  // the output language changes.
  languageRule: string;
  searchNote: string;
  technicalNote: string;
  fallbackNote: string;
  schemaInstruction: (schema: string) => string;
  userMessage: (parts: { pair: string; nowUtc: string; note: string; sections: string; schema: string }) => string;
  disclaimer: string;
  // Substring that identifies the disclaimer already being present, so it is
  // not appended twice when the model followed the instruction.
  disclaimerMarker: string;
  fallbackWarning: string;
  // Shown when an account without a subscription asks for an analysis
  subscriptionRequired: string;
  // Shown when the plan would have been "enter now" but the market is shut,
  // so there is no "now" to enter at
  marketClosed: string;
  // Put in the prompt when the calendar WAS consulted and had nothing inside
  // the plan's horizon. Without it, "checked and clear" and "never checked"
  // reach the model as the same empty space.
  calendarClear: (hours: number) => string;
  // Put in the prompt when the calendar could not be read at all
  calendarUnavailable: string;
  // Shown when a plan was downgraded to WAIT because the market would never
  // have reached its entry (see entry.ts)
  entryRejected: (parts: {
    rejection: string;
    signal: string;
    distanceAtr: number | null;
    stopAtr: number | null;
    riskReward: number | null;
    // Why moving the entry to the market did not save the plan either
    repairRejection: string | null;
  }) => string;
  // Shown when the entry was moved to the market price because the model's
  // pullback entry would not have been filled
  entryRepaired: (parts: { signal: string; originalEntry: string; entry: string }) => string;
  // Shown when an entry inside the "at market" band was pulled onto the
  // market price so that it is entered, and judged, as a market order
  entrySnapped: (parts: { originalEntry: string; entry: string }) => string;
  // Shown when that pull was declined because the plan breaks at the market
  // price: the entry stays a few pips off and may not be reached
  entrySnapDeclined: (parts: { entry: string; price: string; reason: string }) => string;
  // Shown when the same direction on the same pair is already open from an
  // earlier plan: another one is the same bet, not a new one
  openSameDirection: (parts: { count: number; signal: string; hours: number }) => string;
}

const STRINGS: Record<AnalysisLocale, LocaleStrings> = {
  ja: {
    languageRule:
      "- analysis・thesis・key_factors・warnings などの文章は日本語で書く（market_context_detail の値は英語の定型語でよい）。",
    searchNote:
      "分析モード: full — まずweb検索で本日の経済指標・金融政策・当該通貨の材料を確認し、fundamental_score とファンダ要因を分析に統合してください。検索は2回まで。",
    technicalNote:
      "分析モード: technical_only — テクニカルのみで判断し、fundamental_score は50、ファンダ要因には言及しないでください。",
    fallbackNote:
      "分析モード: technical_fallback — ニュース検索が利用できないため、テクニカルのみで判断し、fundamental_score は50、ファンダ要因には言及しないでください。",
    schemaInstruction: (schema) =>
      `\n\n最終回答は<json>タグ内に、次のJSON Schemaに厳密に従ったJSONのみを出力してください。キー名とenum値は英語のまま一字一句一致させ、required のフィールドは全て含めること。スキーマ外のキーは出力しないこと。\n${schema}`,
    userMessage: ({ pair, nowUtc, note, sections, schema }) =>
      `通貨ペア: ${pair}\n現在時刻(UTC): ${nowUtc}\n${note}\n\n${sections}\n\n上記のマルチタイムフレームデータを手順1-6に沿って分析し、トレードプランを出力してください。${schema}`,
    disclaimer: "この分析は参考情報です。投資判断は自己責任で行ってください",
    disclaimerMarker: "自己責任",
    fallbackWarning: "ニュース検索が利用できなかったため、テクニカルのみで判断しています",
    subscriptionRequired: "分析機能は有料プラン専用です。プランに申し込むとご利用いただけます。",
    marketClosed: "為替市場が閉まっているため、見送り（WAIT）にしました。このアプリのプランは「今の値段で入る」前提なので、開いていない時間に出すと、週明けの窓を含んだ架空の成績になります。",
    calendarClear: (hours) =>
      `経済指標カレンダー: 確認済み。今後${hours}時間以内に、この通貨ペアに影響するHigh/Mediumの発表予定はありません（カレンダーは今週分までしか公開されていないため、それより先は不明）。`,
    calendarUnavailable:
      "経済指標カレンダー: 取得できませんでした。予定の有無は不明として扱い、指標が無いことを前提にしたプランを組まないこと。",
    entryRejected: ({ rejection, signal, distanceAtr, stopAtr, riskReward, repairRejection }) => {
      const head = `AIの判断は ${signal} でしたが、`;
      const tail = "ため見送り（WAIT）に変更しました";
      const repair = repairRejection === "poor_rr"
        ? "。現在値で入り直してもリスクリワードが成立しません"
        : repairRejection === "stop_too_tight"
          ? "。現在値で入り直すと損切りが近すぎます"
          : "";
      switch (rejection) {
        case "too_far":
          return `${head}エントリー価格が現在値から離れすぎており（ATRの${distanceAtr ?? "?"}倍）、約定しない可能性が高い${tail}${repair}`;
        case "should_be_market":
          return `${head}トレンドが継続している場面で「戻りを待つ指値」になっており、約定しない可能性が高い${tail}${repair}`;
        case "stop_too_tight":
          return `${head}損切りが現在値に近すぎ（ATRの${stopAtr ?? "?"}倍）、ノイズで刈られる可能性が高い${tail}`;
        case "poor_rr":
          return `${head}このエントリーではリスクリワードが${riskReward ?? "?"}しかなく、割に合わない${tail}`;
        case "target_out_of_reach":
          return `${head}利確がリスクの${riskReward ?? "?"}倍と遠すぎ、期限内に届かず期限切れで終わる可能性が高い${tail}`;
        default:
          return `${head}エントリー・損切り・利確の水準に矛盾がある${tail}`;
      }
    },
    entryRepaired: ({ signal, originalEntry, entry }) =>
      `AIは ${originalEntry} への戻りを待つ ${signal} を提案しましたが、トレンド継続中に戻りを待つと約定しないため、エントリーを現在値 ${entry} の成行に修正しました（損切り・利確はそのまま）`,
    entrySnapped: ({ originalEntry, entry }) =>
      `エントリー ${originalEntry} は現在値とほぼ同じ水準のため、成行として現在値 ${entry} に揃えました（数pipsの待ちで約定を逃さないため）`,
    entrySnapDeclined: ({ entry, price, reason }) =>
      `エントリー ${entry} は現在値 ${price} とほぼ同水準ですが、現在値に揃えると${reason === "stop_too_tight" ? "損切りが近すぎる" : reason === "poor_rr" ? "リスクリワードが崩れる" : "プランが成立しない"}ため指値のまま公開します。数pipsの差で未約定になる可能性があります`,
    openSameDirection: ({ count, signal, hours }) =>
      `直近${hours}時間以内に同じ方向（${signal}）のプランが${count}件進行中です。同じ局面への重複エントリーはリスクが積み上がるため、既存ポジションの扱いを決めてから判断してください`,
  },
  en: {
    languageRule:
      "- Write analysis, thesis, key_factors and warnings in English (market_context_detail values stay the fixed English terms).",
    searchNote:
      "Mode: full — first use web search to check today's economic releases, monetary policy and any news moving this pair, then fold that into fundamental_score and the analysis. At most 2 searches.",
    technicalNote:
      "Mode: technical_only — judge on the technicals alone, set fundamental_score to 50, and do not refer to fundamentals.",
    fallbackNote:
      "Mode: technical_fallback — news search is unavailable, so judge on the technicals alone, set fundamental_score to 50, and do not refer to fundamentals.",
    schemaInstruction: (schema) =>
      `\n\nReturn your final answer inside <json> tags as JSON only, strictly following this JSON Schema. Keep key names and enum values exactly as written, include every required field, and output no keys outside the schema.\n${schema}`,
    userMessage: ({ pair, nowUtc, note, sections, schema }) =>
      `Currency pair: ${pair}\nCurrent time (UTC): ${nowUtc}\n${note}\n\n${sections}\n\nAnalyse the multi-timeframe data above following steps 1-6 and output the trade plan.${schema}`,
    disclaimer: "This analysis is reference information. Trading decisions are your own responsibility.",
    disclaimerMarker: "your own responsibility",
    fallbackWarning: "News search was unavailable, so this call is based on technicals alone.",
    subscriptionRequired: "Analysis is available on a paid plan. Subscribe to start using it.",
    marketClosed: "The market is shut, so this is a WAIT. Every plan here is entered at the price on screen, and one written while the market is closed would be judged by filling at the Monday reopen — across the gap, as a trade nobody could have taken.",
    calendarClear: (hours) =>
      `Economic calendar: checked. Nothing High or Medium impact is scheduled for this pair in the next ${hours} hours. (Only the current week is published, so anything beyond that is unknown.)`,
    calendarUnavailable:
      "Economic calendar: could not be read. Treat the schedule as unknown and do not build a plan that assumes no release is due.",
    entryRejected: ({ rejection, signal, distanceAtr, stopAtr, riskReward, repairRejection }) => {
      const head = `The model called ${signal}, but `;
      const tail = ", so this was downgraded to WAIT.";
      const repair = repairRejection === "poor_rr"
        ? " Entering at the market instead would not pay either."
        : repairRejection === "stop_too_tight"
          ? " Entering at the market instead would leave the stop too close."
          : "";
      switch (rejection) {
        case "too_far":
          return `${head}the entry sits too far from the market (${distanceAtr ?? "?"}× ATR) to be filled${tail}${repair}`;
        case "should_be_market":
          return `${head}it waits for a pullback while the trend is still running, which would not have filled${tail}${repair}`;
        case "stop_too_tight":
          return `${head}the stop sits inside the noise (${stopAtr ?? "?"}× ATR from the entry) and would be hit by it${tail}`;
        case "poor_rr":
          return `${head}at that entry the risk/reward is only ${riskReward ?? "?"}, which does not pay${tail}`;
        case "target_out_of_reach":
          return `${head}the target sits ${riskReward ?? "?"}x the risk away — far enough that the plan is likelier to expire than to resolve${tail}`;
        default:
          return `${head}the entry, stop and target contradict each other${tail}`;
      }
    },
    entryRepaired: ({ signal, originalEntry, entry }) =>
      `The model proposed a ${signal} on a pullback to ${originalEntry}; a pullback does not come in a running trend, so the entry was moved to the market at ${entry} (stop and targets unchanged).`,
    entrySnapped: ({ originalEntry, entry }) =>
      `The entry at ${originalEntry} was effectively at the market, so it was aligned to the market price ${entry} rather than waiting a few pips for a fill.`,
    entrySnapDeclined: ({ entry, price, reason }) =>
      `The entry at ${entry} is effectively at the market (${price}), but moving it there would ${reason === "stop_too_tight" ? "leave the stop too close" : reason === "poor_rr" ? "break the risk/reward" : "break the plan"}, so it stays as a limit and may not be reached by a few pips.`,
    openSameDirection: ({ count, signal, hours }) =>
      `${count} ${signal} plan${count === 1 ? "" : "s"} on this pair from the last ${hours} hours ${count === 1 ? "is" : "are"} still open. Another entry in the same direction stacks the same bet; decide what to do with the open position first.`,
  },
};

export const stringsFor = (locale: AnalysisLocale): LocaleStrings => STRINGS[locale];

// The disclaimer is a compliance requirement, so it is added server-side rather
// than left to the model — including when the model wrote its own wording.
export const withDisclaimer = (warnings: string[], locale: AnalysisLocale): string[] => {
  const { disclaimer, disclaimerMarker } = STRINGS[locale];
  const present = warnings.some((w) => w.toLowerCase().includes(disclaimerMarker.toLowerCase()));
  return present ? warnings : [...warnings, disclaimer];
};
