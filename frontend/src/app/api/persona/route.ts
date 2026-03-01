import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';
import { generateMockDmResponse, generateGenericMockResponse } from './mock-responses';
import { LAYER_A_ANDO_FOUNDATION } from '@/lib/prompts/layer-a-ando';
import { LAYER_A_PRINCESS_MARKETING } from '@/lib/prompts/layer-a-princess';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const USE_MOCK_CLAUDE = !ANTHROPIC_API_KEY;
const USE_MOCK_OPENAI = !OPENAI_API_KEY;

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

// cast_persona テーブル（039）の構造化データ
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

// ============================================================
// GET /api/persona?cast_name=xxx&account_id=yyy
// ペルソナ取得（認証 + account_id 検証）
// ============================================================
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const castName = searchParams.get('cast_name');
  const accountId = searchParams.get('account_id');

  if (!castName || !accountId) {
    return NextResponse.json({ error: 'cast_name と account_id は必須です' }, { status: 400 });
  }

  const auth = await authenticateAndValidateAccount(req, accountId);
  if (!auth.authenticated) return auth.error;

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
// PUT /api/persona — ペルソナ更新（upsert）（認証 + account_id 検証）
// ============================================================
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { account_id, cast_name, ...fields } = body;

  if (!account_id || !cast_name) {
    return NextResponse.json({ error: 'account_id と cast_name は必須です' }, { status: 400 });
  }

  const auth = await authenticateAndValidateAccount(req, account_id);
  if (!auth.authenticated) return auth.error;

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
// Layer B — キャスト人格定義（cast_personas + cast_persona 統合）
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

  // ── cast_persona テーブルからの構造化データ（Layer B 強化） ──
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
      parts.push(`\nNG行動（絶対にしないこと）:\n${detail.ng_behaviors.map(b => `- ${b}`).join('\n')}`);
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
  S1-S3(VIP)=特別感・唯一性を強調。「〇〇さんだけ」「特別」
  S4-S6(常連)=居場所感・安心感。「いつもの」「安心する」
  S7-S8(中堅)=軽い誘い・好奇心。「この前の続き」「気になってた」
  S9-S10(ライト/単発)=軽く短く。感謝のみ。押さない。
- シナリオ別目的:
  thankyou_regular=感謝+再来訪の種まき（直接誘わない）
  churn_recovery=存在を思い出させる+懐かしさ（理由を聞かない）
  pre_broadcast=期待感+個別感（「〇〇さんに会いたい」）
  vip_special=承認欲求充足+特別扱い（限定情報を匂わせる）
  return_nudge=軽い接触+BYAF強め（圧ゼロ）
- 必ず以下のJSON形式で出力:
{"message": "...", "reasoning": "..."}`,

  fb_report: `=== FBレポート生成ルール ===
- 構造化フォーマットで出力:
  1. 総合評価（S/A/B/C/D）— 基準: S=売上前回比150%以上, A=120%以上, B=100%以上, C=80%以上, D=80%未満
  2. 良かった点（3つ、数値根拠必須）— 「良かった」ではなく「チップ率30%増」
  3. 改善点（3つ、具体的なアクション付き）— 「もっと頑張る」禁止。「22時台に1回ゴール設定を入れる」レベル
  4. 次回アクション（優先度順に3つ）— 測定可能な行動目標
- キャストのキャラクターの口調で書く。
- 根拠のない主観評価禁止。必ずデータから読み取れる事実を引用。
- JSON形式で出力:
{"evaluation": "A", "good_points": [...], "improvements": [...], "next_actions": [...], "summary": "..."}`,

  dm_evaluate: `=== DM評価ルール ===
- DM文面を評価してスコア0-100で採点。
- 評価軸（各20点満点）:
  1. BYAF有無（末尾に「自由」要素があるか）
  2. キャラ一致度（口調・絵文字・語尾がキャストらしいか）
  3. 文字数適正（120文字以内か、短すぎないか）
  4. 個別感（ユーザー名・過去の発言への言及があるか）
  5. セグメント適合度（VIPに軽すぎ、ライトに重すぎないか）
- 改善案3つを「修正前→修正後」の具体例で提示。
- JSON形式で出力:
{"score": 85, "breakdown": {"byaf": 20, "character": 18, "length": 15, "personal": 16, "segment_fit": 16}, "improvements": ["修正前→修正後の形式で3つ"]}`,

  realtime_coach: `=== リアルタイムコーチルール ===
