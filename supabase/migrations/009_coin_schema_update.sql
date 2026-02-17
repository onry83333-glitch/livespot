-- 009: coin_transactions スキーマ拡張
-- Stripchat API IDでのupsert重複排除 + 追加フィールド

-- Stripchat APIの生ID（upsertのconflictキー）
ALTER TABLE public.coin_transactions ADD COLUMN IF NOT EXISTS stripchat_tx_id BIGINT;

-- ユーザーID（Stripchat内部ID）
ALTER TABLE public.coin_transactions ADD COLUMN IF NOT EXISTS user_id BIGINT;

-- USD金額
ALTER TABLE public.coin_transactions ADD COLUMN IF NOT EXISTS amount NUMERIC;

-- 匿名フラグ
ALTER TABLE public.coin_transactions ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT false;

-- 同期日時
ALTER TABLE public.coin_transactions ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT now();

-- Upsert用ユニーク制約（account_id + Stripchat API tx id）
-- NULLは複数許可されるため既存データに影響なし
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'coin_tx_account_stripchat_id_unique'
  ) THEN
    ALTER TABLE public.coin_transactions
      ADD CONSTRAINT coin_tx_account_stripchat_id_unique UNIQUE (account_id, stripchat_tx_id);
  END IF;
END $$;
