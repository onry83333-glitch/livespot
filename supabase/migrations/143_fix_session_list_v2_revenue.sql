-- ============================================================
-- 143: get_session_list_v2 の売上データソースを修正
-- 問題: migration 127 で sessions.total_tokens のみを使うように簡略化され、
--       売上が89%欠落（sessions.total_tokensは信頼性低）
-- 修正: spy_messages の SUM(tokens) WHERE tokens > 0 で集計
--       + coin_transactions との突合で GREATEST を取る（053のロジック復元）
-- 参照: Notion「SPYデータ vs coin_transactions 差分分析ナレッジ」
-- ============================================================

DROP FUNCTION IF EXISTS public.get_session_list_v2(UUID, TEXT, INT, INT);

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
  WITH
  -- Step 1: sessions テーブルから30分ギャップでグルーピング
  ordered AS (
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
      g.gid,
      (array_agg(g.id::TEXT ORDER BY g.started_at))[1] AS grp_id,
      array_agg(g.session_id ORDER BY g.started_at) AS session_ids,
      MIN(g.started_at)::DATE AS g_session_date,
      MIN(g.started_at) AS g_session_start,
      MAX(g.ended_at) AS g_session_end,
      GREATEST(1, EXTRACT(EPOCH FROM MAX(g.ended_at) - MIN(g.started_at)) / 60)::INT AS g_duration_minutes,
      GREATEST(MAX(g.unique_users), 0)::INT AS g_unique_users,
      (array_agg(g.broadcast_title ORDER BY g.started_at) FILTER (WHERE g.broadcast_title IS NOT NULL))[1] AS g_broadcast_title,
      COUNT(*)::INT AS g_session_count
    FROM with_gid g
    GROUP BY g.gid
  ),

  -- ページネーション適用
  paged AS (
    SELECT gr.*
    FROM grouped gr
    ORDER BY gr.g_session_start DESC
    LIMIT p_limit OFFSET p_offset
  ),

  -- Step 2: spy_messages から売上・メッセージ数を集計（sessions.total_tokensは使わない）
  spy_agg AS (
    SELECT
      p.gid,
      COUNT(sm.id)::INT AS sa_msg_count,
      COUNT(sm.id) FILTER (WHERE sm.tokens > 0)::INT AS sa_tip_count,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS sa_chat_tokens
    FROM paged p
    JOIN public.spy_messages sm
      ON sm.account_id = p_account_id
      AND sm.cast_name = p_cast_name
      AND sm.session_id = ANY(p.session_ids)
    GROUP BY p.gid
  ),

  -- Step 3: coin_transactions を時間範囲でマッチング（自社キャストの正確な売上用）
  coin_match AS (
    SELECT
      p.gid,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS c_total
    FROM paged p
    LEFT JOIN public.coin_transactions ct
      ON ct.account_id = p_account_id
      AND (ct.cast_name = p_cast_name OR ct.cast_name IS NULL)
      AND ct.tokens > 0
      AND ct.date >= p.g_session_start - INTERVAL '5 minutes'
      AND ct.date <= p.g_session_end + INTERVAL '30 minutes'
    GROUP BY p.gid
  )

  -- 最終結果: GREATEST(spy_messages合計, coin_transactions合計)
  SELECT
    p.grp_id AS id,
    p.g_session_date AS session_date,
    p.g_session_start AS session_start,
    p.g_session_end AS session_end,
    p.g_duration_minutes AS duration_minutes,
    COALESCE(sa.sa_msg_count, 0)::INT AS message_count,
    COALESCE(sa.sa_tip_count, 0)::INT AS tip_count,
    GREATEST(COALESCE(sa.sa_chat_tokens, 0), COALESCE(cm.c_total, 0))::BIGINT AS total_coins,
    COALESCE(sa.sa_chat_tokens, 0)::BIGINT AS chat_tokens,
    p.g_unique_users AS unique_users,
    p.g_broadcast_title AS broadcast_title,
    p.g_session_count AS session_count
  FROM paged p
  LEFT JOIN spy_agg sa ON sa.gid = p.gid
  LEFT JOIN coin_match cm ON cm.gid = p.gid
  ORDER BY p.g_session_start DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_session_list_v2(UUID, TEXT, INT, INT) TO authenticated, anon, service_role;
