-- ============================================================
-- 051: get_session_actions RPC — 配信後アクション提案
-- 根本: spy_messages + dm_send_log から導出
-- spy_sessions, spy_logs は存在しない — 参照禁止
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
  first_timers AS (
    SELECT
      sp.user_name,
      sp.session_tokens,
      EXISTS (
        SELECT 1 FROM public.dm_send_log dl
        WHERE dl.account_id = p_account_id
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

-- ============================================================
-- 使用例:
-- SELECT get_session_actions('account-uuid', 'session-uuid');
-- ============================================================
