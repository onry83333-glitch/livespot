-- ============================================================
-- Migration 127: 欠落RPC 23個の一括実装
-- get_coin_sessions は migration 126 で実装済み
-- ============================================================

-- DROP existing functions with old signatures
DROP FUNCTION IF EXISTS public.calculate_revenue_share(uuid, text, date, date);
DROP FUNCTION IF EXISTS public.get_cast_fans(uuid, text, integer);
DROP FUNCTION IF EXISTS public.get_cast_hourly_performance(uuid, text, integer);
DROP FUNCTION IF EXISTS public.get_cast_paid_users(uuid, text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.get_cast_stats(uuid, text[]);
DROP FUNCTION IF EXISTS public.get_coin_sync_status();
DROP FUNCTION IF EXISTS public.get_dm_campaign_effectiveness(uuid, text, integer);
DROP FUNCTION IF EXISTS public.get_new_users_by_session(uuid, text, date);
DROP FUNCTION IF EXISTS public.get_session_actions(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_session_list_v2(uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.get_session_revenue_breakdown(uuid, text, date);
DROP FUNCTION IF EXISTS public.get_session_summary_v2(uuid, text);
DROP FUNCTION IF EXISTS public.get_spy_cast_stats(uuid, text[]);
DROP FUNCTION IF EXISTS public.get_transcript_timeline(uuid, text, text);
DROP FUNCTION IF EXISTS public.get_user_acquisition_dashboard(uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.get_user_acquisition_dashboard(uuid, text, integer, integer, integer);
DROP FUNCTION IF EXISTS public.get_user_activity(uuid, text);
DROP FUNCTION IF EXISTS public.get_user_retention_status(uuid, text);
DROP FUNCTION IF EXISTS public.get_weekly_coin_stats(uuid, text[], timestamptz, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.search_users_bulk(uuid, text, text[]);
DROP FUNCTION IF EXISTS public.get_sync_health(uuid);
DROP FUNCTION IF EXISTS public.check_spy_data_quality(uuid);
DROP FUNCTION IF EXISTS public.count_test_data(uuid, text);
DROP FUNCTION IF EXISTS public.delete_test_data(uuid, text);

-- ============================================================
-- グループ1: キャスト統計・売上（5個）
-- ============================================================

-- 1. get_cast_stats
CREATE OR REPLACE FUNCTION public.get_cast_stats(
  p_account_id UUID,
  p_cast_names TEXT[]
)
RETURNS TABLE (
  cast_name TEXT,
  total_messages BIGINT,
  total_tips BIGINT,
  total_coins BIGINT,
  unique_users BIGINT,
  last_activity TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    cn.val AS cast_name,
    COALESCE(cl.total_messages, 0)::BIGINT,
    COALESCE(cl.total_tips, 0)::BIGINT,
    COALESCE(ct.total_coins, 0)::BIGINT,
    COALESCE(cl.unique_users, 0)::BIGINT,
    GREATEST(cl.last_act, ct.last_act) AS last_activity
  FROM UNNEST(p_cast_names) AS cn(val)
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::BIGINT AS total_messages,
      COUNT(*) FILTER (WHERE c.tokens > 0)::BIGINT AS total_tips,
      COUNT(DISTINCT c.username)::BIGINT AS unique_users,
      MAX(c.timestamp) AS last_act
    FROM public.chat_logs c
    WHERE c.account_id = p_account_id AND c.cast_name = cn.val
  ) cl ON true
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(t.tokens), 0)::BIGINT AS total_coins,
      MAX(t.date) AS last_act
    FROM public.coin_transactions t
    WHERE t.account_id = p_account_id AND t.cast_name = cn.val
  ) ct ON true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_cast_stats(UUID, TEXT[]) TO authenticated, anon, service_role;

-- 2. get_weekly_coin_stats
CREATE OR REPLACE FUNCTION public.get_weekly_coin_stats(
  p_account_id UUID,
  p_cast_names TEXT[],
  p_this_week_start TEXT,
  p_last_week_start TEXT,
  p_today_start TEXT
)
RETURNS TABLE (
  cast_name TEXT,
  this_week BIGINT,
  last_week BIGINT,
  today BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_this_week TIMESTAMPTZ := p_this_week_start::TIMESTAMPTZ;
  v_last_week TIMESTAMPTZ := p_last_week_start::TIMESTAMPTZ;
  v_today TIMESTAMPTZ := p_today_start::TIMESTAMPTZ;
BEGIN
  RETURN QUERY
  SELECT
    cn.val AS cast_name,
    COALESCE(SUM(t.tokens) FILTER (WHERE t.date >= v_this_week), 0)::BIGINT AS this_week,
    COALESCE(SUM(t.tokens) FILTER (WHERE t.date >= v_last_week AND t.date < v_this_week), 0)::BIGINT AS last_week,
    COALESCE(SUM(t.tokens) FILTER (WHERE t.date >= v_today), 0)::BIGINT AS today
  FROM UNNEST(p_cast_names) AS cn(val)
  LEFT JOIN public.coin_transactions t
    ON t.account_id = p_account_id AND t.cast_name = cn.val AND t.date >= v_last_week
  GROUP BY cn.val;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_weekly_coin_stats(UUID, TEXT[], TEXT, TEXT, TEXT) TO authenticated, anon, service_role;

-- 3. get_cast_fans
CREATE OR REPLACE FUNCTION public.get_cast_fans(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  user_name TEXT,
  total_tokens BIGINT,
  msg_count BIGINT,
  last_seen TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    pu.user_name,
    pu.total_coins::BIGINT AS total_tokens,
    COALESCE(cl.msg_count, 0)::BIGINT AS msg_count,
    COALESCE(cl.last_seen, pu.last_payment_date) AS last_seen
  FROM public.paid_users pu
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::BIGINT AS msg_count,
      MAX(c.timestamp) AS last_seen
    FROM public.chat_logs c
    WHERE c.account_id = p_account_id AND c.cast_name = p_cast_name AND c.username = pu.user_name
  ) cl ON true
  WHERE pu.account_id = p_account_id AND pu.cast_name = p_cast_name
  ORDER BY pu.total_coins DESC
  LIMIT p_limit;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_cast_fans(UUID, TEXT, INT) TO authenticated, anon, service_role;

-- 4. calculate_revenue_share
CREATE OR REPLACE FUNCTION public.calculate_revenue_share(
  p_account_id UUID,
  p_cast_name TEXT,
  p_start_date TEXT,
  p_end_date TEXT
)
RETURNS TABLE (
  week_start DATE,
  week_end DATE,
  week_label TEXT,
  transaction_count BIGINT,
  total_tokens BIGINT,
  setting_token_to_usd NUMERIC,
  setting_platform_fee_pct NUMERIC,
  setting_revenue_share_pct NUMERIC,
  gross_usd NUMERIC,
  platform_fee_usd NUMERIC,
  net_usd NUMERIC,
  cast_payment_usd NUMERIC,
  formula_gross TEXT,
  formula_fee TEXT,
  formula_net TEXT,
  formula_payment TEXT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_token_to_usd NUMERIC;
  v_platform_fee NUMERIC;
  v_rev_share NUMERIC;
BEGIN
  SELECT cs.token_to_usd, cs.platform_fee_rate, cs.revenue_share_rate
  INTO v_token_to_usd, v_platform_fee, v_rev_share
  FROM public.cast_cost_settings cs
  WHERE cs.account_id = p_account_id AND cs.cast_name = p_cast_name
  ORDER BY cs.effective_from DESC LIMIT 1;

  v_token_to_usd := COALESCE(v_token_to_usd, 0.05);
  v_platform_fee := COALESCE(v_platform_fee, 40);
  v_rev_share := COALESCE(v_rev_share, 50);

  RETURN QUERY
  WITH weeks AS (
    SELECT
      date_trunc('week', t.date)::DATE AS ws,
      (date_trunc('week', t.date) + INTERVAL '6 days')::DATE AS we,
      COUNT(*) AS tx_count,
      SUM(t.tokens)::BIGINT AS ttl_tokens
    FROM public.coin_transactions t
    WHERE t.account_id = p_account_id
      AND t.cast_name = p_cast_name
      AND t.date >= p_start_date::TIMESTAMPTZ
      AND t.date < (p_end_date::DATE + 1)::TIMESTAMPTZ
    GROUP BY date_trunc('week', t.date)
  )
  SELECT
    w.ws AS week_start,
    w.we AS week_end,
    TO_CHAR(w.ws, 'MM/DD') || ' - ' || TO_CHAR(w.we, 'MM/DD') AS week_label,
    w.tx_count AS transaction_count,
    w.ttl_tokens AS total_tokens,
    v_token_to_usd AS setting_token_to_usd,
    v_platform_fee AS setting_platform_fee_pct,
    v_rev_share AS setting_revenue_share_pct,
    ROUND(w.ttl_tokens * v_token_to_usd, 2) AS gross_usd,
    ROUND(w.ttl_tokens * v_token_to_usd * v_platform_fee / 100, 2) AS platform_fee_usd,
    ROUND(w.ttl_tokens * v_token_to_usd * (1 - v_platform_fee / 100), 2) AS net_usd,
    ROUND(w.ttl_tokens * v_token_to_usd * (1 - v_platform_fee / 100) * v_rev_share / 100, 2) AS cast_payment_usd,
    w.ttl_tokens || ' × $' || v_token_to_usd AS formula_gross,
    'Gross × ' || v_platform_fee || '%' AS formula_fee,
    'Gross - Fee' AS formula_net,
    'Net × ' || v_rev_share || '%' AS formula_payment
  FROM weeks w
  ORDER BY w.ws;
END;
$$;
GRANT EXECUTE ON FUNCTION public.calculate_revenue_share(UUID, TEXT, TEXT, TEXT) TO authenticated, anon, service_role;

-- 5. get_cast_paid_users
CREATE OR REPLACE FUNCTION public.get_cast_paid_users(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INT DEFAULT 100,
  p_since TEXT DEFAULT NULL
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ,
  first_payment_date TIMESTAMPTZ,
  segment TEXT,
  tx_count INT,
  user_id_stripchat TEXT,
  profile_url TEXT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    pu.user_name,
    pu.total_coins::BIGINT,
    pu.last_payment_date,
    pu.first_payment_date,
    pu.segment,
    pu.tx_count,
    pu.user_id_stripchat,
    pu.profile_url
  FROM public.paid_users pu
  WHERE pu.account_id = p_account_id
    AND pu.cast_name = p_cast_name
    AND (p_since IS NULL OR pu.last_payment_date >= p_since::TIMESTAMPTZ)
  ORDER BY pu.total_coins DESC
  LIMIT p_limit;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_cast_paid_users(UUID, TEXT, INT, TEXT) TO authenticated, anon, service_role;

-- ============================================================
-- グループ2: セッション（5個）
-- ============================================================

-- 6. get_session_list_v2
CREATE OR REPLACE FUNCTION public.get_session_list_v2(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id TEXT,
  session_date DATE,
  session_start TIMESTAMPTZ,
  session_end TIMESTAMPTZ,
  duration_minutes INT,
  message_count INT,
  tip_count INT,
  total_coins BIGINT,
  chat_tokens BIGINT,
  unique_users INT,
  broadcast_title TEXT,
  session_count INT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH ordered AS (
    SELECT
      s.*,
      CASE WHEN s.started_at - LAG(s.ended_at) OVER (ORDER BY s.started_at) > INTERVAL '30 minutes'
        THEN 1 ELSE 0 END AS new_group
    FROM public.sessions s
    WHERE s.account_id = p_account_id AND s.cast_name = p_cast_name
  ),
  with_gid AS (
    SELECT o.*, SUM(o.new_group) OVER (ORDER BY o.started_at) AS gid
    FROM ordered o
  ),
  grouped AS (
    SELECT
      (array_agg(g.id::TEXT ORDER BY g.started_at))[1] AS grp_id,
      MIN(g.started_at)::DATE AS session_date,
      MIN(g.started_at) AS session_start,
      MAX(g.ended_at) AS session_end,
      GREATEST(1, EXTRACT(EPOCH FROM MAX(g.ended_at) - MIN(g.started_at)) / 60)::INT AS duration_minutes,
      SUM(g.total_messages)::INT AS message_count,
      SUM(g.total_tips)::INT AS tip_count,
      SUM(g.total_tokens)::BIGINT AS total_coins,
      SUM(g.total_tokens)::BIGINT AS chat_tokens,
      GREATEST(MAX(g.unique_users), 0)::INT AS unique_users,
      (array_agg(g.broadcast_title ORDER BY g.started_at) FILTER (WHERE g.broadcast_title IS NOT NULL))[1] AS broadcast_title,
      COUNT(*)::INT AS session_count
    FROM with_gid g
    GROUP BY g.gid
  )
  SELECT
    grouped.grp_id AS id,
    grouped.session_date,
    grouped.session_start,
    grouped.session_end,
    grouped.duration_minutes,
    grouped.message_count,
    grouped.tip_count,
    grouped.total_coins,
    grouped.chat_tokens,
    grouped.unique_users,
    grouped.broadcast_title,
    grouped.session_count
  FROM grouped
  ORDER BY grouped.session_start DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_session_list_v2(UUID, TEXT, INT, INT) TO authenticated, anon, service_role;

-- 7. get_session_summary_v2
CREATE OR REPLACE FUNCTION public.get_session_summary_v2(
  p_account_id UUID,
  p_session_id TEXT
)
RETURNS TABLE (
  broadcast_group_id TEXT,
  session_ids JSONB,
  cast_name TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INT,
  msg_count INT,
  unique_users INT,
  chat_tokens BIGINT,
  tip_count INT,
  tokens_by_type JSONB,
  top_chatters JSONB,
  coin_tokens BIGINT,
  coin_by_type JSONB,
  coin_top_users JSONB,
  coin_new_users INT,
  coin_returning_users INT,
  total_revenue BIGINT,
  prev_broadcast_group_id TEXT,
  prev_total_revenue BIGINT,
  prev_started_at TIMESTAMPTZ,
  change_pct NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cast TEXT;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_prev_id TEXT;
  v_prev_rev BIGINT;
  v_prev_start TIMESTAMPTZ;
BEGIN
  -- Find target session and its broadcast group using 30-min merge
  WITH all_sess AS (
    SELECT
      s.id::TEXT AS sid, s.cast_name AS cn, s.started_at AS sa, s.ended_at AS ea,
      s.total_messages, s.total_tips, s.total_tokens, s.unique_users AS uu,
      s.broadcast_title,
      s.session_id AS orig_session_id,
      CASE WHEN s.started_at - LAG(s.ended_at) OVER (PARTITION BY s.cast_name ORDER BY s.started_at) > INTERVAL '30 minutes'
        THEN 1 ELSE 0 END AS ng
    FROM public.sessions s
    WHERE s.account_id = p_account_id
  ),
  with_gid AS (
    SELECT a.*, SUM(a.ng) OVER (PARTITION BY a.cn ORDER BY a.sa) AS gid
    FROM all_sess a
  ),
  target AS (
    SELECT gid, cn FROM with_gid WHERE sid = p_session_id LIMIT 1
  ),
  grp AS (
    SELECT w.* FROM with_gid w JOIN target t ON w.gid = t.gid AND w.cn = t.cn
  ),
  grp_agg AS (
    SELECT
      (array_agg(g.sid ORDER BY g.sa))[1] AS bg_id,
      jsonb_agg(g.sid ORDER BY g.sa) AS sids,
      (array_agg(g.orig_session_id ORDER BY g.sa)) AS orig_sids,
      MIN(g.cn) AS cn,
      (array_agg(g.broadcast_title ORDER BY g.sa) FILTER (WHERE g.broadcast_title IS NOT NULL))[1] AS title,
      MIN(g.sa) AS grp_start,
      MAX(g.ea) AS grp_end,
      GREATEST(1, EXTRACT(EPOCH FROM MAX(g.ea) - MIN(g.sa)) / 60)::INT AS dur,
      SUM(g.total_messages)::INT AS msgs,
      GREATEST(MAX(g.uu), 0)::INT AS uusers,
      SUM(g.total_tokens)::BIGINT AS chtk,
      SUM(g.total_tips)::INT AS tips
    FROM grp g
  )
  SELECT grp_agg.cn, grp_agg.grp_start, grp_agg.grp_end
  INTO v_cast, v_start, v_end
  FROM grp_agg;

  IF v_cast IS NULL THEN
    RETURN;
  END IF;

  -- Find previous broadcast group
  WITH all_sess AS (
    SELECT
      s.id::TEXT AS sid, s.started_at AS sa, s.ended_at AS ea, s.total_tokens,
      CASE WHEN s.started_at - LAG(s.ended_at) OVER (ORDER BY s.started_at) > INTERVAL '30 minutes'
        THEN 1 ELSE 0 END AS ng
    FROM public.sessions s
    WHERE s.account_id = p_account_id AND s.cast_name = v_cast AND s.started_at < v_start
  ),
  with_gid AS (
    SELECT a.*, SUM(a.ng) OVER (ORDER BY a.sa) AS gid FROM all_sess a
  ),
  prev_grps AS (
    SELECT
      (array_agg(w.sid ORDER BY w.sa))[1] AS bg_id,
      MIN(w.sa) AS sa,
      SUM(w.total_tokens)::BIGINT AS rev
    FROM with_gid w GROUP BY w.gid
  )
  SELECT pg.bg_id, pg.rev, pg.sa
  INTO v_prev_id, v_prev_rev, v_prev_start
  FROM prev_grps pg ORDER BY pg.sa DESC LIMIT 1;

  RETURN QUERY
  WITH grp AS (
    SELECT w.*
    FROM (
      SELECT
        s.id::TEXT AS sid, s.cast_name AS cn, s.started_at AS sa, s.ended_at AS ea,
        s.total_messages, s.total_tips, s.total_tokens, s.unique_users AS uu,
        s.broadcast_title, s.session_id AS orig_session_id,
        CASE WHEN s.started_at - LAG(s.ended_at) OVER (PARTITION BY s.cast_name ORDER BY s.started_at) > INTERVAL '30 minutes'
          THEN 1 ELSE 0 END AS ng
      FROM public.sessions s
      WHERE s.account_id = p_account_id
    ) sub
    CROSS JOIN LATERAL (
      SELECT sub.*, SUM(sub.ng) OVER (PARTITION BY sub.cn ORDER BY sub.sa) AS gid
    ) w
    WHERE EXISTS (
      SELECT 1 FROM (
        SELECT sub2.cn, SUM(sub2.ng) OVER (PARTITION BY sub2.cn ORDER BY sub2.sa) AS gid2
        FROM (
          SELECT s2.id::TEXT AS sid2, s2.cast_name AS cn, s2.started_at AS sa,
            CASE WHEN s2.started_at - LAG(s2.ended_at) OVER (PARTITION BY s2.cast_name ORDER BY s2.started_at) > INTERVAL '30 minutes'
              THEN 1 ELSE 0 END AS ng
          FROM public.sessions s2 WHERE s2.account_id = p_account_id
        ) sub2
        WHERE sub2.sid2 = p_session_id
      ) t WHERE w.gid = t.gid2 AND w.cn = t.cn
    )
  ),
  grp_agg AS (
    SELECT
      (array_agg(g.sid ORDER BY g.sa))[1] AS bg_id,
      jsonb_agg(g.sid ORDER BY g.sa) AS sids,
      array_agg(g.orig_session_id) AS orig_sids,
      MIN(g.cn) AS cn,
      (array_agg(g.broadcast_title ORDER BY g.sa) FILTER (WHERE g.broadcast_title IS NOT NULL))[1] AS title,
      MIN(g.sa) AS grp_start,
      MAX(g.ea) AS grp_end,
      GREATEST(1, EXTRACT(EPOCH FROM MAX(g.ea) - MIN(g.sa)) / 60)::INT AS dur,
      SUM(g.total_messages)::INT AS msgs,
      GREATEST(MAX(g.uu), 0)::INT AS uusers,
      SUM(g.total_tokens)::BIGINT AS chtk,
      SUM(g.total_tips)::INT AS tips
    FROM grp g
  ),
  -- Chat top chatters
  chat_top AS (
    SELECT jsonb_agg(sub ORDER BY sub.tokens DESC) AS val
    FROM (
      SELECT c.username AS user_name, SUM(c.tokens)::BIGINT AS tokens, COUNT(*) FILTER (WHERE c.tokens > 0)::INT AS tip_count
      FROM public.chat_logs c
      WHERE c.account_id = p_account_id AND c.cast_name = v_cast
        AND c.timestamp >= v_start AND c.timestamp <= v_end
        AND c.username IS NOT NULL AND c.username != ''
      GROUP BY c.username
      ORDER BY SUM(c.tokens) DESC LIMIT 10
    ) sub
  ),
  -- Coin data
  coin_agg AS (
    SELECT
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS coin_total,
      jsonb_object_agg(COALESCE(ct.type, 'unknown'), ct_sum.s) AS by_type
    FROM (SELECT DISTINCT type FROM public.coin_transactions WHERE account_id = p_account_id AND cast_name = v_cast AND date >= v_start AND date <= v_end) ct
    CROSS JOIN LATERAL (
      SELECT SUM(t2.tokens)::BIGINT AS s
      FROM public.coin_transactions t2
      WHERE t2.account_id = p_account_id AND t2.cast_name = v_cast AND t2.date >= v_start AND t2.date <= v_end AND t2.type = ct.type
    ) ct_sum
  ),
  coin_top AS (
    SELECT jsonb_agg(sub ORDER BY sub.tokens DESC) AS val
    FROM (
      SELECT
        ct.user_name,
        SUM(ct.tokens)::BIGINT AS tokens,
        array_agg(DISTINCT ct.type) AS types,
        NOT EXISTS (
          SELECT 1 FROM public.coin_transactions p
          WHERE p.account_id = p_account_id AND p.cast_name = v_cast
            AND p.user_name = ct.user_name AND p.date < v_start
        ) AS is_new
      FROM public.coin_transactions ct
      WHERE ct.account_id = p_account_id AND ct.cast_name = v_cast
        AND ct.date >= v_start AND ct.date <= v_end
        AND ct.user_name IS NOT NULL AND ct.user_name != '' AND ct.user_name != 'anonymous'
      GROUP BY ct.user_name
      ORDER BY SUM(ct.tokens) DESC LIMIT 10
    ) sub
  ),
  coin_users AS (
    SELECT
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM public.coin_transactions p
        WHERE p.account_id = p_account_id AND p.cast_name = v_cast
          AND p.user_name = ct.user_name AND p.date < v_start
      ))::INT AS new_cnt,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.coin_transactions p
        WHERE p.account_id = p_account_id AND p.cast_name = v_cast
          AND p.user_name = ct.user_name AND p.date < v_start
      ))::INT AS ret_cnt
    FROM (
      SELECT DISTINCT ct.user_name
      FROM public.coin_transactions ct
      WHERE ct.account_id = p_account_id AND ct.cast_name = v_cast
        AND ct.date >= v_start AND ct.date <= v_end
        AND ct.user_name IS NOT NULL AND ct.user_name != '' AND ct.user_name != 'anonymous'
    ) ct
  )
  SELECT
    ga.bg_id,
    ga.sids,
    ga.cn,
    ga.title,
    ga.grp_start,
    ga.grp_end,
    ga.dur,
    ga.msgs,
    ga.uusers,
    ga.chtk,
    ga.tips,
    COALESCE((SELECT jsonb_object_agg(ct.type, ct_s.s) FROM (SELECT DISTINCT type FROM public.coin_transactions WHERE account_id = p_account_id AND cast_name = v_cast AND date >= v_start AND date <= v_end) ct CROSS JOIN LATERAL (SELECT SUM(tokens)::BIGINT AS s FROM public.coin_transactions WHERE account_id = p_account_id AND cast_name = v_cast AND date >= v_start AND date <= v_end AND type = ct.type) ct_s), '{}'::JSONB) AS tokens_by_type,
    COALESCE((SELECT val FROM chat_top), '[]'::JSONB),
    COALESCE((SELECT coin_total FROM coin_agg), 0)::BIGINT,
    COALESCE((SELECT by_type FROM coin_agg), '{}'::JSONB),
    COALESCE((SELECT val FROM coin_top), '[]'::JSONB),
    COALESCE((SELECT new_cnt FROM coin_users), 0)::INT,
    COALESCE((SELECT ret_cnt FROM coin_users), 0)::INT,
    (ga.chtk + COALESCE((SELECT coin_total FROM coin_agg), 0))::BIGINT AS total_revenue,
    v_prev_id,
    v_prev_rev,
    v_prev_start,
    CASE WHEN v_prev_rev IS NOT NULL AND v_prev_rev > 0
      THEN ROUND(((ga.chtk + COALESCE((SELECT coin_total FROM coin_agg), 0)) - v_prev_rev)::NUMERIC / v_prev_rev * 100, 1)
      ELSE NULL END
  FROM grp_agg ga;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_session_summary_v2(UUID, TEXT) TO authenticated, anon, service_role;

-- 8. get_session_actions
CREATE OR REPLACE FUNCTION public.get_session_actions(
  p_account_id UUID,
  p_session_id TEXT
)
RETURNS TABLE (
  first_time_payers JSONB,
  high_spenders JSONB,
  visited_no_action JSONB,
  dm_no_visit JSONB,
  segment_breakdown JSONB
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cast TEXT;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
BEGIN
  -- Get session time range
  SELECT s.cast_name, s.started_at, s.ended_at
  INTO v_cast, v_start, v_end
  FROM public.sessions s
  WHERE s.id = p_session_id::UUID AND s.account_id = p_account_id
  LIMIT 1;

  IF v_cast IS NULL THEN
    RETURN QUERY SELECT '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, '[]'::JSONB, '[]'::JSONB;
    RETURN;
  END IF;

  RETURN QUERY
  WITH session_payers AS (
    SELECT ct.user_name, SUM(ct.tokens)::BIGINT AS session_tokens
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = v_cast
      AND ct.date >= v_start AND ct.date <= v_end
      AND ct.user_name IS NOT NULL AND ct.user_name != '' AND ct.user_name != 'anonymous'
    GROUP BY ct.user_name
  ),
  first_timers AS (
    SELECT sp.user_name, sp.session_tokens,
      EXISTS (SELECT 1 FROM public.dm_send_log d WHERE d.account_id = p_account_id AND d.cast_name = v_cast AND d.user_name = sp.user_name) AS dm_sent
    FROM session_payers sp
    WHERE NOT EXISTS (
      SELECT 1 FROM public.coin_transactions p
      WHERE p.account_id = p_account_id AND p.cast_name = v_cast AND p.user_name = sp.user_name AND p.date < v_start
    )
  ),
  high AS (
    SELECT sp.user_name, sp.session_tokens
    FROM session_payers sp
    ORDER BY sp.session_tokens DESC LIMIT 10
  ),
  visitors AS (
    SELECT DISTINCT c.username AS user_name
    FROM public.chat_logs c
    WHERE c.account_id = p_account_id AND c.cast_name = v_cast
      AND c.timestamp >= v_start AND c.timestamp <= v_end
      AND c.username IS NOT NULL AND c.username != ''
  ),
  no_action AS (
    SELECT v.user_name, COALESCE(up.segment, 'unknown') AS segment
    FROM visitors v
    LEFT JOIN public.user_profiles up ON up.account_id = p_account_id AND up.cast_name = v_cast AND up.username = v.user_name
    WHERE NOT EXISTS (SELECT 1 FROM session_payers sp WHERE sp.user_name = v.user_name)
  ),
  dm_miss AS (
    SELECT d.user_name, COALESCE(up.segment, 'unknown') AS segment, d.sent_at AS dm_sent_at
    FROM public.dm_send_log d
    LEFT JOIN public.user_profiles up ON up.account_id = p_account_id AND up.cast_name = v_cast AND up.username = d.user_name
    WHERE d.account_id = p_account_id AND d.cast_name = v_cast
      AND d.queued_at >= (v_start - INTERVAL '7 days') AND d.queued_at < v_start
      AND NOT EXISTS (SELECT 1 FROM visitors vis WHERE vis.user_name = d.user_name)
    LIMIT 20
  ),
  seg_bkdn AS (
    SELECT
      COALESCE(up.segment, 'unknown') AS segment,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.dm_send_log d WHERE d.account_id = p_account_id AND d.cast_name = v_cast AND d.user_name = up.username))::INT AS dm_sent,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM visitors v WHERE v.user_name = up.username))::INT AS visited,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM session_payers sp WHERE sp.user_name = up.username))::INT AS paid
    FROM public.user_profiles up
    WHERE up.account_id = p_account_id AND up.cast_name = v_cast
    GROUP BY COALESCE(up.segment, 'unknown')
  )
  SELECT
    COALESCE((SELECT jsonb_agg(row_to_json(ft)) FROM first_timers ft), '[]'::JSONB),
    COALESCE((SELECT jsonb_agg(row_to_json(h)) FROM high h), '[]'::JSONB),
    COALESCE((SELECT jsonb_agg(row_to_json(na)) FROM no_action na LIMIT 20), '[]'::JSONB),
    COALESCE((SELECT jsonb_agg(row_to_json(dm)) FROM dm_miss dm), '[]'::JSONB),
    COALESCE((SELECT jsonb_agg(row_to_json(sb)) FROM seg_bkdn sb), '[]'::JSONB);
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_session_actions(UUID, TEXT) TO authenticated, anon, service_role;

