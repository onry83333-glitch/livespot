-- ============================================================
-- 091: get_weekly_coin_stats RPC — 週次コイン集計（サーバーサイド）
--
-- 問題: フロントエンドのcoin_transactions全件取得+クライアント集計が
--       PostgREST max_rows=1000 に衝突し、2,514件中1,000件しか返らず
--       Risa_06の週次コイン=0tkと表示される
--
-- 解決: サーバーサイドでSUM/GROUP BY集計。月曜03:00 JST区切り対応
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_weekly_coin_stats(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);
-- ============================================================

CREATE OR REPLACE FUNCTION get_weekly_coin_stats(
  p_account_id UUID,
  p_cast_names TEXT[],
  p_this_week_start TIMESTAMPTZ,
  p_last_week_start TIMESTAMPTZ,
  p_today_start TIMESTAMPTZ
)
RETURNS TABLE(
  cast_name TEXT,
  this_week BIGINT,
  last_week BIGINT,
  today BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.cast_name,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_this_week_start), 0)::BIGINT AS this_week,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_last_week_start AND ct.date < p_this_week_start), 0)::BIGINT AS last_week,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_today_start), 0)::BIGINT AS today
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = ANY(p_cast_names)
    AND ct.date >= p_last_week_start
    AND ct.tokens > 0
  GROUP BY ct.cast_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
