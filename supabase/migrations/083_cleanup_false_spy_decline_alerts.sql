-- 083_cleanup_false_spy_decline_alerts.sql
-- SPY停止中に 0→0 で「視聴者-100%減少」と誤検知されたアラートを既読化
--
-- 原因: collector/src/alerts/index.ts evaluateSpyCastDecline() で
--   recentCount === 0 のガードが欠落 → avg > 0 のとき changeRate = -100% でアラート発火
-- 修正: recentCount === 0 のときは continue（同コミットで修正済み）
--
-- ROLLBACK:
--   UPDATE public.alerts
--   SET is_read = false
--   WHERE alert_type = 'spy_cast_decline'
--     AND (metadata->>'recent_count')::int = 0;

UPDATE public.alerts
SET is_read = true
WHERE alert_type = 'spy_cast_decline'
  AND (metadata->>'recent_count')::int = 0
  AND is_read = false;
