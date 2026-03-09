-- ============================================================
-- Migration 099: v1テーブル → v2テーブルへのデータマイグレーション
--
-- 移行対象:
--   spy_messages   → chat_logs        (カラム名正規化、unknown除外、msg_type正規化)
--   spy_viewers    → viewer_snapshots  (セッション別JSONB集約、unknown除外)
--   paid_users     → user_profiles    (cast_name必須化、first_seen/last_seen算出)
--
-- 注意:
--   - 旧テーブルはそのまま残す（並行運用）
--   - 冪等: ON CONFLICT DO NOTHING / IF NOT EXISTS で再実行安全
--   - 移行後に件数整合性チェックを実行
--
-- ROLLBACK:
--   TRUNCATE public.chat_logs;
--   TRUNCATE public.viewer_snapshots;
--   TRUNCATE public.user_profiles;
-- ============================================================

-- ============================================================
-- 1. spy_messages → chat_logs
-- ============================================================
-- 除外条件:
--   - user_name IS NULL / '' / 'unknown' / 'Unknown' / 'undefined' / 'null'
--   - cast_name IS NULL / ''
--   - account_id IS NULL
-- 正規化:
--   - msg_type → message_type: 小文字化、chat/tip/system以外は'chat'にフォールバック
--   - tokens > 0 かつ msg_type='chat' → 'tip' に補正
--   - tokens: 負数は0に切り上げ
--   - is_vip → metadata に統合

DO $$
DECLARE
  v_inserted_chat BIGINT;
  v_source_chat BIGINT;
  v_excluded_chat BIGINT;
BEGIN
  RAISE NOTICE '=== spy_messages → chat_logs 開始 ===';

  -- 移行元の件数（フィルタ前）
  SELECT COUNT(*) INTO v_source_chat FROM public.spy_messages;
  RAISE NOTICE 'spy_messages 総件数: %', v_source_chat;

  -- データ挿入
  INSERT INTO public.chat_logs (
    cast_name,
    account_id,
    session_id,
    username,
    message,
    message_type,
    tokens,
    timestamp,
    metadata,
    created_at
  )
  SELECT
    sm.cast_name,
    sm.account_id,
    -- session_id: sessionsテーブルに存在しないものはNULLに
    CASE WHEN s.session_id IS NOT NULL THEN sm.session_id ELSE NULL END,
    TRIM(sm.user_name),
    COALESCE(TRIM(sm.message), ''),
    -- msg_type 正規化: 小文字化 → chat/tip/system のいずれか → tokens>0+chat→tip補正
    CASE
      WHEN LOWER(sm.msg_type) IN ('tip', 'system') THEN LOWER(sm.msg_type)
      WHEN LOWER(sm.msg_type) = 'chat' AND COALESCE(sm.tokens, 0) > 0 THEN 'tip'
      ELSE 'chat'
    END,
    GREATEST(COALESCE(sm.tokens, 0), 0)::BIGINT,
    sm.message_time,
    -- is_vip を metadata に統合
    CASE
      WHEN sm.is_vip = true THEN
        COALESCE(sm.metadata, '{}'::JSONB) || '{"is_vip": true}'::JSONB
      ELSE
        COALESCE(sm.metadata, '{}'::JSONB)
    END,
    sm.created_at
  FROM public.spy_messages sm
  LEFT JOIN public.sessions s ON s.session_id = sm.session_id
  WHERE
    -- 必須フィールドチェック
    sm.account_id IS NOT NULL
    AND sm.cast_name IS NOT NULL
    AND sm.cast_name != ''
    -- unknown/無効ユーザー除外
    AND sm.user_name IS NOT NULL
    AND TRIM(sm.user_name) != ''
    AND LOWER(TRIM(sm.user_name)) NOT IN ('unknown', 'undefined', 'null')
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted_chat = ROW_COUNT;
  v_excluded_chat := v_source_chat - v_inserted_chat;

  RAISE NOTICE 'chat_logs 挿入件数: % (除外: %)', v_inserted_chat, v_excluded_chat;
END $$;


-- ============================================================
-- 2. spy_viewers → viewer_snapshots
-- ============================================================
-- 変換ロジック:
--   spy_viewers は (account_id, cast_name, user_name, session_id) 単位の行
--   → session_id ごとに全viewer を JSONB配列に集約
--   → snapshot_at = そのセッション内の最新 last_seen_at
--   → unknown/空ユーザー除外

DO $$
DECLARE
  v_inserted_viewer BIGINT;
  v_source_viewer BIGINT;
  v_source_sessions BIGINT;
