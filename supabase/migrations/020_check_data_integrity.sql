-- ═══════════════════════════════════════════════════════════
--  020: データ整合性チェック RPC
--  Usage: SELECT check_data_integrity();
--         SELECT check_data_integrity('2025-02-15'::timestamptz);
--  Returns: JSONB with all check results
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_data_integrity(
  p_valid_since TIMESTAMPTZ DEFAULT '2025-02-15T00:00:00+00:00'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  res jsonb := '{}'::jsonb;
  v_count bigint;
  v_count2 bigint;
  v_count3 bigint;
  v_oldest text;
  v_names jsonb;
  v_campaigns jsonb;
BEGIN
  -- ═══ テーブル行数 ═══
  SELECT count(*) INTO v_count FROM coin_transactions WHERE date >= p_valid_since;
  res := res || jsonb_build_object('table_coin_transactions', v_count);

  SELECT count(*) INTO v_count FROM paid_users;
  res := res || jsonb_build_object('table_paid_users', v_count);

  SELECT count(*) INTO v_count FROM dm_send_log;
  res := res || jsonb_build_object('table_dm_send_log', v_count);

  SELECT count(*) INTO v_count FROM spy_messages WHERE message_time >= p_valid_since;
  res := res || jsonb_build_object('table_spy_messages', v_count);

  SELECT count(*) INTO v_count FROM sessions WHERE started_at >= p_valid_since;
  res := res || jsonb_build_object('table_sessions', v_count);

  SELECT count(*) INTO v_count FROM registered_casts WHERE is_active = true;
  res := res || jsonb_build_object('table_registered_casts', v_count);

  -- ═══ CHECK-01: coin_transactions NULL cast_name ═══
  SELECT count(*) INTO v_count
  FROM coin_transactions
  WHERE cast_name IS NULL AND date >= p_valid_since;
  res := res || jsonb_build_object('check_01_null_cast_coin', v_count);

  -- ═══ CHECK-02: paid_users cast_name ═══
  -- paid_usersテーブルにcast_nameカラムは存在しない → 常に -1 (N/A)
  res := res || jsonb_build_object('check_02_null_cast_paid', -1);

  -- ═══ CHECK-03: dm_send_log NULL cast_name ═══
  SELECT count(*) INTO v_count
  FROM dm_send_log
  WHERE cast_name IS NULL;
  res := res || jsonb_build_object('check_03_null_cast_dm', v_count);

  -- ═══ CHECK-04: キャスト間ユーザー重複 ═══
  SELECT count(*) INTO v_count
  FROM (
    SELECT user_name
    FROM coin_transactions
    WHERE date >= p_valid_since AND cast_name IS NOT NULL
    GROUP BY user_name
    HAVING count(DISTINCT cast_name) > 1
  ) sub;
  res := res || jsonb_build_object('check_04_cross_cast_users', v_count);

  -- ═══ CHECK-05: 未登録cast_name ═══
  SELECT COALESCE(jsonb_agg(DISTINCT ct.cast_name), '[]'::jsonb) INTO v_names
  FROM coin_transactions ct
  WHERE ct.date >= p_valid_since
    AND ct.cast_name IS NOT NULL
    AND ct.cast_name != 'unknown'
    AND ct.cast_name NOT IN (
      SELECT cast_name FROM registered_casts WHERE is_active = true
      UNION ALL
      SELECT cast_name FROM spy_casts WHERE is_active = true
    );
  res := res || jsonb_build_object('check_05_unregistered_casts', v_names);

  -- ═══ CHECK-06: キャンペーンタグ一覧 ═══
  SELECT COALESCE(jsonb_agg(row_to_json(sub)), '[]'::jsonb) INTO v_campaigns
  FROM (
    SELECT
      COALESCE(NULLIF(campaign, ''), '(空)') AS campaign,
      cast_name,
      count(*) AS cnt
    FROM dm_send_log
    GROUP BY COALESCE(NULLIF(campaign, ''), '(空)'), cast_name
    ORDER BY cnt DESC
  ) sub;
  res := res || jsonb_build_object('check_06_campaigns', v_campaigns);

  -- ═══ CHECK-07: DM先で課金記録なし ═══
  SELECT count(DISTINCT d.user_name) INTO v_count
  FROM dm_send_log d
  WHERE d.user_name IS NOT NULL;

  SELECT count(DISTINCT d.user_name) INTO v_count2
  FROM dm_send_log d
  WHERE d.user_name IS NOT NULL
    AND d.user_name NOT IN (
      SELECT DISTINCT user_name FROM coin_transactions
      WHERE date >= p_valid_since AND user_name IS NOT NULL
    );
  res := res || jsonb_build_object('check_07_dm_total', v_count,
                                   'check_07_dm_no_coin', v_count2);

  -- ═══ CHECK-08: DM/コインキャスト不一致 ═══
  SELECT count(DISTINCT d.user_name) INTO v_count
  FROM dm_send_log d
  WHERE d.user_name IS NOT NULL
    AND d.cast_name IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM coin_transactions ct
      WHERE ct.user_name = d.user_name
        AND ct.date >= p_valid_since
        AND ct.cast_name IS NOT NULL
        AND ct.cast_name != d.cast_name
    )
    AND NOT EXISTS (
      SELECT 1 FROM coin_transactions ct
      WHERE ct.user_name = d.user_name
        AND ct.date >= p_valid_since
        AND ct.cast_name = d.cast_name
    );
  res := res || jsonb_build_object('check_08_cast_mismatch', v_count);

  -- ═══ CHECK-09: マイナストークン ═══
  SELECT count(*) INTO v_count
  FROM coin_transactions
  WHERE tokens < 0 AND date >= p_valid_since;
  res := res || jsonb_build_object('check_09_negative_tokens', v_count);

  -- ═══ CHECK-10: ゼロトークン ═══
  SELECT count(*) INTO v_count
  FROM coin_transactions
  WHERE tokens = 0 AND date >= p_valid_since;
  res := res || jsonb_build_object('check_10_zero_tokens', v_count);

  -- ═══ CHECK-11: 無効日付データ ═══
  SELECT count(*) INTO v_count
  FROM coin_transactions
  WHERE date < p_valid_since;

  SELECT COALESCE(min(date)::text, '(なし)') INTO v_oldest
  FROM coin_transactions
  WHERE date < p_valid_since;
  res := res || jsonb_build_object('check_11_old_data', v_count,
                                   'check_11_oldest', v_oldest);

  -- ═══ CHECK-12: 完全重複行 ═══
  SELECT COALESCE(sum(cnt - 1), 0), count(*) INTO v_count, v_count2
  FROM (
    SELECT user_name, cast_name, tokens, date, count(*) AS cnt
    FROM coin_transactions
    WHERE date >= p_valid_since
    GROUP BY user_name, cast_name, tokens, date
    HAVING count(*) > 1
  ) sub;
  res := res || jsonb_build_object('check_12_dup_rows', v_count,
                                   'check_12_dup_groups', v_count2);

  -- ═══ CHECK-13: sessions 未登録cast_name ═══
  SELECT COALESCE(jsonb_agg(DISTINCT cn), '[]'::jsonb) INTO v_names
  FROM (
    SELECT COALESCE(s.cast_name, s.title) AS cn
    FROM sessions s
    WHERE s.started_at >= p_valid_since
  ) sub
  WHERE cn IS NOT NULL
    AND cn != 'unknown'
    AND cn NOT IN (
      SELECT cast_name FROM registered_casts WHERE is_active = true
      UNION ALL
      SELECT cast_name FROM spy_casts WHERE is_active = true
    );
  res := res || jsonb_build_object('check_13_unreg_session_casts', v_names);

  -- ═══ CHECK-14: spy_messages 未登録cast_name ═══
  SELECT count(*) INTO v_count
  FROM spy_messages sm
  WHERE sm.message_time >= p_valid_since
    AND sm.cast_name IS NOT NULL
    AND sm.cast_name != 'unknown'
    AND sm.cast_name NOT IN (
      SELECT cast_name FROM registered_casts WHERE is_active = true
      UNION ALL
      SELECT cast_name FROM spy_casts WHERE is_active = true
    );
  res := res || jsonb_build_object('check_14_unreg_spy_msgs', v_count);

  -- ═══ CHECK-15: SPY/セッション時間整合性 ═══
  -- セッション開始前のspy_messages件数
  SELECT count(*) INTO v_count
  FROM spy_messages sm
  WHERE sm.message_time >= p_valid_since
    AND sm.cast_name IS NOT NULL
    AND sm.message_time < (
      SELECT COALESCE(min(s.started_at), '2099-01-01'::timestamptz)
      FROM sessions s
      WHERE COALESCE(s.cast_name, s.title) = sm.cast_name
        AND s.started_at >= p_valid_since
    );
  res := res || jsonb_build_object('check_15_orphan_spy', v_count);

  -- ═══ CHECK-16: セグメント整合性 ═══
  -- segmentsは物理テーブルではなくRPC (get_user_segments) で動的生成 → N/A
  res := res || jsonb_build_object('check_16_segments', -1);

  RETURN res;
END;
$$;

-- 使用例:
-- SELECT check_data_integrity();
-- SELECT jsonb_pretty(check_data_integrity());
-- SELECT check_data_integrity('2025-03-01'::timestamptz);  -- 3月以降のみ
