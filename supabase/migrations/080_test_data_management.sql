-- ============================================================
-- 080_test_data_management.sql
-- テストデータ件数カウント + 一括削除 RPC
-- ============================================================
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS count_test_data(UUID, TEXT);
--   DROP FUNCTION IF EXISTS delete_test_data(UUID, TEXT);
-- ============================================================

-- テストデータのプレフィックス定義:
--   dm_send_log.campaign: 'bulk_%', 'pipe3_bulk_%', '20250217_test_%', 'test_%'

-- -------------------------------------------------------
-- count_test_data: テーブルごとのテストデータ件数を返す
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION count_test_data(
  p_account_id UUID,
  p_table_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count BIGINT := 0;
  v_breakdown JSONB := '[]'::JSONB;
BEGIN
  IF p_table_name = 'dm_send_log' THEN
    -- campaign プレフィックス別の内訳
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::JSONB)
    INTO v_breakdown
    FROM (
      SELECT
        CASE
          WHEN campaign LIKE 'pipe3_bulk_%' THEN 'pipe3_bulk_*'
          WHEN campaign LIKE '20250217_test_%' THEN '20250217_test_*'
          WHEN campaign LIKE 'test_%' THEN 'test_*'
          WHEN campaign LIKE 'bulk_%' THEN 'bulk_*'
        END AS prefix,
        COUNT(*) AS count
      FROM dm_send_log
      WHERE account_id = p_account_id
        AND (
          campaign LIKE 'bulk_%'
          OR campaign LIKE 'pipe3_bulk_%'
          OR campaign LIKE '20250217_test_%'
          OR campaign LIKE 'test_%'
        )
      GROUP BY 1
      ORDER BY count DESC
    ) t;

    SELECT COUNT(*)
    INTO v_count
    FROM dm_send_log
    WHERE account_id = p_account_id
      AND (
        campaign LIKE 'bulk_%'
        OR campaign LIKE 'pipe3_bulk_%'
        OR campaign LIKE '20250217_test_%'
        OR campaign LIKE 'test_%'
      );

  ELSIF p_table_name = 'spy_messages' THEN
    -- msg_type = 'demo' のデモ挿入データ
    SELECT COUNT(*)
    INTO v_count
    FROM spy_messages
    WHERE account_id = p_account_id
      AND msg_type = 'demo';

    IF v_count > 0 THEN
      v_breakdown := jsonb_build_array(
        jsonb_build_object('prefix', 'msg_type=demo', 'count', v_count)
      );
    END IF;

  ELSIF p_table_name = 'dm_trigger_logs' THEN
    -- status = 'error' の失敗ログ
    SELECT COUNT(*)
    INTO v_count
    FROM dm_trigger_logs
    WHERE account_id = p_account_id
      AND status = 'error';

    IF v_count > 0 THEN
      v_breakdown := jsonb_build_array(
        jsonb_build_object('prefix', 'status=error', 'count', v_count)
      );
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported table: %', p_table_name;
  END IF;

  RETURN jsonb_build_object(
    'table_name', p_table_name,
    'total_count', v_count,
    'breakdown', v_breakdown
  );
END;
$$;

-- -------------------------------------------------------
-- delete_test_data: テストデータを削除して件数を返す
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_test_data(
  p_account_id UUID,
  p_table_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted BIGINT := 0;
BEGIN
  IF p_table_name = 'dm_send_log' THEN
    WITH deleted AS (
      DELETE FROM dm_send_log
      WHERE account_id = p_account_id
        AND (
          campaign LIKE 'bulk_%'
          OR campaign LIKE 'pipe3_bulk_%'
          OR campaign LIKE '20250217_test_%'
          OR campaign LIKE 'test_%'
        )
      RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted FROM deleted;

  ELSIF p_table_name = 'spy_messages' THEN
    WITH deleted AS (
      DELETE FROM spy_messages
      WHERE account_id = p_account_id
        AND msg_type = 'demo'
      RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted FROM deleted;

  ELSIF p_table_name = 'dm_trigger_logs' THEN
    WITH deleted AS (
      DELETE FROM dm_trigger_logs
      WHERE account_id = p_account_id
        AND status = 'error'
      RETURNING id
    )
    SELECT COUNT(*) INTO v_deleted FROM deleted;

  ELSE
    RAISE EXCEPTION 'Unsupported table: %', p_table_name;
  END IF;

  RETURN jsonb_build_object(
    'table_name', p_table_name,
    'deleted_count', v_deleted
  );
END;
$$;
