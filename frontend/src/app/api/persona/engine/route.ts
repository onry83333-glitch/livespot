import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';
import { LAYER_A_ANDO_FOUNDATION } from '@/lib/prompts/layer-a-ando';
import { LAYER_A_PRINCESS_MARKETING } from '@/lib/prompts/layer-a-princess';
import { buildCastRAGContext } from '@/lib/rag-context';

// ============================================================
// 統一クリエイティブエンジン /api/persona/engine
// task_type: dm / x_post / recruitment / content
// 既存 /api/persona/route.ts の Layer A/B/C 構造を維持
// 過去の高評価データを persona_feedback から取得してコンテキストに含める
// ============================================================

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/[\s\r\n]+/g, '');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

type EngineTaskType = 'dm' | 'x_post' | 'recruitment' | 'content' | 'fb_report';

interface EngineRequest {
  task_type: EngineTaskType;
  cast_name: string;
  account_id?: string;
  context: Record<string, unknown>;
}

interface CastPersona {
  id: string;
  account_id: string;
  cast_name: string;
  display_name: string | null;
  personality: string | null;
  speaking_style: string | null;
  emoji_style: string | null;
  taboo_topics: string | null;
  dm_tone: string;
  byaf_style: string | null;
  system_prompt_base: string | null;
  system_prompt_cast: string | null;
  system_prompt_context: string | null;
}

interface CastPersonaDetail {
  speaking_style: {
    suffix?: string[];
    emoji_rate?: string;
    formality?: string;
    max_length?: number;
  } | null;
  personality_traits: string[] | null;
  ng_behaviors: string[] | null;
  greeting_patterns: Record<string, string> | null;
  dm_tone_examples: Record<string, string> | null;
}

