-- ============================================================
-- 067: アラート/通知基盤
-- alerts テーブル: システムアラート（売上低下・連続赤字・競合変動・市場トレンド）
-- ============================================================

-- 1. alerts テーブル
CREATE TABLE IF NOT EXISTS public.alerts (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'revenue_drop',        -- UC-061: 売上急落検出
    'consecutive_loss',    -- UC-019: 連続赤字検出
    'spy_cast_decline',    -- UC-025: 競合キャスト視聴者急減
    'market_trend_change'  -- UC-026: 市場全体トレンド変動
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  body TEXT,
  metadata JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.alerts IS 'システムアラート（売上低下・連続赤字・競合変動・市場トレンド）';
COMMENT ON COLUMN public.alerts.alert_type IS 'アラート種別';
COMMENT ON COLUMN public.alerts.severity IS '重要度: info / warning / critical';
COMMENT ON COLUMN public.alerts.metadata IS '付加データ（数値・比較元など）';

-- インデックス
CREATE INDEX IF NOT EXISTS idx_alerts_account_unread
  ON public.alerts(account_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_account_type
  ON public.alerts(account_id, alert_type, created_at DESC);

-- RLS
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alerts_select" ON public.alerts;
CREATE POLICY "alerts_select" ON public.alerts
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

DROP POLICY IF EXISTS "alerts_update" ON public.alerts;
CREATE POLICY "alerts_update" ON public.alerts
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));

-- サービスロール（Collector）からINSERTするためALLポリシーも追加
DROP POLICY IF EXISTS "alerts_insert_service" ON public.alerts;
CREATE POLICY "alerts_insert_service" ON public.alerts
  FOR INSERT WITH CHECK (true);
-- ※ CollectorはSUPABASE_SERVICE_ROLE_KEYを使うのでRLSバイパス済みだが、念のため

-- Realtime有効化
ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
