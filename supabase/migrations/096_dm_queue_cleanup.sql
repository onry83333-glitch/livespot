-- 096: dm_send_log クリーンアップ
-- 1. status CHECK制約に 'cancelled' を追加
-- 2. cast_name, account_id に NOT NULL 制約を追加（キャスト間誤送信防止）

-- Step 1: CHECK制約を更新（cancelled を追加）
ALTER TABLE public.dm_send_log
  DROP CONSTRAINT IF EXISTS dm_send_log_status_check;

ALTER TABLE public.dm_send_log
  ADD CONSTRAINT dm_send_log_status_check
  CHECK (status IN ('success', 'error', 'pending', 'queued', 'sending', 'cancelled'));

-- Step 2: 滞留queued 150件を cancelled に更新（削除ではなく履歴保持）
UPDATE public.dm_send_log
  SET status = 'cancelled'
  WHERE status = 'queued';

-- Step 3: cast_name に NOT NULL 制約を追加
-- 既存NULLを空文字に変換してから制約追加
UPDATE public.dm_send_log SET cast_name = '' WHERE cast_name IS NULL;
ALTER TABLE public.dm_send_log ALTER COLUMN cast_name SET NOT NULL;
ALTER TABLE public.dm_send_log ALTER COLUMN cast_name SET DEFAULT '';

-- account_id は初期スキーマで既に NOT NULL REFERENCES accounts(id)
-- 確認のみ（追加不要）
