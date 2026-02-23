-- ============================================================
-- 049: get_session_list + get_session_summary RPCs
-- 配信単位ビュー — セッション一覧 + 個別サマリー
-- ============================================================

-- ============================================================
-- 1. get_session_list: キャストのセッション一覧（ページネーション付き）
--    sessions テーブルと coin_transactions を突合して売上を計算
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_session_list(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  session_id TEXT,
  title TEXT,
  cast_name TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  total_messages INTEGER,
  total_tokens BIGINT,
  peak_viewers INTEGER,
  unique_chatters INTEGER,
  tip_count INTEGER,
  coin_revenue BIGINT,       -- coin_transactions ベース売上
  is_active BOOLEAN,
  total_count BIGINT         -- ページネーション用: 全件数
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total BIGINT;
BEGIN
  -- 全件数をカウント
  SELECT COUNT(*) INTO v_total
  FROM public.sessions s
  WHERE s.account_id = p_account_id
    AND COALESCE(s.cast_name, s.title) = p_cast_name;

  RETURN QUERY
  WITH sess AS (
    SELECT
      s.session_id,
      COALESCE(s.title, s.cast_name) AS title,
      COALESCE(s.cast_name, s.title) AS cast_name,
      s.started_at,
      s.ended_at,
      EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at))::INTEGER / 60 AS duration_minutes,
      s.total_messages,
      COALESCE(s.total_tokens, 0)::BIGINT AS total_tokens,
      COALESCE(s.peak_viewers, 0) AS peak_viewers,
      (s.ended_at IS NULL) AS is_active
    FROM public.sessions s
    WHERE s.account_id = p_account_id
      AND COALESCE(s.cast_name, s.title) = p_cast_name
    ORDER BY s.started_at DESC
    LIMIT p_limit OFFSET p_offset
  ),
  -- spy_messages から unique chatters + tip count を取得
  spy_agg AS (
    SELECT
      sm.session_id AS sid,
      COUNT(DISTINCT sm.user_name)::INTEGER AS unique_chatters,
      COUNT(*) FILTER (WHERE sm.tokens > 0)::INTEGER AS tip_count
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = p_cast_name
      AND sm.session_id IN (SELECT ss.session_id FROM sess ss)
    GROUP BY sm.session_id
  ),
  -- coin_transactions から売上を取得
  coin_agg AS (
    SELECT
      ss.session_id AS sid,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS coin_revenue
    FROM sess ss
    LEFT JOIN public.coin_transactions ct
      ON ct.account_id = p_account_id
      AND ct.cast_name = p_cast_name
      AND ct.tokens > 0
      AND ct.date >= ss.started_at
      AND ct.date < COALESCE(ss.ended_at, ss.started_at + INTERVAL '12 hours')
    GROUP BY ss.session_id
  )
  SELECT
    ss.session_id,
    ss.title,
    ss.cast_name,
    ss.started_at,
    ss.ended_at,
    ss.duration_minutes,
    ss.total_messages,
    ss.total_tokens,
    ss.peak_viewers,
    COALESCE(sa.unique_chatters, 0) AS unique_chatters,
    COALESCE(sa.tip_count, 0) AS tip_count,
    COALESCE(ca.coin_revenue, 0) AS coin_revenue,
    ss.is_active,
    v_total AS total_count
  FROM sess ss
  LEFT JOIN spy_agg sa ON sa.sid = ss.session_id
  LEFT JOIN coin_agg ca ON ca.sid = ss.session_id
  ORDER BY ss.started_at DESC;
END;
$$;

