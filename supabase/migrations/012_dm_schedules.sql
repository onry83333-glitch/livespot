-- Migration 012: dm_schedules テーブル
-- Chrome拡張のchrome.alarmsベースでDMスケジュール送信を管理

CREATE TABLE IF NOT EXISTS public.dm_schedules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id),
  cast_name TEXT NOT NULL,
  message TEXT NOT NULL,
  target_segment TEXT,           -- 'S1,S2,S3' or 'all'
  target_usernames TEXT[],       -- 個別指定の場合
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'completed', 'failed', 'cancelled')),
  sent_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  error_message TEXT,
  campaign TEXT,
  send_mode TEXT DEFAULT 'pipeline',  -- 'pipeline' or 'sequential'
  tab_count INTEGER DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- インデックス
CREATE INDEX idx_dm_schedules_account ON public.dm_schedules(account_id);
CREATE INDEX idx_dm_schedules_status ON public.dm_schedules(status);
CREATE INDEX idx_dm_schedules_scheduled_at ON public.dm_schedules(scheduled_at);

-- RLS
ALTER TABLE public.dm_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dm_schedules_all" ON public.dm_schedules
  FOR ALL USING (account_id IN (SELECT public.user_account_ids()));

-- Realtime有効化
ALTER PUBLICATION supabase_realtime ADD TABLE public.dm_schedules;
