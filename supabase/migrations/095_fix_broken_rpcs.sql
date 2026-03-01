-- ============================================================
-- 095: 本番で壊れているRPC 4関数の修正（再デプロイ）
--
-- 問題: 以下4関数が本番で古い/壊れたバージョンのまま残っている
--   1. get_new_users_by_session — ct.username (typo) → ct.user_name
--   2. get_session_list_v2     — 戻り値型 UUID vs TEXT 不一致
--   3. get_session_summary_v2  — UUID = TEXT 比較エラー
--   4. get_transcript_timeline — UUID = TEXT 比較エラー
--
-- 修正: マイグレーション047/053/055の正しいバージョンを再デプロイ
--
-- ROLLBACK:
--   -- これらは修正版の再デプロイなのでロールバック不要
--   -- 必要に応じて各関数をDROP:
--   DROP FUNCTION IF EXISTS get_new_users_by_session(UUID, TEXT, DATE);
--   DROP FUNCTION IF EXISTS get_session_list_v2(UUID, TEXT, INTEGER, INTEGER);
--   DROP FUNCTION IF EXISTS get_session_summary_v2(UUID, TEXT);
--   DROP FUNCTION IF EXISTS get_transcript_timeline(UUID, TEXT, TEXT);
-- ============================================================


-- ============================================================
-- 1. get_new_users_by_session — ct.username → ct.user_name 修正
-- ============================================================
DROP FUNCTION IF EXISTS public.get_new_users_by_session(UUID, TEXT, DATE);

