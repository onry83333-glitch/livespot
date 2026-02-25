-- ============================================================
-- 064: DM Trigger Engine
-- dm_triggers: トリガー定義（条件・テンプレート・クールダウン）
-- dm_trigger_logs: トリガー発火ログ（重複防止・効果測定）
-- ============================================================

-- ============================================================
-- 1. dm_triggers テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dm_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  trigger_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'first_visit',
    'vip_no_tip',
    'churn_risk',
    'segment_upgrade',
    'competitor_outflow',
    'post_session',
    'cross_promotion'
  )),
  cast_name TEXT,
  condition_config JSONB NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL DEFAULT 'direct_dm' CHECK (action_type IN ('direct_dm', 'enroll_scenario')),
  message_template TEXT,
  scenario_id UUID REFERENCES public.dm_scenarios(id) ON DELETE SET NULL,
  target_segments TEXT[] DEFAULT '{}',
  cooldown_hours INTEGER NOT NULL DEFAULT 168,
  daily_limit INTEGER NOT NULL DEFAULT 50,
  enabled BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_triggers_account_enabled
  ON public.dm_triggers(account_id, enabled);
CREATE INDEX IF NOT EXISTS idx_dm_triggers_type
  ON public.dm_triggers(account_id, trigger_type, enabled);

ALTER TABLE public.dm_triggers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'dm_triggers' AND policyname = 'dm_triggers_account_scope'
  ) THEN
    CREATE POLICY dm_triggers_account_scope ON public.dm_triggers
      FOR ALL USING (account_id IN (SELECT public.user_account_ids()));
  END IF;
END $$;

-- updated_at トリガー
CREATE OR REPLACE FUNCTION public.update_dm_trigger_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dm_triggers_updated_at ON public.dm_triggers;
CREATE TRIGGER trg_dm_triggers_updated_at
  BEFORE UPDATE ON public.dm_triggers
  FOR EACH ROW EXECUTE FUNCTION public.update_dm_trigger_timestamp();

-- ============================================================
-- 2. dm_trigger_logs テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS public.dm_trigger_logs (
  id BIGSERIAL PRIMARY KEY,
  trigger_id UUID NOT NULL REFERENCES public.dm_triggers(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  cast_name TEXT NOT NULL,
  user_name TEXT NOT NULL,
  action_taken TEXT NOT NULL CHECK (action_taken IN (
    'dm_queued',
    'scenario_enrolled',
    'skipped_cooldown',
    'skipped_duplicate',
    'skipped_segment',
    'skipped_daily_limit',
    'error'
  )),
  dm_send_log_id BIGINT,
  enrollment_id UUID,
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  fired_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_trigger_logs_trigger
  ON public.dm_trigger_logs(trigger_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_trigger_logs_user_cooldown
  ON public.dm_trigger_logs(trigger_id, user_name, fired_at DESC)
  WHERE action_taken IN ('dm_queued', 'scenario_enrolled');
CREATE INDEX IF NOT EXISTS idx_dm_trigger_logs_account_date
  ON public.dm_trigger_logs(account_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_trigger_logs_daily
  ON public.dm_trigger_logs(trigger_id, fired_at)
  WHERE action_taken IN ('dm_queued', 'scenario_enrolled');

ALTER TABLE public.dm_trigger_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'dm_trigger_logs' AND policyname = 'dm_trigger_logs_account_scope'
  ) THEN
    CREATE POLICY dm_trigger_logs_account_scope ON public.dm_trigger_logs
      FOR ALL USING (account_id IN (SELECT public.user_account_ids()));
  END IF;
END $$;

-- ============================================================
-- 3. dm_send_log に trigger_log_id カラム追加
-- ============================================================
ALTER TABLE public.dm_send_log
ADD COLUMN IF NOT EXISTS trigger_log_id BIGINT REFERENCES public.dm_trigger_logs(id) ON DELETE SET NULL;

-- ============================================================
-- 4. Realtime 有効化
-- ============================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_trigger_logs;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ============================================================
-- 5. デフォルトトリガー7件
-- ============================================================
INSERT INTO public.dm_triggers (
  account_id, trigger_name, trigger_type, cast_name,
  condition_config, action_type, message_template, scenario_id,
  target_segments, cooldown_hours, daily_limit, enabled, priority
)
VALUES
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    '初来訪ウェルカムDM',
    'first_visit',
    NULL,
    '{"source": "viewer_list"}'::JSONB,
    'direct_dm',
    '{username}さん、はじめまして！来てくれてありがとう 楽しんでくれたら嬉しいな また気が向いたら遊びに来てね！',
    NULL,
    ARRAY[]::TEXT[],
    720,
    30,
    true,
    10
  ),
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    'VIPフォローDM',
    'vip_no_tip',
    NULL,
    '{"min_total_tokens": 1000, "check_window_hours": 24}'::JSONB,
    'direct_dm',
    '{username}さん、今日は来てくれてありがとう {username}さんがいてくれるだけで嬉しいです また会えたら嬉しいな！',
    NULL,
    ARRAY['S1','S2','S4','S5']::TEXT[],
    48,
    20,
    true,
    20
  ),
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    '離脱リスクDM',
    'churn_risk',
    NULL,
    '{"absence_days": 14, "min_total_tokens": 300}'::JSONB,
    'direct_dm',
    '{username}さん、最近見かけなくて寂しいです また遊びに来てくれたら嬉しいな 待ってるね！',
    NULL,
    ARRAY['S2','S3','S5','S6','S8']::TEXT[],
    336,
    15,
    true,
    30
  ),
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    'セグメント昇格DM',
    'segment_upgrade',
    NULL,
    '{"track_upgrades": ["S9->S7", "S7->S4", "S5->S4", "S4->S1"]}'::JSONB,
    'direct_dm',
    '{username}さん、いつも応援ありがとう {username}さんは私にとって本当に大切な存在です これからもよろしくね！',
    NULL,
    ARRAY[]::TEXT[],
    168,
    20,
    true,
    40
  ),
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    '他社流入ウェルカムDM',
    'competitor_outflow',
    NULL,
    '{"min_spy_tokens": 500, "days_since_own_visit": 7}'::JSONB,
    'direct_dm',
    '{username}さん、お久しぶりです 最近見かけなかったから気になってました また遊びに来てくれたら嬉しいな！',
    NULL,
    ARRAY['S2','S3','S5','S6','S8']::TEXT[],
    336,
    10,
    true,
    50
  ),
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    '配信後サンキューDM',
    'post_session',
    NULL,
    '{"delay_minutes": 30, "min_session_tokens": 50}'::JSONB,
    'direct_dm',
    '{username}さん、今日は配信に来てくれてありがとう {session_tokens}tkもありがとう 次の配信も楽しみにしててね！',
    NULL,
    ARRAY['S1','S2','S4','S5','S7','S9']::TEXT[],
    48,
    50,
    true,
    60
  ),
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    'クロスプロモDM',
    'cross_promotion',
    NULL,
    '{"min_visits_other_cast": 3, "max_visits_target_cast": 0}'::JSONB,
    'direct_dm',
    '{username}さん、{cast_name}です 他の配信で見かけて気になってました よかったら私の配信にも遊びに来てくれませんか？',
    NULL,
    ARRAY[]::TEXT[],
    720,
    10,
    false,
    70
  )
ON CONFLICT DO NOTHING;
