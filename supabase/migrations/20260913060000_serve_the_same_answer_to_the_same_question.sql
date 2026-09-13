-- 同じ入力なら、同じ答えを出す（#90）。
--
-- 同じ入力に同じ答えが返らないことは測ってある: 保存済みプロンプトを再生した
-- 48 回のうち 10 回が SELL↔WAIT で割れた（#64、ノイズ床 20.83%）。つまり
-- 「同じ条件でもう一度分析する」は、証拠を増やす操作ではなく、アナリストの
-- ノイズを引き直す操作である。引き直さずに前の答えを出す。
--
-- 鍵は「送った 2 本の文字列 + 送った形」。プロンプトの中身を列挙しないのは、
-- 列挙するとプロンプト側が育つたびに鍵が古くなるから。鍵がプロンプトそのもの
-- なら、育っても鍵は正しいままである。
-- 除外するのは `現在時刻(UTC):` の 1 行だけ（毎回違うので、入れると一度も
-- 一致しない）。除外した分は、再利用できる時間の幅で縛る（analyze/reuse.ts）。
--
-- 作る前に本番で測った（2026-09-13、プロンプト保存済み 91 行）:
--   完全一致                     0 組
--   時刻の行を外して一致          1 組（下見の 1h、1 分差、両方 WAIT 68）
--
-- この 1 件が、この機能の形のすべてである。market_v1 ではプランは「その瞬間の
-- 値段」で約定し、その値段はプロンプトに入っている（`現在値:`）。だから市場が
-- 動いている間は、2 回の入力が一致することは原理的に無い。一致するのは
-- **休場中（下見）か、フィードが動いていないとき**だけ。
-- 逆に言えば、1 分差で WAIT→SELL が割れた実測ペアは入力が違っていたので、
-- これでは直らない。直すなら「確定足だけで判断する」という別の変更が要る。

-- ---------------------------------------------------------------------------
-- 1. 行に鍵を刻む
-- ---------------------------------------------------------------------------

alter table public.analyses add column if not exists inputs_key text;

comment on column public.analyses.inputs_key is
  'この回の入力の指紋（sha256）。送った system と user、model / effort / max_tokens、'
  '下見かどうか、契約、ロケールから作る。user からは `現在時刻(UTC):` の行だけを外す。'
  'NULL は「この列より前の行」。ハッシュなので中身は復元できない。';

-- 引くのは「自分の・同じ鍵の・最新」だけ。
create index if not exists analyses_reuse_lookup_idx
  on public.analyses (user_id, inputs_key, created_at desc)
  where inputs_key is not null and shadow = false;

-- ---------------------------------------------------------------------------
-- 2. 再利用したことを残す（プランの行は書き換えない）
-- ---------------------------------------------------------------------------
--
-- 「もう一度出した」はプランについての事実ではなく、配ったことの記録なので、
-- プランの行に書き足さず別の表に積む。追記のみ。
-- 数を隠さないため（§7.3）: 何回効いて、効かなかったときは何が理由だったかを
-- 両方書く。効いた回しか記録しないと、「ほとんど起きない」という一番大事な
-- 事実が記録から消える。
create table if not exists public.analysis_reuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 再利用したときだけ埋まる。断ったときは NULL。
  analysis_id uuid references public.analyses (id) on delete set null,
  inputs_key text not null,
  pair text not null,
  interval text not null,
  preview boolean not null,
  -- 'served' か、断った理由（no_match / outside_window / not_servable /
  -- positions_changed / forced_fresh）。
  outcome text not null,
  -- 再利用した元の分析の時刻。断ったときは NULL。
  analyzed_at timestamptz,
  served_at timestamptz not null default now()
);

comment on table public.analysis_reuses is
  '同じ入力での再利用を試みた記録。効いた回（outcome = served）と断った回の両方を積む。'
  'service role 専用。プランの行は書き換えない——もう一度配ったことは、プランについての事実ではない。';
comment on column public.analysis_reuses.outcome is
  'served / no_match / outside_window / not_servable / positions_changed / forced_fresh。'
  '断った理由を残さないと「一度も効いていない」と「そもそも試していない」が見分けられない。';

create index if not exists analysis_reuses_served_at_idx
  on public.analysis_reuses (served_at desc);

alter table public.analysis_reuses enable row level security;
-- 方針は置かない: 方針の無い RLS は service role 以外を全部拒む。
revoke all on public.analysis_reuses from public, anon, authenticated;
