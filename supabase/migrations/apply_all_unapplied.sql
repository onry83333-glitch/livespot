-- ============================================================
-- apply_all_unapplied.sql
-- Date: 2026-02-28
-- Combined SQL script for all unapplied Supabase migrations
--
-- Included migrations (in dependency order):
--   1. 074_spy_data_quality.sql
--   2. 078_fix_cast_name_filters_v2.sql
--   3. 079_sync_health.sql
--   4. 080_test_data_management.sql
--   5. 081_tokens_bigint.sql
--   6. 083_cleanup_false_spy_decline_alerts.sql
--   7. 084_dedup_dm_scenarios.sql
--   8. 085_backfill_paid_users_cast_name.sql
--   9. 086_fix_sessions_schema_cache.sql
--  10. 082_fix_monthly_pl_coin_tx.sql (after 086 - depends on sessions.total_tokens)
--  11. 087_dedup_sessions.sql
--  12. 088_close_orphan_sessions.sql
--
-- NOT included:
--   - 080_fix_session_pl_column.sql (superseded by 082)
--
-- ROLLBACK (reverse order):
--   -- 088: UPDATE sessions SET ended_at = NULL WHERE ended_at IS NOT NULL
--   --       AND ended_at > '2026-02-28' AND total_messages IS NULL;
--   --       DROP FUNCTION IF EXISTS close_orphan_sessions(interval);
--   -- 087: DROP INDEX IF EXISTS idx_sessions_one_active_per_cast;
--   -- 082: DROP FUNCTION IF EXISTS get_monthly_pl(UUID, TEXT, INTEGER);
--   --       DROP FUNCTION IF EXISTS get_session_pl(UUID, TEXT, TEXT, INTEGER);
--   --       -- Re-apply 080_fix_session_pl_column.sql if needed
--   -- 086: -- No rollback needed (IF NOT EXISTS + NOTIFY only)
--   -- 085: UPDATE paid_users SET cast_name = NULL;
--   --       -- Re-apply 076 refresh_segments
--   -- 084: ALTER TABLE dm_scenarios DROP CONSTRAINT IF EXISTS uq_dm_scenarios_account_name;
--   --       ALTER TABLE dm_triggers DROP CONSTRAINT IF EXISTS uq_dm_triggers_account_name;
--   -- 083: UPDATE public.alerts SET is_read = false
--   --       WHERE alert_type = 'spy_cast_decline'
--   --         AND (metadata->>'recent_count')::int = 0;
--   -- 081: ALTER TABLE public.coin_transactions ALTER COLUMN tokens TYPE INTEGER;
--   --       ALTER TABLE public.spy_messages ALTER COLUMN tokens TYPE INTEGER;
--   --       ALTER TABLE public.paid_users ALTER COLUMN total_coins TYPE INTEGER;
--   --       ALTER TABLE public.viewer_stats ALTER COLUMN total_tokens TYPE INTEGER;
--   --       -- Re-apply 055_transcript_timeline.sql for get_transcript_timeline
--   -- 080: DROP FUNCTION IF EXISTS count_test_data(UUID, TEXT);
--   --       DROP FUNCTION IF EXISTS delete_test_data(UUID, TEXT);
--   -- 079: DROP FUNCTION IF EXISTS get_sync_health(UUID);
--   --       DROP FUNCTION IF EXISTS upsert_sync_health(UUID, TEXT, TEXT, TEXT, TEXT);
--   --       DROP TABLE IF EXISTS sync_health;
--   -- 078: -- Re-create each function with original signatures (no p_cast_name)
--   -- 074: DROP FUNCTION IF EXISTS check_spy_data_quality(UUID);
--   --       ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
-- ============================================================


-- ############################################################
-- ## 1/12: 074_spy_data_quality.sql
-- ## SPY data quality check RPC + alerts
-- ############################################################

-- alert_type に 'data_quality' を追加
ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
ALTER TABLE public.alerts ADD CONSTRAINT alerts_alert_type_check
  CHECK (alert_type IN (
    'revenue_drop',
    'consecutive_loss',
    'spy_cast_decline',
    'market_trend_change',
    'data_quality'
  ));

