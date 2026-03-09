-- 114: get_session_list_v2 tip_count をcoin_transactionsからも取得
-- ============================================================
-- 問題: tip_count は chat_logs の COUNT(*) FILTER (WHERE tokens > 0) のみ。
-- total_revenue は GREATEST(chat_tokens, coin_total) で coin_transactions も考慮。
-- → coin_transactions にデータがあるが chat_logs にtipデータがないセッションで
--    TIP=0 なのに COINS>0 になるバグ。
-- 修正: coin_match に c_count (取引件数) を追加し、tip_count を
--        GREATEST(bg_tip_count, c_count) で返す。
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
      COUNT(*)::BIGINT AS c_count,
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
    pbg.bg_msg_count, COALESCE(buu.bg_unique, 0)::BIGINT, pbg.bg_chat_tokens,
    -- tip_count: chat_logs と coin_transactions の大きい方を採用（total_revenue と同じ方針）
    GREATEST(pbg.bg_tip_count, COALESCE(cm.c_count, 0))::BIGINT,
    COALESCE(cm.c_total, 0)::BIGINT, COALESCE(cm.c_tip, 0)::BIGINT, COALESCE(cm.c_private, 0)::BIGINT,
    COALESCE(cm.c_ticket, 0)::BIGINT, COALESCE(cm.c_group, 0)::BIGINT, COALESCE(cm.c_spy, 0)::BIGINT,
    COALESCE(cm.c_other, 0)::BIGINT,
    GREATEST(pbg.bg_chat_tokens, COALESCE(cm.c_total, 0))::BIGINT,
    (pbg.bg_end > NOW() - INTERVAL '10 minutes'), (SELECT cnt FROM bg_count)
  FROM paged_bg pbg LEFT JOIN bg_unique_users buu ON buu.grp_num = pbg.grp_num
  LEFT JOIN coin_match cm ON cm.grp_num = pbg.grp_num ORDER BY pbg.bg_start DESC;
END;
$fn$;
