-- ============================================================
-- 005: キャスト集計RPC関数
-- spy_messagesの1000行制限を回避するためにDB側で集計
-- ============================================================

-- キャスト別集計（/casts一覧ページ用）
CREATE OR REPLACE FUNCTION get_cast_stats(
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

-- キャストのファン一覧（DMタブ用）
CREATE OR REPLACE FUNCTION get_cast_fans(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  user_name TEXT,
  total_tokens BIGINT,
  msg_count BIGINT,
  last_seen TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.user_name,
    COALESCE(SUM(sm.tokens), 0)::BIGINT AS total_tokens,
    COUNT(*)::BIGINT AS msg_count,
    MAX(sm.message_time) AS last_seen
  FROM spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.cast_name = p_cast_name
    AND sm.user_name IS NOT NULL
  GROUP BY sm.user_name
  ORDER BY COALESCE(SUM(sm.tokens), 0) DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
