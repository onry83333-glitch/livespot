/**
 * evaluators/churn-risk.ts — UC-031: Churn risk detection
 *
 * Scheduled: Find users who haven't been seen for N days but have significant
 * historical spend (total_tokens >= threshold).
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';

const log = createLogger('trigger:churn-risk');

export async function evaluateChurnRisk(
  trigger: DmTrigger,
  accountId: string,
): Promise<EvaluationResult> {
  const sb = getSupabase();
  const absenceDays = (trigger.condition_config.absence_days as number) || 14;
  const minTotalTokens = (trigger.condition_config.min_total_tokens as number) || 300;

  const cutoffDate = new Date(Date.now() - absenceDays * 24 * 60 * 60 * 1000).toISOString();

  // Find users with high historical spend who haven't been seen recently
  const { data, error } = await sb
    .from('spy_user_profiles')
    .select('user_name, cast_name, total_tokens, last_seen')
    .eq('account_id', accountId)
    .eq('is_registered_cast', true)
    .gte('total_tokens', minTotalTokens)
    .lt('last_seen', cutoffDate)
    .order('total_tokens', { ascending: false })
    .limit(50); // cap per evaluation

  if (error) {
    log.error(`churn_risk query failed: ${error.message}`);
    return { shouldFire: false, targets: [] };
  }

  if (!data || data.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  const targets: TriggerContext[] = data.map((row: {
    user_name: string;
    cast_name: string;
    total_tokens: number;
    last_seen: string;
  }) => {
    const daysSince = Math.floor(
      (Date.now() - new Date(row.last_seen).getTime()) / (24 * 60 * 60 * 1000),
    );
    // Use the trigger's cast_name if specified, otherwise the user's primary cast
    const castName = trigger.cast_name || row.cast_name;
    return {
      accountId,
      castName,
      userName: row.user_name,
      totalTokens: row.total_tokens,
      daysSinceLastVisit: daysSince,
    };
  });

  log.info(`churn_risk: ${targets.length} dormant users (>${absenceDays}d, >=${minTotalTokens}tk)`);
  return { shouldFire: true, targets };
}
