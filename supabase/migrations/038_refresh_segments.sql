-- Migration 038: refresh_segments RPC
-- coin_transactionsからユーザー別セグメントを再計算し、paid_usersにUPSERT
-- PERCENTILE_CONTで動的しきい値を算出（キャスト/アカウントごとに異なる）

-- 1. paid_users にセグメント関連カラム追加
ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS segment TEXT;
ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS tx_count INTEGER DEFAULT 0;
ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS first_payment_date TIMESTAMPTZ;

COMMENT ON COLUMN paid_users.segment IS 'ファンセグメント: whale/vip/regular/light/new/churned';
COMMENT ON COLUMN paid_users.tx_count IS '課金トランザクション回数';
COMMENT ON COLUMN paid_users.first_payment_date IS '初回課金日時';

-- 2. refresh_segments RPC
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
  -- cast_name指定時: そのキャストの取引があるユーザーに絞る
  -- ただしtotal_coinsはアカウント全体の合計（paid_usersがアカウントレベルのため）
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
  GROUP BY ct.account_id, ct.user_name;

  -- ─── Step 2: PERCENTILE_CONTで動的しきい値 ───
  SELECT
    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_coins), 5000),
    COALESCE(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY total_coins), 1000),
    COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_coins), 100)
  INTO v_p95, v_p80, v_p50
  FROM _user_agg;

  -- ─── Step 3: セグメント分類 + paid_users UPSERT ───
  WITH classified AS (
    SELECT
      account_id,
      user_name,
      total_coins,
      tx_count,
      first_paid,
      last_paid,
      CASE
        -- churned: 90日以上課金なし（金額に関係なく離脱判定）
        WHEN last_paid < NOW() - INTERVAL '90 days' THEN 'churned'
        -- new: 初回課金から30日以内 かつ 中央値未満
        WHEN first_paid >= NOW() - INTERVAL '30 days'
             AND total_coins < v_p50 THEN 'new'
        -- whale: P95以上
        WHEN total_coins >= v_p95 THEN 'whale'
        -- vip: P80以上
        WHEN total_coins >= v_p80 THEN 'vip'
        -- regular: P50以上
        WHEN total_coins >= v_p50 THEN 'regular'
        -- light: それ以外
        ELSE 'light'
      END AS segment
    FROM _user_agg
  )
  INSERT INTO paid_users (account_id, user_name, total_coins, last_payment_date, segment, tx_count, first_payment_date, updated_at)
  SELECT account_id, user_name, total_coins, last_paid, segment, tx_count, first_paid, NOW()
  FROM classified
  ON CONFLICT (account_id, user_name)
  DO UPDATE SET
    total_coins = EXCLUDED.total_coins,
    last_payment_date = EXCLUDED.last_payment_date,
    segment = EXCLUDED.segment,
    tx_count = EXCLUDED.tx_count,
    first_payment_date = EXCLUDED.first_payment_date,
    updated_at = NOW();

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- ─── Step 4: paying_usersマテビューもリフレッシュ ───
  REFRESH MATERIALIZED VIEW CONCURRENTLY paying_users;

  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
