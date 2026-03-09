-- ============================================================
-- 110: get_session_revenue_breakdown 時間範囲バッファ追加
--
-- 問題: セッション境界ぴったりでcoin_transactionsを突合するため、
--       セッション開始前/終了後数分のトランザクションが漏れる
-- 修正: ±5分のバッファを追加（get_session_list_v2 と統一）
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.get_session_revenue_breakdown(UUID, TEXT, DATE);
--   -- Then re-apply 048_get_session_revenue_breakdown.sql
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
