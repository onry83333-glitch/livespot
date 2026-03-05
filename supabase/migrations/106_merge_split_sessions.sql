-- ============================================================
-- 106: セッション分割バグ修正 — 不正分割セッションのマージ
--
-- 原因: collector.ts の isOnline 判定に ticketShow/groupShow が
-- 含まれておらず、チケットショー中にセッションが不正に閉じられていた。
-- 同一キャスト・60秒未満のギャップで連続するセッションをマージする。
--
-- 対象: 57グループ、140セッション削除 → 57セッションに統合
--
-- ROLLBACK:
--   この操作はデータ削除を伴うため、実行前にバックアップテーブルを作成。
--   ROLLBACK: DROP TABLE IF EXISTS _backup_sessions_106; で不要時に削除。
-- ============================================================

-- Step 1: バックアップ
CREATE TABLE IF NOT EXISTS _backup_sessions_106 AS
SELECT * FROM sessions;

-- Step 2: マージ実行
-- CTEでマージグループを特定し、各グループの最初のセッションに統合
DO $$
DECLARE
  v_merged_count INTEGER := 0;
  v_deleted_count INTEGER := 0;
  rec RECORD;
BEGIN
  -- 一時テーブルにマージ対象を計算
  CREATE TEMP TABLE _merge_groups AS
  WITH ordered AS (
    SELECT
      session_id,
      cast_name,
      account_id,
      started_at,
      ended_at,
      total_messages,
      total_tokens,
      peak_viewers,
      LAG(ended_at) OVER (PARTITION BY account_id, cast_name ORDER BY started_at) AS prev_ended_at,
      LAG(session_id) OVER (PARTITION BY account_id, cast_name ORDER BY started_at) AS prev_session_id
    FROM sessions
    WHERE ended_at IS NOT NULL
  ),
  gaps AS (
    SELECT *,
      CASE
        WHEN prev_ended_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (started_at - prev_ended_at)) < 60
        THEN 0  -- 同じグループ
        ELSE 1  -- 新グループ開始
      END AS is_group_start
    FROM ordered
  ),
  groups AS (
    SELECT *,
      SUM(is_group_start) OVER (PARTITION BY account_id, cast_name ORDER BY started_at) AS group_id
    FROM gaps
  ),
  group_info AS (
    SELECT
      account_id,
      cast_name,
      group_id,
      COUNT(*) AS session_count,
      MIN(session_id) AS keep_session_id,
      MIN(started_at) AS group_started_at,
      MAX(ended_at) AS group_ended_at,
      COALESCE(SUM(total_messages), 0) AS total_messages_sum,
      COALESCE(SUM(total_tokens), 0) AS total_tokens_sum,
      MAX(COALESCE(peak_viewers, 0)) AS peak_viewers_max,
      ARRAY_AGG(session_id ORDER BY started_at) AS all_session_ids
    FROM groups
    GROUP BY account_id, cast_name, group_id
    HAVING COUNT(*) > 1
  )
  SELECT * FROM group_info;

  -- マージ実行
  FOR rec IN SELECT * FROM _merge_groups LOOP
    -- 保持するセッション（最初のもの）を更新
    UPDATE sessions
    SET
      ended_at = rec.group_ended_at,
      total_messages = rec.total_messages_sum,
      total_tokens = rec.total_tokens_sum,
      peak_viewers = rec.peak_viewers_max
    WHERE session_id = rec.keep_session_id;

    -- spy_messages の session_id を統合先に更新
    UPDATE spy_messages
    SET session_id = rec.keep_session_id::TEXT
    WHERE session_id::TEXT = ANY(
      SELECT unnest(rec.all_session_ids)::TEXT
    )
    AND session_id::TEXT != rec.keep_session_id::TEXT;

    -- 不要なセッションを削除（最初以外）
    DELETE FROM sessions
    WHERE session_id = ANY(rec.all_session_ids)
    AND session_id != rec.keep_session_id;

    v_merged_count := v_merged_count + 1;
    v_deleted_count := v_deleted_count + (rec.session_count - 1);
  END LOOP;

  DROP TABLE _merge_groups;

  RAISE NOTICE 'Session merge complete: % groups merged, % duplicate sessions deleted', v_merged_count, v_deleted_count;
END;
$$;

-- Step 3: spy_messagesから再集計してtotal_messages/total_tokensを正確にする
UPDATE sessions s
SET
  total_messages = sub.msg_count,
  total_tokens = sub.tip_total
FROM (
  SELECT
    session_id::UUID AS sid,
    COUNT(*) AS msg_count,
    COALESCE(SUM(tokens), 0) AS tip_total
  FROM spy_messages
  WHERE session_id IS NOT NULL
  GROUP BY session_id
) sub
WHERE s.session_id = sub.sid
AND s.ended_at IS NOT NULL;
