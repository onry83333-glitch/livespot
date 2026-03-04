-- ============================================================
-- 100: コイン同期アラート（24h警告 / 48h緊急）
-- alerts テーブルに coin_sync_stale を追加
-- check_coin_sync_alerts() RPC で定期チェック→アラート自動生成
-- ============================================================
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS check_coin_sync_alerts();
--   ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
--   ALTER TABLE public.alerts ADD CONSTRAINT alerts_alert_type_check
--     CHECK (alert_type IN ('revenue_drop','consecutive_loss','spy_cast_decline','market_trend_change','data_quality'));

-- 1. alert_type に coin_sync_stale を追加
ALTER TABLE public.alerts DROP CONSTRAINT IF EXISTS alerts_alert_type_check;
ALTER TABLE public.alerts ADD CONSTRAINT alerts_alert_type_check
  CHECK (alert_type IN (
    'revenue_drop',
    'consecutive_loss',
    'spy_cast_decline',
    'market_trend_change',
    'data_quality',
    'coin_sync_stale'
  ));

-- 2. check_coin_sync_alerts RPC
-- 各キャストのコイン同期鮮度をチェックし、alertsテーブルにアラートを生成
-- 24h超 → warning、48h超 → critical
-- dedup_key で1キャスト1日1件に制限
CREATE OR REPLACE FUNCTION check_coin_sync_alerts()
RETURNS TABLE(
  cast_name TEXT,
  hours_since_sync NUMERIC,
  severity TEXT,
  alert_created BOOLEAN
) AS $$
DECLARE
  r RECORD;
  v_severity TEXT;
  v_title TEXT;
  v_body TEXT;
  v_dedup TEXT;
  v_existing BIGINT;
  v_created BOOLEAN;
BEGIN
  FOR r IN
    SELECT
      rc.cast_name,
      rc.account_id,
      ROUND(EXTRACT(EPOCH FROM (NOW() - COALESCE(MAX(ct.synced_at), '1970-01-01'::TIMESTAMPTZ))) / 3600, 1) AS hrs
    FROM registered_casts rc
    LEFT JOIN coin_transactions ct
      ON ct.cast_name = rc.cast_name
      AND ct.account_id = rc.account_id
    WHERE rc.is_active = true
    GROUP BY rc.cast_name, rc.account_id
  LOOP
    -- 24h未満はスキップ
    IF r.hrs < 24 THEN
      cast_name := r.cast_name;
      hours_since_sync := r.hrs;
      severity := 'ok';
      alert_created := false;
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- 重要度判定
    IF r.hrs >= 48 THEN
      v_severity := 'critical';
      v_title := r.cast_name || ' のコイン同期が48時間以上停止';
      v_body := r.cast_name || ' の最終同期: ' || r.hrs || '時間前。Chrome拡張からコイン同期を実行してください。';
    ELSE
      v_severity := 'warning';
      v_title := r.cast_name || ' のコイン同期が24時間以上経過';
      v_body := r.cast_name || ' の最終同期: ' || r.hrs || '時間前。早めにコイン同期を実行してください。';
    END IF;

    -- 同日・同キャスト・同severity の重複チェック
    v_dedup := 'coin_sync_' || r.cast_name || '_' || v_severity || '_' || TO_CHAR(NOW() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD');

    SELECT id INTO v_existing
    FROM public.alerts
    WHERE account_id = r.account_id
      AND alert_type = 'coin_sync_stale'
      AND metadata->>'dedup_key' = v_dedup
    LIMIT 1;

    IF v_existing IS NULL THEN
      INSERT INTO public.alerts (account_id, alert_type, severity, title, body, metadata)
      VALUES (
        r.account_id,
        'coin_sync_stale',
        v_severity,
        v_title,
        v_body,
        jsonb_build_object(
          'cast_name', r.cast_name,
          'hours_since_sync', r.hrs,
          'dedup_key', v_dedup
        )
      );
      v_created := true;
    ELSE
      v_created := false;
    END IF;

    cast_name := r.cast_name;
    hours_since_sync := r.hrs;
    severity := v_severity;
    alert_created := v_created;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION check_coin_sync_alerts IS 'コイン同期鮮度チェック: 24h超=warning, 48h超=critical をalertsテーブルに記録（1日1件dedup）';
