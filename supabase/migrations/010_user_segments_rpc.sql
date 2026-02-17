-- Migration 010: get_user_segments RPC
-- spy_messagesからキャスト別のユーザーセグメント分析を実行
-- paid_usersはcast_nameを持たないため、spy_messages.tokensを使用

CREATE OR REPLACE FUNCTION get_user_segments(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  result JSONB := '[]'::JSONB;
BEGIN
  WITH user_agg AS (
    -- spy_messages からキャスト別のユーザー消費額を集計
    SELECT
      sm.user_name,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS total_coins,
      MAX(sm.message_time) AS last_seen
    FROM spy_messages sm
    WHERE sm.account_id = p_account_id
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
      AND sm.user_name IS NOT NULL
      AND sm.user_name != ''
    GROUP BY sm.user_name
    HAVING SUM(sm.tokens) FILTER (WHERE sm.tokens > 0) > 0
  ),
  classified AS (
    -- S1-S10 セグメント分類（コイン累計 × 最終課金日の2軸）
    SELECT
      user_name, total_coins, last_seen,
      CASE
        WHEN total_coins >= 5000 AND last_seen >= NOW() - INTERVAL '7 days'  THEN 'S1'
        WHEN total_coins >= 5000 AND last_seen >= NOW() - INTERVAL '90 days' THEN 'S2'
        WHEN total_coins >= 5000 THEN 'S3'
        WHEN total_coins >= 1000 AND last_seen >= NOW() - INTERVAL '7 days'  THEN 'S4'
        WHEN total_coins >= 1000 AND last_seen >= NOW() - INTERVAL '90 days' THEN 'S5'
        WHEN total_coins >= 1000 THEN 'S6'
        WHEN total_coins >= 300  AND last_seen >= NOW() - INTERVAL '30 days' THEN 'S7'
        WHEN total_coins >= 300  THEN 'S8'
        WHEN total_coins >= 50   THEN 'S9'
        ELSE 'S10'
      END AS seg_id
    FROM user_agg
  ),
  seg_users AS (
    -- セグメントごとのユーザーリスト（上位100名、コイン降順）
    SELECT
      seg_id,
      jsonb_agg(
        jsonb_build_object(
          'user_name', user_name,
          'total_coins', total_coins,
          'last_payment_date', last_seen
        ) ORDER BY total_coins DESC
      ) FILTER (WHERE rn <= 100) AS users_json
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY seg_id ORDER BY total_coins DESC) AS rn
      FROM classified
    ) ranked
    GROUP BY seg_id
  ),
  seg_agg AS (
    -- セグメント別集計
    SELECT
      c.seg_id,
      COUNT(*)::INTEGER AS user_count,
      COALESCE(SUM(c.total_coins), 0)::BIGINT AS seg_total_coins,
      CASE WHEN COUNT(*) > 0 THEN (SUM(c.total_coins) / COUNT(*))::BIGINT ELSE 0 END AS avg_coins
    FROM classified c
    GROUP BY c.seg_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'segment_id', sa.seg_id,
      'segment_name', CASE sa.seg_id
        WHEN 'S1'  THEN 'VIP現役'
        WHEN 'S2'  THEN 'VIP準現役'
        WHEN 'S3'  THEN 'VIP休眠'
        WHEN 'S4'  THEN '常連現役'
        WHEN 'S5'  THEN '常連離脱危機'
        WHEN 'S6'  THEN '常連休眠'
        WHEN 'S7'  THEN '中堅現役'
        WHEN 'S8'  THEN '中堅休眠'
        WHEN 'S9'  THEN 'ライト'
        WHEN 'S10' THEN '単発/新規'
      END,
      'tier', CASE
        WHEN sa.seg_id IN ('S1','S2','S3') THEN 'VIP（5000tk+）'
        WHEN sa.seg_id IN ('S4','S5','S6') THEN '常連（1000-4999tk）'
        WHEN sa.seg_id IN ('S7','S8')      THEN '中堅（300-999tk）'
        WHEN sa.seg_id = 'S9'              THEN 'ライト（50-299tk）'
        ELSE '単発（50tk未満）'
      END,
      'recency', CASE
        WHEN sa.seg_id IN ('S1','S4') THEN '7日以内'
        WHEN sa.seg_id IN ('S2','S5') THEN '90日以内'
        WHEN sa.seg_id = 'S7'         THEN '30日以内'
        ELSE '休眠/その他'
      END,
      'priority', CASE
        WHEN sa.seg_id = 'S1'                   THEN '最優先'
        WHEN sa.seg_id IN ('S2','S4')            THEN '高'
        WHEN sa.seg_id IN ('S3','S5','S7')       THEN '中'
        WHEN sa.seg_id IN ('S6','S8')            THEN '通常'
        ELSE '低'
      END,
      'user_count', sa.user_count,
      'total_coins', sa.seg_total_coins,
      'avg_coins', sa.avg_coins,
      'users', COALESCE(su.users_json, '[]'::JSONB)
    ) ORDER BY sa.seg_id
  ), '[]'::JSONB)
  INTO result
  FROM seg_agg sa
  LEFT JOIN seg_users su ON su.seg_id = sa.seg_id;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
