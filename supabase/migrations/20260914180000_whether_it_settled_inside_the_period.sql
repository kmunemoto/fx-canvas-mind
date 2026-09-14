-- 期間の内に決着したかを、勝敗とは別の記録として出す（#91 step 2）。
--
-- step 1 でプランは「狙う期間」を宣言するようになった。宣言しただけでは、
-- 守れたかどうかは誰も見ていない。ここでそれを 4 つ目の軸として出す。
--
-- **これは勝ち負けではない。** 実測: 決着した 53 件を 24 本で打ち切ると 2 件が
-- 落ち、その 2 件は**どちらも勝ち**である。だから「期間外＝悪い」ではない。
-- 伸びた勝ちトレードは期間外に決着するし、それは良いことである。この軸は
-- **どちらが良いかを言わない記述的な数字**で、`descriptive` を立てて明示する。
--
-- 行に保存しない。`plan_horizon.ends_at` も `evaluation.resolved_at` も既に行に
-- 凍結されているので、導出は 2 つの凍結された値の上で行われる。列を足して
-- track-outcomes に書かせる案もあったが、それは採点器を開ける変更であり、
-- 得られるものは「規則そのものが変わったときに過去が再計算されない」保証だけで
-- ある。既存の 3 軸も同じく導出であり、そちらに合わせる。
--
-- **母集団が上の 3 軸とは違う。** 3 軸は postmortem が done の行しか見ない
-- （facts が要るため）。pace は ends_at と resolved_at だけで出るので、診断が
-- 済んでいない行でも数えられる。`causes` が既に「違う母集団である」と大声で
-- 書いているのと同じ扱いにする — 分母を書かずに並べるのが、この関数が存在する
-- 理由そのものの誤りだからである。
--
-- definition_version は**上げない**。既存 3 軸の定義は 1 文字も変わっておらず、
-- 版をまたいだ比較は 3 軸についてはそのまま有効である。古い版の保存物に pace が
-- 無いのは「そのとき測っていなかった」という正しい意味になる。ここで版を上げると、
-- 「1 つの実験が 2 つとして報告される」というヘッダの警告が、変わっていない 3 軸に
-- 対して発動してしまう。
--
-- 400 行の関数本体は書き写さない。生きた定義を読み、アンカーで 3 箇所だけ
-- 差し替え、**どれか 1 つでも 1 箇所でなければ中断する**（OPERATIONS §6.1 /
-- §8.7-b: 手で写す作業はこのプロジェクトが実際に何度か壊している）。

