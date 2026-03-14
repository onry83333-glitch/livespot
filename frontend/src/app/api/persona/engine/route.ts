import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';
import { LAYER_A_ANDO_FOUNDATION } from '@/lib/prompts/layer-a-ando';
import { LAYER_A_PRINCESS_MARKETING } from '@/lib/prompts/layer-a-princess';
import { buildCastRAGContext } from '@/lib/rag-context';

export const maxDuration = 60;

// ============================================================
// 統一クリエイティブエンジン /api/persona/engine
// task_type: dm / x_post / recruitment / content
// 既存 /api/persona/route.ts の Layer A/B/C 構造を維持
// 過去の高評価データを persona_feedback から取得してコンテキストに含める
// ============================================================

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/[\s\r\n]+/g, '');
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

type EngineTaskType = 'dm' | 'x_post' | 'recruitment' | 'content' | 'fb_report' | 'fb_report_analysis' | 'fb_report_new_users' | 'fb_report_repeaters';

interface EngineRequest {
  task_type: EngineTaskType;
  cast_name: string;
  account_id?: string;
  context: Record<string, unknown>;
  user_prompt?: string; // 2リクエスト分離: Step2でフロントから渡されたプロンプト（collect5AxisDataスキップ用）
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

/** 構造化チッパーデータ（JSレポート生成用） */
export interface StructuredTipperData {
  sessionSummary: {
    totalTokens: number;
    txCount: number;
    durationMinutes: number;
    uniqueTipperCount: number;
    anonymousCount: number;
    anonymousTokens: number;
  };
  newTippers: Array<{ username: string; tk: number; count: number }>;
  repeaters: Array<{
    username: string;
    tk: number;
    firstTipDate: string;   // YYYY-MM-DD
    lastTipDate: string;    // YYYY-MM-DD（今回セッション前の最終課金日）
    totalTk: number;        // 累計コイン（今回セッション含まず）
    daysSince: number;      // セッション開始日 - lastTipDate
  }>;
  returnUsers: Array<{
    username: string;
    tk: number;
    firstTipDate: string;
    lastTipDate: string;
    daysSince: number;
  }>;
  dmCopyNames: {
    newTippers: string[];
    repeaters: string[];
    returnUsers: string[];
  };
}

/** classifyTippers の戻り値 */
export interface ClassifiedTippers {
  newTippers: Array<{ username: string; tk: number; count: number }>;
  repeaters: Array<{
    username: string; tk: number;
    firstTipDate: string; lastTipDate: string;
    totalTk: number; daysSince: number;
  }>;
  comebackUsers: Array<{
    username: string; tk: number;
    firstTipDate: string; lastTipDate: string;
    daysSince: number;
  }>;
}

/**
 * チッパーリストを新規/リピーター/復帰に分類する
 * collect5AxisData内のロジック(729-832相当)を切り出したもの
 */
export async function classifyTippers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  accountId: string,
  castName: string,
  sessionStartISO: string,
  tippers: Array<{ username: string; total: number; count: number }>,
): Promise<ClassifiedTippers> {
  const BATCH_SIZE = 50;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const sessionStartMs = new Date(sessionStartISO).getTime();

  interface TipperHistory {
    username: string;
    historyTxCount: number;
    historyTokens: number;
    firstTipDate: string;
    lastTipDate: string;
  }

  const tipperNames = tippers.map(t => t.username);
  const historyMap = new Map<string, TipperHistory>();

  if (tipperNames.length > 0) {
    for (let bi = 0; bi < tipperNames.length; bi += BATCH_SIZE) {
      const batch = tipperNames.slice(bi, bi + BATCH_SIZE);
      const { data: histRows } = await supabase
        .from('coin_transactions')
        .select('user_name, date, tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .in('user_name', batch)
        .lt('date', sessionStartISO)
        .gt('tokens', 0)
        .order('date', { ascending: true })
        .limit(100000);

      for (const row of histRows || []) {
        const uname = row.user_name as string;
        const dateStr = row.date as string;
        const tk = (row.tokens as number) || 0;
        const existing = historyMap.get(uname);
        if (existing) {
          if (dateStr < existing.firstTipDate) existing.firstTipDate = dateStr;
          if (dateStr > existing.lastTipDate) existing.lastTipDate = dateStr;
          existing.historyTxCount++;
          existing.historyTokens += tk;
        } else {
          historyMap.set(uname, {
            username: uname, historyTxCount: 1, historyTokens: tk,
            firstTipDate: dateStr, lastTipDate: dateStr,
          });
        }
      }
    }
  }

  const newTipperSet = new Set(tipperNames.filter(n => !historyMap.has(n)));

  const newTippers = tippers
    .filter(t => newTipperSet.has(t.username))
    .sort((a, b) => b.total - a.total)
    .map(t => ({ username: t.username, tk: t.total, count: t.count }));

  const returningTippersSorted = tippers
    .filter(t => !newTipperSet.has(t.username))
    .sort((a, b) => b.total - a.total);

  const repeaters = returningTippersSorted.map(t => {
    const hist = historyMap.get(t.username);
    const daysSince = hist
      ? Math.floor((sessionStartMs - new Date(hist.lastTipDate).getTime()) / (24 * 60 * 60 * 1000))
      : 0;
    return {
      username: t.username, tk: t.total,
      firstTipDate: hist?.firstTipDate?.slice(0, 10) || '',
      lastTipDate: hist?.lastTipDate?.slice(0, 10) || '',
      totalTk: hist?.historyTokens || 0,
      daysSince,
    };
  });

  const comebackUsers = repeaters
    .filter(r => {
      const lastMs = new Date(r.lastTipDate).getTime();
      return (sessionStartMs - lastMs) >= THIRTY_DAYS_MS;
    })
    .sort((a, b) => b.daysSince - a.daysSince);

  return { newTippers, repeaters, comebackUsers };
}

export interface FiveAxisData {
  tipperStructure: string;
  tipTriggers: string;
  chatTemperature: string;
  diffFromPrevious: string;
  benchmark: string;
  dmActionLists: string;  // Group D: #11離脱予兆, #12初回課金後再訪率, #13復帰きっかけ
  userBehavior: string;   // Group A: #1リテンション, #2来訪間隔, #3課金エスカレーション, #4課金タイプ変遷
  broadcastQuality: string; // Group B: #5新規獲得率推移, #6常連維持率, #7チップ速度カーブ, #8ticketshow最適化
  realtimeMetrics: string;  // Group E: viewer_stats時系列, ゴール前後変化, ticketshow前後変化
  crossCompetitor: string;  // Group C: #9自社ファンの他社出現, #10他社ゴール設定パターン
  structured?: StructuredTipperData; // JSレポート生成用の構造化データ
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
export function buildUserPrompt(
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
  「🔴 優先度A」「🟡 優先度B」「🟢 優先度C」「🚩 離脱警告」
  「## #11 離脱予兆ユーザー」「## #12 初回課金後2回目来訪率」「## #13 復帰ユーザーの復帰きっかけ」
  「## #1 セッション間リテンション」「## #2 来訪間隔パターン」「## #3 課金エスカレーション」「## #4 課金タイプ変遷」
  「## #5 セッション別新規獲得率」「## #6 常連維持率」「## #7 チップ速度の時間カーブ」「## #8 ticketshow突入タイミング」
  「## viewer_stats時系列」「## ticketshow前後」
  「## #9 自社ファンの他社出現」「## #10 他社のゴール設定パターン」
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

### 軸7: ユーザー行動パターン
${fiveAxis?.userBehavior || 'データなし'}

### 軸8: 配信品質測定
${fiveAxis?.broadcastQuality || 'データなし'}

### 軸9: リアルタイム推移
${fiveAxis?.realtimeMetrics || 'データなし'}

### 軸10: 他社突合（グループC）
${fiveAxis?.crossCompetitor || 'データなし'}

## 分析指示
- 事実データに基づく分析と、推測に基づく提案を明確に分けること
- 「新規」の定義: このキャストへの初チップが今回セッション内の人。paid_usersテーブルの値ではない
- チッパーの履歴情報（初回日・累計tk）がある場合、常連の貢献度や離脱リスクの分析に使うこと
- チャットデータがない場合、チャット関連の推測は「チャットデータ未収集のため推測不可」と明示すること
- DMだけでなく、配信構成・ゴール設定・コミュニケーション施策も提案すること
- 軸6のDM施策直結データは「## 📩 DM施策アクションリスト」セクションとしてレポート末尾にまとめること
- 離脱予兆ユーザーには「また来てね」系DM、初回→未再訪には「初回ありがとう」系DM、復帰ユーザーには「おかえり」系DMを提案すること
- 課金減少ユーザーにはフォローDM、課金増加ユーザーには感謝DMを提案すること
- リテンション率と来訪頻度パターンから、配信スケジュールや集客施策の提案も含めること
- チップ速度カーブから序盤・中盤・終盤の盛り上がり分析を行い、配信構成の改善提案をすること
- ticketshowのCVRとタイミングから最適な突入タイミングを具体的に提案すること（「配信開始XX分後にYY人のコイン持ちが集まってから」等）
- viewer_statsデータがない場合は「データ不足」と明示し、推測しないこと
- 🚩離脱警告ユーザーは「## ⚠️ 離脱予兆アラート」セクションで赤旗付きで目立たせること。累計高額なのに今回急落=離脱の兆候
- DM優先度（🔴A→🟡B→🟢C）の順でDM施策を提案すること。優先度Aは即DM推奨
- 復帰フック分析（💡マーク）がある場合、ticketshow告知をDM文面に含める提案をすること
- #9自社ファンの他社出現データがある場合、ファンの流出先と時間帯から配信スケジュール改善を提案すること
- #10他社ゴール設定パターンがある場合、自社のゴール金額設定の参考として具体的な提案をすること
- 他社データはSPYログベースの参考値。「推測:」プレフィックスを付けて事実と分離すること`;
    }

    case 'fb_report_analysis': {
      const summaryJson = context.axis_summary as string || '{}';
      const castDisplayName = context.cast_display_name as string || context.cast_name as string || '';
      return `# 配信FBレポート — 分析エンジン

キャスト名: ${castDisplayName}

## データソースについて（絶対遵守）
以下のデータはSQL + ルールベースで収集した構造化データです。
- [事実] タグ付きの数値は検証済み。1文字も変更せずそのまま引用すること。
- 推測・分析を行う場合は必ず「推測:」「分析:」と明示すること。

## 集計データ
${summaryJson}

## 分析指示
以下のセクションをMarkdownで出力してください:
1. 📊 データ分析 — 数値ファクト整理（セッション概要、チッパー構造、ticketshow、チップ速度カーブ）
2. 🎯 マーケティング視点 — 安藤式7原則との紐付け
3. 購買心理3ルート分析 — 衝動型/計画型/社会的証明型
4. 🎨 キャスト視点 — 次の配信で実行すべき3アクション（具体的に）
5. 💭 ファン心理分析 — セグメント別
6. 📋 次回配信アクションプラン — 具体的なアクション3つ

- DMだけでなく、配信構成・ゴール設定・コミュニケーション施策も提案すること
- チップ速度カーブから序盤・中盤・終盤の盛り上がり分析を行い、配信構成の改善提案をすること
- ticketshowのCVRとタイミングから最適な突入タイミングを具体的に提案すること
- 抽象的な提案禁止（×「コミュニケーションを増やす」→ ○「配信開始10分以内にチャットで名前を3人呼ぶ」）
- 改善提案は「次の配信で」実行可能な具体策のみ`;
    }

    case 'fb_report_new_users': {
      const newUserData = context.new_users_data as string || '';
      const castDisplayName = context.cast_display_name as string || context.cast_name as string || '';
      return `# 配信FBレポート — 新規チッパー分析エンジン

キャスト名: ${castDisplayName}

## データソースについて（絶対遵守）
以下のデータはSQL + ルールベースで収集した構造化データです。
- ユーザーリストは全員そのまま転記すること。1人も省略するな。
- [事実] タグ付きの数値は検証済み。

## 新規チッパーデータ
${newUserData}

## 分析指示
以下のセクションをMarkdownで出力してください:
1. 🆕 新規チッパー全体分析 — 人数・合計tk・平均tk・初回課金傾向
2. 💎 高額新規ユーザー分析 — 150tk以上の新規は何がきっかけで高額課金したか推測
3. 初回課金心理 — なぜ初めてチップしたのか（社会的証明、衝動、ticketshow参加）
4. 定着課題 — 新規→リピーターへの転換率改善提案
5. 初回フォロー提案 — 新規ユーザーへのDM文面案（感謝+次回来訪誘導）
6. 全新規チッパーリスト転記 — 全員のユーザー名・tk・回数をそのまま転記

- 心理分析には社会的証明、コミットメント一貫性の視点を含めること
- 高額新規（150tk以上）はVIP候補として特別DM提案すること
- 抽象的な提案禁止。具体的なDM文面例を含めること`;
    }

    case 'fb_report_repeaters': {
      const repeaterData = context.repeater_data as string || '';
      const castDisplayName = context.cast_display_name as string || context.cast_name as string || '';
      return `# 配信FBレポート — リピーター・復帰ユーザー分析エンジン

キャスト名: ${castDisplayName}

## データソースについて（絶対遵守）
以下のデータはSQL + ルールベースで収集した構造化データです。
- ユーザーリストは全員そのまま転記すること。1人も省略するな。
- [事実] タグ付きの数値は検証済み。

## リピーター・復帰ユーザーデータ
${repeaterData}

## 分析指示
以下のセクションをMarkdownで出力してください:
1. 🔄 リピーター分析 — 課金エスカレーションの心理変化、継続理由
2. 📈 課金増加ユーザー — サンクコスト効果の活用、感謝DM文面案
3. 📉 課金減少ユーザー — 離脱リスク評価、フォローDM文面案
4. 🔙 復帰ユーザー分析 — 復帰心理、きっかけ分析、復帰を促すDM文面提案
5. ⚠️ 離脱リスク評価 — 🚩離脱警告ユーザーを赤旗付きで最も目立つ形で表示
6. 全リピーター・復帰ユーザーリスト転記 — 全員のユーザー名・tk・回数・履歴をそのまま転記

- 心理分析にはサンクコスト効果、コミットメント一貫性、返報性の視点を含めること
- 🚩離脱警告ユーザーは赤旗付きで最も目立つ形で表示すること
- 課金減少ユーザーにはフォローDM、課金増加ユーザーには感謝DMの文面案を提案すること
- 抽象的な提案禁止。具体的なDM文面例を含めること`;
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
  - 「## #1 セッション間リテンション」— セッション別残存率
  - 「## #2 来訪間隔パターン」— 頻度帯別ユーザーリスト
  - 「## #3 課金エスカレーション」— 増加/減少/安定ユーザーリスト
  - 「## #4 課金タイプ変遷」— タイプ変更ユーザー + 全体構成変化
  - 「## #5 セッション別新規獲得率」— セッション別新規率推移
  - 「## #6 常連維持率」— セッション間維持率推移
  - 「## #7 チップ速度の時間カーブ」— 10分区間別tk推移
  - 「## #8 ticketshow突入タイミング」— CVR・タイミング分析
  - 「## viewer_stats時系列」「## ticketshow前後の視聴者変化」— データがある場合のみ
  - 「## #9 自社ファンの他社出現」— 他社に出現した自社ファン全員
  - 「## #10 他社のゴール設定パターン」— キャスト別ゴール設定
  - 「🔴 優先度A」「🟡 優先度B」「🟢 優先度C」— DM優先度リスト
  - 「🚩 離脱警告」— 累計高額→今回少額ユーザー
- 🚩離脱警告ユーザーは「## ⚠️ 離脱予兆アラート」セクションで赤旗🚩付きで最も目立つ形で表示すること
- DM施策は優先度A→B→C→離脱警告の順で提案すること
- 復帰フック分析（💡マーク付き）の情報は必ずレポートに含め、DM文面の提案にも反映すること
- 推測・解釈を書く場合は必ず「推測:」「分析:」と明示すること
- 改善提案は「次の配信で」実行可能な具体策のみ
- 抽象的な提案禁止（×「コミュニケーションを増やす」→ ○「配信開始10分以内にチャットで名前を3人呼ぶ」）
- DMだけでなく、配信構成・ゴール設定・コミュニケーション施策も提案すること
- 「安藤式7原則」「BYAF法」「購買心理3ルート」「サンクコスト効果」「社会的証明」「希少性原理」等のフレームワーク名・心理学用語を絶対に使うな。安藤自身の言葉で語れ。
- JSON出力禁止。Markdownのみ。`;
}

// ============================================================
// エージェント1: データコレクター（情報収集特化）
// LLMは使わない。SQL + ルールベースで構造化された事実データを作る。
// 「事実」と「未検証」を明確に分離して出力。
// ============================================================
export async function collect5AxisData(
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
    userBehavior: 'データなし',
    broadcastQuality: 'データなし',
    realtimeMetrics: 'データなし',
    crossCompetitor: 'データなし',
  };

  try {
    const _t = { start: Date.now(), last: Date.now() };
    const _mark = (label: string) => { const now = Date.now(); console.log(`[5axis][PERF] ${label}: ${now - _t.last}ms (total: ${now - _t.start}ms)`); _t.last = now; };

    // ── セッション一覧取得（基本データソース） ──
    const { data: sessions } = await sb.rpc('get_coin_sessions', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_limit: 5,
    });
    _mark('get_coin_sessions');

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

    _mark('session+tipper queries');
    // ── 新規/リピーター/復帰 分類（classifyTippers に委譲） ──
    const classified = await classifyTippers(sb, accountId, castName, sessionStartISO, allTippers);
    _mark('tipper history (classifyTippers)');

    // classifyTippersの戻り値からテキスト生成用の変数を構築
    const newTipperSet = new Set(classified.newTippers.map(t => t.username));
    const newTippersSorted = classified.newTippers.map(t => ({ username: t.username, total: t.tk, count: t.count }));
    const newTipperTotalTk = classified.newTippers.reduce((s, t) => s + t.tk, 0);
    const newTipperLines = classified.newTippers.map(t => `- ${t.username}: ${t.tk}tk (${t.count}回) ← 初チップ`);
    const highValueNewTippers = newTippersSorted.filter(t => t.total >= 150);
    const trueNewTippers = classified.newTippers.map(t => t.username);

    // 下流コード互換用のエイリアス
    const returningTippers = classified.repeaters.map(r => ({
      username: r.username, historyTokens: r.totalTk, historyTxCount: 0,
      firstTipDate: r.firstTipDate, lastTipDate: r.lastTipDate,
    }));
    const returningTippersSorted = classified.repeaters.map(r => ({ username: r.username, total: r.tk, count: 0 }));
    const returningLines = classified.repeaters.map((r, i) =>
      `${i + 1}. ${r.username}: ${r.tk}tk [初回${r.firstTipDate}, 累計${r.totalTk}tk, 前回${r.lastTipDate}, ${r.daysSince}日ぶり]`
    );

    const comebackUsers = classified.comebackUsers.map(u => ({
      username: u.username, lastTipDate: u.lastTipDate, daysSince: u.daysSince,
      sessionTk: u.tk,
    }));

    // ── 構造化データ（JSレポート生成用） ──
    result.structured = {
      sessionSummary: {
        totalTokens,
        txCount: latest.tx_count,
        durationMinutes: latest.duration_minutes,
        uniqueTipperCount,
        anonymousCount,
        anonymousTokens,
      },
      newTippers: classified.newTippers,
      repeaters: classified.repeaters,
      returnUsers: classified.comebackUsers,
      dmCopyNames: {
        newTippers: classified.newTippers.map(t => t.username),
        repeaters: classified.repeaters.map(r => r.username),
        returnUsers: classified.comebackUsers.map(u => u.username),
      },
    };

    // ── DM優先度分類 ──
    // 優先度A: 複数回チップの新規（本気度高い）
    const priorityA = newTippersSorted.filter(t => t.count >= 2);
    // 優先度B: 150tk固定の様子見新規（ticketshow参加=様子見）
    const priorityB = newTippersSorted.filter(t => t.count === 1 && t.total === 150);
    // 優先度C: 少額の新規（上記以外）
    const priorityC = newTippersSorted.filter(t => !priorityA.includes(t) && !priorityB.includes(t));

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

## リピーター（${classified.repeaters.length}人）
${returningLines.length > 0 ? returningLines.join('\n') : '(なし)'}

## 復帰ユーザー（30日以上ぶり: ${comebackUsers.length}人）
${comebackUsers.length > 0 ? comebackUsers.map(u => `- ${u.username}: ${u.daysSince}日ぶり（最終${u.lastTipDate}）→ 今回${u.sessionTk}tk`).join('\n') : '(なし)'}

## DM用ユーザー名リスト（優先度付き・コピペ用）

### 🔴 優先度A: 複数回チップ新規（${priorityA.length}人）— 本気度高い、即DM
${priorityA.length > 0 ? priorityA.map(t => `- ${t.username}: ${t.total}tk (${t.count}回)`).join('\n') : '(なし)'}
\`\`\`
${priorityA.map(t => t.username).join('\n') || '(なし)'}
\`\`\`

### 🟡 優先度B: 150tk様子見新規（${priorityB.length}人）— ticketshow参加=興味あり
${priorityB.length > 0 ? priorityB.map(t => `- ${t.username}: ${t.total}tk (${t.count}回)`).join('\n') : '(なし)'}
\`\`\`
${priorityB.map(t => t.username).join('\n') || '(なし)'}
\`\`\`

### 🟢 優先度C: 少額新規（${priorityC.length}人）
${priorityC.length > 0 ? priorityC.map(t => `- ${t.username}: ${t.total}tk (${t.count}回)`).join('\n') : '(なし)'}
\`\`\`
${priorityC.map(t => t.username).join('\n') || '(なし)'}
\`\`\`

### 復帰ユーザー（${comebackUsers.length}人）
\`\`\`
${dmCopyComeback || '(なし)'}
\`\`\`

### リピーター（${classified.repeaters.length}人）
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
    // セッション横断チッパーマップ（グループD・A共通）
    // ================================================================
    const sessionTipperMaps: Array<{ sessionIdx: number; start: string; end: string; tippers: Set<string> }> = [];

    // ================================================================
    // グループD: DM施策直結データ
    // #11 離脱予兆ユーザーリスト
    // #12 初回課金後2回目来訪率
    // #13 復帰ユーザーの復帰きっかけ
    // ================================================================
    try {

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

      _mark('Group D session history queries');
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
        for (const [name, count] of Array.from(attendanceCount.entries())) {
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

        // ticketshow復帰インサイト
        const tsCount = triggerSummary.get('ticketshow') || 0;
        const tsRatio = comebackUsers.length > 0 ? ((tsCount / comebackUsers.length) * 100).toFixed(0) : '0';
        const ticketshowInsight = tsCount > 0
          ? `\n\n💡 **復帰フック分析:** 復帰${comebackUsers.length}人中${tsCount}人(${tsRatio}%)がticketshowで復帰。ticketshowは復帰フックとして有効。ticketshow告知をDMに含めることで休眠ユーザーの復帰を促進できる可能性が高い。`
          : '';

        dmParts.push(`## #13 復帰ユーザーの復帰きっかけ（30日以上ぶり: ${comebackUsers.length}人）
[事実] 復帰きっかけ取引タイプ: ${triggerLines.join(', ')}

${comebackDetailLines.join('\n')}

[判定根拠] 最も金額が大きい取引タイプを「きっかけ」として判定（tip=投げ銭、ticketshow=チケット購入、photo=写真購入）${ticketshowInsight}`);
      }

      if (dmParts.length > 0) {
        result.dmActionLists = dmParts.join('\n\n');
      }
    } catch (groupDErr) {
      console.error('[5-Axis GroupD] Error:', groupDErr);
      result.dmActionLists = '[注意] グループDデータ収集でエラー発生';
    }

    // ================================================================
    // グループA: ユーザー行動データ
    // #1 セッション間リテンション
    // #2 来訪間隔パターン
    // #3 課金エスカレーション
    // #4 課金タイプ変遷
    // ================================================================
    try {
      const behaviorParts: string[] = [];

      // sessionTipperMapsが未構築の場合のフォールバック（Group Dでエラーが起きた場合）
      let sMaps = sessionTipperMaps;
      if (!sMaps || sMaps.length === 0) {
        // 最低限、最新セッションだけ
        sMaps = [{ sessionIdx: 0, start: sessionStartISO, end: sessionEndISO, tippers: new Set(allTipperNames) }];
      }

      _mark('Group D done');
      // ── #1 セッション間リテンション ──
      // セッションN → セッションN-1 のチッパー残存率
      if (sMaps.length >= 2) {
        const retentionLines: string[] = [];
        for (let i = sMaps.length - 1; i >= 1; i--) {
          const older = sMaps[i];
          const newer = sMaps[i - 1];
          const olderArr = Array.from(older.tippers);
          const retained = olderArr.filter(n => newer.tippers.has(n));
          const rate = olderArr.length > 0 ? ((retained.length / olderArr.length) * 100).toFixed(0) : 'N/A';
          retentionLines.push(
            `- ${older.start.slice(0, 10)} → ${newer.start.slice(0, 10)}: ${olderArr.length}人 → ${retained.length}人残存 (${rate}%)`
          );
        }

        // 平均リテンション率
        let totalRates = 0;
        let rateCount = 0;
        for (let i = sMaps.length - 1; i >= 1; i--) {
          const olderSize = sMaps[i].tippers.size;
          if (olderSize > 0) {
            const retainedN = Array.from(sMaps[i].tippers).filter(n => sMaps[i - 1].tippers.has(n)).length;
            totalRates += retainedN / olderSize;
            rateCount++;
          }
        }
        const avgRetention = rateCount > 0 ? ((totalRates / rateCount) * 100).toFixed(0) : 'N/A';

        behaviorParts.push(`## #1 セッション間リテンション
[事実] 平均チッパー残存率: ${avgRetention}%
${retentionLines.join('\n')}`);
      }

      // ── #2 来訪間隔パターン ──
      // リピーターの来訪頻度（何セッションに1回来るか）
      if (sMaps.length >= 3 && returningTippers.length > 0) {
        // 各リピーターが何セッションに出現したかカウント
        const visitorFreq = new Map<string, number>();
        for (const sm of sMaps) {
          for (const name of Array.from(sm.tippers)) {
            if (!newTipperSet.has(name)) {
              visitorFreq.set(name, (visitorFreq.get(name) || 0) + 1);
            }
          }
        }

        // 頻度帯別に分類
        const freqBands: Record<string, string[]> = {
          '毎回': [],       // sessions.length回
          '常連': [],       // 50%以上
          'たまに': [],     // 20-49%
          'まれ': [],       // 1-19%
        };

        for (const [name, count] of Array.from(visitorFreq.entries())) {
          const rate = count / sMaps.length;
          if (count === sMaps.length) freqBands['毎回'].push(name);
          else if (rate >= 0.5) freqBands['常連'].push(name);
          else if (rate >= 0.2) freqBands['たまに'].push(name);
          else freqBands['まれ'].push(name);
        }

        const freqLines = Object.entries(freqBands)
          .filter(([, users]) => users.length > 0)
          .map(([label, users]) => {
            const userList = users.slice(0, 10).join(', ');
            const more = users.length > 10 ? ` 他${users.length - 10}人` : '';
            return `- ${label}(${users.length}人): ${userList}${more}`;
          });

        behaviorParts.push(`## #2 来訪間隔パターン（直近${sMaps.length}セッション）
[事実] 来訪頻度帯:
${freqLines.join('\n')}

### DM用（毎回来る常連）
\`\`\`
${freqBands['毎回'].join('\n') || '(なし)'}
\`\`\`

### DM用（来訪減少=たまに+まれ）
\`\`\`
${[...freqBands['たまに'], ...freqBands['まれ']].join('\n') || '(なし)'}
\`\`\``);
      }

      // ── #3/#4 共通: 前回セッションのcoin_transactionsを1回で取得 ──
      const prevSession34 = sessions.length >= 2 ? sessions[1] : null;
      let sharedPrevTxRows: Array<{ user_name: string; tokens: number; type: string }> = [];
      if (prevSession34) {
        const { data: _prevRows } = await sb
          .from('coin_transactions')
          .select('user_name, tokens, type')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .gte('date', prevSession34.session_start as string)
          .lte('date', prevSession34.session_end as string)
          .gt('tokens', 0);
        sharedPrevTxRows = (_prevRows || []) as Array<{ user_name: string; tokens: number; type: string }>;
      }

      // ── #3 課金エスカレーション ──
      // リピーターの課金額変化（増加/減少/安定）
      if (sMaps.length >= 2 && returningTippers.length > 0) {
        // 各セッションのチッパー別tk取得（最新2セッション比較）
        const latestTippers = tipperMap; // 最新セッション（既に取得済み）

        // 1つ前のセッションのチッパー別tk（共通クエリ結果を使用）
        const prevTipperMap = new Map<string, number>();
        for (const row of sharedPrevTxRows) {
          const name = row.user_name || '';
          if (!name || name === 'anonymous') continue;
          prevTipperMap.set(name, (prevTipperMap.get(name) || 0) + row.tokens);
        }

        // 両セッションに出現するリピーターの変化
        const escalation: Array<{ username: string; prevTk: number; currTk: number; change: number; pct: string }> = [];
        for (const [name, currData] of Array.from(latestTippers.entries())) {
          const prevTk = prevTipperMap.get(name);
          if (prevTk !== undefined) {
            const change = currData.total - prevTk;
            const pct = prevTk > 0 ? ((change / prevTk) * 100).toFixed(0) : 'NEW';
            escalation.push({ username: name, prevTk, currTk: currData.total, change, pct });
          }
        }
        escalation.sort((a, b) => b.change - a.change);

        const increased = escalation.filter(e => e.change > 0);
        const decreased = escalation.filter(e => e.change < 0);
        const stable = escalation.filter(e => e.change === 0);

        const escLines: string[] = [];
        if (increased.length > 0) {
          escLines.push(`### 課金増加（${increased.length}人）`);
          escLines.push(...increased.map(e => `- ${e.username}: ${e.prevTk}tk → ${e.currTk}tk (+${e.change}tk, +${e.pct}%)`));
        }
        if (decreased.length > 0) {
          escLines.push(`### 課金減少（${decreased.length}人）`);
          escLines.push(...decreased.map(e => `- ${e.username}: ${e.prevTk}tk → ${e.currTk}tk (${e.change}tk, ${e.pct}%)`));
        }
        if (stable.length > 0) {
          escLines.push(`### 課金安定（${stable.length}人）: ${stable.map(e => e.username).join(', ')}`);
        }

        const decreasedDmCopy = decreased.map(e => e.username).join('\n');
        const increasedDmCopy = increased.map(e => e.username).join('\n');

        behaviorParts.push(`## #3 課金エスカレーション（前回→今回）
[事実] 継続チッパー${escalation.length}人中: 増加${increased.length}人 / 減少${decreased.length}人 / 安定${stable.length}人
${escLines.join('\n')}

### DM用（課金減少ユーザー=フォロー対象）
\`\`\`
${decreasedDmCopy || '(なし)'}
\`\`\`

### DM用（課金増加ユーザー=感謝DM対象）
\`\`\`
${increasedDmCopy || '(なし)'}
\`\`\``);
      }

      // ── #4 課金タイプ変遷 ──
      // リピーターの取引タイプが前回から変わったか
      if (sMaps.length >= 2) {
        // 前回のユーザー別メイン取引タイプ（共通クエリ結果を使用）
        const prevUserTypes = new Map<string, Map<string, number>>();
        for (const row of sharedPrevTxRows) {
          const name = row.user_name || '';
          if (!name || name === 'anonymous') continue;
          if (!prevUserTypes.has(name)) prevUserTypes.set(name, new Map());
          const typeMap2 = prevUserTypes.get(name)!;
          const t = ((row.type || 'unknown') as string).toLowerCase();
          typeMap2.set(t, (typeMap2.get(t) || 0) + row.tokens);
        }

        // 今回のユーザー別メイン取引タイプ（allTxRowsから）
        const currUserTypes = new Map<string, Map<string, number>>();
        for (const row of allTxRows || []) {
          const name = (row as { user_name: string }).user_name || '';
          if (!name || name === 'anonymous') continue;
          if (!currUserTypes.has(name)) currUserTypes.set(name, new Map());
          const typeMap2 = currUserTypes.get(name)!;
          const t = (((row as { type: string }).type || 'unknown') as string).toLowerCase();
          typeMap2.set(t, (typeMap2.get(t) || 0) + (row as { tokens: number }).tokens);
        }

        // 両セッションに出現するユーザーの変遷
        const typeChanges: Array<{ username: string; prevMain: string; currMain: string; changed: boolean }> = [];
        for (const [name, currTypes] of Array.from(currUserTypes.entries())) {
          const prevTypes = prevUserTypes.get(name);
          if (!prevTypes) continue;

          const getMain = (m: Map<string, number>) => {
            let maxType = 'unknown';
            let maxTk = 0;
            for (const [t, tk] of Array.from(m.entries())) {
              if (tk > maxTk) { maxTk = tk; maxType = t; }
            }
            return maxType;
          };

          const prevMain = getMain(prevTypes);
          const currMain = getMain(currTypes);
          typeChanges.push({ username: name, prevMain, currMain, changed: prevMain !== currMain });
        }

        const changed = typeChanges.filter(c => c.changed);
        const unchanged = typeChanges.filter(c => !c.changed);

        const changeLines = changed.map(c => `- ${c.username}: ${c.prevMain} → ${c.currMain}`);

        // タイプ全体の変遷サマリー
        const prevTypeTotal = new Map<string, number>();
        const currTypeTotal = new Map<string, number>();
        for (const [, types] of Array.from(prevUserTypes.entries())) {
          for (const [t, tk] of Array.from(types.entries())) prevTypeTotal.set(t, (prevTypeTotal.get(t) || 0) + tk);
        }
        for (const [, types] of Array.from(currUserTypes.entries())) {
          for (const [t, tk] of Array.from(types.entries())) currTypeTotal.set(t, (currTypeTotal.get(t) || 0) + tk);
        }

        const allTypes = new Set([...Array.from(prevTypeTotal.keys()), ...Array.from(currTypeTotal.keys())]);
        const typeSummaryLines = Array.from(allTypes).map(t => {
          const prev = prevTypeTotal.get(t) || 0;
          const curr = currTypeTotal.get(t) || 0;
          const diff = curr - prev;
          return `- ${t}: ${prev}tk → ${curr}tk (${diff >= 0 ? '+' : ''}${diff}tk)`;
        });

        behaviorParts.push(`## #4 課金タイプ変遷（前回→今回）
[事実] 継続ユーザー${typeChanges.length}人中: タイプ変更${changed.length}人 / 変更なし${unchanged.length}人
${changed.length > 0 ? `\n### タイプ変更ユーザー\n${changeLines.join('\n')}` : ''}

### 全体タイプ構成変化
${typeSummaryLines.join('\n')}`);
      }

      if (behaviorParts.length > 0) {
        result.userBehavior = behaviorParts.join('\n\n');
      }
    } catch (groupAErr) {
      console.error('[5-Axis GroupA] Error:', groupAErr);
      result.userBehavior = '[注意] グループAデータ収集でエラー発生';
    }

    // ================================================================
    // グループB: 配信品質測定
    // #5 セッション別新規獲得率の推移（直近10回）
    // #6 セッション別常連維持率
    // #7 チップ速度の時間カーブ比較
    // #8 ticketshow突入タイミングの最適化
    // ================================================================
    try {
      const qualityParts: string[] = [];

      _mark('Group A done');
      // ── #5 セッション別新規獲得率の推移 ──
      // 各セッションで全チッパーのうち何%が新規だったか
      if (sessionTipperMaps.length >= 2) {
        // セッションごとの新規率を算出（古い順に処理）
        const newRateBySession: Array<{ date: string; totalTippers: number; newCount: number; rate: string }> = [];

        // 全セッションの累積チッパーリストを古い順に積み上げ
        const cumulativeTippers = new Set<string>();
        for (let i = sessionTipperMaps.length - 1; i >= 0; i--) {
          const sm = sessionTipperMaps[i];
          const sessionArr = Array.from(sm.tippers);
          const newInSession = sessionArr.filter(n => !cumulativeTippers.has(n));
          const rate = sessionArr.length > 0 ? ((newInSession.length / sessionArr.length) * 100).toFixed(0) : '0';
          newRateBySession.push({
            date: sm.start.slice(0, 10),
            totalTippers: sessionArr.length,
            newCount: newInSession.length,
            rate,
          });
          // 累積に追加
          sessionArr.forEach(n => cumulativeTippers.add(n));
        }
        // 新しい順に反転
        newRateBySession.reverse();

        const rateLines = newRateBySession.map(r =>
          `- ${r.date}: ${r.totalTippers}人中${r.newCount}人新規 (${r.rate}%)`
        );

        // トレンド判定
        const rates = newRateBySession.map(r => parseFloat(r.rate));
        const firstHalf = rates.slice(0, Math.ceil(rates.length / 2));
        const secondHalf = rates.slice(Math.ceil(rates.length / 2));
        const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / Math.max(secondHalf.length, 1);
        const trend = avgSecond > avgFirst + 5 ? '上昇傾向（新規流入増）'
          : avgSecond < avgFirst - 5 ? '下降傾向（固定客化）'
          : '安定';

        qualityParts.push(`## #5 セッション別新規獲得率の推移（直近${sessionTipperMaps.length}回）
[事実] 新規獲得率トレンド: ${trend}
[判定根拠] 累積ベース: そのキャストへの初チップがそのセッション内の人を「新規」と判定
${rateLines.join('\n')}`);
      }

      // ── #6 セッション別常連維持率 ──
      // 「前回セッションにいたチッパーが今回も来たか」のセッション別推移
      if (sessionTipperMaps.length >= 2) {
        const retLines: string[] = [];
        for (let i = sessionTipperMaps.length - 1; i >= 1; i--) {
          const older = sessionTipperMaps[i];
          const newer = sessionTipperMaps[i - 1];
          const olderArr = Array.from(older.tippers);
          if (olderArr.length === 0) continue;
          const retained = olderArr.filter(n => newer.tippers.has(n));
          const lost = olderArr.filter(n => !newer.tippers.has(n));
          const rate = ((retained.length / olderArr.length) * 100).toFixed(0);
          retLines.push(`- ${older.start.slice(0, 10)} → ${newer.start.slice(0, 10)}: ${rate}% (${retained.length}/${olderArr.length}人継続, ${lost.length}人離脱)`);
        }

        qualityParts.push(`## #6 セッション別常連維持率（前回→今回の継続率）
${retLines.join('\n')}`);
      }

      // ── #7 チップ速度の時間カーブ比較（直近5セッション） ──
      // 各セッションを10分区間に分割し、区間別tkを算出
      {
        const curveN = Math.min(sessions.length, 5);

        // Promise.all で並列取得（逐次ループから並列化）
        const curveLines = await Promise.all(
          sessions.slice(0, curveN).map(async (sess: { session_start: string; session_end: string; duration_minutes: number }) => {
            const sStart = new Date(sess.session_start).getTime();
            const sEnd = new Date(sess.session_end).getTime();
            const durationMin = Math.max(sess.duration_minutes || 1, 1);

            const { data: curveTx } = await sb
              .from('coin_transactions')
              .select('tokens, date')
              .eq('account_id', accountId)
              .eq('cast_name', castName)
              .gte('date', sess.session_start)
              .lte('date', sess.session_end)
              .gt('tokens', 0);

            const INTERVAL_MS = 10 * 60 * 1000;
            const bucketCount = Math.max(Math.ceil((sEnd - sStart) / INTERVAL_MS), 1);
            const buckets = new Array(Math.min(bucketCount, 12)).fill(0);

            for (const tx of curveTx || []) {
              const txTime = new Date(tx.date as string).getTime();
              const bucketIdx = Math.min(Math.floor((txTime - sStart) / INTERVAL_MS), buckets.length - 1);
              if (bucketIdx >= 0) buckets[bucketIdx] += tx.tokens;
            }

            const bucketStr = buckets.map((tk: number, i: number) => `${i * 10}-${(i + 1) * 10}分:${tk}tk`).join(' | ');
            const sessionDate = sess.session_start.slice(0, 10);
            return `- ${sessionDate} (${durationMin}分): ${bucketStr}`;
          })
        );

        // ピーク区間の比較
        qualityParts.push(`## #7 チップ速度の時間カーブ（10分区間, 直近${curveN}回）
[判定根拠] 各セッションを10分区間に分割し、区間ごとのtk合計を算出
${curveLines.join('\n')}

[分析ヒント] 最初の10分でどれだけ稼げるかがセッション全体のtk量と相関。序盤が低い場合は開始直後のゴール設定やチャット盛り上げが課題`);
      }

      // ── #8 ticketshow突入タイミングの最適化 ──
      // セッション内のticketshowトランザクションの時間帯と参加者数
      {
        const tsN = Math.min(sessions.length, 10);

        // Promise.all で並列取得（逐次ループから並列化）
        const tsResults = await Promise.all(
          sessions.slice(0, tsN).map(async (sess: { session_start: string; session_end: string; total_tokens: number }, si: number) => {
            const sStart = new Date(sess.session_start).getTime();

            const { data: tsTx } = await sb
              .from('coin_transactions')
              .select('user_name, tokens, date')
              .eq('account_id', accountId)
              .eq('cast_name', castName)
              .eq('type', 'ticketshow')
              .gte('date', sess.session_start)
              .lte('date', sess.session_end)
              .gt('tokens', 0);

            if (!tsTx || tsTx.length === 0) return null;

            const tsDates = tsTx.map(t => new Date(t.date as string).getTime()).sort((a, b) => a - b);
            const tsStartTime = tsDates[0];
            const minuteIn = Math.round((tsStartTime - sStart) / 60000);
            const tsTk = tsTx.reduce((s, t) => s + (t.tokens || 0), 0);
            const tsUserSet = new Set(tsTx.map(t => t.user_name).filter(Boolean));
            const totalTippers = sessionTipperMaps[si]?.tippers.size || 0;

            return {
              date: sess.session_start.slice(0, 10),
              minuteIn,
              tsTk,
              tsUsers: tsUserSet.size,
              totalSessionTk: sess.total_tokens || 0,
              tsRatio: sess.total_tokens > 0 ? ((tsTk / sess.total_tokens) * 100).toFixed(0) : '0',
              totalTippers,
            };
          })
        );
        const tsAnalysis = tsResults.filter((r): r is NonNullable<typeof r> => r !== null);

        if (tsAnalysis.length > 0) {
          const tsLines = tsAnalysis.map(t =>
            `- ${t.date}: 開始${t.minuteIn}分後, ${t.tsUsers}人参加/${t.totalTippers}人中 (CVR ${t.totalTippers > 0 ? ((t.tsUsers / t.totalTippers) * 100).toFixed(0) : '0'}%), ${t.tsTk}tk (セッションの${t.tsRatio}%)`
          );

          // 最適タイミング分析: CVRが最も高かったセッション
          const withCvr = tsAnalysis
            .filter(t => t.totalTippers > 0)
            .map(t => ({ ...t, cvr: t.tsUsers / t.totalTippers }));
          withCvr.sort((a, b) => b.cvr - a.cvr);
          const bestSession = withCvr[0];
          const avgMinuteIn = Math.round(tsAnalysis.reduce((s, t) => s + t.minuteIn, 0) / tsAnalysis.length);

          qualityParts.push(`## #8 ticketshow突入タイミングの最適化（直近${tsAnalysis.length}セッション）
[事実] ticketshow実施セッション: ${tsAnalysis.length}回
[事実] 平均突入タイミング: 配信開始${avgMinuteIn}分後
${bestSession ? `[事実] 最高CVRセッション: ${bestSession.date} (開始${bestSession.minuteIn}分後, CVR ${(bestSession.cvr * 100).toFixed(0)}%, ${bestSession.tsTk}tk)` : ''}

${tsLines.join('\n')}

[分析ヒント] ticketshowはコイン持ちユーザーが十分集まってから突入すべき。早すぎると未課金ユーザーが多く低CVR`);
        } else {
          qualityParts.push(`## #8 ticketshow突入タイミング
[注意] 直近${tsN}セッションにticketshowデータなし`);
        }
      }

      if (qualityParts.length > 0) {
        result.broadcastQuality = qualityParts.join('\n\n');
      }
    } catch (groupBErr) {
      console.error('[5-Axis GroupB] Error:', groupBErr);
      result.broadcastQuality = '[注意] グループBデータ収集でエラー発生';
    }

    // ================================================================
    // グループE: リアルタイム推移（viewer_stats時系列）
    // viewer_stats: total, coin_users, others, coin_holders の推移
    // ゴール前後・ticketshow前後の視聴者変化
    // ================================================================
    try {
      const rtParts: string[] = [];

      // viewer_statsからこのキャストの最新セッション内データを取得
      const { data: vsRows } = await sb
        .from('viewer_stats')
        .select('total, coin_users, others, coin_holders, ultimate_count, others_count, recorded_at')
        .eq('cast_name', castName)
        .gte('recorded_at', sessionStartISO)
        .lte('recorded_at', sessionEndISO)
        .order('recorded_at', { ascending: true });

      if (vsRows && vsRows.length >= 2) {
        // 時系列データあり
        const vsLines = vsRows.map(r => {
          const time = (r.recorded_at as string).slice(11, 19);
          return `${time}: total=${r.total} coin_users=${r.coin_users} coin_holders=${r.coin_holders || 0} others=${r.others}`;
        });

        // ピーク・ボトム
        const totals = vsRows.map(r => r.total as number);
        const peakTotal = Math.max(...totals);
        const bottomTotal = Math.min(...totals);
        const coinPeak = Math.max(...vsRows.map(r => (r.coin_users as number) || 0));

        rtParts.push(`## viewer_stats時系列（${vsRows.length}ポイント）
[事実] ピーク視聴者: ${peakTotal}人 / ボトム: ${bottomTotal}人
[事実] コインユーザーピーク: ${coinPeak}人

--- 時系列データ ---
${vsLines.join('\n')}`);

        // ゴールイベントとの突合（spy_messagesからgoalイベントが取得済みなら）
        // ticketshow突入タイミングとの突合
        const { data: tsFirstTx } = await sb
          .from('coin_transactions')
          .select('date')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .eq('type', 'ticketshow')
          .gte('date', sessionStartISO)
          .lte('date', sessionEndISO)
          .gt('tokens', 0)
          .order('date', { ascending: true })
          .limit(1);

        if (tsFirstTx && tsFirstTx.length > 0) {
          const tsTime = new Date(tsFirstTx[0].date as string).getTime();
          // tsTime直前と直後のviewer_statsを見つける
          let beforeVs = vsRows[0];
          let afterVs = vsRows[vsRows.length - 1];
          for (let i = 0; i < vsRows.length; i++) {
            const vsTime = new Date(vsRows[i].recorded_at as string).getTime();
            if (vsTime <= tsTime) beforeVs = vsRows[i];
            if (vsTime > tsTime && i > 0) { afterVs = vsRows[i]; break; }
          }

          rtParts.push(`## ticketshow前後の視聴者変化
[事実] ticketshow開始: ${(tsFirstTx[0].date as string).slice(11, 19)}
[事実] 直前: total=${beforeVs.total} coin_users=${beforeVs.coin_users} coin_holders=${beforeVs.coin_holders || 0}
[事実] 直後: total=${afterVs.total} coin_users=${afterVs.coin_users} coin_holders=${afterVs.coin_holders || 0}
[判定根拠] ticketshow開始時刻の直前・直後のviewer_statsスナップショットを比較`);
        }
      } else {
        // viewer_statsデータなし — 過去セッション全体を確認
        const { data: allVs } = await sb
          .from('viewer_stats')
          .select('cast_name, recorded_at, total, coin_users')
          .eq('cast_name', castName)
          .order('recorded_at', { ascending: false })
          .limit(5);

        if (allVs && allVs.length > 0) {
          const vsInfo = allVs.map(r => `${(r.recorded_at as string).slice(0, 16)}: total=${r.total} coin=${r.coin_users}`).join('\n');
          rtParts.push(`## viewer_stats時系列
[注意] 最新セッション内のviewer_statsデータなし（spy collector停止の可能性）
[事実] 最新の利用可能データ:
${vsInfo}`);
        } else {
          rtParts.push(`## viewer_stats時系列
[注意] このキャストのviewer_statsデータなし。spy collectorが停止している可能性が高い。
→ pm2でviewer_stats収集プロセスを再起動する必要あり`);
        }

        // viewer_statsなしでもcoin_transactionsからticketshowタイミング分析は可能
        // セッション内の取引を時系列で分析し、ticketshow前後のチップ流入変化を算出
        const { data: sessionTxTimeline } = await sb
          .from('coin_transactions')
          .select('user_name, tokens, type, date')
          .eq('account_id', accountId)
          .eq('cast_name', castName)
          .gte('date', sessionStartISO)
          .lte('date', sessionEndISO)
          .gt('tokens', 0)
          .order('date', { ascending: true });

        if (sessionTxTimeline && sessionTxTimeline.length > 0) {
          // ticketshow最初のトランザクション
          const firstTs = sessionTxTimeline.find(t => ((t.type as string) || '').toLowerCase() === 'ticketshow');
          if (firstTs) {
            const tsTime = new Date(firstTs.date as string).getTime();
            const sStart = new Date(sessionStartISO).getTime();

            // ticketshow前後のチッパー数とtk比較
            const beforeTs = sessionTxTimeline.filter(t => new Date(t.date as string).getTime() < tsTime);
            const afterTs = sessionTxTimeline.filter(t => new Date(t.date as string).getTime() >= tsTime);

            const beforeUsers = new Set(beforeTs.map(t => t.user_name).filter(Boolean));
            const afterUsers = new Set(afterTs.map(t => t.user_name).filter(Boolean));
            const beforeTk = beforeTs.reduce((s, t) => s + (t.tokens || 0), 0);
            const afterTk = afterTs.reduce((s, t) => s + (t.tokens || 0), 0);
            const tsMins = Math.round((tsTime - sStart) / 60000);

            // ticketshow参加者でticketsshow前にtipしていた人
            const tsParticipants = afterTs.filter(t => ((t.type as string) || '').toLowerCase() === 'ticketshow');
            const tsUserNames = new Set(tsParticipants.map(t => t.user_name).filter(Boolean));
            const preWarmedUsers = Array.from(tsUserNames).filter(n => beforeUsers.has(n as string));

            rtParts.push(`## ticketshow前後のチップ流入分析（coin_transactionsベース）
[事実] ticketshow突入: 配信開始${tsMins}分後
[事実] ticketshow前: ${beforeUsers.size}人/${beforeTk}tk
[事実] ticketshow後（含ts）: ${afterUsers.size}人/${afterTk}tk
[事実] ticketshow参加者: ${tsUserNames.size}人（うち事前チップあり: ${preWarmedUsers.length}人）
[判定根拠] ticketshow前にtipしていたユーザー=「温まっていたユーザー」として、ticketshow突入前のウォームアップ効果を測定

### ticketshow参加者（DM用）
\`\`\`
${Array.from(tsUserNames).join('\n') || '(なし)'}
\`\`\`

### ticketshow前にチップ済み→ticketshow購入者（ウォームアップ成功）
\`\`\`
${preWarmedUsers.join('\n') || '(なし)'}
\`\`\``);
          }
        }
      }

      if (rtParts.length > 0) {
        result.realtimeMetrics = rtParts.join('\n\n');
      }
    } catch (groupEErr) {
      console.error('[5-Axis GroupE] Error:', groupEErr);
      result.realtimeMetrics = '[注意] グループEデータ収集でエラー発生';
    }

    // ================================================================
    // グループC: 他社突合
    // #9 自社ファンの他社出現（chat_logsで自社usernameが他社cast_nameに出現）
    // #10 他社のゴール設定パターン（spy_messages WHERE msg_type='goal'をキャスト別に集計）
    // ================================================================
    try {
      const crossParts: string[] = [];

      _mark('Group B+E done');
      // ── #9 自社ファンの他社出現 ──
      // 自社のチッパー（今回+リピーター）が他社キャストのchat_logsに出現しているか
      if (allTipperNames.length > 0) {
        // 自社ファン名リスト（全チッパー + 過去のリピーター）
        const fanNames = Array.from(new Set([...allTipperNames, ...returningTippers.map(r => r.username)]));

        // chat_logsで自社以外のcast_nameに出現するファンを検索
        // バッチで50人ずつ処理（IN句のサイズ制限回避）
        const crossAppearances: Array<{
          username: string; otherCast: string; lastSeen: string; msgCount: number;
        }> = [];

        const BATCH_SIZE = 50;
        for (let bi = 0; bi < fanNames.length; bi += BATCH_SIZE) {
          const batch = fanNames.slice(bi, bi + BATCH_SIZE);
          const { data: crossRows } = await sb
            .from('chat_logs')
            .select('username, cast_name, timestamp')
            .in('username', batch)
            .neq('cast_name', castName)
            .order('timestamp', { ascending: false })
            .limit(500);

          if (crossRows && crossRows.length > 0) {
            // ユーザー×キャスト別に集計
            const crossMap = new Map<string, { otherCast: string; lastSeen: string; count: number }>();
            for (const row of crossRows) {
              const key = `${row.username}__${row.cast_name}`;
              const existing = crossMap.get(key);
              if (existing) {
                existing.count++;
              } else {
                crossMap.set(key, {
                  otherCast: row.cast_name,
                  lastSeen: (row.timestamp as string).slice(0, 16),
                  count: 1,
                });
              }
            }
            for (const [key, data] of Array.from(crossMap.entries())) {
              const username = key.split('__')[0];
              crossAppearances.push({
                username,
                otherCast: data.otherCast,
                lastSeen: data.lastSeen,
                msgCount: data.count,
              });
            }
          }
        }

        // spy_messagesでもフォールバック検索（chat_logsにデータがない場合）
        if (crossAppearances.length === 0) {
          for (let bi = 0; bi < fanNames.length; bi += BATCH_SIZE) {
            const batch = fanNames.slice(bi, bi + BATCH_SIZE);
            const { data: spyCrossRows } = await sb
              .from('spy_messages')
              .select('user_name, cast_name, message_time')
              .in('user_name', batch)
              .neq('cast_name', castName)
              .eq('msg_type', 'chat')
              .order('message_time', { ascending: false })
              .limit(500);

            if (spyCrossRows && spyCrossRows.length > 0) {
              const crossMap = new Map<string, { otherCast: string; lastSeen: string; count: number }>();
              for (const row of spyCrossRows) {
                const key = `${row.user_name}__${row.cast_name}`;
                const existing = crossMap.get(key);
                if (existing) {
                  existing.count++;
                } else {
                  crossMap.set(key, {
                    otherCast: row.cast_name,
                    lastSeen: (row.message_time as string).slice(0, 16),
                    count: 1,
                  });
                }
              }
              for (const [key, data] of Array.from(crossMap.entries())) {
                const username = key.split('__')[0];
                crossAppearances.push({
                  username,
                  otherCast: data.otherCast,
                  lastSeen: data.lastSeen,
                  msgCount: data.count,
                });
              }
            }
          }
        }

        if (crossAppearances.length > 0) {
          // ユーザー別にまとめて表示
          const byUser = new Map<string, Array<{ otherCast: string; lastSeen: string; msgCount: number }>>();
          for (const ca of crossAppearances) {
            const arr = byUser.get(ca.username) || [];
            arr.push({ otherCast: ca.otherCast, lastSeen: ca.lastSeen, msgCount: ca.msgCount });
            byUser.set(ca.username, arr);
          }

          const crossLines = Array.from(byUser.entries())
            .sort((a, b) => b[1].reduce((s, c) => s + c.msgCount, 0) - a[1].reduce((s, c) => s + c.msgCount, 0))
            .slice(0, 20) // 上位20人に限定
            .map(([username, casts]) => {
              const castStr = casts
                .sort((a, b) => b.msgCount - a.msgCount)
                .map(c => `${c.otherCast}(${c.msgCount}msg, 最終${c.lastSeen})`)
                .join(', ');
              return `- ${username}: ${castStr}`;
            });

          // 他社キャスト別の自社ファン出現数
          const byCast = new Map<string, number>();
          for (const ca of crossAppearances) {
            byCast.set(ca.otherCast, (byCast.get(ca.otherCast) || 0) + 1);
          }
          const castRankLines = Array.from(byCast.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([cast, count]) => `- ${cast}: 自社ファン${count}人が出現`);

          crossParts.push(`## #9 自社ファンの他社出現（${byUser.size}人が他社で確認）
[事実] 自社チッパー${fanNames.length}人中${byUser.size}人が他社キャストの配信に出現
[判定根拠] chat_logs/spy_messagesで自社usernameが他社cast_nameに出現した記録を検索

### 他社に出現した自社ファン（上位20人）
${crossLines.join('\n')}

### 自社ファンが多く出現している他社キャスト
${castRankLines.join('\n')}

[分析ヒント] 自社ファンが他社に出現する時間帯=自社が配信していない時間帯の可能性。配信スケジュール調整の参考に`);
        } else {
          crossParts.push(`## #9 自社ファンの他社出現
[注意] chat_logs/spy_messagesに他社配信での自社ファン出現データなし（spy collector停止 or データ不足の可能性）`);
        }
      }

      // ── #10 他社のゴール設定パターン ──
      // spy_messages WHERE msg_type='goal' をキャスト別に集計
      {
        const { data: goalRows } = await sb
          .from('spy_messages')
          .select('cast_name, message, tokens, message_time')
          .eq('msg_type', 'goal')
          .neq('cast_name', castName)
          .order('message_time', { ascending: false })
          .limit(1000);

        if (goalRows && goalRows.length > 0) {
          // キャスト別に集計
          const goalByCast = new Map<string, Array<{ message: string; tokens: number; time: string }>>();
          for (const row of goalRows) {
            const cast = row.cast_name;
            const arr = goalByCast.get(cast) || [];
            arr.push({
              message: row.message || '',
              tokens: row.tokens || 0,
              time: (row.message_time as string).slice(0, 16),
            });
            goalByCast.set(cast, arr);
          }

          const goalSummaryLines = Array.from(goalByCast.entries())
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 10) // 上位10キャスト
            .map(([cast, goals]) => {
              const avgTokens = goals.reduce((s, g) => s + g.tokens, 0) / Math.max(goals.length, 1);
              // 最頻出のゴール金額帯
              const tokenBuckets = new Map<string, number>();
              for (const g of goals) {
                const bucket = g.tokens <= 100 ? '~100' : g.tokens <= 300 ? '101-300' : g.tokens <= 500 ? '301-500' : '500+';
                tokenBuckets.set(bucket, (tokenBuckets.get(bucket) || 0) + 1);
              }
              const topBucket = Array.from(tokenBuckets.entries()).sort((a, b) => b[1] - a[1])[0];
              return `- ${cast}: ${goals.length}回のゴール設定, 平均${Math.round(avgTokens)}tk, 最頻価格帯: ${topBucket?.[0] || 'N/A'}(${topBucket?.[1] || 0}回)`;
            });

          crossParts.push(`## #10 他社のゴール設定パターン（${goalByCast.size}キャスト, ${goalRows.length}件）
[事実] spy_messagesのgoalイベントから他社キャストのゴール設定を集計
[判定根拠] msg_type='goal'のレコードをキャスト別に集計し、ゴール金額帯・回数を分析

### キャスト別ゴール設定（上位10）
${goalSummaryLines.join('\n')}

[分析ヒント] 他社の成功パターン（ゴール金額×達成頻度）を参考に自社のゴール設定を最適化`);
        } else {
          crossParts.push(`## #10 他社のゴール設定パターン
[注意] spy_messagesにgoalイベントデータなし（spy collector停止 or ゴール設定データ未収集）`);
        }
      }

      if (crossParts.length > 0) {
        result.crossCompetitor = crossParts.join('\n\n');
      }
    } catch (groupCErr) {
      console.error('[5-Axis GroupC] Error:', groupCErr);
      result.crossCompetitor = '[注意] グループCデータ収集でエラー発生';
    }

    _mark('ALL DONE');
    return result;
  } catch (err) {
    console.error('[5-Axis] Error collecting data:', err);
    return result;
  }
}

