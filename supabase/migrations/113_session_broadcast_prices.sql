-- Migration 113: sessions に broadcast_prices / broadcast_goal カラム追加
-- 売上精度向上: /cam API から取得した価格設定とゴール情報を保存
-- private/cam2cam/ticket/group/spy の分単価を記録し、
-- coin_transactions にギャップがある場合の売上推定に使用
--
-- ROLLBACK:
--   ALTER TABLE public.sessions DROP COLUMN IF EXISTS broadcast_prices;
--   ALTER TABLE public.sessions DROP COLUMN IF EXISTS broadcast_goal;

ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS broadcast_prices JSONB DEFAULT NULL;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS broadcast_goal JSONB DEFAULT NULL;

COMMENT ON COLUMN public.sessions.broadcast_prices IS '配信価格設定 {privatePrice, cam2camPrice, ticketShowPrice, groupShowPrice, spyPrice} (tokens/min or tokens)';
COMMENT ON COLUMN public.sessions.broadcast_goal IS '配信ゴール設定 {amount, currentAmount, description, isAchieved}';

-- PostgREST スキーマキャッシュ更新
NOTIFY pgrst, 'reload schema';
