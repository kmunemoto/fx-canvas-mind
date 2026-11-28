-- signal-alerts v43 (its index.ts, the note on the 5-minute reads' cost; the docs section is written after the
-- release): the five pairs' 5-minute chart (kline-direct.ts isKlineDirectChart) reads the ended GMO day files it needs
-- from GMO, not from this table. A run on a new instance read some 0.96 MB of them here (an estimate: some 4.0 files
-- a pair on each of its two sides, five pairs, at the 23,925 bytes the kept 5-minute files' JSON text averaged, measured on
-- 2026-11-28), 36 runs an hour, against the 5 GB a month of egress of
-- Supabase's Free plan (the organization's plan as read on 2026-11-28). This function says which of those
-- files the table keeps, with a digest of each. signal-alerts uses GMO's answer only when it is the kept file bar for
-- bar (count and digest equal), and the kept file otherwise. Files are still stored only when none is kept, as
-- before. Read only: no table, row or right of a table changes. Called by signal-alerts (service role).
-- One row per kept sound file (status 0, data a list, as indicators.ts keepableKlines):
--   s symbol, p price_type, d date_key, n its bars,
--   h the first 16 hex digits of the SHA-256 of its bars' text (per bar the stored openTime, open, high, low and
--   close joined by ',', a missing one empty; the bars joined by a newline in the file's own order).
-- kline-direct.ts klineDataText makes the same text from GMO's answer (and none for an odd bar, so they never agree).
-- Applied BEFORE signal-alerts is deployed (docs/OPERATIONS.md §6.1 item 5): a merge to main deploys the function, and
-- nothing in the repository applies this file. Dropping it sends signal-alerts back to v43's full read.
create or replace function public.gmo_kline_index(p_interval text, p_symbols text[], p_since text)
returns table (s text, p text, d text, n integer, h text)
language sql
stable
security invoker
set search_path = ''
as $$
  select f.symbol,
         f.price_type,
         f.date_key,
         jsonb_array_length(f.body -> 'data'),
         left(encode(sha256(convert_to(coalesce((
           select string_agg(concat(t.e ->> 'openTime', ',', t.e ->> 'open', ',', t.e ->> 'high', ',', t.e ->> 'low', ',', t.e ->> 'close'), chr(10) order by t.i)
           from jsonb_array_elements(f.body -> 'data') with ordinality as t(e, i)
         ), ''), 'UTF8')), 'hex'), 16)
  from public.gmo_kline_files f
  where f."interval" = p_interval
    and f.symbol = any (p_symbols)
    and f.date_key >= p_since
    and f.body -> 'status' = '0'::jsonb
    and jsonb_typeof(f.body -> 'data') = 'array'
  order by f.symbol, f.price_type, f.date_key;
$$;

revoke all on function public.gmo_kline_index(text, text[], text) from public, anon, authenticated;
grant execute on function public.gmo_kline_index(text, text[], text) to service_role;

-- Rollback (instant, no redeploy; the function then takes v43's preload on every run):
-- drop function if exists public.gmo_kline_index(text, text[], text);
