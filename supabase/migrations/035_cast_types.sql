-- Migration 035: 型（プロダクトタイプ）カタログ
CREATE TABLE IF NOT EXISTS cast_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  type_name TEXT NOT NULL,
  benchmark_cast TEXT NOT NULL,
  description TEXT,
  genre TEXT,
  category TEXT,
  streaming_style TEXT,
  revenue_pattern TEXT,
  avg_session_revenue_min INTEGER,
  avg_session_revenue_max INTEGER,
  ticket_ratio INTEGER,
  avg_ticket_price INTEGER,
  avg_ticket_attendees INTEGER,
  customer_quality TEXT,
  streaming_frequency TEXT,
  expected_lifespan_months INTEGER,
  survival_rate_30d INTEGER,
  product_route TEXT,
  consistency_checklist JSONB DEFAULT '[]',
  hypothesis_1year TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cast_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY cast_types_all ON cast_types FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_cast_types_account ON cast_types(account_id);

ALTER TABLE registered_casts ADD COLUMN IF NOT EXISTS cast_type_id UUID DEFAULT NULL;
ALTER TABLE spy_casts ADD COLUMN IF NOT EXISTS cast_type_id UUID DEFAULT NULL;
