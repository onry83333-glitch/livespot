import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// ============================================================
// Types
// ============================================================
type TaskType = 'dm_generate' | 'fb_report' | 'dm_evaluate' | 'realtime_coach' | 'recruitment_copy' | 'training_task';
type Mode = 'customer' | 'recruitment';

interface PersonaRow {
  id: string;
  account_id: string;
  cast_name: string;
  character_type: string;
  speaking_style: {
    suffix: string[];
    emoji_rate: 'low' | 'medium' | 'high';
    formality: 'casual' | 'casual_polite' | 'polite';
    max_length: number;
  };
  personality_traits: string[];
  ng_behaviors: string[];
  greeting_patterns: Record<string, string>;
  dm_tone_examples: Record<string, string>;
}

interface RequestBody {
  task_type: TaskType;
  mode?: Mode;
  cast_name: string;
  context: Record<string, unknown>;
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
// Layer B — キャスト人格定義（動的生成）
// ============================================================
function buildLayerB(persona: PersonaRow): string {
  const ngList = persona.ng_behaviors.map(b => `- ${b}`).join('\n');
  const toneExamples = Object.entries(persona.dm_tone_examples)
    .map(([key, val]) => `${key}: ${val}`)
    .join('\n');

  return `=== あなたのキャラクター ===
キャスト名: ${persona.cast_name}
タイプ: ${persona.character_type}
性格: ${persona.personality_traits.join('、')}
口調の語尾: ${persona.speaking_style.suffix.join('、')}
絵文字使用率: ${persona.speaking_style.emoji_rate}
敬語レベル: ${persona.speaking_style.formality}

絶対にしないこと:
${ngList}

トーンのお手本:
${toneExamples}

↓ このキャラクターとして生成してください。
「このキャストが書きそうな文章」になっていることが最も重要。`;
}

// ============================================================
// Layer C — タスク固有ルール（全パターン定義）
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
- シナリオ別目的:
  thankyou_vip=言質取り（「また来てくれる？」）
  thankyou_regular=行動再定義（「応援してくれて嬉しい」）
  thankyou_first=短く嬉しさだけ
  churn_recovery_14d=軽いノリで
  churn_recovery_30d=企画・イベント告知を添える
  churn_recovery_60d=最終DM、淡白に
- 必ず以下のJSON形式で出力:
{"message": "...", "reasoning": "..."}`,

  fb_report: `=== FBレポート生成ルール ===
- 構造化フォーマットで出力:
  1. 総合評価（S/A/B/C/D）
  2. 良かった点（3つ、数値根拠必須）
  3. 改善点（3つ、具体的なアクション付き）
  4. 次回アクション（優先度順に3つ）
- 数値根拠必須。「良かった」ではなく「チップ率30%増」。
- キャストのキャラで書く（設定された口調で「お疲れ様〜！」から始まる）。
- 過去セッションとの比較があれば必ず言及。
- JSON形式で出力:
{"evaluation": "A", "good_points": [...], "improvements": [...], "next_actions": [...], "summary": "..."}`,

  dm_evaluate: `=== DM評価ルール ===
- DM文面を評価してスコア0-100で採点。
- 評価軸: BYAF有無/キャラ一致度/文字数/個別感/セグメント適合度
- 改善案3つを具体的に提示。
- ペルソナ反応シミュレーション:
  S2(VIP準現役)がどう感じるか
  S5(常連離脱危機)がどう感じるか
  S9(ライト)がどう感じるか
- JSON形式で出力:
{"score": 85, "breakdown": {...}, "improvements": [...], "simulations": {"S2": "...", "S5": "...", "S9": "..."}}`,

  realtime_coach: `=== リアルタイムコーチルール ===
- 短文3行以内。即座に使える具体的アクション。
- 「今○○の話題が盛り上がってるから、ここでギフト誘導」のように具体的に。
- 数字やユーザー名を必ず含める。
- JSON形式で出力:
{"action": "...", "reasoning": "...", "urgency": "high|medium|low"}`,

  recruitment_copy: `=== 採用コピー生成ルール ===
- Princess Marketing Realism 4Step準拠:
  Step1: 「私だけは分かってるよ」（共感）
  Step2: 「でもこのままだと…」（問題提起、恐怖禁止）
  Step3: 「こういう場所があるよ」（オンリーワン訴求）
  Step4: 「まずは話だけ聞いてみない？」（軽いCTA）
- 主語は「あなた」。
- 禁止: 「チャットレディ」「アダルト」「風俗」「恐怖訴求」「簡単に稼げる」
- ペルソナ3人の反応シミュレーション付き。
- JSON形式で出力:
{"copy": "...", "step_breakdown": {...}, "simulations": [...]}`,

  training_task: `=== 育成タスク生成ルール ===
- 具体的で3つ。測定可能。
- 例: 「チップ時のお礼を『名前+具体行動』にする練習を3回」
- 各タスクに成功基準と期限を設定。
- JSON形式で出力:
{"tasks": [{"task": "...", "success_criteria": "...", "deadline": "..."}]}`,
};

// ============================================================
// デフォルトペルソナ（テーブルに未登録の場合）
// ============================================================
const DEFAULT_PERSONA: PersonaRow = {
  id: '',
  account_id: '',
  cast_name: 'default',
  character_type: '甘え系',
  speaking_style: { suffix: ['〜', 'よ', 'ね'], emoji_rate: 'medium', formality: 'casual_polite', max_length: 120 },
  personality_traits: ['聞き上手'],
  ng_behaviors: ['他キャストの悪口', 'お金の話を直接する'],
  greeting_patterns: { first_time: 'はじめまして！', regular: 'おかえり〜', vip: '○○さん待ってた！' },
  dm_tone_examples: { thankyou: '今日はありがとう〜', churn: '最近見かけないけど元気？' },
};

// ============================================================
// User Promptビルダー（task_type別）
// ============================================================
async function buildUserPrompt(
  taskType: TaskType,
  context: Record<string, unknown>,
  token: string,
): Promise<string> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  switch (taskType) {
    case 'dm_generate': {
      const userName = context.user_name as string;
      const castName = context.cast_name as string;
      const scenarioType = context.scenario_type as string || 'thankyou_regular';
      const stepNumber = context.step_number as number || 1;

      // spy_messages 直近10件
      const { data: spyMsgs } = await supabase
        .from('spy_messages')
        .select('message, message_time, msg_type, tokens')
        .eq('user_name', userName)
        .eq('cast_name', castName)
        .order('message_time', { ascending: false })
        .limit(10);

      // coin_transactions サマリー
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

      // paid_users からセグメント
      const { data: paidUser } = await supabase
        .from('paid_users')
        .select('total_coins, last_seen')
        .eq('user_name', userName)
        .single();

      const segment = paidUser
        ? getSegmentLabel(paidUser.total_coins, paidUser.last_seen)
        : 'S10:単発';

      // 前回DM
      const { data: lastDm } = await supabase
        .from('dm_send_log')
        .select('message, sent_at')
        .eq('user_name', userName)
        .eq('cast_name', castName)
        .eq('status', 'success')
        .order('sent_at', { ascending: false })
        .limit(1)
        .single();

      const spyLog = spyMsgs?.map(m =>
        `[${m.message_time?.slice(11, 16) || '??:??'}] ${m.msg_type}: ${m.message || ''} ${m.tokens ? `(${m.tokens}tk)` : ''}`
      ).join('\n') || 'なし';

      return `ユーザー名: ${userName}
セグメント: ${segment}
累計コイン: ${totalCoins}tk / 平均: ${avgCoins}tk / 最終: ${lastTxDate}
シナリオ: ${scenarioType} (Step ${stepNumber})
前回DM: ${lastDm?.message || 'なし'} (${lastDm?.sent_at || ''})

直近の発言ログ:
${spyLog}

上記の情報をもとに、このユーザーに最適なDMを生成してください。`;
    }

    case 'fb_report': {
      const sessionId = context.session_id as string;

      const { data: session } = await supabase
        .from('sessions')
        .select('*')
        .eq('session_id', sessionId)
        .single();

      if (!session) return 'セッションが見つかりません。';

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

      const endedAt = session.ended_at || msgs[msgs.length - 1]?.message_time || new Date().toISOString();
      const durationMin = Math.max(1, Math.round(
        (new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 60000
      ));

      // チャットサンプル（先頭20 + 末尾20）
      const chatMsgs = msgs.filter(m => m.msg_type === 'chat');
      const chatSample = [
        ...chatMsgs.slice(0, 20),
        ...(chatMsgs.length > 40 ? chatMsgs.slice(-20) : []),
      ].map(m =>
        `[${m.message_time?.slice(11, 16) || '??:??'}] ${m.user_name || '?'}: ${m.message || ''}`
      ).join('\n');

      return `配信データ:
キャスト: ${session.title}
配信時間: ${durationMin}分
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
// セグメント判定（ai-report と同じロジック）
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
      throw Object.assign(new Error('レート制限中です。しばらく待ってから再試行してください'), { statusCode: 429 });
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
// ============================================================
export async function POST(req: NextRequest) {
  // 1. 認証チェック
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const token = authHeader.slice(7);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    return NextResponse.json({ error: '認証トークンが無効です' }, { status: 401 });
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY が未設定です' }, { status: 500 });
  }

