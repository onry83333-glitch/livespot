-- ============================================================
-- 統合マイグレーション: 未適用6件（074/079/083/084/085/086/082）
-- 作成日: 2026-02-28
--
-- 適用順序:
--   074 → 079 → 083 → 084 → 085 → 086 → 082
--
-- 適用方法:
--   1. npx supabase db push --db-url "postgresql://postgres.ujgbhkllfeacbgpdbjto:[PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
--   2. または Supabase SQL Editor にペーストして実行
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS check_spy_data_quality(UUID);
--   DROP FUNCTION IF EXISTS get_sync_health(UUID);
--   DROP FUNCTION IF EXISTS upsert_sync_health(UUID, TEXT, TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS sync_health;
--   -- 083/084/085 はデータ変更のため元に戻せない
--   ALTER TABLE sessions DROP COLUMN IF EXISTS total_tokens;
--   -- 082 は 066+080 を再適用
-- ============================================================


-- ████████████████████████████████████████████████████████████████
-- 074: SPY データ品質チェック RPC
-- ████████████████████████████████████████████████████████████████

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

  -- CHECK-1: 欠損ギャップ検出（5分以上の空白）
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
    WHERE account_id = p_account_id AND message_time >= v_since
    GROUP BY cast_name, message_time, user_name, message
    HAVING COUNT(*) > 1
  ) sub;

  SELECT COALESCE(SUM(cnt - 1), 0) INTO v_count2
  FROM (
    SELECT cast_name, message_time, user_name, message, COUNT(*) AS cnt
    FROM spy_messages
    WHERE account_id = p_account_id AND message_time >= v_since
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
    WHERE sc.account_id = p_account_id AND sc.is_active = true
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
  WHERE account_id = p_account_id AND message_time >= v_since AND session_id IS NULL;

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
      ON sm.cast_name = sc.cast_name AND sm.account_id = sc.account_id AND sm.message_time >= v_since
    WHERE sc.account_id = p_account_id AND sc.is_active = true
    GROUP BY sc.cast_name ORDER BY msg_count DESC
  LOOP
    v_names := v_names || jsonb_build_object(
      'cast_name', v_row.cast_name, 'msg_count', v_row.msg_count,
      'tip_count', v_row.tip_count, 'total_tokens', v_row.total_tokens, 'last_msg', v_row.last_msg
    );
  END LOOP;

  v_checks := v_checks || jsonb_build_object(
    'id', 'cast_summary', 'label', 'キャスト別データ量 (7日間)', 'status', 'ok',
    'count', (SELECT COUNT(*) FROM spy_casts WHERE account_id = p_account_id AND is_active = true),
    'details', v_names
  );

  -- CHECK-7: coin_transactions と spy_messages のクロスチェック
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT DISTINCT cast_name, DATE(message_time AT TIME ZONE 'Asia/Tokyo') AS d
    FROM spy_messages
    WHERE account_id = p_account_id AND msg_type = 'tip' AND tokens > 0 AND message_time >= v_since
  ) spy
  WHERE NOT EXISTS (
    SELECT 1 FROM coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = spy.cast_name
      AND DATE(ct.date AT TIME ZONE 'Asia/Tokyo') = spy.d
  );

  v_checks := v_checks || jsonb_build_object(
    'id', 'cross_check_coins', 'label', 'SPY tip vs coin_transactions 整合性',
    'status', CASE WHEN v_count > 3 THEN 'warn' ELSE 'ok' END,
    'count', v_count, 'details', jsonb_build_object('missing_coin_days', v_count)
  );

  res := jsonb_build_object(
    'checked_at', v_now, 'account_id', p_account_id, 'checks', v_checks,
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


-- ████████████████████████████████████████████████████████████████
-- 079: sync_health テーブル + RPC
-- ████████████████████████████████████████████████████████████████

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
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_health_updated_at ON sync_health;
CREATE TRIGGER trg_sync_health_updated_at
  BEFORE UPDATE ON sync_health FOR EACH ROW EXECUTE FUNCTION sync_health_updated_at();

-- Realtime（すでに追加済みの場合はエラーになるが無害）
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE sync_health;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION get_sync_health(p_account_id UUID)
RETURNS TABLE (
  cast_name TEXT, sync_type TEXT, last_sync_at TIMESTAMPTZ,
  status TEXT, error_count INTEGER, last_error TEXT,
  minutes_since_sync NUMERIC, auto_status TEXT
) LANGUAGE sql STABLE AS $$
  SELECT sh.cast_name, sh.sync_type, sh.last_sync_at, sh.status,
    sh.error_count, sh.last_error,
    ROUND(EXTRACT(EPOCH FROM (now() - sh.last_sync_at)) / 60, 1),
    CASE
      WHEN sh.last_sync_at IS NULL THEN 'unknown'
      WHEN sh.error_count >= 3 THEN 'error'
      WHEN EXTRACT(EPOCH FROM (now() - sh.last_sync_at)) > 7200 THEN 'warn'
      ELSE 'ok'
    END
  FROM sync_health sh WHERE sh.account_id = p_account_id
  ORDER BY sh.cast_name, sh.sync_type;
$$;

CREATE OR REPLACE FUNCTION upsert_sync_health(
  p_account_id UUID, p_cast_name TEXT, p_sync_type TEXT,
  p_status TEXT DEFAULT 'ok', p_error TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_health (account_id, cast_name, sync_type, last_sync_at, status, error_count, last_error)
  VALUES (p_account_id, p_cast_name, p_sync_type, now(), p_status,
    CASE WHEN p_status = 'error' THEN 1 ELSE 0 END, p_error)
  ON CONFLICT (account_id, cast_name, sync_type)
  DO UPDATE SET
    last_sync_at = now(), status = EXCLUDED.status,
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


-- ████████████████████████████████████████████████████████████████
-- 083: SPY停止中の誤検知アラート既読化
-- ████████████████████████████████████████████████████████████████

UPDATE public.alerts
SET is_read = true
WHERE alert_type = 'spy_cast_decline'
  AND (metadata->>'recent_count')::int = 0
  AND is_read = false;


-- ████████████████████████████████████████████████████████████████
-- 084: dm_scenarios / dm_triggers 重複削除 + UNIQUE制約
-- ████████████████████████████████████████████████████████████████

DELETE FROM dm_scenarios
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, scenario_name ORDER BY created_at DESC) AS rn
    FROM dm_scenarios
  ) ranked WHERE rn > 1
);

