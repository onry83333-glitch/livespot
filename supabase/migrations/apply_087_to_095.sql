-- ============================================================
-- 統合適用バッチ: Migration 087-095
-- 作成日: 2026-03-01
-- 用途: Supabase SQL Editor でワンショット実行
-- ============================================================
-- 含まれるMigration:
--   087: sessions 重複削除 + 部分UNIQUE制約
--   088: 孤児セッション一括クローズ + close_orphan_sessions RPC
--   089: get_dm_effectiveness_by_segment セグメントJOIN修正
--   090: spy_viewers ゴーストデータ削除 + CHECK制約
--   091: get_weekly_coin_stats RPC（サーバーサイド週次集計）
--   092: get_dm_campaign_cvr 来場CVR追加 + get_user_acquisition_dashboard cast_name修正
--   093: check_spy_data_integrity RPC + spy_viewers UNIQUE NULLS NOT DISTINCT
--   094: calc_churn_risk_score / user_summary / get_session_actions cast_name修正
--   095: 壊れたRPC4関数修正（get_new_users_by_session/get_session_list_v2/get_session_summary_v2/get_transcript_timeline）
--
-- ROLLBACK（逆順で実行）:
--   -- 094
--   DROP FUNCTION IF EXISTS calc_churn_risk_score(UUID, TEXT);
--   DROP FUNCTION IF EXISTS user_summary(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.get_session_actions(UUID, UUID);
--   -- 093
--   DROP FUNCTION IF EXISTS public.check_spy_data_integrity();
--   ALTER TABLE public.spy_viewers DROP CONSTRAINT IF EXISTS spy_viewers_account_id_cast_name_user_name_session_id_key;
--   -- 092
--   DROP FUNCTION IF EXISTS get_dm_campaign_cvr(UUID, TEXT, DATE);
--   DROP INDEX IF EXISTS idx_spy_msg_user;
--   -- 091
--   DROP FUNCTION IF EXISTS get_weekly_coin_stats(UUID, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);
--   -- 090
--   ALTER TABLE public.spy_viewers DROP CONSTRAINT IF EXISTS chk_spy_viewers_user_name;
--   -- 088
--   DROP FUNCTION IF EXISTS close_orphan_sessions(interval);
--   -- 087
--   DROP INDEX IF EXISTS idx_sessions_one_active_per_cast;
-- ============================================================


-- ============================================================
-- 087: sessions 重複セッション削除 + 再発防止UNIQUE制約
-- ============================================================

-- 冪等ガード: インデックスが既に存在する場合はスキップ
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_sessions_one_active_per_cast') THEN
    RAISE NOTICE '087: idx_sessions_one_active_per_cast は適用済み。スキップ';
  ELSE
    -- 重複グループ内の正規セッションを保護リストに
    CREATE TEMP TABLE sessions_to_keep AS
    WITH ranked AS (
      SELECT
        session_id,
        ROW_NUMBER() OVER (
          PARTITION BY cast_name, account_id, date_trunc('minute', started_at)
          ORDER BY
            CASE WHEN total_messages > 0 OR ended_at IS NOT NULL THEN 0 ELSE 1 END,
            started_at ASC
        ) AS rn
      FROM public.sessions
    )
    SELECT session_id FROM ranked WHERE rn = 1;

    DELETE FROM public.sessions
    WHERE session_id NOT IN (SELECT session_id FROM sessions_to_keep);

    DROP TABLE sessions_to_keep;

    CREATE UNIQUE INDEX idx_sessions_one_active_per_cast
      ON public.sessions (cast_name, account_id)
      WHERE ended_at IS NULL;

    RAISE NOTICE '087: 重複セッション削除 + UNIQUE制約追加 完了';
  END IF;
END $$;


-- ============================================================
-- 088: 孤児セッション一括クローズ + RPC
-- ============================================================

-- 24h以上前の未閉鎖セッションをクローズ
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
-- 089: get_dm_effectiveness_by_segment セグメントJOIN修正
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
-- 090: spy_viewers ゴーストデータ削除 + CHECK制約
-- ============================================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE constraint_name = 'chk_spy_viewers_user_name'
             AND table_name = 'spy_viewers') THEN
    RAISE NOTICE '090: chk_spy_viewers_user_name は適用済み。スキップ';
  ELSE
    DELETE FROM public.spy_viewers
    WHERE session_id IS NOT NULL
      AND session_id NOT IN (SELECT session_id::TEXT FROM public.sessions WHERE session_id IS NOT NULL);

    DELETE FROM public.spy_viewers
    WHERE user_name = 'unknown';

    ALTER TABLE public.spy_viewers
      ADD CONSTRAINT chk_spy_viewers_user_name
      CHECK (user_name <> '' AND user_name <> 'unknown');

    RAISE NOTICE '090: spy_viewers ゴーストデータ削除 + CHECK制約追加 完了';
  END IF;
