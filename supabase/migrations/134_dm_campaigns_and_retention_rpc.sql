-- dm_campaigns テーブル: キャンペーンごとのリテンション判定設定
CREATE TABLE IF NOT EXISTS dm_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  campaign_tag TEXT NOT NULL,
  retention_type TEXT NOT NULL DEFAULT 'days',  -- 'next_session' or 'days'
  retention_days INT DEFAULT 14,                -- daysタイプの場合の日数
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, cast_name, campaign_tag)
);

-- キャンペーン別リテンション判定RPC
CREATE OR REPLACE FUNCTION get_campaign_retention(
  p_account_id UUID,
  p_cast_name TEXT,
  p_campaign_tag TEXT,
  p_retention_days INT DEFAULT 14
)
RETURNS TABLE(
  total_sent BIGINT,
  returned_count BIGINT,
  retention_rate NUMERIC,
  earliest_dm TIMESTAMPTZ,
  latest_dm TIMESTAMPTZ,
  period_ended BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH dm_targets AS (
    SELECT DISTINCT ON (dl.user_name) dl.user_name, dl.created_at as dm_sent_at
    FROM dm_send_log dl
    WHERE dl.account_id = p_account_id
      AND dl.cast_name = p_cast_name
      AND dl.status = 'success'
      AND dl.campaign = p_campaign_tag
    ORDER BY dl.user_name, dl.created_at ASC
  ),
  retention AS (
    SELECT dt.user_name, dt.dm_sent_at,
      EXISTS (
        SELECT 1 FROM coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND ct.cast_name = p_cast_name
          AND ct.user_name = dt.user_name
          AND ct.date > dt.dm_sent_at
          AND ct.date <= dt.dm_sent_at + (p_retention_days || ' days')::INTERVAL
          AND ct.type != 'studio'
          AND ct.tokens > 0
      ) AS returned
    FROM dm_targets dt
  )
  SELECT
    COUNT(*)::BIGINT as total_sent,
    COUNT(*) FILTER (WHERE returned)::BIGINT as returned_count,
    ROUND(COUNT(*) FILTER (WHERE returned)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) as retention_rate,
    MIN(dm_sent_at)::TIMESTAMPTZ as earliest_dm,
    MAX(dm_sent_at)::TIMESTAMPTZ as latest_dm,
    (MAX(dm_sent_at) + (p_retention_days || ' days')::INTERVAL < NOW()) as period_ended
  FROM retention;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
