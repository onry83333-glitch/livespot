-- Migration 019: coin_transactions.cast_name正式化 + sessions.cast_name追加 + 再振り分けRPC
-- Chrome拡張が既にcast_nameを書き込んでいるが、migrationで未追跡だったため正式化

-- 1. coin_transactions に cast_name カラムを正式追加
ALTER TABLE public.coin_transactions ADD COLUMN IF NOT EXISTS cast_name TEXT;
CREATE INDEX IF NOT EXISTS idx_coin_tx_cast ON public.coin_transactions(account_id, cast_name, date DESC);

-- 2. sessions に cast_name カラムを追加（現在 title に格納されている）
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS cast_name TEXT;
UPDATE public.sessions SET cast_name = title WHERE cast_name IS NULL AND title IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_cast ON public.sessions(account_id, cast_name, started_at DESC);

-- 3. reassign_coin_transactions_by_session RPC
-- セッション配信時間帯とcoin_transactionsのdateを突合してcast_nameを再振り分け
-- Step1: 配信中 → そのセッションのcast_name
-- Step2: オフライン(offlineTip) → 直前に配信していたキャストに帰属
CREATE OR REPLACE FUNCTION reassign_coin_transactions_by_session(
  p_account_id UUID
)
RETURNS TABLE(
  updated_count BIGINT,
  session_matched BIGINT,
  fallback_matched BIGINT
) AS $$
DECLARE
  v_session_matched BIGINT := 0;
  v_fallback_matched BIGINT := 0;
BEGIN
  -- Step 1: 配信中のトランザクション → セッションのcast_nameで上書き
  WITH session_cast AS (
    SELECT
      s.started_at,
      COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours') AS effective_end,
      COALESCE(s.cast_name, s.title) AS session_cast_name
    FROM sessions s
    WHERE s.account_id = p_account_id
      AND COALESCE(s.cast_name, s.title) IS NOT NULL
  ),
  matched AS (
    UPDATE coin_transactions ct
    SET cast_name = sc.session_cast_name
    FROM session_cast sc
    WHERE ct.account_id = p_account_id
      AND ct.date >= sc.started_at
      AND ct.date < sc.effective_end
      AND (ct.cast_name IS NULL OR ct.cast_name = 'unknown' OR ct.cast_name != sc.session_cast_name)
    RETURNING ct.id
  )
  SELECT COUNT(*) INTO v_session_matched FROM matched;

  -- Step 2: オフラインtip → 直前の過去セッションのcast_nameで上書き
  WITH latest_session AS (
    SELECT DISTINCT ON (ct_inner.id)
      ct_inner.id AS tx_id,
      COALESCE(s.cast_name, s.title) AS prev_cast_name
    FROM coin_transactions ct_inner
    JOIN sessions s
      ON s.account_id = ct_inner.account_id
      AND COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours') <= ct_inner.date
      AND COALESCE(s.cast_name, s.title) IS NOT NULL
    WHERE ct_inner.account_id = p_account_id
      AND (ct_inner.cast_name IS NULL OR ct_inner.cast_name = 'unknown')
    ORDER BY ct_inner.id, s.started_at DESC
  ),
  fallback_matched AS (
    UPDATE coin_transactions ct
    SET cast_name = ls.prev_cast_name
    FROM latest_session ls
    WHERE ct.id = ls.tx_id
    RETURNING ct.id
  )
  SELECT COUNT(*) INTO v_fallback_matched FROM fallback_matched;

  RETURN QUERY SELECT
    (v_session_matched + v_fallback_matched)::BIGINT AS updated_count,
    v_session_matched AS session_matched,
    v_fallback_matched AS fallback_matched;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
