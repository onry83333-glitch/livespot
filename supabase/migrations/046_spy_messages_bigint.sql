-- ============================================================
-- 046: spy_messages / spy_viewers の INTEGER → BIGINT 移行
-- user_level=2195868252 が integer 上限 (2,147,483,647) を超過
-- ============================================================

-- spy_messages: user_level と tokens を BIGINT に
ALTER TABLE public.spy_messages
  ALTER COLUMN user_level TYPE BIGINT,
  ALTER COLUMN tokens TYPE BIGINT;

-- spy_viewers: level を BIGINT に（同様の超過リスク）
ALTER TABLE public.spy_viewers
  ALTER COLUMN level TYPE BIGINT;

-- 確認クエリ（適用後に実行）
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name IN ('spy_messages', 'spy_viewers')
--   AND column_name IN ('tokens', 'user_level', 'level');
