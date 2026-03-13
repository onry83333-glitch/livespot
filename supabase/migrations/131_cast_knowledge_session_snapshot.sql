-- 131: cast_knowledge に session_snapshot タイプを許可
-- CHECK制約を更新して session_snapshot を追加

-- 既存のCHECK制約を削除（存在する場合のみ）
ALTER TABLE public.cast_knowledge DROP CONSTRAINT IF EXISTS cast_knowledge_report_type_check;

-- 新しいCHECK制約を追加（session_report + session_snapshot を含む）
ALTER TABLE public.cast_knowledge ADD CONSTRAINT cast_knowledge_report_type_check
  CHECK (report_type IN ('post_session', 'daily_briefing', 'weekly_review', 'session_report', 'session_snapshot'));
