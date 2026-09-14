-- すでに持っている建玉を登録できるようにする（#92）。
--
-- 今までの登録は「このプランで入った」の 1 本道しか無かった。register_position は
-- ユーザーから約定価格と約定時刻だけを受け取り、**損切りと利確はプランの行から
-- そのまま写す**（20260913080000 の insert を見れば分かる）。だから、プランが
-- 書かれる前に建てた玉を登録しようとすると opened_before_plan で断られる。
--
-- これは正しい拒否である。断らずに通すと、行が 3 か所で嘘をつく:
--   1. 置いていない損切りが、その人の損切りとして記録される
--   2. 保有中レビューの move_R は |約定価格 − 損切り| をリスクとして割るので、
--      取っていないリスクで含み損益が R 換算される
--   3. レビューは opened_at を起点に「建ててから損切りに触ったか」を測る。
--      プランより前を起点にすると、**プランが書かれる前の値動き**を、この
--      プランについての証拠として読むことになる
--
-- 足りないのはチェックの緩和ではなく、**プランに紐づかない建玉**という概念である。
-- ここで足すのはそれだけ: analysis_id を nullable にし、ユーザー自身の水準を
-- 受け取る 2 本目の RPC を置く。register_position は 1 文字も触らない。
--
-- analysis_id IS NULL が「アプリのプランから入ったのではない」の印そのものである。
-- origin のような列は足さない。analyses への FK は on delete cascade なので、
-- 「プランが消えて null になった」行は存在し得ない（行ごと消える）。つまり
-- null の意味は 1 つしか無く、2 つ目の列を置くと同じ事実の出どころが 2 つになる。
--
-- 成績統計には入らない。本番で実測: performance_stats / variant_stats /
-- loop_health の定義本文に 'positions' は 1 度も出てこない。アプリが出した
-- コールではない建玉が勝率に混ざる経路は、そもそも存在しない。

-- ---------------------------------------------------------------------------
-- 1. 列
-- ---------------------------------------------------------------------------

alter table public.positions
  alter column analysis_id drop not null;

comment on column public.positions.analysis_id is
  '入ったプランの行。NULL = アプリのプランから入ったのではない建玉（#92）。'
  '元のプランはこの行を指すだけで、二度と書き換えない。FK は on delete cascade なので、'
  '「プランが消えたせいで NULL になった行」は存在しない（行ごと消える）。'
  'したがって NULL の意味は「最初からプランが無い」の 1 つだけである。';

-- interval は NOT NULL のまま残す。プラン由来の値だが、独立した建玉でも
-- 「どの時間足で見直すか」は利用者が選ぶ実在の選択で、レビューはこの値で
-- 足を取りに行く。NULL を許すと、そこから先が全部「時間足が無いときの分岐」に
-- なる。列を 1 つ増やすより、選ばせるほうが嘘が少ない。

-- ---------------------------------------------------------------------------
-- 2. 重複の防ぎ方
-- ---------------------------------------------------------------------------
--
-- 既存の positions_one_open_per_analysis は (analysis_id) where status='open'。
-- Postgres の UNIQUE は NULL どうしを別物として扱うので、**この索引は独立した
-- 建玉を 1 つも止めない**。それは意図どおりである: 同じ通貨ペアに別々の建玉を
-- 複数持つことは普通にあり、レビュー側も「ペアごとに最新の open を評価し、
-- 残りは数える」という作りになっている（others / other_open_positions）。
--
-- 止めたいのは「登録ボタンの二度押し」だけなので、そこだけを止める。
-- 同じ人・同じペア・同じ方向・同じ約定価格・同じ約定時刻の open は 1 つ。
create unique index if not exists positions_one_open_standalone
  on public.positions (user_id, pair, direction, entry_price, opened_at)
  where status = 'open' and analysis_id is null;

