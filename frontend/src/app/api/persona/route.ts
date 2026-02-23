import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// ============================================================
// Types
// ============================================================
type TaskType = 'dm_generate' | 'fb_report' | 'dm_evaluate' | 'realtime_coach' | 'recruitment_copy' | 'training_task';

interface CastPersona {
  id: string;
  account_id: string;
  cast_name: string;
  display_name: string | null;
  personality: string | null;
  speaking_style: string | null;
  emoji_style: string | null;
  taboo_topics: string | null;
  greeting_patterns: string[];
  dm_tone: string;
  byaf_style: string | null;
  system_prompt_base: string | null;
  system_prompt_cast: string | null;
  system_prompt_context: string | null;
  created_at: string;
  updated_at: string;
}

interface DmGenerateBody {
  cast_name: string;
  account_id: string;
  target_username: string;
  segment?: string;
  context?: string;
  template_type: 'thank' | 'follow' | 'pre_broadcast' | 'vip' | 'churn';
}

interface AiGenerateBody {
  task_type: TaskType;
  cast_name: string;
  context: Record<string, unknown>;
}

// ============================================================
// Supabase helper — 認証トークン付きクライアント
// ============================================================
function getAuthClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function verifyAuth(req: NextRequest): Promise<{ token: string } | NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const token = authHeader.slice(7);
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) {
    return NextResponse.json({ error: '認証トークンが無効です' }, { status: 401 });
  }
  return { token };
}

// ============================================================
// GET /api/persona?cast_name=xxx&account_id=yyy
// ペルソナ取得
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await verifyAuth(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const castName = searchParams.get('cast_name');
  const accountId = searchParams.get('account_id');

  if (!castName || !accountId) {
    return NextResponse.json({ error: 'cast_name と account_id は必須です' }, { status: 400 });
  }

  const sb = getAuthClient(auth.token);
  const { data, error } = await sb
    .from('cast_personas')
    .select('*')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .single();

  if (error && error.code !== 'PGRST116') {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ persona: data || null });
}

// ============================================================
// PUT /api/persona — ペルソナ更新（upsert）
// ============================================================
export async function PUT(req: NextRequest) {
  const auth = await verifyAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  const { account_id, cast_name, ...fields } = body;

  if (!account_id || !cast_name) {
    return NextResponse.json({ error: 'account_id と cast_name は必須です' }, { status: 400 });
  }

  const sb = getAuthClient(auth.token);
  const { data, error } = await sb
    .from('cast_personas')
    .upsert({
      account_id,
      cast_name,
      ...fields,
    }, { onConflict: 'account_id,cast_name' })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ persona: data });
}

// ============================================================
// Phase 1 テンプレートベースDM文面生成
// ============================================================
const DM_TEMPLATES: Record<string, string[]> = {
  thank: [
    '{user_name}さん💕 今日は来てくれてありがとう！すっごく嬉しかった！ {byaf}',
    '{user_name}さん！ チップありがとう😊 {user_name}さんがいると楽しい！ {byaf}',
    '{user_name}さん✨ 今日も会えて嬉しかった！ありがとうね！ {byaf}',
  ],
  follow: [
    '{user_name}さん、最近会えてないね😢 元気にしてる？ {byaf}',
    '{user_name}さん！ 久しぶり〜！また遊びに来てね😊 {byaf}',
  ],
  pre_broadcast: [
    '{user_name}さん！ 今日配信するよ〜！楽しみにしててね✨ {byaf}',
    '{user_name}さん💕 今日も配信するから遊びに来てね！ {byaf}',
  ],
  vip: [
    '{user_name}さん💎 いつも本当にありがとう！{user_name}さんのおかげで頑張れてるよ！ {byaf}',
    '{user_name}さん✨ いつも応援してくれて感謝してます！特別な存在だよ💕 {byaf}',
  ],
  churn: [
    '{user_name}さん、元気にしてる？最近見かけないから気になってたの😢 {byaf}',
    '{user_name}さん！ 久しぶり〜！たまには顔見せてね😊 {byaf}',
  ],
};

function generateDmFromTemplate(
  persona: CastPersona | null,
  templateType: string,
  targetUsername: string,
): { message: string; persona_used: string | null } {
  const templates = DM_TEMPLATES[templateType] || DM_TEMPLATES.thank;
  const idx = Math.floor(Math.random() * templates.length);
  let message = templates[idx];

  const byaf = persona?.byaf_style || 'もちろん無理しないでね！';
  const displayName = persona?.display_name || null;

  message = message.replace(/\{user_name\}/g, targetUsername);
  message = message.replace(/\{byaf\}/g, byaf);

  return { message, persona_used: displayName };
}

