-- ============================================================
-- 054: cast_screenshots + model_id columns
-- 冪等: 何回実行しても安全
-- ============================================================

-- 孤立インデックスがあれば削除
DROP INDEX IF EXISTS idx_screenshots_cast;
DROP INDEX IF EXISTS idx_screenshots_session;
DROP INDEX IF EXISTS idx_screenshots_type;

-- 1. cast_screenshots table
CREATE TABLE IF NOT EXISTS public.cast_screenshots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    session_id TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    image_url TEXT NOT NULL,
    storage_path TEXT,
    thumbnail_type TEXT DEFAULT 'auto'
        CHECK (thumbnail_type IN ('auto', 'manual', 'spy')),
    is_live BOOLEAN DEFAULT false,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screenshots_cast
    ON public.cast_screenshots(cast_name, account_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_session
    ON public.cast_screenshots(session_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_type
    ON public.cast_screenshots(thumbnail_type);

ALTER TABLE public.cast_screenshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'cast_screenshots' AND policyname = 'cast_screenshots_all') THEN
    CREATE POLICY "cast_screenshots_all" ON public.cast_screenshots
      FOR ALL USING (account_id IN (SELECT user_account_ids()));
  END IF;
END $$;

-- 2. Add stripchat_model_id to registered_casts and spy_casts
ALTER TABLE public.registered_casts
    ADD COLUMN IF NOT EXISTS stripchat_model_id TEXT DEFAULT NULL;
COMMENT ON COLUMN public.registered_casts.stripchat_model_id
    IS 'Stripchat model numeric ID for CDN thumbnail URL';

ALTER TABLE public.spy_casts
    ADD COLUMN IF NOT EXISTS stripchat_model_id TEXT DEFAULT NULL;
COMMENT ON COLUMN public.spy_casts.stripchat_model_id
    IS 'Stripchat model numeric ID for CDN thumbnail URL';

-- Known model IDs
UPDATE public.registered_casts SET stripchat_model_id = '178845750' WHERE cast_name = 'Risa_06' AND stripchat_model_id IS NULL;
UPDATE public.spy_casts SET stripchat_model_id = '186865131' WHERE cast_name = 'hanshakun' AND stripchat_model_id IS NULL;

COMMENT ON TABLE public.cast_screenshots IS 'Stripchat CDN thumbnail captures';
