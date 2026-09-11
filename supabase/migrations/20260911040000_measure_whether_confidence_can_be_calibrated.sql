-- #68 — 確信度を実績で補正する、の前に置く計器。
--
-- 課題の題は「確信度を実績で補正する（十分な記録が溜まってから適用）」だが、
-- 適用の前に確かめることが一つある。補正とは「モデルが80と言ったとき実際は
-- 55%しか勝たない」という写像を当てることで、そのためには **モデルの言う数字が
-- 動いている** 必要がある。動いていなければ補正は効かないのではなく、定義できない。
--
-- 2026-09-11 の本番実測（market_v1、shadow/preview 除外、80行）:
--
--   約定したプラン 38件の確信度: 62, 63, 64, 66, 68, 70 の6値のみ。幅は8。
--   WAIT 42件の確信度: 42〜63。うち41件は entry_check.rejection = 'low_confidence'
--   （確信度フロア60による強制WAIT）で、価格についての判断ですらない。
--   決着した37件の勝率は 21/37。
--
-- つまり 0〜100 のうち実際に使われているのは 42〜70 で、約定側に限れば 62〜70。
-- performance_stats の by_confidence は 0-59 / 60-69 / 70-79 / 80+ の4段なので、
-- 約定側は事実上1段に全部入り、この偏りが見えない。段を細かくするのがこの関数の
-- 一つ目の仕事である。
--
-- 二つ目は識別力。較正（calibration, 数字の水準が合っているか）と識別
-- （discrimination, 数字が勝ち負けを並べ替えられるか）は別物で、後者が無ければ
-- 前者を直しても意味がない。ここでは勝ちと負けの全ペアを取り、勝ったほうの確信度が
-- 高かった割合を出す（Mann-Whitney の U を正規化したもの＝AUC）。0.5 が「並べ替え
-- られていない」。
--
-- 三つ目は門。いつになったら補正を当ててよいかを、当てる前に書いておく。
--
--   この門は実測を見た **あとに** 書いている。事前登録ではない。
--   docs/NOISE_FLOOR_PREREGISTRATION.md のような事前登録と同列に扱ってはならない。
--   数字を見てから閾値を決めると、その閾値は都合よく置ける。ここでできる最善は
--   「見てから決めた」と明記して、閾値そのものは既存の慣習（MIN_N=20、
--   performance_stats の below_min_n と同じ）から引くことだけである。
--
-- この関数は補正を **適用しない**。適用してよいかどうかだけを返す。
--
-- SECURITY INVOKER。performance_stats / separated_scores と同じ理由で、
-- public.analyses の RLS がこの関数を呼び出し元1アカウントに絞る唯一の仕組みであり、
-- 本文に user_id = auth.uid() は意図的に書かない。DEFINER にすると2アカウント分が
-- 1人の成績として出る。

