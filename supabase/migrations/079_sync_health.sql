-- ============================================================
-- 079: sync_health テーブル + get_sync_health RPC
-- Collector同期状態の監視用
-- ============================================================
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_sync_health(UUID);
--   DROP FUNCTION IF EXISTS upsert_sync_health(UUID, TEXT, TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS sync_health;
-- ============================================================

-- 同期ヘルス状態テーブル
CREATE TABLE IF NOT EXISTS sync_health (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cast_name   TEXT NOT NULL,
  sync_type   TEXT NOT NULL,  -- 'spy_chat' | 'spy_viewer' | 'coin_sync' | 'screenshot'
  last_sync_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'unknown',  -- 'ok' | 'warn' | 'error' | 'unknown'
  error_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(account_id, cast_name, sync_type)
);

-- RLS
ALTER TABLE sync_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sync_health_select" ON sync_health
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY "sync_health_insert" ON sync_health
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

CREATE POLICY "sync_health_update" ON sync_health
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION sync_health_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_health_updated_at
  BEFORE UPDATE ON sync_health
  FOR EACH ROW
  EXECUTE FUNCTION sync_health_updated_at();

-- Realtime 有効化
ALTER PUBLICATION supabase_realtime ADD TABLE sync_health;

-- ============================================================
-- RPC: get_sync_health
-- 各キャスト×sync_typeの同期状態を返す
-- 2時間以上経過でwarn、エラー3回以上でerror に自動判定
-- ============================================================
CREATE OR REPLACE FUNCTION get_sync_health(p_account_id UUID)
RETURNS TABLE (
  cast_name   TEXT,
  sync_type   TEXT,
  last_sync_at TIMESTAMPTZ,
  status      TEXT,
  error_count INTEGER,
  last_error  TEXT,
  minutes_since_sync NUMERIC,
  auto_status TEXT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    sh.cast_name,
    sh.sync_type,
    sh.last_sync_at,
    sh.status,
    sh.error_count,
    sh.last_error,
    ROUND(EXTRACT(EPOCH FROM (now() - sh.last_sync_at)) / 60, 1) AS minutes_since_sync,
    CASE
      WHEN sh.last_sync_at IS NULL THEN 'unknown'
      WHEN sh.error_count >= 3 THEN 'error'
      WHEN EXTRACT(EPOCH FROM (now() - sh.last_sync_at)) > 7200 THEN 'warn'
      ELSE 'ok'
    END AS auto_status
  FROM sync_health sh
  WHERE sh.account_id = p_account_id
  ORDER BY sh.cast_name, sh.sync_type;
$$;

-- ============================================================
-- RPC: upsert_sync_health
-- Collectorから呼び出す用（UPSERT）
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_sync_health(
  p_account_id UUID,
  p_cast_name  TEXT,
  p_sync_type  TEXT,
  p_status     TEXT DEFAULT 'ok',
  p_error      TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO sync_health (account_id, cast_name, sync_type, last_sync_at, status, error_count, last_error)
  VALUES (p_account_id, p_cast_name, p_sync_type, now(), p_status, CASE WHEN p_status = 'error' THEN 1 ELSE 0 END, p_error)
  ON CONFLICT (account_id, cast_name, sync_type)
  DO UPDATE SET
    last_sync_at = now(),
    status = EXCLUDED.status,
    error_count = CASE
      WHEN EXCLUDED.status = 'error' THEN sync_health.error_count + 1
      WHEN EXCLUDED.status = 'ok' THEN 0
      ELSE sync_health.error_count
    END,
    last_error = CASE
      WHEN EXCLUDED.status = 'error' THEN EXCLUDED.last_error
      ELSE sync_health.last_error
    END;
END;
$$;
