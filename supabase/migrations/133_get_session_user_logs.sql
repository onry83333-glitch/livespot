-- 133: セッション内ユーザーログ取得RPC
-- spy_messagesから指定ユーザーの配信中ログを時系列で返す

CREATE OR REPLACE FUNCTION public.get_session_user_logs(
  p_cast_name TEXT,
  p_session_start TIMESTAMPTZ,
  p_session_end TIMESTAMPTZ,
  p_user_names TEXT[]
)
RETURNS TABLE(
  user_name TEXT,
  message TEXT,
  msg_type TEXT,
  tokens BIGINT,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.user_name,
    sm.message,
    sm.msg_type,
    COALESCE(sm.tokens, 0) AS tokens,
    sm.created_at
  FROM public.spy_messages sm
  WHERE sm.cast_name = p_cast_name
    AND sm.created_at >= p_session_start
    AND sm.created_at <= COALESCE(p_session_end, NOW())
    AND sm.user_name = ANY(p_user_names)
  ORDER BY sm.created_at ASC
  LIMIT 500;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