DO $$ BEGIN
  ALTER TABLE dm_scenarios ADD CONSTRAINT uq_dm_scenarios_account_name UNIQUE (account_id, scenario_name);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DELETE FROM dm_triggers
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, trigger_name ORDER BY created_at DESC) AS rn
    FROM dm_triggers
  ) ranked WHERE rn > 1
);

DO $$ BEGIN
  ALTER TABLE dm_triggers ADD CONSTRAINT uq_dm_triggers_account_name UNIQUE (account_id, trigger_name);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;


-- ████████████████████████████████████████████████████████████████
-- 085: paid_users cast_name バックフィル + refresh_segments改修
-- ████████████████████████████████████████████████████████████████

ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- coin_transactions から最多課金キャストを特定してバックフィル
WITH dominant_cast AS (
  SELECT DISTINCT ON (account_id, user_name)
    account_id, user_name, cast_name
  FROM (
    SELECT account_id, user_name, cast_name, SUM(tokens) AS total_tokens
    FROM coin_transactions
    WHERE cast_name IS NOT NULL AND cast_name != '' AND tokens > 0
    GROUP BY account_id, user_name, cast_name
    ORDER BY account_id, user_name, SUM(tokens) DESC
  ) ranked
)
UPDATE paid_users pu
SET cast_name = dc.cast_name, updated_at = NOW()
FROM dominant_cast dc
WHERE pu.account_id = dc.account_id
  AND pu.user_name = dc.user_name
  AND (pu.cast_name IS NULL OR pu.cast_name = '');

-- coin_transactions にもない孤立レコードを削除
DELETE FROM paid_users pu
WHERE (pu.cast_name IS NULL OR pu.cast_name = '')
  AND NOT EXISTS (
    SELECT 1 FROM coin_transactions ct
    WHERE ct.user_name = pu.user_name AND ct.account_id = pu.account_id
  );