BEGIN
  RAISE NOTICE '=== spy_viewers → viewer_snapshots 開始 ===';

  SELECT COUNT(*) INTO v_source_viewer FROM public.spy_viewers;
  SELECT COUNT(DISTINCT (account_id, cast_name, session_id))
    INTO v_source_sessions FROM public.spy_viewers
    WHERE session_id IS NOT NULL;
  RAISE NOTICE 'spy_viewers 総件数: %, セッション数: %', v_source_viewer, v_source_sessions;

  INSERT INTO public.viewer_snapshots (
    cast_name,
    account_id,
    session_id,
    snapshot_at,
    viewer_count,
    viewers,
    created_at
  )
  SELECT
    sv_agg.cast_name,
    sv_agg.account_id,
    sv_agg.session_id,
    sv_agg.snapshot_at,
    sv_agg.viewer_count,
    sv_agg.viewers,
    sv_agg.snapshot_at  -- created_at = snapshot_at
  FROM (
    SELECT
      sv.cast_name,
      sv.account_id,
      -- session_id: sessionsテーブルに存在するもののみ（FK制約対応）
      CASE WHEN s.session_id IS NOT NULL THEN sv.session_id::UUID ELSE NULL END AS session_id,
      MAX(sv.last_seen_at) AS snapshot_at,
      COUNT(*)::INTEGER AS viewer_count,
      JSONB_AGG(
        JSONB_BUILD_OBJECT(
          'username', TRIM(sv.user_name),
          'league', sv.league,
          'level', sv.level,
          'is_fan_club', COALESCE(sv.is_fan_club, false),
          'visit_count', COALESCE(sv.visit_count, 1)
        )
        ORDER BY COALESCE(sv.level, 0) DESC
      ) AS viewers
    FROM public.spy_viewers sv
    LEFT JOIN public.sessions s ON s.session_id::TEXT = sv.session_id
    WHERE
      sv.session_id IS NOT NULL
      AND sv.account_id IS NOT NULL
      AND sv.cast_name IS NOT NULL
      AND sv.cast_name != ''
      AND sv.user_name IS NOT NULL
      AND TRIM(sv.user_name) != ''
      AND LOWER(TRIM(sv.user_name)) NOT IN ('unknown', 'undefined', 'null')
    GROUP BY sv.account_id, sv.cast_name, sv.session_id, s.session_id
  ) sv_agg
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted_viewer = ROW_COUNT;
  RAISE NOTICE 'viewer_snapshots 挿入件数: % (元セッション: %)', v_inserted_viewer, v_source_sessions;
END $$;


-- ============================================================
-- 3. paid_users → user_profiles
-- ============================================================
-- 変換ロジック:
--   - cast_name 必須 → NULL/空のレコードは除外
--   - user_name → username (TRIM)
--   - total_coins → total_tokens (INTEGER→BIGINT)
--   - first_payment_date → first_seen (NULL時はcreated_atで代替)
--   - last_payment_date → last_seen (NULL時はupdated_atで代替)
--   - segment はそのまま移行
--   - user_id_stripchat, profile_url, user_level → metadata JSONB
--   - visit_count → spy_viewers から算出

DO $$
DECLARE
  v_inserted_profile BIGINT;
  v_source_paid BIGINT;
  v_excluded_paid BIGINT;
