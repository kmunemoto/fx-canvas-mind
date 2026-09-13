-- 登録・決済の時刻について、行が言っていることを実際に測ったことに合わせる（#89 の続き）。
--
-- 20260912150000 を適用したあとのレビューで 2 つ出た。どちらも「保存した数値が、
-- それが何を測ったものかを言っていない」という同じ形である。
--
-- 1. 約定時刻の下限がプランの行の作成時刻（マイクロ秒）と比べられていた。
--    画面の入力は datetime-local で分までしか作れないので、17:04:48 に書かれた
--    プランを 17:04:55 に約定して「17:04」と入力すると 17:04:00 < 17:04:48 で
--    opened_before_plan。プランより後の約定を「プランより前」と断って拒む。
--    下限をプランが書かれた「分」にする。クライアントが表現できる精度と同じにする
--    のであって、検査を緩めるのではない（17:03 は今までどおり拒む）。
--
-- 2. closed_at が必ず「決済ボタンを押した瞬間のサーバー時刻」だった。
--    深夜に損切りされて朝に記録した人の行は、朝の時刻の隣に朝には存在しなかった
--    価格が並ぶ。opened_at には opened_at_source を付けて「約定時刻」と
--    「登録時刻」を分けたのに、決済側には何も無かった——1 列に 2 つの意味を
--    持たせると後から見分けられない、というのがその列を足した理由そのものである。
--    §2.3 は「建玉に決済価格と時刻。途中の継続／撤退判断の損益を後から採点できる」
--    と書いているので、採点はこの時刻を使う。言っていない時刻では採点できない。

-- ---------------------------------------------------------------------------
-- 1. 決済時刻の出どころを行に書く
-- ---------------------------------------------------------------------------

alter table public.positions
  add column if not exists closed_at_source text
    check (closed_at_source in ('user', 'registered'));

comment on column public.positions.closed_at_source is
  'user = ユーザーが決済時刻を入力した / registered = 入力が無く、記録した瞬間のサーバー時刻を使った。'
  'NULL は「記録が無い」——この列より前に閉じた行と、開いている行。';
comment on column public.positions.closed_at is
  '決済時刻。closed_at_source = registered なら記録した瞬間のサーバー時刻であって、'
  'ユーザーの決済時刻ではない。source を見ずにこの列だけで損益を採点してはならない。';

-- この列より前に閉じた行は、すべて now() で押された。これは推測ではなく、
-- 当時のコードがそれしか書けなかったという事実である。
update public.positions
   set closed_at_source = 'registered'
 where status = 'closed' and closed_at is not null and closed_at_source is null;

-- ---------------------------------------------------------------------------
-- 2. 登録：下限をプランが書かれた「分」にする
-- ---------------------------------------------------------------------------
--
-- 本文は 20260912150000 と一字一句同じで、比較 1 行だけが違う。
create or replace function public.register_position(
  p_analysis_id uuid,
  p_entry_price numeric,
  p_opened_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_a public.analyses%rowtype;
  v_opened_at timestamptz;
  v_source text;
  v_row public.positions%rowtype;
  v_already boolean := false;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if p_entry_price is null or p_entry_price <= 0 then
    raise exception 'entry_price_must_be_positive' using errcode = '22023';
  end if;

  select * into v_a from public.analyses
   where id = p_analysis_id and user_id = v_uid;
  if not found then
    raise exception 'analysis_not_found' using errcode = 'P0002';
  end if;
  if v_a.signal not in ('BUY', 'SELL') then
    raise exception 'plan_is_not_a_trade' using errcode = '22023';
  end if;
  if v_a.preview then
    raise exception 'plan_is_a_preview' using errcode = '22023';
  end if;
  if v_a.shadow then
    raise exception 'plan_is_a_shadow' using errcode = '22023';
  end if;
  if v_a.stop_loss is null or v_a.take_profit_1 is null then
    raise exception 'plan_has_no_levels' using errcode = '22023';
  end if;
  if v_a.signal = 'BUY' and not (v_a.stop_loss < p_entry_price and p_entry_price < v_a.take_profit_1) then
    raise exception 'fill_outside_plan' using errcode = '22023';
  end if;
  if v_a.signal = 'SELL' and not (v_a.take_profit_1 < p_entry_price and p_entry_price < v_a.stop_loss) then
    raise exception 'fill_outside_plan' using errcode = '22023';
  end if;

  if p_opened_at is null then
    v_opened_at := now();
    v_source := 'registered';
  else
    -- プランが書かれた「分」が下限。入力欄が分までしか作れないので、秒を持つ
    -- created_at とそのまま比べると、同じ分の約定が「プランより前」になる。
    if p_opened_at < date_trunc('minute', v_a.created_at) then
      raise exception 'opened_before_plan' using errcode = '22023';
    end if;
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
    v_uid, v_a.id, v_a.pair, v_a.interval, v_a.signal, p_entry_price,
    v_a.stop_loss, v_a.take_profit_1, v_a.take_profit_2, v_a.take_profit_3,
    v_opened_at, v_source, v_a.outcome <> 'pending'
  )
  on conflict (analysis_id) where status = 'open' do nothing
  returning * into v_row;

  if v_row.id is null then
    v_already := true;
    select * into v_row from public.positions
     where analysis_id = v_a.id and status = 'open' and user_id = v_uid;
    if not found then
      raise exception 'position_not_open' using errcode = 'P0002';
    end if;
  end if;

  return jsonb_build_object('position', to_jsonb(v_row), 'already_open', v_already);
