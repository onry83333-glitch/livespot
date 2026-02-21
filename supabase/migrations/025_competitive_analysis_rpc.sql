-- 025: Competitive Analysis RPC (8 functions)

-- 1. get_competitor_overview
CREATE OR REPLACE FUNCTION public.get_competitor_overview(
  p_account_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT,
  is_own_cast BOOLEAN,
  total_sessions BIGINT,
  total_hours NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_session NUMERIC,
  avg_peak_viewers NUMERIC,
  unique_tippers BIGINT,
  last_active TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH session_stats AS (
    SELECT
      COALESCE(s.cast_name, s.title) AS cn,
      COUNT(*)::BIGINT AS sess_count,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.started_at + INTERVAL '2 hours') - s.started_at)) / 3600.0
      ), 0)::NUMERIC AS hours,
      COALESCE(SUM(s.total_tokens), 0)::BIGINT AS sess_tokens,
      COALESCE(AVG(s.peak_viewers), 0)::NUMERIC AS avg_peak,
      MAX(s.started_at) AS last_sess
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY COALESCE(s.cast_name, s.title)
  ),
  tip_stats AS (
    SELECT
      sm.cast_name AS cn,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::BIGINT AS tip_tokens,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))::BIGINT AS tippers,
      MAX(sm.message_time) AS last_msg
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY sm.cast_name
  ),
  all_casts AS (
    SELECT cn FROM session_stats
    UNION
    SELECT cn FROM tip_stats
  )
  SELECT
    ac.cn AS cast_name,
    EXISTS (
      SELECT 1 FROM public.registered_casts rc
      WHERE rc.account_id = p_account_id AND rc.cast_name = ac.cn
    ) AS is_own_cast,
    COALESCE(ss.sess_count, 0)::BIGINT AS total_sessions,
    ROUND(COALESCE(ss.hours, 0), 1) AS total_hours,
    COALESCE(ts.tip_tokens, 0)::BIGINT AS total_tokens,
    CASE WHEN COALESCE(ss.sess_count, 0) > 0
      THEN ROUND(COALESCE(ts.tip_tokens, 0)::NUMERIC / ss.sess_count, 0)
      ELSE 0
    END AS avg_tokens_per_session,
    ROUND(COALESCE(ss.avg_peak, 0), 0) AS avg_peak_viewers,
    COALESCE(ts.tippers, 0)::BIGINT AS unique_tippers,
    GREATEST(ss.last_sess, ts.last_msg) AS last_active
  FROM all_casts ac
  LEFT JOIN session_stats ss ON ss.cn = ac.cn
  LEFT JOIN tip_stats ts ON ts.cn = ac.cn
  ORDER BY COALESCE(ts.tip_tokens, 0) DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;


