-- ============================================================
-- 068: スコアリングエンジン
-- calc_churn_risk_score / calc_session_quality_score / calc_cast_health_score
-- ============================================================

-- ============================================================
-- 1. ユーザー離脱リスクスコア（0-100、高いほど危険）
-- ============================================================
CREATE OR REPLACE FUNCTION calc_churn_risk_score(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
) RETURNS TABLE(
  user_name TEXT,
  segment TEXT,
  total_coins INTEGER,
  days_since_last_activity INTEGER,
  tip_trend NUMERIC,
  visit_trend NUMERIC,
  churn_risk_score INTEGER
) AS $$
  WITH user_activity AS (
    SELECT
      sm.user_name,
      MAX(sm.message_time) AS last_activity,
      COALESCE(SUM(CASE WHEN sm.message_time > NOW() - INTERVAL '30 days' THEN sm.tokens ELSE 0 END), 0) AS recent_tips,
      COALESCE(SUM(CASE WHEN sm.message_time BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '30 days' THEN sm.tokens ELSE 0 END), 0) AS prev_tips,
      COUNT(DISTINCT CASE WHEN sm.message_time > NOW() - INTERVAL '30 days' THEN sm.message_time::DATE END) AS recent_visits,
      COUNT(DISTINCT CASE WHEN sm.message_time BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '30 days' THEN sm.message_time::DATE END) AS prev_visits
    FROM spy_messages sm
    WHERE sm.account_id = p_account_id
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
      AND sm.user_name IS NOT NULL
      AND sm.message_time > NOW() - INTERVAL '90 days'
    GROUP BY sm.user_name
  )
  SELECT
    ua.user_name,
    COALESCE(pu.segment, 'unknown')::TEXT AS segment,
    COALESCE(pu.total_coins, 0) AS total_coins,
    EXTRACT(DAY FROM NOW() - ua.last_activity)::INTEGER AS days_since_last_activity,
    CASE WHEN ua.prev_tips > 0 THEN ROUND(ua.recent_tips::NUMERIC / ua.prev_tips, 2) ELSE 0 END AS tip_trend,
    CASE WHEN ua.prev_visits > 0 THEN ROUND(ua.recent_visits::NUMERIC / ua.prev_visits, 2) ELSE 0 END AS visit_trend,
    LEAST(100, GREATEST(0,
      (CASE WHEN EXTRACT(DAY FROM NOW() - ua.last_activity) > 30 THEN 40
            WHEN EXTRACT(DAY FROM NOW() - ua.last_activity) > 14 THEN 25
            WHEN EXTRACT(DAY FROM NOW() - ua.last_activity) > 7  THEN 10
            ELSE 0 END)
      + (CASE WHEN ua.prev_tips > 0 AND ua.recent_tips::NUMERIC / ua.prev_tips < 0.3 THEN 30
              WHEN ua.prev_tips > 0 AND ua.recent_tips::NUMERIC / ua.prev_tips < 0.6 THEN 15
              ELSE 0 END)
      + (CASE WHEN ua.prev_visits > 0 AND ua.recent_visits::NUMERIC / ua.prev_visits < 0.3 THEN 30
              WHEN ua.prev_visits > 0 AND ua.recent_visits::NUMERIC / ua.prev_visits < 0.5 THEN 15
              ELSE 0 END)
    ))::INTEGER AS churn_risk_score
  FROM user_activity ua
  LEFT JOIN paid_users pu ON pu.user_name = ua.user_name AND pu.account_id = p_account_id
  WHERE COALESCE(pu.total_coins, 0) >= 10
  ORDER BY churn_risk_score DESC;
$$ LANGUAGE SQL STABLE;

