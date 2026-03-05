-- Migration 103: dm_trigger_logs action_taken CHECK制約に skipped_test_mode 追加
-- 根本原因: dm-guard.ts が 'skipped_test_mode' をINSERTするが、064のCHECK制約に未登録
-- 結果: トリガーログINSERTが100%失敗していた
--
-- ROLLBACK:
-- ALTER TABLE public.dm_trigger_logs DROP CONSTRAINT IF EXISTS dm_trigger_logs_action_taken_check;
-- ALTER TABLE public.dm_trigger_logs ADD CONSTRAINT dm_trigger_logs_action_taken_check
--   CHECK (action_taken IN ('dm_queued','scenario_enrolled','skipped_cooldown','skipped_duplicate','skipped_segment','skipped_daily_limit','error'));

BEGIN;

-- 旧CHECK制約を削除
ALTER TABLE public.dm_trigger_logs
  DROP CONSTRAINT IF EXISTS dm_trigger_logs_action_taken_check;

-- 新CHECK制約（skipped_test_mode 追加）
ALTER TABLE public.dm_trigger_logs
  ADD CONSTRAINT dm_trigger_logs_action_taken_check
  CHECK (action_taken IN (
    'dm_queued',
    'scenario_enrolled',
    'skipped_cooldown',
    'skipped_duplicate',
    'skipped_segment',
    'skipped_daily_limit',
    'skipped_test_mode',
    'error'
  ));

COMMIT;
