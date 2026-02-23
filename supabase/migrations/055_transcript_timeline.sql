-- ============================================================
-- 055: get_transcript_timeline — 時刻突合タイムライン
-- cast_transcripts（文字起こし）+ spy_messages（チャット）+
-- coin_transactions（課金）を時刻で突合し、
-- 「何を言ったら客がどう動いたか」の質的データを返す。
-- ============================================================

DROP FUNCTION IF EXISTS public.get_transcript_timeline(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_transcript_timeline(
  p_account_id UUID,
  p_cast_name  TEXT,
  p_session_id TEXT          -- spy_messages 側の session_id（TEXT型）
)
RETURNS TABLE (
  event_time  TIMESTAMPTZ,
  event_type  TEXT,           -- 'transcript' | 'chat' | 'tip' | 'enter' | 'leave' | 'coin'
  user_name   TEXT,
  message     TEXT,
  tokens      INTEGER,
  coin_type   TEXT,           -- coin_transactions.type（coin イベントのみ）
  confidence  NUMERIC,        -- transcript のみ
  elapsed_sec INTEGER,        -- セッション開始からの秒数
  is_highlight BOOLEAN        -- 課金30秒前後のtranscriptか
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_session_start TIMESTAMPTZ;
  v_session_end   TIMESTAMPTZ;
  v_recording_start TIMESTAMPTZ;
BEGIN
  -- ───────────────────────────────────────────
  -- 1. セッションの時間範囲を取得
  -- ───────────────────────────────────────────
  SELECT MIN(sm.message_time), MAX(sm.message_time)
    INTO v_session_start, v_session_end
    FROM public.spy_messages sm
   WHERE sm.account_id = p_account_id
     AND sm.cast_name  = p_cast_name
     AND sm.session_id = p_session_id;

  IF v_session_start IS NULL THEN
    RETURN;
  END IF;

  -- recording_started_at を取得（absolute_start_at 計算用）
  SELECT ct.recording_started_at
    INTO v_recording_start
    FROM public.cast_transcripts ct
   WHERE ct.account_id = p_account_id
     AND ct.cast_name  = p_cast_name
     AND ct.session_id = p_session_id::UUID
     AND ct.recording_started_at IS NOT NULL
   LIMIT 1;

  -- ───────────────────────────────────────────
  -- 2. UNION ALL で3ソースを統合して時刻順に返却
  -- ───────────────────────────────────────────
  RETURN QUERY

  WITH
  -- ── A: transcripts ──
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
      0::INTEGER AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      ct.confidence AS evt_confidence
    FROM public.cast_transcripts ct
    WHERE ct.account_id = p_account_id
      AND ct.cast_name  = p_cast_name
      AND ct.session_id = p_session_id::UUID
      AND ct.processing_status = 'completed'
  ),

  -- ── B: spy_messages (chat / tip / enter / leave) ──
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
      COALESCE(sm.tokens, 0)::INTEGER AS evt_tokens,
      NULL::TEXT AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name  = p_cast_name
      AND sm.session_id = p_session_id
  ),

  -- ── C: coin_transactions（セッション時間範囲内） ──
  coins AS (
    SELECT
      coin.date AS evt_time,
      'coin'::TEXT AS evt_type,
      coin.user_name AS evt_user,
      coin.source_detail AS evt_message,
      coin.tokens::INTEGER AS evt_tokens,
      coin.type AS evt_coin_type,
      NULL::NUMERIC AS evt_confidence
    FROM public.coin_transactions coin
    WHERE coin.account_id = p_account_id
      AND coin.cast_name  = p_cast_name
      AND coin.date >= v_session_start - INTERVAL '5 minutes'
      AND coin.date <= v_session_end   + INTERVAL '5 minutes'
  ),

  -- ── 統合 ──
  merged AS (
    SELECT * FROM transcripts
    UNION ALL
    SELECT * FROM spy
    UNION ALL
    SELECT * FROM coins
  ),

  -- ── 課金イベントの時刻リスト（highlight計算用） ──
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
    -- is_highlight: transcript が課金イベントの前後30秒以内
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
