-- ============================================================
-- 086: sessions テーブル スキーマキャッシュ修正
--
-- 問題: PostgREST スキーマキャッシュに sessions.total_tokens 等が
--       存在せず、Collector の closeSession() UPDATE が失敗する。
--       セッション終了（ended_at）が記録されない → 配信中のまま残る。
--
-- 修正: カラム存在保証 + スキーマキャッシュのリロード通知
--
-- ROLLBACK: この migration はカラム追加のみ（既存の場合は何もしない）。
--           NOTIFY pgrst は副作用なし。ロールバック不要。
-- ============================================================

-- sessions テーブルのカラム存在保証（IF NOT EXISTS で安全）
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_messages INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS peak_viewers INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- PostgREST スキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';
