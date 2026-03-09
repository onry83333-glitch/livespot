-- Migration 100: テストDMデータ削除（2026-03-05 適用済み）
-- 対象: dm_send_log 全464件（全てテスト/失敗/滞留データ）
--
-- 削除内訳:
--   手動テスト（TEST, pipe3_*, pipe5_*）: 7件
--   trigger_* (error/cancelled/queued): 455件
--   auto_churn_* (pending): 2件
--
-- ROLLBACK手順:
--   復元不可（DELETE）。全て error/cancelled/queued/pending のテストデータのため実害なし。
--   成功(success)ステータスのレコードは0件だった。

-- 1. 手動テストデータ削除
DELETE FROM dm_send_log
WHERE campaign IN (
  'TEST',
  'pipe3_test_bulk_20260302_1310',
  'pipe3_adsf_bulk_20260302_1315',
  'pipe3_asdg_bulk_20260302_1311',
  'pipe3_asdg_bulk_20260302_1314'
);

DELETE FROM dm_send_log
WHERE campaign LIKE 'pipe5_%';

-- 2. トリガーDM全件削除（全て error/cancelled/queued）
DELETE FROM dm_send_log
WHERE campaign LIKE 'trigger_%';

-- 3. auto_churn テスト削除
DELETE FROM dm_send_log
WHERE campaign LIKE 'auto_churn_%';
