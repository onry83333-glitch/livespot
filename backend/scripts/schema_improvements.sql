-- ============================================================
-- Phase 2: セッション管理・キャスト除外・コイン換算
-- 実行: Supabase Dashboard > SQL Editor で実行
-- ============================================================

-- (A) spy_messagesにsession管理カラム追加
ALTER TABLE public.spy_messages ADD COLUMN IF NOT EXISTS session_id UUID;
ALTER TABLE public.spy_messages ADD COLUMN IF NOT EXISTS session_title TEXT;

-- (B) sessionsテーブル新設
CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  session_id UUID NOT NULL UNIQUE,
  title TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  total_messages INT DEFAULT 0,
  total_tips INT DEFAULT 0,
  total_coins NUMERIC DEFAULT 0,
  unique_users INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON public.sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON public.sessions(account_id, started_at DESC);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sessions_policy" ON public.sessions FOR ALL
  USING (account_id IN (SELECT id FROM public.accounts WHERE user_id = auth.uid()));

-- (C) accountsにキャスト除外・換算設定追加
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS cast_usernames TEXT[] DEFAULT '{}';
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS coin_rate NUMERIC DEFAULT 7.7;

-- (D) キャスト除外用の共通関数
CREATE OR REPLACE FUNCTION public.is_cast_user(p_account_id UUID, p_user_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT p_user_name = ANY(COALESCE(
    (SELECT cast_usernames FROM public.accounts WHERE id = p_account_id),
    '{}'::TEXT[]
  ));
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- (E) spy_messagesにuser_levelカラム追加
ALTER TABLE public.spy_messages ADD COLUMN IF NOT EXISTS user_level INT;

-- (F) spy_messagesのsession_idインデックス
CREATE INDEX IF NOT EXISTS idx_spy_messages_session ON public.spy_messages(session_id);

-- (G) セッション集計を更新するRPC
CREATE OR REPLACE FUNCTION public.update_session_stats(p_session_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE public.sessions SET
    total_messages = (SELECT COUNT(*) FROM public.spy_messages WHERE session_id = p_session_id),
    total_tips = (SELECT COUNT(*) FROM public.spy_messages WHERE session_id = p_session_id AND msg_type IN ('tip', 'gift')),
    total_coins = (SELECT COALESCE(SUM(tokens), 0) FROM public.spy_messages WHERE session_id = p_session_id AND tokens > 0),
    unique_users = (SELECT COUNT(DISTINCT user_name) FROM public.spy_messages WHERE session_id = p_session_id AND user_name IS NOT NULL)
  WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
