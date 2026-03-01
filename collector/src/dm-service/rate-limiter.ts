/**
 * DM送信レート制限
 *
 * - 送信間隔: 最低 SEND_INTERVAL_MS（デフォルト3秒）
 * - 日次上限: DAILY_LIMIT（デフォルト5,000件/アカウント）
 * - ユーザークールダウン: 同一ユーザーへの再送信を COOLDOWN_HOURS 時間ブロック
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Config
// ============================================================

export const SEND_INTERVAL_MS = parseInt(process.env.DM_SEND_INTERVAL_MS || '3000', 10);
export const DAILY_LIMIT = parseInt(process.env.DM_DAILY_LIMIT || '5000', 10);
export const COOLDOWN_HOURS = parseInt(process.env.DM_COOLDOWN_HOURS || '24', 10);

// ============================================================
// Interval limiter (token bucket, 1 token)
// ============================================================

let lastSendTime = 0;

export function waitForSlot(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastSendTime;

  if (elapsed >= SEND_INTERVAL_MS) {
    lastSendTime = Date.now();
    return Promise.resolve();
  }

  const delay = SEND_INTERVAL_MS - elapsed;
  lastSendTime = now + delay;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ============================================================
// Daily limit check (JST day boundary)
// ============================================================

export async function checkDailyLimit(
  sb: SupabaseClient,
  accountId: string,
): Promise<{ allowed: boolean; sentToday: number; remaining: number }> {
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(Date.now() + jstOffset);
  const todayStr = jstNow.toISOString().slice(0, 10);
  const todayStart = `${todayStr}T00:00:00+09:00`;
  const todayEnd = `${todayStr}T23:59:59+09:00`;

  const { count } = await sb
    .from('dm_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .in('status', ['queued', 'sending', 'success'])
    .gte('created_at', todayStart)
    .lt('created_at', todayEnd);

  const sentToday = count || 0;
  const remaining = Math.max(0, DAILY_LIMIT - sentToday);

  return {
    allowed: sentToday < DAILY_LIMIT,
    sentToday,
    remaining,
  };
}

// ============================================================
// Per-user cooldown check
// ============================================================

export async function isUserOnCooldown(
  sb: SupabaseClient,
  accountId: string,
  castName: string,
  userName: string,
): Promise<boolean> {
  if (COOLDOWN_HOURS <= 0) return false;

  const cooldownSince = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  const { count } = await sb
    .from('dm_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('user_name', userName)
    .eq('status', 'success')
    .gte('sent_at', cooldownSince);

  return (count || 0) > 0;
}
