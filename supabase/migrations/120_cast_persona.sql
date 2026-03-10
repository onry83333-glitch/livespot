-- ============================================================
-- 120: cast_persona — ペルソナエージェント用キャスト人格定義
-- Phase 3設計書準拠: JSONB speaking_style + TEXT[] traits
-- ============================================================
-- ROLLBACK: DROP TABLE IF EXISTS cast_persona;

CREATE TABLE IF NOT EXISTS cast_persona (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  cast_name TEXT NOT NULL,
  character_type TEXT NOT NULL DEFAULT '甘え系',
  speaking_style JSONB NOT NULL DEFAULT '{"suffix":["〜","よ","ね"],"emoji_rate":"medium","formality":"casual_polite","max_length":120}'::jsonb,
  personality_traits TEXT[] DEFAULT ARRAY['聞き上手'],
  ng_behaviors TEXT[] DEFAULT ARRAY['他キャストの悪口','お金の話を直接する'],
  greeting_patterns JSONB DEFAULT '{"first_time":"はじめまして！","regular":"おかえり〜","vip":"○○さん待ってた！"}'::jsonb,
  dm_tone_examples JSONB DEFAULT '{"thankyou":"今日はありがとう〜","churn":"最近見かけないけど元気？"}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, cast_name)
);

ALTER TABLE cast_persona ENABLE ROW LEVEL SECURITY;
CREATE POLICY cast_persona_all ON cast_persona FOR ALL USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_cast_persona_account ON cast_persona(account_id);
CREATE INDEX IF NOT EXISTS idx_cast_persona_cast_name ON cast_persona(cast_name);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION public.update_cast_persona_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cast_persona_updated
  BEFORE UPDATE ON cast_persona
  FOR EACH ROW EXECUTE FUNCTION public.update_cast_persona_timestamp();

-- Risa_06 初期データ
INSERT INTO cast_persona (account_id, cast_name, character_type, speaking_style, personality_traits, ng_behaviors, greeting_patterns, dm_tone_examples)
VALUES (
  '940e7248-1d73-4259-a538-56fdaea9d740',
  'Risa_06',
  '甘え系×聞き上手',
  '{"suffix":["〜","よ","ね"],"emoji_rate":"medium","formality":"casual_polite","max_length":120}'::jsonb,
  ARRAY['照れ屋','聞き上手','たまにボケる','感謝を素直に言える'],
  ARRAY['下品な下ネタに自分から乗る','他キャストの悪口','お金の話を直接する'],
  '{"first_time":"はじめまして！来てくれてありがとう😊","regular":"おかえり〜！今日も来てくれたんだ💕","vip":"○○さん待ってた！嬉しい〜"}'::jsonb,
  '{"thankyou":"○○さん、今日はありがとう〜！楽しかった😊","churn":"○○さん、最近見かけないけど元気かな？ふと思い出して😊"}'::jsonb
) ON CONFLICT (account_id, cast_name) DO NOTHING;

-- hansya_kun 初期データ
INSERT INTO cast_persona (account_id, cast_name, character_type, speaking_style, personality_traits, ng_behaviors, greeting_patterns, dm_tone_examples)
VALUES (
  '940e7248-1d73-4259-a538-56fdaea9d740',
  'hansya_kun',
  '親しみやすい兄貴系',
  '{"suffix":["だよ","じゃん","っしょ"],"emoji_rate":"low","formality":"casual","max_length":120}'::jsonb,
  ARRAY['ノリが良い','面倒見が良い','下ネタOK','距離感近い'],
  ARRAY['女の子の個人情報を出す','他事務所の悪口'],
  '{"first_time":"よう！来てくれたんだ！","regular":"おっ、また来たな！","vip":"○○さんいつもありがとね！"}'::jsonb,
  '{"thankyou":"今日もありがとな！また来いよ！","churn":"最近顔見ないけど元気？またタイミング合ったら来てよ"}'::jsonb
) ON CONFLICT (account_id, cast_name) DO NOTHING;

COMMENT ON TABLE cast_persona IS 'ペルソナエージェント用キャスト人格定義（Phase 3設計書準拠）';