interface FeedbackRow {
  output: string;
  score: number;
  input_context: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface AgentProfile {
  agent_name: string;
  agent_icon: string;
  role_description: string;
  personality_mbti: string | null;
  personality_traits: string[];
  thinking_style: string | null;
  reference_framework: string | null;
  output_format: string | null;
}

interface FiveAxisData {
  tipperStructure: string;
  tipTriggers: string;
  chatTemperature: string;
  diffFromPrevious: string;
  benchmark: string;
  dmActionLists: string;  // Group D: #11離脱予兆, #12初回課金後再訪率, #13復帰きっかけ
}

const DEFAULT_PERSONA: CastPersona = {
  id: '',
  account_id: '',
  cast_name: 'default',
  display_name: null,
  personality: '聞き上手で優しい',
  speaking_style: '〜だよ！〜かな？',
  emoji_style: '適度に使用',
  taboo_topics: null,
  dm_tone: 'friendly',
  byaf_style: 'もちろん無理しないでね！',
  system_prompt_base: null,
  system_prompt_cast: null,
  system_prompt_context: null,
};

// ============================================================
// Supabase クライアント
// ============================================================
function getAuthClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// ============================================================
// cast_persona テーブルからの詳細データ取得
// ============================================================
async function fetchCastPersonaDetail(
  token: string,
  castName: string,
  accountId?: string | null,
): Promise<CastPersonaDetail | null> {
  try {
    const sb = getAuthClient(token);
    let query = sb
      .from('cast_persona')
      .select('speaking_style, personality_traits, ng_behaviors, greeting_patterns, dm_tone_examples')
      .eq('cast_name', castName);
    if (accountId) query = query.eq('account_id', accountId);
    const { data } = await query.single();
    return data as CastPersonaDetail | null;
  } catch {
    return null;
  }
}

// ============================================================
// 過去の高評価データを persona_feedback から取得
// ============================================================
async function fetchTopFeedback(
  token: string,
  castName: string,
  taskType: EngineTaskType,
  limit = 5,
): Promise<FeedbackRow[]> {
  try {
    const sb = getAuthClient(token);
    const { data } = await sb
      .from('persona_feedback')
      .select('output, score, input_context, metadata')
      .eq('cast_name', castName)
      .eq('task_type', taskType)
      .not('score', 'is', null)
      .gte('score', 70)
      .order('score', { ascending: false })
      .limit(limit);
    return (data as FeedbackRow[]) || [];
  } catch {
    return [];
  }
}

// ============================================================
// Layer B — キャスト人格定義
// ============================================================
function buildLayerB(persona: CastPersona, detail?: CastPersonaDetail | null): string {
  const parts = [
    `=== あなたのキャラクター ===`,
    `キャスト名: ${persona.display_name || persona.cast_name}`,
  ];

  if (persona.personality) parts.push(`性格: ${persona.personality}`);
  if (persona.speaking_style) parts.push(`口調: ${persona.speaking_style}`);
  if (persona.emoji_style) parts.push(`絵文字: ${persona.emoji_style}`);
  if (persona.dm_tone) parts.push(`DMトーン: ${persona.dm_tone}`);
  if (persona.byaf_style) parts.push(`BYAF: ${persona.byaf_style}`);
  if (persona.taboo_topics) parts.push(`\n禁止話題:\n${persona.taboo_topics}`);

  if (detail) {
    if (detail.speaking_style) {
      const ss = detail.speaking_style;
      if (ss.suffix?.length) parts.push(`語尾パターン: ${ss.suffix.join('、')}`);
      if (ss.emoji_rate) parts.push(`絵文字使用頻度: ${ss.emoji_rate}`);
      if (ss.formality) parts.push(`フォーマリティ: ${ss.formality}`);
      if (ss.max_length) parts.push(`最大文字数: ${ss.max_length}文字`);
    }
    if (detail.personality_traits?.length) {
      parts.push(`\n性格特性:\n${detail.personality_traits.map(t => `- ${t}`).join('\n')}`);
    }
    if (detail.ng_behaviors?.length) {
      parts.push(`\nNG行動:\n${detail.ng_behaviors.map(b => `- ${b}`).join('\n')}`);
    }
    if (detail.greeting_patterns && Object.keys(detail.greeting_patterns).length) {
      const labels: Record<string, string> = { first_time: '初見', regular: '常連', vip: 'VIP' };
      const lines = Object.entries(detail.greeting_patterns)
        .map(([k, v]) => `- ${labels[k] || k}: 「${v}」`);
      parts.push(`\n挨拶パターン:\n${lines.join('\n')}`);
    }
    if (detail.dm_tone_examples && Object.keys(detail.dm_tone_examples).length) {
      const labels: Record<string, string> = { thankyou: 'お礼', churn: '離脱防止', follow: 'フォロー', pre_broadcast: '配信前' };
      const lines = Object.entries(detail.dm_tone_examples)
        .map(([k, v]) => `- ${labels[k] || k}: 「${v}」`);
      parts.push(`\nDMトーン見本:\n${lines.join('\n')}`);
    }
  }

  if (persona.system_prompt_cast) {
    parts.push(`\n=== キャスト固有ルール ===\n${persona.system_prompt_cast}`);
  }

  parts.push(`\n↓ このキャラクターとして生成してください。「このキャストが書きそうな文章」になっていることが最も重要。`);
  return parts.join('\n');
}

// ============================================================
// 高評価データをコンテキスト文字列に変換
// ============================================================
function buildFeedbackContext(feedback: FeedbackRow[]): string {
  if (feedback.length === 0) return '';
  const examples = feedback.slice(0, 3).map((f, i) =>
    `例${i + 1} (スコア${f.score}): ${f.output.slice(0, 200)}`
  ).join('\n');
  return `\n=== 過去の高評価データ（参考にして品質を維持） ===\n${examples}\n`;
}

// ============================================================
// Layer C — タスク固有ルール（統一エンジン版）
// ============================================================
const ENGINE_LAYER_C: Record<string, string> = {
  dm: `=== DM生成ルール ===
- 120文字以内。絶対に超えない。
- ユーザー名を必ず1回入れる。
- 末尾にBYAF要素必須。「もちろん無理しないでね」「気が向いたらでいいよ」等。
- 2通連続同じトーン禁止。感情→事実→感情の交互。
- spy_messagesのハイライトがあれば触れて個別感を出す。
- 1メッセージ=1トピック。
- セグメント別トーン:
  S1-S3(VIP)=特別感・唯一性。S4-S6(常連)=居場所感・安心感。
  S7-S8(中堅)=軽い誘い・好奇心。S9-S10(ライト/単発)=軽く短く。
- 必ず以下のJSON形式で出力:
{"message": "...", "reasoning": "..."}`,

  x_post: `=== X投稿生成ルール ===
- SOUL.mdの4モード対応:
  1. 思考共有モード: 事業や哲学について語る。知的好奇心を刺激。
  2. 日常切り取りモード: 何気ない日常を独自の視点で切り取る。
  3. 実績共有モード: 数字や成果を自然に共有。自慢にならないトーン。
  4. 問いかけモード: フォロワーに考えさせる問いを投げる。
- 140文字以内推奨（日本語）。超えてもOKだが280文字が上限。
- ハッシュタグは0-2個。過剰禁止。
- 「いいね稼ぎ」感を出さない。本物の声に聞こえること。
- JSON形式で出力:
{"post_text": "...", "mode": "思考共有|日常切り取り|実績共有|問いかけ", "reasoning": "...", "hashtags": ["..."]}`,

  recruitment: `=== 採用コピー生成ルール ===
- Princess Marketing Realism 4Step準拠。
- 訴求軸変換:
  主語: ×商品 → ○「あなた」
  訴求: ×ナンバーワン → ○オンリーワン（共感・特別感）
  動詞: ×「稼げる」 → ○「整う」「余裕ができる」
  CTA: ×「今すぐ応募」 → ○「まずは話だけ聞いてみませんか？」
  BYAF必須: 「合わなかったらそれでOK」
- 禁止ワード: チャットレディ/アダルト/風俗/水商売/簡単に稼げる/誰でもできる
- 職業名: 「ライブ配信パフォーマー」「オンラインパフォーマー」
- JSON形式で出力:
{"copy": "...", "step_breakdown": {"step1_empathy": "...", "step2_vision": "...", "step3_proof": "...", "step4_safe_cta": "..."}, "target_persona_fit": "..."}`,

  content: `=== コンテンツ生成ルール ===
- 用途に応じたフォーマットで出力:
  - 切り抜きの見どころ選定: タイムスタンプ+理由
  - 画像生成プロンプト: 英語で具体的に
  - 記事/ブログ: 見出し+本文構造
  - SNSキャプション: プラットフォーム最適化
- キャストのキャラクターに合ったトーン。
- 数値データがあれば根拠として引用。
- JSON形式で出力:
{"content": "...", "content_type": "...", "reasoning": "...", "metadata": {}}`,
};

// ============================================================
// User Prompt ビルダー
// ============================================================
function buildUserPrompt(
  taskType: EngineTaskType,
  context: Record<string, unknown>,
): string {
  switch (taskType) {
    case 'dm': {
      const userName = context.user_name as string || '';
      const segment = context.segment as string || '';
      const scenario = context.scenario_type as string || '';
      const recentMessages = context.recent_messages as string || '';
      const lastDm = context.last_dm as string || '';
      return `ユーザー名: ${userName}
セグメント: ${segment}
シナリオ: ${scenario}
${lastDm ? `前回DM: ${lastDm}\n→ 異なるトーンで生成すること` : ''}
${recentMessages ? `直近の発言ログ:\n${recentMessages}` : ''}

上記ユーザーに最適なDMを生成してください。`;
    }

    case 'x_post': {
      const mode = context.mode as string || '思考共有';
      const topic = context.topic as string || '';
      const tone = context.tone as string || '';
      const recentPosts = context.recent_posts as string || '';
      return `投稿モード: ${mode}
${topic ? `トピック: ${topic}` : ''}
${tone ? `トーン: ${tone}` : ''}
${recentPosts ? `直近投稿（被り回避）:\n${recentPosts}` : ''}

上記の条件でX投稿を生成してください。`;
    }

    case 'recruitment': {
      const targetPersona = context.target_persona as string || 'あかり（24歳・事務職OL）';
      const medium = context.medium as string || 'SNS広告';
      const maxLength = context.max_length as number || 200;
      const existingCopy = context.existing_copy as string || '';
      return `ターゲットペルソナ: ${targetPersona}
媒体: ${medium}
文字数上限: ${maxLength}文字
${existingCopy ? `既存コピー: 「${existingCopy}」\n→ 改善してください。` : 'Princess Marketing 4Stepに沿った採用コピーを新規作成してください。'}`;
    }

    case 'content': {
      const contentType = context.content_type as string || '';
      const description = context.description as string || '';
      const platform = context.platform as string || '';
      const additionalData = context.additional_data as string || '';
      return `コンテンツ種類: ${contentType}
${platform ? `プラットフォーム: ${platform}` : ''}
${description ? `説明: ${description}` : ''}
${additionalData ? `追加データ:\n${additionalData}` : ''}

上記の条件でコンテンツを生成してください。`;
    }

    case 'fb_report': {
      const fiveAxis = context.five_axis as FiveAxisData | undefined;
      const castDisplayName = context.cast_display_name as string || context.cast_name as string || '';
      return `# 配信FBレポート生成依頼

キャスト名: ${castDisplayName}

## データソースについて（絶対遵守）
以下のデータはエージェント1（データコレクター）がSQL + ルールベースで収集した構造化データです。
- [事実] タグ付きの数値は検証済み。1文字も変更せずそのまま引用すること。独自に数え直すな。
- 以下のユーザーリストは全員そのまま転記すること。1人も省略するな:
  「## 新規チッパー」「## 高額新規」「## リピーター」「## 復帰ユーザー」「## DM用ユーザー名リスト」
  「## #11 離脱予兆ユーザー」「## #12 初回課金後2回目来訪率」「## #13 復帰ユーザーの復帰きっかけ」
- [判定根拠] タグは判定ロジックの説明。
- [注意] タグはデータ欠損や制限事項。
- 上記以外の推測・分析を行う場合は必ず「推測:」「分析:」と明示すること。

## 5軸データ

### 軸1: チッパー構造
${fiveAxis?.tipperStructure || 'データなし'}

### 軸2: チップトリガー
${fiveAxis?.tipTriggers || 'データなし'}

### 軸3: チャット温度
${fiveAxis?.chatTemperature || 'データなし'}

### 軸4: 前回との差分
${fiveAxis?.diffFromPrevious || 'データなし'}

### 軸5: ベンチマーク
${fiveAxis?.benchmark || 'データなし'}

### 軸6: DM施策直結データ
${fiveAxis?.dmActionLists || 'データなし'}

## 分析指示
- 事実データに基づく分析と、推測に基づく提案を明確に分けること
- 「新規」の定義: このキャストへの初チップが今回セッション内の人。paid_usersテーブルの値ではない
- チッパーの履歴情報（初回日・累計tk）がある場合、常連の貢献度や離脱リスクの分析に使うこと
- チャットデータがない場合、チャット関連の推測は「チャットデータ未収集のため推測不可」と明示すること
- DMだけでなく、配信構成・ゴール設定・コミュニケーション施策も提案すること
- 軸6のDM施策直結データは「## 📩 DM施策アクションリスト」セクションとしてレポート末尾にまとめること
- 離脱予兆ユーザーには「また来てね」系DM、初回→未再訪には「初回ありがとう」系DM、復帰ユーザーには「おかえり」系DMを提案すること`;
    }

    default:
      return JSON.stringify(context);
  }
}

// ============================================================
// Claude API 呼び出し
// ============================================================
async function callClaude(systemPrompt: string, userPrompt: string, maxTokens = 1000) {
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!apiRes.ok) {
    const errBody = await apiRes.json().catch(() => ({}));
    if (apiRes.status === 401) {
      throw Object.assign(new Error('APIキーが無効です'), { statusCode: 502 });
    }
    if (apiRes.status === 429) {
      throw Object.assign(new Error('レート制限中です'), { statusCode: 429 });
    }
    throw Object.assign(
      new Error((errBody as Record<string, unknown>).error as string || `Claude API error: ${apiRes.status}`),
      { statusCode: 502 },
    );
  }

