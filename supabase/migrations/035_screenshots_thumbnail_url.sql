-- Migration 035: screenshots テーブルに thumbnail_url カラム追加
-- CDN方式サムネイル取得のURL保存用

ALTER TABLE public.screenshots ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

COMMENT ON COLUMN public.screenshots.thumbnail_url IS 'CDN方式で取得したサムネイルURL（storage_pathと排他）';
