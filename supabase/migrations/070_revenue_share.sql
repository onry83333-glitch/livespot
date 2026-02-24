-- ============================================================
-- 070: レベニューシェア自動計算
-- cast_cost_settings に revenue_share_rate 追加
-- + calculate_revenue_share RPC（週次・月曜3:00AM JST境界）
-- ============================================================

-- 1. revenue_share_rate カラム追加（キャストへの分配率 %）
ALTER TABLE cast_cost_settings
  ADD COLUMN IF NOT EXISTS revenue_share_rate NUMERIC(5,2) DEFAULT 50.00;

COMMENT ON COLUMN cast_cost_settings.revenue_share_rate
  IS 'キャスト報酬分配率（%）。ネット売上 × この率 = キャスト支払い額';

-- token_to_usd カラム追加（Stripchat: 1token = $0.05）
ALTER TABLE cast_cost_settings
  ADD COLUMN IF NOT EXISTS token_to_usd NUMERIC(10,6) DEFAULT 0.05;

COMMENT ON COLUMN cast_cost_settings.token_to_usd
  IS '1トークン=USD（Stripchat標準: $0.05）';

-- ============================================================
-- 2. calculate_revenue_share RPC
--
-- 週次集計（月曜 03:00 AM JST = 日曜 18:00 UTC 境界）
-- coin_transactions.tokens で集計（amount 不使用）
-- coin_transactions.date で集計（created_at 不使用）
-- 2/15 以前のデータは除外
-- 全演算根拠を返却
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_revenue_share(
  p_account_id     UUID,
  p_cast_name      TEXT,
  p_start_date     DATE,
  p_end_date       DATE
) RETURNS TABLE(
  -- 週の識別
  week_start          DATE,
  week_end            DATE,
  week_label          TEXT,

  -- 集計元データ
  transaction_count   BIGINT,
  total_tokens        BIGINT,

  -- 設定値（演算根拠）
  setting_token_to_usd    NUMERIC,
  setting_platform_fee_pct NUMERIC,
  setting_revenue_share_pct NUMERIC,

  -- 演算ステップ
  gross_usd           NUMERIC,
  platform_fee_usd    NUMERIC,
  net_usd             NUMERIC,
  cast_payment_usd    NUMERIC,

  -- 演算式（人間が読める根拠文字列）
  formula_gross       TEXT,
  formula_fee         TEXT,
  formula_net         TEXT,
  formula_payment     TEXT
) AS $$
DECLARE
  v_data_cutoff CONSTANT DATE := '2025-02-15';
  v_actual_start DATE;
