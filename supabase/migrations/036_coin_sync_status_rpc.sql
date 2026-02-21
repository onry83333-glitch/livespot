-- Migration 036: get_coin_sync_status RPC
-- キャストごとの最終コイン同期日時を取得するRPC関数

CREATE OR REPLACE FUNCTION get_coin_sync_status()
RETURNS TABLE(
  cast_name TEXT,
  last_synced_at TIMESTAMPTZ,
  hours_since_sync NUMERIC,
  transaction_count BIGINT,
  needs_sync BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    rc.cast_name,
    MAX(ct.synced_at) AS last_synced_at,
    ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX(ct.synced_at), '1970-01-01'::TIMESTAMPTZ))) / 3600, 1) AS hours_since_sync,
    COUNT(ct.id) AS transaction_count,
    (MAX(ct.synced_at) IS NULL OR MAX(ct.synced_at) < NOW() - INTERVAL '24 hours') AS needs_sync
  FROM registered_casts rc
  LEFT JOIN coin_transactions ct
    ON ct.cast_name = rc.cast_name
    AND ct.account_id = rc.account_id
  WHERE rc.account_id IN (SELECT user_account_ids())
    AND rc.is_active = true
  GROUP BY rc.cast_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