create or replace function public.confidence_calibration(live_contract text default 'market_v1')
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $function$
with mine as (
  -- performance_stats の mine と同じ除外。母集団が違えば、同じ画面に並んだ二つの
  -- 数字が別の集団を指すことになる。
  select a.signal, a.confidence, a.outcome
  from public.analyses a
  where a.shadow = false
    and a.preview = false
    and coalesce(a.plan_contract, 'entry_chosen_v1') = live_contract
    and a.confidence is not null
),
traded as (
  select confidence, outcome from mine where signal in ('BUY', 'SELL')
),
waited as (
  select confidence from mine where signal = 'WAIT'
),
settled as (
  -- 勝ちと負けだけ。expired / pending / skipped は「その確信度が当たったか」の
  -- 証拠にならないので、母数にも分子にも入れない。
  select confidence, (outcome = 'win') as won
  from traded
  where outcome in ('win', 'loss')
),
span_all as (
  select count(*)::int as n, min(confidence)::int as lo, max(confidence)::int as hi,
         count(distinct confidence)::int as distinct_values
  from mine
),
span_traded as (
  select count(*)::int as n, min(confidence)::int as lo, max(confidence)::int as hi,
         count(distinct confidence)::int as distinct_values
  from traded
),
span_wait as (
  select count(*)::int as n, min(confidence)::int as lo, max(confidence)::int as hi,
         count(distinct confidence)::int as distinct_values
  from waited
),
by_value as (
  -- 粗い帯ではなく、実際に出た値そのもの。ここが偏りの見えるところ。
  select confidence::int as confidence,
         count(*)::int as settled,
         count(*) filter (where won)::int as wins,
         count(*) filter (where not won)::int as losses
  from settled
  group by confidence
),
by_band as (
  -- 5刻み。門はこちらで判定する。値そのものだと n=1 の段が並んで門が甘くなる。
  select ((confidence / 5) * 5)::int as band_lo,
         count(*)::int as settled,
         count(*) filter (where won)::int as wins,
         count(*) filter (where not won)::int as losses
  from settled
  group by 1
),
pair_counts as (
  -- 勝ち×負けの全ペア。n が小さいので総当たりで足りる。
  select
    count(*)::int as total_pairs,
    count(*) filter (where w.confidence > l.confidence)::int as concordant,
    count(*) filter (where w.confidence = l.confidence)::int as ties,
    count(*) filter (where w.confidence < l.confidence)::int as discordant
  from settled w
  cross join settled l
  where w.won and not l.won
),
auc_raw as (
  select
    p.total_pairs, p.concordant, p.ties, p.discordant,
    (select count(*) from settled where won)::int as n_win,
    (select count(*) from settled where not won)::int as n_loss,
    case
      when p.total_pairs = 0 then null
      else ((p.concordant + p.ties::numeric / 2) / p.total_pairs)
    end as a
  from pair_counts p
),
auc_ci as (
  -- Hanley-McNeil の標準誤差。正規近似なので n が小さいと信用できない。
  -- ここでは n_win=21 / n_loss=16 のような規模で使うことになるので、
  -- 返す側で approximate: true を立てて、読む側が鵜呑みにしないようにする。
  select
    r.*,
    case
      when r.a is null or r.n_win = 0 or r.n_loss = 0 then null
      else sqrt(
        greatest(
          0,
          (
            r.a * (1 - r.a)
            + (r.n_win - 1) * ((r.a / (2 - r.a)) - r.a * r.a)
            + (r.n_loss - 1) * ((2 * r.a * r.a / (1 + r.a)) - r.a * r.a)
          ) / (r.n_win::numeric * r.n_loss)
        )
      )
    end as se
  from auc_raw r
),
-- 門。MIN_N=20 は performance_stats の below_min_n と同じ床。
-- 「5刻みの段が3つ以上、どれも20件以上決着している」を満たすまで補正は当てない。
-- 3段は、較正曲線が直線かどうかを言うのに必要な最小の点の数である。
gate as (
  select
    20::int as min_n_per_band,
    3::int as need_bands,
    (select count(*) from by_band where settled >= 20)::int as have_bands,
    (select coalesce(sum(settled), 0) from by_band)::int as have_settled,
    60::int as need_settled
)
select jsonb_build_object(
  'contract', live_contract,
  'span', jsonb_build_object(
    'all', (select jsonb_build_object('n', n, 'lo', lo, 'hi', hi, 'distinct_values', distinct_values,
                                      'width', case when n = 0 then null else hi - lo end) from span_all),
    'traded', (select jsonb_build_object('n', n, 'lo', lo, 'hi', hi, 'distinct_values', distinct_values,
                                         'width', case when n = 0 then null else hi - lo end) from span_traded),
    'wait', (select jsonb_build_object('n', n, 'lo', lo, 'hi', hi, 'distinct_values', distinct_values,
                                       'width', case when n = 0 then null else hi - lo end) from span_wait)
  ),
  'by_value', coalesce((
    select jsonb_agg(jsonb_build_object(
      'confidence', v.confidence,
      'settled', v.settled,
      'wins', v.wins,
      'losses', v.losses,
      'win_rate', round(100.0 * v.wins / v.settled),
      'ci95', public.wilson95(v.wins, v.settled)
    ) order by v.confidence)
    from by_value v
  ), '[]'::jsonb),
  'by_band', coalesce((
    select jsonb_agg(jsonb_build_object(
      'band_lo', b.band_lo,
      'band_hi', b.band_lo + 4,
      'settled', b.settled,
      'wins', b.wins,
      'losses', b.losses,
      'win_rate', round(100.0 * b.wins / b.settled),
      'ci95', public.wilson95(b.wins, b.settled),
      'below_min_n', b.settled < 20
    ) order by b.band_lo)
    from by_band b
  ), '[]'::jsonb),
  'discrimination', (
    select jsonb_build_object(
      'n_win', c.n_win,
      'n_loss', c.n_loss,
      'total_pairs', c.total_pairs,
      'concordant', c.concordant,
      'ties', c.ties,
      'discordant', c.discordant,
      -- 0.5 = 並べ替えられていない。1.0 = 勝ちが必ず高い確信度。
      'auc', case when c.a is null then null else round(c.a, 3) end,
      'ci95', case
        when c.a is null or c.se is null then null
        else jsonb_build_array(round(greatest(0, c.a - 1.96 * c.se), 3),
                               round(least(1, c.a + 1.96 * c.se), 3))
      end,
      -- 正規近似であること、同点が多いと特に粗いことを、数字と一緒に運ぶ。
      'ci95_approximate', true,
      'tie_share', case when c.total_pairs = 0 then null
                        else round(100.0 * c.ties / c.total_pairs) end
    )
    from auc_ci c
  ),
  'gate', (
    select jsonb_build_object(
      'applies', false,
      'min_n_per_band', g.min_n_per_band,
      'need_bands', g.need_bands,
      'have_bands', g.have_bands,
      'need_settled', g.need_settled,
      'have_settled', g.have_settled,
      'met', (g.have_bands >= g.need_bands and g.have_settled >= g.need_settled),
      -- 見てから決めた閾値である、を数字と同じ場所に置く。
      'preregistered', false
    )
    from gate g
  )
);
$function$;

comment on function public.confidence_calibration(text) is
  '#68 の計器。確信度が実際に取る範囲、値ごと・5刻みごとの勝率と信頼区間、'
  '識別力（勝ち×負け全ペアでのAUC）、および補正を当ててよい条件を返す。'
  '補正は適用しない。SECURITY INVOKER、RLS で呼び出し元1アカウントに絞られる。';

revoke all on function public.confidence_calibration(text) from public;
revoke all on function public.confidence_calibration(text) from anon;
grant execute on function public.confidence_calibration(text) to authenticated;
