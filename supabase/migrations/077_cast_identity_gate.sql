-- ============================================================
-- 077: DM送信キャスト身元検証ゲート（P0-5 再発防止）
-- registered_casts に stripchat_user_id を追加し、
-- DM送信前にセッションとキャストの一致を検証可能にする
-- ============================================================

-- ─── 1. registered_casts に stripchat_user_id カラム追加 ───
ALTER TABLE public.registered_casts
  ADD COLUMN IF NOT EXISTS stripchat_user_id BIGINT;

COMMENT ON COLUMN public.registered_casts.stripchat_user_id
  IS 'Stripchat内部ユーザーID。DM送信時にセッションuserIdとの一致検証に使用';

-- ─── 2. 既知キャストのID登録 ───
UPDATE public.registered_casts
  SET stripchat_user_id = 186865131
  WHERE cast_name = 'hanshakun' AND stripchat_user_id IS NULL;

UPDATE public.registered_casts
  SET stripchat_user_id = 178845750
  WHERE cast_name = 'Risa_06' AND stripchat_user_id IS NULL;

-- ─── 3. verify_dm_cast_identity RPC ───
-- DM送信前にcast_name→registered_casts.stripchat_user_id→セッションuserIdの一致を検証
CREATE OR REPLACE FUNCTION public.verify_dm_cast_identity(
  p_account_id UUID,
  p_cast_name TEXT
)
RETURNS TABLE (
  ok BOOLEAN,
  registered_user_id BIGINT,
  session_user_id TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_registered_id BIGINT;
  v_session_id TEXT;
BEGIN
  -- 1. registered_casts から stripchat_user_id を取得
  SELECT rc.stripchat_user_id INTO v_registered_id
  FROM public.registered_casts rc
  WHERE rc.account_id = p_account_id
    AND rc.cast_name = p_cast_name
    AND rc.is_active = true;

  IF v_registered_id IS NULL THEN
    RETURN QUERY SELECT
      false,
      NULL::BIGINT,
      NULL::TEXT,
      format('cast_name "%s" の stripchat_user_id が未登録です', p_cast_name);
    RETURN;
  END IF;

  -- 2. stripchat_sessions から session の user_id を取得
  SELECT ss.stripchat_user_id INTO v_session_id
  FROM public.stripchat_sessions ss
  WHERE ss.account_id = p_account_id
    AND ss.is_valid = true;

  IF v_session_id IS NULL THEN
    RETURN QUERY SELECT
      false,
      v_registered_id,
      NULL::TEXT,
      '有効なセッションがありません';
    RETURN;
  END IF;

  -- 3. 一致検証
  IF v_session_id != v_registered_id::TEXT THEN
    RETURN QUERY SELECT
      false,
      v_registered_id,
      v_session_id,
      format('セッション不一致: cast=%s(ID:%s) だがセッションのuserIdは %s です。誤送信を防止しました。',
             p_cast_name, v_registered_id, v_session_id);
    RETURN;
  END IF;

  -- OK
  RETURN QUERY SELECT
    true,
    v_registered_id,
    v_session_id,
    NULL::TEXT;
END;
$$;

COMMENT ON FUNCTION public.verify_dm_cast_identity(UUID, TEXT)
  IS 'DM送信前のキャスト身元検証: cast_name→registered_casts.stripchat_user_id→session.stripchat_user_idの一致を確認';