- 短文3行以内。即座に使える具体的アクション。
- 1行目: 何をするか（動詞で始める）
- 2行目: なぜ今やるべきか（数字で根拠）
- 3行目: 具体的なセリフ例（「」で囲む）
- 曖昧な助言禁止。「盛り上げましょう」→「〇〇さんに名前呼びで話しかけて」
- JSON形式で出力:
{"action": "...", "reasoning": "...", "urgency": "high|medium|low"}`,

  recruitment_copy: `=== 採用コピー生成ルール ===
- Princess Marketing Realism 4Step準拠。どのStepを使ったか明示。
- 訴求軸変換（必ず守ること）:
  主語: ×商品・サービス → ○「あなた」
  訴求: ×ナンバーワン（実績・スペック） → ○オンリーワン（共感・特別感）
  動詞: ×「解決する」「実現する」「稼げる」 → ○「整う」「余裕ができる」「自分で選べる」
  CTA: ×「今すぐ応募」「簡単登録」 → ○「まずは話だけ聞いてみませんか？」
  BYAF: 必ず末尾に「もちろん合わなかったらそれでOK」系を入れる
- 禁止ワード: 「チャットレディ」「アダルト」「風俗」「水商売」「簡単に稼げる」「誰でもできる」「ノーリスク」
- 恐怖訴求禁止: 「今のままだと…」「このまま年を取ったら…」は絶対に使わない
- 職業名: 「ライブ配信パフォーマー」「オンラインパフォーマー」を使用
- 金銭表現: ×「投げ銭」「チップ」 → ○「応援」「サポート」
- JSON形式で出力:
{"copy": "...", "step_breakdown": {"step1_empathy": "...", "step2_vision": "...", "step3_proof": "...", "step4_safe_cta": "..."}, "target_persona_fit": "..."}`,

  training_task: `=== 育成タスク生成ルール ===
- 具体的で測定可能な3タスク。曖昧な目標禁止。
- 各タスクの形式:
  task: 何をするか（動詞で始める）
  success_criteria: 成功基準（数値 or Yes/No で判定可能）
  deadline: いつまでに（「次回配信まで」「今週中」等）
