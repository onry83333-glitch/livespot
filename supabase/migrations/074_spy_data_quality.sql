-- ============================================================
-- 074: SPY データ品質チェック RPC
-- check_spy_data_quality(p_account_id UUID)
-- Returns: JSONB with quality check results + inserts alerts
-- ============================================================

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

  -- ═══ CHECK-1: 欠損ギャップ検出 ═══
  -- 配信中(spy_messagesが直近24h以内にある)キャストで、メッセージ間隔が5分以上のギャップ
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
        AND EXTRACT(EPOCH FROM (message_time - prev_time)) > 300  -- 5min+
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

  -- ═══ CHECK-2: 重複メッセージ検出 ═══
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

  -- 重複が10件超なら critical alert
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

  -- ═══ CHECK-3: 鮮度検出（30分以上データなし） ═══
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
      AND EXTRACT(EPOCH FROM (v_now - MAX(sm.message_time))) > 1800  -- 30min+
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

  -- ═══ CHECK-4: 未登録キャスト検出 ═══
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

  -- ═══ CHECK-5: NULLセッションID検出 ═══
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

  -- ═══ CHECK-6: キャスト別データ量サマリー ═══
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

  -- ═══ CHECK-7: coin_transactions と spy_messages のクロスチェック ═══
  -- spy_messagesでtipが記録されているのにcoin_transactionsにない日
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

  -- ═══ Build result ═══
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

-- 使用例:
-- SELECT jsonb_pretty(check_spy_data_quality());
-- SELECT jsonb_pretty(check_spy_data_quality('940e7248-1d73-4259-a538-56fdaea9d740'));
