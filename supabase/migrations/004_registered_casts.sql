-- ============================================================
-- 004: registered_casts — 自社キャスト登録テーブル
-- spy_messagesに出てくるキャストのうち「自社キャスト」を区別する
-- ============================================================

CREATE TABLE IF NOT EXISTS registered_casts (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cast_name TEXT NOT NULL,
  display_name TEXT,           -- 表示名（本名やニックネーム）
  stripchat_url TEXT,          -- https://stripchat.com/cast_name
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,                  -- メモ
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, cast_name)
);

-- RLS
ALTER TABLE registered_casts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "registered_casts_select" ON registered_casts
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY "registered_casts_insert" ON registered_casts
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

CREATE POLICY "registered_casts_update" ON registered_casts
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY "registered_casts_delete" ON registered_casts
  FOR DELETE USING (account_id IN (SELECT user_account_ids()));

-- Realtime有効化
ALTER PUBLICATION supabase_realtime ADD TABLE registered_casts;

-- ============================================================
-- 初期データ: Risa_06 を自社キャストとして登録
-- ============================================================
INSERT INTO registered_casts (account_id, cast_name, display_name)
VALUES ('940e7248-1d73-4259-a538-56fdaea9d740', 'Risa_06', 'りさ')
ON CONFLICT (account_id, cast_name) DO NOTHING;
