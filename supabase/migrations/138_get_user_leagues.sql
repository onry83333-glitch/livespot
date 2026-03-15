-- ユーザーリーグ情報取得RPC（spy_messagesから最新のuser_leagueを取得）
CREATE OR REPLACE FUNCTION get_user_leagues(
  p_cast_name TEXT,
  p_user_names TEXT[]
)
RETURNS TABLE(sender TEXT, user_league TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (sm.sender) sm.sender, sm.user_league
  FROM spy_messages sm
  WHERE sm.cast_name = p_cast_name
    AND sm.sender = ANY(p_user_names)
    AND sm.user_league IS NOT NULL
  ORDER BY sm.sender, sm.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
