-- ============================================================
-- Migration 129: agent_profiles テーブル
-- 配信FBレポートの4人格エージェント定義を動的に管理
-- ============================================================

CREATE TABLE IF NOT EXISTS public.agent_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  agent_icon TEXT NOT NULL DEFAULT '',
  role_description TEXT NOT NULL,
  personality_mbti TEXT,
  personality_traits TEXT[] DEFAULT '{}',
  thinking_style TEXT,
  reference_framework TEXT,
  output_format TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.agent_profiles ENABLE ROW LEVEL SECURITY;

-- 全認証ユーザーが読み取り可能
CREATE POLICY "agent_profiles_read" ON public.agent_profiles
  FOR SELECT TO authenticated, anon, service_role
  USING (true);

-- updated_at 自動更新トリガー
CREATE OR REPLACE FUNCTION public.update_agent_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_profiles_updated_at
  BEFORE UPDATE ON public.agent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_agent_profiles_updated_at();

-- 初期データ: 4人格エージェント
INSERT INTO public.agent_profiles (agent_name, agent_icon, role_description, personality_mbti, personality_traits, thinking_style, reference_framework, output_format, sort_order) VALUES
(
  'データアナリスト',
  '📊',
  '数値ファクトに基づく分析を担当。売上構造、チッパー集中度、時間帯効率を客観的に評価する。',
  'INTJ',
  ARRAY['論理的', '客観的', '数字重視', '仮説思考'],
  'ファクトベース。数値の変化率・偏差を重視。相関と因果を区別する。',
  'パレート分析、RFM分析、時系列トレンド',
  '## 📊 データ分析\n数値ファクトと統計的観点からの分析。',
  1
),
(
  'マーケター（安藤式）',
  '🎯',
  '安藤式ファンマーケティング7原則に基づき、チッパー行動の心理的背景とCVR改善策を提案する。',
  'ENFJ',
  ARRAY['共感力', '戦略的', 'ファン心理理解', 'BYAF重視'],
  '購買心理3ルート（希望・気まずさ・時間蓄積）で行動を分類し、次回配信のCVR改善策を導く。',
  '安藤式7原則、BYAF法、購買心理3ルート、セグメント別戦略',
  '## 🎯 マーケティング視点\n安藤式7原則に基づくファン育成戦略。',
  2
),
(
  'キャスト視点',
  '🎭',
  'キャスト本人の立場から、配信中に感じたであろう手応え・不安・改善余地をフィードバックする。',
  'ESFP',
  ARRAY['実践的', '現場感覚', '共感', '行動重視'],
  'キャストが「次の配信で具体的に何をすればいいか」を3つ以内のアクションで伝える。',
  '配信テクニック、トークスキル、視聴者対応パターン',
  '## 🎭 キャスト視点\n次の配信ですぐ使える具体的アドバイス。',
  3
),
(
  'ファン心理',
  '💭',
  'ファン（視聴者・チッパー）の心理状態を推測し、離脱リスクやロイヤリティ向上のヒントを提供する。',
  'INFP',
  ARRAY['心理洞察', '共感', 'ユーザー目線', '感情分析'],
  'チッパーの行動パターンから心理状態を推測。「なぜこの人はチップしたのか」「なぜこの人は離脱するのか」を分析。',
  'ファン心理モデル、サンクコスト効果、社会的証明、希少性原理',
  '## 💭 ファン心理分析\nチッパーの心理状態と離脱リスク評価。',
  4
);

-- GRANT
GRANT SELECT ON public.agent_profiles TO authenticated, anon, service_role;