BEGIN
  RAISE NOTICE '=== paid_users → user_profiles 開始 ===';

  SELECT COUNT(*) INTO v_source_paid FROM public.paid_users;
  RAISE NOTICE 'paid_users 総件数: %', v_source_paid;

  INSERT INTO public.user_profiles (
    cast_name,
    account_id,
    username,
    first_seen,
    last_seen,
    total_tokens,
    visit_count,
    segment,
    segment_updated_at,
    metadata,
    created_at,
    updated_at
  )
  SELECT
    pu.cast_name,
    pu.account_id,
    TRIM(pu.user_name),
    -- first_seen: first_payment_date > created_at の順でフォールバック
    COALESCE(pu.first_payment_date, pu.created_at, NOW()),
    -- last_seen: last_payment_date > updated_at の順でフォールバック
    COALESCE(pu.last_payment_date, pu.updated_at, NOW()),
    COALESCE(pu.total_coins, 0)::BIGINT,
    -- visit_count: spy_viewers から集計
    COALESCE(vc.total_visits, 0),
    pu.segment,
    CASE WHEN pu.segment IS NOT NULL THEN NOW() ELSE NULL END,
    -- metadata: 旧カラムを統合
    JSONB_BUILD_OBJECT(
      'user_id_stripchat', pu.user_id_stripchat,
      'profile_url', pu.profile_url,
      'user_level', pu.user_level,
      'tx_count', pu.tx_count
    ) - ARRAY(
      -- NULL値のキーを除去
      SELECT key FROM JSONB_EACH(
        JSONB_BUILD_OBJECT(
          'user_id_stripchat', pu.user_id_stripchat,
          'profile_url', pu.profile_url,
          'user_level', pu.user_level,
          'tx_count', pu.tx_count
        )
      ) WHERE value = 'null'::JSONB
    ),
    COALESCE(pu.created_at, NOW()),
    COALESCE(pu.updated_at, NOW())
  FROM public.paid_users pu
  LEFT JOIN (
    -- spy_viewers から visit_count を集計
    SELECT
      account_id,
      cast_name,
      user_name,
      SUM(visit_count) AS total_visits
    FROM public.spy_viewers
    WHERE user_name IS NOT NULL AND cast_name IS NOT NULL
    GROUP BY account_id, cast_name, user_name
  ) vc ON vc.account_id = pu.account_id
       AND vc.cast_name = pu.cast_name
       AND vc.user_name = pu.user_name
  WHERE
    -- cast_name 必須
    pu.cast_name IS NOT NULL
    AND pu.cast_name != ''
    -- account_id / user_name 必須
    AND pu.account_id IS NOT NULL
    AND pu.user_name IS NOT NULL
    AND TRIM(pu.user_name) != ''
    AND LOWER(TRIM(pu.user_name)) NOT IN ('unknown', 'undefined', 'null')
  ON CONFLICT (account_id, cast_name, username) DO NOTHING;

  GET DIAGNOSTICS v_inserted_profile = ROW_COUNT;
  v_excluded_paid := v_source_paid - v_inserted_profile;

  RAISE NOTICE 'user_profiles 挿入件数: % (除外: %)', v_inserted_profile, v_excluded_paid;
END $$;


