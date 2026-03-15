-- cast_profiles テーブル拡張: 分析用カラム追加
alter table public.cast_profiles
  add column if not exists category text,
  add column if not exists tags text[],
  add column if not exists avg_session_duration interval,
  add column if not exists avg_session_revenue numeric,
  add column if not exists tip_ticket_ratio numeric,
  add column if not exists peak_hour int,
  add column if not exists viewer_retention_rate numeric,
  add column if not exists last_analyzed_at timestamptz;
