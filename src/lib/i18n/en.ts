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
    intervals: { "15min": "15m", "1h": "1H", "4h": "4H", "1day": "1D" },
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
    distance: (pips: number, atr: number | null) =>
      atr === null ? `${pips} pips` : `${pips} pips · ${atr}× ATR`,
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
    detail: "Full analysis",
    marketContext: "Market context and levels",
    warnings: "Warnings",
    waitReason: {
      label: "Why it is a WAIT",
      ownLowConfidence: "The model's own confidence was below the floor we publish at, so no entry, stop or targets were issued",
      refused: (word: string, gloss: string) => `The model's ${word} (${gloss}) was refused server-side and published as WAIT`,
      atrMultiple: (n: number) => `${n}× ATR`,
      confidence: (score: number, floor: number) => `confidence ${score}, floor ${floor}`,
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
  },

  technical: {
    title: "Market data summary",
    currentRate: "Current rate",
    overbought: " (overbought)",
    oversold: " (oversold)",
    tenkan: "Ichimoku Tenkan",
    kijun: "Ichimoku Kijun",
    spanA: "Ichimoku Span A (26 ahead)",
    spanB: "Ichimoku Span B (26 ahead)",
    cloudNow: "Cloud at price (computed 26 bars ago)",
    cloudTop: "top",
    cloudBottom: "bottom",
    indicators: "Indicator readings",
    cloudSides: { above: "price above the cloud", inside: "price inside the cloud", below: "price below the cloud" },
    forming: "this bar has not closed"
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
    },
    scope: (n: number) => `last ${n}`,
    statsScope: (n: number) => `Record: ${n} calls, all time`,
    statsScopeContract: (n: number, contract: string) => `Record: ${n} calls, all time (${contract})`,
    statsFallback: (n: number) => `Record: from the last ${n} rows only — the server totals could not be fetched`,
    otherContractRows: (n: number) => `${n} calls made under a different entry contract are not counted here`,
    autoNote: "Judged automatically every 15 minutes against actual prices (TP1 reached = WIN, SL reached = LOSS)",
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
        `${n} call${n === 1 ? " was" : "s were"} the model's own decision to stand aside — these were not server refusals.`,
      shadowNote: (s: { untriggered: number; wins: number; losses: number; open: number }) =>
        `Refused plans tracked anyway: no fill ${s.untriggered} / WIN ${s.wins} / LOSS ${s.losses} / open ${s.open}`,
      rejectedTitle: "Plan refused server-side",
      rejectedSummary: "The model's plan was refused server-side and published as WAIT",
      declinedSummary: "The model declined to trade — this was not a server refusal",
      reasons: {
        too_far: "Entry too far from the market (would not fill)",
        should_be_market: "Waits for a pullback in a running trend (would not fill)",
        stop_too_tight: "Stop inside the noise (would be hit by it)",
        poor_rr: "Risk/reward does not pay",
        target_out_of_reach: "Target too far to be reached in time",
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
    note: "Generated automatically from reviews against actual prices, and put in front of the model on every new analysis",
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
    registerSubmit: "Register",
    registering: "Registering…",
    registered: "Position registered",
    registeredChip: "Position registered",
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
      position_not_open: "That position is not open (already closed, or not yours)",
      close_price_must_be_positive: "The close price must be greater than 0",
      close_reason_invalid: "Invalid close reason",
      generic: "Could not register. Please try again later",
    },
    openTitle: "Open positions",
    openedAt: "Opened",
    openedAtRegistered: "time of registration",
    planTimeframe: "plan timeframe",
    closeButton: "I closed it",
    closeTitle: "Record the close",
    closePrice: "Close price",
    closeReason: "Reason",
    closeReasons: { manual: "Manual", stop: "Stop hit", target: "Target hit", other: "Other" },
    closeSubmit: "Record",
    closing: "Recording…",
    closed: "Close recorded",
    cancel: "Cancel",
    latestVerdict: "Latest verdict",
    verdictAt: (at: string) => `as of ${at}`,
    noVerdictSinceRegistration: "No analysis since registration yet (analyse this pair to get one)",
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
      registered_after_settlement: "This position was registered after the tracker had settled the plan, so the tracker's verdict is not used as an exit condition",
    },
    facts: {
      title: "Measured by the server",
      price: "Price now",
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
      midOnly: "mid price only; not measured on the exit side's bid/ask",
      feed: { twelve_data: "mid, Twelve Data", gmo: "mid, GMO Coin" },
      feedDiffers: "Touches are measured on this run's bars. The original plan was priced on a different feed (they differ by up to 0.15 ATR)",
      tracker: "Tracker",
      trackerBasis: { quotes: "bid/ask", mid: "mid", none: "basis not recorded" },
      trackerPending: "not settled",
      basisNote: "A stop touch on the mid counts as the exit condition. No touch on the mid, and TP1 reached on the mid, are facts on the mid only; the tracker's bid/ask verdict is shown beside them, not merged.",
    },
    thesis: {
      heldLabel: "Original plan's thesis",
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
    noiseNote: "The same input can split the model's call. Trust the headline only where a named measured fact backs it.",
  },

  index: {
    emptyLine1: "Press “Analyze” to pull",
    emptyLine2: "multi-timeframe data and run the AI analysis",
    upgradeTitle: "Upgrade to unlock everything",
    upgradeBody: "Higher daily limits, every technical indicator, and priority support",
    upgradeCta: "Upgrade",
    limitTitle: "You have hit today's analysis limit",
    limitBody: "Upgrade your plan to run more analyses",
    disclaimer:
      "This analysis is AI-generated reference information, not investment advice. FX trading carries risk and losses can exceed your deposit. Every trading decision is your own responsibility.",
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
    disclaimer: "This analysis is AI-generated reference information, not investment advice.",
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
    subtitle: "Pick the plan that fits how you trade",
    current: (p: string) => `Current plan: ${p}`,
    adminNote: "This is an admin account — every feature is unlimited, no subscription needed",
    recommended: "Recommended",
    inUse: "Current plan",
    subscribe: "Subscribe",
    perMonth: "/month",
    adminToastTitle: "Admin account",
    adminToastBody: "Every feature is available without a subscription",
    features: {
      light: ["10 analyses per day", "USD/JPY only", "1H timeframe only"],
      standard: ["30 analyses per day", "All currency pairs", "All timeframes", "Fundamental analysis", "Saved analysis history"],
      pro: ["Unlimited analyses", "Every feature", "Alerts (planned)", "Priority support"],
    },
  },

  lp: {
    nav: { features: "Features", pricing: "Pricing", faq: "FAQ" },
    heroBefore: "It does not just ",
    heroHighlight: "call the trade",
    heroAfter: ".",
    heroLine2: "The AI grades its own calls and works out why the losers lost.",
    subtitleBefore: "AI layers the economic calendar over ",
    subtitleCount: "11",
    subtitleAfter: " technical indicators — RSI, MACD, Bollinger Bands and more — reads the pair across every timeframe, and returns an entry, a stop and targets. Every plan is then scored automatically against real bid/ask prices, and each losing one is traced back to its cause and fed into the rules the AI must follow.",
    noCard: "Creating an account is free. Analysis needs a paid plan, from ¥2,980/month",
    painTitle: "Sound familiar?",
    pains: ["Too many indicators to watch", "Never sure when to enter", "Nobody ever checks whether the tool was right"],
    featuresTitle: "What Sextant does",
    features: [
      { title: "Data pulled automatically", desc: "Live prices plus RSI, MACD, Bollinger Bands, Ichimoku and 11 indicators in all, together with this week's economic calendar" },
      { title: "Four timeframes measured at once", desc: "15m, 1h, 4h and daily each get their own swing highs and lows, the levels a close has broken, and the room left to the next standing level. Where the timeframes disagree, it says so" },
      { title: "Only closed bars are counted", desc: "The forming bar and the flat stretches from hours when the market was shut are dropped before any indicator is computed, so a weekend does not bend the numbers" },
    ],
    stepsTitle: "Three steps to your first analysis",
    steps: [
      { title: "Create an account", sub: "Takes 30 seconds" },
      { title: "Pick a plan", sub: "From ¥2,980/month" },
      { title: "Press “Analyze”", sub: "Results straight away" },
    ],
    pricingTitle: "Straightforward pricing",
    pricingDetails: "See full pricing",
    choosePlan: "Start on this plan",
    loopTitle: "The AI grades its own calls",
    loopBody: "This is what sets it apart. Every plan it issues is tracked server-side, and every losing one has its cause investigated. Nobody has to remember to do it.",
    loopSteps: [
      { title: "Score", desc: "Tracked every 15 minutes until the plan expires, against real quotes: filled, stopped out, or target hit. A buy fills on the ask and closes on the bid, so the spread is on the side it is really on" },
      { title: "Investigate", desc: "Losing plans are replayed past the point they resolved, to work out whether the target was reached after the stop, whether entering at market would have paid, and whether that stop distance was viable at all" },
      { title: "Apply", desc: "The causes it finds rewrite the rules the AI has to follow on the next analysis — and the app shows you each rule with the number of settled trades behind it" },
    ],
    loopLive: (version: number, rules: number, updated: string) =>
      `Rulebook now at v${version} — ${rules} rules, last changed ${updated}`,
    loopLiveNote: "No one wrote these rules by hand; they were derived from the trades that went wrong",
    honestTitle: "Why we quote no win rate",
    honestBody: "We will not publish a win rate until the sample is large enough to mean something. Our threshold is 50 independent settled trades; past that, the app shows it with a 95% confidence interval. We would rather show you nothing than only the flattering numbers.",
    faqTitle: "Frequently asked questions",
    faqs: [
      { q: "What is Sextant?", a: "A tool that measures how a currency pair has moved. It computes 11 indicators — RSI, MACD, Bollinger Bands, Ichimoku and others — together with price structure: recent swing highs and lows, the levels a close has broken, and the room to the next standing level, across 15m, 1h, 4h and daily." },
      { q: "How is this different from other AI analysis tools?", a: "Every call it makes is scored, and every losing call is investigated automatically. Plans are tracked against real bid/ask prices until they expire; the losers are traced back to a cause; and what that turns up is written into the rules the AI must follow. You can read those rules in the app, along with how many settled trades support each one." },
      { q: "What is the win rate?", a: "We do not publish one yet, because the sample is not large enough to mean anything — over a handful of trades a win rate is indistinguishable from luck. Our threshold is 50 independent settled trades, after which the app shows it with a 95% confidence interval." },
      { q: "Is this investment advice?", a: "No. The service provides market analysis, not investment advice or brokerage. Every trading decision, and its outcome, remains yours." },
      { q: "Which currency pairs are supported?", a: "Major pairs including USD/JPY, EUR/USD, GBP/JPY and EUR/JPY. The Light plan covers USD/JPY only; Standard and Pro cover every pair." },
      { q: "Is there a free option?", a: "Creating an account is free and lets you see the plans and the app, but running an analysis requires a paid plan: Light (¥2,980/month), Standard (¥5,980/month) or Pro (¥12,800/month)." },
      { q: "How long does an analysis take?", a: "About 10–15 seconds for technicals only, and about 20–30 seconds when fundamental analysis is included." },
      { q: "Which technical indicators are used?", a: "RSI, MACD, Bollinger Bands, SMAs, Ichimoku, ATR, Stochastics and ADX — 11 in all — applied across 15m, 1H, 4H and daily timeframes." },
      { q: "Can I cancel at any time?", a: "Yes, from your account page at any time. You keep access until the end of the current billing period." },
    ],
    ctaTitle: "Get started now",
    ctaBody: "Creating an account takes 30 seconds",
    shareTitle: "Spread the word",
    shareBody: "Share this tool with friends and followers and help them trade with more discipline",
    shareText: "Found an FX AI that does not just call the trade — it scores every call against real quotes and works out why the losers lost. #FX #AI #trading",
    aria: { nav: "Main navigation", hero: "Hero", pain: "Common problems", features: "Features", steps: "How it works", pricing: "Pricing", loop: "How the scoring and learning loop works", faq: "FAQ", cta: "Sign-up call to action", share: "Share on social media", footerNav: "Footer navigation" },
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

  legal: {
    japaneseAuthoritative:
      "This page is a Japanese legal document and is provided in Japanese only. The Japanese text is the authoritative version.",
  },
};
