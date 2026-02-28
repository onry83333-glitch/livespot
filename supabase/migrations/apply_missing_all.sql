-- ============================================================
-- 統合マイグレーション: 未適用分のみ（8件）
-- 実行先: Supabase SQL Editor (https://supabase.com/dashboard)
-- 作成日: 2026-02-28
--
-- 適用済み確認済み（スキップ）: 068, 070, 076, 077
-- 本ファイルに含む（未適用確認済み）:
--   074 → 078 → 079 → 082 → 083 → 084 → 085 → 086
--
-- ⚠️ 084 は BEGIN/COMMIT トランザクションを含む。
--    SQL Editor では自動コミットのため、問題なく実行可能。
-- ============================================================


-- ============================================================
-- 074: SPY データ品質チェック RPC
-- ============================================================

ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
ALTER TABLE public.alerts ADD CONSTRAINT alerts_alert_type_check
  CHECK (alert_type IN (
    'revenue_drop',
    'consecutive_loss',
    'spy_cast_decline',
    'market_trend_change',
    'data_quality'
  ));

CREATE OR REPLACE FUNCTION check_spy_data_quality(
  p_account_id UUID DEFAULT '940e7248-1d73-4259-a538-56fdaea9d740'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  res jsonb := '{}'::jsonb;
  v_checks jsonb := '[]'::jsonb;
  v_count bigint;
  v_count2 bigint;
  v_names jsonb;
  v_row record;
  v_gap_details jsonb;
  v_freshness jsonb;
  v_alert_count int := 0;
  v_now timestamptz := NOW();
  v_since timestamptz := v_now - INTERVAL '7 days';
  v_dedup_key text;
  v_today text := to_char(v_now AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD');
BEGIN

  -- CHECK-1: 欠損ギャップ検出
  v_gap_details := '[]'::jsonb;
  FOR v_row IN
    WITH recent_msgs AS (
      SELECT
        cast_name,
        message_time,
        LAG(message_time) OVER (PARTITION BY cast_name ORDER BY message_time) AS prev_time
      FROM spy_messages
      WHERE account_id = p_account_id
        AND message_time >= v_now - INTERVAL '24 hours'
        AND msg_type IN ('chat', 'tip')
    ),
    gaps AS (
      SELECT
        cast_name,
        prev_time AS gap_start,
        message_time AS gap_end,
        EXTRACT(EPOCH FROM (message_time - prev_time)) / 60 AS gap_minutes
      FROM recent_msgs
      WHERE prev_time IS NOT NULL
        AND EXTRACT(EPOCH FROM (message_time - prev_time)) > 300
    )
    SELECT
      cast_name,
      COUNT(*) AS gap_count,
      MAX(gap_minutes) AS max_gap_min,
      AVG(gap_minutes) AS avg_gap_min
    FROM gaps
    GROUP BY cast_name
  LOOP
    v_gap_details := v_gap_details || jsonb_build_object(
      'cast_name', v_row.cast_name,
      'gap_count', v_row.gap_count,
      'max_gap_min', ROUND(v_row.max_gap_min::numeric, 1),
      'avg_gap_min', ROUND(v_row.avg_gap_min::numeric, 1)
    );
  END LOOP;

  SELECT COUNT(*) INTO v_count FROM jsonb_array_elements(v_gap_details);
  v_checks := v_checks || jsonb_build_object(
    'id', 'gap_detection',
    'label', 'メッセージギャップ検出 (5分+)',
    'status', CASE WHEN v_count > 0 THEN 'warn' ELSE 'ok' END,
    'count', v_count,
    'details', v_gap_details
  );

  -- CHECK-2: 重複メッセージ検出
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT cast_name, message_time, user_name, message, COUNT(*) AS cnt
    FROM spy_messages
    WHERE account_id = p_account_id
      AND message_time >= v_since
    GROUP BY cast_name, message_time, user_name, message
    HAVING COUNT(*) > 1
  ) sub;

  SELECT COALESCE(SUM(cnt - 1), 0) INTO v_count2
  FROM (
    SELECT cast_name, message_time, user_name, message, COUNT(*) AS cnt
    FROM spy_messages
    WHERE account_id = p_account_id
      AND message_time >= v_since
    GROUP BY cast_name, message_time, user_name, message
    HAVING COUNT(*) > 1
  ) sub;

  v_checks := v_checks || jsonb_build_object(
    'id', 'duplicate_detection',
    'label', '重複メッセージ検出',
    'status', CASE WHEN v_count2 > 10 THEN 'error' WHEN v_count2 > 0 THEN 'warn' ELSE 'ok' END,
    'count', v_count2,
    'details', jsonb_build_object('duplicate_groups', v_count, 'excess_rows', v_count2)
  );

  IF v_count2 > 10 THEN
    v_dedup_key := 'data_quality_dup_' || v_today;
    IF NOT EXISTS (SELECT 1 FROM alerts WHERE metadata->>'dedup_key' = v_dedup_key) THEN
      INSERT INTO alerts (account_id, alert_type, severity, title, body, metadata)
      VALUES (p_account_id, 'data_quality', 'warning',
        'SPY重複メッセージ: ' || v_count2 || '件',
        '過去7日間でspy_messagesに' || v_count2 || '件の重複行が検出されました。',
        jsonb_build_object('dedup_key', v_dedup_key, 'excess_rows', v_count2, 'groups', v_count)
      );
      v_alert_count := v_alert_count + 1;
    END IF;
  END IF;

  -- CHECK-3: 鮮度検出（30分以上データなし）
  v_freshness := '[]'::jsonb;
  FOR v_row IN
    SELECT
      sc.cast_name,
      MAX(sm.message_time) AS last_msg,
      EXTRACT(EPOCH FROM (v_now - MAX(sm.message_time))) / 60 AS minutes_since
    FROM spy_casts sc
    LEFT JOIN spy_messages sm
      ON sm.cast_name = sc.cast_name
      AND sm.account_id = sc.account_id
      AND sm.message_time >= v_now - INTERVAL '24 hours'
    WHERE sc.account_id = p_account_id
      AND sc.is_active = true
    GROUP BY sc.cast_name
    HAVING MAX(sm.message_time) IS NOT NULL
      AND EXTRACT(EPOCH FROM (v_now - MAX(sm.message_time))) > 1800
  LOOP
    v_freshness := v_freshness || jsonb_build_object(
      'cast_name', v_row.cast_name,
      'last_msg', v_row.last_msg,
      'minutes_since', ROUND(v_row.minutes_since::numeric, 0)
    );
  END LOOP;

  SELECT COUNT(*) INTO v_count FROM jsonb_array_elements(v_freshness);
  v_checks := v_checks || jsonb_build_object(
    'id', 'freshness_detection',
    'label', 'データ鮮度チェック (30分+)',
    'status', CASE WHEN v_count > 3 THEN 'error' WHEN v_count > 0 THEN 'warn' ELSE 'ok' END,
    'count', v_count,
    'details', v_freshness
  );

  -- CHECK-4: 未登録キャスト検出
  SELECT COALESCE(jsonb_agg(DISTINCT sm.cast_name), '[]'::jsonb) INTO v_names
  FROM spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.message_time >= v_since
    AND sm.cast_name IS NOT NULL
    AND sm.cast_name NOT IN (
      SELECT cast_name FROM spy_casts WHERE account_id = p_account_id AND is_active = true
      UNION ALL
      SELECT cast_name FROM registered_casts WHERE account_id = p_account_id AND is_active = true
    );

  SELECT COUNT(*) INTO v_count FROM jsonb_array_elements(v_names);
  v_checks := v_checks || jsonb_build_object(
    'id', 'unregistered_casts',
    'label', '未登録キャスト検出',
    'status', CASE WHEN v_count > 0 THEN 'warn' ELSE 'ok' END,
    'count', v_count,
    'details', v_names
  );

  -- CHECK-5: NULLセッションID検出
  SELECT COUNT(*) INTO v_count
  FROM spy_messages
  WHERE account_id = p_account_id
    AND message_time >= v_since
    AND session_id IS NULL;

  v_checks := v_checks || jsonb_build_object(
    'id', 'null_session_id',
    'label', 'NULL session_id メッセージ',
    'status', CASE WHEN v_count > 50 THEN 'warn' ELSE 'ok' END,
    'count', v_count,
    'details', jsonb_build_object('null_count', v_count)
  );

  -- CHECK-6: キャスト別データ量サマリー
  v_names := '[]'::jsonb;
  FOR v_row IN
    SELECT
      sc.cast_name,
      COUNT(sm.id) AS msg_count,
      COUNT(CASE WHEN sm.msg_type = 'tip' THEN 1 END) AS tip_count,
      COALESCE(SUM(CASE WHEN sm.msg_type = 'tip' THEN sm.tokens ELSE 0 END), 0) AS total_tokens,
      MAX(sm.message_time) AS last_msg
    FROM spy_casts sc
    LEFT JOIN spy_messages sm
      ON sm.cast_name = sc.cast_name
      AND sm.account_id = sc.account_id
      AND sm.message_time >= v_since
    WHERE sc.account_id = p_account_id
      AND sc.is_active = true
    GROUP BY sc.cast_name
    ORDER BY msg_count DESC
  LOOP
    v_names := v_names || jsonb_build_object(
      'cast_name', v_row.cast_name,
      'msg_count', v_row.msg_count,
      'tip_count', v_row.tip_count,
      'total_tokens', v_row.total_tokens,
      'last_msg', v_row.last_msg
    );
  END LOOP;

  v_checks := v_checks || jsonb_build_object(
    'id', 'cast_summary',
    'label', 'キャスト別データ量 (7日間)',
    'status', 'ok',
    'count', (SELECT COUNT(*) FROM spy_casts WHERE account_id = p_account_id AND is_active = true),
    'details', v_names
  );

  -- CHECK-7: coin_transactions と spy_messages のクロスチェック
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT DISTINCT cast_name, DATE(message_time AT TIME ZONE 'Asia/Tokyo') AS d
    FROM spy_messages
    WHERE account_id = p_account_id
      AND msg_type = 'tip'
      AND tokens > 0
      AND message_time >= v_since
  ) spy
  WHERE NOT EXISTS (
    SELECT 1 FROM coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name = spy.cast_name
      AND DATE(ct.date AT TIME ZONE 'Asia/Tokyo') = spy.d
  );

  v_checks := v_checks || jsonb_build_object(
    'id', 'cross_check_coins',
    'label', 'SPY tip vs coin_transactions 整合性',
    'status', CASE WHEN v_count > 3 THEN 'warn' ELSE 'ok' END,
    'count', v_count,
    'details', jsonb_build_object('missing_coin_days', v_count)
  );

  -- Build result
  res := jsonb_build_object(
    'checked_at', v_now,
    'account_id', p_account_id,
    'checks', v_checks,
    'alerts_created', v_alert_count,
    'summary', jsonb_build_object(
      'total_checks', jsonb_array_length(v_checks),
      'ok', (SELECT COUNT(*) FROM jsonb_array_elements(v_checks) el WHERE el->>'status' = 'ok'),
      'warn', (SELECT COUNT(*) FROM jsonb_array_elements(v_checks) el WHERE el->>'status' = 'warn'),
      'error', (SELECT COUNT(*) FROM jsonb_array_elements(v_checks) el WHERE el->>'status' = 'error')
    )
  );

  RETURN res;
END;
$$;


-- ============================================================
-- 078: cast_name フィルタ欠落修正 v2（10 RPC）
-- ============================================================

-- 1. daily_sales
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

-- 2. revenue_breakdown
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

-- 3. hourly_revenue
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

-- 4. arpu_trend
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

-- 5. retention_cohort
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

-- 6. revenue_trend
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

-- 7. top_users_detail
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

-- 8. dm_effectiveness
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

-- 9. detect_churn_risk
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

-- 10. get_thankyou_dm_candidates
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
        sg.uname || 'さん、今日はありがとう。すごく嬉しかったです！ また気が向いたら遊びに来てくださいね。 でも無理しないでね'
      WHEN sg.seg IN ('S5', 'S7') THEN
        sg.uname || 'さん、今日はありがとう。すごく楽しかったです！ 気が向いたらまた遊びに来てくださいね。'
      WHEN sg.seg IN ('S8', 'S9') THEN
        sg.uname || 'さん、ありがとう。また会えたら嬉しいです。 あなたの自由だから、気が向いたらね'
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


-- ============================================================
-- 079: sync_health テーブル + RPC
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_health (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cast_name   TEXT NOT NULL,
  sync_type   TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'unknown',
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(account_id, cast_name, sync_type)
);

ALTER TABLE sync_health ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sync_health' AND policyname = 'sync_health_select') THEN
    CREATE POLICY "sync_health_select" ON sync_health FOR SELECT USING (account_id IN (SELECT user_account_ids()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sync_health' AND policyname = 'sync_health_insert') THEN
    CREATE POLICY "sync_health_insert" ON sync_health FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'sync_health' AND policyname = 'sync_health_update') THEN
    CREATE POLICY "sync_health_update" ON sync_health FOR UPDATE USING (account_id IN (SELECT user_account_ids()));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_health_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_health_updated_at') THEN
    CREATE TRIGGER trg_sync_health_updated_at
      BEFORE UPDATE ON sync_health
      FOR EACH ROW
      EXECUTE FUNCTION sync_health_updated_at();
  END IF;
END $$;

-- Realtime（既に追加済みの場合はエラーを無視）
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE sync_health;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION get_sync_health(p_account_id UUID)
RETURNS TABLE (
  cast_name   TEXT,
  sync_type   TEXT,
  last_sync_at TIMESTAMPTZ,
  status      TEXT,
  error_count INTEGER,
  last_error  TEXT,
  minutes_since_sync NUMERIC,
  auto_status TEXT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    sh.cast_name,
    sh.sync_type,
    sh.last_sync_at,
    sh.status,
    sh.error_count,
    sh.last_error,
    ROUND(EXTRACT(EPOCH FROM (now() - sh.last_sync_at)) / 60, 1) AS minutes_since_sync,
    CASE
      WHEN sh.last_sync_at IS NULL THEN 'unknown'
      WHEN sh.error_count >= 3 THEN 'error'
      WHEN EXTRACT(EPOCH FROM (now() - sh.last_sync_at)) > 7200 THEN 'warn'
      ELSE 'ok'
    END AS auto_status
  FROM sync_health sh
  WHERE sh.account_id = p_account_id
  ORDER BY sh.cast_name, sh.sync_type;
$$;

CREATE OR REPLACE FUNCTION upsert_sync_health(
  p_account_id UUID,
  p_cast_name  TEXT,
  p_sync_type  TEXT,
  p_status     TEXT DEFAULT 'ok',
  p_error      TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO sync_health (account_id, cast_name, sync_type, last_sync_at, status, error_count, last_error)
  VALUES (p_account_id, p_cast_name, p_sync_type, now(), p_status, CASE WHEN p_status = 'error' THEN 1 ELSE 0 END, p_error)
  ON CONFLICT (account_id, cast_name, sync_type)
  DO UPDATE SET
    last_sync_at = now(),
    status = EXCLUDED.status,
    error_count = CASE
      WHEN EXCLUDED.status = 'error' THEN sync_health.error_count + 1
      WHEN EXCLUDED.status = 'ok' THEN 0
      ELSE sync_health.error_count
    END,
    last_error = CASE
      WHEN EXCLUDED.status = 'error' THEN EXCLUDED.last_error
      ELSE sync_health.last_error
    END;
END;
$$;


-- ============================================================
-- 082: get_monthly_pl / get_session_pl を coin_transactions ベースに改修
-- ============================================================

CREATE OR REPLACE FUNCTION get_monthly_pl(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_months INTEGER DEFAULT 6
) RETURNS TABLE(
  month TEXT,
  cast_name TEXT,
  total_sessions BIGINT,
  total_hours NUMERIC,
  total_tokens BIGINT,
  gross_revenue_jpy NUMERIC,
  platform_fee_jpy NUMERIC,
  net_revenue_jpy NUMERIC,
  total_cast_cost_jpy NUMERIC,
  monthly_fixed_cost_jpy INTEGER,
  gross_profit_jpy NUMERIC,
  profit_margin NUMERIC
) AS $$
  WITH
  session_agg AS (
    SELECT
      TO_CHAR(s.started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS s_month,
      s.cast_name AS s_cast,
      COUNT(*)::BIGINT AS s_count,
      ROUND(SUM(
        CASE WHEN s.ended_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600
          ELSE 0
        END
      )::NUMERIC, 1) AS s_hours
    FROM sessions s
    WHERE s.account_id = p_account_id
      AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
      AND s.started_at >= (DATE_TRUNC('month', NOW()) - (p_months || ' months')::INTERVAL)
    GROUP BY 1, 2
  ),
  revenue_agg AS (
    SELECT
      TO_CHAR(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS r_month,
      ct.cast_name AS r_cast,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS r_tokens
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
      AND ct.date >= (DATE_TRUNC('month', NOW()) - (p_months || ' months')::INTERVAL)
      AND ct.tokens > 0
    GROUP BY 1, 2
  ),
  combined AS (
    SELECT
      COALESCE(sa.s_month, ra.r_month) AS c_month,
      COALESCE(sa.s_cast, ra.r_cast) AS c_cast,
      COALESCE(sa.s_count, 0)::BIGINT AS c_sessions,
      COALESCE(sa.s_hours, 0)::NUMERIC AS c_hours,
      COALESCE(ra.r_tokens, 0)::BIGINT AS c_tokens
    FROM session_agg sa
    FULL OUTER JOIN revenue_agg ra
      ON sa.s_month = ra.r_month AND sa.s_cast = ra.r_cast
  )
  SELECT
    cm.c_month AS month,
    cm.c_cast AS cast_name,
    cm.c_sessions AS total_sessions,
    cm.c_hours AS total_hours,
    cm.c_tokens AS total_tokens,
    cm.c_tokens * AVG(c.token_to_jpy) AS gross_revenue_jpy,
    cm.c_tokens * AVG(c.token_to_jpy) * (AVG(c.platform_fee_rate) / 100) AS platform_fee_jpy,
    cm.c_tokens * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100) AS net_revenue_jpy,
    ROUND((cm.c_hours * AVG(c.hourly_rate))::NUMERIC, 0) AS total_cast_cost_jpy,
    MAX(c.monthly_fixed_cost) AS monthly_fixed_cost_jpy,
    cm.c_tokens * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100)
      - (cm.c_hours * AVG(c.hourly_rate))
      - MAX(c.monthly_fixed_cost) AS gross_profit_jpy,
    CASE WHEN cm.c_tokens > 0
      THEN ROUND(
        ((cm.c_tokens * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100)
          - (cm.c_hours * AVG(c.hourly_rate))
          - MAX(c.monthly_fixed_cost))
        / (cm.c_tokens * AVG(c.token_to_jpy))) * 100, 1)
      ELSE 0
    END AS profit_margin
  FROM combined cm
  JOIN cast_cost_settings c
    ON c.cast_name = cm.c_cast
    AND c.account_id = p_account_id
    AND TO_DATE(cm.c_month || '-01', 'YYYY-MM-DD') >= c.effective_from
    AND (c.effective_to IS NULL OR TO_DATE(cm.c_month || '-01', 'YYYY-MM-DD') <= c.effective_to)
  GROUP BY cm.c_month, cm.c_cast, cm.c_sessions, cm.c_hours, cm.c_tokens
  ORDER BY cm.c_month DESC, cm.c_cast;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_session_pl(
  p_account_id UUID,
  p_session_id TEXT DEFAULT NULL,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
) RETURNS TABLE(
  session_id TEXT,
  cast_name TEXT,
  session_date DATE,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  total_tokens BIGINT,
  peak_viewers INTEGER,
  gross_revenue_jpy NUMERIC,
  platform_fee_jpy NUMERIC,
  net_revenue_jpy NUMERIC,
  cast_cost_jpy NUMERIC,
  gross_profit_jpy NUMERIC,
  profit_margin NUMERIC,
  hourly_rate INTEGER,
  token_to_jpy NUMERIC
) AS $$
  WITH session_coins AS (
    SELECT
      s.session_id,
      s.cast_name,
      s.started_at,
      s.ended_at,
      s.peak_viewers,
      COALESCE((
        SELECT SUM(ct.tokens)
        FROM coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND (ct.cast_name = s.cast_name OR ct.cast_name IS NULL)
          AND ct.tokens > 0
          AND ct.date >= s.started_at - INTERVAL '5 minutes'
          AND ct.date <= COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours') + INTERVAL '30 minutes'
      ), COALESCE(s.total_tokens, 0))::BIGINT AS session_tokens
    FROM sessions s
    WHERE s.account_id = p_account_id
      AND (p_session_id IS NULL OR s.session_id = p_session_id)
      AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
      AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
  )
  SELECT
    sc.session_id,
    sc.cast_name,
    sc.started_at::DATE AS session_date,
    sc.started_at,
    sc.ended_at,
    CASE WHEN sc.ended_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at))::INTEGER / 60
      ELSE 0
    END AS duration_minutes,
    sc.session_tokens AS total_tokens,
    COALESCE(sc.peak_viewers, 0) AS peak_viewers,
    sc.session_tokens * c.token_to_jpy AS gross_revenue_jpy,
    sc.session_tokens * c.token_to_jpy * (c.platform_fee_rate / 100) AS platform_fee_jpy,
    sc.session_tokens * c.token_to_jpy * (1 - c.platform_fee_rate / 100) AS net_revenue_jpy,
    CASE WHEN sc.ended_at IS NOT NULL
      THEN (EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at)) / 3600) * c.hourly_rate
      ELSE 0
    END AS cast_cost_jpy,
    sc.session_tokens * c.token_to_jpy * (1 - c.platform_fee_rate / 100)
      - CASE WHEN sc.ended_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at)) / 3600) * c.hourly_rate
          ELSE 0
        END AS gross_profit_jpy,
    CASE WHEN sc.session_tokens > 0
      THEN ROUND(
        ((sc.session_tokens * c.token_to_jpy * (1 - c.platform_fee_rate / 100)
          - CASE WHEN sc.ended_at IS NOT NULL
              THEN (EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at)) / 3600) * c.hourly_rate
              ELSE 0
            END)
        / (sc.session_tokens * c.token_to_jpy)) * 100, 1)
      ELSE 0
    END AS profit_margin,
    c.hourly_rate,
    c.token_to_jpy
  FROM session_coins sc
  JOIN cast_cost_settings c
    ON c.cast_name = sc.cast_name
    AND c.account_id = p_account_id
    AND sc.started_at::DATE >= c.effective_from
    AND (c.effective_to IS NULL OR sc.started_at::DATE <= c.effective_to)
  ORDER BY sc.started_at DESC;
