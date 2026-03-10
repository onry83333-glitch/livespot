-- 118: cast_knowledge テーブル拡張
-- 分析レポート分類・セッション紐付け・RAG用embedding・フィードバック

ALTER TABLE public.cast_knowledge
  ADD COLUMN IF NOT EXISTS knowledge_type TEXT,
  ADD COLUMN IF NOT EXISTS source_session_id UUID,
  ADD COLUMN IF NOT EXISTS feedback TEXT;

-- knowledge_type のデフォルト値をセット（既存レコード）
UPDATE public.cast_knowledge
  SET knowledge_type = report_type
  WHERE knowledge_type IS NULL;

COMMENT ON COLUMN public.cast_knowledge.knowledge_type IS 'session_report / competitor_diff / weekly_summary / daily_briefing';
COMMENT ON COLUMN public.cast_knowledge.source_session_id IS '分析元セッションID（session_reportの場合）';
COMMENT ON COLUMN public.cast_knowledge.feedback IS 'YUUTAの良い/悪い判定（good / bad / comment）';

-- embedding カラムは pgvector 拡張が必要なため、将来の有効化時に追加
-- CREATE EXTENSION IF NOT EXISTS vector;
-- ALTER TABLE public.cast_knowledge ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);

CREATE INDEX IF NOT EXISTS idx_cast_knowledge_type ON public.cast_knowledge(knowledge_type);
CREATE INDEX IF NOT EXISTS idx_cast_knowledge_session ON public.cast_knowledge(source_session_id);
