-- Migration 041: DMシナリオエンジン
-- dm_scenarios: シナリオ定義（ステップ配列 + トリガー条件）
-- dm_scenario_enrollments: ユーザーごとのシナリオ進行状態
-- detect_churn_risk: 閾値変更（90日→14日）
-- 初期シナリオ4件INSERT

-- ============================================================
-- 1. dm_scenarios テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS dm_scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scenario_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('thankyou_vip','thankyou_regular','thankyou_first','churn_recovery')),
  segment_targets TEXT[] DEFAULT '{}',
  steps JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  auto_approve_step0 BOOLEAN DEFAULT true,
  daily_send_limit INTEGER DEFAULT 50,
  min_interval_hours INTEGER DEFAULT 24,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE dm_scenarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dm_scenarios_account_scope" ON dm_scenarios
  FOR ALL USING (account_id IN (SELECT user_account_ids()));

COMMENT ON TABLE dm_scenarios IS 'DMシナリオ定義: ステップ配信テンプレート + トリガー条件';
COMMENT ON COLUMN dm_scenarios.trigger_type IS 'トリガー種別: thankyou_vip/thankyou_regular/thankyou_first/churn_recovery';
COMMENT ON COLUMN dm_scenarios.steps IS 'ステップ配列 JSONB: [{step, delay_hours, template, goal}]';
COMMENT ON COLUMN dm_scenarios.auto_approve_step0 IS 'Step0を自動承認（queued）にするか';
COMMENT ON COLUMN dm_scenarios.daily_send_limit IS '1日あたりの最大送信数';
COMMENT ON COLUMN dm_scenarios.min_interval_hours IS '同一ユーザーへの最小送信間隔（時間）';

-- ============================================================
-- 2. dm_scenario_enrollments テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS dm_scenario_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES dm_scenarios(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cast_name TEXT,
  username TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  current_step INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled','goal_reached')),
  last_step_sent_at TIMESTAMPTZ,
  next_step_due_at TIMESTAMPTZ,
  goal_type TEXT,
  goal_reached_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  UNIQUE(scenario_id, username, cast_name)
);

ALTER TABLE dm_scenario_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dm_scenario_enrollments_account_scope" ON dm_scenario_enrollments
  FOR ALL USING (account_id IN (SELECT user_account_ids()));

-- Realtime有効化
ALTER PUBLICATION supabase_realtime ADD TABLE dm_scenario_enrollments;

CREATE INDEX idx_enrollments_status ON dm_scenario_enrollments(status, next_step_due_at);
CREATE INDEX idx_enrollments_username ON dm_scenario_enrollments(account_id, username);

COMMENT ON TABLE dm_scenario_enrollments IS 'DMシナリオ エンロールメント: ユーザーごとの進行状態';
COMMENT ON COLUMN dm_scenario_enrollments.current_step IS '現在のステップ番号（0始まり）';
COMMENT ON COLUMN dm_scenario_enrollments.status IS 'active/completed/cancelled/goal_reached';
COMMENT ON COLUMN dm_scenario_enrollments.next_step_due_at IS '次ステップの送信予定時刻';

-- ============================================================
-- 3. detect_churn_risk 閾値変更（出席率しきい値 0.3 は据え置き）
-- p_absence_threshold デフォルト 2→2 のまま、RPC側は変えない。
-- 呼び出し元 (background.js) で p_lookback_sessions を調整。
-- ============================================================
-- (閾値変更はRPC自体ではなく呼び出し側で対応するため、ここでは変更なし)

-- ============================================================
-- 4. 初期シナリオ4件 INSERT
-- ============================================================
INSERT INTO dm_scenarios (account_id, scenario_name, trigger_type, segment_targets, steps, is_active, auto_approve_step0, daily_send_limit, min_interval_hours)
VALUES
  -- A: VIPお礼→リエンゲージ
  ('940e7248-1d73-4259-a538-56fdaea9d740',
   'VIPお礼→リエンゲージ',
   'thankyou_vip',
   ARRAY['S1','S2','S3'],
   '[
     {"step":0, "delay_hours":0, "template":"お礼+特別感", "message":"{username}さん、今日は本当にありがとう💕 あなたがいてくれると特別な時間になります。また会えたら嬉しいな😊", "goal":"reply_or_visit"},
     {"step":1, "delay_hours":48, "template":"次回予告+言質取り", "message":"{username}さん、実は次の配信でちょっと特別なことやろうと思ってるんだ😊 来てくれたら嬉しいな💕", "goal":"reply_or_visit"},
     {"step":2, "delay_hours":120, "template":"限定企画+BYAF", "message":"{username}さん、元気にしてますか？😊 今度の配信で限定企画やるんだけど、気が向いたら来てくれたら嬉しいな。でも無理しないでね、あなたの自由だから💕", "goal":"reply_or_visit"}
   ]'::JSONB,
   true, true, 50, 24),

  -- B: 常連お礼→定着促進
  ('940e7248-1d73-4259-a538-56fdaea9d740',
   '常連お礼→定着促進',
   'thankyou_regular',
   ARRAY['S5','S6','S7','S8'],
   '[
     {"step":0, "delay_hours":0, "template":"お礼+居場所感", "message":"{username}さん、ありがとう😊 あなたがいてくれるとすごく楽しいです！ またふらっと遊びに来てくださいね💕", "goal":"reply_or_visit"},
     {"step":1, "delay_hours":72, "template":"日常トーク+行動再定義", "message":"{username}さん、最近どうですか？😊 いつも来てくれて嬉しいです。あなたの存在が私の元気の源なんです💕 また気が向いたらね！", "goal":"reply_or_visit"}
   ]'::JSONB,
   true, true, 50, 24),

  -- C: 初回お礼→2回目誘導
  ('940e7248-1d73-4259-a538-56fdaea9d740',
   '初回お礼→2回目誘導',
   'thankyou_first',
   ARRAY['S9'],
   '[
     {"step":0, "delay_hours":0, "template":"短く嬉しさ", "message":"{username}さん、ありがとう😊 すごく嬉しかったです！", "goal":"reply_or_visit"},
     {"step":1, "delay_hours":24, "template":"自己紹介+次回誘導", "message":"{username}さん、昨日はありがとうございました😊 私のこともう少し知ってもらえたら嬉しいな。また気が向いたら遊びに来てくださいね💕", "goal":"reply_or_visit"}
   ]'::JSONB,
   true, true, 50, 24),

  -- D: 離脱防止→復帰誘導
  ('940e7248-1d73-4259-a538-56fdaea9d740',
   '離脱防止→復帰誘導',
   'churn_recovery',
   ARRAY['S1','S2','S3','S4','S5','S6','S7','S8','S9'],
   '[
     {"step":0, "delay_hours":0, "template":"軽く安否確認", "message":"{username}さん、最近見かけないので気になっちゃって😊 元気にしてますか？ 無理しないでね、あなたの自由だから💕", "goal":"reply_or_visit"},
     {"step":1, "delay_hours":168, "template":"企画告知+BYAF", "message":"{username}さん、お久しぶりです😊 今度ちょっと面白いこと企画してるんだ。気が向いたらふらっと来てくれたら嬉しいな💕 でも無理しないでね！", "goal":"reply_or_visit"},
     {"step":2, "delay_hours":336, "template":"最終DM+サンクコスト", "message":"{username}さん、ずっと気になってました😊 あなたと過ごした時間は私の宝物です。またいつか会えたら嬉しいな。でも無理しないでね、あなたの自由だから💕", "goal":"reply_or_visit"}
   ]'::JSONB,
   true, true, 30, 48);
