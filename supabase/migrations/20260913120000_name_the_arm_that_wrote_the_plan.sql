-- どの版のアナリストがこのプランを書いたか（#86 / #87）。
--
-- これまで「候補版を試す」方法は 1 つしか無かった: モジュールの定数を書き換えて
-- 全トラフィックにデプロイする。その代償が §8.5 と §8.5-a で、本番の 504 が 2 回と
-- 同日 2 段階のロールバックである。ルールブックの `candidate` は答えにならない
-- （あれは再生専用の置き場で、analyze は一度も読んでいない）。
--
-- なぜ plan_contract を使わないか。あの列は「プランがどう約定するか」の規則を
-- 指す（_shared/contract.ts）。#86 も #87 も約定の仕方は変えない。変えるのは
-- **アナリストが何を見せられ、何を言ってよいか**である。plan_contract に相乗り
-- すると、トレードとしては同一の行を統計が別population として扱い、しかも契約に
-- ついて嘘をつくことになる。
--
-- なぜ "both" が無いか。この腕が比べられる相手は決着済み 48 件しかない。2 つに
-- 割れば 1 腕 24 件で、MIN_STAT_N（20）をかろうじて上回る程度でしかない。統計を出して
-- よい下限であって、余裕のある標本ではない。4 つに割ればどの区画も下限割れで、ラベルの付いた
-- ノイズである。「一度に 1 つ」は仕組みの制約ではなく、証拠が運べる唯一の形。

alter table public.analyses
  add column if not exists variant text not null default 'control';

alter table public.analyses
  add constraint analyses_variant_check
  check (variant in ('control', 'lower_tf', 'conditional_wait'));

comment on column public.analyses.variant is
  'この行を書いたアナリストの版。control = 現行。lower_tf = #87（下位足を仕掛け確認用に見せた）。'
  'conditional_wait = #86（WAIT のとき発動条件と有効期限を言ってよい）。'
  '約定の規則は変わらないので plan_contract とは別の軸。既定は control で、'
  'この列より前の行も既定値で control になる（実際に control だったので正しい）。';

-- 腕ごとに引けるように。統計は腕を混ぜてはいけない。
create index if not exists analyses_variant_idx
  on public.analyses (variant, created_at desc)
  where variant <> 'control';