  // 2. リクエストボディ
  const body = (await req.json()) as RequestBody;
  const { task_type, cast_name, context } = body;

  if (!task_type || !cast_name) {
    return NextResponse.json({ error: 'task_type と cast_name は必須です' }, { status: 400 });
  }

  if (!LAYER_C_RULES[task_type]) {
    return NextResponse.json({ error: `未対応のtask_type: ${task_type}` }, { status: 400 });
  }

  try {
    // 3. cast_persona テーブルからペルソナ取得
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: persona } = await supabase
      .from('cast_persona')
      .select('*')
      .eq('cast_name', cast_name)
      .single();

    const activePersona: PersonaRow = persona
      ? (persona as PersonaRow)
      : { ...DEFAULT_PERSONA, cast_name };

    // 4. System Prompt 組み立て = Layer A + Layer B + Layer C
    const systemPrompt = [
      LAYER_A_ANDO_FOUNDATION,
      '',
      buildLayerB(activePersona),
      '',
      LAYER_C_RULES[task_type],
    ].join('\n');

    // 5. User Prompt 組み立て
    const userPrompt = await buildUserPrompt(task_type, { ...context, cast_name }, token);

    // 6. Claude API 呼び出し
    const maxTokens = task_type === 'dm_generate' || task_type === 'realtime_coach' ? 500 : 1000;
    const result = await callClaude(systemPrompt, userPrompt, maxTokens);

    // 7. JSON パース試行
    let parsed: unknown = null;
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // JSONパース失敗 — テキストをそのまま返す
    }

    return NextResponse.json({
      output: parsed || result.text,
      raw_text: result.text,
      reasoning: parsed && typeof parsed === 'object' && 'reasoning' in parsed
        ? (parsed as Record<string, unknown>).reasoning
        : null,
      confidence: parsed && typeof parsed === 'object' && 'score' in parsed
        ? (parsed as Record<string, unknown>).score
        : null,
      cost_tokens: result.tokensUsed,
      cost_usd: result.costUsd,
      persona_used: activePersona.cast_name,
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
