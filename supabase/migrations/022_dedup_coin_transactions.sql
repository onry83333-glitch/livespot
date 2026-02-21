-- ==============================================
-- 022: coin_transactions重複行の除去 + 制約追加
-- ==============================================

-- 1. 重複行の実態確認（実行前に確認）
SELECT user_name, cast_name, tokens, date, COUNT(*) as cnt
FROM coin_transactions
WHERE date >= '2025-02-15'
GROUP BY user_name, cast_name, tokens, date
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 20;

-- 2. 重複行を除去（各グループで最小IDだけ残す）
DELETE FROM coin_transactions
WHERE id NOT IN (
  SELECT MIN(id)
  FROM coin_transactions
  GROUP BY account_id, user_name, cast_name, tokens, date
);

-- 3. 削除結果確認
SELECT COUNT(*) AS total_after_dedup FROM coin_transactions;

-- 4. ユニーク制約を追加（今後の重複防止）
-- account_id含めてマルチテナント対応
-- 同一ユーザー・同一キャスト・同一金額・同一日時の組み合わせを許可しない
CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_tx_dedup
ON coin_transactions (account_id, user_name, cast_name, tokens, date);

-- 5. 旧 stripchat_tx_id ベースのユニーク制約は残す（NULLでなければ有効）
-- 既存のインデックスがあれば確認
-- SELECT indexname FROM pg_indexes WHERE tablename = 'coin_transactions';
