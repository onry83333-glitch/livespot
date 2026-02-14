-- Migration 003: Sessions, Viewer Stats, cast_usernames
-- SPY機能で必要なテーブルとカラムを追加

-- ============================================================
-- 1. ACCOUNTS に cast_usernames カラム追加
-- ============================================================
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS cast_usernames JSONB DEFAULT '[]';

COMMENT ON COLUMN public.accounts.cast_usernames IS 'キャスト自身のユーザー名リスト（SPYでキャスト発言を除外するため）';

-- ============================================================
-- 2. SPY_MESSAGES に session_id / session_title カラム追加
-- ============================================================
ALTER TABLE public.spy_messages
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS session_title TEXT;

CREATE INDEX IF NOT EXISTS idx_spy_session ON public.spy_messages(session_id) WHERE session_id IS NOT NULL;

-- ============================================================
-- 3. SESSIONS テーブル（配信セッション管理）
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sessions (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE,
    title TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    total_messages INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    peak_viewers INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON public.sessions(account_id, started_at DESC);

-- セッション統計更新用RPC
CREATE OR REPLACE FUNCTION public.update_session_stats(p_session_id TEXT)
RETURNS void AS $$
BEGIN
    UPDATE public.sessions s SET
        total_messages = sub.msg_count,
        total_tokens = sub.token_sum
    FROM (
        SELECT
            COUNT(*) AS msg_count,
            COALESCE(SUM(tokens), 0) AS token_sum
        FROM public.spy_messages
        WHERE session_id = p_session_id
    ) sub
    WHERE s.session_id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 4. VIEWER_STATS テーブル（視聴者数推移）
-- ============================================================
CREATE TABLE IF NOT EXISTS public.viewer_stats (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT NOT NULL,
    total INTEGER,
    coin_users INTEGER,
    others INTEGER,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_viewer_stats_account ON public.viewer_stats(account_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_viewer_stats_cast ON public.viewer_stats(account_id, cast_name, recorded_at);

-- ============================================================
-- 5. RLS ポリシー
-- ============================================================

-- sessions
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_select ON public.sessions FOR SELECT
    USING (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

CREATE POLICY sessions_insert ON public.sessions FOR INSERT
    WITH CHECK (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

CREATE POLICY sessions_update ON public.sessions FOR UPDATE
    USING (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

-- viewer_stats
ALTER TABLE public.viewer_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY viewer_stats_select ON public.viewer_stats FOR SELECT
    USING (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

CREATE POLICY viewer_stats_insert ON public.viewer_stats FOR INSERT
    WITH CHECK (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

-- ============================================================
-- 6. Realtime 有効化
-- ============================================================
-- viewer_stats はリアルタイム不要（ポーリングベース）
-- sessions は必要に応じて後から有効化
