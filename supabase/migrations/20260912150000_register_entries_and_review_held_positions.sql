-- 保有中の判断を新規判断から分ける（#89）。
--
-- 今のアプリの WAIT は「今から新しく入るのは見送り」であって「決済しろ」ではない。
-- だが画面には新規判断しか無いので、売りを持っている人が WAIT を見て
-- 「決済しろという意味？」と迷う。直すには 3 つ要る:
--
--   1. エントリー登録    — ユーザーが「このプランで入った」と言える場所（この表）
--   2. 保有中の判断      — 保有プランをその根拠と水準で評価した結果（analyses.position_review）
--   3. 前回からの変更理由 — 前回の判断と何が変わったか（同じ列の change）
--
-- 設計上の不変条件（docs/OPERATIONS.md §2.3）:
--   - 元のプラン（analyses の行）は書き換えない。建玉は別の表に、評価は新しい行に。
--   - 書き込みは 2 つの SECURITY DEFINER 関数だけ。直接 INSERT/UPDATE は無い。
--     このリポジトリで authenticated が呼べる definer 書き込み関数はこれが最初なので、
--     search_path を空に固定し、auth.uid() が NULL のときは明示的に拒む。
--   - NULL は「記録が無い」。既定値の代わりに NULL を読んではならない。

-- ---------------------------------------------------------------------------
-- 1. 建玉
-- ---------------------------------------------------------------------------

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 入ったプラン。元のプランはこの行を指すだけで、二度と書き換えない。
  analysis_id uuid not null references public.analyses (id) on delete cascade,
  pair text not null,
  interval text not null,
  direction text not null check (direction in ('BUY', 'SELL')),
  -- ユーザー自身の約定価格。既定はプランの entry_point だが、滑った値でよい。
  entry_price numeric not null check (entry_price > 0),
  -- 登録時にプランから写す。NOT NULL なのは、これが無いと含み R も損切り接触も
  -- 計算できず、「保有中の判断」が何も言えなくなるから。水準の無い行（ゲート前の
  -- 検索パスで prose が読めなかった行）は登録を断る。
  stop_loss numeric not null,
  take_profit_1 numeric not null,
  take_profit_2 numeric,
  take_profit_3 numeric,
  opened_at timestamptz not null,
  -- opened_at が「ユーザーが入力した約定時刻」なのか「登録した瞬間のサーバー時刻」
  -- なのかを行に残す。1 列に 2 つの意味を持たせると、後から見分けられない。
  opened_at_source text not null check (opened_at_source in ('user', 'registered')),
  -- 登録した時点で判定システムがプランを決着させていた（win / loss / expired …）。
  -- こういう建玉に対しては判定側の loss を「撤退条件成立」に格上げしない。
  registered_after_settlement boolean not null default false,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_at timestamptz,
  close_price numeric,
  close_reason text check (close_reason in ('manual', 'stop', 'target', 'other')),
  created_at timestamptz not null default now()
);

comment on table public.positions is
  'ユーザーが「このプランで入った」と登録した建玉。元のプラン（analyses）は書き換えず、この表が指すだけ。書き込みは register_position / close_position のみ。';
comment on column public.positions.opened_at_source is
  'user = ユーザーが約定時刻を入力した / registered = 入力が無く、登録した瞬間のサーバー時刻を記録した。';
comment on column public.positions.registered_after_settlement is
  '登録時点で判定システムがこのプランを決着済みにしていた。true の建玉では判定側の loss を撤退条件に使わない（決着が建玉より前かもしれないため）。';

-- 1 プランに開いた建玉は 1 つ。再登録は register_position が既存の行を返す。
create unique index if not exists positions_one_open_per_analysis
  on public.positions (analysis_id) where status = 'open';

-- analyze が「このペアで開いている建玉」を引くための索引
create index if not exists positions_user_pair_open_idx
  on public.positions (user_id, pair, opened_at desc) where status = 'open';

alter table public.positions enable row level security;

drop policy if exists "Users can read own positions" on public.positions;
create policy "Users can read own positions"
  on public.positions for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.positions from public, anon, authenticated;
