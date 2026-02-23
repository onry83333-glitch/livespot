-- ============================================================
-- 056: cast_personas — キャストごとのキャラクター定義
-- SaaSの核心: キャストが増えるほどAIが賢くなる設計の基盤
-- ============================================================

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

CREATE POLICY "cast_personas_all" ON public.cast_personas
    FOR ALL USING (account_id IN (SELECT user_account_ids()));

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION public.update_persona_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_persona_updated
  BEFORE UPDATE ON public.cast_personas
  FOR EACH ROW EXECUTE FUNCTION public.update_persona_timestamp();

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
