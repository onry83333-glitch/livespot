-- ==============================================
-- 023: pipeline_status テーブル + 自動検出RPC
-- ==============================================

-- 1. テーブル作成
CREATE TABLE IF NOT EXISTS pipeline_status (
  id SERIAL PRIMARY KEY,
  pipeline_name TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'off' CHECK (status IN ('auto', 'semi', 'manual', 'off')),
  source TEXT,
  destination TEXT,
  detail TEXT,
  last_run_at TIMESTAMPTZ,
  last_success BOOLEAN DEFAULT false,
  error_message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 初期データ10行
INSERT INTO pipeline_status (pipeline_name, status, source, destination, detail) VALUES
  ('スカウト収集', 'auto', '求人サイト', 'Notion候補DB', '264名登録済 (v0.3)'),
  ('AI配信FBレポート', 'auto', 'spy_messages', 'レポート', '稼働中'),
  ('DMキャンペーン', 'semi', 'SLS UI', 'Stripchat DM', '3段階確認フロー'),
  ('コイン同期', 'manual', 'Stripchat API', 'Supabase', 'キャスト選択UI実装済'),
  ('ファイナンス同期', 'manual', 'Supabase', 'Notion売上DB', '3件投入済'),
  ('SPY監視（自社）', 'manual', 'Stripchat', 'spy_messages', '手動 → 自動検出予定'),
  ('SPY監視（他社）', 'off', 'Stripchat', 'spy_messages', '自動巡回ロジック必要'),
  ('セグメント更新', 'manual', 'paid_users', 'segments', '週次cron化予定'),
  ('コンテキスト巡回', 'manual', 'CLAUDE.md', 'Notion事業OS', '¥8.68/回 → ミニPCでcron化'),
  ('育成タスク生成', 'off', 'キャストDB', 'タスクDB', 'DB設計済 → スクリプト未実装')
ON CONFLICT (pipeline_name) DO NOTHING;

-- 3. 自動更新トリガー
CREATE OR REPLACE FUNCTION update_pipeline_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pipeline_status_updated ON pipeline_status;
CREATE TRIGGER pipeline_status_updated
  BEFORE UPDATE ON pipeline_status
  FOR EACH ROW
  EXECUTE FUNCTION update_pipeline_timestamp();

-- 4. RLS
ALTER TABLE pipeline_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated read" ON pipeline_status
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Allow authenticated update" ON pipeline_status
  FOR UPDATE USING (auth.role() = 'authenticated');

-- 5. 自動検出RPC (SPY・コイン同期・DMの最新タイムスタンプから状態更新)
CREATE OR REPLACE FUNCTION update_pipeline_auto_status()
RETURNS void AS $$
DECLARE
  v_spy_last TIMESTAMPTZ;
  v_coin_last TIMESTAMPTZ;
  v_dm_last TIMESTAMPTZ;
BEGIN
  -- SPY監視（自社）: spy_messagesの最新
  SELECT MAX(created_at) INTO v_spy_last FROM spy_messages;
  UPDATE pipeline_status SET
    last_run_at = v_spy_last,
    last_success = (v_spy_last > NOW() - INTERVAL '1 hour'),
    detail = CASE
      WHEN v_spy_last > NOW() - INTERVAL '1 hour' THEN '稼働中（最終: ' || to_char(v_spy_last AT TIME ZONE 'Asia/Tokyo', 'HH24:MI') || '）'
      WHEN v_spy_last IS NOT NULL THEN '停止中（最終: ' || to_char(v_spy_last AT TIME ZONE 'Asia/Tokyo', 'MM/DD HH24:MI') || '）'
      ELSE '未実行'
    END
  WHERE pipeline_name = 'SPY監視（自社）';

  -- コイン同期: coin_transactionsの最新synced_at
  SELECT MAX(synced_at) INTO v_coin_last FROM coin_transactions;
  UPDATE pipeline_status SET
    last_run_at = v_coin_last,
    last_success = (v_coin_last > NOW() - INTERVAL '24 hours'),
    detail = CASE
      WHEN v_coin_last > NOW() - INTERVAL '24 hours' THEN '同期済（最終: ' || to_char(v_coin_last AT TIME ZONE 'Asia/Tokyo', 'MM/DD HH24:MI') || '）'
      WHEN v_coin_last IS NOT NULL THEN '要同期（最終: ' || to_char(v_coin_last AT TIME ZONE 'Asia/Tokyo', 'MM/DD') || '）'
      ELSE '未実行'
    END
  WHERE pipeline_name = 'コイン同期';

  -- DMキャンペーン: dm_send_logの最新queued_at
  SELECT MAX(queued_at) INTO v_dm_last FROM dm_send_log;
  UPDATE pipeline_status SET
    last_run_at = v_dm_last,
    last_success = (v_dm_last IS NOT NULL),
    detail = CASE
      WHEN v_dm_last IS NOT NULL THEN '最終送信: ' || to_char(v_dm_last AT TIME ZONE 'Asia/Tokyo', 'MM/DD HH24:MI')
      ELSE '未送信'
    END
  WHERE pipeline_name = 'DMキャンペーン';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
