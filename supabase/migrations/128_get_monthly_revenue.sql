-- get_monthly_revenue: サーバー側SUM集計でmax_rows制限を回避
CREATE OR REPLACE FUNCTION get_monthly_revenue(
  p_account_id UUID,
  p_cast_name TEXT,
  p_start_date DATE,
  p_end_date DATE
)
RETURNS TABLE(total_tokens BIGINT, transaction_count BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tokens,
    COUNT(*)::BIGINT AS transaction_count
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.type != 'studio'
    AND ct.date >= p_start_date
    AND ct.date < p_end_date
    AND ct.tokens > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
