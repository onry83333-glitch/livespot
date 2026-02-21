-- Migration 040: グループチャット課金レート
-- registered_casts / spy_casts に gc_rate_per_minute カラム追加
-- デフォルト12コイン/分（Stripchat標準GCレート）

ALTER TABLE registered_casts
ADD COLUMN IF NOT EXISTS gc_rate_per_minute NUMERIC DEFAULT 12;

ALTER TABLE spy_casts
ADD COLUMN IF NOT EXISTS gc_rate_per_minute NUMERIC DEFAULT 12;

COMMENT ON COLUMN registered_casts.gc_rate_per_minute IS 'グループチャット課金レート（コイン/分）。デフォルト12';
COMMENT ON COLUMN spy_casts.gc_rate_per_minute IS 'グループチャット課金レート（コイン/分）。デフォルト12';