grant select on public.positions to authenticated;
grant all on public.positions to service_role;

-- ---------------------------------------------------------------------------
-- 2. 登録
-- ---------------------------------------------------------------------------
--
-- 検査するもの: 呼び出し元が自分のプランを指しているか、それが BUY/SELL の公開済み
-- プランか（下見・shadow・WAIT は不可）、損切りと TP1 が有るか、約定価格が損切りと
-- TP1 の間にあるか（既に損切りの向こうにある約定は「保有プラン」として評価できない）、
-- 約定時刻がプランより前でなく、未来でもないか。
--
-- p_opened_at が NULL のときはサーバーの now() を記録し、その旨を行に書く。
-- ブラウザの時計を既定値に使うと、進んだ時計は上限で、遅れた時計は下限で弾かれる。
--
-- 二重登録は例外ではなく既存の行を返す（already_open = true）。ネットワークの
-- 再送で 2 回届いた登録が、1 回目は成功して 2 回目がエラー、では困る。
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
    if p_opened_at < v_a.created_at then
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
  '自分の公開済み BUY/SELL プランに建玉を登録する。既に開いていれば既存の行を返す（already_open）。opened_at 省略時はサーバー時刻を記録し opened_at_source = registered。';

-- ---------------------------------------------------------------------------
-- 3. 決済
-- ---------------------------------------------------------------------------
--
-- 条件付き UPDATE 1 発。所有と status = 'open' を WHERE に置くので、同時に 2 回
-- 呼ばれても 2 回目は NOT FOUND になり、1 回目の価格と時刻を上書きしない。
-- 「閉じている」と「他人のもの」は同じ文言で断る（他人の id の存在を漏らさない）。
create or replace function public.close_position(
  p_position_id uuid,
  p_close_price numeric,
  p_reason text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
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

  update public.positions
     set status = 'closed',
         closed_at = now(),
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

revoke all on function public.close_position(uuid, numeric, text) from public, anon;
grant execute on function public.close_position(uuid, numeric, text) to authenticated;

comment on function public.close_position(uuid, numeric, text) is
  '自分の開いている建玉を閉じる。条件付き UPDATE 1 発で、二重決済は 2 回目が失敗する。';

-- ---------------------------------------------------------------------------
-- 4. 保有中の判断は新しい行に書く
-- ---------------------------------------------------------------------------
--
-- analyze が今回の分析行に書く。元のプランの行には触らない。
-- NULL = 「この行が書かれたとき、この列は無かった」。列より後の行では、
-- 参照が無ければ status = skipped の JSON が入る（NULL ではない）。
alter table public.analyses add column if not exists position_review jsonb;

comment on column public.analyses.position_review is
  '保有中プラン（または前回の判断）をその根拠と水準で評価した結果。'
  'reference（held / previous）・mechanical（サーバー計算の事実、基準の板つき）・'
  'analyst（モデルの答えそのまま）・verdict（サーバーが導いた判定）・change（前回との差）。'
  'NULL は列より前の行。参照が無い回は status = skipped が入る。';

-- ---------------------------------------------------------------------------
-- 5. 評価に送ったプロンプトも残す（analysis_prompts と同じ理由・同じ扱い）
-- ---------------------------------------------------------------------------
--
-- 評価の回答が再生できなければ、そのノイズ床も測れないし、あとで「同じ入力なら
-- 結果を再利用する」を作るときの鍵も無い。送った通りの文字列を、送った形と一緒に。
create table if not exists public.position_review_prompts (
  analysis_id uuid primary key references public.analyses (id) on delete cascade,
  system text,
  "user" text,
  model text,
  effort text,
  max_tokens integer,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.position_review_prompts is
  '保有中プランの評価に送った 2 本の文字列と送信時の形。service role 専用。クライアントは読まない。';
comment on column public.position_review_prompts.effort is
  '送った output_config.effort。NULL は「送っていない」であって既定値ではない。';

alter table public.position_review_prompts enable row level security;
-- 方針は置かない: 方針の無い RLS は service role 以外を全部拒み、service role は RLS を通らない。
revoke all on public.position_review_prompts from public, anon, authenticated;
