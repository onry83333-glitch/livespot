/**
 * llm-client.ts — LLM API クライアント（Anthropic Claude / OpenAI）
 *
 * - ANTHROPIC_API_KEY があれば Claude claude-haiku-4-5-20251001 を使用（安価・高速）
 * - OPENAI_API_KEY があれば gpt-4o-mini を使用
 * - どちらもなければ null を返し、呼び出し元がルールベースにフォールバック
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('llm');

// ============================================================
// Types
// ============================================================

export interface TipperAnalysis {
  username: string;
  amount: number;
  motivation: string;
  pattern: string;
  recommendation: string;
}

export interface SessionInsights {
  tipper_analysis: TipperAnalysis[];
  session_summary: string;
  next_session_tips: string[];
}

interface LlmPromptContext {
  castName: string;
  sessionDurationMinutes: number;
  totalTips: number;
  tipCount: number;
  topTippers: { username: string; amount: number; count: number }[];
  tipTimings: { username: string; minuteFromStart: number; amount: number }[];
  segmentMap: Record<string, string>;
  recentChats: { username: string; message: string; minuteFromStart: number }[];
  tipHistory: { username: string; totalPast30d: number; txCount: number }[];
}

// ============================================================
// Provider detection
// ============================================================

type Provider = 'anthropic' | 'openai' | null;

function detectProvider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

// ============================================================
// Prompt construction
// ============================================================

function buildPrompt(ctx: LlmPromptContext): string {
  const tipperLines = ctx.topTippers.map((t) => {
    const seg = ctx.segmentMap[t.username] || 'unknown';
    const timings = ctx.tipTimings
      .filter((tt) => tt.username === t.username)
      .map((tt) => `${tt.minuteFromStart}分目に${tt.amount}tk`)
      .join(', ');
    const history = ctx.tipHistory.find((h) => h.username === t.username);
    const historyStr = history
      ? `過去30日: ${history.totalPast30d}tk (${history.txCount}回)`
      : '過去30日: データなし';
    const chats = ctx.recentChats
      .filter((c) => c.username === t.username)
      .slice(0, 3)
      .map((c) => `「${c.message}」(${c.minuteFromStart}分目)`)
      .join(', ');
    return `- ${t.username}: ${t.amount}tk (${t.count}回), セグメント=${seg}, タイミング=[${timings}], ${historyStr}, チャット=[${chats || 'なし'}]`;
  }).join('\n');

  return `あなたはライブ配信分析の専門家です。以下の配信データからチッパーの投げ銭動機を分析してください。

## 配信概要
- キャスト: ${ctx.castName}
- 配信時間: ${ctx.sessionDurationMinutes}分
- 合計チップ: ${ctx.totalTips}tk (${ctx.tipCount}件)

## トップチッパー詳細
${tipperLines}

## 分析指示
各チッパーについて以下を推論してください:
1. motivation: なぜ投げたか（日本語、20文字以内の簡潔な分析）
2. pattern: 以下から1つ選択
   - goal_closer: ゴール達成のために投げた
   - first_timer: 初めての投げ銭
   - regular_supporter: 常連の定期的な応援
   - competitive: 他ユーザーとの競争意識
   - emotional: 感情的な反応（チャットの流れで）
   - whale_routine: 大口の定期的な投げ銭
3. recommendation: このユーザーへの次回対応アドバイス（日本語、25文字以内）

また配信全体について:
4. session_summary: この配信の分析サマリ（日本語2-3文）
5. next_session_tips: 次回配信への提案（日本語、3項目以内）

JSON形式で出力してください:
{
  "tipper_analysis": [{"username": "...", "amount": 数値, "motivation": "...", "pattern": "...", "recommendation": "..."}],
  "session_summary": "...",
  "next_session_tips": ["...", "...", "..."]
}`;
}

// ============================================================
// LLM API calls
// ============================================================

async function callAnthropic(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    log.error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
    return null;
  }

  const data = await res.json() as { content?: { text?: string }[] };
  return data.content?.[0]?.text || null;
}

async function callOpenAI(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      messages: [
        { role: 'system', content: 'JSON形式で回答してください。' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    log.error(`OpenAI API ${res.status}: ${errText.slice(0, 200)}`);
    return null;
  }

  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || null;
}

// ============================================================
// JSON parsing with validation
// ============================================================

function parseInsightsJson(raw: string): SessionInsights | null {
  // JSONブロックを抽出（```json ... ``` でラップされている場合）
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]) as SessionInsights;

    // バリデーション
    if (!Array.isArray(parsed.tipper_analysis)) return null;
    if (typeof parsed.session_summary !== 'string') return null;
    if (!Array.isArray(parsed.next_session_tips)) return null;

    // 各tipperの必須フィールドチェック
    for (const t of parsed.tipper_analysis) {
      if (!t.username || typeof t.amount !== 'number' || !t.motivation || !t.pattern || !t.recommendation) {
        return null;
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

// ============================================================
// Rule-based fallback
// ============================================================

function generateRuleBasedInsights(ctx: LlmPromptContext): SessionInsights {
  const tipperAnalysis: TipperAnalysis[] = ctx.topTippers.map((t) => {
    const seg = ctx.segmentMap[t.username] || 'unknown';
    const history = ctx.tipHistory.find((h) => h.username === t.username);
    const isFirstTimer = !history || history.txCount === 0;

    let pattern: string;
    let motivation: string;
    let recommendation: string;

    if (isFirstTimer) {
      pattern = 'first_timer';
      motivation = '初回投げ銭';
      recommendation = 'お礼DMで関係構築を';
    } else if (seg === 'S9' || seg === 'S10') {
      pattern = 'whale_routine';
      motivation = '大口の定期的応援';
      recommendation = '名前を呼んで特別感を演出';
    } else if (seg === 'S7' || seg === 'S8') {
      pattern = 'regular_supporter';
      motivation = '常連の継続的応援';
      recommendation = '感謝を伝えて維持を';
    } else if (t.count >= 3) {
      pattern = 'competitive';
      motivation = '複数回投げ銭で存在感';
      recommendation = 'リアクションを返して盛り上げる';
    } else {
      pattern = 'emotional';
      motivation = '流れに乗った応援';
      recommendation = '次回もチャットで会話を';
    }

    return { username: t.username, amount: t.amount, motivation, pattern, recommendation };
  });

  const summary = ctx.totalTips > 0
    ? `${ctx.sessionDurationMinutes}分の配信で${ctx.totalTips}tk獲得。トップチッパー${ctx.topTippers.length}名が貢献。`
    : `${ctx.sessionDurationMinutes}分の配信。チップなし。`;

  const tips: string[] = [];
  if (tipperAnalysis.some((t) => t.pattern === 'first_timer')) {
    tips.push('初投げユーザーにお礼DMを送信する');
  }
  if (ctx.totalTips > 0) {
    tips.push('トップチッパーの名前を次回配信で呼ぶ');
  }
  tips.push('配信開始30分以内にゴール設定を行う');

  return {
    tipper_analysis: tipperAnalysis,
    session_summary: summary,
    next_session_tips: tips.slice(0, 3),
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * LLM推論でチッパー分析を生成する。
 * APIキーがない場合やAPI失敗時はルールベースにフォールバック。
 */