-- ============================================================
-- 2. get_session_summary: 個別セッションの詳細サマリー
--    チャットログ統計 + 売上内訳 + トップユーザー + 前回比較
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_session_summary(
  p_account_id UUID,
  p_session_id TEXT
)
RETURNS TABLE (
  session_id TEXT,
  title TEXT,
  cast_name TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  -- チャット統計
  total_messages INTEGER,
  total_tips INTEGER,
  spy_tokens BIGINT,
  unique_chatters INTEGER,
  peak_viewers INTEGER,
  -- coin_transactions ベース売上
  coin_revenue BIGINT,
  revenue_by_type JSONB,
  -- ユーザー分析
  new_users INTEGER,
  returning_users INTEGER,
  -- トップ5
  top_users JSONB,
  -- 前回比較
  prev_session_id TEXT,
  prev_session_date DATE,
  prev_coin_revenue BIGINT,
  change_pct NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session RECORD;
  v_prev RECORD;
  v_effective_end TIMESTAMPTZ;
BEGIN
  -- ターゲットセッション取得
  SELECT s.* INTO v_session
  FROM public.sessions s
  WHERE s.account_id = p_account_id
    AND s.session_id = p_session_id;

  IF v_session IS NULL THEN
    RETURN;
  END IF;

  v_effective_end := COALESCE(v_session.ended_at, v_session.started_at + INTERVAL '12 hours');

  -- 前回セッション取得
  SELECT s.* INTO v_prev
  FROM public.sessions s
  WHERE s.account_id = p_account_id
    AND COALESCE(s.cast_name, s.title) = COALESCE(v_session.cast_name, v_session.title)
    AND s.started_at < v_session.started_at
  ORDER BY s.started_at DESC
  LIMIT 1;

  RETURN QUERY
  WITH
  -- spy_messages 集計
  spy_agg AS (
    SELECT
      COUNT(*)::INTEGER AS msg_count,
      COUNT(*) FILTER (WHERE sm.tokens > 0)::INTEGER AS tip_count,
      COALESCE(SUM(sm.tokens), 0)::BIGINT AS spy_tk,
      COUNT(DISTINCT sm.user_name)::INTEGER AS chatters
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = p_session_id
  ),
  -- coin_transactions 集計
  session_tx AS (
    SELECT ct.*
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name = COALESCE(v_session.cast_name, v_session.title)
      AND ct.date >= v_session.started_at
      AND ct.date < v_effective_end
      AND ct.tokens > 0
  ),
  type_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(t.type, t.sum_tokens),
      '{}'::JSONB
    ) AS rev
    FROM (
      SELECT st.type, SUM(st.tokens) AS sum_tokens
      FROM session_tx st
      GROUP BY st.type
    ) t
  ),
  -- ユーザー分析
  user_agg AS (
    SELECT
      st.user_name,
      SUM(st.tokens)::BIGINT AS user_tokens,
      ARRAY_AGG(DISTINCT st.type) AS user_types,
      EXISTS (
        SELECT 1 FROM public.coin_transactions older
        WHERE older.account_id = p_account_id
          AND older.cast_name = COALESCE(v_session.cast_name, v_session.title)
          AND older.user_name = st.user_name
          AND older.date < v_session.started_at
          AND older.tokens > 0
      ) AS has_prior
    FROM session_tx st
    GROUP BY st.user_name
  ),
  user_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE NOT ua.has_prior)::INTEGER AS new_u,
      COUNT(*) FILTER (WHERE ua.has_prior)::INTEGER AS ret_u
    FROM user_agg ua
  ),
  top5 AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'user_name', ua.user_name,
          'tokens', ua.user_tokens,
          'types', ua.user_types,
          'is_new', NOT ua.has_prior
        ) ORDER BY ua.user_tokens DESC
      ),
      '[]'::JSONB
    ) AS top_list
    FROM (SELECT * FROM user_agg ORDER BY user_tokens DESC LIMIT 5) ua
  ),
  -- 前回セッション売上
  prev_revenue AS (
    SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT AS prev_tokens
    FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name = COALESCE(v_session.cast_name, v_session.title)
      AND v_prev.started_at IS NOT NULL
      AND ct.date >= v_prev.started_at
      AND ct.date < COALESCE(v_prev.ended_at, v_prev.started_at + INTERVAL '12 hours')
      AND ct.tokens > 0
  )
  SELECT
    v_session.session_id,
    COALESCE(v_session.title, v_session.cast_name),
    COALESCE(v_session.cast_name, v_session.title),
    v_session.started_at,
    v_effective_end,
    EXTRACT(EPOCH FROM (v_effective_end - v_session.started_at))::INTEGER / 60,
    sa.msg_count,
    sa.tip_count,
    sa.spy_tk,
    sa.chatters,
    COALESCE(v_session.peak_viewers, 0),
    COALESCE((SELECT SUM(st.tokens) FROM session_tx st), 0)::BIGINT,
    ta.rev,
    us.new_u,
    us.ret_u,
    t5.top_list,
    v_prev.session_id,
    v_prev.started_at::date,
    pr.prev_tokens,
    CASE
      WHEN pr.prev_tokens > 0 THEN
        ROUND(((SELECT SUM(st.tokens) FROM session_tx st)::NUMERIC - pr.prev_tokens) / pr.prev_tokens * 100, 1)
      ELSE NULL
    END
  FROM spy_agg sa
  CROSS JOIN type_agg ta
  CROSS JOIN user_stats us
  CROSS JOIN top5 t5
  CROSS JOIN prev_revenue pr;
END;
$$;

-- ============================================================
-- 使用例:
-- SELECT * FROM get_session_list('account-uuid', 'airi_love22', 20, 0);
-- SELECT * FROM get_session_summary('account-uuid', 'session-id-here');
-- ============================================================
