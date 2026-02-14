-- Morning Hook SaaS - Initial Schema
-- Migration 001: Core tables + RLS

-- ============================================================
-- 1. PROFILES (extends Supabase Auth)
-- ============================================================
CREATE TABLE public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'light', 'standard', 'pro', 'enterprise')),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    max_casts INTEGER DEFAULT 1,
    max_dm_per_month INTEGER DEFAULT 10,
    max_ai_per_month INTEGER DEFAULT 0,
    dm_used_this_month INTEGER DEFAULT 0,
    ai_used_this_month INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, display_name)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 2. ACCOUNTS (Stripchat accounts)
-- ============================================================
CREATE TABLE public.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_name TEXT NOT NULL,
    stripchat_cookie_encrypted TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, account_name)
);

CREATE INDEX idx_accounts_user ON public.accounts(user_id);

-- ============================================================
-- 3. PAID_USERS (per-user cumulative)
-- ============================================================
CREATE TABLE public.paid_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL,
    total_coins INTEGER DEFAULT 0,
    last_payment_date TIMESTAMPTZ,
    user_id_stripchat TEXT,
    profile_url TEXT,
    user_level INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(account_id, user_name)
);

CREATE INDEX idx_paid_users_account ON public.paid_users(account_id);
CREATE INDEX idx_paid_users_tokens ON public.paid_users(account_id, total_coins DESC);

-- ============================================================
-- 4. COIN_TRANSACTIONS (individual transactions)
-- ============================================================
CREATE TABLE public.coin_transactions (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    type TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    source_detail TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_coin_tx_account_date ON public.coin_transactions(account_id, date DESC);
CREATE INDEX idx_coin_tx_user ON public.coin_transactions(account_id, user_name);
CREATE INDEX idx_coin_tx_type ON public.coin_transactions(account_id, type);

-- ============================================================
-- 5. PAYING_USERS (materialized view for fast aggregation)
-- ============================================================
CREATE MATERIALIZED VIEW public.paying_users AS
SELECT
    account_id,
    user_name,
    SUM(tokens) AS total_tokens,
    MAX(date) AS last_paid,
    MIN(date) AS first_paid,
    COUNT(*) AS tx_count
FROM public.coin_transactions
GROUP BY account_id, user_name;

CREATE UNIQUE INDEX idx_paying_users ON public.paying_users(account_id, user_name);

-- ============================================================
-- 6. DM_SEND_LOG
-- ============================================================
CREATE TABLE public.dm_send_log (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    user_name TEXT NOT NULL,
    profile_url TEXT,
    message TEXT,
    image_sent BOOLEAN DEFAULT false,
    status TEXT DEFAULT 'queued' CHECK (status IN ('success', 'error', 'pending', 'queued', 'sending')),
    error TEXT,
    sent_at TIMESTAMPTZ,
    queued_at TIMESTAMPTZ DEFAULT NOW(),
    campaign TEXT DEFAULT '',
    template_name TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_dm_log_account ON public.dm_send_log(account_id, queued_at DESC);
CREATE INDEX idx_dm_log_status ON public.dm_send_log(account_id, status);
CREATE INDEX idx_dm_log_campaign ON public.dm_send_log(account_id, campaign);
CREATE INDEX idx_dm_log_user ON public.dm_send_log(account_id, user_name);

-- ============================================================
-- 7. DM_TEMPLATES
-- ============================================================
CREATE TABLE public.dm_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    message TEXT NOT NULL,
    image_url TEXT,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 8. SPY_MESSAGES (chat logs)
-- ============================================================
CREATE TABLE public.spy_messages (
    id BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT NOT NULL,
    message_time TIMESTAMPTZ NOT NULL,
    msg_type TEXT NOT NULL,
    user_name TEXT,
    message TEXT,
    tokens INTEGER DEFAULT 0,
    is_vip BOOLEAN DEFAULT false,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spy_account_cast ON public.spy_messages(account_id, cast_name, message_time DESC);
CREATE INDEX idx_spy_vip ON public.spy_messages(account_id, is_vip) WHERE is_vip = true;
CREATE INDEX idx_spy_gifts ON public.spy_messages(account_id, msg_type) WHERE msg_type IN ('gift', 'tip');
CREATE INDEX idx_spy_time ON public.spy_messages(message_time DESC);

-- ============================================================
-- 9. BROADCAST_SCRIPTS
-- ============================================================
CREATE TABLE public.broadcast_scripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT,
    title TEXT NOT NULL,
    duration_minutes INTEGER DEFAULT 120,
    steps JSONB NOT NULL DEFAULT '[]',
    vip_rules JSONB NOT NULL DEFAULT '[]',
    notes TEXT DEFAULT '',
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 10. AI_REPORTS
-- ============================================================
CREATE TABLE public.ai_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT,
    report_type TEXT NOT NULL,
    input_summary TEXT,
    output_text TEXT NOT NULL,
    model TEXT DEFAULT 'claude-sonnet',
    tokens_used INTEGER DEFAULT 0,
    cost_usd NUMERIC(10,6) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_reports_account ON public.ai_reports(account_id, created_at DESC);

-- ============================================================
-- 11. AUDIO_RECORDINGS
-- ============================================================
CREATE TABLE public.audio_recordings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT NOT NULL,
    recording_date DATE NOT NULL,
    file_path TEXT NOT NULL,
    duration_seconds INTEGER,
    transcript TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 12. ROW LEVEL SECURITY
-- ============================================================

-- Helper function: get all account_ids for current user
CREATE OR REPLACE FUNCTION public.user_account_ids()
RETURNS SETOF UUID AS $$
    SELECT id FROM public.accounts WHERE user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Profiles: own only
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Accounts: own only
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "accounts_all" ON public.accounts FOR ALL USING (auth.uid() = user_id);

-- All account-scoped tables: macro for RLS
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'paid_users', 'coin_transactions', 'dm_send_log', 'dm_templates',
        'spy_messages', 'broadcast_scripts', 'ai_reports', 'audio_recordings'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY "%s_all" ON public.%I FOR ALL USING (account_id IN (SELECT public.user_account_ids()))',
            tbl, tbl
        );
    END LOOP;
END $$;

-- ============================================================
-- 13. REALTIME (enable for spy_messages and dm_send_log)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.spy_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_send_log;

-- ============================================================
-- 14. HELPER FUNCTIONS
-- ============================================================

-- Refresh paying_users materialized view
CREATE OR REPLACE FUNCTION public.refresh_paying_users()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.paying_users;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Monthly usage reset (call via pg_cron or edge function)
CREATE OR REPLACE FUNCTION public.reset_monthly_usage()
RETURNS void AS $$
BEGIN
    UPDATE public.profiles SET dm_used_this_month = 0, ai_used_this_month = 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