$$ LANGUAGE SQL STABLE;


-- ============================================================
-- 083: 誤検知SPYアラート既読化
-- ============================================================

UPDATE public.alerts
SET is_read = true
WHERE alert_type = 'spy_cast_decline'
  AND (metadata->>'recent_count')::int = 0
  AND is_read = false;


-- ============================================================
-- 084: dm_scenarios / dm_triggers 重複削除 + UNIQUE制約
-- ============================================================

-- dm_scenarios: 重複削除（最新を残す）
DELETE FROM dm_scenarios
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY account_id, scenario_name
             ORDER BY created_at DESC
           ) AS rn
    FROM dm_scenarios
  ) ranked
  WHERE rn > 1
);

-- dm_scenarios: UNIQUE制約追加
DO $$ BEGIN
  ALTER TABLE dm_scenarios
    ADD CONSTRAINT uq_dm_scenarios_account_name
    UNIQUE (account_id, scenario_name);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

-- dm_triggers: 重複削除
DELETE FROM dm_triggers
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY account_id, trigger_name
             ORDER BY created_at DESC
           ) AS rn
    FROM dm_triggers
  ) ranked
  WHERE rn > 1
);

-- dm_triggers: UNIQUE制約追加
DO $$ BEGIN
  ALTER TABLE dm_triggers
    ADD CONSTRAINT uq_dm_triggers_account_name
    UNIQUE (account_id, trigger_name);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;


