-- Migration 069: dm_send_log に target_user_id カラム追加
-- DB内にusername→userIdマッピングがないユーザーへのDM送信に対応
-- Chrome拡張のDM API送信で使用

ALTER TABLE dm_send_log ADD COLUMN IF NOT EXISTS target_user_id BIGINT;

-- sent_via カラムも確認（API/DOM識別用、既存なら追加しない）
ALTER TABLE dm_send_log ADD COLUMN IF NOT EXISTS sent_via TEXT DEFAULT 'dom';

COMMENT ON COLUMN dm_send_log.target_user_id IS 'Stripchat内部ユーザーID（DM API送信用）';
COMMENT ON COLUMN dm_send_log.sent_via IS 'DM送信方法: api=内部API, dom=DOM操作';
