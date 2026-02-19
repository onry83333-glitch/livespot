-- ============================================================
-- 018: DM Campaign CVR (Conversion Rate) RPC
-- DMキャンペーン別のCVR・収益を集計
-- ============================================================

CREATE OR REPLACE FUNCTION get_dm_campaign_cvr(
  p_account_id UUID DEFAULT NULL,
  p_cast_name TEXT DEFAULT NULL,
  p_since DATE DEFAULT (CURRENT_DATE - INTERVAL '90 days')::date
)
RETURNS TABLE(
  campaign TEXT,
  dm_sent BIGINT,
  paid_after BIGINT,
  cvr_pct NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_payer NUMERIC,
  first_sent TIMESTAMPTZ,
  last_sent TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    dsl.campaign,
    COUNT(DISTINCT dsl.user_name)                                               AS dm_sent,
    COUNT(DISTINCT ct.user_name)                                                AS paid_after,
    ROUND(
      COUNT(DISTINCT ct.user_name)::numeric
      / NULLIF(COUNT(DISTINCT dsl.user_name), 0) * 100, 1
    )                                                                           AS cvr_pct,
    COALESCE(SUM(ct.tokens), 0)::BIGINT                                         AS total_tokens,
    ROUND(
      COALESCE(SUM(ct.tokens), 0)::numeric
      / NULLIF(COUNT(DISTINCT ct.user_name), 0), 0
    )                                                                           AS avg_tokens_per_payer,
    MIN(dsl.queued_at)                                                          AS first_sent,
    MAX(dsl.sent_at)                                                            AS last_sent
  FROM dm_send_log dsl
  LEFT JOIN coin_transactions ct
    ON  ct.user_name = dsl.user_name
    AND ct.date > dsl.queued_at
    AND (p_account_id IS NULL OR ct.account_id = p_account_id)
    AND (p_cast_name  IS NULL OR ct.cast_name  = p_cast_name)
  WHERE dsl.queued_at >= p_since
    AND (p_account_id IS NULL OR dsl.account_id = p_account_id)
    AND dsl.campaign IS NOT NULL
    AND dsl.campaign != ''
    AND dsl.status = 'success'
  GROUP BY dsl.campaign
  ORDER BY cvr_pct DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql;
