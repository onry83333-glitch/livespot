-- Migration 073: dm_send_log に send_order カラム追加
-- 画像DM送信時の送信順序を記録（Phase 1: UI, Phase 2: Chrome拡張で実行）

ALTER TABLE public.dm_send_log
  ADD COLUMN IF NOT EXISTS send_order TEXT DEFAULT 'text_only';

COMMENT ON COLUMN public.dm_send_log.send_order IS
  '送信順序: text_only / image_only / text_then_image / image_then_text';
