-- Migration 014: alert_rules テーブル
-- リアルタイム配信中のポップアラートルール管理

CREATE TABLE IF NOT EXISTS public.alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id),
  cast_name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'high_tip',
    'vip_enter',
    'whale_enter',
    'new_user_tip',
    'viewer_milestone'
  )),
  threshold_value INTEGER DEFAULT 100,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alert_rules_account ON public.alert_rules(account_id, cast_name);

-- RLS
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "alert_rules_all" ON public.alert_rules
  FOR ALL USING (account_id IN (SELECT public.user_account_ids()));