END $$;


-- ============================================================
-- 091: get_weekly_coin_stats RPC
-- ============================================================

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
-- 092: get_dm_campaign_cvr 来場CVR追加 + get_user_acquisition_dashboard cast_name修正
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_spy_msg_user
  ON public.spy_messages(account_id, cast_name, user_name, message_time DESC);

DROP FUNCTION IF EXISTS get_dm_campaign_cvr(UUID, TEXT, DATE);

CREATE OR REPLACE FUNCTION get_dm_campaign_cvr(
  p_account_id UUID DEFAULT NULL,
  p_cast_name TEXT DEFAULT NULL,
  p_since DATE DEFAULT (CURRENT_DATE - INTERVAL '90 days')::date
)
RETURNS TABLE(
  campaign TEXT,
  dm_sent BIGINT,
  paid_after BIGINT,
  visited_after BIGINT,
  cvr_pct NUMERIC,
  visit_cvr_pct NUMERIC,
  total_tokens BIGINT,
  avg_tokens_per_payer NUMERIC,
  first_sent TIMESTAMPTZ,
  last_sent TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH dm AS (
    SELECT DISTINCT ON (dsl.campaign, dsl.user_name)
      dsl.campaign,
      dsl.user_name,
      dsl.queued_at,
      dsl.sent_at,
      dsl.account_id,
      dsl.cast_name
    FROM dm_send_log dsl
    WHERE dsl.queued_at >= p_since
      AND (p_account_id IS NULL OR dsl.account_id = p_account_id)
      AND (p_cast_name  IS NULL OR dsl.cast_name  = p_cast_name)
      AND dsl.campaign IS NOT NULL
      AND dsl.campaign != ''
      AND dsl.status = 'success'
    ORDER BY dsl.campaign, dsl.user_name, dsl.queued_at ASC
  ),
  visit_flags AS (
    SELECT DISTINCT dm.campaign, dm.user_name
    FROM dm
    WHERE EXISTS (
      SELECT 1 FROM spy_messages sm
      WHERE sm.user_name = dm.user_name
        AND sm.message_time > dm.queued_at
        AND sm.account_id = dm.account_id
        AND sm.cast_name  = dm.cast_name
    )
  )
  SELECT
    dm.campaign,
    COUNT(DISTINCT dm.user_name)::BIGINT AS dm_sent,
    COUNT(DISTINCT ct.user_name)::BIGINT AS paid_after,
    COUNT(DISTINCT vf.user_name)::BIGINT AS visited_after,
    ROUND(
      COUNT(DISTINCT ct.user_name)::numeric
      / NULLIF(COUNT(DISTINCT dm.user_name), 0) * 100, 1
    ) AS cvr_pct,
    ROUND(
      COUNT(DISTINCT vf.user_name)::numeric
      / NULLIF(COUNT(DISTINCT dm.user_name), 0) * 100, 1
    ) AS visit_cvr_pct,
    COALESCE(SUM(ct.tokens), 0)::BIGINT AS total_tokens,
    ROUND(
      COALESCE(SUM(ct.tokens), 0)::numeric
      / NULLIF(COUNT(DISTINCT ct.user_name), 0), 0
    ) AS avg_tokens_per_payer,
    MIN(dm.queued_at) AS first_sent,
    MAX(dm.sent_at)   AS last_sent
  FROM dm
  LEFT JOIN coin_transactions ct
    ON  ct.user_name  = dm.user_name
    AND ct.date        > dm.queued_at
    AND (p_account_id IS NULL OR ct.account_id = p_account_id)
    AND (p_cast_name  IS NULL OR ct.cast_name  = p_cast_name)
  LEFT JOIN visit_flags vf
    ON  vf.campaign  = dm.campaign
    AND vf.user_name = dm.user_name
  GROUP BY dm.campaign
  ORDER BY dm_sent DESC, cvr_pct DESC NULLS LAST;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION get_user_acquisition_dashboard(
  p_account_id UUID,
  p_cast_name TEXT,
  p_days INTEGER DEFAULT 30,
  p_min_coins INTEGER DEFAULT 0,
  p_max_coins INTEGER DEFAULT 999999
)
RETURNS TABLE (
  user_name TEXT,
  total_coins BIGINT,
  last_payment_date TIMESTAMPTZ,
  first_seen TIMESTAMPTZ,
  tx_count BIGINT,
  dm_sent BOOLEAN,
  dm_sent_date TIMESTAMPTZ,
  dm_campaign TEXT,
  segment TEXT,
  is_new_user BOOLEAN,
  converted_after_dm BOOLEAN
)
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pu.user_name,
    pu.total_coins::BIGINT,
    pu.last_payment_date,
    pu.created_at AS first_seen,
    COALESCE(ct_agg.tx_count, 0)::BIGINT,
    EXISTS (
      SELECT 1 FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
      AND dm.cast_name = p_cast_name
    ) AS dm_sent,
    (
      SELECT MAX(dm.queued_at) FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
      AND dm.cast_name = p_cast_name
    ) AS dm_sent_date,
    (
      SELECT dm.campaign FROM dm_send_log dm
      WHERE dm.user_name = pu.user_name
      AND dm.account_id = p_account_id
      AND dm.cast_name = p_cast_name
      ORDER BY dm.queued_at DESC LIMIT 1
    ) AS dm_campaign,
    CASE
      WHEN pu.total_coins >= 3500 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S2 Whale準現役'
      WHEN pu.total_coins >= 3500 THEN 'S3 Whale休眠'
      WHEN pu.total_coins >= 1400 AND pu.last_payment_date >= NOW() - INTERVAL '90 days' THEN 'S5 VIP準現役'
      WHEN pu.total_coins >= 1400 THEN 'S6 VIP休眠'
      WHEN pu.total_coins >= 550 THEN 'S8 常連'
      WHEN pu.total_coins >= 200 THEN 'S9 中堅'
      ELSE 'S10 ライト'
    END AS segment,
    (pu.created_at >= NOW() - (p_days || ' days')::INTERVAL) AS is_new_user,
    (
      EXISTS (
        SELECT 1 FROM dm_send_log dm
        WHERE dm.user_name = pu.user_name
        AND dm.account_id = p_account_id
        AND dm.cast_name = p_cast_name
        AND pu.last_payment_date > dm.queued_at
      )
    ) AS converted_after_dm
  FROM paid_users pu
  LEFT JOIN (
    SELECT ct.user_name, COUNT(*) AS tx_count
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id
    AND ct.cast_name = p_cast_name
    AND ct.date >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY ct.user_name
  ) ct_agg ON ct_agg.user_name = pu.user_name
  WHERE pu.cast_name = p_cast_name
  AND pu.total_coins >= p_min_coins
  AND pu.total_coins <= p_max_coins
  AND pu.last_payment_date >= NOW() - (p_days || ' days')::INTERVAL
  AND pu.created_at >= '2026-02-15'::DATE
  ORDER BY pu.total_coins DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- 093: check_spy_data_integrity RPC + spy_viewers UNIQUE NULLS NOT DISTINCT
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_spy_data_integrity()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB := '{}';
  v_row RECORD;
  v_arr JSONB;
BEGIN
  -- 1. spy_viewers: 同一ユーザー×キャストで複数session_id
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      sv.account_id, sv.cast_name, sv.user_name,
      COUNT(DISTINCT sv.session_id) AS distinct_session_ids,
      COUNT(*) AS total_rows,
      array_agg(DISTINCT sv.session_id) AS session_ids
    FROM public.spy_viewers sv
    GROUP BY sv.account_id, sv.cast_name, sv.user_name
    HAVING COUNT(DISTINCT sv.session_id) > 1
    ORDER BY COUNT(DISTINCT sv.session_id) DESC
    LIMIT 50
  ) t;
  v_result := v_result || jsonb_build_object(
    'spy_viewers_multi_session_per_user',
    jsonb_build_object(
      'count', COALESCE(jsonb_array_length(v_arr), 0),
      'description', '同一ユーザー×キャストで複数session_idを持つspy_viewersレコード',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- 2. spy_viewers: session_id NULL の重複
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      sv.account_id, sv.cast_name, sv.user_name,
      COUNT(*) AS dup_count
    FROM public.spy_viewers sv
    WHERE sv.session_id IS NULL
    GROUP BY sv.account_id, sv.cast_name, sv.user_name
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 50
  ) t;
  v_result := v_result || jsonb_build_object(
    'spy_viewers_null_session_duplicates',
    jsonb_build_object(
      'count', COALESCE(jsonb_array_length(v_arr), 0),
      'description', 'session_id=NULLで同一ユーザー×キャストの重複レコード',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- 3. spy_messages: session→cast_name不一致
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      sm.cast_name AS msg_cast_name,
      s.cast_name AS session_cast_name,
      sm.session_id,
      COUNT(*) AS mismatch_count
    FROM public.spy_messages sm
    INNER JOIN public.sessions s ON s.session_id::TEXT = sm.session_id
    WHERE sm.session_id IS NOT NULL
      AND sm.cast_name IS NOT NULL
      AND s.cast_name IS NOT NULL
      AND sm.cast_name != s.cast_name
    GROUP BY sm.cast_name, s.cast_name, sm.session_id
    ORDER BY COUNT(*) DESC
    LIMIT 20
  ) t;
  v_result := v_result || jsonb_build_object(
    'spy_messages_session_cast_mismatch',
    jsonb_build_object(
      'count', COALESCE(jsonb_array_length(v_arr), 0),
      'description', 'spy_messagesのcast_nameとsessionsのcast_nameが不一致',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- 4. spy_viewers: session→cast_name不一致
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      sv.cast_name AS viewer_cast_name,
      s.cast_name AS session_cast_name,
      sv.session_id,
      COUNT(*) AS mismatch_count
    FROM public.spy_viewers sv
    INNER JOIN public.sessions s ON s.session_id::TEXT = sv.session_id
    WHERE sv.session_id IS NOT NULL
      AND sv.cast_name IS NOT NULL
      AND s.cast_name IS NOT NULL
      AND sv.cast_name != s.cast_name
    GROUP BY sv.cast_name, s.cast_name, sv.session_id
    ORDER BY COUNT(*) DESC
    LIMIT 20
  ) t;
  v_result := v_result || jsonb_build_object(
    'spy_viewers_session_cast_mismatch',
    jsonb_build_object(
      'count', COALESCE(jsonb_array_length(v_arr), 0),
      'description', 'spy_viewersのcast_nameとsessionsのcast_nameが不一致',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- 5. sessions: 5分以内の重複セッション
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      s1.cast_name,
      s1.session_id AS session_a, s2.session_id AS session_b,
      s1.started_at AS start_a, s2.started_at AS start_b,
      ABS(EXTRACT(EPOCH FROM (s1.started_at - s2.started_at))) AS diff_seconds
    FROM public.sessions s1
    INNER JOIN public.sessions s2
      ON s1.account_id = s2.account_id
      AND s1.cast_name = s2.cast_name
      AND s1.session_id < s2.session_id
      AND ABS(EXTRACT(EPOCH FROM (s1.started_at - s2.started_at))) < 300
    WHERE s1.started_at > NOW() - INTERVAL '30 days'
    ORDER BY s1.started_at DESC
    LIMIT 30
  ) t;
  v_result := v_result || jsonb_build_object(
    'sessions_duplicate_physical',
    jsonb_build_object(
      'count', COALESCE(jsonb_array_length(v_arr), 0),
      'description', '同一キャストで5分以内に開始した複数セッション',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- 6. viewer_stats: cast_name不正
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      vs.cast_name, COUNT(*) AS row_count,
      MIN(vs.recorded_at) AS first_seen, MAX(vs.recorded_at) AS last_seen
    FROM public.viewer_stats vs
    WHERE vs.cast_name IN ('unknown', '') OR vs.cast_name IS NULL
    GROUP BY vs.cast_name
  ) t;
  v_result := v_result || jsonb_build_object(
    'viewer_stats_unknown_cast',
    jsonb_build_object(
      'count', COALESCE(jsonb_array_length(v_arr), 0),
      'description', 'viewer_statsでcast_nameが空/unknown/NULLのレコード',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- 7. spy_messages: cast_name空
  SELECT COUNT(*)
  INTO v_row
  FROM public.spy_messages
  WHERE cast_name IS NULL OR cast_name = '';

  v_result := v_result || jsonb_build_object(
    'spy_messages_empty_cast_name',
    jsonb_build_object(
      'count', COALESCE(v_row.count, 0),
      'description', 'spy_messagesでcast_nameが空/NULLのレコード数'
    )
  );

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.check_spy_data_integrity()
  IS 'SPYデータ整合性チェック: キャスト間混在・セッション重複・NULLフィルタ検出';

-- spy_viewers UNIQUE制約: NULLS NOT DISTINCT
ALTER TABLE public.spy_viewers
  DROP CONSTRAINT IF EXISTS spy_viewers_account_id_cast_name_user_name_session_id_key;

ALTER TABLE public.spy_viewers
  ADD CONSTRAINT spy_viewers_account_id_cast_name_user_name_session_id_key
  UNIQUE NULLS NOT DISTINCT (account_id, cast_name, user_name, session_id);


-- ============================================================
-- 094: cast_nameフィルタ修正 v3
-- ============================================================

-- 1. calc_churn_risk_score
CREATE OR REPLACE FUNCTION calc_churn_risk_score(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
) RETURNS TABLE(
  user_name TEXT,
  segment TEXT,
  total_coins INTEGER,
  days_since_last_activity INTEGER,
  tip_trend NUMERIC,
  visit_trend NUMERIC,
  churn_risk_score INTEGER
) AS $$
  WITH user_activity AS (
    SELECT
      sm.user_name,
      MAX(sm.message_time) AS last_activity,
      COALESCE(SUM(CASE WHEN sm.message_time > NOW() - INTERVAL '30 days' THEN sm.tokens ELSE 0 END), 0) AS recent_tips,
      COALESCE(SUM(CASE WHEN sm.message_time BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '30 days' THEN sm.tokens ELSE 0 END), 0) AS prev_tips,
      COUNT(DISTINCT CASE WHEN sm.message_time > NOW() - INTERVAL '30 days' THEN sm.message_time::DATE END) AS recent_visits,
      COUNT(DISTINCT CASE WHEN sm.message_time BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '30 days' THEN sm.message_time::DATE END) AS prev_visits
    FROM spy_messages sm
    WHERE sm.account_id = p_account_id
      AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
      AND sm.user_name IS NOT NULL
      AND sm.message_time > NOW() - INTERVAL '90 days'
    GROUP BY sm.user_name
  )
  SELECT
    ua.user_name,
    COALESCE(pu.segment, 'unknown')::TEXT AS segment,
    COALESCE(pu.total_coins, 0) AS total_coins,
    EXTRACT(DAY FROM NOW() - ua.last_activity)::INTEGER AS days_since_last_activity,
    CASE WHEN ua.prev_tips > 0 THEN ROUND(ua.recent_tips::NUMERIC / ua.prev_tips, 2) ELSE 0 END AS tip_trend,
    CASE WHEN ua.prev_visits > 0 THEN ROUND(ua.recent_visits::NUMERIC / ua.prev_visits, 2) ELSE 0 END AS visit_trend,
    LEAST(100, GREATEST(0,
      (CASE WHEN EXTRACT(DAY FROM NOW() - ua.last_activity) > 30 THEN 40
            WHEN EXTRACT(DAY FROM NOW() - ua.last_activity) > 14 THEN 25
            WHEN EXTRACT(DAY FROM NOW() - ua.last_activity) > 7  THEN 10
            ELSE 0 END)
      + (CASE WHEN ua.prev_tips > 0 AND ua.recent_tips::NUMERIC / ua.prev_tips < 0.3 THEN 30
              WHEN ua.prev_tips > 0 AND ua.recent_tips::NUMERIC / ua.prev_tips < 0.6 THEN 15
              ELSE 0 END)
      + (CASE WHEN ua.prev_visits > 0 AND ua.recent_visits::NUMERIC / ua.prev_visits < 0.3 THEN 30
              WHEN ua.prev_visits > 0 AND ua.recent_visits::NUMERIC / ua.prev_visits < 0.5 THEN 15
              ELSE 0 END)
    ))::INTEGER AS churn_risk_score
  FROM user_activity ua
  LEFT JOIN paid_users pu
    ON pu.user_name = ua.user_name
    AND pu.account_id = p_account_id
    AND (p_cast_name IS NULL OR pu.cast_name = p_cast_name)
  WHERE COALESCE(pu.total_coins, 0) >= 10
  ORDER BY churn_risk_score DESC;
$$ LANGUAGE SQL STABLE;

-- 2. user_summary — シグネチャ変更のため DROP → CREATE
DROP FUNCTION IF EXISTS user_summary(UUID);

CREATE OR REPLACE FUNCTION user_summary(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
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
    AND (p_cast_name IS NULL OR sm.cast_name = p_cast_name)
    AND sm.user_name IS NOT NULL
  GROUP BY sm.user_name
  ORDER BY total_tokens DESC;
$$;

-- 3. get_session_actions — dm_send_log に cast_name 条件追加
DROP FUNCTION IF EXISTS public.get_session_actions(UUID, UUID);

CREATE OR REPLACE FUNCTION public.get_session_actions(
  p_account_id UUID,
  p_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cast TEXT;
  v_started TIMESTAMPTZ;
  v_ended TIMESTAMPTZ;
  v_result JSONB;
BEGIN
  SELECT sm.cast_name, MIN(sm.message_time), MAX(sm.message_time)
  INTO v_cast, v_started, v_ended
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.session_id = p_session_id
  GROUP BY sm.cast_name
  LIMIT 1;

  IF v_cast IS NULL THEN
    RETURN jsonb_build_object(
      'first_time_payers', '[]'::JSONB,
      'high_spenders', '[]'::JSONB,
      'visited_no_action', '[]'::JSONB,
      'dm_no_visit', '[]'::JSONB,
      'segment_breakdown', '[]'::JSONB
    );
  END IF;

  WITH
  session_payers AS (
    SELECT sm.user_name, SUM(sm.tokens)::BIGINT AS session_tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = p_session_id
      AND sm.tokens > 0
      AND sm.user_name IS NOT NULL AND sm.user_name != ''
    GROUP BY sm.user_name
  ),
  session_participants AS (
    SELECT DISTINCT sm.user_name
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = p_session_id
      AND sm.user_name IS NOT NULL AND sm.user_name != ''
  ),
  user_history AS (
    SELECT
      sm.user_name,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS total_tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.cast_name = v_cast
      AND sm.user_name IS NOT NULL AND sm.user_name != ''
    GROUP BY sm.user_name
  ),
  first_timers AS (
    SELECT
      sp.user_name, sp.session_tokens,
      EXISTS (
        SELECT 1 FROM public.dm_send_log dl
        WHERE dl.account_id = p_account_id
          AND dl.cast_name = v_cast
          AND dl.user_name = sp.user_name
          AND dl.status = 'success'
          AND dl.sent_at >= v_ended
      ) AS dm_sent
    FROM session_payers sp
    WHERE NOT EXISTS (
      SELECT 1 FROM public.spy_messages sm2
      WHERE sm2.account_id = p_account_id
        AND sm2.cast_name = v_cast
        AND sm2.user_name = sp.user_name
        AND sm2.tokens > 0
        AND sm2.session_id IS NOT NULL
        AND sm2.session_id != p_session_id
        AND sm2.message_time < v_started
    )
  ),
  high_spenders AS (
    SELECT sp.user_name, sp.session_tokens
    FROM session_payers sp
    WHERE sp.session_tokens >= 200
    ORDER BY sp.session_tokens DESC
    LIMIT 10
  ),
  visitors_no_pay AS (
    SELECT sm.user_name
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = p_session_id
      AND sm.user_name IS NOT NULL AND sm.user_name != ''
    GROUP BY sm.user_name
    HAVING COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0) = 0
  ),
  visited_no_action AS (
    SELECT
      vp.user_name,
      CASE
        WHEN COALESCE(uh.total_tokens, 0) >= 5000 THEN 'S1'
        WHEN COALESCE(uh.total_tokens, 0) >= 2000 THEN 'S2'
        WHEN COALESCE(uh.total_tokens, 0) >= 1000 THEN 'S3'
        WHEN COALESCE(uh.total_tokens, 0) >= 500  THEN 'S4'
        WHEN COALESCE(uh.total_tokens, 0) >= 200  THEN 'S5'
        WHEN COALESCE(uh.total_tokens, 0) >= 100  THEN 'S6'
        WHEN COALESCE(uh.total_tokens, 0) >= 50   THEN 'S7'
        WHEN COALESCE(uh.total_tokens, 0) >= 10   THEN 'S8'
        WHEN COALESCE(uh.total_tokens, 0) > 0     THEN 'S9'
        ELSE 'S10'
      END AS segment
    FROM visitors_no_pay vp
    LEFT JOIN user_history uh ON uh.user_name = vp.user_name
  ),
  dm_sent_recent AS (
    SELECT DISTINCT ON (dl.user_name)
      dl.user_name, dl.sent_at AS dm_sent_at
    FROM public.dm_send_log dl
    WHERE dl.account_id = p_account_id
      AND dl.cast_name = v_cast
      AND dl.status = 'success'
      AND dl.sent_at >= v_started - INTERVAL '7 days'
      AND dl.sent_at < v_started
    ORDER BY dl.user_name, dl.sent_at DESC
  ),
  dm_no_visit AS (
    SELECT
      dsr.user_name,
      CASE
        WHEN COALESCE(uh.total_tokens, 0) >= 5000 THEN 'S1'
        WHEN COALESCE(uh.total_tokens, 0) >= 2000 THEN 'S2'
        WHEN COALESCE(uh.total_tokens, 0) >= 1000 THEN 'S3'
        WHEN COALESCE(uh.total_tokens, 0) >= 500  THEN 'S4'
        WHEN COALESCE(uh.total_tokens, 0) >= 200  THEN 'S5'
        WHEN COALESCE(uh.total_tokens, 0) >= 100  THEN 'S6'
        WHEN COALESCE(uh.total_tokens, 0) >= 50   THEN 'S7'
        WHEN COALESCE(uh.total_tokens, 0) >= 10   THEN 'S8'
        WHEN COALESCE(uh.total_tokens, 0) > 0     THEN 'S9'
        ELSE 'S10'
      END AS segment,
      dsr.dm_sent_at
    FROM dm_sent_recent dsr
    LEFT JOIN user_history uh ON uh.user_name = dsr.user_name
    WHERE NOT EXISTS (
      SELECT 1 FROM session_participants sp
      WHERE sp.user_name = dsr.user_name
    )
  ),
  segment_data AS (
    SELECT
      dsr.user_name,
      CASE
        WHEN COALESCE(uh.total_tokens, 0) >= 5000 THEN 'S1'
        WHEN COALESCE(uh.total_tokens, 0) >= 2000 THEN 'S2'
        WHEN COALESCE(uh.total_tokens, 0) >= 1000 THEN 'S3'
        WHEN COALESCE(uh.total_tokens, 0) >= 500  THEN 'S4'
        WHEN COALESCE(uh.total_tokens, 0) >= 200  THEN 'S5'
        WHEN COALESCE(uh.total_tokens, 0) >= 100  THEN 'S6'
        WHEN COALESCE(uh.total_tokens, 0) >= 50   THEN 'S7'
        WHEN COALESCE(uh.total_tokens, 0) >= 10   THEN 'S8'
        WHEN COALESCE(uh.total_tokens, 0) > 0     THEN 'S9'
        ELSE 'S10'
      END AS segment,
      (sp2.user_name IS NOT NULL) AS visited,
      (COALESCE(pay.session_tokens, 0) > 0) AS paid
    FROM dm_sent_recent dsr
    LEFT JOIN user_history uh ON uh.user_name = dsr.user_name
    LEFT JOIN session_participants sp2 ON sp2.user_name = dsr.user_name
    LEFT JOIN session_payers pay ON pay.user_name = dsr.user_name
  ),
  segment_breakdown AS (
    SELECT
      sd.segment,
      COUNT(*)::INTEGER AS dm_sent,
      COUNT(*) FILTER (WHERE sd.visited)::INTEGER AS visited,
      COUNT(*) FILTER (WHERE sd.paid)::INTEGER AS paid
    FROM segment_data sd
    GROUP BY sd.segment
    ORDER BY sd.segment
  )

  SELECT jsonb_build_object(
    'first_time_payers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user_name', ft.user_name,
        'session_tokens', ft.session_tokens,
        'dm_sent', ft.dm_sent
      ) ORDER BY ft.session_tokens DESC)
      FROM first_timers ft
    ), '[]'::JSONB),
    'high_spenders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user_name', hs.user_name,
        'session_tokens', hs.session_tokens
      ) ORDER BY hs.session_tokens DESC)
      FROM high_spenders hs
    ), '[]'::JSONB),
    'visited_no_action', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user_name', vna.user_name,
        'segment', vna.segment
      ))
      FROM visited_no_action vna
    ), '[]'::JSONB),
    'dm_no_visit', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'user_name', dnv.user_name,
        'segment', dnv.segment,
        'dm_sent_at', dnv.dm_sent_at
      ))
      FROM dm_no_visit dnv
    ), '[]'::JSONB),
    'segment_breakdown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'segment', sb.segment,
        'dm_sent', sb.dm_sent,
        'visited', sb.visited,
        'paid', sb.paid
      ) ORDER BY sb.segment)
      FROM segment_breakdown sb
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;