CREATE OR REPLACE FUNCTION public.get_new_users_by_session(
  p_account_id UUID,
  p_cast_name TEXT,
  p_session_date DATE
)
RETURNS TABLE (
  user_name TEXT,
  total_tokens_on_date BIGINT,
  transaction_count INTEGER,
  types TEXT[],
  has_prior_history BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.user_name,
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tokens_on_date,
    COUNT(*)::INTEGER AS transaction_count,
    ARRAY_AGG(DISTINCT ct.type) AS types,
    EXISTS (
      SELECT 1 FROM public.coin_transactions older
      WHERE older.account_id = p_account_id
        AND older.cast_name = p_cast_name
        AND older.user_name = ct.user_name
        AND older.date::date < p_session_date
    ) AS has_prior_history
  FROM public.coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.date::date = p_session_date
    AND ct.tokens > 0
  GROUP BY ct.user_name
  ORDER BY total_tokens_on_date DESC;
END;
$$;


-- ============================================================
-- 2. get_session_list_v2 — 戻り値型修正（DROP→CREATE必須）
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
  with_gap AS (
    SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end
    FROM raw_sessions rs
  ),
  with_group AS (
    SELECT wg.*,
      SUM(
        CASE
          WHEN wg.prev_end IS NULL THEN 1
          WHEN EXTRACT(EPOCH FROM (wg.s_start - wg.prev_end)) > 1800 THEN 1
          ELSE 0
        END
      ) OVER (ORDER BY wg.s_start) AS grp_num
    FROM with_gap wg
  ),
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
  bg_count AS (
    SELECT COUNT(*)::BIGINT AS cnt FROM broadcast_groups
  ),
  paged_bg AS (
    SELECT bg.*
    FROM broadcast_groups bg
    ORDER BY bg.bg_start DESC
    LIMIT p_limit OFFSET p_offset
  ),
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
-- 3. get_session_summary_v2 — UUID vs TEXT比較修正
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
  SELECT sm.cast_name INTO v_cast
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.session_id = p_session_id
  LIMIT 1;

  IF v_cast IS NULL THEN RETURN; END IF;

  WITH raw_sessions AS (
    SELECT sm.session_id AS sid, MIN(sm.message_time) AS s_start, MAX(sm.message_time) AS s_end
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id AND sm.cast_name = v_cast AND sm.session_id IS NOT NULL
    GROUP BY sm.session_id
  ),
  sorted AS (
    SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs
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
    ARRAY_AGG(g.sid ORDER BY g.s_start), MIN(g.s_start), MAX(g.s_end)
  INTO v_session_ids, v_bg_start, v_bg_end
  FROM grouped g
  WHERE g.grp_num = (SELECT tg.grp_num FROM target_grp tg);

  IF v_session_ids IS NULL THEN
    v_session_ids := ARRAY[p_session_id];
    SELECT MIN(sm.message_time), MAX(sm.message_time)
    INTO v_bg_start, v_bg_end
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id AND sm.session_id = p_session_id;
  END IF;

  -- 前回broadcast_group
  WITH raw_sessions AS (
    SELECT sm.session_id AS sid, MIN(sm.message_time) AS s_start, MAX(sm.message_time) AS s_end
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id AND sm.cast_name = v_cast AND sm.session_id IS NOT NULL
    GROUP BY sm.session_id
  ),
  sorted AS (
    SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs
  ),
  grouped AS (
    SELECT ss.*,
      SUM(CASE WHEN ss.prev_end IS NULL OR EXTRACT(EPOCH FROM (ss.s_start - ss.prev_end)) > 1800 THEN 1 ELSE 0 END)
        OVER (ORDER BY ss.s_start) AS grp_num
    FROM sorted ss
  ),
  bg_agg AS (
    SELECT g.grp_num, (ARRAY_AGG(g.sid ORDER BY g.s_start))[1] AS bg_id,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_sids, MIN(g.s_start) AS bg_start, MAX(g.s_end) AS bg_end
    FROM grouped g GROUP BY g.grp_num
  ),
  prev_bg AS (
    SELECT ba.bg_id, ba.bg_sids, ba.bg_start, ba.bg_end
    FROM bg_agg ba WHERE ba.bg_end < v_bg_start
    ORDER BY ba.bg_start DESC LIMIT 1
  )
  SELECT pb.bg_id, pb.bg_start, pb.bg_end
  INTO v_prev_bg_id, v_prev_bg_start, v_prev_bg_end
  FROM prev_bg pb;

  IF v_prev_bg_start IS NOT NULL THEN
    SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT INTO v_prev_revenue
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (ct.cast_name = v_cast OR ct.cast_name IS NULL)
      AND ct.tokens > 0
      AND ct.date >= v_prev_bg_start - INTERVAL '5 minutes'
      AND ct.date <= v_prev_bg_end + INTERVAL '30 minutes';

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
    SELECT COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT INTO v_prev_chat
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id IN (SELECT psi.sid FROM prev_session_ids psi);

    v_prev_revenue := GREATEST(COALESCE(v_prev_chat, 0), COALESCE(v_prev_revenue, 0));
  END IF;

  RETURN QUERY
  WITH
  spy_agg AS (
    SELECT
      COUNT(*)::BIGINT AS sa_msg_count,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.user_name IS NOT NULL AND sm.user_name != '')::BIGINT AS sa_unique_users,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS sa_chat_tokens,
      COUNT(*) FILTER (WHERE sm.tokens > 0)::BIGINT AS sa_tip_count
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id AND sm.session_id = ANY(v_session_ids)
  ),
  type_breakdown AS (
    SELECT COALESCE(jsonb_object_agg(t.msg_type, t.type_tokens), '{}'::JSONB) AS tbt
    FROM (
      SELECT sm.msg_type, SUM(sm.tokens) AS type_tokens
      FROM public.spy_messages sm
      WHERE sm.account_id = p_account_id AND sm.session_id = ANY(v_session_ids) AND sm.tokens > 0
      GROUP BY sm.msg_type
    ) t
  ),
  top5_chat AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('user_name', u.user_name, 'tokens', u.user_tokens, 'tip_count', u.user_tips) ORDER BY u.user_tokens DESC), '[]'::JSONB) AS top_list
    FROM (
      SELECT sm.user_name, SUM(sm.tokens)::BIGINT AS user_tokens, COUNT(*)::BIGINT AS user_tips
      FROM public.spy_messages sm
      WHERE sm.account_id = p_account_id AND sm.session_id = ANY(v_session_ids) AND sm.tokens > 0
        AND sm.user_name IS NOT NULL AND sm.user_name != ''
      GROUP BY sm.user_name ORDER BY SUM(sm.tokens) DESC LIMIT 5
    ) u
  ),
  session_tx AS (
    SELECT ct.* FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND (ct.cast_name = v_cast OR ct.cast_name IS NULL)
      AND ct.tokens > 0
      AND ct.date >= v_bg_start - INTERVAL '5 minutes'
      AND ct.date <= v_bg_end + INTERVAL '30 minutes'
  ),
  coin_total AS (SELECT COALESCE(SUM(st.tokens), 0)::BIGINT AS c_total FROM session_tx st),
  coin_type_agg AS (
    SELECT COALESCE(jsonb_object_agg(t.ctype, t.sum_tokens), '{}'::JSONB) AS c_by_type
    FROM (SELECT st.type AS ctype, SUM(st.tokens)::BIGINT AS sum_tokens FROM session_tx st GROUP BY st.type) t
  ),
  coin_user_agg AS (
    SELECT st.user_name, SUM(st.tokens)::BIGINT AS user_tokens, ARRAY_AGG(DISTINCT st.type) AS user_types,
      EXISTS (
        SELECT 1 FROM public.coin_transactions older
        WHERE older.account_id = p_account_id
          AND (older.cast_name = v_cast OR older.cast_name IS NULL)
          AND older.user_name = st.user_name
          AND older.date < v_bg_start - INTERVAL '5 minutes'
          AND older.tokens > 0
      ) AS has_prior
    FROM session_tx st GROUP BY st.user_name
  ),
  coin_user_stats AS (
    SELECT COUNT(*) FILTER (WHERE NOT cua.has_prior)::INTEGER AS new_u,
           COUNT(*) FILTER (WHERE cua.has_prior)::INTEGER AS ret_u
    FROM coin_user_agg cua
  ),
  coin_top5 AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('user_name', cua.user_name, 'tokens', cua.user_tokens, 'types', cua.user_types, 'is_new', NOT cua.has_prior) ORDER BY cua.user_tokens DESC), '[]'::JSONB) AS top_list
    FROM (SELECT * FROM coin_user_agg ORDER BY user_tokens DESC LIMIT 10) cua
  )
  SELECT
    v_session_ids[1], v_session_ids, v_cast,
    (SELECT MAX(sm2.session_title) FROM public.spy_messages sm2 WHERE sm2.account_id = p_account_id AND sm2.session_id = ANY(v_session_ids)),
    v_bg_start, v_bg_end,
    ROUND(EXTRACT(EPOCH FROM (v_bg_end - v_bg_start)) / 60, 1),
    sa.sa_msg_count, sa.sa_unique_users, sa.sa_chat_tokens, sa.sa_tip_count,
    tb.tbt, t5c.top_list,
    ct_total.c_total, cta.c_by_type, ct5.top_list,
    COALESCE(cus.new_u, 0), COALESCE(cus.ret_u, 0),
    GREATEST(sa.sa_chat_tokens, ct_total.c_total)::BIGINT,
    v_prev_bg_id, v_prev_revenue, v_prev_bg_start,
    CASE WHEN v_prev_revenue IS NOT NULL AND v_prev_revenue > 0
      THEN ROUND((GREATEST(sa.sa_chat_tokens, ct_total.c_total)::NUMERIC - v_prev_revenue) / v_prev_revenue * 100, 1)
      ELSE NULL
    END
  FROM spy_agg sa
  CROSS JOIN type_breakdown tb
  CROSS JOIN top5_chat t5c
  CROSS JOIN coin_total ct_total
  CROSS JOIN coin_type_agg cta
  CROSS JOIN coin_user_stats cus
  CROSS JOIN coin_top5 ct5;
