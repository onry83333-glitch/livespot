-- Migration 109: stripchat_sessions UNIQUE制約をNULLS NOT DISTINCTに強化
-- 背景: cast_name=NULLが複数INSERT可能（PostgreSQL標準UNIQUE）→ upsert 42P10エラー
-- PostgreSQL 15+ の NULLS NOT DISTINCT で NULL も一意制約に含める
--
-- ROLLBACK:
-- ALTER TABLE stripchat_sessions DROP CONSTRAINT IF EXISTS stripchat_sessions_account_cast_key;
-- ALTER TABLE stripchat_sessions ADD CONSTRAINT stripchat_sessions_account_cast_key UNIQUE(account_id, cast_name);

-- 1. 既存NULLの重複を解消（最新1行のみ残す）
DELETE FROM public.stripchat_sessions a
USING public.stripchat_sessions b
WHERE a.cast_name IS NULL
  AND b.cast_name IS NULL
  AND a.account_id = b.account_id
  AND a.updated_at < b.updated_at;

-- 2. 旧制約を削除
ALTER TABLE public.stripchat_sessions
  DROP CONSTRAINT IF EXISTS stripchat_sessions_account_cast_key;

-- 3. NULLS NOT DISTINCT付き制約を追加
ALTER TABLE public.stripchat_sessions
  ADD CONSTRAINT stripchat_sessions_account_cast_key
  UNIQUE NULLS NOT DISTINCT (account_id, cast_name);
