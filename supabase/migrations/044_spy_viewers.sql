-- Migration 044: spy_viewers テーブル + stripchat_sessions.jwt_token + get_dm_funnel RPC
-- 視聴者個人の入退室・リーグ/レベル情報を記録 + DM→来訪→課金ファネル分析

-- ============================================================
-- 1. spy_viewers テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS public.spy_viewers (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT NOT NULL,
    session_id TEXT,
    user_name TEXT NOT NULL,
    user_id_stripchat TEXT,
    league TEXT,
    level INTEGER,
    is_fan_club BOOLEAN DEFAULT false,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    visit_count INTEGER DEFAULT 1,
    UNIQUE(account_id, cast_name, user_name, session_id)
);

CREATE INDEX IF NOT EXISTS idx_spy_viewers_cast ON public.spy_viewers(account_id, cast_name, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_spy_viewers_user ON public.spy_viewers(account_id, user_name);

ALTER TABLE public.spy_viewers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "spy_viewers_all" ON public.spy_viewers
    FOR ALL USING (account_id IN (SELECT user_account_ids()));

COMMENT ON TABLE public.spy_viewers IS '視聴者個人データ（入退室・リーグ/レベル情報）';

-- ============================================================
-- 2. stripchat_sessions に jwt_token カラム追加
-- ============================================================
ALTER TABLE public.stripchat_sessions ADD COLUMN IF NOT EXISTS jwt_token TEXT;
COMMENT ON COLUMN public.stripchat_sessions.jwt_token IS 'Stripchat JWT (viewer member list API用)';

-- ============================================================
-- 3. get_dm_funnel RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_dm_funnel(
    p_account_id UUID,
    p_cast_name TEXT DEFAULT NULL,
    p_since TIMESTAMPTZ DEFAULT NOW() - INTERVAL '30 days'
)
RETURNS TABLE(
    campaign TEXT,
    dm_sent_count BIGINT,
    visited_count BIGINT,
    visit_rate NUMERIC,
    paid_count BIGINT,
    conversion_rate NUMERIC,
    total_tokens BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH dm_users AS (
        SELECT DISTINCT d.campaign, d.user_name
        FROM public.dm_send_log d
        WHERE d.account_id = p_account_id
          AND d.status = 'success'
          AND d.sent_at >= p_since
          AND (p_cast_name IS NULL OR d.cast_name = p_cast_name)
    ),
    visited AS (
        SELECT DISTINCT du.campaign, du.user_name
        FROM dm_users du
        INNER JOIN public.spy_viewers sv ON sv.user_name = du.user_name
          AND sv.account_id = p_account_id
          AND sv.first_seen_at >= p_since
          AND (p_cast_name IS NULL OR sv.cast_name = p_cast_name)
    ),
    paid AS (
        SELECT du.campaign, du.user_name, SUM(ct.tokens) AS tokens
        FROM dm_users du
        INNER JOIN public.coin_transactions ct ON ct.user_name = du.user_name
          AND ct.account_id = p_account_id
          AND ct.transaction_time >= p_since
          AND (p_cast_name IS NULL OR ct.cast_name = p_cast_name)
        GROUP BY du.campaign, du.user_name
    )
    SELECT
        du.campaign,
        COUNT(DISTINCT du.user_name)::BIGINT AS dm_sent_count,
        COUNT(DISTINCT v.user_name)::BIGINT AS visited_count,
        ROUND(COUNT(DISTINCT v.user_name)::NUMERIC * 100.0 / GREATEST(COUNT(DISTINCT du.user_name), 1), 1) AS visit_rate,
        COUNT(DISTINCT p.user_name)::BIGINT AS paid_count,
        ROUND(COUNT(DISTINCT p.user_name)::NUMERIC * 100.0 / GREATEST(COUNT(DISTINCT du.user_name), 1), 1) AS conversion_rate,
        COALESCE(SUM(p.tokens), 0)::BIGINT AS total_tokens
    FROM dm_users du
    LEFT JOIN visited v ON v.campaign = du.campaign AND v.user_name = du.user_name
    LEFT JOIN paid p ON p.campaign = du.campaign AND p.user_name = du.user_name
    GROUP BY du.campaign
    ORDER BY dm_sent_count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.get_dm_funnel IS 'DM→来訪→課金ファネル分析（spy_viewers + coin_transactions結合）';

-- ============================================================
-- 4. Realtime有効化（spy_viewers）
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.spy_viewers;
