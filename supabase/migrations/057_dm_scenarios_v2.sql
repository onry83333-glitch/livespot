-- Migration 057: DMシナリオエンジン v2
-- 既存の dm_scenarios / dm_scenario_enrollments を拡張
-- 新トリガータイプ追加 + trigger_config カラム + dm_scenario_steps テーブル + completed_at カラム
-- 完全冪等（IF NOT EXISTS / DO $$ ブロック使用）

-- ============================================================
-- 1. trigger_type CHECK制約を拡張（既存4種 + 新6種）
-- ============================================================
DO $$
BEGIN
  -- 既存の CHECK制約を削除（存在する場合）
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'dm_scenarios'
      AND column_name = 'trigger_type'
  ) THEN
    -- 制約名を動的に取得して削除
    EXECUTE (
      SELECT 'ALTER TABLE dm_scenarios DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'dm_scenarios'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%trigger_type%'
      LIMIT 1
    );
  END IF;

  -- 新しい CHECK制約を追加（既存4種 + 新6種 = 計10種）
  ALTER TABLE dm_scenarios ADD CONSTRAINT dm_scenarios_trigger_type_check
    CHECK (trigger_type IN (
      'thankyou_vip',
      'thankyou_regular',
      'thankyou_first',
      'churn_recovery',
      'first_payment',
      'high_payment',
      'visit_no_action',
      'dormant',
      'segment_change',
      'manual'
    ));
END $$;

COMMENT ON COLUMN dm_scenarios.trigger_type IS 'トリガー種別: thankyou_vip/thankyou_regular/thankyou_first/churn_recovery/first_payment/high_payment/visit_no_action/dormant/segment_change/manual';

-- ============================================================
-- 2. trigger_config JSONB カラム追加
-- ============================================================
ALTER TABLE dm_scenarios
ADD COLUMN IF NOT EXISTS trigger_config JSONB DEFAULT '{}';

COMMENT ON COLUMN dm_scenarios.trigger_config IS 'トリガー条件の詳細設定 (例: {"days": 7} for dormant, {"min_tokens": 500} for high_payment)';

-- ============================================================
-- 3. dm_scenario_steps テーブル（正規化ステップ、JSONB方式と共存）
-- ============================================================
CREATE TABLE IF NOT EXISTS dm_scenario_steps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES dm_scenarios(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  delay_hours INTEGER DEFAULT 0,
  message_template TEXT NOT NULL,
  use_persona BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS有効化
ALTER TABLE dm_scenario_steps ENABLE ROW LEVEL SECURITY;

-- RLSポリシー（dm_scenariosのaccount_idスコープ経由）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'dm_scenario_steps'
      AND policyname = 'dm_scenario_steps_account_scope'
  ) THEN
    CREATE POLICY dm_scenario_steps_account_scope ON dm_scenario_steps
      FOR ALL USING (
        scenario_id IN (
          SELECT id FROM dm_scenarios
          WHERE account_id IN (SELECT user_account_ids())
        )
      );
  END IF;
END $$;

COMMENT ON TABLE dm_scenario_steps IS 'DMシナリオ 正規化ステップ定義（dm_scenarios.steps JSONBと共存）';
COMMENT ON COLUMN dm_scenario_steps.step_number IS 'ステップ番号（0始まり）';
COMMENT ON COLUMN dm_scenario_steps.delay_hours IS '前ステップからの遅延時間（時間）';
COMMENT ON COLUMN dm_scenario_steps.message_template IS 'メッセージテンプレート（{username}等のプレースホルダー使用可）';
COMMENT ON COLUMN dm_scenario_steps.use_persona IS 'Persona Agentによる文面生成を使用するか';

-- ============================================================
-- 4. インデックス追加
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_dm_scenario_steps_scenario
  ON dm_scenario_steps(scenario_id, step_number);

CREATE INDEX IF NOT EXISTS idx_dm_scenarios_trigger_type
  ON dm_scenarios(account_id, trigger_type, is_active);

CREATE INDEX IF NOT EXISTS idx_enrollments_cast_username
  ON dm_scenario_enrollments(account_id, cast_name, username);

-- ============================================================
-- 5. dm_scenario_enrollments に completed_at カラム追加
-- ============================================================
ALTER TABLE dm_scenario_enrollments
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN dm_scenario_enrollments.completed_at IS 'シナリオ完了日時（completed/goal_reached時に記録）';

-- ============================================================
-- 6. 新シナリオ3件 INSERT（Risa_06用、ON CONFLICT DO NOTHING）
-- ============================================================
INSERT INTO dm_scenarios (
  account_id, scenario_name, trigger_type, trigger_config,
  segment_targets, steps, is_active, auto_approve_step0,
  daily_send_limit, min_interval_hours
)
VALUES
  -- 初課金お礼
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    '初課金お礼',
    'first_payment',
    '{}',
    ARRAY['S9','S10'],
    '[
      {"step":0, "delay_hours":0, "template":"感謝+名前呼び", "message":"{username}さん、初めてのチップありがとう！すごく嬉しかったです😊 また遊びに来てくれたら嬉しいな💕", "goal":"reply_or_visit"},
      {"step":1, "delay_hours":24, "template":"フォロー+次回予告", "message":"{username}さん、昨日は本当にありがとう😊 次の配信も楽しみにしててね！気が向いたら来てくれたら嬉しいな💕", "goal":"reply_or_visit"}
    ]'::JSONB,
    true, true, 50, 24
  ),
  -- 離脱防止(7日)
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    '離脱防止(7日)',
    'dormant',
    '{"days": 7}'::JSONB,
    ARRAY['S1','S2','S3','S4','S5','S6','S7','S8'],
    '[
      {"step":0, "delay_hours":0, "template":"軽い安否確認", "message":"{username}さん、最近来てくれてないから気になっちゃって😊 元気にしてますか？無理しないでね💕", "goal":"reply_or_visit"},
      {"step":1, "delay_hours":72, "template":"次回配信告知", "message":"{username}さん、今度の配信でちょっと特別なことやろうと思ってるんだ😊 気が向いたら見に来てね💕", "goal":"reply_or_visit"},
      {"step":2, "delay_hours":168, "template":"最終フォロー", "message":"{username}さん、あなたのこと忘れてないよ😊 またいつでも遊びに来てね。待ってるから💕", "goal":"reply_or_visit"}
    ]'::JSONB,
    true, true, 30, 48
  ),
  -- 来訪フォロー
  (
    '940e7248-1d73-4259-a538-56fdaea9d740',
    '来訪フォロー',
    'visit_no_action',
    '{}',
    ARRAY['S5','S6','S7','S8','S9','S10'],
    '[
      {"step":0, "delay_hours":1, "template":"来てくれたお礼", "message":"{username}さん、さっきは来てくれてありがとう😊 短い時間だったけど嬉しかったです！また気が向いたら遊びに来てね💕", "goal":"reply_or_visit"}
    ]'::JSONB,
    true, true, 50, 24
  )
ON CONFLICT DO NOTHING;
