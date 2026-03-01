-- ============================================================
-- 一括適用: Migration 087〜091
-- 適用先: Supabase SQL Editor
-- 日時: 2026-03-01
-- ============================================================

-- ============================================================
-- 087: sessions 重複セッション削除 + 再発防止UNIQUE制約
-- ============================================================

-- ステップ1: 保護リスト作成
CREATE TEMP TABLE sessions_to_keep AS
WITH ranked AS (
  SELECT
    session_id,
    cast_name,
    account_id,
    started_at,
    ended_at,
    total_messages,
    ROW_NUMBER() OVER (
      PARTITION BY cast_name, account_id, date_trunc('minute', started_at)
      ORDER BY
        CASE WHEN total_messages > 0 OR ended_at IS NOT NULL THEN 0 ELSE 1 END,
        started_at ASC
    ) AS rn
  FROM public.sessions
)
SELECT session_id FROM ranked WHERE rn = 1;

-- ステップ2: 保護リスト以外を削除
DELETE FROM public.sessions
WHERE session_id NOT IN (SELECT session_id FROM sessions_to_keep);

DROP TABLE sessions_to_keep;

-- ステップ3: 部分ユニーク制約（既に存在する場合はスキップ）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_sessions_one_active_per_cast'
  ) THEN
    CREATE UNIQUE INDEX idx_sessions_one_active_per_cast
      ON public.sessions (cast_name, account_id)
      WHERE ended_at IS NULL;
  END IF;
END $$;

-- ============================================================
-- 088: 孤児セッション一括クローズ + close_orphan_sessions RPC
-- ============================================================

-- Step 1: 24時間以上前の未閉鎖セッションをクローズ
WITH orphans AS (
  SELECT session_id, started_at
  FROM sessions
  WHERE ended_at IS NULL
    AND started_at < NOW() - INTERVAL '24 hours'
)
UPDATE sessions s
SET ended_at = o.started_at + INTERVAL '4 hours'
FROM orphans o
WHERE s.session_id = o.session_id;

