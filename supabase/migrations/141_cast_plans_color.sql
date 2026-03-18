-- 141: cast_plans.color カラム追加（メモの文字色カスタマイズ）
ALTER TABLE cast_plans ADD COLUMN IF NOT EXISTS color TEXT DEFAULT 'white';