-- 2. get_session_comparison
CREATE OR REPLACE FUNCTION public.get_session_comparison(
  p_account_id UUID,
  p_cast_names TEXT[],
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT,
  session_date DATE,
  duration_minutes NUMERIC,
  total_messages BIGINT,
  total_tokens BIGINT,
  peak_viewers INTEGER,
  avg_viewers NUMERIC,
  tokens_per_minute NUMERIC,
  messages_per_minute NUMERIC,
  tip_count BIGINT,
  gift_count BIGINT,
  unique_chatters BIGINT
) AS $$
BEGIN
  RETURN QUERY
  WITH sess AS (
    SELECT
      COALESCE(s.cast_name, s.title) AS cn,
      s.session_id,
      (s.started_at AT TIME ZONE 'Asia/Tokyo')::DATE AS s_date,
      s.started_at,
      COALESCE(s.ended_at, s.started_at + INTERVAL '2 hours') AS ended,
      s.peak_viewers AS p_viewers,
      EXTRACT(EPOCH FROM (
        COALESCE(s.ended_at, s.started_at + INTERVAL '2 hours') - s.started_at
      )) / 60.0 AS dur_min
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND COALESCE(s.cast_name, s.title) = ANY(p_cast_names)
      AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
  ),
  msg_stats AS (
    SELECT
      sm.session_id,
      COUNT(*)::BIGINT AS msg_count,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::BIGINT AS tokens,
      COUNT(*) FILTER (WHERE sm.msg_type = 'tip')::BIGINT AS tips,
      COUNT(*) FILTER (WHERE sm.msg_type = 'gift')::BIGINT AS gifts,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.msg_type = 'chat')::BIGINT AS chatters
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = ANY(p_cast_names)
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND sm.session_id IS NOT NULL
    GROUP BY sm.session_id
  ),
  viewer_avg AS (
    SELECT
      se.session_id,
      ROUND(AVG(vs.total), 1) AS avg_v
    FROM sess se
    JOIN public.viewer_stats vs
      ON vs.account_id = p_account_id
      AND vs.cast_name = se.cn
      AND vs.recorded_at >= se.started_at
      AND vs.recorded_at <= se.ended
    GROUP BY se.session_id
  )
  SELECT
    se.cn AS cast_name,
    se.s_date AS session_date,
    ROUND(se.dur_min, 1) AS duration_minutes,
    COALESCE(ms.msg_count, 0)::BIGINT AS total_messages,
    COALESCE(ms.tokens, 0)::BIGINT AS total_tokens,
    se.p_viewers AS peak_viewers,
    COALESCE(va.avg_v, 0)::NUMERIC AS avg_viewers,
    CASE WHEN se.dur_min > 0
      THEN ROUND(COALESCE(ms.tokens, 0) / se.dur_min, 2)
      ELSE 0
    END AS tokens_per_minute,
    CASE WHEN se.dur_min > 0
      THEN ROUND(COALESCE(ms.msg_count, 0) / se.dur_min, 2)
      ELSE 0
    END AS messages_per_minute,
    COALESCE(ms.tips, 0)::BIGINT AS tip_count,
    COALESCE(ms.gifts, 0)::BIGINT AS gift_count,
    COALESCE(ms.chatters, 0)::BIGINT AS unique_chatters
  FROM sess se
  LEFT JOIN msg_stats ms ON ms.session_id = se.session_id
  LEFT JOIN viewer_avg va ON va.session_id = se.session_id
  ORDER BY se.cn, se.started_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;


