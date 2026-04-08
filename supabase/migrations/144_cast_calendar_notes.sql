-- ============================================================
-- 144: cast_calendar_notes — Notion風カレンダーメモ（TipTap JSON）
-- 日付単位で複数のリッチテキストメモを保存する。
-- 既存の cast_plans / cast_sticky_notes とは別物として共存。
-- ============================================================

CREATE TABLE IF NOT EXISTS cast_calendar_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL,
  cast_name   TEXT NOT NULL,
  note_date   DATE NOT NULL,
  title       TEXT,
  content     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- TipTap JSON ドキュメント
  category    TEXT NOT NULL DEFAULT 'other',       -- 企画 / FB / アイデア / その他
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cast_calendar_notes_cast_date
  ON cast_calendar_notes (cast_name, note_date);

CREATE INDEX IF NOT EXISTS idx_cast_calendar_notes_account_cast
  ON cast_calendar_notes (account_id, cast_name);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION cast_calendar_notes_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cast_calendar_notes_updated_at ON cast_calendar_notes;
CREATE TRIGGER trg_cast_calendar_notes_updated_at
  BEFORE UPDATE ON cast_calendar_notes
  FOR EACH ROW EXECUTE FUNCTION cast_calendar_notes_set_updated_at();

-- RLS: cast_sticky_notes と同じく全オペレーション open（認証は API 層で実施）。
-- embed ルートからは anon ロールで SELECT するため USING (true) が必須。
ALTER TABLE cast_calendar_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cast_calendar_notes_select ON cast_calendar_notes;
DROP POLICY IF EXISTS cast_calendar_notes_insert ON cast_calendar_notes;
DROP POLICY IF EXISTS cast_calendar_notes_update ON cast_calendar_notes;
DROP POLICY IF EXISTS cast_calendar_notes_delete ON cast_calendar_notes;

CREATE POLICY cast_calendar_notes_select ON cast_calendar_notes FOR SELECT USING (true);
CREATE POLICY cast_calendar_notes_insert ON cast_calendar_notes FOR INSERT WITH CHECK (true);
CREATE POLICY cast_calendar_notes_update ON cast_calendar_notes FOR UPDATE USING (true);
CREATE POLICY cast_calendar_notes_delete ON cast_calendar_notes FOR DELETE USING (true);

-- ============================================================
-- Storage bucket: cast-calendar-notes
-- TipTap エディタからの画像貼り付け先。公開バケットで URL を JSON に埋め込む。
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('cast-calendar-notes', 'cast-calendar-notes', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- バケット配下のオブジェクトに対する RLS ポリシー
-- embed ルートから画像 URL を直接参照できるように anon SELECT を許可
DROP POLICY IF EXISTS cast_calendar_notes_storage_select ON storage.objects;
DROP POLICY IF EXISTS cast_calendar_notes_storage_insert ON storage.objects;
DROP POLICY IF EXISTS cast_calendar_notes_storage_update ON storage.objects;
DROP POLICY IF EXISTS cast_calendar_notes_storage_delete ON storage.objects;

CREATE POLICY cast_calendar_notes_storage_select ON storage.objects
  FOR SELECT USING (bucket_id = 'cast-calendar-notes');
CREATE POLICY cast_calendar_notes_storage_insert ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'cast-calendar-notes');
CREATE POLICY cast_calendar_notes_storage_update ON storage.objects
  FOR UPDATE USING (bucket_id = 'cast-calendar-notes');
CREATE POLICY cast_calendar_notes_storage_delete ON storage.objects
  FOR DELETE USING (bucket_id = 'cast-calendar-notes');
