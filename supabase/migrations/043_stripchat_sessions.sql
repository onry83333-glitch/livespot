-- Migration 043: stripchat_sessions テーブル + dm_send_log.sent_via
-- DM送信サーバーサイドAPI化に必要なセッション管理

CREATE TABLE IF NOT EXISTS public.stripchat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    session_cookie TEXT NOT NULL,
    csrf_token TEXT,
    csrf_timestamp TEXT,
    stripchat_user_id TEXT,
    front_version TEXT DEFAULT '11.5.57',
    cookies_json JSONB DEFAULT '{}',
    is_valid BOOLEAN DEFAULT true,
    last_validated_at TIMESTAMPTZ DEFAULT NOW(),
    exported_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id)
);

CREATE INDEX IF NOT EXISTS idx_stripchat_sessions_active
    ON public.stripchat_sessions(account_id, is_valid);

ALTER TABLE public.stripchat_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stripchat_sessions_all" ON public.stripchat_sessions
    FOR ALL USING (account_id IN (SELECT user_account_ids()));

COMMENT ON TABLE public.stripchat_sessions IS 'Stripchatセッション管理（DM API送信用）';

-- dm_send_log に sent_via カラム追加
ALTER TABLE public.dm_send_log ADD COLUMN IF NOT EXISTS sent_via TEXT DEFAULT 'extension';
COMMENT ON COLUMN public.dm_send_log.sent_via IS 'DM送信方法: api or extension';
