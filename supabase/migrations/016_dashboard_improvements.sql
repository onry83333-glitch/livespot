-- Migration 016: ユーザー獲得ダッシュボード改善
-- 1. get_user_acquisition_dashboard に p_max_coins 追加（範囲フィルタ）
-- 2. search_user_detail 新規（ターゲット検索・前方一致・DM履歴+トランザクション）

-- ============================================================
-- 1. get_user_acquisition_dashboard v2（p_max_coins追加）
-- ============================================================
CREATE OR REPLACE FUNCTION get_user_acquisition_dashboard(
  p_account_id UUID,
  p_cast_name TEXT,
  p_days INTEGER DEFAULT 30,
  p_min_coins INTEGER DEFAULT 0,
  p_max_coins INTEGER DEFAULT 999999
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ,
  first_seen TIMESTAMPTZ,
  tx_count BIGINT,
  dm_sent BOOLEAN,
  dm_sent_date TIMESTAMPTZ,
  dm_campaign TEXT,
  segment TEXT,
  is_new_user BOOLEAN,
  converted_after_dm BOOLEAN
)
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pu.user_name,
    pu.total_coins::BIGINT,
    pu.last_payment_date,
    pu.created_at AS first_seen,
    COALESCE(ct_agg.tx_count, 0)::BIGINT,
    EXISTS (
      SELECT 1 FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
    ) AS dm_sent,
    (
      SELECT MAX(dm.queued_at) FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
    ) AS dm_sent_date,
    (
      SELECT dm.campaign FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
      ORDER BY dm.queued_at DESC LIMIT 1
    ) AS dm_campaign,
    CASE
      WHEN pu.total_coins >= 3500 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S2 Whale準現役'
      WHEN pu.total_coins >= 3500 THEN 'S3 Whale休眠'
      WHEN pu.total_coins >= 1400 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S5 VIP準現役'
      WHEN pu.total_coins >= 1400 THEN 'S6 VIP休眠'
      WHEN pu.total_coins >= 550 THEN 'S8 常連'
      WHEN pu.total_coins >= 200 THEN 'S9 中堅'
      ELSE 'S10 ライト'
    END AS segment,
    (pu.created_at >= NOW() - (p_days || ' days')::INTERVAL) AS is_new_user,
    (
      EXISTS (
        SELECT 1 FROM dm_send_log dm
        WHERE dm.user_name = pu.user_name
        AND dm.account_id = p_account_id
        AND pu.last_payment_date > dm.queued_at
      )
    ) AS converted_after_dm
  FROM paid_users pu
  LEFT JOIN (
    SELECT ct.user_name, COUNT(*) AS tx_count
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.date >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY ct.user_name
  ) ct_agg ON ct_agg.user_name = pu.user_name
  WHERE pu.cast_name = p_cast_name
  AND pu.total_coins >= p_min_coins
  AND pu.total_coins <= p_max_coins
  AND pu.last_payment_date >= NOW() - (p_days || ' days')::INTERVAL
  AND pu.created_at >= '2026-02-15'::DATE
  ORDER BY pu.total_coins DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 2. search_user_detail（ターゲット検索）
-- ============================================================
CREATE OR REPLACE FUNCTION search_user_detail(
  p_account_id UUID,
  p_cast_name TEXT,
  p_user_name TEXT
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ,
  first_seen TIMESTAMPTZ,
  tx_count BIGINT,
  segment TEXT,
  dm_history JSONB,
  recent_transactions JSONB
)
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pu.user_name,
    pu.total_coins::BIGINT,
    pu.last_payment_date,
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
    ) AS recent_transactions
  FROM paid_users pu
  WHERE pu.cast_name = p_cast_name
  AND pu.user_name ILIKE p_user_name || '%'
  LIMIT 5;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