-- ============================================================
-- 4. 整合性チェック
-- ============================================================
DO $$
DECLARE
  -- spy_messages / chat_logs
  v_spy_total BIGINT;
  v_spy_valid BIGINT;
  v_chat_total BIGINT;
  v_chat_diff BIGINT;
  -- spy_viewers / viewer_snapshots
  v_viewer_total BIGINT;
  v_viewer_sessions BIGINT;
  v_snapshot_total BIGINT;
  v_snapshot_diff BIGINT;
  -- paid_users / user_profiles
  v_paid_total BIGINT;
  v_paid_valid BIGINT;
  v_profile_total BIGINT;
  v_profile_diff BIGINT;
  -- トークン整合性
  v_spy_tokens BIGINT;
  v_chat_tokens BIGINT;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '╔══════════════════════════════════════════════╗';
  RAISE NOTICE '║       データマイグレーション整合性チェック       ║';
  RAISE NOTICE '╠══════════════════════════════════════════════╣';

  -- ── chat_logs チェック ──
  SELECT COUNT(*) INTO v_spy_total FROM public.spy_messages;

  SELECT COUNT(*) INTO v_spy_valid
  FROM public.spy_messages
  WHERE account_id IS NOT NULL
    AND cast_name IS NOT NULL AND cast_name != ''
    AND user_name IS NOT NULL AND TRIM(user_name) != ''
    AND LOWER(TRIM(user_name)) NOT IN ('unknown', 'undefined', 'null');

  SELECT COUNT(*) INTO v_chat_total FROM public.chat_logs;
  v_chat_diff := v_spy_valid - v_chat_total;

  RAISE NOTICE '║ spy_messages (全件)      : %', LPAD(v_spy_total::TEXT, 10);
  RAISE NOTICE '║ spy_messages (有効)      : %', LPAD(v_spy_valid::TEXT, 10);
  RAISE NOTICE '║ chat_logs                : %', LPAD(v_chat_total::TEXT, 10);
  RAISE NOTICE '║ chat_logs 差分           : %', LPAD(v_chat_diff::TEXT, 10);

  -- トークン整合性
  SELECT COALESCE(SUM(GREATEST(tokens, 0)), 0) INTO v_spy_tokens
  FROM public.spy_messages
  WHERE account_id IS NOT NULL
    AND cast_name IS NOT NULL AND cast_name != ''
    AND user_name IS NOT NULL AND TRIM(user_name) != ''
    AND LOWER(TRIM(user_name)) NOT IN ('unknown', 'undefined', 'null');

  SELECT COALESCE(SUM(tokens), 0) INTO v_chat_tokens FROM public.chat_logs;

  RAISE NOTICE '║ spy_messages tokens合計  : %', LPAD(v_spy_tokens::TEXT, 10);
  RAISE NOTICE '║ chat_logs tokens合計     : %', LPAD(v_chat_tokens::TEXT, 10);
  RAISE NOTICE '║ tokens差分              : %', LPAD((v_spy_tokens - v_chat_tokens)::TEXT, 10);
  RAISE NOTICE '╠──────────────────────────────────────────────╣';

  -- ── viewer_snapshots チェック ──
  SELECT COUNT(*) INTO v_viewer_total FROM public.spy_viewers;

  SELECT COUNT(DISTINCT (account_id, cast_name, session_id))
  INTO v_viewer_sessions
  FROM public.spy_viewers
  WHERE session_id IS NOT NULL
    AND account_id IS NOT NULL
    AND cast_name IS NOT NULL AND cast_name != ''
    AND user_name IS NOT NULL AND TRIM(user_name) != ''
    AND LOWER(TRIM(user_name)) NOT IN ('unknown', 'undefined', 'null');

  SELECT COUNT(*) INTO v_snapshot_total FROM public.viewer_snapshots;
  v_snapshot_diff := v_viewer_sessions - v_snapshot_total;

  RAISE NOTICE '║ spy_viewers (全件)       : %', LPAD(v_viewer_total::TEXT, 10);
  RAISE NOTICE '║ spy_viewers (有効session) : %', LPAD(v_viewer_sessions::TEXT, 10);
  RAISE NOTICE '║ viewer_snapshots         : %', LPAD(v_snapshot_total::TEXT, 10);
  RAISE NOTICE '║ snapshots差分            : %', LPAD(v_snapshot_diff::TEXT, 10);
  RAISE NOTICE '╠──────────────────────────────────────────────╣';

  -- ── user_profiles チェック ──
  SELECT COUNT(*) INTO v_paid_total FROM public.paid_users;

  SELECT COUNT(*) INTO v_paid_valid
  FROM public.paid_users
  WHERE cast_name IS NOT NULL AND cast_name != ''
    AND account_id IS NOT NULL
    AND user_name IS NOT NULL AND TRIM(user_name) != ''
    AND LOWER(TRIM(user_name)) NOT IN ('unknown', 'undefined', 'null');

  SELECT COUNT(*) INTO v_profile_total FROM public.user_profiles;
  v_profile_diff := v_paid_valid - v_profile_total;

  RAISE NOTICE '║ paid_users (全件)        : %', LPAD(v_paid_total::TEXT, 10);
  RAISE NOTICE '║ paid_users (有効)        : %', LPAD(v_paid_valid::TEXT, 10);
  RAISE NOTICE '║ user_profiles            : %', LPAD(v_profile_total::TEXT, 10);
  RAISE NOTICE '║ profiles差分             : %', LPAD(v_profile_diff::TEXT, 10);
  RAISE NOTICE '╠──────────────────────────────────────────────╣';

  -- ── 判定 ──
  IF v_chat_diff = 0 AND v_snapshot_diff = 0 AND v_profile_diff = 0 AND (v_spy_tokens - v_chat_tokens) = 0 THEN
    RAISE NOTICE '║ ✅ 全テーブル整合性OK                        ║';
  ELSE
    IF v_chat_diff != 0 THEN
      RAISE NOTICE '║ ⚠ chat_logs: % 件の差分あり', v_chat_diff;
    END IF;
    IF v_snapshot_diff != 0 THEN
      RAISE NOTICE '║ ⚠ viewer_snapshots: % 件の差分あり', v_snapshot_diff;
    END IF;
    IF v_profile_diff != 0 THEN
      RAISE NOTICE '║ ⚠ user_profiles: % 件の差分あり', v_profile_diff;
    END IF;
    IF (v_spy_tokens - v_chat_tokens) != 0 THEN
      RAISE NOTICE '║ ⚠ tokens合計: % の差分あり', (v_spy_tokens - v_chat_tokens);
    END IF;
  END IF;

  RAISE NOTICE '╚══════════════════════════════════════════════╝';
END $$;


-- ============================================================
-- 5. 完了通知 + PostgREST キャッシュリフレッシュ
-- ============================================================
NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  RAISE NOTICE 'Migration 099 完了: spy_messages→chat_logs, spy_viewers→viewer_snapshots, paid_users→user_profiles データ移行完了';
  RAISE NOTICE '旧テーブルはそのまま残存（並行運用）';
END $$;