-- RPC本体
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

  -- CHECK-1: gap detection
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

  -- CHECK-2: duplicate detection
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

  -- CHECK-3: freshness (30min+)
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

  -- CHECK-4: unregistered casts
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

  -- CHECK-5: NULL session_id
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

  -- CHECK-6: per-cast data volume summary
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

  -- CHECK-7: cross-check spy tips vs coin_transactions
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


-- ############################################################
-- ## 2/12: 078_fix_cast_name_filters_v2.sql
-- ## cast_name filter added to 10 RPC functions
-- ############################################################

-- 1. daily_sales: cast_name option added
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

-- 2. revenue_breakdown: cast_name option added
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

-- 3. hourly_revenue: cast_name option added
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

-- 4. arpu_trend: cast_name option added
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

-- 5. retention_cohort: cast_name option added
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

-- 6. revenue_trend: cast_name option added
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

-- 7. top_users_detail: cast_name option added
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

-- 8. dm_effectiveness: cast_name option added
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

-- 9. detect_churn_risk: paid_users cast_name filter added
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

-- 10. get_thankyou_dm_candidates: paid_users cast_name filter added
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


-- ############################################################
-- ## 3/12: 079_sync_health.sql
-- ## sync_health table + get_sync_health / upsert_sync_health RPCs
-- ############################################################

-- sync_health table
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

-- RLS
ALTER TABLE sync_health ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_health' AND policyname = 'sync_health_select'
  ) THEN
    CREATE POLICY "sync_health_select" ON sync_health
      FOR SELECT USING (account_id IN (SELECT user_account_ids()));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_health' AND policyname = 'sync_health_insert'
  ) THEN
    CREATE POLICY "sync_health_insert" ON sync_health
      FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'sync_health' AND policyname = 'sync_health_update'
  ) THEN
    CREATE POLICY "sync_health_update" ON sync_health
      FOR UPDATE USING (account_id IN (SELECT user_account_ids()));
  END IF;
END $$;

-- updated_at auto-update trigger
CREATE OR REPLACE FUNCTION sync_health_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_health_updated_at ON sync_health;
CREATE TRIGGER trg_sync_health_updated_at
  BEFORE UPDATE ON sync_health
  FOR EACH ROW
  EXECUTE FUNCTION sync_health_updated_at();

-- Realtime (safe: ignore error if already added)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE sync_health;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- RPC: get_sync_health
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

-- RPC: upsert_sync_health
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


-- ############################################################
-- ## 4/12: 080_test_data_management.sql
-- ## Test data count + bulk delete RPCs
-- ############################################################

CREATE OR REPLACE FUNCTION count_test_data(
  p_account_id UUID,
  p_table_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count BIGINT := 0;
  v_breakdown JSONB := '[]'::JSONB;
BEGIN
  IF p_table_name = 'dm_send_log' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::JSONB)
    INTO v_breakdown
    FROM (
      SELECT
        CASE
          WHEN campaign LIKE 'pipe3_bulk_%' THEN 'pipe3_bulk_*'
          WHEN campaign LIKE '20250217_test_%' THEN '20250217_test_*'
          WHEN campaign LIKE 'test_%' THEN 'test_*'
          WHEN campaign LIKE 'bulk_%' THEN 'bulk_*'
        END AS prefix,
        COUNT(*) AS count
      FROM dm_send_log
      WHERE account_id = p_account_id
        AND (
          campaign LIKE 'bulk_%'
          OR campaign LIKE 'pipe3_bulk_%'
          OR campaign LIKE '20250217_test_%'
          OR campaign LIKE 'test_%'
        )
      GROUP BY 1
      ORDER BY count DESC
    ) t;

    SELECT COUNT(*)
    INTO v_count
    FROM dm_send_log
    WHERE account_id = p_account_id
      AND (
        campaign LIKE 'bulk_%'
        OR campaign LIKE 'pipe3_bulk_%'
        OR campaign LIKE '20250217_test_%'
        OR campaign LIKE 'test_%'
      );

  ELSIF p_table_name = 'spy_messages' THEN
    SELECT COUNT(*)
    INTO v_count
    FROM spy_messages
    WHERE account_id = p_account_id
      AND msg_type = 'demo';

    IF v_count > 0 THEN
      v_breakdown := jsonb_build_array(
        jsonb_build_object('prefix', 'msg_type=demo', 'count', v_count)
      );
    END IF;

  ELSIF p_table_name = 'dm_trigger_logs' THEN
    SELECT COUNT(*)
    INTO v_count
    FROM dm_trigger_logs
    WHERE account_id = p_account_id
      AND status = 'error';

    IF v_count > 0 THEN
      v_breakdown := jsonb_build_array(
        jsonb_build_object('prefix', 'status=error', 'count', v_count)
      );
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported table: %', p_table_name;
  END IF;

  RETURN jsonb_build_object(
    'table_name', p_table_name,
    'total_count', v_count,
    'breakdown', v_breakdown
  );
