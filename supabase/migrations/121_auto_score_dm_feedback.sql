-- ============================================================
-- 121: auto_score_dm_feedback — DM送信後の自動スコアリングRPC
-- ルールベースでpersona_feedbackに自動記録
-- 手動実行ボタン or daily-briefingから1日1回呼ばれる想定
-- ============================================================
-- ROLLBACK: DROP FUNCTION IF EXISTS public.auto_score_dm_feedback(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.auto_score_dm_feedback(
  p_account_id UUID,
  p_cast_name  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_processed  INT := 0;
  v_skipped    INT := 0;
  v_visit_bonus INT := 0;
  v_coin_bonus  INT := 0;
  rec RECORD;
  v_score      FLOAT;
  v_has_visit  BOOLEAN;
  v_has_coin   BOOLEAN;
  v_detail     JSONB;
BEGIN
  -- dm_send_log から status='success' かつ
  -- まだ persona_feedback に auto スコアが記録されていないレコードを対象にする
  -- 送信から48h以上経過したもののみ（CVR判定期間を確保）
  FOR rec IN
    SELECT
      d.id         AS dm_id,
      d.user_name,
      d.cast_name,
      d.sent_at,
      d.campaign,
      d.message
    FROM dm_send_log d
    WHERE d.account_id = p_account_id
      AND d.cast_name  = p_cast_name
      AND d.status      = 'success'
      AND d.sent_at     IS NOT NULL
      AND d.sent_at     < NOW() - INTERVAL '48 hours'
      -- まだスコア記録していない（metadata.dm_id で重複チェック）
      AND NOT EXISTS (
        SELECT 1 FROM persona_feedback pf
        WHERE pf.cast_name    = d.cast_name
          AND pf.task_type    = 'dm'
          AND pf.score_source = 'auto'
          AND pf.metadata->>'dm_id' = d.id::TEXT
      )
    ORDER BY d.sent_at DESC
    LIMIT 500  -- 1回あたり最大500件
  LOOP
    -- 基本スコア: DM送信成功 = 50
    v_score := 50;
    v_has_visit := FALSE;
    v_has_coin  := FALSE;

    -- 24h以内にchat_logsに出現？（来訪復帰 +30）
    SELECT EXISTS (
      SELECT 1 FROM chat_logs cl
      WHERE cl.account_id = p_account_id
        AND cl.cast_name  = p_cast_name
        AND cl.username   = rec.user_name
        AND cl.timestamp  > rec.sent_at
        AND cl.timestamp <= rec.sent_at + INTERVAL '24 hours'
    ) INTO v_has_visit;

    IF v_has_visit THEN
      v_score := v_score + 30;
      v_visit_bonus := v_visit_bonus + 1;
    END IF;

    -- 48h以内にcoin_transactionsに出現？（応援復帰 +20）
    SELECT EXISTS (
      SELECT 1 FROM coin_transactions ct
      WHERE ct.account_id = p_account_id
        AND ct.cast_name  = p_cast_name
        AND ct.user_name  = rec.user_name
        AND ct.date        > rec.sent_at
        AND ct.date       <= rec.sent_at + INTERVAL '48 hours'
    ) INTO v_has_coin;

    IF v_has_coin THEN
      v_score := v_score + 20;
      v_coin_bonus := v_coin_bonus + 1;
    END IF;

    -- metadata構築
    v_detail := jsonb_build_object(
      'dm_id',       rec.dm_id,
      'user_name',   rec.user_name,
      'sent_at',     rec.sent_at,
      'campaign',    rec.campaign,
      'visit_24h',   v_has_visit,
      'coin_48h',    v_has_coin,
      'scoring_rule', 'base50 + visit30 + coin20'
    );

    -- persona_feedbackにINSERT
    INSERT INTO persona_feedback (
      cast_name,
      task_type,
      input_context,
      output,
      score,
      score_source,
      metadata
    ) VALUES (
      rec.cast_name,
      'dm',
      jsonb_build_object(
        'campaign', rec.campaign,
        'user_name', rec.user_name
      ),
      COALESCE(LEFT(rec.message, 200), ''),
      v_score,
      'auto',
      v_detail
    );

    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'processed',    v_processed,
    'skipped',      v_skipped,
    'visit_bonus',  v_visit_bonus,
    'coin_bonus',   v_coin_bonus,
    'avg_score',    CASE WHEN v_processed > 0
                      THEN ROUND((50 * v_processed + 30 * v_visit_bonus + 20 * v_coin_bonus)::NUMERIC / v_processed, 1)
                      ELSE 0
                    END
  );
END;
$$;

-- インデックス: dm_send_log の高速走査用
CREATE INDEX IF NOT EXISTS idx_dm_send_log_auto_score
  ON dm_send_log (account_id, cast_name, status, sent_at DESC)
  WHERE status = 'success' AND sent_at IS NOT NULL;

-- インデックス: persona_feedback の重複チェック用
CREATE INDEX IF NOT EXISTS idx_persona_feedback_auto_dm
  ON persona_feedback (cast_name, task_type, score_source)
  WHERE task_type = 'dm' AND score_source = 'auto';

COMMENT ON FUNCTION public.auto_score_dm_feedback(UUID, TEXT)
  IS 'DM送信後のCVR自動スコアリング（ルールベース）: base50 + 来訪24h+30 + 応援48h+20 → persona_feedbackにauto記録';
