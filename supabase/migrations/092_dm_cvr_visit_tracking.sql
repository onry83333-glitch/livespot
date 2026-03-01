-- ============================================================
-- 092: get_dm_campaign_cvr に来場CVR（spy_messages突合）を追加
--
-- 問題: CVR計算が coin_transactions（6h同期）のみに依存しており、
--       当日送信のキャンペーンは課金同期が追いつかずCVR 0%になる。
--       spy_messages（リアルタイム）との突合が未実装。
--
-- 修正: visited_after / visit_cvr_pct を追加。
--       DM送信後にspy_messagesに出現したユーザーをカウント。
--       idx_spy_msg_user (account_id, user_name, message_time) を活用。
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_dm_campaign_cvr(UUID, TEXT, DATE);
--   -- 076_fix_cast_name_filters.sql の get_dm_campaign_cvr を再適用
-- ============================================================

-- 戻り値型が変わるため DROP → CREATE
DROP FUNCTION IF EXISTS get_dm_campaign_cvr(UUID, TEXT, DATE);

CREATE OR REPLACE FUNCTION get_dm_campaign_cvr(
  p_account_id UUID DEFAULT NULL,
  p_cast_name TEXT DEFAULT NULL,
  p_since DATE DEFAULT (CURRENT_DATE - INTERVAL '90 days')::date
)
RETURNS TABLE(
  campaign TEXT,
  dm_sent BIGINT,
  paid_after BIGINT,
  visited_after BIGINT,
  cvr_pct NUMERIC,
  visit_cvr_pct NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_payer NUMERIC,
  first_sent TIMESTAMPTZ,
  last_sent TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH dm AS (
    -- キャンペーン×ユーザー単位で最初のDM送信を取得
    SELECT DISTINCT ON (dsl.campaign, dsl.user_name)
      dsl.campaign,
      dsl.user_name,
      dsl.queued_at,
      dsl.sent_at,
      dsl.account_id,
      dsl.cast_name
    FROM dm_send_log dsl
    WHERE dsl.queued_at >= p_since
      AND (p_account_id IS NULL OR dsl.account_id = p_account_id)
      AND (p_cast_name  IS NULL OR dsl.cast_name  = p_cast_name)
      AND dsl.campaign IS NOT NULL
      AND dsl.campaign != ''
      AND dsl.status = 'success'
    ORDER BY dsl.campaign, dsl.user_name, dsl.queued_at ASC
  ),
  visit_flags AS (
    -- DM送信後にspy_messagesに出現したユーザー（来場判定）
    SELECT DISTINCT dm.campaign, dm.user_name
    FROM dm
    WHERE EXISTS (
      SELECT 1 FROM spy_messages sm
      WHERE sm.user_name = dm.user_name
        AND sm.message_time > dm.queued_at
        AND sm.account_id = dm.account_id
        AND sm.cast_name  = dm.cast_name
    )
  )
  SELECT
    dm.campaign,
    COUNT(DISTINCT dm.user_name)::BIGINT AS dm_sent,
    COUNT(DISTINCT ct.user_name)::BIGINT AS paid_after,
    COUNT(DISTINCT vf.user_name)::BIGINT AS visited_after,
    ROUND(
      COUNT(DISTINCT ct.user_name)::numeric
      / NULLIF(COUNT(DISTINCT dm.user_name), 0) * 100, 1
    ) AS cvr_pct,
    ROUND(
      COUNT(DISTINCT vf.user_name)::numeric
      / NULLIF(COUNT(DISTINCT dm.user_name), 0) * 100, 1
    ) AS visit_cvr_pct,
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tokens,
    ROUND(
      COALESCE(SUM(ct.tokens), 0)::numeric
      / NULLIF(COUNT(DISTINCT ct.user_name), 0), 0
    ) AS avg_tokens_per_payer,
    MIN(dm.queued_at) AS first_sent,
    MAX(dm.sent_at)   AS last_sent
  FROM dm
  LEFT JOIN coin_transactions ct
    ON  ct.user_name  = dm.user_name
    AND ct.date        > dm.queued_at
    AND (p_account_id IS NULL OR ct.account_id = p_account_id)
    AND (p_cast_name  IS NULL OR ct.cast_name  = p_cast_name)
  LEFT JOIN visit_flags vf
    ON  vf.campaign  = dm.campaign
    AND vf.user_name = dm.user_name
  GROUP BY dm.campaign
  ORDER BY dm_sent DESC, cvr_pct DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 2. get_user_acquisition_dashboard: dm_send_log に cast_name フィルタ追加
--
-- 問題: dm_sent / dm_sent_date / dm_campaign / converted_after_dm の
--       サブクエリに cast_name 条件がなく、他キャスト宛DMが混入していた。
--
-- ROLLBACK:
--   -- 016_dashboard_improvements.sql の関数を再適用
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
      AND dm.cast_name = p_cast_name
    ) AS dm_sent,
    (
      SELECT MAX(dm.queued_at) FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
      AND dm.cast_name = p_cast_name
    ) AS dm_sent_date,
    (
      SELECT dm.campaign FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
      AND dm.cast_name = p_cast_name
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
        AND dm.cast_name = p_cast_name
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
