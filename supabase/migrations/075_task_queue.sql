-- P0-10: Claude.ai → デスクトップ タスクキュー
-- claude.aiからタスクをINSERT → デスクトップポーラーが検出・実行

CREATE TABLE task_queue (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  source text DEFAULT 'claude_ai',
  title text NOT NULL,
  instruction text NOT NULL,
  target text DEFAULT 'claude_code',
  priority text DEFAULT 'normal' CHECK (priority IN ('urgent', 'normal', 'low')),
  started_at timestamptz,
  completed_at timestamptz,
  result text,
  error text
);

CREATE INDEX idx_task_queue_status ON task_queue(status);
CREATE INDEX idx_task_queue_created ON task_queue(created_at DESC);

-- RLS: service_roleのみ全操作可能
ALTER TABLE task_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON task_queue FOR ALL USING (true) WITH CHECK (true);