-- ============================================================
-- 085: paid_users cast_name NULL バックフィル
-- ============================================================

ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- coin_transactions から最多課金キャストを特定してバックフィル
WITH dominant_cast AS (
  SELECT DISTINCT ON (account_id, user_name)
    account_id,
    user_name,
    cast_name
  FROM (
    SELECT
      account_id,
      user_name,
      cast_name,
      SUM(tokens) AS total_tokens
    FROM coin_transactions
    WHERE cast_name IS NOT NULL
      AND cast_name != ''
      AND tokens > 0
    GROUP BY account_id, user_name, cast_name
    ORDER BY account_id, user_name, SUM(tokens) DESC
  ) ranked
)
UPDATE paid_users pu
SET cast_name = dc.cast_name,
    updated_at = NOW()
FROM dominant_cast dc
WHERE pu.account_id = dc.account_id
  AND pu.user_name = dc.user_name
  AND (pu.cast_name IS NULL OR pu.cast_name = '');

-- coin_transactions にもない孤立レコード削除
DELETE FROM paid_users pu
WHERE (pu.cast_name IS NULL OR pu.cast_name = '')
  AND NOT EXISTS (
    SELECT 1 FROM coin_transactions ct
    WHERE ct.user_name = pu.user_name
      AND ct.account_id = pu.account_id
  );