end;
$$;

revoke all on function public.register_position(uuid, numeric, timestamptz) from public, anon;
grant execute on function public.register_position(uuid, numeric, timestamptz) to authenticated;

comment on function public.register_position(uuid, numeric, timestamptz) is
  '自分の公開済み BUY/SELL プランに建玉を登録する。既に開いていれば既存の行を返す（already_open）。'
  'opened_at 省略時はサーバー時刻を記録し opened_at_source = registered。'
  '入力された約定時刻の下限はプランが書かれた「分」（画面が分までしか作れないため）。';

-- ---------------------------------------------------------------------------
-- 3. 決済：時刻を受け取れるようにし、出どころを書く
-- ---------------------------------------------------------------------------
--
-- 3 引数版は必ず落とす。残すと PostgREST が 3 つの名前付き引数の呼び出しを
-- 両方に一致させられてしまい、古い本文（必ず now() を書く）が走り続ける。
drop function if exists public.close_position(uuid, numeric, text);

create or replace function public.close_position(
  p_position_id uuid,
  p_close_price numeric,
  p_reason text default 'manual',
  p_closed_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_opened_at timestamptz;
  v_row public.positions%rowtype;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if p_close_price is null or p_close_price <= 0 then
    raise exception 'close_price_must_be_positive' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('manual', 'stop', 'target', 'other') then
    raise exception 'close_reason_invalid' using errcode = '22023';
  end if;

  if p_closed_at is not null then
    -- 入力された時刻だけ、建玉より後で未来でないことを確かめる。所有と
    -- status は下の UPDATE の WHERE が握っているので、ここで読むのは
    -- 境界を測るための opened_at だけ。
    select opened_at into v_opened_at from public.positions
     where id = p_position_id and user_id = v_uid and status = 'open';
    if not found then
      raise exception 'position_not_open' using errcode = 'P0002';
    end if;
    if p_closed_at < date_trunc('minute', v_opened_at) then
      raise exception 'closed_before_open' using errcode = '22023';
    end if;
    if p_closed_at > now() + interval '5 minutes' then
      raise exception 'closed_in_future' using errcode = '22023';
    end if;
  end if;

  -- 条件付き UPDATE 1 発は変えない。同時に 2 回呼ばれても 2 回目は NOT FOUND に
  -- なり、1 回目の価格と時刻を上書きしない。
  update public.positions
     set status = 'closed',
         closed_at = coalesce(p_closed_at, now()),
         closed_at_source = case when p_closed_at is null then 'registered' else 'user' end,
         close_price = p_close_price,
         close_reason = p_reason
   where id = p_position_id
     and user_id = v_uid
     and status = 'open'
  returning * into v_row;

  if not found then
    raise exception 'position_not_open' using errcode = 'P0002';
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.close_position(uuid, numeric, text, timestamptz) from public, anon;
grant execute on function public.close_position(uuid, numeric, text, timestamptz) to authenticated;

comment on function public.close_position(uuid, numeric, text, timestamptz) is
  '自分の開いている建玉を閉じる。条件付き UPDATE 1 発で、二重決済は 2 回目が失敗する。'
  'closed_at 省略時は記録した瞬間のサーバー時刻を使い closed_at_source = registered。';