// ============================================================
// Layer A 選択
// ============================================================

/** cast_knowledge から marketer_persona_source テキストを取得 */
async function fetchMarketerPersonaSources(token: string): Promise<string | null> {
  try {
    const sb = getAuthClient(token);
    // monthly (最新3件) + method (2件) + experience/ふみ (1件) = 最大6件
    const [monthlyRes, methodRes, fumiRes] = await Promise.all([
      sb.from('cast_knowledge')
        .select('insights_json, metrics_json')
        .eq('knowledge_type', 'marketer_persona_source')
        .eq('report_type', 'post_session')
        .filter('metrics_json->>category', 'eq', 'monthly')
        .filter('metrics_json->>author', 'eq', '安藤')
        .order('period_start', { ascending: false })
        .limit(3),
      sb.from('cast_knowledge')
        .select('insights_json, metrics_json')
        .eq('knowledge_type', 'marketer_persona_source')
        .eq('report_type', 'post_session')
        .filter('metrics_json->>category', 'eq', 'method')
        .filter('metrics_json->>author', 'eq', '安藤')
        .order('period_start', { ascending: false })
        .limit(2),
      sb.from('cast_knowledge')
        .select('insights_json, metrics_json')
        .eq('knowledge_type', 'marketer_persona_source')
        .eq('report_type', 'post_session')
        .filter('metrics_json->>author', 'eq', 'ふみ')
        .order('period_start', { ascending: false })
        .limit(1),
    ]);

    const allRows = [
      ...(monthlyRes.data || []),
      ...(methodRes.data || []),
      ...(fumiRes.data || []),
    ];
    if (allRows.length === 0) return null;

    const sections: string[] = [];
    for (const row of allRows) {
      const meta = row.metrics_json as { author?: string; category?: string; source_file?: string };
      const content = (row.insights_json as { content?: string })?.content;
      if (!content) continue;
      const label = meta.author === 'ふみ'
        ? `【ふみの体験記】${meta.source_file || ''}`
        : `【安藤/${meta.category || ''}】${meta.source_file || ''}`;
      // 1件あたり最大8000文字に制限（6件×8000=48000文字以内）
      sections.push(`--- ${label} ---\n${content.slice(0, 8000)}`);
    }
    return sections.join('\n\n');
  } catch (e) {
    console.error('[fetchMarketerPersonaSources] error:', e);
    return null;
  }
}

