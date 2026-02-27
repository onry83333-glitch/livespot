-- 088_close_orphan_sessions.sql
-- 孤児セッション一括クローズ + 起動時クリーンアップRPC
--
-- 問題: Collector再起動時にセッション状態が失われ、ended_at=NULLのまま放置される（793/876件=90.5%）
-- 原因:
--   1. シャットダウン時にDB上のセッションをクローズしない
--   2. 起動時に既存の未閉鎖セッションを処理しない
--   3. オフラインキャストの旧セッションがクローズされない
--
-- ROLLBACK:
--   UPDATE sessions SET ended_at = NULL, total_messages = NULL, total_tokens = NULL
--   WHERE ended_at IS NOT NULL AND total_messages IS NULL AND total_tokens IS NULL
--     AND ended_at > '2026-02-28';
--   DROP FUNCTION IF EXISTS close_orphan_sessions(interval);

-- ============================================================
-- Step 1: 24時間以上前に開始された未閉鎖セッションを一括クローズ
-- ended_at = started_at + 4時間（平均配信時間の推定値）
-- ============================================================
WITH orphans AS (
  SELECT session_id, started_at
  FROM sessions
  WHERE ended_at IS NULL
    AND started_at < NOW() - INTERVAL '24 hours'
)
UPDATE sessions s
SET ended_at = o.started_at + INTERVAL '4 hours'
FROM orphans o
WHERE s.session_id = o.session_id;

-- ============================================================
-- Step 2: Collector起動時に呼び出すRPC
-- 指定時間以上前に開始された未閉鎖セッションをクローズする
-- ============================================================
CREATE OR REPLACE FUNCTION close_orphan_sessions(
  p_stale_threshold INTERVAL DEFAULT INTERVAL '6 hours'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_closed INTEGER;
BEGIN
  WITH orphans AS (
    SELECT session_id, started_at
    FROM sessions
    WHERE ended_at IS NULL
      AND started_at < NOW() - p_stale_threshold
  )
  UPDATE sessions s
  SET ended_at = o.started_at + INTERVAL '4 hours'
  FROM orphans o
  WHERE s.session_id = o.session_id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$$;
