-- ============================================================
-- RPC: get_coin_sessions
-- coin_transactionsからセッション（1時間ギャップで分割）を集計して返す
-- 配信レポートタブの売上データソースとして使用
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_coin_sessions(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  session_start TIMESTAMPTZ,
  session_end TIMESTAMPTZ,
  duration_minutes INT,
  total_tokens BIGINT,
  tx_count INT,
  top_users JSONB
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH filtered AS (
    -- 集計対象のみ（tip, ticketShow）。photo, offlineTipは除外
    SELECT
      ct.date AS tx_date,
      ct.tokens,
      ct.user_name
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name = p_cast_name
      AND LOWER(ct.type) NOT IN ('photo', 'offlinetip')
      AND ct.tokens > 0
    ORDER BY ct.date
  ),
  with_gap AS (
    SELECT
      tx_date,
      tokens,
      user_name,
      CASE
        WHEN tx_date - LAG(tx_date) OVER (ORDER BY tx_date) > INTERVAL '1 hour'
        THEN 1
        ELSE 0
      END AS new_session
    FROM filtered
  ),
  with_session_id AS (
    SELECT
      tx_date,
      tokens,
      user_name,
      SUM(new_session) OVER (ORDER BY tx_date) AS session_id
    FROM with_gap
  ),
  session_agg AS (
    SELECT
      s.session_id,
      MIN(s.tx_date) AS session_start,
      MAX(s.tx_date) AS session_end,
      GREATEST(1, EXTRACT(EPOCH FROM (MAX(s.tx_date) - MIN(s.tx_date))) / 60)::INT AS duration_minutes,
      SUM(s.tokens)::BIGINT AS total_tokens,
      COUNT(*)::INT AS tx_count,
      (
        SELECT jsonb_agg(u ORDER BY u.total DESC)
        FROM (
          SELECT
            s2.user_name AS username,
            SUM(s2.tokens)::INT AS total,
            COUNT(*)::INT AS count
          FROM with_session_id s2
          WHERE s2.session_id = s.session_id
            AND s2.user_name IS NOT NULL
            AND s2.user_name != ''
            AND s2.user_name != 'anonymous'
          GROUP BY s2.user_name
          ORDER BY SUM(s2.tokens) DESC
          LIMIT 5
        ) u
      ) AS top_users
    FROM with_session_id s
    GROUP BY s.session_id
  )
  SELECT
    sa.session_start,
    sa.session_end,
    sa.duration_minutes,
    sa.total_tokens,
    sa.tx_count,
    COALESCE(sa.top_users, '[]'::jsonb) AS top_users
  FROM session_agg sa
  ORDER BY sa.session_start DESC
  LIMIT p_limit;
END;
$$;

-- RLSを通さずにservice_role/anon_keyどちらでも呼べるようにGRANT
GRANT EXECUTE ON FUNCTION public.get_coin_sessions(UUID, TEXT, INT) TO authenticated, anon, service_role;
