-- ============================================================
-- 056 + 057 + 058 統合マイグレーション
-- Supabase SQL Editor にコピペで実行可能
-- 冪等: 何回実行しても安全（IF NOT EXISTS / DO $$ / ON CONFLICT）
-- ============================================================

-- ************************************************************
-- 056: cast_personas — キャストごとのキャラクター定義
-- ************************************************************

CREATE TABLE IF NOT EXISTS public.cast_personas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  cast_name TEXT NOT NULL,

  -- キャラクター定義
  display_name TEXT,
  personality TEXT,
  speaking_style TEXT,
  emoji_style TEXT,
  taboo_topics TEXT,
  greeting_patterns JSONB DEFAULT '[]',

  -- DM生成用パラメータ
  dm_tone TEXT DEFAULT 'friendly'
      CHECK (dm_tone IN ('friendly', 'flirty', 'cool', 'cute')),
  byaf_style TEXT,

  -- System Prompt 3層
  system_prompt_base TEXT,
  system_prompt_cast TEXT,
  system_prompt_context TEXT,

  -- メタ
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(account_id, cast_name)
);

CREATE INDEX IF NOT EXISTS idx_personas_cast
    ON public.cast_personas(account_id, cast_name);

ALTER TABLE public.cast_personas ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cast_personas' AND policyname = 'cast_personas_all'
  ) THEN
    CREATE POLICY "cast_personas_all" ON public.cast_personas
      FOR ALL USING (account_id IN (SELECT user_account_ids()));
  END IF;
END $$;

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION public.update_persona_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_persona_updated'
      AND tgrelid = 'public.cast_personas'::regclass
  ) THEN
    CREATE TRIGGER trg_persona_updated
      BEFORE UPDATE ON public.cast_personas
      FOR EACH ROW EXECUTE FUNCTION public.update_persona_timestamp();
  END IF;
END $$;

-- デフォルトデータ
INSERT INTO public.cast_personas (
  account_id, cast_name, display_name, personality, speaking_style,
  emoji_style, dm_tone, byaf_style, system_prompt_base
) VALUES
  ('940e7248-1d73-4259-a538-56fdaea9d740', 'Risa_06', 'りさ',
   '明るくて甘えん坊。ファンとの距離が近い。初見にも優しい。',
   '〜だよ！〜かな？〜してくれると嬉しいな💕',
   '❤️🥰😘多め',
   'flirty',
   '来てくれたら嬉しいな💕でも無理しないでね！',
   'あなたはStripchatで配信するキャストのDMアシスタントです。安藤式ファンマーケ原則に従い、BYAF（But You Are Free）で締めます。課金を強制しない。ファンとの関係構築が最優先。'),
  ('940e7248-1d73-4259-a538-56fdaea9d740', 'hanshakun', 'はんしゃくん',
   '元気でノリが良い。チケットショーが主力。グループの盛り上がり重視。',
   '〜だよ〜！めっちゃ楽しかった！みんなありがとう！',
   '🎉✨😆多め',
   'friendly',
   'よかったら遊びに来てね！待ってるよ〜！',
   'あなたはStripchatで配信するキャストのDMアシスタントです。安藤式ファンマーケ原則に従い、BYAF（But You Are Free）で締めます。課金を強制しない。ファンとの関係構築が最優先。')
ON CONFLICT (account_id, cast_name) DO NOTHING;

COMMENT ON TABLE public.cast_personas
    IS 'キャストごとのキャラクター定義（DM文面生成・AIコーチング用）';


-- ************************************************************
-- 057: DMシナリオエンジン v2
-- ************************************************************

-- 1. trigger_type CHECK制約を拡張（既存4種 + 新6種 = 計10種）
DO $$
BEGIN
  -- 既存の CHECK制約を削除（存在する場合）
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dm_scenarios'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%trigger_type%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE dm_scenarios DROP CONSTRAINT ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid = 'dm_scenarios'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%trigger_type%'
      LIMIT 1
    );
  END IF;

  -- 新しい CHECK制約を追加（10種）
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dm_scenarios'::regclass
      AND conname = 'dm_scenarios_trigger_type_check'
  ) THEN
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
  END IF;
