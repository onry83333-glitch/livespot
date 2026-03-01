-- ============================================================
-- Migration 100: v2テーブル切り替え
-- spy_messages/spy_viewers/paid_users → chat_logs/viewer_snapshots/user_profiles
--
-- 変更点:
-- 1. 同期トリガー: spy_messages→chat_logs, paid_users→user_profiles
-- 2. ギャップ埋め: Migration 099以降のデータを同期
-- 3. 全RPCを新テーブル参照に書き換え
--
-- カラム対応:
--   spy_messages.user_name     → chat_logs.username
--   spy_messages.msg_type      → chat_logs.message_type
--   spy_messages.message_time  → chat_logs.timestamp
--   spy_messages.session_title → sessions.broadcast_title (JOIN)
--   spy_messages.is_vip        → chat_logs.metadata->>'is_vip'
--   paid_users.user_name       → user_profiles.username
--   paid_users.total_coins     → user_profiles.total_tokens
--   paid_users.last_payment_date → user_profiles.last_seen
--   paid_users.created_at      → user_profiles.first_seen
--   paid_users.tx_count        → user_profiles.visit_count
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_sync_spy_to_chat_logs ON public.spy_messages;
--   DROP TRIGGER IF EXISTS trg_sync_paid_to_user_profiles ON public.paid_users;
--   DROP FUNCTION IF EXISTS public.sync_spy_messages_to_chat_logs();
--   DROP FUNCTION IF EXISTS public.sync_paid_users_to_user_profiles();
--   -- Then re-apply original RPCs from migrations 005, 010, 016, 026, 058, 065, 097
-- ============================================================

-- ############################################################
-- Section 0: 同期トリガー
-- ############################################################

-- 0-1. spy_messages → chat_logs 同期トリガー
CREATE OR REPLACE FUNCTION public.sync_spy_messages_to_chat_logs()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.chat_logs (
    cast_name, account_id, session_id, username, message,
    message_type, tokens, "timestamp", metadata, created_at
  )
  VALUES (
    NEW.cast_name,
    NEW.account_id,
    -- FK安全: sessionsに存在するsession_idのみ設定
    CASE WHEN NEW.session_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.sessions s WHERE s.session_id = NEW.session_id)
         THEN NEW.session_id ELSE NULL END,
    NEW.user_name,
    COALESCE(NEW.message, ''),
    LOWER(COALESCE(NEW.msg_type, 'chat')),
    GREATEST(COALESCE(NEW.tokens, 0), 0),
    NEW.message_time,
    JSONB_BUILD_OBJECT(
      'is_vip', COALESCE(NEW.is_vip, false),
      'user_color', NEW.user_color,
      'user_league', NEW.user_league,
      'user_level', NEW.user_level
    ) || COALESCE(NEW.metadata, '{}'::JSONB),
    COALESCE(NEW.created_at, NOW())
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- トリガーエラーで元テーブルのINSERTを止めない
  RAISE WARNING 'sync_spy_messages_to_chat_logs failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- spy_messagesにuser_color/user_league/user_levelカラムが存在するか確認
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'spy_messages' AND column_name = 'user_color') THEN
    -- カラムが無い場合はシンプル版トリガーに差し替え
    CREATE OR REPLACE FUNCTION public.sync_spy_messages_to_chat_logs()
    RETURNS TRIGGER LANGUAGE plpgsql AS $t$
    BEGIN
      INSERT INTO public.chat_logs (
        cast_name, account_id, session_id, username, message,
        message_type, tokens, "timestamp", metadata, created_at
      ) VALUES (
        NEW.cast_name, NEW.account_id,
        CASE WHEN NEW.session_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM public.sessions s WHERE s.session_id = NEW.session_id)
             THEN NEW.session_id ELSE NULL END,
        NEW.user_name, COALESCE(NEW.message, ''),
        LOWER(COALESCE(NEW.msg_type, 'chat')),
        GREATEST(COALESCE(NEW.tokens, 0), 0),
        NEW.message_time,
        JSONB_BUILD_OBJECT('is_vip', COALESCE(NEW.is_vip, false)) || COALESCE(NEW.metadata, '{}'::JSONB),
        COALESCE(NEW.created_at, NOW())
      );
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'sync_spy_messages_to_chat_logs failed: %', SQLERRM;
      RETURN NEW;
    END;
    $t$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_sync_spy_to_chat_logs ON public.spy_messages;
CREATE TRIGGER trg_sync_spy_to_chat_logs
  AFTER INSERT ON public.spy_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_spy_messages_to_chat_logs();

-- 0-2. paid_users → user_profiles 同期トリガー
CREATE OR REPLACE FUNCTION public.sync_paid_users_to_user_profiles()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- cast_name が NULL/空の場合はスキップ
  IF NEW.cast_name IS NULL OR NEW.cast_name = '' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_name IS NULL OR TRIM(NEW.user_name) = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_profiles (
    cast_name, account_id, username, total_tokens, first_seen, last_seen,
    visit_count, segment, segment_updated_at, metadata, created_at, updated_at
  ) VALUES (
    NEW.cast_name, NEW.account_id, NEW.user_name,
    COALESCE(NEW.total_coins, 0),
    COALESCE(NEW.first_payment_date, NEW.created_at, NOW()),
    COALESCE(NEW.last_payment_date, NOW()),
    COALESCE(NEW.tx_count, 0),
    NEW.segment,
    CASE WHEN NEW.segment IS NOT NULL THEN NOW() ELSE NULL END,
    '{}'::JSONB,
    COALESCE(NEW.created_at, NOW()),
    NOW()
  )
  ON CONFLICT (account_id, cast_name, username)
  DO UPDATE SET
    total_tokens = EXCLUDED.total_tokens,
    last_seen = EXCLUDED.last_seen,
    visit_count = EXCLUDED.visit_count,
    segment = COALESCE(EXCLUDED.segment, user_profiles.segment),
    segment_updated_at = CASE WHEN EXCLUDED.segment IS NOT NULL THEN NOW()
                              ELSE user_profiles.segment_updated_at END,
    updated_at = NOW();

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_paid_users_to_user_profiles failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_paid_to_user_profiles ON public.paid_users;
CREATE TRIGGER trg_sync_paid_to_user_profiles
  AFTER INSERT OR UPDATE ON public.paid_users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_paid_users_to_user_profiles();

-- 0-3. ギャップ埋め: Migration 099以降に追加されたspy_messagesをchat_logsに同期
INSERT INTO public.chat_logs (
  cast_name, account_id, session_id, username, message,
  message_type, tokens, "timestamp", metadata, created_at
)
SELECT
  sm.cast_name, sm.account_id,
  CASE WHEN sm.session_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.sessions s WHERE s.session_id = sm.session_id)
       THEN sm.session_id ELSE NULL END,
  sm.user_name,
  COALESCE(sm.message, ''),
  LOWER(COALESCE(sm.msg_type, 'chat')),
  GREATEST(COALESCE(sm.tokens, 0), 0),
  sm.message_time,
  JSONB_BUILD_OBJECT('is_vip', COALESCE(sm.is_vip, false)) || COALESCE(sm.metadata, '{}'::JSONB),
  COALESCE(sm.created_at, NOW())
FROM public.spy_messages sm
WHERE sm.message_time > (SELECT COALESCE(MAX(cl."timestamp"), '1970-01-01'::TIMESTAMPTZ) FROM public.chat_logs cl)
  AND sm.account_id IS NOT NULL
  AND sm.cast_name IS NOT NULL AND sm.cast_name != ''
ON CONFLICT DO NOTHING;

-- 0-4. ギャップ埋め: paid_users → user_profiles
INSERT INTO public.user_profiles (
  cast_name, account_id, username, total_tokens, first_seen, last_seen,
  visit_count, segment, segment_updated_at, metadata, created_at, updated_at
)
SELECT
  COALESCE(pu.cast_name, 'unknown'),
  pu.account_id, pu.user_name,
  COALESCE(pu.total_coins, 0),
  COALESCE(pu.first_payment_date, pu.created_at, NOW()),
  COALESCE(pu.last_payment_date, NOW()),
  COALESCE(pu.tx_count, 0),
  pu.segment,
  CASE WHEN pu.segment IS NOT NULL THEN pu.updated_at ELSE NULL END,
  '{}'::JSONB,
  COALESCE(pu.created_at, NOW()),
  NOW()
FROM public.paid_users pu
WHERE pu.user_name IS NOT NULL AND TRIM(pu.user_name) != ''
  AND pu.cast_name IS NOT NULL AND pu.cast_name != ''
  AND pu.updated_at > (SELECT COALESCE(MAX(up.updated_at), '1970-01-01'::TIMESTAMPTZ) FROM public.user_profiles up)
ON CONFLICT (account_id, cast_name, username) DO UPDATE SET
  total_tokens = EXCLUDED.total_tokens,
  last_seen = EXCLUDED.last_seen,
  visit_count = EXCLUDED.visit_count,
  segment = COALESCE(EXCLUDED.segment, user_profiles.segment),
  segment_updated_at = CASE WHEN EXCLUDED.segment IS NOT NULL THEN NOW()
                            ELSE user_profiles.segment_updated_at END,
  updated_at = NOW();

