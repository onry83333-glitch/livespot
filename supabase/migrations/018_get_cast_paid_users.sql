-- Migration 018: get_cast_paid_users RPC
-- paid_usersテーブルのcast_nameが不完全なため、
-- coin_transactionsからcast_name別にユーザー集計するRPC

CREATE OR REPLACE FUNCTION get_cast_paid_users(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INTEGER DEFAULT 100,
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.user_name,
    SUM(ct.tokens)::BIGINT AS total_coins,
    MAX(ct.date) AS last_payment_date
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND (p_since IS NULL OR ct.date >= p_since)
  GROUP BY ct.user_name
  HAVING SUM(ct.tokens) > 0
  ORDER BY total_coins DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
