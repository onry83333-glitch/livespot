/**
 * evaluators/cross-promotion.ts — UC-040: Multi-cast cross-promotion DM
 *
 * Scheduled: For each pair of own casts, find users who visit one cast
 * but not another. Promote the unvisited cast to them.
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';

const log = createLogger('trigger:cross-promotion');

export async function evaluateCrossPromotion(
  trigger: DmTrigger,
  accountId: string,
): Promise<EvaluationResult> {
  const sb = getSupabase();
  const minVisitsOther = (trigger.condition_config.min_visits_other_cast as number) || 3;
  const maxVisitsTarget = (trigger.condition_config.max_visits_target_cast as number) || 0;

  // 1. Get registered casts
  const { data: casts, error: castErr } = await sb
    .from('registered_casts')
    .select('cast_name')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('cast_name');

  if (castErr || !casts || casts.length < 2) {
    return { shouldFire: false, targets: [], reason: 'need at least 2 casts' };
  }

  // Limit to top 5 casts by activity
  const castNames = casts.map((c: { cast_name: string }) => c.cast_name).slice(0, 5);

  // 2. Get all user profiles for own casts
  const { data: profiles, error: profErr } = await sb
    .from('spy_user_profiles')
    .select('user_name, cast_name, message_count, total_tokens')
    .eq('account_id', accountId)
    .eq('is_registered_cast', true)
    .in('cast_name', castNames)
    .gte('message_count', minVisitsOther);

  if (profErr || !profiles) {
    log.error(`cross_promotion query failed: ${profErr?.message}`);
    return { shouldFire: false, targets: [] };
  }

  // Build user -> set of visited casts
  const userCasts = new Map<string, Map<string, number>>(); // user -> cast -> message_count
  for (const p of profiles) {
    if (!userCasts.has(p.user_name)) {
      userCasts.set(p.user_name, new Map());
    }
    userCasts.get(p.user_name)!.set(p.cast_name, p.message_count);
  }

  // 3. Find promotion opportunities
  const targets: TriggerContext[] = [];

  userCasts.forEach((castVisits, userName) => {
    for (const targetCast of castNames) {
      // Skip if user already visits target cast above threshold
      const targetVisits = castVisits.get(targetCast) || 0;
      if (targetVisits > maxVisitsTarget) continue;

      // Check if user visits any OTHER cast enough times
      let hasOtherCastVisits = false;
      castVisits.forEach((count, visitedCast) => {
        if (visitedCast !== targetCast && count >= minVisitsOther) {
          hasOtherCastVisits = true;
        }
      });

      if (hasOtherCastVisits) {
        targets.push({
          accountId,
          castName: targetCast,
          userName,
        });
        break; // one promotion per user per evaluation
      }
    }
  });

  if (targets.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  const capped = targets.slice(0, 20);
  log.info(`cross_promotion: ${capped.length} cross-promotion opportunities`);
  return { shouldFire: true, targets: capped };
}
