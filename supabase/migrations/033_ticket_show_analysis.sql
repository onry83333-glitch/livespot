-- Migration 033: sessions にチケットショー分析カラム追加
-- チケチャ（チケットチャット）検出結果を保存

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS ticket_shows JSONB DEFAULT '[]';
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_ticket_revenue INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_tip_revenue INTEGER DEFAULT 0;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS total_ticket_attendees INTEGER DEFAULT 0;

COMMENT ON COLUMN public.sessions.ticket_shows IS 'チケットショー検出結果の配列 [{started_at, ended_at, ticket_price, ticket_revenue, estimated_attendees, tip_revenue}]';
COMMENT ON COLUMN public.sessions.total_ticket_revenue IS 'セッション中のチケット売上合計 (tokens)';
COMMENT ON COLUMN public.sessions.total_tip_revenue IS 'セッション中の非チケットチップ合計 (tokens)';
COMMENT ON COLUMN public.sessions.total_ticket_attendees IS 'セッション中のチケット購入者数合計';
