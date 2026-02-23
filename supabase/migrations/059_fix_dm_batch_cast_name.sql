-- ============================================================
-- 059: create_dm_batch RPC に cast_name パラメータ追加
-- 既存のRPCを置き換え（CREATE OR REPLACE）
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_dm_batch(
  p_account_id UUID,
  p_cast_name TEXT DEFAULT NULL,
  p_targets TEXT[] DEFAULT '{}',
  p_message TEXT DEFAULT '',
  p_template_name TEXT DEFAULT NULL
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
  v_target TEXT;
  v_effective_targets TEXT[];
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

  RETURN jsonb_build_object('batch_id', v_batch_id, 'count', v_count);
END;
$$;
