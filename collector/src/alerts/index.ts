/**
 * alerts/index.ts — AlertEvaluator: 4種類の運営アラート評価
 *
 * UC-061: revenue_drop       — セッション売上急落（前日 vs 7日平均 -30%）
 * UC-019: consecutive_loss   — 連続赤字（3週連続 gross_profit < 0）
 * UC-025: spy_cast_decline   — 競合キャスト視聴者急減（-40%）
 * UC-026: market_trend_change — 市場全体トレンド変動（WoW -15% / +20%）
 */

import { getSupabase } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('alerts');

interface AlertInsert {
  account_id: string;
  alert_type: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

// ============================================================
// Dedup: 同一アラートを24時間以内に重複発行しない
// ============================================================
async function isDuplicate(
  accountId: string,
  alertType: string,
  dedupKey: string,
): Promise<boolean> {
  const sb = getSupabase();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from('alerts')
    .select('id')
    .eq('account_id', accountId)
    .eq('alert_type', alertType)
    .gte('created_at', since)
    .contains('metadata', { dedup_key: dedupKey })
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function insertAlert(alert: AlertInsert): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('alerts').insert(alert);
  if (error) {
    log.error(`Failed to insert alert: ${error.message}`, alert);
  } else {
    log.info(`[ALERT] ${alert.severity.toUpperCase()} ${alert.alert_type}: ${alert.title}`);
  }
}

// ============================================================
// UC-061: revenue_drop — セッション売上急落
// 昨日の合計トークン vs 過去7日平均、-30%で critical
// ============================================================
async function evaluateRevenueDrop(accountId: string): Promise<void> {
  const sb = getSupabase();

  // 昨日のセッション合計
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);

  const { data: yesterdayData } = await sb
    .from('sessions')
    .select('cast_name, total_coins')
    .eq('account_id', accountId)
    .gte('started_at', `${yStr}T00:00:00+09:00`)
    .lt('started_at', `${yStr}T24:00:00+09:00`);

  if (!yesterdayData || yesterdayData.length === 0) return;

  // キャスト別に集計
  const castTotals = new Map<string, number>();
  for (const s of yesterdayData) {
    const prev = castTotals.get(s.cast_name) ?? 0;
    castTotals.set(s.cast_name, prev + (s.total_coins ?? 0));
  }

  // 過去7日（昨日を除く）のキャスト別日平均
  const weekAgo = new Date(yesterday);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const wStr = weekAgo.toISOString().slice(0, 10);

  const { data: weekData } = await sb
    .from('sessions')
    .select('cast_name, total_coins, started_at')
    .eq('account_id', accountId)
    .gte('started_at', `${wStr}T00:00:00+09:00`)
    .lt('started_at', `${yStr}T00:00:00+09:00`);

  if (!weekData || weekData.length === 0) return;

  // キャスト別日別集計 → 平均
  const castDayTotals = new Map<string, Map<string, number>>();
  for (const s of weekData) {
    const day = s.started_at?.slice(0, 10) ?? '';
    if (!castDayTotals.has(s.cast_name)) castDayTotals.set(s.cast_name, new Map());
    const dayMap = castDayTotals.get(s.cast_name)!;
    dayMap.set(day, (dayMap.get(day) ?? 0) + (s.total_coins ?? 0));
  }

  for (const [castName, yesterdayTotal] of castTotals) {
    const dayMap = castDayTotals.get(castName);
    if (!dayMap || dayMap.size === 0) continue;

    const dayValues = [...dayMap.values()];
    const avg = dayValues.reduce((a, b) => a + b, 0) / dayValues.length;
    if (avg <= 0) continue;

    const changeRate = ((yesterdayTotal - avg) / avg) * 100;

    if (changeRate <= -30) {
      const dedupKey = `revenue_drop_${castName}_${yStr}`;
      if (await isDuplicate(accountId, 'revenue_drop', dedupKey)) continue;

      await insertAlert({
        account_id: accountId,
        alert_type: 'revenue_drop',
        severity: 'critical',
        title: `${castName}: 売上急落 ${changeRate.toFixed(0)}%`,
        body: `${yStr}のトークン合計 ${yesterdayTotal.toLocaleString()}tk は7日平均 ${Math.round(avg).toLocaleString()}tk から${Math.abs(changeRate).toFixed(0)}%減少しました。`,
        metadata: {
          dedup_key: dedupKey,
          cast_name: castName,
          date: yStr,
          yesterday_tokens: yesterdayTotal,
          avg_7d_tokens: Math.round(avg),
          change_rate: Math.round(changeRate),
        },
      });
    }
  }
}

