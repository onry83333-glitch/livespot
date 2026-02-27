-- ============================================================
-- 078: cast_name フィルタ欠落修正 v2
-- 002_analytics_functions の8 RPC + 026の2 RPC に cast_name 追加
-- ROLLBACK: 各関数を元の引数で再CREATEすれば復旧可
-- ============================================================

-- ─── 1. daily_sales: cast_name オプション追加 ───
CREATE OR REPLACE FUNCTION public.daily_sales(
  p_account_id UUID,
  p_since TEXT,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(date TEXT, tokens BIGINT, tx_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_char(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS date,
        SUM(ct.tokens)::BIGINT AS tokens,
        COUNT(*)::BIGINT AS tx_count
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.date >= p_since::TIMESTAMPTZ
      AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 2. revenue_breakdown: cast_name オプション追加 ───
CREATE OR REPLACE FUNCTION public.revenue_breakdown(
  p_account_id UUID,
  p_since TEXT,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(type TEXT, tokens BIGINT, tx_count BIGINT, pct NUMERIC) AS $$
BEGIN
    RETURN QUERY
    WITH totals AS (
        SELECT SUM(ct.tokens) AS grand_total
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND ct.date >= p_since::TIMESTAMPTZ
          AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
    )
    SELECT
        ct.type,
        SUM(ct.tokens)::BIGINT AS tokens,
        COUNT(*)::BIGINT AS tx_count,
        ROUND(SUM(ct.tokens) * 100.0 / NULLIF(t.grand_total, 0), 1) AS pct
    FROM public.coin_transactions ct, totals t
    WHERE ct.account_id = p_account_id
      AND ct.date >= p_since::TIMESTAMPTZ
      AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
    GROUP BY ct.type, t.grand_total
    ORDER BY tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 3. hourly_revenue: cast_name オプション追加 ───
CREATE OR REPLACE FUNCTION public.hourly_revenue(
  p_account_id UUID,
  p_since TEXT,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(hour_jst INTEGER, tokens BIGINT, tx_count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        EXTRACT(HOUR FROM ct.date AT TIME ZONE 'Asia/Tokyo')::INTEGER AS hour_jst,
        SUM(ct.tokens)::BIGINT AS tokens,
        COUNT(*)::BIGINT AS tx_count
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.date >= p_since::TIMESTAMPTZ
      AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 4. arpu_trend: cast_name オプション追加 ───
CREATE OR REPLACE FUNCTION public.arpu_trend(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(month TEXT, arpu NUMERIC, unique_payers BIGINT, total_tokens BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_char(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
        ROUND(SUM(ct.tokens)::NUMERIC / NULLIF(COUNT(DISTINCT ct.user_name), 0), 1) AS arpu,
        COUNT(DISTINCT ct.user_name)::BIGINT AS unique_payers,
        SUM(ct.tokens)::BIGINT AS total_tokens
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 5. retention_cohort: cast_name オプション追加 ───
-- paying_users MV にcast_nameがないため coin_transactions から直接集計
CREATE OR REPLACE FUNCTION public.retention_cohort(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(last_paid_month TEXT, user_count BIGINT, avg_tokens NUMERIC) AS $$
BEGIN
    RETURN QUERY
    WITH user_summary AS (
        SELECT
            ct.user_name,
            MAX(ct.date) AS last_paid,
            SUM(ct.tokens)::BIGINT AS total_tokens
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
        GROUP BY ct.user_name
    )
    SELECT
        to_char(us.last_paid AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS last_paid_month,
        COUNT(*)::BIGINT AS user_count,
        ROUND(AVG(us.total_tokens), 0) AS avg_tokens
    FROM user_summary us
    GROUP BY 1
    ORDER BY 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 6. revenue_trend: cast_name オプション追加 ───
CREATE OR REPLACE FUNCTION public.revenue_trend(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(month TEXT, type TEXT, tokens BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT
        to_char(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
        ct.type,
        SUM(ct.tokens)::BIGINT AS tokens
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
    GROUP BY 1, 2
    ORDER BY 1, 2;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 7. top_users_detail: cast_name オプション追加 ───
CREATE OR REPLACE FUNCTION public.top_users_detail(
  p_account_id UUID,
  p_limit INTEGER DEFAULT 15,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(
    user_name TEXT,
    total_tokens BIGINT,
    first_paid TIMESTAMPTZ,
    last_paid TIMESTAMPTZ,
    tx_count BIGINT,
    months_active INTEGER,
    primary_type TEXT
) AS $$
BEGIN
    RETURN QUERY
    WITH user_stats AS (
        SELECT
            ct.user_name,
            SUM(ct.tokens)::BIGINT AS total_tokens,
            MIN(ct.date) AS first_paid,
            MAX(ct.date) AS last_paid,
            COUNT(*)::BIGINT AS tx_count,
            (EXTRACT(YEAR FROM AGE(MAX(ct.date), MIN(ct.date))) * 12 +
             EXTRACT(MONTH FROM AGE(MAX(ct.date), MIN(ct.date))))::INTEGER + 1 AS months_active
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
        GROUP BY ct.user_name
        ORDER BY total_tokens DESC
        LIMIT p_limit
    ),
    primary_types AS (
        SELECT DISTINCT ON (ct.user_name)
            ct.user_name,
            ct.type AS primary_type
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
          AND ct.user_name IN (SELECT us.user_name FROM user_stats us)
        GROUP BY ct.user_name, ct.type
        ORDER BY ct.user_name, SUM(ct.tokens) DESC
    )
    SELECT
        us.user_name,
        us.total_tokens,
        us.first_paid,
        us.last_paid,
        us.tx_count,
        us.months_active,
        pt.primary_type
    FROM user_stats us
    LEFT JOIN primary_types pt ON us.user_name = pt.user_name
    ORDER BY us.total_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 8. dm_effectiveness: cast_name オプション追加 ───
CREATE OR REPLACE FUNCTION public.dm_effectiveness(
  p_account_id UUID,
  p_window_days INTEGER DEFAULT 7,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS TABLE(
    campaign TEXT,
    dm_sent_count BIGINT,
    reconverted_count BIGINT,
    conversion_rate NUMERIC,
    reconverted_tokens BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.campaign,
        COUNT(DISTINCT d.user_name)::BIGINT AS dm_sent_count,
        COUNT(DISTINCT c.user_name)::BIGINT AS reconverted_count,
        ROUND(
            COUNT(DISTINCT c.user_name)::NUMERIC * 100.0 /
            NULLIF(COUNT(DISTINCT d.user_name), 0),
            1
        ) AS conversion_rate,
        COALESCE(SUM(c.tokens), 0)::BIGINT AS reconverted_tokens
    FROM public.dm_send_log d
    LEFT JOIN public.coin_transactions c
        ON d.user_name = c.user_name
        AND c.account_id = d.account_id
        AND c.date BETWEEN d.sent_at AND d.sent_at + (p_window_days || ' days')::INTERVAL
        AND c.tokens > 0
        AND (p_cast_name IS NULL OR c.cast_name = p_cast_name)
    WHERE d.account_id = p_account_id
      AND d.status = 'success'
      AND d.campaign IS NOT NULL
      AND d.campaign != ''
      AND (p_cast_name IS NULL OR d.cast_name = p_cast_name)
    GROUP BY d.campaign
    ORDER BY conversion_rate DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 9. detect_churn_risk: paid_users に cast_name フィルタ追加 ───
CREATE OR REPLACE FUNCTION public.detect_churn_risk(
  p_account_id UUID,
  p_cast_name TEXT,
  p_lookback_sessions INT DEFAULT 7,
  p_absence_threshold INT DEFAULT 2
)
RETURNS TABLE (
  username TEXT,
  segment TEXT,
  total_tokens BIGINT,
  attendance_rate NUMERIC,
  last_seen_date TIMESTAMPTZ,
  consecutive_absences INT
) AS $$
BEGIN
  RETURN QUERY
  WITH recent_sessions AS (
    SELECT
      s.session_id,
      s.started_at,
      COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours') AS ended,
      ROW_NUMBER() OVER (ORDER BY s.started_at DESC) AS sess_num
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND COALESCE(s.cast_name, s.title) = p_cast_name
    ORDER BY s.started_at DESC
    LIMIT p_lookback_sessions
  ),
  total_sess_count AS (
    SELECT COUNT(*)::INT AS cnt FROM recent_sessions
  ),
  valuable_users AS (
    SELECT
      pu.user_name AS uname,
      COALESCE(pu.total_coins, 0)::BIGINT AS all_tokens,
      pu.last_payment_date,
      CASE
        WHEN pu.total_coins >= 5000 AND pu.last_payment_date >= NOW() - INTERVAL '7 days'  THEN 'S1'
        WHEN pu.total_coins >= 5000 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S2'
        WHEN pu.total_coins >= 5000 THEN 'S3'
        WHEN pu.total_coins >= 1000 AND pu.last_payment_date >= NOW() - INTERVAL '7 days'  THEN 'S4'
        WHEN pu.total_coins >= 1000 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S5'
        WHEN pu.total_coins >= 1000 THEN 'S6'
        WHEN pu.total_coins >= 300  AND pu.last_payment_date >= NOW() - INTERVAL '30 days' THEN 'S7'
        WHEN pu.total_coins >= 300  THEN 'S8'
        WHEN pu.total_coins >= 50   THEN 'S9'
        ELSE 'S10'
      END AS seg
    FROM public.paid_users pu
    WHERE pu.account_id = p_account_id
      AND pu.cast_name = p_cast_name
      AND pu.total_coins >= 50
  ),
  user_attendance AS (
    SELECT
      vu.uname,
      rs.sess_num,
      EXISTS (
        SELECT 1 FROM public.spy_messages sm
        WHERE sm.account_id = p_account_id
          AND sm.cast_name = p_cast_name
          AND sm.user_name = vu.uname
          AND sm.message_time >= rs.started_at
          AND sm.message_time <= rs.ended
      ) OR EXISTS (
        SELECT 1 FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND ct.user_name = vu.uname
          AND ct.date >= rs.started_at
          AND ct.date <= rs.ended
      ) AS was_present
    FROM valuable_users vu
    CROSS JOIN recent_sessions rs
  ),
  attendance_stats AS (
    SELECT
      ua.uname,
      COUNT(*) FILTER (WHERE ua.was_present)::NUMERIC / NULLIF((SELECT cnt FROM total_sess_count), 0)::NUMERIC AS att_rate,
      MAX(rs2.started_at) FILTER (WHERE ua.was_present) AS last_seen
    FROM user_attendance ua
    JOIN recent_sessions rs2 ON rs2.sess_num = ua.sess_num
    GROUP BY ua.uname
  ),
  consecutive_abs AS (
    SELECT
      ua.uname,
      COALESCE(
        MIN(ua.sess_num) FILTER (WHERE ua.was_present) - 1,
        (SELECT cnt FROM total_sess_count)
      )::INT AS consec_abs
    FROM user_attendance ua
    GROUP BY ua.uname
  )
  SELECT
    vu.uname AS username,
    vu.seg AS segment,
    vu.all_tokens AS total_tokens,
    ROUND(COALESCE(ast.att_rate, 0), 3) AS attendance_rate,
    ast.last_seen AS last_seen_date,
    ca.consec_abs AS consecutive_absences
  FROM valuable_users vu
  JOIN attendance_stats ast ON ast.uname = vu.uname
  JOIN consecutive_abs ca ON ca.uname = vu.uname
  WHERE vu.seg != 'S10'
    AND ast.att_rate > 0.3
    AND ca.consec_abs >= p_absence_threshold
  ORDER BY ca.consec_abs DESC, vu.all_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;

-- ─── 10. get_thankyou_dm_candidates: paid_users に cast_name フィルタ追加 ───
CREATE OR REPLACE FUNCTION public.get_thankyou_dm_candidates(
  p_account_id UUID,
  p_cast_name TEXT,
  p_session_id TEXT DEFAULT NULL,
  p_min_tokens INT DEFAULT 100
)
RETURNS TABLE (
  username TEXT,
  tokens_in_session BIGINT,
  total_tokens BIGINT,
  segment TEXT,
  last_dm_sent_at TIMESTAMPTZ,
  dm_sent_this_session BOOLEAN,
  suggested_template TEXT
) AS $$
DECLARE
  v_session_id TEXT;
  v_session_start TIMESTAMPTZ;
  v_session_end TIMESTAMPTZ;
BEGIN
  IF p_session_id IS NOT NULL THEN
    v_session_id := p_session_id;
  ELSE
    SELECT s.session_id INTO v_session_id
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND COALESCE(s.cast_name, s.title) = p_cast_name
    ORDER BY s.started_at DESC
    LIMIT 1;
  END IF;

  IF v_session_id IS NULL THEN
    RETURN;
  END IF;

  SELECT s.started_at, COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours')
  INTO v_session_start, v_session_end
  FROM public.sessions s
  WHERE s.account_id = p_account_id AND s.session_id = v_session_id;

  IF v_session_start IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH session_tippers AS (
    SELECT
      sm.user_name AS uname,
      COALESCE(SUM(sm.tokens), 0)::BIGINT AS sess_tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = p_cast_name
      AND sm.msg_type IN ('tip', 'gift')
      AND sm.message_time >= v_session_start
      AND sm.message_time <= v_session_end
      AND sm.user_name IS NOT NULL
      AND sm.user_name != ''
      AND sm.tokens > 0
    GROUP BY sm.user_name
    HAVING COALESCE(SUM(sm.tokens), 0) >= p_min_tokens
  ),
  user_totals AS (
    SELECT
      pu.user_name AS uname,
      COALESCE(pu.total_coins, 0)::BIGINT AS all_tokens
    FROM public.paid_users pu
    WHERE pu.account_id = p_account_id
      AND pu.cast_name = p_cast_name
      AND pu.user_name IN (SELECT st.uname FROM session_tippers st)
  ),
  segmented AS (
    SELECT
      st.uname,
      st.sess_tokens,
      COALESCE(ut.all_tokens, st.sess_tokens)::BIGINT AS cumulative_tokens,
      CASE
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 5000 THEN
          CASE WHEN COALESCE(pu_inner.last_payment_date, NOW()) >= NOW() - INTERVAL '7 days' THEN 'S1' ELSE 'S2' END
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 1000 THEN
          CASE WHEN COALESCE(pu_inner.last_payment_date, NOW()) >= NOW() - INTERVAL '90 days' THEN 'S4' ELSE 'S5' END
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 300 THEN
          CASE WHEN COALESCE(pu_inner.last_payment_date, NOW()) >= NOW() - INTERVAL '30 days' THEN 'S7' ELSE 'S8' END
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 50 THEN 'S9'
        ELSE 'S10'
      END AS seg
    FROM session_tippers st
    LEFT JOIN user_totals ut ON ut.uname = st.uname
    LEFT JOIN public.paid_users pu_inner
      ON pu_inner.account_id = p_account_id
      AND pu_inner.cast_name = p_cast_name
      AND pu_inner.user_name = st.uname
  ),
  dm_history AS (
    SELECT
      dl.user_name AS uname,
      MAX(dl.sent_at) AS last_sent,
      BOOL_OR(dl.sent_at >= v_session_start AND dl.sent_at <= v_session_end + INTERVAL '6 hours') AS sent_this_sess
    FROM public.dm_send_log dl
    WHERE dl.account_id = p_account_id
      AND dl.status = 'success'
      AND dl.user_name IN (SELECT sg.uname FROM segmented sg)
    GROUP BY dl.user_name
  )
  SELECT
    sg.uname AS username,
    sg.sess_tokens AS tokens_in_session,
    sg.cumulative_tokens AS total_tokens,
    sg.seg AS segment,
    dh.last_sent AS last_dm_sent_at,
    COALESCE(dh.sent_this_sess, FALSE) AS dm_sent_this_session,
    CASE
      WHEN sg.seg IN ('S1') THEN NULL
      WHEN sg.seg IN ('S2', 'S4') THEN
        sg.uname || 'さん、今日はありがとう😊 すごく嬉しかったです！ また気が向いたら遊びに来てくださいね。 でも無理しないでね😊'
      WHEN sg.seg IN ('S5', 'S7') THEN
        sg.uname || 'さん、今日はありがとう😊 すごく楽しかったです！ 気が向いたらまた遊びに来てくださいね。'
      WHEN sg.seg IN ('S8', 'S9') THEN
        sg.uname || 'さん、ありがとう😊 また会えたら嬉しいです。 あなたの自由だから、気が向いたらね😊'
      ELSE NULL
    END AS suggested_template
  FROM segmented sg
  LEFT JOIN dm_history dh ON dh.uname = sg.uname
  WHERE sg.seg != 'S10'
    AND COALESCE(dh.sent_this_sess, FALSE) = FALSE
  ORDER BY sg.sess_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;
