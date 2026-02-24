-- ============================================================
-- 062: spy_user_profiles RPC — 1回コピペ実行用
-- Supabase SQL Editorで「No limit」を選択して実行すること
-- ============================================================

-- 旧シグネチャDROP
DROP FUNCTION IF EXISTS public.refresh_spy_user_profiles(UUID);
DROP FUNCTION IF EXISTS public.refresh_spy_user_profiles(UUID, INTEGER);
DROP FUNCTION IF EXISTS public.get_user_overlap_matrix(UUID, TEXT);
DROP FUNCTION IF EXISTS public.get_spy_top_users(UUID, INTEGER);

-- ─── 1. refresh_spy_user_profiles(UUID, INTEGER) ───
CREATE FUNCTION public.refresh_spy_user_profiles(
  p_account_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
DECLARE
  v_upserted INTEGER := 0;
  v_since TIMESTAMPTZ;
BEGIN
  v_since := NOW() - (p_days * INTERVAL '1 day');

  WITH agg AS (
    SELECT
      sm.account_id,
      sm.user_name,
      sm.cast_name,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS total_tokens,
      COUNT(*)::INTEGER AS message_count,
      MIN(sm.message_time) AS first_seen,
      MAX(sm.message_time) AS last_seen
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.message_time >= v_since
      AND sm.user_name IS NOT NULL
      AND sm.user_name <> ''
      AND sm.msg_type NOT IN ('viewer_count', 'system')
    GROUP BY sm.account_id, sm.user_name, sm.cast_name
  )
  INSERT INTO public.spy_user_profiles
    (account_id, user_name, cast_name, total_tokens, message_count, first_seen, last_seen, is_registered_cast, updated_at)
  SELECT
    a.account_id,
    a.user_name,
    a.cast_name,
    a.total_tokens,
    a.message_count,
    a.first_seen,
    a.last_seen,
    EXISTS (
      SELECT 1 FROM public.registered_casts rc
      WHERE rc.account_id = a.account_id AND rc.cast_name = a.cast_name
    ),
    NOW()
  FROM agg a
  ON CONFLICT (account_id, user_name, cast_name)
  DO UPDATE SET
    total_tokens = EXCLUDED.total_tokens,
    message_count = EXCLUDED.message_count,
    first_seen = LEAST(spy_user_profiles.first_seen, EXCLUDED.first_seen),
    last_seen = GREATEST(spy_user_profiles.last_seen, EXCLUDED.last_seen),
    is_registered_cast = EXCLUDED.is_registered_cast,
    updated_at = NOW();

  GET DIAGNOSTICS v_upserted = ROW_COUNT;
  RETURN v_upserted;
END;
$body$;

-- ─── 2. get_user_overlap_matrix(UUID, TEXT) ───
CREATE FUNCTION public.get_user_overlap_matrix(
  p_account_id UUID,
  p_segment TEXT DEFAULT NULL
)
RETURNS TABLE (
  own_cast TEXT,
  spy_cast TEXT,
  overlap_users INTEGER,
  overlap_tokens BIGINT,
  own_total_users INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
BEGIN
  RETURN QUERY
  WITH
  own_users AS (
    SELECT sup.cast_name AS own_cast, sup.user_name
    FROM public.spy_user_profiles sup
    WHERE sup.account_id = p_account_id
      AND sup.is_registered_cast = true
      AND (p_segment IS NULL OR EXISTS (
        SELECT 1 FROM public.paid_users pu
        WHERE pu.account_id = p_account_id AND pu.user_name = sup.user_name AND pu.segment = p_segment
      ))
  ),
  own_totals AS (
    SELECT ou.own_cast, COUNT(DISTINCT ou.user_name)::INTEGER AS total_users
    FROM own_users ou GROUP BY ou.own_cast
  ),
  overlap AS (
    SELECT
      ou.own_cast,
      sup.cast_name AS spy_cast,
      COUNT(DISTINCT ou.user_name)::INTEGER AS overlap_users,
      COALESCE(SUM(sup.total_tokens), 0)::BIGINT AS overlap_tokens
    FROM own_users ou
    INNER JOIN public.spy_user_profiles sup
      ON sup.account_id = p_account_id AND sup.user_name = ou.user_name AND sup.is_registered_cast = false
    GROUP BY ou.own_cast, sup.cast_name
  )
  SELECT o.own_cast, o.spy_cast, o.overlap_users, o.overlap_tokens, COALESCE(ot.total_users, 0) AS own_total_users
  FROM overlap o
  LEFT JOIN own_totals ot ON ot.own_cast = o.own_cast
  ORDER BY o.overlap_users DESC;
END;
$body$;

-- ─── 3. get_spy_top_users(UUID, INTEGER) ───
CREATE FUNCTION public.get_spy_top_users(
  p_account_id UUID,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  user_name TEXT,
  spy_casts TEXT[],
  spy_total_tokens BIGINT,
  own_total_coins INTEGER,
  own_segment TEXT,
  cast_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
BEGIN
  RETURN QUERY
  WITH spy_agg AS (
    SELECT
      sup.user_name,
      ARRAY_AGG(DISTINCT sup.cast_name ORDER BY sup.cast_name) AS spy_casts,
      SUM(sup.total_tokens)::BIGINT AS spy_total_tokens,
      COUNT(DISTINCT sup.cast_name)::INTEGER AS cast_count
    FROM public.spy_user_profiles sup
    WHERE sup.account_id = p_account_id AND sup.is_registered_cast = false AND sup.total_tokens > 0
    GROUP BY sup.user_name
  )
  SELECT
    sa.user_name, sa.spy_casts, sa.spy_total_tokens,
    COALESCE(pu.total_coins, 0)::INTEGER AS own_total_coins,
    pu.segment AS own_segment,
    sa.cast_count
  FROM spy_agg sa
  LEFT JOIN public.paid_users pu ON pu.account_id = p_account_id AND pu.user_name = sa.user_name
  ORDER BY sa.spy_total_tokens DESC
  LIMIT p_limit;
END;
$body$;

-- ─── 検証: 3関数が存在するか ───
SELECT proname, pronargs
FROM pg_proc
WHERE proname IN ('refresh_spy_user_profiles', 'get_user_overlap_matrix', 'get_spy_top_users')
  AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
