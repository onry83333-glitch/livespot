-- ============================================================
-- 112: 売上集計からstudio payout（スタジオ週次精算）を除外
--
-- 問題: coin_transactions の type='studio' は過去配信の精算トランザクション。
--       売上集計に含めると実際の配信売上と大幅に乖離する
--       （例: Risa_06 今週 48,129tk表示 → 実際は約9,040tk）
--
-- 修正: 売上関連の全RPCに AND ct.type != 'studio' を追加
--
-- ROLLBACK:
--   -- 各RPCをDROP後、元のmigrationから再適用:
--   -- get_weekly_coin_stats → 091
--   -- get_monthly_pl / get_session_pl → 082
--   -- get_session_list_v2 / get_session_summary_v2 → 111
--   -- get_session_revenue_breakdown → 110
-- ============================================================

-- ============================================================
-- 1. get_weekly_coin_stats
-- ============================================================
DROP FUNCTION IF EXISTS get_weekly_coin_stats(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION get_weekly_coin_stats(
  p_account_id UUID,
  p_cast_names TEXT[],
  p_this_week_start TIMESTAMPTZ,
  p_last_week_start TIMESTAMPTZ,
  p_today_start TIMESTAMPTZ
)
RETURNS TABLE(
  cast_name TEXT,
  this_week INTEGER,
  last_week INTEGER,
  today INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.cast_name,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_this_week_start), 0)::INTEGER AS this_week,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_last_week_start AND ct.date < p_this_week_start), 0)::INTEGER AS last_week,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_today_start), 0)::INTEGER AS today
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = ANY(p_cast_names)
    AND ct.date >= p_last_week_start
    AND ct.tokens > 0
    AND ct.type != 'studio'
  GROUP BY ct.cast_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 2. get_monthly_pl