- 例: ×「トークを改善する」 → ○「配信開始5分以内に視聴者3人に名前呼びで挨拶する」
- FBレポートの改善点から逆算して設計する。
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
        .eq('cast_name', castName)
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
        .order('message_time', { ascending: true })
        .limit(50000);

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

    case 'dm_evaluate': {
      const dmText = context.dm_text as string || '';
      const targetSegment = context.target_segment as string || '不明';
      const castName = context.cast_name as string || '';

      return `以下のDM文面を評価してください。

DM文面: 「${dmText}」
ターゲットセグメント: ${targetSegment}
キャスト: ${castName}

評価軸: BYAF有無 / キャラ一致度 / 文字数 / 個別感 / セグメント適合度
0-100でスコアリングし、改善案を3つ提示してください。`;
    }

    case 'realtime_coach': {
      const recentMessages = context.recent_messages as string || 'なし';
      const viewerCount = context.viewer_count as number || 0;
      const sessionDuration = context.session_duration as string || '不明';

      return `配信状況:
視聴者数: ${viewerCount}名
配信経過: ${sessionDuration}

直近のチャット:
${recentMessages}

今すぐ実行できる具体的なアクションを1つ提案してください。`;
    }

    case 'recruitment_copy': {
      const targetPersona = context.target_persona as string || 'あかり（24歳・事務職OL・手取り18万・推し活費用が足りない）';
      const medium = context.medium as string || 'SNS広告';
      const maxLength = context.max_length as number || 200;
      const existingCopy = context.existing_copy as string || '';
      const focusStep = context.focus_step as string || '';

      return `ターゲットペルソナ: ${targetPersona}
媒体: ${medium}
文字数上限: ${maxLength}文字
${focusStep ? `フォーカスStep: ${focusStep}` : ''}
${existingCopy ? `既存コピー: 「${existingCopy}」\n→ 訴求軸変換ルールに照らして改善してください。特に主語が「あなた」になっているか、動詞が穏やかか、CTAが安心CTAかをチェック。` : 'Princess Marketing 4Stepに沿った採用コピーを新規作成してください。'}

必須チェック:
1. 主語が「あなた」になっているか
2. 動詞が「整う」「余裕ができる」系の穏やか表現か
3. CTAが「まずは話だけ聞いてみませんか？」系の安心CTAか
4. 禁止ワードが含まれていないか
5. BYAF（「合わなかったらそれでOK」）が末尾にあるか
6. 4Stepのどの要素を使ったか明示`;
    }

    case 'training_task': {
      const castName = context.cast_name as string || '';
      const recentReport = context.recent_report as string || 'なし';
      const castType = context.cast_type as string || '不明';

      return `キャスト: ${castName}
キャストタイプ: ${castType}

直近FBレポート:
${recentReport}

このキャストが次回配信までに取り組むべき練習タスクを3つ生成してください。
具体的かつ測定可能なものにしてください。`;
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
// OpenAI API 呼び出し（mode=customer で使用。OPENAI_API_KEY 設定後に有効化）
// ============================================================
async function callOpenAI(systemPrompt: string, userPrompt: string, maxTokens = 500) {
  const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: maxTokens,
      temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!apiRes.ok) {
    const errBody = await apiRes.json().catch(() => ({}));
    if (apiRes.status === 401) {
      throw Object.assign(new Error('OpenAI APIキーが無効です'), { statusCode: 502 });
    }
    if (apiRes.status === 429) {
      throw Object.assign(new Error('OpenAI レート制限中です'), { statusCode: 429 });
    }
    throw Object.assign(
      new Error((errBody as Record<string, string>).error || `OpenAI API error: ${apiRes.status}`),
      { statusCode: 502 },
    );
  }

  const apiData = await apiRes.json();
  const text = apiData.choices[0].message.content;
  const inputTokens = apiData.usage?.prompt_tokens || 0;
  const outputTokens = apiData.usage?.completion_tokens || 0;
  return {
    text,
    tokensUsed: inputTokens + outputTokens,
    // gpt-4o-mini pricing: $0.15/1M input, $0.60/1M output
    costUsd: (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000,
  };
}

// ============================================================
// キャスト別表示名をDBから取得（cast_personas → registered_casts → castName）
// ============================================================
async function getCastDisplayName(castName: string): Promise<string> {
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data } = await sb
      .from('cast_personas')
      .select('display_name')
      .eq('cast_name', castName)
      .limit(1)
      .single();
    if (data?.display_name) return data.display_name;

    const { data: regCast } = await sb
      .from('registered_casts')
      .select('display_name')
      .eq('cast_name', castName)
      .limit(1)
      .single();
    if (regCast?.display_name) return regCast.display_name;
  } catch { /* DB接続失敗時はキャスト名をそのまま返す */ }
  return castName;
}

// ============================================================
// Layer A 選択 — mode に応じて安藤式 or Princess Marketing
// ============================================================
function selectLayerA(mode: string, personaBase: string | null): string {
  if (mode === 'recruitment') return LAYER_A_PRINCESS_MARKETING;
  return personaBase || LAYER_A_ANDO_FOUNDATION;
}

// ============================================================
// モードB訴求軸変換レイヤー — recruitment mode 専用
// Layer A(Princess Marketing) と Layer C の間に挟む変換ルール
// ============================================================
const RECRUITMENT_AXIS_TRANSFORM = `=== 訴求軸変換チェックリスト ===
生成したコピーが以下の変換ルールに従っているか、出力前に必ずセルフチェックすること。

【主語変換】
× 「当社は」「弊社の」「このサービスは」
○ 「あなたは」「あなたの」「あなたが」
→ 全文中の主語を「あなた」に統一。商品説明ではなく「あなたの未来」を語る。

【訴求変換】
× ナンバーワン訴求: 「業界No.1」「実績○件」「稼げる額」
○ オンリーワン訴求: 「あなたらしく」「自分のペースで」「他にない働き方」
→ スペック競争ではなく「この人だから」という共感で選ばれる設計。

【動詞変換】
× 「解決する」「実現する」「稼げる」「儲かる」「叶える」
○ 「整う」「余裕ができる」「自分で選べる」「好きなことに使える」
→ 力強い動詞ではなく、自然体で穏やかな変化を表現。

【CTA変換】
× 「今すぐ応募」「限定○名」「急いで」「簡単登録」
○ 「まずは話だけ聞いてみませんか？」「見学だけでもOK」「相談してみる」
→ 応募ではなく「相談」「見学」の導線。ハードルを最大限下げる。

【BYAF必須】
生成文の末尾に必ず「もちろん合わなかったらそれでOK」系の一文を入れる。
例: 「もちろん話を聞いて違うなと思ったら、それで全然大丈夫です」

【禁止ワード最終チェック】
以下が含まれていたら書き直し:
チャットレディ / アダルト / 風俗 / 水商売 / 簡単に稼げる / 誰でもできる / ノーリスク / 今のままだと… / このまま年を取ったら…`;

