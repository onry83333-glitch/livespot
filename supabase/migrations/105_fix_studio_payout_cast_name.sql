-- 105_fix_studio_payout_cast_name.sql
-- studio payoutのcast_name誤帰属を修正
-- 原因: coin-sync-service.tsがaccount単位で取得したtransactionsを最初のcast_nameに一律割当
-- studio typeはuser_name=キャスト自身なのでuser_nameからcast_nameを判定すべき
--
-- ROLLBACK:
--   この修正は「正しいcast_nameへの再割当」なので、ロールバックは不要。
--   万が一戻す場合は、synced_atが本マイグレーション実行時刻のレコードを特定して
--   元のcast_nameに戻す（実用上は不要）。

-- Step 1: 対象件数の確認（実行前チェック）
-- SELECT
--   ct.id, ct.user_name, ct.cast_name AS current_cast_name,
--   rc.cast_name AS correct_cast_name, ct.tokens, ct.date
-- FROM coin_transactions ct
-- JOIN registered_casts rc ON rc.account_id = ct.account_id AND rc.cast_name = ct.user_name
-- WHERE ct.type = 'studio'
--   AND ct.cast_name != ct.user_name
-- ORDER BY ct.date DESC;

-- Step 2: 修正実行
UPDATE coin_transactions ct
SET cast_name = rc.cast_name
FROM registered_casts rc
WHERE rc.account_id = ct.account_id
  AND rc.cast_name = ct.user_name
  AND ct.type = 'studio'
  AND ct.cast_name != ct.user_name;
