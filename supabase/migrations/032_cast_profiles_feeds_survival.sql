-- ============================================================
-- 032: Cast Profiles, Feeds, and Survival Tracking
-- Task B: Profile & Feed extraction storage
-- Task K: Survival tracking columns
-- ============================================================

-- 1. cast_profiles — キャストプロフィール情報
CREATE TABLE IF NOT EXISTS cast_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  age INTEGER,
  origin TEXT,
  body_type TEXT,
  details TEXT,
  ethnicity TEXT,
  hair_color TEXT,
  eye_color TEXT,
  bio TEXT,
  followers_count TEXT,
  tip_menu JSONB,
  epic_goal JSONB,
  profile_data JSONB,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cast_name, account_id)
);

-- RLS
ALTER TABLE cast_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY cast_profiles_all ON cast_profiles FOR ALL USING (true) WITH CHECK (true);

-- Index
CREATE INDEX IF NOT EXISTS idx_cast_profiles_account ON cast_profiles(account_id);
CREATE INDEX IF NOT EXISTS idx_cast_profiles_cast ON cast_profiles(cast_name);

-- 2. cast_feeds — キャストのタイムライン投稿
CREATE TABLE IF NOT EXISTS cast_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  post_text TEXT,
  post_date TEXT,
  likes_count INTEGER DEFAULT 0,
  has_image BOOLEAN DEFAULT FALSE,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique index for deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_cast_feeds_unique
  ON cast_feeds(account_id, cast_name, post_date, LEFT(post_text, 100));

-- RLS
ALTER TABLE cast_feeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY cast_feeds_all ON cast_feeds FOR ALL USING (true) WITH CHECK (true);

-- Index
CREATE INDEX IF NOT EXISTS idx_cast_feeds_account ON cast_feeds(account_id);
CREATE INDEX IF NOT EXISTS idx_cast_feeds_cast ON cast_feeds(cast_name);

-- 3. Survival tracking — registered_casts
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS last_seen_online TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS is_extinct BOOLEAN DEFAULT FALSE;
ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS extinct_at TIMESTAMPTZ DEFAULT NULL;

-- 4. Survival tracking — spy_casts
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS last_seen_online TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS is_extinct BOOLEAN DEFAULT FALSE;
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS extinct_at TIMESTAMPTZ DEFAULT NULL;
