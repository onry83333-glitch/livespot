-- Migration 037: キャスト別スクリーンショット撮影間隔
-- registered_casts: デフォルト5分（自社キャストは撮影ON）
-- spy_casts: デフォルト0（他社はOFF）

ALTER TABLE registered_casts
ADD COLUMN IF NOT EXISTS screenshot_interval INTEGER DEFAULT 5;

ALTER TABLE spy_casts
ADD COLUMN IF NOT EXISTS screenshot_interval INTEGER DEFAULT 0;

COMMENT ON COLUMN registered_casts.screenshot_interval IS 'スクリーンショット撮影間隔（分）。0=OFF, 5/10/15/30';
COMMENT ON COLUMN spy_casts.screenshot_interval IS 'スクリーンショット撮影間隔（分）。0=OFF, 5/10/15/30';
