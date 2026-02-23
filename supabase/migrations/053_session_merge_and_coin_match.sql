-- ============================================================
-- 053: セッション統合 + coin_transactions突合
-- 問題1: Chrome拡張の再接続で1配信が複数session_idに分割される
-- 問題2: セッション一覧がspy_messages.tokensのみ（coin_transactionsの
--         private/ticket/spy等の売上が反映されない）
-- 解決: 30分ギャップでセッションをbroadcast_groupにマージ +
--       coin_transactionsの時間範囲マッチング
-- 注意: spy_sessions, spy_logs は存在しない — 参照禁止
-- ============================================================

-- ============================================================
-- 1. get_session_list_v2: broadcast_group単位のセッション一覧
-- ============================================================
DROP FUNCTION IF EXISTS public.get_session_list_v2(UUID, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.get_session_list_v2(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  broadcast_group_id TEXT,
  session_ids TEXT[],
  cast_name TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC,
  msg_count BIGINT,
  unique_users BIGINT,
  chat_tokens BIGINT,
  tip_count BIGINT,
  coin_tokens BIGINT,
  coin_tip_tokens BIGINT,
  coin_private_tokens BIGINT,
  coin_ticket_tokens BIGINT,
  coin_group_tokens BIGINT,
  coin_spy_tokens BIGINT,
  coin_other_tokens BIGINT,
  total_revenue BIGINT,
  is_active BOOLEAN,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH
  -- Step 1: spy_messages から session_id 別の基本統計
  raw_sessions AS (
    SELECT
      sm.session_id AS sid,
      sm.cast_name AS cn,
      MAX(sm.session_title) AS stitle,
      MIN(sm.message_time) AS s_start,
      MAX(sm.message_time) AS s_end,
      COUNT(*) AS s_msg_count,
      COUNT(DISTINCT sm.user_name) FILTER (
        WHERE sm.user_name IS NOT NULL AND sm.user_name != ''
      ) AS s_unique_users,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS s_chat_tokens,
      COUNT(*) FILTER (WHERE sm.tokens > 0) AS s_tip_count
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = p_cast_name
      AND sm.session_id IS NOT NULL
    GROUP BY sm.session_id, sm.cast_name
  ),

  -- Step 2: 開始時刻順にソートし、前セッションとのギャップを計算
  with_gap AS (
    SELECT
      rs.*,
      LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end
    FROM raw_sessions rs
  ),

  -- Step 3: 30分以上のギャップがあれば新しいbroadcast_groupを開始
  with_group AS (
    SELECT
      wg.*,
      SUM(
        CASE
          WHEN wg.prev_end IS NULL THEN 1
          WHEN EXTRACT(EPOCH FROM (wg.s_start - wg.prev_end)) > 1800 THEN 1
          ELSE 0
        END
      ) OVER (ORDER BY wg.s_start) AS grp_num
    FROM with_gap wg
  ),

  -- Step 4: broadcast_group単位で集約
  broadcast_groups AS (
    SELECT
      g.grp_num,
      g.cn,
      (ARRAY_AGG(g.stitle ORDER BY g.s_msg_count DESC NULLS LAST))[1] AS bg_title,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_session_ids,
      MIN(g.s_start) AS bg_start,
      MAX(g.s_end) AS bg_end,
      SUM(g.s_msg_count)::BIGINT AS bg_msg_count,
      SUM(g.s_tip_count)::BIGINT AS bg_tip_count,
      SUM(g.s_chat_tokens)::BIGINT AS bg_chat_tokens
    FROM with_group g
    GROUP BY g.grp_num, g.cn
  ),

  -- Step 4.5: ユニークユーザーはセッション横断で再計算
  bg_unique_users AS (
    SELECT
      bg.grp_num,
      COUNT(DISTINCT sm.user_name) FILTER (
        WHERE sm.user_name IS NOT NULL AND sm.user_name != ''
      ) AS bg_unique
    FROM broadcast_groups bg
    JOIN public.spy_messages sm
      ON sm.account_id = p_account_id
      AND sm.cast_name = p_cast_name
      AND sm.session_id = ANY(bg.bg_session_ids)
    GROUP BY bg.grp_num
  ),

  -- 全broadcast_group数（ページネーション用）
  bg_count AS (
    SELECT COUNT(*)::BIGINT AS cnt FROM broadcast_groups
  ),

  -- ページネーション適用
  paged_bg AS (
    SELECT bg.*
    FROM broadcast_groups bg
    ORDER BY bg.bg_start DESC
    LIMIT p_limit OFFSET p_offset
  ),

  -- Step 5: coin_transactions を時間範囲でマッチング
  -- 範囲: started_at - 5分 ～ ended_at + 30分
  coin_match AS (
    SELECT
      pbg.grp_num,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS c_total,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'tip'), 0)::BIGINT AS c_tip,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'private'), 0)::BIGINT AS c_private,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'ticket'), 0)::BIGINT AS c_ticket,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'group'), 0)::BIGINT AS c_group,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'spy'), 0)::BIGINT AS c_spy,
      COALESCE(SUM(ct.tokens) FILTER (
        WHERE ct.type NOT IN ('tip', 'private', 'ticket', 'group', 'spy')
      ), 0)::BIGINT AS c_other
    FROM paged_bg pbg
    LEFT JOIN public.coin_transactions ct
      ON ct.account_id = p_account_id
      AND (ct.cast_name = p_cast_name OR ct.cast_name IS NULL)
      AND ct.tokens > 0
      AND ct.date >= pbg.bg_start - INTERVAL '5 minutes'
      AND ct.date <= pbg.bg_end + INTERVAL '30 minutes'
    GROUP BY pbg.grp_num
  )

  -- 最終結果
  SELECT
    pbg.bg_session_ids[1] AS broadcast_group_id,
    pbg.bg_session_ids AS session_ids,
    pbg.cn AS cast_name,
    pbg.bg_title AS session_title,
    pbg.bg_start AS started_at,
    pbg.bg_end AS ended_at,
    ROUND(EXTRACT(EPOCH FROM (pbg.bg_end - pbg.bg_start)) / 60, 1) AS duration_minutes,
    pbg.bg_msg_count AS msg_count,
    COALESCE(buu.bg_unique, 0)::BIGINT AS unique_users,
    pbg.bg_chat_tokens AS chat_tokens,
    pbg.bg_tip_count AS tip_count,
    COALESCE(cm.c_total, 0)::BIGINT AS coin_tokens,
    COALESCE(cm.c_tip, 0)::BIGINT AS coin_tip_tokens,
    COALESCE(cm.c_private, 0)::BIGINT AS coin_private_tokens,
    COALESCE(cm.c_ticket, 0)::BIGINT AS coin_ticket_tokens,
    COALESCE(cm.c_group, 0)::BIGINT AS coin_group_tokens,
    COALESCE(cm.c_spy, 0)::BIGINT AS coin_spy_tokens,
    COALESCE(cm.c_other, 0)::BIGINT AS coin_other_tokens,
    GREATEST(pbg.bg_chat_tokens, COALESCE(cm.c_total, 0))::BIGINT AS total_revenue,
    (pbg.bg_end > NOW() - INTERVAL '10 minutes') AS is_active,
    (SELECT cnt FROM bg_count) AS total_count
  FROM paged_bg pbg
  LEFT JOIN bg_unique_users buu ON buu.grp_num = pbg.grp_num
  LEFT JOIN coin_match cm ON cm.grp_num = pbg.grp_num
  ORDER BY pbg.bg_start DESC;
