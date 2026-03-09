import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';
import { LAYER_A_ANDO_FOUNDATION } from '@/lib/prompts/layer-a-ando';
import { LAYER_A_PRINCESS_MARKETING } from '@/lib/prompts/layer-a-princess';

// ============================================================
// 統一クリエイティブエンジン /api/persona/engine
// task_type: dm / x_post / recruitment / content
// 既存 /api/persona/route.ts の Layer A/B/C 構造を維持
// 過去の高評価データを persona_feedback から取得してコンテキストに含める
// ============================================================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

type EngineTaskType = 'dm' | 'x_post' | 'recruitment' | 'content';

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
const ENGINE_LAYER_C: Record<EngineTaskType, string> = {
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
  if (!ENGINE_LAYER_C[task_type]) {
    return NextResponse.json(
      { error: `未対応のtask_type: ${task_type}。対応: dm, x_post, recruitment, content` },
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

    // ── Layer A 選択 ──
    const layerA = selectLayerA(task_type, activePersona.system_prompt_base);

    // ── Layer B: recruitment はエージェンシーブランド、それ以外はキャスト人格 ──
    const layerB = task_type === 'recruitment'
      ? `=== あなたの役割 ===\nライブ配信エージェンシーの採用マーケター。\n温かく、共感的で、押しつけがましくない。\n「この人なら相談できそう」と思わせるトーン。`
      : buildLayerB(activePersona, detail);

    // ── System Prompt 組み立て: Layer A + B + Feedback + Context + C ──
    const systemPrompt = [
      layerA,
      '',
      layerB,
      '',
      feedbackContext,
      activePersona.system_prompt_context
        ? `=== 直近コンテキスト ===\n${activePersona.system_prompt_context}`
        : '',
      '',
      ENGINE_LAYER_C[task_type],
    ].filter(Boolean).join('\n');

    // ── User Prompt ──
    const userPrompt = buildUserPrompt(task_type, context || {});

    // ── API 呼び出し ──
    const maxTokens = task_type === 'dm' ? 500 : 1000;
    const result = await callClaude(systemPrompt, userPrompt, maxTokens);

    // ── レスポンスパース ──
    let parsed: Record<string, unknown> | null = null;
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch { /* ignore */ }

    // ── confidence 算出 ──
    const requiredFields: Record<EngineTaskType, string[]> = {
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