-- ============================================================
DROP FUNCTION IF EXISTS get_monthly_pl(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION get_monthly_pl(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_months INTEGER DEFAULT 6
) RETURNS TABLE(
  month TEXT,
  cast_name TEXT,
  total_sessions BIGINT,
  total_hours NUMERIC,
  total_tokens BIGINT,
  gross_revenue_jpy NUMERIC,
  platform_fee_jpy NUMERIC,
  net_revenue_jpy NUMERIC,
  total_cast_cost_jpy NUMERIC,
  monthly_fixed_cost_jpy INTEGER,
  gross_profit_jpy NUMERIC,
  profit_margin NUMERIC
) AS $$
  WITH
  session_agg AS (
    SELECT
      TO_CHAR(s.started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS s_month,
      s.cast_name AS s_cast,
      COUNT(*)::BIGINT AS s_count,
      ROUND(SUM(
        CASE WHEN s.ended_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 3600
          ELSE 0
        END
      )::NUMERIC, 1) AS s_hours
    FROM sessions s
    WHERE s.account_id = p_account_id
      AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
      AND s.started_at >= (DATE_TRUNC('month', NOW()) - (p_months || ' months')::INTERVAL)
    GROUP BY 1, 2
  ),
  revenue_agg AS (
    SELECT
      TO_CHAR(ct.date AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM') AS r_month,
      ct.cast_name AS r_cast,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS r_tokens
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
      AND ct.date >= (DATE_TRUNC('month', NOW()) - (p_months || ' months')::INTERVAL)
      AND ct.tokens > 0
      AND ct.type != 'studio'
    GROUP BY 1, 2
  ),
  combined AS (
    SELECT
      COALESCE(sa.s_month, ra.r_month) AS c_month,
      COALESCE(sa.s_cast, ra.r_cast) AS c_cast,
      COALESCE(sa.s_count, 0)::BIGINT AS c_sessions,
      COALESCE(sa.s_hours, 0)::NUMERIC AS c_hours,
      COALESCE(ra.r_tokens, 0)::BIGINT AS c_tokens
    FROM session_agg sa
    FULL OUTER JOIN revenue_agg ra
      ON sa.s_month = ra.r_month AND sa.s_cast = ra.r_cast
  )
  SELECT
    cm.c_month AS month,
    cm.c_cast AS cast_name,
    cm.c_sessions AS total_sessions,
    cm.c_hours AS total_hours,
    cm.c_tokens AS total_tokens,
    cm.c_tokens * AVG(c.token_to_jpy) AS gross_revenue_jpy,
    cm.c_tokens * AVG(c.token_to_jpy) * (AVG(c.platform_fee_rate) / 100) AS platform_fee_jpy,
    cm.c_tokens * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100) AS net_revenue_jpy,
    ROUND((cm.c_hours * AVG(c.hourly_rate))::NUMERIC, 0) AS total_cast_cost_jpy,
    MAX(c.monthly_fixed_cost) AS monthly_fixed_cost_jpy,
    cm.c_tokens * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100)
      - (cm.c_hours * AVG(c.hourly_rate))
      - MAX(c.monthly_fixed_cost) AS gross_profit_jpy,
    CASE WHEN cm.c_tokens > 0
      THEN ROUND(
        ((cm.c_tokens * AVG(c.token_to_jpy) * (1 - AVG(c.platform_fee_rate) / 100)
          - (cm.c_hours * AVG(c.hourly_rate))
          - MAX(c.monthly_fixed_cost))
        / (cm.c_tokens * AVG(c.token_to_jpy))) * 100, 1)
      ELSE 0
    END AS profit_margin
  FROM combined cm
  JOIN cast_cost_settings c
    ON c.cast_name = cm.c_cast
    AND c.account_id = p_account_id
    AND TO_DATE(cm.c_month || '-01', 'YYYY-MM-DD') >= c.effective_from
    AND (c.effective_to IS NULL OR TO_DATE(cm.c_month || '-01', 'YYYY-MM-DD') <= c.effective_to)
  GROUP BY cm.c_month, cm.c_cast, cm.c_sessions, cm.c_hours, cm.c_tokens
  ORDER BY cm.c_month DESC, cm.c_cast;
$$ LANGUAGE SQL STABLE;

-- ============================================================
-- 3. get_session_pl
-- ============================================================
DROP FUNCTION IF EXISTS get_session_pl(UUID, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION get_session_pl(
  p_account_id UUID,
  p_session_id TEXT DEFAULT NULL,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
) RETURNS TABLE(
  session_id TEXT,
  cast_name TEXT,
  session_date DATE,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  total_tokens BIGINT,
  peak_viewers INTEGER,
  gross_revenue_jpy NUMERIC,
  platform_fee_jpy NUMERIC,
  net_revenue_jpy NUMERIC,
  cast_cost_jpy NUMERIC,
  gross_profit_jpy NUMERIC,
  profit_margin NUMERIC,
  hourly_rate INTEGER,
  token_to_jpy NUMERIC
) AS $$
  WITH session_coins AS (
    SELECT
      s.session_id::TEXT,
      s.cast_name,
      s.started_at,
      s.ended_at,
      s.peak_viewers,
      COALESCE((
        SELECT SUM(ct.tokens)
        FROM coin_transactions ct
        WHERE ct.account_id = p_account_id
          AND (ct.cast_name = s.cast_name OR ct.cast_name IS NULL)
          AND ct.tokens > 0
          AND ct.type != 'studio'
          AND ct.date >= s.started_at - INTERVAL '5 minutes'
          AND ct.date <= COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours') + INTERVAL '30 minutes'
      ), COALESCE(s.total_tokens, 0))::BIGINT AS session_tokens
    FROM sessions s
    WHERE s.account_id = p_account_id
      AND (p_session_id IS NULL OR s.session_id::TEXT = p_session_id)
      AND (p_cast_name IS NULL OR s.cast_name = p_cast_name)
      AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
  )
  SELECT
    sc.session_id,
    sc.cast_name,
    sc.started_at::DATE AS session_date,
    sc.started_at,
    sc.ended_at,
    CASE WHEN sc.ended_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at))::INTEGER / 60
      ELSE 0
    END AS duration_minutes,
    sc.session_tokens AS total_tokens,
    COALESCE(sc.peak_viewers, 0) AS peak_viewers,
    sc.session_tokens * c.token_to_jpy AS gross_revenue_jpy,
    sc.session_tokens * c.token_to_jpy * (c.platform_fee_rate / 100) AS platform_fee_jpy,
    sc.session_tokens * c.token_to_jpy * (1 - c.platform_fee_rate / 100) AS net_revenue_jpy,
    CASE WHEN sc.ended_at IS NOT NULL
      THEN (EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at)) / 3600) * c.hourly_rate
      ELSE 0
    END AS cast_cost_jpy,
    sc.session_tokens * c.token_to_jpy * (1 - c.platform_fee_rate / 100)
      - CASE WHEN sc.ended_at IS NOT NULL
          THEN (EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at)) / 3600) * c.hourly_rate
          ELSE 0
        END AS gross_profit_jpy,
    CASE WHEN sc.session_tokens > 0
      THEN ROUND(
        ((sc.session_tokens * c.token_to_jpy * (1 - c.platform_fee_rate / 100)
          - CASE WHEN sc.ended_at IS NOT NULL
              THEN (EXTRACT(EPOCH FROM (sc.ended_at - sc.started_at)) / 3600) * c.hourly_rate
              ELSE 0
            END)
        / (sc.session_tokens * c.token_to_jpy)) * 100, 1)
      ELSE 0
    END AS profit_margin,
    c.hourly_rate,
    c.token_to_jpy
  FROM session_coins sc
  JOIN cast_cost_settings c
    ON c.cast_name = sc.cast_name
    AND c.account_id = p_account_id
    AND sc.started_at::DATE >= c.effective_from
    AND (c.effective_to IS NULL OR sc.started_at::DATE <= c.effective_to)
  ORDER BY sc.started_at DESC;