-- 9. get_session_revenue_breakdown
CREATE OR REPLACE FUNCTION public.get_session_revenue_breakdown(
  p_account_id UUID,
  p_cast_name TEXT,
  p_session_date TEXT DEFAULT NULL
)
RETURNS TABLE (
  session_id TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INT,
  revenue_by_type JSONB,
  total_tokens BIGINT,
  unique_users INT,
  new_users INT,
  returning_users INT,
  top_users JSONB,
  prev_session_tokens BIGINT,
  prev_session_date TIMESTAMPTZ,
  change_pct NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH target_sessions AS (
    SELECT s.id::TEXT AS sid, s.started_at AS sa, s.ended_at AS ea,
      s.broadcast_title, s.total_tokens AS sess_tokens,
      GREATEST(1, EXTRACT(EPOCH FROM s.ended_at - s.started_at) / 60)::INT AS dur
    FROM public.sessions s
    WHERE s.account_id = p_account_id AND s.cast_name = p_cast_name
      AND (p_session_date IS NULL OR s.started_at::DATE = p_session_date::DATE)
    ORDER BY s.started_at DESC LIMIT 10
  )
  SELECT
    ts.sid AS session_id,
    ts.broadcast_title AS session_title,
    ts.sa AS started_at,
    ts.ea AS ended_at,
    ts.dur AS duration_minutes,
    COALESCE((
      SELECT jsonb_object_agg(ct.type, ct_s.s)
      FROM (SELECT DISTINCT type FROM public.coin_transactions WHERE account_id = p_account_id AND cast_name = p_cast_name AND date >= ts.sa AND date <= ts.ea) ct
      CROSS JOIN LATERAL (SELECT SUM(tokens)::BIGINT AS s FROM public.coin_transactions WHERE account_id = p_account_id AND cast_name = p_cast_name AND date >= ts.sa AND date <= ts.ea AND type = ct.type) ct_s
    ), '{}'::JSONB) AS revenue_by_type,
    COALESCE((SELECT SUM(tokens) FROM public.coin_transactions WHERE account_id = p_account_id AND cast_name = p_cast_name AND date >= ts.sa AND date <= ts.ea), 0)::BIGINT AS total_tokens,
    (SELECT COUNT(DISTINCT user_name)::INT FROM public.coin_transactions WHERE account_id = p_account_id AND cast_name = p_cast_name AND date >= ts.sa AND date <= ts.ea AND user_name IS NOT NULL AND user_name != 'anonymous') AS unique_users,
    (SELECT COUNT(DISTINCT ct.user_name)::INT FROM public.coin_transactions ct WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name AND ct.date >= ts.sa AND ct.date <= ts.ea AND ct.user_name IS NOT NULL AND ct.user_name != 'anonymous' AND NOT EXISTS (SELECT 1 FROM public.coin_transactions p WHERE p.account_id = p_account_id AND p.cast_name = p_cast_name AND p.user_name = ct.user_name AND p.date < ts.sa)) AS new_users,
    (SELECT COUNT(DISTINCT ct.user_name)::INT FROM public.coin_transactions ct WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name AND ct.date >= ts.sa AND ct.date <= ts.ea AND ct.user_name IS NOT NULL AND ct.user_name != 'anonymous' AND EXISTS (SELECT 1 FROM public.coin_transactions p WHERE p.account_id = p_account_id AND p.cast_name = p_cast_name AND p.user_name = ct.user_name AND p.date < ts.sa)) AS returning_users,
    COALESCE((
      SELECT jsonb_agg(sub ORDER BY sub.tokens DESC)
      FROM (
        SELECT ct.user_name, SUM(ct.tokens)::BIGINT AS tokens, array_agg(DISTINCT ct.type) AS types,
          NOT EXISTS (SELECT 1 FROM public.coin_transactions p WHERE p.account_id = p_account_id AND p.cast_name = p_cast_name AND p.user_name = ct.user_name AND p.date < ts.sa) AS is_new
        FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name AND ct.date >= ts.sa AND ct.date <= ts.ea AND ct.user_name IS NOT NULL AND ct.user_name != 'anonymous'
        GROUP BY ct.user_name ORDER BY SUM(ct.tokens) DESC LIMIT 10
      ) sub
    ), '[]'::JSONB) AS top_users,
    (SELECT SUM(s2.total_tokens)::BIGINT FROM public.sessions s2 WHERE s2.account_id = p_account_id AND s2.cast_name = p_cast_name AND s2.started_at < ts.sa ORDER BY s2.started_at DESC LIMIT 1) AS prev_session_tokens,
    (SELECT s2.started_at FROM public.sessions s2 WHERE s2.account_id = p_account_id AND s2.cast_name = p_cast_name AND s2.started_at < ts.sa ORDER BY s2.started_at DESC LIMIT 1) AS prev_session_date,
    NULL::NUMERIC AS change_pct
  FROM target_sessions ts;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_session_revenue_breakdown(UUID, TEXT, TEXT) TO authenticated, anon, service_role;

-- 10. get_new_users_by_session
CREATE OR REPLACE FUNCTION public.get_new_users_by_session(
  p_account_id UUID,
  p_cast_name TEXT,
  p_session_date TEXT DEFAULT NULL
)
RETURNS TABLE (
  user_name TEXT,
  total_tokens_on_date BIGINT,
  transaction_count INT,
  types TEXT[],
  has_prior_history BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_date DATE := COALESCE(p_session_date::DATE, CURRENT_DATE);
BEGIN
  RETURN QUERY
  SELECT
    ct.user_name,
    SUM(ct.tokens)::BIGINT AS total_tokens_on_date,
    COUNT(*)::INT AS transaction_count,
    array_agg(DISTINCT ct.type) AS types,
    EXISTS (
      SELECT 1 FROM public.coin_transactions p
      WHERE p.account_id = p_account_id AND p.cast_name = p_cast_name
        AND p.user_name = ct.user_name AND p.date::DATE < v_date
    ) AS has_prior_history
  FROM public.coin_transactions ct
  WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
    AND ct.date::DATE = v_date
    AND ct.user_name IS NOT NULL AND ct.user_name != '' AND ct.user_name != 'anonymous'
  GROUP BY ct.user_name
  HAVING NOT EXISTS (
    SELECT 1 FROM public.coin_transactions p
    WHERE p.account_id = p_account_id AND p.cast_name = p_cast_name
      AND p.user_name = ct.user_name AND p.date::DATE < v_date
  )
  ORDER BY SUM(ct.tokens) DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_new_users_by_session(UUID, TEXT, TEXT) TO authenticated, anon, service_role;

-- ============================================================
-- グループ3: アナリティクス（5個）
-- ============================================================

-- 11. get_cast_hourly_performance
CREATE OR REPLACE FUNCTION public.get_cast_hourly_performance(
  p_account_id UUID,
  p_cast_name TEXT,
  p_days INT DEFAULT 30
)
RETURNS TABLE (
  hour_jst INT,
  session_count INT,
  avg_duration_min NUMERIC,
  avg_viewers NUMERIC,
  avg_tokens NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_hour NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    EXTRACT(HOUR FROM s.started_at AT TIME ZONE 'Asia/Tokyo')::INT AS hour_jst,
    COUNT(*)::INT AS session_count,
    ROUND(AVG(EXTRACT(EPOCH FROM s.ended_at - s.started_at) / 60), 1) AS avg_duration_min,
    ROUND(AVG(GREATEST(s.unique_users, s.peak_viewers)), 1) AS avg_viewers,
    ROUND(AVG(s.total_tokens), 0) AS avg_tokens,
    SUM(s.total_tokens)::BIGINT AS total_tokens,
    CASE WHEN AVG(EXTRACT(EPOCH FROM s.ended_at - s.started_at) / 3600) > 0
      THEN ROUND(AVG(s.total_tokens) / NULLIF(AVG(EXTRACT(EPOCH FROM s.ended_at - s.started_at) / 3600), 0), 0)
      ELSE 0 END AS avg_tokens_per_hour
  FROM public.sessions s
  WHERE s.account_id = p_account_id AND s.cast_name = p_cast_name
    AND s.started_at >= NOW() - (p_days || ' days')::INTERVAL
  GROUP BY EXTRACT(HOUR FROM s.started_at AT TIME ZONE 'Asia/Tokyo')
  ORDER BY hour_jst;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_cast_hourly_performance(UUID, TEXT, INT) TO authenticated, anon, service_role;

-- 12. get_user_retention_status
CREATE OR REPLACE FUNCTION public.get_user_retention_status(
  p_account_id UUID,
  p_cast_name TEXT
)
RETURNS TABLE (
  user_name TEXT,
  status TEXT,
  total_tokens BIGINT,
  tip_count BIGINT,
  last_tip TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  first_tip TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    up.username AS user_name,
    CASE
      WHEN ct.last_tip IS NULL AND up.total_tokens = 0 THEN 'free'
      WHEN ct.first_tip >= NOW() - INTERVAL '7 days' AND ct.prior_count = 0 THEN 'new'
      WHEN ct.last_tip >= NOW() - INTERVAL '7 days' THEN 'active'
      WHEN ct.last_tip >= NOW() - INTERVAL '30 days' THEN 'at_risk'
      ELSE 'churned'
    END AS status,
    COALESCE(ct.total_tokens, up.total_tokens)::BIGINT AS total_tokens,
    COALESCE(ct.tip_count, 0)::BIGINT AS tip_count,
    ct.last_tip,
    up.last_seen,
    ct.first_tip
  FROM public.user_profiles up
  LEFT JOIN LATERAL (
    SELECT
      SUM(t.tokens)::BIGINT AS total_tokens,
      COUNT(*)::BIGINT AS tip_count,
      MAX(t.date) AS last_tip,
      MIN(t.date) AS first_tip,
      COUNT(*) FILTER (WHERE t.date < NOW() - INTERVAL '7 days')::BIGINT AS prior_count
    FROM public.coin_transactions t
    WHERE t.account_id = p_account_id AND t.cast_name = p_cast_name AND t.user_name = up.username
      AND t.tokens > 0
  ) ct ON true
  WHERE up.account_id = p_account_id AND up.cast_name = p_cast_name
  ORDER BY COALESCE(ct.total_tokens, up.total_tokens) DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_user_retention_status(UUID, TEXT) TO authenticated, anon, service_role;

-- 13. get_dm_campaign_effectiveness
CREATE OR REPLACE FUNCTION public.get_dm_campaign_effectiveness(
  p_account_id UUID,
  p_cast_name TEXT,
  p_window_days INT DEFAULT 7
)
RETURNS TABLE (
  campaign TEXT,
  sent_count INT,
  success_count INT,
  visited_count INT,
  tipped_count INT,
  tip_amount BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.campaign,
    COUNT(*)::INT AS sent_count,
    COUNT(*) FILTER (WHERE d.status = 'success')::INT AS success_count,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.chat_logs c
      WHERE c.account_id = p_account_id AND c.cast_name = p_cast_name
        AND c.username = d.user_name
        AND c.timestamp > d.queued_at AND c.timestamp < d.queued_at + (p_window_days || ' days')::INTERVAL
    ))::INT AS visited_count,
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.coin_transactions ct
      WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
        AND ct.user_name = d.user_name
        AND ct.date > d.queued_at AND ct.date < d.queued_at + (p_window_days || ' days')::INTERVAL
        AND ct.tokens > 0
    ))::INT AS tipped_count,
    COALESCE(SUM(
      (SELECT COALESCE(SUM(ct.tokens), 0)
       FROM public.coin_transactions ct
       WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
         AND ct.user_name = d.user_name
         AND ct.date > d.queued_at AND ct.date < d.queued_at + (p_window_days || ' days')::INTERVAL
         AND ct.tokens > 0)
    ), 0)::BIGINT AS tip_amount
  FROM public.dm_send_log d
  WHERE d.account_id = p_account_id AND d.cast_name = p_cast_name
    AND d.campaign IS NOT NULL
  GROUP BY d.campaign
  ORDER BY COUNT(*) DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_dm_campaign_effectiveness(UUID, TEXT, INT) TO authenticated, anon, service_role;

-- 14. get_user_acquisition_dashboard
CREATE OR REPLACE FUNCTION public.get_user_acquisition_dashboard(
  p_account_id UUID,
  p_cast_name TEXT,
  p_days INT DEFAULT 30,
  p_min_coins INT DEFAULT 0,
  p_max_coins INT DEFAULT 999999999
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ,
  first_seen TIMESTAMPTZ,
  tx_count INT,
  dm_sent BOOLEAN,
  dm_sent_date TIMESTAMPTZ,
  dm_campaign TEXT,
  segment TEXT,
  is_new_user BOOLEAN,
  converted_after_dm BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    pu.user_name,
    pu.total_coins::BIGINT,
    pu.last_payment_date,
    COALESCE(pu.first_payment_date, up.first_seen) AS first_seen,
    COALESCE(pu.tx_count, 0)::INT AS tx_count,
    dm.dm_exists AS dm_sent,
    dm.last_dm_at AS dm_sent_date,
    dm.last_campaign AS dm_campaign,
    COALESCE(pu.segment, up.segment, 'unknown') AS segment,
    (pu.first_payment_date >= NOW() - (p_days || ' days')::INTERVAL) AS is_new_user,
    (dm.dm_exists AND pu.last_payment_date > dm.last_dm_at) AS converted_after_dm
  FROM public.paid_users pu
  LEFT JOIN public.user_profiles up
    ON up.account_id = p_account_id AND up.cast_name = p_cast_name AND up.username = pu.user_name
  LEFT JOIN LATERAL (
    SELECT
      TRUE AS dm_exists,
      MAX(d.queued_at) AS last_dm_at,
      (array_agg(d.campaign ORDER BY d.queued_at DESC))[1] AS last_campaign
    FROM public.dm_send_log d
    WHERE d.account_id = p_account_id AND d.cast_name = p_cast_name AND d.user_name = pu.user_name
    HAVING COUNT(*) > 0
  ) dm ON true
  WHERE pu.account_id = p_account_id AND pu.cast_name = p_cast_name
    AND pu.total_coins >= p_min_coins AND pu.total_coins <= p_max_coins
    AND (p_days = 0 OR pu.last_payment_date >= NOW() - (p_days || ' days')::INTERVAL)
  ORDER BY pu.total_coins DESC
  LIMIT 500;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_user_acquisition_dashboard(UUID, TEXT, INT, INT, INT) TO authenticated, anon, service_role;

-- 15. search_users_bulk
CREATE OR REPLACE FUNCTION public.search_users_bulk(
  p_account_id UUID,
  p_cast_name TEXT,
  p_user_names TEXT[]
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ,
  first_seen TIMESTAMPTZ,
  tx_count INT,
  dm_sent BOOLEAN,
  dm_sent_date TIMESTAMPTZ,
  dm_campaign TEXT,
  segment TEXT,
  is_new_user BOOLEAN,
  converted_after_dm BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    un.val AS user_name,
    COALESCE(pu.total_coins, 0)::BIGINT AS total_coins,
    pu.last_payment_date,
    COALESCE(pu.first_payment_date, up.first_seen) AS first_seen,
    COALESCE(pu.tx_count, 0)::INT AS tx_count,
    COALESCE(dm.dm_exists, FALSE) AS dm_sent,
    dm.last_dm_at AS dm_sent_date,
    dm.last_campaign AS dm_campaign,
    COALESCE(pu.segment, up.segment, 'unknown') AS segment,
    (pu.first_payment_date >= NOW() - INTERVAL '30 days') AS is_new_user,
    (COALESCE(dm.dm_exists, FALSE) AND pu.last_payment_date > dm.last_dm_at) AS converted_after_dm
  FROM UNNEST(p_user_names) AS un(val)
  LEFT JOIN public.paid_users pu
    ON pu.account_id = p_account_id AND pu.cast_name = p_cast_name AND pu.user_name = un.val
  LEFT JOIN public.user_profiles up
    ON up.account_id = p_account_id AND up.cast_name = p_cast_name AND up.username = un.val
  LEFT JOIN LATERAL (
    SELECT
      TRUE AS dm_exists,
      MAX(d.queued_at) AS last_dm_at,
      (array_agg(d.campaign ORDER BY d.queued_at DESC))[1] AS last_campaign
    FROM public.dm_send_log d
    WHERE d.account_id = p_account_id AND d.cast_name = p_cast_name AND d.user_name = un.val
    HAVING COUNT(*) > 0
  ) dm ON true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.search_users_bulk(UUID, TEXT, TEXT[]) TO authenticated, anon, service_role;

-- ============================================================
-- グループ4: SPY（2個）
-- ============================================================

-- 16. get_spy_cast_stats
CREATE OR REPLACE FUNCTION public.get_spy_cast_stats(
  p_account_id UUID,
  p_cast_names TEXT[]
)
RETURNS TABLE (
  cast_name TEXT,
  total_messages BIGINT,
  total_tips BIGINT,
  total_coins BIGINT,
  unique_users BIGINT,
  last_activity TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    cn.val AS cast_name,
    COALESCE(cl.total_messages, 0)::BIGINT,
    COALESCE(cl.total_tips, 0)::BIGINT,
    COALESCE(cl.total_coins, 0)::BIGINT,
    COALESCE(cl.unique_users, 0)::BIGINT,
    cl.last_activity
  FROM UNNEST(p_cast_names) AS cn(val)
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::BIGINT AS total_messages,
      COUNT(*) FILTER (WHERE c.message_type IN ('tip', 'gift') AND c.tokens > 0)::BIGINT AS total_tips,
      COALESCE(SUM(c.tokens), 0)::BIGINT AS total_coins,
      COUNT(DISTINCT c.username)::BIGINT AS unique_users,
      MAX(c.timestamp) AS last_activity
    FROM public.chat_logs c
    WHERE c.account_id = p_account_id AND c.cast_name = cn.val
  ) cl ON true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_spy_cast_stats(UUID, TEXT[]) TO authenticated, anon, service_role;

-- 17. get_user_activity
CREATE OR REPLACE FUNCTION public.get_user_activity(
  p_account_id UUID,
  p_user_name TEXT
)
RETURNS TABLE (
  cast_name TEXT,
  total_coins BIGINT,
  visit_count BIGINT,
  last_visit TIMESTAMPTZ,
  message_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.cast_name,
    COALESCE(SUM(c.tokens), 0)::BIGINT AS total_coins,
    COUNT(DISTINCT c.timestamp::DATE)::BIGINT AS visit_count,
    MAX(c.timestamp) AS last_visit,
    COUNT(*)::BIGINT AS message_count
  FROM public.chat_logs c
  WHERE c.account_id = p_account_id AND c.username = p_user_name
  GROUP BY c.cast_name
  ORDER BY SUM(c.tokens) DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_user_activity(UUID, TEXT) TO authenticated, anon, service_role;

-- ============================================================
-- グループ6: システム・管理（6個）
-- ============================================================

-- 18. get_sync_health
CREATE OR REPLACE FUNCTION public.get_sync_health(
  p_account_id UUID
)
RETURNS TABLE (
  cast_name TEXT,
  sync_type TEXT,
  last_sync_at TIMESTAMPTZ,
  status TEXT,
  error_count INT,
  last_error TEXT,
  minutes_since_sync INT,
  auto_status TEXT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  -- Chat logs (SPY) sync health
  SELECT
    cl.cast_name,
    'spy_chat'::TEXT AS sync_type,
    cl.last_ts AS last_sync_at,
    CASE WHEN cl.last_ts >= NOW() - INTERVAL '30 minutes' THEN 'ok' ELSE 'stale' END AS status,
    0::INT AS error_count,
    NULL::TEXT AS last_error,
    EXTRACT(EPOCH FROM NOW() - cl.last_ts)::INT / 60 AS minutes_since_sync,
    CASE WHEN cl.last_ts >= NOW() - INTERVAL '30 minutes' THEN 'healthy'
         WHEN cl.last_ts >= NOW() - INTERVAL '2 hours' THEN 'warning'
         ELSE 'critical' END AS auto_status
  FROM (
    SELECT c.cast_name, MAX(c.created_at) AS last_ts
    FROM public.chat_logs c WHERE c.account_id = p_account_id
    GROUP BY c.cast_name
  ) cl

  UNION ALL

  -- Coin transactions sync health
  SELECT
    ct.cast_name,
    'coin_sync'::TEXT AS sync_type,
    ct.last_ts AS last_sync_at,
    CASE WHEN ct.last_ts >= NOW() - INTERVAL '24 hours' THEN 'ok' ELSE 'stale' END AS status,
    0::INT AS error_count,
    NULL::TEXT AS last_error,
    EXTRACT(EPOCH FROM NOW() - ct.last_ts)::INT / 60 AS minutes_since_sync,
    CASE WHEN ct.last_ts >= NOW() - INTERVAL '24 hours' THEN 'healthy'
         WHEN ct.last_ts >= NOW() - INTERVAL '72 hours' THEN 'warning'
         ELSE 'critical' END AS auto_status
  FROM (
    SELECT t.cast_name, MAX(t.synced_at) AS last_ts
    FROM public.coin_transactions t WHERE t.account_id = p_account_id
    GROUP BY t.cast_name
  ) ct

  ORDER BY cast_name, sync_type;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_sync_health(UUID) TO authenticated, anon, service_role;

-- 19. get_coin_sync_status
CREATE OR REPLACE FUNCTION public.get_coin_sync_status()
RETURNS TABLE (
  cast_name TEXT,
  last_synced_at TIMESTAMPTZ,
  hours_since_sync NUMERIC,
  transaction_count BIGINT,
  needs_sync BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    rc.cast_name,
    ct.last_sync AS last_synced_at,
    ROUND(EXTRACT(EPOCH FROM NOW() - ct.last_sync) / 3600, 1) AS hours_since_sync,
    COALESCE(ct.tx_count, 0)::BIGINT AS transaction_count,
    (ct.last_sync IS NULL OR ct.last_sync < NOW() - INTERVAL '24 hours') AS needs_sync
  FROM public.registered_casts rc
  LEFT JOIN LATERAL (
    SELECT MAX(t.synced_at) AS last_sync, COUNT(*)::BIGINT AS tx_count
    FROM public.coin_transactions t
    WHERE t.account_id = rc.account_id AND t.cast_name = rc.cast_name
  ) ct ON true
  ORDER BY rc.cast_name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_coin_sync_status() TO authenticated, anon, service_role;

-- 20. get_transcript_timeline
CREATE OR REPLACE FUNCTION public.get_transcript_timeline(
  p_account_id UUID,
  p_cast_name TEXT,
  p_session_id TEXT
)
RETURNS TABLE (
  "timestamp" TIMESTAMPTZ,
  event_type TEXT,
  description TEXT,
  "user" TEXT,
  tokens BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
BEGIN
  -- Get session time range
  SELECT s.started_at, s.ended_at INTO v_start, v_end
  FROM public.sessions s
  WHERE s.id = p_session_id::UUID AND s.account_id = p_account_id
  LIMIT 1;

  IF v_start IS NULL THEN RETURN; END IF;

  -- Return chat events as timeline (no whisper data yet)
  RETURN QUERY
  SELECT
    c.timestamp AS "timestamp",
    CASE
      WHEN c.tokens > 0 THEN 'tip'
      WHEN c.message_type = 'enter' THEN 'enter'
      WHEN c.message_type = 'system' THEN 'system'
      ELSE 'chat'
    END AS event_type,
    LEFT(c.message, 200) AS description,
    c.username AS "user",
    c.tokens::BIGINT AS tokens
  FROM public.chat_logs c
  WHERE c.account_id = p_account_id AND c.cast_name = p_cast_name
    AND c.timestamp >= v_start AND c.timestamp <= v_end
  ORDER BY c.timestamp
  LIMIT 500;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_transcript_timeline(UUID, TEXT, TEXT) TO authenticated, anon, service_role;

-- 21. check_spy_data_quality
CREATE OR REPLACE FUNCTION public.check_spy_data_quality(
  p_account_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result JSONB := '{"checks": []}'::JSONB;
  v_checks JSONB := '[]'::JSONB;
  v_gap_count INT;
  v_dup_count INT;
  v_stale_count INT;
  v_null_session INT;
  v_unregistered INT;
BEGIN
  -- 1. Gap check: >5min gaps in last 24h per cast
  SELECT COUNT(*)::INT INTO v_gap_count
  FROM (
    SELECT cast_name, timestamp,
      timestamp - LAG(timestamp) OVER (PARTITION BY cast_name ORDER BY timestamp) AS gap
    FROM public.chat_logs
    WHERE account_id = p_account_id AND timestamp >= NOW() - INTERVAL '24 hours'
  ) sub WHERE sub.gap > INTERVAL '5 minutes';

  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id', 'gap_check', 'label', 'Data Gaps (>5min, 24h)',
    'status', CASE WHEN v_gap_count = 0 THEN 'ok' WHEN v_gap_count < 10 THEN 'warn' ELSE 'error' END,
    'count', v_gap_count, 'details', '[]'::JSONB
  ));

  -- 2. Duplicate check: same timestamp+username+cast in last 7d
  SELECT COUNT(*)::INT INTO v_dup_count
  FROM (
    SELECT cast_name, username, timestamp, COUNT(*) AS cnt
    FROM public.chat_logs
    WHERE account_id = p_account_id AND timestamp >= NOW() - INTERVAL '7 days'
    GROUP BY cast_name, username, timestamp
    HAVING COUNT(*) > 1
  ) sub;

  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id', 'dup_check', 'label', 'Duplicate Messages (7d)',
    'status', CASE WHEN v_dup_count = 0 THEN 'ok' WHEN v_dup_count < 50 THEN 'warn' ELSE 'error' END,
    'count', v_dup_count, 'details', '[]'::JSONB
  ));

  -- 3. Freshness: casts with no data in 30min
  SELECT COUNT(DISTINCT cast_name)::INT INTO v_stale_count
  FROM (
    SELECT cast_name, MAX(timestamp) AS last_ts
    FROM public.chat_logs WHERE account_id = p_account_id
    GROUP BY cast_name
    HAVING MAX(timestamp) < NOW() - INTERVAL '30 minutes'
  ) sub;

  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id', 'freshness', 'label', 'Stale Casts (>30min)',
    'status', CASE WHEN v_stale_count = 0 THEN 'ok' ELSE 'warn' END,
    'count', v_stale_count, 'details', '[]'::JSONB
  ));

  -- 4. NULL session_id
  SELECT COUNT(*)::INT INTO v_null_session
  FROM public.chat_logs
  WHERE account_id = p_account_id AND session_id IS NULL AND timestamp >= NOW() - INTERVAL '7 days';

  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id', 'null_session', 'label', 'NULL session_id (7d)',
    'status', CASE WHEN v_null_session = 0 THEN 'ok' WHEN v_null_session < 100 THEN 'warn' ELSE 'error' END,
    'count', v_null_session, 'details', '[]'::JSONB
  ));

  -- 5. Unregistered casts
  SELECT COUNT(DISTINCT c.cast_name)::INT INTO v_unregistered
  FROM public.chat_logs c
  WHERE c.account_id = p_account_id
    AND NOT EXISTS (SELECT 1 FROM public.spy_casts sc WHERE sc.account_id = p_account_id AND sc.cast_name = c.cast_name)
    AND NOT EXISTS (SELECT 1 FROM public.registered_casts rc WHERE rc.account_id = p_account_id AND rc.cast_name = c.cast_name)
    AND c.timestamp >= NOW() - INTERVAL '7 days';

  v_checks := v_checks || jsonb_build_array(jsonb_build_object(
    'id', 'unregistered', 'label', 'Unregistered Casts',
    'status', CASE WHEN v_unregistered = 0 THEN 'ok' ELSE 'warn' END,
    'count', v_unregistered, 'details', '[]'::JSONB
  ));

  v_result := jsonb_build_object('checks', v_checks);
  RETURN v_result;
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_spy_data_quality(UUID) TO authenticated, anon, service_role;

