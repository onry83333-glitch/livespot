-- ============================================================
-- 060: DM効果測定v2 + 配信時間帯パフォーマンス
-- セグメント別DM CVR + 時間帯別時給換算
-- ============================================================

-- ============================================================
-- RPC 1: get_dm_effectiveness_by_segment
-- キャンペーン×セグメント別のDM効果測定
-- 来訪判定: DM送信後24h以内にspy_messagesに出現
-- 課金判定: DM送信後48h以内にcoin_transactionsに出現
-- ============================================================
CREATE OR REPLACE FUNCTION get_dm_effectiveness_by_segment(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  campaign TEXT,
  segment TEXT,
  sent_count BIGINT,
  visited_count BIGINT,
  paid_count BIGINT,
  visit_cvr NUMERIC,
  payment_cvr NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_payer NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH dm_sent AS (
    -- 成功したDM送信ログ
    SELECT
      d.user_name,
      d.campaign,
      d.cast_name,
      d.sent_at
    FROM dm_send_log d
    WHERE d.account_id = p_account_id
      AND d.status = 'success'
      AND d.sent_at >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR d.cast_name = p_cast_name)
  ),
  dm_with_segment AS (
    -- セグメント情報を付与
    SELECT
      ds.user_name,
      ds.campaign,
      ds.cast_name,
      ds.sent_at,
      COALESCE(pu.segment, 'unknown') AS user_segment
    FROM dm_sent ds
    LEFT JOIN paid_users pu
      ON pu.account_id = p_account_id
      AND pu.user_name = ds.user_name
      AND (p_cast_name IS NULL OR pu.cast_name = ds.cast_name)
  ),
  visit_check AS (
    -- DM送信後24h以内のspy_messages出現チェック
    SELECT DISTINCT
      dws.user_name,
      dws.campaign,
      dws.user_segment
    FROM dm_with_segment dws
    WHERE EXISTS (
      SELECT 1 FROM spy_messages sm
      WHERE sm.account_id = p_account_id
        AND sm.user_name = dws.user_name
        AND sm.cast_name = dws.cast_name
        AND sm.message_time BETWEEN dws.sent_at AND dws.sent_at + INTERVAL '24 hours'
    )
  ),
  payment_check AS (
    -- DM送信後48h以内のcoin_transactions出現チェック
    SELECT DISTINCT
      dws.user_name,
      dws.campaign,
      dws.user_segment,
      ct_sum.total_tk
    FROM dm_with_segment dws
    INNER JOIN LATERAL (
      SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tk
      FROM coin_transactions ct
      WHERE ct.account_id = p_account_id
        AND ct.user_name = dws.user_name
        AND ct.cast_name = dws.cast_name
        AND ct.date BETWEEN dws.sent_at AND dws.sent_at + INTERVAL '48 hours'
    ) ct_sum ON ct_sum.total_tk > 0
  )
  SELECT
    dws.campaign,
    dws.user_segment AS segment,
    COUNT(DISTINCT dws.user_name)::BIGINT AS sent_count,
    COUNT(DISTINCT vc.user_name)::BIGINT AS visited_count,
    COUNT(DISTINCT pc.user_name)::BIGINT AS paid_count,
    ROUND(
      COUNT(DISTINCT vc.user_name) * 100.0 / NULLIF(COUNT(DISTINCT dws.user_name), 0),
      1
    ) AS visit_cvr,
    ROUND(
      COUNT(DISTINCT pc.user_name) * 100.0 / NULLIF(COUNT(DISTINCT dws.user_name), 0),
      1
    ) AS payment_cvr,
    COALESCE(SUM(pc.total_tk), 0)::BIGINT AS total_tokens,
    ROUND(
      COALESCE(SUM(pc.total_tk), 0)::NUMERIC / NULLIF(COUNT(DISTINCT pc.user_name), 0),
      0
    ) AS avg_tokens_per_payer
  FROM dm_with_segment dws
  LEFT JOIN visit_check vc
    ON vc.user_name = dws.user_name
    AND vc.campaign = dws.campaign
    AND vc.user_segment = dws.user_segment
  LEFT JOIN payment_check pc
    ON pc.user_name = dws.user_name
    AND pc.campaign = dws.campaign
    AND pc.user_segment = dws.user_segment
  GROUP BY dws.campaign, dws.user_segment
  ORDER BY COUNT(DISTINCT dws.user_name) DESC, dws.campaign;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- RPC 2: get_cast_hourly_performance
-- 時間帯別配信パフォーマンス（セッション推定 → 時給換算）
-- spy_messagesの30分以上の間隔でセッション区切り
-- ============================================================
CREATE OR REPLACE FUNCTION get_cast_hourly_performance(
  p_account_id UUID,
  p_cast_name TEXT,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  hour_jst INTEGER,
  session_count BIGINT,
  avg_duration_min NUMERIC,
  avg_viewers NUMERIC,
  avg_tokens NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_hour NUMERIC
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
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
  ),
  sessioned AS (
    SELECT
      o.*,
      SUM(CASE
        WHEN o.prev_time IS NULL
          OR EXTRACT(EPOCH FROM o.message_time - o.prev_time) > 1800
        THEN 1 ELSE 0
      END) OVER (ORDER BY o.message_time) AS sess_id
    FROM ordered o
  ),
  session_stats AS (
    SELECT
      s.sess_id,
      EXTRACT(HOUR FROM MIN(s.message_time) AT TIME ZONE 'Asia/Tokyo')::INTEGER AS start_hour,
      EXTRACT(EPOCH FROM MAX(s.message_time) - MIN(s.message_time))::NUMERIC / 60.0 AS duration_min,
      COUNT(DISTINCT s.user_name)::NUMERIC AS unique_viewers,
      COALESCE(SUM(s.tokens) FILTER (WHERE s.msg_type IN ('tip', 'gift')), 0)::BIGINT AS session_tokens
    FROM sessioned s
    GROUP BY s.sess_id
    HAVING COUNT(*) > 5
      AND EXTRACT(EPOCH FROM MAX(s.message_time) - MIN(s.message_time)) > 300
  )
  SELECT
    ss.start_hour AS hour_jst,
    COUNT(*)::BIGINT AS session_count,
    ROUND(AVG(ss.duration_min), 0) AS avg_duration_min,
    ROUND(AVG(ss.unique_viewers), 1) AS avg_viewers,
    ROUND(AVG(ss.session_tokens::NUMERIC), 0) AS avg_tokens,
    SUM(ss.session_tokens)::BIGINT AS total_tokens,
    ROUND(
      AVG(
        CASE WHEN ss.duration_min > 0
          THEN ss.session_tokens::NUMERIC / (ss.duration_min / 60.0)
          ELSE 0
        END
      ),
      0
    ) AS avg_tokens_per_hour
  FROM session_stats ss
  GROUP BY ss.start_hour
  ORDER BY ss.start_hour;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
