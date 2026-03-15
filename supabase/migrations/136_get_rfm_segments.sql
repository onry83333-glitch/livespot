-- RFMセグメント分析RPC
CREATE OR REPLACE FUNCTION get_rfm_segments(
  p_account_id UUID,
  p_cast_name TEXT,
  p_start_date DATE DEFAULT '2025-02-15',
  p_end_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  user_name TEXT,
  recency_days INT,
  frequency INT,
  monetary BIGINT,
  r_score INT,
  f_score INT,
  m_score INT,
  rfm_total INT,
  segment TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      ct.user_name,
      (CURRENT_DATE - MAX(ct.date)::DATE)::INT AS recency_days,
      COUNT(DISTINCT ct.date::DATE)::INT AS frequency,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS monetary
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name = p_cast_name
      AND ct.type != 'studio'
      AND ct.tokens > 0
      AND ct.user_name != 'anonymous'
      AND ct.date::DATE >= p_start_date
      AND ct.date::DATE <= p_end_date
    GROUP BY ct.user_name
  ),
  scored AS (
    SELECT
      b.*,
      NTILE(5) OVER (ORDER BY b.recency_days DESC)::INT AS r_score,
      NTILE(5) OVER (ORDER BY b.frequency ASC)::INT AS f_score,
      NTILE(5) OVER (ORDER BY b.monetary ASC)::INT AS m_score
    FROM base b
  )
  SELECT
    s.user_name,
    s.recency_days,
    s.frequency,
    s.monetary,
    s.r_score,
    s.f_score,
    s.m_score,
    (s.r_score + s.f_score + s.m_score)::INT AS rfm_total,
    CASE
      WHEN s.r_score + s.f_score + s.m_score >= 12 THEN 'VIP'
      WHEN s.r_score + s.f_score + s.m_score >= 9 THEN 'ロイヤル'
      WHEN s.r_score + s.f_score + s.m_score >= 6 THEN 'アクティブ'
      WHEN s.r_score + s.f_score + s.m_score >= 4 THEN '休眠'
      ELSE '離脱'
    END AS segment
  FROM scored s
  ORDER BY rfm_total DESC, monetary DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