// ============================================================
// ペルソナ反応シミュレーション（設計書 Layer 2 簡易版）
// task_type と mode に応じて仮想ペルソナの反応を生成
// ============================================================
interface PersonaReaction {
  persona: string;
  reaction: string;
}

function buildPersonaReactions(
  taskType: TaskType,
  mode: string,
  parsed: Record<string, unknown> | null,
): PersonaReaction[] {
  if (mode === 'recruitment') {
    return [
      { persona: 'あかり(24歳・事務職OL)', reaction: `共感${parsed ? '◎' : '○'} 信頼○ 応募△` },
      { persona: 'みゆ(28歳・シングルマザー)', reaction: `共感○ 信頼${parsed ? '◎' : '○'} 応募○` },
      { persona: 'ひな(32歳・派遣社員)', reaction: `共感△ 信頼○ 応募△` },
    ];
  }

  // モードA（男性顧客向け）
  switch (taskType) {
    case 'dm_generate':
      return [
        { persona: 'S2 VIP準現役', reaction: `開封◎ 返信${parsed ? '◎' : '○'} 来訪△` },
        { persona: 'S5 常連離脱危機', reaction: `開封○ 返信△ 来訪${parsed ? '○' : '△'}` },
        { persona: 'S9 お試し', reaction: `開封△ 返信△ 来訪△` },
      ];
    case 'fb_report':
      return [
        { persona: 'キャスト本人', reaction: `理解◎ モチベ${parsed ? '◎' : '○'} 実行○` },
      ];
    case 'dm_evaluate':
      return [
        { persona: 'S1-S3 VIP層', reaction: `反応${parsed ? '◎' : '○'}` },
        { persona: 'S7-S10 ライト層', reaction: `反応${parsed ? '○' : '△'}` },
      ];
    default:
      return [];
  }
}

// ============================================================
// Confidence 算出（出力のJSON構造の完全性で簡易判定）
// ============================================================
function calcConfidence(parsed: Record<string, unknown> | null, taskType: TaskType): number {
  if (!parsed) return 0.3;

  const requiredFields: Record<TaskType, string[]> = {
    dm_generate: ['message', 'reasoning'],
    fb_report: ['evaluation', 'good_points', 'improvements'],
    dm_evaluate: ['score', 'breakdown', 'improvements'],
    realtime_coach: ['action', 'reasoning', 'urgency'],
    recruitment_copy: ['copy', 'step_breakdown'],
    training_task: ['tasks'],
  };

  const fields = requiredFields[taskType] || [];
  if (fields.length === 0) return 0.7;

  const present = fields.filter(f => f in parsed).length;
  return Math.round((0.4 + 0.6 * (present / fields.length)) * 100) / 100;
}

