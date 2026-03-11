-- ============================================================
-- Migration 128: coin_tx_tokens_positive → coin_tx_tokens_nonneg
-- tokens=0のトランザクション（非課金イベント）もDBに保存する
-- 根本原因: CHECK (tokens > 0) が ~31,000件のtokens=0レコードを拒否
-- ============================================================

ALTER TABLE public.coin_transactions DROP CONSTRAINT IF EXISTS coin_tx_tokens_positive;
ALTER TABLE public.coin_transactions ADD CONSTRAINT coin_tx_tokens_nonneg CHECK (tokens >= 0);

-- idx_coin_tx_dedup (account_id, user_name, cast_name, tokens, date) は
-- tokens=0の同一ユーザー・同一タイムスタンプのトランザクションでUNIQUE違反を起こす。
-- coin_tx_account_stripchat_id_unique (account_id, stripchat_tx_id) で十分なのでDROP。
DROP INDEX IF EXISTS public.idx_coin_tx_dedup;
