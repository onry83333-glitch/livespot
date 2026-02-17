-- ============================================================
-- 006: キャスト分析RPC関数
-- セッション分割、リテンション分析、DM効果測定
-- ============================================================

-- 1. セッション分割（30分ギャップでセッション区切り）
CREATE OR REPLACE FUNCTION get_cast_sessions(
  p_account_id UUID,
  p_cast_name TEXT,
  p_since DATE DEFAULT '2026-02-15'
)
RETURNS TABLE (
  session_date DATE,
  session_start TIMESTAMPTZ,
  session_end TIMESTAMPTZ,
  message_count BIGINT,
  tip_count BIGINT,
  total_coins BIGINT,
  unique_users BIGINT
) AS $$
BEGIN
  RETURN QUERY
  WITH ordered AS (
    SELECT
      sm.message_time,
      sm.msg_type,
      sm.tokens,
      sm.user_name,
      LAG(sm.message_time) OVER (ORDER BY sm.message_time) AS prev_time
    FROM spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = p_cast_name
      AND sm.message_time >= p_since::TIMESTAMPTZ
  ),
  sessioned AS (
    SELECT
      o.*,
      SUM(CASE
        WHEN o.prev_time IS NULL
          OR EXTRACT(EPOCH FROM o.message_time - o.prev_time) > 1800
        THEN 1 ELSE 0
      END) OVER (ORDER BY o.message_time) AS session_id
    FROM ordered o
  )
  SELECT
    (MIN(s.message_time) AT TIME ZONE 'Asia/Tokyo')::DATE AS session_date,
    MIN(s.message_time) AS session_start,
    MAX(s.message_time) AS session_end,
    COUNT(*)::BIGINT AS message_count,
    COUNT(*) FILTER (WHERE s.msg_type IN ('tip', 'gift'))::BIGINT AS tip_count,
    COALESCE(SUM(s.tokens) FILTER (WHERE s.msg_type IN ('tip', 'gift')), 0)::BIGINT AS total_coins,
    COUNT(DISTINCT s.user_name)::BIGINT AS unique_users
  FROM sessioned s
  GROUP BY s.session_id
  HAVING COUNT(*) > 5
  ORDER BY MIN(s.message_time) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. ユーザーリテンションステータス分類
CREATE OR REPLACE FUNCTION get_user_retention_status(
  p_account_id UUID,
  p_cast_name TEXT
)
RETURNS TABLE (
  user_name TEXT,
  status TEXT,
  total_tokens BIGINT,
  tip_count BIGINT,
  last_tip TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  first_tip TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.user_name,
    CASE
      WHEN MAX(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift')) IS NULL THEN 'free'
      WHEN MAX(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))
        >= NOW() - INTERVAL '7 days'
        AND MIN(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))
        >= NOW() - INTERVAL '7 days' THEN 'new'
      WHEN MAX(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))
        >= NOW() - INTERVAL '7 days' THEN 'active'
      WHEN MAX(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))
        >= NOW() - INTERVAL '14 days' THEN 'at_risk'
      ELSE 'churned'
    END AS status,
    COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::BIGINT AS total_tokens,
    COUNT(*) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))::BIGINT AS tip_count,
    MAX(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift')) AS last_tip,
    MAX(sm.message_time) AS last_seen,
    MIN(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift')) AS first_tip
  FROM spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.cast_name = p_cast_name
    AND sm.user_name IS NOT NULL
  GROUP BY sm.user_name
  HAVING COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0) > 0
  ORDER BY COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. DMキャンペーン効果測定
CREATE OR REPLACE FUNCTION get_dm_campaign_effectiveness(
  p_account_id UUID,
  p_cast_name TEXT,
  p_window_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  campaign TEXT,
  sent_count BIGINT,
  success_count BIGINT,
  visited_count BIGINT,
  tipped_count BIGINT,
  tip_amount BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.campaign,
    COUNT(*)::BIGINT AS sent_count,
    COUNT(*) FILTER (WHERE d.status = 'success')::BIGINT AS success_count,
    COUNT(DISTINCT CASE
      WHEN EXISTS (
        SELECT 1 FROM spy_messages sm
        WHERE sm.account_id = p_account_id
          AND sm.cast_name = p_cast_name
          AND sm.user_name = d.user_name
          AND sm.message_time > d.sent_at
          AND sm.message_time <= d.sent_at + (p_window_days || ' days')::INTERVAL
      ) THEN d.user_name
    END)::BIGINT AS visited_count,
    COUNT(DISTINCT CASE
      WHEN EXISTS (
        SELECT 1 FROM spy_messages sm
        WHERE sm.account_id = p_account_id
          AND sm.cast_name = p_cast_name
          AND sm.user_name = d.user_name
          AND sm.msg_type IN ('tip', 'gift')
          AND sm.message_time > d.sent_at
          AND sm.message_time <= d.sent_at + (p_window_days || ' days')::INTERVAL
      ) THEN d.user_name
    END)::BIGINT AS tipped_count,
    COALESCE((
      SELECT SUM(sm2.tokens)
      FROM spy_messages sm2
      WHERE sm2.account_id = p_account_id
        AND sm2.cast_name = p_cast_name
        AND sm2.msg_type IN ('tip', 'gift')
        AND sm2.user_name IN (
          SELECT d2.user_name FROM dm_send_log d2
          WHERE d2.campaign = d.campaign AND d2.status = 'success'
        )
        AND sm2.message_time > MIN(d.sent_at)
        AND sm2.message_time <= MIN(d.sent_at) + (p_window_days || ' days')::INTERVAL
    ), 0)::BIGINT AS tip_amount
  FROM dm_send_log d
  WHERE d.account_id = p_account_id
    AND d.campaign IS NOT NULL
    AND d.campaign != ''
  GROUP BY d.campaign
  ORDER BY MIN(d.queued_at) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. 新規課金ユーザー検出
CREATE OR REPLACE FUNCTION detect_new_tippers(
  p_account_id UUID,
  p_cast_name TEXT,
  p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '7 days'
)
RETURNS TABLE (
  user_name TEXT,
  first_tip_time TIMESTAMPTZ,
  first_tip_tokens BIGINT,
  total_tokens BIGINT,
  msg_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.user_name,
    MIN(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift')) AS first_tip_time,
    (ARRAY_AGG(sm.tokens ORDER BY sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift')))[1]::BIGINT AS first_tip_tokens,
    COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::BIGINT AS total_tokens,
    COUNT(*)::BIGINT AS msg_count
  FROM spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.cast_name = p_cast_name
    AND sm.user_name IS NOT NULL
  GROUP BY sm.user_name
  HAVING MIN(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift')) >= p_since
  ORDER BY MIN(sm.message_time) FILTER (WHERE sm.msg_type IN ('tip', 'gift')) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
