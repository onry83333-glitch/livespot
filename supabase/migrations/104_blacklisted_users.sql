-- Migration 104: blacklisted_users テーブル + create_dm_batch ブラックリストフィルタ
-- ブラックリスト機能: 特定ユーザーへのDM送信を永続的にブロック
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.blacklisted_users CASCADE;
--   -- create_dm_batch RPCは旧版に戻す必要あり（Migration 045/059参照）

-- ============================================================
-- 1. blacklisted_users テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS public.blacklisted_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  cast_name TEXT NOT NULL,
  user_name TEXT NOT NULL,
  reason TEXT,
  blocked_by TEXT DEFAULT 'manual',  -- 'manual' | 'auto' | 'system'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, cast_name, user_name)
);

-- RLS
ALTER TABLE public.blacklisted_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blacklisted_users_select" ON public.blacklisted_users
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY "blacklisted_users_insert" ON public.blacklisted_users
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

CREATE POLICY "blacklisted_users_delete" ON public.blacklisted_users
  FOR DELETE USING (account_id IN (SELECT user_account_ids()));

-- インデックス
CREATE INDEX IF NOT EXISTS idx_blacklisted_users_lookup
  ON public.blacklisted_users(account_id, cast_name, user_name);

-- ============================================================
-- 2. check_blacklisted_users RPC
--    指定ユーザー名リストからブラックリスト該当者を返す
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_blacklisted_users(
  p_account_id UUID,
  p_cast_name TEXT,
  p_user_names TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_blocked TEXT[];
BEGIN
  SELECT ARRAY_AGG(bu.user_name)
  INTO v_blocked
  FROM public.blacklisted_users bu
  WHERE bu.account_id = p_account_id
    AND bu.cast_name = p_cast_name
    AND bu.user_name = ANY(p_user_names);

  IF v_blocked IS NULL THEN
    v_blocked := ARRAY[]::TEXT[];
  END IF;

  RETURN jsonb_build_object(
    'blocked', to_jsonb(v_blocked),
    'blocked_count', array_length(v_blocked, 1)
  );
END;
$$;

-- ============================================================
-- 3. create_dm_batch にブラックリストフィルタを追加
--    既存RPCをDROP→再作成（引数変更なし、内部ロジック追加）
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_dm_batch(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_targets TEXT[] DEFAULT '{}',
  p_message TEXT DEFAULT '',
  p_template_name TEXT DEFAULT NULL,
  p_skip_duplicates BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_plan TEXT;
  v_limit INTEGER;
  v_used INTEGER;
  v_remaining INTEGER;
  v_filtered TEXT[];
  v_blacklisted TEXT[];
  v_blacklisted_count INTEGER := 0;
  v_count INTEGER;
  v_batch_id TEXT;
  v_now TIMESTAMPTZ := now();
BEGIN
  -- 1. プラン上限チェック
  SELECT p.plan, p.max_dm_per_month, p.dm_used_this_month
  INTO v_plan, v_limit, v_used
  FROM public.profiles p
  WHERE p.id = auth.uid();

  IF v_limit IS NULL THEN v_limit := 500; END IF;
  IF v_used IS NULL THEN v_used := 0; END IF;
  v_remaining := v_limit - v_used;

  IF v_remaining <= 0 THEN
    RETURN jsonb_build_object(
      'error', 'DM送信上限に達しました',
      'limit', v_limit,
      'used', v_used
    );
  END IF;

  -- 2. ブラックリストフィルタ
  SELECT ARRAY_AGG(bu.user_name)
  INTO v_blacklisted
  FROM public.blacklisted_users bu
  WHERE bu.account_id = p_account_id
    AND bu.cast_name = p_cast_name
    AND bu.user_name = ANY(p_targets);

  IF v_blacklisted IS NOT NULL THEN
    v_blacklisted_count := array_length(v_blacklisted, 1);
    -- ブラックリスト該当者を除外
    SELECT ARRAY_AGG(t)
    INTO v_filtered
    FROM unnest(p_targets) AS t
    WHERE t <> ALL(v_blacklisted);
  ELSE
    v_filtered := p_targets;
  END IF;

  IF v_filtered IS NULL OR array_length(v_filtered, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'error', '送信対象が0件です（全員ブラックリスト該当）',
      'blacklisted_count', v_blacklisted_count
    );
  END IF;

  -- 3. 上限でトリミング
  IF array_length(v_filtered, 1) > v_remaining THEN
    v_filtered := v_filtered[1:v_remaining];
  END IF;

  v_count := array_length(v_filtered, 1);
  v_batch_id := 'batch_' || to_char(v_now, 'YYYYMMDD_HH24MISS') || '_' || v_count;

  -- 4. dm_send_log に一括INSERT
  INSERT INTO public.dm_send_log (account_id, cast_name, user_name, message, template_name, status, campaign, queued_at)
  SELECT p_account_id, p_cast_name, u, p_message, p_template_name, 'queued', v_batch_id, v_now
  FROM unnest(v_filtered) AS u;

  -- 5. 使用量カウンター更新
  UPDATE public.profiles
  SET dm_used_this_month = dm_used_this_month + v_count
  WHERE id = auth.uid();

  RETURN jsonb_build_object(
    'batch_id', v_batch_id,
    'count', v_count,
    'blacklisted_count', v_blacklisted_count,
    'limit', v_limit,
    'used', v_used + v_count
  );
END;
$$;
