-- ============================================================
-- 124: cast_personas（複数形）非推奨マーク
-- cast_persona（単数形, migration 120）が正式テーブル
-- cast_personasは後方互換のため残すが、新規参照禁止
-- ============================================================
-- ROLLBACK: COMMENT ON TABLE public.cast_personas IS 'キャストごとのキャラクター定義（DM文面生成・AIコーチング用）';

-- 非推奨コメント
COMMENT ON TABLE public.cast_personas IS
  '[DEPRECATED] Phase 2テーブル。新規参照禁止。cast_persona（単数形, migration 120）を使用すること。'
  ' display_name/dm_tone/system_prompt_* はpersona/route.tsが依存中のため削除不可。'
  ' 段階的にcast_personaへ統合予定。';

-- cast_persona（正式テーブル）のコメント更新
COMMENT ON TABLE public.cast_persona IS
  '[ACTIVE] Phase 3 正式テーブル。ペルソナエージェント用キャスト人格定義。'
  ' JSONB speaking_style + TEXT[] personality_traits。persona-tab.tsx / engine APIが参照。';
