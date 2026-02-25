-- ============================================================
-- 061: spy_user_profiles — ユーザー重複分析基盤
-- spy_messages からユーザー × キャスト別プロフィールを蓄積し、
-- 自社 vs 他社のユーザー重複マトリクスを可視化する
-- ============================================================

-- ─── 1. テーブル作成 ───
CREATE TABLE IF NOT EXISTS public.spy_user_profiles (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  cast_name TEXT NOT NULL,
  total_tokens BIGINT DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  is_registered_cast BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, user_name, cast_name)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_spy_user_profiles_account_cast
  ON public.spy_user_profiles(account_id, cast_name);
CREATE INDEX IF NOT EXISTS idx_spy_user_profiles_account_user
  ON public.spy_user_profiles(account_id, user_name);

-- RLS
ALTER TABLE public.spy_user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "spy_user_profiles_select" ON public.spy_user_profiles
  FOR SELECT USING (account_id IN (SELECT public.user_account_ids()));

CREATE POLICY "spy_user_profiles_insert" ON public.spy_user_profiles
  FOR INSERT WITH CHECK (account_id IN (SELECT public.user_account_ids()));

CREATE POLICY "spy_user_profiles_update" ON public.spy_user_profiles
  FOR UPDATE USING (account_id IN (SELECT public.user_account_ids()));

CREATE POLICY "spy_user_profiles_delete" ON public.spy_user_profiles
  FOR DELETE USING (account_id IN (SELECT public.user_account_ids()));

-- updated_at トリガー
CREATE OR REPLACE FUNCTION public.update_spy_profile_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_spy_user_profiles_updated_at
  BEFORE UPDATE ON public.spy_user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_spy_profile_timestamp();

COMMENT ON TABLE public.spy_user_profiles
  IS 'spy_messages集計: ユーザー×キャスト別のトークン・メッセージ数・初回/最終出現';


-- ─── 2. refresh_spy_user_profiles RPC ───
-- spy_messages → spy_user_profiles へ集計UPSERT
DROP FUNCTION IF EXISTS public.refresh_spy_user_profiles(UUID);

CREATE OR REPLACE FUNCTION public.refresh_spy_user_profiles(
  p_account_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_upserted INTEGER := 0;
BEGIN
  -- spy_messages からユーザー×キャスト別に集計してUPSERT
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
      AND sm.user_name IS NOT NULL
      AND sm.user_name != ''
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
$$;

COMMENT ON FUNCTION public.refresh_spy_user_profiles(UUID)
  IS 'spy_messages → spy_user_profiles 集計UPSERT（全キャスト一括）';


-- ─── 3. get_user_overlap_matrix RPC ───
-- 自社キャスト × 他社キャスト のユーザー重複マトリクス
DROP FUNCTION IF EXISTS public.get_user_overlap_matrix(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.get_user_overlap_matrix(
  p_account_id UUID,
  p_segment TEXT DEFAULT NULL  -- paid_users.segment でフィルタ（NULL=全セグメント）
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
AS $$
BEGIN
  RETURN QUERY
  WITH
  -- 自社キャストに出現しているユーザー一覧
  own_users AS (
    SELECT
      sup.cast_name AS own_cast,
      sup.user_name
    FROM public.spy_user_profiles sup
    WHERE sup.account_id = p_account_id
      AND sup.is_registered_cast = true
      -- セグメントフィルタ（paid_usersとJOIN）
      AND (p_segment IS NULL OR EXISTS (
        SELECT 1 FROM public.paid_users pu
        WHERE pu.account_id = p_account_id
          AND pu.user_name = sup.user_name
          AND pu.segment = p_segment
      ))
  ),
  -- 自社キャスト別の総ユーザー数
  own_totals AS (
    SELECT
      ou.own_cast,
      COUNT(DISTINCT ou.user_name)::INTEGER AS total_users
    FROM own_users ou
    GROUP BY ou.own_cast
  ),
  -- 他社キャストに出現している同名ユーザーとの突合
  overlap AS (
    SELECT
      ou.own_cast,
      sup.cast_name AS spy_cast,
      COUNT(DISTINCT ou.user_name)::INTEGER AS overlap_users,
      COALESCE(SUM(sup.total_tokens), 0)::BIGINT AS overlap_tokens
    FROM own_users ou
    INNER JOIN public.spy_user_profiles sup
      ON sup.account_id = p_account_id
      AND sup.user_name = ou.user_name
      AND sup.is_registered_cast = false
    GROUP BY ou.own_cast, sup.cast_name
  )
  SELECT
    o.own_cast,
    o.spy_cast,
    o.overlap_users,
    o.overlap_tokens,
    COALESCE(ot.total_users, 0) AS own_total_users
  FROM overlap o
  LEFT JOIN own_totals ot ON ot.own_cast = o.own_cast
  ORDER BY o.overlap_users DESC;
END;
$$;

COMMENT ON FUNCTION public.get_user_overlap_matrix(UUID, TEXT)
  IS '自社×他社キャストのユーザー重複マトリクス（セグメントフィルタ対応）';


-- ─── 4. get_spy_top_users RPC ───
-- 他社キャストで高額課金しているユーザーのランキング
DROP FUNCTION IF EXISTS public.get_spy_top_users(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_top_users(
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
AS $$
BEGIN
  RETURN QUERY
  WITH spy_agg AS (
    SELECT
      sup.user_name,
      ARRAY_AGG(DISTINCT sup.cast_name ORDER BY sup.cast_name) AS spy_casts,
      SUM(sup.total_tokens)::BIGINT AS spy_total_tokens,
      COUNT(DISTINCT sup.cast_name)::INTEGER AS cast_count
    FROM public.spy_user_profiles sup
    WHERE sup.account_id = p_account_id
      AND sup.is_registered_cast = false
      AND sup.total_tokens > 0
    GROUP BY sup.user_name
  )
  SELECT
    sa.user_name,
    sa.spy_casts,
    sa.spy_total_tokens,
    COALESCE(pu.total_coins, 0)::INTEGER AS own_total_coins,
    pu.segment AS own_segment,
    sa.cast_count
  FROM spy_agg sa
  LEFT JOIN public.paid_users pu
    ON pu.account_id = p_account_id
    AND pu.user_name = sa.user_name
  ORDER BY sa.spy_total_tokens DESC
  LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_spy_top_users(UUID, INTEGER)
  IS '他社キャスト高額課金ユーザーランキング（自社データJOIN付き）';
