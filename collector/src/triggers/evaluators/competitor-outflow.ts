/**
 * evaluators/competitor-outflow.ts — UC-037: Competitor outflow detection
 *
 * Scheduled: Find users who are active at competitor casts (high spend)
 * but haven't visited own casts recently.
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';

const log = createLogger('trigger:competitor-outflow');

export async function evaluateCompetitorOutflow(
  trigger: DmTrigger,
  accountId: string,
): Promise<EvaluationResult> {
  const sb = getSupabase();
  const minSpyTokens = (trigger.condition_config.min_spy_tokens as number) || 500;
  const daysSinceOwnVisit = (trigger.condition_config.days_since_own_visit as number) || 7;

  const cutoffDate = new Date(Date.now() - daysSinceOwnVisit * 24 * 60 * 60 * 1000).toISOString();

  // 1. Get users active at competitor casts (high tokens, is_registered_cast=false)
  const { data: spyUsers, error: spyErr } = await sb
    .from('spy_user_profiles')
    .select('user_name, total_tokens')
    .eq('account_id', accountId)
    .eq('is_registered_cast', false)
    .gte('total_tokens', minSpyTokens)
    .order('total_tokens', { ascending: false })
    .limit(200);

  if (spyErr || !spyUsers || spyUsers.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  const spyUserNames = spyUsers.map((u: { user_name: string }) => u.user_name);

  // 2. Check which of these users have been seen at OWN casts recently
  const { data: ownProfiles, error: ownErr } = await sb
    .from('spy_user_profiles')
    .select('user_name, cast_name, total_tokens, last_seen')
    .eq('account_id', accountId)
    .eq('is_registered_cast', true)
    .in('user_name', spyUserNames);

  if (ownErr) {
    log.error(`competitor_outflow own query failed: ${ownErr.message}`);
    return { shouldFire: false, targets: [] };
  }

  // Build map of own cast visits
  const ownVisits = new Map<string, { castName: string; lastSeen: string; totalTokens: number }>();
  for (const p of ownProfiles || []) {
    const existing = ownVisits.get(p.user_name);
    // Keep the cast with the most tokens
    if (!existing || p.total_tokens > existing.totalTokens) {
      ownVisits.set(p.user_name, {
        castName: p.cast_name,
        lastSeen: p.last_seen,
        totalTokens: p.total_tokens,
      });
    }
  }

  // 3. Find users who either:
  //    a) Have no own cast visits at all
  //    b) Have own cast visits but last_seen is older than cutoff
  const targets: TriggerContext[] = [];

  for (const spyUser of spyUsers) {
    const ownVisit = ownVisits.get(spyUser.user_name);

    if (!ownVisit) {
      // Never visited own cast — interesting but need a cast_name for DM
      // Skip if no trigger.cast_name specified
      if (!trigger.cast_name) continue;
      targets.push({
        accountId,
        castName: trigger.cast_name,
        userName: spyUser.user_name,
        totalTokens: spyUser.total_tokens,
      });
    } else if (ownVisit.lastSeen < cutoffDate) {
      // Visited own cast but gone dormant
      const daysSince = Math.floor(
        (Date.now() - new Date(ownVisit.lastSeen).getTime()) / (24 * 60 * 60 * 1000),
      );
      targets.push({
        accountId,
        castName: ownVisit.castName,
        userName: spyUser.user_name,
        totalTokens: ownVisit.totalTokens,
        daysSinceLastVisit: daysSince,
      });
    }
  }

  if (targets.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  // Cap to avoid flooding
  const capped = targets.slice(0, 30);
  log.info(`competitor_outflow: ${capped.length} users spending at competitors but dormant at own casts`);
  return { shouldFire: true, targets: capped };
}
