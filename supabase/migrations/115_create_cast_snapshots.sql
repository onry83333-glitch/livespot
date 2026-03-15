-- cast_snapshots: キャスト配信画面のスナップショットとAI分析結果を保存
create table if not exists public.cast_snapshots (
  id uuid primary key default gen_random_uuid(),
  cast_name text not null,
  snapshot_url text not null,
  captured_at timestamptz not null,
  ai_analysis jsonb,
  analysis_model text,
  created_at timestamptz not null default now()
);

-- RLS有効化
alter table public.cast_snapshots enable row level security;

-- インデックス
create index idx_cast_snapshots_cast_name on public.cast_snapshots (cast_name);
create index idx_cast_snapshots_captured_at on public.cast_snapshots (captured_at);
