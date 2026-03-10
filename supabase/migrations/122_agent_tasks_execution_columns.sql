-- 122: agent_tasks にタスク自動実行エージェント用カラム追加
-- task_type: タスク種別（investigation, ui_fix, implementation, design, data_cleanup）
-- execution_prompt: エージェントに渡す実行プロンプト
-- skill_files: 参照すべきスキル/エージェントファイルパス
-- target_files: 対象ファイルパス
--
-- ROLLBACK:
--   ALTER TABLE public.agent_tasks DROP COLUMN IF EXISTS task_type;
--   ALTER TABLE public.agent_tasks DROP COLUMN IF EXISTS execution_prompt;
--   ALTER TABLE public.agent_tasks DROP COLUMN IF EXISTS skill_files;
--   ALTER TABLE public.agent_tasks DROP COLUMN IF EXISTS target_files;

ALTER TABLE public.agent_tasks
  ADD COLUMN IF NOT EXISTS task_type TEXT DEFAULT 'implementation',
  ADD COLUMN IF NOT EXISTS execution_prompt TEXT,
  ADD COLUMN IF NOT EXISTS skill_files TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS target_files TEXT[] DEFAULT '{}';

ALTER TABLE public.agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_task_type_check;
ALTER TABLE public.agent_tasks ADD CONSTRAINT agent_tasks_task_type_check
  CHECK (task_type IN ('ui_fix', 'investigation', 'implementation', 'design', 'data_cleanup'));

COMMENT ON COLUMN public.agent_tasks.task_type IS 'タスク種別: ui_fix/investigation/implementation/design/data_cleanup';
COMMENT ON COLUMN public.agent_tasks.execution_prompt IS 'エージェントに渡す実行プロンプト全文';
COMMENT ON COLUMN public.agent_tasks.skill_files IS '参照すべきスキル/エージェントファイルパス配列';
COMMENT ON COLUMN public.agent_tasks.target_files IS '対象ファイルパス配列';

NOTIFY pgrst, 'reload schema';
