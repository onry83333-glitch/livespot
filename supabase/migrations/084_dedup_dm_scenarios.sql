-- 084_dedup_dm_scenarios.sql
-- 目的: dm_scenarios の重複レコード削除 + UNIQUE制約追加
-- 対象: 「初課金お礼」「離脱防止(7日)」「来訪フォロー」が各2件存在
--
-- ROLLBACK:
--   ALTER TABLE dm_scenarios DROP CONSTRAINT IF EXISTS uq_dm_scenarios_account_name;
--   ALTER TABLE dm_triggers DROP CONSTRAINT IF EXISTS uq_dm_triggers_account_name;

BEGIN;

-- ============================================================
-- 1. dm_scenarios: 重複レコード削除（古い方を削除、新しい方を残す）
-- ============================================================

-- 重複の中で古い方（created_at が小さい方）を削除
-- 同一 account_id + scenario_name で複数行ある場合、最新1件だけ残す
DELETE FROM dm_scenarios
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY account_id, scenario_name
             ORDER BY created_at DESC
           ) AS rn
    FROM dm_scenarios
  ) ranked
  WHERE rn > 1
);

-- ============================================================
-- 2. dm_scenarios: UNIQUE制約追加（同一アカウント内でシナリオ名一意）
-- ============================================================

ALTER TABLE dm_scenarios
  ADD CONSTRAINT uq_dm_scenarios_account_name
  UNIQUE (account_id, scenario_name);

-- ============================================================
-- 3. dm_triggers: UNIQUE制約追加（同一アカウント内でトリガー名一意）
-- ============================================================

-- まず重複があれば削除（安全のため）
DELETE FROM dm_triggers
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY account_id, trigger_name
             ORDER BY created_at DESC
           ) AS rn
    FROM dm_triggers
  ) ranked
  WHERE rn > 1
);

ALTER TABLE dm_triggers
  ADD CONSTRAINT uq_dm_triggers_account_name
  UNIQUE (account_id, trigger_name);

COMMIT;