  const apiData = await apiRes.json();
  const text = apiData.content[0].text;
  const inputTokens = apiData.usage?.input_tokens || 0;
  const outputTokens = apiData.usage?.output_tokens || 0;
  return {
    text,
    tokensUsed: inputTokens + outputTokens,
    costUsd: (inputTokens * 3 + outputTokens * 15) / 1_000_000,
  };
}

// ============================================================
// agent_profiles から動的 Layer C を構築（fb_report用）
// ============================================================
async function fetchAgentProfiles(token: string): Promise<AgentProfile[]> {
  try {
    const sb = getAuthClient(token);
    const { data } = await sb
      .from('agent_profiles')
      .select('agent_name, agent_icon, role_description, personality_mbti, personality_traits, thinking_style, reference_framework, output_format')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    return (data as AgentProfile[]) || [];
  } catch {
    return [];
  }
}

function buildFbReportLayerC(agents: AgentProfile[]): string {
  const agentInstructions = agents.map(a => {
    const traits = a.personality_traits?.length ? a.personality_traits.join('・') : '';
    return `### ${a.agent_icon} ${a.agent_name}${a.personality_mbti ? ` (${a.personality_mbti})` : ''}
役割: ${a.role_description}
${traits ? `特性: ${traits}` : ''}
${a.thinking_style ? `思考法: ${a.thinking_style}` : ''}
${a.reference_framework ? `参照フレーム: ${a.reference_framework}` : ''}
${a.output_format ? `出力形式: ${a.output_format}` : ''}`;
  }).join('\n\n');

  return `=== 配信FBレポート生成ルール ===

あなたは4人のエージェントチームです。1回のレスポンスで全員の視点を含むMarkdownレポートを生成してください。

## エージェント定義
${agentInstructions}

## 出力フォーマット
Markdownで出力してください。以下の構造を守ること:

1. 冒頭に1行サマリー（配信の総合評価を1文で）
2. 各エージェントのセクション（上記の出力形式ヘッダーを使用）
3. 最後に「## 📋 次回配信アクションプラン」として具体的なアクション3つ

## ルール（絶対遵守）
- [事実] タグ付きデータの数値は1文字も変更するな。「新規20人」なら「新規20人」と出力しろ。独自に数え直すな。
- 以下のセクションはUser Promptのリストをそのまま全員転記しろ。1人も省略するな:
  - 「## 新規チッパー」— 全員のユーザー名・tk・回数
  - 「## 高額新規」— 全員のユーザー名・tk
  - 「## リピーター」— 全員のユーザー名・tk・回数・履歴
  - 「## 復帰ユーザー」— 全員のユーザー名・日数・tk
  - 「## DM用ユーザー名リスト」— コードブロック内のユーザー名リストをそのまま転記
  - 「## #11 離脱予兆ユーザー」— 全員のユーザー名・参加回数・累計tk
  - 「## #12 初回課金後2回目来訪率」— セッション別再訪率 + 未再訪ユーザーリスト全員
  - 「## #13 復帰ユーザーの復帰きっかけ」— 全員のユーザー名・日数・取引タイプ
- 推測・解釈を書く場合は必ず「推測:」「分析:」と明示すること
- 改善提案は「次の配信で」実行可能な具体策のみ
- 抽象的な提案禁止（×「コミュニケーションを増やす」→ ○「配信開始10分以内にチャットで名前を3人呼ぶ」）
- DMだけでなく、配信構成・ゴール設定・コミュニケーション施策も提案すること
- 安藤式7原則・BYAF法に触れる場合は具体例付きで
- JSON出力禁止。Markdownのみ。`;
}