-- Step 2: RPC作成
CREATE OR REPLACE FUNCTION close_orphan_sessions(
  p_stale_threshold INTERVAL DEFAULT INTERVAL '6 hours'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_closed INTEGER;
BEGIN
  WITH orphans AS (
    SELECT session_id, started_at
    FROM sessions
    WHERE ended_at IS NULL
      AND started_at < NOW() - p_stale_threshold
  )
  UPDATE sessions s
  SET ended_at = o.started_at + INTERVAL '4 hours'
  FROM orphans o
  WHERE s.session_id = o.session_id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$$;

-- ============================================================
-- 089: get_dm_effectiveness_by_segment のセグメントJOIN修正
-- ============================================================

CREATE OR REPLACE FUNCTION get_dm_effectiveness_by_segment(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  campaign TEXT,
  segment TEXT,
  sent_count BIGINT,
  visited_count BIGINT,
  paid_count BIGINT,
  visit_cvr NUMERIC,
  payment_cvr NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_payer NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH dm_sent AS (
    SELECT
      d.user_name,
      d.campaign,
      d.cast_name,
      d.sent_at
    FROM dm_send_log d
    WHERE d.account_id = p_account_id
      AND d.status = 'success'
      AND d.sent_at >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR d.cast_name = p_cast_name)
  ),
  dm_with_segment AS (
    SELECT
      ds.user_name,
      ds.campaign,
      ds.cast_name,
      ds.sent_at,
      COALESCE(pu.segment, 'unknown') AS user_segment
    FROM dm_sent ds
    LEFT JOIN paid_users pu
      ON pu.account_id = p_account_id
      AND pu.user_name = ds.user_name
  ),
  visit_check AS (
    SELECT DISTINCT
      dws.user_name,
      dws.campaign,
      dws.user_segment
    FROM dm_with_segment dws
    WHERE EXISTS (
      SELECT 1 FROM spy_messages sm
      WHERE sm.account_id = p_account_id
        AND sm.user_name = dws.user_name
        AND sm.cast_name = dws.cast_name
        AND sm.message_time BETWEEN dws.sent_at AND dws.sent_at + INTERVAL '24 hours'
    )
  ),
  payment_check AS (
    SELECT DISTINCT
      dws.user_name,
      dws.campaign,
      dws.user_segment,
      ct_sum.total_tk
    FROM dm_with_segment dws
    INNER JOIN LATERAL (
      SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tk
      FROM coin_transactions ct
      WHERE ct.account_id = p_account_id
        AND ct.user_name = dws.user_name
        AND ct.cast_name = dws.cast_name
        AND ct.date BETWEEN dws.sent_at AND dws.sent_at + INTERVAL '48 hours'
    ) ct_sum ON ct_sum.total_tk > 0
  )
  SELECT
    dws.campaign,
    dws.user_segment AS segment,
    COUNT(DISTINCT dws.user_name)::BIGINT AS sent_count,
    COUNT(DISTINCT vc.user_name)::BIGINT AS visited_count,
    COUNT(DISTINCT pc.user_name)::BIGINT AS paid_count,
    ROUND(
      COUNT(DISTINCT vc.user_name) * 100.0 / NULLIF(COUNT(DISTINCT dws.user_name), 0),
      1
    ) AS visit_cvr,
    ROUND(
      COUNT(DISTINCT pc.user_name) * 100.0 / NULLIF(COUNT(DISTINCT dws.user_name), 0),
      1
    ) AS payment_cvr,
    COALESCE(SUM(pc.total_tk), 0)::BIGINT AS total_tokens,
    ROUND(
      COALESCE(SUM(pc.total_tk), 0)::NUMERIC / NULLIF(COUNT(DISTINCT pc.user_name), 0),
      0
    ) AS avg_tokens_per_payer
  FROM dm_with_segment dws
  LEFT JOIN visit_check vc
    ON vc.user_name = dws.user_name
    AND vc.campaign = dws.campaign
    AND vc.user_segment = dws.user_segment
  LEFT JOIN payment_check pc
    ON pc.user_name = dws.user_name
    AND pc.campaign = dws.campaign
    AND pc.user_segment = dws.user_segment
  GROUP BY dws.campaign, dws.user_segment
  ORDER BY COUNT(DISTINCT dws.user_name) DESC, dws.campaign;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 090: spy_viewers ゴーストデータクリーンアップ
-- ============================================================

-- 1. 存在しないsession_idのspy_viewersを削除
DELETE FROM public.spy_viewers
WHERE session_id IS NOT NULL
  AND session_id NOT IN (SELECT session_id FROM public.sessions WHERE session_id IS NOT NULL);

-- 2. user_name='unknown' を削除
DELETE FROM public.spy_viewers
WHERE user_name = 'unknown';

-- 3. NOT NULL制約追加（既に存在する場合はスキップ）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chk_spy_viewers_user_name'
      AND table_name = 'spy_viewers'
  ) THEN
    ALTER TABLE public.spy_viewers
      ADD CONSTRAINT chk_spy_viewers_user_name
      CHECK (user_name <> '' AND user_name <> 'unknown');
  END IF;
END $$;

-- ============================================================
-- 091: get_weekly_coin_stats RPC — 週次コイン集計
-- ============================================================

-- 旧BIGINT版が存在する場合は先にDROP（戻り値型変更にはDROP必須）
DROP FUNCTION IF EXISTS get_weekly_coin_stats(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION get_weekly_coin_stats(
  p_account_id UUID,
  p_cast_names TEXT[],
  p_this_week_start TIMESTAMPTZ,
  p_last_week_start TIMESTAMPTZ,
  p_today_start TIMESTAMPTZ
)
RETURNS TABLE(
  cast_name TEXT,
  this_week INTEGER,
  last_week INTEGER,
  today INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ct.cast_name,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_this_week_start), 0)::INTEGER AS this_week,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_last_week_start AND ct.date < p_this_week_start), 0)::INTEGER AS last_week,
    COALESCE(SUM(ct.tokens) FILTER (WHERE ct.date >= p_today_start), 0)::INTEGER AS today
  FROM coin_transactions ct
  WHERE ct.account_id = p_account_id
    AND ct.cast_name = ANY(p_cast_names)
    AND ct.date >= p_last_week_start
    AND ct.tokens > 0
  GROUP BY ct.cast_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- スキーマキャッシュリロード
-- ============================================================
NOTIFY pgrst, 'reload schema';