// ============================================================
// Layer A — 安藤式基盤 System Prompt（定数）
// ============================================================
const LAYER_A_ANDO_FOUNDATION = `あなたはライブ配信プラットフォームのファンマーケティング専門AIです。
以下の安藤式7原則・6技法・3ルートを必ず守ってください。

=== 7原則 ===
1. ファンは「作る」のではなく「生まれる環境」を設計する
2. 「気づかせる」＞「教える」
3. 事実が先、ストーリーは後
4. 1対1(DM)と1対多(SNS)は完全に別スキル
5. 姿勢＞テクニック
6. 本人の声は不可替
7. 地味な本質情報＞派手な煎り

=== コンテンツメイキング6技法 ===
1. BYAF法: 全DM末尾に「でもあなたの自由」要素を入れる。「もちろん無理しないでね」「気が向いたらでいいよ」等。BYAFがないDMは押し売り。
2. 言質取り: 小さなYESを積み重ねる
3. サンクコスト: 過去の投資を意識させて離脱を防ぐ
4. 部数限定: 希少性で即行動を促す
5. 行動の再定義: 「課金」→「応援」「特別な関係」に認知フレーム転換
6. 感情逆算設計: ゴールの感情から逆算してコンテンツを組む

=== 購買心理3ルート ===
1. 希望ルート: 「こうなりたい」未来像で動く
2. 気まずさルート: 社会的圧力・断りにくさで動く（S2-S3のCVR78.7%の正体）
3. 時間蓄積ルート: 3年かけて信頼が積み上がり購入に至る

=== 禁止語 ===
- ×「課金」「お金」「投げ銭」 → ○「応援」「気持ち」「サポート」
- ×「ファン」 → ○「○○さん」（名前呼び）`;

// ============================================================
// Layer B — キャスト人格定義（cast_personas テーブルから動的生成）
// ============================================================
function buildLayerB(persona: CastPersona): string {
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

  // L2: キャスト固有プロンプト
  if (persona.system_prompt_cast) {
    parts.push(`\n=== キャスト固有ルール ===\n${persona.system_prompt_cast}`);
  }

  parts.push(`\n↓ このキャラクターとして生成してください。「このキャストが書きそうな文章」になっていることが最も重要。`);

  return parts.join('\n');
}

// ============================================================
// Layer C — タスク固有ルール
// ============================================================
const LAYER_C_RULES: Record<TaskType, string> = {
  dm_generate: `=== DM生成ルール ===
- 120文字以内。絶対に超えない。
- ユーザー名を必ず1回入れる。
- 末尾にBYAF要素必須。「もちろん無理しないでね」「気が向いたらでいいよ」等。
- 2通連続同じトーン禁止。感情→事実→感情の交互。
- spy_messagesのハイライトがあれば触れて個別感を出す。
- 1メッセージ=1トピック。
- セグメント別トーン:
  S1-S3(VIP)=特別感を強調
  S4-S6(常連)=居場所感・安心感
  S7-S8(中堅)=軽い誘い
  S9-S10(ライト/単発)=軽く短く
- 必ず以下のJSON形式で出力:
{"message": "...", "reasoning": "..."}`,

  fb_report: `=== FBレポート生成ルール ===
- 構造化フォーマットで出力:
  1. 総合評価（S/A/B/C/D）
  2. 良かった点（3つ、数値根拠必須）
  3. 改善点（3つ、具体的なアクション付き）
  4. 次回アクション（優先度順に3つ）
- 数値根拠必須。「良かった」ではなく「チップ率30%増」。
- キャストのキャラで書く。
- JSON形式で出力:
{"evaluation": "A", "good_points": [...], "improvements": [...], "next_actions": [...], "summary": "..."}`,

  dm_evaluate: `=== DM評価ルール ===
- DM文面を評価してスコア0-100で採点。
- 評価軸: BYAF有無/キャラ一致度/文字数/個別感/セグメント適合度
- 改善案3つを具体的に提示。
- JSON形式で出力:
{"score": 85, "breakdown": {...}, "improvements": [...]}`,

  realtime_coach: `=== リアルタイムコーチルール ===
- 短文3行以内。即座に使える具体的アクション。
- 数字やユーザー名を必ず含める。
- JSON形式で出力:
{"action": "...", "reasoning": "...", "urgency": "high|medium|low"}`,

  recruitment_copy: `=== 採用コピー生成ルール ===
- Princess Marketing Realism 4Step準拠
- 主語は「あなた」。
- 禁止: 「チャットレディ」「アダルト」「風俗」「恐怖訴求」「簡単に稼げる」
- JSON形式で出力:
{"copy": "...", "step_breakdown": {...}}`,

  training_task: `=== 育成タスク生成ルール ===
- 具体的で3つ。測定可能。
- JSON形式で出力:
{"tasks": [{"task": "...", "success_criteria": "...", "deadline": "..."}]}`,
};

