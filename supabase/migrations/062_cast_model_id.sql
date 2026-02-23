-- ============================================================
-- 062: キャスト設定拡張 — model_id (BIGINT), platform, avatar_url
-- Collector (WebSocket) が model_id (数値) を必要とするため追加。
-- 既存の stripchat_model_id (TEXT, migration 054) はCDNサムネ用に残す。
-- ============================================================

-- registered_casts
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS model_id BIGINT;
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS platform TEXT DEFAULT 'stripchat';
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS avatar_url TEXT;

COMMENT ON COLUMN registered_casts.model_id  IS 'Stripchat numeric model ID for WebSocket/Collector';
COMMENT ON COLUMN registered_casts.platform  IS 'プラットフォーム (stripchat / fanza / chatpia)';
COMMENT ON COLUMN registered_casts.avatar_url IS 'アバター画像URL';

-- spy_casts
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS model_id BIGINT;
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS avatar_url TEXT;

COMMENT ON COLUMN spy_casts.model_id   IS 'Stripchat numeric model ID for WebSocket/Collector';
COMMENT ON COLUMN spy_casts.avatar_url IS 'アバター画像URL';

-- 既知の model_id を設定（stripchat_model_id TEXT → model_id BIGINT にコピー）
UPDATE registered_casts SET model_id = 178845750 WHERE cast_name = 'Risa_06' AND model_id IS NULL;
UPDATE registered_casts SET model_id = 186865131 WHERE cast_name = 'hanshakun' AND model_id IS NULL;

UPDATE spy_casts SET model_id = 186865131 WHERE cast_name = 'hanshakun' AND model_id IS NULL;
