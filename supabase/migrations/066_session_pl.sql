-- ============================================================
-- 066: セッション・月次P/L（損益計算）
-- cast_cost_settings テーブル + get_session_pl / get_monthly_pl RPC
-- ============================================================

-- 1. コスト設定テーブル
CREATE TABLE IF NOT EXISTS cast_cost_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cast_name TEXT NOT NULL,
  hourly_rate INTEGER DEFAULT 0,
  monthly_fixed_cost INTEGER DEFAULT 0,
  platform_fee_rate NUMERIC(5,2) DEFAULT 40.00,
  token_to_jpy NUMERIC(10,4) DEFAULT 5.5,
  bonus_rate NUMERIC(5,2) DEFAULT 0,
  effective_from DATE DEFAULT CURRENT_DATE,
  effective_to DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(account_id, cast_name, effective_from)
);

COMMENT ON TABLE cast_cost_settings IS 'キャスト別コスト設定（時給・手数料率・トークン円換算）';
COMMENT ON COLUMN cast_cost_settings.hourly_rate IS 'キャスト時給（円）';
COMMENT ON COLUMN cast_cost_settings.monthly_fixed_cost IS '月額固定費（円）';
COMMENT ON COLUMN cast_cost_settings.platform_fee_rate IS 'プラットフォーム手数料率（%）';
COMMENT ON COLUMN cast_cost_settings.token_to_jpy IS '1トークン=円（Stripchat: 約5.5円）';
COMMENT ON COLUMN cast_cost_settings.bonus_rate IS 'ボーナス率（%）';

-- RLS
ALTER TABLE cast_cost_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cast_cost_settings_select" ON cast_cost_settings
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));
CREATE POLICY "cast_cost_settings_insert" ON cast_cost_settings
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));
CREATE POLICY "cast_cost_settings_update" ON cast_cost_settings
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));
CREATE POLICY "cast_cost_settings_delete" ON cast_cost_settings
  FOR DELETE USING (account_id IN (SELECT user_account_ids()));

-- ============================================================
-- 2. セッションP/L算出RPC
-- ============================================================
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
  SELECT
    s.session_id,
    s.cast_name,
    s.started_at::DATE AS session_date,
    s.started_at,
    s.ended_at,
    CASE WHEN s.ended_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at))::INTEGER / 60
      ELSE 0
    END AS duration_minutes,
    COALESCE(s.total_tokens, 0)::BIGINT AS total_tokens,
    COALESCE(s.peak_viewers, 0) AS peak_viewers,
    -- 粗売上
    COALESCE(s.total_tokens, 0) * c.token_to_jpy AS gross_revenue_jpy,
    -- 手数料
    COALESCE(s.total_tokens, 0) * c.token_to_jpy * (c.platform_fee_rate / 100) AS platform_fee_jpy,
    -- ネット売上
    COALESCE(s.total_tokens, 0) * c.token_to_jpy * (1 - c.platform_fee_rate / 100) AS net_revenue_jpy,
    -- キャスト費用
    CASE WHEN s.ended_at IS NOT NULL
      THEN (EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600) * c.hourly_rate
      ELSE 0
    END AS cast_cost_jpy,
    -- 粗利
    COALESCE(s.total_tokens, 0) * c.token_to_jpy * (1 - c.platform_fee_rate / 100)
      - CASE WHEN s.ended_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600) * c.hourly_rate
          ELSE 0
        END AS gross_profit_jpy,
    -- 粗利率
    CASE WHEN COALESCE(s.total_tokens, 0) > 0
      THEN ROUND(
        ((COALESCE(s.total_tokens, 0) * c.token_to_jpy * (1 - c.platform_fee_rate / 100)
          - CASE WHEN s.ended_at IS NOT NULL
              THEN (EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600) * c.hourly_rate
              ELSE 0
            END)
        / (COALESCE(s.total_tokens, 0) * c.token_to_jpy)) * 100, 1)
      ELSE 0
    END AS profit_margin,
    c.hourly_rate,
    c.token_to_jpy
  FROM sessions s
  JOIN cast_cost_settings c
    ON c.cast_name = s.cast_name
    AND c.account_id = p_account_id
    AND s.started_at::DATE >= c.effective_from
    AND (c.effective_to IS NULL OR s.started_at::DATE <= c.effective_to)
  WHERE s.account_id = p_account_id
    AND (p_session_id IS NULL OR s.session_id = p_session_id)
    AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
    AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
  ORDER BY s.started_at DESC;
$$ LANGUAGE SQL STABLE;

-- ============================================================
-- 3. 月次P/L集計RPC
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
  SELECT
    TO_CHAR(s.started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS month,
    s.cast_name,
    COUNT(*)::BIGINT AS total_sessions,
    ROUND(SUM(
      CASE WHEN s.ended_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600
        ELSE 0
      END
    )::NUMERIC, 1) AS total_hours,
    COALESCE(SUM(s.total_tokens), 0)::BIGINT AS total_tokens,
    -- 粗売上
    COALESCE(SUM(s.total_tokens), 0) * AVG(c.token_to_jpy) AS gross_revenue_jpy,
    -- 手数料
    COALESCE(SUM(s.total_tokens), 0) * AVG(c.token_to_jpy) * (AVG(c.platform_fee_rate) / 100) AS platform_fee_jpy,
    -- ネット売上
    COALESCE(SUM(s.total_tokens), 0) * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100) AS net_revenue_jpy,
    -- キャスト費用合計
    ROUND(SUM(
      CASE WHEN s.ended_at IS NOT NULL
        THEN (EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600) * c.hourly_rate
        ELSE 0
      END
    )::NUMERIC, 0) AS total_cast_cost_jpy,
    -- 月額固定費
    MAX(c.monthly_fixed_cost) AS monthly_fixed_cost_jpy,
    -- 粗利（ネット売上 - キャスト費用 - 固定費）
    COALESCE(SUM(s.total_tokens), 0) * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100)
      - SUM(
          CASE WHEN s.ended_at IS NOT NULL
            THEN (EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600) * c.hourly_rate
            ELSE 0
          END
        )
      - MAX(c.monthly_fixed_cost) AS gross_profit_jpy,
    -- 粗利率
    CASE WHEN COALESCE(SUM(s.total_tokens), 0) > 0
      THEN ROUND(
        ((COALESCE(SUM(s.total_tokens), 0) * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100)
          - SUM(
              CASE WHEN s.ended_at IS NOT NULL
                THEN (EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600) * c.hourly_rate
                ELSE 0
              END
            )
          - MAX(c.monthly_fixed_cost))
        / (COALESCE(SUM(s.total_tokens), 0) * AVG(c.token_to_jpy))) * 100, 1)
      ELSE 0
    END AS profit_margin
  FROM sessions s
  JOIN cast_cost_settings c
    ON c.cast_name = s.cast_name
    AND c.account_id = p_account_id
    AND s.started_at::DATE >= c.effective_from
    AND (c.effective_to IS NULL OR s.started_at::DATE <= c.effective_to)
  WHERE s.account_id = p_account_id
    AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
    AND s.started_at >= (DATE_TRUNC('month', NOW()) - (p_months || ' months')::INTERVAL)
  GROUP BY TO_CHAR(s.started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM'), s.cast_name
  ORDER BY month DESC, s.cast_name;
$$ LANGUAGE SQL STABLE;