// ============================================================
// デフォルトペルソナ（テーブルに未登録の場合）
// ============================================================
const DEFAULT_PERSONA: CastPersona = {
  id: '',
  account_id: '',
  cast_name: 'default',
  display_name: null,
  personality: '聞き上手で優しい',
  speaking_style: '〜だよ！〜かな？',
  emoji_style: '適度に使用',
  taboo_topics: null,
  greeting_patterns: [],
  dm_tone: 'friendly',
  byaf_style: 'もちろん無理しないでね！',
  system_prompt_base: null,
  system_prompt_cast: null,
  system_prompt_context: null,
  created_at: '',
  updated_at: '',
};

// ============================================================
// セグメント判定
// ============================================================
function getSegmentLabel(totalCoins: number, lastSeen: string | null): string {
  const daysSince = lastSeen
    ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 86400000)
    : 999;
  if (totalCoins >= 5000) {
    if (daysSince <= 7) return 'S1:VIP現役';
    if (daysSince <= 90) return 'S2:VIP準現役';
    return 'S3:VIP休眠';
  }
  if (totalCoins >= 1000) {
    if (daysSince <= 7) return 'S4:常連現役';
    if (daysSince <= 90) return 'S5:常連離脱危機';
    return 'S6:常連休眠';
  }
  if (totalCoins >= 300) {
    if (daysSince <= 30) return 'S7:中堅現役';
    return 'S8:中堅休眠';
  }
  if (totalCoins >= 50) return 'S9:ライト';
  return 'S10:単発';
}

