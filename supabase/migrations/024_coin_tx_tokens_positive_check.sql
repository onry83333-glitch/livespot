-- ==============================================
-- 024: coin_transactions tokens > 0 CHECK制約
-- マイナストークン・ゼロトークンの記録を防止
-- ==============================================

-- 1. 既存の不正データ（tokens <= 0）を削除
DELETE FROM coin_transactions WHERE tokens <= 0;

-- 2. CHECK制約を追加
ALTER TABLE public.coin_transactions
  ADD CONSTRAINT coin_tx_tokens_positive CHECK (tokens > 0);