-- ############################################################
-- Section 1: RPCs from spy_messages → chat_logs (simple rewrites)
-- ############################################################

-- 1-1. get_cast_stats (005)
DROP FUNCTION IF EXISTS public.get_cast_stats(UUID, TEXT[]);

CREATE OR REPLACE FUNCTION public.get_cast_stats(
  p_account_id UUID,
  p_cast_names TEXT[]
)
RETURNS TABLE (
  cast_name TEXT,
  total_messages BIGINT,
  total_tips BIGINT,
  total_tokens BIGINT,
  unique_users BIGINT,
  last_activity TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.cast_name,
    COUNT(*)::BIGINT AS total_messages,
    COUNT(*) FILTER (WHERE cl.message_type IN ('tip', 'gift'))::BIGINT AS total_tips,
    COALESCE(SUM(cl.tokens) FILTER (WHERE cl.message_type IN ('tip', 'gift')), 0)::BIGINT AS total_tokens,
    COUNT(DISTINCT cl.username)::BIGINT AS unique_users,
    MAX(cl."timestamp") AS last_activity
  FROM public.chat_logs cl
  WHERE cl.account_id = p_account_id
    AND cl.cast_name = ANY(p_cast_names)
  GROUP BY cl.cast_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1-2. get_cast_fans (005) — return type change: user_name → username
DROP FUNCTION IF EXISTS public.get_cast_fans(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_cast_fans(
  p_account_id UUID,
  p_cast_name TEXT,
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  username TEXT,
  total_tokens BIGINT,
  msg_count BIGINT,
  last_seen TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.username,
    COALESCE(SUM(cl.tokens), 0)::BIGINT AS total_tokens,
    COUNT(*)::BIGINT AS msg_count,
    MAX(cl."timestamp") AS last_seen
  FROM public.chat_logs cl
  WHERE cl.account_id = p_account_id
    AND cl.cast_name = p_cast_name
    AND cl.username IS NOT NULL
  GROUP BY cl.username
  ORDER BY COALESCE(SUM(cl.tokens), 0) DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1-3. get_user_segments (010) — JSONB keys updated
CREATE OR REPLACE FUNCTION public.get_user_segments(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  result JSONB := '[]'::JSONB;
BEGIN
  WITH user_agg AS (
    SELECT
      cl.username,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT AS total_tokens,
      MAX(cl."timestamp") AS last_seen
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id
      AND (p_cast_name IS NULL OR cl.cast_name = p_cast_name)
      AND cl.username IS NOT NULL
      AND cl.username != ''
    GROUP BY cl.username
    HAVING SUM(cl.tokens) FILTER (WHERE cl.tokens > 0) > 0
  ),
  classified AS (
    SELECT
      username, total_tokens, last_seen,
      CASE
        WHEN total_tokens >= 5000 AND last_seen >= NOW() - INTERVAL '7 days'  THEN 'S1'
        WHEN total_tokens >= 5000 AND last_seen >= NOW() - INTERVAL '90 days' THEN 'S2'
        WHEN total_tokens >= 5000 THEN 'S3'
        WHEN total_tokens >= 1000 AND last_seen >= NOW() - INTERVAL '7 days'  THEN 'S4'
        WHEN total_tokens >= 1000 AND last_seen >= NOW() - INTERVAL '90 days' THEN 'S5'
        WHEN total_tokens >= 1000 THEN 'S6'
        WHEN total_tokens >= 300  AND last_seen >= NOW() - INTERVAL '30 days' THEN 'S7'
        WHEN total_tokens >= 300  THEN 'S8'
        WHEN total_tokens >= 50   THEN 'S9'
        ELSE 'S10'
      END AS seg_id
    FROM user_agg
  ),
  seg_users AS (
    SELECT
      seg_id,
      jsonb_agg(
        jsonb_build_object(
          'username', username,
          'total_tokens', total_tokens,
          'last_seen', last_seen
        ) ORDER BY total_tokens DESC
      ) FILTER (WHERE rn <= 100) AS users_json
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY seg_id ORDER BY total_tokens DESC) AS rn
      FROM classified
    ) ranked
    GROUP BY seg_id
  ),
  seg_agg AS (
    SELECT
      c.seg_id,
      COUNT(*)::INTEGER AS user_count,
      COALESCE(SUM(c.total_tokens), 0)::BIGINT AS seg_total_tokens,
      CASE WHEN COUNT(*) > 0 THEN (SUM(c.total_tokens) / COUNT(*))::BIGINT ELSE 0 END AS avg_tokens
    FROM classified c
    GROUP BY c.seg_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'segment_id', sa.seg_id,
      'segment_name', CASE sa.seg_id
        WHEN 'S1'  THEN 'VIP現役'
        WHEN 'S2'  THEN 'VIP準現役'
        WHEN 'S3'  THEN 'VIP休眠'
        WHEN 'S4'  THEN '常連現役'
        WHEN 'S5'  THEN '常連離脱危機'
        WHEN 'S6'  THEN '常連休眠'
        WHEN 'S7'  THEN '中堅現役'
        WHEN 'S8'  THEN '中堅休眠'
        WHEN 'S9'  THEN 'ライト'
        WHEN 'S10' THEN '単発/新規'
      END,
      'tier', CASE
        WHEN sa.seg_id IN ('S1','S2','S3') THEN 'VIP（5000tk+）'
        WHEN sa.seg_id IN ('S4','S5','S6') THEN '常連（1000-4999tk）'
        WHEN sa.seg_id IN ('S7','S8')      THEN '中堅（300-999tk）'
        WHEN sa.seg_id = 'S9'              THEN 'ライト（50-299tk）'
        ELSE '単発（50tk未満）'
      END,
      'recency', CASE
        WHEN sa.seg_id IN ('S1','S4') THEN '7日以内'
        WHEN sa.seg_id IN ('S2','S5') THEN '90日以内'
        WHEN sa.seg_id = 'S7'         THEN '30日以内'
        ELSE '休眠/その他'
      END,
      'priority', CASE
        WHEN sa.seg_id = 'S1'                   THEN '最優先'
        WHEN sa.seg_id IN ('S2','S4')            THEN '高'
        WHEN sa.seg_id IN ('S3','S5','S7')       THEN '中'
        WHEN sa.seg_id IN ('S6','S8')            THEN '通常'
        ELSE '低'
      END,
      'user_count', sa.user_count,
      'total_tokens', sa.seg_total_tokens,
      'avg_tokens', sa.avg_tokens,
      'users', COALESCE(su.users_json, '[]'::JSONB)
    ) ORDER BY sa.seg_id
  ), '[]'::JSONB)
  INTO result
  FROM seg_agg sa
  LEFT JOIN seg_users su ON su.seg_id = sa.seg_id;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ############################################################
-- Section 2: Analysis RPCs (058 — 他社SPYマーケット分析)
-- ############################################################

