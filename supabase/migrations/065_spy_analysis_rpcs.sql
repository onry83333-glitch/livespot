-- ============================================================
-- 065: SPY集計・トレンド分析 RPC関数5本
-- 自社/他社キャストの配信パターン・課金パターン・成長曲線・ゴール達成分析・マーケットトレンド
-- ============================================================

-- 1. 配信パターン分析（配信スケジュール傾向）
-- 曜日×時間帯ごとの配信頻度・視聴者・売上を集計
DROP FUNCTION IF EXISTS public.get_spy_cast_schedule_pattern(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_cast_schedule_pattern(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT,
  day_of_week INTEGER,       -- 0=Sun, 6=Sat
  hour_of_day INTEGER,       -- 0-23 (JST)
  session_count INTEGER,
  avg_duration_min NUMERIC,
  avg_viewers NUMERIC,
  avg_tokens_per_session NUMERIC,
  total_tokens BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH sessions AS (
    SELECT
      sm.cast_name,
      DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo') AS session_date,
      EXTRACT(DOW FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')::INTEGER AS dow,
      EXTRACT(HOUR FROM MIN(sm.message_time) AT TIME ZONE 'Asia/Tokyo')::INTEGER AS start_hour,
      EXTRACT(EPOCH FROM (MAX(sm.message_time) - MIN(sm.message_time))) / 60.0 AS duration_min,
      COALESCE(AVG(
        CASE WHEN sm.msg_type = 'viewer_count' AND sm.metadata->>'total' IS NOT NULL
          THEN (sm.metadata->>'total')::NUMERIC
          ELSE NULL
        END
      ), 0) AS avg_v,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0) AS session_tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
    GROUP BY sm.cast_name, session_date, dow
    HAVING COUNT(*) >= 5  -- 最低5メッセージでセッション判定
  )
  SELECT
    s.cast_name,
    s.dow AS day_of_week,
    s.start_hour AS hour_of_day,
    COUNT(*)::INTEGER AS session_count,
    ROUND(AVG(s.duration_min), 1) AS avg_duration_min,
    ROUND(AVG(s.avg_v), 0) AS avg_viewers,
    ROUND(AVG(s.session_tokens), 0) AS avg_tokens_per_session,
    SUM(s.session_tokens)::BIGINT AS total_tokens
  FROM sessions s
  GROUP BY s.cast_name, s.dow, s.start_hour
  ORDER BY s.cast_name, s.dow, s.start_hour;
END;
$$;

COMMENT ON FUNCTION public.get_spy_cast_schedule_pattern(UUID, TEXT, INTEGER)
  IS '配信パターン分析: 曜日×時間帯ごとの配信頻度・視聴者・売上集計';


-- 2. 課金パターン分析（ユーザー課金行動の傾向）
-- セッション内の課金タイミング・頻度・金額帯を分析
DROP FUNCTION IF EXISTS public.get_user_payment_pattern(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_user_payment_pattern(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT,
  payment_hour INTEGER,       -- 課金が多い時間帯 (JST)
  avg_tip_amount NUMERIC,
  median_tip_amount NUMERIC,
  tip_count BIGINT,
  unique_tippers BIGINT,
  repeat_tipper_count BIGINT, -- 2回以上課金ユーザー数
  avg_tips_per_user NUMERIC,
  whale_count BIGINT,         -- 1000tk+の課金回数
  micro_count BIGINT,         -- 1-49tkの課金回数
  mid_count BIGINT,           -- 50-499tkの課金回数
  high_count BIGINT           -- 500-999tkの課金回数
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH tips AS (
    SELECT
      sm.cast_name,
      EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')::INTEGER AS tip_hour,
      sm.user_name,
      sm.tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.msg_type IN ('tip', 'gift')
      AND sm.tokens > 0
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
  ),
  hourly AS (
    SELECT
      t.cast_name,
      t.tip_hour,
      ROUND(AVG(t.tokens), 1) AS avg_tip,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.tokens)::NUMERIC AS median_tip,
      COUNT(*)::BIGINT AS cnt,
      COUNT(DISTINCT t.user_name)::BIGINT AS unique_cnt,
      COUNT(*) FILTER (WHERE t.tokens >= 1000)::BIGINT AS whale,
      COUNT(*) FILTER (WHERE t.tokens < 50)::BIGINT AS micro,
      COUNT(*) FILTER (WHERE t.tokens >= 50 AND t.tokens < 500)::BIGINT AS mid,
      COUNT(*) FILTER (WHERE t.tokens >= 500 AND t.tokens < 1000)::BIGINT AS high
    FROM tips t
    GROUP BY t.cast_name, t.tip_hour
  ),
  repeaters AS (
    SELECT
      t.cast_name,
      COUNT(DISTINCT t.user_name)::BIGINT AS repeat_cnt
    FROM tips t
    GROUP BY t.cast_name
    HAVING COUNT(*) >= 2
  )
  SELECT
    h.cast_name,
    h.tip_hour AS payment_hour,
    h.avg_tip AS avg_tip_amount,
    ROUND(h.median_tip, 1) AS median_tip_amount,
    h.cnt AS tip_count,
    h.unique_cnt AS unique_tippers,
    COALESCE(r.repeat_cnt, 0) AS repeat_tipper_count,
    CASE WHEN h.unique_cnt > 0 THEN ROUND(h.cnt::NUMERIC / h.unique_cnt, 1) ELSE 0 END AS avg_tips_per_user,
    h.whale AS whale_count,
    h.micro AS micro_count,
    h.mid AS mid_count,
    h.high AS high_count
  FROM hourly h
  LEFT JOIN repeaters r ON r.cast_name = h.cast_name
  ORDER BY h.cast_name, h.tip_hour;
END;
$$;

COMMENT ON FUNCTION public.get_user_payment_pattern(UUID, TEXT, INTEGER)
  IS '課金パターン分析: 時間帯別課金行動（金額帯・リピート率・中央値）';


-- 3. 成長曲線（キャスト別日次KPIトレンド）
-- 視聴者数・売上・チャット速度の時系列推移
DROP FUNCTION IF EXISTS public.get_cast_growth_curve(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_cast_growth_curve(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 90
)
RETURNS TABLE (
  cast_name TEXT,
  report_date DATE,
  tokens BIGINT,
  tip_count BIGINT,
  unique_users BIGINT,
  avg_viewers NUMERIC,
  peak_viewers INTEGER,
  chat_messages BIGINT,
  tokens_7d_avg NUMERIC,     -- 7日移動平均
  viewers_7d_avg NUMERIC      -- 7日移動平均
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH daily AS (
    SELECT
      sm.cast_name,
      DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo') AS d,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS tokens,
      COUNT(*) FILTER (WHERE sm.msg_type IN ('tip', 'gift') AND sm.tokens > 0)::BIGINT AS tip_count,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.user_name IS NOT NULL)::BIGINT AS unique_users,
      ROUND(AVG(
        CASE WHEN sm.msg_type = 'viewer_count' AND sm.metadata->>'total' IS NOT NULL
          THEN (sm.metadata->>'total')::NUMERIC
          ELSE NULL
        END
      ), 0) AS avg_viewers,
      COALESCE(MAX(
        CASE WHEN sm.msg_type = 'viewer_count' AND sm.metadata->>'total' IS NOT NULL
          THEN (sm.metadata->>'total')::INTEGER
          ELSE NULL
        END
      ), 0) AS peak_viewers,
      COUNT(*) FILTER (WHERE sm.msg_type = 'chat')::BIGINT AS chat_messages
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
    GROUP BY sm.cast_name, DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo')
    HAVING COUNT(*) >= 3  -- ノイズ除外
  )
  SELECT
    daily.cast_name,
    daily.d AS report_date,
    daily.tokens,
    daily.tip_count,
    daily.unique_users,
    daily.avg_viewers,
    daily.peak_viewers::INTEGER,
    daily.chat_messages,
    ROUND(AVG(daily.tokens) OVER (
      PARTITION BY daily.cast_name ORDER BY daily.d
      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ), 0) AS tokens_7d_avg,
    ROUND(AVG(daily.avg_viewers) OVER (
      PARTITION BY daily.cast_name ORDER BY daily.d
      ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ), 0) AS viewers_7d_avg
  FROM daily
  ORDER BY daily.cast_name, daily.d;
END;
$$;

COMMENT ON FUNCTION public.get_cast_growth_curve(UUID, TEXT, INTEGER)
  IS '成長曲線: キャスト別日次KPIトレンド（7日移動平均付き）';


-- 4. ゴール達成分析
-- goal メッセージの達成率・金額帯・時間帯を分析
DROP FUNCTION IF EXISTS public.get_goal_achievement_analysis(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_goal_achievement_analysis(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT,
  goal_count BIGINT,
  total_goal_tokens BIGINT,
  avg_goal_tokens NUMERIC,
  sessions_with_goals BIGINT,
  goals_per_session NUMERIC,
  goal_hours JSONB           -- 時間帯別ゴール数 [{hour: 20, count: 5}, ...]
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH goals AS (
    SELECT
      sm.cast_name,
      sm.tokens,
      DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo') AS goal_date,
      EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')::INTEGER AS goal_hour
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.msg_type = 'goal'
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
  ),
  goal_hours_agg AS (
    SELECT
      g.cast_name,
      jsonb_agg(
        jsonb_build_object('hour', gh.goal_hour, 'count', gh.cnt)
        ORDER BY gh.goal_hour
      ) AS hours_json
    FROM goals g
    INNER JOIN (
      SELECT g2.cast_name, g2.goal_hour, COUNT(*)::INTEGER AS cnt
      FROM goals g2
      GROUP BY g2.cast_name, g2.goal_hour
    ) gh ON gh.cast_name = g.cast_name
    GROUP BY g.cast_name
  )
  SELECT
    g.cast_name,
    COUNT(*)::BIGINT AS goal_count,
    COALESCE(SUM(g.tokens), 0)::BIGINT AS total_goal_tokens,
    ROUND(AVG(g.tokens), 0) AS avg_goal_tokens,
    COUNT(DISTINCT g.goal_date)::BIGINT AS sessions_with_goals,
    CASE WHEN COUNT(DISTINCT g.goal_date) > 0
      THEN ROUND(COUNT(*)::NUMERIC / COUNT(DISTINCT g.goal_date), 1)
      ELSE 0
    END AS goals_per_session,
    COALESCE(gh.hours_json, '[]'::JSONB) AS goal_hours
  FROM goals g
  LEFT JOIN goal_hours_agg gh ON gh.cast_name = g.cast_name
  GROUP BY g.cast_name, gh.hours_json
  ORDER BY g.cast_name;
END;
$$;

COMMENT ON FUNCTION public.get_goal_achievement_analysis(UUID, TEXT, INTEGER)
  IS 'ゴール達成分析: ゴール頻度・金額・時間帯傾向';


-- 5. マーケットトレンド（自社+他社の日次推移比較）
-- 市場全体のトレンドと自社ポジション変化を可視化
DROP FUNCTION IF EXISTS public.get_market_trend(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_market_trend(
  p_account_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  report_date DATE,
  own_tokens BIGINT,
  own_viewers NUMERIC,
  own_sessions INTEGER,
  competitor_tokens BIGINT,
  competitor_viewers NUMERIC,
  competitor_sessions INTEGER,
  market_share_pct NUMERIC,  -- 自社トークンシェア%
  own_avg_tip NUMERIC,
  competitor_avg_tip NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH own_casts AS (
    SELECT rc.cast_name
    FROM public.registered_casts rc
    WHERE rc.account_id = p_account_id AND rc.is_active = true
  ),
  daily AS (
    SELECT
      DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo') AS d,
      CASE WHEN oc.cast_name IS NOT NULL THEN 'own' ELSE 'competitor' END AS side,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS tokens,
      ROUND(AVG(
        CASE WHEN sm.msg_type = 'viewer_count' AND sm.metadata->>'total' IS NOT NULL
          THEN (sm.metadata->>'total')::NUMERIC ELSE NULL END
      ), 0) AS avg_viewers,
      COUNT(DISTINCT sm.cast_name)::INTEGER AS sessions,
      CASE WHEN COUNT(*) FILTER (WHERE sm.msg_type IN ('tip', 'gift') AND sm.tokens > 0) > 0
        THEN ROUND(
          SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift') AND sm.tokens > 0)::NUMERIC /
          COUNT(*) FILTER (WHERE sm.msg_type IN ('tip', 'gift') AND sm.tokens > 0),
          1
        )
        ELSE 0
      END AS avg_tip
    FROM public.spy_messages sm
    LEFT JOIN own_casts oc ON oc.cast_name = sm.cast_name
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo'),
             CASE WHEN oc.cast_name IS NOT NULL THEN 'own' ELSE 'competitor' END
  )
  SELECT
    COALESCE(o.d, c.d) AS report_date,
    COALESCE(o.tokens, 0) AS own_tokens,
    COALESCE(o.avg_viewers, 0) AS own_viewers,
    COALESCE(o.sessions, 0) AS own_sessions,
    COALESCE(c.tokens, 0) AS competitor_tokens,
    COALESCE(c.avg_viewers, 0) AS competitor_viewers,
    COALESCE(c.sessions, 0) AS competitor_sessions,
    CASE WHEN COALESCE(o.tokens, 0) + COALESCE(c.tokens, 0) > 0
      THEN ROUND(COALESCE(o.tokens, 0)::NUMERIC / (COALESCE(o.tokens, 0) + COALESCE(c.tokens, 0)) * 100, 1)
      ELSE 0
    END AS market_share_pct,
    COALESCE(o.avg_tip, 0) AS own_avg_tip,
    COALESCE(c.avg_tip, 0) AS competitor_avg_tip
  FROM (SELECT * FROM daily WHERE side = 'own') o
  FULL OUTER JOIN (SELECT * FROM daily WHERE side = 'competitor') c ON o.d = c.d
  ORDER BY COALESCE(o.d, c.d);
END;
$$;

COMMENT ON FUNCTION public.get_market_trend(UUID, INTEGER)
  IS 'マーケットトレンド: 自社vs他社の日次KPI推移と市場シェア';
