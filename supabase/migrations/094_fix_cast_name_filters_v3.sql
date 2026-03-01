-- ============================================================
-- 094: cast_nameフィルタ欠落修正 v3
-- 対象: calc_churn_risk_score / user_summary / get_session_actions
-- ============================================================
-- ROLLBACK手順:
--   DROP FUNCTION IF EXISTS calc_churn_risk_score(UUID, TEXT);
--   DROP FUNCTION IF EXISTS user_summary(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.get_session_actions(UUID, UUID);
--   -- その後、068_scoring_engine.sql / 003_refresh_mv_and_user_summary_rpc.sql / 051_get_session_actions.sql を再適用
-- ============================================================

-- ============================================================
-- 1. calc_churn_risk_score — paid_users JOINにcast_name条件追加
--    旧: pu.account_id = p_account_id のみ
--    新: + (p_cast_name IS NULL OR pu.cast_name = p_cast_name)
-- ============================================================
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

-- ============================================================
-- 2. user_summary — cast_name引数を追加
--    旧: (p_account_id UUID) のみ
--    新: (p_account_id UUID, p_cast_name TEXT DEFAULT NULL)
--    ※ 引数追加 = シグネチャ変更のため DROP → CREATE
-- ============================================================
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

-- ============================================================
-- 3. get_session_actions — first_timers CTE の dm_send_log に cast_name 追加
--    旧: dl.account_id + dl.user_name + dl.status + dl.sent_at のみ
--    新: + dl.cast_name = v_cast
-- ============================================================
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
  -- セッション情報を spy_messages から取得
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
  -- ① このセッションで課金したユーザー
  session_payers AS (
    SELECT
      sm.user_name,
      SUM(sm.tokens)::BIGINT AS session_tokens
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = p_session_id
      AND sm.tokens > 0
      AND sm.user_name IS NOT NULL AND sm.user_name != ''
    GROUP BY sm.user_name
  ),

  -- ② このセッションの全参加者
  session_participants AS (
    SELECT DISTINCT sm.user_name
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.session_id = p_session_id
      AND sm.user_name IS NOT NULL AND sm.user_name != ''
  ),

  -- ③ ユーザー別の過去累計tokens（セグメント計算用）
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

  -- ④ 初課金ユーザー（このセッションが初課金）
  --    ★修正: dm_send_log に cast_name 条件追加
  first_timers AS (
    SELECT
      sp.user_name,
      sp.session_tokens,
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

  -- ⑤ 高額課金（200tk以上、上位10名）
  high_spenders AS (
    SELECT sp.user_name, sp.session_tokens
    FROM session_payers sp
    WHERE sp.session_tokens >= 200
    ORDER BY sp.session_tokens DESC
    LIMIT 10
  ),

  -- ⑥ 来訪したがアクションなし（tokens=0）
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

  -- ⑦ DM送信→未来訪（7日以内に送信、セッション不参加）
  dm_sent_recent AS (
    SELECT DISTINCT ON (dl.user_name)
      dl.user_name,
      dl.sent_at AS dm_sent_at
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

  -- ⑧ セグメント別ブレイクダウン（DM送信者ベース）
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

  -- 結果のJSONBを組み立て
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
