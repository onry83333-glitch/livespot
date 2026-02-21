-- Migration 034: screenshots テーブル
-- SPY監視中のスクリーンショットメタデータを保存

CREATE TABLE IF NOT EXISTS public.screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  session_id UUID,
  filename TEXT NOT NULL,
  storage_path TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screenshots_cast ON public.screenshots(cast_name, captured_at DESC);

-- RLS
ALTER TABLE public.screenshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "screenshots_select" ON public.screenshots
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY "screenshots_insert" ON public.screenshots
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

COMMENT ON TABLE public.screenshots IS 'SPY監視中のスクリーンショットメタデータ（5分間隔キャプチャ）';
