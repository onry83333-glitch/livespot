-- ============================================================
-- 085: paid_users cast_name NULL バックフィル + バリデーション追加
--
-- 問題: paid_users.cast_name が NULL のレコードが多数存在し、
--       品質チェック画面で (unknown) と表示される
--
-- 原因: sync.py の paid_users UPSERT で cast_name を含めていなかった
--       refresh_segments RPC もバックフィルを行っていなかった
--
-- ROLLBACK:
--   UPDATE paid_users SET cast_name = NULL;
--   -- refresh_segments は 076 版に戻す（本ファイルの関数を DROP 後に 076 を再適用）
-- ============================================================

-- ─── 1. cast_name カラムが存在しない場合は追加（安全策） ───
ALTER TABLE paid_users ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- ─── 2. coin_transactions から最多課金キャストを特定してバックフィル ───
-- 各ユーザーのトークン合計が最大のキャストを「主キャスト」として設定
WITH dominant_cast AS (
  SELECT DISTINCT ON (account_id, user_name)
    account_id,
    user_name,
    cast_name
  FROM (
    SELECT
      account_id,
      user_name,
      cast_name,
      SUM(tokens) AS total_tokens
    FROM coin_transactions
    WHERE cast_name IS NOT NULL
      AND cast_name != ''
      AND tokens > 0
    GROUP BY account_id, user_name, cast_name
    ORDER BY account_id, user_name, SUM(tokens) DESC
  ) ranked
)
UPDATE paid_users pu
SET cast_name = dc.cast_name,
    updated_at = NOW()
FROM dominant_cast dc
WHERE pu.account_id = dc.account_id
  AND pu.user_name = dc.user_name
  AND (pu.cast_name IS NULL OR pu.cast_name = '');

-- ─── 3. coin_transactions にもない孤立レコード（テストデータ）を削除 ───
-- paid_users にいるが coin_transactions に1件もない = CSV手動投入 or テストデータ
DELETE FROM paid_users pu
WHERE (pu.cast_name IS NULL OR pu.cast_name = '')
  AND NOT EXISTS (
    SELECT 1 FROM coin_transactions ct
    WHERE ct.user_name = pu.user_name
      AND ct.account_id = pu.account_id
  );

-- ─── 4. refresh_segments RPC を更新（cast_name NULL 防止バリデーション） ───
-- p_cast_name が NULL の場合、各ユーザーの最多課金キャストを自動判定
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
  -- ─── Step 1: coin_transactions からユーザー別集計 ───
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

  -- ─── Step 2: PERCENTILE_CONT で動的しきい値 ───
  SELECT
    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_coins), 5000),
    COALESCE(PERCENTILE_CONT(0.80) WITHIN GROUP (ORDER BY total_coins), 1000),
    COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_coins), 100)
  INTO v_p95, v_p80, v_p50
  FROM _user_agg;

  -- ─── Step 3: 各ユーザーの最多課金キャストを判定（cast_name NULL 防止） ───
  CREATE TEMP TABLE _user_dominant_cast ON COMMIT DROP AS
  SELECT DISTINCT ON (account_id, user_name)
    account_id,
    user_name,
    cast_name
  FROM (
    SELECT
      ct2.account_id,
      ct2.user_name,
      ct2.cast_name,
      SUM(ct2.tokens) AS cast_tokens
    FROM coin_transactions ct2
    INNER JOIN _target_users tu2 ON tu2.user_name = ct2.user_name
    WHERE ct2.account_id = p_account_id
      AND ct2.tokens > 0
      AND ct2.cast_name IS NOT NULL
      AND ct2.cast_name != ''
    GROUP BY ct2.account_id, ct2.user_name, ct2.cast_name
    ORDER BY ct2.account_id, ct2.user_name, SUM(ct2.tokens) DESC
  ) sub;

  -- ─── Step 4: セグメント分類 + paid_users UPSERT（cast_name 確定済み） ───
  WITH classified AS (
    SELECT
      ua.account_id,
      ua.user_name,
      ua.total_coins,
      ua.tx_count,
      ua.first_paid,
      ua.last_paid,
      -- p_cast_name 指定時はそれを使用、未指定時は最多課金キャストを使用
      COALESCE(p_cast_name, udc.cast_name) AS resolved_cast_name,
      CASE
        WHEN ua.last_paid < NOW() - INTERVAL '90 days' THEN 'churned'
        WHEN ua.first_paid >= NOW() - INTERVAL '30 days'
             AND ua.total_coins < v_p50 THEN 'new'
        WHEN ua.total_coins >= v_p95 THEN 'whale'
        WHEN ua.total_coins >= v_p80 THEN 'vip'
        WHEN ua.total_coins >= v_p50 THEN 'regular'
        ELSE 'light'
      END AS segment
    FROM _user_agg ua
    LEFT JOIN _user_dominant_cast udc
      ON udc.account_id = ua.account_id AND udc.user_name = ua.user_name
  )
  INSERT INTO paid_users (
    account_id, user_name, total_coins, last_payment_date,
    segment, tx_count, first_payment_date, cast_name, updated_at
  )
  SELECT
    account_id, user_name, total_coins, last_paid,
    segment, tx_count, first_paid, resolved_cast_name, NOW()
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

  -- ─── Step 5: paying_users マテビューもリフレッシュ ───
  REFRESH MATERIALIZED VIEW CONCURRENTLY paying_users;

  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