/** 安藤人格シミュレーション型 Layer A を構築 */
function buildMarketerPersonaLayerA(sourceTexts: string): string {
  return `あなたのチームには「安藤」というマーケターがいます。

安藤は、ファンクラブ運営・ファンマーケティングの実践者です。
以下は安藤が実際に書いた文章です。この文章に表れている考え方、価値観、物事の見方で意見を述べてください。

重要なルール:
- 「7原則」「BYAF法」「社会的証明」「サンクコスト効果」などのフレームワーク名や心理学用語を使うな
- 安藤自身の言葉で、安藤の考え方で語れ
- 教科書的な提案ではなく、安藤だったらどうするかを考えろ

安藤の弟子に「ふみ」がいます。ふみの体験記も参照し、実践者の視点を加えてください。

=== 安藤・ふみ 参照テキスト ===
${sourceTexts}`;
}

function selectLayerA(taskType: EngineTaskType, personaBase: string | null): string {
  if (taskType === 'recruitment') return LAYER_A_PRINCESS_MARKETING;
  return personaBase || LAYER_A_ANDO_FOUNDATION;
}

/** fb_report系用: 人格シミュレーション版 Layer A（ソース取得済みならそれを使う） */
function selectLayerAForFbReport(marketerSources: string | null, personaBase: string | null): string {
  if (marketerSources) {
    console.log('[selectLayerAForFbReport] marketerSources取得成功 → buildMarketerPersonaLayerA使用');
    return buildMarketerPersonaLayerA(marketerSources);
  }
  // フォールバック: 従来版
  console.log('[selectLayerAForFbReport] marketerSourcesなし → フォールバック:', personaBase ? 'personaBase' : 'LAYER_A_ANDO_FOUNDATION');
  return personaBase || LAYER_A_ANDO_FOUNDATION;
}