do $migration$
declare
  def text;
  patched text;

  -- (1) mine に 3 列足す。pace はこの 3 つだけで出る。
  a1 constant text := E'    coalesce(a.plan_contract, \'entry_chosen_v1\') as contract,\n    a.postmortem,';
  b1 constant text := E'    coalesce(a.plan_contract, \'entry_chosen_v1\') as contract,\n'
                   || E'    a.outcome,\n    a.plan_horizon,\n    a.evaluation,\n    a.postmortem,';

  -- (2) pace の CTE を shaped の直前に差し込む。lesson_agg と同じ形
  --     （別母集団 → tagged → agg → shaped で join）にそろえてある。
  a2 constant text := E'\nshaped as (\n';
  b2 constant text := E'\n'
    || E'-- (d) PACE。宣言した期間の内に決着したか。**勝敗ではない。**\n'
    || E'--\n'
    || E'-- 母集団が上の 3 軸と違う: あちらは postmortem が done の行だけ（facts が\n'
    || E'-- 要る）。こちらは ends_at と resolved_at だけで出るので、診断待ちの行も\n'
    || E'-- 数えられる。だから n は別に持ち、混ぜない。\n'
    || E'--\n'
    || E'-- ends_at の cast は形を見てから行う。サーバは必ず ISO で書くが、1 行でも\n'
    || E'-- 壊れた文字列があると cast 例外で関数ごと落ち、3 軸まで道連れになる。\n'
    || E'pace_rows as (\n'
    || E'  select\n'
    || E'    m.contract,\n'
    || E'    m.outcome,\n'
    || E'    case when m.plan_horizon->>''ends_at'' ~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}T''\n'
    || E'      then (m.plan_horizon->>''ends_at'')::timestamptz end as ends_at,\n'
    || E'    case when m.evaluation->>''resolved_at'' ~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}T''\n'
    || E'      then (m.evaluation->>''resolved_at'')::timestamptz end as resolved_at\n'
    || E'  from mine m\n'
    || E'  where m.signal in (''BUY'', ''SELL'')\n'
    || E'),\n'
    || E'pace_tagged as (\n'
    || E'  select p.*, ''scope''::text as dim, ''all_time''::text as key\n'
    || E'  from pace_rows p where p.contract = live_contract\n'
    || E'  union all\n'
    || E'  select p.*, ''by_contract''::text as dim, p.contract as key\n'
    || E'  from pace_rows p\n'
    || E'),\n'
    || E'pace_agg as (\n'
    || E'  select\n'
    || E'    pt.dim, pt.key,\n'
    || E'    -- 分母は「決着して、期間を宣言していた」取引だけ。\n'
    || E'    count(*) filter (where pt.outcome in (''win'', ''loss'')\n'
    || E'      and pt.ends_at is not null and pt.resolved_at is not null)::int as n,\n'
    || E'    count(*) filter (where pt.outcome in (''win'', ''loss'')\n'
    || E'      and pt.ends_at is not null and pt.resolved_at is not null\n'
    || E'      and pt.resolved_at <= pt.ends_at)::int as inside,\n'
    || E'    count(*) filter (where pt.outcome in (''win'', ''loss'')\n'
    || E'      and pt.ends_at is not null and pt.resolved_at is not null\n'
    || E'      and pt.resolved_at > pt.ends_at)::int as outside,\n'
    || E'    -- 落ちた行は落としたと書く（この関数の作法）。\n'
    || E'    -- 期間を宣言していない決着済み取引。step 1 より前の行は全部ここ。\n'
    || E'    count(*) filter (where pt.outcome in (''win'', ''loss'')\n'
    || E'      and pt.ends_at is null)::int as no_horizon,\n'
    || E'    -- まだ開いていて、期間はもう過ぎている。**期限ではない**ので異常では\n'
    || E'    -- ないが、宣言と現実が離れている行ではある。\n'
    || E'    count(*) filter (where pt.outcome = ''pending''\n'
    || E'      and pt.ends_at is not null and pt.ends_at < now())::int as open_past_horizon,\n'
    || E'    count(*) filter (where pt.outcome = ''untriggered'')::int as untriggered,\n'
    || E'    count(*) filter (where pt.outcome = ''expired'')::int as expired\n'
    || E'  from pace_tagged pt\n'
    || E'  group by pt.dim, pt.key\n'
    || E'),\n'
    || E'shaped as (\n';

  -- (3) shaped の value に pace を足す。
  a3 constant text := E'      ''causes'', coalesce(\n'
    || E'        (select la.value from lesson_agg la where la.dim = a.dim and la.key = a.key),\n'
    || E'        jsonb_build_object(''total'', 0, ''waits'', 0, ''direction'', 0, ''timing'', 0, ''placement'', 0,\n'
    || E'                           ''neither'', 0, ''by_cause'', ''{}''::jsonb))\n'
    || E'    ) as value';
  b3 constant text := E'      ''causes'', coalesce(\n'
    || E'        (select la.value from lesson_agg la where la.dim = a.dim and la.key = a.key),\n'
    || E'        jsonb_build_object(''total'', 0, ''waits'', 0, ''direction'', 0, ''timing'', 0, ''placement'', 0,\n'
    || E'                           ''neither'', 0, ''by_cause'', ''{}''::jsonb)),\n'
    || E'      -- (d) PACE。宣言した期間の内に決着したか。\n'
    || E'      --\n'
    || E'      -- `descriptive` が立っているのは「**どちらが良いとも言っていない**」と\n'
    || E'      -- いう意味である。伸びた勝ちは期間外に決着する。実測で、決着 53 件を\n'
    || E'      -- 24 本で打ち切ると落ちる 2 件はどちらも勝ちだった。画面はこの数字を\n'
    || E'      -- 良い／悪いの色で塗ってはならない。\n'
    || E'      ''pace'', coalesce(\n'
    || E'        (select jsonb_build_object(\n'
    || E'          ''n'', pa.n,\n'
    || E'          ''inside'', pa.inside,\n'
    || E'          ''outside'', pa.outside,\n'
    || E'          ''rate'', case when pa.n > 0 then round(pa.inside::numeric * 100 / pa.n)::int end,\n'
    || E'          ''ci95'', case when pa.n > 0 then public.wilson95(pa.inside, pa.n) end,\n'
    || E'          ''no_horizon'', pa.no_horizon,\n'
    || E'          ''open_past_horizon'', pa.open_past_horizon,\n'
    || E'          ''untriggered'', pa.untriggered,\n'
    || E'          ''expired'', pa.expired,\n'
    || E'          ''below_min_n'', pa.n < 20,\n'
    || E'          ''descriptive'', true)\n'
    || E'         from pace_agg pa where pa.dim = a.dim and pa.key = a.key),\n'
    || E'        jsonb_build_object(''n'', 0, ''inside'', 0, ''outside'', 0, ''rate'', null, ''ci95'', null,\n'
    || E'                           ''no_horizon'', 0, ''open_past_horizon'', 0, ''untriggered'', 0,\n'
    || E'                           ''expired'', 0, ''below_min_n'', true, ''descriptive'', true))\n'
    || E'    ) as value';

  procedure_name constant text := 'separated_scores';
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = procedure_name;

  if def is null then
    raise exception '% not found — refusing to guess at its definition', procedure_name;
  end if;

  -- 既に当たっているなら何もしない（再適用しても壊れない）。
  if position('pace_agg' in def) > 0 then
    raise notice 'separated_scores already has the pace axis; nothing to do';
    return;
  end if;

  -- 3 つのアンカーが**それぞれちょうど 1 箇所**であること。
  if (length(def) - length(replace(def, a1, ''))) / length(a1) <> 1 then
    raise exception 'anchor 1 (mine columns) is not unique in %', procedure_name;
  end if;
  if (length(def) - length(replace(def, a2, ''))) / length(a2) <> 1 then
    raise exception 'anchor 2 (shaped CTE) is not unique in %', procedure_name;
  end if;
  if (length(def) - length(replace(def, a3, ''))) / length(a3) <> 1 then
    raise exception 'anchor 3 (causes key) is not unique in %', procedure_name;
  end if;

  patched := replace(replace(replace(def, a1, b1), a2, b2), a3, b3);

  -- 置換が本当に 3 つとも起きたか。アンカーが在ることと、置換後の文字列が
  -- 入っていることは別の主張である（53dca87 はそこを取り違えて偽を書いた）。
  if position('a.plan_horizon,' in patched) = 0
     or position('pace_agg as (' in patched) = 0
     or position('''pace'', coalesce(' in patched) = 0 then
    raise exception 'one of the three replacements did not land in %', procedure_name;
  end if;

  execute patched;
end
$migration$;

comment on function public.separated_scores(text) is
  '方向・タイミング・水準の 3 軸に加え、#91 step 2 で pace（宣言した期間の内に決着したか）を足した。'
  'pace は **勝敗ではなく、どちらが良いとも言っていない**（descriptive = true）: 伸びた勝ちは期間外に決着する。'
  'pace の母集団は上の 3 軸と違う — 3 軸は postmortem が done の行だけ、pace は ends_at と resolved_at だけで出る。'
  'definition_version は上げていない: 既存 3 軸の定義は変わっておらず、版をまたいだ比較はそのまま有効である。';
