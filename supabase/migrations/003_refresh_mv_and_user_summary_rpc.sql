-- ============================================================
-- 003: paying_users MV リフレッシュ + ユーザーサマリーRPC関数
-- Supabase SQL Editor で実行してください
-- ============================================================

-- ============================================================
-- 1. paying_users マテリアライズドビュー即時リフレッシュ
-- ============================================================
REFRESH MATERIALIZED VIEW paying_users;

-- ============================================================
-- 2. pg_cron で paying_users を毎時自動リフレッシュ（要 pg_cron 拡張）
--    Supabase Dashboard > Database > Extensions > pg_cron を有効化してから実行
-- ============================================================
-- SELECT cron.schedule(
--   'refresh-paying-users',
--   '0 * * * *',  -- 毎時0分
--   $$REFRESH MATERIALIZED VIEW paying_users$$
-- );

-- ============================================================
-- 3. ユーザーサマリーRPC関数（users/page.tsx 最適化用）
--    spy_messages を GROUP BY で集計し、クライアント全件取得を回避
-- ============================================================
CREATE OR REPLACE FUNCTION user_summary(p_account_id UUID)
RETURNS TABLE (
  user_name TEXT,
  message_count BIGINT,
  total_tokens BIGINT,
  last_activity TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    sm.user_name,
    COUNT(*)::BIGINT AS message_count,
    COALESCE(SUM(sm.tokens), 0)::BIGINT AS total_tokens,
    MAX(sm.message_time) AS last_activity
  FROM spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.user_name IS NOT NULL
  GROUP BY sm.user_name
  ORDER BY total_tokens DESC;
$$;

-- RLSバイパスのため SECURITY DEFINER を使用
-- フロントエンドからの呼び出し:
--   supabase.rpc('user_summary', { p_account_id: accountId })
