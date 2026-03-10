-- 117: competitor_benchmarks テーブル作成
-- 競合キャストベンチマーク管理

CREATE TABLE IF NOT EXISTS public.competitor_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL DEFAULT '940e7248-1d73-4259-a538-56fdaea9d740',
  cast_name TEXT NOT NULL,
  competitor_cast_name TEXT NOT NULL,
  category TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, cast_name, competitor_cast_name)
);

ALTER TABLE public.competitor_benchmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account_access" ON public.competitor_benchmarks
  FOR ALL USING (account_id = '940e7248-1d73-4259-a538-56fdaea9d740');
CREATE INDEX idx_comp_bench_cast ON public.competitor_benchmarks(cast_name);