-- ============================================================
-- 2. 配信品質スコア（0-100、高いほど良い）
-- ============================================================
CREATE OR REPLACE FUNCTION calc_session_quality_score(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
) RETURNS TABLE(
  session_id TEXT,
  cast_name TEXT,
  session_date DATE,
  duration_minutes INTEGER,
  peak_viewers INTEGER,
  total_coins INTEGER,
  chat_count BIGINT,
  tip_per_viewer NUMERIC,
  chat_per_minute NUMERIC,
  quality_score INTEGER
) AS $$
  WITH session_chat AS (
    SELECT
      s.session_id,
      s.cast_name,
      s.started_at::DATE AS session_date,
      CASE WHEN s.ended_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INTEGER / 60
        ELSE 0
      END AS duration_minutes,
      COALESCE(s.peak_viewers, 0) AS peak_viewers,
      COALESCE(s.total_coins, 0) AS total_coins,
      COUNT(sm.id) AS chat_count
    FROM sessions s
    LEFT JOIN spy_messages sm
      ON sm.cast_name = s.cast_name
      AND sm.account_id = s.account_id
      AND sm.message_time >= s.started_at
      AND (s.ended_at IS NULL OR sm.message_time <= s.ended_at)
    WHERE s.account_id = p_account_id
      AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
      AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
      AND s.ended_at IS NOT NULL
      AND s.ended_at > s.started_at
    GROUP BY s.session_id, s.cast_name, s.started_at, s.ended_at, s.peak_viewers, s.total_coins
  )
  SELECT
    sc.session_id,
    sc.cast_name,
    sc.session_date,
    sc.duration_minutes,
    sc.peak_viewers,
    sc.total_coins,
    sc.chat_count,
    CASE WHEN sc.peak_viewers > 0
      THEN ROUND(sc.total_coins::NUMERIC / sc.peak_viewers, 1) ELSE 0 END AS tip_per_viewer,
    CASE WHEN sc.duration_minutes > 0
      THEN ROUND(sc.chat_count::NUMERIC / sc.duration_minutes, 1) ELSE 0 END AS chat_per_minute,
    LEAST(100, GREATEST(0,
      -- Duration (max 20pt)
      (CASE WHEN sc.duration_minutes >= 180 THEN 20
            WHEN sc.duration_minutes >= 120 THEN 15
            WHEN sc.duration_minutes >= 60  THEN 10
            WHEN sc.duration_minutes >= 30  THEN 5
            ELSE 0 END)
      -- Viewer engagement (max 25pt)
      + (CASE WHEN sc.peak_viewers >= 100 THEN 25
              WHEN sc.peak_viewers >= 50  THEN 20
              WHEN sc.peak_viewers >= 20  THEN 15
              WHEN sc.peak_viewers >= 10  THEN 10
              WHEN sc.peak_viewers >= 5   THEN 5
              ELSE 0 END)
      -- Revenue per viewer (max 25pt)
      + (CASE WHEN sc.peak_viewers > 0 AND sc.total_coins::NUMERIC / sc.peak_viewers >= 50 THEN 25
              WHEN sc.peak_viewers > 0 AND sc.total_coins::NUMERIC / sc.peak_viewers >= 20 THEN 20
              WHEN sc.peak_viewers > 0 AND sc.total_coins::NUMERIC / sc.peak_viewers >= 10 THEN 15
              WHEN sc.peak_viewers > 0 AND sc.total_coins::NUMERIC / sc.peak_viewers >= 5  THEN 10
              WHEN sc.peak_viewers > 0 AND sc.total_coins::NUMERIC / sc.peak_viewers >= 1  THEN 5
              ELSE 0 END)
      -- Chat activity (max 15pt)
      + (CASE WHEN sc.duration_minutes > 0 AND sc.chat_count::NUMERIC / sc.duration_minutes >= 5 THEN 15
              WHEN sc.duration_minutes > 0 AND sc.chat_count::NUMERIC / sc.duration_minutes >= 2 THEN 10
              WHEN sc.duration_minutes > 0 AND sc.chat_count::NUMERIC / sc.duration_minutes >= 1 THEN 5
              ELSE 0 END)
      -- Revenue absolute (max 15pt)
      + (CASE WHEN sc.total_coins >= 1000 THEN 15
              WHEN sc.total_coins >= 500  THEN 10
              WHEN sc.total_coins >= 100  THEN 5
              ELSE 0 END)
    ))::INTEGER AS quality_score
  FROM session_chat sc
  ORDER BY sc.session_date DESC, quality_score DESC;
$$ LANGUAGE SQL STABLE;