-- refresh_segments RPC 更新（cast_name NULL 防止）
CREATE OR REPLACE FUNCTION refresh_segments(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER := 0;
  v_p95 NUMERIC;
  v_p80 NUMERIC;
  v_p50 NUMERIC;
BEGIN
  CREATE TEMP TABLE _target_users ON COMMIT DROP AS
  SELECT DISTINCT user_name
  FROM coin_transactions
  WHERE account_id = p_account_id
    AND tokens > 0
    AND (p_cast_name IS NULL OR cast_name = p_cast_name);

  CREATE TEMP TABLE _user_agg ON COMMIT DROP AS
  SELECT
    ct.account_id,
    ct.user_name,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.tokens > 0), 0)::INTEGER AS total_coins,
    COUNT(*) FILTER (WHERE ct.tokens > 0)::INTEGER AS tx_count,
    MIN(ct.date) AS first_paid,
    MAX(ct.date) AS last_paid
  FROM coin_transactions ct
  INNER JOIN _target_users tu ON tu.user_name = ct.user_name
  WHERE ct.account_id = p_account_id
    AND ct.tokens > 0
    AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
  GROUP BY ct.account_id, ct.user_name;

  SELECT
    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_coins), 5000),
    COALESCE(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY total_coins), 1000),
    COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_coins), 100)
  INTO v_p95, v_p80, v_p50
  FROM _user_agg;

  CREATE TEMP TABLE _user_dominant_cast ON COMMIT DROP AS
  SELECT DISTINCT ON (account_id, user_name)
    account_id,
    user_name,
    cast_name
  FROM (
    SELECT
      ct2.account_id,
      ct2.user_name,
      ct2.cast_name,
      SUM(ct2.tokens) AS cast_tokens
    FROM coin_transactions ct2
    INNER JOIN _target_users tu2 ON tu2.user_name = ct2.user_name
    WHERE ct2.account_id = p_account_id
      AND ct2.tokens > 0
      AND ct2.cast_name IS NOT NULL
      AND ct2.cast_name != ''
    GROUP BY ct2.account_id, ct2.user_name, ct2.cast_name
    ORDER BY ct2.account_id, ct2.user_name, SUM(ct2.tokens) DESC
  ) sub;

  WITH classified AS (
    SELECT
      ua.account_id,
      ua.user_name,
      ua.total_coins,
      ua.tx_count,
      ua.first_paid,
      ua.last_paid,
      COALESCE(p_cast_name, udc.cast_name) AS resolved_cast_name,
      CASE
        WHEN ua.last_paid < NOW() - INTERVAL '90 days' THEN 'churned'
        WHEN ua.first_paid >= NOW() - INTERVAL '30 days'
             AND ua.total_coins < v_p50 THEN 'new'
        WHEN ua.total_coins >= v_p95 THEN 'whale'
        WHEN ua.total_coins >= v_p80 THEN 'vip'
        WHEN ua.total_coins >= v_p50 THEN 'regular'
        ELSE 'light'
      END AS segment
    FROM _user_agg ua
    LEFT JOIN _user_dominant_cast udc
      ON udc.account_id = ua.account_id AND udc.user_name = ua.user_name
  )
  INSERT INTO paid_users (
    account_id, user_name, total_coins, last_payment_date,
    segment, tx_count, first_payment_date, cast_name, updated_at
  )
  SELECT
    account_id, user_name, total_coins, last_paid,
    segment, tx_count, first_paid, resolved_cast_name, NOW()
  FROM classified
  ON CONFLICT (account_id, user_name)
  DO UPDATE SET
    total_coins = EXCLUDED.total_coins,
    last_payment_date = EXCLUDED.last_payment_date,
    segment = EXCLUDED.segment,
    tx_count = EXCLUDED.tx_count,
    first_payment_date = EXCLUDED.first_payment_date,
    cast_name = COALESCE(EXCLUDED.cast_name, paid_users.cast_name),
    updated_at = NOW();

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  REFRESH MATERIALIZED VIEW CONCURRENTLY paying_users;

  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- 086: sessions テーブル スキーマキャッシュ修正
-- ============================================================

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_messages INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS peak_viewers INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cast_name TEXT;

NOTIFY pgrst, 'reload schema';


-- ============================================================
-- 完了メッセージ
-- ============================================================
DO $$ BEGIN RAISE NOTICE '=== 8件のMigration適用完了 (074, 078, 079, 082, 083, 084, 085, 086) ==='; END $$;
