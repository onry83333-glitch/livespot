-- ============================================================
-- 058: 他社SPYマーケット分析RPC
-- spy_messages の viewer_count (metadata.total) + tip/gift データから
-- 時間帯別視聴者トレンド・課金タイプ分布を集計
-- ============================================================

-- 1. 時間帯別視聴者数推移（他社キャスト）
-- viewer_count の msg_type 行から metadata->>'total' を使用
DROP FUNCTION IF EXISTS public.get_spy_viewer_trends(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_viewer_trends(
  p_account_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  cast_name TEXT,
  hour_of_day INTEGER,
  avg_viewers NUMERIC,
  max_viewers INTEGER,
  broadcast_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.cast_name,
    EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')::INTEGER AS hour_of_day,
    ROUND(AVG((sm.metadata->>'total')::NUMERIC), 0) AS avg_viewers,
    MAX((sm.metadata->>'total')::INTEGER) AS max_viewers,
    COUNT(DISTINCT DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo'))::INTEGER AS broadcast_count
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.msg_type = 'viewer_count'
    AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    AND sm.metadata->>'total' IS NOT NULL
    AND (sm.metadata->>'total')::INTEGER > 0
    AND sm.cast_name NOT IN (
      SELECT rc.cast_name FROM public.registered_casts rc
      WHERE rc.account_id = p_account_id
    )
  GROUP BY sm.cast_name, EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')
  ORDER BY sm.cast_name, hour_of_day;
END;
$$;

COMMENT ON FUNCTION public.get_spy_viewer_trends(UUID, INTEGER)
  IS '他社キャストの時間帯別視聴者数推移（viewer_count metadata.total）';


-- 2. 他社キャストの課金タイプ分布
-- spy_messages の msg_type + tokens で集計
DROP FUNCTION IF EXISTS public.get_spy_revenue_types(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_revenue_types(
  p_account_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  cast_name TEXT,
  tip_count BIGINT,
  ticket_count BIGINT,
  group_count BIGINT,
  total_tokens BIGINT,
  broadcast_days INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.cast_name,
    COUNT(*) FILTER (WHERE sm.msg_type IN ('tip', 'gift') AND sm.tokens > 0)::BIGINT AS tip_count,
    COUNT(*) FILTER (WHERE sm.msg_type = 'goal')::BIGINT AS ticket_count,
    COUNT(*) FILTER (WHERE sm.msg_type IN ('group_join', 'group_end'))::BIGINT AS group_count,
    COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS total_tokens,
    COUNT(DISTINCT DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo'))::INTEGER AS broadcast_days
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    AND sm.cast_name NOT IN (
      SELECT rc.cast_name FROM public.registered_casts rc
      WHERE rc.account_id = p_account_id
    )
  GROUP BY sm.cast_name;
END;
$$;

COMMENT ON FUNCTION public.get_spy_revenue_types(UUID, INTEGER)
  IS '他社キャストの課金タイプ分布（チップ/チケット/グループ）';


-- 3. 現在の時間帯のマーケット概況サマリー
-- 配信前モードのワンライナー用
DROP FUNCTION IF EXISTS public.get_spy_market_now(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_market_now(
  p_account_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  current_hour INTEGER,
  active_casts INTEGER,
  avg_viewers_now NUMERIC,
  best_cast TEXT,
  best_viewers INTEGER,
  own_avg_viewers NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_hour INTEGER;
BEGIN
  v_hour := EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tokyo')::INTEGER;

  RETURN QUERY
  WITH
  spy_hourly AS (
    SELECT
      sm.cast_name,
      ROUND(AVG((sm.metadata->>'total')::NUMERIC), 0) AS avg_v,
      MAX((sm.metadata->>'total')::INTEGER) AS max_v
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.msg_type = 'viewer_count'
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND sm.metadata->>'total' IS NOT NULL
      AND (sm.metadata->>'total')::INTEGER > 0
      AND EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo') = v_hour
      AND sm.cast_name NOT IN (
        SELECT rc.cast_name FROM public.registered_casts rc
        WHERE rc.account_id = p_account_id
      )
    GROUP BY sm.cast_name
  ),
  own_hourly AS (
    SELECT
      ROUND(AVG((sm.metadata->>'total')::NUMERIC), 0) AS avg_v
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.msg_type = 'viewer_count'
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND sm.metadata->>'total' IS NOT NULL
      AND (sm.metadata->>'total')::INTEGER > 0
      AND EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo') = v_hour
      AND sm.cast_name IN (
        SELECT rc.cast_name FROM public.registered_casts rc
        WHERE rc.account_id = p_account_id
      )
  ),
  best AS (
    SELECT sh.cast_name, sh.max_v
    FROM spy_hourly sh
    ORDER BY sh.avg_v DESC
    LIMIT 1
  )
  SELECT
    v_hour AS current_hour,
    COUNT(*)::INTEGER AS active_casts,
    ROUND(AVG(sh.avg_v), 0) AS avg_viewers_now,
    (SELECT b.cast_name FROM best b) AS best_cast,
    (SELECT b.max_v FROM best b) AS best_viewers,
    (SELECT oh.avg_v FROM own_hourly oh) AS own_avg_viewers
  FROM spy_hourly sh;
END;
$$;

COMMENT ON FUNCTION public.get_spy_market_now(UUID, INTEGER)
  IS '現在時刻のマーケット概況（他社視聴者平均・ベストキャスト・自社比較）';
