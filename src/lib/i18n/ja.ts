// Japanese is the source of truth for the dictionary shape: `Dict = typeof ja`,
// and every other locale is typed as `Dict`, so adding a key here turns every
// untranslated locale into a compile error rather than a silent fallback.
// That matters more than usual here — a missing string in a trading UI is a
// blank where a price or a direction should be.

export const ja = {
  localeName: "日本語",
  // Used for Intl date/number formatting, and sent to the analyze function so
  // the model writes its analysis in the same language the UI is in.
  intlLocale: "ja-JP",

  common: {
    appName: "Sextant",
    cancel: "キャンセル",
    close: "閉じる",
    processing: "処理中...",
    error: "エラー",
    language: "言語",
    dash: "—",
  },

  header: {
    upgrade: "プランをアップグレード",
    changePlan: "プランを変更",
    cancelPending: "(解約予定)",
    signOut: "ログアウト",
    settings: "設定",
  },

  control: {
    intervals: { "15min": "15分足", "1h": "1時間足", "4h": "4時間足", "1day": "日足" },
    analyze: "分析開始",
    analyzing: "分析中...",
    stages: {
      idle: "",
      fetching: "データ取得中...",
      analyzing: "AI分析中...",
      generating_judgment: "総合判断中...",
    },
    remainingToday: (n: number) => `本日の残り: ${n}回`,
    includeFundamental: "経済ニュース・指標も考慮する",
    subscribeToAnalyze: "プランに申し込んで分析する",
    paidFeature: "分析機能は有料プラン専用です",
    fundamentalHelp: "詳細",
    fundamentalOn: "ONで最新ニュース・経済指標を統合分析（精度向上・時間増）",
    fundamentalOff: "OFFでテクニカル指標のみで判断（高速・シンプル）",
    tooltipOn: "ON: 最新ニュース・経済指標を統合分析（精度向上・時間増）",
    tooltipOff: "OFF: テクニカル指標のみで判断（高速・シンプル）",
  },

  stages: {
    banner: "SIGNAL ANALYSIS IN PROGRESS",
    caption: "マルチタイムフレームの構造・レベル・トレンドを解析しています…",
  },

  // The big English word is the trader idiom and stays; the gloss beside it is
  // what stops a reader taking SHORT for a buy.
  direction: {
    label: "DIRECTION",
    BUY: { word: "LONG", gloss: "買い" },
    SELL: { word: "SHORT", gloss: "売り" },
    WAIT: { word: "WAIT", gloss: "様子見" },
    confidence: "確信度スコア",
    // リングは 0〜100 で描かれるが、このシステムがその目盛りを全部使ったことは
    // 一度もない。66 を「90 も出せる目盛りの中の 66」と読ませないために、
    // 実測レンジを数字の真下に添える。固定文にはしない——
    // confidence_calibration() の span.traded から組み立てる（#68）。
    confidenceObserved: (lo: number, hi: number, n: number) =>
      `あなたの記録での実測レンジ ${lo}〜${hi}（約定${n}件）`,
  },

  result: {
    tradePlan: "トレードプラン",
    entry: "エントリー",
    stopLoss: "損切り",
    riskReward: "R:R比",
    tp1: "利確 TP1",
    tp2: "利確 TP2",
    tp3: "利確 TP3",
    // 損切り・TP1 までの距離。ATR は取得データに無いこともあるので省略可
    distance: (pips: number, atr: number | null) =>
      atr === null ? `${pips} pips` : `${pips} pips・ATR ${atr}倍`,
    evidence: "根拠",
    showAll: (n: number) => `すべて表示（${n}件）`,
    showLess: "折りたたむ",
    // AI の自己採点。何も較正していない数字なので、カードではなく一列のチップ
    ratings: {
      label: "AIの自己評価",
      technical: "テクニカル",
      fundamental: "ファンダ",
      risk: "リスク",
      volatility: "ボラ",
    },
    inferenceChip: "推測",
    inferenceNote: "板情報・出来高・建玉・約定履歴は取得していません。「推測」と付いた記述は値動きからの解釈であって、観測した事実ではありません。",
    detail: "詳細分析",
    marketContext: "相場環境と水準",
    warnings: "注意",
    // 見送り（WAIT）の理由。entry_check から読むので、警告文の位置や文言には依存しない
    waitReason: {
      label: "見送りの理由",
      // AI 自身が WAIT と答え、その確信度が公開の下限に届かなかった回。サーバー
      // が覆したわけではないので、history.gate.reasons.low_confidence は使わない
      ownLowConfidence: "AI自身の確信度が公開の下限に届かなかったため、エントリー・損切り・利確は出していません",
      // サーバーが却下した回の2行目。AI が出していた方向を残す
      refused: (word: string, gloss: string) => `${word}（${gloss}）の提案はサーバー側で却下され、WAITとして公開されました`,
      // 却下の根拠になった実測値。文言だけでは「近すぎる」がどれだけ近いのか分からない
      atrMultiple: (n: number) => `ATR ${n}倍`,
      confidence: (score: number, floor: number) => `確信度 ${score}／下限 ${floor}`,
    },
    riskLevels: { LOW: "低", MEDIUM: "中", HIGH: "高" },
    sentiments: { BULLISH: "強気", NEUTRAL: "中立", BEARISH: "弱気" },
    volatilityLevels: { Low: "低", Medium: "中", High: "高" },
  },

  // 「相場環境と水準」の行ラベル。値の側（Trend Day / Up など）はサーバーの定型英語のまま
  context: {
    mode: "相場モード",
    structure: "構造",
    smartMoney: "スマートマネー",
    strength: "勢い",
    session: "セッション",
    direction: "方向",
    continuity: "継続性",
    summary: "要約",
    levels: "主要な水準",
    resistance: "レジスタンス",
    support: "サポート",
    stopHunt: "ストップ狩りゾーン",
  },

  // 折りたたみ行の開閉ラベル
  disclosure: {
    open: "開く",
    close: "閉じる",
  },

  chart: {
    title: "プライスチャート",
    recentBars: (pair: string, n: number) => `${pair} 直近${n}本`,
    ariaLabel: (pair: string) => `${pair} のローソク足チャートとトレードプラン水準`,
    // Marks a level the model named rather than one the server measured.
    citedMark: "(AI)",
    legend: "破線=サーバ計算の水準 / 点線=AIが挙げた水準 / 帯=現在価格の雲",
    hiddenLevels: (n: number) => `表示範囲の外に ${n}件`,
  },

  technical: {
    title: "取得データサマリー",
    currentRate: "現在レート",
    overbought: " (買われすぎ)",
    oversold: " (売られすぎ)",
    tenkan: "一目 転換線",
    kijun: "一目 基準線",
    // Named for where they are drawn. "先行A/B" alone read as the cloud
    // price is in, which is a different pair computed 26 bars earlier — so
    // the panel confirmed "price is below the cloud" with the wrong numbers.
    spanA: "一目 先行A(26本先)",
    spanB: "一目 先行B(26本先)",
    cloudNow: "現在価格の雲(26本前算出)",
    cloudTop: "上",
    cloudBottom: "下",
    indicators: "指標の数値",
    cloudSides: { above: "価格は雲の上", inside: "価格は雲の中", below: "価格は雲の下" },
    forming: "この足はまだ形成中",
  },

  history: {
    title: "シグナル履歴",
    winRate: "勝率",
    fillRate: "約定率",
    outcomes: {
      win: "WIN",
      loss: "LOSS",
      pending: "進行中",
      expired: "期限切れ",
      skipped: "—",
      untriggered: "未約定",
      ambiguous: "判定不能",
      rejected: "却下",
      // 「却下」と並べて出る別の出来事。AI自身がWAITと答えた行に「却下」を
      // 出していたため、サーバーが16件のプランを覆したように読めていた。
      declined: "AI見送り",
    },
    scope: (n: number) => `直近${n}件`,
    // The statistics and the row list are two different populations on one
    // screen, so each says which it is.
    statsScope: (n: number) => `成績: 全期間 ${n}件の判断`,
    statsScopeContract: (n: number, contract: string) => `成績: 全期間 ${n}件の判断（${contract} の記録）`,
    statsFallback: (n: number) => `成績: 直近 ${n}件のみで集計（サーバ集計を取得できませんでした）`,
    otherContractRows: (n: number) => `別の契約で作られた ${n}件は、この集計に含めていません`,
    autoNote: "結果は実際の値動きで15分ごとに自動判定（TP1到達=WIN / SL到達=LOSS）",
    winRateNote: "勝率はWIN/LOSS/期限切れで計算（未約定・判定不能は除外）。期限切れは「届かない利確を置いた」結果なので、勝率から外れる逃げ道にはしません。約定率はエントリー価格に実際に到達した割合",
    stats: {
      title: "内訳",
      byTimeframe: "時間足",
      byMode: "モード",
      byConfidence: "確信度",
      all: "全体",
      record: "勝敗",
      open: "進行中",
      untriggered: "未約定",
      other: "その他",
      unknownBand: "—",
      noClosed: "決着したシグナルはまだありません",
      confidenceBand: (lo: number, hi: number | null) => (hi === null ? `${lo}%以上` : `${lo}–${hi}%`),
      // The honest version of the win rate: how much it rests on
      measuring: (n: number, target: number) => `測定中（独立した決着 ${n}件 / 目安 ${target}件）`,
      ci: (lo: number, hi: number) => `95%区間 ${lo}–${hi}%`,
      clusters: (n: number) => `独立した局面 ${n}件`,
      expectancyLine: (expectancy: string, sum: string) => `期待値 ${expectancy}（合計 ${sum}）`,
      rColumn: "損益(R)",
      byRulebook: "ルール版",
      verdictRate: "採点できた割合",
      leakLine: (wait: number, untriggered: number, expired: number) =>
        `見送り ${wait}%・未約定 ${untriggered}%・期限切れ ${expired}%`,
      incoherentLine: (n: number) => `水準の矛盾 ${n}件`,
      legacyContract: (v: string) => `${v}（旧契約）`,
      mixedContracts: "エントリー契約が異なるプランが混在しているため、割合は表示しません。旧契約では約定しないまま採点されないプランがあり、新契約ではそれが起こりません。内訳の「ルール版」で分けて見てください。",
      rulebookNone: "ルール導入前",
      frictionNote: "R は計画リスク幅を1とした損益（WIN=TP1到達、LOSS=−1R）。スプレッド・スリッページは含まない理論値",
    },
    modes: { full: "ニュース込み", technical_only: "テクニカル", technical_fallback: "テクニカル(検索不可)" },
    // The entry gate: plans analyze refused because the market would not
    // have reached them, and what became of them in the shadows
    gate: {
      // 「サーバーが却下した」と「AI自身が見送った」は別の出来事。確信度の
      // 下限は AI 自身がWAITと答えた行にも rejection を書くので、この2文を
      // 1つの件数にまとめていた間、16件の自主的な見送りが「サーバーがAIの
      // 判断を覆した」と表示されていた（実際の却下は1件）。
      note: (n: number) => `AIの提案 ${n}件は「約定しない・割に合わない」としてサーバー側で却下し、WAITに変更しました。`,
      declinedNote: (n: number) => `AI自身が「見送る」と判断したものが ${n}件あります（サーバーによる却下ではありません）。`,
      shadowNote: (s: { untriggered: number; wins: number; losses: number; open: number }) =>
        `却下したプランをそのまま追跡した結果: 未約定 ${s.untriggered} / WIN ${s.wins} / LOSS ${s.losses} / 進行中 ${s.open}`,
      rejectedTitle: "サーバー側で却下したプラン",
      rejectedSummary: "AIの提案はサーバー側で却下され、WAITとして公開されました",
      declinedSummary: "AI自身が見送ると判断しました（サーバーによる却下ではありません）",
      reasons: {
        too_far: "エントリーが現在値から離れすぎ（約定しない）",
        should_be_market: "トレンド継続中に戻りを待つ指値（約定しない）",
        stop_too_tight: "損切りが近すぎる（ノイズで刈られる）",
        poor_rr: "リスクリワードが割に合わない",
        target_out_of_reach: "利確が遠すぎて期限内に届かない",
        market_closed: "市場が閉まっていた（成行で入れない）",
        // この見出しが出るのは、AIがBUY/SELLを出したうえで確信度が下限に
        // 届かなかった行だけ。AI自身がWAITと答えた行はここに来ない。
        low_confidence: "AIの確信度が下限に届かなかった",
        // この却下は entry.ts の2か所から出る。水準を突き合わせて逆向きだった
        // 行と、値が欠けていて突き合わせ自体ができなかった行。却下理由の文字列
        // だけではどちらか分からないので、「矛盾」と書くと後者について、誰も
        // 行っていない比較の結果を断定することになる。（このラベルのすぐ隣に
        // proposed_stop / proposed_tp1 が並ぶので、欠けていた行はそこで分かる。）
        incoherent: "エントリー・損切り・利確を筋の通ったプランとして読めなかった",
      },
      proposed: "AIの提案",
      distance: "現在値との距離",
      riskReward: "リスクリワード",
      shadowResult: "却下プランの追跡結果",
      gateRight: "→ 却下は正しかった（エントリー価格に届かなかった）",
      gateWrong: "→ 却下は誤りだった（約定して利確に到達）",
      gateSaved: "→ 約定していれば損切りになっていた",
      gateOpen: "→ 追跡中",
      repaired: "AIの指値エントリーはトレンド継続中のため、現在値の成行に修正して公開しました",
    },
    // 見送り（WAIT）の検証。見送りは「間違えようのない答え」になりがちなので、
    // 見送った後に相場が何をしたかを必ず突き合わせる
    preview: { badge: "下見" },
    wait: {
      title: "見送りの検証",
      badge: "取れていた",
      summary: (judged: number, missed: number, rate: number) =>
        `見送りの検証: 判定済み ${judged}件のうち ${missed}件（${rate}%）は、このアプリ自身が許す最小のトレードなら勝てていました`,
      verdicts: {
        missed: "見送るべきではなかった（判断時点で想定した方向のトレードが勝っていた）",
        correct: "見送りは妥当だった（そのトレードは損切りに掛かったか、期間内に届かなかった）",
        pending: "検証期間が終わっていません",
        unknown: "検証に必要なデータがありません",
        no_call: "判断時点で方向が決まっていないため、採点していません",
      },
      direction: (dir: string, source: string) => `判断時点で想定した方向: ${dir}（${source}）`,
      directionSources: {
        proposed_signal: "AIが出したシグナルをサーバが却下",
        declared_direction: "AIが宣言した相場の方向",
        regime: "指標が示したトレンドの向き",
        none: "なし",
      },
      planNote: "この方向・損切り・利確は判断した時点で確定して保存したものです。値動きを見てから選んだものではありません",
      noCallNote: "判断時点で方向を示す材料がなかったため、この見送りは「当たり・外れ」のどちらにも数えていません",
      basis: "検証したトレード",
      basisNote: (risk: string, reward: string) =>
        `損切り幅 ${risk} / 利確幅 ${reward}（ゲートが許す最小の損切りと、リスクリワード下限を満たす最も近い利確）`,
      reachedAt: "利確到達",
      barsExamined: (n: number) => `検証した足 ${n}本`,
      horizon: (hours: number) => `検証期間 ${hours}時間（市場が開いている時間で計測）`,
      note: "見送りは採点されないと「常に見送る」が最善手になってしまうため、見送った後の値動きも同じ基準で検証しています",
    },
    // Why a settled plan went the way it did
    postmortem: {
      title: "なぜ外れたか（AIの検証）",
      titleWin: "なぜ当たったか（AIの検証）",
      pending: "原因分析は決着から数時間後に自動で行われます",
      failed: "原因分析を実行できませんでした。次回の自動実行で再試行します",
      causes: {
        direction_wrong: "方向が逆だった",
        stop_too_tight: "損切りが近すぎた",
        entry_too_far: "エントリーが約定しなかった（旧契約）",
        entry_too_early: "成行で追いかけて即逆行（旧契約）",
        chased_move: "伸びきった動きに乗った",
        target_too_far: "利確が遠すぎた",
        regime_misread: "相場環境の読み違い",
        news_shock: "指標・イベントの急変動",
        plan_incoherent: "プランの水準が矛盾",
        good_call: "想定通り",
        lucky_win: "勝ったが危うかった",
        wait_missed_trade: "見送ったが取れていた",
        good_wait: "見送りは妥当だった",
        sound_call_lost: "動かせるレバーが無い負け",
        inconclusive: "判断材料が不足",
      },
      // The one verdict that is easy to read as something it does not say, so
      // the page spells out what it claims. Shown under the badge.
      causeNote: {
        sound_call_lost:
          "損切りを広げても、利確を近づけても、より良い値で入っても、決着まで検証したどの案も結果を変えませんでした。動かせるレバーはどれもこの結果を変えなかった、という意味であり、「読みが正しかった」という判定ではありません（検証できるのは判断より後の値動きだけです）",
      },
      lesson: "教訓",
      avoidable: "分析時点の情報で回避できた",
      unavoidable: "分析時点では回避が難しかった",
      confidence: (c: number) => `診断の確度 ${c}%`,
      counterfactual: "もし…だったら",
      cfMarket: "成行で入っていたら",
      cfStop15: "損切りを1.5倍に広げていたら",
      cfStop2: "損切りを2倍に広げていたら",
      cfTpHalf: "利確を半分にしていたら",
      cfMarketSameRisk: "成行で入り損切り幅を同じにしていたら",
      cfPullback: "0.5R 有利な値が付いていたか",
      cfRr: (rr: number) => `RR ${rr}`,
      cfNotViable: "採用不可（ゲート基準未満）",
      cfResult: { win: "WIN", loss: "LOSS", untriggered: "未約定", expired: "期限切れ", ambiguous: "判定不能", open: "未決着" },
      afterTp1: (bars: number) => `損切りの ${bars} 本後に TP1 へ到達`,
      beyondSl: (r: number) => `損切り後さらに ${r}R 逆行`,
      earlyAdverse: (r: number) => `約定直後の逆行 ${r}R`,
      // One line per raised danger flag, each a measurement of the winning
      // trade rather than a verdict on it
      danger: {
        deep_mae: (closestR: number) => `損切りまで残り ${closestR}R まで逆行`,
        mostly_underwater: (underwater: number, bars: number) => `保有 ${bars} 本のうち ${underwater} 本が含み損`,
        chop: (crossings: number) => `エントリー価格を ${crossings} 回またいだ`,
        spike_target: (reversedR: number) => `利確はヒゲだけで、その後 ${reversedR}R 戻した`,
        late_win: (percent: number) => `期限の ${percent}% を使って到達`,
      },
      thinNote: "決着後の値動きがまだ少ないため暫定診断です。値動きが揃い次第、自動で再診断します",
      thinFinalNote: "再診断でも決着後の値動きが少なく、暫定のままです（これ以上の自動再診断はありません）",
      revisedNote: "値動きが揃った後に再診断済み",
      ruleBlamed: (id: string) => `結果を招いたルール: ${id}`,
      ruleCredited: (id: string) => `貢献したルール: ${id}`,
      eventBar: (country: string, title: string) => `急変動した足で ${country} の指標発表: ${title}`,
      causeBreakdown: "外れた原因の内訳",
    },
    detail: {
      expand: "予想と実際を見る",
      collapse: "閉じる",
      plan: "AIの予想",
      actual: "実際の値動き",
      entry: "エントリー",
      stopLoss: "損切り (SL)",
      takeProfit1: "利確 (TP1)",
      priceAtSignal: "分析時の価格",
      orderTypeLabel: "注文タイプ",
      orderType: {
        market: "成行相当",
        limit: "指値（押し目/戻りを待つ）",
        stop: "逆指値（ブレイクを待つ）",
        unknown: "—",
      },
      priceFeedLabel: "値付けした板",
      priceFeed: {
        twelve_data: "Twelve Data 仲値",
        gmo: "GMO Coin 仲値（採点と同じ板）",
      },
      priceBasisLabel: "採点に使った板",
      priceBasis: {
        mid: "仲値（Bid/Askが取れず）",
        quotes: "GMO Coin の Bid/Ask",
      },
      filledAt: "約定",
      notFilled: "未約定",
      resolvedAt: "決着",
      mfe: "最大含み益",
      mae: "最大含み損",
      tpsHit: "到達した利確",
      none: "なし",
      pips: "pips",
      checkedAt: "最終判定",
      evalInterval: "判定足",
      refined: (interval: string | null) => (interval ? `${interval}足で精査済み` : "細かい足で精査済み"),
      noEvidence: "まだ判定データがありません。次回の自動判定（15分以内）をお待ちください。",
      refinePending: "判定に必要な細かい足を取得できなかったため、次回の自動判定で再試行します",
      possibleFill: "分析直後の足がエントリー価格に触れていますが、分析の前後どちらかは特定できません",
      reasons: {
        missed: "約定前にTP1へ到達（エントリーできず）",
        invalidated: "約定前に損切り水準へ到達（シナリオ崩れ）",
        no_fill: "有効期限内にエントリー価格へ届かず",
        incoherent: "プランの水準が矛盾しており判定できません",
        no_data: "判定に必要な値動きデータが得られませんでした",
      },
      summary: {
        win: (tp: string) => `TP1 ${tp} に到達`,
        loss: (sl: string) => `SL ${sl} に到達`,
        expired: (price: string) => `期限切れ（最終価格 ${price}）`,
        // 発生源が分かっている行では ambiguitySite の側を出す。この総称は
        // 「両方に到達」と断言してしまうが、現行契約で最も多いのは片方だけ
        // 触れた行なので、事実と食い違う。
        ambiguous: "値動きの順序を判定できませんでした",
        pending: "決着待ち",
        skipped: "WAIT（トレードプランなし）のため判定対象外",
      },
      // なぜ判定できなかったか。総称ではなく、実際に起きたことを言う
      ambiguitySite: {
        incoherent: "プランの損切りと利確の水準が矛盾しています",
        window_short: "シグナル時点までさかのぼる値動きを取得できませんでした",
        no_finer_data: "細かい足を繰り返し取得できず、順序を確かめられませんでした",
        signal_bar: "分析した足がすでに損切りか利確の水準に触れており、それがプラン作成の前か後かを特定できません",
        pre_fill: "約定していた可能性があるまま、エントリー期限が過ぎました",
        unfilled_touch: "約定していたかどうかが分からないまま、損切りか利確の水準に到達しました",
        fill_bar: "約定した足が損切りか利確の水準にも触れており、順序を特定できません",
        in_trade: "保有中の同じ足で損切りと利確の両方に触れ、順序を特定できません",
        feed_conflict: "細かい足が、粗い足に見えていた値動きを示しませんでした",
      },
      legacyNoEvidence: "旧バージョンの判定のため、値動きの記録はありません",
      chartHeading: "実際の値動き",
      chartSubtitle: (interval: string, n: number) => `判定足 ${interval} / ${n}本`,
      chartSubtitleCompressed: (interval: string, n: number) => `判定足 ${interval}（${n}点に圧縮表示）`,
      markers: { signal: "分析", fill: "約定", win: "TP1", loss: "SL", end: "終了" },
    },
  },

  // What the analyzer has learned from its own record (public.rulebook)
  rules: {
    title: "AIが学習したルール",
    version: (v: number) => `v${v}`,
    updated: (d: string) => `更新 ${d}`,
    empty: "まだ学習したルールはありません。シグナルの決着と原因分析が進むと自動で追加されます。",
    support: (n: number) => `実績${n}件`,
    verifying: "検証中",
    verifyingSupport: (n: number) => `検証中・実績${n}件`,
    kind: { constraint: "歯止め", heuristic: "指針" },
    showAll: (n: number) => `すべて表示（${n}件）`,
    showLess: "折りたたむ",
    note: "実際の値動きに基づく検証から自動生成され、次回以降の分析プロンプトに組み込まれます",
    supportNote: "実績＝そのルールの根拠になった独立した局面の数（同じ方向のプランは24時間以内なら1件。ただし前の取引が決着してから間が空いていれば別の局面として数える）。2件以下は「検証中」",
    cadence: "改訂は「新しい教訓が5件」または「前回から24時間経過」のときだけ行い、1回に追加・削除できるのは各2件まで。版ごとの成績を比べられるようにするため",
    // 学習は全アカウントの結果から行う。ルール横の「実績n件」は自分の履歴には
    // 無いプランを含むので、そう書いておかないと数が合わない
    sharedNote: "ルールは全ユーザーの分析結果をまとめて学習しています。各ルールの実績件数は、あなた自身の履歴だけの数ではありません",
    heldBack: (n: number) =>
      `現在の契約では実行できないルール${n}件は保留中です。原因または文言が「エントリー価格の置き方」を指しており、現在のAIはエントリー価格を選べません。根拠は保持され、方向・損切り幅・利確幅・見送りのいずれかを動かす形に書き直されれば復帰します`,
    priorEvidence: "旧契約の実績を含む",
    priorEvidenceNote: "このルールの根拠には、アナリストがエントリー価格を選んでいた旧契約時代のプランが含まれます",
    noneInForce: "現在の契約で有効なルールはまだありません。新しいプランが決着し検証されると、ここに追加されます",
    // ルールブックを改訂する AI が自分用に残す文。内部の識別子や、既に古くなった
    // 主張を含むことがあるので、ルールの下に最初に読む段落にはしない
    editorNote: "改訂AIのメモ",
    editorNoteCaption: "ルールブックを改訂するAIが自分用に残したメモです。内部用語を含むことがあり、現在の状態と合っていない場合があります。",
  },

  // Whether the automatic review loop is running (public.loop_health)
  loop: {
    title: "自動レビューの稼働状況",
    tracker: "勝敗判定",
    postmortem: "原因分析",
    every15: "15分ごと",
    last: (d: string) => `最終 ${d}`,
    lastLine: (d: string, ago: string) => `最終 ${d}（${ago}）`,
    ago: (m: number) => (m < 60 ? `${m}分前` : `${Math.floor(m / 60)}時間${m % 60}分前`),
    never: "未実行",
    stalled: "60分以上実行がありません（停止の可能性）",
    inactive: "スケジュールが無効になっています",
    openPlans: (n: number) => `進行中 ${n}件`,
    awaiting: (n: number) => `原因分析待ち ${n}件`,
    reviewed: (n: number) => `分析済み ${n}件`,
    rulebook: (v: number) => `ルールブック v${v}`,
    lessons: (n: number) => `教訓 ${n}件`,
    nextRevision: (n: number) => (n > 0 ? `次回改訂まで教訓あと${n}件（または前回改訂から24時間で）` : "次の原因分析で改訂"),
    candidateHeld: (decided: number, needed: number) =>
      `改訂案は作成済みです。現行版を試した独立した局面が${decided}/${needed}件になった時点で、成績を比べてから適用します`,
    waits: "原因分析は決着の1時間後（15分足）・2時間後（1時間足）・4時間後（4時間足）・8時間後（日足）に自動実行し、決着後の値動きが少ない場合は後で再診断します",
  },

  // 勝ち負けを1つにまとめず、方向・タイミング・置き場所を別々に出す画面。
  // 数字は public.separated_scores() の答えをそのまま描くだけで、
  // 画面側では何も計算しない（計算が2箇所にあると必ず食い違う）。
  scores: {
    title: "3つに分けた採点",
    definition: (v: number) => `採点定義 v${v}`,
    subtitle:
      "勝ち負けを1つの数字にまとめると、「向きは合っていたのに損切りの位置で負けた」と「そもそも向きが逆だった」が同じ『負け』になります。ここでは3つを分けて出します。",
    none: "サーバから採点を受け取れませんでした（この画面は手元の行から勝手に計算しません）",
    empty: "まだ採点できる取引がありません",
    noPair: "不明",
    noRate: "区間なし",
    span: (from: string, to: string) => `${from}〜${to}`,
    basis: (calls: number, pairs: string) => `土台: 全${calls}件の判断・通貨ペア ${pairs}`,
    basisSignals: (mix: string) => `内訳 ${mix}`,
    basisTrades: (trades: number, diagnosed: number, undiagnosed: number) =>
      `取引 ${trades}件（原因分析ずみ ${diagnosed}件・未分析 ${undiagnosed}件）`,
    // 採点の土台になった取引の件数。上の「原因分析ずみ」とは違う数字になりうる
    // ——発注方式が違う行は採点から外れるため。外れた件数は次の行で出す。
    basisGraded: (graded: number) => `このうち、下の採点の土台になったのは ${graded}件`,
    otherContract: (rows: number, list: string) =>
      `別の発注方式の行が ${rows}件（${list}）あり、下の採点には入っていません`,
    // 「通貨ペアは1つ、期間は約2週間」を固定文で書くのをやめ、実データから
    // 組み立てる。固定文は、2つ目の通貨ペアが増えた日・記録が2か月に伸びた日に、
    // すぐ上の行と矛盾したまま残りつづける（#83 と同じ形）。
    narrow: (pairs: number, days: number | null, topSignal: string | null, topShare: number | null) => {
      const parts = [`通貨ペア ${pairs}種`];
      if (days !== null) parts.push(`期間 ${days}日ぶん`);
      if (topSignal !== null && topShare !== null) parts.push(`${topSignal} が全体の ${topShare}%`);
      return `この採点が乗っている土台: ${parts.join(" / ")}。相場が変われば数字も変わります。`;
    },
    // 「材料が足りない」という判断も、固定文ではなく区間から出す。
    undecided:
      "どの採点も、95%区間がまだ「五分五分」をまたいでいます。うまくいっているとも、いっていないとも、まだ言えていません。",
    contractNote: (contract: string) => `現行の発注方式には採点できる取引がないため、${contract} の記録を表示しています`,
    direction: {
      label: "方向（向きは合っていたか）",
      // しきい値は画面に出す。「向きが合っていた」がどれだけ弱い条件で満たされるかは、
      // ラベルの字面からは分からない。
      hint: (deadR: number | null) =>
        `値動きがどちらへ行ったか、だけを見ます。「合っていた」と数えるのは、損切りを1R超えて走り続けず、かつプランが生きているあいだに${deadR === null ? "わずかでも" : `${deadR}R以上`}こちらへ来た行です（それだけの条件です）。損切りと利確のどちらが先に当たったかは見ません。負けた取引でも方向は正解でありえます——それを分けるのがこの行の目的です。`,
    },
    timing: {
      label: "タイミング（入った直後の逆行）",
      hint: (earlyR: number | null) =>
        `約定した直後の数本で、${earlyR === null ? "" : `${earlyR}R以上`}逆へ動かなかった取引の割合です。「入り方が間違っていた」という意味ではありません。流れに乗る入り方は、仕組み上かならず逆行を受けます。`,
    },
    placement: {
      label: "置き場所（損切りと利確の位置）",
      // 損切り側は「負けた取引でしか実際には検証されない」。ここを書かないと、
      // 勝ちが増えるだけで置き場所の点が上がるのに、画面は「検証ずみ」と読める。
      hint: "損切りを広げていたら、または利確を半分の距離にしていたら、結果が変わったか。ただし損切りの側が実際に検証されるのは負けた取引だけで、負けなかった取引は損切りの位置を調べないまま「問題なし」に数えられます（右の件数）。利確の側は毎回検証しています。置き場所は方向とタイミングの結果でもあります。",
    },
    deepMae: {
      // この行だけ向きが逆。ラベル自体に書かないと、上の3つと同じ並びで
      // 「4つめの成績」に見える。
      label: "最大逆行が損切り目前まで届いた割合（数字が大きいほど悪い）",
      hint: (maeR: number | null) =>
        `損切りまでの距離の${maeR === null ? "大部分" : `${Math.round(maeR * 100)}%`}以上まで逆行した取引の割合です。上の3つと違い、この行は数字が大きいほど悪いという意味になります。測る窓も母数も上のタイミングとは違うので、足したり比べたりしないでください。`,
    },
    n: (hits: number, n: number) => `${hits}/${n}件`,
    ci: (lo: number, hi: number) => `95%区間 ${lo}〜${hi}%`,
    unscored: (n: number) => `採点できず ${n}件`,
    thin: "件数が少なく、区間が広いことに注意してください",
    denominators: "3つの母数（件数）はそれぞれ違います。同じ分母を分けたものではありません。",
    notADecomposition:
      "3つは独立していません。足しても勝率になりませんし、内訳でもありません。同じ取引を3つの角度から見ているだけです。",
    causesLabel: "原因の内訳（教訓テーブル）",
    // この内訳は上の3つとは母集団が違う。件数と、そのうち「待つ」の判断が
    // 何件かを必ず並べて出す。出さなければ「同じ取引の4つめの見方」に読める。
    causesTotal: (total: number, waits: number) =>
      `全 ${total}件。うち ${waits}件は「待つ」の判断で、上の3つの採点には1件も入っていません`,
    causeSplit: (direction: number, timing: number, placement: number, neither: number) =>
      `方向 ${direction} / タイミング ${timing} / 置き場所 ${placement} / どれでもない ${neither}`,
    causeStraddle: "「損切りが近すぎた」は置き場所に数えていますが、タイミングの話でもあります。この分類はきれいには分かれません。",
    ranPast: (n: number) => `損切りを超えて走った ${n}件`,
    neverCame: (n: number) => `一度もこちらへ来なかった ${n}件`,
    wrongPartial: (n: number) => `うち ${n}件は測定が片方欠けており、「合っていた」側には入りえない行`,
    stopBad: (n: number) => `損切りの位置に問題 ${n}件`,
    targetBad: (n: number) => `利確の位置に問題 ${n}件`,
    stopUntested: (n: number) => `うち ${n}件は負けなかったため損切りの位置を検証していない`,
  },

  // #68 の計器。確信度に補正を当てる「前に」、補正がそもそも定義できるのかを
  // 測る画面。数字は public.confidence_calibration() の答えをそのまま描くだけで、
  // この画面は補正を一切適用しない。
  //
  // 読み違えさせてはいけないものが2つある。識別力の 0.5 は「並べ替えていない」で
  // あって、0.5 未満は「逆向き」の証拠ではない（区間が 0.5 をまたいでいる限り、
  // 何も確かめられていない）。そして門の閾値は実測を見た後に書いたもので、
  // 事前登録ではない。どちらも数字と同じ場所に置く。
  calibration: {
    title: "確信度は補正できるのか",
    subtitle:
      "補正とは「モデルが80と言ったとき実際は55%しか勝たない」という対応づけを当てることです。そのためには、モデルの言う数字が動いていなければなりません。動いていなければ、補正は効かないのではなく定義できません。この画面は補正を一切適用せず、当てられるかどうかだけを測ります。",
    contract: (contract: string) => `発注方式 ${contract}`,
    unknown: "—",

    rangeTitle: "1. 実際に出た確信度の幅",
    // 「62〜70しか言っていない」を固定文ではなく実測から組み立てる。固定文は、
    // モデルが別の値を出しはじめた日に矛盾したまま残りつづける（#83 と同じ形）。
    tradedRange: (lo: number, hi: number, n: number) =>
      `このシステムが実際に取引したプラン${n}件で言った確信度は、${lo} から ${hi} までだけです。`,
    tradedShape: (distinct: number, width: number) =>
      `異なる値は${distinct}種類、端から端までの幅は${width}しかありません。`,
    rangeUnknown: "約定したプランの確信度の幅を読み取れませんでした。",
    allRange: (lo: number, hi: number, n: number, distinct: number) =>
      `待ちも含めた全${n}件では ${lo}〜${hi}（${distinct}種類）`,
    waitRange: (lo: number, hi: number, n: number, distinct: number) =>
      `「待つ」の判断${n}件では ${lo}〜${hi}（${distinct}種類）`,
    gaugeNote:
      "確信度のゲージは 0〜100 の目盛りで描かれます。この記録の中で実際に使われたのは、そのうち上の範囲だけです。",
    // 幅そのものは事実。「対応が決まらない」は解釈なので、門が求める帯の
    // 数から導いた条件を満たしたときだけ出す。定数の断定は、データが変わった
    // 瞬間に下の表と矛盾する（#83）。
    roomFact: (width: number) =>
      `補正は「言った数字」と「実際の勝率」の対応づけです。言った数字が実際に動いた幅は${width}です。`,
    roomNarrow: (needSpan: number) =>
      `この幅では、門が求める帯（5点刻み、${needSpan}点ぶん）を並べられません。当てられる対応がありません。`,

    valuesTitle: "2. 言った値ごとの決着",
    valuesNote:
      "粗い帯にまとめず、実際に出た値そのものを並べています。まとめると、値がほとんど動いていないという肝心のことが見えなくなります。",
    colConfidence: "確信度",
    colN: "決着",
    colRate: "勝率",
    ciPercent: (lo: number, hi: number) => `95%区間 ${lo}〜${hi}%`,
    valueN: (settled: number, wins: number, losses: number) => `${settled}件（勝${wins}・負${losses}）`,
    valueRate: (rate: number, wins: number, settled: number) => `${rate}%（${wins}/${settled}）`,
    // 件数の少なさは行そのものに書く。1件の行が、100件の行と同じ大きさの
    // パーセントで並んでいるのが、この表のいちばん危ないところ。
    valueThin: (settled: number) => `この行はわずか${settled}件の結果です`,
    noValues: "決着した取引がまだ1件もなく、値ごとの勝率は出せていません。",

    bandsTitle: "5刻みの帯（下の門はこの帯で判定します）",
    bandLabel: (lo: number, hi: number) => `${lo}〜${hi}`,
    bandThin: (minN: number) => `${minN}件に届いていません`,

    discTitle: "3. 識別力（数字が勝ち負けを並べ替えているか）",
    discMeaning: (auc: number) =>
      `勝った取引と負けた取引を1件ずつ取り出したとき、勝ったほうの確信度が高かった割合は ${auc} です（同点は0.5と数えます）。0.5 は「この数字は勝ち負けをまったく並べ替えていない」という意味です。`,
    discPairs: (pairs: number, nWin: number, nLoss: number) =>
      `勝ち${nWin}件 × 負け${nLoss}件 = ${pairs}ペアすべてで数えています。`,
    discCi: (lo: number, hi: number) => `95%区間 ${lo}〜${hi}`,
    discTies: (share: number) => `同点のペアが全体の${share}%`,
    // 近似であることは、区間と必ず同じ場所に置く。別の行に書けば、区間だけが
    // 引用されて数字が独り歩きする。
    discApproximate:
      "この区間は正規近似（Hanley-McNeil）による概算です。同点が多いほど粗くなります。",
    discNothing:
      "区間が 0.5 を含んでいます。つまり、何も確かめられていません。数字が 0.5 を下回っていることは「確信度が逆向きに効いている」証拠ではありません——区間が広く、偶然と区別がついていないだけです。",
    // 区間が読めなかったときに「区間が 0.5 を含む」とは書けない。無い測定の
    // 性質を述べることになる。
    discNoInterval:
      "区間が出ていないので、どちらとも確かめられていません。",
    discEstablished: "区間は 0.5 を含んでいません。",
    discNone: "勝ちと負けのペアが作れず、識別力は出せていません。",

    gateTitle: "4. 補正を当ててよい条件",
    gateNotApplied:
      "確信度への補正は、現在いっさい適用していません。この画面は当ててよいかどうかだけを測っています。",
    gateApplied: "注意: 補正が適用されています。",
    gateNeed: (bands: number, minN: number, settled: number) =>
      `必要: 5刻みの帯が${bands}つ以上あり、そのどれもが${minN}件以上決着していること。決着の合計が${settled}件以上あること。`,
    gateHave: (bands: number, settled: number) =>
      `現在: 条件を満たす帯は${bands}つ、決着は合計${settled}件。`,
    gateUnmet: "条件はまだ満たされていません。満たされるまで補正は当てません。",
    gateMet: "条件は満たされています（当てるかどうかは、これとは別の判断です）。",
    // 閾値をいつ決めたかは、閾値そのものと同じくらい重要な事実である。
    gateAfterTheFact:
      "この条件は実測を見た「後」に書いたものです。事前登録ではありません。数字を見てから閾値を決めれば、閾値は都合よく置けます。docs/NOISE_FLOOR_PREREGISTRATION.md のような事前登録と同じ扱いをしないでください。",
    gatePreregistered: "この条件は数字を見る前に登録されたものです。",
  },

  // 記録を書いたのは誰か。成績の集計キーには発注方式とルールブックの版しか
  // 入っておらず、どのモデルが答えたかは入っていない。つまりモデルを入れ替え
  // れば、二人の分析者の成績が一本の勝率に溶け、あとから分けることはできない。
  // この画面はその一点だけを、記録のすぐ隣で見張る。
  //
  // 読み違えさせてはいけないものが1つある。モデルが記録されていない行は
  // 「記録が無い」のであって「いつもの方だった」ではない。埋めることは
  // できないので、名前のあるモデルの件数に混ぜてはならない。
  modelMix: {
    title: "この記録を書いた分析者",
    contract: (contract: string) => `発注方式 ${contract}`,
    unknown: "—",
    scope: (calls: number) => `対象は分析${calls}件`,
    // 普通の状態。警告ではなく事実として、1行で。
    // 「単独で」と言えるのは、記録の無い決着がゼロのときだけ。1件でもあれば
    // 下の singlePlusGap に切り替える。
    single: (model: string, settled: number) =>
      `この記録は ${model} が単独で書いています（決着した取引${settled}件）。`,
    // 名前のあるモデルが1つでも、書き手の分からない決着が混ざっているとき。
    // ここで「単独で」と書くと、勝率の母数に入っている取引を1つのモデルの
    // 成績として読ませることになる。このパネルが防ぐべきものそのもの。
    singlePlusGap: (model: string, settled: number, gap: number) =>
      `決着した取引のうち${settled}件は ${model} が書いています。` +
      `ただし別に${gap}件、書いたモデルが記録されていない決着があり、それも勝率に入っています。` +
      `したがってこの勝率を ${model} の成績として読むことはできません。`,
    // この画面が存在する理由そのもの。
    pooled: (models: number) =>
      `この勝率は${models}種類のモデルの成績が混ざったものです。どれか1つの成績としては読めません。`,
    pooledNote: "決着した取引を持つモデルが複数あります。内訳は以下のとおりです。",
    // 混ざっているという事実だけが来て、内訳が来なかったとき。
    // 「内訳は以下のとおり」と書いた下に何も無い、という形を作らない。
    pooledNoSplit: "決着した取引を持つモデルが複数あります。内訳は返ってきていません。",
    row: (settled: number, calls: number) => `決着${settled}件 / 呼び出し${calls}件`,
    rowSettledOnly: (settled: number) => `決着${settled}件`,
    none: "決着した取引がまだなく、勝率を書いたモデルはまだありません。",
    noCalls: "この発注方式の分析はまだ1件もありません。",
    // 「まだ1件も無い」と「読み取れなかった」は別のこと。読めなかったものを
    // 「無い」と書けば、それは測っていない事実を測ったことにする。
    notReadable: "この記録を書いたモデルは読み取れませんでした。",
    unrecorded: (rows: number) => `${rows}件は、どのモデルが書いたかが記録されていません。`,
    unrecordedSettled: (settled: number) => `うち${settled}件は決着済みで、勝率に入っています。`,
    // 行数が読めず、決着数だけが読めたとき。勝率に効いているのは決着数のほうなので、
    // 行数が無いことを理由にこの注意書きごと消してはいけない。
    unrecordedSettledOnly: (settled: number) =>
      `${settled}件の決着した取引は、どのモデルが書いたかが記録されていないまま勝率に入っています。`,
    unrecordedNote:
      "これは記録が欠けているという意味であって、既定のモデルが使われたという意味ではありません。あとから埋めることはできません。",
  },

  // その回の分析が参照したルールと、今の相場との照合結果（サーバ実測）。
  ruleFit: {
    title: "適用されたルール",
    summary: (matched: number, total: number) => `${total}件を提示し、うち${matched}件が今の相場に該当。`,
    heldBack: (n: number) => `文字数の都合で${n}件を省略（今の相場から遠いものから）。`,
    verdicts: {
      match: "該当",
      off: "別局面",
      unknown: "照合不可",
    },
    axes: {
      adx: "ADX",
      rsi: "RSI",
      stretch: "SMA20乖離",
      bb_pos: "BB内の位置",
      htf_adx: "上位足ADX",
    },
    missed: (axes: string[]) => `外れた軸: ${axes.join("・")}`,
    evidence: (cases: number, cited: number) =>
      cases === cited
        ? `根拠${cited}件すべての当時の値と比較。`
        : `根拠${cited}件のうち${cases}件しか当時の値が残っておらず、その範囲との比較。`,
    claimed: "AI申告",
    claimedNote:
      "「AI申告」は、AI自身がこの回で使ったと述べたルールで、サーバが測ったものではありません（申告が無い回はこの印も出ません）。",
    claimedNone:
      "AI自身は、この回はどのルールも使わなかったと述べています（サーバの判定は上のとおりで、これとは別です）。",
    ruleGone: (id: string) => `（${id}：本文を取得できませんでした）`,
    note:
      "「該当」判定は、そのルールの根拠になった過去の局面の実測値（ADX・RSI・SMA20乖離のATR倍・BB内の位置・上位足ADX）と現在値をサーバが機械的に比べた結果です。ルール本文の主張ではありません。ルールは全アカウントの記録から学習されているため、根拠の件数にはあなたの履歴に無いものも含まれます。",
  },

  analysisMode: {
    label: "分析モード:",
    full: "フル分析（テクニカル+ファンダメンタル）",
    technical_only: "テクニカル分析のみ",
    technical_fallback: "テクニカルのみ（ニュース検索が利用できませんでした）",
  },

  // 為替が閉まっている間の読み。エラーではなく、結果の性質。
  // 同じ入力に同じ答えを返したときの表示（#90）。古い答えを新しい答えの顔で
  // 出さないための一画面。
  reuse: {
    // 「前回」と書かない。引くのは「同じ鍵の最新の行」であって、直前の分析とは
    // 限らない（間に別のペアを回していれば、それが「前回」である）。
    title: "同じ入力の回が既にあったので、その分析結果をそのまま出しています",
    body:
      "相場データ・学習ルール・設定が、その回と一字一句同じでした" +
      "（この再利用はニュース検索を使っていない回だけに出ます。使った回は、検索した中身が同じとは言えないので再利用しません）。" +
      "同じ入力でもう一度分析しても、AIの判定はぶれるだけで新しい材料は出ません" +
      "（同一入力の再生で48回中10回、売り↔見送りが割れました）。",
    analyzedAt: (at: string) => `この結果は ${at} の分析です。`,
    clockNote: "違うのは時刻だけです。時間帯やイベントまでの距離の読みは、その時刻のものです。",
    // 返金は best-effort なので、戻ったときだけ「消費していない」と言う。
    creditReturned: "分析回数は消費していません。",
    creditNotReturned: "この回のために消費した分析回数を戻せませんでした。残り回数は1減っています。",
    forceButton: "それでも新しく分析する（回数を消費します）",
  },

  preview: {
    title: "下見（相場は閉まっています）",
    body:
      "直近の終値までを読んだ結果です。入る値段が存在しないので、エントリー・損切り・利確は出していません。" +
      "この回は履歴に残りますが、勝率・期待R・ルールの学習には一切数えません。",
    opensAt: (at: Date) =>
      `次に分析がプランを出せるのは ${at.toLocaleString("ja-JP", {
        month: "numeric",
        day: "numeric",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })} 以降です。`,
  },

  // 保有中の判断（#89）。新規判断（BUY/SELL/WAIT）とは別枠。WAIT は「今から新しく
  // 入るのは見送り」であって「決済しろ」ではない、というのがこの節の全部。
  position: {
    registerButton: "エントリー登録（この価格で入った）",
    registerTitle: "エントリー登録",
    registerHint: "このプランで実際に入った値段と時刻を登録すると、次回の分析から「保有中の判断」が別枠で出ます。元のプランは書き換えません。",
    fillPrice: "約定価格",
    fillTime: "約定時刻（任意）",
    fillTimeHint: "未入力なら登録した時刻を記録します",
    // 入力はブラウザの時計で解釈される。画面の時刻表示は全部日本時間なので、
    // 何が記録されるのかをそのまま見せる。
    timePreview: (at: string) => `記録される時刻: ${at}`,
    registerSubmit: "登録する",
    registering: "登録中…",
    registered: "建玉を登録しました",
    registeredChip: "建玉登録済み",
    closedAlready: (price: string, at: string) => `決済済み ${price}（${at}）`,
    alreadyOpen: (price: string) => `この建玉は登録済みでした（記録されている約定価格 ${price}）`,
    registerPrevious: "前回のプランを保有中なら登録",
    registerErrors: {
      not_signed_in: "ログインが必要です",
      entry_price_must_be_positive: "約定価格は 0 より大きい数で入力してください",
      analysis_not_found: "そのプランが見つかりません（自分の分析だけ登録できます）",
      plan_is_not_a_trade: "WAIT のプランには建玉を登録できません",
      plan_is_a_preview: "下見（休場中の読み）には建玉を登録できません",
      plan_is_a_shadow: "却下されたプランの追跡行には登録できません",
      plan_has_no_levels: "このプランには損切り・TP1 の記録が無く、保有中の評価ができません",
      fill_outside_plan: "約定価格が損切りと TP1 の間にありません。プランの水準で評価できる建玉ではありません",
      opened_before_plan: "約定時刻がプランの作成より前です",
      opened_in_future: "約定時刻が未来です",
      time_unreadable: "時刻を読み取れません",
      position_not_open: "その建玉は開いていません（決済済み、または自分のものではありません）",
      close_price_must_be_positive: "決済価格は 0 より大きい数で入力してください",
      close_reason_invalid: "決済理由が不正です",
      closed_before_open: "決済時刻が建玉より前です",
      closed_in_future: "決済時刻が未来です",
      generic: "登録できませんでした。時間をおいて再試行してください",
    },
    openTitle: "保有中の建玉",
    openedAt: "建玉",
    openedAtRegistered: "登録時刻で記録",
    planTimeframe: "分析足",
    closeButton: "決済した",
    // 決済を記録したあとの保有中カード。判定はそのまま残すが、「今の保有中の
    // 判断」ではなくなったことを見出しで言う。
    closedChip: (price: string, at: string) => `決済済み ${price}（${at}）`,
    verdictBeforeClose: "決済前の判定",
    closeTitle: "決済を記録",
    closePrice: "決済価格",
    closeTime: "決済時刻（任意）",
    closeTimeHint: "未入力なら記録した時刻を使います",
    closeReason: "理由",
    closeReasons: { manual: "手動", stop: "損切り", target: "利確", other: "その他" },
    closeSubmit: "記録する",
    closing: "記録中…",
    closed: "決済を記録しました",
    cancel: "やめる",
    latestVerdict: "最新の判定",
    verdictAt: (at: string) => `${at} 時点`,
    noVerdictSinceRegistration: "登録後の分析はまだありません（このペアを分析すると判定が出ます）",
    // 登録後に分析は走ったが、この建玉は評価されなかった／建玉を読めなかった。
    // どちらも「分析がまだ無い」ではない。
    verdictNotCovered: "最新の分析は別の建玉（最新の 1 件）を評価しました",
    verdictLookupFailed: "最新の分析は建玉を参照できませんでした",
    noVerdictInRecent: (n: number) => `直近${n}件に判定なし`,
    verdictStale: "以後は未評価",
    otherOpen: (n: number) => `他に ${n} 件の建玉あり（この判定は最新の 1 件のみ）`,
    intervalDiffers: (registered: string, now: string) => `登録時の分析足は ${registered}、今回の分析は ${now}`,
    heldTitle: "保有中の判断",
    heldSubtitle: "登録済みの建玉を、元のプランの根拠と水準で評価しています。新規判断とは別です。",
    verdicts: {
      hold: "継続",
      caution: "警戒",
      exit_condition_met: "撤退条件成立",
      undecidable: "判定できない",
    },
    verdictGloss: {
      hold: "根拠は維持されており、撤退条件は成立していません",
      caution: "根拠が弱まった、または不利な事実があります。撤退条件は成立していません",
      exit_condition_met: "プラン自身の撤退条件に達しています",
      undecidable: "材料が足りない、または元の根拠を評価できません",
    },
    decidedByAnalyst: "AI の判定",
    decidedByServerTouch: (at: string, feed: string, forming: boolean) =>
      `サーバー計測: 損切り水準に接触（${feed}・${at} の足${forming ? "・形成中" : ""}）`,
    decidedByServerTracker: (outcome: string, basis: string, at: string) =>
      `判定システムの結果: ${outcome}（${basis}・${at}）`,
    decidedByIncoherent: (verdict: string, thesis: string) =>
      `AI の答えが矛盾しているため判定できません（AI の答え: ${verdict}／根拠は${thesis}）`,
    analystUnavailable: (reason: string) => `AI の判定は取得できませんでした（${reason}）`,
    failReasons: {
      time_budget: "時間切れ",
      api: "AI 呼び出しに失敗",
      parse: "AI の答えを読めず",
      lookup: "参照を取得できず",
      no_model: "モデル未設定",
      finalise: "判定の組み立てに失敗",
      unknown: "不明",
    },
    suppressed: {
      settled_before_open: (at: string) =>
        `判定システムは損切り（loss）としていますが、その決着（${at}）は建玉より前なので撤退条件には使っていません`,
      // 登録時刻を建玉時刻にしている建玉。決着が登録より前でも、実際の約定が
      // その前か後かは記録が無いので分からない——「約定より前」とは言えない。
      settled_before_registration: (at: string) =>
        `判定システムは損切り（loss）としていますが、その決着（${at}）は登録より前です。実際の約定時刻は記録されていないため、撤退条件には使っていません`,
      registered_after_settlement: "決着後に登録された建玉なので、判定システムの結果は撤退条件に使っていません",
    },
    facts: {
      title: "サーバー計測",
      // 値が付いた時刻を必ず添える。下見（休場中）の回では「現在値」は
      // 金曜の終値であって、いまの値段ではない。
      price: "現在値",
      priceAt: (price: string, at: string) => `${price}（${at}）`,
      open: "含み",
      hypothetical: "プランの価格で入っていた場合（仮定）",
      toStop: "損切りまで",
      toTp1: "TP1まで",
      beyond: "越え済み",
      stopTouch: "損切り接触",
      tp1Touch: "TP1到達",
      touched: (at: string, forming: boolean) => `あり（${at} の足${forming ? "・形成中" : ""}）`,
      notTouched: (asOf: string, n: number) => `なし（${asOf} まで・${n} 本）`,
      notMeasured: {
        no_anchor: "未計測（基準時刻なし）",
        series_starts_after_anchor: "未計測（取得した足が建玉時刻に届かない）",
        no_bars_since_anchor: "未計測（建玉後の足がまだ無い）",
      },
      // 同じ 3 状態を、建玉が無い参照（前回の判断）向けに言い直したもの。
      // 基準は約定ではなく前回の値付け時刻なので、「建玉」と書いたら
      // 存在しなかったポジションの話になる。
      notMeasuredPriced: {
        no_anchor: "未計測（基準時刻なし）",
        series_starts_after_anchor: "未計測（取得した足が前回の価格時刻に届かない）",
        no_bars_since_anchor: "未計測（前回の価格時刻以降の足がまだ無い）",
      },
      midOnly: "仲値のみ。決済側の Bid/Ask では未計測",
      feed: { twelve_data: "仲値・Twelve Data", gmo: "仲値・GMO Coin" },
      feedDiffers: "損切り接触は今回の足で測定しています。元のプランは別の板で価格付けされていました（差は最大 0.15 ATR）",
      tracker: "判定システム",
      trackerBasis: { quotes: "Bid/Ask 判定", mid: "仲値判定", none: "板の記録なし" },
      trackerPending: "未判定",
      // プラン行を引けなかった回。判定システムには聞いていないので「未判定」
      // ではない（聞いた結果まだ決着していない、という意味になる）。
      trackerUnknown: "プラン行を取得できず",
      basisNote: "仲値での損切り接触は撤退条件として扱います。仲値で接触なし・TP1 到達は仲値上の事実で、判定システムの Bid/Ask 判定はその横に別に出します。",
    },
    thesis: {
      heldLabel: "元のプランの根拠",
      previousLabel: "前回の根拠",
      byAnalyst: "AI の見立て",
      status: { intact: "維持", weakened: "弱化", broken: "崩壊", unknown: "不明" },
      unavailable: "取得できず",
    },
    whatChanged: "変わったこと",
    reasons: "理由",
    watch: "見張るもの",
    notAnInstruction: (signal: string) =>
      `下の新規判断（${signal}）は「今から新しく入るか」の判断で、保有中のポジションを決済する指示ではありません。`,
    reversedNote: (held: string, fresh: string) =>
      `新規判断は保有中（${held}）とは反対方向（${fresh}）です。これは上の保有中の評価を変えるものではなく、別の判断です。`,
    stopReached: (basis: string) => `前回のプランの損切り水準には既に達しています（${basis}）`,
    changeTitle: "前回からの変化",
    changeHeader: (prev: string, cur: string) => `前回 ${prev} → 今回 ${cur}`,
    withConfidence: (signal: string, confidence: number | null) =>
      confidence === null ? signal : `${signal} ${confidence}%`,
    kinds: {
      sameTrade: (dir: string) => `AI は今回も ${dir} と判断しています`,
      sameWait: "前回も今回も AI 自身が見送りです",
      reversed: (prev: string, cur: string) => `AI は方向を ${prev} → ${cur} に変えました`,
      tradeToWait: "AI は今回、新規エントリーを見送りました（AI 自身の判断）",
      waitToTrade: (cur: string) => `前回は見送り、今回は ${cur} です`,
      unclear: "前回の提案シグナルが記録されていないため、比較できません",
    },
    refusedNow: (reason: string) => `ただし今回はサーバーが公開を見送りました（${reason}）`,
    refusedThen: (reason: string) => `前回はサーバーが公開を見送っていました（${reason}）`,
    gateRr: (rr: number) => `今回のゲート計測: RR 1:${rr}`,
    gateNone: "今回は新規プランが出ていないため、ゲートの計測はありません",
    previousLevelsRefused: "前回の水準は AI が提案し、サーバーが公開を見送ったものです",
    previousWasWait: "前回は見送り（水準なし）",
    // 水準が読めなかった回。AI 自身の見送りではないので「見送り」とは書かない。
    previousLevelsUnrecorded: "前回の水準は揃って記録されていません",
    noiseNote: "同じ入力でも AI の判定は割れることがあります。見出しは、名前の付いた計測事実が裏付けるときだけ信頼してください。",
  },

  index: {
    emptyLine1: "「分析開始」をクリックすると",
    emptyLine2: "マルチタイムフレームのデータ取得＋AI分析を行います",
    upgradeTitle: "全機能を使うにはプランをアップグレード",
    upgradeBody: "分析回数の上限解放・全テクニカル指標・優先サポートが利用できます",
    upgradeCta: "アップグレード",
    limitTitle: "本日の分析上限に達しました",
    limitBody: "より多くの分析を行うにはプランをアップグレードしてください",
    disclaimer:
      "本アプリの分析結果はAIによる参考情報であり、投資助言ではありません。FX取引にはリスクが伴い、投資元本を超える損失が発生する可能性があります。取引の最終判断は必ずご自身の責任で行ってください。",
  },

  errors: {
    loginRequired: "ログインが必要です",
    limitReached: "本日の分析上限に達しました",
    limitReachedBody: "プランをアップグレードしてください",
    adminNotDeployed: "Admin Mode未反映",
    adminNotDeployedBody: "analyze Edge Function を再デプロイすると管理者バイパスが有効になります",
    noResult: "分析結果が取得できませんでした。もう一度お試しください。",
    network: "analyze に接続できませんでした。関数のデプロイ状態またはCORS設定を確認してください。",
    generic: "分析処理でエラーが発生しました",
    wallClock: "分析に時間がかかりすぎて中断されました。「経済ニュース・指標も考慮する」をOFFにすると速くなります。",
    server: (status: number) => `サーバーエラー (${status})`,
    render: "表示エラーが発生しました",
    renderBody: "ページを再読み込みして、もう一度お試しください。",
    signIn: "メールアドレスまたはパスワードが正しくありません",
    signInOther: (m: string) => `ログインエラー: ${m}`,
  },

  password: {
    tooShort: (n: number) => `パスワードは${n}文字以上で入力してください`,
    needsBoth: "パスワードには英字と数字を両方含めてください",
    alreadyRegistered: "このメールアドレスは既に登録されています",
    leaked: "このパスワードは過去に漏洩したものとして知られています。別のパスワードを設定してください",
    weak: "パスワードに英字と数字（設定によっては記号）を混ぜてください",
    signUpOther: (m: string) => `登録エラー: ${m}`,
  },

  login: {
    // ソーシャルログイン
    orContinueWith: "または",
    withGoogle: "Google で続ける",
    withApple: "Apple で続ける",
    providerOff: "この方法でのログインは現在ご利用いただけません。メールアドレスとパスワードでお試しください。",
    providerFailed: (detail: string) => `ログインを開始できませんでした: ${detail}`,
    socialNote: "既存のアカウントと同じメールアドレスなら、同じアカウントにログインします。",
    createAccount: "アカウントを作成",
    signInToStart: "ログインして開始",
    email: "メールアドレス",
    password: "パスワード",
    passwordPlaceholder: (n: number) => `${n}文字以上・英字と数字を含む`,
    confirmPassword: "パスワード確認",
    confirmPlaceholder: "もう一度入力",
    submitSignUp: "アカウント作成",
    submitSignIn: "ログイン",
    haveAccount: "既にアカウントをお持ちですか？",
    noAccount: "アカウントをお持ちでないですか？",
    bothRequired: "メールアドレスとパスワードを入力してください",
    mismatch: "パスワードが一致しません",
    created: "アカウントを作成しました。リダイレクトしています...",
    genericError: "エラーが発生しました",
    consentBefore: "アカウント作成により、",
    consentMiddle: "と",
    consentAfter: "に同意したものとみなされます。",
    disclaimer: "本アプリの分析結果はAIによる参考情報であり、投資助言ではありません。",
  },

  settings: {
    title: "設定",
    saved: "設定を保存しました",
    planSection: "プラン情報",
    currentPlan: "現在のプラン",
    adminNote: "管理者アカウントのため、サブスクリプションなしで全機能を無制限にご利用いただけます。",
    nextBilling: "次回更新日",
    cancelDate: "解約予定日",
    cancelPendingUntil: (d: string) => `解約予定（${d} まで利用可能）`,
    cancelDone: "解約手続き済み",
    cancelPlan: "プランを解約する",
    upgrade: "プランをアップグレード",
    pair: "取引通貨ペア",
    cancelTitle: "プランを解約しますか？",
    cancelBody: (plan: string) => `${plan}プランを解約します。期間終了日までは現在のプランを引き続きご利用いただけます。`,
    cancelBody2: "期間終了後は自動的にFreeプランへ切り替わります。",
    cancelConfirm: "解約する",
    cancelFailed: "解約に失敗しました",
    cancelSucceeded: "解約手続きが完了しました",
    cancelUsableUntil: (d: string) => `${d} までご利用いただけます`,
  },

  pricing: {
    back: "ダッシュボードに戻る",
    title: "料金プラン",
    subtitle: "あなたのトレードスタイルに合ったプランをお選びください",
    current: (p: string) => `現在のプラン: ${p}`,
    adminNote: "管理者アカウントのため、お申し込みなしで全機能を無制限にご利用いただけます",
    recommended: "おすすめ",
    inUse: "ご利用中",
    subscribe: "申し込む",
    perMonth: "/月",
    adminToastTitle: "管理者アカウントです",
    adminToastBody: "サブスクリプションなしで全機能をご利用いただけます",
    features: {
      light: ["10回/日の分析", "USD/JPYのみ", "1時間足のみ"],
      standard: ["30回/日の分析", "全通貨ペア対応", "全時間足対応", "ファンダメンタル分析", "分析履歴保存"],
      pro: ["無制限の分析", "全機能", "アラート通知（予定）", "優先サポート"],
    },
  },

  lp: {
    nav: { features: "機能", pricing: "料金", faq: "よくある質問" },
    // The headline wraps a highlighted phrase, so it is stored as the pieces
    // around it rather than as one string containing markup.
    heroBefore: "予想を、",
    heroHighlight: "出しっぱなしにしない",
    heroAfter: "。",
    heroLine2: "AIが自分の判断を採点し、外れた理由を調べます。",
    subtitleBefore: "RSI・MACD・ボリンジャーバンドなど",
    subtitleCount: "11種",
    subtitleAfter: "のテクニカル指標に経済指標カレンダーを重ね、マルチタイムフレームでエントリー・損切り・利確まで提示。さらに全プランを実際のBid/Askで自動採点し、外れた分は原因を特定してAI自身のルールに反映します。",
    noCard: "アカウント作成は無料。分析のご利用は有料プラン（月額2,980円〜）から",
    painTitle: "こんな悩み、ありませんか？",
    pains: ["複数の指標を見るのが大変", "エントリーのタイミングに迷う", "ツールの予想が当たったのか、誰も検証しない"],
    featuresTitle: "Sextantでできること",
    features: [
      { title: "全自動データ取得", desc: "リアルタイム価格、RSI、MACD、ボリンジャーバンド、一目均衡表など11種の指標に加え、今週の経済指標カレンダーまで自動取得" },
      { title: "4つの時間足を同時に測る", desc: "15分足・1時間足・4時間足・日足で、直近の高安、終値で抜けた水準、次の水準までの余地をそれぞれ計算。時間足どうしが食い違っているときは、食い違っていると出します" },
      { title: "確定した足だけで計算", desc: "形成中のローソク足と、市場が閉まっていた時間帯の見せかけの値動きを除いてから指標を計算。週末をまたぐ足で数字が歪まない" },
    ],
    stepsTitle: "3ステップで使える",
    steps: [
      { title: "アカウント作成", sub: "30秒で完了" },
      { title: "プラン選択", sub: "月額2,980円〜" },
      { title: "「分析開始」を押すだけ", sub: "即座に結果表示" },
    ],
    pricingTitle: "シンプルな料金プラン",
    pricingDetails: "料金詳細を見る",
    choosePlan: "このプランで始める",
    loopTitle: "AIが自分の予想を採点する",
    loopBody: "他のツールとの違いはここです。出した予想はサーバー側で自動追跡され、外れたものは必ず原因を調べられます。人が回す作業はありません。",
    loopSteps: [
      { title: "採点", desc: "プランの期限まで15分ごとに実勢レートで追跡し、約定したか・損切りか・利確かを自動判定。買いはAskで約定してBidで決済、という実際の板の向きで計算します" },
      { title: "検証", desc: "外れたプランは決着後の値動きまで遡り、「損切り後に利確値へ到達したか」「成行なら勝てたか」「その損切り幅は成立しうるか」を計算して原因を特定します" },
      { title: "反映", desc: "特定した原因から、次の分析でAIが守るルールを書き換え。何件の実績に裏付けられたルールかまで、アプリ内で確認できます" },
    ],
    loopLive: (version: number, rules: number, updated: string) =>
      `現在のルールブック: v${version}（${rules}ルール・最終更新 ${updated}）`,
    loopLiveNote: "このルールは人が書いたものではなく、外れたトレードの検証から自動生成されています",
    honestTitle: "勝率をうたわない理由",
    honestBody: "統計的に意味を持つ件数に達するまで、当サービスは勝率を公表しません。目安は独立した決着50件で、到達後はアプリ内に95%信頼区間つきで表示します。都合のいい数字だけをお見せしないための方針です。",
    faqTitle: "よくある質問",
    faqs: [
      { q: "Sextantとは何ですか？", a: "為替の値動きを測るテクニカル分析ツールです。RSI、MACD、ボリンジャーバンド、一目均衡表など11種の指標と、直近の高安・終値で抜けた水準・次の水準までの余地といった値動きの構造を、15分足・1時間足・4時間足・日足で計算します。" },
      { q: "他のAI分析ツールと何が違いますか？", a: "出した予想を必ず採点し、外れた理由を自動で調べる仕組みが入っている点です。全プランは期限まで実際のBid/Askで追跡され、外れたものは決着後の値動きから原因を特定し、その結果がAIの守るルールに反映されます。ルールの内容と、そのルールが何件の実績に裏付けられているかはアプリ内で確認できます。" },
      { q: "勝率はどのくらいですか？", a: "統計的に意味を持つ件数に達していないため、現時点では公表していません。少ない件数の勝率は運とほとんど区別がつかないためです。独立した決着50件を目安とし、到達後はアプリ内に95%信頼区間つきで表示します。" },
      { q: "投資助言サービスですか？", a: "いいえ。本サービスは相場分析情報の提供であり、投資助言・代理業には該当しません。売買の最終判断とその結果はお客様ご自身に帰属します。" },
      { q: "どの通貨ペアに対応していますか？", a: "USD/JPY、EUR/USD、GBP/JPY、EUR/JPYなど主要な通貨ペアに対応しています。Lightプランはドル円のみ、Standard/Proプランは全通貨ペアに対応しています。" },
      { q: "無料で使えますか？", a: "アカウントの作成は無料で、料金プランや機能はご覧いただけます。AIによる分析機能のご利用には有料プランのご契約が必要です。プランはLight（月額2,980円）、Standard（月額5,980円）、Pro（月額12,800円）の3つからお選びいただけます。" },
      { q: "分析にはどのくらい時間がかかりますか？", a: "テクニカル分析のみの場合は約10〜15秒、ファンダメンタル分析を含めた場合は約20〜30秒で結果が表示されます。" },
      { q: "どのようなテクニカル指標を使用していますか？", a: "RSI、MACD、ボリンジャーバンド、SMA（移動平均線）、一目均衡表、ATR、ストキャスティクス、ADXなど11種のテクニカル指標を使用し、マルチタイムフレーム分析（15分足/1時間足/4時間足/日足）を行います。" },
      { q: "解約はいつでもできますか？", a: "はい、マイページからいつでも解約可能です。解約後も契約期間終了まではご利用いただけます。" },
    ],
    ctaTitle: "今すぐ始めましょう",
    ctaBody: "アカウント作成は30秒で完了します",
    shareTitle: "Sextantを広める",
    shareBody: "このツールを友人やフォロワーにシェアして、賢いトレードを広めましょう",
    shareText: "予想を出しっぱなしにしないFX AIツールを見つけました。全プランを実勢レートで自動採点して、外れた理由まで調べてくれます。 #FX #AI分析 #トレード",
    aria: { nav: "メインナビゲーション", hero: "ヒーロー", pain: "ユーザーの悩み", features: "機能紹介", steps: "利用ステップ", pricing: "料金プラン", loop: "自動採点と学習の仕組み", faq: "よくある質問", cta: "登録CTA", share: "SNSシェア", footerNav: "フッターナビゲーション" },
  },

  landing: {
    login: "ログイン",
    startFree: "始める",
    terms: "利用規約",
    privacy: "プライバシーポリシー",
    tokushoho: "特定商取引法に基づく表記",
    contact: "お問い合わせ",
    footerNote: "本サービスは投資助言ではありません。FX取引にはリスクが伴います。",
    // Share strings for the landing page's own SNS buttons. They lived under
    // `blog` until the blog was removed; the buttons are the landing page's,
    // so the keys moved here rather than being deleted with it.
    share: {
      shareX: "Xでシェア",
      shareLine: "LINEで共有",
      copyLink: "リンクをコピー",
      copied: "コピー済み",
      copiedToast: "リンクをコピーしました",
      copyFailed: "コピーに失敗しました",
    },
  },

  contact: {
    title: "お問い合わせ",
    intro: "ご質問、ご要望、不具合の報告などがございましたら、以下のフォームよりお気軽にお問い合わせください。3営業日以内にご返信いたします。",
    mail: "メール: support@fx-tactical-analyzer.com",
    name: "お名前",
    namePlaceholder: "山田 太郎",
    email: "メールアドレス",
    subject: "件名",
    subjectPlaceholder: "お問い合わせ内容の件名",
    message: "お問い合わせ内容",
    messagePlaceholder: "お問い合わせ内容を入力してください",
    send: "送信する",
    sending: "送信中...",
    sentTitle: "送信完了",
    sentBody: "お問い合わせを受け付けました。3営業日以内にご返信いたします。",
  },

  // Terms / Privacy / 特定商取引法 are Japanese legal documents. A machine
  // translation presented as the operative text would be a liability, so the
  // Japanese stands and non-Japanese readers get told why.
  legal: {
    japaneseAuthoritative: "",
  },
};

// Deliberately NOT `as const`: the literal types it produces would force every
// other locale to repeat the Japanese strings verbatim. Widened strings still
// require every KEY, which is the guarantee we actually want.
export type Dict = typeof ja;
