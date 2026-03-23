-- live_viewer_stats: Chrome拡張からのコイン有りユーザー数・アルティメット会員数の推移
CREATE TABLE IF NOT EXISTS live_viewer_stats (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    account_id UUID NOT NULL DEFAULT '940e7248-1d73-4259-a538-56fdaea9d740',
    cast_name TEXT NOT NULL,
    total_viewers INTEGER NOT NULL DEFAULT 0,
    coin_users INTEGER NOT NULL DEFAULT 0,
    ultimate_members INTEGER NOT NULL DEFAULT 0,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_live_viewer_stats_cast_time ON live_viewer_stats(cast_name, recorded_at DESC);

ALTER TABLE live_viewer_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for authenticated" ON live_viewer_stats
    FOR ALL USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE live_viewer_stats;
