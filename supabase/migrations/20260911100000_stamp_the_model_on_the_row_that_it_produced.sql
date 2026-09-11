-- #68b — 分析行に、それを書いたモデルの名前を刻む。
--
-- なぜ今か。所有者から「分析を Sonnet に替えたら精度は落ちるか」と問われた。答えは
-- 「今の記録では測れない」だが、調査の途中でそれより重い問題が出た。
--
--   public.analyses には model 列が無い。
--   src/lib/outcomeStats.ts と performance_stats は plan_contract と rulebook_version でしか
--   母集団を分けていない。
--
-- つまり今日モデルを入れ替えると、Opus が書いた行と Sonnet が書いた行が **1人の分析者の成績
-- として混ざる**。そして混ざったことは、あとから誰にも分からない。
--
-- これは supabase/functions/_shared/contract.ts が契約について書いている confound と
-- 同じものである:
--
--   「2つの契約は2つの母集団。統計は混ぜることを拒否し、ルールブックはある時代のルールを
--     別の時代の分析者に見せることを拒否する。」
--
-- 契約については守られていて、モデルについては守られていない。その非対称に理由は無い。
--
-- 入れ替えるかどうかはまだ決まっていない。決める前にこれを入れるのは、**入れ替えたあとでは
-- 手遅れだから**である。刻んでいない行は、あとから刻み直せない。
--
-- 保存場所について。モデルは public.analysis_prompts.model に既にある。そこを見れば足りる、
-- とはならない。2026-09-11 に本番で確認した事実:
--
--   * analysis_prompts は RLS 有効・ポリシー0・authenticated への grant 無し。
--     performance_stats / separated_scores / confidence_calibration はいずれも SECURITY INVOKER
--     なので、この表に join できない。DEFINER に変えるのは論外で、それは2アカウント分を
--     1人の成績に混ぜる（#88 でまさにそれを避けた）。
--   * プロンプト行を持たない分析が21件ある。すべて 2026-08-29〜09-04、つまり
--     #60（送信プロンプトの保存）より前。market_v1 には1件も無い。
--
-- よって列は analyses 側に置く。
--
-- NULL の意味。「記録されていない」であって「claude-opus-5 だった」ではない。上記21行は
-- NULL のまま残す。当時のデプロイが何だったかは推測できるが、推測を列に書けば、それは
-- 測定値と見分けがつかなくなる。このリポジトリが繰り返し避けてきたのはその1点である。

alter table public.analyses
  add column if not exists model text;

comment on column public.analyses.model is
  'この行のプランを書いたモデルの識別子。analyze が挿入時に書く。'
  'NULL は「記録が無い」であって「既定のモデルだった」ではない——'
  '#60 より前の行は送信プロンプトごと残っていないため、埋められない。'
  '成績をモデル間で混ぜないための鍵であり、plan_contract と同じ役割を果たす。';

-- 埋められるものだけ埋める。プロンプト行が1分析につき高々1行であることは
-- 2026-09-11 に本番で確認済み（重複0件）なので、この update は行を増やさない。
update public.analyses a
set model = p.model
from public.analysis_prompts p
where p.analysis_id = a.id
  and a.model is null
  and p.model is not null
  and length(p.model) > 0;
