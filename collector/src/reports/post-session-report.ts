/**
 * post-session-report.ts — 配信後レポート自動生成
 *
 * セッション終了時に spy_messages + sessions データを集計し
 * cast_knowledge テーブルに保存する。
 */

import { getSupabase } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { generateTipperInsights, type LlmPromptContext, type SessionInsights } from './llm-client.js';

const log = createLogger('report');

interface TopTipper {
  username: string;
  amount: number;
  count: number;
}

interface ViewerTimelinePoint {
  time: string;
  count: number;
}

interface SegmentDistribution {
  new: number;
  light: number;
  regular: number;
  vip: number;
  whale: number;
  churned: number;
  unknown: number;
}

export interface PostSessionMetrics {
  session_duration_minutes: number;
  peak_viewers: number;
  avg_viewers: number;
  viewer_timeline: ViewerTimelinePoint[];
  total_tips: number;
  tip_count: number;
  tip_speed_per_minute: number;
  top_tippers: TopTipper[];
  chat_messages_total: number;
  chat_speed_per_minute: number;
  segment_distribution: SegmentDistribution;
  unique_chatters: number;
  returning_viewers_count: number;
}

/**
 * 配信後レポートを生成して cast_knowledge に保存する
 */
export async function generatePostSessionReport(
  accountId: string,
  castName: string,
  sessionId: string,
  sessionStartTime: string,
): Promise<void> {
  const sb = getSupabase();

  // 1. registered_casts から cast_id を取得（spy_castsはレポート対象外）
  const { data: castRow, error: castErr } = await sb
    .from('registered_casts')
    .select('id')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('is_active', true)
    .single();

  if (castErr || !castRow) {
    log.debug(`レポートスキップ: ${castName} は registered_casts に未登録`);
    return;
  }

  const castId = castRow.id;
  const periodStart = sessionStartTime;

  // 2. spy_messages + sessions を並列取得
  const [msgResult, sessionResult] = await Promise.all([
    sb
      .from('spy_messages')
      .select('msg_type, user_name, tokens, message_time, message, is_vip, metadata')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .eq('session_id', sessionId)
      .order('message_time', { ascending: true }),
    sb
      .from('sessions')
      .select('peak_viewers, started_at, ended_at')
      .eq('session_id', sessionId)
      .eq('account_id', accountId)
      .single(),
  ]);

  if (msgResult.error) {
    log.error(`spy_messages取得失敗: ${msgResult.error.message}`);
    return;
  }

  const msgs = msgResult.data || [];
  const sessionRow = sessionResult.data;
  const periodEnd = sessionRow?.ended_at || new Date().toISOString();

  // 4. viewer_stats から視聴者タイムラインを取得
  const { data: viewerStats } = await sb
    .from('viewer_stats')
    .select('viewer_count, recorded_at')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .gte('recorded_at', periodStart)
    .lte('recorded_at', periodEnd)
    .order('recorded_at', { ascending: true });

  // 5. メトリクス計算
  const metrics = buildMetrics(msgs, sessionRow, viewerStats || [], periodStart, periodEnd);

  // 6. paid_users からセグメント分布を取得（チャッターのみ）
  const uniqueChatters = new Set(
    msgs.filter((m) => m.msg_type !== 'system').map((m) => m.user_name),
  );
  const segDist = await getSegmentDistribution(sb, accountId, castName, Array.from(uniqueChatters));
  metrics.segment_distribution = segDist;

  // 7. 過去に来た人（リピーター）の数
  metrics.returning_viewers_count = await countReturningViewers(
    sb, accountId, castName, sessionId, Array.from(uniqueChatters),
  );

  // 8. LLM推論でインサイトを生成
  const insights = await buildInsights(
    sb, accountId, castName, metrics, msgs, periodStart,
  );

  // 9. cast_knowledge に UPSERT
  const { error: upsertErr } = await sb
    .from('cast_knowledge')
    .upsert(
      {
        cast_id: castId,
        account_id: accountId,
        report_type: 'post_session',
        period_start: periodStart,
        period_end: periodEnd,
        metrics_json: metrics,
        insights_json: insights,
      },
      { onConflict: 'cast_id,report_type,period_start' },
    );

  if (upsertErr) {
    log.error(`cast_knowledge UPSERT失敗: ${upsertErr.message}`);
    return;
  }

  log.info(
    `配信後レポート保存: ${castName} (${metrics.session_duration_minutes}分, ` +
    `${metrics.total_tips}tk, ${metrics.chat_messages_total}msgs, ` +
    `${metrics.unique_chatters}人)`,
  );
}

// ============================================================
// Internal helpers
// ============================================================

