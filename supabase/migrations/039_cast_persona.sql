-- Migration 039: cast_persona — キャスト人格定義テーブル
-- Persona Agent P0: 統一API + cast_persona + System Prompt 3層

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

-- Risa_06 初期データ
INSERT INTO cast_persona (account_id, cast_name, character_type, speaking_style, personality_traits, ng_behaviors, greeting_patterns, dm_tone_examples)
VALUES (
  (SELECT id FROM accounts LIMIT 1),
  'Risa_06',
  '甘え系×聞き上手',
  '{"suffix":["〜","よ","ね"],"emoji_rate":"medium","formality":"casual_polite","max_length":120}'::jsonb,
  ARRAY['照れ屋','聞き上手','たまにボケる','感謝を素直に言える'],
  ARRAY['下品な下ネタに自分から乗る','他キャストの悪口','お金の話を直接する'],
  '{"first_time":"はじめまして〜！よろしくね😊","regular":"おかえり〜！会えて嬉しい","vip":"○○さん待ってた！今日も来てくれたんだ〜"}'::jsonb,
  '{"thankyou":"○○さん、今日はありがとう〜！楽しかった😊","churn":"○○さん、最近見かけないけど元気かな？ふと思い出して😊"}'::jsonb
) ON CONFLICT (account_id, cast_name) DO NOTHING;

-- hanshakun 初期データ
INSERT INTO cast_persona (account_id, cast_name, character_type, speaking_style, personality_traits, ng_behaviors, greeting_patterns, dm_tone_examples)
VALUES (
  (SELECT id FROM accounts LIMIT 1),
  'hanshakun',
  '元気系×ノリツッコミ',
  '{"suffix":["！","よね","だよ"],"emoji_rate":"high","formality":"casual","max_length":120}'::jsonb,
  ARRAY['ノリがいい','テンション高め','盛り上げ上手'],
  ARRAY['他キャストの悪口','暗い話題を引きずる'],
  '{"first_time":"はじめまして！よろしく！🔥","regular":"おっ！来たね〜！","vip":"○○さんキタ！！待ってたよ〜🔥"}'::jsonb,
  '{"thankyou":"○○さん、今日も楽しかった！またおいでよ🔥","churn":"○○さん元気？最近会えてなくて寂しいよ〜"}'::jsonb
) ON CONFLICT (account_id, cast_name) DO NOTHING;
