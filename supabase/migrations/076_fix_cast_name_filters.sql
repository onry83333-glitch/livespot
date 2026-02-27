-- ============================================================
-- 076: cast_name フィルタ欠落修正
-- paid_users / dm_send_log の WHERE句に cast_name 条件を追加
-- ============================================================

-- ─── 1. refresh_segments: paid_users INSERT に cast_name を追加 ───
-- 既存: cast_name を設定せず NULL のまま → .eq('cast_name', x) で取得不可
CREATE OR REPLACE FUNCTION refresh_segments(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  v_updated INTEGER := 0;
  v_p95 NUMERIC;
  v_p80 NUMERIC;
  v_p50 NUMERIC;
BEGIN
  -- ─── Step 1: coin_transactionsからユーザー別集計 ───
  CREATE TEMP TABLE _target_users ON COMMIT DROP AS
  SELECT DISTINCT user_name
  FROM coin_transactions
  WHERE account_id = p_account_id
    AND tokens > 0
    AND (p_cast_name IS NULL OR cast_name = p_cast_name);

  CREATE TEMP TABLE _user_agg ON COMMIT DROP AS
  SELECT
    ct.account_id,
    ct.user_name,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.tokens > 0), 0)::INTEGER AS total_coins,
    COUNT(*) FILTER (WHERE ct.tokens > 0)::INTEGER AS tx_count,
    MIN(ct.date) AS first_paid,
    MAX(ct.date) AS last_paid
  FROM coin_transactions ct
  INNER JOIN _target_users tu ON tu.user_name = ct.user_name
  WHERE ct.account_id = p_account_id
    AND ct.tokens > 0
    AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
  GROUP BY ct.account_id, ct.user_name;

  -- ─── Step 2: PERCENTILE_CONTで動的しきい値 ───
  SELECT
    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_coins), 5000),
    COALESCE(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY total_coins), 1000),
    COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_coins), 100)
  INTO v_p95, v_p80, v_p50
  FROM _user_agg;

  -- ─── Step 3: セグメント分類 + paid_users UPSERT（cast_name含む） ───
  WITH classified AS (
    SELECT
      account_id,
      user_name,
      total_coins,
      tx_count,
      first_paid,
      last_paid,
      CASE
        WHEN last_paid < NOW() - INTERVAL '90 days' THEN 'churned'
        WHEN first_paid >= NOW() - INTERVAL '30 days'
             AND total_coins < v_p50 THEN 'new'
        WHEN total_coins >= v_p95 THEN 'whale'
        WHEN total_coins >= v_p80 THEN 'vip'
        WHEN total_coins >= v_p50 THEN 'regular'
        ELSE 'light'
      END AS segment
    FROM _user_agg
  )
  INSERT INTO paid_users (account_id, user_name, total_coins, last_payment_date, segment, tx_count, first_payment_date, cast_name, updated_at)
  SELECT account_id, user_name, total_coins, last_paid, segment, tx_count, first_paid, p_cast_name, NOW()
  FROM classified
  ON CONFLICT (account_id, user_name)
  DO UPDATE SET
    total_coins = EXCLUDED.total_coins,
    last_payment_date = EXCLUDED.last_payment_date,
    segment = EXCLUDED.segment,
    tx_count = EXCLUDED.tx_count,
    first_payment_date = EXCLUDED.first_payment_date,
    cast_name = COALESCE(EXCLUDED.cast_name, paid_users.cast_name),
    updated_at = NOW();

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- ─── Step 4: paying_usersマテビューもリフレッシュ ───
  REFRESH MATERIALIZED VIEW CONCURRENTLY paying_users;

  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ─── 2. get_dm_campaign_effectiveness: dm_send_log に cast_name フィルタ追加 ───
