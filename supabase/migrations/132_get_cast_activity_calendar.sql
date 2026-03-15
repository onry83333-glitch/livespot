-- 運用カレンダー用RPC: 月単位で全アクティビティを一括取得
CREATE OR REPLACE FUNCTION get_cast_activity_calendar(
  p_account_id UUID,
  p_cast_name TEXT,
  p_year INT,
  p_month INT
)
RETURNS TABLE(
  activity_date DATE,
  has_session BOOLEAN,
  session_count INT,
  has_dm BOOLEAN,
  dm_count INT,
  has_report BOOLEAN,
  report_count INT,
  has_revenue BOOLEAN,
  revenue_tokens BIGINT
) AS $$
DECLARE
  v_start DATE := make_date(p_year, p_month, 1);
  v_end DATE := v_start + INTERVAL '1 month';
BEGIN
  RETURN QUERY
  WITH dates AS (
    SELECT generate_series(v_start, v_end - INTERVAL '1 day', '1 day')::DATE AS d
  ),
  sessions_agg AS (
    SELECT started_at::DATE AS d, COUNT(*)::INT AS cnt
    FROM sessions
    WHERE cast_name = p_cast_name
      AND started_at >= v_start AND started_at < v_end
    GROUP BY started_at::DATE
  ),
  dm_agg AS (
    SELECT created_at::DATE AS d, COUNT(*)::INT AS cnt
    FROM dm_send_log
    WHERE account_id = p_account_id
      AND cast_name = p_cast_name
      AND status = 'success'
      AND created_at >= v_start AND created_at < v_end
    GROUP BY created_at::DATE
  ),
  report_agg AS (
    SELECT created_at::DATE AS d, COUNT(DISTINCT report_type)::INT AS cnt
    FROM cast_knowledge
    WHERE cast_id = (
      SELECT id FROM registered_casts WHERE cast_name = p_cast_name LIMIT 1
    )
      AND created_at >= v_start AND created_at < v_end
    GROUP BY created_at::DATE
  ),
  revenue_agg AS (
    SELECT date::DATE AS d, COALESCE(SUM(tokens), 0)::BIGINT AS total
    FROM coin_transactions
    WHERE account_id = p_account_id
      AND cast_name = p_cast_name
      AND type != 'studio'
      AND tokens > 0
      AND date >= v_start AND date < v_end
    GROUP BY date::DATE
  )
  SELECT
    dates.d AS activity_date,
    (s.cnt IS NOT NULL) AS has_session,
    COALESCE(s.cnt, 0)::INT AS session_count,
    (dm.cnt IS NOT NULL) AS has_dm,
    COALESCE(dm.cnt, 0)::INT AS dm_count,
    (r.cnt IS NOT NULL) AS has_report,
    COALESCE(r.cnt, 0)::INT AS report_count,
    (rev.total IS NOT NULL AND rev.total > 0) AS has_revenue,
    COALESCE(rev.total, 0)::BIGINT AS revenue_tokens
  FROM dates
  LEFT JOIN sessions_agg s ON s.d = dates.d
  LEFT JOIN dm_agg dm ON dm.d = dates.d
  LEFT JOIN report_agg r ON r.d = dates.d
  LEFT JOIN revenue_agg rev ON rev.d = dates.d
  ORDER BY dates.d;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
