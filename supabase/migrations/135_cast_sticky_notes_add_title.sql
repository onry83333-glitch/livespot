-- 135: cast_sticky_notes に title カラムを追加
ALTER TABLE public.cast_sticky_notes ADD COLUMN IF NOT EXISTS title TEXT;
