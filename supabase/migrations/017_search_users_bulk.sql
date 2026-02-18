-- Migration 017: search_users_bulk RPC
-- search_user_detail の置き換え: 完全一致 + 配列一括検索 + 該当なしも返す
-- last_actual_payment (coin_transactions MAX(date)) を追加

CREATE OR REPLACE FUNCTION search_users_bulk(
  p_account_id UUID,
  p_cast_name TEXT,
  p_user_names TEXT[]
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ,
  last_actual_payment TIMESTAMPTZ,
  first_seen TIMESTAMPTZ,
  tx_count BIGINT,
  segment TEXT,
  dm_history JSONB,
  recent_transactions JSONB,
  found BOOLEAN
)
AS $$
BEGIN
  RETURN QUERY
  -- ヒットしたユーザー
  SELECT
    pu.user_name,
    pu.total_coins::BIGINT,
    pu.last_payment_date,
    (SELECT MAX(ct.date) FROM coin_transactions ct
     WHERE ct.user_name = pu.user_name
     AND ct.cast_name = p_cast_name
     AND ct.account_id = p_account_id
    ) AS last_actual_payment,
    pu.created_at AS first_seen,
    (SELECT COUNT(*) FROM coin_transactions ct
     WHERE ct.user_name = pu.user_name
     AND ct.cast_name = p_cast_name
     AND ct.account_id = p_account_id)::BIGINT AS tx_count,
    CASE
      WHEN pu.total_coins >= 3500 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S2 Whale準現役'
      WHEN pu.total_coins >= 3500 THEN 'S3 Whale休眠'
      WHEN pu.total_coins >= 1400 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S5 VIP準現役'
      WHEN pu.total_coins >= 1400 THEN 'S6 VIP休眠'
      WHEN pu.total_coins >= 550 THEN 'S8 常連'
      WHEN pu.total_coins >= 200 THEN 'S9 中堅'
      ELSE 'S10 ライト'
    END AS segment,
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'campaign', dm.campaign,
        'sent_date', dm.queued_at,
        'status', dm.status
      ) ORDER BY dm.queued_at DESC)
      FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id),
      '[]'::JSONB
    ) AS dm_history,
    COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'date', ct.date,
        'amount', ct.tokens,
        'type', ct.type
      ) ORDER BY ct.date DESC)
      FROM (
        SELECT ct2.date, ct2.tokens, ct2.type
        FROM coin_transactions ct2
        WHERE ct2.user_name = pu.user_name
        AND ct2.cast_name = p_cast_name
        AND ct2.account_id = p_account_id
        ORDER BY ct2.date DESC
        LIMIT 20
      ) ct),
      '[]'::JSONB
    ) AS recent_transactions,
    true AS found
  FROM paid_users pu
  WHERE pu.cast_name = p_cast_name
  AND pu.user_name = ANY(p_user_names)

  UNION ALL

  -- 該当なしのユーザー
  SELECT
    un.name AS user_name,
    0::BIGINT,
    NULL::TIMESTAMPTZ,
    NULL::TIMESTAMPTZ,
    NULL::TIMESTAMPTZ,
    0::BIGINT,
    'なし'::TEXT,
    '[]'::JSONB,
    '[]'::JSONB,
    false AS found
  FROM unnest(p_user_names) AS un(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM paid_users pu2
    WHERE pu2.cast_name = p_cast_name
    AND pu2.user_name = un.name
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