-- 22. count_test_data
CREATE OR REPLACE FUNCTION public.count_test_data(
  p_account_id UUID,
  p_table_name TEXT
)
RETURNS TABLE (
  table_name TEXT,
  total_count BIGINT,
  breakdown JSONB
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count BIGINT;
  v_breakdown JSONB := '[]'::JSONB;
BEGIN
  -- Security: only allow known tables
  IF p_table_name NOT IN ('chat_logs', 'coin_transactions', 'sessions', 'dm_send_log', 'paid_users', 'user_profiles', 'alerts', 'feed_posts', 'ai_reports') THEN
    RAISE EXCEPTION 'Unknown table: %', p_table_name;
  END IF;

  EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE account_id = $1', p_table_name)
  INTO v_count USING p_account_id;

  -- Get breakdown by cast_name if column exists
  BEGIN
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(jsonb_build_object(''prefix'', sub.cast_name, ''count'', sub.cnt)), ''[]''::JSONB) FROM (SELECT cast_name, COUNT(*) AS cnt FROM public.%I WHERE account_id = $1 GROUP BY cast_name ORDER BY cnt DESC LIMIT 20) sub',
      p_table_name
    ) INTO v_breakdown USING p_account_id;
  EXCEPTION WHEN undefined_column THEN
    v_breakdown := '[]'::JSONB;
  END;

  RETURN QUERY SELECT p_table_name, v_count, v_breakdown;
END;
$$;
GRANT EXECUTE ON FUNCTION public.count_test_data(UUID, TEXT) TO authenticated, anon, service_role;

-- 23. delete_test_data
CREATE OR REPLACE FUNCTION public.delete_test_data(
  p_account_id UUID,
  p_table_name TEXT
)
RETURNS TABLE (
  table_name TEXT,
  deleted_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_deleted BIGINT;
BEGIN
  -- Security: only allow known tables
  IF p_table_name NOT IN ('chat_logs', 'coin_transactions', 'sessions', 'dm_send_log', 'paid_users', 'user_profiles', 'alerts', 'feed_posts', 'ai_reports') THEN
    RAISE EXCEPTION 'Unknown table: %', p_table_name;
  END IF;

  EXECUTE format('DELETE FROM public.%I WHERE account_id = $1', p_table_name)
  USING p_account_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT p_table_name, v_deleted;
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_test_data(UUID, TEXT) TO authenticated, anon, service_role;
