-- ============================================================
-- 102_fix_goal_miscount.sql
-- ゴール誤カウント修正 + 既存データ復元
--
-- 問題: Collectorがゴール系メッセージを 'chat' や 'tip' として保存していた
--   - goalChanged WSイベント未購読
--   - normalizer が 'goal' を VALID_MSG_TYPES に含んでいなかった
--   - tip補正ロジックで tokens > 0 の goal が 'tip' に変換されていた
--
-- 修正: Chrome拡張と同一のゴールパターンで既存データを再分類
--   パターン: ゴール, goal, エピック, epic, 達成, 残り.*コイン, 新しいゴール, new goal
--
-- ROLLBACK手順:
--   UPDATE spy_messages
--   SET msg_type = 'tip', tokens = (metadata->>'original_tokens')::INTEGER
--   WHERE metadata->>'reclassified_from' IS NOT NULL
--     AND metadata->>'reclassified_from' IN ('tip', 'chat');
-- ============================================================

BEGIN;

-- Step 1: tip/chat → goal 再分類（ゴールパターンに一致するメッセージ）
-- tokens を 0 にリセット（ゴールメッセージの tokens は偽チップ）
-- 元の値を metadata に保存（ロールバック可能）
WITH targets AS (
  SELECT id, msg_type, tokens, metadata
  FROM spy_messages
  WHERE message_time >= '2025-02-15'
    AND msg_type IN ('tip', 'chat', 'system')
    AND (
      message ~* 'ゴール'
      OR message ~* 'goal'
      OR message ~* 'エピック'
      OR message ~* 'epic'
      OR message ~* '達成'
      OR message ~* '残り.*コイン'
      OR message ~* '新しいゴール'
      OR message ~* 'new goal'
    )
    -- 既に修正済みのものは除外
    AND (metadata->>'reclassified_from') IS NULL
)
UPDATE spy_messages sm
SET
  msg_type = 'goal',
  tokens = 0,
  metadata = sm.metadata
    || jsonb_build_object(
      'reclassified_from', t.msg_type,
      'original_tokens', t.tokens,
      'reclassified_at', NOW()::TEXT,
      'reclassified_by', '102_fix_goal_miscount'
    )
FROM targets t
WHERE sm.id = t.id;

-- Step 2: 影響件数を確認（ログ出力用）
DO $$
DECLARE
  cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM spy_messages
  WHERE metadata->>'reclassified_by' = '102_fix_goal_miscount';

  RAISE NOTICE '102_fix_goal_miscount: % records reclassified to goal', cnt;
END $$;

COMMIT;
