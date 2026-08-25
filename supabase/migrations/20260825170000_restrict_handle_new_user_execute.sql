-- Supabase のセキュリティアドバイザ指摘への対応。
--
-- public スキーマの関数は PostgREST が /rest/v1/rpc/<name> として自動公開する。
-- handle_new_user は SECURITY DEFINER（所有者権限で実行）なので、外部から
-- 呼び出せる状態はアドバイザに警告される。
--
-- 実際にはトリガー専用関数（戻り値 trigger）のため RPC から呼んでも Postgres が
-- 拒否するが、公開自体を止めておく。トリガーの EXECUTE 権限はトリガー作成時に
-- 検査されるもので発火のたびには検査されないため、新規登録時のプロフィール
-- 作成は従来どおり動作する。
--
-- 万一新規登録が壊れた場合の切り戻しは以下の1行:
--   grant execute on function public.handle_new_user() to public;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
