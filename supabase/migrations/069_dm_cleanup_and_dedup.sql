-- ============================================================
-- 069: P0-4 テストデータ削除 RPC + P0-5 DM二重送信防止
-- ============================================================

-- ============================================================
-- P0-4: テストデータ件数カウント + 削除 RPC
-- campaign が test/bulk パターンにマッチするレコードを対象
-- ============================================================

-- 件数カウント（削除前の確認用）
CREATE OR REPLACE FUNCTION public.count_test_dm_data(
  p_account_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_test_count  INTEGER;
  v_bulk_count  INTEGER;
  v_total       INTEGER;
BEGIN
  IF p_account_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_test_count
    FROM public.dm_send_log
    WHERE account_id = p_account_id
      AND campaign ~* '(^|_)test($|_)';

    SELECT COUNT(*) INTO v_bulk_count
    FROM public.dm_send_log
    WHERE account_id = p_account_id
      AND campaign ~* '(^|_)bulk($|_)';
  ELSE
    SELECT COUNT(*) INTO v_test_count
    FROM public.dm_send_log
    WHERE campaign ~* '(^|_)test($|_)';

    SELECT COUNT(*) INTO v_bulk_count
    FROM public.dm_send_log
    WHERE campaign ~* '(^|_)bulk($|_)';
  END IF;

  v_total := v_test_count + v_bulk_count;

  RETURN jsonb_build_object(
    'test_count', v_test_count,
    'bulk_count', v_bulk_count,
    'total', v_total
  );
END;
$$;

-- テストデータ削除
CREATE OR REPLACE FUNCTION public.cleanup_test_dm_data(
  p_account_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_account_id IS NOT NULL THEN
    DELETE FROM public.dm_send_log
    WHERE account_id = p_account_id
      AND (
        campaign ~* '(^|_)test($|_)'
        OR campaign ~* '(^|_)bulk($|_)'
      );
  ELSE
    DELETE FROM public.dm_send_log
    WHERE campaign ~* '(^|_)test($|_)'
       OR campaign ~* '(^|_)bulk($|_)';
  END IF;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'timestamp', NOW()
  );
END;
$$;


-- ============================================================
-- P0-5: DM二重送信防止チェック RPC
-- 同一 account_id + cast_name + user_name で
-- 24時間以内に送信済み（status != 'error'）のレコードがあるかチェック
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_dm_duplicate(
  p_account_id UUID,
  p_cast_name TEXT,
  p_user_names TEXT[],
  p_hours INTEGER DEFAULT 24
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ;
  v_duplicates TEXT[];
BEGIN
  v_cutoff := NOW() - (p_hours || ' hours')::INTERVAL;

  -- 24時間以内に送信済み（error以外）のユーザーを検出
  SELECT ARRAY_AGG(DISTINCT user_name)
  INTO v_duplicates
  FROM public.dm_send_log
  WHERE account_id = p_account_id
    AND cast_name = p_cast_name
    AND user_name = ANY(p_user_names)
    AND status != 'error'
    AND queued_at >= v_cutoff;

  IF v_duplicates IS NULL THEN
    v_duplicates := '{}';
  END IF;

  RETURN jsonb_build_object(
    'duplicates', to_jsonb(v_duplicates),
    'duplicate_count', array_length(v_duplicates, 1),
    'checked_count', array_length(p_user_names, 1),
    'cutoff', v_cutoff
  );
END;
$$;


-- ============================================================
-- P0-5: create_dm_batch に重複チェック組み込み
-- 既存RPCを置き換え
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_dm_batch(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_targets TEXT[] DEFAULT '{}',
  p_message TEXT DEFAULT '',
  p_template_name TEXT DEFAULT NULL,
  p_skip_duplicates BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_used INTEGER;
  v_limit INTEGER;
  v_remaining INTEGER;
  v_batch_id TEXT;
  v_count INTEGER := 0;
  v_skipped INTEGER := 0;
  v_target TEXT;
  v_effective_targets TEXT[];
  v_dup_users TEXT[];
  v_cutoff TIMESTAMPTZ;
BEGIN
  -- アカウント所有者を確認
  SELECT a.user_id INTO v_user_id
  FROM public.accounts a
  WHERE a.id = p_account_id;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'アカウントが見つかりません');
  END IF;

  -- 呼び出し元ユーザーがアカウント所有者であることを確認
  IF v_user_id != auth.uid() THEN
    RETURN jsonb_build_object('error', '権限がありません');
  END IF;

  -- プラン上限チェック
  SELECT p.dm_used_this_month, p.max_dm_per_month
  INTO v_used, v_limit
  FROM public.profiles p
  WHERE p.id = v_user_id;

  v_remaining := v_limit - v_used;
  IF v_remaining <= 0 THEN
    RETURN jsonb_build_object(
      'error', '今月のDM送信上限に達しました',
      'used', v_used,
      'limit', v_limit
    );
  END IF;

  -- ターゲットを上限までに制限
  v_effective_targets := p_targets[1:LEAST(array_length(p_targets, 1), v_remaining)];

  -- P0-5: 24時間以内の重複チェック
  IF p_skip_duplicates AND p_cast_name IS NOT NULL THEN
    v_cutoff := NOW() - INTERVAL '24 hours';

    SELECT ARRAY_AGG(DISTINCT user_name)
    INTO v_dup_users
    FROM public.dm_send_log
    WHERE account_id = p_account_id
      AND cast_name = p_cast_name
      AND user_name = ANY(v_effective_targets)
      AND status != 'error'
      AND queued_at >= v_cutoff;

    IF v_dup_users IS NOT NULL THEN
      -- 重複ユーザーを除外
      v_effective_targets := ARRAY(
        SELECT unnest(v_effective_targets)
        EXCEPT
        SELECT unnest(v_dup_users)
      );
      v_skipped := COALESCE(array_length(v_dup_users, 1), 0);
    END IF;

    -- 全員重複でスキップされた場合
    IF array_length(v_effective_targets, 1) IS NULL OR array_length(v_effective_targets, 1) = 0 THEN
      RETURN jsonb_build_object(
        'batch_id', NULL,
        'count', 0,
        'skipped', v_skipped,
        'reason', '全対象が24時間以内に送信済みです'
      );
    END IF;
  END IF;

  -- バッチID生成
  v_batch_id := 'batch_' || to_char(NOW() AT TIME ZONE 'JST', 'YYYYMMDD_HH24MISS') || '_' || LEFT(p_account_id::TEXT, 8);

  -- dm_send_log にキュー登録（cast_name 含む）
  FOREACH v_target IN ARRAY v_effective_targets
  LOOP
    INSERT INTO public.dm_send_log (
      account_id, cast_name, user_name, message, status, campaign, template_name
    ) VALUES (
      p_account_id, p_cast_name, v_target, p_message, 'queued', v_batch_id, COALESCE(p_template_name, '')
    );
    v_count := v_count + 1;
  END LOOP;

  -- 使用カウンター更新
  UPDATE public.profiles
  SET dm_used_this_month = dm_used_this_month + v_count
  WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'batch_id', v_batch_id,
    'count', v_count,
    'skipped', COALESCE(v_skipped, 0)
  );
END;
$$;


-- ============================================================
-- P0-5: dm_send_log にインデックス追加（重複チェック高速化）
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_dm_send_log_dedup
  ON public.dm_send_log (account_id, cast_name, user_name, queued_at DESC)
  WHERE status != 'error';
