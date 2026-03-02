/**
 * DM Queue Manager
 *
 * dm_send_log テーブルからキュー（status=queued）を取得し、
 * ステータス更新を管理する。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export interface DMTask {
  id: number;
  account_id: string;
  user_name: string;
  profile_url: string | null;
  message: string;
  cast_name: string;
  campaign: string;
  target_user_id: number | null;
  image_url: string | null;
  send_order: string;
}

// ============================================================
// Queue operations
// ============================================================

/**
 * キューから送信待ちタスクを取得（cast_name + account_id フィルタ）
 * 30秒のグレースピリオドを適用（投入直後のタスクはスキップ）
 */
export async function fetchQueuedTasks(
  sb: SupabaseClient,
  accountId: string,
  castName: string | null,
  limit: number = 20,
): Promise<DMTask[]> {
  const graceThreshold = new Date(Date.now() - 30 * 1000).toISOString();

  let query = sb
    .from('dm_send_log')
    .select('id, account_id, user_name, profile_url, message, cast_name, campaign, target_user_id, image_url, send_order')
    .eq('account_id', accountId)
    .eq('status', 'queued')
    .lt('created_at', graceThreshold)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (castName) {
    query = query.eq('cast_name', castName);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[dm-queue] Fetch error:', error.message);
    return [];
  }

  return (data || []) as DMTask[];
}

/**
 * タスクのステータスを 'sending' に更新
 */
export async function markSending(sb: SupabaseClient, taskId: number): Promise<void> {
  await sb
    .from('dm_send_log')
    .update({ status: 'sending', sent_via: 'api' })
    .eq('id', taskId);
}

/**
 * 送信成功を記録
 */
export async function markSuccess(sb: SupabaseClient, taskId: number): Promise<void> {
  await sb
    .from('dm_send_log')
    .update({
      status: 'success',
      sent_via: 'api',
      sent_at: new Date().toISOString(),
      error: null,
    })
    .eq('id', taskId);
}

/**
 * 送信エラーを記録
 */
export async function markError(sb: SupabaseClient, taskId: number, errorMsg: string): Promise<void> {
  await sb
    .from('dm_send_log')
    .update({
      status: 'error',
      sent_via: 'api',
      error: errorMsg.slice(0, 1000),
    })
    .eq('id', taskId);
}

/**
 * テストモードでブロックされた送信を記録
 */
export async function markBlockedTestMode(sb: SupabaseClient, taskId: number, username: string): Promise<void> {
  await sb
    .from('dm_send_log')
    .update({
      status: 'blocked_test_mode',
      sent_via: 'api',
      error: `TEST MODE: blocked send to ${username} — ホワイトリスト外`,
    })
    .eq('id', taskId);
}

/**
 * キャンペーン未設定でブロックされた送信を記録
 */
export async function markBlockedNoCampaign(sb: SupabaseClient, taskId: number): Promise<void> {
  await sb
    .from('dm_send_log')
    .update({
      status: 'blocked_no_campaign',
      sent_via: 'api',
      error: 'campaign_idが未設定のため送信拒否',
    })
    .eq('id', taskId);
}

/**
 * タスクをキューに戻す（セッション切れ時）
 */
export async function requeue(sb: SupabaseClient, taskId: number): Promise<void> {
  await sb
    .from('dm_send_log')
    .update({ status: 'queued' })
    .eq('id', taskId);
}

/**
 * 残りのキュー数を取得
 */
export async function getQueueCount(
  sb: SupabaseClient,
  accountId: string,
): Promise<number> {
  const { count } = await sb
    .from('dm_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'queued');

  return count || 0;
}