-- ---------------------------------------------------------------------------
-- 3. 登録 RPC
-- ---------------------------------------------------------------------------
--
-- register_position とは別関数にする。同じ関数に分岐を足すと、「プランの水準を
-- 写す」経路と「利用者の水準を受け取る」経路が 1 つの本体の中で混ざり、
-- どちらの水準が入ったのかが後から読めなくなる。それはこの表が
-- opened_at_source / closed_at_source を足したときと同じ理由である。
create or replace function public.register_held_position(
  p_pair text,
  p_interval text,
  p_direction text,
  p_entry_price numeric,
  p_stop_loss numeric,
  p_take_profit_1 numeric,
  p_take_profit_2 numeric default null,
  p_take_profit_3 numeric default null,
  p_opened_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_opened_at timestamptz;
  v_source text;
  v_row public.positions;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '28000';
  end if;

  if p_pair is null or p_pair !~ '^[A-Z]{3}/[A-Z]{3}$' then
    raise exception 'pair_invalid' using errcode = '22023';
  end if;
  -- レビューがこの値で足を取りに行くので、取りに行ける 4 つに限る。
  if p_interval is null or p_interval not in ('15min', '1h', '4h', '1day') then
    raise exception 'interval_invalid' using errcode = '22023';
  end if;
  if p_direction is null or p_direction not in ('BUY', 'SELL') then
    raise exception 'direction_invalid' using errcode = '22023';
  end if;
  if p_entry_price is null or p_entry_price <= 0 then
    raise exception 'entry_price_must_be_positive' using errcode = '22023';
  end if;
  -- 損切りと利確を必須にするのは、表を作ったときと同じ理由である:
  -- これが無いと含み R も損切り接触も計算できず、「保有中の判断」が
  -- 何も言えない。持っている玉に損切りが無いなら、R は出せない。
  if p_stop_loss is null or p_stop_loss <= 0 then
    raise exception 'stop_loss_must_be_positive' using errcode = '22023';
  end if;
  if p_take_profit_1 is null or p_take_profit_1 <= 0 then
    raise exception 'take_profit_1_must_be_positive' using errcode = '22023';
  end if;

  -- 水準の向き。プラン経由の fill_outside_plan と同じ不等式を、
  -- 利用者自身の水準に当てる。
  if p_direction = 'BUY' and not (p_stop_loss < p_entry_price and p_entry_price < p_take_profit_1) then
    raise exception 'levels_incoherent' using errcode = '22023';
  end if;
  if p_direction = 'SELL' and not (p_take_profit_1 < p_entry_price and p_entry_price < p_stop_loss) then
    raise exception 'levels_incoherent' using errcode = '22023';
  end if;

  -- TP2 / TP3 は任意だが、入れるなら順番が合っていること。順序が壊れた利確は
  -- レビューの「どこまで伸びたか」を無意味にする。
  if p_direction = 'BUY' then
    if p_take_profit_2 is not null and p_take_profit_2 <= p_take_profit_1 then
      raise exception 'targets_out_of_order' using errcode = '22023';
    end if;
    if p_take_profit_3 is not null and p_take_profit_3 <= coalesce(p_take_profit_2, p_take_profit_1) then
      raise exception 'targets_out_of_order' using errcode = '22023';
    end if;
  else
    if p_take_profit_2 is not null and p_take_profit_2 >= p_take_profit_1 then
      raise exception 'targets_out_of_order' using errcode = '22023';
    end if;
    if p_take_profit_3 is not null and p_take_profit_3 >= coalesce(p_take_profit_2, p_take_profit_1) then
      raise exception 'targets_out_of_order' using errcode = '22023';
    end if;
  end if;
  -- TP2 を飛ばして TP3 だけ、は受けない。上の coalesce で通ってしまうため、
  -- ここで明示的に断る（プラン側も TP は 1→2→3 の順に埋まる）。
  if p_take_profit_3 is not null and p_take_profit_2 is null then
    raise exception 'targets_out_of_order' using errcode = '22023';
  end if;

  if p_opened_at is null then
    v_opened_at := now();
    v_source := 'registered';
  else
    -- **下限は置かない。** プラン経由と違って比べる相手（プランの作成時刻）が
    -- 無く、「何日前までなら本当か」を決める根拠がこちらには無い。古すぎる
    -- 約定はレビューが covers_anchor = false として正直に報告する。
    -- 未来だけは、定義上あり得ないので断る。5 分はクライアントの時計のずれ。
    if p_opened_at > now() + interval '5 minutes' then
      raise exception 'opened_in_future' using errcode = '22023';
    end if;
    v_opened_at := p_opened_at;
    v_source := 'user';
  end if;

  insert into public.positions (
    user_id, analysis_id, pair, interval, direction, entry_price,
    stop_loss, take_profit_1, take_profit_2, take_profit_3,
    opened_at, opened_at_source, registered_after_settlement
  ) values (
    v_uid, null, p_pair, p_interval, p_direction, p_entry_price,
    p_stop_loss, p_take_profit_1, p_take_profit_2, p_take_profit_3,
    -- 決着していたプランが無いので false。これは既定値ではなく、
    -- 「判定側の loss を撤退条件に格上げしない」判断が要らないという意味である。
    v_opened_at, v_source, false
  )
  on conflict (user_id, pair, direction, entry_price, opened_at)
    where status = 'open' and analysis_id is null
  do nothing
  returning * into v_row;

  if v_row.id is null then
    -- 二度押し。既にある同一の open を返す（already_open = true）。
    select * into v_row from public.positions
     where user_id = v_uid and pair = p_pair and direction = p_direction
       and entry_price = p_entry_price and opened_at = v_opened_at
       and status = 'open' and analysis_id is null;
    if not found then
      raise exception 'position_not_open' using errcode = 'P0002';
    end if;
    return jsonb_build_object('position', to_jsonb(v_row), 'already_open', true);
  end if;

  return jsonb_build_object('position', to_jsonb(v_row), 'already_open', false);
end;
$$;

revoke all on function public.register_held_position(
  text, text, text, numeric, numeric, numeric, numeric, numeric, timestamptz
) from public, anon;
grant execute on function public.register_held_position(
  text, text, text, numeric, numeric, numeric, numeric, numeric, timestamptz
) to authenticated;

comment on function public.register_held_position is
  'すでに持っている建玉を、アプリのプランに紐づけずに登録する（#92）。analysis_id は NULL。'
  '損切り・利確は**利用者自身のもの**を受け取る（register_position はプランから写す。そこが違う）。'
  '約定時刻の下限は置かない — 比べる相手が無く、何日前までが本当かを決める根拠がこちらに無いため。'
  '古すぎる約定はレビューが covers_anchor = false として報告する。未来だけを断る。'
  'この建玉は成績統計に入らない（performance_stats / variant_stats / loop_health は positions を読まない）。';
