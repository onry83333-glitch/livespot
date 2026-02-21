-- ============================================================
-- 030: Cast Tags (genre / benchmark / category)
-- registered_casts: genre, benchmark, category を追加（notes は既存）
-- spy_casts: genre, benchmark を追加（category, notes は既存）
-- ============================================================

-- registered_casts tags
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS genre TEXT DEFAULT NULL;
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS benchmark TEXT DEFAULT NULL;
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS category TEXT DEFAULT NULL;

-- spy_casts tags (category, notes は 008_spy_casts.sql で既存)
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS genre TEXT DEFAULT NULL;
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS benchmark TEXT DEFAULT NULL;
