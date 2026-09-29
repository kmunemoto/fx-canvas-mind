import type { Dict } from "./ja";

// Typed as Dict, so a key added to ja.ts fails the build here until it is
// translated. Add a new locale by copying this file and changing the values —
// the compiler lists everything that is missing.
export const en: Dict = {
  localeName: "English",
  intlLocale: "en-US",

  common: {
    appName: "Sextant",
    cancel: "Cancel",
    close: "Close",
    processing: "Processing…",
    error: "Error",
    language: "Language",
    dash: "—",
  },

  header: {
    upgrade: "Upgrade plan",
    changePlan: "Change plan",
    cancelPending: "(cancelling)",
    signOut: "Sign out",
    settings: "Settings",
  },

  control: {
    intervals: { "1min": "1m", "5min": "5m", "15min": "15m", "1h": "1H", "4h": "4H", "1day": "1D" },
    // #111: what the spread alone takes (measured, §8.21)
    cost: (tf: string, share: number | null) =>
      share === null
        ? tf === "1min"
          ? "On 1-minute charts the spread weighs most (share not measured)."
          : "On daily charts the spread weighs least (not measured)."
        : `On ${tf} charts the spread alone costs about ${Math.round(share * 100)}% of the stop every trade (measured).${share >= 0.1 ? " 4-hour and daily charts cost less." : ""}`,
    analyze: "Analyze",
    analyzing: "Analyzing…",
    stages: {
      idle: "",
      fetching: "Fetching data…",
      analyzing: "AI analysis…",
      generating_judgment: "Forming judgement…",
    },
    remainingToday: (n: number) => `Remaining today: ${n}`,
    includeFundamental: "Factor in economic news and data",
    subscribeToAnalyze: "Subscribe to analyze",
    paidFeature: "Analysis is a paid feature",
    fundamentalHelp: "Details",
    fundamentalOn: "ON — latest news and economic data are folded in (more accurate, slower)",
    fundamentalOff: "OFF — technical indicators only (fast and simple)",
    tooltipOn: "ON: latest news and economic data are folded in (more accurate, slower)",
    tooltipOff: "OFF: technical indicators only (fast and simple)",
  },

  stages: {
    banner: "SIGNAL ANALYSIS IN PROGRESS",
    caption: "Reading structure, levels and trend across timeframes…",
  },

  direction: {
    label: "DIRECTION",
    BUY: { word: "LONG", gloss: "Buy" },
    SELL: { word: "SHORT", gloss: "Sell" },
    WAIT: { word: "WAIT", gloss: "Stand aside" },
    confidence: "Confidence",
    // The ring is drawn on 0..100, a scale this system has never filled. The
    // observed range sits under the number so 66 is not read as "66 out of a
    // scale that could have said 90". Built from confidence_calibration()'s
    // span.traded, never written as a constant (#68).
    confidenceObserved: (lo: number, hi: number, n: number) =>
      `In your record this number has landed between ${lo} and ${hi} (${n} traded)`,
  },

  result: {
    tradePlan: "Trade plan",
    entry: "Entry",
    stopLoss: "Stop loss",
    riskReward: "R:R",
    tp1: "Take profit 1",
    tp2: "Take profit 2",
    tp3: "Take profit 3",
    // (#128: amount carries its unit — "62 pips", or "$12.34" for gold)
    distance: (amount: string, atr: number | null) =>
      atr === null ? amount : `${amount} · ${atr}× ATR`,
    // #111: sizing help without a balance: the loss per 10,000 units
    lossPer10k: (money: string) => `${money} lost per 10,000 units if stopped`,
    // #128: gold per ounce
    lossPerOz: (money: string) => `${money} lost per ounce if stopped`,
    evidenceNotGold: "This test was run on currency pairs. It has not been run on gold (XAU/USD).",
    // See the Japanese copy for why the period is declared in bars.
    horizon: {
      label: "Target period",
      bars: (tfLabel: string, bars: number, span: string) =>
        `${bars} bars of the ${tfLabel} chart (${span} of open market)`,
      span: {
        minutes: (n: number) => `about ${n} minutes`,
        hours: (n: number) => `about ${n} hours`,
        days: (n: number) => `about ${n} days`,
      },
      endsAt: (when: string) => `to about ${when}`,
      notACutoff: "The bar count is not a deadline — scoring continues until the plan settles.",
      tpRoles: "Take profit 1 is the level aimed at inside this period. Take profit 2 and 3 are extensions beyond it and are not expected to be reached within it.",
      absent: "No target period was recorded for this analysis.",
      // See the Japanese copy: 1min only (#98).
      staleness: (time: string, seconds: number) =>
        `Priced at ${time} (about ${seconds}s before this was shown). On a one-minute chart the market has moved since — check the gap between the entry and the live price before acting.`,
    },
    // See the Japanese copy: the reader's own same-direction losing run.
    streak: {
      warn: (word: string, n: number, from: string, to: string) =>
        `In your record the last ${n} ${word} calls all lost (${from} – ${to})`,
      note: "The analyst does not see this run; this plan was issued independently of it.",
    },
    evidence: "Evidence",
    showAll: (n: number) => `Show all (${n})`,
    showLess: "Show fewer",
    ratings: {
      label: "Model's self-ratings",
      technical: "Technical",
      fundamental: "Fundamental",
      risk: "Risk",
      volatility: "Volatility",
    },
    inferenceChip: "inferred",
    inferenceNote: "This app sees no order book, volume, open interest or executions. Anything marked inferred is a reading of price action, not something observed.",
    // The other side's case (#96): written by the model before it decides.
    counterCase: {
      title: "The other side",
      who: (word: string, gloss: string) => `${word} (${gloss}):`,
      trigger: "What would flip it",
      note: "The strongest case the model could make for the opposite direction (optional from v68, and not used to decide the signal).",
    },
    detail: "Full analysis",
    marketContext: "Market context and levels",
    warnings: "Warnings",
    waitReason: {
      label: "Why it is a WAIT",
      ownLowConfidence: "The model's own confidence was below the floor we publish at, so no entry, stop or targets were issued",
      refused: (word: string, gloss: string) => `The model's ${word} (${gloss}) was refused server-side and published as WAIT`,
      atrMultiple: (n: number) => `${n}× ATR`,
      confidence: (score: number, floor: number) => `confidence ${score}, floor ${floor}`,
      structure: (tf: string, up: boolean, level: string | null) =>
        level === null
          ? `${tf} points ${up ? "up" : "down"} (last two swings)`
          : `${tf} closed ${up ? "up" : "down"} through ${level} and stayed there`,
      // The turn count that refused the plan and the threshold it was measured
      // against. `up` means the entry timeframe was turning UP (a SELL refused).
      costly: (jstHour: number, inside: number | null, outside: number | null) =>
        inside === null || outside === null
          ? `${jstHour}:00 JST`
          : `${jstHour}:00 JST · won ${inside}% in these hours, ${outside}% otherwise`,
      turn: (up: boolean, score: number, block: number) =>
        `${score} facts that the entry timeframe is turning ${up ? "up" : "down"} (threshold ${block})`,
    },
    riskLevels: { LOW: "Low", MEDIUM: "Medium", HIGH: "High" },
    sentiments: { BULLISH: "Bullish", NEUTRAL: "Neutral", BEARISH: "Bearish" },
    volatilityLevels: { Low: "Low", Medium: "Medium", High: "High" },
  },

  context: {
    mode: "Market mode",
    structure: "Structure",
    smartMoney: "Smart money",
    strength: "Strength",
    session: "Session",
    direction: "Direction",
    continuity: "Continuity",
    summary: "Summary",
    levels: "Key technical levels",
    resistance: "Resistance",
    support: "Support",
    stopHunt: "Stop hunt zone",
  },

  disclosure: {
    open: "Show",
    close: "Hide",
  },

  chart: {
    title: "Price chart",
    recentBars: (pair: string, n: number) => `${pair} · last ${n} bars`,
    ariaLabel: (pair: string) => `${pair} candlestick chart with trade plan levels`,
    citedMark: "(AI)",
    legend: "dashed = measured by the server / dotted = named by the model / band = the cloud at price",
    hiddenLevels: (n: number) => `${n} outside the visible range`,
    // #99: the bounce marks and the trend lines
    signalLegend: "BUY · SELL = a closed bar where RSI(9) came back from 25/75 with the SAR on the same side (✓ won ✗ lost … open). Dotted = that signal's stop (red) and target (green). Dots = Parabolic SAR (green under price · red over price)",
    gainzLegend: "Outlined GA = the GA-style signal (engulfing, large body, RSI 40, against 5 bars ago; stop 1 ATR, target 2× the stop)",
    rsiLabel: "RSI(9)",
    trend: { lows: "lows", highs: "highs" },
    // The label on the flag: the side, then how it came out
    outcomeMark: { win: "✓", loss: "✗", ambiguous: "?", expired: "–", open: "…" },
    exitMark: { win: "TP", loss: "SL", ambiguous: "?", expired: "END", open: "" } as Record<string, string>,
    positionLegend: (boxes: boolean, cloud: boolean): string =>
      [
        boxes ? "Box = the signal's position (green: entry to target, red: entry to stop) up to the bar that settled it. Dashed = from the entry to where it ended (the price now while open), × = settled (TP target · SL stop · END neither within 48 bars). Vertical line = the signal's bar" : "",
        cloud ? "Band = from the Parabolic SAR away from price by 1 ATR (green under price · red over price)" : "",
      ].filter((x) => x !== "").join(". "),
    zoomIn: "Zoom in (fewer bars)",
    zoomOut: "Zoom out (more bars)",
    zoomReset: "Show all bars",
    fullscreen: "Full screen",
    exitFullscreen: "Close full screen",
    fullscreenOn: "The chart is open in full screen",
    zoomShown: (shown: number, total: number) => `${shown}/${total} bars`,
    zoomHint: "Pinch or wheel to zoom, drag sideways to go back in time, ↺ for all bars. The price scale fits the bars on screen",
    indicators: "Indicators",
    stoch: {
      name: "Stoch",
      settings: "Stochastic settings",
      kLength: "%K length",
      kSmoothing: "%K smoothing",
      dSmoothing: "%D smoothing",
      reset: "Back to the defaults (14, 1, 3)",
      note: "Calculated as TradingView's Stochastic (%K = where the close sits in the recent high–low range, %D = its moving average, 80/20). #132's first-period best (21, 5, 3; 70/30) did worse on the second period (28.7% won; this setting 29.1%), so these were put back. Shown only: no signal is judged on it.",
    },
    // #140: the indicators, a paid feature
    lockedHint: "Available with the Light plan",
    lockedNote: "The indicators marked 🔒 come with the Light plan (¥2,980 a month). The signals, RSI and the Parabolic SAR are free.",
    // #135: Bollinger %b and RCI, TradingView's built-ins
    pctB: {
      name: (length: number, mult: number) => `BB %b ${length} ${mult}`,
      note: "Bollinger Bands %b (TradingView's built-in, with its calculation and defaults): where the close sits in the band of the 20-bar average ± 2 standard deviations. 1 = the upper band, 0.5 = the average, 0 = the lower band; outside the band it goes above 1 or below 0. Like the stochastic, a gauge of whether the price is high or low in its recent range: above 1 is not a reversal signal (TradingView's help also says that in a strong trend the price \"walks the band\"). Shown only: no signal is judged on it.",
    },
    rci: {
      name: (length: number) => `RCI ${length}`,
      note: "RCI (Rank Correlation Index; TradingView's built-in, with its calculation and defaults): the correlation between the last 10 closes' ranks and their order in time, × 100. +100 = each close higher than the one before, −100 = each lower, near 0 = no consistent direction. The yellow line is its 14-bar average. A gauge of how steadily the price has moved, not where it is: past ±80 is not a reversal signal. Shown only: no signal is judged on it.",
    },
    settingsTitle: "Chart settings",
    background: "Background",
    themeNames: { dark: "Dark", light: "White" },
    themeLight: "White background",
    themeDark: "Dark background",
    zoomTitle: "Range",
    closeSheet: "Close",
    vsPrevBar: "vs previous bar",
    priceNow: "Price now",
    overlayNames: {
      signals: "Signals",
      positions: "Position boxes",
      sarCloud: "SAR band",
      sarDots: "Parabolic SAR",
      trendLines: "Swing lines",
      kalman: (atr: number, factor: number) => `SPECTRA-style ${atr} ${factor}`,
      supertrend: (period: number, mult: number) => `SuperTrend ${period} ${mult}`,
      utBot: (key: number, atr: number) => `UT Bot ${key} ${atr}`,
      fvgProfile: "FVG Crossfire + Volume Profile",
      zoneShift: (length: number) => `Zone Shift ${length}`,
      dow: "Dow theory",
      gainzPro: "Pro-style score",
      ema: (length: number) => `EMA ${length}`,
      // #145
      qTrend: (period: number, atr: number, mult: number) => `Q-Trend ${period} ${atr} ${mult}`,
      qtBlsh: "Q-Trend × BLSH (triple confirmation)",
      // #150
      autoTrend: "Trend lines",
      maCross: "GC / DC (EMA 50 × 200)",
      ichimoku: (conv: number, base: number, span2: number) => `Ichimoku ${conv} ${base} ${span2}`,
      // #151
      ultra: (gold: boolean): string => (gold ? "ULTRA (RSI 14, SL $10, TP $5/10/15)" : "ULTRA (RSI 14, SL 30, TP 5/10/15 pips)"),
    },
    // #131: the Pro-style score
    gainzProTitle: (side: "BUY" | "SELL", score: number, rank: number) =>
      `Pro-style ${side === "BUY" ? "buy" : "sell"} · score ${score}/100 (above ${rank}% of the last 50 scores)`,
    gainzProNote: (bars: number | null, status: "loading" | "ready" | "error") =>
      "Pro-style score: this app's own formulas for what GainzAlgo publishes about the Pro configuration of its Suite (pattern, volatility, momentum and trend turned into percentile-ranked scores, a signal above a threshold set by recent conditions). GainzAlgo's code is not public, so its signals will differ. " +
      "On a down candle then an up candle (a sell: the mirror), ① the candle's shape (where it closed × its body's share of the range), ② RSI(14)'s acceleration, ③ its range expansion (true range ÷ the ATR(14) before it) and ④ EMA(50)'s 10-bar slope (for a buy, the more upward the higher) are each ranked among their last 50 values and averaged; a P marks a bar whose score is in the top 5% of the last 50 (under the candle for a buy, over it for a sell). " +
      (status === "loading"
        ? "Loading the earlier candles it needs (about 160). "
        : status === "error"
          ? "Not drawn: the earlier candles could not be read (tried again on the next candle). "
          : `Computed over ${bars ?? 0} candles. `) +
      "The ranking window was searched in #132: 50 won most often on the first period (2024-01 to 2025-06; it was 100). On the second period (2025-07 on; 11 pairs, 15m/1h/4h, stop 1 ATR, target 2x, spread paid): 43,752 trades, 29.5% won (break-even 33.3%), −0.114R each (with 100: 43,665, 29.3%, −0.118R) — no different from entering at random. " +
      "Shown only: no signal or email uses it.",
    // #129: Dow theory — the timeframes' short names, its levels and marks
    dowTfShort: { "4h": "4H", "1h": "1H", "15min": "15M", "5min": "5M" } as Record<string, string>,
    dowLevel: { pushLow: "Pullback low", pullHigh: "Rally high", high: "High", low: "Low" },
    dowBroken: { pushLow: " (broken once)", pullHigh: " (broken once)" },
    dowBreak1: "①",
    dowConfirm: "Confirmed",
    dowCancel: "Off",
    dowEventTitle: (kind: "update" | "break1" | "confirm" | "cancel", dir: "up" | "down", level: string) =>
      kind === "break1"
        ? `First break: a close ${dir === "down" ? "below the pullback low" : "above the rally high"} ${level} (a sign of a turn, not confirmed)`
        : kind === "confirm"
          ? `Second break: the turn ${dir === "down" ? "down" : "up"} is confirmed (a close ${dir === "down" ? "below" : "above"} ${level})`
          : kind === "cancel"
            ? `Off: before it was confirmed, a close beyond the old ${dir === "up" ? "high" : "low"} ${level} (the ${dir === "up" ? "uptrend" : "downtrend"} goes on)`
            : `New ${dir === "up" ? "high" : "low"} ${level}`,
    dowNote: (status: "loading" | "ready" | "error", hasCurrent: boolean, higher: string[]) =>
      "Dow theory (built from what is said in an Instagram video by The5ers Japan presenting such an indicator; its author's code is not published and the full interview could not be read, so its readings may differ): " +
      "swing highs and lows = a high (low) above (below) the 4 candles either side (known 4 candles later, never redrawn). HH = higher high, HL = higher low, LH = lower high, LL = lower low; the swings are joined by a thin line. " +
      "A close above the last swing high = uptrend (making new highs), and the swing low before it is the pullback low (green line); a downtrend mirrors it with the rally high (red line). " +
      "A close below the pullback low = ① (the first break: a sign of a turn). A swing low after it, a lower swing high, then a close below that low = Confirmed (the second break confirms the turn down — the owner's chosen reading of the video's \"touch it once more and it is confirmed\"). A close above the old uptrend's high before that = Off. A turn up from a downtrend mirrors it. " +
      (higher.length > 0 ? `Dashed = the higher timeframes' (${higher.join(", ")}) pullback low or rally high (thicker) and their last swing high and low. ` : "") +
      (hasCurrent ? "" : "This timeframe is not read (4h, 1h, 15m and 5m only). ") +
      (status === "loading" ? "Loading. " : status === "error" ? "Could not be read (tried again in a minute). " : "") +
      "Judged on closed candles' closes only. " +
      "The swing width was searched in #132: 4 candles either side won most often on the first period (2024-01 to 2025-06; it was 5). On the second period (2025-07 on; 11 pairs, 15m/1h/4h, stop 1 ATR, target 2x, spread paid), entering at the confirmation (the second break): 2,460 trades, 29.4% won (break-even 33.3%), −0.117R each (with 5: 2,059, 28.6%, −0.139R) — no different from entering at random beyond noise. Measured with 5, entering at the first break or at each new high or low, or keeping to the higher timeframe's direction, did no better. " +
      "Shown only: no signal or email uses it.",
    // #124
    zoneShiftNote: (bars: number | null, status: "loading" | "ready" | "error") =>
      "Zone Shift (a port of ChartPrime's open-source code, MPL 2.0): the midline = the average of EMA(100) and HMA(60) (dotted), the outer lines = the midline ± the 200-candle average of high − low. " +
      "An uptrend when a closed candle's low crosses above the top line (candles turn lime), a downtrend when its high crosses below the bottom line (blue). The low (high) of the candle the trend began on is drawn as a dotted level; ◆ = the close or wick crossing back over it in the trend's direction (a retest, at least 6 candles after the last ◆). " +
      (status === "loading"
        ? "Loading the earlier candles its 200-candle average needs. "
        : status === "error"
          ? "Not drawn: the earlier candles could not be read (tried again on the next candle). "
          : `Computed over ${bars ?? 0} candles (including those before the screen). `) +
      "On past data (11 pairs, 15m/1h/4h, stop 1 ATR, target 2x, spread paid, 2025-07 on): entering at its turns, 5,687 trades, 29.7% won (break-even 33.3%), −0.109R each; at its ◆, 9,028 trades, 30.4%, −0.085R. Neither differs from entering at random beyond noise (1h a little better, still about zero). #132's first-period best (Length 75, a retest gap of 10) did worse on the second period (29.2% won; this setting 29.9%), so these were put back. " +
      "Shown only: no signal or email uses it.",
    // #123: the two Flux Charts ports, shown as one indicator
    fvgProfileNote: (bars: number) =>
      "FVG Crossfire + Weighted Volume Profile (both ports of Flux Charts' open-source code, MPL 2.0, shown together as one). " +
      "[Boxes] only where a new fair value gap (at least 0.05% of price) printed over an unfilled opposite one. Green = bullish, red = bearish (the newer gap's side). Another opposite gap over it flips it and narrows it to the overlap. ★ = times formed or flipped, ▲▼ = a candle back in the zone after leaving it (a retest), the faint wedge = the gap it grew from, a faint box = finished by a close through its far side. Judged on closed candles. Only the candles on the chart are searched (the live chart's 120), not the original's 3,000, so there are fewer zones. " +
      `[Bars at the left] the price range of the newest ${bars} candles${bars < 200 ? " (all the chart has; the original reads 200)" : ""} in 30 rows, each as long as the number of candles that traded through it — green for up candles, red for down, longest = most. The yellow line = the fullest row (the point of control). The original weighs each candle by its volume; GMO's FX candles have none, so here every candle counts as 1: the bars show where price spent its time, not volume. Drawn under the candles and see-through (the original's boxes are opaque, on top). ` +
      "The smallest gap (0.05% of price) is from #132: every setting was tried and this one's retest arrows (▲▼) won most often on the first period (2024-01 to 2025-06; the original's default is 0, every gap; the 3-bar fill delay stayed, as 2 and 3 gave the same results). On the second period (2025-07 on; 11 pairs, 15m/1h/4h, stop 1 ATR, target 2x, spread paid): 5,287 trades, 31.4% won (break-even 33.3%), −0.057R each (the old setting: 22,085, 29.0%, −0.128R); +0.042R over entering at random, within noise (95%: −0.005 to +0.089R). " +
      "Shown only: no signal or email uses it.",
    // #145: the two indicators of the owner's video, and its combination
    qTrendNote:
      "Q-Trend (a port of the code tarasenko_ published on TradingView, MPL 2.0; the video's default settings: period 200, ATR 14, multiplier 1): a trend line that starts at the middle of the highest and lowest close of the last 200 bars. A close over line + ATR(14) lifts the line by one ATR and is a BUY; under line − ATR lowers it and is a SELL (only the first of a run). A buy whose bar, or one of the four before, opened in the bottom eighth of the 200-bar range is STRONG (a sell: the top eighth). The line and the candles take the last signal's colour (green after a buy, red otherwise; UT Bot's colours win when it is on). Judged on closed bars. The line is built step by step from the bar it starts at, so here it starts at a fixed time among the bars read before the chart (every 200 bars' time): opened again, the chart shows the same past labels, which change only when that time moves on (about once every 8 days on the 1-hour chart). TradingView starts elsewhere, so the line can sit a little apart. Stop and targets: Q-Trend has none of its own, so it takes ULTRA's numbers (#156: entered at the bar's close, TP1 5, TP2 10, TP3 15 — pips on a pair with a stop of 30 (#166), dollars on gold with a stop of 10). The newest signal gets dotted lines (green entry, red stop, blue targets) and, while it is open, \"Q\"-marked price tags at the right edge (laid out with ULTRA's so they never cover each other). As ULTRA's, each is followed to its stop or TP3, and a bar reaching both counts the stop. Measured on GMO's FX pairs (January 2024–September 2026, spread paid; the signals the emails send, entered at their bar's close), TP1 came before the stop 58.9% of the time on 5-minute bars, 59.5% on 15-minute, 61.9% on 1-hour, 61.4% on 4-hour and 35.9% on daily (breaking even needs more than 67%). Closing all of it at TP1 or the stop lost 2.10, 1.92, 1.46, 1.35 and 9.11 pips a trade on average (the daily bars close at 21:00 UTC, when the spread is widest). Gold and the pairs read from Twelve Data were not measured. The email alerts (the charts chosen in Settings) use it too and carry the same stop and targets.",
    qtBlshNote:
      "Q-Trend × BLSH (the video's \"triple confirmation\"): 3✓ BUY / 3✓ SELL on the first closed bar where ① Q-Trend's last signal (a buy, a sell), ② the BLSH line's colour (yellow for a buy, blue for a sell) and ③ the BLSH area's colour (green for a buy, red for a sell) agree. As the video does, it marks the bar where the last of the three comes in after the signal (\"as soon as the histogram turned red\"), and a signal that never gets all three before the next one is the video's \"fake entry\": no mark. Once per Q-Trend signal. The video's rule written as it is said, not measured on past data (the single signals this app has measured did no better than entering at random after the spread). Shown only: no signal or email uses it.",
    qtBlshTitle: (side: "BUY" | "SELL") => `Q-Trend × BLSH triple confirmation: ${side === "BUY" ? "buy" : "sell"}`,
    blsh: {
      name: "BLSH",
      note: "BLSH (Buy Low Sell High Composite, a port of the code zacmcc published on TradingView): RSI(14) (25–75), EMA(5) − EMA(35) and the MACD histogram (both within ±2 × ATR(9)) and MFI(14) (25–75), each scaled to −1…+1, summed and divided by 4: an area green above 0, red at or under it. The line is the MACD signal line scaled the same way, yellow while MACD is at or over it and blue while under (the video's colours; the original's lime and red). Its author: \"buy when it's very red, sell when it's very green\". GMO's FX bars have no volume, so MFI counts each bar as one (a guide to the share of the last 14 bars' typical prices on bars that rose). The original's crossover dots are not drawn (the video shows none). Not measured on past data. Shown only: no signal or email uses it.",
    },
    // #150: the trend tools of the owner's note
    autoTrendNote:
      "Trend lines: rising, the line through the lows; falling, through the highs. Of the swings Dow theory reads (a bar higher or lower than the 4 on each side, known 4 bars later), the line through the latest two rising swing lows (green) and through the latest two falling swing highs (red), drawn on to the right. When a close goes clearly through one (a close, not a wick) it stops there, marked 'break': a sign the flow is changing. Judged on closed bars. Not measured on past data. Shown only: no signal or email uses it.",
    maCrossNote:
      "GC / DC: GC (golden cross) on the closed bar where EMA 50 crosses above EMA 200, DC (dead cross) where it crosses below; marked even when the lines are hidden. A crossing of averages, so it comes after the flow has turned. Not measured on past data. Shown only: no signal or email uses it.",
    ichimokuNote:
      "Ichimoku (as TradingView's built-in computes it, its defaults 9, 26, 52 and displacement 26): the conversion line (blue, the middle of the last 9 highs and lows), the base line (dark red, 26), the cloud of the leading spans (the average of the two lines, and the middle of 52) drawn 25 bars ahead (green while span 1 is on top, red otherwise), and the lagging span (green, the close drawn 25 bars back). The price over the cloud leans up, under it down, inside it neither; the chart's top left says which. This chart has no room to the right of its newest bar, so the cloud's part ahead of it is not drawn. Not measured on past data. Shown only: no signal or email uses it.",
    ichimokuSide: { above: "over the cloud (leaning up)", inside: "in the cloud", below: "under the cloud (leaning down)" } as Record<string, string>,
    trendBreak: { up: "break", down: "break" },
    // #151: the owner's video's ULTRA EN, rebuilt from what the video shows
    ultraNote:
      "ULTRA (the video's \"ULTRA EN\" by F-INVEST on TradingView, rebuilt from the settings and marks the video shows. It is invite-only and its author has no published script (it is handed out on Telegram), so its code cannot be read and its signals may differ): " +
      "Sell on the closed bar where RSI(14) crosses back under 70 from above, Buy where it crosses back over 30 from below (the video's settings: RSI 14, overbought 70, oversold 30, trade mode \"Trend-f...\". On the video's chart the Sell comes a little after a top and the Buy a little after a bottom, so this app reads it as entering once the stretch starts to turn). " +
      "Entered at that bar's close with a stop of 10 and targets of TP1 5, TP2 10, TP3 15 (the video's numbers: dollars on gold — in the video a sell at 4327.154 has its stop at 4337.154 and TP1 at 4322.154. On a currency pair the same numbers are pips: the video is gold only, and $10 taken as a price would be ten yen on USD/JPY; this is this app's choice). On a currency pair the stop is 30 pips, set from this app's own measurements (#166; gold keeps the video's $10). " +
      "★TP1 to ★TP3 on the bars that reached them, a small × where the stop came before TP1. The newest signal's box (green entry, red to the stop, blue to the targets; its prices in room left to the right of the newest bar while it is open, faint once it has ended) and the row above the chart: how many signals reached TP1, TP2, TP3 and the stop among the bars read, each as a share of the total (TP1 + stop); the win rate is TP1's share, counted as the video's table counts. " +
      "A bar that reaches both the stop and a target counts the stop; a stop after TP1 ends the trade and is not counted as a stop. Each signal is followed on its own to its stop or TP3. The video's MACD (off) and Heikin Ashi MACD sections are not built. " +
      "Against the video's \"80% win rate\" (on gold), measured here on GMO's FX pairs (January 2024–September 2026, spread paid; the signals the emails send, entered at their bar's close), TP1 came before the stop 61.0% of the time on 5-minute bars, 61.1% on 15-minute, 61.6% on 1-hour, 64.2% on 4-hour and 33.5% on daily. TP1 is half the stop's distance, so with no drift in price about 67% of random entries would reach TP1 before the stop, and paying the spread takes that lower. Closing all of it at TP1 or the stop lost 1.64, 1.51, 1.67, 0.82 and 10.00 pips a trade on average. Gold and the pairs read from Twelve Data were not measured. Closed bars only. The email alerts (the charts chosen in Settings) use it too.",
    ultraTable: { tp1: "TP1", tp2: "TP2", tp3: "TP3", sl: "SL", total: "TOTAL", winRate: "WIN RATE" },
    ultraTitle: (side: "BUY" | "SELL", entry: string, sl: string, tps: string[]): string =>
      `ULTRA ${side === "BUY" ? "buy" : "sell"}: entry ${entry}, stop ${sl}, TP1 ${tps[0]}, TP2 ${tps[1]}, TP3 ${tps[2]}`,
    ultraHit: (what: string, price: string): string => `ULTRA: ${what === "SL" ? "stop" : what} ${price} reached`,
    // #156: Q-Trend's newest signal with ULTRA's numbers
    qtPlanTitle: (side: "BUY" | "SELL", entry: string, sl: string, tps: string[]): string =>
      `Q-Trend ${side === "BUY" ? "buy" : "sell"} (ULTRA's stop and targets): entry ${entry}, stop ${sl}, TP1 ${tps[0]}, TP2 ${tps[1]}, TP3 ${tps[2]}`,
    maCrossTitle: (side: "GC" | "DC"): string => (side === "GC" ? "Golden cross (EMA 50 crossed above EMA 200)" : "Dead cross (EMA 50 crossed below EMA 200)"),
    macd: {
      name: (fast: number, slow: number, signal: number) => `MACD ${fast} ${slow} ${signal}`,
      note: "MACD (as TradingView's built-in computes it, its defaults 12, 26, 9): the blue line is EMA 12 − EMA 26, the orange line its 9-bar EMA (the signal), the bars their difference (the histogram: over 0 and growing dark green, shrinking light green; under 0 and falling dark red, rising light red). The line over 0 leans up; crossing above the signal is the momentum turning up. Shown only: no signal uses it.",
    },
    adx: {
      name: (di: number, adx: number) => `ADX ${di} ${adx}`,
      note: "ADX and DMI (as TradingView's built-in 'Directional Movement Index' computes it, its defaults 14, 14): the pink line is ADX (how strong the trend is, not its direction), blue +DI (the move up), orange −DI (the move down). ADX over 25 (dotted) is a trend being there: up while +DI is on top, down while −DI is. Under 25 is a sideways market. Shown only: no signal uses it.",
    },
    // #143
    emaNote: (bars: number | null, status: "loading" | "ready" | "error") =>
      "EMA 50 (orange) and EMA 200 (purple): exponential moving averages of the close (TradingView's arithmetic). A close above the line is an upward flow, below it a downward one. " +
      "#142 compared 31 indicators on past charts (11 pairs, 15min/1h/4h, 2024-01 to 2026-09): the flow across the chart's 120 bars (about 3–4 weeks on 4h) was read best by the close above or below EMA 50 (71.6% on the later period; the stochastic 68.3%), and a larger flow (about 2–3 months on 4h) by the 200-bar averages. " +
      "They read where the flow has been: over the next 48 bars the price went the reading's way about half the time. On 4h alone, the later period could not tell EMA 50 from the stochastic. " +
      (status === "loading"
        ? "Loading the bars before the chart's. "
        : status === "error"
          ? "Not shown: the bars before the chart's could not be read (tried again on the next bar). "
          : `Computed over ${bars ?? 0} bars (including those before the chart's). `) +
      "Shown only: no signal or email uses them.",
    // #136
    supertrendNote:
      "SuperTrend (a port of the code KivancOzbilgic published on TradingView): a line at the high–low midpoint ± 3 × ATR(10). While the trend is up the lower line shows (green), while down the upper one (red); the line only rises in an uptrend and only falls in a downtrend. When a close crosses the line on the other side the trend turns, marked with a dot and Buy / Sell on the line. The space between the line and the candles' average (open, high, low, close) is tinted. Judged on closed bars only, not drawn on the bar still forming. As its author says, it does not work in a sideways market. Not yet measured on past data (the SPECTRA style, the same mechanism smoothed by a Kalman filter, did no better than entering at random in #120). Shown only: no signal or email uses it.",
    // #137
    utBotNote:
      "UT Bot Alerts (a port of the code QuantNomad published on TradingView; UT Bot by Yo_adriiiiaan from an idea of HPotter): a trailing stop kept 1 × ATR(10) from the close; Buy (under the candle) where the close crosses over it, Sell (over the candle) where it crosses under. Candles are painted green while the close is above the stop and red while below (over Zone Shift's colours). As in the original, the stop itself is not drawn. Its Heikin Ashi option (off by default there) is not ported. Judged on closed bars only; the bar still forming is not painted. Not measured on past data. Shown only: no signal or email uses it.",
    kalmanNote:
      "SPECTRA-style = the processing order SentioEdge publishes for SPECTRA, rebuilt: the high–low midpoint and ATR(10) smoothed by a Kalman filter → Supertrend (3 ATR) → ▲▼ only when RSI(14) is above 50 (below for a sell). Green = up, red = down; the cloud is the gap to the smoothed price. Its Smart Trail (not published) and volume classification (GMO's bars have no volume) are not in it. Marked on closed bars only. On past data (11 pairs, 15m/1h/4h, stop 1 ATR, target 2x, spread paid, 2025-07 on): 7,164 trades, 29.4% won (break-even 33.3%), −0.116R each — no different from entering at random (1h: −0.031R, +0.05R over random, within noise). The RSI filter removed about 1 in 7,000. #132's first-period best (ATR 7, 1.5x) did worse on the second period (29.2% won; this setting 29.4%), so these were put back. No signal or email uses it.",
    hide: "Hide",
    show: "Show",
    foldList: "Fold the list",
    // #144: as iSPEED FX lays its chart out
    notesTitle: "How to read the chart, and the indicators",
    info: "About",
    groups: {
      signals: "Signals and positions",
      trend: "Trend (drawn over the price)",
      oscillator: "Oscillators (under the price)",
    },
    ohlc: (o: string, h: string, l: string, c: string) => `O ${o} H ${h} L ${l} C ${c}`,
    priceAuto: "Auto",
    priceAutoHint: "Fit the price scale again",
    gestureHint:
      "Long-press for the crosshair (it follows the finger; tap again to hide it). Drag the price scale on the right up or down to stretch it (Auto puts it back), the time scale at the bottom sideways to zoom. Turn the phone on its side for full screen.",
    tabsLabel: "Timeframe",
    // A timeframe the control bar does not offer (the higher rungs of a chain)
    tf: (tf: string) => tf,
    // #160: the drawing tools
    draw: {
      title: "Drawing tools",
      open: "Draw on the chart",
      openShort: "Draw",
      tools: {
        trend: "Trend line",
        ray: "Ray",
        extended: "Extended line",
        hline: "Horizontal line",
        hray: "Horizontal ray",
        vline: "Vertical line",
        channel: "Parallel channel",
        fib: "Fibonacci retracement",
        fibTime: "Fib time zone",
        fibFan: "Fib fan",
        fibArc: "Fib arcs",
        rect: "Rectangle",
        text: "Text",
        arrowUp: "Arrow up",
        arrowDown: "Arrow down",
        measure: "Price and time range",
        long: "Long position",
        short: "Short position",
      },
      short: {
        trend: "Trend",
        ray: "Ray",
        extended: "Extended",
        hline: "Horizontal",
        hray: "H. ray",
        vline: "Vertical",
        channel: "Channel",
        fib: "Fib",
        fibTime: "Fib time",
        fibFan: "Fib fan",
        fibArc: "Fib arc",
        rect: "Rectangle",
        text: "Text",
        arrowUp: "Up",
        arrowDown: "Down",
        measure: "Measure",
        long: "Long",
        short: "Short",
      },
      pick: "Pick a drawing tool",
      pickShort: "Tools",
      groups: { lines: "Lines", fib: "Fibonacci", marks: "Shapes, text and measures" },
      clearAsk: "Remove every drawing of this pair?",
      magnet: "Magnet (snap to open, high, low, close)",
      magnetModes: { off: "Off", weak: "Weak", strong: "Strong" },
      keep: "Keep drawing (stay on the tool after a drawing)",
      hideAll: "Hide all drawings",
      showAll: "Show the drawings",
      undo: "Undo",
      redo: "Redo",
      clearAll: "Remove this pair's drawings",
      clearYes: (n: number) => `Remove all ${n}`,
      clearNo: "Cancel",
      close: "Close the drawing tools",
      color: "Colour",
      width: "Width",
      style: "Line style",
      styles: { solid: "Solid", dashed: "Dashed", dotted: "Dotted" },
      text: "Edit the text",
      textPlaceholder: "Type here",
      defaultText: "Text",
      lock: "Lock (keep it in place)",
      unlock: "Unlock",
      copy: "Copy",
      remove: "Remove",
      deselect: "Deselect",
      hintStart: "Pick a tool under Tools, then tap (or drag) on the chart. Tap a drawing to select it: move it, change its colour or width, or remove it. Drawings are kept per pair and show on every timeframe.",
      hintTool: (name: string, left: number, total: number) =>
        total === 1
          ? `${name}: tap where it goes (or drag and let go)`
          : left === total
            ? `${name}: tap the first point (or drag and let go for the second)`
            : `${name}: ${left} more. Tap the next point (or drag and let go)`,
      hintSelected: "Drag the drawing to move it, a round handle to move that point. Tap an empty spot to deselect.",
      hintHidden: "The drawings are hidden (the eye shows them)",
      hintFull: (n: number) => `A pair takes up to ${n} drawings. Remove one to draw another.`,
      measure: (move: string, dist: string, pct: string, bars: number, span: string) => [`${move} (${dist}, ${pct}%)`, `${bars} bars, ${span}`],
      span: (d: number, h: number, m: number) => [d > 0 ? `${d}d` : "", h > 0 ? `${h}h` : "", m > 0 ? `${m}m` : ""].filter((x) => x !== "").join(" ") || "0m",
      target: (price: string, dist: string) => `Target ${price} (${dist})`,
      stop: (price: string, dist: string) => `Stop ${price} (${dist})`,
      ratio: (r: string) => `Risk/reward 1:${r}`,
    },
  },

  // #104: the RSI(14) × Parabolic SAR reading, the next-close prices at
  // which the rule fires, and the evidence the rule was adopted on
  rsiSar: {
    title: "RSI × Parabolic SAR",
    rule: "Buy: RSI(9) comes back above 25 from 25 or below, with the SAR under price. Sell: RSI comes back below 75 from 75 or above, with the SAR over price. Both are judged on closed bars (the RSI length and levels were searched in #132 and are the ones that won most often on past charts; they were RSI(14), 30/70).",
    nowTitle: "Now",
    rsi: (prev: string, now: string) => `RSI(9) ${prev} → ${now}`,
    sar: (level: string, below: boolean) => `Parabolic SAR ${level} (${below ? "under price, the buy side" : "over price, the sell side"})`,
    fired: (side: string) => `The newest closed bar gave a ${side} signal`,
    noSignal: "No signal on the newest closed bar",
    adviceTitle: "Where to act (judged on the next bar's close)",
    sides: { BUY: "Buy", SELL: "Sell" },
    ready: {
      BUY: (price: string, dist: string) => `If the next bar closes above ${price}, the buy conditions are met (${dist} from the current price).`,
      SELL: (price: string, dist: string) => `If the next bar closes below ${price}, the sell conditions are met (${dist} from the current price).`,
    },
    holdSar: {
      BUY: (level: string) => `That bar's low must also stay above the SAR at ${level}.`,
      SELL: (level: string) => `That bar's high must also stay below the SAR at ${level}.`,
    },
    notReady: {
      BUY: (price: string, dist: string, sar: string) =>
        `Not set up yet. First a close at or below ${price} has to take RSI under 25 (${dist} from the current price). After that, when RSI comes back above 25 with price above the SAR (now ${sar}), it is a buy.`,
      SELL: (price: string, dist: string, sar: string) =>
        `Not set up yet. First a close at or above ${price} has to take RSI over 75 (${dist} from the current price). After that, when RSI comes back below 75 with price below the SAR (now ${sar}), it is a sell.`,
    },
    plan: (entry: string, stop: string, target: string) => `The plan then: entry ${entry} · stop ${stop} · target ${target}`,
    costlyNext: (jstHour: number) => `The next bar closes in the ${jstHour}:00 JST hour, when the spread widens; the app stands aside then even if the conditions are met.`,
    adviceNote: "The rule is judged on the close. Touching the price during the bar does not meet it. The levels change every bar, so analyse again after the next bar closes.",
    windowTitle: (bars: number) => `Signals in these ${bars} bars`,
    tally: (side: string, n: number, wins: number, losses: number) => `${side} ${n} (${wins} won · ${losses} lost)`,
    method: (stopAtr: number, rr: number, horizon: number) =>
      `Stop ${stopAtr} ATR, target ${rr}× the stop, judged within ${horizon} bars on mid prices without the spread.`,
    evidenceTitle: "Tested on past charts",
    evidence: (period: string, pairs: number, win: number, n: number, breakeven: number) =>
      `${period}, ${pairs} pairs: won ${win}% (${n} trades). Breaking even needs ${breakeven}%.`,
    hit: (hit: number, n: number, blind: number) =>
      `Direction right (1 ATR either way, whichever came first): ${hit}% (${n}). Entering every bar: ${blind}%.`,
    notMeasured: (tf: string) => `Not tested on ${tf}. Below are the 15-minute, 1-hour and 4-hour results together.`,
    belowBreakeven: "In the test, this rule's win rate did not reach break-even.",
    unavailable: (reason: string) => `RSI and SAR could not be computed (${reason})`,
  },

  live: {
    title: "Live chart",
    connecting: "Connecting…",
    updated: (clock: string) => `Updated ${clock}`,
    pairsLabel: "Pairs",
    intervalsLabel: "Timeframe",
    // #127: gold's spread in dollars
    bidAskUsd: (bid: string, ask: string, spread: string) => `Bid ${bid}   Ask ${ask}   Spread $${spread}`,
    bidAsk: (bid: string, ask: string, spreadPips: string) => `Bid ${bid}   Ask ${ask}   Spread ${spreadPips} pips`,
    closed: "Market closed (last price)",
    loading: "Loading the chart…",
    error: "The chart could not be loaded. It tries again every minute.",
    maintenance: "GMO Coin's price feed is down for maintenance (it happens at weekends), so the chart cannot be shown now. It checks every minute and appears as soon as the feed is back.",
    maintenanceShort: "Feed maintenance",
    viewLabel: "Signals shown",
    pairNames: {
      "USD/JPY": "US Dollar / Japanese Yen",
      "EUR/USD": "Euro / US Dollar",
      "GBP/USD": "British Pound / US Dollar",
      "EUR/JPY": "Euro / Japanese Yen",
      "GBP/JPY": "British Pound / Japanese Yen",
      "XAU/USD": "Gold / US Dollar (per ounce)",
      // #153
      "AUD/JPY": "Australian Dollar / Japanese Yen",
      "AUD/USD": "Australian Dollar / US Dollar",
      "MXN/JPY": "Mexican Peso / Japanese Yen",
      "NZD/JPY": "New Zealand Dollar / Japanese Yen",
      "ZAR/JPY": "South African Rand / Japanese Yen",
      "CAD/JPY": "Canadian Dollar / Japanese Yen",
      "CHF/JPY": "Swiss Franc / Japanese Yen",
      "TRY/JPY": "Turkish Lira / Japanese Yen",
      "NZD/USD": "New Zealand Dollar / US Dollar",
      "EUR/GBP": "Euro / British Pound",
      "AUD/NZD": "Australian Dollar / New Zealand Dollar",
      "HUF/JPY": "Hungarian Forint / Japanese Yen",
      "SEK/JPY": "Swedish Krona / Japanese Yen",
      "NOK/SEK": "Norwegian Krone / Swedish Krona",
      "AUD/CAD": "Australian Dollar / Canadian Dollar",
      "NZD/CAD": "New Zealand Dollar / Canadian Dollar",
      // #154
      "USD/CAD": "US Dollar / Canadian Dollar",
      "USD/CHF": "US Dollar / Swiss Franc",
      "GBP/CHF": "British Pound / Swiss Franc",
      "EUR/CHF": "Euro / Swiss Franc",
      "AUD/CHF": "Australian Dollar / Swiss Franc",
      "NZD/CHF": "New Zealand Dollar / Swiss Franc",
      "HKD/JPY": "Hong Kong Dollar / Japanese Yen",
      "SGD/JPY": "Singapore Dollar / Japanese Yen",
      "NOK/JPY": "Norwegian Krone / Japanese Yen",
      "EUR/AUD": "Euro / Australian Dollar",
      "GBP/AUD": "British Pound / Australian Dollar",
      "PLN/JPY": "Polish Zloty / Japanese Yen",
      "CZK/JPY": "Czech Koruna / Japanese Yen",
      "CAD/CHF": "Canadian Dollar / Swiss Franc",
      "USD/HKD": "US Dollar / Hong Kong Dollar",
    } as Record<string, string>,
    // #153: the pair picker's groups and its button
    pairGroups: { fx: "FX", commodities: "Commodities (CFD)" } as Record<string, string>,
    // the grid's short names, in English
    pairShort: {
      "USD/JPY": "Dollar/Yen", "EUR/JPY": "Euro/Yen", "GBP/JPY": "Pound/Yen", "AUD/JPY": "Aussie/Yen",
      "EUR/USD": "Euro/Dollar", "GBP/USD": "Pound/Dollar", "AUD/USD": "Aussie/Dollar", "MXN/JPY": "Peso/Yen",
      "NZD/JPY": "Kiwi/Yen", "ZAR/JPY": "Rand/Yen", "CAD/JPY": "Loonie/Yen", "CHF/JPY": "Franc/Yen",
      "TRY/JPY": "Lira/Yen", "NZD/USD": "Kiwi/Dollar", "EUR/GBP": "Euro/Pound", "AUD/NZD": "Aussie/Kiwi",
      "HUF/JPY": "Forint/Yen", "SEK/JPY": "Krona/Yen", "NOK/SEK": "Krone/Krona", "AUD/CAD": "Aussie/Loonie",
      "NZD/CAD": "Kiwi/Loonie", "XAU/USD": "Gold",
      // #154
      "USD/CAD": "Dollar/Loonie", "USD/CHF": "Dollar/Franc", "GBP/CHF": "Pound/Franc", "EUR/CHF": "Euro/Franc",
      "AUD/CHF": "Aussie/Franc", "NZD/CHF": "Kiwi/Franc", "HKD/JPY": "HK Dollar/Yen", "SGD/JPY": "SG Dollar/Yen",
      "NOK/JPY": "Krone/Yen", "EUR/AUD": "Euro/Aussie", "GBP/AUD": "Pound/Aussie", "PLN/JPY": "Zloty/Yen",
      "CZK/JPY": "Koruna/Yen", "CAD/CHF": "Loonie/Franc", "USD/HKD": "Dollar/HK Dollar",
    } as Record<string, string>,
    pairGrid: "All symbols",
    // #154
    pairGridNote:
      "The prices listed for the 15 pairs GMO Coin does not carry (Dollar/Loonie, HK Dollar/Yen and so on) are Swissquote's, and those not on screen are one to three minutes old. CNH/JPY and CNH/HKD are not here yet: no free feed with their bars was found.",
    intervalShort: { "1min": "1m", "5min": "5m", "15min": "15m", "1h": "1H", "4h": "4H", "1day": "1D" } as Record<string, string>,
    signalNames: { gainz: "GA-style signals", rsi_sar: "RSI + SAR signals", both: "GA-style and RSI + SAR signals" } as Record<string, string>,
    views: { gainz: "GA style (recommended)", rsi_sar: "RSI + SAR", both: "Both" } as Record<string, string>,
    // #144: folded under the chart
    recommendedTitle: "About the base timeframe (4 hours)",
    recommended:
      "The base timeframe is the 4-hour chart: there the spread takes the smallest share of the stop (about 6%, against about 14% on the 15-minute chart), and entering at random lost least of the three timeframes. The GA style (#132's settings) on 4 hours: first period 106 trades, 30.2% won, −0.094R each; second period 102 trades, 39.2%, +0.176R. Few trades and a wide swing between the periods: it is not a reason to expect to win.",
    gaLegend: "BUY · SELL = the GA-style signal (engulfing, large body, RSI 40, against 5 bars ago; judged on closed bars). TP/SL = stop 1 ATR, target twice the stop (✓ won ✗ lost … open). The SAR band is a guide to the trend; the GA-style rule does not use it",
    rsiSarLegend: "BUY · SELL = a closed bar where RSI(9) came back from 25/75 with the SAR on the same side (✓ won ✗ lost … open). Dots = Parabolic SAR (green under price · red over price)",
    latestTitle: (rule: string) => `Latest signal (${rule})`,
    latestPlan: (entry: string, tp: string, sl: string) => `Entry ${entry}  TP ${tp}  SL ${sl}`,
    outcome: { win: "Result: reached the target", loss: "Result: reached the stop", ambiguous: "Result: both in one bar (counted as a loss)", expired: "Result: not settled in 48 bars", open: "Result: open" } as Record<string, string>,
    fallback: (maintenance: boolean, fetched: string) =>
      `${maintenance ? "GMO Coin's price feed is down for maintenance" : "GMO Coin's price feed cannot be read"}, so these are the latest bars from another feed (Twelve Data, fetched ${fetched} JST). Prices do not move. It switches back to GMO automatically.`,
    reopens: (at: string) => `The market is due to reopen at ${at} JST.`,
    ruleRsiSar: "RSI + SAR",
    ruleGa: "GA style",
    sides: { BUY: "BUY", SELL: "SELL" },
    none: "No signal on the newest closed bar",
    fresh: (what: string) => `New signal: ${what}`,
    nextClose: (time: string, remain: string) => `Next bar closes ${time} JST (in ${remain})`,
    note: "Prices are GMO Coin's public rates (the mid of bid and ask), updated every 5 seconds. Signals are judged on closed bars only, so the forming bar moving does not change the marks. The chart reloads when a bar closes.",
    // #129: Dow theory on four timeframes
    dowTitle: (tfs: string) => `Dow theory (${tfs})`,
    dowTfNames: { "4h": "4h", "1h": "1h", "15min": "15m", "5min": "5m" } as Record<string, string>,
    dowStates: {
      up: "Up (making new highs)",
      down: "Down (making new lows)",
      toDown: "Up → a sign of down (pullback low broken once, not confirmed)",
      toUp: "Down → a sign of up (rally high broken once, not confirmed)",
      none: "No reading (not enough swings yet)",
    },
    dowShort: { up: "Up", down: "Down", toDown: "Sign of down", toUp: "Sign of up", none: "—" },
    dowKey: (kind: "pushLow" | "pullHigh", price: string, broken: boolean) =>
      kind === "pushLow" ? `${broken ? "Broken p" : "P"}ullback low ${price}` : `${broken ? "Broken r" : "R"}ally high ${price}`,
    dowSince: (time: string) => `since ${time}`,
    dowLoading: "Loading…",
    dowError: "Could not be read (tried again in a minute)",
    dowTfError: "Could not be read",
    dowHint: "First break = a sign, second = confirmed (more under the chart). Shown only: no signal uses it.",
    dowCompact: "Dow",
    // #127
    goldNote:
      "Gold (XAU/USD, spot gold in US dollars) is not on GMO Coin, so its bars are Twelve Data's (read again as each bar closes) and its moving price is Swissquote's public rate (the mid of bid and ask, every 5 seconds). It is a different source from TradingView's gold CFD, so the two can differ by a few dollars. The signal marks are drawn, but gold is not in the email alerts or the outcome records. To stay within Twelve Data's free allowance (800 reads a day), each timeframe has a cap on the day's reads, reached first by the 1- and 5-minute charts. Past it, or while Twelve Data cannot be read, the bars go on from Swissquote's prices (the chart says so; the reads come back at 9:00 JST).",
    // #146, #147: gold's bars made from Swissquote's prices after Twelve Data's
    // last read; #154: a pair's GMO does not serve too
    fromTicks: (name: string, tf: string, limited: boolean, from: string | null, ownChart: boolean) =>
      `${name}'s ${tf} chart ${limited ? "has used today's Twelve Data reads (they come back at 9:00 JST)" : "could not be read again from Twelve Data"}, so its bars ${from ? `from ${from} JST` : "from now"} are made from Swissquote's prices (every few seconds). Prices are recorded only while ${ownChart ? "this pair's" : "a"} chart is open, so a time nobody had one open has no bars.`,
    // #154
    twelveNote:
      "This pair is not on GMO Coin, so its bars are Twelve Data's (read again as each bar closes) and its moving price is Swissquote's public rate (the mid of bid and ask, every 5 seconds). It is a different source from Rakuten FX's, so prices can differ a little. The signal marks are drawn, but the pair is not in the email alerts or the outcome records. Twelve Data's free allowance (800 reads a day) is shared with gold, and each timeframe has a cap on the day's reads, reached first by the 1- and 5-minute charts. Past it, or while Twelve Data cannot be read, the bars go on from Swissquote's prices (the chart says so; the reads come back at 9:00 JST). Opening several of these pairs or timeframes within a minute can hit the reads' per-minute limit (five), and a chart may then take about a minute to appear.",
  },

  gainz: {
    title: "GA-style signal (GainzAlgo V2 Alpha style)",
    rule: "Buy: the previous bar closed down and this one closes up, above that bar's open (engulfing); the body is more than 70% of the bar's range; RSI(14) is below 40; the close is below the close 5 bars ago. Sell is the mirror (RSI over 60). Judged on closed bars.",
    origin: "A reproduction matched to the settings on the GainzAlgo Suite screen (0.5 · 50 · 5 · 1:2), with its numbers then searched in #132 and set to the ones that won most often on the first period of past charts: 0.7 · 40 · 5 (the stop and target unchanged). GainzAlgo does not publish its logic, so the signals may differ. The app's signal (RSI × SAR) does not use it.",
    fired: (side: string) => `The newest closed bar gave a ${side} signal`,
    noSignal: "No signal on the newest closed bar",
    sides: { BUY: "Buy", SELL: "Sell" },
    plan: (entry: string, stop: string, target: string) => `The plan then: entry ${entry} · stop ${stop} · target ${target}`,
    windowTitle: (bars: number) => `Signals in these ${bars} bars`,
    tally: (side: string, n: number, wins: number, losses: number) => `${side} ${n} (${wins} won · ${losses} lost)`,
    method: (stopAtr: number, rr: number, horizon: number) =>
      `Stop ${stopAtr} ATR, target ${rr}× the stop, judged within ${horizon} bars on mid prices without the spread.`,
    evidenceTitle: "Tested on past charts (spread paid)",
    evidence: (period: string, pairs: number, win: number, n: number, breakeven: number, meanR: string) =>
      `${period}, ${pairs} pairs: won ${win}% (${n} trades), ${meanR}R per trade on average. Breaking even needs ${breakeven}%.`,
    notMeasured: (tf: string) => `Not tested on ${tf}. Below are the 15-minute, 1-hour and 4-hour results together.`,
    notMeasuredAll: "Not tested yet.",
    verdict: (meanR: number): string =>
      meanR < 0
        ? "In the test, each trade lost money on average once the spread was paid."
        : "In the test, each trade made money on average; whether that is more than luck is for the live record to show.",
    unavailable: (reason: string) => `The GA-style signal could not be computed (${reason})`,
  },

  technical: {
    title: "Market data summary",
    currentRate: "Current rate",
    overbought: " (overbought)",
    oversold: " (oversold)",
    // #104: the only readings the analysis uses
    sar: "Parabolic SAR",
    sarSide: (below: boolean) => (below ? "under price (buy side)" : "over price (sell side)"),
    atr: "ATR(14) · the unit for stop and target",
    closedNote: "RSI and SAR are closed-bar values",
    forming: "This bar is still forming",
  },

  history: {
    title: "Signal history",
    winRate: "Win rate",
    fillRate: "Fill rate",
    outcomes: {
      win: "WIN",
      loss: "LOSS",
      pending: "OPEN",
      expired: "EXPIRED",
      skipped: "—",
      untriggered: "NO FILL",
      ambiguous: "UNCLEAR",
      rejected: "REFUSED",
      // The other event REFUSED used to be printed for: the model's own WAIT.
      // Sixteen of those wore the refusal badge while one plan had actually
      // been refused.
      declined: "AI DECLINED",
      // #104 (v68+): a WAIT because the RSI/SAR rule did not fire
      ruleWait: "NO SIGNAL",
    },
    scope: (n: number) => `last ${n}`,
    statsScope: (n: number) => `Record: ${n} calls, all time`,
    statsScopeContract: (n: number, contract: string) => `Record: ${n} calls, all time (${contract})`,
    statsFallback: (n: number) => `Record: from the last ${n} rows only — the server totals could not be fetched`,
    otherContractRows: (n: number) => `${n} calls made under a different entry contract are not counted here`,
    autoNote: "Judged automatically every 15 minutes against actual prices (TP1 reached = WIN, SL reached = LOSS)",
    streak: (word: string, n: number, from: string, to: string) =>
      `Same-direction losing run: ${n} ${word} calls in a row lost (${from} – ${to}, your record)`,
    winRateNote: "Win rate counts WIN, LOSS and expired (no-fill and unclear are excluded). An expiry is what a target too far away looks like, so it is not an exit from the win rate. Fill rate is how often the market actually reached the entry",
    stats: {
      title: "Breakdown",
      byTimeframe: "Timeframe",
      byMode: "Mode",
      byConfidence: "Confidence",
      all: "All",
      record: "W–L",
      open: "Open",
      untriggered: "No fill",
      other: "Other",
      unknownBand: "—",
      noClosed: "No signal has been settled yet",
      confidenceBand: (lo: number, hi: number | null) => (hi === null ? `${lo}%+` : `${lo}–${hi}%`),
      measuring: (n: number, target: number) => `Measuring (${n} of ~${target} independent settled trades)`,
      ci: (lo: number, hi: number) => `95% interval ${lo}–${hi}%`,
      clusters: (n: number) => `${n} independent situation${n === 1 ? "" : "s"}`,
      expectancyLine: (expectancy: string, sum: string) => `Expectancy ${expectancy} (total ${sum})`,
      rColumn: "P&L (R)",
      byRulebook: "Rulebook",
      verdictRate: "Calls with a verdict",
      leakLine: (wait: number, untriggered: number, expired: number) =>
        `stood aside ${wait}%, never filled ${untriggered}%, expired ${expired}%`,
      incoherentLine: (n: number) => `${n} with contradictory levels`,
      legacyContract: (v: string) => `${v} (old contract)`,
      mixedContracts: "These plans span two entry contracts, so no rate is shown. Under the old one a plan could go unfilled and unscored; under the new one it cannot. Split them with the rulebook breakdown to compare.",
      rulebookNone: "Before rules",
      frictionNote: "R is profit or loss in multiples of the planned risk (WIN = TP1 reached, LOSS = −1R). Frictionless: no spread or slippage is charged",
    },
    modes: { full: "With news", technical_only: "Technical", technical_fallback: "Technical (no search)" },
    gate: {
      // "the server refused the analyst" and "the analyst declined" are
      // different events. The confidence floor stamps a rejection on a WAIT the
      // model itself answered, so while these were one count the screen
      // reported sixteen server overrides where one plan had been refused.
      note: (n: number) => `${n} of the model's plans were refused server-side as unfillable or not worth taking, and published as WAIT.`,
      // "nothing was refused server-side" would be printed in the same
      // paragraph as the sentence above saying something was, and an English
      // reader has no way to tell which to believe. The clause is scoped to
      // these calls, the way the Japanese parenthetical already scopes it.
      declinedNote: (n: number) =>
        `${n} call${n === 1 ? " was" : "s were"} a stand-aside by the model itself or a wait for the RSI/SAR conditions — these were not server refusals.`,
      shadowNote: (s: { untriggered: number; wins: number; losses: number; open: number }) =>
        `Refused plans tracked anyway: no fill ${s.untriggered} / WIN ${s.wins} / LOSS ${s.losses} / open ${s.open}`,
      rejectedTitle: "Plan refused server-side",
      rejectedSummary: "The model's plan was refused server-side and published as WAIT",
      declinedSummary: "The model declined to trade — this was not a server refusal",
      ruleWaitSummary: "The RSI/SAR conditions were not met, so this is a WAIT — not a server refusal",
      reasons: {
        too_far: "Entry too far from the market (would not fill)",
        should_be_market: "Waits for a pullback in a running trend (would not fill)",
        stop_too_tight: "Stop inside the noise (would be hit by it)",
        poor_rr: "Risk/reward does not pay",
        target_out_of_reach: "Target too far to be reached in time",
        // The stop floor's demand, made of the other side of the entry.
        target_too_close: "First target inside the noise (reaching it would prove nothing)",
        market_closed: "The market was shut, so there was no price to enter at",
        // Only reachable on a row where the model asked for a BUY or a SELL
        // and rated it below the floor. A model WAIT never reaches this block.
        low_confidence: "The model's own confidence was below the floor",
        // Written by two different paths in entry.ts — levels compared and
        // pointing the wrong way, or a level missing so nothing was compared —
        // and the reason alone does not say which. "Contradict" asserts the
        // outcome of a comparison that, on the second path, never happened.
        // (The missing level is visible: proposed_stop and proposed_tp1 are
        // rendered right beside this label.)
        incoherent: "Entry, stop and target could not be read as a coherent plan",
        // See the Japanese copy: added after nine consecutive same-direction
        // losses; takes effect on the bar AFTER the higher timeframe turns.
        structure_conflict: "Runs against the higher timeframe's direction (closing break)",
        // See the Japanese copy: the entry timeframe was turning (opposing
        // evidence at the threshold, no fresh break its own way) and the plan
        // rode the old direction — the 9/14–9/15 daily SELLs.
        turn_conflict: "The entry timeframe was turning, and the plan rode the old direction",
        costly_hours: "Priced in the hours around the daily roll, when the spread widens",
      },
      proposed: "Model's call",
      distance: "Distance from market",
      riskReward: "Risk/reward",
      shadowResult: "Refused plan, tracked",
      gateRight: "→ The refusal was right (the entry was never reached)",
      gateWrong: "→ The refusal was wrong (it filled and reached the target)",
      gateSaved: "→ It would have filled and been stopped out",
      gateOpen: "→ Still tracking",
      repaired: "The model's limit entry was moved to the market price because the trend was still running",
    },
    preview: { badge: "preview" },
    wait: {
      title: "Standing aside, reviewed",
      badge: "trade missed",
      summary: (judged: number, missed: number, rate: number) =>
        `Standing aside: of ${judged} judged calls, ${missed} (${rate}%) would have won on the smallest trade this app itself allows`,
      verdicts: {
        missed: "Standing aside was wrong — the trade named at the call would have won",
        correct: "Standing aside cost nothing — that trade was stopped out, or never paid in time",
        pending: "The review window has not closed yet",
        unknown: "The data needed to judge this call is missing",
        no_call: "Nothing at the moment of the call named a side, so this one is not scored",
      },
      direction: (dir: string, source: string) => `Direction fixed at the call: ${dir} (${source})`,
      directionSources: {
        proposed_signal: "the model asked for this trade and the server refused it",
        declared_direction: "the direction the model declared while declining to trade",
        regime: "the trend the indicators read",
        none: "none",
      },
      planNote: "This direction, stop and target were fixed and stored at the moment of the call — not chosen afterwards from what the market did",
      noCallNote: "Nothing at the time named a side, so this call counts on neither side of the miss rate",
      basis: "Trade tested",
      basisNote: (risk: string, reward: string) =>
        `Stop ${risk} / target ${reward} — the tightest stop the gate allows and the nearest target that still clears the risk/reward floor`,
      reachedAt: "Target reached",
      barsExamined: (n: number) => `${n} bars examined`,
      horizon: (hours: number) => `${hours}h window, measured in open-market time`,
      note: "A call that declines to trade is scored too: leave it unscored and standing aside becomes the answer that is never wrong",
    },
    postmortem: {
      title: "Why it missed (AI review)",
      titleWin: "Why it worked (AI review)",
      pending: "The review runs automatically a few hours after settlement",
      candidateArm: "This call was made by a candidate arm. The post-mortem feeds the shared rulebook, so it runs on the control arm only and this row is not diagnosed.",
      failed: "The review could not run; it will be retried on the next pass",
      causes: {
        direction_wrong: "Wrong direction",
        stop_too_tight: "Stop too tight",
        entry_too_far: "Entry never filled (old contract)",
        entry_too_early: "Chased at market, turned at once (old contract)",
        chased_move: "Entered an extended move",
        target_too_far: "Target too far",
        regime_misread: "Regime misread",
        news_shock: "Event shock",
        plan_incoherent: "Incoherent plan",
        good_call: "As planned",
        lucky_win: "Won, but unsafely",
        wait_missed_trade: "Stood aside from a trade that paid",
        good_wait: "Standing aside was right",
        sound_call_lost: "Lost with no lever to move",
        inconclusive: "Not enough evidence",
      },
      causeNote: {
        sound_call_lost:
          "A wider stop, a nearer target and a better fill were each simulated through to a verdict, and not one of them changed the outcome. This says no lever we can move would have changed it — not that the call was right: everything measured here happened after the decision was made",
      },
      lesson: "Lesson",
      avoidable: "Avoidable with what was known at the time",
      unavoidable: "Hard to avoid with what was known at the time",
      confidence: (c: number) => `Diagnosis confidence ${c}%`,
      counterfactual: "What if…",
      cfMarket: "Entered at the market",
      cfStop15: "Stop 1.5× wider",
      cfStop2: "Stop 2× wider",
      cfTpHalf: "Target at half the distance",
      cfMarketSameRisk: "At the market, same stop width",
      cfPullback: "A 0.5R better price was on offer",
      cfRr: (rr: number) => `RR ${rr}`,
      cfNotViable: "not publishable (below the gate's minimum)",
      cfResult: { win: "WIN", loss: "LOSS", untriggered: "No fill", expired: "Expired", ambiguous: "Unclear", open: "Open" },
      afterTp1: (bars: number) => `TP1 was reached ${bars} bars after the stop`,
      beyondSl: (r: number) => `Price ran a further ${r}R past the stop`,
      earlyAdverse: (r: number) => `Turned ${r}R against the entry right after the fill`,
      danger: {
        deep_mae: (closestR: number) => `Came within ${closestR}R of the stop`,
        mostly_underwater: (underwater: number, bars: number) => `Underwater for ${underwater} of ${bars} bars`,
        chop: (crossings: number) => `Crossed the entry ${crossings} times`,
        spike_target: (reversedR: number) => `Target hit by a wick, then gave back ${reversedR}R`,
        late_win: (percent: number) => `Reached the target with ${percent}% of its life used`,
      },
      thinNote: "Provisional: little price action has followed the settlement yet. It will be reviewed again automatically once the window fills",
      thinFinalNote: "Still provisional after the second look: little price action followed the settlement, and no further automatic review is scheduled",
      revisedNote: "Reviewed again after the full window",
      ruleBlamed: (id: string) => `Rule at fault: ${id}`,
      ruleCredited: (id: string) => `Rule that helped: ${id}`,
      eventBar: (country: string, title: string) => `The abnormal bar carried a ${country} release: ${title}`,
      causeBreakdown: "Why plans missed",
    },
    detail: {
      expand: "Plan vs. actual",
      collapse: "Close",
      plan: "AI plan",
      actual: "What happened",
      entry: "Entry",
      stopLoss: "Stop loss (SL)",
      takeProfit1: "Take profit (TP1)",
      priceAtSignal: "Price at analysis",
      orderTypeLabel: "Order type",
      orderType: {
        market: "At market",
        limit: "Limit (waits for a pullback)",
        stop: "Stop (waits for a breakout)",
        unknown: "—",
      },
      priceFeedLabel: "Priced from",
      priceFeed: {
        twelve_data: "Twelve Data mid",
        gmo: "GMO Coin mid (same book it is scored on)",
      },
      priceBasisLabel: "Scored on",
      priceBasis: {
        mid: "Mid (no bid/ask available)",
        quotes: "GMO Coin bid/ask",
      },
      filledAt: "Filled",
      notFilled: "Not filled",
      resolvedAt: "Settled",
      mfe: "Max. favourable move",
      mae: "Max. adverse move",
      tpsHit: "Targets reached",
      none: "none",
      pips: "pips",
      checkedAt: "Last check",
      evalInterval: "Judged on",
      refined: (interval: string | null) => (interval ? `refined with ${interval} bars` : "refined with finer bars"),
      noEvidence: "No judgement data yet. The next automatic check runs within 15 minutes.",
      refinePending: "The finer bars needed for a decision could not be fetched; the next automatic check will retry",
      possibleFill: "The bar around the signal reached the entry, but whether that was before or after the analysis cannot be told",
      reasons: {
        missed: "TP1 was reached before the entry filled (missed the move)",
        invalidated: "The stop level was reached before the entry filled (setup invalidated)",
        no_fill: "The entry price was not reached within the validity window",
        incoherent: "The plan's levels contradict each other and cannot be judged",
        no_data: "The price data needed for a judgement was not available",
      },
      summary: {
        win: (tp: string) => `Reached TP1 at ${tp}`,
        loss: (sl: string) => `Reached SL at ${sl}`,
        expired: (price: string) => `Expired (last price ${price})`,
        // Rows whose site is known render ambiguitySite instead. This generic
        // line asserts BOTH levels were touched, which under the current
        // contract is usually false: one level, often before the plan existed.
        ambiguous: "The order of events could not be determined",
        pending: "Awaiting settlement",
        skipped: "Not judged: a WAIT call carries no trade plan",
      },
      // Why it could not be judged. Names what happened, not a category.
      ambiguitySite: {
        incoherent: "The plan's stop and target contradict each other",
        window_short: "Price history reaching back to the signal could not be fetched",
        no_finer_data: "Finer bars could not be fetched after repeated tries, so the order is unknown",
        signal_bar: "The bar being analysed had already reached the stop or the target, and whether that happened before or after the plan was written cannot be established",
        pre_fill: "The entry window ran out while a fill was still possible",
        unfilled_touch: "The stop or the target was reached while it was still unknown whether the entry had filled",
        fill_bar: "The bar that filled the order also reached the stop or the target, so the order is unknown",
        in_trade: "One bar touched both the stop and the target while the position was open",
        feed_conflict: "The finer bars did not show the move the coarse bar did",
      },
      legacyNoEvidence: "Judged by an earlier version; no price path was recorded",
      chartHeading: "Actual price path",
      chartSubtitle: (interval: string, n: number) => `${interval} bars / ${n}`,
      chartSubtitleCompressed: (interval: string, n: number) => `${interval} bars, compressed to ${n} points`,
      markers: { signal: "Signal", fill: "Fill", win: "TP1", loss: "SL", end: "End" },
    },
  },

  rules: {
    title: "What the AI has learned",
    version: (v: number) => `v${v}`,
    updated: (d: string) => `updated ${d}`,
    empty: "Nothing learned yet. Rules are added automatically as signals settle and are reviewed.",
    support: (n: number) => `${n} case${n === 1 ? "" : "s"}`,
    verifying: "under review",
    verifyingSupport: (n: number) => `under review, ${n} case${n === 1 ? "" : "s"}`,
    kind: { constraint: "guard", heuristic: "playbook" },
    showAll: (n: number) => `Show all (${n})`,
    showLess: "Show fewer",
    note: "Generated automatically from reviews against actual prices. The signal is decided by the RSI and Parabolic SAR rule, so these rules are not used in the analysis (they are shown as a record)",
    supportNote: "Cases = independent situations behind the rule (plans in the same direction within a day count once — unless the earlier trade had already finished well before the next was made). Two or fewer is \"under review\"",
    cadence: "Revised only after 5 new lessons or 24 hours since the last revision, adding or dropping at most 2 rules at a time, so each version's results can be compared",
    sharedNote: "These rules are learned from every account's results pooled together, so a rule's evidence count includes plans you will not find in your own history",
    heldBack: (n: number) =>
      `${n} rule${n === 1 ? " is" : "s are"} held back: ${n === 1 ? "its cause or its wording names" : "their causes or wordings name"} a move the current entry contract does not have — the analyst no longer chooses where to enter. They keep their evidence and return if they are rewritten in terms of direction, stop, target, or waiting.`,
    priorEvidence: "incl. prior contract",
    priorEvidenceNote: "Some of the plans behind this rule were made under the previous entry contract, where the analyst chose the entry price.",
    noneInForce: "No rule is in force under the current contract yet. Rules return here as new plans settle and are reviewed.",
    editorNote: "Editor's note",
    editorNoteCaption: "The working note the rulebook editor keeps for itself. It may use internal terms and may no longer match the current state.",
  },

  loop: {
    title: "Automatic review status",
    tracker: "Outcome judging",
    postmortem: "Post-mortems",
    every15: "every 15 min",
    last: (d: string) => `last ${d}`,
    lastLine: (d: string, ago: string) => `last ${d} (${ago})`,
    ago: (m: number) => (m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`),
    never: "not yet run",
    stalled: "no run for over 60 minutes (may have stopped)",
    inactive: "schedule is disabled",
    openPlans: (n: number) => `${n} open`,
    awaiting: (n: number) => `${n} awaiting review`,
    reviewed: (n: number) => `${n} reviewed`,
    rulebook: (v: number) => `Rulebook v${v}`,
    lessons: (n: number) => `${n} lesson${n === 1 ? "" : "s"}`,
    nextRevision: (n: number) => (n > 0 ? `${n} more lesson${n === 1 ? "" : "s"} until the next revision (or 24 h after the last)` : "revised on the next review"),
    candidateHeld: (decided: number, needed: number) =>
      `A revision is written and held. It goes live once the current version has been tried on ${decided}/${needed} independent situations to compare it against`,
    waits: "Post-mortems run automatically 1 h (15min plans), 2 h (1h), 4 h (4h) or 8 h (1day) after settlement, and are reviewed again later when little price action has followed",
  },

  // Direction, timing and placement scored apart instead of collapsed into
  // win/loss. Every number is public.separated_scores()' answer rendered as
  // it arrived; the screen computes none of it (two implementations of one
  // number is how one number with one name becomes two).
  scores: {
    title: "Three scores kept apart",
    definition: (v: number) => `scoring definition v${v}`,
    subtitle:
      "Collapsed into win/loss, \"right about the direction and wrong about where the stop went\" and \"wrong about the direction\" are the same word: loss. These three are kept apart.",
    none: "No scores came back from the server (this panel never computes them from the rows on screen)",
    empty: "No trades can be scored yet",
    noPair: "unknown",
    noRate: "no interval",
    span: (from: string, to: string) => `${from} - ${to}`,
    basis: (calls: number, pairs: string) => `Rests on: ${calls} calls, pair ${pairs}`,
    basisSignals: (mix: string) => `mix ${mix}`,
    basisTrades: (trades: number, diagnosed: number, undiagnosed: number) =>
      `${trades} trades (${diagnosed} diagnosed, ${undiagnosed} not yet)`,
    // How many trades the scores were actually taken over. This can differ from
    // "diagnosed" above: rows on a different entry contract are out of scope
    // for the scores, and the next line says how many.
    basisGraded: (graded: number) => `${graded} of them are what the scores below were taken over`,
    otherContract: (rows: number, list: string) =>
      `${rows} rows use a different entry contract (${list}) and are NOT in the scores below`,
    // Derived from the population, never asserted from a constant. A fixed
    // "one pair, about two weeks" outlives its data the day a second pair is
    // analysed, and then contradicts the line directly above it (#83).
    narrow: (pairs: number, days: number | null, topSignal: string | null, topShare: number | null) => {
      const parts = [`${pairs} pair${pairs === 1 ? "" : "s"}`];
      if (days !== null) parts.push(`${days} day${days === 1 ? "" : "s"} of record`);
      if (topSignal !== null && topShare !== null) parts.push(`${topSignal} is ${topShare}% of all calls`);
      return `What these scores rest on: ${parts.join(" / ")}. Change the market and the numbers change.`;
    },
    // The "not enough yet" judgement also comes from the intervals, not from a
    // sentence that stops being true without anyone noticing.
    undecided:
      "Every interval below still contains 50%. None of these scores says this is working, or that it is not - not yet.",
    contractNote: (contract: string) => `The live entry contract has no scoreable trades, so the ${contract} record is shown instead`,
    direction: {
      label: "Direction (was the call right about which way)",
      // The threshold goes on the screen. How weak a test "right about the
      // direction" actually is cannot be read off the label.
      hint: (deadR: number | null) =>
        `Which way price went, and nothing else. A row counts as right when price did not keep running a full 1R past the stop AND came at least ${deadR === null ? "some distance" : `${deadR}R`} the plan's way while the plan was alive - that is the whole test. It does not read whether the stop or the target was hit first. A direction can be right on a trade that LOST, and separating that is what this row is for.`,
    },
    timing: {
      label: "Timing (heat right after entry)",
      hint: (earlyR: number | null) =>
        `How often price did NOT go${earlyR === null ? "" : ` ${earlyR}R or more`} against the plan in the first bars after the fill. It does NOT say the entry was wrong: an entry that goes with a trend takes heat by construction.`,
    },
    placement: {
      label: "Placement (where the stop and target went)",
      // The stop leg is only ever simulated on a loss. Left unsaid, a run of
      // wins lifts this score and the screen reads as though a judge checked.
      hint: "Whether a wider stop, or a target half the distance away, would have changed the ending. But the stop half is only actually simulated on a LOSS: a trade that did not lose passes the stop test with its stop never examined (see the count beside the rate). The target half is checked every time. Placement is also partly a consequence of direction and timing.",
    },
    pace: {
      label: "Settled inside the declared period",
      notAScore: "This is not a score. Higher is not better and lower is not worse — a winner that runs long settles outside its period.",
      hint: "The denominator is only trades that settled AND declared a period. That is a different population from the three above, which need a finished post-mortem.",
      noHorizon: (n: number) => `${n} settled with no declared period`,
      openPast: (n: number) => `${n} still open past their period`,
    },
    deepMae: {
      // The one row whose polarity is inverted. It has to be in the label:
      // stacked under three higher-is-better rates it otherwise reads as a
      // fourth score of about the same quality.
      label: "Worst excursion reaching the stop's edge (higher is WORSE)",
      hint: (maeR: number | null) =>
        `How often the deepest drawdown got within ${maeR === null ? "most of the way" : `${Math.round(maeR * 100)}%`} of the stop. Unlike the three above, a HIGHER number here is worse. Different window and different denominator from the timing row - do not add them or compare them.`,
    },
    n: (hits: number, n: number) => `${hits}/${n}`,
    ci: (lo: number, hi: number) => `95% interval ${lo}-${hi}%`,
    unscored: (n: number) => `${n} could not be scored`,
    thin: "Few rows, and the interval spans most of the range",
    denominators: "The three are taken over three different populations. They are not one denominator split three ways.",
    notADecomposition:
      "The three are not independent. They do not add up to the win rate and they are not a breakdown of it - they are three views of the same trades.",
    causesLabel: "Causes on record (lessons table)",
    // A different population from the three scores. The count, and how much of
    // it is WAIT calls, go next to it - without them the block reads as a
    // fourth view of the same trades.
    causesTotal: (total: number, waits: number) =>
      `${total} rows, of which ${waits} are WAIT calls that appear in NONE of the three scores above`,
    causeSplit: (direction: number, timing: number, placement: number, neither: number) =>
      `direction ${direction} / timing ${timing} / placement ${placement} / neither ${neither}`,
    causeStraddle: "\"Stop too tight\" is counted under placement here, but it is also a statement about timing. This grouping does not partition cleanly.",
    ranPast: (n: number) => `${n} ran past the stop`,
    neverCame: (n: number) => `${n} never came our way`,
    wrongPartial: (n: number) => `${n} of these could only ever count as a miss (one measurement missing)`,
    stopBad: (n: number) => `${n} with the stop misplaced`,
    targetBad: (n: number) => `${n} with the target misplaced`,
    stopUntested: (n: number) => `${n} passed the stop test untested - the trade did not lose`,
  },

  // The instrument that runs BEFORE any correction is applied to confidence:
  // whether a correction could be defined at all. Every number is
  // public.confidence_calibration()'s answer rendered as it arrived, and this
  // panel applies no correction to anything.
  //
  // Two readings it must not permit. An AUC of 0.5 means "does not rank
  // outcomes"; a value below 0.5 is NOT evidence of an inverted confidence
  // while the interval still contains 0.5 - it establishes nothing either way.
  // And the gate's threshold was written AFTER the numbers were seen; it is
  // not a preregistration. Both sit next to the numbers, not in a doc.
  calibration: {
    title: "Can confidence be corrected at all",
    subtitle:
      "A correction is a mapping: \"when the model says 80 it actually wins 55% of the time\". Fitting one needs the stated number to MOVE. If it does not move, the correction is not weak - it is undefined. This panel applies no correction; it only measures whether one could be defined.",
    contract: (contract: string) => `entry contract ${contract}`,
    unknown: "-",

    rangeTitle: "1. The range confidence actually takes",
    // Built from the measurement, never from a fixed sentence. A constant
    // "62 to 70" outlives its data the day the model emits anything else, and
    // then contradicts the table directly under it (#83).
    tradedRange: (lo: number, hi: number, n: number) =>
      `Across the ${n} plans this system actually traded, it has only ever said ${lo} to ${hi}.`,
    tradedShape: (distinct: number, width: number) =>
      `That is ${distinct} distinct values and a width of ${width}, end to end.`,
    rangeUnknown: "The confidence range on traded plans could not be read.",
    allRange: (lo: number, hi: number, n: number, distinct: number) =>
      `All ${n} calls including waits: ${lo} to ${hi} (${distinct} distinct values)`,
    waitRange: (lo: number, hi: number, n: number, distinct: number) =>
      `The ${n} WAIT calls: ${lo} to ${hi} (${distinct} distinct values)`,
    gaugeNote:
      "The confidence gauge is drawn on a 0 to 100 scale. The range above is all of that scale this record has ever used.",
    // The width is a fact. "No mapping to fit" is a verdict, so it is rendered
    // only when a payload-derived test says so. A constant verdict contradicts
    // the table under it the moment the data moves (#83).
    roomFact: (width: number) =>
      `A correction maps the stated number onto the observed win rate. The stated number has actually moved ${width} wide.`,
    roomNarrow: (needSpan: number) =>
      `That is not wide enough to lay out the bands the gate asks for (5-wide, ${needSpan} points of span). There is no mapping to fit.`,

    valuesTitle: "2. What became of each value it stated",
    valuesNote:
      "The values themselves, not coarse bands. Banding hides the one thing this table is for: how little the number moves.",
    colConfidence: "confidence",
    colN: "settled",
    colRate: "win rate",
    ciPercent: (lo: number, hi: number) => `95% interval ${lo}-${hi}%`,
    valueN: (settled: number, wins: number, losses: number) => `${settled} (${wins}W / ${losses}L)`,
    valueRate: (rate: number, wins: number, settled: number) => `${rate}% (${wins}/${settled})`,
    // How thin a row is belongs ON the row. A percentage taken over one trade
    // printed at the same size as one taken over a hundred is the most
    // dangerous thing this table can do.
    valueThin: (settled: number) => `this row is ${settled} settled trade${settled === 1 ? "" : "s"}`,
    noValues: "No trade has settled yet, so there is no win rate per value to show.",

    bandsTitle: "5-wide bands (what the gate below is judged on)",
    bandLabel: (lo: number, hi: number) => `${lo}-${hi}`,
    bandThin: (minN: number) => `short of ${minN}`,

    discTitle: "3. Discrimination (does the number rank wins above losses)",
    discMeaning: (auc: number) =>
      `Take one winning trade and one losing trade at random: the winner carried the higher stated confidence ${auc} of the time (ties counted as half). 0.5 means the number does not rank outcomes at all.`,
    discPairs: (pairs: number, nWin: number, nLoss: number) =>
      `Counted over every pair: ${nWin} wins x ${nLoss} losses = ${pairs} pairs.`,
    discCi: (lo: number, hi: number) => `95% interval ${lo} to ${hi}`,
    discTies: (share: number) => `${share}% of the pairs are ties`,
    // The approximation goes wherever the interval goes. On a separate line it
    // gets quoted without the caveat.
    discApproximate:
      "This interval is a normal approximation (Hanley-McNeil), and it gets coarser the more ties there are.",
    discNothing:
      "The interval contains 0.5, so nothing is established. A value below 0.5 is NOT evidence that confidence works in reverse - the interval is simply too wide to tell it apart from chance.",
    // With no interval read, "the interval contains 0.5" would state a
    // property of a measurement that is not there.
    discNoInterval: "No interval was reported, so nothing is established either way.",
    discEstablished: "The interval does not contain 0.5.",
    discNone: "No win/loss pairs could be formed, so discrimination could not be measured.",

    gateTitle: "4. What is required before a correction is applied",
    gateNotApplied:
      "No correction is applied to confidence anywhere. This panel only measures whether one would be allowed.",
    gateApplied: "Warning: a correction is being applied.",
    gateNeed: (bands: number, minN: number, settled: number) =>
      `Required: at least ${bands} 5-wide bands with ${minN} or more settled trades each, and ${settled} settled trades in total.`,
    gateHave: (bands: number, settled: number) =>
      `Currently: ${bands} band${bands === 1 ? " qualifies" : "s qualify"}, ${settled} settled in total.`,
    gateUnmet: "Not met. Until it is, no correction is applied.",
    gateMet: "Met. Whether to apply a correction is a separate decision.",
    // When the threshold was chosen matters as much as what it is.
    gateAfterTheFact:
      "This threshold was written AFTER the numbers above were seen. It is not a preregistration. A threshold picked once the data is visible can be placed wherever it is convenient, so this must not be treated like docs/NOISE_FLOOR_PREREGISTRATION.md.",
    gatePreregistered: "This threshold was registered before the numbers were seen.",
  },

  // Who wrote the record. The statistics are keyed on the entry contract and
  // the rulebook version and on nothing else: which model answered was never
  // part of the key. Swap the model and two analysts' track records dissolve
  // into one win rate with nothing left to separate them by. This panel
  // watches that one thing, right beside the record itself.
  //
  // One reading it must never permit: a row with no model recorded means the
  // record is MISSING, not that the usual one was used. Those rows cannot be
  // filled in later, so their count must never be folded into a named model's.
  modelMix: {
    title: "Who wrote this record",
    contract: (contract: string) => `entry contract ${contract}`,
    unknown: "-",
    scope: (calls: number) => `over ${calls} call${calls === 1 ? "" : "s"}`,
    // The ordinary case. Information, not a warning, and one line of it.
    // "alone" is only true when nothing settled unattributed; one such trade
    // and the panel switches to singlePlusGap below.
    single: (model: string, settled: number) =>
      `This record was written by ${model} alone, over ${settled} settled trade${settled === 1 ? "" : "s"}.`,
    // One named model, but settled trades whose author was never recorded.
    // Saying "alone" here would hand one model a win rate taken over trades it
    // may not have written — the exact reading this panel exists to stop.
    singlePlusGap: (model: string, settled: number, gap: number) =>
      `${model} wrote ${settled} of the settled trades here. ` +
      `Another ${gap} settled with no model recorded and also count toward the win rate, ` +
      `so this rate cannot be read as ${model}'s.`,
    // What the panel exists for.
    pooled: (models: number) =>
      `This win rate is a blend of ${models} different models. It cannot be read as any one of their records.`,
    pooledNote: "More than one model has settled trades. The split is below.",
    // The blend is reported but the split is not. Never promise a table and
    // then draw nothing under it.
    pooledNoSplit: "More than one model has settled trades here; the per-model split was not reported.",
    row: (settled: number, calls: number) => `${settled} settled / ${calls} calls`,
    rowSettledOnly: (settled: number) => `${settled} settled`,
    none: "No trade has settled yet, so no model has written a win rate.",
    noCalls: "No analysis has been recorded under this entry contract yet.",
    // "nothing yet" and "could not be read" are different claims. Rendering an
    // unreadable payload as the former states a fact nobody measured.
    notReadable: "Who wrote this record could not be read.",
    unrecorded: (rows: number) =>
      rows === 1 ? "1 row has no model recorded." : `${rows} rows have no model recorded.`,
    unrecordedSettled: (settled: number) =>
      `${settled} of those have settled and count toward the win rate.`,
    // The row count was unreadable but the settled count was not. The settled
    // count is the one feeding the win rate, so a missing row count must not
    // take this whole warning off the screen with it.
    unrecordedSettledOnly: (settled: number) =>
      `${settled} settled trade${settled === 1 ? "" : "s"} count toward the win rate with no model recorded.`,
    unrecordedNote:
      "That means the record is missing, not that a default model was used. It cannot be filled in afterwards.",
  },

  ruleFit: {
    title: "Rules consulted",
    summary: (matched: number, total: number) =>
      `${total} shown, ${matched} of which fit today's market.`,
    heldBack: (n: number) => `${n} more were left out for length, furthest from today's market first.`,
    verdicts: {
      match: "fits",
      off: "different situation",
      unknown: "cannot compare",
    },
    axes: {
      adx: "ADX",
      rsi: "RSI",
      stretch: "distance from SMA20",
      bb_pos: "position in the band",
      htf_adx: "higher-timeframe ADX",
    },
    missed: (axes: string[]) => `Outside on: ${axes.join(", ")}`,
    evidence: (cases: number, cited: number) =>
      cases === cited
        ? `Compared against all ${cited} plans it was drawn from.`
        : `Only ${cases} of the ${cited} plans it cites still carry the reading of the day; compared against those.`,
    claimed: "AI says used",
    claimedNote:
      "\"AI says used\" marks the rules the analyst itself said it applied on this call, not anything the server measured (a run that said nothing carries no marks).",
    claimedNone:
      "The analyst itself reported using none of these rules on this call. The server's own verdicts above are separate and stand as they are.",
    ruleGone: (id: string) => `(${id}: text unavailable)`,
    note:
      "The \"fits\" verdict is a mechanical comparison the server made between today's readings and those measured on the past plans each rule was drawn from (ADX, RSI, distance from SMA20 in ATR, position in the Bollinger band, higher-timeframe ADX). It is not a claim made by the rule's own text. The rules are learned from every account's record, so the evidence counts include plans that are not in your own history.",
  },

  analysisMode: {
    label: "Mode:",
    full: "Full analysis (technical + fundamental)",
    technical_only: "Technical only",
    technical_fallback: "Technical only (news search was unavailable)",
  },

  reuse: {
    // Not "last time": the lookup takes the newest row with the same key,
    // which need not be the run immediately before this one.
    title: "This input matched a run you were already answered on, so that answer is shown again",
    body:
      "The market data, the learned rules and the settings were byte-for-byte what they were on that run " +
      "(this only happens on runs that did not use the news search — when one did, what it read cannot be shown to be the same, so nothing is reused). " +
      "Analysing the same input again only samples the model's noise: replayed on identical input, 10 of 48 runs flipped between SELL and WAIT.",
    analyzedAt: (at: string) => `This result is the analysis from ${at}.`,
    clockNote: "Only the clock differs. The session and the distance to the next event are read as of that time.",
    // The refund is best-effort, so only claim it when it landed.
    creditReturned: "No analysis credit was used.",
    creditNotReturned: "A credit was spent to start this run and could not be handed back — your remaining count is one lower.",
    forceButton: "Analyse again anyway (uses a credit)",
  },

  preview: {
    title: "Preview — the market is shut",
    body:
      "This is a reading up to the last close. There is no price to enter at, so no entry, stop or targets were issued. " +
      "The run is kept in your history and counts towards nothing: not the win rate, not the expectancy, not the rules.",
    opensAt: (at: Date) =>
      `Plans resume from ${at.toLocaleString("en-GB", {
        month: "short",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}.`,
  },

  position: {
    registerButton: "Register entry (I entered at this price)",
    registerTitle: "Register entry",
    registerHint: "Record the price and time you actually entered on this plan, and the next analysis shows a separate held-position judgement. The original plan is never rewritten.",
    fillPrice: "Fill price",
    fillTime: "Fill time (optional)",
    fillTimeHint: "Left blank, the time of registration is recorded",
    timePreview: (at: string) => `Will be recorded as: ${at}`,
    registerSubmit: "Register",
    registering: "Registering…",
    registered: "Position registered",
    registeredChip: "Position registered",
    closedAlready: (price: string, at: string) => `Closed at ${price} (${at})`,
    alreadyOpen: (price: string) => `This position was already registered (recorded fill ${price})`,
    registerPrevious: "Holding the previous plan? Register it",
    registerErrors: {
      not_signed_in: "Sign in first",
      entry_price_must_be_positive: "The fill price must be greater than 0",
      analysis_not_found: "That plan was not found (only your own analyses can be registered)",
      plan_is_not_a_trade: "A WAIT has no position to register",
      plan_is_a_preview: "A preview (closed-market read) has no position to register",
      plan_is_a_shadow: "A refused plan's shadow row cannot be registered",
      plan_has_no_levels: "This plan has no recorded stop / TP1, so a held position cannot be evaluated",
      fill_outside_plan: "The fill price is not between the stop and TP1, so the plan's levels cannot evaluate it",
      opened_before_plan: "The fill time is before the plan was written",
      opened_in_future: "The fill time is in the future",
      time_unreadable: "That time could not be read",
      position_not_open: "That position is not open (already closed, or not yours)",
      close_price_must_be_positive: "The close price must be greater than 0",
      close_reason_invalid: "Invalid close reason",
      closed_before_open: "The close time is before the position was opened",
      closed_in_future: "The close time is in the future",
      pair_invalid: "Currency pair is not in the expected form (e.g. USD/JPY)",
      interval_invalid: "Unsupported timeframe (15min, 1h, 4h or 1day)",
      direction_invalid: "Choose buy or sell",
      stop_loss_must_be_positive: "Stop loss must be a number greater than 0",
      take_profit_1_must_be_positive: "Take profit 1 must be a number greater than 0",
      levels_incoherent: "The levels do not line up. For a buy: stop < fill < TP1. For a sell: TP1 < fill < stop.",
      targets_out_of_order: "The take-profits are out of order (TP3 without TP2 is not accepted either)",
      generic: "Could not register. Please try again later",
    },
    openTitle: "Open positions",
    own: {
      button: "Register a position you hold",
      title: "A position you already hold",
      hint: "Register a position even if it did not come from one of the app's plans. Enter the stop and take-profit YOU set. From the next analysis on, the held-position verdict uses those levels.",
      notCounted: "This position does not enter the app's record. It was not the app's call.",
      whyLevels: "The stop and take-profit are required because without them there is no open R and no stop-touch to measure, and the held-position verdict can say nothing.",
      pair: "Currency pair",
      interval: "Review timeframe",
      direction: "Direction",
      buy: "Buy",
      sell: "Sell",
      fillPrice: "Fill price",
      stopLoss: "Stop loss",
      tp1: "Take profit 1",
      tp2: "Take profit 2 (optional)",
      tp3: "Take profit 3 (optional)",
      fillTime: "Fill time (optional)",
      fillTimeHint: "Left blank, the time of registration is recorded. An old fill is fine",
      submit: "Register",
      cancel: "Cancel",
      registered: "Position registered",
    },
    openedAt: "Opened",
    openedAtRegistered: "time of registration",
    planTimeframe: "plan timeframe",
    ownTimeframe: "review timeframe",
    heldSubtitleOwn: "Your registered position, judged on the levels you registered. There is no plan behind it. Separate from the new-entry call.",
    closeButton: "I closed it",
    closedChip: (price: string, at: string) => `Closed at ${price} (${at})`,
    verdictBeforeClose: "Verdict before the close",
    closeTitle: "Record the close",
    closePrice: "Close price",
    closeTime: "Close time (optional)",
    closeTimeHint: "Left blank, the time it is recorded is used",
    closeReason: "Reason",
    closeReasons: { manual: "Manual", stop: "Stop hit", target: "Target hit", other: "Other" },
    closeSubmit: "Record",
    closing: "Recording…",
    closed: "Close recorded",
    cancel: "Cancel",
    latestVerdict: "Latest verdict",
    verdictAt: (at: string) => `as of ${at}`,
    noVerdictSinceRegistration: "No analysis since registration yet (analyse this pair to get one)",
    verdictNotCovered: "The latest analysis reviewed a different position (the newest one)",
    verdictLookupFailed: "The latest analysis could not read the positions",
    noVerdictInRecent: (n: number) => `no verdict in the last ${n} rows`,
    verdictStale: "not re-evaluated since",
    otherOpen: (n: number) => `${n} other open position(s); this verdict covers the newest only`,
    intervalDiffers: (registered: string, now: string) => `registered on the ${registered} plan; this analysis is ${now}`,
    heldTitle: "Held position",
    heldSubtitle: "Your registered position, judged on its original plan's thesis and levels. Separate from the new-entry call.",
    verdicts: {
      hold: "HOLD",
      caution: "CAUTION",
      exit_condition_met: "EXIT CONDITION MET",
      undecidable: "UNDECIDABLE",
    },
    verdictGloss: {
      hold: "The thesis is intact and no exit condition is met",
      caution: "The thesis has weakened or adverse facts have appeared; no exit condition is met",
      exit_condition_met: "The plan's own exit condition has been reached",
      undecidable: "Not enough material, or the original thesis cannot be evaluated",
    },
    verdictGlossOwn: {
      hold: "None of the exit conditions you registered is met",
      caution: "Adverse facts have appeared; none of the exit conditions you registered is met",
      exit_condition_met: "An exit condition you registered has been reached",
      undecidable: "Not enough material to judge",
    },
    decidedByAnalyst: "The model's verdict",
    decidedByServerTouch: (at: string, feed: string, forming: boolean) =>
      `Measured by the server: the stop level was touched (${feed}, bar ${at}${forming ? ", still forming" : ""})`,
    decidedByServerTracker: (outcome: string, basis: string, at: string) =>
      `Tracker verdict: ${outcome} (${basis}, ${at})`,
    decidedByIncoherent: (verdict: string, thesis: string) =>
      `The model contradicted itself, so no verdict is relayed (it answered ${verdict} with the thesis ${thesis})`,
    analystUnavailable: (reason: string) => `The model's verdict could not be obtained (${reason})`,
    failReasons: {
      time_budget: "out of time",
      api: "model call failed",
      parse: "answer unreadable",
      lookup: "reference lookup failed",
      no_model: "no model configured",
      finalise: "verdict assembly failed",
      unknown: "unknown",
    },
    suppressed: {
      settled_before_open: (at: string) =>
        `The tracker settled this plan as a loss, but that settlement (${at}) predates your fill, so it is not used as an exit condition`,
      settled_before_registration: (at: string) =>
        `The tracker settled this plan as a loss on a bar (${at}) before you registered the position. When you actually filled is not recorded, so it is not used as an exit condition`,
      registered_after_settlement: "This position was registered after the tracker had settled the plan, so the tracker's verdict is not used as an exit condition",
    },
    facts: {
      title: "Measured by the server",
      price: "Price now",
      priceAt: (price: string, at: string) => `${price} (${at})`,
      open: "Open P&L",
      hypothetical: "If filled at the plan's entry (hypothetical)",
      toStop: "To stop",
      toTp1: "To TP1",
      beyond: "already beyond",
      stopTouch: "Stop touched",
      tp1Touch: "TP1 reached",
      touched: (at: string, forming: boolean) => `yes (bar ${at}${forming ? ", still forming" : ""})`,
      notTouched: (asOf: string, n: number) => `no (through ${asOf}, ${n} bars)`,
      notMeasured: {
        no_anchor: "not measured (no anchor time)",
        series_starts_after_anchor: "not measured (the fetched bars do not reach back to the fill)",
        no_bars_since_anchor: "not measured (no bars since the fill yet)",
      },
      notMeasuredPriced: {
        no_anchor: "not measured (no anchor time)",
        series_starts_after_anchor: "not measured (the fetched bars do not reach back to the previous call's price time)",
        no_bars_since_anchor: "not measured (no bars since the previous call's price time yet)",
      },
      midOnly: "mid price only; not measured on the exit side's bid/ask",
      feed: { twelve_data: "mid, Twelve Data", gmo: "mid, GMO Coin" },
      feedDiffers: "Touches are measured on this run's bars. The original plan was priced on a different feed (they differ by up to 0.15 ATR)",
      tracker: "Tracker",
      trackerBasis: { quotes: "bid/ask", mid: "mid", none: "basis not recorded" },
      trackerPending: "not settled",
      trackerUnknown: "the plan row could not be read",
      trackerNoPlan: "no plan to settle",
      basisNote: "A stop touch on the mid counts as the exit condition. No touch on the mid, and TP1 reached on the mid, are facts on the mid only; the tracker's bid/ask verdict is shown beside them, not merged.",
    },
    thesis: {
      heldLabel: "Original plan's thesis",
      noPlan: "No plan behind this one. The direction, stop and TP1 you registered are the thesis; the review judges whether the market still supports that direction",
      previousLabel: "Previous call's thesis",
      byAnalyst: "model's reading",
      status: { intact: "intact", weakened: "weakened", broken: "broken", unknown: "unknown" },
      unavailable: "unavailable",
    },
    whatChanged: "What changed",
    reasons: "Reasons",
    watch: "Watch",
    notAnInstruction: (signal: string) =>
      `The new-entry call below (${signal}) answers "open a new position now?". It is not an instruction to close the position you hold.`,
    reversedNote: (held: string, fresh: string) =>
      `The new-entry call (${fresh}) is the opposite direction to your held ${held}. It is a separate call and does not change the held-position verdict above.`,
    stopReached: (basis: string) => `The previous plan's stop level has already been reached (${basis})`,
    changeTitle: "Since the previous call",
    changeHeader: (prev: string, cur: string) => `Previous ${prev} → now ${cur}`,
    withConfidence: (signal: string, confidence: number | null) =>
      confidence === null ? signal : `${signal} ${confidence}%`,
    kinds: {
      sameTrade: (dir: string) => `The model calls ${dir} again`,
      sameWait: "The model itself stood aside both times",
      reversed: (prev: string, cur: string) => `The model changed direction from ${prev} to ${cur}`,
      tradeToWait: "The model declined a NEW entry this time (its own call)",
      waitToTrade: (cur: string) => `Previously stood aside; now calls ${cur}`,
      unclear: "The previous run's proposed signal was not recorded, so the two cannot be compared",
    },
    refusedNow: (reason: string) => `but the server declined to publish it this time (${reason})`,
    refusedThen: (reason: string) => `the server had declined to publish the previous one (${reason})`,
    gateRr: (rr: number) => `Gate measurement this run: RR 1:${rr}`,
    gateNone: "No fresh plan was issued this run, so the gate measured nothing",
    previousLevelsRefused: "The previous levels were proposed by the model and the server declined to publish them",
    previousWasWait: "The previous call stood aside (no levels)",
    previousLevelsUnrecorded: "The previous levels were not fully recorded",
    noiseNote: "The same input can split the model's call. Trust the headline only where a named measured fact backs it.",
  },

  index: {
    emptyLine1: "Press “Analyze” to pull",
    emptyLine2: "multi-timeframe data and run the AI analysis",
    upgradeTitle: "Get signals by email",
    upgradeBody: "With the Light plan (¥2,980 a month): the indicators, and an email when a GA-style or RSI + SAR signal fires",
    upgradeCta: "Upgrade",
    limitTitle: "You have hit today's analysis limit",
    limitBody: "Upgrade your plan to run more analyses",
    disclaimer:
      "The chart, the signals and the emails are information for reference, not investment advice. FX trading carries risk and losses can exceed your deposit. Every trading decision is your own responsibility.",
  },

  errors: {
    loginRequired: "Please sign in",
    limitReached: "You have hit today's analysis limit",
    limitReachedBody: "Please upgrade your plan",
    adminNotDeployed: "Admin mode not live",
    adminNotDeployedBody: "Redeploy the analyze edge function to enable the admin bypass",
    noResult: "No analysis came back. Please try again.",
    network: "Could not reach analyze. Check that the function is deployed and CORS is configured.",
    generic: "Something went wrong during analysis",
    wallClock: "The analysis took too long and was stopped. Turning off “Factor in economic news and data” makes it faster.",
    server: (status: number) => `Server error (${status})`,
    render: "Something went wrong rendering this page",
    renderBody: "Please reload the page and try again.",
    signIn: "That email address or password is not correct",
    signInOther: (m: string) => `Sign-in error: ${m}`,
  },

  password: {
    tooShort: (n: number) => `Password must be at least ${n} characters`,
    needsBoth: "Password must contain both letters and digits",
    alreadyRegistered: "That email address is already registered",
    leaked: "This password has appeared in a known breach. Please choose a different one.",
    weak: "Mix letters and digits (and symbols, depending on the settings) into your password",
    signUpOther: (m: string) => `Sign-up error: ${m}`,
  },

  login: {
    orContinueWith: "or",
    withGoogle: "Continue with Google",
    withApple: "Continue with Apple",
    providerOff: "This sign-in method is not available right now. Please use your email and password.",
    providerFailed: (detail: string) => `Could not start sign-in: ${detail}`,
    socialNote: "If the address matches an account you already have, you will be signed into that same account.",
    createAccount: "Create an account",
    signInToStart: "Sign in to get started",
    email: "Email address",
    password: "Password",
    passwordPlaceholder: (n: number) => `${n}+ characters, letters and digits`,
    confirmPassword: "Confirm password",
    confirmPlaceholder: "Type it again",
    submitSignUp: "Create account",
    submitSignIn: "Sign in",
    haveAccount: "Already have an account?",
    noAccount: "Don't have an account?",
    bothRequired: "Please enter your email address and password",
    mismatch: "Passwords do not match",
    created: "Account created. Redirecting…",
    genericError: "Something went wrong",
    consentBefore: "By creating an account you agree to the ",
    consentMiddle: " and the ",
    consentAfter: ".",
    disclaimer: "The chart, the signals and the emails are information for reference, not investment advice.",
  },

  settings: {
    title: "Settings",
    saved: "Settings saved",
    planSection: "Plan",
    currentPlan: "Current plan",
    adminNote: "This is an admin account, so every feature is unlimited without a subscription.",
    nextBilling: "Next billing date",
    cancelDate: "Cancellation date",
    cancelPendingUntil: (d: string) => `Cancelling — usable until ${d}`,
    cancelDone: "Cancellation requested",
    cancelPlan: "Cancel plan",
    upgrade: "Upgrade plan",
    pair: "Currency pair",
    cancelTitle: "Cancel your plan?",
    cancelBody: (plan: string) => `This cancels the ${plan} plan. You keep it until the end of the current period.`,
    cancelBody2: "After that the account switches to the Free plan automatically.",
    cancelConfirm: "Cancel plan",
    cancelFailed: "Cancellation failed",
    cancelSucceeded: "Cancellation complete",
    cancelUsableUntil: (d: string) => `Usable until ${d}`,
  },

  pricing: {
    back: "Back to dashboard",
    title: "Pricing",
    subtitle: "The chart is free. Indicators and email alerts for signals come with the Light plan",
    current: (p: string) => `Current plan: ${p}`,
    adminNote: "This is an admin account — every feature is unlimited, no subscription needed",
    recommended: "Recommended",
    inUse: "Current plan",
    subscribe: "Subscribe",
    perMonth: "/month",
    adminToastTitle: "Admin account",
    adminToastBody: "Every feature is available without a subscription",
    features: {
      free: ["The live chart (5 pairs and gold, 1-minute to daily bars)", "GA-style and RSI + SAR signals on the chart"],
      light: ["Everything in Free", "Indicators (stochastic, Bollinger %b, RCI, SuperTrend, UT Bot, Dow theory and more)", "Email alerts for signals (GA style, RSI + SAR; pick the pairs and timeframes)", "The record of the signals emailed"],
    },
    freeIncluded: "Included when you sign up",
  },

  lp: {
    nav: { features: "Features", pricing: "Pricing", faq: "FAQ" },
    heroBefore: "Signals with their record ",
    heroHighlight: "in plain sight",
    heroAfter: ".",
    heroLine2: "A live chart, and email alerts for buy and sell signals.",
    subtitleBefore: "The chart draws two kinds of signal: ",
    subtitleCount: "GA style and RSI + Parabolic SAR",
    subtitleAfter: ". Both are judged on closed bars only, so they never vanish or move afterwards. Their record on past charts and the real record of the signals emailed are shown as they are, losing ones included.",
    noCard: "Signing up is free, and so is the chart. Indicators and email alerts come with the Light plan (¥2,980 a month)",
    painTitle: "Sound familiar?",
    pains: ["Too many indicators to watch", "Missing the moment a signal fires", "Nobody checks whether the signals were right"],
    featuresTitle: "What Sextant does",
    features: [
      { title: "A live chart", desc: "Five currency pairs and gold (XAU/USD) from 1-minute to daily bars, the price moving every few seconds. With the Light plan, the stochastic, Bollinger %b, RCI, SuperTrend, UT Bot, Dow theory and more to switch on" },
      { title: "Email alerts for signals", desc: "Pick the pairs and timeframes: when a GA-style or RSI + SAR signal fires on a closed bar, an email arrives within minutes (Light plan)" },
      { title: "The record in plain sight", desc: "Every signal emailed is followed to its stop or its target and recorded, beside how the rule did on past charts. Losing numbers are shown as they are" },
    ],
    stepsTitle: "Three steps",
    steps: [
      { title: "Create an account", sub: "Takes 30 seconds" },
      { title: "Open the chart", sub: "Free" },
      { title: "Indicators and email alerts", sub: "Light plan, ¥2,980 a month" },
    ],
    pricingTitle: "Simple pricing",
    pricingDetails: "See full pricing",
    choosePlan: "Start with this plan",
    honestTitle: "Why we quote no win rate",
    honestBody: "On past charts (11 pairs, spread paid), none of the app's signals reached the win rate needed to break even. A signal is not an order to trade; it is something to weigh. The real record of the signals emailed is shown in the app, with how many there were.",
    faqTitle: "Frequently asked questions",
    faqs: [
      { q: "What is Sextant?", a: "A live FX chart with email alerts for buy and sell signals. Two kinds of signal, GA style and RSI + Parabolic SAR, are judged on closed bars and drawn on the chart." },
      { q: "How is it different from other tools?", a: "It does not hide the record. How each rule did on past charts, and whether each signal emailed reached its stop or its target first, are shown as they are, losing ones included. Signals are judged on closed bars only and never vanish or move afterwards." },
      { q: "What is the win rate?", a: "On past charts (11 pairs, spread paid), none of the signals reached the win rate needed to break even. The numbers are in the app's notes. Please do not take them as a reason to expect to win." },
      { q: "Is this investment advice?", a: "No. The service provides a chart and signals as information, and is not an investment advisory business. Every trading decision and its outcome are your own." },
      { q: "Which currency pairs are covered?", a: "The live chart covers USD/JPY, EUR/USD, GBP/USD, EUR/JPY, GBP/JPY and gold (XAU/USD). Email alerts can be set for USD/JPY, EUR/USD, GBP/USD, EUR/JPY, GBP/JPY, AUD/USD and AUD/JPY on 15-minute, 1-hour, 4-hour and daily bars." },
      { q: "Can I use it for free?", a: "Yes. With an account the live chart and its signals are free. The indicators and email alerts for signals come with the Light plan (¥2,980 a month)." },
      { q: "When do the emails arrive?", a: "Within minutes of the bar closing. Signals on 15-minute and 1-hour bars closing 17:00–23:59 UTC are not emailed, as those hours lost most on past charts (they stay in the app's log)." },
      { q: "Which technical indicators are used?", a: "Two kinds of signal: GA style (engulfing, a large body, RSI(14), against the close 5 bars back) and RSI(9) with the Parabolic SAR (0.02, 0.2) (RSI back from 25 or 75, the SAR on the same side). Stops and targets use ATR(14). With the Light plan the chart can also show the stochastic, Bollinger %b, RCI, SuperTrend, UT Bot, Dow theory and more (shown only, no signal uses them)." },
      { q: "Can I cancel anytime?", a: "Yes — cancel from your account page at any time. You keep access until the end of the paid period." },
    ],
    ctaTitle: "Get started",
    ctaBody: "Creating an account takes 30 seconds",
    shareTitle: "Share Sextant",
    shareBody: "Share this tool with friends and followers",
    shareText: "Found an FX chart that shows its signals' record as it is: a free live chart, with email alerts for buy and sell signals. #FX #trading",
    aria: { nav: "Main navigation", hero: "Hero", pain: "Pain points", features: "Features", steps: "Steps", pricing: "Pricing", honest: "Why we quote no win rate", faq: "FAQ", cta: "Sign-up call to action", share: "Share on social media", footerNav: "Footer navigation" },
  },
  landing: {
    login: "Sign in",
    startFree: "Get started",
    terms: "Terms of Service",
    privacy: "Privacy Policy",
    tokushoho: "Commercial Transactions Act notice",
    contact: "Contact",
    footerNote: "This service is not investment advice. FX trading carries risk.",
    // Share strings for the landing page's own SNS buttons. They lived under
    // `blog` until the blog was removed; the buttons are the landing page's,
    // so the keys moved here rather than being deleted with it.
    share: {
      shareX: "Share on X",
      shareLine: "Share on LINE",
      copyLink: "Copy link",
      copied: "Copied",
      copiedToast: "Link copied",
      copyFailed: "Could not copy the link",
    },
  },

  contact: {
    title: "Contact",
    intro: "For questions, requests or bug reports, use the form below. We reply within three business days.",
    mail: "Email: support@fx-tactical-analyzer.com",
    name: "Name",
    namePlaceholder: "Jane Doe",
    email: "Email address",
    subject: "Subject",
    subjectPlaceholder: "What is your message about?",
    message: "Message",
    messagePlaceholder: "Type your message here",
    send: "Send",
    sending: "Sending…",
    sentTitle: "Sent",
    sentBody: "We have received your message and will reply within three business days.",
  },

  // #105: email alerts for the RSI + Parabolic SAR signal
  alerts: {
    title: "Email alerts (buy/sell signals)",
    intro: (email: string) =>
      `When the kind chosen below (RSI + SAR, GA style, Q-Trend or ULTRA) fires a BUY or SELL on a chart you tick, we email ${email}. It arrives a few minutes after the bar closes.`,
    introNoEmail: "When the kind chosen below (RSI + SAR, GA style, Q-Trend or ULTRA) fires a BUY or SELL on a chart you tick, we email the address you signed in with.",
    proOnly: "Email alerts are a Light plan feature (¥2,980 a month).",
    notConfigured: "Email sending is not set up yet. Signals are logged below, but no email can be delivered for now.",
    loading: "Loading…",
    loadFailed: "Could not load your alert settings",
    saveFailed: "Could not save",
    pairHeader: "Pair",
    intervals: { "5min": "5m", "15min": "15m", "1h": "1h", "4h": "4h", "1day": "1D" } as Record<string, string>,
    ruleTabs: { rsi_sar: "RSI + SAR", gainz: "GA style", qtrend: "Q-Trend", ultra: "ULTRA" } as Record<string, string>,
    ruleTabsLabel: "Which signal to email",
    gainzIntro:
      "GA style is the GainzAlgo V2 Alpha-style signal (engulfing, large body, RSI 40, against 5 bars ago; stop 1 ATR, target 2× the stop). It is a reproduction of the GainzAlgo Suite settings, its numbers then set in #132 to the ones that won most often on past charts (a 70% body, RSI 40, 5 bars ago); its logic is not published, so the signals may differ.",
    gainzNotes: [
      "On past charts (2025-07 to 2026-09, 11 pairs, spread paid, #132's settings) it won 30.1% with −0.093R per trade on average, short of the 33.3% break-even; its difference from entering at random was within noise.",
      "On 15-minute charts it fires about once every two or three days per pair (with #132's settings, about a sixth as often as before).",
      "On 15-minute and 1-hour charts, signals from bars closing 17:00–23:59 UTC are not emailed (they stay in the log).",
    ],
    ruleTag: { rsi_sar: "", gainz: " (GA)", qtrend: " (Q-Trend)", ultra: " (ULTRA)" } as Record<string, string>,
    // #155
    strongTag: " STRONG",
    indicatorIntro: {
      qtrend: "Q-Trend's BUY, SELL and STRONG signals (tarasenko_'s open-source script, at 200, 14, 1): the same marks the live chart draws.",
      ultra: "ULTRA's Buy ☆ and Sell ☆ signals (built from F-INVEST's video): the same marks the live chart draws, with a stop (30 pips on a currency pair, $10 on gold) and targets 1 to 3 (5, 10, 15) in the email.",
    } as Record<string, string>,
    allPairs: "All symbols",
    indicatorHourOnly: "Symbols GMO Coin does not carry are on the 1-hour, 4-hour and daily charts only",
    indicatorNotes: [
      "Judged on the live chart's own bars with its own code. Emails arrive a minute to three after the bar closes (the symbols GMO Coin does not carry can take up to about 30 minutes: Twelve Data is read a few at a time).",
      "The 16 symbols GMO Coin does not carry (15 pairs such as USD/CAD and HKD/JPY, and gold) are read from Twelve Data's free allowance (800 reads a day, shared with the chart), so on the 1-hour, 4-hour and daily charts only.",
      "Every symbol on the 5- and 15-minute charts can mean hundreds of emails a day. The mail service's (Resend's) free plan sends 100 a day and 3,000 a month; the rest show as failed.",
      "Neither Q-Trend nor ULTRA has been tested on past charts here. An alert is not an instruction to trade, and no record of their outcomes is kept.",
      "Nothing is judged while the market is shut (weekends and the like).",
    ],
    notes: [
      "On 15-minute charts the spread alone costs about 14% of the stop every trade; 4-hour (about 6%) and daily charts cost less.",
      "On 15-minute and 1-hour charts, signals from bars closing 17:00–23:59 UTC are not emailed: past charts lost most in those hours (they stay in the log).",
      "The daily chart was not part of the test on past charts.",
      "Prices are GMO Coin's public rates (bid/ask).",
      "On past charts this rule has not reached the win rate needed to break even (40%). An alert is not an instruction to trade.",
    ],
    test: "Send a test email",
    testSent: "Test email sent",
    testNotConfigured: "Email sending is not set up yet, so no test email was sent",
    testFailed: "Could not send the test email",
    testCooldown: "One test email every 5 minutes",
    recentTitle: "Recent alerts",
    none: "No alerts yet",
    testRow: "Test email",
    status: {
      pending: "Sending",
      sent: "Sent",
      failed: "Failed",
      not_configured: "Not sent (email not set up)",
      skipped: "Not emailed",
    } as Record<string, string>,
    skipReasons: { costly_hours: "Not emailed (costly hours)" } as Record<string, string>,
    sides: { BUY: "Buy", SELL: "Sell" } as Record<string, string>,
    plan: (entry: string, stop: string, target: string) => `Entry ${entry} / Stop ${stop} / Target ${target}`,
    // #108: the live record of what each signal did afterwards
    record: {
      title: "How the alerts did (recorded from the prices that followed)",
      titleFor: (rule: string) => `How the ${rule} alerts did (recorded from the prices that followed)`,
      rNoteGainz: "R is the result in units of the stop distance: for GA style, +2R is a win of twice the stop, −1R a loss of the stop.",
      mine: "Alerts sent to you",
      all: "Every signal on the 7 pairs (in the hours alerts are sent)",
      none: "No signal has settled yet",
      line: (n: number, w: number, l: number, e: number) => `${n}: ${w} won, ${l} lost, ${e} expired`,
      stats: (win: string, mean: string) => `Win rate ${win} / average ${mean} a trade`,
      ci: (half: string) => ` (±${half})`,
      open: (n: number) => `${n} still open`,
      backtest: (period: string, win: string, mean: string, be: string) =>
        `What past charts suggested (${period}): win rate ${win}, average ${mean}. Breaking even takes ${be}.`,
      rNote: "R is the result in units of the stop distance: +1.5R is a win of 1.5 times the stop, −1R a loss of the stop.",
      small: "Below 30 signals chance dominates: read nothing into the numbers yet, good or bad.",
      method:
        "Each signal is entered at its bar's close (the ask for a buy, the bid for a sell) and settled by whichever of the emailed stop and target is reached first. After 48 bars it is closed at the market; a bar that reaches both counts as a loss.",
    },
    outcome: {
      win: "Won",
      loss: "Lost",
      ambiguous: "Lost (both in one bar)",
      expired: "Expired",
      no_data: "No data",
    } as Record<string, string>,
    pendingResult: "Open",
  },

  legal: {
    japaneseAuthoritative:
      "This page is a Japanese legal document and is provided in Japanese only. The Japanese text is the authoritative version.",
  },
};