// ============================================================
// POST /api/persona/engine
// ============================================================
export async function POST(req: NextRequest) {
  const body = await req.json() as EngineRequest;
  const { task_type, cast_name, account_id: reqAccountId, context, user_prompt: prebuiltUserPrompt } = body;

  // バリデーション
  if (!task_type || !cast_name) {
    return NextResponse.json({ error: 'task_type と cast_name は必須です' }, { status: 400 });
  }
  const FB_REPORT_TYPES = ['fb_report', 'fb_report_analysis', 'fb_report_new_users', 'fb_report_repeaters'] as const;
  if (!ENGINE_LAYER_C[task_type] && !FB_REPORT_TYPES.includes(task_type as typeof FB_REPORT_TYPES[number])) {
    return NextResponse.json(
      { error: `未対応のtask_type: ${task_type}。対応: dm, x_post, recruitment, content, fb_report, fb_report_analysis, fb_report_new_users, fb_report_repeaters` },
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
      .from('cast_persona')
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

    // ── fb_report系: 5軸データ収集 + agent_profiles から動的 Layer C ──
    const isFbReport = FB_REPORT_TYPES.includes(task_type as typeof FB_REPORT_TYPES[number]);
    let fiveAxisData: FiveAxisData | undefined;
    let dynamicLayerC = '';
    if (isFbReport) {
      if (task_type === 'fb_report' && !prebuiltUserPrompt) {
        // 従来互換: collect5AxisData を実行（1リクエストモード）
        const effectiveAccountId = reqAccountId || (auth.accountIds?.[0]) || '';
        const t0 = Date.now();
        fiveAxisData = await collect5AxisData(auth.token, cast_name, effectiveAccountId, context);
        const t1 = Date.now();
        console.log(`[fb_report][PERF] collect5AxisData: ${t1 - t0}ms`);
        console.log('[fb_report] 5-Axis tipperStructure:', fiveAxisData.tipperStructure?.slice(0, 500));
        console.log('[fb_report] 5-Axis chatTemperature:', fiveAxisData.chatTemperature?.slice(0, 200));
      } else {
        // 3エンジン分離 or 2リクエスト分離: データ収集スキップ
        console.log(`[${task_type}] using prebuilt user_prompt, skipping collect5AxisData`);
      }
      const agents = await fetchAgentProfiles(auth.token);
      if (task_type === 'fb_report_analysis') {
        // 分析エンジン用: 簡潔な分析指示
        dynamicLayerC = agents.length > 0
          ? buildFbReportLayerC(agents) + '\n\n## 注意: このエンジンはデータ分析専用です。ユーザーリストの全件転記は不要です。集計数字に基づく分析・提案のみ出力してください。'
          : '配信データの分析レポートを生成してください。Markdown形式で出力。';
      } else if (task_type === 'fb_report_new_users') {
        // 新規チッパー分析エンジン用
        dynamicLayerC = `=== 新規チッパー心理分析エンジン ===

あなたはライブ配信の新規ユーザー獲得・定着の専門家です。
以下の心理学的フレームワークで新規チッパーを分析してください:

1. 社会的証明 — 他のファンの行動が新規ファンの初回課金を後押しする
2. コミットメント一貫性 — 初回課金が2回目以降の課金を促す。最初の一歩が重要
3. 返報性 — キャストからの個別対応（DM等）が初回課金者の定着を促進する
4. 希少性 — ticketshow等の限定体験が初回課金のきっかけになる

## 出力ルール
- ユーザーリストは全員のユーザー名・数値をそのまま転記すること。1人も省略するな
- 心理分析は具体的に（×「初回課金が多い」→ ○「67人中15人がticketshow経由で初課金、社会的証明効果が強い」）
- Markdown形式で出力`;
      } else if (task_type === 'fb_report_repeaters') {
        // リピーター・復帰ユーザー分析エンジン用
        dynamicLayerC = `=== リピーター・復帰ユーザー心理分析エンジン ===

あなたはライブ配信の継続ファン・離脱防止の専門家です。
以下の心理学的フレームワークでリピーター・復帰ユーザーを分析してください:

1. サンクコスト効果 — 累計課金額が大きいほど離脱しにくい。この効果が薄れるサインを見つけること
2. コミットメント一貫性 — 継続課金のパターンが崩れる時が離脱の兆候
3. 返報性 — キャストからの個別対応（DM等）が継続を強化する
4. 希少性 — ticketshow告知が復帰きっかけになりうる

## 出力ルール
- ユーザーリストは全員のユーザー名・数値をそのまま転記すること。1人も省略するな
- 心理分析は具体的に（×「関係性が深い」→ ○「累計3159tk・11回参加でサンクコスト効果が強く働いている」）
- 🚩離脱警告は最も目立つ形で表示すること
- Markdown形式で出力`;
      } else {
        dynamicLayerC = agents.length > 0
          ? buildFbReportLayerC(agents)
          : '配信FBレポートを生成してください。Markdown形式で出力。';
      }
    }

    // ── Layer A 選択 ──
    let layerA: string;
    if (isFbReport) {
      const marketerSources = await fetchMarketerPersonaSources(auth.token);
      layerA = selectLayerAForFbReport(marketerSources, activePersona.system_prompt_base);
    } else {
      layerA = selectLayerA(task_type, activePersona.system_prompt_base);
    }

    // ── Layer B: タスク別分岐 ──
    const layerB = task_type === 'recruitment'
      ? `=== あなたの役割 ===\nライブ配信エージェンシーの採用マーケター。\n温かく、共感的で、押しつけがましくない。\n「この人なら相談できそう」と思わせるトーン。`
      : task_type === 'fb_report' || task_type === 'fb_report_analysis'
      ? `=== あなたの役割 ===\nライブ配信の配信FBレポートを生成する4人のエージェントチーム。\nキャスト「${activePersona.display_name || cast_name}」の配信データを分析し、具体的な改善策を提案する。`
      : task_type === 'fb_report_new_users'
      ? `=== あなたの役割 ===\nライブ配信の新規ユーザー獲得・定着の専門家。\nキャスト「${activePersona.display_name || cast_name}」の新規チッパーの行動パターンを分析し、定着施策を提案する。`
      : task_type === 'fb_report_repeaters'
      ? `=== あなたの役割 ===\nライブ配信の継続ファン・離脱防止の専門家。\nキャスト「${activePersona.display_name || cast_name}」のリピーター・復帰ユーザーの心理変化を分析し、離脱防止施策を提案する。`
      : buildLayerB(activePersona, detail);

    // ── System Prompt 組み立て: Layer A + B + RAG + Feedback + Context + C ──
    const layerC = isFbReport ? dynamicLayerC : ENGINE_LAYER_C[task_type];
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

    // ── User Prompt（fb_report系 は5軸データ or 分割データをcontextに注入） ──
    let userPrompt: string;
    if (task_type === 'fb_report' && prebuiltUserPrompt) {
      // 2リクエスト分離: Step2 — フロントから渡されたプロンプトをそのまま使用
      userPrompt = prebuiltUserPrompt;
    } else if (task_type === 'fb_report_analysis' || task_type === 'fb_report_new_users' || task_type === 'fb_report_repeaters') {
      // 4エンジン分離: フロントから渡されたuser_promptをそのまま使用
      userPrompt = prebuiltUserPrompt || buildUserPrompt(task_type, context || {});
    } else {
      const effectiveContext = task_type === 'fb_report'
        ? { ...context, five_axis: fiveAxisData, cast_name }
        : context || {};
      userPrompt = buildUserPrompt(task_type, effectiveContext);
    }

    // ── API 呼び出し（fb_report系 は長い出力が必要） ──
    const maxTokens = task_type === 'dm' ? 500 : isFbReport ? 4000 : 1000;
    const tLlm0 = Date.now();
    const result = await callClaude(systemPrompt, userPrompt, maxTokens);
    const tLlm1 = Date.now();
    console.log(`[${task_type}][PERF] callClaude: ${tLlm1 - tLlm0}ms (tokens: ${result.tokensUsed})`);

    // ── レスポンス処理（fb_report系 はMarkdown、それ以外はJSON） ──
    if (isFbReport) {
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
        agents_used: task_type === 'fb_report' ? 4 : (task_type === 'fb_report_analysis' ? 4 : 1),
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
