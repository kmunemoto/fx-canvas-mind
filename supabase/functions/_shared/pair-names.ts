// #211 (the owner, 2026-10-07: 「メールの…通貨のペアの部分をこの場合だとユーロ/円と日本語で表示して」, with
// 楽天FX's pair picker beside it): each pair as the owner's broker (楽天FX) labels it in its own picker. The
// Japanese emails show these; the app's picker has the same list (src/lib/i18n/ja.ts live.pairShort, #153/#154 —
// src/test/pair-names.test.ts keeps the two the same). A pair not in it is shown as its code.
export const PAIR_JA: Readonly<Record<string, string>> = {
  "USD/JPY": "ドル/円", "EUR/JPY": "ユーロ/円", "GBP/JPY": "ポンド/円", "AUD/JPY": "豪ドル/円",
  "EUR/USD": "ユーロ/ドル", "GBP/USD": "ポンド/ドル", "AUD/USD": "豪ドル/ドル", "MXN/JPY": "メキシコペソ/円",
  "NZD/JPY": "NZドル/円", "ZAR/JPY": "ランド/円", "CAD/JPY": "カナダドル/円", "CHF/JPY": "スイス/円",
  "TRY/JPY": "トルコリラ/円", "NZD/USD": "NZドル/ドル", "EUR/GBP": "ユーロ/ポンド", "AUD/NZD": "豪ドル/NZドル",
  "HUF/JPY": "フォリント/円", "SEK/JPY": "Sクローナ/円", "NOK/SEK": "Nクローネ/Sクローナ", "AUD/CAD": "豪ドル/カナダドル",
  "NZD/CAD": "NZドル/カナダドル", "XAU/USD": "金", "USD/CAD": "ドル/カナダドル", "USD/CHF": "ドル/スイス",
  "GBP/CHF": "ポンド/スイス", "EUR/CHF": "ユーロ/スイス", "AUD/CHF": "豪ドル/スイス", "NZD/CHF": "NZドル/スイス",
  "HKD/JPY": "香港ドル/円", "SGD/JPY": "SGドル/円", "NOK/JPY": "Nクローネ/円", "EUR/AUD": "ユーロ/豪ドル",
  "GBP/AUD": "ポンド/豪ドル", "PLN/JPY": "ズロチ/円", "CZK/JPY": "チェココルナ/円", "CAD/CHF": "カナダドル/スイス",
  "USD/HKD": "ドル/香港ドル",
};

export const pairJa = (pair: string): string => PAIR_JA[pair] ?? pair;