END;
$$;


-- ============================================================
-- 2. get_session_summary_v2: broadcast_group単位の詳細サマリー
-- p_session_id は broadcast_group内の任意のsession_id（自動解決）
-- ============================================================
DROP FUNCTION IF EXISTS public.get_session_summary_v2(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.get_session_summary_v2(
  p_account_id UUID,
  p_session_id TEXT
)
RETURNS TABLE (
  broadcast_group_id TEXT,
  session_ids TEXT[],
  cast_name TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC,
  msg_count BIGINT,
  unique_users BIGINT,
  chat_tokens BIGINT,
  tip_count BIGINT,
  tokens_by_type JSONB,
  top_chatters JSONB,
  coin_tokens BIGINT,
  coin_by_type JSONB,
  coin_top_users JSONB,
  coin_new_users INTEGER,
  coin_returning_users INTEGER,
  total_revenue BIGINT,
  prev_broadcast_group_id TEXT,
  prev_total_revenue BIGINT,
  prev_started_at TIMESTAMPTZ,
  change_pct NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cast TEXT;
  v_session_ids TEXT[];
  v_bg_start TIMESTAMPTZ;
  v_bg_end TIMESTAMPTZ;
  v_prev_bg_id TEXT;
  v_prev_bg_start TIMESTAMPTZ;
  v_prev_bg_end TIMESTAMPTZ;
  v_prev_revenue BIGINT;
  v_prev_chat BIGINT;
BEGIN
  -- p_session_idのcast_nameを特定
  SELECT sm.cast_name
  INTO v_cast
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.session_id = p_session_id
  LIMIT 1;

  IF v_cast IS NULL THEN
    RETURN;
  END IF;

  -- 同キャストの全セッションをグルーピングし、p_session_idが属するグループを特定
  WITH raw_sessions AS (
    SELECT
      sm.session_id AS sid,
      MIN(sm.message_time) AS s_start,
      MAX(sm.message_time) AS s_end
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = v_cast
      AND sm.session_id IS NOT NULL
    GROUP BY sm.session_id
  ),
  sorted AS (
    SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end
    FROM raw_sessions rs
  ),
  grouped AS (
    SELECT ss.*,
      SUM(CASE WHEN ss.prev_end IS NULL OR EXTRACT(EPOCH FROM (ss.s_start - ss.prev_end)) > 1800 THEN 1 ELSE 0 END)
        OVER (ORDER BY ss.s_start) AS grp_num
    FROM sorted ss
  ),
  target_grp AS (
    SELECT g.grp_num FROM grouped g WHERE g.sid = p_session_id LIMIT 1
  )
  SELECT
    ARRAY_AGG(g.sid ORDER BY g.s_start),
    MIN(g.s_start),
    MAX(g.s_end)
  INTO v_session_ids, v_bg_start, v_bg_end
  FROM grouped g
  WHERE g.grp_num = (SELECT tg.grp_num FROM target_grp tg);

  IF v_session_ids IS NULL THEN
    v_session_ids := ARRAY[p_session_id];
    -- v_bg_start/v_bg_endを直接取得
    SELECT MIN(sm.message_time), MAX(sm.message_time)
    INTO v_bg_start, v_bg_end
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id AND sm.session_id = p_session_id;
  END IF;

  -- 前回broadcast_groupを特定
  WITH raw_sessions AS (
    SELECT
      sm.session_id AS sid,
      MIN(sm.message_time) AS s_start,
      MAX(sm.message_time) AS s_end
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = v_cast
      AND sm.session_id IS NOT NULL
    GROUP BY sm.session_id
  ),
  sorted AS (
    SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end
    FROM raw_sessions rs
  ),
  grouped AS (
    SELECT ss.*,
      SUM(CASE WHEN ss.prev_end IS NULL OR EXTRACT(EPOCH FROM (ss.s_start - ss.prev_end)) > 1800 THEN 1 ELSE 0 END)
        OVER (ORDER BY ss.s_start) AS grp_num
    FROM sorted ss
  ),
  bg_agg AS (
    SELECT
      g.grp_num,
      (ARRAY_AGG(g.sid ORDER BY g.s_start))[1] AS bg_id,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_sids,
      MIN(g.s_start) AS bg_start,
      MAX(g.s_end) AS bg_end
    FROM grouped g
    GROUP BY g.grp_num
  ),
  prev_bg AS (
    SELECT ba.bg_id, ba.bg_sids, ba.bg_start, ba.bg_end
    FROM bg_agg ba
    WHERE ba.bg_end < v_bg_start
    ORDER BY ba.bg_start DESC
    LIMIT 1
  )
  SELECT pb.bg_id, pb.bg_start, pb.bg_end
  INTO v_prev_bg_id, v_prev_bg_start, v_prev_bg_end
  FROM prev_bg pb;

  -- 前回のrevenue（coin + chat）
  IF v_prev_bg_start IS NOT NULL THEN
    SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT
    INTO v_prev_revenue
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (ct.cast_name = v_cast OR ct.cast_name IS NULL)
      AND ct.tokens > 0
      AND ct.date >= v_prev_bg_start - INTERVAL '5 minutes'
      AND ct.date <= v_prev_bg_end + INTERVAL '30 minutes';

    -- 前回のchat tokens
    WITH prev_sids AS (
      SELECT sm.session_id AS sid, MIN(sm.message_time) AS s_start, MAX(sm.message_time) AS s_end
      FROM public.spy_messages sm
      WHERE sm.account_id = p_account_id AND sm.cast_name = v_cast AND sm.session_id IS NOT NULL
      GROUP BY sm.session_id
    ),
    prev_sorted AS (
      SELECT ps.*, LAG(ps.s_end) OVER (ORDER BY ps.s_start) AS pe FROM prev_sids ps
    ),
    prev_grouped AS (
      SELECT pss.*,
        SUM(CASE WHEN pss.pe IS NULL OR EXTRACT(EPOCH FROM (pss.s_start - pss.pe)) > 1800 THEN 1 ELSE 0 END)
          OVER (ORDER BY pss.s_start) AS gn
      FROM prev_sorted pss
    ),
    prev_target AS (
      SELECT pg.gn FROM prev_grouped pg WHERE pg.sid = v_prev_bg_id LIMIT 1
    ),
    prev_session_ids AS (
      SELECT pg.sid FROM prev_grouped pg WHERE pg.gn = (SELECT pt.gn FROM prev_target pt)
    )
    SELECT COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT
    INTO v_prev_chat
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id IN (SELECT psi.sid FROM prev_session_ids psi);

    v_prev_revenue := GREATEST(COALESCE(v_prev_chat, 0), COALESCE(v_prev_revenue, 0));
  END IF;

  -- メインクエリ
  RETURN QUERY
  WITH
  -- spy_messages 集計
  spy_agg AS (
    SELECT
      COUNT(*)::BIGINT AS sa_msg_count,
      COUNT(DISTINCT sm.user_name) FILTER (
        WHERE sm.user_name IS NOT NULL AND sm.user_name != ''
      )::BIGINT AS sa_unique_users,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS sa_chat_tokens,
      COUNT(*) FILTER (WHERE sm.tokens > 0)::BIGINT AS sa_tip_count
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = ANY(v_session_ids)
  ),
  -- msg_type別内訳 (chat tokens)
  type_breakdown AS (
    SELECT COALESCE(
      jsonb_object_agg(t.msg_type, t.type_tokens),
      '{}'::JSONB
    ) AS tbt
    FROM (
      SELECT sm.msg_type, SUM(sm.tokens) AS type_tokens
      FROM public.spy_messages sm
      WHERE sm.account_id = p_account_id
        AND sm.session_id = ANY(v_session_ids)
        AND sm.tokens > 0
      GROUP BY sm.msg_type
    ) t
  ),
  -- トップ5チャッター
  top5_chat AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'user_name', u.user_name,
          'tokens', u.user_tokens,
          'tip_count', u.user_tips
        ) ORDER BY u.user_tokens DESC
      ),
      '[]'::JSONB
    ) AS top_list
    FROM (
      SELECT
        sm.user_name,
        SUM(sm.tokens)::BIGINT AS user_tokens,
        COUNT(*)::BIGINT AS user_tips
      FROM public.spy_messages sm
      WHERE sm.account_id = p_account_id
        AND sm.session_id = ANY(v_session_ids)
        AND sm.tokens > 0
        AND sm.user_name IS NOT NULL AND sm.user_name != ''
      GROUP BY sm.user_name
      ORDER BY SUM(sm.tokens) DESC
      LIMIT 5
    ) u
  ),
  -- coin_transactions 集計
  session_tx AS (
    SELECT ct.*
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (ct.cast_name = v_cast OR ct.cast_name IS NULL)
      AND ct.tokens > 0
      AND ct.date >= v_bg_start - INTERVAL '5 minutes'
      AND ct.date <= v_bg_end + INTERVAL '30 minutes'
  ),
  coin_total AS (
    SELECT COALESCE(SUM(st.tokens), 0)::BIGINT AS c_total
    FROM session_tx st
  ),
  coin_type_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(t.ctype, t.sum_tokens),
      '{}'::JSONB
    ) AS c_by_type
    FROM (
      SELECT st.type AS ctype, SUM(st.tokens)::BIGINT AS sum_tokens
      FROM session_tx st
      GROUP BY st.type
    ) t
  ),
  coin_user_agg AS (
    SELECT
      st.user_name,
      SUM(st.tokens)::BIGINT AS user_tokens,
      ARRAY_AGG(DISTINCT st.type) AS user_types,
      EXISTS (
        SELECT 1 FROM public.coin_transactions older
        WHERE older.account_id = p_account_id
          AND (older.cast_name = v_cast OR older.cast_name IS NULL)
          AND older.user_name = st.user_name
          AND older.date < v_bg_start - INTERVAL '5 minutes'
          AND older.tokens > 0
      ) AS has_prior
    FROM session_tx st
    GROUP BY st.user_name
  ),
  coin_user_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE NOT cua.has_prior)::INTEGER AS new_u,
      COUNT(*) FILTER (WHERE cua.has_prior)::INTEGER AS ret_u
    FROM coin_user_agg cua
  ),
  coin_top5 AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'user_name', cua.user_name,
          'tokens', cua.user_tokens,
          'types', cua.user_types,
          'is_new', NOT cua.has_prior
        ) ORDER BY cua.user_tokens DESC
      ),
      '[]'::JSONB
    ) AS top_list
    FROM (SELECT * FROM coin_user_agg ORDER BY user_tokens DESC LIMIT 10) cua
  )
  SELECT
    v_session_ids[1] AS broadcast_group_id,
    v_session_ids AS session_ids,
    v_cast AS cast_name,
    (SELECT MAX(sm2.session_title) FROM public.spy_messages sm2
     WHERE sm2.account_id = p_account_id AND sm2.session_id = ANY(v_session_ids)
    ) AS session_title,
    v_bg_start AS started_at,
    v_bg_end AS ended_at,
    ROUND(EXTRACT(EPOCH FROM (v_bg_end - v_bg_start)) / 60, 1) AS duration_minutes,
    sa.sa_msg_count AS msg_count,
    sa.sa_unique_users AS unique_users,
    sa.sa_chat_tokens AS chat_tokens,
    sa.sa_tip_count AS tip_count,
    tb.tbt AS tokens_by_type,
    t5c.top_list AS top_chatters,
    ct_total.c_total AS coin_tokens,
    cta.c_by_type AS coin_by_type,
    ct5.top_list AS coin_top_users,
    COALESCE(cus.new_u, 0) AS coin_new_users,
    COALESCE(cus.ret_u, 0) AS coin_returning_users,
    GREATEST(sa.sa_chat_tokens, ct_total.c_total)::BIGINT AS total_revenue,
    v_prev_bg_id AS prev_broadcast_group_id,
    v_prev_revenue AS prev_total_revenue,
    v_prev_bg_start AS prev_started_at,
    CASE
      WHEN v_prev_revenue IS NOT NULL AND v_prev_revenue > 0 THEN
        ROUND((GREATEST(sa.sa_chat_tokens, ct_total.c_total)::NUMERIC - v_prev_revenue) / v_prev_revenue * 100, 1)
      ELSE NULL
    END AS change_pct
  FROM spy_agg sa
  CROSS JOIN type_breakdown tb
  CROSS JOIN top5_chat t5c
  CROSS JOIN coin_total ct_total
  CROSS JOIN coin_type_agg cta
  CROSS JOIN coin_user_stats cus
  CROSS JOIN coin_top5 ct5;
END;
$$;


-- 053 done
