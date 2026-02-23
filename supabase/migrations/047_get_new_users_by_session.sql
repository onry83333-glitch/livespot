-- ============================================================
-- 047: get_new_users_by_session RPC
-- 「指定日に初めて課金したユーザー」を正確に判定する
-- 既存の detect_new_paying_users は synced_at ベースで不正確
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_new_users_by_session(
  p_account_id UUID,
  p_cast_name TEXT,
  p_session_date DATE
)
RETURNS TABLE (
  user_name TEXT,
  total_tokens_on_date BIGINT,
  transaction_count INTEGER,
  types TEXT[],
  has_prior_history BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.user_name,
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tokens_on_date,
    COUNT(*)::INTEGER AS transaction_count,
    ARRAY_AGG(DISTINCT ct.type) AS types,
    -- 過去履歴あり = この日より前に同キャストでトランザクションがある
    EXISTS (
      SELECT 1 FROM public.coin_transactions older
      WHERE older.account_id = p_account_id
        AND older.cast_name = p_cast_name
        AND older.user_name = ct.user_name
        AND older.date::date < p_session_date
    ) AS has_prior_history
  FROM public.coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.date::date = p_session_date
    AND ct.tokens > 0
  GROUP BY ct.user_name
  ORDER BY total_tokens_on_date DESC;
END;
$$;

-- ============================================================
-- 使用例:
-- SELECT * FROM get_new_users_by_session(
--   'your-account-id',
--   'Risa_06',
--   '2026-02-22'
-- ) WHERE has_prior_history = false;
--
-- has_prior_history = false のユーザーが「真の新規」
-- has_prior_history = true のユーザーはリピーター
-- ============================================================
