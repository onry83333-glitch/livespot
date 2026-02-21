-- Migration 042: dm_send_log AI生成カラム追加
-- Phase 2: Persona Agent統合でAI生成メタデータを保存

-- ai_generated: AI生成かテンプレートか
ALTER TABLE dm_send_log
ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT false;

-- ai_reasoning: AIの生成理由（JSONテキスト）
ALTER TABLE dm_send_log
ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;

-- ai_confidence: AI信頼度スコア（0-100）
ALTER TABLE dm_send_log
ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC;

-- scenario_enrollment_id: シナリオエンロールメントとの紐付け
ALTER TABLE dm_send_log
ADD COLUMN IF NOT EXISTS scenario_enrollment_id UUID REFERENCES dm_scenario_enrollments(id) ON DELETE SET NULL;

-- edited_by_human: 人間が編集したかどうか
ALTER TABLE dm_send_log
ADD COLUMN IF NOT EXISTS edited_by_human BOOLEAN DEFAULT false;

-- original_ai_message: 編集前のAI生成メッセージ（編集された場合のみ保存）
ALTER TABLE dm_send_log
ADD COLUMN IF NOT EXISTS original_ai_message TEXT;

-- インデックス: pending + ai_generated の組み合わせ（承認UI用）
CREATE INDEX IF NOT EXISTS idx_dm_send_log_pending_ai
ON dm_send_log(status, ai_generated)
WHERE status = 'pending';

-- コメント
COMMENT ON COLUMN dm_send_log.ai_generated IS 'AI生成DM（true）かテンプレート（false）か';
COMMENT ON COLUMN dm_send_log.ai_reasoning IS 'AIの生成理由';
COMMENT ON COLUMN dm_send_log.ai_confidence IS 'AI信頼度スコア（0-100）';
COMMENT ON COLUMN dm_send_log.scenario_enrollment_id IS 'シナリオエンロールメントとの紐付け';
COMMENT ON COLUMN dm_send_log.edited_by_human IS '人間が編集したかどうか';
COMMENT ON COLUMN dm_send_log.original_ai_message IS '編集前のAI生成メッセージ';