$$ LANGUAGE SQL STABLE;

-- ============================================================
-- 4. get_session_list_v2 — 安全策としてstudio除外追加
-- ============================================================
DROP FUNCTION IF EXISTS public.get_session_list_v2(UUID, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.get_session_list_v2(
  p_account_id UUID, p_cast_name TEXT, p_limit INTEGER DEFAULT 20, p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(
  broadcast_group_id TEXT, session_ids TEXT[], cast_name TEXT, session_title TEXT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, duration_minutes NUMERIC,
  msg_count BIGINT, unique_users BIGINT, chat_tokens BIGINT, tip_count BIGINT,
  coin_tokens BIGINT, coin_tip_tokens BIGINT, coin_private_tokens BIGINT,
  coin_ticket_tokens BIGINT, coin_group_tokens BIGINT, coin_spy_tokens BIGINT,
  coin_other_tokens BIGINT, total_revenue BIGINT, is_active BOOLEAN, total_count BIGINT
) LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  RETURN QUERY
  WITH
  raw_sessions AS (
    SELECT
      cl.session_id::TEXT AS sid,
      cl.cast_name AS cn,
      MAX(s.broadcast_title) AS stitle,
      MIN(cl."timestamp") AS s_start,
      MAX(cl."timestamp") AS s_end,
      COUNT(*) AS s_msg_count,
      COUNT(DISTINCT cl.username) FILTER (WHERE cl.username IS NOT NULL AND cl.username != '') AS s_unique_users,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT AS s_chat_tokens,
      COUNT(*) FILTER (WHERE cl.tokens > 0) AS s_tip_count
    FROM public.chat_logs cl
    LEFT JOIN public.sessions s ON s.session_id = cl.session_id
    WHERE cl.account_id = p_account_id AND cl.cast_name = p_cast_name AND cl.session_id IS NOT NULL
    GROUP BY cl.session_id, cl.cast_name
  ),
  with_gap AS (
    SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs
  ),
  with_group AS (
    SELECT wg.*, SUM(CASE WHEN wg.prev_end IS NULL THEN 1 WHEN EXTRACT(EPOCH FROM (wg.s_start - wg.prev_end)) > 1800 THEN 1 ELSE 0 END) OVER (ORDER BY wg.s_start) AS grp_num
    FROM with_gap wg
  ),
  broadcast_groups AS (
    SELECT g.grp_num, g.cn,
      (ARRAY_AGG(g.stitle ORDER BY g.s_msg_count DESC NULLS LAST))[1] AS bg_title,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_session_ids,
      MIN(g.s_start) AS bg_start, MAX(g.s_end) AS bg_end,
      SUM(g.s_msg_count)::BIGINT AS bg_msg_count, SUM(g.s_tip_count)::BIGINT AS bg_tip_count,
      SUM(g.s_chat_tokens)::BIGINT AS bg_chat_tokens
    FROM with_group g GROUP BY g.grp_num, g.cn
  ),
  bg_with_next AS (
    SELECT bg.*,
      LEAD(bg.bg_start) OVER (ORDER BY bg.bg_start) AS next_bg_start
    FROM broadcast_groups bg
  ),
  bg_unique_users AS (
    SELECT bg.grp_num, COUNT(DISTINCT cl.username) FILTER (WHERE cl.username IS NOT NULL AND cl.username != '') AS bg_unique
    FROM bg_with_next bg
    JOIN public.chat_logs cl ON cl.account_id = p_account_id AND cl.cast_name = p_cast_name AND cl.session_id::TEXT = ANY(bg.bg_session_ids)
    GROUP BY bg.grp_num
  ),
  bg_count AS (SELECT COUNT(*)::BIGINT AS cnt FROM bg_with_next),
  paged_bg AS (SELECT bg.* FROM bg_with_next bg ORDER BY bg.bg_start DESC LIMIT p_limit OFFSET p_offset),
  coin_match AS (
    SELECT pbg.grp_num,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS c_total,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'tip'), 0)::BIGINT AS c_tip,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'private'), 0)::BIGINT AS c_private,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'ticket'), 0)::BIGINT AS c_ticket,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'group'), 0)::BIGINT AS c_group,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'spy'), 0)::BIGINT AS c_spy,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type NOT IN ('tip','private','ticket','group','spy','studio')), 0)::BIGINT AS c_other
    FROM paged_bg pbg
    LEFT JOIN public.coin_transactions ct ON ct.account_id = p_account_id AND (ct.cast_name = p_cast_name OR ct.cast_name IS NULL)
      AND ct.tokens > 0
      AND ct.type != 'studio'
      AND ct.date >= pbg.bg_start - INTERVAL '5 minutes'
      AND ct.date <= LEAST(
        pbg.bg_end + INTERVAL '60 minutes',
        COALESCE(pbg.next_bg_start - INTERVAL '5 minutes', pbg.bg_end + INTERVAL '60 minutes')
      )
    GROUP BY pbg.grp_num
  )
  SELECT pbg.bg_session_ids[1], pbg.bg_session_ids, pbg.cn, pbg.bg_title,
    pbg.bg_start, pbg.bg_end, ROUND(EXTRACT(EPOCH FROM (pbg.bg_end - pbg.bg_start)) / 60, 1),
    pbg.bg_msg_count, COALESCE(buu.bg_unique, 0)::BIGINT, pbg.bg_chat_tokens, pbg.bg_tip_count,
    COALESCE(cm.c_total, 0)::BIGINT, COALESCE(cm.c_tip, 0)::BIGINT, COALESCE(cm.c_private, 0)::BIGINT,
    COALESCE(cm.c_ticket, 0)::BIGINT, COALESCE(cm.c_group, 0)::BIGINT, COALESCE(cm.c_spy, 0)::BIGINT,
    COALESCE(cm.c_other, 0)::BIGINT,
    GREATEST(pbg.bg_chat_tokens, COALESCE(cm.c_total, 0))::BIGINT,
    (pbg.bg_end > NOW() - INTERVAL '10 minutes'), (SELECT cnt FROM bg_count)
  FROM paged_bg pbg LEFT JOIN bg_unique_users buu ON buu.grp_num = pbg.grp_num
  LEFT JOIN coin_match cm ON cm.grp_num = pbg.grp_num ORDER BY pbg.bg_start DESC;
