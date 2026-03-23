-- cast_live_instructions: マネージャー指示パネル用テーブル
CREATE TABLE IF NOT EXISTS cast_live_instructions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    account_id UUID NOT NULL DEFAULT '940e7248-1d73-4259-a538-56fdaea9d740',
    cast_name TEXT NOT NULL,
    instruction_type TEXT NOT NULL DEFAULT 'custom',
    instruction_text TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expired_at TIMESTAMPTZ
);

ALTER TABLE cast_live_instructions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON cast_live_instructions
    FOR ALL USING (true) WITH CHECK (true);

-- Realtime有効化
ALTER PUBLICATION supabase_realtime ADD TABLE cast_live_instructions;
