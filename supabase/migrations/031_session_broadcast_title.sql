-- Migration 031: sessions に broadcast_title カラム追加
-- 配信タイトル（Stripchat DOM から抽出）

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS broadcast_title TEXT DEFAULT NULL;

COMMENT ON COLUMN public.sessions.broadcast_title IS '配信ルームのトピック/タイトル（DOM .view-cam-info-topic から自動取得）';