-- 3. get_tip_clustering
CREATE OR REPLACE FUNCTION public.get_tip_clustering(
  p_account_id UUID,
  p_cast_name TEXT,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cluster_start TIMESTAMPTZ,
  cluster_end TIMESTAMPTZ,
  cluster_duration_seconds INTEGER,
  total_tokens BIGINT,
  tip_count BIGINT,
  unique_tippers BIGINT,
  trigger_context TEXT,
  preceding_goal BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH tips AS (
    SELECT
      sm.message_time,
      sm.tokens,
      sm.user_name,
      EXTRACT(EPOCH FROM (
        sm.message_time - LAG(sm.message_time) OVER (ORDER BY sm.message_time)
      )) AS gap_seconds
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = p_cast_name
      AND sm.msg_type IN ('tip', 'gift')
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
  ),
  clustered AS (
    SELECT
      t.*,
      SUM(CASE WHEN t.gap_seconds IS NULL OR t.gap_seconds > 120 THEN 1 ELSE 0 END)
        OVER (ORDER BY t.message_time) AS cluster_id
    FROM tips t
  ),
  cluster_agg AS (
    SELECT
      c.cluster_id,
      MIN(c.message_time) AS c_start,
      MAX(c.message_time) AS c_end,
      EXTRACT(EPOCH FROM (MAX(c.message_time) - MIN(c.message_time)))::INTEGER AS dur_sec,
      COALESCE(SUM(c.tokens), 0)::BIGINT AS tokens,
      COUNT(*)::BIGINT AS cnt,
      COUNT(DISTINCT c.user_name)::BIGINT AS tippers
    FROM clustered c
    GROUP BY c.cluster_id
    HAVING COUNT(*) >= 2
  ),
  context AS (
    SELECT DISTINCT ON (ca.cluster_id)
      ca.cluster_id,
      (
        SELECT string_agg(
          sub.user_name || ': ' || sub.message,
          ' | ' ORDER BY sub.message_time
        )
        FROM (
          SELECT sm2.user_name, sm2.message, sm2.message_time
          FROM public.spy_messages sm2
          WHERE sm2.account_id = p_account_id
            AND sm2.cast_name = p_cast_name
            AND sm2.message_time < ca.c_start
            AND sm2.message_time >= ca.c_start - INTERVAL '5 minutes'
            AND sm2.msg_type = 'chat'
            AND sm2.message IS NOT NULL
          ORDER BY sm2.message_time DESC
          LIMIT 5
        ) sub
      ) AS ctx
    FROM cluster_agg ca
  ),
  goal_check AS (
    SELECT DISTINCT ON (ca.cluster_id)
      ca.cluster_id,
      EXISTS (
        SELECT 1 FROM public.spy_messages sm3
        WHERE sm3.account_id = p_account_id
          AND sm3.cast_name = p_cast_name
          AND sm3.msg_type = 'goal'
          AND sm3.message_time < ca.c_start
          AND sm3.message_time >= ca.c_start - INTERVAL '5 minutes'
      ) AS has_goal
    FROM cluster_agg ca
  )
  SELECT
    ca.c_start AS cluster_start,
    ca.c_end AS cluster_end,
    ca.dur_sec AS cluster_duration_seconds,
    ca.tokens AS total_tokens,
    ca.cnt AS tip_count,
    ca.tippers AS unique_tippers,
    ctx.ctx AS trigger_context,
    COALESCE(gc.has_goal, FALSE) AS preceding_goal
  FROM cluster_agg ca
  LEFT JOIN context ctx ON ctx.cluster_id = ca.cluster_id
  LEFT JOIN goal_check gc ON gc.cluster_id = ca.cluster_id
  ORDER BY ca.tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;


-- 4. get_viewer_trend
CREATE OR REPLACE FUNCTION public.get_viewer_trend(
  p_account_id UUID,
  p_cast_names TEXT[],
  p_session_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  cast_name TEXT,
  recorded_at TIMESTAMPTZ,
  total_viewers INTEGER,
  coin_users INTEGER,
  delta_viewers INTEGER,
  minutes_from_start INTEGER
) AS $$
DECLARE
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
BEGIN
  IF p_session_id IS NOT NULL THEN
    SELECT s.started_at, COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours')
    INTO v_start, v_end
    FROM public.sessions s
    WHERE s.account_id = p_account_id AND s.session_id = p_session_id;
  ELSE
    v_start := NOW() - INTERVAL '24 hours';
    v_end := NOW();
  END IF;

  RETURN QUERY
  WITH ranked AS (
    SELECT
      vs.cast_name,
      vs.recorded_at,
      vs.total AS total_v,
      vs.coin_users AS coin_u,
      (vs.total - LAG(vs.total) OVER (
        PARTITION BY vs.cast_name ORDER BY vs.recorded_at
      ))::INTEGER AS delta,
      EXTRACT(EPOCH FROM (vs.recorded_at - v_start))::INTEGER / 60 AS min_from_start
    FROM public.viewer_stats vs
    WHERE vs.account_id = p_account_id
      AND vs.cast_name = ANY(p_cast_names)
      AND vs.recorded_at >= v_start
      AND vs.recorded_at <= v_end
  )
  SELECT
    r.cast_name,
    r.recorded_at,
    r.total_v AS total_viewers,
    r.coin_u AS coin_users,
    COALESCE(r.delta, 0)::INTEGER AS delta_viewers,
    r.min_from_start AS minutes_from_start
  FROM ranked r
  ORDER BY r.cast_name, r.recorded_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;


-- 5. get_user_overlap
CREATE OR REPLACE FUNCTION public.get_user_overlap(
  p_account_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  user_name TEXT,
  casts_visited TEXT[],
  total_tokens_all BIGINT,
  primary_cast TEXT,
  loyalty_score FLOAT,
  is_potential_steal BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH per_cast AS (
    SELECT
      sm.user_name,
      sm.cast_name,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::BIGINT AS cast_tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND sm.user_name IS NOT NULL
      AND sm.user_name != ''
    GROUP BY sm.user_name, sm.cast_name
  ),
  multi_cast_users AS (
    SELECT
      pc.user_name,
      ARRAY_AGG(DISTINCT pc.cast_name ORDER BY pc.cast_name) AS visited,
      SUM(pc.cast_tokens)::BIGINT AS total_tokens
    FROM per_cast pc
    GROUP BY pc.user_name
    HAVING COUNT(DISTINCT pc.cast_name) >= 2
  ),
  primary_cte AS (
    SELECT DISTINCT ON (pc.user_name)
      pc.user_name,
      pc.cast_name AS top_cast,
      pc.cast_tokens
    FROM per_cast pc
    WHERE pc.user_name IN (SELECT mcu.user_name FROM multi_cast_users mcu)
    ORDER BY pc.user_name, pc.cast_tokens DESC
  ),
  own_cast_tokens AS (
    SELECT
      pc.user_name,
      COALESCE(SUM(pc.cast_tokens), 0)::BIGINT AS own_tokens
    FROM per_cast pc
    WHERE pc.user_name IN (SELECT mcu.user_name FROM multi_cast_users mcu)
      AND EXISTS (
        SELECT 1 FROM public.registered_casts rc
        WHERE rc.account_id = p_account_id AND rc.cast_name = pc.cast_name
      )
    GROUP BY pc.user_name
  )
  SELECT
    mcu.user_name,
    mcu.visited AS casts_visited,
    mcu.total_tokens AS total_tokens_all,
    pr.top_cast AS primary_cast,
    CASE WHEN mcu.total_tokens > 0
      THEN ROUND(COALESCE(oct.own_tokens, 0)::FLOAT / mcu.total_tokens::FLOAT, 3)
      ELSE 0.0
    END::FLOAT AS loyalty_score,
    (
      COALESCE(oct.own_tokens, 0) > 0
      AND COALESCE(oct.own_tokens, 0)::FLOAT < mcu.total_tokens::FLOAT * 0.5
    ) AS is_potential_steal
  FROM multi_cast_users mcu
  LEFT JOIN primary_cte pr ON pr.user_name = mcu.user_name
  LEFT JOIN own_cast_tokens oct ON oct.user_name = mcu.user_name
  ORDER BY mcu.total_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;


-- 6. get_hourly_heatmap
CREATE OR REPLACE FUNCTION public.get_hourly_heatmap(
  p_account_id UUID,
  p_cast_names TEXT[],
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT,
  day_of_week INTEGER,
  hour_jst INTEGER,
  avg_viewers FLOAT,
  avg_tokens_per_hour FLOAT,
  session_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  WITH msg_hourly AS (
    SELECT
      sm.cast_name AS cn,
      EXTRACT(DOW FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')::INTEGER AS dow,
      EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')::INTEGER AS hr,
      (sm.message_time AT TIME ZONE 'Asia/Tokyo')::DATE AS msg_date,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0) AS hour_tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = ANY(p_cast_names)
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY sm.cast_name,
      EXTRACT(DOW FROM sm.message_time AT TIME ZONE 'Asia/Tokyo'),
      EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo'),
      (sm.message_time AT TIME ZONE 'Asia/Tokyo')::DATE
  ),
  viewer_hourly AS (
    SELECT
      vs.cast_name AS cn,
      EXTRACT(DOW FROM vs.recorded_at AT TIME ZONE 'Asia/Tokyo')::INTEGER AS dow,
      EXTRACT(HOUR FROM vs.recorded_at AT TIME ZONE 'Asia/Tokyo')::INTEGER AS hr,
      AVG(vs.total)::FLOAT AS avg_v
    FROM public.viewer_stats vs
    WHERE vs.account_id = p_account_id
      AND vs.cast_name = ANY(p_cast_names)
      AND vs.recorded_at >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY vs.cast_name,
      EXTRACT(DOW FROM vs.recorded_at AT TIME ZONE 'Asia/Tokyo'),
      EXTRACT(HOUR FROM vs.recorded_at AT TIME ZONE 'Asia/Tokyo')
  )
  SELECT
    mh.cn AS cast_name,
    mh.dow AS day_of_week,
    mh.hr AS hour_jst,
    COALESCE(vh.avg_v, 0)::FLOAT AS avg_viewers,
    ROUND(SUM(mh.hour_tokens)::FLOAT / NULLIF(COUNT(DISTINCT mh.msg_date), 0), 1)::FLOAT AS avg_tokens_per_hour,
    COUNT(DISTINCT mh.msg_date)::BIGINT AS session_count
  FROM msg_hourly mh
  LEFT JOIN viewer_hourly vh
    ON vh.cn = mh.cn AND vh.dow = mh.dow AND vh.hr = mh.hr
  GROUP BY mh.cn, mh.dow, mh.hr, vh.avg_v
  ORDER BY mh.cn, mh.dow, mh.hr;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;


-- 7. get_success_patterns
CREATE OR REPLACE FUNCTION public.get_success_patterns(
  p_account_id UUID,
  p_min_tokens INTEGER DEFAULT 10000
)
RETURNS TABLE (
  cast_name TEXT,
  session_id TEXT,
  session_date DATE,
  total_tokens BIGINT,
  duration_minutes NUMERIC,
  peak_viewers INTEGER,
  first_tip_minute INTEGER,
  tip_concentration_ratio FLOAT,
  chat_density FLOAT,
  goal_count BIGINT,
  start_hour_jst INTEGER,
  day_of_week INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH high_sessions AS (
    SELECT
      COALESCE(s.cast_name, s.title) AS cn,
      s.session_id,
      (s.started_at AT TIME ZONE 'Asia/Tokyo')::DATE AS s_date,
      s.started_at,
      COALESCE(s.ended_at, s.started_at + INTERVAL '2 hours') AS ended,
      s.total_tokens AS sess_tokens,
      EXTRACT(EPOCH FROM (
        COALESCE(s.ended_at, s.started_at + INTERVAL '2 hours') - s.started_at
      )) / 60.0 AS dur_min,
      s.peak_viewers AS p_viewers,
      EXTRACT(HOUR FROM s.started_at AT TIME ZONE 'Asia/Tokyo')::INTEGER AS start_hr,
      EXTRACT(DOW FROM s.started_at AT TIME ZONE 'Asia/Tokyo')::INTEGER AS dow
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND s.total_tokens >= p_min_tokens
  ),
  first_tips AS (
    SELECT DISTINCT ON (sm.session_id)
      sm.session_id,
      EXTRACT(EPOCH FROM (sm.message_time - hs.started_at))::INTEGER / 60 AS first_min
    FROM public.spy_messages sm
    JOIN high_sessions hs ON hs.session_id = sm.session_id
    WHERE sm.account_id = p_account_id
      AND sm.msg_type IN ('tip', 'gift')
      AND sm.tokens > 0
    ORDER BY sm.session_id, sm.message_time
  ),
  tip_concentration AS (
    SELECT
      sm.session_id,
      CASE WHEN SUM(sm.tokens) > 0
        THEN (
          SELECT COALESCE(SUM(sub.user_tokens), 0)::FLOAT / SUM(sm.tokens)::FLOAT
          FROM (
            SELECT SUM(sm2.tokens) AS user_tokens
            FROM public.spy_messages sm2
            WHERE sm2.account_id = p_account_id
              AND sm2.session_id = sm.session_id
              AND sm2.msg_type IN ('tip', 'gift')
            GROUP BY sm2.user_name
            ORDER BY SUM(sm2.tokens) DESC
            LIMIT 3
          ) sub
        )
        ELSE 0.0
      END::FLOAT AS concentration
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id IN (SELECT hs2.session_id FROM high_sessions hs2)
      AND sm.msg_type IN ('tip', 'gift')
    GROUP BY sm.session_id
  ),
  chat_stats AS (
    SELECT
      sm.session_id,
      COUNT(*) FILTER (WHERE sm.msg_type = 'chat')::FLOAT AS chat_count,
      COUNT(*) FILTER (WHERE sm.msg_type = 'goal')::BIGINT AS goals
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id IN (SELECT hs3.session_id FROM high_sessions hs3)
    GROUP BY sm.session_id
  )
  SELECT
    hs.cn AS cast_name,
    hs.session_id,
    hs.s_date AS session_date,
    hs.sess_tokens::BIGINT AS total_tokens,
    ROUND(hs.dur_min, 1) AS duration_minutes,
    hs.p_viewers AS peak_viewers,
    COALESCE(ft.first_min, -1)::INTEGER AS first_tip_minute,
    ROUND(COALESCE(tc.concentration, 0)::NUMERIC, 3)::FLOAT AS tip_concentration_ratio,
    CASE WHEN hs.dur_min > 0
      THEN ROUND(COALESCE(cs.chat_count, 0) / hs.dur_min, 2)::FLOAT
      ELSE 0.0
    END AS chat_density,
    COALESCE(cs.goals, 0)::BIGINT AS goal_count,
    hs.start_hr AS start_hour_jst,
    hs.dow AS day_of_week
  FROM high_sessions hs
  LEFT JOIN first_tips ft ON ft.session_id = hs.session_id
  LEFT JOIN tip_concentration tc ON tc.session_id = hs.session_id
  LEFT JOIN chat_stats cs ON cs.session_id = hs.session_id
  ORDER BY hs.sess_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;


-- 8. get_cast_ranking
CREATE OR REPLACE FUNCTION public.get_cast_ranking(
  p_account_id UUID,
  p_metric TEXT DEFAULT 'tokens',
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  rank INTEGER,
  cast_name TEXT,
  is_own_cast BOOLEAN,
  metric_value NUMERIC,
  prev_period_value NUMERIC,
  change_pct FLOAT
) AS $$
BEGIN
  RETURN QUERY
  WITH current_period AS (
    SELECT
      sm.cast_name AS cn,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::NUMERIC AS total_tokens,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))::NUMERIC AS unique_tippers,
      COUNT(*) FILTER (WHERE sm.msg_type = 'chat')::NUMERIC AS chat_messages
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY sm.cast_name
  ),
  current_sessions AS (
    SELECT
      COALESCE(s.cast_name, s.title) AS cn,
      AVG(s.peak_viewers)::NUMERIC AS avg_peak,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.started_at + INTERVAL '2 hours') - s.started_at)) / 3600.0
      ), 0)::NUMERIC AS total_hours
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY COALESCE(s.cast_name, s.title)
  ),
  prev_period AS (
    SELECT
      sm.cast_name AS cn,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.msg_type IN ('tip', 'gift')), 0)::NUMERIC AS total_tokens,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.msg_type IN ('tip', 'gift'))::NUMERIC AS unique_tippers,
      COUNT(*) FILTER (WHERE sm.msg_type = 'chat')::NUMERIC AS chat_messages
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= NOW() - (p_days * 2 || ' days')::INTERVAL
      AND sm.message_time < NOW() - (p_days || ' days')::INTERVAL
    GROUP BY sm.cast_name
  ),
  prev_sessions AS (
    SELECT
      COALESCE(s.cast_name, s.title) AS cn,
      AVG(s.peak_viewers)::NUMERIC AS avg_peak,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.started_at + INTERVAL '2 hours') - s.started_at)) / 3600.0
      ), 0)::NUMERIC AS total_hours
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND s.started_at >= NOW() - (p_days * 2 || ' days')::INTERVAL
      AND s.started_at < NOW() - (p_days || ' days')::INTERVAL
    GROUP BY COALESCE(s.cast_name, s.title)
  ),
  all_casts AS (
    SELECT cn FROM current_period
    UNION
    SELECT cn FROM current_sessions
  ),
  metrics AS (
    SELECT
      ac.cn,
      CASE p_metric
        WHEN 'tokens'     THEN COALESCE(cp.total_tokens, 0)
        WHEN 'viewers'    THEN ROUND(COALESCE(cs.avg_peak, 0), 1)
        WHEN 'engagement' THEN
          CASE WHEN COALESCE(cs.avg_peak, 0) > 0
            THEN ROUND(COALESCE(cp.chat_messages, 0) / cs.avg_peak, 2)
            ELSE 0
          END
        WHEN 'tippers'    THEN COALESCE(cp.unique_tippers, 0)
        WHEN 'duration'   THEN ROUND(COALESCE(cs.total_hours, 0), 1)
        ELSE COALESCE(cp.total_tokens, 0)
      END AS cur_val,
      CASE p_metric
        WHEN 'tokens'     THEN COALESCE(pp.total_tokens, 0)
        WHEN 'viewers'    THEN ROUND(COALESCE(ps.avg_peak, 0), 1)
        WHEN 'engagement' THEN
          CASE WHEN COALESCE(ps.avg_peak, 0) > 0
            THEN ROUND(COALESCE(pp.chat_messages, 0) / ps.avg_peak, 2)
            ELSE 0
          END
        WHEN 'tippers'    THEN COALESCE(pp.unique_tippers, 0)
        WHEN 'duration'   THEN ROUND(COALESCE(ps.total_hours, 0), 1)
        ELSE COALESCE(pp.total_tokens, 0)
      END AS prev_val
    FROM all_casts ac
    LEFT JOIN current_period cp ON cp.cn = ac.cn
    LEFT JOIN current_sessions cs ON cs.cn = ac.cn
    LEFT JOIN prev_period pp ON pp.cn = ac.cn
    LEFT JOIN prev_sessions ps ON ps.cn = ac.cn
  )
  SELECT
    RANK() OVER (ORDER BY m.cur_val DESC)::INTEGER AS rank,
    m.cn AS cast_name,
    EXISTS (
      SELECT 1 FROM public.registered_casts rc
      WHERE rc.account_id = p_account_id AND rc.cast_name = m.cn
    ) AS is_own_cast,
    m.cur_val AS metric_value,
    m.prev_val AS prev_period_value,
    CASE WHEN m.prev_val > 0
      THEN ROUND(((m.cur_val - m.prev_val) / m.prev_val * 100)::NUMERIC, 1)::FLOAT
      ELSE CASE WHEN m.cur_val > 0 THEN 100.0 ELSE 0.0 END::FLOAT
    END AS change_pct
  FROM metrics m
  WHERE m.cur_val > 0 OR m.prev_val > 0
  ORDER BY m.cur_val DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public;