export async function generateTipperInsights(ctx: LlmPromptContext): Promise<SessionInsights> {
  const provider = detectProvider();

  if (!provider) {
    log.info('LLM APIキーなし — ルールベースフォールバック');
    return generateRuleBasedInsights(ctx);
  }

  const prompt = buildPrompt(ctx);

  try {
    log.info(`LLM推論開始 (${provider}): ${ctx.topTippers.length}名のチッパーを分析`);

    const raw = provider === 'anthropic'
      ? await callAnthropic(prompt)
      : await callOpenAI(prompt);

    if (!raw) {
      log.warn(`${provider} API応答なし — ルールベースフォールバック`);
      return generateRuleBasedInsights(ctx);
    }

    const parsed = parseInsightsJson(raw);
    if (!parsed) {
      log.warn(`${provider} JSON解析失敗 — ルールベースフォールバック`);
      log.debug(`Raw response: ${raw.slice(0, 300)}`);
      return generateRuleBasedInsights(ctx);
    }

    log.info(`LLM推論完了 (${provider}): ${parsed.tipper_analysis.length}名分析済み`);
    return parsed;
  } catch (err) {
    log.error(`LLM呼び出し例外 (${provider}): ${err}`);
    return generateRuleBasedInsights(ctx);
  }
}

export type { LlmPromptContext };