-- ============================================================
-- 3. キャスト健全性スコア
-- ============================================================
CREATE OR REPLACE FUNCTION calc_cast_health_score(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
) RETURNS TABLE(
  cast_name TEXT,
  schedule_consistency INTEGER,
  revenue_trend INTEGER,
  dm_dependency INTEGER,
  broadcast_quality INTEGER,
  independence_risk INTEGER,
  mental_health_flag BOOLEAN,
  overall_health INTEGER
) AS $$
  WITH cast_list AS (
    SELECT DISTINCT s.cast_name
    FROM sessions s
    WHERE s.account_id = p_account_id
      AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
      AND s.started_at >= NOW() - INTERVAL '30 days'
  ),
  session_stats AS (
    SELECT
      s.cast_name,
      COUNT(*) AS cnt_30d,
      COALESCE(STDDEV(EXTRACT(HOUR FROM s.started_at AT TIME ZONE 'Asia/Tokyo')), 99) AS hour_sd,
      COUNT(CASE WHEN s.started_at >= NOW() - INTERVAL '15 days' THEN 1 END) AS recent_cnt,
      COUNT(CASE WHEN s.started_at <  NOW() - INTERVAL '15 days' THEN 1 END) AS prev_cnt,
      COALESCE(SUM(CASE WHEN s.started_at >= NOW() - INTERVAL '15 days' THEN s.total_coins ELSE 0 END), 0) AS recent_rev,
      COALESCE(SUM(CASE WHEN s.started_at <  NOW() - INTERVAL '15 days' THEN s.total_coins ELSE 0 END), 0) AS prev_rev,
      COALESCE(AVG(CASE WHEN s.started_at >= NOW() - INTERVAL '15 days' THEN s.peak_viewers END), 0) AS recent_viewers,
      COALESCE(AVG(CASE WHEN s.started_at <  NOW() - INTERVAL '15 days' THEN s.peak_viewers END), 0) AS prev_viewers,
      COALESCE(AVG(CASE WHEN s.ended_at IS NOT NULL AND s.started_at >= NOW() - INTERVAL '15 days'
        THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))/60 END), 0) AS recent_dur,
      COALESCE(AVG(CASE WHEN s.ended_at IS NOT NULL AND s.started_at < NOW() - INTERVAL '15 days'
        THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))/60 END), 0) AS prev_dur,
      -- Session quality average
      COALESCE(AVG(
        CASE WHEN s.ended_at IS NOT NULL AND s.ended_at > s.started_at THEN
          LEAST(100, GREATEST(0,
            (CASE WHEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))/60 >= 180 THEN 20
                  WHEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))/60 >= 120 THEN 15
                  WHEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))/60 >= 60  THEN 10
                  ELSE 5 END)
            + (CASE WHEN COALESCE(s.peak_viewers,0) >= 50 THEN 25
                    WHEN COALESCE(s.peak_viewers,0) >= 20 THEN 15
                    WHEN COALESCE(s.peak_viewers,0) >= 10 THEN 10
                    ELSE 5 END)
            + (CASE WHEN COALESCE(s.total_coins,0) >= 1000 THEN 25
                    WHEN COALESCE(s.total_coins,0) >= 500  THEN 15
                    WHEN COALESCE(s.total_coins,0) >= 100  THEN 10
                    ELSE 5 END)
          ))
        END
      ), 0) AS avg_quality
    FROM sessions s
    WHERE s.account_id = p_account_id
      AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
      AND s.started_at >= NOW() - INTERVAL '30 days'
    GROUP BY s.cast_name
  ),
  tip_users AS (
    SELECT sm.cast_name, COUNT(DISTINCT sm.user_name) AS tip_user_cnt
    FROM spy_messages sm
    WHERE sm.account_id = p_account_id
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
      AND sm.tokens > 0
      AND sm.message_time >= NOW() - INTERVAL '30 days'
    GROUP BY sm.cast_name
  ),
  dm_driven AS (
    SELECT tu_inner.cast_name, COUNT(DISTINCT tu_inner.user_name) AS dm_tip_cnt
    FROM (
      SELECT DISTINCT sm.cast_name, sm.user_name
      FROM spy_messages sm
      WHERE sm.account_id = p_account_id
        AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
        AND sm.tokens > 0
        AND sm.message_time >= NOW() - INTERVAL '30 days'
    ) tu_inner
    INNER JOIN dm_send_log d
      ON d.user_name = tu_inner.user_name
      AND d.cast_name = tu_inner.cast_name
      AND d.account_id = p_account_id
      AND d.status = 'success'
      AND d.sent_at >= NOW() - INTERVAL '37 days'
    GROUP BY tu_inner.cast_name
  ),
  scores AS (
    SELECT
      cl.cast_name,
      -- Schedule consistency (0-100)
      (CASE WHEN ss.cnt_30d >= 20 AND ss.hour_sd < 3 THEN 90
            WHEN ss.cnt_30d >= 15 AND ss.hour_sd < 5 THEN 75
            WHEN ss.cnt_30d >= 10 THEN 60
            WHEN ss.cnt_30d >= 5  THEN 40
            ELSE 20 END)::INTEGER AS schedule_consistency,
      -- Revenue trend (0-100, 50=flat)
      (CASE WHEN COALESCE(ss.prev_rev, 0) = 0 AND COALESCE(ss.recent_rev, 0) > 0 THEN 80
            WHEN COALESCE(ss.prev_rev, 0) = 0 THEN 50
            WHEN ss.recent_rev::NUMERIC / ss.prev_rev >= 1.5 THEN 90
            WHEN ss.recent_rev::NUMERIC / ss.prev_rev >= 1.1 THEN 70
            WHEN ss.recent_rev::NUMERIC / ss.prev_rev >= 0.9 THEN 50
            WHEN ss.recent_rev::NUMERIC / ss.prev_rev >= 0.5 THEN 30
            ELSE 10 END)::INTEGER AS revenue_trend,
      -- DM dependency (0-100, high = dependent)
      (CASE WHEN COALESCE(tu.tip_user_cnt, 0) = 0 THEN 50
            WHEN COALESCE(dd.dm_tip_cnt, 0)::NUMERIC / tu.tip_user_cnt > 0.7 THEN 85
            WHEN COALESCE(dd.dm_tip_cnt, 0)::NUMERIC / tu.tip_user_cnt > 0.5 THEN 65
            WHEN COALESCE(dd.dm_tip_cnt, 0)::NUMERIC / tu.tip_user_cnt > 0.3 THEN 40
            ELSE 20 END)::INTEGER AS dm_dependency,
      -- Broadcast quality (0-100)
      LEAST(100, GREATEST(0, ROUND(COALESCE(ss.avg_quality, 0))))::INTEGER AS broadcast_quality,
      -- Independence risk (0-100)
      (CASE WHEN COALESCE(ss.prev_rev, 0) = 0 THEN 30
            WHEN ss.recent_rev::NUMERIC / NULLIF(ss.prev_rev, 0) >= 1.3
              AND COALESCE(dd.dm_tip_cnt, 0)::NUMERIC / NULLIF(tu.tip_user_cnt, 0) < 0.3 THEN 80
            WHEN ss.recent_rev::NUMERIC / NULLIF(ss.prev_rev, 0) >= 1.0
              AND COALESCE(dd.dm_tip_cnt, 0)::NUMERIC / NULLIF(tu.tip_user_cnt, 0) < 0.5 THEN 55
            WHEN ss.recent_viewers > ss.prev_viewers * 1.2 THEN 45
            ELSE 20 END)::INTEGER AS independence_risk,
      -- Mental health flag
      (COALESCE(ss.recent_cnt, 0) < COALESCE(ss.prev_cnt, 1) * 0.5
       OR (ss.prev_dur > 60 AND ss.recent_dur < ss.prev_dur * 0.5)
      ) AS mental_health_flag
    FROM cast_list cl
    LEFT JOIN session_stats ss ON ss.cast_name = cl.cast_name
    LEFT JOIN tip_users    tu ON tu.cast_name = cl.cast_name
    LEFT JOIN dm_driven    dd ON dd.cast_name = cl.cast_name
  )
  SELECT
    sc.cast_name,
    sc.schedule_consistency,
    sc.revenue_trend,
    sc.dm_dependency,
    sc.broadcast_quality,
    sc.independence_risk,
    sc.mental_health_flag,
    LEAST(100, GREATEST(0, (
      sc.schedule_consistency * 20
      + sc.revenue_trend * 25
      + (100 - sc.dm_dependency) * 15
      + sc.broadcast_quality * 25
      + (100 - sc.independence_risk) * 15
    ) / 100))::INTEGER AS overall_health
  FROM scores sc
  ORDER BY sc.cast_name;
$$ LANGUAGE SQL STABLE;
