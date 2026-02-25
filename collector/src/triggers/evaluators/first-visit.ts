/**
 * evaluators/first-visit.ts — UC-006: Spy user first visit to own cast
 *
 * Detects users appearing in a viewer list for the first time on a registered cast.
 * Uses an in-memory Set of known viewers per cast, diffing against each poll.
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';
import type { ViewerEntry } from '../../parsers/viewer.js';

const log = createLogger('trigger:first-visit');

// In-memory cache: "accountId:castName" -> Set<userName>
const knownViewers = new Map<string, Set<string>>();

function castKey(accountId: string, castName: string): string {
  return `${accountId}:${castName}`;
}

/**
 * Initialize known viewers from spy_user_profiles for a cast.
 * Call on session start to avoid false positives after restart.
 */
export async function initKnownViewers(accountId: string, castName: string): Promise<void> {
  const key = castKey(accountId, castName);
  const sb = getSupabase();

  const { data, error } = await sb
    .from('spy_user_profiles')
    .select('user_name')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('is_registered_cast', true);

  if (error) {
    log.error(`initKnownViewers failed: ${error.message}`);
    knownViewers.set(key, new Set());
    return;
  }

  const set = new Set<string>();
  (data || []).forEach((row: { user_name: string }) => set.add(row.user_name));
  knownViewers.set(key, set);
  log.debug(`initKnownViewers: ${castName} → ${set.size} known users`);
}

export async function evaluateFirstVisit(
  trigger: DmTrigger,
  accountId: string,
  castName: string,
  viewers: ViewerEntry[],
): Promise<EvaluationResult> {
  const key = castKey(accountId, castName);

  // Ensure we have a set (lazy init)
  if (!knownViewers.has(key)) {
    await initKnownViewers(accountId, castName);
  }

  const known = knownViewers.get(key)!;
  const newViewers: string[] = [];

  for (const v of viewers) {
    if (!known.has(v.userName)) {
      newViewers.push(v.userName);
      known.add(v.userName); // add immediately to prevent re-fire
    }
  }

  if (newViewers.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  // Check which new viewers have spy history (seen at other casts = interesting users)
  // For first_visit, we want ALL first-time visitors, not just spy users
  const targets: TriggerContext[] = newViewers.map((userName) => ({
    accountId,
    castName,
    userName,
  }));

  log.info(`first_visit: ${newViewers.length} new viewers at ${castName}`);
  return { shouldFire: true, targets };
}