END;
$$;


-- ============================================================
-- 4. get_transcript_timeline — UUID vs TEXT キャスト修正（再デプロイ）
-- ============================================================
DROP FUNCTION IF EXISTS public.get_transcript_timeline(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_transcript_timeline(
  p_account_id UUID,
  p_cast_name  TEXT,
  p_session_id TEXT
)
RETURNS TABLE (
  event_time  TIMESTAMPTZ,
  event_type  TEXT,
  user_name   TEXT,
  message     TEXT,
  tokens      INTEGER,
  coin_type   TEXT,
  confidence  NUMERIC,
  elapsed_sec INTEGER,
  is_highlight BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session_start TIMESTAMPTZ;
  v_session_end   TIMESTAMPTZ;
  v_recording_start TIMESTAMPTZ;
BEGIN
  SELECT MIN(sm.message_time), MAX(sm.message_time)
    INTO v_session_start, v_session_end
    FROM public.spy_messages sm
   WHERE sm.account_id = p_account_id
     AND sm.cast_name  = p_cast_name
     AND sm.session_id = p_session_id;

  IF v_session_start IS NULL THEN RETURN; END IF;

  SELECT ct.recording_started_at INTO v_recording_start
    FROM public.cast_transcripts ct
   WHERE ct.account_id = p_account_id
     AND ct.cast_name  = p_cast_name
     AND ct.session_id = p_session_id::UUID
     AND ct.recording_started_at IS NOT NULL
   LIMIT 1;

  RETURN QUERY
  WITH
  transcripts AS (
    SELECT
      COALESCE(
        ct.absolute_start_at,
        CASE WHEN v_recording_start IS NOT NULL AND ct.segment_start_seconds IS NOT NULL
             THEN v_recording_start + (ct.segment_start_seconds || ' seconds')::INTERVAL
             ELSE v_session_start + COALESCE((ct.segment_start_seconds || ' seconds')::INTERVAL, INTERVAL '0')
        END
      ) AS evt_time,
      'transcript'::TEXT AS evt_type,
      NULL::TEXT AS evt_user,
      ct.text AS evt_message,
      0::INTEGER AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      ct.confidence AS evt_confidence
    FROM public.cast_transcripts ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name  = p_cast_name
      AND ct.session_id = p_session_id::UUID
      AND ct.processing_status = 'completed'
  ),
  spy AS (
    SELECT
      sm.message_time AS evt_time,
      CASE
        WHEN sm.tokens > 0 THEN 'tip'
        WHEN sm.msg_type = 'enter' THEN 'enter'
        WHEN sm.msg_type = 'leave' THEN 'leave'
        ELSE 'chat'
      END::TEXT AS evt_type,
      sm.user_name AS evt_user,
      sm.message AS evt_message,
      COALESCE(sm.tokens, 0)::INTEGER AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name  = p_cast_name
      AND sm.session_id = p_session_id
  ),
  coins AS (
    SELECT
      coin.date AS evt_time,
      'coin'::TEXT AS evt_type,
      coin.user_name AS evt_user,
      coin.source_detail AS evt_message,
      coin.tokens::INTEGER AS evt_tokens,
      coin.type AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.coin_transactions coin
    WHERE coin.account_id = p_account_id
      AND coin.cast_name  = p_cast_name
      AND coin.date >= v_session_start - INTERVAL '5 minutes'
      AND coin.date <= v_session_end   + INTERVAL '5 minutes'
  ),
  merged AS (
    SELECT * FROM transcripts UNION ALL
    SELECT * FROM spy UNION ALL
    SELECT * FROM coins
  ),
  payment_times AS (
    SELECT evt_time FROM merged WHERE evt_type IN ('tip', 'coin') AND evt_tokens > 0
  )
  SELECT
    m.evt_time, m.evt_type, m.evt_user, m.evt_message, m.evt_tokens,
    m.evt_coin_type, m.evt_confidence,
    EXTRACT(EPOCH FROM (m.evt_time - v_session_start))::INTEGER AS elapsed_sec,
    (m.evt_type = 'transcript' AND EXISTS (
      SELECT 1 FROM payment_times pt
       WHERE pt.evt_time BETWEEN m.evt_time - INTERVAL '30 seconds'
                              AND m.evt_time + INTERVAL '30 seconds'
    ))::BOOLEAN AS is_highlight
  FROM merged m
  ORDER BY m.evt_time ASC, m.evt_type ASC;
END;
$$;

COMMENT ON FUNCTION public.get_transcript_timeline(UUID, TEXT, TEXT)
  IS '文字起こし+チャット+課金を時刻順に統合するタイムラインRPC';


-- PostgREST スキーマキャッシュリロード
NOTIFY pgrst, 'reload schema';
