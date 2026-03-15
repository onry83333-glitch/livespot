-- cast_sticky_notes: Google Keep風の付箋メモ
CREATE TABLE IF NOT EXISTS cast_sticky_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  title TEXT,
  content TEXT,
  color TEXT DEFAULT 'yellow',
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cast_sticky_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY cast_sticky_notes_select ON cast_sticky_notes FOR SELECT USING (true);
CREATE POLICY cast_sticky_notes_insert ON cast_sticky_notes FOR INSERT WITH CHECK (true);
CREATE POLICY cast_sticky_notes_update ON cast_sticky_notes FOR UPDATE USING (true);
CREATE POLICY cast_sticky_notes_delete ON cast_sticky_notes FOR DELETE USING (true);
