-- ==============================================
-- 107: pipeline_status RLS INSERT policy 追加
-- ==============================================
-- 問題: pipeline_status テーブルに INSERT policy がなく
-- service_role_key 以外からの INSERT/UPSERT が拒否される。
-- Collector サービスは service_role_key で接続するため通常は問題ないが
-- 安全のため INSERT policy を追加する。
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS "Allow service insert" ON pipeline_status;

-- INSERT policy (service role は RLS をバイパスするため、これは
-- 将来 authenticated ユーザーからの書き込みが必要になった場合の保険)
CREATE POLICY "Allow authenticated insert" ON pipeline_status
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- DELETE policy (管理用)
CREATE POLICY "Allow authenticated delete" ON pipeline_status
  FOR DELETE USING (auth.role() = 'authenticated');
