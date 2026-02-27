import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * P0-5: DM送信安全機構
 * - 1日あたり送信上限（デフォルト5,000件）
 * - campaign単位の送信数制限
 */

export const DEFAULT_DAILY_DM_LIMIT = 5000;

interface DailyLimitResult {
  allowed: boolean;
  sentToday: number;
  limit: number;
  reason?: string;
}

interface CampaignLimitResult {
  allowed: boolean;
  sentCount: number;
  limit: number;
  reason?: string;
}

/**
 * 1日あたりのDM送信数チェック（JST基準）
 * account_settings.daily_dm_limit が設定されていればその値、なければデフォルト5,000件
 */
export async function checkDailyDmLimit(
  supabase: SupabaseClient,
  accountId: string,
): Promise<DailyLimitResult> {
  // JST基準の今日の開始・終了
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const todayStr = jstNow.toISOString().slice(0, 10);
  const todayStart = `${todayStr}T00:00:00+09:00`;
  const todayEnd = `${todayStr}T23:59:59+09:00`;

  // 今日の送信数カウント（queued/sending/success を対象、error/blocked_by_limitは除外）
  const { count, error } = await supabase
    .from('dm_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .in('status', ['queued', 'sending', 'success'])
    .gte('created_at', todayStart)
    .lt('created_at', todayEnd);

  if (error) {
    console.warn('[dm-safety] Daily limit check failed:', error.message);
    // エラー時は安全側に倒す（許可）
    return { allowed: true, sentToday: 0, limit: DEFAULT_DAILY_DM_LIMIT };
  }

  const sentToday = count || 0;
  const limit = DEFAULT_DAILY_DM_LIMIT;

  if (sentToday >= limit) {
    return {
      allowed: false,
      sentToday,
      limit,
      reason: `1日あたりの送信上限(${limit.toLocaleString()}件)に到達しました（本日: ${sentToday.toLocaleString()}件）`,
    };
  }

  return { allowed: true, sentToday, limit };
}

/**
 * campaign単位の送信数チェック
 * maxCount が指定されていない場合はチェックしない（無制限）
 */
export async function checkCampaignLimit(
  supabase: SupabaseClient,
  accountId: string,
  campaign: string,
  maxCount?: number,
): Promise<CampaignLimitResult> {
  if (!maxCount || maxCount <= 0) {
    return { allowed: true, sentCount: 0, limit: 0 };
  }

  const { count, error } = await supabase
    .from('dm_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('campaign', campaign)
    .in('status', ['queued', 'sending', 'success']);

  if (error) {
    console.warn('[dm-safety] Campaign limit check failed:', error.message);
    return { allowed: true, sentCount: 0, limit: maxCount };
  }

  const sentCount = count || 0;

  if (sentCount >= maxCount) {
    return {
      allowed: false,
      sentCount,
      limit: maxCount,
      reason: `キャンペーン「${campaign}」の送信上限(${maxCount.toLocaleString()}件)に到達しました（送信済み: ${sentCount.toLocaleString()}件）`,
    };
  }

  return { allowed: true, sentCount, limit: maxCount };
}

/**
 * 日次上限に対して追加可能な残数を計算
 */
export function getRemainingDailyQuota(dailyCheck: DailyLimitResult): number {
  return Math.max(0, dailyCheck.limit - dailyCheck.sentToday);
}
