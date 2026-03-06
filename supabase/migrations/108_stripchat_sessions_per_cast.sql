-- Migration 108: stripchat_sessions をキャスト別Cookie対応に変更
-- 背景: Stripchat APIはモデル別認証Cookieが必要。1アカウント1行では複数キャスト分離不可
--
-- ROLLBACK:
-- ALTER TABLE stripchat_sessions DROP CONSTRAINT IF EXISTS stripchat_sessions_account_cast_key;
-- ALTER TABLE stripchat_sessions ADD CONSTRAINT stripchat_sessions_account_id_key UNIQUE(account_id);
-- ALTER TABLE stripchat_sessions DROP COLUMN IF EXISTS cast_name;

-- 1. cast_name カラム追加
ALTER TABLE public.stripchat_sessions ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- 2. 旧UNIQUE制約を削除
ALTER TABLE public.stripchat_sessions DROP CONSTRAINT IF EXISTS stripchat_sessions_account_id_key;

-- 3. 新UNIQUE制約（account_id, cast_name）
-- cast_name=NULL は「共通セッション」扱い（後方互換）
ALTER TABLE public.stripchat_sessions
  ADD CONSTRAINT stripchat_sessions_account_cast_key UNIQUE(account_id, cast_name);

-- 4. インデックス更新
DROP INDEX IF EXISTS idx_stripchat_sessions_active;
CREATE INDEX idx_stripchat_sessions_active
  ON public.stripchat_sessions(account_id, cast_name, is_valid);