// ============================================================
// User Prompt ビルダー
// ============================================================
async function buildUserPrompt(
  taskType: TaskType,
  context: Record<string, unknown>,
  token: string,
): Promise<string> {
  const supabase = getAuthClient(token);

  switch (taskType) {
    case 'dm_generate': {
      const userName = context.user_name as string;
      const castName = context.cast_name as string;
      const scenarioType = context.scenario_type as string || 'thankyou_regular';
      const stepNumber = context.step_number as number || 1;

      const { data: spyMsgs } = await supabase
        .from('spy_messages')
        .select('message, message_time, msg_type, tokens')
        .eq('user_name', userName)
        .eq('cast_name', castName)
        .order('message_time', { ascending: false })
        .limit(10);

      const { data: coinTx } = await supabase
        .from('coin_transactions')
        .select('tokens, type, date')
        .eq('user_name', userName)
        .eq('cast_name', castName)
        .order('date', { ascending: false })
        .limit(20);

      const totalCoins = coinTx?.reduce((s, t) => s + (t.tokens || 0), 0) || 0;
      const avgCoins = coinTx && coinTx.length > 0 ? Math.round(totalCoins / coinTx.length) : 0;
      const lastTxDate = coinTx?.[0]?.date || '不明';

      const { data: paidUser } = await supabase
        .from('paid_users')
        .select('total_coins, last_seen')
        .eq('user_name', userName)
        .single();

      const segment = paidUser
        ? getSegmentLabel(paidUser.total_coins, paidUser.last_seen)
        : 'S10:単発';

      const { data: lastDms } = await supabase
        .from('dm_send_log')
        .select('message, sent_at, template_name')
        .eq('user_name', userName)
        .eq('cast_name', castName)
        .eq('status', 'success')
        .order('sent_at', { ascending: false })
        .limit(3);

      const spyLog = spyMsgs?.map(m =>
        `[${m.message_time?.slice(11, 16) || '??:??'}] ${m.msg_type}: ${m.message || ''} ${m.tokens ? `(${m.tokens}tk)` : ''}`
      ).join('\n') || 'なし';

      const lastDmLog = lastDms?.map(d =>
        `- ${d.message || '?'} (${d.sent_at?.slice(0, 10) || '?'}, ${d.template_name || ''})`
      ).join('\n') || 'なし';

      return `ユーザー名: ${userName}
セグメント: ${segment}
累計コイン: ${totalCoins}tk / 平均: ${avgCoins}tk / 最終: ${lastTxDate}
シナリオ: ${scenarioType} (Step ${stepNumber})

前回DM履歴（直近3件）:
${lastDmLog}

直近の発言ログ:
${spyLog}

上記の情報をもとに、このユーザーに最適なDMを生成してください。
- 前回DMと異なるトーンにしてください（感情→事実→感情の交互）。
- ユーザーの発言内容に触れて個別感を出してください。`;
    }

    case 'fb_report': {
      const sessionId = context.session_id as string;

      const { data: messages } = await supabase
        .from('spy_messages')
        .select('user_name, message, msg_type, tokens, message_time')
        .eq('session_id', sessionId)
        .order('message_time', { ascending: true });

      const msgs = messages || [];
      const uniqueUsers = new Set(msgs.map(m => m.user_name).filter(Boolean)).size;
      const tipMsgs = msgs.filter(m => (m.msg_type === 'tip' || m.msg_type === 'gift') && m.tokens && m.tokens > 0);
      const totalTokens = tipMsgs.reduce((s, m) => s + (m.tokens || 0), 0);

      const topTippers: Record<string, number> = {};
      for (const m of tipMsgs) {
        const name = m.user_name || '?';
        topTippers[name] = (topTippers[name] || 0) + (m.tokens || 0);
      }
      const tipRanking = Object.entries(topTippers)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, coins], i) => `${i + 1}. ${name}: ${coins}tk`)
        .join('\n');

      const chatMsgs = msgs.filter(m => m.msg_type === 'chat');
      const chatSample = [
        ...chatMsgs.slice(0, 20),
        ...(chatMsgs.length > 40 ? chatMsgs.slice(-20) : []),
      ].map(m =>
        `[${m.message_time?.slice(11, 16) || '??:??'}] ${m.user_name || '?'}: ${m.message || ''}`
      ).join('\n');

      return `配信データ:
メッセージ数: ${msgs.length}
チップ合計: ${totalTokens}tk
ユニーク発言者: ${uniqueUsers}名

チップランキング:
${tipRanking || 'なし'}

チャットサンプル:
${chatSample || 'なし'}

このデータをもとにFBレポートを生成してください。キャストのキャラクターに合った口調で書いてください。`;
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
// POST /api/persona
// mode=generate → Phase 1テンプレート文面生成
// mode=ai       → Phase 2 Claude API文面生成
// (後方互換) task_type指定 → Phase 2
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await verifyAuth(req);
  if (auth instanceof NextResponse) return auth;

  const body = await req.json();
  const mode = body.mode as string || (body.task_type ? 'ai' : 'generate');

  // ── Phase 1: テンプレートベースDM生成 ──
  if (mode === 'generate') {
    const { cast_name, account_id, target_username, template_type } = body as DmGenerateBody;
    if (!cast_name || !account_id || !target_username) {
      return NextResponse.json({ error: 'cast_name, account_id, target_username は必須です' }, { status: 400 });
    }

    const sb = getAuthClient(auth.token);
    const { data: persona } = await sb
      .from('cast_personas')
      .select('*')
      .eq('account_id', account_id)
      .eq('cast_name', cast_name)
      .single();

    const result = generateDmFromTemplate(
      persona as CastPersona | null,
      template_type || 'thank',
      target_username,
    );

    return NextResponse.json(result);
  }

  // ── Phase 2: Claude API生成 ──
  const { task_type, cast_name, context } = body as AiGenerateBody;

  if (!task_type || !cast_name) {
    return NextResponse.json({ error: 'task_type と cast_name は必須です' }, { status: 400 });
  }
  if (!LAYER_C_RULES[task_type]) {
    return NextResponse.json({ error: `未対応のtask_type: ${task_type}` }, { status: 400 });
  }
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY が未設定です' }, { status: 500 });
  }

  try {
    const sb = getAuthClient(auth.token);
    const { data: persona } = await sb
      .from('cast_personas')
      .select('*')
      .eq('cast_name', cast_name)
      .single();

    const activePersona: CastPersona = persona
      ? (persona as CastPersona)
      : { ...DEFAULT_PERSONA, cast_name };

    // System Prompt = L1(base) + Layer A + Layer B + Layer C
    const l1 = activePersona.system_prompt_base || LAYER_A_ANDO_FOUNDATION;
    const systemPrompt = [
      l1,
      '',
      buildLayerB(activePersona),
      '',
      // L3: 動的コンテキスト（設定されていれば追加）
      activePersona.system_prompt_context ? `=== 直近コンテキスト ===\n${activePersona.system_prompt_context}` : '',
      '',
      LAYER_C_RULES[task_type],
    ].filter(Boolean).join('\n');

    const userPrompt = await buildUserPrompt(task_type, { ...context, cast_name }, auth.token);

    const maxTokens = task_type === 'dm_generate' || task_type === 'realtime_coach' ? 500 : 1000;
    const result = await callClaude(systemPrompt, userPrompt, maxTokens);

    let parsed: unknown = null;
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch { /* ignore */ }

    return NextResponse.json({
      output: parsed || result.text,
      raw_text: result.text,
      reasoning: parsed && typeof parsed === 'object' && 'reasoning' in parsed
        ? (parsed as Record<string, unknown>).reasoning : null,
      cost_tokens: result.tokensUsed,
      cost_usd: result.costUsd,
      persona_used: activePersona.display_name || activePersona.cast_name,
      persona_found: !!persona,
    });
  } catch (e: unknown) {
    const err = e as { message?: string; statusCode?: number };
    return NextResponse.json(
      { error: err.message || 'Persona Agent エラー' },
      { status: err.statusCode || 500 },
    );
  }
}
