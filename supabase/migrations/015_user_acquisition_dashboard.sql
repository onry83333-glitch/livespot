-- Migration 015: get_user_acquisition_dashboard RPC
-- ユーザー獲得ダッシュボード：新規課金ユーザー特定 + DM効果測定 + チケットチャット初回抽出

CREATE OR REPLACE FUNCTION get_user_acquisition_dashboard(
  p_account_id UUID,
  p_cast_name TEXT,
  p_days INTEGER DEFAULT 30,
  p_min_coins INTEGER DEFAULT 150
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
    -- DM送信履歴
    EXISTS (
      SELECT 1 FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
    ) AS dm_sent,
    -- 最新のDM送信日
    (
      SELECT MAX(dm.queued_at) FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
    ) AS dm_sent_date,
    -- キャンペーン名
    (
      SELECT dm.campaign FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
      ORDER BY dm.queued_at DESC LIMIT 1
    ) AS dm_campaign,
    -- セグメント判定
    CASE
      WHEN pu.total_coins >= 3500 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S2 Whale準現役'
      WHEN pu.total_coins >= 3500 THEN 'S3 Whale休眠'
      WHEN pu.total_coins >= 1400 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S5 VIP準現役'
      WHEN pu.total_coins >= 1400 THEN 'S6 VIP休眠'
      WHEN pu.total_coins >= 550 THEN 'S8 常連'
      WHEN pu.total_coins >= 200 THEN 'S9 中堅'
      ELSE 'S10 ライト'
    END AS segment,
    -- 新規判定: created_atが期間内
    (pu.created_at >= NOW() - (p_days || ' days')::INTERVAL) AS is_new_user,
    -- DM→課金コンバージョン: DM送信後にlast_payment_dateがある
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
  AND pu.last_payment_date >= NOW() - (p_days || ' days')::INTERVAL
  AND pu.created_at >= '2026-02-15'::DATE
  ORDER BY pu.total_coins DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