-- refresh_segments RPC を更新（cast_name NULL 防止）
CREATE OR REPLACE FUNCTION refresh_segments(
  p_account_id UUID, p_cast_name TEXT DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER := 0;
  v_p95 NUMERIC; v_p80 NUMERIC; v_p50 NUMERIC;
BEGIN
  CREATE TEMP TABLE _target_users ON COMMIT DROP AS
  SELECT DISTINCT user_name FROM coin_transactions
  WHERE account_id = p_account_id AND tokens > 0
    AND (p_cast_name IS NULL OR cast_name = p_cast_name);

  CREATE TEMP TABLE _user_agg ON COMMIT DROP AS
  SELECT ct.account_id, ct.user_name,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.tokens > 0), 0)::INTEGER AS total_coins,
    COUNT(*) FILTER (WHERE ct.tokens > 0)::INTEGER AS tx_count,
    MIN(ct.date) AS first_paid, MAX(ct.date) AS last_paid
  FROM coin_transactions ct
  INNER JOIN _target_users tu ON tu.user_name = ct.user_name
  WHERE ct.account_id = p_account_id AND ct.tokens > 0
    AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
  GROUP BY ct.account_id, ct.user_name;

  SELECT
    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_coins), 5000),
    COALESCE(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY total_coins), 1000),
    COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_coins), 100)
  INTO v_p95, v_p80, v_p50
  FROM _user_agg;

  CREATE TEMP TABLE _user_dominant_cast ON COMMIT DROP AS
  SELECT DISTINCT ON (account_id, user_name) account_id, user_name, cast_name
  FROM (
    SELECT ct2.account_id, ct2.user_name, ct2.cast_name, SUM(ct2.tokens) AS cast_tokens
    FROM coin_transactions ct2
    INNER JOIN _target_users tu2 ON tu2.user_name = ct2.user_name
    WHERE ct2.account_id = p_account_id AND ct2.tokens > 0
      AND ct2.cast_name IS NOT NULL AND ct2.cast_name != ''
    GROUP BY ct2.account_id, ct2.user_name, ct2.cast_name
    ORDER BY ct2.account_id, ct2.user_name, SUM(ct2.tokens) DESC
  ) sub;

  WITH classified AS (
    SELECT ua.account_id, ua.user_name, ua.total_coins, ua.tx_count,
      ua.first_paid, ua.last_paid,
      COALESCE(p_cast_name, udc.cast_name) AS resolved_cast_name,
      CASE
        WHEN ua.last_paid < NOW() - INTERVAL '90 days' THEN 'churned'
        WHEN ua.first_paid >= NOW() - INTERVAL '30 days' AND ua.total_coins < v_p50 THEN 'new'
        WHEN ua.total_coins >= v_p95 THEN 'whale'
        WHEN ua.total_coins >= v_p80 THEN 'vip'
        WHEN ua.total_coins >= v_p50 THEN 'regular'
        ELSE 'light'
      END AS segment
    FROM _user_agg ua
    LEFT JOIN _user_dominant_cast udc ON udc.account_id = ua.account_id AND udc.user_name = ua.user_name
  )
  INSERT INTO paid_users (
    account_id, user_name, total_coins, last_payment_date,
    segment, tx_count, first_payment_date, cast_name, updated_at
  )
  SELECT account_id, user_name, total_coins, last_paid,
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


-- ████████████████████████████████████████████████████████████████
-- 086: sessions テーブル total_tokens カラム追加（082の前提）
-- ████████████████████████████████████████████████████████████████

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0;

-- total_coins の既存データを total_tokens にバックフィル
UPDATE public.sessions
SET total_tokens = total_coins
WHERE total_tokens = 0 AND total_coins > 0;

NOTIFY pgrst, 'reload schema';


-- ████████████████████████████████████████████████████████████████
-- 082: P/L RPC を coin_transactions ベースに改修
-- まず旧版をDROPしてから新版をCREATE
-- ████████████████████████████████████████████████████████████████

-- 旧版 get_monthly_pl (引数2つ版が存在する場合) をDROP
DROP FUNCTION IF EXISTS get_monthly_pl(UUID, INTEGER);
-- 旧版 get_monthly_pl (引数3つ版) もDROP（CREATE OR REPLACEで戻り値変更不可のため）
DROP FUNCTION IF EXISTS get_monthly_pl(UUID, TEXT, INTEGER);

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
    FULL OUTER JOIN revenue_agg ra ON sa.s_month = ra.r_month AND sa.s_cast = ra.r_cast
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


-- 旧版 get_session_pl をDROP
DROP FUNCTION IF EXISTS get_session_pl(UUID, TEXT, TEXT, INTEGER);

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
      s.session_id::TEXT,
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
      AND (p_session_id IS NULL OR s.session_id::TEXT = p_session_id)
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


-- ████████████████████████████████████████████████████████████████
-- スキーマキャッシュリロード
-- ████████████████████████████████████████████████████████████████
NOTIFY pgrst, 'reload schema';
