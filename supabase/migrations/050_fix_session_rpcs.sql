-- ============================================================
-- 050: get_session_list / get_session_summary 書き直し
-- 根本原因: 049は sessions テーブルを参照していたが、
-- セッションデータは spy_messages.session_id の GROUP BY で導出する。
-- spy_sessions テーブルは存在しない。
-- ============================================================

-- 旧RPC削除
DROP FUNCTION IF EXISTS public.get_session_list(UUID, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.get_session_summary(UUID, TEXT);

-- ============================================================
-- 1. get_session_list: spy_messages から session_id GROUP BY で導出
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_session_list(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  session_id UUID,
  cast_name TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC,
  msg_count BIGINT,
  unique_users BIGINT,
  total_tokens BIGINT,
  tip_count BIGINT,
  is_active BOOLEAN,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total BIGINT;
BEGIN
  -- 全セッション数をカウント
  SELECT COUNT(DISTINCT sm.session_id) INTO v_total
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.cast_name = p_cast_name
    AND sm.session_id IS NOT NULL;

  RETURN QUERY
  SELECT
    sm.session_id,
    sm.cast_name,
    MAX(sm.session_title) AS session_title,
    MIN(sm.message_time) AS started_at,
    MAX(sm.message_time) AS ended_at,
    ROUND(EXTRACT(EPOCH FROM (MAX(sm.message_time) - MIN(sm.message_time))) / 60, 1) AS duration_minutes,
    COUNT(*) AS msg_count,
    COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.user_name IS NOT NULL AND sm.user_name != '') AS unique_users,
    COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS total_tokens,
    COUNT(*) FILTER (WHERE sm.tokens > 0) AS tip_count,
    (MAX(sm.message_time) > NOW() - INTERVAL '10 minutes') AS is_active,
    v_total AS total_count
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.cast_name = p_cast_name
    AND sm.session_id IS NOT NULL
  GROUP BY sm.session_id, sm.cast_name
  ORDER BY MIN(sm.message_time) DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- ============================================================
-- 2. get_session_summary: 個別セッション詳細 (spy_messages から導出)
--    基本統計 + msg_type別内訳 + トップ5ユーザー + 前回比較
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_session_summary(
  p_account_id UUID,
  p_session_id UUID
)
RETURNS TABLE (
  session_id UUID,
  cast_name TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC,
  msg_count BIGINT,
  unique_users BIGINT,
  total_tokens BIGINT,
  tip_count BIGINT,
  -- msg_type 別内訳
  tokens_by_type JSONB,
  -- トップ5ユーザー
  top_users JSONB,
  -- 前回セッション比較
  prev_session_id UUID,
  prev_total_tokens BIGINT,
  prev_started_at TIMESTAMPTZ,
  change_pct NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cast TEXT;
  v_started TIMESTAMPTZ;
  v_tokens BIGINT;
  v_prev_sid UUID;
  v_prev_tokens BIGINT;
  v_prev_start TIMESTAMPTZ;
BEGIN
  -- セッションのcast_nameと開始時刻を特定
  SELECT sm.cast_name, MIN(sm.message_time), COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT
  INTO v_cast, v_started, v_tokens
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.session_id = p_session_id
  GROUP BY sm.cast_name
  LIMIT 1;

  IF v_cast IS NULL THEN
    RETURN;  -- セッションが見つからない
  END IF;

  -- 前回セッションを特定（同じキャストで直前のsession）
  SELECT sq.sid, sq.tk, sq.sa
  INTO v_prev_sid, v_prev_tokens, v_prev_start
  FROM (
    SELECT
      sm2.session_id AS sid,
      COALESCE(SUM(sm2.tokens) FILTER (WHERE sm2.tokens > 0), 0)::BIGINT AS tk,
      MIN(sm2.message_time) AS sa
    FROM public.spy_messages sm2
    WHERE sm2.account_id = p_account_id
      AND sm2.cast_name = v_cast
      AND sm2.session_id IS NOT NULL
      AND sm2.session_id != p_session_id
    GROUP BY sm2.session_id
    HAVING MIN(sm2.message_time) < v_started
    ORDER BY MIN(sm2.message_time) DESC
    LIMIT 1
  ) sq;

  RETURN QUERY
  WITH
  -- 基本統計
  base AS (
    SELECT
      sm.session_id,
      sm.cast_name,
      MAX(sm.session_title) AS session_title,
      MIN(sm.message_time) AS started_at,
      MAX(sm.message_time) AS ended_at,
      ROUND(EXTRACT(EPOCH FROM (MAX(sm.message_time) - MIN(sm.message_time))) / 60, 1) AS duration_minutes,
      COUNT(*) AS msg_count,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.user_name IS NOT NULL AND sm.user_name != '') AS unique_users,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS total_tokens,
      COUNT(*) FILTER (WHERE sm.tokens > 0) AS tip_count
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = p_session_id
    GROUP BY sm.session_id, sm.cast_name
  ),
  -- msg_type別 tokens内訳
  type_breakdown AS (
    SELECT COALESCE(
      jsonb_object_agg(t.msg_type, t.type_tokens),
      '{}'::JSONB
    ) AS tbt
    FROM (
      SELECT sm.msg_type, SUM(sm.tokens) AS type_tokens
      FROM public.spy_messages sm
      WHERE sm.account_id = p_account_id
        AND sm.session_id = p_session_id
        AND sm.tokens > 0
      GROUP BY sm.msg_type
    ) t
  ),
  -- トップ5ユーザー（課金額順）
  top5 AS (
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
        SUM(sm.tokens) AS user_tokens,
        COUNT(*) AS user_tips
      FROM public.spy_messages sm
      WHERE sm.account_id = p_account_id
        AND sm.session_id = p_session_id
        AND sm.tokens > 0
        AND sm.user_name IS NOT NULL
        AND sm.user_name != ''
      GROUP BY sm.user_name
      ORDER BY SUM(sm.tokens) DESC
      LIMIT 5
    ) u
  )
  SELECT
    b.session_id,
    b.cast_name,
    b.session_title,
    b.started_at,
    b.ended_at,
    b.duration_minutes,
    b.msg_count,
    b.unique_users,
    b.total_tokens,
    b.tip_count,
    tb.tbt AS tokens_by_type,
    t5.top_list AS top_users,
    v_prev_sid AS prev_session_id,
    v_prev_tokens AS prev_total_tokens,
    v_prev_start AS prev_started_at,
    CASE
      WHEN v_prev_tokens IS NOT NULL AND v_prev_tokens > 0 THEN
        ROUND((b.total_tokens::NUMERIC - v_prev_tokens) / v_prev_tokens * 100, 1)
      ELSE NULL
    END AS change_pct
  FROM base b
  CROSS JOIN type_breakdown tb
  CROSS JOIN top5 t5;
END;
$$;

-- ============================================================
-- 使用例:
-- SELECT * FROM get_session_list('account-uuid', 'Risa_06', 20, 0);
-- SELECT * FROM get_session_summary('account-uuid', 'a1707a8a-baae-4f13-9768-107f56c43aaf');
-- ============================================================