END $$;

COMMENT ON COLUMN dm_scenarios.trigger_type
  IS 'トリガー種別: thankyou_vip/thankyou_regular/thankyou_first/churn_recovery/first_payment/high_payment/visit_no_action/dormant/segment_change/manual';

-- 2. trigger_config JSONB カラム追加
ALTER TABLE dm_scenarios
ADD COLUMN IF NOT EXISTS trigger_config JSONB DEFAULT '{}';

COMMENT ON COLUMN dm_scenarios.trigger_config
  IS 'トリガー条件の詳細設定 (例: {"days": 7} for dormant, {"min_tokens": 500} for high_payment)';

-- 3. dm_scenario_steps テーブル
CREATE TABLE IF NOT EXISTS dm_scenario_steps (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES dm_scenarios(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  delay_hours INTEGER DEFAULT 0,
  message_template TEXT NOT NULL,
  use_persona BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE dm_scenario_steps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
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

COMMENT ON TABLE dm_scenario_steps
  IS 'DMシナリオ 正規化ステップ定義（dm_scenarios.steps JSONBと共存）';

-- 4. インデックス追加
CREATE INDEX IF NOT EXISTS idx_dm_scenario_steps_scenario
  ON dm_scenario_steps(scenario_id, step_number);

CREATE INDEX IF NOT EXISTS idx_dm_scenarios_trigger_type
  ON dm_scenarios(account_id, trigger_type, is_active);

CREATE INDEX IF NOT EXISTS idx_enrollments_cast_username
  ON dm_scenario_enrollments(account_id, cast_name, username);

-- 5. completed_at カラム追加
ALTER TABLE dm_scenario_enrollments
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN dm_scenario_enrollments.completed_at
  IS 'シナリオ完了日時（completed/goal_reached時に記録）';

-- 6. 新シナリオ3件 INSERT
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


-- ************************************************************
-- 058: 他社SPYマーケット分析RPC（3関数）
-- ************************************************************

-- 1. 時間帯別視聴者数推移（他社キャスト）
DROP FUNCTION IF EXISTS public.get_spy_viewer_trends(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_viewer_trends(
  p_account_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  cast_name TEXT,
  hour_of_day INTEGER,
  avg_viewers NUMERIC,
  max_viewers INTEGER,
  broadcast_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.cast_name,
    EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')::INTEGER AS hour_of_day,
    ROUND(AVG((sm.metadata->>'total')::NUMERIC), 0) AS avg_viewers,
    MAX((sm.metadata->>'total')::INTEGER) AS max_viewers,
    COUNT(DISTINCT DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo'))::INTEGER AS broadcast_count
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.msg_type = 'viewer_count'
    AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    AND sm.metadata->>'total' IS NOT NULL
    AND (sm.metadata->>'total')::INTEGER > 0
    AND sm.cast_name NOT IN (
      SELECT rc.cast_name FROM public.registered_casts rc
      WHERE rc.account_id = p_account_id
    )
  GROUP BY sm.cast_name, EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo')
  ORDER BY sm.cast_name, hour_of_day;
END;
$$;

COMMENT ON FUNCTION public.get_spy_viewer_trends(UUID, INTEGER)
  IS '他社キャストの時間帯別視聴者数推移（viewer_count metadata.total）';


-- 2. 他社キャストの課金タイプ分布
DROP FUNCTION IF EXISTS public.get_spy_revenue_types(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_revenue_types(
  p_account_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  cast_name TEXT,
  tip_count BIGINT,
  ticket_count BIGINT,
  group_count BIGINT,
  total_tokens BIGINT,
  broadcast_days INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sm.cast_name,
    COUNT(*) FILTER (WHERE sm.msg_type IN ('tip', 'gift') AND sm.tokens > 0)::BIGINT AS tip_count,
    COUNT(*) FILTER (WHERE sm.msg_type = 'goal')::BIGINT AS ticket_count,
    COUNT(*) FILTER (WHERE sm.msg_type IN ('group_join', 'group_end'))::BIGINT AS group_count,
    COALESCE(SUM(sm.tokens) FILTER (WHERE sm.tokens > 0), 0)::BIGINT AS total_tokens,
    COUNT(DISTINCT DATE(sm.message_time AT TIME ZONE 'Asia/Tokyo'))::INTEGER AS broadcast_days
  FROM public.spy_messages sm
  WHERE sm.account_id = p_account_id
    AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
    AND sm.cast_name NOT IN (
      SELECT rc.cast_name FROM public.registered_casts rc
      WHERE rc.account_id = p_account_id
    )
  GROUP BY sm.cast_name;
END;
$$;

COMMENT ON FUNCTION public.get_spy_revenue_types(UUID, INTEGER)
  IS '他社キャストの課金タイプ分布（チップ/チケット/グループ）';


-- 3. 現在の時間帯のマーケット概況サマリー
DROP FUNCTION IF EXISTS public.get_spy_market_now(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_spy_market_now(
  p_account_id UUID,
  p_days INTEGER DEFAULT 7
)
RETURNS TABLE (
  current_hour INTEGER,
  active_casts INTEGER,
  avg_viewers_now NUMERIC,
  best_cast TEXT,
  best_viewers INTEGER,
  own_avg_viewers NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_hour INTEGER;
BEGIN
  v_hour := EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tokyo')::INTEGER;

  RETURN QUERY
  WITH
  spy_hourly AS (
    SELECT
      sm.cast_name,
      ROUND(AVG((sm.metadata->>'total')::NUMERIC), 0) AS avg_v,
      MAX((sm.metadata->>'total')::INTEGER) AS max_v
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.msg_type = 'viewer_count'
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND sm.metadata->>'total' IS NOT NULL
      AND (sm.metadata->>'total')::INTEGER > 0
      AND EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo') = v_hour
      AND sm.cast_name NOT IN (
        SELECT rc.cast_name FROM public.registered_casts rc
        WHERE rc.account_id = p_account_id
      )
    GROUP BY sm.cast_name
  ),
  own_hourly AS (
    SELECT
      ROUND(AVG((sm.metadata->>'total')::NUMERIC), 0) AS avg_v
    FROM public.spy_messages sm
    WHERE sm.account_id = p_account_id
      AND sm.msg_type = 'viewer_count'
      AND sm.message_time >= NOW() - (p_days || ' days')::INTERVAL
      AND sm.metadata->>'total' IS NOT NULL
      AND (sm.metadata->>'total')::INTEGER > 0
      AND EXTRACT(HOUR FROM sm.message_time AT TIME ZONE 'Asia/Tokyo') = v_hour
      AND sm.cast_name IN (
        SELECT rc.cast_name FROM public.registered_casts rc
        WHERE rc.account_id = p_account_id
      )
  ),
  best AS (
    SELECT sh.cast_name, sh.max_v
    FROM spy_hourly sh
    ORDER BY sh.avg_v DESC
    LIMIT 1
  )
  SELECT
    v_hour AS current_hour,
    COUNT(*)::INTEGER AS active_casts,
    ROUND(AVG(sh.avg_v), 0) AS avg_viewers_now,
    (SELECT b.cast_name FROM best b) AS best_cast,
    (SELECT b.max_v FROM best b) AS best_viewers,
    (SELECT oh.avg_v FROM own_hourly oh) AS own_avg_viewers
  FROM spy_hourly sh;
END;
$$;

COMMENT ON FUNCTION public.get_spy_market_now(UUID, INTEGER)
  IS '現在時刻のマーケット概況（他社視聴者平均・ベストキャスト・自社比較）';


-- ============================================================
-- 完了！ 056 + 057 + 058 全て適用済み
-- ============================================================
