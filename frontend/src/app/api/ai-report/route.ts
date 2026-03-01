import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { reportError } from '@/lib/error-handler';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// ============================================================
// Claude API 共通呼び出し
// ============================================================
async function callClaude(prompt: string, systemPrompt?: string) {
  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemPrompt || 'あなたはライブ配信の分析アシスタントです。配信セッションデータを分析し、日本語でレポートを生成してください。具体的な数値やユーザー名を引用して、実用的で読みやすいレポートを書いてください。',
      messages: [{ role: 'user', content: prompt }],
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
  return { text, tokensUsed: inputTokens + outputTokens, costUsd: (inputTokens * 3 + outputTokens * 15) / 1_000_000 };
}

// ============================================================
// セグメント判定（total_coinsとlast_seenから分類）
// ============================================================
function getSegment(totalCoins: number, lastSeen: string | null): string {
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
// 5分間隔でメッセージをグルーピング → 盛り上がりポイント検出
// ============================================================
interface TimeSlot { startTime: string; count: number; sampleMessage: string }

function detectHotSpots(messages: { message_time: string; message: string }[]): TimeSlot[] {
  if (messages.length < 10) return [];
  const start = new Date(messages[0].message_time).getTime();
  const groups = new Map<number, typeof messages>();

  for (const m of messages) {
    const t = new Date(m.message_time).getTime();
    const bucket = Math.floor((t - start) / 300000); // 5分
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(m);
  }

  const slots: TimeSlot[] = Array.from(groups.entries()).map(([bucket, msgs]) => ({
    startTime: new Date(start + bucket * 300000).toISOString(),
    count: msgs.length,
    sampleMessage: msgs[Math.floor(msgs.length / 2)]?.message || '',
  }));

  const avgCount = slots.reduce((s, sl) => s + sl.count, 0) / slots.length;
  return slots.filter(sl => sl.count >= avgCount * 2);
}

// ============================================================
// セッションベースのFBレポート生成
// ============================================================
async function generateSessionReport(token: string, sessionId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // 1. セッション情報取得
  const { data: session, error: sessErr } = await supabase
    .from('sessions')
    .select('*')
    .eq('session_id', sessionId)
    .single();

  if (sessErr || !session) {
    return NextResponse.json({ error: `セッションが見つかりません: ${sessionId}` }, { status: 404 });
  }

  // ended_atがnullなら最終メッセージで補完
  let endedAt = session.ended_at;
  if (!endedAt) {
    const { data: lastMsg } = await supabase
      .from('spy_messages')
      .select('message_time')
      .eq('account_id', session.account_id)
      .eq('session_id', sessionId)
      .order('message_time', { ascending: false })
      .limit(1)
      .single();
    endedAt = lastMsg?.message_time || new Date().toISOString();
  }

  const durationMinutes = Math.max(1, Math.round(
    (new Date(endedAt).getTime() - new Date(session.started_at).getTime()) / 60000
  ));

  // 2. セッション中の全メッセージ取得
  const { data: messages } = await supabase
    .from('spy_messages')
    .select('user_name, message, msg_type, tokens, message_time')
    .eq('account_id', session.account_id)
    .eq('session_id', sessionId)
    .order('message_time', { ascending: true })
    .limit(10000);

  const msgs = messages || [];
  const uniqueUsers = new Set(msgs.map(m => m.user_name).filter(Boolean)).size;

  // 3. チップ集計
  const tipMsgs = msgs.filter(m => (m.msg_type === 'tip' || m.msg_type === 'gift') && m.tokens && m.tokens > 0);
  const totalTokens = tipMsgs.reduce((s, m) => s + (m.tokens || 0), 0);

  // トップチッパー
  const tipperMap: Record<string, number> = {};
  for (const m of tipMsgs) {
    const name = m.user_name || '?';
    tipperMap[name] = (tipperMap[name] || 0) + (m.tokens || 0);
  }
  const topTippers = Object.entries(tipperMap).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // トップチャッター
  const chatCounter: Record<string, number> = {};
  for (const m of msgs) {
    if (m.user_name) chatCounter[m.user_name] = (chatCounter[m.user_name] || 0) + 1;
  }
  const topChatters = Object.entries(chatCounter).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // 4. paid_users突合（セグメント情報）
  const usernames = Array.from(new Set(msgs.map(m => m.user_name).filter(Boolean)));
  let vipList = 'なし';
  let regularList = 'なし';
  let segmentSummary = '';

  if (usernames.length > 0) {
    const { data: paidUsers } = await supabase
      .from('paid_users')
      .select('user_name, total_coins, last_seen')
      .eq('cast_name', session.cast_name)
      .in('user_name', usernames.slice(0, 500))
      .limit(500);

    if (paidUsers && paidUsers.length > 0) {
      const vips = paidUsers.filter(u => u.total_coins >= 5000);
      const regulars = paidUsers.filter(u => u.total_coins >= 1000 && u.total_coins < 5000);

      if (vips.length > 0) {
        vipList = vips
          .sort((a, b) => b.total_coins - a.total_coins)
          .map(u => `${u.user_name}(${u.total_coins}tk, ${getSegment(u.total_coins, u.last_seen)})`)
          .join(', ');
      }
      if (regulars.length > 0) {
        regularList = regulars
          .sort((a, b) => b.total_coins - a.total_coins)
          .map(u => `${u.user_name}(${u.total_coins}tk, ${getSegment(u.total_coins, u.last_seen)})`)
          .join(', ');
      }

      // セグメント分布
      const segCounts: Record<string, number> = {};
      for (const u of paidUsers) {
        const seg = getSegment(u.total_coins, u.last_seen);
        segCounts[seg] = (segCounts[seg] || 0) + 1;
      }
      segmentSummary = Object.entries(segCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([seg, count]) => `  ${seg}: ${count}名`)
        .join('\n');
    }
  }

  // 5. 過去5回のセッション統計
  const { data: pastSessions } = await supabase
    .from('sessions')
    .select('session_id, started_at, ended_at, total_messages, total_tokens, peak_viewers')
    .eq('cast_name', session.cast_name)
    .eq('account_id', session.account_id)
    .neq('session_id', sessionId)
    .not('ended_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(5);

  let pastSessionsTable = 'まだ過去データがありません。';
  if (pastSessions && pastSessions.length > 0) {
    const header = '| # | 日付 | 時間(分) | メッセージ | チップ(tk) | ピーク視聴者 |';
    const divider = '|---|------|---------|----------|-----------|------------|';
    const rows = pastSessions.map((s, i) => {
      const dur = s.ended_at
        ? Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000)
        : '?';
      const date = new Date(s.started_at).toLocaleDateString('ja-JP');
      return `| ${i + 1} | ${date} | ${dur} | ${s.total_messages || 0} | ${s.total_tokens || 0} | ${s.peak_viewers || '-'} |`;
    });
    pastSessionsTable = [header, divider, ...rows].join('\n');
  }

  // 6. チャットログ抜粋（トークン節約）
  const tipLines = tipMsgs.map(m =>
    `[${m.message_time?.slice(11, 16) || '??:??'}] ${m.user_name || '?'}: [${m.tokens}tk] ${m.message || ''}`
  );

  // 盛り上がりポイント
  const hotSpots = detectHotSpots(msgs);
  let hotSpotsText = 'データ不足';
  if (hotSpots.length > 0) {
    hotSpotsText = hotSpots.map(h =>
      `- ${h.startTime.slice(11, 16)}: ${h.count}件/5分 — 例: "${(h.sampleMessage || '').slice(0, 60)}"`
    ).join('\n');
  }

  // チャットサンプル（先頭30 + 末尾30）
  const chatMsgs = msgs.filter(m => m.msg_type === 'chat');
  const chatFirst = chatMsgs.slice(0, 30).map(m =>
    `[${m.message_time?.slice(11, 16) || '??:??'}] ${m.user_name || '?'}: ${m.message || ''}`
  );
  const chatLast = chatMsgs.length > 60
    ? chatMsgs.slice(-30).map(m =>
        `[${m.message_time?.slice(11, 16) || '??:??'}] ${m.user_name || '?'}: ${m.message || ''}`
      )
    : [];
  let chatSample = chatFirst.join('\n');
  if (chatLast.length > 0) {
    chatSample += `\n... (${chatMsgs.length - 60}件省略) ...\n` + chatLast.join('\n');
  }

  // 7. プロンプト組み立て
  const prompt = `あなたはStripchat配信のデータアナリストです。以下の配信データを分析し、FBレポートを生成してください。

## 今回の配信データ
- キャスト名: ${session.title}
- 配信日時: ${new Date(session.started_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
- 配信時間: ${durationMinutes}分
- 総メッセージ数: ${session.total_messages || msgs.length}
- 総チップ額: ${session.total_tokens || totalTokens} tk
- ユニーク発言者数: ${uniqueUsers}
- ピーク視聴者数: ${session.peak_viewers || '不明'}

## ファンセグメント（paid_users突合）
- VIP(S1-S3): ${vipList}
- 常連(S4-S6): ${regularList}
${segmentSummary ? `\n### セグメント分布\n${segmentSummary}` : ''}

## トップチッパー
${topTippers.length > 0 ? topTippers.map(([name, coins], i) => `  ${i + 1}. ${name}: ${coins}tk`).join('\n') : '  (なし)'}

## 発言数ランキング
${topChatters.length > 0 ? topChatters.map(([name, count], i) => `  ${i + 1}. ${name}: ${count}発言`).join('\n') : '  (なし)'}

## 過去5回の配信トレンド
${pastSessionsTable}

## 盛り上がりポイント（5分間隔で平均の2倍以上）
${hotSpotsText}

## チップメッセージ全件(${tipLines.length}件)
${tipLines.length > 0 ? tipLines.join('\n') : '(なし)'}

## チャットメッセージサンプル(${chatMsgs.length}件中)
${chatSample || '(なし)'}

## 出力形式（必ずこの形式で出力してください）

### 📊 配信の要約
配信の概要を3行でまとめてください。

### 🔥 盛り上がりポイント
チップが集中した時間帯や、会話が盛り上がった瞬間を具体的に分析してください。

### 🐋 常連ファンの動向
VIP・常連ユーザーの特徴、セグメント別の行動パターンを分析してください。

### 💡 改善提案
次回の配信に向けた具体的なアドバイスを3つ提示してください。

### 🎯 推奨アクション
DM送信候補のユーザーや、お礼すべきユーザーをリストアップしてください。セグメントと理由も添えてください。

### 📈 数値サマリー
今回のKPIと過去配信との比較を表形式でまとめてください。`;

  // 8. Claude API呼び出し
  const result = await callClaude(prompt);

  return NextResponse.json({
    text: result.text,
    tokensUsed: result.tokensUsed,
    costUsd: result.costUsd,
    session: {
      session_id: sessionId,
      cast_name: session.title,
      duration_minutes: durationMinutes,
      total_messages: session.total_messages || msgs.length,
      total_tokens: session.total_tokens || totalTokens,
      unique_users: uniqueUsers,
      peak_viewers: session.peak_viewers || null,
    },
    meta: {
      vip_count: usernames.length > 0 ? (vipList !== 'なし' ? vipList.split(', ').length : 0) : 0,
      regular_count: usernames.length > 0 ? (regularList !== 'なし' ? regularList.split(', ').length : 0) : 0,
      past_sessions_count: pastSessions?.length || 0,
      hot_spots_count: hotSpots.length,
    },
  });
}

// ============================================================
// POST /api/ai-report
// ============================================================
export async function POST(req: NextRequest) {
  // 1. 認証チェック（Supabase JWT検証）
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const token = authHeader.slice(7);

  // Supabase auth API でトークン検証
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

  // 2. リクエストボディ取得
  const body = await req.json();
  const { session_id, prompt } = body as {
    session_id?: string;
    prompt?: string;
  };
  // NOTE: systemPrompt はセキュリティ上の理由で受け付けない（プロンプトインジェクション防止）

  // 3. session_id指定 → セッションベースFBレポート（新）
  if (session_id) {
    try {
      return await generateSessionReport(token, session_id);
    } catch (e: unknown) {
      const err = e as { message?: string; statusCode?: number };
      await reportError(e, { file: 'api/ai-report', context: 'セッションレポート生成' });
      return NextResponse.json(
        { error: err.message || 'レポート生成に失敗しました' },
        { status: err.statusCode || 500 },
      );
    }
  }

  // 4. prompt指定 → 既存の汎用レポート（後方互換）
  if (!prompt) {
    return NextResponse.json({ error: 'session_id または prompt が必要です' }, { status: 400 });
  }

  try {
    const result = await callClaude(prompt);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const err = e as { message?: string; statusCode?: number };
    await reportError(e, { file: 'api/ai-report', context: 'Claude API呼び出し' });
    return NextResponse.json(
      { error: err.message || 'Unknown error' },
      { status: err.statusCode || 500 },
    );
  }
}