// ============================================================
// エージェント1: データコレクター（情報収集特化）
// LLMは使わない。SQL + ルールベースで構造化された事実データを作る。
// 「事実」と「未検証」を明確に分離して出力。
// ============================================================
async function collect5AxisData(
  token: string,
  castName: string,
  accountId: string,
  sessionData?: Record<string, unknown>,
): Promise<FiveAxisData> {
  const sb = getAuthClient(token);
  const result: FiveAxisData = {
    tipperStructure: 'データなし',
    tipTriggers: 'データなし',
    chatTemperature: 'データなし',
    diffFromPrevious: 'データなし',
    benchmark: 'データなし',
    dmActionLists: 'データなし',
  };

  try {
    // ── セッション一覧取得（基本データソース） ──
    const { data: sessions } = await sb.rpc('get_coin_sessions', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_limit: 10,
    });

    if (!sessions || sessions.length === 0) return result;

    const latest = sessions[0];
    const totalTokens = latest.total_tokens || 0;
    const sessionStartISO = latest.session_start as string;
    const sessionEndISO = latest.session_end as string;

    // ================================================================
    // 軸1: チッパー構造（全チッパー + coin_transactions全履歴で新規判定）
    // ================================================================

    // セッション内の全取引を1回で取得（user_name, tokens, type）
    const { data: allTxRows } = await sb
      .from('coin_transactions')
      .select('user_name, tokens, type')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gte('date', sessionStartISO)
      .lte('date', sessionEndISO)
      .gt('tokens', 0);

    // チッパー別集計 + チップ種類別集計を同時に行う
    const tipperMap = new Map<string, { total: number; count: number }>();
    const typeMap = new Map<string, { tokens: number; count: number }>();
    let anonymousTokens = 0;
    let anonymousCount = 0;

    for (const row of allTxRows || []) {
      // チップ種類別集計
      const txType = (row.type || 'unknown').toLowerCase();
      const typeEntry = typeMap.get(txType) || { tokens: 0, count: 0 };
      typeEntry.tokens += row.tokens;
      typeEntry.count++;
      typeMap.set(txType, typeEntry);

      // チッパー別集計
      const name = row.user_name || '';
      if (!name || name === 'anonymous') {
        anonymousTokens += row.tokens;
        anonymousCount++;
        continue;
      }
      const existing = tipperMap.get(name) || { total: 0, count: 0 };
      existing.total += row.tokens;
      existing.count++;
      tipperMap.set(name, existing);
    }

    // ソートしてランキング作成
    const allTippers = Array.from(tipperMap.entries())
      .map(([name, data]) => ({ username: name, total: data.total, count: data.count }))
      .sort((a, b) => b.total - a.total);

    const uniqueTipperCount = allTippers.length;
    const top3Tokens = allTippers.slice(0, 3).reduce((s, u) => s + u.total, 0);
    const concentration = totalTokens > 0 ? ((top3Tokens / totalTokens) * 100).toFixed(1) : '0';
    const allTipperNames = allTippers.map(t => t.username);

    // ── 新規判定: coin_transactions全履歴ベース（paid_usersは使わない） ──
    // このキャストのcoin_transactionsにセッション開始前のレコードが1件もない = 新規
    //
    // 重要: 全履歴クエリは数千行超になりSupabaseの1000行制限で切り捨てられる。
    // → ユーザー単位で並列クエリ（各ユーザー: 存在チェック + 初回日 + 最終日 + 件数）
    interface TipperHistory {
      username: string;
      historyTxCount: number;
      historyTokens: number;
      firstTipDate: string;
      lastTipDate: string;   // 復帰ユーザー判定用
    }

    let trueNewTippers: string[] = [];
    let returningTippers: TipperHistory[] = [];

    if (allTipperNames.length > 0) {
      // 全チッパーの履歴を並列取得（各ユーザー3クエリ: 最古日/最新日/件数+累計tk）
      const historyMap = new Map<string, TipperHistory>();

      const historyChecks = allTipperNames.map(async (name) => {
        // 存在チェック兼最古のチップ日（セッション開始前のみ）
        const { data: oldest } = await sb
          .from('coin_transactions')
          .select('date')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .eq('user_name', name)
          .lt('date', sessionStartISO)
          .gt('tokens', 0)
          .order('date', { ascending: true })
          .limit(1);

        if (!oldest || oldest.length === 0) return; // 新規

        // 最新のチップ日（セッション開始前で最も新しい）
        const { data: newest } = await sb
          .from('coin_transactions')
          .select('date')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .eq('user_name', name)
          .lt('date', sessionStartISO)
          .gt('tokens', 0)
          .order('date', { ascending: false })
          .limit(1);

        // 件数
        const { count } = await sb
          .from('coin_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .eq('user_name', name)
          .gt('tokens', 0);

        // 累計tk（limit明示で1000行制限回避）
        const { data: tkRows } = await sb
          .from('coin_transactions')
          .select('tokens')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .eq('user_name', name)
          .gt('tokens', 0)
          .limit(10000);
        const totalTk = (tkRows || []).reduce((s, r) => s + (r.tokens || 0), 0);

        historyMap.set(name, {
          username: name,
          historyTxCount: count || 0,
          historyTokens: totalTk,
          firstTipDate: oldest[0].date as string,
          lastTipDate: (newest?.[0]?.date as string) || oldest[0].date as string,
        });
      });
      await Promise.all(historyChecks);

      trueNewTippers = allTipperNames.filter(n => !historyMap.has(n));
      returningTippers = allTipperNames
        .filter(n => historyMap.has(n))
        .map(n => historyMap.get(n)!);
    }

    // ── ユーザー分類リスト構築 ──
    const newTipperSet = new Set(trueNewTippers);
    const sessionStartMs = new Date(sessionStartISO).getTime();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    // a. 新規チッパー全員リスト（tk降順）
    const newTippersSorted = allTippers
      .filter(t => newTipperSet.has(t.username))
      .sort((a, b) => b.total - a.total);
    const newTipperTotalTk = newTippersSorted.reduce((s, t) => s + t.total, 0);
    const newTipperLines = newTippersSorted
      .map(t => `- ${t.username}: ${t.total}tk (${t.count}回) ← 初チップ`);

    // b. 高額新規（150tk以上の初チッパー）
    const highValueNewTippers = newTippersSorted.filter(t => t.total >= 150);

    // c. リピーター全員リスト（tk降順、履歴情報付き）
    const returningMap = new Map(returningTippers.map(r => [r.username, r]));
    const returningTippersSorted = allTippers
      .filter(t => !newTipperSet.has(t.username))
      .sort((a, b) => b.total - a.total);
    const returningLines = returningTippersSorted.map((u, i) => {
      const hist = returningMap.get(u.username);
      const tag = hist?.firstTipDate
        ? `[初回${hist.firstTipDate.slice(0, 10)}, 累計${hist.historyTokens}tk/${hist.historyTxCount}回]`
        : '';
      return `${i + 1}. ${u.username}: ${u.total}tk (${u.count}回) ${tag}`;
    });

    // d. 復帰ユーザー（前回チップから30日以上空いて戻ってきた人）
    const comebackUsers = returningTippers
      .filter(r => {
        const lastTipMs = new Date(r.lastTipDate).getTime();
        return (sessionStartMs - lastTipMs) >= THIRTY_DAYS_MS;
      })
      .map(r => {
        const sessionTk = tipperMap.get(r.username)?.total || 0;
        const daysSince = Math.floor((sessionStartMs - new Date(r.lastTipDate).getTime()) / (24 * 60 * 60 * 1000));
        return { username: r.username, lastTipDate: r.lastTipDate.slice(0, 10), daysSince, sessionTk };
      })
      .sort((a, b) => b.daysSince - a.daysSince);

    // ── DM用コピペセクション（ユーザー名のみ改行区切り） ──
    const dmCopyNew = newTippersSorted.map(t => t.username).join('\n');
    const dmCopyHighNew = highValueNewTippers.map(t => t.username).join('\n');
    const dmCopyComeback = comebackUsers.map(u => u.username).join('\n');
    const dmCopyReturning = returningTippersSorted.map(t => t.username).join('\n');

    result.tipperStructure = `[事実] 合計: ${totalTokens}tk / ${latest.tx_count}件 / ${latest.duration_minutes}分
[事実] ユニークチッパー: ${uniqueTipperCount}人（匿名: ${anonymousCount}件/${anonymousTokens}tk）
[事実] Top3集中度: ${concentration}%
[判定根拠] 新規判定=coin_transactions全履歴でセッション開始前にこのキャストへのチップが0件の人

## 新規チッパー（${trueNewTippers.length}人 / ${newTipperTotalTk}tk）
${newTipperLines.length > 0 ? newTipperLines.join('\n') : '(なし)'}

## 高額新規（150tk以上: ${highValueNewTippers.length}人）
${highValueNewTippers.length > 0 ? highValueNewTippers.map(t => `- ${t.username}: ${t.total}tk (${t.count}回)`).join('\n') : '(なし)'}

## リピーター（${returningTippers.length}人）
${returningLines.length > 0 ? returningLines.join('\n') : '(なし)'}

## 復帰ユーザー（30日以上ぶり: ${comebackUsers.length}人）
${comebackUsers.length > 0 ? comebackUsers.map(u => `- ${u.username}: ${u.daysSince}日ぶり（最終${u.lastTipDate}）→ 今回${u.sessionTk}tk`).join('\n') : '(なし)'}

## DM用ユーザー名リスト（コピペ用）

### 新規チッパー（${trueNewTippers.length}人）
\`\`\`
${dmCopyNew || '(なし)'}
\`\`\`

### 高額新規 150tk+（${highValueNewTippers.length}人）
\`\`\`
${dmCopyHighNew || '(なし)'}
\`\`\`

### 復帰ユーザー（${comebackUsers.length}人）
\`\`\`
${dmCopyComeback || '(なし)'}
\`\`\`

### リピーター（${returningTippers.length}人）
\`\`\`
${dmCopyReturning || '(なし)'}
\`\`\``;

    // ================================================================
    // 軸2: チップトリガー（時間帯分析 + チップ種類別構成）
    // ================================================================
    const sessionStart = new Date(sessionStartISO);
    const hour = sessionStart.getUTCHours() + 9;
    const jstHour = hour >= 24 ? hour - 24 : hour;
    const speed = latest.duration_minutes > 0 ? (totalTokens / latest.duration_minutes).toFixed(1) : '0';

    const typeBreakdown = Array.from(typeMap.entries())
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([type, data]) => {
        const pct = totalTokens > 0 ? ((data.tokens / totalTokens) * 100).toFixed(1) : '0';
        return `${type}: ${data.tokens}tk (${pct}%, ${data.count}件)`;
      })
      .join('\n');

    result.tipTriggers = `[事実] 配信時間帯: ${jstHour}時台
[事実] 配信時間: ${latest.duration_minutes}分
[事実] チップ速度: ${speed} tk/分
[事実] 取引密度: ${(latest.tx_count / Math.max(latest.duration_minutes, 1) * 60).toFixed(1)}件/時

--- チップ種類別構成 ---
${typeBreakdown}`;

    // ================================================================
    // 軸3: チャット温度（spy_messages優先、chat_logsフォールバック）
    // ================================================================

    // spy_messages を優先（msg_type付きで豊富なデータ）
    const { data: spyRows } = await sb
      .from('spy_messages')
      .select('user_name, message_time, msg_type, message, tokens')
      .eq('cast_name', castName)
      .gte('message_time', sessionStartISO)
      .lte('message_time', sessionEndISO);

    const hasSpyData = (spyRows?.length || 0) > 0;

    let chatCount = 0;
    let uniqueChatters = 0;
    let chatOnlyCount = 0;
    let goalEvents: Array<{ time: string; user: string; message: string }> = [];
    let chatDataSource = '';
    let topChatters: Array<{ username: string; msgCount: number; tipped: boolean }> = [];

    if (hasSpyData) {
      chatDataSource = 'spy_messages';
      const chatMessages = spyRows!.filter(r => r.msg_type === 'chat');
      chatCount = chatMessages.length;

      // ユーザー別メッセージ数
      const chatterMap = new Map<string, number>();
      for (const row of chatMessages) {
        const name = row.user_name || '';
        if (!name) continue;
        chatterMap.set(name, (chatterMap.get(name) || 0) + 1);
      }
      uniqueChatters = chatterMap.size;

      const tipperNameSet = new Set(allTipperNames);
      chatOnlyCount = Array.from(chatterMap.keys()).filter(n => !tipperNameSet.has(n)).length;

      // Top10チャッター
      topChatters = Array.from(chatterMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({
          username: name,
          msgCount: count,
          tipped: tipperNameSet.has(name),
        }));

      // goalイベント
      goalEvents = spyRows!
        .filter(r => r.msg_type === 'goal')
        .map(r => ({ time: (r.message_time as string).slice(11, 16), user: r.user_name || '', message: r.message || '' }));
    } else {
      // chat_logsフォールバック
      chatDataSource = 'chat_logs';
      const { data: chatRows } = await sb
        .from('chat_logs')
        .select('username, timestamp')
        .eq('cast_name', castName)
        .gte('timestamp', sessionStartISO)
        .lte('timestamp', sessionEndISO);

      chatCount = chatRows?.length || 0;
      const chatterMap = new Map<string, number>();
      for (const row of chatRows || []) {
        const name = row.username || '';
        if (!name) continue;
        chatterMap.set(name, (chatterMap.get(name) || 0) + 1);
      }
      uniqueChatters = chatterMap.size;
      const tipperNameSet = new Set(allTipperNames);
      chatOnlyCount = Array.from(chatterMap.keys()).filter(n => !tipperNameSet.has(n)).length;

      topChatters = Array.from(chatterMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, count]) => ({
          username: name,
          msgCount: count,
          tipped: tipperNameSet.has(name),
        }));
    }

    const chatSpeed = latest.duration_minutes > 0 ? (chatCount / latest.duration_minutes).toFixed(1) : '0';
    const interactionRate = latest.tx_count / Math.max(latest.duration_minutes, 1);
    const tempLabel = interactionRate > 1 ? '高温（活発）' : interactionRate > 0.3 ? '中温（普通）' : '低温（静か）';

    const chatterLines = topChatters.map((c, i) =>
      `${i + 1}. ${c.username}: ${c.msgCount}msg ${c.tipped ? '(チッパー)' : '(未課金)'}`
    ).join('\n');

    const goalText = goalEvents.length > 0
      ? `\n\n--- ゴールイベント (${goalEvents.length}件) ---\n${goalEvents.map(g => `${g.time} ${g.user}: ${g.message}`).join('\n')}`
      : '';

    const noDataWarning = chatCount === 0
      ? '\n[注意] このセッションのチャットデータなし（spy collector停止の可能性）'
      : '';

    result.chatTemperature = `[事実] チャット温度: ${tempLabel}
[事実] データソース: ${chatDataSource}
[事実] チャットメッセージ数: ${chatCount}件 (${chatSpeed}msg/分)
[事実] ユニークチャット参加者: ${uniqueChatters}人
[事実] チップインタラクション密度: ${interactionRate.toFixed(2)}回/分
[事実] チャットのみ（未課金）ユーザー: ${chatOnlyCount}人${chatOnlyCount > 0 ? ' → DM施策ターゲット候補' : ''}${noDataWarning}

--- チャット活発ユーザーTop10 ---
${chatterLines || '(データなし)'}${goalText}`;

    // ================================================================
    // 軸4: 前回との差分 + フィードバックループ
    // ================================================================
    if (sessions.length >= 2) {
      const prev = sessions[1];
      const prevTotal = prev.total_tokens || 0;
      const diff = totalTokens - prevTotal;
      const diffPct = prevTotal > 0 ? ((diff / prevTotal) * 100).toFixed(1) : 'N/A';

      // 前回セッションの全チッパーとの比較
      const { data: prevTipperRows } = await sb
        .from('coin_transactions')
        .select('user_name')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .gte('date', prev.session_start as string)
        .lte('date', prev.session_end as string)
        .gt('tokens', 0)
        .not('user_name', 'is', null)
        .neq('user_name', 'anonymous');

      const prevAllNames = new Set((prevTipperRows || []).map(r => r.user_name).filter(Boolean));
      const currentAllNames = new Set(allTipperNames);
      const returningFromPrev = Array.from(currentAllNames).filter(n => prevAllNames.has(n));
      const newFromPrev = Array.from(currentAllNames).filter(n => !prevAllNames.has(n));
      const lostFromPrev = Array.from(prevAllNames).filter(n => !currentAllNames.has(n as string));

      let diffText = `[事実] 前回比: ${diff >= 0 ? '+' : ''}${diff}tk (${diffPct}%)
[事実] 前回: ${prevTotal}tk / ${prev.duration_minutes}分 / ${prev.tx_count}件
[事実] 継続チッパー: ${returningFromPrev.length}人
[事実] 前回→今回の新規: ${newFromPrev.length}人${newFromPrev.length > 0 ? ` (${newFromPrev.slice(0, 5).join(', ')}${newFromPrev.length > 5 ? '...' : ''})` : ''}
[事実] 前回→今回の離脱: ${lostFromPrev.length}人${lostFromPrev.length > 0 ? ` (${(lostFromPrev as string[]).slice(0, 5).join(', ')}${lostFromPrev.length > 5 ? '...' : ''})` : ''}`;

      // 前回レポートのnext_actionsを取得して突合
      try {
        const { data: prevReportRow } = await sb
          .from('cast_knowledge')
          .select('metrics_json')
          .eq('account_id', accountId)
          .eq('report_type', 'session_report')
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (prevReportRow?.metrics_json) {
          const reportMd = (prevReportRow.metrics_json as Record<string, unknown>).report_markdown as string || '';
          if (reportMd) {
            const actionMatch = reportMd.match(/##\s*📋\s*次回配信アクションプラン[\s\S]*$/i)
              || reportMd.match(/##\s*次回.*アクション[\s\S]*$/i);
            if (actionMatch) {
              const actionText = actionMatch[0].slice(0, 500);
              diffText += `\n\n--- 前回レポートの次回アクションプラン ---
${actionText}
→ 上記の提案が今回の数字にどう影響したか分析すること`;
            }
          }
        }
      } catch { /* 前回レポートがない場合は無視 */ }

      result.diffFromPrevious = diffText;
    }

    // ================================================================
    // 軸5: ベンチマーク（過去5セッション平均）
    // ================================================================
    if (sessions.length >= 2) {
      const allTokens = sessions.map((s: { total_tokens: number }) => s.total_tokens);
      const allDurations = sessions.map((s: { duration_minutes: number }) => s.duration_minutes);
      const avgTokens = Math.round(allTokens.reduce((a: number, b: number) => a + b, 0) / allTokens.length);
      const avgDuration = Math.round(allDurations.reduce((a: number, b: number) => a + b, 0) / allDurations.length);
      const latestVsAvg = avgTokens > 0 ? (((totalTokens - avgTokens) / avgTokens) * 100).toFixed(1) : 'N/A';

      result.benchmark = `[事実] 過去${sessions.length}回平均: ${avgTokens}tk / ${avgDuration}分
[事実] 今回 vs 平均: ${latestVsAvg}%
[事実] 最高: ${Math.max(...allTokens)}tk
[事実] 最低: ${Math.min(...allTokens)}tk`;
    }

    // ================================================================
    // グループD: DM施策直結データ
    // #11 離脱予兆ユーザーリスト
    // #12 初回課金後2回目来訪率
    // #13 復帰ユーザーの復帰きっかけ
    // ================================================================
    try {
      // 全セッションのチッパーマップを構築（セッション単位で誰がいたか）
      const sessionTipperMaps: Array<{ sessionIdx: number; start: string; end: string; tippers: Set<string> }> = [];

      // 最新セッション(index 0)は既にallTipperNamesで取得済み
      sessionTipperMaps.push({
        sessionIdx: 0,
        start: sessionStartISO,
        end: sessionEndISO,
        tippers: new Set(allTipperNames),
      });

      // 過去セッション(index 1〜)のチッパーを並列取得
      const pastSessionFetches = sessions.slice(1).map(async (s: { session_start: string; session_end: string }, idx: number) => {
        const { data: rows } = await sb
          .from('coin_transactions')
          .select('user_name')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .gte('date', s.session_start)
          .lte('date', s.session_end)
          .gt('tokens', 0)
          .not('user_name', 'is', null)
          .neq('user_name', 'anonymous');
        const names = new Set((rows || []).map((r: { user_name: string }) => r.user_name).filter(Boolean));
        return { sessionIdx: idx + 1, start: s.session_start, end: s.session_end, tippers: names };
      });
      const pastMaps = await Promise.all(pastSessionFetches);
      sessionTipperMaps.push(...pastMaps);
      sessionTipperMaps.sort((a, b) => a.sessionIdx - b.sessionIdx);

      const dmParts: string[] = [];

      // ── #11 離脱予兆ユーザーリスト ──
      // 直近5セッション中3回以上来たが、最新2セッションに不在
      if (sessionTipperMaps.length >= 3) {
        const recentN = Math.min(sessionTipperMaps.length, 5);
        const recentMaps = sessionTipperMaps.slice(0, recentN);
        const last2 = new Set<string>();
        Array.from(recentMaps[0].tippers).forEach(n => last2.add(n));
        if (recentMaps[1]) Array.from(recentMaps[1].tippers).forEach(n => last2.add(n));

        // 全ユニークユーザーの出現回数
        const attendanceCount = new Map<string, number>();
        for (const sm of recentMaps) {
          for (const name of Array.from(sm.tippers)) {
            attendanceCount.set(name, (attendanceCount.get(name) || 0) + 1);
          }
        }

        // 3回以上出現 かつ 最新2セッション不在
        const churnRisk: Array<{ username: string; sessions: number; cumulativeTk: number; lastSeenIdx: number }> = [];
        for (const [name, count] of attendanceCount.entries()) {
          if (count >= 3 && !last2.has(name)) {
            // 最後に見たセッション（index小さい=新しい）
            let lastSeenIdx = recentN;
            for (let i = 0; i < recentMaps.length; i++) {
              if (recentMaps[i].tippers.has(name)) { lastSeenIdx = i; break; }
            }
            // 累計tk取得（returningTippersから）
            const hist = returningTippers.find(r => r.username === name);
            churnRisk.push({
              username: name,
              sessions: count,
              cumulativeTk: hist?.historyTokens || 0,
              lastSeenIdx,
            });
          }
        }
        churnRisk.sort((a, b) => b.cumulativeTk - a.cumulativeTk);

        const churnLines = churnRisk.map(u =>
          `- ${u.username}: ${u.sessions}/${recentN}回参加, 累計${u.cumulativeTk}tk, 最終=${u.lastSeenIdx}セッション前`
        );
        const churnDmCopy = churnRisk.map(u => u.username).join('\n');

        dmParts.push(`## #11 離脱予兆ユーザー（直近${recentN}セッション中3回以上来訪→最新2回不在: ${churnRisk.length}人）
[判定根拠] 直近${recentN}セッションで3回以上チップしたが、最新2セッションに不在のユーザー
${churnLines.length > 0 ? churnLines.join('\n') : '(該当なし)'}

### DM用（離脱予兆）
\`\`\`
${churnDmCopy || '(なし)'}
\`\`\``);
      }

      // ── #12 初回課金後2回目来訪率 ──
      // 各セッションの新規チッパーが次セッションに戻ったか
      if (sessionTipperMaps.length >= 2) {
        const returnRateLines: string[] = [];
        const allNonReturners: Array<{ username: string; sessionDate: string; tk: number }> = [];

        // セッションN（古い方）の新規 → セッションN-1（新しい方）に来たか
        for (let i = sessionTipperMaps.length - 1; i >= 1; i--) {
          const olderSession = sessionTipperMaps[i];
          const newerSession = sessionTipperMaps[i - 1];

          // このセッションの新規=それより前のセッションに一度も出てない人
          const priorTippers = new Set<string>();
          for (let j = i + 1; j < sessionTipperMaps.length; j++) {
            Array.from(sessionTipperMaps[j].tippers).forEach(n => priorTippers.add(n));
          }
          // さらにcoin_transactions全履歴で判定（セッション開始前にチップ有無）
          const sessionNewTippers: string[] = [];
          for (const name of Array.from(olderSession.tippers)) {
            if (!priorTippers.has(name)) {
              // 念のためこのセッション開始前に過去チップがあるか確認
              const hist = returningTippers.find(r => r.username === name);
              if (!hist) sessionNewTippers.push(name);
            }
          }

          if (sessionNewTippers.length === 0) continue;

          const returnedCount = sessionNewTippers.filter(n => newerSession.tippers.has(n)).length;
          const rate = ((returnedCount / sessionNewTippers.length) * 100).toFixed(0);
          const sessionDate = olderSession.start.slice(0, 10);
          returnRateLines.push(`- ${sessionDate}: 新規${sessionNewTippers.length}人 → 次回来訪${returnedCount}人 (${rate}%)`);

          // 戻ってこなかった人をDMリストに
          for (const name of sessionNewTippers) {
            if (!newerSession.tippers.has(name)) {
              const tipData = tipperMap.get(name);
              allNonReturners.push({ username: name, sessionDate, tk: tipData?.total || 0 });
            }
          }
        }

        const nonReturnerDmCopy = allNonReturners.map(u => u.username).join('\n');

        dmParts.push(`## #12 初回課金後2回目来訪率
[事実] セッション別の新規→次回来訪率:
${returnRateLines.length > 0 ? returnRateLines.join('\n') : '(データ不足: 2セッション以上の新規追跡が必要)'}

### 2回目来訪なしユーザー（${allNonReturners.length}人）— DM施策ターゲット
${allNonReturners.length > 0 ? allNonReturners.map(u => `- ${u.username}: ${u.sessionDate}に${u.tk}tk → 次回不在`).join('\n') : '(なし)'}

### DM用（初回課金→未再訪）
\`\`\`
${nonReturnerDmCopy || '(なし)'}
\`\`\``);
      }

      // ── #13 復帰ユーザーの復帰きっかけ ──
      // 30日以上ぶりの復帰ユーザーが、今回何で戻ったか（取引タイプ分析）
      if (comebackUsers.length > 0) {
        // 復帰ユーザーの今回セッション内取引タイプを取得
        const comebackNames = comebackUsers.map(u => u.username);
        const comebackTxDetails: Array<{
          username: string; daysSince: number; types: Array<{ type: string; tokens: number; count: number }>;
          firstTxType: string;
        }> = [];

        for (const cu of comebackUsers) {
          // このユーザーのセッション内取引を抽出（allTxRowsから）
          const userTxs = (allTxRows || []).filter(
            (r: { user_name: string }) => r.user_name === cu.username
          );
          const txTypeMap = new Map<string, { tokens: number; count: number }>();
          for (const tx of userTxs) {
            const t = ((tx as { type: string }).type || 'unknown').toLowerCase();
            const entry = txTypeMap.get(t) || { tokens: 0, count: 0 };
            entry.tokens += (tx as { tokens: number }).tokens;
            entry.count++;
            txTypeMap.set(t, entry);
          }
          const types = Array.from(txTypeMap.entries())
            .map(([type, data]) => ({ type, tokens: data.tokens, count: data.count }))
            .sort((a, b) => b.tokens - a.tokens);

          // 最初の取引タイプ（復帰のきっかけ）
          const firstTxType = types.length > 0 ? types[0].type : 'unknown';

          comebackTxDetails.push({
            username: cu.username,
            daysSince: cu.daysSince,
            types,
            firstTxType,
          });
        }

        // きっかけ別集計
        const triggerSummary = new Map<string, number>();
        for (const d of comebackTxDetails) {
          triggerSummary.set(d.firstTxType, (triggerSummary.get(d.firstTxType) || 0) + 1);
        }
        const triggerLines = Array.from(triggerSummary.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${type}: ${count}人`);

        const comebackDetailLines = comebackTxDetails.map(d => {
          const typeStr = d.types.map(t => `${t.type}(${t.tokens}tk/${t.count}回)`).join(', ');
          return `- ${d.username}: ${d.daysSince}日ぶり → ${typeStr}`;
        });

        dmParts.push(`## #13 復帰ユーザーの復帰きっかけ（30日以上ぶり: ${comebackUsers.length}人）
[事実] 復帰きっかけ取引タイプ: ${triggerLines.join(', ')}

${comebackDetailLines.join('\n')}

[判定根拠] 最も金額が大きい取引タイプを「きっかけ」として判定（tip=投げ銭、ticketshow=チケット購入、photo=写真購入）`);
      }

      if (dmParts.length > 0) {
        result.dmActionLists = dmParts.join('\n\n');
      }
    } catch (groupDErr) {
      console.error('[5-Axis GroupD] Error:', groupDErr);
      result.dmActionLists = '[注意] グループDデータ収集でエラー発生';
    }

    return result;
  } catch (err) {
    console.error('[5-Axis] Error collecting data:', err);
    return result;
  }
}

// ============================================================
// Layer A 選択
// ============================================================
function selectLayerA(taskType: EngineTaskType, personaBase: string | null): string {
  if (taskType === 'recruitment') return LAYER_A_PRINCESS_MARKETING;
  return personaBase || LAYER_A_ANDO_FOUNDATION;
}

// ============================================================
// POST /api/persona/engine
// ============================================================
export async function POST(req: NextRequest) {
  const body = await req.json() as EngineRequest;
  const { task_type, cast_name, account_id: reqAccountId, context } = body;

  // バリデーション
  if (!task_type || !cast_name) {
    return NextResponse.json({ error: 'task_type と cast_name は必須です' }, { status: 400 });
  }
  if (!ENGINE_LAYER_C[task_type] && task_type !== 'fb_report') {
    return NextResponse.json(
      { error: `未対応のtask_type: ${task_type}。対応: dm, x_post, recruitment, content, fb_report` },
      { status: 400 },
    );
  }

  // 認証（APIキーチェックより先）
  const auth = await authenticateAndValidateAccount(req, reqAccountId || null);
  if (!auth.authenticated) return auth.error;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY が設定されていません' },
      { status: 503 },
    );
  }

  try {
    const sb = getAuthClient(auth.token);

    // ── ペルソナ取得 ──
    let personaQuery = sb
      .from('cast_personas')
      .select('*')
      .eq('cast_name', cast_name);
    if (reqAccountId) personaQuery = personaQuery.eq('account_id', reqAccountId);
    const { data: persona } = await personaQuery.single();

    const activePersona: CastPersona = persona
      ? (persona as CastPersona)
      : { ...DEFAULT_PERSONA, cast_name };

    // ── cast_persona 詳細 ──
    const detail = await fetchCastPersonaDetail(auth.token, cast_name, reqAccountId);

    // ── 過去の高評価データ取得 ──
    const topFeedback = await fetchTopFeedback(auth.token, cast_name, task_type);
    const feedbackContext = buildFeedbackContext(topFeedback);

    // ── RAG Context: cast_knowledge から配信分析ナレッジを取得 ──
    const ragContext = await buildCastRAGContext(cast_name, task_type, sb);
    const ragBlock = ragContext.summary
      ? `\n=== キャスト分析ナレッジ（直近の配信データに基づく） ===\n${ragContext.summary}\n`
      : '';

    // ── fb_report: 5軸データ収集 + agent_profiles から動的 Layer C ──
    let fiveAxisData: FiveAxisData | undefined;
    let dynamicLayerC = '';
    if (task_type === 'fb_report') {
      const effectiveAccountId = reqAccountId || (auth.accountIds?.[0]) || '';
      fiveAxisData = await collect5AxisData(auth.token, cast_name, effectiveAccountId, context);
      // デバッグ: LLMに渡す前の5軸データを確認
      console.log('[fb_report] 5-Axis tipperStructure:', fiveAxisData.tipperStructure?.slice(0, 500));
      console.log('[fb_report] 5-Axis chatTemperature:', fiveAxisData.chatTemperature?.slice(0, 200));
      const agents = await fetchAgentProfiles(auth.token);
      dynamicLayerC = agents.length > 0
        ? buildFbReportLayerC(agents)
        : '配信FBレポートを生成してください。Markdown形式で出力。';
    }

    // ── Layer A 選択 ──
    const layerA = selectLayerA(task_type, activePersona.system_prompt_base);

    // ── Layer B: タスク別分岐 ──
    const layerB = task_type === 'recruitment'
      ? `=== あなたの役割 ===\nライブ配信エージェンシーの採用マーケター。\n温かく、共感的で、押しつけがましくない。\n「この人なら相談できそう」と思わせるトーン。`
      : task_type === 'fb_report'
      ? `=== あなたの役割 ===\nライブ配信の配信FBレポートを生成する4人のエージェントチーム。\nキャスト「${activePersona.display_name || cast_name}」の配信データを分析し、具体的な改善策を提案する。`
      : buildLayerB(activePersona, detail);

    // ── System Prompt 組み立て: Layer A + B + RAG + Feedback + Context + C ──
    const layerC = task_type === 'fb_report' ? dynamicLayerC : ENGINE_LAYER_C[task_type];
    const systemPrompt = [
      layerA,
      '',
      layerB,
      '',
      ragBlock,
      feedbackContext,
      activePersona.system_prompt_context
        ? `=== 直近コンテキスト ===\n${activePersona.system_prompt_context}`
        : '',
      '',
      layerC,
    ].filter(Boolean).join('\n');

    // ── User Prompt（fb_report は5軸データをcontextに注入） ──
    const effectiveContext = task_type === 'fb_report'
      ? { ...context, five_axis: fiveAxisData, cast_name }
      : context || {};
    const userPrompt = buildUserPrompt(task_type, effectiveContext);

    // ── API 呼び出し（fb_report は長い出力が必要） ──
    const maxTokens = task_type === 'dm' ? 500 : task_type === 'fb_report' ? 4000 : 1000;
    const result = await callClaude(systemPrompt, userPrompt, maxTokens);

    // ── レスポンス処理（fb_report はMarkdown、それ以外はJSON） ──
    if (task_type === 'fb_report') {
      return NextResponse.json({
        output: result.text,
        output_format: 'markdown',
        confidence: 0.85,
        cost_tokens: result.tokensUsed,
        cost_usd: result.costUsd,
        model: 'claude-sonnet-4-20250514',
        task_type,
        cast_name,
        persona_used: activePersona.display_name || activePersona.cast_name,
        persona_found: !!persona,
        feedback_examples_used: topFeedback.length,
        rag_data_points: ragContext.dataPoints,
        rag_last_updated: ragContext.lastUpdated || null,
        five_axis_collected: !!fiveAxisData,
        agents_used: 4,
      });
    }

    // ── レスポンスパース（JSON系タスク） ──
    let parsed: Record<string, unknown> | null = null;
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch { /* ignore */ }

    // ── confidence 算出 ──
    const requiredFields: Record<string, string[]> = {
      dm: ['message', 'reasoning'],
      x_post: ['post_text', 'mode'],
      recruitment: ['copy', 'step_breakdown'],
      content: ['content', 'content_type'],
    };
    const fields = requiredFields[task_type] || [];
    const present = parsed ? fields.filter(f => f in parsed).length : 0;
    const confidence = parsed
      ? Math.round((0.4 + 0.6 * (present / Math.max(fields.length, 1))) * 100) / 100
      : 0.3;

    return NextResponse.json({
      output: parsed || result.text,
      reasoning: parsed && 'reasoning' in parsed ? parsed.reasoning : null,
      confidence,
      cost_tokens: result.tokensUsed,
      cost_usd: result.costUsd,
      model: 'claude-sonnet-4-20250514',
      task_type,
      cast_name,
      persona_used: activePersona.display_name || activePersona.cast_name,
      persona_found: !!persona,
      feedback_examples_used: topFeedback.length,
      rag_data_points: ragContext.dataPoints,
      rag_last_updated: ragContext.lastUpdated || null,
      raw_text: result.text,
    });
  } catch (e: unknown) {
    const err = e as { message?: string; statusCode?: number };
    await reportError(e, { file: 'api/persona/engine', context: `統一エンジン (task=${task_type})` });
    return NextResponse.json(
      { error: err.message || '統一エンジンエラー' },
      { status: err.statusCode || 500 },
    );
  }
}