-- ============================================================
-- 095: 壊れたRPC 4関数の修正（再デプロイ）
-- ============================================================

-- 1. get_new_users_by_session（ct.username typo修正）
DROP FUNCTION IF EXISTS public.get_new_users_by_session(UUID, TEXT, DATE);

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

-- 2. get_session_list_v2（戻り値型修正）
DROP FUNCTION IF EXISTS public.get_session_list_v2(UUID, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.get_session_list_v2(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  broadcast_group_id TEXT,
  session_ids TEXT[],
  cast_name TEXT,
  session_title TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC,
  msg_count BIGINT,
  unique_users BIGINT,
  chat_tokens BIGINT,
  tip_count BIGINT,
  coin_tokens BIGINT,
  coin_tip_tokens BIGINT,
  coin_private_tokens BIGINT,
  coin_ticket_tokens BIGINT,
  coin_group_tokens BIGINT,
  coin_spy_tokens BIGINT,
  coin_other_tokens BIGINT,
  total_revenue BIGINT,
  is_active BOOLEAN,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH
  raw_sessions AS (
    SELECT sm.session_id AS sid, sm.cast_name AS cn,
      MAX(sm.session_title) AS stitle, MIN(sm.message_time) AS s_start, MAX(sm.message_time) AS s_end,
      COUNT(*) AS s_msg_count,
      COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.user_name IS NOT NULL AND sm.user_name != '') AS s_unique_users,
      COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS s_chat_tokens,
      COUNT(*) FILTER (WHERE sm.tokens > 0) AS s_tip_count
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id AND sm.cast_name = p_cast_name AND sm.session_id IS NOT NULL
    GROUP BY sm.session_id, sm.cast_name
  ),
  with_gap AS (SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs),
  with_group AS (
    SELECT wg.*, SUM(CASE WHEN wg.prev_end IS NULL THEN 1 WHEN EXTRACT(EPOCH FROM (wg.s_start - wg.prev_end)) > 1800 THEN 1 ELSE 0 END) OVER (ORDER BY wg.s_start) AS grp_num
    FROM with_gap wg
  ),
  broadcast_groups AS (
    SELECT g.grp_num, g.cn,
      (ARRAY_AGG(g.stitle ORDER BY g.s_msg_count DESC NULLS LAST))[1] AS bg_title,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_session_ids,
      MIN(g.s_start) AS bg_start, MAX(g.s_end) AS bg_end,
      SUM(g.s_msg_count)::BIGINT AS bg_msg_count, SUM(g.s_tip_count)::BIGINT AS bg_tip_count,
      SUM(g.s_chat_tokens)::BIGINT AS bg_chat_tokens
    FROM with_group g GROUP BY g.grp_num, g.cn
  ),
  bg_unique_users AS (
    SELECT bg.grp_num, COUNT(DISTINCT sm.user_name) FILTER (WHERE sm.user_name IS NOT NULL AND sm.user_name != '') AS bg_unique
    FROM broadcast_groups bg
    JOIN public.spy_messages sm ON sm.account_id = p_account_id AND sm.cast_name = p_cast_name AND sm.session_id = ANY(bg.bg_session_ids)
    GROUP BY bg.grp_num
  ),
  bg_count AS (SELECT COUNT(*)::BIGINT AS cnt FROM broadcast_groups),
  paged_bg AS (SELECT bg.* FROM broadcast_groups bg ORDER BY bg.bg_start DESC LIMIT p_limit OFFSET p_offset),
  coin_match AS (
    SELECT pbg.grp_num,
      COALESCE(SUM(ct.tokens), 0)::BIGINT AS c_total,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'tip'), 0)::BIGINT AS c_tip,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'private'), 0)::BIGINT AS c_private,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'ticket'), 0)::BIGINT AS c_ticket,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'group'), 0)::BIGINT AS c_group,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type = 'spy'), 0)::BIGINT AS c_spy,
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type NOT IN ('tip', 'private', 'ticket', 'group', 'spy')), 0)::BIGINT AS c_other
    FROM paged_bg pbg
    LEFT JOIN public.coin_transactions ct ON ct.account_id = p_account_id AND (ct.cast_name = p_cast_name OR ct.cast_name IS NULL) AND ct.tokens > 0
      AND ct.date >= pbg.bg_start - INTERVAL '5 minutes' AND ct.date <= pbg.bg_end + INTERVAL '30 minutes'
    GROUP BY pbg.grp_num
  )
  SELECT pbg.bg_session_ids[1], pbg.bg_session_ids, pbg.cn, pbg.bg_title,
    pbg.bg_start, pbg.bg_end,
    ROUND(EXTRACT(EPOCH FROM (pbg.bg_end - pbg.bg_start)) / 60, 1),
    pbg.bg_msg_count, COALESCE(buu.bg_unique, 0)::BIGINT, pbg.bg_chat_tokens, pbg.bg_tip_count,
    COALESCE(cm.c_total, 0)::BIGINT, COALESCE(cm.c_tip, 0)::BIGINT, COALESCE(cm.c_private, 0)::BIGINT,
    COALESCE(cm.c_ticket, 0)::BIGINT, COALESCE(cm.c_group, 0)::BIGINT, COALESCE(cm.c_spy, 0)::BIGINT,
    COALESCE(cm.c_other, 0)::BIGINT,
    GREATEST(pbg.bg_chat_tokens, COALESCE(cm.c_total, 0))::BIGINT,
    (pbg.bg_end > NOW() - INTERVAL '10 minutes'),
    (SELECT cnt FROM bg_count)
  FROM paged_bg pbg
  LEFT JOIN bg_unique_users buu ON buu.grp_num = pbg.grp_num
  LEFT JOIN coin_match cm ON cm.grp_num = pbg.grp_num
  ORDER BY pbg.bg_start DESC;
END;
$$;

-- 3. get_session_summary_v2 は 053 の正しいバージョンをそのまま再デプロイ（上記094セクションでDROP済み不要、ここでDROP+CREATE）
-- ※ この関数は長大なため、095_fix_broken_rpcs.sql を参照

-- 4. get_transcript_timeline は 055 の正しいバージョンをそのまま再デプロイ
-- ※ この関数は095_fix_broken_rpcs.sql を参照

-- 注意: get_session_summary_v2 と get_transcript_timeline は 095_fix_broken_rpcs.sql に完全版があります。
-- このバッチでは上記2関数（get_new_users_by_session, get_session_list_v2）を適用し、
-- 残り2関数は 095_fix_broken_rpcs.sql を別途実行してください。
-- もしくは apply_087_to_095.sql の代わりに 095_fix_broken_rpcs.sql を単体実行すれば全4関数が修正されます。


-- ============================================================
-- PostgREST スキーマキャッシュリロード
-- ============================================================
NOTIFY pgrst, 'reload schema';
