-- ============================================================
-- 081: tokens カラム INTEGER → BIGINT 変換
--
-- 対象:
--   1. coin_transactions.tokens   (INTEGER NOT NULL → BIGINT NOT NULL)
--   2. spy_messages.tokens         (INTEGER DEFAULT 0 → BIGINT DEFAULT 0)
--   3. paid_users.total_coins      (INTEGER DEFAULT 0 → BIGINT DEFAULT 0)
--   4. viewer_stats.total_tokens   (INTEGER DEFAULT 0 → BIGINT DEFAULT 0)
--   5. get_transcript_timeline RPC 戻り値 tokens INTEGER → BIGINT
--
-- PostgreSQL INTEGER: max 2,147,483,647 (~21億)
-- 大量コインを扱うキャストでオーバーフローのリスクがあるため BIGINT に統一。
-- RPC の SUM() 戻り値は既に BIGINT だが、元カラムも合わせる。
--
-- ROLLBACK:
--   ALTER TABLE public.coin_transactions ALTER COLUMN tokens TYPE INTEGER;
--   ALTER TABLE public.spy_messages ALTER COLUMN tokens TYPE INTEGER;
--   ALTER TABLE public.paid_users ALTER COLUMN total_coins TYPE INTEGER;
--   ALTER TABLE public.viewer_stats ALTER COLUMN total_tokens TYPE INTEGER;
--   -- get_transcript_timeline は再作成（055_transcript_timeline.sql を再適用）
-- ============================================================

-- 1. coin_transactions.tokens
ALTER TABLE public.coin_transactions
  ALTER COLUMN tokens TYPE BIGINT;

-- 2. spy_messages.tokens
ALTER TABLE public.spy_messages
  ALTER COLUMN tokens TYPE BIGINT;

-- 3. paid_users.total_coins
ALTER TABLE public.paid_users
  ALTER COLUMN total_coins TYPE BIGINT;

-- 4. viewer_stats.total_tokens
ALTER TABLE public.viewer_stats
  ALTER COLUMN total_tokens TYPE BIGINT;

-- 5. get_transcript_timeline RPC: tokens 戻り値を BIGINT に更新
--    関数内の ::INTEGER キャストも ::BIGINT に修正
DROP FUNCTION IF EXISTS public.get_transcript_timeline(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_transcript_timeline(
  p_account_id UUID,
  p_cast_name  TEXT,
  p_session_id TEXT
)
RETURNS TABLE (
  event_time  TIMESTAMPTZ,
  event_type  TEXT,
  user_name   TEXT,
  message     TEXT,
  tokens      BIGINT,
  coin_type   TEXT,
  confidence  NUMERIC,
  elapsed_sec INTEGER,
  is_highlight BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session_start TIMESTAMPTZ;
  v_session_end   TIMESTAMPTZ;
  v_recording_start TIMESTAMPTZ;
BEGIN
  SELECT MIN(sm.message_time), MAX(sm.message_time)
    INTO v_session_start, v_session_end
    FROM public.spy_messages sm
   WHERE sm.account_id = p_account_id
     AND sm.cast_name  = p_cast_name
     AND sm.session_id = p_session_id;

  IF v_session_start IS NULL THEN
    RETURN;
  END IF;

  SELECT ct.recording_started_at
    INTO v_recording_start
    FROM public.cast_transcripts ct
   WHERE ct.account_id = p_account_id
     AND ct.cast_name  = p_cast_name
     AND ct.session_id = p_session_id::UUID
     AND ct.recording_started_at IS NOT NULL
   LIMIT 1;

  RETURN QUERY

  WITH
  transcripts AS (
    SELECT
      COALESCE(
        ct.absolute_start_at,
        CASE WHEN v_recording_start IS NOT NULL AND ct.segment_start_seconds IS NOT NULL
             THEN v_recording_start + (ct.segment_start_seconds || ' seconds')::INTERVAL
             ELSE v_session_start + COALESCE((ct.segment_start_seconds || ' seconds')::INTERVAL, INTERVAL '0')
        END
      ) AS evt_time,
      'transcript'::TEXT AS evt_type,
      NULL::TEXT AS evt_user,
      ct.text AS evt_message,
      0::BIGINT AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      ct.confidence AS evt_confidence
    FROM public.cast_transcripts ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name  = p_cast_name
      AND ct.session_id = p_session_id::UUID
      AND ct.processing_status = 'completed'
  ),

  spy AS (
    SELECT
      sm.message_time AS evt_time,
      CASE
        WHEN sm.tokens > 0 THEN 'tip'
        WHEN sm.msg_type = 'enter' THEN 'enter'
        WHEN sm.msg_type = 'leave' THEN 'leave'
        ELSE 'chat'
      END::TEXT AS evt_type,
      sm.user_name AS evt_user,
      sm.message AS evt_message,
      COALESCE(sm.tokens, 0)::BIGINT AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name  = p_cast_name
      AND sm.session_id = p_session_id
  ),

  coins AS (
    SELECT
      coin.date AS evt_time,
      'coin'::TEXT AS evt_type,
      coin.user_name AS evt_user,
      coin.source_detail AS evt_message,
      coin.tokens AS evt_tokens,
      coin.type AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.coin_transactions coin
    WHERE coin.account_id = p_account_id
      AND coin.cast_name  = p_cast_name
      AND coin.date >= v_session_start - INTERVAL '5 minutes'
      AND coin.date <= v_session_end   + INTERVAL '5 minutes'
  ),

  merged AS (
    SELECT * FROM transcripts
    UNION ALL
    SELECT * FROM spy
    UNION ALL
    SELECT * FROM coins
  ),

  payment_times AS (
    SELECT evt_time
      FROM merged
     WHERE evt_type IN ('tip', 'coin')
       AND evt_tokens > 0
  )

  SELECT
    m.evt_time                              AS event_time,
    m.evt_type                              AS event_type,
    m.evt_user                              AS user_name,
    m.evt_message                           AS message,
    m.evt_tokens                            AS tokens,
    m.evt_coin_type                         AS coin_type,
    m.evt_confidence                        AS confidence,
    EXTRACT(EPOCH FROM (m.evt_time - v_session_start))::INTEGER AS elapsed_sec,
    (m.evt_type = 'transcript' AND EXISTS (
      SELECT 1 FROM payment_times pt
       WHERE pt.evt_time BETWEEN m.evt_time - INTERVAL '30 seconds'
                              AND m.evt_time + INTERVAL '30 seconds'
    ))::BOOLEAN AS is_highlight

  FROM merged m
  ORDER BY m.evt_time ASC, m.evt_type ASC;
END;
$$;

COMMENT ON FUNCTION public.get_transcript_timeline(UUID, TEXT, TEXT)
  IS '文字起こし+チャット+課金を時刻順に統合するタイムラインRPC';
