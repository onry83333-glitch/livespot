-- 119: agent_tasks に verification ステータス + data_dependency 追加
-- 事業OS構造的問題修正: 検証なき完了 + 連動なきプロジェクト

ALTER TABLE public.agent_tasks
  ADD COLUMN IF NOT EXISTS data_dependency JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS verification_notes TEXT;

-- status の CHECK 制約を更新（verification を追加）
ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
ALTER TABLE public.agent_tasks ADD CONSTRAINT agent_tasks_status_check
  CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'verification'));

COMMENT ON COLUMN public.agent_tasks.data_dependency IS '{"requires": "coin_sync_healthy", "check": "説明"}';
COMMENT ON COLUMN public.agent_tasks.verification_notes IS 'YUUTA検証時のメモ（OK/NG理由）';