-- 2-1. get_spy_viewer_trends
DROP FUNCTION IF EXISTS public.get_spy_viewer_trends(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_viewer_trends(
  p_account_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  cast_name TEXT, hour_of_day INTEGER, avg_viewers NUMERIC,
  max_viewers INTEGER, broadcast_count INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.cast_name,
    EXTRACT(HOUR FROM cl."timestamp" AT TIME ZONE 'Asia/Tokyo')::INTEGER AS hour_of_day,
    ROUND(AVG((cl.metadata->>'total')::NUMERIC), 0) AS avg_viewers,
    MAX((cl.metadata->>'total')::INTEGER) AS max_viewers,
    COUNT(DISTINCT DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo'))::INTEGER AS broadcast_count
  FROM public.chat_logs cl
  WHERE cl.account_id = p_account_id
    AND cl.message_type = 'viewer_count'
    AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
    AND cl.metadata->>'total' IS NOT NULL
    AND (cl.metadata->>'total')::INTEGER > 0
    AND cl.cast_name NOT IN (
      SELECT rc.cast_name FROM public.registered_casts rc WHERE rc.account_id = p_account_id
    )
  GROUP BY cl.cast_name, EXTRACT(HOUR FROM cl."timestamp" AT TIME ZONE 'Asia/Tokyo')
  ORDER BY cl.cast_name, hour_of_day;
END;
$$;

-- 2-2. get_spy_revenue_types
DROP FUNCTION IF EXISTS public.get_spy_revenue_types(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_revenue_types(
  p_account_id UUID, p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  cast_name TEXT, tip_count BIGINT, ticket_count BIGINT,
  group_count BIGINT, total_tokens BIGINT, broadcast_days INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT
    cl.cast_name,
    COUNT(*) FILTER (WHERE cl.message_type IN ('tip', 'gift') AND cl.tokens > 0)::BIGINT,
    COUNT(*) FILTER (WHERE cl.message_type = 'goal')::BIGINT,
    COUNT(*) FILTER (WHERE cl.message_type IN ('group_join', 'group_end'))::BIGINT,
    COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT,
    COUNT(DISTINCT DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo'))::INTEGER
  FROM public.chat_logs cl
  WHERE cl.account_id = p_account_id
    AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
    AND cl.cast_name NOT IN (
      SELECT rc.cast_name FROM public.registered_casts rc WHERE rc.account_id = p_account_id
    )
  GROUP BY cl.cast_name;
END;
$$;

-- 2-3. get_spy_market_now
DROP FUNCTION IF EXISTS public.get_spy_market_now(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_market_now(
  p_account_id UUID, p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  current_hour INTEGER, active_casts INTEGER, avg_viewers_now NUMERIC,
  best_cast TEXT, best_viewers INTEGER, own_avg_viewers NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_hour INTEGER;
BEGIN
  v_hour := EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tokyo')::INTEGER;
  RETURN QUERY
  WITH
  spy_hourly AS (
    SELECT cl.cast_name,
      ROUND(AVG((cl.metadata->>'total')::NUMERIC), 0) AS avg_v,
      MAX((cl.metadata->>'total')::INTEGER) AS max_v
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id AND cl.message_type = 'viewer_count'
      AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
      AND cl.metadata->>'total' IS NOT NULL AND (cl.metadata->>'total')::INTEGER > 0
      AND EXTRACT(HOUR FROM cl."timestamp" AT TIME ZONE 'Asia/Tokyo') = v_hour
      AND cl.cast_name NOT IN (SELECT rc.cast_name FROM public.registered_casts rc WHERE rc.account_id = p_account_id)
    GROUP BY cl.cast_name
  ),
  own_hourly AS (
    SELECT ROUND(AVG((cl.metadata->>'total')::NUMERIC), 0) AS avg_v
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id AND cl.message_type = 'viewer_count'
      AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
      AND cl.metadata->>'total' IS NOT NULL AND (cl.metadata->>'total')::INTEGER > 0
      AND EXTRACT(HOUR FROM cl."timestamp" AT TIME ZONE 'Asia/Tokyo') = v_hour
      AND cl.cast_name IN (SELECT rc.cast_name FROM public.registered_casts rc WHERE rc.account_id = p_account_id)
  ),
  best AS (SELECT sh.cast_name, sh.max_v FROM spy_hourly sh ORDER BY sh.avg_v DESC LIMIT 1)
  SELECT v_hour, COUNT(*)::INTEGER, ROUND(AVG(sh.avg_v), 0),
    (SELECT b.cast_name FROM best b), (SELECT b.max_v FROM best b),
    (SELECT oh.avg_v FROM own_hourly oh)
  FROM spy_hourly sh;
END;
$$;

-- ############################################################
-- Section 3: Analysis RPCs (065 — SPY集計・トレンド分析)
-- ############################################################

-- 3-1. get_spy_cast_schedule_pattern
DROP FUNCTION IF EXISTS public.get_spy_cast_schedule_pattern(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_cast_schedule_pattern(
  p_account_id UUID, p_cast_name TEXT DEFAULT NULL, p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT, day_of_week INTEGER, hour_of_day INTEGER, session_count INTEGER,
  avg_duration_min NUMERIC, avg_viewers NUMERIC, avg_tokens_per_session NUMERIC, total_tokens BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH sessions AS (
    SELECT cl.cast_name,
      DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo') AS session_date,
      EXTRACT(DOW FROM cl."timestamp" AT TIME ZONE 'Asia/Tokyo')::INTEGER AS dow,
      EXTRACT(HOUR FROM MIN(cl."timestamp") AT TIME ZONE 'Asia/Tokyo')::INTEGER AS start_hour,
      EXTRACT(EPOCH FROM (MAX(cl."timestamp") - MIN(cl."timestamp"))) / 60.0 AS duration_min,
      COALESCE(AVG(CASE WHEN cl.message_type = 'viewer_count' AND cl.metadata->>'total' IS NOT NULL
        THEN (cl.metadata->>'total')::NUMERIC ELSE NULL END), 0) AS avg_v,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0) AS session_tokens
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id
      AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR cl.cast_name = p_cast_name)
    GROUP BY cl.cast_name, session_date, dow
    HAVING COUNT(*) >= 5
  )
  SELECT s.cast_name, s.dow, s.start_hour,
    COUNT(*)::INTEGER, ROUND(AVG(s.duration_min), 1),
    ROUND(AVG(s.avg_v), 0), ROUND(AVG(s.session_tokens), 0),
    SUM(s.session_tokens)::BIGINT
  FROM sessions s
  GROUP BY s.cast_name, s.dow, s.start_hour
  ORDER BY s.cast_name, s.dow, s.start_hour;
END;
$$;

-- 3-2. get_user_payment_pattern
DROP FUNCTION IF EXISTS public.get_user_payment_pattern(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_user_payment_pattern(
  p_account_id UUID, p_cast_name TEXT DEFAULT NULL, p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT, payment_hour INTEGER, avg_tip_amount NUMERIC, median_tip_amount NUMERIC,
  tip_count BIGINT, unique_tippers BIGINT, repeat_tipper_count BIGINT, avg_tips_per_user NUMERIC,
  whale_count BIGINT, micro_count BIGINT, mid_count BIGINT, high_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH tips AS (
    SELECT cl.cast_name,
      EXTRACT(HOUR FROM cl."timestamp" AT TIME ZONE 'Asia/Tokyo')::INTEGER AS tip_hour,
      cl.username, cl.tokens
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id
      AND cl.message_type IN ('tip', 'gift') AND cl.tokens > 0
      AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR cl.cast_name = p_cast_name)
  ),
  hourly AS (
    SELECT t.cast_name, t.tip_hour,
      ROUND(AVG(t.tokens), 1) AS avg_tip,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY t.tokens)::NUMERIC AS median_tip,
      COUNT(*)::BIGINT AS cnt, COUNT(DISTINCT t.username)::BIGINT AS unique_cnt,
      COUNT(*) FILTER (WHERE t.tokens >= 1000)::BIGINT AS whale,
      COUNT(*) FILTER (WHERE t.tokens < 50)::BIGINT AS micro,
      COUNT(*) FILTER (WHERE t.tokens >= 50 AND t.tokens < 500)::BIGINT AS mid,
      COUNT(*) FILTER (WHERE t.tokens >= 500 AND t.tokens < 1000)::BIGINT AS high
    FROM tips t GROUP BY t.cast_name, t.tip_hour
  ),
  repeaters AS (
    SELECT t.cast_name, COUNT(DISTINCT t.username)::BIGINT AS repeat_cnt
    FROM tips t GROUP BY t.cast_name HAVING COUNT(*) >= 2
  )
  SELECT h.cast_name, h.tip_hour, h.avg_tip, ROUND(h.median_tip, 1),
    h.cnt, h.unique_cnt, COALESCE(r.repeat_cnt, 0),
    CASE WHEN h.unique_cnt > 0 THEN ROUND(h.cnt::NUMERIC / h.unique_cnt, 1) ELSE 0 END,
    h.whale, h.micro, h.mid, h.high
  FROM hourly h LEFT JOIN repeaters r ON r.cast_name = h.cast_name
  ORDER BY h.cast_name, h.tip_hour;
END;
$$;

-- 3-3. get_cast_growth_curve
DROP FUNCTION IF EXISTS public.get_cast_growth_curve(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_cast_growth_curve(
  p_account_id UUID, p_cast_name TEXT DEFAULT NULL, p_days INTEGER DEFAULT 90
)
RETURNS TABLE (
  cast_name TEXT, report_date DATE, tokens BIGINT, tip_count BIGINT,
  unique_users BIGINT, avg_viewers NUMERIC, peak_viewers INTEGER, chat_messages BIGINT,
  tokens_7d_avg NUMERIC, viewers_7d_avg NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH daily AS (
    SELECT cl.cast_name,
      DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo') AS d,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT AS tokens,
      COUNT(*) FILTER (WHERE cl.message_type IN ('tip', 'gift') AND cl.tokens > 0)::BIGINT AS tip_count,
      COUNT(DISTINCT cl.username) FILTER (WHERE cl.username IS NOT NULL)::BIGINT AS unique_users,
      ROUND(AVG(CASE WHEN cl.message_type = 'viewer_count' AND cl.metadata->>'total' IS NOT NULL
        THEN (cl.metadata->>'total')::NUMERIC ELSE NULL END), 0) AS avg_viewers,
      COALESCE(MAX(CASE WHEN cl.message_type = 'viewer_count' AND cl.metadata->>'total' IS NOT NULL
        THEN (cl.metadata->>'total')::INTEGER ELSE NULL END), 0) AS peak_viewers,
      COUNT(*) FILTER (WHERE cl.message_type = 'chat')::BIGINT AS chat_messages
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id
      AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR cl.cast_name = p_cast_name)
    GROUP BY cl.cast_name, DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo')
    HAVING COUNT(*) >= 3
  )
  SELECT daily.cast_name, daily.d, daily.tokens, daily.tip_count, daily.unique_users,
    daily.avg_viewers, daily.peak_viewers::INTEGER, daily.chat_messages,
    ROUND(AVG(daily.tokens) OVER (PARTITION BY daily.cast_name ORDER BY daily.d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 0),
    ROUND(AVG(daily.avg_viewers) OVER (PARTITION BY daily.cast_name ORDER BY daily.d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 0)
  FROM daily ORDER BY daily.cast_name, daily.d;
END;
$$;

-- 3-4. get_goal_achievement_analysis
DROP FUNCTION IF EXISTS public.get_goal_achievement_analysis(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION public.get_goal_achievement_analysis(
  p_account_id UUID, p_cast_name TEXT DEFAULT NULL, p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  cast_name TEXT, goal_count BIGINT, total_goal_tokens BIGINT, avg_goal_tokens NUMERIC,
  sessions_with_goals BIGINT, goals_per_session NUMERIC, goal_hours JSONB
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH goals AS (
    SELECT cl.cast_name, cl.tokens,
      DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo') AS goal_date,
      EXTRACT(HOUR FROM cl."timestamp" AT TIME ZONE 'Asia/Tokyo')::INTEGER AS goal_hour
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id AND cl.message_type = 'goal'
      AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
      AND (p_cast_name IS NULL OR cl.cast_name = p_cast_name)
  ),
  goal_hours_agg AS (
    SELECT g.cast_name,
      jsonb_agg(jsonb_build_object('hour', gh.goal_hour, 'count', gh.cnt) ORDER BY gh.goal_hour) AS hours_json
    FROM goals g
    INNER JOIN (SELECT g2.cast_name, g2.goal_hour, COUNT(*)::INTEGER AS cnt FROM goals g2 GROUP BY g2.cast_name, g2.goal_hour) gh ON gh.cast_name = g.cast_name
    GROUP BY g.cast_name
  )
  SELECT g.cast_name, COUNT(*)::BIGINT, COALESCE(SUM(g.tokens), 0)::BIGINT,
    ROUND(AVG(g.tokens), 0), COUNT(DISTINCT g.goal_date)::BIGINT,
    CASE WHEN COUNT(DISTINCT g.goal_date) > 0 THEN ROUND(COUNT(*)::NUMERIC / COUNT(DISTINCT g.goal_date), 1) ELSE 0 END,
    COALESCE(gh.hours_json, '[]'::JSONB)
  FROM goals g LEFT JOIN goal_hours_agg gh ON gh.cast_name = g.cast_name
  GROUP BY g.cast_name, gh.hours_json ORDER BY g.cast_name;
END;
$$;

-- 3-5. get_market_trend
DROP FUNCTION IF EXISTS public.get_market_trend(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_market_trend(
  p_account_id UUID, p_days INTEGER DEFAULT 30
)
RETURNS TABLE (
  report_date DATE, own_tokens BIGINT, own_viewers NUMERIC, own_sessions INTEGER,
  competitor_tokens BIGINT, competitor_viewers NUMERIC, competitor_sessions INTEGER,
  market_share_pct NUMERIC, own_avg_tip NUMERIC, competitor_avg_tip NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH own_casts AS (
    SELECT rc.cast_name FROM public.registered_casts rc
    WHERE rc.account_id = p_account_id AND rc.is_active = true
  ),
  daily AS (
    SELECT DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo') AS d,
      CASE WHEN oc.cast_name IS NOT NULL THEN 'own' ELSE 'competitor' END AS side,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT AS tokens,
      ROUND(AVG(CASE WHEN cl.message_type = 'viewer_count' AND cl.metadata->>'total' IS NOT NULL
        THEN (cl.metadata->>'total')::NUMERIC ELSE NULL END), 0) AS avg_viewers,
      COUNT(DISTINCT cl.cast_name)::INTEGER AS sessions,
      CASE WHEN COUNT(*) FILTER (WHERE cl.message_type IN ('tip', 'gift') AND cl.tokens > 0) > 0
        THEN ROUND(SUM(cl.tokens) FILTER (WHERE cl.message_type IN ('tip', 'gift') AND cl.tokens > 0)::NUMERIC /
          COUNT(*) FILTER (WHERE cl.message_type IN ('tip', 'gift') AND cl.tokens > 0), 1) ELSE 0 END AS avg_tip
    FROM public.chat_logs cl
    LEFT JOIN own_casts oc ON oc.cast_name = cl.cast_name
    WHERE cl.account_id = p_account_id
      AND cl."timestamp" >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY DATE(cl."timestamp" AT TIME ZONE 'Asia/Tokyo'),
             CASE WHEN oc.cast_name IS NOT NULL THEN 'own' ELSE 'competitor' END
  )
  SELECT COALESCE(o.d, c.d), COALESCE(o.tokens, 0), COALESCE(o.avg_viewers, 0),
    COALESCE(o.sessions, 0), COALESCE(c.tokens, 0), COALESCE(c.avg_viewers, 0),
    COALESCE(c.sessions, 0),
    CASE WHEN COALESCE(o.tokens, 0) + COALESCE(c.tokens, 0) > 0
      THEN ROUND(COALESCE(o.tokens, 0)::NUMERIC / (COALESCE(o.tokens, 0) + COALESCE(c.tokens, 0)) * 100, 1)
      ELSE 0 END,
    COALESCE(o.avg_tip, 0), COALESCE(c.avg_tip, 0)
  FROM (SELECT * FROM daily WHERE side = 'own') o
  FULL OUTER JOIN (SELECT * FROM daily WHERE side = 'competitor') c ON o.d = c.d
  ORDER BY COALESCE(o.d, c.d);
END;
$$;

-- ############################################################
-- Section 4: RPCs from paid_users → user_profiles (016, 026)
-- ############################################################

-- 4-1. get_user_acquisition_dashboard — return type changes
DROP FUNCTION IF EXISTS public.get_user_acquisition_dashboard(UUID, TEXT, INTEGER, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.get_user_acquisition_dashboard(
  p_account_id UUID, p_cast_name TEXT, p_days INTEGER DEFAULT 30,
  p_min_coins INTEGER DEFAULT 0, p_max_coins INTEGER DEFAULT 999999
)
RETURNS TABLE (
  username TEXT, total_tokens BIGINT, last_seen TIMESTAMPTZ, first_seen TIMESTAMPTZ,
  tx_count BIGINT, dm_sent BOOLEAN, dm_sent_date TIMESTAMPTZ, dm_campaign TEXT,
  segment TEXT, is_new_user BOOLEAN, converted_after_dm BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    up.username,
    up.total_tokens::BIGINT,
    up.last_seen,
    up.first_seen,
    COALESCE(ct_agg.tx_count, 0)::BIGINT,
    EXISTS (SELECT 1 FROM dm_send_log dm WHERE dm.user_name = up.username AND dm.account_id = p_account_id) AS dm_sent,
    (SELECT MAX(dm.queued_at) FROM dm_send_log dm WHERE dm.user_name = up.username AND dm.account_id = p_account_id) AS dm_sent_date,
    (SELECT dm.campaign FROM dm_send_log dm WHERE dm.user_name = up.username AND dm.account_id = p_account_id ORDER BY dm.queued_at DESC LIMIT 1) AS dm_campaign,
    CASE
      WHEN up.total_tokens >= 3500 AND up.last_seen >= NOW() - INTERVAL '90 days' THEN 'S2 Whale準現役'
      WHEN up.total_tokens >= 3500 THEN 'S3 Whale休眠'
      WHEN up.total_tokens >= 1400 AND up.last_seen >= NOW() - INTERVAL '90 days' THEN 'S5 VIP準現役'
      WHEN up.total_tokens >= 1400 THEN 'S6 VIP休眠'
      WHEN up.total_tokens >= 550 THEN 'S8 常連'
      WHEN up.total_tokens >= 200 THEN 'S9 中堅'
      ELSE 'S10 ライト'
    END AS segment,
    (up.first_seen >= NOW() - (p_days || ' days')::INTERVAL) AS is_new_user,
    (EXISTS (SELECT 1 FROM dm_send_log dm WHERE dm.user_name = up.username AND dm.account_id = p_account_id AND up.last_seen > dm.queued_at)) AS converted_after_dm
  FROM public.user_profiles up
  LEFT JOIN (
    SELECT ct.user_name, COUNT(*) AS tx_count
    FROM coin_transactions ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
      AND ct.date >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY ct.user_name
  ) ct_agg ON ct_agg.user_name = up.username
  WHERE up.cast_name = p_cast_name
    AND up.total_tokens >= p_min_coins
    AND up.total_tokens <= p_max_coins
    AND up.last_seen >= NOW() - (p_days || ' days')::INTERVAL
    AND up.first_seen >= '2026-02-15'::DATE
  ORDER BY up.total_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4-2. search_user_detail — return type changes
DROP FUNCTION IF EXISTS public.search_user_detail(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.search_user_detail(
  p_account_id UUID, p_cast_name TEXT, p_user_name TEXT
)
RETURNS TABLE (
  username TEXT, total_tokens BIGINT, last_seen TIMESTAMPTZ, first_seen TIMESTAMPTZ,
  tx_count BIGINT, segment TEXT, dm_history JSONB, recent_transactions JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    up.username, up.total_tokens::BIGINT, up.last_seen, up.first_seen,
    (SELECT COUNT(*) FROM coin_transactions ct WHERE ct.user_name = up.username
      AND ct.cast_name = p_cast_name AND ct.account_id = p_account_id)::BIGINT AS tx_count,
    CASE
      WHEN up.total_tokens >= 3500 AND up.last_seen >= NOW() - INTERVAL '90 days' THEN 'S2 Whale準現役'
      WHEN up.total_tokens >= 3500 THEN 'S3 Whale休眠'
      WHEN up.total_tokens >= 1400 AND up.last_seen >= NOW() - INTERVAL '90 days' THEN 'S5 VIP準現役'
      WHEN up.total_tokens >= 1400 THEN 'S6 VIP休眠'
      WHEN up.total_tokens >= 550 THEN 'S8 常連'
      WHEN up.total_tokens >= 200 THEN 'S9 中堅'
      ELSE 'S10 ライト'
    END AS segment,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('campaign', dm.campaign, 'sent_date', dm.queued_at, 'status', dm.status) ORDER BY dm.queued_at DESC)
      FROM dm_send_log dm WHERE dm.user_name = up.username AND dm.account_id = p_account_id), '[]'::JSONB) AS dm_history,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('date', ct.date, 'amount', ct.tokens, 'type', ct.type) ORDER BY ct.date DESC)
      FROM (SELECT ct2.date, ct2.tokens, ct2.type FROM coin_transactions ct2 WHERE ct2.user_name = up.username
        AND ct2.cast_name = p_cast_name AND ct2.account_id = p_account_id ORDER BY ct2.date DESC LIMIT 20) ct), '[]'::JSONB) AS recent_transactions
  FROM public.user_profiles up
  WHERE up.cast_name = p_cast_name AND up.username ILIKE p_user_name || '%'
  LIMIT 5;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4-3. get_thankyou_dm_candidates (026) — uses both chat_logs + user_profiles
CREATE OR REPLACE FUNCTION public.get_thankyou_dm_candidates(
  p_account_id UUID, p_cast_name TEXT, p_session_id TEXT DEFAULT NULL, p_min_tokens INT DEFAULT 100
)
RETURNS TABLE (
  username TEXT, tokens_in_session BIGINT, total_tokens BIGINT, segment TEXT,
  last_dm_sent_at TIMESTAMPTZ, dm_sent_this_session BOOLEAN, suggested_template TEXT
) AS $$
DECLARE
  v_session_id TEXT; v_session_start TIMESTAMPTZ; v_session_end TIMESTAMPTZ;
BEGIN
  IF p_session_id IS NOT NULL THEN v_session_id := p_session_id;
  ELSE
    SELECT s.session_id::TEXT INTO v_session_id FROM public.sessions s
    WHERE s.account_id = p_account_id AND COALESCE(s.cast_name, s.title) = p_cast_name
    ORDER BY s.started_at DESC LIMIT 1;
  END IF;
  IF v_session_id IS NULL THEN RETURN; END IF;

  SELECT s.started_at, COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours')
  INTO v_session_start, v_session_end
  FROM public.sessions s WHERE s.account_id = p_account_id AND s.session_id::TEXT = v_session_id;
  IF v_session_start IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH session_tippers AS (
    SELECT cl.username AS uname, COALESCE(SUM(cl.tokens), 0)::BIGINT AS sess_tokens
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id AND cl.cast_name = p_cast_name
      AND cl.message_type IN ('tip', 'gift')
      AND cl."timestamp" >= v_session_start AND cl."timestamp" <= v_session_end
      AND cl.username IS NOT NULL AND cl.username != '' AND cl.tokens > 0
    GROUP BY cl.username HAVING COALESCE(SUM(cl.tokens), 0) >= p_min_tokens
  ),
  user_totals AS (
    SELECT up.username AS uname, COALESCE(up.total_tokens, 0)::BIGINT AS all_tokens
    FROM public.user_profiles up
    WHERE up.account_id = p_account_id AND up.username IN (SELECT st.uname FROM session_tippers st)
  ),
  segmented AS (
    SELECT st.uname, st.sess_tokens,
      COALESCE(ut.all_tokens, st.sess_tokens)::BIGINT AS cumulative_tokens,
      CASE
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 5000 THEN
          CASE WHEN COALESCE(up_i.last_seen, NOW()) >= NOW() - INTERVAL '7 days' THEN 'S1' ELSE 'S2' END
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 1000 THEN
          CASE WHEN COALESCE(up_i.last_seen, NOW()) >= NOW() - INTERVAL '90 days' THEN 'S4' ELSE 'S5' END
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 300 THEN
          CASE WHEN COALESCE(up_i.last_seen, NOW()) >= NOW() - INTERVAL '30 days' THEN 'S7' ELSE 'S8' END
        WHEN COALESCE(ut.all_tokens, st.sess_tokens) >= 50 THEN 'S9'
        ELSE 'S10'
      END AS seg
    FROM session_tippers st
    LEFT JOIN user_totals ut ON ut.uname = st.uname
    LEFT JOIN public.user_profiles up_i ON up_i.account_id = p_account_id AND up_i.username = st.uname
  ),
  dm_history AS (
    SELECT dl.user_name AS uname, MAX(dl.sent_at) AS last_sent,
      BOOL_OR(dl.sent_at >= v_session_start AND dl.sent_at <= v_session_end + INTERVAL '6 hours') AS sent_this_sess
    FROM public.dm_send_log dl
    WHERE dl.account_id = p_account_id AND dl.status = 'success'
      AND dl.user_name IN (SELECT sg.uname FROM segmented sg)
    GROUP BY dl.user_name
  )
  SELECT sg.uname, sg.sess_tokens, sg.cumulative_tokens, sg.seg,
    dh.last_sent, COALESCE(dh.sent_this_sess, FALSE),
    CASE
      WHEN sg.seg IN ('S1') THEN NULL
      WHEN sg.seg IN ('S2', 'S4') THEN sg.uname || 'さん、今日はありがとう😊 すごく嬉しかったです！ また気が向いたら遊びに来てくださいね。 でも無理しないでね😊'
      WHEN sg.seg IN ('S5', 'S7') THEN sg.uname || 'さん、今日はありがとう😊 すごく楽しかったです！ 気が向いたらまた遊びに来てくださいね。'
      WHEN sg.seg IN ('S8', 'S9') THEN sg.uname || 'さん、ありがとう😊 また会えたら嬉しいです。 あなたの自由だから、気が向いたらね😊'
      ELSE NULL
    END
  FROM segmented sg LEFT JOIN dm_history dh ON dh.uname = sg.uname
  WHERE sg.seg != 'S10' AND COALESCE(dh.sent_this_sess, FALSE) = FALSE
  ORDER BY sg.sess_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4-4. detect_churn_risk (026) — uses both chat_logs + user_profiles
CREATE OR REPLACE FUNCTION public.detect_churn_risk(
  p_account_id UUID, p_cast_name TEXT, p_lookback_sessions INT DEFAULT 7, p_absence_threshold INT DEFAULT 2
)
RETURNS TABLE (
  username TEXT, segment TEXT, total_tokens BIGINT, attendance_rate NUMERIC,
  last_seen_date TIMESTAMPTZ, consecutive_absences INT
) AS $$
BEGIN
  RETURN QUERY
  WITH recent_sessions AS (
    SELECT s.session_id, s.started_at,
      COALESCE(s.ended_at, s.started_at + INTERVAL '12 hours') AS ended,
      ROW_NUMBER() OVER (ORDER BY s.started_at DESC) AS sess_num
    FROM public.sessions s
    WHERE s.account_id = p_account_id AND COALESCE(s.cast_name, s.title) = p_cast_name
    ORDER BY s.started_at DESC LIMIT p_lookback_sessions
  ),
  total_sess_count AS (SELECT COUNT(*)::INT AS cnt FROM recent_sessions),
  valuable_users AS (
    SELECT up.username AS uname, COALESCE(up.total_tokens, 0)::BIGINT AS all_tokens,
      up.last_seen,
      CASE
        WHEN up.total_tokens >= 5000 AND up.last_seen >= NOW() - INTERVAL '7 days'  THEN 'S1'
        WHEN up.total_tokens >= 5000 AND up.last_seen >= NOW() - INTERVAL '90 days' THEN 'S2'
        WHEN up.total_tokens >= 5000 THEN 'S3'
        WHEN up.total_tokens >= 1000 AND up.last_seen >= NOW() - INTERVAL '7 days'  THEN 'S4'
        WHEN up.total_tokens >= 1000 AND up.last_seen >= NOW() - INTERVAL '90 days' THEN 'S5'
        WHEN up.total_tokens >= 1000 THEN 'S6'
        WHEN up.total_tokens >= 300  AND up.last_seen >= NOW() - INTERVAL '30 days' THEN 'S7'
        WHEN up.total_tokens >= 300  THEN 'S8'
        WHEN up.total_tokens >= 50   THEN 'S9'
        ELSE 'S10'
      END AS seg
    FROM public.user_profiles up
    WHERE up.account_id = p_account_id AND up.total_tokens >= 50
  ),
  user_attendance AS (
    SELECT vu.uname, rs.sess_num,
      EXISTS (
        SELECT 1 FROM public.chat_logs cl
        WHERE cl.account_id = p_account_id AND cl.cast_name = p_cast_name
          AND cl.username = vu.uname AND cl."timestamp" >= rs.started_at AND cl."timestamp" <= rs.ended
      ) OR EXISTS (
        SELECT 1 FROM public.coin_transactions ct
        WHERE ct.account_id = p_account_id AND ct.user_name = vu.uname
          AND ct.date >= rs.started_at AND ct.date <= rs.ended
      ) AS was_present
    FROM valuable_users vu CROSS JOIN recent_sessions rs
  ),
  attendance_stats AS (
    SELECT ua.uname,
      COUNT(*) FILTER (WHERE ua.was_present)::NUMERIC / NULLIF((SELECT cnt FROM total_sess_count), 0)::NUMERIC AS att_rate,
      MAX(rs2.started_at) FILTER (WHERE ua.was_present) AS last_seen
    FROM user_attendance ua JOIN recent_sessions rs2 ON rs2.sess_num = ua.sess_num
    GROUP BY ua.uname
  ),
  consecutive_abs AS (
    SELECT ua.uname,
      COALESCE(MIN(ua.sess_num) FILTER (WHERE ua.was_present) - 1, (SELECT cnt FROM total_sess_count))::INT AS consec_abs
    FROM user_attendance ua GROUP BY ua.uname
  )
  SELECT vu.uname, vu.seg, vu.all_tokens,
    ROUND(COALESCE(ast.att_rate, 0), 3), ast.last_seen, ca.consec_abs
  FROM valuable_users vu
  JOIN attendance_stats ast ON ast.uname = vu.uname
  JOIN consecutive_abs ca ON ca.uname = vu.uname
  WHERE vu.seg != 'S10' AND ast.att_rate > 0.3 AND ca.consec_abs >= p_absence_threshold
  ORDER BY ca.consec_abs DESC, vu.all_tokens DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ############################################################
-- Section 5: Session RPCs (097 — 最も複雑)
-- ############################################################

-- 5-1. get_session_list_v2
DROP FUNCTION IF EXISTS public.get_session_list_v2(UUID, TEXT, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION public.get_session_list_v2(
  p_account_id UUID, p_cast_name TEXT, p_limit INTEGER DEFAULT 20, p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(
  broadcast_group_id TEXT, session_ids TEXT[], cast_name TEXT, session_title TEXT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, duration_minutes NUMERIC,
  msg_count BIGINT, unique_users BIGINT, chat_tokens BIGINT, tip_count BIGINT,
  coin_tokens BIGINT, coin_tip_tokens BIGINT, coin_private_tokens BIGINT,
  coin_ticket_tokens BIGINT, coin_group_tokens BIGINT, coin_spy_tokens BIGINT,
  coin_other_tokens BIGINT, total_revenue BIGINT, is_active BOOLEAN, total_count BIGINT
) LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  RETURN QUERY
  WITH
  raw_sessions AS (
    SELECT
      cl.session_id::TEXT AS sid,
      cl.cast_name AS cn,
      MAX(s.broadcast_title) AS stitle,
      MIN(cl."timestamp") AS s_start,
      MAX(cl."timestamp") AS s_end,
      COUNT(*) AS s_msg_count,
      COUNT(DISTINCT cl.username) FILTER (WHERE cl.username IS NOT NULL AND cl.username != '') AS s_unique_users,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT AS s_chat_tokens,
      COUNT(*) FILTER (WHERE cl.tokens > 0) AS s_tip_count
    FROM public.chat_logs cl
    LEFT JOIN public.sessions s ON s.session_id = cl.session_id
    WHERE cl.account_id = p_account_id AND cl.cast_name = p_cast_name AND cl.session_id IS NOT NULL
    GROUP BY cl.session_id, cl.cast_name
  ),
  with_gap AS (
    SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs
  ),
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
    SELECT bg.grp_num, COUNT(DISTINCT cl.username) FILTER (WHERE cl.username IS NOT NULL AND cl.username != '') AS bg_unique
    FROM broadcast_groups bg
    JOIN public.chat_logs cl ON cl.account_id = p_account_id AND cl.cast_name = p_cast_name AND cl.session_id::TEXT = ANY(bg.bg_session_ids)
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
      COALESCE(SUM(ct.tokens) FILTER (WHERE ct.type NOT IN ('tip','private','ticket','group','spy')), 0)::BIGINT AS c_other
    FROM paged_bg pbg
    LEFT JOIN public.coin_transactions ct ON ct.account_id = p_account_id AND (ct.cast_name = p_cast_name OR ct.cast_name IS NULL)
      AND ct.tokens > 0 AND ct.date >= pbg.bg_start - INTERVAL '5 minutes' AND ct.date <= pbg.bg_end + INTERVAL '30 minutes'
    GROUP BY pbg.grp_num
  )
  SELECT pbg.bg_session_ids[1], pbg.bg_session_ids, pbg.cn, pbg.bg_title,
    pbg.bg_start, pbg.bg_end, ROUND(EXTRACT(EPOCH FROM (pbg.bg_end - pbg.bg_start)) / 60, 1),
    pbg.bg_msg_count, COALESCE(buu.bg_unique, 0)::BIGINT, pbg.bg_chat_tokens, pbg.bg_tip_count,
    COALESCE(cm.c_total, 0)::BIGINT, COALESCE(cm.c_tip, 0)::BIGINT, COALESCE(cm.c_private, 0)::BIGINT,
    COALESCE(cm.c_ticket, 0)::BIGINT, COALESCE(cm.c_group, 0)::BIGINT, COALESCE(cm.c_spy, 0)::BIGINT,
    COALESCE(cm.c_other, 0)::BIGINT,
    GREATEST(pbg.bg_chat_tokens, COALESCE(cm.c_total, 0))::BIGINT,
    (pbg.bg_end > NOW() - INTERVAL '10 minutes'), (SELECT cnt FROM bg_count)
  FROM paged_bg pbg LEFT JOIN bg_unique_users buu ON buu.grp_num = pbg.grp_num
  LEFT JOIN coin_match cm ON cm.grp_num = pbg.grp_num ORDER BY pbg.bg_start DESC;
END;
$fn$;

-- 5-2. get_session_summary_v2
DROP FUNCTION IF EXISTS public.get_session_summary_v2(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.get_session_summary_v2(p_account_id UUID, p_session_id TEXT)
RETURNS TABLE(
  broadcast_group_id TEXT, session_ids TEXT[], cast_name TEXT, session_title TEXT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, duration_minutes NUMERIC,
  msg_count BIGINT, unique_users BIGINT, chat_tokens BIGINT, tip_count BIGINT,
  tokens_by_type JSONB, top_chatters JSONB,
  coin_tokens BIGINT, coin_by_type JSONB, coin_top_users JSONB,
  coin_new_users INTEGER, coin_returning_users INTEGER, total_revenue BIGINT,
  prev_broadcast_group_id TEXT, prev_total_revenue BIGINT, prev_started_at TIMESTAMPTZ, change_pct NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_cast TEXT; v_session_ids TEXT[]; v_bg_start TIMESTAMPTZ; v_bg_end TIMESTAMPTZ;
  v_prev_bg_id TEXT; v_prev_bg_start TIMESTAMPTZ; v_prev_bg_end TIMESTAMPTZ;
  v_prev_revenue BIGINT; v_prev_chat BIGINT;
BEGIN
  SELECT cl.cast_name INTO v_cast FROM public.chat_logs cl
  WHERE cl.account_id = p_account_id AND cl.session_id = p_session_id::UUID LIMIT 1;
  IF v_cast IS NULL THEN RETURN; END IF;

  WITH raw_sessions AS (
    SELECT cl.session_id::TEXT AS sid, MIN(cl."timestamp") AS s_start, MAX(cl."timestamp") AS s_end
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id AND cl.cast_name = v_cast AND cl.session_id IS NOT NULL
    GROUP BY cl.session_id
  ),
  sorted AS (SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs),
  grouped AS (
    SELECT ss.*, SUM(CASE WHEN ss.prev_end IS NULL OR EXTRACT(EPOCH FROM (ss.s_start - ss.prev_end)) > 1800 THEN 1 ELSE 0 END) OVER (ORDER BY ss.s_start) AS grp_num
    FROM sorted ss
  ),
  target_grp AS (SELECT g.grp_num FROM grouped g WHERE g.sid = p_session_id LIMIT 1)
  SELECT ARRAY_AGG(g.sid ORDER BY g.s_start), MIN(g.s_start), MAX(g.s_end)
  INTO v_session_ids, v_bg_start, v_bg_end
  FROM grouped g WHERE g.grp_num = (SELECT tg.grp_num FROM target_grp tg);

  IF v_session_ids IS NULL THEN
    v_session_ids := ARRAY[p_session_id];
    SELECT MIN(cl."timestamp"), MAX(cl."timestamp") INTO v_bg_start, v_bg_end
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id AND cl.session_id = p_session_id::UUID;
  END IF;

  WITH raw_sessions AS (
    SELECT cl.session_id::TEXT AS sid, MIN(cl."timestamp") AS s_start, MAX(cl."timestamp") AS s_end
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id AND cl.cast_name = v_cast AND cl.session_id IS NOT NULL
    GROUP BY cl.session_id
  ),
  sorted AS (SELECT rs.*, LAG(rs.s_end) OVER (ORDER BY rs.s_start) AS prev_end FROM raw_sessions rs),
  grouped AS (
    SELECT ss.*, SUM(CASE WHEN ss.prev_end IS NULL OR EXTRACT(EPOCH FROM (ss.s_start - ss.prev_end)) > 1800 THEN 1 ELSE 0 END) OVER (ORDER BY ss.s_start) AS grp_num
    FROM sorted ss
  ),
  bg_agg AS (
    SELECT g.grp_num, (ARRAY_AGG(g.sid ORDER BY g.s_start))[1] AS bg_id,
      ARRAY_AGG(g.sid ORDER BY g.s_start) AS bg_sids, MIN(g.s_start) AS bg_start, MAX(g.s_end) AS bg_end
    FROM grouped g GROUP BY g.grp_num
  ),
  prev_bg AS (SELECT ba.bg_id, ba.bg_start, ba.bg_end FROM bg_agg ba WHERE ba.bg_end < v_bg_start ORDER BY ba.bg_start DESC LIMIT 1)
  SELECT pb.bg_id, pb.bg_start, pb.bg_end INTO v_prev_bg_id, v_prev_bg_start, v_prev_bg_end FROM prev_bg pb;

  IF v_prev_bg_start IS NOT NULL THEN
    SELECT COALESCE(SUM(ct.tokens), 0)::BIGINT INTO v_prev_revenue FROM public.coin_transactions ct
    WHERE ct.account_id = p_account_id AND (ct.cast_name = v_cast OR ct.cast_name IS NULL) AND ct.tokens > 0
      AND ct.date >= v_prev_bg_start - INTERVAL '5 minutes' AND ct.date <= v_prev_bg_end + INTERVAL '30 minutes';

    WITH prev_sids AS (
      SELECT cl.session_id::TEXT AS sid FROM public.chat_logs cl
      WHERE cl.account_id = p_account_id AND cl.cast_name = v_cast AND cl.session_id IS NOT NULL
      GROUP BY cl.session_id
    )
    SELECT COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT INTO v_prev_chat
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id
      AND cl.session_id::TEXT IN (SELECT ps.sid FROM prev_sids ps)
      AND cl."timestamp" >= v_prev_bg_start AND cl."timestamp" <= v_prev_bg_end;
    v_prev_revenue := GREATEST(COALESCE(v_prev_chat, 0), COALESCE(v_prev_revenue, 0));
  END IF;

  RETURN QUERY
  WITH
  spy_agg AS (
    SELECT COUNT(*)::BIGINT AS sa_msg_count,
      COUNT(DISTINCT cl.username) FILTER (WHERE cl.username IS NOT NULL AND cl.username != '')::BIGINT AS sa_unique_users,
      COALESCE(SUM(cl.tokens) FILTER (WHERE cl.tokens > 0), 0)::BIGINT AS sa_chat_tokens,
      COUNT(*) FILTER (WHERE cl.tokens > 0)::BIGINT AS sa_tip_count
    FROM public.chat_logs cl WHERE cl.account_id = p_account_id AND cl.session_id::TEXT = ANY(v_session_ids)
  ),
  type_breakdown AS (
    SELECT COALESCE(jsonb_object_agg(t.message_type, t.type_tokens), '{}'::JSONB) AS tbt
    FROM (SELECT cl.message_type, SUM(cl.tokens) AS type_tokens FROM public.chat_logs cl
      WHERE cl.account_id = p_account_id AND cl.session_id::TEXT = ANY(v_session_ids) AND cl.tokens > 0 GROUP BY cl.message_type) t
  ),
  top5_chat AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('username', u.username, 'tokens', u.user_tokens, 'tip_count', u.user_tips) ORDER BY u.user_tokens DESC), '[]'::JSONB) AS top_list
    FROM (SELECT cl.username, SUM(cl.tokens)::BIGINT AS user_tokens, COUNT(*)::BIGINT AS user_tips FROM public.chat_logs cl
      WHERE cl.account_id = p_account_id AND cl.session_id::TEXT = ANY(v_session_ids) AND cl.tokens > 0 AND cl.username IS NOT NULL AND cl.username != ''
      GROUP BY cl.username ORDER BY SUM(cl.tokens) DESC LIMIT 5) u
  ),
  session_tx AS (SELECT ct.* FROM public.coin_transactions ct WHERE ct.account_id = p_account_id AND (ct.cast_name = v_cast OR ct.cast_name IS NULL)
    AND ct.tokens > 0 AND ct.date >= v_bg_start - INTERVAL '5 minutes' AND ct.date <= v_bg_end + INTERVAL '30 minutes'),
  coin_total AS (SELECT COALESCE(SUM(st.tokens), 0)::BIGINT AS c_total FROM session_tx st),
  coin_type_agg AS (SELECT COALESCE(jsonb_object_agg(t.ctype, t.sum_tokens), '{}'::JSONB) AS c_by_type FROM (SELECT st.type AS ctype, SUM(st.tokens)::BIGINT AS sum_tokens FROM session_tx st GROUP BY st.type) t),
  coin_user_agg AS (
    SELECT st.user_name, SUM(st.tokens)::BIGINT AS user_tokens, ARRAY_AGG(DISTINCT st.type) AS user_types,
      EXISTS (SELECT 1 FROM public.coin_transactions older WHERE older.account_id = p_account_id AND (older.cast_name = v_cast OR older.cast_name IS NULL)
        AND older.user_name = st.user_name AND older.date < v_bg_start - INTERVAL '5 minutes' AND older.tokens > 0) AS has_prior
    FROM session_tx st GROUP BY st.user_name
  ),
  coin_user_stats AS (SELECT COUNT(*) FILTER (WHERE NOT cua.has_prior)::INTEGER AS new_u, COUNT(*) FILTER (WHERE cua.has_prior)::INTEGER AS ret_u FROM coin_user_agg cua),
  coin_top5 AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('username', cua.user_name, 'tokens', cua.user_tokens, 'types', cua.user_types, 'is_new', NOT cua.has_prior) ORDER BY cua.user_tokens DESC), '[]'::JSONB) AS top_list
    FROM (SELECT * FROM coin_user_agg ORDER BY user_tokens DESC LIMIT 10) cua
  )
  SELECT v_session_ids[1], v_session_ids, v_cast,
    (SELECT MAX(s.broadcast_title) FROM public.sessions s WHERE s.session_id::TEXT = ANY(v_session_ids)),
    v_bg_start, v_bg_end, ROUND(EXTRACT(EPOCH FROM (v_bg_end - v_bg_start)) / 60, 1),
    sa.sa_msg_count, sa.sa_unique_users, sa.sa_chat_tokens, sa.sa_tip_count,
    tb.tbt, t5c.top_list, ct_total.c_total, cta.c_by_type, ct5.top_list,
    COALESCE(cus.new_u, 0), COALESCE(cus.ret_u, 0), GREATEST(sa.sa_chat_tokens, ct_total.c_total)::BIGINT,
    v_prev_bg_id, v_prev_revenue, v_prev_bg_start,
    CASE WHEN v_prev_revenue IS NOT NULL AND v_prev_revenue > 0
      THEN ROUND((GREATEST(sa.sa_chat_tokens, ct_total.c_total)::NUMERIC - v_prev_revenue) / v_prev_revenue * 100, 1) ELSE NULL END
  FROM spy_agg sa CROSS JOIN type_breakdown tb CROSS JOIN top5_chat t5c CROSS JOIN coin_total ct_total
  CROSS JOIN coin_type_agg cta CROSS JOIN coin_user_stats cus CROSS JOIN coin_top5 ct5;
END;
$fn$;

-- 5-3. get_transcript_timeline — return type change: user_name → username
DROP FUNCTION IF EXISTS public.get_transcript_timeline(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_transcript_timeline(p_account_id UUID, p_cast_name TEXT, p_session_id TEXT)
RETURNS TABLE(
  event_time TIMESTAMPTZ, event_type TEXT, username TEXT, message TEXT,
  tokens INTEGER, coin_type TEXT, confidence NUMERIC, elapsed_sec INTEGER, is_highlight BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_session_start TIMESTAMPTZ; v_session_end TIMESTAMPTZ; v_recording_start TIMESTAMPTZ;
BEGIN
  SELECT MIN(cl."timestamp"), MAX(cl."timestamp")
    INTO v_session_start, v_session_end
    FROM public.chat_logs cl
   WHERE cl.account_id = p_account_id AND cl.cast_name = p_cast_name AND cl.session_id = p_session_id::UUID;
  IF v_session_start IS NULL THEN RETURN; END IF;

  SELECT ct.recording_started_at INTO v_recording_start
    FROM public.cast_transcripts ct
   WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name AND ct.session_id = p_session_id::UUID
     AND ct.recording_started_at IS NOT NULL LIMIT 1;

  RETURN QUERY
  WITH
  transcripts AS (
    SELECT COALESCE(ct.absolute_start_at,
        CASE WHEN v_recording_start IS NOT NULL AND ct.segment_start_seconds IS NOT NULL
             THEN v_recording_start + (ct.segment_start_seconds || ' seconds')::INTERVAL
             ELSE v_session_start + COALESCE((ct.segment_start_seconds || ' seconds')::INTERVAL, INTERVAL '0') END
      ) AS evt_time,
      'transcript'::TEXT AS evt_type, NULL::TEXT AS evt_user, ct.text AS evt_message,
      0::INTEGER AS evt_tokens, NULL::TEXT AS evt_coin_type, ct.confidence AS evt_confidence
    FROM public.cast_transcripts ct
    WHERE ct.account_id = p_account_id AND ct.cast_name = p_cast_name
      AND ct.session_id = p_session_id::UUID AND ct.processing_status = 'completed'
  ),
  spy AS (
    SELECT cl."timestamp" AS evt_time,
      CASE WHEN cl.tokens > 0 THEN 'tip' WHEN cl.message_type = 'enter' THEN 'enter'
           WHEN cl.message_type = 'leave' THEN 'leave' ELSE 'chat' END::TEXT AS evt_type,
      cl.username AS evt_user, cl.message AS evt_message,
      COALESCE(cl.tokens, 0)::INTEGER AS evt_tokens, NULL::TEXT AS evt_coin_type, NULL::NUMERIC AS evt_confidence
    FROM public.chat_logs cl
    WHERE cl.account_id = p_account_id AND cl.cast_name = p_cast_name AND cl.session_id = p_session_id::UUID
  ),
  coins AS (
    SELECT coin.date AS evt_time, 'coin'::TEXT AS evt_type, coin.user_name AS evt_user,
      coin.source_detail AS evt_message, coin.tokens::INTEGER AS evt_tokens,
      coin.type AS evt_coin_type, NULL::NUMERIC AS evt_confidence
    FROM public.coin_transactions coin
    WHERE coin.account_id = p_account_id AND coin.cast_name = p_cast_name
      AND coin.date >= v_session_start - INTERVAL '5 minutes' AND coin.date <= v_session_end + INTERVAL '5 minutes'
  ),
  merged AS (SELECT * FROM transcripts UNION ALL SELECT * FROM spy UNION ALL SELECT * FROM coins),
  payment_times AS (SELECT evt_time FROM merged WHERE evt_type IN ('tip', 'coin') AND evt_tokens > 0)
  SELECT m.evt_time, m.evt_type, m.evt_user, m.evt_message, m.evt_tokens,
    m.evt_coin_type, m.evt_confidence,
    EXTRACT(EPOCH FROM (m.evt_time - v_session_start))::INTEGER,
    (m.evt_type = 'transcript' AND EXISTS (
      SELECT 1 FROM payment_times pt WHERE pt.evt_time BETWEEN m.evt_time - INTERVAL '30 seconds' AND m.evt_time + INTERVAL '30 seconds'
    ))::BOOLEAN
  FROM merged m ORDER BY m.evt_time ASC, m.evt_type ASC;
END;
$fn$;

-- 5-4. check_spy_data_integrity — updated to check new tables
CREATE OR REPLACE FUNCTION public.check_spy_data_integrity()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_result JSONB := '{}';
  v_row RECORD;
  v_arr JSONB;
BEGIN
  -- 1. chat_logs vs sessions cast_name mismatch
  SELECT jsonb_agg(row_to_json(t)) INTO v_arr
  FROM (SELECT cl.cast_name AS msg_cast_name, s.cast_name AS session_cast_name, cl.session_id::TEXT AS session_id, COUNT(*) AS mismatch_count
    FROM public.chat_logs cl INNER JOIN public.sessions s ON s.session_id = cl.session_id
    WHERE cl.session_id IS NOT NULL AND cl.cast_name IS NOT NULL AND s.cast_name IS NOT NULL AND cl.cast_name != s.cast_name
    GROUP BY cl.cast_name, s.cast_name, cl.session_id ORDER BY COUNT(*) DESC LIMIT 20) t;
  v_result := v_result || jsonb_build_object('chat_logs_session_cast_mismatch', jsonb_build_object('count', COALESCE(jsonb_array_length(v_arr), 0), 'description', 'chat_logsのcast_nameとsessionsのcast_nameが不一致', 'sample', COALESCE(v_arr, '[]'::jsonb)));

  -- 2. viewer_snapshots vs sessions cast_name mismatch
  SELECT jsonb_agg(row_to_json(t)) INTO v_arr
  FROM (SELECT vs.cast_name AS viewer_cast_name, s.cast_name AS session_cast_name, vs.session_id::TEXT AS session_id, COUNT(*) AS mismatch_count
    FROM public.viewer_snapshots vs INNER JOIN public.sessions s ON s.session_id = vs.session_id
    WHERE vs.session_id IS NOT NULL AND vs.cast_name IS NOT NULL AND s.cast_name IS NOT NULL AND vs.cast_name != s.cast_name
    GROUP BY vs.cast_name, s.cast_name, vs.session_id ORDER BY COUNT(*) DESC LIMIT 20) t;
  v_result := v_result || jsonb_build_object('viewer_snapshots_session_cast_mismatch', jsonb_build_object('count', COALESCE(jsonb_array_length(v_arr), 0), 'description', 'viewer_snapshotsのcast_nameとsessionsのcast_nameが不一致', 'sample', COALESCE(v_arr, '[]'::jsonb)));

  -- 3. sessions: duplicate within 5 min
  SELECT jsonb_agg(row_to_json(t)) INTO v_arr
  FROM (SELECT s1.cast_name, s1.session_id::TEXT AS session_a, s2.session_id::TEXT AS session_b,
    s1.started_at AS start_a, s2.started_at AS start_b, ABS(EXTRACT(EPOCH FROM (s1.started_at - s2.started_at))) AS diff_seconds
    FROM public.sessions s1 INNER JOIN public.sessions s2 ON s1.account_id = s2.account_id AND s1.cast_name = s2.cast_name AND s1.session_id < s2.session_id AND ABS(EXTRACT(EPOCH FROM (s1.started_at - s2.started_at))) < 300
    WHERE s1.started_at > NOW() - INTERVAL '30 days' ORDER BY s1.started_at DESC LIMIT 30) t;
  v_result := v_result || jsonb_build_object('sessions_duplicate_physical', jsonb_build_object('count', COALESCE(jsonb_array_length(v_arr), 0), 'description', '同一キャストで5分以内に開始した複数セッション', 'sample', COALESCE(v_arr, '[]'::jsonb)));

  -- 4. chat_logs: empty cast_name
  SELECT COUNT(*) INTO v_row FROM public.chat_logs WHERE cast_name IS NULL OR cast_name = '';
  v_result := v_result || jsonb_build_object('chat_logs_empty_cast_name', jsonb_build_object('count', COALESCE(v_row.count, 0), 'description', 'chat_logsでcast_nameが空/NULLのレコード数'));

  -- 5. user_profiles: NULL segment count
  SELECT COUNT(*) INTO v_row FROM public.user_profiles WHERE segment IS NULL;
  v_result := v_result || jsonb_build_object('user_profiles_null_segment', jsonb_build_object('count', COALESCE(v_row.count, 0), 'description', 'user_profilesでsegmentがNULLのレコード数'));

  -- 6. data sync check: chat_logs vs spy_messages count comparison
  v_result := v_result || jsonb_build_object('sync_comparison', jsonb_build_object(
    'spy_messages_count', (SELECT COUNT(*) FROM public.spy_messages),
    'chat_logs_count', (SELECT COUNT(*) FROM public.chat_logs),
    'paid_users_count', (SELECT COUNT(*) FROM public.paid_users),
    'user_profiles_count', (SELECT COUNT(*) FROM public.user_profiles),
    'description', '旧テーブルと新テーブルの件数比較'
  ));

  RETURN v_result;
END;
$fn$;

-- ############################################################
-- Section 6: Schema cache refresh
-- ############################################################
NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE 'Migration 100 完了: 全RPCを新テーブル(chat_logs/user_profiles)参照に切り替え';
  RAISE NOTICE '同期トリガー: spy_messages→chat_logs, paid_users→user_profiles 設定済み';
END $$;
