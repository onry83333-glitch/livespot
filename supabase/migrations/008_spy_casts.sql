-- ============================================================
-- 008: spy_casts（他社キャスト管理）+ ユーザー横断分析RPC
-- 自社キャスト(registered_casts)と完全分離
-- ============================================================

-- 1. spy_castsテーブル
CREATE TABLE IF NOT EXISTS spy_casts (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  display_name TEXT,
  stripchat_url TEXT,
  category TEXT,
  format_tag TEXT,
  notes TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  auto_monitor BOOLEAN DEFAULT FALSE,
  screenshot_interval INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, cast_name)
);

-- RLS: オープンアクセス（他社分析データは共有可能）
ALTER TABLE spy_casts ENABLE ROW LEVEL SECURITY;
CREATE POLICY spy_casts_all ON spy_casts FOR ALL USING (true) WITH CHECK (true);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_spy_casts_account ON spy_casts(account_id);
CREATE INDEX IF NOT EXISTS idx_spy_casts_active ON spy_casts(is_active) WHERE is_active = true;

-- 2. ユーザー横断分析RPC
-- あるユーザーが複数キャストにまたがって活動した履歴を集計
CREATE OR REPLACE FUNCTION get_user_activity(
  p_account_id UUID,
  p_user_name TEXT
)
RETURNS TABLE (
  cast_name TEXT,
  total_coins BIGINT,
  visit_count BIGINT,
  last_visit TIMESTAMPTZ,
  message_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.cast_name,
    COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::BIGINT AS total_coins,
    COUNT(DISTINCT (sm.message_time::DATE))::BIGINT AS visit_count,
    MAX(sm.message_time) AS last_visit,
    COUNT(*)::BIGINT AS message_count
  FROM spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.user_name = p_user_name
  GROUP BY sm.cast_name
  ORDER BY COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. スパイキャスト統計RPC
-- spy_castsに登録済みのキャストの統計を一括取得
CREATE OR REPLACE FUNCTION get_spy_cast_stats(
  p_account_id UUID,
  p_cast_names TEXT[]
)
RETURNS TABLE (
  cast_name TEXT,
  total_messages BIGINT,
  total_tips BIGINT,
  total_coins BIGINT,
  unique_users BIGINT,
  last_activity TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.cast_name,
    COUNT(*)::BIGINT AS total_messages,
    COUNT(*) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))::BIGINT AS total_tips,
    COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::BIGINT AS total_coins,
    COUNT(DISTINCT sm.user_name)::BIGINT AS unique_users,
    MAX(sm.message_time) AS last_activity
  FROM spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.cast_name = ANY(p_cast_names)
  GROUP BY sm.cast_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
