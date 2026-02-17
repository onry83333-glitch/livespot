-- ============================================================
-- 007: dm_send_log に cast_name カラム追加
-- DM送信履歴をキャスト別に分離するため
-- ============================================================

ALTER TABLE dm_send_log ADD COLUMN IF NOT EXISTS cast_name TEXT;

-- キャスト別検索用インデックス
CREATE INDEX IF NOT EXISTS idx_dm_send_log_cast_name ON dm_send_log(cast_name);
