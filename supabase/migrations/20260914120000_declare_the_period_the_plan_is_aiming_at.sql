-- そのプランが「どの期間の値動きを取りに行く提案なのか」を、行に書く。
--
-- **地平線は欠けていたのではなく、4か所で別々に決まっていた。** 1時間足の1プラン
-- について同時に: AIには「この先12時間を見ろ」（econ-calendar HORIZON_MS）、未約定
-- エントリーの有効期限は48時間（ENTRY_WINDOW_MS）、建玉の寿命は20営業日≒28日
-- （EXPIRY_DAYS）、損切り幅の上限は1時間足ATR1本分（MAX_STOP_ATR）。最大40倍の開きが
-- あり、どこにも宣言されていなかった。だから5つ目の数字を足すと悪化する。
--
-- ここは新しい数字を1つも作らない。plan_horizon.bars は HORIZON_MS を、その足の
-- 1本の長さで割っただけである（6h/15min=24, 12h/1h=12, 48h/4h=12, 120h/1day=5)。
-- econ-calendar は今後この表から導出する側になり、src/test/horizon.test.ts が
-- 4つの積を固定するので、どちらかが黙ってずれることはない。
--
-- **本数で宣言する理由。** 本番の決着53件を実測すると、保有時間は「本数」で見ると
-- 足にほぼ依らない（中央値 1.05 / 1.67 / 1.26 / 2.82）のに、壁時計では約74倍違う。
-- 時間で書けば無関係な4つの数字、本数で書けば1つの文になる。#86 の expires_bars と
-- 同じ単位でもあるので、宣言と後の実測が違う単位になることがない。
--
-- **これは打ち切りではない。** ここが設計の要で、好みではなく実測で決まっている。
-- 同じ53件を宣言本数で切ると、6本で11件（うち勝ち4）、12本で3件（うち勝ち2）、
-- 24本で2件（**両方とも勝ち**）が捨てられる。長い尾にいるのは勝ちである。だから
-- 宣言を過ぎても決済が付くまで採点は続き、「期間の内に決着したか」は勝敗の代わりでは
-- なく**横に**記録される。31本かかった勝ちは勝ちのまま within=false になる。
--
-- scoring_windows は地平線ではない。トラッカーの外側の境界（未約定をいつまで待つか、
-- いつ追跡を諦めるか）を**値を1つも変えずに**行へ凍結する。いま採点器はこれを生きた
-- モジュール定数から読んでいるので、定数を調整すると発行済みのプランが黙って再採点
-- される。waits.ts が自分のために既に直した危険と同じもので、凍結はその前提になる。
--
-- バックフィルはしない。既存116行は plan_horizon が null のままで、画面は「記録なし」
-- と出す。宣言が存在しなかった時期のプランに今日の表を後から刻むのは、まさにこの
-- 移行が止めようとしている種類の嘘である。

alter table public.analyses
  add column if not exists plan_horizon jsonb;

alter table public.analyses
  add column if not exists scoring_windows jsonb;

comment on column public.analyses.plan_horizon is
  'そのプランが狙う期間。{version, bars, interval, source, bar_ms, declared_at, ends_at, calendar_covers_horizon}。'
  'bars はエントリー足の本数で、econ-calendar の HORIZON_MS をその足の長さで割った値（新しい数字ではない）。'
  'declared_at は priced_at（created_at ではない。あちらはモデル呼び出しとゲートと履歴書き込みの後、30〜120秒遅れる）。'
  'ends_at は marketHorizonEnd で市場時間を歩いた結果を発行時に凍結したもので、精度は30分（HORIZON_STEP_MS）。'
  '**これは打ち切り時刻ではない。** 過ぎても決済が付くまで採点は続く。期間の内に決着したかは別に記録する。'
  'NULL はこの列が存在する前に書かれた行（バックフィルしない）。';

comment on column public.analyses.scoring_windows is
  'この行が発行された時点のトラッカーの外側の境界を凍結したもの。{version, unfilled_entry_ms, wait_window_ms, give_up_days}。'
  '地平線ではない。値は ENTRY_WINDOW_MS / EXPIRY_DAYS のまま1つも変えていない。'
  '凍結する理由は、採点器がこれらを生きた定数から読んでいるため、定数を調整すると発行済みのプランが黙って'
  '再採点されるから（waits.ts が自分のために既に直した危険と同じ）。読み出し側の切り替えは後の段階で行う。';

-- 採点側がまだ読んでいない行を引くための部分索引。第2段階（horizon_check）で使う。
create index if not exists analyses_horizon_declared_idx
  on public.analyses (created_at)
  where plan_horizon is not null;
