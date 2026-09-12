-- 分析を Sonnet + effort "max" に切り替える。その前に、送信時の形を行に刻む。
--
-- #68b で public.analyses.model を足したときの理由はこうだった:
--
--   「入れ替えたあとでは手遅れだから。刻んでいない行は、あとから刻み直せない。」
--
-- 2026-09-12、同じ理由が残り2つのリクエスト引数について満期を迎えた。
--
-- noise-floor/shape.ts は再生リクエストを組み立てるとき、**model は行から取り、
-- effort と max_tokens は固定定数から取る**。その非対称に理由は無く、
-- 定数が動いた日——つまり今日——に初めて害になる:
--
--   切り替え前の行（effort "medium" / max_tokens 8000 で送られた）を
--   切り替え後に再生すると、その行が一度も送られたことのない深さで走る。
--   そして何もそれを言わない。
--
-- shape.ts のコメント自身がこう書いている:
--
--   「本番より長く考えられる再生は、本番の再生ではない。」
--
-- model については守られていて、effort と max_tokens については守られていない。
-- #68b と一字一句同じ形の穴である。
--
-- NULL の意味。「記録が無い」であって「既定値だった」ではない。
-- 2026-09-12 時点で90行すべてがこの列より前に書かれているので、すべて NULL になる。
-- 埋めない。当時のデプロイの定数は git から読めるが、推測を列に書けば
-- 測定値と見分けがつかなくなる。このリポジトリが繰り返し避けてきたのはその1点で、
-- #68b が21行を NULL のまま残したのと同じ判断である。
--
-- 読む側（shape.ts）は NULL を見たら、切り替え前の定数を明示的な fallback として
-- 使い、**そう記録する**。黙って今の定数を当てることはしない。

alter table public.analysis_prompts
  add column if not exists effort text,
  add column if not exists max_tokens integer;

comment on column public.analysis_prompts.effort is
  'この分析が送られたときの output_config.effort。'
  'NULL は「記録が無い」であって「既定値だった」ではない——'
  'この列より前の行と、API が output_config を拒否して effort 無しで再送された行が NULL になる。'
  'model と同じ役割: 再生が本番と同じ深さで走ることを保証する唯一の手段。';

comment on column public.analysis_prompts.max_tokens is
  'この分析が送られたときの max_tokens。'
  'NULL は「記録が無い」であって「既定値だった」ではない。'
  '上限が動くと、打ち切られた応答の出方が変わる——'
  'それは再生の形の一部であり、あとから推測で埋めてはならない。';
