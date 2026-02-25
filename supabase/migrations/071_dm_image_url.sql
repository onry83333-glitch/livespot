-- Migration 071: dm_send_log に image_url カラム追加
-- 画像付きDM送信のため、送信キューに画像URLを保存する

ALTER TABLE public.dm_send_log ADD COLUMN IF NOT EXISTS image_url TEXT;
COMMENT ON COLUMN public.dm_send_log.image_url IS 'DM添付画像のURL（Supabase Storage公開URL）';
