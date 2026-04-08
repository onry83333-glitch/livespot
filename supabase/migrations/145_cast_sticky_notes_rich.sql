-- ============================================================
-- 145: cast_sticky_notes をリッチテキスト対応に拡張
-- content_rich (JSONB, TipTap JSON) と category を追加。
-- 既存の content (TEXT) は後方互換のため残す。
-- ============================================================

-- 004 以前に取り込まれなかったケース向けに title を defensive に ensure
ALTER TABLE public.cast_sticky_notes
  ADD COLUMN IF NOT EXISTS title TEXT;

-- リッチテキスト本体（TipTap JSON ドキュメント）
ALTER TABLE public.cast_sticky_notes
  ADD COLUMN IF NOT EXISTS content_rich JSONB;

-- カテゴリ（cast_calendar_notes と同じ 4 種: plan / fb / idea / other）
ALTER TABLE public.cast_sticky_notes
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';

-- updated_at を NULL にしない defensive 対応
ALTER TABLE public.cast_sticky_notes
  ALTER COLUMN updated_at SET DEFAULT NOW();

-- updated_at 自動更新トリガー（cast_calendar_notes と同じパターン）
CREATE OR REPLACE FUNCTION cast_sticky_notes_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cast_sticky_notes_updated_at ON public.cast_sticky_notes;
CREATE TRIGGER trg_cast_sticky_notes_updated_at
  BEFORE UPDATE ON public.cast_sticky_notes
  FOR EACH ROW EXECUTE FUNCTION cast_sticky_notes_set_updated_at();

-- 既存データ: content (TEXT) のみ持つ行に対し、空の TipTap JSON 骨格を content_rich に設定
-- 初回編集時にクライアント側が TipTap にロードして段落化する。
UPDATE public.cast_sticky_notes
   SET content_rich = jsonb_build_object(
         'type', 'doc',
         'content', CASE
           WHEN content IS NULL OR content = '' THEN jsonb_build_array(jsonb_build_object('type', 'paragraph'))
           ELSE jsonb_build_array(
             jsonb_build_object(
               'type', 'paragraph',
               'content', jsonb_build_array(
                 jsonb_build_object('type', 'text', 'text', content)
               )
             )
           )
         END
       )
 WHERE content_rich IS NULL;

-- Index: cast_name による検索高速化
CREATE INDEX IF NOT EXISTS idx_cast_sticky_notes_account_cast
  ON public.cast_sticky_notes (account_id, cast_name);
