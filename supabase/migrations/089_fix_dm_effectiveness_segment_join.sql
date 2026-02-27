-- ============================================================
-- 089: get_dm_effectiveness_by_segment のセグメントJOIN修正
--
-- 問題: paid_users との LEFT JOIN で pu.cast_name = ds.cast_name を
--       要求していたが、paid_users はユニーク制約 (account_id, user_name)
--       で1ユーザー1行。cast_name は「最多課金キャスト（dominant cast）」
--       を保存しているため、DM送信先キャストとdominant castが異なる
--       ユーザーのJOINが失敗し、segment が 'unknown' になっていた。
--
-- 修正: paid_users JOIN から cast_name 条件を除去。
--       segment はユーザーレベルの属性であり、キャスト別ではない。
--
-- ROLLBACK:
--   -- 060_dm_effectiveness_v2.sql の関数を再適用すれば復旧
-- ============================================================

CREATE OR REPLACE FUNCTION get_dm_effectiveness_by_segment(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  campaign TEXT,
  segment TEXT,
  sent_count BIGINT,
  visited_count BIGINT,
  paid_count BIGINT,
  visit_cvr NUMERIC,
  payment_cvr NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_payer NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH dm_sent AS (
    -- 成功したDM送信ログ
    SELECT
      d.user_name,
      d.campaign,
      d.cast_name,
      d.sent_at
    FROM dm_send_log d
    WHERE d.account_id = p_account_id
      AND d.status = 'success'
      AND d.sent_at >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR d.cast_name = p_cast_name)
  ),
  dm_with_segment AS (
    -- セグメント情報を付与
    -- paid_users は (account_id, user_name) でユニーク。
    -- cast_name は dominant cast なので、DM送信先キャストと
    -- 一致するとは限らない。cast_name 条件なしで結合する。
    SELECT
      ds.user_name,
      ds.campaign,
      ds.cast_name,
      ds.sent_at,
      COALESCE(pu.segment, 'unknown') AS user_segment
    FROM dm_sent ds
    LEFT JOIN paid_users pu
      ON pu.account_id = p_account_id
      AND pu.user_name = ds.user_name
  ),
  visit_check AS (
    -- DM送信後24h以内のspy_messages出現チェック
    SELECT DISTINCT
      dws.user_name,
      dws.campaign,
      dws.user_segment
    FROM dm_with_segment dws
    WHERE EXISTS (
      SELECT 1 FROM spy_messages sm
      WHERE sm.account_id = p_account_id
        AND sm.user_name = dws.user_name
        AND sm.cast_name = dws.cast_name
        AND sm.message_time BETWEEN dws.sent_at AND dws.sent_at + INTERVAL '24 hours'
    )
  ),
  payment_check AS (
    -- DM送信後48h以内のcoin_transactions出現チェック
    SELECT DISTINCT
      dws.user_name,
      dws.campaign,
      dws.user_segment,
      ct_sum.total_tk
    FROM dm_with_segment dws
    INNER JOIN LATERAL (
      SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tk
      FROM coin_transactions ct
      WHERE ct.account_id = p_account_id
        AND ct.user_name = dws.user_name
        AND ct.cast_name = dws.cast_name
        AND ct.date BETWEEN dws.sent_at AND dws.sent_at + INTERVAL '48 hours'
    ) ct_sum ON ct_sum.total_tk > 0
  )
  SELECT
    dws.campaign,
    dws.user_segment AS segment,
    COUNT(DISTINCT dws.user_name)::BIGINT AS sent_count,
    COUNT(DISTINCT vc.user_name)::BIGINT AS visited_count,
    COUNT(DISTINCT pc.user_name)::BIGINT AS paid_count,
    ROUND(
      COUNT(DISTINCT vc.user_name) * 100.0 / NULLIF(COUNT(DISTINCT dws.user_name), 0),
      1
    ) AS visit_cvr,
    ROUND(
      COUNT(DISTINCT pc.user_name) * 100.0 / NULLIF(COUNT(DISTINCT dws.user_name), 0),
      1
    ) AS payment_cvr,
    COALESCE(SUM(pc.total_tk), 0)::BIGINT AS total_tokens,
    ROUND(
      COALESCE(SUM(pc.total_tk), 0)::NUMERIC / NULLIF(COUNT(DISTINCT pc.user_name), 0),
      0
    ) AS avg_tokens_per_payer
  FROM dm_with_segment dws
  LEFT JOIN visit_check vc
    ON vc.user_name = dws.user_name
    AND vc.campaign = dws.campaign
    AND vc.user_segment = dws.user_segment
  LEFT JOIN payment_check pc
    ON pc.user_name = dws.user_name
    AND pc.campaign = dws.campaign
    AND pc.user_segment = dws.user_segment
  GROUP BY dws.campaign, dws.user_segment
  ORDER BY COUNT(DISTINCT dws.user_name) DESC, dws.campaign;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