interface SpyMessage {
  msg_type: string;
  user_name: string;
  tokens: number;
  message_time: string;
  message: string | null;
  is_vip: boolean;
  metadata: Record<string, unknown> | null;
}

interface SessionRow {
  peak_viewers: number | null;
  started_at: string | null;
  ended_at: string | null;
}

interface ViewerStatRow {
  viewer_count: number;
  recorded_at: string;
}

function buildMetrics(
  msgs: SpyMessage[],
  sessionRow: SessionRow | null,
  viewerStats: ViewerStatRow[],
  periodStart: string,
  periodEnd: string,
): PostSessionMetrics {
  const startMs = new Date(periodStart).getTime();
  const endMs = new Date(periodEnd).getTime();
  const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60_000));

  // チャットメッセージ（systemを除く）
  const chatMsgs = msgs.filter((m) => m.msg_type !== 'system');
  const chatMessagesTotal = chatMsgs.length;
  const chatSpeedPerMinute = Math.round((chatMessagesTotal / durationMinutes) * 10) / 10;

  // チップ集計
  const tipMsgs = msgs.filter((m) => m.tokens > 0);
  const totalTips = tipMsgs.reduce((sum, m) => sum + m.tokens, 0);
  const tipCount = tipMsgs.length;
  const tipSpeedPerMinute = Math.round((totalTips / durationMinutes) * 10) / 10;

  // トップティッパー
  const tipperMap = new Map<string, { amount: number; count: number }>();
  for (const m of tipMsgs) {
    const entry = tipperMap.get(m.user_name) || { amount: 0, count: 0 };
    entry.amount += m.tokens;
    entry.count += 1;
    tipperMap.set(m.user_name, entry);
  }
  const topTippers: TopTipper[] = Array.from(tipperMap.entries())
    .map(([username, { amount, count }]) => ({ username, amount, count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  // ユニークチャッター
  const uniqueChatters = new Set(chatMsgs.map((m) => m.user_name)).size;

  // 視聴者タイムライン（5分刻み）
  const viewerTimeline = buildViewerTimeline(viewerStats, startMs, endMs);
  const peakViewers = sessionRow?.peak_viewers
    || (viewerStats.length > 0 ? Math.max(...viewerStats.map((v) => v.viewer_count)) : 0);
  const avgViewers = viewerStats.length > 0
    ? Math.round(viewerStats.reduce((s, v) => s + v.viewer_count, 0) / viewerStats.length)
    : 0;

  return {
    session_duration_minutes: durationMinutes,
    peak_viewers: peakViewers,
    avg_viewers: avgViewers,
    viewer_timeline: viewerTimeline,
    total_tips: totalTips,
    tip_count: tipCount,
    tip_speed_per_minute: tipSpeedPerMinute,
    top_tippers: topTippers,
    chat_messages_total: chatMessagesTotal,
    chat_speed_per_minute: chatSpeedPerMinute,
    segment_distribution: { new: 0, light: 0, regular: 0, vip: 0, whale: 0, churned: 0, unknown: 0 },
    unique_chatters: uniqueChatters,
    returning_viewers_count: 0,
  };
}

function buildViewerTimeline(
  viewerStats: ViewerStatRow[],
  startMs: number,
  endMs: number,
): ViewerTimelinePoint[] {
  if (viewerStats.length === 0) return [];

  const INTERVAL = 5 * 60_000; // 5分
  const timeline: ViewerTimelinePoint[] = [];

  for (let t = startMs; t <= endMs; t += INTERVAL) {
    const tEnd = t + INTERVAL;
    const bucket = viewerStats.filter((v) => {
      const vMs = new Date(v.recorded_at).getTime();
      return vMs >= t && vMs < tEnd;
    });
    const count = bucket.length > 0
      ? Math.round(bucket.reduce((s, v) => s + v.viewer_count, 0) / bucket.length)
      : 0;
    timeline.push({
      time: new Date(t).toISOString(),
      count,
    });
  }

  return timeline;
}

async function getSegmentDistribution(
  sb: ReturnType<typeof getSupabase>,
  accountId: string,
  castName: string,
  userNames: string[],
): Promise<SegmentDistribution> {
  const dist: SegmentDistribution = {
    new: 0, light: 0, regular: 0, vip: 0, whale: 0, churned: 0, unknown: 0,
  };

  if (userNames.length === 0) return dist;

  // paid_users のセグメントで分類
  const { data: users } = await sb
    .from('paid_users')
    .select('user_name, segment')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .in('user_name', userNames.slice(0, 200)); // 上限200名

  const segmentMap = new Map<string, string>();
  if (users) {
    for (const u of users) {
      segmentMap.set(u.user_name, u.segment || 'unknown');
    }
  }

  for (const name of userNames) {
    const seg = segmentMap.get(name) || 'unknown';
    // S1-S2: new, S3-S4: light, S5-S6: regular, S7-S8: vip, S9-S10: whale
    if (seg === 'S1' || seg === 'S2') dist.new++;
    else if (seg === 'S3' || seg === 'S4') dist.light++;
    else if (seg === 'S5' || seg === 'S6') dist.regular++;
    else if (seg === 'S7' || seg === 'S8') dist.vip++;
    else if (seg === 'S9' || seg === 'S10') dist.whale++;
    else if (seg.startsWith('churned')) dist.churned++;
    else dist.unknown++;
  }

  return dist;
}

async function countReturningViewers(
  sb: ReturnType<typeof getSupabase>,
  accountId: string,
  castName: string,
  currentSessionId: string,
  userNames: string[],
): Promise<number> {
  if (userNames.length === 0) return 0;

  // このセッション以外で過去にメッセージを送ったユニークユーザーを数える
  // DISTINCT user_name が必要なため、データ取得してSet化
  const { data, error } = await sb
    .from('spy_messages')
    .select('user_name')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .neq('session_id', currentSessionId)
    .in('user_name', userNames.slice(0, 200))
    .neq('msg_type', 'system')
    .limit(5000);

  if (error) {
    log.warn(`リピーターカウント失敗: ${error.message}`);
    return 0;
  }

  const uniqueReturning = new Set((data || []).map((r) => r.user_name));
  return uniqueReturning.size;
}

// ============================================================
// LLM-powered insights
// ============================================================

async function buildInsights(
  sb: ReturnType<typeof getSupabase>,
  accountId: string,
  castName: string,
  metrics: PostSessionMetrics,
  msgs: SpyMessage[],
  periodStart: string,
): Promise<SessionInsights> {
  if (metrics.top_tippers.length === 0) {
    return {
      tipper_analysis: [],
      session_summary: `${metrics.session_duration_minutes}分の配信。チップなし。`,
      next_session_tips: ['ゴール設定で投げ銭を促す', 'チャットに積極的にリアクションする'],
    };
  }

  const startMs = new Date(periodStart).getTime();
  const tipperUsernames = metrics.top_tippers.map((t) => t.username);

  // チップのタイミング（配信開始何分後か）
  const tipMsgs = msgs.filter((m) => m.tokens > 0);
  const tipTimings = tipMsgs.map((m) => ({
    username: m.user_name,
    minuteFromStart: Math.round((new Date(m.message_time).getTime() - startMs) / 60_000),
    amount: m.tokens,
  }));

  // セグメント取得
  const { data: segRows } = await sb
    .from('paid_users')
    .select('user_name, segment')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .in('user_name', tipperUsernames.slice(0, 50));

  const segmentMap: Record<string, string> = {};
  for (const r of segRows || []) {
    segmentMap[r.user_name] = r.segment || 'unknown';
  }

  // 過去30日のチップ履歴
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const { data: historyRows } = await sb
    .from('coin_transactions')
    .select('user_name, tokens')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .in('user_name', tipperUsernames.slice(0, 50))
    .gte('transaction_time', thirtyDaysAgo);

  const tipHistory: { username: string; totalPast30d: number; txCount: number }[] = [];
  const histMap = new Map<string, { total: number; count: number }>();
  for (const r of historyRows || []) {
    const entry = histMap.get(r.user_name) || { total: 0, count: 0 };
    entry.total += r.tokens || 0;
    entry.count += 1;
    histMap.set(r.user_name, entry);
  }
  for (const [username, v] of histMap) {
    tipHistory.push({ username, totalPast30d: v.total, txCount: v.count });
  }

  // チップ直前のチャットメッセージ
  const recentChats: { username: string; message: string; minuteFromStart: number }[] = [];
  const chatMsgs = msgs.filter((m) => m.msg_type !== 'system' && m.tokens === 0 && m.message);
  for (const tipper of tipperUsernames.slice(0, 10)) {
    const tipperChats = chatMsgs
      .filter((m) => m.user_name === tipper)
      .slice(0, 3);
    for (const c of tipperChats) {
      recentChats.push({
        username: c.user_name,
        message: (c.message || '').slice(0, 50),
        minuteFromStart: Math.round((new Date(c.message_time).getTime() - startMs) / 60_000),
      });
    }
  }

  const ctx: LlmPromptContext = {
    castName,
    sessionDurationMinutes: metrics.session_duration_minutes,
    totalTips: metrics.total_tips,
    tipCount: metrics.tip_count,
    topTippers: metrics.top_tippers,
    tipTimings,
    segmentMap,
    recentChats,
    tipHistory,
  };

  return generateTipperInsights(ctx);
}
