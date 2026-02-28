-- ============================================================
-- 未適用マイグレーション統合適用ファイル
-- 適用順序: 083 → 084 → 085 → 086 → 082
-- 作成日: 2026-02-28
--
-- ■ 内容:
--   083: SPY誤検知アラート既読化
--   084: dm_scenarios/dm_triggers 重複削除 + UNIQUE制約
--   085: paid_users cast_name バックフィル + refresh_segments改修
--   086: sessions.total_tokens カラム追加（082の前提）
--   082: P/L RPCをcoin_transactionsベースに改修
--
-- ■ 適用方法: Supabase SQL Editor にペーストして実行
-- ============================================================


-- ████████████████████████████████████████████████████████████
-- 083: SPY停止中の誤検知アラート既読化
-- ████████████████████████████████████████████████████████████

UPDATE public.alerts
SET is_read = true
WHERE alert_type = 'spy_cast_decline'
  AND (metadata->>'recent_count')::int = 0
  AND is_read = false;


-- ████████████████████████████████████████████████████████████
-- 084: dm_scenarios / dm_triggers 重複削除 + UNIQUE制約
-- ████████████████████████████████████████████████████████████

-- dm_scenarios: 重複の中で古い方を削除
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

ALTER TABLE dm_scenarios
  ADD CONSTRAINT uq_dm_scenarios_account_name
  UNIQUE (account_id, scenario_name);

-- dm_triggers: 重複があれば削除
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

ALTER TABLE dm_triggers
  ADD CONSTRAINT uq_dm_triggers_account_name
  UNIQUE (account_id, trigger_name);


-- ████████████████████████████████████████████████████████████
-- 085: paid_users cast_name バックフィル
-- ████████████████████████████████████████████████████████████

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

-- coin_transactions にもない孤立レコードを削除
DELETE FROM paid_users pu
WHERE (pu.cast_name IS NULL OR pu.cast_name = '')
  AND NOT EXISTS (
    SELECT 1 FROM coin_transactions ct
    WHERE ct.user_name = pu.user_name
      AND ct.account_id = pu.account_id
  );

-- refresh_segments RPC を更新（cast_name NULL 防止バリデーション）
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


-- ████████████████████████████████████████████████████████████
-- 086: sessions テーブル total_tokens カラム追加
-- （082の前提条件）
-- ████████████████████████████████████████████████████████████

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_messages INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_tokens INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS peak_viewers INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cast_name TEXT;

NOTIFY pgrst, 'reload schema';


-- ████████████████████████████████████████████████████████████
-- 082: P/L RPC を coin_transactions ベースに改修
-- ████████████████████████████████████████████████████████████

-- 旧シグネチャをDROP（オーバーロード衝突防止）
DROP FUNCTION IF EXISTS get_monthly_pl(uuid, integer);
DROP FUNCTION IF EXISTS get_session_pl(uuid,text,text,integer);

-- 1. get_monthly_pl
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


-- 2. get_session_pl
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
