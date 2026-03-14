-- 週次売上推移（過去12週分）
CREATE OR REPLACE FUNCTION get_weekly_revenue_trend(
  p_account_id UUID,
  p_cast_name TEXT,
  p_weeks INT DEFAULT 12
)
RETURNS TABLE(week_start DATE, week_end DATE, total_tokens BIGINT, transaction_count BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('week', ct.date)::DATE AS week_start,
    (date_trunc('week', ct.date) + interval '6 days')::DATE AS week_end,
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tokens,
    COUNT(*)::BIGINT AS transaction_count
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.type != 'studio'
    AND ct.tokens > 0
    AND ct.date >= date_trunc('week', CURRENT_DATE) - (p_weeks || ' weeks')::INTERVAL
  GROUP BY date_trunc('week', ct.date)
  ORDER BY week_start DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 月次売上推移（過去6ヶ月分）
CREATE OR REPLACE FUNCTION get_monthly_revenue_trend(
  p_account_id UUID,
  p_cast_name TEXT,
  p_months INT DEFAULT 6
)
RETURNS TABLE(month_start DATE, total_tokens BIGINT, transaction_count BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('month', ct.date)::DATE AS month_start,
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tokens,
    COUNT(*)::BIGINT AS transaction_count
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.type != 'studio'
    AND ct.tokens > 0
    AND ct.date >= date_trunc('month', CURRENT_DATE) - (p_months || ' months')::INTERVAL
  GROUP BY date_trunc('month', ct.date)
  ORDER BY month_start DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- リピート率（先月来た人のうち今月も来た人の割合）
CREATE OR REPLACE FUNCTION get_repeat_rate(
  p_account_id UUID,
  p_cast_name TEXT
)
RETURNS TABLE(last_month_users BIGINT, returning_users BIGINT, repeat_rate NUMERIC) AS $$
DECLARE
  v_this_month_start DATE := date_trunc('month', CURRENT_DATE);
  v_last_month_start DATE := date_trunc('month', CURRENT_DATE - interval '1 month');
BEGIN
  RETURN QUERY
  WITH last_month AS (
    SELECT DISTINCT ct.user_name
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
      AND ct.type != 'studio' AND ct.date >= v_last_month_start AND ct.date < v_this_month_start
  ),
  this_month AS (
    SELECT DISTINCT ct.user_name
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
      AND ct.type != 'studio' AND ct.date >= v_this_month_start
  ),
  stats AS (
    SELECT
      (SELECT COUNT(*) FROM last_month)::BIGINT AS last_month_users,
      (SELECT COUNT(*) FROM last_month lm INNER JOIN this_month tm ON lm.user_name = tm.user_name)::BIGINT AS returning_users
  )
  SELECT s.last_month_users, s.returning_users,
    CASE WHEN s.last_month_users > 0
      THEN ROUND(s.returning_users::NUMERIC / s.last_month_users * 100, 1)
      ELSE 0
    END AS repeat_rate
  FROM stats s;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 離脱リスク（先月来たけど今月来ていない人、課金額順）
CREATE OR REPLACE FUNCTION get_churn_risk(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INT DEFAULT 20
)
RETURNS TABLE(user_name TEXT, last_month_tokens BIGINT, last_visit DATE) AS $$
DECLARE
  v_this_month_start DATE := date_trunc('month', CURRENT_DATE);
  v_last_month_start DATE := date_trunc('month', CURRENT_DATE - interval '1 month');
BEGIN
  RETURN QUERY
  WITH last_month AS (
    SELECT ct.user_name, SUM(ct.tokens)::BIGINT AS last_month_tokens,
           MAX(ct.date)::DATE AS last_visit
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
      AND ct.type != 'studio' AND ct.date >= v_last_month_start AND ct.date < v_this_month_start
    GROUP BY ct.user_name
  ),
  this_month AS (
    SELECT DISTINCT ct.user_name
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
      AND ct.type != 'studio' AND ct.date >= v_this_month_start
  )
  SELECT lm.user_name, lm.last_month_tokens, lm.last_visit
  FROM last_month lm
  WHERE NOT EXISTS (SELECT 1 FROM this_month tm WHERE tm.user_name = lm.user_name)
  ORDER BY lm.last_month_tokens DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 新規定着率（初回から2回目に来た率）
CREATE OR REPLACE FUNCTION get_new_user_retention(
  p_account_id UUID,
  p_cast_name TEXT
)
RETURNS TABLE(new_users_last_month BIGINT, returned_users BIGINT, retention_rate NUMERIC) AS $$
DECLARE
  v_this_month_start DATE := date_trunc('month', CURRENT_DATE);
  v_last_month_start DATE := date_trunc('month', CURRENT_DATE - interval '1 month');
BEGIN
  RETURN QUERY
  WITH first_timers AS (
    SELECT ct.user_name
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
      AND ct.type != 'studio' AND ct.date >= v_last_month_start AND ct.date < v_this_month_start
      AND NOT EXISTS (
        SELECT 1 FROM coin_transactions ct2
        WHERE ct2.account_id = p_account_id AND ct2.cast_name = p_cast_name
          AND ct2.type != 'studio' AND ct2.user_name = ct.user_name AND ct2.date < v_last_month_start
      )
    GROUP BY ct.user_name
  ),
  returned AS (
    SELECT ft.user_name
    FROM first_timers ft
    WHERE EXISTS (
      SELECT 1 FROM coin_transactions ct
      WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
        AND ct.type != 'studio' AND ct.user_name = ft.user_name AND ct.date >= v_this_month_start
    )
  ),
  stats AS (
    SELECT
      (SELECT COUNT(*) FROM first_timers)::BIGINT AS new_users_last_month,
      (SELECT COUNT(*) FROM returned)::BIGINT AS returned_users
  )
  SELECT s.new_users_last_month, s.returned_users,
    CASE WHEN s.new_users_last_month > 0
      THEN ROUND(s.returned_users::NUMERIC / s.new_users_last_month * 100, 1)
      ELSE 0
    END AS retention_rate
  FROM stats s;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
