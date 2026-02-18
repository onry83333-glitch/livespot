-- Migration 013: detect_new_paying_users RPC
-- コイン同期の差分から新規課金ユーザーを検出

CREATE OR REPLACE FUNCTION detect_new_paying_users(
  p_account_id UUID,
  p_cast_name TEXT,
  p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '24 hours'
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  tx_count BIGINT,
  first_payment TIMESTAMPTZ,
  is_completely_new BOOLEAN
)
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.user_name,
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_coins,
    COUNT(*)::BIGINT AS tx_count,
    MIN(ct.date) AS first_payment,
    -- 完全新規 = p_since以前のトランザクションが存在しない
    NOT EXISTS (
      SELECT 1 FROM coin_transactions older
      WHERE older.account_id = p_account_id
        AND older.cast_name = p_cast_name
        AND older.user_name = ct.user_name
        AND older.date < p_since
    ) AS is_completely_new
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.synced_at >= p_since
    AND ct.tokens > 0
  GROUP BY ct.user_name
  ORDER BY total_coins DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