// ============================================================
// POST /api/persona
// mode=customer    → モードA OpenAI DM生成（モック/実API自動切替）
// mode=recruitment → モードB Princess Marketing（採用向け）
// mode=generate    → Phase 1 テンプレート文面生成
// mode=ai          → Phase 2/3 Claude API統一生成
// (後方互換) task_type指定 → Phase 2/3
// ============================================================
export async function POST(req: NextRequest) {
  const body = await req.json();
  const mode = body.mode as string || (body.task_type ? 'ai' : 'generate');
  const reqAccountId = body.account_id as string | null;

  // ── mode=customer: モードA OpenAI DM生成パス ──
  // OPENAI_API_KEY なし → モック（認証不要）
  // OPENAI_API_KEY あり → 認証 + DB + OpenAI
  if (mode === 'customer') {
    const castName = body.cast_name as string;
    const taskType = body.task_type as string;
    const ctx = body.context as Record<string, unknown> | undefined;

    if (!castName || !ctx?.username) {
      return NextResponse.json({ error: 'cast_name と context.username は必須です' }, { status: 400 });
    }
    if (taskType && taskType !== 'dm_generate') {
      return NextResponse.json({ error: 'mode=customer は現在 dm_generate のみ対応' }, { status: 400 });
    }

    const username = ctx.username as string;
    const segment = (ctx.segment as string) || 'S10';
    const scenario = (ctx.scenario as string) || 'A';
    const stepNumber = (ctx.step_number as number) || 1;
    const recentMessage = ctx.recent_message as string | undefined;
    const lastDmTone = ctx.last_dm_tone as string | undefined;

    // ── モック: OPENAI_API_KEY 未設定 ──
    if (USE_MOCK_OPENAI) {
      const displayName = await getCastDisplayName(castName);
      const mockRes = generateMockDmResponse({
        username,
        segment,
        scenario,
        castDisplayName: displayName,
      });
      return NextResponse.json(mockRes);
    }

    // ── 実API: 認証 + DB + OpenAI ──
    const auth = await authenticateAndValidateAccount(req, reqAccountId);
    if (!auth.authenticated) return auth.error;

    try {
      const sb = getAuthClient(auth.token);
      let personaQuery = sb
        .from('cast_personas')
        .select('*')
        .eq('cast_name', castName);
      if (reqAccountId) personaQuery = personaQuery.eq('account_id', reqAccountId);
      const { data: persona } = await personaQuery.single();

      const activePersona: CastPersona = persona
        ? (persona as CastPersona)
        : { ...DEFAULT_PERSONA, cast_name: castName };

      const detail = await fetchCastPersonaDetail(auth.token, castName, reqAccountId);

      const systemPrompt = [
        LAYER_A_ANDO_FOUNDATION,
        '',
        buildLayerB(activePersona, detail),
        '',
        activePersona.system_prompt_context ? `=== 直近コンテキスト ===\n${activePersona.system_prompt_context}` : '',
        '',
        LAYER_C_RULES.dm_generate,
      ].filter(Boolean).join('\n');

      const SCENARIO_LABELS: Record<string, string> = { A: 'お礼', B: '離脱防止', C: '配信前告知', D: 'VIP特別', E: '復帰促進' };
      const scenarioLabel = SCENARIO_LABELS[scenario] || scenario;

      const userPrompt = `ユーザー名: ${username}
セグメント: ${segment}
シナリオ: ${scenarioLabel} (Step ${stepNumber})
${recentMessage ? `直近発言: ${recentMessage}` : ''}
${lastDmTone ? `前回DMトーン: ${lastDmTone}（今回は異なるトーンで）` : ''}

上記ユーザーに最適なDMを生成してください。`;

      const result = await callOpenAI(systemPrompt, userPrompt, 500);

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(result.text);
      } catch {
        parsed = { message: result.text, reasoning: 'JSON parse failed', tone: 'emotional', byaf_used: activePersona.byaf_style || '' };
      }

      return NextResponse.json({
        output: { message: (parsed.message as string) || result.text },
        reasoning: (parsed.reasoning as string) || '',
        persona_reactions: buildPersonaReactions('dm_generate', 'customer', parsed),
        confidence: calcConfidence(parsed, 'dm_generate'),
        cost_tokens: result.tokensUsed,
        // 後方互換フィールド
        message: (parsed.message as string) || result.text,
        tone: (parsed.tone as string) || 'emotional',
        byaf_used: (parsed.byaf_used as string) || activePersona.byaf_style || '',
        persona_used: activePersona.display_name || activePersona.cast_name,
        persona_found: !!persona,
        is_mock: false,
        model: 'gpt-4o-mini',
        cost_usd: result.costUsd,
      });
    } catch (e: unknown) {
      const err = e as { message?: string; statusCode?: number };
      // 401（APIキー無効）→ モックにフォールバック
      if (err.statusCode === 502 && err.message?.includes('APIキーが無効')) {
        const displayName = await getCastDisplayName(castName);
        const mockRes = generateMockDmResponse({
          username,
          segment,
          scenario,
          castDisplayName: displayName,
        });
        return NextResponse.json({ ...mockRes, _fallback_reason: 'OpenAI APIキー無効のためモックにフォールバック' });
      }
      await reportError(e, { file: 'api/persona', context: 'OpenAI DM生成' });
      return NextResponse.json(
        { error: err.message || 'OpenAI DM生成エラー' },
        { status: err.statusCode || 500 },
      );
    }
  }

  // ── 以下は認証必須モード ──
  const auth = await authenticateAndValidateAccount(req, reqAccountId);
  if (!auth.authenticated) return auth.error;

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

  // ── Phase 3: AI統一生成（mode=ai / mode=recruitment） ──
  const { task_type, cast_name, context } = body as AiGenerateBody;

  if (!task_type || !cast_name) {
    return NextResponse.json({ error: 'task_type と cast_name は必須です' }, { status: 400 });
  }
  if (!LAYER_C_RULES[task_type]) {
    return NextResponse.json({ error: `未対応のtask_type: ${task_type}` }, { status: 400 });
  }

  // mode=recruitment で task_type が customer向けの場合はエラー
  if (mode === 'recruitment' && !['recruitment_copy', 'training_task'].includes(task_type)) {
    return NextResponse.json(
      { error: `mode=recruitment では recruitment_copy または training_task のみ対応。受信: ${task_type}` },
      { status: 400 },
    );
  }

  // APIキー未設定 → OpenAIフォールバック or モック
  if (USE_MOCK_CLAUDE && USE_MOCK_OPENAI) {
    if (task_type === 'dm_generate') {
      const username = (context?.username || context?.user_name || 'user') as string;
      const segment = (context?.segment) as string | undefined;
      const scenario = (context?.scenario || context?.scenario_type) as string | undefined;
      const mockRes = generateMockDmResponse({
        username,
        segment,
        scenario,
        castDisplayName: cast_name,
      });
      return NextResponse.json(mockRes);
    }
    return NextResponse.json(generateGenericMockResponse(task_type, cast_name));
  }

  try {
    const sb = getAuthClient(auth.token);
    let personaQuery2 = sb
      .from('cast_personas')
      .select('*')
      .eq('cast_name', cast_name);
    if (reqAccountId) personaQuery2 = personaQuery2.eq('account_id', reqAccountId);
    const { data: persona } = await personaQuery2.single();

    const activePersona: CastPersona = persona
      ? (persona as CastPersona)
      : { ...DEFAULT_PERSONA, cast_name };

    const detail = await fetchCastPersonaDetail(auth.token, cast_name, reqAccountId);

    // Layer A: mode に応じて安藤式 or Princess Marketing を選択
    const layerA = selectLayerA(mode, activePersona.system_prompt_base);

    // System Prompt = Layer A + Layer B + Context + Layer C (+ 訴求軸変換 for recruitment)
    const systemPrompt = [
      layerA,
      '',
      // mode=recruitment: キャスト人格の代わりにエージェンシーブランドとして振る舞う
      mode === 'recruitment'
        ? `=== あなたの役割 ===\nライブ配信エージェンシーの採用マーケター。\n温かく、共感的で、押しつけがましくない。\n「この人なら相談できそう」と思わせるトーン。`
        : buildLayerB(activePersona, detail),
      '',
      activePersona.system_prompt_context ? `=== 直近コンテキスト ===\n${activePersona.system_prompt_context}` : '',
      '',
      LAYER_C_RULES[task_type],
      // mode=recruitment: 訴求軸変換チェックリストを追加
      mode === 'recruitment' ? `\n${RECRUITMENT_AXIS_TRANSFORM}` : '',
    ].filter(Boolean).join('\n');

    const userPrompt = await buildUserPrompt(task_type, { ...context, cast_name }, auth.token);

    const maxTokens = task_type === 'dm_generate' || task_type === 'realtime_coach' ? 500 : 1000;

    // Claude優先、なければOpenAIフォールバック
    const useOpenAiFallback = USE_MOCK_CLAUDE && !USE_MOCK_OPENAI;
    const result = useOpenAiFallback
      ? await callOpenAI(systemPrompt, userPrompt, maxTokens)
      : await callClaude(systemPrompt, userPrompt, maxTokens);
    const modelUsed = useOpenAiFallback ? 'gpt-4o' : 'claude-sonnet-4-20250514';

    let parsed: Record<string, unknown> | null = null;
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch { /* ignore */ }

    return NextResponse.json({
      output: parsed || result.text,
      reasoning: parsed && 'reasoning' in parsed ? parsed.reasoning : null,
      persona_reactions: buildPersonaReactions(task_type, mode, parsed),
      confidence: calcConfidence(parsed, task_type),
      cost_tokens: result.tokensUsed,
      // 補助フィールド
      raw_text: result.text,
      cost_usd: result.costUsd,
      model: modelUsed,
      persona_used: activePersona.display_name || activePersona.cast_name,
      persona_found: !!persona,
    });
  } catch (e: unknown) {
    const err = e as { message?: string; statusCode?: number };
    await reportError(e, { file: 'api/persona', context: `Persona Agent AI生成 (mode=${mode})` });
    return NextResponse.json(
      { error: err.message || 'Persona Agent エラー' },
      { status: err.statusCode || 500 },
    );
  }
}