// ============================================================
// UC-019: consecutive_loss — 連続赤字検出
// get_monthly_pl は月次だが、週次で判定するため直近3週をセッション単位で判定
// 3週連続で週の gross_profit < 0 → warning
// ============================================================
async function evaluateConsecutiveLoss(accountId: string): Promise<void> {
  const sb = getSupabase();

  // get_session_pl を呼んで直近30日のP/Lを取得
  const { data, error } = await sb.rpc('get_session_pl', {
    p_account_id: accountId,
    p_days: 30,
  });

  if (error || !data || data.length === 0) return;

  // 週別に gross_profit を集計
  const weekProfits = new Map<string, number>(); // 'YYYY-WW' → sum
  for (const row of data as Array<{ started_at: string; gross_profit_jpy: number }>) {
    const d = new Date(row.started_at);
    // ISO week calculation
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    weekProfits.set(weekKey, (weekProfits.get(weekKey) ?? 0) + (row.gross_profit_jpy ?? 0));
  }

  // 直近3週を判定
  const sortedWeeks = [...weekProfits.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  if (sortedWeeks.length < 3) return;

  const recent3 = sortedWeeks.slice(0, 3);
  const allNegative = recent3.every(([, profit]) => profit < 0);

  if (allNegative) {
    const dedupKey = `consecutive_loss_${recent3[0][0]}`;
    if (await isDuplicate(accountId, 'consecutive_loss', dedupKey)) return;

    const totalLoss = recent3.reduce((sum, [, p]) => sum + p, 0);
    await insertAlert({
      account_id: accountId,
      alert_type: 'consecutive_loss',
      severity: 'warning',
      title: `3週連続赤字: 合計 ${Math.round(totalLoss).toLocaleString()}円`,
      body: `直近3週 (${recent3[2][0]} ~ ${recent3[0][0]}) でいずれもgross_profit < 0 です。コスト設定の見直しを推奨します。`,
      metadata: {
        dedup_key: dedupKey,
        weeks: recent3.map(([week, profit]) => ({ week, profit: Math.round(profit) })),
        total_loss: Math.round(totalLoss),
      },
    });
  }
}

// ============================================================
// UC-025: spy_cast_decline — 競合キャスト視聴者急減
// spy_casts に登録されたキャストの平均視聴者数が-40%以上低下 → info
// ============================================================
async function evaluateSpyCastDecline(accountId: string): Promise<void> {
  const sb = getSupabase();

  // spy_casts 一覧
  const { data: spyCasts } = await sb
    .from('spy_casts')
    .select('cast_name')
    .eq('account_id', accountId)
    .eq('is_active', true);

  if (!spyCasts || spyCasts.length === 0) return;

  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  for (const { cast_name: castName } of spyCasts) {
    // 昨日の平均視聴者数
    const { data: recentViewers } = await sb
      .from('spy_viewers')
      .select('user_name')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gte('last_seen_at', yesterday.toISOString());

    const recentCount = recentViewers?.length ?? 0;

    // SPY停止中 or キャストオフライン → 0人は「減少」ではなく「データなし」なのでスキップ
    if (recentCount === 0) continue;

    // 過去7日の平均（日別ユニーク数の平均）
    const { data: weekViewers } = await sb
      .from('spy_viewers')
      .select('user_name, last_seen_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gte('last_seen_at', weekAgo.toISOString())
      .lt('last_seen_at', yesterday.toISOString());

    if (!weekViewers || weekViewers.length === 0) continue;

    // 日別ユニーク数
    const dayUniques = new Map<string, Set<string>>();
    for (const v of weekViewers) {
      const day = v.last_seen_at?.slice(0, 10) ?? '';
      if (!dayUniques.has(day)) dayUniques.set(day, new Set());
      dayUniques.get(day)!.add(v.user_name);
    }
    const dayValues = [...dayUniques.values()].map((s) => s.size);
    if (dayValues.length === 0) continue;
    const avg = dayValues.reduce((a, b) => a + b, 0) / dayValues.length;
    if (avg <= 0) continue;

    const changeRate = ((recentCount - avg) / avg) * 100;

    if (changeRate <= -40) {
      const dedupKey = `spy_decline_${castName}_${yesterday.toISOString().slice(0, 10)}`;
      if (await isDuplicate(accountId, 'spy_cast_decline', dedupKey)) continue;

      await insertAlert({
        account_id: accountId,
        alert_type: 'spy_cast_decline',
        severity: 'info',
        title: `${castName}: 視聴者 ${changeRate.toFixed(0)}% 減少`,
        body: `昨日の視聴者 ${recentCount}人 は7日平均 ${Math.round(avg)}人 から${Math.abs(changeRate).toFixed(0)}%減少。チャンスの可能性があります。`,
        metadata: {
          dedup_key: dedupKey,
          cast_name: castName,
          recent_count: recentCount,
          avg_7d_count: Math.round(avg),
          change_rate: Math.round(changeRate),
        },
      });
    }
  }
}

// ============================================================
// UC-026: market_trend_change — 市場全体トレンド変動
// 全キャストの合計視聴者数 WoW 比較
// -15%以上で warning、+20%以上で info
// ============================================================
async function evaluateMarketTrend(accountId: string): Promise<void> {
  const sb = getSupabase();

  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(thisWeekStart.getDate() - 7);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  // 今週の全視聴者ユニーク数
  const { count: thisWeekCount } = await sb
    .from('spy_viewers')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('last_seen_at', thisWeekStart.toISOString());

  // 先週の全視聴者ユニーク数
  const { count: lastWeekCount } = await sb
    .from('spy_viewers')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('last_seen_at', lastWeekStart.toISOString())
    .lt('last_seen_at', thisWeekStart.toISOString());

  const tw = thisWeekCount ?? 0;
  const lw = lastWeekCount ?? 0;
  if (lw === 0) return;

  const changeRate = ((tw - lw) / lw) * 100;
  const dateKey = now.toISOString().slice(0, 10);

  if (changeRate <= -15) {
    const dedupKey = `market_decline_${dateKey}`;
    if (await isDuplicate(accountId, 'market_trend_change', dedupKey)) return;

    await insertAlert({
      account_id: accountId,
      alert_type: 'market_trend_change',
      severity: 'warning',
      title: `市場縮小: 視聴者 ${changeRate.toFixed(0)}% (WoW)`,
      body: `今週の総視聴者 ${tw.toLocaleString()}人 は先週 ${lw.toLocaleString()}人 から${Math.abs(changeRate).toFixed(0)}%減少。市場全体の縮小傾向です。`,
      metadata: {
        dedup_key: dedupKey,
        this_week: tw,
        last_week: lw,
        change_rate: Math.round(changeRate),
        direction: 'decline',
      },
    });
  } else if (changeRate >= 20) {
    const dedupKey = `market_growth_${dateKey}`;
    if (await isDuplicate(accountId, 'market_trend_change', dedupKey)) return;

    await insertAlert({
      account_id: accountId,
      alert_type: 'market_trend_change',
      severity: 'info',
      title: `市場拡大: 視聴者 +${changeRate.toFixed(0)}% (WoW)`,
      body: `今週の総視聴者 ${tw.toLocaleString()}人 は先週 ${lw.toLocaleString()}人 から${changeRate.toFixed(0)}%増加。積極投資のチャンスです。`,
      metadata: {
        dedup_key: dedupKey,
        this_week: tw,
        last_week: lw,
        change_rate: Math.round(changeRate),
        direction: 'growth',
      },
    });
  }
}

// ============================================================
// Public: evaluateAll — 全4種類を一括評価
// ============================================================
export async function evaluateAlerts(accountIds: string[]): Promise<void> {
  log.info(`[ALERT] Evaluating alerts for ${accountIds.length} account(s)...`);

  for (const accountId of accountIds) {
    try {
      await evaluateRevenueDrop(accountId);
    } catch (err) {
      log.error(`revenue_drop evaluation failed for ${accountId}`, err);
    }

    try {
      await evaluateConsecutiveLoss(accountId);
    } catch (err) {
      log.error(`consecutive_loss evaluation failed for ${accountId}`, err);
    }

    try {
      await evaluateSpyCastDecline(accountId);
    } catch (err) {
      log.error(`spy_cast_decline evaluation failed for ${accountId}`, err);
    }

    try {
      await evaluateMarketTrend(accountId);
    } catch (err) {
      log.error(`market_trend evaluation failed for ${accountId}`, err);
    }
  }

  log.info('[ALERT] Evaluation complete');
}
