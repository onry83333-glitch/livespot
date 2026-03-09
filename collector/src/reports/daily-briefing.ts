/**
 * daily-briefing.ts — 日次ブリーフィング自動生成
 *
 * 毎朝09:00 JSTに実行。前日の配信後レポート(post_session)を集計し
 * キャスト別の日次サマリー + 7日トレンド + 推奨時間帯を
 * cast_knowledge (report_type='daily_briefing') に保存。
 * Telegram通知も送信する。
 *
 * Usage:
 *   npx tsx src/reports/daily-briefing.ts           # 即時実行（前日分）
 *   npx tsx src/reports/daily-briefing.ts 2026-03-01 # 指定日分
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('daily-briefing');

// ============================================================
// Config
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8050153948';

// ============================================================
// Types
// ============================================================

interface CastYesterday {
  sessions_count: number;
  total_duration_minutes: number;
  total_tips: number;
  peak_viewers: number;
  unique_chatters: number;
}

interface CastTrend7d {
  avg_daily_tips: number;
  avg_session_duration: number;
  avg_peak_viewers: number;
  tip_trend: 'up' | 'down' | 'stable';
}

interface CastBriefing {
  cast_name: string;
  yesterday: CastYesterday;
  trend_7d: CastTrend7d;
  recommended_time_slot: string;
}

interface DailyBriefingMetrics {
  date: string;
  casts: CastBriefing[];
}

interface PostSessionMetrics {
  session_duration_minutes: number;
  peak_viewers: number;
  total_tips: number;
  unique_chatters: number;
  tip_speed_per_minute: number;
  chat_messages_total: number;
  [key: string]: unknown;
}

interface RegisteredCast {
  id: number;
  account_id: string;
  cast_name: string;
}

// ============================================================
// Main
// ============================================================

export async function generateDailyBriefing(targetDate?: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 対象日（デフォルト: 昨日 JST）
  const now = new Date();
  const jstOffset = 9 * 60 * 60_000;
  const jstNow = new Date(now.getTime() + jstOffset);

  let dateStr: string;
  if (targetDate) {
    dateStr = targetDate;
  } else {
    // 昨日（JST）
    const yesterday = new Date(jstNow);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    dateStr = yesterday.toISOString().slice(0, 10);
  }

  // 対象日のUTC範囲（JST 00:00-24:00 = UTC 15:00前日 - 15:00当日）
  const dayStartUtc = new Date(`${dateStr}T00:00:00+09:00`).toISOString();
  const dayEndUtc = new Date(`${dateStr}T23:59:59+09:00`).toISOString();

  log.info(`日次ブリーフィング生成開始: ${dateStr}`);

  // 1. registered_casts を全件取得
  const { data: casts, error: castErr } = await sb
    .from('registered_casts')
    .select('id, account_id, cast_name')
    .eq('is_active', true);

  if (castErr || !casts || casts.length === 0) {
    log.warn('registered_casts が 0件。ブリーフィングスキップ');
    return;
  }

  const briefings: CastBriefing[] = [];

  for (const cast of casts as RegisteredCast[]) {
    const briefing = await buildCastBriefing(sb, cast, dateStr, dayStartUtc, dayEndUtc);
    briefings.push(briefing);
  }

  const metrics: DailyBriefingMetrics = {
    date: dateStr,
    casts: briefings,
  };

  // cast_knowledge に UPSERT（キャストごとではなくアカウントまとめて1レコード）
  // 最初のキャストのcast_id/account_idを代表として使用
  const primaryCast = casts[0] as RegisteredCast;

  const { error: upsertErr } = await sb
    .from('cast_knowledge')
    .upsert(
      {
        cast_id: primaryCast.id,
        account_id: primaryCast.account_id,
        report_type: 'daily_briefing',
        period_start: dayStartUtc,
        period_end: dayEndUtc,
        metrics_json: metrics,
        insights_json: {},
      },
      { onConflict: 'cast_id,report_type,period_start' },
    );

  if (upsertErr) {
    log.error(`cast_knowledge UPSERT失敗: ${upsertErr.message}`);
    return;
  }

  log.info(`日次ブリーフィング保存完了: ${dateStr} (${briefings.length}キャスト)`);

  // Telegram通知
  await sendTelegramNotification(metrics);

  // pipeline_status 更新
  try {
    const { error: pipeErr } = await sb.from('pipeline_status').upsert({
      pipeline_name: 'DailyBriefing',
      status: 'auto',
      source: 'cast_knowledge',
      destination: 'cast_knowledge + Telegram',
      detail: `${dateStr}: ${briefings.length}キャスト`,
      last_run_at: new Date().toISOString(),
      last_success: true,
      error_message: null,
    }, { onConflict: 'pipeline_name' });
    if (pipeErr) {
      log.warn(`pipeline_status更新失敗: ${pipeErr.message}`);
    } else {
      log.info('pipeline_status更新完了');
    }
  } catch (err) {
    log.warn(`pipeline_status更新エラー: ${err}`);
  }
}

// ============================================================
// キャスト別ブリーフィング構築
// ============================================================

async function buildCastBriefing(
  sb: SupabaseClient,
  cast: RegisteredCast,
  dateStr: string,
  dayStartUtc: string,
  dayEndUtc: string,
): Promise<CastBriefing> {
  // 前日のpost_sessionレポートを取得
  const { data: reports } = await sb
    .from('cast_knowledge')
    .select('metrics_json, period_start, period_end')
    .eq('cast_id', cast.id)
    .eq('report_type', 'post_session')
    .gte('period_start', dayStartUtc)
    .lte('period_start', dayEndUtc)
    .order('period_start', { ascending: true });

  const sessions = reports || [];

  // 昨日のサマリー
  const yesterday = aggregateYesterday(sessions);

  // 7日トレンド
  const trend7d = await calculateTrend7d(sb, cast, dateStr);

  // 推奨時間帯（過去30日）
  const recommendedTimeSlot = await getRecommendedTimeSlot(sb, cast);

  return {
    cast_name: cast.cast_name,
    yesterday,
    trend_7d: trend7d,
    recommended_time_slot: recommendedTimeSlot,
  };
}

function aggregateYesterday(
  sessions: { metrics_json: PostSessionMetrics; period_start: string; period_end: string }[],
): CastYesterday {
  if (sessions.length === 0) {
    return {
      sessions_count: 0,
      total_duration_minutes: 0,
      total_tips: 0,
      peak_viewers: 0,
      unique_chatters: 0,
    };
  }

  let totalDuration = 0;
  let totalTips = 0;
  let peakViewers = 0;
  let totalChatters = 0;

  for (const s of sessions) {
    const m = s.metrics_json;
    totalDuration += m.session_duration_minutes || 0;
    totalTips += m.total_tips || 0;
    peakViewers = Math.max(peakViewers, m.peak_viewers || 0);
    totalChatters += m.unique_chatters || 0;
  }

  return {
    sessions_count: sessions.length,
    total_duration_minutes: totalDuration,
    total_tips: totalTips,
    peak_viewers: peakViewers,
    unique_chatters: totalChatters,
  };
}

// ============================================================
// 7日トレンド計算
// ============================================================

async function calculateTrend7d(
  sb: SupabaseClient,
  cast: RegisteredCast,
  dateStr: string,
): Promise<CastTrend7d> {
  // 過去7日間のpost_sessionレポートを取得
  const endDate = new Date(`${dateStr}T23:59:59+09:00`);
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60_000);

  const { data: reports } = await sb
    .from('cast_knowledge')
    .select('metrics_json, period_start')
    .eq('cast_id', cast.id)
    .eq('report_type', 'post_session')
    .gte('period_start', startDate.toISOString())
    .lte('period_start', endDate.toISOString())
    .order('period_start', { ascending: true });

  const sessions = reports || [];

  if (sessions.length === 0) {
    return { avg_daily_tips: 0, avg_session_duration: 0, avg_peak_viewers: 0, tip_trend: 'stable' };
  }

  // 日別に集計
  const dailyTips = new Map<string, number>();
  let totalDuration = 0;
  let totalPeak = 0;

  for (const s of sessions) {
    const m = s.metrics_json as PostSessionMetrics;
    const day = s.period_start.slice(0, 10);
    dailyTips.set(day, (dailyTips.get(day) || 0) + (m.total_tips || 0));
    totalDuration += m.session_duration_minutes || 0;
    totalPeak = Math.max(totalPeak, m.peak_viewers || 0);
  }

  const numDays = Math.max(1, dailyTips.size);
  const totalTipsSum = Array.from(dailyTips.values()).reduce((s, v) => s + v, 0);
  const avgDailyTips = Math.round(totalTipsSum / numDays);
  const avgSessionDuration = Math.round(totalDuration / sessions.length);
  const avgPeakViewers = Math.round(totalPeak / numDays);

  // トレンド判定: 前半3.5日 vs 後半3.5日
  const midpoint = new Date(startDate.getTime() + 3.5 * 24 * 60 * 60_000);
  let firstHalfTips = 0;
  let secondHalfTips = 0;

  for (const s of sessions) {
    const m = s.metrics_json as PostSessionMetrics;
    const t = new Date(s.period_start).getTime();
    if (t < midpoint.getTime()) {
      firstHalfTips += m.total_tips || 0;
    } else {
      secondHalfTips += m.total_tips || 0;
    }
  }

  let tipTrend: 'up' | 'down' | 'stable' = 'stable';
  if (firstHalfTips > 0) {
    const change = (secondHalfTips - firstHalfTips) / firstHalfTips;
    if (change > 0.1) tipTrend = 'up';
    else if (change < -0.1) tipTrend = 'down';
  }

  return {
    avg_daily_tips: avgDailyTips,
    avg_session_duration: avgSessionDuration,
    avg_peak_viewers: avgPeakViewers,
    tip_trend: tipTrend,
  };
}

// ============================================================
// 推奨時間帯（過去30日のセッション開始時刻から最も高パフォーマンスの時間帯を特定）
// ============================================================

async function getRecommendedTimeSlot(
  sb: SupabaseClient,
  cast: RegisteredCast,
): Promise<string> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

  const { data: sessions } = await sb
    .from('sessions')
    .select('started_at, peak_viewers, total_tokens')
    .eq('account_id', cast.account_id)
    .eq('cast_name', cast.cast_name)
    .gte('started_at', thirtyDaysAgo.toISOString())
    .not('ended_at', 'is', null)
    .order('started_at', { ascending: true });

  if (!sessions || sessions.length === 0) {
    return '配信データなし';
  }

  // JST時間帯別にパフォーマンスを集計（2時間刻み）
  const slots = new Map<string, { count: number; totalTokens: number; totalViewers: number }>();

  for (const s of sessions) {
    const startJst = new Date(new Date(s.started_at).getTime() + 9 * 60 * 60_000);
    const hour = startJst.getUTCHours();
    const slotStart = Math.floor(hour / 2) * 2;
    const slotKey = `${slotStart.toString().padStart(2, '0')}:00-${(slotStart + 2).toString().padStart(2, '0')}:00`;

    const entry = slots.get(slotKey) || { count: 0, totalTokens: 0, totalViewers: 0 };
    entry.count++;
    entry.totalTokens += s.total_tokens || 0;
    entry.totalViewers += s.peak_viewers || 0;
    slots.set(slotKey, entry);
  }

  // トークン/回が最も高い時間帯を推奨
  let bestSlot = '';
  let bestAvgTokens = 0;

  for (const [slot, data] of slots.entries()) {
    if (data.count < 2) continue; // サンプル2回未満は除外
    const avgTokens = data.totalTokens / data.count;
    if (avgTokens > bestAvgTokens) {
      bestAvgTokens = avgTokens;
      bestSlot = slot;
    }
  }

  if (!bestSlot) {
    // サンプル不足の場合、最頻時間帯を返す
    let maxCount = 0;
    for (const [slot, data] of slots.entries()) {
      if (data.count > maxCount) {
        maxCount = data.count;
        bestSlot = slot;
      }
    }
  }

  return bestSlot ? `${bestSlot} JST` : '配信データ不足';
}

// ============================================================
// Telegram通知
// ============================================================

async function sendTelegramNotification(metrics: DailyBriefingMetrics): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    log.warn('TELEGRAM_BOT_TOKEN未設定。通知スキップ');
    return;
  }

  const lines: string[] = [];
  lines.push(`📊 <b>日次ブリーフィング ${metrics.date}</b>`);
  lines.push('');

  for (const cast of metrics.casts) {
    const y = cast.yesterday;
    lines.push(`<b>${cast.cast_name}</b>`);

    if (y.sessions_count === 0) {
      lines.push('  配信なし');
    } else {
      lines.push(`  配信: ${y.sessions_count}回 / ${y.total_duration_minutes}分`);
      lines.push(`  応援: ${y.total_tips}tk / 視聴者: ${y.peak_viewers}人`);
      lines.push(`  チャッター: ${y.unique_chatters}人`);
    }

    const t = cast.trend_7d;
    const trendEmoji = t.tip_trend === 'up' ? '📈' : t.tip_trend === 'down' ? '📉' : '➡️';
    lines.push(`  7日: ${trendEmoji} ${t.avg_daily_tips}tk/日 (${t.avg_session_duration}分/回)`);
    lines.push(`  推奨: ${cast.recommended_time_slot}`);
    lines.push('');
  }

  const text = lines.join('\n');

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      log.warn(`Telegram通知失敗: HTTP ${res.status} — ${body}`);
    } else {
      log.info('Telegram通知送信完了');
    }
  } catch (err) {
    log.warn(`Telegram通知エラー: ${err}`);
  }
}

// ============================================================
// CLI エントリポイント
// ============================================================

const targetDate = process.argv[2]; // optional: YYYY-MM-DD
generateDailyBriefing(targetDate)
  .then(() => {
    log.info('日次ブリーフィング完了');
    process.exit(0);
  })
  .catch((err) => {
    log.error(`日次ブリーフィングエラー: ${err}`);
    process.exit(1);
  });
