-- Migration 029: viewer_stats に視聴者内訳カラム追加
-- アルティメット会員数・コイン有りユーザー数・その他の内訳を記録

ALTER TABLE public.viewer_stats ADD COLUMN IF NOT EXISTS ultimate_count INTEGER DEFAULT 0;
ALTER TABLE public.viewer_stats ADD COLUMN IF NOT EXISTS coin_holders INTEGER DEFAULT 0;
ALTER TABLE public.viewer_stats ADD COLUMN IF NOT EXISTS others_count INTEGER DEFAULT 0;

COMMENT ON COLUMN public.viewer_stats.ultimate_count IS 'アルティメット会員数（viewer panel の info-item-ultimate から取得）';
COMMENT ON COLUMN public.viewer_stats.coin_holders IS 'コイン有りユーザー数（viewer panel の info-item-grey から取得）';
COMMENT ON COLUMN public.viewer_stats.others_count IS 'その他の視聴者数（total - ultimate - coin_holders）';