END;
$$;

CREATE OR REPLACE FUNCTION delete_test_data(
  p_account_id UUID,
  p_table_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted BIGINT := 0;
BEGIN
  IF p_table_name = 'dm_send_log' THEN
    WITH deleted AS (
      DELETE FROM dm_send_log
      WHERE account_id = p_account_id
        AND (
          campaign LIKE 'bulk_%'
          OR campaign LIKE 'pipe3_bulk_%'
          OR campaign LIKE '20250217_test_%'
          OR campaign LIKE 'test_%'
        )
      RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted FROM deleted;

  ELSIF p_table_name = 'spy_messages' THEN
    WITH deleted AS (
      DELETE FROM spy_messages
      WHERE account_id = p_account_id
        AND msg_type = 'demo'
      RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted FROM deleted;

  ELSIF p_table_name = 'dm_trigger_logs' THEN
    WITH deleted AS (
      DELETE FROM dm_trigger_logs
      WHERE account_id = p_account_id
        AND status = 'error'
      RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted FROM deleted;

  ELSE
    RAISE EXCEPTION 'Unsupported table: %', p_table_name;
  END IF;

  RETURN jsonb_build_object(
    'table_name', p_table_name,
    'deleted_count', v_deleted
  );
END;
$$;


-- ############################################################
-- ## 5/12: 081_tokens_bigint.sql
-- ## tokens columns INTEGER -> BIGINT conversion
-- ############################################################

-- 1. coin_transactions.tokens
ALTER TABLE public.coin_transactions
  ALTER COLUMN tokens TYPE BIGINT;

-- 2. spy_messages.tokens
ALTER TABLE public.spy_messages
  ALTER COLUMN tokens TYPE BIGINT;

-- 3. paid_users.total_coins
ALTER TABLE public.paid_users
  ALTER COLUMN total_coins TYPE BIGINT;

-- 4. viewer_stats.total_tokens
ALTER TABLE public.viewer_stats
  ALTER COLUMN total_tokens TYPE BIGINT;

-- 5. get_transcript_timeline RPC: tokens return type updated to BIGINT
DROP FUNCTION IF EXISTS public.get_transcript_timeline(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_transcript_timeline(
  p_account_id UUID,
  p_cast_name  TEXT,
  p_session_id TEXT
)
RETURNS TABLE (
  event_time  TIMESTAMPTZ,
  event_type  TEXT,
  user_name   TEXT,
  message     TEXT,
  tokens      BIGINT,
  coin_type   TEXT,
  confidence  NUMERIC,
  elapsed_sec INTEGER,
  is_highlight BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session_start TIMESTAMPTZ;
  v_session_end   TIMESTAMPTZ;
  v_recording_start TIMESTAMPTZ;
BEGIN
  SELECT MIN(sm.message_time), MAX(sm.message_time)
    INTO v_session_start, v_session_end
    FROM public.spy_messages sm
   WHERE sm.account_id = p_account_id
     AND sm.cast_name  = p_cast_name
     AND sm.session_id = p_session_id;

  IF v_session_start IS NULL THEN
    RETURN;
  END IF;

  SELECT ct.recording_started_at
    INTO v_recording_start
    FROM public.cast_transcripts ct
   WHERE ct.account_id = p_account_id
     AND ct.cast_name  = p_cast_name
     AND ct.session_id = p_session_id::UUID
     AND ct.recording_started_at IS NOT NULL
   LIMIT 1;

  RETURN QUERY

  WITH
  transcripts AS (
    SELECT
      COALESCE(
        ct.absolute_start_at,
        CASE WHEN v_recording_start IS NOT NULL AND ct.segment_start_seconds IS NOT NULL
             THEN v_recording_start + (ct.segment_start_seconds || ' seconds')::INTERVAL
             ELSE v_session_start + COALESCE((ct.segment_start_seconds || ' seconds')::INTERVAL, INTERVAL '0')
        END
      ) AS evt_time,
      'transcript'::TEXT AS evt_type,
      NULL::TEXT AS evt_user,
      ct.text AS evt_message,
      0::BIGINT AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      ct.confidence AS evt_confidence
    FROM public.cast_transcripts ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name  = p_cast_name
      AND ct.session_id = p_session_id::UUID
      AND ct.processing_status = 'completed'
  ),

  spy AS (
    SELECT
      sm.message_time AS evt_time,
      CASE
        WHEN sm.tokens > 0 THEN 'tip'
        WHEN sm.msg_type = 'enter' THEN 'enter'
        WHEN sm.msg_type = 'leave' THEN 'leave'
        ELSE 'chat'
      END::TEXT AS evt_type,
      sm.user_name AS evt_user,
      sm.message AS evt_message,
      COALESCE(sm.tokens, 0)::BIGINT AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name  = p_cast_name
      AND sm.session_id = p_session_id
  ),

  coins AS (
    SELECT
      coin.date AS evt_time,
      'coin'::TEXT AS evt_type,
      coin.user_name AS evt_user,
      coin.source_detail AS evt_message,
      coin.tokens AS evt_tokens,
      coin.type AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.coin_transactions coin
    WHERE coin.account_id = p_account_id
      AND coin.cast_name  = p_cast_name
      AND coin.date >= v_session_start - INTERVAL '5 minutes'
      AND coin.date <= v_session_end   + INTERVAL '5 minutes'
  ),

  merged AS (
    SELECT * FROM transcripts
    UNION ALL
    SELECT * FROM spy
    UNION ALL
    SELECT * FROM coins
  ),

  payment_times AS (
    SELECT evt_time
      FROM merged
     WHERE evt_type IN ('tip', 'coin')
       AND evt_tokens > 0
  )

  SELECT
    m.evt_time                              AS event_time,
    m.evt_type                              AS event_type,
    m.evt_user                              AS user_name,
    m.evt_message                           AS message,
    m.evt_tokens                            AS tokens,
    m.evt_coin_type                         AS coin_type,
    m.evt_confidence                        AS confidence,
    EXTRACT(EPOCH FROM (m.evt_time - v_session_start))::INTEGER AS elapsed_sec,
    (m.evt_type = 'transcript' AND EXISTS (
      SELECT 1 FROM payment_times pt
       WHERE pt.evt_time BETWEEN m.evt_time - INTERVAL '30 seconds'
                              AND m.evt_time + INTERVAL '30 seconds'
    ))::BOOLEAN AS is_highlight

  FROM merged m
  ORDER BY m.evt_time ASC, m.evt_type ASC;
END;
$$;

COMMENT ON FUNCTION public.get_transcript_timeline(UUID, TEXT, TEXT)
  IS '文字起こし+チャット+課金を時刻順に統合するタイムラインRPC';


-- ############################################################
-- ## 6/12: 083_cleanup_false_spy_decline_alerts.sql
-- ## Mark false spy_cast_decline alerts as read
-- ############################################################

UPDATE public.alerts
SET is_read = true
WHERE alert_type = 'spy_cast_decline'
  AND (metadata->>'recent_count')::int = 0
  AND is_read = false;


-- ############################################################
-- ## 7/12: 084_dedup_dm_scenarios.sql
-- ## Deduplicate dm_scenarios + dm_triggers, add UNIQUE constraints
-- ############################################################

BEGIN;

-- dm_scenarios: delete older duplicates (keep newest per account_id + scenario_name)
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

-- dm_scenarios: add UNIQUE constraint
ALTER TABLE dm_scenarios
  ADD CONSTRAINT uq_dm_scenarios_account_name
  UNIQUE (account_id, scenario_name);

-- dm_triggers: delete older duplicates
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

-- dm_triggers: add UNIQUE constraint
ALTER TABLE dm_triggers
  ADD CONSTRAINT uq_dm_triggers_account_name
  UNIQUE (account_id, trigger_name);

COMMIT;


-- ############################################################
-- ## 8/12: 085_backfill_paid_users_cast_name.sql
-- ## Backfill NULL cast_name in paid_users + update refresh_segments
-- ############################################################

-- 1. Ensure cast_name column exists
ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- 2. Backfill from coin_transactions (dominant cast per user)
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

-- 3. Delete orphan records (no coin_transactions at all)
DELETE FROM paid_users pu
WHERE (pu.cast_name IS NULL OR pu.cast_name = '')
  AND NOT EXISTS (
    SELECT 1 FROM coin_transactions ct
    WHERE ct.user_name = pu.user_name
      AND ct.account_id = pu.account_id
  );

-- 4. Updated refresh_segments RPC with cast_name NULL prevention
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
  -- Step 1: aggregate per user from coin_transactions
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

  -- Step 2: dynamic thresholds via PERCENTILE_CONT
  SELECT
    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_coins), 5000),
    COALESCE(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY total_coins), 1000),
    COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_coins), 100)
  INTO v_p95, v_p80, v_p50
  FROM _user_agg;

  -- Step 3: determine dominant cast per user (prevent NULL cast_name)
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

  -- Step 4: classify + UPSERT into paid_users
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

  -- Step 5: refresh paying_users materialized view
  REFRESH MATERIALIZED VIEW CONCURRENTLY paying_users;

  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ############################################################
-- ## 9/12: 086_fix_sessions_schema_cache.sql
-- ## Ensure sessions columns exist + reload PostgREST schema cache
-- ############################################################

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_messages INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS peak_viewers INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';


-- ############################################################
-- ## 10/12: 082_fix_monthly_pl_coin_tx.sql
-- ## get_monthly_pl / get_session_pl based on coin_transactions
-- ## (placed after 086 which ensures sessions.total_tokens exists)
-- ############################################################

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


-- ############################################################
-- ## 11/12: 087_dedup_sessions.sql
-- ## Delete duplicate sessions + add partial UNIQUE index
-- ############################################################

BEGIN;

-- Step 1: identify sessions to keep (prioritize those with data, then oldest)
CREATE TEMP TABLE sessions_to_keep AS
WITH ranked AS (
  SELECT
    session_id,
    cast_name,
    account_id,
    started_at,
    ended_at,
    total_messages,
    ROW_NUMBER() OVER (
      PARTITION BY cast_name, account_id, date_trunc('minute', started_at)
      ORDER BY
        CASE WHEN total_messages > 0 OR ended_at IS NOT NULL THEN 0 ELSE 1 END,
        started_at ASC
    ) AS rn
  FROM public.sessions
)
SELECT session_id FROM ranked WHERE rn = 1;

-- Step 2: delete everything not in the keep list
DELETE FROM public.sessions
WHERE session_id NOT IN (SELECT session_id FROM sessions_to_keep);

DROP TABLE sessions_to_keep;

-- Step 3: partial UNIQUE index (one active session per cast per account)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_active_per_cast
  ON public.sessions (cast_name, account_id)
  WHERE ended_at IS NULL;

-- PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';

COMMIT;


-- ############################################################
-- ## 12/12: 088_close_orphan_sessions.sql
-- ## Bulk close orphan sessions + cleanup RPC
-- ############################################################

-- Step 1: bulk close sessions started 24h+ ago that are still open
WITH orphans AS (
  SELECT session_id, started_at
  FROM sessions
  WHERE ended_at IS NULL
    AND started_at < NOW() - INTERVAL '24 hours'
)
UPDATE sessions s
SET ended_at = o.started_at + INTERVAL '4 hours'
FROM orphans o
WHERE s.session_id = o.session_id;

-- Step 2: RPC for Collector startup cleanup
CREATE OR REPLACE FUNCTION close_orphan_sessions(
  p_stale_threshold INTERVAL DEFAULT INTERVAL '6 hours'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_closed INTEGER;
BEGIN
  WITH orphans AS (
    SELECT session_id, started_at
    FROM sessions
    WHERE ended_at IS NULL
      AND started_at < NOW() - p_stale_threshold
  )
  UPDATE sessions s
  SET ended_at = o.started_at + INTERVAL '4 hours'
  FROM orphans o
  WHERE s.session_id = o.session_id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$$;


-- ############################################################
-- ## Done. All 12 migrations applied.
-- ############################################################