END;
$fn$;

-- ============================================================
-- 5. get_session_summary_v2 — studio除外追加
-- ============================================================
DROP FUNCTION IF EXISTS public.get_session_summary_v2(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.get_session_summary_v2(p_account_id UUID, p_session_id TEXT)
RETURNS TABLE(
  broadcast_group_id TEXT, session_ids TEXT[], cast_name TEXT, session_title TEXT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, duration_minutes NUMERIC,
  msg_count BIGINT, unique_users BIGINT, chat_tokens BIGINT, tip_count BIGINT,
  tokens_by_type JSONB, top_chatters JSONB,
  coin_tokens BIGINT, coin_by_type JSONB, coin_top_users JSONB,
  coin_new_users INTEGER, coin_returning_users INTEGER, total_revenue BIGINT,
  prev_broadcast_group_id TEXT, prev_total_revenue BIGINT, prev_started_at TIMESTAMPTZ, change_pct NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_cast TEXT; v_session_ids TEXT[]; v_bg_start TIMESTAMPTZ; v_bg_end TIMESTAMPTZ;
  v_next_bg_start TIMESTAMPTZ;
  v_coin_end TIMESTAMPTZ;
  v_prev_bg_id TEXT; v_prev_bg_start TIMESTAMPTZ; v_prev_bg_end TIMESTAMPTZ;
  v_prev_next_bg_start TIMESTAMPTZ;
  v_prev_revenue BIGINT; v_prev_chat BIGINT;
BEGIN
  SELECT cl.cast_name INTO v_cast FROM public.chat_logs cl
  WHERE cl.account_id = p_account_id AND cl.session_id = p_session_id::UUID LIMIT 1;
  IF v_cast IS NULL THEN RETURN; END IF;

  WITH raw_sessions AS (
    SELECT cl.session_id::TEXT AS sid, MIN(cl."timestamp") AS s_start, MAX(cl."timestamp") AS s_end
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id AND cl.cast_name = v_cast AND cl.session_id IS NOT NULL
    GROUP BY cl.session_id
  ),
  sorted AS (SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs),
  grouped AS (
    SELECT ss.*, SUM(CASE WHEN ss.prev_end IS NULL OR EXTRACT(EPOCH FROM (ss.s_start - ss.prev_end)) > 1800 THEN 1 ELSE 0 END) OVER (ORDER BY ss.s_start) AS grp_num
    FROM sorted ss
  ),
  target_grp AS (SELECT g.grp_num FROM grouped g WHERE g.sid = p_session_id LIMIT 1),
  bg_agg AS (
    SELECT g.grp_num,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_sids,
      MIN(g.s_start) AS bg_start, MAX(g.s_end) AS bg_end
    FROM grouped g GROUP BY g.grp_num
  ),
  bg_with_next AS (
    SELECT ba.*, LEAD(ba.bg_start) OVER (ORDER BY ba.bg_start) AS nbs
    FROM bg_agg ba
  )
  SELECT bwn.bg_sids, bwn.bg_start, bwn.bg_end, bwn.nbs
  INTO v_session_ids, v_bg_start, v_bg_end, v_next_bg_start
  FROM bg_with_next bwn
  WHERE bwn.grp_num = (SELECT tg.grp_num FROM target_grp tg);

  IF v_session_ids IS NULL THEN
    v_session_ids := ARRAY[p_session_id];
    SELECT MIN(cl."timestamp"), MAX(cl."timestamp") INTO v_bg_start, v_bg_end
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id AND cl.session_id = p_session_id::UUID;
  END IF;

  v_coin_end := LEAST(
    v_bg_end + INTERVAL '60 minutes',
    COALESCE(v_next_bg_start - INTERVAL '5 minutes', v_bg_end + INTERVAL '60 minutes')
  );

  WITH raw_sessions AS (
    SELECT cl.session_id::TEXT AS sid, MIN(cl."timestamp") AS s_start, MAX(cl."timestamp") AS s_end
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id AND cl.cast_name = v_cast AND cl.session_id IS NOT NULL
    GROUP BY cl.session_id
  ),
  sorted AS (SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs),
  grouped AS (
    SELECT ss.*, SUM(CASE WHEN ss.prev_end IS NULL OR EXTRACT(EPOCH FROM (ss.s_start - ss.prev_end)) > 1800 THEN 1 ELSE 0 END) OVER (ORDER BY ss.s_start) AS grp_num
    FROM sorted ss
  ),
  bg_agg AS (
    SELECT g.grp_num, (ARRAY_AGG(g.sid ORDER BY g.s_start))[1] AS bg_id,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_sids, MIN(g.s_start) AS bg_start, MAX(g.s_end) AS bg_end
    FROM grouped g GROUP BY g.grp_num
  ),
  bg_with_next AS (
    SELECT ba.*, LEAD(ba.bg_start) OVER (ORDER BY ba.bg_start) AS nbs
    FROM bg_agg ba
  ),
  prev_bg AS (SELECT bwn.bg_id, bwn.bg_start, bwn.bg_end, bwn.nbs FROM bg_with_next bwn WHERE bwn.bg_end < v_bg_start ORDER BY bwn.bg_start DESC LIMIT 1)
  SELECT pb.bg_id, pb.bg_start, pb.bg_end, pb.nbs INTO v_prev_bg_id, v_prev_bg_start, v_prev_bg_end, v_prev_next_bg_start FROM prev_bg pb;

  IF v_prev_bg_start IS NOT NULL THEN
    SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT INTO v_prev_revenue FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id AND (ct.cast_name = v_cast OR ct.cast_name IS NULL) AND ct.tokens > 0
      AND ct.type != 'studio'
      AND ct.date >= v_prev_bg_start - INTERVAL '5 minutes'
      AND ct.date <= LEAST(
        v_prev_bg_end + INTERVAL '60 minutes',
        COALESCE(v_prev_next_bg_start - INTERVAL '5 minutes', v_prev_bg_end + INTERVAL '60 minutes')
      );

    WITH prev_sids AS (
      SELECT cl.session_id::TEXT AS sid FROM public.chat_logs cl
      WHERE cl.account_id = p_account_id AND cl.cast_name = v_cast AND cl.session_id IS NOT NULL
      GROUP BY cl.session_id
    )
    SELECT COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT INTO v_prev_chat
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id
      AND cl.session_id::TEXT IN (SELECT ps.sid FROM prev_sids ps)
      AND cl."timestamp" >= v_prev_bg_start AND cl."timestamp" <= v_prev_bg_end;
    v_prev_revenue := GREATEST(COALESCE(v_prev_chat, 0), COALESCE(v_prev_revenue, 0));
  END IF;

  RETURN QUERY
  WITH
  spy_agg AS (
    SELECT COUNT(*)::BIGINT AS sa_msg_count,
      COUNT(DISTINCT cl.username) FILTER (WHERE cl.username IS NOT NULL AND cl.username != '')::BIGINT AS sa_unique_users,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT AS sa_chat_tokens,
      COUNT(*) FILTER (WHERE cl.tokens > 0)::BIGINT AS sa_tip_count
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id AND cl.session_id::TEXT = ANY(v_session_ids)
  ),
  type_breakdown AS (
    SELECT COALESCE(jsonb_object_agg(t.message_type, t.type_tokens), '{}'::JSONB) AS tbt
    FROM (SELECT cl.message_type, SUM(cl.tokens) AS type_tokens FROM public.chat_logs cl
      WHERE cl.account_id = p_account_id AND cl.session_id::TEXT = ANY(v_session_ids) AND cl.tokens > 0 GROUP BY cl.message_type) t
  ),
  top5_chat AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('user_name', u.username, 'tokens', u.user_tokens, 'tip_count', u.user_tips) ORDER BY u.user_tokens DESC), '[]'::JSONB) AS top_list
    FROM (SELECT cl.username, SUM(cl.tokens)::BIGINT AS user_tokens, COUNT(*)::BIGINT AS user_tips FROM public.chat_logs cl
      WHERE cl.account_id = p_account_id AND cl.session_id::TEXT = ANY(v_session_ids) AND cl.tokens > 0 AND cl.username IS NOT NULL AND cl.username != ''
      GROUP BY cl.username ORDER BY SUM(cl.tokens) DESC LIMIT 5) u
  ),
  session_tx AS (SELECT ct.* FROM public.coin_transactions ct WHERE ct.account_id = p_account_id AND (ct.cast_name = v_cast OR ct.cast_name IS NULL)
    AND ct.tokens > 0 AND ct.type != 'studio' AND ct.date >= v_bg_start - INTERVAL '5 minutes' AND ct.date <= v_coin_end),
  coin_total AS (SELECT COALESCE(SUM(st.tokens), 0)::BIGINT AS c_total FROM session_tx st),
  coin_type_agg AS (SELECT COALESCE(jsonb_object_agg(t.ctype, t.sum_tokens), '{}'::JSONB) AS c_by_type FROM (SELECT st.type AS ctype, SUM(st.tokens)::BIGINT AS sum_tokens FROM session_tx st GROUP BY st.type) t),
  coin_user_agg AS (
    SELECT st.user_name, SUM(st.tokens)::BIGINT AS user_tokens, ARRAY_AGG(DISTINCT st.type) AS user_types,
      EXISTS (SELECT 1 FROM public.coin_transactions older WHERE older.account_id = p_account_id AND (older.cast_name = v_cast OR older.cast_name IS NULL)
        AND older.user_name = st.user_name AND older.date < v_bg_start - INTERVAL '5 minutes' AND older.tokens > 0 AND older.type != 'studio') AS has_prior
    FROM session_tx st GROUP BY st.user_name
  ),
  coin_user_stats AS (SELECT COUNT(*) FILTER (WHERE NOT cua.has_prior)::INTEGER AS new_u, COUNT(*) FILTER (WHERE cua.has_prior)::INTEGER AS ret_u FROM coin_user_agg cua),
  coin_top5 AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('user_name', cua.user_name, 'tokens', cua.user_tokens, 'types', cua.user_types, 'is_new', NOT cua.has_prior) ORDER BY cua.user_tokens DESC), '[]'::JSONB) AS top_list
    FROM (SELECT * FROM coin_user_agg ORDER BY user_tokens DESC LIMIT 10) cua
  )
  SELECT v_session_ids[1], v_session_ids, v_cast,
    (SELECT MAX(s.broadcast_title) FROM public.sessions s WHERE s.session_id::TEXT = ANY(v_session_ids)),
    v_bg_start, v_bg_end, ROUND(EXTRACT(EPOCH FROM (v_bg_end - v_bg_start)) / 60, 1),
    sa.sa_msg_count, sa.sa_unique_users, sa.sa_chat_tokens, sa.sa_tip_count,
    tb.tbt, t5c.top_list, ct_total.c_total, cta.c_by_type, ct5.top_list,
    COALESCE(cus.new_u, 0), COALESCE(cus.ret_u, 0), GREATEST(sa.sa_chat_tokens, ct_total.c_total)::BIGINT,
    v_prev_bg_id, v_prev_revenue, v_prev_bg_start,
    CASE WHEN v_prev_revenue IS NOT NULL AND v_prev_revenue > 0
      THEN ROUND((GREATEST(sa.sa_chat_tokens, ct_total.c_total)::NUMERIC - v_prev_revenue) / v_prev_revenue * 100, 1) ELSE NULL END
  FROM spy_agg sa CROSS JOIN type_breakdown tb CROSS JOIN top5_chat t5c CROSS JOIN coin_total ct_total
  CROSS JOIN coin_type_agg cta CROSS JOIN coin_user_stats cus CROSS JOIN coin_top5 ct5;
