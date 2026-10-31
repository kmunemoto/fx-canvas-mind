// #318 (docs §8.113 20 (f)): the planted errors of the trial. Each is a named hook in the code, switched on by
// CB_PLANT (one at a time, made-up runs only); its `expect` lists the checks of which at least one must fail
// (the right-hand side of 20 (f)). plant-sum lists every check that failed for each plant and stops when none
// of the expected ones did (「書いた確かめでは見つからなかった」).
//
// hook: "hand" — the hand examples (CB_MODE=hand, and the Python's --plant twin); "run" — a full made-up run
// of N 101 in the main period; "gate" — refused before reading (exit 2) or by stage 2's gate; "print" — the
// printer's list.
// status "deferred": the named check needs items or data outside step 2 (SQ-12, SQ-13); the hook is not run.

export interface PlantDef {
  name: string;
  hook: "hand" | "run" | "gate" | "print";
  expect: readonly string[];
  status: "trial" | "deferred";
  note: string;
}

export const PLANTS: readonly PlantDef[] = [
  { name: "formingBar", hook: "run", expect: ["lookahead.cut.donchian-A20"], status: "trial", note: "確定していない足を使う → 切り取り (donchian-A20 reads the next bar's close)" },
  { name: "eNextBar", hook: "run", expect: ["lookahead.poison.donchian-A20", "lookahead.poison.donchian-A55", "lookahead.poison.breedon-1", "lookahead.poison.breedon-2"], status: "trial", note: "E を次の足から取る → 毒 (events.ts eOf, the one E of the records, the blind rows and so every trade's levels)" },
  { name: "hhIncludesI", hook: "hand", expect: ["hand.c1.docs", "lookahead.cut.donchian-A20"], status: "trial", note: "donchian の HH に足 i を入れる → 切り取り・手の例 (the window i−n+1..i holds bar i's own high, so no close ever breaks it: the hand example catches it; a cut finds nothing to differ)" },
  { name: "followFromSignalBar", hook: "run", expect: ["lookahead.followFixed"], status: "trial", note: "追う足を合図の足から始める → 追う足の (i)" },
  { name: "followLate1", hook: "run", expect: ["lookahead.followFirst"], status: "trial", note: "追い始めを1本遅らせる → 追う足の (ii)" },
  { name: "ambAsTp", hook: "hand", expect: ["hand.follow.amb"], status: "trial", note: "amb を利確に数える → 手の例（追い方）" },
  { name: "buyExitAsk", hook: "hand", expect: ["hand.follow.upFirst", "hand.follow.downFirst", "hand.follow.askBuyTp"], status: "trial", note: "買いを Ask で決済する → 手の例（追い方）" },
  { name: "usdPip001", hook: "hand", expect: ["hand.follow.usdExact"], status: "trial", note: "ドルのペアの pip を 0.01 にする → 手の例（追い方）" },
  { name: "entryMid", hook: "hand", expect: ["hand.follow.upFirst", "hand.follow.downFirst"], status: "trial", note: "入りを中値にする → 手の例（追い方）" },
  { name: "mirrorSameDir", hook: "hand", expect: ["hand.mirror"], status: "trial", note: "鏡を合図と同じ向きにする → 手の例（鏡）・裏返し・N (the flip and N in the sets)" },
  { name: "midHalfEven", hook: "hand", expect: ["hand.round.1"], status: "trial", note: "中値を偶数へ丸める → 手の例（丸め）" },
  { name: "midShortestRepr", hook: "hand", expect: ["hand.round.2"], status: "trial", note: "Decimal(str(v)) で丸める → 手の例（丸め） (the TS twin: rounding the shortest decimal string)" },
  { name: "pointsTrunc", hook: "hand", expect: ["hand.points"], status: "trial", note: "点を切り捨てで作る → 手の例（点）" },
  { name: "stratumNoHour", hook: "hand", expect: ["hand.delta.strata"], status: "trial", note: "ブラインドの層から時を外す → H と手の例（Δ）" },
  { name: "noBlind", hook: "hand", expect: ["hand.delta.strata", "hand.delta.one"], status: "trial", note: "ブラインドを引かない → D の歯と手の例" },
  { name: "seNoBlindTerm", hook: "hand", expect: ["hand.delta.strata", "hand.delta.one"], status: "trial", note: "標準誤差からブラインドの項を外す → 手の例（Δ）" },
  { name: "signalTermStratumMean", hook: "hand", expect: ["hand.delta.one"], status: "trial", note: "合図の影響を層の中の平均で引く → 手の例（合図が1件だけの層）と N の (5)" },
  { name: "stratumNoSeason", hook: "hand", expect: ["hand.delta.season"], status: "trial", note: "層から季節の組を外す → 手の例（Δ の季節）" },
  { name: "shiftNoRing", hook: "hand", expect: ["hand.shift"], status: "trial", note: "週ずらしを輪にしない → 手の例（週ずらし）" },
  { name: "noHolm", hook: "hand", expect: ["hand.holm"], status: "trial", note: "Holm を使わず1つずつ2.5%で見る → 手の例（Holm）と N" },
  { name: "selectByPoint", hook: "hand", expect: ["hand.select"], status: "trial", note: "点で選ぶ → 手の例（選び方）" },
  { name: "ignoreGroups", hook: "hand", expect: ["hand.select"], status: "trial", note: "重なりの組を無視する → 手の例（選び方）" },
  { name: "floorH1Only", hook: "hand", expect: ["hand.floor"], status: "trial", note: "床を前半の数だけで見る → 手の例（床）" },
  { name: "allowCrossSplit", hook: "hand", expect: ["hand.half"], status: "trial", note: "前半の合図の追う窓が SPLIT をまたぐのを許す → 手の例（半分）" },
  { name: "splitShift1w", hook: "hand", expect: ["hand.half"], status: "trial", note: "SPLIT を1週ずらす → 手の例（半分）" },
  { name: "londonDstAsNy", hook: "hand", expect: ["hand.time.dst", "hand.delta.season"], status: "trial", note: "ロンドンの夏時間を NY の切り替えの日で替える → 手の例（時刻）" },
  { name: "countUnsent", hook: "hand", expect: ["hand.sent"], status: "trial", note: "送られない時刻の合図を数える → 手の例（送られる合図）" },
  { name: "noRiseEdge", hook: "hand", expect: ["hand.events.condition", "hand.c1.docs"], status: "trial", note: "立ち上がりを見ない → 手の例 (pinbar・round in step 3; the event framework's condition case and C1's in step 2: SQ-13)" },
  { name: "dropAdverse1h", hook: "run", expect: ["lookahead.poison.donchian-A20"], status: "trial", note: "donchian-A20 で「T＋1時間までに中値が E から逆向きに13 pips 動く合図を消す」→ 毒" },
  { name: "stage2Unselected", hook: "gate", expect: ["gate.unselected"], status: "trial", note: "選ばなかった項目の後半を計算する → 段2の門 (one unchosen item more in the second half's list; halfRowsOf refuses it before computing it, exit 2)" },
  { name: "stage1FollowH2", hook: "run", expect: ["lookahead.h1Only"], status: "trial", note: "段1で後半の取引を追う → h1Only (stage 1's follow checks also sample the second half's counted signals)" },
  { name: "printExtraItem", hook: "print", expect: ["print.items"], status: "trial", note: "出してよい項目に無い数を出す → 出してよい項目" },
  { name: "printToLog", hook: "print", expect: ["print.items"], status: "trial", note: "成績を print.txt 以外に出す → 出してよい項目" },
  { name: "printHoldExtra", hook: "print", expect: ["print.items"], status: "trial", note: "オーナーの持ち方の、出してよい項目に無い数を出す → 出してよい項目 (gates-05: hold.<src>.<acct>.* is listed key by key; the plant prints hold.ultra5.full.main.E)" },
  { name: "printTextExtra", hook: "print", expect: ["print.items"], status: "trial", note: "決めていない文を出す → 出してよい項目 (gates-05: text.* is listed id by id; the plant prints text.s2.note)" },
  { name: "badSha", hook: "gate", expect: ["data.candidatesSha"], status: "trial", note: "sha256 を間違える → 何も読まずに止まる (exit 2)" },
  // deferred (SQ-12, SQ-13): their checks need items or data step 2 does not build
  { name: "c4ByLatePoint", hook: "run", expect: ["set.Q"], status: "deferred", note: "C4 を Δ_late の点で見る → Q (no in-scope item gets a spurious positive Δ under Q: SQ-12)" },
  { name: "dayAggIncludesT", hook: "run", expect: ["lookahead.poison"], status: "deferred", note: "日の集計に T を含む日を使う → 毒（日の集計）: no trial item aggregates days" },
  { name: "sigmaIncludesNow", hook: "hand", expect: ["hand.bigmove", "hand.knn"], status: "deferred", note: "bigmove・knn の σ に今の足を入れる → 手の例 (step 3)" },
  { name: "knnSelf", hook: "run", expect: ["lookahead.poison.knn"], status: "deferred", note: "knn のライブラリに j ＝ i を入れる → 毒 (step 3)" },
  { name: "gapGIncludesWeek", hook: "hand", expect: ["hand.gap"], status: "deferred", note: "gap の G_t にその週を入れる → 手の例 K3 (step 3)" },
  { name: "gapFriday20", hook: "run", expect: ["item.gap.summerF"], status: "deferred", note: "gap の F の窓を金曜 20:00 UTC からにする (step 3)" },
  { name: "kamaSlope2", hook: "run", expect: ["item.kama"], status: "deferred", note: "kama-B の傾きを K_i − K_{i−2} で見る (step 3)" },
  { name: "kamaPrice2", hook: "run", expect: ["item.kama"], status: "deferred", note: "kama-A の P_i を K_{i−2} と比べる (step 3)" },
  { name: "roundPivotPresence", hook: "run", expect: ["lookahead.presence1", "lookahead.presence2"], status: "deferred", note: "round・pivot に i+1〜i+8 の決まりを戻す (step 3)" },
  { name: "pivotLastBarByNext", hook: "run", expect: ["lookahead.presence2"], status: "deferred", note: "pivot の最後の足を次の足で決める (step 3)" },
  { name: "jpHolidayShift", hook: "hand", expect: ["hand.fix"], status: "deferred", note: "日本の祝日を1日ずらす → 手の例 (step 3)" },
];

// the plant of this process (one, read once): "" when none; an unknown name stops the run
let current: string | null = null;
export const setPlant = (name: string) => {
  if (name && !PLANTS.some((p) => p.name === name)) throw new Error(`CB_PLANT ${name}: not a planted error of the trial`);
  current = name;
};
export const plant = (): string => {
  if (current === null) {
    let v = "";
    try {
      v = Deno.env.get("CB_PLANT") ?? "";
    } catch {
      v = "";
    }
    setPlant(v);
  }
  return current ?? "";
};
export const planted = (name: string): boolean => plant() === name;
export const plantDef = (name: string): PlantDef | undefined => PLANTS.find((p) => p.name === name);
