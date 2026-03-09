-- ============================================================
-- 098: persona_feedback テーブル
-- 統一クリエイティブエンジンの生成結果+実績データ蓄積
-- ============================================================
-- ROLLBACK: DROP TABLE IF EXISTS persona_feedback;

CREATE TABLE IF NOT EXISTS persona_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cast_name   TEXT NOT NULL,
  task_type   TEXT NOT NULL CHECK (task_type IN ('dm', 'x_post', 'recruitment', 'content')),
  input_context JSONB DEFAULT '{}',
  output      TEXT NOT NULL DEFAULT '',
  score       FLOAT CHECK (score >= 0 AND score <= 100),
  score_source TEXT CHECK (score_source IN ('auto', 'manual')),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- インデックス: キャスト×タスク別の高評価データ取得を高速化
CREATE INDEX IF NOT EXISTS idx_persona_feedback_cast_task
  ON persona_feedback (cast_name, task_type);

CREATE INDEX IF NOT EXISTS idx_persona_feedback_score
  ON persona_feedback (score DESC NULLS LAST)
  WHERE score IS NOT NULL;

-- RLS
ALTER TABLE persona_feedback ENABLE ROW LEVEL SECURITY;

-- サービスロールは全操作可能
CREATE POLICY "service_role_all" ON persona_feedback
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 認証ユーザーはINSERT/SELECT可能（自社キャストのデータのみ）
CREATE POLICY "authenticated_insert" ON persona_feedback
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "authenticated_select" ON persona_feedback
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE persona_feedback IS '統一クリエイティブエンジンの生成結果+フィードバックデータ蓄積';