END;
$fn$;

-- ============================================================
-- 6. get_session_revenue_breakdown — studio除外追加
-- ============================================================
DROP FUNCTION IF EXISTS public.get_session_revenue_breakdown(UUID, TEXT, DATE);

CREATE OR REPLACE FUNCTION public.get_session_revenue_breakdown(
  p_account_id UUID,
  p_cast_name TEXT,
  p_session_date DATE DEFAULT NULL
)
RETURNS TABLE (
  session_id TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  revenue_by_type JSONB,
  total_tokens BIGINT,
  unique_users INTEGER,
  new_users INTEGER,
  returning_users INTEGER,
  top_users JSONB,
  prev_session_tokens BIGINT,
  prev_session_date DATE,
  change_pct NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session RECORD;
  v_prev_session RECORD;
  v_effective_end TIMESTAMPTZ;
BEGIN
  IF p_session_date IS NOT NULL THEN
    SELECT s.* INTO v_session
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND COALESCE(s.cast_name, s.title) = p_cast_name
      AND s.started_at::date = p_session_date
    ORDER BY s.started_at DESC
    LIMIT 1;
  ELSE
    SELECT s.* INTO v_session
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND COALESCE(s.cast_name, s.title) = p_cast_name
    ORDER BY s.started_at DESC
    LIMIT 1;
  END IF;

  IF v_session IS NULL THEN
    RETURN;
  END IF;

  v_effective_end := COALESCE(v_session.ended_at, v_session.started_at + INTERVAL '12 hours');

  SELECT s.* INTO v_prev_session
  FROM public.sessions s
  WHERE s.account_id = p_account_id
    AND COALESCE(s.cast_name, s.title) = p_cast_name
    AND s.started_at < v_session.started_at
  ORDER BY s.started_at DESC
  LIMIT 1;

  RETURN QUERY
  WITH
  session_tx AS (
    SELECT ct.*
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name = p_cast_name
      AND ct.date >= v_session.started_at - INTERVAL '5 minutes'
      AND ct.date < v_effective_end + INTERVAL '5 minutes'
      AND ct.tokens > 0
      AND ct.type != 'studio'
  ),
  type_agg AS (
    SELECT jsonb_object_agg(t.type, t.sum_tokens) AS rev
    FROM (
      SELECT st.type, SUM(st.tokens) AS sum_tokens
      FROM session_tx st
      GROUP BY st.type
    ) t
  ),
  user_agg AS (
    SELECT
      st.user_name,
      SUM(st.tokens)::BIGINT AS user_tokens,
      ARRAY_AGG(DISTINCT st.type) AS user_types,
      EXISTS (
        SELECT 1 FROM public.coin_transactions older
        WHERE older.account_id = p_account_id
          AND older.cast_name = p_cast_name
          AND older.user_name = st.user_name
          AND older.date < v_session.started_at - INTERVAL '5 minutes'
          AND older.tokens > 0
          AND older.type != 'studio'
      ) AS has_prior
    FROM session_tx st
    GROUP BY st.user_name
  ),
  user_stats AS (
    SELECT
      COUNT(*)::INTEGER AS total_u,
      COUNT(*) FILTER (WHERE NOT ua.has_prior)::INTEGER AS new_u,
      COUNT(*) FILTER (WHERE ua.has_prior)::INTEGER AS ret_u
    FROM user_agg ua
  ),
  top5 AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'user_name', ua.user_name,
        'tokens', ua.user_tokens,
        'types', ua.user_types,
        'is_new', NOT ua.has_prior
      ) ORDER BY ua.user_tokens DESC
    ) AS top_list
    FROM (SELECT * FROM user_agg ORDER BY user_tokens DESC LIMIT 5) ua
  ),
  prev_revenue AS (
    SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT AS prev_tokens
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name = p_cast_name
      AND v_prev_session.started_at IS NOT NULL
      AND ct.date >= v_prev_session.started_at - INTERVAL '5 minutes'
      AND ct.date < COALESCE(v_prev_session.ended_at, v_prev_session.started_at + INTERVAL '12 hours') + INTERVAL '5 minutes'
      AND ct.tokens > 0
      AND ct.type != 'studio'
  )
  SELECT
    v_session.session_id,
    COALESCE(v_session.title, v_session.cast_name) AS session_title,
    v_session.started_at,
    v_effective_end AS ended_at,
    EXTRACT(EPOCH FROM (v_effective_end - v_session.started_at))::INTEGER / 60 AS duration_minutes,
    COALESCE(ta.rev, '{}'::JSONB) AS revenue_by_type,
    COALESCE((SELECT SUM(st.tokens) FROM session_tx st), 0)::BIGINT AS total_tokens,
    us.total_u AS unique_users,
    us.new_u AS new_users,
    us.ret_u AS returning_users,
    COALESCE(t5.top_list, '[]'::JSONB) AS top_users,
    pr.prev_tokens AS prev_session_tokens,
    v_prev_session.started_at::date AS prev_session_date,
    CASE
      WHEN pr.prev_tokens > 0 THEN
        ROUND(((SELECT SUM(st.tokens) FROM session_tx st)::NUMERIC - pr.prev_tokens) / pr.prev_tokens * 100, 1)
      ELSE NULL
    END AS change_pct
  FROM type_agg ta
  CROSS JOIN user_stats us
  CROSS JOIN top5 t5
  CROSS JOIN prev_revenue pr;
END;
$$;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