-- 既存: dm_send_log を account_id のみでフィルタ → 全キャスト混在
CREATE OR REPLACE FUNCTION get_dm_campaign_effectiveness(
  p_account_id UUID,
  p_cast_name TEXT,
  p_window_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  campaign TEXT,
  sent_count BIGINT,
  success_count BIGINT,
  visited_count BIGINT,
  tipped_count BIGINT,
  tip_amount BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.campaign,
    COUNT(*)::BIGINT AS sent_count,
    COUNT(*) FILTER (WHERE d.status = 'success')::BIGINT AS success_count,
    COUNT(DISTINCT CASE
      WHEN EXISTS (
        SELECT 1 FROM spy_messages sm
        WHERE sm.account_id = p_account_id
          AND sm.cast_name = p_cast_name
          AND sm.user_name = d.user_name
          AND sm.message_time > d.sent_at
          AND sm.message_time <= d.sent_at + (p_window_days || ' days')::INTERVAL
      ) THEN d.user_name
    END)::BIGINT AS visited_count,
    COUNT(DISTINCT CASE
      WHEN EXISTS (
        SELECT 1 FROM spy_messages sm
        WHERE sm.account_id = p_account_id
          AND sm.cast_name = p_cast_name
          AND sm.user_name = d.user_name
          AND sm.msg_type IN ('tip', 'gift')
          AND sm.message_time > d.sent_at
          AND sm.message_time <= d.sent_at + (p_window_days || ' days')::INTERVAL
      ) THEN d.user_name
    END)::BIGINT AS tipped_count,
    COALESCE((
      SELECT SUM(sm2.tokens)
      FROM spy_messages sm2
      WHERE sm2.account_id = p_account_id
        AND sm2.cast_name = p_cast_name
        AND sm2.msg_type IN ('tip', 'gift')
        AND sm2.user_name IN (
          SELECT d2.user_name FROM dm_send_log d2
          WHERE d2.campaign = d.campaign AND d2.status = 'success'
        )
        AND sm2.message_time > MIN(d.sent_at)
        AND sm2.message_time <= MIN(d.sent_at) + (p_window_days || ' days')::INTERVAL
    ), 0)::BIGINT AS tip_amount
  FROM dm_send_log d
  WHERE d.account_id = p_account_id
    AND d.cast_name = p_cast_name
    AND d.campaign IS NOT NULL
    AND d.campaign != ''
  GROUP BY d.campaign
  ORDER BY MIN(d.queued_at) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ─── 3. get_dm_campaign_cvr: dm_send_log に cast_name フィルタ追加 ───
-- 既存: dm_send_log に cast_name フィルタなし → 全キャストのDMが混在
CREATE OR REPLACE FUNCTION get_dm_campaign_cvr(
  p_account_id UUID DEFAULT NULL,
  p_cast_name TEXT DEFAULT NULL,
  p_since DATE DEFAULT (CURRENT_DATE - INTERVAL '90 days')::date
)
RETURNS TABLE(
  campaign TEXT,
  dm_sent BIGINT,
  paid_after BIGINT,
  cvr_pct NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_payer NUMERIC,
  first_sent TIMESTAMPTZ,
  last_sent TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    dsl.campaign,
    COUNT(DISTINCT dsl.user_name)                                               AS dm_sent,
    COUNT(DISTINCT ct.user_name)                                                AS paid_after,
    ROUND(
      COUNT(DISTINCT ct.user_name)::numeric
      / NULLIF(COUNT(DISTINCT dsl.user_name), 0) * 100, 1
    )                                                                           AS cvr_pct,
    COALESCE(SUM(ct.tokens), 0)::BIGINT                                         AS total_tokens,
    ROUND(
      COALESCE(SUM(ct.tokens), 0)::numeric
      / NULLIF(COUNT(DISTINCT ct.user_name), 0), 0
    )                                                                           AS avg_tokens_per_payer,
    MIN(dsl.queued_at)                                                          AS first_sent,
    MAX(dsl.sent_at)                                                            AS last_sent
  FROM dm_send_log dsl
  LEFT JOIN coin_transactions ct
    ON  ct.user_name = dsl.user_name
    AND ct.date > dsl.queued_at
    AND (p_account_id IS NULL OR ct.account_id = p_account_id)
    AND (p_cast_name  IS NULL OR ct.cast_name  = p_cast_name)
  WHERE dsl.queued_at >= p_since
    AND (p_account_id IS NULL OR dsl.account_id = p_account_id)
    AND (p_cast_name  IS NULL OR dsl.cast_name  = p_cast_name)
    AND dsl.campaign IS NOT NULL
    AND dsl.campaign != ''
    AND dsl.status = 'success'
  GROUP BY dsl.campaign
  ORDER BY cvr_pct DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql;
