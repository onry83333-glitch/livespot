-- ============================================================
-- 101: cast_knowledge — キャスト専用ナレッジ蓄積テーブル
--
-- 配信後レポート・日次ブリーフィング・週次レビューを保存。
-- 将来100+キャスト規模でスケールする設計。
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS cast_knowledge;
-- ============================================================

CREATE TABLE IF NOT EXISTS cast_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cast_id BIGINT NOT NULL REFERENCES registered_casts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('post_session', 'daily_briefing', 'weekly_review')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ,
  metrics_json JSONB NOT NULL DEFAULT '{}',
  insights_json JSONB NOT NULL DEFAULT '{}',
  benchmark_json JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一配信の重複レポート防止
CREATE UNIQUE INDEX IF NOT EXISTS uq_cast_knowledge_report
  ON cast_knowledge (cast_id, report_type, period_start);

-- 時系列クエリ高速化
CREATE INDEX IF NOT EXISTS idx_cast_knowledge_period
  ON cast_knowledge (period_start DESC);

-- account_id検索用
CREATE INDEX IF NOT EXISTS idx_cast_knowledge_account
  ON cast_knowledge (account_id);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE cast_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cast_knowledge_select" ON cast_knowledge
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY "cast_knowledge_insert" ON cast_knowledge
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

CREATE POLICY "cast_knowledge_update" ON cast_knowledge
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY "cast_knowledge_delete" ON cast_knowledge
  FOR DELETE USING (account_id IN (SELECT user_account_ids()));

-- PostgREST スキーマキャッシュ通知
NOTIFY pgrst, 'reload schema';