BEGIN
  -- 2/15 以前のデータは使用禁止
  v_actual_start := GREATEST(p_start_date, v_data_cutoff);

  RETURN QUERY
  WITH
  -- 月曜 03:00 JST 境界で週番号を割り当て
  -- JST = UTC+9 なので、月曜03:00 JST = 日曜18:00 UTC
  -- date_trunc('week', ...) は月曜起点
  weekly_tx AS (
    SELECT
      -- JST変換してから3時間引いて（03:00境界）、週の月曜に丸める
      DATE_TRUNC('week',
        (ct.date AT TIME ZONE 'Asia/Tokyo' - INTERVAL '3 hours')::DATE
      )::DATE AS w_start,
      ct.tokens
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name  = p_cast_name
      AND ct.date::DATE >= v_actual_start
      AND ct.date::DATE <= p_end_date
      -- 2/15 以前のデータは絶対除外
      AND ct.date::DATE >= v_data_cutoff
  ),
  -- 週ごとに集計
  weekly_agg AS (
    SELECT
      w.w_start,
      (w.w_start + 6)::DATE AS w_end,
      COUNT(*)::BIGINT       AS tx_count,
      COALESCE(SUM(w.tokens), 0)::BIGINT AS sum_tokens
    FROM weekly_tx w
    GROUP BY w.w_start
  ),
  -- コスト設定を結合
  with_settings AS (
    SELECT
      wa.*,
      cs.token_to_usd,
      cs.platform_fee_rate,
      cs.revenue_share_rate
    FROM weekly_agg wa
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(c.token_to_usd, 0.05)       AS token_to_usd,
        COALESCE(c.platform_fee_rate, 40.00)  AS platform_fee_rate,
        COALESCE(c.revenue_share_rate, 50.00) AS revenue_share_rate
      FROM cast_cost_settings c
      WHERE c.account_id = p_account_id
        AND c.cast_name  = p_cast_name
        AND c.effective_from <= wa.w_start
        AND (c.effective_to IS NULL OR c.effective_to >= wa.w_start)
      ORDER BY c.effective_from DESC
      LIMIT 1
    ) cs
  )
  SELECT
    ws.w_start                                          AS week_start,
    ws.w_end                                            AS week_end,
    TO_CHAR(ws.w_start, 'MM/DD') || ' - ' ||
      TO_CHAR(ws.w_end, 'MM/DD')                       AS week_label,
    ws.tx_count                                         AS transaction_count,
    ws.sum_tokens                                       AS total_tokens,

    -- 設定値
    ws.token_to_usd                                     AS setting_token_to_usd,
    ws.platform_fee_rate                                AS setting_platform_fee_pct,
    ws.revenue_share_rate                               AS setting_revenue_share_pct,

    -- 演算ステップ
    ROUND(ws.sum_tokens * ws.token_to_usd, 2)          AS gross_usd,
    ROUND(ws.sum_tokens * ws.token_to_usd
      * (ws.platform_fee_rate / 100), 2)               AS platform_fee_usd,
    ROUND(ws.sum_tokens * ws.token_to_usd
      * (1 - ws.platform_fee_rate / 100), 2)           AS net_usd,
    ROUND(ws.sum_tokens * ws.token_to_usd
      * (1 - ws.platform_fee_rate / 100)
      * (ws.revenue_share_rate / 100), 2)              AS cast_payment_usd,

    -- 演算根拠（人間が読める式）
    ws.sum_tokens || ' tk x $' ||
      TRIM(TO_CHAR(ws.token_to_usd, '0.0000')) ||
      ' = $' || TRIM(TO_CHAR(
        ws.sum_tokens * ws.token_to_usd, '999,999.00'))
                                                        AS formula_gross,

    '$' || TRIM(TO_CHAR(ws.sum_tokens * ws.token_to_usd, '999,999.00')) ||
      ' x ' || TRIM(TO_CHAR(ws.platform_fee_rate, '990.0')) || '% = $' ||
      TRIM(TO_CHAR(ws.sum_tokens * ws.token_to_usd
        * (ws.platform_fee_rate / 100), '999,999.00'))
                                                        AS formula_fee,

    '$' || TRIM(TO_CHAR(ws.sum_tokens * ws.token_to_usd, '999,999.00')) ||
      ' x (1 - ' || TRIM(TO_CHAR(ws.platform_fee_rate, '990.0')) || '%) = $' ||
      TRIM(TO_CHAR(ws.sum_tokens * ws.token_to_usd
        * (1 - ws.platform_fee_rate / 100), '999,999.00'))
                                                        AS formula_net,

    '$' || TRIM(TO_CHAR(ws.sum_tokens * ws.token_to_usd
        * (1 - ws.platform_fee_rate / 100), '999,999.00')) ||
      ' x ' || TRIM(TO_CHAR(ws.revenue_share_rate, '990.0')) || '% = $' ||
      TRIM(TO_CHAR(ws.sum_tokens * ws.token_to_usd
        * (1 - ws.platform_fee_rate / 100)
        * (ws.revenue_share_rate / 100), '999,999.00'))
                                                        AS formula_payment
  FROM with_settings ws
  ORDER BY ws.w_start;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION calculate_revenue_share IS
  '週次レベニューシェア計算。coin_transactions.tokens/dateベース。月曜03:00JST境界。2/15以前除外。';
