-- 条件付き WAIT（#86）。
--
-- 「今は入らないが、この水準にこちら側から触れたら、こちらに入る」という
-- 見立てを、WAIT の回に任意で書けるようにする。
--
-- **注文にはならない。** #37 が測っている: AI に約定価格を選ばせていた時期、
-- 売買 8 件のうち 5 件が未約定で、その 5 件すべてに AI 自身の Trend Day /
-- Breakout タグがシグナルと同じ向きに付いていた。analyze の should_be_market は
-- まさにその形を拒むために書かれた規則である。条件付き WAIT を指値にすると、
-- そこへ戻ることになる。だから画面に出るのは今までどおり水準なしの WAIT で、
-- ここに入るのは**横に置いて後で採点される予測**である。
--
-- 列を 2 本に分けるのは書き手が違うから。analyze が conditional_wait を書き、
-- track-outcomes が conditional_outcome を書く。1 本の jsonb を 2 つの関数が
-- 別々のタイミングで更新すると、片方が片方を消す。entry_check と evaluation が
-- 既にこの形になっている。

alter table public.analyses
  add column if not exists conditional_wait jsonb;

alter table public.analyses
  add column if not exists conditional_outcome jsonb;

comment on column public.analyses.conditional_wait is
  '#86。WAIT の回に AI が任意で書いた条件付きの見立て（発動水準・向き・発動時の方向・有効期限の足数・一行の根拠）。'
  'サーバーが検査して通ったものだけが入る（現在値の反対側・ATR で近すぎ／遠すぎは捨てる）。'
  'NULL は「書かれなかった／候補版ではなかった／検査で落ちた」。落ちた理由は entry_check.conditional_rejection にある。'
  'この水準で注文は出ない（#37）。';

comment on column public.analyses.conditional_outcome is
  '#86 の採点。track-outcomes が書く。not_triggered / triggered_right / triggered_wrong / '
  'triggered_unresolved / unmeasurable。'
  '**not_triggered は合格ではない。** 既存の WAIT 採点は「窓が終わって何も取らなかった」を correct と '
  '返すので、届かない水準を名指しするのが一番安く正しく見える手になってしまう。それを塞ぐための独立した判定である。';

-- 採点待ちを引くための部分索引。対象は WAIT で条件付きを書いた行だけ。
create index if not exists analyses_conditional_pending_idx
  on public.analyses (created_at)
  where conditional_wait is not null and conditional_outcome is null;
