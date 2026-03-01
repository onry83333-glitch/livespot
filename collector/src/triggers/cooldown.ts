/**
 * triggers/cooldown.ts — Cooldown + daily limit checks via dm_trigger_logs
 *
 * DB columns (verified 2026-03-01):
 *   id, trigger_id, account_id, user_id, username, cast_name,
 *   triggered_at, dm_sent_at, status, reason
 */

import { getSupabase } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('trigger-cooldown');

/**
 * Check if a trigger has fired for this user within cooldown_hours.
 * Returns true if the trigger is within cooldown (should NOT fire).
 */
export async function isInCooldown(
  triggerId: string,
  userName: string,
  cooldownHours: number,
): Promise<boolean> {
  const sb = getSupabase();
  const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await sb
    .from('dm_trigger_logs')
    .select('id')
    .eq('trigger_id', triggerId)
    .eq('username', userName)
    .in('status', ['dm_queued', 'scenario_enrolled'])
    .gte('triggered_at', since)
    .limit(1);

  if (error) {
    log.error(`Cooldown check failed: ${error.message}`);
    return true; // fail-safe: skip if query fails
  }

  return (data?.length ?? 0) > 0;
}

/**
 * Check if trigger has hit its daily limit.
 * Returns true if limit reached (should NOT fire).
 */
export async function isDailyLimitReached(
  triggerId: string,
  dailyLimit: number,
): Promise<boolean> {
  const sb = getSupabase();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count, error } = await sb
    .from('dm_trigger_logs')
    .select('id', { count: 'exact', head: true })
    .eq('trigger_id', triggerId)
    .in('status', ['dm_queued', 'scenario_enrolled'])
    .gte('triggered_at', todayStart.toISOString());

  if (error) {
    log.error(`Daily limit check failed: ${error.message}`);
    return true; // fail-safe
  }

  return (count ?? 0) >= dailyLimit;
}

/**
 * Check if user's segment matches the trigger's target_segments filter.
 * Returns true if segment is allowed (should fire).
 * Empty target_segments means all segments allowed.
 */
export function isSegmentAllowed(
  targetSegments: string[],
  userSegment?: string,
): boolean {
  if (!targetSegments || targetSegments.length === 0) return true;
  if (!userSegment) return true; // no segment info = allow
  return targetSegments.includes(userSegment);
}
