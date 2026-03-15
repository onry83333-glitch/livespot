-- cast_plans: カレンダーメモ（日ごとの予定・メモ）
CREATE TABLE IF NOT EXISTS cast_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  plan_date DATE NOT NULL,
  title TEXT,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, cast_name, plan_date)
);

ALTER TABLE cast_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY cast_plans_select ON cast_plans FOR SELECT USING (true);
CREATE POLICY cast_plans_insert ON cast_plans FOR INSERT WITH CHECK (true);
CREATE POLICY cast_plans_update ON cast_plans FOR UPDATE USING (true);
CREATE POLICY cast_plans_delete ON cast_plans FOR DELETE USING (true);
