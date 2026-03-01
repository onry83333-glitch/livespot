-- ============================================================
-- 093: SPY データ整合性チェック RPC
-- spy_messages / spy_viewers のキャスト間データ混在を検出
-- ============================================================
-- ROLLBACK: DROP FUNCTION IF EXISTS public.check_spy_data_integrity();

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
  -- ============================================================
  -- 1. spy_viewers: 同一ユーザー×キャストで複数session_idを持つレコード
  --    → Collector(SHA256) と Chrome(randomUUID) の二重書き込みを検出
  -- ============================================================
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      sv.account_id,
      sv.cast_name,
      sv.user_name,
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
      'description', '同一ユーザー×キャストで複数session_idを持つspy_viewersレコード（Collector/Chrome二重書き込みの可能性）',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- ============================================================
  -- 2. spy_viewers: session_id NULL の重複
  --    → PostgreSQL UNIQUE制約がNULLを区別しないため発生
  -- ============================================================
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      sv.account_id,
      sv.cast_name,
      sv.user_name,
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

  -- ============================================================
  -- 3. spy_messages: session_idが指すsessionsのcast_nameと不一致
  --    → セッション作成時のcast_name誤りを検出
  -- ============================================================
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

  -- ============================================================
  -- 4. spy_viewers: session_idが指すsessionsのcast_nameと不一致
  -- ============================================================
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

  -- ============================================================
  -- 5. sessions: 同一cast_nameで重複session_id（物理的に同じ配信）
  --    → Collector vs Chrome の同時session作成を検出
  -- ============================================================
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      s1.cast_name,
      s1.session_id AS session_a,
      s2.session_id AS session_b,
      s1.started_at AS start_a,
      s2.started_at AS start_b,
      ABS(EXTRACT(EPOCH FROM (s1.started_at - s2.started_at))) AS diff_seconds
    FROM public.sessions s1
    INNER JOIN public.sessions s2
      ON s1.account_id = s2.account_id
      AND s1.cast_name = s2.cast_name
      AND s1.session_id < s2.session_id
      -- 5分以内に開始した別session_id = 重複の可能性
      AND ABS(EXTRACT(EPOCH FROM (s1.started_at - s2.started_at))) < 300
    WHERE s1.started_at > NOW() - INTERVAL '30 days'
    ORDER BY s1.started_at DESC
    LIMIT 30
  ) t;
  v_result := v_result || jsonb_build_object(
    'sessions_duplicate_physical',
    jsonb_build_object(
      'count', COALESCE(jsonb_array_length(v_arr), 0),
      'description', '同一キャストで5分以内に開始した複数セッション（Collector/Chrome重複作成の可能性）',
      'sample', COALESCE(v_arr, '[]'::jsonb)
    )
  );

  -- ============================================================
  -- 6. viewer_stats: cast_name='unknown' のレコード
  --    → last_cast_name フォールバックで混入した可能性
  -- ============================================================
  SELECT jsonb_agg(row_to_json(t))
  INTO v_arr
  FROM (
    SELECT
      vs.cast_name,
      COUNT(*) AS row_count,
      MIN(vs.recorded_at) AS first_seen,
      MAX(vs.recorded_at) AS last_seen
    FROM public.viewer_stats vs
    WHERE vs.cast_name IN ('unknown', '')
       OR vs.cast_name IS NULL
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

  -- ============================================================
  -- 7. spy_messages: cast_nameが空文字のレコード
  -- ============================================================
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

-- ============================================================
-- spy_viewers UNIQUE制約: NULLS NOT DISTINCT 追加
-- PostgreSQL 15+ で NULL同士もUNIQUE違反とする
-- ============================================================
-- 既存制約を削除して再作成
ALTER TABLE public.spy_viewers
  DROP CONSTRAINT IF EXISTS spy_viewers_account_id_cast_name_user_name_session_id_key;

ALTER TABLE public.spy_viewers
  ADD CONSTRAINT spy_viewers_account_id_cast_name_user_name_session_id_key
  UNIQUE NULLS NOT DISTINCT (account_id, cast_name, user_name, session_id);
